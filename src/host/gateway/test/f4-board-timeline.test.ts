// F4（2026-10-13）：板端时间戳 tBoardMs 的端到端转发回归（v3联板验证报告 §3c/§8b/§F4）。
//
// 现场堵点：`assembler.ts` 早已算出 `tBoardMs`，但 `ws.ts encodeFrame()` 没把它放进 FRAME_RAW IPC、
// `api.ts /api/frame.json` 也没输出 ⇒ 校准完成后 1011 帧全部 `layoutVer=0`，
// VFR/MP4 导出的"全帧板端时间 → 用板端轴"路径永远走不到（web/src/export/times.ts）。
//
// 本文件钉死三件事（与判据 ② 一一对应）：
//   ① WS FRAME_RAW 载荷含 tBoardMs：有（layoutVer=1 + float64）/ 无（layoutVer=0 老布局）两路径；
//   ② /api/frame.json 字段：有则输出、无则**不写该字段**（不是 null）；
//   ③ VFR 导出时间源端到端：回放 v3 帧 → 真实解析/装配 → WS → decodeIpc → exportTimesMs，
//      全帧有 tBoardMs ⇒ "board" 轴；缺一 ⇒ 整体回退到达时刻 "arrival"。
// 红线：EVENTS 先于同帧 FRAME_RAW 的推送顺序（A5 KEY3 撕裂修复）在本文件里同时钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { IPC, createCounters, decodeIpc, getProfile } from "@retina/protocol";
import type {
  Counters,
  EventBatch,
  FramePacket,
  IpcFrameRaw,
  IpcMessage,
  Profile,
  SourceError,
  SourceInfo,
  SourceStats,
  Unsubscribe,
} from "@retina/protocol";
import type { IFrameSource } from "@retina/protocol";
import { IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { LatestStore } from "../src/pipeline/latest.ts";
import { handleApi, type ApiContext } from "../src/ipc/api.ts";
import { exportTimesMs } from "../../web/src/export/times.ts";
import { buildV3, evByteAligned } from "../../packages/protocol/test/helpers.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;

/** 最小数据源桩：只实现 hub 会订阅的 "frame"；counters/info 与真实源同形 */
class StubSource implements IFrameSource {
  readonly spiVersion: 1 = 1;
  readonly info: SourceInfo;
  readonly counters = createCounters();
  private readonly frameSubs = new Set<(f: FramePacket) => void>();

  constructor(p: Profile) {
    this.info = {
      wire: p.wire,
      profile: p.name,
      geometry: { w: p.frame.w, h: p.frame.h },
      evRecBytes: p.evRecBytes,
    };
  }

  start(): void {}
  stop(): void {}

  on(evt: "frame", cb: (p: FramePacket) => void): Unsubscribe;
  on(evt: "events", cb: (e: EventBatch) => void): Unsubscribe;
  on(evt: "stats", cb: (s: SourceStats, c: Counters) => void): Unsubscribe;
  on(evt: "error", cb: (e: SourceError) => void): Unsubscribe;
  on(evt: "frame" | "events" | "stats" | "error", cb: unknown): Unsubscribe {
    if (evt === "frame") {
      const fn = cb as (f: FramePacket) => void;
      this.frameSubs.add(fn);
      return () => {
        this.frameSubs.delete(fn);
      };
    }
    return () => {};
  }

  emitFrame(f: FramePacket): void {
    for (const cb of this.frameSubs) cb(f);
  }
}

interface Collected {
  readonly text: Record<string, unknown>[];
  readonly binary: Uint8Array[];
}

/** 必须"先挂监听再等 open"：服务端连接即推 hello/STATS，晚挂会漏 */
function collect(ws: WebSocket): Collected {
  const c: Collected = { text: [], binary: [] };
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) c.binary.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else c.text.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
  });
  ws.on("error", () => {});
  return c;
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface DecodedFrame {
  readonly msg: IpcFrameRaw;
  /** FRAME_RAW 载荷的布局版本字节（0=老布局 / ≥1=带板端时间） */
  readonly ver: number;
  readonly payloadLen: number;
}

/** 解出全部 FRAME_RAW 及其布局版本（版本字节直接读原始缓冲，防"解码器掩盖编码错误"） */
function framesOf(c: Collected): DecodedFrame[] {
  const out: DecodedFrame[] = [];
  for (const b of c.binary) {
    const m = decodeIpc(b);
    if (m === null || m.type !== "FRAME_RAW") continue;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    out.push({ msg: m, ver: b[IPC.HEADER + 5] as number, payloadLen: dv.getUint32(12) });
  }
  return out;
}

/** 解出全部消息（含 EVENTS），用于顺序红线断言 */
function messagesOf(c: Collected): IpcMessage[] {
  const out: IpcMessage[] = [];
  for (const b of c.binary) {
    const m = decodeIpc(b);
    if (m !== null) out.push(m);
  }
  return out;
}

function frameBytes(frameIdx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + frameIdx * 13) & 0xff;
  return out;
}

/**
 * 造一帧完整的 v3 线上字节（与回放/实时同一条解析+装配路径）。
 * tsUs=null ⇒ TS_VALID=0（板端时间不可信）⇒ 该帧不得有 tBoardMs。
 */
function feedV3Frame(rig: { processor: PacketProcessor; source: StubSource }, frameIdx: number, tsUs: number | null, t0: number, withEvents: boolean): void {
  const raw = frameBytes(frameIdx);
  for (let i = 0; i < N; i++) {
    const events = withEvents && i === 3 ? evByteAligned(i, 7, 1, i) : null;
    rig.processor.pushRawPayload(
      buildV3({
        frameIdx,
        chunkIdx: i,
        raw: raw.subarray(i * CHUNK, (i + 1) * CHUNK),
        tsUs,
        tsCalibrated: tsUs !== null,
        first: i === 0,
        last: i === N - 1,
        mode: 0,
        ...(events === null ? {} : { events }),
      }),
      t0 + i,
    );
  }
}

interface Rig {
  readonly hub: IpcHub;
  readonly source: StubSource;
  readonly processor: PacketProcessor;
  readonly frames: FramePacket[];
}

async function newRig(): Promise<Rig> {
  const source = new StubSource(profile);
  const frames: FramePacket[] = [];
  const processor = new PacketProcessor({
    profile,
    counters: source.counters,
    onFrame: (f) => {
      frames.push(f);
      source.emitFrame(f);
    },
  });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "replay" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  await hub.ready();
  return { hub, source, processor, frames };
}

test("F4 ① WS FRAME_RAW：带 tBoardMs → layoutVer=1 + float64 原值；缺省 → layoutVer=0 老布局逐字节兼容", async () => {
  const rig = await newRig();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(rig.hub.url);
    const c = collect(ws);
    await once(ws, "open");

    // 帧1：已校准板端时间；帧2：TS_VALID=0（无可信时间）；帧3：已校准
    feedV3Frame(rig, 1, 274_302_310_100, 1000, true);
    feedV3Frame(rig, 2, null, 2000, false);
    feedV3Frame(rig, 3, 274_302_377_856, 3000, false);

    await waitFor(() => (framesOf(c).length >= 3 ? true : undefined), "3 条 FRAME_RAW");
    const fs = framesOf(c);
    assert.equal(fs.length, 3);

    // 路径 A（有板端时间）：ver=1、tBoardMs = TS_US/1000、载荷多 8 B
    const a = fs[0] as DecodedFrame;
    assert.equal(a.ver, IPC.FRAME_LAYOUT_BOARD_TS, "有 tBoardMs 时必须落 ver=1（前端按 ver 判有无）");
    assert.equal(a.msg.tBoardMs, 274_302_310.1);
    assert.equal(a.payloadLen, 6 + 8 + profile.frame.bytes, "载荷 = w2+h2+fmt1+ver1+板端 ms(8) + raw");
    assert.equal(a.msg.raw.length, profile.frame.bytes, "像素本体不能被时间字段挤掉");

    // 路径 C（无可信板端时间）：ver=0、无该字段、载荷回到老布局
    const b = fs[1] as DecodedFrame;
    assert.equal(b.ver, IPC.FRAME_LAYOUT_V2, "TS_VALID=0 必须回退老布局（老前端/老记录逐字节兼容）");
    assert.equal(b.msg.tBoardMs, undefined, "无板端时间时不许给 null/NaN/0 冒充");
    assert.equal(b.payloadLen, 6 + profile.frame.bytes);

    // 帧3同样带板端时间（同一会话内两种布局可混发，由 ver 区分）
    assert.equal((fs[2] as DecodedFrame).ver, IPC.FRAME_LAYOUT_BOARD_TS);
    assert.equal((fs[2] as DecodedFrame).msg.tBoardMs, 274_302_377.856);

    // 红线：A5（EVENTS 先于同帧 FRAME_RAW）不因新增字段被破坏
    const msgs = messagesOf(c);
    const ev = msgs.find((m) => m.type === "EVENTS");
    assert.ok(ev !== undefined, "帧1 带了事件段 ⇒ 必须推 EVENTS");
    const evAt = msgs.indexOf(ev);
    const frameAt = msgs.findIndex((m) => m.type === "FRAME_RAW" && m.frameIdx === ev.frameIdx);
    assert.ok(frameAt > evAt, "EVENTS 必须排在它那一帧的 FRAME_RAW 之前（A5 撕裂修复红线）");
  } finally {
    if (ws !== null) ws.close();
    await rig.hub.close();
  }
});

test("F4 ③ VFR 导出时间源端到端：全帧有 tBoardMs → 板端轴；缺一 → 整体回退到达时刻", async () => {
  const rig = await newRig();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(rig.hub.url);
    const c = collect(ws);
    await once(ws, "open");

    // 回放三帧：1、3 帧有板端时间（已校准），2 帧 TS_VALID=0
    const ts1 = 274_302_310_100;
    const ts3 = 274_302_377_856;
    feedV3Frame(rig, 1, ts1, 1000, false);
    feedV3Frame(rig, 2, null, 2000, false);
    feedV3Frame(rig, 3, ts3, 3000, false);
    await waitFor(() => (framesOf(c).length >= 3 ? true : undefined), "3 条 FRAME_RAW");

    // 装配器确实算出了两条板端时间（判据下限保护：链路是"转发"而不是"重算"）
    assert.equal(rig.frames.length, 3);
    assert.equal((rig.frames[0] as FramePacket).tBoardMs, ts1 / 1000);
    assert.equal((rig.frames[1] as FramePacket).tBoardMs, undefined);
    assert.equal((rig.frames[2] as FramePacket).tBoardMs, ts3 / 1000);

    const timed = framesOf(c).map((f) => ({
      tMs: f.msg.tArriveMs,
      ...(f.msg.tBoardMs === undefined ? {} : { tBoardMs: f.msg.tBoardMs }),
    }));

    // 全帧都有（= 只取有板端时间的那两帧）：板端轴，时间戳逐值等于 TS_US/1000
    const all = exportTimesMs([timed[0] as (typeof timed)[number], timed[2] as (typeof timed)[number]]);
    assert.equal(all.source, "board", "全帧有 tBoardMs ⇒ VFR 导出必须走板端优先路径");
    assert.deepEqual(all.timesMs, [ts1 / 1000, ts3 / 1000]);

    // 缺一（三帧一起导出）：不许混轴 ⇒ 整体回退到达时刻
    const mixed = exportTimesMs(timed);
    assert.equal(mixed.source, "arrival", "缺一帧板端时间 ⇒ 整体回退到达时刻（禁止混轴）");
    assert.deepEqual(mixed.timesMs, timed.map((f) => f.tMs));
  } finally {
    if (ws !== null) ws.close();
    await rig.hub.close();
  }
});

test("F4 ② /api/frame.json：有板端时间则输出 tBoardMs，没有则不写该字段（不是 null）", () => {
  const store = new LatestStore();
  const ctx: ApiContext = {
    store,
    profile,
    getStats: () => ({ packets: 0, bytes: 0, bytesRaw: 0, bytesEvents: 0, pps: 0, bps: 0, lastFrameIdx: 0, wraps: 0, tNowMs: 0 }),
    getCounters: createCounters,
    getConfig: () => ({}),
    startedAtMs: Date.now(),
    sourceInfo: { wire: profile.wire, profile: profile.name },
    uiUrl: null,
  };
  const raw = new Uint8Array(profile.frame.bytes);

  function getFrameJson(): Record<string, unknown> {
    let code = 0;
    let body = "";
    const res = {
      writeHead: (c: number) => {
        code = c;
        return res;
      },
      end: (b?: unknown) => {
        body = typeof b === "string" ? b : String(b);
      },
      setHeader: () => {},
    } as unknown as import("node:http").ServerResponse;
    const req = { method: "GET" } as import("node:http").IncomingMessage;
    const handled = handleApi(req, res, new URL("http://127.0.0.1/api/frame.json"), ctx);
    assert.equal(handled, true);
    assert.equal(code, 200);
    return JSON.parse(body) as Record<string, unknown>;
  }

  // 有板端时间：字段原值输出
  store.setFrame(
    { frameIdx: 7, seq: 9, w: profile.frame.w, h: profile.frame.h, raw, pixel: "RGB565_BE", events: { records: [], dropped: 0, thinned: false }, tArriveMs: 1234, tBoardMs: 274_302_310.1, synthetic: false },
    9999,
  );
  const withTs = getFrameJson();
  assert.equal(withTs["tBoardMs"], 274_302_310.1, "/api/frame.json 必须给出板端时间（拉 API 的消费者同一条时间源）");
  assert.equal(withTs["tArriveMs"], 1234, "到达时刻字段不受影响（回退路径仍可用）");

  // 无板端时间：不写字段（消费方按"缺省"处理；给 null 会被 typeof 判断误当成"有"）
  store.setFrame(
    { frameIdx: 8, seq: 10, w: profile.frame.w, h: profile.frame.h, raw, pixel: "RGB565_BE", events: { records: [], dropped: 0, thinned: false }, tArriveMs: 2345, synthetic: false },
    10_001,
  );
  const noTs = getFrameJson();
  assert.equal(Object.prototype.hasOwnProperty.call(noTs, "tBoardMs"), false, "无可信板端时间时不许写 tBoardMs 键");
  assert.equal(noTs["tArriveMs"], 2345);
});
