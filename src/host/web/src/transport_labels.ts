// 传输/串口状态 → 界面文案的**唯一映射**（与 v3labels.ts 同一规矩：文案集中一处，有单测钉着）。
//
// 为什么要单独一个模块：传输选择有"降级"这一档（仅串口 ⇒ MODE1 只原画不可用，WIRE-U1 §5.3），
// 以及"未检测到 v3 固件但遥测在流"这种半可用状态 —— 这些必须**如实**上屏，
// 不能在界面上把"降级"画成"正常"（那和"静默失败"是同一类错误）。
//
// 输入一律是 `unknown`（网关 JSON 透传）：字段缺/类型不对时返回"—"，绝不抛错炸界面。
import type { UartTelemFrame } from "@retina/protocol";

export type TransportMode = "udp" | "uart" | "auto";
export type TransportKind = "udp" | "uart";

export interface TransportDecisionView {
  readonly mode: TransportMode;
  readonly state: "idle" | "active" | "degraded" | "failed";
  readonly active: TransportKind | null;
  readonly secondary: TransportKind | null;
  readonly degraded: boolean;
  readonly reason: string;
  readonly failures: Readonly<Partial<Record<TransportKind, string>>>;
}

export interface DeframerView {
  readonly bytes: number;
  readonly v3Frames: number;
  readonly telemFrames: number;
  readonly telemCrcFail: number;
  readonly v3CrcFail: number;
  readonly badLen: number;
  readonly resyncs: number;
  readonly bytesDropped: number;
  readonly downlinkEcho: number;
  readonly textLines: number;
}

/** 十修：串口链路 1 Hz GET_STATUS 心跳的健康度（网关 live.ts 合并 V3Link 统计） */
export interface HeartbeatView {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly sent: number;
  readonly skippedInFlight: number;
  readonly skippedRecentDownlink: number;
  readonly lastAtMs: number | null;
  readonly ack: number;
  readonly fail: number;
  readonly lastAckAtMs: number | null;
  readonly lastRttMs: number | null;
}

export interface UartView {
  readonly path: string;
  readonly baudRate: number;
  readonly open: boolean;
  /** 累计收到的串口字节（B3：区分"通道打开了"与"通道真的有数据"） */
  readonly rxBytes: number;
  /** 最近 1 s 收到的字节速率（B/s，滑动窗口；0 = 当前无数据） */
  readonly rxBps: number;
  /** 距上次收到字节的毫秒数；null = 本次打开后从未收到任何字节 */
  readonly lastRxAgeMs: number | null;
  readonly handshakeOk: boolean;
  readonly handshakeDetail: string;
  readonly handshakeAttempts: number;
  readonly handshakeRttMs: number | null;
  readonly deframer: DeframerView | null;
  readonly telemetry: (UartTelemFrame & { atMs: number }) | null;
  /** S7：有效 v3 帧年龄 / 最近 10 s 窗口 / CRC 失败率（ADDITIVE，旧网关缺省） */
  readonly lastV3FrameAtMs?: number | null | undefined;
  readonly lastV3FrameAgeMs?: number | null | undefined;
  readonly noV3ForMs?: number | undefined;
  readonly crcFailTotal?: number | undefined;
  readonly v3CrcFailRate?: number | undefined;
  readonly recent10s?: { readonly v3Ok: number; readonly v3CrcFail: number; readonly total: number; readonly failRate: number } | undefined;
  /** 十修：心跳 RTT / 最近成功年龄 / ACK 计数（ADDITIVE，旧网关缺省） */
  readonly heartbeat?: HeartbeatView | undefined;
}

/** 通道健康看门狗（网关 live.ts refreshHealth，B4：当前通道 ≥3 s 无字节/包 ⇒ degraded） */
export interface HealthView {
  readonly state: "active" | "degraded";
  readonly channel: TransportKind;
  readonly noDataMs: number;
  readonly reason: string;
}

/** S8：串口无有效帧时网关的自动回退结果（前端必须原样上屏，不能只让用户看日志） */
export interface AutoFallbackView {
  readonly count: number;
  readonly atMs: number | null;
  readonly inFlight: boolean;
  readonly notice: string;
  readonly error: string;
}

/** B：open 时的串口档位扫描轨迹（网关 SerialBaudScanState 的宽容视图） */
export interface BaudScanView {
  readonly running: boolean;
  readonly tried: readonly number[];
  readonly hit: number | null;
}

/** B：最近一次切档结果（串口通道取 SerialTransport；UDP 主通道记录板端命令结果） */
export interface BaudSwitchView {
  readonly ok: boolean;
  readonly atMs: number | null;
  readonly error: string | null;
}

export interface TransportView {
  readonly decision: TransportDecisionView | null;
  readonly uart: UartView | null;
  readonly health: HealthView | null;
  readonly autoFallback: AutoFallbackView | null;
  /** B：主串口实际打开的档位（UDP 主通道时 null；串口卡片另有 uart.baudRate） */
  readonly baudRate?: number | null | undefined;
  /** B：板端 0x91 读回（null=旧位流/未上报） */
  readonly boardBaud?: number | null | undefined;
  /** B：用户偏好档位（启动参数/最近一次成功切档） */
  readonly preferredBaud?: number | undefined;
  readonly baudScan?: BaudScanView | undefined;
  readonly lastBaudSwitch?: BaudSwitchView | undefined;
  /**
   * A5：网关实际主数据面（ADDITIVE）。界面高亮/点击守卫只认它 ——
   * decision.mode 是**启动参数**（--udp / --serial / --transport auto），运行期切到串口后它仍是 "udp"。
   */
  readonly active?: TransportKind | null | undefined;
  /** A4：本次 adopt 后最近一次 FRAME_RAW 到达时刻（ms；null=还没收到） */
  readonly lastRawFrameAtMs?: number | null | undefined;
  /** A4：距最近原始帧（从未收到则从 adopt 起算）的时长（ms） */
  readonly rawRecoverMs?: number | null | undefined;
  /** A4：本次 adopt 后收到的原始帧数 */
  readonly rawFrames?: number | undefined;
  /**
   * P1-1：当前主通道**不应该**产出 FRAME_RAW（串口事件链路，或板端 EV_ONLY）。
   * 为 true 时不能拿 rawRecoverMs 报"板端掉档"—— 这条链路本来就没有 RAW。
   */
  readonly noRaw?: boolean | undefined;
}

const NA = "—";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown, fallback = NA): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 宽容解析网关的 transport 视图；完全不认识就返回 null（界面显示"—"而不是崩） */
export function parseTransportView(raw: unknown): TransportView | null {
  if (!isObj(raw)) return null;
  const d = isObj(raw["decision"]) ? raw["decision"] : null;
  const u = isObj(raw["uart"]) ? raw["uart"] : null;
  const decision: TransportDecisionView | null = d === null ? null : {
    mode: (d["mode"] === "udp" || d["mode"] === "uart" || d["mode"] === "auto" ? d["mode"] : "udp"),
    state: (d["state"] === "active" || d["state"] === "degraded" || d["state"] === "failed" || d["state"] === "idle" ? d["state"] : "idle"),
    active: d["active"] === "udp" || d["active"] === "uart" ? d["active"] : null,
    secondary: d["secondary"] === "udp" || d["secondary"] === "uart" ? d["secondary"] : null,
    degraded: d["degraded"] === true,
    reason: str(d["reason"]),
    failures: isObj(d["failures"])
      ? {
          ...(typeof d["failures"]["udp"] === "string" ? { udp: d["failures"]["udp"] } : {}),
          ...(typeof d["failures"]["uart"] === "string" ? { uart: d["failures"]["uart"] } : {}),
        }
      : {},
  };
  const rawDeframer = u !== null && isObj(u["deframer"]) ? u["deframer"] : null;
  const rawHb = u !== null && isObj(u["heartbeat"]) ? u["heartbeat"] : null;
  const uart: UartView | null = u === null ? null : {
    path: str(u["path"], "?"),
    baudRate: num(u["baudRate"], 115200),
    open: u["open"] === true,
    handshakeOk: u["handshakeOk"] === true,
    handshakeDetail: str(u["handshakeDetail"], NA),
    handshakeAttempts: num(u["handshakeAttempts"]),
    handshakeRttMs: typeof u["handshakeRttMs"] === "number" ? u["handshakeRttMs"] : null,
    rxBytes: num(u["rxBytes"]),
    rxBps: num(u["rxBps"]),
    lastRxAgeMs: typeof u["lastRxAgeMs"] === "number" ? u["lastRxAgeMs"] : null,
    deframer: isObj(u["deframer"])
      ? {
          bytes: num(u["deframer"]["bytes"]),
          v3Frames: num(u["deframer"]["v3Frames"]),
          telemFrames: num(u["deframer"]["telemFrames"]),
          telemCrcFail: num(u["deframer"]["telemCrcFail"]),
          v3CrcFail: num(u["deframer"]["v3CrcFail"]),
          badLen: num(u["deframer"]["badLen"]),
          resyncs: num(u["deframer"]["resyncs"]),
          bytesDropped: num(u["deframer"]["bytesDropped"]),
          downlinkEcho: num(u["deframer"]["downlinkEcho"]),
          textLines: num(u["deframer"]["textLines"]),
        }
      : null,
    telemetry: isObj(u["telemetry"]) ? (u["telemetry"] as unknown as UartTelemFrame & { atMs: number }) : null,
    heartbeat: rawHb === null ? undefined : {
      enabled: rawHb["enabled"] === true,
      intervalMs: num(rawHb["intervalMs"], 1000),
      sent: num(rawHb["sent"]),
      skippedInFlight: num(rawHb["skippedInFlight"]),
      skippedRecentDownlink: num(rawHb["skippedRecentDownlink"]),
      lastAtMs: typeof rawHb["lastAtMs"] === "number" ? rawHb["lastAtMs"] : null,
      ack: num(rawHb["ack"]),
      fail: num(rawHb["fail"]),
      lastAckAtMs: typeof rawHb["lastAckAtMs"] === "number" ? rawHb["lastAckAtMs"] : null,
      lastRttMs: typeof rawHb["lastRttMs"] === "number" ? rawHb["lastRttMs"] : null,
    },
    lastV3FrameAtMs: typeof u["lastV3FrameAtMs"] === "number" ? u["lastV3FrameAtMs"] : null,
    lastV3FrameAgeMs: typeof u["lastV3FrameAgeMs"] === "number" ? u["lastV3FrameAgeMs"] : null,
    noV3ForMs: num(u["noV3ForMs"]),
    crcFailTotal: num(u["crcFailTotal"], num(rawDeframer?.["v3CrcFail"]) + num(rawDeframer?.["telemCrcFail"])),
    v3CrcFailRate: typeof u["v3CrcFailRate"] === "number" ? u["v3CrcFailRate"] : 0,
    recent10s: isObj(u["recent10s"])
      ? {
          v3Ok: num(u["recent10s"]["v3Ok"]),
          v3CrcFail: num(u["recent10s"]["v3CrcFail"]),
          total: num(u["recent10s"]["total"]),
          failRate: num(u["recent10s"]["failRate"]),
        }
      : undefined,
  };
  const h = isObj(raw["health"]) ? raw["health"] : null;
  const health: HealthView | null = h === null ? null : {
    state: h["state"] === "degraded" ? "degraded" : "active",
    channel: h["channel"] === "udp" || h["channel"] === "uart" ? h["channel"] : "udp",
    noDataMs: num(h["noDataMs"]),
    reason: str(h["reason"]),
  };
  const af = isObj(raw["autoFallback"]) ? raw["autoFallback"] : null;
  const autoFallback: AutoFallbackView | null = af === null ? null : {
    count: num(af["count"]),
    atMs: typeof af["atMs"] === "number" ? af["atMs"] : null,
    inFlight: af["inFlight"] === true,
    notice: typeof af["notice"] === "string" ? af["notice"] : "",
    error: typeof af["error"] === "string" ? af["error"] : "",
  };
  const active = raw["active"] === "udp" || raw["active"] === "uart"
    ? raw["active"]
    : (decision?.active ?? null);
  const scan = isObj(raw["baudScan"]) ? raw["baudScan"] : null;
  const sw = isObj(raw["lastBaudSwitch"]) ? raw["lastBaudSwitch"] : null;
  return {
    decision,
    uart,
    health,
    autoFallback,
    baudRate: typeof raw["baudRate"] === "number" ? raw["baudRate"] : null,
    boardBaud: typeof raw["boardBaud"] === "number" ? raw["boardBaud"] : null,
    preferredBaud: typeof raw["preferredBaud"] === "number" ? raw["preferredBaud"] : undefined,
    baudScan: scan === null ? undefined : {
      running: scan["running"] === true,
      tried: Array.isArray(scan["tried"]) ? scan["tried"].filter((x): x is number => typeof x === "number") : [],
      hit: typeof scan["hit"] === "number" ? scan["hit"] : null,
    },
    lastBaudSwitch: sw === null ? undefined : {
      ok: sw["ok"] === true,
      atMs: typeof sw["atMs"] === "number" ? sw["atMs"] : null,
      error: typeof sw["error"] === "string" ? sw["error"] : null,
    },
    active,
    lastRawFrameAtMs: typeof raw["lastRawFrameAtMs"] === "number" ? raw["lastRawFrameAtMs"] : null,
    rawRecoverMs: typeof raw["rawRecoverMs"] === "number" ? raw["rawRecoverMs"] : null,
    rawFrames: num(raw["rawFrames"]),
    noRaw: raw["noRaw"] === true,
  };
}

const MODE_LABEL: Record<TransportMode, string> = { udp: "网口", uart: "串口", auto: "自动" };

/** B4：串口波特率 4 档（契约 §1.1）。UI 与文案共用这一份，禁止各处再抄字面量。 */
export const BAUD_CHOICES = [115200, 230400, 460800, 921600] as const;

/**
 * B4：波特率 chip 的"待应用"选择状态。现场 STATS 是 1 Hz，如果每帧都把 chip 拽回实际档，
 * 用户点完 chip 还没点「应用」就被下一帧改回去 —— 看起来就是"选了不生效"。
 * 规则：用户 pin 住后保持；只有实际档变化（切档成功/被外部改）或网口下首选档变化才跟随。
 */
export interface BaudChoiceState {
  readonly choice: number;
  readonly pinned: boolean;
  readonly lastActual: number | null | undefined;
  readonly lastPreferred: number;
}

export function initialBaudChoice(): BaudChoiceState {
  return { choice: BAUD_CHOICES[0], pinned: false, lastActual: undefined, lastPreferred: -1 };
}

/** 用户点 chip：只改"待应用"，不切档。 */
export function pinBaudChoice(state: BaudChoiceState, baud: number): BaudChoiceState {
  return { ...state, choice: baud, pinned: true };
}

/** 每次状态刷新调用；busy 期间冻结（切档中不能让 1 Hz STATS 改掉用户选择）。 */
export function updateBaudChoice(
  state: BaudChoiceState,
  actualBaud: number | null,
  preferredBaud: number,
  busy: boolean,
): BaudChoiceState {
  if (busy) return state;
  const current = actualBaud ?? preferredBaud;
  const changed = state.lastActual === undefined || actualBaud !== state.lastActual ||
    (actualBaud === null && preferredBaud !== state.lastPreferred);
  let choice = state.choice;
  let pinned = state.pinned;
  if (!pinned || changed) {
    if ((BAUD_CHOICES as readonly number[]).includes(current)) choice = current;
    pinned = false;
  }
  return { choice, pinned, lastActual: actualBaud, lastPreferred: preferredBaud };
}

/**
 * A4：切到网口后 3 s 仍没有 FRAME_RAW 的醒目提示。
 * 为什么必须提示：UDP "绑定成功但 0 包/0 原始帧"是现场最常见的假成功（板端还在串口档、
 * 端口被旧进程先绑定、板端没发流），只留一个空画面用户会以为上位机坏了。
 */
/**
 * A1：传输 chip 是否高亮。只认网关的**实际主通道** active（statusView 顶层优先），
 * 绝不拿 decision.mode（启动参数）冒充 —— 现场 bug 就是 --udp 启动后切到串口，mode 仍是 udp。
 * "自动"不是物理通道：仅在没有主通道且启动模式为 auto 时保持高亮。
 */
export function transportChipSelected(
  mode: TransportMode,
  active: TransportKind | null,
  startupMode: TransportMode | undefined,
): boolean {
  if (mode === "auto") return active === null && startupMode === "auto";
  return active === mode;
}

/** A2：点击当前实际 active 的物理通道 = 强制重建（不是"已经是该档"的空操作）。auto 永远走 switchAuto。 */
export function transportClickForce(mode: TransportMode, active: TransportKind | null): boolean {
  return mode !== "auto" && active === mode;
}

export function rawRecoverText(v: TransportView | null): string | null {
  if (v === null || v.active !== "udp") return null;
  // P1-1：EV_ONLY 板端/串口事件链路上没有 RAW 是设计如此，报"3 s 没原始帧"是纯误报。
  if (v.noRaw === true) return null;
  const ms = v.rawRecoverMs;
  if (typeof ms !== "number" || ms < 3000) return null;
  return "切到网口 " + (ms / 1000).toFixed(1) + " s 仍无原始帧（FRAME_RAW）—— 板端可能仍在串口档/未发流";
}
const KIND_LABEL: Record<TransportKind, string> = { udp: "网口(UDP)", uart: "串口(UART)" };

/** 选择结论一句话（主通道 + 能力）。failed 时必须把原因带出来 */
export function decisionText(v: TransportView | null): string {
  if (v === null || v.decision === null) return NA;
  const d = v.decision;
  if (d.state === "failed" || d.active === null) return "无可用通道：" + d.reason;
  const main = KIND_LABEL[d.active];
  const extra = d.secondary !== null ? " + " + KIND_LABEL[d.secondary] + "（第二观察）" : "";
  // 通道健康看门狗是"降级"的第二种来源（与"仅串口 ⇒ 只事件回传"不同）：必须分开写清楚，
  // 否则现场看到"降级"会去查 MODE1，实际上是网线掉了/串口没数据。
  const noData = v.health?.state === "degraded" ? " · 通道无数据" : "";
  return main + extra + (d.degraded ? "（降级：仅事件回传）" : "") + noData;
}

/** 能力说明（设计 §5.3：网口在 = 三模式全可选；仅串口 = MODE1 只原画不可用） */
export function capabilityText(v: TransportView | null): string {
  if (v === null || v.decision === null) return NA;
  return v.decision.degraded
    ? "仅事件回传：MODE1（只原画）不可用（115200 下原画需 66.7 s/帧，WIRE-U1 §5.3）；串口命令 EV_EN/SET_PARAM/EV_RES 可下发"
    : "网口可用：MODE0/MODE1/MODE2 三模式全可选";
}

/** 字节速率可读化：B/s → "1.2 KB/s" */
function fmtRate(bps: number): string {
  if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
  return Math.round(bps) + " B/s";
}

/**
 * 串口通道三态（B6）。三态必须字面区分，这是现场排查的第一分界线：
 *   ① 未启用串口通道 —— 当前走网口/没有串口对象（uart=null）
 *   ② 串口已打开但无 v3 握手 —— COM 开了、板端 UART_LINK_EN=0 或线/波特率不对（**现场就是这个状态**）
 *   ③ 串口已打开且握手 OK —— 真正能收发 v3
 */
export function uartStatusText(v: TransportView | null): string {
  if (v === null || v.uart === null) return "未启用串口通道";
  const u = v.uart;
  if (!u.open) return u.path + " @" + u.baudRate + " 8N1 · 串口已关闭（未打开）";
  if (!u.handshakeOk) return u.path + " @" + u.baudRate + " 8N1 · 串口已打开但无 v3 握手（v3 通道不可用）";
  return u.path + " @" + u.baudRate + " 8N1 · 串口已打开且 v3 握手 OK" +
    (u.handshakeRttMs === null ? "" : "(RTT " + u.handshakeRttMs + " ms)");
}

/**
 * 串口 rx 实测速率（B3）：把"通道有没有数据"变成一眼可见的数字。
 * 现场事实（2026-10-17，COM6，UART_LINK_EN=0 位流）：打开成功、握手 3 次无 ACK、rx 0 B/s。
 */
export function uartRxText(v: TransportView | null): string {
  if (v === null || v.uart === null) return "串口收发：—（未启用串口通道）";
  const u = v.uart;
  if (!u.open) return "串口收发：—（串口未打开）";
  const age = u.lastRxAgeMs === null ? "从未收到字节" : "最近收包 " + (u.lastRxAgeMs / 1000).toFixed(1) + " s 前";
  return "串口收发：" + fmtRate(u.rxBps) + " · 累计 " + u.rxBytes + " B · " + age;
}

/** 通道健康看门狗文案（B4）：degraded 时把网关给的原因原样上屏 */
export function healthText(v: TransportView | null): string {
  if (v === null || v.health === null) return "通道健康：—";
  const h = v.health;
  if (h.state !== "degraded") return "通道健康：" + KIND_LABEL[h.channel] + " 有数据";
  return "通道健康：⚠ " + (h.reason === NA ? KIND_LABEL[h.channel] + " 已 " + (h.noDataMs / 1000).toFixed(1) + " s 无数据" : h.reason);
}

/** 握手失败时的可执行提示（照抄网关的 detail，不自己编原因） */
export function handshakeText(v: TransportView | null): string {
  if (v === null || v.uart === null) return NA;
  return v.uart.handshakeOk
    ? "v3 固件在线（GET_STATUS ACK，第 " + v.uart.handshakeAttempts + " 次尝试）"
    : v.uart.handshakeDetail;
}

/**
 * S7：串口链路有效性一行话 —— 有效 v3 帧数 / CRC 失败数（最近 10 s 窗口）/ 最后成功帧年龄。
 * 故障时绝不允许只画"黑屏 + 0 ev/s"：这行就是用户判断"线坏了 / 帧坏了 / 板子没发"的第一现场。
 */
export function crcHealthText(v: TransportView | null): string {
  const u = v?.uart;
  if (u === null || u === undefined) return "链路：—（未启用串口通道）";
  const d = u.deframer;
  const ok = d?.v3Frames ?? 0;
  const recent = u.recent10s;
  const recentPart = recent !== undefined && recent.total > 0
    ? " · 最近 10s " + recent.v3CrcFail + "/" + recent.total + " 失败（" + (recent.failRate * 100).toFixed(1) + "%）"
    : "";
  const agePart = u.lastV3FrameAgeMs === null || u.lastV3FrameAgeMs === undefined
    ? " · 最后成功帧：从未"
    : " · 最后成功帧 " + (u.lastV3FrameAgeMs / 1000).toFixed(1) + " s 前";
  const crc = u.crcFailTotal ?? ((d?.v3CrcFail ?? 0) + (d?.telemCrcFail ?? 0));
  return "链路：v3 有效 " + ok + " 帧 · CRC 失败 " + crc + recentPart + agePart;
}

/**
 * B：波特率一行 —— 主机实际档位 / 板端 0x91 读回 / 用户偏好 + open 扫描轨迹 + 最近一次切档结果。
 * 必须把"板端未上报（旧位流）"写成字面，否则用户会以为下拉选了 921600 就已经提速。
 */
export function baudStateText(v: TransportView | null): string {
  if (v === null) return "波特率：—（当前不是实时源）";
  // 新网关显式给 baudRate（UDP 主通道 = null）；旧网关缺字段时才退到串口卡
  const actual = v.baudRate !== undefined ? v.baudRate : (v.uart?.baudRate ?? null);
  const pref = v.preferredBaud ?? actual ?? 115200;
  const board = v.boardBaud ?? null;
  const parts: string[] = [];
  parts.push(actual === null ? "主机串口未打开" : "实际 " + actual + " baud");
  parts.push(board === null ? "板端未上报（旧位流，仍 115200）" : "板端读回 " + board + " baud");
  if (pref !== actual && pref !== board) parts.push("偏好 " + pref + " baud");
  const scan = v.baudScan;
  if (scan !== undefined && scan.tried.length > 0) {
    parts.push("扫描 " + scan.tried.join("→") + (scan.hit === null ? "（未命中）" : "（命中 " + scan.hit + "）"));
  }
  const sw = v.lastBaudSwitch;
  if (sw !== undefined && sw.error !== null && sw.error !== "") {
    parts.push("上次切档失败：" + sw.error);
  } else if (sw !== undefined && sw.ok) {
    parts.push("上次切档成功");
  }
  return "波特率：" + parts.join(" · ");
}

/**
 * 十修：心跳健康度一行 —— RTT / 最近成功心跳年龄 / 已发与 ACK 计数。
 * 传 nowMs 是为了单测确定性；页面默认取当前墙钟。
 */
export function heartbeatText(v: TransportView | null, nowMs: number = Date.now()): string {
  const hb = v?.uart?.heartbeat;
  if (hb === undefined) return "心跳：—";
  if (!hb.enabled) return "心跳：未启用";
  const rtt = hb.lastRttMs === null ? "RTT —" : "RTT " + Math.round(hb.lastRttMs) + " ms";
  const age = hb.lastAckAtMs === null
    ? "尚无成功心跳"
    : "最近成功心跳 " + (Math.max(0, nowMs - hb.lastAckAtMs) / 1000).toFixed(1) + " s 前";
  const counts = "已发 " + hb.sent + " / ACK " + hb.ack + (hb.fail > 0 ? "（失败 " + hb.fail + "）" : "");
  return "心跳：" + rtt + " · " + age + " · " + counts;
}

/** 传输卡"链路"一行：CRC/有效帧 + 心跳（有 heartbeat 字段时才追加，兼容旧网关） */
export function linkHealthText(v: TransportView | null, nowMs: number = Date.now()): string {
  const base = crcHealthText(v);
  return v?.uart?.heartbeat === undefined ? base : base + " · " + heartbeatText(v, nowMs);
}

/** 定帧健康度（重同步/CRC 失败必须上屏，否则串口"看起来没数据"时无从排查） */
export function deframerText(v: TransportView | null): string {
  const d = v?.uart?.deframer ?? null;
  if (d === null) return NA;
  return "v3帧 " + d.v3Frames + " · 遥测 " + d.telemFrames + " · CRC错 " + (d.v3CrcFail + d.telemCrcFail) +
    " · 重同步 " + d.resyncs + " · 丢 " + d.bytesDropped + " B";
}

/** 遥测帧直读（帧型 A：ev/act/cr 三项是设计 §8.2 H7 点名要上屏的） */
export function telemetryText(t: UartTelemFrame | null): string {
  if (t === null) return NA;
  const cr = t.crSaturated ? "饱和(无事件)" : t.cr.toFixed(1) + "×";
  return "fr=" + t.frameCnt + " ev=" + t.evPerFrame + " act=" + t.activity.toFixed(2) +
    " cr=" + cr + " mode=" + t.mode + " key=" + t.key + " en=" + t.evEn;
}

/** MODE 选择被禁用时的理由（仅串口档时 MODE1 必须灰掉并说明） */
export function modeDisabledReason(v: TransportView | null, mode: number): string | null {
  if (v === null || v.decision === null) return null;
  if (mode === 1 && v.decision.degraded) return "仅串口档不可用：115200 下原画 768,000 B/帧需 66.7 s/帧（WIRE-U1 §5.3）";
  return null;
}

/** 传输模式选项（UI 单选；与网关 TransportMode 逐值一致） */
export const TRANSPORT_MODES: readonly { readonly v: TransportMode; readonly label: string; readonly note: string }[] = [
  { v: "auto", label: "自动", note: "先网口后串口：网口在=三模式全可选，否则降级为仅事件回传（设计 §5.3）" },
  { v: "udp", label: "网口", note: "只用 UDP（板端 v3 网口路线）" },
  { v: "uart", label: "串口", note: "只用串口（COM6 @115200 8N1，事件回传 + 命令/校准）" },
];

export { MODE_LABEL };
