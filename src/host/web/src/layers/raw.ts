// L1 原始帧：RGB565 → RGBA（复用 protocol 的 decodeRgb565），再 drawImage 到画布。
// 为什么缓存离屏画布：解码一帧 800×480 要 ~4 ms，四个窗格共用同一份解码结果，
// 每帧只解码一次；只在"换帧"时重解（03 文档 §7 实现要点 1 的缓存思路）。
import { decodeRgb565, LAYER_Z } from "@retina/protocol";
import { MONO, type Layer, type RenderEnv, type ViewFrame } from "./types.ts";

export class RawLayer implements Layer {
  readonly key = "RAW" as const;
  readonly z = LAYER_Z.RAW;
  readonly label = "原始帧";
  readonly note = "RGB565 → RGB888";
  readonly blend = "normal";

  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private last: ViewFrame | null = null;

  /** 解码并缓存（同一 ViewFrame 对象只解一次） */
  private prepare(frame: ViewFrame): HTMLCanvasElement | null {
    if (this.off && this.img && this.offCtx && this.last === frame) return this.off;
    if (!this.off || !this.img || this.img.width !== frame.w || this.img.height !== frame.h) {
      const off = document.createElement("canvas");
      off.width = frame.w;
      off.height = frame.h;
      const c = off.getContext("2d", { alpha: false });
      if (!c) return null;
      this.off = off;
      this.offCtx = c;
      this.img = c.createImageData(frame.w, frame.h);
    }
    const img = this.img;
    const ctx = this.offCtx;
    if (!img || !ctx) return null;
    decodeRgb565(frame.raw, img.data, frame.byteOrder);
    ctx.putImageData(img, 0, 0);
    this.last = frame;
    return this.off;
  }

  draw(env: RenderEnv): void {
    const { ctx, view, frame } = env;
    if (!frame) {
      ctx.fillStyle = "#6b7d96";
      ctx.font = "11px " + MONO;
      ctx.textAlign = "center";
      // EV_ONLY（板端只回传事件）下一张原始帧都不会来：不能写"等待"，要写"无"
      ctx.fillText(env.evOnly === true ? "无原始帧（EV_ONLY：板端只回传事件）" : "等待原始帧…", view.x + view.w / 2, view.y + view.h / 2);
      ctx.textAlign = "left";
      return;
    }
    const off = this.prepare(frame);
    if (!off) return;
    ctx.imageSmoothingEnabled = !view.integer;
    ctx.drawImage(off, view.x, view.y, view.w, view.h);
  }
}
