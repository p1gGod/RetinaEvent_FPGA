#!/usr/bin/env node
// analyze_dump.mjs —— 离线分析 udp_sniff_v3.mjs 落盘的裸 UDP 原始字节（前 400 包）
// 目的：看板端包序列的"帧/块"推进是否连续（有没有整帧缺块），从而判断装配器 aborted 计数是否指向丢包。
import fs from "node:fs";

const file = process.argv[2];
const buf = fs.readFileSync(file);
const packets = [];
let off = 0;
while (off + 4 <= buf.length) {
  if (!(buf[off] === 0xf0 && buf[off + 1] === 0x5a && buf[off + 2] === 0xa5 && buf[off + 3] === 0x30)) break;
  const len = 24 + buf.readUInt16BE(off + 12) + buf.readUInt16BE(off + 14) + 2;
  packets.push({
    frameIdx: buf.readUInt16BE(off + 10),
    chunkIdx: buf.readUInt16BE(off + 8),
    rawLen: buf.readUInt16BE(off + 12),
    evLen: buf.readUInt16BE(off + 14),
    mode: buf[off + 7],
    tsUs: Number(buf.readBigUInt64BE(off + 16) >> 16n),
    len,
  });
  off += len;
}
console.log("解析出 " + packets.length + " 包（应等于 dump 内包数；若少于文件里实际包数说明边界不对）");

const byFrame = new Map();
for (const p of packets) {
  if (!byFrame.has(p.frameIdx)) byFrame.set(p.frameIdx, { chunks: [], evPkts: 0, tsMin: Infinity, tsMax: -Infinity });
  const f = byFrame.get(p.frameIdx);
  if (p.rawLen > 0) f.chunks.push(p.chunkIdx);
  if (p.evLen > 0) f.evPkts++;
  if (p.tsUs < f.tsMin) f.tsMin = p.tsUs;
  if (p.tsUs > f.tsMax) f.tsMax = p.tsUs;
}
console.log("涉及帧数 = " + byFrame.size);
for (const [idx, f] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
  const sorted = [...f.chunks].sort((a, b) => a - b);
  const missing = [];
  if (sorted.length > 0) {
    for (let i = sorted[0]; i <= Math.min(sorted[sorted.length - 1], sorted[0] + 599); i++) {
      if (!sorted.includes(i)) missing.push(i);
    }
  }
  console.log("FRAME " + idx + ": RAW包=" + f.chunks.length + " EV包=" + f.evPkts +
    " chunk 范围=[" + (sorted[0] ?? "-") + ".." + (sorted[sorted.length - 1] ?? "-") + "]" +
    " 缺块数=" + missing.length + (missing.length > 0 && missing.length <= 12 ? " 缺=" + missing.join(",") : "") +
    " 帧内时长µs=" + (f.tsMax - f.tsMin));
}
