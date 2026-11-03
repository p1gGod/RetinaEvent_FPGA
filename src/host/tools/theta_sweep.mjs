// θ 扫描工具：从**正在运行的网关**抓一批真实帧，用与网关同一份算法离线扫 θ，
// 输出「原始帧 / 事件层 / 叠加」对比图 + 数据 JSON。
//
// 为什么必须有它：θ 到底该取多少，是**现场问题**，不是逻辑问题。
// 只有拿真实帧扫一遍才知道「8 有运动、44 什么都没有」。靠猜没用。
//
// 用法（网关要开着）：
//   node --experimental-strip-types tools/theta_sweep.mjs --frames 12 --thetas 2,4,8,16,44 --out out.png
//
// 产出：
//   <out>.png    1 + N 列；上排 = 原图/叠加，下排 = 原图/纯事件层
//   <out>.json   每个 θ 的事件数 / 事件率 / 覆盖率
import { writeFileSync } from "node:fs";
import { EventBitmap, RetinaEngine, BOARD_PARAMS } from "@retina/retina";
import { decodeRgb565 } from "@retina/protocol";
import { encodePngRgba, downscaleRgba } from "../gateway/src/util/png.ts";

const GW = process.env.GW ?? "http://127.0.0.1:8787";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const N = Number.parseInt(arg("frames", "12"), 10);
/**
 * 一列 = 一组参数。写法 `theta` 或 `theta:minDl`：
 *   --thetas 2,4,8,16,44            只扫 θ（守卫取 --minDl）
 *   --thetas 8:1,8:4,8:8,8:16       固定 θ=8 扫守卫
 * 为什么必须支持固定 θ 扫守卫：θ 定的是"多大的空间对比才算事件"，守卫定的是
 * "中心像素至少要有多少时域变化"——**抑制缓慢的自动曝光漂移靠的是后者，不是前者**。
 */
const SPECS = arg("thetas", "2,4,8,16,44").split(",").map((s) => {
  const [t, m] = s.trim().split(":");
  return { theta: Number.parseInt(t ?? "", 10), minDl: m === undefined ? null : Number.parseInt(m, 10) };
}).filter((s) => Number.isFinite(s.theta));
const OUT = arg("out", "theta_sweep.png");
const MIN_DL_DEFAULT = Number.parseInt(arg("minDl", "1"), 10);
/**
 * 位图余晖衰减系数。
 *   0.55（默认，与界面一致）= 累积视图：看得见"物体刚经过哪里"
 *   0                      = **只画本帧事件**：没有余晖，骗不了人
 * 两个都要出：只用累积图会把"一帧里 700 个事件"看成"整个画面都在动"。
 */
const DECAY = Number.parseFloat(arg("decay", "0.55"));

// ————————————————————————— ① 抓帧 —————————————————————————
async function capture(n) {
  const out = [];
  let lastSeq = -1;
  const t0 = Date.now();
  while (out.length < n && Date.now() - t0 < 120000) {
    let m = null;
    try {
      const r = await fetch(GW + "/api/frame.json");
      if (r.ok) m = await r.json();
    } catch {
      throw new Error("连不上网关 " + GW + "（网关要先跑起来）");
    }
    if (m !== null && m.seq !== lastSeq) {
      lastSeq = m.seq;
      const raw = Buffer.from(await (await fetch(GW + "/api/frame.raw")).arrayBuffer());
      if (raw.length === m.w * m.h * 2) out.push({ seq: m.seq, frameIdx: m.frameIdx, raw, w: m.w, h: m.h });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (out.length < 2) throw new Error("只抓到 " + out.length + " 帧（需要 ≥2 帧才能算时域差分）");
  return out;
}

console.log("[theta_sweep] 抓帧中（需要 " + N + " 帧）…");
const frames = await capture(N);
console.log(
  "[theta_sweep] 抓到 " + frames.length + " 帧，seq " + frames[0].seq + "…" + frames[frames.length - 1].seq +
  "，帧号 " + frames[0].frameIdx + "…" + frames[frames.length - 1].frameIdx,
);

// ————————————————————————— ② 每个 θ 跑一遍 —————————————————————————
/**
 * 形状指标：区分"噪声散点"、"连通的轮廓"、"成片的区域"。
 *
 * 为什么要它（2026-10-06 用户给出第二个工作点 θ=1/守卫=20 之后）：
 * 孤立率能分出"散点 vs 连通"，但分不出**轮廓 vs 实心区域**——
 * 而这两者是完全不同的输出（一个是边缘，一个是运动区域/包络）。
 * 所以再加一个**最大连通块占比**：事件里属于同一块的比例。
 *   · 噪声散点   ⇒ 块很多、每块很小 ⇒ 占比低
 *   · 运动轮廓   ⇒ 一两条长链     ⇒ 占比中等偏高
 *   · 运动区域   ⇒ 一大片         ⇒ 占比很高
 */
function shapeStats(records, w = 400, h = 240) {
  const occ = new Uint8Array(w * h);
  for (const e of records) {
    if (e.x >= 0 && e.x < w && e.y >= 0 && e.y < h) occ[e.y * w + e.x] = 1;
  }
  let iso = 0;
  for (const e of records) {
    let n = 0;
    for (let dy = -1; dy <= 1 && n === 0; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = e.x + dx;
        const ny = e.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (occ[ny * w + nx] === 1) { n = 1; break; }
      }
    }
    if (n === 0) iso++;
  }
  // 4 连通洪泛，统计块数与最大块
  const stack = new Int32Array(records.length + 1);
  const seen = new Uint8Array(w * h);
  let comps = 0;
  let largest = 0;
  for (const e of records) {
    const start = e.y * w + e.x;
    if (start < 0 || start >= w * h || seen[start] === 1) continue;
    comps++;
    let sp = 0;
    let size = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const c = stack[--sp];
      size++;
      const cx = c % w;
      const cy = (c - cx) / w;
      if (cx > 0 && seen[c - 1] === 0 && occ[c - 1] === 1) { seen[c - 1] = 1; stack[sp++] = c - 1; }
      if (cx < w - 1 && seen[c + 1] === 0 && occ[c + 1] === 1) { seen[c + 1] = 1; stack[sp++] = c + 1; }
      if (cy > 0 && seen[c - w] === 0 && occ[c - w] === 1) { seen[c - w] = 1; stack[sp++] = c - w; }
      if (cy < h - 1 && seen[c + w] === 0 && occ[c + w] === 1) { seen[c + w] = 1; stack[sp++] = c + w; }
    }
    if (size > largest) largest = size;
  }
  return { iso, comps, largest };
}

function runTheta(spec) {
  const minDl = spec.minDl ?? MIN_DL_DEFAULT;
  const eng = new RetinaEngine({ ...BOARD_PARAMS, theta: spec.theta, minDl });
  const bmp = new EventBitmap(400, 240, DECAY);
  let total = 0;
  let on = 0;
  let off = 0;
  let maxAbsDl = 0;
  let lastCount = 0;
  let isoSum = 0;
  let compSum = 0;
  let largestSum = 0;
  let isoN = 0;
  for (const f of frames) {
    const r = eng.processBeBytes(f.raw, f.w, f.h);
    bmp.step();                    // 先衰减、再写本帧（与网关/前端一致）
    bmp.apply(r.events);
    total += r.events.length;
    lastCount = r.events.length;
    const sh = shapeStats(r.events);
    isoSum += sh.iso;
    compSum += sh.comps;
    largestSum += sh.largest;
    isoN++;
    for (const e of r.events) { if (e.pol === 1) on++; else off++; }
    for (let i = 0; i < r.dl.length; i++) { const a = Math.abs(r.dl[i]); if (a > maxAbsDl) maxAbsDl = a; }
  }
  let covered = 0;
  for (let i = 0; i < 96000; i++) {
    if (bmp.rgba[i * 4] !== 0 || bmp.rgba[i * 4 + 1] !== 0 || bmp.rgba[i * 4 + 2] !== 0) covered++;
  }
  const perFrame = total / frames.length;
  // 数据量降低：原始帧字节 ÷ 事件字节（与界面同一口径：800*480*2 字节 vs 每条 5 字节）
  const evBytes = perFrame * 5;
  return {
    theta: spec.theta, minDl,
    perFrame,
    onPerFrame: on / frames.length,
    offPerFrame: off / frames.length,
    maxAbsDl, lastCount, covered, bmp,
    isoPerFrame: isoSum / isoN,
    compsPerFrame: compSum / isoN,
    largestShare: perFrame > 0 ? (largestSum / isoN) / perFrame : 0,
    reduction: evBytes > 0 ? (800 * 480 * 2) / evBytes : Infinity,
  };
}

const rows = SPECS.map(runTheta);
const anyMinDl = rows.some((r) => r.minDl !== rows[0].minDl);
console.log("\n  θ   守卫     事件/帧   孤立率  最大块占比  连通块数   降低倍   覆盖栅格  max|ΔL|");
for (const r of rows) {
  const isoPct = r.perFrame > 0 ? (r.isoPerFrame / r.perFrame) * 100 : 0;
  console.log(
    "  " + String(r.theta).padStart(4) + "  " + String(r.minDl).padStart(4) + "  " + r.perFrame.toFixed(1).padStart(8) + "  " +
    isoPct.toFixed(1).padStart(6) + "%  " + (r.largestShare * 100).toFixed(1).padStart(9) + "%  " +
    r.compsPerFrame.toFixed(0).padStart(9) + "  " +
    (r.reduction === Infinity ? "∞" : r.reduction.toFixed(1) + "×").padStart(7) + "  " +
    String(r.covered).padStart(8) + "  " + String(r.maxAbsDl).padStart(7),
  );
}

// ————————————————————————— ③ 拼图 —————————————————————————
// 5×7 点阵字体：只为了在图上写字，不值得为此引一个依赖
const FONT = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..",".##..","..#..","..#..","..#..","..#..",".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

/** 把 text 画到一块 w×h 的 RGBA 缓冲上（左上空黑底），返回该缓冲 */
function textBlock(w, h, text, scale, color) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2]; buf[o + 3] = 255;
  };
  let cx = 4;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 7; r++) {
      const line = g[r] ?? "";
      for (let c = 0; c < 5; c++) {
        if (line[c] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(cx + c * scale + dx, 4 + r * scale + dy);
      }
    }
    cx += 6 * scale;
  }
  return buf;
}

const PW = 400, PH = 240, BAR = 22, GAP = 8;
const cols = 1 + rows.length;
const W = cols * PW + (cols + 1) * GAP;
const H = 2 * (BAR + PH) + 3 * GAP;
const canvas = new Uint8ClampedArray(W * H * 4);
for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;

function blit(src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const s = (y * sw + x) * 4;
      const d = ((dy + y) * W + (dx + x)) * 4;
      canvas[d] = src[s]; canvas[d + 1] = src[s + 1]; canvas[d + 2] = src[s + 2]; canvas[d + 3] = 255;
    }
  }
}

// 末帧原图 → RGBA → 降到栅格尺寸（与 400×240 事件栅格逐格对齐）
const last = frames[frames.length - 1];
const fullRgba = new Uint8ClampedArray(last.w * last.h * 4);
decodeRgb565(last.raw, fullRgba, "BE");
const base = downscaleRgba(fullRgba, last.w, last.h, PW);

/** 面板 = 标题条 + 图；返回要 blit 的两块 */
function panel(title, titleColor, img, x, y) {
  // 标题条：深底 + 白字
  for (let yy = 0; yy < BAR - 2; yy++) {
    for (let xx = 0; xx < PW; xx++) {
      const o = ((y + yy) * W + (x + xx)) * 4;
      canvas[o] = 18; canvas[o + 1] = 22; canvas[o + 2] = 30; canvas[o + 3] = 255;
    }
  }
  blit(textBlock(PW, BAR - 2, title, 2, titleColor), PW, BAR - 2, x, y);
  blit(img, PW, PH, x, y + BAR);
}

/** 叠加：底图压暗到 55%，事件加 90% —— 和 UI 里 screen 混合同一个意图（让事件压得住底图） */
function overlayOf(ev) {
  const o = new Uint8ClampedArray(PW * PH * 4);
  for (let i = 0; i < PW * PH; i++) {
    o[i * 4] = Math.min(255, base.rgba[i * 4] * 0.55 + ev[i * 4] * 0.9);
    o[i * 4 + 1] = Math.min(255, base.rgba[i * 4 + 1] * 0.55 + ev[i * 4 + 1] * 0.9);
    o[i * 4 + 2] = Math.min(255, base.rgba[i * 4 + 2] * 0.55 + ev[i * 4 + 2] * 0.9);
    o[i * 4 + 3] = 255;
  }
  return o;
}

const yTop = GAP;
const yBot = BAR + PH + 2 * GAP;
const rawTitle = "RAW FRAME  IDX=" + last.frameIdx;
panel(rawTitle, [255, 214, 102], base.rgba, GAP, yTop);
panel(rawTitle, [255, 214, 102], base.rgba, GAP, yBot);
rows.forEach((r, k) => {
  const ev = r.bmp.toRgba();
  const x = GAP + (k + 1) * (PW + GAP);
  const t = "T=" + r.theta + (anyMinDl || r.minDl !== MIN_DL_DEFAULT ? " M=" + r.minDl : "") + "  N=" + r.lastCount;
  panel(t, [150, 255, 170], overlayOf(ev), x, yTop);
  panel(t, [150, 255, 170], ev, x, yBot);
});

writeFileSync(OUT, encodePngRgba(canvas, W, H));
const jsonPath = OUT.replace(/\.png$/i, ".json");
writeFileSync(jsonPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  gateway: GW,
  frames: frames.map((f) => ({ seq: f.seq, frameIdx: f.frameIdx })),
  minDlDefault: MIN_DL_DEFAULT,
  decay: DECAY,
  rows: rows.map((r) => ({
    theta: r.theta,
    minDl: r.minDl,
    eventsPerFrame: +r.perFrame.toFixed(1),
    onPerFrame: +r.onPerFrame.toFixed(1),
    offPerFrame: +r.offPerFrame.toFixed(1),
    isolatedPerFrame: +r.isoPerFrame.toFixed(1),
    isolatedPct: r.perFrame > 0 ? +((r.isoPerFrame / r.perFrame) * 100).toFixed(1) : 0,
    largestComponentSharePct: +(r.largestShare * 100).toFixed(1),
    componentsPerFrame: +r.compsPerFrame.toFixed(0),
    dataReductionX: r.reduction === Infinity ? null : +r.reduction.toFixed(1),
    lastFrameLit: r.lastCount,
    coveredCells: r.covered,
    coveragePct: +((r.covered / 96000) * 100).toFixed(2),
    maxAbsDl: r.maxAbsDl,
  })),
}, null, 1), "utf8");

console.log("\n[theta_sweep] 写出 " + OUT + " (" + W + "x" + H + ")");
console.log("[theta_sweep] 写出 " + jsonPath);
console.log("THETA_SWEEP_RESULT=OK");
