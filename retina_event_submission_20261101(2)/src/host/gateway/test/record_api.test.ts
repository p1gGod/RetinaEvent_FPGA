// 长录 HTTP 接口（task-30 / REC_API_OK）：真实 http server + fetch，覆盖 start/status/stop、
// 409（已在录）、400（body 非法）、405（方法错误）、404（未知路径）与 stop 幂等。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Profile } from "@retina/protocol";
import { getProfile } from "@retina/protocol";
import { createWebServer, listenWebServer } from "../src/ipc/http.ts";
import { handleRec } from "../src/record/api.ts";
import { Recorder } from "../src/record/recorder.ts";

const PROFILE = getProfile("retina-v2-800x480-1280") as Profile;
const FIXTURE = path.resolve(import.meta.dirname, "../../tools/test/fixtures/fake_ffmpeg.mjs");

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  return JSON.parse(text) as Record<string, unknown>;
}

test("POST /rec/start → GET /rec/status → POST /rec/stop 全链路", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retina-rec-api-"));
  const rec = new Recorder({
    profile: PROFILE,
    root,
    ffmpegPath: process.execPath,
    ffmpegArgsPrefix: [FIXTURE],
    chunkMs: 60_000,
    // task-35：注入磁盘探测，避免 API 测试等 10 s 定时器；1 B 阈值只用于让采样不触发自动停录
    diskCheckMs: 0,
    diskMinFreeBytes: 1,
    diskFreeBytes: async () => 300 * 1024 * 1024,
  });
  const server = createWebServer({ root, rec: (req, res, url) => handleRec(req, res, url, rec) });
  const port = await listenWebServer(server, "127.0.0.1", 0);
  const base = "http://127.0.0.1:" + String(port);
  try {
    const initial = await fetch(base + "/rec/status");
    assert.equal(initial.status, 200);
    const s0 = await json(initial);
    assert.equal(s0["ok"], true);
    assert.equal(s0["active"], false);
    assert.deepEqual(s0["chunks"], []);
    assert.deepEqual(s0["counters"], { frames: 0, events: 0, droppedFrames: 0, droppedEvents: 0, bytes: 0 });
    assert.equal(s0["bytesVideo"], 0);
    assert.equal(s0["diskFreeBytes"], null); // 首次 statfs 采样前未知，不能伪装成 0

    const started = await fetch(base + "/rec/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "api-test" }),
    });
    assert.equal(started.status, 200);
    const s1 = await json(started);
    assert.equal(s1["active"], true);
    assert.match(String(s1["session"]), /_api-test$/);
    assert.equal((s1["chunk"] as Record<string, unknown>)["index"], 0);
    assert.equal(s1["bytesVideo"], 0); // 还没有碎片文件

    // 当前 .recording.mp4 写 1234 B：status 必须实时反映视频体积，且与原始字节无关
    const cur = (rec as unknown as { current: { fragPath: string } }).current;
    await fs.writeFile(cur.fragPath, Buffer.alloc(1234, 0x55));
    await (rec as unknown as { checkDisk(): Promise<void> }).checkDisk();

    const dup = await fetch(base + "/rec/start", { method: "POST" });
    assert.equal(dup.status, 409);
    assert.equal((await json(dup))["ok"], false);

    const status = await fetch(base + "/rec/status");
    assert.equal(status.status, 200);
    const s2 = await json(status);
    assert.equal(s2["active"], true);
    assert.equal(s2["session"], s1["session"]);
    assert.equal(s2["bytesVideo"], 1234);
    assert.equal(s2["diskFreeBytes"], 300 * 1024 * 1024);

    const stopped = await fetch(base + "/rec/stop", { method: "POST" });
    assert.equal(stopped.status, 200);
    const s3 = await json(stopped);
    assert.equal(s3["active"], false);
    assert.equal(s3["reason"], "api");
    assert.equal(s3["chunk"], null);
    // stop 后当前碎片已被 seal 成 32 B 占位视频，bytesVideo 只算 sealed videoBytes
    assert.equal(s3["bytesVideo"], 32);
    const chunks3 = s3["chunks"] as Record<string, unknown>[];
    assert.equal(chunks3.length, 1);
    assert.equal(chunks3[0]?.["videoBytes"], 32);

    // 幂等：第二次 stop 仍 200，且 endedAt 不再变化
    const stopped2 = await fetch(base + "/rec/stop", { method: "POST" });
    assert.equal(stopped2.status, 200);
    assert.equal((await json(stopped2))["endedAt"], s3["endedAt"]);

    const meta = JSON.parse(await fs.readFile(path.join(root, String(s1["session"]), "meta.json"), "utf8")) as { version: number; reason: string };
    assert.equal(meta.version, 1);
    assert.equal(meta.reason, "api");
  } finally {
    await rec.stop("cleanup");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("body 非法：非 JSON / 数组 / 未知字段 / label 非字符串 都 400", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retina-rec-api-"));
  const rec = new Recorder({ profile: PROFILE, root, ffmpegPath: process.execPath, ffmpegArgsPrefix: [FIXTURE] });
  const server = createWebServer({ root, rec: (req, res, url) => handleRec(req, res, url, rec) });
  const port = await listenWebServer(server, "127.0.0.1", 0);
  const base = "http://127.0.0.1:" + String(port);
  const post = (body: string) => fetch(base + "/rec/start", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  try {
    for (const body of ["{", "[1,2]", JSON.stringify({ foo: 1 }), JSON.stringify({ label: 3 }), JSON.stringify({ label: "" })]) {
      const res = await post(body);
      assert.equal(res.status, 400, body);
      assert.equal((await json(res))["ok"], false);
    }
    // 空 body 合法（等价于 {}）
    const empty = await fetch(base + "/rec/start", { method: "POST" });
    assert.equal(empty.status, 200);
    assert.equal((await json(empty))["active"], true);
  } finally {
    await rec.stop("cleanup");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("方法/路径错误：405 + Allow，未知 /rec 路径 404", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retina-rec-api-"));
  const rec = new Recorder({ profile: PROFILE, root, ffmpegPath: process.execPath, ffmpegArgsPrefix: [FIXTURE] });
  const server = createWebServer({ root, rec: (req, res, url) => handleRec(req, res, url, rec) });
  const port = await listenWebServer(server, "127.0.0.1", 0);
  const base = "http://127.0.0.1:" + String(port);
  try {
    const getStart = await fetch(base + "/rec/start");
    assert.equal(getStart.status, 405);
    assert.equal(getStart.headers.get("allow"), "POST");
    assert.match(String((await json(getStart))["error"]), /POST/);

    const postStatus = await fetch(base + "/rec/status", { method: "POST" });
    assert.equal(postStatus.status, 405);
    assert.equal(postStatus.headers.get("allow"), "GET, HEAD");

    for (const p of ["/rec", "/rec/unknown", "/rec/start/extra"]) {
      const res = await fetch(base + p, { method: "POST" });
      assert.equal(res.status, 404, p);
      assert.match(String((await json(res))["error"]), /未知/);
    }
  } finally {
    await rec.stop("cleanup");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
