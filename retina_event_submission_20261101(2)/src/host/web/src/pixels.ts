// 像素工具：RGB565 解码直接复用 @retina/protocol（原则 P1：编解码只写一份）。
// 本文件只补协议层没有、而前端渲染/检测需要的东西：BT.601 亮度（与 RTL 同算式）。
export { decodeRgb565, byteOrderOf } from "@retina/protocol";

/** ITU-R BT.601 亮度，与 RTL 及离线脚本同一算式：Y = (77R + 150G + 29B) >> 8 */
export function luma601(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

/** 单像素亮度（检测器用）：直接读 RGBA 缓冲，避免为一行像素额外分配数组 */
export function lumaAtRgba(rgba: Uint8ClampedArray, i: number): number {
  return luma601(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
}
