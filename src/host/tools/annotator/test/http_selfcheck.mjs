/**
 * annotator 的 HTTP 自检：真起服务、真发请求。零依赖。
 * 用法：node host/app/tools/annotator/test/http_selfcheck.mjs
 * 通过输出 ANNO_HTTP_OK=1；失败打印 FAIL 行并以 1 退出。
 *
 * 需要一个 fixture 根目录（默认 temp_test/anno_fixture/records），可用 --root 指定。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const DEFAULT_FIXTURE = path.join(repoRoot, "temp_test", "anno_fixture", "records");

const checks = [];
function ok(name, extra) {
  checks.push({ ok: true, name: name, extra: extra || "" });
  console.log("PASS " + name + (extra ? "  [" + extra + "]" : ""));
}
function fail(name, detail) {
  checks.push({ ok: false, name: name, extra: String(detail) });
  console.log("FAIL " + name + "  " + detail);
}

function parseRoot(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") return path.resolve(argv[i + 1]);
    if (argv[i].startsWith("--root=")) return path.resolve(argv[i].slice("--root=".length));
  }
  return DEFAULT_FIXTURE;
}

async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, extra);
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = parseRoot(process.argv.slice(2));
const started = await startServer({ port: 0, root: root, open: false });
const base = "http://127.0.0.1:" + started.port;
console.log("serve " + base + "  root=" + root);

try {
  let sessions = null;
  let videoPath = null;

  await check("GET / 返回 200 且是标注页（含 <video> 与 app.js）", async () => {
    const res = await fetch(base + "/");
    const text = await res.text();
    assert(res.status === 200, "status=" + res.status);
    assert(/<video\b/.test(text), "响应里没有 <video> 标签");
    assert(/app\.js/.test(text), "响应里没有 app.js");
    assert(/timeline/.test(text), "响应里没有 timeline 容器");
    return "status=200 bytes=" + Buffer.byteLength(text);
  });

  await check("GET /api/sessions 列出 fixture 会话与分段", async () => {
    const res = await fetch(base + "/api/sessions");
    const data = await res.json();
    assert(res.status === 200, "status=" + res.status);
    assert(data && data.ok === true, "ok!=true");
    sessions = data.sessions;
    assert(Array.isArray(sessions) && sessions.length === 2, "sessions.length=" + (sessions ? sessions.length : "null"));
    const names = sessions.map((s) => s.name).sort();
    assert(names[0] === "rec-20261030-190000" && names[1] === "rec-20261030-200000", "names=" + names.join(","));
    assert(!names.includes("not-a-session"), "没有分段视频的目录不该出现在会话列表");
    const a = sessions.find((s) => s.name === "rec-20261030-190000");
    assert(a.chunks.length === 3, "会话 A 分段数=" + a.chunks.length);
    const unsealed = a.chunks.find((c) => c.index === 1);
    assert(unsealed && unsealed.sealed === false, "chunk-001 应标记为未完成（只有 .recording.mp4）");
    const sealed = a.chunks.find((c) => c.index === 0);
    assert(sealed && sealed.sealed === true, "chunk-000 应已 seal");
    return "sessions=2 chunks=" + a.chunks.length;
  });

  await check("GET /api/chunk 返回 frames/events/labels 与桶聚合", async () => {
    const res = await fetch(base + "/api/chunk/rec-20261030-190000/0");
    const data = await res.json();
    assert(res.status === 200, "status=" + res.status);
    assert(data.ok === true, "ok!=true");
    assert(data.degraded === false, "degraded 应为 false（有 frames.csv）");
    assert(Array.isArray(data.frames) && data.frames.length === 200, "frames=" + (data.frames ? data.frames.length : "null"));
    assert(data.frameIndex && data.frameIndex.t0Ms === 1000, "t0Ms=" + (data.frameIndex ? data.frameIndex.t0Ms : "null"));
    assert(data.events && data.events.bucketMs === 100, "bucketMs=" + (data.events ? data.events.bucketMs : "null"));
    assert(data.events.total === 360, "events.total=" + data.events.total);
    assert(Array.isArray(data.events.counts) && data.events.counts.length > 0, "counts 为空");
    assert(data.labels && data.labels.types.length === 10, "labels.types=" + (data.labels ? data.labels.types.length : "null"));
    assert(data.labels.segments.length === 3, "labels.segments=" + data.labels.segments.length);
    assert(/^\/media\/rec-20261030-190000\/chunk-000\.video\.mp4$/.test(data.videoUrl), "videoUrl=" + data.videoUrl);
    videoPath = data.videoUrl;
    return "frames=200 events=" + data.events.total + " labels=3";
  });

  await check("视频 Range: bytes=0-99 → 206 + Content-Range 正确", async () => {
    const res = await fetch(base + videoPath, { headers: { Range: "bytes=0-99" } });
    const buf = Buffer.from(await res.arrayBuffer());
    assert(res.status === 206, "status=" + res.status);
    assert(res.headers.get("accept-ranges") === "bytes", "accept-ranges=" + res.headers.get("accept-ranges"));
    const cr = res.headers.get("content-range") || "";
    const m = /^bytes 0-99\/(\d+)$/.exec(cr);
    assert(m, "content-range=" + cr);
    assert(Number(m[1]) === 65536, "总长度=" + m[1]);
    assert(res.headers.get("content-length") === "100", "content-length=" + res.headers.get("content-length"));
    assert(buf.length === 100, "实际字节=" + buf.length);
    return "206 content-range=" + cr + " bytes=100";
  });

  await check("视频 Range 越界 → 416 + Content-Range: bytes */size", async () => {
    const res = await fetch(base + videoPath, { headers: { Range: "bytes=999999999-" } });
    await res.arrayBuffer();
    assert(res.status === 416, "status=" + res.status);
    assert(res.headers.get("content-range") === "bytes */65536", "content-range=" + res.headers.get("content-range"));
    return "416";
  });

  await check("GET → POST → GET labels 往返一致（原子落盘）", async () => {
    // chunk-002 故意没有 labels.json：先清掉上次自检留下的一份，保证「缺文件 → 默认值」也被测到
    fs.rmSync(path.join(root, "rec-20261030-190000", "chunk-002.labels.json"), { force: true });
    const url = base + "/api/labels/rec-20261030-190000/2";
    const first = await (await fetch(url)).json();
    assert(first.ok === true, "GET ok!=true");
    const labels = first.labels;
    assert(labels.version === 1 && labels.chunk === 2, "缺文件时应返回默认 labels（version/chunk）");
    assert(labels.types.length === 10 && labels.types[0].id === 0, "缺文件时应返回 10 个默认类型、id=0 无动作");
    assert(labels.segments.length === 0, "fixture chunk-002 原本应该没有片段");
    labels.types[1].name = "自检改名";
    labels.segments = [
      { id: 7, startMs: 1000, endMs: 1600, startFrame: 0, endFrame: 18, typeId: 1, note: "roundtrip" },
      { id: 8, startMs: 2000, endMs: 2600, startFrame: 30, endFrame: 48, typeId: 2, note: "" },
    ];
    const post = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(labels) });
    const saved = await post.json();
    assert(post.status === 200, "POST status=" + post.status);
    assert(saved.ok === true, "POST ok!=true");
    assert(typeof saved.file === "string" && saved.file.endsWith("chunk-002.labels.json"), "file=" + saved.file);
    const back = await (await fetch(url)).json();
    assert(back.ok === true, "GET2 ok!=true");
    assert(back.labels.segments.length === 2, "回读片段数=" + back.labels.segments.length);
    assert(back.labels.types[1].name === "自检改名", "类型改名没落盘：" + back.labels.types[1].name);
    assert(back.labels.segments[0].endMs === 1600 && back.labels.segments[1].typeId === 2, "片段字段回读不一致");
    return "segments 0 → 2，类型名与区间一致";
  });

  await check("路径穿越 ../ 与绝对路径被拒绝（4xx，不出内容）", async () => {
    const attacks = [
      "/media/..%2F..%2Fsecret.txt",
      "/media/rec-20261030-190000/..%2F..%2Fsecret.txt",
      "/media/rec-20261030-190000/chunk-000.video.mp4%2F..%2F..%2Fsecret.txt",
      "/media/%2Fetc%2Fpasswd",
      "/api/chunk/..%2F..%2Fetc/0",
      "/api/chunk/rec-20261030-190000/..%2F..%2Fsecret.txt",
    ];
    const statuses = [];
    for (const a of attacks) {
      const res = await fetch(base + a);
      const body = await res.text();
      statuses.push(a + "→" + res.status);
      assert(res.status === 400 || res.status === 404, a + " 返回 " + res.status);
      assert(!/TOP_SECRET_DO_NOT_SERVE/.test(body), a + " 泄漏了根目录外的文件！");
    }
    return statuses.join(" ");
  });

  await check("静态资源 /ui/{app,core}.js 与 style.css 可加载且 MIME 正确", async () => {
    const expect = [
      ["/ui/app.js", /javascript/],
      ["/ui/core.js", /javascript/],
      ["/ui/style.css", /text\/css/],
      ["/ui/index.html", /text\/html/],
    ];
    const got = [];
    for (const [p, re] of expect) {
      const res = await fetch(base + p);
      const body = await res.text();
      const ct = res.headers.get("content-type") || "";
      assert(res.status === 200, p + " status=" + res.status);
      assert(re.test(ct), p + " content-type=" + ct);
      assert(body.length > 500, p + " 内容过短：" + body.length);
      got.push(p + " " + body.length + "B");
    }
    return got.join(" ");
  });

  await check("未知路由 404、JSON 错误体统一", async () => {
    const res = await fetch(base + "/nope/nothing");
    const body = await res.text();
    assert(res.status === 404, "status=" + res.status);
    assert(/ok/.test(body) || /error/.test(body), "404 响应体：" + body.slice(0, 80));
    return "404";
  });
  // 根目录不存在时不能白屏：/api/sessions 要明确返回 exists=false，页面本身仍 200
  const ghost = await startServer({ port: 0, root: path.join(here, "__definitely_no_such_root__"), open: false });
  try {
    await check("根目录不存在：/api/sessions 返回 exists=false（UI 显示引导卡片）", async () => {
      const res = await fetch("http://127.0.0.1:" + ghost.port + "/api/sessions");
      const data = await res.json();
      assert(res.status === 200, "status=" + res.status);
      assert(data.ok === true, "ok!=true");
      assert(data.exists === false, "exists=" + data.exists);
      assert(Array.isArray(data.sessions) && data.sessions.length === 0, "sessions 应为空数组");
      const page = await fetch("http://127.0.0.1:" + ghost.port + "/");
      const text = await page.text();
      assert(page.status === 200, "页面 status=" + page.status);
      assert(/emptyState/.test(text) && /--root/.test(text), "空状态引导卡片缺失");
      return "exists=false sessions=0 页面含 emptyState/--root 指引";
    });
  } finally {
    if (typeof ghost.server.closeAllConnections === "function") ghost.server.closeAllConnections();
    await new Promise((resolve) => ghost.server.close(resolve));
  }
} finally {
  // 先断开 fetch 的 keep-alive 连接，再关服务，避免 Windows 上 libuv 关闭断言
  if (typeof started.server.closeAllConnections === "function") started.server.closeAllConnections();
  else if (typeof started.server.closeIdleConnections === "function") started.server.closeIdleConnections();
  await new Promise((resolve) => started.server.close(resolve));
}

const failed = checks.filter((c) => !c.ok);
console.log("----");
console.log("checks=" + checks.length + " pass=" + (checks.length - failed.length) + " fail=" + failed.length);
if (failed.length) {
  console.log("ANNO_HTTP_OK=0");
  for (const f of failed) console.log("  FAILED: " + f.name + " :: " + f.extra);
  // 不用 process.exit：Node 24/Windows 上在 close 未收敛时强退会触发 libuv async.c 断言
  process.exitCode = 1;
}
console.log("ANNO_HTTP_OK=1");
