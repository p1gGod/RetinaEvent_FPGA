// 核心纯函数单测（node --test tool/annotator/test/core.test.mjs）。
// 覆盖验收判据 1 点名的每一类：px<->ms、缩放钳制、片段边界、Alt+N 映射、
// 100ms 桶聚合（含空输入）、Range 解析与 206 头构造、路径穿越拒绝、labels 迁移/损坏恢复。

import test from "node:test";
import assert from "node:assert/strict";

import * as core from "../ui/core.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 视图换算与缩放
// ---------------------------------------------------------------------------

test("px<->ms 互换算，且锚点缩放后光标下的时刻不变", () => {
  const view = { startMs: 1000, pxPerMs: 0.1 };
  assert.equal(core.pxToMs(0, view), 1000);
  assert.equal(core.pxToMs(100, view), 2000);
  assert.equal(core.msToPx(2000, view), 100);
  // 往返一致
  assert.ok(near(core.pxToMs(core.msToPx(1234, view), view), 1234));

  // 光标停在 x=250 处放大 2 倍，该点对应的 ms 必须还原成同一个值
  const anchorX = 250;
  const before = core.pxToMs(anchorX, view);
  const zoomed = core.zoomViewAt(view, 2, anchorX, 10000, 1000);
  const after = core.pxToMs(anchorX, zoomed);
  assert.ok(near(before, after), "锚点漂移：" + before + " -> " + after);
});

test("缩放钳制：不超过最大 px/ms，也不小于适应窗口的 0.5 倍", () => {
  const totalMs = 10000;
  const width = 1000;
  const fit = core.fitView(totalMs, width);
  assert.equal(fit.pxPerMs, 0.1);
  assert.equal(fit.startMs, 0);

  // 疯狂放大：被 MAX_PX_PER_MS 卡住
  let v = fit;
  for (let i = 0; i < 40; i++) v = core.zoomViewAt(v, 4, 500, totalMs, width);
  assert.equal(v.pxPerMs, core.MAX_PX_PER_MS);

  // 疯狂缩小：被 fit*0.5 卡住（此时整段居中，两侧留白）
  for (let i = 0; i < 40; i++) v = core.zoomViewAt(v, 0.25, 500, totalMs, width);
  assert.ok(v.pxPerMs >= fit.pxPerMs * core.MIN_ZOOM_FACTOR - 1e-12);
  assert.ok(v.pxPerMs < fit.pxPerMs);
  assert.ok(v.startMs < 0, "看到比整段更长时应该居中留白");
});

test("平移钳制：startMs 不越出 [0, totalMs-visibleMs]", () => {
  const totalMs = 10000;
  const width = 1000;
  const v = core.clampView({ startMs: 0, pxPerMs: 0.5 }, totalMs, width); // 可见 2000ms
  assert.equal(v.startMs, 0);
  const right = core.panViewBy(v, 1e9, totalMs, width);
  assert.equal(right.startMs, totalMs - width / v.pxPerMs);
  const left = core.panViewBy(v, -1e9, totalMs, width);
  assert.equal(left.startMs, 0);
});

test("空输入（totalMs=0）时不产生 NaN/Infinity", () => {
  const v = core.clampView({ startMs: 123, pxPerMs: 0 }, 0, 800);
  assert.equal(v.totalMs, 0);
  assert.ok(Number.isFinite(v.startMs) && Number.isFinite(v.pxPerMs));
  assert.equal(core.pxToMs(0, v), v.startMs);
});

test("刻度步长随缩放变化，且像素间距不小于阈值", () => {
  const far = core.tickStepMs(0.005, 72); // 1 像素 = 200ms
  const nearStep = core.tickStepMs(1, 72);
  assert.ok(far > nearStep);
  assert.ok(far * 0.005 >= 72);
  assert.ok(nearStep * 1 >= 72);
});

// ---------------------------------------------------------------------------
// 片段几何
// ---------------------------------------------------------------------------

test("片段边界钳制：反序摆正、越界贴边、太短撑到最短、空分段返回 null", () => {
  const a = core.clampSegment(800, 200, 1000);
  assert.deepEqual(a, { startMs: 200, endMs: 800 });

  const b = core.clampSegment(-500, 5000, 1000);
  assert.deepEqual(b, { startMs: 0, endMs: 1000 });

  const c = core.clampSegment(400, 410, 1000); // 10ms < MIN_SEG_MS
  assert.equal(c.startMs, 400);
  assert.equal(c.endMs, 400 + core.MIN_SEG_MS);

  const d = core.clampSegment(960, 900, 1000); // 反序且贴右边界，撑开会顶到 totalMs
  assert.ok(d.endMs <= 1000 && d.endMs > d.startMs);

  assert.equal(core.clampSegment(0, 10, 0), null, "totalMs=0 不能建段，且不得 start>=end");
  assert.equal(core.clampSegment(500, 500, 1000).endMs > 500, true);
});

test("平移片段撞到两端贴边，长度不变", () => {
  const seg = { startMs: 100, endMs: 300 };
  const left = core.moveSegment(seg, -1000, 1000);
  assert.deepEqual(left, { startMs: 0, endMs: 200 });
  const right = core.moveSegment(seg, 1e9, 1000);
  assert.deepEqual(right, { startMs: 800, endMs: 1000 });
  const mid = core.moveSegment(seg, 50, 1000);
  assert.deepEqual(mid, { startMs: 150, endMs: 350 });
});

test("拖两端改边界：另一端固定，且不得短于最短时长", () => {
  const seg = { startMs: 100, endMs: 500 };
  assert.deepEqual(core.resizeSegment(seg, "start", 200, 1000), { startMs: 200, endMs: 500 });
  assert.deepEqual(core.resizeSegment(seg, "end", 800, 1000), { startMs: 100, endMs: 800 });
  // 起点拖过终点：被卡在 end-minMs
  const over = core.resizeSegment(seg, "start", 999, 1000);
  assert.equal(over.startMs, 500 - core.MIN_SEG_MS);
  assert.equal(over.endMs, 500);
  // 负坐标与越界
  assert.equal(core.resizeSegment(seg, "start", -50, 1000).startMs, 0);
  assert.equal(core.resizeSegment(seg, "end", 99999, 1000).endMs, 1000);
});

test("命中判定：两端热区优先于整段拖拽", () => {
  const segs = [{ id: 1, startMs: 1000, endMs: 2000 }];
  assert.deepEqual(core.hitTestSegments(segs, 1000, 6), { id: 1, part: "start" });
  assert.deepEqual(core.hitTestSegments(segs, 2000, 6), { id: 1, part: "end" });
  assert.deepEqual(core.hitTestSegments(segs, 1500, 6), { id: 1, part: "body" });
  assert.equal(core.hitTestSegments(segs, 50, 6), null);
  assert.equal(core.hitTestSegments([], 1500, 6), null);
});

test("切分：切点靠边（两侧会短于最短时长）拒绝切分", () => {
  const seg = { id: 1, startMs: 1000, endMs: 2000 };
  const parts = core.splitSegmentAt(seg, 1500, core.MIN_SEG_MS);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { startMs: 1000, endMs: 1500 });
  assert.deepEqual(parts[1], { startMs: 1500, endMs: 2000 });
  assert.equal(core.splitSegmentAt(seg, 1010, core.MIN_SEG_MS), null);
  assert.equal(core.splitSegmentAt(seg, 1990, core.MIN_SEG_MS), null);
});

test("片段 id 单调递增，不会被复用", () => {
  assert.equal(core.nextSegmentId([]), 1);
  assert.equal(core.nextSegmentId([{ id: 1 }, { id: 7 }, { id: 3 }]), 8);
});

// ---------------------------------------------------------------------------
// 快捷键与打标决策
// ---------------------------------------------------------------------------

const TYPES = core.defaultTypes();
const key = (k, mods = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

test("Alt+1..9 与备用无修饰 1..9 都映射到槽位；Ctrl/Meta 与非数字不认", () => {
  assert.equal(core.hotkeySlotFromEvent(key("1", { altKey: true })), 1);
  assert.equal(core.hotkeySlotFromEvent(key("9", { altKey: true })), 9);
  assert.equal(core.hotkeySlotFromEvent(key("3")), 3, "无修饰数字键是 Alt+数字 的备用路径");
  assert.equal(core.hotkeySlotFromEvent(key("0")), null);
  assert.equal(core.hotkeySlotFromEvent(key("1", { ctrlKey: true })), null);
  assert.equal(core.hotkeySlotFromEvent(key("1", { metaKey: true })), null);
  assert.equal(core.hotkeySlotFromEvent(key("a")), null);
  assert.equal(core.hotkeySlotFromEvent(null), null);
});

test("槽位 -> typeId：按 id 升序取第 slot 个；类型被删后返回 null", () => {
  assert.equal(core.typeIdForSlot(TYPES, 0), 0);
  assert.equal(core.typeIdForSlot(TYPES, 1), 1);
  assert.equal(core.typeIdForSlot(TYPES, 9), 9);
  assert.equal(core.typeIdForSlot(TYPES, 10), null);
  assert.equal(core.typeIdForSlot(TYPES.slice(0, 3), 5), null);
});

test("planTypeAssign：有选中改选中，无选中但有选区则建段后赋类型，都没有则 noop", () => {
  const segments = [{ id: 1, startMs: 0, endMs: 100, typeId: 0, note: "" }];
  const assigned = core.planTypeAssign({ types: TYPES, segments, selectedIds: [1], totalMs: 1000 }, 2);
  assert.equal(assigned.action, "assign");
  assert.equal(assigned.segments[0].typeId, 2);
  assert.equal(assigned.typeId, 2);
  assert.equal(segments[0].typeId, 0, "入参不能被就地修改");

  const created = core.planTypeAssign({ types: TYPES, segments, selectedIds: [], pending: { startMs: 200, endMs: 400 }, totalMs: 1000 }, 3);
  assert.equal(created.action, "create");
  assert.equal(created.segments.length, 2);
  const fresh = created.segments.find((s) => s.id === 2);
  assert.deepEqual({ startMs: fresh.startMs, endMs: fresh.endMs, typeId: fresh.typeId }, { startMs: 200, endMs: 400, typeId: 3 });
  assert.deepEqual(created.selectedIds, [2]);

  const noop = core.planTypeAssign({ types: TYPES, segments, selectedIds: [], pending: null, totalMs: 1000 }, 4);
  assert.equal(noop.action, "noop");
  assert.equal(noop.segments.length, 1);

  const badSlot = core.planTypeAssign({ types: TYPES.slice(0, 2), segments, selectedIds: [1], totalMs: 1000 }, 7);
  assert.equal(badSlot.action, "noop");
  assert.equal(badSlot.typeId, null);
});

// ---------------------------------------------------------------------------
// 事件密度
// ---------------------------------------------------------------------------

test("100ms 桶聚合：空输入返回全 0 桶，正常输入按桶计数并钳制越界", () => {
  const empty = core.bucketEvents([], { t0Ms: 0, bucketMs: 100, totalMs: 1000 });
  assert.equal(empty.counts.length, 10);
  assert.equal(empty.total, 0);
  assert.ok(empty.counts.every((c) => c === 0), "空输入必须是 0 而不是 undefined/NaN");
  assert.equal(empty.bucketMs, 100);

  const evs = [{ tMs: 0 }, { tMs: 50 }, { tMs: 99 }, { tMs: 100 }, { tMs: 999 }, { tMs: 1200 }];
  const r = core.bucketEvents(evs, { t0Ms: 0, bucketMs: 100, totalMs: 1000 });
  assert.equal(r.counts[0], 3, "0..99ms 都落进第 0 桶");
  assert.equal(r.counts[1], 1);
  assert.equal(r.buckets, 10);
  assert.equal(r.total, 6);
  assert.equal(r.counts[9], 2, "越过 totalMs 的事件钳到最后一桶（不丢事件）");

  // 带 t0 偏移
  const off = core.bucketEvents([{ tMs: 1000 }, { tMs: 1150 }], { t0Ms: 1000, bucketMs: 100, totalMs: 500 });
  assert.equal(off.counts[0], 1);
  assert.equal(off.counts[1], 1);
});

test("对数归一化：全 0 不除零，最大值归到 1，单调不减", () => {
  const zeros = core.logNormalizeCounts(new Uint32Array(5));
  assert.equal(zeros.length, 5);
  assert.ok(zeros.every((v) => v === 0));

  const norms = core.logNormalizeCounts(Uint32Array.from([0, 1, 10, 1000]));
  assert.equal(norms[0], 0);
  assert.equal(norms[3], 1);
  assert.ok(norms[1] > 0 && norms[1] < norms[2] && norms[2] < norms[3]);
  assert.equal(core.logNormalizeCounts(new Uint32Array(0)).length, 0);
});

// ---------------------------------------------------------------------------
// Range 与 206 响应
// ---------------------------------------------------------------------------

test("Range 解析：闭区间/开区间/后缀区间/越界/坏语法/多区间", () => {
  assert.deepEqual(core.parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(core.parseRangeHeader("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(core.parseRangeHeader("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(core.parseRangeHeader("bytes=990-2000", 1000), { start: 990, end: 999 }, "end 超出文件尾要夹到 size-1");
  assert.equal(core.parseRangeHeader(undefined, 1000), null);
  assert.equal(core.parseRangeHeader("", 1000), null);
  assert.deepEqual(core.parseRangeHeader("bytes=1000-", 1000), { error: "unsatisfiable" });
  assert.deepEqual(core.parseRangeHeader("bytes=-0", 1000), { error: "unsatisfiable" });
  assert.deepEqual(core.parseRangeHeader("bytes=abc", 1000), { error: "malformed" });
  assert.deepEqual(core.parseRangeHeader("bytes=0-10,20-30", 1000), { error: "unsupported" });
  assert.deepEqual(core.parseRangeHeader("items=0-10", 1000), { error: "malformed" });
});

test("206 响应构造：Content-Range/Content-Length 正确，416 带 bytes */size", () => {
  const r = core.parseRangeHeader("bytes=0-99", 4000);
  const resp = core.rangeResponse(r, 4000, { "Content-Type": "video/mp4" });
  assert.equal(resp.status, 206);
  assert.equal(resp.headers["Content-Range"], "bytes 0-99/4000");
  assert.equal(resp.headers["Content-Length"], "100");
  assert.equal(resp.headers["Accept-Ranges"], "bytes");
  assert.equal(resp.headers["Content-Type"], "video/mp4");
  assert.equal(core.contentLength(r), 100);

  const bad = core.rangeResponse(core.parseRangeHeader("bytes=9999-", 4000), 4000);
  assert.equal(bad.status, 416);
  assert.equal(bad.headers["Content-Range"], "bytes */4000");

  const full = core.rangeResponse(null, 4000);
  assert.equal(full.status, 200);
  assert.equal(full.headers["Content-Length"], "4000");
});

// ---------------------------------------------------------------------------
// 路径穿越
// ---------------------------------------------------------------------------

test("路径穿越字符串层拒绝：上级目录、绝对路径、盘符、反斜杠改用、NTFS 数据流", () => {
  assert.equal(core.sanitizeRelPath("chunk-000.video.mp4"), "chunk-000.video.mp4");
  assert.equal(core.sanitizeRelPath("sess/demo/./chunk-000.video.mp4"), "sess/demo/chunk-000.video.mp4");
  assert.throws(() => core.sanitizeRelPath("../secret.txt"), /路径穿越/);
  assert.throws(() => core.sanitizeRelPath("a/../../secret.txt"), /路径穿越/);
  assert.throws(() => core.sanitizeRelPath("/etc/passwd"), /绝对路径/);
  assert.throws(() => core.sanitizeRelPath("C:/Windows/win.ini"), /盘符/);
  assert.throws(() => core.sanitizeRelPath("C:\\Windows\\win.ini"), /盘符/);
  assert.throws(() => core.sanitizeRelPath("a\0b"), /NUL/);
  assert.throws(() => core.sanitizeRelPath("a/b:c"), /非法字符/);
  assert.throws(() => core.sanitizeRelPath(""), /为空/);
  // 反斜杠分隔的 ..\..\ 也得挡住
  assert.throws(() => core.sanitizeRelPath("..\\..\\secret.txt"), /路径穿越/);
});

// ---------------------------------------------------------------------------
// CSV 解析与时间轴索引
// ---------------------------------------------------------------------------

const FRAMES_CSV =
  "frame_idx,t_board_ms,t_arrive_ms\r\n" + "0,1000,1010\r\n" + "1,1033,1041\r\n" + "2,1066,1075\r\n";

test("frames.csv 解析：跳表头、CRLF、坏行跳过不抛异常", () => {
  const ok = core.parseFramesCsv(FRAMES_CSV);
  assert.equal(ok.frames.length, 3);
  assert.deepEqual(ok.frames[1], { frameIdx: 1, tBoardMs: 1033, tArriveMs: 1041 });

  const dirty = "\uFEFFframe_idx,t_board_ms,t_arrive_ms\r\n0,1000,1001\r\n坏行,abc\r\n5,2000,2001\r\n";
  const r = core.parseFramesCsv(dirty);
  assert.equal(r.frames.length, 2, "BOM + 坏行都应被处理");
  assert.equal(r.skipped, 1);
  assert.equal(r.frames[1].frameIdx, 5);
  assert.equal(core.parseFramesCsv("").frames.length, 0);
  assert.equal(core.parseFramesCsv("frame_idx,t_board_ms,t_arrive_ms\r\n").frames.length, 0);
});

test("events.csv 解析：8 列契约，缺 events.csv 时按空处理", () => {
  const text =
    "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts\r\n" + "7,1200,3,4,1,ON,4,9\r\n" + "8,1233,5,6,0,OFF,0,10\r\n";
  const r = core.parseEventsCsv(text);
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events[0], { frameIdx: 7, tMs: 1200, x: 3, y: 4, pol: 1, flags: 4, ts: 9 });
  assert.equal(core.parseEventsCsv("").events.length, 0);
  assert.equal(core.parseEventsCsv("frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts\r\n").events.length, 0);
});

test("时间轴索引：t0/t1 取首末帧，frame<->ms 双向查找，掉帧时线性插值", () => {
  const frames = [
    { frameIdx: 0, tBoardMs: 1000, tArriveMs: 1000 },
    { frameIdx: 1, tBoardMs: 1033, tArriveMs: 1033 },
    { frameIdx: 3, tBoardMs: 1100, tArriveMs: 1100 }, // 掉了一帧
  ];
  const idx = core.buildFrameIndex(frames);
  assert.equal(idx.t0Ms, 1000);
  assert.equal(idx.t1Ms, 1100);
  assert.equal(idx.totalMs, 100);
  assert.equal(idx.count, 3);

  assert.equal(core.frameAtMs(idx, 0).frameIdx, 0);
  assert.equal(core.frameAtMs(idx, 1050).frameIdx, 1);
  assert.equal(core.frameAtMs(idx, 1e9).frameIdx, 3, "超出右边界贴到最后一帧");
  // 点击定位取「最近帧」，边界映射取「不晚于」（floor）
  assert.equal(core.nearestFrameAtMs(idx, 1049).frameIdx, 1, "1049 距 1033 更近");
  assert.equal(core.nearestFrameAtMs(idx, 1060).frameIdx, 1, "1060 距 1033(27ms) 比 1100(40ms) 更近");
  assert.equal(core.nearestFrameAtMs(idx, 1085).frameIdx, 3, "1085 距 1100(15ms) 更近");
  assert.equal(core.frameAtMs(idx, 1085).frameIdx, 1, "floor 语义：边界仍归属不晚于该时刻的帧");
  assert.equal(core.nearestFrameAtMs(core.buildFrameIndex([]), 5), null, "空索引返回 null");
  assert.equal(core.msAtFrame(idx, 0), 1000);
  assert.equal(core.msAtFrame(idx, 1), 1033);
  assert.equal(core.msAtFrame(idx, 3), 1100);
  const mid = core.msAtFrame(idx, 2); // 整数帧 2 不在表里：按 1->3 线性插值
  assert.ok(mid > 1033 && mid < 1100);

  assert.equal(core.buildFrameIndex([]).count, 0);
  assert.equal(core.frameAtMs(core.buildFrameIndex([]), 5), null);
  assert.equal(core.msAtFrame(core.buildFrameIndex([]), 5), null);
  assert.equal(core.frameToVideoTime(15, 30), 0.5);
  assert.equal(core.videoTimeToFrame(0.5, 30), 15);
});

// ---------------------------------------------------------------------------
// labels.json 迁移与损坏恢复
// ---------------------------------------------------------------------------

test("labels 迁移：缺失/非法字段补默认，id=0 无动作强制保留，非法 typeId 归 0", () => {
  const { labels, warnings } = core.normalizeLabels(
    {
      version: 0,
      session: "s1",
      chunk: 2,
      types: [{ id: 0, name: "被改坏的名字" }, { id: 5, name: "挥手", color: "#123456" }, { id: 99, name: "越界" }],
      segments: [{ id: 3, startMs: 100, endMs: 300, typeId: 5 }, { id: 3, startMs: 400, endMs: 600, typeId: 42 }],
    },
    { session: "s1", chunk: 2, fpsNominal: 30, totalMs: 1000 },
  );
  assert.equal(labels.version, 1);
  assert.equal(labels.types[0].id, 0);
  assert.equal(labels.types[0].name, "无动作");
  assert.equal(labels.types.some((t) => t.id === 99), false, "id 越界的类型要被丢弃");
  assert.equal(labels.segments.length, 2);
  assert.notEqual(labels.segments[1].id, 3, "重复 id 要重编");
  assert.equal(labels.segments[1].id, 4, "重编时避开已用 id，取下一个空位");
  assert.equal(labels.segments[1].typeId, 0, "不存在的 typeId 归为无动作");
  assert.ok(warnings.length > 0);
  assert.ok(labels.updatedAt);
});

test("labels 恢复：坏 JSON / 空文件 / 非对象都退回默认结构，绝不抛异常", () => {
  const bad = core.parseLabelsText("{ 这不是 JSON", { session: "s", chunk: 1, fpsNominal: 25 });
  assert.equal(bad.recovered, true);
  assert.equal(bad.labels.version, 1);
  assert.equal(bad.labels.session, "s");
  assert.equal(bad.labels.chunk, 1);
  assert.equal(bad.labels.fpsNominal, 25);
  assert.deepEqual(bad.labels.segments, []);
  assert.equal(bad.labels.types.length, 10);

  const empty = core.parseLabelsText("", {});
  assert.equal(empty.recovered, true);
  assert.equal(empty.labels.types[0].name, "无动作");

  const arr = core.parseLabelsText("[1,2,3]", {});
  assert.equal(arr.recovered, true);

  const ok = core.parseLabelsText(JSON.stringify(core.defaultLabels({ session: "x", chunk: 0 })), {});
  assert.equal(ok.recovered, false);
  assert.deepEqual(ok.warnings, []);
});

test("labels 片段越界钳制：超出总长的片段被裁到 [0,totalMs]", () => {
  const { labels } = core.normalizeLabels(
    { version: 1, types: core.defaultTypes(), segments: [{ id: 1, startMs: 900, endMs: 5000, typeId: 1 }] },
    { totalMs: 1000 },
  );
  assert.equal(labels.segments[0].startMs, 900);
  assert.equal(labels.segments[0].endMs, 1000);

  const zeroTotal = core.normalizeLabels(
    { version: 1, types: core.defaultTypes(), segments: [{ id: 1, startMs: 900, endMs: 950, typeId: 1 }] },
    { totalMs: 0 },
  );
  assert.equal(zeroTotal.labels.segments.length, 1, "没有 totalMs 时不应误删片段");
});

test("segments.csv 导出：表头固定、CRLF、含逗号/引号/换行的 note 正确转义", () => {
  const labels = core.defaultLabels({ session: "s", chunk: 0 });
  labels.types[1].name = "挥手";
  labels.segments = [
    { id: 2, startMs: 200, endMs: 400, startFrame: 6, endFrame: 12, typeId: 1, note: "" },
    { id: 1, startMs: 100, endMs: 200, startFrame: 3, endFrame: 6, typeId: 0, note: 'a,b"c' },
  ];
  const csv = core.exportSegmentsCsv(labels);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], core.SEGMENTS_HEADER);
  assert.equal(lines[0], "id,startMs,endMs,startFrame,endFrame,typeId,typeName,note");
  assert.equal(lines[1], "1,100,200,3,6,0,无动作,\"a,b\"\"c\"");
  assert.equal(lines[2], "2,200,400,6,12,1,挥手,");
  assert.ok(csv.endsWith("\r\n"), "最后一行也要 CRLF");
  assert.equal(core.csvEscape("普通"), "普通");
  assert.equal(core.csvEscape(undefined), "");
});

test("makeSegment：边界换算成 frame_idx，并钳到总长", () => {
  const idx = core.buildFrameIndex(JSON.parse(JSON.stringify(core.parseFramesCsv(FRAMES_CSV).frames)));
  const ctx = { index: idx, t0Ms: idx.t0Ms, totalMs: 1000, fpsNominal: 30 };
  const seg = core.makeSegment({ startMs: 33, endMs: 100, typeId: 2, id: 9 }, ctx);
  assert.equal(seg.startFrame, 1, "相对 33ms + t0=1000 -> 板卡 1033ms 落在 frame 1");
  assert.equal(seg.endFrame, 2);
  assert.equal(seg.startMs, 33, "内部仍用相对毫秒");
  assert.equal(seg.typeId, 2);
  assert.equal(seg.id, 9);
  assert.equal(core.makeSegment({ startMs: 0, endMs: 0 }, ctx).endMs >= core.MIN_SEG_MS, true);
  assert.deepEqual(
    (({ startMs, endMs }) => ({ startMs, endMs }))(core.makeSegment({ startMs: 900, endMs: 5000 }, { totalMs: 1000 })),
    { startMs: 900, endMs: 1000 },
    "越过末尾的选区被钳到总长，而不是丢弃",
  );
  assert.equal(core.makeSegment(null, { totalMs: 1000 }), null, "非法入参返回 null");
  assert.ok(core.makeSegment({ startMs: 0, endMs: 100 }, { totalMs: 0 }), "totalMs 未知（0）时不钳制长度");
});

test("坐标系往返：labels 绝对毫秒 <-> UI 相对毫秒", () => {
  const idx = core.buildFrameIndex(JSON.parse(JSON.stringify(core.parseFramesCsv(FRAMES_CSV).frames)));
  const t0Ms = idx.t0Ms;
  const rel = [
    { id: 1, startMs: 0, endMs: 66, startFrame: 0, endFrame: 2, typeId: 1, note: "" },
    { id: 2, startMs: 20, endMs: 60, startFrame: 0, endFrame: 2, typeId: 0, note: "x" },
  ];
  const abs = core.segmentsToLabels(rel, t0Ms);
  assert.equal(abs[0].startMs, t0Ms + 0);
  assert.equal(abs[1].startMs, t0Ms + 20, "落盘是绝对板卡毫秒");

  const back = core.segmentsFromLabels(abs, { index: idx, t0Ms, totalMs: idx.totalMs, fpsNominal: 30 });
  assert.equal(back.length, 2);
  assert.equal(back[0].startMs, 0);
  assert.equal(back[0].endMs, 66);
  assert.equal(back[1].startMs, 20);
  assert.equal(back[0].startFrame, 0);
  assert.equal(back[0].endFrame, 2);
  assert.equal(back[1].note, "x");
  assert.equal(abs[0].startFrame, 0);

  const clamped = core.segmentsFromLabels([{ id: 5, startMs: t0Ms + 5000, endMs: t0Ms + 6000, typeId: 0 }], {
    index: idx,
    t0Ms,
    totalMs: idx.totalMs,
  });
  assert.equal(clamped[0].endMs, idx.totalMs, "超出域外的绝对区间被拉到时间轴末端而不是 frame 0");
  assert.equal(clamped[0].startMs, idx.totalMs - core.MIN_SEG_MS, "贴边时向前补足最小段长");
  assert.equal(core.relToAbs(120, 1000), 1120);
  assert.equal(core.absToRel(1120, 1000), 120);
  assert.equal(core.clampSpanToDomain(1000, 2000, 1000, 100, 40).endMs, 100);
});

test("降级时间轴：没有 frames.csv 时按 fps 合成，并有 frame 0", () => {
  const idx = core.synthFrameIndex(1, 30);
  assert.equal(idx.count, 31);
  assert.equal(idx.frames[0].frameIdx, 0);
  assert.equal(idx.frames[30].tBoardMs, 1000);
  assert.equal(core.synthFrameIndex(0, 30).count, 1, "至少一帧，不能是空索引");
});

test("时间显示格式：01:23.456 与 1.234s", () => {
  assert.equal(core.formatClock(0), "00:00.000");
  assert.equal(core.formatClock(83456), "01:23.456");
  assert.equal(core.formatSeconds(1234), "1.234s");
  assert.equal(core.formatClock(NaN), "--:--.---");
});
