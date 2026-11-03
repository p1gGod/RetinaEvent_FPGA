/**
 * 用真实长录（temp_test/rec_probe/rec_60s_final）验证 annotator 的关键换算与存取。
 * 用法：node host/app/tools/annotator/test/realdata_check.mjs [--root <目录>]
 *
 * 为什么需要它：这份数据墙钟 60s、视频容器 43.1s、fpsNominal=30、实际 ~21.5fps，
 * 正是「不能拿 video.currentTime 当时间轴」的现场证据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../ui/core.js";
import { startServer } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const DEFAULT_ROOT = path.join(repoRoot, "temp_test", "rec_probe", "rec_60s_final");

function parseRoot(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") return path.resolve(argv[i + 1]);
    if (argv[i].startsWith("--root=")) return path.resolve(argv[i].slice("--root=".length));
  }
  return DEFAULT_ROOT;
}

const checks = [];
function ok(name, extra) {
  checks.push(true);
  console.log("PASS " + name + (extra ? "  [" + extra + "]" : ""));
}
function fail(name, detail) {
  checks.push(false);
  console.log("FAIL " + name + "  " + detail);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function check(name, fn) {
  try {
    ok(name, await fn());
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
  }
}

const root = parseRoot(process.argv.slice(2));
if (!fs.existsSync(root)) {
  console.log("REALDATA_SKIP=1  找不到 " + root);
  process.exitCode = 0;
  process.exit();
}

let started = null;
try {
  started = await startServer({ port: 0, root: root, open: false });
  const base = "http://127.0.0.1:" + started.port;
  console.log("serve " + base + "  root=" + root);

  const listing = await (await fetch(base + "/api/sessions")).json();
  assert(listing.ok === true, "/api/sessions ok!=true");
  const session = listing.sessions.find((s) => s.chunks.length > 0);
  assert(session, "没有可用会话");
  const sessName = session.name;
  const chunk = session.chunks[0];
  const framesPath = path.join(root, sessName, chunk.frames);
  const eventsPath = path.join(root, sessName, chunk.events);
  const framesText = fs.readFileSync(framesPath, "utf8");
  const parsedFrames = core.parseFramesCsv(framesText);
  const frames = parsedFrames.frames;

  await check("meta.json 的 chunks[].video/events/frames 按会话目录拼（是文件名，不是绝对路径）", async () => {
    assert(chunk.video === "chunk-000.video.mp4", "video=" + chunk.video);
    assert(chunk.events === "chunk-000.events.csv", "events=" + chunk.events);
    assert(chunk.frames === "chunk-000.frames.csv", "frames=" + chunk.frames);
    assert(chunk.sealed === true, "sealed 应为 true");
    assert(chunk.videoBytes === 46183970, "videoBytes=" + chunk.videoBytes);
    assert(!path.isAbsolute(chunk.video), "chunk.video 不该是绝对路径");
    return "session=" + sessName + " video=" + chunk.video + " (" + chunk.videoBytes + "B)";
  });

  await check("frames.csv 行数 = 视频帧数 + 1，frame_idx 严格递增", async () => {
    const lines = framesText.split(/\r?\n/).filter((l) => l.trim() !== "");
    assert(lines.length === 1294, "行数(含表头)=" + lines.length);
    assert(lines[0] === core.FRAMES_HEADER, "表头=" + lines[0]);
    assert(frames.length === 1293, "解析帧数=" + frames.length);
    assert(parsedFrames.skipped === 0, "跳过的坏行=" + parsedFrames.skipped);
    let inc = true;
    for (let i = 1; i < frames.length; i++) {
      if (!(frames[i].frameIdx > frames[i - 1].frameIdx)) inc = false;
    }
    assert(inc, "frame_idx 不是严格递增");
    return "1294 行（表头 1 + 帧 1293）";
  });

  let chunkData = null;
  let fidx = null;
  await check("GET /api/chunk 给出真实 t0/totalMs/帧数，且 events.csv 只有表头时 total=0、密度全 0", async () => {
    const res = await fetch(base + "/api/chunk/" + sessName + "/0");
    chunkData = await res.json();
    assert(res.status === 200, "status=" + res.status);
    assert(chunkData.degraded === false, "degraded=" + chunkData.degraded);
    assert(Array.isArray(chunkData.frames) && chunkData.frames.length === 1293, "payload frames=" + (chunkData.frames && chunkData.frames.length));
    fidx = core.buildFrameIndex(chunkData.frames);
    assert(fidx.count === 1293 && fidx.frames.length === 1293, "buildFrameIndex 后 count=" + fidx.count);
    assert(chunkData.fpsNominal === 30, "fpsNominal=" + chunkData.fpsNominal);
    assert(chunkData.frameIndex.count === 1293, "frameIndex.count=" + chunkData.frameIndex.count);
    assert(chunkData.frameIndex.t0Ms === frames[0].tBoardMs, "t0Ms=" + chunkData.frameIndex.t0Ms + " 首帧=" + frames[0].tBoardMs);
    assert(chunkData.frameIndex.totalMs === frames[1292].tBoardMs - frames[0].tBoardMs, "totalMs 不等于末帧-首帧");
    const evText = fs.readFileSync(eventsPath, "utf8");
    assert(core.parseEventsCsv(evText).events.length === 0, "events.csv 本该只有表头");
    assert(chunkData.events.total === 0, "events.total=" + chunkData.events.total);
    assert(chunkData.events.counts.length > 0, "counts 不能是空数组（长度按 totalMs 定）");
    assert(chunkData.events.counts.every((v) => v === 0), "只有表头时密度应全 0");
    assert(chunkData.labels.segments.length === 0, "还没有 labels.json，应为空片段");
    assert(chunkData.labels.types.length === 10, "默认 10 个类型");
    return "t0=" + chunkData.frameIndex.t0Ms + " totalMs=" + chunkData.frameIndex.totalMs + " counts=" + chunkData.events.counts.length + " 桶";
  });

  await check("★30fps 陷阱：视频时间→帧号→t_board_ms，全部对上 frames.csv（不能用 currentTime 当时间）", async () => {
    const samples = [0, 5, 21.5, 30, 40, 43.09];
    const out = [];
    let maxDrift = 0;
    for (const tSec of samples) {
      const frame = Math.min(1292, Math.max(0, core.videoTimeToFrame(tSec, 30)));
      const abs = core.msAtFrame(fidx, frame);
      assert(Math.abs(abs - frames[frame].tBoardMs) < 1e-6, "t=" + tSec + "s frame=" + frame + " 换算 " + abs + " != " + frames[frame].tBoardMs);
      const rel = abs - fidx.t0Ms;
      const drift = tSec * 1000 - rel;
      maxDrift = Math.max(maxDrift, Math.abs(drift));
      out.push("t=" + tSec + "s→f" + frame + "→板卡偏移" + Math.round(rel) + "ms");
    }
    assert(maxDrift > 5000, "最大偏差只有 " + maxDrift + "ms，这份数据的 30fps 陷阱不明显？");
    return out.join("；") + "；最大 PTS 偏差=" + Math.round(maxDrift) + "ms";
  });

  await check("二分定位：时间轴 ms → 最近帧 → frame/fps 精确 seek → 帧号往返一致", async () => {
    const targets = [0, 5000, 20000, 40000, fidx.totalMs];
    const out = [];
    for (const rel of targets) {
      const abs = fidx.t0Ms + rel;
      const f = core.nearestFrameAtMs(fidx, abs);
      assert(f, "rel=" + rel + " 找不到帧");
      const vt = core.frameToVideoTime(f.frameIdx, 30);
      const f2 = core.videoTimeToFrame(vt, 30);
      assert(f2 === f.frameIdx, "往返帧号 " + f.frameIdx + " -> " + f2);
      const backAbs = core.msAtFrame(fidx, f2);
      assert(Math.abs(backAbs - f.tBoardMs) < 1e-6, "回读板卡时间不一致");
      out.push("rel=" + rel + "ms→f" + f.frameIdx + "→seek " + vt.toFixed(3) + "s");
    }
    return out.join(" ");
  });

  await check("★拖动时间轴：像素 → 相对 ms（含缩放）→ 最近帧，全宽 1000px 单调且不越界", async () => {
    const width = 1000;
    let prev = -1;
    let prevPx = -1;
    const view = core.fitView(fidx.totalMs, width);
    for (let x = 0; x <= width; x += 50) {
      const rel = core.pxToMs(x, view);
      const f = core.nearestFrameAtMs(fidx, fidx.t0Ms + rel);
      assert(f, "x=" + x + " 找不到帧");
      assert(f.frameIdx >= 0 && f.frameIdx <= 1292, "x=" + x + " 越界帧号 " + f.frameIdx);
      assert(f.frameIdx >= prev, "拖动时帧号倒退：x=" + x);
      prev = f.frameIdx;
      prevPx = x;
    }
    // 放大 2 倍后再拖，仍要落在合法帧上
    const zoomed = core.zoomViewAt(core.fitView(fidx.totalMs, width), 2, width / 2, fidx.totalMs, width);
    const zf = core.nearestFrameAtMs(fidx, fidx.t0Ms + core.pxToMs(width / 2, zoomed));
    assert(zf && zf.frameIdx >= 0 && zf.frameIdx <= 1292, "放大后拖动越界");
    return "x 0..1000px 共 21 个采样点单调，末点 f" + prev + "；放大 2x 中心 f" + zf.frameIdx + "；px→ms 用 fitView/pxToMs/zoomViewAt";
  });

  await check("建段 + POST labels + GET 回读：落盘绝对板卡毫秒，frame 来自 frames.csv", async () => {
    const relStart = 12345;
    const relEnd = 23456;
    const seg = core.makeSegment(
      { startMs: relStart, endMs: relEnd, typeId: 2, note: "真实数据自检" },
      { index: fidx, t0Ms: fidx.t0Ms, totalMs: fidx.totalMs, fpsNominal: 30 },
    );
    assert(seg, "makeSegment 返回 null");
    const expectStartFrame = core.frameAtMs(fidx, fidx.t0Ms + relStart).frameIdx;
    assert(seg.startFrame === expectStartFrame, "startFrame=" + seg.startFrame + " 期望 " + expectStartFrame);
    const labels = {
      version: 1,
      session: sessName,
      chunk: 0,
      fpsNominal: 30,
      types: chunkData.labels.types,
      segments: core.segmentsToLabels([seg], fidx.t0Ms),
    };
    const url = base + "/api/labels/" + sessName + "/0";
    const post = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(labels) });
    const saved = await post.json();
    assert(post.status === 200 && saved.ok === true, "POST 失败：" + (saved && saved.error));
    const back = await (await fetch(url)).json();
    const got = back.labels.segments[0];
    assert(got, "回读没有片段");
    assert(got.startMs === fidx.t0Ms + relStart, "startMs=" + got.startMs + " 期望 " + (fidx.t0Ms + relStart));
    assert(got.endMs === fidx.t0Ms + relEnd, "endMs=" + got.endMs);
    assert(got.startFrame === seg.startFrame && got.endFrame === seg.endFrame, "frame 边界回读不一致");
    assert(got.typeId === 2 && got.note === "真实数据自检", "typeId/note 回读不一致");
    const file = path.join(root, sessName, "chunk-000.labels.json");
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(disk.segments.length === 1, "磁盘上片段数=" + disk.segments.length);
    return "startMs=" + got.startMs + " endMs=" + got.endMs + " frames=" + got.startFrame + ".." + got.endFrame + " file=" + file;
  });

  await check("46MB 真视频 Range：0-99 → 206，末尾 10 字节 → 206，Content-Range 总长一致", async () => {
    const size = chunk.videoBytes;
    const r1 = await fetch(base + chunkData.videoUrl, { headers: { Range: "bytes=0-99" } });
    const b1 = Buffer.from(await r1.arrayBuffer());
    assert(r1.status === 206, "status=" + r1.status);
    assert(r1.headers.get("content-range") === "bytes 0-99/" + size, "content-range=" + r1.headers.get("content-range"));
    assert(b1.length === 100, "字节数=" + b1.length);
    assert(b1[4] === 0x66 && b1[5] === 0x74 && b1[6] === 0x79 && b1[7] === 0x70, "开头不是 ftyp box，可能读错了文件");
    const from = size - 10;
    const r2 = await fetch(base + chunkData.videoUrl, { headers: { Range: "bytes=" + from + "-" } });
    const b2 = Buffer.from(await r2.arrayBuffer());
    assert(r2.status === 206, "尾部 status=" + r2.status);
    assert(r2.headers.get("content-range") === "bytes " + from + "-" + (size - 1) + "/" + size, "尾部 content-range=" + r2.headers.get("content-range"));
    assert(b2.length === 10, "尾部字节数=" + b2.length);
    return "size=" + size + " 头 100B + 尾 10B 均 206";
  });

  // 清掉自检写进去的 labels，保持原始长录干净（文件内容已在上面验证过）
  const labelFile = path.join(root, sessName, "chunk-000.labels.json");
  if (fs.existsSync(labelFile)) {
    fs.rmSync(labelFile, { force: true });
    console.log("cleanup " + labelFile);
  }
} catch (err) {
  fail("真数据自检跑掛了", err && err.stack ? err.stack.split("\n")[0] : String(err));
} finally {
  if (started) {
    if (typeof started.server.closeAllConnections === "function") started.server.closeAllConnections();
    await new Promise((resolve) => started.server.close(resolve));
  }
}

const failed = checks.filter((c) => !c).length;
console.log("----");
console.log("realdata checks=" + checks.length + " pass=" + (checks.length - failed) + " fail=" + failed);
if (failed) {
  console.log("REALDATA_OK=0");
  process.exitCode = 1;
} else {
  console.log("REALDATA_OK=1");
}
