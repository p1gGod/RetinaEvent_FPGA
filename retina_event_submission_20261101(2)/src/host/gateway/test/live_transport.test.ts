// 实时数据面管理器测试（UART 路线 WIRE-U1 §1.3 / §5.3 / §8.2 H4）：
// 探测 → 选择 → 建通道 → （失败时）降级，全部走真实代码路径，只把两条 IO 边（UDP 源 / 串口工厂）换成假件。
//
// 判据覆盖：
//   ① 显式 UART 打开失败 ⇒ 抛 SerialOpenError（明确报错），且**不碰** UDP（不静默回退）；
//   ② auto：网口不在 + 串口可用 ⇒ 主通道换到串口并标 degraded（仅事件回传）；
//   ③ auto：网口在 + 串口打不开 ⇒ 主通道仍是 UDP，串口失败原因进 failures（如实）；
//   ④ auto：两侧都不可用 ⇒ NoTransportError，两条原因都在；
//   ⑤ 运行期切换失败**不影响**当前通道；成功则换源（onSourceChange 被调用）；
//   ⑥ 运行期降级：UDP 报停滞错 ⇒ 自动换到已探过的串口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { IFrameSource, Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager, NoTransportError } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { SerialOpenError } from "../src/transport/serial.ts";
import { FakeSerialPort, ctrlAck, failingFactory, portFactory } from "./serial_fakes.ts";
import { CTRL, DOWNLINK } from "@retina/protocol";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;
const FAST_HS = { attempts: 1, ackTimeoutMs: 10, gapMs: 1 } as const;

/** 假 UDP 源：deliver=true 时探测窗口内"收到包"（模拟板端在发），否则一个都没有 */
class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  readonly detail = "fake-udp";
  private readonly deliver: boolean;

  constructor(profile0: Profile, deliver: boolean) {
    super({ profile: profile0 });
    this.deliver = deliver;
  }

  protected override onStart(): void {
    if (this.deliver) this.rxPackets = 1;
  }

  setTsOffsetUs(_offsetUs: number | null): void {
    /* 测试里不关心 */
  }

  /** 模拟"绑定成功但收不到流"（UdpTransport 在 5 s 零包时发的非致命错误） */
  stall(): void {
    this.emitError({ code: "udp-stall", message: "UDP 已绑定但 5000 ms 内未收到任何包（先绑定者独占收包）", fatal: false });
  }
}

interface Recorder {
  readonly sources: IFrameSource[];
}

function mk(opts: {
  deliverUdp?: boolean;
  serial?: "ok" | "fail";
  serialPort?: FakeSerialPort;
}): { manager: Promise<LiveTransportManager>; rec: Recorder } {
  const rec: Recorder = { sources: [] };
  const port = opts.serialPort ?? new FakeSerialPort();
  if (opts.serial === "ok") {
    port.responder = (frame) => {
      const d = FakeSerialPort.parseDownlink(frame);
      if (d?.opcode === DOWNLINK.OPCODE.GET_STATUS) port.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
    };
  }
  const manager = LiveTransportManager.create({
    profile,
    mode: "auto",
    udpProbeMs: 10,
    udpFactory: (_o: UdpOptions) => new FakeUdp(profile, opts.deliverUdp ?? false),
    ...(opts.serial === undefined
      ? {}
      : { serialFactory: opts.serial === "ok" ? portFactory(port) : failingFactory("COM6", ["COM1", "COM4"]) }),
    handshake: FAST_HS,
    onSourceChange: (s) => rec.sources.push(s),
    log: () => {},
  });
  return { manager, rec };
}

test("auto：网口不在（收不到包）+ 串口可用 ⇒ 降级到串口（仅事件回传），且说明能力缺失", async () => {
  const { manager, rec } = mk({ deliverUdp: false, serial: "ok" });
  const m = await manager;
  try {
    assert.equal(m.kind, "uart");
    assert.equal(m.decision.degraded, true);
    assert.equal(m.decision.state, "degraded");
    assert.equal(m.decision.active, "uart");
    assert.match(m.decision.reason, /仅事件回传/);
    assert.match(m.decision.failures.udp ?? "", /未收到任何包/);
    assert.equal(rec.sources.length, 1, "主通道只建一次（串口）");
    const view = m.statusView();
    assert.equal(view.decision.active, "uart");
    assert.equal(view.uart?.["path"], "COM6");
    assert.equal(view.uart?.["handshakeOk"], true);
    assert.equal(view.probes["uart"]?.ok, true);
  } finally {
    m.close();
  }
});

test("auto：网口在 + 串口打不开 ⇒ 主通道仍是 UDP，串口失败原因如实登记（不是失败）", async () => {
  const { manager, rec } = mk({ deliverUdp: true, serial: "fail" });
  const m = await manager;
  try {
    assert.equal(m.kind, "udp");
    assert.equal(m.decision.state, "active");
    assert.equal(m.decision.degraded, false);
    assert.equal(m.decision.secondary, null);
    assert.match(m.decision.failures.uart ?? "", /COM6 打开失败/);
    assert.equal(rec.sources.length, 1, "串口探失败不应换主通道");
    assert.equal(m.statusView().uart, null, "没有串口通道就不该报串口状态（显式 null，不是缺字段）");
  } finally {
    m.close();
  }
});

test("auto：两侧都不可用 ⇒ NoTransportError，消息里 UDP 与串口两条原因都在", async () => {
  const { manager } = mk({ deliverUdp: false, serial: "fail" });
  await assert.rejects(() => manager, (err: unknown) => {
    assert.ok(err instanceof NoTransportError);
    assert.match(err.message, /没有可用的数据通道/);
    assert.match(err.message, /未收到任何包/);
    assert.match(err.message, /COM6 打开失败/);
    assert.match(err.message, /--transport auto/);
    return true;
  });
});

test("显式 UART 打开失败 ⇒ 直接抛 SerialOpenError，绝不偷偷回退到网口", async () => {
  let udpBuilt = 0;
  const manager = LiveTransportManager.create({
    profile,
    mode: "uart",
    udpProbeMs: 10,
    udpFactory: () => { udpBuilt++; return new FakeUdp(profile, true); },
    serialFactory: failingFactory("COM6", ["COM1"]),
    handshake: FAST_HS,
    log: () => {},
  });
  await assert.rejects(() => manager, (err: unknown) => {
    assert.ok(err instanceof SerialOpenError, "必须是串口打开失败的明确类型");
    assert.match(err.message, /COM6 打开失败/);
    assert.match(err.message, /当前可用串口：COM1/);
    return true;
  });
  assert.equal(udpBuilt, 0, "显式选串口时根本不该去建 UDP（不静默回退）");
});

test("运行期切换：失败则当前通道不动；成功则换源并更新状态视图", async () => {
  const okPort = new FakeSerialPort();
  const { manager, rec } = mk({ deliverUdp: true, serial: "ok", serialPort: okPort });
  const m = await manager;
  try {
    assert.equal(m.kind, "udp");
    assert.equal(m.decision.secondary, "uart", "auto 下串口作第二观察通道");
    // ① 切到一个打不开的口：必须抛错，主通道仍是 UDP
    const badPort = new FakeSerialPort();
    const m2 = await LiveTransportManager.create({
      profile,
      mode: "udp",
      udpFactory: () => new FakeUdp(profile, true),
      serialFactory: failingFactory("COM7", ["COM1"]),
      handshake: FAST_HS,
      log: () => {},
    });
    m2.updateSerialPath("COM7");
    await assert.rejects(() => m2.switchTo("uart"), /COM7 打开失败/);
    assert.equal(m2.kind, "udp", "切换失败后当前通道必须保持不动");
    assert.equal(m2.decision.active, "udp");
    m2.close();
    // ② 正常切换（串口已就绪）：主通道变 uart
    const before = rec.sources.length;
    const d = await m.switchTo("uart");
    assert.equal(d.active, "uart");
    assert.equal(m.kind, "uart");
    assert.equal(rec.sources.length, before + 1, "换源必须通知 hub（switchSource）");
    assert.equal(m.decision.degraded, true);
    assert.equal(m.statusView().decision.active, "uart");
  } finally {
    m.close();
  }
});

test("运行期降级：UDP 报停滞（udp-stall）⇒ auto 自动换到已探过的串口", async () => {
  const udp = new FakeUdp(profile, true);
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "auto",
    udpProbeMs: 10,
    udpFactory: () => { built++; return udp; },
    serialFactory: portFactory((() => {
      const p = new FakeSerialPort();
      p.responder = (frame) => {
        const d = FakeSerialPort.parseDownlink(frame);
        if (d?.opcode === DOWNLINK.OPCODE.GET_STATUS) p.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
      };
      return p;
    })()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(m.kind, "udp");
    assert.equal(m.decision.secondary, "uart");
    udp.stall();
    await new Promise((r) => setTimeout(r, 40)); // 等降级流程（建串口通道）走完
    assert.equal(m.kind, "uart", "auto 下主通道失效应自动降级");
    assert.equal(m.decision.degraded, true);
    assert.match(m.decision.reason, /降级/);
  } finally {
    m.close();
  }
});
