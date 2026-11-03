// RTL ↔ 上位机「逐事件」对拍（2026-10-06 适配的等价性证据）
//
// 为什么需要它：`engine.test.ts` 只对拍**逐帧事件数**（13 个整数）。数字相同不等于
// 事件相同 —— 坐标错位、极性翻转、事件在两帧之间搬家，都可能让计数看起来对得上。
// 这里把 ModelSim 转储出来的**每一条事件**（tb_retina_core_wp → wp_events.txt）
// 与上位机 RetinaEngine 的输出逐条比 (x, y, pol)，这才是"两边算的是同一件事"。
//
// 用法：
//   cd host/app
//   node --experimental-strip-types tools/rtl_wp_compare.ts [dump路径]
//
// 判据分级（因为不应期两边实现机制不同，见文件末尾说明）：
//   pass0/pass1（不应期**旁路**）→ 必须**逐条完全一致**，否则退出码 1
//   pass2/3/4（不应期开）→ 逐条比对结果只作**测量**，不判失败；单独统计差异并报告
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RetinaEngine, TB_PARAMS, patternFrame565, tbPatternSequence } from "@retina/retina";
import type { EventRecord } from "@retina/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DUMP = resolve(HERE, "..", "..", "..", "retina_event", "build", "sim", "tb_retina_core_wp", "wp_events.txt");

const NFRAMES = 13;

interface PassSpec {
  readonly theta: number;
  readonly minDl: number;
  readonly refractoryFrames: number;
  /** true = 逐条必须完全一致（不应期旁路） */
  readonly exact: boolean;
  readonly note: string;
}

const PASSES: readonly PassSpec[] = [
  { theta: 74, minDl: 2, refractoryFrames: 0, exact: true, note: "自校验：复现 tb_retina_core golden" },
  { theta: 1, minDl: 20, refractoryFrames: 0, exact: true, note: "★ 已验证工作点（无余晖）" },
  { theta: 1, minDl: 20, refractoryFrames: 2, exact: false, note: "★ 板端实际配置（余晖开）" },
  { theta: 1, minDl: 32, refractoryFrames: 2, exact: false, note: "区域·省流" },
  { theta: 3, minDl: 18, refractoryFrames: 2, exact: false, note: "运动边缘" },
];

const key = (e: EventRecord): string => e.x + "," + e.y + "," + e.pol;

function parseDump(path: string): Map<string, EventRecord[]> {
  const txt = readFileSync(path, "utf8");
  const out = new Map<string, EventRecord[]>();
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (s === "" || s.startsWith("#")) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 5) continue;
    const pass = Number(parts[0]);
    const frame = Number(parts[1]);
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    // EventRecord.pol 是字面量联合 0 | 1（协议层钉死的极性编码），不能直接塞 number
    const pol: 0 | 1 = Number(parts[4]) === 1 ? 1 : 0;
    const k = pass + "/" + frame;
    let arr = out.get(k);
    if (arr === undefined) {
      arr = [];
      out.set(k, arr);
    }
    arr.push({ x, y, pol, flags: 0, ts: 0 });
  }
  return out;
}

function main(): number {
  const dumpPath = process.argv[2] ?? DEFAULT_DUMP;
  if (!existsSync(dumpPath)) {
    console.error("找不到 RTL 转储：" + dumpPath);
    console.error("先跑：cd retina_event && pwsh -File tool/run_sim.ps1 -Tb tb_retina_core_wp");
    return 2;
  }
  const rtl = parseDump(dumpPath);
  console.log("RTL 转储：" + dumpPath);
  console.log("已解析 pass/frame 组合数 = " + rtl.size);

  let failed = 0;
  const summary: string[] = [];

  for (let p = 0; p < PASSES.length; p++) {
    const spec = PASSES[p] as PassSpec;
    const eng = new RetinaEngine({
      ...TB_PARAMS,
      theta: spec.theta,
      minDl: spec.minDl,
      refractoryFrames: spec.refractoryFrames,
    });

    let exactOk = true;
    let totalRtl = 0;
    let totalHost = 0;
    let totalCommon = 0;
    const perFrame: string[] = [];

    for (let f = 1; f <= NFRAMES; f++) {
      const { mode, frameCnt } = tbPatternSequence(f);
      const host = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480).events;
      const rtlEv = rtl.get(p + "/" + f) ?? [];

      const hs = new Set(host.map(key));
      const rs = new Set(rtlEv.map(key));
      let common = 0;
      for (const k of rs) if (hs.has(k)) common++;

      totalRtl += rtlEv.length;
      totalHost += host.length;
      totalCommon += common;

      const same = rtlEv.length === host.length && common === host.length;
      if (!same) exactOk = false;
      perFrame.push(
        "f" + f + ": rtl=" + rtlEv.length + " host=" + host.length + " 共同=" + common +
        (same ? " ✓" : " ✗(仅RTL=" + (rtlEv.length - common) + ", 仅上位机=" + (host.length - common) + ")"),
      );
    }

    const verdict = exactOk ? "逐条完全一致" : "有差异";
    summary.push(
      "pass" + p + " θ=" + spec.theta + " 守卫=" + spec.minDl +
      " 余晖=" + (spec.refractoryFrames === 0 ? "旁路" : spec.refractoryFrames + "帧") +
      " ⇒ " + verdict +
      "（RTL 合计 " + totalRtl + " / 上位机 " + totalHost + " / 共同 " + totalCommon + "）",
    );

    console.log("");
    console.log("── pass" + p + "：" + spec.note + " ──");
    console.log("   θ=" + spec.theta + " 守卫=" + spec.minDl +
      " 余晖=" + (spec.refractoryFrames === 0 ? "旁路" : spec.refractoryFrames));
    for (const line of perFrame) console.log("   " + line);

    if (spec.exact) {
      if (exactOk) {
        console.log("   ⇒ PASS：与 RTL **逐条**一致");
      } else {
        console.log("   ⇒ FAIL：不应期旁路下两边必须逐条一致，实得差异");
        failed++;
      }
    } else {
      console.log("   ⇒ 测量（不判失败）：余晖两边的实现机制不同，见文件末尾说明");
    }
  }

  console.log("");
  console.log("================ 汇总 ================");
  for (const s of summary) console.log("  " + s);
  console.log("");
  if (failed === 0) {
    console.log("RTL_WP_COMPARE=PASS（不应期旁路的每一遍都逐条一致）");
  } else {
    console.log("RTL_WP_COMPARE=FAIL（" + failed + " 遍逐条不一致）");
  }
  return failed === 0 ? 0 : 1;
}

// ────────────────────────────────────────────────────────────────────────────
// 关于不应期（余晖）两边实现机制不同这件事 —— 这是本轮**测出来**的，不是猜的
//
//   RTL `refractory.v`：冷却位图。每 REFRACT_FRAMES 个 vsync 把整张位图清 0
//     （首清在第 REFRACT_FRAMES+1 个 vsync，此后每 REFRACT_FRAMES 个一次）。
//     于是"能不能再放行"取决于**全局清扫相位**，而不是该像素上次放行的时刻。
//  上位机 `RetinaEngine`：每像素倒计时。放行时置 N，每帧减 1，减到 0 才再放行
//     ⇒ 严格"每像素每 N 帧至多 1 个事件"。
//
//   两者在**稳定运动**下都退化成"隔帧放行"，总事件数接近；但对"从某一帧才开始变化"
//   的像素，相位可能差 1 帧（RTL 的清扫可能恰好落在它刚置位之后）。
//   所以本脚本对余晖开的几遍只做测量、不判失败；逐条一致的要求只施加在**旁路**的
//   两遍上 —— 那才是"算法本身"（θ/守卫/坐标/极性）的等价性。
// ────────────────────────────────────────────────────────────────────────────

process.exit(main());
