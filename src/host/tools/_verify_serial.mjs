#!/usr/bin/env node
// 七修验收：串口模式事件上屏（rawCapable=false 时 EV_ONLY + NO_RAW）+ S7-S10。
// 只用临时端口 1236；不碰 1234/8787，不碰真串口 COM6（用 FakeSerialPort），不向板子发控制字节。
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProfile } from "@retina/protocol";
import { buildV3 } from "../packages/protocol/test/helpers.ts";
import { LiveTransportManager } from "../gateway/src/transport/live.ts";
import { UdpTransport } from "../gateway/src/transport/udp.ts";
import { FakeSerialPort, portFactory } from "../gateway/test/serial_fakes.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S10_PORT = 1236;
const S10_HOST = "127.0.0.1";
const onlyS10 = process.argv.includes("--s10");
const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    ...opts,
  });
}

function outOf(r) {
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function recordMany(ids, ok, title, evidence) {
  for (const id of ids) results.push({ id, ok, title });
  console.log((ok ? "✔" : "✘") + " " + ids.join("、") + " " + title);
  if (evidence) {
    for (const line of String(evidence).split("\n")) {
      if (line.trim() !== "") console.log("    " + line);
    }
  }
}

function tail(r, n = 4000) {
  return outOf(r).slice(-n);
}

function testSummary(out) {
  return out
    .split("\n")
    .filter((l) => /^(ℹ|#) (tests|suites|pass|fail|duration_ms)/.test(l))
    .join("\n");
}

function childTests(ids, title, files, mustContain) {
  const r = run(process.execPath, ["--test", "--experimental-strip-types", ...files]);
  const out = outOf(r);
  const has = mustContain.every((s) => out.includes(s));
  const ok = r.status === 0 && has;
  recordMany(ids, ok, title, testSummary(out) || tail(r, 1200));
  if (!ok) console.log(tail(r, 5000));
  return ok;
}

function npm(args) {
  return run(process.platform === "win32" ? "npm" : "npm", args, { shell: process.platform === "win32" });
}

function checkRegression() {
  const regress = npm(["test"]);
  const regressOut = outOf(regress);
  const pass = /(?:ℹ|#) pass (\d+)/.exec(regressOut);
  const passN = pass === null ? 0 : Number(pass[1]);
  const regressOk = regress.status === 0 && passN >= 443 && /(?:ℹ|#) fail 0/.test(regressOut);

  const tc = npm(["run", "typecheck"]);
  const tcOk = tc.status === 0;
  const build = npm(["run", "build", "--workspace", "web"]);
  const buildOut = outOf(build);
  const buildOk = build.status === 0 && buildOut.includes("built in");

  const evidence = [
    "npm test：tests=" + String(passN) + "，fail=" + (/(?:ℹ|#) fail (\d+)/.exec(regressOut)?.[1] ?? "?") + "（基线 443+）",
    "typecheck：exit " + String(tc.status) + (tcOk ? "" : "，" + tail(tc, 800)),
    "web build：exit " + String(build.status) + "；" + (buildOut.split("\n").filter((l) => /built in|modules transformed|dist\//.test(l)).slice(-3).join("；") || tail(build, 800)),
  ].join("\n");
  const ok = regressOk && tcOk && buildOk;
  recordMany(
    ["S5", "N5"],
    ok,
    "全量回归（" + String(passN) + " pass / 0 fail）+ typecheck 0 + web build 重建 dist",
    evidence,
  );
  if (!ok) {
    if (!regressOk) console.log(tail(regress, 5000));
    if (!tcOk) console.log(tail(tc, 2000));
    if (!buildOk) console.log(tail(build, 2000));
  }
  return ok;
}

async function probePortFree(port, host) {
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((resolve) => {
      const s = dgram.createSocket("udp4");
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        try { s.close(); } catch { /* 已关 */ }
        resolve(v);
      };
      s.once("error", () => done(false));
      s.bind(port, host, () => done(true));
    });
    if (ok) return true;
    await sleep(25);
  }
  return false;
}

async function sendRawFrame(port, host, profile, frameIdx) {
  const raw = new Uint8Array(profile.frame.bytes);
  const sender = dgram.createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      let pending = profile.chunksPerFrame;
      for (let i = 0; i < profile.chunksPerFrame; i++) {
        const from = i * profile.rawChunk;
        const to = Math.min(from + profile.rawChunk, raw.length);
        const pkt = buildV3({
          raw: raw.subarray(from, to),
          chunkIdx: i,
          frameIdx,
          mode: 0,
          first: i === 0,
          last: i === profile.chunksPerFrame - 1,
          tsUs: 1000 + i,
        });
        sender.send(Buffer.from(pkt), port, host, (err) => {
          if (err) { reject(err); return; }
          pending -= 1;
          if (pending === 0) resolve();
        });
      }
    });
  } finally {
    try { sender.close(); } catch { /* ignore */ }
  }
}

async function checkS10() {
  const profile = getProfile("retina-v2-800x480-1280");
  const fakePort = new FakeSerialPort();
  const boundLogs = [];
  const logs = [];
  const udpSources = [];
  let current = null;

  const m = await LiveTransportManager.create({
    profile,
    mode: "udp",
    bind: S10_HOST,
    port: S10_PORT,
    serialPath: "COM6",
    handshakeEnabled: false,
    serialFactory: portFactory(fakePort),
    udpFactory: (o) => {
      const src = new UdpTransport({
        ...o,
        sendControl: false,
        onBound: (ip, p) => {
          boundLogs.push({ ip, port: p, at: Date.now() });
          logs.push("[verify] UDP 已绑定 " + ip + ":" + p);
        },
      });
      udpSources.push(src);
      return src;
    },
    log: (s) => logs.push(s),
    onSourceChange: (s) => { current = s; },
  });

  try {
    const initialBound = await waitFor(() => boundLogs.length >= 1, 2000);
    if (!initialBound) throw new Error("初始 UDP 未在 2 s 内绑定 " + S10_HOST + ":" + S10_PORT);
    const first = udpSources[0];
    if (m.kind !== "udp") throw new Error("初始通道不是 udp：" + m.kind);
    console.log("    [S10] 初始 UDP 已绑定 " + S10_HOST + ":" + S10_PORT + "；决策 active=" + String(m.statusView().decision.active));

    await m.switchTo("uart");
    if (m.kind !== "uart") throw new Error("切串口失败：" + m.kind);
    if (first.running) throw new Error("切串口后旧 UDP 源仍在 running");
    if (first.localPort !== null) throw new Error("切串口后旧 UDP localPort 仍为 " + first.localPort);
    console.log("    [S10] 已切串口：旧 UDP running=" + first.running + " localPort=" + String(first.localPort));

    const freed = await probePortFree(S10_PORT, S10_HOST);
    if (!freed) throw new Error("旧 UDP 会话已停止但端口 " + S10_PORT + " 仍不可重新绑定");
    console.log("    [S10] 端口探针：旧 UDP 释放后 " + S10_HOST + ":" + S10_PORT + " 可重新绑定");
    await sleep(80);

    const frames = [];
    logs.length = 0;
    boundLogs.length = 0;
    const tSwitch = Date.now();
    await m.switchTo("udp", { force: true, reason: "S10 验收：串口→网口" });
    current.on("frame", (f) => frames.push({ f, at: Date.now() }));

    const rebound = await waitFor(() => boundLogs.length >= 1, 2000);
    if (!rebound) throw new Error("回切后 UDP 未在 2 s 内重新绑定；日志：" + logs.slice(-5).join(" | "));
    console.log("    [S10] 回切后重新绑定成功：" + boundLogs[0].ip + ":" + boundLogs[0].port + "（新 UDP socket）");

    await sendRawFrame(S10_PORT, S10_HOST, profile, 6100);
    const got = await waitFor(() => frames.length > 0, 3000, 10);
    if (!got) throw new Error("回切后 3 s 内没有 FRAME_RAW；rxPackets=" + String(current.rxPackets));
    const { f, at } = frames[0];
    const dt = at - tSwitch;
    if (dt > 3000) throw new Error("FRAME_RAW 在回切后 " + dt + " ms 才到（>3 s）");
    if (f.raw.length !== profile.frame.bytes) throw new Error("FRAME_RAW 原始段长度 " + f.raw.length + " ≠ " + profile.frame.bytes);
    console.log("    [S10] 回切后 " + dt + " ms 收到 FRAME_RAW frameIdx=" + f.frameIdx + " raw=" + f.raw.length + " B（" + profile.chunksPerFrame + " 块）");
    console.log("    [S10] 新 UDP 源 rxPackets=" + String(current.rxPackets) + "；旧源 running=" + String(first.running));
    recordMany(["S10"], true, "串口→网口：旧会话释放、端口重绑成功、3 s 内 FRAME_RAW", "");
  } finally {
    m.close();
  }
}

async function main() {
  if (!onlyS10) {
    childTests(
      ["S1", "S2"],
      "串口 rawCapable=false 事件批 EV_ONLY/NO_RAW；rawCapable=true 不误标",
      ["gateway/test/serial_evonly_ws.test.ts"],
      ["✔ S1", "✔ S2"],
    );
    childTests(
      ["S3", "S7", "S8", "S9"],
      "串口残留批结算、故障态字段、坏帧日志限流、自动回退只一次",
      ["gateway/test/serial_sevenfix.test.ts"],
      ["✔ S3", "✔ S7/S9", "✔ S8"],
    );
    childTests(
      ["S4"],
      "前端串口模式守卫：立即上屏、不 evQueue、文案切换",
      ["web/test/evonly.test.ts", "web/test/evonly-dispatch.test.ts"],
      ["串口 NO_RAW", "S4 串口 NO_RAW"],
    );
    childTests(
      ["S6"],
      "遥测语义未变（codec_uart_telem + CRC）",
      ["packages/protocol/test/codec_uart_telem.test.ts", "packages/protocol/test/codec_uart_telem_crc.test.ts"],
      [],
    );
    childTests(
      ["N1", "N2", "N3", "N4"],
      "九修串口心跳：安静场景不误回退、真损坏仍回退、不打断命令、切后无残留 timer",
      ["gateway/test/serial_heartbeat.test.ts"],
      ["✔ N1", "✔ N2", "✔ N3", "✔ N4"],
    );
    checkRegression();
  }

  try {
    await checkS10();
  } catch (err) {
    recordMany(["S10"], false, "串口→网口实测", String(err instanceof Error ? err.stack ?? err.message : err));
  }

  const failed = results.filter((r) => !r.ok);
  const sResults = results.filter((r) => r.id.startsWith("S"));
  const nResults = results.filter((r) => r.id.startsWith("N"));
  const sFailed = sResults.filter((r) => !r.ok);
  const nFailed = nResults.filter((r) => !r.ok);
  console.log("");
  console.log(
    "七修 S1-S10：" + (sResults.length - sFailed.length) + "/" + sResults.length + " 通过" +
    (sFailed.length ? "；失败：" + sFailed.map((r) => r.id).join(",") : ""),
  );
  console.log("SERIAL_EV_OK=" + (sFailed.length === 0 ? 1 : 0));
  if (!onlyS10) {
    console.log(
      "九修 N1-N5：" + (nResults.length - nFailed.length) + "/" + nResults.length + " 通过" +
      (nFailed.length ? "；失败：" + nFailed.map((r) => r.id).join(",") : ""),
    );
    console.log("NINEFIX_OK=" + (nFailed.length === 0 ? 1 : 0));
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
