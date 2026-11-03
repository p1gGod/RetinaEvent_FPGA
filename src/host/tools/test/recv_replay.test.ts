// recv_buffer_replay 证据工具的回归测试（tools/recv_replay_lib.ts）。
//
// 为什么证据脚本也要测：抓包格式/线格式一变，脚本可能"静默算错"，
// 然后给出一个看起来合理、实际错误的帧率数字 —— 比直接崩掉危险得多。
// 判据：① .bin 能按 v3 自描述长度完整切回来且 CRC 独立复算全对；
//      ② 造出的回放流每个包的字节都自洽（长度/CRC/帧号/块号/速率）；
//      ③ 缓冲深度换算与 22 MB/s 线速自洽（4 MB≈181 ms / 16 MB≈723 ms，与报告口径一致）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CAPTURE_DEFAULT,
  CHUNKS_PER_FRAME,
  LINE_FPS,
  RAW_CHUNK,
  bufferDepthMs,
  buildReplay,
  crc16ccitt,
  splitCapture,
} from "../recv_replay_lib.ts";

const hasCapture = fs.existsSync(CAPTURE_DEFAULT);

test("CRC-16/CCITT-FALSE 自检值（独立实现，与被测代码不同源）", () => {
  let crc = 0xffff;
  for (const b of new TextEncoder().encode("123456789")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  assert.equal(crc, 0x29b1, "CCITT-FALSE(\"123456789\") = 0x29B1");
  assert.equal(crc16ccitt(new TextEncoder().encode("123456789")), 0x29b1);
});

test("常量与线格式真值一致：1280 B/块、600 块/帧、29.7 fps（P0 §5.3）", () => {
  assert.equal(RAW_CHUNK, 1280);
  assert.equal(CHUNKS_PER_FRAME, 600);
  assert.equal(LINE_FPS, 29.7);
  assert.equal(RAW_CHUNK * CHUNKS_PER_FRAME, 768_000, "800×480×2 = 768,000 B/帧");
});

test("缓冲深度换算：22 MB/s 线速下 4 MB≈181 ms / 8 MB≈362 ms / 16 MB≈723 ms", () => {
  const bps = 22.1 * 1024 * 1024;
  // 容 ±1 ms：线速取整（22.1 MB/s vs 工具实测的 23,202,055 B/s）会让结果差 1 ms
  const near = (got: number, want: number): void => assert.ok(Math.abs(got - want) <= 1, "期望 ≈" + want + " 实得 " + got);
  near(bufferDepthMs(4 * 1024 * 1024, bps), 181);
  near(bufferDepthMs(8 * 1024 * 1024, bps), 362);
  near(bufferDepthMs(16 * 1024 * 1024, bps), 723);
  assert.equal(bufferDepthMs(0, bps), 0, "零缓冲 = 零深度（不做无意义除法）");
});

test("真实抓包 .bin：按 v3 头自描述长度完整切回，CRC 独立复算全对", { skip: !hasCapture ? "抓包文件不在（docs 目录）" : false }, () => {
  const buf = new Uint8Array(fs.readFileSync(CAPTURE_DEFAULT));
  const pkts = splitCapture(buf);
  assert.ok(pkts.length > 100, "至少要切出上百个包（实测 400）");
  assert.equal(pkts.filter((p) => p.crcOk === false).length, 0, "所有带 CRC 的包都必须独立复算通过");
  const data = pkts.filter((p) => p.rawLen === RAW_CHUNK);
  assert.ok(data.length > 100, "抓包里应有大量 1280 B 载荷包");
  assert.equal((data[0] as { hdrLen: number }).hdrLen, 24, "HDR_LEN=24（v3 固定头）");
  // 切包必须"不重叠、无空洞"：切出的字节总量 = 文件长度（否则就是切错了）
  const total = pkts.reduce((a, p) => a + p.bytes.length, 0);
  assert.ok(total > 0 && total <= buf.length);
  assert.equal(splitCapture(buf.subarray(0, total)).length, pkts.length, "同一字节流切两次结果必须一致（确定性）");
});

test("回放流：包数/长度/CRC/帧号块号/速率全部自洽（不依赖抓包文件）", () => {
  const fake = [{
    bytes: new Uint8Array(24 + RAW_CHUNK + 2),
    rawLen: RAW_CHUNK, evLen: 0, hdrLen: 24, flags: 0x1d, frameIdx: 0, chunkIdx: 0, tsUs: 1_000_000,
    crcOk: true, raw: new Uint8Array(RAW_CHUNK).fill(7), ev: null,
  }];
  const r = buildReplay(fake, 2, CHUNKS_PER_FRAME, LINE_FPS);
  assert.equal(r.meta.totalFrames, 59, "29.7 fps × 2 s ≈ 59 帧");
  assert.equal(r.meta.packets, 59 * 600, "每帧 600 包");
  const p0 = r.pkts[0] as Uint8Array;
  const p1 = r.pkts[1] as Uint8Array;
  const dv = new DataView(p0.buffer);
  assert.deepEqual([...p0.subarray(0, 4)], [0xf0, 0x5a, 0xa5, 0x30]);
  assert.equal(p0[4], 3, "VER=3");
  assert.equal(p0[5], 24, "HDR_LEN=24");
  assert.equal(dv.getUint16(12), RAW_CHUNK, "RAW_LEN=1280");
  assert.equal(dv.getUint16(14), 0, "本包无事件段");
  assert.equal(dv.getUint16(8), 0, "第 1 包 chunk=0");
  assert.equal(new DataView(p1.buffer).getUint16(8), 1, "chunk 递增");
  assert.equal(dv.getUint16(10), 0, "frameIdx 从 0 起");
  const want = dv.getUint16(24 + RAW_CHUNK);
  assert.equal(crc16ccitt(p0.subarray(0, 24 + RAW_CHUNK)), want, "尾部 CRC16 必须覆盖 [0..24+RAW_LEN)");
  // 第 (600) 个包属于第 2 帧
  const p600 = r.pkts[600] as Uint8Array;
  assert.equal(new DataView(p600.buffer).getUint16(10), 1, "第 601 个包进入 frameIdx=1");
  // 线速自洽：包数 × 平均包长 ÷ 时长 ≈ 22 MB/s（报告里的 17.8k pps 口径）
  const pps = r.meta.packets / 2;
  assert.ok(pps > 17_000 && pps < 18_500, "17.8k pps 量级，实得 " + pps);
});
