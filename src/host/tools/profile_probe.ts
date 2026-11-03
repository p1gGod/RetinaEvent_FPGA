// profile 选择诊断：**板子发的包，用哪个 profile 才能解开？**
//
// 为什么需要它（2026-10-07 的真实事故）：网关当时跑的是
//     --profile legacy-800x480-1280     （wire = "LEGACY" ⇒ 用 parseV1Packet）
// 而板子发的是 **v2/STREAM** 格式（`udp_merge.v` 的 13B 包头）。
// 两者**魔数相同**（缺口 G6），且 v2 的 1295 B 包 ≥ v1 的 FIRST_PKT 阈值 1290 B
// ⇒ v1 解析器把**每一个包**都当成"首包"，然后按 v1 的偏移读帧号：
//     v1: frameIdx = getUint16(8)
//     v2: 偏移 8 其实是 {chunk_idx[7:0], raw_len[15:8]}（raw_len=1280 ⇒ 低字节 0x05）
//   ⇒ 解出的"帧号" = (chunkIdx & 0xFF) * 256 + 5，**每包都变**
//   ⇒ 装配器每包 abort 一次：aborted ≈ 包数、idxGap ≈ 255/包、framesSeen 不涨。
// 现象上"包全都在到、MAGIC/CRC/长度全对，就是组不出帧"，极容易被误判成板子的问题。
//
// 实测对照（本脚本的输出，与当时活着的网关逐项对上）：
//     chunk=599 时 v1 解出 22277 —— 而网关 /api/stats 的 lastFrameIdx 正好是 **22277**。
//
// 用法：cd host/app && node --experimental-strip-types tools/profile_probe.ts
// 判据：v2 解析对同一 frameIdx 的 600 块**都给出同一个帧号**；v1 解析**每块都不同**。
import { parseV1Packet, parseV2Packet, crc16, getProfile } from "@retina/protocol";

const profile = getProfile("retina-v2-800x480-1280");
const legacy = getProfile("legacy-800x480-1280");
if (!profile || !legacy) throw new Error("profile 缺失");

/** 按 udp_merge.v 的 hdr_byte() 造包：MAGIC|frameIdx(2)|segMask(1)|chunkIdx(2)|rawLen(2)|evLen(2)|raw|crc16(2) */
function buildV2(frameIdx: number, chunkIdx: number): Uint8Array {
  const rawLen = 1280;
  const evLen = 0;
  const buf = new Uint8Array(13 + rawLen + 2);
  const dv = new DataView(buf.buffer);
  buf[0] = 0xf0; buf[1] = 0x5a; buf[2] = 0xa5; buf[3] = 0x0f;
  dv.setUint16(4, frameIdx);
  buf[6] = 0b01;                       // SEG.RAW
  dv.setUint16(7, chunkIdx);
  dv.setUint16(9, rawLen);
  dv.setUint16(11, evLen);
  for (let i = 0; i < rawLen; i++) buf[13 + i] = (i * 7) & 0xff;
  dv.setUint16(13 + rawLen, crc16(buf.subarray(0, 13 + rawLen)));
  return buf;
}

console.log("包长 = " + buildV2(0, 0).length + " B（v1 的 FIRST_PKT 阈值 = 1290 ⇒ 每包都被当成 v1 首包）");
console.log("");
console.log(" chunk |  v2 正确解析 (frameIdx, chunkIdx)  |  v1 误解析 frameIdx");
console.log("-------|----------------------------------|--------------------");
for (const c of [0, 1, 2, 127, 128, 255, 256, 257, 511, 512, 599]) {
  const p = buildV2(7, c);
  const r2 = parseV2Packet(p, { profile, strictCrc: true });
  const r1 = parseV1Packet(p, { profile: legacy, expectChunk: null });
  const v2 = r2.ok ? `(${r2.value.frameIdx}, ${r2.value.chunkIdx})` : "ERR " + r2.reason;
  const v1 = r1.ok ? String(r1.value.frameIdx) : "ERR " + r1.reason;
  console.log(String(c).padStart(6) + " |  " + v2.padEnd(32) + "|  " + v1);
}
console.log("");
const a = parseV1Packet(buildV2(7, 0), { profile: legacy, expectChunk: null });
const b = parseV1Packet(buildV2(7, 1), { profile: legacy, expectChunk: null });
console.log("结论：同一个 frameIdx=7 的两块，v1 解出的 frameIdx 分别是 " +
  (a.ok ? a.value.frameIdx : "?") + " 与 " + (b.ok ? b.value.frameIdx : "?") +
  " ⇒ **每包都不同** ⇒ 装配器每包 abort 一次（aborted ≈ 包数、idxGap ≈ 255/包）。");
console.log("而 v2 解析给出 frameIdx=7、chunkIdx=0/1 ⇒ 同一帧，正常装配。");
