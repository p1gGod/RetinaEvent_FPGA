// 六修 BLOCK-1/2 回归（2026-10-17）：40 ms 事件时间窗只能服务 EV_ONLY。
// BLOCK-1：RAW_EV（mode1）下帧间隔 >40 ms / 尾包晚到时，纯事件批曾被误标 EV_ONLY
//    ⇒ 前端 main.ts 见 FLAG_EV_ONLY 直接 return，不进 evQueue/recPair（事件 CSV 整批缺失）。
// BLOCK-2：EV_ONLY→RAW_EV 回切瞬间残留批曾走 legacy 出口（旧 frameIdx、无 EV_ONLY），
//   前端塞进 evQueue 等一个永不到来的帧 ⇒ 悬空；或 40 ms 后被当 EV_ONLY 刷出 ⇒ 幽灵。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { EventBatch, FramePacket, Profile } from "@retina/protocol";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { buildV3, concatU8, evByteAligned } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;

interface Emitted {
  readonly batch: EventBatch;
  readonly frameIdx: number;
  readonly seq: number;
  readonly evOnly: boolean;
}

function newRig(): {
  proc: PacketProcessor;
  frames: FramePacket[];
  out: Emitted[];
} {
  const frames: FramePacket[] = [];
  const out: Emitted[] = [];
  const proc = new PacketProcessor({
    profile,
    onFrame: (f) => frames.push(f),
    onEvents: (b, frameIdx, seq, _t, evOnly?: boolean) => out.push({ batch: b, frameIdx, seq, evOnly: evOnly === true }),
  });
  return { proc, frames, out };
}

function frameBytes(idx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + idx * 7) & 0xff;
  return out;
}
function chunkOf(raw: Uint8Array, i: number): Uint8Array {
  return raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
}
function feedFrame(proc: PacketProcessor, idx: number, t0: number): void {
  const raw = frameBytes(idx);
  for (let i = 0; i < N; i++) {
    proc.pushRawPayload(
      buildV3({ frameIdx: idx, chunkIdx: i, raw: chunkOf(raw, i), mode: 0, tsUs: t0 + i, tsCalibrated: true, first: i === 0, last: i === N - 1 }),
      t0 + i,
    );
  }
}
/** n 条事件记录（evByteAligned 只造 1 条，这里拼成 n 条） */
function evs(startX: number, n: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) parts.push(evByteAligned((startX + i) % 500, 3, ((startX + i) % 2) as 0 | 1, 0));
  return concatU8(...parts);
}

function xs(out: EventBatch[]): number[] {
  const r: number[] = [];
  for (const b of out) for (const e of b.records) r.push(e.x);
  return r;
}

// A1：RAW_EV 帧间隔 60~200 ms（>40 ms 窗）的纯事件包不得被标 EV_ONLY
test("A1 RAW_EV 低帧率/尾包晚到：纯事件批不得标 EV_ONLY，事件必须仍走 evQueue/录制通路", () => {
  const { proc, frames, out } = newRig();
  feedFrame(proc, 100, 1000);
  assert.equal(frames.length, 1, "首帧正常交付");
  // 同一帧的尾事件：以 60/90/120/150/200 ms 间隔的纯事件包到达（帧号冻结在 100）
  for (let i = 0; i < 5; i++) {
    proc.pushRawPayload(buildV3({ frameIdx: 100, events: evs(i * 20, 20), mode: 0, tsUs: 2000 + i * 1000, tsCalibrated: true }), 2200 + i * 120);
  }
  // 下一帧到达（帧间隔 ~600 ms > 40 ms 窗，旧实现会在 40 ms 处就误刷 EV_ONLY）
  feedFrame(proc, 101, 3000);
  proc.finish();
  assert.ok(frames.length >= 2, "帧照常交付");
  assert.equal(out.filter((o) => o.evOnly).length, 0, "RAW_EV 下任何批都不得带 EV_ONLY（否则前端直接 return，事件不进 evQueue/recPair）");
  assert.ok(out.length >= 1, "尾事件仍必须交付（legacy 批次，前端进 evQueue/录制）");
  assert.equal(xs(out.map((o) => o.batch)).length, 100, "5 包 × 20 条一条不少");
});

// A2：EV_ONLY 下 40 ms 窗口仍生效（evDrop=0、守恒）
test("A2 EV_ONLY 模式：40 ms 时间窗照常兜底，批数足够且 evDrop=0、事件守恒", () => {
  const { proc, out } = newRig();
  const PER = 4;
  const PACKETS = 500;
  for (let i = 0; i < PACKETS; i++) {
    proc.pushRawPayload(buildV3({ frameIdx: 6040, events: evs((i * PER) % 480, PER), mode: 2, tsUs: 1000 + i * 5000, tsCalibrated: true }), i * 5);
  }
  proc.tick(2600);
  proc.finish();
  assert.ok(out.length >= 50, "2.5 s 连续事件流至少 50 批，实测 " + out.length);
  assert.ok(out.every((o) => o.evOnly), "EV_ONLY 批必须全部带标记");
  assert.equal(proc.assembler.counters.evDrop, 0, "evDrop 只应在真溢出时增长");
  assert.equal(xs(out.map((o) => o.batch)).length, PACKETS * PER, "事件一条不多一条不少");
  let prev = 0;
  for (const o of out) {
    assert.ok(o.seq > prev, "逻辑帧号严格单调递增");
    prev = o.seq;
  }
});

// A3：EV_ONLY→RAW_EV 回切 40 ms 内残留批必须显式结算（不悬空、不重复上屏）
test("A3 EV_ONLY→RAW_EV 回切：<40 ms 残留批以 EV_ONLY 出口结算，不悬空不进 evQueue、不重复", () => {
  const { proc, frames, out } = newRig();
  // 300 条事件在 40 ms 窗口内攒着（t=0/10）
  proc.pushRawPayload(buildV3({ frameIdx: 300, events: evs(0, 30), mode: 2, tsUs: 1000, tsCalibrated: true }), 0);
  proc.pushRawPayload(buildV3({ frameIdx: 300, events: evs(30, 30), mode: 2, tsUs: 1500, tsCalibrated: true }), 10);
  assert.equal(out.length, 0, "窗口未到，先攒批");
  // 回切：首包是原始帧（帧号 301，与残留批的 300 不同 ⇒ 不能收编，必须结算）
  feedFrame(proc, 301, 24);
  proc.finish();
  assert.equal(frames.length, 1, "回切后原始帧正常交付");
  assert.equal(out.length, 1, "残留批必须以一次 EV_ONLY 结算，不能悬空也不能再刷第二批");
  const o = out[0] as Emitted;
  assert.equal(o.evOnly, true, "不得走 legacy 出口（否则前端 evQueuePush(300) 等 frame 300 永不到）");
  assert.equal(o.batch.records.length, 60, "60 条全部结算");
  assert.equal(o.frameIdx, 300, "保留原帧号作诊断，但标记 EV_ONLY ⇒ 前端立即上屏");
  assert.equal(xs(out.map((x) => x.batch)).length, 60, "不重复：总上屏条数 = 60");
});
