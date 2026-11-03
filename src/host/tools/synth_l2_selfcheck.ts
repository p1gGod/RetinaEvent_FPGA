// 合成源 L2 像素自证：把页内合成源（web/src/synth.ts）的消息，按 main.ts 的
// 「事件随帧取用」口径（evQueue → 命中本帧才置位）喂给**真实的 EventBitmap**，
// 再把 L2 位图的像素级结果打出来（点亮格子 / 非黑像素 / 红系 / 蓝系 / distinct 颜色）。
//
// 为什么要有这个工具：main.ts 顶层 `import "./style.css"` 并直接读写 DOM/Canvas，
// node --experimental-strip-types 里 import 不了它；而「合成源的事件到底有没有落到 L2 上」
// 必须能被机器判死 —— 2026-10-13 用户报的「连合成源的事件画面都不对」就是这条通路断了：
// 合成源把事件标在**上一帧**的 frameIdx 上、而事件又在该帧之后才发出 ⇒ 入队即过期 ⇒ 一条都不置位
// （界面上：事件率 23.8 kev/s 而 L2「点亮 0 / 96000」、画布全黑）。
//
// 用法：cd host/app && node --experimental-strip-types tools/synth_l2_selfcheck.ts [秒数]
// 判据：末行 SYNTH_L2_SELFCHECK_OK=1（点亮 > 0）；=0 表示事件一条都没落到 L2，视为 bug。
import { decodeEvents, getProfile } from "@retina/protocol";
import type { EventRecord, IpcEvents, IpcMessage, Profile } from "@retina/protocol";
import { EventBitmap } from "../web/src/events.ts";
import { SynthSource, ballCenter } from "../web/src/synth.ts";

const SECONDS = Number(process.argv[2] ?? 6);
const profileName = process.argv[3] ?? "retina-v2-800x480-1280";

const resolved = getProfile(profileName);
if (resolved === null) throw new Error("未知 profile: " + profileName);
// 收成非空常量：类体里 TS 不会再认上面那次收窄（noUncheckedIndexedAccess 同款严格）
const profile: Profile = resolved;

/**
 * 与 main.ts 的 evQueue / evQueuePush / handleFrame（A1~A4，2026-10-09）同构。
 * frame-events.test.ts 里也有一份同样的模型（那份用真实 EventBitmap 验语义）；
 * 这里要多记两个数：命中并置位的条数、过期被清的条数。
 */
class FrameEventQueue {
  private readonly q = new Map<number, EventRecord[]>();
  static readonly MAX_KEYS = 8;
  applied = 0;
  expired = 0;
  evicted = 0;

  push(frameIdx: number, records: readonly EventRecord[]): void {
    if (records.length === 0) return;
    const hit = this.q.get(frameIdx);
    if (hit === undefined) this.q.set(frameIdx, records.slice());
    else for (const r of records) hit.push(r);
    while (this.q.size > FrameEventQueue.MAX_KEYS) {
      const oldest = this.q.keys().next();
      if (oldest.done === true) break;
      this.evicted += this.q.get(oldest.value)?.length ?? 0;
      this.q.delete(oldest.value);
    }
  }

  /** 与 handleFrame 的 A3 段同构：命中即删除并返回；随后无条件清掉比本帧更旧的键 */
  takeFor(frameIdx: number): EventRecord[] | undefined {
    const hit = this.q.get(frameIdx);
    if (hit !== undefined) this.q.delete(frameIdx);
    for (const k of [...this.q.keys()]) {
      if (k < frameIdx) {
        this.expired += this.q.get(k)?.length ?? 0;
        this.q.delete(k);
      }
    }
    return hit;
  }
}

/** 与 main.ts 的 handleFrame / handleEvents 同构（只取与事件位图有关的那几行） */
class L2Model {
  readonly bitmap = new EventBitmap(profile.evGrid.w, profile.evGrid.h, 0.55);
  readonly q = new FrameEventQueue();
  frames = 0;
  evMsgs = 0;
  evRecords = 0;
  lastFrameIdx = 0;

  onMessage(m: IpcMessage): void {
    if (m.type === "FRAME_RAW") this.onFrame(m.frameIdx);
    else if (m.type === "EVENTS") this.onEvents(m);
  }

  private onFrame(frameIdx: number): void {
    this.frames++;
    this.lastFrameIdx = frameIdx;
    this.bitmap.step(); // 衰减挂在每帧上（与 main.ts 一致）
    const hit = this.q.takeFor(frameIdx);
    if (hit !== undefined && hit.length > 0) {
      this.bitmap.apply(hit);
      this.q.applied += hit.length;
    }
  }

  private onEvents(m: IpcEvents): void {
    const dec = decodeEvents(m.data, m.recBytes);
    this.evMsgs++;
    this.evRecords += dec.records.length;
    this.q.push(m.frameIdx, dec.records);
  }
}

const src = new SynthSource(profile);
src.start(0);
const model = new L2Model();
for (let t = 0; t <= SECONDS * 1000; t += 6) {
  for (const m of src.poll(t)) model.onMessage(m);
}

const bw = profile.evGrid.w;
const bh = profile.evGrid.h;
const rgba = model.bitmap.rgba;
let nonBlack = 0;
let reddish = 0;
let bluish = 0;
const colors = new Set<number>();
for (let i = 0; i < bw * bh; i++) {
  const r = rgba[i * 4] ?? 0;
  const g = rgba[i * 4 + 1] ?? 0;
  const b = rgba[i * 4 + 2] ?? 0;
  if (r + g + b === 0) continue;
  nonBlack++;
  colors.add((r << 16) | (g << 8) | b);
  if (r > g && r > b) reddish++;
  else if (b > g && b > r) bluish++;
}
const lit = model.bitmap.activeCells;
const pct = ((lit / (bw * bh)) * 100).toFixed(1);

/**
 * 位置一致性（「事件点位置错」的机器判据）：**满强度**事件格（= 本帧刚置位的那些，
 * intensity 1.0 时 rgba 恰好是 EV_COLOR 原色）必须落在**本帧事件区间**（上一帧之后到本帧）
 * 运动目标（亮球 + 左臂）扫过的格范围内。若满强度事件跑到别的帧的位置上（错帧），这里会报越界格数。
 *
 * 注意区间会跨「扫掠接缝」：一帧 = 8 tick、一个扫掠 = 12 tick，所以每 3 帧就有一次接缝；
 * 接缝那个 tick 合成源明确不发事件（剪辑点），掩板里也把它排除 —— 否则掩板会被一格跳变撑满整场。
 */
const ON: readonly [number, number, number] = [255, 77, 99];
const OFF: readonly [number, number, number] = [77, 155, 255];
const gx: number[] = [];
const gy: number[] = [];
for (let i = 0; i < bw * bh; i++) {
  const r = rgba[i * 4] ?? 0;
  const g = rgba[i * 4 + 1] ?? 0;
  const b = rgba[i * 4 + 2] ?? 0;
  const isOn = r === ON[0] && g === ON[1] && b === ON[2];
  const isOff = r === OFF[0] && g === OFF[1] && b === OFF[2];
  if (!isOn && !isOff) continue;
  gx.push(i % bw);
  gy.push((i - (i % bw)) / bw);
}
const mask = new Uint8Array(bw * bh);
let maskTicks = 0;
const intervalEnd = model.lastFrameIdx * 8; // 本帧所在 tick（一帧 = FRAME_EVERY 个 tick）
// 掩板 = 区间内每个 tick 上运动目标的包围盒并集。两端都要算：
//   · 起点 tick（intervalEnd-8）：tick k 的事件 = u(k-1)→u(k) 的变化，少算起点会把"目标刚离开的位置"误判成越界（实测 320 格）；
//   · 扫掠接缝那个 tick（k%12==0）**要算**：它自己不发事件，但它是下一个 tick 差分的端点（实测漏掉它差 96 格）。
for (let k = intervalEnd - 8; k <= intervalEnd; k++) {
  maskTicks++;
  const u = (k % 12) / 12;
  const { cx, cy } = ballCenter(u);
  // 运动目标在 400×240 栅格上的包围盒（2×2 降采样 ⇒ /2，外扩 1 格）：
  // 亮球 d≤34（x、y 两个方向都 ±34），左臂 x∈(cx-150,cx-30)、y∈(cy+11,cy+41)
  // ⇒ 合成包围盒 = x[cx-150, cx+34] × y[cy-34, cy+41]（漏掉手臂的下沿会把"刚离开的位置"误判成越界）
  const x0 = Math.max(0, Math.floor((cx - 150) / 2) - 1);
  const x1 = Math.min(bw - 1, Math.ceil((cx + 34) / 2) + 1);
  const y0 = Math.max(0, Math.floor((cy - 34) / 2) - 1);
  const y1 = Math.min(bh - 1, Math.ceil((cy + 41) / 2) + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * bw + x] = 1;
}
let out = 0;
for (let i = 0; i < gx.length; i++) {
  const x = gx[i] ?? 0;
  const y = gy[i] ?? 0;
  if (mask[y * bw + x] === 0) out++;
}

const u = ((model.lastFrameIdx * 8) % 12) / 12;

console.log("[自证] 合成源 → 前端「事件随帧取用」模型（与 main.ts handleFrame/handleEvents 同构）");
console.log("  profile        : " + profile.name + "（事件栅格 " + bw + "×" + bh + "）");
console.log("  时间           : " + SECONDS + " s（6 ms 步进，与前端 pump 周期一致）");
console.log("  消息           : FRAME_RAW " + model.frames + " 条 / EVENTS " + model.evMsgs + " 条 / 事件记录 " + model.evRecords + " 条");
console.log("  入队后置位     : " + model.q.applied + " 条（命中本帧才置位）");
console.log("  过期被清       : " + model.q.expired + " 条（比本帧更旧、等不到自己的帧）");
console.log("  超上限淘汰     : " + model.q.evicted + " 条（键数 > " + FrameEventQueue.MAX_KEYS + "）");
console.log("  L2 位图        : 点亮 " + lit + " / " + bw * bh + "（" + pct + "%）");
console.log("  像素自证       : 非黑 " + nonBlack + " px，distinct 颜色 " + colors.size + "，红系 " + reddish + " px，蓝系 " + bluish + " px");
console.log(
  "  位置自证       : 末帧 idx=" + model.lastFrameIdx + "（u=" + u.toFixed(2) + "）满强度事件格 " + gx.length +
    " 个，本帧区间掩板 " + maskTicks + " tick，越界 " + out + " 个",
);
console.log("  SYNTH_L2_SELFCHECK_OK=" + (lit > 0 && out === 0 ? "1" : "0") + "（0 = 事件没落到 L2 或落错帧，视为 bug）");
process.exitCode = lit > 0 && out === 0 ? 0 : 1;
