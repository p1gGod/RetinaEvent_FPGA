// 上位机侧的「仿视网膜事件驱动视觉」算法 —— 与 RTL 逐位同构的**逐帧等价实现**。
//
// 为什么必须有它（2026-10-06 用户提出）：板上改一行要综合+实现+烧录（十几分钟到几十分钟），
// 中间链条太长，**根本没法快速看到"算法真正跑起来长什么样"**。上位机这份的作用是当**标准对照**：
// 同一帧输入，一边看板子算的、一边看这里算的，差异立刻可见。
//
// 与 RTL 的对应关系（逐级，见 retina_event/src/hdl/engine/）：
//   vps_resample   → samplePixel()   2×2 抽点取左上角（不是平均）
//   px_luma        → lumaFromRgb565() 位复制 + 77/150/29 + 取高字节
//   luma_log       → LUMA_LOG[]      256 项查表，尺度 255
//   temporal_diff  → 本文件 §2        与上一帧逐像素差，首帧强制 0
//   spatial_lap    → 本文件 §3        4c−(u+d+l+r)，算术右移 NORM_SHIFT
//   event_gen      → 本文件 §4        |lapN| ≥ θ 且 |ΔL| ≥ MIN_DL，含等号
//   refractory     → 本文件 §5        每像素 N 帧内至多 1 个事件（板端开、tb 旁路）
//
// ⚠️ 三条"看着不合理但必须照抄"的 RTL 事实：
//   1) 有效栅格是 **399×239**（x≤398, y≤238），不是文档写的 400×240 —— 结构性限制。
//   2) `lap >> 2` 是**算术右移**（向下取整），不是四舍五入；它带来 ±1 LSB 偏置、偏向多报 OFF。
//   3) 抽点是"取左上角"，没有任何抗混叠；换分辨率时结果会变，不是可缩放的算法。
import type { EventRecord } from "@retina/protocol";
import { LUMA_LOG, lumaFromRgb565 } from "./luma.ts";

export interface RetinaParams {
  /** 事件阈值 θ（对数亮度 LSB）。板上三档：44 / 74 / 130 */
  readonly theta: number;
  /** 最小 |ΔL| 守卫：低于它的变化不算事件（抑制噪声） */
  readonly minDl: number;
  /** 中心权重（RTL CENTER_GAIN） */
  readonly centerGain: number;
  /** 归一化右移位数（RTL NORM_SHIFT） */
  readonly normShift: number;
  /** 不应期帧数：0 = 旁路（与 tb_retina_core 一致）；2 = 板端实际生效值 */
  readonly refractoryFrames: number;
  /** 事件栅格（名义 400×240，实际可达 399×239） */
  readonly gridW: number;
  readonly gridH: number;
}

/** 与 `tb_retina_core` 一致（复现它的 golden 数字必须用这一组，尤其 refractory 要旁路） */
export const TB_PARAMS: RetinaParams = {
  theta: 74,
  minDl: 2,
  centerGain: 4,
  normShift: 2,
  refractoryFrames: 0,
  gridW: 400,
  gridH: 240,
};

/**
 * 与板端 `top_retina_event` 上电实际生效的值一致（θ=1 / 守卫=20 / 不应期生效）。
 *
 * ⚠️ 2026-10-06 变更：**板端上电默认已从 θ=44 / 守卫=1 改为 θ=1 / 守卫=20**。
 *   原因：上位机扫出来的可用工作点在板子上**根本到不了** —— 旧档位只有
 *   θ∈{44,74,130}、守卫∈{1,2,3}，而现场最优是 θ=1 / 守卫=20（旧档位在本场景下
 *   等于全黑：实测 1.1 事件/帧）。现在板子 KEY1 轮换的 4 个档位与 `HOST_PRESETS`
 *   逐个相同，上电即停在档位 0 = (1, 20)。
 *
 *   出处与证据：
 *     · RTL 档位表：`retina_event/src/hdl/control/sys_ctrl.v` 的 B5 工作点译码
 *     · 等价性测试台：`retina_event/sim/tb/tb_retina_core_wp.v`
 *       （自校验：θ=74/守卫=2/旁路 必须复现 tb_retina_core 的 golden
 *         0,0,5841,0,0,0,4,0,64,0,64,0,4 —— 实测复现）
 *     · 逐事件对拍：`host/app/tools/rtl_wp_compare.ts`（RTL 转储 vs 本文件的引擎）
 *
 *   ⚠️ 这里的字面量必须与 `HOST_SIM_DEFAULT_THETA` / `HOST_SIM_DEFAULT_MINDL` 相等
 *      （那两个常量在本文件后面才声明，此处不能直接引用 —— `const` 有 TDZ）。
 *      `engine.test.ts` 有断言钉住这个相等关系，改一处忘了另一处会红。
 */
export const BOARD_PARAMS: RetinaParams = {
  ...TB_PARAMS,
  theta: 1,
  minDl: 20,
  refractoryFrames: 2,
};

/**
 * 「上位机模拟处理」的默认参数 —— **现场实测挑出来的，不是板端上电值**。
 *
 * 判决链是 `lapN = (4c−(u+d+l+r)) >> 2`，两个旋钮管的是**两件不同的事**：
 *
 *   θ      = 空间对比门限。`on = lapN >= θ`，所以 θ 越小，空间算子越接近"旁路"：
 *            **θ=1 时只要求 lap ≥ 4**，任何局部不平坦的 ΔL 场都过得去 ⇒ 输出退化成
 *            **"时域变化掩膜"**（`|ΔL| ≥ minDl` 的像素），它的特点是**连通成片**。
 *            θ 一抬高就只剩拉普拉斯峰 ⇒ 变成**碎片化的边缘**。
 *   minDl  = 时域变化下限（中心像素自己的 |ΔL|）。**这一条才是照度漂移的过滤器**：
 *            相机自动曝光的漂移整幅同步发生（实测 ΔL ≈ f(L)，75%~99% 的方差只由 L 决定），
 *            幅度只有 3~8 LSB；运动物体边缘能到 200。
 *
 * 现场实测（摆动装置，单帧事件、无余晖，2026-10-06）：
 *
 * | θ | minDl | 事件/帧 | 孤立率 | 最大连通块占比 | 数据量降低 | 输出形态 |
 * |---|-------|---------|--------|----------------|-----------|----------|
 * | **1** | **20** | 11 084 | **2.8%** | **38.0%** | 13.9× | **运动区域：连成大片的包络** |
 * | 1 | 24    | 10 140 | 2.7% | 38.7% | 15.1× | 同上，略紧 |
 * | 1 | 32    | 8 182 | 2.6% | 40.7% | 18.8× | 同上，数据量少 26% |
 * | 2 | 20    | 7 698 | 5.1% | 17.1% | 20.0× | 过渡态 |
 * | 3 | 18    | 4 855 | 14.2% | 8.9% | 31.6× | 运动边缘：碎片化的轮廓 |
 * | 44 | 1    | 1.1 | — | — | — | 全黑（板端上电默认） |
 *
 * 关键读法：**θ=1 与 θ=3 不是"干净程度"的差别，是两种输出。**
 * 孤立率 2.8% vs 14.2%、最大连通块 38% vs 8.9% —— 前者是一片区域，后者是一把碎片。
 * 要"看出物体在动、物体在哪"用 θ=1；要"只要变化发生过的稀疏边缘、省数据量"用 θ=3。
 *
 * 默认取 **θ=1 / minDl=20**（用户现场判断 + 上表复核），
 * 其余几个工作点在界面上做成一键预设（`web/src/hostparams.ts` 的 `HOST_PRESETS`）。
 */
export const HOST_SIM_DEFAULT_THETA = 1;
/** 「上位机模拟处理」的默认守卫（最小 |ΔL|）—— 现场实测值，见 HOST_SIM_DEFAULT_THETA */
export const HOST_SIM_DEFAULT_MINDL = 20;

export interface FrameEvents {
  /** 本帧事件（x∈[0,398]、y∈[0,238]） */
  readonly events: EventRecord[];
  /** 对数亮度场（400×240），调试/可视化用 */
  readonly luma: Uint8Array;
  /** 时域差分场（−255..+255），调试/可视化用 */
  readonly dl: Int16Array;
}

/** 把"高字节在前"的 RGB565 字节流转成像素数组（与 profile.pixel = RGB565_BE 一致） */
export function pixelsFromBeBytes(raw: Uint8Array, count: number): Uint16Array {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = (((raw[2 * i] ?? 0) << 8) | (raw[2 * i + 1] ?? 0)) & 0xffff;
  return out;
}

export class RetinaEngine {
  readonly params: RetinaParams;

  private prevL: Uint8Array;
  private luma: Uint8Array;
  private dl: Int16Array;
  /** 不应期倒计时（每像素一帧），仅 refractoryFrames > 0 时分配 */
  private cool: Uint8Array | null;
  private firstFrame = true;
  /** 已处理帧数（从 1 开始计数，便于和 tb 的窗口号对齐） */
  framesProcessed = 0;

  constructor(params: RetinaParams = TB_PARAMS) {
    this.params = params;
    const n = params.gridW * params.gridH;
    this.prevL = new Uint8Array(n);
    this.luma = new Uint8Array(n);
    this.dl = new Int16Array(n);
    this.cool = params.refractoryFrames > 0 ? new Uint8Array(n) : null;
  }

  reset(): void {
    this.prevL.fill(0);
    this.luma.fill(0);
    this.dl.fill(0);
    this.cool?.fill(0);
    this.firstFrame = true;
    this.framesProcessed = 0;
  }

  /**
   * 喂一帧相机像素（RGB565，行优先，尺寸 w×h，应为栅格的 2 倍）。
   * 返回本帧事件。
   */
  processPixels(px: Uint16Array, w: number, h: number): FrameEvents {
    const { gridW, gridH, centerGain, normShift, theta, minDl } = this.params;
    const n = gridW * gridH;
    if (this.luma.length !== n) {
      this.prevL = new Uint8Array(n);
      this.luma = new Uint8Array(n);
      this.dl = new Int16Array(n);
    }

    // ---- ① 抽点（2×2 左上角）+ 亮度 + 对数压缩 ----
    const L = this.luma;
    for (let y = 0; y < gridH; y++) {
      const sy = 2 * y;
      if (sy >= h) break;
      const rowBase = sy * w;
      for (let x = 0; x < gridW; x++) {
        const sx = 2 * x;
        if (sx >= w) break;
        L[y * gridW + x] = LUMA_LOG[lumaFromRgb565(px[rowBase + sx] ?? 0)] ?? 0;
      }
    }

    // ---- ② 时域差分（首帧强制 0，与 RTL 的 i_first_frame 抑制等价）----
    const DL = this.dl;
    const prev = this.prevL;
    if (this.firstFrame) {
      DL.fill(0);
    } else {
      for (let i = 0; i < n; i++) DL[i] = (L[i] ?? 0) - (prev[i] ?? 0);
    }

    // ---- ③ 空间（中心-周边）+ ④ 判决 ----
    // 候选中心 x∈[0,gridW-2]、y∈[0,gridH-2]；越界抽头按 0 补（EDGE_MODE=0）
    const events: EventRecord[] = [];
    const xMax = gridW - 2;
    const yMax = gridH - 2;
    for (let y = 0; y <= yMax; y++) {
      const row = y * gridW;
      const upRow = row - gridW;
      const dnRow = row + gridW;
      for (let x = 0; x <= xMax; x++) {
        const c = DL[row + x] ?? 0;
        const l = x >= 1 ? (DL[row + x - 1] ?? 0) : 0;
        const r = DL[row + x + 1] ?? 0;              // x ≤ gridW-2 ⇒ 右邻必存在
        const u = y >= 1 ? (DL[upRow + x] ?? 0) : 0;
        const d = DL[dnRow + x] ?? 0;                // y ≤ gridH-2 ⇒ 下邻必存在
        const lap = centerGain * c - (u + d + l + r);
        const lapN = lap >> normShift;               // 算术右移 = 向下取整（不要用 Math.trunc(lap/4)）
        const on = lapN >= theta;
        const off = lapN <= -theta;
        if (!on && !off) continue;
        if (Math.abs(c) < minDl) continue;
        events.push({ x, y, pol: on ? 1 : 0, flags: 0, ts: 0 });
      }
    }

    // ---- ⑤ 不应期（板端生效；tb 旁路）----
    let out = events;
    if (this.cool !== null) {
      const cool = this.cool;
      // 先整帧递减（饱和到 0），再对本帧事件判冷却
      for (let i = 0; i < n; i++) {
        const v = cool[i] ?? 0;
        if (v > 0) cool[i] = v - 1;
      }
      const keep: EventRecord[] = [];
      for (const e of events) {
        const i = e.y * gridW + e.x;
        if ((cool[i] ?? 0) > 0) continue;            // 冷却中 ⇒ 抑制
        cool[i] = this.params.refractoryFrames;
        keep.push(e);
      }
      out = keep;
    }

    // ---- 收尾：本帧亮度成为下一帧的"上一帧" ----
    prev.set(L);
    this.firstFrame = false;
    this.framesProcessed++;
    return { events: out, luma: L, dl: DL };
  }

  /** 便捷入口：直接吃"高字节在前"的 RGB565 字节流 */
  processBeBytes(raw: Uint8Array, w: number, h: number): FrameEvents {
    return this.processPixels(pixelsFromBeBytes(raw, w * h), w, h);
  }
}

/**
 * 事件位图（4bit 单元，与 RTL 的 48000×8bit 组织一致）。
 *
 * 用途：① 与 RTL 的 `bmp_*.txt` 逐半字节对拍（这是最硬的可移植性证据）
 *       ② /api/events.png 与前端 L2 图层的事件来源之一
 *
 * 组织（照抄 RTL，不要"优化"）：
 *   addr = y*200 + (x>>1)；低半字节 = x 偶，高半字节 = x 奇
 *   半字节 bit[3] = 极性(1=ON)，bit[2:0] = 余晖强度（新事件写 7）
 *   每帧：先全图衰减（对整个 4bit 值减 dstep，下限 0），再写本帧事件
 */
export class EventNibbleBitmap {
  readonly w: number;
  readonly h: number;
  /** 48000 个字节，每个装 2 个 4bit 单元 */
  readonly words: Uint8Array;

  constructor(w = 400, h = 240) {
    this.w = w;
    this.h = h;
    this.words = new Uint8Array((w * h) / 2);
  }

  /** 一帧的更新：先衰减全图，再写本帧事件（顺序与 RTL 实测等效模型一致） */
  step(events: readonly EventRecord[], decayStep = 1): void {
    const d = decayStep < 0 ? 0 : decayStep > 15 ? 15 : decayStep;
    if (d > 0) {
      const words = this.words;
      for (let i = 0; i < words.length; i++) {
        const wv = words[i] ?? 0;
        const lo = wv & 0x0f;
        const hi = (wv >> 4) & 0x0f;
        const nlo = lo > d ? lo - d : 0;
        const nhi = hi > d ? hi - d : 0;
        words[i] = (nhi << 4) | nlo;
      }
    }
    for (const e of events) {
      if (e.x < 0 || e.x >= this.w || e.y < 0 || e.y >= this.h) continue;
      const nib = ((e.pol === 1 ? 1 : 0) << 3) | 0x07;
      const addr = e.y * (this.w / 2) + (e.x >> 1);
      const cur = this.words[addr] ?? 0;
      this.words[addr] = (e.x & 1) !== 0 ? ((nib << 4) | (cur & 0x0f)) : ((cur & 0xf0) | nib);
    }
  }

  /** 取某个像素的半字节（0 = 无事件） */
  nibbleAt(x: number, y: number): number {
    const addr = y * (this.w / 2) + (x >> 1);
    const wv = this.words[addr] ?? 0;
    return (x & 1) !== 0 ? (wv >> 4) & 0x0f : wv & 0x0f;
  }

  /** 非零单元数（与 RTL tb 的 count_nonzero_bitmap 同口径） */
  nonzeroCount(): number {
    let n = 0;
    for (const v of this.words) if (v !== 0) n++;
    return n;
  }

  reset(): void {
    this.words.fill(0);
  }

  /** 渲染成 RGBA（供 PNG 与前端图层） */
  toRgba(out?: Uint8ClampedArray): Uint8ClampedArray {
    const rgba = out ?? new Uint8ClampedArray(this.w * this.h * 4);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const nib = this.nibbleAt(x, y);
        const o = (y * this.w + x) * 4;
        rgba[o + 3] = 255;
        if (nib === 0) {
          rgba[o] = 0;
          rgba[o + 1] = 0;
          rgba[o + 2] = 0;
          continue;
        }
        const strength = (nib & 0x07) / 7;
        const on = (nib & 0x08) !== 0;
        rgba[o] = (on ? 255 : 77) * strength;
        rgba[o + 1] = (on ? 77 : 155) * strength;
        rgba[o + 2] = (on ? 99 : 255) * strength;
      }
    }
    return rgba;
  }
}
