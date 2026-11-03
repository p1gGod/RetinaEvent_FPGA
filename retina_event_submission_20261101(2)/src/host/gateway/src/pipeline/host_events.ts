// 网关侧的「上位机模拟处理」：用与 RTL 同构的算法，从**板子送来的原始帧**算出事件。
//
// 它解决的问题（用户 2026-10-06 提出）：板上改算法要综合+实现+烧录，链条太长，
// 根本看不到"算法真正跑起来长什么样"。这里给出**标准对照**：
// 同一帧输入，一边是板端 v2 自带的事件，一边是这里算出来的事件，差异一眼可见。
//
// 关键设计：事件**不改协议**。算出来的事件照样编成 EV_DATA 字节、照样走 EVENTS IPC 消息，
// 前端用同一条解码路径画（只是多一个 flag 标明来源）。这样"板端/上位机"两条来源在
// 前端完全对称，切换时不会出现两套渲染逻辑。
import { EventBitmap, RetinaEngine, TB_PARAMS, type RetinaParams } from "@retina/retina";
import { encodeEvents } from "@retina/protocol";
import type { EventRecord, FramePacket, Profile } from "@retina/protocol";

export type EventSourceKind = "board" | "host";

export interface HostEvents {
  readonly records: readonly EventRecord[];
  /** 已编码的 EV_DATA 字节（前端 decodeEvents 直接吃） */
  readonly raw: Uint8Array;
  /** 恒定 true：这批事件是上位机算的（IPC 首部的 FLAG_HOST_SIM 据此置位） */
  readonly host: true;
}

export class HostEventProcessor {
  private engine: RetinaEngine;
  private readonly bitmap: EventBitmap;
  private readonly recBytes: number;
  /** 最近一次位图内容对应的帧号与来源（/api/events.json 用） */
  lastFrameIdx = -1;
  lastOrigin: EventSourceKind = "board";
  lastCount = 0;

  constructor(profile: Profile, params: RetinaParams = TB_PARAMS) {
    this.engine = new RetinaEngine(params);
    this.bitmap = new EventBitmap(profile.evGrid.w, profile.evGrid.h, 0.55);
    this.recBytes = profile.evRecBytes;
  }

  /** 换参数（θ 档位等）时要重建引擎，并清空位图——否则旧余晖会挂在屏上 */
  setParams(params: RetinaParams): void {
    this.engine = new RetinaEngine(params);
    this.bitmap.reset();
  }

  get params(): RetinaParams {
    return this.engine.params;
  }

  /** 用上位机算法算这一帧的事件（不碰位图） */
  compute(f: FramePacket): HostEvents {
    const r = this.engine.processBeBytes(f.raw, f.w, f.h);
    return { records: r.events, raw: encodeEvents(r.events, this.recBytes), host: true };
  }

  /**
   * 推进一帧的位图：**先衰减、再写本帧事件**（与 RTL 实测等效模型一致）。
   * 每帧都必须调用，哪怕本帧没有事件 —— 否则余晖永不消散（这正是之前那个"切回实时后画面冻住"的根因）。
   */
  stepBitmap(records: readonly EventRecord[], frameIdx: number, origin: EventSourceKind): void {
    this.bitmap.step();
    this.bitmap.apply(records);
    this.lastFrameIdx = frameIdx;
    this.lastOrigin = origin;
    this.lastCount = records.length;
  }

  /** 给 /api/events.png 的一份独立副本（调用方可能要降采样，不该动到内部缓冲） */
  bitmapRgba(): Uint8ClampedArray {
    return this.bitmap.toRgba();
  }

  get gridW(): number {
    return this.bitmap.w;
  }

  get gridH(): number {
    return this.bitmap.h;
  }

  reset(): void {
    this.engine.reset();
    this.bitmap.reset();
    this.lastFrameIdx = -1;
    this.lastCount = 0;
  }
}
