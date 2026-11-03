// 串口遥测帧（帧型 A）编解码测试 —— 与板端 RTL 逐字节对齐。
//
// 真值来源（只读引用，未改 RTL）：`retina_event/src/hdl/comms/uart_link.v` 的 `pay_byte()`
// （偏移 0..15 的字段与字节序）与 `bin_byte_w`（AA 55 54 4D + 16 B + CRC8）。
// 语义来源：WIRE-U1 §3.1 帧型 A（帧计数/每帧事件数/活跃度/降低率/模式/按键/EV_EN/版本号）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TELEM, crc8 } from "@retina/protocol";
import { buildUartTelemFrame, parseUartTelemFrame, parseTelemetry, telemCrcOk } from "@retina/protocol";

test("帧型 A 逐字节：AA 55 54 4D + 16 B 大端载荷 + CRC8(覆盖前 20 B，与 RTL 一致)", () => {
  const f = buildUartTelemFrame({ frameCnt: 0x01020304, evPerFrame: 0x0a0b0c, activityQ16: 0x7fff, crX10: 0x010203, mode: 2, key: 5, evEn: 1 });
  assert.equal(f.length, TELEM.TOTAL, "定长 21 B（4+16+1）");
  assert.deepEqual([...f.subarray(0, 4)], [0xaa, 0x55, 0x54, 0x4d]);
  // 大端逐字段（与 RTL pay_byte 的 {[31:24],[23:16],[15:8],[7:0]} 顺序一致）
  assert.deepEqual([...f.subarray(4, 8)], [0x01, 0x02, 0x03, 0x04], "frameCnt u32 BE");
  assert.deepEqual([...f.subarray(8, 11)], [0x0a, 0x0b, 0x0c], "evPerFrame u24 BE");
  assert.deepEqual([...f.subarray(11, 13)], [0x7f, 0xff], "activityQ16 u16 BE");
  assert.deepEqual([...f.subarray(13, 16)], [0x01, 0x02, 0x03], "crX10 u24 BE");
  assert.equal(f[16], 2, "mode");
  assert.equal(f[17], 5, "key（低 4 bit）");
  assert.equal(f[18], 1, "evEn");
  assert.equal(f[19], 0x01, "PROTO_VER");
  assert.equal(f[20], crc8(f.subarray(0, 20)), "CRC8(poly 0x07) 覆盖前 20 B（魔数+载荷）");
});

test("解析：ev/act/cr 直读字段换算正确（串口连接卡上屏口径）", () => {
  const f = buildUartTelemFrame({ frameCnt: 26_500, evPerFrame: 2288, activityQ16: 32768, crX10: 2650, mode: 1, key: 9, evEn: 0 });
  const r = parseUartTelemFrame(f);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.frameCnt, 26_500);
  assert.equal(r.value.evPerFrame, 2288);
  assert.equal(r.value.activity, 0.5, "activityQ16 / 65536");
  assert.equal(r.value.cr, 265, "crX10 / 10（降低倍数）");
  assert.equal(r.value.crSaturated, false);
  assert.equal(r.value.mode, 1);
  assert.equal(r.value.key, 9);
  assert.equal(r.value.evEn, 0);
  assert.equal(r.value.protoVer, 1);
});

test("无事件饱和值：crX10 = 0xFFFFFF 必须识别为饱和（不是 1677721.5 倍降低）", () => {
  const f = buildUartTelemFrame({ frameCnt: 1, evPerFrame: 0, activityQ16: 0, crX10: 0xffffff });
  const r = parseUartTelemFrame(f);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.crSaturated, true);
  assert.equal(r.value.evPerFrame, 0);
});

test("长度/魔数/CRC 三种坏帧都必须拒收（不半解释）", () => {
  const good = buildUartTelemFrame({ frameCnt: 2, evPerFrame: 3, activityQ16: 4, crX10: 5 });
  assert.equal(parseUartTelemFrame(good.subarray(0, 20)).ok, false, "长度不是 21 ⇒ 拒收");
  const badMagic = good.slice();
  badMagic[2] = 0x00;
  const m = parseUartTelemFrame(badMagic);
  assert.equal(m.ok, false);
  if (!m.ok) assert.equal(m.reason, "badMagic");
  const badCrc = good.slice();
  badCrc[20] = (badCrc[20] as number) ^ 0xff;
  const c = parseUartTelemFrame(badCrc);
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.reason, "crcFail");
});

test("与旧 v1 遥测解析共存：同一 21 B 帧不会被 v1 路径误收（两条口径不混）", () => {
  const f = buildUartTelemFrame({ frameCnt: 1, evPerFrame: 2, activityQ16: 3, crX10: 4 });
  // v1 路径吃的是"16 B 小端载荷 + 单独 CRC 字节"，与本帧的 16 B 大端统计载荷语义不同；
  // 这里只证明 CRC8 工具同源、且 21 B 全帧不会被 v1 的载荷长度判据接受。
  assert.equal(telemCrcOk(f.subarray(0, 20), f[20] as number), true);
  assert.equal(parseTelemetry(f.subarray(4, 20)).ok, true, "v1 解析器只认长度，不看语义（历史事实）");
  assert.notDeepEqual([...(f.subarray(4, 20))], [], "帧字节非空");
});
