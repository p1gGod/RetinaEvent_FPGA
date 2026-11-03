// 长录核心（task-30 / REC_CORE_OK）：假 ffmpeg + 真实文件系统，验证字节数、背压、分段、CSV、
// 异常重开与幂等停止。真 ffmpeg 的集成验证在 tools/test/record_integration.test.ts（REC_E2E=1）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventRecord, FramePacket, Profile } from "@retina/protocol";
import { getProfile } from "@retina/protocol";
import { EVENTS_HEADER, FRAMES_HEADER, buildChunkCsv, formatEventRow, formatFrameRow } from "../src/record/csv.ts";
import { buildEncodeArgs, buildSealArgs } from "../src/record/ffmpeg.ts";
import { Recorder, type RecorderOptions } from "../src/record/recorder.ts";

const PROFILE = getProfile("retina-v2-800x480-1280") as Profile;
const FRAME_BYTES = PROFILE.frame.bytes;
const FIXTURE = fileURLToPath(new URL("../../tools/test/fixtures/fake_ffmpeg.mjs", import.meta.url));

function fakeRecorder(root: string, extra: Partial<RecorderOptions> = {}): Recorder {
  return new Recorder({
    profile: PROFILE,
    root,
    ffmpegPath: process.execPath,
    ffmpegArgsPrefix: [FIXTURE],
    chunkMs: 60_000,
    ...extra,
  });
}

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "retina-rec-"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("条件在 " + timeoutMs + " ms 内未成立");
    await delay(10);
  }
}

function ev(x: number, y: number, pol: 0 | 1): EventRecord {
  return { x, y, pol, flags: pol, ts: 100 + x };
}

function frame(idx: number, opts: { tBoardMs?: number; events?: EventRecord[]; bytes?: number } = {}): FramePacket {
  return {
    frameIdx: idx & 0xffff,
    seq: idx,
    w: PROFILE.frame.w,
    h: PROFILE.frame.h,
    raw: new Uint8Array(opts.bytes ?? FRAME_BYTES),
    pixel: "RGB565_BE",
    events: { records: opts.events ?? [], dropped: 0, thinned: false },
    tArriveMs: 1_000 + idx,
    ...(opts.tBoardMs === undefined ? {} : { tBoardMs: opts.tBoardMs }),
    synthetic: false,
  };
}

function feed(rec: Recorder, f: FramePacket): void {
  (rec as unknown as { onFrame(x: FramePacket): void }).onFrame(f);
}

function lines(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\r\n"), file + " 必须以 CRLF 结尾");
  return text.split("\r\n").filter((x) => x.length > 0);
}

test("buildEncodeArgs 逐字任务书命令（含 fragmented MP4 标志）", () => {
  assert.deepEqual(buildEncodeArgs({ width: 800, height: 480, fps: 30, crf: 23, encoder: "libx264", output: "chunk-000.recording.mp4" }), [
    "-hide_banner", "-loglevel", "warning",
    "-f", "rawvideo", "-pixel_format", "rgb565be", "-video_size", "800x480", "-framerate", "30",
    "-i", "pipe:0", "-fps_mode", "passthrough",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23", "-g", "60",
    "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "chunk-000.recording.mp4",
  ]);
  assert.deepEqual(buildSealArgs("a.recording.mp4", "a.video.mp4"), [
    "-hide_banner", "-loglevel", "warning", "-y", "-i", "a.recording.mp4", "-c", "copy", "-movflags", "+faststart", "a.video.mp4",
  ]);
});

test("CSV 八列/三列、CRLF、逐行可解析", () => {
  const row = formatEventRow(7, 1500, { x: 11, y: 22, pol: 1, flags: 5, ts: 99 });
  assert.equal(row, "7,1500,11,22,1,ON,5,99");
  assert.ok(!row.endsWith("\r\n"));
  const built = buildChunkCsv([
    { recFrameIdx: 0, tBoardMs: 1000, tArriveMs: 900, events: [{ x: 1, y: 2, pol: 0, flags: 0, ts: 3 }] },
    { recFrameIdx: 1, tBoardMs: null, tArriveMs: 1200, events: [] },
  ]);
  assert.ok(built.framesCsv.startsWith(FRAMES_HEADER + "\r\n"));
  assert.ok(built.eventsCsv.startsWith(EVENTS_HEADER + "\r\n"));
  const eventRows = built.eventsCsv.split("\r\n").filter((x) => x.length > 0);
  assert.equal(eventRows.length, 2); // 表头 + 1 行
  assert.deepEqual(eventRows[1]?.split(",").length, 8);
  assert.equal(eventRows[1]?.split(",")[5], "OFF");
  assert.equal(built.framesCsv.split("\r\n")[2], "1,1200,1200");
});

test("录制一帧：768000 B 恰好一帧、frames/events 各一行、seal 生成 video 并删 frag", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    const started = await rec.start("unit");
    assert.equal(started.active, true);
    feed(rec, frame(0, { tBoardMs: 5000, events: [ev(1, 2, 1), ev(3, 4, 0)] }));
    const st = await rec.stop("unit-done");
    assert.equal(st.active, false);
    assert.equal(st.counters.frames, 1);
    assert.equal(st.counters.bytes, FRAME_BYTES);
    assert.equal(st.counters.events, 2);
    assert.equal(st.counters.droppedFrames, 0);
    const chunk = st.chunks[0];
    assert.ok(chunk);
    assert.equal(chunk.framesWritten, 1);
    assert.equal(chunk.eventsWritten, 2);
    assert.equal(chunk.finished, true);
    assert.ok((chunk.videoBytes ?? 0) > 0);
    assert.equal(chunk.fragBytes, 32);
    const session = st.session as string;
    const framesCsv = path.join(root, session, "chunk-000.frames.csv");
    const eventsCsv = path.join(root, session, "chunk-000.events.csv");
    assert.deepEqual(lines(framesCsv), [FRAMES_HEADER, "0,5000,1000"]);
    assert.deepEqual(lines(eventsCsv), [EVENTS_HEADER, "0,5000,1,2,1,ON,1,101", "0,5000,3,4,0,OFF,0,103"]);
    assert.ok(fs.existsSync(path.join(root, session, "chunk-000.video.mp4")));
    assert.ok(!fs.existsSync(path.join(root, session, "chunk-000.recording.mp4")));
    // 假 ffmpeg 的 sidecar 证明真正喂进去的字节数（不是只写 CSV）
    const fake = JSON.parse(fs.readFileSync(path.join(root, session, "chunk-000.recording.mp4.fake.json"), "utf8")) as { bytes: number };
    assert.equal(fake.bytes, FRAME_BYTES);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("帧字节数不符：丢弃并计 droppedFrames，不分配 frame_idx", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    await rec.start("bad-size");
    feed(rec, frame(0, { bytes: 100 }));
    const st = await rec.stop();
    assert.equal(st.counters.frames, 0);
    assert.equal(st.counters.droppedFrames, 1);
    const csv = lines(path.join(root, st.session as string, "chunk-000.frames.csv"));
    assert.deepEqual(csv, [FRAMES_HEADER]);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("stdin 背压：队列上限 8 帧，第 10 帧显式 droppedFrames++", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    await rec.start("backpressure");
    for (let i = 0; i < 10; i++) feed(rec, frame(i));
    const st = await rec.stop();
    assert.equal(st.counters.droppedFrames, 1);
    assert.equal(st.counters.frames, 9);
    const rows = lines(path.join(root, st.session as string, "chunk-000.frames.csv"));
    assert.equal(rows.length, 10); // 表头 + 9 帧
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("分段轮转：chunk-000/001 文件名正确，各自 frame_idx 从 0 起", async () => {
  const root = await tmpRoot();
  let t = 0;
  const rec = fakeRecorder(root, { chunkMs: 1000, now: () => t });
  try {
    await rec.start("rotate");
    t = 0;
    feed(rec, frame(0));
    t = 1001;
    feed(rec, frame(1));
    t = 1002;
    feed(rec, frame(2));
    const st = await rec.stop();
    assert.equal(st.chunks.length, 2);
    assert.equal(st.chunks[0]?.framesWritten, 1);
    assert.equal(st.chunks[1]?.framesWritten, 2);
    const session = st.session as string;
    assert.deepEqual(lines(path.join(root, session, "chunk-000.frames.csv")), [FRAMES_HEADER, "0,1000,1000"]);
    assert.deepEqual(lines(path.join(root, session, "chunk-001.frames.csv")), [FRAMES_HEADER, "0,1001,1001", "1,1002,1002"]);
    assert.ok(fs.existsSync(path.join(root, session, "chunk-000.video.mp4")));
    assert.ok(fs.existsSync(path.join(root, session, "chunk-001.video.mp4")));
    assert.ok(!fs.existsSync(path.join(root, session, "chunk-000.recording.mp4")));
    assert.ok(!fs.existsSync(path.join(root, session, "chunk-001.recording.mp4")));
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("ffmpeg 异常退出后重开一次并计数（chunk 数 +1）", async () => {
  const root = await tmpRoot();
  const flag = path.join(root, "fail-once.flag");
  fs.writeFileSync(flag, "1");
  process.env.FAKE_FFMPEG_FAIL_ONCE = flag;
  const rec = fakeRecorder(root);
  try {
    await rec.start("crash");
    await until(() => rec.status().ffmpeg.restarts >= 1);
    assert.equal(rec.status().ffmpeg.restarts, 1);
    assert.equal(rec.status().chunks.length, 2);
    feed(rec, frame(0));
    const st = await rec.stop();
    assert.equal(st.chunks.length, 2);
    assert.equal(st.active, false);
  } finally {
    delete process.env.FAKE_FFMPEG_FAIL_ONCE;
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("stop 幂等：并发/重复调用共享同一会话与 endedAt", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    await rec.start("idem");
    const p1 = rec.stop("idem");
    const p2 = rec.stop("idem");
    const a = await p1;
    const b = await p2;
    assert.equal(a.session, b.session);
    assert.equal(a.endedAt, b.endedAt);
    assert.equal(a.active, false);
    const c = await rec.stop("third");
    assert.equal(c.endedAt, a.endedAt);
    assert.equal(c.chunks.length, 1);
    const meta = JSON.parse(await fsp.readFile(path.join(root, a.session as string, "meta.json"), "utf8")) as { version: number; chunks: unknown[] };
    assert.equal(meta.version, 1);
    assert.equal(meta.chunks.length, 1);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("attachSource 订阅/切源：旧源解绑、新源继续录，chunk 内 frame_idx 连续", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  class FakeSource {
    private readonly listeners = new Set<(f: FramePacket) => void>();
    on(event: string, cb: (f: FramePacket) => void): () => void {
      if (event !== "frame") return () => {};
      this.listeners.add(cb);
      return () => { this.listeners.delete(cb); };
    }
    onEventsDetailed(): () => void { return () => {}; }
    emitFrame(f: FramePacket): void { for (const cb of this.listeners) cb(f); }
  }
  const a = new FakeSource();
  const b = new FakeSource();
  try {
    await rec.start("switch");
    rec.attachSource(a as never);
    a.emitFrame(frame(0));
    rec.attachSource(b as never); // 切源：a 的订阅必须退掉
    a.emitFrame(frame(1));
    b.emitFrame(frame(2));
    const st = await rec.stop();
    assert.equal(st.counters.frames, 2);
    assert.deepEqual(lines(path.join(root, st.session as string, "chunk-000.frames.csv")), [FRAMES_HEADER, "0,1000,1000", "1,1002,1002"]);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rawDump 模式额外落 chunk-000.raw（768000 B/帧）", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root, { rawDump: true });
  try {
    await rec.start("raw");
    feed(rec, frame(0));
    const st = await rec.stop();
    const raw = path.join(root, st.session as string, "chunk-000.raw");
    assert.equal(fs.statSync(raw).size, FRAME_BYTES);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("事件批次 dropped 计入 counters.droppedEvents（不写事件行）", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    await rec.start("dropped");
    const f = frame(0);
    feed(rec, { ...f, events: { records: [ev(9, 9, 1)], dropped: 3, thinned: false } });
    const st = await rec.stop();
    assert.equal(st.counters.droppedEvents, 3);
    assert.equal(st.counters.events, 1);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("磁盘低于阈值自动停录 reason=disk_low", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root, { diskCheckMs: 10, diskMinFreeBytes: 1, diskFreeBytes: async () => 0 });
  try {
    await rec.start("disk");
    await until(() => rec.status().active === false);
    const st = rec.status();
    assert.equal(st.reason, "disk_low");
    assert.equal(st.active, false);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------- task-35：视频体积 / 磁盘余量字段 ----------

test("bytesVideo = 当前 .recording.mp4 的实时大小，不混入原始帧字节；stat 失败算 0", async () => {
  const root = await tmpRoot();
  const rec = fakeRecorder(root);
  try {
    await rec.start("bytes-video");
    const cur = (rec as unknown as { current: { fragPath: string } }).current;
    await fsp.writeFile(cur.fragPath, Buffer.alloc(4096, 0x55));
    const st = rec.status();
    assert.equal(st.bytesVideo, 4096);
    // counters.bytes 是原始帧字节（这里 0 帧 = 0），绝不能拿来当视频体积
    assert.equal(st.counters.bytes, 0);
    assert.equal(st.chunk?.videoBytes, null);

    await fsp.rm(cur.fragPath, { force: true });
    assert.equal(rec.status().bytesVideo, 0);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("bytesVideo = 已封口 chunk 的 videoBytes 之和 + 当前 frag；stop 后只算 sealed", async () => {
  const root = await tmpRoot();
  let t = 0;
  const rec = fakeRecorder(root, { chunkMs: 1000, now: () => t });
  try {
    await rec.start("bytes-sum");
    t = 0;
    feed(rec, frame(0));
    t = 1001;
    feed(rec, frame(1)); // 同步轮转：chunk-000 进入后台 seal，chunk-001 成为 current
    await until(() => {
      const s = rec.status();
      return s.chunks.length === 2 && s.chunks[0]?.finished === true && s.chunks[0]?.videoBytes !== null;
    });
    const sealed = rec.status().chunks[0]?.videoBytes ?? -1;
    assert.ok(sealed > 0);
    const cur = (rec as unknown as { current: { fragPath: string } }).current;
    await fsp.writeFile(cur.fragPath, Buffer.alloc(100, 0x55));
    assert.equal(rec.status().bytesVideo, sealed + 100);

    const stopped = await rec.stop();
    const sealedTotal = stopped.chunks.reduce((n, c) => n + (c.videoBytes ?? 0), 0);
    assert.equal(stopped.chunks.length, 2);
    assert.ok((stopped.chunks[1]?.videoBytes ?? 0) > 0);
    assert.equal(stopped.bytesVideo, sealedTotal);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("diskFreeBytes 来自 checkDisk 缓存：首次采样前 null，status 不重复调 statfs", async () => {
  const root = await tmpRoot();
  let calls = 0;
  const rec = fakeRecorder(root, {
    diskCheckMs: 0,
    diskMinFreeBytes: 1,
    diskFreeBytes: async () => {
      calls++;
      return 300 * 1024 * 1024;
    },
  });
  try {
    await rec.start("disk-cache");
    assert.equal(rec.status().diskFreeBytes, null);
    await (rec as unknown as { checkDisk(): Promise<void> }).checkDisk();
    assert.equal(rec.status().diskFreeBytes, 300 * 1024 * 1024);
    const sampled = calls;
    for (let i = 0; i < 5; i++) rec.status();
    assert.equal(calls, sampled);
  } finally {
    await rec.stop("cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
});
