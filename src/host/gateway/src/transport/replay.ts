// 回放源（L0）：把 RTPKT 容器里的 UDP 负载按原速/全速喂进与实时完全相同的解析路径。
// 为什么它必须存在：M1 要在没有板子的情况下证明"协议理解无误"（01 §8、02 §10 的 6 个向量），
// 而且答辩现场可以用抓好的包代替实时流 —— 前提是回放与实时不能有第二条代码路径。
import { readFileSync } from "node:fs";
import { iterRtpkt } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { resolveInputPath } from "../paths.ts";
import { BaseFrameSource, unrefTimer } from "./base.ts";

export interface ReplayOptions {
  readonly profile: Profile;
  readonly path: string;
  /** <=0：同步全速灌完（回归测试）；>0：按回传带宽的倍速播放 */
  readonly speed?: number;
  readonly loop?: boolean;
  /** 参考负载速率；默认 02 §3.1 实测回传带宽 2.53 MB/s */
  readonly bytesPerSec?: number;
  readonly frameTimeoutMs?: number;
  readonly evRingMaxBytes?: number;
  readonly onLoaded?: (packets: number, bytes: number) => void;
}

const DEFAULT_BYTES_PER_SEC = 2_530_000;

export class ReplayTransport extends BaseFrameSource {
  private readonly options: ReplayOptions;
  private payloads: Uint8Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private virtualNowMs = 0;
  private loops = 0;

  constructor(opts: ReplayOptions) {
    super({
      profile: opts.profile,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
    });
    this.options = opts;
  }

  /** 容器里的包数；start() 之前为 0 */
  get packetCount(): number {
    return this.payloads.length;
  }

  get loopCount(): number {
    return this.loops;
  }

  protected onStart(): void {
    // start() 是同步接口：这里同步读+物化（向量是 MB 级，不值得为了异步读把 L0 接口改成 Promise）
    const file = readFileSync(resolveInputPath(this.options.path));
    const payloads: Uint8Array[] = [];
    let bytes = 0;
    for (const p of iterRtpkt(file)) {
      payloads.push(p);
      bytes += p.length;
    }
    this.payloads = payloads;
    this.cursor = 0;
    this.virtualNowMs = Date.now();
    const onLoaded = this.options.onLoaded;
    if (onLoaded !== undefined) onLoaded(payloads.length, bytes);
    const speed = this.options.speed ?? 1;
    if (speed <= 0) {
      this.drainAll();
      return;
    }
    this.timer = setInterval(() => this.pump(), 10);
    unrefTimer(this.timer);
  }

  protected onStop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 全速：一次喂完，时间戳用 1 ms/包 的虚拟时钟，避免帧超时误杀 */
  private drainAll(): void {
    let t = Date.now();
    for (const p of this.payloads) {
      this.feed(p, t);
      t += 1;
    }
    // 流结束 = 悬挂帧结算（g03 的 aborted=1）
    this.processor.finish();
  }

  private pump(): void {
    const speed = this.options.speed ?? 1;
    const bps = this.options.bytesPerSec ?? DEFAULT_BYTES_PER_SEC;
    const realNow = Date.now();
    if (this.cursor === 0 && this.payloads.length > 0) {
      const first = this.payloads[0];
      if (first !== undefined) {
        this.feed(first, realNow);
        this.cursor = 1;
        this.virtualNowMs = realNow;
      }
    }
    while (this.cursor < this.payloads.length) {
      const p = this.payloads[this.cursor];
      if (p === undefined) break;
      const needMs = (p.length / (bps * speed)) * 1000;
      if (this.virtualNowMs + needMs > realNow) break;
      this.virtualNowMs += needMs;
      this.feed(p, realNow);
      this.cursor++;
    }
    if (this.cursor >= this.payloads.length) {
      if (this.options.loop === true && this.payloads.length > 0) {
        this.cursor = 0;
        this.virtualNowMs = realNow;
        this.loops++;
        return;
      }
      // 播完：结算悬挂帧并停表（stop() 会清掉定时器）
      this.processor.finish();
      this.stop();
    }
  }
}
