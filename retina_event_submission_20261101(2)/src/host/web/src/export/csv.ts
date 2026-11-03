// 事件表（.csv）：给 Excel / pandas 直接看的平面表。
//
// 为什么行尾用 \r\n 而不是 \n：Excel（尤其是中文版双击打开的路径）对纯 \n 的容忍度很差，
// 常见表现是"整个文件挤成一行"或"列名带了一个看不见的字符"，用户会以为导出坏了。
// RFC 4180 本来就规定 CRLF，所以这里跟着规范走，顺便满足 Excel。
// 行尾统一收在每行末尾（含最后一行），下游按 split 得到的是规整的行数组，
// 不会出现"最后一行没有换行符"这种特例分支。
//
// 列是固定的 8 列（frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts）：
// pol 给出机器可读的 0/1，pol_name 给出人可读的 ON/OFF —— 只给一种，总有一边要现场换算。
// 字段全是数字和固定枚举，不含引号/逗号，所以不做 RFC 4180 的引号转义。

import type { RecordedFrame } from "./framebin.ts";

const HEADER = "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts";
const CRLF = "\r\n";

/**
 * 扁平化所有帧的事件。
 *
 * 没有事件时也要输出表头：下游脚本（pandas.read_csv / Excel）靠表头定列，
 * 空文件会让"这次录制真的没有事件"和"导出失败"看起来一模一样。
 */
export function buildEventsCsv(frames: readonly RecordedFrame[]): string {
  const lines: string[] = [HEADER];
  for (const f of frames) {
    for (const ev of f.events) {
      lines.push(
        `${f.frameIdx},${f.tMs},${ev.x},${ev.y},${ev.pol},${ev.pol === 1 ? "ON" : "OFF"},${ev.flags},${ev.ts}`,
      );
    }
  }
  return lines.join(CRLF) + CRLF;
}
