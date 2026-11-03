// 事件位图：把事件记录变成"可绘制、可衰减"的累积位图。
//
// 为什么要共享到包层（而不是只留在 web 里）：现在有**两个**消费者
//   ① 浏览器：把 EVENTS 消息画到 L2 图层（要 rgba + revision，避免每帧重传 ImageData）
//   ② 网关：把事件渲染成 PNG 给 /api/events.png（别的 agent 拉图用）
// 两边必须"同一张图"——否则 UI 上看到的和 agent 拉到的会不一致，那种 bug 最难查。
//
// 性能：事件率可达上万条/秒，遍历全部历史事件必然掉帧。
// 所以 active[] 只保存"非零单元"：衰减 O(活跃单元)，置位 O(新事件)。
import type { EventRecord } from "@retina/protocol";

/** 事件层配色（与板上 event_render 一致：ON 红 / OFF 蓝） */
export const EV_COLOR = { on: [255, 77, 99], off: [77, 155, 255] } as const;

/** 衰减到低于它就认为"熄灭"（避免留下永远不消的鬼影） */
const EXTINGUISH = 0.03;

export class EventBitmap {
  readonly w: number;
  readonly h: number;
  /** 供 canvas putImageData / PNG 编码直接使用；背景纯黑（图层用 screen 混合，黑=不改变底图） */
  readonly rgba: Uint8ClampedArray;
  /** 余晖衰减系数（与板上位图同构） */
  readonly decay: number;

  private readonly intens: Float32Array;
  private readonly pol: Int8Array;
  private active: Int32Array;
  private activeCount = 0;
  private onCells = 0;
  private offCells = 0;
  /** 内容每次变化 +1；上层据此决定要不要重传 ImageData */
  revision = 0;

  constructor(w: number, h: number, decay = 0.55) {
    this.w = w;
    this.h = h;
    this.decay = decay;
    this.rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
    this.intens = new Float32Array(w * h);
    this.pol = new Int8Array(w * h);
    this.active = new Int32Array(8192);
  }

  get activeCells(): number {
    return this.activeCount;
  }

  get polarity(): { on: number; off: number } {
    return { on: this.onCells, off: this.offCells };
  }

  private write(cell: number): void {
    const i = this.intens[cell] ?? 0;
    const c = (this.pol[cell] ?? 0) > 0 ? EV_COLOR.on : EV_COLOR.off;
    const o = cell * 4;
    this.rgba[o] = c[0] * i;
    this.rgba[o + 1] = c[1] * i;
    this.rgba[o + 2] = c[2] * i;
  }

  /** 置位：新事件把该单元拉到最亮并记住极性 */
  apply(records: readonly EventRecord[], count = records.length): void {
    let touched = false;
    for (let k = 0; k < count; k++) {
      const r = records[k];
      if (r === undefined) continue;
      if (r.x < 0 || r.x >= this.w || r.y < 0 || r.y >= this.h) continue;
      const cell = r.y * this.w + r.x;
      const wasActive = (this.intens[cell] ?? 0) > 0;
      const wasOn = (this.pol[cell] ?? 0) > 0;
      if (wasActive) {
        // 极性翻转要把旧极性从计数里扣掉，否则 ON/OFF 占比会越跑越偏
        if (wasOn) this.onCells--;
        else this.offCells--;
      } else {
        if (this.activeCount >= this.active.length) {
          const grown = new Int32Array(this.active.length * 2);
          grown.set(this.active);
          this.active = grown;
        }
        this.active[this.activeCount++] = cell;
      }
      if (r.pol === 1) this.onCells++;
      else this.offCells++;
      this.intens[cell] = 1;
      this.pol[cell] = r.pol === 1 ? 1 : -1;
      this.write(cell);
      touched = true;
    }
    if (touched) this.revision++;
  }

  /** 逐帧衰减：只遍历活跃单元；衰减到阈值的单元 swap-remove 出活跃集（保持 O(1)） */
  step(): void {
    if (this.activeCount === 0) return;
    let n = 0;
    for (let a = 0; a < this.activeCount; a++) {
      const cell = this.active[a] ?? 0;
      const v = (this.intens[cell] ?? 0) * this.decay;
      if (v < EXTINGUISH) {
        this.intens[cell] = 0;
        if ((this.pol[cell] ?? 0) > 0) this.onCells--;
        else this.offCells--;
        this.pol[cell] = 0;
        const o = cell * 4;
        this.rgba[o] = 0;
        this.rgba[o + 1] = 0;
        this.rgba[o + 2] = 0;
        continue;
      }
      this.intens[cell] = v;
      this.active[n++] = cell;
      this.write(cell);
    }
    this.activeCount = n;
    this.revision++;
  }

  reset(): void {
    for (let a = 0; a < this.activeCount; a++) {
      const cell = this.active[a] ?? 0;
      this.intens[cell] = 0;
      this.pol[cell] = 0;
      const o = cell * 4;
      this.rgba[o] = 0;
      this.rgba[o + 1] = 0;
      this.rgba[o + 2] = 0;
    }
    this.activeCount = 0;
    this.onCells = 0;
    this.offCells = 0;
    this.revision++;
  }

  /** 给 PNG 编码用的一份独立副本（调用方可能要降采样，不该动到内部缓冲） */
  toRgba(): Uint8ClampedArray {
    return this.rgba.slice();
  }
}
