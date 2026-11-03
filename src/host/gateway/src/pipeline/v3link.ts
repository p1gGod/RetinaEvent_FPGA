// v3 链路状态机（WIRE-V3 设计 §5/§6 的 PC 侧落点）：
//   · 下行命令（SET_PARAM / SET_MODE / TIME_SYNC / GET_STATUS）编码 + SEQ 分配 + ACK 匹配（§6.1/§6.3）
//   · 校准握手：板端 TIME_SYNC_REQ（0x83）→ 立即应答 TIME_SYNC（0x03）；PC 主动校准按 600 s 节流（§5.2）
//   · 状态聚合：STATUS 心跳与数据包 MODE 双源校验（§3.3 第 5 条），TLV 状态（§6.2）
// 为什么收发都做成注入：单测里不发真 UDP 包、不睡真定时器，节流/超时逻辑才能确定性覆盖。
import {
  CALIB,
  CTRL,
  DOWNLINK,
  buildEvEnPayload,
  buildSetModePayload,
  buildSetParamPayload,
  buildTimeSyncPayload,
  bump,
  encodeDownlink,
  interpretStatusTlvs,
  readTsUs,
} from "@retina/protocol";
import type { Counters, CtrlTlv, ParsedV3, V3SerStateView, V3StatusView } from "@retina/protocol";
import { createCounters } from "@retina/protocol";

/** ACK 等待结果（ board 回的 STATUS + TLV 解释；超时/未启用时 ok=false 且带原因） */
export interface AckResult {
  readonly ok: boolean;
  readonly opcode: number;
  readonly seq: number;
  /** 板端 STATUS 字节（超时时 null） */
  readonly status: number | null;
  readonly detail: string;
  readonly tlvs?: ReturnType<typeof interpretStatusTlvs>;
}

export interface V3LinkOptions {
  /** 下行发送通道（真实实现 = DownlinkSocket.send；测试用捕获数组） */
  readonly send: (bytes: Uint8Array) => void;
  /** PC 单调时基（µs）——HOST_TS_US 的取值口径（§6.3.3 / U6 建议"PC 单调时基"） */
  readonly nowUs: () => number;
  /** 墙钟 ms（calAgeMs 显示用）；缺省 Date.now */
  readonly nowMs?: () => number;
  /** PC 主动校准周期（缺省 600 s = 10 min，§5.2 周期默认值） */
  readonly calPeriodUs?: number;
  /** ACK 等待超时（缺省 1000 ms；§8.2 局域网 RTT < 1 ms，1 s 足够宽） */
  readonly ackTimeoutMs?: number;
  /** 计数器（与源共享一份口径） */
  readonly counters?: Counters;
  /** ACK 超时定时器工厂（测试注入以避免真定时器） */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
}

interface PendingCmd {
  readonly opcode: number;
  readonly seq: number;
  readonly resolve: (r: AckResult) => void;
  readonly timer: unknown;
  /** 九修：心跳（GET_STATUS 探活）不计入"用户命令在飞"，自动回退可照常进行 */
  readonly heartbeat: boolean;
}

/** V3Link 对外暴露的控制入口（main.ts 组装成 GatewayControl.board） */
export interface BoardControlApi {
  /**
   * SET_PARAM：θ / MIN_DL / 抽帧比 + **UART 扩展 tag 0x07..0x0A**（板端实现报告 §3.3 ④）
   * + **sccb 集成 tag 0x0B EXP_CAP**（sccb 集成报告 §9.1，2026-10-13）。
   * minDl 由 `buildSetParamPayload` 按 0..511 钳位、expCap 按 4..5904 钳位
   * （两者越界板端都会 BAD_VALUE 且整条不写）。
   */
  setParam(params: {
    theta?: number;
    minDl?: number;
    frameDecim?: number;
    evRes?: number;
    serDecim?: number;
    serAgg?: number;
    serEvFlushMs?: number;
    /** 曝光上限（**sccb 集成 tag 0x0B**，4..5904 行；2026-10-13 对齐）：越界由协议层钳位 */
    expCap?: number;
    /**
     * 串口波特率档位（**串口提速 tag 0x0C**，2026-10-17）：必须是
     * 115200 / 230400 / 460800 / 921600 之一；非法值由协议层抛错，绝不静默取默认。
     */
    serialBaud?: number;
  }): Promise<AckResult>;
  setMode(mode: number): Promise<AckResult>;
  getStatus(): Promise<AckResult>;
  /**
   * PC 主动校准一次。F2（2026-10-13）：**优先于自动 600 s 节流**（自动 tick 让位一次），
   * 只挡 2 s 内的连点/双击；同一动作不会发两帧。
   */
  calibrate(): Promise<AckResult>;
  /** 事件支路开关（**v3.1 增补 EV_EN=0x05**）：true=使能 / false=禁用 */
  evEn(enabled: boolean): Promise<AckResult>;
}

export class V3Link implements BoardControlApi {
  /**
   * 手动校准的最小重触发间隔（单调 µs，F2）：连点/双击不重复发帧。
   * 为什么不复用 600 s：那会让 UI「立即校准」在自动 tick 占坑后结构性失效（F2 的根因）。
   * 2 s 足够挡住一次双击/连点，又不会让操作者感到"点了没反应"。
   */
  static readonly MANUAL_MIN_GAP_US = 2_000_000;

  readonly counters: Counters;
  private readonly send: (bytes: Uint8Array) => void;
  private readonly nowUs: () => number;
  private readonly nowMs: () => number;
  private readonly calPeriodUs: number;
  private readonly ackTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  private seq = 0;
  private readonly pending = new Map<number, PendingCmd>();

  /** 十修：心跳 ACK 健康度（只统计 getStatus({heartbeat:true})，不参与 V3StatusView 线格式） */
  private hbAck = 0;
  private hbFail = 0;
  private hbLastAckAtMs: number | null = null;
  private hbLastRttMs: number | null = null;

  /** 尚未收到 ACK 的下行命令数（S8：自动回退不得打断正在输入/等待确认的命令） */
  get inFlight(): number {
    return this.pending.size;
  }

  /** 用户命令（不含九修心跳）在飞数：S8 的"不打断用户命令"只看这个 */
  get userInFlight(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.heartbeat) n++;
    return n;
  }
  /** 已见过 v3 上行包（v2 固件期间不发任何下行命令，避免污染 dlReject 计数） */
  seenV3 = false;

  // —— 状态聚合（STATS 推送 + UI 显示）——
  private wireVer: 2 | 3 = 2;
  private dataMode: number | null = null;
  private statusMode: number | null = null;
  private theta: number | null = null;
  private minDl: number | null = null;
  private tsOffsetUs: number | null = null;
  private tsRttUs: number | null = null;
  private tsCalibrated: boolean | null = null;
  private tsStale = false;
  private tsEpochReset = false;
  private tsAlignErrMs: number | null = null;
  private bootId: number | null = null;
  /** 事件支路开关最近一次读回值（v3.1 TLV 0x8C：EV_EN ACK 与 GET_STATUS 尾部携带；null = 板端尚未上报）。
   *  ⚠️ 字段名不能叫 evEn：类字段会在实例上遮蔽同名方法（JS 字段初始化在原型方法之后） */
  private lastEvEn: boolean | null = null;
  /** 串口事件支路读回（UART 扩展 TLV 0x8D/0x8E；板端实现报告 §3.3。null = 板端尚未上报） */
  private evRes: number | null = null;
  private serState: V3SerStateView | null = null;
  /** 网口可用性检测器读回（UART 扩展 TLV 0x8F：0=DOWN/1=UP/2=UNKNOWN；null = 尚未上报） */
  private netState: number | null = null;
  /**
   * 曝光上限板端读回值（**sccb 集成 TLV 0x90**，2026-10-13 对齐；null = 尚未上报）。
   * 以板端读回为准（同 0x8C 口径）：SET_PARAM ACK 与 GET_STATUS 刷新它，心跳/旧固件不携带时保持现值。
   */
  private expCap: number | null = null;
  /**
   * 串口当前生效波特率板端读回值（**串口提速 TLV 0x91**，2026-10-17；null = 旧位流/尚未上报）。
   * 与 0x8C/0x90 同一口径：只认板端读回，绝不用下发值顶替。
   */
  private boardBaud: number | null = null;
  private calFailures = 0;
  /** 最近一次校准（墙钟 ms）：REQ 应答或 ACK OK 都算 */
  private lastCalAtMs: number | null = null;
  /** PC 主动校准的节流戳（单调 µs）；board 端发起的 REQ 应答也刷新它 —— 两边共用同一时间轴 */
  private lastCalStampUs: number | null = null;
  /** PC 侧发出 HOST_TS_US 的时刻（算 tsAlignErrMs 用，§5.1 第 5 步） */
  private lastSyncSendUs: number | null = null;
  /** MODE 双源冲突去重：同一对冲突值只计一次 */
  private lastConflictKey: string | null = null;
  /** 最近一次因冲突重发 GET_STATUS 的墙钟 ms（§7.2"重发 GET_STATUS"的节流） */
  private lastResendMs = -Infinity;

  constructor(opts: V3LinkOptions) {
    this.send = opts.send;
    this.nowUs = opts.nowUs;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.calPeriodUs = opts.calPeriodUs ?? CALIB.PERIOD_US;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 1000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.counters = opts.counters ?? createCounters();
  }

  // ————————————————————————— 下行命令 —————————————————————————

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /**
   * 发一条命令并等 ACK（§6.1：SEQ 板端必须在 ACK 中回声 ⇒ 按.seq 匹配）。
   *
   * silent（2026-10-31，串口动作轮询）：ACK 照常按 SEQ 匹配、照常超时结算，但**不** emitCtrlEvent。
   * 为什么需要：网关每秒自动发一条 GET_STATUS 读动作快照（main.ts 的 startUartStatusPoll），
   * 若走普通通道，`TRANSPORT_CTRL` 会每秒推一条 ack 事件 ⇒ 面板「最近命令」被状态查询刷屏、
   * ackTracker 把自动轮询当成用户操作。silent 只掐推送，不影响 inFlight/超时/计数器口径。
   * 不复用 heartbeat：heartbeat 会把 hbAck/hbFail 心跳健康度带偏（那是 0xF0 专用口径）。
   */
  private command(opcode: number, payload: Uint8Array, heartbeat = false, silent = false): Promise<AckResult> {
    const seq = this.nextSeq();
    const bytes = encodeDownlink(opcode, seq, payload);
    const sentAtMs = heartbeat ? this.nowMs() : 0;
    return new Promise<AckResult>((resolve) => {
      const finish = (r: AckResult): void => {
        const atMs = this.nowMs();
        if (heartbeat) {
          if (r.ok) {
            this.hbAck++;
            this.hbLastAckAtMs = atMs;
            this.hbLastRttMs = Math.max(0, atMs - sentAtMs);
          } else {
            this.hbFail++;
          }
        }
        if (!silent) {
          this.emitCtrlEvent({
            kind: "ack", opcode: r.opcode, seq: r.seq, ok: r.ok, status: r.status, detail: r.detail, atMs,
            // 十修（ADDITIVE）：前端据此静默心跳 ACK，不弹 toast、不进"最近命令"列表。
            ...(heartbeat ? { heartbeat: true } : {}),
          });
        }
        resolve(r);
      };
      const timer = this.setTimer(() => {
        this.pending.delete(seq);
        // tsCalFail 口径（WIRE-V3 §7.2）：只统计校准类命令的失败，普通命令超时不算校准失败
        if (opcode === DOWNLINK.OPCODE.TIME_SYNC) this.calFailures++;
        finish({ ok: false, opcode, seq, status: null, detail: "ACK 超时（" + this.ackTimeoutMs + " ms 内未回）" });
      }, this.ackTimeoutMs);
      this.pending.set(seq, { opcode, seq, resolve: finish, timer, heartbeat });
      this.send(bytes);
    });
  }

  private emitCtrlEvent(e: Record<string, unknown>): void {
    if (this.onCtrlEvent !== null) this.onCtrlEvent(e);
  }

  setParam(params: {
    theta?: number;
    minDl?: number;
    frameDecim?: number;
    evRes?: number;
    serDecim?: number;
    serAgg?: number;
    serEvFlushMs?: number;
    expCap?: number;
    serialBaud?: number;
  }): Promise<AckResult> {
    // minDl 的 0..511 与 expCap 的 4..5904 钳位都在 buildSetParamPayload 内完成，此处不再重复判据；
    // serialBaud 的 4 档校验也在协议层抛错（非法档必须明确失败，不能静默编码成默认档）
    return this.command(DOWNLINK.OPCODE.SET_PARAM, buildSetParamPayload(params));
  }

  setMode(mode: number): Promise<AckResult> {
    return this.command(DOWNLINK.OPCODE.SET_MODE, buildSetModePayload(mode));
  }

  /** 事件支路开关（v3.1 增补 EV_EN=0x05，载荷 1 B 0/1；ACK 机制与其它命令相同）。
   *  2026-10-11 对齐板端：ACK 带 TLV 0x8C（写后读回）⇒ 状态以读回为准；
   *  ACK 无 0x8C（旧固件）时才回退用下发值。 */
  async evEn(enabled: boolean): Promise<AckResult> {
    const r = await this.command(DOWNLINK.OPCODE.EV_EN, buildEvEnPayload(enabled));
    if (r.ok) {
      const back = r.tlvs?.evEn ?? null;
      this.lastEvEn = back === null ? enabled : back;
    }
    return r;
  }

  /**
   * GET_STATUS（0x04）：ACK 尾部携带权威动作快照（TLV 0x92，见 downlink_cmd.v ★M4b）。
   *
   * · heartbeat：板端 0xF0 心跳口径（只用于串口链路保活，参与 heartbeatStats 统计）
   * · silent：网关自动轮询口径（2026-10-31）—— 不发 CTRL 事件、不进「最近命令」，
   *   但 ACK/超时/SEQ 语义与普通命令完全一致
   *
   * BoardControlApi 接口保持无参（UI 的「刷新状态」按钮就是心跳之外的普通命令），
   * 这两个开关只给网关内部两条自动通道用。
   */
  getStatus(opts: { readonly heartbeat?: boolean; readonly silent?: boolean } = {}): Promise<AckResult> {
    return this.command(DOWNLINK.OPCODE.GET_STATUS, new Uint8Array(0), opts.heartbeat === true, opts.silent === true);
  }

  /** 十修：心跳健康度（STATS 的 transport.uart.heartbeat 由 live.ts 合并进来） */
  heartbeatStats(): { readonly ack: number; readonly fail: number; readonly lastAckAtMs: number | null; readonly lastRttMs: number | null } {
    return { ack: this.hbAck, fail: this.hbFail, lastAckAtMs: this.hbLastAckAtMs, lastRttMs: this.hbLastRttMs };
  }

  /**
   * PC 主动校准（§6.3.3 TIME_SYNC 的第二用途）。
   *
   * F2（2026-10-13）：手动校准**优先于自动节流** —— 现场实测（v3联板验证报告 §F2）里
   * 网关启动 ~1 s 的 `maybeCalibrate()` tick 就占用了 600 s 闸门，此后 UI"立即校准"
   * 在稳定态几乎不可命中（只在"重启网关后 ≤1 s 抢跑"能成功）。
   * 现在：手动不被 600 s 周期拦，只挡"同一动作的连点/双击"（`MANUAL_MIN_GAP_US`），
   * 命中后刷新节流戳 ⇒ 自动 tick 让位一次（其后的 600 s 内不再自动发起）。
   * 防重语义不变：闸门仍只有 `tryTakeCalSlot` 一处，同一动作不会发两帧。
   */
  async calibrate(): Promise<AckResult> {
    if (!this.tryTakeCalSlot({ manual: true })) {
      const ageMs = this.lastCalStampUs === null ? null : (this.nowUs() - this.lastCalStampUs) / 1000;
      const detail = ageMs === null
        ? "校准节流中：链路尚未就绪或最近一次校准刚发起"
        : "刚校准过（" + Math.round(ageMs) + " ms 前）：同一动作不重复发帧";
      return { ok: false, opcode: DOWNLINK.OPCODE.TIME_SYNC, seq: 0, status: null, detail };
    }
    return await this.sendTimeSyncNow();
  }

  /** 组装并发送 TIME_SYNC 下行（§6.3.3）：HOST_TS_US = PC 当前单调 µs，RTT_HALF=0（板端自算） */
  private async sendTimeSyncNow(): Promise<AckResult> {
    this.lastSyncSendUs = this.nowUs();
    return await this.command(DOWNLINK.OPCODE.TIME_SYNC, buildTimeSyncPayload(this.lastSyncSendUs, 0, false));
  }

  // ————————————————————————— 校准节流（判据③） —————————————————————————

  /**
   * PC 主动周期校准：距上次校准满 600 s 才发起（WIRE-V3 §5.2 周期默认值）。
   * 返回是否真的发起了。重复调用（比如每秒 tick 一次）不会重复发起 —— 这是判据③的核心。
   */
  maybeCalibrate(): boolean {
    if (!this.tryTakeCalSlot()) return false;
    void this.sendTimeSyncNow();
    return true;
  }

  /**
   * 校准节流闸门：唯一决定"这次要不要真发帧"的地方，不发送。
   * 三处调用：maybeCalibrate（周期 tick）/ calibrate（UI 立即校准）/ 板端 REQ 应答由上层自行发送。
   *
   * F2（2026-10-13）语义改成"手动优先"：
   *   · 自动（manual 缺省）：距上次校准不满 calPeriodUs（600 s）不发 —— 判据③不变；
   *     手动校准或板端 REQ 刷新过戳后，自动 tick 在这里让位。
   *   · 手动（manual=true）：不受 600 s 周期约束（否则 UI「立即校准」在稳定态结构性不可命中），
   *     只挡 MANUAL_MIN_GAP_US 内的连点/双击 —— 保证"同一次主动校准只发一帧"。
   * 为什么闸门仍然只有这一个：历史 bug 是"闸门里发一次、调用方再发一次"⇒ 一次主动校准出两帧。
   */
  private tryTakeCalSlot(opts: { manual?: boolean } = {}): boolean {
    if (!this.seenV3) return false; // v2 固件期间不发（板上没有 0x03 解析器，发了也是 dlReject）
    const now = this.nowUs();
    const sinceUs = this.lastCalStampUs === null ? null : now - this.lastCalStampUs;
    if (opts.manual === true) {
      if (sinceUs !== null && sinceUs < V3Link.MANUAL_MIN_GAP_US) return false;
    } else if (sinceUs !== null && sinceUs < this.calPeriodUs) {
      return false;
    }
    this.lastCalStampUs = now;
    return true;
  }

  // ————————————————————————— 上行 CTRL 入口 —————————————————————————

  /**
   * 喂一个 v3 CTRL 包（processor 从 parseV3Packet 分派过来）。
   * 覆盖三类：TIME_SYNC_REQ（0x83 REQ）→ 立即应答；命令 ACK（SEQ 回声）→ 匹配 pending；
   * STATUS 心跳（0xF0）→ 只更新状态。
   */
  onCtrlPacket(pkt: ParsedV3): void {
    const ch = pkt.ctrlHeader;
    if (ch === null) return;
    this.seenV3 = true;
    this.wireVer = 3;
    const tlvs = interpretStatusTlvs(ch.tlv);
    this.absorbTlvs(tlvs);

    if (ch.opcode === CTRL.OPCODE.STATUS_HEARTBEAT) {
      this.checkModeConflict();
      return;
    }
    if (ch.opcode === CTRL.OPCODE.TIME_SYNC_REQ && this.isSyncReq(ch)) {
      this.respondToSyncReq(ch.seq, ch.payload);
      return;
    }
    // 命令 ACK：按 SEQ 回声匹配（§6.1）
    const p = this.pending.get(ch.seq);
    if (p === undefined) return; // 无请求可答（如 KEY0 触发的自发行为）：忽略
    this.pending.delete(ch.seq);
    this.clearTimer(p.timer);
    if (ch.opcode === DOWNLINK.OPCODE.TIME_SYNC && ch.status === DOWNLINK.STATUS.OK) {
      this.onSyncAck(ch.seq, tlvs);
    }
    p.resolve({
      ok: ch.status === DOWNLINK.STATUS.OK,
      opcode: ch.opcode,
      seq: ch.seq,
      status: ch.status,
      detail: ch.status === DOWNLINK.STATUS.OK ? "OK" : "板端 STATUS=" + ch.status,
      tlvs,
    });
  }

  /** 数据包 MODE（主通道，延迟 ≤1 包，§3.3 第 5 条）——processor 每包回报 */
  noteDataMode(mode: number): void {
    this.seenV3 = true;
    this.wireVer = 3;
    this.dataMode = mode;
    this.checkModeConflict();
  }

  /** offset 吸取口（main.ts 接到 source.setTsOffsetUs） */
  onOffsetChanged: ((offsetUs: number | null) => void) | null = null;
  /** 命令/校准事件出口（main.ts 接到 hub.pushCtrlEvent → TYPE_CTRL，WIRE-V3 §7.2） */
  onCtrlEvent: ((e: Record<string, unknown>) => void) | null = null;

  /** 当前状态视图（STATS v3 字段 / GatewayControl.board.status()） */
  statusView(): V3StatusView {
    const calAgeMs = this.lastCalAtMs === null ? null : Math.max(0, this.nowMs() - this.lastCalAtMs);
    return {
      wireVer: this.wireVer,
      mode: this.dataMode ?? this.statusMode,
      tsCalibrated: this.tsCalibrated,
      tsStale: this.tsStale,
      tsEpochReset: this.tsEpochReset,
      tsOffsetUs: this.tsOffsetUs,
      tsRttUs: this.tsRttUs,
      tsAlignErrMs: this.tsAlignErrMs,
      calAgeMs,
      calFailures: this.calFailures,
      bootId: this.bootId,
      theta: this.theta,
      minDl: this.minDl,
      evEn: this.lastEvEn,
      evRes: this.evRes,
      serState: this.serState,
      netState: this.netState,
      expCap: this.expCap,
      serialBaud: this.boardBaud,
      downlinkAvailable: true,
    };
  }

  // ————————————————————————— 内部 —————————————————————————

  private absorbTlvs(tlvs: ReturnType<typeof interpretStatusTlvs>): void {
    if (tlvs.mode !== null) this.statusMode = tlvs.mode;
    if (tlvs.theta !== null) this.theta = tlvs.theta;
    if (tlvs.minDl !== null) this.minDl = tlvs.minDl;
    if (tlvs.tsOffsetUs !== null) this.setOffset(tlvs.tsOffsetUs);
    if (tlvs.tsRttUs !== null) this.tsRttUs = tlvs.tsRttUs;
    if (tlvs.tsFlags !== null) {
      this.tsCalibrated = (tlvs.tsFlags & CTRL.TS_FLAG.CALIBRATED) !== 0;
      this.tsStale = (tlvs.tsFlags & CTRL.TS_FLAG.STALE) !== 0;
      this.tsEpochReset = (tlvs.tsFlags & CTRL.TS_FLAG.EPOCH_RESET) !== 0;
    }
    if (tlvs.bootId !== null) this.bootId = tlvs.bootId;
    // 事件支路状态以板端读回为准（v3.1 TLV 0x8C：EV_EN ACK 与 GET_STATUS 尾部都携带）；
    // 心跳子集/旧固件不带（null）时保持现值，绝不用"下发值"顶掉板端真值
    if (tlvs.evEn !== null) this.lastEvEn = tlvs.evEn;
    // UART 扩展（板端实现报告 §3.3）：0x8D/0x8E 随 SET_PARAM ACK 与 GET_STATUS 来时刷新，0x8F 随心跳/插发刷新；
    // 未携带（null）时保持现值 —— 与 0x8C 同一"以板端读回为准、缺失不回退"口径
    if (tlvs.evRes !== null) this.evRes = tlvs.evRes;
    if (tlvs.serState !== null) this.serState = tlvs.serState;
    if (tlvs.netState !== null) this.netState = tlvs.netState;
    // 曝光上限读回（sccb 集成 TLV 0x90，2026-10-13）：SET_PARAM ACK 与 GET_STATUS 刷新；
    // 心跳/旧固件（无 0x90）时保持现值 —— 同一"以板端读回为准、缺失不回退"口径
    if (tlvs.expCap !== null) this.expCap = tlvs.expCap;
    // 串口波特率读回（串口提速 TLV 0x91，2026-10-17）：SET_PARAM ACK / GET_STATUS 携带；
    // 旧位流无 0x91 ⇒ null 保持 null，绝不写下发值
    if (tlvs.serialBaud !== null) this.boardBaud = tlvs.serialBaud;
  }

  private setOffset(offsetUs: number): void {
    const changed = this.tsOffsetUs !== offsetUs;
    this.tsOffsetUs = offsetUs;
    if (changed && this.onOffsetChanged !== null) this.onOffsetChanged(offsetUs);
  }

  /** TIME_SYNC ACK（§5.1 第 4/5 步）：记校准点、算单向误差 err = ((t4'−t1) − RTT)/2 */
  private onSyncAck(_seq: number, tlvs: ReturnType<typeof interpretStatusTlvs>): void {
    this.lastCalAtMs = this.nowMs();
    this.tsCalibrated = true;
    if (this.tsOffsetUs === null && tlvs.tsOffsetUs !== null) this.setOffset(tlvs.tsOffsetUs);
    if (this.lastSyncSendUs !== null && this.tsRttUs !== null) {
      const t4p = this.nowUs();
      const errUs = (t4p - this.lastSyncSendUs - this.tsRttUs) / 2;
      this.tsAlignErrMs = errUs / 1000;
    }
    this.emitCtrlEvent({
      kind: "calibrated", offsetUs: this.tsOffsetUs, rttUs: this.tsRttUs,
      alignErrMs: this.tsAlignErrMs, atMs: this.lastCalAtMs,
    });
  }

  private isSyncReq(ch: { readonly ctrlLen: number; readonly payload: Uint8Array; readonly tlv: readonly CtrlTlv[] }): boolean {
    // 消歧规则见 codec/v3.ts splitSyncCtrl：REQ 载荷 = 裸 6 B BOARD_TS_US；ACK 带 TLV
    if (ch.ctrlLen === 6) return true;
    return ch.tlv.length === 0;
  }

  /** 板端 REQ → 立即应答（§5.1 第 2 步）：HOST_TS_US = t1（PC 收到时刻），SEQ = 回声请求 SEQ */
  private respondToSyncReq(reqSeq: number, payload: Uint8Array): void {
    const t1 = this.nowUs();
    this.lastCalStampUs = t1; // 板端发起的校准同样刷新节流戳：10 min 内 PC 不再主动发起
    this.lastCalAtMs = this.nowMs();
    const t2 = payload.length >= 6 ? readTsUs(payload, 0) : null; // 板端本机 µs（记录/误差分析用）
    this.send(encodeDownlink(DOWNLINK.OPCODE.TIME_SYNC, reqSeq, buildTimeSyncPayload(t1, 0, false)));
    this.emitCtrlEvent({ kind: "timeSyncReq", boardSeq: reqSeq, boardTsUs: t2, hostTsUs: t1, atMs: this.lastCalAtMs });
  }

  /** MODE 双源校验（§7.2 网关行）：数据包 MODE 与 STATUS 心跳 MODE 不一致 ⇒ 计 modeConflict 并重发 GET_STATUS */
  private checkModeConflict(): void {
    if (this.dataMode === null || this.statusMode === null) return;
    if (this.dataMode === this.statusMode) {
      this.lastConflictKey = null;
      return;
    }
    const key = this.dataMode + "->" + this.statusMode;
    if (key !== this.lastConflictKey) {
      this.lastConflictKey = key;
      bump(this.counters, "modeConflict");
    }
    // 重发 GET_STATUS 读回真值；节流 2 s 防风暴（KEY0 切换的过渡期两个源会短暂不一致）
    const nowMs = this.nowMs();
    if (nowMs - this.lastResendMs >= 2000) {
      this.lastResendMs = nowMs;
      void this.getStatus();
    }
  }
}
