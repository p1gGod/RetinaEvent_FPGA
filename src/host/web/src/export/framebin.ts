// 原始帧容器（.bin）：把"帧索引/时间戳/事件/检测框 + 原始像素"装进一个可回放、可被别的工具读的文件。
//
// 为什么要自己定容器而不是拼一个大数组：
//   导出的每一帧有两类需求完全不同的数据 —— ① 原始像素（768 KB/帧，大且只进不出）；
//   ② 元数据（帧号、时间、事件、检测框，小但要能被脚本直接读）。
//   把元数据放进 JSON manifest、像素原样堆在后面，就能做到"别的工具不解析整个文件也能 seek 到某一帧"，
//   代价只是多一次 UTF-8 编码。
//
// 布局（全部小端）：
//   magic     16 B  定长 ASCII（见 FRAMEBIN_MAGIC，末位是容器版本号）
//   manifestLen u32  manifest 的**字节数**（不是字符数）
//   manifest  manifestLen B  UTF-8 JSON
//   ── 之后每帧 ──
//   payloadLen u32  该帧像素字节数（= w*h*2）
//   payload   payloadLen B  原始像素（字节序由 manifest.pixel 描述）
//
// manifest 至少包含：
//   { version, createdAt, pixel, w, h, frameCount,
//     frames: [{ frameIdx, tMs, offset, bytes, w, h, pixel }] }
// 其中 offset 是 payload 在**整个文件**里的绝对偏移（指向像素本身，不含长度前缀），
// 这就是"能 seek"的关键；每帧额外带 w/h/pixel，是因为一旦允许不同分辨率的帧混录，
// 顶层字段只能描述"多数情况"，逐帧字段才是真值。
//
// 一个循环依赖（写的时候必须处理）：offset 的值写进 manifest，而 offset 又依赖 manifest 的长度。
// 解法是把 manifestLen 迭代到不动点：offset 只随 manifestLen 单调增大，位数一旦稳定就收敛
// （通常 2~3 轮）。直接取 json.length 当字节数也是错的：中文/非 ASCII 字符在 UTF-8 里 >1 字节。
import type { EventRecord } from "@retina/protocol";
import type { ViewStats } from "../types.ts";

/** 16 字节定长 magic；末位 '1' 就是容器版本，便于以后换布局时一眼区分 */
export const FRAMEBIN_MAGIC = "RETINAEV-RAWBIN1";

/** 当前容器版本，写进 manifest.version。解析时不认识就明确报错，而不是猜 */
const FRAMEBIN_VERSION = 1;

const MAGIC_BYTES = new TextEncoder().encode(FRAMEBIN_MAGIC);
/** magic + manifestLen 两个字段的总长（固定 20） */
const HEADER_PREFIX = MAGIC_BYTES.length + 4;

/**
 * 一帧录制结果。
 *
 * `raw` 的生命周期归调用方：上游（合成器/解码器）常常每帧复用同一块缓冲，
 * 所以 Recorder 拿到后必须自己复制（见 recorder.ts）。
 */
export interface RecordedFrame {
  readonly frameIdx: number;
  /** 到达时刻（Date.now()），用于算跨度和时间轴对齐 */
  readonly tMs: number;
  /**
   * 板端时间轴上的毫秒时刻（WIRE-V3 §4.3 帧时间轴；经 µs→ms 与校准 offset）。
   * 可选：v2 通路 / TS 无效时缺省 —— 导出 MP4 时"全部帧都带它"才优先用板端时间
   * （两种时间基不许混在一条时间轴上，见 export/times.ts）。
   */
  readonly tBoardMs?: number;
  readonly w: number;
  readonly h: number;
  readonly pixel: "RGB565_BE" | "RGB565_LE";
  /** w*h*2 字节；事件-only 帧（hasRaw=false）恒为空数组 */
  readonly raw: Uint8Array;
  /**
   * 这帧是否带原始像素。缺省 true（正常配帧录制与老缓冲都按有像素处理）。
   * 串口/EV_ONLY 的事件-only 帧显式 false：它们只能进 CSV/JSON，
   * 不能进 PNG/MP4/.bin（没有像素可渲染，也没有像素可对拍）。
   */
  readonly hasRaw?: boolean;
  readonly events: readonly EventRecord[];
  readonly detections: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly label: string;
    readonly score: number;
  }[];
  /**
   * 该帧到达那一刻的统计快照（HUD 导出要的是"当时"的数字，不是点导出时的）。
   *
   * 可选：纯数据容器（.bin/.csv/.json）不看它，回放时的渲染层（export/render.ts）才要，
   * 所以离线构造的帧（老文件回放、单测）不填也不该报错。
   */
  readonly stats?: ViewStats;
}

/** parseRawBin 的产物：manifest 原样（未做类型收窄，调用方按需读）+ 逐帧视图 */
export interface ParsedRawBin {
  readonly manifest: Record<string, unknown>;
  readonly frames: readonly {
    frameIdx: number;
    tMs: number;
    w: number;
    h: number;
    pixel: string;
    /** 指向入参 buf 的**零拷贝视图**（共享同一块 ArrayBuffer），长期持有请自行 slice */
    bytes: Uint8Array;
  }[];
}

/** 取 manifest 里的非负整数字段；坏值一律抛错，静默取 0 会造出"能解析但全错"的结果 */
function reqInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`RAW BIN 的 manifest 字段 ${what} 不是非负整数：${JSON.stringify(v) ?? "undefined"}`);
  }
  return v;
}

/** 取可选数值字段，缺失/坏值时回落到顶层值（逐帧 w/h/pixel 是后加的，老文件没有） */
function optNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * 组装 .bin。
 *
 * @param meta 额外写进 manifest 的字段（板卡 id、θ 门限等观测条件）。
 *        注意：`version/pixel/w/h/frameCount/frames` 由本函数计算并**覆盖** meta ——
 *        meta 只用来补信息，不允许把容器自己的描述字段写坏。
 *        `meta.createdAt`（字符串）是唯一的例外：剪裁/重打包时要保持原始录制时间。
 */
export function buildRawBin(frames: readonly RecordedFrame[], meta?: Record<string, unknown>): Uint8Array {
  const enc = new TextEncoder();
  // 事件-only 帧没有像素：manifest 会声称"这一帧存在"而 payload 是空的，
  // 下游 parseRawBin 会得到一张 0 字节的"图"。导出按钮已按 hasRaw 禁用，
  // 这里再挡一次直接调用（自检脚本/未来别的入口）。
  for (const f of frames) {
    if (f.hasRaw === false) {
      throw new Error(
        "帧 " + f.frameIdx + " 是事件-only（无原始像素），不能导出原始帧 .bin；请改用事件流 CSV 或检测结果 JSON",
      );
    }
  }
  // 先校验尺寸：w*h*2 与实际字节数不符，几乎总是上游把 stride/字节序搞错了。
  // 让它在导出这一刻炸掉，好过一个"能打开但图像错位"的文件被当成证据交出去。
  for (const f of frames) {
    if (!Number.isInteger(f.w) || !Number.isInteger(f.h) || f.w <= 0 || f.h <= 0) {
      throw new Error(`帧 ${f.frameIdx} 的尺寸非法：w=${f.w} h=${f.h}`);
    }
    const expect = f.w * f.h * 2;
    if (f.raw.length !== expect) {
      throw new Error(`帧 ${f.frameIdx} 的原始像素 ${f.raw.length} 字节 ≠ w*h*2 = ${expect}`);
    }
  }

  const first = frames[0];
  const pixel = frames.length === 0
    ? "unknown"
    : frames.every((f) => f.pixel === first?.pixel)
      ? (first?.pixel ?? "unknown")
      : "MIXED";
  const w = first?.w ?? 0;
  const h = first?.h ?? 0;
  const metaCreated = (meta ?? {})["createdAt"];
  const createdAt = typeof metaCreated === "string" ? metaCreated : new Date().toISOString();

  // manifestLen 的不动点迭代：offset 写进 manifest，而 offset 依赖 manifestLen。
  let manifestLen = 0;
  let manifestJson = "";
  for (let round = 0; ; round++) {
    const offsets: {
      frameIdx: number;
      tMs: number;
      offset: number;
      bytes: number;
      w: number;
      h: number;
      pixel: string;
    }[] = [];
    // +4：offset 指的是**本帧 payload 的起点**，不是长度前缀的位置（少加这 4 字节，
    // 解析方会在 offset-4 处读到上一段 JSON 的尾巴，报"长度前缀不一致"）
    let off = HEADER_PREFIX + manifestLen + 4;
    for (const f of frames) {
      offsets.push({
        frameIdx: f.frameIdx,
        tMs: f.tMs,
        offset: off,
        bytes: f.raw.length,
        w: f.w,
        h: f.h,
        pixel: f.pixel,
      });
      off += 4 + f.raw.length;
    }
    manifestJson = JSON.stringify({
      ...(meta ?? {}),
      version: FRAMEBIN_VERSION,
      createdAt,
      pixel,
      w,
      h,
      frameCount: frames.length,
      frames: offsets,
    });
    const len = enc.encode(manifestJson).length; // UTF-8 字节数，不能用 manifestJson.length
    if (len === manifestLen) break;
    manifestLen = len;
    if (round >= 31) throw new Error("RAW BIN manifest 长度迭代 32 轮仍不收敛（内部错误）");
  }

  let total = HEADER_PREFIX + manifestLen;
  for (const f of frames) total += 4 + f.raw.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  view.setUint32(MAGIC_BYTES.length, manifestLen, true);
  out.set(enc.encode(manifestJson), HEADER_PREFIX);
  let p = HEADER_PREFIX + manifestLen;
  for (const f of frames) {
    view.setUint32(p, f.raw.length, true);
    p += 4;
    out.set(f.raw, p);
    p += f.raw.length;
  }
  if (p !== total) throw new Error(`内部错误：RAW BIN 长度预算 ${total} ≠ 实际写入 ${p}`);
  return out;
}

/**
 * 解析 .bin。
 *
 * 坏输入一律抛**中文** Error，绝不返回半个结果：这个文件的消费方是要拿它当证据的，
 * 悄悄返回"少了几帧"的数据比直接失败危险得多。
 */
export function parseRawBin(buf: Uint8Array): ParsedRawBin {
  if (buf.length < HEADER_PREFIX) {
    throw new Error(`不是 RAW BIN：只有 ${buf.length} 字节，连 ${HEADER_PREFIX} 字节的固定头都不够`);
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[i] !== MAGIC_BYTES[i]) {
      const got = String.fromCharCode(...buf.subarray(0, MAGIC_BYTES.length));
      throw new Error(`不是 RAW BIN：magic 应为 "${FRAMEBIN_MAGIC}"，实际为 "${got}"`);
    }
  }
  // DataView 必须带上 byteOffset：buf 可能是别人传进来的 subarray，从 buffer 起点读会全错
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const manifestLen = view.getUint32(MAGIC_BYTES.length, true);
  if (manifestLen > buf.length - HEADER_PREFIX) {
    throw new Error(`RAW BIN 被截断：manifest 声明 ${manifestLen} 字节，但头部之后只剩 ${buf.length - HEADER_PREFIX} 字节`);
  }
  const manifestBytes = buf.subarray(HEADER_PREFIX, HEADER_PREFIX + manifestLen);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new Error("RAW BIN 的 manifest 不是合法 UTF-8：文件被改坏，或根本不是本工具产出的");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("RAW BIN 的 manifest 不是合法 JSON：文件被改坏，或根本不是本工具产出的");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("RAW BIN 的 manifest 不是 JSON 对象");
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest["version"] !== FRAMEBIN_VERSION) {
    throw new Error(`RAW BIN 版本不受支持：文件是 ${JSON.stringify(manifest["version"]) ?? "undefined"}，本工具只认 ${FRAMEBIN_VERSION}`);
  }
  const rawFrames = manifest["frames"];
  if (!Array.isArray(rawFrames)) {
    throw new Error("RAW BIN 的 manifest 缺少 frames 数组");
  }
  const list: readonly unknown[] = rawFrames as readonly unknown[];

  const payloadStart = HEADER_PREFIX + manifestLen;
  const topPixel = typeof manifest["pixel"] === "string" ? manifest["pixel"] : "unknown";
  const topW = optNum(manifest["w"], 0);
  const topH = optNum(manifest["h"], 0);

  const out: {
    frameIdx: number;
    tMs: number;
    w: number;
    h: number;
    pixel: string;
    bytes: Uint8Array;
  }[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (typeof e !== "object" || e === null) {
      throw new Error(`RAW BIN 第 ${i} 帧的目录项不是对象`);
    }
    const rec = e as Record<string, unknown>;
    const offset = reqInt(rec["offset"], `frames[${i}].offset`);
    const bytes = reqInt(rec["bytes"], `frames[${i}].bytes`);
    if (offset < payloadStart) {
      throw new Error(`RAW BIN 第 ${i} 帧的 offset=${offset} 落在 manifest 内部（payload 起点是 ${payloadStart}）`);
    }
    if (bytes > buf.length - offset) {
      throw new Error(`RAW BIN 第 ${i} 帧越界：offset=${offset} + bytes=${bytes} > 文件长度 ${buf.length}`);
    }
    // 长度前缀自校验：offset 前面 4 字节必须等于 bytes，否则说明 offset 指向的不是帧数据
    const prefix = view.getUint32(offset - 4, true);
    if (prefix !== bytes) {
      throw new Error(`RAW BIN 第 ${i} 帧的长度前缀 ${prefix} 与 manifest 记录的 ${bytes} 不一致（offset 没指向帧数据）`);
    }
    const tMs = rec["tMs"];
    if (typeof tMs !== "number" || !Number.isFinite(tMs)) {
      throw new Error(`RAW BIN 第 ${i} 帧的 tMs 不是有限数字：${JSON.stringify(tMs) ?? "undefined"}`);
    }
    out.push({
      frameIdx: reqInt(rec["frameIdx"], `frames[${i}].frameIdx`),
      tMs,
      w: optNum(rec["w"], topW),
      h: optNum(rec["h"], topH),
      pixel: typeof rec["pixel"] === "string" ? rec["pixel"] : topPixel,
      bytes: buf.subarray(offset, offset + bytes),
    });
  }
  return { manifest, frames: out };
}
