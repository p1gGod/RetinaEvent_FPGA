import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { EventBatch, FramePacket, Profile } from "@retina/protocol";
import { SynthTransport, synthEventRecords, synthRawFrame } from "../src/transport/synth.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;

interface Run {
  readonly src: SynthTransport;
  readonly frames: FramePacket[];
  readonly batches: EventBatch[];
}

function run(opts: ConstructorParameters<typeof SynthTransport>[0]): Run {
  const src = new SynthTransport(opts);
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  src.on("frame", (f) => frames.push(f));
  src.on("events", (b) => batches.push(b));
  src.start();
  src.stop();
  return { src, frames, batches };
}

test("合成源全速出 3 帧：逐字节等于同构算式、frameIdx/seq 递增", () => {
  const { src, frames } = run({ profile, speed: 0, maxFrames: 3 });
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.frameIdx), [1, 2, 3]);
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2]);
  for (const f of frames) {
    assert.deepEqual(f.raw, synthRawFrame(f.frameIdx, profile.frame.bytes), "合成帧必须与算式逐字节一致");
    assert.equal(f.synthetic, true, "合成数据必须带上标志，IPC 会置 FLAG_SYNTHETIC");
  }
  assert.equal(src.counters.aborted, 0);
  assert.equal(src.bytesRaw, 3 * 768000);
  assert.equal(src.packetsSent, 3 * profile.chunksPerFrame);
});

test("合成源可注入丢包：dropChunks=[499] ⇒ aborted=1 且零帧（不产生错位图像）", () => {
  const { src, frames } = run({ profile, speed: 0, maxFrames: 1, dropChunks: [499] });
  assert.equal(frames.length, 0);
  assert.equal(src.counters.aborted, 1);
  assert.equal(src.bytesRaw, 749 * profile.rawChunk);
  assert.equal(src.packetsDropped, 1);
});

test("合成源可注入重复包：dupChunks=[10] ⇒ dupChunk=1，帧仍逐字节正确", () => {
  const { src, frames } = run({ profile, speed: 0, maxFrames: 1, dupChunks: [10] });
  assert.equal(frames.length, 1);
  assert.equal(src.counters.dupChunk, 1);
  assert.equal(src.counters.aborted, 0);
  assert.deepEqual((frames[0] as FramePacket).raw, synthRawFrame(1, profile.frame.bytes));
});

test("合成源乱序发送：装配按 CHUNK_IDX 位图定位，结果不受到达顺序影响", () => {
  const { frames } = run({ profile, speed: 0, maxFrames: 1, reorder: true });
  assert.equal(frames.length, 1);
  assert.deepEqual((frames[0] as FramePacket).raw, synthRawFrame(1, profile.frame.bytes));
});

test("合成源 16bit 回绕：65534 → 65535 → 0，步长为 1、无 idxGap", () => {
  const { src, frames } = run({ profile, speed: 0, maxFrames: 3, startFrameIdx: 65534 });
  assert.deepEqual(frames.map((f) => f.frameIdx), [65534, 65535, 0]);
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2]);
  assert.equal(src.counters.idxGap, 0);
  assert.equal(src.snapshotStats(1).wraps, 1);
});

test("帧内事件按 profile 容量分摊并随帧交付；装不下时退化成纯事件包（缺口 G3）", () => {
  const small = run({ profile, speed: 0, maxFrames: 1, eventsPerFrame: 100 });
  assert.equal(small.batches.length, 0, "100 条能全搭在原始包上");
  const recs = (small.frames[0] as FramePacket).events.records;
  assert.equal(recs.length, 100);
  const truth = synthEventRecords(1, 100);
  assert.deepEqual(recs.map((r) => ({ x: r.x, y: r.y, pol: r.pol })), truth, "事件坐标/极性与发送侧一致");

  const big = run({ profile, speed: 0, maxFrames: 1, eventsPerFrame: 70_000 });
  const inFrames = big.frames.reduce((n, f) => n + f.events.records.length, 0);
  const inBatches = big.batches.reduce((n, b) => n + b.records.length, 0);
  assert.equal(inFrames + inBatches, 70_000, "事件不能丢，只能分批/退化");
  assert.ok(big.batches.length > 0, "70k 条必然超出原始包容量 ⇒ 必须出现纯事件包");
  assert.equal(big.src.counters.evPartial, 0);
});

test("合成丢包率可复现（同 seed 同结果），且丢包只体现为 aborted", () => {
  const a = run({ profile, speed: 0, maxFrames: 1, dropRate: 0.05, seed: 1234 });
  const b = run({ profile, speed: 0, maxFrames: 1, dropRate: 0.05, seed: 1234 });
  assert.equal(a.src.packetsDropped, b.src.packetsDropped, "同 seed 必须同丢包模式");
  assert.equal(a.frames.length, 0);
  assert.equal(a.src.counters.aborted, 1);
  assert.ok(a.src.packetsDropped > 0);
});

test("TELEM profile 不能当 UDP 帧流用（合成源直接拒绝，不静默出错图）", () => {
  const telem = getProfile("telem-400x240") as Profile;
  assert.throws(() => new SynthTransport({ profile: telem, speed: 0, maxFrames: 1 }), /TELEM/);
});
