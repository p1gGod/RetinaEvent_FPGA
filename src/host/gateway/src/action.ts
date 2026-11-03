// 动作识别的网关侧快照 + 事件环 + 映射配置（契约 05_动作回传与上位机契约 §4）。
//
// 为什么单独一个模块（而不是塞进 LatestStore）：
//   · 动作字节（byte23）是**每包都带**的状态量，但事件语义是"类别变化才记一条"，
//     和"最新一帧/最新事件图"的单槽容量语义不同（事件要环、要 seq、要长轮询）；
//   · /api/action、/api/action/events、/api/action/config 三个接口共享同一份状态，
//     前端 WS config.set 写进来的映射也落在这里 —— 只读镜像，不落盘。
//
// 接线方式：processor 解析到 v3 包后调 actionStore.observe(...)（模块级单例）。
// 为什么用单例：transport/** 不在本轮改动白名单，PacketProcessor 由 BaseFrameSource 内部构造，
// 没有现成的钩子路径把 store 注入到传输层；单例是"只加调用、不改传输层契约"的最小接线。
// 测试可以另外 new ActionStore() 不碰单例（长轮询/环语义都能独立验证）。
import { ACT_CLASS_NAMES, OFF3, decodeActionState } from "@retina/protocol";
import type { ParsedV3 } from "@retina/protocol";

/** 动作类别（当前权威语义：0 无动作 / 1 手部开合（任一方向） / 2 横向挥手 / 3 保留） */
export type ActionClass = 0 | 1 | 2 | 3;

/** 可执行操作（契约 §5.2；none 不做事） */
export type ActionOp = "none" | "startRecord" | "stopRecord" | "startAndAutoExport";

/** 导出目标（契约 §5.3；对 none/startRecord/stopRecord 不生效但仍须合法） */
export type ActionTarget = "raw" | "events" | "overlay" | "statsOnly";

export interface ActionMapEntry {
  readonly action: ActionOp;
  readonly target: ActionTarget;
}

/** 动作映射配置（= 前端 localStorage 键 actionMap 的 schema，契约 §5.4） */
export interface ActionConfig {
  readonly v: 1;
  readonly updatedAtMs: number;
  readonly minConf: number;
  readonly map: Readonly<Record<"0" | "1" | "2", ActionMapEntry>>;
}

/** 默认映射（契约 §5.4 的默认值，网关与前端各存一份但必须逐字段一致） */
export const DEFAULT_ACTION_CONFIG: ActionConfig = Object.freeze({
  v: 1 as const,
  updatedAtMs: 0,
  minConf: 8,
  map: Object.freeze({
    "0": Object.freeze({ action: "none" as const, target: "statsOnly" as const }),
    "1": Object.freeze({ action: "startRecord" as const, target: "raw" as const }),
    "2": Object.freeze({ action: "stopRecord" as const, target: "raw" as const }),
  }),
});

const ACTION_OPS: readonly ActionOp[] = ["none", "startRecord", "stopRecord", "startAndAutoExport"];
const ACTION_TARGETS: readonly ActionTarget[] = ["raw", "events", "overlay", "statsOnly"];
const MAP_KEYS = ["0", "1", "2"] as const;

/** 类别显示名（越界按 3=保留 处理；前端卡片/API 同一个口径） */
export function actionClassName(cls: number): string {
  return ACT_CLASS_NAMES[(cls & 0x03) as 0 | 1 | 2 | 3];
}

/**
 * 从一条已解析 v3 包取动作字节（契约 §3）：
 * 优先用 CTRL 包 TLV 0x92（len=1，只随 GET_STATUS ACK 尾追）里的值 —— 那是板端"当前快照"的显式声明；
 * 否则用包头 byte23（OFF3.ACTION，每包都带）。
 * 为什么 TLV 优先：联板抓到过"ACK 里 TLV 与 byte23 同时有效但不同帧"的瞬间，
 * TLV 是 GET_STATUS 那一刻的显式真值，比"顺带带的包头字节"更可信（契约 §3 尾段）。
 */
export function actionRawOfPacket(buf: Uint8Array, pkt: ParsedV3): number {
  const tlv = pkt.ctrlHeader?.tlv.find((t) => t.tag === 0x92);
  if (tlv !== undefined && tlv.value.length === 1) return tlv.value[0] as number;
  return (buf[OFF3.ACTION] ?? 0) & 0xff;
}

/**
 * CTRL 包是否携带权威的动作状态 TLV 0x92（len=1，只随 GET_STATUS ACK 尾追）。
 * 为什么需要它：非 GET_STATUS 的 CTRL 包（最典型是 1 Hz 心跳 0xF0）里 byte23 落
 * downlink_cmd.v 的 default 分支 = 0x00，这不是"无动作"的真实状态；拿它喂 observe()
 * 会把 prevValid 打回 false，下一条数据包又被记一次 valid_rise，检测次数被系统性放大。
 * malformed 0x92（len != 1）也返回 false：不能让它回退到 byte23 再触发同一个问题。
 */
export function hasActionStateTlv(pkt: ParsedV3): boolean {
  return pkt.ctrlHeader?.tlv.some((t) => t.tag === 0x92 && t.value.length === 1) ?? false;
}

/** 映射结果（/api/action 的 mapped 字段；null = 本轮没有可执行映射） */
export interface ActionMapped {
  readonly action: ActionOp;
  readonly target: ActionTarget;
}

/** 触发一次检测计数的事件原因：VALID 上升沿 或 类别变化（task-24） */
export type ActionEventReason = "valid_rise" | "class_change";

/** 一条动作事件（契约 §4.2；VALID 上升沿或类别变化时产生） */
export interface ActionEvent {
  readonly seq: number;
  /** 事件发生时刻（= 该包到达网关的 tArriveMs，与 /api/action 的 tArriveMs 同源） */
  readonly tMs: number;
  readonly frameIdx: number;
  readonly raw: number;
  readonly valid: boolean;
  readonly class: ActionClass;
  readonly className: string;
  readonly conf: number;
  readonly mapped: ActionMapped | null;
  /** 为什么记这一次检测：valid_rise = VALID 0->1；class_change = VALID 保持 1 但类别变了 */
  readonly reason: ActionEventReason;
}

/** 当前快照（/api/action 的可用性判定 + 字段来源） */
export interface ActionSnapshot {
  /** 是否已经观察到过 v3 动作字节（false = 当前源不是 v3 / 还没收到过 v3 数据包） */
  readonly available: boolean;
  readonly frameIdx: number;
  readonly tArriveMs: number;
  readonly raw: number;
  readonly valid: boolean;
  readonly class: ActionClass;
  readonly className: string;
  readonly conf: number;
  readonly mapped: ActionMapped | null;
}

export interface ActionEventsPage {
  readonly events: readonly ActionEvent[];
  readonly lastSeq: number;
  readonly dropped: number;
  readonly timedOut: boolean;
}

interface Waiter {
  readonly after: number;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 事件环容量（契约 §4.2：环 64 条；单次最多返回 32 条） */
export const ACTION_EVENT_RING = 64;
export const ACTION_EVENT_PAGE = 32;

export class ActionStore {
  private snap: ActionSnapshot | null = null;
  private events: ActionEvent[] = [];
  private nextSeq = 1;
  /** 最近一条事件的 seq；0 = 还没有任何事件（/api/action 兼容镜像字段用） */
  private lastEventSeq = 0;
  /** 上一条 v3 动作字节的 VALID（用于识别 0->1 上升沿；task-24） */
  private prevValid = false;
  /** 上一条有效动作字节的类别（跨 VALID=0 空窗保留，用于 class_change 判定） */
  private prevClass: ActionClass | null = null;
  /** 累计检测次数：VALID 上升沿或类别变化各记一次（task-24；/api/action 的 count） */
  private count = 0;
  private waiters: Waiter[] = [];
  private cfg: ActionConfig = DEFAULT_ACTION_CONFIG;
  private cfgSource: "ui" | "default" = "default";

  /**
   * 观察一条 v3 包的动作字节（processor 每包调用一次）。
   * 事件判定（task-24）：VALID 由 0 变 1（上升沿）或类别相对上一条有效字节发生变化，
   * 两者任一记一条并把 count +1；VALID 保持 1 且类别不变（哪怕 conf 变）不记。
   * valid=false 的包只更新快照、绝不产生事件（避免"识别未启用"被当成一次动作）。
   * 不触发任何执行 —— 执行只发生在浏览器页面内（契约 §5.6）。
   */
  observe(raw: number, frameIdx: number, tArriveMs: number): void {
    const st = decodeActionState(raw);
    const cls = st.cls;
    const mapped = this.mapOf(st.valid, cls);
    this.snap = {
      available: true,
      frameIdx,
      tArriveMs,
      raw: raw & 0xff,
      valid: st.valid,
      class: cls,
      className: actionClassName(cls),
      conf: st.conf,
      mapped,
    };
    if (!st.valid) {
      this.prevValid = false;
      return;
    }
    // reason：上升沿优先（板侧 1.0 s 空窗清零后，每次动作都会重新拉高 VALID）；
    // 已在 1 电平时只有类别变化才算新的一次检测，conf 变化只是状态量。
    const reason: ActionEventReason | null = !this.prevValid
      ? "valid_rise"
      : this.prevClass !== null && this.prevClass !== cls
        ? "class_change"
        : null;
    this.prevValid = true;
    if (reason === null) {
      this.prevClass = cls;
      return;
    }
    this.prevClass = cls;
    this.count += 1;
    const ev: ActionEvent = {
      seq: this.nextSeq++,
      tMs: tArriveMs,
      frameIdx,
      raw: raw & 0xff,
      valid: true,
      class: cls,
      className: actionClassName(cls),
      conf: st.conf,
      mapped: this.mapOf(true, cls),
      reason,
    };
    this.lastEventSeq = ev.seq;
    this.events.push(ev);
    if (this.events.length > ACTION_EVENT_RING) {
      // 丢最旧的：seq 连续递增，消费者用 dropped 判断"我漏了多少"
      this.events.splice(0, this.events.length - ACTION_EVENT_RING);
    }
    this.wake();
  }

  /** 当前快照（null = 还没观察过 v3 动作字节；API 层据此给 available:false + reason） */
  getSnapshot(): ActionSnapshot | null {
    return this.snap;
  }

  /** 最近一条事件 seq（0 = 还没有事件）；任务书 /api/action 兼容镜像字段用，契约字段不受影响 */
  getLastEventSeq(): number {
    return this.lastEventSeq;
  }

  /** 累计检测次数（task-24；VALID 上升沿或类别变化各一次，只增不减直到 reset） */
  getCount(): number {
    return this.count;
  }

  /** 映射配置镜像（契约 §4.3：source=ui 表示前端至少推过一次 actionMap） */
  getConfigView(): { readonly source: "ui" | "default"; readonly updatedAtMs: number | null; readonly config: ActionConfig } {
    return {
      source: this.cfgSource,
      updatedAtMs: this.cfgSource === "ui" ? this.cfg.updatedAtMs : null,
      config: this.cfg,
    };
  }

  /**
   * 应用前端 WS config.set {actionMap}（契约 §4.3/§5.4）。
   * 校验失败抛错（IPC 层转 error 响应）—— 宁可让前端看到明确错误，也不静默改掉用户配置。
   * 通过后 source 变 "ui"；网关不落盘，进程重启回 default。
   */
  setConfig(raw: unknown, nowMs = Date.now()): ActionConfig {
    const cfg = normalizeActionConfig(raw, nowMs);
    this.cfg = cfg;
    this.cfgSource = "ui";
    // 已缓存的快照/事件的 mapped 要按新映射重算（否则改完映射 API 还显示旧动作）
    if (this.snap !== null) {
      this.snap = { ...this.snap, mapped: this.mapOf(this.snap.valid, this.snap.class) };
    }
    this.events = this.events.map((e) => ({ ...e, mapped: this.mapOf(e.valid, e.class) }));
    return cfg;
  }

  /** 当前是否已经有可执行映射（给测试/诊断用） */
  get hasSnapshot(): boolean {
    return this.snap !== null;
  }

  /** 事件总数（环外也计数；seq 就是它 +1，这里给测试断言用） */
  get totalEvents(): number {
    return this.nextSeq - 1;
  }

  /**
   * 长轮询（契约 §4.2）：
   *   · after=-1：立即返回当前最新 1 条；一条都没有就等到第一条出现或超时；
   *   · after>=0：返回 seq>after 的最多 32 条，按 seq 升序；没有就等；
   *   · after 早于环里最旧一条之前 ⇒ dropped = 最旧seq-1-after（消费者知道自己漏了）。
   */
  async waitEvents(after: number, timeoutMs: number): Promise<ActionEventsPage> {
    const immediate = this.buildPage(after);
    if (immediate.events.length > 0) return immediate;
    if (after < 0 && this.events.length > 0) {
      // after=-1：即便有事件也走 buildPage 的分支（上面已覆盖）；这里防御空环
      return this.buildPage(after);
    }
    if (timeoutMs <= 0) return { ...immediate, timedOut: true };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve();
      }, timeoutMs);
      this.waiters.push({ after, resolve, timer });
    });
    // 被唤醒或超时后重新取页：超时且仍为空 ⇒ timedOut
    const page = this.buildPage(after);
    return page.events.length > 0 ? page : { ...page, timedOut: true };
  }

  /** 清空（测试用；也用于未来"切换数据源＝动作快照失效"的扩展） */
  reset(): void {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.snap = null;
    this.events = [];
    this.nextSeq = 1;
    this.prevValid = false;
    this.prevClass = null;
    this.count = 0;
    this.cfg = DEFAULT_ACTION_CONFIG;
    this.cfgSource = "default";
  }

  private mapOf(valid: boolean, cls: number): ActionMapped | null {
    // 契约 §4.1：valid=false 或 class=3（保留）⇒ mapped=null；class0 的映射固定 none
    if (!valid || cls === 3) return null;
    const e = this.cfg.map[String(cls) as "0" | "1" | "2"];
    return e === undefined ? null : { action: e.action, target: e.target };
  }

  private buildPage(after: number): ActionEventsPage {
    const lastSeq = this.events.length === 0 ? 0 : (this.events[this.events.length - 1] as ActionEvent).seq;
    if (this.events.length === 0) return { events: [], lastSeq, dropped: 0, timedOut: false };
    const oldestSeq = (this.events[0] as ActionEvent).seq;
    const dropped = after >= 0 && after < oldestSeq - 1 ? oldestSeq - 1 - after : 0;
    let list: ActionEvent[];
    if (after < 0) {
      // after=-1：立即返回最新 1 条（契约 §4.2），不是"全部 32 条"
      list = [this.events[this.events.length - 1] as ActionEvent];
    } else {
      list = this.events.filter((e) => e.seq > after).slice(0, ACTION_EVENT_PAGE);
    }
    return { events: list, lastSeq, dropped, timedOut: false };
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) {
      clearTimeout(x.timer);
      x.resolve();
    }
  }
}

/**
 * 校验/补全 actionMap（契约 §5.4）。
 * 规则：v 必须 1；minConf 0..31；map 只接受 "0"/"1"/"2"（"3" 保留类不允许配置）；
 * 缺键补默认；"0" 的 action 必须是 none；action/target 必须在枚举内。
 * 不做"静默修正"：任何非法值直接抛错，错误信息带字段路径（前端能 toast 出来）。
 */
export function normalizeActionConfig(input: unknown, nowMs: number): ActionConfig {
  if (typeof input !== "object" || input === null) throw new Error("actionMap 必须是对象");
  const o = input as Record<string, unknown>;
  if (o["v"] !== 1) throw new Error("actionMap.v 必须是 1（收到 " + String(o["v"]) + "）");
  const minConfRaw = o["minConf"] ?? DEFAULT_ACTION_CONFIG.minConf;
  if (typeof minConfRaw !== "number" || !Number.isInteger(minConfRaw) || minConfRaw < 0 || minConfRaw > 31) {
    throw new Error("actionMap.minConf 必须是 0..31 的整数（收到 " + String(minConfRaw) + "）");
  }
  const rawMap = o["map"] ?? {};
  if (typeof rawMap !== "object" || rawMap === null || Array.isArray(rawMap)) throw new Error("actionMap.map 必须是对象");
  const m = rawMap as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    if (k !== "0" && k !== "1" && k !== "2") throw new Error("actionMap.map 含不允许的类别键: " + k + "（只接受 0/1/2）");
  }
  const map: Record<"0" | "1" | "2", ActionMapEntry> = { "0": DEFAULT_ACTION_CONFIG.map["0"], "1": DEFAULT_ACTION_CONFIG.map["1"], "2": DEFAULT_ACTION_CONFIG.map["2"] };
  for (const k of MAP_KEYS) {
    const e = m[k];
    if (e === undefined) continue;
    if (typeof e !== "object" || e === null) throw new Error("actionMap.map." + k + " 必须是 {action,target}");
    const entry = e as Record<string, unknown>;
    const action = entry["action"];
    if (typeof action !== "string" || !(ACTION_OPS as readonly string[]).includes(action)) {
      throw new Error("actionMap.map." + k + ".action 非法: " + String(action) + "（允许 " + ACTION_OPS.join("/") + "）");
    }
    const target = entry["target"];
    if (typeof target !== "string" || !(ACTION_TARGETS as readonly string[]).includes(target)) {
      throw new Error("actionMap.map." + k + ".target 非法: " + String(target) + "（允许 " + ACTION_TARGETS.join("/") + "）");
    }
    if (k === "0" && action !== "none") throw new Error("actionMap.map.0.action 必须是 none（无动作类不允许执行操作）");
    map[k] = { action: action as ActionOp, target: target as ActionTarget };
  }
  return {
    v: 1,
    updatedAtMs: nowMs,
    minConf: minConfRaw,
    map: Object.freeze({ "0": Object.freeze(map["0"]), "1": Object.freeze(map["1"]), "2": Object.freeze(map["2"]) }),
  };
}

/** 进程级单例：processor 观察、api 读快照、ws 写配置，三处必须是同一份（main.ts 也引用它） */
export const actionStore = new ActionStore();
