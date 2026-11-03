// WS 层透传（A3）：装配器产出的 evOnly 批必须以 EVENTS.flags 的 FLAG_EV_ONLY 位原样到达浏览器，
// 且 frameIdx 用的是**网关自增逻辑帧号**（严格递增）。这条链路是"事件-only 能上屏"的唯一出口：
// 装配器改对了、ws 丢了标记，前端仍会把批塞进 evQueue 等一个永远不来的 FRAME_RAW。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { decodeIpc, encodeEvents, getProfile } from "@retina/protocol";
import type { EventRecord, IpcMessage, ParsedV2, Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import { IpcHub, FLAG_EV_ONLY } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;
const REC = profile.evRecBytes;

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

function recs(tag: number, n: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) list.push({ x: tag * 10 + i, y: tag, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}

/** 测试专用源：直接把已解析包塞进真实 assembler，绕开字节解析（A 的缺陷在装配/分发层） */
class PumpSource extends BaseFrameSource {
  constructor() {
    super({ profile });
  }
  pump(pkt: ParsedV2, tArriveMs: number): void {
    this.processor.assembler.push(pkt, tArriveMs);
  }
  tickAt(nowMs: number): void {
    this.processor.tick(nowMs);
  }
  frameRaw(frameIdx: number): void {
    const raw = new Uint8Array(profile.frame.bytes);
    for (let i = 0; i < raw.length; i++) raw[i] = (i + frameIdx) & 0xff;
    for (let i = 0; i < N; i++) {
      this.pump(v2(frameIdx, i, raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length))), 2_000_000 + i);
    }
  }
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("EV_ONLY 批：EVENTS 带 FLAG_EV_ONLY、frameIdx=逻辑帧号递增、无 FRAME_RAW、evDrop=0", async () => {
  const source = new PumpSource();
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "pump" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
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

    // 现场形态：帧号冻结 6040、2.5 s、每包 4 条
    const FROZEN = 6040;
    for (let i = 0; i < 500; i++) source.pump(v2(FROZEN, 0, null, recs((i % 40) + 1, 4)), 1_000_000 + i * 5);
    source.tickAt(1_000_000 + 500 * 5 + 40); // 排空尾巴

    const evOnly = await waitFor(() => {
      const list = msgs.filter((m) => m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0);
      return list.length >= 50 ? list : undefined;
    }, "≥50 条 EV_ONLY EVENTS");

    // 不许有原始帧（板端一条都没发）
    assert.equal(msgs.filter((m) => m.type === "FRAME_RAW").length, 0, "EV_ONLY 阶段不应出现 FRAME_RAW");
    // 逻辑帧号严格递增
    for (let i = 1; i < evOnly.length; i++) {
      const a = evOnly[i - 1]!;
      const b = evOnly[i]!;
      if (a.type !== "EVENTS" || b.type !== "EVENTS") continue;
      assert.ok(b.frameIdx > a.frameIdx, "逻辑帧号必须严格递增（前端按批 step，不按原始帧）");
      assert.equal((b.flags & FLAG_EV_ONLY) !== 0, true);
      assert.equal(b.count > 0, true);
      assert.equal(b.data.length, b.count * b.recBytes);
    }

    // 统计口径：evDrop 不许因"无帧边界"增长；counters 与 STATS 一致
    assert.equal(source.counters.evDrop, 0, "时间窗兜底后 evDrop 必须为 0");
    assert.equal(source.counters.evOrphan, 0);
    hub.pushSnapshotStats();
    const stats = await waitFor(() => msgs.find((m) => m.type === "STATS"), "STATS");
    if (stats.type === "STATS") {
      assert.equal(stats.counters.evDrop, 0, "STATS 里的 evDrop 必须与源侧一致");
      assert.equal(stats.stats.lastFrameIdx, 0, "没有任何原始帧，lastFrameIdx 必须是 0（不许编造帧号）");
    }
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

test("EV_ONLY→RAW_EV 回切帧号隔离：逻辑帧号绝不跟在 FRAME_RAW 之后，回切配对帧号只认真实帧 seq", async () => {
  const source = new PumpSource();
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "pump" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  const msgs: IpcMessage[] = [];
  let ws: WebSocket | null = null;
  try {
    await hub.ready();
    source.start(); // 让 1 Hz STATS 定时器跑起来（lastStats 只由周期统计刷新，pushSnapshotStats 推的是上一拍快照）
    ws = new WebSocket(hub.url);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (m !== null) msgs.push(m);
    });
    ws.on("error", () => {});
    await once(ws, "open");

    // ① EV_ONLY 阶段：板端帧号冻结 6040，连续 2.5 s 纯事件
    const FROZEN = 6040;
    for (let i = 0; i < 500; i++) source.pump(v2(FROZEN, 0, null, recs((i % 40) + 1, 4)), 1_000_000 + i * 5);
    source.tickAt(1_000_000 + 500 * 5 + 40); // 排空窗口，保证回切瞬间 evPend 为空（现场也是这样：窗口一直在出批）

    const evOnly = await waitFor(() => {
      const list = msgs.filter((m) => m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0);
      return list.length >= 50 ? list : undefined;
    }, "≥50 条 EV_ONLY EVENTS");
    assert.equal(msgs.filter((m) => m.type === "FRAME_RAW").length, 0, "回切前不许出现原始帧");

    // ② 回切 MODE0：第一帧真实原始帧到达
    source.frameRaw(6041);
    const frame1 = await waitFor(
      () => msgs.find((m) => m.type === "FRAME_RAW"),
      "回切后第一帧 FRAME_RAW",
    );
    if (frame1.type !== "FRAME_RAW") throw new Error("类型收窄失败");
    const cut = msgs.indexOf(frame1);
    const before = msgs.slice(0, cut);
    const after = msgs.slice(cut);

    // 判据 1：所有 EV_ONLY 批都在回切帧之前；不存在"逻辑帧号残留到回切之后"的批
    const taggedAfter = after.filter((m) => m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0);
    assert.equal(taggedAfter.length, 0, "回切 FRAME_RAW 之后不得再出现带 EV_ONLY 位的 EVENTS（逻辑帧号不许污染配对队列）");
    assert.ok(
      before.every((m) => m.type !== "EVENTS" || (m.flags & FLAG_EV_ONLY) !== 0),
      "回切前（evPend 已排空）不应有未标记的事件批混在逻辑帧号里",
    );

    // 判据 2：逻辑帧号在 EV_ONLY 阶段严格递增，且都没有 FRAME_RAW 与之配对
    const tagged = before.filter((m): m is Extract<IpcMessage, { type: "EVENTS" }> =>
      m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0,
    );
    for (let i = 1; i < tagged.length; i++) {
      assert.ok(tagged[i]!.frameIdx > tagged[i - 1]!.frameIdx, "EV_ONLY 逻辑帧号必须严格递增");
    }
    assert.ok(tagged.length >= 50, "EV_ONLY 逻辑帧号批必须成规模（实际 " + tagged.length + "）");
    assert.equal(
      before.filter((m) => m.type === "FRAME_RAW").length,
      0,
      "EV_ONLY 逻辑帧号没有对应的原始帧（这就是它必须带标记的原因）",
    );

    // 判据 3：回切后的第一帧自带事件走真实配对：EVENTS.frameIdx === FRAME_RAW.frameIdx、无 EV_ONLY 位
    const raw = new Uint8Array(profile.frame.bytes);
    for (let i = 0; i < N; i++) {
      const chunk = raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
      source.pump(v2(6042, i, chunk, i === 0 ? recs(20, 3) : null), 2_100_000 + i);
    }
    const frame2 = await waitFor(
      () => msgs.filter((m) => m.type === "FRAME_RAW")[1],
      "第二帧 FRAME_RAW",
    );
    if (frame2.type !== "FRAME_RAW") throw new Error("类型收窄失败");
    const idx2 = msgs.indexOf(frame2);
    const paired = msgs
      .slice(idx2 - 1, idx2)
      .find((m): m is Extract<IpcMessage, { type: "EVENTS" }> => m.type === "EVENTS");
    assert.ok(paired !== undefined, "回切后的帧内事件必须紧贴 FRAME_RAW 之前（同帧配对契约）");
    assert.equal(paired.frameIdx, frame2.frameIdx, "配对口径只认真实帧 seq（与 FRAME_RAW 完全一致）");
    assert.equal(paired.flags & FLAG_EV_ONLY, 0, "配对事件批不允许带 EV_ONLY 位");
    assert.equal(paired.count, 3);

    // 判据 4：STATS 的 lastFrameIdx 回到真实板端帧号（不是逻辑帧号），counters 不因 EV_ONLY 丢事件
    hub.pushSnapshotStats();
    const stats = await waitFor(
      () => msgs.find((m) => m.type === "STATS" && m.stats.lastFrameIdx === 6042),
      "回切后的 STATS",
    );
    if (stats.type === "STATS") {
      assert.equal(stats.counters.evDrop, 0, "EV_ONLY 期间时间窗已兜底，evDrop 必须为 0");
      assert.equal(stats.counters.evOrphan, 0);
    }
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

test("EV_ONLY 恢复后 RAW_EV 同帧配对不受影响：先到的纯事件收编进帧、EVENTS 在 FRAME_RAW 之前、不带 EV_ONLY 位", async () => {
  const source = new PumpSource();
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "pump" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
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

    // 纯事件先到（板端"积压先发纯事件包"的时序），随后同号原始帧到
    source.pump(v2(700, 0, null, recs(1, 3)), 1_000_000);
    source.frameRaw(700);

    const frame = await waitFor(() => msgs.find((m) => m.type === "FRAME_RAW"), "FRAME_RAW");
    if (frame.type !== "FRAME_RAW") throw new Error("类型收窄失败");
    // IPC 的 frameIdx 是装配器的**逻辑帧序号**（f.seq），不是板端 16bit FRAME_IDX —— 配对口径两边一致即可
    assert.equal(typeof frame.frameIdx, "number");

    const idx = msgs.indexOf(frame);
    const ev = msgs.slice(0, idx).find((m) => m.type === "EVENTS");
    assert.ok(ev !== undefined, "收编后的事件 EVENTS 必须紧贴在 FRAME_RAW 之前（前端同帧配对契约）");
    if (ev !== undefined && ev.type === "EVENTS") {
      assert.equal(ev.frameIdx, frame.frameIdx, "同帧配对：EVENTS 与 FRAME_RAW 的 frameIdx 必须一致");
      assert.equal(ev.flags & FLAG_EV_ONLY, 0, "随帧交付的批绝不是 evOnly 批");
      assert.equal(ev.count, 3);
    }
    assert.equal(source.counters.evOrphan, 0);
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

// F1（六修）：eventSource=host 时 EV_ONLY 批也必须转发（否则页面全黑），STATS 带事件源/EV_ONLY/客户端数
test("F1 eventSource=host + EV_ONLY：批仍转发且 STATS 暴露 eventSource/evOnlyActive/clients", async () => {
  const source = new PumpSource();
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "pump" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
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

    hub.setEventSource("host");
    for (let i = 0; i < 100; i++) source.pump(v2(6040, 0, null, recs((i % 40) + 1, 4)), 1_000_000 + i * 5);
    source.tickAt(1_000_000 + 100 * 5 + 40);

    const evOnly = await waitFor(() => {
      const list = msgs.filter((m) => m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0);
      return list.length >= 5 ? list : undefined;
    }, "host 模式下 ≥5 条 EV_ONLY EVENTS");
    assert.ok(evOnly.length >= 5, "host 模式必须仍转发 EV_ONLY 批（前端靠它自动切板端事件源）");

    hub.pushSnapshotStats();
    // 取**最后一条** STATS：hello 时补发的是切换前（board）的快照
    const stats = await waitFor(() => [...msgs].reverse().find((m) => m.type === "STATS" && m.eventSource === "host"), "host 快照 STATS");
    if (stats.type === "STATS") {
      assert.equal(stats.eventSource, "host", "STATS.eventSource 必须是当前事件源");
      assert.equal(stats.evOnlyActive, true, "刚推过 EV_ONLY 批 ⇒ evOnlyActive=true（2 s 判据）");
      assert.equal(typeof stats.clients, "number");
      assert.ok((stats.clients ?? 0) >= 1);
      assert.equal(typeof stats.slowClients, "number");
    }
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

// A7（六修 F2）：双客户端，一个卡住（不读 socket）只能丢它自己的 FRAME_RAW，
// 另一个正常客户端必须照收全部帧（修前 anyClientSlow 会全局丢帧，现场 uiDrop +87/3s）。
test("A7 双客户端：一个慢客户端只丢自己的 FRAME_RAW，另一个客户端帧不受影响", async () => {
  const source = new PumpSource();
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "pump" }),
  };
  // 阈值压到 200 KB：不真的等 8 MB，几帧就能把"慢"判定逼出来
  const hub = new IpcHub({ port: 0, profile, source, control, maxBufferedBytes: 200_000 });
  const fastFrames = new Set<number>();
  let fast: WebSocket | null = null;
  let slow: WebSocket | null = null;
  try {
    await hub.ready();
    fast = new WebSocket(hub.url);
    fast.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (m !== null && m.type === "FRAME_RAW") fastFrames.add(m.frameIdx);
    });
    fast.on("error", () => {});
    slow = new WebSocket(hub.url);
    slow.on("error", () => {});
    await Promise.all([once(fast, "open"), once(slow, "open")]);
    // 慢客户端：底层 socket 暂停读 ⇒ 服务端 bufferedAmount 越积越多（旧实现此时会全局丢帧）
    (slow as unknown as { _socket: { pause(): void } })._socket.pause();

    const PUSHES = 8;
    // 帧之间让出事件循环：真实运行时快客户端会持续读 socket；同步灌 8 帧会把两个客户端都判慢
    for (let i = 0; i < PUSHES; i++) {
      source.frameRaw(100 + i);
      await new Promise((r) => setTimeout(r, 80));
    }

    await waitFor(() => (fastFrames.size >= PUSHES ? true : undefined), "快客户端收齐 " + PUSHES + " 帧");
    assert.equal(fastFrames.size, PUSHES, "慢客户端不得拖累快客户端（per-client 降帧）");
    assert.ok(hub.pushCounters.slowFrameDrop > 0, "慢客户端必须被单独计数降帧（slowFrameDrop=" + hub.pushCounters.slowFrameDrop + "）");
    assert.equal(hub.pushCounters.uiDrop, 0, "只要有人收到，就不许记全局 uiDrop");
  } finally {
    fast?.terminate();
    slow?.terminate();
    source.stop();
    await hub.close();
  }
});
