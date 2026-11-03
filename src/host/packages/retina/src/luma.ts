// 亮度链路：RGB565 → 8bit 亮度 → 对数压缩（逐位同构 RTL 的 px_luma.v + luma_log.v）
//
// ⚠️ 移植时最容易错的两处（都已按 RTL 实测校准，不要"顺手改成更合理的写法"）：
//   1) 分量扩展是**位复制**，不是简单左移：r8 = {r5, r5[4:2]}，g8 = {g6, g6[5:4]}，b8 = {b5, b5[4:2]}。
//      左移会把 5bit 的最大值扩成 0xF8 而不是 0xFF，白点亮度直接差 7。
//   2) 求和后取**高字节**（`sum[15:8]`）= 向下截断，**没有四舍五入、没有饱和**。
//      系数和恰为 256，所以 sum 最大 255*256 = 0xFF00 ⇒ 高字节正好 255，不会溢出。

/** 5bit → 8bit（位复制填充低位） */
export function expand5to8(v: number): number {
  const x = v & 0x1f;
  return ((x << 3) | (x >> 2)) & 0xff;
}
/** 6bit → 8bit（位复制填充低位） */
export function expand6to8(v: number): number {
  const x = v & 0x3f;
  return ((x << 2) | (x >> 4)) & 0xff;
}

/**
 * RGB565（16bit，已按高字节在前拼好）→ 8bit 亮度。
 * 系数 77/150/29（和 = 256），结果取高字节。
 */
export function lumaFromRgb565(px: number): number {
  const r8 = expand5to8((px >> 11) & 0x1f);
  const g8 = expand6to8((px >> 5) & 0x3f);
  const b8 = expand5to8(px & 0x1f);
  return (77 * r8 + 150 * g8 + 29 * b8) >> 8;
}

/**
 * 对数压缩查找表：L = min(255, round(255 * log2(1 + Y/255)))，共 256 项。
 *
 * 为什么尺度是 255 而不是 256（原理文档用的是 256，**已确认是旧口径**）：
 * 尺度取 255 时 Y=255 → L=255，满量程对得上；取 256 时 Y=255 → L=255.0 但中间值会整体偏大。
 * 实测：本式与 RTL 的 rom 全 256 项**零差异**（subagent 逐项比对）。
 * 阈值 θ=74 LSB 换算成自然对数域就是 74/255×ln2 ≈ 0.2012。
 */
export const LUMA_LOG: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let y = 0; y < 256; y++) {
    const v = Math.round(255 * Math.log2(1 + y / 255));
    t[y] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return t;
})();

/** 便捷：RGB565 → 对数亮度（px_luma + luma_log 两级合起来） */
export function logLumaFromRgb565(px: number): number {
  return LUMA_LOG[lumaFromRgb565(px)] ?? 0;
}

/** 从"高字节在前"的字节流里取第 i 个像素（与 profile.pixel = RGB565_BE 一致） */
export function rgb565BeAt(raw: Uint8Array, i: number): number {
  return (((raw[2 * i] ?? 0) << 8) | (raw[2 * i + 1] ?? 0)) & 0xffff;
}
