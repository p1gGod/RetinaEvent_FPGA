// 网关客户端（浏览器侧唯一的传输层）。
// 两条通路共用一条下游接口：WS 二进制消息经 protocol 的 decodeIpc 解出；连不上网关时自动回退到
// 页内合成源（synth.ts）——这样"没板子、没网关"也能演示，而前端其余部分完全不区分数据来源。
// 为什么回退要在这一层做：上层界面不该出现 if (offline) 分支，否则离线路径永远测不到。
import { decodeIpc } from "@retina/protocol";
import type { IpcMessage, Profile, RpcResponse } from "@retina/protocol";
import { SynthSource } from "../synth.ts";
import type { SourceKind, SourceStatus } from "../types.ts";

export type ClientMode = "auto" | "synth";

/** 断线重连退避（04 §7.2：指数退避，最多 5 次） */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const SYNTH_PUMP_MS = 6;
const RPC_TIMEOUT_MS = 3000;
/**
 * 传输方式切换的专用超时（B1）。
 * 为什么不能沿用 3 s：网关切串口是"打开 COM6 + 3×300 ms 握手 + 2×500 ms 间隔"，
 * 现场实测 1996 ms，机器慢/驱动重试时轻易过 3 s —— 3 s 超时会让前端误报"网关无响应"，
 * 而网关其实已经切过去了（页面无帧，看起来就是卡死，切回网口也没人再点）。
 * 20 s 只用于 config.set 的 transport/serialPort 调用，全局 RPC 仍是 3 s。
 */
export const TRANSPORT_SWITCH_TIMEOUT_MS = 20000;

export interface ClientOptions {
  readonly url: string;
  readonly profile: Profile;
  readonly onMessage: (m: IpcMessage) => void;
  readonly onStatus: (s: SourceStatus) => void;
  /** 每次拿到 session.snapshot 时回调（界面据此采用网关的**真实** profile，见 main.ts） */
  readonly onSnapshot?: (snapshot: unknown) => void;
}

interface Pending {
  readonly resolve: (r: RpcResponse) => void;
  readonly timer: number;
}

export class GatewayClient {
  private readonly opts: ClientOptions;
  private readonly synth: SynthSource;
  private ws: WebSocket | null = null;
  private pumpTimer = 0;
  private retryTimer = 0;
  private attempts = 0;
  private live = false;
  private mode: ClientMode = "auto";
  private wantEventSource: "board" | "host" = "board";
  private nextRpcId = 1;
  private readonly pending = new Map<number, Pending>();
  /** 最近一次 session.snapshot 的原始结果（面板显示网关版本/绑定地址用） */
  snapshot: unknown = null;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.synth = new SynthSource(opts.profile);
  }

  get sourceKind(): SourceKind {
    return this.live ? "gateway" : "synth";
  }
  get isLive(): boolean {
    return this.live;
  }
  get wsUrl(): string {
    return this.opts.url;
  }
  /** 界面用它高亮顶栏的"实时 / 合成源"段控 */
  get synthMode(): boolean {
    return this.mode === "synth";
  }

  /** 期望的事件来源；连上后会自动下发给网关（没连上时先记住） */
  get eventSource(): "board" | "host" {
    return this.wantEventSource;
  }

  /**
   * 切换事件来源：板端 v2 自带（board）还是上位机同构算法（host）。
   * 未连接时只记住，连上后补发 —— 否则"先点按钮再连网关"会静默失效。
   */
  setEventSource(kind: "board" | "host"): void {
    this.wantEventSource = kind;
    if (this.live) void this.rpc("config.set", { eventSource: kind });
  }

  start(): void {
    this.synth.start(performance.now());
    this.pumpTimer = window.setInterval(() => this.pump(), SYNTH_PUMP_MS);
    this.pushStatus(this.mode === "synth" ? "合成源模式：页内合成，不连网关" : "正在连接网关…");
    if (this.mode === "auto") this.connect();
  }

  /** 手动/自动模式：合成源模式只跑页内源，不再尝试连网关（用于"就地演示"） */
  setMode(mode: ClientMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "synth") {
      this.closeWs();
      this.live = false;
      this.attempts = 0;
      this.synth.start(performance.now());
      this.pushStatus("合成源模式（已断开网关）");
    } else {
      this.attempts = 0;
      this.connect();
    }
  }

  /** 立即重连（面板上的"重试"按钮/快捷键用） */
  retryNow(): void {
    this.attempts = 0;
    if (this.mode === "auto") this.connect();
  }

  close(): void {
    if (this.pumpTimer) window.clearInterval(this.pumpTimer);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.closeWs();
    this.synth.stop();
    for (const [, p] of this.pending) window.clearTimeout(p.timer);
    this.pending.clear();
  }

  /** 冻结画面时叫网关别推原始帧（事件与 STATS 照推，与 04 §7.2 背压一致） */
  flowPause(): void {
    void this.rpc("flow.pause");
  }
  flowResume(): void {
    void this.rpc("flow.resume");
  }

  /** JSON-RPC 子集；未连接直接返回 null（调用方据此把按钮标成不可用） */
  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<RpcResponse | null> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const id = this.nextRpcId++;
    const budget = Math.max(1, timeoutMs);
    return await new Promise<RpcResponse | null>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, budget);
      this.pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 单帧解码/绘制超过预算时告知界面（uiDrop 的本地口径） */
  private pump(): void {
    if (this.live) return;
    const msgs = this.synth.poll(performance.now());
    for (const m of msgs) this.opts.onMessage(m);
  }

  private connect(): void {
    if (this.mode !== "auto") return;
    this.closeWs();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.scheduleRetry("WS 地址非法");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.live = true;
      this.synth.stop();
      this.pushStatus("网关已连接 " + this.opts.url);
      void this.rpc("session.snapshot").then((r) => {
        if (r && "result" in r) {
          this.snapshot = r.result;
          this.opts.onSnapshot?.(r.result);
        }
      });
      // 补发"事件来源"偏好：用户可能先点了按钮、后连上网关
      if (this.wantEventSource !== "board") void this.rpc("config.set", { eventSource: this.wantEventSource });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        this.onRpcText(ev.data);
        return;
      }
      if (!(ev.data instanceof ArrayBuffer)) return;
      const msg = decodeIpc(new Uint8Array(ev.data));
      if (msg) this.opts.onMessage(msg);
      else this.opts.onStatus({ kind: this.sourceKind, connected: this.live, detail: "收到无法解析的 IPC 消息（已忽略）" });
    };
    ws.onerror = () => {
      /* onclose 一定会跟来，重连逻辑只放在 onclose，避免双触发 */
    };
    ws.onclose = () => {
      const wasLive = this.live;
      this.live = false;
      this.ws = null;
      this.synth.start(performance.now());
      this.scheduleRetry(wasLive ? "网关连接已断开" : "连接不上网关");
    };
  }

  private onRpcText(text: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof obj !== "object" || obj === null) return;
    const rec = obj as { id?: number };
    if (typeof rec.id !== "number") return;
    const p = this.pending.get(rec.id);
    if (!p) return;
    this.pending.delete(rec.id);
    window.clearTimeout(p.timer);
    p.resolve(obj as RpcResponse);
  }

  private scheduleRetry(reason: string): void {
    if (this.mode !== "auto") return;
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 16000;
    this.attempts++;
    const giveUp = this.attempts > BACKOFF_MS.length;
    this.pushStatus(
      giveUp
        ? reason + "：已重试 " + BACKOFF_MS.length + " 次，改用页内合成源（可手动重试）"
        : reason + "：" + Math.round(delay / 1000) + " s 后重试（第 " + this.attempts + "/" + BACKOFF_MS.length + " 次）",
    );
    if (giveUp) return;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private closeWs(): void {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch {
      /* 关闭失败不影响后续状态 */
    }
    this.ws = null;
  }

  private pushStatus(detail: string): void {
    this.opts.onStatus({ kind: this.sourceKind, connected: this.live, detail });
  }
}
