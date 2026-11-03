#!/usr/bin/env node
// record_events.mjs —— 长录事件流工具（绕开网页 Recorder 600 帧上限）
//
// 直接绑定板卡上行 UDP 端口（默认 192.168.1.102:1234），用 @retina/protocol 的 v3 解析器
// 解出事件，按**与网页导出一致的 8 列 CSV**（host/app/web/src/export/csv.ts 为唯一权威，
// 行尾 CRLF）连续写盘 N 秒后正常退出。全程不依赖浏览器与网关，也不需要 Vite。
//
// 用法：
//   node --experimental-strip-types tools/record_events.mjs \
//     --seconds 5 --bind 192.168.1.102 --port 1234 --out /tmp/rec.csv
//
// 退出码：
//   0 = 正常录制完成；2 = 参数错误；3 = 绑定失败（地址/端口）；4 = 超时未收到任何上行包
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { decodeEvents, getProfile, hasV3Magic, parseV3Packet } from "@retina/protocol";

/** 与 web/src/export/csv.ts 逐字节一致的表头（列顺序是契约，禁止重排） */
export const HEADER = "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts";
export const CRLF = "\r\n";
export const DEFAULT_BIND = "192.168.1.102";
export const DEFAULT_PORT = 1234;
export const DEFAULT_SECONDS = 10;
export const DEFAULT_PROFILE = "retina-v2-800x480-1280";
export const EV_GRID = { w: 400, h: 240 };

const USAGE = [
  "用法: node --experimental-strip-types tools/record_events.mjs [选项]",
  "  --seconds <N>   录制时长，秒（默认 10，范围 0.1~3600）",
  "  --bind <ipv4>   绑定地址（默认 192.168.1.102，必须是本机 IPv4）",
  "  --port <n>      绑定端口（默认 1234）",
  "  --out <path>    输出 CSV 路径（必填；父目录不存在会自动创建）",
  "  --profile <名>  协议 profile 名（默认 retina-v2-800x480-1280；v3 包自描述 evRecBytes）",
  "  --idle-ms <n>   首包等待上限毫秒（默认 min(8000, 时长)，超时以退出码 4 结束）",
  "  --help          打印本帮助",
].join("\n");

/** 参数错误（调用方统一按退出码 2 处理） */
export class ArgsError extends Error {}

function numberArg(raw, name, min, max) {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ArgsError("参数 " + name + " 不是数字：" + String(raw));
  if (v < min || v > max) throw new ArgsError("参数 " + name + " 超出范围 " + min + "~" + max + "：" + String(raw));
  return v;
}

/** 解析命令行 → 结构化的录制选项（纯函数，便于单测；--help 时返回 help=true） */
export function parseRecordArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const valOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = valOf("--out");
  if (out === undefined || out === "" || out.startsWith("--")) throw new ArgsError("缺少必填参数 --out <path>");
  const seconds = valOf("--seconds") === undefined ? DEFAULT_SECONDS : numberArg(valOf("--seconds"), "--seconds", 0.1, 3600);
  const port = valOf("--port") === undefined ? DEFAULT_PORT : numberArg(valOf("--port"), "--port", 1, 65535);
  if (!Number.isInteger(port)) throw new ArgsError("参数 --port 必须是整数：" + String(valOf("--port")));
  const bind = valOf("--bind") ?? DEFAULT_BIND;
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(bind)) throw new ArgsError("参数 --bind 不是点分十进制 IPv4：" + bind);
  const profileName = valOf("--profile") ?? DEFAULT_PROFILE;
  const profile = getProfile(profileName);
  if (profile === null) throw new ArgsError("未知 profile：" + profileName);
  const idleMs = valOf("--idle-ms") === undefined
    ? Math.min(8000, Math.max(1000, Math.round(seconds * 1000)))
    : numberArg(valOf("--idle-ms"), "--idle-ms", 100, 600000);
  return { help: false, bind, port, seconds, out, profileName, profile, idleMs };
}

/** 单条事件行（格式与 web buildEventsCsv 完全一致） */
export function eventRow(frameIdx, tMs, ev) {
  return frameIdx + "," + tMs + "," + ev.x + "," + ev.y + "," + ev.pol + "," + (ev.pol === 1 ? "ON" : "OFF") + "," + ev.flags + "," + ev.ts;
}

/**
 * 帧列表 → CSV 文本（含表头与末尾 CRLF）。
 * 与 web/src/export/csv.ts 的 buildEventsCsv 保持逐字节一致：没有事件时也输出表头。
 */
export function buildEventsCsv(frames) {
  const lines = [HEADER];
  for (const f of frames) {
    for (const ev of f.events) lines.push(eventRow(f.frameIdx, f.tMs, ev));
  }
  return lines.join(CRLF) + CRLF;
}

/** frame_t_ms 取值：优先板端 µs 时间戳（tsValid），否则用到达时刻；调用方再保证单调不减 */
export function packetTimeMs(pkt, arrivalMs) {
  if (pkt !== null && pkt.tsUs !== null && Number.isFinite(pkt.tsUs) && pkt.tsUs >= 0) {
    return Math.floor(pkt.tsUs / 1000);
  }
  return Math.floor(arrivalMs);
}

/**
 * 解一个上行 UDP 包 → { frameIdx, tMs, records }；非 v3 / 控制包 / 坏包返回 null。
 * 事件记录布局用协议层 decodeEvents（byte-aligned，02 文档 §2.4）。
 */
export function decodeUplinkPacket(buf, profile, arrivalMs = Date.now()) {
  if (!(buf instanceof Uint8Array) || !hasV3Magic(buf)) return null;
  const r = parseV3Packet(buf, { profile });
  if (!r.ok) return { error: r.reason, detail: r.detail };
  const pkt = r.value;
  if (pkt.ctrl || !pkt.hasEvents || pkt.events === null) return null;
  const recBytes = pkt.evRecBytes > 0 ? pkt.evRecBytes : profile.evRecBytes;
  const decoded = decodeEvents(pkt.events, recBytes, "byte-aligned");
  return { frameIdx: pkt.frameIdx, tMs: packetTimeMs(pkt, arrivalMs), records: decoded.records, partialBytes: decoded.partialBytes };
}

/** 过滤非法坐标/极性（x∈[0,400)、y∈[0,240)、pol∈{0,1}），返回 { kept, dropped } */
export function filterValidRecords(records) {
  const kept = [];
  let dropped = 0;
  for (const ev of records) {
    const ok = Number.isInteger(ev.x) && ev.x >= 0 && ev.x < EV_GRID.w &&
      Number.isInteger(ev.y) && ev.y >= 0 && ev.y < EV_GRID.h && (ev.pol === 0 || ev.pol === 1);
    if (ok) kept.push(ev); else dropped++;
  }
  return { kept, dropped };
}

/**
 * 单调时间轴：收到新帧时间戳 t 时返回 max(last, t)。
 * 板端 48 bit µs 计数在长时间录像里是单调的，但校准/epoch 重置后可能回退；CSV 判据要求
 * frame_t_ms 单调不减，所以这里夹住（只影响回退的那些包，不影响正常路径的时间）。
 */
export function advanceFrameTime(state, t) {
  const tMs = t > state.lastTMs ? t : state.lastTMs;
  state.lastTMs = tMs;
  return tMs;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function defaultOutPath() {
  const d = new Date();
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  return path.resolve(process.cwd(), "events-" + stamp + ".csv");
}

function fmtRate(events, ms) {
  if (ms <= 0) return "0";
  return (events * 1000 / ms).toFixed(1);
}

/**
 * 执行录制。返回 { exitCode, rows, bytes, packets, durationMs, out }。
 * 依赖注入点：opts.socketFactory 供单测替换（默认 dgram.createSocket）。
 */
export async function runRecord(opts, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(s + "\n"));
  const errLog = deps.errLog ?? ((s) => process.stderr.write(s + "\n"));
  const socketFactory = deps.socketFactory ?? ((o) => dgram.createSocket(o));
  const now = deps.now ?? (() => Date.now());
  const clock = deps.setTimeout ?? setTimeout;
  const clear = deps.clearTimeout ?? clearTimeout;

  const out = path.resolve(opts.out ?? defaultOutPath());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, "w");
  let bytes = fs.writeSync(fd, HEADER + CRLF);
  const state = { lastTMs: 0 };
  let rows = 0;
  let packets = 0;       // 有效事件包
  let totalPackets = 0;  // 所有收到的 UDP 包
  let badPackets = 0;
  let ctrlPackets = 0;
  let droppedCoords = 0;
  let parseErrors = 0;
  const startedAt = now();
  let finished = false;
  let sock = null;
  let idleTimer = null;
  let stopTimer = null;

  const finish = (exitCode, reason) => {
    if (finished) return;
    finished = true;
    if (idleTimer !== null) clear(idleTimer);
    if (stopTimer !== null) clear(stopTimer);
    const durationMs = Math.max(0, now() - startedAt);
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持 fsync，忽略 */ }
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    const done = () => {
      log("[record] 结束(" + reason + "): 包=" + packets + "/" + totalPackets + " 事件行=" + rows + " 文件字节=" + bytes +
        " 时长=" + durationMs + "ms 速率=" + fmtRate(rows, durationMs) + " 行/s" +
        (droppedCoords > 0 ? " 丢弃非法坐标=" + droppedCoords : "") +
        (parseErrors > 0 ? " 坏包/解析失败=" + parseErrors : ""));
      log("RECORDER_DONE rows=" + rows + " bytes=" + bytes + " packets=" + packets + " bad_packets=" + parseErrors +
        " ctrl_packets=" + ctrlPackets + " duration_ms=" + durationMs + " ev_per_s=" + fmtRate(rows, durationMs) +
        " seconds=" + opts.seconds + " out=" + out + " exit=" + exitCode);
      if (exitCode !== 0 || rows === 0) errLog("[record] 未取得有效事件行（检查烧录/端口/绑定地址/theta 配置）");
    };
    if (sock !== null) {
      try { sock.close(() => done()); } catch { done(); }
    } else {
      done();
    }
    return exitCode;
  };

  const onPacket = (msg) => {
    if (finished) return;
    totalPackets++;
    const buf = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
    if (!hasV3Magic(buf)) { parseErrors++; return; }
    const parsed = decodeUplinkPacket(buf, opts.profile, now());
    if (parsed === null) { ctrlPackets++; return; }   // 控制包（ACK/心跳）不算坏包
    if (parsed.error !== undefined) { parseErrors++; return; }
    packets++;
    const tMs = advanceFrameTime(state, parsed.tMs);
    const { kept, dropped } = filterValidRecords(parsed.records);
    droppedCoords += dropped;
    if (kept.length === 0) return;
    const lines = [];
    for (const ev of kept) lines.push(eventRow(parsed.frameIdx, tMs, ev));
    const chunk = lines.join(CRLF) + CRLF;
    bytes += fs.writeSync(fd, chunk);
    rows += kept.length;
    if (idleTimer !== null) { clear(idleTimer); idleTimer = null; }
  };

  return await new Promise((resolve, reject) => {
    sock = socketFactory({ type: "udp4", recvBufferSize: 8 * 1024 * 1024 });
    sock.on("message", onPacket);
    sock.on("error", (e) => {
      errLog("[record] socket 错误: " + (e && e.code ? e.code + " " : "") + (e && e.message ? e.message : String(e)));
      finished = true;
      if (idleTimer !== null) clear(idleTimer);
      if (stopTimer !== null) clear(stopTimer);
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { sock.close(); } catch { /* ignore */ }
      reject(e);
    });
    sock.on("listening", () => {
      const addr = sock.address();
      log("[record] 已绑定 " + String(opts.bind) + ":" + addr.port + " → " + out + "（计划 " + opts.seconds + " s，profile=" + opts.profile.name + "）");
      stopTimer = clock(() => {
        const code = finish(0, "到时");
        resolve({ exitCode: code, rows, bytes, packets, totalPackets, badPackets: parseErrors, droppedCoords, durationMs: Math.max(0, now() - startedAt), out });
      }, Math.round(opts.seconds * 1000));
      idleTimer = clock(() => {
        if (packets > 0 || finished) return;
        errLog("[record] 在 " + opts.idleMs + " ms 内没有收到任何 v3 事件包（板端未推流 / --bind 非本机地址 / 端口被占用 / 板端 PC_IP 不匹配）");
        const code = finish(4, "首包超时");
        resolve({ exitCode: code, rows, bytes, packets, totalPackets, badPackets: parseErrors, droppedCoords, durationMs: Math.max(0, now() - startedAt), out });
      }, opts.idleMs);
    });
    sock.bind(opts.port, opts.bind);
  });
}

/** CLI 入口；返回退出码（不直接 process.exit，便于单测） */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const errLog = deps.errLog ?? ((s) => process.stderr.write(s + "\n"));
  const log = deps.log ?? ((s) => process.stdout.write(s + "\n"));
  let opts;
  try {
    opts = parseRecordArgs(argv);
  } catch (e) {
    errLog("[record] 参数错误：" + (e instanceof Error ? e.message : String(e)));
    errLog(USAGE);
    return 2;
  }
  if (opts.help) { log(USAGE); return 0; }
  try {
    const r = await runRecord(opts, deps);
    return r.exitCode;
  } catch (e) {
    const code = e && typeof e.code === "string" ? e.code : "";
    errLog("[record] 录制失败" + (code ? "（socket code=" + code + "）" : "") + "：" + (e instanceof Error ? e.message : String(e)));
    if (code === "EADDRNOTAVAIL" || code === "EACCES" || code === "EADDRINUSE") {
      errLog("[record] 提示：--bind 必须是本机 IPv4（127.0.0.1 也可），端口不能被其它进程占用");
    }
    return 3;
  }
}

// 只在被直接执行时跑 CLI；被测试 import 时不产生副作用
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("/tools/record_events.mjs");
if (isEntry) {
  void main().then((code) => { process.exitCode = code; });
}
