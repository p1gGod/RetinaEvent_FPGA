// 测试用的包构造器：按 02 文档 §2.1 手工拼字节（与实现解耦，避免"用实现验证实现"）
export interface V2Spec {
  frameIdx?: number; chunkIdx?: number;
  raw?: Uint8Array | null; events?: Uint8Array | null;
  segMask?: number; rawLenOverride?: number; evLenOverride?: number;
  withCrc?: boolean; breakCrc?: boolean; segMaskReserved?: boolean;
  totalPad?: number;                       // 追加垃圾字节使长度不自洽
}
export function buildV2(s: V2Spec): Uint8Array {
  const raw = s.raw ?? null;
  const ev = s.events ?? null;
  const rawLen = s.rawLenOverride ?? (raw ? raw.length : 0);
  const evLen = s.evLenOverride ?? (ev ? ev.length : 0);
  let segMask = s.segMask ?? ((raw ? 0b01 : 0) | (ev ? 0b10 : 0));
  if (s.segMaskReserved) segMask |= 0b10000000;
  const len = 13 + rawLen + evLen + (s.withCrc ? 2 : 0) + (s.totalPad ?? 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  out[0] = 0xf0; out[1] = 0x5a; out[2] = 0xa5; out[3] = 0x0f;
  dv.setUint16(4, s.frameIdx ?? 1);
  dv.setUint8(6, segMask);
  dv.setUint16(7, s.chunkIdx ?? 0);
  dv.setUint16(9, rawLen);
  dv.setUint16(11, evLen);
  if (raw) out.set(raw, 13);
  if (ev) out.set(ev, 13 + rawLen);
  if (s.withCrc) {
    // 独立 CRC-16/CCITT-FALSE（逐位，init 0xFFFF）—— 与 RTL udp_merge.v 一致
    let crc = 0xffff;
    for (let i = 0; i < 13 + rawLen + evLen; i++) {
      crc ^= (out[i] as number) << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    if (s.breakCrc) crc ^= 0xffff;
    dv.setUint16(13 + rawLen + evLen, crc);
  }
  return out;
}
/** byte-aligned 事件记录：[X_LO][bit0=X8][Y][bit0=POL][TS8] */
export function evByteAligned(x: number, y: number, pol: 0 | 1, ts: number, recBytes = 5, dirtyReserved = false): Uint8Array {
  const b = new Uint8Array(recBytes);
  b[0] = x & 0xff;
  b[1] = ((x >> 8) & 0x01) | (dirtyReserved ? 0xfe : 0);
  if (recBytes > 2) b[2] = y & 0xff;
  if (recBytes > 3) b[3] = (pol & 0x01) | (dirtyReserved ? 0xfe : 0);
  if (recBytes > 4) b[4] = ts & 0xff;
  return b;
}
export function seq(n: number): Uint8Array { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = i & 0xff; return a; }

// ————————————————————————— v3（WIRE-V3 设计 §2.1 / §6.2） —————————————————————————
// 与 buildV2 同哲学：独立于被测实现手工拼字节，避免"用实现验证实现"。

export interface V3Spec {
  frameIdx?: number; chunkIdx?: number;
  raw?: Uint8Array | null; events?: Uint8Array | null;
  ver?: number;
  /** 头长（默认 24；>24 时模拟前向兼容的附加头，raw 起点跟着移动） */
  hdrLen?: number;
  /** 显式 FLAGS（给了就不按下面各 bit 推断 —— 用于构造"FLAGS 与长度矛盾"的坏包） */
  flags?: number;
  mode?: number;
  /** null = TS_VALID=0（时间不可信）；缺省 = 填 0 但 TS 有效 */
  tsUs?: number | null;
  tsCalibrated?: boolean;
  first?: boolean; last?: boolean;
  /** true = CTRL 包（§6.2）：RAW_LEN=EV_LEN=0，载荷为 6 B 控制头 + TLV/REQ */
  ctrl?: boolean;
  evRecBytes?: number | null;
  rsvd?: number;
  withCrc?: boolean; breakCrc?: boolean;
  totalPad?: number;
  rawLenOverride?: number; evLenOverride?: number;
  // —— CTRL 包（§6.2）——
  ctrlOpcode?: number; ctrlStatus?: number; ctrlSeq?: number;
  /** TLV 字节（tag+len+value 列表原样拼）；与 ctrlPayload 二选一 */
  ctrlTlv?: Uint8Array;
  /** 裸控制载荷（如 TIME_SYNC_REQ 的 6 B BOARD_TS_US）；给了就忽略 ctrlTlv */
  ctrlPayload?: Uint8Array;
  /** 显式 CTRL_LEN（默认按载荷长度） */
  ctrlLen?: number;
}
export function buildV3(s: V3Spec): Uint8Array {
  const raw = s.raw ?? null;
  const ev = s.events ?? null;
  const hdrLen = s.hdrLen ?? 24;
  const isCtrl = s.ctrl === true;
  const rawLen = isCtrl ? 0 : (s.rawLenOverride ?? (raw ? raw.length : 0));
  const evLen = isCtrl ? 0 : (s.evLenOverride ?? (ev ? ev.length : 0));
  const tsUs = s.tsUs === undefined ? 0 : s.tsUs;
  const tsValid = s.tsUs === undefined ? true : s.tsUs !== null;
  const withCrc = s.withCrc ?? true;
  const flags = s.flags ?? (
    (isCtrl ? 0b10000101 : 0) |                     // CTRL：bit7 + bit2（CRC_PRESENT，§6.2 头定义）
    (raw ? 0b01 : 0) | (ev ? 0b10 : 0) |
    (withCrc ? 0b100 : 0) |
    (tsValid ? 0b1000 : 0) |
    (tsValid && s.tsCalibrated ? 0b10000 : 0) |
    (s.first ? 0b100000 : 0) | (s.last ? 0b1000000 : 0)
  );
  const ctrlPayload = s.ctrlPayload ?? s.ctrlTlv ?? new Uint8Array(0);
  const ctrlLen = s.ctrlLen ?? ctrlPayload.length;
  const len = hdrLen + (isCtrl ? 6 + ctrlLen : rawLen + evLen) + (withCrc ? 2 : 0) + (s.totalPad ?? 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  out[0] = 0xf0; out[1] = 0x5a; out[2] = 0xa5; out[3] = 0x30;
  out[4] = s.ver ?? 0x03;
  out[5] = hdrLen;
  out[6] = flags;
  out[7] = (s.mode ?? (isCtrl ? 0 : (raw ? 0 : 2))) & 0xff;
  dv.setUint16(8, s.chunkIdx ?? 0);
  dv.setUint16(10, s.frameIdx ?? 1);
  dv.setUint16(12, rawLen);
  dv.setUint16(14, evLen);
  // 48 bit 大端 TS（§2.1 偏移 16..21）
  const ts = tsUs === null ? 0 : tsUs;
  out[16] = Math.floor(ts / 2 ** 40) & 0xff;
  out[17] = Math.floor(ts / 2 ** 32) & 0xff;
  dv.setUint32(18, ts % 2 ** 32);
  out[22] = s.evRecBytes === undefined ? 5 : (s.evRecBytes === null ? 0 : s.evRecBytes);
  out[23] = s.rsvd ?? 0;
  const bodyEnd = hdrLen + (isCtrl ? 6 + ctrlLen : rawLen + evLen);
  if (isCtrl) {
    out[hdrLen] = (s.ctrlOpcode ?? 0xf0) & 0xff;
    out[hdrLen + 1] = (s.ctrlStatus ?? 0) & 0xff;
    dv.setUint16(hdrLen + 2, (s.ctrlSeq ?? 0) & 0xffff);
    dv.setUint16(hdrLen + 4, ctrlLen & 0xffff);
    out.set(ctrlPayload, hdrLen + 6);
  } else {
    if (raw) out.set(raw, hdrLen);
    if (ev) out.set(ev, hdrLen + rawLen);
  }
  if (withCrc) {
    let crc = 0xffff;
    for (let i = 0; i < bodyEnd; i++) {
      crc ^= (out[i] as number) << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    if (s.breakCrc) crc ^= 0xffff;
    dv.setUint16(bodyEnd, crc);
  }
  return out;
}

/** 上行 TLV 拼装（§6.2：tag(1)+len(1)+value） */
export function v3Tlv(tag: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + value.length);
  out[0] = tag & 0xff;
  out[1] = value.length & 0xff;
  out.set(value, 2);
  return out;
}
export function concatU8(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
