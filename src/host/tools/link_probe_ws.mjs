#!/usr/bin/env node
// link_probe_ws.mjs —— 联板排障用「前端通路探针」：以最小 WS 客户端连网关，按真实 IPC 布局
// （16 B 二进制首部：type u8 @0 / flags u8 @1 / seq u16 BE @2 / frameIdx u32 BE @4 /
//   tArriveMs u32 BE @8 / payloadLen u32 BE @12；见 packages/protocol/src/ipc.ts encodeIpc）
// 统计 FRAME_RAW(1) / EVENTS(2) / STATS(3) / CTRL(4) 条数，作为"装配器 → 推送链"的机器证据。
// 用法: node tools/link_probe_ws.mjs [--ws ws://127.0.0.1:8787] [--ms 12000]
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const URLW = valOf("--ws", "ws://127.0.0.1:8787");
const MS = Number(valOf("--ms", 12000));

const TYPE = { 1: "FRAME_RAW", 2: "EVENTS", 3: "STATS", 4: "CTRL" };
const count = { FRAME_RAW: 0, EVENTS: 0, STATS: 0, CTRL: 0, TEXT: 0, OTHER: 0 };
const bytes = { FRAME_RAW: 0, EVENTS: 0, STATS: 0, CTRL: 0, TEXT: 0, OTHER: 0 };
const samples = [];
const eventSamples = [];
const ctrlSamples = [];
const textSamples = [];
let withBoardTs = 0, synthetic = 0, eventRecs = 0;

const ws = new WebSocket(URLW);
const t0 = Date.now();
ws.on("open", () => console.log("[probe] 已连接 " + URLW + "（窗口 " + MS + " ms）"));
ws.on("error", (e) => console.error("[probe] 错误: " + e.message));
ws.on("message", (data, isBinary) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const looksJson = buf.length > 0 && (buf[0] === 0x7b || buf[0] === 0x5b); // '{' / '['
  if (!isBinary || looksJson) {
    count.TEXT++; bytes.TEXT += buf.length;
    if (textSamples.length < 2) textSamples.push(buf.toString("utf8").slice(0, 300));
    return;
  }
  if (buf.length < 16) { count.OTHER++; return; }
  const type = buf[0], flags = buf[1];
  const seq = buf.readUInt16BE(2), frameIdx = buf.readUInt32BE(4), payloadLen = buf.readUInt32BE(12);
  const name = TYPE[type] ?? "OTHER";
  count[name]++; bytes[name] += buf.length;
  if (name === "FRAME_RAW") {
    const w = buf.readUInt16BE(16), h = buf.readUInt16BE(18), fmt = buf[20], ver = buf[21];
    if (ver >= 1) withBoardTs++;
    if (flags & 0x04) synthetic++;
    if (samples.length < 5) {
      samples.push({ seq, frameIdx, w, h, fmt, layoutVer: ver, flags: "0x" + flags.toString(16).padStart(2, "0"),
        len: buf.length, payloadLen,
        tBoardMs: ver >= 1 ? buf.readDoubleBE(22) : null });
    }
  } else if (name === "EVENTS") {
    const n = buf.readUInt32BE(16), recBytes = buf[20];
    eventRecs += n;
    if (eventSamples.length < 5) eventSamples.push({ seq, frameIdx, count: n, recBytes, flags: "0x" + flags.toString(16).padStart(2, "0"), len: buf.length });
  } else if (name === "CTRL") {
    if (ctrlSamples.length < 4) ctrlSamples.push(buf.subarray(16, 16 + Math.min(payloadLen, 300)).toString("utf8"));
  }
});
ws.on("close", () => console.log("[probe] 连接关闭"));

setTimeout(() => {
  const secs = (Date.now() - t0) / 1000;
  console.log("\n===== 前端通路探针小结（窗口 " + secs.toFixed(1) + " s） =====");
  for (const k of Object.keys(count)) {
    if (count[k] === 0) continue;
    console.log("  " + k.padEnd(10) + " 条数=" + count[k] + "  字节=" + bytes[k] +
      (k === "FRAME_RAW" || k === "EVENTS" ? "  速率=" + (count[k] / secs).toFixed(2) + " 条/s" : ""));
  }
  if (count.FRAME_RAW > 0) {
    console.log("  FRAME_RAW: 带板端时间戳(layoutVer>=1)=" + withBoardTs + "，合成数据(FLAG_SYNTHETIC)=" + synthetic +
      "，累计事件记录=" + eventRecs);
  }
  if (samples.length > 0) { console.log("  FRAME_RAW 样本（原文）:"); for (const s of samples) console.log("    " + JSON.stringify(s)); }
  if (eventSamples.length > 0) { console.log("  EVENTS 样本（原文）:"); for (const s of eventSamples) console.log("    " + JSON.stringify(s)); }
  if (ctrlSamples.length > 0) { console.log("  CTRL 载荷样本:"); for (const s of ctrlSamples) console.log("    " + s); }
  if (textSamples.length > 0) { console.log("  文本消息样本:"); for (const s of textSamples) console.log("    " + s); }
  console.log("判据③ " + (count.FRAME_RAW >= 30 ? "达标" : "未达标") + "：FRAME_RAW 推送 = " + count.FRAME_RAW +
    " 条（要求 ≥ 30）；EVENTS 推送 = " + count.EVENTS + " 条");
  try { ws.close(); } catch { /* 已关 */ }
  process.exitCode = count.FRAME_RAW >= 30 ? 0 : 4;
}, MS);
