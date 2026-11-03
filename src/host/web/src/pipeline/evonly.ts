// EV_ONLY（板端 KEY3 第三档：只回传事件）的前端纯逻辑：没有 DOM 依赖，可直接在 node --test 里跑。
//
// 为什么需要单独一层（2026-10-17 用户现场 bug）：
//   mode=2 时板端**不发 FRAME_RAW**，事件包的 FRAME_IDX 还冻结在同一个值（udp_merge 用 raw_pop 计数当帧号）。
//   旧前端把"置位 + 衰减"全挂在 FRAME_RAW 上，于是事件到了也只进队列、永远不上屏：L1 停旧图、L2 全黑、
//   事件率 0.0 ev/s、每帧 0/96 000。网关侧现在按 ~40 ms 时间窗把纯事件包打成批，并给每批分配
//   自增逻辑帧号 + IPC FLAG_EV_ONLY 位；前端据此"批到即上屏、每批衰减一次"，统计口径改成"批次"。
//
// 这里只放三件可单测的事：
//   1) FLAG 常量与批次的"活跃/陈旧"判定（切回配帧模式后不能把界面钉在 EV_ONLY 上）；
//   2) applyEvOnlyBatch：置位/衰减/统计一次做完（main.ts 的 handleEvents 只调它）；
//   3) 文案：L1 角标 / L2 元信息 / 侧栏"每批点数"，全部是纯函数，测试不必碰 DOM。
import type { EventRecord } from "@retina/protocol";

/**
 * IPC EVENTS.flags 的 EV_ONLY 位，与 gateway/src/ipc/ws.ts 的 FLAG_EV_ONLY 同值。
 * 为什么不加进 packages/protocol：那套 flag 是**线格式语义**（THINNED/KEYFRAME/SYNTHETIC/HOST_SIM），
 * 改它的语义要动 RTL/文档；这里借用 IPC 层尚未使用的一位，网关与前端各自定义、由本文件与 ws.ts 对齐。
 */
export const EV_ONLY_FLAG = 0b10000;

/**
 * IPC EVENTS.flags 的"本通道没有原始画面"位，与 gateway/src/ipc/ws.ts 的 FLAG_NO_RAW 同值。
 * 串口 UART-LINK 只回传事件帧（RAW_LEN 恒 0），与板端 KEY3 的 EV_ONLY 是两件事：
 *   · EV_ONLY = 板端当前档位不产生原始帧（可能切回 R+E）；
 *   · NO_RAW  = **这条通道本身**永远没有原始段（串口），文案必须说"串口模式"，不能误导用户去按 KEY3。
 */
export const EV_NO_RAW_FLAG = 0b100000;

/** 超过这么久没有新的 EV_ONLY 批 ⇒ 判定"已经切回配帧模式"（不用等下一帧，也不用手动复位） */
export const EV_ONLY_STALE_MS = 1500;

/** EV_ONLY 状态的不可变快照（供 sidebar/main 渲染；测试可直接断言字段） */
export interface EvOnlyView {
  /** 当前是否处于 EV_ONLY（最近有 EV_ONLY 批，且之后没有新的原始帧） */
  readonly active: boolean;
  /** 累计 EV_ONLY 批次数 */
  readonly batches: number;
  /** 最后一批的逻辑帧号（网关自增，不是板端 16bit FRAME_IDX） */
  readonly lastBatchIdx: number;
  /** 最后一批的事件点数 */
  readonly lastBatchPoints: number;
  /** 累计事件点数 */
  readonly events: number;
  /** 最后一批的到达时刻（performance.now 口径） */
  readonly lastBatchAtMs: number;
  /** active 时是否还有一张完整的原始帧可以显示（决定 L1 角标文案） */
  readonly frozenRaw: boolean;
  /** 当前通道是否**天生没有原始画面**（串口 UART-LINK）：文案要说"串口模式"，不能只写 EV_ONLY */
  readonly noRawSource: boolean;
}

/** EV_ONLY 批次追踪器：只记账，不做 I/O */
export class EvOnlyTracker {
  private readonly staleMs: number;
  private batches = 0;
  private events = 0;
  private lastBatchIdx = 0;
  private lastBatchPoints = 0;
  private lastBatchAtMs = 0;
  private lastRawAtMs = 0;
  private noRawSource = false;

  constructor(staleMs = EV_ONLY_STALE_MS) {
    this.staleMs = staleMs;
  }

  /** 收到一批 EV_ONLY 事件（t / frameIdx 都是 IPC 消息里的字段） */
  noteBatch(t: number, frameIdx: number, points: number, noRaw = false): void {
    this.noRawSource = noRaw;
    this.batches++;
    this.events += points;
    this.lastBatchIdx = frameIdx;
    this.lastBatchPoints = points;
    this.lastBatchAtMs = t;
  }

  /** 收到一张真实原始帧：配帧通路已恢复（切回 mode0/1 或别的来源），EV_ONLY 状态立即失效 */
  noteRawFrame(t: number): void {
    this.lastRawAtMs = t;
  }

  get batchCount(): number {
    return this.batches;
  }

  get eventCount(): number {
    return this.events;
  }

  view(now: number): EvOnlyView {
    const recent = this.lastBatchAtMs > 0 && now - this.lastBatchAtMs <= this.staleMs;
    // 最后一张原始帧比最后一批 EV_ONLY 新 ⇒ 配帧通路回来了，别再把界面钉在"已冻结"上。
    const rawResumed = this.lastRawAtMs > this.lastBatchAtMs;
    const active = recent && !rawResumed;
    return {
      active,
      batches: this.batches,
      lastBatchIdx: this.lastBatchIdx,
      lastBatchPoints: this.lastBatchPoints,
      events: this.events,
      lastBatchAtMs: this.lastBatchAtMs,
      frozenRaw: active,
      noRawSource: this.noRawSource,
    };
  }

  reset(): void {
    this.batches = 0;
    this.events = 0;
    this.lastBatchIdx = 0;
    this.lastBatchPoints = 0;
    this.lastBatchAtMs = 0;
    this.lastRawAtMs = 0;
    this.noRawSource = false;
  }
}

/** 位图侧只依赖这两个方法（EventBitmap 满足；测试可以塞假实现） */
export interface EvOnlyBitmapSink {
  step(): void;
  apply(records: readonly EventRecord[], count?: number): void;
}

/** 统计侧只依赖这两个方法（StatsAggregator 满足；测试可以塞假实现） */
export interface EvOnlyStatsSink {
  addEvents(t: number, count: number, bytes: number, on: number, off: number): void;
  addEvOnlyBatch(t: number): void;
}

export interface EvOnlyBatchResult {
  readonly on: number;
  readonly off: number;
}

/**
 * 把一批 EV_ONLY 事件一次性落到位图与统计：
 *   ① 每批**恰好衰减一次**（与配帧模式的"每帧一次"同构；不能每条消息都衰减，否则事件多时画面反而更暗）；
 *   ② 置位新事件；
 *   ③ 统计按"批次"记（eventsPerBatch 才是 EV_ONLY 下正确的"每帧点数"口径）。
 * frozen 时只记账不动位图：冻结是"画布停住"，不是"数据停止计数"（原则 P6：不静默丢数据）。
 */
export function applyEvOnlyBatch(
  bitmap: EvOnlyBitmapSink,
  stats: EvOnlyStatsSink,
  tracker: EvOnlyTracker,
  t: number,
  frameIdx: number,
  records: readonly EventRecord[],
  bytes: number,
  frozen: boolean,
  noRaw = false,
): EvOnlyBatchResult {
  let on = 0;
  let off = 0;
  for (const r of records) {
    if (r.pol === 1) on++;
    else off++;
  }
  tracker.noteBatch(t, frameIdx, records.length, noRaw);
  stats.addEvOnlyBatch(t);
  stats.addEvents(t, records.length, bytes, on, off);
  if (!frozen) {
    bitmap.step();
    if (records.length > 0) bitmap.apply(records);
  }
  return { on, off };
}

/** L1 角标：区分"有旧帧但已冻结"与"根本没有原始帧"（两者排障方向完全不同） */
export function evOnlyRawBadge(v: EvOnlyView, hasRawFrame: boolean): string {
  if (!v.active) return "";
  if (v.noRawSource) return "串口模式：无原始画面";
  return hasRawFrame ? "原始帧已冻结（EV_ONLY）" : "无原始帧（EV_ONLY）";
}

/** L2 元信息：事件率/批次/每批点数（都不允许出现 0——现场事件率 82~110 kev/s） */
export function evOnlyPaneMeta(points: number, lit: number, total: number, v: EvOnlyView): string {
  const pct = total > 0 ? (lit / total) * 100 : 0;
  const label = v.noRawSource ? "串口事件批次" : "EV_ONLY 批次";
  return label + " " + v.batches + " · 每批 " + points + " 点 · 点亮 " + lit + " / " + total + "（" + pct.toFixed(1) + "%）";
}

/** 侧栏事件流卡中间那行：EV_ONLY 下没有"每帧"，必须换成"每批" */
export function evOnlyLegend(eventsPerBatch: number, batches: number): string {
  return "每批 " + Math.round(eventsPerBatch).toLocaleString("en-US") + " 点 · 事件批次 " + batches.toLocaleString("en-US") + "（串口/EV_ONLY 不配对原始帧）";
}
