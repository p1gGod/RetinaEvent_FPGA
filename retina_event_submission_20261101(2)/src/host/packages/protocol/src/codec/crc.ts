// CRC：与 RTL 侧必须逐位一致（不一致会表现为"看起来收到了但全丢"）。
import { CRC8, CRC16 } from "../constants.ts";

/** CRC8：多项式 0x07、初值 0x00（uart_telemetry 用，只覆盖 16B 载荷） */
export function crc8(data: Uint8Array, init: number = CRC8.INIT): number {
  let crc = init & 0xff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] as number;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ CRC8.POLY) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * CRC-16 查表（256 项，poly 0x1021，MSB-first；init 缺省 0xFFFF = CRC-16/CCITT-FALSE，与 RTL 一致）。
 *
 * 为什么要查表（2026-10-13，ACK 高负载残留根因）：逐位实现的实测成本是
 * **31.2 µs / 1304 B 包**（本机 Node 24，见 raw/bench_crc.txt）—— 22 MB/s 线速 ≈ 17.8k pps 时
 * 单 CRC 就吃掉 0.56 个核，网关事件循环被收包路径压满 ⇒ 内核接收队列堆积并长期保持满
 * （16 MB ≈ 700 ms）⇒ 板端 ACK 与数据流同 socket（板端上行恒为 1234）时排在队尾或被丢，
 * 1000 ms ACK 预算被耗尽。
 * 查表版与逐位版**逐位等价**（测试与 RTL 向量逐条对拍），成本降到 ~1/10（3.2 µs/包 = 0.06 核）。
 */
const CRC16_TABLE: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 8) & 0xffff;
    for (let b = 0; b < 8; b++) {
      c = (c & 0x8000) !== 0 ? ((c << 1) ^ CRC16.POLY) & 0xffff : (c << 1) & 0xffff;
    }
    t[i] = c;
  }
  return t;
})();

/** CRC-16（poly 0x1021、init 缺省 0xFFFF、不反转、不异或输出）——查表实现（热路径） */
export function crc16(data: Uint8Array, init: number = CRC16.INIT): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ (CRC16_TABLE[((crc >> 8) ^ (data[i] as number)) & 0xff] as number)) & 0xffff;
  }
  return crc;
}

/** 逐位参考实现（只在测试里用于"查表 == 逐位"的等价性对拍） */
export function crc16Bitwise(data: Uint8Array, init: number = CRC16.INIT): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] as number) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ CRC16.POLY) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
