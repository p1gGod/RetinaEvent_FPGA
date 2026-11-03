// L5 交互标注（游标/测量/选区）：唯一"默认关"的层，因为它是 PC 独有、且与画面内容无关。
// 状态与画面必须一致（设计稿踩坑 #4：图层栈显示 L5=关，画布上却画了十字线）——
// 所以这里的 draw 只在图层 enabled 时才被调用，自己不再做第二套开关。
import { LAYER_Z } from "@retina/protocol";
import { MONO, type Layer, type RenderEnv } from "./types.ts";

function draw(env: RenderEnv): void {
  const p = env.pointer;
  if (!p) return;
  const { ctx, view, profile } = env;
  const sx = view.w / profile.frame.w;
  const sy = view.h / profile.frame.h;
  // 指针画布坐标 → 原始帧像素坐标（面板/导出里显示的必须是原始像素）
  const ix = Math.round((p.x - view.x) / sx);
  const iy = Math.round((p.y - view.y) / sy);
  if (ix < 0 || iy < 0 || ix >= profile.frame.w || iy >= profile.frame.h) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,77,99,.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(view.x, p.y + 0.5);
  ctx.lineTo(view.x + view.w, p.y + 0.5);
  ctx.moveTo(p.x + 0.5, view.y);
  ctx.lineTo(p.x + 0.5, view.y + view.h);
  ctx.stroke();
  ctx.fillStyle = "rgba(8,12,20,.85)";
  ctx.font = "10px " + MONO;
  const txt = "x=" + ix + " y=" + iy;
  const tw = ctx.measureText(txt).width;
  ctx.fillRect(p.x + 8, p.y + 8, tw + 8, 16);
  ctx.fillStyle = "#e7eefa";
  ctx.fillText(txt, p.x + 12, p.y + 20);
  ctx.restore();
}

export function createInteractLayer(): Layer {
  return {
    key: "INTERACT", z: LAYER_Z.INTERACT, label: "交互标注", note: "游标/测量/选区", blend: "overlay", draw,
  };
}
