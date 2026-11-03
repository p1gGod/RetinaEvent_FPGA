import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile, iterRtpkt, parseV1Packet, parseV2Packet } from "@retina/protocol";

// 这个测试守的是"网关只通过 @retina/protocol 的 barrel 拿协议能力"（原则 P1）：
// 一旦 barrel 漏导出某个函数，网关会在 import 期就炸 —— 与其在运行时花屏，不如在这里红。
test("工作区子包可被 ESM 解析，且 barrel 导出了网关依赖的协议入口", () => {
  assert.equal(typeof parseV2Packet, "function");
  assert.equal(typeof parseV1Packet, "function");
  assert.equal(typeof iterRtpkt, "function");
  const p = getProfile("retina-v2-800x480-e5");
  assert.ok(p);
  assert.equal(p.frame.bytes, 768000);
});
