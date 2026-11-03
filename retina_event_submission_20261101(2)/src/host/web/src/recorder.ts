// 内存帧环：录制期间把最近若干帧留在内存里，导出按钮点下去就有东西可导。
//
// 为什么要有上限：768 KB/帧（400×240 RGB565 全分辨率）在主线程里堆着，
// 只按帧数限会随分辨率变化而失控 —— 768×480 的一帧就是 3 MB，600 帧能吃掉 1.8 GB 内存，
// 浏览器直接崩标签页。所以同时按字节数与帧数双限，谁先到就丢谁。
//
// "环形"在这里用数组 + shift 实现而不是取模索引：容量上限只有几百，
// shift 的搬移成本可以忽略；而取模环形缓冲会让 slice/span 这类"按顺序取一段"的操作
// 变得容易写错（跨环回绕），这类 bug 只在录满一圈后才出现，最难复现。
//
// 一个必须记住的契约：**push 时复制 raw**。上游每帧复用同一块像素缓冲，
// 不复制的话环里所有帧最终都指向同一张图 —— 录制"成功"、导出全是最后一帧。
import type { RecordedFrame } from "./export/framebin.ts";

/**
 * 从本模块也能取到帧类型：导出链路（export/render.ts、export/pngseq.ts、main.ts）
 * 拿到的是"录进环里的帧"，从 recorder 导入比从 framebin 导入更贴合语义。
 * 只转出类型，不转出实现 —— 容器格式的实现细节仍然只属于 framebin.ts。
 */
export type { RecordedFrame };

export interface RecorderOptions {
  readonly maxBytes?: number;
  readonly maxFrames?: number;
}

/** 约 30 s 帧环：3.25 fps × 768 KB ≈ 2.5 MB/s，96 MiB 落在 30 s 出头（给元数据留了余量） */
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_FRAMES = 600;

/** 事件-only 帧共享的空像素缓冲（不分配、不复制、不计费；内容永远不可写） */
const EMPTY_RAW = new Uint8Array(0);

export class Recorder {
  private readonly limitBytes: number;
  private readonly limitFrames: number;
  private buf: RecordedFrame[] = [];
  private usedBytes = 0;
  /** 内部计数（字段名不能叫 evicted：会与下面的 getter 撞名） */
  private droppedCount = 0;

  constructor(opts: RecorderOptions = {}) {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`Recorder 的 maxBytes 必须是正数，收到 ${String(opts.maxBytes)}`);
    }
    if (!Number.isFinite(maxFrames) || maxFrames < 1) {
      throw new Error(`Recorder 的 maxFrames 必须是 ≥1 的整数，收到 ${String(opts.maxFrames)}`);
    }
    this.limitBytes = maxBytes;
    this.limitFrames = Math.floor(maxFrames);
  }

  /**
   * 收一帧。
   *
   * `raw.slice()` 是拷贝（`subarray` 才是视图，两者在这里混用就会重现"每帧都是同一张图"的 bug）。
   * events/detections 不复制：它们的契约是每次新建的小数组，复制 600 帧 × 上万条事件
   * 反而会把主线程拖住，收益为零。
   *
   * 另一条被 main.ts 依赖的契约：这是**浅拷贝**，`events` 的**数组身份被保留**。
   * 协议把 FRAME_RAW 与 EVENTS 分两条消息发（隔一个 tick），所以调用方先塞一个空数组占位，
   * 等事件到了再往同一个数组对象里 push —— 复制数组会让那一步补的事件落进虚空。
   */
  push(f: RecordedFrame): void {
    if (f.hasRaw === false) {
      // 事件-only 帧没有像素：元数据/事件照存，raw 归一成共享空缓冲。
      // 不复制调用方的缓冲（可能是任意非空占位），也不计 usedBytes ——
      // 否则串口 EV_ONLY 录 600 帧会虚报几百 MB 占用，还会把像素帧提前挤掉。
      this.buf.push({ ...f, raw: EMPTY_RAW });
    } else {
      this.buf.push({ ...f, raw: f.raw.slice() });
      this.usedBytes += f.raw.byteLength;
    }
    this.trim();
  }

  /** 已缓存帧的 raw 总字节（不含元数据；UI 上显示的"占用"就用它） */
  get bytes(): number {
    return this.usedBytes;
  }

  /**
   * 返回缓冲的**浅拷贝**：调用方拿到内部数组后 push/splice 会让 usedBytes 与数组不一致，
   * 之后 evictionCount、bytes 全是错的，而且不会立刻报错。
   */
  get frames(): readonly RecordedFrame[] {
    return this.buf.slice();
  }

  /** 因超预算被丢掉的帧数：必须能在 UI 上说出来，静默丢帧会让用户以为"这段全录上了" */
  get evictionCount(): number {
    return this.droppedCount;
  }

  /** 字节预算上限（时间轴画"还剩多少"要用）；与 maxBytes 选项一致 */
  get capacityBytes(): number {
    return this.limitBytes;
  }

  /** 最旧到最新的时间跨度（ms）。空缓冲返回 0；到达时刻乱序时钳到 0，不返回负数 */
  get spanMs(): number {
    const first = this.buf[0];
    const last = this.buf[this.buf.length - 1];
    if (first === undefined || last === undefined) return 0;
    return Math.max(0, last.tMs - first.tMs);
  }

  /**
   * 取 [fromIdx, toIdx] 闭区间的帧（两端都包含）。
   *
   * 参数是**缓冲数组下标**，不是帧号 frameIdx：时间轴的选区（`FrameRange.from/to`）
   * 就是按下标给的（它自己只知道"缓冲里有几帧"），而且上游丢帧会让 frameIdx 出现空洞 ——
   * 那时用帧号解释会让"选中的第 3 段"落到别的帧上。要帧号请自己从返回的帧上读 `.frameIdx`。
   *
   * 越界一律收敛到合法下标：负的 from 当 0，超长的 to 当最后一帧，空缓冲返回空数组，
   * 全程不抛异常 —— 刚启动就点导出、或选区还停在被淘汰的旧范围上，都会走到这些路径。
   */
  slice(fromIdx: number, toIdx: number): readonly RecordedFrame[] {
    const n = this.buf.length;
    if (n === 0) return [];
    const clamp = (v: number, fallback: number): number =>
      Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(v) ? v : fallback)));
    const lo = clamp(fromIdx, 0);
    const hi = clamp(toIdx, n - 1);
    if (lo > hi) return [];
    return this.buf.slice(lo, hi + 1);
  }

  /** 清空并把 evictionCount 归零：新一次录制不该继承上一段的丢帧计数 */
  clear(): void {
    this.buf = [];
    this.usedBytes = 0;
    this.droppedCount = 0;
  }

  private trim(): void {
    // 循环条件带 `length > 1`：单帧体积就超过 maxBytes 时（比如把 maxBytes 设得比一帧还小），
    // 至少保留最新一帧。否则会出现"按了录制却永远 0 帧"这种看起来像功能坏掉的现象。
    while ((this.usedBytes > this.limitBytes || this.buf.length > this.limitFrames) && this.buf.length > 1) {
      const dropped = this.buf.shift();
      if (dropped === undefined) break;
      this.usedBytes -= dropped.raw.byteLength;
      this.droppedCount++;
    }
  }
}
