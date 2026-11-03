// L4 后处理结果：把 detection[] 画成框 + 标签（设计稿的 "ball 0.93" 那一层）。
// 检测框的坐标是原始帧像素，这里统一按 view 换算成百分比式落位 —— 设计稿踩坑 #3 就是这么来的：
// 位置必须从原始像素算，不能凭感觉写百分比。
import { LAYER_Z } from "@retina/protocol";
import { MONO, type Layer, type RenderEnv } from "./types.ts";

function draw(env: RenderEnv): void {
  const { ctx, view, detections, profile } = env;
  if (detections.length === 0) return;
  const sx = view.w / profile.frame.w;
  const sy = view.h / profile.frame.h;
  const size = Math.max(9, Math.min(12, view.h * 0.026));
  ctx.save();
  ctx.font = size + "px " + MONO;
  ctx.textBaseline = "alphabetic";
  for (const d of detections) {
    const x = view.x + d.x * sx;
    const y = view.y + d.y * sy;
    const w = d.w * sx;
    const h = d.h * sy;
    // 高置信用绿（与设计稿 .ov.box.g 一致），其余用黄 —— 只做视觉分档，不改变数字
    const color = d.score >= 0.8 ? "#34d399" : "#fbbf24";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    const label = d.label + " " + d.score.toFixed(2);
    const tw = ctx.measureText(label).width;
    const lh = size * 1.5;
    const ly = y - lh < view.y ? y : y - lh;
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, ly, tw + 8, lh);
    ctx.fillStyle = "#1b1200";
    ctx.fillText(label, x + 3, ly + lh * 0.72);
  }
  ctx.restore();
}

export function createPostprocLayer(): Layer {
  return {
    key: "POSTPROC", z: LAYER_Z.POSTPROC, label: "后处理结果", note: "检测框/热图", blend: "normal", draw,
  };
}
