// EV_DATA → EventRecord[]（02 文档 §2.4）
// 两种布局都支持：
//   byte-aligned（默认，README/02 §2.4 表）：[X_LO][bit0=X8][Y][bit0=POL,其余保留][TS8?]
//   bitpacked-le：v = 小端累积的 recBytes 字节；x=v[8:0], y=v[16:9], pol=v[17], 其余保留
// 记录长度参数化 + 余数丢弃（判据 P5）+ 保留位忽略（P6）—— 三者缺一不可。
import type { EventRecord } from "../types.ts";

export type EvLayout = "byte-aligned" | "bitpacked-le";

export interface DecodedEvents {
  readonly records: readonly EventRecord[];
  readonly partialBytes: number;
  readonly raw: Uint8Array;
}

export function decodeEvents(data: Uint8Array, recBytes: number, layout: EvLayout = "byte-aligned"): DecodedEvents {
  const rb = Math.max(3, Math.min(8, Math.floor(recBytes)));
  const count = Math.floor(data.length / rb);
  const partialBytes = data.length - count * rb;
  const records: EventRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * rb;
    if (layout === "bitpacked-le") {
      let v = 0;
      for (let k = 0; k < rb; k++) v += (data[o + k] as number) * 2 ** (8 * k);   // 用乘加避免 32bit 位移溢出
      const x = v % 0x200;                    // v[8:0]
      const y = Math.floor(v / 0x200) % 0x100; // v[16:9]
      const pol = Math.floor(v / 0x20000) % 2;
      const resv = Math.floor(v / 0x40000);    // v[18+] 保留位
      records.push({ x, y, pol: pol === 1 ? 1 : 0, flags: resv & 0xff, ts: 0 });
    } else {
      const x = (data[o] as number) | (((data[o + 1] as number) & 0x01) << 8);
      const y = rb >= 3 ? (data[o + 2] as number) : 0;
      const polByte = rb >= 4 ? (data[o + 3] as number) : 0;
      const ts = rb >= 5 ? (data[o + 4] as number) : 0;
      // 保留位原样带出但不解释（P6）；x 的高 7 位、POL 除 bit0 外的位都不参与语义
      const flags = ((data[o + 1] as number) & 0xfe) | ((polByte & 0xfe) << 7);
      records.push({ x, y, pol: (polByte & 0x01) === 1 ? 1 : 0, flags: flags & 0xffff, ts });
    }
  }
  return { records, partialBytes, raw: data };
}

/**
 * EventRecord[] → EV_DATA 字节（decodeEvents 的逆）。
 *
 * 为什么放在协议包而不是网关里：板端发的事件与**上位机自己算出来的**事件
 * 必须编成**同一种字节**，前端才能用同一条解码路径、同一套图层去画。
 * 两边各写一个编码器迟早会漂移（这正是"协议只有一份实现"要避免的）。
 *
 * 布局与 decodeEvents 的 byte-aligned 分支严格互逆（5B 记录时）：
 *   b0 = X[7:0] | b1 = {7'b0, X[8]} | b2 = Y[7:0] | b3 = {7'b0, POL} | b4 = TS8
 */
export function encodeEvents(
  records: readonly EventRecord[],
  recBytes = 5,
  layout: EvLayout = "byte-aligned",
): Uint8Array {
  const rb = Math.max(3, Math.min(8, Math.floor(recBytes)));
  const out = new Uint8Array(records.length * rb);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r === undefined) continue;
    const o = i * rb;
    if (layout === "bitpacked-le") {
      let v = (r.x & 0x1ff) + (r.y & 0xff) * 0x200 + (r.pol === 1 ? 0x20000 : 0);
      for (let k = 0; k < rb; k++) {
        out[o + k] = v & 0xff;
        v = Math.floor(v / 256);
      }
      continue;
    }
    out[o] = r.x & 0xff;
    if (rb >= 2) out[o + 1] = (r.x >> 8) & 0x01;
    if (rb >= 3) out[o + 2] = r.y & 0xff;
    if (rb >= 4) out[o + 3] = r.pol & 0x01;
    if (rb >= 5) out[o + 4] = r.ts & 0xff;
  }
  return out;
}
