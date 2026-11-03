// ACK 高负载回环取证工具的夹具回归（2026-10-13）。
// 保护对象：tools/ack_loopback_lib.ts —— 板端桩造的 CTRL ACK 必须能被**生产解析器**解析、
// 并能在 V3Link 的 SEQ 匹配路径上真正结束一个 pending 命令；否则工具会报"ACK 全超时"，
// 把结论错误地指向网关（这类"证据工具自己错"比崩掉更危险）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProfile, parseV3Packet } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { V3Link } from "../../gateway/src/pipeline/v3link.ts";
import { buildCtrlAck, readTs48, writeTs48 } from "../ack_loopback_lib.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

test("板端桩 ACK 夹具：生产解析器可解析（特指 CTRL）、opcode/seq 原样、CRC 自洽", () => {
  const pkt = buildCtrlAck(0x04, 0x1234);
  const r = parseV3Packet(pkt, { profile });
  assert.equal(r.ok, true, "夹具包必须能被生产解析器收下（否则工具证据全部作废）");
  if (!r.ok) return;
  assert.equal(r.value.ctrl, true);
  assert.equal(r.value.ctrlHeader?.opcode, 0x04);
  assert.equal(r.value.ctrlHeader?.seq, 0x1234);
  assert.equal(r.value.ctrlHeader?.status, 0);
  assert.equal(r.value.ctrlHeader?.ctrlLen, 0);
  // 破坏一字节 ⇒ 必须被 CRC 拦下（夹具确实有 CRC，而不是"碰巧能过"）
  const bad = pkt.slice();
  bad[25] = 1;
  assert.equal(parseV3Packet(bad, { profile }).ok, false);
});

test("板端桩 ACK 夹具：能在 V3Link 上按 SEQ 回声结束一条 pending 命令（工具的核心前提）", async () => {
  const sent: Uint8Array[] = [];
  let us = 1_000_000;
  const link = new V3Link({ send: (b) => sent.push(b), nowUs: () => us, nowMs: () => us / 1000 });
  link.seenV3 = true;
  const pending = link.getStatus();                     // GET_STATUS（opcode 0x04）
  assert.equal(sent.length, 1);
  const cmd = sent[0] as Uint8Array;
  const seq = ((cmd[6] as number) << 8) | (cmd[7] as number);
  const ackPkt = buildCtrlAck(0x04, seq);
  const parsed = parseV3Packet(ackPkt, { profile });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  us += 3000;
  link.onCtrlPacket(parsed.value);
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.seq, seq);
  assert.equal(r.detail, "OK");
});

test("回放段循环的 48bit 时间戳读写：往返一致 + 平移后仍单调（段续播不制造 epochReset）", () => {
  const p = new Uint8Array(24);
  const t1 = 5_000_000;
  writeTs48(p, t1);
  assert.equal(readTs48(p), t1);
  writeTs48(p, t1 + 3_998_400);                          // 一个 4 s 段的平移量
  assert.equal(readTs48(p), t1 + 3_998_400);
  // 边界：48bit 上限附近（2^48-1 仍在 Number 安全范围内）
  const big = 2 ** 48 - 1;
  writeTs48(p, big);
  assert.equal(readTs48(p), big);
  writeTs48(p, 0);
  assert.equal(readTs48(p), 0);
});
