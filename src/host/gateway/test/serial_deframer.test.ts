// 串口流式定帧测试（UART 路线 WIRE-U1 §3.1 / §8.2 H2）。
//
// 这一层的判据是**定界**：串口是连续字节流，没有 UDP 的包边界，所以必须证明
//   ① 与 UDP **逐字节同构**：同一帧字节走"定帧器 → processor"和直接走 pushRawPayload 结果一致；
//   ② 逐字节滴灌（串口 data 回调的分片边界与帧边界无关）不掉帧、不误判；
//   ③ 三种帧（遥测 / v3 / 下行回显）与 ASCII 行人读行能在同一条流里共存；
//   ④ CRC/长度失败按**字节**重同步并计数，且**后一帧照常解析**（不能一错到底）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile, buildUartTelemFrame, encodeDownlink } from "@retina/protocol";
import type { EventBatch, FramePacket, Profile, UartTelemFrame } from "@retina/protocol";
import { SerialDeframer } from "../src/pipeline/serial_deframer.ts";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { buildV3, evByteAligned, concatU8 } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

/** 事件的 5 B 记录（byte-aligned 变体：实现层按位解析，这里与 helpers 同口径） */
function eventsOf(n: number, base = 0): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) parts.push(evByteAligned((base + i) % 400, (i * 3) % 240, (i % 2) as 0 | 1, 0));
  return concatU8(...parts);
}

/** 串口侧事件帧（WIRE-U1 §3.2：RAW_LEN=0、MODE=2、FIRST/LAST 标记，与 UDP 包头逐字节同构） */
function uartEventFrame(frameIdx: number, n: number, opts: { first?: boolean; last?: boolean } = {}): Uint8Array {
  return buildV3({
    events: eventsOf(n, frameIdx * 7),
    mode: 2,
    frameIdx,
    chunkIdx: 0,
    tsUs: 1_000_000 + frameIdx * 37_600,
    first: opts.first ?? true,
    last: opts.last ?? true,
    evRecBytes: 5,
  });
}

interface Captured {
  readonly deframer: SerialDeframer;
  readonly v3: Uint8Array[];
  readonly telem: UartTelemFrame[];
  readonly text: string[];
  readonly bad: string[];
}

function newDeframer(): Captured {
  const v3: Uint8Array[] = [];
  const telem: UartTelemFrame[] = [];
  const text: string[] = [];
  const bad: string[] = [];
  const deframer = new SerialDeframer({
    onV3Frame: (f) => v3.push(f),
    onTelem: (t) => telem.push(t),
    onText: (l) => text.push(l),
    onBadFrame: (reason, detail) => bad.push(reason + ":" + detail),
  });
  return { deframer, v3, telem, text, bad };
}

function rig(): { processor: PacketProcessor; frames: FramePacket[]; batches: EventBatch[] } {
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  const processor = new PacketProcessor({
    profile,
    onFrame: (f) => frames.push(f),
    onEvents: (b) => batches.push(b),
  });
  return { processor, frames, batches };
}

test("定界：v3 帧字节与 UDP 路径逐字节同构（byte-identity + 解析/装配等价）", () => {
  const frame = uartEventFrame(7, 12);
  // 路径 A：UDP（一个数据报 = 一个帧，直接喂处理器）
  const a = rig();
  a.processor.pushRawPayload(frame, 1000);
  a.processor.pushRawPayload(uartEventFrame(8, 3), 1001); // 下一帧：把 7 的纯事件批次挤出来
  // 路径 B：串口（同一帧字节，经过定帧器）
  const cap = newDeframer();
  const b = rig();
  cap.deframer.push(frame, 1000);
  cap.deframer.push(uartEventFrame(8, 3), 1001);
  for (const f of cap.v3) b.processor.pushRawPayload(f, 1000);

  assert.equal(cap.v3.length, 2, "两帧都必须被定界出来");
  assert.deepEqual(cap.v3[0], frame, "定帧器给上层的字节必须与板端发出的逐字节相同（含 CRC16）");
  assert.equal(a.batches.length, b.batches.length, "两条路径的事件批次数一致");
  assert.deepEqual(
    b.batches[0]?.records.map((r) => [r.x, r.y, r.pol]),
    a.batches[0]?.records.map((r) => [r.x, r.y, r.pol]),
    "事件记录（坐标/极性）逐条相同",
  );
  assert.equal(b.batches[0]?.records.length, a.batches[0]?.records.length, "事件条数一致");
  assert.deepEqual(b.batches[0]?.raw, a.batches[0]?.raw, "事件段原始字节一致（不是「看起来一样」）");
  assert.equal(cap.deframer.stats.v3Frames, 2);
  assert.equal(cap.deframer.stats.resyncs, 0, "合法流里不允许出现重同步");
});

test("滴灌：每次 1 B 喂入（分片边界切在帧头/帧中）仍能定界且不误判", () => {
  const cap = newDeframer();
  const frames = [uartEventFrame(11, 4), buildUartTelemFrame({ frameCnt: 42, evPerFrame: 2288, activityQ16: 4096, crX10: 265 }), uartEventFrame(12, 6)];
  const all = concatU8(...frames);
  for (const byte of all) cap.deframer.push(Uint8Array.of(byte));
  assert.equal(cap.v3.length, 2, "两个 v3 帧");
  assert.equal(cap.telem.length, 1, "一个遥测帧");
  assert.equal(cap.deframer.stats.resyncs, 0);
  assert.equal(cap.deframer.stats.bytesDropped, 0, "合法流不允许丢任何字节");
  assert.deepEqual(cap.v3[0], frames[0]);
  assert.deepEqual(cap.v3[1], frames[2]);
});

test("CRC16 失败：按字节重同步并计数，且后一帧照常解析（不会一错到底）", () => {
  const cap = newDeframer();
  const broken = buildV3({ events: eventsOf(5), mode: 2, frameIdx: 3, breakCrc: true });
  const good = uartEventFrame(4, 7);
  cap.deframer.push(concatU8(broken, good));
  assert.equal(cap.deframer.stats.v3CrcFail, 1, "坏帧计一次 CRC 失败");
  assert.equal(cap.deframer.stats.resyncs, 1, "失败即一次重同步（设计 §8.2 H2）");
  assert.equal(cap.v3.length, 1, "坏帧不得上送");
  assert.deepEqual(cap.v3[0], good, "重同步后必须找回紧接着的合法帧");
  assert.ok(cap.bad[0]?.startsWith("crcFail:"), "失败原因要如实上报（P6 不静默）");
});

test("长度不自洽：超上限的长度声明 ⇒ badLen 重同步；随后真帧照常解析", () => {
  const cap = newDeframer();
  // EV_LEN=2000 > LIMITS3.EV_LEN(1445)：长度字段被噪声带跑时的典型形态 —— 立刻判坏并重同步
  const lying = buildV3({ events: eventsOf(3), mode: 2, frameIdx: 5, evLenOverride: 2000, withCrc: false });
  const good = uartEventFrame(6, 2);
  cap.deframer.push(concatU8(lying, good));
  assert.equal(cap.deframer.stats.badLen, 1, "超上限长度计一次 badLen");
  assert.equal(cap.deframer.stats.resyncs, 1);
  assert.equal(cap.deframer.stats.v3Frames, 1, "只有真帧上送");
  assert.deepEqual(cap.v3[0], good);
  assert.ok(cap.bad[0]?.startsWith("badLength:"), "失败原因如实上报");
});

test("遥测帧 CRC8 失败：计数 + 重同步；合法遥测帧解出 ev/act/cr（帧型 A 直读）", () => {
  const cap = newDeframer();
  const good = buildUartTelemFrame({ frameCnt: 1234, evPerFrame: 2288, activityQ16: 32768, crX10: 2650, mode: 2, key: 9, evEn: 1 });
  const bad = good.slice();
  bad[20] = (bad[20] as number) ^ 0xff; // 破坏 CRC8
  cap.deframer.push(concatU8(bad, good));
  assert.equal(cap.deframer.stats.telemCrcFail, 1);
  assert.equal(cap.deframer.stats.telemFrames, 1);
  assert.equal(cap.telem[0]?.frameCnt, 1234);
  assert.equal(cap.telem[0]?.evPerFrame, 2288);
  assert.equal(cap.telem[0]?.cr, 265);
  assert.equal(cap.telem[0]?.mode, 2);
  assert.equal(cap.telem[0]?.key, 9);
  assert.equal(cap.telem[0]?.activity, 0.5);
});

test("三族帧 + 人读 ASCII 行 + 下行回显在一条流里共存（分派规则 §3.1）", () => {
  const cap = newDeframer();
  const telem = buildUartTelemFrame({ frameCnt: 7, evPerFrame: 100, activityQ16: 1, crX10: 10 });
  const ascii = new Uint8Array([...Buffer.from("T fr=7 ev=100 act=0 cr=1 mode=0 key=0 en=1\r\n", "ascii")]);
  const ev = uartEventFrame(9, 3);
  const echo = encodeDownlink(0x04, 5, new Uint8Array(0)); // 本机下行回显（F0 5A A5 31）
  cap.deframer.push(concatU8(telem, ascii, ev, echo, uartEventFrame(10, 3)));

  assert.equal(cap.telem.length, 1, "遥测帧");
  assert.deepEqual(cap.text, ["T fr=7 ev=100 act=0 cr=1 mode=0 key=0 en=1"], "ASCII 行按人读通道放行");
  assert.equal(cap.v3.length, 2, "两个 v3 帧（下行回显不算上行帧）");
  assert.equal(cap.deframer.stats.downlinkEcho, 1, "下行回显整帧跳过并计数");
  assert.equal(cap.deframer.stats.resyncs, 0, "共存不应触发重同步");
  assert.deepEqual(cap.v3[0], ev);
  assert.equal(cap.deframer.stats.v3Frames, 2);
  assert.equal(cap.deframer.stats.bytes, telem.length + ascii.length + ev.length + echo.length + cap.v3[1]!.length);
});

test("噪声重同步：垃圾字节（含假 0xF0/0xAA 前缀）不影响后续真帧", () => {
  const cap = newDeframer();
  const junk = Uint8Array.of(0x00, 0xf0, 0xf0, 0x5a, 0xa5, 0x99, 0xaa, 0xaa, 0x55, 0x00, 0x55, 0xf0, 0x5a);
  const good = uartEventFrame(21, 5);
  cap.deframer.push(concatU8(junk, good));
  assert.equal(cap.v3.length, 1, "垃圾里的假魔数不得被当成帧");
  assert.deepEqual(cap.v3[0], good);
  assert.equal(cap.deframer.stats.bytesDropped, junk.length, "垃圾字节逐个计数（不静默）");
  assert.equal(cap.deframer.pending, 0);
});

test("flush：半帧残留按噪声结算（流结束不留下悬挂字节）", () => {
  const cap = newDeframer();
  const frame = uartEventFrame(31, 5);
  cap.deframer.push(frame.subarray(0, 30)); // 只喂半帧
  assert.equal(cap.v3.length, 0);
  assert.equal(cap.deframer.pending, 30, "未定界字节仍挂在缓冲区（联调可观测）");
  cap.deframer.flush();
  assert.equal(cap.deframer.pending, 0);
  assert.equal(cap.deframer.stats.bytesDropped, 30);
});
