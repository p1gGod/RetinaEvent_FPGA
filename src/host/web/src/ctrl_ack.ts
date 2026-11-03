// 下行命令 ACK 的"要不要打扰用户"纯逻辑（十修）。
//
// 背景：九修为串口链路加了 1 Hz GET_STATUS 心跳。心跳 ACK 与用户命令 ACK 走同一条
// TYPE_CTRL/onCtrlEvent 通道；若前端照旧无条件弹 toast，串口模式下会每秒闪一次
// "GET_STATUS：板端 ACK OK"。这里把"心跳 = 不通知"的判定独立成纯函数，
// 便于单测（10 个心跳 + 1 个用户命令只产生 1 条通知）而不碰 DOM。
import type { IpcCtrl } from "@retina/protocol";

export type CtrlAckTone = "ok" | "error";

/** 一条值得让用户看到的命令结果（心跳 ACK 永远不会生成它） */
export interface CtrlAckNotice {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  readonly tone: CtrlAckTone;
  readonly opcode: number;
  readonly atMs: number;
}

const OP_NAMES: Readonly<Record<number, string>> = {
  0x01: "SET_PARAM",
  0x02: "SET_MODE",
  0x03: "TIME_SYNC",
  0x04: "GET_STATUS",
  0x05: "EV_EN",
};

export function ctrlName(opcode: number): string {
  return OP_NAMES[opcode] ?? "命令";
}

/**
 * 心跳 ACK 判据：网关十修起在 ctrl ACK payload 里带 `heartbeat: true`（ADDITIVE）。
 * 只在 kind=ack 且显式 true 时静默；缺字段的旧网关保持原行为。
 */
export function isHeartbeatAck(ctrl: Record<string, unknown>): boolean {
  return ctrl["kind"] === "ack" && ctrl["heartbeat"] === true;
}

/** ACK → 可展示通知；心跳 ACK 返回 null（调用方据此 console.debug 后直接 return） */
export function ctrlAckNotice(ctrl: IpcCtrl | Record<string, unknown>, nowMs: number = Date.now()): CtrlAckNotice | null {
  const c = ctrl as Record<string, unknown>;
  if (c["kind"] !== "ack" || isHeartbeatAck(c)) return null;
  const opcode = Number(c["opcode"] ?? -1);
  const name = ctrlName(opcode);
  const ok = c["ok"] === true;
  const detail = String(c["detail"] ?? "未知原因");
  return {
    name,
    ok,
    message: ok ? name + "：板端 ACK OK" : name + " 失败：" + detail,
    tone: ok ? "ok" : "error",
    opcode,
    atMs: nowMs,
  };
}

/**
 * "最近命令"列表 + 通知闸门。心跳 ACK 不进入 recent、也不产生返回值；
 * 用户自己发的命令（SET_PARAM / SET_MODE / TIME_SYNC / GET_STATUS / EV_EN）照旧。
 */
export class CtrlAckTracker {
  private readonly items: CtrlAckNotice[] = [];

  get recent(): readonly CtrlAckNotice[] {
    return this.items;
  }

  /** 返回 null = 心跳 ACK（静默）；否则返回通知并记入最近命令（最多 20 条）。 */
  note(ctrl: IpcCtrl | Record<string, unknown>, nowMs: number = Date.now()): CtrlAckNotice | null {
    const n = ctrlAckNotice(ctrl, nowMs);
    if (n === null) return null;
    this.items.push(n);
    if (this.items.length > 20) this.items.splice(0, this.items.length - 20);
    return n;
  }

  clear(): void {
    this.items.length = 0;
  }
}
