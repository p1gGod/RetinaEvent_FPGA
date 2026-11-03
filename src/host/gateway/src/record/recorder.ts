// 长录会话（task-30）：把 v2/v3 数据源的完整帧写进 fragmented MP4，同时落事件/帧表 CSV。
//
// 关键口径（不可随意改，annotator 与 M5 验收都依赖它）：
// - 每个 chunk 内 frame_idx 从 0 起，**只统计成功交给 ffmpeg 的帧**，严格 +1；
//   annotator 的 videoFrame 就是该值（videoTime = frame_idx / fpsNominal）。
// - 跨 chunk 重置编号：每份 frames.csv 内部严格递增，份与份之间不做全局单调。
// - 录制不受浏览器连接/paused/slowFrameDrop 影响；切源后继续录（IpcHub 会重新 attachSource）。
// - 分段正常关闭先把 .recording.mp4 转封装成 .video.mp4 再删碎片；崩溃残留的 .recording.mp4 不清理。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { EventBatch, FramePacket, IFrameSource, Profile } from "@retina/protocol";
import { EVENTS_HEADER, FRAMES_HEADER, formatEventRow, formatFrameRow, frameTimeBase } from "./csv.ts";
import { FfmpegEncoder, sealRecording, type FfmpegFinishResult } from "./ffmpeg.ts";

export const DEFAULT_RECORD_ROOT = path.resolve(import.meta.dirname, "../../../../../records");
export const FPS_NOMINAL = 30;
const CSV_CRLF = "\r\n";

export interface RecorderCounters {
  frames: number;
  events: number;
  droppedFrames: number;
  droppedEvents: number;
  bytes: number;
}

export interface RecorderChunkView {
  readonly index: number;
  readonly video: string;
  readonly events: string;
  readonly frames: string;
  readonly framesWritten: number;
  readonly eventsWritten: number;
  readonly fragBytes: number | null;
  readonly videoBytes: number | null;
  readonly finished: boolean;
  readonly sealError: string | null;
}

export interface RecorderStatus {
  readonly active: boolean;
  readonly session: string | null;
  readonly root: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly reason: string | null;
  readonly chunk: RecorderChunkView | null;
  readonly chunks: readonly RecorderChunkView[];
  readonly counters: RecorderCounters;
  readonly durationMs: number;
  /** 已封口 chunk 的 videoBytes 之和 + 当前 .recording.mp4 的实时体积（原始帧字节不计入） */
  readonly bytesVideo: number;
  /** 录制根盘的可用字节；来自周期性 statfs 的缓存，首次采样前为 null */
  readonly diskFreeBytes: number | null;
  readonly ffmpeg: {
    readonly path: string;
    readonly restarts: number;
    readonly lastError: string | null;
    readonly pending: number;
  };
}

export interface RecorderOptions {
  readonly profile: Profile;
  /** 会话根目录；默认 E:/workspace/FPGA_Comp/records */
  readonly root?: string | undefined;
  /** 分段时长（ms），默认 5 分钟 */
  readonly chunkMs?: number | undefined;
  readonly crf?: number | undefined;
  readonly encoder?: string | undefined;
  readonly ffmpegPath?: string | null | undefined;
  /** 单测注入假 ffmpeg 的参数前缀 */
  readonly ffmpegArgsPrefix?: readonly string[] | undefined;
  /** 额外写 chunk-00N.raw（调试用；默认关） */
  readonly rawDump?: boolean | undefined;
  /** stdin 背压队列上限（帧），默认 8 */
  readonly maxQueuedFrames?: number | undefined;
  readonly log?: ((msg: string) => void) | undefined;
  /** 注入时钟（单测用；默认 Date.now） */
  readonly now?: (() => number) | undefined;
  /** 注入剩余磁盘探测（单测用；默认 statfs） */
  readonly diskFreeBytes?: ((root: string) => Promise<number>) | undefined;
  readonly diskCheckMs?: number | undefined;
  readonly diskMinFreeBytes?: number | undefined;
}

/** start 时已在录：API 映射 409，而不是覆盖旧会话 */
export class RecorderBusyError extends Error {
  constructor(message = "已经在录制中") {
    super(message);
    this.name = "RecorderBusyError";
  }
}

interface ChunkState {
  readonly index: number;
  readonly dir: string;
  readonly base: string;
  readonly fragPath: string;
  readonly videoPath: string;
  readonly eventsName: string;
  readonly framesName: string;
  readonly eventsPath: string;
  readonly framesPath: string;
  readonly eventsStream: fs.WriteStream;
  readonly framesStream: fs.WriteStream;
  readonly rawStream: fs.WriteStream | null;
  readonly encoder: FfmpegEncoder;
  startedAtMs: number;
  nextIdx: number;
  framesWritten: number;
  eventsWritten: number;
  fragBytes: number | null;
  videoBytes: number | null;
  sealError: string | null;
  finished: boolean;
  finishPromise: Promise<void> | null;
}

type DetailedCb = (b: EventBatch, frameIdx: number, seq: number, tArriveMs: number, evOnly?: boolean) => void;

function zeroCounters(): RecorderCounters {
  return { frames: 0, events: 0, droppedFrames: 0, droppedEvents: 0, bytes: 0 };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** 本地时间戳目录名（用户现场能一眼看出是哪天哪一档） */
export function sessionStamp(ms: number): string {
  const d = new Date(ms);
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1, 2),
    pad(d.getDate(), 2),
    "-",
    pad(d.getHours(), 2),
    pad(d.getMinutes(), 2),
    pad(d.getSeconds(), 2),
  ].join("");
}

/** label 只进目录名：去掉 Windows 非法字符，空/过长回退到 rec */
export function safeLabel(label: string | undefined): string {
  const raw = (label ?? "rec").trim();
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.+$/, "").slice(0, 40);
  return cleaned.length === 0 ? "rec" : cleaned;
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableEnded || stream.destroyed) {
      resolve();
      return;
    }
    stream.end(() => resolve());
  });
}

export class Recorder {
  private readonly profile: Profile;
  private readonly root: string;
  private readonly chunkMs: number;
  private readonly crf: number;
  private readonly encoderName: string;
  private readonly ffmpegPath: string;
  private readonly ffmpegArgsPrefix: readonly string[];
  private readonly rawDump: boolean;
  private readonly maxQueuedFrames: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly diskFree: ((root: string) => Promise<number>) | null;
  private readonly diskCheckMs: number;
  private readonly diskMinFreeBytes: number;
  private readonly frameBytes: number;
  private readonly frameW: number;
  private readonly frameH: number;

  private readonly countersState: RecorderCounters = zeroCounters();
  private readonly chunks: ChunkState[] = [];
  private current: ChunkState | null = null;
  private sessionDir: string | null = null;
  private sessionName: string | null = null;
  private startedAtMs: number | null = null;
  private endedAtMs: number | null = null;
  private reason: string | null = null;
  private active = false;
  private stopPromise: Promise<RecorderStatus> | null = null;
  private diskTimer: ReturnType<typeof setInterval> | null = null;
  private ffmpegRestarts = 0;
  private lastError: string | null = null;
  private readonly unsubs: Array<() => void> = [];
  private metaQueue: Promise<void> = Promise.resolve();
  private lastDropLogMs = 0;
  /** checkDisk 最近一次 statfs 的可用字节；status() 只读缓存，不再调 statfs */
  private lastDiskFreeBytes: number | null = null;

  constructor(opts: RecorderOptions) {
    if (opts.profile.frame.pixel !== "RGB565_BE") {
      throw new Error("录制只支持 RGB565_BE（profile " + opts.profile.name + " 是 " + opts.profile.frame.pixel + "）");
    }
    this.profile = opts.profile;
    this.root = path.resolve(opts.root ?? DEFAULT_RECORD_ROOT);
    this.chunkMs = Math.max(1000, Math.round(opts.chunkMs ?? 5 * 60 * 1000));
    this.crf = opts.crf ?? 23;
    this.encoderName = opts.encoder ?? "libx264";
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.ffmpegArgsPrefix = opts.ffmpegArgsPrefix ?? [];
    this.rawDump = opts.rawDump === true;
    this.maxQueuedFrames = opts.maxQueuedFrames ?? 8;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.diskFree = opts.diskFreeBytes ?? null;
    this.diskCheckMs = opts.diskCheckMs ?? 10000;
    this.diskMinFreeBytes = opts.diskMinFreeBytes ?? 1024 * 1024 * 1024;
    this.frameBytes = opts.profile.frame.bytes;
    this.frameW = opts.profile.frame.w;
    this.frameH = opts.profile.frame.h;
  }

  /** 订阅/重订阅数据源；切源时 IpcHub 会再次调用，旧订阅先退掉 */
  attachSource(source: IFrameSource): void {
    this.detachSource();
    this.unsubs.push(source.on("frame", (f: FramePacket) => this.onFrame(f)));
    const detailed = (source as { onEventsDetailed?: (cb: DetailedCb) => () => void }).onEventsDetailed;
    if (typeof detailed === "function") {
      this.unsubs.push(detailed.call(source, (b, _idx, _seq, t, evOnly) => this.onEventsDetailed(b, t, evOnly === true)));
    }
  }

  private detachSource(): void {
    for (const u of this.unsubs.splice(0)) {
      try { u(); } catch { /* 源可能已关闭 */ }
    }
  }

  async start(label?: string): Promise<RecorderStatus> {
    if (this.active) throw new RecorderBusyError();
    if (this.stopPromise !== null) await this.stopPromise;
    if (this.active) throw new RecorderBusyError();
    const started = this.now();
    await fsp.mkdir(this.root, { recursive: true });
    const dir = await this.createSessionDir(started, safeLabel(label));
    this.sessionDir = dir;
    this.sessionName = path.basename(dir);
    this.startedAtMs = started;
    this.endedAtMs = null;
    this.reason = null;
    this.ffmpegRestarts = 0;
    this.lastError = null;
    this.lastDropLogMs = 0;
    this.lastDiskFreeBytes = null;
    this.chunks.length = 0;
    this.current = null;
    Object.assign(this.countersState, zeroCounters());
    this.openChunk(0);
    this.active = true;
    this.startDiskTimer();
    try {
      await this.writeMeta();
    } catch (err) {
      this.lastError = "写 meta.json 失败: " + (err instanceof Error ? err.message : String(err));
      this.log("[record] " + this.lastError);
    }
    this.log("[record] 开始: " + dir);
    return this.status();
  }

  private async createSessionDir(started: number, label: string): Promise<string> {
    const base = sessionStamp(started) + "_" + label;
    for (let i = 0; i < 100; i++) {
      const name = i === 0 ? base : base + "-" + pad(i, 2);
      const dir = path.join(this.root, name);
      try {
        await fsp.mkdir(dir);
        return dir;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
      }
    }
    throw new Error("同名录制目录过多: " + base);
  }

  /**
   * 开启一个 chunk（同步：持锁构建流/子进程，避免轮转时丢帧）。
   * 文件打开错误会通过流 error 事件记录，不阻塞后续帧。
   */
  private openChunk(index: number, startedAtMs = this.now()): void {
    const dir = this.sessionDir;
    if (dir === null) throw new Error("内部错误：sessionDir 尚未建立");
    const base = "chunk-" + pad(index, 3);
    const fragPath = path.join(dir, base + ".recording.mp4");
    const videoPath = path.join(dir, base + ".video.mp4");
    const eventsName = base + ".events.csv";
    const framesName = base + ".frames.csv";
    const eventsPath = path.join(dir, eventsName);
    const framesPath = path.join(dir, framesName);
    const eventsStream = fs.createWriteStream(eventsPath, { flags: "w" });
    const framesStream = fs.createWriteStream(framesPath, { flags: "w" });
    eventsStream.on("error", (err: Error) => { this.lastError = "events.csv 写入失败: " + err.message; });
    framesStream.on("error", (err: Error) => { this.lastError = "frames.csv 写入失败: " + err.message; });
    eventsStream.write(EVENTS_HEADER + CSV_CRLF);
    framesStream.write(FRAMES_HEADER + CSV_CRLF);
    const rawStream = this.rawDump ? fs.createWriteStream(path.join(dir, base + ".raw"), { flags: "w" }) : null;
    rawStream?.on("error", (err: Error) => { this.lastError = "raw 写入失败: " + err.message; });

    const holder: { chunk: ChunkState | null } = { chunk: null };
    const encoder = new FfmpegEncoder({
      output: fragPath,
      width: this.frameW,
      height: this.frameH,
      fps: FPS_NOMINAL,
      crf: this.crf,
      encoder: this.encoderName,
      ffmpegPath: this.ffmpegPath,
      argsPrefix: this.ffmpegArgsPrefix,
      maxQueuedFrames: this.maxQueuedFrames,
      log: this.log,
      onError: (err) => { if (holder.chunk !== null) this.onEncoderError(holder.chunk, err); },
    });
    const chunk: ChunkState = {
      index,
      dir,
      base,
      fragPath,
      videoPath,
      eventsName,
      framesName,
      eventsPath,
      framesPath,
      eventsStream,
      framesStream,
      rawStream,
      encoder,
      startedAtMs,
      nextIdx: 0,
      framesWritten: 0,
      eventsWritten: 0,
      fragBytes: null,
      videoBytes: null,
      sealError: null,
      finished: false,
      finishPromise: null,
    };
    holder.chunk = chunk;
    this.chunks.push(chunk);
    this.current = chunk;
  }

  private onFrame(f: FramePacket): void {
    if (!this.active) return;
    const counters = this.countersState;
    counters.droppedEvents += Math.max(0, f.events.dropped | 0);
    if (f.raw.length !== this.frameBytes) {
      counters.droppedFrames++;
      this.logDrop("帧字节数不符（" + f.raw.length + " != " + this.frameBytes + "），已丢弃");
      return;
    }
    if (this.current === null) {
      counters.droppedFrames++;
      return;
    }
    const now = this.now();
    if (now - this.current.startedAtMs >= this.chunkMs) this.rotate(now);
    const chunk = this.current;
    if (chunk === null) {
      counters.droppedFrames++;
      return;
    }
    const accepted = chunk.encoder.writeFrame(f.raw, () => this.onFrameAccepted(chunk, f));
    if (!accepted) {
      counters.droppedFrames++;
      this.logDrop("ffmpeg 背压队列已满（上限 " + this.maxQueuedFrames + " 帧），本帧丢弃");
    }
  }

  private logDrop(msg: string): void {
    const t = this.now();
    if (t - this.lastDropLogMs < 5000) return;
    this.lastDropLogMs = t;
    this.log("[record] " + msg);
  }

  /** 只有真正写进 stdin 的帧才分配 chunk 内 frame_idx 并落两表 */
  private onFrameAccepted(chunk: ChunkState, f: FramePacket): void {
    if (chunk.finished) return;
    const recIdx = chunk.nextIdx++;
    chunk.framesWritten++;
    this.countersState.frames++;
    this.countersState.bytes += f.raw.length;
    const frameT = frameTimeBase(f);
    chunk.framesStream.write(formatFrameRow(recIdx, f.tBoardMs ?? null, f.tArriveMs) + CSV_CRLF);
    for (const ev of f.events.records) {
      chunk.eventsStream.write(formatEventRow(recIdx, frameT, ev) + CSV_CRLF);
      chunk.eventsWritten++;
      this.countersState.events++;
    }
    if (chunk.rawStream !== null) chunk.rawStream.write(Buffer.from(f.raw));
  }

  /** 纯事件批次（EV_ONLY）没有对应视频帧：挂到"下一个 chunk 内帧号"上，仅在极端场景出现 */
  private onEventsDetailed(b: EventBatch, tArriveMs: number, evOnly: boolean): void {
    if (!this.active || !evOnly) return;
    this.countersState.droppedEvents += Math.max(0, b.dropped | 0);
    const chunk = this.current;
    if (chunk === null || b.records.length === 0) return;
    const recIdx = chunk.nextIdx;
    for (const ev of b.records) {
      chunk.eventsStream.write(formatEventRow(recIdx, tArriveMs, ev) + CSV_CRLF);
      chunk.eventsWritten++;
      this.countersState.events++;
    }
  }

  /** 到达分段时长：同步开新 chunk，旧 chunk 的排空/转封装在后台跑（不阻塞当前帧） */
  private rotate(now: number): void {
    const old = this.current;
    if (old === null) return;
    // 时间钉在触发时刻，避免注入时钟/轮转内部取时造成偏差
    this.openChunk(this.chunks.length, now);
    this.log("[record] 分段轮转: " + old.base + " → " + (this.current?.base ?? "?"));
    void this.finishChunk(old).catch((err: unknown) => {
      this.lastError = "分段收尾失败: " + (err instanceof Error ? err.message : String(err));
      this.log("[record] " + this.lastError);
    });
  }

  private finishChunk(chunk: ChunkState): Promise<void> {
    if (chunk.finishPromise !== null) return chunk.finishPromise;
    chunk.finishPromise = this.doFinishChunk(chunk);
    return chunk.finishPromise;
  }

  private async doFinishChunk(chunk: ChunkState): Promise<void> {
    let enc: FfmpegFinishResult;
    try {
      enc = await chunk.encoder.finish();
    } catch (err) {
      enc = { ok: false, code: null, signal: null, stderr: err instanceof Error ? err.message : String(err) };
    }
    if (!enc.ok) {
      const msg = "ffmpeg 收尾失败（code=" + String(enc.code) + "）：" + enc.stderr.slice(-500);
      this.lastError = msg;
      this.log("[record] " + msg);
    }
    await closeStream(chunk.framesStream);
    await closeStream(chunk.eventsStream);
    if (chunk.rawStream !== null) await closeStream(chunk.rawStream);

    try {
      chunk.fragBytes = (await fsp.stat(chunk.fragPath)).size;
    } catch {
      chunk.fragBytes = 0;
    }
    if (chunk.fragBytes <= 0) {
      chunk.sealError = "没有可转封装的碎片文件（未收到帧或 ffmpeg 未落盘）";
    } else {
      const seal = await sealRecording({
        frag: chunk.fragPath,
        video: chunk.videoPath,
        ffmpegPath: this.ffmpegPath,
        argsPrefix: this.ffmpegArgsPrefix,
        log: this.log,
      });
      if (seal.ok) {
        chunk.videoBytes = seal.videoBytes;
        this.log("[record] 分段完成: " + path.basename(chunk.videoPath) + " (" + String(seal.videoBytes ?? 0) + " B)");
      } else {
        chunk.sealError = "转封装失败（code=" + String(seal.code) + "）：" + seal.stderr.slice(-300);
        this.lastError = chunk.sealError;
        this.log("[record] " + chunk.sealError + "；保留碎片文件 " + path.basename(chunk.fragPath));
      }
    }
    chunk.finished = true;
    await this.writeMeta().catch(() => { /* 已在内部记录 */ });
  }

  private onEncoderError(chunk: ChunkState, err: Error): void {
    this.lastError = "ffmpeg 异常: " + err.message;
    if (chunk.finished || chunk !== this.current) return;
    if (!this.active) return;
    this.ffmpegRestarts++;
    if (this.ffmpegRestarts > 1) {
      this.log("[record] ffmpeg 第二次异常，停止录制（碎片文件保留可播）");
      void this.stop("ffmpeg_failed");
      return;
    }
    this.log("[record] ffmpeg 异常，重开一次");
    const old = chunk;
    this.current = null;
    this.openChunk(this.chunks.length);
    void this.finishChunk(old).catch(() => { /* 已记录 */ });
  }

  /** 幂等停止；并发调用共享同一个 Promise */
  stop(reason = "stopped"): Promise<RecorderStatus> {
    if (this.stopPromise !== null) return this.stopPromise;
    if (!this.active && this.current === null && this.chunks.every((c) => c.finished)) {
      return Promise.resolve(this.status());
    }
    this.active = false;
    this.stopDiskTimer();
    this.endedAtMs = this.now();
    this.reason = reason;
    this.stopPromise = (async () => {
      for (const chunk of [...this.chunks]) {
        await this.finishChunk(chunk);
      }
      this.current = null;
      await this.writeMeta().catch(() => { /* 已记录 */ });
      this.log("[record] 停止（" + reason + "）: " + String(this.sessionName ?? "-"));
      this.stopPromise = null;
      return this.status();
    })();
    return this.stopPromise;
  }

  status(): RecorderStatus {
    const started = this.startedAtMs;
    const ended = this.endedAtMs;
    const duration = started === null ? 0 : Math.max(0, (ended ?? this.now()) - started);
    return {
      active: this.active,
      session: this.sessionName,
      root: this.root,
      startedAt: started === null ? null : new Date(started).toISOString(),
      endedAt: ended === null ? null : new Date(ended).toISOString(),
      reason: this.reason,
      chunk: this.current === null ? null : this.chunkView(this.current),
      chunks: this.chunks.map((c) => this.chunkView(c)),
      counters: { ...this.countersState },
      durationMs: duration,
      bytesVideo: this.videoBytesTotal(),
      diskFreeBytes: this.lastDiskFreeBytes,
      ffmpeg: {
        path: this.ffmpegPath,
        restarts: this.ffmpegRestarts,
        lastError: this.lastError,
        pending: this.current?.encoder.pending ?? 0,
      },
    };
  }

  /**
   * 视频体积：已封口 chunk 的 videoBytes 之和 + 当前正在写的 .recording.mp4 的实时大小。
   *
   * 每次 status 只对当前碎片文件 stat 一次；还没生成/已转封装删除时算 0。
   * 绝不能把 counters.bytes（原始帧字节，60 s 样本约 947 MB）混进来 —— 那是用户以为
   * 「录一分钟吃 1 GB」的来源，mp4 实际只有 46.2 MB。
   */
  private videoBytesTotal(): number {
    let total = 0;
    for (const c of this.chunks) {
      if (c.videoBytes !== null && Number.isFinite(c.videoBytes)) total += c.videoBytes;
    }
    const cur = this.current;
    if (cur !== null) {
      try {
        total += fs.statSync(cur.fragPath).size;
      } catch {
        // 文件尚未出现或已被 seal 删除：当前段还没有可计的视频字节
      }
    }
    return total;
  }

  private chunkView(c: ChunkState): RecorderChunkView {
    return {
      index: c.index,
      video: c.base + ".video.mp4",
      events: c.eventsName,
      frames: c.framesName,
      framesWritten: c.framesWritten,
      eventsWritten: c.eventsWritten,
      fragBytes: c.fragBytes,
      videoBytes: c.videoBytes,
      finished: c.finished,
      sealError: c.sealError,
    };
  }

  /** meta.json 串行写：轮转/停止并发时也不会互相覆盖 */
  private writeMeta(): Promise<void> {
    this.metaQueue = this.metaQueue.then(async () => {
      if (this.sessionDir === null) return;
      const meta = {
        version: 1,
        session: this.sessionName,
        startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
        endedAt: this.endedAtMs === null ? null : new Date(this.endedAtMs).toISOString(),
        profile: this.profile.name,
        fpsNominal: FPS_NOMINAL,
        chunks: this.chunks.map((c) => ({
          index: c.index,
          video: c.base + ".video.mp4",
          events: c.eventsName,
          frames: c.framesName,
          fragBytes: c.fragBytes,
          videoBytes: c.videoBytes,
        })),
        counters: { ...this.countersState },
        ...(this.reason === null ? {} : { reason: this.reason }),
      };
      await fsp.writeFile(path.join(this.sessionDir as string, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
    }).catch((err: unknown) => {
      this.lastError = "写 meta.json 失败: " + (err instanceof Error ? err.message : String(err));
      this.log("[record] " + this.lastError);
    });
    return this.metaQueue;
  }

  private startDiskTimer(): void {
    this.stopDiskTimer();
    if (this.diskCheckMs <= 0) return;
    this.diskTimer = setInterval(() => { void this.checkDisk(); }, this.diskCheckMs);
    this.diskTimer.unref();
  }

  private stopDiskTimer(): void {
    if (this.diskTimer !== null) {
      clearInterval(this.diskTimer);
      this.diskTimer = null;
    }
  }

  private async checkDisk(): Promise<void> {
    if (!this.active) return;
    let free: number;
    try {
      free = this.diskFree === null ? await defaultDiskFree(this.root) : await this.diskFree(this.root);
    } catch (err) {
      this.log("[record] 磁盘剩余探测失败: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    this.lastDiskFreeBytes = free;
    if (free < this.diskMinFreeBytes) {
      this.lastError = "剩余磁盘 " + Math.round(free / 1048576) + " MB 低于阈值 " + Math.round(this.diskMinFreeBytes / 1048576) + " MB";
      this.log("[record] " + this.lastError + "，停止录制");
      void this.stop("disk_low");
    }
  }
}

async function defaultDiskFree(root: string): Promise<number> {
  const st = await fsp.statfs(root);
  return Number(st.bavail) * Number(st.bsize);
}
