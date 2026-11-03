#!/usr/bin/env node
// task-18 A 项（传输切换修复）机读判据：TRANSPORT2_OK=1
//
// 现场复现（用户 m01746）：网关以 --udp 启动 → 用户切到串口（active=uart，但启动模式仍 udp）
// → 用户点「网口」被"已经是网口档"早退，FRAME_RAW 再也不来。
//
// 本脚本不碰 1234/8787、不碰真板：全部用 FakeUdp + FakeSerialPort，走真实 LiveTransportManager、
// 真实 v3 装配器和真实前端 chip 纯函数。覆盖：
//   A1 chip 只认 active（启动模式不压 active）
//   A2 点当前 active chip = force 重建；同 kind 非 force = 早退
//   A3 switchAuto 两分支（网口在线 → udp；网口不在 + 串口可用 → uart）
//   A4/A5 现场复现 3 s 内 FRAME_RAW 恢复，statusView.active=udp（即 STATS transport.active）
//   BLOCK-3R 收过包后静默 3.3 s ⇒ degraded，必须释放旧 socket 后重探（不能复用 stale UDP）
//
// 用法：node tools/_verify_transport2.mjs
import { getProfile, MODE3 } from "@retina/protocol";
import { BaseFrameSource } from "../gateway/src/transport/base.ts";
import { LiveTransportManager } from "../gateway/src/transport/live.ts";
import { buildV3 } from "../packages/protocol/test/helpers.ts";
import { ctrlAck, FakeSerialPort, portFactory } from "../gateway/test/serial_fakes.ts";
import { transportChipSelected, transportClickForce } from "../web/src/transport_labels.ts";

const profile = getProfile("retina-v2-800x480-1280");
const FAST_HS = { attempts: 1, ackTimeoutMs: 10, gapMs: 1 };
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;
const results = [];
// 本脚本没有服务器/socket 常驻句柄，而 LiveTransportManager 的探测/握手定时器有意 unref（不拖住网关进程）。
// 顶层 await 期间若事件循环为空，Node 会以 13 退出；用一个显式 ref 的 interval 撑住，结束再清。
const keepAlive = setInterval(() => {}, 1000);

function check(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + " ⇒ " + detail);
}

class FakeUdp extends BaseFrameSource {
  rxPackets = 0;
  detail = "fake-udp";
  deliver;

  constructor(p0, deliver) {
    super({ profile: p0 });
    this.deliver = deliver;
  }

  onStart() {
    if (this.deliver) this.rxPackets = 1;
  }

  setTsOffsetUs(_offsetUs) {
    /* 验证不关心时间校准 */
  }

  feedBytes(buf, t = Date.now()) {
    this.feed(buf, t);
  }
}

function fakeSerial() {
  const port = new FakeSerialPort();
  port.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d?.opcode === 0x04) port.feed(ctrlAck(profile, 0x04, d.seq));
  };
  return port;
}

function fullFrame(udp, frameIdx, tsBase) {
  const raw = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < raw.length; i += 89) raw[i] = (i * 11 + 5) & 0xff;
  for (let ci = 0; ci < N; ci++) {
    udp.feedBytes(buildV3({
      frameIdx,
      chunkIdx: ci,
      raw: raw.subarray(ci * CHUNK, (ci + 1) * CHUNK),
      mode: 0,
      first: ci === 0,
      last: ci === N - 1,
      tsUs: tsBase + ci,
    }), tsBase / 1000 + ci);
  }
}

// —— A1：chip 只认 active，启动模式 udp 不能压过 active=uart ——
check(transportChipSelected("uart", "uart", "udp") === true, "A1 串口 chip 高亮", "active=uart / 启动=udp");
check(transportChipSelected("udp", "uart", "udp") === false, "A1 网口 chip 不高亮", "active=uart / 启动=udp：启动模式不能压过 active");
check(transportChipSelected("auto", "uart", "auto") === false, "A1 自动 chip 不高亮", "active=uart / 启动=auto");
check(transportClickForce("udp", "uart") === false, "A1 点网口=普通切换", "active=uart ⇒ 不能当成『已是当前档』早退");
check(transportClickForce("uart", "uart") === true, "A2 点当前 active chip=force", "active=uart ⇒ 强制重建");

// —— A2：同 kind 非 force 早退，force 必须重建 ——
{
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o) => {
      built += 1;
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    const d0 = await m.switchTo("udp");
    check(built === 1 && /已是当前通道/.test(d0.reason), "A2 同 kind 非 force 不重建", "built=" + built + " reason=" + d0.reason);
    const d1 = await m.switchTo("udp", { force: true });
    check(built === 2 && d1.active === "udp", "A2 force 重建当前通道", "built=" + built + " active=" + d1.active);
  } finally {
    m.close();
  }
}

// —— A3 分支 1：网口在线 ⇒ 切 udp，且重复 auto 不重建 ——
{
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "uart",
    udpFactory: (_o) => {
      built += 1;
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    const d = await m.switchAuto();
    check(d.active === "udp" && /自动选择：网口在线/.test(d.reason), "A3 auto 网口在线⇒udp", "active=" + d.active + " reason=" + d.reason);
    await m.switchAuto();
    check(built === 1, "A3 重复 auto 不重建在线网口", "built=" + built);
  } finally {
    m.close();
  }
}

// —— A3 分支 2：网口不在 + 串口可用 ⇒ 保持 uart，并说明两条探测结果 ——
{
  const m = await LiveTransportManager.create({
    profile,
    mode: "uart",
    udpProbeMs: 10,
    udpFactory: (_o) => new FakeUdp(profile, false),
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    const d = await m.switchAuto();
    check(d.active === "uart" && /自动选择：网口不可用/.test(d.reason) && /串口/.test(d.reason),
      "A3 auto 网口不在⇒保持串口", "active=" + d.active + " reason=" + d.reason);
  } finally {
    m.close();
  }
}

// —— BLOCK-3 复查：UDP running 但 rxPackets=0 不能算在线；必须释放旧 socket 后重探 ——
{
  let built = 0;
  let first = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o) => {
      built += 1;
      const u = new FakeUdp(profile, built > 1);
      if (built === 1) first = u;
      return u;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    first.rxPackets = 0; // running=true 但一个包都没有：旧实现会把它当在线并直接早退
    const d = await m.switchAuto();
    check(built === 2 && d.active === "udp" && m.statusView().active === "udp"
      && /自动选择：网口在线/.test(d.reason),
      "BLOCK-3 auto 0 包必须释放重探", "built=" + built + " active=" + d.active + " reason=" + d.reason);
    const link = m.v3link;
    const orig = link.statusView.bind(link);
    link.statusView = () => ({ ...orig(), mode: MODE3.EV_ONLY });
    check(m.statusView().noRaw === true, "P1-1 EV_ONLY ⇒ transport.noRaw=true",
      "noRaw=" + String(m.statusView().noRaw));
  } finally {
    m.close();
  }
}

// —— BLOCK-3 复查：UDP 0 包且串口也打不开 ⇒ 明确 NoTransport，不保留死网口 ——
{
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o) => {
      built += 1;
      return new FakeUdp(profile, false);
    },
    serialFactory: {
      async open() { throw new Error("测试：没有可用串口"); },
      async list() { return []; },
    },
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    let msg = "";
    try {
      await m.switchAuto();
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    check(/没有可用的数据通道/.test(msg) && m.statusView().active === null && built === 2,
      "BLOCK-3 auto 双失败⇒明确 NoTransport", "msg=" + msg + " active=" + String(m.statusView().active) + " built=" + built);
  } finally {
    m.close();
  }
}

// —— P2-1 复查：UDP force 首次重建失败 ⇒ 自动重绑并恢复 primary，不把通道丢成 null ——
{
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o) => {
      built += 1;
      if (built === 2) throw new Error("测试：首次重绑失败");
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    const d = await m.switchTo("udp", { force: true });
    check(built === 3 && d.active === "udp" && m.statusView().active === "udp"
      && /已重新建立并恢复/.test(d.reason),
      "P2-1 force 首次失败⇒自动恢复", "built=" + built + " active=" + d.active + " reason=" + d.reason);
  } finally {
    m.close();
  }
}

// —— BLOCK-3R 复查：UDP 收过包后静默 3.3 s ⇒ degraded，必须释放旧 socket 后重探 ——
{
  let built = 0;
  let first = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o) => {
      built += 1;
      const u = new FakeUdp(profile, true);
      if (built === 1) first = u;
      return u;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    first.rxPackets = 3; // 曾收过包 ≠ 仍在线；3.3 s 后 health 必须判 degraded
    m.statusView(); // 建立活性基线
    await new Promise((resolve) => setTimeout(resolve, 3300));
    const h = m.statusView().health;
    check(h !== null && h.state === "degraded", "BLOCK-3R 曾收包后静默⇒degraded",
      "health=" + JSON.stringify(h));
    const d = await m.switchAuto();
    check(built === 2 && d.active === "udp" && m.statusView().active === "udp"
      && !/已收到 3 包/.test(d.reason),
      "BLOCK-3R stale UDP 必须释放重探", "built=" + built + " active=" + d.active + " reason=" + d.reason);
  } finally {
    m.close();
  }
}

// —— A4/A5 现场复现：--udp 启动 → 切 uart → 点网口（普通切换）→ 3 s 内 FRAME_RAW 恢复 ——
{
  let udp = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o) => {
      udp = new FakeUdp(profile, true);
      return udp;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    check(m.statusView().active === "udp", "现场① 初始 active=udp", "启动模式 udp");
    const du = await m.switchTo("uart");
    check(du.active === "uart" && m.decision.mode === "udp", "现场② 切串口后 active=uart，启动模式仍 udp",
      "active=" + du.active + " decision.mode=" + m.decision.mode);
    const tSwitch = Date.now();
    const dd = await m.switchTo("udp");
    check(dd.active === "udp" && m.statusView().active === "udp", "现场③ 点网口成功切回", "active=" + dd.active);
    fullFrame(udp, 91, 8_000_000);
    const v = m.statusView();
    check(v.rawFrames === 1 && typeof v.lastRawFrameAtMs === "number",
      "A4 切回后恢复 FRAME_RAW", "rawFrames=" + v.rawFrames + " lastRawFrameAtMs=" + String(v.lastRawFrameAtMs));
    check(typeof v.rawRecoverMs === "number" && v.rawRecoverMs < 3000,
      "A4 3 s 内恢复", "rawRecoverMs=" + String(v.rawRecoverMs));
    check(Date.now() - tSwitch < 3000, "现场④ 切换总耗时 <3 s", "elapsed=" + (Date.now() - tSwitch) + " ms");
    // STATS 1 Hz 的 transport 字段就是 statusView()；active 必须如实为 udp（不是启动模式）
    check(v.active === "udp", "A5 STATS transport.active=udp", "statusView().active=" + v.active);
  } finally {
    m.close();
  }
}

clearInterval(keepAlive);
const bad = results.filter((r) => !r.ok);
console.log("");
if (bad.length === 0) {
  console.log("判据：A1..A5 全部通过（现场复现 3 s 内恢复 FRAME_RAW）");
  console.log("TRANSPORT2_OK=1");
  process.exit(0);
}
console.log("TRANSPORT2_OK=0  失败项：" + bad.map((r) => r.name).join(" / "));
process.exit(1);
