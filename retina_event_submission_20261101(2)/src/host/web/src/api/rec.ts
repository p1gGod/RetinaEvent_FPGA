// 长录（网关 /rec/*）的前端只读客户端与展示口径（task-31 / WEB_REC_UI_OK）。
//
// 为什么单独一层：底栏要同时存在两种"录制"——
//   · 「录制（缓冲 96 MB）」是浏览器内存里的环形缓冲，刷新即丢，导出走浏览器；
//   · 「长录」是网关把完整帧 + events/frames CSV 落到磁盘，刷新页面不影响。
// 两种状态绝不能混成一个布尔值；这里只封装**网关状态**，不把 active 存 localStorage。
//
// 口径（契约来自 gateway/src/record/recorder.ts 的 RecorderStatus，不发明字段）：
//   durationMs 由网关按 startedAt/endedAt（或当前时刻）算；
//   counters.frames 是**真正写进 ffmpeg 的帧数**；
//   实际帧率 = frames / (durationMs / 1000)，所以合成源 21.5 fps 时用户能一眼看出不是程序坏了。
//
// 注意：视频 PTS 只是容器表象，真值永远来自 frames.csv 的 frame_idx ↔ t_board_ms；
// 标注工具按 frame_idx 反查 t_board_ms 定位，不依赖 30 fps 假设。前端不做 VFR 重定时。
export const REC_STATUS_POLL_MS = 1000;
/** 低于此值显示黄色「磁盘余量」警告（10 GiB） */
export const REC_DISK_LOW_BYTES = 10 * 1024 * 1024 * 1024;

export type RecTone = "off" | "ok" | "warn" | "bad";

/** /rec/status 的线上结构：字段都按可选处理，旧网关没有 /rec 时整份不可用 */
export interface RecCountersWire {
  readonly frames?: number;
  readonly events?: number;
  readonly droppedFrames?: number;
  readonly droppedEvents?: number;
  readonly bytes?: number;
}

export interface RecChunkWire {
  readonly index?: number;
  readonly video?: string;
  readonly events?: string;
  readonly frames?: string;
  readonly framesWritten?: number;
  readonly eventsWritten?: number;
  readonly fragBytes?: number | null;
  readonly videoBytes?: number | null;
  readonly finished?: boolean;
  readonly sealError?: string | null;
}

export interface RecStatusWire {
  readonly ok?: boolean;
  readonly active?: boolean;
  readonly session?: string | null;
  readonly root?: string | null;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly reason?: string | null;
  readonly chunk?: RecChunkWire | null;
  readonly chunks?: readonly RecChunkWire[];
  readonly counters?: RecCountersWire;
  readonly durationMs?: number;
  readonly bytesVideo?: number;
  readonly diskFreeBytes?: number | null;
  readonly ffmpeg?: {
    readonly path?: string;
    readonly restarts?: number;
    readonly lastError?: string | null;
    readonly pending?: number;
  };
}

export interface RecStatusView {
  readonly text: string;
  readonly tone: RecTone;
  readonly active: boolean;
  readonly fps: number | null;
  readonly durationText: string;
  /** 视频文件体积（主显示；旧网关缺 bytesVideo 时为 "—"） */
  readonly sizeText: string;
  /** 原始帧字节（次行，明确标注“原始”，不能与视频体积混用） */
  readonly rawSizeText: string;
  readonly videoSizeText: string;
  readonly diskFreeText: string;
  /** 胶囊次行：原始字节 / 重开次数 / 目录；空闲时可能为空 */
  readonly subText: string;
  readonly bytesVideo: number | null;
  readonly diskFreeBytes: number | null;
  readonly diskLow: boolean;
  readonly dropped: number;
  readonly restarts: number;
  readonly dir: string;
  readonly title: string;
  readonly session: string | null;
}

export interface RecButtonState {
  readonly label: string;
  readonly action: "start" | "stop";
  readonly disabled: boolean;
  readonly title: string;
}

export interface RecRequestResult {
  readonly ok: boolean;
  readonly status?: RecStatusWire;
  readonly error?: string;
  readonly httpStatus?: number;
}

/** 只依赖 fetch 的最小签名：测试可以注入纯函数，不必起网关 */
export type RecFetch = (input: string, init?: RequestInit) => Promise<Response>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 可选数值：缺失/非有限/负数 → null（用于“未知”而不是伪装成 0） */
function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 毫秒 → mm:ss（超过 1 小时继续累加分钟，现场看 60:00 比 1:00:00 更符合"录了多久"的直觉） */
export function formatRecDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(num(ms) / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}

/**
 * 字节 → 人类可读体积（1024 进制；自动 MB/GB）。
 *
 * 46.2 MB / 947 MB / 312 GB；null/NaN/负数 → "—"（旧网关没有 bytesVideo/diskFreeBytes）。
 * >=100 时不带小数，避免底栏出现 "947.0 MB" 这种噪音；<10 GB 时保留一位，才看得见余量在掉。
 */
export function formatRecBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return (gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)) + " GB";
  }
  return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + " MB";
}

/** task-31 的旧名字；语义同 formatRecBytes（保留给旧调用/旧测试） */
export function formatRecSize(bytes: number): string {
  return formatRecBytes(bytes);
}

export function recFullPath(root: string | null | undefined, session: string | null | undefined): string {
  const r = str(root).replace(/[\\/]+$/, "");
  const s = str(session).replace(/^[\\/]+/, "");
  if (r === "") return s;
  if (s === "") return r;
  return r + "/" + s;
}

/**
 * 目录省略：底栏放不下整条 E:/workspace/.../20261030-202724_rec。
 * 只留最后两段（父目录 + 会话名），前面用 …/ 表示，鼠标悬停的 title 里仍有完整路径。
 */
export function shortenRecPath(root: string | null | undefined, session: string | null | undefined): string {
  const full = recFullPath(root, session).replace(/\\/g, "/");
  const parts = full.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 ? "…/" + tail : tail;
}

/** 实际录制帧率：只认"成功写进 ffmpeg 的帧"，不是渲染循环的节拍 */
export function actualRecFps(status: RecStatusWire | null | undefined): number | null {
  if (status === null || status === undefined) return null;
  const frames = num(status.counters?.frames);
  const seconds = num(status.durationMs) / 1000;
  if (frames <= 0 || seconds <= 0) return null;
  return Math.round((frames / seconds) * 10) / 10;
}

function statusParts(status: RecStatusWire): {
  readonly durationText: string;
  readonly sizeText: string;
  readonly videoSizeText: string;
  readonly rawSizeText: string;
  readonly diskFreeText: string;
  readonly dropped: number;
  readonly restarts: number;
  readonly fps: number | null;
  readonly dir: string;
  readonly session: string | null;
  readonly bytesVideo: number | null;
  readonly diskFreeBytes: number | null;
  readonly diskLow: boolean;
} {
  const counters = status.counters;
  const dropped = num(counters?.droppedFrames);
  const restarts = num(status.ffmpeg?.restarts);
  const rawBytes = num(counters?.bytes);
  const bytesVideo = optNum(status.bytesVideo);
  const diskFreeBytes = optNum(status.diskFreeBytes);
  const videoSizeText = formatRecBytes(bytesVideo);
  const rawSizeText = formatRecBytes(rawBytes);
  const diskFreeText = formatRecBytes(diskFreeBytes);
  const session = str(status.session).trim();
  const dir = session === "" ? "" : shortenRecPath(status.root, session);
  return {
    durationText: formatRecDuration(num(status.durationMs)),
    sizeText: videoSizeText,
    videoSizeText,
    rawSizeText,
    diskFreeText,
    dropped,
    restarts,
    fps: actualRecFps(status),
    dir,
    session: session === "" ? null : session,
    bytesVideo,
    diskFreeBytes,
    diskLow: diskFreeBytes !== null && diskFreeBytes < REC_DISK_LOW_BYTES,
  };
}

/**
 * 状态胶囊的唯一格式化入口。
 *
 * null 不是"空状态"，而是"网关 /rec/status 不可达"——必须显示「未连接」而不是 0 帧，
 * 否则用户会以为长录已停/已坏。丢帧优先级最高（红），其次是磁盘余量低/ffmpeg 重开（黄）。
 *
 * 体积口径（task-35）：主行「视频 46.2 MB」来自网关 bytesVideo（已封口 videoBytes +
 * 当前 .recording.mp4 的 stat 大小）；原始帧字节只放次行「原始 947 MB」，绝不再冒充视频体积。
 */
export function formatRecStatus(status: RecStatusWire | null | undefined): RecStatusView {
  if (status === null || status === undefined) {
    return {
      text: "长录 未连接",
      tone: "off",
      active: false,
      fps: null,
      durationText: "00:00",
      sizeText: "—",
      rawSizeText: "—",
      videoSizeText: "—",
      diskFreeText: "—",
      subText: "",
      bytesVideo: null,
      diskFreeBytes: null,
      diskLow: false,
      dropped: 0,
      restarts: 0,
      dir: "",
      title: "GET /rec/status 不可达：网关未启动，或版本过旧没有长录接口",
      session: null,
    };
  }

  const active = status.active === true;
  const p = statusParts(status);
  const fpsText = p.fps === null ? "—" : p.fps.toFixed(1);
  let text: string;
  let subText: string;
  if (!active && p.session === null) {
    text = "长录 就绪 · 点击开始";
    subText = p.diskFreeText === "—" ? "" : "磁盘余量 " + p.diskFreeText;
  } else {
    const head = active ? "长录" : "长录 已停止";
    const fields = [
      "视频 " + p.videoSizeText,
      p.durationText,
      "实际 " + fpsText + " fps",
      "丢帧 " + p.dropped,
      "磁盘余量 " + p.diskFreeText,
    ];
    text = head + " · " + fields.join(" · ");
    const sub = ["原始 " + p.rawSizeText, "重开 " + p.restarts];
    if (p.dir !== "") sub.push(p.dir);
    subText = sub.join(" · ");
  }

  const tone: RecTone = p.dropped > 0 ? "bad" : p.diskLow || p.restarts > 0 ? "warn" : active ? "ok" : "off";
  const titleBits: string[] = [];
  const full = recFullPath(status.root, p.session);
  titleBits.push(full === "" ? "长录尚未开始" : full);
  titleBits.push("视频 " + p.videoSizeText + " · 原始 " + p.rawSizeText + " · 磁盘余量 " + p.diskFreeText);
  if (str(status.reason) !== "") titleBits.push("停止原因: " + str(status.reason));
  if (str(status.ffmpeg?.lastError) !== "") titleBits.push("ffmpeg: " + str(status.ffmpeg?.lastError));
  return {
    text,
    tone,
    active,
    fps: p.fps,
    durationText: p.durationText,
    sizeText: p.sizeText,
    rawSizeText: p.rawSizeText,
    videoSizeText: p.videoSizeText,
    diskFreeText: p.diskFreeText,
    subText,
    bytesVideo: p.bytesVideo,
    diskFreeBytes: p.diskFreeBytes,
    diskLow: p.diskLow,
    dropped: p.dropped,
    restarts: p.restarts,
    dir: p.dir,
    title: titleBits.join(" · "),
    session: p.session,
  };
}

/** 胶囊/文字的颜色只由 tone 决定，main.ts 不再散落 if */
export function recToneColor(tone: RecTone): string {
  switch (tone) {
    case "bad":
      return "var(--on)";
    case "warn":
      return "var(--warn)";
    case "ok":
      return "var(--ok)";
    default:
      return "var(--tx3)";
  }
}

/**
 * 长录按钮的 start/stop 状态机：只由网关 active（+ 请求在途）决定。
 * 绝不用前端本地布尔：刷新页面后必须从 GET /rec/status 恢复。
 */
export function recButtonState(active: boolean, busy = false): RecButtonState {
  if (active) {
    return {
      label: "■ 停止长录",
      action: "stop",
      disabled: busy,
      title: "停止网关长录（POST /rec/stop）；已录的 chunk 会转封装成可播放 mp4",
    };
  }
  return {
    label: "● 长录",
    action: "start",
    disabled: busy,
    title: "开始网关长录（POST /rec/start）：完整帧进 mp4，事件/帧表落 CSV",
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function wireError(j: unknown, fallback: string): string {
  if (isObject(j) && typeof j["error"] === "string" && j["error"] !== "") return j["error"];
  return fallback;
}

/**
 * 读状态：任何失败都返回 null（调用方显示「未连接」），绝不把异常抛到渲染循环里。
 * 旧面板（没有 /rec）返回 404 HTML 也走这条路，不会污染控制台成未处理 rejection。
 */
export async function fetchRecStatus(fetchImpl: RecFetch = (input, init) => fetch(input, init)): Promise<RecStatusWire | null> {
  try {
    const res = await fetchImpl("/rec/status", { cache: "no-store" });
    if (!res.ok) return null;
    const j = await readJson(res);
    if (!isObject(j) || j["ok"] === false) return null;
    return j as RecStatusWire;
  } catch {
    return null;
  }
}

async function postRec(path: string, fetchImpl: RecFetch): Promise<RecRequestResult> {
  try {
    const res = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    });
    const j = await readJson(res);
    if (!res.ok || (isObject(j) && j["ok"] === false)) {
      return {
        ok: false,
        error: wireError(j, "HTTP " + res.status + " " + path),
        httpStatus: res.status,
      };
    }
    if (!isObject(j)) {
      return { ok: false, error: "网关返回的不是 JSON 对象: " + path, httpStatus: res.status };
    }
    return { ok: true, status: j as RecStatusWire, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startRec(fetchImpl: RecFetch = (input, init) => fetch(input, init)): Promise<RecRequestResult> {
  return postRec("/rec/start", fetchImpl);
}

export function stopRec(fetchImpl: RecFetch = (input, init) => fetch(input, init)): Promise<RecRequestResult> {
  return postRec("/rec/stop", fetchImpl);
}
