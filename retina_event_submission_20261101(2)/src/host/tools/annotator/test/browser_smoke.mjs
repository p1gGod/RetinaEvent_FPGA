/**
 * 浏览器端冒烟：真 Chrome/Edge headless + CDP，验证标注页能加载真实长录、
 * 点时间轴定位、拖空白建段、Alt+3 打标、改类型名、Ctrl+S 保存、导出 segments.csv。
 *
 * 用法：node host/app/tools/annotator/test/browser_smoke.mjs [--root <目录>] [--keep-labels]
 * 依赖：本机 Chrome 或 Edge（Windows 默认安装位置），Node >= 22 自带 WebSocket。
 * 注意：每次运行会往 <root>/<session>/chunk-000.labels.json 写测试标注，结束后删除。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "../ui/core.js";
import { startServer } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const DEFAULT_ROOT = path.join(repoRoot, "temp_test", "rec_probe", "rec_60s_final");
const SCRATCH = path.join(repoRoot, "temp_test", "anno_fixture");
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, keepLabels: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = path.resolve(argv[i + 1]);
    else if (argv[i].startsWith("--root=")) out.root = path.resolve(argv[i].slice(7));
    else if (argv[i] === "--keep-labels") out.keepLabels = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.root)) {
  console.log("BROWSER_SKIP=1  找不到 " + args.root);
  process.exitCode = 0;
  process.exit();
}
const chromePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.log("BROWSER_SKIP=1  找不到 Chrome/Edge");
  process.exitCode = 0;
  process.exit();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error("等待超时：" + label + (lastErr ? "（最后错误：" + lastErr.message + "）" : ""));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(to);
        resolve();
      });
      this.ws.addEventListener("error", (ev) => {
        clearTimeout(to);
        reject(new Error("CDP WebSocket 出错：" + (ev.message || "unknown")));
      });
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP 已断开"));
      this.pending.clear();
    });
  }
  onMessage(raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.method + "：" + msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      const ex = d.exception || {};
      this.errors.push("exception: " + (ex.description || d.text || "unknown"));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = (msg.params.args || []).map((a) => a.value || a.description || "").join(" ");
      this.errors.push("console.error: " + text);
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry || {};
      if (e.level === "error" && !String(e.url || "").includes("favicon")) this.errors.push("log: " + e.text);
    }
    this.events.push(msg.method);
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("CDP 超时：" + method));
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      throw new Error("页面内异常：" + (ex.description || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }
  mouse(type, x, y, buttons) {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      buttons: buttons,
      clickCount: 1,
      pointerType: "mouse",
    });
  }
  async drag(x1, y1, x2, y2, steps) {
    await this.mouse("mousePressed", x1, y1, 1);
    const n = steps || 8;
    for (let i = 1; i <= n; i++) {
      await this.mouse("mouseMoved", x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 1);
      await sleep(15);
    }
    await this.mouse("mouseReleased", x2, y2, 0);
  }
  async key(key, code, vk, modifiers) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: modifiers || 0,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: modifiers || 0,
    });
  }
}

const checks = [];
function ok(name, extra) {
  checks.push(true);
  console.log("PASS " + name + (extra ? "  [" + extra + "]" : ""));
}
function bad(name, err) {
  checks.push(false);
  console.log("FAIL " + name + "  " + (err && err.message ? err.message : String(err)));
}
async function check(name, fn) {
  try {
    ok(name, await fn());
  } catch (err) {
    bad(name, err);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let server = null;
let chrome = null;
let cdp = null;
const profileDir = path.join(SCRATCH, "_browser_profile");
const downloadDir = path.join(SCRATCH, "_browser_downloads");
let labelsFile = null;

function chromeKill() {
  if (!chrome || chrome.killed) return;
  try {
    execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }
}

try {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  server = await startServer({ port: 0, root: args.root, open: false });
  const base = "http://127.0.0.1:" + server.port;
  console.log("annotator " + base + "  root=" + args.root);

  // 干净起点：删掉上一次测试可能残留的 labels（被测会话的第一段）
  const listing = await (await fetch(base + "/api/sessions")).json();
  const firstSession = (listing.sessions || []).find((s) => s.chunks && s.chunks.length);
  if (firstSession) {
    const firstChunk = firstSession.chunks[0];
    const stale = path.join(
      args.root,
      firstSession.name,
      "chunk-" + String(firstChunk.index).padStart(3, "0") + ".labels.json",
    );
    if (fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
      console.log("pre-clean " + stale);
    }
  }

  const cdpPort = await freePort();
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--remote-allow-origins=*",
      "--remote-debugging-port=" + cdpPort,
      "--user-data-dir=" + profileDir,
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const target = await waitUntil(
    async () => {
      const res = await fetch("http://127.0.0.1:" + cdpPort + "/json/list");
      const list = await res.json();
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    },
    20000,
    "Chrome 调试端口",
  );
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });

  await cdp.send("Page.navigate", { url: base + "/" });
  await waitUntil(async () => (await cdp.eval("document.readyState")) === "complete", 30000, "页面加载");
  await waitUntil(
    async () => (await cdp.eval("document.querySelectorAll('#sessionSelect option').length")) > 0,
    30000,
    "会话列表填充",
  );
  await waitUntil(
    async () => {
      const t = await cdp.eval("document.querySelector('#saveStatus').textContent");
      return t && t.indexOf("加载") < 0 && t.indexOf("保存中") < 0;
    },
    30000,
    "分段数据装载",
  );

  let pageInfo = null;
  await check("页面加载：无未捕获异常，会话/分段下拉已填充", async () => {
    pageInfo = await cdp.eval(
      "(() => { const q = (s) => document.querySelector(s); return { title: document.title, ready: document.readyState, sessions: document.querySelectorAll('#sessionSelect option').length, chunks: document.querySelectorAll('#chunkSelect option').length, session: q('#sessionSelect').value, chunk: q('#chunkSelect').value, saveStatus: q('#saveStatus').textContent, statusLeft: q('#statusLeft').textContent, emptyHidden: q('#emptyState').classList.contains('hidden'), types: document.querySelectorAll('#typeList .type-row').length, hotkey: q('#hotkeyBadge').textContent, mode: q('#hotkeyModeText').textContent, videoReady: q('#video').readyState, videoDur: q('#video').duration, videoMeta: q('#videoMeta').textContent, timelineHint: q('#timelineHint').textContent }; })()",
    );
    assert(pageInfo.ready === "complete", "readyState=" + pageInfo.ready);
    assert(pageInfo.sessions >= 1, "会话数=" + pageInfo.sessions);
    assert(pageInfo.emptyHidden === true, "空状态卡片没隐藏");
    assert(pageInfo.types === 10, "类型行数=" + pageInfo.types);
    assert(pageInfo.statusLeft.indexOf("帧 1293") >= 0, "状态栏没显示 1293 帧：" + pageInfo.statusLeft);
    assert(pageInfo.statusLeft.indexOf("时长") >= 0, "状态栏没显示时长");
    assert(pageInfo.saveStatus.length > 0, "保存状态为空");
    assert(pageInfo.saveStatus.indexOf("重建") < 0, "起点应有干净 labels，实际：" + pageInfo.saveStatus);
    const seg0 = await cdp.eval("document.querySelectorAll('#segmentList li').length");
    assert(seg0 === 0, "起点片段数应为 0，实际 " + seg0);
    return (
      "session=" + pageInfo.session + " chunks=" + pageInfo.chunks + " types=" + pageInfo.types +
      " saveStatus=" + pageInfo.saveStatus + " videoReady=" + pageInfo.videoReady + " dur=" + pageInfo.videoDur +
      " meta=" + JSON.stringify(pageInfo.videoMeta) + " hotkey=" + pageInfo.hotkey
    );
  });

  const chunkApi = await (
    await fetch(base + "/api/chunk/" + encodeURIComponent(pageInfo.session) + "/" + pageInfo.chunk)
  ).json();
  const fidx = core.buildFrameIndex(chunkApi.frames);
  const t0 = fidx.t0Ms;
  const totalMs = fidx.totalMs;
  const framesCsv = fs.readFileSync(path.join(args.root, pageInfo.session, chunkApi.files.frames), "utf8");
  const frameRows = core.parseFramesCsv(framesCsv).frames;
  labelsFile = path.join(args.root, pageInfo.session, "chunk-" + String(Number(pageInfo.chunk)).padStart(3, "0") + ".labels.json");
  console.log("chunkData totalMs=" + totalMs + " t0=" + t0 + " frames=" + fidx.count + " videoDur=" + chunkApi.videoUrl);

  const rect = await cdp.eval(
    "(() => { const c = document.querySelector('#timeline'); c.scrollIntoView({block:'center'}); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()",
  );
  assert(rect.w > 100 && rect.h > 100, "时间轴画布尺寸异常 " + JSON.stringify(rect));
  const laneY = rect.y + Math.min(rect.h - 20, Math.max(96, rect.h * 0.62));

  await check("点时间轴 60% 处 → 播放头按 frames.csv 定位（clock/frame/currentTime）", async () => {
    const x = rect.x + rect.w * 0.6;
    await cdp.mouse("mousePressed", x, rect.y + 10, 1);
    await cdp.mouse("mouseReleased", x, rect.y + 10, 0);
    await sleep(400);
    const s = await cdp.eval(
      "(() => { const q = (id) => document.querySelector(id); return { clock: q('#clock').textContent, frameInfo: q('#frameInfo').textContent, cur: q('#video').currentTime, playhead: q('#statusLeft').textContent }; })()",
    );
    const m = /(\d+):(\d+)\.(\d+)/.exec(s.clock);
    assert(m, "clock 文本格式：" + s.clock);
    const rel = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]);
    const expected = totalMs * 0.6;
    assert(Math.abs(rel - expected) < 800, "clock=" + s.clock + " rel=" + rel + " 期望约 " + Math.round(expected));
    const f = /frame (\d+)/.exec(s.frameInfo);
    assert(f, "frameInfo 无帧号：" + s.frameInfo);
    const frameIdx = Number(f[1]);
    assert(frameIdx >= 0 && frameIdx <= 1292, "帧号越界 " + frameIdx);
    assert(frameIdx > 600 && frameIdx < 900, "60% 处帧号不合理 " + frameIdx);
    assert(s.cur > 10, "video.currentTime 没动：" + s.cur);
    const abs = core.msAtFrame(fidx, frameIdx);
    assert(abs - t0 <= totalMs, "定位帧超出总长");
    return "clock=" + s.clock + " frame=" + frameIdx + " currentTime=" + s.cur.toFixed(3) + " 期望帧≈" + core.nearestFrameAtMs(fidx, t0 + expected).frameIdx;
  });

  await check("键盘 ←/Shift+← 逐帧（基于 frames.csv 帧号）", async () => {
    const before = await cdp.eval("document.querySelector('#frameInfo').textContent");
    await cdp.key("ArrowRight", "ArrowRight", 39, 0);
    await sleep(150);
    const one = await cdp.eval("document.querySelector('#frameInfo').textContent");
    await cdp.key("ArrowRight", "ArrowRight", 39, 8);
    await sleep(150);
    const ten = await cdp.eval("document.querySelector('#frameInfo').textContent");
    const f1 = Number(/(\d+)/.exec(one)[1]);
    const f2 = Number(/(\d+)/.exec(ten)[1]);
    const fb = Number(/(\d+)/.exec(before)[1]);
    assert(f1 === fb + 1, "单帧步进：" + fb + " -> " + f1);
    assert(f2 === f1 + 10, "Shift+方向键十帧步进：" + f1 + " -> " + f2);
    return "frame " + fb + " → " + f1 + " → " + f2;
  });

  await check("拖空白建段：片段列表 +1、自动保存写 labels.json（绝对板卡毫秒）", async () => {
    const y = laneY;
    await cdp.drag(rect.x + rect.w * 0.25, y, rect.x + rect.w * 0.55, y, 10);
    await sleep(300);
    const segCount = await cdp.eval("document.querySelectorAll('#segmentList li').length");
    assert(segCount === 1, "建段后片段数=" + segCount);
    const ui = await cdp.eval(
      "(() => ({ segCount: document.querySelector('#segCount').textContent, saveStatus: document.querySelector('#saveStatus').textContent, row: document.querySelector('#segmentList li') ? document.querySelector('#segmentList li').textContent : '', status: document.querySelector('#statusLeft').textContent }))()",
    );
    assert(ui.row.indexOf("无动作") >= 0, "新片段类型行：" + ui.row);
    await waitUntil(
      async () => (await cdp.eval("document.querySelector('#saveStatus').textContent")).indexOf("已保存") >= 0,
      8000,
      "自动保存",
    );
    await waitUntil(() => fs.existsSync(labelsFile), 5000, "labels.json 落盘");
    const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
    assert(labels.version === 1, "labels.version=" + labels.version);
    assert(labels.segments.length === 1, "磁盘片段数=" + labels.segments.length);
    const seg = labels.segments[0];
    assert(seg.typeId === 0, "typeId=" + seg.typeId);
    assert(seg.startMs > t0 && seg.endMs < t0 + totalMs, "区间超出会话");
    const expectDur = totalMs * 0.3;
    assert(Math.abs(seg.endMs - seg.startMs - expectDur) < 1500, "片段时长 " + (seg.endMs - seg.startMs) + " 期望约 " + Math.round(expectDur));
    assert(seg.startFrame >= 0 && seg.endFrame <= 1292 && seg.startFrame < seg.endFrame, "帧边界 " + seg.startFrame + ".." + seg.endFrame);
    const expectedStartFrame = core.frameAtMs(fidx, seg.startMs).frameIdx;
    assert(seg.startFrame === expectedStartFrame, "startFrame=" + seg.startFrame + " 期望 " + expectedStartFrame);
    return (
      "row=" + ui.row.slice(0, 40) + " saveStatus=" + ui.saveStatus + " labels[startMs=" + seg.startMs +
      " endMs=" + seg.endMs + " frames=" + seg.startFrame + ".." + seg.endFrame + "]"
    );
  });

  await check("Alt+3 给选中片段打标 → labels.typeId=3（动作三）", async () => {
    await cdp.key("3", "Digit3", 51, 1);
    await sleep(200);
    const row = await cdp.eval("document.querySelector('#segmentList li').textContent");
    assert(row.indexOf("动作三") >= 0, "片段行没变类型：" + row);
    await waitUntil(() => fs.existsSync(labelsFile), 5000, "labels.json");
    await waitUntil(async () => {
      try {
        return JSON.parse(fs.readFileSync(labelsFile, "utf8")).segments[0].typeId === 3;
      } catch {
        return false;
      }
    }, 8000, "typeId 落盘");
    const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
    return "row=" + row.slice(0, 40) + " typeId=" + labels.segments[0].typeId;
  });

  await check("右栏改类型名 → 自动保存到 labels.types[3].name", async () => {
    const renamed = "自检改名三";
    await cdp.eval(
      "(() => { const inputs = document.querySelectorAll('#typeList .type-name'); const i = inputs[3]; if (!i) return false; i.focus(); i.value = " + JSON.stringify(renamed) + "; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
    );
    await sleep(300);
    const shown = await cdp.eval("document.querySelector('#segmentList li').textContent");
    assert(shown.indexOf(renamed) >= 0, "片段行未显示新类型名：" + shown);
    await waitUntil(async () => {
      try {
        const ls = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
        return ls.types.some((t) => t.id === 3 && t.name === renamed);
      } catch {
        return false;
      }
    }, 8000, "类型改名落盘");
    const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
    const t = labels.types.find((x) => x.id === 3);
    assert(t && t.name === renamed, "labels.types[3]=" + JSON.stringify(t));
    return "types[3].name=" + t.name + " types=" + labels.types.length + " 段类型=" + labels.segments[0].typeId;
  });

  await check("Ctrl+S 立即保存：状态栏提示 + labels.updatedAt 刷新", async () => {
    const before = JSON.parse(fs.readFileSync(labelsFile, "utf8")).updatedAt;
    await sleep(20);
    await cdp.key("s", "KeyS", 83, 2);
    await waitUntil(
      async () => (await cdp.eval("document.querySelector('#statusLeft').textContent")).indexOf("立即保存") >= 0,
      5000,
      "Ctrl+S 状态提示",
    );
    await waitUntil(() => {
      try {
        return JSON.parse(fs.readFileSync(labelsFile, "utf8")).updatedAt !== before;
      } catch {
        return false;
      }
    }, 5000, "updatedAt 刷新");
    const after = JSON.parse(fs.readFileSync(labelsFile, "utf8")).updatedAt;
    return "updatedAt " + before + " → " + after;
  });

  await check("导出 segments.csv（浏览器下载到临时目录，内容/列头正确）", async () => {
    const before = new Set(fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : []);
    await cdp.eval("document.querySelector('#exportBtn').click()");
    const file = await waitUntil(() => {
      const files = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
      const fresh = files.filter((f) => !before.has(f) && f.endsWith(".segments.csv"));
      if (!fresh.length) return null;
      const p = path.join(downloadDir, fresh[0]);
      return fs.statSync(p).size > 0 ? p : null;
    }, 10000, "segments.csv 下载");
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    assert(lines[0] === core.SEGMENTS_HEADER, "列头=" + lines[0]);
    assert(lines.length === 2, "行数=" + lines.length + "（应 1 片段 + 表头）");
    const cols = lines[1].split(",");
    assert(Number(cols[5]) === 3, "typeId 列=" + cols[5]);
    assert(Number(cols[1]) > t0 && Number(cols[2]) < t0 + totalMs, "导出的毫秒不是绝对板卡时间：" + lines[1]);
    return "file=" + path.basename(file) + " bytes=" + Buffer.byteLength(text) + " row=" + lines[1];
  });

  await check("Delete 删除选中片段 → 磁盘 segments 清空", async () => {
    await cdp.eval("document.querySelector('#segmentList li').click()");
    await sleep(100);
    await cdp.key("Delete", "Delete", 46, 0);
    await sleep(200);
    const n = await cdp.eval("document.querySelectorAll('#segmentList li').length");
    assert(n === 0, "删除后片段数=" + n);
    await waitUntil(() => {
      try {
        return JSON.parse(fs.readFileSync(labelsFile, "utf8")).segments.length === 0;
      } catch {
        return false;
      }
    }, 8000, "空片段落盘");
    return "segments 0，labels 已自动保存";
  });

  await check("全程无未捕获 JS 异常 / console.error", async () => {
    const errs = cdp.errors.filter((e) => e.indexOf("favicon") < 0);
    assert(errs.length === 0, "捕获到 " + errs.length + " 条：" + errs.slice(0, 3).join(" | "));
    return "errors=0（含资源加载失败检查）";
  });
} catch (err) {
  bad("浏览器冒烟基础设施", err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
} finally {
  try {
    if (cdp && cdp.ws) cdp.ws.close();
  } catch {
    /* ignore */
  }
  chromeKill();
  if (server) {
    if (typeof server.server.closeAllConnections === "function") server.server.closeAllConnections();
    await new Promise((resolve) => server.server.close(resolve));
  }
  if (labelsFile && fs.existsSync(labelsFile) && !args.keepLabels) {
    fs.rmSync(labelsFile, { force: true });
    console.log("cleanup " + labelsFile);
  }
  for (const dir of [profileDir, downloadDir]) {
    for (let i = 0; i < 8; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

const failed = checks.filter((c) => !c).length;
console.log("----");
console.log("browser checks=" + checks.length + " pass=" + (checks.length - failed) + " fail=" + failed);
if (failed) {
  console.log("BROWSER_OK=0");
  process.exitCode = 1;
} else {
  console.log("BROWSER_OK=1");
}
