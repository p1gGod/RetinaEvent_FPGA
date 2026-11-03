// RGB565 → RGBA8888：**逐像素**（不按字节），保证与板上/旧脚本同一约定。
// 默认高位在前（与 receive_lcd_eth.py 一致）；提供字节序开关（旧脚本的 --low-byte-first）。
import type { Profile } from "../types.ts";

export function decodeRgb565(raw: Uint8Array, rgba: Uint8ClampedArray, byteOrder: "BE" | "LE" = "BE"): void {
  const n = Math.min(Math.floor(raw.length / 2), Math.floor(rgba.length / 4));
  for (let i = 0; i < n; i++) {
    const a = raw[i * 2] as number;
    const b = raw[i * 2 + 1] as number;
    const px = byteOrder === "BE" ? (a << 8) | b : (b << 8) | a;
    const r5 = (px >> 11) & 0x1f;
    const g6 = (px >> 5) & 0x3f;
    const b5 = px & 0x1f;
    rgba[i * 4] = (r5 << 3) | (r5 >> 2);
    rgba[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
    rgba[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
    rgba[i * 4 + 3] = 255;
  }
}

export function byteOrderOf(p: Profile): "BE" | "LE" {
  return p.frame.pixel === "RGB565_LE" ? "LE" : "BE";
}
