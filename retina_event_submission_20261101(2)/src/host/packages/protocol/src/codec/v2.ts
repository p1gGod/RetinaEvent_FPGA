// UDP v2（udp_merge）单包解析 —— 见 02 文档 §2.1/§2.2 与 README §3 判据 P1~P4。
import { MAGIC, MAX_PAYLOAD, OFF, SEG } from "../constants.ts";
import type { CountersKey, ParsedV2, ParseResult, Profile } from "../types.ts";
import { crc16 } from "./crc.ts";

export interface ParseV2Options {
  readonly profile: Profile;
  /** true 时要求 CRC16 必须存在（缺了算 badLength） */
  readonly strictCrc?: boolean;
}

function fail(reason: CountersKey, detail: string): ParseResult<ParsedV2> {
  return { ok: false, reason, detail };
}

export function parseV2Packet(buf: Uint8Array, opts: ParseV2Options): ParseResult<ParsedV2> {
  const p = opts.profile;
  const warnings: string[] = [];

  if (buf.length < OFF.HEADER) return fail("truncated", "len=" + buf.length + " < 13");
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) return fail("badMagic", "前 4 字节不是 F0 5A A5 0F");
  }
  if (buf.length > MAX_PAYLOAD) return fail("oversize", "len=" + buf.length + " > " + MAX_PAYLOAD);

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frameIdx = dv.getUint16(OFF.FRAME_IDX);
  const segMask = dv.getUint8(OFF.SEG_MASK);
  const chunkIdx = dv.getUint16(OFF.CHUNK_IDX);
  const rawLen = dv.getUint16(OFF.RAW_LEN);
  const evLen = dv.getUint16(OFF.EV_LEN);

  const body = OFF.HEADER + rawLen + evLen;
  const noCrc = buf.length === body;
  const withCrc = buf.length === body + 2;
  if (!noCrc && !withCrc) {
    return fail("badLength", "len=" + buf.length + " 既不等于 " + body + "（无 CRC）也不等于 " + (body + 2) + "（有 CRC）");
  }
  if (p.crc16 === "none" && withCrc) return fail("badLength", "profile 声明无 CRC16，却多出 2 字节");
  if (opts.strictCrc === true && p.crc16 === "present" && !withCrc) return fail("badLength", "profile 要求 CRC16，但包长不含 CRC");

  // 判据 P3/P4：段存在性以 SEG_MASK 为准；保留位只告警不报错
  const hasRaw = (segMask & SEG.RAW) !== 0;
  const hasEvents = (segMask & SEG.EVENTS) !== 0;
  if (hasRaw !== rawLen > 0) warnings.push("segInconsistent");
  if (hasEvents !== evLen > 0) warnings.push("segInconsistent");
  if ((segMask & SEG.RESERVED_MASK) !== 0) warnings.push("segNotice");

  // 带 CRC 时先验后取数据（失败则整包丢弃）
  let crc16Present = false;
  if (withCrc) {
    const want = dv.getUint16(body);
    const got = crc16(buf.subarray(0, body));
    if (want !== got) return fail("crcFail", "CRC16 期望 0x" + want.toString(16) + " 实得 0x" + got.toString(16));
    crc16Present = true;
  }

  // 偏移始终按声明的长度算（保证即使 SEG_MASK 与长度矛盾也不会错位）
  const rawStart = OFF.HEADER;
  const evStart = OFF.HEADER + rawLen;
  const raw = hasRaw && rawLen > 0 ? buf.subarray(rawStart, rawStart + rawLen) : null;
  const events = hasEvents && evLen > 0 ? buf.subarray(evStart, evStart + evLen) : null;

  return {
    ok: true,
    value: { kind: "v2", frameIdx, segMask, hasRaw, hasEvents, chunkIdx, rawLen, evLen, raw, events, crc16Present, warnings },
  };
}
