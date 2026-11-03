import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveProfile, runGateway, DEFAULT_PROFILE, DEFAULT_WS_PORT } from "../src/main.ts";
import type { CliOptions } from "../src/main.ts";

function ok(argv: string[]): CliOptions {
  const r = parseArgs(argv);
  assert.equal(r.ok, true, "参数应解析成功: " + argv.join(" "));
  return (r as { ok: true; options: CliOptions }).options;
}

test("默认无数据源参数时走合成源（无板也能起画面），WS 端口 8787", () => {
  const o = ok([]);
  assert.equal(o.kind, "synth");
  assert.equal(o.wsPort, DEFAULT_WS_PORT);
  assert.equal(o.replayPath, null);
});

test("回放默认循环 + 等第一个客户端（演示不黑屏）；--no-loop/--start-now 可关", () => {
  const def = ok(["--replay"]);
  assert.equal(def.loop, true, "默认循环：单槽帧总线，否则后连上的浏览器只能看黑屏");
  assert.equal(def.waitClient, true, "默认等浏览器连上再开播");
  const off = ok(["--replay", "--no-loop", "--start-now"]);
  assert.equal(off.loop, false);
  assert.equal(off.waitClient, false);
  const loop = ok(["--loop", "--wait-client"]);
  assert.equal(loop.loop, true);
  assert.equal(loop.waitClient, true);
});

test("--replay 可裸用（package.json 的 gateway:replay 就是裸 --replay），也可带路径", () => {
  const bare = ok(["--replay"]);
  assert.equal(bare.kind, "replay");
  assert.equal(bare.replayPath, null, "裸 --replay 用默认向量路径");
  const withPath = ok(["--replay", "capture/x.rtpkt"]);
  assert.equal(withPath.kind, "replay");
  assert.equal(withPath.replayPath, "capture/x.rtpkt");
});

test("裸路径等价于 --replay <path>（命令行习惯）", () => {
  const o = ok(["capture/y.rtpkt"]);
  assert.equal(o.kind, "replay");
  assert.equal(o.replayPath, "capture/y.rtpkt");
});

test("--profile / --udp / --bind / --port / --ws-port 全部可覆盖", () => {
  const o = ok(["--profile", "legacy-800x480-1280", "--udp", "--bind", "0.0.0.0", "--port", "1234", "--ws-port", "9001"]);
  assert.equal(o.profile, "legacy-800x480-1280");
  assert.equal(o.kind, "udp");
  assert.equal(o.bind, "0.0.0.0");
  assert.equal(o.port, 1234);
  assert.equal(o.wsPort, 9001);
});

test("非法/未知参数必须给出可读错误，而不是静默忽略", () => {
  const unknown = parseArgs(["--bogus"]);
  assert.equal(unknown.ok, false);
  const badPort = parseArgs(["--ws-port", "99999"]);
  assert.equal(badPort.ok, false);
  const missing = parseArgs(["--profile"]);
  assert.equal(missing.ok, false);
});

test("resolveProfile：未知 profile 与校验失败都抛错（04 §9 必须拒绝启动）", () => {
  assert.equal(resolveProfile("retina-v2-800x480-e5").chunksPerFrame, 750);
  assert.equal(resolveProfile("legacy-800x480-1280").wire, "LEGACY");
  assert.throws(() => resolveProfile("does-not-exist"), /未知 profile/);
});

test("runGateway 端到端装配：合成源 + WS(port 0) 可启动可关闭", async () => {
  const options: CliOptions = {
    profile: "retina-v2-800x480-e5",
    kind: "synth",
    replayPath: null,
    wsPort: 0,
    bind: null,
    port: null,
    speed: 0,
    loop: true,
    waitClient: true,
    synthFrames: 1,
    synthEvents: 5,
    help: false,
  };
  const logs: string[] = [];
  const running = await runGateway(options, (m) => logs.push(m));
  assert.equal(running.profile.name, "retina-v2-800x480-e5");
  assert.equal(running.hub.clients, 0);
  assert.equal(running.hub.pushCounters.frames, 1, "合成 1 帧应经 IPC 推流计数一次（无客户端也计数）");
  await running.close();
});

test("config.get/set：拒绝 profile 热切换、拒绝未知键，合法键返回 applied", async () => {
  const options: CliOptions = {
    profile: "retina-v2-800x480-e5",
    kind: "synth",
    replayPath: null,
    wsPort: 0,
    bind: null,
    port: null,
    speed: 1,
    loop: true,
    waitClient: true,
    synthFrames: 0,
    synthEvents: 0,
    help: false,
  };
  const running = await runGateway(options, () => {});
  try {
    const cfg = running.control.getConfig();
    assert.equal(cfg.profile, "retina-v2-800x480-e5");
    assert.equal(cfg.chunksPerFrame, 750);
    assert.throws(() => running.control.setConfig({ profile: "legacy-800x480-1280" }), /不支持热切换/);
    assert.throws(() => running.control.setConfig({ bogus: 1 }), /不支持的键/);
    const applied = running.control.setConfig({ bind: "127.0.0.1", port: 2345 }) as { applied: string[] };
    assert.deepEqual(applied.applied, ["bind", "port"]);
  } finally {
    await running.close();
  }
});

// 这条是"接开发板开箱可用"的守卫：默认 profile 必须与 RTL udp_merge.v 的实际参数一致。
// 曾经默认是 1024/750，与 RTL 的 1280/600 不符 ⇒ 帧永远凑不齐、且按 1024 步长拼 1280 字节负载整帧错位。
// 依据：`retina_event/sim/tb/tb_udp_merge.v` dump 的 605 个真实包（见 host/docs/02 文档 §2.3）。
test("默认 profile 必须与 RTL udp_merge.v 的实际参数一致（1280/600 + CRC16 必带）", () => {
  const p = resolveProfile(DEFAULT_PROFILE);
  assert.equal(p.wire, "STREAM");
  assert.equal(p.rawChunk, 1280, "RTL 的 RAW_CHUNK 默认 1280");
  assert.equal(p.chunksPerFrame, 600, "768000 / 1280 = 600");
  assert.equal(p.evRecBytes, 5, "RTL 的 EV_REC_BYTES 默认 5");
  assert.equal(p.crc16, "present", "RTL 的 CRC_EN=1，尾部必带 CRC16");
  // 包长红线：13 + 1280 + EV_MAX_USE + 2 必须 ≤ 1472（RTL 把事件段钳到 175 B）
  const evMaxUse = Math.floor((1472 - 13 - 1280 - 2) / 5) * 5;
  assert.equal(13 + p.rawChunk + evMaxUse + 2, 1470, "最坏包长 1470 ≤ 1472（MTU 红线）");
});
