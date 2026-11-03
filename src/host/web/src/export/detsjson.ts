// 检测结果（.json）：给外部脚本/标注工具消费的结构化结果。
//
// 为什么和像素分开：像素是 .bin 的事（几百 MB，只适合流式读），
// 检测框只有几十 KB，塞进 JSON 才能被 notebook 里 `json.load` 一眼看懂。
// 所以这里**绝不含像素**，也不含 events（事件有自己的 .csv）。
//
// 缩进用 1 空格而不是 2：字段名短、嵌套浅，1 空格已经一行一字段便于 diff，
// 而 2 空格会让 600 帧的文件体积接近翻倍 —— 这些文件经常要贴进 issue/邮件里。

import type { RecordedFrame } from "./framebin.ts";

const DETSJSON_VERSION = 1;

interface DetectionJson {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly score: number;
}

interface FrameJson {
  readonly frameIdx: number;
  readonly tMs: number;
  readonly detections: readonly DetectionJson[];
}

/**
 * 导出检测框。
 *
 * 逐字段重建而不是直接 `JSON.stringify(frames)`：RecordedFrame 里带着
 * `raw`（768 KB/帧）和 `events`，直接序列化会把几百 MB 像素写成十进制数字塞进 JSON
 * —— 既撑爆内存，也违背"JSON 只放元数据"的约定。所以这里显式挑字段。
 * 空检测的帧也保留（`detections: []`）：下游按 frameCount 对齐时间轴时，
 * 缺帧和"这帧确实没检测到"是两件完全不同的事。
 */
export function buildDetectionsJson(frames: readonly RecordedFrame[]): string {
  const out = {
    version: DETSJSON_VERSION,
    createdAt: new Date().toISOString(),
    frameCount: frames.length,
    frames: frames.map(
      (f): FrameJson => ({
        frameIdx: f.frameIdx,
        tMs: f.tMs,
        detections: f.detections.map(
          (d): DetectionJson => ({ x: d.x, y: d.y, w: d.w, h: d.h, label: d.label, score: d.score }),
        ),
      }),
    ),
  };
  return JSON.stringify(out, null, 1);
}
