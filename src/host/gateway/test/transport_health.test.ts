// 串口/网口通道健壮性（B 线四修）的网关侧测试：
//   ① 通道健康看门狗：当前通道 ≥3 s 无字节/包 ⇒ statusView.decision.state=degraded +
//      health.reason="通道 X 已 N s 无数据"；一包/一字节回来 ⇒ 立刻恢复 active（现场判据 B4）；
//   ② UDP 绑定 EADDRINUSE ⇒ 精确原因上屏 + 200 ms 后自动重试 1 次；仍失败 ⇒ 抛可执行文案（B5）；
//   ③ serial.statusView() 必须带 rxBytes/rxBps/lastRxAgeMs（B3：现场 UART_LINK_EN=0 位流 rx=0 B/s）。
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { SerialTransport } from "../src/transport/serial.ts";
import { FakeSerialPort } from "./serial_fakes.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

interface FakeUdpOpts {
  /** 绑定时抛 udp-socket 致命错误（模拟 EADDRINUSE） */
  readonly bindFail?: string;
  /** onStart 时"收到过包"（模拟板端在发流） */
  readonly deliver?: boolean;
}

/** 假 UDP 源：只实现 UdpLike 的结构契约，协议字节不经过它（本测试不关心业务流） */
class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  private readonly fopts: FakeUdpOpts;

  constructor(profile0: Profile, fopts: FakeUdpOpts = {}) {
    super({ profile: profile0 });
    this.fopts = fopts;
  }

  protected override onStart(): void {
    if (this.fopts.bindFail !== undefined) {
      this.emitError({ code: "udp-socket", message: this.fopts.bindFail, fatal: true });
      return;
    }
    if (this.fopts.deliver !== false) this.rxPackets = 1;
  }

  setTsOffsetUs(_offsetUs: number | null): void {
    /* 测试不关心 */
  }
}

function udpManager(opts: {
  deliver?: boolean;
  bindFailFirst?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}): { manager: Promise<LiveTransportManager>; builds: () => number; last: () => FakeUdp | null } {
  let builds = 0;
  let lastFake: FakeUdp | null = null;
  const manager = LiveTransportManager.create({
    profile,
    mode: "udp",
    bind: "192.168.1.102",
    port: 1236,
    udpFactory: (_o: UdpOptions) => {
      builds++;
      const fail = opts.bindFailFirst === true && builds === 1;
      lastFake = new FakeUdp(profile, fail
        ? { bindFail: "listen EADDRINUSE: address already in use 192.168.1.102:1236" }
        : { deliver: opts.deliver ?? true });
      return lastFake;
    },
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    log: opts.log ?? (() => {}),
    onSourceChange: () => {},
  });
  return { manager, builds: () => builds, last: () => lastFake };
}

test("看门狗：3 s 无包 ⇒ degraded + 原因上屏；包回来 ⇒ 恢复 active", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { manager, last } = udpManager({ deliver: true });
    const m = await manager;
    try {
      const v0 = m.statusView();
      assert.equal(v0.health, null, "刚切好通道时不该立刻判无数据");
      assert.equal(v0.decision.state, "active");

      mock.timers.tick(3100);
      const v1 = m.statusView();
      assert.equal(v1.health?.state, "degraded");
      assert.equal(v1.health?.channel, "udp");
      assert.match(v1.health?.reason ?? "", /通道 网口\(UDP\) 已 3\.1 s 无数据/);
      assert.equal(v1.decision.state, "degraded", "degraded 必须叠加到选择结论上（前端读 decision.state）");
      assert.match(v1.decision.reason, /无数据/, "原有 reason 不能丢，只能追加");

      // 下一包到达 ⇒ 活性刷新，下一次采样就是 active
      last()!.rxPackets++;
      const v2 = m.statusView();
      assert.equal(v2.health, null);
      assert.equal(v2.decision.state, "active");
      assert.doesNotMatch(v2.decision.reason, /无数据/);
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});

test("EADDRINUSE：第一次绑定失败 ⇒ 记日志 + 200 ms 后自动重建一次并成功", async () => {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const { manager, builds } = udpManager({
    bindFailFirst: true,
    sleep: async (ms) => { sleeps.push(ms); },
    log: (msg) => { logs.push(msg); },
  });
  const m = await manager;
  try {
    assert.equal(builds(), 2, "必须真的重建一次（不是假装成功）");
    assert.deepEqual(sleeps, [200], "重试间隔 200 ms（B5 判据）");
    assert.ok(logs.some((l) => /EADDRINUSE.*自动重试一次/.test(l)), "日志里要有 EADDRINUSE 与重试说明：" + JSON.stringify(logs));
    assert.equal(m.statusView().decision.active, "udp");
  } finally {
    m.close();
  }
});

test("EADDRINUSE：两次都失败 ⇒ 抛精确原因（端口仍被占用 + 已自动重试 1 次）", async () => {
  let builds = 0;
  const sleeps: number[] = [];
  const manager = LiveTransportManager.create({
    profile,
    mode: "udp",
    bind: "192.168.1.102",
    port: 1236,
    udpFactory: () => {
      builds++;
      return new FakeUdp(profile, { bindFail: "listen EADDRINUSE: address already in use 192.168.1.102:1236" });
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  });
  const err = await manager.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error, "必须抛错，而不是静默拿到一条收 0 包的通道");
  assert.match(err.message, /EADDRINUSE/);
  // R1（六修）：文案扩展为 EADDRINUSE/EACCES（Windows 端口冲突实际报 EACCES）
  assert.match(err.message, /端口仍被占用（EADDRINUSE\/EACCES，已自动重试 1 次）/);
  assert.equal(builds, 2);
  assert.deepEqual(sleeps, [200]);
});

test("serial.statusView：rxBytes/rxBps/lastRxAgeMs 实测（0 字节时也必须可见）", async () => {
  const port = new FakeSerialPort();
  const t = await SerialTransport.open({ profile, path: "COM6", port, handshake: { enabled: false } });
  try {
    const v0 = t.statusView();
    assert.equal(v0["rxBytes"], 0, "现场判据：UART_LINK_EN=0 位流打开成功但 rx 恒 0");
    assert.equal(v0["rxBps"], 0);
    assert.equal(v0["lastRxAgeMs"], null, "从未收到 ⇒ null（不是 0：0 会被误读成'刚刚收到'）");
    assert.equal(v0["lastRxAtMs"], null);

    port.feed(new Uint8Array([0xaa, 0x55, 0x54, 0x4d, 0x00, 0x01, 0x02, 0x03]));
    const v1 = t.statusView();
    assert.equal(v1["rxBytes"], 8);
    assert.equal(v1["rxBps"], 8, "1 s 窗口内 8 B ⇒ 8 B/s");
    assert.equal(typeof v1["lastRxAgeMs"], "number");
    assert.ok((v1["lastRxAgeMs"] as number) >= 0);
  } finally {
    t.closePort();
  }
});

// A4（六修 R1）：Windows 端口被占返回的是 EACCES（errno -4091），不是 EADDRINUSE。
// 旧实现只匹配 /EADDRINUSE/i，200 ms 自动重试在 Windows 上从未触发（director 实测 rpcMs=28 直接失败）。
test("A4 EACCES（Windows 端口冲突）：同样触发一次且只一次 200 ms 自动重试", async () => {
  const logs: string[] = [];
  const sleeps: number[] = [];
  let builds = 0;
  const manager = LiveTransportManager.create({
    profile,
    mode: "udp",
    bind: "192.168.1.102",
    port: 1236,
    udpFactory: () => {
      builds++;
      return new FakeUdp(profile, builds === 1
        ? { bindFail: "bind EACCES 192.168.1.102:1236" }
        : { deliver: true });
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (msg) => { logs.push(msg); },
    onSourceChange: () => {},
  });
  const m = await manager;
  try {
    assert.equal(builds, 2, "EACCES 必须也触发自动重建一次");
    assert.deepEqual(sleeps, [200], "重试间隔 200 ms，且只重试一次");
    assert.ok(logs.some((l) => /EACCES/.test(l) && /自动重试一次/.test(l)), "日志必须写明 EACCES 与重试：" + JSON.stringify(logs));
    assert.equal(m.statusView().decision.active, "udp");
  } finally {
    m.close();
  }
});
