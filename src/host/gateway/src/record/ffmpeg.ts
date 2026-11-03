// ffmpeg 子进程封装（task-30）：只负责"把 768000 字节的 RGB565 帧按顺序灌进 stdin"与
// "正常关闭时把 fragmented MP4 转封装成可拖进度条的 faststart MP4"。
//
// 为什么直接 spawn 数组而不是拼 shell：Windows 路径含空格/中文，拼字符串必然踩引号坑；
// 数组形式同时让单测能注入一个假 ffmpeg（process.execPath + fixture 脚本）。
import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";

export interface EncodeArgsOptions {
  /** 输入宽高（profile.frame.w/h；默认 800x480） */
  readonly width: number;
  readonly height: number;
  /** 标称帧率（契约固定 30；-fps_mode passthrough 让每个输入帧都成为输出帧） */
  readonly fps: number;
  readonly crf: number;
  /** libx264 / h264_nvenc…（--record-encoder 覆盖） */
  readonly encoder: string;
  readonly output: string;
}

/** 任务书逐字命令（Lead 2026-10-30 已实测 90 帧 exit 0）。改这里等于改板端回放速度。 */
export function buildEncodeArgs(o: EncodeArgsOptions): string[] {
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "rawvideo",
    "-pixel_format", "rgb565be",
    "-video_size", o.width + "x" + o.height,
    "-framerate", String(o.fps),
    "-i", "pipe:0",
    "-fps_mode", "passthrough",
    "-c:v", o.encoder,
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-crf", String(o.crf),
    "-g", "60",
    "-pix_fmt", "yuv420p",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    o.output,
  ];
}

/** 分段正常关闭：碎片 MP4 → faststart MP4（-c copy 秒级、大小几乎不变；成功后才删碎片文件） */
export function buildSealArgs(frag: string, video: string): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-y", "-i", frag, "-c", "copy", "-movflags", "+faststart", video];
}

export interface FfmpegEncoderOptions {
  readonly output: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly crf: number;
  readonly encoder: string;
  /** ffmpeg 可执行文件；默认 "ffmpeg"（PATH），--ffmpeg 可覆盖 */
  readonly ffmpegPath?: string | undefined;
  /** 注入假 ffmpeg 时放在 ffmpegPath 前面的参数（例如 fixture 脚本路径） */
  readonly argsPrefix?: readonly string[] | undefined;
  /** stdin 背压队列上限（帧）；超过就丢新帧并计入 droppedFrames */
  readonly maxQueuedFrames?: number | undefined;
  readonly log?: ((msg: string) => void) | undefined;
  /** 子进程异常退出（非正常 finish）时回调；用于"重开一次" */
  readonly onError?: ((err: Error) => void) | undefined;
}

export interface FfmpegFinishResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

interface QueuedFrame {
  readonly data: Uint8Array;
  readonly onAccepted: (() => void) | undefined;
}

/** 从流里截取最后 N 个字符的 stderr 环（ffmpeg 报错通常就在最后几行） */
function tailAppend(prev: string, chunk: string, max = 4000): string {
  const s = prev + chunk;
  return s.length > max ? s.slice(s.length - max) : s;
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref();
  });
}

function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

export class FfmpegEncoder {
  readonly output: string;
  readonly ffmpegPath: string;
  private readonly encodeArgs: readonly string[];
  private readonly maxQueuedFrames: number;
  private readonly log: (msg: string) => void;
  private readonly onError: ((err: Error) => void) | null;
  private child: ChildProcess | null = null;
  private readonly queue: QueuedFrame[] = [];
  private needDrain = false;
  private finishing = false;
  private failed = false;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stderrTail = "";
  private lastError: string | null = null;
  private readonly drainWaiters: Array<() => void> = [];
  private readonly closePromise: Promise<FfmpegFinishResult>;
  private resolveClose!: (r: FfmpegFinishResult) => void;
  private finishPromise: Promise<FfmpegFinishResult> | null = null;
  private errorNotified = false;

  constructor(opts: FfmpegEncoderOptions) {
    this.output = opts.output;
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.maxQueuedFrames = Math.max(1, opts.maxQueuedFrames ?? 8);
    this.log = opts.log ?? (() => {});
    this.onError = opts.onError ?? null;
    this.encodeArgs = [
      ...(opts.argsPrefix ?? []),
      ...buildEncodeArgs({
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        crf: opts.crf,
        encoder: opts.encoder,
        output: opts.output,
      }),
    ];
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    this.spawnChild();
  }

  /** 背压队列里还没写进 stdin 的帧数（status 用；不含已交给内核缓冲的部分） */
  get pending(): number {
    return this.queue.length;
  }

  get isFailed(): boolean {
    return this.failed;
  }

  get errorText(): string | null {
    return this.lastError;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  private spawnChild(): void {
    let child: ChildProcess;
    try {
      child = spawn(this.ffmpegPath, this.encodeArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      this.failed = true;
      this.lastError = "无法启动 ffmpeg: " + (err instanceof Error ? err.message : String(err));
      this.notifyDrained();
      this.resolveClose({ ok: false, code: null, signal: null, stderr: "" });
      return;
    }
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { this.stderrTail = tailAppend(this.stderrTail, d); });
    child.stdin?.on("drain", () => {
      this.needDrain = false;
      this.pump();
    });
    child.stdin?.on("error", (err: Error) => {
      // EPIPE 只在子进程异常退出时出现；正常 finish 由关闭事件收尾，不重复报错
      if (!this.finishing) this.fail("ffmpeg stdin 错误: " + err.message);
    });
    child.on("error", (err: Error) => {
      this.fail("ffmpeg 启动/运行错误: " + err.message);
    });
    child.on("close", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      if (!this.finishing && !this.failed) {
        this.fail("ffmpeg 意外退出（code=" + String(code) + " signal=" + String(signal) + "）" + this.stderrTail);
      }
      this.queue.length = 0;
      this.notifyDrained();
      this.resolveClose({
        ok: !this.failed && code === 0,
        code,
        signal: signal ?? null,
        stderr: this.stderrTail,
      });
    });
  }

  /**
   * 写一帧。返回 false = 背压队列已满/编码器已失效，本帧被丢弃（调用方计入 droppedFrames）。
   * onAccepted 在该帧真正写入 stdin（或从队列排空）时按顺序回调；CSV 行以此为"成功写入"。
   */
  writeFrame(data: Uint8Array, onAccepted?: () => void): boolean {
    if (this.failed || this.finishing || this.exited) return false;
    const item: QueuedFrame = { data, onAccepted };
    if (this.needDrain) {
      if (this.queue.length >= this.maxQueuedFrames) return false;
      this.queue.push(item);
      return true;
    }
    this.writeNow(item);
    return true;
  }

  private writeNow(item: QueuedFrame): void {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined || !stdin.writable) {
      this.fail("ffmpeg stdin 不可写");
      return;
    }
    let ok = false;
    try {
      ok = stdin.write(Buffer.from(item.data));
    } catch (err) {
      this.fail("写 ffmpeg stdin 失败: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    try {
      item.onAccepted?.();
    } catch (err) {
      this.log("[record] 写 CSV 回调异常: " + (err instanceof Error ? err.message : String(err)));
    }
    if (!ok) this.needDrain = true;
    if (this.queue.length === 0 && !this.needDrain) this.notifyDrained();
  }

  private pump(): void {
    while (!this.needDrain && !this.failed && !this.exited && this.queue.length > 0) {
      const item = this.queue.shift();
      if (item === undefined) break;
      this.writeNow(item);
    }
    if (this.queue.length === 0 && !this.needDrain) this.notifyDrained();
  }

  private notifyDrained(): void {
    const waiters = this.drainWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitDrained(ms: number): Promise<boolean> {
    if ((this.queue.length === 0 && !this.needDrain) || this.failed || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(v);
      };
      this.drainWaiters.push(() => done(true));
      timer = setTimeout(() => done(false), ms);
      timer.unref();
    });
  }

  private waitClose(ms: number): Promise<FfmpegFinishResult | null> {
    if (this.exited) {
      return Promise.resolve({ ok: !this.failed && this.exitCode === 0, code: this.exitCode, signal: this.exitSignal, stderr: this.stderrTail });
    }
    return Promise.race([this.closePromise, delay(ms)]);
  }

  /** 排空队列 → 关 stdin → 等 ffmpeg 自然退出（保证 mp4 尾部的 moof 写完） */
  finish(): Promise<FfmpegFinishResult> {
    if (this.finishPromise !== null) return this.finishPromise;
    this.finishing = true;
    this.finishPromise = (async () => {
      const drained = await this.waitDrained(15000);
      if (!drained) {
        this.fail("ffmpeg 背压排空超时（15 s）");
        this.kill();
      }
      if (!this.exited) {
        try { this.child?.stdin?.end(); } catch { /* 已关闭 */ }
      }
      const res = await this.waitClose(15000);
      if (res === null) {
        this.kill();
        return { ok: false, code: null, signal: null, stderr: this.stderrTail };
      }
      return { ...res, ok: res.ok && !this.failed };
    })();
    return this.finishPromise;
  }

  kill(): void {
    try { this.child?.kill("SIGKILL"); } catch { /* 已退出 */ }
  }

  /** 子进程异常：清空队列、记录错误、只通知一次（restart 逻辑在 Recorder） */
  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.lastError = message;
    this.queue.length = 0;
    this.notifyDrained();
    if (!this.errorNotified) {
      this.errorNotified = true;
      this.log("[record] " + message);
      this.onError?.(new Error(message));
    }
  }
}

export interface SealOptions {
  readonly frag: string;
  readonly video: string;
  readonly ffmpegPath?: string | undefined;
  readonly argsPrefix?: readonly string[] | undefined;
  readonly log?: ((msg: string) => void) | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface SealResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stderr: string;
  readonly fragBytes: number;
  readonly videoBytes: number | null;
}

/** 把 fragmented MP4 转成 faststart MP4；成功才删 .recording.mp4（崩溃残留保持可播） */
export async function sealRecording(opts: SealOptions): Promise<SealResult> {
  const log = opts.log ?? (() => {});
  let fragBytes = 0;
  try {
    fragBytes = (await fsp.stat(opts.frag)).size;
  } catch (err) {
    return { ok: false, code: null, stderr: "碎片文件不存在: " + (err instanceof Error ? err.message : String(err)), fragBytes: 0, videoBytes: null };
  }
  const args = [
    ...(opts.argsPrefix ?? []),
    ...buildSealArgs(opts.frag, opts.video),
  ];
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({ code, stderr });
    };
    let child: ChildProcess;
    try {
      child = spawn(opts.ffmpegPath ?? "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { stderr = tailAppend(stderr, d); });
    child.on("error", (err: Error) => { finish(null); log("[record] 转封装启动失败: " + err.message); });
    child.on("close", (code) => finish(code));
    timer = later(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish(null);
    }, opts.timeoutMs ?? 120000);
  });
  if (result.code !== 0) {
    try { await fsp.rm(opts.video, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, code: result.code, stderr: result.stderr, fragBytes, videoBytes: null };
  }
  let videoBytes: number | null = null;
  try {
    videoBytes = (await fsp.stat(opts.video)).size;
    await fsp.rm(opts.frag, { force: true });
  } catch (err) {
    return { ok: false, code: result.code, stderr: "转封装产物不可读: " + (err instanceof Error ? err.message : String(err)), fragBytes, videoBytes: null };
  }
  return { ok: true, code: 0, stderr: result.stderr, fragBytes, videoBytes };
}
