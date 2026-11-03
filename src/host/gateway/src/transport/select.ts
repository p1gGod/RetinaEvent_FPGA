// 传输方式选择状态机（WIRE-U1 §1.3 / §5.3 的 PC 侧落点）：UDP / UART / 自动。
//
// 为什么值得单独一个纯模块：选择规则里有**能力差异**（网口在 = MODE0/1/2 三模式全可选；
// 仅串口 = 只事件回传，MODE1 只原画物理不可用），还有两种失败要区分对待 ——
//   ① 打开/握手失败：auto 必须**降级**到另一条通道并如实说明"降级了、能力少了什么"；
//   ② 显式选择（--transport uart）失败：必须**明确报错**，绝不偷偷回退到 UDP（否则用户以为在看串口）。
// 纯函数式（无 IO）：探测结果由调用方喂进来，规则在这里判定 ⇒ 单测可以穷举所有组合。

/** 数据通道种类（本任务只需 UDP / UART 两种） */
export type TransportKind = "udp" | "uart";
/** 选择模式：显式 UDP / 显式 UART / 自动（先网口后串口） */
export type TransportMode = "udp" | "uart" | "auto";
/** 选择器状态：idle=未探测 / active=主通道就绪 / degraded=降级（能力受限）/ failed=无通道 */
export type SelectorState = "idle" | "active" | "degraded" | "failed";

export interface ProbeOutcome {
  readonly ok: boolean;
  /** 人能看懂的一句话（成功也给：握手 RTT / 首包到达等都写这里） */
  readonly detail: string;
}

export interface TransportDecision {
  readonly mode: TransportMode;
  readonly state: SelectorState;
  /** 主数据面（null = 无可用通道） */
  readonly active: TransportKind | null;
  /** 第二观察通道（网口在 + 串口可用时的 UART） */
  readonly secondary: TransportKind | null;
  /** true = 当前是"仅串口"降级档（能力漏掉 MODE1 原画） */
  readonly degraded: boolean;
  readonly reason: string;
  /** 状态迁移轨迹（联调/测试用：每一步都有据可查） */
  readonly trail: readonly string[];
  /** 失败的探针明细（前端直接上屏；键 = 通道） */
  readonly failures: Readonly<Partial<Record<TransportKind, string>>>;
}

/** 「仅串口」档的能力差异文案（设计 §5.3：MODE1 只原画在 115200 下需 66.7 s/帧，物理不可能） */
export const UART_ONLY_NOTE = "仅事件回传（115200 下原画不可达：MODE1 只原画禁用；串口命令 EV_EN/SET_PARAM/EV_RES 仍可下发）";
/** 「网口在」档的能力文案（设计 §1.3：三模式全可选，串口同时可作第二观察通道） */
export const UDP_ALL_MODES_NOTE = "网口可用：MODE0/MODE1/MODE2 三模式全可选";

const ORDER: Record<TransportMode, readonly TransportKind[]> = {
  udp: ["udp"],
  uart: ["uart"],
  // auto：先网口后串口（设计 §5.3 的裁决方向 —— 网口在则全功能，否则只事件回传）
  auto: ["udp", "uart"],
};

export class TransportSelector {
  readonly mode: TransportMode;
  private readonly order: readonly TransportKind[];
  private cursor = 0;
  private readonly results = new Map<TransportKind, ProbeOutcome>();
  private active: TransportKind | null = null;
  private secondary: TransportKind | null = null;
  private failed = false;
  private degraded = false;
  private reason = "未探测";
  private readonly trail: string[] = [];

  constructor(mode: TransportMode) {
    this.mode = mode;
    this.order = ORDER[mode];
  }

  /** 下一个要探测的通道；null = 探测已结束（结论看 decision） */
  next(): TransportKind | null {
    while (this.cursor < this.order.length) {
      const kind = this.order[this.cursor] as TransportKind;
      this.cursor++;
      return kind;
    }
    return null;
  }

  /**
   * 喂入一次探测结果。顺序必须与 next() 一致（乱序喂会抛，避免静默走错分支）。
   * 未显式 next() 时按 order 顺序自动前进（调用方"直接喂结论"的写法也合法，但种类错仍然抛）。
   */
  record(kind: TransportKind, outcome: ProbeOutcome): TransportDecision {
    if (this.cursor < this.order.length && this.order[this.cursor] === kind) this.cursor++;
    const expected = this.order[this.cursor - 1];
    if (expected !== kind) {
      throw new Error("传输选择器：探测顺序错乱（期望 " + String(expected) + " 实得 " + kind + "）");
    }
    this.results.set(kind, outcome);
    this.trail.push(kind + (outcome.ok ? " OK" : " FAIL") + "：" + outcome.detail);
    if (outcome.ok) this.onProbeOk(kind);
    else this.onProbeFail(kind);
    return this.decision;
  }

  get decision(): TransportDecision {
    return {
      mode: this.mode,
      state: this.failed ? "failed" : this.degraded ? "degraded" : this.active === null ? "idle" : "active",
      active: this.active,
      secondary: this.secondary,
      degraded: this.degraded,
      reason: this.reason,
      trail: [...this.trail],
      failures: Object.fromEntries([...this.results.entries()].filter(([, r]) => !r.ok).map(([k, r]) => [k, r.detail])),
    };
  }

  /** 探测是否已结束（结论可用） */
  get settled(): boolean {
    return !(this.cursor < this.order.length && this.active === null && !this.failed);
  }

  /**
   * 运行期降级：当前主通道失效（UDP 停滞 / 串口关闭）时换到备选。
   * 只有 auto 模式、且备选**已探过且可用**才允许；否则返回 null（调用方保持现状 + 明确报错）。
   */
  fallback(reasonText: string): TransportDecision | null {
    if (this.mode !== "auto") return null;
    const other: TransportKind = this.active === "udp" ? "uart" : "udp";
    const probe = this.results.get(other);
    if (probe === undefined || !probe.ok) return null;
    if (this.active === other) return null;
    this.trail.push("降级 " + String(this.active) + " → " + other + "：" + reasonText);
    this.active = other;
    this.secondary = null;
    this.degraded = other === "uart";
    this.reason = "主通道失效（" + reasonText + "）→ 降级到 " + other + "：" + (other === "uart" ? UART_ONLY_NOTE : UDP_ALL_MODES_NOTE);
    return this.decision;
  }

  /** 用户显式切换（UI/config.set）：更新 mode 之外的结论文案（探测由调用方先做） */
  force(kind: TransportKind, reasonText: string): TransportDecision {
    this.trail.push("显式切换到 " + kind + "：" + reasonText);
    this.active = kind;
    this.secondary = null;
    this.degraded = kind === "uart";
    this.failed = false;
    this.reason = reasonText;
    return this.decision;
  }

  // ————————————————————————— 内部 —————————————————————————

  private onProbeOk(kind: TransportKind): void {
    if (kind === "udp") {
      this.active = "udp";
      this.secondary = null;
      this.degraded = false;
      this.reason = this.mode === "auto" ? UDP_ALL_MODES_NOTE : "UDP 数据面就绪：" + UDP_ALL_MODES_NOTE;
      return;
    }
    // kind === "uart"
    if (this.active === "udp") {
      // 网口在 + 串口也可用：串口是**第二观察通道**（设计 §5.3 上位机行）
      this.secondary = "uart";
      this.reason = UDP_ALL_MODES_NOTE + "；串口亦可用（第二观察通道）";
      return;
    }
    this.active = "uart";
    this.degraded = true;
    this.reason = "网口不可用 → " + UART_ONLY_NOTE;
  }

  private onProbeFail(kind: TransportKind): void {
    const detail = this.results.get(kind)?.detail ?? "";
    if (kind === "uart" && this.active === "udp") {
      // 网口在、串口不可用：**不是失败**，只是少了一条观察通道（如实写进 reason）
      this.reason = UDP_ALL_MODES_NOTE + "；串口不可用（" + detail + "）";
      return;
    }
    if (kind === "udp" && this.mode === "auto") {
      // 还有串口没探：不结算（等 record("uart") 时再定）
      this.reason = "网口不可用（" + detail + "），尝试串口…";
      return;
    }
    // 显式选择失败，或 auto 的备选也失败 ⇒ 整条选择失败：把两侧原因都摊开
    this.failed = true;
    this.active = null;
    const all = [...this.results.entries()].map(([k, r]) => (k === "udp" ? "UDP" : "串口") + "：" + (r.ok ? "OK" : r.detail));
    this.reason = "没有可用数据通道 —— " + all.join(" / ");
  }
}
