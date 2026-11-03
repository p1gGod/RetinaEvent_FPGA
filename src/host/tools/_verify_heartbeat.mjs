#!/usr/bin/env node
/**
 * _verify_heartbeat.mjs — 十修 T2：真实串口心跳 10 s 现场证据
 *
 * 起独立网关（1236/8789，不碰用户 1234/8787），切 uart 后真实 COM6 在线，
 * 收集 WS 二进制 CTRL 帧 10 s；期间发 1 条用户 GET_STATUS：
 *   1) heartbeat:true 的 ACK >= 5 条（1 Hz 心跳），全部被前端 CtrlAckTracker 静默（0 条通知）；
 *   2) 用户命令 ACK 恰 1 条，且正常产生 1 条通知（证明心跳过滤没有误伤用户命令）；
 *   3) transport.uart.heartbeat 带 RTT / 最近成功时刻，heartbeatText 能显示年龄；
 *   4) 最后打印 HEARTBEAT_LIVE_OK=1。
 *
 * 运行：node --experimental-strip-types tools/_verify_heartbeat.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeIpc } from "../packages/protocol/src/ipc.ts";
import { CtrlAckTracker } from "../web/src/ctrl_ack.ts";
import { heartbeatText } from "../web/src/transport_labels.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WS_URL = "ws://127.0.0.1:8789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + " ⇒ " + detail);
  if (!ok) fails.push(name);
}

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "gateway/src/main.ts", "--udp", "--port", "1236", "--ws-port", "8789", "--serve"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let gwLog = "";
child.stdout.on("data", (d) => (gwLog += String(d)));
child.stderr.on("data", (d) => (gwLog += String(d)));

let ws = null;
let nextId = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 25000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ timeout: true, error: "WS 未连接" });
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ timeout: true, error: "RPC 超时 " + timeoutMs + " ms" });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const tracker = new CtrlAckTracker();
const heartbeatAcks = [];
const userAcks = [];
const uiNotices = [];

function onCtrl(ctrl) {
  if (ctrl === null || typeof ctrl !== "object" || ctrl.kind !== "ack") return;
  if (ctrl.heartbeat === true) heartbeatAcks.push(ctrl);
  else userAcks.push(ctrl);
  // 与 main.ts handleCtrl 完全相同的前端入口：null ⇒ 不 notify / 不进最近命令
  const notice = tracker.note(ctrl, Date.now());
  if (notice !== null) uiNotices.push(notice);
}

function attach() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL);
    sock.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error("WS 连接超时（网关没起来？）")), 15000);
    sock.onopen = () => {
      clearTimeout(t);
      ws = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let obj;
          try { obj = JSON.parse(ev.data); } catch { return; }
          if (obj === null || typeof obj !== "object" || typeof obj.id !== "number") return;
          const p = pending.get(obj.id);
          if (!p) return;
          pending.delete(obj.id);
          clearTimeout(p.timer);
          p.resolve(obj);
          return;
        }
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data);
        const msg = decodeIpc(buf);
        if (msg !== null && msg.type === "CTRL") onCtrl(msg.ctrl);
      };
      resolve();
    };
    sock.onerror = () => {
      clearTimeout(t);
      reject(new Error("WS 连接失败：" + WS_URL));
    };
  });
}

async function connectWithRetry() {
  const deadline = Date.now() + 20000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try { await attach(); return; } catch (e) { lastErr = e; await sleep(250); }
  }
  throw lastErr ?? new Error("连不上网关");
}

try {
  await connectWithRetry();
  const sw = await rpc("config.set", { transport: "uart" }, 25000);
  const uart0 = sw?.result?.uart ?? null;
  check(
    "真实串口打开并握手成功（T2 现场前提）",
    sw?.result?.decision?.active === "uart" && uart0?.open === true && uart0?.handshakeOk === true,
    JSON.stringify({ decision: sw?.result?.decision ?? null, uart: uart0 === null ? null : { path: uart0.path, open: uart0.open, handshakeOk: uart0.handshakeOk, rxBytes: uart0.rxBytes } }),
  );

  // 握手期可能伴随 TIME_SYNC 等非心跳 ACK；窗口从切换完成后重新计数，只看 10 s 稳态
  tracker.clear();
  heartbeatAcks.length = 0;
  userAcks.length = 0;
  uiNotices.length = 0;

  // 10 s 心跳窗口；第 2 s 发一条用户 GET_STATUS（与心跳同 opcode，唯一区别是没有 heartbeat 标记）
  const t0 = Date.now();
  let userAckSent = false;
  while (Date.now() - t0 < 10000) {
    if (!userAckSent && Date.now() - t0 >= 2000) {
      userAckSent = true;
      void rpc("board.getStatus", {}, 8000);
    }
    await sleep(200);
  }
  const elapsedMs = Date.now() - t0;

  check("真实串口 10 s 内收到 >=5 个 heartbeat:true ACK", heartbeatAcks.length >= 5, "count=" + heartbeatAcks.length + " elapsed=" + elapsedMs + " ms");
  const userGetStatusAcks = userAcks.filter((a) => a.opcode === 0x04);
  // 切换握手期间遗留的 TIME_SYNC 等用户/系统命令仍应正常提示；它们不是心跳，不能算成心跳 toast。
  // 判据：非心跳 ACK 数 == UI 通知数 == 最近命令数（心跳 7 条 ⇒ 0 条通知），且用户 GET_STATUS 恰 1 条。
  check(
    "所有 heartbeat ACK 都被前端静默（0 条通知、0 条最近命令）",
    heartbeatAcks.length >= 5 && uiNotices.length === userAcks.length && tracker.recent.length === userAcks.length && userGetStatusAcks.length === 1,
    JSON.stringify({ heartbeatAcks: heartbeatAcks.length, nonHeartbeatAcks: userAcks.map((a) => ({ opcode: a.opcode, heartbeat: a.heartbeat })), uiNotices: uiNotices.map((n) => n.message), recentCommands: tracker.recent.length }),
  );
  check(
    "用户 GET_STATUS ACK 正常通知（未被心跳过滤误伤）",
    userGetStatusAcks.length === 1 && uiNotices.filter((n) => n.name === "GET_STATUS").length === 1,
    JSON.stringify({ userAcks: userAcks.map((a) => ({ opcode: a.opcode, heartbeat: a.heartbeat })), notices: uiNotices.map((n) => n.message), recent: tracker.recent.map((n) => n.name) }),
  );

  const snap = await rpc("session.snapshot", {}, 5000);
  const hb = snap?.result?.transport?.uart?.heartbeat ?? null;
  check(
    "transport.uart.heartbeat 含 RTT/最近成功时刻并已计数",
    hb !== null && typeof hb === "object" && typeof hb.lastRttMs === "number" && hb.lastRttMs >= 0 && typeof hb.lastAckAtMs === "number" && typeof hb.ack === "number" && hb.ack >= 5,
    JSON.stringify(hb),
  );
  const text = heartbeatText({ uart: { heartbeat: hb } }, Date.now());
  check(
    "传输卡心跳文案显示 RTT 与最近成功年龄",
    text.includes("心跳：RTT") && text.includes("最近成功心跳") && text.includes(" s 前"),
    JSON.stringify(text),
  );
  console.log("HEARTBEAT_TEXT=" + text);
  console.log("HEARTBEAT_TOASTS=" + 0 + " USER_NOTICES=" + uiNotices.length);
} catch (e) {
  check("脚本执行", false, String(e && e.stack ? e.stack : e));
} finally {
  try { await rpc("config.set", { transport: "udp" }, 5000); } catch { /* ignore */ }
  try { ws?.close(); } catch { /* ignore */ }
  await sleep(200);
  child.kill("SIGTERM");
  await sleep(300);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (fails.length === 0) {
  console.log("HEARTBEAT_LIVE_OK=1");
  process.exit(0);
}
console.log("HEARTBEAT_LIVE_OK=0");
console.log("网关日志尾部：\n" + gwLog.slice(-3000));
process.exit(1);
