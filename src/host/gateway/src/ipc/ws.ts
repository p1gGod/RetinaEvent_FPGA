// 网关 ↔ 浏览器 的 IPC 服务（04 §7）：二进制推流 + JSON-RPC 2.0 控制面，同一条 WS 连接。
// 为什么二进制必须用 protocol 的 encodeIpc：首部布局是跨进程契约，前端 decodeIpc 是唯一的读侧实现，
// 网关这边只要有一个字段写错，前端就是"静默花屏"（最难查的一类错）。
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { IPC, MAGIC, PIXEL, RPC_METHODS, bump, createCounters, encodeIpc } from "@retina/protocol";
import type {
  Counters,
  EventBatch,
  EventRecord,
  FramePacket,
  IFrameSource,
  IpcMessage,
  Profile,
  SourceError,
  SourceStats,
  Unsubscribe,
  V3StatusView,
} from "@retina/protocol";
import type { EventsDetailedCb } from "../transport/base.ts";
import type { LatestStore } from "../pipeline/latest.ts";
import { HostEventProcessor, type EventSourceKind } from "../pipeline/host_events.ts";
import { actionStore } from "../action.ts";
import { BOARD_PARAMS, HOST_SIM_DEFAULT_MINDL, HOST_SIM_DEFAULT_THETA, type RetinaParams } from "@retina/retina";

/** 本帧要推给前端的事件（已编码成 EV_DATA 字节）；host=true 表示是上位机算出来的 */
interface FrameEvents {
  readonly records: readonly EventRecord[];
  readonly raw: Uint8Array;
  readonly host: boolean;
}

export const GATEWAY_VERSION = "0.1.0";

/**
 * EVENTS.flags 扩展位：纯事件-时间窗批次（板端 EV_ONLY 下事件包帧号冻结）。
 * 为什么不去 packages/protocol 里加：IPC 常量表是全仓共享契约，加位要同步改前端解码与文档；
 * 这个位与 FLAG_THINNED/KEYFRAME/SYNTHETIC/HOST_SIM（0b0001..0b1000）不冲突，
 * 且"老前端不认识新位"的退化行为正好是"忽略该批、走帧配对"，是安全的。
 */
export const FLAG_EV_ONLY = 0b10000;

/**
 * EVENTS.flags 扩展位（七修）：本批来自"不具备原始段"的数据源（串口 UART-LINK）。
 * 与 FLAG_EV_ONLY 同时置位；前端据此把 L1/L4 文案切成"串口模式：无原始画面"，
 * 而不是误报成板端 EV_ONLY 的"原始帧已冻结"。
 */
export const FLAG_NO_RAW = 0b100000;

/** WS 心跳间隔（旧标签页/崩溃页面的死连接多久回收一轮；ws 库自动回 pong） */
const WS_HEARTBEAT_MS = 30_000;

/**
 * v3 下行命令控制（WIRE-V3 §6/§7.2）。main.ts 在 --udp 数据源下组装（V3Link），
 * 其它数据源不实现 —— 前端会收到明确的"不可用原因"，而不是装死。
 */
export interface BoardControl {
  /**
   * SET_PARAM 参数（tag 0x01..0x0A；UART 扩展 0x07..0x0A 见板端实现报告 §3.3 ④；
   * sccb 集成增补 0x0B EXP_CAP 见 sccb 集成报告 §9.1）。
   * minDl 由协议层 `buildSetParamPayload` 钳位 0..511、expCap 钳位 4..5904
   * （越界板端都会 BAD_VALUE 且整条不写）。
   */
  setParam(params: {
    theta?: number;
    minDl?: number;
    frameDecim?: number;
    evRes?: number;
    serDecim?: number;
    serAgg?: number;
    serEvFlushMs?: number;
    /** 曝光上限（tag 0x0B，4..5904 行；sccb 集成报告 §9.1） */
    expCap?: number;
  }): Promise<unknown>;
  setMode(mode: number): Promise<unknown>;
  getStatus(): Promise<unknown>;
  calibrate(): Promise<unknown>;
  /** 事件支路开关（v3.1 增补 EV_EN=0x05） */
  evEn(enabled: boolean): Promise<unknown>;
  /** 当前 v3 状态视图（STATS 推送用；null = 尚未见到 v3 流量） */
  status(): unknown;
}

/** 网关侧可控项；由 main.ts 组装（IPC 层不知道自己控制的是哪种源） */
export interface GatewayControl {
  start(): void;
  stop(): void;
  getConfig(): Record<string, unknown>;
  setConfig(patch: Record<string, unknown>): Record<string, unknown>;
  snapshot(): Record<string, unknown>;
  /** v3 下行命令；缺省 = 当前数据源不支持（IPC 层据此回明确错误） */
  readonly board?: BoardControl;
  /**
   * 传输方式切换（UART 路线，WIRE-U1 §8.2 H4/H7）：udp / uart / auto + 串口号。
   * 异步：先建后拆（新通道打开失败 ⇒ 抛错、当前通道不动）。缺省 = 非实时源，不支持切换。
   */
  readonly switchTransport?: ((want: { transport?: string; serialPort?: string; force?: boolean }) => Promise<Record<string, unknown>>) | undefined;
  /**
   * B：串口波特率切档（4 档：115200/230400/460800/921600）。
   * 异步：串口主通道要走"板端 ACK → 关旧口 → 新档重开 → GET_STATUS 验证"的完整舞蹈；
   * 缺省 = 非实时源/不支持切档。
   */
  readonly setSerialBaud?: ((baud: number) => Promise<Record<string, unknown>>) | undefined;
  /**
   * 传输/串口状态视图（UART 路线）：随 STATS 1 Hz 推到前端（"传输方式"卡片的数据源）。
   * 缺省 = 非实时源（回放/合成）没有传输概念。
   */
  readonly transportView?: (() => Record<string, unknown>) | undefined;
}

/** 长录记录器的接线口（task-30）：只在 attachSource/switchSource 时被调用，避免 IpcHub 反向依赖 record 模块的具体类型。 */
export interface RecorderAttach {
  attachSource(source: IFrameSource): void;
}

export interface IpcHubOptions {
  readonly port: number;
  readonly profile: Profile;
  readonly source: IFrameSource;
  readonly control: GatewayControl;
  readonly host?: string;
  /** 与源共享的计数器（缺省自建；收到 STATS 后会切换成源的那一份，保证口径一致） */
  readonly counters?: Counters;
  /** 慢客户端阈值：bufferedAmount 超过它就丢 FRAME_RAW 保新帧，并计 uiDrop（04 §6 背压） */
  readonly maxBufferedBytes?: number;
  /** 已有 HTTP 服务器（网关兼任静态界面时传入）：WS 与界面同端口，浏览器同源，不用配代理 */
  readonly server?: import("node:http").Server;
  /** 第一个客户端连上时回调一次（回放演示用它做到"浏览器打开才开始播"） */
  readonly onFirstClient?: () => void;
  /**
   * 最新帧/事件的外部单槽存储（/api/* 从它读）。
   * 与 lastFrame 的区别：lastFrame 是"给新连上的浏览器补发"的内部缓存，
   * 而 store 是给**别的进程**拉取的对外快照，且带墙钟时间戳（"这张图有多新"）。
   */
  readonly store?: LatestStore | undefined;
  /** 长录记录器（可选）：数据源每次挂接/切换都会同步给它，录制不依赖浏览器是否连接。 */
  readonly recorder?: RecorderAttach | undefined;
  readonly log?: (msg: string) => void;
}

interface RpcCall {
  readonly id: number | string | null;
  readonly method: string;
  readonly params: unknown;
}

const ERR = { PARSE: -32700, REQUEST: -32600, METHOD: -32601, PARAMS: -32602, SERVER: -32000 } as const;
/** 已实现的子集（RPC_METHODS 里其余方法等 M3/M4 落地；未实现必须显式报错，不静默） */
const IMPLEMENTED = ["session.snapshot", "transport.start", "transport.stop", "config.get", "config.set", "flow.pause", "flow.resume"] as const;

export class IpcHub {
  readonly host: string;

  private boundPort: number;

  private readonly wss: WebSocketServer;
  private readonly profile: Profile;
  private readonly control: GatewayControl;
  private readonly maxBufferedBytes: number;
  private readonly onFirstClient: (() => void) | null;
  private readonly log: (msg: string) => void;
  /** 单槽帧缓存（原则 P3）：新客户端一连上就能先看到最近一帧，而不是黑屏等 0.3~1 s */
  private lastFrame: FramePacket | null = null;
  private sawClient = false;
  private counters: Counters;
  private source: IFrameSource;
  private readonly store: LatestStore | null;
  /** 长录记录器：与浏览器无关，跟随数据源生命周期 */
  private readonly recorder: RecorderAttach | null;
  /** 「事件从哪来」：板端 v2 自带（board）还是上位机同构算法（host）。可在运行时切换 */
  private eventSource: EventSourceKind = "board";
  private readonly hostProc: HostEventProcessor;
  /**
   * 上位机算法的参数。
   *
   * θ 与守卫的默认值**故意不是板端的 44 / 1**，而是现场实测的最优工作点
   * （θ=3 / 守卫=18）—— 理由与实测表见 `@retina/retina` 的 `HOST_SIM_DEFAULT_THETA`
   * 与 `HOST_SIM_DEFAULT_MINDL`。一句话：**板端默认 44 在这个场景下是 1.1 事件/帧（等于全黑）**。
   *
   * 「上位机模拟」这一档的存在意义就是**现场把这两个数扫出来**（板端改它们要重编比特流，
   * 上位机改只是改一个数）。所以默认给一个"看得见东西"的值；想 1:1 复现板端行为，
   * 在界面上点刻度「44板端」、守卫拖回 1 即可。
   */
  private hostParams: RetinaParams = {
    ...BOARD_PARAMS,
    theta: HOST_SIM_DEFAULT_THETA,
    minDl: HOST_SIM_DEFAULT_MINDL,
  };
  /** host 模式下本帧算出的事件（每帧只算一次，见 eventsFor 的注释） */
  private lastHostEvents: FrameEvents | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  private msgSeq = 0;
  private lastStats: SourceStats;
  private readonly startedAtMs = Date.now();
  private closed = false;

  /** 本网关自己的推送统计（不是协议计数器；协议计数器在 counters 里） */
  readonly pushCounters = { frames: 0, events: 0, stats: 0, bytes: 0, uiDrop: 0, slowFrameDrop: 0 };
  /** 暂停时只停 FRAME_RAW（事件与统计照推）—— 04 §7.2 的背压方向 */
  paused = false;

  constructor(opts: IpcHubOptions) {
    this.boundPort = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.profile = opts.profile;
    this.source = opts.source;
    this.control = opts.control;
    // 计数器优先复用源的那一份：否则背压（uiDrop）等网关侧计数会和源侧分家，状态栏出现两个口径
    const sourceCounters = (opts.source as { counters?: Counters }).counters;
    this.counters = opts.counters ?? sourceCounters ?? createCounters();
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 8 * 1024 * 1024;
    this.onFirstClient = opts.onFirstClient ?? null;
    this.store = opts.store ?? null;
    this.recorder = opts.recorder ?? null;
    this.hostProc = new HostEventProcessor(opts.profile, this.hostParams);
    this.log = opts.log ?? (() => {});
    this.lastStats = {
      packets: 0,
      bytes: 0,
      bytesRaw: 0,
      bytesEvents: 0,
      pps: 0,
      bps: 0,
      lastFrameIdx: 0,
      wraps: 0,
      tNowMs: Date.now(),
    };
    this.wss = opts.server === undefined
      ? new WebSocketServer({ host: this.host, port: this.port })
      : new WebSocketServer({ server: opts.server });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("error", (err: Error) => {
      this.log("[ws] server error: " + err.message);
    });
    this.startHeartbeat();
    this.attachSource(opts.source);
  }

  /** 真实监听端口（构造时给 0 的话，ready() 之后才有意义） */
  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return "ws://" + this.host + ":" + this.boundPort;
  }

  get clients(): number {
    return this.wss.clients.size;
  }

  /** 等监听就绪并返回真实端口（测试给 port:0 时用） */
  async ready(): Promise<number> {
    const addr = this.wss.address();
    if (addr === null || typeof addr !== "object") {
      await new Promise<void>((resolve, reject) => {
        this.wss.once("listening", () => resolve());
        this.wss.once("error", (err: Error) => reject(err));
      });
    }
    const a = this.wss.address();
    if (a !== null && typeof a === "object") this.boundPort = a.port;
    return this.boundPort;
  }

  /** 订阅数据源（回放/实时/合成统一入口） */
  attachSource(source: IFrameSource): void {
    this.unsubs.push(
      source.on("frame", (f: FramePacket) => this.pushFrame(f)),
      source.on("stats", (s: SourceStats, c: Counters) => {
        this.counters = c;
        this.lastStats = s;
        this.pushStats(s, c);
      }),
      source.on("error", (e: SourceError) => {
        this.log("[source] " + e.code + ": " + e.message + (e.fatal ? " (fatal)" : ""));
      }),
    );
    // 纯事件批次（G3）需要 frameIdx/seq/tArriveMs 才能填首部 ⇒ 用扩展订阅
    const detailed = (source as { onEventsDetailed?: (cb: EventsDetailedCb) => Unsubscribe }).onEventsDetailed;
    if (typeof detailed === "function") {
      this.unsubs.push(
        detailed.call(source, (b: EventBatch, _idx: number, seq: number, t: number, evOnly?: boolean) =>
          this.pushEvents(b, seq, t, evOnly === true),
        ),
      );
    }
    // 录制器自己订阅/退订数据源：切源后自动跟着新源走（task-30）。
    // 放在最后是因为 Recorder.attachSource 内部会先退掉旧源，顺序与 IpcHub 的退订互为幂等。
    this.recorder?.attachSource(source);
  }

  /** 立刻给所有客户端推一条 STATS（连接建立时用，前端不用等 1 s） */
  pushSnapshotStats(): void {
    this.pushStats(this.lastStats, this.counters);
  }

  /**
   * 运行时切换数据源（UART 路线：UI 选 UDP/UART/自动 ⇒ LiveTransportManager 先建新通道再调这里）。
   * 旧源由调用方 stop()；这里只做"退订旧的 + 挂新的 + 口径跟着换"，并立刻推一条 STATS 让前端看到新状态。
   */
  switchSource(source: IFrameSource): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.source = source;
    const c = (source as { counters?: Counters }).counters;
    if (c !== undefined) this.counters = c;
    this.attachSource(source);
    this.log("[ws] 数据源已切换: wire=" + source.info.wire + " profile=" + source.info.profile);
    this.pushStats(this.lastStats, this.counters);
  }

  /** 给 /api/* 用的只读快照（不要让它直接拿到可变对象去改） */
  lastStatsSnapshot(): SourceStats {
    return this.lastStats;
  }

  countersSnapshot(): Counters {
    return this.counters;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const client of this.wss.clients) {
      try {
        client.terminate();
      } catch {
        // 已断开：忽略
      }
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  // ————————————————————————— 推流 —————————————————————————

  private pushFrame(f: FramePacket): void {
    // 缓存先于节流：缓存的是"最新完整帧"，与是否推给慢客户端无关（原则 P3 单槽帧总线）
    this.lastFrame = f;
    // 对外快照同样先于节流：/api/* 的消费者不该因为"某个浏览器慢"而拿不到帧
    this.store?.setFrame(f, Date.now());
    // 事件来源在这一层定：算出来的与板端发来的，编成同一种字节走同一条 EVENTS 通路
    const ev = this.eventsFor(f, true);
    // 位图每帧都要推进（哪怕本帧没有事件），否则余晖永不消散
    this.hostProc.stepBitmap(ev?.records ?? [], f.frameIdx, this.eventSource);
    this.store?.setEvents({
      frameIdx: f.frameIdx,
      w: this.hostProc.gridW,
      h: this.hostProc.gridH,
      rgba: this.hostProc.bitmapRgba(),
      count: this.hostProc.lastCount,
      origin: this.eventSource,
      arrivedAtMs: Date.now(),
    });
    if (this.paused) {
      bump(this.counters, "uiDrop");
      this.pushCounters.uiDrop++;
      return;
    }
    // F2（2026-10-17 六修）：**per-client 降帧**。修前只要有一个慢客户端（旧标签页/后台页
    // bufferedAmount 涨过 8 MB）就全局丢帧，把所有客户端一起拖黑（现场 clients=3 时 uiDrop +87/3s）。
    // 现在每帧只编码一次，逐客户端判定：慢的跳过它自己的这一帧并单独计数；没人接收才记全局 uiDrop。
    const msgs = this.encodeFrame(f, ev);
    const bufs = msgs.map((m) => encodeIpc(m));
    let delivered = 0;
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.bufferedAmount > this.maxBufferedBytes) {
        this.pushCounters.slowFrameDrop++;
        continue;
      }
      for (const buf of bufs) {
        try {
          client.send(buf);
          this.pushCounters.bytes += buf.length;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log("[ws] send failed: " + message);
        }
      }
      delivered++;
    }
    if (delivered === 0 && this.pushCounters.slowFrameDrop > 0) {
      // 所有在线客户端都慢：本帧确实没人收到 —— 记一次全局丢帧（UI 角标/计数器口径）
      bump(this.counters, "uiDrop");
      this.pushCounters.uiDrop++;
    }
    this.pushCounters.frames++;
  }

  /**
   * 本帧要推给前端的事件。
   *
   * ⚠️ host 模式下**每帧只能算一次**：`HostEventProcessor.compute()` 会推进时域差分状态，
   * 重复调用等于把同一帧喂两遍，事件会全错。所以结果要随帧缓存（lastHostEvents）。
   */
  private eventsFor(f: FramePacket, allowCompute: boolean): FrameEvents | null {
    if (this.eventSource === "host") {
      if (allowCompute) this.lastHostEvents = this.hostProc.compute(f);
      return this.lastHostEvents;
    }
    const b = f.events;
    if (b.records.length === 0 || b.raw === undefined) return null;
    return { records: b.records, raw: b.raw, host: false };
  }

  /** 切换事件来源：清掉位图与算法状态（否则旧余晖/旧帧存会污染新来源） */
  setEventSource(kind: EventSourceKind): void {
    if (this.eventSource === kind) return;
    this.eventSource = kind;
    this.hostProc.reset();
    this.lastHostEvents = null;
    this.store?.setEvents({
      frameIdx: -1,
      w: this.hostProc.gridW,
      h: this.hostProc.gridH,
      rgba: this.hostProc.bitmapRgba(),
      count: 0,
      origin: kind,
      arrivedAtMs: Date.now(),
    });
    this.log("[events] 事件来源切换为 " + kind);
  }

  get eventSourceKind(): EventSourceKind {
    return this.eventSource;
  }

  /** 改上位机算法参数（θ / 守卫）；会重建引擎并清位图 —— 参数一变，旧余晖就没有意义了 */
  setHostParams(patch: Partial<RetinaParams>): void {
    this.hostParams = { ...this.hostParams, ...patch };
    this.hostProc.setParams(this.hostParams);
    this.lastHostEvents = null;
    this.log("[events] 上位机算法参数 θ=" + this.hostParams.theta + " 守卫=" + this.hostParams.minDl);
  }

  get hostAlgorithmParams(): RetinaParams {
    return this.hostParams;
  }

  /**
   * 一帧对应的 IPC 消息序列：**有事件时 EVENTS 在前，FRAME_RAW 在后**；无事件的帧只有 FRAME_RAW。
   *
   * A5（2026-10-09 KEY3 撕裂修复）：WebSocket 保序，前端收到 EVENTS 后按 `frameIdx` 入队，
   * 等属于它的那一帧到了才置位。若仍按"FRAME_RAW 先、EVENTS 后"发，前端在帧到达时
   * 队列里还没有本帧事件 ⇒ 只能等下一帧，画面必然差 1 帧（`frameDecim` 下就是 300 ms 的错位）。
   * 故这里必须把 EVENTS 排在前面；两型消息的 `frameIdx` 都取 `f.seq`，配对口径不变。
   */
  private encodeFrame(f: FramePacket, ev: FrameEvents | null): IpcMessage[] {
    const flags = (f.synthetic ? IPC.FLAG_SYNTHETIC : 0) | (f.events.thinned ? IPC.FLAG_THINNED : 0);
    const msgs: IpcMessage[] = [];
    if (ev !== null && ev.records.length > 0) {
      msgs.push({
        type: "EVENTS",
        flags: (ev.host ? IPC.FLAG_HOST_SIM : 0) | (f.events.thinned && !ev.host ? IPC.FLAG_THINNED : 0),
        seq: this.nextSeq(),
        frameIdx: f.seq >>> 0,
        tArriveMs: f.tArriveMs >>> 0,
        recBytes: this.profile.evRecBytes,
        count: ev.records.length,
        data: ev.raw,
      });
    }
    msgs.push({
      type: "FRAME_RAW",
      flags,
      seq: this.nextSeq(),
      frameIdx: f.seq >>> 0,
      tArriveMs: f.tArriveMs >>> 0,
      // F4（2026-10-13）：板端时间轴必须原样转发到前端，否则 VFR/MP4 导出的
      // "全帧板端优先"路径永远走不到（校准完成也只剩到达时刻回退）。
      // 缺省（TS 无效/v2 帧）= 不写该字段 ⇒ encodeIpc 落 ver=0 老布局，老前端逐字节兼容。
      ...(f.tBoardMs === undefined ? {} : { tBoardMs: f.tBoardMs }),
      w: f.w,
      h: f.h,
      pixel: f.pixel === "RGB565_BE" ? PIXEL.RGB565_BE : PIXEL.RGB565_LE,
      raw: f.raw,
    });
    return msgs;
  }

  /** 只发给一个客户端（新连接补发最近一帧用） */
  private sendMessagesTo(ws: WebSocket, msgs: readonly IpcMessage[]): void {
    if (ws.readyState !== 1) return;
    for (const m of msgs) {
      const buf = encodeIpc(m);
      try {
        ws.send(buf);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("[ws] send failed: " + message);
      }
    }
  }

  /**
   * 纯事件批次出口（G3）。evOnly=true 时 seq 是装配器分配的**网关自增逻辑帧号**，
   * 该批不配对任何 FRAME_RAW；前端看到 FLAG_EV_ONLY 必须立即上屏并单独 step 一次衰减。
   */
  private pushEvents(b: EventBatch, seq: number, tArriveMs: number, evOnly = false): void {
    // host 模式：事件一律由"帧到达"时算出来（逐帧等价算法需要整帧输入），板端这种与原始帧解耦
    // 的纯事件包在这个模式下没有对应物 ⇒ 普通纯事件包明确忽略，不混进同一条流。
    // F1（2026-10-17 六修）：**EV_ONLY 批例外**。板端 EV_ONLY 时没有 FRAME_RAW，host 模拟永远算不出
    // 事件（页面必然全黑）。这类批必须照常转发并带 FLAG_EV_ONLY，前端会据此自动切到板端事件源。
    if (this.eventSource === "host" && !evOnly) return;
    if (evOnly) this.lastEvOnlyPushAt = Date.now();
    const data = b.raw ?? new Uint8Array(0);
    const noRaw = !this.sourceRawCapable();
    this.pushMessage({
      type: "EVENTS",
      flags:
        (b.thinned ? IPC.FLAG_THINNED : 0) |
        (evOnly ? FLAG_EV_ONLY : 0) |
        (noRaw ? FLAG_NO_RAW : 0),
      seq: this.nextSeq(),
      frameIdx: seq >>> 0,
      tArriveMs: tArriveMs >>> 0,
      recBytes: this.profile.evRecBytes,
      count: b.records.length,
      data,
    });
    this.pushCounters.events++;
  }

  private pushStats(s: SourceStats, c: Counters): void {
    // WIRE-V3 §7.2：TYPE_STATS 载荷扩展 v3 状态（mode / tsCalibrated / tsAlignErrMs / calAge …）
    const v3 = this.control.board?.status() as V3StatusView | null | undefined;
    const transport = this.control.transportView?.();
    const boardMode = v3 === null || v3 === undefined || typeof v3.mode !== "number" ? undefined : v3.mode;
    const online = this.onlineClients();
    this.pushMessage({
      type: "STATS",
      flags: 0,
      seq: this.nextSeq(),
      frameIdx: s.lastFrameIdx >>> 0,
      tArriveMs: s.tNowMs >>> 0,
      stats: s,
      counters: c,
      ...(v3 === null || v3 === undefined ? {} : { v3: v3 as V3StatusView }),
      ...(transport === undefined ? {} : { transport }),
      // F1/F2（ADDITIVE）：事件源、板端 MODE、EV_ONLY 是否成立、客户端/慢客户端数。
      // 前端据此自动切事件源（EV_ONLY + host = 必然全黑）并在状态条提示旧连接降帧。
      eventSource: this.eventSource,
      ...(boardMode === undefined ? {} : { boardMode }),
      evOnlyActive: boardMode === 2 || Date.now() - this.lastEvOnlyPushAt < 2000,
      clients: online.length,
      slowClients: online.filter((w) => w.bufferedAmount > this.maxBufferedBytes).length,
      // 七修 ADDITIVE：数据源是否可能产出 FRAME_RAW（串口事件链路 = false）。
      rawCapable: this.sourceRawCapable(),
    });
    this.pushCounters.stats++;
  }

  /**
   * 心跳/旧连接回收：每 30 s ping 一次，上一轮没回 pong 的直接 terminate。
   * 现场 "clients=3" 常是旧标签页/崩溃页面残留；死连接不回收会一直吃 bufferedAmount 判定。
   */
  private startHeartbeat(): void {
    const timer = setInterval(() => {
      for (const client of this.wss.clients) {
        if (this.alive.get(client) === false) {
          try {
            client.terminate();
          } catch {
            // 已断开：忽略
          }
          continue;
        }
        this.alive.set(client, false);
        try {
          client.ping();
        } catch {
          // ping 失败留给下一轮 terminate
        }
      }
    }, WS_HEARTBEAT_MS);
    // 不要让心跳单独吊住 node 进程（网关本来有 listen 句柄，但单测会直接 close hub）
    if (typeof timer.unref === "function") timer.unref();
    this.heartbeat = timer;
  }

  /**
   * 当前数据源是否具备原始段。IFrameSource 冻结契约里没有该字段，所以用鸭子类型读；
   * 缺省 true（回放/合成/旧源），只有串口源显式声明 false。
   */
  private sourceRawCapable(): boolean {
    const v = (this.source as IFrameSource & { readonly rawCapable?: boolean }).rawCapable;
    return v !== false;
  }

  /** 在线（readyState=1）客户端列表 */
  private onlineClients(): WebSocket[] {
    const out: WebSocket[] = [];
    for (const client of this.wss.clients) if (client.readyState === 1) out.push(client);
    return out;
  }

  /** EV_ONLY 批最近一次推送时刻（0 = 从未；STATS 用它告诉前端"板端当前只回传事件"） */
  private lastEvOnlyPushAt = 0;
  /** 心跳定时器（close 清理）与每连接存活标记 */
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly alive = new WeakMap<WebSocket, boolean>();

  /** v3 下行命令事件（ACK 结果 / 失败原因）推给所有客户端（TYPE_CTRL，WIRE-V3 §7.2） */
  pushCtrlEvent(ctrl: Record<string, unknown>): void {
    this.pushMessage({
      type: "CTRL",
      flags: 0,
      seq: this.nextSeq(),
      frameIdx: 0,
      tArriveMs: Date.now() >>> 0,
      ctrl,
    });
  }

  private pushMessage(m: IpcMessage): void {
    if (this.closed) return;
    const buf = encodeIpc(m);
    this.pushCounters.bytes += buf.length;
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue;
      try {
        client.send(buf);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("[ws] send failed: " + message);
      }
    }
  }

  private nextSeq(): number {
    this.msgSeq = (this.msgSeq + 1) & 0xffff;
    return this.msgSeq;
  }

  private anyClientSlow(): boolean {
    for (const client of this.wss.clients) {
      if (client.readyState === 1 && client.bufferedAmount > this.maxBufferedBytes) return true;
    }
    return false;
  }

  // ————————————————————————— 控制面 —————————————————————————

  private onConnection(ws: WebSocket): void {
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));
    ws.on("close", () => this.alive.delete(ws));
    ws.on("error", (err: Error) => this.log("[ws] client error: " + err.message));
    ws.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        // 前端目前只有请求控制这一种上行；收到二进制直接忽略，避免误解成配置
        return;
      }
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      this.handleText(ws, text);
    });
    // 新连接先给一份现场（profile/计数器/统计），前端不用发 RPC 也能先渲染状态栏
    this.sendJson(ws, { method: "session.hello", params: this.helloParams() });
    this.pushStats(this.lastStats, this.counters);
    // 最近一帧补发：浏览器一连上就有画面（回放/实时都适用），不需要等下一帧
    // ⚠️ 事件用**缓存的**那一份，不能重算 —— host 模式下重算会二次推进时域差分状态
    if (this.lastFrame !== null) this.sendMessagesTo(ws, this.encodeFrame(this.lastFrame, this.eventsFor(this.lastFrame, false)));
    if (!this.sawClient) {
      this.sawClient = true;
      if (this.onFirstClient !== null) this.onFirstClient();
    }
  }

  private handleText(ws: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, null, ERR.PARSE, "JSON 解析失败");
      return;
    }
    const call = normalizeCall(parsed);
    if (call === null) {
      this.sendError(ws, null, ERR.REQUEST, "请求必须是 {id, method, params?} 对象");
      return;
    }
    if (!(RPC_METHODS as readonly string[]).includes(call.method) && !call.method.startsWith("flow.")) {
      this.sendError(ws, call.id, ERR.METHOD, "未知方法: " + call.method);
      return;
    }
    // board.* 是真异步（等板端 ACK），dispatch 返回 Promise；其余方法同步返回也兼容 await
    void this.dispatch(call).then((res) => {
      if (res !== null) this.sendJson(ws, res);
    });
  }

  /** 返回 null 表示"通知"（无 id）不回应 */
  private async dispatch(call: RpcCall): Promise<Record<string, unknown> | null> {
    if (call.id === null) return null;
    switch (call.method) {
      case "session.snapshot":
        return { id: call.id, result: this.helloParams() };
      case "transport.start":
        this.control.start();
        return { id: call.id, result: { started: true } };
      case "transport.stop":
        this.control.stop();
        return { id: call.id, result: { started: false } };
      case "config.get":
        return {
          id: call.id,
          result: {
            ...this.control.getConfig(),
            eventSource: this.eventSource,
            hostTheta: this.hostParams.theta,
            hostMinDl: this.hostParams.minDl,
            // 动作映射镜像：浏览器重连后可以拿它校正本地 localStorage（只读，不从网关反写前端）
            actionMap: actionStore.getConfigView().config,
          },
        };
      case "config.set": {
        if (call.params === null || typeof call.params !== "object") {
          return errorResponse(call.id, ERR.PARAMS, "config.set 需要对象参数");
        }
        // 传输方式切换（UDP/UART/自动）由 IPC 层单独异步处理：它会重建数据通道（先建后拆）
        const raw = call.params as Record<string, unknown>;
        const wantTransport = raw["transport"];
        const wantSerial = raw["serialPort"];
        const wantForce = raw["force"];
        if (wantTransport !== undefined || wantSerial !== undefined) {
          if (this.control.switchTransport === undefined) {
            return errorResponse(
              call.id,
              ERR.SERVER,
              "当前数据源（" + String(this.control.getConfig()["source"] ?? "?") + "）不是实时源，不支持切换传输方式；" +
              "请用 --udp / --serial COMx / --transport auto 启动网关",
            );
          }
          if (wantTransport !== undefined && typeof wantTransport !== "string") {
            return errorResponse(call.id, ERR.PARAMS, "transport 必须是字符串（udp / uart / auto）");
          }
          if (wantSerial !== undefined && typeof wantSerial !== "string") {
            return errorResponse(call.id, ERR.PARAMS, "serialPort 必须是字符串（如 COM6）");
          }
          if (wantForce !== undefined && typeof wantForce !== "boolean") {
            return errorResponse(call.id, ERR.PARAMS, "force 必须是布尔值（true=强制重连当前通道）");
          }
          try {
            const result = await this.control.switchTransport({
              ...(wantTransport === undefined ? {} : { transport: wantTransport as string }),
              ...(wantSerial === undefined ? {} : { serialPort: wantSerial as string }),
              // A2：点当前 active 档 = 强制重建（不是"已经是该档"的空操作）
              ...(wantForce === undefined ? {} : { force: wantForce }),
            });
            return { id: call.id, result: { ...result, eventSource: this.eventSource } };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // 明确报错：当前通道保持不动（前端拿到 message 直接上屏）
            return errorResponse(call.id, ERR.SERVER, "传输方式切换失败：" + message);
          }
        }
        // B：串口波特率切档（异步舞蹈）单独处理，不能落到同步 setConfig 的"不支持键"
        const wantBaud = raw["serialBaud"];
        if (wantBaud !== undefined) {
          if (this.control.setSerialBaud === undefined) {
            return errorResponse(
              call.id,
              ERR.SERVER,
              "当前数据源（" + String(this.control.getConfig()["source"] ?? "?") + "）是实时源但不支持切换波特率；" +
              "请用 --udp / --serial COMx / --transport auto 启动网关",
            );
          }
          if (typeof wantBaud !== "number" || !Number.isInteger(wantBaud)) {
            return errorResponse(call.id, ERR.PARAMS, "serialBaud 必须是整数波特率（115200/230400/460800/921600）");
          }
          try {
            const result = await this.control.setSerialBaud(wantBaud);
            return { id: call.id, result: { ...result, eventSource: this.eventSource } };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResponse(call.id, ERR.PARAMS, "波特率切换失败：" + message);
          }
        }
        // eventSource 由 IPC 层自己消化：它决定"事件从哪来"，属于推流选择，不是数据源配置
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k === "eventSource") {
            if (v !== "board" && v !== "host") {
              return errorResponse(call.id, ERR.PARAMS, "eventSource 只能是 \"board\" 或 \"host\"");
            }
            this.setEventSource(v);
            continue;
          }
          // 动作映射：与 eventSource 同类 —— 是"浏览器侧策略"的镜像，不是数据源配置。
          // 为什么必须在 IPC 层消化：control.setConfig 只认 bind/port/wsPort/serialPort 这类数据源键，
          // 把 actionMap 漏进去会得到"config.set 不支持的键"（前端改下拉直接报错）。
          // 网关只存只读镜像（/api/action/config 与前端对账用），不落盘、更不执行动作。
          if (k === "actionMap") {
            try {
              actionStore.setConfig(v);
            } catch (err) {
              return errorResponse(call.id, ERR.PARAMS, err instanceof Error ? err.message : String(err));
            }
            continue;
          }
          // 上位机算法参数：同样是"推流侧"的选择，不动数据源
          if (k === "hostTheta" || k === "hostMinDl") {
            if (typeof v !== "number" || !Number.isFinite(v)) {
              return errorResponse(call.id, ERR.PARAMS, k + " 需要数字");
            }
            const patch: Partial<RetinaParams> = k === "hostTheta" ? { theta: Math.round(v) } : { minDl: Math.round(v) };
            this.setHostParams(patch);
            continue;
          }
          rest[k] = v;
        }
        try {
          const result = this.control.setConfig(rest);
          return { id: call.id, result: { ...result, eventSource: this.eventSource, hostTheta: this.hostParams.theta, hostMinDl: this.hostParams.minDl } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResponse(call.id, ERR.PARAMS, message);
        }
      }
      case "flow.pause":
        this.paused = true;
        return { id: call.id, result: { paused: true } };
      case "flow.resume":
        this.paused = false;
        return { id: call.id, result: { paused: false } };
      case "board.setParam":
      case "board.setMode":
      case "board.getStatus":
      case "board.calibrate":
      case "board.evEn":
        return await this.dispatchBoard(call);
      default:
        return errorResponse(
          call.id,
          ERR.METHOD,
          "方法 " + call.method + " 属于 RPC_METHODS 但 M2 未实现；已实现: " + IMPLEMENTED.join(", "),
        );
    }
  }

  /**
   * v3 下行命令（board.*）：转发给 main.ts 组装的 BoardControl（= V3Link）。
   * 未启用时（非 --udp 数据源）必须给出明确原因 —— "点了没反应"是 04 §13 点名的最差反馈。
   */
  private async dispatchBoard(call: RpcCall): Promise<Record<string, unknown>> {
    const board = this.control.board;
    if (board === undefined) {
      return errorResponse(
        call.id,
        ERR.SERVER,
        "当前数据源（" + String(this.control.getConfig()["source"] ?? "?") + "）不支持 v3 下行命令；请用 --udp 启动网关并连接 v3 固件",
      );
    }
    const params = (call.params ?? {}) as Record<string, unknown>;
    try {
      if (call.method === "board.setParam") {
        const p: {
          theta?: number; minDl?: number; frameDecim?: number;
          evRes?: number; serDecim?: number; serAgg?: number; serEvFlushMs?: number;
          expCap?: number;
        } = {};
        // tag 0x01..0x06（v3）+ 0x07..0x0A（UART 扩展，板端实现报告 §3.3 ④）
        // + 0x0B（sccb 集成，EXP_CAP；sccb 集成报告 §9.1）
        for (const k of ["theta", "minDl", "frameDecim", "evRes", "serDecim", "serAgg", "serEvFlushMs", "expCap"] as const) {
          const v = params[k];
          if (v === undefined) continue;
          if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
            return errorResponse(call.id, ERR.PARAMS, k + " 必须是整数");
          }
          p[k] = v;
        }
        const r = await board.setParam(p);
        return { id: call.id, result: this.ackToResult(r) };
      }
      if (call.method === "board.setMode") {
        const m = params["mode"];
        if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m > 2) {
          return errorResponse(call.id, ERR.PARAMS, "mode 必须是 0/1/2");
        }
        const r = await board.setMode(m);
        return { id: call.id, result: this.ackToResult(r) };
      }
      if (call.method === "board.getStatus") {
        const r = await board.getStatus();
        return { id: call.id, result: this.ackToResult(r) };
      }
      if (call.method === "board.evEn") {
        const v = params["enabled"];
        if (typeof v !== "boolean") {
          return errorResponse(call.id, ERR.PARAMS, "enabled 必须是布尔（true=使能 / false=禁用）");
        }
        const r = await board.evEn(v);
        return { id: call.id, result: this.ackToResult(r) };
      }
      const r = await board.calibrate();
      return { id: call.id, result: this.ackToResult(r) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(call.id, ERR.PARAMS, message);
    }
  }

  /** AckResult → RPC result（TLV 解释拍平，前端不用认识 TLV 编码） */
  private ackToResult(r: unknown): Record<string, unknown> {
    const a = r as { ok: boolean; opcode: number; seq: number; status: number | null; detail: string; tlvs?: unknown };
    return {
      ok: a.ok,
      opcode: a.opcode,
      seq: a.seq,
      status: a.status,
      detail: a.detail,
      ...(a.tlvs === undefined ? {} : { tlvs: a.tlvs }),
      v3: this.control.board?.status() ?? null,
    };
  }

  private helloParams(): Record<string, unknown> {
    const v3 = this.control.board?.status() as V3StatusView | null | undefined;
    return {
      version: GATEWAY_VERSION,
      protocolMagic: Array.from(MAGIC).map((b) => b.toString(16).padStart(2, "0")).join(""),
      uptimeMs: Date.now() - this.startedAtMs,
      clients: this.wss.clients.size,
      paused: this.paused,
      boardDownlink: this.control.board !== undefined,
      ...(v3 === null || v3 === undefined ? {} : { v3: v3 as V3StatusView }),
      profile: {
        name: this.profile.name,
        wire: this.profile.wire,
        w: this.profile.frame.w,
        h: this.profile.frame.h,
        pixel: this.profile.frame.pixel,
        rawChunk: this.profile.rawChunk,
        chunksPerFrame: this.profile.chunksPerFrame,
        evRecBytes: this.profile.evRecBytes,
        crc16: this.profile.crc16,
        frameDecim: this.profile.frameDecim,
      },
      source: this.source.info,
      ...(this.control.transportView === undefined ? {} : { transport: this.control.transportView() }),
      eventSource: this.eventSource,
      hostTheta: this.hostParams.theta,
      hostMinDl: this.hostParams.minDl,
      stats: this.lastStats,
      counters: this.counters,
      ...this.control.snapshot(),
    };
  }

  private sendJson(ws: WebSocket, obj: Record<string, unknown>): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("[ws] sendJson failed: " + message);
    }
  }

  private sendError(ws: WebSocket, id: number | string | null, code: number, message: string): void {
    this.sendJson(ws, errorResponse(id, code, message));
  }
}

function normalizeCall(parsed: unknown): RpcCall | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof o.method !== "string") return null;
  let id: number | string | null = null;
  if (typeof o.id === "number" || typeof o.id === "string") id = o.id;
  return { id, method: o.method, params: o.params === undefined ? null : o.params };
}

function errorResponse(id: number | string | null, code: number, message: string): Record<string, unknown> {
  return { id, error: { code, message } };
}
