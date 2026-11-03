import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeRtpkt, iterRtpkt, countRtpkt, RTPKT_MAGIC } from "../src/rtpkt.ts";
import { FrameIndexUnwrapper, createCounters, bump, countersTotal, gapOf } from "../src/counters.ts";
import { encodeIpc, decodeIpc, RPC_METHODS } from "../src/ipc.ts";
import { getProfile, validateProfile } from "../src/profile.ts";
import type { IpcMessage } from "../src/ipc.ts";

test("RTPKT 容器：往返一致 + 尾截断可检出", () => {
  const ps = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array([9, 9])];
  const f = encodeRtpkt(ps);
  assert.equal(countRtpkt(f), 3);
  const got: number[][] = [];
  for (const p of iterRtpkt(f)) got.push(Array.from(p));
  assert.deepEqual(got, [[1, 2, 3], [], [9, 9]]);
  const bad = new Uint8Array(f.subarray(0, f.length - 1));
  assert.throws(() => countRtpkt(bad), /截断/);
  const noMagic = Uint8Array.from(f); noMagic[0] = 0x00;
  assert.throws(() => countRtpkt(noMagic), /魔数/);
  assert.equal(RTPKT_MAGIC.length, 8);
});

test("帧号回绕：16bit → 单调递增逻辑帧号", () => {
  const u = new FrameIndexUnwrapper();
  const seqs: number[] = [];
  for (const raw of [65533, 65534, 65535, 0, 1, 2]) seqs.push(u.push(raw).seq);
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);
  assert.equal(u.push(2).gap, 0);            // 重复包不算推进
  assert.equal(gapOf(65535, 0), 1);
  assert.equal(gapOf(null, 5), 0);
});

test("计数器：初始全 0、bump 累加、名字与常量表一致", () => {
  const c = createCounters();
  assert.equal(countersTotal(c), 0);
  bump(c, "aborted"); bump(c, "badMagic", 3);
  assert.equal(c.aborted, 1);
  assert.equal(c.badMagic, 3);
  // 15 → 25（2026-10-11 WIRE-V3 §7.2 增补 10 个 v3 计数器；与 tooling.test.ts 同步）
  // 25 → 26（2026-10-13 增补 evOrphan；与 tooling.test.ts 同步）
  assert.equal(Object.keys(c).length, 26);
});

test("IPC：FRAME_RAW / EVENTS / STATS 三种消息往返一致", () => {
  const raw = new Uint8Array(768).fill(7);
  const msgs: IpcMessage[] = [
    { type: "FRAME_RAW", flags: 0, seq: 1, frameIdx: 48271, tArriveMs: 1234, w: 800, h: 480, pixel: 0, raw },
    { type: "EVENTS", flags: 1, seq: 2, frameIdx: 48272, tArriveMs: 1300, recBytes: 5, count: 3, data: new Uint8Array(15) },
    { type: "STATS", flags: 4, seq: 3, frameIdx: 48273, tArriveMs: 1400, stats: { packets: 1, bytes: 2, bytesRaw: 2, bytesEvents: 0, pps: 3, bps: 4, lastFrameIdx: 5, wraps: 0, tNowMs: 6 }, counters: createCounters() },
  ];
  for (const m of msgs) {
    const bytes = encodeIpc(m);
    const back = decodeIpc(bytes);
    assert.ok(back, m.type + " 应能解码");
    assert.equal(back!.type, m.type);
    assert.equal(back!.frameIdx, m.frameIdx);
    assert.equal(back!.tArriveMs, m.tArriveMs);
  }
  const first = decodeIpc(encodeIpc(msgs[0]!));
  assert.equal(first!.type === "FRAME_RAW" ? first!.w : 0, 800);
  assert.equal(first!.type === "FRAME_RAW" ? first!.raw.length : 0, 768);
});

test("IPC：坏输入返回 null 而不抛", () => {
  assert.equal(decodeIpc(new Uint8Array(3)), null);
  const cut = encodeIpc({ type: "FRAME_RAW", flags: 0, seq: 0, frameIdx: 1, tArriveMs: 0, w: 8, h: 8, pixel: 0, raw: new Uint8Array(64) });
  assert.equal(decodeIpc(cut.subarray(0, 20)), null);          // payloadLen 与实到不符
  assert.ok(RPC_METHODS.includes("session.snapshot"));
  assert.ok(RPC_METHODS.includes("transport.start"));
});

test("profile 校验：能挡下真实会踩的错", () => {
  const ok = validateProfile(getProfile("retina-v2-800x480-e5")!);
  assert.equal(ok.ok, true);
  const bad = validateProfile({ ...getProfile("retina-v2-800x480-e5")!, rawChunk: 700 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.join(" ").includes("整除"));
  const mismatch = validateProfile({ ...getProfile("retina-v2-800x480-e5")!, rawChunk: 800 });   // 800 能整除(960 包)
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.join(" ").includes("chunksPerFrame"));
  const bad2 = validateProfile({ ...getProfile("retina-v2-800x480-e5")!, magic: "XYZ" });
  assert.equal(bad2.ok, false);
  const bad3 = validateProfile({ ...getProfile("retina-v2-800x480-e5")!, evRecBytes: 2 });
  assert.equal(bad3.ok, false);
});
