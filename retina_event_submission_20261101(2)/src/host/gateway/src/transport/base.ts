// 所有数据源的公共骨架（L0 插槽基类，SPI v1 的 IFrameSource 实现）。
// 为什么把解析+装配放在源里：IFrameSource 的冻结契约只有 frame/events/stats/error 四种事件，
// 也就是说"源"对上层就代表"帧流"。协议解析集中在 pipeline/processor，源本身仍然只搬字节。
import { createCounters } from "@retina/protocol";
import type {
  Counters,
  EventBatch,
  FramePacket,
  IFrameSource,
  ParsedV3,
  Profile,
  SourceError,
  SourceInfo,
  SourceStats,
  Unsubscribe,
} from "@retina/protocol";
import { PacketProcessor } from "../pipeline/processor.ts";

/** setInterval 返回值在 DOM/Node 两种 lib 下不同，用鸭子类型 unref，避免测试被定时器吊住 */
export function unrefTimer(t: unknown): void {
  const fn = (t as { unref?: () => void }).unref;
  if (typeof fn === "function") fn.call(t);
}

export interface BaseSourceOptions {
  readonly profile: Profile;
  // 这些字段会被具体源原样转发，exactOptionalPropertyTypes 下要允许 undefined
  readonly frameTimeoutMs?: number | undefined;
  readonly evRingMaxBytes?: number | undefined;
  readonly synthetic?: boolean | undefined;
  /**
   * 数据源是否具备原始段（ADDITIVE，七修）。串口 UART-LINK 只回传事件帧 ⇒ false；
   * UDP/回放/合成缺省 true。装配器据此把"无原始段的 v3 事件包"按 EV_ONLY 语义交付。
   */
  readonly rawCapable?: boolean | undefined;
  /** 帧超时检查周期（04 §3：200 ms） */
  readonly tickIntervalMs?: number | undefined;
  /** STATS 聚合周期（04 §7.2：1 Hz） */
  readonly statsIntervalMs?: number | undefined;
  /** v3 CTRL 包出口（ACK / 心跳 / TIME_SYNC_REQ → 状态/校准通道；WIRE-V3 §7.2） */
  readonly onCtrl?: ((pkt: ParsedV3) => void) | undefined;
  /** v3 数据包 MODE 观察者（网关维护 currentMode 的主通道，§3.3） */
  readonly onV3Mode?: ((mode: number) => void) | undefined;
}

/**
 * 扩展订阅：带 frameIdx/逻辑帧号/tArriveMs 的事件批次（ws 填 EVENTS 首部需要这些字段）。
 * evOnly=true ⇒ 纯事件-时间窗批次（板端 EV_ONLY 下事件包帧号冻结）：seq 是**网关自增逻辑帧号**，
 * 这批事件**不配对任何原始帧**，前端必须立即上屏（IPC EVENTS 的 FLAG_EV_ONLY 与之一一对应）。
 */
export type EventsDetailedCb = (
  b: EventBatch,
  frameIdx: number,
  seq: number,
  tArriveMs: number,
  evOnly?: boolean,
) => void;

export class BaseFrameSource implements IFrameSource {
  readonly spiVersion: 1 = 1;
  readonly info: SourceInfo;
  /** 与装配器共享同一份计数器，整个网关只有一个统计口径 */
  readonly counters: Counters;
  /** 数据源能力位：是否可能产出原始帧（串口事件链路 = false；IPC STATS/EVENTS 用它区分文案） */
  readonly rawCapable: boolean;

  protected readonly profile: Profile;
  protected readonly processor: PacketProcessor;

  private started = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly statsIntervalMs: number;

  private readonly frameSubs = new Set<(p: FramePacket) => void>();
  private readonly eventSubs = new Set<(e: EventBatch) => void>();
  private readonly eventDetailedSubs = new Set<EventsDetailedCb>();
  private readonly statsSubs = new Set<(s: SourceStats, c: Counters) => void>();
  private readonly errorSubs = new Set<(e: SourceError) => void>();

  constructor(opts: BaseSourceOptions) {
    this.profile = opts.profile;
    this.rawCapable = opts.rawCapable ?? true;
    this.counters = createCounters();
    this.info = {
      wire: opts.profile.wire,
      profile: opts.profile.name,
      geometry: { w: opts.profile.frame.w, h: opts.profile.frame.h },
      evRecBytes: opts.profile.evRecBytes,
    };
    this.tickIntervalMs = opts.tickIntervalMs ?? 200;
    this.statsIntervalMs = opts.statsIntervalMs ?? 1000;
    this.processor = new PacketProcessor({
      profile: opts.profile,
      counters: this.counters,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
      synthetic: opts.synthetic,
      rawCapable: this.rawCapable,
      // 注意：这两个不能叫 emitFrame/emitEvents —— 子类有同名方法时会在 JS 里被遮蔽成递归
      onFrame: (f) => this.deliverFrame(f),
      // processor 的 ProcessorOptions.onEvents 还是 4 参（不在本轮白名单里）：第 5 参声明为可选即可赋值，
      // 运行时 assembler 会带 5 个实参调用，JS 原样透传。
      onEvents: (b: EventBatch, idx: number, seq: number, t: number, evOnly?: boolean) =>
        this.deliverEvents(b, idx, seq, t, evOnly),
      onError: (e) => this.emitError(e),
      onCtrl: opts.onCtrl,
      onV3Mode: opts.onV3Mode,
    });
  }

  get running(): boolean {
    return this.started;
  }

  get bytesRaw(): number {
    return this.processor.bytesRaw;
  }

  get bytesEvents(): number {
    return this.processor.bytesEvents;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.onStart();
    this.tickTimer = setInterval(() => this.processor.tick(Date.now()), this.tickIntervalMs);
    this.statsTimer = setInterval(() => this.emitStats(), this.statsIntervalMs);
    unrefTimer(this.tickTimer);
    unrefTimer(this.statsTimer);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.onStop();
    // 结算悬挂帧：不完整帧计 aborted，绝不交付半帧（g03 判据）
    this.processor.finish();
    this.emitStats();
  }

  on(evt: "frame", cb: (p: FramePacket) => void): Unsubscribe;
  on(evt: "events", cb: (e: EventBatch) => void): Unsubscribe;
  on(evt: "stats", cb: (s: SourceStats, c: Counters) => void): Unsubscribe;
  on(evt: "error", cb: (e: SourceError) => void): Unsubscribe;
  on(evt: "frame" | "events" | "stats" | "error", cb: unknown): Unsubscribe {
    if (evt === "frame") {
      const fn = cb as (p: FramePacket) => void;
      this.frameSubs.add(fn);
      return () => {
        this.frameSubs.delete(fn);
      };
    }
    if (evt === "events") {
      const fn = cb as (e: EventBatch) => void;
      this.eventSubs.add(fn);
      return () => {
        this.eventSubs.delete(fn);
      };
    }
    if (evt === "stats") {
      const fn = cb as (s: SourceStats, c: Counters) => void;
      this.statsSubs.add(fn);
      return () => {
        this.statsSubs.delete(fn);
      };
    }
    const fn = cb as (e: SourceError) => void;
    this.errorSubs.add(fn);
    return () => {
      this.errorSubs.delete(fn);
    };
  }

  /** SPI 之外的扩展：ws 需要 frameIdx/tArriveMs 才能填 IPC 首部 */
  onEventsDetailed(cb: EventsDetailedCb): Unsubscribe {
    this.eventDetailedSubs.add(cb);
    return () => {
      this.eventDetailedSubs.delete(cb);
    };
  }

  /** 立即取一次统计（连接建立时先推一条，前端不用等 1 s）。含 bytesRaw/bytesEvents 拆分口径 */
  snapshotStats(nowMs = Date.now()): SourceStats {
    return this.processor.snapshotStats(nowMs);
  }

  /**
   * PC 侧学到的板端 offset_reg（WIRE-V3 §5.1）。
   * V3Link 从 TIME_SYNC ACK 的 TLV 0x84 学到后注入；影响其后每一帧的 tBoardMs（路径②）。
   */
  setTsOffsetUs(offsetUs: number | null): void {
    this.processor.setTsOffsetUs(offsetUs);
  }

  // —— 子类可覆写 ——
  protected onStart(): void {}
  protected onStop(): void {}

  /** 子类把收到的原始负载喂进来；解析路径与实时完全一致 */
  protected feed(buf: Uint8Array, tArriveMs = Date.now()): void {
    this.processor.pushRawPayload(buf, tArriveMs);
  }

  protected emitError(e: SourceError): void {
    for (const cb of this.errorSubs) cb(e);
  }

  private deliverFrame(f: FramePacket): void {
    for (const cb of this.frameSubs) cb(f);
  }

  private deliverEvents(
    b: EventBatch,
    frameIdx: number,
    seq: number,
    tArriveMs: number,
    evOnly = false,
  ): void {
    for (const cb of this.eventSubs) cb(b);
    for (const cb of this.eventDetailedSubs) cb(b, frameIdx, seq, tArriveMs, evOnly);
  }

  private emitStats(): void {
    const now = Date.now();
    const stats = this.processor.snapshotStats(now);
    for (const cb of this.statsSubs) cb(stats, this.counters);
  }
}
