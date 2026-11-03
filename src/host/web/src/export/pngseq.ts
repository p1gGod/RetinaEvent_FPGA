// PNG 序列导出：把录下来的每一帧渲染成 PNG，打成一个 zip。
//
// 为什么是 zip 而不是"逐帧下载 100 个文件"：浏览器每帧都要弹一次下载确认/落盘，
// 100 帧就 100 次（而且 Chrome 会拦住"短时间内多次下载"）。zip 一次给完。
//
// 为什么用 STORE（不压缩）打包：PNG 已经是 deflate 过的，再压一遍 CPU 白烧、体积不降。
// 见 export/zip.ts。
import type { RecordedFrame } from "../recorder.ts";
import { buildZip, type ZipEntry } from "./zip.ts";
import { canvasToPngBytes } from "./render.ts";

export interface PngSequenceOptions {
  readonly frames: readonly RecordedFrame[];
  /** 渲染第 i 帧到画布（调用方决定目标尺寸与图层构成） */
  readonly renderOne: (index: number) => HTMLCanvasElement;
  /** 逐帧进度；返回 false 表示取消 */
  readonly onProgress?: (done: number, total: number) => boolean;
  /** 清单内容（写进 manifest.json，便于别的工具知道这批图是什么参数下录的） */
  readonly manifest: Record<string, unknown>;
}

export interface PngSequenceResult {
  readonly zip: Uint8Array;
  readonly entries: number;
  readonly pngBytes: number;
}

const README = [
  "RetinaEvent 上位机 · PNG 序列导出",
  "",
  "frames/frame_XXXXXX.png  按录制顺序编号（XXXXXX = 录制缓冲里的下标，不是帧号）",
  "manifest.json            导出时录制的参数、帧号与到达时刻，逐帧对齐用",
  "",
  "为什么图里没有游标/测量标注：那是看的人留下的交互痕迹，不属于数据。",
  "为什么尺寸是固定的：导出走离屏渲染（L1/L3/L4 = 800x480，L2 = 400x240），",
  "与窗口大小无关 —— 否则同一次录制在不同窗口尺寸下导出的图对不齐。",
].join("\n");

/** 零填充的下标，保证字典序 = 时间序（用 padStart 而不是 toLocaleString） */
function frameName(i: number): string {
  return "frame_" + String(i).padStart(6, "0") + ".png";
}

export async function buildPngSequenceZip(opt: PngSequenceOptions): Promise<PngSequenceResult> {
  const total = opt.frames.length;
  if (total === 0) throw new Error("录制缓冲是空的（先按 R 录一段）");
  const entries: ZipEntry[] = [];
  let pngBytes = 0;
  for (let i = 0; i < total; i++) {
    const canvas = opt.renderOne(i);
    const png = await canvasToPngBytes(canvas);
    pngBytes += png.length;
    entries.push({ name: "frames/" + frameName(i), data: png });
    if (opt.onProgress !== undefined && opt.onProgress(i + 1, total) === false) {
      throw new Error("导出已取消");
    }
    // 让出一帧给界面：100 帧 × (渲染 + PNG 编码) 会把主线程占满，
    // 不主动让出的话进度条根本不会动（用户看到的就是"点了没反应"）
    await new Promise((r) => window.setTimeout(r, 0));
  }
  entries.push({
    name: "manifest.json",
    data: new TextEncoder().encode(JSON.stringify(opt.manifest, null, 1)),
  });
  entries.push({ name: "README.txt", data: new TextEncoder().encode(README) });
  return { zip: buildZip(entries), entries: entries.length, pngBytes };
}
