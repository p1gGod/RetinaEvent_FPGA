// L2 事件位图：累积位图 → putImageData（零拷贝包装 EventBitmap.rgba）→ 整数/最近邻 drawImage。
// 为什么用 screen 混合 + 85% 不透明度：与设计稿及板上 hud_event_layer 的观感一致：
// 底图亮的地方事件仍然显红/蓝，而不是把底图整块盖住。
import { LAYER_Z } from "@retina/protocol";
import { EventBitmap } from "../events.ts";
import { MONO, type Layer, type RenderEnv } from "./types.ts";

export class EventsLayer implements Layer {
  readonly key = "EVENTS" as const;
  readonly z = LAYER_Z.EVENTS;
  readonly label = "事件位图";
  readonly note = "ON/OFF + 余晖";
  readonly blend = "screen 85%";

  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private bitmap: EventBitmap | null = null;
  private rev = -1;

  draw(env: RenderEnv): void {
    const bmp = env.events;
    if (!this.off || this.bitmap !== bmp) {
      const off = document.createElement("canvas");
      off.width = bmp.w;
      off.height = bmp.h;
      const c = off.getContext("2d");
      if (!c) return;
      this.off = off;
      this.offCtx = c;
      // 用 createImageData 建缓冲，再按其 revision 把位图内容拷进来：
      // 只有位图真的变了才拷（26 次/秒 × 384 KB 是可接受的代价，换来零类型体操）
      this.img = c.createImageData(bmp.w, bmp.h);
      this.bitmap = bmp;
      this.rev = -1;
    }
    const ctx = this.offCtx;
    const img = this.img;
    if (!ctx || !img) return;
    if (this.rev !== bmp.revision) {
      img.data.set(bmp.rgba);
      ctx.putImageData(img, 0, 0);
      this.rev = bmp.revision;
    }
    const { view } = env;
    env.ctx.save();
    env.ctx.imageSmoothingEnabled = false; // 放大必须看见"块"，否则会被误读成模糊灰度图
    env.ctx.globalAlpha = 0.85;
    env.ctx.globalCompositeOperation = "screen";
    env.ctx.drawImage(this.off, view.x, view.y, view.w, view.h);
    env.ctx.restore();
  }
}
