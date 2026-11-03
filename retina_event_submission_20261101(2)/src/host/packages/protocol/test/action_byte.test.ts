// 动作识别字节（byte23 = OFF3.ACTION）协议层测试 —— 契约 05_动作回传与上位机契约 §2/§3。
// 为什么单独成文件：动作字节是 2026-10-29 新增的线上语义，必须能独立跑（npm run test:protocol），
// 且用例要逐位锁死 VALID/CONF/CLASS 的位分配，避免以后重构时"移一下位"静默改掉契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACT3,
  ACT_CLASS_NAMES,
  CTRL,
  OFF3,
  decodeActionState,
  encodeActionState,
  getProfile,
  parseV3Packet,
} from "../src/index.ts";
import { buildV3, concatU8, seq, v3Tlv } from "./helpers.ts";

const P = getProfile("retina-v2-800x480-1280")!;
const base = { profile: P };

// ————————————————————————— 常量 / 位分配（契约 §2.1） —————————————————————————

test("A1 位分配常量：byte23、VALID=bit7、CONF=bit6..2、CLASS=bit1..0", () => {
  // 这几个数字是板端 RTL 与上位机共同依赖的硬事实，任何一个被改动都必须先改契约文档
  assert.equal(OFF3.ACTION, 23, "动作字节固定占 byte23（24 B 定长头内）");
  assert.equal(OFF3.ACTION, OFF3.RSVD, "旧名 RSVD 必须指向同一字节（兼容历史代码/文档）");
  assert.equal(ACT3.VALID, 0x80);
  assert.equal(ACT3.CONF_SHIFT, 2);
  assert.equal(ACT3.CONF_MASK, 0x1f);
  assert.equal(ACT3.CLASS_MASK, 0x03);
  assert.equal(CTRL.TLV.ACTION_STATE, 0x92, "TLV 0x92 = ACTION_STATE（只随 GET_STATUS ACK 尾追）");
  assert.equal(CTRL.LEN.GET_STATUS_ACK_ACT, 71, "GET_STATUS ACK 带动作 TLV 后 CTRL_LEN=68+3=71");
});

test("A2 类别显示名与当前权威语义一致（class3 保留必须按无动作处理）", () => {
  assert.deepEqual([...ACT_CLASS_NAMES], ["无动作", "手部开合", "横向挥手", "保留"]);
});

// ————————————————————————— 解码（契约 §2.1 尾段：坏字节不抛错） —————————————————————————

test("A3 0x00（未启用）→ {valid:false, conf:0, cls:0}", () => {
  assert.deepEqual(decodeActionState(0x00), { valid: false, conf: 0, cls: 0 });
});

test("A4 0x80|0x01 → valid、class1、conf0（纯 VALID+CLASS，无置信度位）", () => {
  const s = decodeActionState(0x81);
  assert.equal(s.valid, true);
  assert.equal(s.conf, 0);
  assert.equal(s.cls, 1);
});

test("A5 conf 位在 bit6..2：0x80|(1<<2)|1 = 0x85 → conf1 class1", () => {
  assert.deepEqual(decodeActionState(0x85), { valid: true, conf: 1, cls: 1 });
});

test("A6 0xFF → valid、conf31（最大置信度）、class3（保留类仍解析，是否执行由上层判）", () => {
  assert.deepEqual(decodeActionState(0xff), { valid: true, conf: 31, cls: 3 });
});

test("A7 VALID=1 且 CLASS=0 是合法常见组合（静止但识别在跑）", () => {
  assert.deepEqual(decodeActionState(0x80), { valid: true, conf: 0, cls: 0 });
});

test("A8 组合位：VALID + conf=8 + class2 = 0xA2（逐段拼装必须与契约位图一致）", () => {
  const raw = (ACT3.VALID | (8 << ACT3.CONF_SHIFT) | 2) & 0xff;
  assert.equal(raw, 0xa2);
  assert.deepEqual(decodeActionState(raw), { valid: true, conf: 8, cls: 2 });
});

test("A9 非 8 bit 入参只取低 8 位（不抛错、不把高位当 VALID）", () => {
  // 0x1A2 的低 8 位 = 0xA2；若实现忘了截断，conf 会变成 40（越界）或被高位误判
  assert.deepEqual(decodeActionState(0x1a2), { valid: true, conf: 8, cls: 2 });
  assert.deepEqual(decodeActionState(-1), { valid: true, conf: 31, cls: 3 }, "无符号字节语义：-1 等价 0xFF");
});

// ————————————————————————— 编码（契约 §2.2 encodeActionByte） —————————————————————————

test("A10 编解码互逆：合法字段 roundtrip 原值", () => {
  for (const s of [
    { valid: false, conf: 0, cls: 0 },
    { valid: true, conf: 0, cls: 1 },
    { valid: true, conf: 8, cls: 2 },
    { valid: true, conf: 31, cls: 3 },
  ] as const) {
    assert.deepEqual(decodeActionState(encodeActionState(s)), s);
  }
});

test("A11 编码越界夹值：conf 99→31、cls 7→3（自检脚本不许因越界抛错）", () => {
  assert.deepEqual(decodeActionState(encodeActionState({ valid: true, conf: 99, cls: 7 })), { valid: true, conf: 31, cls: 3 });
});

// ————————————————————————— 与包解析的衔接 —————————————————————————

test("A12 parseV3Packet 不消费 byte23，但数据包/CTRL 包都保留该字节（网关直接读 buf[23]）", () => {
  const data = buildV3({ raw: seq(16), rsvd: 0xa2 });
  const r = parseV3Packet(data, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(data[OFF3.ACTION], 0xa2, "数据包的 byte23 原样在线上");

  const ctrl = buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.GET_STATUS, ctrlTlv: new Uint8Array(0), rsvd: 0x85 });
  const rc = parseV3Packet(ctrl, base);
  assert.equal(rc.ok, true);
  if (!rc.ok) return;
  assert.equal(ctrl[OFF3.ACTION], 0x85, "CTRL 包同样带 byte23（TLV 0x92 只做旁证）");
});

test("A13 GET_STATUS ACK 尾追 TLV 0x92：解析保留、不误判成 TIME_SYNC_REQ、不丢整包", () => {
  const actionTlv = v3Tlv(0x92, Uint8Array.of(0xa2));
  // 旧 ACK（68 B 惯例）的已知 TLV 尾部 + 新 0x92 —— 长度声明由 buildV3 按实际载荷算，解析只认声明
  const known = v3Tlv(0x8e, Uint8Array.of(1, 1, 0)); // SER_STATE（3 B，随便一条已知 TLV 占位）
  const pkt = buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.GET_STATUS,
    ctrlStatus: 0,
    ctrlSeq: 7,
    ctrlTlv: concatU8(known, actionTlv),
  });
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.opcode, 0x04);
  assert.deepEqual(r.value.ctrlHeader?.tlv.map((t) => t.tag), [0x8e, 0x92]);
  const t = r.value.ctrlHeader?.tlv[1];
  assert.equal(t?.value.length, 1);
  assert.equal(t?.value[0], 0xa2);
  assert.equal(r.value.warnings.includes("ctrlReq"), false, "已知 tag 集合已含 0x92，不得误判为 TIME_SYNC_REQ");
});

test("A14 TLV 0x92 len≠1 时仍不丢整包（契约 §3：忽略该 TLV 即可，由使用方判）", () => {
  const bad = v3Tlv(0x92, Uint8Array.of(1, 2)); // len=2，非法但结构自洽
  const pkt = buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.GET_STATUS, ctrlTlv: bad });
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true, "坏 TLV 长度不得导致整包被拒");
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.tlv[0]?.tag, 0x92);
  assert.equal(r.value.ctrlHeader?.tlv[0]?.value.length, 2);
});
