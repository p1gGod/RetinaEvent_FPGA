// 独立复核器（tools/replay-verify.ts）
//
// 职责：把 host/testdata/golden/*.rtpkt 重放一遍，与同名 .expected.json 逐字段比对。
// 独立性来自两点（这是它存在的全部理由）：
//   1) 不 import gateway —— 组帧逻辑在本文件朴素重写（按 CHUNK_IDX 定位 + 集合计满），
//      与 gateway/pipeline 的 assembler 是两套实现，g01 的 sha256 因此成为交叉校验；
//   2) 每条包同时用两条路径判读：
//        a. 本文件"照 02 文档手写偏移 + 查表 CRC16 + 手写事件解码"；
//        b. @retina/protocol 的 parseV2Packet / parseV1Packet / decodeEvents / crc16。
//      两者对不上就记进 mismatches —— 说明向量与协议实现至少有一方错了。
//
// g02 用的事件布局（gateway-core 关心的那处）：EV_REC_BYTES = 5，
//   [0]=x_lo, [1]=x_hi(bit0 = x[8]，bit1..7 保留), [2]=y, [3]=pol(bit0，bit1..7 保留), [4]=ts8(忽略)。
//   生成器把保留位与 ts8 都填成非 0，专门验证 P6"只取 x/y/pol"。
//
// 运行：cd host/app && node --experimental-strip-types tools/replay-verify.ts [--dir <路径>]

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COUNTER_KEYS, FrameIndexUnwrapper, bump, createCounters, crc16, decodeEvents, gapOf,
  getProfile, iterRtpkt, parseV1Packet, parseV2Packet,
} from "@retina/protocol";
import type { Counters, CountersKey, Profile } from "@retina/protocol";

// ── 照 02 文档手写的线格式常数（与生成器各自独立，故意不共用） ────────────────
const V2_MAGIC = [0xf0, 0x5a, 0xa5, 0x0f];
const V2_HDR = 13;
const MAX_PAYLOAD = 1472;
const SEG_RAW = 0b01;
const SEG_EV = 0b10;
const SEG_RESERVED_MASK = 0b1111_1100;
const V1_HDR = 10;
const V1_FIRST = 1290;

/** CRC-16/CCITT-FALSE 查表实现（poly 0x1021、init 0xFFFF）：与生成器的逐位实现分开写，互为对照 */
const CRC_TABLE = ((): Uint16Array => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = (c & 0x8000) !== 0 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

function crc16Table(bytes: Uint8Array, end: number): number {
  let c = 0xffff;
  for (let i = 0; i < end; i++) c = ((c << 8) ^ (CRC_TABLE[((c >> 8) ^ (bytes[i] ?? 0)) & 0xff] ?? 0)) & 0xffff;
  return c & 0xffff;
}

function be16(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)) & 0xffff;
}

function magicOk(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  for (let i = 0; i < 4; i++) if (b[i] !== V2_MAGIC[i]) return false;
  return true;
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// ── 结果契约 ────────────────────────────────────────────────────────────

export interface SimpleEvent {
  readonly x: number;
  readonly y: number;
  readonly pol: 0 | 1;
}

export interface ObservedFrame {
  readonly frameIdx: number;
  readonly raw: Uint8Array;
  readonly events: readonly SimpleEvent[];
}

export interface ReplayResult {
  readonly packets: number;
  /** 只含"完整交付"的原始帧（纯事件包不产生帧） */
  readonly frames: readonly ObservedFrame[];
  /** 出现过的 frameIdx 序列（换帧时记录，用于回绕判步长） */
  readonly frameIdxSeq: readonly number[];
  readonly allEvents: readonly SimpleEvent[];
  /** 累计被接受的 RAW_LEN 之和（含未凑齐帧的已收段） */
  readonly bytesRaw: number;
  readonly eventCount: number;
  readonly counters: Counters;
  /** 两条判读路径的不一致清单：非空即视为复核失败 */
  readonly mismatches: readonly string[];
}

// ── 手写事件解码（02 §2.4 表：只取 x/y/pol，保留位与 ts8 一律忽略 —— P6） ──────

function decodeSimple(data: Uint8Array, recBytes: number): SimpleEvent[] {
  const n = Math.floor(data.length / recBytes);
  const out: SimpleEvent[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * recBytes;
    out.push({
      x: (data[o] ?? 0) | (((data[o + 1] ?? 0) & 0x01) << 8),
      y: data[o + 2] ?? 0,
      pol: ((data[o + 3] ?? 0) & 0x01) === 1 ? 1 : 0,
    });
  }
  return out;
}

// ── 单包判读（本文件路径） ──────────────────────────────────────────────

type Judgement =
  | {
      readonly kind: "accept";
      readonly frameIdx: number;
      readonly segMask: number;
      readonly chunkIdx: number;
      readonly rawLen: number;
      readonly evLen: number;
      readonly withCrc: boolean;
    }
  | { readonly kind: "reject"; readonly reason: CountersKey; readonly detail: string };

function judgeV2(pkt: Uint8Array, profile: Profile): Judgement {
  if (pkt.length < V2_HDR) return { kind: "reject", reason: "truncated", detail: "len=" + pkt.length + " < 13" };
  if (!magicOk(pkt)) return { kind: "reject", reason: "badMagic", detail: "前 4 字节不是 F0 5A A5 0F" };
  if (pkt.length > MAX_PAYLOAD) return { kind: "reject", reason: "oversize", detail: "len=" + pkt.length };
  const rawLen = be16(pkt, 9);
  const evLen = be16(pkt, 11);
  const body = V2_HDR + rawLen + evLen;
  const withCrc = pkt.length === body + 2;
  if (pkt.length !== body && !withCrc) return { kind: "reject", reason: "badLength", detail: "len=" + pkt.length + " body=" + body };
  // 与 protocol 同一条 profile 规则：声明无 CRC 却多出 2 字节 → badLength（两边判读必须同源，否则对拍会假红）
  if (profile.crc16 === "none" && withCrc) return { kind: "reject", reason: "badLength", detail: "profile 声明无 CRC16，却多出 2 字节" };
  if (rawLen > MAX_PAYLOAD || evLen > MAX_PAYLOAD) return { kind: "reject", reason: "oversize", detail: "raw=" + rawLen + " ev=" + evLen };
  if (withCrc) {
    const want = be16(pkt, body);
    const got = crc16Table(pkt, body);
    if (want !== got) return { kind: "reject", reason: "crcFail", detail: "want=0x" + want.toString(16) + " got=0x" + got.toString(16) };
  }
  return {
    kind: "accept", frameIdx: be16(pkt, 4), segMask: pkt[6] ?? 0, chunkIdx: be16(pkt, 7), rawLen, evLen, withCrc,
  };
}

// ── 朴素组帧（本文件路径；与 gateway 的 assembler 互不相干） ─────────────────

interface V2Frame {
  idx: number;
  chunkIdx: number;
  /** 该帧是否声明过原始段（SEG_MASK.bit0=1）：只有它才参与"缺块 → aborted"的结算 */
  expectsRaw: boolean;
}

function assembleChunks(chunks: readonly (Uint8Array | null)[], rawChunk: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === null || c === undefined) throw new Error("缺块 chunkIdx=" + i); // 只有 got==n 才会调用
    out.set(c, i * rawChunk);
  }
  return out;
}

function replayV2(payloads: readonly Uint8Array[], profile: Profile, res: MutableResult): void {
  const n = profile.chunksPerFrame;
  let cur: V2Frame | null = null;
  let chunks: (Uint8Array | null)[] = [];
  let got = 0;
  let events: SimpleEvent[] = [];

  const settleAborted = (): void => {
    if (cur !== null && cur.expectsRaw && got < n) bump(res.counters, "aborted");
  };

  let i = -1;
  for (const pkt of payloads) {
    i++;
    const mine = judgeV2(pkt, profile);
    const theirs = parseV2Packet(pkt, { profile });

    // 两条路径逐包对拍：任何一侧接受/拒绝与另一侧不同，或包头字段不同，都记 mismatch
    if (mine.kind === "reject") {
      if (theirs.ok) res.mismatches.push("#" + i + " 本文件判 " + mine.reason + "，protocol 判接受");
      else if (theirs.reason !== mine.reason) res.mismatches.push("#" + i + " 拒绝原因不一致：本文件 " + mine.reason + " vs protocol " + theirs.reason);
      bump(res.counters, mine.reason);
      continue;
    }
    if (!theirs.ok) {
      // 两条路径矛盾时按 protocol 的原因计数（它是协议权威），并记 mismatch ⇒ 测试必红，逼人查清谁错
      res.mismatches.push("#" + i + " protocol 判 " + theirs.reason + "，本文件判接受");
      bump(res.counters, theirs.reason);
      continue;
    }
    const v = theirs.value;
    if (v.frameIdx !== mine.frameIdx || v.segMask !== mine.segMask || v.chunkIdx !== mine.chunkIdx
      || v.rawLen !== mine.rawLen || v.evLen !== mine.evLen || v.crc16Present !== mine.withCrc) {
      res.mismatches.push("#" + i + " 包头字段与 protocol 不一致");
    }
    if ((v.segMask & SEG_RESERVED_MASK) !== 0) bump(res.counters, "segNotice");
    if (v.hasRaw !== mine.rawLen > 0) bump(res.counters, "segInconsistent");

    // 帧生命周期：按包自带的 FRAME_IDX 分组（02 §2.6）
    if (cur === null || cur.idx !== mine.frameIdx) {
      settleAborted();
      if (cur !== null) bump(res.counters, "idxGap", gapOf(cur.idx, mine.frameIdx) - 1);
      cur = { idx: mine.frameIdx, chunkIdx: 0, expectsRaw: false };
      chunks = new Array<Uint8Array | null>(n).fill(null);
      got = 0;
      events = [];
      res.frameIdxSeq.push(mine.frameIdx);
    }

    if ((mine.segMask & SEG_RAW) !== 0) {
      cur.expectsRaw = true;
      if (mine.chunkIdx >= n) {
        bump(res.counters, "badLength");
      } else if (chunks[mine.chunkIdx] !== null) {
        // 重复块：数据取先到者（02 §8"后者忽略"），但它同样"通过校验被接受" ⇒ RAW_LEN 仍计入 bytesRaw，
        // 否则 bytesRaw 与 packets 对不上账、重复块被静默吞掉（lead 裁决，g07 钉死）
        res.bytesRaw += mine.rawLen;
        bump(res.counters, "dupChunk");
      } else {
        chunks[mine.chunkIdx] = pkt.subarray(V2_HDR, V2_HDR + mine.rawLen);
        got++;
        res.bytesRaw += mine.rawLen;
      }
    }

    if ((mine.segMask & SEG_EV) !== 0 && mine.evLen > 0) {
      const rec = profile.evRecBytes;
      const partial = mine.evLen % rec;
      if (partial !== 0) bump(res.counters, "evPartial");
      const evBytes = pkt.subarray(V2_HDR + mine.rawLen, V2_HDR + mine.rawLen + mine.evLen);
      const simple = decodeSimple(evBytes, rec);
      const proto = decodeEvents(evBytes, rec);
      if (proto.partialBytes !== partial) res.mismatches.push("#" + i + " 事件余数字节不一致：本文件 " + partial + " vs protocol " + proto.partialBytes);
      if (proto.records.length !== simple.length) {
        res.mismatches.push("#" + i + " 事件条数不一致：本文件 " + simple.length + " vs protocol " + proto.records.length);
      } else {
        for (let k = 0; k < simple.length; k++) {
          const a = simple[k] as SimpleEvent;
          const b = proto.records[k];
          if (b === undefined || b.x !== a.x || b.y !== a.y || b.pol !== a.pol) {
            res.mismatches.push("#" + i + " 第 " + k + " 条事件解码不一致");
            break;
          }
        }
      }
      for (const e of simple) events.push(e);
      res.eventCount += simple.length;
      for (const e of simple) res.allEvents.push(e);
    }

    if (got === n && cur !== null) {
      res.frames.push({ frameIdx: cur.idx, raw: assembleChunks(chunks, profile.rawChunk, profile.frame.bytes), events });
      cur = null;
    }
  }
  // 回放结束：仍在装的未完成原始帧也要结算（数据源 finish，不静默丢帧）
  settleAborted();
}

function replayLegacy(payloads: readonly Uint8Array[], profile: Profile, res: MutableResult): void {
  let cur: { idx: number; buf: Uint8Array; filled: number } | null = null;
  let i = -1;
  for (const pkt of payloads) {
    i++;
    const myFirst = pkt.length >= V1_FIRST && magicOk(pkt);
    const theirs = parseV1Packet(pkt, { profile, expectChunk: cur === null ? null : 1 });
    if (myFirst) {
      const w = be16(pkt, 4);
      const h = be16(pkt, 6);
      const idx = be16(pkt, 8);
      if (!theirs.ok || !theirs.value.isFirst) res.mismatches.push("#" + i + " v1 首包：protocol 未判为首包");
      else if (theirs.value.w !== w || theirs.value.h !== h || theirs.value.frameIdx !== idx) {
        res.mismatches.push("#" + i + " v1 首包字段与 protocol 不一致");
      }
      if (cur !== null && cur.filled < profile.frame.bytes) bump(res.counters, "aborted");
      if (cur !== null) bump(res.counters, "idxGap", gapOf(cur.idx, idx) - 1);
      cur = { idx, buf: new Uint8Array(profile.frame.bytes), filled: 0 };
      res.frameIdxSeq.push(idx);
      const take = Math.min(profile.rawChunk, pkt.length - V1_HDR);
      cur.buf.set(pkt.subarray(V1_HDR, V1_HDR + take), 0);
      cur.filled = take;
      res.bytesRaw += take;
    } else {
      if (pkt.length !== profile.rawChunk) {
        bump(res.counters, "badLength");
        continue;
      }
      if (cur === null) {
        bump(res.counters, "badLength"); // 还没见首包就来数据包（02 §4）
        continue;
      }
      if (!theirs.ok) res.mismatches.push("#" + i + " v1 数据包：protocol 判 " + theirs.reason);
      else if (theirs.value.isFirst) res.mismatches.push("#" + i + " v1 数据包被 protocol 判为首包");
      cur.buf.set(pkt, cur.filled);
      cur.filled += pkt.length;
      res.bytesRaw += pkt.length;
    }
    if (cur !== null && cur.filled === profile.frame.bytes) {
      res.frames.push({ frameIdx: cur.idx, raw: cur.buf, events: [] });
      cur = null;
    }
  }
  if (cur !== null && cur.filled < profile.frame.bytes) bump(res.counters, "aborted");
}

interface MutableResult {
  packets: number;
  frames: ObservedFrame[];
  frameIdxSeq: number[];
  allEvents: SimpleEvent[];
  bytesRaw: number;
  eventCount: number;
  counters: Counters;
  mismatches: string[];
}

/** 重放一串 UDP 负载（纯函数；测试与 CLI 共用） */
export function replay(payloads: readonly Uint8Array[], profile: Profile): ReplayResult {
  const res: MutableResult = {
    packets: payloads.length, frames: [], frameIdxSeq: [], allEvents: [],
    bytesRaw: 0, eventCount: 0, counters: createCounters(), mismatches: [],
  };
  if (profile.wire === "LEGACY") replayLegacy(payloads, profile, res);
  else replayV2(payloads, profile, res);
  return res;
}

// ── expected.json 契约（packages/protocol/README.md §4） ─────────────────

export interface GoldenExpect {
  readonly frames: number;
  readonly frameIdx: readonly number[];
  readonly bytesRaw: number;
  readonly eventCount: number;
  readonly counters: Readonly<Record<string, number>>;
}

export interface GoldenExpected {
  readonly id: string;
  readonly profile: string;
  readonly description: string;
  readonly packets: number;
  readonly expect: GoldenExpect;
  readonly rawSha256: string | null;
}

/**
 * 事件真值从 <id>.events.json 读取（README §4.1）：真值放在数据文件里才可审计，
 * 也避免"测试代码里的常量"与生成器一起错。文件内容是 [{x,y,pol}]。
 */
async function loadEventTruth(dir: string, id: string): Promise<readonly (readonly [number, number, 0 | 1])[] | null> {
  try {
    const rows = JSON.parse(await readFile(resolve(dir, id + ".events.json"), "utf8")) as readonly { x: number; y: number; pol: number }[];
    return rows.map((e) => [e.x, e.y, e.pol === 1 ? 1 : 0] as const);
  } catch {
    return null; // 该向量没有逐条事件真值
  }
}

export interface VerifyReport {
  readonly id: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly packets: number;
  readonly frames: number;
  readonly bytesRaw: number;
  readonly eventCount: number;
  readonly counterSummary: string;
}

function checkEvents(report: { problems: string[] }, got: readonly SimpleEvent[], truth: readonly (readonly [number, number, 0 | 1])[]): void {
  if (got.length !== truth.length) {
    report.problems.push("事件条数 " + got.length + " ≠ 真值 " + truth.length);
    return;
  }
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i] as readonly [number, number, 0 | 1];
    const g = got[i] as SimpleEvent;
    if (g.x !== t[0] || g.y !== t[1] || g.pol !== t[2]) {
      report.problems.push("第 " + i + " 条事件 (" + g.x + "," + g.y + "," + g.pol + ") ≠ 真值 (" + t.join(",") + ")");
      return;
    }
  }
}

/** 单向量核对：文件 → 重放 → 与 expected.json 逐字段比对 */
export async function verifyVector(dir: string, id: string): Promise<VerifyReport> {
  const problems: string[] = [];
  const boot = { problems };
  const expectedPath = resolve(dir, id + ".expected.json");
  const rtpktPath = resolve(dir, id + ".rtpkt");

  const expected = JSON.parse(await readFile(expectedPath, "utf8")) as GoldenExpected;
  if (expected.id !== id) problems.push("expected.id=" + expected.id + " 与文件名 " + id + " 不一致");
  for (const key of ["id", "profile", "description", "packets", "expect", "rawSha256"]) {
    if (!(key in (expected as unknown as Record<string, unknown>))) problems.push("expected.json 缺字段 " + key);
  }
  const profile = getProfile(expected.profile);
  if (profile === null) {
    return { id, ok: false, problems: [...problems, "未知 profile " + expected.profile], packets: 0, frames: 0, bytesRaw: 0, eventCount: 0, counterSummary: "-" };
  }

  const payloads = [...iterRtpkt(await readFile(rtpktPath))];
  const res = replay(payloads, profile);
  const truth = await loadEventTruth(dir, id);

  if (res.packets !== expected.packets) problems.push("packets " + res.packets + " ≠ expected " + expected.packets);
  if (res.frames.length !== expected.expect.frames) problems.push("frames " + res.frames.length + " ≠ expected " + expected.expect.frames);
  const gotIdx = res.frames.map((f) => f.frameIdx);
  if (gotIdx.join(",") !== expected.expect.frameIdx.join(",")) problems.push("frameIdx [" + gotIdx.join(",") + "] ≠ expected [" + expected.expect.frameIdx.join(",") + "]");
  if (res.bytesRaw !== expected.expect.bytesRaw) problems.push("bytesRaw " + res.bytesRaw + " ≠ expected " + expected.expect.bytesRaw);
  if (res.eventCount !== expected.expect.eventCount) problems.push("eventCount " + res.eventCount + " ≠ expected " + expected.expect.eventCount);

  for (const [key, want] of Object.entries(expected.expect.counters)) {
    if (!(COUNTER_KEYS as readonly string[]).includes(key)) problems.push("counters 里出现未知计数名 " + key);
    const got = (res.counters as unknown as Record<string, number>)[key] ?? 0;
    if (got !== want) problems.push("counter " + key + " = " + got + " ≠ expected " + want);
  }

  if (expected.rawSha256 === null) {
    if (res.frames.length > 0) problems.push("expected.rawSha256=null 却交付了 " + res.frames.length + " 帧");
  } else {
    const first = res.frames[0];
    if (first === undefined) problems.push("expected.rawSha256 非 null 但没有交付帧");
    else if (sha256Hex(first.raw) !== expected.rawSha256) problems.push("rawSha256 不一致：实得 " + sha256Hex(first.raw));
  }

  // 逐向量专项判据（02 §10 的 V2/V3/V4/V5）
  if (truth !== null) {
    checkEvents(boot, res.allEvents, truth);
    // 保留位必须真的非 0，否则这条向量并没有在检验"忽略保留位"（P6）
    let reservedSeen = 0;
    for (const pkt of payloads) {
      const rawLen = be16(pkt, 9);
      const evLen = be16(pkt, 11);
      const ev = pkt.subarray(V2_HDR + rawLen, V2_HDR + rawLen + evLen);
      for (let k = 0; k + 5 <= ev.length; k += 5) {
        if (((ev[k + 1] ?? 0) & 0xfe) !== 0 || ((ev[k + 3] ?? 0) & 0xfe) !== 0) reservedSeen++;
      }
    }
    if (reservedSeen !== truth.length) problems.push("保留位非 0 的记录数 " + reservedSeen + " ≠ 真值条数 " + truth.length + "（P6 未被真正检验）");
  }
  if (id === "g02_ev_only") {
    if (truth === null) problems.push("缺 g02_ev_only.events.json：事件真值必须外置（README §4.1）");
    if (res.frames.length !== 0) problems.push("纯事件流不应产出原始帧");
    if ((res.counters as unknown as Record<string, number>)["aborted"] !== 0) problems.push("纯事件流不应计 aborted（语义已冻结）");
  }
  if (id === "g04_wrap") {
    if (res.frameIdxSeq.join(",") !== "65535,0") problems.push("frameIdx 序列应为 65535,0，实得 [" + res.frameIdxSeq.join(",") + "]");
    const unwrap = new FrameIndexUnwrapper();
    const g0 = unwrap.push(65535);
    const g1 = unwrap.push(0);
    if (g1.gap !== 1 || g1.wraps !== 1 || g0.gap !== 0) problems.push("回绕步长应为 1、wraps=1，实得 gap=" + g1.gap + " wraps=" + g1.wraps);
    if ((res.counters as unknown as Record<string, number>)["idxGap"] !== 0) problems.push("回绕不应计 idxGap");
  }
  if (id === "g05_bad_crc") {
    if ((res.counters as unknown as Record<string, number>)["crcFail"] !== 1) problems.push("应恰好 1 个包 crcFail");
    if (res.bytesRaw !== 3 * profile.rawChunk) problems.push("坏包不得计入 bytesRaw");
  }
  if (id === "g03_drop_chunk") {
    if ((res.counters as unknown as Record<string, number>)["aborted"] !== 1) problems.push("g03 必须恰好 aborted=1");
    if (res.frames.length !== 0) problems.push("g03 不得交付任何帧");
  }
  if (id === "g07_dup_chunk") {
    if ((res.counters as unknown as Record<string, number>)["dupChunk"] !== 1) problems.push("g07 必须恰好 dupChunk=1");
    // 3 个包都通过校验（含重复块）⇒ bytesRaw 是 3 段而不是 2 段；这正是 g07 要钉死的口径
    if (res.bytesRaw !== 3 * profile.rawChunk) problems.push("重复块也必须计入 bytesRaw（应为 " + 3 * profile.rawChunk + "，实得 " + res.bytesRaw + "）");
    if (res.frames.length !== 0) problems.push("g07 帧不齐，不得交付任何帧");
    if ((res.counters as unknown as Record<string, number>)["aborted"] !== 1) problems.push("g07 必须恰好 aborted=1（flush 结算）");
  }

  if (res.mismatches.length > 0) problems.push("朴素判读与 protocol 不一致：" + res.mismatches.slice(0, 5).join("；"));

  const counters = res.counters as unknown as Record<string, number>;
  const counterSummary = COUNTER_KEYS.filter((k) => counters[k] !== 0).map((k) => k + "=" + counters[k]).join(",") || "全 0";
  return {
    id, ok: problems.length === 0, problems, packets: res.packets,
    frames: res.frames.length, bytesRaw: res.bytesRaw, eventCount: res.eventCount, counterSummary,
  };
}

/** 核对目录下全部向量（按 id 排序） */
export async function verifyAll(dir: string): Promise<VerifyReport[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".expected.json")).sort();
  const reports: VerifyReport[] = [];
  for (const n of names) reports.push(await verifyVector(dir, n.slice(0, -".expected.json".length)));
  return reports;
}

export const DEFAULT_GOLDEN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "testdata", "golden");

async function main(argv: readonly string[]): Promise<number> {
  const flag = argv.indexOf("--dir");
  const arg = flag >= 0 ? argv[flag + 1] : argv[0];
  const dir = arg === undefined ? DEFAULT_GOLDEN_DIR : isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  const reports = await verifyAll(dir);
  console.log("独立复核 " + dir + " （" + reports.length + " 组向量）");
  let failed = 0;
  for (const r of reports) {
    console.log(
      (r.ok ? "PASS" : "FAIL") + "  " + r.id.padEnd(16) +
      " packets=" + String(r.packets).padStart(4) +
      " frames=" + r.frames +
      " bytesRaw=" + String(r.bytesRaw).padStart(6) +
      " events=" + String(r.eventCount).padStart(3) +
      "  " + r.counterSummary,
    );
    for (const p of r.problems) console.log("        - " + p);
    if (!r.ok) failed++;
  }
  console.log(failed === 0 ? "全部通过（" + reports.length + "/" + reports.length + "）" : "失败 " + failed + " 组");
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
