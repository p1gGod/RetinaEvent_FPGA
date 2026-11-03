// 导出格式登记表：底栏那 5 个按钮、结果提示、自检钩子三处必须**说同一件事**。
//
// 为什么单独一张表：2026-10-06 的现状是这 5 个按钮写在 index.html 里当装饰 span，
// 表头文字（"PNG 序列 .zip"）与任何代码都没有关系 —— 于是"点了没反应"这件事
// 从代码上根本查不出来（没有任何处理函数，也没有任何一个地方声明过它们该干什么）。
// 现在按钮的 id、文件名后缀、真实能力都在这里定义，UI 只是它的投影。
import { probeVideoEncoding, type VideoCapability } from "./mp4.ts";
import { allFramesHaveRaw } from "../recordEventOnly.ts";
import type { RecordedFrame } from "./framebin.ts";

export type ExporterId = "pngzip" | "mp4" | "rawbin" | "csv" | "detsjson";

export interface ExporterSpec {
  readonly id: ExporterId;
  /** 按钮上的字（与 index.html 的静态文案一致，改这里要一起改） */
  readonly label: string;
  /** 后缀（不要带点） */
  readonly ext: string;
  /** 文件名前缀 */
  readonly prefix: string;
  readonly mime: string;
  /** 悬停说明：写清"导出的是什么、依赖什么" */
  readonly blurb: string;
  /**
   * 是否依赖浏览器的视频编码器。
   * 这类格式**必须先探测再决定能不能点** —— 否则用户点下去只会得到一句"失败"，
   * 而正确做法是事先把按钮标成不可用并把原因写在 tooltip 里。
   */
  readonly needsEncoder: boolean;
}

export const EXPORTERS: readonly ExporterSpec[] = [
  {
    id: "pngzip", label: "PNG 序列", ext: "zip", prefix: "retina-pngseq", mime: "application/zip",
    blurb: "把录制缓冲里的每一帧渲染成 PNG 打成一个 zip（含 manifest.json）。不依赖任何编码器，最稳。",
    needsEncoder: false,
  },
  {
    id: "mp4", label: "MP4 · H.264", ext: "mp4", prefix: "retina-video", mime: "video/mp4",
    blurb: "把录制缓冲编成视频（默认 MP4/H.264，无编码器时降级 WebM）。导出期间别切走标签页，否则会被节流。",
    needsEncoder: true,
  },
  {
    id: "rawbin", label: "原始帧", ext: "bin", prefix: "retina-raw", mime: "application/octet-stream",
    blurb: "逐帧原始 RGB565 字节 + 自描述清单。这是唯一能跟 RTL/旧脚本**逐字节对拍**的格式。",
    needsEncoder: false,
  },
  {
    id: "csv", label: "事件流", ext: "csv", prefix: "retina-events", mime: "text/csv;charset=utf-8",
    blurb: "每条事件一行（帧号/时刻/坐标/极性），Excel 与 pandas 都能直接读。",
    needsEncoder: false,
  },
  {
    id: "detsjson", label: "检测结果", ext: "json", prefix: "retina-detections", mime: "application/json",
    blurb: "逐帧的检测框（坐标是原始帧像素），不含像素 —— 像素在「原始帧 .bin」里。",
    needsEncoder: false,
  },
];

export function exporterById(id: ExporterId): ExporterSpec {
  const e = EXPORTERS.find((x) => x.id === id);
  if (e === undefined) throw new Error("未登记的导出格式：" + id);
  return e;
}

export interface ExporterAvailability {
  readonly spec: ExporterSpec;
  readonly enabled: boolean;
  /** 不可用的原因（enabled=false 时必须有，要给用户看） */
  readonly reason: string;
  readonly video: VideoCapability | null;
}

/**
 * 事件-only 录制的不可用说明。串口 UART-LINK（EV_NO_RAW）与板端 EVENT 档都没有 FRAME_RAW：
 * 事件/检测框完整，但没有像素可渲染（PNG）、可编码（MP4）、可逐字节对拍（.bin）。
 */
export const NO_RAW_EXPORT_REASON =
  "串口事件-only 录制不含原始像素（无 FRAME_RAW），PNG/MP4/原始帧不可导出；请用事件流 CSV 或检测结果 JSON";

/**
 * 逐个判定可用性。优先级：
 *   1. `frames === 0`：缓冲区空，全部不可用（"先按 R 录一段"）；
 *   2. `hasRaw === false`：事件-only 录制，只开事件流 CSV / 检测结果 JSON，
 *      其余置灰并给出 NO_RAW_EXPORT_REASON；
 *   3. 其余按编码器能力判定。
 */
export function exporterAvailability(frames: number, hasRaw = true): readonly ExporterAvailability[] {
  const video = probeVideoEncoding();
  return EXPORTERS.map((spec) => {
    if (frames === 0) {
      return { spec, enabled: false, reason: "录制缓冲是空的：先按 R（或点「录制」）录一段", video: spec.needsEncoder ? video : null };
    }
    if (!hasRaw) {
      const metaOnly = spec.id === "csv" || spec.id === "detsjson";
      return { spec, enabled: metaOnly, reason: metaOnly ? "" : NO_RAW_EXPORT_REASON, video: spec.needsEncoder ? video : null };
    }
    if (spec.needsEncoder && !video.ok) {
      return { spec, enabled: false, reason: video.detail, video };
    }
    return { spec, enabled: true, reason: "", video: spec.needsEncoder ? video : null };
  });
}

/** 时间轴选区：帧下标闭区间；null = 没有选区（导出整段缓冲） */
export interface ExportSelection {
  readonly from: number;
  readonly to: number;
}

/**
 * 把时间轴选区换算成**当前缓冲里真实存在**的帧。
 *
 * 与 UI timeline 的约束一致：from/to 必须是整数且 0 <= from <= to < frames.length。
 * 任何越界、空区间、反向区间、NaN 都返回空数组（而不是钳到边界）：
 * 选区在缓冲被清空/淘汰后可能短暂失效，这时不能拿"钳出来的几帧"冒充用户选中的那段；
 * 空数组会让 exporterAvailability(0, ...) 走"录制缓冲是空的"原因，按钮保持置灰。
 * 无选区（null）才返回整段缓冲。
 */
export function framesForSelection(
  frames: readonly RecordedFrame[],
  sel: ExportSelection | null,
): readonly RecordedFrame[] {
  if (sel === null) return frames;
  if (frames.length === 0) return [];
  if (!Number.isInteger(sel.from) || !Number.isInteger(sel.to)) return [];
  if (sel.from < 0 || sel.to < sel.from || sel.to >= frames.length) return [];
  return frames.slice(sel.from, sel.to + 1);
}

export interface SelectionExportAvailability {
  /** 实际参与导出/可用性判定的帧：有选区=选区帧，无选区=整段缓冲 */
  readonly frames: readonly RecordedFrame[];
  readonly hasSelection: boolean;
  readonly availability: readonly ExporterAvailability[];
}

/**
 * 选区感知的导出可用性（BLOCK-REC-1）。
 *
 * 无选区保留 frontline 的保守语义：整段 every，混录时 PNG/MP4/.bin 整体置灰；
 * 有选区时只按选区帧判定，于是"混录里只选中 raw 帧"可以导出像素类格式。
 * 选区失效（空/越界）得到 0 帧，exporterAvailability 先报"缓冲是空的"，
 * 不会被放宽成"有帧可用"。
 */
export function exportAvailabilityForSelection(
  frames: readonly RecordedFrame[],
  sel: ExportSelection | null,
): SelectionExportAvailability {
  const scoped = framesForSelection(frames, sel);
  return {
    frames: scoped,
    hasSelection: sel !== null,
    availability: exporterAvailability(scoped.length, allFramesHaveRaw(scoped)),
  };
}

export interface ClipExportState {
  readonly enabled: boolean;
  readonly frames: readonly RecordedFrame[];
  /** enabled=false 时给用户看的原因 */
  readonly reason: string;
}

/**
 * 「导出选中片段（MP4）」的可用性，和顶部 MP4 按钮共用同一个选区口径。
 * 选区里有任何事件-only 帧就禁用；空/越界选区同样禁用。
 * 编码器能力不在本函数内判定（顶部 MP4 按钮另有 exporterAvailability 的 video 分支），
 * 片段按钮保持既有行为：先让用户选，点下去时 runExport 会给出编码器不可用的具体原因。
 */
export function clipExportState(
  frames: readonly RecordedFrame[],
  sel: ExportSelection | null,
): ClipExportState {
  if (sel === null) {
    return { enabled: false, frames: [], reason: "先在时间轴上拖出选区（底栏左侧轨道），再点这里导出 MP4 片段" };
  }
  const scoped = framesForSelection(frames, sel);
  if (scoped.length === 0) {
    return {
      enabled: false,
      frames: scoped,
      reason: "当前选区里没有可导出的帧（缓冲可能已清空或选区已越界），请重新拖选",
    };
  }
  if (!allFramesHaveRaw(scoped)) {
    return {
      enabled: false,
      frames: scoped,
      reason: NO_RAW_EXPORT_REASON,
    };
  }
  return { enabled: true, frames: scoped, reason: "" };
}
