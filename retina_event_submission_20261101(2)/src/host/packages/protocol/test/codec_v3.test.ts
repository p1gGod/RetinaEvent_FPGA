// v3 线格式测试（WIRE-V3 设计 §2/§5/§6 的逐条落地断言）。
// 构造一律用 helpers.buildV3 手工拼字节 —— 与被测实现解耦（与 codec_v2.test.ts 同哲学）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvEnPayload,
  buildSetModePayload,
  buildSetParamPayload,
  buildTimeSyncPayload,
  boardTsToMs,
  applyTsOffsetUs,
  CTRL,
  DOWNLINK,
  EXP_CAP_LIMITS,
  MIN_DL_LIMITS,
  SERIAL_BAUD_RATES,
  clampExpCap,
  clampMinDl,
  encodeDownlink,
  getProfile,
  interpretStatusTlvs,
  parseTlvs,
  parseV3Packet,
  serialBaudCode,
  serialBaudOfCode,
  usToMs,
} from "../src/index.ts";
import { buildV2, buildV3, concatU8, evByteAligned, seq, v3Tlv } from "./helpers.ts";

const P = getProfile("retina-v2-800x480-1280")!;
const base = { profile: P };

// ————————————————————————— 上行包头解析（§2） —————————————————————————

test("P0-v3 正常包（仅原始段）：字段偏移按 §2.1，CHUNK_IDX/FRAME_IDX 位置与 v2 不同", () => {
  const r = parseV3Packet(buildV3({ frameIdx: 0x1234, chunkIdx: 599, raw: seq(1280), tsUs: 0x1234_5678_90ab, tsCalibrated: true, first: true }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value;
  assert.equal(v.kind, "v3");
  assert.equal(v.ver, 3);
  assert.equal(v.hdrLen, 24);
  assert.equal(v.frameIdx, 0x1234);
  assert.equal(v.chunkIdx, 599);
  assert.equal(v.rawLen, 1280);
  assert.equal(v.evLen, 0);
  assert.equal(v.tsUs, 0x1234_5678_90ab);          // 48 bit 大端无损读出（< 2^53）
  assert.equal(v.tsValid, true);
  assert.equal(v.tsCalibrated, true);
  assert.equal(v.firstOfFrame, true);
  assert.equal(v.crc16Present, true);
  assert.equal(v.raw?.length, 1280);
  assert.equal(v.ctrlHeader, null);
});

test("P0-v3 原始+事件包：EV 数据起点 = 24+RAW_LEN（不是 v2 的 13+…）", () => {
  const ev = evByteAligned(100, 239, 1, 0x2a);
  const r = parseV3Packet(buildV3({ raw: seq(1280), events: ev, mode: 0 }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.events?.length, 5);
  assert.equal(r.value.events?.[0], 100);            // EV 起点 = 24+1280，数据没错位
  assert.equal(r.value.evRecBytes, 5);
});

test("P0-v3 时间戳三路径之一：TS_VALID=1 → tsUs 读出（判据① 存在）", () => {
  const r = parseV3Packet(buildV3({ raw: seq(32), tsUs: 1234567 }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.tsUs, 1234567);
});

test("P0-v3 时间戳三路径之二：TS_VALID=0 → tsUs=null 但包照常解析（判据① 缺失；§2.3 只忽略时间戳）", () => {
  const r = parseV3Packet(buildV3({ raw: seq(32), tsUs: null }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.tsValid, false);
  assert.equal(r.value.tsUs, null);
  assert.equal(r.value.raw?.length, 32);
});

test("P0-v3 HDR_LEN > 24：按声明头长跳过附加头（前向兼容）", () => {
  const r = parseV3Packet(buildV3({ raw: seq(16), hdrLen: 26 }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.hdrLen, 26);
  assert.equal(r.value.raw?.length, 16);
});

test("P2-v3 定位/版本/头长三道闸：坏魔数 badMagic、VER≠3 badVersion、HDR_LEN<24 badHdrLen", () => {
  const good = buildV3({ raw: seq(16) });
  const badMagic = Uint8Array.from(good); badMagic[3] = 0x0f;   // v2 魔数 ≠ v3
  const r1 = parseV3Packet(badMagic, base);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "badMagic");
  const badVer = Uint8Array.from(good); badVer[4] = 0x02;
  const r2 = parseV3Packet(badVer, base);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "badVersion");
  const badHdr = Uint8Array.from(good); badHdr[5] = 13;         // 13 是 v2 头长，v3 至少 24
  const r3 = parseV3Packet(badHdr, base);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.reason, "badHdrLen");
});

test("P2-v3 长度自洽：多/少字节 → badLength；>1472 或 RAW_LEN>1446 → oversize", () => {
  const r1 = parseV3Packet(buildV3({ raw: seq(64), totalPad: 3 }), base);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "badLength");
  const r2 = parseV3Packet(buildV3({ raw: seq(1500) }), base);   // 24+1500+2 > 1472
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "oversize");
  // RAW_LEN 声明 1447 但只装 64 B：上限判定先于长度自洽（§2.3 顺序）
  const r3 = parseV3Packet(buildV3({ raw: seq(64), rawLenOverride: 1447, flags: 0b1111, mode: 0 }), base);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.reason, "oversize");
});

test("P5'-v3 CRC 损坏 → crcFail（整包丢弃）", () => {
  const r = parseV3Packet(buildV3({ raw: seq(1280), breakCrc: true }), base);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "crcFail");
});

test("P3-v3 段一致性：FLAGS 说有事件但 EV_LEN=0 → 以 FLAGS 为准 + segInconsistent；MODE1 带事件段同样告警", () => {
  const r1 = parseV3Packet(buildV3({ raw: seq(64), flags: 0b1111, mode: 0 }), base); // bit0/1/2/3：bit1 声明事件但 EV_LEN=0
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.ok(r1.value.warnings.includes("segInconsistent"));
  assert.equal(r1.value.events, null);
  const r2 = parseV3Packet(buildV3({ raw: seq(64), events: evByteAligned(1, 2, 1, 0), mode: 1 }), base);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.ok(r2.value.warnings.includes("segInconsistent"));
});

test("P3-v3 未知 MODE ≥3：按 MODE2 稳健降级 + modeNotice 告警，不丢整包", () => {
  const ev = evByteAligned(1, 2, 1, 0);
  const r = parseV3Packet(buildV3({ events: ev, mode: 5 }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.mode, 2);
  assert.equal(r.value.modeRaw, 5);
  assert.ok(r.value.warnings.includes("modeNotice"));
  assert.equal(r.value.events?.length, 5);
});

test("P9-v3 任何输入都不抛异常（垃圾数据）", () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0), new Uint8Array([0xf0, 0x5a, 0xa5, 0x30]),
    new Uint8Array(2000).fill(0xab), buildV3({ raw: seq(2000) }), buildV3({ raw: seq(16), ver: 0x99 }),
  ];
  for (const c of cases) {
    const r = parseV3Packet(c, base);
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.equal(typeof r.reason, "string");
  }
});

test("P2-v3 v2 帧不被 v3 解析器误收（按魔数分派互不误判，§9.2）", () => {
  const v2pkt = buildV2({ frameIdx: 7, chunkIdx: 1, raw: seq(64) });
  const r = parseV3Packet(v2pkt, base);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "badMagic");
});

// ————————————————————————— CTRL 包（§6.2） —————————————————————————

test("CTRL ACK：6 B 控制头 + TLV 解析 + STATUS/SEQ 读出", () => {
  const tlv = concatU8(
    v3Tlv(0x81, Uint8Array.of(1)),                       // MODE=1
    v3Tlv(0x82, Uint8Array.of(0x00, 0x2c)),              // THETA=44
    v3Tlv(0x86, Uint8Array.of(0b001)),                   // TS_FLAGS calibrated
  );
  const r = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x02, ctrlStatus: 0, ctrlSeq: 0x1234, ctrlTlv: tlv, mode: 1 }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.ctrl, true);
  assert.equal(r.value.raw, null);
  assert.equal(r.value.events, null);
  const ch = r.value.ctrlHeader;
  assert.ok(ch !== null);
  assert.equal(ch.opcode, 0x02);
  assert.equal(ch.status, 0);
  assert.equal(ch.seq, 0x1234);
  assert.equal(ch.tlv.length, 3);
  const st = interpretStatusTlvs(ch.tlv);
  assert.equal(st.mode, 1);
  assert.equal(st.theta, 44);
  assert.equal(st.tsFlags, 1);
});

test("CTRL TIME_SYNC_REQ：6 B 裸载荷（BOARD_TS_US）不按 TLV 解析", () => {
  const payload = Uint8Array.of(0x00, 0x00, 0x12, 0x34, 0x56, 0x78); // t2，首字节 0（µs 上电 <12.7 天）
  const r = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x83, ctrlSeq: 77, ctrlPayload: payload }), base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ch = r.value.ctrlHeader;
  assert.ok(ch !== null);
  assert.equal(ch.tlv.length, 0);                       // REQ 载荷不是 TLV
  assert.equal(ch.payload.length, 6);
});

test("CTRL 包必须 RAW_LEN=EV_LEN=0，否则 badLength（§2.1 CTRL 例外）", () => {
  // 绕开 helper 的"CTRL 强制清零"，手工把 RAW_LEN 改成 16
  const bad = buildV3({ ctrl: true, ctrlTlv: new Uint8Array(0) });
  bad[13] = 0x10;                                        // RAW_LEN = 0x0010
  const r = parseV3Packet(bad, base);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "badLength");
});

test("TLV 解释表（§6.2）：TS_OFFSET 二补码 / DROP×2 / VERSION×2 / UNSUPPORTED_TAGS", () => {
  const tlv = concatU8(
    v3Tlv(0x84, Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xfe)),   // -2 µs（二补码低 48 位）
    v3Tlv(0x88, Uint8Array.of(0x00, 0x0a)),                            // DROP_PX=10
    v3Tlv(0x88, Uint8Array.of(0x00, 0x14)),                            // DROP_EV=20
    v3Tlv(0x89, Uint8Array.of(0x00, 0x00, 0x00, 0x07)),                // BOOT_ID=7
    v3Tlv(0x8a, Uint8Array.of(0x01, 0x02)),                            // FW_VER=0x0102
    v3Tlv(0x8a, Uint8Array.of(0x03)),                                  // WIRE_VER=3
    v3Tlv(0x8b, Uint8Array.of(0x07, 0x08)),                            // UNSUPPORTED_TAGS
  );
  const st = interpretStatusTlvs(parseTlvs(tlv));
  assert.equal(st.tsOffsetUs, -2);
  assert.equal(st.dropPx, 10);
  assert.equal(st.dropEv, 20);
  assert.equal(st.bootId, 7);
  assert.equal(st.fwVer, 0x0102);
  assert.equal(st.wireVer, 3);
  assert.deepEqual(st.unsupportedTags, [7, 8]);
  assert.equal(st.evEn, null);                                          // 未携带 0x8C → null
});

// ———————— v3.1 对齐（2026-10-11 板端定案，见板端实现报告 §5） ————————

test("v3.1 对齐 ①：TLV 0x8C（len1）解释为事件支路读回值；EV_EN ACK 的 CTRL_LEN=3 包可解析", () => {
  const st1 = interpretStatusTlvs(parseTlvs(v3Tlv(0x8c, Uint8Array.of(1))));
  assert.equal(st1.evEn, true);
  const st0 = interpretStatusTlvs(parseTlvs(v3Tlv(0x8c, Uint8Array.of(0))));
  assert.equal(st0.evEn, false);
  // 板端 EV_EN ACK 实际字节形态：STATUS=OK + 单条 TLV 0x8C（CTRL_LEN=3）
  const ack = buildV3({ ctrl: true, ctrlOpcode: 0x05, ctrlStatus: 0, ctrlSeq: 0x0043, ctrlTlv: v3Tlv(0x8c, Uint8Array.of(1)) });
  assert.equal(new DataView(ack.buffer, ack.byteOffset, ack.byteLength).getUint16(28), 3); // CTRL_LEN=3
  const r = parseV3Packet(ack, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.status, 0);
  assert.equal(interpretStatusTlvs(r.value.ctrlHeader?.tlv ?? []).evEn, true);
});

test("v3.1 对齐 ③：未知 TLV tag 容忍不回归（0x8C 之外的未知 tag 仍忽略，不抛、不动已知字段）", () => {
  const tlv = concatU8(
    v3Tlv(0x8c, Uint8Array.of(0)),                                     // 已知（本次新增）
    v3Tlv(0x90, Uint8Array.of(0xde, 0xad)),                            // 未知 tag：前向兼容
    v3Tlv(0xf0, Uint8Array.of(1, 2, 3, 4)),                            // 未知 tag
  );
  let threw: unknown = null;
  let st: ReturnType<typeof interpretStatusTlvs> | null = null;
  try {
    st = interpretStatusTlvs(parseTlvs(tlv));
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null);                                           // 显式断言"不抛"
  assert.ok(st !== null);
  assert.equal(st.evEn, false);                                        // 0x8C 正常解释
  assert.equal(st.mode, null);                                         // 未知 tag 没有污染已知字段
  assert.deepEqual(st.unsupportedTags, []);                            // 未知 tag 不进 UNSUPPORTED_TAGS
});

// ————————————————————————— 下行命令编码（§6） —————————————————————————

test("下行通用格式：MAGIC_D F0 5A A5 31 / VER 3 / OPCODE / SEQ / LEN / CRC16 覆盖 [0..10+LEN)", () => {
  const payload = Uint8Array.of(0xde, 0xad);
  const b = encodeDownlink(0x02, 0xbeef, payload);
  assert.deepEqual(Array.from(b.subarray(0, 4)), [0xf0, 0x5a, 0xa5, 0x31]);
  assert.equal(b[4], 0x03);
  assert.equal(b[5], 0x02);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(dv.getUint16(6), 0xbeef);
  assert.equal(dv.getUint16(8), 2);
  assert.deepEqual(Array.from(b.subarray(10, 12)), [0xde, 0xad]);
  // 独立重算 CRC-16/CCITT-FALSE（与 codec/crc.ts 同算法、与 RTL 一致）
  let crc = 0xffff;
  for (let i = 0; i < 12; i++) {
    crc ^= (b[i] as number) << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  assert.equal(dv.getUint16(12), crc);
});

test("SET_PARAM TLV（§6.3.1）：THETA/MIN_DL u16、EV_FLUSH_CYC/TS_CAL_PERIOD_S u32、TS_FORCE_CAL u8", () => {
  const p = buildSetParamPayload({ theta: 44, minDl: 1, frameDecim: 2, evFlushCyc: 100000, tsCalPeriodS: 600, tsForceCal: 1 });
  const tlvs = parseTlvs(p);
  assert.equal(tlvs.length, 6);
  assert.deepEqual(Array.from(tlvs[0]!.value), [0x00, 0x2c]);
  assert.deepEqual(Array.from(tlvs[1]!.value), [0x00, 0x01]);
  assert.deepEqual(Array.from(tlvs[2]!.value), [0x00, 0x02]);
  const dv32 = (v: Uint8Array): number => (v[0] as number) * 2 ** 24 + (v[1] as number) * 2 ** 16 + (v[2] as number) * 2 ** 8 + (v[3] as number);
  assert.equal(dv32(tlvs[3]!.value), 100000);
  assert.equal(dv32(tlvs[4]!.value), 600);
  assert.equal(tlvs[5]!.value[0], 1);
});

test("SET_MODE 载荷 = 1 字节 0/1/2；越界抛错（§6.3.2）", () => {
  assert.deepEqual(Array.from(buildSetModePayload(0)), [0]);
  assert.deepEqual(Array.from(buildSetModePayload(2)), [2]);
  assert.throws(() => buildSetModePayload(3));
  assert.throws(() => buildSetModePayload(-1));
});

test("v3.1 增补 EV_EN：命令码 0x05（§6.1 顺序下一个未用码）、载荷 1 B 0/1、下行帧字节正确", () => {
  // ⚠️ 联板核对点：EV_EN 命令码 = 0x05，载荷 1 B（1=使能 / 0=禁用），登记见实现报告"协议增补 EV_EN"
  assert.equal(DOWNLINK.OPCODE.EV_EN, 0x05);
  const en = encodeDownlink(DOWNLINK.OPCODE.EV_EN, 0x0007, buildEvEnPayload(true));
  assert.equal(en[5], 0x05);
  assert.equal(en.length, 10 + 1 + 2);                   // 头 10 + 载荷 1 + CRC 2
  assert.deepEqual(Array.from(en.subarray(10, 11)), [1]);
  const dis = encodeDownlink(DOWNLINK.OPCODE.EV_EN, 0x0008, buildEvEnPayload(false));
  assert.deepEqual(Array.from(dis.subarray(10, 11)), [0]);
});

test("TIME_SYNC 载荷（§6.3.3）：9 B = HOST_TS_US[47:0] + RTT_HALF_US + FLAG", () => {
  const p = buildTimeSyncPayload(0x00_00_12_34_56_78, 0, false);
  assert.equal(p.length, 9);
  assert.deepEqual(Array.from(p.subarray(0, 6)), [0x00, 0x00, 0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(Array.from(p.subarray(6)), [0, 0, 0]);
  assert.throws(() => buildTimeSyncPayload(2 ** 48));   // 超出 48 bit
  assert.throws(() => buildTimeSyncPayload(-1));
});

// ————————————————————————— 时间换算与校准 offset（§4/§5，判据②） —————————————————————————

test("判据② µs→ms 换算：1_500_000 µs = 1500 ms（纯除 1000，无其它换算）", () => {
  assert.equal(usToMs(1_500_000), 1500);
  assert.equal(usToMs(0), 0);
});

test("判据② 校准 offset 应用：板端未标 calibrated 时 PC 代加 offset（§5.1 aligned = local + offset）", () => {
  // ① calibrated=1：板端已对齐，PC 不重复加
  assert.equal(boardTsToMs(5_000_000, { offsetUs: 999, calibrated: true }), 5000);
  // ② calibrated=0 + PC 知 offset：PC 代加
  assert.equal(boardTsToMs(5_000_000, { offsetUs: 1_500_000, calibrated: false }), 6500);
  // ③ offset 未知：null → 调用方回退到达时刻
  assert.equal(boardTsToMs(5_000_000, { offsetUs: null, calibrated: false }), null);
  assert.equal(boardTsToMs(Number.NaN, { offsetUs: 1, calibrated: false }), null);
});

test("判据② offset 二补码负值 + 48 bit 自然回绕（§5.1）", () => {
  assert.equal(applyTsOffsetUs(1000, -1500), 2 ** 48 - 500);  // 回绕到高端
  assert.equal(applyTsOffsetUs(2 ** 48 - 100, 200), 100);     // 高端 + 回绕
  assert.equal(boardTsToMs(1000, { offsetUs: -1500, calibrated: false }), (2 ** 48 - 500) / 1000);
});

// ————————————————————————————————————————————————————————————————————————————
// host 小修批次（2026-10-12，依据：统一把关报告 P-2/P-5 + UART 板端实现报告 §3.3）
// ① TLV 0x88/0x8A 双语义拆读  ② MIN_DL 输入钳位 0..511  ③ UART 扩展 tag/TLV/CTRL_LEN 对齐
// ————————————————————————————————————————————————————————————————————————————

// ———————— ① TLV 0x88 / 0x8A 双语义拆读（板端单条 vs 旧两条兼容） ————————

test("host小修① 0x88 单条 len4 → 拆出 DROP_PX + DROP_EV（先 PX 后 EV，与 RTL 字节序一致）", () => {
  // 板端 tlv_byte：值 = i_drop_px[15:8],px[7:0],i_drop_ev[15:8],ev[7:0]
  const st = interpretStatusTlvs(parseTlvs(v3Tlv(0x88, Uint8Array.of(0x01, 0x2c, 0x00, 0x0a))));
  assert.equal(st.dropPx, 300);                       // 前 2 B = PX
  assert.equal(st.dropEv, 10);                        // 后 2 B = EV（旧实现此字段恒 null ⇒ 告警盲区）
  // 反序对照：防止"拆反了但两边都是非 null"这种看不出来的错
  const swapped = interpretStatusTlvs(parseTlvs(v3Tlv(0x88, Uint8Array.of(0x00, 0x0a, 0x01, 0x2c))));
  assert.equal(swapped.dropPx, 10);
  assert.equal(swapped.dropEv, 300);
});

test("host小修① 0x8A 单条 len3 → 拆出 FW_VER + WIRE_VER（先 FW 后 WIRE）；两条旧形态仍兼容", () => {
  const st = interpretStatusTlvs(parseTlvs(v3Tlv(0x8a, Uint8Array.of(0x01, 0x02, 0x03))));
  assert.equal(st.fwVer, 0x0102);                     // 前 2 B = FW_VER
  assert.equal(st.wireVer, 3);                        // 末 1 B = WIRE_VER（旧实现恒 null）
  // 旧兼容分支（0x88 两条 len2 / 0x8A len2+len1）：不回归
  const legacy = interpretStatusTlvs(parseTlvs(concatU8(
    v3Tlv(0x88, Uint8Array.of(0x00, 0x0a)),
    v3Tlv(0x88, Uint8Array.of(0x00, 0x14)),
    v3Tlv(0x8a, Uint8Array.of(0x01, 0x02)),
    v3Tlv(0x8a, Uint8Array.of(0x03)),
  )));
  assert.equal(legacy.dropPx, 10);
  assert.equal(legacy.dropEv, 20);
  assert.equal(legacy.fwVer, 0x0102);
  assert.equal(legacy.wireVer, 3);
});

// ———————— ② MIN_DL 输入钳位 0..511（统一把关报告 Q-7 / P-5） ————————

test("host小修② MIN_DL 钳位：600→511、负值→0、非有限值→0、整数取整（板端 9 bit 寄存器上限）", () => {
  assert.equal(MIN_DL_LIMITS.MIN, 0);
  assert.equal(MIN_DL_LIMITS.MAX, 511);
  assert.equal(clampMinDl(600), 511);
  assert.equal(clampMinDl(-1), 0);
  assert.equal(clampMinDl(-65535), 0);
  assert.equal(clampMinDl(Number.NaN), 0);
  assert.equal(clampMinDl(Number.POSITIVE_INFINITY), 0);   // 非有限值 → 下界（与 clampInt 同口径）
  assert.equal(clampMinDl(511), 511);
  assert.equal(clampMinDl(0), 0);
  assert.equal(clampMinDl(12.7), 13);
});

test("host小修② 下行编码对 MIN_DL 钳位后再落字节（600→0x01FF、负值→0x0000），同包 θ 不受连坐", () => {
  const tlvs = parseTlvs(buildSetParamPayload({ theta: 44, minDl: 600 }));
  assert.equal(tlvs.length, 2);
  assert.deepEqual(Array.from(tlvs[0]!.value), [0x00, 0x2c]);   // θ=44 原样（板端不再因 MIN_DL 越界整条拒写）
  assert.deepEqual(Array.from(tlvs[1]!.value), [0x01, 0xff]);   // MIN_DL=511
  const neg = parseTlvs(buildSetParamPayload({ minDl: -5 }));
  assert.deepEqual(Array.from(neg[0]!.value), [0x00, 0x00]);
  // 整帧仍是合法 v3 下行包（头 10 + 载荷 4 + CRC 2）
  assert.equal(encodeDownlink(DOWNLINK.OPCODE.SET_PARAM, 1, buildSetParamPayload({ minDl: 600 })).length, 16);
});

// ———————— ③ UART 板端扩展契约（板端实现报告 §3.2/§3.3） ————————

test("host小修③ 下行 tag 0x07..0x0A 字节布局（与 RTL T_EV_RES/T_SER_DECIM/T_SER_AGG/T_SER_FLUSH 逐值一致）", () => {
  assert.equal(DOWNLINK.TAG.EV_RES, 0x07);
  assert.equal(DOWNLINK.TAG.SER_DECIM, 0x08);
  assert.equal(DOWNLINK.TAG.SER_AGG, 0x09);
  assert.equal(DOWNLINK.TAG.SER_EV_FLUSH_MS, 0x0a);
  const tlvs = parseTlvs(buildSetParamPayload({ evRes: 1, serDecim: 32, serAgg: 0, serEvFlushMs: 20 }));
  assert.equal(tlvs.length, 4);
  assert.deepEqual([tlvs[0]!.tag, Array.from(tlvs[0]!.value)], [0x07, [1]]);          // EV_RES u8
  assert.deepEqual([tlvs[1]!.tag, Array.from(tlvs[1]!.value)], [0x08, [32]]);         // SER_DECIM u8
  assert.deepEqual([tlvs[2]!.tag, Array.from(tlvs[2]!.value)], [0x09, [0]]);          // SER_AGG u8
  assert.deepEqual([tlvs[3]!.tag, Array.from(tlvs[3]!.value)], [0x0a, [0x00, 0x14]]); // SER_EV_FLUSH_MS u16 BE=20
  // 与既有 tag 同包混发时顺序 = 参数表声明顺序（板端顺序无关，仅钉住字节不漂）
  const mixed = parseTlvs(buildSetParamPayload({ theta: 44, evRes: 2, serAgg: 1 }));
  assert.deepEqual(mixed.map((t) => t.tag), [0x01, 0x07, 0x09]);
});

test("host小修③ TLV 0x8D/0x8E/0x8F 解释：EV_RES(len1)/SER_STATE(len3)/NET_STATE(len1) 三值 + 缺失为 null", () => {
  const st = interpretStatusTlvs(parseTlvs(concatU8(
    v3Tlv(0x8d, Uint8Array.of(1)),
    v3Tlv(0x8e, Uint8Array.of(32, 2, 7)),
    v3Tlv(0x8f, Uint8Array.of(1)),
  )));
  assert.equal(st.evRes, 1);
  assert.deepEqual(st.serState, { decim: 32, agg: 2, uartEvDrop: 7 });
  assert.equal(st.netState, 1);
  // NET_STATE 三值语义登记：0=DOWN / 1=UP / 2=UNKNOWN（link_detect 唯一真值）
  assert.deepEqual([CTRL.NET_STATE.DOWN, CTRL.NET_STATE.UP, CTRL.NET_STATE.UNKNOWN], [0, 1, 2]);
  for (const n of [0, 1, 2]) {
    assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x8f, Uint8Array.of(n)))).netState, n);
  }
  // 携带不全（len<3）→ null，不半解释出错误的 SER_STATE
  assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x8e, Uint8Array.of(32, 0)))).serState, null);
  // 未携带 → null（旧固件/心跳子集）
  const empty = interpretStatusTlvs(parseTlvs(new Uint8Array(0)));
  assert.equal(empty.evRes, null);
  assert.equal(empty.serState, null);
  assert.equal(empty.netState, null);
});

/** 板端 §3.3 ① 的 GET_STATUS TLV 区逐字节清单（50 B v3.1 段 + 11 B UART 扩展段 + 4 B sccb 段 = 65 B） */
function boardGetStatusTlv(): Uint8Array {
  return concatU8(
    v3Tlv(0x81, Uint8Array.of(0)),                       // MODE(3)
    v3Tlv(0x82, Uint8Array.of(0x00, 0x2c)),              // THETA(4)
    v3Tlv(0x83, Uint8Array.of(0x00, 0x20)),              // MIN_DL(4)
    v3Tlv(0x84, Uint8Array.of(0, 0, 0, 0, 0x16, 0xe3)),  // TS_OFFSET(8)
    v3Tlv(0x85, Uint8Array.of(0x0b, 0xb8)),              // RTT(4)
    v3Tlv(0x86, Uint8Array.of(0b001)),                   // TS_FLAGS(3)
    v3Tlv(0x87, Uint8Array.of(0x00, 0x07)),              // FRAME_IDX(4)
    v3Tlv(0x88, Uint8Array.of(0, 3, 0, 5)),              // DROP 单条 len4(6)
    v3Tlv(0x89, Uint8Array.of(0, 0, 0, 1)),              // BOOT_ID(6)
    v3Tlv(0x8a, Uint8Array.of(0x01, 0x02, 0x03)),        // FW/WIRE 单条 len3(5)
    v3Tlv(0x8c, Uint8Array.of(1)),                       // EV_EN(3)
    v3Tlv(0x8d, Uint8Array.of(2)),                       // EV_RES_STATE(3)
    v3Tlv(0x8e, Uint8Array.of(32, 1, 9)),                // SER_STATE(5)
    v3Tlv(0x8f, Uint8Array.of(2)),                       // NET_STATE(3)
    v3Tlv(0x90, Uint8Array.of(0x17, 0x10)),              // EXP_CAP_STATE(4) ← sccb 集成尾追（0x1710 = 复位默认）
  );
}

/** 串口提速后的 GET_STATUS TLV：65 B sccb 形态 + 0x91 波特率读回(3) = 68 B */
function boardGetStatusTlvNew(): Uint8Array {
  return concatU8(boardGetStatusTlv(), v3Tlv(0x91, Uint8Array.of(3)));   // 3 ⇒ 921600 baud
}

test("串口提速 B1 GET_STATUS ACK CTRL_LEN=68（全包 100 B）：0x8D/0x8E/0x8F/0x90 + 0x91 波特率读回", () => {
  const tlv = boardGetStatusTlvNew();
  assert.equal(tlv.length, CTRL.LEN.GET_STATUS_ACK);     // 68 = sccb 65 + 0x91(3)
  const pkt = buildV3({ ctrl: true, ctrlOpcode: 0x04, ctrlStatus: 0, ctrlSeq: 0x0011, ctrlTlv: tlv });
  assert.equal(pkt.length, 24 + 6 + CTRL.LEN.GET_STATUS_ACK + 2);   // 100
  assert.equal(new DataView(pkt.buffer).getUint16(28), 68);         // 线上 CTRL_LEN 大端
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true);                              // CRC16 覆盖 [0..95) —— 长度自洽即过
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.ctrlLen, 68);
  assert.equal(r.value.ctrlHeader?.tlv.length, 16);
  const st = interpretStatusTlvs(r.value.ctrlHeader?.tlv ?? []);
  assert.equal(st.dropPx, 3);
  assert.equal(st.dropEv, 5);                            // 单条 len4 拆读
  assert.equal(st.fwVer, 0x0102);
  assert.equal(st.wireVer, 3);                           // 单条 len3 拆读
  assert.equal(st.evEn, true);
  assert.equal(st.evRes, 2);
  assert.deepEqual(st.serState, { decim: 32, agg: 1, uartEvDrop: 9 });
  assert.equal(st.netState, 2);
  assert.equal(st.expCap, 0x1710);                       // sccb 集成：EXP_CAP 读回（BE 0x17 0x10）
  assert.equal(st.serialBaud, 921600);                   // 0x91 档位码 3 ⇒ 921600 baud
});

test("host小修③ 心跳/状态插发 CTRL_LEN=25（全包 57 B）：0x8F 尾追 + 0x88 单条拆读", () => {
  const tlv = concatU8(
    v3Tlv(0x81, Uint8Array.of(0)),          // MODE(3)
    v3Tlv(0x86, Uint8Array.of(0)),          // TS_FLAGS(3)
    v3Tlv(0x88, Uint8Array.of(0, 1, 0, 2)), // DROP 单条 len4(6)
    v3Tlv(0x87, Uint8Array.of(0, 9)),       // FRAME_IDX(4)
    v3Tlv(0x89, Uint8Array.of(0, 0, 0, 3)), // BOOT_ID(6)
    v3Tlv(0x8f, Uint8Array.of(0)),          // NET_STATE(3) ← UART 扩展尾追
  );
  assert.equal(tlv.length, CTRL.LEN.HEARTBEAT);          // 25
  const pkt = buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlStatus: 0, ctrlSeq: 5, ctrlTlv: tlv });
  assert.equal(pkt.length, 24 + 6 + CTRL.LEN.HEARTBEAT + 2);   // 57
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.ctrlLen, 25);
  const st = interpretStatusTlvs(r.value.ctrlHeader?.tlv ?? []);
  assert.equal(st.mode, 0);
  assert.equal(st.dropPx, 1);
  assert.equal(st.dropEv, 2);
  assert.equal(st.bootId, 3);
  assert.equal(st.netState, CTRL.NET_STATE.DOWN);        // 拔网线场景
});

test("串口提速 B1 SET_PARAM ACK CTRL_LEN=26（全包 58 B）：0x8D/0x8E + 0x90 + 0x91 写后读回", () => {
  const tlv = concatU8(
    v3Tlv(0x81, Uint8Array.of(1)),          // MODE(3)
    v3Tlv(0x82, Uint8Array.of(0x00, 0x2c)), // THETA(4)
    v3Tlv(0x83, Uint8Array.of(0x01, 0xff)), // MIN_DL(4) 读回 511（钳位后的值）
    v3Tlv(0x8d, Uint8Array.of(1)),          // EV_RES_STATE(3)
    v3Tlv(0x8e, Uint8Array.of(7, 0, 4)),    // SER_STATE(5)
    v3Tlv(0x90, Uint8Array.of(0x02, 0xea)), // EXP_CAP_STATE(4) ← sccb 集成尾追（写后读回 746 = 0x02EA）
    v3Tlv(0x91, Uint8Array.of(2)),          // SER_BAUD_STATE(3) ← 串口提速尾追（读回 460800 = 档位 2）
  );
  assert.equal(tlv.length, CTRL.LEN.SET_PARAM_ACK);      // 26 = sccb 23 + 0x91(3)
  const pkt = buildV3({ ctrl: true, ctrlOpcode: 0x01, ctrlStatus: 0, ctrlSeq: 0x0022, ctrlTlv: tlv });
  assert.equal(pkt.length, 24 + 6 + CTRL.LEN.SET_PARAM_ACK + 2);   // 58
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const st = interpretStatusTlvs(r.value.ctrlHeader?.tlv ?? []);
  assert.equal(st.minDl, 511);
  assert.equal(st.evRes, 1);
  assert.deepEqual(st.serState, { decim: 7, agg: 0, uartEvDrop: 4 });
  assert.equal(st.expCap, 746);                          // 0x02EA 大端拆读 = 746 行
  assert.equal(st.serialBaud, 460800);                   // 0x91 档位码 2 ⇒ 460800 baud
});

test("host小修③ CTRL_LEN 无硬断言（前向兼容）：比登记表更长 + 携带不全的 0x91 仍按声明长度自洽解析", () => {
  const tlv = concatU8(boardGetStatusTlv(), v3Tlv(0x91, Uint8Array.of(0xde, 0xad)));
  const pkt = buildV3({ ctrl: true, ctrlOpcode: 0x04, ctrlStatus: 0, ctrlSeq: 1, ctrlTlv: tlv });
  const r = parseV3Packet(pkt, base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.ctrlHeader?.ctrlLen, 65 + 4);     // 65 + 未知 tag TLV(2+2)
  const st = interpretStatusTlvs(r.value.ctrlHeader?.tlv ?? []);
  assert.equal(st.evRes, 2);                             // 已知 tag 不受未知 tag 影响
  assert.equal(st.netState, 2);
  assert.equal(st.expCap, 0x1710);                       // 0x90 是已知 tag：仍然正常落位
  assert.equal(st.serialBaud, null);                     // 0x91 len≠1：携带不全，不许猜档位
  // 新 tag 已进已知集：0x83 + 只带 0x8F 的载荷不再被判成 REQ（splitSyncCtrl 的 ACK 分支）
  const ack83 = parseV3Packet(buildV3({
    ctrl: true, ctrlOpcode: CTRL.OPCODE.TIME_SYNC_REQ, ctrlStatus: 0, ctrlSeq: 2,
    ctrlTlv: v3Tlv(0x8f, Uint8Array.of(1)),
  }), base);
  assert.equal(ack83.ok, true);
  if (!ack83.ok) return;
  assert.equal(ack83.value.warnings.includes("ctrlReq"), false);
  assert.equal(ack83.value.ctrlHeader?.tlv.length, 1);
});

// ————————————————————————————————————————————————————————————————————————————
// sccb 集成对齐（2026-10-13）：tag 0x0B EXP_CAP + TLV 0x90 + CTRL_LEN 23/65 两代帧
// 依据：sccb 集成报告 §9（上位机对齐契约，板端已实现并由 tb_downlink_cmd 断言）
// ————————————————————————————————————————————————————————————————————————————

test("sccb① + 串口提速 B1 常量登记：tag 0x0B/0x0C、TLV 0x90/0x91、CTRL_LEN 26·68（心跳 25 不动）、4 档映射", () => {
  assert.equal(DOWNLINK.TAG.EXP_CAP, 0x0b);
  assert.equal(CTRL.TLV.EXP_CAP_STATE, 0x90);
  assert.deepEqual([EXP_CAP_LIMITS.MIN, EXP_CAP_LIMITS.MAX], [4, 5904]);
  assert.equal(DOWNLINK.TAG.SER_BAUD, 0x0c);
  assert.equal(CTRL.TLV.SER_BAUD_STATE, 0x91);
  assert.deepEqual(Array.from(SERIAL_BAUD_RATES), [115200, 230400, 460800, 921600]);
  assert.deepEqual(SERIAL_BAUD_RATES.map((b) => serialBaudCode(b)), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map((c) => serialBaudOfCode(c)), [115200, 230400, 460800, 921600]);
  assert.equal(serialBaudCode(400000), null);            // 只认 4 档，绝不静默取默认
  assert.equal(serialBaudOfCode(4), null);
  assert.equal(CTRL.LEN.SET_PARAM_ACK, 26);
  assert.equal(CTRL.LEN.GET_STATUS_ACK, 68);
  assert.equal(CTRL.LEN.HEARTBEAT, 25);                  // 心跳不追 0x90/0x91（报告 §9.3 明列）
});

test("串口提速 B1 四档 0x0C 编码逐字节 + 非法档拒绝 + BAD_VALUE/未知 tag 容忍", () => {
  for (const [code, baud] of SERIAL_BAUD_RATES.entries()) {
    const tlvs = parseTlvs(buildSetParamPayload({ serialBaud: baud }));
    assert.equal(tlvs.length, 1);
    assert.equal(tlvs[0]!.tag, DOWNLINK.TAG.SER_BAUD);
    assert.deepEqual(Array.from(tlvs[0]!.value), [code]);   // 线上只传 1 B 档位码
  }
  assert.throws(() => buildSetParamPayload({ serialBaud: 400000 }), /串口波特率必须是 115200 \/ 230400 \/ 460800 \/ 921600 之一/);
  // 板端旧位流：STATUS=0x04 BAD_VALUE、0x91 仍回旧档（这里 0）：解析不得抛，也不得把"请求值"当真值
  const bad = buildV3({
    ctrl: true, ctrlOpcode: CTRL.OPCODE.SET_PARAM, ctrlStatus: DOWNLINK.STATUS.BAD_VALUE, ctrlSeq: 3,
    ctrlTlv: concatU8(v3Tlv(0x91, Uint8Array.of(0)), v3Tlv(0x92, Uint8Array.of(1, 2))),
  });
  const rb = parseV3Packet(bad, base);
  assert.equal(rb.ok, true);
  if (!rb.ok) return;
  assert.equal(rb.value.ctrlHeader?.status, DOWNLINK.STATUS.BAD_VALUE);
  const st = interpretStatusTlvs(rb.value.ctrlHeader?.tlv ?? []);
  assert.equal(st.serialBaud, 115200);                   // 读回旧档，不是请求的 921600
});

test("sccb② tag 0x0B 编码：746 → 0x02EA（BE）；600 在值域内原样通过（不得照抄 MIN_DL 的 600→511）", () => {
  const tlvs = parseTlvs(buildSetParamPayload({ expCap: 746 }));
  assert.equal(tlvs.length, 1);
  assert.equal(tlvs[0]!.tag, 0x0b);
  assert.deepEqual(Array.from(tlvs[0]!.value), [0x02, 0xea]);       // 746 = 0x02EA，大端
  // 报告 §9.1 示例：payload 十六进制 `0B 02 02 EA` = EXP_CAP=746 ⇒ 上面这条就是逐字节钉住它
  // 600 在 4..5904 内 ⇒ **原样** 0x0258（与 MIN_DL 的 600→511 不是同一值域，防照抄那条例子的误钳位）
  const inRange = parseTlvs(buildSetParamPayload({ expCap: 600 }));
  assert.deepEqual(Array.from(inRange[0]!.value), [0x02, 0x58]);
  // 边界 4 / 5904（= 0x1710 厂家基线原上限）都接受且不改动
  assert.deepEqual(Array.from(parseTlvs(buildSetParamPayload({ expCap: 4 }))[0]!.value), [0x00, 0x04]);
  assert.deepEqual(Array.from(parseTlvs(buildSetParamPayload({ expCap: 5904 }))[0]!.value), [0x17, 0x10]);
  // 与既有 tag 同包混发：顺序 = 参数表声明顺序（板端顺序无关，仅钉住字节不漂）
  const mixed = parseTlvs(buildSetParamPayload({ theta: 44, expCap: 746, evRes: 1 }));
  assert.deepEqual(mixed.map((t) => t.tag), [0x01, 0x07, 0x0b]);
});

test("sccb② tag 0x0B 钳位：3→4 / 5905→5904 / 负值→4 / NaN→4 / 小数取整；越界绝不原样发出", () => {
  assert.equal(clampExpCap(3), 4);
  assert.equal(clampExpCap(0), 4);
  assert.equal(clampExpCap(-1), 4);
  assert.equal(clampExpCap(-65535), 4);
  assert.equal(clampExpCap(5905), 5904);
  assert.equal(clampExpCap(99999), 5904);
  assert.equal(clampExpCap(Number.NaN), 4);
  assert.equal(clampExpCap(Number.POSITIVE_INFINITY), 4);   // 非有限值 → 下界（与 clampMinDl 同口径）
  assert.equal(clampExpCap(596.7), 597);
  // 编码侧同一钳位：越界值绝不会以原样字节发出（否则会被板端 BAD_VALUE 连坐整条命令）
  assert.deepEqual(Array.from(parseTlvs(buildSetParamPayload({ expCap: 99999 }))[0]!.value), [0x17, 0x10]);
  // 同包其它合法 tag 不被连坐：θ 原样、expCap 已钳位、整帧仍是合法 v3 下行包（10 + 4 + 2）
  const mixed = parseTlvs(buildSetParamPayload({ theta: 44, expCap: -5 }));
  assert.deepEqual([mixed[0]!.tag, Array.from(mixed[0]!.value)], [0x01, [0x00, 0x2c]]);
  assert.deepEqual([mixed[1]!.tag, Array.from(mixed[1]!.value)], [0x0b, [0x00, 0x04]]);
  assert.equal(encodeDownlink(DOWNLINK.OPCODE.SET_PARAM, 1, buildSetParamPayload({ expCap: 746 })).length, 16);
});

test("sccb③ TLV 0x90 解释：len2 BE 拆读；len<2 判为携带不全 → null；未携带 → null", () => {
  assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x90, Uint8Array.of(0x17, 0x10)))).expCap, 0x1710);
  assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x90, Uint8Array.of(0x02, 0xea)))).expCap, 746);
  assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x90, Uint8Array.of(0x02)))).expCap, null);   // len1：不半解释出错误值
  assert.equal(interpretStatusTlvs(parseTlvs(v3Tlv(0x90, new Uint8Array(0)))).expCap, null);
  assert.equal(interpretStatusTlvs(parseTlvs(new Uint8Array(0))).expCap, null);                   // 旧固件/心跳子集
  // 与其它 tag 混排：解析顺序无关
  const st = interpretStatusTlvs(parseTlvs(concatU8(v3Tlv(0x8d, Uint8Array.of(1)), v3Tlv(0x90, Uint8Array.of(0x02, 0xea)))));
  assert.equal(st.evRes, 1);
  assert.equal(st.expCap, 746);
});

test("sccb④ + 串口提速：三代帧都解析（新 26/68 带 0x91、sccb 23/65 带 0x90、旧 19/61 两者皆无）", () => {
  // sccb 固件 SET_PARAM ACK：23 = 19 + 0x90(4)
  const midSetParam = concatU8(
    v3Tlv(0x81, Uint8Array.of(1)),
    v3Tlv(0x82, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(0x83, Uint8Array.of(0x01, 0xff)),
    v3Tlv(0x8d, Uint8Array.of(1)),
    v3Tlv(0x8e, Uint8Array.of(7, 0, 4)),
    v3Tlv(0x90, Uint8Array.of(0x02, 0xea)),
  );
  // 串口提速固件 SET_PARAM ACK：26 = 23 + 0x91(3)
  const newSetParam = concatU8(midSetParam, v3Tlv(0x91, Uint8Array.of(3)));
  // 旧固件 SET_PARAM ACK：19（= 2026-10-12 已烧录形态，无 0x90）
  const oldSetParam = concatU8(
    v3Tlv(0x81, Uint8Array.of(1)),
    v3Tlv(0x82, Uint8Array.of(0x00, 0x2c)),
    v3Tlv(0x83, Uint8Array.of(0x01, 0xff)),
    v3Tlv(0x8d, Uint8Array.of(1)),
    v3Tlv(0x8e, Uint8Array.of(7, 0, 4)),
  );
  assert.equal(newSetParam.length, CTRL.LEN.SET_PARAM_ACK);   // 26
  assert.equal(midSetParam.length, 23);                       // 旧登记值仍可解析
  assert.equal(oldSetParam.length, 19);
  const rNew = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x01, ctrlSeq: 7, ctrlTlv: newSetParam }), base);
  const rMid = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x01, ctrlSeq: 7, ctrlTlv: midSetParam }), base);
  const rOld = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x01, ctrlSeq: 7, ctrlTlv: oldSetParam }), base);
  assert.equal(rNew.ok, true);
  assert.equal(rMid.ok, true);
  assert.equal(rOld.ok, true);
  if (!rNew.ok || !rMid.ok || !rOld.ok) return;
  assert.equal(interpretStatusTlvs(rNew.value.ctrlHeader?.tlv ?? []).expCap, 746);
  assert.equal(interpretStatusTlvs(rNew.value.ctrlHeader?.tlv ?? []).serialBaud, 921600);
  assert.equal(interpretStatusTlvs(rMid.value.ctrlHeader?.tlv ?? []).expCap, 746);
  assert.equal(interpretStatusTlvs(rMid.value.ctrlHeader?.tlv ?? []).serialBaud, null);   // sccb 无 0x91
  assert.equal(interpretStatusTlvs(rOld.value.ctrlHeader?.tlv ?? []).expCap, null);       // 旧固件：未上报，不能猜
  // GET_STATUS：新 68（100 B）/ sccb 65（97 B）/ 旧 61（93 B，前 61 B 与旧固件逐字节相同）
  const newGs = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x04, ctrlSeq: 8, ctrlTlv: boardGetStatusTlvNew() }), base);
  const midGs = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x04, ctrlSeq: 8, ctrlTlv: boardGetStatusTlv() }), base);
  const oldGs = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: 0x04, ctrlSeq: 8, ctrlTlv: boardGetStatusTlv().subarray(0, 61) }), base);
  assert.equal(newGs.ok, true);
  assert.equal(midGs.ok, true);
  assert.equal(oldGs.ok, true);
  if (!newGs.ok || !midGs.ok || !oldGs.ok) return;
  assert.equal(interpretStatusTlvs(newGs.value.ctrlHeader?.tlv ?? []).expCap, 0x1710);
  assert.equal(interpretStatusTlvs(newGs.value.ctrlHeader?.tlv ?? []).serialBaud, 921600);
  assert.equal(interpretStatusTlvs(midGs.value.ctrlHeader?.tlv ?? []).expCap, 0x1710);
  assert.equal(interpretStatusTlvs(midGs.value.ctrlHeader?.tlv ?? []).serialBaud, null);
  assert.equal(interpretStatusTlvs(oldGs.value.ctrlHeader?.tlv ?? []).expCap, null);
  // 心跳 57 B（CTRL_LEN=25）两代同形：本就不含 0x90 ⇒ 解析不受任何影响
  const hb = concatU8(
    v3Tlv(0x81, Uint8Array.of(0)),
    v3Tlv(0x86, Uint8Array.of(0)),
    v3Tlv(0x88, Uint8Array.of(0, 1, 0, 2)),
    v3Tlv(0x87, Uint8Array.of(0, 9)),
    v3Tlv(0x89, Uint8Array.of(0, 0, 0, 3)),
    v3Tlv(0x8f, Uint8Array.of(1)),
  );
  assert.equal(hb.length, CTRL.LEN.HEARTBEAT);           // 25
  const rHb = parseV3Packet(buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT, ctrlSeq: 9, ctrlTlv: hb }), base);
  assert.equal(rHb.ok, true);
  if (!rHb.ok) return;
  assert.equal(interpretStatusTlvs(rHb.value.ctrlHeader?.tlv ?? []).expCap, null);    // 心跳不含 0x90（报告 §9.3）
});
