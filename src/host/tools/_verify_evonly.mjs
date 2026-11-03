#!/usr/bin/env node
// A 项（事件-only 上行）机读自检：EV_ONLY_OK=1
//
// 现场缺陷（KEY3 切板端 mode=2）：
//   · 板端 EV_ONLY 下事件包 FRAME_IDX 冻结（udp_merge 用 raw_pop 计数当帧号），网关装配器
//     "只有帧号变化才结算纯事件批"永不触发 → 2 MB 事件环被挤爆（现场 evDrop=5,495,957）
//     → 前端一条事件都收不到（L1 停旧图 / L2 全黑 / 事件率 0.0 ev/s / 每帧 0/96000）。
//   · 前端只把事件塞 evQueue，等 FRAME_RAW 才置位；mode2 根本没有 FRAME_RAW。
//
// 本脚本不碰网络、不碰板子，用**真实装配器 + 真实前端纯逻辑**跑现场形态：
//   ① 500 包 × 5 ms（2.5 s）× 4 条事件、frameIdx 恒 6040 ⇒ 批次≥50、evDrop=0、逻辑帧号单调；
//   ② 同一份批直接喂前端的 EventBitmap/StatsAggregator/EvOnlyTracker ⇒ 事件上屏、统计非 0；
//   ③ 恢复 MODE0（真实 FRAME_RAW 6041 带帧内事件）⇒ 帧照常交付、事件不被 EV_ONLY 批污染；
//   ④ 反向对照：同一流量把时间窗关到 5000 ms ⇒ evDrop 必须重现（证明 40 ms 窗口是真 gate）。
//
// 用法：node --experimental-strip-types tools/_verify_evonly.mjs
import { encodeEvents, getProfile } from "@retina/protocol";
import { FrameAssembler } from "../gateway/src/pipeline/assembler.ts";
import { EventBitmap } from "../web/src/events.ts";
import { StatsAggregator } from "../web/src/stats.ts";
import { EvOnlyTracker, applyEvOnlyBatch, evOnlyRawBadge } from "../web/src/pipeline/evonly.ts";

const profile = getProfile("retina-v2-800x480-e5");
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;
const REC = profile.evRecBytes;
const FROZEN = 6040;
const PKT_MS = 5;
const PER = 4;
const PACKETS = 500;

const results = [];
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " ⇒ " + detail);
}
function recs(tag, n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push({ x: (tag * 10 + i) & 0x1ff, y: tag % 480, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}
function pkt(frameIdx, chunkIdx, raw, events) {
  return {
    kind: "v2",
    frameIdx,
    segMask: (raw === null ? 0 : 1) | (events === null ? 0 : 2),
    hasRaw: raw !== null,
    hasEvents: events !== null,
    chunkIdx,
    rawLen: raw === null ? 0 : raw.length,
    evLen: events === null ? 0 : events.length,
    raw,
    events,
    crc16Present: false,
    warnings: [],
  };
}

// ————————————— ① 装配器：EV_ONLY 连续流 —————————————
const out = [];
const frames = [];
let asm = new FrameAssembler({
  profile,
  onFrame: (f) => frames.push(f),
  onEvents: (batch, frameIdx, seq, t, evOnly) => out.push({ batch, frameIdx, seq, t, evOnly: evOnly === true }),
});

const bmp = new EventBitmap(800, 480, 0.5);
const agg = new StatsAggregator();
const trk = new EvOnlyTracker();
let batchCount = 0;
for (let i = 0; i < PACKETS; i++) {
  const t = 1_000_000 + i * PKT_MS;
  asm.push(pkt(FROZEN, 0, null, recs((i % 40) + 1, PER)), t);
  // 网关 → 前端：装配器每出一批，这里就按 IPC EVENTS(FLAG_EV_ONLY) 的语义立即喂前端纯逻辑
  while (batchCount < out.length) {
    const e = out[batchCount++];
    if (!e.evOnly) continue;
    applyEvOnlyBatch(bmp, agg, trk, e.t, e.seq, e.batch.records, e.batch.records.length * REC, false);
  }
}
asm.tick(1_000_000 + PACKETS * PKT_MS + 40); // 排空最后一个窗口（现场网关 tick 周期 200 ms）
while (batchCount < out.length) {
  const e = out[batchCount++];
  if (!e.evOnly) continue;
  applyEvOnlyBatch(bmp, agg, trk, e.t, e.seq, e.batch.records, e.batch.records.length * REC, false);
}

const timed = out.filter((e) => e.evOnly);
const delivered = out.reduce((n, e) => n + e.batch.records.length, 0);
check(timed.length >= 50, "2.5 s 连续纯事件（frameIdx 冻结）⇒ 时间窗批次≥50", timed.length + " 批");
check(asm.counters.evDrop === 0, "时间窗兜底后 evDrop 必须为 0（现场 5,495,957）", "evDrop=" + asm.counters.evDrop);
check(asm.counters.evOrphan === 0, "无可归属事件", "evOrphan=" + asm.counters.evOrphan);
check(frames.length === 0, "EV_ONLY 阶段不产生原始帧（前端不得再等 FRAME_RAW）", "FRAME_RAW=" + frames.length);
check(delivered === PACKETS * PER, "事件一条不多一条不少（总数守恒）", delivered + "/" + PACKETS * PER);
let monotonic = true;
for (let i = 1; i < timed.length; i++) if (timed[i].seq <= timed[i - 1].seq) monotonic = false;
check(monotonic && timed[0]?.seq === 1, "逻辑帧号从 1 起严格单调递增", timed.length === 0 ? "无批" : timed[0].seq + "…" + timed[timed.length - 1].seq);
check(timed.every((e) => e.frameIdx === FROZEN), "批次仍携带板端原始帧号（仅作诊断；配对靠标记区分）", "frameIdx=" + FROZEN);

const now = 1_000_000 + PACKETS * PKT_MS + 40;
const snap = agg.snapshot(now);
const view = trk.view(now);
check(bmp.activeCells > 0, "无 FRAME_RAW 事件也上屏（L2 不再全黑）", "activeCells=" + bmp.activeCells);
check(snap.eventRate > 0, "事件率非 0（现场 82~110 kev/s）", snap.eventRate.toFixed(1) + " ev/s");
check(snap.evBatchRate > 0 && snap.eventsPerBatch > 0, "批次率/每批点数非 0（替代'每帧点数'口径）", snap.evBatchRate.toFixed(1) + " 批/s · " + snap.eventsPerBatch.toFixed(1) + " 点/批");
check(snap.eventsPerFrame === 0, "EV_ONLY 下 eventsPerFrame 按定义恒 0（界面必须改读 eventsPerBatch）", "eventsPerFrame=" + snap.eventsPerFrame);
check(view.active === true && view.batches === timed.length && view.lastBatchIdx === timed[timed.length - 1].seq, "EV_ONLY 视图 active 且批次连续", "batches=" + view.batches + " last=" + view.lastBatchIdx);
check(evOnlyRawBadge(view, false) === "无原始帧（EV_ONLY）", "L1 角标：无原始帧时明确标注", evOnlyRawBadge(view, false));
check(evOnlyRawBadge(view, true) === "原始帧已冻结（EV_ONLY）", "L1 角标：保留最后完整帧时明确标注", evOnlyRawBadge(view, true));

// ————————————— ② 回切 MODE0：真实原始帧 + 帧内事件 —————————————
const raw = new Uint8Array(profile.frame.bytes);
for (let i = 0; i < raw.length; i++) raw[i] = (i + 6041) & 0xff;
for (let i = 0; i < N; i++) {
  asm.push(pkt(6041, i, raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length)), i === 0 ? recs(50, 3) : null), 2_000_000 + i);
}
check(frames.length === 1, "回切后首帧 FRAME_RAW 正常交付（mode0 不被 EV_ONLY 修复污染）", "frames=" + frames.length);
check(frames[0]?.frameIdx === 6041 && frames[0]?.events.records.length === 3, "帧内事件随帧交付且条数正确", "idx=" + frames[0]?.frameIdx + " events=" + frames[0]?.events.records.length);
check(asm.counters.evOrphan === 0, "回切后无孤儿事件（逻辑帧号未混入配对）", "evOrphan=" + asm.counters.evOrphan);

// ————————————— ③ 反向对照：关掉时间窗 ⇒ evDrop 必须重现 —————————————
const PER2 = 550;
const PACKETS2 = 1040; // 5.2 s @ ~110 kev/s
const asmSlow = new FrameAssembler({ profile, evFlushMs: 5000, onFrame: () => {}, onEvents: () => {} });
function bigRecs(tag, n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push({ x: (tag * 97 + i) & 0x1ff, y: (i * 7) % 480, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: (i * 13) & 0xff });
  return encodeEvents(list, REC);
}
for (let i = 0; i < PACKETS2; i++) asmSlow.push(pkt(FROZEN, 0, null, bigRecs(i, PER2)), 1_000_000 + i * PKT_MS);
const dropSlow = asmSlow.counters.evDrop;
check(dropSlow > 0, "反向对照：evFlushMs=5000 时 2 MB 事件环真的会溢出（证明 40 ms 窗口是真 gate）", "evDrop=" + dropSlow);

const ok = results.every((r) => r.ok);
console.log("EV_ONLY_OK=" + (ok ? 1 : 0));
process.exit(ok ? 0 : 1);
