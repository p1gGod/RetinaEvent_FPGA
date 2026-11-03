// 七修 S3/S7/S8/S9 串口链路修复的网关侧回归：
//   S3 串口→UDP 回切：切换前残留的 EV_ONLY 批必须恰好结算一次（不重复不丢）。
//   S7 故障可视化：statusView 必须带 lastV3FrameAgeMs / noV3ForMs / crcFailTotal / v3CrcFailRate / recent10s。
//   S8 自动回退：串口仍有字节但连续 5 s 无有效 v3 帧 ⇒ 自动切回网口，只切一次、冷却 10 s、有下行命令在飞时不打断。
//   S9 日志限流：1000 条坏帧只产生 1 条「最近 1 s N 帧失败」汇总，不许日志洪水。
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { encodeEvents, getProfile } from "@retina/protocol";
import type { EventBatch, EventRecord, Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import type { UdpOptions } from "../src/transport/udp.ts";
import { LiveTransportManager } from "../src/transport/live.ts";
import type { UdpLike } from "../src/transport/live.ts";
import { SerialTransport } from "../src/transport/serial.ts";
import { FakeSerialPort, portFactory } from "./serial_fakes.ts";
import { buildV3, concatU8, evByteAligned } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;
const REC = profile.evRecBytes;

function recs(tag: number, n: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) list.push({ x: tag * 10 + i, y: tag, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}

/** 串口实测事件帧：MODE=0、RAW_LEN=0（不是 UDP 侧常见的 MODE=2） */
function uartNoRawEventFrame(frameIdx: number, n: number, tsUs = 1000 + frameIdx): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) parts.push(evByteAligned((i * 5) % 400, (i * 7) % 240, (i % 2) as 0 | 1, 0));
  return buildV3({ events: concatU8(...parts), mode: 0, frameIdx, first: true, last: true, tsUs });
}

class FakeUdp extends BaseFrameSource implements UdpLike {
  rxPackets = 0;
  readonly detail = "fake-udp";
  constructor(profile0: Profile) {
    super({ profile: profile0 });
  }
  protected override onStart(): void {
    this.rxPackets = 1;
  }
  setTsOffsetUs(_offsetUs: number | null): void {
    /* 测试不关心 */
  }
}

test("S3 串口→UDP：残留 EV_ONLY 批在切换时恰好结算一次（不重复不丢）", async () => {
  const port = new FakeSerialPort();
  let udpBuilds = 0;
  const m = await LiveTransportManager.create({
    profile,
    mode: "uart",
    serialFactory: portFactory(port),
    handshake: { enabled: false },
    udpFactory: (_o: UdpOptions) => {
      udpBuilds++;
      return new FakeUdp(profile);
    },
    log: () => {},
  });
  try {
    assert.equal(m.kind, "uart");
    const serial = m.source as SerialTransport;
    assert.equal(serial.rawCapable, false, "串口源必须声明无原始段");

    const batches: EventBatch[] = [];
    const detailed: { frameIdx: number; evOnly: boolean | undefined; count: number }[] = [];
    serial.onEventsDetailed((b, frameIdx, _seq, _t, evOnly) => {
      batches.push(b);
      detailed.push({ frameIdx, evOnly, count: b.records.length });
    });

    // 只喂一帧、不等 40 ms 时间窗：这一批在切换瞬间一定还 pending 在装配器里。
    port.feed(uartNoRawEventFrame(7, 4));
    assert.equal(batches.length, 0, "时间窗未到，批次应还在 pending（这正是修复前会被静默丢掉的那批）");
    const evDropBefore = serial.counters.evDrop;

    await m.switchTo("udp");
    await new Promise((r) => setTimeout(r, 60)); // 给旧源 finish / 任何迟到结算留出时间

    assert.equal(m.kind, "udp");
    assert.equal(udpBuilds, 1);
    assert.equal(batches.length, 1, "残留批必须恰好交付一次（重复=重复上屏；0=丢最后一批）");
    assert.equal(detailed[0]?.count, 4);
    assert.equal(detailed[0]?.evOnly, true, "串口残留批必须按 EV_ONLY 语义结算（前端立即上屏）");
    assert.equal(serial.counters.evDrop, evDropBefore, "切换不得增加 evDrop");
    assert.equal(serial.running, false);
    assert.equal(serial.open, false, "切走后旧串口必须关闭（不长期占 COM6）");
  } finally {
    m.close();
  }
});

test("S7/S9 串口坏帧：statusView 暴露年龄/失败率，1000 条坏帧只产生 1 条汇总日志", async () => {
  const port = new FakeSerialPort();
  const t = await SerialTransport.open({ profile, path: "COM6", port, handshake: { enabled: false } });
  const errors: { code: string; message: string }[] = [];
  t.on("error", (e) => errors.push(e));
  try {
    // 1000 条 CRC 全坏的 v3 帧（每帧都完整到达，只是校验失败）
    for (let i = 0; i < 1000; i++) port.feed(buildV3({ frameIdx: i, tsUs: 1_000_000 + i, breakCrc: true }));
    await new Promise((r) => setTimeout(r, 1_100)); // 等 1 s 汇总窗口 flush

    const crcLogs = errors.filter((e) => e.code === "uart-crc");
    assert.equal(crcLogs.length, 1, "每通道每秒最多 1 条汇总（实际 " + crcLogs.length + "）");
    assert.match(crcLogs[0]?.message ?? "", /最近 1 s 1000 帧定帧\/CRC 失败，累计 1000/);
    assert.match(crcLogs[0]?.message ?? "", /首个错误：/);

    const v = t.statusView();
    assert.equal(v["lastV3FrameAtMs"], null, "从未有过有效帧");
    assert.equal(v["lastV3FrameAgeMs"], null, "从未有过有效帧 ⇒ null（不是 0）");
    assert.ok((v["noV3ForMs"] as number) >= 1_000, "noV3ForMs 必须从打开时刻起算");
    assert.equal(v["crcFailTotal"], 1000);
    assert.equal(v["v3CrcFailRate"], 1, "全是 CRC 失败 ⇒ 失败率 1");
    const recent = v["recent10s"] as { v3Ok: number; v3CrcFail: number; total: number; failRate: number };
    assert.deepEqual(recent, { v3Ok: 0, v3CrcFail: 1000, total: 1000, failRate: 1 });
  } finally {
    t.closePort();
  }
});

test("S8 串口 5 s 无有效帧但字节仍在涨 ⇒ 自动切回网口且只切一次；下行在飞时不打断", async () => {
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.tick(1_000_000);
  try {
    const port = new FakeSerialPort();
    let udpBuilds = 0;
    const logs: string[] = [];
    const m = await LiveTransportManager.create({
      profile,
      mode: "uart",
      serialFactory: portFactory(port),
      handshake: { enabled: false },
      // 九修：该用例验证"心跳关闭时"的 S8 原判据，避免 1 s 心跳 ACK 干扰 5 s 无有效帧的构造
      serialHeartbeatMs: 0,
      udpFactory: (_o: UdpOptions) => {
        udpBuilds++;
        return new FakeUdp(profile);
      },
      log: (msg) => logs.push(msg),
    });
    try {
      assert.equal(m.kind, "uart");

      // 5 s 过去，只来了坏帧（字节在涨、没有一帧有效）
      mock.timers.tick(5_000);
      port.feed(buildV3({ frameIdx: 1, tsUs: 1, breakCrc: true }));

      // 下行命令还在飞（userInFlight>0）⇒ 不许打断（九修后 S8 只认用户命令，心跳 pending 不算）
      Object.defineProperty(m.v3link, "userInFlight", { configurable: true, value: 1 });
      const guard = m.statusView();
      assert.equal(guard.autoFallback.count, 0, "有下行命令在飞时不得自动回退");
      assert.equal(guard.decision.active, "uart");
      assert.equal(udpBuilds, 0);
      Reflect.deleteProperty(m.v3link, "userInFlight");

      const trig = m.statusView();
      assert.equal(trig.autoFallback.count, 1, "条件满足后必须发起回退");
      assert.equal(trig.autoFallback.inFlight, true);

      await new Promise((r) => setTimeout(r, 50)); // 等 switchTo 的异步建链完成（真实 microtask/定时器）
      const after = m.statusView();
      assert.equal(m.kind, "udp", "必须真的切回网口");
      assert.equal(after.decision.active, "udp");
      assert.equal(udpBuilds, 1, "只建一条新网口通道");
      assert.equal(after.autoFallback.count, 1);
      assert.match(after.autoFallback.notice, /串口链路无有效帧，已自动切回网口/);
      assert.match(after.decision.reason, /串口链路无有效帧，已自动切回网口/);
      assert.ok(logs.some((l) => /自动回退完成/.test(l)), "日志必须留下自动回退记录：" + JSON.stringify(logs));

      // 再过一个冷却周期也不许再切（每次串口会话只自动一次）
      mock.timers.tick(10_000);
      const later = m.statusView();
      assert.equal(later.autoFallback.count, 1);
      assert.equal(udpBuilds, 1);
      assert.equal(m.kind, "udp");
    } finally {
      m.close();
    }
  } finally {
    mock.timers.reset();
  }
});
