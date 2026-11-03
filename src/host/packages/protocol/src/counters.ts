// 计数器与帧号工具：小但必须共用（否则前后端统计口径会不一致）
import { COUNTER_KEYS } from "./constants.ts";
import type { Counters } from "./types.ts";

export function createCounters(): Counters {
  const c = {} as Record<string, number>;
  for (const k of COUNTER_KEYS) c[k] = 0;
  return c as Counters;
}

export function bump(c: Counters, key: keyof Counters, by = 1): Counters {
  (c as Record<string, number>)[key] = ((c as Record<string, number>)[key] ?? 0) + by;
  return c;
}

export function countersTotal(c: Counters): number {
  let s = 0;
  for (const k of COUNTER_KEYS) s += c[k];
  return s;
}

/**
 * 帧号步长（处理 16bit 回绕）：返回 >=0 的模差。
 * 02 文档 §2.7：不能直接相减；3.3 fps 下约 5.5 小时回绕一次。
 */
export function gapOf(prev: number | null, next: number): number {
  if (prev === null) return 0;
  return (next - prev + 0x10000) & 0xffff;
}

/** 逻辑帧号展开：把 16bit 帧号变成单调递增的 64bit 安全整数（前端画时间轴用） */
export class FrameIndexUnwrapper {
  private last = -1;
  private wraps = 0;
  private seq = 0;
  push(raw: number): { readonly seq: number; readonly wraps: number; readonly gap: number } {
    const gap = this.last < 0 ? 0 : gapOf(this.last, raw);
    if (this.last >= 0 && raw < this.last) this.wraps++;
    this.last = raw;
    this.seq += gap;
    return { seq: this.seq, wraps: this.wraps, gap };
  }
}
