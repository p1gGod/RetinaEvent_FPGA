// v3 下行命令通道（WIRE-V3 设计 §6）：PC → 板，UDP 目的端口 1235。
// 为什么独立一个小 socket 而不复用 1234 的接收 socket：上行 socket 的职责是"长时间占住 1234 收流"
// （用户明确要求），发命令是低频动作（校准 10 分钟一次 + 用户点按钮），分开口互不拖累；
// 且 1235 目的端口是设计冻结值（§6.1），与上行源端口 1234 语义不同。
// 本类只做"字节出去"，协议含义（编码/ACK 匹配/节流）在 pipeline/v3link.ts —— 与 transport 层
// "不知道协议含义"的分工一致（04 §2 依赖方向）。
import dgram from "node:dgram";
import type { SourceError } from "@retina/protocol";
import { BOARD } from "@retina/protocol";

export interface DownlinkOptions {
  readonly boardIp?: string;
  readonly boardPort?: number;
  /** 发送失败回调（不 fatal：网线没插也要能看 UI 的错误提示） */
  readonly onError?: (e: SourceError) => void;
}

export class DownlinkSocket {
  private socket: dgram.Socket | null = null;
  private readonly boardIp: string;
  private readonly boardPort: number;
  private readonly onError: (e: SourceError) => void;

  constructor(opts: DownlinkOptions = {}) {
    this.boardIp = opts.boardIp ?? BOARD.ip;
    this.boardPort = opts.boardPort ?? BOARD.downPort;
    this.onError = opts.onError ?? (() => {});
  }

  /** 实际绑定端口（测试 port:0 时用；null = 未启动/未就绪） */
  get localPort(): number | null {
    const s = this.socket;
    if (s === null) return null;
    try {
      const a = s.address();
      return a !== null && typeof a === "object" ? a.port : null;
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.socket !== null) return;
    const socket = dgram.createSocket({ type: "udp4" });
    this.socket = socket;
    socket.on("error", (err: Error) => {
      this.onError({ code: "udp-downlink", message: err.message, fatal: false });
    });
    // bind 随机端口：内核挑一个，避免与 1234/1235 冲突
    socket.bind(0);
    // 测试进程不能被这个 socket 吊住（与 base.ts 的 unrefTimer 同理）
    socket.unref();
  }

  /** 发一帧下行命令。未 start 或 socket 异常时静默失败（调用方的 ACK 超时机制兜底） */
  send(bytes: Uint8Array): void {
    const s = this.socket;
    if (s === null) {
      this.onError({ code: "udp-downlink", message: "下行通道未启动，命令未发出", fatal: false });
      return;
    }
    try {
      s.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), this.boardPort, this.boardIp, (err) => {
        if (err !== null && err !== undefined) {
          this.onError({ code: "udp-downlink", message: "下行发送失败: " + err.message, fatal: false });
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onError({ code: "udp-downlink", message: "下行发送异常: " + message, fatal: false });
    }
  }

  close(): void {
    const s = this.socket;
    this.socket = null;
    if (s !== null) {
      try {
        s.close();
      } catch {
        // 已关/未 bind：收尾不值得崩进程
      }
    }
  }
}
