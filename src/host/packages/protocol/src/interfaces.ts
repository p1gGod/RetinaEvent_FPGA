// 五个扩展插槽（05 文档 §0）。SPI v1 冻结候选：只允许"加可选字段/加新方法"。
// 这里的接口是给"未来接 YOLO/CNN/视频导出"用的正式入口。
import type { FramePacket, SourceStats, EventBatch, Counters } from "./types.ts";

export type Unsubscribe = () => void;

export interface SourceInfo {
  readonly wire: "STREAM" | "LEGACY" | "TELEM";
  readonly profile: string;
  readonly geometry: { readonly w: number; readonly h: number };
  readonly evRecBytes: number;
}
export interface SourceError { readonly code: string; readonly message: string; readonly fatal: boolean }

/** L0 数据源插槽：UDP / 串口 / 回放 / 合成 四种实现必须行为等价（原则 P4） */
export interface IFrameSource {
  readonly spiVersion: 1;
  readonly info: SourceInfo;
  start(): void;
  stop(): void;
  on(evt: "frame", cb: (p: FramePacket) => void): Unsubscribe;
  on(evt: "events", cb: (e: EventBatch) => void): Unsubscribe;
  on(evt: "stats", cb: (s: SourceStats, c: Counters) => void): Unsubscribe;
  on(evt: "error", cb: (e: SourceError) => void): Unsubscribe;
}

/** L1 协议插槽：一种线格式一个实现（v2 / v1 / telem） */
export interface ICodec<TParsed> {
  readonly name: string;
  parse(buf: Uint8Array): { readonly ok: true; readonly value: TParsed } | { readonly ok: false; readonly reason: keyof Counters; readonly detail?: string };
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly input: "raw" | "event" | "overlay";
  readonly caps: readonly ("gpu" | "wasm" | "sidecar" | "disk")[];
  readonly budgetMs: number;
  readonly outputKinds: readonly DerivedLayer["kind"][];
}

/** L2 后处理插槽：CNN / YOLO / OpenCV / 自定义 JS 都实现它 */
export interface IPostProcessor {
  readonly spiVersion: 1;
  readonly manifest: PluginManifest;
  warmup(ctx: PluginContext): Promise<void>;
  process(frame: FramePacket, ctx: PluginContext): Promise<DerivedLayer[]>;
  dispose(): void;
}

export interface PluginContext {
  readonly hasGPU: boolean;
  readonly nowMs: () => number;
  resolveAsset(name: string): string;
  readonly log: (msg: string) => void;
}

/** 插件唯一允许的输出：图层（永不修改原始帧，原则 P2 / E5） */
export interface DerivedLayer {
  readonly kind: "boxes" | "mask" | "heatmap" | "labels" | "image";
  readonly z: number;
  readonly blend: "normal" | "screen" | "multiply" | "add";
  readonly opacity: number;
  draw(ctx: CanvasRenderingContext2D): void;
  readonly meta?: unknown;
}

export interface ExportJob {
  readonly source: "frameRing" | "eventRing" | "derived";
  readonly range: { readonly fromMs: number; readonly toMs: number };
  readonly layers: readonly number[];
  readonly format: Readonly<Record<string, unknown>>;
  readonly targetDir: string;
}
export interface ProgressSink { readonly onProgress: (done: number, total: number) => void }
export interface ExportResult { readonly files: readonly string[]; readonly bytes: number; readonly warnings: readonly string[] }

/** L2 导出插槽：视频 / 图集 / 原始数据走同一 job 模型 */
export interface IExporter {
  readonly spiVersion: 1;
  readonly id: string;
  readonly exts: readonly string[];
  readonly supports: { readonly range: boolean; readonly audio: boolean; readonly lossless: boolean };
  export(job: ExportJob, sink: ProgressSink): Promise<ExportResult>;
}

/** L2 录制插槽：环形缓冲（实时与回放共用渲染链，原则 P4） */
export interface IRecorder {
  readonly spiVersion: 1;
  start(opts: { readonly frameSec: number; readonly evSec: number; readonly spillToDisk: boolean }): void;
  stop(): void;
  readonly state: { readonly recording: boolean; readonly frameCount: number; readonly bytes: number; readonly oldestMs: number };
}
