// 网关事件归属自证工具（2026-10-13 任务：纯事件包先到 ⇒ 静默丢失）。
//
// 为什么要有它：缺陷在网关装配器里（`beginFrame` 无条件清事件环），而「收下了却没推出去、也没计数」
// 这件事必须在**真实数据流**上量出来，不能靠读代码下结论。本工具用既有回放向量（g01/g02，真实板端字节）
// 重组容器，喂进**真实网关**（ReplayTransport → PacketProcessor → FrameAssembler → IpcHub → 真 WS），
// 客户端用 `decodeIpc` 逐条收，最后打印：
//   · 源侧帧包带了多少事件（= 事件是否真的随帧走）
//   · 客户端收到多少条事件、相对其所属帧是「先到 / 后到 / 无帧」
//   · 源侧计数器账目（bytesEvents / evPartial / evDrop / **evOrphan** / aborted）
//
// 用法（**不占任何 UDP 端口**；网关实例只绑 127.0.0.1 的随机端口，回放源不发网络包）：
//   node --experimental-strip-types gateway/test/evattrib_selfcheck.ts          # 真实实现（修后）
//   node --experimental-strip-types gateway/test/evattrib_selfcheck.ts negctl   # 修前语义负对照
//
// negctl 是"同一份数据流 + 同一个网关，只把 beginFrame 的归属逻辑换回修前语义（无条件清事件环）"：
// 运行时在原型上包一层，把「收编 / 显式丢弃」换回「清空」。这样修后也能复跑"修前的静默丢失"，
// 证明末行判据不是恒真。真实实现那一档必须全绿。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { decodeEvents, decodeIpc, encodeRtpkt, getProfile, iterRtpkt, parseV2Packet } from "@retina/protocol";
import { COUNTER_KEYS } from "@retina/protocol";
import type { IpcMessage, Profile } from "@retina/protocol";
import { encodeV2Packet } from "../src/transport/v2encode.ts";
import { IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";
import { ReplayTransport } from "../src/transport/replay.ts";
import { FrameAssembler } from "../src/pipeline/assembler.ts";
import { hostPath } from "../src/paths.ts";

const mode = process.argv[2] === "negctl" ? "negctl" : "real";

// ——————————————————— 修前语义负对照（同一份代码，只换 beginFrame 的归属逻辑） ———————————————————

interface AsmInternals {
  evChunks: Uint8Array[];
  evBytes: number;
  evTargetIdx: number | null;
  evPendChunks: Uint8Array[];
  evPendBytes: number;
  /** 修后新增的归属步骤（beginFrame 里调它）；修前没有这一步，beginFrame 直接清环 */
  assignPendingToFrame: (rawIdx: number) => void;
}

if (mode === "negctl") {
  const proto = FrameAssembler.prototype as unknown as AsmInternals;
  proto.assignPendingToFrame = function patched(this: AsmInternals): void {
    // 修前逐字语义：beginFrame 里就是 `evChunks=[]; evBytes=0; evTargetIdx=null;`（无差别清环）——
    // 修后事件分两个环，这里把两个环都清掉，等价于修前"那一个环被清空"。
    // 关键是**不收编、不记账、不留存**：这正是"静默丢失"的定义。
    this.evChunks = [];
    this.evBytes = 0;
    this.evPendChunks = [];
    this.evPendBytes = 0;
    this.evTargetIdx = null;
  };
}

// ——————————————————— 数据流：既有回放向量重组（字节一个不改，只改容器顺序/帧号） ———————————————————

const profile = getProfile("retina-v2-800x480-e5") as Profile;

function readGolden(id: string): Uint8Array[] {
  const b = readFileSync(hostPath("testdata/golden/" + id + ".rtpkt"));
  return [...iterRtpkt(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))];
}

/**
 * g01 的 750 个真实帧负载把帧号 1→rawIdx 重封装（像素逐字节未改）。
 * 为什么能改帧号：本任务要的是"事件与其所属帧同号"的时序，g01 原始帧号是 1、g02 事件帧号是 7，
 * 只有把两者对齐到同一帧号，才是线上真实存在的「同帧事件」形态（重组手法与 `录制配对修复报告.md`
 * §5.1 的 replay-combined 完全一致，同一份既有数据）。
 */
function framePayloads(rawIdx: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const [i, p] of readGolden("g01_min_frame").entries()) {
    const r = parseV2Packet(p, { profile });
    if (!r.ok || r.value.raw === null) throw new Error("g01 第 " + i + " 包解析失败：" + (r.ok ? "无 raw" : r.reason));
    out.push(
      encodeV2Packet({
        frameIdx: rawIdx,
        segMask: r.value.segMask,
        chunkIdx: r.value.chunkIdx,
        raw: r.value.raw,
        withCrc16: p.length > 13 + r.value.rawLen,
      }),
    );
  }
  return out;
}

const evPayloads = (): Uint8Array[] => readGolden("g02_ev_only");

// ——————————————————— 真实网关：回放源 → 装配器 → IpcHub → WS → decodeIpc ———————————————————

interface StreamReport {
  readonly name: string;
  /** 源侧交付的帧：帧号 + 该帧带的事件条数（= 事件有没有随帧走） */
  readonly frames: { idx: number; ev: number }[];
  /** 源侧纯事件批次（onEventsDetailed）：帧号 + 条数 */
  readonly batches: { idx: number; ev: number }[];
  /** 客户端收到的 EVENT 记录总数 */
  readonly clientEvents: number;
  /** 相对同帧 FRAME_RAW 的到达序（用 IPC 的 frameIdx = 逻辑帧号判） */
  readonly evBeforeFrame: number;
  readonly evAfterFrame: number;
  readonly evNoFrame: number;
  readonly frameMsgs: number;
  readonly evMsgs: number;
  /** 源侧计数器账目 */
  readonly bytesEvents: number;
  readonly evPartial: number;
  readonly evDrop: number;
  readonly evOrphan: number;
  readonly aborted: number;
  /** 账目守恒：交付条数 + 显式丢弃条数 = 负载里的整条记录数，且余数字节走 evPartial、bytesEvents 对得上 */
  readonly accountingOk: boolean;
  /** 真实负载里应有的整条记录数（从 EV_LEN 逐包算，不依赖实现） */
  readonly expectRecords: number;
  readonly expectResidual: number;
}

async function runStream(name: string, payloads: readonly Uint8Array[]): Promise<StreamReport> {
  const dir = mkdtempSync(path.join(tmpdir(), "evattrib-"));
  const file = path.join(dir, "vector.rtpkt");
  writeFileSync(file, encodeRtpkt(payloads));
  const source = new ReplayTransport({ profile, path: file, speed: 0 });
  const frames: { idx: number; ev: number }[] = [];
  const batches: { idx: number; ev: number }[] = [];
  source.on("frame", (f) => frames.push({ idx: f.frameIdx, ev: f.events.records.length }));
  source.onEventsDetailed((b, idx) => batches.push({ idx, ev: b.records.length }));
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "selfcheck" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  const got: IpcMessage[] = [];
  let ws: WebSocket | null = null;
  try {
    await hub.ready();
    ws = new WebSocket(hub.url);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (m !== null) got.push(m);
    });
    ws.on("error", () => {});
    await once(ws, "open");
    source.start();
    // 等"新消息静默"（回放是确定性数据，静默即洗完）
    for (let i = 0; i < 400; i++) {
      const n = got.length;
      await new Promise((r) => setTimeout(r, 25));
      if (got.length === n && n > 0) break;
    }
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // —— 客户端侧审计：EVENTS 的 frameIdx 与同号 FRAME_RAW 的先后 ——
  const frameAt = new Map<number, number>();
  got.forEach((m, i) => {
    if (m.type === "FRAME_RAW" && !frameAt.has(m.frameIdx)) frameAt.set(m.frameIdx, i);
  });
  let clientEvents = 0;
  let evBeforeFrame = 0;
  let evAfterFrame = 0;
  let evNoFrame = 0;
  got.forEach((m, i) => {
    if (m.type !== "EVENTS") return;
    const n = decodeEvents(m.data, m.recBytes).records.length;
    clientEvents += n;
    const at = frameAt.get(m.frameIdx);
    if (at === undefined) evNoFrame += n;
    else if (i < at) evBeforeFrame += n;
    else evAfterFrame += n;
  });

  const c = source.counters;
  // 修前计数器表里没有 evOrphan（读不到就是 0，且账目判据会红 —— 这正是"静默"的可机读形态）
  const orphanCount = (c as unknown as Record<string, number>)["evOrphan"] ?? 0;
  // —— 账目：从真实负载算出「应有的整条记录数 / 余数字节」，再和"交付 + 显式丢弃"对拍 ——
  // 为什么从负载算：这样"应该有多少条"与实现无关，修前（静默丢）在同一个判据下必然对不上。
  let expectRecords = 0;
  let expectResidual = 0;
  let expectPartialPkts = 0;
  for (const p of payloads) {
    const r = parseV2Packet(p, { profile });
    if (!r.ok || r.value.evLen === 0) continue;
    expectRecords += Math.floor(r.value.evLen / profile.evRecBytes);
    const rem = r.value.evLen % profile.evRecBytes;
    if (rem > 0) {
      expectResidual += rem;
      expectPartialPkts++;
    }
  }
  const delivered = clientEvents;
  const dropped = orphanCount;
  /** 事件字节累计在源侧 getter 上（Counters 里没有它） */
  const srcBytesEvents = source.bytesEvents;
  const accountingOk =
    delivered + dropped === expectRecords &&
    c.evPartial === expectPartialPkts &&
    srcBytesEvents === expectRecords * profile.evRecBytes + expectResidual;
  return {
    name,
    frames,
    batches,
    clientEvents,
    evBeforeFrame,
    evAfterFrame,
    evNoFrame,
    frameMsgs: got.filter((m) => m.type === "FRAME_RAW").length,
    evMsgs: got.filter((m) => m.type === "EVENTS").length,
    bytesEvents: srcBytesEvents,
    evPartial: c.evPartial,
    evDrop: c.evDrop,
    evOrphan: orphanCount,
    aborted: c.aborted,
    accountingOk,
    expectRecords,
    expectResidual,
  };
}

function printReport(r: StreamReport): void {
  console.log("  " + r.name);
  console.log(
    "    源侧交付帧 " + r.frames.length + " 个" +
      (r.frames.length === 0 ? "" : "：" + r.frames.map((f) => "帧" + f.idx + " 带 " + f.ev + " 条事件").join(" · ")) +
      " · 源侧纯事件批 " + r.batches.length + " 个" +
      (r.batches.length === 0 ? "" : "：" + r.batches.map((b) => "帧" + b.idx + " " + b.ev + " 条").join(" · ")),
  );
  console.log(
    "    客户端：EVENTS 消息 " + r.evMsgs + " 条 / FRAME_RAW 消息 " + r.frameMsgs + " 条 ⇒ 收到事件 " + r.clientEvents +
      " 条（先于同帧 " + r.evBeforeFrame + " / 后于同帧 " + r.evAfterFrame + " / 无帧 " + r.evNoFrame + "）",
  );
  console.log(
    "    源侧账目：bytesEvents=" + r.bytesEvents + " · evPartial=" + r.evPartial + " · evDrop=" + r.evDrop +
      " · **evOrphan=" + r.evOrphan + "** · aborted=" + r.aborted,
  );
  console.log(
    "    账目守恒：负载应有 " + r.expectRecords + " 条整记录（余数 " + r.expectResidual + " B） vs 交付 " + r.clientEvents +
      " + 显式丢弃 " + r.evOrphan + " ⇒ " + (r.accountingOk ? "对得上" : "对不上（有事件去向不明）"),
  );
}

// ——————————————————— 主流程 ———————————————————

async function main(): Promise<number> {
  console.log("[自证] 网关事件归属（纯事件包先到 ⇒ 不得静默丢失）");
  console.log(
    "  模式               : " + mode +
      (mode === "negctl" ? "（修前语义负对照：beginFrame 无条件清事件环）" : "（真实实现：按 frameIdx 归属 + evOrphan 显式计数）"),
  );
  console.log("  计数器表           : evOrphan " + ((COUNTER_KEYS as readonly string[]).includes("evOrphan") ? "已登记（COUNTER_KEYS）" : "未登记（修前：无任何丢弃计数）"));
  console.log("  数据源             : host/testdata/golden/g01_min_frame.rtpkt（真实板端 750 包 1 帧）"
    + " + g02_ev_only.rtpkt（真实 20 条事件 / 帧号 7）");
  console.log("");

  const streams: StreamReport[] = [];
  streams.push(await runStream("① g01 帧向量原样（真实 1 帧 / 无事件）", framePayloads(1)));
  streams.push(await runStream("② g02 事件向量原样（真实 20 条事件 / 无对应帧）", evPayloads()));
  streams.push(await runStream("③ 既有数据重组：帧先到、事件后到（同帧号 7；迟到序）", [...framePayloads(7), ...evPayloads()]));
  streams.push(await runStream("④ ③ 的到达序对调：纯事件包先到、帧后到（同帧号 7）", [...evPayloads(), ...framePayloads(7)]));
  streams.push(await runStream("⑤ 无法归属帧：事件帧号 7 已被跳过（帧 9 起装，7/8 从未到）", [...evPayloads(), ...framePayloads(9)]));
  for (const r of streams) {
    printReport(r);
    console.log("");
  }

  const byName = (needle: string): StreamReport => {
    const hit = streams.find((s) => s.name.includes(needle));
    if (hit === undefined) throw new Error("找不到数据流：" + needle);
    return hit;
  };
  const g01 = byName("①");
  const g02 = byName("②");
  const late = byName("③");
  const early = byName("④");
  const orphan = byName("⑤");

  const checks: { what: string; ok: boolean }[] = [];
  const push = (what: string, ok: boolean): void => {
    checks.push({ what, ok });
    console.log((ok ? "  [OK] " : "  [NG] ") + what);
  };

  // ① 既有向量：帧照旧、零事件、零丢弃（不得回归）
  push("① g01：帧交付 1 个且 0 条事件、evOrphan=0、aborted=0",
    g01.frames.length === 1 && g01.frames[0]?.ev === 0 && g01.clientEvents === 0 && g01.evOrphan === 0 && g01.aborted === 0);
  // ② 既有向量：无帧的事件照旧交付（MODE2/纯事件流的既有出口）
  push("② g02：20 条事件全部交付客户端、evOrphan=0、不误配（无帧可配）",
    g02.clientEvents === 20 && g02.evOrphan === 0 && g02.frames.length === 0);
  // ③ 迟到序：帧先到、事件后到 —— 修前修后都必须交付（零回归）
  push("③ 迟到序：20 条事件全部交付（后于同帧 FRAME_RAW，走既有纯事件出口）",
    late.clientEvents === 20 && late.frames[0]?.ev === 0 && late.evOrphan === 0);
  // ④ 本缺陷：纯事件包先到 ⇒ 必须收编进同帧（随帧交付），不是丢、也不是迟到批
  push("④ 先到序（本缺陷）：帧 7 带 20 条事件一起交付 ⇒ 客户端收到 20 条且先于同帧 FRAME_RAW",
    early.frames.length === 1 && early.frames[0]?.ev === 20 && early.clientEvents === 20 &&
      early.evBeforeFrame === 20 && early.evOrphan === 0 && early.batches.length === 0);
  // ⑤ 真正无法归属：帧号 7 被跳过且从未交付 ⇒ 显式计数丢弃（evOrphan=20），客户端 0 条
  push("⑤ 无法归属帧：evOrphan=20（显式计数丢弃）、客户端 0 条、帧 9 照常交付",
    orphan.evOrphan === 20 && orphan.clientEvents === 0 && orphan.frames.length === 1 &&
      orphan.frames[0]?.idx === 9 && orphan.frames[0]?.ev === 0);
  // 账目守恒（每条流）：交付 + 显式丢弃 与 bytesEvents 对得上（余数走 evPartial，不静默）
  for (const s of streams) push("账目守恒：" + s.name.slice(0, 6) + " 交付 " + s.clientEvents + " + 丢弃 " + s.evOrphan + " 与 bytesEvents=" + s.bytesEvents, s.accountingOk);

  const ok = checks.every((c) => c.ok);
  console.log("");
  console.log("EVATTRIB_SELFCHECK_OK=" + (ok ? "1" : "0") + "（" + checks.filter((c) => c.ok).length + "/" + checks.length + " 条判据成立）");
  return ok ? 0 : 1;
}

process.exitCode = await main();
