#!/usr/bin/env node
// uart_accept_snapshot.mjs —— UART 位流上板验收的「烧前 / 烧后」只读取证快照。
//
// 设计原则：
//   * 只读 —— 不烧录、不下载、不发 v3 命令（WS 只调 board.getStatus 读状态；
//     串口只做 SerialPort.list()，--probe-open 时最多试开 300 ms 再立刻关闭）；
//   * 同口径 —— pre/post 两次抓同一批字段，便于事后 diff 计数器与接缝；
//   * 留档 —— 写到 docs/05_experiments/UART位流_20261017/记录/ 下带时间戳的 json + md。
//
// 用法（在 host/app 下跑，依赖 host/app/node_modules 的 ws / serialport）：
//   node tools/uart_accept_snapshot.mjs --phase pre  --label "before-B"
//   node tools/uart_accept_snapshot.mjs --phase post --label "after-B"
//   node tools/uart_accept_snapshot.mjs --phase post --label "after-rollback" --no-jtag
// 开关：
//   --no-jtag      跳过 Vivado JTAG 探测（默认会跑，视 hw_server 状态约 10~40 s，只读 open_hw_target）
//   --probe-open   试开 COM6 200 ms 判断是否被占（默认关闭，避免打扰板子/网关）
//   --out <dir>    改记录目录（默认 docs/05_experiments/UART位流_20261017/记录）
//   --ws <url>     WS 地址（默认 ws://127.0.0.1:8787）
// 机器可读输出标记（便于 diff）：
//   SNAP_JSON= SNAP_MD= SNAP_BIT_A_MD5= SNAP_BIT_B_MD5= SNAP_JTAG_DONE= SNAP_JTAG_EOS=
//   SNAP_JTAG_GWE= SNAP_JTAG_CONFIGURED= SNAP_COM6_PRESENT= SNAP_GATEWAY_PID= SNAP_RESULT=
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));      // ...\host\app\tools
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");        // ...\FPGA_Comp
const DOC_DIR = path.join(REPO_ROOT, "docs", "05_实验与实测", "UART位流_20261017");
const DEFAULT_OUT = path.join(DOC_DIR, "记录");

const VIVADO = "E:\\Programs\\Xilinx\\Vivado\\2020.2\\bin\\vivado.bat";
const JTAG_TCL = "E:\\Tools\\FPGABuilder_AMD\\scripts\\jtag_detect.tcl";
const JTAG_CWD = "E:\\Tools\\FPGABuilder_AMD";

const BITS = [
  { key: "A", label: "variant_uart (仅串口)", rel: "build/variant_uart/retina_event.bit" },
  { key: "B", label: "variant_fix_uart (串口+相位修复，推荐)", rel: "build/variant_fix_uart/retina_event.bit" },
  { key: "DELIVERED", label: "delivered (现役交付版/回滚目标)", rel: "build/retina_event.bit" },
];

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const phase = String(argOf("--phase", "pre")).toLowerCase();
const label = argOf("--label", "");
const wsUrl = argOf("--ws", "ws://127.0.0.1:8787");
const outDir = path.resolve(argOf("--out", DEFAULT_OUT));
const skipJtag = argv.includes("--no-jtag");
const probeOpen = argv.includes("--probe-open");

const errors = [];
const t0 = Date.now();
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const tsLocal = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const isoNow = now.toISOString();

function md5File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5");
    const s = fs.createReadStream(p);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function bitsInfo() {
  const out = [];
  for (const b of BITS) {
    const abs = path.join(REPO_ROOT, b.rel);
    const rec = { key: b.key, label: b.label, rel: b.rel, path: abs, exists: fs.existsSync(abs) };
    try {
      if (rec.exists) {
        const st = fs.statSync(abs);
        rec.size = st.size;
        rec.mtime = st.mtime.toISOString();
        rec.md5 = await md5File(abs);
      }
    } catch (e) { rec.error = String(e && e.message || e); }
    out.push(rec);
  }
  return out;
}

async function httpGet(p, timeoutMs = 4000) {
  const url = `http://127.0.0.1:8787${p}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 原样留 */ }
    return { ok: r.ok, status: r.status, json, text: json ? undefined : text.slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function rpcGetStatus(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const finish = (v) => { if (!settled) { settled = true; try { ws && ws.close(); } catch { /* noop */ } resolve(v); } };
    try {
      // 动态 import 以便拿不到 ws 时降级成 error（不影响其它段）
      const { WebSocket } = require_ws();
      ws = new WebSocket(url);
      ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "board.getStatus", params: {} })));
      ws.on("error", (e) => finish({ ok: false, error: String(e && e.message || e) }));
      ws.on("message", (d) => {
        const s = d.toString();
        if (!s.startsWith("{")) return;
        let j; try { j = JSON.parse(s); } catch { return; }
        if (j.method !== undefined || j.id !== 1) return;
        finish({ ok: true, result: j.result, error: j.error ?? null });
      });
      setTimeout(() => finish({ ok: false, error: `${timeoutMs} ms 内无 RPC 回复` }), timeoutMs);
    } catch (e) { finish({ ok: false, error: String(e && e.message || e) }); }
  });
}
// require_ws 的薄封装：ESM 里可直接用静态 import；保留此函数是为了错误信息可读
let __WebSocket = null;
function require_ws() {
  if (!__WebSocket) throw new Error("ws 模块不可用（应存在于 host/app/node_modules）");
  return { WebSocket: __WebSocket };
}
try {
  const mod = await import("ws");
  __WebSocket = mod.WebSocket || mod.default;
} catch (e) { errors.push("import ws 失败: " + String(e && e.message || e)); }

function listPorts() {
  return new Promise(async (resolve) => {
    try {
      const { SerialPort } = await import("serialport");
      const ports = await SerialPort.list();
      resolve({ ok: true, ports: ports.map((p) => ({
        path: p.path, manufacturer: p.manufacturer, serialNumber: p.serialNumber,
        vendorId: p.vendorId, productId: p.productId,
      })) });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

function probeCom6() {
  return new Promise(async (resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const { SerialPort } = await import("serialport");
      const p = new SerialPort({
        path: "COM6", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", autoOpen: false,
        dtr: false, rts: false,   // 不扰动板子（不碰 DTR/RTS）
      });
      p.open((err) => {
        if (err) return finish({ ok: true, busy: true, error: String(err.message || err) });
        setTimeout(() => {
          try { p.close(); } catch { /* noop */ }
          finish({ ok: true, busy: false, note: "试开成功并已关闭（dtr/rts 保持低）⇒ 当前没人独占 COM6" });
        }, 200);
      });
    } catch (e) { finish({ ok: false, error: String(e && e.message || e) }); }
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { timeoutMs = 60000, cwd = REPO_ROOT, shell = false } = opts;
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, shell, ...(opts.spawnOpts || {}) });
    } catch (e) {
      return resolve({ ok: false, error: String(e && e.message || e), chunks: [] });
    }
    const chunks = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, timeoutMs);
    child.stdout && child.stdout.on("data", (d) => chunks.push(d));
    child.stderr && child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message || e), chunks }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: true, code, chunks }); });
  });
}

function decodeJtag(buf) {
  // 同一台机器上 Vivado 的输出编码会变（GUI 管道有时 UTF-8、有时 GBK）。
  // 先按严格 UTF-8 试解，失败再退 GB18030，最后兜底 latin1；标记本身都是 ASCII，不影响解析。
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* 非 UTF-8 */ }
  try { return new TextDecoder("gb18030", { fatal: false }).decode(buf); } catch { /* 无该解码器 */ }
  return buf.toString("latin1");
}

function parseJtag(buf) {
  const s = decodeJtag(buf);
  // Vivado batch 会把 -source 的 Tcl 脚本逐行回显（以 "# " 开头），
  // 所以只能认"行首"标记，避免抓到回显里的 "JTAG_DEV: ... $__done"。
  const line = (prefix) => {
    const m = s.match(new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.*)$", "m"));
    return m ? m[1].trim() : null;
  };
  const dev = line("JTAG_DEV:");
  const kv = (k) => { if (!dev) return null; const m = dev.match(new RegExp(k + "=([^\\s]+)")); return m ? m[1] : null; };
  const ascii = (s) => (s ? s.replace(/[^\x20-\x7e]+/g, " ").trim() : null);
  const cfgRaw = line("JTAG_CONFIGURED:");
  const resRaw = line("JTAG_RESULT:");
  return {
    target: line("JTAG_TARGETS:"),
    devlist: line("JTAG_DEVLIST:"),
    devLine: ascii(dev),
    part: kv("PART"), idcode: kv("IDCODE"),
    done: kv("DONE"), doneInternal: kv("DONE_INTERNAL"),
    eos: kv("EOS"), gwe: kv("GWE"),
    configured: cfgRaw ? ((cfgRaw.match(/^(YES|NO|UNKNOWN)/) || [null, ascii(cfgRaw)])[1]) : null,
    result: resRaw ? ascii(resRaw) : null,
  };
}

function parseNetstat(buf) {
  const s = buf.toString("latin1");
  const want = [];
  for (const line of s.split(/\r?\n/)) {
    if (/:1234\b/.test(line) || /:8787\b/.test(line)) want.push(line.trim().replace(/\s+/g, " "));
  }
  return want;
}

const snap = {
  meta: {
    tool: "uart_accept_snapshot.mjs",
    phase, label, isoTime: isoNow, localTime: tsLocal,
    repoRoot: REPO_ROOT, wsUrl, node: process.version,
    note: "只读取证；不含烧录/下载动作；COM6 仅在 --probe-open 时试开 300 ms",
  },
  bits: null, http: {}, rpc: {}, serial: {}, jtag: {}, ports: {}, errors,
};

// ── 1. 位流身份 ────────────────────────────────────────────────
snap.bits = await bitsInfo();

// ── 2. HTTP 只读统计（网关同端口 8787）─────────────────────────
snap.http.health = await httpGet("/api/health");
snap.http.stats = await httpGet("/api/stats");

// ── 3. WS board.getStatus ─────────────────────────────────────
snap.rpc.getStatus = await rpcGetStatus(wsUrl);

// ── 4. 串口枚举（COM6 是否在列 / 是否被占）────────────────────
snap.serial.list = await listPorts();
snap.serial.com6Present = !!(snap.serial.list.ok && snap.serial.list.ports.some((p) => p.path === "COM6"));
if (probeOpen) snap.serial.probeOpen = await probeCom6();

// ── 5. 端口/进程（1234 / 8787 的 pid，用于接缝与计数对比时定位网关）──
const ns = await run("netstat", ["-ano"], { timeoutMs: 20000 });
if (ns.ok) snap.ports.lines = parseNetstat(Buffer.concat(ns.chunks));
else snap.ports.error = ns.error;

// ── 6. JTAG 配置态（只读；默认开启）───────────────────────────
if (!skipJtag) {
  const t1 = Date.now();
  const psCmd = `& '${VIVADO}' -mode batch -nolog -nojournal -source '${JTAG_TCL}'`;
  const j = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd],
    { cwd: JTAG_CWD, timeoutMs: 240000 });
  const raw = Buffer.concat(j.chunks || []);
  snap.jtag = {
    ok: j.ok && j.code === 0, code: j.code, elapsedMs: Date.now() - t1,
    skipped: false, parsed: parseJtag(raw),
    rawLog: null,
  };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const rawPath = path.join(outDir, `jtag_${phase}_${tsLocal}.log`);
    fs.writeFileSync(rawPath, raw);
    snap.jtag.rawLog = rawPath;
  } catch (e) { errors.push("jtag 原始日志写入失败: " + String(e && e.message || e)); }
} else {
  snap.jtag = { skipped: true };
}

// ── 7. 落盘 ───────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const base = `snapshot_${phase}_${tsLocal}${label ? "_" + String(label).replace(/[^\w.-]+/g, "-") : ""}`;
const jsonPath = path.join(outDir, base + ".json");
const mdPath = path.join(outDir, base + ".md");
fs.writeFileSync(jsonPath, JSON.stringify(snap, null, 2), "utf8");

const b = Object.fromEntries(snap.bits.map((x) => [x.key, x]));
const jp = snap.jtag.parsed || {};
const st = snap.http.stats && snap.http.stats.json;
const gwPid = [...new Set((snap.ports.lines || [])
  .filter((l) => /LISTENING/.test(l) || /^UDP\b/.test(l))
  .map((l) => { const m = l.match(/(\d+)\s*$/); return m ? m[1] : null; })
  .filter(Boolean))];

const lines = [];
lines.push(`# 快照 ${phase}（${snap.meta.localTime}）${label ? " · " + label : ""}`);
lines.push("");
lines.push("- 工具：`host/app/tools/uart_accept_snapshot.mjs`（只读，不烧录/不下载）");
lines.push("- JSON：`" + jsonPath + "`");
lines.push("");
lines.push("## 位流身份");
lines.push("");
lines.push("| 代号 | 文件 | 存在 | 大小 | md5 | mtime（UTC） |");
lines.push("|---|---|---|---|---|---|");
for (const x of snap.bits) {
  lines.push(`| ${x.key} | ${x.rel ? x.rel : x.path} | ${x.exists ? "是" : "否"} | ${x.size ?? "-"} | ${x.md5 ? "\`" + x.md5 + "\`" : "-"} | ${x.mtime ?? "-"} |`);
}
lines.push("");
lines.push("## 网关 HTTP（只读）");
lines.push("");
const h = snap.http.health && snap.http.health.json;
const s = st;
if (h) lines.push(`- /api/health：ok=${snap.http.health.ok} wire=${h.wire} geo=${h.geometry ? h.geometry.w + "x" + h.geometry.h : "-"} framesSeen=${h.framesSeen} latestSeq=${h.latestFrame && h.latestFrame.seq} ageMs=${h.latestFrame && h.latestFrame.ageMs} evCount=${h.latestEvents && h.latestEvents.count} uptimeMs=${h.uptimeMs}`);
else lines.push(`- /api/health：失败 ${JSON.stringify(snap.http.health)}`);
if (s) {
  lines.push(`- /api/stats.profile：${JSON.stringify(s.profile)}`);
  lines.push(`- /api/stats.stats：packets=${s.stats && s.stats.packets} bytes=${s.stats && s.stats.bytes} pps=${s.stats && s.stats.pps} bps=${s.stats && s.stats.bps} lastFrameIdx=${s.stats && s.stats.lastFrameIdx} wraps=${s.stats && s.stats.wraps}`);
  lines.push(`- /api/stats.counters：${JSON.stringify(s.counters)}`);
} else lines.push(`- /api/stats：失败 ${JSON.stringify(snap.http.stats)}`);
lines.push("");
lines.push("## 板端状态（WS board.getStatus）");
lines.push("");
if (snap.rpc.getStatus.ok) lines.push("\`\`\`json\n" + JSON.stringify(snap.rpc.getStatus.result, null, 2) + "\n\`\`\`");
else lines.push(`- 失败：${snap.rpc.getStatus.error}`);
lines.push("");
lines.push("## JTAG / CONFIG_STATUS（只读探测）");
lines.push("");
if (snap.jtag.skipped) lines.push("- 已跳过（--no-jtag）");
else {
  lines.push(`- 结果：ok=${snap.jtag.ok} code=${snap.jtag.code} 耗时=${snap.jtag.elapsedMs} ms`);
  for (const [k, v] of Object.entries(jp)) if (v) lines.push(`- ${k}：${v}`);
  lines.push(`- 原始日志：${snap.jtag.rawLog || "-"}`);
}
lines.push("");
lines.push("## 串口");
lines.push("");
lines.push(`- COM6 在 SerialPort.list() 中：${snap.serial.com6Present ? "是" : "否"}`);
if (snap.serial.list.ok) lines.push(`- 端口列表：${JSON.stringify(snap.serial.list.ports)}`);
else lines.push(`- 枚举失败：${snap.serial.list.error}`);
if (snap.serial.probeOpen) lines.push(`- probe-open：${JSON.stringify(snap.serial.probeOpen)}`);
lines.push("");
lines.push("## 端口占用（1234/8787）");
lines.push("");
if (snap.ports.lines && snap.ports.lines.length) for (const l of snap.ports.lines) lines.push("- " + l);
else lines.push("- 无匹配行（网关没在跑？）");
lines.push("");
if (errors.length) { lines.push("## 错误"); lines.push(""); for (const e of errors) lines.push("- " + e); lines.push(""); }
fs.writeFileSync(mdPath, lines.join("\n"), "utf8");

// ── 8. 机读标记 ───────────────────────────────────────────────
const mark = (k, v) => console.log(`${k}=${v === undefined || v === null ? "" : v}`);
mark("SNAP_PHASE", phase);
mark("SNAP_JSON", jsonPath);
mark("SNAP_MD", mdPath);
mark("SNAP_BIT_A_MD5", b.A && b.A.md5);
mark("SNAP_BIT_A_SIZE", b.A && b.A.size);
mark("SNAP_BIT_B_MD5", b.B && b.B.md5);
mark("SNAP_BIT_B_SIZE", b.B && b.B.size);
mark("SNAP_BIT_DELIVERED_MD5", b.DELIVERED && b.DELIVERED.md5);
mark("SNAP_JTAG_DONE", jp.done);
mark("SNAP_JTAG_DONE_INTERNAL", jp.doneInternal);
mark("SNAP_JTAG_EOS", jp.eos);
mark("SNAP_JTAG_GWE", jp.gwe);
mark("SNAP_JTAG_CONFIGURED", jp.configured);
mark("SNAP_JTAG_RESULT", jp.result);
mark("SNAP_COM6_PRESENT", snap.serial.com6Present ? "1" : "0");
mark("SNAP_GATEWAY_PID", gwPid.length ? gwPid.join(",") : "");
mark("SNAP_HTTP_OK", snap.http.health.ok && snap.http.stats.ok ? "1" : "0");
mark("SNAP_RPC_OK", snap.rpc.getStatus.ok ? "1" : "0");
mark("SNAP_ELAPSED_MS", Date.now() - t0);
const fatal = !(snap.http.health.ok && snap.http.stats.ok);
mark("SNAP_RESULT", fatal ? "PARTIAL" : "OK");
process.exit(fatal ? 1 : 0);
