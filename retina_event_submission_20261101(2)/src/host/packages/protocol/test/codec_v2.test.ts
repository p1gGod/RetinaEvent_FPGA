import { test } from "node:test";
import assert from "node:assert/strict";
import { parseV2Packet } from "../src/codec/v2.ts";
import { getProfile, validateProfile } from "../src/profile.ts";
import { buildV2, evByteAligned, seq } from "./helpers.ts";

const P = getProfile("retina-v2-800x480-e5")!;
const base = { profile: P };

test("P0 profile 自检：内置 profile 全部合法", () => {
  for (const n of ["legacy-800x480-1280", "retina-v2-800x480-e5", "retina-v2-800x480-e3", "telem-400x240"]) {
    const c = validateProfile(getProfile(n)!);
    assert.equal(c.ok, true, n + " 应合法：" + c.errors.join("; "));
  }
});

test("P1 正常包（仅原始段，无 CRC）", () => {
  const raw = seq(1024);
  const r = parseV2Packet(buildV2({ frameIdx: 0x1234, chunkIdx: 749, raw }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.frameIdx, 0x1234);        // P7 大端
  assert.equal(r.value.chunkIdx, 749);
  assert.equal(r.value.hasRaw, true);
  assert.equal(r.value.hasEvents, false);
  assert.equal(r.value.raw?.length, 1024);
  assert.deepEqual(Array.from(r.value.raw!.subarray(0, 4)), [0, 1, 2, 3]);
  assert.equal(r.value.crc16Present, false);
});

test("P1 正常包（原始段 + 事件段 + CRC16）", () => {
  const raw = seq(1024);
  const ev = evByteAligned(399, 239, 1, 0x2a);
  const r = parseV2Packet(buildV2({ raw, events: ev, withCrc: true }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.crc16Present, true);
  assert.equal(r.value.events?.length, 5);
});

test("P1 长度不自洽 → badLength", () => {
  const r = parseV2Packet(buildV2({ raw: seq(1024), totalPad: 3 }), base);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "badLength");
});

test("P2 超 MTU → oversize；短包 → truncated", () => {
  const big = buildV2({ raw: seq(1460) });            // 13+1460 = 1473 > 1472
  const r1 = parseV2Packet(big, base);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "oversize");
  const r2 = parseV2Packet(new Uint8Array([0xf0, 0x5a, 0xa5]), base);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "truncated");
});

test("P1 魔数错 → badMagic", () => {
  const b = buildV2({ raw: seq(16) });
  b[2] = 0x00;
  const r = parseV2Packet(b, base);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "badMagic");
});

test("P3 SEG_MASK 与长度矛盾：以 SEG_MASK 为准 + 告警 + 偏移不错位", () => {
  const ev = evByteAligned(100, 50, 0, 0);
  // 声明 rawLen=1024 但 SEG_MASK.bit0=0（只声明事件段）
  const b = buildV2({ raw: seq(1024), events: ev, segMask: 0b10, rawLenOverride: 1024 });
  const r = parseV2Packet(b, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.hasRaw, false);
  assert.equal(r.value.raw, null);
  assert.ok(r.value.warnings.includes("segInconsistent"));
  assert.equal(r.value.events?.length, 5);            // EV 起点仍是 13+rawLen，没有错位
  assert.equal(r.value.events?.[0], 100);
});

test("P4 保留位只告警不报错（前向兼容）", () => {
  const r = parseV2Packet(buildV2({ raw: seq(8), segMaskReserved: true }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.warnings.includes("segNotice"));
});

test("P3' 事件包：SEG_MASK=0b10（缺口 G3，允许只有事件）", () => {
  const r = parseV2Packet(buildV2({ events: evByteAligned(1, 2, 1, 0) }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.hasRaw, false);
  assert.equal(r.value.hasEvents, true);
  assert.equal(r.value.rawLen, 0);
});

test("P2' profile 声明无 CRC 却多 2 字节 → badLength", () => {
  const strict = { ...P, crc16: "none" as const };
  const r = parseV2Packet(buildV2({ raw: seq(16), withCrc: true }), { profile: strict });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "badLength");
});

test("P5' CRC16 损坏 → crcFail（不整帧放弃，只丢该包）", () => {
  const r = parseV2Packet(buildV2({ raw: seq(1024), withCrc: true, breakCrc: true }), base);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "crcFail");
});

test("P9 任何输入都不抛异常（垃圾数据）", () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0), new Uint8Array([1]), new Uint8Array([0xf0, 0x5a, 0xa5, 0x0f]),
    new Uint8Array(2000).fill(0xab), buildV2({ raw: seq(2000) }),
  ];
  for (const c of cases) {
    const r = parseV2Packet(c, base);
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.equal(typeof r.reason, "string");
  }
});

test("不改动输入缓冲（原则 P2）", () => {
  const b = buildV2({ raw: seq(32) });
  const copy = Uint8Array.from(b);
  parseV2Packet(b, base);
  assert.deepEqual(Array.from(b), Array.from(copy));
});
