// golden 向量生成器（tools/gen-golden.ts）
//
// 为什么这里"手写偏移"而不用 packages/protocol 的常量或 parse 函数：
//   生成器一旦与解析器共用同一份实现，"golden 回归"就只能证明自己等于自己。
//   本文件照 02 文档 §2.1（v2 包头）、§2.4（事件记录）、§4（v1 首包）逐字段写偏移，
//   让向量成为"按文档独立造出来的字节流"——解析器的偏移/长度/CRC 写错时回归才会红。
//   只有 RTPKT 容器复用 @retina/protocol 的 encodeRtpkt：它是回放格式的唯一权威实现，且不做协议解析。
//
// 运行：cd host/app && npm run golden:gen   （输出到 host/testdata/golden/）

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeRtpkt, getProfile } from "@retina/protocol";

// ── 线格式常数（照文档手写；实测值与 02 文档 §2.1/§2.3/§4 一一对应） ──────────────
/** 02 §2.1：魔数 F0 5A A5 0F（v1 同魔数，缺口 G6） */
const V2_MAGIC = new Uint8Array([0xf0, 0x5a, 0xa5, 0x0f]);
/** 02 §2.1：13 字节定长包头各字段偏移 */
const V2 = { FRAME_IDX: 4, SEG_MASK: 6, CHUNK_IDX: 7, RAW_LEN: 9, EV_LEN: 11, HDR: 13 } as const;
const SEG_RAW = 0b01;
const SEG_EV = 0b10;
/** 02 §2.3：一帧 800×480 RGB565 = 768000 B，RAW_CHUNK=1024 ⇒ 750 包整除 */
const FRAME_W = 800;
const FRAME_H = 480;
const FRAME_BYTES = 768_000;
const RAW_CHUNK = 1024;
const CHUNKS_PER_FRAME = 750;
/** 02 §4：v1 首包 = 10 B 头 + 1280 B 数据；一帧 600 包。⚠️ 大端（与 UART 遥测相反） */
const V1 = { HDR: 10, DATA: 1280, PKT: 600, W: 4, H: 6, FRAME_IDX: 8 } as const;

/** 事件记录长度：与 profile evRecBytes 一致（缺口 G2，当前默认 5） */
const EV_REC_BYTES = 5;
/** 02 §2.4 的 5B 布局偏移 */
const EV = { X_LO: 0, X_HI: 1, Y: 2, POL: 3, TS8: 4 } as const;
/** 保留位故意填非 0：验证上位机确实忽略它们（判据 P6） */
const EV_RESERVED_HI = 0x80;
const EV_RESERVED_POL = 0xc0;

/** 02 §2.4 表的事件真值（x∈[0,399]、y∈[0,239]、pol 1=ON） */
interface GoldenEvent {
  readonly x: number;
  readonly y: number;
  readonly pol: 0 | 1;
}

// ── 字节流构造 ──────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT-FALSE（poly 0x1021、init 0xFFFF、不反转、不异或输出）。
 * 公开检查值：crc16("123456789") === 0x29B1（测试里对拍）。
 * 与 RTL `udp_merge.v` 的 `crc16_step`（初值 16'hFFFF）逐位一致。
 * 与 tools/replay-verify.ts 的查表实现、@retina/protocol 的逐位实现，三者互为对照。
 */
function crc16Bitwise(bytes: Uint8Array, end: number): number {
  let crc = 0xffff;
  for (let i = 0; i < end; i++) {
    crc ^= ((bytes[i] ?? 0) << 8) & 0xffff;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** 确定性伪随机原始像素：任何块错位/丢块都会改变整帧 sha256 */
function makeRaw(seed: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = (seed * 2654435761 + 1013904223) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** 按 02 §2.4 编码一条事件；保留位填非 0，用来验证"忽略保留位"（P6） */
function encodeEventRecord(e: GoldenEvent, index: number): Uint8Array {
  const r = new Uint8Array(EV_REC_BYTES);
  r[EV.X_LO] = e.x & 0xff;
  r[EV.X_HI] = ((e.x >> 8) & 0x01) | EV_RESERVED_HI;
  r[EV.Y] = e.y & 0xff;
  r[EV.POL] = (e.pol & 0x01) | EV_RESERVED_POL;
  r[EV.TS8] = (0xa5 + index * 7) & 0xff;
  return r;
}

function encodeEvents(list: readonly GoldenEvent[], from: number, count: number): Uint8Array {
  const out = new Uint8Array(count * EV_REC_BYTES);
  for (let i = 0; i < count; i++) out.set(encodeEventRecord(list[from + i] as GoldenEvent, from + i), i * EV_REC_BYTES);
  return out;
}

interface V2Spec {
  readonly frameIdx: number;
  readonly segMask: number;
  readonly chunkIdx: number;
  readonly raw: Uint8Array | null;
  readonly evData: Uint8Array | null;
  /** true = 尾部带 2B CRC16；两种长度上位机都必须能吃（02 §2.5） */
  readonly crc: boolean;
}

/** 按 02 §2.1 的偏移表直接摆字节 */
function buildV2Packet(s: V2Spec): Uint8Array {
  const rawLen = s.raw === null ? 0 : s.raw.length;
  const evLen = s.evData === null ? 0 : s.evData.length;
  const total = V2.HDR + rawLen + evLen + (s.crc ? 2 : 0);
  const out = new Uint8Array(total);
  out.set(V2_MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint16(V2.FRAME_IDX, s.frameIdx & 0xffff, false);
  out[V2.SEG_MASK] = s.segMask & 0xff;
  dv.setUint16(V2.CHUNK_IDX, 0, false);
  dv.setUint16(V2.CHUNK_IDX, s.chunkIdx & 0xffff, false);
  dv.setUint16(V2.RAW_LEN, rawLen, false);
  dv.setUint16(V2.EV_LEN, evLen, false);
  if (s.raw !== null) out.set(s.raw, V2.HDR);
  if (s.evData !== null) out.set(s.evData, V2.HDR + rawLen);
  if (s.crc) dv.setUint16(V2.HDR + rawLen + evLen, crc16Bitwise(out, V2.HDR + rawLen + evLen), false);
  return out;
}

/** 02 §4：首包 = 魔数 | H(2B BE) | V(2B BE) | FRAME_IDX(2B BE) | 1280B；其余包 = 纯 1280B */
function buildV1First(frameIdx: number, firstChunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(V1.HDR + V1.DATA);
  out.set(V2_MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint16(V1.W, FRAME_W, false);
  dv.setUint16(V1.H, FRAME_H, false);
  dv.setUint16(V1.FRAME_IDX, frameIdx & 0xffff, false);
  out.set(firstChunk, V1.HDR);
  return out;
}

// ── 向量契约（packages/protocol/README.md §4） ───────────────────────────

export interface GoldenExpect {
  readonly frames: number;
  readonly frameIdx: readonly number[];
  /** 累计被接受的 RAW_LEN 之和（含未凑齐的帧） */
  readonly bytesRaw: number;
  readonly eventCount: number;
  /** 子集比对：只有列出的键会被逐值核对（策略相关项故意不列） */
  readonly counters: Readonly<Record<string, number>>;
}

export interface GoldenExpected {
  readonly id: string;
  readonly profile: string;
  readonly description: string;
  readonly packets: number;
  readonly expect: GoldenExpect;
  /** 完整帧的 sha256（十六进制）；帧不完整/未产出帧时为 null */
  readonly rawSha256: string | null;
}

export interface GoldenVector {
  readonly id: string;
  readonly profile: string;
  readonly description: string;
  readonly payloads: readonly Uint8Array[];
  readonly expected: GoldenExpected;
  /** 需逐条核对坐标/极性时给出真值：另存为 <id>.events.json（README §4.1，禁止把真值写死在测试代码里） */
  readonly eventsTruth?: readonly GoldenEvent[];
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** 生成前核对内置 profile 与文档常数：profile 被改过就必须重算向量，不能静默漂移 */
function assertProfile(name: string, frameBytes: number, rawChunk: number, chunks: number, evRec: number): void {
  const p = getProfile(name);
  if (p === null) throw new Error("内置 profile 缺失：" + name);
  const want = [frameBytes, rawChunk, chunks, evRec].join(",");
  const got = [p.frame.bytes, p.rawChunk, p.chunksPerFrame, p.evRecBytes].join(",");
  if (got !== want) throw new Error("profile " + name + " 与 02 文档不一致：got " + got + " / want " + want);
}

// ── 7 组向量 ───────────────────────────────────────────────────────────

const V2_PROFILE = "retina-v2-800x480-e5";
const V1_PROFILE = "legacy-800x480-1280";

/** g01：一帧 750 包、无事件 ⇒ 拼出的 768000 B 必须与源逐字节相同 */
function buildG01(): GoldenVector {
  const raw = makeRaw(0x01, FRAME_BYTES);
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < CHUNKS_PER_FRAME; i++) {
    payloads.push(
      buildV2Packet({
        frameIdx: 1, segMask: SEG_RAW, chunkIdx: i,
        raw: raw.subarray(i * RAW_CHUNK, (i + 1) * RAW_CHUNK), evData: null, crc: true,
      }),
    );
  }
  return {
    id: "g01_min_frame",
    profile: V2_PROFILE,
    description: "一帧 750 包、无事件；拼出的 768000 B 应与源逐字节一致（02 §10 V2）",
    payloads,
    expected: {
      id: "g01_min_frame", profile: V2_PROFILE, packets: payloads.length,
      description: "一帧 750 包、无事件；拼出的 768000 B 应与源逐字节一致（02 §10 V2）",
      expect: { frames: 1, frameIdx: [1], bytesRaw: FRAME_BYTES, eventCount: 0, counters: { aborted: 0, badMagic: 0, badLength: 0, evPartial: 0 } },
      rawSha256: sha256Hex(raw),
    },
  };
}

/** g02 的事件真值：发送侧的唯一事实来源（replay-verify.ts 另有一份独立抄录用于对拍） */
const G02_EVENTS: readonly GoldenEvent[] = [
  { x: 0, y: 0, pol: 0 }, { x: 1, y: 239, pol: 1 }, { x: 255, y: 128, pol: 1 }, { x: 256, y: 1, pol: 0 },
  { x: 399, y: 239, pol: 1 }, { x: 300, y: 42, pol: 0 }, { x: 17, y: 200, pol: 1 }, { x: 128, y: 64, pol: 0 },
  { x: 257, y: 3, pol: 1 }, { x: 44, y: 99, pol: 0 },
  { x: 5, y: 5, pol: 1 }, { x: 258, y: 238, pol: 0 }, { x: 100, y: 100, pol: 1 }, { x: 399, y: 0, pol: 0 },
  { x: 200, y: 120, pol: 1 }, { x: 33, y: 77, pol: 0 }, { x: 266, y: 199, pol: 1 }, { x: 7, y: 8, pol: 0 },
  { x: 310, y: 45, pol: 1 }, { x: 150, y: 210, pol: 0 },
];

/**
 * g02：纯事件包 SEG_MASK=0b10（缺口 G3）。
 * 第 2 包故意让 EV_LEN % 5 = 3，检验"丢余数并计 evPartial"（判据 P5，不整包错位）。
 * 第 1 包带 CRC、第 2 包不带 ⇒ 顺带覆盖 02 §2.5 的两种长度算式。
 */
function buildG02(): GoldenVector {
  const p0 = buildV2Packet({ frameIdx: 7, segMask: SEG_EV, chunkIdx: 0, raw: null, evData: encodeEvents(G02_EVENTS, 0, 10), crc: true });
  const ev1 = new Uint8Array(10 * EV_REC_BYTES + 3);
  ev1.set(encodeEvents(G02_EVENTS, 10, 10), 0);
  ev1.fill(0x5a, 10 * EV_REC_BYTES);
  const p1 = buildV2Packet({ frameIdx: 7, segMask: SEG_EV, chunkIdx: 0, raw: null, evData: ev1, crc: false });
  const desc = "纯事件包 SEG_MASK=0b10（缺口 G3）：20 条事件，第 2 包有余数 3B，保留位非 0";
  return {
    id: "g02_ev_only", profile: V2_PROFILE, description: desc,
    payloads: [p0, p1],
    eventsTruth: G02_EVENTS,
    expected: {
      id: "g02_ev_only", profile: V2_PROFILE, packets: 2, description: desc,
      // 纯事件包不参与原始帧生命周期 ⇒ aborted 必须是 0（lead 冻结语义）
      expect: { frames: 0, frameIdx: [], bytesRaw: 0, eventCount: 20, counters: { aborted: 0, badMagic: 0, badLength: 0, crcFail: 0, evPartial: 1 } },
      rawSha256: null,
    },
  };
}

/** g03：人为删掉第 500 个包（chunkIdx=499）⇒ 帧不齐，回放结束时计 aborted=1，不产出错位图像 */
function buildG03(): GoldenVector {
  const raw = makeRaw(0x03, FRAME_BYTES);
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < CHUNKS_PER_FRAME; i++) {
    if (i === 499) continue;
    payloads.push(
      buildV2Packet({
        frameIdx: 1, segMask: SEG_RAW, chunkIdx: i,
        raw: raw.subarray(i * RAW_CHUNK, (i + 1) * RAW_CHUNK), evData: null, crc: true,
      }),
    );
  }
  const desc = "人为删掉第 500 个包（chunkIdx=499）：期望 aborted=1、不产出帧（不产生错位图像）";
  return {
    id: "g03_drop_chunk", profile: V2_PROFILE, description: desc,
    payloads,
    expected: {
      id: "g03_drop_chunk", profile: V2_PROFILE, packets: payloads.length, description: desc,
      expect: {
        frames: 0, frameIdx: [], bytesRaw: FRAME_BYTES - RAW_CHUNK, eventCount: 0,
        counters: { aborted: 1, badMagic: 0, badLength: 0, evPartial: 0 },
      },
      rawSha256: null,
    },
  };
}

/** g04：FRAME_IDX 65535 → 0。局部 2 包即可触发换帧；判步长必须用模差（02 §2.7），否则会误报 65535 的跳变 */
function buildG04(): GoldenVector {
  const rawA = makeRaw(0x40, RAW_CHUNK);
  const rawB = makeRaw(0x41, RAW_CHUNK);
  const payloads: Uint8Array[] = [
    buildV2Packet({ frameIdx: 65535, segMask: SEG_RAW, chunkIdx: 0, raw: rawA, evData: null, crc: true }),
    buildV2Packet({ frameIdx: 0, segMask: SEG_RAW, chunkIdx: 0, raw: rawB, evData: null, crc: true }),
  ];
  const desc = "FRAME_IDX 从 65535 → 0：帧号回绕，步长判为 1、不产生 idxGap 告警（02 §2.7）";
  return {
    id: "g04_wrap", profile: V2_PROFILE, description: desc,
    payloads,
    expected: {
      id: "g04_wrap", profile: V2_PROFILE, packets: payloads.length, description: desc,
      // aborted=2：帧号切换时结算 65535 的帧（永远凑不齐）+1，流结束 flush 再结算 0 的帧 +1。
      // 少结算任何一次都是真 bug —— "帧号切换那一路"最容易被漏掉，所以必须钉进契约（lead 裁决）。
      expect: { frames: 0, frameIdx: [], bytesRaw: 2 * RAW_CHUNK, eventCount: 0, counters: { idxGap: 0, aborted: 2, badMagic: 0, badLength: 0 } },
      rawSha256: null,
    },
  };
}

/**
 * g05：末包（第 4 个）的 RAW_DATA 翻转 1 bit ⇒ CRC16 必失败。
 * 坏包放末尾 + 只动载荷：长度不变 ⇒ badLength 必须为 0，且被拒的包不计入 bytesRaw（README §4.1）。
 */
function buildG05(): GoldenVector {
  const raw = makeRaw(0x05, 4 * RAW_CHUNK);
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < 4; i++) {
    const pkt = buildV2Packet({
      frameIdx: 3, segMask: SEG_RAW, chunkIdx: i,
      raw: raw.subarray(i * RAW_CHUNK, (i + 1) * RAW_CHUNK), evData: null, crc: true,
    });
    if (i === 3) pkt[V2.HDR + 16] = (pkt[V2.HDR + 16] ?? 0) ^ 0x01; // 末包动 1 bit 载荷，不动包头/长度
    payloads.push(pkt);
  }
  const desc = "末包篡改 1 个字节使 CRC16 失败：该包 crcFail 丢弃，前 3 个好包照收（02 §2.5）";
  return {
    id: "g05_bad_crc", profile: V2_PROFILE, description: desc,
    payloads,
    expected: {
      id: "g05_bad_crc", profile: V2_PROFILE, packets: payloads.length, description: desc,
      // aborted=1：好坏包同属一帧、无帧号切换 ⇒ 只有流结束 flush 结算一次（被拒的坏包只进 crcFail）
      expect: { frames: 0, frameIdx: [], bytesRaw: 3 * RAW_CHUNK, eventCount: 0, counters: { crcFail: 1, aborted: 1, badMagic: 0, badLength: 0 } },
      rawSha256: null,
    },
  };
}

/** g06：旧格式（例程 60）600 包 × 1280 B，按 LEGACY profile 解析成功（H30 实测通路） */
function buildG06(): GoldenVector {
  const raw = makeRaw(0x06, FRAME_BYTES);
  const payloads: Uint8Array[] = [buildV1First(1, raw.subarray(0, V1.DATA))];
  for (let i = 1; i < V1.PKT; i++) payloads.push(raw.subarray(i * V1.DATA, (i + 1) * V1.DATA));
  const desc = "旧格式（例程 60）：600 包 × 1280 B，按 LEGACY profile 解析成功（02 §4）";
  return {
    id: "g06_legacy", profile: V1_PROFILE, description: desc,
    payloads,
    expected: {
      id: "g06_legacy", profile: V1_PROFILE, packets: payloads.length, description: desc,
      expect: { frames: 1, frameIdx: [1], bytesRaw: FRAME_BYTES, eventCount: 0, counters: { aborted: 0, badMagic: 0, badLength: 0 } },
      rawSha256: sha256Hex(raw),
    },
  };
}

/**
 * g07：重复块口径（lead 裁决）—— 同一帧 3 个包：chunkIdx 0 / 0（同载荷重复）/ 1。
 * 关键：重复包也"通过校验被接受"，它的 RAW_LEN 必须计入 bytesRaw（同时计 dupChunk）；
 * 否则 bytesRaw 与 packets 对不上账，重复块这种异常会被静默吞掉（原则 P6 不静默）。
 */
function buildG07(): GoldenVector {
  const raw = makeRaw(0x07, 2 * RAW_CHUNK);
  const chunk0 = raw.subarray(0, RAW_CHUNK);
  const chunk1 = raw.subarray(RAW_CHUNK, 2 * RAW_CHUNK);
  const payloads: Uint8Array[] = [
    buildV2Packet({ frameIdx: 1, segMask: SEG_RAW, chunkIdx: 0, raw: chunk0, evData: null, crc: true }),
    buildV2Packet({ frameIdx: 1, segMask: SEG_RAW, chunkIdx: 0, raw: chunk0, evData: null, crc: true }), // 同载荷重复块
    buildV2Packet({ frameIdx: 1, segMask: SEG_RAW, chunkIdx: 1, raw: chunk1, evData: null, crc: true }),
  ];
  const desc = "同一帧 chunkIdx 0 / 0（重复同载荷）/ 1：重复块计入 dupChunk，其 RAW_LEN 仍计入 bytesRaw";
  return {
    id: "g07_dup_chunk", profile: V2_PROFILE, description: desc,
    payloads,
    expected: {
      id: "g07_dup_chunk", profile: V2_PROFILE, packets: 3, description: desc,
      expect: { frames: 0, frameIdx: [], bytesRaw: 3 * RAW_CHUNK, eventCount: 0, counters: { dupChunk: 1, aborted: 1, badLength: 0, badMagic: 0 } },
      rawSha256: null,
    },
  };
}

export function buildVectors(): GoldenVector[] {
  assertProfile(V2_PROFILE, FRAME_BYTES, RAW_CHUNK, CHUNKS_PER_FRAME, EV_REC_BYTES);
  assertProfile(V1_PROFILE, FRAME_BYTES, V1.DATA, V1.PKT, EV_REC_BYTES);
  return [buildG01(), buildG02(), buildG03(), buildG04(), buildG05(), buildG06(), buildG07()];
}

/** 稳定的序列化：键顺序照 README §4 的例子固定，避免"只改顺序"的假 diff */
export function expectedJsonOf(v: GoldenVector): string {
  const e = v.expected;
  const ordered = { id: e.id, profile: e.profile, description: e.description, packets: e.packets, expect: e.expect, rawSha256: e.rawSha256 };
  return JSON.stringify(ordered, null, 2) + "\n";
}

// ── 落盘 ───────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** host/app/tools → host/testdata/golden（与 02 §10 的 host/test/golden 命名不同，以 README §4 为准） */
export const GOLDEN_DIR = resolve(HERE, "..", "..", "testdata", "golden");

export interface WrittenVector {
  readonly id: string;
  readonly packets: number;
  readonly rtpktBytes: number;
  readonly expectedBytes: number;
  /** 事件真值文件字节数；该向量没有真值时为 null */
  readonly eventsBytes: number | null;
}

/** 事件真值的稳定序列化：数组 [{x,y,pol}]，可被前端/网关直接复用 */
export function eventsJsonOf(v: GoldenVector): string {
  return JSON.stringify(v.eventsTruth ?? [], null, 2) + "\n";
}

export async function writeVectors(dir: string): Promise<WrittenVector[]> {
  await mkdir(dir, { recursive: true });
  const written: WrittenVector[] = [];
  for (const v of buildVectors()) {
    const rtpkt = encodeRtpkt(v.payloads);
    const json = expectedJsonOf(v);
    await writeFile(resolve(dir, v.id + ".rtpkt"), rtpkt);
    await writeFile(resolve(dir, v.id + ".expected.json"), json, "utf8");
    let eventsBytes: number | null = null;
    if (v.eventsTruth !== undefined) {
      const evJson = eventsJsonOf(v);
      await writeFile(resolve(dir, v.id + ".events.json"), evJson, "utf8");
      eventsBytes = Buffer.byteLength(evJson, "utf8");
    }
    written.push({ id: v.id, packets: v.payloads.length, rtpktBytes: rtpkt.length, expectedBytes: Buffer.byteLength(json, "utf8"), eventsBytes });
  }
  return written;
}

async function main(): Promise<void> {
  const written = await writeVectors(GOLDEN_DIR);
  console.log("golden 向量已生成 → " + GOLDEN_DIR);
  for (const w of written) {
    const s = await stat(resolve(GOLDEN_DIR, w.id + ".rtpkt"));
    console.log("  " + w.id.padEnd(16) + " packets=" + String(w.packets).padStart(4) + "  rtpkt=" + String(s.size).padStart(7) + " B  expected.json " + w.expectedBytes + " B" + (w.eventsBytes === null ? "" : "  events.json " + w.eventsBytes + " B"));
  }
}

// 只有被直接执行才写盘；被 test 导入时不得有副作用
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
