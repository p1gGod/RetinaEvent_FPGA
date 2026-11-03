// 页内合成源：不接网关也能出图（demo/截图/离线演示的兜底）。
// 算式与 host/design/assets/make_demo_frames.py 同构，也就是与 RTL 同构：
//   Y = (77R + 150G + 29B) >> 8 → L = round(255·log2(1 + Y/255)) → |ΔL| > θ(74 LSB) 才发事件
//   pol = ΔL > 0 ? ON : OFF；事件网格 400×240（2×2 降采样）；余晖 0.55（由事件图层负责衰减）
// 为什么放在页内而不是网关：验收要求在"没板子、没网关"时四窗格也要有内容，
// 而且合成数据能随时说明"每个数字都有来源"——面板上的量都从这条真实的数据通路里统计出来。
import { IPC, PIXEL, createCounters } from "@retina/protocol";
import type {
  Counters, EventRecord, IpcEvents, IpcFrameRaw, IpcMessage, IpcStats, Profile, SourceStats,
} from "@retina/protocol";

export const SYNTH_W = 800;
export const SYNTH_H = 480;
export const SYNTH_GW = 400;
export const SYNTH_GH = 240;
/** θ=0.20 档位换算成 luma LSB（见技术原理 §阈值换算 / 离线脚本 THETA_LSB） */
export const THETA_LSB = 74;
/** 位图余晖系数（事件图层按 tick 衰减） */
export const DECAY = 0.55;
/** 一个完整扫掠用多少个事件 tick；调它等于调"运动速度"与拖尾长度 */
export const SWEEP_TICKS = 12;
/** 每多少个事件 tick 出一张原始帧：12/8 ≈ 26.4 fps 事件 vs 3.3 fps 回传帧，与 02 文档口径一致 */
export const FRAME_EVERY = 8;
/** 事件 tick 周期 = 1000/26.4 */
export const TICK_MS = 1000 / 26.4;

/** 亮度对数映射查表（Y 是 0..255 整数，查表比每像素调 log2 快一个数量级） */
const LOG2_LUT: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let y = 0; y < 256; y++) t[y] = Math.round(255 * Math.log2(1 + y / 255));
  return t;
})();

const GX = new Float32Array(SYNTH_GW);
const GY = new Float32Array(SYNTH_GH);
for (let i = 0; i < SYNTH_GW; i++) GX[i] = 2 * i + 0.5;
for (let i = 0; i < SYNTH_GH; i++) GY[i] = 2 * i + 0.5;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** 静态部分（背景渐变 / 显示器 / 货架 / 高频纹理 / 地面线），顺序与 scene() 完全一致 */
function staticPixel(x: number, y: number, out: Float32Array, o: number): void {
  const ys = y / (SYNTH_H - 1);
  let r = 22 + 30 * ys;
  let g = 28 + 36 * ys;
  let b = 40 + 52 * ys;
  if (y >= 86 && y < 236 && x >= 64 && x < 296) { r = 92; g = 98; b = 110; }
  if (y >= 96 && y < 226 && x >= 74 && x < 286) { r = 46; g = 60; b = 82; }
  if (y >= 112 && y < 150 && x >= 92 && x < 250) { r = 70; g = 120; b = 150; }
  if (y >= 168 && y < 186 && x >= 92 && x < 210) { r = 120; g = 126; b = 136; }
  if (y >= 100 && y < 128 && x >= 616 && x < 776) { r = 104; g = 106; b = 114; }
  if (y >= 128 && y < 136 && x >= 616 && x < 776) { r = 70; g = 72; b = 78; }
  // 静止高频纹理：存在的意义就是证明"有纹理但静止 ⇒ 不产生事件"
  if (x > 520 && y > 250 && y < 400) {
    const tex = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 * 30 + 62;
    r = tex; g = tex; b = tex * 1.1;
  }
  if (y >= 380 && y < 388) { r = 96; g = 90; b = 80; }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

/** 运动目标（亮球 + 手部）。球先画、手臂后画 —— 与 scene() 的赋值顺序一致（手臂压住球边缘） */
function moverPixel(cx: number, cy: number, x: number, y: number, out: Float32Array, o: number): void {
  const dx = x - cx;
  const dy = y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 < 34 * 34) {
    if (d2 > 26 * 26) { out[o] = 150; out[o + 1] = 158; out[o + 2] = 170; }
    else { out[o] = 232; out[o + 1] = 236; out[o + 2] = 240; }
  }
  if (x > cx - 150 && x < cx - 30 && Math.abs(y - (cy + 26)) < 15) { out[o] = 168; out[o + 1] = 150; out[o + 2] = 138; }
}

/** 运动目标的圆心（导出：tools/synth_l2_selfcheck.ts 的"事件位置自证"必须用同一条算式，不许另抄一份） */
export function ballCenter(u: number): { cx: number; cy: number } {
  return { cx: 250 + 190 * u, cy: 240 + 70 * u };
}

/** 事件的 400×240 网格 luma（2×2 块取块心采样 ≈ 离线脚本的 2×2 降采样） */
export function gridLuma(u: number, out: Float32Array): void {
  const { cx, cy } = ballCenter(u);
  const buf = new Float32Array(3);
  for (let gy = 0; gy < SYNTH_GH; gy++) {
    const y = GY[gy] ?? 0;
    const row = gy * SYNTH_GW;
    for (let gx = 0; gx < SYNTH_GW; gx++) {
      const x = GX[gx] ?? 0;
      staticPixel(x, y, buf, 0);
      moverPixel(cx, cy, x, y, buf, 0);
      const Y = (77 * (buf[0] ?? 0) + 150 * (buf[1] ?? 0) + 29 * (buf[2] ?? 0)) >> 8;
      out[row + gx] = LOG2_LUT[Y < 0 ? 0 : Y > 255 ? 255 : Y] ?? 0;
    }
  }
}

/** 原始帧（RGB565 高位在前），走的是与网关推流完全相同的字节格式 —— 前端解码路径不搞特殊 */
export function renderRgb565(u: number, into: Uint8Array): void {
  const { cx, cy } = ballCenter(u);
  const buf = new Float32Array(3);
  let q = 0;
  for (let py = 0; py < SYNTH_H; py++) {
    const y = py + 0.5;
    for (let px = 0; px < SYNTH_W; px++, q += 2) {
      const x = px + 0.5;
      staticPixel(x, y, buf, 0);
      moverPixel(cx, cy, x, y, buf, 0);
      const r5 = (clamp255(buf[0] ?? 0) >> 3) & 0x1f;
      const g6 = (clamp255(buf[1] ?? 0) >> 2) & 0x3f;
      const b5 = (clamp255(buf[2] ?? 0) >> 3) & 0x1f;
      const v = (r5 << 11) | (g6 << 5) | b5;
      into[q] = (v >> 8) & 0xff;        // 高位在前
      into[q + 1] = v & 0xff;
    }
  }
}

/**
 * 合成源：按 26.4 fps 出事件、每 8 个 tick 出 1 帧原始画面，1 Hz 出 STATS。
 * 时间由外面喂（poll(nowMs)）而不是自己 setInterval —— 这样暂停/回放/截图都对同一根时间轴负责。
 */
export class SynthSource {
  readonly profile: Profile;
  private readonly prev: Float32Array = new Float32Array(SYNTH_GW * SYNTH_GH);
  private readonly cur: Float32Array = new Float32Array(SYNTH_GW * SYNTH_GH);
  private readonly raw: Uint8Array = new Uint8Array(SYNTH_W * SYNTH_H * 2);
  private evBytes: Uint8Array = new Uint8Array(4096);
  private readonly evPool: EventRecord[] = [];
  private evBuf: EventRecord[] = [];
  private counters: Counters = createCounters();
  private tick = 0;
  private nextTickMs = 0;
  private started = false;
  private seq = 0;
  private packets = 0;
  private bytes = 0;
  private bytesRaw = 0;
  private bytesEvents = 0;
  private lastStatsMs = 0;
  private lastStatsPackets = 0;
  private lastStatsBytes = 0;
  private lastFrameIdx = 0;

  constructor(profile: Profile) {
    this.profile = profile;
    gridLuma(0, this.prev); // 首帧之前先对齐 prev，避免启动瞬间炸出一片假事件
  }

  /** 外部时钟推进；返回本次应该下发给前端的消息（可能是空数组） */
  poll(nowMs: number): IpcMessage[] {
    if (!this.started) return [];
    const out: IpcMessage[] = [];
    if (this.nextTickMs === 0) {
      this.nextTickMs = nowMs;
      // 启动时立刻给一帧 + 一条 STATS：截图/接不上网关时不必等 300 ms
      out.push(this.frameMessage(nowMs));
      out.push(this.statsMessage(nowMs));
    }
    let guard = 0;
    while (nowMs >= this.nextTickMs && guard++ < 8) {
      const msgs = this.oneTick(this.nextTickMs);
      for (const m of msgs) out.push(m);
      this.nextTickMs += TICK_MS;
    }
    if (nowMs - this.lastStatsMs >= 1000) out.push(this.statsMessage(nowMs));
    return out;
  }

  start(nowMs: number): void {
    this.started = true;
    this.nextTickMs = 0;
    this.lastStatsMs = nowMs;
    this.tick = 0;
    gridLuma(0, this.prev);
  }

  stop(): void {
    this.started = false;
  }

  private oneTick(nowMs: number): IpcMessage[] {
    const out: IpcMessage[] = [];
    const wrapped = this.tick % SWEEP_TICKS === 0 && this.tick > 0;
    const u = (this.tick % SWEEP_TICKS) / SWEEP_TICKS;
    gridLuma(u, this.cur);
    // 扫掠回到起点时是"剪辑点"：直接对齐 prev，不发事件（否则会炸出一片假的 ON/OFF）
    if (!wrapped) {
      const n = this.collectEvents(this.tick === 0 ? 0 : THETA_LSB);
      // 本 tick 的事件属于**即将下发的那一帧**（lastFrameIdx + 1），不是已经发过的上一帧 ——
      // 帧号口径见 eventMessage() 的注释（这是"合成源事件画面全黑"的修复点）。
      if (n > 0 && !this.paused) out.push(this.eventMessage(n, nowMs, this.lastFrameIdx + 1));
    }
    const tmp = this.prev;
    this.prev.set(this.cur.subarray(0, tmp.length), 0);
    // tick 0 不重复出帧：poll() 启动时已经给过一帧，否则前两帧挤在 0 ms 内，
    // 会让"近 4 s 帧率"在头一秒虚高一倍（数字诚实，但不能自欺）
    if (this.tick > 0 && this.tick % FRAME_EVERY === 0) {
      renderRgb565(u, this.raw);
      this.lastFrameIdx = this.tick / FRAME_EVERY;
      out.push(this.frameMessage(nowMs));
    }
    this.tick++;
    return out;
  }

  /** 后面 Windows 端暂停用：暂停只停原始帧，事件照推（与 04 §7.2 的背压口径一致） */
  paused = false;

  private collectEvents(threshold: number): number {
    const rb = Math.max(3, Math.min(8, this.profile.evRecBytes));
    let n = 0;
    for (let i = 0; i < this.cur.length; i++) {
      const d = (this.cur[i] ?? 0) - (this.prev[i] ?? 0);
      if (d > threshold || d < -threshold) {
        const gx = i % SYNTH_GW;
        const gy = (i - gx) / SYNTH_GW;
        const rec = this.evPool[n] ?? { x: 0, y: 0, pol: 0 as const, flags: 0, ts: 0 };
        (rec as { x: number }).x = gx;
        (rec as { y: number }).y = gy;
        (rec as { pol: 0 | 1 }).pol = d > 0 ? 1 : 0;
        this.evPool[n] = rec;
        n++;
      }
    }
    this.evBuf = this.evPool.slice(0, n);
    const need = n * rb;
    if (this.evBytes.length < need) this.evBytes = new Uint8Array(Math.max(need, this.evBytes.length * 2));
    for (let k = 0; k < n; k++) {
      const r = this.evPool[k];
      if (!r) continue;
      const o = k * rb;
      this.evBytes[o] = r.x & 0xff;
      this.evBytes[o + 1] = (r.x >> 8) & 0x01;   // 保留位清 0
      if (rb >= 3) this.evBytes[o + 2] = r.y & 0xff;
      if (rb >= 4) this.evBytes[o + 3] = r.pol;
      if (rb >= 5) this.evBytes[o + 4] = 0;      // TS8 未使用
    }
    return n;
  }

  private frameMessage(nowMs: number): IpcFrameRaw {
    const chunkBytes = this.raw.length;
    this.packets += this.profile.chunksPerFrame;
    this.bytes += chunkBytes;
    this.bytesRaw += chunkBytes;   // 与网关口径一致：事件字节不计入 bytesRaw
    return {
      type: "FRAME_RAW",
      flags: IPC.FLAG_SYNTHETIC,
      seq: this.seq++ & 0xffff,
      frameIdx: this.lastFrameIdx >>> 0,
      tArriveMs: nowMs >>> 0,
      w: SYNTH_W,
      h: SYNTH_H,
      pixel: PIXEL.RGB565_BE,
      raw: this.raw.slice(),   // 复制：下游可能留着做导出，不能让我复用的缓冲被改掉
    };
  }

  /**
   * 事件消息：`frameIdx` 必须取**即将下发的那一帧**（调用方传 `lastFrameIdx + 1`），不能取 `lastFrameIdx`。
   *
   * 为什么（2026-10-13 用户报「合成源的事件画面全黑」的根因，见
   * docs/05_实验与实测/上位机合成源修复_20261013/合成源修复报告.md §3）：
   * 前端自 KEY3 撕裂修复（A1~A5，2026-10-09）起按「事件随帧取用」——
   * EVENTS 先入队（键 = frameIdx），要等**同 frameIdx** 的 FRAME_RAW 到达才置位，
   * 未命中不置位、比本帧更旧的键无条件清掉（web/src/main.ts 的 handleEvents/handleFrame）。
   * 网关（板源/回放）由 A5 统一保证「EVENTS(N) 先于 FRAME_RAW(N)」；页内合成源原来把事件标成
   * `lastFrameIdx`（**上一帧**，此刻早已画过、且已从队列里删掉），于是每批事件入队即过期 ——
   * 界面上事件率 24 kev/s 而 L2「点亮 0 / 96000」、画布全黑（像素级取证见报告 §2）。
   * 改成 +1 后：两次原始帧之间的所有事件都在 FRAME_RAW(N) 之前发出且同号（本函数在 oneTick 的
   * out 里排在 frameMessage 之前），与 A5 的口径逐字一致 ⇒ 事件落在它该在的那一帧上。
   */
  private eventMessage(count: number, nowMs: number, frameIdx: number): IpcEvents {
    const rb = Math.max(3, Math.min(8, this.profile.evRecBytes));
    const evLen = count * rb;
    this.bytes += evLen;
    this.bytesEvents += evLen;
    return {
      type: "EVENTS",
      flags: IPC.FLAG_SYNTHETIC,
      seq: this.seq++ & 0xffff,
      frameIdx: frameIdx >>> 0,
      tArriveMs: nowMs >>> 0,
      recBytes: rb,
      count,
      data: this.evBytes.slice(0, count * rb),
    };
  }

  private statsMessage(nowMs: number): IpcStats {
    const dt = Math.max(0.001, (nowMs - this.lastStatsMs) / 1000);
    const dPackets = this.packets - this.lastStatsPackets;
    const dBytes = this.bytes - this.lastStatsBytes;
    this.lastStatsMs = nowMs;
    this.lastStatsPackets = this.packets;
    this.lastStatsBytes = this.bytes;
    const stats: SourceStats = {
      packets: this.packets,
      bytes: this.bytes,
      bytesRaw: this.bytesRaw,
      bytesEvents: this.bytesEvents,
      pps: dPackets / dt,
      bps: dBytes / dt,
      lastFrameIdx: this.lastFrameIdx,
      wraps: 0,
      tNowMs: nowMs,
    };
    return {
      type: "STATS",
      flags: IPC.FLAG_SYNTHETIC,
      seq: this.seq++ & 0xffff,
      frameIdx: this.lastFrameIdx >>> 0,
      tArriveMs: nowMs >>> 0,
      stats,
      counters: this.counters,
    };
  }

  /** 仅供面板/测试读取：当前 tick 与最近一次事件条数 */
  get debugState(): { tick: number; events: number } {
    return { tick: this.tick, events: this.evBuf.length };
  }
}
