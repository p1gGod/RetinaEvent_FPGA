// 极简 PNG 编码器（纯 JS + node:zlib，零原生模块）。
//
// 为什么自己写而不是引 sharp/pngjs：上位机有一条硬纪律「零原生模块」——
// 那是为了让 SEA 单 exe 能打出来（04 文档 §11，实测 exe 87.7 MB / 启动 314 ms）。
// PNG 的编码格式本身很简单（IHDR + zlib 压缩的扫描行 + IEND），不值得为此破例。
//
// 只做一种最通用的形态：8 bit、RGBA、无隔行、filter 全 0。
// 浏览器/图像库/Python PIL 都能直接打开。
import { deflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 输入：RGBA8、行优先、长度必须 = w*h*4 */
export function encodePngRgba(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Buffer {
  if (w <= 0 || h <= 0) throw new Error("PNG: 宽高必须为正");
  if (rgba.length !== w * h * 4) throw new Error("PNG: 像素缓冲长度 " + rgba.length + " ≠ w*h*4 = " + w * h * 4);
  const stride = w * 4;
  // 每行前面加一个 filter 字节（0 = None）。PNG 要求这个字节，且逐行都要有。
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * 盒式降采样到指定宽度（保持宽高比，高度取偶数对齐）。
 * 用途：`/api/frame.png?w=400` —— 其他 agent 拉图时往往不需要全分辨率，
 * 400 宽的 PNG 比 800 宽的小 3~4 倍，够看清画面内容。
 */
export function downscaleRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  targetW: number,
): { rgba: Uint8ClampedArray; w: number; h: number } {
  const outW = Math.max(1, Math.min(w, Math.round(targetW)));
  if (outW === w) return { rgba: rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), w, h };
  const outH = Math.max(1, Math.round((h * outW) / w));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = w / outW;
  const sy = h / outH;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const i = (yy * w + xx) * 4;
          r += rgba[i] as number;
          g += rgba[i + 1] as number;
          b += rgba[i + 2] as number;
          n++;
        }
      }
      const o = (y * outW + x) * 4;
      out[o] = Math.round(r / Math.max(1, n));
      out[o + 1] = Math.round(g / Math.max(1, n));
      out[o + 2] = Math.round(b / Math.max(1, n));
      out[o + 3] = 255;
    }
  }
  return { rgba: out, w: outW, h: outH };
}
