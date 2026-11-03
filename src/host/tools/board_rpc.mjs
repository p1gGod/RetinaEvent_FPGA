#!/usr/bin/env node
// board_rpc.mjs —— 经网关的 JSON-RPC 给板端下发 v3 命令 / 取状态（联板排障与下一轮二分实验用）。
// 为什么走网关而不是自己造包：下行 ACK 的解析、SEQ 管理、计数器口径都在网关里，
// 自己造包只能看见"发出去"，看不见"板端回没回"。网关会把结果与 TYPE_CTRL 事件一起给出。
// 用法:
//   node tools/board_rpc.mjs --get-status
//   node tools/board_rpc.mjs --set-param theta=44
//   node tools/board_rpc.mjs --set-param frameDecim=1
//   node tools/board_rpc.mjs --set-mode 1        # 0=RAW+EV 1=仅RAW 2=仅事件
//   node tools/board_rpc.mjs --ev-en 1
//   node tools/board_rpc.mjs --calibrate
//   （可加 --ws ws://127.0.0.1:8787）
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const WS = valOf("--ws", "ws://127.0.0.1:8787");

let method = null, params = {};
if (argv.includes("--get-status")) { method = "board.getStatus"; }
else if (argv.includes("--calibrate")) { method = "board.calibrate"; }
else if (argv.includes("--set-mode")) { method = "board.setMode"; params = { mode: Number(valOf("--set-mode")) }; }
else if (argv.includes("--ev-en")) { method = "board.evEn"; params = { enabled: Number(valOf("--ev-en")) !== 0 }; }
else if (argv.includes("--set-param")) {
  method = "board.setParam";
  for (const kv of argv.slice(argv.indexOf("--set-param") + 1)) {
    if (kv.startsWith("--")) break;
    const [k, v] = kv.split("=");
    if (k !== undefined && v !== undefined) params[k] = Number(v);
  }
}
if (method === null) {
  console.error("用法: node tools/board_rpc.mjs [--ws url] (--get-status | --calibrate | --set-mode N | --ev-en 0/1 | --set-param k=v ...)");
  process.exit(2);
}

const t0 = Date.now();
const ws = new WebSocket(WS);
let done = false;
ws.on("open", () => {
  console.log("[rpc] → " + method + " " + JSON.stringify(params));
  ws.send(JSON.stringify({ id: 1, method, params }));
});
ws.on("error", (e) => { console.log("[rpc] 错误: " + e.message); process.exit(3); });
ws.on("message", (d) => {
  const s = d.toString();
  if (!s.startsWith("{")) return;
  let j;
  try { j = JSON.parse(s); } catch { return; }
  if (j.method !== undefined) return;                      // 推送（session.hello / 日志）
  if (j.id !== 1 || done) return;
  done = true;
  console.log("[rpc] ← " + (Date.now() - t0) + " ms: " + JSON.stringify(j.result));
  ws.close();
  setTimeout(() => process.exit(j.result?.ok === true ? 0 : 4), 150);
});
setTimeout(() => { if (!done) { console.log("[rpc] " + ((Date.now() - t0) / 1000).toFixed(1) + " s 内无 RPC 回复（板端未 ACK ⇒ 上行控制通路不可用）"); process.exit(4); } }, 8000);
