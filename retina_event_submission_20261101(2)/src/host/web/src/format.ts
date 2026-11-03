// 数字格式化：所有数字走同一处（03 文档 §4"统一千分位/单位/有效位"）
// 为什么集中：原型里出现过 "3.31" 与 "3.310" 混用，评审一眼就看出是两个地方各写各的。

/** 千分位整数（用普通空格分组，与设计稿 "1 238 402" 一致） */
export function fmtInt(n: number): string {
  const s = Math.round(Number.isFinite(n) ? n : 0).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 固定小数位；非有限值统一显示 "—"（不让 NaN 上屏） */
export function fmtFixed(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/** 自动 k/M 单位；返回数值与单位两段，方便大数字/小单位分开排版 */
export function fmtScale(n: number, digits = 1): { v: string; u: string } {
  if (!Number.isFinite(n)) return { v: "—", u: "" };
  if (Math.abs(n) >= 1e9) return { v: (n / 1e9).toFixed(digits), u: "G" };
  if (Math.abs(n) >= 1e6) return { v: (n / 1e6).toFixed(digits), u: "M" };
  if (Math.abs(n) >= 1e3) return { v: (n / 1e3).toFixed(digits), u: "k" };
  return { v: n.toFixed(digits), u: "" };
}

/** 字节数：B / KB / MB / GB（1024 进制，和内存统计口径一致） */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return Math.round(n) + " B";
}
