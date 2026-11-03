// 七修 S1/S2：串口链路（rawCapable=false）的无原始段事件包必须以 EV_ONLY 语义交付到 WS。
//
// 现场缺陷：串口 UART-LINK 只回传事件帧（MODE=0、RAW_LEN=0），装配器按 MODE 等原始帧 ⇒ 永不结算 ⇒ 页面全黑。
// S1：合成串口源（v3 / MODE=0 / RAW_LEN=0 / EV_LEN>0）1 s 内至少 5 批 EVENTS，带 FLAG_EV_ONLY + FLAG_NO_RAW，
//     逻辑帧号严格递增、全程无 FRAME_RAW、evDrop=0。
// S2：同一条包在 rawCapable=true 的源上不得被标 EV_ONLY（证明修复只对串口生效，UDP 行为不变）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { decodeIpc, encodeEvents, getProfile } from "@retina/protocol";
import type { EventRecord, IpcMessage, ParsedV3, Profile } from "@retina/protocol";
import { BaseFrameSource } from "../src/transport/base.ts";
import { FLAG_EV_ONLY, FLAG_NO_RAW, IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";

const profile: Profile = getProfile("retina-v2-800x480-e5") as Profile;
const REC = profile.evRecBytes;

function recs(tag: number, n: number): Uint8Array {
  const list: EventRecord[] = [];
  for (let i = 0; i < n; i++) list.push({ x: tag * 10 + i, y: tag, pol: i % 2 === 0 ? 1 : 0, flags: 0, ts: 0 });
  return encodeEvents(list, REC);
}

/** 串口实测包形态：v3 / MODE=0 / 无原始段 / 事件字节；帧号可冻结 */
function v3EventOnly(frameIdx: number, events: Uint8Array, tArriveMs: number): ParsedV3 {
  return {
    kind: "v3",
    ver: 3,
    hdrLen: 24,
    flags: 0b10 | 0b100 | 0b1000,
    mode: 0,
    modeRaw: 0,
    hasRaw: false,
    hasEvents: true,
    chunkIdx: 0,
    frameIdx,
    rawLen: 0,
    evLen: events.length,
    tsUs: tArriveMs * 1000,
    tsValid: true,
    tsCalibrated: true,
    firstOfFrame: true,
    lastOfFrame: true,
    ctrl: false,
    evRecBytes: REC,
    raw: null,
    events,
    crc16Present: true,
    ctrlHeader: null,
    warnings: [],
  };
}

/** 测试源：直接喂已解析包，绕开串口字节流（缺陷在装配/分发层，不在定帧） */
class PumpSource extends BaseFrameSource {
  constructor(rawCapable: boolean) {
    super({ profile, rawCapable });
  }
  pump(pkt: ParsedV3, tArriveMs: number): void {
    this.processor.assembler.push(pkt, tArriveMs);
  }
  tickAt(nowMs: number): void {
    this.processor.tick(nowMs);
  }
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function openHub(source: PumpSource, msgs: IpcMessage[]): Promise<{ hub: IpcHub; socket: WebSocket }> {
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "serial-pump" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  await hub.ready();
  const socket = new WebSocket(hub.url);
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (m !== null) msgs.push(m);
  });
  socket.on("error", () => {});
  await once(socket, "open");
  return { hub, socket };
}

test("S1 串口无原始段事件包：WS EVENTS 带 EV_ONLY+NO_RAW、逻辑帧号递增、无 FRAME_RAW、evDrop=0", async () => {
  const source = new PumpSource(false);
  const msgs: IpcMessage[] = [];
  let hub: IpcHub | null = null;
  let socket: WebSocket | null = null;
  try {
    ({ hub, socket } = await openHub(source, msgs));

    // 现场形态：串口事件帧 MODE=0、RAW_LEN=0、帧号冻结 6040；1 s 内 250 包（每包 4 条）
    const FROZEN = 6040;
    for (let i = 0; i < 250; i++) source.pump(v3EventOnly(FROZEN, recs((i % 40) + 1, 4), 1_000_000 + i * 4), 1_000_000 + i * 4);
    source.tickAt(1_000_000 + 250 * 4 + 40); // 排空最后一个 40 ms 时间窗

    const evOnly = await waitFor(() => {
      const list = msgs.filter((m): m is Extract<IpcMessage, { type: "EVENTS" }> => m.type === "EVENTS" && (m.flags & FLAG_EV_ONLY) !== 0);
      return list.length >= 5 ? list : undefined;
    }, "≥5 条 EV_ONLY EVENTS");

    assert.equal(msgs.filter((m) => m.type === "FRAME_RAW").length, 0, "串口没有原始段，绝不出现 FRAME_RAW");
    for (const m of evOnly) {
      assert.equal((m.flags & FLAG_NO_RAW) !== 0, true, "串口批必须带 FLAG_NO_RAW（前端据此切换文案）");
      assert.ok(m.count > 0);
      assert.equal(m.data.length, m.count * m.recBytes);
    }
    for (let i = 1; i < evOnly.length; i++) {
      assert.ok(evOnly[i]!.frameIdx > evOnly[i - 1]!.frameIdx, "EV_ONLY 批逻辑帧号必须严格递增");
    }
    assert.equal(source.counters.evDrop, 0, "时间窗兜底后 evDrop=0");
    assert.equal(source.counters.evOrphan, 0);
    assert.equal(source.rawCapable, false);
  } finally {
    socket?.close();
    if (hub !== null) await hub.close();
    source.stop();
  }
});

test("S2 rawCapable=true（UDP/回放）：同样的无原始段事件包不得标 EV_ONLY / NO_RAW", async () => {
  const source = new PumpSource(true);
  const msgs: IpcMessage[] = [];
  let hub: IpcHub | null = null;
  let socket: WebSocket | null = null;
  try {
    ({ hub, socket } = await openHub(source, msgs));
    source.start(); // 让停止时真的走 finish()，把 pending 纯事件批结算出来

    // 同样的包：MODE=0、RAW_LEN=0、帧号冻结。UDP 语义下它还在等自己的原始帧，不能提前按 EV_ONLY 交付。
    for (let i = 0; i < 3; i++) source.pump(v3EventOnly(6040, recs(i + 1, 3), 2_000_000 + i * 5), 2_000_000 + i * 5);
    source.stop();

    const batches = await waitFor(() => {
      const list = msgs.filter((m): m is Extract<IpcMessage, { type: "EVENTS" }> => m.type === "EVENTS");
      return list.length > 0 ? list : undefined;
    }, "rawCapable=true 的事件批（finish 结算）");
    for (const m of batches) {
      assert.equal((m.flags & FLAG_EV_ONLY) !== 0, false, "UDP/回放不得被标 EV_ONLY");
      assert.equal((m.flags & FLAG_NO_RAW) !== 0, false, "UDP/回放不得被标 NO_RAW");
    }
    assert.equal(msgs.filter((m) => m.type === "FRAME_RAW").length, 0);
    assert.equal(source.rawCapable, true);
  } finally {
    socket?.close();
    if (hub !== null) await hub.close();
    source.stop();
  }
});
