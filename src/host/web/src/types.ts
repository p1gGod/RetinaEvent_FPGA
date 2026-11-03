// 前端内部类型（与 protocol 的线格式类型区分开：这里只放"界面要用的视图模型"）
import type { Counters } from "@retina/protocol";

/** 数据来源：gateway=真实网关推流 / synth=页内合成源（连不上网关时的离线演示） */
export type SourceKind = "gateway" | "synth";

export interface SourceStatus {
  readonly kind: SourceKind;
  readonly connected: boolean;
  /** 给顶栏 pill 用的一句话状态（含原因，方便排障） */
  readonly detail: string;
}

/** 后处理产出的一个检测框（坐标一律用原始帧像素，画的时候再换算到窗格） */
export interface Detection {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly score: number;
}

/** 侧栏/状态栏显示的所有统计数字。每个字段都必须能追溯到公式（见 03 文档 §0）。 */
export interface ViewStats {
  /** 回传帧率 fps = 窗口内 FRAME_RAW 条数 / 窗口秒数 */
  readonly fps: number;
  /** 相机帧率（反推）= 回传帧率 × profile.frameDecim */
  readonly camFps: number;
  /** 事件率 ev/s = 窗口内事件条数 / 窗口秒数 */
  readonly eventRate: number;
  /** 每帧平均事件数 = 事件条数 / FRAME_RAW 条数（EV_ONLY 下没有帧 ⇒ 恒为 0，界面必须改读 eventsPerBatch） */
  readonly eventsPerFrame: number;
  /** EV_ONLY 批次率（批/s）= 窗口内 EV_ONLY 批次数 / 窗口秒数；配帧模式恒为 0 */
  readonly evBatchRate: number;
  /** 每批平均事件数 = 事件条数 / EV_ONLY 批次数（无批为 0）——EV_ONLY 下的"每帧点数"正确口径 */
  readonly eventsPerBatch: number;
  /** 字节级降低倍数 = 原始字节率 / 事件字节率（两者同一窗口，可追溯） */
  readonly reduction: number;
  readonly onShare: number;
  readonly offShare: number;
  readonly pps: number;
  readonly bps: number;
  readonly packets: number;
  readonly frames: number;
  /** 最后一条消息的到达延迟（网关单调时钟与浏览器时钟不同源，故用本机收包时刻差） */
  readonly latencyMs: number;
  readonly uiDrop: number;
  readonly counters: Counters;
}
