// 板端读回状态 → 界面文案的**唯一**映射（板端实现报告 §3.3：TLV 0x8D / 0x8E / 0x8F；
// sccb 集成报告 §9.2 增补：TLV 0x90 EXP_CAP_STATE）。
//
// 为什么单独一个文件：这些"枚举 → 人话"的翻译散在 DOM 代码里就没法测（侧栏是闭包，Node 里没有 DOM）。
// 而联板时最怕的恰恰是"板端发的是 2（UNKNOWN），界面显示成 UP"这类翻译错误 ——
// 那会让排障方向完全反掉（明明是"网口状态还没首判"，看起来却像"网口正常"）。
import type { V3SerStateView } from "@retina/protocol";
import { CTRL } from "@retina/protocol";

/** EV_RES 值 → 文案（TLV 0x8D，len1；对应下行 tag 0x07） */
const EV_RES_LABEL: Readonly<Record<number, string>> = { 0: "全分辨率", 1: "÷2", 2: "÷4" };
/** SER_AGG 值 → 文案（TLV 0x8E 第 2 字节；对应下行 tag 0x09） */
const SER_AGG_LABEL: Readonly<Record<number, string>> = { 0: "RAW", 1: "GRID 8×6", 2: "GRID 16×12" };

/** TLV 0x8D EV_RES_STATE → 文案；null = 板端未上报 */
export function evResText(n: number | null): string {
  if (n === null) return "—";
  return EV_RES_LABEL[n] ?? "未定义(" + n + ")";
}

/** TLV 0x8E SER_STATE → 文案；null = 板端未上报 */
export function serStateText(s: V3SerStateView | null): string {
  if (s === null) return "—";
  return "DECIM=" + s.decim + " " + (SER_AGG_LABEL[s.agg] ?? "AGG=" + s.agg) + " 丢=" + s.uartEvDrop;
}

/** TLV 0x8F NET_STATE → 文案（0=DOWN / 1=UP / 2=UNKNOWN；null = 板端未上报） */
export function netStateText(n: number | null): string {
  if (n === null) return "—";
  if (n === CTRL.NET_STATE.UP) return "UP";
  if (n === CTRL.NET_STATE.DOWN) return "DOWN";
  if (n === CTRL.NET_STATE.UNKNOWN) return "UNKNOWN";
  return "未定义(" + n + ")";
}

/**
 * TLV 0x90 EXP_CAP_STATE → 文案（sccb 集成报告 §9.2）：行数 + 十六进制（与 SCCB 寄存器口径可直接对照）。
 * null = 板端未上报（心跳不含本 TLV；旧固件也没有）—— 显示"—"，绝不猜一个值顶上去。
 * 0xXXXX 后缀是给 E0~E6 实测用的：档位表（sccb 集成报告 §8.1）里的 cap 就是按 hex 记的（0x1710 / 0x02EA …）。
 */
export function expCapText(n: number | null): string {
  if (n === null) return "—";
  return String(n) + "（0x" + n.toString(16).toUpperCase().padStart(4, "0") + "）";
}
