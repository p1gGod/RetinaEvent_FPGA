// 网关装配与生命周期（04 §1/§9）：参数 → profile 校验 → 数据源 → IPC 服务 → 信号收尾。
// 为什么参数解析单独导出：它是最容易出错的边界（--replay 带不带值、缺 profile…），
// 必须能在测试里直接覆盖，而不是"起个进程试试看"。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PROFILES, formatProfileError, getProfile, validateProfile } from "@retina/protocol";
import type { IFrameSource, Profile, UartTelemFrame } from "@retina/protocol";
import { IpcHub } from "./ipc/ws.ts";
import type { BoardControl, GatewayControl } from "./ipc/ws.ts";
import { resolveResource } from "./paths.ts";
import { BaseFrameSource, unrefTimer } from "./transport/base.ts";
import { ReplayTransport } from "./transport/replay.ts";
import { SynthTransport } from "./transport/synth.ts";
import { LiveTransportManager } from "./transport/live.ts";
import type { TransportKind, TransportMode } from "./transport/select.ts";
import { DEFAULT_SERIAL_PATH } from "./transport/serial.ts";
import { createWebServer, listenWebServer } from "./ipc/http.ts";
import { handleApi, type ApiContext } from "./ipc/api.ts";
import { LatestStore } from "./pipeline/latest.ts";
import { DEFAULT_RECORD_ROOT, Recorder } from "./record/recorder.ts";
import { handleRec } from "./record/api.ts";

export type SourceKind = "replay" | "synth" | "udp" | "uart";

export interface CliOptions {
  readonly profile: string;
  readonly kind: SourceKind;
  /** --replay 的容器路径；缺省用 testdata/golden/g01_min_frame.rtpkt */
  readonly replayPath: string | null;
  readonly wsPort: number;
  readonly bind: string | null;
  readonly port: number | null;
  /** <=0 = 全速（回放回归）；>0 = 倍速 */
  readonly speed: number;
  /** 回放默认循环（演示时浏览器随时连上都有画面）；--no-loop 关掉 */
  readonly loop: boolean;
  /** 回放默认等第一个浏览器客户端连上再开播；--start-now 关掉 */
  readonly waitClient: boolean;
  /** 0 = 无限 */
  readonly synthFrames: number;
  readonly synthEvents: number;
  /**
   * 传输方式选择（UART 路线）：udp（默认）/ uart / auto（先网口后串口，WIRE-U1 §5.3）。
   * 缺省由 kind 推得：--serial ⇒ uart，其余 ⇒ udp。**可选**（回放/合成源不涉及）。
   */
  readonly transport?: TransportMode | undefined;
  /** 串口号（--serial 的取值；缺省 COM6 —— 用户 2026-10-12 现场口径） */
  readonly serialPath?: string | undefined;
  /** 串口波特率（缺省 115200；460800/921600 需板端同档位重编比特流，设计 §3.6 阶段④） */
  readonly serialBaud?: number | undefined;
  /** 内核 UDP 接收缓冲（MB；缺省 16 MB —— P0 报告 §5.4 的掉帧复盘，可调回 4 对比） */
  readonly recvBufMb?: number | undefined;
  /** auto 模式等 UDP 首包的时长（ms；缺省 1500） */
  readonly udpProbeMs?: number | undefined;
  /**
   * 是否同时把构建好的界面端出来（一个进程 = 后端 + 界面）。
   * 缺省 false：**库调用**（测试/嵌入）不该悄悄起一个网站；CLI 会显式给 true。
   */
  readonly serve?: boolean;
  readonly serveDir?: string | null;
  /** --record：网关启动即开录（不依赖浏览器）；缺省只暴露 /rec/*，由界面/脚本决定何时开录 */
  readonly record?: boolean | undefined;
  readonly recordRoot?: string | undefined;
  /** 分段时长（分钟，可小数；缺省 5）；只影响新分段，不重切当前段 */
  readonly recordChunkMin?: number | undefined;
  /** x264 CRF（0..51；缺省 23） */
  readonly recordCrf?: number | undefined;
  /** 编码器（缺省 libx264） */
  readonly recordEncoder?: string | undefined;
  /** 额外落 .raw 原始帧（调试用；默认关闭，避免磁盘爆掉） */
  readonly recordRaw?: boolean | undefined;
  /** ffmpeg 可执行文件路径覆盖（缺省从 PATH 找 ffmpeg） */
  readonly ffmpegPath?: string | undefined;
  readonly help: boolean;
}

export type ParseResult = { readonly ok: true; readonly options: CliOptions } | { readonly ok: false; readonly error: string };

// 默认必须是**与 RTL 实际参数一致**的那一个，否则「接开发板」开箱即黑屏。
// RTL `udp_merge.v` 默认 RAW_CHUNK=1280 / 600 包 / CRC16 必带 ⇒ retina-v2-800x480-1280。
export const DEFAULT_PROFILE = "retina-v2-800x480-1280";
export const DEFAULT_WS_PORT = 8787;
export const DEFAULT_REPLAY = "testdata/golden/g01_min_frame.rtpkt";

export const USAGE = [
  "用法: node --experimental-strip-types gateway/src/main.ts [选项]",
  "",
  "  --profile <name>   解析 profile（默认 " + DEFAULT_PROFILE + "）",
  "                     可用: " + Object.keys(BUILTIN_PROFILES).join(" / "),
  "  --replay [path]    回放 RTPKT 容器（缺省 " + DEFAULT_REPLAY + "）",
  "  --synth            合成数据源（无板演示/冒烟）",
  "  --udp              实时 UDP 数据源（用 profile.udp 的绑定/端口）",
  "  --serial [COMx]    串口数据源（UART 路线；缺省 COM6，115200 8N1 无流控）",
  "  --serial-baud <n>  串口波特率（缺省 115200；460800/921600 需板端同档重编，设计 §3.6 阶段④）",
  "  --transport <t>    传输方式：udp / uart / auto（auto=先网口后串口，网口不在则只事件回传）",
  "  --recv-buf <MB>    UDP 内核接收缓冲（缺省 16 MB；P0 报告 §5.4 的装配掉帧复盘参数）",
  "  --udp-probe <ms>   auto 模式下等网口首包的时长（缺省 1500）",
  "  --bind <ip>        UDP 绑定位（默认取 profile，板侧 PC_IP 写死，见 02 §4）",
  "  --port <n>         UDP 端口（默认取 profile）",
  "  --ws-port <n>      WS 监听端口（默认 " + DEFAULT_WS_PORT + "，只绑 127.0.0.1）",
  "  --speed <x>        回放/合成倍速；<=0 = 全速",
  "  --loop / --no-loop 回放是否循环（默认循环：演示时浏览器随时连上都有画面）",
  "  --start-now        回放不等浏览器，立刻开播（默认等第一个客户端连上）",
  "  --frames <n>       合成帧数（0 = 无限）",
  "  --events <n>       合成每帧事件数",
  "  --serve [dir]      同时端出构建好的界面（默认自动找 web/dist）",
  "  --no-serve         只开 WS，不服务界面（给「纯后端 / 嵌入式」用法）",
  "  --record           启动即开长录（RGB565→H.264 分段 MP4 + 事件/帧 CSV）",
  "  --record-root <d>  长录根目录（缺省 " + DEFAULT_RECORD_ROOT + "）",
  "  --record-chunk-min <m>  分段时长分钟数（缺省 5，可小数）",
  "  --record-crf <n>   x264 CRF（缺省 23，范围 0..51）",
  "  --record-encoder <e>  编码器（缺省 libx264）",
  "  --record-raw       额外保存逐帧 .raw（调试用，占空间大）",
  "  --ffmpeg <path>    ffmpeg 可执行文件覆盖（缺省用 PATH 上的 ffmpeg）",
  "  -h, --help         打印本帮助",
].join("\n");

function intOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 纯函数，不读 process.argv（测试直接喂数组） */
export function parseArgs(argv: readonly string[]): ParseResult {
  let profile = DEFAULT_PROFILE;
  let kind: SourceKind | null = null;
  let replayPath: string | null = null;
  let wsPort = DEFAULT_WS_PORT;
  let bind: string | null = null;
  let port: number | null = null;
  let speed = 1;
  let serve = true;
  let serveDir: string | null = null;
  // 回放默认循环：单槽帧总线只保最新帧，一次性跑完的话后连上的浏览器只能看到黑屏
  let loop = true;
  let waitClient = true;
  let synthFrames = 0;
  let synthEvents = 0;
  let transport: TransportMode | null = null;
  let serialPath: string | null = null;
  let serialBaud: number | null = null;
  let recvBufMb: number | null = null;
  let udpProbeMs: number | null = null;
  let record = false;
  let recordRoot: string | null = null;
  let recordChunkMin: number | null = null;
  let recordCrf: number | null = null;
  let recordEncoder: string | null = null;
  let recordRaw = false;
  let ffmpegPath: string | null = null;
  let help = false;

  const valueAt = (i: number): string | undefined => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--profile") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--profile 需要一个 profile 名" };
      profile = v;
      i++;
      continue;
    }
    if (a === "--replay") {
      kind = "replay";
      // --replay 的值可选：下一个不是选项就当路径（package.json 的 gateway:replay 就是裸 --replay）
      const v = valueAt(i);
      if (v !== undefined && !v.startsWith("-")) {
        replayPath = v;
        i++;
      }
      continue;
    }
    if (a === "--synth") {
      kind = "synth";
      continue;
    }
    if (a === "--udp") {
      kind = "udp";
      continue;
    }
    if (a === "--serial") {
      // UART 路线数据源（WIRE-U1 §8.2 H4）：值可选 —— 裸 --serial 用缺省 COM6
      kind = "uart";
      const v = valueAt(i);
      if (v !== undefined && !v.startsWith("-")) {
        serialPath = v;
        i++;
      }
      continue;
    }
    if (a === "--serial-baud") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--serial-baud 需要一个波特率" };
      const b = intOf(v, -1);
      if (b < 1200 || b > 2_000_000) return { ok: false, error: "--serial-baud 非法（1200..2000000，CH340 上限 2 Mbps）: " + v };
      serialBaud = b;
      i++;
      continue;
    }
    if (a === "--transport") {
      const v = valueAt(i);
      if (v !== "udp" && v !== "uart" && v !== "auto") {
        return { ok: false, error: "--transport 只能是 udp / uart / auto，收到: " + String(v) };
      }
      transport = v;
      // 显式传输方式同时钉住"初始候选源"：uart ⇒ 串口，udp/auto ⇒ 网口（auto 先网口后串口）
      if (v === "uart") kind = "uart";
      else if (v === "udp" || v === "auto") kind = kind === "uart" ? "uart" : "udp";
      i++;
      continue;
    }
    if (a === "--recv-buf") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--recv-buf 需要一个 MB 数" };
      const mb = Number.parseFloat(v);
      if (!Number.isFinite(mb) || mb <= 0) return { ok: false, error: "--recv-buf 非法: " + v };
      recvBufMb = mb;
      i++;
      continue;
    }
    if (a === "--udp-probe") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--udp-probe 需要一个毫秒数" };
      udpProbeMs = intOf(v, -1);
      if (udpProbeMs <= 0) return { ok: false, error: "--udp-probe 非法: " + v };
      i++;
      continue;
    }
    if (a === "--bind") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--bind 需要一个地址" };
      bind = v;
      i++;
      continue;
    }
    if (a === "--port") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--port 需要一个端口号" };
      port = intOf(v, -1);
      if (port < 0 || port > 65535) return { ok: false, error: "--port 非法: " + v };
      i++;
      continue;
    }
    if (a === "--ws-port") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--ws-port 需要一个端口号" };
      wsPort = intOf(v, -1);
      if (wsPort < 0 || wsPort > 65535) return { ok: false, error: "--ws-port 非法: " + v };
      i++;
      continue;
    }
    if (a === "--speed") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--speed 需要一个数字" };
      speed = Number.parseFloat(v);
      if (!Number.isFinite(speed)) return { ok: false, error: "--speed 非法: " + v };
      i++;
      continue;
    }
    if (a === "--loop") {
      loop = true;
      continue;
    }
    if (a === "--no-loop") {
      loop = false;
      continue;
    }
    if (a === "--start-now" || a === "--no-wait") {
      waitClient = false;
      continue;
    }
    if (a === "--wait-client") {
      waitClient = true;
      continue;
    }
    if (a === "--frames") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--frames 需要一个整数" };
      synthFrames = intOf(v, 0);
      i++;
      continue;
    }
    if (a === "--events") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--events 需要一个整数" };
      synthEvents = intOf(v, 0);
      i++;
      continue;
    }
    if (a === "--record") {
      record = true;
      continue;
    }
    if (a === "--record-root") {
      const v = valueAt(i);
      if (v === undefined || v.startsWith("-")) return { ok: false, error: "--record-root 需要一个目录" };
      recordRoot = v;
      i++;
      continue;
    }
    if (a === "--record-chunk-min") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--record-chunk-min 需要分钟数" };
      const m = Number.parseFloat(v);
      if (!Number.isFinite(m) || m <= 0 || m > 1440) return { ok: false, error: "--record-chunk-min 非法（0 < m <= 1440）: " + v };
      recordChunkMin = m;
      i++;
      continue;
    }
    if (a === "--record-crf") {
      const v = valueAt(i);
      if (v === undefined) return { ok: false, error: "--record-crf 需要 0..51" };
      const c = intOf(v, -1);
      if (c < 0 || c > 51) return { ok: false, error: "--record-crf 非法（0..51）: " + v };
      recordCrf = c;
      i++;
      continue;
    }
    if (a === "--record-encoder") {
      const v = valueAt(i);
      if (v === undefined || v.trim() === "") return { ok: false, error: "--record-encoder 需要一个编码器名" };
      recordEncoder = v;
      i++;
      continue;
    }
    if (a === "--record-raw") {
      recordRaw = true;
      continue;
    }
    if (a === "--ffmpeg") {
      const v = valueAt(i);
      if (v === undefined || v.trim() === "") return { ok: false, error: "--ffmpeg 需要一个可执行文件路径" };
      ffmpegPath = v;
      i++;
      continue;
    }
    if (a === "--serve") {
      const v = valueAt(i);
      if (v !== undefined && !v.startsWith("-")) { serveDir = v; i++; } else serveDir = null;
      serve = true;
      continue;
    }
    if (a === "--no-serve") { serve = false; continue; }
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: "未知参数: " + a };
    // 裸路径：等价于 --replay <path>
    kind = "replay";
    replayPath = a;
  }
  return {
    ok: true,
    options: {
      profile,
      kind: kind ?? "synth",
      replayPath,
      wsPort,
      bind,
      port,
      speed,
      loop,
      waitClient,
      synthFrames,
      synthEvents,
      ...(transport === null ? {} : { transport }),
      ...(serialPath === null ? {} : { serialPath }),
      ...(serialBaud === null ? {} : { serialBaud }),
      ...(recvBufMb === null ? {} : { recvBufMb }),
      ...(udpProbeMs === null ? {} : { udpProbeMs }),
      serve,
      serveDir,
      ...(record ? { record: true } : {}),
      ...(recordRoot === null ? {} : { recordRoot }),
      ...(recordChunkMin === null ? {} : { recordChunkMin }),
      ...(recordCrf === null ? {} : { recordCrf }),
      ...(recordEncoder === null ? {} : { recordEncoder }),
      ...(recordRaw ? { recordRaw: true } : {}),
      ...(ffmpegPath === null ? {} : { ffmpegPath }),
      help,
    },
  };
}

export function resolveProfile(name: string): Profile {
  const p = getProfile(name);
  if (p === null) {
    throw new Error("未知 profile: " + name + "；可用: " + Object.keys(BUILTIN_PROFILES).join(", "));
  }
  const check = validateProfile(p);
  if (!check.ok) throw new Error(formatProfileError(p, check));
  return p;
}

/** UdpTransport 的 v3 钩子（CTRL 包出口 + MODE 观察）；构造时闭包引用稍后创建的 V3Link */
export interface UdpV3Hooks {
  readonly onCtrl: (pkt: import("@retina/protocol").ParsedV3) => void;
  readonly onV3Mode: (mode: number) => void;
}

export function createSource(
  options: CliOptions,
  profile: Profile,
  log: (msg: string) => void = () => {},
  _udpV3Hooks?: UdpV3Hooks,
): IFrameSource {
  if (options.kind === "replay") {
    const p = options.replayPath === null ? resolveResource(DEFAULT_REPLAY) : options.replayPath;
    return new ReplayTransport({
      profile,
      path: p,
      speed: options.speed,
      loop: options.loop,
      onLoaded: (packets, bytes) => log("回放容器载入: " + packets + " 包 / " + bytes + " B (" + p + ")"),
    });
  }
  if (options.kind === "udp" || options.kind === "uart") {
    // 实时源（UDP / 串口）由 LiveTransportManager 建立：探测、握手、下行 sink、V3Link 都在那边接线。
    // 保留本函数只服务回放/合成（库调用/测试），实时路径禁止走这里（否则 v3 下发链路是断的）。
    throw new Error(
      "实时数据源（" + options.kind + "）请用 LiveTransportManager.create()（runGateway 已如此接线），" +
      "createSource 只服务回放/合成源",
    );
  }
  return new SynthTransport({
    profile,
    speed: options.speed,
    maxFrames: options.synthFrames,
    eventsPerFrame: options.synthEvents,
  });
}

export interface RunningGateway {
  readonly hub: IpcHub;
  readonly source: IFrameSource;
  /** 长录记录器：/rec/* 与 --record 共用同一个实例 */
  readonly recorder: Recorder;
  readonly profile: Profile;
  /** 控制面实现；爆出来便于嵌入/测试直接调（WS 侧只是它的转发者） */
  readonly control: GatewayControl;
  /** 界面地址（--serve 生效时非 null）：启动器与用户都看它 */
  readonly uiUrl: string | null;
  close(): Promise<void>;
}

/**
 * 串口动作状态轮询周期（ms）。
 *
 * 为什么是 1 Hz：串口链路没有原始帧，动作真值只能靠 GET_STATUS(0x04) ACK 尾部的 TLV 0x92
 * 读回（downlink_cmd.v ★M4b，CTRL_LEN=71）；RTL 的动作锁存按 1 s 空窗语义刷新，1 Hz 已能
 * 保证"UDP 帧流停了，/api/action 也不超过 1 s 陈旧"。
 */
export const UART_STATUS_POLL_MS = 1000;

/** 心跳 ACK 的"新鲜"窗口（ms）：这段时间内有过一次 GET_STATUS ACK 就不补发（缺省 900 = 1 Hz 的 90%） */
export const UART_STATUS_POLL_HEARTBEAT_FRESH_MS = 900;

/** startUartStatusPoll 需要的最小链路形状：只列轮询真正用到的成员，测试可直接给假对象 */
export interface StatusPollLink {
  readonly inFlight: number;
  readonly seenV3: boolean;
  getStatus(opts?: { readonly heartbeat?: boolean; readonly silent?: boolean }): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** V3Link 自有成员；假对象可以不给（缺省视为"心跳从没 ACK 过" ⇒ 轮询接管） */
  readonly heartbeatStats?: () => { readonly lastAckAtMs: number | null };
}

export interface StatusPollSource {
  readonly kind: string;
  readonly v3link: StatusPollLink;
}

export interface StatusPollHandle {
  stop(): void;
  /** 已发出的 GET_STATUS 条数（诊断/测试用） */
  readonly polls: number;
}

/**
 * 串口通道的 1 Hz 动作状态轮询（2026-10-31，串口动作实时显示收尾）。
 *
 * 缺的是什么：串口没有原始帧，UDP 帧流一停（或现场安静、板端不发事件帧），`/api/action`
 * 就冻在最后一次快照上。GET_STATUS 的 ACK 是唯一能主动"拉"一次动作真值的手段。
 *
 * 为什么只 gate 在 uart：
 *   · UDP/回放的动作字节随每个数据包到达（processor 每包 observe），再轮询纯属多余流量；
 *   · 回放/合成根本没有板子和下行通道（`live === null`），UDPSink 之外也没有串口。
 *
 * 为什么 silent：1 Hz 的 ACK 若照常 emitCtrlEvent，面板「最近命令」会被状态查询刷屏，
 * ackTracker 也会把自动轮询算成用户操作。silent 只掐推送，SEQ/ACK/超时语义不变。
 *
 * 为什么还要看心跳（2026-10-31 task-7 修过一次）：SerialTransport 的心跳本来就是 1 Hz 的
 * GET_STATUS，且带 `now - lastDownlinkAtMs < 1000 ⇒ 本次跳过` 的闸门。**两件事必须分清**：
 *   · 心跳"启用/关闭"是**配置**（`serialHeartbeatMs` 缺省 1000、observer 旁路为 0）——只能读配置，
 *     不能靠"最近 ACK 时刻"判断：并行的 1 Hz 轮询会把 `lastDownlinkAtMs` 永远压在 1 s 内，心跳
 *     每拍被 `skippedRecentDownlink` 吞掉 ⇒ `heartbeat.sent/ack` 永久冻在 0；而心跳饿死后
 *     `lastAckAtMs` 永远不新鲜，靠 ACK 新鲜度做的守卫也就一起失效（鸡生蛋，8787 活体实测 25 s
 *     出现 sent=0 / skippedRecentDownlink=25）。所以**心跳在位 ⇒ 本定时器一次下行都不发**。
 *   · `heartbeatStats().lastAckAtMs` 只作为**二次保险**（心跳关掉后仍可能有一两个 ACK 尾巴在飞，
 *     或心跳与轮询交接的那一秒），窗口 900 ms 内刚 ACK 过就不重复发。
 * 心跳被关闭（`serialHeartbeatMs=0`、observer 旁路、握手期 `heartbeatStats` 恒 null）时由本定时器
 * 接管 —— 两种情况下 `/api/action` 的陈旧度都不超过一个轮询周期。
 */
export function startUartStatusPoll(deps: {
  readonly getLive: () => StatusPollSource | null;
  readonly intervalMs?: number;
  readonly log?: (msg: string) => void;
  readonly nowMs?: () => number;
  readonly heartbeatFreshMs?: number;
  /**
   * 串口传输层心跳是否启用（配置口径）。缺省 undefined = "没有心跳"⇒ 轮询照常跑（测试与
   * 无心跳接线都走这条）；main.ts 接线时注入 `statusView().uart.heartbeat.enabled`。
   */
  readonly heartbeatEnabled?: () => boolean;
  /** 心跳间隔 ms（0 = 关闭）。只在 heartbeatEnabled() 为真时才有意义，缺省按 1 Hz 算 */
  readonly heartbeatIntervalMs?: () => number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (t: unknown) => void;
}): StatusPollHandle {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const freshMs = deps.heartbeatFreshMs ?? UART_STATUS_POLL_HEARTBEAT_FRESH_MS;
  // DOM 与 Node 两套 lib 的 setInterval 返回类型不同（number / Timeout）⇒ 统一当 unknown 传
  const setIntervalFn: (fn: () => void, ms: number) => unknown =
    deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn: (t: unknown) => void =
    deps.clearIntervalFn ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let polls = 0;
  /** 连续未确认次数（成功一次归零；日志只在第 1 次与每 60 次打一条，避免链断时刷屏） */
  let consecutiveFails = 0;

  const tick = (): void => {
    const live = deps.getLive();
    if (live === null || live.kind !== "uart") return;
    // task-7：串口传输层心跳在位 ⇒ 完全让位（本定时器零下行）。理由见函数头注释：
    // 心跳自己就是 1 Hz GET_STATUS，而 SerialTransport 的"最近 1 s 有下行就跳过"闸门
    // 会让并行的轮询把它饿死（sent/ack 冻在 0、面板健康度失真）。
    if (deps.heartbeatEnabled?.() === true && (deps.heartbeatIntervalMs?.() ?? UART_STATUS_POLL_MS) > 0) return;
    const link = live.v3link;
    // S8 / 旧固件保护：用户命令在飞时不插队（原语义），没见过 v3 上行（v2 固件）时不发，
    // 否则只会在板端刷 dlReject 计数（V3Link.tryTakeCalSlot 同一口径）。
    if (!link.seenV3 || link.inFlight > 0) return;
    const hbAckAtMs = link.heartbeatStats?.().lastAckAtMs ?? null;
    if (hbAckAtMs !== null && nowMs() - hbAckAtMs <= freshMs) return;
    polls += 1;
    // 不重试：ACK 超时只记日志。链路断开的判定归心跳/握手，重试会掩盖真实原因。
    void link.getStatus({ silent: true }).then(
      (r) => {
        if (r.ok) {
          consecutiveFails = 0;
          return;
        }
        consecutiveFails += 1;
        if (consecutiveFails === 1 || consecutiveFails % 60 === 0) {
          deps.log?.("[uart-poll] GET_STATUS 未确认（连续 " + consecutiveFails + " 次）：" + r.detail);
        }
      },
      (err: unknown) => {
        consecutiveFails += 1;
        if (consecutiveFails === 1) {
          deps.log?.("[uart-poll] GET_STATUS 发送失败：" + (err instanceof Error ? err.message : String(err)));
        }
      },
    );
  };

  const timer = setIntervalFn(tick, deps.intervalMs ?? UART_STATUS_POLL_MS);
  unrefTimer(timer);
  return {
    stop: () => clearIntervalFn(timer),
    get polls() {
      return polls;
    },
  };
}

export async function runGateway(
  options: CliOptions,
  log: (msg: string) => void = (m) => console.log("[gateway] " + m),
): Promise<RunningGateway> {
  // profile 校验失败必须拒绝启动（04 §9）；这里抛错，由 main 打印成 [FATAL]
  const profile = resolveProfile(options.profile);

  // —— 实时数据面（UDP / UART / auto）：一条通道 = 源 + 下行 sink + V3Link（transport/live.ts）。
  //    回放/合成源走老路径（不需要下发通道、不需要探测）。
  const mode: TransportMode = options.transport ?? (options.kind === "uart" ? "uart" : "udp");
  const isLive = options.kind === "udp" || options.kind === "uart" || options.transport === "auto";
  // hub 在下面才创建，但探测/切换回调要引用它 ⇒ 用可变引用（切换数据面 = hub.switchSource）
  const hubRef: { hub: IpcHub | null } = { hub: null };
  let live: LiveTransportManager | null = null;
  let calTimer: ReturnType<typeof setInterval> | null = null;
  let statusPoll: StatusPollHandle | null = null;
  if (isLive) {
    live = await LiveTransportManager.create({
      profile,
      mode,
      bind: options.bind,
      port: options.port,
      ...(options.recvBufMb === undefined ? {} : { recvBufferSize: Math.round(options.recvBufMb * 1024 * 1024) }),
      ...(options.serialPath === null || options.serialPath === undefined ? {} : { serialPath: options.serialPath }),
      ...(options.serialBaud === undefined ? {} : { serialBaud: options.serialBaud }),
      ...(options.udpProbeMs === undefined ? {} : { udpProbeMs: options.udpProbeMs }),
      onSourceChange: (s) => hubRef.hub?.switchSource(s),
      onV3Link: (link) => {
        // 命令/校准事件 → TYPE_CTRL 推流（WIRE-V3 §7.2；切通道后新 link 也要接上）
        link.onCtrlEvent = (e) => hubRef.hub?.pushCtrlEvent(e);
      },
      onTelemetry: (t: UartTelemFrame, _raw, atMs) => {
        // 遥测帧（250 ms，帧型 A）→ TYPE_CTRL：串口连接卡直读 ev/act/cr（WIRE-U1 §8.2 H7）
        hubRef.hub?.pushCtrlEvent({ kind: "uartTelemetry", ...t, atMs });
      },
      onText: (line) => hubRef.hub?.pushCtrlEvent({ kind: "uartText", line }),
      log,
    });
    calTimer = setInterval(() => live?.v3link.maybeCalibrate(), 1000);
    unrefTimer(calTimer);
    // 串口动作状态轮询（2026-10-31）：只在 uart 通道真发 GET_STATUS，UDP/合成路径不产生任何流量。
    // task-7：心跳在位时轮询必须完全让位。判据取**配置**（SerialTransport.statusView() 的
    // heartbeat.enabled/intervalMs，与 /api/stats 的 transport.uart.heartbeat 同源），而不是
    // "最近一次心跳 ACK 时刻"：心跳一旦被并行的 1 Hz 下行饿死，lastAckAtMs 就永远不新鲜（鸡生蛋）。
    // 读不到（udp 主通道、初始化瞬间）一律当"没有心跳"⇒ 由轮询自己覆盖 /api/action。
    const heartbeatConfig = (): { enabled: boolean; intervalMs: number } | null => {
      if (live === null) return null;
      try {
        const hb = live.statusView().uart?.["heartbeat"];
        if (typeof hb !== "object" || hb === null) return null;
        const v = hb as { enabled?: unknown; intervalMs?: unknown };
        return { enabled: v.enabled === true, intervalMs: typeof v.intervalMs === "number" ? v.intervalMs : 0 };
      } catch {
        return null;
      }
    };
    statusPoll = startUartStatusPoll({
      getLive: () => live,
      log: (m) => log(m),
      heartbeatEnabled: () => heartbeatConfig()?.enabled === true,
      heartbeatIntervalMs: () => heartbeatConfig()?.intervalMs ?? 0,
    });
    log(
      "数据通道 = " + live.kind + "（模式 " + mode + "）：" + live.decision.reason +
      (live.kind === "udp" ? " 下行 → " + profile.udp.board + ":1235" : " 命令/校准 over " + (options.serialPath ?? DEFAULT_SERIAL_PATH)),
    );
  }
  const source = live !== null ? live.source : createSource(options, profile, log);

  // 长录记录器（task-30）：无论是否 --record 都创建，/rec/* 才能随时开录；
  // 不订阅日历/磁盘检查，只有 start() 之后才产生 IO，空闲时零开销。
  const recorder = new Recorder({
    profile,
    ...(options.recordRoot === undefined ? {} : { root: options.recordRoot }),
    ...(options.recordChunkMin === undefined ? {} : { chunkMs: Math.round(options.recordChunkMin * 60_000) }),
    ...(options.recordCrf === undefined ? {} : { crf: options.recordCrf }),
    ...(options.recordEncoder === undefined ? {} : { encoder: options.recordEncoder }),
    ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
    rawDump: options.recordRaw === true,
    log: (m) => log(m),
  });

  const runtime = {
    bind: options.bind ?? profile.udp.bind,
    port: options.port ?? profile.udp.port,
    wsPort: options.wsPort,
  };

  // 静态界面：默认开启。一个进程同时是「后端 + 界面」，浏览器与 WS 同源 ⇒ 用户只需一个网址。
  // 这也是将来单 exe 的形态（host/docs/04 §11）：exe 起来之后自带界面。
  const HOST = "127.0.0.1";
  const distDir = options.serveDir ?? path.resolve(import.meta.dirname, "../../web/dist");
  // 最新帧/事件的单槽存储：WS 推给浏览器，/api/* 给"别的进程来拉"，两者共用这一份
  const store = new LatestStore();
  let webServer: import("node:http").Server | null = null;
  let uiUrl: string | null = null;
  if (options.serve === true) {
    const apiCtx: ApiContext = {
      store,
      profile,
      getStats: () => hub.lastStatsSnapshot(),
      getCounters: () => hub.countersSnapshot(),
      getConfig: () => control.getConfig(),
      startedAtMs: Date.now(),
      sourceInfo: source.info,
      uiUrl: null,
    };
    webServer = createWebServer({
      root: distDir,
      api: (req, res, url) => handleApi(req, res, url, { ...apiCtx, uiUrl }),
      rec: (req, res, url) => handleRec(req, res, url, recorder),
      log,
    });
    runtime.wsPort = await listenWebServer(webServer, HOST, options.wsPort);
    uiUrl = "http://" + HOST + ":" + runtime.wsPort + "/";
  }
  // —— 下行命令 / 校准：UDP 与 UART 共用同一个 V3Link（传输无关，WIRE-U1 §1.2 原则 3）——
  const boardControl: BoardControl | undefined = live === null
    ? undefined
    : {
        setParam: (p) => live!.v3link.setParam(p),
        setMode: (m) => live!.v3link.setMode(m),
        getStatus: () => live!.v3link.getStatus(),
        calibrate: () => live!.v3link.calibrate(),
        evEn: (enabled) => live!.v3link.evEn(enabled),
        status: () => live!.v3link.statusView(),
      };
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({
      profile: profile.name,
      wire: profile.wire,
      source: live === null ? options.kind : live.kind,
      transport: live === null ? null : live.statusView(),
      transportMode: live === null ? null : live.decision.mode,
      // A5：主数据面（udp|uart|null）。transportMode 是启动参数（--udp/--serial/--transport auto），
      // 两者不是一回事：切到串口后 transportMode 仍是启动时的 "udp"。
      active: live === null ? null : live.decision.active,
      serialPort: live === null ? null : (options.serialPath ?? DEFAULT_SERIAL_PATH),
      // B：回显"用户偏好档位"，而不是启动参数 —— 扫描/切档成功后必须一致
      serialBaud: live === null ? null : live.preferredBaud,
      recvBufMb: options.recvBufMb ?? 16,
      // 实际生效的内核缓冲（系统可能夹到上限）：比"我设了多少"诚实（udp.ts 同口径）
      recvBufActualMb: (() => {
        const src = live?.source as { recvBufferSizeActual?: number | null } | undefined;
        const v = src?.recvBufferSizeActual ?? null;
        return v === null ? null : Math.round((v / 1024 / 1024) * 100) / 100;
      })(),
      bind: runtime.bind,
      port: runtime.port,
      wsPort: runtime.wsPort,
      chunksPerFrame: profile.chunksPerFrame,
      evRecBytes: profile.evRecBytes,
    }),
    setConfig: (patch) => {
      const applied: string[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === "profile") throw new Error("profile 不支持热切换（会改变段长/段数/事件记录长度），请重启网关");
        if (k === "bind" && typeof v === "string") {
          runtime.bind = v;
          applied.push(k);
          continue;
        }
        if (k === "port" && typeof v === "number") {
          runtime.port = v;
          applied.push(k);
          continue;
        }
        if (k === "wsPort" && typeof v === "number") {
          runtime.wsPort = v;
          applied.push(k);
          continue;
        }
        if (k === "serialPort" && typeof v === "string") {
          if (live === null) throw new Error("当前数据源（" + options.kind + "）不是实时源，串口号无意义");
          live.updateSerialPath(v);
          applied.push(k);
          continue;
        }
        if (k === "transport") throw new Error("传输方式切换请用 config.set {transport}（网关内部按异步切换处理），不要直接改配置");
        throw new Error("config.set 不支持的键: " + k);
      }
      return { ...runtime, applied, note: "绑定/端口的修改需重启网关后生效（M2 不做运行时重绑）" };
    },
    ...(live === null ? {} : {
      /** 传输/串口状态视图：随 STATS 1 Hz 上屏（前端"传输方式"卡片） */
      transportView: () => live!.statusView() as unknown as Record<string, unknown>,
      /** B：串口波特率切档（前端下拉 / config.set {serialBaud}）；失败抛错，前端 toast 原因 */
      setSerialBaud: async (baud) => {
        const view = await live!.switchSerialBaud(baud);
        return view as unknown as Record<string, unknown>;
      },
      /** UI 的"传输方式"选择（UDP/UART/自动）：先建后拆，失败则明确报错且当前通道不动 */
      switchTransport: async (want) => {
        if (want.serialPort !== undefined && want.serialPort !== "") live!.updateSerialPath(want.serialPort);
        if (want.transport === "auto") {
          // A3：真正的自动 —— 先 UDP 探测（等首包），再试串口；失败保留当前通道并报原因。
          // 修前这里算成 (decision.active ?? kind)，点「自动」在 active=uart 时永远是空操作。
          await live!.switchAuto();
          return { ...live!.statusView() };
        }
        const target: TransportKind | null =
          want.transport === undefined
            ? null
            : (want.transport === "uart" ? "uart" : want.transport === "udp" ? "udp" : null);
        if (want.transport !== undefined && target === null) {
          throw new Error("transport 只能是 udp / uart / auto，收到 " + String(want.transport));
        }
        if (target !== null) await live!.switchTo(target, { force: want.force === true });
        return { ...live!.statusView() };
      },
    }),
    snapshot: () => ({
      sourceKind: live === null ? options.kind : live.kind,
      replayPath: options.replayPath,
      loop: options.loop,
      speed: options.speed,
      bind: runtime.bind,
      port: runtime.port,
      wsPort: runtime.wsPort,
      ...(boardControl === undefined ? {} : { boardDownlink: true }),
      ...(live === null ? {} : { transport: live.statusView(), serialPort: options.serialPath ?? DEFAULT_SERIAL_PATH }),
    }),
    ...(boardControl === undefined ? {} : { board: boardControl }),
  };

  const counters = source instanceof BaseFrameSource ? source.counters : undefined;
  // 回放演示：浏览器打开再开播。否则 750 包在启动瞬间跑完，客户端连上只能看到统计（M1 验收就黄了）。
  // 实时 UDP/串口必须立刻收（板子不会等人）—— 实时源在 LiveTransportManager 建立时就已 start。
  const deferStart = options.kind === "replay" && options.waitClient;
  const hub = new IpcHub({
    port: runtime.wsPort,
    ...(webServer === null ? {} : { server: webServer }),
    profile,
    source,
    control,
    store,
    recorder,
    ...(counters === undefined ? {} : { counters }),
    ...(deferStart ? { onFirstClient: () => source.start() } : {}),
    log: (m) => log(m),
  });
  hubRef.hub = hub;
  await hub.ready();
  if (options.record === true) {
    try {
      const st = await recorder.start();
      log("长录已开始: " + (st.session ?? "?") + "（根目录 " + st.root + "）");
    } catch (err) {
      // 录制失败不能让网关崩：界面仍可看流，错误进日志与会话状态
      log("[record] 启动失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  // 启动期可能已建过 link（bootstrap 里握手/探测时）：补一次接线，切通道时 onV3Link 会再挂
  if (live !== null) live.v3link.onCtrlEvent = (e) => hub.pushCtrlEvent(e);
  if (deferStart) {
    log("等待第一个浏览器客户端连上后开始回放（--start-now 可立刻开始）");
  } else {
    source.start();
  }
  return {
    hub,
    source,
    recorder,
    profile,
    control,
    uiUrl,
    close: async () => {
      source.stop();
      // 先停录：把队列/ffmpeg 收干净再关 WS，避免收尾期还在写盘
      try {
        await recorder.stop("shutdown");
      } catch (err) {
        log("[record] 关闭录制失败: " + (err instanceof Error ? err.message : String(err)));
      }
      await hub.close();
      if (calTimer !== null) clearInterval(calTimer);
      if (statusPoll !== null) statusPoll.stop();
      if (live !== null) live.close();
      if (webServer !== null) {
        await new Promise<void>((resolve) => { webServer?.close(() => resolve()); });
      }
    },
  };
}

/**
 * 启动守卫上限（ms）：bootstrap 卡住（典型：UDP 绑定地址不属于本机，异步 socket error 后无人报错）
 * 时保证最迟 7 s 内以 [FATAL] + 非 0 退出码结束，而不是"什么都没打印就退出 0"。
 * 判据要求 8 s 内失败，这里留 1 s 余量；正常启动远快于该值，不影响正常路径时序。
 */
export const STARTUP_GUARD_MS = 7000;

/**
 * 守卫的实际生效阈值 = max(STARTUP_GUARD_MS, udpProbeMs + 3000)。
 *
 * 为什么不能只用 7 s：auto 模式的合法启动时间本身就含 `--udp-probe <ms>`（等网口首包，默认 1500，
 * 用户可调大到任意值）。默认 7 s 对 1500 ms 探针有 ~4.5 倍余量，但 `--udp-probe 10000` 这类
 * 合法用法会让"本来能成功"的启动在 7 s 被守卫误杀（实测：7.0 s 打 [FATAL] 启动超时，底层 auto
 * 流程还在跑，进程 13 s 才退）。阈值跟着探针走，非 auto 模式没有该参数 ⇒ 仍是 7000。
 */
export function startupGuardMs(options: { readonly udpProbeMs?: number | undefined }): number {
  return Math.max(STARTUP_GUARD_MS, (options.udpProbeMs ?? 0) + 3000);
}

/**
 * 给启动关键路径套超时守卫。守卫定时器**必须**是 ref（默认 setTimeout）：
 * 否则收尾后进程会因无事可做而静默 exit 0 —— 正是 task-1 要消灭的那类现象。
 *
 * onTimeout：超时瞬间的回调（CLI 用它打一行 [FATAL] 后立刻 process.exit(2)）。
 * 不传则只 reject（单测/嵌入方自己决定怎么收场）；传了也仍会 reject，便于调用方继续走通用错误路径。
 */
export async function withStartupGuard<T>(
  label: string,
  ms: number,
  work: Promise<T>,
  onTimeout?: (message: string) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      const message = "启动超时：" + label + "超过 " + ms + " ms 仍未就绪。最常见原因：UDP 绑定地址不属于本机" +
        "（改用 --bind 本机 IPv4，或把网卡改成该地址），其次串口被别的程序占用。";
      if (onTimeout !== undefined) onTimeout(message);
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

let fatalHandlersInstalled = false;

/**
 * 最后兜底：未捕获异常 / 未处理的 Promise 拒绝一律 [FATAL] 上屏 + 非 0 退出。
 * 入口是 `void main()`，没有外层 catch —— 缺了这层就会出现"静默 exit 0"（用户完全看不出原因）。
 */
export function installFatalHandlers(): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  const onFatal = (err: unknown): void => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try {
      // 同步写 fd 2：进程即将 exit，console.error 在管道/重定向下可能来不及 flush
      fs.writeSync(2, "[FATAL] " + msg + "\n");
    } catch {
      // stderr 都写不了时已无处可报，仍要保证非 0 退出码
    }
    process.exitCode = 2;
    process.exit(2);
  };
  process.on("unhandledRejection", onFatal);
  process.on("uncaughtException", onFatal);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  installFatalHandlers();
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error("[FATAL] " + parsed.error + "\n\n" + USAGE);
    process.exitCode = 2;
    return;
  }
  if (parsed.options.help) {
    console.log(USAGE);
    return;
  }
  let running: RunningGateway;
  // 判超时后必须**立刻**退出：底层 auto/串口流程不会因为守卫 reject 而停下，
  // 拖着不退会让用户看到"已报错却还在跑"的进程（实测旧实现 7 s 报错、13 s 才退）。
  const guardMs = startupGuardMs(parsed.options);
  try {
    running = await withStartupGuard("网关启动", guardMs, runGateway(parsed.options), (message) => {
      try {
        fs.writeSync(2, "[FATAL] " + message + "\n");
      } catch {
        // 写不了 stderr 也要保证退出码
      }
      process.exit(2);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[FATAL] " + msg);
    process.exitCode = 2;
    return;
  }
  console.log("[gateway] profile=" + running.profile.name + " source=" + parsed.options.kind + " ws=" + running.hub.url);
  if (running.uiUrl !== null) {
    console.log("[gateway] 界面: " + running.uiUrl + "   ← 浏览器打开它即可");
  } else {
    console.log("[gateway] 未开启界面服务；请另外打开前端并连 " + running.hub.url);
  }
  console.log("[gateway] 按 Ctrl+C 退出（此窗口关掉，服务也停）");
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void running.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** 只有被当作入口直接执行时才自我启动（被测试 import 时不得起服务） */
const invoked = process.argv[1];
if (invoked !== undefined && path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
