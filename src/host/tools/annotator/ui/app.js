/**
 * 标注页交互层：原生 JS + canvas + video，零依赖。
 * 纯函数（px/ms、钳制、解析、CSV、labels 迁移）都在 core.js，这里只做 DOM/画布/请求。
 *
 * 坐标系（与 core.js 一致）：
 *   - 画布/拖拽/桶：相对时间轴毫秒，0..totalMs（totalMs = 末帧 t_board_ms - 首帧 t_board_ms）；
 *   - labels.json：绝对板卡毫秒（首帧 t_board_ms + 相对值），和 frames.csv / events.csv 同刻度。
 */
import * as core from "./core.js";

const $ = (id) => document.getElementById(id);

const els = {
  sessionSelect: $("sessionSelect"),
  chunkSelect: $("chunkSelect"),
  saveStatus: $("saveStatus"),
  saveBtn: $("saveBtn"),
  exportBtn: $("exportBtn"),
  banner: $("banner"),
  bannerText: $("bannerText"),
  bannerAction: $("bannerAction"),
  video: $("video"),
  videoMeta: $("videoMeta"),
  playBtn: $("playBtn"),
  prevFrameBtn: $("prevFrameBtn"),
  nextFrameBtn: $("nextFrameBtn"),
  clock: $("clock"),
  frameInfo: $("frameInfo"),
  canvas: $("timeline"),
  zoomInfo: $("zoomInfo"),
  eventInfo: $("eventInfo"),
  fitBtn: $("fitBtn"),
  typeList: $("typeList"),
  addTypeBtn: $("addTypeBtn"),
  segCount: $("segCount"),
  segmentList: $("segmentList"),
  bareDigitToggle: $("bareDigitToggle"),
  hotkeyModeText: $("hotkeyModeText"),
  hotkeyBadge: $("hotkeyBadge"),
  statusLeft: $("statusLeft"),
  emptyState: $("emptyState"),
  emptyTitle: $("emptyTitle"),
  emptyWhy: $("emptyWhy"),
  emptyDetail: $("emptyDetail"),
  timelineHint: $("timelineHint"),
};

const TL = {
  rulerH: 24,
  densityH: 46,
  gap: 8,
  laneGap: 4,
  laneH: 26,
  minLaneH: 10,
};

const SAVE_DEBOUNCE_MS = 800;
const LS_KEY = "annotator.prefs.v1";

const state = {
  root: "",
  rootExists: false,
  sessions: [],
  sessionName: null,
  chunkIndex: null,
  chunk: null,
  labels: null,
  types: [],
  segments: [], // 相对毫秒
  index: null, // core.buildFrameIndex / synthFrameIndex
  t0Ms: 0,
  totalMs: 0,
  fpsNominal: 30,
  degraded: false,
  events: null,
  playheadMs: 0,
  selectionId: null,
  view: { startMs: 0, pxPerMs: 0.1 },
  drag: null,
  dirty: false,
  saving: false,
  saveQueued: false,
  saveTimer: 0,
  lastSavedAt: null,
  saveError: null,
  bareDigits: true,
  playRaf: 0,
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function flash(text, tone) {
  if (tone === "warn" || tone === "error") {
    showBanner(text, tone, tone === "error");
  } else {
    setStatusText(text);
  }
}

function setStatusText(text) {
  els.statusLeft.textContent = text;
}

function setSaveStatus(text, cls) {
  els.saveStatus.textContent = text;
  els.saveStatus.className = "save-status" + (cls ? " " + cls : "");
}

function showBanner(text, tone, withRetry) {
  els.bannerText.textContent = text;
  els.banner.className = "banner" + (tone === "warn" ? " warn" : "");
  els.bannerAction.classList.toggle("hidden", !withRetry);
}

function hideBanner() {
  els.banner.classList.add("hidden");
  els.bannerAction.classList.add("hidden");
}

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!target.isContentEditable;
}

function savePrefs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      bareDigits: state.bareDigits,
      session: state.sessionName,
      chunk: state.chunkIndex,
    }));
  } catch {
    /* localStorage 被禁用也无所谓 */
  }
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

function typeById(id) {
  return state.types.find((t) => t.id === id) || { id: id, name: "未知", color: "#888888" };
}

function typeSlot(types, id) {
  const list = types.slice().sort((a, b) => a.id - b.id);
  return list.findIndex((t) => t.id === id);
}

function typeColor(id) {
  return typeById(id).color || "#888";
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
  if (!m) return "rgba(136,136,136," + alpha + ")";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

function lastFrameIdx() {
  if (!state.index || !state.index.frames.length) return 0;
  return state.index.frames[state.index.frames.length - 1].frameIdx;
}

function frameForMs(relMs) {
  if (!state.index || !state.index.frames.length) return 0;
  const f = core.frameAtMs(state.index, state.t0Ms + relMs);
  return f ? f.frameIdx : 0;
}

function msForFrame(frameIdx) {
  if (!state.index || !state.index.frames.length) return 0;
  const ms = core.msAtFrame(state.index, frameIdx);
  return ms === null ? 0 : ms - state.t0Ms;
}

function currentFrame() {
  return core.videoTimeToFrame(els.video.currentTime || 0, state.fpsNominal);
}

function nearestFrameForMs(relMs) {
  if (!state.index || !state.index.frames.length) return 0;
  const f = core.nearestFrameAtMs(state.index, state.t0Ms + relMs);
  return f ? f.frameIdx : 0;
}

function clampRel(ms) {
  return core.clamp(core.toFiniteNumber(ms, 0), 0, state.totalMs > 0 ? state.totalMs : 0);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function getJson(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : "HTTP " + res.status;
    throw new Error(msg);
  }
  return data;
}

async function loadSessions() {
  setSaveStatus("加载会话…", "busy");
  try {
    const data = await getJson("/api/sessions");
    state.root = data.root || "";
    state.rootExists = !!data.exists;
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    fillSessionSelect();
    if (!state.sessions.length) {
      showEmpty(
        state.rootExists ? "根目录里还没有会话" : "根目录不存在",
        state.rootExists
          ? "已找到目录 " + state.root + "，但里面没有带 chunk-00N.video.mp4 的会话目录（录制中的分段会以 .recording.mp4 出现，也算）。"
          : "找不到目录 " + state.root + "。录制工具默认写这里；如果你的数据在别处，请用 --root 指定。",
      );
      setSaveStatus("没有数据", "");
      return;
    }
    hideEmpty();
    const prefs = readPrefs();
    const wanted = prefs && prefs.session ? state.sessions.find((s) => s.name === prefs.session) : null;
    const target = wanted && wanted.chunks.length ? wanted : state.sessions.find((s) => s.chunks.length) || state.sessions[0];
    els.sessionSelect.value = target.name;
    await loadSession(target.name, prefs && prefs.chunk);
  } catch (err) {
    showEmpty("加载失败", "请求 /api/sessions 失败：" + (err && err.message ? err.message : String(err)));
    setSaveStatus("加载失败", "error");
  }
}

function fillSessionSelect() {
  const sel = els.sessionSelect;
  sel.innerHTML = "";
  for (const s of state.sessions) {
    const opt = document.createElement("option");
    opt.value = s.name;
    const chunkCount = s.chunks.length;
    opt.textContent = s.name + "（" + chunkCount + " 段" + (s.startedAt ? " · " + s.startedAt.slice(0, 19) : "") + "）";
    sel.appendChild(opt);
  }
}

function fillChunkSelect(session, wantedIndex) {
  const sel = els.chunkSelect;
  sel.innerHTML = "";
  for (const c of session.chunks) {
    const opt = document.createElement("option");
    opt.value = String(c.index);
    const flags = [];
    if (!c.sealed) flags.push("录制中");
    if (c.labels) flags.push("有标注");
    const sizeMb = c.sealed ? c.videoBytes : c.recordingBytes;
    opt.textContent = "chunk-" + String(c.index).padStart(3, "0") + "（" + (sizeMb / 1048576).toFixed(1) + "MB" + (flags.length ? " · " + flags.join(" · ") : "") + "）";
    sel.appendChild(opt);
  }
  const found = session.chunks.find((c) => c.index === wantedIndex);
  sel.value = String(found ? found.index : session.chunks[0].index);
}

async function loadSession(name, wantedChunk) {
  const session = state.sessions.find((s) => s.name === name);
  if (!session) return;
  if (!session.chunks.length) {
    showEmpty("这个会话还没有分段", "会话 " + name + " 里没有 chunk-00N.video.mp4 / chunk-00N.recording.mp4。");
    return;
  }
  state.sessionName = name;
  fillChunkSelect(session, wantedChunk);
  await loadChunk(name, Number(els.chunkSelect.value));
}

async function loadChunk(sessionName, index) {
  const session = state.sessions.find((s) => s.name === sessionName);
  const chunkAt = session ? session.chunks.find((c) => c.index === index) : null;
  const unsealed = chunkAt ? !chunkAt.sealed : false;
  setSaveStatus("加载分段…", "busy");
  stopPlayLoop();
  try {
    const data = await getJson("/api/chunk/" + encodeURIComponent(sessionName) + "/" + index);
    state.chunk = data;
    state.sessionName = data.session;
    state.chunkIndex = data.index;
    state.fpsNominal = data.fpsNominal || 30;
    state.t0Ms = data.frameIndex ? data.frameIndex.t0Ms : 0;
    state.totalMs = data.frameIndex ? data.frameIndex.totalMs : 0;
    state.degraded = !!data.degraded;
    state.index = data.frames && data.frames.length ? core.buildFrameIndex(data.frames) : null;
    state.labels = data.labels;
    state.types = (data.labels && data.labels.types ? data.labels.types : core.defaultTypes()).slice();
    state.segments = core.segmentsFromLabels(data.labels.segments || [], {
      index: state.index,
      t0Ms: state.t0Ms,
      totalMs: state.totalMs,
      fpsNominal: state.fpsNominal,
    });
    state.selectionId = null;
    state.events = data.events || { total: 0, counts: [] };
    state.playheadMs = 0;
    state.dirty = false;
    state.saveError = null;
    state.drag = null;

    els.chunkSelect.value = String(index);
    els.video.src = data.videoUrl;
    applyFit();
    renderTypes();
    renderSegmentList();
    updateStatus();
    updatePlayheadUi();
    draw();
    hideBanner();
    if (data.warnings && data.warnings.length) showBanner(data.warnings.join("；"), "warn", false);
    setSaveStatus(data.labelsRecovered ? "labels 已重建（原文件损坏）" : data.files.labels ? "已加载标注" : "暂无标注", data.labelsRecovered ? "busy" : "");
    if (unsealed) {
      showBanner("该分段还在录制中（只有 .recording.mp4）：拖动可能卡顿，标注可以正常保存。", "warn", false);
    }
    savePrefs();
  } catch (err) {
    showEmpty("分段打不开", "请求分段数据失败：" + (err && err.message ? err.message : String(err)));
    setSaveStatus("加载失败", "error");
  }
}

// ---------------------------------------------------------------------------
// 视图 / 时间轴绘制
// ---------------------------------------------------------------------------

function canvasWidth() {
  return Math.max(2, els.canvas.clientWidth || 0);
}

function applyFit() {
  state.view = core.fitView(state.totalMs, canvasWidth());
  updateZoomInfo();
}

function updateZoomInfo() {
  const w = canvasWidth();
  els.zoomInfo.textContent = "缩放 " + (state.view.pxPerMs ? state.view.pxPerMs.toFixed(3) : "-") + " px/ms · 可见 " + core.formatSeconds(Math.min(state.totalMs, w / Math.max(state.view.pxPerMs, 1e-6)));
}

function updateStatus() {
  const c = state.chunk;
  if (!c) {
    setStatusText("");
    return;
  }
  const parts = [];
  parts.push(c.session + " / chunk-" + String(c.index).padStart(3, "0"));
  parts.push("fps " + state.fpsNominal);
  parts.push("帧 " + (state.index && state.index.count ? state.index.count : 0));
  if (state.events) parts.push("事件 " + state.events.total + (state.events.truncated ? "（已聚合）" : ""));
  parts.push("时长 " + core.formatClock(state.totalMs));
  if (state.degraded) parts.push("⚠ 退化时间轴（无 frames.csv）");
  if (c.root) parts.push("root " + c.root);
  setStatusText(parts.join("  ·  "));
  els.segCount.textContent = state.segments.length ? state.segments.length + " 个" : "（空）";
  els.timelineHint.textContent = state.degraded
    ? "无 frames.csv：时间轴按 fps 推算，frame 号为近似值"
    : "滚轮缩放 · 拖空白建段 · 拖两端改边界 · 拖中间移动";
}

function tlLayout() {
  const H = Math.max(2, els.canvas.clientHeight || 0);
  const laneTop = TL.rulerH + TL.densityH + TL.gap;
  const laneAreaH = Math.max(24, H - laneTop - 8);
  return { W: canvasWidth(), H: H, laneTop: laneTop, laneAreaH: laneAreaH };
}

function packRows(segments) {
  const sorted = core.sortSegments(segments);
  const rows = [];
  for (const seg of sorted) {
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if (seg.startMs >= last.endMs - 1) {
        row.push(seg);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([seg]);
  }
  return rows;
}

function draw() {
  const canvas = els.canvas;
  if (!canvas) return;
  const W = canvasWidth();
  const H = Math.max(2, canvas.clientHeight || 0);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  state.view = core.clampView(state.view, state.totalMs, W);
  const layout = tlLayout();
  const view = state.view;

  // 底板
  ctx.fillStyle = "#12161d";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#161c25";
  ctx.fillRect(0, 0, W, TL.rulerH);
  ctx.fillStyle = "#141a22";
  ctx.fillRect(0, TL.rulerH, W, TL.densityH);

  drawRuler(ctx, W, view);
  drawDensity(ctx, W, view, layout);
  drawSegments(ctx, W, layout, view);
  drawPlayhead(ctx, W, H, layout, view);
  drawPendingRange(ctx, W, layout, view);
}

function drawRuler(ctx, W, view) {
  const step = core.tickStepMs(view.pxPerMs, 84);
  const first = Math.floor(view.startMs / step) * step;
  ctx.strokeStyle = "#2a3341";
  ctx.beginPath();
  ctx.moveTo(0, TL.rulerH - 0.5);
  ctx.lineTo(W, TL.rulerH - 0.5);
  ctx.stroke();

  ctx.fillStyle = "#8b97a8";
  ctx.font = "11px Consolas, monospace";
  ctx.textBaseline = "middle";
  for (let t = first; ; t += step) {
    const x = core.msToPx(t, view);
    if (x > W + 1) break;
    if (x < -60) continue;
    ctx.strokeStyle = t < 0 ? "#1f2732" : "#39465a";
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, TL.rulerH - 9);
    ctx.lineTo(Math.round(x) + 0.5, TL.rulerH);
    ctx.stroke();
    if (t >= 0) ctx.fillText(core.formatClock(t), x + 4, TL.rulerH / 2 - 1);
  }
}

function drawDensity(ctx, W, view, layout, ) {
  const ev = state.events;
  const counts = ev && ev.counts ? ev.counts : [];
  const bucketMs = ev && ev.bucketMs ? ev.bucketMs : 100;
  const norm = core.logNormalizeCounts(counts);
  const baseY = TL.rulerH + TL.densityH;
  const maxH = TL.densityH - 8;
  ctx.fillStyle = "#4d8ce0";
  const bucketPx = bucketMs * view.pxPerMs;
  const w = Math.max(1, bucketPx - 1);
  for (let i = 0; i < norm.length; i++) {
    const x = core.msToPx(i * bucketMs, view);
    if (x > W) break;
    if (x + w < 0) continue;
    const h = Math.max(norm[i] > 0 ? 1 : 0, norm[i] * maxH);
    if (h <= 0) continue;
    ctx.fillRect(Math.round(x), baseY - h, w, h);
  }
  ctx.strokeStyle = "#243040";
  ctx.beginPath();
  ctx.moveTo(0, baseY - 0.5);
  ctx.lineTo(W, baseY - 0.5);
  ctx.stroke();
  ctx.fillStyle = "#6b7788";
  ctx.font = "10px Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.fillText("事件/100ms", 6, TL.rulerH + 4);
}

function drawSegments(ctx, W, layout, view) {
  const rows = packRows(state.segments);
  const total = rows.length || 0;
  const availH = layout.laneAreaH;
  let laneH = TL.laneH;
  if (total > 0) {
    const fitH = Math.floor((availH - (total - 1) * TL.laneGap) / total);
    laneH = Math.max(TL.minLaneH, Math.min(TL.laneH, fitH));
  }
  if (!total) {
    ctx.fillStyle = "#5b6675";
    ctx.font = "12px 'Microsoft YaHei', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("在下方轨道上左右拖动 → 建立片段（拖动两端改边界，拖中间移动）", 12, layout.laneTop + Math.min(30, availH / 2));
    return;
  }
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const y = layout.laneTop + r * (laneH + TL.laneGap);
    if (y > layout.H) break;
    for (const seg of row) {
      const x1 = core.msToPx(seg.startMs, view);
      const x2 = core.msToPx(seg.endMs, view);
      if (x2 < 0 || x1 > W) continue;
      const rx = Math.max(0, x1);
      const rw = Math.max(2, Math.min(W, x2) - rx);
      const selected = seg.id === state.selectionId;
      ctx.fillStyle = hexToRgba(typeColor(seg.typeId), selected ? 0.85 : 0.55);
      roundRect(ctx, rx, y, rw, laneH, 4);
      ctx.fill();
      ctx.strokeStyle = selected ? "#ffffff" : hexToRgba(typeColor(seg.typeId), 0.9);
      ctx.lineWidth = selected ? 2 : 1;
      roundRect(ctx, rx + 0.5, y + 0.5, Math.max(1, rw - 1), laneH - 1, 4);
      ctx.stroke();
      if (laneH >= 16) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx + 3, y, Math.max(0, rw - 6), laneH);
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.font = "11px 'Microsoft YaHei', sans-serif";
        ctx.textBaseline = "middle";
        const durText = Math.round(seg.endMs - seg.startMs) + "ms";
        ctx.fillText(typeById(seg.typeId).name + " · " + durText, rx + 6, y + laneH / 2 + 0.5);
        ctx.restore();
      }
      if (selected) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.max(0, x1 - 1), y, 3, laneH);
        ctx.fillRect(Math.min(W - 2, x2 - 2), y, 3, laneH);
      }
    }
  }
}

function drawPlayhead(ctx, W, H, layout, view) {
  const x = core.msToPx(state.playheadMs, view);
  if (x < -1 || x > W + 1) return;
  ctx.strokeStyle = "#ffcf5c";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, TL.rulerH - 2);
  ctx.lineTo(Math.round(x) + 0.5, H);
  ctx.stroke();
  ctx.fillStyle = "#ffcf5c";
  ctx.beginPath();
  ctx.moveTo(x - 5, TL.rulerH - 10);
  ctx.lineTo(x + 5, TL.rulerH - 10);
  ctx.lineTo(x, TL.rulerH - 2);
  ctx.closePath();
  ctx.fill();
  const label = core.formatClock(state.playheadMs);
  ctx.font = "11px Consolas, monospace";
  const tw = ctx.measureText(label).width + 10;
  const bx = Math.min(Math.max(2, x - tw / 2), W - tw - 2);
  ctx.fillStyle = "rgba(255,207,92,0.92)";
  roundRect(ctx, bx, 2, tw, 15, 3);
  ctx.fill();
  ctx.fillStyle = "#2a2105";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + 5, 10);
}

function drawPendingRange(ctx, W, layout, view) {
  const d = state.drag;
  if (!d || d.kind !== "create") return;
  const a = Math.min(d.startMs, d.curMs);
  const b = Math.max(d.startMs, d.curMs);
  const x1 = core.msToPx(a, view);
  const x2 = core.msToPx(b, view);
  ctx.fillStyle = "rgba(77,140,224,0.18)";
  ctx.fillRect(x1, layout.laneTop, Math.max(1, x2 - x1), layout.laneAreaH);
  ctx.strokeStyle = "#4d8ce0";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x1 + 0.5, layout.laneTop + 0.5, Math.max(1, x2 - x1 - 1), layout.laneAreaH - 1);
  ctx.setLineDash([]);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 类型 / 片段列表（右栏）
// ---------------------------------------------------------------------------

function renderTypes() {
  const list = els.typeList;
  list.innerHTML = "";
  const counts = new Map();
  for (const s of state.segments) counts.set(s.typeId, (counts.get(s.typeId) || 0) + 1);
  const sorted = state.types.slice().sort((a, b) => a.id - b.id);
  for (const t of sorted) {
    const li = document.createElement("li");
    li.className = "type-row" + (state.selectionId !== null && typeById(state.segments.find((s) => s.id === state.selectionId) ? state.segments.find((s) => s.id === state.selectionId).typeId : -1).id === t.id ? " selected" : "");
    const color = document.createElement("input");
    color.type = "color";
    color.className = "type-dot";
    color.value = t.color || "#888888";
    color.title = "改颜色";
    color.addEventListener("input", () => {
      t.color = color.value;
      renderTypes();
      draw();
      markDirty();
    });
    const name = document.createElement("input");
    name.type = "text";
    name.className = "type-name" + (t.id === 0 ? " locked" : "");
    name.value = t.name;
    name.maxLength = 40;
    name.readOnly = t.id === 0;
    name.title = t.id === 0 ? "「无动作」是固定类型，不能改名/删除" : "点一下就能改名";
    name.addEventListener("change", () => {
      const v = name.value.trim().slice(0, 40);
      if (!v) {
        name.value = t.name;
        return;
      }
      t.name = v;
      renderTypes();
      renderSegmentList();
      draw();
      markDirty();
    });
    const slot = typeSlot(state.types, t.id);
    const key = document.createElement("span");
    key.className = "type-key";
    key.textContent = slot >= 0 && slot <= 9 ? "Alt+" + slot : "-";
    key.title = slot === 0 ? "无动作（默认类型）" : "Alt+" + slot + " 打标";
    const cnt = document.createElement("span");
    cnt.className = "type-count";
    cnt.textContent = String(counts.get(t.id) || 0);
    li.appendChild(color);
    li.appendChild(name);
    li.appendChild(key);
    li.appendChild(cnt);
    if (t.id !== 0) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "type-del";
      del.textContent = "✕";
      del.title = t.id === 0 ? "不可删除" : "删除类型（用它标过的片段会回到「无动作」）";
      del.addEventListener("click", () => removeType(t.id));
      li.appendChild(del);
    }
    list.appendChild(li);
  }
  updateHotkeyUi();
}

function updateHotkeyUi() {
  els.bareDigitToggle.checked = state.bareDigits;
  const mode = state.bareDigits ? "Alt+数字 + 数字键" : "Alt+数字（数字键已关）";
  els.hotkeyModeText.textContent = "当前：" + mode;
  els.hotkeyBadge.textContent = state.bareDigits ? "打标：Alt+1..9（1..9 备用）" : "打标：Alt+1..9（仅 Alt）";
}

function renderSegmentList() {
  const list = els.segmentList;
  list.innerHTML = "";
  const segs = core.sortSegments(state.segments);
  els.segCount.textContent = segs.length ? segs.length + " 个" : "（空）";
  for (const seg of segs) {
    const li = document.createElement("li");
    li.className = "seg-row" + (seg.id === state.selectionId ? " selected" : "");
    const dot = document.createElement("span");
    dot.className = "type-dot";
    dot.style.background = typeColor(seg.typeId);
    const time = document.createElement("span");
    time.className = "seg-time";
    time.textContent = core.formatClock(seg.startMs) + "–" + core.formatClock(seg.endMs);
    const name = document.createElement("span");
    name.className = "seg-name";
    name.textContent = typeById(seg.typeId).name + (seg.note ? " · " + seg.note : "");
    const dur = document.createElement("span");
    dur.className = "seg-dur";
    dur.textContent = Math.round(seg.endMs - seg.startMs) + "ms";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "seg-del";
    del.textContent = "✕";
    del.title = "删除片段（Delete）";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteSegment(seg.id);
    });
    li.appendChild(dot);
    li.appendChild(time);
    li.appendChild(name);
    li.appendChild(dur);
    li.appendChild(del);
    li.addEventListener("click", () => {
      state.selectionId = seg.id;
      renderSegmentList();
      renderTypes();
      seekToMs(seg.startMs);
      draw();
    });
    list.appendChild(li);
  }
}

function addType() {
  if (state.types.length >= core.MAX_TYPES) {
    flash("动作类型最多 " + core.MAX_TYPES + " 个（含「无动作」）", "warn");
    return;
  }
  let id = 1;
  while (id < core.MAX_TYPES && state.types.some((t) => t.id === id)) id++;
  if (id >= core.MAX_TYPES) {
    flash("没有空闲的类型编号了", "warn");
    return;
  }
  const name = core.DEFAULT_TYPE_NAMES[id] || "类型" + id;
  state.types.push({ id: id, name: name, color: core.PALETTE[id] || core.PALETTE[1] });
  state.types.sort((a, b) => a.id - b.id);
  renderTypes();
  markDirty();
}

function removeType(id) {
  if (id === 0) return;
  if (state.types.length <= 2) {
    flash("至少保留一个动作类型（外加「无动作」）", "warn");
    return;
  }
  const affected = state.segments.filter((s) => s.typeId === id);
  for (const s of affected) s.typeId = 0;
  state.types = state.types.filter((t) => t.id !== id);
  renderTypes();
  renderSegmentList();
  draw();
  markDirty();
  if (affected.length) flash("已删除类型，受影响片段回到「无动作」");
}

// ---------------------------------------------------------------------------
// 片段编辑
// ---------------------------------------------------------------------------

function recomputeFrames(seg) {
  seg.startFrame = frameForMs(seg.startMs);
  seg.endFrame = frameForMs(seg.endMs);
  return seg;
}

function commitChange(text) {
  state.segments = core.sortSegments(state.segments);
  renderSegmentList();
  renderTypes();
  updateStatus();
  draw();
  markDirty();
  if (text) setStatusText(text);
}

function createSegmentAt(startMs, endMs) {
  const span = core.clampSegment(Math.min(startMs, endMs), Math.max(startMs, endMs), state.totalMs);
  if (!span) return null;
  const seg = core.makeSegment(
    { startMs: span.startMs, endMs: span.endMs, typeId: 0, id: core.nextSegmentId(state.segments) },
    { index: state.index, t0Ms: state.t0Ms, totalMs: state.totalMs, fpsNominal: state.fpsNominal },
  );
  if (!seg) return null;
  state.segments.push(seg);
  state.selectionId = seg.id;
  return seg;
}

function deleteSegment(id) {
  const before = state.segments.length;
  state.segments = state.segments.filter((s) => s.id !== id);
  if (state.segments.length === before) return;
  if (state.selectionId === id) state.selectionId = null;
  commitChange("已删除片段");
}

function deleteSelected() {
  if (state.selectionId === null) return;
  deleteSegment(state.selectionId);
}

function splitAtPlayhead() {
  const t = state.playheadMs;
  const target =
    state.segments.find((s) => s.id === state.selectionId && t > s.startMs && t < s.endMs) ||
    state.segments.find((s) => t > s.startMs && t < s.endMs);
  if (!target) {
    flash("播放头不在任何片段内，无法切分", "warn");
    return;
  }
  const parts = core.splitSegmentAt(target, t);
  if (!parts) {
    flash("切点太靠边：两侧各至少要 " + core.MIN_SEG_MS + "ms", "warn");
    return;
  }
  const idx = state.segments.findIndex((s) => s.id === target.id);
  const newId = core.nextSegmentId(state.segments);
  const left = Object.assign({}, target, { startMs: parts[0].startMs, endMs: parts[0].endMs });
  const right = Object.assign({}, target, { id: newId, startMs: parts[1].startMs, endMs: parts[1].endMs });
  recomputeFrames(left);
  recomputeFrames(right);
  state.segments[idx] = left;
  state.segments.push(right);
  state.selectionId = right.id;
  commitChange("已在播放头切分");
}

function assignTypeSlot(slot) {
  const pending = state.drag && state.drag.kind === "create" ? { startMs: Math.min(state.drag.startMs, state.drag.curMs), endMs: Math.max(state.drag.startMs, state.drag.curMs) } : null;
  const plan = core.planTypeAssign(
    {
      types: state.types,
      segments: state.segments,
      selectedIds: state.selectionId === null ? [] : [state.selectionId],
      pending: pending,
      totalMs: state.totalMs,
    },
    slot,
  );
  if (plan.action === "noop") {
    flash(plan.reason + "：先在轨道上拖出一段，或点选一个片段", "warn");
    return;
  }
  for (const s of plan.segments) recomputeFrames(s);
  state.segments = plan.segments;
  state.selectionId = plan.selectedIds.length ? plan.selectedIds[0] : state.selectionId;
  renderSegmentList();
  renderTypes();
  draw();
  markDirty();
  setStatusText(plan.reason + "（" + typeById(plan.typeId).name + "）");
}

// ---------------------------------------------------------------------------
// 保存 / 导出
// ---------------------------------------------------------------------------

function buildLabels() {
  return {
    version: 1,
    session: state.sessionName || "",
    chunk: Number.isInteger(state.chunkIndex) ? state.chunkIndex : 0,
    fpsNominal: state.fpsNominal,
    types: state.types.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    segments: core.segmentsToLabels(state.segments, state.t0Ms),
    updatedAt: new Date().toISOString(),
  };
}

function markDirty() {
  if (!state.chunk) return;
  state.dirty = true;
  state.saveError = null;
  setSaveStatus("有未保存修改…", "busy");
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = 0;
    void saveLabels("auto");
  }, SAVE_DEBOUNCE_MS);
}

async function saveLabels(reason) {
  if (!state.chunk) return;
  if (state.saving) {
    state.saveQueued = true;
    return;
  }
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
  }
  state.saving = true;
  state.dirty = false;
  setSaveStatus("保存中…", "busy");
  const body = JSON.stringify(buildLabels());
  const url = "/api/labels/" + encodeURIComponent(state.sessionName) + "/" + state.chunkIndex;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error(data && data.error ? data.error : "HTTP " + res.status);
    }
    state.labels = data.labels;
    state.lastSavedAt = data.savedAt;
    state.saveError = null;
    hideBanner();
    const t = new Date(data.savedAt || Date.now());
    setSaveStatus("已保存 " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds()), "ok");
    if (reason === "manual") setStatusText("已立即保存 labels.json");
  } catch (err) {
    state.saveError = err && err.message ? err.message : String(err);
    state.dirty = true;
    setSaveStatus("保存失败", "error");
    showBanner("保存失败：" + state.saveError + "。修改还在页面上，点右侧「重试保存」或 Ctrl+S 再试。", "error", true);
  } finally {
    state.saving = false;
    if (state.saveQueued) {
      state.saveQueued = false;
      if (state.dirty) void saveLabels("auto");
    }
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function exportCsv() {
  if (!state.chunk) return;
  const csv = core.exportSegmentsCsv(buildLabels());
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "chunk-" + String(state.chunkIndex).padStart(3, "0") + ".segments.csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  setStatusText("已导出 " + a.download + "（" + state.segments.length + " 个片段）");
}

// ---------------------------------------------------------------------------
// 播放 / 定位
// ---------------------------------------------------------------------------

function seekToMs(relMs) {
  const ms = clampRel(relMs);
  // 定位用时间上最接近的帧；labels 边界仍按「不晚于该时刻」的帧记录（见 core.frameAtMs）
  const frame = nearestFrameForMs(ms);
  const t = core.frameToVideoTime(frame, state.fpsNominal);
  try {
    if (Number.isFinite(t)) els.video.currentTime = t;
  } catch {
    /* 元数据还没到，忽略 */
  }
  state.playheadMs = ms;
  updatePlayheadUi();
  draw();
}

function stepFrames(delta) {
  const last = lastFrameIdx();
  const next = core.clamp(currentFrame() + delta, 0, last);
  const t = core.frameToVideoTime(next, state.fpsNominal);
  try {
    els.video.currentTime = t;
  } catch {
    return;
  }
  state.playheadMs = clampRel(msForFrame(next));
  updatePlayheadUi();
  draw();
}

function togglePlay() {
  if (els.video.paused) {
    const p = els.video.play();
    if (p && typeof p.catch === "function") p.catch(() => flash("浏览器拒绝播放（需要用户交互或视频未就绪）", "warn"));
  } else {
    els.video.pause();
  }
}

function updatePlayheadUi() {
  const frame = frameForMs(state.playheadMs);
  els.clock.textContent = core.formatClock(state.playheadMs);
  els.frameInfo.textContent = "frame " + frame + " / " + lastFrameIdx() + (state.degraded ? " · 退化时间轴" : "");
  els.playBtn.textContent = els.video.paused ? "▶" : "⏸";
  els.playBtn.title = els.video.paused ? "播放（Space）" : "暂停（Space）";
}

function onVideoTime() {
  if (!state.index) return;
  const frame = core.videoTimeToFrame(els.video.currentTime || 0, state.fpsNominal);
  state.playheadMs = clampRel(msForFrame(frame));
  updatePlayheadUi();
  draw();
}

function startPlayLoop() {
  stopPlayLoop();
  const tick = () => {
    onVideoTime();
    state.playRaf = requestAnimationFrame(tick);
  };
  state.playRaf = requestAnimationFrame(tick);
}

function stopPlayLoop() {
  if (state.playRaf) cancelAnimationFrame(state.playRaf);
  state.playRaf = 0;
}

function ensureDegradedIndex() {
  const hasFrames = state.index && state.index.frames && state.index.frames.length;
  if (hasFrames) return false;
  const dur = Number.isFinite(els.video.duration) ? els.video.duration : 0;
  state.index = core.synthFrameIndex(dur, state.fpsNominal);
  state.t0Ms = 0;
  state.totalMs = state.index.totalMs;
  state.segments = core.segmentsFromLabels(state.labels && state.labels.segments ? state.labels.segments : [], {
    index: state.index,
    t0Ms: 0,
    totalMs: state.totalMs,
    fpsNominal: state.fpsNominal,
  });
  applyFit();
  updateStatus();
  return true;
}

// ---------------------------------------------------------------------------
// 画布交互
// ---------------------------------------------------------------------------

function canvasPoint(ev) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev) {
  if (!state.chunk || !state.totalMs) return;
  if (ev.button !== 0) return;
  const p = canvasPoint(ev);
  const layout = tlLayout();
  const ms = core.pxToMs(p.x, state.view);
  try {
    els.canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* 某些浏览器/测试环境不支持，忽略 */
  }
  if (p.y < layout.laneTop) {
    state.drag = { kind: "seekpan", x0: p.x, viewStart: state.view.startMs, ms0: ms, moved: false };
    return;
  }
  const tolMs = Math.max(1, 7 / Math.max(state.view.pxPerMs, 1e-6));
  const hit = core.hitTestSegments(state.segments, ms, tolMs);
  if (hit) {
    const seg = state.segments.find((s) => s.id === hit.id);
    if (!seg) return;
    state.selectionId = seg.id;
    state.drag = {
      kind: hit.part === "body" ? "move" : "resize",
      id: seg.id,
      edge: hit.part,
      ms0: ms,
      startMs: seg.startMs,
      endMs: seg.endMs,
    };
    renderSegmentList();
    renderTypes();
    draw();
    return;
  }
  state.drag = { kind: "create", startMs: ms, curMs: ms };
  state.selectionId = null;
  renderSegmentList();
  renderTypes();
  draw();
}

function onPointerMove(ev) {
  const p = canvasPoint(ev);
  const layout = tlLayout();
  const ms = core.pxToMs(p.x, state.view);
  const d = state.drag;
  if (!d) {
    updateCursor(p, layout, ms);
    return;
  }
  if (d.kind === "seekpan") {
    if (Math.abs(p.x - d.x0) > 3) d.moved = true;
    if (d.moved) {
      state.view = core.clampView(
        { startMs: d.viewStart - (p.x - d.x0) / Math.max(state.view.pxPerMs, 1e-6), pxPerMs: state.view.pxPerMs },
        state.totalMs,
        canvasWidth(),
      );
      updateZoomInfo();
      draw();
    }
    return;
  }
  if (d.kind === "create") {
    d.curMs = ms;
    draw();
    return;
  }
  if (d.kind === "move") {
    const span = core.moveSegment({ startMs: d.startMs, endMs: d.endMs }, ms - d.ms0, state.totalMs);
    if (!span) return;
    const seg = state.segments.find((s) => s.id === d.id);
    if (!seg) return;
    seg.startMs = span.startMs;
    seg.endMs = span.endMs;
    recomputeFrames(seg);
    draw();
    return;
  }
  if (d.kind === "resize") {
    const span = core.resizeSegment({ startMs: d.startMs, endMs: d.endMs }, d.edge, ms, state.totalMs);
    if (!span) return;
    const seg = state.segments.find((s) => s.id === d.id);
    if (!seg) return;
    seg.startMs = span.startMs;
    seg.endMs = span.endMs;
    recomputeFrames(seg);
    draw();
  }
}

function updateCursor(p, layout, ms) {
  if (p.y < layout.laneTop) {
    els.canvas.style.cursor = "default";
    return;
  }
  const tolMs = Math.max(1, 7 / Math.max(state.view.pxPerMs, 1e-6));
  const hit = core.hitTestSegments(state.segments, ms, tolMs);
  if (!hit) {
    els.canvas.style.cursor = "crosshair";
    return;
  }
  els.canvas.style.cursor = hit.part === "body" ? "grab" : "ew-resize";
}

function onPointerUp(ev) {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.kind === "seekpan") {
    if (!d.moved) seekToMs(d.ms0);
    return;
  }
  if (d.kind === "create") {
    const a = Math.min(d.startMs, d.curMs);
    const b = Math.max(d.startMs, d.curMs);
    if (b - a < core.MIN_SEG_MS) {
      draw();
      return;
    }
    const seg = createSegmentAt(a, b);
    if (!seg) {
      draw();
      return;
    }
    commitChange("已建片段（typeId=0 无动作）：按 Alt+1..9 选类型");
    return;
  }
  if (d.kind === "move" || d.kind === "resize") {
    commitChange(d.kind === "move" ? "已移动片段" : "已改片段边界");
  }
}

function onPointerCancel() {
  state.drag = null;
  draw();
}

function onWheel(ev) {
  if (!state.totalMs) return;
  ev.preventDefault();
  const p = canvasPoint(ev);
  const factor = Math.exp(-ev.deltaY * 0.0016);
  state.view = core.zoomViewAt(state.view, factor, p.x, state.totalMs, canvasWidth());
  updateZoomInfo();
  draw();
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

function onKeyDown(ev) {
  if (ev.defaultPrevented) return;
  if (isTypingTarget(ev.target)) return;
  if (!state.chunk) return;

  if (ev.ctrlKey || ev.metaKey) {
    if (ev.key === "s" || ev.key === "S") {
      ev.preventDefault();
      void saveLabels("manual");
    }
    return;
  }

  if (ev.key === " ") {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    const dir = ev.key === "ArrowLeft" ? -1 : 1;
    stepFrames(dir * (ev.shiftKey ? 10 : 1));
    return;
  }
  if (ev.key === "s" || ev.key === "S") {
    ev.preventDefault();
    splitAtPlayhead();
    return;
  }
  if (ev.key === "Delete" || ev.key === "Backspace") {
    if (state.selectionId !== null) {
      ev.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (ev.key === "Escape") {
    state.drag = null;
    state.selectionId = null;
    renderSegmentList();
    renderTypes();
    draw();
    return;
  }
  const slot = core.hotkeySlotFromEvent(ev);
  if (slot !== null) {
    if (!ev.altKey && !state.bareDigits) return;
    ev.preventDefault();
    assignTypeSlot(slot);
  }
}

// ---------------------------------------------------------------------------
// 空状态
// ---------------------------------------------------------------------------

function showEmpty(title, why) {
  els.emptyTitle.textContent = title;
  els.emptyWhy.textContent = why;
  els.emptyDetail.textContent = "";
  els.emptyState.classList.remove("hidden");
}

function hideEmpty() {
  els.emptyState.classList.add("hidden");
}

function showEmptyFatal(err) {
  els.emptyDetail.textContent = err && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function bindEvents() {
  els.sessionSelect.addEventListener("change", () => {
    const name = els.sessionSelect.value;
    void (async () => {
      if (state.dirty) await saveLabels("auto");
      await loadSession(name, null);
    })();
  });
  els.chunkSelect.addEventListener("change", () => {
    const idx = Number(els.chunkSelect.value);
    void (async () => {
      if (state.dirty) await saveLabels("auto");
      await loadChunk(state.sessionName, idx);
    })();
  });
  els.saveBtn.addEventListener("click", () => void saveLabels("manual"));
  els.exportBtn.addEventListener("click", exportCsv);
  els.fitBtn.addEventListener("click", () => {
    applyFit();
    draw();
  });
  els.playBtn.addEventListener("click", togglePlay);
  els.prevFrameBtn.addEventListener("click", () => stepFrames(-1));
  els.nextFrameBtn.addEventListener("click", () => stepFrames(1));
  els.addTypeBtn.addEventListener("click", addType);
  els.bareDigitToggle.addEventListener("change", () => {
    state.bareDigits = els.bareDigitToggle.checked;
    updateHotkeyUi();
    savePrefs();
  });
  els.bannerAction.addEventListener("click", () => void saveLabels("manual"));
  els.canvas.addEventListener("pointerdown", onPointerDown);
  els.canvas.addEventListener("pointermove", onPointerMove);
  els.canvas.addEventListener("pointerup", onPointerUp);
  els.canvas.addEventListener("pointercancel", onPointerCancel);
  els.canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", () => draw());
  window.addEventListener("beforeunload", (ev) => {
    if (state.dirty) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
  els.video.addEventListener("loadedmetadata", () => {
    const dur = Number.isFinite(els.video.duration) ? els.video.duration : 0;
    const metaParts = [els.video.videoWidth + "×" + els.video.videoHeight, core.formatSeconds(dur * 1000)];
    if (!state.index || !state.index.count) metaParts.push("无 frames.csv");
    els.videoMeta.textContent = metaParts.join(" · ");
    if (ensureDegradedIndex()) {
      renderSegmentList();
      renderTypes();
      state.segments.forEach((s) => recomputeFrames(s));
      draw();
    }
  });
  els.video.addEventListener("timeupdate", onVideoTime);
  els.video.addEventListener("play", () => {
    startPlayLoop();
    updatePlayheadUi();
  });
  els.video.addEventListener("pause", () => {
    stopPlayLoop();
    updatePlayheadUi();
  });
  els.video.addEventListener("seeked", onVideoTime);
  els.video.addEventListener("error", () => {
    flash("视频加载失败：文件可能还在录制/未 seal，或浏览器不支持这个编码", "error");
  });
}

function init() {
  const prefs = readPrefs();
  state.bareDigits = prefs && typeof prefs.bareDigits === "boolean" ? prefs.bareDigits : true;
  els.typeList.innerHTML = "";
  els.segmentList.innerHTML = "";
  bindEvents();
  updateHotkeyUi();
  updatePlayheadUi();
  draw();
  void loadSessions();
}

init();
