// 事件-only 录制帧：串口 UART-LINK（EV_NO_RAW）与板端 EVENT 档都**不发 FRAME_RAW**，
// 但事件流/检测框仍然完整。以前这类包在 handleEvents 里 apply 完就直接 return，
// 从没进 recorder，于是"录制中"却 0 帧、5 个导出按钮全灰（2026-10-18 用户报障）。
//
// 这里集中构造这种帧，而不是在 main.ts 里内联一个对象字面量：
//   · hasRaw:false 是导出能力的唯一开关，必须只有一处定义；
//   · raw 恒为空且共享同一块 0 字节缓冲（Recorder 不会复制、不会计费）；
//   · pixel 字段只是 RecordedFrame 的必填占位 —— 像素类导出按 hasRaw=false 禁用，
//     永远不会有人把它当真正的 RGB565 读。
import type { EventRecord } from "@retina/protocol";
import type { RecordedFrame } from "./export/framebin.ts";

const EMPTY_RAW = new Uint8Array(0);

export interface EventOnlyFrameArgs {
  readonly frameIdx: number;
  /** 到达时刻（Date.now()），与 handleFrame 的 tMs 同一时间基 */
  readonly tMs: number;
  readonly w: number;
  readonly h: number;
  readonly events: readonly EventRecord[];
}

/**
 * 整段缓冲是否**全部**带原始像素。
 *
 * 为什么不是"任意一帧有像素"：PNG/MP4/.bin 导出的是整段缓冲（或整段选区），
 * 混入一帧事件-only 就必然在导出中途缺一张图/一帧视频。这里用 every 保守置灰，
 * 让按钮状态与 runExport 的行为一致，而不是"能点，点了才弹提示"。
 */
export function allFramesHaveRaw(frames: readonly RecordedFrame[]): boolean {
  return frames.every((f) => f.hasRaw !== false);
}

/** 构造一帧"只有事件、没有像素"的录制结果 */
export function eventOnlyRecordedFrame(args: EventOnlyFrameArgs): RecordedFrame {
  return {
    frameIdx: args.frameIdx,
    tMs: args.tMs,
    w: args.w,
    h: args.h,
    pixel: "RGB565_LE",
    raw: EMPTY_RAW,
    hasRaw: false,
    events: args.events,
    detections: [],
  };
}
