// 长录 CSV 格式（task-30 契约 §2.3）：8 列事件 / 3 列帧表，UTF-8 + CRLF。
// 为什么不用 JSON：events.csv 是给 annotator 与 Excel 直接吃的，行数可能上百万；
// CSV 追加写不会在崩溃时留下"半个 JSON"，已写完的行永远可解析。
import type { EventRecord, FramePacket } from "@retina/protocol";

/** events.csv 表头：与 web/src/export/csv.ts 的现成导出保持一致（用户已经习惯这 8 列） */
export const EVENTS_HEADER = "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts";

/** frames.csv 表头：frame_idx 是**本 chunk 内**成功写入 ffmpeg 的序号（0 起严格递增） */
export const FRAMES_HEADER = "frame_idx,t_board_ms,t_arrive_ms";

const CRLF = "\r\n";

function int(v: number): string {
  return Number.isFinite(v) ? String(Math.trunc(v)) : "0";
}

/** 一行事件（不含 CRLF）：frame_idx 与 frame_t_ms 由调用方给出，保证同一帧的事件共用同一时间基 */
export function formatEventRow(recFrameIdx: number, frameTMs: number, ev: EventRecord): string {
  return [
    int(recFrameIdx),
    int(frameTMs),
    int(ev.x),
    int(ev.y),
    ev.pol === 1 ? "1" : "0",
    ev.pol === 1 ? "ON" : "OFF",
    int(ev.flags),
    int(ev.ts),
  ].join(",");
}

/** 一行帧表（不含 CRLF）：t_board_ms 缺失时用 t_arrive_ms 顶上，annotator 靠它排时间轴 */
export function formatFrameRow(recFrameIdx: number, tBoardMs: number | null | undefined, tArriveMs: number): string {
  return [int(recFrameIdx), int(tBoardMs ?? tArriveMs), int(tArriveMs)].join(",");
}

/** 该帧事件的统一时间基：板端时间戳优先，v2 包没有 tBoardMs 时退回本机到达时间 */
export function frameTimeBase(f: FramePacket): number {
  return f.tBoardMs ?? f.tArriveMs;
}

/** 便于测试/调用方拿到完整 CSV 文本（录制器本身用 WriteStream 追加，不整文件拼接） */
export function buildChunkCsv(
  frames: readonly { recFrameIdx: number; tBoardMs: number | null | undefined; tArriveMs: number; events: readonly EventRecord[] }[],
): { framesCsv: string; eventsCsv: string } {
  const frameLines: string[] = [FRAMES_HEADER];
  const eventLines: string[] = [EVENTS_HEADER];
  for (const f of frames) {
    frameLines.push(formatFrameRow(f.recFrameIdx, f.tBoardMs, f.tArriveMs));
    const t = f.tBoardMs ?? f.tArriveMs;
    for (const ev of f.events) eventLines.push(formatEventRow(f.recFrameIdx, t, ev));
  }
  return {
    framesCsv: frameLines.join(CRLF) + CRLF,
    eventsCsv: eventLines.join(CRLF) + CRLF,
  };
}
