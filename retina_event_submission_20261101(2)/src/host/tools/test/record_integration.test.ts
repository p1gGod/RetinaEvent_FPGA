// 长录真 ffmpeg 集成（task-30 / REC_INTEGRATION_OK）：
// --synth 30 fps 喂 3 秒 → 网关 --record 真编码 → POST /rec/stop 转封装 →
// ffprobe -count_frames 的 nb_read_frames 必须等于 frames.csv 行数（fragmented MP4 的 nb_frames 是 N/A）。
// 默认 skip；手动：REC_E2E=1 node --experimental-strip-types --test tools/test/record_integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EVENTS_HEADER, FRAMES_HEADER } from "../../gateway/src/record/csv.ts";

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const FFMPEG = process.env["REC_FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["REC_FFPROBE"] ?? "ffprobe";
const REC_E2E = process.env["REC_E2E"] === "1";
/** 录制时长（秒）：默认 3；现场复验可设 60 产出完整 1 分钟素材 */
const REC_SECONDS = Math.max(1, Number(process.env["REC_SECONDS"] ?? "3") || 3);
/** 最低有效帧率（10 fps）：只防"录了 3 秒却一帧没有"，不假设 --synth 一定能跑满 30 fps */
const MIN_FRAMES = Math.max(10, Math.round(REC_SECONDS * 10));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok && p >= 18000 && p !== 8787 && p !== 1234) return p;
  }
  throw new Error("在 " + start + " 附近找不到空闲端口");
}

async function waitJson(url: string, predicate: (j: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      last = String(res.status) + " " + text.slice(0, 200);
      if (res.ok) {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (predicate(j)) return j;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(100);
  }
  throw new Error("等待 " + url + " 超时；最后响应: " + last);
}

function ffprobeValue(args: readonly string[]): string {
  const r = spawnSync(FFPROBE, args, { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, "ffprobe 失败: " + String(r.stderr));
  return (r.stdout ?? "").trim();
}

async function killAndWait(child: ChildProcess, ms = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const t0 = Date.now();
  while (child.exitCode === null && child.signalCode === null && Date.now() - t0 < ms) await delay(50);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await delay(200);
  }
}

test("synth " + String(REC_SECONDS) + " 秒 + 真 ffmpeg：nb_read_frames == frames.csv 行数", { skip: REC_E2E ? false : "设置 REC_E2E=1 才跑真 ffmpeg 集成", timeout: REC_SECONDS * 2000 + 120_000 }, async () => {
  const ff = spawnSync(FFMPEG, ["-version"], { encoding: "utf8", windowsHide: true });
  if (ff.status !== 0) {
    assert.fail("ffmpeg 不可用（" + FFMPEG + "）：" + String(ff.stderr).slice(0, 300));
  }
  const keep = process.env["REC_OUT"];
  const root = keep === undefined ? await fsp.mkdtemp(path.join(os.tmpdir(), "retina-rec-int-")) : path.resolve(keep);
  await fsp.mkdir(root, { recursive: true });
  const port = await freePort(18731);
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "gateway/src/main.ts",
    "--synth", "--speed", "9.09", "--frames", "0",
    "--record", "--record-root", root, "--record-chunk-min", "5",
    "--ffmpeg", FFMPEG, "--ws-port", String(port),
  ], { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  child.stderr?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  const base = "http://127.0.0.1:" + String(port);
  try {
    const started = await waitJson(base + "/rec/status", (j) => j["active"] === true, 15_000);
    const session = String(started["session"]);
    const framesCsvPath = path.join(root, session, "chunk-000.frames.csv");
    // 约 3 秒（30 fps → 90 帧），额外等一点余量；以 frames.csv 实际数量为准
    // 按墙钟录满 REC_SECONDS 秒（--synth 的实际帧率受编码/打包 CPU 影响，不强行按 30 fps 等帧数）
    const running = await waitJson(base + "/rec/status", (j) => (j["durationMs"] as number) >= REC_SECONDS * 1000 && ((j["counters"] as Record<string, number>)["frames"] ?? 0) >= MIN_FRAMES, REC_SECONDS * 1000 + 60_000);
    assert.ok(((running["counters"] as Record<string, number>)["frames"] ?? 0) >= MIN_FRAMES);
    const stopRes = await fetch(base + "/rec/stop", { method: "POST" });
    assert.equal(stopRes.status, 200);
    const stopped = JSON.parse(await stopRes.text()) as Record<string, unknown>;
    assert.equal(stopped["active"], false);
    const chunks = stopped["chunks"] as Record<string, unknown>[];
    assert.equal(chunks.length, 1);
    const chunk = chunks[0] as Record<string, unknown>;
    assert.equal(chunk["finished"], true);
    assert.ok((chunk["videoBytes"] as number) > 0);
    assert.ok((chunk["fragBytes"] as number) > 0);
    const video = path.join(root, session, String(chunk["video"]));
    assert.ok(fs.existsSync(video), video);
    assert.ok(!fs.existsSync(path.join(root, session, "chunk-000.recording.mp4")));

    const framesText = await fsp.readFile(framesCsvPath, "utf8");
    assert.ok(framesText.startsWith(FRAMES_HEADER + "\r\n"));
    const frameRows = framesText.split("\r\n").filter((x) => x.length > 0);
    const recorded = frameRows.length - 1;
    assert.ok(recorded >= MIN_FRAMES, "frames.csv 只写了 " + recorded + " 帧（低于 " + MIN_FRAMES + "）");
    for (let i = 1; i < frameRows.length; i++) {
      const cols = frameRows[i]?.split(",") ?? [];
      assert.equal(cols.length, 3);
      assert.equal(cols[0], String(i - 1), "frame_idx 必须本 chunk 内 0 起严格递增");
    }
    const eventsText = await fsp.readFile(path.join(root, session, "chunk-000.events.csv"), "utf8");
    assert.ok(eventsText.startsWith(EVENTS_HEADER + "\r\n"));

    // 关键判据：fragmented MP4 的 stream=nb_frames 是 N/A，必须 -count_frames 实测 nb_read_frames
    const nbRead = Number(ffprobeValue([
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1", video,
    ]).replace(/^nb_read_frames=/, ""));
    assert.equal(nbRead, recorded, "nb_read_frames 必须等于 frames.csv 行数");

    const meta = JSON.parse(await fsp.readFile(path.join(root, session, "meta.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta["version"], 1);
    assert.equal(meta["fpsNominal"], 30);
    assert.equal(meta["session"], session);
    assert.equal(meta["reason"], "api");
    assert.equal((meta["chunks"] as unknown[]).length, 1);
    const counters = meta["counters"] as Record<string, number>;
    assert.equal(counters["frames"], recorded);
    assert.equal(counters["bytes"], recorded * 768000);

    // 编码参数（真 ffmpeg 产物，不是假 fixture）
    const probe = JSON.parse(ffprobeValue(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "json", video])) as { streams: Record<string, string>[] };
    const vs = probe.streams[0] as Record<string, string>;
    assert.equal(vs["codec_name"], "h264");
    assert.equal(Number(vs["width"]), 800);
    assert.equal(Number(vs["height"]), 480);
    assert.equal(vs["r_frame_rate"], "30/1");
    console.log("REC_INTEGRATION_OK=1 session=" + session + " frames=" + String(recorded) + " nb_read_frames=" + String(nbRead) + " video=" + video + " bytes=" + String(chunk["videoBytes"]));
  } catch (err) {
    console.error("网关输出:\n" + out.slice(-4000));
    throw err;
  } finally {
    // 先 HTTP 幂等停录，再结束子进程；失败路径也不能留下网关
    try { await fetch(base + "/rec/stop", { method: "POST" }); } catch { /* 进程可能已退出 */ }
    await killAndWait(child);
    if (keep === undefined) await fsp.rm(root, { recursive: true, force: true });
  }
});
