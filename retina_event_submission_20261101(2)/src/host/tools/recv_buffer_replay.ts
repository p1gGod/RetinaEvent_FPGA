#!/usr/bin/env node
// recv_buffer_replay —— 「网关 recvBufferSize 提升 → 装配帧率不再因缓冲不足掉帧」的可复现证据工具。
//
// 背景（P0 上板验收报告 §5.4）：同一时刻
//   · 板端线级：29.6~29.7 fps 整帧（独立抓包器，16 MB 接收缓冲，99% 成套）
//   · 网关装配：13~19 fps（默认 4 MB 接收缓冲），`aborted` 一路涨（"帧没凑齐就来了下一帧"）
// 差在 PC 侧：17.8k pps × ~1300 B ≈ 22 MB/s 的突发下，4 MB 只装得下 ~180 ms，
// 事件循环一停（WS 推 768 KB 大帧 / GC）就整块丢包 ⇒ 一帧缺一块 ⇒ 整帧 aborted。
//
// 本工具**全是真跑**（不模型推导）：
//   ① 读真实抓包字节（docs/.../P0上板验收_20261012/raw/sniff_r1.bin）→ 按 v3 头自描述长度切包；
//   ② 用实测参数按**真实线速**（29.7 fps × 600 块 = 17.8k pps ≈ 22 MB/s）回放 UDP 流（负载复用真实字节）；
//   ③ 起**真网关进程**（--udp --recv-buf <MB>），并按现场条件给它一个 WS 客户端（复现"网关同时在推大帧"）；
//   ④ 读 /api/health + /api/stats + WS 计数，打印装配帧率 / aborted / 内核缓冲实测。
//
// 用法（两次对照就是证据）：
//   node --experimental-strip-types tools/recv_buffer_replay.ts --mb 4  --seconds 20
//   node --experimental-strip-types tools/recv_buffer_replay.ts --mb 16 --seconds 20
// 说明：**不碰板子、不碰 COM 口**（只走 127.0.0.1 回环），也不干扰 192.168.1.102:1234 的现场网关。
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { CAPTURE_DEFAULT, LINE_FPS, buildReplay, bufferDepthMs, splitCapture } from "./recv_replay_lib.ts";

const APP = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const valOf = (f: string, d: string): string => {
  const i = argv.indexOf(f);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const has = (f: string): boolean => argv.includes(f);

const CAPTURE = path.resolve(valOf("--capture", CAPTURE_DEFAULT));
const SECONDS = Number(valOf("--seconds", "20"));
const FPS = Number(valOf("--fps", String(LINE_FPS)));
const CHUNKS = Number(valOf("--chunks", "600"));
const MB = Number(valOf("--mb", "16"));
const BIND = valOf("--bind", "127.0.0.1");
const UDP_PORT = Number(valOf("--port", "12341"));
const WS_PORT = Number(valOf("--ws-port", "8799"));
const CLIENT = !has("--no-client");
const JSON_OUT = has("--json");

interface ApiStats {
  readonly stats?: { readonly pps?: number; readonly bytesRaw?: number; readonly bytesEvents?: number };
  readonly counters?: Record<string, number>;
  readonly config?: { readonly recvBufActualMb?: number | null };
}
interface ApiHealth {
  readonly framesSeen?: number;
  readonly latestFrame?: { readonly ageMs?: number };
}

async function getJson<T>(url: string, ms: number): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return (await r.json()) as T;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main(): Promise<void> {
  if (!fs.existsSync(CAPTURE)) {
    console.error("[replay] 找不到抓包文件: " + CAPTURE + "（用 --capture 指定）");
    process.exitCode = 3;
    return;
  }
  const capture = splitCapture(new Uint8Array(fs.readFileSync(CAPTURE)));
  const crcBad = capture.filter((p) => p.crcOk === false).length;
  const replay = buildReplay(capture, SECONDS, CHUNKS, FPS);
  const bytesPerSec = (replay.meta.packets * replay.meta.avgLen) / SECONDS;
  console.log("===== 捕获摘要（真实字节，独立抓包器落盘）=====");
  console.log("文件          : " + CAPTURE + "（" + fs.statSync(CAPTURE).size + " B）");
  console.log("包数          : " + capture.length + "（CRC 独立复算失败 " + crcBad + "）");
  console.log("平均包长      : " + replay.meta.avgLen.toFixed(1) + " B（含事件段混合包 " +
    (replay.meta.evRatio * 100).toFixed(1) + "%）");
  console.log("真实 1280 B 载荷池 : " + replay.meta.rawPool + " 份");
  console.log("TS_US 实测步进 : " + replay.meta.tsStepUs + " µs/包");
  console.log("");
  console.log("===== 回放参数（速率/结构标定：29.7 fps × 600 块）=====");
  console.log("时长 / 帧数   : " + SECONDS + " s / " + replay.meta.totalFrames + " 帧（" + replay.meta.packets + " 包）");
  console.log("目标速率      : " + (replay.meta.packets / SECONDS / 1000).toFixed(2) + "k pps ≈ " +
    (bytesPerSec / 1024 / 1024).toFixed(1) + " MB/s");
  console.log("网关接收缓冲  : --recv-buf " + MB + " MB（可吸收 " +
    bufferDepthMs(MB * 1024 * 1024, bytesPerSec) + " ms 的突发）");
  console.log("");

  // ---- 起真网关（回环口，不碰现场 192.168.1.102:1234）----
  const args = [
    "--experimental-strip-types", path.join("gateway", "src", "main.ts"),
    "--udp", "--bind", BIND, "--port", String(UDP_PORT), "--ws-port", String(WS_PORT),
    "--recv-buf", String(MB), "--serve",
  ];
  const child = spawn(process.execPath, args, { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
  const gwLog: string[] = [];
  child.stdout.on("data", (d) => gwLog.push(String(d)));
  child.stderr.on("data", (d) => gwLog.push(String(d)));
  const base = "http://127.0.0.1:" + WS_PORT;
  const health0 = await getJson<ApiHealth>(base + "/api/health", 25000);
  if (health0 === null) {
    console.error("[replay] 网关未就绪；日志：\n" + gwLog.join(""));
    try { child.kill(); } catch { /* 已退出 */ }
    process.exitCode = 4;
    return;
  }

  // ---- 现场条件：一个 WS 客户端（网关要同时把 768 KB 大帧推出去）----
  const wsCount = { FRAME_RAW: 0, EVENTS: 0, STATS: 0, bytes: 0 };
  let ws: WebSocket | null = null;
  if (CLIENT) {
    ws = new WebSocket("ws://127.0.0.1:" + WS_PORT);
    const TYPE: Readonly<Record<number, keyof typeof wsCount>> = { 1: "FRAME_RAW", 2: "EVENTS", 3: "STATS" };
    ws.on("message", (data: unknown) => {
      const buf = data as Uint8Array;
      const t = TYPE[buf[0] as number];
      if (t !== undefined) wsCount[t]++;
      wsCount.bytes += buf.length;
    });
    await new Promise<void>((r) => { ws?.on("open", () => r()); ws?.on("error", () => r()); });
  }

  // ---- 回放（按真实线速节拍，1 ms 一批）----
  const sock = dgram.createSocket({ type: "udp4", sendBufferSize: 8 * 1024 * 1024 });
  const pps = replay.meta.packets / SECONDS / 1000; // 每 ms 包数
  let cursor = 0;
  let sent = 0;
  const t0 = Date.now();
  const pump = (): void => {
    const elapsed = Date.now() - t0;
    const due = Math.min(replay.meta.packets, Math.floor(elapsed * pps));
    while (cursor < due) {
      const p = replay.pkts[cursor++] as Uint8Array;
      sock.send(p, UDP_PORT, BIND, () => {});
      sent++;
    }
    if (cursor < replay.meta.packets) timer = setTimeout(pump, 1);
  };
  let timer = setTimeout(pump, 0);
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (cursor >= replay.meta.packets) { clearInterval(iv); resolve(); }
    }, 20);
  });
  const sendMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1500)); // 让网关把内核/事件队列里的包消化完

  const health = await getJson<ApiHealth>(base + "/api/health", 5000);
  const stats = await getJson<ApiStats>(base + "/api/stats", 5000);
  clearTimeout(timer);
  try { sock.close(); } catch { /* 已关 */ }
  if (ws !== null) { try { ws.close(); } catch { /* 已关 */ } }
  try { child.kill(); } catch { /* 已退出 */ }

  const framesSeen = Number(health?.framesSeen ?? 0);
  const lineFrames = replay.meta.totalFrames;
  const assembledFps = framesSeen / SECONDS;
  const counters = stats?.counters ?? {};
  const summary = {
    recvBufferMb: MB,
    recvBufActualMb: stats?.config?.recvBufActualMb ?? null,
    client: CLIENT,
    seconds: SECONDS,
    sentPackets: sent,
    sendMs,
    lineFps: FPS,
    lineFrames,
    framesSeen,
    assembledFps: Number(assembledFps.toFixed(2)),
    assembleRatio: Number((framesSeen / lineFrames).toFixed(3)),
    aborted: counters["aborted"] ?? null,
    idxGap: counters["idxGap"] ?? null,
    badMagic: counters["badMagic"] ?? null,
    badLength: counters["badLength"] ?? null,
    crcFail: counters["crcFail"] ?? null,
    bytesPerSec: Math.round(bytesPerSec),
    bufferDepthMs: bufferDepthMs(MB * 1024 * 1024, bytesPerSec),
    ws: wsCount,
  };
  console.log("===== 结果（真网关进程 + 真回环 + 真回放字节）=====");
  console.log("回放发送      : " + sent + " 包 / " + sendMs + " ms（目标 " + SECONDS * 1000 + " ms）");
  console.log("板端线级口径  : " + FPS + " fps × " + SECONDS + " s = " + lineFrames + " 帧（回放流本身就是这个速率）");
  console.log("网关装配      : framesSeen = " + framesSeen + " ⇒ " + assembledFps.toFixed(2) + " fps（装配率 " +
    ((100 * framesSeen) / lineFrames).toFixed(1) + "%）");
  console.log("内核缓冲实测  : 请求 " + MB + " MB / 实际 " + String(summary.recvBufActualMb) + " MB" +
    "（可吸收 " + summary.bufferDepthMs + " ms 突发）");
  console.log("计数器        : aborted=" + summary.aborted + " idxGap=" + summary.idxGap +
    " badMagic=" + summary.badMagic + " badLength=" + summary.badLength + " crcFail=" + summary.crcFail);
  console.log("WS 客户端收到 : FRAME_RAW=" + wsCount.FRAME_RAW + " EVENTS=" + wsCount.EVENTS +
    " STATS=" + wsCount.STATS + "（" + (wsCount.bytes / 1024 / 1024).toFixed(1) + " MB）");
  if (JSON_OUT) console.log("JSON " + JSON.stringify(summary));
  process.exitCode = 0;
}

await main();
