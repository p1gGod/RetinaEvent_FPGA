// 标注工具的核心纯函数：不 import 任何 node:* 模块，浏览器和 node --test 都能直接加载。
//
// 分三块：
//   1) 时间轴视图换算（px <-> ms、缩放钳制、平移）
//   2) 片段几何（建段/移动/改边界/命中判定/切分）
//   3) 数据契约解析（frames.csv / events.csv / labels.json / Range 请求头）
//
// 之所以把 Range 解析放在这里：服务端和自检脚本要共用同一份实现，
// "206 响应头怎么拼" 这种细节一旦两处各写一遍，迟早对不上。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 片段最短时长（ms）。比一帧（30fps≈33ms）留一点余量，避免建出零宽片段。 */
export const MIN_SEG_MS = 40;

/** 动作类型槽位上限：Alt+1..9 共 9 个可编辑类型 + id=0 的「无动作」。 */
export const MAX_TYPES = 10;

/** 缩放上限：1ms 最多铺 4px。 */
export const MAX_PX_PER_MS = 4;

/** 缩放下限相对「适应窗口」的倍数：允许缩到刚好看到 2 倍时长，再多就没意义。 */
export const MIN_ZOOM_FACTOR = 0.5;

/** 默认类型颜色：下标即类型槽位。 */
export const PALETTE = Object.freeze([
  "#8a8f98", // 0 无动作（灰）
  "#e06c75",
  "#61afef",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#f5a97f",
  "#7f9cf5",
  "#a3be8c",
]);

/** 默认类型名：0 = 无动作，1..9 = 动作一..动作九。 */
export const DEFAULT_TYPE_NAMES = Object.freeze([
  "无动作",
  "动作一",
  "动作二",
  "动作三",
  "动作四",
  "动作五",
  "动作六",
  "动作七",
  "动作八",
  "动作九",
]);

/** 事件密度桶默认宽度（ms）。 */
export const DEFAULT_BUCKET_MS = 100;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function toFiniteNumber(v, fallback) {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 毫秒 -> 01:23.456（时间轴刻度与读数用）。 */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return "--:--.---";
  const sign = ms < 0 ? "-" : "";
  const v = Math.abs(ms);
  const totalSec = Math.floor(v / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const mmm = Math.round(v % 1000);
  const pad = (n, w) => String(n).padStart(w, "0");
  return sign + pad(mm, 2) + ":" + pad(ss, 2) + "." + pad(mmm, 3);
}

/** 毫秒 -> 1.234s（片段列表里更紧凑）。 */
export function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return "?";
  return (ms / 1000).toFixed(3) + "s";
}

// ---------------------------------------------------------------------------
// 1) 视图换算
// ---------------------------------------------------------------------------
//
// view = { startMs, pxPerMs }：startMs 是画布左边缘对应的时间轴毫秒。
// totalMs 是该分段的时长（t1Ms - t0Ms）。

/** 画布 x(px) -> 时间轴 ms。 */
export function pxToMs(x, view) {
  return view.startMs + x / view.pxPerMs;
}

/** 时间轴 ms -> 画布 x(px)。 */
export function msToPx(ms, view) {
  return (ms - view.startMs) * view.pxPerMs;
}

/** 适应窗口：整段铺满 widthPx。 */
export function fitView(totalMs, widthPx) {
  const span = Math.max(toFiniteNumber(totalMs, 0), 1);
  const width = Math.max(toFiniteNumber(widthPx, 0), 1);
  return clampView({ startMs: 0, pxPerMs: width / span }, totalMs, widthPx);
}

/**
 * 视图钳制：pxPerMs 与 startMs 都要落在合法区间内。
 *
 * - 缩放：pxPerMs ∈ [fit*MIN_ZOOM_FACTOR, MAX_PX_PER_MS]
 * - 平移：看得见整段时居中；否则 startMs ∈ [0, totalMs - visibleMs]
 */
export function clampView(view, totalMs, widthPx) {
  const total = toFiniteNumber(totalMs, 0);
  const width = Math.max(toFiniteNumber(widthPx, 0), 1);
  if (total <= 0) {
    const pxPerMs = clamp(toFiniteNumber(view && view.pxPerMs, width), 1e-6, MAX_PX_PER_MS);
    return { startMs: 0, pxPerMs, visibleMs: width / pxPerMs, totalMs: 0 };
  }
  const fitPxPerMs = width / total;
  const minPxPerMs = Math.min(fitPxPerMs * MIN_ZOOM_FACTOR, MAX_PX_PER_MS);
  const pxPerMs = clamp(toFiniteNumber(view && view.pxPerMs, fitPxPerMs), Math.min(minPxPerMs, MAX_PX_PER_MS), MAX_PX_PER_MS);
  const visibleMs = width / pxPerMs;
  let startMs;
  if (visibleMs >= total) {
    // 整段都看得见：居中摆放，两侧留等宽空白的观感最好。
    startMs = (total - visibleMs) / 2;
  } else {
    startMs = clamp(toFiniteNumber(view && view.startMs, 0), 0, total - visibleMs);
  }
  return { startMs, pxPerMs, visibleMs, totalMs: total };
}

/** 以 anchorX 处的时刻为锚点缩放（滚轮缩放手感的关键：光标下的时刻不动）。 */
export function zoomViewAt(view, factor, anchorX, totalMs, widthPx) {
  const f = toFiniteNumber(factor, 1);
  if (!(f > 0)) return clampView(view, totalMs, widthPx);
  const anchorMs = pxToMs(anchorX, view);
  const nextPxPerMs = view.pxPerMs * f;
  return clampView({ startMs: anchorMs - anchorX / nextPxPerMs, pxPerMs: nextPxPerMs }, totalMs, widthPx);
}

/** 平移 dxPx（正数 = 内容向左走，看更晚的时间）。 */
export function panViewBy(view, dxPx, totalMs, widthPx) {
  const shift = toFiniteNumber(dxPx, 0) / view.pxPerMs;
  return clampView({ startMs: view.startMs + shift, pxPerMs: view.pxPerMs }, totalMs, widthPx);
}

/** 刻度步长：挑一个「像素间距 >= minPx」的最小候选值，保证刻度不挤在一起。 */
export function tickStepMs(pxPerMs, minPx = 72) {
  const candidates = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  const px = toFiniteNumber(pxPerMs, 0);
  if (!(px > 0)) return candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c * px >= minPx) return c;
  }
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// 2) 片段几何
// ---------------------------------------------------------------------------

/**
 * 把 (startMs,endMs) 钳到 [0,totalMs] 且保证 end>start。
 * 反序入参会被自动摆正；放不下（totalMs < minMs）时退化为整段。
 * totalMs<=0 时返回 null —— 空分段不该产生片段。
 */
export function clampSegment(startMs, endMs, totalMs, minMs = MIN_SEG_MS) {
  const total = toFiniteNumber(totalMs, 0);
  const min = Math.max(toFiniteNumber(minMs, MIN_SEG_MS), 1);
  if (!(total > 0)) return null;
  let s = clamp(toFiniteNumber(startMs, 0), 0, total);
  let e = clamp(toFiniteNumber(endMs, 0), 0, total);
  if (e < s) {
    const t = s;
    s = e;
    e = t;
  }
  if (e - s < min) {
    e = Math.min(total, s + min);
    if (e - s < min) s = Math.max(0, e - min);
  }
  if (!(e > s)) return null;
  return { startMs: s, endMs: e };
}

/**
 * 绝对时间 -> 相对时间轴的钳制。
 *
 * 坐标系约定（重要，README 与 labels.json 都按这个说法）：
 *   - 时间轴内部（画布/桶/拖拽）用「相对该分段首帧 t_board_ms 的偏移」，即 0..totalMs；
 *   - labels.json 的 startMs/endMs 用**绝对板卡毫秒**，和 frames.csv 的 t_board_ms、
 *     events.csv 的 frame_t_ms 同一个坐标系，下游可以直接做区间比较。
 * 这个函数负责把「绝对区间」安全地落到相对区间，返回 { startMs, endMs }（相对）。
 */
export function clampSpanToDomain(startAbs, endAbs, t0Ms, totalMs, minMs = MIN_SEG_MS) {
  const t0 = toFiniteNumber(t0Ms, 0);
  const total = toFiniteNumber(totalMs, 0);
  const limit = total > 0 ? total : Number.MAX_SAFE_INTEGER;
  const span = clampSegment(toFiniteNumber(startAbs, 0) - t0, toFiniteNumber(endAbs, 0) - t0, limit, minMs);
  if (!span) return null;
  return { startMs: span.startMs, endMs: span.endMs };
}

/** 相对时间轴 -> 绝对板卡毫秒（labels.json 落盘用）。 */
export function relToAbs(relMs, t0Ms) {
  return toFiniteNumber(relMs, 0) + toFiniteNumber(t0Ms, 0);
}

/** 绝对板卡毫秒 -> 相对时间轴。 */
export function absToRel(absMs, t0Ms) {
  return toFiniteNumber(absMs, 0) - toFiniteNumber(t0Ms, 0);
}

/** 平移整段（长度不变），撞到两端就贴边。 */
export function moveSegment(seg, deltaMs, totalMs, minMs = MIN_SEG_MS) {
  const base = clampSegment(seg.startMs, seg.endMs, totalMs, minMs);
  if (!base) return null;
  const total = toFiniteNumber(totalMs, 0);
  const span = base.endMs - base.startMs;
  const start = clamp(base.startMs + toFiniteNumber(deltaMs, 0), 0, Math.max(0, total - span));
  return { startMs: start, endMs: start + span };
}

/**
 * 拖某一端改边界。edge: "start" | "end"。
 * 拖动过程中另一端固定，且新边界不得越过另一端 minMs。
 */
export function resizeSegment(seg, edge, atMs, totalMs, minMs = MIN_SEG_MS) {
  const base = clampSegment(seg.startMs, seg.endMs, totalMs, minMs);
  if (!base) return null;
  const min = Math.max(toFiniteNumber(minMs, MIN_SEG_MS), 1);
  const total = toFiniteNumber(totalMs, 0);
  const t = clamp(toFiniteNumber(atMs, 0), 0, total);
  if (edge === "start") {
    const start = clamp(t, 0, Math.max(0, base.endMs - min));
    return { startMs: start, endMs: base.endMs };
  }
  if (edge === "end") {
    const end = clamp(t, Math.min(total, base.startMs + min), total);
    return { startMs: base.startMs, endMs: end };
  }
  return base;
}

/**
 * 命中判定。edges 优先于 body（两端各 tolMs 宽的热区），
 * 因为改边界比整段拖拽更容易被误触，得让它优先。
 */
export function hitTestSegments(segments, atMs, tolMs = 6) {
  const tol = Math.max(toFiniteNumber(tolMs, 0), 0);
  const t = toFiniteNumber(atMs, NaN);
  if (!Number.isFinite(t) || !Array.isArray(segments)) return null;
  for (const seg of segments) {
    if (Math.abs(t - seg.startMs) <= tol) return { id: seg.id, part: "start" };
    if (Math.abs(t - seg.endMs) <= tol) return { id: seg.id, part: "end" };
  }
  for (const seg of segments) {
    if (t > seg.startMs + tol && t < seg.endMs - tol) return { id: seg.id, part: "body" };
  }
  return null;
}

/** 在 atMs 处切分；切点太靠边（两侧都会短于 minMs）则返回 null。 */
export function splitSegmentAt(seg, atMs, minMs = MIN_SEG_MS) {
  const min = Math.max(toFiniteNumber(minMs, MIN_SEG_MS), 1);
  const t = toFiniteNumber(atMs, NaN);
  if (!Number.isFinite(t)) return null;
  if (t <= seg.startMs + min || t >= seg.endMs - min) return null;
  return [
    { startMs: seg.startMs, endMs: t },
    { startMs: t, endMs: seg.endMs },
  ];
}

/** 下一个可用片段 id（删除后不复用，避免下游按 id 做删除比对时串号）。 */
export function nextSegmentId(segments) {
  let max = 0;
  for (const s of segments || []) {
    const n = toFiniteNumber(s && s.id, 0);
    if (n > max) max = n;
  }
  return max + 1;
}

export function sortSegments(segments) {
  return (segments || []).slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// ---------------------------------------------------------------------------
// 3) 快捷键
// ---------------------------------------------------------------------------

/**
 * 键盘事件 -> 类型槽位（1..9）。返回 null 表示这次按键不是打标。
 *
 * - 数字键 1..9：Alt+数字 是主路径；无修饰数字键作为备用（部分浏览器/输入法会吞掉 Alt+数字）。
 * - Ctrl/Meta 组合一律不碰（Ctrl+1 是浏览器切标签页）。
 * - Shift 组合不认（Shift+1 出来的是 "!"，key 已经不是数字了）。
 */
export function hotkeySlotFromEvent(ev) {
  if (!ev || typeof ev.key !== "string") return null;
  if (ev.ctrlKey || ev.metaKey) return null;
  if (!/^[1-9]$/.test(ev.key)) return null;
  return Number(ev.key);
}

/**
 * 槽位 -> typeId。types 按 id 升序排列，槽位 0 是「无动作」，槽位 N 是 types[N]。
 * 没有这个类型（用户删过）就返回 null。
 */
export function typeIdForSlot(types, slot) {
  const list = Array.isArray(types) ? types.slice().sort((a, b) => a.id - b.id) : [];
  const s = toFiniteNumber(slot, -1);
  if (!Number.isInteger(s) || s < 0 || s >= list.length) return null;
  return list[s].id;
}

/**
 * 打标决策（纯函数，UI 只负责把结果落到 DOM/画布上）：
 *   1. 有选中片段 -> 改这些片段的 typeId
 *   2. 没选中但有选区 -> 先按选区建段，再赋类型
 *   3. 都没有 -> noop（UI 给出提示）
 *
 * 返回值里的 segments 是**新数组**，不修改入参。
 */
export function planTypeAssign(input, slot) {
  const types = Array.isArray(input && input.types) ? input.types : [];
  const segments = Array.isArray(input && input.segments) ? input.segments : [];
  const selectedIds = Array.isArray(input && input.selectedIds) ? input.selectedIds : [];
  const totalMs = toFiniteNumber(input && input.totalMs, 0);
  const typeId = typeIdForSlot(types, slot);
  if (typeId === null) {
    return { action: "noop", reason: "槽位 " + slot + " 没有可用动作类型", segments, selectedIds, typeId: null };
  }
  if (selectedIds.length > 0) {
    const next = segments.map((s) => (selectedIds.includes(s.id) ? { ...s, typeId } : s));
    return { action: "assign", reason: "已赋类型", segments: next, selectedIds: selectedIds.slice(), typeId };
  }
  const pending = input && input.pending;
  if (pending) {
    const span = clampSegment(pending.startMs, pending.endMs, totalMs);
    if (span) {
      const id = nextSegmentId(segments);
      const seg = { id, startMs: span.startMs, endMs: span.endMs, typeId, note: "", startFrame: null, endFrame: null };
      return { action: "create", reason: "已按选区建段并赋类型", segments: sortSegments(segments.concat([seg])), selectedIds: [id], typeId, created: seg };
    }
  }
  return { action: "noop", reason: "没有选中片段，也没有选区", segments, selectedIds, typeId };
}

// ---------------------------------------------------------------------------
// 4) 事件密度
// ---------------------------------------------------------------------------

/**
 * 事件按 bucketMs 分桶计数。
 * events: [{ tMs }]（时间轴毫秒，已对齐到 frames.csv 的 t_board_ms 坐标系）
 * opts: { t0Ms, bucketMs, totalMs, maxBuckets }
 * 返回 Uint32Array（空输入返回全 0 的数组，长度由 totalMs 决定）。
 */
export function bucketEvents(events, opts = {}) {
  const bucketMs = Math.max(toFiniteNumber(opts.bucketMs, DEFAULT_BUCKET_MS), 1);
  const t0Ms = toFiniteNumber(opts.t0Ms, 0);
  const maxBuckets = Math.max(toFiniteNumber(opts.maxBuckets, 200000), 1);
  const totalMs = toFiniteNumber(opts.totalMs, 0);
  let count = totalMs > 0 ? Math.ceil(totalMs / bucketMs) : 0;
  const list = Array.isArray(events) ? events : [];
  if (count <= 0) {
    // 没有 totalMs 时按事件自身范围定桶数（至少 1 桶，避免空数组长度为 0 时下游除零）。
    let maxT = t0Ms;
    for (const ev of list) {
      const t = toFiniteNumber(ev && ev.tMs, NaN);
      if (Number.isFinite(t) && t > maxT) maxT = t;
    }
    count = Math.max(1, Math.ceil((maxT - t0Ms + 1) / bucketMs));
  }
  count = Math.min(count, maxBuckets);
  const counts = new Uint32Array(count);
  let total = 0;
  let dropped = 0;
  for (const ev of list) {
    const t = toFiniteNumber(ev && ev.tMs, NaN);
    if (!Number.isFinite(t)) {
      dropped++;
      continue;
    }
    let idx = Math.floor((t - t0Ms) / bucketMs);
    if (idx < 0) idx = 0;
    if (idx >= count) idx = count - 1;
    counts[idx]++;
    total++;
  }
  return { counts, bucketMs, t0Ms, buckets: count, total, dropped, totalMs: count * bucketMs };
}

/** 对数归一化（log1p / max），返回 0..1 的 Float32Array，给柱状图定高度。 */
export function logNormalizeCounts(counts) {
  const n = counts && counts.length ? counts.length : 0;
  const out = new Float32Array(n);
  if (!n) return out;
  let maxLog = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.log1p(counts[i]);
    out[i] = v;
    if (v > maxLog) maxLog = v;
  }
  if (maxLog <= 0) return out; // 全 0：柱高 0，不除零
  for (let i = 0; i < n; i++) out[i] = out[i] / maxLog;
  return out;
}

// ---------------------------------------------------------------------------
// 5) frames.csv / events.csv 解析
// ---------------------------------------------------------------------------

export const FRAMES_HEADER = "frame_idx,t_board_ms,t_arrive_ms";
export const EVENTS_HEADER = "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts";

/** 去掉 BOM，按 CRLF/LF/CR 切行，丢掉空行。 */
export function splitCsvLines(text) {
  if (typeof text !== "string") return [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function looksLikeHeader(cells) {
  return cells.some((c) => /^[A-Za-z_]/.test(c));
}

/**
 * frames.csv -> [{ frameIdx, tBoardMs, tArriveMs }]
 * 表头行自动跳过；坏行（字段不够/非数字）跳过并计数，不抛异常
 * —— 录制中途断电留下的半行不该让标注工具打不开。
 */
export function parseFramesCsv(text) {
  const rows = splitCsvLines(text);
  const frames = [];
  const warnings = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0 && looksLikeHeader(row.split(","))) continue;
    const cells = row.split(",").map((c) => c.trim());
    if (cells.length < 3) {
      skipped++;
      continue;
    }
    const frameIdx = toFiniteNumber(cells[0], NaN);
    const tBoardMs = toFiniteNumber(cells[1], NaN);
    const tArriveMs = toFiniteNumber(cells[2], NaN);
    if (!Number.isFinite(frameIdx) || !Number.isFinite(tBoardMs)) {
      skipped++;
      continue;
    }
    frames.push({ frameIdx, tBoardMs, tArriveMs: Number.isFinite(tArriveMs) ? tArriveMs : tBoardMs });
  }
  if (skipped > 0) warnings.push("frames.csv 跳过 " + skipped + " 行坏数据");
  return { frames, skipped, warnings };
}

/** events.csv -> [{ frameIdx, tMs, x, y, pol, flags, ts }]（pol_name 只为人工核对，不参与计算） */
export function parseEventsCsv(text) {
  const rows = splitCsvLines(text);
  const events = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0 && looksLikeHeader(row.split(","))) continue;
    const cells = row.split(",").map((c) => c.trim());
    if (cells.length < 7) {
      skipped++;
      continue;
    }
    const frameIdx = toFiniteNumber(cells[0], NaN);
    const tMs = toFiniteNumber(cells[1], NaN);
    if (!Number.isFinite(frameIdx) || !Number.isFinite(tMs)) {
      skipped++;
      continue;
    }
    events.push({
      frameIdx,
      tMs,
      x: toFiniteNumber(cells[2], 0),
      y: toFiniteNumber(cells[3], 0),
      pol: toFiniteNumber(cells[4], 0),
      flags: toFiniteNumber(cells[6], 0),
      ts: toFiniteNumber(cells[7], 0),
    });
  }
  return { events, skipped };
}

/**
 * frames.csv 的时间轴索引。
 * 表里 frame_idx 严格递增；仍然按 frameIdx 排序一次，坏顺序只告警不崩。
 */
export function buildFrameIndex(frames) {
  const list = (Array.isArray(frames) ? frames : [])
    .filter((f) => f && Number.isFinite(f.frameIdx) && Number.isFinite(f.tBoardMs))
    .slice()
    .sort((a, b) => a.frameIdx - b.frameIdx);
  let nonMonotonic = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].tBoardMs < list[i - 1].tBoardMs) nonMonotonic++;
  }
  if (!list.length) {
    return { frames: [], t0Ms: 0, t1Ms: 0, totalMs: 0, count: 0, nonMonotonic: 0 };
  }
  const t0Ms = list[0].tBoardMs;
  const t1Ms = list[list.length - 1].tBoardMs;
  return { frames: list, t0Ms, t1Ms, totalMs: Math.max(0, t1Ms - t0Ms), count: list.length, nonMonotonic };
}

/** 时间轴 ms -> 最近的「不晚于 ms」的帧（二分）。ms 超出范围就贴边。 */
export function frameAtMs(index, ms) {
  const frames = (index && index.frames) || [];
  if (!frames.length) return null;
  const t = toFiniteNumber(ms, 0);
  if (t <= frames[0].tBoardMs) return frames[0];
  if (t >= frames[frames.length - 1].tBoardMs) return frames[frames.length - 1];
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].tBoardMs <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}

/**
 * 时间轴 ms -> 时间上最接近的帧（二分）。点击/拖动时间轴定位时用它；
 * 片段边界仍用 frameAtMs（取「不晚于该时刻」的帧，边界归属更稳定）。
 */
export function nearestFrameAtMs(index, ms) {
  const frames = (index && index.frames) || [];
  if (!frames.length) return null;
  const f = frameAtMs(index, ms);
  if (!f) return null;
  const at = frames.indexOf(f);
  const next = at + 1 < frames.length ? frames[at + 1] : null;
  if (!next) return f;
  const t = toFiniteNumber(ms, 0);
  return Math.abs(next.tBoardMs - t) < Math.abs(t - f.tBoardMs) ? next : f;
}

/**
 * frame_idx -> 时间轴 ms。
 * 掉帧会让 frame_idx 不连续，此时按前后两帧线性插值，
 * 比「返回最近帧」更贴近真实时刻（用于把 labels 的 frame 边界换算回 ms）。
 */
export function msAtFrame(index, frameIdx) {
  const frames = (index && index.frames) || [];
  if (!frames.length) return null;
  const f = toFiniteNumber(frameIdx, NaN);
  if (!Number.isFinite(f)) return null;
  if (f <= frames[0].frameIdx) return frames[0].tBoardMs;
  const last = frames[frames.length - 1];
  if (f >= last.frameIdx) return last.tBoardMs;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].frameIdx <= f) lo = mid;
    else hi = mid - 1;
  }
  const a = frames[lo];
  if (a.frameIdx === f) return a.tBoardMs;
  const b = frames[Math.min(lo + 1, frames.length - 1)];
  if (b.frameIdx === a.frameIdx) return a.tBoardMs;
  const ratio = (f - a.frameIdx) / (b.frameIdx - a.frameIdx);
  return a.tBoardMs + (b.tBoardMs - a.tBoardMs) * ratio;
}

/** 视频时间（秒）= frame_idx / fpsNominal，契约规定。 */
export function frameToVideoTime(frameIdx, fpsNominal) {
  const fps = toFiniteNumber(fpsNominal, 30) > 0 ? toFiniteNumber(fpsNominal, 30) : 30;
  return toFiniteNumber(frameIdx, 0) / fps;
}

/** 视频时间（秒）-> 最接近的 frame_idx。 */
export function videoTimeToFrame(tSec, fpsNominal) {
  const fps = toFiniteNumber(fpsNominal, 30) > 0 ? toFiniteNumber(fpsNominal, 30) : 30;
  return Math.round(toFiniteNumber(tSec, 0) * fps);
}

/**
 * 没有 frames.csv 时的降级时间轴：把视频时长按 fps 近似成 frame_idx -> ms。
 * UI 会打上「时间轴退化」的标记，提醒用户这不是板卡时间。
 */
export function synthFrameIndex(durationSec, fpsNominal) {
  const fps = toFiniteNumber(fpsNominal, 30) > 0 ? toFiniteNumber(fpsNominal, 30) : 30;
  const dur = Math.max(toFiniteNumber(durationSec, 0), 0);
  const count = Math.max(1, Math.round(dur * fps) + 1);
  const frames = new Array(count);
  for (let i = 0; i < count; i++) frames[i] = { frameIdx: i, tBoardMs: (i / fps) * 1000, tArriveMs: (i / fps) * 1000 };
  return buildFrameIndex(frames);
}

// ---------------------------------------------------------------------------
// 6) labels.json
// ---------------------------------------------------------------------------

export function defaultTypes() {
  return DEFAULT_TYPE_NAMES.map((name, id) => ({ id, name, color: PALETTE[id] || PALETTE[1] }));
}

export function defaultLabels(ctx = {}) {
  return {
    version: 1,
    session: typeof ctx.session === "string" ? ctx.session : "",
    chunk: Number.isInteger(ctx.chunk) ? ctx.chunk : 0,
    fpsNominal: toFiniteNumber(ctx.fpsNominal, 30) > 0 ? toFiniteNumber(ctx.fpsNominal, 30) : 30,
    types: defaultTypes(),
    segments: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTypes(rawTypes, warnings) {
  const list = [];
  const seen = new Set();
  if (Array.isArray(rawTypes)) {
    for (const t of rawTypes) {
      if (!t || typeof t !== "object") continue;
      const id = toFiniteNumber(t.id, NaN);
      if (!Number.isInteger(id) || id < 0 || id >= MAX_TYPES || seen.has(id)) {
        warnings.push("丢弃非法类型 id=" + JSON.stringify(t.id));
        continue;
      }
      seen.add(id);
      const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 40) : DEFAULT_TYPE_NAMES[id] || "类型" + id;
      const color = typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color.toLowerCase() : PALETTE[id] || PALETTE[1];
      list.push({ id, name, color });
    }
  }
  // id=0 是契约里固定不可删的「无动作」。
  const zero = list.find((t) => t.id === 0);
  if (!zero) {
    warnings.push("缺少 id=0「无动作」，已补回");
    list.unshift({ id: 0, name: DEFAULT_TYPE_NAMES[0], color: PALETTE[0] });
  } else if (zero.name !== DEFAULT_TYPE_NAMES[0]) {
    zero.name = DEFAULT_TYPE_NAMES[0]; // 名字不允许被改：下游按它判「无动作」
  }
  if (list.length < 2) {
    for (let id = 1; id < MAX_TYPES && list.length < 2; id++) {
      if (!list.some((t) => t.id === id)) list.push({ id, name: DEFAULT_TYPE_NAMES[id], color: PALETTE[id] });
    }
  }
  return list.sort((a, b) => a.id - b.id);
}

function normalizeSegments(rawSegments, types, ctx, warnings) {
  const out = [];
  const usedIds = new Set();
  let nextId = 1;
  const typeIds = new Set(types.map((t) => t.id));
  const list = Array.isArray(rawSegments) ? rawSegments : [];
  const t0Ms = toFiniteNumber(ctx && ctx.t0Ms, 0);
  const totalMs = toFiniteNumber(ctx && ctx.totalMs, 0);
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const span = clampSpanToDomain(raw.startMs, raw.endMs, t0Ms, totalMs, MIN_SEG_MS);
    if (!span) {
      warnings.push("丢弃非法片段（startMs/endMs 不可用）");
      continue;
    }
    let id = toFiniteNumber(raw.id, NaN);
    if (!Number.isInteger(id) || id <= 0 || usedIds.has(id)) {
      while (usedIds.has(nextId)) nextId++;
      id = nextId;
      warnings.push("片段 id 缺失/重复，重编为 " + id);
    }
    usedIds.add(id);
    if (id >= nextId) nextId = id + 1;
    let typeId = toFiniteNumber(raw.typeId, 0);
    if (!Number.isInteger(typeId) || !typeIds.has(typeId)) {
      warnings.push("片段 " + id + " 的 typeId=" + JSON.stringify(raw.typeId) + " 不存在，归为无动作");
      typeId = 0;
    }
    const startFrame = toFiniteNumber(raw.startFrame, NaN);
    const endFrame = toFiniteNumber(raw.endFrame, NaN);
    out.push({
      id,
      startMs: Math.round(t0Ms + span.startMs),
      endMs: Math.round(t0Ms + span.endMs),
      startFrame: Number.isFinite(startFrame) ? startFrame : null,
      endFrame: Number.isFinite(endFrame) ? endFrame : null,
      typeId,
      note: typeof raw.note === "string" ? raw.note.slice(0, 500) : "",
    });
  }
  return sortSegments(out);
}

/**
 * labels.json 归一化（含 v1 迁移与损坏恢复）。
 * 任何异常输入都不抛异常：宁可退回默认值 + warnings，也不要让标注页白屏。
 * 返回 { labels, recovered, warnings }，recovered=true 表示「文件不可用，已重建」。
 */
export function normalizeLabels(raw, ctx = {}) {
  const warnings = [];
  const totalMs = toFiniteNumber(ctx.totalMs, 0);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { labels: defaultLabels(ctx), recovered: true, warnings: ["labels.json 不是对象，已重建默认结构"] };
  }
  let recovered = false;
  if (raw.version !== 1) {
    warnings.push("version=" + JSON.stringify(raw.version) + " 不是 1，已迁移到 v1");
    recovered = raw.version !== undefined && raw.version !== null;
  }
  const types = normalizeTypes(raw.types, warnings);
  const segments = normalizeSegments(raw.segments, types, { t0Ms: toFiniteNumber(ctx.t0Ms, 0), totalMs }, warnings);
  const session = typeof raw.session === "string" && raw.session ? raw.session : ctx.session || "";
  const chunk = Number.isInteger(raw.chunk) ? raw.chunk : Number.isInteger(ctx.chunk) ? ctx.chunk : 0;
  const fps = toFiniteNumber(raw.fpsNominal, NaN);
  const fpsNominal = fps > 0 ? fps : toFiniteNumber(ctx.fpsNominal, 30) > 0 ? toFiniteNumber(ctx.fpsNominal, 30) : 30;
  const updatedAt = typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : new Date().toISOString();
  return {
    labels: { version: 1, session, chunk, fpsNominal, types, segments, updatedAt },
    recovered,
    warnings,
  };
}

/** 解析 labels.json 文本；空文本/坏 JSON 都退回默认值。 */
export function parseLabelsText(text, ctx = {}) {
  if (typeof text !== "string" || text.trim() === "") {
    return { labels: defaultLabels(ctx), recovered: true, warnings: ["labels.json 为空或不存在，已用默认结构"] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { labels: defaultLabels(ctx), recovered: true, warnings: ["labels.json 解析失败：" + (err && err.message ? err.message : String(err))] };
  }
  return normalizeLabels(raw, ctx);
}

/** 序列化（稳定缩进，便于 git diff）。 */
export function stringifyLabels(labels) {
  return JSON.stringify(labels, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// 7) Range 请求头（视频拖动进度条必需）
// ---------------------------------------------------------------------------

/**
 * 解析单区间 Range 头。
 * 返回 { start, end } | { error } | null（null = 没有 Range 头，按整文件发送）。
 * error 取值：malformed（语法坏，按 RFC 忽略并回 200）/ unsupported（多区间，回 200）/ unsatisfiable（回 416）。
 */
export function parseRangeHeader(header, size) {
  if (header === undefined || header === null || header === "") return null;
  const sizeN = toFiniteNumber(size, 0);
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(String(header));
  if (!m) return { error: "malformed" };
  const spec = m[1].trim();
  if (spec.includes(",")) return { error: "unsupported" };
  const mm = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!mm) return { error: "malformed" };
  const startStr = mm[1];
  const endStr = mm[2];
  if (startStr === "" && endStr === "") return { error: "malformed" };
  let start;
  let end;
  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return { error: "unsatisfiable" };
    start = Math.max(0, sizeN - suffix);
    end = sizeN - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? sizeN - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "malformed" };
  // 起点已经越界属于「不可满足」（RFC 9110 要求回 416），不能当成语法坏。
  if (sizeN <= 0 || start >= sizeN) return { error: "unsatisfiable" };
  if (end < start) return { error: "malformed" };
  if (end >= sizeN) end = sizeN - 1;
  return { start, end };
}

export function contentRangeHeader(start, end, size) {
  return "bytes " + start + "-" + end + "/" + size;
}

export function contentLength(range) {
  return range.end - range.start + 1;
}

/**
 * 构造 206/416 的响应头；正常整文件响应由调用方按 200 处理。
 * 只返回 { status, headers }，不碰 socket，方便单测。
 */
export function rangeResponse(range, size, extra = {}) {
  const sizeN = toFiniteNumber(size, 0);
  if (range && range.error === "unsatisfiable") {
    return { status: 416, headers: { "Content-Range": "bytes */" + sizeN } };
  }
  if (!range || range.error) {
    return { status: 200, headers: { "Content-Length": String(sizeN), "Accept-Ranges": "bytes" } };
  }
  return {
    status: 206,
    headers: {
      "Content-Range": contentRangeHeader(range.start, range.end, sizeN),
      "Content-Length": String(contentLength(range)),
      "Accept-Ranges": "bytes",
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// 8) 路径安全（纯字符串部分；realpath 校验在 server.mjs）
// ---------------------------------------------------------------------------

const BAD_SEGMENT = /[:*?"<>|]/;

/**
 * 把 URL 里的相对路径归一化，越权就抛错。
 * 拒绝：NUL、绝对路径、盘符、上级目录引用、Windows 非法字符（含 NTFS 数据流冒号）。
 * 返回用 "/" 分隔的相对路径。
 *
 * 注意：这里只做字符串层校验；符号链接/重解析点会绕过它，
 * 所以 server.mjs 还会对 realpath 做一次「必须仍在 root 之内」的校验。
 */
export function sanitizeRelPath(rel) {
  if (typeof rel !== "string" || rel === "") {
    throw Object.assign(new Error("路径为空"), { code: "BAD_PATH" });
  }
  if (rel.includes("\u0000")) throw Object.assign(new Error("路径含 NUL"), { code: "BAD_PATH" });
  const s = rel.replace(/\\/g, "/");
  if (s.startsWith("/")) throw Object.assign(new Error("拒绝绝对路径：" + rel), { code: "ABSOLUTE" });
  if (/^[A-Za-z]:/.test(s)) throw Object.assign(new Error("拒绝盘符路径：" + rel), { code: "DRIVE" });
  const parts = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw Object.assign(new Error("拒绝路径穿越：" + rel), { code: "TRAVERSAL" });
    if (BAD_SEGMENT.test(part)) throw Object.assign(new Error("路径含非法字符：" + part), { code: "BAD_PATH" });
    parts.push(part);
  }
  if (!parts.length) throw Object.assign(new Error("路径归一化后为空"), { code: "BAD_PATH" });
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// 9) 导出 segments.csv
// ---------------------------------------------------------------------------

export const SEGMENTS_HEADER = "id,startMs,endMs,startFrame,endFrame,typeId,typeName,note";

/** RFC4180 最小转义：含逗号/引号/换行才加引号。 */
export function csvEscape(value) {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[\r\n",]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * labels -> segments.csv 文本（CRLF，Excel 友好）。
 * 列固定为 id,startMs,endMs,startFrame,endFrame,typeId,typeName,note。
 */
export function exportSegmentsCsv(labels) {
  const types = (labels && Array.isArray(labels.types) ? labels.types : []).slice();
  const nameOf = (id) => {
    const t = types.find((x) => x.id === id);
    return t ? t.name : "未知(" + id + ")";
  };
  const lines = [SEGMENTS_HEADER];
  const segments = sortSegments(labels && Array.isArray(labels.segments) ? labels.segments : []);
  for (const s of segments) {
    lines.push(
      [
        s.id,
        Math.round(s.startMs),
        Math.round(s.endMs),
        s.startFrame === null || s.startFrame === undefined ? "" : s.startFrame,
        s.endFrame === null || s.endFrame === undefined ? "" : s.endFrame,
        s.typeId,
        csvEscape(nameOf(s.typeId)),
        csvEscape(s.note || ""),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * 建一个片段对象（UI 与测试共用）。
 * input.startMs/endMs 用**相对时间轴毫秒**（0..ctx.totalMs）；
 * ctx = { index?, t0Ms?, totalMs?, fpsNominal?, segments?, minMs? }；
 * 返回对象里的 startMs/endMs 保持相对，startFrame/endFrame 用绝对板卡时间换算。
 */
export function makeSegment(input, ctx = {}) {
  if (!input || typeof input !== "object") return null;
  const index = ctx.index || null;
  const t0Ms = toFiniteNumber(ctx.t0Ms, 0);
  const totalMs = toFiniteNumber(ctx.totalMs, index && index.totalMs ? index.totalMs : 0);
  const minMs = toFiniteNumber(ctx.minMs, MIN_SEG_MS) || MIN_SEG_MS;
  const span = clampSegment(input.startMs, input.endMs, totalMs > 0 ? totalMs : Number.MAX_SAFE_INTEGER, minMs);
  if (!span) return null;
  const fps = toFiniteNumber(ctx.fpsNominal, 30) > 0 ? toFiniteNumber(ctx.fpsNominal, 30) : 30;
  const hasFrames = !!(index && index.frames && index.frames.length);
  const startFrame = hasFrames ? frameAtMs(index, t0Ms + span.startMs).frameIdx : videoTimeToFrame(span.startMs / 1000, fps);
  const endFrame = hasFrames ? frameAtMs(index, t0Ms + span.endMs).frameIdx : videoTimeToFrame(span.endMs / 1000, fps);
  return {
    id: Number.isInteger(input.id) ? input.id : nextSegmentId(ctx.segments || []),
    startMs: span.startMs,
    endMs: span.endMs,
    startFrame,
    endFrame,
    typeId: Number.isInteger(input.typeId) ? input.typeId : 0,
    note: typeof input.note === "string" ? input.note : "",
  };
}

/**
 * 相对时间轴片段 -> labels.json 片段（绝对板卡毫秒）。
 * labels.json 只有这一种坐标：startMs/endMs 就是 frames.csv 的 t_board_ms 刻度。
 */
export function segmentsToLabels(relSegments, t0Ms) {
  const t0 = toFiniteNumber(t0Ms, 0);
  const list = Array.isArray(relSegments) ? relSegments : [];
  return list.map((s) => ({
    id: s.id,
    startMs: Math.round(t0 + toFiniteNumber(s.startMs, 0)),
    endMs: Math.round(t0 + toFiniteNumber(s.endMs, 0)),
    startFrame: Number.isFinite(s.startFrame) ? s.startFrame : null,
    endFrame: Number.isFinite(s.endFrame) ? s.endFrame : null,
    typeId: s.typeId,
    note: typeof s.note === "string" ? s.note : "",
  }));
}

/** labels.json 片段 -> 相对时间轴片段（加载时用，边界按域钳制；有帧表则重算 frame_idx）。 */
export function segmentsFromLabels(labelSegments, ctx = {}) {
  const t0Ms = toFiniteNumber(ctx.t0Ms, 0);
  const totalMs = toFiniteNumber(ctx.totalMs, 0);
  const index = ctx.index || null;
  const hasFrames = !!(index && index.frames && index.frames.length);
  const fps = toFiniteNumber(ctx.fpsNominal, 30) > 0 ? toFiniteNumber(ctx.fpsNominal, 30) : 30;
  const minMs = toFiniteNumber(ctx.minMs, MIN_SEG_MS) || MIN_SEG_MS;
  const list = Array.isArray(labelSegments) ? labelSegments : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const span = clampSpanToDomain(raw.startMs, raw.endMs, t0Ms, totalMs, minMs);
    if (!span) continue;
    const startFrame = hasFrames
      ? frameAtMs(index, t0Ms + span.startMs).frameIdx
      : Number.isFinite(raw.startFrame)
        ? raw.startFrame
        : videoTimeToFrame(span.startMs / 1000, fps);
    const endFrame = hasFrames
      ? frameAtMs(index, t0Ms + span.endMs).frameIdx
      : Number.isFinite(raw.endFrame)
        ? raw.endFrame
        : videoTimeToFrame(span.endMs / 1000, fps);
    out.push({
      id: Number.isInteger(raw.id) ? raw.id : nextSegmentId(out),
      startMs: span.startMs,
      endMs: span.endMs,
      startFrame,
      endFrame,
      typeId: Number.isInteger(raw.typeId) ? raw.typeId : 0,
      note: typeof raw.note === "string" ? raw.note : "",
    });
  }
  return sortSegments(out);
}
