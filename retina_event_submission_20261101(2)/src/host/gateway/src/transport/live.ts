// 实时数据面的组装与**运行时切换**：UDP / UART / 自动（WIRE-U1 §1.3、§5.3、§8.2 H1/H4）。
//
// 一个 session = 一条数据通道（源 + 下行 sink + V3Link + 校准节拍器）：
//   · UDP   ：UdpTransport（收）+ DownlinkSocket（发 → 板端 1235）
//   · UART  ：SerialTransport（收 + 发同一根线；命令/校准 over 串口零分叉复用 V3Link）
// 为什么要做成"sessions 可换"而不是各写一份：V3Link（SEQ/ACK/600 s 校准节流/TLV 状态）是传输无关的，
// 只有 sink 与 source 随通道变 —— 这正是设计 §1.2 原则 3"传输无关的下行命令"的落地形态。
import type { IFrameSource, ParsedV3, Profile, UartTelemFrame } from "@retina/protocol";
import { createCounters, MODE3, serialBaudCode, SERIAL_BAUD_RATES } from "@retina/protocol";
import type { Counters } from "@retina/protocol";
import { DownlinkSocket } from "./downlink.ts";
import { UdpTransport } from "./udp.ts";
import type { UdpOptions } from "./udp.ts";
import {
  DEFAULT_SERIAL_PATH,
  SERIAL_BAUD,
  SerialOpenError,
  SerialTransport,
} from "./serial.ts";
import type {
  SerialBaudScanState,
  SerialBaudSwitchState,
  SerialHandshakeResult,
  SerialOptions,
  SerialPortFactory,
} from "./serial.ts";
import { TransportSelector } from "./select.ts";
import type { TransportDecision, TransportKind, TransportMode } from "./select.ts";
import { V3Link } from "../pipeline/v3link.ts";
import os from "node:os";

/** 通道健康：当前主通道连续多久没有字节/包 ⇒ 前端 1 Hz STATS 能看到"通道 X 已 N s 无数据" */
export const CHANNEL_NO_DATA_MS = 3000;
/** UDP 绑定确认等待（ms；EADDRINUSE 这类错误是异步 socket error，必须等一拍才能判） */
const UDP_BIND_WAIT_MS = 800;
/** EADDRINUSE 自动重试间隔（ms；只重试 1 次） */
const UDP_BIND_RETRY_MS = 200;
/**
 * "端口被占用"类错误。Windows 上 Node/uv 报的是 bind EACCES（个别 libuv 版本报 errno -4091/EBUSY），
 * 只匹配 EADDRINUSE 会静默跳过自动重试（R1 复查实测）。导出便于单测对齐同一判据。
 */
export const UDP_BIND_BUSY_RE = /(EADDRINUSE|EACCES|EBUSY|errno\s*-4091)/i;

/**
 * 「绑定地址不是本机地址」的稳定机读标记（task-1 判据；启动器预检共用同一字面量）。
 * 单独导出而不是内联字符串：网关告警、启动器预检、单测三处对齐同一个字面量，避免漂移。
 */
export const BIND_ADDR_NOT_LOCAL = "BIND_ADDR_NOT_LOCAL";

/** os.networkInterfaces() 的最小结构（单测注入假网卡，不依赖真机网卡） */
export type NetworkInterfacesLike = Record<
  string,
  readonly { readonly address: string; readonly family: string | number; readonly internal: boolean }[] | undefined
>;

/** 是否 IPv4 点分字面量（不做网络查询） */
export function isIpv4Literal(addr: string): boolean {
  const parts = addr.trim().split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 回环地址（127.0.0.0/8、localhost、IPv6 ::1）：永远属于本机 */
export function isLoopbackAddr(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === "localhost" || a === "::1" || a.startsWith("127.");
}

/** 本机全部 IPv4（含回环；按网卡展开） */
export function localIpv4Addresses(ifaces: NetworkInterfacesLike = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" || info.family === 4) out.push(info.address);
    }
  }
  return out;
}

/** RFC1918 私有地址（192.168/16、10/8、172.16-31/12）：板卡链路一定是私有网段 */
export function isPrivateIpv4(addr: string): boolean {
  const p = addr.trim().split(".");
  if (p.length !== 4) return false;
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** CGNAT 100.64.0.0/10（Tailscale 等虚拟组网用的地址段）：不是"接板卡"的地址 */
export function isCgnatIpv4(addr: string): boolean {
  const p = addr.trim().split(".");
  if (p.length !== 4) return false;
  const a = Number(p[0]);
  const b = Number(p[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/** 链路本地 169.254/16（DHCP 失败自配地址）：不是"接板卡"的地址 */
export function isLinkLocalIpv4(addr: string): boolean {
  return addr.trim().startsWith("169.254.");
}

/** 虚拟/隧道/无线网卡的名字特征（与 tools/launch.mjs 的 VIRTUAL_NIC_RE 同一口径） */
const NIC_VIRTUAL_RE = /tailscale|vethernet|vmware|hyper-v|virtualbox|loopback|bluetooth|wsl|docker|无线|wi-?fi|wlan/i;
/** 有线以太网卡的名字特征（板卡走网线，优先建议它） */
const NIC_WIRED_RE = /以太网|ethernet|本地连接|lan/i;

/** preferredBindAddress 的候选：地址 + 网卡名 + 打分（分高者优先） */
export interface BindSuggestion {
  readonly address: string;
  readonly name: string;
  readonly score: number;
}

/**
 * 从本机网卡里挑"最该拿去接板卡"的 IPv4 —— 与 tools/launch.mjs 的 pickPreferredIface 同一打分口径
 * （单测用同一份假网卡清单强制两边给出同一个首选地址）：
 *   +8 RFC1918 私有网段；+4 有线网卡（板卡走网线）；
 *   排除 回环 / internal / 169.254 链路本地 / 100.64-127 CGNAT(Tailscale) / 名字像虚拟·隧道·无线
 *   （vEthernet、VMnet、WLAN、Docker、WSL…）。
 * 排序 score 降序 → 地址字符串升序：结果与网卡枚举顺序无关，换机器也不会漂。
 */
export function preferredBindAddress(ifaces: NetworkInterfacesLike = os.networkInterfaces()): BindSuggestion | null {
  const cands: BindSuggestion[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (!(info.family === "IPv4" || info.family === 4)) continue;
      if (info.internal || isLoopbackAddr(info.address)) continue;
      if (NIC_VIRTUAL_RE.test(name)) continue;
      if (!isIpv4Literal(info.address)) continue;
      if (isLinkLocalIpv4(info.address) || isCgnatIpv4(info.address)) continue;
      let score = 0;
      if (isPrivateIpv4(info.address)) score += 8;
      if (NIC_WIRED_RE.test(name)) score += 4;
      cands.push({ address: info.address, name, score });
    }
  }
  cands.sort((x, y) => y.score - x.score || x.address.localeCompare(y.address) || x.name.localeCompare(y.name));
  return cands[0] ?? null;
}

/** bind 地址是否可绑定：空/通配 = 内核选本机地址；回环任意；否则必须是本机某块网卡的 IPv4 */
export function isLocalBindAddress(addr: string, ifaces: NetworkInterfacesLike = os.networkInterfaces()): boolean {
  const a = addr.trim();
  if (a === "" || a === "0.0.0.0" || a === "::") return true;
  if (isLoopbackAddr(a)) return true;
  return localIpv4Addresses(ifaces).includes(a);
}

/** 从 socket 错误文本里取真实错误码（EADDRNOTAVAIL / EACCES / errno -4091 …），取不到返回 null */
export function socketErrorCodeOf(message: string): string | null {
  const code = /\b(E[A-Z]{3,}|UV_[A-Z_]+)\b/.exec(message);
  if (code !== null) return code[1] ?? null;
  const errno = /\berrno\s*(-?\d+)/i.exec(message);
  return errno === null ? null : "errno " + errno[1];
}

/**
 * 真实 socket 错误文本是否属于「地址不属于本机」：
 * Windows/Node 报 EADDRNOTAVAIL（部分 libuv 版本 WSAEADDRNOTAVAIL），Linux 还会报 Cannot assign requested address。
 */
export function isNotLocalBindFailure(message: string): boolean {
  return /(EADDRNOTAVAIL|WSAEADDRNOTAVAIL|NOTLOCAL|Cannot assign requested address)/i.test(message);
}

/** 单行、可执行文案：带机读标记 + 真实 socket 码/原文 + 本机 IPv4 清单 + 三条修复 */
export function formatBindAddrNotLocal(
  addr: string,
  port: number,
  socketCode: string | null,
  rawMessage: string,
  ifaces: NetworkInterfacesLike = os.networkInterfaces(),
): string {
  const locals = localIpv4Addresses(ifaces);
  const localText = locals.length === 0 ? "（未探测到任何 IPv4 网卡）" : locals.join("、");
  // 建议地址与启动器 pickPreferredIface 同口径：优先有线私有网段，排除 Tailscale/VMnet/WLAN 之类
  const preferred = preferredBindAddress(ifaces);
  const suggestion = preferred !== null
    ? preferred.address
    : (locals.find((a) => !isLoopbackAddr(a)) ?? locals[0] ?? "127.0.0.1");
  return BIND_ADDR_NOT_LOCAL +
    "：UDP 绑定地址 " + addr + ":" + port + " 不是本机地址" +
    (socketCode === null ? "" : "（socket_code=" + socketCode + "）") +
    "；socket 原始错误：" + rawMessage +
    "；本机 IPv4：" + localText +
    "；修复：① 直接用本机地址重启（--bind " + suggestion + " --port " + port + "），并同步把板端 PC_IP 改成该地址；" +
    "② 或把该地址配到网卡：netsh interface ipv4 set address name=\"以太网\" static " + addr + " 255.255.255.0（网卡名换成实际网卡）；" +
    "③ 或把网线换到已配置该地址的网卡。";
}

/**
 * ref 版 sleep：等待 bind 结果期间必须让事件循环保活。
 * 默认 sleep 原用 unrefTimer（探测不该拖住进程退出），但异步 socket error 投递后若无 ref 句柄，
 * Node 会以退出码 0 静默退出、外层 await 永不 settle —— 现场"零输出 exit 0"即此（task-1 根因）。
 */
export function sleepRef(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}


/** UDP 源的最小接口（测试可注入假源；真实现 = UdpTransport） */
export interface UdpLike extends IFrameSource {
  readonly rxPackets: number;
  readonly running: boolean;
  /** P1-1：与 BaseFrameSource 对齐（UDP 能产 RAW；假源可不声明） */
  readonly rawCapable?: boolean;
  setTsOffsetUs(offsetUs: number | null): void;
}

export interface LiveTransportOptions {
  readonly profile: Profile;
  readonly mode: TransportMode;
  readonly bind?: string | null | undefined;
  readonly port?: number | null | undefined;
  /** 内核接收缓冲（字节；缺省见 UdpTransport 的说明 —— 2026-10-12 起默认 16 MB） */
  readonly recvBufferSize?: number | undefined;
  readonly serialPath?: string | undefined;
  readonly serialBaud?: number | undefined;
  /** 九修：串口链路心跳间隔（ms，缺省 1000；0=关闭）。ACK 是合法 v3 帧，可维持链路有效性。 */
  readonly serialHeartbeatMs?: number | undefined;
  /** auto 模式等 UDP 首包的时长（ms，缺省 1500） */
  readonly udpProbeMs?: number | undefined;
  readonly handshakeEnabled?: boolean | undefined;
  readonly handshake?: SerialOptions["handshake"];
  /** 注入串口工厂（测试用） */
  readonly serialFactory?: SerialPortFactory | undefined;
  /** 注入 UDP 工厂（测试用） */
  readonly udpFactory?: ((opts: UdpOptions) => UdpLike) | undefined;
  /** 源切换出口（main.ts 接 hub.switchSource） */
  readonly onSourceChange?: ((source: IFrameSource) => void) | undefined;
  /** 每建好一条 session 的 V3Link 就回调一次（main.ts 用它挂 onCtrlEvent → TYPE_CTRL 推流） */
  readonly onV3Link?: ((link: V3Link) => void) | undefined;
  /** 遥测帧出口（帧型 A 直读 ev/act/cr） */
  readonly onTelemetry?: ((t: UartTelemFrame, raw: Uint8Array, atMs: number) => void) | undefined;
  readonly onText?: ((line: string) => void) | undefined;
  readonly log?: ((msg: string) => void) | undefined;
  /** 定时器工厂（测试注入；缺省 setTimeout） */
  readonly setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((t: unknown) => void) | undefined;
  /** 探测/等待用的 sleep（测试注入） */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** 绑定状态（B5：UDP 端口被占时给精确原因 + 自动重试一次，而不是"切换成功但收 0 包"） */
export interface BindState {
  bound: boolean;
  bindError: string | null;
  /** 失败时从 socket 错误文本里提取的真实错误码（EADDRNOTAVAIL / EACCES …）；供 NOTLOCAL 判定与文案 */
  bindErrorCode: string | null;
}

/** 通道健康视图（前端传输卡显示；degraded 时 decision.state 也被叠加为 degraded） */
export interface ChannelHealthView {
  readonly state: "active" | "degraded";
  readonly channel: TransportKind;
  readonly noDataMs: number;
  readonly reason: string;
}

interface Session {
  readonly kind: TransportKind;
  readonly source: UdpLike | SerialTransport;
  readonly bind: BindState;
  readonly v3link: V3Link;
  readonly downlink: DownlinkSocket | null;
  readonly counters: Counters;
  readonly handshake: SerialHandshakeResult | null;
  /** 探测得到的"可用性说明"（UI 上屏） */
  detail: string;
  /** 该 session 是否是"第二观察通道"（未接到 hub 的源） */
  observer: boolean;
  /** A4：是否已挂过原始帧监听（adopt 可能重复调用，不能重复订阅） */
  rawWatched?: boolean;
}

export class NoTransportError extends Error {
  readonly decision: TransportDecision;
  constructor(decision: TransportDecision) {
    super("没有可用的数据通道：" + decision.reason + "（--udp 走网口 / --serial COM6 走串口 / --transport auto 自动择一）");
    this.name = "NoTransportError";
    this.decision = decision;
  }
}

export class LiveTransportManager {
  readonly selector: TransportSelector;
  private readonly opts: LiveTransportOptions;
  private readonly log: (msg: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private primary: Session | null = null;
  /** 网口在 + 串口可用时的第二观察通道（只做遥测/CTRL，不接 hub 的画面通路） */
  private observer: Session | null = null;
  private closed = false;
  private readonly decisions = new Map<TransportKind, { ok: boolean; detail: string }>();
  /** 通道健康看门狗状态（不用定时器：STATS 1 Hz 会调 statusView，采样即判定） */
  private health: { kind: TransportKind; lastActivityMs: number; lastMark: number; degraded: boolean } | null = null;
  /** S8：串口"字节在涨但没有有效 v3 帧"自动回网口（每次串口会话最多一次；10 s 冷却） */
  private autoFallbackInFlight = false;
  private autoFallbackCount = 0;
  private lastAutoFallbackAtMs = 0;
  private autoFallbackNotice = "";
  private autoFallbackError = "";
  /**
   * A4：当前主通道最近一次收到 FRAME_RAW 的时刻（null = 本次 adopt 后还没收到）。
   * 切到网口后 3 s 内没有原始帧 ⇒ 前端必须醒目提示 + 给「重试」，不能只留一个空画面。
   */
  private lastRawFrameAtMs: number | null = null;
  /** 当前主通道 adopt 的时刻（没有原始帧时，rawRecoverMs 从这里起算） */
  private activeSinceMs = 0;
  /** 当前主通道收到的原始帧数（A4，ADDITIVE；便于排查"绑定成功但 0 包/0 原始帧"） */
  private rawFrames = 0;
  /**
   * B：用户偏好的串口波特率（启动 --baud 或最近一次成功切档）。
   * 串口通道建立后以 SerialTransport.preferredBaud 为准（扫描可能改变首选），这里只兜底网口/UDP 主通道。
   */
  private preferredBaudValue: number;
  /** 网口主通道下的切档结果（串口主通道以 SerialTransport.lastBaudSwitch 为准） */
  private lastBaudSwitchValue: SerialBaudSwitchState = { ok: false, atMs: null, error: null };

  private constructor(opts: LiveTransportOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.selector = new TransportSelector(opts.mode);
    this.preferredBaudValue = opts.serialBaud ?? SERIAL_BAUD;
    // 默认用 ref 版 sleep：等 bind 结果期间必须有 ref 句柄，否则异步 socket error 投递后进程会静默 exit 0
    this.sleep = opts.sleep ?? sleepRef;
  }

  /**
   * 建立主数据通道。显式选择失败 ⇒ 抛 `SerialOpenError` / `NoTransportError`（调用方按 [FATAL] 打印）；
   * auto：先探网口、再探串口，任一成功即返回（串口可用但网口也 OK 时，串口降级为第二观察通道）。
   */
  static async create(opts: LiveTransportOptions): Promise<LiveTransportManager> {
    const m = new LiveTransportManager(opts);
    await m.bootstrap();
    return m;
  }

  get kind(): TransportKind {
    if (this.primary === null) throw new Error("数据通道尚未建立");
    return this.primary.kind;
  }

  get source(): IFrameSource {
    if (this.primary === null) throw new Error("数据通道尚未建立");
    return this.primary.source;
  }

  get v3link(): V3Link {
    if (this.primary === null) throw new Error("数据通道尚未建立");
    return this.primary.v3link;
  }

  get decision(): TransportDecision {
    return this.selector.decision;
  }

  /** 串口通道的手测状态（无串口时 null） */
  get serial(): SerialTransport | null {
    const s: Session | null = this.primary?.kind === "uart" ? this.primary : this.observer;
    return s === null || !(s.source instanceof SerialTransport) ? null : s.source;
  }

  /**
   * B：用户偏好的串口波特率。串口会话以扫描/切档后的 preferred 为准；纯网口（无串口观察通道）用启动参数兜底。
   * config.get 用它回显，前端"波特率"下拉才不会被旧启动参数骗住。
   */
  get preferredBaud(): number {
    return this.serial?.preferredBaud ?? this.preferredBaudValue;
  }

  /**
   * 状态视图（STATS 1 Hz / config.get / hello / 前端"传输方式"卡片统一用它）。
   * 形状固定为 `{ decision, uart }`：decision = 选择结论（含降级原因/失败明细），uart = 串口通道实测状态。
   */
  statusView(): {
    decision: TransportDecision;
    uart: Record<string, unknown> | null;
    probes: Record<string, { ok: boolean; detail: string }>;
    health: ChannelHealthView | null;
    autoFallback: {
      count: number;
      atMs: number | null;
      inFlight: boolean;
      notice: string;
      error: string;
    };
    /** A5：主数据面（udp|uart|null）—— 前端只读这个，decision.mode 只是启动参数 */
    active: TransportKind | null;
    /** A4：本次 adopt 后最近一次 FRAME_RAW 到达时刻（ms；null=还没收到） */
    lastRawFrameAtMs: number | null;
    /** A4：距最近一次 FRAME_RAW（没有则从 adopt 起算）的时长（ms；无主通道时 null） */
    rawRecoverMs: number | null;
    /** A4：本次 adopt 后收到的原始帧数 */
    rawFrames: number;
    /** B：主串口实际打开的档位（UDP 主通道时 null；串口卡片另有 uart.baudRate） */
    baudRate: number | null;
    /** B：板端 0x91 读回（串口优先，UDP 时取主通道 V3Link；null=旧位流/未上报） */
    boardBaud: number | null;
    /** B：用户偏好档位（切档成功/启动参数） */
    preferredBaud: number;
    /** B：最近一次 open 的扫描轨迹（未扫描 = running:false/tried:[]） */
    baudScan: SerialBaudScanState;
    /** B：最近一次切档结果（串口主通道取 SerialTransport；UDP 主通道记录板端命令结果） */
    lastBaudSwitch: SerialBaudSwitchState;
    /** P1-1：当前主通道**不可能/不应该**产出 FRAME_RAW（串口事件链路，或板端 EV_ONLY） */
    noRaw: boolean;
  } {
    const d = this.decision;
    const ss: Session | null = this.primary?.kind === "uart" ? this.primary : this.observer;
    const serial = ss === null || !(ss.source instanceof SerialTransport) ? null : ss.source;
    const mainSerial: SerialTransport | null =
      this.primary !== null && this.primary.kind === "uart" && this.primary.source instanceof SerialTransport
        ? this.primary.source
        : null;
    const now = Date.now();
    const health = this.refreshHealth(now);
    // P1-1："切到网口 3 s 没原始帧"的告警只对**能产出 RAW** 的链路成立。
    // 串口事件链路（rawCapable=false）与板端 EV_ONLY 本来就没有 FRAME_RAW，绝不能误报板端掉档。
    const v3 = this.primary?.v3link.statusView() ?? null;
    const noRaw = this.primary !== null &&
      (this.primary.source.rawCapable === false || v3?.mode === MODE3.EV_ONLY);
    // S8：STATS 1 Hz 顺带做"串口字节在涨但 5 s 无有效 v3 帧"的自动回退判定
    this.maybeAutoFallback(now);
    // 健康看门狗**叠加**在选择器结论上（select.ts 是只读白名单外的模块，不改它）：
    // state=degraded + reason 追加"通道 X 已 N s 无数据"，前端传输卡与 decisionText 直接显示。
    let decision: TransportDecision = health === null
      ? d
      : { ...d, state: d.state === "failed" ? d.state : "degraded", reason: d.reason + "；" + health.reason };
    // S8 的自动回退结果必须显式上屏，不能只靠日志（用户看到的是状态条）
    if (this.autoFallbackError !== "") {
      decision = { ...decision, state: "degraded", reason: this.autoFallbackError };
    } else if (this.autoFallbackNotice !== "" && !decision.reason.includes(this.autoFallbackNotice)) {
      decision = { ...decision, state: decision.state === "failed" ? "failed" : "degraded", reason: this.autoFallbackNotice + "；" + decision.reason };
    }
    return {
      decision,
      uart: serial === null || ss === null ? null : this.uartStatusView(ss),
      probes: Object.fromEntries(this.decisions),
      health,
      autoFallback: {
        count: this.autoFallbackCount,
        atMs: this.lastAutoFallbackAtMs === 0 ? null : this.lastAutoFallbackAtMs,
        inFlight: this.autoFallbackInFlight,
        notice: this.autoFallbackNotice,
        error: this.autoFallbackError,
      },
      active: this.primary?.kind ?? null,
      lastRawFrameAtMs: this.lastRawFrameAtMs,
      // 没有原始帧时从 adopt 起算：切到网口 3 s 仍为 null/超大值 ⇒ 前端提示"没收到原始帧"
      rawRecoverMs: this.primary === null
        ? null
        : Math.max(0, now - (this.lastRawFrameAtMs ?? this.activeSinceMs)),
      rawFrames: this.rawFrames,
      baudRate: mainSerial?.baudRate ?? null,
      boardBaud: mainSerial?.boardBaud ?? (this.primary?.v3link.statusView().serialBaud ?? null),
      preferredBaud: mainSerial?.preferredBaud ?? this.preferredBaudValue,
      baudScan: mainSerial?.baudScan ?? { running: false, tried: [], hit: null },
      lastBaudSwitch: mainSerial?.lastBaudSwitch ?? { ...this.lastBaudSwitchValue },
      noRaw,
    };
  }

  /**
   * B：切换波特率（UI 的 4 档下拉 / config.set {serialBaud}）。
   * - 串口主通道：委托 SerialTransport.switchBaud（板端 ACK → 关旧口 → 新档重开 → GET_STATUS 验证；失败回旧档）。
   * - 网口主通道：只发 0x0C 让板端切档，主机网口通道不变；旧位流（超时/STATUS=4/6/无 0x91 读回）按 B5 明示。
   * 失败一律 throw 给 RPC（前端 toast 有具体原因）；同时把结果记进 statusView.lastBaudSwitch 供传输卡长期显示。
   */
  async switchSerialBaud(baud: number): Promise<ReturnType<LiveTransportManager["statusView"]>> {
    if (serialBaudCode(baud) === null) {
      throw new Error("串口波特率只能是 " + SERIAL_BAUD_RATES.join(" / ") + "，收到 " + String(baud));
    }
    if (this.closed) throw new Error("数据通道已关闭，无法切换波特率");
    const p = this.primary;
    if (p === null) throw new Error("数据通道尚未建立，无法切换波特率");
    if (p.kind === "uart" && p.source instanceof SerialTransport) {
      const r = await p.source.switchBaud(baud);
      if (!r.ok) throw new Error(r.detail);
      // P2-3：切档成功也要更新选择器文案，否则页面 still 显示"串口已打开 @ 旧档"。
      this.selector.force(p.kind, "串口波特率已切到 " + r.baudRate + " baud（" +
        (r.boardBaud === null ? "板端未上报 0x91" : "板端读回 " + r.boardBaud + " baud") + "）");
      return this.statusView();
    }
    // 网口主通道：0x0C 由 V3Link 下发；板端 ACK 必须带 0x91 读回才算成功
    let r: Awaited<ReturnType<V3Link["setParam"]>>;
    try {
      r = await p.v3link.setParam({ serialBaud: baud });
    } catch (err) {
      const detail = "板端波特率切换失败：" + (err instanceof Error ? err.message : String(err));
      this.lastBaudSwitchValue = { ok: false, atMs: Date.now(), error: detail };
      this.log("[transport] " + detail);
      throw new Error(detail);
    }
    const at = Date.now();
    if (!r.ok) {
      if (r.status === null || r.status === 4 || r.status === 6) {
        const why = r.status === null ? "ACK 超时" : "板端 STATUS=" + String(r.status);
        // P2-3："仍 X" 必须是当前偏好档，不能写死 115200（用户可能已切到 921600/460800）。
        const detail = "板端位流较旧，暂不支持调波特率（仍 " + this.preferredBaud + "）：" + why;
        this.lastBaudSwitchValue = { ok: false, atMs: at, error: detail };
        this.log("[transport] " + detail);
        throw new Error(detail);
      }
      const detail = "板端拒绝切换波特率：" + r.detail;
      this.lastBaudSwitchValue = { ok: false, atMs: at, error: detail };
      this.log("[transport] " + detail);
      throw new Error(detail);
    }
    const back = r.tlvs?.serialBaud ?? null;
    if (back === null) {
      // B5：老位流 ACK 长度/内容都可能是旧的；没有 0x91 就不能声称板端已切
      const detail = "板端位流较旧，暂不支持调波特率（仍 " + this.preferredBaud + "）：ACK 未携带 0x91 读回";
      this.lastBaudSwitchValue = { ok: false, atMs: at, error: detail };
      this.log("[transport] " + detail);
      throw new Error(detail);
    }
    if (back !== baud) {
      const detail = "板端读回 " + back + " baud，与请求 " + baud + " baud 不一致";
      this.lastBaudSwitchValue = { ok: false, atMs: at, error: detail };
      this.log("[transport] " + detail);
      throw new Error(detail);
    }
    this.preferredBaudValue = baud;
    this.lastBaudSwitchValue = { ok: true, atMs: at, error: null };
    // P2-3：网口主通道没有串口状态可刷，但选择器文案要反映板端档位已变。
    this.selector.force(p.kind, "板端波特率已切到 " + baud + " baud（主机网口通道不变）");
    this.log("[transport] 板端波特率切换成功：请求 " + baud + " baud，读回 " + back + " baud（主机网口通道不变）");
    return this.statusView();
  }

  /**
   * 十修：串口状态 + 该会话 V3Link 的心跳健康度（ack/fail/lastAckAtMs/lastRttMs）。
   * 心跳 ACK 由 V3Link 匹配，SerialTransport 本身看不到，所以在 live 层合并（ADDITIVE）。
   */
  private uartStatusView(s: Session): Record<string, unknown> {
    const base = (s.source as SerialTransport).statusView();
    const hb = typeof base.heartbeat === "object" && base.heartbeat !== null
      ? base.heartbeat as Record<string, unknown>
      : {};
    return { ...base, heartbeat: { ...hb, ...s.v3link.heartbeatStats() } };
  }

  /**
   * S8：串口通道仍有字节（rxBps > 0）却连续 ≥5 s 没有一帧通过 CRC 的 v3 包 ⇒ 自动切回网口。
   * 约束：每次串口会话只自动切一次；10 s 冷却；有下行命令在飞时不打断；失败保持串口并显式报错。
   */
  private maybeAutoFallback(nowMs: number): void {
    if (this.closed || this.autoFallbackInFlight) return;
    const s = this.primary;
    if (s === null || s.kind !== "uart" || !(s.source instanceof SerialTransport)) return;
    const uart = s.source;
    if (!uart.open) return;
    if (this.autoFallbackCount > 0) return;
    if (this.lastAutoFallbackAtMs !== 0 && nowMs - this.lastAutoFallbackAtMs < 10_000) return;
    const view = uart.statusView();
    const noV3ForMs = typeof view.noV3ForMs === "number" ? view.noV3ForMs : 0;
    if (uart.rxBps <= 0 || noV3ForMs < 5_000) return;
    // 九修：心跳自身也是 pending；只挡用户命令，不能因为心跳 pending 而放弃回退
    if (s.v3link.userInFlight > 0) return;
    const reason = "串口链路无有效帧，已自动切回网口";
    this.autoFallbackCount += 1;
    this.lastAutoFallbackAtMs = nowMs;
    this.autoFallbackInFlight = true;
    this.autoFallbackError = "";
    this.log("[transport] " + reason + "（串口字节在增长但 5 s 内无有效 v3 帧）");
    void this.switchTo("udp", { force: true, reason }).then((d) => {
      this.autoFallbackInFlight = false;
      this.autoFallbackNotice = reason;
      this.log("[transport] 自动回退完成：" + d.reason);
    }).catch((err: unknown) => {
      this.autoFallbackInFlight = false;
      this.autoFallbackNotice = "";
      this.autoFallbackError = reason + "失败：" + msgOf(err) + "（已保持串口通道，请检查网口/端口占用）";
      this.log("[transport] " + this.autoFallbackError);
    });
  }

  /** 当前主通道的活性计数（UDP 包数 / 串口累计字节） */
  private activityMark(s: Session): number {
    return s.kind === "udp" ? (s.source as UdpLike).rxPackets : (s.source as SerialTransport).rxBytes;
  }

  /**
   * 通道健康判定：当前通道 ≥3 s 没有新字节/包 ⇒ degraded。
   * 为什么放在 statusView 里采样而不是起定时器：STATS 恰好 1 Hz 调它，等价于 1 Hz 看门狗，
   * 且不会给"没有前端连接"的网关多背一个定时器；切通道后 adopt() 重置基线。
   */
  private refreshHealth(nowMs: number): ChannelHealthView | null {
    const s = this.primary;
    if (s === null) {
      this.health = null;
      return null;
    }
    let h = this.health;
    if (h === null || h.kind !== s.kind) {
      h = { kind: s.kind, lastActivityMs: nowMs, lastMark: this.activityMark(s), degraded: false };
      this.health = h;
      return null;
    }
    const mark = this.activityMark(s);
    if (mark !== h.lastMark) {
      h.lastMark = mark;
      h.lastActivityMs = nowMs;
      h.degraded = false;
      return null;
    }
    const noDataMs = Math.max(0, nowMs - h.lastActivityMs);
    if (noDataMs < CHANNEL_NO_DATA_MS) return null;
    h.degraded = true;
    const channel = s.kind === "udp" ? "网口(UDP)" : "串口(UART)";
    return {
      state: "degraded",
      channel: s.kind,
      noDataMs,
      reason: "通道 " + channel + " 已 " + (noDataMs / 1000).toFixed(1) + " s 无数据",
    };
  }

  /**
   * 显式切换到某条通道（UI 的"传输方式"选择 / config.set）。
   * 先建后拆：新通道探测/打开失败时抛明确错误，**当前通道保持不动**（不中断正在看的流）。
   * 串口号变了（或 force）时，即使种类相同也重建 —— 否则"改了 COM 口点应用"会静默无效。
   */
  async switchTo(kind: TransportKind, opts: { readonly force?: boolean; readonly reason?: string } = {}): Promise<TransportDecision> {
    const sameKind = this.primary !== null && this.primary.kind === kind;
    const pathChanged = kind === "uart" && this.serial !== null && this.serial.path !== (this.opts.serialPath ?? DEFAULT_SERIAL_PATH);
    if (sameKind && !pathChanged && opts.force !== true) return this.selector.force(kind, "已是当前通道");
    // 用户显式选择串口 = 新的一次串口会话：重置 S8 自动回退的一次性计数与冷却
    if (kind === "uart" && opts.reason === undefined) {
      this.autoFallbackCount = 0;
      this.autoFallbackNotice = "";
      this.autoFallbackError = "";
      this.lastAutoFallbackAtMs = 0;
    }
    const old = this.primary;
    let oldReleased = false;
    let session: Session;
    if (kind === "udp") {
      // 目标是 UDP 且当前就是 UDP（force / 强制重建）：先释放旧 socket 再绑 ——
      // Windows 下 SO_REUSEADDR 让两个 socket 都能 bind 同一端口，但**先绑定者独占收包**，
      // 先建后拆会得到一个"绑定成功但 0 包"的新通道（正是现场"切回网口不能用"的一种形态）。
      if (old !== null && old.kind === "udp") {
        this.dispose(old);
        oldReleased = true;
      }
      try {
        session = await this.buildUdpStable(false);
      } catch (err) {
        // P2-1：force 重建 UDP 时旧 socket 已释放；失败必须尽力重绑恢复 primary，
        // 否则 statusView.active 变 null、页面停在"网口通道重建中"且再也收不到包。
        try {
          const restored = await this.buildUdpStable(false);
          this.adopt(restored);
          const detail = "网口通道强制重建首次失败（" + msgOf(err) + "），已重新建立并恢复";
          this.decisions.set("udp", { ok: true, detail });
          this.log("[transport] " + detail);
          return this.selector.force("udp", detail);
        } catch (restoreErr) {
          const detail = "网口通道强制重建失败，且恢复也失败：" + msgOf(err) + " / " + msgOf(restoreErr);
          this.decisions.set("udp", { ok: false, detail });
          this.selector.force("udp", detail);
          this.log("[transport] " + detail);
          throw new Error(detail);
        }
      }
    } else if (sameKind && opts.force === true) {
      // A2：强制重连当前串口。COM 口是独占资源 —— 先开新句柄再拆旧句柄必然 EACCES，
      // 只能先关旧再开新；开新失败时尽力把旧档重新打开（失败也算显式报错，不静默）。
      if (old !== null) {
        this.dispose(old);
        oldReleased = true;
      }
      try {
        session = await this.build(kind, false);
      } catch (err) {
        try {
          const restored = await this.build("uart", false);
          this.adopt(restored);
          this.log("[transport] 强制重连串口失败，已恢复原串口通道：" + msgOf(err));
        } catch (restoreErr) {
          this.log("[transport] 强制重连串口失败，且恢复原通道也失败：" + msgOf(err) + " / " + msgOf(restoreErr));
        }
        throw err;
      }
    } else {
      session = await this.build(kind, false);
    }
    this.adopt(session);
    if (old !== null && !oldReleased) this.dispose(old);
    this.decisions.set(kind, { ok: true, detail: session.detail });
    const reason = opts.reason
      ?? (kind === "uart" ? "显式切换到串口（仅事件回传）" : "显式切换到网口（三模式全可选）");
    return this.selector.force(kind, reason + "：" + session.detail);
  }

  /**
   * A3：真正的「自动」选择（UI 点「自动」/ config.set transport=auto）。
   * 与 bootstrap 的 auto 不同，这一步是**运行期主动重探**：先 UDP（等首包），失败再试串口。
   * 约束：失败保留当前通道并报原因；不能把当前 active 当"空操作"返回（现场正是这样被骗的）。
   */
  async switchAuto(): Promise<TransportDecision> {
    if (this.closed) throw new Error("数据通道已关闭，无法自动选择");
    let current = this.primary;
    const currentUdp = current !== null && current.kind === "udp" ? (current.source as UdpLike) : null;
    // BLOCK-3R：先刷新健康判定。rxPackets > 0 只说明"曾经收到过包"；板端停流 ≥3 s 后
    // statusView 已判 degraded，此时若继续复用，自动选择会把一条 stale socket 报成在线
    //（现场：收过 1 包后静默 3.3 s，仍返回"已收到 1 包"）。degraded 必须和 0 包一样先拆再重探。
    const healthNow = this.refreshHealth(Date.now());
    const staleUdp = healthNow !== null && healthNow.state === "degraded";
    // BLOCK-3：running 只表示 socket 还开着，不代表板端在发流。0 包时若把它当"在线"，
    // 自动选择会直接复用一条死通道；更糟的是旧 socket 不释放，probeUdp 新 socket 在 Windows
    // 下会"绑定成功但先绑定者独占收包"，永远等不到首包。所以 0 包或 degraded 都必须先拆再重探。
    const currentIsLiveUdp =
      currentUdp !== null && currentUdp.running && currentUdp.rxPackets > 0 && !staleUdp;
    if (currentUdp !== null && !currentIsLiveUdp) {
      this.log("[transport] 自动选择：当前网口通道 running=" + currentUdp.running + "、rxPackets=" +
        currentUdp.rxPackets + "、health=" + (staleUdp ? "degraded" : "ok") + "，先释放再重探");
      this.dispose(current as Session);
      current = null;
    }
    let udpOk = false;
    let udpDetail: string;
    if (currentIsLiveUdp) {
      const udp = currentUdp as UdpLike;
      udpOk = true;
      udpDetail = "网口在线（当前主通道）：已收到 " + udp.rxPackets + " 包";
      this.decisions.set("udp", { ok: true, detail: udpDetail });
    } else {
      const probe = await this.probeUdp();
      this.decisions.set("udp", probe);
      udpOk = probe.ok;
      udpDetail = probe.detail;
    }

    if (udpOk) {
      let chosen: Session | null = currentIsLiveUdp ? current : this.lastProbeSession;
      this.lastProbeSession = null;
      if (chosen === null) chosen = await this.build("udp", false);
      if (chosen !== current) {
        this.adopt(chosen);
        if (current !== null) this.dispose(current);
      }
      const uart = await this.probeUartAsObserverSafe();
      this.decisions.set("uart", uart);
      const reason = "自动选择：网口在线（" + udpDetail + "）" +
        (uart.ok ? "；串口可作第二观察通道" : "；串口不可用（" + uart.detail + "）");
      return this.selector.force("udp", reason);
    }

    // UDP 不通：优先复用当前已打开的串口（不重复占 COM 口），否则新建一条主串口。
    let uartOk = false;
    let uartDetail: string;
    let uartSession: Session | null = null;
    if (current !== null && current.kind === "uart" && this.serial?.open === true) {
      uartOk = true;
      uartDetail = "串口在线（当前主通道，仅事件回传）";
      this.decisions.set("uart", { ok: true, detail: uartDetail });
    } else {
      const probe = await this.probeUartPrimary();
      this.decisions.set("uart", probe.outcome);
      uartOk = probe.outcome.ok;
      uartDetail = probe.outcome.detail;
      uartSession = probe.session;
    }
    if (uartOk) {
      if (uartSession !== null) {
        this.adopt(uartSession);
        if (current !== null) this.dispose(current);
      }
      return this.selector.force("uart", "自动选择：网口不可用（" + udpDetail + "）→ " + uartDetail);
    }
    if (current !== null) {
      // 两条都不通：**保持当前通道**，把两侧原因摊开（前端 toast 用 decision.reason 原话）
      const kept = current.kind === "udp" ? "网口" : "串口";
      return this.selector.force(current.kind, "自动选择失败：网口不可用（" + udpDetail + "）；串口不可用（" +
        uartDetail + "）—— 已保持当前通道（" + kept + "）");
    }
    throw new NoTransportError(this.selector.decision);
  }

  /** 自动选择里的串口第二通道探测：已有观察通道就不再新建（避免泄漏一条旧 session） */
  private async probeUartAsObserverSafe(): Promise<{ ok: boolean; detail: string }> {
    if (this.observer !== null) {
      if (this.observer.source.running) {
        return { ok: true, detail: "串口可作第二观察通道（已在观察）" };
      }
      this.dispose(this.observer);
    }
    return this.probeUartAsObserver();
  }

  /** 运行期降级：主通道失效时按 auto 规则换备选（返回是否真的换了） */
  async fallback(reason: string): Promise<boolean> {
    const d = this.selector.fallback(reason);
    if (d === null || d.active === null) return false;
    try {
      // 带上降级原因（否则 switchTo 的"显式切换"文案会盖掉"降级"这一事实，用户看不出发生了什么）
      await this.switchTo(d.active, { reason: d.reason });
      return true;
    } catch (err) {
      this.log("[transport] 降级到 " + d.active + " 失败：" + msgOf(err));
      return false;
    }
  }

  /** 串口号热改（UI 的串口输入框 / config.set serialPort）：只影响**下一次**建串口通道 */
  updateSerialPath(path: string): void {
    (this.opts as { serialPath?: string }).serialPath = path;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.observer !== null) this.dispose(this.observer);
    if (this.primary !== null) this.dispose(this.primary);
  }

  // ————————————————————————— 内部 —————————————————————————

  private async bootstrap(): Promise<void> {
    const mode = this.opts.mode;
    if (mode === "udp") {
      const s = await this.buildUdpStable(false);
      this.adopt(s);
      this.decisions.set("udp", { ok: true, detail: s.detail });
      // 显式选择：不探测（用户已声明板子在网口上），状态机直接落到 active
      this.selector.record("udp", { ok: true, detail: s.detail });
      return;
    }
    if (mode === "uart") {
      let s: Session;
      try {
        s = await this.build("uart", false);
      } catch (err) {
        this.decisions.set("uart", { ok: false, detail: msgOf(err) });
        this.selector.record("uart", { ok: false, detail: msgOf(err) });
        throw err; // 显式选串口：打开失败必须明确报错，绝不偷偷走网口
      }
      this.decisions.set("uart", { ok: true, detail: s.detail });
      this.adopt(s);
      this.selector.record("uart", { ok: true, detail: s.detail });
      return;
    }

    // ---- auto：先探网口（能收到包才算"网口在"），再探串口 ----
    const udpProbe = await this.probeUdp();
    this.decisions.set("udp", udpProbe);
    this.selector.record("udp", udpProbe);
    if (udpProbe.ok) {
      const s = this.lastProbeSession;
      this.lastProbeSession = null;
      if (s !== null) {
        this.adopt(s);
      } else {
        // 探测成功但 session 已被回收（异常路径）：重建一条正常 UDP 通道
        this.adopt(await this.build("udp", false));
      }
      const uartProbe = await this.probeUartAsObserver();
      this.decisions.set("uart", uartProbe);
      this.selector.record("uart", uartProbe);
      return;
    }
    const uartProbe = await this.probeUartPrimary();
    this.decisions.set("uart", uartProbe.outcome);
    this.selector.record("uart", uartProbe.outcome);
    if (uartProbe.outcome.ok && uartProbe.session !== null) {
      this.adopt(uartProbe.session);
      return;
    }
    throw new NoTransportError(this.selector.decision);
  }

  /** 探测期间临时持有一条 UDP session（探测成功就直接留下用，避免重复绑定） */
  private lastProbeSession: Session | null = null;

  /**
   * UDP 探测：绑定 + 等第一个包（缺省 1500 ms）。
   * 为什么要等包："绑定成功"不等于"板子在发"（P0 报告 §"静默失败"）：端口被旧进程独占时绑定也会成功。
   */
  private async probeUdp(): Promise<{ ok: boolean; detail: string }> {
    let s: Session;
    try {
      s = await this.buildUdpStable(false);
    } catch (err) {
      return { ok: false, detail: msgOf(err) };
    }
    const probeMs = Math.max(1, this.opts.udpProbeMs ?? 1500);
    s.source.start();
    const udp = s.source as UdpLike;
    const stepMs = Math.min(50, probeMs);
    let waited = 0;
    while (udp.rxPackets === 0 && waited < probeMs) {
      await this.sleep(stepMs);
      waited += stepMs;
    }
    if (udp.rxPackets > 0) {
      this.lastProbeSession = s;
      return { ok: true, detail: "网口在：绑定 " + this.bindAddress() + " 后 " + waited + " ms 内收到 " + udp.rxPackets + " 包" };
    }
    this.dispose(s);
    return {
      ok: false,
      detail: "绑定 " + this.bindAddress() + " 成功但 " + probeMs + " ms 内未收到任何包（板端未发流 / 端口被旧网关进程独占 —— Windows 先绑定者独占收包）",
    };
  }

  /** auto 第二通道探测：串口可用则留作观察通道（遥测/CTRL），不可用也不影响主通道 */
  private async probeUartAsObserver(): Promise<{ ok: boolean; detail: string }> {
    try {
      const s = await this.build("uart", true);
      this.observer = s;
      // 观察通道也要收（否则遥测/CTRL 无从谈起）；它的帧不进 hub（observer=true），只走遥测出口
      if (!s.source.running) s.source.start();
      return { ok: true, detail: s.detail + "（第二观察通道：遥测/CTRL 并行，不占用画面通路）" };
    } catch (err) {
      return { ok: false, detail: msgOf(err) };
    }
  }

  /** auto 主通道探测：网口已判失败，串口顶上当主通道（降级为"仅事件回传"） */
  private async probeUartPrimary(): Promise<{ outcome: { ok: boolean; detail: string }; session: Session | null }> {
    try {
      const s = await this.build("uart", false);
      return { outcome: { ok: true, detail: s.detail }, session: s };
    } catch (err) {
      return { outcome: { ok: false, detail: msgOf(err) }, session: null };
    }
  }

  private adopt(session: Session): void {
    session.observer = false;
    // S3（七修）：切通道前先把旧主通道**停掉**，让它在 hub 仍订阅时把最后 ≤40 ms 的 pending 事件批
    // 结算出去。修前是 adopt 先 onSourceChange（hub 退订旧源）、dispose(old) 才 stop→finish，
    // 旧源的残留批发给零个订阅者 ⇒ 串口→UDP 边界静默丢最后一批。
    const prev = this.primary;
    if (prev !== null && prev !== session && prev.source.running) {
      try {
        prev.source.stop();
      } catch (err) {
        this.log("[transport] 旧通道停止时出错（继续切换）：" + msgOf(err));
      }
    }
    this.primary = session;
    // 新通道从"刚连上"开始计时（否则刚切回 UDP 会立刻继承上一条通道的 no-data 判定）
    this.health = null;
    // A4：每次 adopt 都重置原始帧时钟 —— 「重试」后 3 s 的判定窗口必须重新起算
    this.activeSinceMs = Date.now();
    this.lastRawFrameAtMs = null;
    this.rawFrames = 0;
    if (session.rawWatched !== true) {
      session.rawWatched = true;
      // 只统计当前主通道：观察通道（第二串口）的帧不算"画面恢复"
      session.source.on("frame", () => {
        if (this.primary !== session) return;
        this.lastRawFrameAtMs = Date.now();
        this.rawFrames += 1;
      });
    }
    this.opts.onSourceChange?.(session.source);
    if (!session.source.running) session.source.start();
    this.watchStall(session);
  }

  /** 主通道失效自检：UDP 停滞 / 串口关闭 ⇒ auto 模式尝试降级（显式模式只报错） */
  private watchStall(session: Session): void {
    session.source.on("error", (e) => {
      if (this.closed || this.primary !== session) return;
      if (e.code !== "udp-stall" && e.code !== "uart-closed") return;
      void this.fallback(e.message);
    });
  }

  /**
   * 建一条 UDP 通道并**确认绑定结果**（B5）：
   *   · 正常：返回已绑定（或绑定信号未知但不报错）的 session；
   *   · EADDRINUSE：精确原因上屏 + 200 ms 后自动重建重试一次；
   *   · 仍失败：抛带可执行文案的错误（调用方保持/恢复当前通道）。
   * 为什么要等：UDP 的 bind 错误是 socket 的异步 "error" 事件，build() 返回时一切看起来都"成功"，
   * 不等一拍就会把一次失败当成功切过去（现场表现正是"切回网口不能用"）。
   */
  private async buildUdpStable(observer: boolean): Promise<Session> {
    const first = await this.build("udp", observer);
    const firstErr = await this.waitUdpBound(first);
    if (firstErr === null) return first;
    this.dispose(first);
    // Windows 的端口占用在 Node 里常报 EACCES（bind EACCES 192.168.1.102:1236），libuv 也可能是
    // -4091（UV_EADDRINUSE）或 EBUSY；只认 EADDRINUSE 会让自动重试在 Windows 上永不触发（R1）。
    // 「地址不是本机」优先于端口占用：两者文案/修复完全不同，混报会让用户看不出真实原因
    if (this.isNotLocalBind(firstErr)) throw new Error(this.notLocalBindMessage(firstErr));
    if (!UDP_BIND_BUSY_RE.test(firstErr)) {
      throw new Error("UDP 绑定失败：" + firstErr + "（" + this.bindAddress() + "）");
    }
    this.log("[transport] UDP 端口被占用（" + this.bindAddress() + "）：" + firstErr + "；" + UDP_BIND_RETRY_MS + " ms 后自动重试一次");
    await this.sleep(UDP_BIND_RETRY_MS);
    const second = await this.build("udp", observer);
    const secondErr = await this.waitUdpBound(second);
    if (secondErr === null) return second;
    this.dispose(second);
    if (this.isNotLocalBind(secondErr)) throw new Error(this.notLocalBindMessage(secondErr));
    throw new Error(
      "UDP 绑定失败：" + secondErr + "（" + this.bindAddress() + "）—— 端口仍被占用（EADDRINUSE/EACCES，已自动重试 1 次）。" +
      "最常见原因：用户网关/旧抓包进程仍占着同一端口（Windows 下先绑定者独占收包）；" +
      "请关闭占用进程后点「重试」，或换端口重启网关。",
    );
  }

  /**
   * 等 UDP 绑定信号（最多 UDP_BIND_WAIT_MS）。返回 null = 成功（或没收到绑定失败信号）。
   * 注入的假源（udpFactory）默认视为已绑定，不等待 —— 单测不该等真实时钟。
   */
  private async waitUdpBound(session: Session): Promise<string | null> {
    // 先 start 再判（幂等）：注入的假源在 onStart 里同步抛 udp-socket 错误，
    // 早退会让"绑定失败"被当成"已绑定" —— 这正是 B5 要防的假成功。
    session.source.start();
    if (session.bind.bindError !== null) return session.bind.bindError;
    if (session.bind.bound) return null;
    const deadline = Date.now() + UDP_BIND_WAIT_MS;
    while (Date.now() < deadline) {
      if (session.bind.bindError !== null) return session.bind.bindError;
      if (session.bind.bound) return null;
      await this.sleep(20);
    }
    // 绑定慢/没有 onBound 信号：不算失败（运行期 socket error 仍会经 watchStall/STATS 上屏）
    return session.bind.bindError;
  }

  private async build(kind: TransportKind, observer: boolean): Promise<Session> {
    const counters = createCounters();
    const profile = this.opts.profile;
    let source: Session["source"];
    let downlink: DownlinkSocket | null = null;
    let handshake: SerialHandshakeResult | null = null;
    let detail: string;

    // V3Link 的 CTRL 出口：这里必须先声明再赋值（源在 build 里就开始收包了）。
    // 目标选择：优先喂**主通道**的 V3Link（串口当第二观察通道时，它的 CTRL 也进主状态视图），
    // 主通道还没建立（bootstrap 期间）则用自己的 link。
    let link: V3Link | null = null;
    /** 九修：串口源在 V3Link 建好前不允许发心跳（start 在 build 之后，实际不会提前触发） */
    let heartbeatLink: V3Link | null = null;
    // 只有主串口通道需要心跳（S8 只对主通道生效）；UDP 主通道下的第二观察串口不发，
    // 否则它的 ACK 会被 ctrlSink 送进主通道的 V3Link（既有路由），造成心跳 pending 永远清不掉。
    const serialHeartbeatMs = observer ? 0 : Math.max(0, this.opts.serialHeartbeatMs ?? 1000);
    const ctrlSink = (pkt: ParsedV3): void => (this.primary?.v3link ?? link)?.onCtrlPacket(pkt);
    const modeSink = (mode: number): void => (this.primary?.v3link ?? link)?.noteDataMode(mode);

    // 绑定状态：注入的假源没有 onBound 信号 ⇒ 视为已绑定（单测不依赖真实 socket）
    const bind: BindState = {
      bound: kind === "udp" ? this.opts.udpFactory !== undefined : true,
      bindError: null,
      bindErrorCode: null,
    };
    if (kind === "udp") {
      const opts: UdpOptions = {
        profile,
        ...(this.opts.bind === null || this.opts.bind === undefined ? {} : { bind: this.opts.bind }),
        ...(this.opts.port === null || this.opts.port === undefined ? {} : { port: this.opts.port }),
        ...(this.opts.recvBufferSize === undefined ? {} : { recvBufferSize: this.opts.recvBufferSize }),
        onCtrl: ctrlSink,
        onV3Mode: modeSink,
      };
      source = this.opts.udpFactory === undefined
        ? new UdpTransport({
            ...opts,
            onBound: (ip, p) => {
              bind.bound = true;
              this.log("UDP 已绑定 " + ip + ":" + p);
            },
          })
        : this.opts.udpFactory(opts);
      // 异步绑定失败（EADDRINUSE / EACCES）先记在 session 上：buildUdpStable 据此重试/报精确原因
      source.on("error", (e) => {
        if (e.code === "udp-socket" && e.fatal) {
          bind.bindError = e.message;
          bind.bindErrorCode = socketErrorCodeOf(e.message);
        }
      });
      downlink = new DownlinkSocket({ onError: (e) => this.log("[downlink] " + e.code + ": " + e.message) });
      downlink.start();
      detail = "UDP 绑定 " + this.bindAddress();
    } else {
      const path = this.opts.serialPath ?? DEFAULT_SERIAL_PATH;
      const serial = await SerialTransport.open({
        profile,
        path,
        baudRate: this.opts.serialBaud ?? SERIAL_BAUD,
        ...(this.opts.serialFactory === undefined ? {} : { factory: this.opts.serialFactory }),
        handshake: {
          enabled: this.opts.handshakeEnabled ?? true,
          ...(this.opts.handshake ?? {}),
        },
        onTelemetry: this.opts.onTelemetry,
        onText: this.opts.onText,
        onCtrl: ctrlSink,
        onV3Mode: modeSink,
        log: this.log,
        ...(serialHeartbeatMs > 0 ? {
          heartbeat: {
            intervalMs: serialHeartbeatMs,
            canSend: () => (heartbeatLink?.inFlight ?? 0) === 0,
            send: () => {
              const l = heartbeatLink;
              if (l !== null && l.inFlight === 0) void l.getStatus({ heartbeat: true });
            },
          },
        } : {}),
      });
      source = serial;
      handshake = serial.handshake;
      detail = "串口 " + path + " @ " + (this.opts.serialBaud ?? SERIAL_BAUD) + " 8N1 已打开；" + handshake.detail;
      this.log("[uart] " + detail);
    }

    const v3link = new V3Link({
      send: (bytes) => {
        if (kind === "udp") downlink?.send(bytes);
        else (source as SerialTransport).send(bytes);
      },
      nowUs: () => performance.now() * 1000,
      counters,
    });
    v3link.onOffsetChanged = (offsetUs) => source.setTsOffsetUs(offsetUs);
    heartbeatLink = v3link;
    this.opts.onV3Link?.(v3link);
    link = v3link;
    return { kind, source, bind, v3link, downlink, counters, handshake, detail, observer };
  }

  private dispose(session: Session): void {
    try {
      session.source.stop();
    } catch (err) {
      this.log("[transport] 停止 " + session.kind + " 源失败：" + msgOf(err));
    }
    if (session.source instanceof SerialTransport) session.source.closePort();
    if (session.downlink !== null) session.downlink.close();
    if (this.primary === session) this.primary = null;
    if (this.observer === session) this.observer = null;
  }

  /** 该次绑定失败是否 = 地址不属于本机（真实 socket 错误码优先；真 socket 场景再按网卡清单兜底） */
  private isNotLocalBind(raw: string): boolean {
    if (isNotLocalBindFailure(raw)) return true;
    // 注入假源（单测）时不做地址兜底：假源报的地址只是文案，不代表真实绑定
    if (this.opts.udpFactory !== undefined) return false;
    const host = this.bindHost();
    return isIpv4Literal(host) && !isLocalBindAddress(host);
  }

  private notLocalBindMessage(raw: string): string {
    return formatBindAddrNotLocal(this.bindHost(), this.bindPort(), socketErrorCodeOf(raw), raw);
  }

  private bindHost(): string {
    return this.opts.bind ?? this.opts.profile.udp.bind;
  }

  private bindPort(): number {
    return this.opts.port ?? this.opts.profile.udp.port;
  }

  private bindAddress(): string {
    return this.bindHost() + ":" + this.bindPort();
  }
}

function msgOf(err: unknown): string {
  if (err instanceof SerialOpenError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
