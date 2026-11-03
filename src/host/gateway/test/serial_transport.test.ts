// 串口 transport 测试（UART 路线 WIRE-U1 §3.7 / §8.2 H1）。
//
// 判据覆盖：
//   ① COM6 **打开失败**必须给明确报错（串口号 + 原因 + 当前可用串口），且不静默吞掉；
//   ② 握手：3 次 × 单次 300 ms（默认）全超时 ⇒ 明确"未检测到 UART v3 固件"，但**照常收遥测帧降级显示**；
//      有 ACK 时如实记录尝试次数/RTT，且发出的下行字节逐字节合规（独立解 CRC16）；
//   ③ **命令/校准 over 串口**：同一份 V3Link 换传输层即可用（板端 REQ → PC 立即应答 TIME_SYNC）；
//   ④ 上行事件帧经定帧 → 处理器 → 装配（串口数据面真的通）；
//   ⑤ USB 被拔（close 事件）必须明确报一次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CTRL, DOWNLINK, MAGIC_V3_DOWN, buildUartTelemFrame, getProfile, parseV3Packet } from "@retina/protocol";
import type { EventBatch, Profile, SourceError, UartTelemFrame } from "@retina/protocol";
import { SerialTransport, SerialOpenError, nodeSerialFactory } from "../src/transport/serial.ts";
import { V3Link } from "../src/pipeline/v3link.ts";
import { FakeSerialPort, ctrlAck, failingFactory, portFactory, timeSyncReq } from "./serial_fakes.ts";
import { buildV3, concatU8, evByteAligned } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

/** 板端串口事件帧（与 UDP 逐字节同构） */
function uartEventFrame(frameIdx: number, n: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) parts.push(evByteAligned((i * 5) % 400, (i * 7) % 240, (i % 2) as 0 | 1, 0));
  return buildV3({ events: concatU8(...parts), mode: 2, frameIdx, first: true, last: true, tsUs: 1000 + frameIdx });
}

const FAST_HS = { attempts: 3, ackTimeoutMs: 20, gapMs: 1 } as const;

test("打开失败：抛 SerialOpenError，报错含串口号 / 原因 / 当前可用串口（用户能照着排查）", async () => {
  await assert.rejects(
    () => SerialTransport.open({ profile, path: "COM6", factory: failingFactory(), handshake: { enabled: false } }),
    (err: unknown) => {
      assert.ok(err instanceof SerialOpenError, "必须是明确的打开失败类型");
      assert.match(err.message, /COM6 打开失败/);
      assert.match(err.message, /File not found/);
      assert.match(err.message, /当前可用串口：COM1, COM4/);
      assert.match(err.message, /CH341SER/);
      return true;
    },
  );
});

test("真串口工厂（serialport@13）：打开不存在的串口走同一条明确报错路径", async () => {
  // 为什么用 COM199 而不是 COM6：本机 COM6 实际存在（`SerialPort.list()` 列出
  // "USB-SERIAL CH340 (COM6)"，就是板子的 CH340）。**测试绝不去开真板口** ——
  // 板子正被停流排障任务使用，且"COM6 实测"按任务分工另派（见交付报告"串口联板待办清单"）。
  // COM199 是 Windows 上不存在的口：这条用例跑的是**真** serialport 原生模块的失败分支，
  // 无板环境也能证明"打开失败 → 明确报错"的形态。
  await assert.rejects(
    () => nodeSerialFactory.open({ path: "COM199", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", rtscts: false }),
    (err: unknown) => {
      assert.ok(err instanceof SerialOpenError, "必须是 SerialOpenError（不是裸 Error）");
      assert.match(err.message, /COM199 打开失败/);
      assert.match(err.message, /当前可用串口：/);
      return true;
    },
  );
});

test("握手成功：发出 GET_STATUS（逐字节合规）→ 板端 ACK → 记录尝试次数与 RTT", async () => {
  const port = new FakeSerialPort();
  port.responder = (frame) => {
    const d = FakeSerialPort.parseDownlink(frame);
    if (d?.opcode === DOWNLINK.OPCODE.GET_STATUS) port.feed(ctrlAck(profile, CTRL.OPCODE.SET_PARAM + 3, d.seq));
  };
  const t = await SerialTransport.open({ profile, path: "COM6", port, handshake: FAST_HS });
  assert.equal(t.handshake.ok, true);
  assert.equal(t.handshake.attempts, 1, "第一次就应答");
  assert.equal(typeof t.handshake.rttMs, "number");
  assert.match(t.handshake.detail, /UART v3 固件在线/);
  // 独立解下行：OPCODE=0x04 / LEN=0 / CRC16 自洽
  assert.equal(port.downlinks.length, 1);
  const d = FakeSerialPort.parseDownlink(port.downlinks[0] as Uint8Array);
  assert.equal(d?.opcode, DOWNLINK.OPCODE.GET_STATUS);
  assert.equal(d?.payload.length, 0);
  assert.equal(d?.crcOk, true, "下行帧 CRC16 必须自洽（板端会拒收坏 CRC）");
  assert.deepEqual([...(port.downlinks[0] as Uint8Array).subarray(0, 4)], [...MAGIC_V3_DOWN]);
});

test("握手失败：3 次全超时 ⇒ 明确提示未检测到 v3 固件；遥测帧照常解析（降级显示）", async () => {
  const port = new FakeSerialPort(); // 不装 responder：板端不应答
  const telem: UartTelemetryHit[] = [];
  const t = await SerialTransport.open({
    profile,
    path: "COM6",
    port,
    handshake: FAST_HS,
    onTelemetry: (x, _raw, atMs) => telem.push({ x, atMs }),
  });
  assert.equal(t.handshake.ok, false);
  assert.equal(t.handshake.attempts, 3, "必须按设计重试 3 次");
  assert.match(t.handshake.detail, /未检测到 UART v3 固件/);
  assert.match(t.handshake.detail, /UART_LINK_EN=1/);
  assert.equal(port.downlinks.length, 3, "3 次 GET_STATUS 都真的发出去了");
  // 降级显示：遥测帧（帧型 A）仍然解析上屏
  port.feed(buildUartTelemFrame({ frameCnt: 99, evPerFrame: 2288, activityQ16: 32768, crX10: 265 }));
  assert.equal(telem.length, 1);
  assert.equal(telem[0]?.x.evPerFrame, 2288);
  assert.equal(t.telemetry?.telem.cr, 26.5);
});

test("命令 over 串口：同一份 V3Link 换 sink 即可下发（SET_PARAM tag 0x07..0x0A 逐字节）", async () => {
  const port = new FakeSerialPort();
  const t = await SerialTransport.open({ profile, path: "COM6", port, handshake: { enabled: false } });
  const link = new V3Link({ send: (b) => t.send(b), nowUs: () => 1_000_000 });
  link.noteDataMode(2); // 见到 v3 流量（v2 固件期间不下发）
  const p = link.setParam({ evRes: 1, serDecim: 32, serAgg: 0, serEvFlushMs: 20 });
  const d = FakeSerialPort.parseDownlink(port.downlinks[0] as Uint8Array);
  assert.equal(d?.opcode, DOWNLINK.OPCODE.SET_PARAM);
  assert.equal(d?.crcOk, true);
  assert.deepEqual([...(d?.payload ?? [])], [
    DOWNLINK.TAG.EV_RES, 1, 1,
    DOWNLINK.TAG.SER_DECIM, 1, 32,
    DOWNLINK.TAG.SER_AGG, 1, 0,
    DOWNLINK.TAG.SER_EV_FLUSH_MS, 2, 0, 20,
  ], "串口与 UDP 共用同一字节格式（设计 §3.7）");
  assert.equal(link.statusView().wireVer, 3);
  // 清掉未应答的命令定时器，避免测试被吊住
  await new Promise((r) => setTimeout(r, 5));
  void p.catch(() => {});
});

test("校准 over 串口：板端 TIME_SYNC_REQ(0x83) → PC 立即回 TIME_SYNC（SEQ 回声），零协议分叉", async () => {
  const port = new FakeSerialPort();
  let link: V3Link | null = null;
  const t = await SerialTransport.open({
    profile,
    path: "COM6",
    port,
    handshake: { enabled: false },
    // 与 main.ts 的接线同形：处理器分派出来的 CTRL 包 → V3Link
    onCtrl: (pkt) => link?.onCtrlPacket(pkt),
  });
  const sent: Uint8Array[] = [];
  link = new V3Link({ send: (b) => { sent.push(b); t.send(b); }, nowUs: () => 42_000_000 });
  const req = timeSyncReq(77, 1_234_567);
  assert.equal(parseV3Packet(req, { profile }).ok, true);
  port.feed(req);
  assert.equal(sent.length, 1, "收到 REQ 必须立即应答（设计 §5.1 第 2 步）");
  const d = FakeSerialPort.parseDownlink(sent[0] as Uint8Array);
  assert.equal(d?.opcode, DOWNLINK.OPCODE.TIME_SYNC);
  assert.equal(d?.seq, 77, "SEQ 必须回声请求值");
  assert.equal(d?.payload.length, 9, "TIME_SYNC 载荷 = HOST_TS_US(6)+RTT_HALF(2)+FLAG(1)");
  assert.equal(d?.crcOk, true);
  assert.notEqual(link.statusView().calAgeMs, null, "应答 REQ 就刷新了校准点（calAgeMs 非 null）");
  assert.equal(port.downlinks.length, 1, "应答确实经串口发出（命令/校准 over 串口）");
});

test("上行事件帧：定帧 → 处理器 → 装配（串口数据面真的通，且 CTRL 进状态通道）", async () => {
  const port = new FakeSerialPort();
  const batches: EventBatch[] = [];
  const ctrls: number[] = [];
  const t = await SerialTransport.open({
    profile,
    path: "COM6",
    port,
    handshake: { enabled: false },
    onCtrl: (pkt) => ctrls.push(pkt.ctrlHeader?.opcode ?? -1),
  });
  t.on("events", (b) => batches.push(b));
  t.start();
  // 纯事件流（v3 MODE2）靠"换帧号 / 超时"结算：第 42 帧一到，第 41 帧的批次就被交出来
  port.feed(concatU8(uartEventFrame(41, 6), uartEventFrame(42, 4)));
  assert.equal(batches.length, 1, "同构装配：帧 41 的事件批已交付");
  assert.equal(batches[0]?.records.length, 6);
  assert.equal(t.deframerStats.v3Frames, 2);
  assert.equal(t.deframerStats.resyncs, 0);
  // CTRL 帧（心跳/ACK）走状态通道，不进数据装配
  port.feed(ctrlAck(profile, CTRL.OPCODE.GET_STATUS, 5));
  assert.deepEqual(ctrls, [CTRL.OPCODE.GET_STATUS]);
  t.stop(); // finish()：把帧 42 的批次结算出来（不交付半帧）
  assert.equal(batches.length, 2);
  assert.equal(batches[1]?.records.length, 4);
});

test("USB 被拔（close 事件）：明确报一次，不静默停流", async () => {
  const port = new FakeSerialPort();
  const errors: SourceError[] = [];
  const t = await SerialTransport.open({ profile, path: "COM6", port, handshake: { enabled: false } });
  t.on("error", (e) => errors.push(e));
  t.start();
  port.unplug();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "uart-closed");
  assert.match(errors[0]?.message ?? "", /COM6 已关闭/);
  assert.equal(t.open, false);
  t.stop();
});

interface UartTelemetryHit {
  readonly x: UartTelemFrame;
  readonly atMs: number;
}
