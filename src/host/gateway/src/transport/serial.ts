// 串口 transport（UART 路线，WIRE-U1 §8.2 H1）：打开 115200 8N1（无流控）→ 流式定帧 → 复用处理器。
//
// 三条原则落在这里：
//   ① **协议层零分叉**：定帧后的整帧原样喂 `feed()`（= packet/processor 的同一条路径），
//      所以 `parseV3Packet` / 装配器 / CTRL→V3Link / MODE 观察全部零改动复用；
//   ② **不静默**（P6）：打开失败、握手失败、写失败、CRC/重同步都必须有明确文案 ——
//      用户看到的是"COM6 打开失败：File not found（当前可用串口：COM1, COM4）"，不是一块黑屏；
//   ③ **可测**：串口句柄走注入（`SerialPortFactory`），测试用假口；真口只在 nodeSerialFactory 里出现，
//      且用**动态 import**（本机没装 serialport / 原生模块加载失败时，网关其余部分照常起）。
import {
  CTRL,
  DOWNLINK,
  SERIAL_BAUD_RATES,
  buildSetParamPayload,
  encodeDownlink,
  interpretStatusTlvs,
  serialBaudCode,
} from "@retina/protocol";
import type { ParsedV3, Profile, SourceError, UartTelemFrame } from "@retina/protocol";
import { BaseFrameSource, unrefTimer } from "./base.ts";
import { SerialDeframer } from "../pipeline/serial_deframer.ts";
import type { SerialDeframerStats } from "../pipeline/serial_deframer.ts";

/** 本机默认串口（用户 2026-10-12 现场口径：板载 CH340C 枚举为 COM6） */
export const DEFAULT_SERIAL_PATH = "COM6";
/** 串口线固定参数（WIRE-U1 §2.1：115200 8N1，无流控） */
export const SERIAL_BAUD = 115200;
/** rx 速率滑动窗口（ms；传输卡显示"最近 1 s 收到多少字节"） */
const RX_WINDOW_MS = 1000;
/**
 * 串口开档扫描阶梯（契约 §1.5）：首选档 → 115200 → 921600 → 460800 → 230400。
 * 为什么 921600 排在 460800 前：现场提速目标是最高档，命中它最省一次重开。
 */
const BAUD_SCAN_LADDER = [115200, 921600, 460800, 230400] as const;
/** 改档后等板端真正切 TX/RX 分频的最小静默（契约 §1.5：≥100 ms） */
const BAUD_SWITCH_SETTLE_MS = 120;
/** SET_PARAM 0x0C 的 ACK 超时：板端旧位流不认 tag 时用来快速判"不支持" */
const BAUD_SWITCH_ACK_TIMEOUT_MS = 1200;
/** 串口 open 扫描单档探测超时（契约 §1.5：单次 GET_STATUS 250 ms） */
const BAUD_SCAN_PROBE_TIMEOUT_MS = 250;

export interface SerialBaudScanState {
  /** 是否正在扫描（open 期间对外不可见，保留字段给切换舞蹈/未来异步重扫） */
  running: boolean;
  /** 已试档位（按实际尝试顺序） */
  tried: number[];
  /** 命中档位；null = 未命中任何档（以首选档返回并带握手失败详情） */
  hit: number | null;
}

export interface SerialBaudSwitchState {
  readonly ok: boolean;
  readonly atMs: number | null;
  readonly error: string | null;
}

export interface SerialBaudSwitchResult extends SerialBaudSwitchState {
  /** 切换成功后实际打开的档位；失败时为当前仍生效的档位 */
  readonly baudRate: number;
  /** 板端 0x91 读回（旧位流/未上报 = null） */
  readonly boardBaud: number | null;
  readonly preferredBaud: number;
  readonly detail: string;
  /** true = 板端已切、主机未连上，已回退旧档 */
  readonly rolledBack: boolean;
  /** true = 板端不认 0x0C（旧位流），按 B5 降级提示且不改 preferred */
  readonly unsupported: boolean;
}

/**
 * 串口句柄的最小结构契约（只声明我们真正用到的 5 个成员）。
 * 为什么要自己的接口而不是直接用 serialport 的类型：① 单测注入假口；② serialport 是原生模块，
 * 万一加载失败，只有 `nodeSerialFactory` 这一个角落受影响。
 */
export interface SerialPortLike {
  readonly isOpen: boolean;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  write(data: Uint8Array, cb: (err: Error | null) => void): unknown;
  close(cb?: (err: Error | null) => void): unknown;
}

export interface SerialOpenOptions {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: 8;
  readonly stopBits: 1;
  readonly parity: "none";
  readonly rtscts: false;
}

export interface SerialPortFactory {
  open(opts: SerialOpenOptions): Promise<SerialPortLike>;
  /** 可用串口列表（只用于"打开失败"时的诊断文案；取不到就返回 null） */
  list(): Promise<readonly string[] | null>;
}

/** 打开失败的错误（带可执行文案：串口号 + 原始错误 + 当前可用串口） */
export class SerialOpenError extends Error {
  readonly path: string;
  readonly cause: string;
  readonly available: readonly string[];
  constructor(path: string, cause: string, available: readonly string[]) {
    super(
      "串口 " + path + " 打开失败：" + cause +
      (available.length > 0 ? "（当前可用串口：" + available.join(", ") + "）" : "（未枚举到任何串口）") +
      " —— 请确认 CH340 驱动（CH341SER）已装、USB 线插好、串口号与 COM 一致（设备管理器可见），" +
      "且没有被串口助手/其它网关进程占用。",
    );
    this.name = "SerialOpenError";
    this.path = path;
    this.cause = cause;
    this.available = available;
  }
}

/** 真实串口（serialport@13，NAPI 预编译）：动态 import + 只在打开时解析原生模块 */
export const nodeSerialFactory: SerialPortFactory = {
  async open(opts: SerialOpenOptions): Promise<SerialPortLike> {
    let listPorts: readonly string[] | null = null;
    try {
      listPorts = await this.list();
    } catch {
      listPorts = null;
    }
    let mod: { SerialPort: new (o: Record<string, unknown>, cb: (err: Error | null) => void) => SerialPortLike };
    try {
      mod = (await import("serialport")) as unknown as typeof mod;
    } catch (err) {
      throw new SerialOpenError(opts.path, "serialport 原生模块加载失败（" + msgOf(err) + "）", listPorts ?? []);
    }
    return await new Promise<SerialPortLike>((resolve, reject) => {
      let port: SerialPortLike;
      try {
        port = new mod.SerialPort(
          {
            path: opts.path,
            baudRate: opts.baudRate,
            dataBits: opts.dataBits,
            stopBits: opts.stopBits,
            parity: opts.parity,
            rtscts: opts.rtscts,
            autoOpen: true,
          },
          (err: Error | null) => {
            if (err === null) resolve(port);
            else reject(new SerialOpenError(opts.path, msgOf(err), listPorts ?? []));
          },
        );
      } catch (err) {
        reject(new SerialOpenError(opts.path, msgOf(err), listPorts ?? []));
      }
    });
  },

  async list(): Promise<readonly string[] | null> {
    try {
      const mod = (await import("serialport")) as unknown as { SerialPort: { list: () => Promise<{ path: string }[]> } };
      const ports = await mod.SerialPort.list();
      return ports.map((p) => p.path);
    } catch {
      return null;
    }
  },
};

export interface SerialHandshakeResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly detail: string;
  /** 握手成功时的 ACK 往返时间（ms；失败为 null） */
  readonly rttMs: number | null;
}

export interface SerialOptions {
  readonly profile: Profile;
  /** 串口号（默认 COM6） */
  readonly path?: string;
  readonly baudRate?: number;
  /** 注入的串口句柄（不传则用 nodeSerialFactory 打开 path） */
  readonly port?: SerialPortLike;
  readonly factory?: SerialPortFactory;
  /** 握手参数（测试注入缩短的时间；默认 3 次 × 300 ms 等 ACK / 间隔 500 ms，WIRE-U1 §3.7） */
  readonly handshake?: {
    readonly attempts?: number;
    readonly ackTimeoutMs?: number;
    readonly gapMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    /** false = 跳过握手（纯数据面用；默认 true） */
    readonly enabled?: boolean;
  } | undefined;
  readonly frameTimeoutMs?: number;
  readonly evRingMaxBytes?: number;
  /**
   * 九修：串口链路心跳（GET_STATUS）。只负责"什么时候发"，真正的命令走 V3Link。
   * 不传 = 关闭（直开 SerialTransport 的既有测试/脚本保持原语义）；intervalMs=0 也关闭。
   */
  readonly heartbeat?: {
    readonly intervalMs?: number;
    readonly send: () => void;
    /** false = 有用户命令在飞，本次跳过（不排队、不打断） */
    readonly canSend?: () => boolean;
  } | undefined;
  /** 遥测帧出口（帧型 A：串口连接卡直读 ev/act/cr；WIRE-U1 §3.1） */
  readonly onTelemetry?: ((t: UartTelemFrame, raw: Uint8Array, atMs: number) => void) | undefined;
  /** 人读 ASCII 行出口（`T fr=…`） */
  readonly onText?: ((line: string) => void) | undefined;
  readonly onCtrl?: ((pkt: ParsedV3) => void) | undefined;
  readonly onV3Mode?: ((mode: number) => void) | undefined;
  readonly log?: ((msg: string) => void) | undefined;
}

function msgOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    unrefTimer(t);
  });
}

export class SerialTransport extends BaseFrameSource {
  readonly path: string;
  /** 定帧器（流式重同步/CRC 统计都在它身上，"不静默"的可观测面） */
  readonly deframer: SerialDeframer;

  /** 当前**已打开**档位（运行时切档后会变，因此不是 readonly；对外只读 getter） */
  private baudRateValue: number;
  /** 用户首选档（重启扫描的第一顺位；切档成功才更新，失败/旧位流降级不更新） */
  private preferredBaudValue: number;
  /** 板端 0x91 读回（旧位流/尚未上报 = null） */
  private boardBaudValue: number | null = null;
  private readonly baudScanState: SerialBaudScanState = { running: false, tried: [], hit: null };
  private lastBaudSwitchValue: SerialBaudSwitchState = { ok: false, atMs: null, error: null };
  /** 串口句柄可在运行时重开；句柄代际用来丢弃旧口迟到的 data/close 事件 */
  private port: SerialPortLike;
  private portGen = 0;
  private readonly factory: SerialPortFactory;
  private readonly portInjected: boolean;
  private readonly options: SerialOptions;
  private readonly log: (msg: string) => void;
  private hs: SerialHandshakeResult = { ok: false, attempts: 0, detail: "握手未执行", rttMs: null };
  private latestTelem: { telem: UartTelemFrame; atMs: number } | null = null;
  /** ACK 等待器带整包：改档要读 ACK 里的 0x91 读回，不能只知道"收到了" */
  private readonly ackWaiters = new Map<number, (pkt: ParsedV3) => void>();
  private hsSeq = 0;
  private closed = false;
  /** 累计接收字节（B4 通道健康看门狗的活性信号 + B3 传输卡 rx 速率） */
  private rxTotalBytes = 0;
  /** 最近一次收到字节的时刻（ms；0 = 从未收到） */
  private rxLastAtMs = 0;
  /**
   * 最近 2 s 的收字节采样（t → 该次 chunk 的字节数）。
   * 为什么自己采样而不是只存计数：rxBps 必须是"最近 1 s 的滑动窗口"，
   * 用总字节数除以运行时长会把"刚刚才开始发/刚刚停"抹平（0 B/s 现场看起来像有数据）。
   */
  private readonly rxSamples: { at: number; bytes: number }[] = [];
  /** 本次打开的时刻（S8：从未收到有效 v3 帧时，从打开时刻起算 noV3ForMs；切档重开要重置） */
  private openedAtMs = Date.now();
  /** 最近一次通过 CRC/定帧校验的 v3 帧到达时刻（ms；0 = 从未） */
  private lastV3FrameAtMs = 0;
  /** 最近 10 s 的成功 v3 帧/CRC 失败时刻（S7 失败率窗口；数组按 10 s 裁剪 + 上限保护） */
  private readonly v3OkTimes: number[] = [];
  private readonly v3CrcFailTimes: number[] = [];
  /** S9：坏帧日志按通道每秒最多 1 条汇总（count=本窗口条数，total=累计，first=窗口内首个错误） */
  private badFrameLogTimer: ReturnType<typeof setTimeout> | null = null;
  private badFrameLogCount = 0;
  private badFrameLogTotal = 0;
  private badFrameLogFirst = "";
  /** 九修：串口链路心跳（STATS 之外的主动探活；ACK 会刷新 lastV3FrameAtMs） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatSent = 0;
  private heartbeatSkippedInFlight = 0;
  private heartbeatSkippedRecentDownlink = 0;
  private lastHeartbeatAtMs = 0;
  /** BLOCK-2：最近一次回退失败的具体原因（旧档无 ACK / 重开失败）；回退成功时为空 */
  private lastRollbackDetail = "";
  /** 最近一次真实下行写入（含用户命令/心跳本身；用于"用户刚发过命令的 1 s 内不插心跳"） */
  private lastDownlinkAtMs = 0;

  private constructor(opts: SerialOptions, port: SerialPortLike, path: string, baudRate: number) {
    super({
      profile: opts.profile,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
      // 七修：串口链路只有事件帧（RAW_LEN=0），没有任何原始段；装配器据此走 EV_ONLY 语义。
      rawCapable: false,
      onCtrl: (pkt) => {
        // 握手 ACK 观察必须先于外部钩子（顺序无关，但先解析才能及时解除等待）
        this.noteCtrl(pkt);
        opts.onCtrl?.(pkt);
      },
      onV3Mode: opts.onV3Mode,
    });
    this.options = opts;
    this.port = port;
    this.path = path;
    this.baudRateValue = baudRate;
    this.preferredBaudValue = baudRate;
    this.factory = opts.factory ?? nodeSerialFactory;
    this.portInjected = opts.port !== undefined;
    this.log = opts.log ?? (() => {});
    this.deframer = new SerialDeframer({
      onV3Frame: (frame, tArriveMs) => {
        this.lastV3FrameAtMs = tArriveMs;
        this.v3OkTimes.push(tArriveMs);
        this.trimRecent(this.v3OkTimes, tArriveMs - 10_000);
        this.feed(frame, tArriveMs);
      },
      onTelem: (telem, raw, atMs) => {
        this.latestTelem = { telem, atMs };
        this.options.onTelemetry?.(telem, raw, atMs);
      },
      onText: opts.onText,
      onBadFrame: (reason, detail) => this.noteBadFrame(reason, detail),
    });
    this.portGen++;
    this.wirePort(port, this.portGen);
  }

  /**
   * 打开串口 + 握手，返回**已就绪但未 start()** 的 transport。
   * 打开失败抛 `SerialOpenError`（调用方据此明确报错/降级）；握手失败**不抛**（照常收遥测帧降级显示）。
   */
  static async open(opts: SerialOptions): Promise<SerialTransport> {
    const path = opts.path ?? DEFAULT_SERIAL_PATH;
    const preferredBaud = opts.baudRate ?? SERIAL_BAUD;
    const factory = opts.factory ?? nodeSerialFactory;
    const portOpts = (baudRate: number): SerialOpenOptions => ({
      path,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
    });
    // 注入句柄（单测/特殊环境）不能换口重开，也不该触发真实扫描；握手关闭同理（显式 no-handshake）
    if (opts.port !== undefined || opts.handshake?.enabled === false) {
      const port = opts.port ?? await factory.open(portOpts(preferredBaud));
      const t = new SerialTransport(opts, port, path, preferredBaud);
      t.hs = await t.runHandshake();
      return t;
    }
    // 契约 §1.5：open 扫描阶梯 [preferred, 115200, 921600, 460800, 230400]，每档单次 GET_STATUS 250 ms；
    // 命中后该档正式握手 3 次。为什么必须扫描：板端改档后掉电/重启，主机重启时首选档可能与板端不一致。
    const ladder: number[] = [];
    for (const b of [preferredBaud, ...BAUD_SCAN_LADDER]) {
      if (!ladder.includes(b)) ladder.push(b);
    }
    const tried: number[] = [];
    let lastOpenError: unknown = null;
    for (const baud of ladder) {
      tried.push(baud);
      let port: SerialPortLike;
      try {
        port = await factory.open(portOpts(baud));
      } catch (err) {
        lastOpenError = err;
        continue;
      }
      const t = new SerialTransport(opts, port, path, baud);
      t.preferredBaudValue = preferredBaud;
      t.baudScanState.running = true;
      t.baudScanState.tried = [...tried];
      const probe = await t.runHandshake({
        attempts: 1,
        ackTimeoutMs: BAUD_SCAN_PROBE_TIMEOUT_MS,
        gapMs: 0,
        ignoreDisabled: true,
      });
      t.baudScanState.running = false;
      if (probe.ok) {
        t.baudScanState.hit = baud;
        // 命中后再按用户配置做正式握手（默认 3 次），失败也不换档（探测已证明链路在线，只是 ACK 抖动）
        t.hs = await t.runHandshake();
        return t;
      }
      t.closePort();
    }
    // 全档未命中：以首选档重开一次返回（保留遥测显示 + 明确握手失败文案）；一个口都打不开则抛原始打开错误
    let port: SerialPortLike;
    try {
      port = await factory.open(portOpts(preferredBaud));
    } catch (err) {
      if (lastOpenError !== null) throw lastOpenError;
      throw err;
    }
    const t = new SerialTransport(opts, port, path, preferredBaud);
    t.preferredBaudValue = preferredBaud;
    t.baudScanState.tried = [...tried];
    t.hs = await t.runHandshake();
    return t;
  }

  // ————————————————————————— 对外状态 —————————————————————————

  get handshake(): SerialHandshakeResult {
    return this.hs;
  }

  get telemetry(): { telem: UartTelemFrame; atMs: number } | null {
    return this.latestTelem;
  }

  get deframerStats(): SerialDeframerStats {
    return this.deframer.stats;
  }

  /** 当前已打开档位（运行时切档后会变；显示"串口打开"用） */
  get baudRate(): number {
    return this.baudRateValue;
  }

  /** 用户首选档（扫描第一顺位；失败/旧位流降级时不改） */
  get preferredBaud(): number {
    return this.preferredBaudValue;
  }

  /** 板端 0x91 读回；null = 旧位流/尚未上报（绝不能拿 preferred 顶替） */
  get boardBaud(): number | null {
    return this.boardBaudValue;
  }

  get baudScan(): SerialBaudScanState {
    return { running: this.baudScanState.running, tried: [...this.baudScanState.tried], hit: this.baudScanState.hit };
  }

  get lastBaudSwitch(): SerialBaudSwitchState {
    return { ...this.lastBaudSwitchValue };
  }

  get open(): boolean {
    return this.port.isOpen && !this.closed;
  }

  /** 累计收到字节数（现场判据：UART_LINK_EN=0 的位流 rxBytes 恒 0） */
  get rxBytes(): number {
    return this.rxTotalBytes;
  }

  /** 最近 1 s 的平均接收速率（B/s；无采样 = 0） */
  get rxBps(): number {
    const cutoff = Date.now() - RX_WINDOW_MS;
    let sum = 0;
    for (let i = this.rxSamples.length - 1; i >= 0; i--) {
      const s = this.rxSamples[i];
      if (s === undefined || s.at < cutoff) break;
      sum += s.bytes;
    }
    return Math.round(sum / (RX_WINDOW_MS / 1000));
  }

  /** 距最近一次收到字节的时间（ms；从未收到 = null） */
  get lastRxAgeMs(): number | null {
    return this.rxLastAtMs === 0 ? null : Math.max(0, Date.now() - this.rxLastAtMs);
  }

  /** 下行写入（V3Link 的 send 通道 = 串口与 UDP 同一份命令字节，WIRE-U1 §3.7） */
  send(bytes: Uint8Array): void {
    if (this.closed || !this.port.isOpen) {
      this.emitError({ code: "uart-write", message: "串口 " + this.path + " 未打开，下行 " + bytes.length + " B 未发出", fatal: false });
      return;
    }
    this.lastDownlinkAtMs = Date.now();
    try {
      this.port.write(bytes, (err) => {
        if (err !== null && err !== undefined) {
          this.emitError({ code: "uart-write", message: "串口 " + this.path + " 写入失败：" + msgOf(err), fatal: false });
        }
      });
    } catch (err) {
      this.emitError({ code: "uart-write", message: "串口 " + this.path + " 写入异常：" + msgOf(err), fatal: false });
    }
  }

  /** 状态视图（config.get / snapshot / 前端连接卡） */
  statusView(): Record<string, unknown> {
    return {
      kind: "uart",
      path: this.path,
      // R-2：端口终态关闭后没有"当前已打开档位"；不能继续回显最后一次尝试的阶档（会被误读为仍连着）。
      baudRate: this.open ? this.baudRate : null,
      // 串口提速（ADDITIVE）：串口打开档 / 板端 0x91 读回 / 首选档 / 扫描结果 / 最近一次切档结果
      boardBaud: this.boardBaudValue,
      preferredBaud: this.preferredBaudValue,
      baudScan: this.baudScan,
      lastBaudSwitch: this.lastBaudSwitch,
      open: this.open,
      handshakeOk: this.hs.ok,
      handshakeDetail: this.hs.detail,
      handshakeAttempts: this.hs.attempts,
      handshakeRttMs: this.hs.rttMs,
      // B3/B4：收字节活性（传输卡显示 rx 速率；通道健康看门狗读它判"有没有字节进来"）
      rxBytes: this.rxTotalBytes,
      rxBps: this.rxBps,
      lastRxAgeMs: this.lastRxAgeMs,
      lastRxAtMs: this.rxLastAtMs === 0 ? null : this.rxLastAtMs,
      deframer: { ...this.deframer.stats },
      telemetry: this.latestTelem === null ? null : { ...this.latestTelem.telem, atMs: this.latestTelem.atMs },
      // S7/S8（ADDITIVE）：链路有效性 —— 有效 v3 帧年龄/CRC 失败率/最近 10 s 窗口。
      lastV3FrameAtMs: this.lastV3FrameAtMs === 0 ? null : this.lastV3FrameAtMs,
      lastV3FrameAgeMs: this.lastV3FrameAtMs === 0 ? null : Math.max(0, Date.now() - this.lastV3FrameAtMs),
      noV3ForMs: Math.max(0, Date.now() - (this.lastV3FrameAtMs === 0 ? this.openedAtMs : this.lastV3FrameAtMs)),
      crcFailTotal: this.deframer.stats.v3CrcFail + this.deframer.stats.telemCrcFail,
      v3CrcFailRate: this.v3CrcFailRate(),
      recent10s: this.recent10s(Date.now()),
      // 九修（ADDITIVE）：心跳探活 —— 安静场景由 ACK 维持 "有有效 v3 帧"，避免 S8 误判。
      heartbeat: {
        enabled: this.heartbeatTimer !== null,
        intervalMs: this.heartbeatIntervalMs(),
        sent: this.heartbeatSent,
        skippedInFlight: this.heartbeatSkippedInFlight,
        skippedRecentDownlink: this.heartbeatSkippedRecentDownlink,
        lastAtMs: this.lastHeartbeatAtMs === 0 ? null : this.lastHeartbeatAtMs,
      },
    };
  }

  // ————————————————————————— 生命周期 —————————————————————————

  protected override onStart(): void {
    this.startHeartbeat();
  }

  protected onStop(): void {
    this.closePort();
  }

  /** 关闭串口（幂等；stop() 之外也会被传输选择器/切换流程调用；closed 是终态） */
  closePort(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachPort();
  }

  /**
   * 摘下当前串口句柄但**不置终态**（运行时改档：旧档 close → 新档 open）。
   * portGen++ 让旧句柄迟到的 data/close/error 事件全部失效 —— 否则旧口的 close 事件会把刚打开的新口误标 closed。
   */
  private detachPort(): void {
    this.portGen++;
    this.stopHeartbeat();
    if (this.badFrameLogTimer !== null) {
      clearTimeout(this.badFrameLogTimer);
      this.badFrameLogTimer = null;
    }
    this.flushBadFrameLog();
    this.deframer.flush();
    try {
      this.port.close(() => { /* 已关闭/未打开：忽略 */ });
    } catch {
      // close 抛错不值得让进程崩（04 §8）
    }
  }

  /** 在当前 path 上以新档重开串口并接管事件（不改 preferred；由调用方决定成功后才更新） */
  private async openPortAt(baudRate: number): Promise<void> {
    if (this.portInjected && this.options.factory === undefined) {
      throw new Error("串口句柄是注入的，不支持运行时重开（请注入 SerialPortFactory 而不是 port）");
    }
    const port = await this.factory.open({
      path: this.path,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
    });
    this.portGen++;
    this.port = port;
    this.baudRateValue = baudRate;
    this.closed = false;
    // 新链路重新计时（S8 的 "连续 N 秒无有效帧" 从新口打开算起；旧口的 CRC/坏帧统计是累计诊断，不清零）
    this.openedAtMs = Date.now();
    this.lastV3FrameAtMs = 0;
    this.v3OkTimes.length = 0;
    this.v3CrcFailTimes.length = 0;
    this.rxSamples.length = 0;
    this.rxLastAtMs = 0;
    this.wirePort(port, this.portGen);
  }

  // ————————————————————————— 内部 —————————————————————————

  private wirePort(port: SerialPortLike, gen: number): void {
    port.on("data", (...args: unknown[]) => {
      if (gen !== this.portGen) return;
      const chunk = args[0];
      if (chunk instanceof Uint8Array) {
        const at = Date.now();
        this.noteRx(at, chunk.byteLength);
        // subarray 视图：定帧器会立刻拷贝整帧，不留引用（serialport 的 Buffer 可复用）
        this.deframer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
      }
    });
    port.on("error", (...args: unknown[]) => {
      if (gen !== this.portGen) return;
      this.emitError({ code: "uart-port", message: "串口 " + this.path + " 错误：" + msgOf(args[0]), fatal: false });
    });
    port.on("close", () => {
      // 旧句柄（切档时主动 close）迟到的 close 事件：交给新句柄，绝不能误标 closed
      if (gen !== this.portGen) return;
      // 串口被拔掉/被别的进程抢走：明确报一次（否则用户只看到"数据不来了"）
      if (!this.closed) {
        this.closed = true;
        this.emitError({
          code: "uart-closed",
          message: "串口 " + this.path + " 已关闭（USB 被拔出 / 端口被其它进程抢占）——数据将停止，请检查连接后重启网关",
          fatal: false,
        });
      }
      // 端口被拔/被抢占：心跳定时器必须立刻停（否则会对着已关端口继续 send）
      this.stopHeartbeat();
    });
  }

  /** 九修：启动串口链路心跳（仅 start 后且开始前端口已打开；intervalMs=0/缺省 = 关闭） */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    // BLOCK-1：切档重开/回退时端口可能已换，但 transport 未必已 start；未 start 不许起定时器。
    if (!this.running) return;
    const hb = this.options.heartbeat;
    const intervalMs = this.heartbeatIntervalMs();
    if (hb === undefined || intervalMs <= 0 || !this.port.isOpen) return;
    const timer = setInterval(() => this.heartbeatTick(), intervalMs);
    unrefTimer(timer);
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private heartbeatIntervalMs(): number {
    const hb = this.options.heartbeat;
    if (hb === undefined) return 0;
    const ms = hb.intervalMs ?? 1000;
    return ms > 0 ? ms : 0;
  }

  /** 心跳节拍：端口仍开 + 没有用户下行在飞 + 最近 1 s 没有下行写入才发 */
  private heartbeatTick(): void {
    const hb = this.options.heartbeat;
    if (hb === undefined || this.heartbeatTimer === null || !this.running || !this.open) return;
    const now = Date.now();
    if (now - this.lastDownlinkAtMs < 1000) {
      this.heartbeatSkippedRecentDownlink++;
      return;
    }
    if (hb.canSend !== undefined && !hb.canSend()) {
      this.heartbeatSkippedInFlight++;
      return;
    }
    this.heartbeatSent++;
    this.lastHeartbeatAtMs = now;
    try {
      hb.send();
    } catch (err) {
      this.emitError({ code: "uart-heartbeat", message: "串口 " + this.path + " 心跳发送失败：" + msgOf(err), fatal: false });
    }
  }

  /** 收字节记账（累计 + 最近 2 s 滑动采样；采样数组有上限，长跑不涨内存） */
  private noteRx(atMs: number, bytes: number): void {
    this.rxTotalBytes += bytes;
    this.rxLastAtMs = atMs;
    this.rxSamples.push({ at: atMs, bytes });
    const cutoff = atMs - RX_WINDOW_MS * 2;
    while (this.rxSamples.length > 0) {
      const head = this.rxSamples[0];
      if (head === undefined || head.at >= cutoff) break;
      this.rxSamples.shift();
    }
    // 极端情况（一次 chunk 狂刷）兜底：只保留最近 4096 条采样
    if (this.rxSamples.length > 4096) this.rxSamples.splice(0, this.rxSamples.length - 4096);
  }

  /** 坏帧日志聚合（S9）：同一通道 1 s 内无论多少坏帧，只发 1 条汇总 */
  private noteBadFrame(reason: "crcFail" | "badLength", detail: string): void {
    const now = Date.now();
    if (reason === "crcFail" && detail.startsWith("CRC16")) {
      this.v3CrcFailTimes.push(now);
      this.trimRecent(this.v3CrcFailTimes, now - 10_000);
    }
    this.badFrameLogTotal++;
    this.badFrameLogCount++;
    if (this.badFrameLogFirst === "") this.badFrameLogFirst = detail;
    if (this.badFrameLogTimer === null) {
      const timer = setTimeout(() => {
        this.badFrameLogTimer = null;
        this.flushBadFrameLog();
      }, 1000);
      unrefTimer(timer);
      this.badFrameLogTimer = timer;
    }
  }

  private flushBadFrameLog(): void {
    if (this.badFrameLogCount === 0) return;
    const count = this.badFrameLogCount;
    const total = this.badFrameLogTotal;
    const first = this.badFrameLogFirst;
    this.badFrameLogCount = 0;
    this.badFrameLogFirst = "";
    this.emitError({
      code: "uart-crc",
      // 每通道每秒最多 1 条：日志洪水本身就是"卡死"的一部分（用户现场每秒几十条）
      message: "串口 " + this.path + " 最近 1 s " + count + " 帧定帧/CRC 失败，累计 " + total + "；首个错误：" + first,
      fatal: false,
    });
  }

  private trimRecent(times: number[], cutoffMs: number): void {
    while (times.length > 0 && (times[0] as number) < cutoffMs) times.shift();
    if (times.length > 8192) times.splice(0, times.length - 8192);
  }

  private v3CrcFailRate(): number {
    const st = this.deframer.stats;
    const total = st.v3Frames + st.v3CrcFail;
    return total === 0 ? 0 : st.v3CrcFail / total;
  }

  private recent10s(nowMs: number): { v3Ok: number; v3CrcFail: number; total: number; failRate: number } {
    this.trimRecent(this.v3OkTimes, nowMs - 10_000);
    this.trimRecent(this.v3CrcFailTimes, nowMs - 10_000);
    const v3Ok = this.v3OkTimes.length;
    const v3CrcFail = this.v3CrcFailTimes.length;
    const total = v3Ok + v3CrcFail;
    return { v3Ok, v3CrcFail, total, failRate: total === 0 ? 0 : v3CrcFail / total };
  }

  private noteCtrl(pkt: ParsedV3): void {
    const ch = pkt.ctrlHeader;
    if (ch === null) return;
    // 串口提速：任何 CTRL（SET_PARAM ACK / GET_STATUS ACK / 心跳）带 0x91 都刷新板端读回；
    // 旧位流不带 = 保持 null，绝不用下发值顶替。
    const tlvs = interpretStatusTlvs(ch.tlv);
    if (tlvs.serialBaud !== null) this.boardBaudValue = tlvs.serialBaud;
    const waiter = this.ackWaiters.get(ch.seq);
    if (waiter !== undefined) {
      this.ackWaiters.delete(ch.seq);
      waiter(pkt);
    }
  }

  /**
   * 运行时切换串口波特率（契约 §1.5，2026-10-17）：
   * 旧档发 SET_PARAM(0x0C) → 等 ACK（必须带 0x91 读回新档）→ ≥100 ms → closePort → 新档 open
   * → GET_STATUS 最多 3×300 ms。新档失败 ⇒ 回旧档并明确报"板端已切换但主机未连上（已回退）"；
   * 旧档也不认 0x0C（旧位流）⇒ 保持原档、preferred 不改，返回 B5 降级文案。
   *
   * 失败语义：非法档/未打开抛错（调用方明确报错）；板端拒绝/超时返回 ok:false + detail（不抛）。
   */
  async switchBaud(target: number): Promise<SerialBaudSwitchResult> {
    const targetCode = serialBaudCode(target);
    if (targetCode === null) {
      throw new Error("串口波特率必须是 " + SERIAL_BAUD_RATES.join(" / ") + " 之一，收到 " + String(target));
    }
    const recordFail = (detail: string, rolledBack = false, unsupported = false): SerialBaudSwitchResult => {
      const atMs = Date.now();
      this.lastBaudSwitchValue = { ok: false, atMs, error: detail };
      this.log("[uart] 改档失败：" + detail);
      return {
        ok: false, atMs, error: detail,
        baudRate: this.baudRateValue,
        boardBaud: this.boardBaudValue,
        preferredBaud: this.preferredBaudValue,
        detail, rolledBack, unsupported,
      };
    };
    if (this.closed || !this.port.isOpen) {
      return recordFail("串口 " + this.path + " 未打开，无法切换波特率；请先切回串口通道");
    }
    const previous = this.baudRateValue;
    // 已在该档且板端读回一致：不折腾链路（重复 close/open 只会丢帧）
    if (target === previous && this.boardBaudValue === target) {
      const atMs = Date.now();
      const detail = "已是当前档 " + target + " baud（板端读回一致）";
      this.lastBaudSwitchValue = { ok: true, atMs, error: null };
      // BLOCK-1：即使链路没重开，也确保切档后心跳仍在跑（页面/网关可能刚恢复）。
      this.startHeartbeat();
      return {
        ok: true, atMs, error: null,
        baudRate: previous, boardBaud: this.boardBaudValue, preferredBaud: this.preferredBaudValue,
        detail, rolledBack: false, unsupported: false,
      };
    }

    // ① 旧档下发 0x0C，等板端 ACK（读回必须是目标档）
    const req = await this.requestBaud(target, targetCode);
    if (!req.ok) {
      return recordFail(req.detail, false, req.unsupported);
    }

    // ② 契约：ACK 全部字节发完且 TX 空闲后才切分频，主机至少等 100 ms 再关旧口
    await sleepDefault(BAUD_SWITCH_SETTLE_MS);

    // ③ 关旧档、开新档
    this.detachPort();
    try {
      await this.openPortAt(target);
    } catch (err) {
      const rollbackOk = await this.rollbackTo(previous);
      const scanHit = rollbackOk ? null : await this.scanBaudsAfterFailure();
      const detail =
        "板端已切换但主机未连上" + (rollbackOk ? "（已回退）" : "") + "：新档 " + target + " 打开失败：" + msgOf(err) +
        (rollbackOk
          ? "；已回旧档 " + previous
          : "；" + this.lastRollbackDetail + this.scanTail(scanHit));
      return recordFail(detail, rollbackOk);
    }

    // ④ 新档 GET_STATUS 3×300 ms 验证（不受 --no-handshake 影响：这是改档后的链路确认）
    const verify = await this.runHandshake({ attempts: 3, ackTimeoutMs: 300, gapMs: 120, ignoreDisabled: true });
    if (!verify.ok) {
      this.detachPort();
      const rollbackOk = await this.rollbackTo(previous);
      const scanHit = rollbackOk ? null : await this.scanBaudsAfterFailure();
      const detail =
        "板端已切换但主机未连上" + (rollbackOk ? "（已回退）" : "") + "：新档 " + target + " 无有效 ACK（" + verify.detail + "）" +
        (rollbackOk
          ? "；已回旧档 " + previous
          : "；" + this.lastRollbackDetail + this.scanTail(scanHit));
      return recordFail(detail, rollbackOk);
    }

    this.hs = verify;
    this.preferredBaudValue = target;
    // BLOCK-1：切档成功前 detachPort 已 stopHeartbeat，这里必须恢复；否则 5 s 后 live 会误判
    // 串口无有效帧并自动回退网口（现场"切完档 5 s 又跳回 UDP"的根因）。
    this.startHeartbeat();
    const atMs = Date.now();
    const boardText = this.boardBaudValue === null ? "板端未上报 0x91" : "板端读回 " + this.boardBaudValue + " baud";
    const detail = "已切换到 " + target + " baud（" + boardText + "；GET_STATUS ACK 验证通过）";
    this.lastBaudSwitchValue = { ok: true, atMs, error: null };
    this.log("[uart] " + detail);
    return {
      ok: true, atMs, error: null,
      baudRate: this.baudRateValue,
      boardBaud: this.boardBaudValue,
      preferredBaud: this.preferredBaudValue,
      detail, rolledBack: false, unsupported: false,
    };
  }

  /**
   * 旧档重新打开（改档失败回退）；返回**旧档 GET_STATUS 是否真的通过**（BLOCK-2）。
   * 只凭 openPortAt 不抛错就报"已回退"是假成功：旧档可能也收不到 ACK。失败时调用方必须
   * 进入扫描阶梯，detail 也不能出现"已回旧档"这种完成态。不改 preferred。
   */
  private async rollbackTo(previous: number): Promise<boolean> {
    this.lastRollbackDetail = "";
    try {
      await this.openPortAt(previous);
      this.hs = await this.runHandshake({ attempts: 3, ackTimeoutMs: 300, gapMs: 120, ignoreDisabled: true });
      if (!this.hs.ok) {
        this.lastRollbackDetail = "旧档 " + previous + " 无 ACK";
        this.log("[uart] 旧档 " + previous + " 重开成功但无 GET_STATUS ACK：" + this.hs.detail);
        return false;
      }
      // BLOCK-1：回退成功同样要恢复心跳，否则回退后的串口链路会被 S8 再次误判。
      this.startHeartbeat();
      return true;
    } catch (err) {
      this.closed = true;
      this.lastRollbackDetail = "旧档 " + previous + " 重开失败：" + msgOf(err);
      this.log("[uart] 旧档 " + previous + " 重开失败：" + msgOf(err));
      return false;
    }
  }

  /**
   * BLOCK-2：回退失败后的扫描阶梯（契约 §1.5：旧档也失败则进入扫描）。
   * 复用当前实例，逐档 openPortAt → 单次 GET_STATUS 250 ms 探测 → 命中后正式 3×300 ms；
   * 成功返回命中档并恢复心跳；全部失败则关闭端口、返回 null。preferred 不改（扫描不是用户选择）。
   */
  private async scanBaudsAfterFailure(): Promise<number | null> {
    this.detachPort();
    const ladder: number[] = [];
    for (const b of [this.preferredBaudValue, ...BAUD_SCAN_LADDER]) {
      if (!ladder.includes(b)) ladder.push(b);
    }
    this.baudScanState.running = true;
    this.baudScanState.tried = [];
    this.baudScanState.hit = null;
    for (const baud of ladder) {
      this.baudScanState.tried.push(baud);
      try {
        await this.openPortAt(baud);
      } catch (err) {
        this.log("[uart] 扫描 " + baud + " 打不开：" + msgOf(err));
        continue;
      }
      const probe = await this.runHandshake({
        attempts: 1,
        ackTimeoutMs: BAUD_SCAN_PROBE_TIMEOUT_MS,
        gapMs: 0,
        ignoreDisabled: true,
      });
      if (probe.ok) {
        const verify = await this.runHandshake({ attempts: 3, ackTimeoutMs: 300, gapMs: 120, ignoreDisabled: true });
        if (verify.ok) {
          this.hs = verify;
          this.baudScanState.running = false;
          this.baudScanState.hit = baud;
          this.startHeartbeat();
          this.log("[uart] 回退失败后扫描命中 " + baud + " baud，链路已恢复");
          return baud;
        }
      }
      this.detachPort();
    }
    this.baudScanState.running = false;
    this.baudScanState.hit = null;
    // R-2：终态失败必须显式失败，不能把切档前的 hs.ok=true 留在状态里（否则 UI 仍显示"握手 OK"）。
    // baudRate 回落到用户偏好档并在 statusView 里按 open=false 显示 null；最后尝试档保留在
    // baudScan.tried 里，供用户/诊断看扫描实际走过哪些档。
    this.hs = {
      ok: false,
      attempts: 0,
      detail: "回退失败后扫描未命中（已试 " + this.baudScanState.tried.join("/") + "），串口已关闭",
      rttMs: null,
    };
    this.baudRateValue = this.preferredBaudValue;
    this.closed = true;
    this.log("[uart] 回退失败后扫描未命中（已试 " + this.baudScanState.tried.join(",") + "）");
    return null;
  }

  /** 扫描结果尾句：命中=恢复事实；未命中=把实际试过的档摊开，绝不写"已回退" */
  private scanTail(hit: number | null): string {
    if (hit !== null) return "，扫描命中并恢复到 " + hit + " baud";
    return " 且扫描未命中（已试 " + this.baudScanState.tried.join("/") + "）";
  }

  /**
   * 下发 SET_PARAM 0x0C 并等 ACK；只有 ACK=OK 且 0x91 读回等于目标档才算板端已切。
   * 超时/STATUS=BAD_VALUE/缺 0x91 统一按"旧位流"降级（B5），不重试轰炸、不改 preferred。
   */
  private async requestBaud(
    target: number,
    code: number,
  ): Promise<{ ok: boolean; detail: string; unsupported: boolean }> {
    const seq = (this.hsSeq = (this.hsSeq + 1) & 0xffff);
    const pkt = await new Promise<ParsedV3 | null>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(seq);
        resolve(null);
      }, BAUD_SWITCH_ACK_TIMEOUT_MS);
      unrefTimer(timer);
      this.ackWaiters.set(seq, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      try {
        this.send(encodeDownlink(DOWNLINK.OPCODE.SET_PARAM, seq, buildSetParamPayload({ serialBaud: target })));
      } catch (err) {
        clearTimeout(timer);
        this.ackWaiters.delete(seq);
        resolve(null);
        this.log("[uart] 改档命令发送异常：" + msgOf(err));
      }
    });
    const keep = "（仍 " + this.baudRateValue + " baud）";
    if (pkt === null) {
      return {
        ok: false,
        unsupported: true,
        detail: "板端位流较旧，暂不支持调波特率" + keep + "：SET_PARAM 0x0C 在 " + BAUD_SWITCH_ACK_TIMEOUT_MS + " ms 内无 ACK",
      };
    }
    const ch = pkt.ctrlHeader;
    if (ch === null) {
      return { ok: false, unsupported: false, detail: "板端 ACK 缺少控制头，改档中止" + keep };
    }
    if (ch.status === DOWNLINK.STATUS.BAD_VALUE) {
      return {
        ok: false,
        unsupported: true,
        detail: "板端位流较旧，暂不支持调波特率" + keep + "：板端回 STATUS=0x04 BAD_VALUE（不认 tag 0x0C）",
      };
    }
    if (ch.status !== DOWNLINK.STATUS.OK) {
      return { ok: false, unsupported: false, detail: "板端拒绝调波特率" + keep + "：STATUS=0x" + ch.status.toString(16) };
    }
    const tlvs = interpretStatusTlvs(ch.tlv);
    if (tlvs.serialBaud === null) {
      return {
        ok: false,
        unsupported: true,
        detail: "板端位流较旧，暂不支持调波特率" + keep + "：SET_PARAM ACK 未携带 TLV 0x91 读回",
      };
    }
    if (tlvs.serialBaud !== target) {
      return {
        ok: false,
        unsupported: false,
        detail: "板端读回 " + tlvs.serialBaud + " baud，与请求 " + target + " baud 不一致，未切换" + keep,
      };
    }
    // 读回一致只是"板端已切换"；主机是否连得上还要走 ③④，故这里不写 preferred
    return { ok: true, unsupported: false, detail: "板端已确认切换到 " + target + " baud（0x91 读回一致）" };
  }

  /**
   * 串口握手（WIRE-U1 §3.7）：GET_STATUS(0x04) 3 次 × 间隔 500 ms、单次等 ACK 300 ms。
   * 全失败 ⇒ 明确提示"未检测到 UART v3 固件"，但**继续**收遥测帧降级显示。
   * 可传覆盖参数：open 扫描用 1×250 ms，改档后验证固定 3×300 ms（ignoreDisabled=true）。
   */
  private async runHandshake(ov?: {
    attempts?: number;
    ackTimeoutMs?: number;
    gapMs?: number;
    ignoreDisabled?: boolean;
  }): Promise<SerialHandshakeResult> {
    const hs = this.options.handshake;
    if (hs?.enabled === false && ov?.ignoreDisabled !== true) {
      return { ok: false, attempts: 0, detail: "握手已禁用（--no-handshake）", rttMs: null };
    }
    const attempts = Math.max(1, ov?.attempts ?? hs?.attempts ?? 3);
    const ackTimeoutMs = Math.max(1, ov?.ackTimeoutMs ?? hs?.ackTimeoutMs ?? 300);
    const gapMs = Math.max(0, ov?.gapMs ?? hs?.gapMs ?? 500);
    const sleep = hs?.sleep ?? sleepDefault;
    let lastDetail = "";
    for (let i = 1; i <= attempts; i++) {
      const seq = (this.hsSeq = (this.hsSeq + 1) & 0xffff);
      const t0 = Date.now();
      const acked = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.ackWaiters.delete(seq);
          resolve(false);
        }, ackTimeoutMs);
        unrefTimer(timer);
        this.ackWaiters.set(seq, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      this.send(encodeDownlink(DOWNLINK.OPCODE.GET_STATUS, seq, new Uint8Array(0)));
      const ok = await acked;
      if (ok) {
        const rtt = Date.now() - t0;
        const detail = "UART v3 固件在线（GET_STATUS ACK，第 " + i + "/" + attempts + " 次，SEQ=" + seq + "，RTT " + rtt + " ms）";
        this.log("[uart] " + detail);
        return { ok: true, attempts: i, detail, rttMs: rtt };
      }
      lastDetail = "第 " + i + "/" + attempts + " 次无 ACK（" + ackTimeoutMs + " ms 超时）";
      this.log("[uart] " + this.path + " " + lastDetail);
      if (i < attempts && gapMs > 0) await sleep(gapMs);
    }
    const detail =
      "未检测到 UART v3 固件：" + lastDetail +
      "；请确认板上位流是 UART_LINK_EN=1（当前位流 UART_LINK_EN=0 时串口不发 v3 CTRL）、" +
      "波特率 115200 8N1、串口号正确。遥测帧（AA 55 54 4D，250 ms）照常显示。";
    this.log("[uart] " + detail);
    return { ok: false, attempts, detail, rttMs: null };
  }
}
