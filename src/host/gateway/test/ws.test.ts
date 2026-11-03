import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { IPC, decodeIpc, getProfile } from "@retina/protocol";
import type { Counters, IpcMessage, Profile } from "@retina/protocol";
import { HOST_SIM_DEFAULT_MINDL, HOST_SIM_DEFAULT_THETA } from "@retina/retina";
import { IpcHub } from "../src/ipc/ws.ts";
import type { BoardControl, GatewayControl } from "../src/ipc/ws.ts";
import { SynthTransport } from "../src/transport/synth.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;

interface Collected {
  readonly text: Record<string, unknown>[];
  readonly binary: Uint8Array[];
}

/** 必须"先挂监听再等 open"：服务端在连接建立时就会推 hello/STATS，晚挂会漏消息 */
function collect(ws: WebSocket): Collected {
  const c: Collected = { text: [], binary: [] };
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) c.binary.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else c.text.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
  });
  ws.on("error", () => {});
  return c;
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rpc(c: Collected, ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ id, method, params }));
  return waitFor(() => c.text.find((m) => m.id === id), "RPC " + method);
}

function decodeAll(c: Collected): IpcMessage[] {
  const out: IpcMessage[] = [];
  for (const b of c.binary) {
    const m = decodeIpc(b);
    if (m !== null) out.push(m);
  }
  return out;
}

test("WS IPC：RPC 子集可用、二进制推流能被 decodeIpc 原样还原、未实现方法显式报错", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 3, eventsPerFrame: 12 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => {
      if ("bogus" in patch) throw new Error("config.set 不支持的键: bogus");
      return { ...patch };
    },
    snapshot: () => ({ sourceKind: "synth" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    const port = await hub.ready();
    assert.ok(port > 0);
    // port:0 时 url 必须是真实端口，否则测试/前端连到 :0
    assert.equal(hub.url, "ws://127.0.0.1:" + port);
    assert.equal(hub.port, port);

    ws = new WebSocket(hub.url);
    const c = collect(ws);
    await once(ws, "open");

    // 连接即拿现场：hello（含 profile/版本）
    const hello = await waitFor(() => c.text.find((m) => m.method === "session.hello"), "session.hello");
    const helloParams = hello.params as { profile: { name: string }; version: string };
    assert.equal(helloParams.profile.name, profile.name);
    assert.equal(typeof helloParams.version, "string");

    const snap = await rpc(c, ws, 1, "session.snapshot");
    const snapResult = snap.result as { profile: { chunksPerFrame: number }; clients: number };
    assert.equal(snapResult.profile.chunksPerFrame, 750);
    assert.equal(snapResult.clients, 1);

    const cfg = await rpc(c, ws, 2, "config.get");
    assert.equal((cfg.result as { profile: string }).profile, profile.name);

    const badCfg = await rpc(c, ws, 3, "config.set", { bogus: 1 });
    assert.equal((badCfg.error as { code: number }).code, -32602, "非法参数必须报 -32602");

    const notImpl = await rpc(c, ws, 4, "plugin.list");
    assert.equal((notImpl.error as { code: number }).code, -32601, "RPC_METHODS 里未实现的方法要显式报错");
    assert.match(String((notImpl.error as { message: string }).message), /plugin\.list/);

    const unknown = await rpc(c, ws, 5, "no.such.method");
    assert.equal((unknown.error as { code: number }).code, -32601);

    // 通过 RPC 启流 → 应收到 FRAME_RAW + EVENTS + STATS
    const started = await rpc(c, ws, 6, "transport.start");
    assert.deepEqual(started.result, { started: true });

    const frameMsg = await waitFor(() => decodeAll(c).find((m) => m.type === "FRAME_RAW"), "FRAME_RAW 推流");
    if (frameMsg.type !== "FRAME_RAW") throw new Error("类型收窄失败");
    assert.equal(frameMsg.raw.length, 768000, "网关不下采样，原样推流");
    assert.equal(frameMsg.w, 800);
    assert.equal(frameMsg.h, 480);
    assert.equal(frameMsg.pixel, 0, "默认 RGB565_BE");
    assert.equal((frameMsg.flags & IPC.FLAG_SYNTHETIC) !== 0, true, "合成源必须带合成标志");

    const evMsg = await waitFor(() => decodeAll(c).find((m) => m.type === "EVENTS" && m.count === 12), "EVENTS 推流");
    if (evMsg.type === "EVENTS") {
      assert.equal(evMsg.recBytes, profile.evRecBytes);
      assert.equal(evMsg.data.length, 12 * profile.evRecBytes);
    }

    const statsMsg = await waitFor(() => decodeAll(c).find((m) => m.type === "STATS"), "STATS 心跳");
    if (statsMsg.type === "STATS") {
      assert.equal(typeof statsMsg.stats.pps, "number");
      assert.equal(statsMsg.counters.aborted, 0);
    }

    // 背压：pause 后只停 FRAME_RAW（EVENTS/STATS 照推），并在快照里可见
    const paused = await rpc(c, ws, 7, "flow.pause");
    assert.deepEqual(paused.result, { paused: true });
    assert.equal(hub.paused, true);
    const snap2 = await rpc(c, ws, 8, "session.snapshot");
    assert.equal((snap2.result as { paused: boolean }).paused, true);
    const resumed = await rpc(c, ws, 9, "flow.resume");
    assert.deepEqual(resumed.result, { paused: false });
  } finally {
    // 失败路径也必须收干净：否则 WS 服务端句柄会吊住 node:test 进程（本地实测过）
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

test("WS IPC：慢客户端时丢 FRAME_RAW 并计 uiDrop（丢帧必须可见）", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 2 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({}),
    setConfig: () => ({}),
    snapshot: () => ({}),
  };
  // 阈值 -1：任何 bufferedAmount 都算"堵住了" ⇒ 确定性触发背压分支，不靠时序碰运气
  const hub = new IpcHub({ port: 0, profile, source, control, maxBufferedBytes: -1 });
  let ws: WebSocket | null = null;
  try {
    assert.ok((await hub.ready()) > 0);
    ws = new WebSocket(hub.url);
    const c = collect(ws);
    await once(ws, "open");
    const counters: Counters = source.counters;
    const before = counters.uiDrop;
    source.start();
    await waitFor(() => (hub.pushCounters.uiDrop > before ? true : undefined), "uiDrop 计数");
    assert.equal(counters.uiDrop > before, true, "丢帧必须计数（原则 P6）");
    assert.equal(decodeAll(c).filter((m) => m.type === "FRAME_RAW").length, 0, "被丢弃的帧不得推给慢客户端");
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

test("WS IPC：新客户端连上即补发最近一帧（单槽帧缓存），不必等下一帧", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 1 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({}),
    setConfig: () => ({}),
    snapshot: () => ({}),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    assert.ok((await hub.ready()) > 0);
    source.start();
    await waitFor(() => (hub.pushCounters.frames > 0 ? true : undefined), "首个合成帧");
    // 此刻才连：帧早已推过（没有客户端），靠缓存补发
    ws = new WebSocket(hub.url);
    const c = collect(ws);
    await once(ws, "open");
    const frameMsg = await waitFor(() => decodeAll(c).find((m) => m.type === "FRAME_RAW"), "补发的 FRAME_RAW");
    if (frameMsg.type !== "FRAME_RAW") throw new Error("类型收窄失败");
    assert.equal(frameMsg.raw.length, 768000, "补发的必须是完整帧（单槽缓存只保最新完整帧）");
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

/**
 * 「上位机模拟处理」的参数通路。
 *
 * 这一组断言来自一次真实事故：前端侧栏把 `{theta}` 直接发给 config.set（网关键名叫 hostTheta），
 * 网关按未知配置项拒掉 ⇒ 每次拖滑动条都弹「参数未下发成功」，θ 永远停在板端默认 44，
 * 事件画面几乎全黑，用户以为"算法没处理好"。所以这里要同时钉两件事：
 *   ① 网关键名就是 hostTheta / hostMinDl（前端映射必须以它为准）
 *   ② 界面键名 theta / minDl **必须**被拒（否则映射写错了也没人发现）
 */
test("WS IPC：上位机算法参数走 hostTheta/hostMinDl；界面键名必须被拒", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 4, eventsPerFrame: 0 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({}),
    setConfig: (patch) => {
      const k = Object.keys(patch)[0];
      if (k !== undefined) throw new Error("config.set 不支持的键: " + k);
      return {};
    },
    snapshot: () => ({}),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    assert.ok((await hub.ready()) > 0);
    ws = new WebSocket(hub.url);
    const c = collect(ws);
    await once(ws, "open");

    // ① 默认必须是"看得见东西"的现场实测工作点（θ=3 / 守卫=18），而不是板端的 44 / 1
    const cfg0 = await rpc(c, ws, 1, "config.get");
    const r0 = cfg0.result as { hostTheta: number; hostMinDl: number; eventSource: string };
    assert.equal(r0.hostTheta, HOST_SIM_DEFAULT_THETA);
    assert.equal(r0.hostMinDl, HOST_SIM_DEFAULT_MINDL);
    assert.notEqual(r0.hostTheta, 44, "θ 默认成 44 时本场景逐帧事件数是 0");
    assert.equal(r0.eventSource, "board", "事件来源默认仍是板端");

    // ② 界面键名（theta/minDl）必须被网关拒掉 —— 前端必须自己做映射
    const wrong = await rpc(c, ws, 2, "config.set", { theta: 8 });
    assert.equal((wrong.error as { code: number }).code, -32602);
    assert.match(String((wrong.error as { message: string }).message), /theta/);
    const wrong2 = await rpc(c, ws, 3, "config.set", { minDl: 2 });
    assert.equal((wrong2.error as { code: number }).code, -32602);

    // ③ 正确的键名要真的改到引擎参数上（不只是回显）
    const ok = await rpc(c, ws, 4, "config.set", { hostTheta: 16, hostMinDl: 3 });
    const rOk = ok.result as { hostTheta: number; hostMinDl: number };
    assert.equal(rOk.hostTheta, 16);
    assert.equal(rOk.hostMinDl, 3);
    assert.equal(hub.hostAlgorithmParams.theta, 16, "config.set 必须真的重建引擎参数");
    assert.equal(hub.hostAlgorithmParams.minDl, 3);

    // ④ 非数字必须拒（滑动条理论上只会给数字，但别留一条能塞进字符串的路）
    const nan = await rpc(c, ws, 5, "config.set", { hostTheta: "8" });
    assert.equal((nan.error as { code: number }).code, -32602);

    // ⑤ 切到上位机模拟后，推流里的 EVENTS 必须带 FLAG_HOST_SIM（前端据此标"来源：上位机"）
    const sw = await rpc(c, ws, 6, "config.set", { eventSource: "host" });
    assert.equal((sw.result as { eventSource: string }).eventSource, "host");
    assert.equal((await rpc(c, ws, 7, "transport.start")).result !== undefined, true);
    const ev = await waitFor(
      () => decodeAll(c).find((m) => m.type === "EVENTS" && (m.flags & IPC.FLAG_HOST_SIM) !== 0),
      "带 FLAG_HOST_SIM 的 EVENTS",
    );
    assert.equal(ev.type, "EVENTS");

    // 切回板端来源（防止后续断言被这条状态影响）
    assert.equal((await rpc(c, ws, 8, "config.set", { eventSource: "board" })).result !== undefined, true);
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});

/**
 * board.setParam 的 expCap 透传（**sccb 集成 tag 0x0B**，sccb 集成报告 §9.1，2026-10-13）。
 *
 * 为什么值得一条端到端断言：ws.ts 的 `board.setParam` 走**整数参数白名单**
 * （逐个 k 校验 Number.isInteger 后才转发给 V3Link）。白名单漏一个键的后果不是报错，
 * 而是**字段被静默丢掉** —— 前端弹"已写入"，板端 cap 却没动，跟 2026-10-06 的
 * config.set 键名事故（theta vs hostTheta）是同一类故障。所以在这里钉住：
 * ① expCap 必须活着走到 board.setParam ② 非整数必须被显式拒绝 ③ 读回（TLV 0x90）要能回到前端。
 */
test("WS IPC：board.setParam 透传 expCap（tag 0x0B）、非整数显式 -32602、ACK 的 TLV 0x90 读回可回前端", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 1 });
  const calls: Record<string, unknown>[] = [];
  const board: BoardControl = {
    setParam: async (p) => {
      calls.push(p as Record<string, unknown>);
      return { ok: true, opcode: 1, seq: 0x0021, status: 0, detail: "OK", tlvs: { expCap: 746 } };
    },
    setMode: async () => ({ ok: true, opcode: 2, seq: 1, status: 0, detail: "OK" }),
    getStatus: async () => ({ ok: true, opcode: 4, seq: 1, status: 0, detail: "OK" }),
    calibrate: async () => ({ ok: true, opcode: 3, seq: 1, status: 0, detail: "OK" }),
    evEn: async () => ({ ok: true, opcode: 5, seq: 1, status: 0, detail: "OK" }),
    status: () => ({ wireVer: 3, expCap: 746, downlinkAvailable: true }),
  };
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({}),
    setConfig: () => ({}),
    snapshot: () => ({}),
    board,
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  let ws: WebSocket | null = null;
  try {
    assert.ok((await hub.ready()) > 0);
    ws = new WebSocket(hub.url);
    const c = collect(ws);
    await once(ws, "open");

    // ① expCap 与既有 tag 同包下发：白名单必须原样转发（键名 = V3Link.setParam 的形参名，不许改名）
    const r = await rpc(c, ws, 1, "board.setParam", { theta: 44, expCap: 746 });
    assert.deepEqual(calls[0], { theta: 44, expCap: 746 }, "expCap 被白名单吞掉了（字段静默丢弃）");
    const res = r.result as { ok: boolean; tlvs?: { expCap?: number | null } };
    assert.equal(res.ok, true);
    assert.equal(res.tlvs?.expCap, 746, "ACK 的 TLV 0x90 读回值必须能回到前端");

    // ② 非整数（界面上不该出现，但别留一条能塞进浮点的路）
    const bad = await rpc(c, ws, 2, "board.setParam", { expCap: 746.5 });
    assert.equal((bad.error as { code: number }).code, -32602);
    assert.equal(calls.length, 1, "非法参数不得转发给 V3Link");
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});
