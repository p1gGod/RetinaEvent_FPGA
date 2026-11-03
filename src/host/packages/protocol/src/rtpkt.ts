// RTPKT：回放容器格式（纯内存实现，浏览器安全 —— 不 import node:fs）。
// 用途：把"一串 UDP 负载"存成可回放文件；回放与实时走同一条解析路径（原则 P4）。
//
// 文件布局：
//   偏移 0   8 B   "RTPKT1\0\0"
//   之后重复： u32 BE payloadLen | payload（即原始 UDP 负载字节）
//
// 谁用：
//   tools/gen-golden.ts  → encodeRtpkt 写出 golden 向量
//   gateway/transport/replay.ts → iterRtpkt 逐包喂给 codec
//   tools/replay-verify.ts → iterRtpkt 独立复核（不同实现路径，避免自证）

export const RTPKT_MAGIC = new Uint8Array([0x52, 0x54, 0x50, 0x4b, 0x54, 0x31, 0x00, 0x00]);

export function encodeRtpkt(payloads: readonly Uint8Array[]): Uint8Array {
  let total = RTPKT_MAGIC.length;
  for (const p of payloads) total += 4 + p.length;
  const out = new Uint8Array(total);
  out.set(RTPKT_MAGIC, 0);
  const dv = new DataView(out.buffer);
  let off = RTPKT_MAGIC.length;
  for (const p of payloads) {
    dv.setUint32(off, p.length);
    off += 4;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 惰性遍历容器里的负载；格式不对时抛 Error（调用方负责转成可见错误） */
export function* iterRtpkt(buf: Uint8Array): Generator<Uint8Array> {
  if (buf.length < RTPKT_MAGIC.length) throw new Error("RTPKT: 文件太短");
  for (let i = 0; i < RTPKT_MAGIC.length; i++) {
    if (buf[i] !== RTPKT_MAGIC[i]) throw new Error("RTPKT: 魔数不匹配（不是回放文件？）");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = RTPKT_MAGIC.length;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error("RTPKT: 尾部截断（长度字段不完整）");
    const len = dv.getUint32(off);
    off += 4;
    if (off + len > buf.length) throw new Error("RTPKT: 尾部截断（负载不完整）");
    yield buf.subarray(off, off + len);
    off += len;
  }
}

/** 仅取包数（供快速自检，不构造负载） */
export function countRtpkt(buf: Uint8Array): number {
  let n = 0;
  for (const _ of iterRtpkt(buf)) n++;
  return n;
}
