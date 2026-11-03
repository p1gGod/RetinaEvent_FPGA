// 事件级运动预测：只吃 EventRecord[]（不碰 raw / detectBright），串口 EV_ONLY 无原始帧也能跑。
//
// 为什么是"粗栅格聚类 + 最近邻 + 每目标一个 CV 卡尔曼"而不是一上来就上神经网络：
// 这块板子的卖点是"事件相机 + 上位机处理"，演示现场需要的是**可解释**的预测——
// 用户能指着画面说"这个点上一秒朝那边走，所以虚线框在这里"。卡尔曼的每个数字都能算给用户看。
//
// 数据流（全部在 feed 里完成，不依赖 rAF）：
//   事件滑动窗口（~350 ms） → 每 ~66 ms 按 8 px 栅格做一次 8 邻域连通域 → 取点数前 4 的簇
//   → 以簇质心为观测做最近邻关联 → 每个 track 用 [pos, vel] 二维 CV 卡尔曼滤波
//   → snapshot 外推 horizonS，只读、不改变内部状态。
//
// 边界纪律：PredictedTrack 的 px/py 永远夹在事件栅格 [0, evW] × [0, evH] 内；
// snapshot 不复用"已经 500 ms 没有任何观测"的旧轨迹（宁可空屏，也不画幽灵）。
import type { EventRecord } from "@retina/protocol";

export interface MotionConfig {
  enabled: boolean;
  horizonS: number;
}

export interface MotionPoint {
  readonly x: number;
  readonly y: number;
}

export interface PredictedTrack {
  readonly id: number;
  /** 当前（now）位置，事件栅格坐标 */
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly speed: number;
  readonly w: number;
  readonly h: number;
  /** 外推到 horizonS 的位置（夹在栅格边界内） */
  readonly px: number;
  readonly py: number;
  readonly hits: number;
  readonly misses: number;
  readonly ageMs: number;
  /** 位置标准差（px），用于画不确定度；由协方差开方得到 */
  readonly sigma: number;
  readonly trail: readonly MotionPoint[];
}

export interface MotionSnapshot {
  readonly tracks: readonly PredictedTrack[];
  readonly eventCount: number;
  readonly clusterCount: number;
  readonly updatedAtMs: number;
}

/** 事件窗口长度：太短测不出速度，太长会把目标的旧位置和当前位置连成一片 */
const WINDOW_MS = 350;
/** 窗口硬上限：2 万 ev/s × 0.35 s ≈ 7k，留一倍余量；超出按最旧丢弃，内存不随运行时长涨 */
const MAX_WINDOW_EVENTS = 16_000;
/** 聚类周期：50–80 ms 的折中（25 ev/s 的批次下大约每 3–4 批算一次） */
const CLUSTER_INTERVAL_MS = 66;
/** 粗栅格 8 px；事件栅格 400×240 ⇒ 50×30 个单元 */
const CELL_PX = 8;
/** 少于这个点数的连通域当噪声（静止本底/散粒） */
const MIN_CLUSTER_EVENTS = 12;
const MAX_CLUSTERS = 4;
/** 最近邻门限：基础 48 px + 速度补偿，目标越快允许的关联距离越大（但仍限制在 120 px 内） */
const GATE_BASE_PX = 48;
const GATE_SPEED_S = 0.12;
const GATE_MAX_PX = 120;
/** 连续 500 ms 没有观测就删轨迹（约 7 个聚类周期） */
const TRACK_TIMEOUT_MS = 500;
/** 观测新鲜度阈值：约 2 个聚类周期没有新事件就认为目标已停；
 *  超过它 snapshot 不再按旧速度外推，而是冻结在最后一次卡尔曼更新位置。 */
const COAST_MS = 140;
/** 观测噪声方差：簇质心抖动按 ~4 px 计 */
const R_POS = 16;
/** 过程噪声（加速度谱密度）：让滤波器跟得上真实机动，又不至于一帧抖成锯齿 */
const Q_ACCEL = 2400;
/** 速度初值方差：第一次观测不能假装知道速度 */
const P_VEL_INIT = 900;
const MAX_TRAIL = 10;
const MAX_DT_S = 0.5;
const MIN_DT_S = 0.02;

interface WindowEvent {
  x: number;
  y: number;
  t: number;
}

interface Observation {
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  /** 该连通域里**最新一个事件**的时间：轨迹的 lastSeen 必须取它，不能取聚类时刻。
   *  否则目标消失后，350 ms 窗口内的旧事件仍会被反复聚类，把 lastSeen 一直续到
   *  "窗口排空 + 500 ms"，屏幕上就会留一个 850 ms 的幽灵框。 */
  lastT: number;
}

/** 每个轴独立的 [pos, vel] 卡尔曼（F=[[1,dt],[0,1]]，H=[1,0]） */
class AxisKalman {
  pos: number;
  vel = 0;
  /** 协方差 [[p00,p01],[p01,p11]] */
  p00 = R_POS;
  p01 = 0;
  p11 = P_VEL_INIT;

  constructor(pos: number) {
    this.pos = pos;
  }

  /** 状态推进 dt 秒（不改观测量，只用于关联/显示；协方差加过程噪声） */
  predict(dtS: number): void {
    const dt = clamp(dtS, 0, MAX_DT_S);
    this.pos += this.vel * dt;
    const q = Q_ACCEL;
    const q00 = (q * dt * dt * dt) / 3;
    const q01 = (q * dt * dt) / 2;
    const q11 = q * dt;
    const p00 = this.p00 + 2 * dt * this.p01 + dt * dt * this.p11 + q00;
    const p01 = this.p01 + dt * this.p11 + q01;
    const p11 = this.p11 + q11;
    this.p00 = p00;
    this.p01 = p01;
    this.p11 = p11;
  }

  /** 位置观测更新（标量观测，H=[1,0]） */
  update(z: number): void {
    const s = this.p00 + R_POS;
    const k0 = this.p00 / s;
    const k1 = this.p01 / s;
    const y = z - this.pos;
    this.pos += k0 * y;
    this.vel += k1 * y;
    const p00 = (1 - k0) * this.p00;
    const p01 = (1 - k0) * this.p01;
    const p11 = this.p11 - k1 * this.p01;
    this.p00 = Math.max(0, p00);
    this.p01 = p01;
    this.p11 = Math.max(0, p11);
  }

  /** 从"上次更新时刻"外推 dt 秒后的位置（不改状态） */
  positionAt(dtS: number): number {
    return this.pos + this.vel * clamp(dtS, 0, MAX_DT_S);
  }

  /** 外推 h 秒后的位置方差（含当前速度方差项） */
  varianceAt(hS: number): number {
    const h = clamp(hS, 0, MAX_DT_S + 2);
    return Math.max(0, this.p00 + 2 * h * this.p01 + h * h * this.p11);
  }
}

interface TrackState {
  id: number;
  readonly xk: AxisKalman;
  readonly yk: AxisKalman;
  hits: number;
  misses: number;
  createdMs: number;
  lastSeenMs: number;
  /** 上一次卡尔曼更新的时刻：dt 从这里算，miss 时不推进状态（否则下次 update 的 dt 会重复计） */
  lastUpdateMs: number;
  w: number;
  h: number;
  trail: MotionPoint[];
}

export class MotionPredictor {
  readonly evW: number;
  readonly evH: number;
  private events: WindowEvent[] = [];
  private tracks: TrackState[] = [];
  private nextId = 1;
  private lastClusterAt = -Infinity;
  private lastFeedAt = 0;
  private lastClusterCount = 0;

  constructor(evW = 400, evH = 240) {
    this.evW = Math.max(1, Math.floor(evW));
    this.evH = Math.max(1, Math.floor(evH));
  }

  /** 喂入一批原始事件；nowMs 必须是单调时钟（main.ts 用 performance.now） */
  feed(records: readonly EventRecord[], nowMs: number): void {
    const now = Number.isFinite(nowMs) ? nowMs : this.lastFeedAt;
    this.lastFeedAt = now;
    for (const r of records) {
      // 坐标越界的事件不参与聚类：它们画不到栅格里，却会把连通域拉到屏幕外
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
      if (r.x < 0 || r.y < 0 || r.x > this.evW || r.y > this.evH) continue;
      this.events.push({ x: r.x, y: r.y, t: now });
    }
    this.prune(now);
    // 即使这一批是空的也要按周期跑：没有观测时 track 的 misses 才会涨、才会过期。
    if (now - this.lastClusterAt >= CLUSTER_INTERVAL_MS) this.clusterAndTrack(now);
  }

  /** 生成只读快照；不改变任何内部状态（连续两次同一 now 结果一致） */
  snapshot(nowMs: number, horizonS: number): MotionSnapshot {
    const now = Number.isFinite(nowMs) ? nowMs : this.lastFeedAt;
    const h = clamp(Number.isFinite(horizonS) ? horizonS : 1, 0, 5);
    const tracks: PredictedTrack[] = [];
    for (const t of this.tracks) {
      const age = now - t.lastSeenMs;
      if (age > TRACK_TIMEOUT_MS) continue;
      // 目标停止后事件窗口还会残留约 350 ms；超过 COAST_MS 就不能再拿旧速度外推，
      // 否则 HUD 会继续画 T+1.0s，把“已停止”误读成“还在走”。冻结只发生在快照视图里，
      // 不改滤波器状态：重新有观测后仍能从原速度继续更新（不会永久冻结）。
      const coasting = age > COAST_MS;
      const dt = clamp((now - t.lastUpdateMs) / 1000, 0, MAX_DT_S);
      // 冻结在“进入 coast 前最后一次 snapshot 的当前点”（= lastSeen+COAST_MS 时刻的外推点），
      // 而不是上次卡尔曼更新位置；这样阈值前后位置连续，目标停止时不会向后跳。
      // 注意 lastUpdateMs 可能晚于 lastSeenMs（窗口旧观测在下一个聚类周期才被吃），
      // 所以锚点必须从 lastSeenMs 算，不能用 COAST_MS/1000 直接当 dt。
      const coastDt = clamp((t.lastSeenMs + COAST_MS - t.lastUpdateMs) / 1000, 0, MAX_DT_S);
      const x = coasting ? coastAxis(t.xk.positionAt(coastDt), t.xk.vel, this.evW) : t.xk.positionAt(dt);
      const y = coasting ? coastAxis(t.yk.positionAt(coastDt), t.yk.vel, this.evH) : t.yk.positionAt(dt);
      const vx = coasting ? 0 : t.xk.vel;
      const vy = coasting ? 0 : t.yk.vel;
      const px = coasting ? x : clamp(x + vx * h, 0, this.evW);
      const py = coasting ? y : clamp(y + vy * h, 0, this.evH);
      // coast 时给的是“当前点”的位置不确定度，不再加预测时域的漂移项。
      const sigma = Math.sqrt(t.xk.varianceAt(dt + (coasting ? 0 : h)) + t.yk.varianceAt(dt + (coasting ? 0 : h)));
      tracks.push({
        id: t.id,
        x,
        y,
        vx,
        vy,
        speed: Math.hypot(vx, vy),
        w: t.w,
        h: t.h,
        px,
        py,
        hits: t.hits,
        misses: t.misses,
        ageMs: Math.max(0, now - t.createdMs),
        sigma,
        trail: t.trail.slice(),
      });
    }
    tracks.sort((a, b) => a.id - b.id);
    return {
      tracks,
      eventCount: this.events.length,
      clusterCount: this.lastClusterCount,
      updatedAtMs: Number.isFinite(this.lastClusterAt) ? this.lastClusterAt : 0,
    };
  }

  /** 换数据源/换 profile 时清空；ID 从头开始，避免旧轨迹的数字被误读成新目标 */
  reset(): void {
    this.events = [];
    this.tracks = [];
    this.nextId = 1;
    this.lastClusterAt = -Infinity;
    this.lastFeedAt = 0;
    this.lastClusterCount = 0;
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < this.events.length && (this.events[drop]?.t ?? Infinity) < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
    if (this.events.length > MAX_WINDOW_EVENTS) {
      this.events.splice(0, this.events.length - MAX_WINDOW_EVENTS);
    }
  }

  private clusterAndTrack(now: number): void {
    this.lastClusterAt = now;
    const clusters = this.cluster();
    this.lastClusterCount = clusters.length;
    // 先清掉过期轨迹（以"最后一次被看见"为准，miss 中不续命）
    this.tracks = this.tracks.filter((t) => now - t.lastSeenMs <= TRACK_TIMEOUT_MS);
    this.associate(clusters, now);
  }

  /** 8 px 粗栅格 + 8 邻域连通域；返回按点数降序的前 MAX_CLUSTERS 个簇 */
  private cluster(): Observation[] {
    const gw = Math.max(1, Math.ceil(this.evW / CELL_PX));
    const gh = Math.max(1, Math.ceil(this.evH / CELL_PX));
    const n = gw * gh;
    const count = new Int32Array(n);
    const sumX = new Float64Array(n);
    const sumY = new Float64Array(n);
    const minX = new Int32Array(n).fill(this.evW + 1);
    const minY = new Int32Array(n).fill(this.evH + 1);
    const lastT = new Float64Array(n);
    const maxX = new Int32Array(n).fill(-1);
    const maxY = new Int32Array(n).fill(-1);
    for (const e of this.events) {
      const cx = clamp(Math.floor(e.x / CELL_PX), 0, gw - 1);
      const cy = clamp(Math.floor(e.y / CELL_PX), 0, gh - 1);
      const i = cy * gw + cx;
      count[i] = (count[i] ?? 0) + 1;
      sumX[i] = (sumX[i] ?? 0) + e.x;
      sumY[i] = (sumY[i] ?? 0) + e.y;
      if (e.x < (minX[i] ?? Infinity)) minX[i] = e.x;
      if (e.y < (minY[i] ?? Infinity)) minY[i] = e.y;
      if (e.t > (lastT[i] ?? 0)) lastT[i] = e.t;
      if (e.x > (maxX[i] ?? -1)) maxX[i] = e.x;
      if (e.y > (maxY[i] ?? -1)) maxY[i] = e.y;
    }
    const visited = new Uint8Array(n);
    const stack: number[] = [];
    const out: Observation[] = [];
    for (let i = 0; i < n; i++) {
      if (visited[i] === 1 || (count[i] ?? 0) === 0) continue;
      visited[i] = 1;
      stack.push(i);
      let total = 0;
      let sx = 0;
      let sy = 0;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      let newest = 0;
      while (stack.length > 0) {
        const c = stack.pop() as number;
        total += count[c] ?? 0;
        sx += sumX[c] ?? 0;
        sy += sumY[c] ?? 0;
        bx0 = Math.min(bx0, minX[c] ?? Infinity);
        by0 = Math.min(by0, minY[c] ?? Infinity);
        bx1 = Math.max(bx1, maxX[c] ?? -Infinity);
        by1 = Math.max(by1, maxY[c] ?? -Infinity);
        newest = Math.max(newest, lastT[c] ?? 0);
        const cx = c % gw;
        const cy = Math.floor(c / gw);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const k = ny * gw + nx;
            if (visited[k] === 1 || (count[k] ?? 0) === 0) continue;
            visited[k] = 1;
            stack.push(k);
          }
        }
      }
      if (total < MIN_CLUSTER_EVENTS) continue;
      out.push({
        x: sx / total,
        y: sy / total,
        w: Math.max(1, bx1 - bx0 + 1),
        h: Math.max(1, by1 - by0 + 1),
        count: total,
        lastT: newest,
      });
    }
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, MAX_CLUSTERS);
  }

  private associate(clusters: readonly Observation[], now: number): void {
    const usedObs = new Uint8Array(clusters.length);
    // 本周期已经吃过观测的 track：不能用 lastSeenMs===now 当哨兵——lastSeen 取的是
    // 观测里的最新事件时间，目标刚消失时它会小于 now（旧窗口还在被聚类）。
    const assigned = new Uint8Array(this.tracks.length);
    const pairs: { ti: number; oi: number; d: number }[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (t === undefined) continue;
      const dt = clamp((now - t.lastUpdateMs) / 1000, 0, MAX_DT_S);
      const px = t.xk.positionAt(dt);
      const py = t.yk.positionAt(dt);
      const speed = Math.hypot(t.xk.vel, t.yk.vel);
      const gate = Math.min(GATE_MAX_PX, GATE_BASE_PX + speed * GATE_SPEED_S);
      for (let oi = 0; oi < clusters.length; oi++) {
        const c = clusters[oi];
        if (c === undefined) continue;
        const d = Math.hypot(c.x - px, c.y - py);
        if (d <= gate) pairs.push({ ti, oi, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const p of pairs) {
      if (usedObs[p.oi] === 1) continue;
      const t = this.tracks[p.ti];
      const c = clusters[p.oi];
      if (t === undefined || c === undefined) continue;
      // 一个 track 每个聚类周期最多吃一个观测
      if (assigned[p.ti] === 1) continue;
      usedObs[p.oi] = 1;
      assigned[p.ti] = 1;
      this.applyObservation(t, c, now);
    }
    // 没用上的旧 track：miss+1（不推进状态，下次仍按 lastUpdateMs 外推）
    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (assigned[ti] !== 1) this.tracks[ti]!.misses++;
    }
    // 没被关联的观测 = 新目标
    for (let oi = 0; oi < clusters.length; oi++) {
      const c = clusters[oi];
      if (usedObs[oi] === 1 || c === undefined) continue;
      this.tracks.push(this.newTrack(c, now));
    }
  }

  private newTrack(c: Observation, now: number): TrackState {
    const id = this.nextId++;
    const t: TrackState = {
      id,
      xk: new AxisKalman(c.x),
      yk: new AxisKalman(c.y),
      hits: 1,
      misses: 0,
      createdMs: c.lastT,
      lastSeenMs: c.lastT,
      lastUpdateMs: now,
      w: c.w,
      h: c.h,
      trail: [{ x: c.x, y: c.y }],
    };
    return t;
  }

  private applyObservation(t: TrackState, c: Observation, now: number): void {
    // 空批时窗口里的旧事件会被反复聚类：c.lastT 还是上一次事件的时间。
    // 这种“同一条旧观测”不能再更新卡尔曼状态，否则目标停止后冻结点仍会被
    // 逐帧推着走（coast 阈值形同虚设）。只有比 lastSeen 更新的事件才算新观测。
    if (c.lastT <= t.lastSeenMs) return;
    const dt = clamp((now - t.lastUpdateMs) / 1000, MIN_DT_S, MAX_DT_S);
    /** 第二次观测 = 两点初始化：直接给速度一个像样的初值，
     *  否则滤波器要从 vel=0 慢慢"追赶"，前 1 秒的预测会明显偏慢（现场看起来就是"预测框拖后腿"）。 */
    const secondObservation = t.hits === 1;
    const prevX = t.xk.pos;
    const prevY = t.yk.pos;
    t.xk.predict(dt);
    t.yk.predict(dt);
    t.xk.update(c.x);
    t.yk.update(c.y);
    if (secondObservation) {
      t.xk.vel = (c.x - prevX) / dt;
      t.yk.vel = (c.y - prevY) / dt;
    }
    t.hits++;
    t.misses = 0;
    // "被看见"的时间取观测里最新的事件时间：窗口里的旧事件不能给轨迹续命
    t.lastSeenMs = Math.max(t.lastSeenMs, c.lastT);
    t.lastUpdateMs = now;
    // 包围盒做指数平滑：单帧连通域的毛刺不该让预测框忽大忽小
    const a = t.hits <= 2 ? 1 : 0.35;
    t.w += (c.w - t.w) * a;
    t.h += (c.h - t.h) * a;
    t.trail.push({ x: c.x, y: c.y });
    if (t.trail.length > MAX_TRAIL) t.trail.splice(0, t.trail.length - MAX_TRAIL);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** coast 冻结点：正常用最后一次卡尔曼更新位置；
 *  目标已经贴边/走出栅格时把点贴到边界，避免 UI 在边界外画半个框。
 *  只在速度朝边界、且距边界不足一个 8 px 栅格时 snap；画面中央的停止目标不受影响。 */
function coastAxis(value: number, velocity: number, max: number): number {
  const v = clamp(value, 0, max);
  if (velocity > 0 && v > max - CELL_PX) return max;
  if (velocity < 0 && v < CELL_PX) return 0;
  return v;
}
