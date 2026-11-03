// B：串口波特率 4 档（契约 §1 / §1.5）—— 扫描命中、运行时切档、旧位流 B5、回退、UDP 板端命令路径。
//
// 判据：
//   ① open 扫描 [preferred,115200,921600,460800,230400]，命中档正式握手，baudScan 轨迹上屏；
//   ② 串口切档：旧档 SET_PARAM 0x0C + ACK 0x91 读回 → 关旧口 → 新档重开 → GET_STATUS 握手；
//   ③ 旧位流（ACK 无 0x91 / 超时 / BAD_VALUE）⇒ 保持原档、preferred 不改、B5 明确文案；
//   ④ 新档连不上 ⇒ 回旧档并报"板端已切换但主机未连上（已回退）"；
//   ⑤ UDP 主通道切换走板端 SET_PARAM（主机串口不动），成功/旧位流文案都如实。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { CTRL, DOWNLINK, encodeDownlink, getProfile, serialBaudCode } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { SerialTransport } from "../src/transport/serial.ts";
import type { SerialOpenOptions, SerialPortFactory } from "../src/transport/serial.ts";
import { FakeSerialPort, ctrlAck } from "./serial_fakes.ts";
import { buildV3, v3Tlv } from "../../packages/protocol/test/helpers.ts";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";
import { SynthTransport } from "../src/transport/synth.ts";

const profile = getProfile("retina-v2-800x480-1280") as Profile;
const FAST = { attempts: 1, ackTimeoutMs: 25, gapMs: 0 } as const;

/** 从 SET_PARAM 下行 payload 里取 0x0C tag 的档位码（独立解析，不复用被测编码器读侧） */
function baudTag(payload: Uint8Array): number | null {
  let i = 0;
  while (i + 1 < payload.length) {
    const tag = payload[i] as number;
    const len = payload[i + 1] as number;
    if (tag === DOWNLINK.TAG.SER_BAUD && len >= 1) return payload[i + 2] ?? null;
    i += 2 + len;
  }
  return null;
}

function ackBaud(seq: number, baud: number): Uint8Array {
  const code = serialBaudCode(baud);
  if (code === null) throw new Error("非法档 " + baud);
  return buildV3({
    ctrl: true,
    ctrlOpcode: DOWNLINK.OPCODE.SET_PARAM,
    ctrlStatus: DOWNLINK.STATUS.OK,
    ctrlSeq: seq,
    ctrlPayload: v3Tlv(CTRL.TLV.SER_BAUD_STATE, Uint8Array.of(code)),
  });
}

/**
 * 每次 open 返回一只**新**假口（切档必须能关旧口再开新口），并按 baud 记录。
 * hitBaud 档会回 GET_STATUS（模拟板端在线）；其它档一个字节都不回（探测/验证超时）。
 */
class BaudFactory implements SerialPortFactory {
  readonly opens: { baud: number; port: FakeSerialPort }[] = [];
  readonly hitBaud: number;
  /** 可选：切档舞蹈的事件顺序（ack → close → open → handshake），跨对象共用一条时间线 */
  readonly events: string[];
  private readonly prof: Profile;
  constructor(prof: Profile, hitBaud: number, events: string[] = []) {
    this.prof = prof;
    this.hitBaud = hitBaud;
    this.events = events;
  }
  async open(opts: SerialOpenOptions): Promise<FakeSerialPort> {
    const port = new FakeSerialPort();
    this.events.push("open:" + opts.baudRate);
    this.opens.push({ baud: opts.baudRate, port });
    port.responder = (frame) => {
      const d = FakeSerialPort.parseDownlink(frame);
      if (d === null) return;
      if (d.opcode === DOWNLINK.OPCODE.GET_STATUS && opts.baudRate === this.hitBaud) {
        this.events.push("handshake:" + opts.baudRate);
        port.feed(ctrlAck(this.prof, CTRL.OPCODE.GET_STATUS, d.seq));
      }
    };
    return port;
  }
  async list(): Promise<readonly string[]> {
    return ["COM6"];
  }
}

/** 旧档句柄的板端应答：SET_PARAM → 带/不带 0x91 的 ACK，或干脆不回。 */
function answerSetParam(port: FakeSerialPort, prof: Profile, mode: "ack" | "no-tlv" | "none", target: number): void {
  port.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d === null || d.opcode !== DOWNLINK.OPCODE.SET_PARAM) return;
    if (mode === "none") return;
    if (mode === "ack") {
      const code = baudTag(d.payload);
      const baud = code === null ? target : [115200, 230400, 460800, 921600][code] ?? target;
      port.feed(ackBaud(d.seq, baud));
    } else {
      port.feed(ctrlAck(prof, DOWNLINK.OPCODE.SET_PARAM, d.seq));
    }
  };
}

class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  readonly detail = "fake-udp";
  constructor(prof: Profile) {
    super({ profile: prof });
  }
  protected override onStart(): void {
    this.rxPackets = 1;
  }
  setTsOffsetUs(_offsetUs: number | null): void {
    /* 无关 */
  }
}

test("B2 open 扫描：首选档无 ACK → 921600 命中，正式握手后 baudScan 轨迹可查", async () => {
  const f = new BaudFactory(profile, 921600);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, factory: f, handshake: FAST,
  });
  try {
    assert.equal(t.baudRate, 921600, "命中档必须成为当前实际档");
    assert.equal(t.preferredBaud, 115200, "扫描不改用户偏好");
    assert.equal(f.opens.map((o) => o.baud).join(","), "115200,921600", "按阶梯扫描且命中即停");
    const v = t.statusView();
    assert.equal(v["baudRate"], 921600);
    assert.equal(v["preferredBaud"], 115200);
    assert.deepEqual(v["baudScan"], { running: false, tried: [115200, 921600], hit: 921600 });
    assert.equal(v["handshakeOk"], true);
  } finally {
    t.closePort();
  }
});

test("B2 open 扫描命中 230400（阶梯第 4 档），baudScan 按实际尝试顺序记录", async () => {
  const f = new BaudFactory(profile, 230400);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, factory: f, handshake: FAST,
  });
  try {
    assert.equal(t.baudRate, 230400);
    assert.equal(t.preferredBaud, 115200, "扫描不改用户偏好");
    assert.deepEqual(f.opens.map((o) => o.baud), [115200, 921600, 460800, 230400]);
    assert.deepEqual(t.statusView()["baudScan"], {
      running: false,
      tried: [115200, 921600, 460800, 230400],
      hit: 230400,
    });
    assert.equal(t.statusView()["handshakeOk"], true);
  } finally {
    t.closePort();
  }
});

test("B2 切档成功：旧档 0x0C + ACK 0x91 → 关旧口 → 新档重开 → GET_STATUS 握手", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "ack", 921600);
  const f = new BaudFactory(profile, 921600);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.rolledBack, false);
    assert.equal(r.unsupported, false);
    assert.equal(r.baudRate, 921600);
    assert.equal(r.boardBaud, 921600, "0x91 读回必须成为板端事实");
    assert.equal(r.preferredBaud, 921600, "成功后偏好改到新档");
    assert.match(r.detail, /已切换到 921600 baud/);
    assert.equal(old.closed, true, "旧档必须主动关闭，不能双开抢端口");
    assert.deepEqual(f.opens.map((o) => o.baud), [921600]);
    const v = t.statusView();
    assert.equal(v["baudRate"], 921600);
    assert.equal(v["boardBaud"], 921600);
    assert.deepEqual(v["lastBaudSwitch"], { ok: true, atMs: v["lastBaudSwitch"] && (v["lastBaudSwitch"] as { atMs: number }).atMs, error: null });
    assert.equal(v["handshakeOk"], true, "新档 GET_STATUS 必须握手通过");
    // 下行确实发过 0x0C 档位码（独立字节断言）
    const setParam = old.written.find((w) => w[3] === 0x31 && w[5] === DOWNLINK.OPCODE.SET_PARAM);
    assert.ok(setParam !== undefined);
    assert.equal(baudTag(FakeSerialPort.parseDownlink(setParam)?.payload ?? new Uint8Array()), serialBaudCode(921600));
  } finally {
    t.closePort();
  }
});

test("B2 舞蹈事件序列：旧档 ACK(0x91) → close 旧口 → open 新档 → GET_STATUS 握手", async () => {
  const events: string[] = [];
  const old = new FakeSerialPort();
  old.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d === null || d.opcode !== DOWNLINK.OPCODE.SET_PARAM) return;
    events.push("ack:115200");
    old.feed(ackBaud(d.seq, 921600));
  };
  const origClose = old.close.bind(old);
  (old as unknown as { close: (cb?: (err: Error | null) => void) => unknown }).close = (cb?: (err: Error | null) => void) => {
    events.push("close:115200");
    return origClose(cb);
  };
  const f = new BaudFactory(profile, 921600, events);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, true, r.detail);
    const at = (name: string): number => {
      const i = events.indexOf(name);
      assert.notEqual(i, -1, "缺少事件 " + name + "；实际 " + events.join(","));
      return i;
    };
    const ack = at("ack:115200");
    const close = at("close:115200");
    const open = at("open:921600");
    const hs = at("handshake:921600");
    assert.ok(ack < close, "必须先等旧档 ACK 再关旧口");
    assert.ok(close < open, "必须先关旧口再开新口（不能双开抢端口）");
    assert.ok(open < hs, "必须新档 open 后再 GET_STATUS 握手");
  } finally {
    t.closePort();
  }
});

test("B5 旧位流：SET_PARAM ACK 无 0x91 ⇒ 保持原档、偏好不改、明确降级文案", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "no-tlv", 115200);
  const f = new BaudFactory(profile, 115200);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, false);
    assert.equal(r.unsupported, true);
    assert.match(r.detail, /板端位流较旧，暂不支持调波特率（仍 115200 baud）/);
    assert.match(r.detail, /ACK 未携带 TLV 0x91 读回/);
    assert.equal(r.preferredBaud, 115200, "B5 不许把偏好改到板端没确认的档");
    assert.equal(r.baudRate, 115200);
    assert.equal(old.isOpen, true, "旧位流不得关旧口");
    assert.equal(f.opens.length, 0, "不许尝试新档重开");
    assert.equal(t.statusView()["boardBaud"], null, "旧位流板端读回必须是 null，不能拿下发值冒充");
    assert.equal((t.statusView()["lastBaudSwitch"] as { ok: boolean }).ok, false);
  } finally {
    t.closePort();
  }
});

test("BLOCK-1 切档成功后心跳必须恢复（否则 5 s 静态无帧会被自动回退误判）", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "ack", 921600);
  const f = new BaudFactory(profile, 921600);
  let sent = 0;
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f,
    handshake: { enabled: false },
    heartbeat: { intervalMs: 25, send: () => { sent += 1; } },
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    t.start();
    await sleep(80);
    const before = sent;
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, true, r.detail);
    const hb = t.statusView()["heartbeat"] as { enabled: boolean; sent: number };
    assert.equal(hb.enabled, true, "切档成功（detachPort 已 stopHeartbeat）后必须重新 startHeartbeat");
    // SET_PARAM 刚写过，心跳要等最近下行 1 s 窗口；窗口过后必须真的发得出去。
    await sleep(1150);
    assert.ok(sent > before, "切档后心跳定时器必须真的在走：sent=" + before + " -> " + sent);
    assert.ok((t.statusView()["heartbeat"] as { sent: number }).sent > 0);
    assert.equal((t.statusView()["heartbeat"] as { enabled: boolean }).enabled, true);
  } finally {
    t.closePort();
  }
});

test("BLOCK-1 切档后 5 s 静态：心跳持续，noV3ForMs 不得涨到自动回退阈值", async () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const old = new FakeSerialPort();
  old.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d !== null && d.opcode === DOWNLINK.OPCODE.SET_PARAM) old.feed(ackBaud(d.seq, 921600));
  };
  let sent = 0;
  let seq = 1000;
  let t: SerialTransport;
  t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: new BaudFactory(profile, 921600),
    handshake: { enabled: false },
    // 心跳必须真的发 GET_STATUS：BaudFactory 的 921600 口会回 ACK，从而刷新 lastV3FrameAtMs。
    heartbeat: {
      intervalMs: 25,
      send: () => {
        sent += 1;
        t.send(encodeDownlink(DOWNLINK.OPCODE.GET_STATUS, seq++, new Uint8Array(0)));
      },
    },
  });
  try {
    t.start();
    await sleep(50);
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, true);
    await sleep(5200);
    const v = t.statusView();
    const hb = v["heartbeat"] as { enabled: boolean; sent: number };
    const noV3ForMs = Number(v["noV3ForMs"]);
    assert.equal(hb.enabled, true, "切档 5 s 后心跳仍必须 enabled");
    assert.ok(hb.sent > 0 && sent > 0, "切档 5 s 内心跳必须真的发过");
    assert.ok(noV3ForMs < 3000,
      "心跳 ACK 必须持续刷新 v3 帧；noV3ForMs=" + noV3ForMs + " 若 >=5000 会被 maybeAutoFallback 切回 UDP");
  } finally {
    t.closePort();
  }
});

test("BLOCK-2 新档+旧档都静默 ⇒ 进入扫描、明确失败，rolledBack 不得为 true", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "ack", 921600);
  // 所有档位都不回 GET_STATUS：新档没起来，旧档也救不回来，扫描也命不中。
  const f = new BaudFactory(profile, 0);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, false, "旧档没有 ACK 就不能报已回退（假成功）");
    assert.match(r.detail, /板端已切换但主机未连上：新档 921600 无有效 ACK/);
    assert.match(r.detail, /旧档 115200 无 ACK/);
    assert.match(r.detail, /且扫描未命中（已试 115200\/921600\/460800\/230400）/);
    assert.doesNotMatch(r.detail, /已回旧档|已回退/);
    const v = t.statusView();
    assert.deepEqual(v["baudScan"], {
      running: false,
      tried: [115200, 921600, 460800, 230400],
      hit: null,
    });
    assert.equal(v["open"], false);
    assert.equal(v["handshakeOk"], false);
  } finally {
    t.closePort();
  }
});

test("BLOCK-2 旧档无 ACK 后扫描命中 460800 ⇒ 链路恢复且 detail 报扫描命中", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "ack", 921600);
  // 新档与旧档都沉默，但 460800 回 GET_STATUS：扫描必须把它救回来。
  const f = new BaudFactory(profile, 460800);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, false, "交给用户的结果仍是失败（本次目标档没切成）");
    assert.equal(r.rolledBack, false);
    assert.equal(r.baudRate, 460800, "扫描命中后实际档必须报 460800");
    assert.match(r.detail, /旧档 115200 无 ACK/);
    assert.match(r.detail, /扫描命中并恢复到 460800 baud/);
    assert.doesNotMatch(r.detail, /已回旧档|已回退/);
    const v = t.statusView();
    assert.deepEqual(v["baudScan"], { running: false, tried: [115200, 921600, 460800], hit: 460800 });
    assert.equal(v["open"], true);
    assert.equal(v["handshakeOk"], true);
    assert.equal(v["baudRate"], 460800);
    assert.equal(v["preferredBaud"], 115200, "扫描不是用户选择，偏好不动");
  } finally {
    t.closePort();
  }
});

test("B2 切档失败回退：新档 921600 无 GET_STATUS 应答 ⇒ 回旧档 115200 并报已回退", async () => {
  const old = new FakeSerialPort();
  answerSetParam(old, profile, "ack", 921600);
  // 只有 115200 回 GET_STATUS；新档 921600 保持沉默（模拟板端切档后没起来）
  const f = new BaudFactory(profile, 115200);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.match(r.detail, /板端已切换但主机未连上（已回退）：新档 921600 无有效 ACK/);
    assert.match(r.detail, /已回旧档 115200/);
    assert.equal(t.baudRate, 115200, "回退后实际档必须回到旧档");
    assert.equal(t.preferredBaud, 115200, "失败不改偏好");
    assert.deepEqual(f.opens.map((o) => o.baud), [921600, 115200], "先开新档失败，再开旧档");
    assert.equal(t.statusView()["open"], true);
  } finally {
    t.closePort();
  }
});

test("B3 UDP 主通道：板端 SET_PARAM 成功（0x91 读回一致）⇒ preferred/lastBaudSwitch 更新，主机串口不动", async () => {
  const m = await LiveTransportManager.create({
    profile, mode: "udp", udpFactory: (_o: UdpOptions) => new FakeUdp(profile), handshake: FAST, log: () => {},
  });
  try {
    const link = m.v3link;
    (link as unknown as { setParam: (o: { serialBaud?: number }) => Promise<unknown> }).setParam = async () => ({
      ok: true, opcode: DOWNLINK.OPCODE.SET_PARAM, seq: 1, status: 0, detail: "OK",
      tlvs: { serialBaud: 921600 },
    });
    const v = await m.switchSerialBaud(921600) as unknown as Record<string, unknown>;
    assert.equal(v["preferredBaud"], 921600);
    assert.deepEqual(v["lastBaudSwitch"], { ok: true, atMs: (v["lastBaudSwitch"] as { atMs: number }).atMs, error: null });
    assert.equal(v["baudRate"], null, "UDP 主通道没有主机串口档位");
    assert.equal(v["boardBaud"], null, "板端读回由真实 statusView 维护，不在此伪造");
    assert.equal(m.kind, "udp");
    // P2-3：切档成功后选择器文案必须更新（前端状态条直接显示 decision.reason）
    assert.match(m.decision.reason, /板端波特率已切到 921600 baud/);
  } finally {
    m.close();
  }
});

test("P2-3 B5 UDP 文案使用当前偏好档，不写死 115200", async () => {
  const m = await LiveTransportManager.create({
    profile, mode: "udp", serialBaud: 460800,
    udpFactory: (_o: UdpOptions) => new FakeUdp(profile), handshake: FAST, log: () => {},
  });
  try {
    const link = m.v3link;
    (link as unknown as { setParam: (o: { serialBaud?: number }) => Promise<unknown> }).setParam = async () => ({
      ok: false, opcode: DOWNLINK.OPCODE.SET_PARAM, seq: 1, status: null, detail: "ACK 超时（1200 ms 内未回）",
    });
    await assert.rejects(() => m.switchSerialBaud(921600), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /板端位流较旧，暂不支持调波特率（仍 460800）：ACK 超时/);
      assert.doesNotMatch(msg, /仍 115200/);
      return true;
    });
    assert.equal(m.preferredBaud, 460800);
  } finally {
    m.close();
  }
});

test("P2-3 串口切档成功后 selector/decision.reason 必须同步新档", async () => {
  const factory: SerialPortFactory = {
    async open(): Promise<FakeSerialPort> {
      const p = new FakeSerialPort();
      p.responder = (frame) => {
        const d = FakeSerialPort.parseDownlink(frame);
        if (d === null) return;
        if (d.opcode === DOWNLINK.OPCODE.GET_STATUS) p.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
        else if (d.opcode === DOWNLINK.OPCODE.SET_PARAM) p.feed(ackBaud(d.seq, 921600));
      };
      return p;
    },
    async list(): Promise<readonly string[]> {
      return ["COM6"];
    },
  };
  const m = await LiveTransportManager.create({
    profile, mode: "uart", serialFactory: factory, handshake: FAST, log: () => {},
  });
  try {
    const v = await m.switchSerialBaud(921600) as unknown as Record<string, unknown>;
    assert.equal(v["baudRate"], 921600);
    assert.equal(m.preferredBaud, 921600);
    assert.match(m.decision.reason, /串口波特率已切到 921600 baud/);
    assert.match(m.decision.reason, /板端读回 921600 baud/);
  } finally {
    m.close();
  }
});

test("B5 UDP 主通道：ACK 超时 ⇒ 明确 B5 文案，不动主通道", async () => {
  const m = await LiveTransportManager.create({
    profile, mode: "udp", udpFactory: (_o: UdpOptions) => new FakeUdp(profile), handshake: FAST, log: () => {},
  });
  try {
    const link = m.v3link;
    (link as unknown as { setParam: (o: { serialBaud?: number }) => Promise<unknown> }).setParam = async () => ({
      ok: false, opcode: DOWNLINK.OPCODE.SET_PARAM, seq: 1, status: null, detail: "ACK 超时（1200 ms 内未回）",
    });
    await assert.rejects(() => m.switchSerialBaud(921600), (err: unknown) => {
      assert.match((err as Error).message, /板端位流较旧，暂不支持调波特率（仍 115200）：ACK 超时/);
      return true;
    });
    assert.equal(m.kind, "udp");
    assert.equal(m.preferredBaud, 115200, "失败不许改偏好");
    assert.equal(m.statusView()["lastBaudSwitch"] && (m.statusView()["lastBaudSwitch"] as { ok: boolean }).ok, false);
  } finally {
    m.close();
  }
});

test("B3 WS RPC：config.set{serialBaud} 走异步切档并回显状态；非整数直接 -32602", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 1, eventsPerFrame: 1 });
  const calls: number[] = [];
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, source: "live" }),
    setConfig: () => ({ pinned: true }),
    snapshot: () => ({ sourceKind: "synth" }),
    setSerialBaud: async (baud) => {
      calls.push(baud);
      return { preferredBaud: baud, lastBaudSwitch: { ok: true, atMs: 1, error: null } };
    },
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    const port = await hub.ready();
    ws = new WebSocket(hub.url);
    const texts: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) texts.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
    await once(ws, "open");
    const rpc = async (id: number, params: unknown): Promise<Record<string, unknown>> => {
      ws?.send(JSON.stringify({ id, method: "config.set", params }));
      const t0 = Date.now();
      for (;;) {
        const hit = texts.find((m) => m["id"] === id);
        if (hit !== undefined) return hit;
        if (Date.now() - t0 > 3000) throw new Error("RPC 超时");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const ok = await rpc(1, { serialBaud: 921600 });
    assert.equal((ok["error"] as { code: number } | undefined)?.code, undefined, JSON.stringify(ok));
    const result = ok["result"] as Record<string, unknown>;
    assert.equal(result["preferredBaud"], 921600);
    assert.equal(result["eventSource"], "board", "config.set 的 eventSource 必须随结果回显");
    assert.deepEqual(calls, [921600]);
    const bad = await rpc(2, { serialBaud: "921600" });
    assert.equal((bad["error"] as { code: number }).code, -32602);
    assert.match(String((bad["error"] as { message: string }).message), /serialBaud 必须是整数波特率/);
    assert.deepEqual(calls, [921600], "非法参数不得触达数据源");
  } finally {
    ws?.close();
    hub.close();
  }
});

test("B3 非法档位：串口与 UDP 两条路径都拒绝非 4 档值", async () => {
  const old = new FakeSerialPort();
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, handshake: { enabled: false },
  });
  try {
    await assert.rejects(() => t.switchBaud(57600), /串口波特率必须是 115200 \/ 230400 \/ 460800 \/ 921600 之一/);
  } finally {
    t.closePort();
  }
});

test("R-2 切档前握手 OK，但旧档重开/扫描全败 ⇒ 终态必须显式失败，baudRate 不得停在最后尝试档", async () => {
  const old = new FakeSerialPort();
  old.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d === null) return;
    if (d.opcode === DOWNLINK.OPCODE.GET_STATUS) old.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
    else if (d.opcode === DOWNLINK.OPCODE.SET_PARAM) old.feed(ackBaud(d.seq, 921600));
  };
  // 旧档 115200 在回退/扫描时都打不开；其它档能打开但一个字节都不回（全静默）。
  const f: SerialPortFactory = {
    async open(opts: SerialOpenOptions): Promise<FakeSerialPort> {
      if (opts.baudRate === 115200) throw new Error("测试：115200 口打不开");
      return new FakeSerialPort();
    },
    async list(): Promise<readonly string[]> {
      return ["COM6"];
    },
  };
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: FAST,
  });
  try {
    assert.equal(t.handshake.ok, true, "前置条件：切档前串口握手必须是真的 OK");
    const r = await t.switchBaud(921600);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, false);
    assert.match(r.detail, /旧档 115200 重开失败/);
    assert.match(r.detail, /扫描未命中/);
    const v = t.statusView();
    assert.equal(v["open"], false, "扫描全败后端口必须关闭");
    assert.equal(v["handshakeOk"], false, "R-2：不能把切档前的 hs.ok=true 留在状态里");
    assert.equal(v["baudRate"], null, "R-2：端口已关闭，不能回显最后尝试的 230400");
    assert.deepEqual(v["baudScan"], {
      running: false,
      tried: [115200, 921600, 460800, 230400],
      hit: null,
    });
    assert.equal(r.baudRate, 115200, "终态结果回落到用户偏好档，而不是最后尝试档");
    assert.equal((t.handshake as { ok: boolean }).ok, false);
  } finally {
    t.closePort();
  }
});

