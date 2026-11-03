// v3 数据通路测试（WIRE-V3 §2/§4/§7.2 装配行）：解析分派 → 装配 → 帧时间轴三路径。
// 判据覆盖：① v3 帧头解析三路径（存在/缺失/回退到达时刻）② µs→ms 换算与校准 offset 应用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile } from "@retina/protocol";
import type { Counters, EventBatch, FramePacket, ParsedV3, Profile } from "@retina/protocol";
import { createCounters } from "@retina/protocol";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { buildV2, buildV3, evByteAligned, seq, v3Tlv, concatU8 } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;

function frameBytes(frameIdx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + frameIdx * 7) & 0xff;
  return out;
}
function chunkOf(raw: Uint8Array, i: number): Uint8Array {
  return raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
}

interface Rig {
  processor: PacketProcessor;
  counters: Counters;
  frames: FramePacket[];
  batches: EventBatch[];
  ctrls: ParsedV3[];
  modes: number[];
}

function newRig(): Rig {
  const counters = createCounters();
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  const ctrls: ParsedV3[] = [];
  const modes: number[] = [];
  const processor = new PacketProcessor({
    profile,
    counters,
    onFrame: (f) => frames.push(f),
    onEvents: (b) => batches.push(b),
    onCtrl: (p) => ctrls.push(p),
    onV3Mode: (m) => modes.push(m),
  });
  return { processor, counters, frames, batches, ctrls, modes };
}

/** 喂一帧完整的 v3 RAW 包（750 段） */
function feedV3Frame(rig: Rig, frameIdx: number, t0: number, tsUs: number, opts: { calibrated?: boolean; tsValid?: boolean } = {}): void {
  const raw = frameBytes(frameIdx);
  const tsValid = opts.tsValid ?? true;
  for (let i = 0; i < N; i++) {
    rig.processor.pushRawPayload(
      buildV3({
        frameIdx,
        chunkIdx: i,
        raw: chunkOf(raw, i),
        tsUs: tsValid ? tsUs : null,
        tsCalibrated: opts.calibrated ?? true,
        first: i === 0,
        last: i === N - 1,
        mode: 0,
      }),
      t0 + i,
    );
  }
}

test("判据① 路径A（板端时间戳存在 + 已校准）：tBoardMs = TS_US/1000（µs→ms）", () => {
  const rig = newRig();
  const tsUs = 1_760_000_123_456;                        // 任意 48 bit 内的值
  feedV3Frame(rig, 1, 1000, tsUs);
  rig.processor.finish();
  assert.equal(rig.frames.length, 1);
  const f = rig.frames[0] as FramePacket;
  assert.equal(f.raw.length, profile.frame.bytes);
  assert.equal(f.tBoardMs, tsUs / 1000);
  assert.equal(rig.counters.aborted, 0);
  assert.equal(rig.modes[0], 0);
});

test("判据① 路径C（时间戳缺失 TS_VALID=0 / v2 帧）：tBoardMs 缺省 → 上层回退到达时刻", () => {
  const rig = newRig();
  feedV3Frame(rig, 1, 1000, 0, { tsValid: false });
  rig.processor.finish();
  assert.equal(rig.frames.length, 1);
  assert.equal((rig.frames[0] as FramePacket).tBoardMs, undefined);
  // v2 帧（板端还没换 v3 固件）同样无板端时间：走 v2 解析路径且正常装配
  const rig2 = newRig();
  const raw = frameBytes(1);
  for (let i = 0; i < N; i++) {
    rig2.processor.pushRawPayload(buildV2({ frameIdx: 1, chunkIdx: i, raw: chunkOf(raw, i), withCrc: true }), 2000 + i);
  }
  rig2.processor.finish();
  assert.equal(rig2.frames.length, 1);
  assert.equal((rig2.frames[0] as FramePacket).tBoardMs, undefined);
  assert.equal(rig2.counters.badMagic, 0);
});

test("判据② 路径B（未校准 + PC 已知 offset）：tBoardMs = (TS_US + offset)/1000", () => {
  const rig = newRig();
  const offsetUs = 1_500_000;
  rig.processor.setTsOffsetUs(offsetUs);                 // V3Link 从 ACK 学到后注入（offset 变更时才会调）
  feedV3Frame(rig, 1, 1000, 5_000_000, { calibrated: false });
  rig.processor.finish();
  assert.equal(rig.frames.length, 1);
  assert.equal((rig.frames[0] as FramePacket).tBoardMs, (5_000_000 + offsetUs) / 1000);
});

test("判据② 已校准的包不重复加 offset（板端已加过，PC 再加就重了）", () => {
  const rig = newRig();
  rig.processor.setTsOffsetUs(999_999_999);
  feedV3Frame(rig, 1, 1000, 2_000_000, { calibrated: true });
  rig.processor.finish();
  assert.equal((rig.frames[0] as FramePacket).tBoardMs, 2000);
});

test("MODE2（EV_ONLY）不拼帧、直接进事件队列（§7.2 装配行——高回传帧率关键路径）", () => {
  const rig = newRig();
  for (let i = 0; i < 4; i++) {
    rig.processor.pushRawPayload(
      buildV3({ frameIdx: 100, events: evByteAligned(i, 2, 1, 0), mode: 2, tsUs: 1000 + i, tsCalibrated: true }), 3000 + i,
    );
  }
  rig.processor.finish();
  assert.equal(rig.frames.length, 0);
  assert.equal(rig.counters.aborted, 0);
  assert.equal(rig.batches.length, 1);                   // 同帧号攒一批
  assert.equal((rig.batches[0] as EventBatch).records.length, 4);
  assert.equal(rig.modes[0], 2);
});

test("MODE1（RAW_ONLY）不进事件图层：即使带事件段也不交付（segInconsistent 已告警）", () => {
  const rig = newRig();
  const raw = frameBytes(1);
  for (let i = 0; i < N; i++) {
    rig.processor.pushRawPayload(
      buildV3({
        frameIdx: 1, chunkIdx: i, raw: chunkOf(raw, i), mode: 1,
        ...(i === 0 ? { events: evByteAligned(1, 2, 1, 0) } : {}),
        tsUs: 4_000_000, tsCalibrated: true, first: i === 0,
      }),
      4000 + i,
    );
  }
  rig.processor.finish();
  assert.equal(rig.frames.length, 1);
  assert.equal(rig.batches.length, 0);
});

test("v3 CTRL 包（ACK/心跳/REQ）不进装配器、转状态通道（§7.2）", () => {
  const rig = newRig();
  const tlv = concatU8(v3Tlv(0x81, Uint8Array.of(2)), v3Tlv(0x86, Uint8Array.of(0b001)));
  rig.processor.pushRawPayload(buildV3({ ctrl: true, ctrlOpcode: 0xf0, ctrlSeq: 5, ctrlTlv: tlv, mode: 2 }), 5000);
  assert.equal(rig.frames.length, 0);
  assert.equal(rig.batches.length, 0);
  assert.equal(rig.ctrls.length, 1);
  const ch = (rig.ctrls[0] as ParsedV3).ctrlHeader;
  assert.ok(ch !== null);
  assert.equal(ch.opcode, 0xf0);
  assert.equal(ch.seq, 5);
});

test("v2/v3 按魔数分派互不误判：VER=2 的 v3 魔数包 → badVersion，不进 v2 路径", () => {
  const rig = newRig();
  const b = buildV3({ raw: seq(64) });
  b[4] = 0x02;
  rig.processor.pushRawPayload(b, 6000);
  assert.equal(rig.counters.badVersion, 1);
  assert.equal(rig.counters.badMagic, 0);
});

test("判据① 异常回退：TS 回退 >1 s ⇒ tsEpochReset，帧时间轴重建但不丢数据（§4.1）", () => {
  const rig = newRig();
  feedV3Frame(rig, 1, 1000, 10_000_000);
  feedV3Frame(rig, 2, 2000, 3_000_000);                  // 板卡复位：TS 从 10 s 掉回 3 s
  rig.processor.finish();
  assert.equal(rig.frames.length, 2);
  assert.equal(rig.counters.tsEpochReset, 1);
  assert.equal((rig.frames[1] as FramePacket).tBoardMs, 3_000_000 / 1000);
});
