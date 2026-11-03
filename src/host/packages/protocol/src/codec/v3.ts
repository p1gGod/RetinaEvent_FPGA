// UDP v3 单包解析 / 下行命令编码 / CTRL TLV —— 唯一权威依据 WIRE-V3 设计（docs/05_实验与实测/协议v3设计_20261009）。
// v2 codec（v2.ts）保持只读用于旧记录回放（设计 §7.2）；v2/v3 按魔数分派（§9.2），互不误判。
import {
  ACT3,
  CTRL,
  DOWNLINK,
  EXP_CAP_LIMITS,
  FLAGS3,
  LIMITS3,
  MAGIC_V3,
  MAGIC_V3_DOWN,
  MIN_DL_LIMITS,
  MODE3,
  OFF3,
  SERIAL_BAUD_RATES,
  serialBaudCode,
  serialBaudOfCode,
  WIRE_V3,
} from "../constants.ts";
import type { CountersKey, CtrlHeader, CtrlTlv, ParsedV3, ParseResult, Profile } from "../types.ts";
import { crc16 } from "./crc.ts";

export interface ParseV3Options {
  readonly profile: Profile;
}

function fail(reason: CountersKey, detail: string): ParseResult<ParsedV3> {
  return { ok: false, reason, detail };
}

/** 线上前 4 字节是否为 v3 上行魔数（processor 按它分派 v2/v3，设计 §9.2） */
export function hasV3Magic(buf: Uint8Array): boolean {
  if (buf.length < MAGIC_V3.length) return false;
  for (let i = 0; i < MAGIC_V3.length; i++) {
    if (buf[i] !== MAGIC_V3[i]) return false;
  }
  return true;
}

// ————————————————————————— 动作识别字节（byte23 = OFF3.ACTION） —————————————————————————
// 唯一依据：docs/03_技术原理/05_动作回传与上位机契约.md §2.1（2026-10-29 与板端/RTL 定案）。
// 为什么解码放协议层：这是线格格式的一部分，前端/网关/测试都必须只调这一份实现
// （上位机原则 P1：线格式只有一处解码，避免"三个地方各移一次位"）。

/** 动作字节解码结果（契约 §2.2 的 ActionByte；types.ts 不在本轮白名单，故就地声明） */
export interface ActionState {
  readonly valid: boolean;
  /** 置信度 0..31（越大越可信；是否采纳由上层按 minConf 门槛判） */
  readonly conf: number;
  /** 0=无动作/静止 / 1=手部开合（任一方向） / 2=横向挥手 / 3=保留（当无动作） */
  readonly cls: 0 | 1 | 2 | 3;
}

/**
 * 解码 byte23 → {valid, conf, cls}（契约 §2.1）。
 * 容错：入参按 8 bit 截断（高 8 位来自 DataView 之外的误用一律忽略），**永不抛错**；
 * 未启用/缺省字节 0x00 自然解成 {valid:false, conf:0, cls:0}，调用方据此显示"识别未启用"。
 */
export function decodeActionState(raw: number): ActionState {
  const b = raw & 0xff;
  return {
    valid: (b & ACT3.VALID) !== 0,
    conf: (b >>> ACT3.CONF_SHIFT) & ACT3.CONF_MASK,
    cls: (b & ACT3.CLASS_MASK) as 0 | 1 | 2 | 3,
  };
}

/**
 * 反向编码（契约 §2.2 的 encodeActionByte）：测试/联板自检用。
 * conf 夹到 0..31、cls 夹到 0..3 —— 宁可产出"最接近的合法字节"，也不让自检脚本因越界抛错。
 */
export function encodeActionState(s: { readonly valid: boolean; readonly conf: number; readonly cls: number }): number {
  const conf = Math.max(0, Math.min(ACT3.CONF_MASK, Math.trunc(s.conf)));
  const cls = Math.max(0, Math.min(ACT3.CLASS_MASK, Math.trunc(s.cls)));
  return (s.valid ? ACT3.VALID : 0) | (conf << ACT3.CONF_SHIFT) | cls;
}

/** 48 bit 大端时间戳 → Number（2^48 < 2^53，安全整数，无精度损失） */
export function readTsUs(buf: Uint8Array, off: number): number {
  return (
    (buf[off] as number) * 2 ** 40 +
    (buf[off + 1] as number) * 2 ** 32 +
    (buf[off + 2] as number) * 2 ** 24 +
    (buf[off + 3] as number) * 2 ** 16 +
    (buf[off + 4] as number) * 2 ** 8 +
    (buf[off + 5] as number)
  );
}

/** 6 B 二补码（offset_reg 低 48 位）→ 有符号 Number */
export function readI48(buf: Uint8Array, off: number): number {
  const u = readTsUs(buf, off);
  return u >= 2 ** 47 ? u - 2 ** 48 : u;
}

/** TLV 列表解析：tag(1)+len(1)+value(len)。越界即停（不抛错，坏 TLV 由上层按长度自洽拒包） */
export function parseTlvs(bytes: Uint8Array): CtrlTlv[] {
  const out: CtrlTlv[] = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const tag = bytes[i] as number;
    const len = bytes[i + 1] as number;
    if (i + 2 + len > bytes.length) break;
    out.push({ tag, value: bytes.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

const KNOWN_TLV_TAGS = new Set<number>(Object.values(CTRL.TLV));

/** opcode 0x83 的 REQ/ACK 消歧（设计 §5.1 未给显式判据，按载荷形态判，详见实现报告"遗留问题"） */
function splitSyncCtrl(opcode: number, payload: Uint8Array): { req: boolean; tlv: CtrlTlv[] } {
  if (opcode !== CTRL.OPCODE.TIME_SYNC_REQ) return { req: false, tlv: parseTlvs(payload) };
  // REQ 载荷 = BOARD_TS_US 裸 6 B；其首字节（µs 计数 bits47..40，上电 ~12.7 天内恒 0）不可能是合法 TLV tag
  if (payload.length === 6) return { req: true, tlv: [] };
  const tlv = parseTlvs(payload);
  const looksLikeAck = tlv.length > 0 && tlv.every((t) => KNOWN_TLV_TAGS.has(t.tag));
  return looksLikeAck ? { req: false, tlv } : { req: true, tlv: [] };
}

/**
 * v3 上行包解析（WIRE-V3 设计 §2.3 硬规则逐条落地）。
 * 判据顺序：定位 → 头长 → 上限 → 长度自洽 → 段一致性（告警）→ CRC → 取段。
 * TS_VALID=0 只忽略时间戳，不影响帧装配（§2.3 尾部规则）。
 */
export function parseV3Packet(buf: Uint8Array, opts: ParseV3Options): ParseResult<ParsedV3> {
  void opts.profile; // 与 v2 对称保留；v3 头自描述（HDR_LEN/EV_REC_BYTES），profile 只供装配层用
  const warnings: string[] = [];

  // 定位：len ≥ 24 且魔数 F0 5A A5 30 且 VER=0x03（§2.3 第 1 行）
  if (buf.length < OFF3.HEADER) return fail("truncated", "len=" + buf.length + " < 24");
  if (!hasV3Magic(buf)) return fail("badMagic", "前 4 字节不是 F0 5A A5 30");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ver = dv.getUint8(OFF3.VER);
  if (ver !== WIRE_V3) return fail("badVersion", "VER=0x" + ver.toString(16) + " ≠ 0x03");
  const hdrLen = dv.getUint8(OFF3.HDR_LEN);
  if (hdrLen < OFF3.HEADER) return fail("badHdrLen", "HDR_LEN=" + hdrLen + " < 24");
  // >24：按声明的头长跳过附加头（前向兼容，§2.3 头长规则）
  const hdr = hdrLen;
  if (buf.length > LIMITS3.MAX_PAYLOAD) return fail("oversize", "len=" + buf.length + " > " + LIMITS3.MAX_PAYLOAD);

  const flags = dv.getUint8(OFF3.FLAGS);
  const modeRaw = dv.getUint8(OFF3.MODE);
  const chunkIdx = dv.getUint16(OFF3.CHUNK_IDX);
  const frameIdx = dv.getUint16(OFF3.FRAME_IDX);
  const rawLen = dv.getUint16(OFF3.RAW_LEN);
  const evLen = dv.getUint16(OFF3.EV_LEN);
  const evRecBytes = dv.getUint8(OFF3.EV_REC_BYTES);

  if (rawLen > LIMITS3.RAW_LEN) return fail("oversize", "RAW_LEN=" + rawLen + " > " + LIMITS3.RAW_LEN);
  if (evLen > LIMITS3.EV_LEN) return fail("oversize", "EV_LEN=" + evLen + " > " + LIMITS3.EV_LEN);

  const isCtrl = (flags & FLAGS3.CTRL) !== 0;
  const crcPresent = (flags & FLAGS3.CRC_PRESENT) !== 0;
  // CTRL：len == hdr + 6(控制头) + CTRL_LEN + (CRC?2:0)；§2.1 CTRL 例外（RAW_LEN=EV_LEN=0）
  const expectLen = isCtrl
    ? hdr + CTRL.HEADER + dv.getUint16(hdr + 4) + (crcPresent ? 2 : 0)
    : hdr + rawLen + evLen + (crcPresent ? 2 : 0);
  if (buf.length !== expectLen) return fail("badLength", "len=" + buf.length + " ≠ 期望 " + expectLen);
  if (isCtrl && (rawLen !== 0 || evLen !== 0)) {
    return fail("badLength", "CTRL 包必须 RAW_LEN=EV_LEN=0（实际 " + rawLen + "/" + evLen + "）");
  }

  // 未知 MODE：按 MODE2 稳健降级并告警，不丢整包（§2.3 未知 MODE 规则）
  let mode = modeRaw;
  if (modeRaw > MODE3.EV_ONLY) {
    mode = MODE3.EV_ONLY;
    warnings.push("modeNotice");
  }

  // 段一致性：以 FLAGS 为准并告警（§2.3）；MODE 与 FLAGS 相容性同计 segInconsistent
  const hasRaw = (flags & FLAGS3.RAW_PRESENT) !== 0;
  const hasEvents = (flags & FLAGS3.EV_PRESENT) !== 0;
  if (hasRaw !== rawLen > 0) warnings.push("segInconsistent");
  if (hasEvents !== evLen > 0) warnings.push("segInconsistent");
  if (mode === MODE3.RAW_ONLY && hasEvents) warnings.push("segInconsistent");
  if (mode === MODE3.EV_ONLY && hasRaw) warnings.push("segInconsistent");

  // 带 CRC 时先验后取（失败整包丢弃）；覆盖范围 [0 .. 24+RAW+EV-1]，CTRL 为 [0 .. 30+CTRL_LEN-1]（§6.2）
  if (crcPresent) {
    const body = hdr + (isCtrl ? CTRL.HEADER + dv.getUint16(hdr + 4) : rawLen + evLen);
    const want = dv.getUint16(body);
    const got = crc16(buf.subarray(0, body));
    if (want !== got) return fail("crcFail", "CRC16 期望 0x" + want.toString(16) + " 实得 0x" + got.toString(16));
  }

  // CTRL：解析 6 B 控制头 + TLV/REQ 载荷（§6.2）
  let ctrlHeader: CtrlHeader | null = null;
  if (isCtrl) {
    const opcode = dv.getUint8(hdr);
    const status = dv.getUint8(hdr + 1);
    const seq = dv.getUint16(hdr + 2);
    const ctrlLen = dv.getUint16(hdr + 4);
    const payload = buf.subarray(hdr + CTRL.HEADER, hdr + CTRL.HEADER + ctrlLen);
    const split = splitSyncCtrl(opcode, payload);
    ctrlHeader = { opcode, status, seq, ctrlLen, payload, tlv: split.tlv };
    if (split.req) warnings.push("ctrlReq");
  }

  const tsValid = (flags & FLAGS3.TS_VALID) !== 0;
  const raw = hasRaw && rawLen > 0 ? buf.subarray(hdr, hdr + rawLen) : null;
  const evStart = hdr + rawLen;
  const events = hasEvents && evLen > 0 ? buf.subarray(evStart, evStart + evLen) : null;

  return {
    ok: true,
    value: {
      kind: "v3",
      ver,
      hdrLen,
      flags,
      mode,
      modeRaw,
      hasRaw,
      hasEvents,
      chunkIdx,
      frameIdx,
      rawLen,
      evLen,
      tsUs: tsValid ? readTsUs(buf, OFF3.TS_US) : null,
      tsValid,
      tsCalibrated: (flags & FLAGS3.TS_CALIBRATED) !== 0,
      firstOfFrame: (flags & FLAGS3.FIRST_OF_FRAME) !== 0,
      lastOfFrame: (flags & FLAGS3.LAST_OF_FRAME) !== 0,
      ctrl: isCtrl,
      evRecBytes: evRecBytes > 0 ? evRecBytes : 5, // 无事件段时板上写 0；装配仍按 profile 的 5
      raw,
      events,
      crc16Present: crcPresent,
      ctrlHeader,
      warnings,
    },
  };
}

// ————————————————————————— 下行命令编码（§6） —————————————————————————

/** 下行通用包：MAGIC_D(4) VER(1) OPCODE(1) SEQ(2,BE) LEN(2,BE) payload CRC16(2,BE 覆盖 [0..10+LEN)) */
export function encodeDownlink(opcode: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > 1400) throw new Error("下行载荷超上限：" + payload.length + " > 1400（设计 §6.1 LEN 0..1400）");
  const out = new Uint8Array(DOWNLINK.HEADER + payload.length + 2);
  out.set(MAGIC_V3_DOWN, 0);
  out[DOWNLINK.HEADER - 6] = WIRE_V3;
  out[DOWNLINK.HEADER - 5] = opcode & 0xff;
  const dv = new DataView(out.buffer);
  dv.setUint16(6, seq & 0xffff);
  dv.setUint16(8, payload.length);
  out.set(payload, DOWNLINK.HEADER);
  dv.setUint16(DOWNLINK.HEADER + payload.length, crc16(out.subarray(0, DOWNLINK.HEADER + payload.length)));
  return out;
}

/** 单条下行 TLV：tag(1) + len(1) + value（u8/u16/u32 大端，设计 §6.3.1） */
export function tlvU8(tag: number, v: number): Uint8Array {
  const out = new Uint8Array(3);
  out[0] = tag & 0xff;
  out[1] = 1;
  out[2] = v & 0xff;
  return out;
}
export function tlvU16(tag: number, v: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = tag & 0xff;
  out[1] = 2;
  new DataView(out.buffer).setUint16(2, v & 0xffff);
  return out;
}
export function tlvU32(tag: number, v: number): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = tag & 0xff;
  out[1] = 4;
  new DataView(out.buffer).setUint32(2, v >>> 0);
  return out;
}
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * MIN_DL 输入钳位（**统一把关报告 Q-7 / P-5**）：板端寄存器 9 bit ⇒ 0..511。
 * 600 → 511、负值 → 0、非有限值 → 0，并取整（板端按整数比较，浮点写入无意义）。
 * ⚠️ 不改板端、不改值域判据（板端 >511 仍返回 BAD_VALUE 且整条不写）——
 *    这里只是让上位机**不发出**注定被拒的值，消除"原子性连坐"陷阱。
 *    单位/上限待算法组 U7 定案；定案后仅需改 `MIN_DL_LIMITS` 一个表（可回退）。
 */
export function clampMinDl(v: number): number {
  if (!Number.isFinite(v)) return MIN_DL_LIMITS.MIN;
  return Math.max(MIN_DL_LIMITS.MIN, Math.min(MIN_DL_LIMITS.MAX, Math.round(v)));
}

/**
 * EXP_CAP 输入钳位（**sccb 集成报告 §4.1 / §9.1**，2026-10-13）：
 * 板端值域 4..5904（`EXP_CAP_LIMITS`，= sccb_patch 的 EXP_CAP_MIN/MAX）。
 * 600 在值域内 ⇒ **原样通过**（与 MIN_DL 的"600→511"不同：那不是同一个值域）；
 * 越界/非有限值钳到最近边界并取整（板端按整数比较，浮点写入无意义）。
 * ⚠️ 与 `clampMinDl()` 同一先例：板端仍会对越界值回 BAD_VALUE 并**整条不写** ——
 *    这里只是让上位机不发出注定被拒、且会连坐同包其它合法参数的整条命令。
 *    "钳位不静默"由 UI 层负责（`clampBoardExpCapInput` 返回 clamped 标志 → 提示用户）。
 */
export function clampExpCap(v: number): number {
  if (!Number.isFinite(v)) return EXP_CAP_LIMITS.MIN;
  return Math.max(EXP_CAP_LIMITS.MIN, Math.min(EXP_CAP_LIMITS.MAX, Math.round(v)));
}

/** SET_PARAM 载荷（§6.3.1 + UART 扩展 tag 0x07..0x0A）：TLV 列表，顺序无关；原子性由板端保证（先全验后写） */
export interface SetParamSpec {
  /** 事件触发阈值 0..4095（tag 0x01，u16 BE） */
  readonly theta?: number;
  /**
   * 最小下采样 0..511（tag 0x02，u16 BE）。⚠️ 单位待算法组 U7 定案；
   * 板端 9 bit 寄存器上限 511（Q-7），本函数按 `clampMinDl()` 钳位后再编码（600→511、负值→0）。
   */
  readonly minDl?: number;
  /** 原始帧回传抽帧比 1..255（tag 0x03，u16 BE） */
  readonly frameDecim?: number;
  /** 事件看门狗周期 4..1048576 拍（tag 0x04，u32 BE） */
  readonly evFlushCyc?: number;
  /** 校准周期 60..86400 s（tag 0x05，u32 BE） */
  readonly tsCalPeriodS?: number;
  /** 值 1 = 立即校准一次（tag 0x06，u8） */
  readonly tsForceCal?: number;
  /** 串口事件分辨率 0/1/2（tag 0x07，u8；与 serAgg≠0 互斥 —— 板端 BAD_VALUE 整条不写） */
  readonly evRes?: number;
  /** 串口事件均匀抽点 1..255（tag 0x08，u8；默认 32） */
  readonly serDecim?: number;
  /** 串口事件聚合 0/1/2（tag 0x09，u8；与 evRes≠0 互斥） */
  readonly serAgg?: number;
  /** RAW 档短帧看门狗 5..1000 ms（tag 0x0A，u16 BE；默认 20） */
  readonly serEvFlushMs?: number;
  /**
   * OV5640 AEC 曝光上限（**sccb 集成增补 tag 0x0B**，u16 BE，单位 = 行；2026-10-13 对齐）。
   * 值域 4..5904（`EXP_CAP_LIMITS`）；本函数按 `clampExpCap()` 钳位后再编码
   * （越界值板端回 BAD_VALUE 且**整条不写**，会连坐同包其它合法 tag —— 同 MIN_DL 的 Q-7/P-5 陷阱）。
   * 板端收到写入后约 1 ms 内重跑整条 SCCB 曝光寄存器写序列（0x3a02/03/0x3a14/15）；
   * 等值写入零副作用（不重触发补写）。
   */
  readonly expCap?: number;
  /**
   * 串口波特率档位（**串口提速增补 tag 0x0C**，u8 档位码；2026-10-17 对齐）。
   * 值必须是 `SERIAL_BAUD_RATES` 之一（115200/230400/460800/921600），这里先映射成 code 再编码；
   * 非法值直接抛错（不得静默取默认，否则 UI 以为换了档、板端却还在旧档）。
   */
  readonly serialBaud?: number;
}

export function buildSetParamPayload(spec: SetParamSpec): Uint8Array {
  const parts: Uint8Array[] = [];
  if (spec.theta !== undefined) parts.push(tlvU16(DOWNLINK.TAG.THETA, spec.theta));
  // 钳位而非原样编码：值域 0..511（Q-7）。超出范围的值必被板端 BAD_VALUE 拒绝并连坐整条命令
  if (spec.minDl !== undefined) parts.push(tlvU16(DOWNLINK.TAG.MIN_DL, clampMinDl(spec.minDl)));
  if (spec.frameDecim !== undefined) parts.push(tlvU16(DOWNLINK.TAG.FRAME_DECIM, spec.frameDecim));
  if (spec.evFlushCyc !== undefined) parts.push(tlvU32(DOWNLINK.TAG.EV_FLUSH_CYC, spec.evFlushCyc));
  if (spec.tsCalPeriodS !== undefined) parts.push(tlvU32(DOWNLINK.TAG.TS_CAL_PERIOD_S, spec.tsCalPeriodS));
  if (spec.tsForceCal !== undefined) parts.push(tlvU8(DOWNLINK.TAG.TS_FORCE_CAL, spec.tsForceCal));
  if (spec.evRes !== undefined) parts.push(tlvU8(DOWNLINK.TAG.EV_RES, spec.evRes));
  if (spec.serDecim !== undefined) parts.push(tlvU8(DOWNLINK.TAG.SER_DECIM, spec.serDecim));
  if (spec.serAgg !== undefined) parts.push(tlvU8(DOWNLINK.TAG.SER_AGG, spec.serAgg));
  if (spec.serEvFlushMs !== undefined) parts.push(tlvU16(DOWNLINK.TAG.SER_EV_FLUSH_MS, spec.serEvFlushMs));
  // EXP_CAP 钳位而非原样编码：值域 4..5904（sccb 集成 §9.1）。越界必被板端 BAD_VALUE 拒绝并连坐整条命令
  if (spec.expCap !== undefined) parts.push(tlvU16(DOWNLINK.TAG.EXP_CAP, clampExpCap(spec.expCap)));
  if (spec.serialBaud !== undefined) {
    const code = serialBaudCode(spec.serialBaud);
    if (code === null) {
      throw new Error(
        "串口波特率必须是 " + SERIAL_BAUD_RATES.join(" / ") + " 之一，收到 " + String(spec.serialBaud),
      );
    }
    parts.push(tlvU8(DOWNLINK.TAG.SER_BAUD, code));
  }
  return concatBytes(...parts);
}

/** SET_MODE 载荷（§6.3.2）：1 B 模式值 0/1/2 */
export function buildSetModePayload(mode: number): Uint8Array {
  if (mode < MODE3.RAW_EV || mode > MODE3.EV_ONLY || !Number.isInteger(mode)) {
    throw new Error("SET_MODE 载荷必须是 0/1/2，收到 " + String(mode));
  }
  return Uint8Array.of(mode);
}

/**
 * EV_EN 载荷（**v3.1 增补**，命令码 0x05 —— 对冻结设计 §6 的增补，登记见实现报告）：
 * 1 B，1 = 事件支路使能（默认）/ 0 = 禁用。禁用时事件数据停止上行、原画回传不受影响。
 * 幂等：等值写入零副作用；ACK 复用 §6.2 通用机制。
 */
export function buildEvEnPayload(enabled: boolean): Uint8Array {
  return Uint8Array.of(enabled ? 1 : 0);
}

/**
 * TIME_SYNC 载荷（§6.3.3，总 9 B）：HOST_TS_US[47:0] 6B BE + RTT_HALF_US 2B BE + FLAG 1B。
 * FLAG.bit0=1 表示"直接设为基准不要重算"；本实现恒 0（板端自算 RTT/2）。
 */
export function buildTimeSyncPayload(hostTsUs: number, rttHalfUs = 0, flagForce = false): Uint8Array {
  if (hostTsUs < 0 || hostTsUs >= 2 ** 48) throw new Error("HOST_TS_US 超出 48 bit 范围：" + String(hostTsUs));
  const out = new Uint8Array(9);
  const v = hostTsUs;
  out[0] = Math.floor(v / 2 ** 40) & 0xff;
  out[1] = Math.floor(v / 2 ** 32) & 0xff;
  const dv = new DataView(out.buffer);
  dv.setUint32(2, Math.floor(v / 2 ** 0) % 2 ** 32);
  dv.setUint16(6, rttHalfUs & 0xffff);
  out[8] = flagForce ? 1 : 0;
  return out;
}

// ————————————————————————— 时间换算与校准 offset（§4 / §5） —————————————————————————

/** µs → ms（§4.1：板上 1 MHz 计数与 PC 毫秒量纲只差 1000 倍，无其它换算） */
export function usToMs(us: number): number {
  return us / 1000;
}

/** 按板端 offset_reg 语义对齐：aligned = board_local + offset（48 bit 自然回绕，§5.1） */
export function applyTsOffsetUs(tsUs: number, offsetUs: number): number {
  const v = (tsUs + offsetUs) % 2 ** 48;
  return v < 0 ? v + 2 ** 48 : v;
}

export interface BoardTsOptions {
  /** PC 已知的 offset_reg（来自 TIME_SYNC ACK TLV 0x84）；null = 未知 */
  readonly offsetUs?: number | null;
  /** 包头 FLAGS.TS_CALIBRATED：板端已自行加过 offset，PC 不得重复加 */
  readonly calibrated: boolean;
}

/**
 * 板端 µs 时间戳 → PC 毫秒时间轴（WIRE-V3 §4.2/§5.1）。
 * 三条路径：① calibrated=1 → 板端已对齐，直接 /1000；② calibrated=0 且 PC 知 offset → PC 代加；
 * ③ offset 未知 → null（调用方回退到到达时刻）。TS 无效的情况由调用方先判（不进本函数）。
 */
export function boardTsToMs(tsUs: number, opts: BoardTsOptions): number | null {
  if (!Number.isFinite(tsUs) || tsUs < 0) return null;
  if (opts.calibrated) return usToMs(tsUs);
  if (opts.offsetUs === null || opts.offsetUs === undefined || !Number.isFinite(opts.offsetUs)) return null;
  return usToMs(applyTsOffsetUs(tsUs, opts.offsetUs));
}

// ————————————————————————— 上行 TLV 解释（§6.2 表） —————————————————————————

/** 串口事件支路状态（TLV 0x8E，len 3；板端实现报告 §3.3） */
export interface SerStateTlv {
  /** SER_DECIM 读回：1..255（每 N 条取第 N 条） */
  readonly decim: number;
  /** SER_AGG 读回：0=RAW / 1=GRID 8×6 每帧 / 2=GRID 16×12 每 4 帧 */
  readonly agg: number;
  /** uartEvDrop[7:0]：串口链路丢事件计数（8 bit 快变可能瞬时不一致，见板端报告 R3） */
  readonly uartEvDrop: number;
}

export interface StatusTlvs {
  readonly mode: number | null;
  readonly theta: number | null;
  readonly minDl: number | null;
  /** offset_reg（二补码） */
  readonly tsOffsetUs: number | null;
  readonly tsRttUs: number | null;
  /** bit0 calibrated / bit1 stale / bit2 epoch_reset（§6.2 tag 0x86） */
  readonly tsFlags: number | null;
  readonly frameIdx: number | null;
  readonly dropPx: number | null;
  readonly dropEv: number | null;
  readonly bootId: number | null;
  readonly fwVer: number | null;
  readonly wireVer: number | null;
  readonly unsupportedTags: readonly number[];
  /**
   * 事件支路使能读回（**v3.1 增补 TLV 0x8C**，len 1；与板端 2026-10-11 定案对齐）。
   * 出现在 EV_EN 的 ACK 与 GET_STATUS 的 TLV 列表尾部；值非 0 = 使能。
   * null = 本包未携带（心跳子集 / 旧固件）。
   */
  readonly evEn: boolean | null;
  /** 串口事件分辨率读回（**UART 扩展 TLV 0x8D**，len 1：0=全分辨率/1=÷2/2=÷4；null=未携带） */
  readonly evRes: number | null;
  /** 串口事件支路状态（**UART 扩展 TLV 0x8E**，len 3；len<3 判为携带不全 → null） */
  readonly serState: SerStateTlv | null;
  /** 网口可用性状态（**UART 扩展 TLV 0x8F**，len 1：0=DOWN/1=UP/2=UNKNOWN；null=未携带） */
  readonly netState: number | null;
  /**
   * 曝光上限读回（**sccb 集成增补 TLV 0x90**，len 2 BE，单位 = 行；2026-10-13 对齐）。
   * 出现在 SET_PARAM ACK（写后读回）与 GET_STATUS（板端 o_exp_cap 真值）；
   * 心跳/状态插发不含 ⇒ 心跳子集或旧固件（无 0x90）时保持现值，显示为 null（未上报）。
   */
  readonly expCap: number | null;
  /**
   * 板端当前生效串口波特率（**串口提速增补 TLV 0x91**，len 1，值 = 档位码）。
   * null = 本包未携带（旧位流 / 心跳子集）—— 绝不能拿下发值顶替。
   */
  readonly serialBaud: number | null;
}

function u16Of(v: Uint8Array | undefined): number | null {
  return v !== undefined && v.length >= 2 ? new DataView(v.buffer, v.byteOffset, v.byteLength).getUint16(0) : null;
}
function u32Of(v: Uint8Array | undefined): number | null {
  return v !== undefined && v.length >= 4 ? new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0) : null;
}

function u16At(v: Uint8Array, off: number): number | null {
  return v.length >= off + 2 ? new DataView(v.buffer, v.byteOffset, v.byteLength).getUint16(off) : null;
}

/**
 * 把 ACK / 心跳 TLV 列表解释成结构化状态（§6.2 tag 表）。
 *
 * ⚠️ TLV 0x88 / 0x8A 是**双语义**（2026-10-12 拆读，统一把关报告 §2.3 P-2 / §7 P-2 方向一）：
 *   · 0x88 板端已烧录形态 = **单条 len 4**（PX[15:0] + EV[15:0]，先 PX 后 EV）→ 一条拆出两个值；
 *     旧兼容形态 = 同 tag 出现两次、各 len 2（第一条 PX、第二条 EV）→ 保留原解释；
 *   · 0x8A 板端已烧录形态 = **单条 len 3**（FW_VER[15:0] + WIRE_VER，先 FW 后 WIRE）；
 *     旧兼容形态 = 两条（len2 的 FW_VER + len1 的 WIRE_VER）→ 保留原解释。
 *   单条形态优先判（len 判据足够大才算单条），两种形态都不会把 dropEv / wireVer 丢成 null。
 */
export function interpretStatusTlvs(tlv: readonly CtrlTlv[]): StatusTlvs {
  let mode: number | null = null;
  let theta: number | null = null;
  let minDl: number | null = null;
  let tsOffsetUs: number | null = null;
  let tsRttUs: number | null = null;
  let tsFlags: number | null = null;
  let frameIdx: number | null = null;
  let dropPx: number | null = null;
  let dropEv: number | null = null;
  let bootId: number | null = null;
  let fwVer: number | null = null;
  let wireVer: number | null = null;
  let evEn: boolean | null = null;
  let evRes: number | null = null;
  let serState: SerStateTlv | null = null;
  let netState: number | null = null;
  let expCap: number | null = null;
  let serialBaud: number | null = null;
  const unsupportedTags: number[] = [];
  for (const t of tlv) {
    const b0 = t.value[0];
    switch (t.tag) {
      case CTRL.TLV.MODE: mode = b0 ?? null; break;
      case CTRL.TLV.THETA: theta = u16Of(t.value); break;
      case CTRL.TLV.MIN_DL: minDl = u16Of(t.value); break;
      case CTRL.TLV.TS_OFFSET: tsOffsetUs = t.value.length === 6 ? readI48(t.value, 0) : null; break;
      case CTRL.TLV.TS_RTT_US: tsRttUs = u16Of(t.value); break;
      case CTRL.TLV.TS_FLAGS: tsFlags = b0 ?? null; break;
      case CTRL.TLV.FRAME_IDX: frameIdx = u16Of(t.value); break;
      case CTRL.TLV.DROP:
        if (t.value.length >= 4) {
          // 板端已烧录形态：单条 len 4 = PX[15:0] + EV[15:0]
          dropPx = u16At(t.value, 0);
          dropEv = u16At(t.value, 2);
        } else if (dropPx === null) {
          dropPx = u16Of(t.value); // 旧兼容形态第 1 条
        } else if (dropEv === null) {
          dropEv = u16Of(t.value); // 旧兼容形态第 2 条
        }
        break;
      case CTRL.TLV.BOOT_ID: bootId = u32Of(t.value); break;
      case CTRL.TLV.VERSION:
        if (t.value.length >= 3) {
          // 板端已烧录形态：单条 len 3 = FW_VER[15:0] + WIRE_VER
          fwVer = u16At(t.value, 0);
          wireVer = t.value[t.value.length - 1] ?? null;
        } else if (fwVer === null) {
          fwVer = u16Of(t.value); // 旧兼容形态第 1 条（len 2）
        } else if (wireVer === null) {
          wireVer = b0 ?? null;   // 旧兼容形态第 2 条（len 1）
        }
        break;
      case CTRL.TLV.EV_EN: evEn = b0 === undefined ? null : b0 !== 0; break;
      case CTRL.TLV.EV_RES_STATE: evRes = b0 ?? null; break;
      case CTRL.TLV.SER_STATE:
        serState = t.value.length >= 3
          ? { decim: t.value[0] as number, agg: t.value[1] as number, uartEvDrop: t.value[2] as number }
          : null;
        break;
      case CTRL.TLV.NET_STATE: netState = b0 ?? null; break;
      // sccb 集成增补（2026-10-13）：len 2 BE（行）；携带不全（len<2）→ null，不半解释出错误值
      case CTRL.TLV.EXP_CAP_STATE: expCap = u16Of(t.value); break;
      // 串口提速增补（2026-10-17）：**严格 len==1** 档位码；长度不符/未知码 → null
      // （旧位流不认此 tag；P2-2 明确不许把多余字节截断成“看起来合法”的档位）。
      case CTRL.TLV.SER_BAUD_STATE:
        serialBaud = t.value.length === 1 ? serialBaudOfCode(b0 ?? -1) : null;
        break;
      case CTRL.TLV.UNSUPPORTED_TAGS:
        for (const b of t.value) unsupportedTags.push(b);
        break;
      default: break; // 未知 tag：前向兼容，忽略（新 tag 之外的未知 tag 仍走此分支，容忍策略不回归）
    }
  }
  return {
    mode, theta, minDl, tsOffsetUs, tsRttUs, tsFlags, frameIdx,
    dropPx, dropEv, bootId, fwVer, wireVer, unsupportedTags,
    evEn, evRes, serState, netState, expCap, serialBaud,
  };
}
