#!/usr/bin/env node
// ack_highload_replay —— 「高负载下经网关命令 ACK 超时」的本地回环复现 / 验收工具（2026-10-13）。
//
// 为什么必须本地回环：板端上行**只有一个 socket**（厂家 `udp_tx.v` 把源/目的端口都写死 1234，
// 见 `retina_event/src/hdl/comms/eth_udp.v:30`），CTRL/ACK 与 22 MB/s 数据流共享同一个内核接收队列
// —— 这就是缺陷的物理机制。拿真板复现要独占 1234（板端修复队友在用板），故本工具用
// **同一条生产链路**（UdpTransport + DownlinkSocket + V3Link + IpcHub/WS）在 127.0.0.1 上
// 用真实抓包字节按真实线速回放，并跑一个"板端桩"把 ACK 发到网关的接收口（复刻"ACK 排在数据流队尾"）。
//
// 进程结构（两个子进程，CPU 互相隔离 —— 否则"发送方"自己会帮被测网关竞争 CPU，测不准）：
//   · --role=board   ：板端桩（收 1235 命令→回 ACK 到网关接收口）+ 回放发送方（真实线速，段循环续播）
//   · --role=gateway ：被测链路（UdpTransport + V3Link + IpcHub，外加一个 WS 客户端复现 768 KB 大帧推送）
//   缺省（父进程）   ：起两个子进程、下发测量指令、汇总打印（--json 给机读）
//
// 用法：
//   node --experimental-strip-types tools/ack_highload_replay.ts --cmds 20 [--seg-seconds 4] [--mb 16] [--json]
// 判据（现场同型）：ACK OK ≥ 19/20 @ ≈22 MB/s（修复前现场为 12/20 @ 23 MB/s）。
import dgram from "node:dgram";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPTURE_DEFAULT, LINE_FPS, buildReplay, splitCapture } from "./recv_replay_lib.ts";
// 板端桩夹具 + 48bit TS 读写（纯函数抽到 lib，配 tools/test/ack_loopback.test.ts 回归）
import { buildCtrlAck, readTs48, writeTs48 } from "./ack_loopback_lib.ts";
// 段循环平移后重算尾部 CRC 用（查表版，~3 µs/包；45 fps 档每包都补，逐位版会拖垮发送循环）。
// 注意：抓包切包的独立 CRC 校验仍走 recv_replay_lib 的逐位实现（那里是"验证"，不能共用被测实现）
import { crc16 } from "@retina/protocol";

const argv = process.argv.slice(2);
const valOf = (f: string, d: string): string => {
  const i = argv.indexOf(f);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const has = (f: string): boolean => argv.includes(f);
const ROLE = valOf("--role", "orchestrator");

const GW_UDP_PORT = Number(valOf("--gw-port", "12341"));   // 网关接收口（= 现场 1234 的等价物）
const BOARD_PORT = Number(valOf("--board-port", "12355")); // 板端命令口（= 现场 1235 的等价物）
const WS_PORT = Number(valOf("--ws-port", "8799"));
const BIND = "127.0.0.1";
/** 回放段长（秒；段循环续播 —— 时间戳/帧号续接，不制造 epochReset/回绕计数） */
const SEG_SECONDS = Number(valOf("--seg-seconds", "4"));
/** 线级帧率（标定线速用；缺省 29.7 fps × 600 块 ≈ 17.8k pps ≈ 22 MB/s = 现场口径） */
const FPS = Number(valOf("--fps", String(LINE_FPS)));
const CMDS = Number(valOf("--cmds", "20"));
const MB = Number(valOf("--mb", "16"));
const WARMUP_MS = Number(valOf("--warmup", "3000"));
const TIMEOUT_MS = Number(valOf("--timeout", "1000"));
const CAPTURE = path.resolve(valOf("--capture", CAPTURE_DEFAULT));
const JSON_OUT = has("--json");

// ————————————————————————— 板端桩 + 回放发送方 —————————————————————————
function makeBoard(): void {
  const gwPort = GW_UDP_PORT;
  const cmdSock = dgram.createSocket({ type: "udp4" });
  let acks = 0;
  cmdSock.on("message", (msg: Buffer) => {
    // 下行包：magic4 f0 5a a5 31 + ver + opcode + seq2 + len2 + payload + CRC2
    if (msg.length < 12 || msg[0] !== 0xf0 || msg[1] !== 0x5a || msg[2] !== 0xa5 || msg[3] !== 0x31) return;
    const opcode = msg[5] as number;
    const seq = ((msg[6] as number) << 8) | (msg[7] as number);
    cmdSock.send(buildCtrlAck(opcode, seq), gwPort, BIND, () => {});
    acks++;
  });
  cmdSock.bind(BOARD_PORT, BIND);

  const raw = new Uint8Array(fs.readFileSync(CAPTURE));
  const replay = buildReplay(splitCapture(raw), SEG_SECONDS, 600, FPS);
  const pkts = replay.pkts;
  const segPkts = replay.meta.packets;
  const segFrames = replay.meta.totalFrames;
  const tsStep = replay.meta.tsStepUs;
  const sender = dgram.createSocket({ type: "udp4", sendBufferSize: 8 * 1024 * 1024 });
  const pps = segPkts / SEG_SECONDS / 1000;              // 包/ms
  let cursor = 0;
  let loop = 0;
  let sent = 0;
  let sendDrops = 0;
  const segStart = Date.now();

  // 段循环：把本段的时间戳/帧号整体平移到"上一段之后"（每循环一次加一个固定的段长偏移），
  // 线级看是连续流 —— 不制造 tsEpochReset / frameIdx 回退计数。
  // ⚠️ 平移的字节（偏移 10..11 / 16..21）在 CRC 覆盖范围内，必须重算尾部 CRC，
  //    否则回放流自己制造 crcFail（第一版就踩了：第二段起 678 包 CRC 全坏）。
  // ⚠️ 补丁**按需随包做**（每包在发送前只平移一次，~3 µs 均摊）：整段一次性平移会阻塞
  //    发送循环 0.2 s，之后的"补发洪峰"会把发送缓冲打爆（第一版实测边界 aborted=2）。
  const tsStepOfSegment = segPkts * tsStep;
  const idxStepOfSegment = segFrames % 65536;
  const patchOne = (p: Uint8Array): void => {
    writeTs48(p, readTs48(p) + tsStepOfSegment);
    const idx = (((p[10] as number) << 8) | (p[11] as number)) + idxStepOfSegment;
    p[10] = (idx >> 8) & 0xff;
    p[11] = idx & 0xff;
    if (((p[6] as number) & 0b100) !== 0) {
      const bodyEnd = p.length - 2;
      new DataView(p.buffer, p.byteOffset, p.byteLength).setUint16(bodyEnd, crc16(p.subarray(0, bodyEnd)));
    }
  };

  const pump = (): void => {
    const due = Math.min(segPkts, Math.max(cursor, Math.floor((Date.now() - segStart) * pps) - loop * segPkts));
    while (cursor < due) {
      const p = pkts[cursor] as Uint8Array;
      if (loop > 0) patchOne(p);        // 第 0 段是原始抓包字节（不动）
      sender.send(p, gwPort, BIND, (err) => {
        if (err !== null && err !== undefined) sendDrops++;
      });
      cursor++;
      sent++;
    }
    if (cursor >= segPkts) {
      cursor = 0;
      loop++;
    }
    setTimeout(pump, 1);
  };
  setTimeout(pump, 0);

  process.on("message", (m: unknown) => {
    const msg = m as { cmd?: string };
    if (msg.cmd === "stats" && process.send !== undefined) {
      process.send({ role: "board", stats: true, sent, acks, loops: loop, sendDrops });
    }
    if (msg.cmd === "stop") process.exit(0);
  });
  if (process.send !== undefined) {
    process.send({
      role: "board",
      ready: true,
      segPackets: segPkts,
      segSeconds: SEG_SECONDS,
      mbps: Math.round((segPkts * replay.meta.avgLen) / SEG_SECONDS / 1024 / 1024 * 10) / 10,
    });
  } else {
    // 单进程直跑：每 2 s 打一行进度（手工排障/观察用）
    console.log("[board-standalone] 回放段 " + segPkts + " 包 / " + SEG_SECONDS + " s ≈ " +
      Math.round((segPkts * replay.meta.avgLen) / SEG_SECONDS / 1024 / 1024 * 10) / 10 + " MB/s → 127.0.0.1:" + gwPort);
    setInterval(() => {
      console.log("[board-standalone] sent=" + sent + " acks=" + acks + " loop=" + loop);
    }, 2000);
  }
}

// ————————————————————————— 被测链路（生产类，回环口） —————————————————————————
function makeGateway(): void {
  void (async () => {
    const { UdpTransport } = await import("../gateway/src/transport/udp.ts");
    const { DownlinkSocket } = await import("../gateway/src/transport/downlink.ts");
    const { V3Link } = await import("../gateway/src/pipeline/v3link.ts");
    const { IpcHub } = await import("../gateway/src/ipc/ws.ts");
    type BoardControl = import("../gateway/src/ipc/ws.ts").BoardControl;
    const { getProfile } = await import("@retina/protocol");
    const WebSocket = (await import("ws")).WebSocket;

    const profile = getProfile("retina-v2-800x480-1280");
    if (profile === null) throw new Error("profile 缺失");

    const linkRef: { link: InstanceType<typeof V3Link> | null } = { link: null };
    const source = new UdpTransport({
      profile,
      bind: BIND,
      port: GW_UDP_PORT,
      sendControl: false,          // ★ 绝不向真板 192.168.1.10 发任何字节
      recvBufferSize: MB * 1024 * 1024,
      stallWarnMs: 0,
      onCtrl: (pkt) => linkRef.link?.onCtrlPacket(pkt),
      onV3Mode: (m) => linkRef.link?.noteDataMode(m),
    });
    const downlink = new DownlinkSocket({ boardIp: BIND, boardPort: BOARD_PORT });
    downlink.start();
    const link = new V3Link({
      send: (b) => downlink.send(b),
      nowUs: () => performance.now() * 1000,
      ackTimeoutMs: TIMEOUT_MS,
    });
    linkRef.link = link;
    source.start();

    const board: BoardControl = {
      setParam: (p) => link.setParam(p),
      setMode: (m) => link.setMode(m),
      getStatus: () => link.getStatus(),
      calibrate: () => link.calibrate(),
      evEn: (e) => link.evEn(e),
      status: () => link.statusView(),
    };
    const hub = new IpcHub({
      port: WS_PORT,
      profile,
      source,
      control: {
        start: () => source.start(),
        stop: () => source.stop(),
        getConfig: () => ({ profile: profile.name }),
        setConfig: (p) => p,
        snapshot: () => ({ sourceKind: "udp-loopback" }),
        board,
      },
      log: () => {},
    });
    await hub.ready();

    // 复现现场条件：一个 WS 客户端在收 768 KB 大帧（网关要同时编码 + 发送）
    const ws = new WebSocket("ws://127.0.0.1:" + WS_PORT);
    const wsCount = { frames: 0, events: 0, bytes: 0 };
    ws.on("message", (d: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      wsCount.bytes += d.length;
      const t = d[0] as number;
      if (t === 1) wsCount.frames++;
      else if (t === 2) wsCount.events++;
    });
    ws.on("error", () => {});
    await new Promise<void>((r) => {
      ws.on("open", () => r());
      ws.on("error", () => r());
    });

    // 单进程直跑（没有父进程 IPC）时：预热后自动测量并打印结果 —— 便于排障/手工使用
    const runStandalone = (): void => {
      void (async () => {
        await new Promise((r) => setTimeout(r, WARMUP_MS));
        const lat: number[] = [];
        let ok = 0;
        for (let i = 0; i < CMDS; i++) {
          const t0 = performance.now();
          const r = await link.getStatus();
          lat.push(performance.now() - t0);
          if (r.ok) ok++;
        }
        const counters = hub.countersSnapshot();
        console.log(JSON.stringify({ mode: "gateway-standalone", ok, total: CMDS, latMs: lat.map((x) => Math.round(x)), rxPackets: source.rxPackets, counters }));
      })();
    };

    process.on("message", (m: unknown) => {
      const msg = m as { cmd?: string };
      if (msg.cmd !== "run") return;
      void (async () => {
        await new Promise((r) => setTimeout(r, WARMUP_MS));   // 先让负载真跑起来
        // 负载标定窗（1 s）："等效负载"证据必须来自命令前的实测窗口，不是拍脑袋
        const p0 = performance.now();
        const pRx0 = source.rxPackets;
        await new Promise((r) => setTimeout(r, 1000));
        const probeMs = performance.now() - p0;
        const probeRx = source.rxPackets - pRx0;
        const lat: number[] = [];
        let ok = 0;
        let timeouts = 0;
        for (let i = 0; i < CMDS; i++) {
          const c0 = performance.now();
          const r = await link.getStatus();
          lat.push(performance.now() - c0);
          if (r.ok) ok++;
          else if (/超时/.test(r.detail)) timeouts++;
        }
        const counters = hub.countersSnapshot();
        const sorted = [...lat].sort((a, b) => a - b);
        const pct = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
        const result = {
          ok,
          total: CMDS,
          timeouts,
          latMinMs: Math.round(Math.min(...lat)),
          latMedianMs: Math.round(pct(0.5)),
          latP90Ms: Math.round(pct(0.9)),
          latMaxMs: Math.round(Math.max(...lat)),
          latMs: lat.map((x) => Math.round(x)),
          probeMs: Math.round(probeMs),
          probeRx,
          rxPps: Math.round((probeRx / probeMs) * 1000),
          rxPackets: source.rxPackets,
          recvBufActualMb: Math.round(((source.recvBufferSizeActual ?? 0) / 1024 / 1024) * 100) / 100,
          counters: {
            aborted: counters.aborted,
            badMagic: counters.badMagic,
            badLength: counters.badLength,
            crcFail: counters.crcFail,
            idxGap: counters.idxGap,
            dupChunk: counters.dupChunk,
            tsEpochReset: counters.tsEpochReset,
          },
          ws: wsCount,
          calFailures: link.statusView().calFailures,
        };
        process.send?.({ role: "gateway", done: true, result });
      })();
    });
    if (process.send === undefined) {
      console.log("[gateway-standalone] 链路就绪 on 127.0.0.1:" + GW_UDP_PORT + "（等负载流进来；" + WARMUP_MS + " ms 后测量）");
      runStandalone();
    } else {
      process.send({ role: "gateway", ready: true, port: source.localPort });
    }
  })();
}

// ————————————————————————— 父进程：编排 + 汇总 —————————————————————————
async function orchestrate(): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  // silent:true ⇒ 子进程 stdout/stderr 走管道：异常必须可见（不然只会看到"父进程超时"这种没法查的现象）
  const board = fork(self, [...argv, "--role", "board"], { execArgv: process.execArgv, silent: true });
  const gateway = fork(self, [...argv, "--role", "gateway"], { execArgv: process.execArgv, silent: true });
  gateway.stderr?.on("data", (d: Buffer) => process.stderr.write("[gateway] " + d.toString()));
  gateway.stdout?.on("data", (d: Buffer) => process.stdout.write("[gateway] " + d.toString()));
  board.stderr?.on("data", (d: Buffer) => process.stderr.write("[board] " + d.toString()));
  board.stdout?.on("data", (d: Buffer) => process.stdout.write("[board] " + d.toString()));
  const kill = (): void => {
    try { board.kill(); } catch { /* 已退 */ }
    try { gateway.kill(); } catch { /* 已退 */ }
  };
  console.log("===== ACK 高负载回环复现（生产链路 + 真实抓包字节 + 真实线速）=====");
  console.log("网关接收口 : " + BIND + ":" + GW_UDP_PORT + "（现场 1234 的等价物；recv-buf " + MB + " MB）");
  console.log("板端桩     : " + BIND + ":" + BOARD_PORT + "（现场 1235 的等价物；ACK → 网关接收口）");

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let started = false;
    let boardReady = false;
    let gwReady = false;
    const avgLen = { v: 1306 };   // 板端桩 ready 消息里带回真实平均包长（负载折算用）
    const maybeStart = (): void => {
      if (gwReady && boardReady && !started) {
        started = true;
        gateway.send?.({ cmd: "run" });
      }
    };
    const timer = setTimeout(() => {
      kill();
      reject(new Error("超时（网关子进程未报告结果）"));
    }, (WARMUP_MS + CMDS * (TIMEOUT_MS + 200) + 40_000));
    gateway.on("message", (m: unknown) => {
      const msg = m as { ready?: boolean; done?: boolean; result?: Record<string, unknown> };
      if (msg.ready === true) {
        gwReady = true;
        maybeStart();
      }
      if (msg.done === true && msg.result !== undefined) {
        clearTimeout(timer);
        // 收尾前把板端桩的发包数/ACK 数取回来（活体证据）
        board.send?.({ cmd: "stats" });
        const r = msg.result;
        r["rxMbpsInWindow"] = Math.round((Number(r["rxPps"] ?? 0) * avgLen.v) / 1024 / 1024 * 10) / 10;
        resolve(r);      }
    });
    board.on("message", (m: unknown) => {
      const msg = m as { ready?: boolean; stats?: boolean; segPackets?: number; segSeconds?: number; mbps?: number; sent?: number; acks?: number; loops?: number; sendDrops?: number };
      if (msg.ready === true) {
        boardReady = true;
        if (msg.segPackets !== undefined && msg.segSeconds !== undefined && msg.mbps !== undefined) {
          avgLen.v = Math.round((msg.mbps * 1024 * 1024 * msg.segSeconds) / msg.segPackets);
        }
        console.log("回放段     : " + msg.segPackets + " 包 / " + msg.segSeconds + " s ≈ " + msg.mbps + " MB/s（段循环续播）");
        maybeStart();
      }
      if (msg.stats === true) {
        console.log("板端桩     : 发包 " + msg.sent + "（发送失败 " + String(msg.sendDrops ?? 0) + "），ACK 回发 " + msg.acks + "，段循环 " + msg.loops + " 次");
      }
    });
    gateway.on("error", reject);
  });

  const ok = Number(result["ok"] ?? 0);
  const total = Number(result["total"] ?? 0);
  console.log("===== 结果 =====");
  console.log("命令 ACK   : OK=" + ok + " / " + total + "（超时=" + String(result["timeouts"]) + "）" +
    "  延迟 min/中位/p90/max = " + result["latMinMs"] + "/" + result["latMedianMs"] + "/" +
    result["latP90Ms"] + "/" + result["latMaxMs"] + " ms");
  console.log("逐条延迟   : " + JSON.stringify(result["latMs"]));
  console.log("命令窗口负载: " + String(result["rxPps"]) + " pps ≈ " + String(result["rxMbpsInWindow"]) +
    " MB/s（命令前 1 s 标定窗内收 " + String(result["probeRx"]) + " 包）");
  console.log("收包       : rxPackets=" + String(result["rxPackets"]) + "（内核缓冲实测 " + String(result["recvBufActualMb"]) + " MB）");
  console.log("计数器     : " + JSON.stringify(result["counters"]));
  console.log("WS 客户端  : " + JSON.stringify(result["ws"]));
  if (JSON_OUT) console.log("JSON " + JSON.stringify(result));
  kill();
  process.exitCode = ok >= 19 ? 0 : 1;
}

if (ROLE === "board") makeBoard();
else if (ROLE === "gateway") makeGateway();
else await orchestrate();
