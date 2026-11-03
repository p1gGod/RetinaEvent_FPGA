// 直接验证「时间基不同」这个机制：
//   板端事件引擎跑在**每一个相机帧**上（26.4 fps）；而网关收到的原始流是 `FRAME_DECIM=8`
//   抽帧后的（3.3 fps）。⇒ 上位机同构引擎的 ΔL 是"相隔 8 个相机帧"的差分，比板端大 ~8 倍。
//   ⇒ 同一个 guard 值对**板端**严、对**上位机**松：上位机的 20 等效于板端的 20/8 ≈ 2.5。
//   ⇒ 要让上位机的事件数**降到板端的水平**，得把它的 guard **抬高 ~8 倍**（20 → 160）。
//
// ⚠️ 第一版把方向写反了（去试 3 / 2），结果事件数反而涨到 18 558 / 28 880 ——
//    那正好又一次证实"guard 越小事件越多"。方向搞反的代价就是白跑一轮，所以记在这里。
//
// 验证方法：把网关的 hostMinDl 依次设成 {20, 80, 160}，看哪个值能把上位机拉到板端水平。
//
// 结束后恢复进入时的 hostMinDl / hostTheta。
// 用法：cd host/app && node --experimental-strip-types tools/ab_guard_scale.ts
import WebSocket from "ws";

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
    const to = setTimeout(() => rej(new Error("rpc timeout " + method)), 8000);
    const on = (raw: WebSocket.RawData): void => {
      let m: Msg;
      try { m = JSON.parse(String(raw)) as Msg; } catch { return; }
      if (m.id !== id) return;
      clearTimeout(to); s.off("message", on);
      if (m.error !== undefined) rej(new Error(JSON.stringify(m.error)));
      else res(m.result ?? {});
    };
    s.on("message", on);
    s.send(JSON.stringify({ id, method, params }));
  });
}
async function evCount(): Promise<number> {
  const r = await fetch("http://127.0.0.1:8787/api/events.json");
  const j = (await r.json()) as { count: number };
  return j.count;
}
async function sample(kind: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8787/api/events.json");
      const j = (await r.json()) as { origin: string; count: number };
      if (j.origin === kind) out.push(j.count);
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return out;
}
const avg = (a: readonly number[]): number => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

const ws = await open();
const cfg = await rpc(ws, "config.get", {});
const c = cfg as { hostTheta?: number; hostMinDl?: number; eventSource?: string };
const origTheta = Number(c.hostTheta ?? 1);
const origMinDl = Number(c.hostMinDl ?? 20);
const origSrc = String(c.eventSource ?? "host");
console.log("进入时 hostTheta=" + origTheta + " hostMinDl=" + origMinDl + " eventSource=" + origSrc);

// 板端基准（同工作点 θ=1/守卫=20）
await rpc(ws, "config.set", { eventSource: "board" });
await new Promise((r) => setTimeout(r, 1200));
const board = await sample("board", 10);
console.log("板端事件段 (θ=1/守卫=20，26.4 fps 时间基): avg=" + avg(board));

await rpc(ws, "config.set", { eventSource: "host" });
for (const md of [20, 80, 160]) {
  await rpc(ws, "config.set", { hostTheta: 1, hostMinDl: md });
  await new Promise((r) => setTimeout(r, 1200));
  const h = await sample("host", 10);
  console.log("上位机同构 (θ=1/守卫=" + String(md).padStart(3) + "，3.3 fps 时间基): avg=" + avg(h) +
    "   (等效 1 帧守卫 ≈ " + (md / 8).toFixed(1) + ")");
}

await rpc(ws, "config.set", { hostTheta: origTheta, hostMinDl: origMinDl, eventSource: origSrc });
const back = await rpc(ws, "config.get", {});
const b = back as { hostTheta?: number; hostMinDl?: number; eventSource?: string };
console.log("已恢复 hostTheta=" + b.hostTheta + " hostMinDl=" + b.hostMinDl + " eventSource=" + b.eventSource);
ws.close();
