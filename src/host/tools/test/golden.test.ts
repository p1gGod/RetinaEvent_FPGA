// golden 向量测试（tools/test/golden.test.ts）
//
// 三层断言，缺一层就会漏掉一类错误：
//   1) 契约层：6 组向量齐备、packets 是容器实际包数、文件与生成器逐字节同步（防"手改向量"）；
//   2) 复核层：tools/replay-verify.ts 的朴素组帧 + protocol 双路对拍结果必须与 expected.json 一致；
//   3) 判据层：02 §10 的 V2~V5 逐条点名（首页 sha256、纯事件真值、缺块 aborted、回绕步长、坏 CRC）。
//
// 运行：cd host/app && npm test（或 node --experimental-strip-types tools/test/golden.test.ts）

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { crc16, encodeRtpkt, gapOf, getProfile, iterRtpkt } from "@retina/protocol";
import { GOLDEN_DIR, buildVectors, eventsJsonOf, expectedJsonOf } from "../gen-golden.ts";
import type { GoldenExpected } from "../gen-golden.ts";
import { replay, verifyAll, verifyVector } from "../replay-verify.ts";

/** 02 §10 / README §4 冻结的向量（g07 为 task-6 新增的重复块口径） */
const IDS = ["g01_min_frame", "g02_ev_only", "g03_drop_chunk", "g04_wrap", "g05_bad_crc", "g06_legacy", "g07_dup_chunk"] as const;

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

async function loadPayloads(id: string): Promise<Uint8Array[]> {
  return [...iterRtpkt(new Uint8Array(await readFile(resolve(GOLDEN_DIR, id + ".rtpkt"))))];
}

async function loadExpected(id: string): Promise<GoldenExpected> {
  return JSON.parse(await readFile(resolve(GOLDEN_DIR, id + ".expected.json"), "utf8")) as GoldenExpected;
}

function be16(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)) & 0xffff;
}

test("契约：向量齐备，且每组文件与生成器逐字节同步（防手改漂移）", async () => {
  const found = (await readdir(GOLDEN_DIR)).filter((n) => n.endsWith(".rtpkt")).map((n) => n.slice(0, -".rtpkt".length)).sort();
  assert.deepEqual(found, [...IDS].sort(), "testdata/golden 下的向量应与契约清单一致（多一个少一个都要在这里红）");

  for (const v of buildVectors()) {
    const onDisk = new Uint8Array(await readFile(resolve(GOLDEN_DIR, v.id + ".rtpkt")));
    assert.equal(sha256Hex(onDisk), sha256Hex(encodeRtpkt(v.payloads)), v.id + ".rtpkt 与生成器不一致：请重跑 npm run golden:gen");
    assert.equal(await readFile(resolve(GOLDEN_DIR, v.id + ".expected.json"), "utf8"), expectedJsonOf(v), v.id + ".expected.json 与生成器不一致");
    if (v.eventsTruth !== undefined) {
      assert.equal(await readFile(resolve(GOLDEN_DIR, v.id + ".events.json"), "utf8"), eventsJsonOf(v), v.id + ".events.json 与生成器不一致");
    }
  }
});

test("契约：packets 字段 == 容器里实际的包数（README §4.1 硬要求）", async () => {
  for (const id of IDS) {
    const exp = await loadExpected(id);
    const payloads = await loadPayloads(id);
    assert.equal(exp.packets, payloads.length, id + " 的 packets 与 iterRtpkt 数出来的不一致");
  }
});

test("复核：全部向量与 expected.json 一致（朴素组帧 + protocol 双路对拍）", async () => {
  const reports = await verifyAll(GOLDEN_DIR);
  assert.equal(reports.length, IDS.length, "应复核到契约清单里的每一组向量");
  assert.deepEqual(
    reports.filter((r) => !r.ok).map((r) => r.id + "：" + r.problems.join("；")),
    [],
    "复核失败（详见左列）",
  );
});

test("V2 g01：750 包拼成完整帧，逐字节 sha256 与源相同", async () => {
  const exp = await loadExpected("g01_min_frame");
  const payloads = await loadPayloads("g01_min_frame");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);
  assert.equal(payloads.length, 750);
  assert.equal(res.frames.length, 1);
  assert.equal(res.frames[0]?.frameIdx, 1);
  assert.equal(res.frames[0]?.raw.length, 768000);
  assert.equal(res.bytesRaw, 768000);
  assert.equal(res.counters.aborted, 0);
  assert.match(exp.rawSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(sha256Hex(res.frames[0]?.raw ?? new Uint8Array()), exp.rawSha256);
});

test("V3 g02：纯事件包（SEG_MASK=0b10）的坐标/极性与 events.json 真值一致，余数只计 evPartial", async () => {
  const truth = JSON.parse(await readFile(resolve(GOLDEN_DIR, "g02_ev_only.events.json"), "utf8")) as readonly { x: number; y: number; pol: number }[];
  const payloads = await loadPayloads("g02_ev_only");
  const exp = await loadExpected("g02_ev_only");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);

  assert.equal(truth.length, 20);
  assert.ok(truth.some((e) => e.x > 255), "真值必须含 x>255，否则 x[8] 分支没被走到");
  assert.deepEqual(res.allEvents.map((e) => [e.x, e.y, e.pol]), truth.map((e) => [e.x, e.y, e.pol]));
  assert.equal(res.eventCount, 20);
  assert.equal(res.counters.evPartial, 1, "第 2 包 EV_LEN%5=3 ⇒ 余数丢弃计 1");
  assert.equal(res.counters.aborted, 0, "纯事件包不参与原始帧生命周期");
  assert.equal(res.frames.length, 0, "纯事件流不产出原始帧");
  assert.equal(res.bytesRaw, 0);

  // 保留位必须真的非 0，否则这条向量没在检验 P6
  let reserved = 0;
  for (const pkt of payloads) {
    const ev = pkt.subarray(13 + be16(pkt, 9), 13 + be16(pkt, 9) + be16(pkt, 11));
    for (let k = 0; k + 5 <= ev.length; k += 5) {
      if (((ev[k + 1] ?? 0) & 0xfe) !== 0 || ((ev[k + 3] ?? 0) & 0xfe) !== 0) reserved++;
    }
  }
  assert.equal(reserved, truth.length, "每条记录的保留位都应为非 0（P6 才被真正检验）");
});

test("V3 g03：删掉第 500 包 ⇒ aborted=1、不交付帧、rawSha256=null", async () => {
  const exp = await loadExpected("g03_drop_chunk");
  const payloads = await loadPayloads("g03_drop_chunk");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);

  assert.equal(payloads.length, 749, "第 500 包（chunkIdx=499）应被删掉");
  assert.equal(res.frames.length, 0, "缺块帧绝不能交付（否则是错位图像）");
  assert.equal(res.counters.aborted, 1);
  assert.equal(res.bytesRaw, 766976, "已接受的 749 个段仍要计入 bytesRaw");
  assert.equal(exp.rawSha256, null);
  assert.equal(exp.expect.counters.aborted, 1);
  const report = await verifyVector(GOLDEN_DIR, "g03_drop_chunk");
  assert.deepEqual(report.problems, []);
});

test("V4 g04：FRAME_IDX 65535 → 0 的步长判为 1、无 idxGap；aborted 在两个时点各结算一次", async () => {
  const payloads = await loadPayloads("g04_wrap");
  const exp = await loadExpected("g04_wrap");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);

  assert.deepEqual(res.frameIdxSeq, [65535, 0]);
  assert.equal(gapOf(65535, 0), 1, "必须用模差，直接相减会得到 -65535");
  assert.equal(res.counters.idxGap, 0);
  assert.equal(exp.expect.counters.idxGap, 0);
  // ① 帧号切换时结算 65535 的帧 ② 流结束 flush 结算 0 的帧 ⇒ 2（少一路都是真 bug，lead 裁决钉死）
  assert.equal(res.counters.aborted, 2, "帧号切换 + 流结束 flush 两个时点各结算一次");
  assert.equal(exp.expect.counters.aborted, 2);
});

test("V5 g05：末包篡改 1 字节只被 CRC16 拒掉，其余包照收", async () => {
  const payloads = await loadPayloads("g05_bad_crc");
  const exp = await loadExpected("g05_bad_crc");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);

  // 逐包独立验 CRC：前 3 包必须对，末包必须错（这条不依赖工具的判读路径）
  payloads.forEach((pkt, i) => {
    const body = 13 + be16(pkt, 9) + be16(pkt, 11);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    const ok = dv.getUint16(body) === crc16(pkt.subarray(0, body));
    assert.equal(ok, i < 3, "第 " + i + " 个包的 CRC 校验结果不符：" + (i < 3 ? "应通过" : "应失败"));
  });
  assert.equal(res.counters.crcFail, 1);
  assert.equal(res.bytesRaw, 3072, "被 CRC 拒掉的包不计入 bytesRaw");
  assert.equal(exp.expect.counters.crcFail, 1);
  // 好坏包同属一帧、无帧号切换 ⇒ aborted 只在流结束 flush 结算一次
  assert.equal(res.counters.aborted, 1);
  assert.equal(exp.expect.counters.aborted, 1);
});

test("g07：重复块计 dupChunk，且其 RAW_LEN 仍计入 bytesRaw（不接受静默吞掉）", async () => {
  const payloads = await loadPayloads("g07_dup_chunk");
  const exp = await loadExpected("g07_dup_chunk");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  const res = replay(payloads, profile);

  assert.equal(payloads.length, 3, "容器里是 3 个包：chunkIdx 0 / 0（重复）/ 1");
  assert.equal(res.counters.dupChunk, 1);
  assert.equal(res.counters.aborted, 1, "帧不齐 ⇒ flush 结算一次");
  assert.equal(res.frames.length, 0);
  assert.equal(res.bytesRaw, 3 * 1024, "三个包都通过校验（含重复块）⇒ 3 段都要计入 bytesRaw");
  assert.equal(res.counters.badLength, 0);
  assert.equal(exp.rawSha256, null);

  // 重复块的数据必须取先到者：末包（chunkIdx=1）与第 1 包（chunkIdx=0）同载荷，
  // 但重复包本身不改变任何后续语义 —— 这里用"重复包与原包字节完全相同"来固定构造
  const first = payloads[0] ?? new Uint8Array();
  const dup = payloads[1] ?? new Uint8Array();
  assert.deepEqual([...dup], [...first], "重复块应为同载荷副本");
  const report = await verifyVector(GOLDEN_DIR, "g07_dup_chunk");
  assert.deepEqual(report.problems, []);
});

test("g06 legacy：600 包 × 1280 B 按 LEGACY profile 拼成完整帧", async () => {
  const payloads = await loadPayloads("g06_legacy");
  const exp = await loadExpected("g06_legacy");
  const profile = getProfile(exp.profile);
  assert.ok(profile !== null);
  assert.equal(profile.wire, "LEGACY");
  const res = replay(payloads, profile);

  assert.equal(payloads.length, 600);
  assert.equal(res.frames.length, 1);
  assert.equal(res.bytesRaw, 768000);
  assert.equal(res.counters.aborted, 0);
  assert.equal(sha256Hex(res.frames[0]?.raw ?? new Uint8Array()), exp.rawSha256);
});

test("CRC16 契约定为 CCITT-FALSE（与 RTL 一致）：crc16('123456789') === 0x29B1", () => {
  // 0x29B1 = CCITT-FALSE（init 0xFFFF），RTL udp_merge.v 的 crc16_step 初值即 16'hFFFF。
  // 曾经写成 XMODEM（init 0x0000 → 0x31C3），实测会让板子发来的 605/605 个包全部 crcFail。
  assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29b1);
});
