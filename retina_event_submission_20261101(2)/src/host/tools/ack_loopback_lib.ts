// ack_loopback_lib —— ack_highload_replay 取证工具用的纯函数（独立拼字节，不依赖被测解析器）。
//
// 为什么独立成库并配单测：证据工具自己必须"不会静默算错" —— 如果板端桩造的 ACK 布局错了，
// 工具会报"ACK 全超时"，然后把"网关收包路径有缺陷"这个结论安到无辜的代码上（比崩掉更危险）。
// 所以这里的手拼字节要有解析侧（packages/protocol）与 V3Link 匹配路径的机器判据。
import { crc16ccitt } from "./recv_replay_lib.ts";

/** 上行 v3 CTRL 包布局（WIRE-V3 §6.2）：24B 帧头 + 6B 控制头 + TLV + CRC16(2B) */
export const CTRL_HDR = 24;
export const CTRL_HDR_LEN = 6;

/**
 * 造一条上行 CTRL ACK（板端桩的应答）：
 *   · FLAGS = CTRL(0x80) | CRC_PRESENT(0x04) → 0x85（与现场 CTRL 包同形）；
 *   · 头内 RAW_LEN/EV_LEN = 0、EV_REC_BYTES = 5（与 profile 一致）；
 *   · 控制头 = opcode + STATUS=OK + SEQ 回声 + CTRL_LEN；CRC 覆盖 [0, bodyEnd)。
 * CRC 用 recv_replay_lib 的独立逐位实现（不与被测代码共用）。
 */
export function buildCtrlAck(opcode: number, seq: number, tlv: Uint8Array = new Uint8Array(0)): Uint8Array {
  const pkt = new Uint8Array(CTRL_HDR + CTRL_HDR_LEN + tlv.length + 2);
  const dv = new DataView(pkt.buffer);
  pkt.set(Uint8Array.of(0xf0, 0x5a, 0xa5, 0x30), 0);
  pkt[4] = 0x03;                 // VER
  pkt[5] = CTRL_HDR;             // HDR_LEN
  pkt[6] = 0b10000101;           // CTRL | CRC_PRESENT
  pkt[7] = 0;                    // MODE
  dv.setUint16(8, 0);            // CHUNK_IDX
  dv.setUint16(10, 0);           // FRAME_IDX
  dv.setUint16(12, 0);           // RAW_LEN
  dv.setUint16(14, 0);           // EV_LEN
  pkt[22] = 5;                   // EV_REC_BYTES
  pkt[24] = opcode & 0xff;
  pkt[25] = 0;                   // STATUS = OK(0)
  dv.setUint16(26, seq & 0xffff);
  dv.setUint16(28, tlv.length);
  pkt.set(tlv, CTRL_HDR + CTRL_HDR_LEN);
  const bodyEnd = CTRL_HDR + CTRL_HDR_LEN + tlv.length;
  dv.setUint16(bodyEnd, crc16ccitt(pkt.subarray(0, bodyEnd)));
  return pkt;
}

/** 读 48bit 大端 µs（线上 TS 布局偏移 16..21，WIRE-V3 §2.1） */
export function readTs48(p: Uint8Array): number {
  return (
    (p[16] as number) * 2 ** 40 + (p[17] as number) * 2 ** 32 + (p[18] as number) * 2 ** 24 +
    (p[19] as number) * 2 ** 16 + (p[20] as number) * 2 ** 8 + (p[21] as number)
  );
}

/** 写 48bit 大端 µs（同上；回放段循环续播时把时间轴整体平移） */
export function writeTs48(p: Uint8Array, ts: number): void {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  p[16] = Math.floor(ts / 2 ** 40) & 0xff;
  p[17] = Math.floor(ts / 2 ** 32) & 0xff;
  dv.setUint32(18, ts % 2 ** 32);
}
