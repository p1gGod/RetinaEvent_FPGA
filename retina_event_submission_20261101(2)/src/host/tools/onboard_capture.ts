// 上板验证：把「板端事件场」与「上位机同构事件场」各抓一遍，落成 PNG + 计数。
//
// 为什么用 /api/events.png：它是**逐像素**的事件场（ON 红 / OFF 蓝），
// 而 /api/events.json 只有计数。要判"板端事件场形状对不对、坐标有没有越界"
// 必须拿到坐标，PNG 就是最直接的载体（无需碰 UDP 1234，也无需重启网关）。
//
// 安全约束：**只通过 WS 的 config.set 切 eventSource，结束恢复成进入时的值**；
//          不重绑 UDP、不重启网关、不动 flow.*。
//
// 用法：cd host/app && node --experimental-strip-types tools/onboard_capture.ts [每档张数]
// 产物：tools/_onboard/{board,host}_<i>.png  + summary.json
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const N = Number(process.argv[2] ?? 6);
// 轮数：场景（摆动装置）本身每秒都在变，**必须多轮交替**才能把"场景随时间变化"
// 与"两种来源的真实差异"分开。2 轮 × 6 张时两边的帧号区间完全不重叠，
// 单看均值会掺进大量场景方差（实测比值 1.33，而两边值域其实高度重叠）。
const ROUNDS = Number(process.argv[3] ?? 2);
const WS = "ws://127.0.0.1:8787/ws";
const API = "http://127.0.0.1:8787";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "_onboard");
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

interface EvMeta { count: number; origin: string; frameIdx: number; ageMs: number }

async function evMeta(): Promise<EvMeta> {
  const r = await fetch(API + "/api/events.json");
  return (await r.json()) as EvMeta;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function capture(mode: "board" | "host"): Promise<{ counts: number[]; frames: number[] }> {
  const counts: number[] = [];
  const frames: number[] = [];
  for (let i = 0; i < N; i++) {
    const m = await evMeta();
    if (m.origin !== mode) {
      console.log("    (跳过一帧：origin=" + m.origin + " 期望 " + mode + ")");
      await sleep(400);
      i--;
      continue;
    }
    const r = await fetch(API + "/api/events.png?w=400");
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(resolve(OUT, mode + "_" + i + ".png"), buf);
    counts.push(m.count);
    frames.push(m.frameIdx);
    console.log("   " + mode + "[" + i + "] frameIdx=" + m.frameIdx + " count=" + m.count +
      " png=" + buf.length + "B ageMs=" + m.ageMs);
    await sleep(320);
  }
  return { counts, frames };
}

const ws = await open();
const before = await rpc(ws, "config.get", {});
const orig = String((before as { eventSource?: string }).eventSource ?? "board");
console.log("进入时 eventSource = " + orig + "（结束恢复）");

const result: Record<string, unknown> = { orig };

// 交替两轮：抵消场景随时间变化
const boardCounts: number[] = [];
const hostCounts: number[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  console.log("── 轮 " + round + "：板端 ──");
  await rpc(ws, "config.set", { eventSource: "board" });
  await sleep(1500);
  const b = await capture("board");
  boardCounts.push(...b.counts);
  console.log("── 轮 " + round + "：上位机 ──");
  await rpc(ws, "config.set", { eventSource: "host" });
  await sleep(1500);
  const h = await capture("host");
  hostCounts.push(...h.counts);
}
result.board = boardCounts;
result.host = hostCounts;

await rpc(ws, "config.set", { eventSource: orig });
const after = await rpc(ws, "config.get", {});
result.restored = String((after as { eventSource?: string }).eventSource ?? "?");
console.log("已恢复 eventSource = " + result.restored);

const avg = (a: readonly number[]): number =>
  a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: readonly number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const stat = (a: readonly number[]): string => {
  if (a.length === 0) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  return "n=" + a.length + " avg=" + Math.round(avg(a)) + " median=" + Math.round(median(a)) +
    " min=" + s[0] + " max=" + s[s.length - 1];
};
console.log("");
console.log("板端 (origin=board): " + stat(boardCounts));
console.log("上位机 (origin=host): " + stat(hostCounts));
console.log("比值 host/board : avg " + (avg(hostCounts) / Math.max(1e-9, avg(boardCounts))).toFixed(2) +
  "  /  median " + (median(hostCounts) / Math.max(1e-9, median(boardCounts))).toFixed(2));
// 事件数是重尾的（摆动装置每帧 20…3300），所以"均值相等"远不如"中位数 + 值域重叠"能说明问题
console.log("值域：board [" + Math.min(...boardCounts) + ", " + Math.max(...boardCounts) +
  "]  host [" + Math.min(...hostCounts) + ", " + Math.max(...hostCounts) + "]");

writeFileSync(resolve(OUT, "summary.json"), JSON.stringify(result, null, 2) + "\n");
console.log("产物目录：" + OUT);
ws.close();
