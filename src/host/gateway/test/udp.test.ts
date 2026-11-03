import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { getProfile } from "@retina/protocol";
import type { FramePacket, Profile } from "@retina/protocol";
import { UdpTransport } from "../src/transport/udp.ts";
import { encodeV2Packet } from "../src/transport/v2encode.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("UDP 源：实时收 750 个 v2 包 → 装配出 768000 B 的帧（与回放同一条解析路径）", async () => {
  // bind 127.0.0.1 + port 0：不碰真实板子/网段，也不与其它测试抢端口
  const src = new UdpTransport({ profile, bind: "127.0.0.1", port: 0, sendControl: false });
  const frames: FramePacket[] = [];
  const errors: string[] = [];
  src.on("frame", (f) => frames.push(f));
  src.on("error", (e) => errors.push(e.code));
  src.start();
  try {
    const t0 = Date.now();
    while (src.localPort === null && Date.now() - t0 < 3000) await sleep(5);
    const port = src.localPort;
    assert.ok(port !== null && port > 0, "UDP 源必须真的绑上端口");

    const raw = new Uint8Array(profile.frame.bytes);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + 5) & 0xff;
    const tx = dgram.createSocket("udp4");
    try {
      for (let ci = 0; ci < profile.chunksPerFrame; ci++) {
        const pkt = encodeV2Packet({
          frameIdx: 77,
          segMask: 1,
          chunkIdx: ci,
          raw: raw.subarray(ci * profile.rawChunk, (ci + 1) * profile.rawChunk),
        });
        // 逐包 await，并每 100 包让出一次事件循环：接收侧要先跑起来把内核缓冲抽干，
        // 否则 UDP 缓冲一满就丢包（丢的是原始段 ⇒ 帧不齐），那是测试环境噪声而不是被测行为
        await new Promise<void>((resolve, reject) => {
          tx.send(pkt, port, "127.0.0.1", (err) => (err === null || err === undefined ? resolve() : reject(err)));
        });
        if (ci % 100 === 99) await sleep(2);
      }
    } finally {
      tx.close();
    }

    const t1 = Date.now();
    while (frames.length === 0 && Date.now() - t1 < 3000) await sleep(5);
    assert.equal(frames.length, 1, "应收到 1 帧");
    const f = frames[0] as FramePacket;
    assert.equal(f.raw.length, 768000);
    assert.equal(f.frameIdx, 77);
    assert.deepEqual(f.raw, raw);
    assert.equal(src.counters.aborted, 0);
    assert.equal(errors.length, 0);
  } finally {
    src.stop();
  }
});
