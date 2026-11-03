#!/usr/bin/env node
/**
 * 轻量动作标注工具 —— 本地服务（静态页 + 数据 API + 视频 Range 流）。
 *
 * 设计约束（task-32）：
 *   - 零 npm 依赖：只用 node:http/fs/path/child_process，前端原生 JS + canvas + video；
 *   - 只监听 127.0.0.1，默认端口 8790（不得占用用户面板的 1234/8787）；
 *   - 只读 records/<session>/ 下的契约文件，唯一写入是 chunk-00N.labels.json；
 *   - 视频支持 Range/206（拖动进度条必需），符号链接越权用 realpath 二次校验。
 *
 * 用法：
 *   node server.mjs [--port 8790] [--root E:\workspace\FPGA_Comp\records] [--no-open]
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import * as core from "./ui/core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 8790;
export const DEFAULT_ROOT = "E:" + path.sep + "workspace" + path.sep + "FPGA_Comp" + path.sep + "records";
export const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS_JSON = 60000; // 事件只用于密度统计：超过就先服务端分桶，避免把几十万行塞进浏览器

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHUNK_VIDEO_RE = /^chunk-(\d{3})\.(video|recording)\.mp4$/i;
const CHUNK_EVENTS_RE = /^chunk-(\d{3})\.events\.csv$/i;
const CHUNK_FRAMES_RE = /^chunk-(\d{3})\.frames\.csv$/i;
const CHUNK_LABELS_RE = /^chunk-(\d{3})\.labels\.json$/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

/** 由端口号推出所有文件名（固定契约，不允许各写一套）。 */
export function chunkNames(index) {
  const base = "chunk-" + String(index).padStart(3, "0");
  return {
    index,
    video: base + ".video.mp4",
    recording: base + ".recording.mp4",
    events: base + ".events.csv",
    frames: base + ".frames.csv",
    labels: base + ".labels.json",
  };
}

export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, root: DEFAULT_ROOT, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.slice("--port=".length));
    else if (a === "--root" || a === "-r") opts.root = path.resolve(String(argv[++i] || "."));
    else if (a.startsWith("--root=")) opts.root = path.resolve(a.slice("--root=".length));
    else if (a === "--no-open") opts.open = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error("未知参数：" + a + "（可用：--port/--root/--no-open/--help）");
  }
  if (!opts.help) {
    if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) {
      throw new Error("--port 必须是 1024-65535 的整数（当前：" + opts.port + "）");
    }
    if (opts.port === 1234 || opts.port === 8787) {
      throw new Error("端口 " + opts.port + " 被用户面板占用（禁止 bind），请用默认 8790 或别的高位端口");
    }
  }
  return opts;
}

const badRequest = (msg, code) => Object.assign(new Error(msg), { status: 400, code: code || "BAD_REQUEST" });
const notFound = (msg) => Object.assign(new Error(msg || "not found"), { status: 404, code: "NOT_FOUND" });

function assertSessionName(name) {
  if (typeof name !== "string" || !SESSION_RE.test(name) || name === "." || name === "..") {
    throw badRequest("非法会话名：" + String(name), "BAD_SESSION");
  }
  return name;
}

/** 数字分段号：只接受 0-999 的整数（chunk-00N 契约）。 */
function assertChunkIndex(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 999) throw badRequest("非法分段号：" + String(raw), "BAD_CHUNK");
  return n;
}

async function readTextSafe(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJsonSafe(file) {
  const text = await readTextSafe(file);
  if (text === null) return { value: null, error: "文件不存在：" + file };
  try {
    return { value: JSON.parse(text), error: null };
  } catch (err) {
    return { value: null, error: "JSON 解析失败：" + (err && err.message ? err.message : String(err)) };
  }
}

async function statSizeSafe(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * 列会话：以目录为单位，chunks 以 chunk-00N.video.mp4 存在为准，
 * 只有 .recording.mp4 的分段标记 sealed=false（UI 显示「录制中，可能不可 seek」）。
 */
export async function listSessions(root) {
  const sessions = [];
  if (!fs.existsSync(root)) return { root, exists: false, sessions };
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    return { root, exists: true, error: err && err.message ? err.message : String(err), sessions };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!SESSION_RE.test(ent.name)) continue;
    const described = await describeSession(root, ent.name);
    if (!described.chunks.length) continue; // 没有任何 chunk-00N.(video|recording).mp4 的目录不算会话
    sessions.push(described);
  }
  sessions.sort((a, b) => String(b.startedAt || b.name).localeCompare(String(a.startedAt || a.name)));
  return { root, exists: true, sessions };
}

export async function describeSession(root, name) {
  const dir = path.join(root, name);
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    files = [];
  }
  const metaRead = await readJsonSafe(path.join(dir, "meta.json"));
  const meta = metaRead.value && typeof metaRead.value === "object" ? metaRead.value : null;
  const indices = new Set();
  for (const f of files) {
    const m = CHUNK_VIDEO_RE.exec(f) || CHUNK_EVENTS_RE.exec(f) || CHUNK_FRAMES_RE.exec(f) || CHUNK_LABELS_RE.exec(f);
    if (m) indices.add(Number(m[1]));
  }
  const metaChunks = meta && Array.isArray(meta.chunks) ? meta.chunks : [];
  for (const c of metaChunks) {
    if (c && Number.isInteger(Number(c.index))) indices.add(Number(c.index));
  }
  const chunks = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const names = chunkNames(i);
    const videoBytes = await statSizeSafe(path.join(dir, names.video));
    const recordingBytes = await statSizeSafe(path.join(dir, names.recording));
    if (videoBytes === null && recordingBytes === null) continue; // 没有任何视频的分段不列
    const merged = metaChunks.find((c) => c && Number(c.index) === i) || {};
    chunks.push({
      index: i,
      sealed: videoBytes !== null,
      video: videoBytes !== null ? names.video : null,
      recording: recordingBytes !== null ? names.recording : null,
      events: (await statSizeSafe(path.join(dir, names.events))) !== null ? names.events : null,
      frames: (await statSizeSafe(path.join(dir, names.frames))) !== null ? names.frames : null,
      labels: (await statSizeSafe(path.join(dir, names.labels))) !== null ? names.labels : null,
      videoBytes: videoBytes || 0,
      recordingBytes: recordingBytes || 0,
      framesCount: Number.isFinite(Number(merged.frames)) ? Number(merged.frames) : null,
      eventsCount: Number.isFinite(Number(merged.events)) ? Number(merged.events) : null,
      startedAt: typeof merged.startedAt === "string" ? merged.startedAt : null,
      endedAt: typeof merged.endedAt === "string" ? merged.endedAt : null,
    });
  }
  return {
    name,
    startedAt: typeof meta?.startedAt === "string" ? meta.startedAt : null,
    endedAt: typeof meta?.endedAt === "string" ? meta.endedAt : null,
    profile: typeof meta?.profile === "string" ? meta.profile : null,
    fpsNominal: core.toFiniteNumber(meta?.fpsNominal, 30) > 0 ? core.toFiniteNumber(meta?.fpsNominal, 30) : 30,
    counters: meta && typeof meta.counters === "object" ? meta.counters : null,
    metaError: meta ? null : metaRead.error,
    chunks,
  };
}

export function chunkPath(root, session, index) {
  return path.join(root, assertSessionName(session));
}

/** 读时间轴（frames.csv）：没有就返回 null，由 UI 退化成按 fps 推算。 */
async function loadFrames(root, session, index, fps) {
  const names = chunkNames(index);
  const text = await readTextSafe(path.join(chunkPath(root, session, index), names.frames));
  if (text === null || text.trim() === "") return { index: null, degraded: true, skipped: 0 };
  const parsed = core.parseFramesCsv(text);
  if (!parsed.frames.length) return { index: null, degraded: true, skipped: parsed.skipped };
  return { index: core.buildFrameIndex(parsed.frames), degraded: false, skipped: parsed.skipped, frames: parsed.frames };
}

/** 事件：只统计密度，超大文件就先按 100ms 分桶，浏览器不必吃几十万行。 */
async function loadEvents(root, session, index, t0Ms, totalMs) {
  const names = chunkNames(index);
  const text = await readTextSafe(path.join(chunkPath(root, session, index), names.events));
  if (text === null || text.trim() === "") return { total: 0, dropped: 0, bucketMs: 100, t0Ms, counts: [], truncated: false };
  const parsed = core.parseEventsCsv(text);
  const bucketMs = 100;
  if (parsed.events.length > MAX_EVENTS_JSON) {
    const agg = core.bucketEvents(parsed.events, { t0Ms, bucketMs, totalMs });
    return { total: agg.total, dropped: agg.dropped, bucketMs, t0Ms: agg.t0Ms, counts: Array.from(agg.counts), truncated: true };
  }
  const agg = core.bucketEvents(parsed.events, { t0Ms, bucketMs, totalMs });
  return {
    total: agg.total,
    dropped: agg.dropped,
    bucketMs,
    t0Ms: agg.t0Ms,
    counts: Array.from(agg.counts),
    truncated: false,
    events: parsed.events,
  };
}

/** 单个分段的完整数据（一次请求把 UI 需要的东西全给齐）。 */
export async function loadChunk(root, session, index) {
  assertSessionName(session);
  assertChunkIndex(index);
  const dir = path.join(root, session);
  if (!fs.existsSync(dir)) throw notFound("会话目录不存在：" + session);
  const names = chunkNames(index);
  const metaRead = await readJsonSafe(path.join(dir, "meta.json"));
  const meta = metaRead.value && typeof metaRead.value === "object" ? metaRead.value : null;
  const metaChunk = meta && Array.isArray(meta.chunks) ? meta.chunks.find((c) => c && Number(c.index) === index) : null;
  const fps = core.toFiniteNumber(meta?.fpsNominal, 30) > 0 ? core.toFiniteNumber(meta?.fpsNominal, 30) : 30;
  const warnings = [];

  const videoBytes = await statSizeSafe(path.join(dir, names.video));
  const recordingBytes = await statSizeSafe(path.join(dir, names.recording));
  if (videoBytes === null && recordingBytes === null) {
    throw notFound("分段 " + index + " 没有视频文件（" + names.video + " / " + names.recording + "）");
  }
  const videoFile = videoBytes !== null ? names.video : names.recording;
  if (videoBytes === null) warnings.push("该分段尚未 seal（只有 " + names.recording + "），拖动可能卡顿");

  const framesInfo = await loadFrames(root, session, index, fps);
  if (framesInfo.degraded) warnings.push("缺 " + names.frames + "：时间轴按 fps=" + fps + " 推算，frame 号为近似值");
  const t0Ms = framesInfo.index ? framesInfo.index.t0Ms : 0;
  const totalMs = framesInfo.index ? framesInfo.index.totalMs : 0;
  const ev = await loadEvents(root, session, index, t0Ms, totalMs);
  if (ev.truncated) warnings.push("事件数超过 " + MAX_EVENTS_JSON + "，已服务端按 100ms 聚合");

  const labelsText = await readTextSafe(path.join(dir, names.labels));
  const labelsCtx = { session, chunk: index, fpsNominal: fps, t0Ms, totalMs };
  // 文件不存在是正常的新会话，不是“损坏重建”；只有存在但解析失败/需迁移才提示重建。
  const parsedLabels = labelsText === null
    ? { labels: core.defaultLabels(labelsCtx), recovered: false, warnings: [] }
    : core.parseLabelsText(labelsText, labelsCtx);
  if (parsedLabels.recovered) warnings.push(...parsedLabels.warnings);

  return {
    ok: true,
    root,
    session,
    index,
    fpsNominal: fps,
    files: {
      video: videoBytes !== null ? names.video : null,
      recording: recordingBytes !== null ? names.recording : null,
      videoFile,
      events: ev.total > 0 || ev.counts.length > 0 ? names.events : null,
      frames: framesInfo.degraded ? null : names.frames,
      labels: labelsText !== null ? names.labels : null,
    },
    meta: metaChunk,
    metaError: meta ? null : metaRead.error,
    frameIndex: framesInfo.index
      ? {
          t0Ms: framesInfo.index.t0Ms,
          t1Ms: framesInfo.index.t1Ms,
          totalMs: framesInfo.index.totalMs,
          count: framesInfo.index.count,
          nonMonotonic: framesInfo.index.nonMonotonic,
        }
      : { t0Ms: 0, t1Ms: 0, totalMs: 0, count: 0, nonMonotonic: 0 },
    frames: framesInfo.frames || [],
    framesSkipped: framesInfo.skipped || 0,
    events: ev,
    labels: parsedLabels.labels,
    labelsRecovered: parsedLabels.recovered,
    warnings,
    degraded: framesInfo.degraded,
    videoUrl: "/media/" + encodeURIComponent(session) + "/" + encodeURIComponent(videoFile),
  };
}

/** 读 labels.json（不存在就返回默认结构，前端不会 404 白屏）。 */
export async function loadLabels(root, session, index) {
  assertSessionName(session);
  assertChunkIndex(index);
  const dir = path.join(root, session);
  if (!fs.existsSync(dir)) throw notFound("会话目录不存在：" + session);
  const names = chunkNames(index);
  const metaRead = await readJsonSafe(path.join(dir, "meta.json"));
  const meta = metaRead.value && typeof metaRead.value === "object" ? metaRead.value : null;
  const fps = core.toFiniteNumber(meta?.fpsNominal, 30) > 0 ? core.toFiniteNumber(meta?.fpsNominal, 30) : 30;
  const framesInfo = await loadFrames(root, session, index, fps);
  const text = await readTextSafe(path.join(dir, names.labels));
  const ctx = {
    session,
    chunk: index,
    fpsNominal: fps,
    t0Ms: framesInfo.index ? framesInfo.index.t0Ms : 0,
    totalMs: framesInfo.index ? framesInfo.index.totalMs : 0,
  };
  const parsed = text === null
    ? { labels: core.defaultLabels(ctx), recovered: false, warnings: [] }
    : core.parseLabelsText(text, ctx);
  return { file: names.labels, exists: text !== null, labels: parsed.labels, recovered: parsed.recovered, warnings: parsed.warnings };
}

/**
 * 原子写文件：tmp + rename，半截文件永远不该出现在 records 里。
 *
 * Windows 上 rename 覆盖已存在文件时，如果目标正被别的进程打开（编辑器/杀毒/测试脚本轮询读），
 * 会报 EPERM/EBUSY/EACCES。这里短暂重试几次；仍失败则退化为直接覆盖写（宁可非原子，也不能
 * 让用户刚打的标注保存失败）。
 */
async function writeFileAtomic(target, text) {
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  await fsp.writeFile(tmp, text, "utf8");
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.rename(tmp, target);
      return { atomic: true };
    } catch (err) {
      if (!(err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 + i * 60));
    }
  }
  await fsp.writeFile(target, text, "utf8");
  await fsp.rm(tmp, { force: true });
  return { atomic: false };
}

/**
 * 保存 labels.json：先归一化（钳边界/丢非法段）再原子写（tmp + rename），
 * 半截文件永远不该出现在 records 里。
 */
export async function saveLabels(root, session, index, rawLabels) {
  assertSessionName(session);
  assertChunkIndex(index);
  const dir = path.join(root, session);
  if (!fs.existsSync(dir)) throw notFound("会话目录不存在：" + session);
  const names = chunkNames(index);
  const metaRead = await readJsonSafe(path.join(dir, "meta.json"));
  const meta = metaRead.value && typeof metaRead.value === "object" ? metaRead.value : null;
  const fps = core.toFiniteNumber(meta?.fpsNominal, 30) > 0 ? core.toFiniteNumber(meta?.fpsNominal, 30) : 30;
  const framesInfo = await loadFrames(root, session, index, fps);
  const ctx = {
    session,
    chunk: index,
    fpsNominal: fps,
    t0Ms: framesInfo.index ? framesInfo.index.t0Ms : 0,
    totalMs: framesInfo.index ? framesInfo.index.totalMs : 0,
  };
  const normalized = core.normalizeLabels(rawLabels, ctx);
  const labels = normalized.labels;
  labels.updatedAt = new Date().toISOString();
  const target = path.join(dir, names.labels);
  const text = core.stringifyLabels(labels);
  const writeResult = await writeFileAtomic(target, text);
  return { file: names.labels, labels, warnings: normalized.warnings, savedAt: labels.updatedAt, bytes: Buffer.byteLength(text, "utf8"), atomic: writeResult.atomic };
}

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(text);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求体超过 " + MAX_BODY_BYTES + " 字节"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/ui/index.html", "index.html"],
  ["/ui/app.js", "app.js"],
  ["/ui/core.js", "core.js"],
  ["/ui/style.css", "style.css"],
]);

async function serveStatic(res, pathname) {
  const name = STATIC_FILES.get(pathname);
  if (!name) return false;
  const file = path.join(HERE, "ui", name);
  const text = await readTextSafe(file);
  if (text === null) return false;
  sendText(res, 200, text, MIME[path.extname(file)] || "text/plain; charset=utf-8");
  return true;
}

/** 视频流：Range -> 206/416，无 Range -> 200；realpath 必须仍在 root 里（挡符号链接越权）。 */
async function serveMedia(req, res, root, session, file) {
  assertSessionName(session);
  if (!CHUNK_VIDEO_RE.test(file)) throw badRequest("只允许 chunk-00N.video.mp4 / chunk-00N.recording.mp4：" + file, "BAD_MEDIA");
  const safeRel = core.sanitizeRelPath(session + "/" + file);
  const rootReal = await fsp.realpath(root).catch(() => path.resolve(root));
  const abs = path.join(rootReal, ...safeRel.split("/"));
  const real = await fsp.realpath(abs).catch(() => null);
  if (!real) throw notFound("视频文件不存在：" + safeRel);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw Object.assign(new Error("拒绝越权路径（realpath 跳出 root）：" + safeRel), { status: 403, code: "ESCAPE" });
  }
  const st = await fsp.stat(real);
  if (!st.isFile()) throw notFound("不是文件：" + safeRel);
  const size = st.size;
  const range = core.parseRangeHeader(req.headers.range, size);
  const response = core.rangeResponse(range, size, {
    "Content-Type": MIME["\u002emp4"] || "video/mp4",
    "Cache-Control": "no-store",
  });
  res.writeHead(response.status, response.headers);
  if (response.status === 416 || req.method === "HEAD") {
    res.end();
    return;
  }
  const opts = range && !range.error ? { start: range.start, end: range.end } : {};
  const stream = fs.createReadStream(real, opts);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** 路由：/api/*、/media/*，其余交给静态页。 */
async function route(req, res, root) {
  const u = new URL(req.url || "/", "http://" + HOST);
  const pathname = u.pathname;

  if (req.method === "GET" && (pathname === "/api/sessions" || pathname === "/api/sessions/")) {
    const list = await listSessions(root);
    sendJson(res, 200, { ok: true, ...list, defaultRoot: DEFAULT_ROOT, now: new Date().toISOString() });
    return;
  }

  const chunkMatch = /^\/api\/chunk\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (chunkMatch) {
    if (req.method !== "GET") throw Object.assign(new Error("只支持 GET"), { status: 405 });
    const session = decodeURIComponent(chunkMatch[1]);
    const index = assertChunkIndex(decodeURIComponent(chunkMatch[2]));
    const data = await loadChunk(root, session, index);
    sendJson(res, 200, data);
    return;
  }

  const labelsMatch = /^\/api\/labels\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (labelsMatch) {
    const session = decodeURIComponent(labelsMatch[1]);
    const index = assertChunkIndex(decodeURIComponent(labelsMatch[2]));
    if (req.method === "GET") {
      const data = await loadLabels(root, session, index);
      sendJson(res, 200, { ok: true, session, index, ...data });
      return;
    }
    if (req.method === "POST") {
      const text = await readBody(req);
      let body;
      try {
        body = text.trim() === "" ? null : JSON.parse(text);
      } catch (err) {
        throw badRequest("labels 请求体不是合法 JSON：" + (err && err.message ? err.message : String(err)), "BAD_JSON");
      }
      const raw = body && typeof body === "object" && body.labels && typeof body.labels === "object" ? body.labels : body;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("labels 必须是对象", "BAD_LABELS");
      const saved = await saveLabels(root, session, index, raw);
      sendJson(res, 200, { ok: true, session, index, ...saved });
      return;
    }
    throw Object.assign(new Error("只支持 GET/POST"), { status: 405 });
  }

  const mediaMatch = /^\/media\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (mediaMatch) {
    const session = decodeURIComponent(mediaMatch[1]);
    const file = decodeURIComponent(mediaMatch[2]);
    await serveMedia(req, res, root, session, file);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (await serveStatic(res, pathname)) return;
  }
  throw notFound("没有这个路径：" + pathname);
}

export async function startServer(options) {
  const opts = { port: DEFAULT_PORT, root: DEFAULT_ROOT, ...(options || {}) };
  const root = path.resolve(opts.root);
  const server = http.createServer((req, res) => {
    route(req, res, root).catch((err) => {
      const status = err && Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) console.error("[annotator] " + (err && err.stack ? err.stack : err));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : "ERROR",
      });
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, HOST);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : opts.port;
  return { server, port, root, url: "http://" + HOST + ":" + port + "/" };
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function helpText() {
  return [
    "用法：node server.mjs [--port 8790] [--root <records 目录>] [--no-open]",
    "",
    "  --port, -p   监听端口（只绑 127.0.0.1，默认 8790，禁止 1234/8787）",
    "  --root, -r   records 根目录（默认 " + DEFAULT_ROOT + "）",
    "  --no-open    不自动打开浏览器",
    "  --help, -h   显示本帮助",
  ].join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error("[annotator] " + err.message);
    console.error(helpText());
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(helpText());
    return;
  }
  let started;
  try {
    started = await startServer({ port: opts.port, root: opts.root });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      console.error("[annotator] 端口 " + opts.port + " 已被占用，换一个：node server.mjs --port 8791");
    } else {
      console.error("[annotator] 启动失败：" + (err && err.message ? err.message : err));
    }
    process.exitCode = 1;
    return;
  }
  const rootExists = fs.existsSync(opts.root);
  console.log("--------------------------------------------------------------");
  console.log(" 动作标注工具 annotator");
  console.log("   地址：" + started.url + "（只监听 127.0.0.1）");
  console.log("   根目录：" + opts.root + (rootExists ? "" : "  ← 不存在，页面会显示引导"));
  console.log("   快捷键：Alt+1..9 打标 / Space 播放 / ←→ 逐帧 / S 切分 / Ctrl+S 保存");
  console.log("   关闭窗口或 Ctrl+C 结束服务");
  console.log("--------------------------------------------------------------");
  if (opts.open) openBrowser(started.url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
