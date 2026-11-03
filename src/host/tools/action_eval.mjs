#!/usr/bin/env node
// action_eval.mjs —— M5 动作识别现场评测 CLI（task-16）
//
// 只读消费网关的 GET /api/action/events（长轮询），把真实类别标注与判定结果
// 做窗口匹配，输出混淆矩阵 / 各类 P-R-F1 / 误触发次数/分钟 / 判定延迟。
//
// 用法（详细见 tools/README.md）：
//   node --experimental-strip-types tools/action_eval.mjs \
//     --api http://127.0.0.1:8787 --out action_eval_out
//   node --experimental-strip-types tools/action_eval.mjs --script truth.json --out /tmp/eval
//   node --experimental-strip-types tools/action_eval.mjs --e2e \
//     --udp-port 12400 --ws-port 8900 --out /tmp/eval_e2e
//
// 退出码：0 = 正常完成；1 = 运行/断言失败；2 = 参数错误。
//
// 匹配口径（与任务书 §匹配口径一致）：
//   1) 真值标注后 windowMs 内收到的第一个未消费判定，算该窗口的一次判定；
//   2) 每个真值窗口只消费一次，窗口内后续判定计“重复”但不重复计误触发；
//   3) 无任何动作真值窗口覆盖的时段内，class!=0 的判定一律计误触发；
//   4) 已标注但窗口内没有任何判定，计漏检。
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ACT_CLASS_NAMES } from "@retina/protocol";

/** 工具版本（summary JSON 里记录，便于证据追溯） */
export const VERSION = 1;
export const DEFAULT_API = "http://127.0.0.1:8787";
export const DEFAULT_OUT = "action_eval_out";
export const DEFAULT_WINDOW_MS = 3000;
export const DEFAULT_TAIL_MS = 800;
export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_UDP_PORT = 12400;
export const DEFAULT_WS_PORT = 8900;
export const DEFAULT_BIND = "127.0.0.1";
export const CSV_HEADER = "t_ms,kind,class,className,conf,matched";
export const CSV_NAME = "action_eval.csv";
export const JSON_NAME = "action_eval_summary.json";
export const CLASS_NAMES = ACT_CLASS_NAMES;
export const FRAME_BYTES = 800 * 480 * 2;
export const CHUNK_BYTES = 1280;
export const CHUNKS_PER_FRAME = FRAME_BYTES / CHUNK_BYTES;
export const CONF_BUCKETS = [
  { label: "0-7", min: 0, max: 7 },
  { label: "8-15", min: 8, max: 15 },
  { label: "16-23", min: 16, max: 23 },
  { label: "24-31", min: 24, max: 31 },
];

/** 参数错误（main 统一按退出码 2 处理） */
export class ArgsError extends Error {}

const USAGE = [
  "用法: node --experimental-strip-types tools/action_eval.mjs [选项]",
  "  交互模式（默认）: 键盘 1/2/0 标注，空格或回车确认，q 退出",
  "  --api <url>       网关 HTTP 根地址（默认 http://127.0.0.1:8787，只读 GET）",
  "  --out <dir>       输出目录（默认 action_eval_out；写 action_eval.csv + action_eval_summary.json）",
  "  --window-ms <n>   真值标注后的匹配窗口毫秒（默认 3000）",
  "  --tail-ms <n>     退出前的收尾等待毫秒（默认 800）",
  "  --poll-ms <n>     长轮询 timeoutMs（默认 1000，范围 100~30000）",
  "  --script <file>   非交互回放真值时间线（JSON；格式见 tools/README.md）",
  "  --duration-ms <n> 脚本模式采集时长毫秒（默认 max(真值末尾+window+tail, 1000)）",
  "  --e2e             合成 E2E：自动起网关、注入 v3 包、断言混淆矩阵",
  "  --udp-port <n>    E2E UDP 端口（默认 12400，必须 >=12400）",
  "  --ws-port <n>     E2E HTTP/WS 端口（默认 8900，必须 >=8800）",
  "  --bind <ipv4>     E2E UDP 绑定地址（默认 127.0.0.1）",
  "  --help            打印本帮助",
  "",
  "匹配口径: 真值标注后 windowMs 内第一个未消费判定算一次；每个窗口只消费一次；",
  "          无动作区间内 class!=0 判定计误触发；已标注但无判定计漏检。",
  "端口硬约束: E2E 禁止 1234 / 8787（用户面板保留），UDP 必须 >=12400，HTTP/WS 必须 >=8800。",
].join("\n");

/** 有限数字参数解析（允许小数；整数由调用方另检） */
function numberArg(raw, name, min, max) {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ArgsError("参数 " + name + " 不是数字：" + String(raw));
  if (v < min || v > max) throw new ArgsError("参数 " + name + " 超出范围 " + min + "~" + max + "：" + String(raw));
  return v;
}

function intArg(raw, name, min, max) {
  const v = numberArg(raw, name, min, max);
  if (!Number.isInteger(v)) throw new ArgsError("参数 " + name + " 必须是整数：" + String(raw));
  return v;
}

/** 取一个必须带值的参数；缺值/后一个又是 flag 都算参数错误 */
function valueArg(args, i, flag) {
  const v = args[i + 1];
  if (v === undefined || v === "" || v.startsWith("--")) throw new ArgsError("参数 " + flag + " 缺少值");
  return v;
}

function normalizeApiBase(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ArgsError("参数 --api 不是合法 URL：" + String(raw));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ArgsError("参数 --api 只支持 http/https：" + String(raw));
  }
  if (url.search || url.hash) throw new ArgsError("参数 --api 不能带 query/hash：" + String(raw));
  const pathname = url.pathname.replace(/\/+$/, "");
  return url.origin + pathname;
}

/**
 * 解析命令行 → 结构化选项（纯函数，单测直接调）。
 * mode: interactive | script | e2e。
 */
export function parseEvalArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const opts = {
    help: false,
    mode: "interactive",
    api: DEFAULT_API,
    out: DEFAULT_OUT,
    scriptPath: null,
    windowMs: DEFAULT_WINDOW_MS,
    durationMs: null,
    tailMs: DEFAULT_TAIL_MS,
    pollMs: DEFAULT_POLL_MS,
    udpPort: DEFAULT_UDP_PORT,
    wsPort: DEFAULT_WS_PORT,
    bind: DEFAULT_BIND,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return { ...opts, help: true };
    if (a === "--e2e") { opts.mode = "e2e"; continue; }
    if (a === "--api") { opts.api = normalizeApiBase(valueArg(args, i, a)); i++; continue; }
    if (a === "--out") { opts.out = valueArg(args, i, a); i++; continue; }
    if (a === "--script") { opts.scriptPath = valueArg(args, i, a); i++; continue; }
    if (a === "--window-ms") { opts.windowMs = intArg(valueArg(args, i, a), a, 1, 600000); i++; continue; }
    if (a === "--duration-ms") { opts.durationMs = intArg(valueArg(args, i, a), a, 100, 3600000); i++; continue; }
    if (a === "--tail-ms") { opts.tailMs = intArg(valueArg(args, i, a), a, 0, 600000); i++; continue; }
    if (a === "--poll-ms") { opts.pollMs = intArg(valueArg(args, i, a), a, 100, 30000); i++; continue; }
    if (a === "--udp-port") { opts.udpPort = intArg(valueArg(args, i, a), a, 1, 65535); i++; continue; }
    if (a === "--ws-port") { opts.wsPort = intArg(valueArg(args, i, a), a, 1, 65535); i++; continue; }
    if (a === "--bind") { opts.bind = valueArg(args, i, a); i++; continue; }
    throw new ArgsError("未知参数：" + a);
  }
  if (opts.scriptPath && opts.mode === "e2e") throw new ArgsError("--script 与 --e2e 不能同时使用");
  if (opts.scriptPath) opts.mode = "script";
  if (opts.mode === "e2e") {
    if (opts.bind !== "127.0.0.1") throw new ArgsError("E2E 只允许 --bind 127.0.0.1（本机回环）：" + opts.bind);
    if (opts.udpPort < 12400) throw new ArgsError("E2E --udp-port 必须 >=12400（避免占用 1234）：" + opts.udpPort);
    if (opts.wsPort < 8800) throw new ArgsError("E2E --ws-port 必须 >=8800（避免占用 8787）：" + opts.wsPort);
    if (opts.udpPort === 1234 || opts.wsPort === 1234 || opts.udpPort === 8787 || opts.wsPort === 8787) {
      throw new ArgsError("E2E 禁止使用 1234 / 8787（用户面板保留端口）");
    }
    if (opts.udpPort === opts.wsPort) throw new ArgsError("E2E --udp-port 与 --ws-port 不能相同");
  }
  return opts;
}

/** 类别值：数字 0..3 或中文/英文别名；真值只允许 0/1/2 */
const CLASS_ALIASES = new Map([
  ["0", 0], ["none", 0], ["idle", 0], ["无动作", 0], ["静止", 0], ["无", 0],
  ["1", 1], ["hand", 1], ["openclose", 1], ["手部开合", 1], ["手部", 1], ["开合", 1],
  ["握拳→张开", 1], ["握拳", 1],
  ["2", 2], ["wave", 2], ["横向挥手", 2], ["挥手", 2], ["张开→握拳", 2],
  ["3", 3], ["reserved", 3], ["保留", 3],
]);

export function parseClassValue(raw) {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 3) throw new ArgsError("类别必须是 0..3 的整数：" + String(raw));
    return raw;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^[0-3]$/.test(s)) return Number(s);
    const v = CLASS_ALIASES.get(s) ?? CLASS_ALIASES.get(s.toLowerCase());
    if (v !== undefined) return v;
  }
  throw new ArgsError("无法识别的类别：" + JSON.stringify(raw));
}

export function classLabel(cls) {
  return CLASS_NAMES[cls] ?? "未知";
}

/**
 * 解析 --script JSON。接受：
 *   [{ "tMs": 300, "class": 1 }, ...]
 *   { "truth": [...] } / { "events": [...] } / { "timeline": [...] }
 * 字段别名：tMs/atMs/t；class/cls。
 */
export function parseScript(text, sourceName = "<script>") {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    throw new ArgsError(sourceName + " 不是合法 JSON：" + (e && e.message ? e.message : String(e)));
  }
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data && data.truth) ? data.truth
      : Array.isArray(data && data.timeline) ? data.timeline
        : Array.isArray(data && data.events) ? data.events
          : null;
  if (rows === null) throw new ArgsError(sourceName + " 必须是数组，或含 truth/timeline/events 数组的对象");
  if (rows.length === 0) throw new ArgsError(sourceName + " 的真值时间线为空");
  const out = rows.map((row, index) => {
    let tRaw;
    let cRaw;
    if (Array.isArray(row)) {
      tRaw = row[0];
      cRaw = row[1];
    } else if (row && typeof row === "object") {
      tRaw = row.tMs ?? row.atMs ?? row.t;
      cRaw = row.class ?? row.cls;
    }
    const tMs = Number(tRaw);
    if (!Number.isInteger(tMs) || tMs < 0) {
      throw new ArgsError(sourceName + " 第 " + (index + 1) + " 条的 tMs 必须是 >=0 的整数");
    }
    const cls = parseClassValue(cRaw);
    if (cls === 3) throw new ArgsError(sourceName + " 第 " + (index + 1) + " 条是真值，不能用保留类 class=3");
    return { tMs, class: cls, className: classLabel(cls), note: row && row.note ? String(row.note) : "" };
  });
  out.sort((a, b) => a.tMs - b.tMs || a.class - b.class);
  return out;
}

/** 构造动作字节：bit7 VALID | bit6..2 CONF | bit1..0 CLASS（与协议常量一致） */
export function makeActionByte(cls, conf, valid = true) {
  if (!Number.isInteger(cls) || cls < 0 || cls > 3) throw new ArgsError("class 必须是 0..3：" + String(cls));
  if (!Number.isInteger(conf) || conf < 0 || conf > 31) throw new ArgsError("conf 必须是 0..31：" + String(conf));
  return ((valid ? 0x80 : 0) | ((conf & 0x1f) << 2) | (cls & 0x03)) & 0xff;
}

function ratio(n, d) {
  return d > 0 ? Number((n / d).toFixed(4)) : null;
}

function round3(v) {
  return Number.isFinite(v) ? Number(v.toFixed(3)) : null;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) {
    return { count: 0, minMs: null, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sum = nums.reduce((s, v) => s + v, 0);
  return {
    count: nums.length,
    minMs: round3(nums[0]),
    meanMs: round3(sum / nums.length),
    p50Ms: round3(percentile(nums, 0.5)),
    p95Ms: round3(percentile(nums, 0.95)),
    maxMs: round3(nums[nums.length - 1]),
  };
}

function normalizeTruths(input) {
  return (Array.isArray(input) ? input : []).map((t, i) => {
    const cls = Number(t.class);
    if (!Number.isInteger(cls) || cls < 0 || cls > 3) throw new ArgsError("真值类别非法：" + String(t.class));
    const tMs = Number(t.tMs);
    if (!Number.isFinite(tMs) || tMs < 0) throw new ArgsError("真值 tMs 非法：" + String(t.tMs));
    return { id: i + 1, tMs, class: cls, className: classLabel(cls) };
  }).sort((a, b) => a.tMs - b.tMs || a.id - b.id);
}

function normalizePreds(input) {
  const out = [];
  const ignored = [];
  (Array.isArray(input) ? input : []).forEach((p, i) => {
    const cls = Number(p.class);
    const tMs = Number(p.tMs);
    if (p.valid === false || !Number.isInteger(cls) || cls < 0 || cls > 3 || !Number.isFinite(tMs)) {
      ignored.push({ index: i + 1, class: p.class, tMs: p.tMs });
      return;
    }
    const seq = Number.isInteger(p.seq) ? p.seq : i + 1;
    const recvMs = Number.isFinite(p.recvMs) ? p.recvMs : tMs;
    const recvEpochMs = Number.isFinite(p.recvEpochMs) ? p.recvEpochMs : null;
    out.push({
      index: i + 1,
      seq,
      tMs,
      recvMs,
      recvEpochMs,
      class: cls,
      className: classLabel(cls),
      conf: Number.isInteger(p.conf) ? p.conf : 0,
      raw: Number.isInteger(p.raw) ? p.raw : null,
      frameIdx: Number.isInteger(p.frameIdx) ? p.frameIdx : null,
    });
  });
  out.sort((a, b) => a.recvMs - b.recvMs || a.seq - b.seq);
  return { preds: out, ignored };
}

/**
 * 核心评测：真值 + 判定 → { summary, rows }。
 * rows 同时用于 CSV；summary 是落盘 JSON 的主体。
 */
export function analyze(truthInput, predInput, options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : DEFAULT_WINDOW_MS;
  const truths = normalizeTruths(truthInput);
  const { preds, ignored } = normalizePreds(predInput);
  const actionTruths = truths.filter((t) => t.class === 1 || t.class === 2);
  const predictions = preds.filter((p) => p.class !== 0);
  const ignoredClass0 = preds.filter((p) => p.class === 0);

  // 1) 贪心窗口匹配：真值按时间顺序，每个窗口取窗口内最早未消费判定。
  const used = new Set();
  const matches = [];
  const predTruth = new Map();
  const truthPred = new Map();
  for (const truth of actionTruths) {
    let best = null;
    for (const p of predictions) {
      if (used.has(p)) continue;
      if (p.recvMs < truth.tMs) continue;
      if (p.recvMs > truth.tMs + windowMs) continue;
      if (best === null || p.recvMs < best.recvMs || (p.recvMs === best.recvMs && p.seq < best.seq)) best = p;
    }
    if (best) {
      used.add(best);
      predTruth.set(best, truth);
      truthPred.set(truth, best);
      matches.push({ truth, pred: best });
    }
  }

  // 2) 未消费判定：落在任一动作窗口内 → 重复；否则 → 误触发。
  const duplicates = [];
  const falseTriggers = [];
  for (const p of predictions) {
    if (used.has(p)) continue;
    const insideWindow = actionTruths.some((t) => p.recvMs >= t.tMs && p.recvMs <= t.tMs + windowMs);
    if (insideWindow) duplicates.push(p);
    else falseTriggers.push(p);
  }

  const correct = matches.filter((m) => m.truth.class === m.pred.class).length;
  const wrong = matches.length - correct;
  const missed = actionTruths.length - matches.length;
  const totalPredictions = predictions.length;
  const eventCount = preds.length;
  // task-24：网关 /api/action 的 count 是 VALID 上升沿/类别变化的累计检测次数；
  // 评测期间用「结束 count - 开始 count」作为本次检测次数，事件条数应与它一致。
  const gatewayDelta = Number.isInteger(options.gatewayCount) ? options.gatewayCount : null;
  const detectionCount = gatewayDelta !== null ? gatewayDelta : eventCount;
  const accuracy = ratio(correct, actionTruths.length + falseTriggers.length);

  // 3) 混淆矩阵（行=真值 class，列=预测 class；miss 单独一列）。
  const matrix = {};
  for (const c of [1, 2, 3]) matrix[String(c)] = { "1": 0, "2": 0, "3": 0, miss: 0 };
  for (const m of matches) matrix[String(m.truth.class)][String(m.pred.class)] += 1;
  for (const t of actionTruths) if (!truthPred.has(t)) matrix[String(t.class)].miss += 1;

  // 4) 各类 P/R/F1：错分同时计入真值类的 FN 和预测类的 FP。
  const perClass = {};
  const classesWithSupport = [];
  for (const c of [1, 2, 3]) {
    const support = actionTruths.filter((t) => t.class === c).length;
    const tp = matches.filter((m) => m.truth.class === c && m.pred.class === c).length;
    const fp = falseTriggers.filter((p) => p.class === c).length
      + matches.filter((m) => m.truth.class !== c && m.pred.class === c).length;
    const fn = support - tp;
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, support);
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
    perClass[String(c)] = {
      className: classLabel(c),
      support,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
    };
    if (support > 0) classesWithSupport.push(c);
  }
  const balancedAccuracy = classesWithSupport.length > 0
    ? Number((classesWithSupport.reduce((s, c) => s + perClass[String(c)].recall, 0) / classesWithSupport.length).toFixed(4))
    : null;
  const macroF1 = classesWithSupport.length > 0
    ? Number((classesWithSupport.reduce((s, c) => s + perClass[String(c)].f1, 0) / classesWithSupport.length).toFixed(4))
    : null;

  // 5) 延迟：匹配延迟从真值标注时刻算；transport 用事件 tMs（网关到达时刻）到本地收到时刻。
  const matchLatency = matches.map((m) => m.pred.recvMs - m.truth.tMs);
  const transportLatency = matches
    .filter((m) => m.pred.recvEpochMs !== null)
    .map((m) => m.pred.recvEpochMs - m.pred.tMs);

  // 6) 置信度分档：分档内分别记 correct/wrong/false/duplicate。
  const buckets = CONF_BUCKETS.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    total: 0,
    correct: 0,
    wrong: 0,
    falseTrigger: 0,
    duplicate: 0,
    accuracy: null,
  }));
  for (const p of predictions) {
    const bucket = buckets.find((b) => p.conf >= b.min && p.conf <= b.max) ?? buckets[0];
    bucket.total += 1;
    if (predTruth.has(p)) {
      if (predTruth.get(p).class === p.class) bucket.correct += 1;
      else bucket.wrong += 1;
    } else if (falseTriggers.includes(p)) bucket.falseTrigger += 1;
    else if (duplicates.includes(p)) bucket.duplicate += 1;
  }
  for (const b of buckets) b.accuracy = ratio(b.correct, b.correct + b.wrong + b.falseTrigger);

  // 7) 评测时长：优先用调用方传入的真实采集时长；脚本/合成模式也传。
  let durationMs = Number(options.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    const times = truths.map((t) => t.tMs).concat(predictions.map((p) => p.recvMs));
    durationMs = Math.max(windowMs, ...(times.length ? times : [0]));
  }
  const falseTriggersPerMin = Number(((falseTriggers.length * 60000) / durationMs).toFixed(3));

  const m5 = {
    actionCount: actionTruths.length,
    actionCountTarget: 100,
    actionCountPass: actionTruths.length >= 100,
    accuracy,
    accuracyTarget: 0.85,
    accuracyPass: accuracy !== null && accuracy >= 0.85,
    falseTriggersPerMin,
    falseTriggersPerMinTarget: 1,
    falseTriggersPerMinPass: falseTriggersPerMin < 1,
  };
  m5.pass = m5.actionCountPass && m5.accuracyPass && m5.falseTriggersPerMinPass;

  const rows = [];
  for (const t of truths) {
    rows.push({
      tMs: t.tMs,
      kind: "truth",
      class: t.class,
      className: t.className,
      conf: null,
      matched: truthPred.has(t),
    });
  }
  for (const p of predictions) {
    rows.push({
      tMs: p.recvMs,
      kind: "pred",
      class: p.class,
      className: p.className,
      conf: p.conf,
      matched: used.has(p),
    });
  }
  rows.sort((a, b) => a.tMs - b.tMs || (a.kind === b.kind ? 0 : a.kind === "truth" ? -1 : 1));

  const summary = {
    version: VERSION,
    mode: options.mode ?? "script",
    windowMs,
    durationMs: round3(durationMs),
    totalTruthMarks: truths.length,
    totalTruthActions: actionTruths.length,
    totalPredictions,
    // task-24：检测次数接网关 count（Δ=评测期间），eventCount 是长轮询实际收到的事件条数。
    detectionCount,
    eventCount,
    gatewayCountStart: Number.isInteger(options.gatewayCountStart) ? options.gatewayCountStart : null,
    gatewayCountEnd: Number.isInteger(options.gatewayCountEnd) ? options.gatewayCountEnd : null,
    countMatchesEvents: gatewayDelta !== null ? gatewayDelta === eventCount : null,
    matched: matches.length,
    missed,
    correct,
    wrong,
    duplicates: duplicates.length,
    falseTriggers: falseTriggers.length,
    accuracy,
    balancedAccuracy,
    macroF1,
    falseTriggersPerMin,
    confusionMatrix: {
      columns: ["1", "2", "3", "miss"],
      rows: matrix,
      rowLabels: ["1", "2", "3"],
    },
    perClass,
    latencyMs: latencyStats(matchLatency),
    transportLatencyMs: latencyStats(transportLatency),
    confidenceBuckets: buckets,
    m5Acceptance: m5,
    ignored: {
      class0Predictions: ignoredClass0.length,
      invalidPredictions: ignored.length,
    },
    notes: [
      "匹配口径：真值标注后 " + windowMs + " ms 内第一个未消费判定；每个窗口只消费一次",
      "无动作区间内 class!=0 判定计误触发；动作窗口内多余判定计重复（不重复计误触发）",
      "class0 不作为预测统计；class3 仅按预测类别统计（保留类不应被固件产生）",
      "class 显示名来自 @retina/protocol ACT_CLASS_NAMES（0 无动作 / 1 手部开合 / 2 横向挥手 / 3 保留）",
    ],
  };
  return { summary, rows };
}

/** 便利包装：只要 summary。 */
export function evaluate(truthInput, predInput, options = {}) {
  return analyze(truthInput, predInput, options).summary;
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** rows → CSV 文本（6 列，LF 行尾）。truth 行的 conf 留空。 */
export function buildEvalCsv(rows) {
  const lines = [CSV_HEADER];
  for (const row of rows ?? []) {
    lines.push([
      csvCell(row.tMs),
      csvCell(row.kind),
      csvCell(row.class),
      csvCell(row.className),
      csvCell(row.conf),
      csvCell(row.matched ? "true" : "false"),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/** 写 CSV + summary JSON；summary 追加 generatedAt/tool/source 等元数据。 */
export function writeEvalOutputs(analysis, outDir, meta = {}) {
  const dir = path.resolve(String(outDir));
  fs.mkdirSync(dir, { recursive: true });
  const csvPath = path.join(dir, CSV_NAME);
  const jsonPath = path.join(dir, JSON_NAME);
  const summary = {
    ...analysis.summary,
    generatedAt: new Date().toISOString(),
    tool: "action_eval",
    ...meta,
  };
  fs.writeFileSync(csvPath, buildEvalCsv(analysis.rows), "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  return { dir, csvPath, jsonPath, summary };
}

function fmtMetric(v) {
  return v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%";
}

/** 人类可读摘要（终端/证据日志用）；返回字符串，不直接打印，便于单测。 */
export function formatSummary(summary) {
  const lines = [];
  lines.push("===== 动作评测结果 =====");
  lines.push("真值动作 " + summary.totalTruthActions + " 次（另有无动作标注 " + (summary.totalTruthMarks - summary.totalTruthActions) + " 条）"
    + "；检测次数 count=" + summary.detectionCount + "（事件 " + summary.eventCount + " 条" + (summary.countMatchesEvents === false ? "，不一致！" : "") + "）"
    + "；判定 " + summary.totalPredictions + " 条；匹配 " + summary.matched
    + "；漏检 " + summary.missed + "；错分 " + summary.wrong
    + "；误触发 " + summary.falseTriggers + "；重复 " + summary.duplicates);
  lines.push("混淆矩阵（行=真值，列=预测；miss=漏检）:");
  lines.push("          pred1  pred2  pred3  miss");
  for (const c of ["1", "2", "3"]) {
    const r = summary.confusionMatrix.rows[c];
    lines.push("truth" + c + "  " + String(r["1"]).padStart(5) + "  " + String(r["2"]).padStart(5) + "  " + String(r["3"]).padStart(5) + "  " + String(r.miss).padStart(4));
  }
  for (const c of ["1", "2", "3"]) {
    const p = summary.perClass[c];
    lines.push("class" + c + " " + p.className + ": support=" + p.support + " TP=" + p.tp + " FP=" + p.fp + " FN=" + p.fn
      + " P=" + fmtMetric(p.precision) + " R=" + fmtMetric(p.recall) + " F1=" + fmtMetric(p.f1));
  }
  lines.push("accuracy=" + fmtMetric(summary.accuracy) + "  balanced=" + fmtMetric(summary.balancedAccuracy)
    + "  macroF1=" + fmtMetric(summary.macroF1)
    + "  误触发=" + summary.falseTriggersPerMin + "/min  时长=" + summary.durationMs + " ms");
  const lat = summary.latencyMs;
  if (lat.count > 0) {
    lines.push("匹配延迟: n=" + lat.count + " min=" + lat.minMs + " mean=" + lat.meanMs + " p50=" + lat.p50Ms + " p95=" + lat.p95Ms + " max=" + lat.maxMs + " ms");
  }
  const tr = summary.transportLatencyMs;
  if (tr.count > 0) {
    lines.push("采集传输延迟: n=" + tr.count + " mean=" + tr.meanMs + " p95=" + tr.p95Ms + " ms");
  }
  const m5 = summary.m5Acceptance;
  lines.push("M5 门槛: 动作 " + m5.actionCount + "/" + m5.actionCountTarget + (m5.actionCountPass ? " ✓" : " ✗")
    + " · 准确率 " + fmtMetric(m5.accuracy) + " (目标 " + (m5.accuracyTarget * 100) + "%)" + (m5.accuracyPass ? " ✓" : " ✗")
    + " · 误触发 " + m5.falseTriggersPerMin + "/min (目标 <" + m5.falseTriggersPerMinTarget + ")" + (m5.falseTriggersPerMinPass ? " ✓" : " ✗")
    + (m5.pass ? " → PASS" : " → 未达标"));
  return lines.join("\n");
}

// ——————————————————————— HTTP / 采集 ———————————————————————

async function getJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, text };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 读网关累计检测次数（task-24）。GET /api/action 的 count 只增不改；
 * 读不到（旧网关/503）返回 null，评测沿用事件条数并在 summary 里标 countMatchesEvents=null。
 */
export async function readActionCount(api) {
  try {
    const r = await getJson(api + "/api/action", { timeoutMs: 3000 });
    if (r.status === 200 && r.body && Number.isInteger(r.body.count)) return r.body.count;
  } catch { /* 旧网关或瞬时错误：不影响评测主流程 */ }
  return null;
}

/**
 * 取事件游标基线：GET /api/action/events?after=-1&timeoutMs=0。
 * 空网关会返回 503（还没收到完整帧）；这里按 retry 等待，最多 timeoutMs。
 * 返回 { lastSeq, latest }；latest 是 after=-1 带回的最新旧事件（调用方丢弃）。
 */
export async function waitForBaseline(api, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
  const log = options.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  let lastMsg = 0;
  while (Date.now() < deadline) {
    try {
      const r = await getJson(api + "/api/action/events?after=-1&timeoutMs=0", { timeoutMs: 5000 });
      if (r.status === 503) {
        if (Date.now() - lastMsg > 2000) {
          log("等待网关收到第一帧 v3 数据（/api/action/events 返回 503）...");
          lastMsg = Date.now();
        }
        await sleep(500);
        continue;
      }
      // 空事件表时 /api/action/events 返回 200 + {ok:false,timeout:true,lastSeq}，
      // 这也是合法基线（lastSeq=0，尚无事件）；不能当成失败，否则评测一开始就卡 30s。
      const isTimeoutEnvelope = r.body.ok === false && r.body.timeout === true;
      if (r.status !== 200 || !r.body || (r.body.ok !== true && !isTimeoutEnvelope)) {
        throw new Error("基线请求失败 HTTP " + r.status + "：" + String(r.text).slice(0, 200));
      }
      const lastSeq = Number.isInteger(r.body.lastSeq) ? Math.max(0, r.body.lastSeq) : 0;
      const latest = isTimeoutEnvelope
        ? null
        : (Array.isArray(r.body.events) && r.body.events.length > 0 ? r.body.events[r.body.events.length - 1] : null);
      return { lastSeq, latest };
    } catch (err) {
      if (Date.now() >= deadline) break;
      log("等待网关/API（" + (err && err.message ? err.message : String(err)) + "）...");
      await sleep(500);
    }
  }
  throw new Error("等待网关基线超时（" + timeoutMs + " ms）；请确认网关已启动、板卡/回放已产生 v3 帧、API 地址 " + api);
}

/**
 * 后台长轮询采集器。只 GET /api/action/events；事件按 seq 去重。
 * recvMs 是相对 t0 的本地单调时间，供窗口匹配；recvEpochMs 用于传输延迟。
 */
export class ActionEventCollector {
  constructor(options) {
    this.api = options.api;
    this.after = Number.isInteger(options.after) ? options.after : 0;
    this.t0 = options.t0;
    this.pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
    this.log = options.log ?? (() => {});
    this.onEvent = options.onEvent ?? null;
    this.events = [];
    this.dropped = 0;
    this.errors = [];
    this.unavailable = false;
    this.stopped = false;
    this.controller = new AbortController();
    this.promise = null;
  }

  start() {
    if (this.promise === null) this.promise = this.loop();
    return this;
  }

  async stop() {
    this.stopped = true;
    this.controller.abort();
    if (this.promise) {
      try { await this.promise; } catch { /* stop 时 AbortError 属正常 */ }
    }
  }

  async loop() {
    while (!this.stopped) {
      let r;
      try {
        r = await getJson(this.api + "/api/action/events?after=" + this.after + "&timeoutMs=" + this.pollMs, {
          timeoutMs: this.pollMs + 8000,
          signal: this.controller.signal,
        });
      } catch (err) {
        if (this.stopped || (err && err.name === "AbortError")) break;
        const msg = err && err.message ? err.message : String(err);
        this.errors.push(msg);
        this.log("采集请求失败（" + msg + "），500 ms 后重试");
        await sleep(500);
        continue;
      }
      if (this.stopped) break;
      if (r.status === 503) {
        if (!this.unavailable) {
          this.unavailable = true;
          this.log("网关尚未收到完整帧，等待数据...");
        }
        await sleep(300);
        continue;
      }
      if (this.unavailable) { this.unavailable = false; this.log("网关已恢复，继续采集"); }
      if (r.status !== 200 || !r.body) {
        const msg = "事件接口 HTTP " + r.status + "：" + String(r.text).slice(0, 160);
        this.errors.push(msg);
        this.log(msg);
        await sleep(500);
        continue;
      }
      if (r.body.ok === false && r.body.timeout === true) continue;
      const batch = Array.isArray(r.body.events) ? r.body.events : [];
      let consumed = 0;
      for (const ev of batch) {
        if (!Number.isInteger(ev.seq) || ev.seq <= this.after) continue;
        const recvEpochMs = Date.now();
        const enriched = { ...ev, recvEpochMs, recvMs: performance.now() - this.t0 };
        this.events.push(enriched);
        this.after = ev.seq;
        consumed += 1;
        if (this.onEvent) this.onEvent(enriched);
      }
      if (Number.isFinite(r.body.dropped) && r.body.dropped > 0) this.dropped = r.body.dropped;
      if (consumed === 0) {
        // 超时响应没有事件是正常的；若 lastSeq 已经跑在前面说明环已丢事件，推进游标避免死循环。
        if (Number.isInteger(r.body.lastSeq) && r.body.lastSeq > this.after) {
          this.dropped = Math.max(this.dropped, r.body.lastSeq - this.after);
          this.after = r.body.lastSeq;
        }
        await sleep(30);
      }
    }
  }
}

// ——————————————————————— 键盘交互 ———————————————————————

function openKeyReader(onKey) {
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const handler = (str, key) => onKey(str, key ?? {});
  process.stdin.on("keypress", handler);
  return {
    close() {
      process.stdin.removeListener("keypress", handler);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    },
  };
}

// ——————————————————————— 三种运行模式 ———————————————————————

/** 交互模式：读键标注、后台长轮询，q 退出后落盘。 */
export async function runInteractive(opts) {
  const log = (s) => console.log(s);
  log("动作评测（交互模式）· API " + opts.api + " · 匹配窗口 " + opts.windowMs + " ms");
  log("键位: 1=手部开合  2=横向挥手  0=无动作  空格/回车=确认  q=退出");
  log("说明: 每标注一个动作后请等判定出现再标下一个；退出前建议等一个匹配窗口。");
  let baseline;
  try {
    baseline = await waitForBaseline(opts.api, { log });
  } catch (err) {
    console.error("✗ " + (err && err.message ? err.message : String(err)));
    return 2;
  }
  log("基线 lastSeq=" + baseline.lastSeq + "（旧事件不参与本次评测）");
  const gatewayCountStart = await readActionCount(opts.api);
  const t0 = performance.now();
  let endMs = 0;
  let finishResolve;
  const finished = new Promise((resolve) => { finishResolve = resolve; });
  let done = false;
  let pending = null;
  const truths = [];
  const collector = new ActionEventCollector({
    api: opts.api,
    after: baseline.lastSeq,
    t0,
    pollMs: opts.pollMs,
    log,
    onEvent: (ev) => {
      log("[pred] +" + Math.round(ev.recvMs) + " ms  seq=" + ev.seq + "  class=" + ev.class + " " + ev.className + "  conf=" + ev.conf);
    },
  });
  collector.start();
  const keyReader = openKeyReader((str, key) => {
    if (key && key.ctrl && key.name === "c") { finish(); return; }
    if (key && key.name === "q") { finish(); return; }
    if (str === "0" || str === "1" || str === "2") {
      pending = Number(str);
      log("[待确认] class=" + pending + " " + classLabel(pending) + "（空格/回车确认；再按数字可改）");
      return;
    }
    if (key && (key.name === "return" || key.name === "space")) {
      if (pending === null) {
        log("[提示] 先按 0/1/2 选择真实类别，再按空格/回车确认");
        return;
      }
      const tMs = Math.round(performance.now() - t0);
      truths.push({ tMs, class: pending, className: classLabel(pending) });
      log("[truth] +" + tMs + " ms  class=" + pending + " " + classLabel(pending));
      pending = null;
      return;
    }
  });
  function finish() {
    if (done) return;
    done = true;
    endMs = performance.now() - t0;
    finishResolve();
  }
  const onSigint = () => finish();
  process.on("SIGINT", onSigint);
  try {
    await finished;
    keyReader.close();
    process.removeListener("SIGINT", onSigint);
    log("结束采集（已标 " + truths.length + " 条），收尾 " + opts.tailMs + " ms...");
    await sleep(opts.tailMs);
    await collector.stop();
    const predictions = collector.events.filter((ev) => ev.recvMs <= endMs);
    const gatewayCountEnd = await readActionCount(opts.api);
    const analysis = analyze(truths, predictions, {
      windowMs: opts.windowMs,
      durationMs: endMs,
      mode: "interactive",
      gatewayCountStart,
      gatewayCountEnd,
      gatewayCount: gatewayCountStart !== null && gatewayCountEnd !== null
        ? gatewayCountEnd - gatewayCountStart
        : null,
    });
    if (truths.length === 0) {
      console.error("✗ 没有真值标注，未生成评测结果（请至少标注一次动作）");
      return 2;
    }
    const paths = writeEvalOutputs(analysis, opts.out, {
      mode: "interactive",
      api: opts.api,
      dropped: collector.dropped,
      collectorErrors: collector.errors,
    });
    console.log(formatSummary(paths.summary));
    console.log("CSV: " + paths.csvPath);
    console.log("JSON: " + paths.jsonPath);
    if (collector.dropped > 0) console.log("⚠ 网关环丢事件 dropped=" + collector.dropped + "，结果可能漏检");
    return 0;
  } finally {
    keyReader.close();
    process.removeListener("SIGINT", onSigint);
    await collector.stop();
  }
}

/**
 * 脚本/合成模式：先取基线，再并行启动采集与 onStart（E2E 注入用），
 * 采集 durationMs 后收尾。返回 { analysis, paths, baseline, collector, elapsedMs }。
 */
export async function runScripted(opts, deps = {}) {
  const log = opts.log ?? (() => {});
  let baseline;
  try {
    baseline = await waitForBaseline(opts.api, { log, timeoutMs: opts.baselineTimeoutMs ?? 30000 });
  } catch (err) {
    throw new Error("脚本模式基线失败：" + (err && err.message ? err.message : String(err)));
  }
  const gatewayCountStart = await readActionCount(opts.api);
  const t0 = performance.now();
  const collector = new ActionEventCollector({
    api: opts.api,
    after: baseline.lastSeq,
    t0,
    pollMs: opts.pollMs,
    log,
    onEvent: opts.onEvent ?? null,
  });
  collector.start();
  const injection = deps.onStart ? Promise.resolve().then(() => deps.onStart({ t0, api: opts.api })) : null;
  let elapsedMs = 0;
  try {
    await sleep(opts.durationMs);
    if (injection) await injection;
  } finally {
    elapsedMs = performance.now() - t0;
    await sleep(opts.tailMs ?? DEFAULT_TAIL_MS);
    await collector.stop();
  }
  const gatewayCountEnd = await readActionCount(opts.api);
  const analysis = analyze(opts.truths, collector.events, {
    windowMs: opts.windowMs,
    durationMs: elapsedMs,
    mode: opts.mode ?? "script",
    gatewayCountStart,
    gatewayCountEnd,
    gatewayCount: gatewayCountStart !== null && gatewayCountEnd !== null
      ? gatewayCountEnd - gatewayCountStart
      : null,
  });
  const paths = writeEvalOutputs(analysis, opts.out, {
    mode: opts.mode ?? "script",
    api: opts.api,
    dropped: collector.dropped,
    collectorErrors: collector.errors,
  });
  return { analysis, paths, baseline, collector, elapsedMs };
}

/** 脚本模式 CLI：读 JSON 真值、采集、落盘、打印。 */
export async function runScript(opts) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(opts.scriptPath), "utf8");
  } catch (err) {
    throw new ArgsError("读取 --script 失败：" + (err && err.message ? err.message : String(err)));
  }
  const truths = parseScript(text, opts.scriptPath);
  const lastTruth = truths.length > 0 ? truths[truths.length - 1].tMs : 0;
  const durationMs = opts.durationMs ?? Math.max(1000, lastTruth + opts.windowMs + opts.tailMs);
  console.log("脚本模式: " + opts.scriptPath + " · 真值 " + truths.length + " 条 · 采集 " + durationMs + " ms · API " + opts.api);
  const res = await runScripted({ ...opts, truths, durationMs, mode: "script" });
  console.log(formatSummary(res.paths.summary));
  console.log("CSV: " + res.paths.csvPath);
  console.log("JSON: " + res.paths.jsonPath);
  if (res.collector.dropped > 0) console.log("⚠ 网关环丢事件 dropped=" + res.collector.dropped + "，结果可能漏检");
  return 0;
}

// ——————————————————————— 合成 E2E ———————————————————————

function spawnGateway(opts) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "gateway/src/main.ts",
    "--udp",
    "--bind", opts.bind,
    "--port", String(opts.udpPort),
    "--ws-port", String(opts.wsPort),
    "--serve",
  ], {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let logs = "";
  const append = (d) => {
    logs += String(d);
    if (logs.length > 50000) logs = logs.slice(-50000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => append("\n[spawn error] " + err.message));
  return { child, getLogs: () => logs, appRoot };
}

async function waitForHttp(api, child, getLogs, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("网关提前退出（exit=" + child.exitCode + "）：\n" + getLogs().slice(-4000));
    try {
      const r = await getJson(api + "/healthz", { timeoutMs: 1500 });
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error("等待网关 HTTP 超时 " + timeoutMs + " ms：\n" + getLogs().slice(-4000));
}

async function waitForSnapshot(api, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await getJson(api + "/api/action", { timeoutMs: 2000 });
      last = r;
      if (r.status === 200 && r.body && r.body.available === true) return r.body;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error("等待 /api/action available=true 超时；最后响应 HTTP " + (last ? last.status : "?") + " " + (last ? String(last.text).slice(0, 300) : ""));
}

function sendPacket(sock, packet, opts) {
  return new Promise((resolve, reject) => {
    sock.send(packet, opts.udpPort, opts.bind, (err) => (err ? reject(err) : resolve()));
  });
}

/** 发送一个完整 v3 帧（600×1280 B RAW）；rawByte 写到 byte23（rsvd）。 */
export async function sendV3Frame(sock, buildV3, opts) {
  const raw = opts.raw;
  if (!(raw instanceof Uint8Array) || raw.length !== FRAME_BYTES) {
    throw new ArgsError("sendV3Frame 需要 " + FRAME_BYTES + " B 的 RAW，实际 " + (raw ? raw.length : "?"));
  }
  if (!Number.isInteger(opts.frameIdx) || opts.frameIdx < 0 || opts.frameIdx > 65535) {
    throw new ArgsError("frameIdx 必须是 0..65535 的整数");
  }
  for (let chunkIdx = 0; chunkIdx < CHUNKS_PER_FRAME; chunkIdx++) {
    const packet = buildV3({
      frameIdx: opts.frameIdx,
      chunkIdx,
      raw: raw.subarray(chunkIdx * CHUNK_BYTES, (chunkIdx + 1) * CHUNK_BYTES),
      tsUs: 1_000_000 + opts.frameIdx * 1000,
      tsCalibrated: true,
      first: chunkIdx === 0,
      last: chunkIdx === CHUNKS_PER_FRAME - 1,
      mode: 0,
      rsvd: opts.rawByte & 0xff,
    });
    await sendPacket(sock, packet, opts);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

/**
 * 合成 E2E：起网关（--serve）→ 注入 no-action 完整帧建立快照 → 脚本基线 →
 * 按预置真值时间线注入动作字节 → 采集/评测 → 断言手算矩阵 → 输出 PASS/FAIL。
 * 全程只读网关 API；UDP 注入是本地测试数据源，不新增/改任何接口。
 */
export async function runE2E(opts) {
  console.log("===== 合成 E2E（action_eval --e2e）=====");
  console.log("UDP " + opts.bind + ":" + opts.udpPort + " · HTTP/WS " + opts.wsPort + " · out " + path.resolve(opts.out));
  const api = "http://127.0.0.1:" + opts.wsPort;
  let checks = 0;
  let fails = 0;
  const check = (ok, label, detail = "") => {
    checks += 1;
    if (ok) console.log("[E2E][ok] " + label);
    else {
      fails += 1;
      console.error("[E2E][FAIL] " + label + (detail ? " — " + detail : ""));
    }
  };
  let gateway = null;
  let sock = null;
  try {
    gateway = spawnGateway(opts);
    await waitForHttp(api, gateway.child, gateway.getLogs);
    check(true, "网关 HTTP /healthz 就绪");
    // 等 source.start 稳定后再注入
    await sleep(300);

    const helpers = await import(new URL("../packages/protocol/test/helpers.ts", import.meta.url).href);
    const buildV3 = helpers.buildV3;
    const raw = helpers.seq(FRAME_BYTES);
    sock = dgram.createSocket("udp4");
    const injectionOpts = {
      udpPort: opts.udpPort,
      bind: opts.bind,
    };

    // 先发 no-action 完整帧：让 ActionStore 有快照、events 接口不再 503。
    await sendV3Frame(sock, buildV3, { ...injectionOpts, raw, rawByte: 0x00, frameIdx: 0 });
    const snap = await waitForSnapshot(api);
    check(snap.available === true, "注入 no-action 帧后 /api/action available=true");

    // 预置真值：4 个动作 + 1 个无判定动作（制造一次漏检）。
    const truths = [
      { tMs: 300, class: 1, className: classLabel(1) },
      { tMs: 1100, class: 2, className: classLabel(2) },
      { tMs: 1900, class: 1, className: classLabel(1) },
      { tMs: 2700, class: 1, className: classLabel(1) },
      { tMs: 3600, class: 2, className: classLabel(2) },
    ];
    // 判定序列（相邻预测类必须不同，ActionStore 才会产事件）：
    //   50 class2 误触发；350 class1；1150 class2；1950 class1；2750 class2（对 truth4 是错分）
    const injections = [
      { atMs: 50, frameIdx: 201, cls: 2, conf: 31 },
      { atMs: 350, frameIdx: 202, cls: 1, conf: 8 },
      { atMs: 1150, frameIdx: 203, cls: 2, conf: 31 },
      { atMs: 1950, frameIdx: 204, cls: 1, conf: 8 },
      { atMs: 2750, frameIdx: 205, cls: 2, conf: 31 },
    ];
    const res = await runScripted({
      api,
      truths,
      out: opts.out,
      windowMs: opts.windowMs,
      durationMs: 4300,
      tailMs: 600,
      pollMs: opts.pollMs,
      mode: "e2e",
      log: (s) => console.log("[collector] " + s),
    }, {
      onStart: async ({ t0 }) => {
        for (const inj of injections) {
          const wait = inj.atMs - (performance.now() - t0);
          if (wait > 0) await sleep(wait);
          await sendV3Frame(sock, buildV3, {
            ...injectionOpts,
            raw,
            rawByte: makeActionByte(inj.cls, inj.conf, true),
            frameIdx: inj.frameIdx,
          });
        }
      },
    });
    const s = res.paths.summary;
    console.log(formatSummary(s));
    check(res.baseline.lastSeq === 0, "基线 lastSeq=0（旧事件被丢弃）", String(res.baseline.lastSeq));
    check(res.collector.events.length === 5, "采集到 5 条动作事件", String(res.collector.events.length));
    check(s.detectionCount === 5 && s.eventCount === 5, "检测次数接 /api/action count：Δ=5 且事件=5", "detectionCount=" + s.detectionCount + " eventCount=" + s.eventCount);
    check(s.gatewayCountStart === 0 && s.gatewayCountEnd === 5, "网关 count 0->5", "start=" + s.gatewayCountStart + " end=" + s.gatewayCountEnd);
    check(s.countMatchesEvents === true, "count 增量与长轮询事件条数一致", String(s.countMatchesEvents));
    check(s.totalPredictions === 5, "总判定数=5", String(s.totalPredictions));
    check(s.matched === 4, "窗口匹配=4", String(s.matched));
    check(s.missed === 1, "漏检=1（truth5 无判定）", String(s.missed));
    check(s.falseTriggers === 1, "误触发=1（50 ms class2）", String(s.falseTriggers));
    check(s.duplicates === 0, "重复=0", String(s.duplicates));
    check(s.wrong === 1, "错分=1（truth4 收到 class2）", String(s.wrong));
    check(s.accuracy === 0.5, "accuracy=0.5", String(s.accuracy));
    check(Math.abs(s.balancedAccuracy - 0.5833) < 0.001, "balanced accuracy≈0.5833", String(s.balancedAccuracy));
    check(s.perClass["1"].tp === 2 && s.perClass["1"].fn === 1 && s.perClass["1"].fp === 0, "class1 TP=2 FN=1 FP=0");
    check(s.perClass["1"].precision === 1 && s.perClass["1"].recall === 0.6667 && s.perClass["1"].f1 === 0.8, "class1 P/R/F1=1/0.6667/0.8");
    check(s.perClass["2"].tp === 1 && s.perClass["2"].fn === 1 && s.perClass["2"].fp === 2, "class2 TP=1 FN=1 FP=2（误触发+错分各 1）");
    check(s.perClass["2"].precision === 0.3333 && s.perClass["2"].recall === 0.5 && s.perClass["2"].f1 === 0.4, "class2 P/R/F1=0.3333/0.5/0.4");
    check(s.confusionMatrix.rows["1"]["1"] === 2 && s.confusionMatrix.rows["1"]["2"] === 1 && s.confusionMatrix.rows["1"].miss === 0, "矩阵 row1=[2,1,0,0]");
    check(s.confusionMatrix.rows["2"]["1"] === 0 && s.confusionMatrix.rows["2"]["2"] === 1 && s.confusionMatrix.rows["2"].miss === 1, "矩阵 row2=[0,1,0,1]");
    const b8 = s.confidenceBuckets.find((b) => b.label === "8-15");
    const b31 = s.confidenceBuckets.find((b) => b.label === "24-31");
    check(b8 && b8.total === 2 && b8.correct === 2, "置信度 8-15 档 total=2 correct=2", JSON.stringify(b8));
    check(b31 && b31.total === 3 && b31.correct === 1 && b31.wrong === 1 && b31.falseTrigger === 1, "置信度 24-31 档 total=3 correct=1 wrong=1 false=1", JSON.stringify(b31));
    check(s.falseTriggersPerMin > 0 && Number.isFinite(s.falseTriggersPerMin), "误触发/分钟为正有限值", String(s.falseTriggersPerMin));
    check(s.latencyMs.count === 4 && s.latencyMs.p95Ms !== null && s.latencyMs.p95Ms < opts.windowMs, "匹配延迟 n=4 且 p95 < 窗口", JSON.stringify(s.latencyMs));
    check(s.m5Acceptance.actionCount === 5 && s.m5Acceptance.pass === false, "M5 门槛（合成 5 次动作）不通过属预期", JSON.stringify(s.m5Acceptance));

    const csv = fs.readFileSync(res.paths.csvPath, "utf8");
    const csvLines = csv.trimEnd().split("\n");
    check(csvLines[0] === CSV_HEADER, "CSV 表头逐字节匹配", csvLines[0]);
    check(csvLines.length === 11, "CSV 行数=11（表头+5 truth+5 pred）", String(csvLines.length));
    const csvMatched = csvLines.slice(1).filter((l) => l.endsWith(",true")).length;
    check(csvMatched === 8, "CSV matched=true 共 8 行（4 truth + 4 pred）", String(csvMatched));
    const json = JSON.parse(fs.readFileSync(res.paths.jsonPath, "utf8"));
    check(json.accuracy === s.accuracy && json.falseTriggers === 1 && json.confusionMatrix && json.perClass && json.confidenceBuckets, "summary JSON 字段完整且可回读");
    check(json.tool === "action_eval" && json.version === VERSION && json.mode === "e2e", "summary JSON 元数据为 e2e/action_eval");
  } catch (err) {
    check(false, "E2E 执行未抛异常", err && err.message ? err.message : String(err));
    if (gateway) console.error("---- gateway logs (tail) ----\n" + gateway.getLogs().slice(-4000));
  } finally {
    if (sock) {
      try { sock.close(); } catch { /* already closed */ }
    }
    if (gateway) await stopChild(gateway.child);
  }
  console.log("E2E_RESULT=" + (fails === 0 ? "PASS" : "FAIL") + " checks=" + checks + " fails=" + fails);
  return fails === 0 ? 0 : 1;
}

// ——————————————————————— 入口 ———————————————————————

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseEvalArgs(argv);
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error("参数错误：" + err.message);
      console.error(USAGE);
      return 2;
    }
    console.error("启动失败：" + (err && err.message ? err.message : String(err)));
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    if (opts.mode === "e2e") return await runE2E(opts);
    if (opts.mode === "script") return await runScript(opts);
    return await runInteractive(opts);
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error("参数错误：" + err.message);
      return 2;
    }
    console.error("运行失败：" + (err && err.stack ? err.stack : String(err)));
    return 1;
  }
}

function isEntry() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return path.resolve(arg) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error("未捕获异常：" + (err && err.stack ? err.stack : String(err)));
    process.exitCode = 1;
  });
}
