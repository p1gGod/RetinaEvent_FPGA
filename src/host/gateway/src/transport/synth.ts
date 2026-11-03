// 合成源（L0）：无板演示的保险丝（04 §1 形态 C 的对应物）。
// 关键点：它**自己造出线上字节**（v2encode）再喂进同一条解析路径，而不是直接构造 FramePacket ——
// 否则合成演示只能证明"渲染能跑"，证明不了"协议解析对"（原则 P4）。
import { MAX_PAYLOAD, OFF, SEG } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { BaseFrameSource, unrefTimer } from "./base.ts";
import { encodeEventChunk, encodeV2Packet } from "./v2encode.ts";

export interface SynthOptions {
  readonly profile: Profile;
  /** 0/缺省 = 无限（配合 speed>0 的实时演示）；speed<=0 时必须给正值 */
  readonly maxFrames?: number;
  /** <=0：同步全速灌完（测试）；>0：按 fps × speed 的节奏播放 */
  readonly speed?: number;
  /** 造帧速率，默认 3.3 fps（02 §3.1 的实测回传帧率） */
  readonly fps?: number;
  /** 起始帧号；给 65534 可以顺带验证 16bit 回绕 */
  readonly startFrameIdx?: number;
  readonly eventsPerFrame?: number;
  /** 指定"必丢"的段号（复现 g03 这类向量） */
  readonly dropChunks?: readonly number[];
  /** 随机丢包率 0..1（配合 seed 可复现） */
  readonly dropRate?: number;
  /** 指定"重复发"的段号（验证 dupChunk） */
  readonly dupChunks?: readonly number[];
  /** 相邻包乱序发送（装配按位图定位，顺序无关） */
  readonly reorder?: boolean;
  readonly seed?: number;
  readonly frameTimeoutMs?: number;
  readonly evRingMaxBytes?: number;
}

/** 确定性帧内容：测试可以脱开源实现重算同一串字节 ⇒ 能判"拼帧逐字节正确" */
export function synthRawFrame(frameIdx: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i + frameIdx * 101) & 0xff;
  return out;
}

/** 确定性事件记录（x∈[0,399], y∈[0,239]） */
export function synthEventRecords(frameIdx: number, count: number): { x: number; y: number; pol: 0 | 1 }[] {
  const out: { x: number; y: number; pol: 0 | 1 }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: (i * 7 + frameIdx * 3) % 400, y: (i * 13 + frameIdx) % 240, pol: i % 2 === 0 ? 1 : 0 });
  }
  return out;
}

export class SynthTransport extends BaseFrameSource {
  private readonly options: SynthOptions;
  private readonly recBytes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextIdx = 1;
  private rngState = 1;
  private framesGenerated = 0;
  private sent = 0;
  private dropped = 0;

  constructor(opts: SynthOptions) {
    if (opts.profile.wire === "TELEM") throw new Error("TELEM 通路不是 UDP 帧流，合成源只支持 STREAM/LEGACY");
    super({
      profile: opts.profile,
      synthetic: true,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
    });
    this.options = opts;
    this.recBytes = Math.max(3, Math.min(8, Math.floor(opts.profile.evRecBytes)));
  }

  get framesSent(): number {
    return this.framesGenerated;
  }
  get packetsSent(): number {
    return this.sent;
  }
  get packetsDropped(): number {
    return this.dropped;
  }

  protected onStart(): void {
    const speed = this.options.speed ?? 1;
    const maxFrames = this.options.maxFrames ?? 0;
    this.nextIdx = this.options.startFrameIdx ?? 1;
    this.rngState = this.options.seed ?? 0x12345678;
    if (speed <= 0) {
      if (maxFrames <= 0) throw new Error("同步模式（speed<=0）必须给 maxFrames，否则会死循环");
      while (this.framesGenerated < maxFrames) this.emitFrame(Date.now());
      this.processor.finish();
      return;
    }
    const fps = this.options.fps ?? 3.3;
    const intervalMs = Math.max(1, Math.round(1000 / (fps * speed)));
    // 一帧的包在一个 tick 内整批发出：演示要的是"帧率对"，包内节奏对装配算法没有意义
    this.timer = setInterval(() => {
      this.emitFrame(Date.now());
      if (maxFrames > 0 && this.framesGenerated >= maxFrames) this.stop();
    }, intervalMs);
    unrefTimer(this.timer);
  }

  protected onStop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private rng(): number {
    // xorshift32：不让合成源的丢包模式随 Math.random 漂移（回归测试要可复现）
    let x = this.rngState >>> 0;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x;
    return x / 0x1_0000_0000;
  }

  private emitFrame(nowMs: number): void {
    const idx = this.nextIdx & 0xffff;
    this.nextIdx = (this.nextIdx + 1) & 0xffff;
    this.framesGenerated++;
    const profile = this.options.profile;
    const raw = synthRawFrame(idx, profile.frame.bytes);
    const events = this.buildEventBytes(idx);
    const entries = this.splitFrame(idx, raw, events);
    const dropped = new Set(this.options.dropChunks ?? []);
    const dup = new Set(this.options.dupChunks ?? []);
    let t = nowMs;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e === undefined) continue;
      if (dropped.has(e.chunkIdx)) {
        this.dropped++;
        continue;
      }
      if (this.options.dropRate !== undefined && this.options.dropRate > 0 && this.rng() < this.options.dropRate) {
        this.dropped++;
        continue;
      }
      if (this.options.reorder === true && i % 2 === 0 && i + 1 < entries.length) {
        const nx = entries[i + 1];
        if (nx !== undefined) {
          this.feed(nx.bytes, t);
          this.sent++;
        }
      }
      this.feed(e.bytes, t);
      this.sent++;
      if (dup.has(e.chunkIdx)) {
        this.feed(e.bytes, t);
        this.sent++;
      }
      t += 1;
    }
  }

  private buildEventBytes(frameIdx: number): Uint8Array {
    const count = this.options.eventsPerFrame ?? 0;
    if (count <= 0) return new Uint8Array(0);
    return encodeEventChunk(synthEventRecords(frameIdx, count));
  }

  /** 按 profile 把一帧切成 v2 包；事件优先搭在原始包上，装不下就退化成纯事件包（缺口 G3） */
  private splitFrame(frameIdx: number, raw: Uint8Array, events: Uint8Array): { bytes: Uint8Array; chunkIdx: number }[] {
    const profile = this.options.profile;
    const chunk = profile.rawChunk;
    const n = profile.chunksPerFrame;
    // CRC16 尾部必须跟着 profile 走：RTL 的 udp_merge 是 CRC_EN=1（profile.crc16="present"），
    // 少了它每个包都会被判 badLength —— 合成源就"一个包都过不去"，而画面却是黑的（很难查）。
    const withCrc16 = profile.crc16 !== "none";
    const crcBytes = withCrc16 ? 2 : 0;
    const out: { bytes: Uint8Array; chunkIdx: number }[] = [];
    let evOff = 0;
    for (let ci = 0; ci < n; ci++) {
      const start = ci * chunk;
      const end = Math.min(start + chunk, raw.length);
      const rawSeg = raw.subarray(start, end);
      const capBytes = Math.max(0, Math.floor((MAX_PAYLOAD - OFF.HEADER - rawSeg.length - crcBytes) / this.recBytes)) * this.recBytes;
      const take = Math.min(capBytes, events.length - evOff);
      const evSeg = take > 0 ? events.subarray(evOff, evOff + take) : null;
      evOff += take;
      out.push({
        bytes: encodeV2Packet({
          frameIdx,
          segMask: evSeg === null ? SEG.RAW : SEG.RAW | SEG.EVENTS,
          chunkIdx: ci,
          raw: rawSeg,
          events: evSeg,
          withCrc16,
        }),
        chunkIdx: ci,
      });
    }
    // 剩余事件：纯事件包（SEG_MASK=0b10），CHUNK_IDX 无意义（02 §2.1）
    while (evOff < events.length) {
      const capBytes = Math.max(0, Math.floor((MAX_PAYLOAD - OFF.HEADER - crcBytes) / this.recBytes)) * this.recBytes;
      const take = Math.min(capBytes, events.length - evOff);
      out.push({
        bytes: encodeV2Packet({ frameIdx, segMask: SEG.EVENTS, chunkIdx: 0, raw: null, events: events.subarray(evOff, evOff + take), withCrc16 }),
        chunkIdx: 0,
      });
      evOff += take;
    }
    return out;
  }
}
