// RTL 真实字节 → 上位机协议解析（契约回归）
//
// 为什么需要这一组：`testdata/golden/` 的 7 组向量是**上位机自己生成的**（gen-golden.ts），
// 它们只能证明"解析器与自己的生成器一致"——两边一起错（例如 CRC 初值都写成 XMODEM）时全绿。
// 本文件用的是 **RTL testbench 实际发出的字节**，是唯一不经过上位机生成器的素材。
//
// 素材来源：`retina_event/sim/tb/tb_udp_merge.v` 把每个包 dump 成 `rtl_packets.hex`，
//          再转成 RTPKT 容器（配方见 host/testdata/rtl/README.md）。
//
// 历史价值（2026-10-06 由它抓到两个真缺陷）：
//   1) 上位机 CRC16 用了 XMODEM（init 0x0000），RTL 用 CCITT-FALSE（init 0xFFFF）
//      ⇒ 605/605 个包被判 crcFail，画面恒黑；
//   2) 上位机默认 profile 是 1024/750，RTL 是 1280/600
//      ⇒ 帧永远凑不齐，且按 1024 步长拼 1280 字节负载整帧错位。
// 这两条若没有本向量，只有等接上真板子才会暴露。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCounters, getProfile, iterRtpkt, parseV2Packet } from "@retina/protocol";
import type { FramePacket } from "@retina/protocol";
import { FrameAssembler } from "../src/pipeline/assembler.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** host/app/gateway/test → host/testdata/rtl（向上 3 级才到 host） */
const RTL_DIR = resolve(HERE, "..", "..", "..", "testdata", "rtl");
const VECTOR = resolve(RTL_DIR, "rtl_udp_merge.rtpkt");

/** 与 RTL `udp_merge.v` 默认参数一致的那个 profile */
const PROFILE_NAME = "retina-v2-800x480-1280";

/** tb 的像素激励：第 i 个像素 = i[15:0]，高字节先出 */
const PIXELS_PER_FRAME = 384000;
/** tb 每 100 像素喂 1 条事件，ev_seq 从 0 每条 +1 */
const EVENTS_PER_FRAME_EXPECT = 3840;

async function loadPayloads(): Promise<Uint8Array[]> {
  return [...iterRtpkt(new Uint8Array(await readFile(VECTOR)))];
}

function assemble(payloads: readonly Uint8Array[], profileName: string): { frames: FramePacket[]; ok: number; fails: Map<string, number> } {
  const profile = getProfile(profileName);
  assert.ok(profile, "profile 必须存在: " + profileName);
  const frames: FramePacket[] = [];
  const counters = createCounters();
  const asm = new FrameAssembler({ profile, counters, onFrame: (f) => frames.push(f), onEvents: () => {} });
  const fails = new Map<string, number>();
  let ok = 0;
  let t = 0;
  for (const p of payloads) {
    const r = parseV2Packet(p, { profile, strictCrc: true });
    t++;
    if (!r.ok) {
      fails.set(r.reason, (fails.get(r.reason) ?? 0) + 1);
      continue;
    }
    ok++;
    asm.push(r.value, t);
  }
  asm.tick(t + 2000);
  return { frames, ok, fails };
}

test("RTL 向量：605 个包全部通过 CRC16（RTL 用 CCITT-FALSE，init 0xFFFF）", async () => {
  const payloads = await loadPayloads();
  assert.equal(payloads.length, 605, "tb_udp_merge dump 的包数");
  const { ok, fails } = assemble(payloads, PROFILE_NAME);
  assert.deepEqual([...fails.entries()], [], "不应有任何被拒包");
  assert.equal(ok, 605);
});

test("RTL 向量：按 1280/600 拼出 1 整帧 768000 B，且像素逐字节等于 RTL 激励", async () => {
  const { frames } = assemble(await loadPayloads(), PROFILE_NAME);
  assert.equal(frames.length, 1, "应交付 1 帧（帧 0）");
  const raw = frames[0]!.raw;
  assert.equal(raw.length, 768000);
  assert.equal(raw.length / 2, PIXELS_PER_FRAME);
  let bad = 0;
  for (let i = 0; i < PIXELS_PER_FRAME; i++) {
    const want = i & 0xffff;
    if (raw[2 * i] !== ((want >> 8) & 0xff) || raw[2 * i + 1] !== (want & 0xff)) bad++;
  }
  assert.equal(bad, 0, "与 RTL 激励不符的像素数必须为 0");
});

test("RTL 向量：事件 x/y/pol 解码逐条等于 RTL 激励（x=seq[8:0] / y=seq[7:0] / pol=seq[0]）", async () => {
  const { frames } = assemble(await loadPayloads(), PROFILE_NAME);
  const evs = frames[0]!.events.records;
  // 差 2 条属既定语义：事件页在"包开始"锁存，包发送期间新到的事件进下一包
  assert.ok(evs.length === EVENTS_PER_FRAME_EXPECT || evs.length === EVENTS_PER_FRAME_EXPECT - 2,
    "事件条数应在 " + EVENTS_PER_FRAME_EXPECT + " 附近，实得 " + evs.length);
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k]!;
    assert.equal(e.x, k & 0x1ff, "第 " + k + " 条事件 x");
    assert.equal(e.y, k & 0xff, "第 " + k + " 条事件 y");
    assert.equal(e.pol, k & 1, "第 " + k + " 条事件 pol");
  }
});

test("RTL 向量：用 1024/750 的 profile 解析同一批包 ⇒ 拼不出帧（这就是接不上板子的直接原因）", async () => {
  const { frames, ok } = assemble(await loadPayloads(), "retina-v2-800x480-e5");
  assert.equal(ok, 605, "包本身能被解析（长度自洽），但分片参数不匹配");
  assert.equal(frames.length, 0, "等 750 块只来 600 块 ⇒ 永远凑不齐；本断言锁住「默认 profile 必须与 RTL 一致」");
});
