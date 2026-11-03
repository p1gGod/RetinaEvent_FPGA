// L4 后处理的占位实现：亮度阈值 + 粗网格连通域检测"亮目标"。
// 为什么用真检测而不是写死几个框：写死的框在换数据源（网关真实帧）时立刻变成假数据，
// 而阈值检测对合成帧和真实帧都成立，且能解释"框为什么在那儿"（大于 150 luma 的连通亮区）。
// 真插件（ONNX/帧差）落地后，本文件整体替换为 IPostProcessor 实现，L4 图层签名不变。
import type { Detection } from "./types.ts";
import { lumaAtRgba } from "./pixels.ts";

/** 亮度门限（luma 0..255）。取 150：合成画面里只有亮球(≈236)与手臂(≈154)越线，静态区不越线 */
const LUMA_THRESHOLD = 150;
/** 连通域在粗网格上做：64×38 的格子足够框住目标，成本与像素数同阶但常数小一个数量级 */
const GRID_W = 64;
const MIN_BRIGHT_PX = 120;
const MAX_BOXES = 3;

/**
 * 从 RGBA 原始帧里检出亮度连通域。
 * 三类命名规则是确定性的（同样的盒子永远同样的标签），演示时不会"这次叫 ball 下次叫 box"。
 */
export function detectBright(rgba: Uint8ClampedArray, w: number, h: number): Detection[] {
  if (w <= 0 || h <= 0) return [];
  const gw = Math.min(GRID_W, w);
  const gh = Math.max(1, Math.round((gw * h) / w));
  const cw = w / gw;
  const ch = h / gh;
  const cnt = new Int32Array(gw * gh);
  for (let y = 0, i = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / ch));
    for (let x = 0; x < w; x++, i += 4) {
      if (lumaAtRgba(rgba, i) < LUMA_THRESHOLD) continue;
      const gx = Math.min(gw - 1, Math.floor(x / cw));
      cnt[gy * gw + gx] = (cnt[gy * gw + gx] ?? 0) + 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  const boxes: { x0: number; y0: number; x1: number; y1: number; bright: number }[] = [];
  for (let start = 0; start < cnt.length; start++) {
    if (seen[start] === 1 || (cnt[start] ?? 0) === 0) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    let bright = 0;
    while (sp > 0) {
      const cell = stack[--sp] ?? 0;
      const cx = cell % gw;
      const cy = (cell - cx) / gw;
      bright += cnt[cell] ?? 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      // 8 邻域
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (seen[n] === 1 || (cnt[n] ?? 0) === 0) continue;
          seen[n] = 1;
          stack[sp++] = n;
        }
      }
    }
    if (bright < MIN_BRIGHT_PX) continue;
    boxes.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, bright });
  }
  boxes.sort((a, b) => b.bright - a.bright);
  const out: Detection[] = [];
  for (const b of boxes.slice(0, MAX_BOXES)) {
    const x = Math.round(b.x0 * cw);
    const y = Math.round(b.y0 * ch);
    const wPx = Math.round((b.x1 + 1) * cw) - x;
    const hPx = Math.round((b.y1 + 1) * ch) - y;
    const area = Math.max(1, wPx * hPx);
    const aspect = wPx / Math.max(1, hPx);
    // 置信度 = 框内亮度像素占比的线性映射（不是模型分数，面板上写清"占位检测器"）
    const score = Math.max(0.35, Math.min(0.99, 0.35 + (b.bright / area) * 1.2));
    const label = aspect > 3 ? (y < h * 0.35 ? "shelf" : "arm") : aspect > 0.6 && aspect < 1.6 ? "ball" : "target";
    out.push({ x, y, w: wPx, h: hPx, label, score });
  }
  return out;
}
