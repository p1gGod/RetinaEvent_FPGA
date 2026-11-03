// RTL ↔ 上位机「逐事件」对拍（**真实相机通路**，2026-10-07 H63 修复的等价性证据）
//
// 与 rtl_wp_compare.ts 的区别（为什么必须再有一个）：
//   rtl_wp_compare 用的激励是 vps_pattern_gen 通路 —— 它的 de 是**行内连续**的，
//   所以它证明不了"相机通路（cam_tap → CDC-0 稀疏 de）"下算法也对。
//   板端真正的入口是相机通路，而 H63 那个 bug 恰恰只在那条路上出现
//   （CDC-0 抹掉消隐 ⇒ 2×2 抽点被静默旁路），pattern 通路的 TB 全绿也照样漏。
//
//   本脚本把 tb_retina_core_cam 的**场景**在 TypeScript 里逐像素复算一遍
//   （见 sceneFrame()，与 TB 的 scene_lum/px565 逐字对应），喂给上位机
//   RetinaEngine（θ=1 / 守卫=20 / 不应期旁路），然后与 ModelSim 转储的
//   每一条事件 (x, y, pol) 逐条比 —— 这就是"两端对齐"的机器判据。
//
// 用法（CWD = host/app）：
//   node --experimental-strip-types tools/rtl_cam_compare.ts [dump路径]
//   前置：cd retina_event && pwsh -File tool/run_sim.ps1 -Tb tb_retina_core_cam
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RetinaEngine, TB_PARAMS } from "@retina/retina";
import type { EventRecord } from "@retina/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DUMP = resolve(
  HERE, "..", "..", "..",
  "retina_event", "build", "sim", "tb_retina_core_cam", "cam_events.txt",
);

// ---- 必须与 tb_retina_core_cam.v 的常量逐字一致 ----
const IN_W = 800;
const IN_H = 480;
const BAR_W = 64;
const BAR_X0 = 200;
const THETA = 1;
const MINDL = 20;
const NF = 6;

/** 灰度 → RGB565，与 vps_pattern_gen / TB 的 {lum[7:3], lum[7:2], lum[7:3]} 一致 */
function px565(lum: number): number {
  const r5 = (lum >> 3) & 0x1f;
  const g6 = (lum >> 2) & 0x3f;
  const b5 = (lum >> 3) & 0x1f;
  return ((r5 << 11) | (g6 << 5) | b5) & 0xffff;
}

/** 与 TB 的 scene_lum() 逐字对应：静态竖条纹背景 + 每帧右移 2 输入像素的亮条 */
function sceneFrame(f: number): Uint16Array {
  const px = new Uint16Array(IN_W * IN_H);
  const bx = BAR_X0 + 2 * f;
  for (let y = 0; y < IN_H; y++) {
    const rowBase = y * IN_W;
    for (let x = 0; x < IN_W; x++) {
      let lum: number;
      if (x >= bx && x < bx + BAR_W) lum = 0xf0;
      else if (x % 40 < 20) lum = 0x30;
      else lum = 0x50;
      px[rowBase + x] = px565(lum);
    }
  }
  return px;
}

const key = (e: EventRecord): string => e.x + "," + e.y + "," + e.pol;

function parseDump(path: string): Map<number, EventRecord[]> {
  const txt = readFileSync(path, "utf8");
  const out = new Map<number, EventRecord[]>();
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (s === "" || s.startsWith("#")) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 4) continue;
    const frame = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const pol: 0 | 1 = Number(parts[3]) === 1 ? 1 : 0;
    let arr = out.get(frame);
    if (arr === undefined) {
      arr = [];
      out.set(frame, arr);
    }
    arr.push({ x, y, pol, flags: 0, ts: 0 });
  }
  return out;
}

function main(): number {
  const dumpPath = process.argv[2] ?? DEFAULT_DUMP;
  if (!existsSync(dumpPath)) {
    console.error("找不到 RTL 转储：" + dumpPath);
    console.error("先跑：cd retina_event && pwsh -File tool/run_sim.ps1 -Tb tb_retina_core_cam");
    return 2;
  }
  const rtl = parseDump(dumpPath);
  console.log("RTL 转储：" + dumpPath);
  console.log("转储里出现的相机帧号 = " + [...rtl.keys()].sort((a, b) => a - b).join(", "));

  const eng = new RetinaEngine({ ...TB_PARAMS, theta: THETA, minDl: MINDL, refractoryFrames: 0 });

  // ---- 逐帧对拍 ----
  //   帧 0：RTL 的 first_frame 抑制（上位机同样首帧不给差分）⇒ 两侧都应 0 事件，
  //         但 RTL 的**复位点落在相机帧中间**，首个 vsync 标记出现前计数器还没对齐，
  //         帧存被错位写了一遍，所以 RTL 的**第 1 帧**（标签 1）必然是垃圾帧。
  //         这是"上电后一帧"的启动瞬态（板上同理，约 38 ms），不是稳态行为 ⇒ 只报告。
  //   帧 2..NF：必须**逐条完全一致**。
  let failed = 0;
  let hostTotal = 0;
  let rtlTotal = 0;
  let commonTotal = 0;
  const perFrame: string[] = [];
  const badFrames: number[] = [];

  for (let f = 0; f <= NF; f++) {
    const host = eng.processPixels(sceneFrame(f), IN_W, IN_H).events;
    const rtlEv = rtl.get(f) ?? [];
    const hs = new Set(host.map(key));
    const rs = new Set(rtlEv.map(key));
    let common = 0;
    for (const k of rs) if (hs.has(k)) common++;
    const same = rtlEv.length === host.length && common === host.length;
    if (f <= 1) {
      perFrame.push(
        "f" + f + ": rtl=" + rtlEv.length + " host=" + host.length + "  [启动瞬态，不判]",
      );
      continue;
    }
    hostTotal += host.length;
    rtlTotal += rtlEv.length;
    commonTotal += common;
    if (!same) {
      failed++;
      badFrames.push(f);
    }
    perFrame.push(
      "f" + f + ": rtl=" + rtlEv.length + " host=" + host.length + " 共同=" + common +
      (same ? " ✓" : " ✗(仅RTL=" + (rtlEv.length - common) + ", 仅上位机=" + (host.length - common) + ")"),
    );
  }

  console.log("");
  console.log("── θ=" + THETA + " 守卫=" + MINDL + " 不应期=旁路（相机通路）──");
  for (const line of perFrame) console.log("   " + line);

  // ---- 解析式期望值（与 TB 的判据同源）----
  //   亮条覆盖输入 x ∈ [200+2f, +64) ⇒ 抽点后事件列 [100+f, 131+f]
  //   只有 99+f（转暗 ⇒ OFF）与 131+f（转亮 ⇒ ON）两列发生变化，
  //   守卫 |ΔL| ≥ 20 把拉普拉斯摊出去的邻列挡掉 ⇒ 2 列 × 239 行 = 478
  console.log("");
  console.log("── 解析式期望（两列 × 239 行 = 478，逐帧右移 1 列）──");
  let analyticBad = 0;
  for (let f = 2; f <= NF; f++) {
    const off = 99 + f;
    const on = 131 + f;
    const ev = rtl.get(f) ?? [];
    const xs = new Set(ev.map((e) => e.x));
    const ys = ev.map((e) => e.y);
    const ymin = ys.length === 0 ? -1 : Math.min(...ys);
    const ymax = ys.length === 0 ? -1 : Math.max(...ys);
    const ok =
      ev.length === 478 &&
      xs.size === 2 && xs.has(off) && xs.has(on) &&
      ymin === 0 && ymax === 238;
    if (!ok) analyticBad++;
    console.log(
      "   f" + f + ": n=" + ev.length + " 列={" + [...xs].sort((a, b) => a - b).join(",") +
      "} 期望={" + off + "," + on + "} y=" + ymin + ".." + ymax + " " + (ok ? "✓" : "✗"),
    );
  }

  console.log("");
  console.log("================ 汇总 ================");
  console.log("  稳态帧（2.." + NF + "）RTL 合计 " + rtlTotal +
    " / 上位机 " + hostTotal + " / 共同 " + commonTotal);
  console.log("  逐条不一致的帧：" + (badFrames.length === 0 ? "无" : badFrames.join(", ")));
  console.log("  不满足解析式几何的帧数：" + analyticBad);
  console.log("");
  if (failed === 0 && analyticBad === 0) {
    console.log("RTL_CAM_COMPARE=PASS（相机通路下与上位机逐条一致，且坐标几何符合解析式）");
    return 0;
  }
  console.log("RTL_CAM_COMPARE=FAIL（" + failed + " 帧逐条不一致，" + analyticBad + " 帧几何不符）");
  return 1;
}

process.exit(main());
