import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countRtpkt, encodeRtpkt, getProfile } from "@retina/protocol";
import type { Counters, EventBatch, FramePacket, Profile } from "@retina/protocol";
import { hostPath } from "../src/paths.ts";
import { ReplayTransport } from "../src/transport/replay.ts";
import { encodeV2Packet } from "../src/transport/v2encode.ts";

const GOLDEN_DIR = hostPath("testdata/golden");
// 列表驱动：golden-tools 新增向量时只要这里加个 id（缺文件会带明确理由 skip，不会假绿）
const GOLDEN_IDS = ["g01_min_frame", "g02_ev_only", "g03_drop_chunk", "g04_wrap", "g05_bad_crc", "g06_legacy", "g07_dup_chunk"] as const;

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

interface ReplayRun {
  readonly src: ReplayTransport;
  readonly frames: FramePacket[];
  readonly batches: EventBatch[];
  readonly eventTotal: number;
}

/** 回放一个容器：监听先挂、再 start（全速模式 start() 内部就同步灌完了） */
function replay(file: string, profile: Profile): ReplayRun {
  const src = new ReplayTransport({ profile, path: file, speed: 0 });
  const frames: FramePacket[] = [];
  const batches: EventBatch[] = [];
  src.on("frame", (f) => frames.push(f));
  src.on("events", (b) => batches.push(b));
  src.start();
  src.stop();
  const eventTotal =
    frames.reduce((n, f) => n + f.events.records.length, 0) + batches.reduce((n, b) => n + b.records.length, 0);
  return { src, frames, batches, eventTotal };
}

function payloadsOfFrame(frameIdx: number, raw: Uint8Array, chunk: number, chunks: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let ci = 0; ci < chunks; ci++) {
    out.push(
      encodeV2Packet({
        frameIdx,
        segMask: 1,
        chunkIdx: ci,
        raw: raw.subarray(ci * chunk, Math.min((ci + 1) * chunk, raw.length)),
      }),
    );
  }
  return out;
}

function withTempRtpkt(payloads: Uint8Array[], fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "retina-replay-"));
  const file = path.join(dir, "vector.rtpkt");
  try {
    writeFileSync(file, encodeRtpkt(payloads));
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ————————————————— 自包含 e2e（不依赖 golden-tools 的交付物） —————————————————

test("自包含 e2e：750 包 → 1 帧 768000 B、frameIdx 正确、逐字节与 sha256 一致", () => {
  const profile = getProfile("retina-v2-800x480-e5") as Profile;
  const raw = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) & 0xff;
  withTempRtpkt(payloadsOfFrame(42, raw, profile.rawChunk, profile.chunksPerFrame), (file) => {
    const run = replay(file, profile);
    assert.equal(run.frames.length, 1);
    const f = run.frames[0] as FramePacket;
    assert.equal(f.raw.length, 768000);
    assert.equal(f.frameIdx, 42);
    assert.deepEqual(f.raw, raw, "回放装配结果必须与源逐字节一致");
    assert.equal(sha256(f.raw), sha256(raw));
    assert.equal(run.src.bytesRaw, 768000);
    assert.equal(run.src.counters.aborted, 0);
    assert.equal(run.src.packetCount, 750);
  });
});

test("自包含 e2e：删掉第 500 包 → aborted=1、零帧（复刻 g03 判据，不依赖 golden）", () => {
  const profile = getProfile("retina-v2-800x480-e5") as Profile;
  const raw = new Uint8Array(profile.frame.bytes);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 17) & 0xff;
  const payloads = payloadsOfFrame(1, raw, profile.rawChunk, profile.chunksPerFrame).filter((_, i) => i !== 499);
  withTempRtpkt(payloads, (file) => {
    const run = replay(file, profile);
    assert.equal(run.frames.length, 0, "缺块绝不能出图");
    assert.equal(run.src.counters.aborted, 1);
    assert.equal(run.src.bytesRaw, 749 * profile.rawChunk);
  });
});

test("自包含 e2e：容器包数可数，RTPKT 读出 750 个负载", () => {
  const profile = getProfile("retina-v2-800x480-e5") as Profile;
  const raw = new Uint8Array(profile.frame.bytes);
  const payloads = payloadsOfFrame(3, raw, profile.rawChunk, profile.chunksPerFrame);
  withTempRtpkt(payloads, (file) => {
    const buf = readFileSync(file);
    assert.equal(countRtpkt(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), 750);
  });
});

// ————————————————— golden 向量（host/testdata/golden，缺失则跳过并说明） —————————————————

function goldenSkipReason(id: string): string | false {
  const rtpkt = path.join(GOLDEN_DIR, id + ".rtpkt");
  const expected = path.join(GOLDEN_DIR, id + ".expected.json");
  if (!existsSync(rtpkt) || !existsSync(expected)) {
    return "golden 向量缺失（" + rtpkt + "）：golden-tools 尚未生成，跳过";
  }
  return false;
}

for (const id of GOLDEN_IDS) {
  test("golden " + id + "：包数/帧数/bytesRaw/事件数/计数器子集/rawSha256 全部对拍", { skip: goldenSkipReason(id) }, () => {
    const rtpktPath = path.join(GOLDEN_DIR, id + ".rtpkt");
    const exp = JSON.parse(readFileSync(path.join(GOLDEN_DIR, id + ".expected.json"), "utf8")) as {
      profile: string;
      packets: number;
      expect: { frames: number; frameIdx: number[]; bytesRaw: number; eventCount: number; counters: Record<string, number> };
      rawSha256: string | null;
    };
    const profile = getProfile(exp.profile);
    assert.ok(profile !== null, "expected.json 里的 profile 必须存在: " + exp.profile);

    const buf = readFileSync(rtpktPath);
    assert.equal(
      countRtpkt(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),
      exp.packets,
      "容器实际包数应与 expected.packets 一致（能抓出生成器少写/多写包）",
    );

    const run = replay(rtpktPath, profile);
    assert.equal(run.frames.length, exp.expect.frames, "frames");
    assert.deepEqual(run.frames.map((f) => f.frameIdx), exp.expect.frameIdx, "frameIdx");
    assert.equal(run.src.bytesRaw, exp.expect.bytesRaw, "bytesRaw");
    assert.equal(run.eventTotal, exp.expect.eventCount, "eventCount");

    // 计数器子集比对：expected 没列出的键是"策略相关/故意不锁"，不能拿它们判红
    for (const [k, v] of Object.entries(exp.expect.counters)) {
      assert.equal(run.src.counters[k as keyof Counters], v, "counter " + k);
    }

    // STATS 口径也必须与 frozen 的 bytesRaw 一致：纯事件向量（g02）一旦把 EV_LEN 混进来就会在这里红
    assert.equal(run.src.snapshotStats(Date.now()).bytesRaw, exp.expect.bytesRaw, "STATS 的 bytesRaw 口径");

    if (exp.rawSha256 !== null) {
      assert.equal(run.frames.length, 1, "有 rawSha256 的向量必须恰好产出一帧");
      assert.equal(sha256((run.frames[0] as FramePacket).raw), exp.rawSha256, "rawSha256");
    } else {
      assert.equal(run.frames.length, 0, "rawSha256=null ⇒ 不应产出完整帧");
    }
  });
}

test("golden g02_ev_only：事件流量与原始带宽分开统计（bytesRaw=0 / bytesEvents=103）", { skip: goldenSkipReason("g02_ev_only") }, () => {
  const profile = getProfile("retina-v2-800x480-e5") as Profile;
  const run = replay(path.join(GOLDEN_DIR, "g02_ev_only.rtpkt"), profile);
  const s = run.src.snapshotStats(Date.now());
  assert.equal(s.bytesRaw, 0, "两个包 RAW_LEN 都是 0 ⇒ 原始字节必须为 0");
  assert.equal(s.bytesEvents, 103, "EV_LEN=50+53 必须单独统计");
  assert.equal(s.bytes, 103, "总量仍是两者之和");
});

test("golden g02_ev_only：事件坐标/极性与真值表逐条一致（含 x>255 与边界）", { skip: goldenSkipReason("g02_ev_only") }, () => {
  const truthPath = path.join(GOLDEN_DIR, "g02_ev_only.events.json");
  if (!existsSync(truthPath)) {
    // 真值表是可选的额外证据；缺失只说明"没做这条核对"，不算失败
    return;
  }
  const truth = JSON.parse(readFileSync(truthPath, "utf8")) as { x: number; y: number; pol: number }[];
  const profile = getProfile("retina-v2-800x480-e5") as Profile;
  const run = replay(path.join(GOLDEN_DIR, "g02_ev_only.rtpkt"), profile);
  const got = run.batches.flatMap((b) => b.records.map((r) => ({ x: r.x, y: r.y, pol: r.pol })));
  assert.deepEqual(got, truth, "纯事件包的 x/y/pol 必须与发送侧真值一致");
});
