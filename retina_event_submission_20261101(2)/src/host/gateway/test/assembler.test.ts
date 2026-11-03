import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { EventBatch, FramePacket, ParsedV1, ParsedV2, Profile } from "@retina/protocol";
import { FrameAssembler } from "../src/pipeline/assembler.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;

/** 造一个"已解析好的 v2 包"。组装测试不该依赖 codec，喂结构体才能把失败点缩到装配算法本身 */
function v2(frameIdx: number, chunkIdx: number, raw: Uint8Array | null, events: Uint8Array | null = null): ParsedV2 {
  return {
    kind: "v2",
    frameIdx,
    segMask: (raw === null ? 0 : 1) | (events === null ? 0 : 2),
    hasRaw: raw !== null,
    hasEvents: events !== null,
    chunkIdx,
    rawLen: raw === null ? 0 : raw.length,
    evLen: events === null ? 0 : events.length,
    raw,
    events,
    crc16Present: false,
    warnings: [],
  };
}

/** 确定性帧内容：与 synth 无关，专用于本文件的逐字节断言 */
function frameBytes(frameIdx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + frameIdx * 3) & 0xff;
  return out;
}

function chunkOf(raw: Uint8Array, i: number): Uint8Array {
  return raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
}

function newAsm(opts: { frameTimeoutMs?: number; evRingMaxBytes?: number } = {}): {
  asm: FrameAssembler;
  frames: FramePacket[];
  batches: EventBatch[];
} {
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  const asm = new FrameAssembler({
    profile,
    ...(opts.frameTimeoutMs === undefined ? {} : { frameTimeoutMs: opts.frameTimeoutMs }),
    ...(opts.evRingMaxBytes === undefined ? {} : { evRingMaxBytes: opts.evRingMaxBytes }),
    onFrame: (f) => frames.push(f),
    onEvents: (b) => batches.push(b),
  });
  return { asm, frames, batches };
}

function feedCompleteFrame(asm: FrameAssembler, frameIdx: number, t0: number, raw = frameBytes(frameIdx)): void {
  for (let i = 0; i < N; i++) asm.push(v2(frameIdx, i, chunkOf(raw, i)), t0 + i);
}

test("750 段全部到齐 → 交付 1 帧 768000 B 且逐字节一致（g01 判据）", () => {
  const { asm, frames } = newAsm();
  const raw = frameBytes(1);
  feedCompleteFrame(asm, 1, 1000, raw);
  asm.finish();

  assert.equal(frames.length, 1);
  const f = frames[0] as FramePacket;
  assert.equal(f.raw.length, 768000);
  assert.equal(f.w, 800);
  assert.equal(f.h, 480);
  assert.equal(f.frameIdx, 1);
  assert.equal(f.seq, 0);
  assert.deepEqual(f.raw, raw, "装配结果必须与源逐字节相同");
  assert.equal(asm.counters.aborted, 0);
  assert.equal(asm.counters.dupChunk, 0);
  assert.equal(asm.counters.badLength, 0);
  assert.equal(asm.bytesRaw, 768000);
});

test("缺 1 段（chunkIdx=499）→ 不交付任何帧 + aborted=1 + 不产生错位图像（g03 判据）", () => {
  const { asm, frames } = newAsm();
  const raw = frameBytes(1);
  for (let i = 0; i < N; i++) {
    if (i === 499) continue;
    asm.push(v2(1, i, chunkOf(raw, i)), 1000 + i);
  }
  asm.finish();

  assert.equal(frames.length, 0, "缺块绝不能出图（出图就是错位图像）");
  assert.equal(asm.counters.aborted, 1);
  assert.equal(asm.bytesRaw, (N - 1) * CHUNK);
  assert.equal(asm.counters.dupChunk, 0);
});

test("重复块 → 后者忽略并计 dupChunk，帧仍逐字节正确", () => {
  const { asm, frames } = newAsm();
  const raw = frameBytes(2);
  for (let i = 0; i < N; i++) {
    asm.push(v2(2, i, chunkOf(raw, i)), 1000 + i);
    if (i === 10) asm.push(v2(2, i, chunkOf(raw, i)), 1001 + i); // 同一段到两次
  }
  asm.finish();
  assert.equal(frames.length, 1);
  assert.equal(asm.counters.dupChunk, 1);
  assert.equal(asm.counters.aborted, 0);
  assert.deepEqual((frames[0] as FramePacket).raw, raw);
  // 口径（§4.1 裁决）：bytesRaw 对"通过校验"的包累加 RAW_LEN，重复块也算 —— 它解析成功过，
  // 且 packets 已把它算作被接受；异常必须在统计上暴露（750 + 1 重复 = 751 包）
  assert.equal(asm.bytesRaw, 751 * CHUNK, "重复块的 RAW_LEN 也计入 bytesRaw");
  assert.equal(asm.snapshotStats(9000).bytesRaw, 751 * CHUNK, "STATS 与 getter 同源");
});

test("重复块向量（g07 形状）：3 包 0/0/1 ⇒ dupChunk=1、flush 结算 aborted=1、bytesRaw=3072", () => {
  const { asm, frames } = newAsm();
  const raw = frameBytes(1);
  asm.push(v2(1, 0, chunkOf(raw, 0)), 1);
  asm.push(v2(1, 0, chunkOf(raw, 0)), 2); // 同段二次到达
  asm.push(v2(1, 1, chunkOf(raw, 1)), 3);
  asm.finish();
  assert.equal(frames.length, 0, "只到 2/750 段，绝不能交付");
  assert.equal(asm.counters.dupChunk, 1);
  assert.equal(asm.counters.aborted, 1);
  assert.equal(asm.snapshotStats(10).packets, 3, "重复块也算被接受的包");
  assert.equal(asm.snapshotStats(11).bytesRaw, 3 * CHUNK);
  assert.equal(asm.snapshotStats(12).bytesEvents, 0);
});

test("帧号回绕 65535 → 0：步长为 1、无 idxGap、逻辑帧号单调 +1", () => {
  const { asm, frames } = newAsm();
  feedCompleteFrame(asm, 65535, 1000);
  feedCompleteFrame(asm, 0, 5000);
  asm.finish();

  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.frameIdx), [65535, 0]);
  assert.deepEqual(frames.map((f) => f.seq), [0, 1]);
  assert.equal(asm.counters.idxGap, 0);
  assert.equal(asm.counters.aborted, 0);
  assert.equal(asm.snapshotStats(9000).wraps, 1, "回绕次数要能上状态栏");
});

test("换帧时上一帧不齐 → aborted=1，且只交付新帧（不错位）", () => {
  const { asm, frames } = newAsm();
  const rawOld = frameBytes(7);
  const rawNew = frameBytes(8);
  for (let i = 0; i < 700; i++) asm.push(v2(7, i, chunkOf(rawOld, i)), 1000 + i);
  feedCompleteFrame(asm, 8, 2000, rawNew);
  asm.finish();

  assert.equal(asm.counters.aborted, 1);
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as FramePacket).frameIdx, 8);
  assert.deepEqual((frames[0] as FramePacket).raw, rawNew);
});

test("帧号跳变（10 → 13）只计 idxGap=2，不丢这两帧", () => {
  const { asm, frames } = newAsm();
  feedCompleteFrame(asm, 10, 1000);
  feedCompleteFrame(asm, 13, 2000);
  asm.finish();
  assert.equal(frames.length, 2);
  assert.equal(asm.counters.idxGap, 2);
  assert.equal(asm.counters.aborted, 0);
});

test("帧超时 → aborted=1（不交付半帧）", () => {
  const { asm, frames } = newAsm({ frameTimeoutMs: 1000 });
  asm.push(v2(5, 0, chunkOf(frameBytes(5), 0)), 10_000);
  asm.tick(10_500);
  assert.equal(frames.length, 0, "超时前不能交付");
  assert.equal(asm.counters.aborted, 0, "未到超时不能误杀");
  asm.tick(11_001);
  assert.equal(asm.counters.aborted, 1);
  assert.equal(frames.length, 0);
});

test("纯事件包（SEG_MASK=0b10）不参与原始帧生命周期：不计 aborted，flush 时成批交付", () => {
  const { asm, frames, batches } = newAsm();
  const rec = new Uint8Array([1, 0, 2, 1, 0]); // x=1,y=2,pol=1
  asm.push(v2(100, 0, null, rec), 100);
  asm.push(v2(100, 0, null, rec), 101);
  asm.finish();

  assert.equal(frames.length, 0);
  assert.equal(asm.counters.aborted, 0, "纯事件流没有'缺块'概念，不该计 aborted");
  assert.equal(batches.length, 1);
  assert.equal((batches[0] as EventBatch).records.length, 2);
  const r0 = (batches[0] as EventBatch).records[0];
  assert.deepEqual([r0?.x, r0?.y, r0?.pol], [1, 2, 1]);
});

test("帧内事件随帧一起交付，且不会重复走纯事件回调", () => {
  const { asm, frames, batches } = newAsm();
  const ev = new Uint8Array([9, 0, 8, 0, 0, 7, 0, 6, 1, 0]); // 2 条
  const raw = frameBytes(3);
  for (let i = 0; i < N; i++) {
    asm.push(v2(3, i, chunkOf(raw, i), i === 0 ? ev : null), 1000 + i);
  }
  asm.finish();
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as FramePacket).events.records.length, 2);
  assert.equal(batches.length, 0, "帧内事件随 FRAME 走，不能再单独回调一次（会重复计数）");
});

test("事件半条 → 丢余数并计 evPartial（绝不错位整包）", () => {
  const { asm, batches } = newAsm();
  // 13 B / 5 = 2 条 + 3 B 余数
  const ev = new Uint8Array(13);
  for (let i = 0; i < 13; i++) ev[i] = i;
  asm.push(v2(1, 0, null, ev), 100);
  asm.finish();
  assert.equal(asm.counters.evPartial, 1);
  assert.equal(batches.length, 1);
  assert.equal((batches[0] as EventBatch).records.length, 2);
  // 余数虽然被丢，但它在线上真实占过带宽 ⇒ 仍计入事件流量
  assert.equal(asm.snapshotStats(1).bytesEvents, 13);
  assert.equal(asm.snapshotStats(2).bytesRaw, 0, "纯事件包不能污染原始带宽口径");
});

test("STATS 口径拆分：bytesRaw 只算原始段、bytesEvents 只算事件段、bytes 是两者之和", () => {
  const { asm } = newAsm();
  const ev = new Uint8Array(50); // g02 的第一包形状：RAW_LEN=0、EV_LEN=50
  const ev2 = new Uint8Array(53);
  asm.push(v2(1, 0, null, ev), 100);
  asm.push(v2(1, 0, null, ev2), 101);
  asm.finish();
  const s = asm.snapshotStats(1000);
  assert.equal(s.bytesRaw, 0, "纯事件流的原始字节必须是 0（否则评审问'带宽'时会答错）");
  assert.equal(s.bytesEvents, 103);
  assert.equal(s.bytes, 103, "bytes 仍保持总量，供前端画带宽曲线");
});

test("事件环溢出 → 丢最旧并计 evDrop（按整条记录丢，不错位）", () => {
  const { asm, batches } = newAsm({ evRingMaxBytes: 10 }); // 只装得下 2 条 5B 记录
  for (let k = 0; k < 5; k++) {
    asm.push(v2(1, 0, null, new Uint8Array([k, 0, 1, 1, 0])), 100 + k);
  }
  asm.finish();
  assert.equal(asm.counters.evDrop, 3);
  assert.equal(batches.length, 1);
  const recs = (batches[0] as EventBatch).records;
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.x), [3, 4], "丢的是最旧的记录");
});

test("v1（LEGACY）按帧内到达顺序拼满 600 段 → 逐字节一致", () => {
  const legacy = getProfile("legacy-800x480-1280") as Profile;
  const frames: FramePacket[] = [];
  const asm = new FrameAssembler({ profile: legacy, onFrame: (f) => frames.push(f) });
  const raw = new Uint8Array(legacy.frame.bytes);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 5) & 0xff;
  const first: ParsedV1 = { kind: "v1", frameIdx: 9, isFirst: true, w: 800, h: 480, data: raw.subarray(0, 1280) };
  asm.push(first, 1);
  for (let i = 1; i < legacy.chunksPerFrame; i++) {
    const p: ParsedV1 = { kind: "v1", frameIdx: -1, isFirst: false, w: 0, h: 0, data: raw.subarray(i * 1280, (i + 1) * 1280) };
    asm.push(p, 1 + i);
  }
  asm.finish();
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as FramePacket).frameIdx, 9);
  assert.deepEqual((frames[0] as FramePacket).raw, raw);
  assert.equal(asm.counters.aborted, 0);
});

test("v1 中途丢 1 包 → 该帧永不齐、下一帧首包结算 aborted=1", () => {
  const legacy = getProfile("legacy-800x480-1280") as Profile;
  const frames: FramePacket[] = [];
  const asm = new FrameAssembler({ profile: legacy, onFrame: (f) => frames.push(f) });
  const raw = new Uint8Array(legacy.frame.bytes);
  const first: ParsedV1 = { kind: "v1", frameIdx: 1, isFirst: true, w: 800, h: 480, data: raw.subarray(0, 1280) };
  asm.push(first, 1);
  for (let i = 1; i < 599; i++) {
    // 少喂一段
    const p: ParsedV1 = { kind: "v1", frameIdx: -1, isFirst: false, w: 0, h: 0, data: raw.subarray(i * 1280, (i + 1) * 1280) };
    asm.push(p, 1 + i);
  }
  const next: ParsedV1 = { kind: "v1", frameIdx: 2, isFirst: true, w: 800, h: 480, data: raw.subarray(0, 1280) };
  asm.push(next, 5000);
  assert.equal(frames.length, 0, "缺段的帧不能出图");
  assert.equal(asm.counters.aborted, 1);
});

test("CHUNK_IDX 越界 → 计 badLength 且不写坏帧缓冲", () => {
  const { asm, frames } = newAsm();
  const raw = frameBytes(4);
  asm.push(v2(4, 9999, raw.subarray(0, CHUNK)), 1);
  asm.finish();
  assert.equal(asm.counters.badLength, 1);
  assert.equal(frames.length, 0);
  // 越界块同样"通过校验"（codec 不校验 CHUNK_IDX 与 profile 的关系）⇒ 计入 bytesRaw，但绝不写帧缓冲
  assert.equal(asm.bytesRaw, CHUNK, "越界块计入 bytesRaw（通过校验即计入），但不写入帧缓冲");
});

test("统计快照：pps/bps 是区间值；窗口过短时沿用上次值（不让暴发当带宽）", () => {
  const { asm } = newAsm();
  asm.snapshotStats(0); // 先建立窗口
  feedCompleteFrame(asm, 10, 0);
  const s = asm.snapshotStats(1000); // 1 s 窗口
  assert.equal(s.packets, N);
  assert.equal(s.bps, N * 1024, "1 s 内 750 包 ⇒ 速率就是真实带宽");
  assert.equal(s.lastFrameIdx, 10);

  const held = asm.snapshotStats(1100); // 100 ms 窗口 < 200 ms ⇒ 沿用上次速率
  assert.equal(held.pps, s.pps);
  assert.equal(held.bps, s.bps);

  const s2 = asm.snapshotStats(2000); // 900 ms 且无新包 ⇒ 速率归零，累计值不减
  assert.equal(s2.packets, N, "累计包数不因窗口重置而减少");
  assert.equal(s2.pps, 0, "没有新包时区间速率为 0");
});
