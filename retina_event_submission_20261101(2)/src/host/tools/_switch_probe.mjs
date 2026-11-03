import { WebSocket } from "ws";

const URL0 = process.argv[2] || "ws://127.0.0.1:8788";
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const ws = new WebSocket(URL0);
let id = 0;
const pending = new Map();
let lastStats = null;
let helloT = 0;

ws.on("open", () => { helloT = Date.now(); log("[ws] open"); });
ws.on("message", (d) => {
  const s = d.toString();
  if (!s.startsWith("{")) return;
  let j; try { j = JSON.parse(s); } catch { return; }
  if (j.id !== undefined && pending.has(j.id)) {
    const p = pending.get(j.id); pending.delete(j.id);
    p(j.result);
    return;
  }
  if (j.method === "session.hello") { log("[ws] hello", JSON.stringify(j.params).slice(0, 200)); return; }
  if (j.method === "stats") {
    lastStats = j.params;
    return;
  }
  if (j.method === "log" || j.params?.text) { log("[gw-log]", JSON.stringify(j.params).slice(0, 220)); return; }
  if (j.method !== undefined) { log("[push]", j.method); }
});

const rpc = (method, params, timeoutMs = 15000) => new Promise((res) => {
  const mid = ++id;
  const t0 = Date.now();
  const timer = setTimeout(() => { pending.delete(mid); res({ __timeout: true, ms: Date.now() - t0 }); }, timeoutMs);
  pending.set(mid, (r) => { clearTimeout(timer); res({ __r: r, ms: Date.now() - t0 }); });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snap(tag) {
  const t = lastStats?.transport;
  log(tag, "stats.transport=", JSON.stringify(t));
  if (lastStats) log(tag, "counters=", JSON.stringify({ pps: lastStats.pps, bps: lastStats.bps, fps: lastStats.fps, evRate: lastStats.evRate, lastFrameIdx: lastStats.lastFrameIdx, counters: lastStats.counters }));
}

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(res, 3000); });
await sleep(1200);
snap("T0");

log("→ config.set transport=uart ...");
let r = await rpc("config.set", { transport: "uart" }, 20000);
log("←", "ms=" + r.ms, JSON.stringify(r.__r ?? r).slice(0, 400));
await sleep(2500); snap("T1-after-uart");

log("→ config.set transport=udp ...");
r = await rpc("config.set", { transport: "udp" }, 20000);
log("←", "ms=" + r.ms, JSON.stringify(r.__r ?? r).slice(0, 400));
await sleep(2500); snap("T2-after-udp");

log("→ board.getStatus via gateway ...");
r = await rpc("board.getStatus", {}, 8000);
log("←", "ms=" + r.ms, JSON.stringify(r.__r ?? r).slice(0, 500));
ws.close();
setTimeout(() => process.exit(0), 200);
