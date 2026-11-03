#!/usr/bin/env node
// prefix_hist.mjs —— 全量统计 UDP 1234 上每个包的"前 6 字节"分布（不预设魔数），
// 用于排除"我的 CTRL 过滤条件太窄"这一可能：如果板端真的发了 CTRL 包（心跳/ACK），
// 必然在这里以某个前缀出现。用法: node tools/prefix_hist.mjs [--ms 12000]
import dgram from "node:dgram";
const argv = process.argv.slice(2);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const MS = Number(valOf("--ms", 12000));
const sock = dgram.createSocket({ type: "udp4", reuseAddr: true, recvBufferSize: 8 * 1024 * 1024 });
const hist = new Map();
let total = 0, lenSum = 0;
let f05aa5AnyTailByte = new Map();     // 前三字节 F0 5A A5 时第 4 字节的分布
let ctrlFlagAnyMagic = 0;              // 任何包：如果长度≥24 且 b[6]&0x80
sock.on("message", (msg) => {
  total++; lenSum += msg.length;
  const p = msg.subarray(0, 6).toString("hex");
  hist.set(p, (hist.get(p) ?? 0) + 1);
  if (msg.length >= 4 && msg[0] === 0xf0 && msg[1] === 0x5a && msg[2] === 0xa5) {
    f05aa5AnyTailByte.set(msg[3], (f05aa5AnyTailByte.get(msg[3]) ?? 0) + 1);
  }
  if (msg.length >= 7 && (msg[6] & 0x80) !== 0) ctrlFlagAnyMagic++;
});
sock.bind(1234, "192.168.1.102");
setTimeout(() => {
  console.log("总包数 = " + total + "，平均包长 = " + (total > 0 ? (lenSum / total).toFixed(1) : "-"));
  console.log("前 6 字节前缀 TOP10:");
  for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log("  " + k + " × " + v);
  }
  console.log("前三字节 F0 5A A5 时，第 4 字节分布: " +
    ([...f05aa5AnyTailByte.entries()].map(([k, v]) => "0x" + k.toString(16).padStart(2, "0") + "×" + v).join(", ") || "（无）"));
  console.log("全量里 b[6]&0x80（CTRL 位）= " + ctrlFlagAnyMagic + " 个");
  sock.close();
  process.exitCode = 0;
}, MS);
