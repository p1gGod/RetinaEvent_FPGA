// 串口动作实时显示收尾（2026-10-31）回归，两组判据：
//
//  A 组 = 1 Hz GET_STATUS 轮询（main.ts 的 startUartStatusPoll）
//    串口链路没有原始帧，动作真值只存在于 GET_STATUS(0x04) ACK 尾部的 TLV 0x92 里；
//    没有下行请求 ⇒ UDP 帧流一停 /api/action 就冻在最后一次快照上。
//    但"谁去发"必须挑场景：只发串口、命令在飞时不插队、v2 固件不发、心跳已发过不重复发。
//
//  B 组 = 串口事件帧不得污染动作快照（processor.ts 的 rawCapable 判据）
//    串口事件帧是"v3 24 B 头逐字节同构"，但 byte23 由 uart_ev_tap.v:203-232 的 default
//    分支填 0x00 ⇒ 若照旧每包 observe，每来一帧事件就把 GET_STATUS 读回的真值覆盖成"无动作"
//    （活体实测：/api/action ageMs 几十毫秒就刷新、frameIdx 在涨，raw/valid 却恒 0）。
//
// 两组缺任何一条都会退化成"真值被覆盖 / 快照不刷新"，所以必须一起绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CTRL, DOWNLINK, createCounters, decodeActionState, getProfile, parseV3Packet } from "@retina/protocol";
import type { ParsedV3, Profile } from "@retina/protocol";
import { actionStore } from "../src/action.ts";
import { V3Link } from "../src/pipeline/v3link.ts";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { UART_STATUS_POLL_MS, startUartStatusPoll } from "../src/main.ts";
import type { StatusPollSource } from "../src/main.ts";
import { buildV3, v3Tlv } from "../../packages/protocol/test/helpers.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ————————————————————————— A 组：轮询的"发/不发" —————————————————————————

interface GetStatusOpts {
  readonly heartbeat?: boolean;
  readonly silent?: boolean;
}

interface FakeLink {
  inFlight: number;
  seenV3: boolean;
  lastAckAtMs: number | null;
  fail: boolean;
  readonly calls: GetStatusOpts[];
  getStatus(opts?: GetStatusOpts): Promise<{ readonly ok: boolean; readonly detail: string }>;
  heartbeatStats(): { readonly ack: number; readonly fail: number; readonly lastAckAtMs: number | null; readonly lastRttMs: number | null };
}

/** 假 V3Link：只实现轮询用到的四个成员，记录每次 getStatus 的入参 */
function makeLink(over: { readonly seenV3?: boolean; readonly inFlight?: number; readonly lastAckAtMs?: number | null } = {}): FakeLink {
  const calls: GetStatusOpts[] = [];
  const link: FakeLink = {
    inFlight: over.inFlight ?? 0,
    seenV3: over.seenV3 ?? true,
    lastAckAtMs: over.lastAckAtMs ?? null,
    fail: false,
    calls,
    getStatus: (opts: GetStatusOpts = {}) => {
      // 显式落成 boolean：exactOptionalPropertyTypes 下不能把 undefined 塞进可选属性
      calls.push({ silent: opts.silent === true, heartbeat: opts.heartbeat === true });
      return Promise.resolve(link.fail ? { ok: false, detail: "ACK 超时（1000 ms 内未回）" } : { ok: true, detail: "OK" });
    },
    heartbeatStats: () => ({ ack: 0, fail: 0, lastAckAtMs: link.lastAckAtMs, lastRttMs: null }),
  };
  return link;
}

function uartSource(link: FakeLink): StatusPollSource {
  return { kind: "uart", v3link: link };
}

test("A1 串口 + 心跳从未 ACK：每个周期发一次 GET_STATUS，且带 silent（不推 CTRL 事件）", async () => {
  const link = makeLink();
  const h = startUartStatusPoll({ getLive: () => uartSource(link), intervalMs: 5 });
  try {
    await sleep(80);
    assert.equal(h.polls, link.calls.length, "polls 计数必须与真实发出的请求数一致");
    assert.ok(h.polls >= 3, "定时器必须逐周期发（实测 " + h.polls + " 次）");
    for (const c of link.calls) {
      assert.equal(c.silent, true, "必须 silent：否则 1 Hz 状态查询会把面板「最近命令」刷屏");
      assert.equal(c.heartbeat, false, "不能冒充心跳：hbAck/hbFail 是 0xF0 心跳专用健康度口径");
    }
  } finally {
    h.stop();
  }
});

test("A2 网口 / 回放 / 合成通道：一次都不发（动作字节随数据包到达，轮询纯属多余流量）", async () => {
  for (const kind of ["udp", "replay", "synth"]) {
    const link = makeLink();
    const h = startUartStatusPoll({ getLive: () => ({ kind, v3link: link }), intervalMs: 5 });
    await sleep(40);
    h.stop();
    assert.equal(h.polls, 0, kind + " 通道不得产生任何 GET_STATUS");
    assert.equal(link.calls.length, 0, kind + " 通道的真实调用数也必须为 0");
  }
});

test("A3 inFlight>0（用户命令在飞）：跳过本轮，命令落地后恢复（S8 不打断用户操作）", async () => {
  const link = makeLink({ inFlight: 1 });
  const h = startUartStatusPoll({ getLive: () => uartSource(link), intervalMs: 5 });
  try {
    await sleep(50);
    assert.equal(h.polls, 0, "有在飞命令时不得插队（会抢 SEQ / 打断用户 ACK 匹配）");
    link.inFlight = 0;
    await sleep(50);
    assert.ok(h.polls >= 2, "在飞清零后必须恢复轮询（实测 " + h.polls + " 次）");
  } finally {
    h.stop();
  }
});

test("A4 未见过 v3 上行（v2 固件）：不发，避免白刷板端 dlReject 计数", async () => {
  const link = makeLink({ seenV3: false });
  const h = startUartStatusPoll({ getLive: () => uartSource(link), intervalMs: 5 });
  try {
    await sleep(50);
    assert.equal(h.polls, 0, "seenV3=false 时不能发（与 V3Link.tryTakeCalSlot 同一口径）");
  } finally {
    h.stop();
  }
});

test("A5 心跳刚 ACK 过（≤900 ms）：跳过；心跳停摆后由轮询接管", async () => {
  let nowMs = 1_000_000;
  const link = makeLink({ lastAckAtMs: nowMs - 100 });
  const h = startUartStatusPoll({ getLive: () => uartSource(link), intervalMs: 5, nowMs: () => nowMs });
  try {
    await sleep(50);
    // 串口心跳本来就是 1 Hz 的 GET_STATUS；再并行发一次会让 SerialTransport 的
    // `now - lastDownlinkAtMs < 1000 ⇒ 跳过` 闸门被永久占住（心跳 sent 冻住、健康度失真）
    assert.equal(h.polls, 0, "心跳已在本秒完成一次权威 0x92 读回 ⇒ 不得重复发");
    nowMs += 10_000;
    link.lastAckAtMs = nowMs - 5_000;
    await sleep(50);
    assert.ok(h.polls >= 2, "心跳停摆超过新鲜窗口后必须接管（实测 " + h.polls + " 次）");
  } finally {
    h.stop();
  }
});

test("A6 缺省周期 = UART_STATUS_POLL_MS = 1000 ms；stop() 后定时器被清掉", () => {
  let timerTick: (() => void) | null = null;
  let timerMs = -1;
  let cleared: unknown = null;
  const h = startUartStatusPoll({
    getLive: () => null,
    setIntervalFn: (fn, ms) => {
      timerTick = fn;
      timerMs = ms;
      return 7;
    },
    clearIntervalFn: (t) => {
      cleared = t;
    },
  });
  assert.equal(UART_STATUS_POLL_MS, 1000, "判据口径：1 Hz");
  assert.equal(timerMs, UART_STATUS_POLL_MS, "缺省必须用 1 Hz，不要各调用点各写一个魔数");
  assert.notEqual(timerTick, null);
  h.stop();
  assert.equal(cleared, 7, "close() 必须能停表");
});

test("A7 ACK 超时：只记日志、不重试、不停机；连续失败只在第 1 次打日志", async () => {
  const logs: string[] = [];
  const link = makeLink();
  link.fail = true;
  const h = startUartStatusPoll({ getLive: () => uartSource(link), intervalMs: 5, log: (m) => logs.push(m) });
  try {
    await sleep(70);
    assert.ok(h.polls >= 3, "一次超时不能停机，仍按周期继续（实测 " + h.polls + " 次）");
    assert.equal(link.calls.length, h.polls, "失败路径也不重试：一次 tick 只发一条");
    assert.equal(logs.length, 1, "连续失败必须限流：链断时不得每秒刷屏");
    assert.match(logs[0] ?? "", /GET_STATUS 未确认（连续 1 次）/);
  } finally {
    h.stop();
  }
});

test("A8 发送阶段直接抛错（串口写失败）：包成日志，不产生未处理 rejection", async () => {
  const logs: string[] = [];
  const link = {
    inFlight: 0,
    seenV3: true,
    getStatus: () => Promise.reject(new Error("串口未打开")),
  };
  const h = startUartStatusPoll({ getLive: () => ({ kind: "uart", v3link: link }), intervalMs: 5, log: (m) => logs.push(m) });
  try {
    await sleep(40);
    assert.ok(logs.length >= 1, "发送失败必须留一条日志（否则用户只看到动作不刷新、无任何线索）");
    assert.match(logs[0] ?? "", /GET_STATUS 发送失败：串口未打开/);
  } finally {
    h.stop();
  }
});

test("A9 真 V3Link：silent 的 ACK 不进 emitCtrlEvent（面板「最近命令」不被轮询污染），普通命令照常推", async () => {
  const sent: Uint8Array[] = [];
  const events: Record<string, unknown>[] = [];
  const link = new V3Link({
    send: (b) => sent.push(b),
    nowUs: () => 1_000_000,
    nowMs: () => 1_000_000,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  link.onCtrlEvent = (e) => events.push(e);
  link.seenV3 = true;
  const ackFor = (bytes: Uint8Array): ParsedV3 => {
    const buf = buildV3({ ctrl: true, ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: 0, ctrlSeq: (bytes[6] as number) << 8 | (bytes[7] as number), tsUs: 2_000_000 });
    const r = parseV3Packet(buf, { profile });
    if (!r.ok) throw new Error("ACK 构造失败: " + r.reason);
    return r.value;
  };

  const silentP = link.getStatus({ silent: true });
  const silentBytes = sent[0];
  if (silentBytes === undefined) assert.fail("silent 轮询也必须真的发帧");
  link.onCtrlPacket(ackFor(silentBytes));
  assert.equal((await silentP).ok, true);
  assert.equal(events.length, 0, "silent 的意义就是不推 CTRL 事件");

  const normalP = link.getStatus();
  const normalBytes = sent[1];
  if (normalBytes === undefined) assert.fail("普通命令必须发帧");
  link.onCtrlPacket(ackFor(normalBytes));
  assert.equal((await normalP).ok, true);
  assert.equal(events.length, 1, "UI 的「刷新状态」等真实命令必须照旧推 ack 事件");
  assert.equal(events[0]?.kind, "ack");
});

// ————————————————————————— B 组：串口事件帧不得污染动作快照 —————————————————————————

function makeProcessor(rawCapable?: boolean): PacketProcessor {
  return new PacketProcessor({
    profile,
    counters: createCounters(),
    ...(rawCapable === undefined ? {} : { rawCapable }),
  });
}

/** 一条 v3 数据包（带原始段，等价于 UDP 通路）；rsvd 就是 OFF3.ACTION 的落点 */
function v3Data(frameIdx: number, rsvd: number): Uint8Array {
  return buildV3({ raw: new Uint8Array(profile.rawChunk), frameIdx, rsvd, tsUs: 1_000_000 + frameIdx });
}

/** GET_STATUS ACK（CTRL 包），尾部带权威 TLV 0x92 = 动作字节 */
function v3GetStatusAck(actionByte: number): Uint8Array {
  return buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.GET_STATUS,
    ctrlStatus: 0,
    ctrlSeq: 1,
    frameIdx: 42,
    rsvd: 0x00,
    ctrlTlv: v3Tlv(CTRL.TLV.ACTION_STATE, Uint8Array.of(actionByte)),
    tsUs: 2_000_000,
  });
}

test("B1 串口（rawCapable=false）事件帧 byte23=0x00：不得喂动作快照", () => {
  actionStore.reset();
  const proc = makeProcessor(false);
  // uart_ev_tap.v 封 24 B 头时 OFF3.ACTION 走 default = 0x00 —— 这是"没有这个字段"，不是"没有动作"
  proc.pushRawPayload(v3Data(10, 0x00), 1000);
  assert.equal(actionStore.getSnapshot(), null, "串口下没有权威 TLV 就不能产生快照");
  proc.pushRawPayload(v3Data(11, 0x85), 2000);
  assert.equal(actionStore.getSnapshot(), null, "哪怕事件帧里填了非 0 值也不认：串口没有可读的原始段");
});

test("B2 串口 + GET_STATUS ACK 的 TLV 0x92：喂快照，且 class/conf 与字节一致", () => {
  actionStore.reset();
  const proc = makeProcessor(false);
  const raw = 0xa1;                                        // VALID=1 / CONF=8 / CLASS=1
  proc.pushRawPayload(v3GetStatusAck(raw), 3000);
  const snap = actionStore.getSnapshot();
  if (snap === null) assert.fail("串口下动作真值只能来自 TLV 0x92，必须喂进快照");
  const st = decodeActionState(raw);
  assert.equal(snap.raw, raw);
  assert.equal(snap.valid, st.valid);
  assert.equal(snap.class, st.cls);
  assert.equal(snap.conf, st.conf);
  assert.equal(snap.frameIdx, 42, "帧号取 CTRL 包自带的 frameIdx");
});

test("B3 串口 + 无 TLV 的 CTRL（心跳 / 其它 ACK）：同样不喂快照", () => {
  actionStore.reset();
  const proc = makeProcessor(false);
  proc.pushRawPayload(
    buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlStatus: 0, ctrlSeq: 3, frameIdx: 9001, rsvd: 0x00, tsUs: 5_000_000 }),
    4000,
  );
  assert.equal(actionStore.getSnapshot(), null, "心跳的 byte23 同样是 default 0x00，不能当动作真值");
});

test("B4 网口 / 回放（rawCapable=true）：数据包 byte23 照旧每包更新快照（B 组修复不得波及）", () => {
  actionStore.reset();
  const proc = makeProcessor();                            // 缺省 rawCapable=true，与 UDP/回放同形
  proc.pushRawPayload(v3Data(12, 0x85), 5000);
  const snap = actionStore.getSnapshot();
  if (snap === null) assert.fail("UDP/回放的 byte23 是真实 OFF3.ACTION，必须维持原行为");
  assert.equal(snap.raw, 0x85);
  assert.equal(snap.frameIdx, 12);
});

// ————————————————— D 组：心跳在位时轮询必须完全让位（task-7） —————————————————
//
// 8787 活体实测：轮询上线 25 s 后 `transport.uart.heartbeat` = {enabled:true, intervalMs:1000,
// sent:0, ack:0, skippedRecentDownlink:25}。原因是 SerialTransport 的心跳闸门
// `now - lastDownlinkAtMs < 1000 ⇒ 本次跳过`：轮询每 1 s 写一次 GET_STATUS，把"最近有下行"
// 一直压在 1 s 内，心跳每一拍都被吞掉。而心跳饿死后 lastAckAtMs 永不更新 ⇒ 靠 ACK 新鲜度
// 做的互斥守卫也一起失效（鸡生蛋）。
// 结论：判据必须是**配置**（心跳启用 ⇒ 轮询零下行），不是"最近有没有 ACK"。

test("D1 心跳启用（enabled=true, intervalMs=1000）：一次下行都不发，polls 恒为 0", async () => {
  const link = makeLink();
  const h = startUartStatusPoll({
    getLive: () => uartSource(link),
    intervalMs: 5,
    heartbeatEnabled: () => true,
    heartbeatIntervalMs: () => 1000,
  });
  try {
    await sleep(80);
    assert.equal(link.calls.length, 0, "心跳在位 ⇒ 零下行，否则会把心跳饿死（sent/ack 冻在 0）");
    assert.equal(h.polls, 0, "polls 计数也必须为 0（它是「发过几次」的对外口径）");
  } finally {
    h.stop();
  }
});

test("D2 心跳关闭（enabled=false）：轮询照常接管，逐周期发", async () => {
  const link = makeLink();
  const h = startUartStatusPoll({
    getLive: () => uartSource(link),
    intervalMs: 5,
    heartbeatEnabled: () => false,
    heartbeatIntervalMs: () => 0,
  });
  try {
    await sleep(80);
    assert.ok(h.polls >= 3, "心跳关掉后 /api/action 只能靠轮询，必须照常发（实测 " + h.polls + " 次）");
    assert.equal(h.polls, link.calls.length);
    assert.equal(link.calls[0]?.silent, true, "仍必须是 silent");
  } finally {
    h.stop();
  }
});

test("D3 enabled=true 但 intervalMs=0（心跳配置为关）：按「没有心跳」处理，轮询照常发", async () => {
  const link = makeLink();
  const h = startUartStatusPoll({
    getLive: () => uartSource(link),
    intervalMs: 5,
    heartbeatEnabled: () => true,
    heartbeatIntervalMs: () => 0,
  });
  try {
    await sleep(80);
    assert.ok(h.polls >= 3, "intervalMs=0 等价于心跳关闭，轮询必须接管");
  } finally {
    h.stop();
  }
});

test("D4 网口通道 + 心跳启用：仍然一次都不发（让位判据只在 uart 下才可能生效）", async () => {
  const link = makeLink();
  const h = startUartStatusPoll({
    getLive: () => ({ kind: "udp", v3link: link }),
    intervalMs: 5,
    heartbeatEnabled: () => true,
    heartbeatIntervalMs: () => 1000,
  });
  try {
    await sleep(40);
    assert.equal(link.calls.length, 0);
    assert.equal(h.polls, 0);
  } finally {
    h.stop();
  }
});
