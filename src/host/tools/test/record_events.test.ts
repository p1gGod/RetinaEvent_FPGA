// record_events.mjs 的单元测试（标准库 node:test，无第三方依赖）
//
// 覆盖：
//  1) 合成 v3 上行包（含事件段 + RAW 段）→ 解析 → CSV **逐字节**等于期望文本；
//     同一批帧同时喂给 web/src/export/csv.ts 的 buildEventsCsv，验证列格式与权威实现一致（含 CRLF）。
//  2) 参数解析（默认值/自定义/非法值/--help）。
//  3) 坏包、控制包、CRC 错、非 v3 魔数一律不计入 CSV。
//  4) 坐标/极性过滤与单调时间轴。
//  5) runRecord 写盘闭环（注入假 socket，验证表头+行数+字节数+退出码，不碰真 UDP/不占 1234）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeEvents, crc16 } from "@retina/protocol";
import { buildEventsCsv as webBuildEventsCsv } from "../../web/src/export/csv.ts";

const MOD_URL = new URL("../record_events.mjs", import.meta.url).href;
type RecMod = {
  HEADER: string;
  CRLF: string;
  parseRecordArgs: (argv: string[]) => any;
  buildEventsCsv: (frames: any[]) => string;
  decodeUplinkPacket: (buf: Uint8Array, profile: any, arrivalMs?: number) => any;
  filterValidRecords: (records: any[]) => { kept: any[]; dropped: number };
  advanceFrameTime: (state: { lastTMs: number }, t: number) => number;
  runRecord: (opts: any, deps?: any) => Promise<any>;
  eventRow: (frameIdx: number, tMs: number, ev: any) => string;
};
let mod: RecMod;
test("载入被测模块（动态 import，规避 TS 对 .mjs 的类型解析）", async () => {
  mod = (await import(MOD_URL)) as RecMod;
  assert.equal(mod.HEADER, "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts");
  assert.equal(mod.CRLF, "\r\n");
});

/** 造一个 v3 上行包（24 B 头 + RAW + EV + 可选 CRC16） */
function v3Packet(opts: {
  frameIdx: number;
  tsUs?: number;
  tsValid?: boolean;
  events?: { x: number; y: number; pol: 0 | 1; flags?: number; ts?: number }[];
  eventsRaw?: Uint8Array;
  raw?: Uint8Array;
  crc?: boolean;
  ctrl?: boolean;
}): Uint8Array {
  const evRec = 5;
  const evs = (opts.events ?? []).map((e) => ({ x: e.x, y: e.y, pol: e.pol, flags: e.flags ?? 0, ts: e.ts ?? 0 }));
  const evBytes = opts.eventsRaw ?? encodeEvents(evs, evRec);
  const raw = opts.raw ?? new Uint8Array(0);
  const tsUs = opts.tsUs ?? 0;
  const tsValid = opts.tsValid ?? true;
  let flags = 0;
  if (raw.length > 0) flags |= 1;
  if (evBytes.length > 0) flags |= 2;
  if (opts.crc === true) flags |= 4;
  if (tsValid) flags |= 8;
  if (tsValid) flags |= 16;
  if (opts.ctrl === true) flags |= 128;
  const hdr = new Uint8Array(24);
  hdr.set([0xf0, 0x5a, 0xa5, 0x30], 0);
  hdr[4] = 3;
  hdr[5] = 24;
  hdr[6] = flags;
  hdr[7] = raw.length > 0 ? 0 : 2; // RAW_EV=0 / EV_ONLY=2
  const dv = new DataView(hdr.buffer);
  dv.setUint16(8, 0, false);
  dv.setUint16(10, opts.frameIdx & 0xffff, false);
  dv.setUint16(12, raw.length, false);
  dv.setUint16(14, evBytes.length, false);
  const v = tsUs;
  hdr[16] = Math.floor(v / 2 ** 40) & 0xff;
  hdr[17] = Math.floor(v / 2 ** 32) & 0xff;
  hdr[18] = Math.floor(v / 2 ** 24) & 0xff;
  hdr[19] = Math.floor(v / 2 ** 16) & 0xff;
  hdr[20] = Math.floor(v / 2 ** 8) & 0xff;
  hdr[21] = v & 0xff;
  hdr[22] = evRec;
  // CTRL 包：24 B 头之后还有 6 B 控制头（opcode/status/seq/ctrlLen），否则解析器读越界
  const ctrlBody = opts.ctrl === true ? new Uint8Array(6) : new Uint8Array(0);
  const body = new Uint8Array(raw.length + evBytes.length + ctrlBody.length);
  body.set(raw, 0);
  body.set(evBytes, raw.length);
  body.set(ctrlBody, raw.length + evBytes.length);
  const out = new Uint8Array(24 + body.length + (opts.crc === true ? 2 : 0));
  out.set(hdr, 0);
  out.set(body, 24);
  if (opts.crc === true) {
    const c = crc16(out.subarray(0, 24 + body.length));
    out[24 + body.length] = (c >> 8) & 0xff;
    out[24 + body.length + 1] = c & 0xff;
  }
  return out;
}

const PROFILE = { name: "test", evRecBytes: 5, evGrid: { w: 400, h: 240 }, frameDecim: 1, rawChunk: 1280, chunksPerFrame: 600, wire: "STREAM", magic: "F05AA50F", frame: { w: 800, h: 480, bytes: 768000, pixel: "RGB565_BE" }, crc16: "auto", udp: { bind: "192.168.1.102", port: 1234, board: "192.168.1.10", boardPort: 1234 } };

test("合成 v3 包 → CSV 逐字节等于期望（含 RAW 段包）", async () => {
  const mod2 = (await import(MOD_URL)) as RecMod;
  const p1 = v3Packet({ frameIdx: 7, tsUs: 100_500, events: [{ x: 1, y: 2, pol: 1, ts: 255 }, { x: 399, y: 239, pol: 0, ts: 0 }] });
  const p2 = v3Packet({ frameIdx: 9, tsUs: 120_999, raw: new Uint8Array([0xaa, 0xbb, 0xcc]), events: [{ x: 8, y: 8, pol: 1, flags: 2, ts: 3 }] });
  const d1 = mod2.decodeUplinkPacket(p1, PROFILE, 0);
  const d2 = mod2.decodeUplinkPacket(p2, PROFILE, 0);
  assert.equal(d1.tMs, 100);
  assert.equal(d2.tMs, 120);
  const frames = [{ frameIdx: d1.frameIdx, tMs: d1.tMs, events: d1.records }, { frameIdx: d2.frameIdx, tMs: d2.tMs, events: d2.records }];
  const csv = mod2.buildEventsCsv(frames);
  const expected = "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts\r\n" +
    "7,100,1,2,1,ON,0,255\r\n" +
    "7,100,399,239,0,OFF,0,0\r\n" +
    "9,120,8,8,1,ON,0,3\r\n";
  assert.equal(csv, expected);
  // 与 web 导出权威实现逐字节一致（唯一权威 host/app/web/src/export/csv.ts）
  const web = webBuildEventsCsv(frames as unknown as Parameters<typeof webBuildEventsCsv>[0]);
  assert.equal(csv, web);
  // flags 是记录里的保留位：b1.bit1..7 → flags。手搓一条 {x=266,flags=4,pol=1,ts=9} 验证原样带出
  const flagged = v3Packet({ frameIdx: 11, tsUs: 130_000, eventsRaw: new Uint8Array([10, 0x05, 20, 1, 9]) });
  const d3 = mod2.decodeUplinkPacket(flagged, PROFILE, 0);
  assert.equal(d3.records.length, 1);
  assert.deepEqual(
    { x: d3.records[0].x, y: d3.records[0].y, pol: d3.records[0].pol, flags: d3.records[0].flags, ts: d3.records[0].ts },
    { x: 266, y: 20, pol: 1, flags: 4, ts: 9 },
  );
  assert.equal(mod2.buildEventsCsv([{ frameIdx: 11, tMs: 130, events: d3.records }]), "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts\r\n11,130,266,20,1,ON,4,9\r\n");
  // 没有事件时也必须只有表头（与 web 一致）
  assert.equal(mod2.buildEventsCsv([]), mod2.HEADER + mod2.CRLF);
  assert.equal(mod2.buildEventsCsv([]), webBuildEventsCsv([]));
});

test("坏包/控制包/CRC 错/非 v3 → 不进 CSV", async () => {
  const mod2 = (await import(MOD_URL)) as RecMod;
  const good = v3Packet({ frameIdx: 1, tsUs: 1000, events: [{ x: 3, y: 3, pol: 0 }] });
  assert.notEqual(mod2.decodeUplinkPacket(good, PROFILE, 0), null);
  // 非 v3 魔数
  assert.equal(mod2.decodeUplinkPacket(new Uint8Array([1, 2, 3, 4, 5]), PROFILE, 0), null);
  // 截断
  const trunc = mod2.decodeUplinkPacket(good.subarray(0, 10), PROFILE, 0);
  assert.equal(trunc.error, "truncated");
  // CRC 错（构建正确 CRC 后翻转末字节）
  const withCrc = v3Packet({ frameIdx: 2, tsUs: 2000, events: [{ x: 4, y: 4, pol: 1 }], crc: true });
  withCrc[withCrc.length - 1] = (withCrc[withCrc.length - 1] as number) ^ 0xff;
  const badCrc = mod2.decodeUplinkPacket(withCrc, PROFILE, 0);
  assert.equal(badCrc.error, "crcFail");
  // 控制包（CTRL 位）→ null
  const ctrl = v3Packet({ frameIdx: 3, ctrl: true });
  assert.equal(mod2.decodeUplinkPacket(ctrl, PROFILE, 0), null);
  // TS_VALID=0 → 用到达时刻
  const noTs = v3Packet({ frameIdx: 4, tsUs: 999_000, tsValid: false, events: [{ x: 5, y: 5, pol: 1 }] });
  assert.equal(mod2.decodeUplinkPacket(noTs, PROFILE, 4321).tMs, 4321);
});

test("参数解析：默认值 / 自定义 / 非法值 / --help", async () => {
  const mod2 = (await import(MOD_URL)) as RecMod;
  const d = mod2.parseRecordArgs(["--out", "a.csv"]);
  assert.equal(d.bind, "192.168.1.102");
  assert.equal(d.port, 1234);
  assert.equal(d.seconds, 10);
  assert.equal(d.out, "a.csv");
  const c = mod2.parseRecordArgs(["--out", "b.csv", "--seconds", "5", "--bind", "127.0.0.1", "--port", "12401"]);
  assert.equal(c.seconds, 5);
  assert.equal(c.bind, "127.0.0.1");
  assert.equal(c.port, 12401);
  assert.equal(mod2.parseRecordArgs(["--help"]).help, true);
  const bad: string[][] = [
    ["--seconds", "5"],                              // 缺 --out
    ["--out", "c.csv", "--seconds", "0"],            // 0 秒
    ["--out", "c.csv", "--port", "70000"],           // 端口越界
    ["--out", "c.csv", "--port", "12.5"],            // 非整数端口
    ["--out", "c.csv", "--bind", "not-an-ip"],       // 非 IPv4
    ["--out", "c.csv", "--profile", "no-such"],      // 未知 profile
  ];
  for (const argv of bad) {
    assert.throws(() => mod2.parseRecordArgs(argv), /参数|profile/i, JSON.stringify(argv));
  }
});

test("坐标/极性过滤与单调时间轴", async () => {
  const mod2 = (await import(MOD_URL)) as RecMod;
  const r = mod2.filterValidRecords([
    { x: 0, y: 0, pol: 0, flags: 0, ts: 0 },
    { x: 399, y: 239, pol: 1, flags: 0, ts: 0 },
    { x: 400, y: 10, pol: 1, flags: 0, ts: 0 },
    { x: 10, y: 240, pol: 1, flags: 0, ts: 0 },
    { x: 10, y: 10, pol: 2, flags: 0, ts: 0 },
  ]);
  assert.equal(r.kept.length, 2);
  assert.equal(r.dropped, 3);
  const st = { lastTMs: 0 };
  assert.equal(mod2.advanceFrameTime(st, 100), 100);
  assert.equal(mod2.advanceFrameTime(st, 90), 100);   // 回退被夹住
  assert.equal(mod2.advanceFrameTime(st, 150), 150);
});

test("runRecord 写盘闭环（注入假 socket，不占真实端口）", async () => {
  const mod2 = (await import(MOD_URL)) as RecMod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  const out = path.join(dir, "out.csv");
  const p1 = v3Packet({ frameIdx: 7, tsUs: 100_500, events: [{ x: 1, y: 2, pol: 1, ts: 255 }, { x: 399, y: 239, pol: 0 }] });
  const p2 = v3Packet({ frameIdx: 9, tsUs: 120_999, events: [{ x: 8, y: 8, pol: 1, ts: 3 }] });
  const handlers = new Map<string, ((...a: any[]) => void)[]>();
  const fake = {
    on(ev: string, cb: (...a: any[]) => void) { const a = handlers.get(ev) ?? []; a.push(cb); handlers.set(ev, a); return fake; },
    bind(port: number, addr: string) {
      (fake as any).port = port; (fake as any).addr = addr;
      setImmediate(() => {
        for (const cb of handlers.get("listening") ?? []) cb();
        for (const cb of handlers.get("message") ?? []) cb(Buffer.from(p1), {});
        for (const cb of handlers.get("message") ?? []) cb(Buffer.from(p2), {});
      });
    },
    address() { return { address: (fake as any).addr, port: (fake as any).port }; },
    close(cb?: () => void) { if (cb) setImmediate(cb); },
  };
  const opts = { bind: "127.0.0.1", port: 12499, seconds: 0.05, out, profile: PROFILE, idleMs: 40 };
  const r = await mod2.runRecord(opts, { socketFactory: () => fake, log: () => {}, errLog: () => {} });
  assert.equal(r.exitCode, 0);
  assert.equal(r.rows, 3);
  assert.equal(r.packets, 2);
  const text = fs.readFileSync(out, "utf8");
  assert.equal(text, "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts\r\n" +
    "7,100,1,2,1,ON,0,255\r\n7,100,399,239,0,OFF,0,0\r\n9,120,8,8,1,ON,0,3\r\n");
  assert.equal(fs.statSync(out).size, r.bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});
