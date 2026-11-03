// 纯事件-时间窗兜底（2026-10-17 A 修复）：板端 MODE2(EV_ONLY) 下事件包 FRAME_IDX **冻结**
// （udp_merge.v 用 raw_pop 计数当帧号；现场实测 status frameIdx=6041 而事件包停在 6040），
// 于是装配器"只有帧号变化才 flush"的分支永远不触发；而 `tick()` 的兜底又要求
// `now-evLastT>frameTimeoutMs`，evLastT 每个事件包都刷新 ⇒ 连续事件流永不 flush
// ⇒ 2 MB 事件环被无限增长的内容挤爆、counters.evDrop 暴涨到 549 万、前端一条事件都收不到。
//
// 修法：纯事件路径加**时间窗兜底**（evPend 最老一条的到达时刻 t0；now-t0>=evFlushMs 即出批），
// 并给这些批**网关自增的逻辑帧号**（evOnly=true），前端据此立即上屏。
// 既有"帧号变化即 flush"与"帧内事件随帧交付"路径必须原样保留（RAW_EV 同帧配对不能被扰动）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEvents, getProfile } from "@retina/protocol";
import type { EventBatch, EventRecord, FramePacket, ParsedV2, Profile } from "@retina/protocol";
import { FrameAssembler } from "../src/pipeline/assembler.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const CHUNK = profile.rawChunk;
const N = profile.chunksPerFrame;
const REC = profile.evRecBytes;

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

function frameBytes(frameIdx: number): Uint8Array {
  const out = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < out.length; i++) out[i] = (i + frameIdx * 3) & 0xff;
  return out;
}

function chunkOf(raw: Uint8Array, i: number): Uint8Array {
  return raw.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, raw.length));
}

/** n 条可辨认的事件记录（x = tag*10+i；x 只有 9 bit，tag 必须 <51） */
function recs(tag: number, n: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) list.push({ x: tag * 10 + i, y: tag, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}

interface Emitted {
  readonly batch: EventBatch;
  readonly frameIdx: number;
  readonly seq: number;
  readonly t: number;
  readonly evOnly: boolean;
}

interface Rig {
  asm: FrameAssembler;
  frames: FramePacket[];
  out: Emitted[];
}

function newAsm(opts: { evFlushMs?: number; evRingMaxBytes?: number } = {}): Rig {
  const frames: FramePacket[] = [];
  const out: Emitted[] = [];
  const asm = new FrameAssembler({
    profile,
    ...(opts.evFlushMs === undefined ? {} : { evFlushMs: opts.evFlushMs }),
    ...(opts.evRingMaxBytes === undefined ? {} : { evRingMaxBytes: opts.evRingMaxBytes }),
    onFrame: (f) => frames.push(f),
    onEvents: (batch, frameIdx, seq, t, evOnly?: boolean) =>
      out.push({ batch, frameIdx, seq, t, evOnly: evOnly === true }),
  });
  return { asm, frames, out };
}

// ————————————————— ① 现场形态：2.5 s 连续纯事件包、帧号恒定 —————————————————

test("MODE2 现场形态：帧号冻结的连续纯事件包 2.5 s ⇒ 批次数≥50、evDrop=0、逻辑帧号单调递增", () => {
  const { asm, frames, out } = newAsm(); // 默认 evFlushMs=40
  const PACKETS = 500; // 5 ms 一包 = 2.5 s（现场 82~110 kev/s，每包 4 条）
  const PER_PACKET = 4;
  const FROZEN_IDX = 6040;
  for (let i = 0; i < PACKETS; i++) {
    asm.push(v2(FROZEN_IDX, 0, null, recs((i % 40) + 1, PER_PACKET)), 1_000_000 + i * 5);
  }
  asm.finish();

  assert.ok(out.length >= 50, "2.5 s / 40 ms 应至少有 50 批（实际 " + out.length + "）");
  assert.equal(asm.counters.evDrop, 0, "时间窗兜底后不允许再有环溢出（evDrop 只应在真溢出时增长）");
  assert.equal(asm.counters.evOrphan, 0);
  assert.equal(asm.counters.evPartial, 0, "整条记录对齐，不许产生半记录");
  assert.equal(frames.length, 0, "纯事件流不产生原始帧");

  // 逻辑帧号：时间窗批由网关自增，严格单调递增，从 1 开始。
  // 注意 finish() 的尾巴走既有出口（非 evOnly），它用的是帧号语义的 evTargetSeq —— 那是另一口径，见下一个断言。
  const timed = out.filter((e) => e.evOnly);
  timed.forEach((e, i) => assert.equal(e.seq, i + 1, "第 " + i + " 个时间窗批的逻辑帧号必须连续自增"));
  for (let i = 1; i < timed.length; i++) assert.ok(timed[i]!.seq > timed[i - 1]!.seq);
  assert.equal(out[out.length - 1]!.evOnly, false, "finish 出来的尾巴批次走既有出口（停止时不再等帧）");

  // 每条事件恰好交付一次：总数守恒
  const total = out.reduce((n, e) => n + e.batch.records.length, 0);
  assert.equal(total, PACKETS * PER_PACKET, "交付条数必须与推入条数一致");
  assert.ok(
    timed.every((e) => e.evOnly),
    "时间窗批次必须带 evOnly 标记（前端靠它立即上屏；帧号变化批次则不带）",
  );
  // onEvents 的 frameIdx 仍报板端原始帧号，seq 才是逻辑帧号 —— 两者不能混
  assert.ok(out.every((e) => e.frameIdx === FROZEN_IDX));
  // 时间窗从最老一条起算：每批跨度不允许无限增长
  for (const e of out) assert.ok(e.t - 1_000_000 <= 5000, "批次时间跨度必须被窗口约束");
});

test("时间窗以 evPend 最老一条的到达时刻起算（不是最后一个包的时间）", () => {
  const { asm, out } = newAsm({ evFlushMs: 40 });
  asm.push(v2(9, 0, null, recs(1, 2)), 1000);
  asm.push(v2(9, 0, null, recs(2, 2)), 1020);
  asm.push(v2(9, 0, null, recs(3, 2)), 1035);
  assert.equal(out.length, 0, "未到窗口不 flush");
  asm.push(v2(9, 0, null, recs(4, 2)), 1040); // 1040-1000=40 ⇒ 到窗口（先结算已攒的 3 包，本包开新窗）
  assert.equal(out.length, 1, "到窗口立即出批，不许等到下一次 tick");
  assert.equal(out[0]!.batch.records.length, 6, "窗口内已到达的包一起出批");
  assert.equal(out[0]!.evOnly, true);
  assert.equal(out[0]!.frameIdx, 9);
  asm.tick(1080);
  assert.equal(out.length, 2, "新窗从触发包起算（1040），1080 时到窗口");
  assert.equal(out[1]!.batch.records.length, 2);
});

test("低频纯事件包：tick() 也按时间窗兜底（不要求等 1 s frameTimeout）", () => {
  const { asm, out } = newAsm({ evFlushMs: 40 });
  asm.push(v2(9, 0, null, recs(1, 3)), 1000);
  assert.equal(out.length, 0);
  asm.tick(1010);
  assert.equal(out.length, 0, "10 ms 未到窗口");
  asm.tick(1045);
  assert.equal(out.length, 1, "缺包时 tick 也必须按窗口兜底出批，否则低频事件流会一直攒着");
  assert.equal(out[0]!.evOnly, true);
  assert.equal(out[0]!.batch.records.length, 3);
});

// ————————————————— ② 既有语义回归：帧号变化 / 帧内事件 / 迟到事件 —————————————————

test("帧号变化仍走旧语义：不带 evOnly、seq 仍是装配器分配的逻辑号（RAW_EV 配对不变）", () => {
  const { asm, out } = newAsm({ evFlushMs: 40 });
  asm.push(v2(5, 0, null, recs(1, 2)), 1000);
  asm.push(v2(6, 0, null, recs(2, 2)), 1010); // 帧号变化 ⇒ 立即 flush 帧 5 的批
  assert.equal(out.length, 1, "帧号变化即 flush（这条既有路径不许被时间窗替代）");
  assert.equal(out[0]!.evOnly, false, "帧号变化批次不是 evOnly（它可能属于后续原始帧，前端仍走配对）");
  asm.finish();
  assert.equal(out.length, 2, "finish 排空尾巴");
  assert.equal(out[1]!.evOnly, false);
});

test("时间窗关闭（evFlushMs=0）⇒ 退回旧行为：只靠帧号变化/超时/finish 出批", () => {
  const { asm, out } = newAsm({ evFlushMs: 0 });
  for (let i = 0; i < 20; i++) asm.push(v2(9, 0, null, recs(i + 1, 2)), 1000 + i * 5);
  assert.equal(out.length, 0, "关闭后连续事件流仍然不 flush（这是修前语义，测试注入口要用得到）");
  asm.finish();
  assert.equal(out.length, 1);
});

test("RAW_EV 同帧配对回归：帧内事件随帧交付，纯事件批不重复推同一批", () => {
  const { asm, frames, out } = newAsm({ evFlushMs: 40 });
  const raw = frameBytes(7);
  for (let i = 0; i < N; i++) asm.push(v2(7, i, chunkOf(raw, i), i === 0 ? recs(1, 2) : null), 1000 + i);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.events.records.map((e) => e.x), [10, 11]);
  assert.equal(out.length, 0, "帧内事件不许再走纯事件出口");
  asm.finish();
  assert.equal(out.length, 0);
  assert.equal(asm.counters.evDrop, 0);
  assert.equal(asm.counters.aborted, 0);
});

test("真溢出才计 evDrop：窗口内暴涨超过环上限 ⇒ 丢最旧记录并计数", () => {
  // e5 profile 每记录 5 B：每包 4 条 = 20 B；环上限 25 B ⇒ 第二包进来必须扔最旧的 3 条
  const { asm, out } = newAsm({ evFlushMs: 40, evRingMaxBytes: 25 });
  asm.push(v2(9, 0, null, recs(1, 4)), 1000);
  asm.push(v2(9, 0, null, recs(2, 4)), 1010);
  assert.equal(asm.counters.evDrop, 3, "真溢出必须显式计数（不许再静默）：40 B > 25 B ⇒ 丢 3 条");
  asm.tick(1050);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.batch.records.length, 5, "只留得下 5 条（25 B / 5 B）");
});

// ————————————————— ③ 时间窗是真 gate：关掉窗口 ⇒ 2 MB 环真的会爆 —————————————————

/** 现场事件率下的大批记录（每包几百条；x/y 会被编码器按 9 位截断，只要求条数准确） */
function bigRecs(n: number, tag: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) {
    list.push({ x: (tag * 97 + i) & 0x1ff, y: (i * 7) % 480, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: (i * 13) & 0xff });
  }
  return encodeEvents(list, REC);
}

test("时间窗兜底是唯一的 gate：evFlushMs=5000 时现场事件率挤爆 2 MB 环（evDrop 重现），回到 40 ms 后归零", () => {
  // 现场：82~110 kev/s，5 ms 一包 ⇒ 每包约 550 条；5.2 s ≈ 57.2 万条，而 2 MB / 5 B = 41.9 万条 ⇒ 必溢出。
  const PKT_MS = 5;
  const PER = 550;
  const PACKETS = 1040; // 5.2 s
  const PUSHED = PER * PACKETS;
  const FROZEN_IDX = 6040;

  function run(evFlushMs: number): { drop: number; batches: number; delivered: number } {
    const { asm, out } = newAsm({ evFlushMs });
    for (let i = 0; i < PACKETS; i++) {
      asm.push(v2(FROZEN_IDX, 0, null, bigRecs(PER, i)), 1_000_000 + i * PKT_MS);
    }
    const drop = asm.counters.evDrop;
    asm.finish();
    const delivered = out.reduce((n, e) => n + e.batch.records.length, 0);
    return { drop, batches: out.length, delivered };
  }

  const slow = run(5000);
  assert.ok(slow.drop > 0, "evFlushMs=5000 时 2 MB 事件环必须溢出并计 evDrop（证明窗口是真 gate，不是摆设）：drop=" + slow.drop);
  assert.ok(slow.drop >= 100_000, "溢出量应与超出 2 MB 的记录数量级一致：drop=" + slow.drop);
  assert.ok(slow.batches <= 3, "5 s 窗口内只允许极少数批次：batches=" + slow.batches);
  assert.equal(slow.delivered + slow.drop, PUSHED, "交付条数 + 丢弃条数必须守恒（丢弃只能来自环裁剪）");

  const fast = run(40);
  assert.equal(fast.drop, 0, "回到 40 ms 窗口后同一流量不允许再溢出：evDrop=" + fast.drop);
  assert.ok(fast.batches >= 100, "40 ms 窗口下批次数应≈时长/窗口：batches=" + fast.batches);
  assert.equal(fast.delivered, PUSHED, "40 ms 窗口下必须一条不丢");
});

test("EV_ONLY 后恢复 MODE0：时间窗批先出，随后原始帧正常交付且事件不重复", () => {
  const { asm, frames, out } = newAsm({ evFlushMs: 40 });
  for (let i = 0; i < 10; i++) asm.push(v2(6040, 0, null, recs(i + 1, 2)), 1000 + i * 5);
  asm.tick(1100);
  assert.ok(out.length >= 2, "时间窗批必须已交付");
  assert.equal(out.reduce((n, e) => n + e.batch.records.length, 0), 20, "恢复前先把纯事件排空");

  const raw = frameBytes(6041);
  for (let i = 0; i < N; i++) asm.push(v2(6041, i, chunkOf(raw, i), i === 0 ? recs(20, 1) : null), 1100 + i);
  assert.equal(frames.length, 1, "恢复 MODE0 后原始帧必须照常交付");
  assert.equal(frames[0]!.frameIdx, 6041);
  assert.deepEqual(frames[0]!.events.records.map((e) => e.x), [200], "帧内事件归帧，不与事件-only 批次搅浑");
  asm.finish();
  const total = out.reduce((n, e) => n + e.batch.records.length, 0);
  assert.equal(total, 20, "纯事件阶段 10×2 条，一条不多一条不少");
  assert.equal(asm.counters.evOrphan, 0);
});
