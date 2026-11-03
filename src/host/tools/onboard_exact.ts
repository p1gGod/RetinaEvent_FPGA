// 上板"同帧两端"取证（v2）：**不要求三样东西原子**，改为一律按 frameIdx 建索引，事后 join。
//
// 为什么 v2 比 v1 好：
//   v1 要求 (frame.json, frame.raw, events.json, events.png) 全部同一个 frameIdx，
//   而 raw 有 768 000 B（一次读就跨过 38 ms 的帧驻留）⇒ 大量尝试被丢弃，
//   且为了凑"同帧"把连续帧拆散（v1 实测 24 个样本里有 7 个重复、还缺帧）。
//   v2 认识到：`/api/events.json`（单个小 JSON）与 `/api/frame.raw`（大）**各自**只要求
//   "自己那对首尾 frameIdx 一致"就够了 —— 两个槽在 pushFrame 里是**紧挨着同步更新**的，
//   所以两者都带上正确的 frameIdx 之后，按 frameIdx 一 join 就是同一帧。
//
// 产物：tools/_exact/ev_<frameIdx>.png + .json、raw_<frameIdx>.raw、index.json
// 用法：cd host/app && node --experimental-strip-types tools/onboard_exact.ts [目标事件帧数] [目标原始帧数] [mode]
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const WANT_EV = Number(process.argv[2] ?? 70);
const WANT_RAW = Number(process.argv[3] ?? 45);
const MODE = (process.argv[4] ?? "board") as "board" | "host";
const BUDGET_MS = Number(process.argv[5] ?? 120000);

const WS = "ws://127.0.0.1:8787/ws";
const API = "http://127.0.0.1:8787";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "_exact");
mkdirSync(OUT, { recursive: true });

interface Msg { id?: number; result?: Record<string, unknown>; error?: unknown }
function open(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const s = new WebSocket(WS);
    s.once("open", () => res(s));
    s.once("error", rej);
  });
}
let seq = 1;
function rpc(s: WebSocket, method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = seq++;
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("rpc timeout: " + method)), 8000);
    const onMsg = (raw: WebSocket.RawData): void => {
      let m: Msg;
      try { m = JSON.parse(String(raw)) as Msg; } catch { return; }
      if (m.id !== id) return;
      clearTimeout(to);
      s.off("message", onMsg);
      if (m.error !== undefined) rej(new Error(method + " -> " + JSON.stringify(m.error)));
      else res(m.result ?? {});
    };
    s.on("message", onMsg);
    s.send(JSON.stringify({ id, method, params }));
  });
}
interface FrameMeta { seq: number; frameIdx: number; w: number; h: number }
interface EvMeta { count: number; origin: string; frameIdx: number }
const getJson = async <T>(p: string): Promise<T> => (await (await fetch(API + p)).json()) as T;

const evGot = new Map<number, { count: number; pngBytes: number }>();
const rawGot = new Map<number, number>();

const ws = await open();
const before = await rpc(ws, "config.get", {});
const orig = String((before as { eventSource?: string }).eventSource ?? "board");
console.log("进入时 eventSource = " + orig + " -> 采样用 " + MODE);
await rpc(ws, "config.set", { eventSource: MODE });
await new Promise((r) => setTimeout(r, 1500));

const t0 = Date.now();
let triesEv = 0, triesRaw = 0, okEv = 0, okRaw = 0;

while (Date.now() - t0 < BUDGET_MS && (evGot.size < WANT_EV || rawGot.size < WANT_RAW)) {
  // ---- (a) 事件槽：两个小 JSON + 一张 ~8 KB PNG，容易落在一帧内 ----
  if (evGot.size < WANT_EV) {
    triesEv++;
    try {
      const e1 = await getJson<EvMeta>("/api/events.json");
      if (e1.origin === MODE && !evGot.has(e1.frameIdx)) {
        const png = Buffer.from(await (await fetch(API + "/api/events.png?w=400")).arrayBuffer());
        const e2 = await getJson<EvMeta>("/api/events.json");
        if (e2.frameIdx === e1.frameIdx && e1.frameIdx >= 0) {
          writeFileSync(resolve(OUT, "ev_" + e1.frameIdx + ".png"), png);
          evGot.set(e1.frameIdx, { count: e1.count, pngBytes: png.length });
          okEv++;
        }
      }
    } catch { /* 重试 */ }
  }
  // ---- (b) 原始帧槽：只要求自己那对首尾 frameIdx 一致 ----
  if (rawGot.size < WANT_RAW) {
    triesRaw++;
    try {
      const f1 = await getJson<FrameMeta>("/api/frame.json");
      if (!rawGot.has(f1.frameIdx)) {
        const raw = Buffer.from(await (await fetch(API + "/api/frame.raw")).arrayBuffer());
        const f2 = await getJson<FrameMeta>("/api/frame.json");
        if (f2.frameIdx === f1.frameIdx && raw.length === f1.w * f1.h * 2) {
          writeFileSync(resolve(OUT, "raw_" + f1.frameIdx + ".raw"), raw);
          rawGot.set(f1.frameIdx, raw.length);
          okRaw++;
        }
      }
    } catch { /* 重试 */ }
  }
}

const evFrames = [...evGot.keys()].sort((a, b) => a - b);
const rawFrames = [...rawGot.keys()].sort((a, b) => a - b);
const both = evFrames.filter((f) => rawGot.has(f));
writeFileSync(resolve(OUT, "index_" + MODE + ".json"), JSON.stringify({
  mode: MODE,
  seconds: Math.round((Date.now() - t0) / 1000),
  triesEv, okEv, triesRaw, okRaw,
  evFrames, rawFrames, joined: both,
  counts: Object.fromEntries([...evGot.entries()].map(([k, v]) => [String(k), v.count])),
}, null, 2) + "\n");

await rpc(ws, "config.set", { eventSource: orig });
const after = await rpc(ws, "config.get", {});
console.log("事件帧 " + evGot.size + "（尝试 " + triesEv + "，成功 " + okEv + "）；" +
  "原始帧 " + rawGot.size + "（尝试 " + triesRaw + "，成功 " + okRaw + "）");
console.log("frameIdx 范围：事件 " + evFrames[0] + ".." + evFrames[evFrames.length - 1] +
  "，原始 " + rawFrames[0] + ".." + rawFrames[rawFrames.length - 1] +
  "，**两者都有**的 = " + both.length + " 帧");
console.log("已恢复 eventSource = " + String((after as { eventSource?: string }).eventSource ?? "?"));
console.log("产物：" + OUT);
ws.close();
