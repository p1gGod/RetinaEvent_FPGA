// UDP v1（厂家例程 60）：首包 10B 头 + 1280B 数据；其余包各 1280B 纯数据。
// ⚠️ v1 与 v2 魔数相同（缺口 G6）⇒ 版本只能靠 profile 决定；这里只负责 v1 的包边界判定。
import { MAGIC, V1 } from "../constants.ts";
import type { ParsedV1, ParseResult, Profile } from "../types.ts";

export interface V1Ctx {
  readonly profile: Profile;
  /** 期望的下一个数据包序号（首包后为 1）；null 表示"还没见过首包" */
  readonly expectChunk: number | null;
}

export function parseV1Packet(buf: Uint8Array, ctx: V1Ctx): ParseResult<ParsedV1> {
  const pk = ctx.profile.rawChunk > 0 ? ctx.profile.rawChunk : V1.PKT_DATA;

  // 首包：10B 头 + 1280B 数据（长度 ≥ 1290 且魔数匹配；1280 的数据包不可能被误判）
  if (buf.length >= V1.FIRST_PKT) {
    let magicOk = true;
    for (let i = 0; i < MAGIC.length; i++) if (buf[i] !== MAGIC[i]) magicOk = false;
    if (!magicOk) return { ok: false, reason: "badMagic", detail: "首包魔数不匹配" };
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint16(4);            // 大端（实测事实：fpga_link.py 亦按大端解析）
    const h = dv.getUint16(6);
    const frameIdx = dv.getUint16(8);
    const dataLen = Math.min(pk, buf.length - V1.HEADER);
    return { ok: true, value: { kind: "v1", frameIdx, isFirst: true, w, h, data: buf.subarray(V1.HEADER, V1.HEADER + dataLen) } };
  }

  if (buf.length > pk) return { ok: false, reason: "oversize", detail: "v1 数据包 len=" + buf.length + " > " + pk };
  if (buf.length === 0) return { ok: false, reason: "truncated", detail: "空包" };
  if (ctx.expectChunk === null) return { ok: false, reason: "badLength", detail: "还没收到首包就来了数据包" };
  // 非首包不带帧号；帧号由首包决定（由装配器维护）
  return { ok: true, value: { kind: "v1", frameIdx: -1, isFirst: false, w: 0, h: 0, data: buf } };
}
