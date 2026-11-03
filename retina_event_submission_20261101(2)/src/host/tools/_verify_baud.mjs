#!/usr/bin/env node
// task-18 B 项（串口波特率 4 档）机读判据：BAUDUI_OK=1
//
// 不碰真 COM6、不烧板、不占 1234/8787：全部用 FakeSerialPort + 真 SerialTransport / LiveTransportManager。
// 覆盖：
//   B1 旧位流兼容：旧 SET_PARAM ACK（CTRL_LEN=23）/ 旧 GET_STATUS ACK（CTRL_LEN=65）仍可解析，0x91 缺失=null
//   B2 扫描命中 230400（阶梯第 4 档，轨迹按实际尝试顺序）
//   B2 切档舞蹈：旧档 0x0C + ACK 0x91 → close 旧口 → open 新档 → GET_STATUS 握手
//   B2 新档连不上 ⇒ 回旧档并报"已回退"
//   B5 旧位流 ACK 无 0x91 ⇒ 保持原档 / preferred 不改 / 不重试 / 不关旧口
//   B3 UDP 主通道下发 SET_PARAM ⇒ preferred + lastBaudSwitch 更新，主机串口不动
//   R-2 旧档重开失败 + 扫描全败 ⇒ 终态 handshakeOk=false / baudRate=null，不假报已回退
//
// 用法：node tools/_verify_baud.mjs
import { CTRL, DOWNLINK, getProfile, interpretStatusTlvs, parseV3Packet, serialBaudCode } from "@retina/protocol";
import { SerialTransport } from "../gateway/src/transport/serial.ts";
import { LiveTransportManager } from "../gateway/src/transport/live.ts";
import { BaseFrameSource } from "../gateway/src/transport/base.ts";
import { ctrlAck, FakeSerialPort } from "../gateway/test/serial_fakes.ts";
import { buildV3, concatU8, v3Tlv } from "../packages/protocol/test/helpers.ts";

const profile = getProfile("retina-v2-800x480-1280");
const FAST = { attempts: 1, ackTimeoutMs: 25, gapMs: 0 };
const results = [];
const keepAlive = setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + " ⇒ " + detail);
}

function ackBaud(seq, baud) {
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

/** 每次 open 返回一只新假口；hitBaud 回 GET_STATUS（模拟板端在线），其它档沉默。 */
class BaudFactory {
  opens = [];
  events = [];
  hitBaud;

  constructor(hitBaud, events = []) {
    this.hitBaud = hitBaud;
    this.events = events;
  }

  async open(opts) {
    const port = new FakeSerialPort();
    this.events.push("open:" + opts.baudRate);
    this.opens.push({ baud: opts.baudRate, port });
    port.responder = (frame) => {
      const d = FakeSerialPort.parseDownlink(frame);
      if (d === null) return;
      if (d.opcode === DOWNLINK.OPCODE.GET_STATUS && opts.baudRate === this.hitBaud) {
        this.events.push("handshake:" + opts.baudRate);
        port.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
      }
    };
    return port;
  }

  async list() {
    return ["COM6"];
  }
}

/** 旧档句柄：SET_PARAM → 带 0x91 的成功 ACK / 不带 0x91 的旧 23 B ACK。 */
function answerSetParam(port, mode, target, events = []) {
  port.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d === null || d.opcode !== DOWNLINK.OPCODE.SET_PARAM) return;
    if (mode === "ack") {
      events.push("ack:115200");
      port.feed(ackBaud(d.seq, target));
    } else if (mode === "no-tlv") {
      events.push("ack23:115200");
      port.feed(ctrlAck(profile, DOWNLINK.OPCODE.SET_PARAM, d.seq, 23));
    }
  };
}

class FakeUdp extends BaseFrameSource {
  rxPackets = 0;
  detail = "fake-udp";
  constructor(p0) {
    super({ profile: p0 });
  }
  onStart() {
    this.rxPackets = 1;
  }
  setTsOffsetUs(_offsetUs) {
    /* 无关 */
  }
}

// —— B1：旧位流 23/65 仍可解析，0x91 缺失必须映射为 null（不是用下发值顶替） ——
{
  const old23 = parseV3Packet(ctrlAck(profile, DOWNLINK.OPCODE.SET_PARAM, 7, 23), { profile });
  const old65 = parseV3Packet(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, 8, 65), { profile });
  const tlv23 = old23.ok ? old23.value.ctrlHeader?.tlv ?? [] : [];
  const tlv65 = old65.ok ? old65.value.ctrlHeader?.tlv ?? [] : [];
  check(old23.ok && old65.ok, "B1 旧 SET_PARAM 23 / GET_STATUS 65 可解析",
    "ok23=" + old23.ok + " ok65=" + old65.ok);
  check(old23.ok && old23.value.ctrlHeader?.ctrlLen === 23, "B1 旧 SET_PARAM ACK len=23",
    "ctrlLen=" + String(old23.ok ? old23.value.ctrlHeader?.ctrlLen : "parse-fail"));
  check(old65.ok && old65.value.ctrlHeader?.ctrlLen === 65, "B1 旧 GET_STATUS ACK len=65",
    "ctrlLen=" + String(old65.ok ? old65.value.ctrlHeader?.ctrlLen : "parse-fail"));
  check(interpretStatusTlvs(tlv23).serialBaud === null && interpretStatusTlvs(tlv65).serialBaud === null,
    "B1 旧位流无 0x91 ⇒ serialBaud=null", "两帧都回 null（不能用请求值顶替）");
  // P2-2 复查：0x91 必须严格 len==1；len=2 时按缺失处理，不能截取首字节猜档位。
  const len2 = interpretStatusTlvs([{ tag: CTRL.TLV.SER_BAUD_STATE, value: Uint8Array.of(2, 3) }]);
  check(len2.serialBaud === null, "P2-2 0x91 非 len==1 ⇒ 按缺失", "serialBaud=" + String(len2.serialBaud));
}

// —— BLOCK-1 复查：切档成功必须重启心跳（detach 会 stop），否则 5 s 无帧被自动回退误判 ——
{
  const old = new FakeSerialPort();
  answerSetParam(old, "ack", 921600);
  const f = new BaudFactory(921600);
  let sent = 0;
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
    heartbeat: { intervalMs: 25, send: () => { sent += 1; } },
  });
  try {
    t.start();
    await sleep(80);
    const before = sent;
    const r = await t.switchBaud(921600);
    check(r.ok === true && t.statusView().heartbeat.enabled === true,
      "BLOCK-1 切档成功后心跳立即恢复", "ok=" + String(r.ok) + " enabled=" + String(t.statusView().heartbeat.enabled));
    await sleep(1150);
    check(sent > before && t.statusView().heartbeat.enabled === true,
      "BLOCK-1 切档后心跳继续发", "sentBefore=" + before + " sentAfter=" + sent + " enabled=" + String(t.statusView().heartbeat.enabled));
  } finally {
    t.closePort();
  }
}

// —— BLOCK-2 复查：新档+旧档都静默 ⇒ 必须进扫描，明确失败，不得报已回退 ——
{
  const old = new FakeSerialPort();
  answerSetParam(old, "ack", 921600);
  const f = new BaudFactory(0);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    check(r.ok === false && r.rolledBack === false
      && /旧档 115200 无 ACK/.test(r.detail) && /扫描未命中/.test(r.detail)
      && !/已回旧档|已回退/.test(r.detail),
      "BLOCK-2 旧档也失败⇒进扫描且不假报回退", "ok=" + String(r.ok) + " rolledBack=" + String(r.rolledBack) + " detail=" + r.detail);
    const v = t.statusView();
    check(v.baudScan && v.baudScan.running === false && v.baudScan.hit === null
      && v.baudScan.tried.join(",") === "115200,921600,460800,230400",
      "BLOCK-2 扫描轨迹可查", "tried=" + ((v.baudScan && v.baudScan.tried) || []).join(",") + " hit=" + String(v.baudScan && v.baudScan.hit));
  } finally {
    t.closePort();
  }
}

// —— BLOCK-2 复查：旧档无 ACK 但扫描命中 460800 ⇒ 恢复链路并明确报扫描命中 ——
{
  const old = new FakeSerialPort();
  answerSetParam(old, "ack", 921600);
  const f = new BaudFactory(460800);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    check(r.ok === false && r.rolledBack === false && r.baudRate === 460800
      && /扫描命中并恢复到 460800 baud/.test(r.detail) && !/已回退/.test(r.detail),
      "BLOCK-2 扫描命中恢复 460800", "ok=" + String(r.ok) + " baud=" + r.baudRate + " detail=" + r.detail);
    check(t.statusView().handshakeOk === true && t.preferredBaud === 115200,
      "BLOCK-2 扫描恢复后链路在线且偏好不变", "handshakeOk=" + String(t.statusView().handshakeOk) + " preferred=" + t.preferredBaud);
  } finally {
    t.closePort();
  }
}

// —— B2 扫描：首选 115200 无 ACK → 230400 命中（阶梯第 4 档） ——
{
  const f = new BaudFactory(230400);
  const t = await SerialTransport.open({ profile, path: "COM6", baudRate: 115200, factory: f, handshake: FAST });
  try {
    const v = t.statusView();
    const tried = (v.baudScan && v.baudScan.tried) || [];
    check(t.baudRate === 230400 && f.opens.map((o) => o.baud).join(",") === "115200,921600,460800,230400",
      "B2 扫描命中 230400", "opens=" + f.opens.map((o) => o.baud).join(",") + " baudRate=" + t.baudRate);
    check(v.baudScan && v.baudScan.hit === 230400 && tried.join(",") === "115200,921600,460800,230400",
      "B2 baudScan 轨迹按实际尝试顺序", "tried=" + tried.join(",") + " hit=" + String(v.baudScan && v.baudScan.hit));
    check(v.handshakeOk === true && t.preferredBaud === 115200, "B2 命中后正式握手，扫描不改偏好",
      "handshakeOk=" + String(v.handshakeOk) + " preferred=" + t.preferredBaud);
  } finally {
    t.closePort();
  }
}

// —— B2 舞蹈：ACK → close 旧档 → open 新档 → 握手（顺序即判据） ——
{
  const events = [];
  const old = new FakeSerialPort();
  answerSetParam(old, "ack", 921600, events);
  const oldClose = old.close.bind(old);
  old.close = (cb) => {
    events.push("close:115200");
    return oldClose(cb);
  };
  const f = new BaudFactory(921600, events);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    check(r.ok && r.baudRate === 921600 && r.boardBaud === 921600 && r.preferredBaud === 921600,
      "B2 切档成功且读回一致", "ok=" + String(r.ok) + " baud=" + r.baudRate + " board=" + String(r.boardBaud) + " preferred=" + r.preferredBaud);
    check(events.join(" < ") === "ack:115200 < close:115200 < open:921600 < handshake:921600",
      "B2 舞蹈顺序 ACK<close<open<handshake", events.join(" < "));
    check(old.closed === true && f.opens.length === 1 && f.opens[0].baud === 921600,
      "B2 旧口已关、只开新档", "oldClosed=" + String(old.closed) + " opens=" + f.opens.map((o) => o.baud).join(","));
    const v = t.statusView();
    check(v.baudRate === 921600 && v.boardBaud === 921600 && v.lastBaudSwitch && v.lastBaudSwitch.ok === true,
      "B2 statusView 反映新档", "baud=" + String(v.baudRate) + " board=" + String(v.boardBaud) + " last.ok=" + String(v.lastBaudSwitch && v.lastBaudSwitch.ok));
  } finally {
    t.closePort();
  }
}

// —— B2 回退：新档 921600 无 GET_STATUS ⇒ 回旧档 115200 并明确报已回退 ——
{
  const old = new FakeSerialPort();
  answerSetParam(old, "ack", 921600);
  const f = new BaudFactory(115200);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    check(r.ok === false && r.rolledBack === true && r.baudRate === 115200,
      "B2 新档不通⇒回旧档", "ok=" + String(r.ok) + " rolledBack=" + String(r.rolledBack) + " baud=" + r.baudRate);
    check(/板端已切换但主机未连上（已回退）/.test(r.detail) && /已回旧档 115200/.test(r.detail),
      "B2 回退文案含原因", r.detail);
    check(f.opens.map((o) => o.baud).join(",") === "921600,115200" && t.preferredBaud === 115200,
      "B2 先开新档失败再开旧档，偏好不变", "opens=" + f.opens.map((o) => o.baud).join(",") + " preferred=" + t.preferredBaud);
  } finally {
    t.closePort();
  }
}

// —— B5 旧位流：ACK 无 0x91（旧 23 B） ⇒ 保持原档、不重试、不关旧口、偏好不改 ——
{
  const old = new FakeSerialPort();
  answerSetParam(old, "no-tlv", 921600);
  const f = new BaudFactory(921600);
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: { enabled: false },
  });
  try {
    const r = await t.switchBaud(921600);
    check(r.ok === false && r.unsupported === true && r.baudRate === 115200,
      "B5 旧位流明确降级", "ok=" + String(r.ok) + " unsupported=" + String(r.unsupported) + " baud=" + r.baudRate);
    check(/板端位流较旧，暂不支持调波特率（仍 115200 baud）/.test(r.detail),
      "B5 文案", r.detail);
    check(old.closed === false && f.opens.length === 0 && t.preferredBaud === 115200 && t.boardBaud === null,
      "B5 不重试/不关旧口/不改偏好/不伪造读回",
      "closed=" + String(old.closed) + " opens=" + f.opens.length + " preferred=" + t.preferredBaud + " board=" + String(t.boardBaud));
  } finally {
    t.closePort();
  }
}

// —— P2-3 复查：B5 文案必须用当前偏好档，不能写死 115200 ——
{
  const m = await LiveTransportManager.create({
    profile, mode: "udp", serialBaud: 460800, udpFactory: (_o) => new FakeUdp(profile), handshake: FAST, log: () => {},
  });
  try {
    const link = m.v3link;
    link.setParam = async () => ({
      ok: false, opcode: DOWNLINK.OPCODE.SET_PARAM, seq: 1, status: null, detail: "ACK 超时（1200 ms 内未回）",
    });
    let msg = "";
    try {
      await m.switchSerialBaud(921600);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    check(/仍 460800/.test(msg) && !/仍 115200/.test(msg) && m.preferredBaud === 460800,
      "P2-3 B5 文案用当前偏好档", "msg=" + msg + " preferred=" + m.preferredBaud);
  } finally {
    m.close();
  }
}

// —— B3 UDP 主通道：下发 SET_PARAM 成功 ⇒ preferred/lastBaudSwitch 更新，主机串口不动 ——
{
  const m = await LiveTransportManager.create({
    profile, mode: "udp", udpFactory: (_o) => new FakeUdp(profile), handshake: FAST, log: () => {},
  });
  try {
    const link = m.v3link;
    link.setParam = async () => ({
      ok: true, opcode: DOWNLINK.OPCODE.SET_PARAM, seq: 1, status: 0, detail: "OK",
      tlvs: { serialBaud: 921600 },
    });
    const v = await m.switchSerialBaud(921600);
    check(v.preferredBaud === 921600 && v.lastBaudSwitch && v.lastBaudSwitch.ok === true,
      "B3 UDP 下发成功⇒preferred 更新", "preferred=" + String(v.preferredBaud) + " last.ok=" + String(v.lastBaudSwitch && v.lastBaudSwitch.ok));
    check(v.baudRate === null && m.kind === "udp",
      "B3 UDP 主通道主机串口不动", "baudRate=" + String(v.baudRate) + " kind=" + m.kind);
  } finally {
    m.close();
  }
}

// —— R-2 复查：切档前握手 OK，但旧档重开失败且扫描全败 ⇒ 终态必须显式失败 ——
{
  const old = new FakeSerialPort();
  old.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d === null) return;
    if (d.opcode === DOWNLINK.OPCODE.GET_STATUS) {
      old.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
    } else if (d.opcode === DOWNLINK.OPCODE.SET_PARAM) {
      old.feed(ackBaud(d.seq, 921600));
    }
  };
  const opens = [];
  const f = {
    async open(opts) {
      opens.push(opts.baudRate);
      if (opts.baudRate === 115200) throw new Error("测试：115200 口打不开");
      return new FakeSerialPort(); // 其它档可打开但静默：握手必超时
    },
    async list() {
      return ["COM6"];
    },
  };
  const t = await SerialTransport.open({
    profile, path: "COM6", baudRate: 115200, port: old, factory: f, handshake: FAST,
  });
  const hsBefore = t.handshake.ok;
  const r = await t.switchBaud(921600);
  const v = t.statusView();
  check(hsBefore === true && r.ok === false && r.rolledBack === false
    && /旧档 115200 重开失败/.test(r.detail) && /扫描未命中/.test(r.detail),
    "R-2 全败⇒明确失败且不假报回滚", "hsBefore=" + String(hsBefore) + " ok=" + String(r.ok) + " rolledBack=" + String(r.rolledBack) + " detail=" + r.detail);
  check(v.open === false && v.handshakeOk === false && v.baudRate === null && t.handshake.ok === false,
    "R-2 终态不残留已连接/波特率", "open=" + String(v.open) + " handshakeOk=" + String(v.handshakeOk) + " baudRate=" + String(v.baudRate) + " hs.ok=" + String(t.handshake.ok));
  check(r.baudRate === 115200 && v.baudScan && v.baudScan.running === false && v.baudScan.hit === null
    && v.baudScan.tried.join(",") === "115200,921600,460800,230400",
    "R-2 结果回偏好档、扫描轨迹保留", "r.baudRate=" + r.baudRate + " tried=" + ((v.baudScan && v.baudScan.tried) || []).join(",") + " opens=" + opens.join(","));
  t.closePort();
}

clearInterval(keepAlive);
const bad = results.filter((r) => !r.ok);
console.log("");
if (bad.length === 0) {
  console.log("判据：B1/B2/B3/B5 + R-2 全部通过（B4 为前端 chip/文案，见 gateway/web 单测）");
  console.log("BAUDUI_OK=1");
  process.exit(0);
}
console.log("BAUDUI_OK=0  失败项：" + bad.map((r) => r.name).join(" / "));
process.exit(1);
