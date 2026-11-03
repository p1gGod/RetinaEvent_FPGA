// 实时 UDP 源（L0）。只做 socket 收发与驱动，协议含义一概不知道（解析在 pipeline/processor）。
// 只收不发 是 04 §12 的最小权限原则；唯一的例外是 02 §6.1 实测的 '1'/'0' 起停字节。
import dgram from "node:dgram";
import type { ParsedV3, Profile, SourceError } from "@retina/protocol";
import { BaseFrameSource, unrefTimer } from "./base.ts";

export interface UdpOptions {
  readonly profile: Profile;
  /** 覆盖 profile.udp 的绑定位（PC 网卡必须与 RTL 里写死的 PC_IP 一致，02 §4） */
  readonly bind?: string;
  readonly port?: number;
  /** 起停时给板卡发 '1'/'0'（等价旧脚本行为）；测试里关掉 */
  readonly sendControl?: boolean;
  readonly boardIp?: string;
  readonly boardPort?: number;
  /**
   * 内核接收缓冲。为什么必须显式调大：2.5 MB/s 突发时默认缓冲只有几十 KB，
   * 事件循环一忙就整批丢包（丢的是原始段 ⇒ 帧永远凑不齐）。04 §10 的"≥3000 pkt/s 不丢"靠它。
   *
   * ⚠️ 2026-10-12 复盘（P0 上板验收报告 §5.4）：现场"线级 29.7 fps vs 网关装配 17.5 fps"的口径差
   * 就出在这里 —— 网关默认 **4 MB**，而同一台机器上独立的极简抓包器用 **16 MB** 能收到 99% 的块。
   * 17.8k pps × ~1300 B ≈ 22 MB/s 的突发下，4 MB 只装得下 ~180 ms，任何一次事件循环停顿
   * （WS 推 768 KB 大帧、PNG 编码、GC）都会整块丢包 ⇒ 一帧缺一块 ⇒ 整帧 aborted。
   * 故默认提到 **16 MB**（与抓包器同口径，复现见 `docs/.../UART实现_20261012/上位机实现报告.md` §5）。
   */
  readonly recvBufferSize?: number;
  /**
   * 绑定成功后多久"一个包都没收到"就报一次告警（毫秒；<=0 关闭；缺省 5000）。
   * 为什么必须要：Windows 上两个进程用 SO_REUSEADDR 绑同一 UDP 端口时，**先绑定者独占收包**，
   * 后启动的网关会"绑定成功但永远收 0 包" ⇒ 界面全黑且没有任何报错（2026-10-12 联板实测）。
   * 这类"静默失败"违背 P6（不静默）—— 绑定成功不等于接上了板子。
   */
  readonly stallWarnMs?: number;
  readonly frameTimeoutMs?: number;
  readonly evRingMaxBytes?: number;
  readonly onBound?: (bind: string, port: number) => void;
  /** v3 CTRL 包出口（ACK / 心跳 / TIME_SYNC_REQ → V3Link；WIRE-V3 §7.2） */
  readonly onCtrl?: ((pkt: ParsedV3) => void) | undefined;
  /** v3 数据包 MODE 观察者（网关维护 currentMode，§3.3 第 5 条） */
  readonly onV3Mode?: ((mode: number) => void) | undefined;
}

export class UdpTransport extends BaseFrameSource {
  /** 默认内核接收缓冲（16 MB）。见 UdpOptions.recvBufferSize 的复盘说明（P0 报告 §5.4） */
  static readonly DEFAULT_RECV_BUFFER = 16 * 1024 * 1024;

  private readonly options: UdpOptions;
  private socket: dgram.Socket | null = null;
  /** 本 socket 上实际收到的包数（"绑定成功"与"真的收到流"是两件事，P6 不静默的判据） */
  private rxPacketCount = 0;
  /**
   * 绑定失败原因（null = 还没失败）。为什么必须记住：
   * 绑定失败后 socket 处于 UNBOUND，收尾时若还调 send()（onStop 的起停字节），内核会把它**隐式绑定**
   * 到 0.0.0.0:随机端口并触发 listening ⇒ onBound 回调把"绑定失败"上报成"已绑定"（假成功日志）。
   */
  private bindError: string | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: UdpOptions) {
    super({
      profile: opts.profile,
      frameTimeoutMs: opts.frameTimeoutMs,
      evRingMaxBytes: opts.evRingMaxBytes,
      onCtrl: opts.onCtrl,
      onV3Mode: opts.onV3Mode,
    });
    this.options = opts;
  }

  /** 实际绑定到的端口（测试用 port:0 时才知道自己落在哪） */
  get localPort(): number | null {
    const socket = this.socket;
    if (socket === null) return null;
    try {
      const a = socket.address();
      return a !== null && typeof a === "object" ? a.port : null;
    } catch {
      // 还没 bind 完时 getsockname 会抛 EBADF —— 对调用方来说等价于"端口未知"
      return null;
    }
  }

  /** 本 socket 上累计收到的 UDP 包数（探测"网口在不在"与 /api 自检都读它） */
  get rxPackets(): number {
    return this.rxPacketCount;
  }

  /** 实际生效的内核接收缓冲（有些系统会夹到上限；上屏/自检比"我设了 4 MB"诚实） */
  get recvBufferSizeActual(): number | null {
    const socket = this.socket;
    if (socket === null) return null;
    try {
      return socket.getRecvBufferSize();
    } catch {
      return null;
    }
  }

  get boundAddress(): string {
    const b = this.options.bind ?? this.options.profile.udp.bind;
    const p = this.options.port ?? this.options.profile.udp.port;
    return b + ":" + p;
  }

  protected onStart(): void {
    const bind = this.options.bind ?? this.options.profile.udp.bind;
    const port = this.options.port ?? this.options.profile.udp.port;
    this.bindError = null;
    // reuseAddr：旧脚本/抓包工具同时开着时不至于抢不到端口（多收一份比收不到好）
    const socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true,
      recvBufferSize: this.options.recvBufferSize ?? UdpTransport.DEFAULT_RECV_BUFFER,
    });
    this.socket = socket;
    socket.on("message", (msg: Buffer) => {
      this.rxPacketCount++;
      // subarray 视图，不拷贝；解析层承诺不写输入（判据 P10）
      this.feed(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength), Date.now());
    });
    socket.on("error", (err: Error) => {
      // 记下失败原因：后面的隐式绑定/send 不能再把这次失败当成"已绑定"
      this.bindError = err.message;
      const e: SourceError = { code: "udp-socket", message: err.message, fatal: true };
      this.emitError(e);
    });
    socket.on("listening", () => {
      // 绑定失败后 Node 仍可能因 send() 的隐式绑定再触发 listening：绝不能报"已绑定"（假成功）
      if (this.bindError !== null) return;
      const onBound = this.options.onBound;
      if (onBound !== undefined) onBound(bind, port);
      this.sendControl("1");
      this.armStallWarn();
    });
    socket.bind(port, bind);
  }

  /**
   * 绑定后的"空转告警"（一次性）：窗口内收到 0 个包就报一条非致命错误。
   * 最可能的两种原因都写进消息里 —— 用户看到的是可执行的提示，而不是一块黑屏。
   */
  private armStallWarn(): void {
    const warnMs = this.options.stallWarnMs ?? 5000;
    if (warnMs <= 0) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!this.running || this.rxPacketCount > 0) return;
      this.emitError({
        code: "udp-stall",
        message:
          "UDP " + this.boundAddress + " 已绑定但 " + warnMs + " ms 内未收到任何包。" +
          "最常见原因：另一个旧网关进程仍占着同一端口（Windows 下先绑定者独占收包，" +
          "后启动者静默收 0 包）——请关闭其它 RetinaEvent 窗口后重启；" +
          "其次核对板卡是否在发流、网线插的口与 profile.udp.bind 是否同一网段。",
        fatal: false,
      });
    }, warnMs);
    unrefTimer(this.stallTimer);
  }

  protected onStop(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.sendControl("0");
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // 已经关了/还没 bind：收尾阶段不值得让进程崩（04 §8 的"不允许崩"）
      }
    }
  }

  /** 起停字节是既有板侧行为；失败只记录，不 fatal（网线没插也要能起 UI 看错误） */
  private sendControl(byte: "0" | "1"): void {
    if (this.options.sendControl === false) return;
    const socket = this.socket;
    if (socket === null) return;
    // 绑定失败后 socket 是 UNBOUND：send() 会让内核隐式绑到 0.0.0.0:随机端口（假"已绑定"），且字节也发不出去
    if (this.bindError !== null) return;
    const ip = this.options.boardIp ?? this.options.profile.udp.board;
    const port = this.options.boardPort ?? this.options.profile.udp.boardPort;
    const payload = Buffer.from(byte, "ascii");
    try {
      socket.send(payload, port, ip, (err) => {
        if (err !== null && err !== undefined) {
          this.emitError({ code: "udp-control", message: "控制字节 '" + byte + "' 发送失败: " + err.message, fatal: false });
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitError({ code: "udp-control", message: "控制字节 '" + byte + "' 发送异常: " + message, fatal: false });
    }
  }
}
