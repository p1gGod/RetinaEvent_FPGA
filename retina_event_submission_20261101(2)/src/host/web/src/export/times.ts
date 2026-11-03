// 导出时间轴选择（WIRE-V3 任务判据"MP4 导出优先使用板端时间戳"）。
//
// 为什么抽成纯函数：选择规则有三种输入形态（全带板端时间 / 全不带 / 混合），
// 且"混合时整体回退"是个反直觉但必须钉死的决定 —— 两种时间基不能混在一条视频时间轴上：
// tMs 是 PC 墙钟（Date.now()），tBoardMs 是板端时钟换算到 PC 基准的毫秒
// （WIRE-V3 §4/§5，经 µs→ms 与校准 offset）。二者数值差距可能高达数小时（板子上电时长），
// 混用会让相邻帧间隔出现巨大的假停顿（被 mp4.ts 钳到 500 ms 也已经是错的节奏）。
//
// 所以规则是：
//   · 帧序列**每一帧**都有有限 tBoardMs → 全部用板端时间（优先路径）；
//   · 否则（缺一个就不行）→ 整体回退到达时刻 tMs，并告诉调用方时间来源，导出的
//     manifest 里写清楚（"时间戳来自哪里"必须可追溯，03 文档 §0 硬原则）。

export type ExportTimeSource = "board" | "arrival";

export interface ExportTimes {
  /** 每帧的导出时间戳（ms），下标与输入帧一一对应 */
  readonly timesMs: number[];
  readonly source: ExportTimeSource;
}

/** 一帧上可供导出的时间（RecordedFrame 的形状子集；纯数据便于单测） */
export interface TimedFrame {
  readonly tMs: number;
  readonly tBoardMs?: number;
}

function finite(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 为导出选时间轴：全部帧都带有限板端时间 → 用板端；否则整体回退到达时刻。
 * 输入为空数组时返回空 timesMs + "arrival"（没有帧就没有时间轴）。
 */
export function exportTimesMs(frames: readonly TimedFrame[]): ExportTimes {
  if (frames.length === 0) return { timesMs: [], source: "arrival" };
  const board = frames.map((f) => f.tBoardMs);
  if (board.every(finite)) {
    return { timesMs: board as number[], source: "board" };
  }
  const arrival: number[] = [];
  for (const f of frames) {
    // 逐帧兜底：tMs 本身缺失/坏值时给 0（mp4.ts 的 frameGaps 会把非有限差值钳回固定节拍）
    arrival.push(finite(f.tMs) ? f.tMs : 0);
  }
  return { timesMs: arrival, source: "arrival" };
}
