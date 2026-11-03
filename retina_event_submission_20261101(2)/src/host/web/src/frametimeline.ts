// FRAME_RAW → 录制帧的"板端时间字段"装配点（F4，2026-10-13）。
//
// 为什么单独抽一个纯函数：这是 WS 载荷时间轴进入录制缓冲的**唯一**装配点，
// 而 main.ts 是 DOM 入口（单测跑不起来）⇒ 抽出来才能把"有则带上、无则缺省"
// 钉成机器判据 —— 否则又会重演 F4：字段在网关就丢了，前端全帧 layoutVer=0 却没人发现。
// 入参形状刻意不绑定 IpcFrameRaw（FramePacket 也能传）：只要求"可能带 tBoardMs"。

/**
 * 录制帧要展开的板端时间字段：
 *   · 有 tBoardMs（IPC layoutVer≥1，且为有限值）→ `{ tBoardMs }`；
 *   · 无（v2 帧 / TS_VALID=0 / 坏值）→ `{}`（键都不出现，禁止给 null/NaN 冒充）。
 *
 * 调用方按 `...boardTimeOf(m)` 展开。下游导出侧按"每一帧都有有限值才用板端轴"整体择源
 * （web/src/export/times.ts）：缺一就整体回退到达时刻，**不许把两种时间基混在一条时间轴上**。
 */
export function boardTimeOf(m: { readonly tBoardMs?: number | undefined }): { readonly tBoardMs?: number } {
  if (m.tBoardMs === undefined || !Number.isFinite(m.tBoardMs)) return {};
  return { tBoardMs: m.tBoardMs };
}
