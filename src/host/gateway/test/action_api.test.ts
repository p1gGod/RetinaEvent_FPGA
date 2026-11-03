// 动作回传（契约 05 §4）网关侧回归：
//   · ActionStore：快照/事件语义（valid=false 不产事件、类别变化才算、环 64、dropped）
//   · /api/action、/api/action/events、/api/action/config 三接口的三态与错误码
//
// 为什么直接调 handleApi + 假 res：网关的 API 层是纯函数 + LatestStore，不需要起真 socket
// 就能钉死状态码/字段/文案；真实 HTTP（UDP 注入 → curl）另见 EVIDENCE_API.log 的端到端脚本。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CTRL,
  OFF3,
  createCounters,
  decodeActionState,
  getProfile,
  parseV3Packet,
} from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import {
  ACTION_EVENT_RING,
  ActionStore,
  DEFAULT_ACTION_CONFIG,
  actionRawOfPacket,
  actionStore,
  hasActionStateTlv,
  normalizeActionConfig,
} from "../src/action.ts";
import { ENDPOINTS, handleApi, type ApiContext } from "../src/ipc/api.ts";
import { IpcHub, type GatewayControl } from "../src/ipc/ws.ts";
import { LatestStore } from "../src/pipeline/latest.ts";
import { PacketProcessor } from "../src/pipeline/processor.ts";
import { SynthTransport } from "../src/transport/synth.ts";
import WebSocket from "ws";
import { buildV3, v3Tlv } from "../../packages/protocol/test/helpers.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;
const RAW = new Uint8Array(profile.frame.bytes);

/** 构造一个只依赖 LatestStore/ActionStore 的 ApiContext（其余字段与真实装配同形） */
function makeCtx(action?: ActionStore): { ctx: ApiContext; store: LatestStore; action?: ActionStore } {
  const store = new LatestStore();
  const ctx: ApiContext = {
    store,
    profile,
    getStats: () => ({ packets: 0, bytes: 0, bytesRaw: 0, bytesEvents: 0, pps: 0, bps: 0, lastFrameIdx: 0, wraps: 0, tNowMs: 0 }),
    getCounters: createCounters,
    getConfig: () => ({}),
    startedAtMs: 1_000_000,
    sourceInfo: { wire: profile.wire, profile: profile.name },
    uiUrl: null,
    ...(action === undefined ? {} : { action }),
  };
  return { ctx, store, ...(action === undefined ? {} : { action }) };
}

function putFrame(store: LatestStore, frameIdx = 1): void {
  store.setFrame(
    {
      frameIdx,
      seq: frameIdx,
      w: profile.frame.w,
      h: profile.frame.h,
      raw: RAW,
      pixel: "RGB565_BE",
      events: { records: [], dropped: 0, thinned: false },
      tArriveMs: 1500,
      synthetic: false,
    },
    1500,
  );
}

interface ApiReply {
  readonly code: number;
  readonly body: string;
  readonly type: string;
}

/** 假 res：把 writeHead/end 捕获成一个可 await 的回复（长轮询的异步 send 也覆盖） */
function callApi(ctx: ApiContext, path: string, method = "GET"): Promise<ApiReply> {
  return new Promise<ApiReply>((resolve) => {
    let code = 0;
    const headers: Record<string, string> = {};
    const res = {
      writeHead: (c: number, h?: Record<string, string | number>) => {
        code = c;
        if (h !== undefined) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
        return res;
      },
      setHeader: (k: string, v: unknown) => {
        headers[k.toLowerCase()] = String(v);
      },
      end: (b?: unknown) => {
        resolve({
          code,
          body: typeof b === "string" ? b : b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : String(b ?? ""),
          type: headers["content-type"] ?? "",
        });
      },
    } as unknown as ServerResponse;
    const req = { method } as IncomingMessage;
    const handled = handleApi(req, res, new URL("http://127.0.0.1" + path), ctx);
    assert.equal(handled, true, "已注册的 /api 路径必须被 handleApi 接住: " + path);
  });
}

async function getJson(ctx: ApiContext, path: string, method = "GET"): Promise<{ r: ApiReply; j: Record<string, unknown> }> {
  const r = await callApi(ctx, path, method);
  assert.match(r.type, /application\/json; charset=utf-8/, "JSON 接口的 Content-Type 口径（契约 §4.0）: " + path);
  return { r, j: JSON.parse(r.body) as Record<string, unknown> };
}

// ————————————————————————— ActionStore：快照 + 事件语义 —————————————————————————

test("ActionStore：valid=false 只更新快照不产事件；同类别不重复、类别变化才记一条", () => {
  const s = new ActionStore();
  assert.equal(s.getSnapshot(), null);
  assert.equal(s.hasSnapshot, false);

  s.observe(0x00, 1, 100);            // 未启用：valid=0 class=0
  assert.equal(s.hasSnapshot, true);
  assert.deepEqual(decodeActionState(0x00), { valid: false, conf: 0, cls: 0 });
  assert.equal(s.totalEvents, 0, "有效位=0 的包绝不能当一次动作事件（契约 §4.2）");

  s.observe(0x81, 2, 200);            // valid class1 conf0
  assert.equal(s.totalEvents, 1);
  s.observe(0x81, 3, 300);            // 同类别：不记
  assert.equal(s.totalEvents, 1, "同一类别持续只算一条（持续 10s 只执行一次靠前端，网关事件流同样不重复）");
  s.observe(0x82, 4, 400);            // 类别 1→2
  assert.equal(s.totalEvents, 2);
  s.observe(0x00, 5, 500);            // 退回无动作：不记
  assert.equal(s.totalEvents, 2, "valid=0 不产生事件");
  s.observe(0x81, 6, 600);            // 2→1
  assert.equal(s.totalEvents, 3);

  const snap = s.getSnapshot();
  assert.notEqual(snap, null);
  assert.equal(snap?.raw, 0x81);
  assert.equal(snap?.class, 1);
  assert.equal(snap?.className, "手部开合");
  assert.equal(snap?.frameIdx, 6);
  assert.equal(snap?.tArriveMs, 600);
  assert.deepEqual(snap?.mapped, { action: "startRecord", target: "raw" }, "class1 默认映射 = 开始录制→rawbin");
});

test("ActionStore：class3=保留类可记录事件但 mapped 恒为 null（不得执行映射）", () => {
  const s = new ActionStore();
  s.observe(0xff, 1, 10);
  assert.equal(s.totalEvents, 1);
  const snap = s.getSnapshot();
  assert.equal(snap?.valid, true);
  assert.equal(snap?.conf, 31);
  assert.equal(snap?.class, 3);
  assert.equal(snap?.className, "保留");
  assert.equal(snap?.mapped, null, "class3 是保留类，契约要求当无动作、不得执行任何映射");

  s.observe(0x80, 2, 20);             // valid=1 class=0
  assert.equal(s.getSnapshot()?.className, "无动作");
  assert.deepEqual(s.getSnapshot()?.mapped, { action: "none", target: "statsOnly" }, "class0 映射固定 none");
});

test("ActionStore：事件环 64 条、单页最多 32 条、dropped=最旧seq-1-after", async () => {
  const s = new ActionStore();
  const N = ACTION_EVENT_RING + 6;   // 70 条
  for (let i = 0; i < N; i++) s.observe(i % 2 === 0 ? 0x81 : 0x82, i + 1, i * 10);
  assert.equal(s.totalEvents, N);

  const page = await s.waitEvents(-1, 0);
  assert.equal(page.events.length, 1, "after=-1 只返回最新 1 条（契约 §4.2）");
  assert.equal(page.events[0]?.seq, N);
  assert.equal(page.lastSeq, N);

  const all = await s.waitEvents(0, 0);
  assert.equal(all.events.length, 32, "单次最多 32 条");
  assert.equal(all.events[0]?.seq, 7, "环满后最旧一条是 seq 7（70-64+1）");
  assert.equal(all.dropped, 6, "dropped = 最旧 seq - 1 - after = 7-1-0");

  const mid = await s.waitEvents(5, 0);
  assert.equal(mid.dropped, 1, "after=5 时漏了 seq6（7-1-5）");
  const exact = await s.waitEvents(6, 0);
  assert.equal(exact.dropped, 0, "after=最旧-1 时没有缺口");
  assert.equal(exact.events[0]?.seq, 7);
});

test("ActionStore：长轮询会被新事件唤醒；没有新事件按 timeout 返回 timedOut", async () => {
  const s = new ActionStore();
  s.observe(0x81, 1, 100);
  const pending = s.waitEvents(1, 800);
  setTimeout(() => s.observe(0x82, 2, 200), 30);
  const woke = await pending;
  assert.equal(woke.timedOut, false);
  assert.equal(woke.events.length, 1);
  assert.equal(woke.events[0]?.seq, 2);

  const t0 = Date.now();
  const to = await s.waitEvents(2, 40);
  assert.equal(to.timedOut, true);
  assert.equal(to.events.length, 0);
  assert.equal(to.lastSeq, 2, "超时页仍带 lastSeq，前端可继续用 after=lastSeq 重开");
  assert.ok(Date.now() - t0 >= 30, "超时必须真的等到 timeoutMs，不能提前返回");

  const zero = await s.waitEvents(2, 0);
  assert.equal(zero.timedOut, true, "timeoutMs=0 立即超时（用于纯查询）");
});

// ————————————————————————— 配置镜像 —————————————————————————

test("ActionStore：默认配置 source=default；setConfig 后 source=ui 且已缓存 mapped 立即重算", async () => {
  const s = new ActionStore();
  const def = s.getConfigView();
  assert.equal(def.source, "default");
  assert.equal(def.updatedAtMs, null, "从未收到前端配置时 updatedAtMs 必须是 null（契约 §4.3）");
  assert.deepEqual(def.config, DEFAULT_ACTION_CONFIG);

  s.observe(0x81, 1, 100);           // class1 先按默认映射
  assert.deepEqual(s.getSnapshot()?.mapped, { action: "startRecord", target: "raw" });

  const cfg = s.setConfig(
    { v: 1, minConf: 12, map: { "1": { action: "startAndAutoExport", target: "overlay" } } },
    1_700_000_000_000,
  );
  assert.equal(cfg.minConf, 12);
  assert.deepEqual(cfg.map["1"], { action: "startAndAutoExport", target: "overlay" });
  assert.deepEqual(cfg.map["0"], { action: "none", target: "statsOnly" }, "缺键补默认");
  assert.deepEqual(cfg.map["2"], { action: "stopRecord", target: "raw" });

  const view = s.getConfigView();
  assert.equal(view.source, "ui");
  assert.equal(view.updatedAtMs, 1_700_000_000_000);
  assert.deepEqual(s.getSnapshot()?.mapped, { action: "startAndAutoExport", target: "overlay" }, "改映射后快照 mapped 必须立刻跟着变");

  const pg = await s.waitEvents(-1, 0);
  assert.deepEqual(pg.events[0]?.mapped, { action: "startAndAutoExport", target: "overlay" }, "历史事件的 mapped 也按新映射重算");
});

test("normalizeActionConfig：非法配置必须抛错（不静默修正），缺键补默认", () => {
  const bad: readonly [unknown, RegExp][] = [
    [null, /必须是对象/],
    [{ minConf: 8 }, /v 必须是 1/],
    [{ v: 2 }, /v 必须是 1/],
    [{ v: 1, minConf: 32 }, /minConf 必须是 0\.\.31/],
    [{ v: 1, minConf: 1.5 }, /minConf 必须是 0\.\.31/],
    [{ v: 1, map: [] }, /map 必须是对象/],
    [{ v: 1, map: { "3": { action: "none", target: "raw" } } }, /不允许的类别键: 3/],
    [{ v: 1, map: { "1": 5 } }, /必须是 \{action,target\}/],
    [{ v: 1, map: { "1": { action: "record", target: "raw" } } }, /action 非法: record/],
    [{ v: 1, map: { "1": { action: "startRecord", target: "jpg" } } }, /target 非法: jpg/],
    [{ v: 1, map: { "0": { action: "startRecord", target: "raw" } } }, /map\.0\.action 必须是 none/],
  ];
  for (const [input, re] of bad) assert.throws(() => normalizeActionConfig(input, 1), re);

  const ok = normalizeActionConfig({ v: 1 }, 123);
  assert.equal(ok.minConf, 8);
  assert.equal(ok.updatedAtMs, 123);
  assert.deepEqual(ok.map["0"], { action: "none", target: "statsOnly" });
  assert.ok(Object.isFrozen(ok.map), "返回的 map 必须冻结，防止调用方意外改掉共享默认值");
});

// ————————————————————————— 取字节：byte23 / TLV 0x92 —————————————————————————

test("actionRawOfPacket：默认读 byte23；CTRL 的 TLV 0x92(len=1) 优先；len≠1 回退 byte23", () => {
  const data = buildV3({ raw: new Uint8Array(profile.rawChunk), rsvd: 0x85 });
  const p1 = parseV3Packet(data, { profile });
  assert.equal(p1.ok, true);
  if (p1.ok) assert.equal(actionRawOfPacket(data, p1.value), 0x85, "普通数据包读 OFF3.ACTION（byte23）");
  assert.equal(OFF3.ACTION, 23);

  const ctrlTlv = v3Tlv(CTRL.TLV.ACTION_STATE, Uint8Array.of(0x82));
  const ctrl = buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.GET_STATUS, ctrlStatus: 0, rsvd: 0x85, ctrlTlv });
  const p2 = parseV3Packet(ctrl, { profile });
  assert.equal(p2.ok, true);
  if (p2.ok) assert.equal(actionRawOfPacket(ctrl, p2.value), 0x82, "GET_STATUS ACK 的 TLV 0x92 是显式快照真值，优先于 byte23");

  const badLen = v3Tlv(CTRL.TLV.ACTION_STATE, new Uint8Array(2));
  const ctrl2 = buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.GET_STATUS, ctrlStatus: 0, rsvd: 0x85, ctrlTlv: badLen });
  const p3 = parseV3Packet(ctrl2, { profile });
  assert.equal(p3.ok, true, "TLV 长度不对也不能丢整包（契约 §3）");
  if (p3.ok) assert.equal(actionRawOfPacket(ctrl2, p3.value), 0x85, "非法 TLV 被忽略后回退 byte23");
});

// ————————————————————————— CTRL 包过滤（M4g） —————————————————————————
//
// downlink_cmd.v 的 pkt_byte() 里 byte23 落 default = 0x00：心跳（0xF0，1 Hz）与除
// GET_STATUS 外的所有 ACK 头里 byte23 都是 0。processor 若对每个 v3 包都 observe()，
// 心跳会把 prevValid 打回 false，下一条 0xFD 数据包又记一次 valid_rise ⇒ 检测次数被
// 1 Hz 心跳系统性放大。下面用真 PacketProcessor 走完整解析路径钉死这个行为。

function v3Data(frameIdx: number, rsvd: number): Uint8Array {
  return buildV3({ raw: new Uint8Array(profile.rawChunk), frameIdx, rsvd, tsUs: 1_000_000 + frameIdx });
}

function v3Heartbeat(seq: number): Uint8Array {
  return buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.STATUS_HEARTBEAT,
    ctrlStatus: 0,
    ctrlSeq: seq,
    frameIdx: 9000 + seq,
    rsvd: 0x00,
    tsUs: 2_000_000 + seq,
  });
}

function makeProcessor(): PacketProcessor {
  return new PacketProcessor({ profile, counters: createCounters() });
}

test("processor：无 TLV 0x92 的 CTRL 心跳不喂 observe（两条数据包夹心跳，count/快照不变）", (t) => {
  actionStore.reset();
  t.after(() => actionStore.reset());
  const proc = makeProcessor();
  proc.pushRawPayload(v3Data(10, 0xfd), 1000);
  assert.equal(actionStore.getCount(), 1);
  assert.equal(actionStore.getSnapshot()?.frameIdx, 10);

  proc.pushRawPayload(v3Heartbeat(0), 1500);
  assert.equal(actionStore.getCount(), 1, "心跳 byte23=0 不能被当成「无动作」而清掉 prevValid");
  assert.equal(actionStore.getSnapshot()?.frameIdx, 10, "心跳也不应覆盖动作快照");
  assert.equal(actionStore.totalEvents, 1);

  proc.pushRawPayload(v3Data(11, 0xfd), 2000);
  assert.equal(actionStore.getCount(), 1, "同类别数据包不产生 valid_rise");
  assert.equal(actionStore.getSnapshot()?.frameIdx, 11, "普通数据包仍然每包更新快照");
});

test("processor：带 TLV 0x92 的 GET_STATUS ACK 仍更新快照并计数", (t) => {
  actionStore.reset();
  t.after(() => actionStore.reset());
  const proc = makeProcessor();
  proc.pushRawPayload(v3Data(10, 0x81), 1000);
  assert.equal(actionStore.getCount(), 1);
  assert.equal(actionStore.getSnapshot()?.class, 1);

  const tlv = v3Tlv(CTRL.TLV.ACTION_STATE, Uint8Array.of(0x82));
  const ctrl = buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.GET_STATUS,
    ctrlStatus: 0,
    ctrlSeq: 1,
    frameIdx: 11,
    rsvd: 0x81,
    ctrlTlv: tlv,
    tsUs: 2_000_000,
  });
  proc.pushRawPayload(ctrl, 2000);
  assert.equal(actionStore.getCount(), 2, "GET_STATUS ACK 的 TLV 0x92 是权威快照，类别 1→2 记一次 class_change");
  assert.equal(actionStore.getSnapshot()?.frameIdx, 11);
  assert.equal(actionStore.getSnapshot()?.raw, 0x82);
  assert.equal(actionStore.getSnapshot()?.class, 2);
});

test("processor：数据包真实空窗（0xFD→0x00→0xFD）仍记一次 valid_rise", (t) => {
  actionStore.reset();
  t.after(() => actionStore.reset());
  const proc = makeProcessor();
  proc.pushRawPayload(v3Data(10, 0xfd), 1000);
  proc.pushRawPayload(v3Data(11, 0x00), 2000);
  assert.equal(actionStore.getCount(), 1, "valid=false 只更新快照、不产生事件");
  assert.equal(actionStore.getSnapshot()?.valid, false);

  proc.pushRawPayload(v3Data(12, 0xfd), 3000);
  assert.equal(actionStore.getCount(), 2, "真实数据包把 VALID 重新拉高必须记一次");
  assert.equal(actionStore.totalEvents, 2);
});

test("processor：连续 20 条心跳零事件，随后同类数据包也不再计数", (t) => {
  actionStore.reset();
  t.after(() => actionStore.reset());
  const proc = makeProcessor();
  proc.pushRawPayload(v3Data(10, 0xfd), 1000);
  for (let i = 0; i < 20; i++) proc.pushRawPayload(v3Heartbeat(i), 1100 + i * 1000);

  assert.equal(actionStore.getCount(), 1, "20 条心跳不能产生任何检测");
  assert.equal(actionStore.totalEvents, 1);
  assert.equal(actionStore.getLastEventSeq(), 1);
  assert.equal(actionStore.getSnapshot()?.frameIdx, 10);
  assert.equal(actionStore.getSnapshot()?.raw, 0xfd);

  proc.pushRawPayload(v3Data(11, 0xfd), 22_000);
  assert.equal(actionStore.getCount(), 1, "心跳期间 prevValid 必须保持 true，同类数据包不能再记上升沿");
});

test("hasActionStateTlv：只认 len=1 的 0x92；无 TLV 与 malformed 都返回 false", () => {
  const hb = parseV3Packet(v3Heartbeat(0), { profile });
  assert.equal(hb.ok, true);
  if (hb.ok) assert.equal(hasActionStateTlv(hb.value), false);

  const good = buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.GET_STATUS,
    ctrlTlv: v3Tlv(CTRL.TLV.ACTION_STATE, Uint8Array.of(0xa1)),
    rsvd: 0x00,
  });
  const pg = parseV3Packet(good, { profile });
  assert.equal(pg.ok, true);
  if (pg.ok) assert.equal(hasActionStateTlv(pg.value), true);

  const bad = buildV3({
    ctrl: true,
    ctrlOpcode: CTRL.OPCODE.GET_STATUS,
    ctrlTlv: v3Tlv(CTRL.TLV.ACTION_STATE, new Uint8Array(2)),
    rsvd: 0xa1,
  });
  const pb = parseV3Packet(bad, { profile });
  assert.equal(pb.ok, true);
  if (pb.ok) assert.equal(hasActionStateTlv(pb.value), false, "malformed 0x92 不能回退到 byte23 又触发同一个 bug");
});

// ————————————————————————— /api/action —————————————————————————

test("/api/action：一帧都没有 ⇒ 503（与 frame.json 同文案）；POST ⇒ 405 纯文本", async () => {
  const { ctx } = makeCtx(new ActionStore());
  const r = await callApi(ctx, "/api/action");
  assert.equal(r.code, 503);
  assert.match(r.body, /还没有收到任何完整帧（检查板子\/网口\/UDP 端口）/);
  assert.match(r.type, /application\/json/);
  const j = JSON.parse(r.body) as Record<string, unknown>;
  assert.equal(j["ok"], false);
  assert.equal(j["available"], false);

  const post = await callApi(ctx, "/api/action", "POST");
  assert.equal(post.code, 405, "三个接口都只读（契约 §4.4）");
  assert.match(post.body, /本接口只读：仅支持 GET\/HEAD/);
});

test("/api/action：有帧但从未观察到 v3 动作字节 ⇒ 200 available:false + reason", async () => {
  const action = new ActionStore();
  const { ctx, store } = makeCtx(action);
  putFrame(store, 12);
  const { r, j } = await getJson(ctx, "/api/action");
  assert.equal(r.code, 200);
  assert.equal(j["ok"], true);
  assert.equal(j["available"], false);
  assert.equal(j["reason"], "当前数据源不是 v3 实时帧（v2/回放/合成），没有动作字节");
  assert.equal(j["frameIdx"], 12, "不可判定时也给最新帧位置，方便前端显示「无数据（等待 v3 帧）」");
  assert.equal(j["valid"], false);
  assert.equal(j["raw"], null);
  assert.equal(j["mapped"], null);
  // 任务书 API_OK 的兼容镜像字段（契约字段之外，多给不改变语义）
  assert.equal(j["seq"], 0);
  assert.equal(j["tMs"], null);
  assert.equal(j["source"], "default");
});

test("/api/action：available=true 时字段齐全且 ageMs 按到达时刻算", async () => {
  const action = new ActionStore();
  const { ctx, store } = makeCtx(action);
  putFrame(store, 30);
  action.observe(0xa2, 30, 1500);     // valid class1 conf8: (8<<2)|1 = 33 | 0x80 = 0xa1? 计算见下
  const { r, j } = await getJson(ctx, "/api/action");
  assert.equal(r.code, 200);
  const st = decodeActionState(0xa2);
  assert.equal(j["available"], true);
  assert.equal(j["frameIdx"], 30);
  assert.equal(j["raw"], 0xa2);
  assert.equal(j["valid"], st.valid);
  assert.equal(j["class"], st.cls);
  assert.equal(j["className"], "横向挥手");
  assert.equal(j["conf"], st.conf);
  assert.deepEqual(j["mapped"], { action: "stopRecord", target: "raw" });
  assert.equal(typeof j["ageMs"], "number");
  assert.ok((j["ageMs"] as number) >= 0);
  // 任务书 API_OK 兼容镜像：本帧产生第一条事件 seq=1；tMs 与快照同源；默认映射 source=default
  assert.equal(j["seq"], 1);
  assert.equal(j["tMs"], 1500);
  assert.equal(j["source"], "default");
  assert.equal(typeof j["uptimeMs"], "number", "公共字段 uptimeMs 必须在每个 200 里");
  assert.equal(j["uiUrl"], null);
});

test("/api/action/events：无 v3 快照 ⇒ 503；after=-1 ⇒ 最新 1 条；无新事件 ⇒ 200 timeout:true", async () => {
  const empty = makeCtx(new ActionStore());
  const r503 = await callApi(empty.ctx, "/api/action/events?after=-1&timeoutMs=0");
  assert.equal(r503.code, 503, "从未收到 v3 实时帧 ⇒ 503（契约 §4.2）");
  assert.match(r503.body, /还没有收到任何完整帧/);

  const action = new ActionStore();
  action.observe(0x81, 1, 100);
  action.observe(0x82, 2, 200);
  const { ctx } = makeCtx(action);

  const first = await getJson(ctx, "/api/action/events?after=-1&timeoutMs=5000");
  assert.equal(first.r.code, 200);
  assert.equal(first.j["ok"], true);
  assert.equal(first.j["lastSeq"], 2);
  assert.equal((first.j["events"] as unknown[]).length, 1, "after=-1 只回最新一条，不把历史全灌给前端");
  assert.equal(first.j["dropped"], 0);
  const ev = (first.j["events"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.equal(ev["seq"], 2);
  assert.equal(ev["tMs"], 200, "tMs 与该包的 tArriveMs 同源");
  assert.equal(ev["class"], 2);
  assert.equal(ev["className"], "横向挥手");
  assert.deepEqual(ev["mapped"], { action: "stopRecord", target: "raw" });

  const idle = await getJson(ctx, "/api/action/events?after=2&timeoutMs=30");
  assert.equal(idle.r.code, 200, "长轮询超时是 200，不是 504/408（契约 §4.4）");
  assert.equal(idle.j["ok"], false);
  assert.equal(idle.j["timeout"], true);
  assert.equal(idle.j["lastSeq"], 2);
  assert.deepEqual(idle.j["events"], []);
  assert.equal(idle.j["dropped"], 0);
  assert.equal(idle.j["error"], "在 30 ms 内没有新的动作事件");
});

test("/api/action/events：长轮询会被新事件唤醒（真实 HTTP 语义的形状）", async () => {
  const action = new ActionStore();
  action.observe(0x81, 1, 100);
  const { ctx } = makeCtx(action);
  const pending = getJson(ctx, "/api/action/events?after=1&timeoutMs=2000");
  setTimeout(() => action.observe(0x82, 2, 300), 25);
  const { r, j } = await pending;
  assert.equal(r.code, 200);
  assert.equal(j["ok"], true);
  assert.equal(j["lastSeq"], 2);
  assert.equal((j["events"] as Record<string, unknown>[]).length, 1);
  assert.equal(((j["events"] as Record<string, unknown>[])[0] as Record<string, unknown>)["seq"], 2);
});

// ————————————————————————— /api/action/config + ENDPOINTS —————————————————————————

test("/api/action/config：默认镜像与前端推入后的镜像（扁平+嵌套字段都可用）", async () => {
  const action = new ActionStore();
  const { ctx } = makeCtx(action);
  const def = await getJson(ctx, "/api/action/config");
  assert.equal(def.r.code, 200);
  assert.equal(def.j["ok"], true);
  assert.equal(def.j["source"], "default");
  assert.equal(def.j["updatedAtMs"], null);
  assert.equal(def.j["minConf"], 8, "扁平字段（任务书机读）");
  assert.deepEqual(def.j["map"], DEFAULT_ACTION_CONFIG.map);
  const nested = def.j["config"] as Record<string, unknown>;
  assert.equal(nested["v"], 1, "嵌套字段（契约 §4.3）");
  assert.equal(nested["minConf"], 8);

  action.setConfig({ v: 1, minConf: 9, map: { "2": { action: "stopRecord", target: "overlay" } } }, 42);
  const ui = await getJson(ctx, "/api/action/config");
  assert.equal(ui.j["source"], "ui");
  assert.equal(ui.j["updatedAtMs"], 42);
  assert.equal(ui.j["minConf"], 9);
  assert.deepEqual((ui.j["map"] as Record<string, unknown>)["2"], { action: "stopRecord", target: "overlay" });
});

test("ENDPOINTS：三个动作接口都在清单里（契约 §4.5 要求写进端点表）", async () => {
  for (const key of ["/api/action", "/api/action/events?after=<seq>&timeoutMs=5000", "/api/action/config"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(ENDPOINTS, key), "ENDPOINTS 缺 " + key);
  }

  const { ctx } = makeCtx();
  const unknown = await callApi(ctx, "/api/action/nope");
  assert.equal(unknown.code, 404);
  const j = JSON.parse(unknown.body) as Record<string, unknown>;
  assert.match(String(j["error"]), /未知接口: \/api\/action\/nope/);
  assert.ok(Object.prototype.hasOwnProperty.call(j["endpoints"] as object, "/api/action"));
});
test("WS config.set {actionMap}：镜像变 ui；非法配置回 -32602 且不污染镜像", async () => {
  actionStore.reset();
  const source = new SynthTransport({ profile, speed: 50, maxFrames: 1, eventsPerFrame: 0 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name }),
    setConfig: (patch) => {
      const bad = Object.keys(patch).filter((k) => k !== "bind" && k !== "port" && k !== "wsPort");
      if (bad.length > 0) throw new Error("config.set 不支持的键: " + bad.join(","));
      return { ...patch };
    },
    snapshot: () => ({}),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    const port = await hub.ready();
    ws = new WebSocket("ws://127.0.0.1:" + port);
    const replies: Record<string, unknown>[] = [];
    ws.on("message", (d: Buffer) => {
      try {
        replies.push(JSON.parse(d.toString("utf8")) as Record<string, unknown>);
      } catch {
        // 二进制帧与本次断言无关
      }
    });
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });
    const rpc = async (id: number, method: string, params: unknown): Promise<Record<string, unknown>> => {
      ws?.send(JSON.stringify({ id, method, params }));
      const t0 = Date.now();
      for (;;) {
        const hit = replies.find((m) => m["id"] === id);
        if (hit !== undefined) return hit;
        if (Date.now() - t0 > 3000) throw new Error("RPC 超时: " + method);
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const ok = await rpc(1, "config.set", {
      actionMap: { v: 1, minConf: 10, map: { "1": { action: "startAndAutoExport", target: "overlay" } } },
    });
    assert.equal(ok["error"], undefined, "actionMap 是白名单键，不能落到 control.setConfig 报不支持");
    assert.equal(actionStore.getConfigView().source, "ui", "收到前端 actionMap 后网关镜像 source=ui");

    const { ctx } = makeCtx(actionStore);
    const view = await getJson(ctx, "/api/action/config");
    assert.equal(view.j["source"], "ui");
    assert.equal(view.j["minConf"], 10, "WS 写入的 minConf 必须出现在只读镜像里");
    assert.deepEqual((view.j["map"] as Record<string, unknown>)["1"], { action: "startAndAutoExport", target: "overlay" });

    const bad = await rpc(2, "config.set", { actionMap: { v: 2 } });
    assert.equal((bad["error"] as Record<string, unknown>)["code"], -32602, "非法 actionMap 必须是参数错误");
    assert.match(String((bad["error"] as Record<string, unknown>)["message"]), /v 必须是 1/);
    assert.equal(actionStore.getConfigView().config.minConf, 10, "非法配置不得改动已生效镜像");
  } finally {
    if (ws !== null) ws.close();
    await hub.close();
    actionStore.reset();
  }
});


// ————————————————————————— task-24：VALID 上升沿计数 —————————————————————————

test("检测计数：VALID 0->1 即使 class 相同也记；1->1（含 conf 变）不记；1->0 不记", async () => {
  const s = new ActionStore();
  s.observe(0x00, 1, 100);
  assert.equal(s.getCount(), 0, "VALID=0 不计检测");

  s.observe(0x81, 2, 200);           // 0->1，class1 conf0
  assert.equal(s.getCount(), 1, "0->1 是上升沿，必须记一次");
  s.observe(0x81, 3, 300);           // 1->1，byte23 完全相同
  assert.equal(s.getCount(), 1, "连续 1->1 不记（关键反例）");
  s.observe(0x85, 4, 400);           // 1->1，仅 conf 0->1
  assert.equal(s.getCount(), 1, "conf 变化而 VALID 保持 1：置信度是状态量，不是一次新检测");
  s.observe(0x00, 5, 500);           // 1->0
  assert.equal(s.getCount(), 1, "VALID 1->0 不记");

  s.observe(0x85, 6, 600);           // 0->1，class 仍为 1
  assert.equal(s.getCount(), 2, "再次 0->1 即使 class 与上次相同也记（关键反例）");
  assert.equal(s.totalEvents, 2);
  const pg = await s.waitEvents(-1, 0);
  assert.equal(pg.events[0]?.seq, 2);
  assert.equal(pg.events[0]?.reason, "valid_rise");
  assert.equal(pg.events[0]?.class, 1);
});

test("检测计数：VALID 保持 1 时类别变化记一次，reason=class_change", async () => {
  const s = new ActionStore();
  s.observe(0x81, 1, 100);           // class1
  s.observe(0x82, 2, 200);           // class1 -> class2
  assert.equal(s.getCount(), 2);
  assert.equal(s.totalEvents, 2);
  const pg = await s.waitEvents(-1, 0);
  assert.equal(pg.events[0]?.reason, "class_change");
  assert.equal(pg.events[0]?.class, 2);
  assert.equal(pg.events[0]?.conf, 0);

  s.observe(0xfe, 3, 300);           // class2 conf31：类别不变
  assert.equal(s.getCount(), 2, "同类别下 conf 0->31 也不记");
});

test("检测计数：0->1 同时类别也变了只记一次，reason 取 valid_rise（不双计）", async () => {
  const s = new ActionStore();
  s.observe(0x81, 1, 100);           // class1
  s.observe(0x00, 2, 200);           // 空窗清零（板侧 1.0 s 后会发生）
  s.observe(0x82, 3, 300);           // 上升沿 + 2 != 1
  assert.equal(s.getCount(), 2, "两个条件同时成立时一次检测只能 +1");
  assert.equal(s.totalEvents, 2);
  const pg = await s.waitEvents(-1, 0);
  assert.equal(pg.events[0]?.reason, "valid_rise");
  assert.equal(pg.events[0]?.class, 2);
});

test("检测计数：after 游标跨多次长轮询连续取事件，count 一直累加且不重不漏", async () => {
  const s = new ActionStore();
  s.observe(0x81, 1, 100);
  s.observe(0x00, 2, 200);
  s.observe(0x81, 3, 300);
  assert.equal(s.getCount(), 2);

  const first = await s.waitEvents(0, 0);
  assert.deepEqual(first.events.map((e) => e.seq), [1, 2], "after=0 取到两次检测");
  s.observe(0x00, 4, 400);
  s.observe(0x81, 5, 500);
  assert.equal(s.getCount(), 3);

  const second = await s.waitEvents(2, 0);
  assert.deepEqual(second.events.map((e) => e.seq), [3], "after 游标只取增量，不重发旧事件");
  assert.equal(second.events[0]?.reason, "valid_rise");
  const again = await s.waitEvents(3, 0);
  assert.equal(again.timedOut, true);
  assert.equal(again.events.length, 0);
  assert.equal(s.getCount(), 3);
});

test("检测计数：reset 清零计数与边沿状态，reset 后首个 VALID=1 仍是上升沿", async () => {
  const s = new ActionStore();
  s.observe(0x81, 1, 100);
  s.observe(0x82, 2, 200);
  assert.equal(s.getCount(), 2);
  s.reset();
  assert.equal(s.getCount(), 0);
  assert.equal(s.hasSnapshot, false);
  assert.equal(s.totalEvents, 0);

  s.observe(0x82, 3, 300);           // 与 reset 前最后的 class 相同
  assert.equal(s.getCount(), 1, "reset 后没有历史边沿，首个有效包必须算一次检测");
  const pg = await s.waitEvents(-1, 0);
  assert.equal(pg.events[0]?.reason, "valid_rise");
});

test("检测计数：超过事件环容量仍持续累加（count 不受环 64 限制）", async () => {
  const s = new ActionStore();
  const N = ACTION_EVENT_RING + 6;
  for (let i = 0; i < N; i++) {
    s.observe(0x00, i * 2 + 1, i * 20);
    s.observe(0x81, i * 2 + 2, i * 20 + 10);   // 每次都是 class1 的 0->1
  }
  assert.equal(s.getCount(), N, "64 条环只限制可回看的事件，不限制累计检测次数");
  assert.equal(s.totalEvents, N);
  const pg = await s.waitEvents(0, 0);
  assert.equal(pg.events.length, 32, "单页仍最多 32 条（既有语义不变）");
  assert.equal(pg.dropped, N - ACTION_EVENT_RING, "环外旧事件按 dropped 告知消费者");
});

test("/api/action：新增 count 只增不改；0->1->0->1（class 恒 1）后 count=2，events?after=0 两条", async () => {
  const action = new ActionStore();
  const { ctx, store } = makeCtx(action);
  putFrame(store, 40);

  const before = await getJson(ctx, "/api/action");
  assert.equal(before.j["available"], false);
  assert.equal(before.j["count"], 0, "还没观察过 v3 动作字节时 count=0");

  action.observe(0x00, 41, 1000);     // 显式 VALID=0
  action.observe(0x81, 42, 2000);    // 0->1
  action.observe(0x00, 43, 3000);    // 1->0
  action.observe(0x81, 44, 4000);    // 0->1（class 仍 1）
  assert.equal(action.getCount(), 2);

  const after = await getJson(ctx, "/api/action");
  assert.equal(after.r.code, 200);
  assert.equal(after.j["count"], 2);
  // 既有字段名字/语义不变（只增不改）
  assert.equal(after.j["available"], true);
  assert.equal(after.j["frameIdx"], 44);
  assert.equal(after.j["raw"], 0x81);
  assert.equal(after.j["valid"], true);
  assert.equal(after.j["class"], 1);
  assert.equal(after.j["className"], "手部开合");
  assert.equal(after.j["conf"], 0);
  assert.equal(after.j["ok"], true);

  const events = await getJson(ctx, "/api/action/events?after=0&timeoutMs=0");
  assert.equal(events.j["lastSeq"], 2);
  const evs = events.j["events"] as Record<string, unknown>[];
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e["reason"]), ["valid_rise", "valid_rise"]);
  assert.deepEqual(evs.map((e) => e["class"]), [1, 1]);
});
