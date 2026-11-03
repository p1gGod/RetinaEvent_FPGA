#!/usr/bin/env node
/**
 * _verify_transport.mjs — B 线机读判据（串口通道健壮性）
 *
 * 起一个独立网关（不碰用户 1234/8787）：
 *   node --experimental-strip-types gateway/src/main.ts --udp --port 1236 --ws-port 8789 --serve
 * 然后脚本化走 udp → uart → udp，只看 RPC/statusView，不需要板子配合：
 *   1) 切 uart 的 RPC 必须在 20 s 内返回，且不抛（COM6 真实打开 + 3×300 ms v3 握手）；
 *   2) 在线/离线分支（十修）：
 *      · 真实 UART 在线（handshakeOk=true 且 rxBps>0）⇒ 打印 LIVE_UART_BRANCH=1，
 *        按在线判据检查，不再误报"无 ACK / rxBytes=0"；
 *      · 离线（当前位流 UART_LINK_EN=0 的现场）⇒ 保留原来的"无 ACK + rxBytes=0"判据；
 *   3) 切回 udp 后 2 s 内 decision.active=udp 且 state=active（不靠重启网关）。
 * 通过时最后一行打印 TRANSPORT_OK=1；任何一条失败打印 FAIL 明细并以 1 退出。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WS_URL = "ws://127.0.0.1:8789";
// 默认现场 COM6；离线路径可用 VERIFY_UART_PATH=COM1 指定一个能打开但无板端应答的串口。
const UART_PATH = process.env.VERIFY_UART_PATH ?? "COM6";
const SWITCH_BUDGET_MS = 20000;
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

function attach() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL);
    const t = setTimeout(() => reject(new Error("WS 连接超时（网关没起来？）")), 15000);
    sock.onopen = () => {
      clearTimeout(t);
      ws = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let obj;
        try {
          obj = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (obj === null || typeof obj !== "object" || typeof obj.id !== "number") return;
        const p = pending.get(obj.id);
        if (!p) return;
        pending.delete(obj.id);
        clearTimeout(p.timer);
        p.resolve(obj);
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
    try {
      await attach();
      return;
    } catch (e) {
      lastErr = e;
      await sleep(250);
    }
  }
  throw lastErr ?? new Error("连不上网关");
}

function decisionOf(res) {
  const r = res?.result;
  if (r === null || typeof r !== "object") return null;
  const d = r.decision;
  if (d === null || typeof d !== "object") return null;
  return {
    active: d.active,
    state: d.state,
    mode: d.mode,
    reason: typeof d.reason === "string" ? d.reason : "",
  };
}

async function snapshotTransport() {
  const r = await rpc("session.snapshot", {}, 5000);
  const t = r?.result?.transport;
  if (t === null || typeof t !== "object") return null;
  const d = t.decision ?? {};
  return {
    decision: {
      active: d.active,
      state: d.state,
      mode: d.mode,
      reason: typeof d.reason === "string" ? d.reason : "",
    },
    health: t.health ?? null,
    uart: t.uart ?? null,
  };
}

try {
  await connectWithRetry();
  const snap0 = await snapshotTransport();
  check(
    "基线：网关起来就用网口监听 1236",
    snap0 !== null && snap0.decision.active === "udp" && snap0.decision.state === "active",
    JSON.stringify(snap0?.decision ?? null),
  );

  // ---- 1/2 切串口：不抛、20 s 内；再按真实 UART 是否在线选择判据（十修 T3） ----
  const t0 = Date.now();
  let sw;
  try {
    sw = await rpc("config.set", { transport: "uart", serialPort: UART_PATH }, SWITCH_BUDGET_MS + 5000);
  } catch (e) {
    sw = { threw: String(e) };
  }
  const dtUart = Date.now() - t0;
  check("切 uart 的 RPC 不抛异常", sw.threw === undefined, sw.threw ?? "正常返回");
  check("切 uart 的 RPC 在 20 s 内返回", sw.threw === undefined && dtUart < SWITCH_BUDGET_MS, dtUart + " ms");
  let dUart = decisionOf(sw) ?? (await snapshotTransport())?.decision ?? null;
  let uartView = sw?.result?.uart ?? (await snapshotTransport())?.uart ?? null;
  console.log("UART_PATH=" + UART_PATH);
  const liveUart = () => uartView !== null && typeof uartView === "object" &&
    uartView.open === true && uartView.handshakeOk === true &&
    (Number(uartView.rxBps) > 0 || Number(uartView.rxBytes) > 0);
  // 刚打开 COM 时首帧/首个心跳 ACK 可能还没到：最多等 2.5 s 再判在线（不改变离线路径的结论）
  let liveWaited = 0;
  while (!liveUart() && liveWaited < 2500) {
    await sleep(100);
    liveWaited += 100;
    const s = await snapshotTransport();
    if (s !== null) {
      uartView = s.uart;
      dUart = s.decision;
    }
  }
  const uartOnline = liveUart();
  console.log("LIVE_UART_BRANCH=" + (uartOnline ? 1 : 0));
  if (uartOnline) {
    // 真实 UART 在线：handshakeOk/rxBps 才是有效判据；"无 ACK / rxBytes=0"是离线现场，不能套用
    check(
      "在线分支：handshakeOk=true 且 rxBps>0",
      uartView?.open === true && uartView?.handshakeOk === true && Number(uartView?.rxBps) > 0,
      JSON.stringify({ path: uartView?.path, open: uartView?.open, handshakeOk: uartView?.handshakeOk, rxBytes: uartView?.rxBytes, rxBps: uartView?.rxBps, liveWaited }),
    );
    check(
      "在线分支：uart.statusView 暴露 rx 指标（数字）",
      typeof uartView?.rxBytes === "number" && typeof uartView?.rxBps === "number",
      JSON.stringify({ rxBytes: uartView?.rxBytes, rxBps: uartView?.rxBps }),
    );
    check(
      "在线分支：decision.reason 不再误报\"无 ACK\"",
      !(dUart?.reason ?? "").includes("无 ACK"),
      JSON.stringify(dUart?.reason ?? null),
    );
  } else {
    check("离线分支：decision.reason 含\"无 ACK\"", (dUart?.reason ?? "").includes("无 ACK"), JSON.stringify(dUart?.reason ?? null));
    check(
      "离线分支：uart.statusView 暴露 rx 指标且 rxBytes=0",
      uartView !== null && uartView.rxBytes === 0 && typeof uartView.rxBps === "number" && uartView.rxBps === 0,
      JSON.stringify({ path: uartView?.path, open: uartView?.open, rxBytes: uartView?.rxBytes, rxBps: uartView?.rxBps }),
    );
  }

  // ---- 3 切回 udp：2 s 内 active=udp/state=active ----
  const tBack = Date.now();
  const back = await rpc("config.set", { transport: "udp" }, SWITCH_BUDGET_MS + 5000);
  let restore = decisionOf(back);
  let waited = 0;
  while (Date.now() - tBack < 2000 && !(restore?.active === "udp" && restore?.state === "active")) {
    await sleep(100);
    waited = Date.now() - tBack;
    restore = (await snapshotTransport())?.decision ?? restore;
  }
  const dtBack = Date.now() - tBack;
  check(
    "切回 udp 后 2 s 内 active=udp 且 state=active",
    restore?.active === "udp" && restore?.state === "active" && dtBack < 2000,
    JSON.stringify({ ...restore, dtMs: dtBack, polledMs: waited }),
  );

  const snapEnd = await snapshotTransport();
  check(
    "恢复后 session.snapshot 与 STATUS 一致（active=udp/state=active/无 UART 主通道）",
    snapEnd !== null && snapEnd.decision.active === "udp" && snapEnd.decision.state === "active",
    JSON.stringify(snapEnd?.decision ?? null),
  );
} catch (e) {
  check("脚本执行", false, String(e && e.stack ? e.stack : e));
} finally {
  try {
    await rpc("config.set", { transport: "udp" }, 5000);
  } catch {
    /* ignore */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  await sleep(200);
  child.kill("SIGTERM");
  await sleep(300);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (fails.length === 0) {
  console.log("TRANSPORT_OK=1");
  process.exit(0);
}
console.log("TRANSPORT_OK=0");
console.log("网关日志尾部：\n" + gwLog.slice(-3000));
process.exit(1);
