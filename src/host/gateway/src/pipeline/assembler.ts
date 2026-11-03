// 帧装配（04 文档 §5 的实现）。
// 为什么按 CHUNK_IDX 位图定位、而不是"按到达顺序拼接"：顺序拼接只要丢 1 个包，
// 整帧就会永久错位并悄悄出一张错图；位图法能把缺失定位到具体段号 ⇒ 只产生 aborted，
// 绝不产生"错位图像"（这是 04 §13 里最贵的错误类型）。
//
// 统计口径：所有计数器都走 protocol 的 createCounters/bump，禁止这里另造一套字段。
import {
  CALIB,
  FRAME_TIMEOUT_MS,
  FrameIndexUnwrapper,
  MODE3,
  boardTsToMs,
  bump,
  createCounters,
  decodeEvents,
  gapOf,
} from "@retina/protocol";
import type {
  Counters,
  EventBatch,
  FramePacket,
  ParsedV1,
  ParsedV2,
  ParsedV3,
  Profile,
  SourceStats,
} from "@retina/protocol";

/** 装配器只认"已解析好的包"，与具体线格式无关（v1/v2/v3 都能喂；v3 CTRL 包不进装配器） */
export type AssemblerPacket = ParsedV2 | ParsedV1 | ParsedV3;

export interface AssemblerOptions {
  readonly profile: Profile;
  // 说明：这些字段会被上一层"原样转发"（processor ← base ← 具体源），
  // 在 exactOptionalPropertyTypes 下必须显式允许 undefined，否则转发处每个字段都要写条件展开。
  /** 复用外部计数器对象（同一个口径）；缺省自建 */
  readonly counters?: Counters | undefined;
  /** 覆盖 FRAME_TIMEOUT_MS（测试里调小，生产按 04 §5 的 1000 ms） */
  readonly frameTimeoutMs?: number | undefined;
  /** 帧内事件环字节上限；满了丢最旧并计 evDrop（04 §6 背压） */
  readonly evRingMaxBytes?: number | undefined;
  /** 合成数据源标记；会写进 FramePacket.synthetic，最终置 IPC 的 FLAG_SYNTHETIC */
  readonly synthetic?: boolean | undefined;
  /**
   * 速率统计的最短窗口：窗口比它短时沿用上一次的 pps/bps。
   * 为什么：回放全速跑完只要几毫秒，用 ~1ms 窗口除出来的 750000 pps 是纯噪声，上屏只会误导人。
   */
  readonly minRateWindowMs?: number | undefined;
  /** 帧装配完成时回调（回调里拿到的 FramePacket 是独立内存，调用方可长期持有） */
  readonly onFrame?: ((f: FramePacket) => void) | undefined;
  /** 纯事件包（SEG_MASK=0b10）成批下发时回调（帧内事件随 frame 一起走，不重复回调） */
  readonly onEvents?:
    | ((b: EventBatch, frameIdx: number, seq: number, tArriveMs: number, evOnly?: boolean) => void)
    | undefined;
  /**
   * 数据源是否具备**原始段**（ADDITIVE，2026-10-17 七修）。
   *
   * 为什么不能按 transport kind 猜：串口链路（UART-LINK）只回传事件帧，线上包的 MODE 字段仍是板端当前
   * 模式（例如 MODE=0 RAW_EV），RAW_LEN 恒为 0、EV_LEN>0。只看 MODE 会把这类包当成"RAW_EV 下先到的
   * 纯事件包"而等一个永不到来的原始帧；必须由数据源显式声明"我没有原始段"。
   *
   * false ⇒ 无原始段的 v3 事件包按 EV_ONLY 语义交付（40 ms 时间窗、逻辑帧号、evOnly 标记）；
   * true（缺省，UDP/回放/合成）⇒ 行为与七修前逐字节一致。
   */
  readonly rawCapable?: boolean | undefined;
  /**
   * 纯事件路径的**时间窗兜底刷新**（ms，缺省 40）。
   *
   * 为什么必须有：板端 EV_ONLY（KEY3 第二态）下事件包的 FRAME_IDX **是冻结的**（udp_merge 用 raw_pop
   * 计数当帧号，raw 不再弹出 ⇒ 事件包帧号不推进），所以「帧号变化才 flush」永远不触发；而 tick() 原先
   * 只在 `now-evLastT>frameTimeoutMs` 才结算，连续事件流每次都刷新 evLastT ⇒ 永不结算 ⇒ 2 MB 事件环
   * 溢出（现场 evDrop 5,495,957、事件率 0.0 ev/s）。
   * 现按「evPend 最老一条到达时刻 t0」结算：now-t0 ≥ evFlushMs 即交付，延迟 ≤ 1 个窗口，且环里永远
   * 只攒一个窗口的数据（evDrop 只在真溢出时增长）。0 = 关闭该兜底（只保留帧号变化/超时结算，测试用）。
   */
  readonly evFlushMs?: number | undefined;
}

const DEFAULT_EV_RING_BYTES = 2_000_000;

/** 纯事件批的兜底时间窗（ms）：40 ms ⇒ 25 批/s，现场 82~110 kev/s 下每批约 3~4 kev，实时且不成灾 */
const DEFAULT_EV_FLUSH_MS = 40;

// STATS 口径见 protocol README §4.1 / SourceStats：
//   bytesRaw    = 对所有"通过校验"的包累加 RAW_LEN（重复块也算：它解析成功过，且 packets 已把它算作被接受）
//   bytesEvents = 对所有"通过校验"的包累加 EV_LEN（事件流量必须与原始带宽分开看）
//   bytes       = 两者之和（前端画带宽用）
// 为什么必须拆：g02 是两个纯事件包，混算会把"原始带宽"显示成 103 B，评审一问就答不上。
/** 速率窗口下限：低于它不出新值（04 §7.2 的 STATS 是 1 Hz，1 s 窗口才是真实带宽） */
const MIN_RATE_WINDOW_MS = 200;

export class FrameAssembler {
  /** 与传输层共享同一份计数器对象，保证状态栏只有一个口径 */
  readonly counters: Counters;
  readonly unwrapper: FrameIndexUnwrapper;

  private readonly profile: Profile;
  private readonly frameTimeoutMs: number;
  private readonly evRingMaxBytes: number;
  private readonly chunksPerFrame: number;
  private readonly rawChunk: number;
  private readonly recBytes: number;
  private readonly onFrame: ((f: FramePacket) => void) | null;
  private readonly onEvents:
    | ((b: EventBatch, frameIdx: number, seq: number, tArriveMs: number, evOnly?: boolean) => void)
    | null;
  private readonly synthetic: boolean;
  private readonly minRateWindowMs: number;
  /** 数据源是否具备原始段；false = 串口事件-only 链路（见 AssemblerOptions.rawCapable） */
  private readonly rawCapable: boolean;

  // —— 正在装的那一帧 ——
  private frameIdx: number | null = null;
  private frameBuf: Uint8Array | null = null;
  private got: Uint8Array;
  private gotCount = 0;
  private t0Ms = 0;
  private frameSeq = 0;
  // v1 没有 CHUNK_IDX ⇒ 只能在"帧内计段"下按到达顺序编号；丢包时该帧永不齐（02 §4 的既有缺陷）
  private v1Count = 0;
  // WIRE-V3 §4.3：帧时间轴 = 该帧 FIRST_OF_FRAME 包的 TS_US。null = 本帧没有可信板端时间
  // （TS_VALID=0 或 v2 通路无时间戳字段），emitFrame 时回退到到达时刻（tArriveMs 不变）。
  private frameTsUs: number | null = null;
  private frameTsCalibrated = false;
  // WIRE-V3 §5.1：PC 从 TIME_SYNC ACK 学到的 offset_reg（二补码 µs）；null = 尚未校准过
  private tsOffsetUs: number | null = null;
  /** 上一包的板端 µs 时间戳（回退 >1 s ⇒ tsEpochReset，§4.1） */
  private lastTsUs: number | null = null;
  /** 当前包是否刚触发 tsEpochReset（beginFrame 里用它抑制 idxWrap 的误计，§4.3 双钥判据） */
  private curEpochReset = false;

  // —— 帧内事件字节块（交付时才解码，避免每包一次分配/解码）——
  //    只装"属于当前正在装的那一帧"的事件：包内自带的 EV_DATA，以及**被收编的先到事件**（见下）。
  private evChunks: Uint8Array[] = [];
  private evBytes = 0;
  // —— 纯事件包（SEG_MASK=EVENTS）先到时的事件，按包自带 FRAME_IDX 攒着（本任务修复）——
  //    为什么必须和帧内事件分开：板端"积压 >33 条时先发纯事件包"（板端实现报告 §3 第 3 条）⇒
  //    这些事件天然排在**同帧原始包之前**；若和帧环混在一起，上一帧的包会把下一帧的事件一起带走
  //    （跨帧误配）。单目标 + 环上限，涨不上去（evRingMaxBytes）。
  private evPendChunks: Uint8Array[] = [];
  private evPendBytes = 0;
  /** 先到事件当前归属的帧号（null = 无）及其逻辑帧号 */
  private evTargetIdx: number | null = null;
  private evTargetSeq = 0;
  private evLastT = 0;
  /** 当前先到事件批里**最老一条**的到达时刻（时间窗兜底的基准 t0；空环 = 0） */
  private evPendT0 = 0;
  /** 纯事件批的**逻辑帧号**（单调递增，网关自增；EV_ONLY 下事件包帧号冻结，不能拿它当帧号） */
  private evOnlySeq = 0;
  /** 当前 MODE 是否为 EV_ONLY（BLOCK-1：40 ms 时间窗只允许在 EV_ONLY 下生效） */
  private evOnlyMode = false;
  /** 上一个包是否显式 EV_ONLY（v3 MODE2；用于检测"退出 EV_ONLY"边界，BLOCK-2） */
  private evOnlyPrev = false;
  /** 当前包是否显式 EV_ONLY（v3 MODE2；pending 出处标记只认它） */
  private evExplicitOnly = false;
  /** 当前 pending 批是否在 EV_ONLY 期间攒下（决定 legacy 出口必须按 EV_ONLY 结算，不能再进帧配对队列） */
  private evPendEvOnly = false;
  /** 时间窗兜底刷新（0 = 关闭） */
  private readonly evFlushMs: number;
  /** 最近一次真正交付出去的帧号（判定"迟到事件属于已交付帧"用，见 assignPendingToFrame） */
  private lastEmittedIdx: number | null = null;

  // —— 统计窗口（pps/bps 用区间差，不用累计值，避免"瞬时速率"造假）——
  private pkts = 0;
  private bytes = 0;
  private winPkts = 0;
  private winBytes = 0;
  private winStartMs = 0;
  /** 不能用 winStartMs===0 当哨兵：nowMs 完全可能是 0（测试虚拟时钟） */
  private windowStarted = false;
  /** 上一次算出的速率；窗口过短时沿用它，避免把"瞬时暴发"当成带宽 */
  private ratePps = 0;
  private rateBps = 0;
  private lastFrameIdx: number | null = null;
  /** 累计"被接受的 RAW_LEN 之和"（含未凑齐帧的已收段）——golden 向量逐条对拍用 */
  private rawAccepted = 0;
  /** 累计"被接受包的 EV_LEN 之和"（事件流量必须与原始带宽分开看） */
  private evAccepted = 0;
  /** FrameIndexUnwrapper 只暴露 push 的返回值，所以缓存最近一次 wraps */
  private lastWraps = 0;

  constructor(opts: AssemblerOptions) {
    this.profile = opts.profile;
    this.frameTimeoutMs = opts.frameTimeoutMs ?? FRAME_TIMEOUT_MS;
    this.evRingMaxBytes = opts.evRingMaxBytes ?? DEFAULT_EV_RING_BYTES;
    this.evFlushMs = opts.evFlushMs ?? DEFAULT_EV_FLUSH_MS;
    this.chunksPerFrame = opts.profile.chunksPerFrame;
    this.rawChunk = opts.profile.rawChunk;
    this.recBytes = opts.profile.evRecBytes;
    this.onFrame = opts.onFrame ?? null;
    this.onEvents = opts.onEvents ?? null;
    this.synthetic = opts.synthetic ?? false;
    this.minRateWindowMs = opts.minRateWindowMs ?? MIN_RATE_WINDOW_MS;
    this.rawCapable = opts.rawCapable ?? true;
    this.counters = opts.counters ?? createCounters();
    this.unwrapper = new FrameIndexUnwrapper();
    this.got = new Uint8Array(Math.max(1, Math.ceil(this.chunksPerFrame / 8)));
  }

  /** 喂一个已解析的包。tArriveMs 必须是"包到达时刻"（02 §1 的 PC 侧时间基；v3 板端时间是叠加轴，见 §4） */
  push(pkt: AssemblerPacket, tArriveMs: number): void {
    if (pkt.kind === "v1") {
      this.pkts++;
      this.winPkts++;
      this.bytes += pkt.data.length;
      this.rawAccepted += pkt.data.length;
      this.winBytes += pkt.data.length;
      this.pushV1(pkt, tArriveMs);
      return;
    }
    // CTRL 包不进装配器（WIRE-V3 §7.2 装配行"FLAGS.CTRL 包不进装配器、转状态通道"）。
    // 正常路径 processor 已分派，这里是直喂装配器的防御性兜底。
    if (pkt.kind === "v3" && pkt.ctrl) return;
    this.pkts++;
    this.winPkts++;
    this.bytes += pkt.rawLen + pkt.evLen;
    // 通过校验即计入：重复块/越界块也算 —— 它们是异常，要在统计上暴露而不是被悄悄吞掉
    this.rawAccepted += pkt.rawLen;
    this.evAccepted += pkt.evLen;
    this.winBytes += pkt.rawLen + pkt.evLen;

    // —— v3 板端时间戳（WIRE-V3 §4.1）：比上次回退 > 1 s ⇒ 板卡复位/时钟重置。
    //    计 tsEpochReset 并作废当前帧的板端时间（重建帧时间轴），数据照常装配不丢。
    let epochReset = false;
    if (pkt.kind === "v3" && pkt.tsUs !== null) {
      if (this.lastTsUs !== null && pkt.tsUs < this.lastTsUs - CALIB.EPOCH_RESET_US) {
        epochReset = true;
        bump(this.counters, "tsEpochReset");
        this.frameTsUs = null;
        this.frameTsCalibrated = false;
      }
      this.lastTsUs = pkt.tsUs;
    }
    this.curEpochReset = epochReset;

    // —— MODE 路由（WIRE-V3 §7.2 装配行）：
    //    MODE2（EV_ONLY）不拼帧、直接进事件队列（高回传帧率的关键路径）；
    //    MODE1（RAW_ONLY）不进事件图层 —— 即使带事件段（那是 segInconsistent，解析层已告警）。
    const mode = pkt.kind === "v3" ? pkt.mode : MODE3.RAW_EV;
    const routeRaw = pkt.hasRaw && mode !== MODE3.EV_ONLY;
    const routeEvents = pkt.hasEvents && mode !== MODE3.RAW_ONLY;
    // 七修：数据源声明"没有原始段"（串口 UART-LINK）时，无原始段的 v3 事件包**一律**按 EV_ONLY 语义处理。
    // 线上 MODE 仍是板端当前模式（实测串口事件帧 MODE=0、RAW_LEN=0），不能拿 MODE 判"要不要等原始帧"：
    // 串口永远不会有原始段，等下去就是永不结算 ⇒ 页面全黑。UDP（rawCapable=true）完全不进这个分支。
    const noRawSourceEvent = this.rawCapable === false && pkt.kind === "v3" && !pkt.hasRaw && routeEvents;
    // v2 没有 MODE 字段：纯事件包沿用 2026-10-17 的时间窗兜底（既有测试/回放依赖）；v3 严格按 MODE 门控。
    const evOnlyNow = mode === MODE3.EV_ONLY || noRawSourceEvent || (pkt.kind === "v2" && !pkt.hasRaw);
    // "显式 EV_ONLY"：v3 MODE2，或"数据源无原始段"的事件包。v2 仍不划进切换语义（没有模式字段）。
    const evExplicitOnly = mode === MODE3.EV_ONLY || noRawSourceEvent;

    // —— BLOCK-2：EV_ONLY 退出边界先结算残留 ——
    // EV_ONLY 期间攒下的 pending 批用的是板端冻结帧号；模式切回 RAW_EV 后若走 legacy 出口，前端会把它
    // 塞进 evQueue 等一个永不到来的旧帧（CASE3）。因此退出 EV_ONLY 的首个包到达时，除非它正是该批所属帧
    // 的原始包（那种情况应继续被 beginFrame 收编，既有 MODE2→MODE0 排空语义），否则立即以逻辑帧号交付。
    if (this.evOnlyPrev && !evExplicitOnly && this.evPendBytes > 0) {
      const willCollect = routeRaw && this.evTargetIdx !== null && pkt.frameIdx === this.evTargetIdx;
      if (!willCollect) this.flushEventOnly(true);
    }
    this.evOnlyMode = evOnlyNow;
    this.evOnlyPrev = evExplicitOnly;
    this.evExplicitOnly = evExplicitOnly;

    if (routeRaw) {
      // 只按"包自带的帧号"分组；换帧说明上一帧到齐不了
      if (this.frameIdx === null) this.beginFrame(pkt.frameIdx, tArriveMs, pkt, epochReset);
      else if (pkt.frameIdx !== this.frameIdx) {
        this.abortFrame();
        this.beginFrame(pkt.frameIdx, tArriveMs, pkt, epochReset);
      } else if (
        pkt.kind === "v3" && pkt.firstOfFrame && pkt.tsUs !== null && this.frameTsUs === null
      ) {
        // 帧开着但还没取到时间（开局包 TS_VALID=0）：FIRST_OF_FRAME 包的 TS 是权威补位（§4.3）
        this.frameTsUs = pkt.tsUs;
        this.frameTsCalibrated = pkt.tsCalibrated;
      }
      const raw = pkt.raw;
      if (raw !== null && pkt.chunkIdx >= 0 && pkt.chunkIdx < this.chunksPerFrame) {
        if (this.bitOf(pkt.chunkIdx)) {
          // 重复块：忽略后到者（02 §8）
          bump(this.counters, "dupChunk");
        } else {
          const off = pkt.chunkIdx * this.rawChunk;
          const room = this.frameBuf === null ? 0 : this.frameBuf.length - off;
          if (room <= 0) {
            bump(this.counters, "badLength");
          } else {
            const n = Math.min(raw.length, room);
            if (this.frameBuf !== null) this.frameBuf.set(raw.subarray(0, n), off);
            this.setBit(pkt.chunkIdx);
            this.gotCount++;
          }
        }
      } else if (raw !== null) {
        // CHUNK_IDX 越界：宁可不装，也不写坏内存/错位
        bump(this.counters, "badLength");
      }
      if (routeEvents && pkt.events !== null) this.appendEvents(pkt.events, tArriveMs, false);
      if (this.gotCount >= this.chunksPerFrame) this.emitFrame(tArriveMs);
      return;
    }

    if (routeEvents && pkt.events !== null) {
      // 纯事件包（缺口 G3；v3 下 MODE2 也走这里）：不参与"原始帧"生命周期。
      // 否则每换一次帧号就会给一个"其实没打算收原始段"的帧记一次 aborted，把计数器污染成噪声。
      const sameOpenFrame = this.frameBuf !== null && pkt.frameIdx === this.frameIdx;
      if (sameOpenFrame) {
        // 帧已开着且同号 ⇒ 就是本帧的事件，直接进本帧事件环（随帧交付，A5 序由 encodeFrame 保证）
        this.appendEvents(pkt.events, tArriveMs, false);
      } else {
        // —— 时间窗兜底（2026-10-17 事件-only 修复）——
        // 板端 EV_ONLY 下事件包 FRAME_IDX 冻结（udp_merge 用 raw_pop 计数当帧号，raw 不再弹出），
        // 「帧号变化才结算」永远不触发；连续事件流又一直刷新 evLastT ⇒ 原先的 tick 超时也永不触发。
        // 现按最老一条的到达时刻结算：攒够 evFlushMs 就先交付上一窗，本包开新窗。
        // BLOCK-1：**只有 EV_ONLY 才走时间窗**。RAW_EV 下帧间隔可能 >40 ms（单帧 36 ms、网络抖动、
        // 暂停回传），纯事件包是在等它那一帧来收编，提前按 EV_ONLY 交付会让前端跳过 evQueue/recPair。
        if (
          evOnlyNow &&
          this.evFlushMs > 0 &&
          this.evTargetIdx !== null &&
          this.evPendBytes > 0 &&
          tArriveMs - this.evPendT0 >= this.evFlushMs
        ) {
          this.flushEventOnly(true);
        }
        if (this.evTargetIdx !== null && pkt.frameIdx !== this.evTargetIdx) this.flushEventOnly(this.evPendEvOnly);
        if (this.evTargetIdx === null) {
          this.evTargetIdx = pkt.frameIdx;
          const u = this.unwrapper.push(pkt.frameIdx);
          this.evTargetSeq = u.seq;
          this.lastWraps = u.wraps;
        }
        // 先到的事件按帧号攒着：等那一帧的原始包到达时收编（修前是在 beginFrame 里被清掉）
        this.appendEvents(pkt.events, tArriveMs, true);
      }
    }
  }

  /** 定时器周期性调用：帧超时丢整帧（02 §8 的"缺块超时"） */
  tick(nowMs: number): void {
    if (this.frameIdx !== null && nowMs - this.t0Ms > this.frameTimeoutMs) {
      this.abortFrame();
    }
    // 纯事件流没有「齐不齐」的概念，只有「攒太久没人要」——到点就把已有事件交出去。
    // ① 时间窗兜底（主路径，EV_ONLY 下事件包帧号冻结时唯一能结算的路径）；
    // ② 旧口径（evFlushMs=0 或空闲超过 frameTimeoutMs）保留，作为「流停了也要交付」的兜底。
    if (this.evTargetIdx !== null && this.evPendBytes > 0) {
      if (this.evOnlyMode && this.evFlushMs > 0 && nowMs - this.evPendT0 >= this.evFlushMs) {
        this.flushEventOnly(true);
      } else if (nowMs - this.evLastT > this.frameTimeoutMs) {
        this.flushEventOnly(this.evPendEvOnly);
      }
    }
  }

  /** 数据源停止/回放结束：还开着的帧按不完整丢弃（g03 的 aborted=1 就走这条路） */
  finish(): void {
    if (this.frameIdx !== null) this.abortFrame();
    // 还没等到自己那一帧的先到事件：按既有纯事件出口交出去（不丢、不静默；MODE2 纯事件流靠这里结算）
    if (this.evTargetIdx !== null && this.evPendBytes > 0) this.flushEventOnly(this.evPendEvOnly);
  }

  /** 累计被接受的原始字节数（重复块/越界块不计） */
  get bytesRaw(): number {
    return this.rawAccepted;
  }

  /** 累计被接受的事件字节数（含半条记录的余数：它在线上真实占过带宽） */
  get bytesEvents(): number {
    return this.evAccepted;
  }

  /**
   * 供 STATS 推送用的聚合快照。
   * packets/bytes 是累计值；pps/bps 是"距上次快照"的区间速率，
   * 且窗口短于 minRateWindowMs 时不重算（沿用上次值）——见 AssemblerOptions.minRateWindowMs 的理由。
   */
  snapshotStats(nowMs: number): SourceStats {
    if (!this.windowStarted) {
      this.windowStarted = true;
      this.winStartMs = nowMs;
    }
    const dtMs = nowMs - this.winStartMs;
    if (dtMs >= this.minRateWindowMs) {
      this.ratePps = (this.winPkts * 1000) / dtMs;
      this.rateBps = (this.winBytes * 1000) / dtMs;
      this.winPkts = 0;
      this.winBytes = 0;
      this.winStartMs = nowMs;
    }
    return {
      packets: this.pkts,
      bytes: this.bytes,
      bytesRaw: this.rawAccepted,
      bytesEvents: this.evAccepted,
      pps: this.ratePps,
      bps: this.rateBps,
      lastFrameIdx: this.lastFrameIdx === null ? 0 : this.lastFrameIdx,
      wraps: this.lastWraps,
      tNowMs: nowMs,
    };
  }

  // ————————————————————————— 内部 —————————————————————————

  /**
   * PC 侧学到的板端 offset_reg（µs，二补码）。
   * 来源：TIME_SYNC ACK 的 TLV 0x84（WIRE-V3 §6.2）。板端未标 TS_CALIBRATED 的包由 PC 代加它；
   * 已标 calibrated 的包不能加（板端已加过，再加就重了）。
   */
  setTsOffsetUs(offsetUs: number | null): void {
    this.tsOffsetUs = offsetUs;
  }

  private beginFrame(rawIdx: number, tArriveMs: number, pkt?: ParsedV2 | ParsedV3, epochReset = false): void {
    this.frameIdx = rawIdx;
    this.frameBuf = new Uint8Array(this.profile.frame.bytes);
    this.got = new Uint8Array(Math.max(1, Math.ceil(this.chunksPerFrame / 8)));
    this.gotCount = 0;
    this.t0Ms = tArriveMs;
    this.evChunks = [];
    this.evBytes = 0;
    // ★ 先到的事件按帧号归属（本任务修复；修前这里是无条件清环 ⇒ 静默丢失，见 assignPendingToFrame）
    this.assignPendingToFrame(rawIdx);
    // 帧时间轴（WIRE-V3 §4.3）：开局包的可信板端 TS；v2/v1 包没有时间戳字段 → null
    this.frameTsUs = pkt !== undefined && pkt.kind === "v3" && pkt.tsUs !== null ? pkt.tsUs : null;
    this.frameTsCalibrated = pkt !== undefined && pkt.kind === "v3" ? pkt.tsCalibrated : false;
    const u = this.unwrapper.push(rawIdx);
    this.frameSeq = u.seq;
    // 16bit 回绕（§4.3 双钥判据）：FRAME_IDX 回退而 TS_US 前进 ⇒ idxWrap；
    // 两者同时回退是板卡复位，已在 push 里计 tsEpochReset，这里不得重复计 idxWrap
    if (u.wraps > this.lastWraps && !epochReset && !this.curEpochReset) {
      bump(this.counters, "idxWrap", u.wraps - this.lastWraps);
    }
    this.lastWraps = u.wraps;
    this.curEpochReset = false;
    // 帧号跳变只计数、不丢帧（02 §8）；gapOf 处理 16bit 回绕
    if (this.lastFrameIdx !== null) {
      const gap = gapOf(this.lastFrameIdx, rawIdx);
      if (gap > 1) bump(this.counters, "idxGap", gap - 1);
    }
    this.lastFrameIdx = rawIdx;
  }

  /**
   * 把"纯事件包先到"的那批事件按包自带 FRAME_IDX 归属（2026-10-13 网关事件修复）。
   *
   * 修前这里是 `evChunks=[] / evBytes=0 / evTargetIdx=null` 的无条件清环：板端"积压 >33 条时先发纯事件包"
   * （板端实现报告 §3 第 3 条）⇒ 纯事件包天然排在同帧原始包之前 ⇒ 事件被收下（bytesEvents 在涨）
   * 却一条不推、也不计任何丢弃计数（静默）。
   *
   * 四种情形（新增测试逐条钉）：
   *   ① 同号 ⇒ **收编**：挪进本帧事件环，随本帧一起交付（IPC 仍是 A5 序：EVENTS(N) 先、FRAME_RAW(N) 后）
   *   ② 事件的帧号还在前面（乱序/16bit 回绕边界）⇒ 继续按帧号留着，等它那一帧到达时收编
   *   ③ 事件的帧号已过、且那一帧**交付过**（板端解耦事件包迟到）⇒ 走既有纯事件出口（不丢、不静默）
   *   ④ 事件的帧号已过、且那一帧**从未交付**（丢帧/跳号/模式切换）⇒ 真正无法归属：计 evOrphan 显式丢弃
   */
  private assignPendingToFrame(rawIdx: number): void {
    const k = this.evTargetIdx;
    if (k === null) return;
    if (k === rawIdx) {
      if (this.evPendBytes > 0) {
        // 先到的事件排在本帧自带的帧内事件之前（线上它们确实更早）
        for (const c of this.evPendChunks) this.evChunks.push(c);
        this.evBytes += this.evPendBytes;
        this.enforceEventRing();
      }
      this.clearPending();
      return;
    }
    if (gapOf(rawIdx, k) < 0x8000) return; // ② 事件帧号在前：留着，等它那一帧
    if (this.lastEmittedIdx !== null && gapOf(k, this.lastEmittedIdx) < 0x8000) {
      this.flushEventOnly(this.evPendEvOnly); // ③ 迟到事件：既有纯事件出口（EV_ONLY 残留按逻辑号交付）
      return;
    }
    const recs = this.evPendBytes / this.recBytes; // ④ 无法归属：显式计数丢弃
    if (recs > 0) bump(this.counters, "evOrphan", recs);
    this.clearPending();
  }

  private clearPending(): void {
    this.evPendChunks = [];
    this.evPendBytes = 0;
    this.evPendT0 = 0;
    this.evTargetIdx = null;
    this.evPendEvOnly = false;
  }

  private abortFrame(): void {
    bump(this.counters, "aborted");
    this.frameIdx = null;
    this.frameBuf = null;
    this.gotCount = 0;
    // 本帧事件环里的字节随本帧一起作废（帧级的账已经在 aborted 上）；
    // **先到的纯事件批不在其中** —— 它按自己的帧号归属，必须留到那一帧/结算点
    // （修前这里把它一起清掉，与 beginFrame 的清环是同一类静默丢失，见 assignPendingToFrame）
    this.evChunks = [];
    this.evBytes = 0;
    this.frameTsUs = null;
    this.frameTsCalibrated = false;
  }

  private emitFrame(tArriveMs: number): void {
    const buf = this.frameBuf;
    if (buf === null) return;
    const events = this.takeEvents();
    // 板端时间轴三路径（WIRE-V3 §4/§5）：
    //   ① TS 有效 + 板端已校准 → 直接 µs→ms；② TS 有效 + 未校准 + PC 知 offset → PC 代加；
    //   ③ 无可信时间（TS_VALID=0 / v2 通路 / offset 未知）→ undefined，上层回退到达时刻。
    const tBoardMs = this.frameTsUs === null
      ? undefined
      : (boardTsToMs(this.frameTsUs, { offsetUs: this.tsOffsetUs, calibrated: this.frameTsCalibrated }) ?? undefined);
    const frame: FramePacket = {
      frameIdx: this.frameIdx === null ? 0 : this.frameIdx,
      seq: this.frameSeq,
      w: this.profile.frame.w,
      h: this.profile.frame.h,
      // 必须拷一份：frameBuf 会复用/重装，FramePacket 按原则 P2 不可变
      raw: buf.slice(0, this.profile.frame.bytes),
      pixel: this.profile.frame.pixel,
      events,
      tArriveMs,
      ...(tBoardMs === undefined ? {} : { tBoardMs }),
      synthetic: this.synthetic,
    };
    this.frameIdx = null;
    this.frameBuf = null;
    this.gotCount = 0;
    this.v1Count = 0;
    this.frameTsUs = null;
    this.frameTsCalibrated = false;
    this.lastEmittedIdx = frame.frameIdx; // 迟到事件的归属判据（assignPendingToFrame 情形③）
    if (this.onFrame !== null) this.onFrame(frame);
  }

  private pushV1(pkt: ParsedV1, tArriveMs: number): void {
    if (pkt.isFirst) {
      if (this.frameIdx !== null) this.abortFrame();
      this.beginFrame(pkt.frameIdx, tArriveMs);
      this.v1Count = 0;
    } else if (this.frameIdx === null) {
      // 首包丢失 ⇒ 后续纯数据包无法归属（02 §4）：丢弃，不猜、不错位
      return;
    }
    if (this.v1Count >= this.chunksPerFrame) {
      bump(this.counters, "badLength");
      return;
    }
    const off = this.v1Count * this.rawChunk;
    const room = this.frameBuf === null ? 0 : this.frameBuf.length - off;
    if (room <= 0) {
      bump(this.counters, "badLength");
      return;
    }
    const n = Math.min(pkt.data.length, room);
    if (this.frameBuf !== null) this.frameBuf.set(pkt.data.subarray(0, n), off);
    this.setBit(this.v1Count);
    this.gotCount++;
    this.v1Count++;
    if (this.gotCount >= this.chunksPerFrame) this.emitFrame(tArriveMs);
  }

  /**
   * 事件段入环（半条记录丢余数并计数，绝不让余数污染后续记录的对齐 02 §2.4 / P5）。
   * pending=true ⇒ 进"先到事件"环（等帧号归属），false ⇒ 进当前帧的事件环。
   */
  private appendEvents(bytes: Uint8Array, tArriveMs: number, pending: boolean): void {
    if (bytes.length === 0) return;
    this.evLastT = tArriveMs;
    const usable = bytes.length - (bytes.length % this.recBytes);
    if (usable !== bytes.length) bump(this.counters, "evPartial");
    if (usable === 0) return;
    const seg = usable === bytes.length ? bytes : bytes.subarray(0, usable);
    if (pending) {
      // 时间窗基准：窗口里**最老一条**的到达时刻（空环时本条就是起点）
      if (this.evPendChunks.length === 0) {
        this.evPendT0 = tArriveMs;
        // 记下这批的出处：EV_ONLY 期间攒下的事件即使到了模式切换后，也不能再按"等帧配对"交付
        this.evPendEvOnly = this.evExplicitOnly;
      }
      this.evPendChunks.push(seg);
      this.evPendBytes += usable;
      const r = trimRing(this.evPendChunks, this.evPendBytes, this.evRingMaxBytes, this.recBytes);
      this.evPendChunks = r.chunks;
      this.evPendBytes = r.bytes;
      if (r.dropped > 0) bump(this.counters, "evDrop", r.dropped);
    } else {
      this.evChunks.push(seg);
      this.evBytes += usable;
      this.enforceEventRing();
    }
  }

  private enforceEventRing(): void {
    const r = trimRing(this.evChunks, this.evBytes, this.evRingMaxBytes, this.recBytes);
    this.evChunks = r.chunks;
    this.evBytes = r.bytes;
    if (r.dropped > 0) bump(this.counters, "evDrop", r.dropped);
  }

  /** 当前帧的事件环 → EventBatch（帧内事件 + 被收编的先到事件） */
  private takeEvents(): EventBatch {
    const batch = decodeBatch(concatChunks(this.evChunks, this.evBytes), this.recBytes);
    this.evChunks = [];
    this.evBytes = 0;
    return batch;
  }

  /** 先到事件的环 → EventBatch（还没有帧来收编时走纯事件出口） */
  private takePendingEvents(): EventBatch {
    const batch = decodeBatch(concatChunks(this.evPendChunks, this.evPendBytes), this.recBytes);
    this.evPendChunks = [];
    this.evPendBytes = 0;
    this.evPendT0 = 0;
    this.evPendEvOnly = false;
    return batch;
  }

  /**
   * 纯事件批交付。
   * @param evOnly true = 时间窗兜底交付（与原始帧**不配对**：板端 EV_ONLY 下事件包帧号冻结）。
   *   这条路径必须带**网关自增的逻辑帧号**（单调递增；前端据此推进批次序列，且不再等 FRAME_RAW），
   *   并把 evOnly 标记透传到 IPC（ws.pushEvents 置 FLAG_EV_ONLY）。false = 既有出口（帧号变化/迟到事件）。
   */
  private flushEventOnly(evOnly = false): void {
    const idx = this.evTargetIdx;
    if (idx === null) return;
    const batch = this.takePendingEvents();
    this.evTargetIdx = null;
    if (batch.records.length > 0 && this.onEvents !== null) {
      if (evOnly) {
        this.evOnlySeq = (this.evOnlySeq + 1) >>> 0;
        this.onEvents(batch, idx, this.evOnlySeq, this.evLastT, true);
      } else {
        this.onEvents(batch, idx, this.evTargetSeq, this.evLastT);
      }
    }
  }

  private bitOf(i: number): boolean {
    const b = this.got[i >> 3];
    return b !== undefined && (b & (1 << (i & 7))) !== 0;
  }

  private setBit(i: number): void {
    const k = i >> 3;
    const b = this.got[k];
    if (b !== undefined) this.got[k] = b | (1 << (i & 7));
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function decodeBatch(raw: Uint8Array, recBytes: number): EventBatch {
  const decoded = decodeEvents(raw, recBytes);
  return { records: decoded.records, dropped: 0, thinned: false, raw };
}

/**
 * 事件环溢出：按**整条记录**丢最旧并计 evDrop（04 §6 背压）。
 * 为什么按整条丢：丢半个记录会让剩下的记录整体错位（比丢数据更难查）。
 * 帧内事件环与"先到事件"环共用这一份口径（evRingMaxBytes 各自封顶 ⇒ 涨不上去）。
 */
function trimRing(
  chunks: readonly Uint8Array[],
  bytes: number,
  maxBytes: number,
  recBytes: number,
): { chunks: Uint8Array[]; bytes: number; dropped: number } {
  if (bytes <= maxBytes) return { chunks: chunks as Uint8Array[], bytes, dropped: 0 };
  const work = chunks as Uint8Array[];
  let needRecs = Math.ceil((bytes - maxBytes) / recBytes);
  let dropped = 0;
  let i = 0;
  while (needRecs > 0 && i < work.length) {
    const first = work[i];
    if (first === undefined) break;
    const recs = first.length / recBytes;
    if (recs <= needRecs) {
      bytes -= first.length;
      needRecs -= recs;
      dropped += recs;
      i++;
    } else {
      const cut = needRecs * recBytes;
      work[i] = first.subarray(cut);
      bytes -= cut;
      dropped += needRecs;
      needRecs = 0;
    }
  }
  return { chunks: work.slice(i), bytes, dropped };
}
