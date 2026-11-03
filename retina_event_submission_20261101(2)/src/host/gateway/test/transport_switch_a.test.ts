// task-18 A：传输切换修复的网关侧回归。
//
// 现场根因（用户 m01746 第 2 条）：网关 transportMode 是**启动参数**（--udp），
// 运行期切到串口后 decision.mode 仍是 "udp"；前端拿它做 chip 高亮/守卫，
// 于是 active=uart 时点"网口"被"已经是网口档"拦掉，看起来就是"切到串口后切不回去"。
//
// 本文件锁定三件事：
//   A5 statusView 顶层 active 必须反映**实际主通道**（不是启动模式），并带 A4 原始帧恢复进度；
//   A2 force=true 必须真的重建当前通道（同 kind 不能走"已是当前通道"早退）；
//   A3 switchAuto 必须真的探测并切换，"自动"不是当前 active 的空操作。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CTRL, DOWNLINK, getProfile } from "@retina/protocol";
import type { IFrameSource, Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { buildV3 } from "../../packages/protocol/test/helpers.ts";
import { FakeSerialPort, ctrlAck, portFactory } from "./serial_fakes.ts";

const profile = getProfile("retina-v2-800x480-1280") as Profile;
const FAST_HS = { attempts: 1, ackTimeoutMs: 10, gapMs: 1 } as const;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;

/** 假 UDP 源：可标记"探测窗口内能收到包"，并可喂一整帧原始段（走真实装配路径） */
class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  readonly detail = "fake-udp";
  private readonly deliver: boolean;

  constructor(p0: Profile, deliver: boolean) {
    super({ profile: p0 });
    this.deliver = deliver;
  }

  protected override onStart(): void {
    if (this.deliver) this.rxPackets = 1;
  }

  setTsOffsetUs(_offsetUs: number | null): void {
    /* 测试不关心时间校准 */
  }

  feedBytes(buf: Uint8Array, t = Date.now()): void {
    this.feed(buf, t);
  }
}

function fakeSerial(): FakeSerialPort {
  const port = new FakeSerialPort();
  port.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d?.opcode === DOWNLINK.OPCODE.GET_STATUS) port.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, d.seq));
  };
  return port;
}

test("A5/A4：statusView.active 反映实际主通道；收到完整原始帧后 rawFrames/lastRawFrameAtMs 前进", async () => {
  const udp = new FakeUdp(profile, true);
  const sources: IFrameSource[] = [];
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o: UdpOptions) => udp,
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    onSourceChange: (s) => sources.push(s),
    log: () => {},
  });
  try {
    const v0 = m.statusView();
    assert.equal(v0.active, "udp", "A5：顶层 active 必须是实际主通道");
    assert.equal(v0.decision.mode, "udp", "启动模式字段保留（语义不变）");
    assert.equal(v0.rawFrames, 0);
    assert.equal(v0.lastRawFrameAtMs, null);
    assert.equal(typeof v0.rawRecoverMs, "number");
    assert.ok((v0.rawRecoverMs as number) >= 0);

    // 600 个原始段走真实 v3 解析/装配路径（和 UDP 上板数据同一条）
    const raw = new Uint8Array(profile.frame.bytes);
    for (let i = 0; i < raw.length; i += 97) raw[i] = (i * 7 + 3) & 0xff;
    for (let ci = 0; ci < N; ci++) {
      udp.feedBytes(buildV3({
        frameIdx: 77,
        chunkIdx: ci,
        raw: raw.subarray(ci * CHUNK, (ci + 1) * CHUNK),
        mode: 0,
        first: ci === 0,
        last: ci === N - 1,
        tsUs: 1_000_000 + ci,
      }), 5_000 + ci);
    }
    const v1 = m.statusView();
    assert.equal(v1.rawFrames, 1, "A4：完整帧必须计入原始帧恢复进度");
    assert.equal(typeof v1.lastRawFrameAtMs, "number");
    assert.ok((v1.rawRecoverMs as number) < 1000);
  } finally {
    m.close();
  }
});

test("A2：同 kind 直接切 = 早退；force=true 必须真的重建当前通道", async () => {
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(built, 1);
    const d0 = await m.switchTo("udp");
    assert.equal(built, 1, "非 force 同 kind 不能重建（避免误点把所有连接打断）");
    assert.equal(d0.active, "udp");
    assert.match(d0.reason, /已是当前通道/);

    const d1 = await m.switchTo("udp", { force: true });
    assert.equal(built, 2, "A2：force=true 必须 dispose 旧通道并重建");
    assert.equal(d1.active, "udp");
    assert.equal(m.statusView().active, "udp");
  } finally {
    m.close();
  }
});

test("A1/A2 现场复现：--udp 启动 → 切串口 → 点网口(普通切换) → 3 s 内 FRAME_RAW 恢复且 active=udp", async () => {
  let udp: FakeUdp | null = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o: UdpOptions) => {
      udp = new FakeUdp(profile, true);
      return udp;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(m.statusView().active, "udp");
    // 用户第 1 步：切到串口（active 变 uart，但启动模式 mode 仍是 udp —— 现场 bug 的土壤）
    const du = await m.switchTo("uart");
    assert.equal(du.active, "uart");
    assert.equal(m.statusView().active, "uart");
    assert.equal(m.decision.mode, "udp", "启动模式不该被运行期切换改写");

    // 用户第 2 步：点「网口」。A1 的 chip 守卫看到 active=uart，因此允许普通切换
    // （不是按启动模式 udp 判成"已经是网口"而早退；A2 的 force 只用于点当前 active 的 chip）。
    const tSwitch = Date.now();
    const dd = await m.switchTo("udp");
    assert.equal(dd.active, "udp");
    assert.equal(m.decision.active, "udp");
    assert.equal(m.statusView().active, "udp", "A5：切回后主通道必须是 udp（STATS.transport 与 getConfig.active 同源）");
    assert.ok(udp !== null, "点网口必须重新建出 UDP 通道");

    // 板端恢复发流：600 个原始段走真实 v3 装配；切回后 3 s 内必须重新出现 FRAME_RAW
    const raw = new Uint8Array(profile.frame.bytes);
    for (let i = 0; i < raw.length; i += 89) raw[i] = (i * 11 + 5) & 0xff;
    for (let ci = 0; ci < N; ci++) {
      (udp as FakeUdp).feedBytes(buildV3({
        frameIdx: 91,
        chunkIdx: ci,
        raw: raw.subarray(ci * CHUNK, (ci + 1) * CHUNK),
        mode: 0,
        first: ci === 0,
        last: ci === N - 1,
        tsUs: 2_000_000 + ci,
      }), 8_000 + ci);
    }
    const v = m.statusView();
    assert.equal(v.rawFrames, 1, "切回网口后必须恢复 FRAME_RAW");
    assert.equal(typeof v.lastRawFrameAtMs, "number");
    assert.ok((v.rawRecoverMs as number) < 3000, "rawRecoverMs 必须在 3 s 判据内，实际 " + String(v.rawRecoverMs));
    assert.ok(Date.now() - tSwitch < 3000);
  } finally {
    m.close();
  }
});

test("A3：switchAuto 网口在线 ⇒ 真的切到网口；重复 auto 不重建在线网口", async () => {
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "uart",
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(m.kind, "uart");
    assert.equal(m.statusView().active, "uart");

    const d = await m.switchAuto();
    assert.equal(d.active, "udp", "A3：auto 不能是当前 active 的空操作");
    assert.equal(m.kind, "udp");
    assert.equal(built, 1);
    assert.match(d.reason, /自动选择：网口在线/);
    assert.equal(m.statusView().active, "udp");

    const d2 = await m.switchAuto();
    assert.equal(d2.active, "udp");
    assert.equal(built, 1, "已在线的网口不该被重复重建");
  } finally {
    m.close();
  }
});

test("A3：switchAuto 网口不在 + 当前串口可用 ⇒ 保持串口并如实说明两条探测结果", async () => {
  const m = await LiveTransportManager.create({
    profile,
    mode: "uart",
    udpProbeMs: 10,
    udpFactory: (_o: UdpOptions) => new FakeUdp(profile, false),
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    const d = await m.switchAuto();
    assert.equal(d.active, "uart");
    assert.equal(m.kind, "uart");
    assert.match(d.reason, /自动选择：网口不可用/);
    assert.match(d.reason, /串口/);
    assert.equal(m.statusView().active, "uart");
  } finally {
    m.close();
  }
});


test("BLOCK-3 switchAuto：UDP running 但 rxPackets=0 必须释放重探，不能把死网口当在线", async () => {
  let built = 0;
  let first: FakeUdp | null = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      const u = new FakeUdp(profile, true);
      if (first === null) first = u;
      return u;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(built, 1);
    assert.ok(first !== null);
    // 模拟"端口绑着但板端不发流"：running=true、0 包。旧实现只看 running 会直接把它当在线。
    (first as FakeUdp).rxPackets = 0;
    const d = await m.switchAuto();
    assert.equal(built, 2, "0 包旧 socket 必须先释放，再新建 socket 重探（否则 Windows 下收不到包）");
    assert.equal(d.active, "udp");
    assert.equal(m.statusView().active, "udp");
    assert.match(d.reason, /自动选择：网口在线/);
  } finally {
    m.close();
  }
});

test("BLOCK-3 switchAuto：UDP 0 包且串口也打不开 ⇒ 明确 NoTransport，不保留死网口", async () => {
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      return new FakeUdp(profile, false);
    },
    serialFactory: {
      async open(): Promise<never> {
        throw new Error("测试：没有可用串口");
      },
      async list(): Promise<readonly string[]> {
        return [];
      },
    },
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(built, 1);
    await assert.rejects(() => m.switchAuto(), (err: unknown) => {
      assert.match((err as Error).message, /没有可用的数据通道/);
      return true;
    });
    assert.equal(built, 2, "必须真的重探过 UDP，而不是直接返回当前 active");
    const v = m.statusView();
    assert.equal(v.active, null, "旧死通道已释放，不能还挂着 active=udp");
    assert.equal((v.probes["udp"] as { ok: boolean }).ok, false);
  } finally {
    m.close();
  }
});

test("P2-1 UDP force 重建首次失败 ⇒ 自动重绑恢复 primary，不把通道丢成 null", async () => {
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      if (built === 2) throw new Error("测试：首次重绑失败");
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(built, 1);
    const d = await m.switchTo("udp", { force: true });
    assert.equal(built, 3, "首次失败后必须再建一次恢复");
    assert.equal(d.active, "udp");
    assert.equal(m.statusView().active, "udp", "恢复成功后 primary 不能是 null");
    assert.match(d.reason, /已重新建立并恢复/);
  } finally {
    m.close();
  }
});

test("P2-1 UDP force 重建两次都失败 ⇒ 明确不可用状态并抛错，不静默留 null", async () => {
  let built = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      if (built >= 2) throw new Error("测试：端口仍被占用");
      return new FakeUdp(profile, true);
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  try {
    assert.equal(built, 1);
    await assert.rejects(() => m.switchTo("udp", { force: true }), (err: unknown) => {
      assert.match((err as Error).message, /强制重建失败，且恢复也失败/);
      return true;
    });
    assert.equal(built, 3);
    const v = m.statusView();
    assert.equal(v.active, null);
    assert.equal((v.probes["udp"] as { ok: boolean }).ok, false);
    assert.match(String((v.probes["udp"] as { detail: string }).detail), /恢复也失败/);
  } finally {
    m.close();
  }
});

test("BLOCK-3R switchAuto：UDP 收过包后静默 3.3 s ⇒ degraded 必须释放重探，不能复用 stale socket", async () => {
  let built = 0;
  let first: FakeUdp | null = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      const u = new FakeUdp(profile, true);
      if (first === null) first = u;
      return u;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    assert.equal(built, 1);
    assert.ok(first !== null);
    // 现场形态：不是 0 包，而是"收过包之后板端停流"。先人为把计数推到 3，并让 statusView
    // 建立活性基线；3.3 s 不再增长后 health 必须变 degraded。
    (first as FakeUdp).rxPackets = 3;
    m.statusView();
    await sleep(3300);
    const v0 = m.statusView();
    assert.equal(v0.health?.state, "degraded", "静默 3.3 s 后健康判定必须是 degraded");
    assert.equal(built, 1, "此刻还没切，旧 socket 仍挂着");

    const d = await m.switchAuto();
    assert.equal(built, 2, "stale socket 必须先释放，再新建 socket 重探（不能复用）");
    assert.equal(d.active, "udp");
    assert.equal(m.statusView().active, "udp");
    assert.doesNotMatch(d.reason, /已收到 3 包/, "不能把 stale 通道的旧包数当在线证据");
    assert.match(d.reason, /自动选择：网口在线/);
  } finally {
    m.close();
  }
});

test("BLOCK-3R switchAuto：stale UDP 重探也失败 + 串口可用 ⇒ 落到 uart", async () => {
  let built = 0;
  let first: FakeUdp | null = null;
  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    udpProbeMs: 20,
    udpFactory: (_o: UdpOptions) => {
      built += 1;
      // 启动时的 socket 能收包；释放后重探的新 socket 收不到（板端确实停了）。
      const u = new FakeUdp(profile, built === 1);
      if (first === null) first = u;
      return u;
    },
    serialFactory: portFactory(fakeSerial()),
    handshake: FAST_HS,
    log: () => {},
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    assert.ok(first !== null);
    (first as FakeUdp).rxPackets = 3;
    m.statusView();
    await sleep(3300);
    assert.equal(m.statusView().health?.state, "degraded");

    const d = await m.switchAuto();
    assert.equal(built, 2, "stale UDP 仍必须释放并重探");
    assert.equal(d.active, "uart", "UDP 重探失败后必须按 auto 语义落到可用串口");
    assert.equal(m.kind, "uart");
    assert.match(d.reason, /自动选择：网口不可用/);
  } finally {
    m.close();
  }
});

