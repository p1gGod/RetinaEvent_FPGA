// 同帧两端对比（离线、可复算）：把板端**真实发出去的**事件集合（从 /api/events.png 的
// 满强度像素解出来的，见 onboard_exact_decode.py）与上位机 RetinaEngine 在**同一帧原始像素**
// 上算出来的事件集合逐条比。
//
// 这是用户那条验收标准的机器判据："同时对比 FPGA 实时处理的画面和上位机模拟处理的画面，
// 两端要对齐"。前几轮只能比"计数均值"，而摆动装置每帧事件数在 20…3800 之间剧烈变化，
// 比均值等于比不同时刻的场景；这里改成**同一 frameIdx** 比集合。
//
// 用法：cd host/app && node --experimental-strip-types tools/onboard_exact_compare.ts [mode]
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RetinaEngine, TB_PARAMS } from "@retina/retina";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "_exact");
const MODE = process.argv[2] ?? "board";

const W = 800, H = 480;
const THETA = 1, MINDL = 20;

interface ExactSets {
  mode: string;
  frames: Record<string, { count: number; fresh: number; on: number; off: number; ev: number[][] }>;
}
interface IndexFile { mode: string; rawFrames: number[] }

const sets = JSON.parse(readFileSync(resolve(SRC, "exactsets_" + MODE + ".json"), "utf8")) as ExactSets;
const index = JSON.parse(readFileSync(resolve(SRC, "index_" + MODE + ".json"), "utf8")) as IndexFile;
const rawFrames = [...index.rawFrames].sort((a, b) => a - b);

/** 高字节先出的 RGB565 字节流 → Uint16 像素（与 udp_merge/cam_tap 的线序一致） */
function pixelsFromBeBytes(buf: Buffer): Uint16Array {
  const n = buf.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = ((buf[2 * i] as number) << 8) | (buf[2 * i + 1] as number);
  return out;
}

const key = (x: number, y: number, p: number): number => (y * 512 + x) * 2 + p;

/** 把连续 frameIdx 切成"段"：段内每个 frame 的原始帧都有，才能做相邻帧差分 */
const runs: number[][] = [];
{
  let cur: number[] = [];
  for (const f of rawFrames) {
    if (cur.length > 0 && f !== (cur[cur.length - 1] as number) + 1) {
      runs.push(cur);
      cur = [];
    }
    cur.push(f);
  }
  if (cur.length > 0) runs.push(cur);
}

interface Cmp { frame: number; board: number; hostR2: number; hostR0: number; commonR2: number; commonR0: number }
const rows: Cmp[] = [];

for (const run of runs) {
  const eng2 = new RetinaEngine({ ...TB_PARAMS, theta: THETA, minDl: MINDL, refractoryFrames: 2 });
  const eng0 = new RetinaEngine({ ...TB_PARAMS, theta: THETA, minDl: MINDL, refractoryFrames: 0 });
  let prev = -1;
  for (const f of run) {
    const p = resolve(SRC, "raw_" + f + ".raw");
    if (!existsSync(p)) continue;
    const px = pixelsFromBeBytes(readFileSync(p));
    const h2 = eng2.processPixels(px, W, H).events;
    const h0 = eng0.processPixels(px, W, H).events;
    if (f === prev + 1) {
      const b = sets.frames[String(f)];
      if (b !== undefined) {
        const bs = new Set<number>(b.ev.map((e) => key(e[0] as number, e[1] as number, e[2] as number)));
        const s2 = new Set<number>(h2.map((e) => key(e.x, e.y, e.pol)));
        const s0 = new Set<number>(h0.map((e) => key(e.x, e.y, e.pol)));
        let c2 = 0;
        for (const k of bs) if (s2.has(k)) c2++;
        let c0 = 0;
        for (const k of bs) if (s0.has(k)) c0++;
        rows.push({ frame: f, board: bs.size, hostR2: h2.length, hostR0: h0.length, commonR2: c2, commonR0: c0 });
      }
    }
    prev = f;
  }
}

const sum = (pick: (r: Cmp) => number): number => rows.reduce((a, r) => a + pick(r), 0);
const exactR2 = rows.filter((r) => r.board === r.hostR2 && r.commonR2 === r.hostR2).length;
const exactR0 = rows.filter((r) => r.board === r.hostR0 && r.commonR0 === r.hostR0).length;

console.log("同帧对比：" + rows.length + " 帧（frameIdx 各段内相邻两帧都有原始像素）");
console.log("");
console.log("frame   board   host(余晖2)  共同    host(余晖0)  共同");
for (const r of rows.slice(0, 30)) {
  console.log(
    String(r.frame).padStart(6) +
    String(r.board).padStart(8) +
    String(r.hostR2).padStart(13) +
    String(r.commonR2).padStart(7) +
    String(r.hostR0).padStart(13) +
    String(r.commonR0).padStart(7),
  );
}
if (rows.length > 30) console.log("   ...（共 " + rows.length + " 帧）");
console.log("");
console.log("合计： board=" + sum((r) => r.board) +
  "  host(余晖2)=" + sum((r) => r.hostR2) + " 共同=" + sum((r) => r.commonR2) +
  "  host(余晖0)=" + sum((r) => r.hostR0) + " 共同=" + sum((r) => r.commonR0));
console.log("逐条完全一致的帧数： 余晖2 → " + exactR2 + "/" + rows.length + " ； 余晖0 → " + exactR0 + "/" + rows.length);
console.log("");
console.log("比值 host/board ： 余晖2 → " + (sum((r) => r.hostR2) / sum((r) => r.board)).toFixed(2) +
  " ； 余晖0 → " + (sum((r) => r.hostR0) / sum((r) => r.board)).toFixed(2));
console.log("");
console.log("（板端事件集合由 /api/events.png 的满强度像素解出：满强度 == 该帧刚写入的事件；")
console.log("  上位机则是把同一 frameIdx 的原始 800x480 RGB565 喂给 RetinaEngine，两者同输入。）");
