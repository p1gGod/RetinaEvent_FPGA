// V3Link 单元测试：判据③（校准 10 min 节流不重复发起）与判据④（命令编码 + SEQ/ACK 匹配）。
// 收发与时钟全部注入：send 捕获字节、nowUs 手动推进、定时器手动点火 —— 节流/超时行为确定性可测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOWNLINK, CTRL, createCounters, parseTlvs, parseV3Packet, readTsUs } from "@retina/protocol";
import type { ParsedV3, Profile } from "@retina/protocol";
import { getProfile } from "@retina/protocol";
import { V3Link } from "../src/pipeline/v3link.ts";
import { buildV3, concatU8, v3Tlv } from "../../packages/protocol/test/helpers.ts";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

interface Rig {
  link: V3Link;
  sent: Uint8Array[];
  nowUs: () => number;
  advanceUs: (us: number) => void;
  fireTimers: (n?: number) => void;
  pendingTimers: () => number;
}

function newRig(
  opts: { calPeriodUs?: number; ackTimeoutMs?: number; counters?: ReturnType<typeof createCounters> } = {},
): Rig {
  let us = 1_000_000;                                    // 任意非 0 起点
  const sent: Uint8Array[] = [];
  const timers: { fn: () => void }[] = [];
  const link = new V3Link({
    send: (b) => sent.push(b),
    nowUs: () => us,
    nowMs: () => us / 1000,
    ...(opts.calPeriodUs === undefined ? {} : { calPeriodUs: opts.calPeriodUs }),
    ...(opts.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: opts.ackTimeoutMs }),
    ...(opts.counters === undefined ? {} : { counters: opts.counters }),
    setTimer: (fn) => {
      timers.push({ fn });
      return timers.length - 1;
    },
    clearTimer: (t) => {
      timers[Number(t)] = { fn: () => {} };
    },
  });
  return {
    link,
    sent,
    nowUs: () => us,
    advanceUs: (delta) => { us += delta; },
    fireTimers: (n = Number.POSITIVE_INFINITY) => {
      // 已被 ACK resolve 的定时器在 clearTimer 里被替换成 noop，全量点火是安全的
      for (let i = 0; i < n; i++) {
        const t = timers.shift();
        if (!t) break;
        t.fn();
      }
    },
    pendingTimers: () => timers.length,
  };
}

/** 造一条上行 CTRL 包（REQ 或 ACK）——与生产路径一致：先按 v3 解析再喂 V3Link */
function ctrlPkt(spec: Parameters<typeof buildV3>[0]): ParsedV3 {
  const buf = buildV3({ ctrl: true, ...spec });
  const r = parseV3Packet(buf, { profile });
  if (!r.ok) throw new Error("ctrlPkt 构造失败: " + r.reason + " " + (r.detail ?? ""));
  return r.value;
}

/** 从已发送的下行字节里解出 SEQ（§6.1 偏移 6..7 BE） */
function seqOf(bytes: Uint8Array): number {
  return (bytes[6] as number) << 8 | (bytes[7] as number);
}
function opcodeOf(bytes: Uint8Array): number {
  return bytes[5] as number;
}

// ————————————————————————— 判据③：10 min 校准节流 —————————————————————————

test("判据③ maybeCalibrate 每 600 s 至多发起一次：1 s 节拍连调 700 次只发 2 帧", () => {
  const rig = newRig();
  rig.link.seenV3 = true;                                // 见过 v3 流量才允许发（直接置位，不引入 dataMode 干扰模式断言）
  let fires = 0;
  for (let i = 0; i < 700; i++) {
    if (rig.link.maybeCalibrate()) fires++;
    rig.advanceUs(1_000_000);                            // 每秒 tick 一次
  }
  assert.equal(fires, 2);                                // t=0s 与 t=600s 两次
  assert.equal(rig.sent.length, 2);
  assert.equal(opcodeOf(rig.sent[0] as Uint8Array), DOWNLINK.OPCODE.TIME_SYNC);
  // HOST_TS_US = PC 单调时基 µs（§6.3.3），载荷前 6 B 大端
  assert.equal(readTsUs((rig.sent[0] as Uint8Array).subarray(10), 0), 1_000_000);
});

test("判据③ 未见过 v3 流量（v2 固件）时不发起：不发命令、不计失败", () => {
  const rig = newRig();
  assert.equal(rig.link.maybeCalibrate(), false);
  assert.equal(rig.sent.length, 0);
  assert.equal(rig.link.statusView().calFailures, 0);
});

test("判据③ 板端 REQ 应答同样刷新节流戳：应答后 10 min 内 PC 不再主动发起", () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  // 板端 TIME_SYNC_REQ：6 B 裸载荷 BOARD_TS_US（§5.1 第 1 步）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.TIME_SYNC_REQ, ctrlSeq: 0x0042, ctrlPayload: Uint8Array.of(0, 0, 0, 0, 0x10, 0x00) }));
  assert.equal(rig.sent.length, 1);                      // 立即应答
  const resp = rig.sent[0] as Uint8Array;
  assert.equal(opcodeOf(resp), DOWNLINK.OPCODE.TIME_SYNC);
  assert.equal(seqOf(resp), 0x0042);                     // SEQ 回声请求 SEQ（§6.1）
  assert.equal(readTsUs(resp.subarray(10), 0), 1_000_000); // HOST_TS_US = t1
  // REQ 不触发 ACK 超时定时器（不是 PC 自己的命令）
  assert.equal(rig.pendingTimers(), 0);
  // 节流戳已被刷新：立刻 maybeCalibrate 不重复发起
  assert.equal(rig.link.maybeCalibrate(), false);
  rig.advanceUs(599_000_000);
  assert.equal(rig.link.maybeCalibrate(), false);        // 还差 1 s
  rig.advanceUs(1_100_000);
  assert.equal(rig.link.maybeCalibrate(), true);
});

test("F2 手动校准优先于自动节流：自动 tick 占坑后手动仍能发帧，且自动让位一次", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  // ① 网关启动 1 s 的自动 tick 先占坑（现场复现：calAgeMs=8~21 s 时手动被节流）
  assert.equal(rig.link.maybeCalibrate(), true);
  assert.equal(rig.sent.length, 1);
  rig.fireTimers();                                      // ACK 未回：点火让它落地（不污染后续计数）
  rig.advanceUs(20_000_000);                             // 20 s 后用户点「立即校准」
  const p = rig.link.calibrate();
  assert.equal(rig.sent.length, 2, "手动校准必须能命中（不再被 600 s 自动闸门拦下）");
  assert.equal(opcodeOf(rig.sent[1] as Uint8Array), DOWNLINK.OPCODE.TIME_SYNC);
  // ② 手动成功后再点一次（<2 s 连点/双击）：拒绝且不发帧 —— 同一动作只发一帧
  const r2 = await rig.link.calibrate();
  assert.equal(r2.ok, false);
  assert.equal(rig.sent.length, 2);
  assert.match(r2.detail, /刚校准过/);
  // ③ 自动 tick 让位一次：手动之后 599 s 内的 tick 一律不发
  rig.advanceUs(590_000_000);
  assert.equal(rig.link.maybeCalibrate(), false);
  assert.equal(rig.sent.length, 2);
  // ④ 手动校准满 600 s 后自动周期恢复
  rig.advanceUs(10_100_000);
  assert.equal(rig.link.maybeCalibrate(), true);
  assert.equal(rig.sent.length, 3);
  rig.fireTimers();
  const r = await p;
  assert.equal(r.opcode, DOWNLINK.OPCODE.TIME_SYNC);     // ② 的手动命令也已落地（超时结果不影响本判据）
});

test("F2 手动校准 2 s 防连点与自动节流互不串台：手动失败不占坑、自动 tick 照常到期", async () => {
  const rig = newRig({ calPeriodUs: 600_000_000 });
  rig.link.seenV3 = true;
  // 板端 REQ 应答刷新节流戳（t=1 s）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.TIME_SYNC_REQ, ctrlSeq: 1, ctrlPayload: Uint8Array.of(0, 0, 0, 0, 0x10, 0x00) }));
  assert.equal(rig.sent.length, 1);
  // 1 s 后手动：在 2 s 防连点窗内 ⇒ 拒绝，但**不得**占用自动闸门
  rig.advanceUs(1_000_000);
  const rManual = await rig.link.calibrate();
  assert.equal(rManual.ok, false);
  assert.equal(rig.sent.length, 1, "防连点拒绝时绝不能发帧");
  // 自动周期仍按 REQ 刷新后的 600 s 计：599 s 不发、601 s 发（证明手动失败没有把戳改坏）
  rig.advanceUs(598_000_000);
  assert.equal(rig.link.maybeCalibrate(), false);
  rig.advanceUs(2_100_000);
  assert.equal(rig.link.maybeCalibrate(), true);
  assert.equal(rig.sent.length, 2);
});

test("判据③ 未见过 v3 流量时手动校准同样拒绝：不发命令（v2 固件期不许污染 dlReject）", async () => {
  const rig = newRig();
  const r = await rig.link.calibrate();
  assert.equal(r.ok, false);
  assert.equal(rig.sent.length, 0);
  assert.equal(rig.link.statusView().calFailures, 0);
});

// ————————————————————————— 判据④：命令编码 + SEQ/ACK 匹配 —————————————————————————

test("判据④ SET_MODE 下发与 ACK 匹配：SEQ 回声命中 pending，TLV MODE 读回进状态", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const p = rig.link.setMode(1);
  assert.equal(rig.sent.length, 1);
  const cmd = rig.sent[0] as Uint8Array;
  assert.equal(opcodeOf(cmd), DOWNLINK.OPCODE.SET_MODE);
  assert.deepEqual(Array.from(cmd.subarray(10, 11)), [1]); // 载荷 = MODE 单字节（下一字节是 CRC）
  const seq = seqOf(cmd);
  // 板端 ACK：STATUS=OK + TLV MODE 读回值（§6.3.2）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.SET_MODE, ctrlStatus: 0, ctrlSeq: seq, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(1)) }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.seq, seq);
  assert.equal(r.status, 0);
  assert.equal(r.tlvs?.mode, 1);
  assert.equal(rig.link.statusView().mode, 1);
});

test("v3.1 增补 EV_EN：编码 0x05 + 载荷 0/1、ACK 匹配、状态显示随 ACK 切换", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  assert.equal(rig.link.statusView().evEn, null);        // 未下发过
  const p = rig.link.evEn(false);                        // 禁用事件支路
  const cmd = rig.sent[0] as Uint8Array;
  assert.equal(opcodeOf(cmd), DOWNLINK.OPCODE.EV_EN);    // 0x05（v3.1 增补码，联板核对点）
  assert.deepEqual(Array.from(cmd.subarray(10, 11)), [0]);
  const seq = seqOf(cmd);
  // 板端 ACK（STATUS=OK，无 TLV —— §6.2 通用机制允许 CTRL_LEN=0）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.EV_EN, ctrlStatus: 0, ctrlSeq: seq }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(rig.link.statusView().evEn, false);       // 状态显示切换
  // 再开：ACK OK → 状态回 true；ACK 失败 → 状态不变
  const p2 = rig.link.evEn(true);
  const seq2 = seqOf(rig.sent[1] as Uint8Array);
  assert.deepEqual(Array.from((rig.sent[1] as Uint8Array).subarray(10, 11)), [1]);
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.EV_EN, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq2 }));
  await p2;
  assert.equal(rig.link.statusView().evEn, true);
  const p3 = rig.link.evEn(false);
  const seq3 = seqOf(rig.sent[2] as Uint8Array);
  rig.fireTimers();                                      // 超时（无 ACK）
  const r3 = await p3;
  assert.equal(r3.ok, false);
  assert.equal(rig.link.statusView().evEn, true);        // 超时不改变已确认状态
});

// ———————— v3.1 对齐（2026-10-11 板端定案：EV_EN ACK 带 TLV 0x8C，GET_STATUS 尾部追加 0x8C） ————————

test("v3.1 对齐 ①：EV_EN ACK（STATUS=OK + TLV 0x8C len1，CTRL_LEN=3）解析成功，状态=板端读回值", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const p = rig.link.evEn(false);                        // 请求禁用
  const seq = seqOf(rig.sent[0] as Uint8Array);
  // 板端 ACK：STATUS=OK + 单条 TLV 0x8C（len 1，值=写后读回），CTRL_LEN=3
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.EV_EN, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq,
    ctrlTlv: v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),    // 读回=1（使能）
  }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.evEn, true);                      // ACK 携带读回值
  assert.equal(rig.link.statusView().evEn, true);        // 状态=读回值（不是请求的 false）
  // 反向：请求使能、读回禁用 → 同样以读回为准
  const p2 = rig.link.evEn(true);
  const seq2 = seqOf(rig.sent[1] as Uint8Array);
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.EV_EN, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq2,
    ctrlTlv: v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(0)),
  }));
  await p2;
  assert.equal(rig.link.statusView().evEn, false);
});

test("v3.1 对齐 ②：GET_STATUS 的 TLV 列表尾部带 0x8C ⇒ 链路状态以板端读回为准（覆盖心跳同路径）", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  // 先经 EV_EN ACK（带 0x8C）建立状态=禁用
  const p = rig.link.evEn(false);
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.EV_EN, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seqOf(rig.sent[0] as Uint8Array),
    ctrlTlv: v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(0)),
  }));
  await p;
  assert.equal(rig.link.statusView().evEn, false);
  // GET_STATUS：TLV 列表尾部追加 0x8C（板端 CTRL_LEN 49→50），读回=使能 → 状态翻转以读回为准
  const p2 = rig.link.getStatus();
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0b001)),
    v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),             // 列表尾部（板端定案的追加位置）
  );
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: DOWNLINK.STATUS.OK,
    ctrlSeq: seqOf(rig.sent[1] as Uint8Array), ctrlTlv: tlv,
  }));
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(r2.tlvs?.evEn, true);
  assert.equal(rig.link.statusView().evEn, true);        // GET_STATUS 读回覆盖旧状态
  // 心跳子集带 0x8C 同样刷新（同一条 absorbTlvs 路径）；不带时保持现值不回退
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 7,
    ctrlTlv: v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(0)),
  }));
  assert.equal(rig.link.statusView().evEn, false);
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 8, ctrlTlv: new Uint8Array(0) }));
  assert.equal(rig.link.statusView().evEn, false);       // 心跳未携带 → 保持板端真值
});

test("v3.1 对齐 ③：未知 TLV tag 容忍不回归（0x8C 之外的未知 tag 仍按既有行为忽略）", () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  // 心跳同时携带已知 0x8C 与两个未知 tag（0x90/0xF0）：不抛、0x8C 生效、未知不动状态、计数不炸
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 1,
    ctrlTlv: concatU8(
      v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)),
      v3Tlv(0x90, Uint8Array.of(0xde, 0xad)),
      v3Tlv(0xf0, Uint8Array.of(1, 2, 3)),
      v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),
    ),
  }));
  assert.equal(rig.link.statusView().mode, 2);           // 已知 tag 照常入状态
  assert.equal(rig.link.statusView().evEn, true);        // 0x8C 照常生效
  assert.equal(rig.link.counters.modeConflict, 0);       // 无数据包 MODE 时心跳模式不判冲突（既有行为）
  // 纯未知 tag 的心跳：状态零变化、不抛
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 2,
    ctrlTlv: v3Tlv(0x91, Uint8Array.of(9)),
  }));
  assert.equal(rig.link.statusView().mode, 2);
  assert.equal(rig.link.statusView().evEn, true);
});

test("判据④ SEQ 不匹配的 ACK 不命中：只有超时定时器能结束等待", async () => {
  const rig = newRig({ ackTimeoutMs: 20 });
  rig.link.seenV3 = true;
  const p = rig.link.setMode(2);
  const seq = seqOf(rig.sent[0] as Uint8Array);
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.SET_MODE, ctrlSeq: (seq + 1) & 0xffff, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)) }));
  // 错 SEQ 的 ACK 不 resolve、也不动模式状态
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 9, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(1)) }));
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10))]);
  assert.equal(settled, false);
  // 点火超时定时器 → resolve 失败
  rig.fireTimers();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.detail, /超时/);
  assert.equal(rig.link.statusView().mode, 1);           // 心跳的 MODE=1 已入状态
});

test("判据④ SET_PARAM/GET_STATUS/校准 ACK：TLV 读回值落进状态视图（§6.3.1/§6.3.4）", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const p = rig.link.setParam({ theta: 44, minDl: 1 });
  const seq = seqOf(rig.sent[0] as Uint8Array);
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x00, 0x01)),
  );
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.SET_PARAM, ctrlSeq: seq, ctrlTlv: tlv }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.theta, 44);
  assert.equal(r.tlvs?.minDl, 1);
  assert.equal(rig.link.statusView().theta, 44);
  assert.equal(rig.link.statusView().minDl, 1);
});

test("判据④ TIME_SYNC ACK：offset 学习（回调通知装配器）+ 单向误差 err=((t4'−t1)−RTT)/2", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const offsets: (number | null)[] = [];
  rig.link.onOffsetChanged = (o) => offsets.push(o);
  const p = rig.link.calibrate();                        // PC 主动校准
  const seq = seqOf(rig.sent[0] as Uint8Array);
  const sendUs = rig.nowUs();
  rig.advanceUs(5_000);                                  // t4' = t1 + 5 ms（PC 收到 ACK 的时刻）
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.TS_OFFSET, Uint8Array.of(0, 0, 0, 0, 0x16, 0xe3)),  // 5859 µs（任意正值）
    v3Tlv(CTRL.TLV.TS_RTT_US, Uint8Array.of(0x0b, 0xb8)),               // RTT = 3000 µs
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 1)),
  );
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.TIME_SYNC, ctrlStatus: 0, ctrlSeq: seq, ctrlTlv: tlv }));
  const r = await p;
  assert.equal(r.ok, true);
  const sv = rig.link.statusView();
  assert.equal(sv.tsCalibrated, true);
  assert.equal(sv.tsOffsetUs, 5859);
  assert.equal(sv.tsRttUs, 3000);
  assert.equal(sv.bootId, 1);
  assert.ok(sv.calAgeMs !== null && sv.calAgeMs >= 0);   // 刚校准完 → calAge 0（nowMs 取 us/1000 同刻）
  // err = (5000 − 3000)/2 = 1000 µs = 1 ms
  assert.equal(Math.round((sv.tsAlignErrMs ?? -1) * 100) / 100, 1);
  assert.deepEqual(offsets, [5859]);                     // 装配器收到 offset 注入
  void sendUs;
});

test("判据④ 模式双源冲突：数据包 MODE vs 心跳 MODE 不一致 ⇒ modeConflict 计数 + 重发 GET_STATUS（§7.2）", () => {
  const rig = newRig();
  rig.link.noteDataMode(1);                              // 数据包说 MODE=1
  assert.equal(rig.sent.length, 0);
  // 心跳说 MODE=2：冲突
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 1, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)) }));
  assert.equal(rig.link.counters.modeConflict, 1);
  assert.equal(rig.sent.length, 1);                      // 重发 GET_STATUS
  assert.equal(opcodeOf(rig.sent[0] as Uint8Array), DOWNLINK.OPCODE.GET_STATUS);
  // 同一对冲突重复出现：去重，不重复计数（但重发节流 2 s 内也不再发）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 2, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)) }));
  assert.equal(rig.link.counters.modeConflict, 1);
  assert.equal(rig.sent.length, 1);
  // 冲突解除后恢复
  rig.link.noteDataMode(2);
  assert.equal(rig.link.counters.modeConflict, 1);
});

test("V3Link 计数器与外部共享口径（构造注入的那一份）", () => {
  const counters = createCounters();
  const rig = newRig({ counters });
  assert.equal(rig.link.counters, counters);             // 注入的那一份被原样使用
  assert.equal(rig.link.counters.modeConflict, 0);
  // 无数据包 MODE（dataMode=null）时心跳模式只入状态、不判冲突
  rig.link.seenV3 = true;
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 1, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(1)) }));
  assert.equal(rig.link.counters.modeConflict, 0);
  assert.equal(rig.link.statusView().mode, 1);
});

// ————————————————————————————————————————————————————————————————————————————
// host 小修批次（2026-10-12）：UART 板端扩展契约对齐
// （依据：板端实现报告 §3.2/§3.3 —— CTRL_LEN 68/25/26 + 下行 tag 0x07..0x0C + TLV 0x8D/0x8E/0x8F/0x90/0x91）
// ————————————————————————————————————————————————————————————————————————————

test("host小修③ GET_STATUS ACK CTRL_LEN=68：0x8D/0x8E/0x8F/0x90/0x91 落进状态视图（0x88/0x8A 单条拆读同路径）", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  assert.equal(rig.link.statusView().evRes, null);       // 板端尚未上报
  assert.equal(rig.link.statusView().serState, null);
  assert.equal(rig.link.statusView().netState, null);
  const p = rig.link.getStatus();
  const seq = seqOf(rig.sent[0] as Uint8Array);
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x00, 0x20)),
    v3Tlv(CTRL.TLV.TS_OFFSET, Uint8Array.of(0, 0, 0, 0, 0x16, 0xe3)),
    v3Tlv(CTRL.TLV.TS_RTT_US, Uint8Array.of(0x0b, 0xb8)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0b001)),
    v3Tlv(CTRL.TLV.FRAME_IDX, Uint8Array.of(0x00, 0x07)),
    v3Tlv(CTRL.TLV.DROP, Uint8Array.of(0, 3, 0, 5)),                        // 单条 len4（板端已烧录形态）
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 1)),
    v3Tlv(CTRL.TLV.VERSION, Uint8Array.of(0x01, 0x02, 0x03)),               // 单条 len3
    v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(32, 1, 9)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.UP)),
    v3Tlv(CTRL.TLV.EXP_CAP_STATE, Uint8Array.of(0x17, 0x10)),   // sccb 集成尾追（2026-10-13）
    v3Tlv(CTRL.TLV.SER_BAUD_STATE, Uint8Array.of(3)),           // 串口提速（2026-10-17）：0x91=921600
  );
  assert.equal(tlv.length, CTRL.LEN.GET_STATUS_ACK);     // 68（与板端 ctrl_len_of 逐值对齐）
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq, ctrlTlv: tlv,
  }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.dropPx, 3);
  assert.equal(r.tlvs?.dropEv, 5);                       // 旧实现此字段恒 null（告警盲区已闭合）
  assert.equal(r.tlvs?.wireVer, 3);                      // 旧实现恒 null
  const sv = rig.link.statusView();
  assert.equal(sv.evRes, 2);
  assert.deepEqual(sv.serState, { decim: 32, agg: 1, uartEvDrop: 9 });
  assert.equal(sv.netState, CTRL.NET_STATE.UP);
  assert.equal(sv.serialBaud, 921600);                    // 0x91 读回 3 → 921600
});

test("host小修③ 心跳 CTRL_LEN=25：0x8F NET_STATE 刷新状态视图；未携带不回退；插发同路径", () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const hb = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.DROP, Uint8Array.of(0, 1, 0, 2)),
    v3Tlv(CTRL.TLV.FRAME_IDX, Uint8Array.of(0, 9)),
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 3)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.DOWN)),          // 拔网线：UNKNOWN→DOWN
  );
  assert.equal(hb.length, CTRL.LEN.HEARTBEAT);           // 25
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 1, ctrlTlv: hb }));
  assert.equal(rig.link.statusView().netState, CTRL.NET_STATE.DOWN);
  assert.equal(rig.link.statusView().mode, 0);
  // 探测状态变化 → 板端立即插发同结构 CTRL（UP）：走同一解析路径
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 2, ctrlTlv: v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.UP)) }));
  assert.equal(rig.link.statusView().netState, CTRL.NET_STATE.UP);
  // 心跳未携带 0x8F（旧固件）⇒ 保持现值，绝不用"无上报"顶掉板端真值
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 3, ctrlTlv: v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)) }));
  assert.equal(rig.link.statusView().netState, CTRL.NET_STATE.UP);
  assert.equal(rig.link.statusView().mode, 2);
});

test("host小修②③ SET_PARAM 下发 MIN_DL 600→511 编码；ACK CTRL_LEN=26 的 0x8D/0x8E/0x90/0x91 读回落状态", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const p = rig.link.setParam({ minDl: 600, evRes: 1, serDecim: 7 });     // 600 越界 → 必须钳成 511
  const cmd = rig.sent[0] as Uint8Array;
  const sent = parseTlvs(cmd.subarray(10, cmd.length - 2));               // 下行载荷（去掉尾部 CRC）
  assert.equal(sent.length, 3);
  assert.equal(sent[0]!.tag, DOWNLINK.TAG.MIN_DL);
  assert.deepEqual(Array.from(sent[0]!.value), [0x01, 0xff]);             // 600 → 511（Q-7 钳位）
  assert.deepEqual([sent[1]!.tag, Array.from(sent[1]!.value)], [DOWNLINK.TAG.EV_RES, [1]]);
  assert.deepEqual([sent[2]!.tag, Array.from(sent[2]!.value)], [DOWNLINK.TAG.SER_DECIM, [7]]);
  // 板端 SET_PARAM ACK：CTRL_LEN=26 = MODE(3)+THETA(4)+MIN_DL(4)+EV_RES(3)+SER_STATE(5)+EXP_CAP_STATE(4)+SER_BAUD_STATE(3)
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x01, 0xff)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(7, 0, 0)),
    v3Tlv(CTRL.TLV.EXP_CAP_STATE, Uint8Array.of(0x17, 0x10)),   // 本次没写 cap ⇒ 读回复位默认（sccb 集成 §9.4 第 3 条同口径）
    v3Tlv(CTRL.TLV.SER_BAUD_STATE, Uint8Array.of(2)),           // 串口提速：0x91=460800
  );
  assert.equal(tlv.length, CTRL.LEN.SET_PARAM_ACK);      // 26
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.SET_PARAM, ctrlStatus: DOWNLINK.STATUS.OK,
    ctrlSeq: seqOf(cmd), ctrlTlv: tlv,
  }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.minDl, 511);                      // 写后读回 = 钳位后的值
  assert.equal(r.tlvs?.expCap, 0x1710);
  const sv = rig.link.statusView();
  assert.equal(sv.minDl, 511);
  assert.equal(sv.evRes, 1);
  assert.equal(sv.serialBaud, 460800);                    // 0x91 读回 2
  assert.deepEqual(sv.serState, { decim: 7, agg: 0, uartEvDrop: 0 });
});

// ————————————————————————————————————————————————————————————————————————————
// sccb 集成对齐（2026-10-13）：tag 0x0B EXP_CAP 下发 + TLV 0x90 读回吸收
// （依据：sccb 集成报告 §9 —— CTRL_LEN SET_PARAM ACK 26 / GET_STATUS 68；串口提速再追加 0x91；心跳仍 25）
// ————————————————————————————————————————————————————————————————————————————

test("sccb① SET_PARAM 下发 expCap：tag 0x0B + u16 BE（746=0x02EA）；越界 99999 先钳成 5904=0x1710", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  assert.equal(rig.link.statusView().expCap, null);      // 板端尚未上报（旧固件/未 GET_STATUS）
  const p = rig.link.setParam({ expCap: 746 });
  const cmd = rig.sent[0] as Uint8Array;
  assert.equal(opcodeOf(cmd), DOWNLINK.OPCODE.SET_PARAM);
  const sent = parseTlvs(cmd.subarray(10, cmd.length - 2));   // 下行载荷（去掉尾部 CRC）
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.tag, DOWNLINK.TAG.EXP_CAP);           // 0x0B
  assert.deepEqual(Array.from(sent[0]!.value), [0x02, 0xea]); // 746 行，大端
  // 越界（99999 > 5904）⇒ 协议层钳位后再编码（否则板端 BAD_VALUE 会连坐整条命令）
  void rig.link.setParam({ expCap: 99999 });
  const cmd2 = rig.sent[1] as Uint8Array;
  assert.deepEqual(Array.from(parseTlvs(cmd2.subarray(10, cmd2.length - 2))[0]!.value), [0x17, 0x10]);
  rig.fireTimers();                                      // 了结挂起的 ACK 定时器（避免悬挂）
  await p;
});

test("sccb② SET_PARAM ACK CTRL_LEN=26：TLV 0x90 写后读回落进状态视图（以读回为准）", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  const p = rig.link.setParam({ expCap: 746 });
  const cmd = rig.sent[0] as Uint8Array;
  // 板端 SET_PARAM ACK：CTRL_LEN=26 = MODE(3)+THETA(4)+MIN_DL(4)+EV_RES(3)+SER_STATE(5)+EXP_CAP_STATE(4)+SER_BAUD_STATE(3)
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x01, 0xff)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(7, 0, 0)),
    v3Tlv(CTRL.TLV.EXP_CAP_STATE, Uint8Array.of(0x02, 0xea)),   // 写后读回 = 746
    v3Tlv(CTRL.TLV.SER_BAUD_STATE, Uint8Array.of(1)),           // 串口提速：0x91=230400
  );
  assert.equal(tlv.length, CTRL.LEN.SET_PARAM_ACK);      // 26（与板端 ctrl_len_of 逐值对齐）
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.SET_PARAM, ctrlStatus: DOWNLINK.STATUS.OK,
    ctrlSeq: seqOf(cmd), ctrlTlv: tlv,
  }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.expCap, 746);
  assert.equal(r.tlvs?.serialBaud, 230400);              // 0x91 读回 1
  assert.equal(rig.link.statusView().expCap, 746);       // 状态=板端读回值
});

test("sccb③ GET_STATUS CTRL_LEN=68：0x90/0x91 刷新；旧固件 65 帧照常解析且 expCap/serialBaud 保持（缺失不回退）", async () => {
  const rig = newRig();
  rig.link.seenV3 = true;
  // 新版 GET_STATUS ACK（68 = 61 + 0x90(4) + 0x91(3)）
  const p = rig.link.getStatus();
  const seq = seqOf(rig.sent[0] as Uint8Array);
  const tlv = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x00, 0x20)),
    v3Tlv(CTRL.TLV.TS_OFFSET, Uint8Array.of(0, 0, 0, 0, 0x16, 0xe3)),
    v3Tlv(CTRL.TLV.TS_RTT_US, Uint8Array.of(0x0b, 0xb8)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0b001)),
    v3Tlv(CTRL.TLV.FRAME_IDX, Uint8Array.of(0x00, 0x07)),
    v3Tlv(CTRL.TLV.DROP, Uint8Array.of(0, 3, 0, 5)),
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 1)),
    v3Tlv(CTRL.TLV.VERSION, Uint8Array.of(0x01, 0x02, 0x03)),
    v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(32, 1, 9)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.UP)),
    v3Tlv(CTRL.TLV.EXP_CAP_STATE, Uint8Array.of(0x17, 0x10)),   // 复位默认 0x1710
    v3Tlv(CTRL.TLV.SER_BAUD_STATE, Uint8Array.of(3)),           // 串口提速：0x91=921600
  );
  assert.equal(tlv.length, CTRL.LEN.GET_STATUS_ACK);     // 68
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq, ctrlTlv: tlv,
  }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.tlvs?.expCap, 0x1710);
  assert.equal(r.tlvs?.serialBaud, 921600);              // 0x91 读回 3
  assert.equal(rig.link.statusView().expCap, 0x1710);
  // 旧固件（2026-10-13 形态，CTRL_LEN=65，无 0x91）：解析照常，expCap/serialBaud 保持板端真值 —— 绝不被"无上报"顶成 null/下发值
  const p2 = rig.link.getStatus();
  const seq2 = seqOf(rig.sent[1] as Uint8Array);
  const legacy = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.THETA, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(CTRL.TLV.MIN_DL, Uint8Array.of(0x00, 0x20)),
    v3Tlv(CTRL.TLV.TS_OFFSET, Uint8Array.of(0, 0, 0, 0, 0x16, 0xe3)),
    v3Tlv(CTRL.TLV.TS_RTT_US, Uint8Array.of(0x0b, 0xb8)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0b001)),
    v3Tlv(CTRL.TLV.FRAME_IDX, Uint8Array.of(0x00, 0x07)),
    v3Tlv(CTRL.TLV.DROP, Uint8Array.of(0, 3, 0, 5)),
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 1)),
    v3Tlv(CTRL.TLV.VERSION, Uint8Array.of(0x01, 0x02, 0x03)),
    v3Tlv(CTRL.TLV.EV_EN, Uint8Array.of(1)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(2)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(32, 1, 9)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.UP)),
    v3Tlv(CTRL.TLV.EXP_CAP_STATE, Uint8Array.of(0x17, 0x10)),   // 2026-10-13 固件有 0x90、无 0x91
  );
  assert.equal(legacy.length, 65);                       // 旧登记长度（61+0x90）：解析器不硬断言 ⇒ 照常过
  rig.link.onCtrlPacket(ctrlPkt({
    ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: seq2, ctrlTlv: legacy,
  }));
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(r2.tlvs?.expCap, 0x1710);                 // 本包仍携带 0x90
  assert.equal(r2.tlvs?.serialBaud, null);               // 旧包无 0x91
  assert.equal(rig.link.statusView().expCap, 0x1710);    // 保持现值（同 0x8C/0x8F 的"缺失不回退"口径）
  assert.equal(rig.link.statusView().serialBaud, 921600); // 读回缺失不回退
  // 心跳（CTRL_LEN=25，不含 0x90）走同一路径：expCap 不动
  const hb = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.TS_FLAGS, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.DROP, Uint8Array.of(0, 1, 0, 2)),
    v3Tlv(CTRL.TLV.FRAME_IDX, Uint8Array.of(0, 9)),
    v3Tlv(CTRL.TLV.BOOT_ID, Uint8Array.of(0, 0, 0, 3)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(CTRL.NET_STATE.UP)),
  );
  assert.equal(hb.length, CTRL.LEN.HEARTBEAT);           // 25（报告 §9.3：心跳不含 0x90，长度不动）
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 0x0101, ctrlTlv: hb }));
  assert.equal(rig.link.statusView().expCap, 0x1710);
});

// ————————————————————————— 十修 T1：心跳 ACK 标记/统计 —————————————————————————

test("十修 T1 心跳 GET_STATUS 的 ACK 带 heartbeat:true 并记 RTT；用户 SET_PARAM ACK 不带该字段", async () => {
  const rig = newRig();
  const events: Record<string, unknown>[] = [];
  rig.link.onCtrlEvent = (e) => { events.push(e); };

  const hbP = rig.link.getStatus({ heartbeat: true });
  assert.equal(rig.sent.length, 1);
  const hbSeq = seqOf(rig.sent[0] as Uint8Array);
  rig.advanceUs(2_000);                                  // 2 ms 后板端回 ACK
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.GET_STATUS, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: hbSeq }));
  const hbAck = await hbP;
  assert.equal(hbAck.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.["kind"], "ack");
  assert.equal(events[0]?.["heartbeat"], true, "心跳 ACK 必须带 heartbeat:true（前端据此静默）");
  assert.deepEqual(rig.link.heartbeatStats(), { ack: 1, fail: 0, lastAckAtMs: 1002, lastRttMs: 2 });

  // 用户自己发的 SET_PARAM：同一条 ACK 通道，但绝不能带 heartbeat 标记
  const userP = rig.link.setParam({ theta: 45 });
  const userSeq = seqOf(rig.sent[1] as Uint8Array);
  rig.advanceUs(5_000);
  rig.link.onCtrlPacket(ctrlPkt({ ctrlOpcode: DOWNLINK.OPCODE.SET_PARAM, ctrlStatus: DOWNLINK.STATUS.OK, ctrlSeq: userSeq }));
  const userAck = await userP;
  assert.equal(userAck.ok, true);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.["heartbeat"], undefined, "用户命令 ACK 不得带 heartbeat");
  // 用户命令不改变心跳统计
  assert.deepEqual(rig.link.heartbeatStats(), { ack: 1, fail: 0, lastAckAtMs: 1002, lastRttMs: 2 });
});
