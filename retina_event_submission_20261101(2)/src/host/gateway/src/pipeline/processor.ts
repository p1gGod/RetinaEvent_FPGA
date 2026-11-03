// 解析分发层：线上字节 → 已解析包 → 装配器。
// 为什么单独一层：transport 只搬字节、不知道协议含义（04 §2 的依赖方向），
// 而"按 profile 选 v1/v2、失败怎么计数"必须只有一处实现 —— 这样回放/实时/合成
// 三种数据源走的是完全相同的解析路径（原则 P4，答辩时才能拿回放当实时代替品）。
import { COUNTER_KEYS, bump, parseV1Packet, parseV2Packet, parseV3Packet } from "@retina/protocol";
import type { Counters, EventBatch, FramePacket, ParsedV3, Profile, SourceError, SourceStats } from "@retina/protocol";
import { actionRawOfPacket, actionStore, hasActionStateTlv } from "../action.ts";
import { FrameAssembler } from "./assembler.ts";

// 只认 COUNTER_KEYS 里有的名字：codec 的 warnings 可能带 detail 后缀，别把自由文本当计数器
const COUNTER_SET = new Set<string>(COUNTER_KEYS);
function counterKeyOf(raw: string): string | null {
  const head = raw.split(/[:=\[]/)[0];
  if (head === undefined) return null;
  const trimmed = head.trim();
  return COUNTER_SET.has(trimmed) ? trimmed : null;
}

export interface ProcessorOptions {
  readonly profile: Profile;
  // 同 AssemblerOptions：这些字段是被原样转发的，exactOptionalPropertyTypes 下要允许 undefined
  readonly frameTimeoutMs?: number | undefined;
  readonly evRingMaxBytes?: number | undefined;
  readonly synthetic?: boolean | undefined;
  /** 数据源是否具备原始段（七修：串口 UART-LINK=false；UDP/回放缺省 true） */
  readonly rawCapable?: boolean | undefined;
  /** 与传输层共享同一份计数器（状态栏只有一个口径） */
  readonly counters?: Counters | undefined;
  readonly onFrame?: ((f: FramePacket) => void) | undefined;
  readonly onEvents?: ((b: EventBatch, frameIdx: number, seq: number, tArriveMs: number) => void) | undefined;
  readonly onError?: ((e: SourceError) => void) | undefined;
  /**
   * v3 CTRL 包出口（WIRE-V3 §7.2：FLAGS.CTRL 包不进装配器、转状态通道）。
   * ACK / STATUS 心跳 / TIME_SYNC_REQ 都从这里给 V3Link。
   */
  readonly onCtrl?: ((pkt: ParsedV3) => void) | undefined;
  /** v3 数据包 MODE 观察者（网关据此维护 currentMode，§3.3 第 5 条主通道） */
  readonly onV3Mode?: ((mode: number) => void) | undefined;
}

export class PacketProcessor {
  readonly assembler: FrameAssembler;
  readonly counters: Counters;

  private readonly profile: Profile;
  /**
   * 数据源是否具备原始段（串口事件链路 = false，见 transport/serial.ts 构造的 rawCapable:false）。
   * 装配器已有一份同名字段（管"等原始段结算"），这里是**动作快照**用的第二份判据：
   * 串口事件帧的 byte23 不是真实动作字节（uart_ev_tap.v 封 24 B 头时 OFF3.ACTION 落 default=0x00），
   * 照旧 observe 会把「无动作」写进快照，并覆盖掉 GET_STATUS ACK 里读回的真值。
   */
  private readonly rawCapable: boolean;
  private readonly onError: ((e: SourceError) => void) | null;
  private readonly onCtrl: ((pkt: ParsedV3) => void) | null;
  private readonly onV3Mode: ((mode: number) => void) | null;
  /** v1 非首包不带帧号，codec 需要知道"见没见过首包"（V1Ctx.expectChunk） */
  private v1ExpectChunk: number | null = null;
  private telemWarned = false;

  constructor(opts: ProcessorOptions) {
    this.profile = opts.profile;
    this.rawCapable = opts.rawCapable ?? true;
    this.onCtrl = opts.onCtrl ?? null;
    this.onV3Mode = opts.onV3Mode ?? null;
    this.assembler = new FrameAssembler({
      profile: opts.profile,
      counters: opts.counters,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
      synthetic: opts.synthetic,
      rawCapable: opts.rawCapable,
      onFrame: opts.onFrame,
      onEvents: opts.onEvents,
    });
    this.counters = this.assembler.counters;
    this.onError = opts.onError ?? null;
  }

  /** 喂一个原始 UDP 负载（合成/回放/实时都一样，不允许有旁路） */
  pushRawPayload(buf: Uint8Array, tArriveMs: number): void {
    if (this.profile.wire === "STREAM") {
      // v2/v3 按魔数第 4 字节分派（WIRE-V3 §9.2：互不误判）。
      // 板端还没换 v3 固件时收到的是 v2 帧 ⇒ 0x0F 走老路径，0x30 走 v3。
      if (buf.length >= 4 && (buf[3] as number) === 0x30 && (buf[0] as number) === 0xf0) {
        const r = parseV3Packet(buf, { profile: this.profile });
        if (!r.ok) {
          bump(this.counters, r.reason);
          return;
        }
        for (const w of r.value.warnings) {
          const k = counterKeyOf(w);
          if (k !== null) bump(this.counters, k as keyof Counters);
        }
        // 动作识别字节（byte23 = OFF3.ACTION，契约 05 §2.1）：数据包与 CTRL 包都带。
        // 只更新快照/事件环，不触发任何执行；CTRL 包里若尾追 TLV 0x92 则以 TLV 为准（§3）。
        // 为什么放在 ctrl 分支之前：GET_STATUS ACK 是动作快照最权威的一条来源，不能被 return 掉。
        //
        // CTRL 包例外（M4g）：心跳 0xF0 等下行命令的 byte23 在 downlink_cmd.v 落 default = 0x00，
        // 那是"这个包不带动作字节"，不是"板端现在没有动作"。若照旧 observe，1 Hz 心跳会把
        // prevValid 打回 false，下一条 0xFD 数据包又记一次 valid_rise ⇒ 检测次数被系统性放大
        // （实测 32 条事件里 30 条 conf=31、seq 间隔 43 ms，物理上穿不过 1.5 s 不应期）。
        // 所以 CTRL 包只有带权威 TLV 0x92（len=1，只随 GET_STATUS ACK）时才喂 observe；
        // 普通数据包不受影响，仍每包更新快照。
        //
        // 串口链路（rawCapable=false，2026-10-31）：事件帧是"v3 24 B 头逐字节同构"，但 byte23
        // 由 uart_ev_tap.v:203-232 的 default 分支填 0x00 ⇒ 每来一帧事件就把动作快照打成「无动作」，
        // GET_STATUS ACK 读回的真值立刻被下一帧覆盖（活体实测 /api/action 的 raw 恒 0、frameIdx 却在涨）。
        // 串口下没有真实原始段可读，动作真值只能来自 TLV 0x92 ⇒ 一律只认权威 TLV；
        // UDP/回放（rawCapable≠false）保持原行为，byte23 是真的 OFF3.ACTION。
        const authoritative = hasActionStateTlv(r.value);
        if (this.rawCapable === false ? authoritative : (!r.value.ctrl || authoritative)) {
          actionStore.observe(actionRawOfPacket(buf, r.value), r.value.frameIdx, tArriveMs);
        }
        if (r.value.ctrl) {
          // CTRL 不进装配器：转状态/校准通道（§7.2 装配行）
          if (this.onCtrl !== null) this.onCtrl(r.value);
          return;
        }
        if (this.onV3Mode !== null) this.onV3Mode(r.value.mode);
        this.assembler.push(r.value, tArriveMs);
        return;
      }
      const r = parseV2Packet(buf, {
        profile: this.profile,
        // profile 明确写 present 才强制要求 CRC16；auto 两种长度都收（02 §2.5）
        strictCrc: this.profile.crc16 === "present",
      });
      if (!r.ok) {
        bump(this.counters, r.reason);
        return;
      }
      for (const w of r.value.warnings) {
        const k = counterKeyOf(w);
        if (k !== null) bump(this.counters, k as keyof Counters);
      }
      this.assembler.push(r.value, tArriveMs);
      return;
    }

    if (this.profile.wire === "LEGACY") {
      const r = parseV1Packet(buf, { profile: this.profile, expectChunk: this.v1ExpectChunk });
      if (!r.ok) {
        bump(this.counters, r.reason);
        return;
      }
      this.v1ExpectChunk = r.value.isFirst ? 1 : (this.v1ExpectChunk ?? 0) + 1;
      this.assembler.push(r.value, tArriveMs);
      return;
    }

    // TELEM 走串口，不是 UDP 帧通路（M3 未接）：明确报一次错，不静默吞包
    if (!this.telemWarned) {
      this.telemWarned = true;
      if (this.onError !== null) {
        this.onError({ code: "unsupported-wire", message: "profile wire=TELEM 不支持 UDP 帧通路（应走 UART）", fatal: false });
      }
    }
  }

  tick(nowMs: number): void {
    this.assembler.tick(nowMs);
  }

  /** 流结束/停止：结算悬挂帧（g03 的 aborted=1 靠这里） */
  finish(): void {
    this.assembler.finish();
  }

  snapshotStats(nowMs: number): SourceStats {
    return this.assembler.snapshotStats(nowMs);
  }

  /** PC 侧学到的板端 offset_reg（V3Link 从 ACK 学到后注入；WIRE-V3 §5.1） */
  setTsOffsetUs(offsetUs: number | null): void {
    this.assembler.setTsOffsetUs(offsetUs);
  }

  /** 与 snapshotStats().bytesRaw 同源；有的调用点只想要这一个量 */
  get bytesEvents(): number {
    return this.assembler.bytesEvents;
  }

  get bytesRaw(): number {
    return this.assembler.bytesRaw;
  }
}
