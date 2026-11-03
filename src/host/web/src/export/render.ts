// 把**录制下来的历史帧**渲染成图片（PNG 序列 / MP4 都要它）。
//
// 为什么不能直接 `pane.canvas.toBlob()`（现有的「导出当前帧」就是这么干的）：
//   ① 窗格画布是**屏幕分辨率**（CSS 像素 × dpr，随窗口大小变）—— 同一个内容在不同窗口
//      尺寸下导出的大小不同，做报告/对比时对不齐。
//   ② 它只能导**当前**那一帧，录了 100 帧也拿不到第 37 帧。
// 所以这里另起一条离屏渲染路径：尺寸由内容决定（原始帧 = 800×480，事件图 = 400×240），
// 与窗口无关、可复现。图层代码一行都不用改 —— 复用同一批 Layer 实现，
// 只是换一个 RenderEnv（这正是 03 文档 §4「展示组件只认 env」的回报）。
//
// ⚠️ 用**新建的 Layer 实例**，不要复用界面上那几个：RawLayer/EventsLayer 内部按
// "同一个 ViewFrame 对象只解码一次"缓存（`this.last === frame`），导出时喂的是历史帧，
// 跟界面上的当前帧来回抢缓存会退化成每帧重解码，而且缓存状态会被搅乱。
import type { Profile } from "@retina/protocol";
import { EventBitmap } from "../events.ts";
import { createBackgroundLayer } from "../layers/background.ts";
import { EventsLayer } from "../layers/events.ts";
import { createHudLayer, hudEventInfo } from "../layers/hud.ts";
import { createPostprocLayer } from "../layers/postproc.ts";
import { RawLayer } from "../layers/raw.ts";
import type { LayerKey, RenderEnv, ViewFrame } from "../layers/types.ts";
import type { Detection, ViewStats } from "../types.ts";
import type { RecordedFrame } from "../recorder.ts";

/** 导出目标 = 窗格种类（与 ui/panes.ts 的 PaneKind 同值，刻意不 import 那边以免耦合到 DOM） */
export type ExportTarget = "raw" | "events" | "overlay" | "post";

export const EXPORT_TARGETS: readonly { readonly id: ExportTarget; readonly label: string; readonly note: string }[] = [
  { id: "raw", label: "L1 原始画面", note: "800×480 原始帧，只含背景网格与原始像素" },
  { id: "events", label: "L2 事件画面", note: "400×240 事件位图（ON 红 / OFF 蓝 + 余晖）" },
  { id: "overlay", label: "L3 屏上叠加", note: "800×480 与板上 LCD 同构：原始 + 事件 + HUD" },
  { id: "post", label: "L4 后处理输出", note: "800×480 原始帧 + 检测框" },
];

/** 每个目标画哪些层。**刻意排除 INTERACT**：游标/测量是"看的人"留下的标注，
 *  录下来再导出时那个指针位置毫无意义，留在图里只会让报告多一个说不清的光标。 */
const TARGET_LAYERS: Readonly<Record<ExportTarget, readonly LayerKey[]>> = {
  raw: ["BACKGROUND", "RAW"],
  events: ["BACKGROUND", "EVENTS"],
  overlay: ["BACKGROUND", "RAW", "EVENTS", "HUD"],
  post: ["BACKGROUND", "RAW", "POSTPROC"],
};

export interface ExportRenderInput {
  readonly target: ExportTarget;
  readonly frame: RecordedFrame;
  /** 历史帧对应的事件位图（调用方按帧序回放出来，见 replayBitmap） */
  readonly events: EventBitmap;
  readonly profile: Profile;
  /** 该帧当时的统计快照（HUD 面板上的数字要用"当时"的，不是"现在"的） */
  readonly stats: ViewStats;
  /** HUD 第二行的文字（θ / 事件来源）；不传就用当前界面上的那份 */
  readonly hudText?: string;
}

/** 按目标决定的输出尺寸：事件图是栅格尺寸，其余是原始帧尺寸 */
export function nativeSize(target: ExportTarget, frame: RecordedFrame, events: EventBitmap): { w: number; h: number } {
  return target === "events" ? { w: events.w, h: events.h } : { w: frame.w, h: frame.h };
}

/** RecordedFrame → 图层要的 ViewFrame */
export function toViewFrame(f: RecordedFrame, profile: Profile): ViewFrame {
  return {
    frameIdx: f.frameIdx,
    w: f.w,
    h: f.h,
    raw: f.raw,
    byteOrder: f.pixel === "RGB565_LE" ? "LE" : "BE",
    tArriveMs: f.tMs,
    synthetic: false,
    chunks: profile.chunksPerFrame,
  };
}

/**
 * 把一帧渲染到离屏画布。
 * 调用方负责传入"那一刻"的 EventBitmap 与 stats，本函数不碰任何全局状态 —— 除了
 * `hudEventInfo`（HUD 图层的第二行文字是模块级可变状态，见该文件的注释）。
 * 这里临时改写它并在 finally 里还原：导出是低频操作，为此把 HUD 层改成参数化不值得。
 */
export function renderRecordedFrame(input: ExportRenderInput): HTMLCanvasElement {
  const { target, frame, events, profile, stats } = input;
  const { w, h } = nativeSize(target, frame, events);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("离屏 2D 上下文创建失败（导出无法继续）");

  // 视口 = 整张画布，整数倍（1:1）。导出不该含任何缩放插值。
  const view = { x: 0, y: 0, w, h, scale: 1, integer: true };
  const env: RenderEnv = {
    ctx,
    cw: w,
    ch: h,
    view,
    frame: toViewFrame(frame, profile),
    events,
    stats,
    profile,
    detections: frame.detections as readonly Detection[],
    pointer: null,          // 导出不含游标（也因此 INTERACT 层不在白名单里）
    frozen: false,
  };

  // 每层新建实例：不与界面上的实例抢内部缓存，见文件头注释
  const layers = [createBackgroundLayer(), new RawLayer(), new EventsLayer(), createHudLayer(), createPostprocLayer()];
  const allow = new Set<LayerKey>(TARGET_LAYERS[target]);
  const savedHud = hudEventInfo.text;
  if (input.hudText !== undefined) hudEventInfo.text = input.hudText;
  try {
    for (const l of layers.slice().sort((a, b) => a.z - b.z)) {
      if (!allow.has(l.key)) continue;
      l.draw(env);
    }
  } finally {
    hudEventInfo.text = savedHud;
  }
  return canvas;
}

/**
 * 按帧序**回放**事件位图到第 n 帧。
 *
 * 为什么不缓存每帧的位图快照：96 MB 的帧环已经占了大头，再存一份每帧 384 KB 的 RGBA
 * 会让内存翻倍还多。回放是 O(n)，导出 100 帧总共 O(n²/2) 次 step+apply —— 实测几百帧
 * 的量级下（每次 step 只遍历活跃单元）完全够快，而内存只多一份位图。
 *
 * ⚠️ 必须**从头**回放，不能从上一次导出的位置续：衰减是累积的，续着算出来的余晖
 * 与界面上当时看到的不一致（"导出的图和录的时候看到的不一样"就是这么来的）。
 */
export function replayBitmap(
  frames: readonly RecordedFrame[],
  upto: number,
  profile: Profile,
  decay = 0.55,
): EventBitmap {
  // 尺寸取自 profile 的事件栅格（400×240），不要自己写死：profile 一换就会错位
  const bmp = new EventBitmap(profile.evGrid.w, profile.evGrid.h, decay);
  for (let i = 0; i <= upto && i < frames.length; i++) {
    const f = frames[i];
    if (f === undefined) break;
    bmp.step();
    bmp.apply(f.events);
  }
  return bmp;
}

/** 画布 → PNG 字节（走浏览器自己的编码器，不自己写 PNG：这里没有"零依赖"的约束） */
export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("canvas.toBlob 返回空（画布尺寸可能是 0）"));
        return;
      }
      blob
        .arrayBuffer()
        .then((ab) => resolve(new Uint8Array(ab)))
        .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    }, "image/png");
  });
}
