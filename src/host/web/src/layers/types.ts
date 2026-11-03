// 图层契约：每个图层只实现 draw(env)，与 05 文档的 DerivedLayer.draw() 同签名 ⇒ 内置层与插件层可互换。
// 为什么把环境对象打包传进去：图层不许自己去摸 DOM/传输层，它只能画 env 里给它的东西
// （03 文档 §4"展示组件不碰数据源"），插件因此不可能污染原始帧。
import type { Profile } from "@retina/protocol";
import type { EventBitmap } from "../events.ts";
import type { MotionSnapshot } from "../predict/motion.ts";
import type { Detection, ViewStats } from "../types.ts";

export type LayerKey = "BACKGROUND" | "RAW" | "EVENTS" | "HUD" | "POSTPROC" | "INTERACT";

/** 一帧原始数据的前端视图（网关与合成源在这里被抹平差异） */
export interface ViewFrame {
  readonly frameIdx: number;
  readonly w: number;
  readonly h: number;
  readonly raw: Uint8Array;
  /** RGB565 字节序（线格式的 fmt 是数字、Profile 里是字符串，这里统一成 BE/LE） */
  readonly byteOrder: "BE" | "LE";
  readonly tArriveMs: number;
  readonly synthetic: boolean;
  /** 该帧由多少段拼成（状态栏显示 750/750 包用） */
  readonly chunks: number;
}

/** 图像坐标系到画布 CSS 坐标的落位（contain 或整数倍放大后的矩形） */
export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 每原始像素占几个 CSS 像素 */
  readonly scale: number;
  /** true = 由整数倍放大规则得出（此时绝不做插值） */
  readonly integer: boolean;
}

export interface RenderEnv {
  readonly ctx: CanvasRenderingContext2D;
  readonly cw: number;
  readonly ch: number;
  readonly view: ViewRect;
  readonly frame: ViewFrame | null;
  readonly events: EventBitmap;
  readonly stats: ViewStats;
  readonly profile: Profile;
  readonly detections: readonly Detection[];
  readonly pointer: { readonly x: number; readonly y: number; readonly down: boolean } | null;
  readonly frozen: boolean;
  /** EV_ONLY（板端只回传事件）时没有新原始帧：raw 层要把"等待"文案换成"无原始帧" */
  readonly evOnly?: boolean;
  /**
   * 事件级运动预测快照（main.ts 每个渲染 tick 算一次，四个窗格共用）。
   * null = 用户关掉了运动预测：HUD 必须画得和加入这个功能之前逐像素一致。
   */
  readonly prediction?: MotionSnapshot | null;
  /** 当前预测时域（秒），仅用于 HUD 标签；与 prediction 同时给 */
  readonly predictionHorizonS?: number;
}

export interface Layer {
  readonly key: LayerKey;
  readonly z: number;
  readonly label: string;
  readonly note: string;
  readonly blend: string;
  draw(env: RenderEnv): void;
}

export const MONO = "'Cascadia Mono','Consolas','SFMono-Regular',monospace";
