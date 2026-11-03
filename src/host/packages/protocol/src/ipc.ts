// 网关 ↔ 浏览器 的唯一跨进程契约（04 文档 §7）。
// 二进制推流：16B 定长首部（大端）+ 负载；控制面：JSON-RPC 2.0 子集（同一 WS 连接）。
import { IPC, PIXEL } from "./constants.ts";
import type { Counters, SourceStats } from "./types.ts";

export type IpcType = typeof IPC.TYPE_FRAME_RAW | typeof IPC.TYPE_EVENTS | typeof IPC.TYPE_STATS;

export interface IpcFrameRaw {
  readonly type: "FRAME_RAW";
  readonly flags: number;
  readonly seq: number;
  readonly frameIdx: number;
  readonly tArriveMs: number;
  /**
   * 板端时间轴上的毫秒时刻（WIRE-V3 §4.3 帧时间轴；TS 无效/未知 offset 时为 undefined，
   * 前端回退用 tArriveMs）。载荷布局版本字节区分有无此字段，老前端/老记录不受影响。
   */
  readonly tBoardMs?: number;
  readonly w: number;
  readonly h: number;
  readonly pixel: typeof PIXEL.RGB565_BE | typeof PIXEL.RGB565_LE;
  readonly raw: Uint8Array;
}
export interface IpcEvents {
  readonly type: "EVENTS";
  readonly flags: number;
  readonly seq: number;
  readonly frameIdx: number;
  readonly tArriveMs: number;
  /** 事件记录长度（与 profile.evRecBytes 一致，参数化以支持缺口 G2 的两种取值） */
  readonly recBytes: number;
  readonly count: number;
  readonly data: Uint8Array;
}
/**
 * 串口事件支路状态（**UART 扩展 TLV 0x8E**，len 3；板端实现报告 §3.3，2026-10-12 对齐）。
 * 出现在 SET_PARAM 的 ACK（CTRL_LEN=23）与 GET_STATUS（CTRL_LEN=65，2026-10-13 sccb 集成后）。
 */
export interface V3SerStateView {
  /** SER_DECIM 读回：1..255 */
  readonly decim: number;
  /** SER_AGG 读回：0=RAW / 1=GRID 8×6 每帧 / 2=GRID 16×12 每 4 帧 */
  readonly agg: number;
  /** uartEvDrop：串口链路丢事件计数（8 bit，快变时单次读回可能瞬时不一致 —— 板端报告 R3） */
  readonly uartEvDrop: number;
}

/**
 * v3 状态视图（WIRE-V3 设计 §7.2 "TYPE_STATS 载荷扩展"）。
 * 网关随 STATS 推送；wireVer=2（未见到 v3 包）时字段多为 null。
 */
export interface V3StatusView {
  /** 当前线协议版本（见到首个 v3 包后为 3） */
  readonly wireVer: 2 | 3;
  /** 当前模式 0/1/2（数据包 MODE 与 STATUS 心跳双源，§3.3 第 5 条） */
  readonly mode: number | null;
  readonly tsCalibrated: boolean | null;
  readonly tsStale: boolean;
  readonly tsEpochReset: boolean;
  readonly tsOffsetUs: number | null;
  readonly tsRttUs: number | null;
  /** 最近一次校准的单向误差估计 err = ((t4'−t1) − RTT)/2（§5.1 第 5 步），ms */
  readonly tsAlignErrMs: number | null;
  /** 上次校准距今（墙钟 ms）；null = 从未校准 */
  readonly calAgeMs: number | null;
  /** 校准失败次数（重试超时累计） */
  readonly calFailures: number;
  readonly bootId: number | null;
  /** 板端读回参数（ACK 写后读回值，§6.3.1） */
  readonly theta: number | null;
  readonly minDl: number | null;
  /**
   * 事件支路使能**板端读回值**（v3.1 TLV 0x8C：EV_EN 的 ACK 与 GET_STATUS 尾部都携带；
   * 2026-10-11 与板端定案对齐，取代先前"PC 侧最近一次下发值"口径）。null = 板端尚未上报。
   */
  readonly evEn: boolean | null;
  /** 串口事件分辨率读回（**UART 扩展 TLV 0x8D**，len 1：0=全分辨率 / 1=÷2 / 2=÷4）。null = 尚未上报 */
  readonly evRes: number | null;
  /** 串口事件支路状态读回（**UART 扩展 TLV 0x8E**）。null = 尚未上报 */
  readonly serState: V3SerStateView | null;
  /** 网口可用性检测器状态（**UART 扩展 TLV 0x8F**：0=DOWN / 1=UP / 2=UNKNOWN，见 CTRL.NET_STATE）。null = 尚未上报 */
  readonly netState: number | null;
  /**
   * 曝光上限**板端读回值**（**sccb 集成增补 TLV 0x90**，len 2 BE，单位 = 行；2026-10-13 对齐）。
   * 出现在 SET_PARAM ACK（写后读回）与 GET_STATUS（板端 o_exp_cap 真值）；心跳不含。
   * 与 0x8C 同一口径：缺失（null）时保持现值，绝不用"下发值"顶掉板端真值。
   */
  readonly expCap: number | null;
  /**
   * 板端当前生效串口波特率（**串口提速增补 TLV 0x91**；2026-10-17）。
   * 单位 baud（115200/230400/460800/921600）；null = 板端尚未上报（旧位流 / 本包未携带）。
   */
  readonly serialBaud: number | null;
  /** 下行命令通道是否可用（--udp 数据源才有） */
  readonly downlinkAvailable: boolean;
}

export interface IpcStats {
  readonly type: "STATS";
  readonly flags: number;
  readonly seq: number;
  readonly frameIdx: number;
  readonly tArriveMs: number;
  readonly stats: SourceStats;
  readonly counters: Counters;
  /** v3 状态（网关未启用 v3 时为 undefined） */
  readonly v3?: V3StatusView;
  /**
   * 传输/串口状态（UART 路线，网关的 LiveTransportManager.statusView()：`{ decision, uart, probes }`）。
   * 用 unknown 透传而不是定契约类型：前端只做"有就显示"的宽容渲染，且网关换形状不该炸前端。
   * 非实时源（回放/合成）不带此字段。
   */
  readonly transport?: unknown;
  /**
   * 事件源（ADDITIVE，2026-10-17 六修）：board = 用板端事件段；host = 前端/网关用原始帧模拟。
   * 老前端忽略即可；新前端用它判断"EV_ONLY 下 host 模拟必然全黑"并自动切源。
   */
  readonly eventSource?: "board" | "host";
  /** 当前板端 MODE（ADDITIVE；无 v3 状态时为 undefined）。2 = EV_ONLY */
  readonly boardMode?: number;
  /** EV_ONLY 是否成立（ADDITIVE；板端只回传事件，没有 FRAME_RAW 可配） */
  readonly evOnlyActive?: boolean;
  /** 当前 WS 客户端数 / 其中慢客户端数（ADDITIVE；F2 单独降帧用） */
  readonly clients?: number;
  readonly slowClients?: number;
  /**
   * 当前数据源是否具备原始段（ADDITIVE，七修）：false = 串口事件-only 链路，永远不会有 FRAME_RAW。
   * 前端据此把"原始帧已冻结(EV_ONLY)"改成"串口模式：无原始画面"，而不是误报板端 EV_ONLY。
   */
  readonly rawCapable?: boolean;
}

/** 下行命令结果 / 不可用原因（WIRE-V3 §7.2 "新增 TYPE_CTRL"）。JSON 载荷，内容随事件类型变化 */
export interface IpcCtrl {
  readonly type: "CTRL";
  readonly flags: number;
  readonly seq: number;
  readonly frameIdx: number;
  readonly tArriveMs: number;
  readonly ctrl: Record<string, unknown>;
}
export type IpcMessage = IpcFrameRaw | IpcEvents | IpcStats | IpcCtrl;

function writeHeader(dv: DataView, type: number, flags: number, seq: number, frameIdx: number, tArriveMs: number, payloadLen: number): void {
  dv.setUint8(0, type);
  dv.setUint8(1, flags);
  dv.setUint16(2, seq & 0xffff);
  dv.setUint32(4, frameIdx >>> 0);
  dv.setUint32(8, tArriveMs >>> 0);
  dv.setUint32(12, payloadLen >>> 0);
}

/** 编码一条 IPC 消息（网关 → 浏览器） */
export function encodeIpc(m: IpcMessage): Uint8Array {
  if (m.type === "FRAME_RAW") {
    // 载荷布局：w2 h2 fmt1 ver1 [ver≥1: 板端 ms float64 8B] raw。
    // ver=0 保持 v2 老布局（无板端时间戳，老前端/老测试逐字节兼容）。
    const hasBoardTs = typeof m.tBoardMs === "number" && Number.isFinite(m.tBoardMs);
    const ver = hasBoardTs ? IPC.FRAME_LAYOUT_BOARD_TS : IPC.FRAME_LAYOUT_V2;
    const tsLen = hasBoardTs ? 8 : 0;
    const payloadLen = 6 + tsLen + m.raw.length;
    const out = new Uint8Array(IPC.HEADER + payloadLen);
    const dv = new DataView(out.buffer);
    writeHeader(dv, IPC.TYPE_FRAME_RAW, m.flags, m.seq, m.frameIdx, m.tArriveMs, payloadLen);
    dv.setUint16(IPC.HEADER, m.w);
    dv.setUint16(IPC.HEADER + 2, m.h);
    dv.setUint8(IPC.HEADER + 4, m.pixel);
    dv.setUint8(IPC.HEADER + 5, ver);
    if (hasBoardTs) dv.setFloat64(IPC.HEADER + 6, m.tBoardMs as number);
    out.set(m.raw, IPC.HEADER + 6 + tsLen);
    return out;
  }
  if (m.type === "EVENTS") {
    const payloadLen = 5 + m.data.length;                // count4 + recBytes1 + data
    const out = new Uint8Array(IPC.HEADER + payloadLen);
    const dv = new DataView(out.buffer);
    writeHeader(dv, IPC.TYPE_EVENTS, m.flags, m.seq, m.frameIdx, m.tArriveMs, payloadLen);
    dv.setUint32(IPC.HEADER, m.count);
    dv.setUint8(IPC.HEADER + 4, m.recBytes);
    out.set(m.data, IPC.HEADER + 5);
    return out;
  }
  if (m.type === "CTRL") {
    const json = new TextEncoder().encode(JSON.stringify(m.ctrl));
    const out = new Uint8Array(IPC.HEADER + json.length);
    const dv = new DataView(out.buffer);
    writeHeader(dv, IPC.TYPE_CTRL, m.flags, m.seq, m.frameIdx, m.tArriveMs, json.length);
    out.set(json, IPC.HEADER);
    return out;
  }
  const json = new TextEncoder().encode(JSON.stringify({
    stats: m.stats,
    counters: m.counters,
    ...(m.v3 === undefined ? {} : { v3: m.v3 }),
    ...(m.transport === undefined ? {} : { transport: m.transport }),
    ...(m.eventSource === undefined ? {} : { eventSource: m.eventSource }),
    ...(m.boardMode === undefined ? {} : { boardMode: m.boardMode }),
    ...(m.evOnlyActive === undefined ? {} : { evOnlyActive: m.evOnlyActive }),
    ...(m.clients === undefined ? {} : { clients: m.clients }),
    ...(m.slowClients === undefined ? {} : { slowClients: m.slowClients }),
    ...(m.rawCapable === undefined ? {} : { rawCapable: m.rawCapable }),
  }));
  const out = new Uint8Array(IPC.HEADER + json.length);
  const dv = new DataView(out.buffer);
  writeHeader(dv, IPC.TYPE_STATS, m.flags, m.seq, m.frameIdx, m.tArriveMs, json.length);
  out.set(json, IPC.HEADER);
  return out;
}

/** 解码一条 IPC 消息（浏览器侧）；不合法返回 null（不抛） */
export function decodeIpc(buf: Uint8Array): IpcMessage | null {
  if (buf.length < IPC.HEADER) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = dv.getUint8(0);
  const flags = dv.getUint8(1);
  const seq = dv.getUint16(2);
  const frameIdx = dv.getUint32(4);
  const tArriveMs = dv.getUint32(8);
  const payloadLen = dv.getUint32(12);
  if (IPC.HEADER + payloadLen > buf.length) return null;
  const p = IPC.HEADER;
  if (type === IPC.TYPE_FRAME_RAW) {
    if (payloadLen < 6) return null;
    const w = dv.getUint16(p);
    const h = dv.getUint16(p + 2);
    const pixel = dv.getUint8(p + 4) === 0 ? PIXEL.RGB565_BE : PIXEL.RGB565_LE;
    const layout = dv.getUint8(p + 5);
    const tsLen = layout >= IPC.FRAME_LAYOUT_BOARD_TS ? 8 : 0;
    if (payloadLen < 6 + tsLen) return null;
    const tBoardMs = tsLen > 0 ? dv.getFloat64(p + 6) : undefined;
    return {
      type: "FRAME_RAW", flags, seq, frameIdx, tArriveMs, w, h, pixel,
      ...(tBoardMs === undefined ? {} : { tBoardMs }),
      raw: buf.subarray(p + 6 + tsLen, p + payloadLen),
    };
  }
  if (type === IPC.TYPE_EVENTS) {
    if (payloadLen < 5) return null;
    const count = dv.getUint32(p);
    const recBytes = dv.getUint8(p + 4);
    return { type: "EVENTS", flags, seq, frameIdx, tArriveMs, count, recBytes, data: buf.subarray(p + 5, p + payloadLen) };
  }
  if (type === IPC.TYPE_CTRL) {
    try {
      const ctrl = JSON.parse(new TextDecoder().decode(buf.subarray(p, p + payloadLen))) as Record<string, unknown>;
      return { type: "CTRL", flags, seq, frameIdx, tArriveMs, ctrl };
    } catch { return null; }
  }
  if (type === IPC.TYPE_STATS) {
    try {
      const obj = JSON.parse(new TextDecoder().decode(buf.subarray(p, p + payloadLen))) as {
        stats: SourceStats; counters: Counters; v3?: V3StatusView; transport?: unknown;
        eventSource?: "board" | "host"; boardMode?: number; evOnlyActive?: boolean;
        clients?: number; slowClients?: number; rawCapable?: boolean;
      };
      return {
        type: "STATS", flags, seq, frameIdx, tArriveMs, stats: obj.stats, counters: obj.counters,
        ...(obj.v3 === undefined ? {} : { v3: obj.v3 }),
        ...(obj.transport === undefined ? {} : { transport: obj.transport }),
        ...(obj.eventSource === undefined ? {} : { eventSource: obj.eventSource }),
        ...(obj.boardMode === undefined ? {} : { boardMode: obj.boardMode }),
        ...(obj.evOnlyActive === undefined ? {} : { evOnlyActive: obj.evOnlyActive }),
        ...(obj.clients === undefined ? {} : { clients: obj.clients }),
        ...(obj.slowClients === undefined ? {} : { slowClients: obj.slowClients }),
        ...(obj.rawCapable === undefined ? {} : { rawCapable: obj.rawCapable }),
      };
    } catch { return null; }
  }
  return null;
}

/** 控制面：JSON-RPC 2.0 子集（04 文档 §7.2） */
export interface RpcRequest { readonly id: number; readonly method: string; readonly params?: unknown }
export interface RpcOk { readonly id: number; readonly result: unknown }
export interface RpcErr { readonly id: number; readonly error: { readonly code: number; readonly message: string } }
export type RpcResponse = RpcOk | RpcErr;

/** 已冻结的方法名（网关必须实现，前端只认这些）。board.* 为 WIRE-V3 §7.2 下行命令新增；
 *  board.evEn 为 v3.1 增补命令（EV_EN=0x05）新增 */
export const RPC_METHODS = [
  "session.snapshot", "transport.start", "transport.stop", "transport.uartGrab",
  "config.get", "config.set", "recorder.start", "recorder.stop",
  "export.start", "export.cancel", "plugin.list", "plugin.enable", "plugin.disable",
  "board.setParam", "board.setMode", "board.getStatus", "board.calibrate", "board.evEn",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];
