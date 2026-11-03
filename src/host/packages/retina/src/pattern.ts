// 合成图案源 —— 逐位复现 RTL 的 `vps_pattern_gen.v`（无摄像头时的自检 VPS）。
//
// 为什么上位机也要有这一份：RTL 的 golden 数字（F3=5841 等）全部建立在这套图案上。
// 要用 RTL 的真实产出来验证上位机算法，两边就必须吃**同一个输入**——
// 否则"数字对不上"时根本分不清是算法移植错了还是输入不一样。
//
// RTL 事实（照抄，别改）：
//   · 扫描 x_cnt 0..1055 / y_cnt 0..524，de = (x_cnt<800)&&(y_cnt<480)
//     ⇒ 可见区内 x_cnt = x、y_cnt = y，所以可直接用像素坐标算。
//   · lum 是 8bit 灰度，再复制成 RGB565：px565 = {lum[7:3], lum[7:2], lum[7:3]}。
//     ⚠️ 是"取高位"不是"乘系数"，所以 lum=0x80(=128) 得到 0x8410 → 亮度 Y=130（不是 81）。
//   · 帧计数 frame_cnt 每 1056×525 拍 +1（FRAME_DIV=1），方块位置 bx = 100 + frame_cnt[7:0]。
//   · MODE3 的 lum 是 8'h80 = 128（RTL 头注释写 "80" 少了 0x 前缀，是注释问题）。

export const PATTERN = {
  /** 水平斜坡 lum = x[9:2] */
  RAMP: 0,
  /** 棋盘 lum = (x[4]^y[4]) ? FF : 00（相机 16×16 ⇒ 事件 8×8） */
  CHECKER: 1,
  /** 运动方块：64×64，x∈[bx,bx+64)、y∈[200,264)，块内 FF、块外 20 */
  BLOCK: 2,
  /** 均匀场 lum = 80h = 128（静态） */
  UNIFORM: 3,
} as const;

export type PatternMode = (typeof PATTERN)[keyof typeof PATTERN];

/** 8bit 灰度 → RGB565（RTL 的复制打包） */
export function grayToRgb565(lum: number): number {
  const l = lum & 0xff;
  const r5 = (l >> 3) & 0x1f;
  const g6 = (l >> 2) & 0x3f;
  const b5 = (l >> 3) & 0x1f;
  return ((r5 << 11) | (g6 << 5) | b5) & 0xffff;
}

/** 方块左边界（RTL：bx = 100 + frame_cnt[7:0]，11bit 截断） */
export function blockX(frameCnt: number): number {
  return (100 + (frameCnt & 0xff)) & 0x7ff;
}

/** 生成一帧图案的灰度值（可见区内 x∈[0,w)、y∈[0,h)） */
export function patternLum(mode: PatternMode, x: number, y: number, frameCnt: number): number {
  switch (mode) {
    case PATTERN.RAMP:
      return (x >> 2) & 0xff;
    case PATTERN.CHECKER:
      return ((((x >> 4) & 1) ^ ((y >> 4) & 1)) !== 0) ? 0xff : 0x00;
    case PATTERN.BLOCK: {
      const bx = blockX(frameCnt);
      const inBlock = x >= bx && x < bx + 64 && y >= 200 && y < 264;
      return inBlock ? 0xff : 0x20;
    }
    case PATTERN.UNIFORM:
    default:
      return 0x80;
  }
}

/** 生成一帧图案的 RGB565 像素数组（行优先，w×h） */
export function patternFrame565(
  mode: PatternMode,
  frameCnt: number,
  w = 800,
  h = 480,
): Uint16Array {
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) out[base + x] = grayToRgb565(patternLum(mode, x, y, frameCnt));
  }
  return out;
}

/**
 * `tb_retina_core` 的图案序列（复现它的 golden 数字时必须按这个来）。
 * 返回 pattern frame 号 → 该帧的模式与 frame_cnt。
 *
 * tb 实际切换点（tb_retina_core.v）：
 *   起始 = PM_CHK（棋盘）；图案帧 3 起 = PM_UNIF；图案帧 7 起 = PM_BLOCK；图案帧 13 = PM_UNIF。
 */
export function tbPatternSequence(frameNo: number): { mode: PatternMode; frameCnt: number } {
  const frameCnt = frameNo;
  if (frameNo <= 2) return { mode: PATTERN.CHECKER, frameCnt };
  if (frameNo <= 6) return { mode: PATTERN.UNIFORM, frameCnt };
  if (frameNo <= 12) return { mode: PATTERN.BLOCK, frameCnt };
  return { mode: PATTERN.UNIFORM, frameCnt };
}
