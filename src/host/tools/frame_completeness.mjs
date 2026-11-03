#!/usr/bin/env node
// frame_completeness.mjs —— 只统计"板端每帧的块是否齐全"，判断丢块的源头在板端还是在 PC。
// 为什么单独一个工具：装配器 aborted 变多时，必须回答"是板端少发了块，还是 PC 内核丢了包"。
//   板端少发 ⇒ 抽包看到某帧的块集合本身有洞（源头在板）；
//   板端发全 ⇒ 抓包侧（独占端口）看到齐全，那么网关侧的截断只能是 PC 内核缓冲丢包。
// 用法: node tools/frame_completeness.mjs [--ms 20000] [--chunks 600]
import dgram from "node:dgram";
const argv = process.argv.slice(2);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const MS = Number(valOf("--ms", 20000));
const CHUNKS = Number(valOf("--chunks", 600));
const BYTES = Math.ceil(CHUNKS / 8);

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true, recvBufferSize: 16 * 1024 * 1024 });
const frames = new Map();     // frameIdx -> bitmap
let framesDone = 0, complete = 0, incomplete = 0, pktTotal = 0, evPkts = 0;
const holesHist = new Map();
const chunkMinMaxSamples = [];
let cur = null;

function evalFrame(idx, bm) {
  let holes = 0;
  for (let c = 0; c < CHUNKS; c++) if ((bm[c >> 3] & (1 << (c & 7))) === 0) holes++;
  framesDone++;
  if (holes === 0) complete++;
  else {
    incomplete++;
    holesHist.set(holes, (holesHist.get(holes) ?? 0) + 1);
    if (chunkMinMaxSamples.length < 5) {
      const missing = [];
      for (let c = 0; c < CHUNKS && missing.length < 8; c++) if ((bm[c >> 3] & (1 << (c & 7))) === 0) missing.push(c);
      chunkMinMaxSamples.push({ idx, holes, missingFirst: missing });
    }
  }
}

sock.on("message", (msg) => {
  pktTotal++;
  if (msg.length < 24 || msg[0] !== 0xf0 || msg[1] !== 0x5a || msg[2] !== 0xa5 || msg[3] !== 0x30) return;
  const flags = msg[6];
  if ((flags & 0x80) !== 0) return;                     // CTRL：另算
  const rawLen = msg.readUInt16BE(12), evLen = msg.readUInt16BE(14);
  if (evLen > 0) evPkts++;
  if (rawLen === 0) return;
  const frameIdx = msg.readUInt16BE(10), chunkIdx = msg.readUInt16BE(8);
  if (cur === null) { cur = frameIdx; frames.set(cur, new Uint8Array(BYTES)); }
  else if (frameIdx !== cur) {
    evalFrame(cur, frames.get(cur));
    frames.delete(cur);
    cur = frameIdx;
    frames.set(cur, new Uint8Array(BYTES));
  }
  if (chunkIdx < CHUNKS) {
    const bm = frames.get(cur);
    bm[chunkIdx >> 3] |= 1 << (chunkIdx & 7);
  }
});
sock.bind(1234, "192.168.1.102");
setTimeout(() => {
  console.log("包总数 = " + pktTotal + "（含事件段混合包 " + evPkts + "）");
  console.log("板端帧总数（首尾截断的当前帧不计）= " + framesDone);
  console.log("块齐全的帧 = " + complete + "；有洞的帧 = " + incomplete +
    (framesDone > 0 ? "（缺块帧占比 " + (100 * incomplete / framesDone).toFixed(1) + "%）" : ""));
  console.log("缺块数分布（缺块数×帧数）: " +
    [...holesHist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([k, v]) => k + "×" + v).join(", "));
  if (chunkMinMaxSamples.length > 0) {
    console.log("有洞帧样本:");
    for (const s of chunkMinMaxSamples) console.log("  " + JSON.stringify(s));
  }
  sock.close();
  process.exitCode = 0;
}, MS);
