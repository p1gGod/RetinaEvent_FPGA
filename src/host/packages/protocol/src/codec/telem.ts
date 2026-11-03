// UART：遥测包（16B 载荷，小端）与帧回传（5B 头，大端）—— 02 文档 §5
import { TELEM } from "../constants.ts";
import { crc8 } from "./crc.ts";
import type { ParseResult, Telemetry } from "../types.ts";

/** 遥测载荷解析。注意：整数是**小端**（fpga_link.py 实际实现如此，别"统一"掉） */
export function parseTelemetry(payload16: Uint8Array): ParseResult<Telemetry> {
  if (payload16.length !== TELEM.PAYLOAD) {
    return { ok: false, reason: "truncated", detail: "遥测载荷长度应为 16，实到 " + payload16.length };
  }
  const dv = new DataView(payload16.buffer, payload16.byteOffset, payload16.byteLength);
  return {
    ok: true,
    value: {
      maxLineW: dv.getUint16(0, true),
      maxLineH: dv.getUint16(2, true),
      lineW: dv.getUint16(4, true),
      frameCnt: dv.getUint16(6, true),
      pclkPeriod: dv.getUint32(8, true),
      pclkTotal: dv.getUint32(12, true),
    },
  };
}

/** CRC8 校验（poly 0x07 / init 0x00）。传入待校验区间；UART 遥测帧必须传**前 20 B（魔数+载荷）** */
export function telemCrcOk(data: Uint8Array, crcByte: number): boolean {
  return crc8(data) === (crcByte & 0xff);
}

export interface TeleFrameHeader { readonly w: number; readonly h: number; readonly mode: number }

/** 帧回传头（W/H 是**大端**，与遥测载荷的小端相反 —— 既有实现的事实） */
export function parseTeleFrame(header5: Uint8Array): TeleFrameHeader | null {
  if (header5.length < 5) return null;
  const dv = new DataView(header5.buffer, header5.byteOffset, header5.byteLength);
  const w = dv.getUint16(0);
  const h = dv.getUint16(2);
  const mode = dv.getUint8(4);
  if (w === 0 || h === 0 || w > 4096 || h > 4096) return null;   // 与 fpga_link.py 同一防御
  return { w, h, mode };
}

// ————————————————————————— 串口（UART 路线）遥测帧 —————————————————————————
//
// 依据 WIRE-U1 §3.1 帧型 A 与板端 RTL `retina_event/src/hdl/comms/uart_link.v` 的
// `pay_byte()`（唯一逐字节真值）：
//
//   AA 55 54 4D | 16 B 载荷（**大端**）| CRC8(poly 0x07, init 0x00，覆盖**前 20 B**：魔数+载荷)   —— 21 B 定长
//
// 2026-10-17 修正（以 RTL 为唯一真值）：retina_event/src/hdl/comms/uart_link.v:637
//   if (bin_idx < 8'd20) bin_crc <= crc8_step(bin_crc, bin_byte_w);
// 即 CRC 从 bin_idx=0（魔数第一个字节）累计到 19（载荷最后一字节），**包含魔数**。
// 老模块 uart_telemetry.v:595 同样是 bin_idx<20。此前上位机只算 16 B 载荷 ⇒ 真帧 10/10 判 CRC 失败。
//
// 载荷（与 v1 `parseTelemetry` 的 16 B 小端布局**不同**：这是串口路线的人读/统计通道，
// 语义 = 帧计数 / 每帧事件数 / 活跃度 / 降低倍数 / 模式 / 按键 / EV_EN / 协议版本）：
//
//   偏移 宽 名称          说明
//   0   4  frameCnt      板端相机帧计数（u32 BE）
//   4   3  evPerFrame    本帧事件数（u24 BE）
//   7   2  activityQ16   活跃度 ρ × 65536（u16 BE）
//   9   3  crX10         降低倍数 ×10（u24 BE，饱和；0xFFFFFF = 无事件饱和值）
//   12  1  mode          板端当前模式 0/1/2
//   13  1  key           按键位图（低 4 bit）
//   14  1  evEn          事件支路使能（1=开 / 0=关）
//   15  1  protoVer      遥测帧协议版本（当前 0x01）

/** 串口遥测帧（帧型 A）解析结果 */
export interface UartTelemFrame {
  readonly frameCnt: number;
  readonly evPerFrame: number;
  readonly activityQ16: number;
  readonly crX10: number;
  readonly mode: number;
  readonly key: number;
  readonly evEn: number;
  readonly protoVer: number;
  /** 活跃度（0..1，= activityQ16 / 65536） */
  readonly activity: number;
  /** 降低倍数（= crX10 / 10，便于直接上屏） */
  readonly cr: number;
  /** 该帧是否已是**饱和**降低倍数（0xFFFFFF ⇒ 本帧无事件） */
  readonly crSaturated: boolean;
}

/** 21 B 串口遥测帧解析（含 CRC8 校验）。长度不对 / 魔数不对 / CRC 不匹配一律失败，不半解释 */
export function parseUartTelemFrame(frame21: Uint8Array): ParseResult<UartTelemFrame> {
  if (frame21.length !== TELEM.TOTAL) {
    return { ok: false, reason: "truncated", detail: "串口遥测帧应为 " + TELEM.TOTAL + " B，实到 " + frame21.length };
  }
  for (let i = 0; i < TELEM.MAGIC.length; i++) {
    if (frame21[i] !== TELEM.MAGIC[i]) {
      return { ok: false, reason: "badMagic", detail: "串口遥测魔数应为 AA 55 54 4D" };
    }
  }
  const payload = frame21.subarray(TELEM.HDR, TELEM.HDR + TELEM.PAYLOAD);
  const crcCovered = frame21.subarray(0, TELEM.HDR + TELEM.PAYLOAD); // RTL bin_idx 0..19：魔数 + 载荷
  const crcByte = frame21[TELEM.HDR + TELEM.PAYLOAD] as number;
  if (!telemCrcOk(crcCovered, crcByte)) {
    return { ok: false, reason: "crcFail", detail: "遥测 CRC8 不匹配（覆盖前 20 B，期望 " + crc8(crcCovered) + " 实得 " + crcByte + "）" };
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const crX10 = dv.getUint8(9) * 65536 + dv.getUint8(10) * 256 + dv.getUint8(11);
  const activityQ16 = dv.getUint16(7);
  return {
    ok: true,
    value: {
      frameCnt: dv.getUint32(0),
      evPerFrame: dv.getUint8(4) * 65536 + dv.getUint8(5) * 256 + dv.getUint8(6),
      activityQ16,
      crX10,
      mode: dv.getUint8(12),
      key: dv.getUint8(13) & 0x0f,
      evEn: dv.getUint8(14),
      protoVer: dv.getUint8(15),
      activity: activityQ16 / 65536,
      cr: crX10 / 10,
      crSaturated: crX10 === 0xffffff,
    },
  };
}

/** 组装一个 21 B 串口遥测帧（测试/工具用；与 RTL `uart_link.v` 的字节序逐字节一致） */
export function buildUartTelemFrame(v: {
  frameCnt: number;
  evPerFrame: number;
  activityQ16: number;
  crX10: number;
  mode?: number;
  key?: number;
  evEn?: number;
  protoVer?: number;
}): Uint8Array {
  const out = new Uint8Array(TELEM.TOTAL);
  out.set(TELEM.MAGIC, 0);
  const payload = out.subarray(TELEM.HDR, TELEM.HDR + TELEM.PAYLOAD);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  dv.setUint32(0, v.frameCnt >>> 0);
  dv.setUint8(4, (v.evPerFrame >>> 16) & 0xff);
  dv.setUint8(5, (v.evPerFrame >>> 8) & 0xff);
  dv.setUint8(6, v.evPerFrame & 0xff);
  dv.setUint16(7, v.activityQ16 & 0xffff);
  dv.setUint8(9, (v.crX10 >>> 16) & 0xff);
  dv.setUint8(10, (v.crX10 >>> 8) & 0xff);
  dv.setUint8(11, v.crX10 & 0xff);
  dv.setUint8(12, (v.mode ?? 0) & 0x03);
  dv.setUint8(13, (v.key ?? 0) & 0x0f);
  dv.setUint8(14, (v.evEn ?? 1) & 0x01);
  dv.setUint8(15, (v.protoVer ?? 0x01) & 0xff);
  out[TELEM.HDR + TELEM.PAYLOAD] = crc8(out.subarray(0, TELEM.HDR + TELEM.PAYLOAD)); // 前 20 B（含魔数）
  return out;
}
