// A5 回归（2026-10-09 KEY3 撕裂）：EVENTS 必须排在**它那一帧的** FRAME_RAW 之前。
// 前端收到 EVENTS 后按 frameIdx 入队（web/src/main.ts 的 evQueue），要等属于它的那一帧到达才置位；
// 若 FRAME_RAW 先发，队列里还没有本帧事件 ⇒ 只能等下一帧，画面必然差 1 帧（frameDecim 下约 300 ms）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { decodeIpc, getProfile } from "@retina/protocol";
import type { IpcMessage, Profile } from "@retina/protocol";
import { IpcHub } from "../src/ipc/ws.ts";
import type { GatewayControl } from "../src/ipc/ws.ts";
import { SynthTransport } from "../src/transport/synth.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("WS 推流顺序：EVENTS 先于同 frameIdx 的 FRAME_RAW（A5，否则前端必然差 1 帧）", async () => {
  const source = new SynthTransport({ profile, speed: 20, maxFrames: 3, eventsPerFrame: 12 });
  const control: GatewayControl = {
    start: () => source.start(),
    stop: () => source.stop(),
    getConfig: () => ({ profile: profile.name, wsPort: 0 }),
    setConfig: (patch) => ({ ...patch }),
    snapshot: () => ({ sourceKind: "synth" }),
  };
  const hub = new IpcHub({ port: 0, profile, source, control });
  const got: IpcMessage[] = [];
  let ws: WebSocket | null = null;
  try {
    await hub.ready();
    ws = new WebSocket(hub.url);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const m = decodeIpc(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (m !== null) got.push(m);
    });
    ws.on("error", () => {});
    await once(ws, "open");
    source.start();

    const ev = await waitFor(
      () => got.find((m) => m.type === "EVENTS" && m.frameIdx > 0),
      "带 frameIdx 的 EVENTS",
    );
    const idx = ev.frameIdx;
    const evAt = got.findIndex((m) => m === ev);
    const frameAt = await waitFor(
      () => {
        const i = got.findIndex((m) => m.type === "FRAME_RAW" && m.frameIdx === idx);
        return i < 0 ? undefined : i;
      },
      "同 frameIdx 的 FRAME_RAW",
    );
    assert.ok(
      evAt < frameAt,
      "EVENTS 必须排在同帧 FRAME_RAW 之前：EVENTS@" + evAt + " FRAME_RAW@" + frameAt + " (frameIdx=" + idx + ")",
    );
  } finally {
    if (ws !== null) ws.close();
    source.stop();
    await hub.close();
  }
});
