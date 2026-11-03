// 界面上的「上位机算法参数」键名 → 网关 `config.set` 键名的**唯一**映射。
//
// 为什么值得单独一个文件（2026-10-06 的真实事故）：
//   界面上叫 theta / minDl，网关的配置键叫 hostTheta / hostMinDl。
//   侧栏把 `{theta: 60}` 直接发给 config.set，网关按"未知配置项"处理，
//   走到 `config.set 不支持的键: theta` ⇒ 每次拖动都弹「参数未下发成功」，
//   而 θ 一直停在板端默认 44 ⇒ 事件画面几乎全黑。
//   一个键名就能让整个功能看起来"根本没实现"，而且**没有任何测试会发现它**。
//   所以：映射只写这一处，并且有单测钉住（web/test/hostparams.test.ts）。
import { EXP_CAP_LIMITS, MIN_DL_LIMITS, clampExpCap, clampMinDl } from "@retina/protocol";
import { HOST_SIM_DEFAULT_MINDL, HOST_SIM_DEFAULT_THETA } from "@retina/retina";

/** 界面侧的补丁（滑动条产出的就是这两个键） */
export interface HostParamPatch {
  readonly theta?: number;
  readonly minDl?: number;
}

/** 界面键 → 网关键 */
export const HOST_PARAM_KEY = {
  theta: "hostTheta",
  minDl: "hostMinDl",
} as const;

/** θ 滑动条值域（= 板端最大档 130，再大没有意义：判决链要求 |ΔL| ≥ 4θ） */
export const THETA_MIN = 1;
export const THETA_MAX = 130;
/**
 * 守卫滑动条值域。
 *
 * 上限从 20 提到 64（2026-10-06）：用户现场调出来的值是 **18**，正好贴在原来的边界上，
 * 差一点就没法再往上试。而"还能不能更干净"恰恰是要往上试才知道的 —— 滑块贴着上限
 * 等于把最后一个方向堵死了。
 */
export const MINDL_MIN = 1;
export const MINDL_MAX = 64;

/** 网关未连接时界面先用这两个值渲染（连上后以网关的 config 为准） */
export const HOST_THETA_FALLBACK = HOST_SIM_DEFAULT_THETA;
export const HOST_MINDL_FALLBACK = HOST_SIM_DEFAULT_MINDL;

/**
 * 现场实测出来的工作点，做成一键预设。
 *
 * 为什么要预设（2026-10-06 用户先后给出两个"感觉更好"的组合）：θ 与守卫**不是**
 * 两个可以各自独立拖到最优的旋钮 —— 它们的组合决定的是**输出形态**：
 *
 *   θ=1 ⇒ 空间算子近乎旁路 ⇒ 输出是**连通的运动区域**（孤立率 2.8%、最大连通块 38%）
 *   θ=3 ⇒ 只留拉普拉斯峰   ⇒ 输出是**碎片化的运动边缘**（孤立率 14.2%、最大连通块 8.9%）
 *
 * 这两者都对，只是用途不同（区域适合给下游做 ROI/跟踪，边缘适合只要"哪里变过"且省带宽）。
 * 靠拖两个滑块反复逼近某一组值很费事，所以把实测过的点直接做成按钮。
 * 数字全部来自 `host/app/tools/theta_sweep.mjs` 的现场扫描，见
 * `docs/05_实验与实测/上位机实测_20261006/09_轮廓vs区域.json`。
 */
export interface HostPreset {
  readonly id: string;
  /** 按钮上的字（要短） */
  readonly label: string;
  readonly theta: number;
  readonly minDl: number;
  /** 悬停说明：写清"这个点换来的是什么、代价是什么" */
  readonly note: string;
}

export const HOST_PRESETS: readonly HostPreset[] = [
  {
    id: "region",
    label: "运动区域",
    theta: HOST_SIM_DEFAULT_THETA,
    minDl: HOST_SIM_DEFAULT_MINDL,
    note: "θ=1 / 守卫=20 —— 输出**连通的运动区域**（物体与其扫过的范围），孤立率 2.8%、最大连通块 38%、事件约 11 000/帧、数据量降低 14×。适合看出物体在哪、往哪走。",
  },
  {
    id: "region-lean",
    label: "区域·省流",
    theta: 1,
    minDl: 32,
    note: "θ=1 / 守卫=32 —— 同样是区域，但事件少 26%（约 8 200/帧）、数据量降低 19×，连通性反而略好（最大连通块 40.7%）。区域形态下最划算的一档。",
  },
  {
    id: "edge",
    label: "运动边缘",
    theta: 3,
    minDl: 18,
    note: "θ=3 / 守卫=18 —— 输出**碎片化的运动边缘**（孤立率 14.2%、最大连通块 8.9%），事件约 4 900/帧、数据量降低 32×。稀疏、省带宽，但看不出物体占哪一块。",
  },
  {
    id: "board",
    label: "旧板端 44/1",
    theta: 44,
    minDl: 1,
    note: "2026-10-06 之前的板端上电值（θ=44 / 守卫=1）—— 现在板子 KEY1 的**档位 3** 仍然是它。在本场景下**等于全黑**（1.1 事件/帧），只用来做 1:1 对照，不是可用工作点。⚠️ 板子上电默认已改为档位 0 = (1,20)，与第一个预设相同。",
  },
];

/** 当前参数是否正落在某个预设上（用来高亮按钮）；容差 0 = 必须完全相等 */
export function matchPreset(theta: number, minDl: number): string | null {
  for (const p of HOST_PRESETS) {
    if (p.theta === theta && p.minDl === minDl) return p.id;
  }
  return null;
}

export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// ————————————————— 板端 SET_PARAM 输入钳位（Q-7 / P-5） —————————————————
// 板端寄存器是权威值域：θ 12 bit（0..4095）、MIN_DL 9 bit（0..511）。
// MIN_DL 上限 511 来自统一把关报告 Q-7：板端 downlink_cmd 的 T_MIN_DL >511 → STATUS=BAD_VALUE
// **且 SET_PARAM 原子性把同包其它合法 tag 一并拦掉** —— UI 必须不发出注定被拒的值。
// 单位/上限待算法组 U7 定案：本钳位是总监建议的先行缓解，可回退（定案后同步改协议层 MIN_DL_LIMITS）。
/** 板端 θ 输入值域（tag 0x01，12 bit） */
export const BOARD_THETA_MIN = 0;
export const BOARD_THETA_MAX = 4095;
/** 板端 MIN_DL 输入值域（tag 0x02，9 bit 寄存器；真值表在协议层 MIN_DL_LIMITS） */
export const BOARD_MINDL_MIN = MIN_DL_LIMITS.MIN;
export const BOARD_MINDL_MAX = MIN_DL_LIMITS.MAX;

export interface BoardMinDlClampResult {
  readonly value: number;
  /** 是否发生了钳位（true ⇒ 调用方必须提示用户，不静默改数） */
  readonly clamped: boolean;
}

/**
 * MIN_DL 输入钳位：600 → 511、负值 → 0、非数字 → 0（与协议层 `clampMinDl` 同一实现）。
 * 返回 `clamped` 是为了让 UI 能说出"你输的 600 被钳成 511 了" —— 悄悄改用户输入是骗人。
 */
export function clampBoardMinDlInput(raw: number): BoardMinDlClampResult {
  const value = clampMinDl(raw);
  // 非数字（NaN === NaN 为 false）与取整/越界都会走这里 → clamped=true
  return { value, clamped: raw !== value };
}

// ————————————————— 板端 EXP_CAP（曝光上限）输入值域（sccb 集成报告 §4.1/§9.1） —————————————————
/** 板端 EXP_CAP 输入值域（tag 0x0B，u16 BE，单位 = 行；真值表在协议层 EXP_CAP_LIMITS） */
export const BOARD_EXP_CAP_MIN = EXP_CAP_LIMITS.MIN;
export const BOARD_EXP_CAP_MAX = EXP_CAP_LIMITS.MAX;

/**
 * EXP_CAP 输入钳位：3 → 4、9999 → 5904、非数字 → 4（与协议层 `clampExpCap` 同一实现）。
 * ⚠️ 600 在 4..5904 内 ⇒ **原样通过**（与 MIN_DL 的 600→511 不是同一个值域，别照抄那个例子）。
 * 返回 `clamped` 是为了让 UI 能说出"你输的 9999 被钳成 5904 了" —— 悄悄改用户输入是骗人。
 */
export function clampBoardExpCapInput(raw: number): BoardMinDlClampResult {
  const value = clampExpCap(raw);
  return { value, clamped: raw !== value };
}

/**
 * 界面补丁 → config.set 的 params。空补丁返回空对象（调用方据此跳过这次 RPC）。
 *
 * ⚠️ 返回值里的键**必须是** hostTheta / hostMinDl，绝不能出现 theta / minDl ——
 * 测试就是钉这一条。
 */
export function toHostParamRpc(patch: HostParamPatch): Record<string, number> {
  const out: Record<string, number> = {};
  if (patch.theta !== undefined) out[HOST_PARAM_KEY.theta] = clampInt(patch.theta, THETA_MIN, THETA_MAX);
  if (patch.minDl !== undefined) out[HOST_PARAM_KEY.minDl] = clampInt(patch.minDl, MINDL_MIN, MINDL_MAX);
  return out;
}
