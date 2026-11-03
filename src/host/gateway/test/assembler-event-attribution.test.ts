// 网关事件归属（2026-10-13 修复）：纯事件包**先于**其所属帧的原始包到达时，
// 那批事件必须进入该帧的正常通路（随帧交付），绝不能被 `beginFrame` 清掉；
// 真正无法归属帧的事件（帧号已被跳过且从未交付）必须**显式计数丢弃**（新计数器 evOrphan）。
//
// 为什么这是线上时序而不是构造：板端为避免静默丢事件，选择"事件积压 >33 条时**先发纯事件包**"
// （`docs/05_实验与实测/协议v3实现_20261011/板端实现报告.md` §3 第 3 条；WIRE-V3 §3.1 模式表里
// MODE0 的上行内容也明写"+ 纯事件包"）⇒ 纯事件包天然排在同帧原始包之前。修前装配器把它当垃圾清掉：
// 源侧 bytesEvents 在涨、客户端一条收不到、也没有任何丢弃计数（静默，违反原则 P6）。
// 缺陷登记：`docs/05_实验与实测/录制配对修复_20261013/录制配对修复报告.md` §7 O1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { decodeIpc, encodeEvents, encodeRtpkt, getProfile, iterRtpkt, parseV2Packet } from "@retina/protocol";
import type { EventBatch, EventRecord, FramePacket, IpcMessage, ParsedV2, Profile } from "@retina/protocol";
import { FrameAssembler } from "../src/pipeline/assembler.ts";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";
import { ReplayTransport } from "../src/transport/replay.ts";
import { encodeV2Packet } from "../src/transport/v2encode.ts";
import { hostPath } from "../src/paths.ts";
import { buildV3, evByteAligned } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;
const REC = profile.evRecBytes;

/** 造"已解析好的 v2 包"（与 assembler.test.ts 同形：喂结构体，把失败点缩到装配算法本身） */
function v2(frameIdx: number, chunkIdx: number, raw: Uint8Array | null, events: Uint8Array | null = null): ParsedV2 {
  return {
    kind: "v2",
    frameIdx,
    segMask: (raw === null ? 0 : 1) | (events === null ? 0 : 2),
    hasRaw: raw !== null,
    hasEvents: events !== null,
    chunkIdx,
    rawLen: raw === null ? 0 : raw.length,
    evLen: events === null ? 0 : events.length,
    raw,
    events,
    crc16Present: false,
    warnings: [],
  };
}

function frameBytes(frameIdx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + frameIdx * 3) & 0xff;
  return out;
}
function chunkOf(raw: Uint8Array, i: number): Uint8Array {
  return raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
}
/** n 条可辨认的事件记录（x = tag*10+i；x 只有 9 bit，取值必须 <512） */
function recs(tag: number, n: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) list.push({ x: tag * 10 + i, y: tag, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}
function xsOf(f: FramePacket): number[] {
  return f.events.records.map((e) => e.x);
}

interface Rig {
  asm: FrameAssembler;
  frames: FramePacket[];
  batches: EventBatch[];
}

function newAsm(opts: { evRingMaxBytes?: number } = {}): Rig {
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  const asm = new FrameAssembler({
    profile,
    ...(opts.evRingMaxBytes === undefined ? {} : { evRingMaxBytes: opts.evRingMaxBytes }),
    onFrame: (f) => frames.push(f),
    onEvents: (b) => batches.push(b),
  });
  return { asm, frames, batches };
}

/** 喂一帧完整的原始包（750 段）；events 只挂在第 0 段上（帧内事件） */
function feedFrame(asm: FrameAssembler, frameIdx: number, t0: number, events: Uint8Array | null = null): void {
  const raw = frameBytes(frameIdx);
  for (let i = 0; i < N; i++) asm.push(v2(frameIdx, i, chunkOf(raw, i), i === 0 ? events : null), t0 + i);
}

// ————————————————————— ① 先到的事件：收编进所属帧 —————————————————————

test("纯事件包先于同帧原始包 ⇒ 收编进该帧随帧交付（修前这里是静默丢失）", () => {
  const { asm, frames, batches } = newAsm();
  // 事件先到（板端"积压 >33 先发纯事件包"的时序）：帧 7 的 3 条事件，先于帧 7 的任何原始包
  asm.push(v2(7, 0, null, recs(1, 3)), 1000);
  assert.equal(frames.length, 0, "还没有帧可交付");
  // 帧 7 的原始包后到：禁止把这批事件清掉（修前 beginFrame 无条件清环）
  feedFrame(asm, 7, 2000, recs(2, 2));
  asm.finish();

  assert.equal(frames.length, 1);
  const f = frames[0] as FramePacket;
  assert.equal(f.frameIdx, 7);
  assert.deepEqual(
    xsOf(f),
    [10, 11, 12, 20, 21],
    "先到的事件必须随帧交付，且排在本帧自带的帧内事件之前（线上它们确实更早）",
  );
  assert.equal(batches.length, 0, "收编后不能再走纯事件出口（否则同一批事件会被推两遍）");
  assert.equal(asm.counters.evOrphan, 0, "能归属帧的事件一条都不许计丢弃");
  assert.equal(asm.counters.aborted, 0);
  assert.equal(asm.counters.evPartial, 0);
});

test("v3 MODE2→MODE0 边界：排空出来的纯事件包（同帧号）⇒ 收编进恢复的那一帧", () => {
  // 板端"整帧发送门：2→0 切换后先让纯事件包把积压排空再恢复原始帧"（板端实现报告 §5）
  // ⇒ 这些纯事件包带的是**即将恢复的那一帧**的帧号，必须收编进那一帧（修前：被 beginFrame 清掉）。
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  const processor = new PacketProcessor({ profile, onFrame: (f) => frames.push(f), onEvents: (b) => batches.push(b) });
  for (let i = 0; i < 3; i++) {
    processor.pushRawPayload(
      buildV3({ frameIdx: 20, events: evByteAligned(i, 9, 1, 0), mode: 2, tsUs: 1000 + i, tsCalibrated: true }),
      3000 + i,
    );
  }
  assert.equal(frames.length, 0, "MODE2 不拼帧");
  const raw = frameBytes(20);
  for (let i = 0; i < N; i++) {
    processor.pushRawPayload(
      buildV3({ frameIdx: 20, chunkIdx: i, raw: chunkOf(raw, i), mode: 0, tsUs: 5000 + i, tsCalibrated: true, first: i === 0, last: i === N - 1 }),
      5000 + i,
    );
  }
  processor.finish();

  assert.equal(frames.length, 1);
  assert.deepEqual((frames[0] as FramePacket).events.records.map((r) => r.x), [0, 1, 2], "排空的事件必须随恢复的那一帧交付");
  assert.equal(batches.length, 0);
  assert.equal(processor.counters.evOrphan, 0);
  assert.equal(processor.counters.aborted, 0, "MODE2 的纯事件包不该给帧记 aborted");
});

// ————————————————————— ② 真正无法归属帧：显式计数丢弃 —————————————————————

test("事件帧号已被跳过（帧 10/11 从未到达，帧 12 起装）⇒ 计 evOrphan 显式丢弃、不误配给帧 12", () => {
  const { asm, frames, batches } = newAsm();
  asm.push(v2(10, 0, null, recs(3, 4)), 1000); // 帧 10 的 4 条事件先到
  feedFrame(asm, 12, 2000, recs(4, 1));        // 帧 10 / 11 从未到达，帧 12 起装
  asm.finish();

  assert.equal(frames.length, 1);
  const f = frames[0] as FramePacket;
  assert.equal(f.frameIdx, 12);
  assert.deepEqual(xsOf(f), [40], "帧 10 的事件绝不许误配给帧 12（跨帧误配比丢弃更难查）");
  assert.equal(asm.counters.evOrphan, 4, "真正无法归属帧 ⇒ 显式计数丢弃（修前：静默消失、无任何计数）");
  assert.equal(batches.length, 0);
});

test("先到事件的帧号还在前面（乱序/边界）⇒ 留着，等它那一帧到达时收编", () => {
  const { asm, frames, batches } = newAsm();
  asm.push(v2(9, 0, null, recs(5, 2)), 1000); // 帧 9 的事件先到
  feedFrame(asm, 8, 2000);                    // 帧 8 先起装：帧 9 的事件必须留着，不许丢也不许塞进 8
  assert.deepEqual(xsOf(frames[0] as FramePacket), [], "帧 8 不许吞掉帧 9 的事件");
  feedFrame(asm, 9, 4000);                    // 帧 9 到达 ⇒ 收编
  assert.deepEqual(xsOf(frames[1] as FramePacket), [50, 51]);
  asm.finish();
  assert.equal(frames.length, 2);
  assert.equal(asm.counters.evOrphan, 0);
  assert.equal(batches.length, 0);
});

test("迟到事件（那一帧已交付过）⇒ 走既有纯事件出口，不丢也不计 evOrphan", () => {
  const { asm, frames, batches } = newAsm();
  feedFrame(asm, 5, 1000);                       // 帧 5 已交付（无事件）
  assert.equal(frames.length, 1);
  asm.push(v2(5, 0, null, recs(6, 3)), 2000);    // 帧 5 的事件迟到（板端解耦事件包）
  feedFrame(asm, 6, 3000);                       // 帧 6 起装 ⇒ 结算迟到的帧 5 事件
  asm.finish();

  assert.equal(batches.length, 1, "已交付帧的迟到事件必须走纯事件出口（前端按 frameIdx 配对）");
  assert.equal((batches[0] as EventBatch).records.length, 3);
  assert.deepEqual((batches[0] as EventBatch).records.map((r) => r.x), [60, 61, 62]);
  assert.equal(asm.counters.evOrphan, 0, "已交付帧的迟到事件不是 orphan");
});

// ————————————————————— ③ 边界：帧被丢弃 / 环上限 都不许静默 —————————————————————

test("先到事件已收编、但那一帧不齐被丢 ⇒ 随帧作废（记在 aborted 上），且不泄漏到下一帧", () => {
  const { asm, frames, batches } = newAsm();
  asm.push(v2(3, 0, null, recs(7, 2)), 1000); // 帧 3 的事件先到
  const raw = frameBytes(3);
  for (let i = 0; i < 700; i++) asm.push(v2(3, i, chunkOf(raw, i)), 2000 + i); // 缺 50 段 ⇒ 帧 3 永远不齐
  feedFrame(asm, 4, 4000, recs(8, 1));        // 帧 4 起装 ⇒ 帧 3 aborted
  asm.finish();

  assert.equal(frames.length, 1);
  assert.equal((frames[0] as FramePacket).frameIdx, 4);
  assert.deepEqual(xsOf(frames[0] as FramePacket), [80], "帧 3 的事件不许泄漏给帧 4");
  assert.equal(asm.counters.aborted, 1, "帧级丢弃记在 aborted 上（帧连同它的事件一起作废）");
  assert.equal(asm.counters.evOrphan, 0, "已收编进帧的事件不算 orphan（帧级的账已经记过）");
  assert.equal(batches.length, 0);
});

test("先到事件同样受事件环上限约束（防涨）：超限按整条丢最旧并计 evDrop", () => {
  const { asm, frames } = newAsm({ evRingMaxBytes: 10 }); // 只装得下 2 条 5B 记录
  for (let k = 0; k < 5; k++) asm.push(v2(1, 0, null, new Uint8Array([k, 0, k, 1, 0])), 100 + k);
  feedFrame(asm, 1, 1000);
  asm.finish();

  assert.equal(asm.counters.evDrop, 3, "先到事件的环同样是 evDrop 口径（与帧内事件环一致）");
  assert.deepEqual(xsOf(frames[0] as FramePacket), [3, 4], "丢的是最旧的记录（按整条丢，不错位）");
  assert.equal(asm.counters.evOrphan, 0);
});

test("MODE2 纯事件流（帧号不推进）不受影响：finish 结算成交付批，一条不丢", () => {
  const { asm, frames, batches } = newAsm();
  for (let i = 0; i < 4; i++) asm.push(v2(100, 0, null, recs(i, 2)), 1000 + i);
  asm.finish();

  assert.equal(frames.length, 0);
  assert.equal(batches.length, 1);
  assert.equal((batches[0] as EventBatch).records.length, 8);
  assert.equal(asm.counters.evOrphan, 0, "纯事件流没有「帧被跳过」的概念，不得误计 evOrphan");
  assert.equal(asm.counters.aborted, 0);
});

// ————————————————————— ④ 真实网关端到端：既有回放向量重组 —————————————————————

/** g01 的 750 个真实帧负载把帧号改成 rawIdx（像素逐字节未改）；g02 的两条真实事件负载原样 */
function goldenPayloads(frameFirst: boolean, rawIdx: number): Uint8Array[] {
  const read = (id: string): Uint8Array[] => {
    const b = readFileSync(hostPath("testdata/golden/" + id + ".rtpkt"));
    return [...iterRtpkt(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))];
  };
  const framePkts: Uint8Array[] = [];
  for (const [i, p] of read("g01_min_frame").entries()) {
    const r = parseV2Packet(p, { profile });
    if (!r.ok || r.value.raw === null) throw new Error("g01 第 " + i + " 包解析失败：" + (r.ok ? "无 raw" : r.reason));
    framePkts.push(
      encodeV2Packet({
        frameIdx: rawIdx,
        segMask: r.value.segMask,
        chunkIdx: r.value.chunkIdx,
        raw: r.value.raw,
        withCrc16: p.length > 13 + r.value.rawLen,
      }),
    );
  }
  const evPkts = read("g02_ev_only");
  return frameFirst ? [...framePkts, ...evPkts] : [...evPkts, ...framePkts];
}

/** 真实网关：回放源 → 装配 → IpcHub → 真 WS → decodeIpc */
async function throughGateway(payloads: readonly Uint8Array[]): Promise<{ msgs: IpcMessage[]; frames: FramePacket[]; src: ReplayTransport }> {
  const dir = mkdtempSync(path.join(tmpdir(), "evattrib-ut-"));
  const file = path.join(dir, "combined.rtpkt");
  writeFileSync(file, encodeRtpkt(payloads));
  const src = new ReplayTransport({ profile, path: file, speed: 0 });
  const frames: FramePacket[] = [];
  src.on("frame", (f) => frames.push(f));
  const control: GatewayControl = {
    start: () => src.start(),
    stop: () => src.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "ut" }),
  };
  const hub = new IpcHub({ port: 0, profile, source: src, control });
  const msgs: IpcMessage[] = [];
  let ws: WebSocket | null = null;
  try {
    await hub.ready();
    ws = new WebSocket(hub.url);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (m !== null) msgs.push(m);
    });
    ws.on("error", () => {});
    await once(ws, "open");
    src.start();
    for (let i = 0; i < 400; i++) {
      const n = msgs.length;
      await new Promise((r) => setTimeout(r, 25));
      if (msgs.length === n && n > 0) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    if (ws !== null) ws.close();
    src.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { msgs, frames, src };
}

test("真实网关端到端：既有向量重组（事件在前）⇒ 20 条事件随帧交付，且 EVENTS 先于同帧 FRAME_RAW（A5 序不变）", async () => {
  const { msgs, frames, src } = await throughGateway(goldenPayloads(false, 7));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.events.records.length, 20, "帧必须带着 20 条事件一起交付（修前这里是 0）");
  assert.equal(src.counters.evOrphan, 0);
  const ev = msgs.find((m) => m.type === "EVENTS");
  assert.ok(ev !== undefined && ev.type === "EVENTS", "必须有 EVENTS 消息");
  assert.equal(ev.count, 20);
  const evAt = msgs.indexOf(ev);
  const frameAt = msgs.findIndex((m) => m.type === "FRAME_RAW" && m.frameIdx === ev.frameIdx);
  assert.ok(frameAt > evAt, "EVENTS 必须排在同帧 FRAME_RAW 之前：EVENTS@" + evAt + " FRAME_RAW@" + frameAt);
  assert.equal(msgs.filter((m) => m.type === "EVENTS").length, 1, "同一批事件不许推两遍");
});

test("真实网关端到端：同一批数据换成迟到序（帧在前）⇒ 行为不变（零回归）", async () => {
  const { msgs, frames, src } = await throughGateway(goldenPayloads(true, 7));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.events.records.length, 0, "迟到序下事件不进帧（走纯事件出口，与修前一致）");
  const ev = msgs.find((m) => m.type === "EVENTS");
  assert.ok(ev !== undefined && ev.type === "EVENTS");
  assert.equal(ev.count, 20);
  const evAt = msgs.indexOf(ev);
  const frameAt = msgs.findIndex((m) => m.type === "FRAME_RAW" && m.frameIdx === ev.frameIdx);
  assert.ok(frameAt >= 0 && frameAt < evAt, "迟到序：事件排在同帧 FRAME_RAW 之后（既有口径不动）");
  assert.equal(src.counters.evOrphan, 0);
});
