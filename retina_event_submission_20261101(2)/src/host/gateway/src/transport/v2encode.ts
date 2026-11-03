// v2 包的"写入侧"最小实现（合成源与测试自造向量用）。
// 为什么需要它：synth 源必须自己造出"线上字节"再喂给与实时完全相同的解析路径（原则 P4），
// 而不是绕过解析直接构造 FramePacket —— 否则合成演示验证不到协议层。
// 权威写入方永远是 RTL 的 udp_merge；这里只做同构复刻，字段偏移一律取自 protocol 常量。
import { CRC16, MAGIC, MAX_PAYLOAD, OFF, crc16 } from "@retina/protocol";

export interface V2PacketSpec {
  readonly frameIdx: number;
  readonly segMask: number;
  readonly chunkIdx: number;
  readonly raw?: Uint8Array | null;
  readonly events?: Uint8Array | null;
  /** 是否追加 CRC16 尾部（覆盖 [0, 13+RAW_LEN+EV_LEN)），默认不带 */
  readonly withCrc16?: boolean;
}

export function encodeV2Packet(spec: V2PacketSpec): Uint8Array {
  const raw = spec.raw ?? null;
  const events = spec.events ?? null;
  const rawLen = raw === null ? 0 : raw.length;
  const evLen = events === null ? 0 : events.length;
  if (rawLen > MAX_PAYLOAD || evLen > MAX_PAYLOAD) throw new Error("v2 段超过 MAX_PAYLOAD=" + MAX_PAYLOAD);
  const bodyLen = OFF.HEADER + rawLen + evLen;
  const out = new Uint8Array(bodyLen + (spec.withCrc16 === true ? 2 : 0));
  out.set(MAGIC, OFF.MAGIC);
  const dv = new DataView(out.buffer);
  dv.setUint16(OFF.FRAME_IDX, spec.frameIdx & 0xffff);
  dv.setUint8(OFF.SEG_MASK, spec.segMask & 0xff);
  dv.setUint16(OFF.CHUNK_IDX, spec.chunkIdx & 0xffff);
  dv.setUint16(OFF.RAW_LEN, rawLen);
  dv.setUint16(OFF.EV_LEN, evLen);
  if (raw !== null) out.set(raw, OFF.HEADER);
  if (events !== null) out.set(events, OFF.HEADER + rawLen);
  if (spec.withCrc16 === true) {
    dv.setUint16(bodyLen, crc16(out.subarray(0, bodyLen), CRC16.INIT));
  }
  return out;
}

/** 事件记录的线格式写入（与 02 §2.4 的 byte-aligned 布局一致） */
export function encodeEventRecord(x: number, y: number, pol: 0 | 1, flags = 0, ts = 0): Uint8Array {
  return new Uint8Array([x & 0xff, (x >> 8) & 0x01, y & 0xff, ((flags & 0x7f) << 1) | (pol & 0x01), ts & 0xff]);
}

export function encodeEventChunk(records: readonly { x: number; y: number; pol: 0 | 1; flags?: number; ts?: number }[]): Uint8Array {
  const out = new Uint8Array(records.length * 5);
  let off = 0;
  for (const r of records) {
    out.set(encodeEventRecord(r.x, r.y, r.pol, r.flags ?? 0, r.ts ?? 0), off);
    off += 5;
  }
  return out;
}
