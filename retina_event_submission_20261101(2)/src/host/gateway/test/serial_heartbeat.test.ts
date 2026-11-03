// 九修 N1-N4：串口链路心跳（GET_STATUS 每 1000 ms）——安静场景不误回退 / 真损坏仍回退 /
// 不打断用户命令 / 切走后无残留 timer。
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { DOWNLINK, buildUartTelemFrame, getProfile } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { SerialTransport } from "../src/transport/serial.ts";
import { FakeSerialPort, ctrlAck, portFactory } from "./serial_fakes.ts";
import { buildV3 } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  readonly detail = "fake-udp";
  constructor() {
    super({ profile });
  }
  protected override onStart(): void {
    this.rxPackets = 1;
  }
  setTsOffsetUs(_offsetUs: number | null): void {
    /* 测试不关心 */
  }
}

interface HeartbeatView {
  enabled: boolean;
  intervalMs: number;
  sent: number;
  skippedInFlight: number;
  skippedRecentDownlink: number;
  lastAtMs: number | null;
  /** 十修：由 live.ts 合并 V3Link 心跳统计（SerialTransport 自己看不到 ACK） */
  ack?: number;
  fail?: number;
  lastAckAtMs?: number | null;
  lastRttMs?: number | null;
}

function heartbeatOf(t: SerialTransport): HeartbeatView {
  const v = t.statusView() as { heartbeat: HeartbeatView };
  return v.heartbeat;
}

function telemetry(frameCnt: number): Uint8Array {
  return buildUartTelemFrame({ frameCnt, evPerFrame: 2288, activityQ16: 32768, crX10: 265 });
}

function makeManager(port: FakeSerialPort, extra: {
  serialHeartbeatMs?: number;
  udpBuilds?: { n: number };
  logs?: string[];
} = {}): Promise<LiveTransportManager> {
  return LiveTransportManager.create({
    profile,
    mode: "uart",
    serialFactory: portFactory(port),
    handshake: { enabled: false },
    ...(extra.serialHeartbeatMs === undefined ? {} : { serialHeartbeatMs: extra.serialHeartbeatMs }),
    udpFactory: (_o: UdpOptions) => {
      if (extra.udpBuilds !== undefined) extra.udpBuilds.n++;
      return new FakeUdp();
    },
    log: (msg) => extra.logs?.push(msg),
  });
}

test("N1 安静场景：遥测照常流但只有心跳 ACK，12 s 内不回退且 noV3ForMs 保持低位", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  mock.timers.tick(1_000_000);
  try {
    const port = new FakeSerialPort();
    port.responder = (frame) => {
      const d = FakeSerialPort.parseDownlink(frame);
      if (d !== null && d.opcode === DOWNLINK.OPCODE.GET_STATUS && d.crcOk) {
        port.feed(ctrlAck(profile, DOWNLINK.OPCODE.GET_STATUS, d.seq));
      }
    };
    const udpBuilds = { n: 0 };
    const m = await makeManager(port, { udpBuilds });
    try {
      let maxNoV3 = 0;
      for (let i = 0; i < 48; i++) {
        mock.timers.tick(250);
        port.feed(telemetry(i));
        const u = m.statusView().uart as { noV3ForMs: number } | null;
        assert.ok(u !== null);
        maxNoV3 = Math.max(maxNoV3, u.noV3ForMs);
      }
      const view = m.statusView();
      const uart = view.uart as { heartbeat: HeartbeatView; noV3ForMs: number } | null;
      assert.ok(uart !== null, "串口主通道必须仍在");
      assert.ok(uart.heartbeat.sent >= 8, "12 s 内至少要发 8 次心跳（实际 " + String(uart.heartbeat.sent) + "）");
      // 十修：心跳 ACK 统计由 live.ts 合并进来，传输卡要能显示 RTT/最近成功年龄
      assert.ok((uart.heartbeat.ack ?? 0) >= 8, "心跳 ACK 计数必须随成功应答增长（实际 " + String(uart.heartbeat.ack) + "）");
      assert.ok(typeof uart.heartbeat.lastAckAtMs === "number", "最近成功心跳时刻必须是数字");
      assert.ok(typeof uart.heartbeat.lastRttMs === "number" && uart.heartbeat.lastRttMs >= 0, "心跳 RTT 必须可显示");
      assert.ok(maxNoV3 < 3000, "整个 12 s 窗口内 noV3ForMs 都必须 <3000（实际峰值 " + String(maxNoV3) + "）");
      assert.ok(uart.noV3ForMs < 3000, "心跳 ACK 必须刷新有效帧年龄（实际 noV3ForMs=" + String(uart.noV3ForMs) + "）");
      assert.equal(view.autoFallback.count, 0, "安静场景不得误判为坏链");
      assert.equal(m.kind, "uart");
      assert.equal(udpBuilds.n, 0);
      assert.equal(heartbeatOf(m.source as SerialTransport).skippedRecentDownlink, 0);
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});

test("N2 真损坏：字节在涨但心跳无 ACK ⇒ 5 s 后自动回退一次，文案不变", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  mock.timers.tick(1_000_000);
  try {
    const port = new FakeSerialPort(); // 不装 responder：GET_STATUS 收不到 ACK
    const udpBuilds = { n: 0 };
    const logs: string[] = [];
    const m = await makeManager(port, { udpBuilds, logs });
    try {
      for (let i = 0; i < 20; i++) {
        mock.timers.tick(250);
        port.feed(telemetry(i)); // rxBps 一直 > 0
        port.feed(buildV3({ frameIdx: i, tsUs: 1_000_000 + i, breakCrc: true })); // 全是坏帧
      }
      const trig = m.statusView();
      const trigUart = trig.uart as { heartbeat: HeartbeatView; noV3ForMs: number } | null;
      assert.ok(trigUart !== null);
      assert.ok(trigUart.heartbeat.sent >= 1, "损坏链路上的心跳也必须真的发出过");
      assert.ok(trigUart.noV3ForMs >= 5000, "没有任何有效 v3 帧 ⇒ noV3ForMs 必须达到 5 s");
      assert.equal(trig.autoFallback.count, 1, "条件满足后必须发起回退");
      assert.equal(trig.autoFallback.inFlight, true);

      await new Promise((r) => setTimeout(r, 80)); // 等 switchTo 的异步建链完成（真实 timer）
      const after = m.statusView();
      assert.equal(m.kind, "udp");
      assert.equal(after.decision.active, "udp");
      assert.equal(udpBuilds.n, 1, "只建一条新网口通道");
      assert.equal(after.autoFallback.count, 1);
      assert.match(after.autoFallback.notice, /串口链路无有效帧，已自动切回网口/);
      assert.match(after.decision.reason, /串口链路无有效帧，已自动切回网口/);
      assert.ok(logs.some((l) => /自动回退完成/.test(l)), "日志必须留下自动回退记录：" + JSON.stringify(logs));

      // 再过一个冷却周期也只切一次（与 S8 的"每次串口会话只自动一次"一致）
      mock.timers.tick(10_000);
      assert.equal(m.statusView().autoFallback.count, 1);
      assert.equal(udpBuilds.n, 1);
      assert.equal(m.kind, "udp");
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});

test("N3 心跳不打断用户命令：userInFlight>0 时跳过，ACK 后恢复", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  mock.timers.tick(1_000_000);
  try {
    const port = new FakeSerialPort();
    const m = await makeManager(port);
    try {
      const pending = m.v3link.setParam({ evRes: 1 });
      assert.equal(m.v3link.inFlight, 1);
      assert.equal(m.v3link.userInFlight, 1);

      mock.timers.tick(1000); // 心跳到点，但用户命令 pending
      const skipped = heartbeatOf(m.source as SerialTransport);
      assert.equal(skipped.sent, 0, "用户命令在飞时不得插心跳");
      assert.ok(skipped.skippedInFlight >= 1, "必须记录一次心跳让位");

      const down = port.downlinks.find((f) => FakeSerialPort.parseDownlink(f)?.opcode === DOWNLINK.OPCODE.SET_PARAM);
      assert.ok(down !== undefined, "用户 SET_PARAM 必须已经发出");
      const d = FakeSerialPort.parseDownlink(down);
      assert.ok(d !== null);
      port.feed(ctrlAck(profile, DOWNLINK.OPCODE.SET_PARAM, d.seq));
      const r = await pending;
      assert.equal(r.ok, true, "用户命令 ACK 必须正常匹配");
      assert.equal(m.v3link.userInFlight, 0);

      mock.timers.tick(1000); // 命令结束后下一个心跳周期恢复
      assert.ok(heartbeatOf(m.source as SerialTransport).sent >= 1, "命令结束后心跳必须恢复发送");
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});

test("N4 切到 UDP 后心跳停止：计数冻结且无残留 timer", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  mock.timers.tick(1_000_000);
  try {
    const port = new FakeSerialPort();
    port.responder = (frame) => {
      const d = FakeSerialPort.parseDownlink(frame);
      if (d !== null && d.opcode === DOWNLINK.OPCODE.GET_STATUS && d.crcOk) {
        port.feed(ctrlAck(profile, DOWNLINK.OPCODE.GET_STATUS, d.seq));
      }
    };
    const m = await makeManager(port);
    try {
      mock.timers.tick(1000);
      const serial = m.source as SerialTransport;
      const before = heartbeatOf(serial).sent;
      assert.ok(before >= 1, "切走前必须已经发过心跳");

      await m.switchTo("udp");
      assert.equal(serial.running, false);
      assert.equal(serial.open, false, "切走后旧串口必须关闭");
      assert.equal(heartbeatOf(serial).enabled, false, "定时器必须已清");

      mock.timers.tick(2500);
      assert.equal(heartbeatOf(serial).sent, before, "切到 UDP 后心跳计数必须冻结（否则说明 timer 泄漏）");
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});
