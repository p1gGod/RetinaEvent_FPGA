// UART 遥测帧 CRC8 **覆盖范围**回归（2026-10-17，真实 COM6 捕获 10 帧）。
//
// 真值来源：retina_event/src/hdl/comms/uart_link.v:637
//   if (bin_idx < 8'd20) bin_crc <= crc8_step(bin_crc, bin_byte_w);
// bin_idx 0..19 = 4 B 魔数 + 16 B 载荷。老模块 uart_telemetry.v:595 也是 bin_idx<20。
// 旧上位机只对 16 B 载荷校验 ⇒ 真帧全部 crcFail，串口遥测整条通道看起来"没数据"。
//
// 下面 10 个 21 B 十六进制字面量是 2026-10-17 18:25 从 COM6 @115200 直接捕获的原文
// （C:/Users/Admin/AppData/Local/Temp/seam/com6_2s.bin，6848 B / 2500 ms）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TELEM, crc8 } from "@retina/protocol";
import { buildUartTelemFrame, parseUartTelemFrame, telemCrcOk } from "@retina/protocol";

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

/** 现场捕获的 10 个完整 21 B 遥测帧（原文，未改写） */
const CAPTURE = [
  "aa55544d00001d210015820eae000074000001011b",
  "aa55544d00001d280014dd0e3e00007800000101b0",
  "aa55544d00001d2e000ee70a2c0000a80000010147",
  "aa55544d00001d3500141d0dbb00007c0000010197",
  "aa55544d00001d3e0023e3187f000046000001012d",
  "aa55544d00001d42001f87158500004f0000010149",
  "aa55544d00001d4c0016a30f7400006e000001017e",
  "aa55544d00001d50001fa2159800004f0000010105",
  "aa55544d00001d590012e00ce200008400000101c6",
  "aa55544d00001d5d0015680e9d00007500000101fd",
].map(hex);

test("现场捕获 10/10：CRC8 覆盖前 20 B（魔数+载荷）必须全部通过", () => {
  assert.equal(CAPTURE.length, 10);
  const cnts: number[] = [];
  for (const [i, f] of CAPTURE.entries()) {
    assert.equal(f.length, TELEM.TOTAL, "帧 " + i + " 长度");
    assert.deepEqual([...f.subarray(0, 4)], [0xaa, 0x55, 0x54, 0x4d], "帧 " + i + " 魔数");
    assert.equal(telemCrcOk(f.subarray(0, 20), f[20] as number), true, "帧 " + i + " 前 20 B CRC");
    const r = parseUartTelemFrame(f);
    assert.equal(r.ok, true, "帧 " + i + " 解析： " + (r.ok ? "" : r.detail));
    if (!r.ok) continue;
    assert.equal(r.value.protoVer, 1);
    assert.equal(r.value.frameCnt, ((f[4]! << 24) | (f[5]! << 16) | (f[6]! << 8) | f[7]!) >>> 0);
    cnts.push(r.value.frameCnt);
  }
  assert.deepEqual(cnts, [0x1d21, 0x1d28, 0x1d2e, 0x1d35, 0x1d3e, 0x1d42, 0x1d4c, 0x1d50, 0x1d59, 0x1d5d]);
});

test("反向对照：只算 16 B 载荷的旧口径 0/10 通过（证明修复点确实是覆盖范围）", () => {
  for (const [i, f] of CAPTURE.entries()) {
    const old = crc8(f.subarray(4, 20));
    assert.notEqual(old, f[20], "帧 " + i + " 旧口径不应等于真 CRC（否则本回归无区分力）");
  }
  // 把 CRC 字节改成"只覆盖载荷"的值：按 RTL 口径必须被判 crcFail，不能静默通过
  const f = CAPTURE[0]!.slice();
  f[20] = crc8(f.subarray(4, 20));
  const r = parseUartTelemFrame(f);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "crcFail");
});

test("编解码往返 10 次全 ok；build 写出的 CRC = crc8(前 20 B)", () => {
  for (let i = 0; i < 10; i++) {
    const f = buildUartTelemFrame({
      frameCnt: 0x1d21 + i,
      evPerFrame: 0x1582 + i,
      activityQ16: 0x0eae,
      crX10: 0x000074,
      mode: 2,
      key: i & 0x0f,
      evEn: 1,
      protoVer: 1,
    });
    assert.equal(f[20], crc8(f.subarray(0, 20)), "CRC 覆盖前 20 B");
    const r = parseUartTelemFrame(f);
    assert.equal(r.ok, true, "往返 " + i + "： " + (r.ok ? "" : r.detail));
    if (r.ok) assert.equal(r.value.frameCnt, 0x1d21 + i);
  }
});

test("负例：CRC 字节翻 1 bit / 载荷翻 1 bit 都必须拒收（不半解释）", () => {
  const c = CAPTURE[3]!.slice();
  c[20] = (c[20] as number) ^ 0x01;
  const rc = parseUartTelemFrame(c);
  assert.equal(rc.ok, false);
  if (!rc.ok) assert.equal(rc.reason, "crcFail");

  const p = CAPTURE[3]!.slice();
  p[10] = (p[10] as number) ^ 0x01;
  const rp = parseUartTelemFrame(p);
  assert.equal(rp.ok, false);
  if (!rp.ok) assert.equal(rp.reason, "crcFail");
});
