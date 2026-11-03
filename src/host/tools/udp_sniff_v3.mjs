#!/usr/bin/env node
// udp_sniff_v3.mjs —— 联板排障用「裸 UDP 抓包器」（独立实现，不复用被测代码）
// 目的：拿到板端发出的原始字节，判定魔数 / 头长 / 长度自洽 / CRC16（独立算一遍 CCITT-FALSE）。
// 用法: node tools/udp_sniff_v3.mjs [--bind 192.168.1.102] [--port 1234] [--n 40] [--ms 12000] [--dump out.bin]
// 说明：Windows 下多个 socket 同址同端口需 SO_REUSEADDR；本脚本后绑定，便于与旧进程并存取证。
import dgram from "node:dgram";
import fs from "node:fs";

const argv = process.argv.slice(2);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const BIND = valOf("--bind", "192.168.1.102");
const PORT = Number(valOf("--port", 1234));
const MAXN = Number(valOf("--n", 40));
const MS = Number(valOf("--ms", 12000));
const DUMP = valOf("--dump", null);

/** CRC-16/CCITT-FALSE（poly 0x1021 / init 0xFFFF / 不反转 / 不异或）—— 独立实现，用于交叉验证 */
function crc16ccitt(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const be16 = (b, o) => (b[o] << 8) | b[o + 1];

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true, recvBufferSize: 8 * 1024 * 1024 });
let n = 0, total = 0, bytes = 0;
const dumps = [];
const bySrc = new Map();
const magicCount = new Map();
const modeCount = new Map();
const opcodeCount = new Map();
let ctrlN = 0, ctrlBytes = 0;
let crcOk = 0, crcBad = 0, lenOk = 0, lenBad = 0;
const firstSamples = [];

sock.on("message", (msg, rinfo) => {
  total++; bytes += msg.length;
  const key = rinfo.address + ":" + rinfo.port;
  bySrc.set(key, (bySrc.get(key) ?? 0) + 1);
  if (DUMP !== null && dumps.length < 400) dumps.push(Buffer.from(msg));
  const b = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
  // 全量统计（不受"只打印前 N 包"影响）：CTRL 包数量 + 控制 OPCODE 分布
  const isV3 = b.length >= 24 && b[0] === 0xf0 && b[1] === 0x5a && b[2] === 0xa5 && b[3] === 0x30;
  if (isV3) {
    const fl = b[6];
    if ((fl & 0x80) !== 0) {
      const hdrLen = b[5];
      const op = b[hdrLen];
      ctrlN++; ctrlBytes += msg.length;
      opcodeCount.set(op, (opcodeCount.get(op) ?? 0) + 1);
    }
  }
  if (n >= MAXN) return;
  n++;
  const magic = hex(b.subarray(0, 4));
  magicCount.set(magic, (magicCount.get(magic) ?? 0) + 1);
  const line = [];
  line.push("#" + n + " len=" + msg.length + " from=" + key + " magic=" + magic);
  if (magic === "f05aa530" && msg.length >= 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ver = b[4], hdrLen = b[5], flags = b[6], mode = b[7];
    const chunkIdx = dv.getUint16(8), frameIdx = dv.getUint16(10);
    const rawLen = dv.getUint16(12), evLen = dv.getUint16(14);
    const tsUs = b[16] * 2 ** 40 + b[17] * 2 ** 32 + b[18] * 2 ** 24 + b[19] * 2 ** 16 + b[20] * 2 ** 8 + b[21];
    const evRec = b[22];
    const crcPresent = (flags & 0x04) !== 0;
    const isCtrl = (flags & 0x80) !== 0;
    modeCount.set(mode, (modeCount.get(mode) ?? 0) + 1);
    const bodyLen = hdrLen + (isCtrl ? 6 + be16(b, hdrLen + 4) : rawLen + evLen);
    const expectLen = bodyLen + (crcPresent ? 2 : 0);
    if (expectLen === msg.length) lenOk++; else lenBad++;
    line.push("  VER=" + ver + " HDR_LEN=" + hdrLen + " FLAGS=0x" + flags.toString(16).padStart(2, "0") +
      "(RAW=" + (flags & 1) + " EV=" + ((flags >> 1) & 1) + " CRC=" + ((flags >> 2) & 1) +
      " TSV=" + ((flags >> 3) & 1) + " TSC=" + ((flags >> 4) & 1) + " FST=" + ((flags >> 5) & 1) + " LST=" + ((flags >> 6) & 1) + " CTRL=" + ((flags >> 7) & 1) + ")");
    line.push("  MODE=" + mode + " CHUNK=" + chunkIdx + " FRAME=" + frameIdx + " RAW_LEN=" + rawLen +
      " EV_LEN=" + evLen + " EV_REC=" + evRec + " TS_US=" + tsUs);
    line.push("  长度自洽: 期望 " + expectLen + " 实得 " + msg.length + " ⇒ " + (expectLen === msg.length ? "OK" : "★不一致"));
    if (isCtrl) {
      const opcode = b[hdrLen], status = b[hdrLen + 1], seq = be16(b, hdrLen + 2), ctrlLen = be16(b, hdrLen + 4);
      line.push("  ★CTRL: OPCODE=0x" + opcode.toString(16) + " STATUS=" + status + " SEQ=" + seq + " CTRL_LEN=" + ctrlLen +
        " 载荷前 32 B=" + hex(b.subarray(hdrLen + 6, hdrLen + 6 + Math.min(ctrlLen, 32))));
    }
    if (crcPresent) {
      const want = be16(b, bodyLen);
      const got = crc16ccitt(b.subarray(0, bodyLen));
      const ok = want === got;
      if (ok) crcOk++; else crcBad++;
      line.push("  CRC16(CCITT-FALSE) 覆盖 [0.." + bodyLen + ") 期望 0x" + want.toString(16).padStart(4, "0") +
        " 独立算得 0x" + got.toString(16).padStart(4, "0") + " ⇒ " + (ok ? "OK" : "★不一致"));
    }
    if (firstSamples.length < 4) {
      firstSamples.push({ n, frameIdx, chunkIdx, rawLen, evLen, mode, flags,
        head: hex(b.subarray(0, 24)), tail: hex(b.subarray(msg.length - 4)) });
    }
  } else {
    line.push("  （非 v3 上行魔数；前 16 B = " + hex(b.subarray(0, 16)) + "）");
  }
  console.log(line.join("\n"));
});

sock.on("error", (e) => { console.error("[sniff] socket 错误: " + e.message); });
sock.on("listening", () => {
  console.log("[sniff] 已绑定 " + BIND + ":" + PORT + "（reuseAddr；窗口 " + MS + " ms，最多打印 " + MAXN + " 包）");
  if (argv.includes("--send-downlink")) {
    // 独立造下行包（不复用被测代码）：MAGIC_D(4) VER(1) OPCODE(1) SEQ(2BE) LEN(2BE) payload CRC16(2BE)
    const mk = (opcode, seq, payload) => {
      const out = Buffer.alloc(10 + payload.length + 2);
      out.set([0xf0, 0x5a, 0xa5, 0x31], 0);
      out[4] = 0x03;
      out[5] = opcode;
      out.writeUInt16BE(seq, 6);
      out.writeUInt16BE(payload.length, 8);
      payload.copy(out, 10);
      out.writeUInt16BE(crc16ccitt(out.subarray(0, 10 + payload.length)), 10 + payload.length);
      return out;
    };
    const ts = Buffer.alloc(9);
    const v = Date.now() % 2 ** 48;
    ts[0] = Math.floor(v / 2 ** 40) & 0xff;
    ts[1] = Math.floor(v / 2 ** 32) & 0xff;
    ts.writeUInt32BE(Math.floor(v % 2 ** 32), 2);
    ts.writeUInt16BE(0, 6);
    ts[8] = 0;
    sock.send(mk(0x04, 1, Buffer.alloc(0)), 1235, "192.168.1.10");
    sock.send(mk(0x03, 2, ts), 1235, "192.168.1.10");
    console.log("[sniff] 已发下行 GET_STATUS(0x04 seq=1) + TIME_SYNC(0x03 seq=2) → 192.168.1.10:1235，等板端 ACK…");
  }
});
sock.bind(PORT, BIND);

setTimeout(() => {
  console.log("\n===== 抓包小结 =====");
  console.log("总包数 = " + total + "，总字节 = " + bytes + "，平均包长 = " + (total > 0 ? (bytes / total).toFixed(1) : "-"));
  console.log("来源: " + [...bySrc.entries()].map(([k, v]) => k + " ×" + v).join(", "));
  console.log("魔数: " + [...magicCount.entries()].map(([k, v]) => k + " ×" + v).join(", "));
  console.log("MODE 分布: " + [...modeCount.entries()].map(([k, v]) => k + " ×" + v).join(", "));
  console.log("长度自洽: OK " + lenOk + " / 不一致 " + lenBad + "（仅统计前 " + n + " 包）");
  console.log("CRC16:    OK " + crcOk + " / 不一致 " + crcBad + "（仅统计前 " + n + " 包）");
  console.log("CTRL(上行控制/ACK/心跳) 包 = " + ctrlN + " 个 / " + ctrlBytes + " B；OPCODE 分布: " +
    ([...opcodeCount.entries()].map(([k, v]) => "0x" + k.toString(16) + "×" + v).join(", ") || "（无）"));
  if (firstSamples.length > 0) {
    console.log("样本（前 " + firstSamples.length + " 包）:");
    for (const s of firstSamples) console.log("  " + JSON.stringify(s));
  }
  if (DUMP !== null && dumps.length > 0) {
    fs.writeFileSync(DUMP, Buffer.concat(dumps));
    console.log("原始字节已落盘: " + DUMP + "（" + dumps.length + " 包 / " + fs.statSync(DUMP).size + " B）");
  }
  sock.close();
  process.exitCode = total > 0 ? 0 : 3;
}, MS);
