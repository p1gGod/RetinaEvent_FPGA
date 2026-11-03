// 板端 θ / 最小|ΔL| 滑条联动的**纯逻辑**（无 DOM）。
//
// 为什么单独一个模块：这段逻辑有三条互相纠缠的时序规则，靠人眼在浏览器里点根本验不了：
//   1) 拖动过程中下发要节流（板端 v3 下行是"一问一答"的 ACK 链路，5 Hz 连发会把
//      在途表塞满、而且每个 SET_PARAM 都是原子写 —— 现场拖动 3 秒就能发上百条）；
//   2) 松手后**必须**在 150 ms 内把最终值发出去（否则用户"拖到头了但板端没收到"，
//      画面和滑条不一致，这是 2026-10 用户报的"滑条能拖但没效果"类问题的温床）；
//   3) 1 Hz 的 GET_STATUS 读回不能把用户正在拖/正在输入框里打的值覆盖回去。
// 把它抽出来后，gateway/web 的 node --test 和 tools/_verify_slider.mjs 都能直接跑，
// 不需要 jsdom，也不需要板子（板端 ACK 那一段在 verify 脚本里用独立网关真连一次）。
//
// 时间源/定时器可注入：测试用假时钟精确断言"1 秒最多几次"，不依赖真实 setTimeout 抖动。

/** 两个可下发的板端参数：SET_PARAM tag 0x01 / 0x02 */
export type BoardParamKey = "theta" | "minDl";

/** 下发出口（main.ts 里接到 board.setParam RPC） */
export interface BoardParamSend {
  (key: BoardParamKey, value: number): void;
}

/** 节流/延时可注入的时钟（生产用 Date.now / setTimeout，测试用假时钟） */
export interface SliderTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
}

const REAL_TIMERS: SliderTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

/**
 * 拖动中的最小下发间隔。
 * 任务口径是"≤5 次/s"；取 250 ms = 4 次/s，留 1 次余量给"松手补最终值"，
 * 否则拖 1 s 正好 5 条 + 松手 1 条 = 6 条，会被现场当成超频。
 */
export const DRAG_MIN_INTERVAL_MS = 250;
/** 松手/数字框提交后，最终值最迟必须在这个时间内发出 */
export const RELEASE_MAX_DELAY_MS = 150;

interface KeyState {
  /** 上次真正下发时刻（now()） */
  lastSentAt: number;
  /** 上次真正下发的值（用于 ACK 回显/调试；不用于去重，松手必须发一次） */
  lastSentValue: number | null;
  /** 等待下发的值；null = 没有待发值 */
  pending: number | null;
  /** 已排程的定时器句柄；0 = 无 */
  timer: number;
}

export interface BoardParamThrottleOptions {
  readonly minIntervalMs?: number;
  readonly releaseMs?: number;
  readonly timers?: SliderTimers;
}

/**
 * θ/MIN_DL 下发节流器。
 *
 * 用法（sidebar.ts）：
 * - 滑条 input 事件 ⇒ drag(key, v)：本地显示由 DOM 自己跟手更新，下发按节流走；
 * - 滑条 change/数字框提交/刻度点击 ⇒ commit(key, v)：最终值最迟 150 ms 后发出。
 *
 * 两者都只发**最新值**：拖动中排程的定时器触发时取 pending（后到的值覆盖先到的），
 * 板端不会看到一串过时的中间值。
 */
export class BoardParamThrottle {
  private readonly send: BoardParamSend;
  private readonly minIntervalMs: number;
  private readonly releaseMs: number;
  private readonly timers: SliderTimers;
  private readonly states: Record<BoardParamKey, KeyState>;

  constructor(send: BoardParamSend, opts: BoardParamThrottleOptions = {}) {
    this.send = send;
    this.minIntervalMs = opts.minIntervalMs ?? DRAG_MIN_INTERVAL_MS;
    this.releaseMs = opts.releaseMs ?? RELEASE_MAX_DELAY_MS;
    this.timers = opts.timers ?? REAL_TIMERS;
    this.states = {
      theta: { lastSentAt: 0, lastSentValue: null, pending: null, timer: 0 },
      minDl: { lastSentAt: 0, lastSentValue: null, pending: null, timer: 0 },
    };
  }

  /** 拖动中的一个采样值：立即存为待发值；窗口空则立刻发，否则排程到窗口末尾 */
  drag(key: BoardParamKey, value: number): void {
    const s = this.states[key];
    s.pending = Math.round(value);
    if (s.timer !== 0) return; // 已有排程，定时器会取最新 pending
    const wait = this.minIntervalMs - (this.timers.now() - s.lastSentAt);
    if (wait <= 0) this.fire(key);
    else this.arm(key, wait);
  }

  /**
   * 最终值（松手 / 数字框提交 / 点刻度）：
   * - 距上次下发已过一个窗口 ⇒ 立刻发；
   * - 否则重排到 releaseMs（≤150 ms），保证"松手后一定有一次下发"。
   */
  commit(key: BoardParamKey, value: number): void {
    const s = this.states[key];
    s.pending = Math.round(value);
    if (this.timers.now() - s.lastSentAt >= this.minIntervalMs) {
      this.fire(key);
      return;
    }
    this.arm(key, this.releaseMs);
  }

  /**
   * 松手（pointerup/mouseup/touchend/keyup/blur/change）：
   * - 取消挂起的节流定时器，立即发最终值（R2：修前松手最终值靠 250 ms 拖动定时器，不是 150 ms）；
   * - 若最终值与最近一次已下发值相同且在节流窗口内 ⇒ 不重复下发（板端已有该值）。
   */
  release(key: BoardParamKey, value: number): void {
    const s = this.states[key];
    s.pending = Math.round(value);
    if (s.timer !== 0) {
      this.timers.clearTimeout(s.timer);
      s.timer = 0;
    }
    if (s.lastSentValue === s.pending && this.timers.now() - s.lastSentAt < this.minIntervalMs) {
      s.pending = null;
      return;
    }
    this.fire(key);
  }

  /** 待发值（测试/调试用：null = 当前没有排队值） */
  pendingValue(key: BoardParamKey): number | null {
    return this.states[key].pending;
  }

  /** 最近一次真正下发的值（测试/调试用） */
  lastSent(key: BoardParamKey): number | null {
    return this.states[key].lastSentValue;
  }

  /** 取消两个 key 的排程并清空待发值（页面卸载/切换数据源时用） */
  dispose(): void {
    for (const key of ["theta", "minDl"] as const) {
      const s = this.states[key];
      if (s.timer !== 0) this.timers.clearTimeout(s.timer);
      s.timer = 0;
      s.pending = null;
    }
  }

  private arm(key: BoardParamKey, ms: number): void {
    const s = this.states[key];
    if (s.timer !== 0) this.timers.clearTimeout(s.timer);
    s.timer = this.timers.setTimeout(() => {
      s.timer = 0;
      this.fire(key);
    }, Math.max(0, ms));
  }

  private fire(key: BoardParamKey): void {
    const s = this.states[key];
    const v = s.pending;
    if (v === null) return;
    s.pending = null;
    s.timer = 0;
    s.lastSentAt = this.timers.now();
    s.lastSentValue = v;
    this.send(key, v);
  }
}

// ———————————————————— 滑条模式 / 文案 / 回写守卫 ————————————————————

/** 滑条三态：上位机算法可调 / 板端 SET_PARAM 可调 / 只读 */
export type SliderMode = "host" | "board" | "readonly";

export function sliderModeOf(hostMode: boolean, boardDownlinkAvailable: boolean): SliderMode {
  if (hostMode) return "host";
  return boardDownlinkAvailable ? "board" : "readonly";
}

export function sliderBadgeText(mode: SliderMode): string {
  if (mode === "host") return "上位机可调";
  if (mode === "board") return "板端可调(SET_PARAM)";
  return "只读";
}

/** θ 滑条/板端下发值域钳位：整数、≥1（上位机与板端都别把 0 当合法阈值） */
export function clampThetaSlider(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(max, Math.round(value)));
}

/**
 * 1 Hz 读回是否应该回写滑条。
 * revChanged：v3 状态版本变了才写；dragging：正在拖；editing：数字框正在输入。
 */
export function shouldSyncSlider(g: {
  readonly revChanged: boolean;
  readonly dragging: boolean;
  readonly editing: boolean;
}): boolean {
  return g.revChanged && !g.dragging && !g.editing;
}

/** SET_PARAM 的 ACK 结果（main.ts 从 board.setParam 的 RPC result 摘出来给界面就地回显） */
export interface BoardParamAckView {
  readonly ok: boolean;
  /** 板端 ACK 的 status 字节（失败时的错误码；超时/网关错误为 null） */
  readonly status: number | null;
  readonly detail: string;
  readonly theta: number | null;
  readonly minDl: number | null;
  /** 本地收到该结果的时刻（Date.now，用于界面判断"多久没新结果"） */
  readonly atMs: number;
}

/**
 * ACK 结果就地回显文案（不只在 toast 里说）。
 * 失败时**必须带 status 错误码**：板端 BAD_VALUE 之类只有码才能对上 WIRE-V3 的表述。
 */
export function boardParamAckText(a: BoardParamAckView | null): string {
  if (a === null) return "SET_PARAM 结果：—（尚未下发）";
  if (a.ok) {
    const parts: string[] = [];
    if (a.theta !== null) parts.push("θ=" + a.theta);
    if (a.minDl !== null) parts.push("δL=" + a.minDl);
    return "SET_PARAM OK" + (parts.length === 0 ? "" : " · " + parts.join(" · ")) + "（板端 ACK 读回）";
  }
  const code = a.status === null ? "" : "status=" + a.status + " · ";
  return "SET_PARAM 被拒：" + code + (a.detail === "" ? "未知原因" : a.detail);
}
