// L0 背景网格/标尺：唯一的"behind"层，负责把画面边界画清楚。
// 为什么标尺要按图像坐标走：观众看到的是 800×480 的画面，尺子必须跟着图像缩放，
// 否则截图里量出来的距离与实际像素不成比例，没法用来做标注。
import { LAYER_Z } from "@retina/protocol";
import type { Layer, RenderEnv } from "./types.ts";

function draw(env: RenderEnv): void {
  const { ctx, cw, ch, view } = env;
  ctx.fillStyle = "#04060a";
  ctx.fillRect(0, 0, cw, ch);

  const px = view.w / env.profile.frame.w;
  const stepX = px * 40;
  const stepY = (view.h / env.profile.frame.h) * 40;
  if (stepX >= 4 && stepY >= 4) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x, view.y, view.w, view.h);
    ctx.clip();
    ctx.strokeStyle = "rgba(91,140,255,.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = view.x; x <= view.x + view.w + 0.5; x += stepX) {
      ctx.moveTo(Math.round(x) + 0.5, view.y);
      ctx.lineTo(Math.round(x) + 0.5, view.y + view.h);
    }
    for (let y = view.y; y <= view.y + view.h + 0.5; y += stepY) {
      ctx.moveTo(view.x, Math.round(y) + 0.5);
      ctx.lineTo(view.x + view.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }
  // 图像边框：画面到哪儿结束必须一眼可见（否则"黑边"会被误当成画面内容）
  ctx.strokeStyle = "rgba(39,54,77,.95)";
  ctx.lineWidth = 1;
  ctx.strokeRect(view.x + 0.5, view.y + 0.5, Math.max(1, view.w - 1), Math.max(1, view.h - 1));
}

export function createBackgroundLayer(): Layer {
  return { key: "BACKGROUND", z: LAYER_Z.BACKGROUND, label: "背景网格", note: "标尺/参考线", blend: "behind", draw };
}
