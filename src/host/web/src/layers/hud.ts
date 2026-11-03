// L3 HUD 叠加（panel/grid/text）——与板上 hud_stack 的三个平面同构。
// 为什么数字画在画布上而不是 DOM 覆盖层：HUD 是"图层"，必须能被单独开关/单独导出，
// DOM 覆盖层做不到"只导出这一层"，也没法在窗格聚焦时自动跟着缩放。
import { LAYER_Z } from "@retina/protocol";
import { fmtFixed, fmtScale } from "../format.ts";
import type { PredictedTrack } from "../predict/motion.ts";
import { MONO, type Layer, type RenderEnv } from "./types.ts";

/**
 * L3 HUD 第二行显示的"这批事件是谁算的、θ 多少"。
 *
 * 为什么做成可变状态而不是从 env 里取：θ 是**上位机算法参数**（属于设置，不属于任何一帧），
 * 塞进 RenderEnv 会让每帧渲染都携带一份与画面无关的配置。由 main.ts 每 200 ms 写一次即可。
 * ⚠️ 以前这一行是**写死的** "θ = 0.20 档位 2/3"，切到上位机模拟后它照样显示板端的值 ——
 * 用户照着它调滑动条，越调越不对。
 */
export const hudEventInfo: { text: string } = { text: "θ = —" };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function panel(env: RenderEnv): Rect {
  const { ctx, view, stats, frame } = env;
  const size = Math.max(9, Math.min(13, view.h * 0.03));
  const line = size * 1.55;
  const title = "RETINA-EVENT";
  const ev = fmtScale(stats.eventRate, 1);
  const lines = [
    title,
    hudEventInfo.text,
    "事件 " + ev.v + " " + ev.u + "ev/s   降低 " + fmtFixed(stats.reduction, 0) + "×",
    "帧 " + (frame ? frame.frameIdx : 0) + "   网格 40 px",
  ];
  // 预测开启才追加这一行：关闭时 lines 必须与旧版逐字符相同（像素级回退）。
  if (env.prediction !== undefined && env.prediction !== null && env.predictionHorizonS !== undefined) {
    const n = env.prediction.tracks.filter(confirmedTrack).length;
    const h = env.predictionHorizonS.toFixed(1);
    lines.push(n > 0 ? "预测 " + h + "s · " + n + " 目标 · 卡尔曼 CV" : "预测 " + h + "s · 等待运动 · 卡尔曼 CV");
  }
  ctx.font = size + "px " + MONO;
  let wMax = 0;
  for (const s of lines) wMax = Math.max(wMax, ctx.measureText(s).width);
  const pw = wMax + size * 2.2;
  const ph = line * lines.length + size * 1.1;
  const px = view.x + 10;
  const py = view.y + view.h - ph - 10;
  ctx.save();
  ctx.fillStyle = "rgba(6,10,18,.82)";
  ctx.strokeStyle = "#2b3d5c";
  ctx.lineWidth = 1;
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + pw, py, px + pw, py + ph, r);
  ctx.arcTo(px + pw, py + ph, px, py + ph, r);
  ctx.arcTo(px, py + ph, px, py, r);
  ctx.arcTo(px, py, px + pw, py, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#cfe0f7";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i] ?? "";
    ctx.fillStyle = i === 0 ? "#ff4d63" : "#cfe0f7";
    ctx.fillText(s, px + size * 1.1, py + size * 0.55 + i * line);
  }
  ctx.restore();
  return { x: px, y: py, w: pw, h: ph };
}

/** 只画"连续被看到"的轨迹：单次观测可能只是噪声/刚出现的目标，画出来会闪。 */
function confirmedTrack(t: PredictedTrack): boolean {
  return t.hits >= 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 深色描边文字：HUD 叠在任意底图上都要读得清，又不给文字加厚重背景块。 */
function txt(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  size: number,
  align: CanvasTextAlign,
): void {
  ctx.font = size + "px " + MONO;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(4,8,16,.88)";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/**
 * 事件级运动预测叠加（只画在 HUD 图层 ⇒ 只有 L3 的白名单里有它）。
 *
 * 坐标系：所有输入都是事件栅格坐标（profile.evGrid，400×240），先归一化到 L3 的 view 矩形。
 * **绝不能用 raw 像素坐标**：EV_ONLY/串口下根本没有 raw，预测照样要能画。
 */
function drawPrediction(env: RenderEnv, panelRect: Rect): void {
  const { ctx, view, profile } = env;
  const snap = env.prediction;
  if (snap === undefined || snap === null) return;
  const tracks = snap.tracks.filter(confirmedTrack).slice().sort((a, b) => b.speed - a.speed || b.hits - a.hits).slice(0, 3);
  if (tracks.length === 0) return;
  const evW = Math.max(1, profile.evGrid.w);
  const evH = Math.max(1, profile.evGrid.h);
  const sx = view.w / evW;
  const sy = view.h / evH;
  const mapX = (x: number): number => view.x + clamp(x / evW, 0, 1) * view.w;
  const mapY = (y: number): number => view.y + clamp(y / evH, 0, 1) * view.h;
  const scale = Math.min(sx, sy);
  const size = Math.max(8, Math.min(12, view.h * 0.022));
  const h = env.predictionHorizonS ?? 1;
  const tag = "T+" + h.toFixed(1) + "s";

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  // 预测叠加按任务要求画在左下 panel 之后；用 even-odd 挖掉 panel 区域，
  // 避免运动轨迹/标签盖住读数（panel 是不透明底，被盖住就真的看不清了）。
  if (panelRect.w > 0 && panelRect.h > 0) ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
  ctx.clip("evenodd");
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const t of tracks) {
    const cx = mapX(t.x);
    const cy = mapY(t.y);
    const px = mapX(t.px);
    const py = mapY(t.py);
    const moving = t.speed >= 5;

    // 1) 历史轨迹：淡青小点 + 细线（只用来让人看出"它是从哪走过来的"）
    if (t.trail.length >= 2) {
      ctx.strokeStyle = "rgba(103,232,249,.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < t.trail.length; i++) {
        const p = t.trail[i];
        if (p === undefined) continue;
        const x = mapX(p.x);
        const y = mapY(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(103,232,249,.42)";
      for (const p of t.trail) {
        ctx.beginPath();
        ctx.arc(mapX(p.x), mapY(p.y), 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (moving) {
      // 2) 不确定度：低透明度圆，别盖住底图；半径由位置标准差映射，并夹在可读区间
      const r = clamp(t.sigma * scale, 8, Math.max(14, Math.min(96, view.w * 0.18)));
      ctx.fillStyle = "rgba(56,189,248,.055)";
      ctx.strokeStyle = "rgba(56,189,248,.16)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 3) 预测路径：虚线 + 末端箭头（太短的路径不画，免得箭头糊成一团）
      const dx = px - cx;
      const dy = py - cy;
      const len = Math.hypot(dx, dy);
      if (len >= 6) {
        ctx.strokeStyle = "rgba(103,232,249,.72)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.setLineDash([]);
        const ang = Math.atan2(dy, dx);
        const ah = Math.max(5, size * 0.55);
        ctx.fillStyle = "rgba(103,232,249,.9)";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - Math.cos(ang - 0.42) * ah, py - Math.sin(ang - 0.42) * ah);
        ctx.lineTo(px - Math.cos(ang + 0.42) * ah, py - Math.sin(ang + 0.42) * ah);
        ctx.closePath();
        ctx.fill();
      }

      // 4) 预测框：青色虚线，用平滑后的包围盒尺寸
      const bw = Math.max(6, t.w * sx);
      const bh = Math.max(6, t.h * sy);
      const x0 = clamp(px - bw / 2, view.x, view.x + view.w);
      const y0 = clamp(py - bh / 2, view.y, view.y + view.h);
      const x1 = clamp(px + bw / 2, view.x, view.x + view.w);
      const y1 = clamp(py + bh / 2, view.y, view.y + view.h);
      ctx.strokeStyle = "rgba(103,232,249,.9)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      ctx.setLineDash([]);
      txt(ctx, tag, clamp(px, view.x + 20, view.x + view.w - 20), clamp(y0 - size * 0.8, view.y + size, view.y + view.h), "rgba(165,243,252,.95)", size, "center");
    } else {
      // 静止目标：只画当前的琥珀小框，不画箭头/远方预测框 —— 否则演示会变成"万物皆预测"
      const bw = Math.max(6, t.w * sx);
      const bh = Math.max(6, t.h * sy);
      ctx.strokeStyle = "rgba(255,191,95,.65)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(clamp(cx - bw / 2, view.x, view.x + view.w), clamp(cy - bh / 2, view.y, view.y + view.h), Math.max(1, Math.min(bw, view.w)), Math.max(1, Math.min(bh, view.h)));
    }

    // 5) 当前质心：琥珀圆环 + 十字 + 稳定 ID；速度标签贴在旁边
    ctx.strokeStyle = "#ffbf5f";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy);
    ctx.lineTo(cx + 7, cy);
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx, cy + 7);
    ctx.stroke();
    const labelX = clamp(cx + 8, view.x + 2, view.x + view.w - 2);
    const labelY = clamp(cy - 10, view.y + size, view.y + view.h - size);
    txt(ctx, "T" + t.id, labelX, labelY, "#ffd39a", size, "left");
    if (moving) {
      txt(ctx, "v " + Math.round(t.speed) + " px/s", labelX, clamp(labelY + size * 1.25, view.y + size, view.y + view.h - size), "rgba(255,211,154,.85)", Math.max(7, size - 0.5), "left");
    }
  }
  ctx.restore();
}

function draw(env: RenderEnv): void {
  const { ctx, view, profile } = env;
  // HUD 网格：40 px 一条，标出"板端 HUD 网格"的位置
  const stepX = (view.w / profile.frame.w) * 40;
  const stepY = (view.h / profile.frame.h) * 40;
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  ctx.strokeStyle = "rgba(91,140,255,.16)";
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
  // 扫描带：让人一眼看出"这是活的画面"（但它不属于统计口径，任何数字都不依赖它）
  const t = (performance.now() / 3200) % 1;
  const bandH = Math.max(6, view.h * 0.38);
  const by = view.y + t * (view.h + bandH) - bandH;
  const g = ctx.createLinearGradient(0, by, 0, by + bandH);
  g.addColorStop(0, "rgba(91,140,255,0)");
  g.addColorStop(0.5, "rgba(91,140,255,.10)");
  g.addColorStop(1, "rgba(91,140,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(view.x, by, view.w, bandH);
  ctx.restore();
  // 任务口径：网格/扫描带/panel 之后画预测叠加。panel 区域在 drawPrediction 里被 even-odd 挖掉。
  const panelRect = panel(env);
  drawPrediction(env, panelRect);
}

export function createHudLayer(): Layer {
  return { key: "HUD", z: LAYER_Z.HUD, label: "HUD 叠加", note: "panel/grid/text", blend: "source-over", draw };
}
