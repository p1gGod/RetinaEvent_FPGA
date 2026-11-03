import { test } from "node:test";
import assert from "node:assert/strict";
// 从 barrel 入口导入（gateway / web / tools 都只允许这么用；顺便证明"单一实现"真的导出全了）
import {
  parseV2Packet, parseV1Packet, decodeEvents, parseTelemetry, decodeRgb565, crc8, crc16,
  getProfile, validateProfile, encodeIpc, decodeIpc, createCounters, bump, gapOf,
  encodeRtpkt, iterRtpkt, countRtpkt, LAYER_Z, OFF, MAGIC, MAX_PAYLOAD, COUNTER_KEYS, RPC_METHODS,
} from "../src/index.ts";

test("工具链：Node 原生跑 TS + 断言可用", () => {
  assert.equal(typeof parseV2Packet, "function");
  assert.equal(typeof crc8, "function");
});

test("barrel 导出完整：三个工作流需要的入口都在 @retina/protocol 里", () => {
  for (const f of [parseV2Packet, parseV1Packet, decodeEvents, parseTelemetry, decodeRgb565, crc8, crc16,
    getProfile, validateProfile, encodeIpc, decodeIpc, createCounters, bump, gapOf, encodeRtpkt, iterRtpkt, countRtpkt]) {
    assert.equal(typeof f, "function");
  }
  assert.equal(OFF.HEADER, 13);
  assert.equal(MAX_PAYLOAD, 1472);
  assert.equal(MAGIC.length, 4);
  // 15 → 25（2026-10-11 WIRE-V3 §7.2 增补 badVersion/badHdrLen/modeNotice/tsEpochReset/tsCalFail/
  // idxWrap/dlCrcFail/dlBadOpcode/dlReject/modeConflict）。v2 线格式断言（OFF/MAGIC）原样保留。
  // 25 → 26（2026-10-13 网关事件归属修复增补 evOrphan：先到的纯事件包其帧号被跳过 ⇒ 显式丢弃计数）。
  // 上一条 15 → 25 见 2026-10-11 WIRE-V3 §7.2 增补 10 个。
  assert.equal(COUNTER_KEYS.length, 26);
  assert.equal(LAYER_Z.EVENTS, 200);
  assert.ok(RPC_METHODS.includes("transport.start"));
});
