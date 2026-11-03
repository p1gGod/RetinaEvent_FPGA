import { test } from "node:test";
import assert from "node:assert/strict";
import { crc8, crc16, crc16Bitwise } from "../src/codec/crc.ts";
import { decodeEvents } from "../src/codec/events.ts";
import { parseV1Packet } from "../src/codec/v1.ts";
import { parseTeleFrame, parseTelemetry, telemCrcOk } from "../src/codec/telem.ts";
import { decodeRgb565 } from "../src/codec/rgb565.ts";
import { getProfile } from "../src/profile.ts";
import { evByteAligned } from "./helpers.ts";

test("CRC 标准检查值（对拍公开常量，验证实现而非自证）", () => {
  const check = new TextEncoder().encode("123456789");
  assert.equal(crc8(check), 0xf4);      // CRC-8/SMBUS (poly 0x07, init 0x00)
  assert.equal(crc16(check), 0x29b1);   // CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) —— 与 RTL 一致
});

test("CRC16 查表 == 逐位（ACK 高负载修复 2026-10-13）：多长度/多初值逐位等价", () => {
  // 逐位版是语义参考（与 RTL 一致）；查表版是热路径实现 —— 两者必须逐位相同，
  // 否则"性能修好了但 CRC 全错"会表现为全线 crcFail（最贵的一类回归）。
  assert.equal(crc16Bitwise(new TextEncoder().encode("123456789")), 0x29b1);
  assert.equal(crc16Bitwise(new TextEncoder().encode("123456789"), 0x0000), 0x31c3); // CRC-16/XMODEM 检查值
  const cases: number[] = [0, 1, 2, 3, 7, 31, 255, 256, 1279, 1304, 1306];
  for (const n of cases) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 131 + 17) & 0xff;
    for (const init of [0xffff, 0x0000, 0x1d0f, 0xffff & 0xabcd]) {
      assert.equal(crc16(buf, init), crc16Bitwise(buf, init), "len=" + n + " init=0x" + init.toString(16));
    }
  }
  // 全 0 / 全 0xff 边界（表首尾项覆盖）
  assert.equal(crc16(new Uint8Array(64)), crc16Bitwise(new Uint8Array(64)));
  assert.equal(crc16(new Uint8Array(64).fill(0xff)), crc16Bitwise(new Uint8Array(64).fill(0xff)));
});

test("CRC8 空输入 = 初值；确定性", () => {
  assert.equal(crc8(new Uint8Array(0)), 0x00);
  assert.equal(crc8(new Uint8Array([1, 2, 3])), crc8(new Uint8Array([1, 2, 3])));
});

test("P5 事件记录长度参数化 + 余数丢弃（evPartial）", () => {
  const d = decodeEvents(evByteAligned(399, 239, 1, 0x2a), 5);
  assert.equal(d.records.length, 1);
  assert.equal(d.partialBytes, 0);
  assert.deepEqual({ ...d.records[0] }, { x: 399, y: 239, pol: 1, flags: 0, ts: 0x2a });
  const short = decodeEvents(new Uint8Array([1, 0, 2, 0, 3, 0, 4]), 5);   // 7 字节 → 1 条 + 2 余
  assert.equal(short.records.length, 1);
  assert.equal(short.partialBytes, 2);
});

test("P6 保留位一律忽略（只取 x/y/pol）", () => {
  const dirty = evByteAligned(200, 100, 1, 0x99, 5, true);   // 保留位全 1
  const d = decodeEvents(dirty, 5);
  assert.equal(d.records[0]!.x, 200);
  assert.equal(d.records[0]!.y, 100);
  assert.equal(d.records[0]!.pol, 1);
});

test("bitpacked-le 布局（缺口 G2 的另一种取值）：3 B 无损表达 x9+y8+pol", () => {
  const v = 399 + 239 * 512 + 1 * 0x20000;                  // x=399 y=239 pol=1
  const rec = new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]);
  const d = decodeEvents(rec, 3, "bitpacked-le");
  assert.equal(d.records[0]!.x, 399);
  assert.equal(d.records[0]!.y, 239);
  assert.equal(d.records[0]!.pol, 1);
});

test("v1 首包：大端 H/V/FRAME_IDX，数据 1280B", () => {
  const P = getProfile("legacy-800x480-1280")!;
  const b = new Uint8Array(1290);
  b[0] = 0xf0; b[1] = 0x5a; b[2] = 0xa5; b[3] = 0x0f;
  const dv = new DataView(b.buffer);
  dv.setUint16(4, 800); dv.setUint16(6, 480); dv.setUint16(8, 7);
  for (let i = 10; i < 1290; i++) b[i] = i & 0xff;
  const r = parseV1Packet(b, { profile: P, expectChunk: null });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.isFirst, true);
  assert.equal(r.value.w, 800);
  assert.equal(r.value.h, 480);
  assert.equal(r.value.frameIdx, 7);
  assert.equal(r.value.data.length, 1280);
  assert.equal(r.value.data[0], 10);
});

test("v1 数据包：1280B，无帧号；未见首包时拒绝", () => {
  const P = getProfile("legacy-800x480-1280")!;
  const d = new Uint8Array(1280).fill(0x5a);
  const r1 = parseV1Packet(d, { profile: P, expectChunk: 3 });
  assert.equal(r1.ok, true);
  if (r1.ok) { assert.equal(r1.value.isFirst, false); assert.equal(r1.value.data.length, 1280); }
  const r2 = parseV1Packet(d, { profile: P, expectChunk: null });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "badLength");
});

test("UART 遥测：载荷小端解析", () => {
  const pl = new Uint8Array(16);
  const dv = new DataView(pl.buffer);
  dv.setUint16(0, 1600, true); dv.setUint16(2, 480, true); dv.setUint16(4, 800, true); dv.setUint16(6, 1207, true);
  dv.setUint32(8, 36000, true); dv.setUint32(12, 43_200_000, true);
  const r = parseTelemetry(pl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual({ ...r.value }, { maxLineW: 1600, maxLineH: 480, lineW: 800, frameCnt: 1207, pclkPeriod: 36000, pclkTotal: 43_200_000 });
  assert.equal(telemCrcOk(pl, crc8(pl)), true);
  assert.equal(telemCrcOk(pl, crc8(pl) ^ 0x01), false);
  const bad = parseTelemetry(new Uint8Array(15));
  assert.equal(bad.ok, false);
});

test("UART 帧头：W/H 大端 + 尺寸防御", () => {
  const h = new Uint8Array(5);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, 400); dv.setUint16(2, 240); dv.setUint8(4, 1);
  assert.deepEqual(parseTeleFrame(h), { w: 400, h: 240, mode: 1 });
  dv.setUint16(0, 0);
  assert.equal(parseTeleFrame(h), null);
});

test("RGB565 → RGBA（高位在前 / 低位在前）", () => {
  const be = new Uint8Array([0xf8, 0x00, 0x07, 0xe0]);      // 红、绿
  const out = new Uint8ClampedArray(8);
  decodeRgb565(be, out, "BE");
  assert.deepEqual(Array.from(out.subarray(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(out.subarray(4, 8)), [0, 255, 0, 255]);
  const le = new Uint8ClampedArray(4);
  decodeRgb565(new Uint8Array([0x00, 0xf8]), le, "LE");
  assert.deepEqual(Array.from(le), [255, 0, 0, 255]);
});
