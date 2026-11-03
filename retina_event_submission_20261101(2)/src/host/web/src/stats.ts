// 统计聚合：把"高频、不可变"的消息流变成"低频、可显示"的数字（03 文档 §5 的 Stats Aggregator）。
// 为什么用固定槽环：槽是 250 ms 一格、共 16 格 = 4 s 窗口，每来一条消息只更新一格（O(1)、零分配），
// 所以显示数字不会随消息量抖动；曲线也直接取这 16 个格子 —— 和卡片上的"近 4 s"是同一个窗口，
// 不会出现"数字是 4 s 口径、曲线是 60 s 口径"这种对不上的情况。
import { COUNTER_KEYS, createCounters } from "@retina/protocol";
import type { Counters } from "@retina/protocol";
import type { ViewStats } from "./types.ts";

const SLOT_MS = 250;
const SLOTS = 16;           // 16 × 250 ms = 4 s 统计窗口
const WINDOW_MS = SLOT_MS * SLOTS;

interface Slot {
  key: number;
  rawBytes: number;
  chunks: number;
  frames: number;
  evCount: number;
  evBytes: number;
  /** EV_ONLY 批次数（网关按 ~40 ms 时间窗打包的纯事件批） */
  evBatches: number;
  on: number;
  off: number;
}

function newSlot(): Slot {
  return { key: -1, rawBytes: 0, chunks: 0, frames: 0, evCount: 0, evBytes: 0, evBatches: 0, on: 0, off: 0 };
}

export class StatsAggregator {
  private readonly slots: Slot[] = Array.from({ length: SLOTS }, newSlot);
  private counters: Counters = createCounters();
  private t0 = 0;
  private lastKey = -1;
  private lastMsgMs = 0;
  private localUiDrop = 0;

  /** 累计量（由网关 STATS 提供；合成源按同一口径给） */
  totalPackets = 0;
  totalBytes = 0;
  totalFrames = 0;
  /** 曲线数据版本号：每条事件消息 +1，界面据此决定要不要重画折线 */
  seriesRev = 0;

  private slot(t: number): Slot {
    const key = Math.floor(t / SLOT_MS);
    this.lastKey = key;
    const s = this.slots[((key % SLOTS) + SLOTS) % SLOTS];
    if (!s) return newSlot();
    if (s.key !== key) {
      s.key = key;
      s.rawBytes = 0;
      s.chunks = 0;
      s.frames = 0;
      s.evCount = 0;
      s.evBytes = 0;
      s.evBatches = 0;
      s.on = 0;
      s.off = 0;
    }
    return s;
  }

  addFrameRaw(t: number, rawBytes: number, chunks: number): void {
    const s = this.slot(t);
    s.rawBytes += rawBytes;
    s.chunks += chunks;
    s.frames += 1;
    this.totalFrames += 1;
    this.lastMsgMs = t;
    if (this.t0 === 0) this.t0 = t;
  }

  addEvents(t: number, count: number, bytes: number, on: number, off: number): void {
    const s = this.slot(t);
    s.evCount += count;
    s.evBytes += bytes;
    s.on += on;
    s.off += off;
    this.seriesRev++;
    this.lastMsgMs = t;
    if (this.t0 === 0) this.t0 = t;
  }

  /**
   * 记一批 EV_ONLY 事件（网关时间窗批）。
   * 为什么不把它算进 frames：EV_ONLY 下确实一张原始帧都没有，把批当帧会让 fps/相机帧率报假数；
   * 但"每帧点数"又必须有个非零口径 ⇒ 单独记批次，由 snapshot 给出 eventsPerBatch。
   */
  addEvOnlyBatch(t: number): void {
    const s = this.slot(t);
    s.evBatches += 1;
    this.lastMsgMs = t;
    if (this.t0 === 0) this.t0 = t;
  }

  addStats(t: number, packets: number, bytes: number, counters: Counters): void {
    this.totalPackets = packets;
    this.totalBytes = bytes;
    // 计数器必须整体替换（Counters 是只读快照），避免新旧字段混在一张表里
    const merged = { ...counters } as Record<string, number>;
    for (const k of COUNTER_KEYS) if (merged[k] === undefined) merged[k] = 0;
    this.counters = merged as unknown as Counters;
    this.lastMsgMs = t;
    if (this.t0 === 0) this.t0 = t;
  }

  /** 界面自己丢的帧也要计数（原则 P6：不静默），与网关的 uiDrop 合并显示 */
  bumpUiDrop(by = 1): void {
    this.localUiDrop += by;
  }

  /**
   * 清空全部累计量与窗口。
   *
   * 为什么必须能清（2026-10-06 用户报的 bug）：切换数据源（合成源 ↔ 网关实时）后，
   * 旧来源的 4 s 窗口与累计计数会和新来源混在一起 —— 界面上就出现
   * "已经切到实时了，事件率却还挂着合成源的数字"这种自相矛盾的状态。
   */
  reset(): void {
    for (const s of this.slots) {
      s.key = -1;
      s.rawBytes = 0;
      s.chunks = 0;
      s.frames = 0;
      s.evCount = 0;
      s.evBytes = 0;
      s.evBatches = 0;
      s.on = 0;
      s.off = 0;
    }
    this.counters = createCounters();
    this.t0 = 0;
    this.lastKey = -1;
    this.lastMsgMs = 0;
    this.localUiDrop = 0;
    this.totalPackets = 0;
    this.totalBytes = 0;
    this.totalFrames = 0;
    this.seriesRev++;
  }

  /**
   * 近 4 s 的 250 ms 分桶事件率（单位 ev/s，从旧到新）。
   * 没有数据的槽给 0：曲线画 0 而不是"跳过"，因为"这 250 ms 没有事件"本身是信息。
   */
  slotSeries(): number[] {
    const out: number[] = [];
    if (this.lastKey < 0) return out;
    for (let i = SLOTS - 1; i >= 0; i--) {
      const key = this.lastKey - i;
      const s = this.slots[((key % SLOTS) + SLOTS) % SLOTS];
      out.push(s && s.key === key ? (s.evCount * 1000) / SLOT_MS : 0);
    }
    return out;
  }

  /** 供状态栏按名字取计数器，避免到处写 ?? 0 */
  counter(name: keyof Counters): number {
    return this.counters[name] ?? 0;
  }

  snapshot(now: number): ViewStats {
    let rawBytes = 0;
    let evCount = 0;
    let evBytes = 0;
    let on = 0;
    let off = 0;
    let chunks = 0;
    let frames = 0;
    let evBatches = 0;
    const keyNow = Math.floor(now / SLOT_MS);
    for (const s of this.slots) {
      if (s.key < 0 || keyNow - s.key >= SLOTS) continue;
      rawBytes += s.rawBytes;
      evCount += s.evCount;
      evBytes += s.evBytes;
      on += s.on;
      off += s.off;
      chunks += s.chunks;
      frames += s.frames;
      evBatches += s.evBatches;
    }
    // 窗口秒数取"实际经过的时间"，但至少一格：刚打开页面时窗口还没走满，
    // 用满 4 s 去除会把速率报小（反之用 0 会除爆），250 ms 是能自洽的最小窗口。
    const spanMs = this.t0 > 0 ? Math.min(now - this.t0, WINDOW_MS) : SLOT_MS;
    const sec = Math.max(SLOT_MS / 1000, spanMs / 1000);
    const merged = { ...(this.counters as unknown as Record<string, number>) };
    merged["uiDrop"] = (merged["uiDrop"] ?? 0) + this.localUiDrop;
    const total = on + off;
    return {
      fps: frames / sec,
      camFps: 0, // 由调用方乘 profile.frameDecim 填充（聚合器不认识 profile）
      eventRate: evCount / sec,
      eventsPerFrame: frames > 0 ? evCount / frames : 0,
      evBatchRate: evBatches / sec,
      eventsPerBatch: evBatches > 0 ? evCount / evBatches : 0,
      // 字节级降低倍数：原始字节 ÷ 事件字节，两个量都来自同一个 4 s 窗口
      reduction: evBytes > 0 ? rawBytes / evBytes : 0,
      onShare: total > 0 ? on / total : 0,
      offShare: total > 0 ? off / total : 0,
      pps: chunks / sec,
      bps: rawBytes / sec,
      packets: this.totalPackets,
      frames: this.totalFrames,
      latencyMs: this.lastMsgMs > 0 ? Math.max(0, now - this.lastMsgMs) : 0,
      uiDrop: merged["uiDrop"] ?? 0,
      counters: merged as unknown as Counters,
    };
  }
}
