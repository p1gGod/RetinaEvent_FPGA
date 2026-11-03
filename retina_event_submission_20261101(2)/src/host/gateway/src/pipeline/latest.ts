// 最新帧/事件的单槽存储（原则 P3「丢帧优于卡顿」在网关侧的唯一落点）。
//
// 存在的理由：WS 推流是"推给浏览器"的，而 /api/* 是"别的进程来拉"的。
// 两者消费速度完全不同（浏览器 60 fps 渲染，另一个 agent 可能每 10 s 拉一张图），
// 所以必须有**一个**地方保存"当前最新的一帧/一张事件图"，让拉的人随时拿到，
// 而不是各自去订阅 2.5 MB/s 的流。
//
// 单槽语义与 IpcHub.lastFrame 一致：新帧覆盖旧帧，永不排队。
import type { FramePacket } from "@retina/protocol";

export interface ApiFrame {
  /** 逻辑帧号（已展开回绕，单调递增） */
  readonly seq: number;
  /** 板侧帧号（16 bit 回绕） */
  readonly frameIdx: number;
  readonly w: number;
  readonly h: number;
  readonly pixel: "RGB565_BE" | "RGB565_LE";
  readonly tArriveMs: number;
  /**
   * 板端时间轴毫秒（WIRE-V3 §4.3；TS 无效/v2 帧时为 undefined）。
   * F4（2026-10-13）：/api/frame.json 与 WS FRAME_RAW 必须给同一个口径 ——
   * 拉 API 的消费者（另一个 agent/导出脚本）也要能拿到"板端优先"的时间源。
   */
  readonly tBoardMs?: number;
  readonly synthetic: boolean;
  readonly raw: Uint8Array;
  /** 网关看到它的墙钟时刻（Date.now()）—— 给"图有多新"用，与板侧时间基无关 */
  readonly arrivedAtMs: number;
}

export interface ApiEvents {
  readonly frameIdx: number;
  readonly w: number;
  readonly h: number;
  /** 已渲染成 RGBA（可直接编码 PNG） */
  readonly rgba: Uint8ClampedArray;
  readonly count: number;
  /** 这批事件是谁算出来的：板端 v2 自带，还是上位机同构算法 */
  readonly origin: "board" | "host";
  readonly arrivedAtMs: number;
}

interface Waiter {
  readonly afterSeq: number;
  readonly resolve: (f: ApiFrame | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LatestStore {
  private frame: ApiFrame | null = null;
  private events: ApiEvents | null = null;
  private waiters: Waiter[] = [];
  /** 累计交付帧数（不是协议计数器；给 /api/health 看"这个网关一共见过多少帧"） */
  private frameCount = 0;

  setFrame(f: FramePacket, arrivedAtMs: number): void {
    const api: ApiFrame = {
      seq: f.seq,
      frameIdx: f.frameIdx,
      w: f.w,
      h: f.h,
      pixel: f.pixel,
      tArriveMs: f.tArriveMs,
      // F4：与 WS FRAME_RAW 同一口径原样透传（undefined = 本帧无可信板端时间）
      ...(f.tBoardMs === undefined ? {} : { tBoardMs: f.tBoardMs }),
      synthetic: f.synthetic,
      raw: f.raw,
      arrivedAtMs,
    };
    this.frame = api;
    this.frameCount++;
    // 唤醒所有"等下一帧"的长轮询；唤醒后清空（每个等待者只被满足一次）
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) {
      clearTimeout(x.timer);
      x.resolve(api);
    }
  }

  setEvents(e: ApiEvents): void {
    this.events = e;
  }

  getFrame(): ApiFrame | null {
    return this.frame;
  }

  getEvents(): ApiEvents | null {
    return this.events;
  }

  get totalFrames(): number {
    return this.frameCount;
  }

  /**
   * 长轮询：等一帧 seq > afterSeq 的帧，超时返回 null。
   * 为什么不用"每 200 ms 轮询一次 HTTP"：其他 agent 拿画面时最怕"多花一次往返还拿到旧帧"，
   * 长轮询让"新帧一到就返回"，延迟与推流同阶。
   */
  waitFrame(afterSeq: number, timeoutMs: number): Promise<ApiFrame | null> {
    const cur = this.frame;
    if (cur !== null && cur.seq > afterSeq) return Promise.resolve(cur);
    return new Promise<ApiFrame | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.timer !== timer);
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.waiters.push({ afterSeq, resolve, timer });
    });
  }

  clear(): void {
    for (const x of this.waiters) {
      clearTimeout(x.timer);
      x.resolve(null);
    }
    this.waiters = [];
  }
}
