// 视频导出：用浏览器自己的编码器（MediaRecorder + canvas.captureStream）把录下来的帧编成视频文件。
//
// 为什么是 MediaRecorder 而不是 WebCodecs + 自己写 MP4 muxer：
//   MediaRecorder 直接把"画布流 → 容器"整条路走完了，容器头/sps/pps/时间戳都不用手写；
//   自己 mux MP4 要 ~300 行且**没有 ffmpeg 可以验收**（本机没装），风险与收益不成比例。
//   （05 文档 §5 写的就是 "MP4：ffmpeg 或 WebCodecs"，MediaRecorder 属于同一条"借浏览器"路线。）
//
// 为什么必须**逐帧驱动 + requestFrame()** 而不是 captureStream(30) 自动抓：
//   源是 3.25 fps 的回传帧，自动抓会把同一张画面重复抓 9 次（或者在后台标签页被节流成 1 fps）。
//   `captureStream(0)` + 手动 `requestFrame()` 让"输出第 n 帧"完全由我们决定，
//   每帧的节拍由采集时刻 tMs 的相邻差给出（变帧率）—— 时间戳因此是真实的，
//   回传快就快、有停顿就停顿，不再把 26 fps 的回传匀速放成 30 fps。
//   调用方不给 timesMs 时才退回 1000/fps 的固定节拍（老路径/自检的兜底）。
//
// 已知限制（会明确告诉用户，不假装没有）：
//   · 标签页被切到后台时浏览器会节流定时器 ⇒ 导出会变慢（帧数不会错，时间戳会拉长）。
//     所以导出期间界面上有进度提示，要求用户别切走。
//   · 某些构建不含 MP4/H.264 编码器 ⇒ 探测后降级到 WebM，并把实际用的格式说出来。

export interface VideoCapability {
  readonly ok: boolean;
  /** 实际可用的 mimeType；ok=false 时为 null */
  readonly mime: string | null;
  /** 给用户看的一句话（成功时说格式，失败时说为什么） */
  readonly detail: string;
}

/** 按"越接近 MP4/H.264 越好"的顺序探测；返回第一个能用的 */
const CANDIDATES: readonly { readonly mime: string; readonly kind: "mp4" | "webm" }[] = [
  { mime: "video/mp4;codecs=avc1.42E01E", kind: "mp4" },
  { mime: "video/mp4;codecs=avc1", kind: "mp4" },
  { mime: "video/mp4", kind: "mp4" },
  { mime: "video/webm;codecs=vp9", kind: "webm" },
  { mime: "video/webm;codecs=vp8", kind: "webm" },
  { mime: "video/webm", kind: "webm" },
];

/**
 * 探测结果缓存。
 * 为什么必须缓存：可用性判定要在界面上每 200 ms 刷一次（按钮置灰状态），
 * 而每次探测是 6 次 `isTypeSupported` —— 不缓存就是每秒 30 次无意义的编解码器查询。
 * 探测结果在页面生命周期内不会变（不会中途装上编码器）。
 */
let cached: VideoCapability | null = null;

export function probeVideoEncoding(): VideoCapability {
  if (cached !== null) return cached;
  cached = probeUncached();
  return cached;
}

function probeUncached(): VideoCapability {
  if (typeof MediaRecorder === "undefined") {
    return { ok: false, mime: null, detail: "这个浏览器没有 MediaRecorder，无法导出视频（可用「PNG 序列」）" };
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
    return { ok: false, mime: null, detail: "这个浏览器不支持 canvas.captureStream（可用「PNG 序列」）" };
  }
  for (const c of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) {
        return {
          ok: true,
          mime: c.mime,
          detail: c.kind === "mp4" ? "可用 MP4 / H.264" : "无 H.264 编码器，将导出 WebM（" + c.mime + "）",
        };
      }
    } catch {
      // isTypeSupported 在极老实现上会抛，忽略继续试下一个
    }
  }
  return { ok: false, mime: null, detail: "浏览器不支持任何可用的视频容器（MP4 / WebM 都不行）" };
}

/**
 * 视频编码的**最小帧数**。
 *
 * 实测（2026-10-06，无头 Chrome + H.264，同一批录制帧只改喂进去的帧数）：
 *
 * | 帧数 | 1 | 2 | 4 | 6 | 8 | 12 | 26 |
 * |---|---|---|---|---|---|---|---|
 * | 产出 | 0 B | 0 B | 0 B | 517 KB | 624 KB | 793 KB | 1.26 MB |
 *
 * 门槛在 4~6 帧之间（≈170 ms 编码器时间），**且在这个边界上不稳定** —— 同一台机器同一天，
 * 12 帧的片段曾出现过一次 0 字节。原因是 MediaRecorder 从 start() 到"真的开始收帧"
 * 有一段初始化窗口，窗口内的帧会被直接丢掉。
 *
 * 所以这里做两件事，而不是把下限拉高到"永远不会出问题"：
 *   ① 帧数低于下限时**直接报错并说清怎么办**（报错比给用户一个 0 字节文件好）；
 *   ② 产出为空时**自动重试一次**（加倍暖机），把不稳定的那一侧挡掉。
 */
export const MIN_VIDEO_FRAMES = 6;

/**
 * 变帧率导出的相邻帧间隔钳位（ms）。
 *
 * 为什么必须钳：媒体时间的唯一来源是"我们什么时候 requestFrame()"这个墙钟时刻，
 * 而采集侧的 tMs 会有三种反常值，直接用会毁掉整段视频：
 *   · Δt = 0 或负数（同一毫秒到两帧、系统时钟回拨）⇒ 两帧落在同一时刻，
 *     编码器要么丢掉一帧，要么产出 0 时长的坏样本（播放器里表现为卡住/花屏）；
 *   · Δt 极大（网关停流几十秒、切后台被节流）⇒ 产出一段几十秒的静止画面，
 *     整段视频时长被拉爆，用户看到的是"播到一半就不动了"；
 *   · NaN / ∞（上游时间戳缺失或损坏）⇒ sleep 拿到非有限值，循环要么立刻空转要么永久挂起；
 *     这一类不做钳位而是**退回固定节拍**（fallbackMs），因为差值本身已不可信。
 * 有限但越界的值统一收敛到 [1, 500]：1 ms 是"两帧不重叠"的下限，500 ms 是"停顿最多压缩到半秒"的上限
 * （500 ms 已足够让肉眼看出停顿，又不至于让一段时间轴被静止帧主导）。
 */
export const MIN_GAP_MS = 1;
export const MAX_GAP_MS = 500;

/** 把任意 Δt 收敛到 [MIN_GAP_MS, MAX_GAP_MS]；非有限值退回 fallback */
function clampGap(deltaMs: number, fallbackMs: number): number {
  if (!Number.isFinite(deltaMs)) return fallbackMs;
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round(deltaMs)));
}

/**
 * 逐帧给出"提交完第 i 帧之后应该等多久"（ms），下标与 frames 一一对应。
 *
 * - 有 timesMs 且相邻两项都是有限数 ⇒ 用差值（变帧率，这是正常路径）；
 * - 缺失/非有限/末帧无后继 ⇒ 退回 fallbackMs（= 1000/fps 的固定节拍）。
 *
 * 抽成不依赖 DOM 的纯函数是为了能在 Node 单测里钉住钳位规则（见 web/test/mp4-vfr.test.ts）。
 */
export function frameGaps(timesMs: readonly number[] | undefined, frames: number, fallbackMs: number): number[] {
  const fb = clampGap(fallbackMs, MIN_GAP_MS);
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const a = timesMs?.[i];
    const b = timesMs?.[i + 1];
    if (typeof a === "number" && typeof b === "number") out.push(clampGap(b - a, fb));
    else out.push(fb);
  }
  return out;
}

export interface EncodeVideoOptions {
  /** 回退帧率：只在 timesMs 缺失/不足时用作固定节拍，并用于算暖机时长与"片段太短"的换算 */
  readonly fps: number;
  /**
   * 每帧的采集时刻（ms，RecordedFrame.tMs 原样，允许是原始 epoch 毫秒）。
   * 给了就按相邻差做变帧率：视频里两帧的间隔 = 板卡/网关实际送来这两帧的间隔。
   */
  readonly timesMs?: readonly number[];
  /** 画第 i 帧到给定 2D 上下文；画布尺寸由调用方决定 */
  readonly draw: (index: number, ctx: CanvasRenderingContext2D) => void;
  readonly width: number;
  readonly height: number;
  readonly mime: string;
  /** 每帧回调（用于进度条）；返回 false 表示用户取消 */
  readonly onProgress?: (done: number, total: number) => boolean;
}

export interface EncodeVideoResult {
  readonly blob: Blob;
  readonly mime: string;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly elapsedMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/**
 * 逐帧编码。
 *
 * ⚠️ 画布必须**留在文档里**（哪怕挪到屏幕外）：脱离文档的画布在部分 Chromium 版本上
 * 不会被 compositor 提交，captureStream 拿不到帧（表现为导出的视频只有 1 帧或全黑）。
 * 所以这里挂到 body 上、`position:fixed; left:-10000px`，结束后移除。
 */
export async function encodeVideo(frames: number, opt: EncodeVideoOptions): Promise<EncodeVideoResult> {
  if (frames <= 0) throw new Error("没有可编码的帧（先按 R 录一段）");
  if (frames < MIN_VIDEO_FRAMES) {
    throw new Error(
      "片段太短：视频编码器至少要 " + MIN_VIDEO_FRAMES + " 帧（约 " + (MIN_VIDEO_FRAMES / opt.fps).toFixed(2) +
        " s），当前 " + frames + " 帧。请把时间轴选区拉长，或改用「PNG 序列」（单帧也能导）。",
    );
  }

  // 固定节拍只作回退（无 tMs 时）与暖机换算；正常路径的真实节拍由 frameGaps 逐帧给出
  const gap = Math.max(1, Math.round(1000 / opt.fps));
  const gaps = frameGaps(opt.timesMs, frames, gap);
  // 第一次用基础暖机，失败（0 字节）时加倍重试一次 —— 边界上的不稳定只有重试能挡住
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await encodeOnce(frames, opt, gap, gaps, attempt === 0 ? Math.max(120, gap * 3) : Math.max(260, gap * 8));
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("视频编码失败");
}

async function encodeOnce(
  frames: number,
  opt: EncodeVideoOptions,
  gap: number,
  gaps: readonly number[],
  warmupMs: number,
): Promise<EncodeVideoResult> {
  const canvas = document.createElement("canvas");
  canvas.width = opt.width;
  canvas.height = opt.height;
  canvas.style.cssText =
    "position:fixed;left:-10000px;top:0;width:" + opt.width + "px;height:" + opt.height + "px;pointer-events:none";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    throw new Error("离屏 2D 上下文创建失败（视频导出无法继续）");
  }

  // ⚠️ captureStream 只能调**一次**：调两次会得到两条互不相干的流，
  // requestFrame() 提交到 A 流而 MediaRecorder 录的是 B 流 ⇒ 导出结果是 0 字节。
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    canvas.remove();
    throw new Error("captureStream 没有给出视频轨");
  }
  // requestFrame 只存在于 CanvasCaptureMediaStreamTrack（TS 的 DOM 类型里没有）：
  // 这是唯一"我画一帧就提交一帧"的入口，缺了它就只能退化成实时抓取。
  const reqFrame = (track as unknown as { requestFrame?: () => void }).requestFrame;
  if (typeof reqFrame !== "function") {
    track.stop();
    canvas.remove();
    throw new Error("这个浏览器的 captureStream 不支持 requestFrame（无法逐帧导出）");
  }

  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, { mimeType: opt.mime, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = (ev: BlobEvent) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    rec.onstop = () => resolve();
    rec.onerror = () => reject(new Error("MediaRecorder 报错（编码器可能不支持该分辨率）"));
  });

  const started = performance.now();
  let cancelled = false;
  let tooShort = false;
  try {
    rec.start();
    // 暖机窗口：`rec.start()` 返回**不代表编码器已经开始收帧**（见 MIN_VIDEO_FRAMES 的实测表）。
    // 先喂一帧把编码器"点火"，等它真的开始收帧，再按真实节奏喂整段。
    opt.draw(0, ctx);
    reqFrame.call(track);
    await sleep(warmupMs);
    for (let i = 0; i < frames; i++) {
      opt.draw(i, ctx);
      reqFrame.call(track);
      if (opt.onProgress !== undefined && opt.onProgress(i + 1, frames) === false) {
        cancelled = true;
        break;
      }
      // 让编码器拿到"真实的帧间隔" —— 时间戳来自墙钟，不 sleep 的话整段视频会被压成 0 秒。
      // gaps[i] 来自相邻帧的 tMs 差（已钳到 [1,500]）；没有 tMs 时它是固定的 1000/fps。
      await sleep(gaps[i] ?? gap);
    }
    if (!cancelled) {
      // 最后一帧提交后再留一点时间给编码器出数据（stop() 之前的数据才会进 ondataavailable）
      await sleep(Math.max(gap * 2, 60));
    }
    tooShort = chunks.length === 0;
  } finally {
    // 无论正常结束、报错还是取消，编码器、轨道、离屏画布都必须收干净：
    // 漏一个，页面每导一次就多留一条被合成器引用的流（越导越卡，且原因看不出来）
    if (rec.state !== "inactive") rec.stop();
    await stopped.catch(() => undefined);
    track.stop();
    canvas.remove();
  }
  if (cancelled) throw new Error("导出已取消");

  const blob = new Blob(chunks, { type: opt.mime.split(";")[0] ?? "video/mp4" });
  if (blob.size === 0) {
    throw new Error(
      tooShort
        ? "编码器没有产出任何数据（" + frames + " 帧太短）"
        : "编码器没有产出任何数据（试试导出 PNG 序列）",
    );
  }
  return {
    blob,
    mime: opt.mime,
    frames,
    width: opt.width,
    height: opt.height,
    elapsedMs: performance.now() - started,
  };
}

/** 视频扩展名：mime 说 MP4 才是 mp4，否则老实叫 webm */
export function videoExt(mime: string): string {
  return mime.includes("mp4") ? "mp4" : "webm";
}
