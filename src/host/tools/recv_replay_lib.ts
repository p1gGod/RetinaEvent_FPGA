// recv_replay_lib —— recv_buffer_replay 工具与它的回归测试共用的**纯函数**：
// ① 把独立抓包器落盘的 .bin 按 v3 头自描述长度重新切包；② 用真实参数造"按真实线速"的回放流。
//
// 为什么单独一个模块：证据脚本本身也要有回归保护 —— 抓包格式/线格式一变，
// 脚本可能"静默算错"然后给出看起来合理的帧率数字（比崩掉更危险）。
import path from "node:path";

export const APP = path.resolve(import.meta.dirname, "..");
/** 默认抓包：P0 上板验收的独立抓包器落盘件（16 MB 缓冲、极简处理，线级真值） */
export const CAPTURE_DEFAULT = path.resolve(
  APP,
  "..",
  "..",
  "docs",
  "05_实验与实测",
  "P0上板验收_20261012",
  "raw",
  "sniff_r1.bin",
);
/** 与 RTL udp_merge.v / profile retina-v2-800x480-1280 一致：每块 1280 B */
export const RAW_CHUNK = 1280;
/** 768000 / 1280 = 600 块/帧 */
export const CHUNKS_PER_FRAME = 600;
/** 板端线级帧率（P0 报告 §5.3：独立抓包 29.6~29.7 fps 整帧；§5.2 frameIdx 1780~1799/60 s） */
export const LINE_FPS = 29.7;

export interface CapturedPacket {
  readonly bytes: Uint8Array;
  readonly rawLen: number;
  readonly evLen: number;
  readonly hdrLen: number;
  readonly flags: number;
  readonly frameIdx: number;
  readonly chunkIdx: number;
  readonly tsUs: number;
  /** null = 该包没有 CRC（本工程恒有）；false = 独立复算不匹配 */
  readonly crcOk: boolean | null;
  readonly raw: Uint8Array | null;
  readonly ev: Uint8Array | null;
}

/** CRC-16/CCITT-FALSE（独立实现，不与被测代码共用） */
export function crc16ccitt(buf: Uint8Array): number {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * 切包：v3 上行帧的总长由头部自描述（HDR_LEN + RAW_LEN + EV_LEN + CRC2），
 * 所以一个 .bin 里连着拍的包可以逐包切回来（抓包器只 dump 了字节，没有长度前缀）。
 * 遇到不认识的头就停（宁可少切，也不猜长度）。
 */
export function splitCapture(buf: Uint8Array): CapturedPacket[] {
  const out: CapturedPacket[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 24 <= buf.length) {
    if (buf[off] !== 0xf0 || buf[off + 1] !== 0x5a || buf[off + 2] !== 0xa5 || buf[off + 3] !== 0x30) break;
    const hdrLen = buf[off + 5] as number;
    const flags = buf[off + 6] as number;
    const isCtrl = (flags & 0x80) !== 0;
    const crcPresent = (flags & 0x04) !== 0;
    const rawLen = dv.getUint16(off + 12);
    const evLen = dv.getUint16(off + 14);
    const body = isCtrl ? hdrLen + 6 + dv.getUint16(off + hdrLen + 4) : hdrLen + rawLen + evLen;
    const total = body + (crcPresent ? 2 : 0);
    if (total < 24 || off + total > buf.length) break;
    const pkt = buf.subarray(off, off + total);
    const raw = rawLen === RAW_CHUNK ? buf.subarray(off + hdrLen, off + hdrLen + rawLen) : null;
    out.push({
      bytes: pkt,
      rawLen,
      evLen,
      hdrLen,
      flags,
      frameIdx: dv.getUint16(off + 10),
      chunkIdx: dv.getUint16(off + 8),
      tsUs: pkt.length >= 22 ? readTsUs(pkt, 16) : 0,
      crcOk: crcPresent ? crc16ccitt(pkt.subarray(0, body)) === dv.getUint16(off + body) : null,
      raw,
      ev: evLen > 0 ? buf.subarray(off + hdrLen + rawLen, off + hdrLen + rawLen + evLen) : null,
    });
    off += total;
  }
  return out;
}

function readTsUs(buf: Uint8Array, off: number): number {
  return (
    (buf[off] as number) * 2 ** 40 +
    (buf[off + 1] as number) * 2 ** 32 +
    (buf[off + 2] as number) * 2 ** 24 +
    (buf[off + 3] as number) * 2 ** 16 +
    (buf[off + 4] as number) * 2 ** 8 +
    (buf[off + 5] as number)
  );
}

export interface ReplayStream {
  readonly pkts: readonly Uint8Array[];
  readonly meta: {
    readonly rawPool: number;
    readonly evRatio: number;
    readonly avgLen: number;
    readonly tsStepUs: number;
    readonly totalFrames: number;
    readonly packets: number;
  };
}

/**
 * 造回放流：**帧/chunk 结构、包长、事件段混合比、TS 步进**都取自实测捕获；
 * 负载字节直接复用捕获里的真实 1280 B 载荷（不新造像素）。
 * 时间维度按真实线速铺（29.7 fps × 600 块 = 17.8k pps），由调用方按此节拍发送。
 */
export function buildReplay(
  packets: readonly CapturedPacket[],
  seconds: number,
  chunks: number = CHUNKS_PER_FRAME,
  fps: number = LINE_FPS,
): ReplayStream {
  const raws = packets.filter((p) => p.raw !== null).map((p) => p.raw as Uint8Array);
  const evs = packets.filter((p) => p.ev !== null).map((p) => p.ev as Uint8Array);
  const rawPool = raws.length > 0 ? raws : [new Uint8Array(RAW_CHUNK).fill(0x5a)];
  const evRatio = packets.length > 0 ? evs.length / packets.length : 0;
  const avgLen = packets.length > 0 ? packets.reduce((a, p) => a + p.bytes.length, 0) / packets.length : 0;
  const ts = packets.map((p) => p.tsUs).filter((v) => v > 0).sort((a, b) => a - b);
  const tsStepUs =
    ts.length > 1 ? Math.round(((ts[ts.length - 1] as number) - (ts[0] as number)) / (ts.length - 1)) : 56;

  const totalFrames = Math.max(1, Math.round(fps * seconds));
  const pkts: Uint8Array[] = [];
  const evEvery = evRatio > 0 ? Math.max(1, Math.round(1 / evRatio)) : 0;
  let tsUs = 5_000_000;
  for (let f = 0; f < totalFrames; f++) {
    const frameIdx = f & 0xffff;
    for (let c = 0; c < chunks; c++) {
      const ev = evEvery > 0 && c % evEvery === 0 ? (evs[(f + c) % Math.max(1, evs.length)] ?? null) : null;
      const evLen = ev === null ? 0 : ev.length;
      const pkt = new Uint8Array(24 + RAW_CHUNK + evLen + 2);
      const dv = new DataView(pkt.buffer);
      pkt[0] = 0xf0;
      pkt[1] = 0x5a;
      pkt[2] = 0xa5;
      pkt[3] = 0x30;
      pkt[4] = 0x03;
      pkt[5] = 24;
      pkt[6] = 0x1d | (ev === null ? 0 : 0x02); // RAW|CRC|TSV|TSC（+EV）
      pkt[7] = 0; // MODE0
      dv.setUint16(8, c);
      dv.setUint16(10, frameIdx);
      dv.setUint16(12, RAW_CHUNK);
      dv.setUint16(14, evLen);
      pkt[16] = Math.floor(tsUs / 2 ** 40) & 0xff;
      pkt[17] = Math.floor(tsUs / 2 ** 32) & 0xff;
      dv.setUint32(18, tsUs % 2 ** 32);
      pkt[22] = 5;
      pkt[23] = 0;
      (rawPool[(f * chunks + c) % rawPool.length] as Uint8Array).forEach((b, i) => {
        pkt[24 + i] = b;
      });
      if (ev !== null) pkt.set(ev, 24 + RAW_CHUNK);
      dv.setUint16(24 + RAW_CHUNK + evLen, crc16ccitt(pkt.subarray(0, 24 + RAW_CHUNK + evLen)));
      pkts.push(pkt);
      tsUs += tsStepUs;
    }
  }
  return { pkts, meta: { rawPool: rawPool.length, evRatio, avgLen, tsStepUs, totalFrames, packets: pkts.length } };
}

/** 内核接收缓冲能"吸收"的突发时长（ms）：缓冲区 ÷ 线速（回放取证里的深度口径） */
export function bufferDepthMs(recvBufferBytes: number, bytesPerSecond: number): number {
  if (bytesPerSecond <= 0) return 0;
  return Math.round((recvBufferBytes / bytesPerSecond) * 1000);
}
