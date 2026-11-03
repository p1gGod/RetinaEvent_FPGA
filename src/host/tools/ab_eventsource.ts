// 受控 A/B：在同一分钟内交替切换 eventSource，比较「板端事件段」与「上位机同构算法」
// 在同一工作点（θ=1 / 守卫=20 / 余晖 2 帧）下、同一场景下的事件数。
//
// 为什么要受控：先前两次采样相隔约 30 分钟，场景动态程度差很多
// （上位机那批 max 16 086，板端那批 max 3 101），直接比是苹果比橘子。
//
// 用法：cd host/app && node --experimental-strip-types tools/ab_eventsource.ts [每档采样数]
// 结束后**恢复成进入时的 eventSource**（不改用户界面状态）。
import WebSocket from "ws";

const N = Number(process.argv[2] ?? 8);
const WS = "ws://127.0.0.1:8787/ws";

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

async function eventsJson(): Promise<{ count: number; origin: string; frameIdx: number }> {
  const r = await fetch("http://127.0.0.1:8787/api/events.json");
  return (await r.json()) as { count: number; origin: string; frameIdx: number };
}

async function sample(kind: "board" | "host", n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = await eventsJson();
    if (e.origin === kind) out.push(e.count);
    await new Promise((r) => setTimeout(r, 700));
  }
  return out;
}

function stat(a: readonly number[]): string {
  if (a.length === 0) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  const avg = Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  return "n=" + a.length + " avg=" + avg + " min=" + s[0] + " max=" + s[s.length - 1];
}

const ws = await open();
const before = await rpc(ws, "config.get", {});
const orig = String((before as { eventSource?: string }).eventSource ?? "board");
console.log("进入时 eventSource = " + orig + "（结束会恢复）");

// 交替两轮，抵消场景随时间变化的影响
const board: number[] = [];
const host: number[] = [];
for (let round = 1; round <= 2; round++) {
  await rpc(ws, "config.set", { eventSource: "board" });
  await new Promise((r) => setTimeout(r, 1200));
  board.push(...(await sample("board", N)));
  await rpc(ws, "config.set", { eventSource: "host" });
  await new Promise((r) => setTimeout(r, 1200));
  host.push(...(await sample("host", N)));
  console.log("  轮 " + round + " 完成");
}

console.log("");
console.log("板端事件段   (origin=board): " + stat(board));
console.log("上位机同构   (origin=host) : " + stat(host));
const bAvg = board.reduce((a, b) => a + b, 0) / Math.max(1, board.length);
const hAvg = host.reduce((a, b) => a + b, 0) / Math.max(1, host.length);
console.log("比值 host/board = " + (hAvg / Math.max(1e-9, bAvg)).toFixed(2));

await rpc(ws, "config.set", { eventSource: orig });
const after = await rpc(ws, "config.get", {});
console.log("已恢复 eventSource = " + String((after as { eventSource?: string }).eventSource ?? "?"));
ws.close();
