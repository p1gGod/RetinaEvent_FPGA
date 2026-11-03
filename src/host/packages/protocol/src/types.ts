// 协议层数据契约（冻结）。只放类型，不含运行时逻辑；前后端共用。
import type { COUNTER_KEYS } from "./constants.ts";

/** 通路类型：STREAM = UDP v2(udp_merge) / LEGACY = 例程 60 旧格式 / TELEM = UART */
export type Wire = "STREAM" | "LEGACY" | "TELEM";

/** 02 文档 §9 的 profile（上位机解析的唯一前提；缺它无法自描述，见缺口 G1） */
export interface Profile {
  readonly name: string;
  readonly wire: Wire;
  readonly magic: string;
  readonly frame: { readonly w: number; readonly h: number; readonly bytes: number; readonly pixel: "RGB565_BE" | "RGB565_LE" };
  /** 必须整除 frame.bytes */
  readonly rawChunk: number;
  /** 派生值 = frame.bytes / rawChunk，写出来便于核对 */
  readonly chunksPerFrame: number;
  /** 3~8；必须与 RTL 的 EV_REC_BYTES 一致（缺口 G2） */
  readonly evRecBytes: number;
  readonly evGrid: { readonly w: number; readonly h: number };
  readonly crc16: "none" | "present" | "auto";
  /** 仅用于反推相机帧率（H31） */
  readonly frameDecim: number;
  readonly udp: { readonly bind: string; readonly port: number; readonly board: string; readonly boardPort: number };
}

export type CountersKey = (typeof COUNTER_KEYS)[number];
/** 计数器：所有"丢弃/异常"都要计数并上屏（原则 P6） */
export type Counters = Record<CountersKey, number>;

/** 单条事件（已解码）：x∈[0,399]、y∈[0,239]、pol 1=ON 0=OFF */
export interface EventRecord {
  readonly x: number;
  readonly y: number;
  readonly pol: 0 | 1;
  /** 保留位原样带出，上位机不解释（前向兼容，缺口 G2） */
  readonly flags: number;
  /** EV_REC_BYTES>=5 时可能存在的 8bit 时间戳/序号，未使用为 0 */
  readonly ts: number;
}

export interface EventBatch {
  readonly records: readonly EventRecord[];
  readonly dropped: number;
  readonly thinned: boolean;
  /** 原始 EV_DATA 字节（导出用，避免重编码） */
  readonly raw?: Uint8Array;
}

/** v2 包解析结果（G3：允许"只有事件、没有原始段"的包） */
export interface ParsedV2 {
  readonly kind: "v2";
  readonly frameIdx: number;
  readonly segMask: number;
  readonly hasRaw: boolean;
  readonly hasEvents: boolean;
  readonly chunkIdx: number;
  readonly rawLen: number;
  readonly evLen: number;
  readonly raw: Uint8Array | null;
  readonly events: Uint8Array | null;
  readonly crc16Present: boolean;
  readonly warnings: readonly string[];
}

/** v3 CTRL 包控制头（设计 §6.2；24 B 包头之后的 6 B） */
export interface CtrlHeader {
  readonly opcode: number;
  readonly status: number;
  readonly seq: number;
  /** TLV / 裸载荷字节数（线上声明的 CTRL_LEN） */
  readonly ctrlLen: number;
  /** 控制头之后的原始字节（TLV 或 TIME_SYNC_REQ 的 BOARD_TS_US） */
  readonly payload: Uint8Array;
  /** payload 按 TLV 解析的结果（解析不出合法 TLV 时为空数组） */
  readonly tlv: readonly CtrlTlv[];
}

/** 一条 TLV：tag(1) + len(1) + value(len, BE)，值原样带出（解释在 interpretStatusTlvs） */
export interface CtrlTlv {
  readonly tag: number;
  readonly value: Uint8Array;
}

/** v3 包解析结果（WIRE-V3 设计 §2）。kind="v3"；CTRL 包 raw/events 恒 null */
export interface ParsedV3 {
  readonly kind: "v3";
  readonly ver: number;
  readonly hdrLen: number;
  readonly flags: number;
  /** 降级后的模式（MODE ≥ 3 按 MODE2 收事件，设计 §2.3） */
  readonly mode: number;
  /** 线上原始 MODE 字节（未知模式告警用） */
  readonly modeRaw: number;
  /** 与 v2 的 hasRaw/hasEvents 同义（FLAGS.bit0/bit1），装配层无需按 kind 分叉 */
  readonly hasRaw: boolean;
  readonly hasEvents: boolean;
  readonly chunkIdx: number;
  readonly frameIdx: number;
  readonly rawLen: number;
  readonly evLen: number;
  /** 48 bit 板端微秒时间戳；FLAGS.TS_VALID=0 时为 null（时间不可信，不参与帧时间轴） */
  readonly tsUs: number | null;
  readonly tsValid: boolean;
  readonly tsCalibrated: boolean;
  readonly firstOfFrame: boolean;
  readonly lastOfFrame: boolean;
  readonly ctrl: boolean;
  readonly evRecBytes: number;
  readonly raw: Uint8Array | null;
  readonly events: Uint8Array | null;
  readonly crc16Present: boolean;
  /** FLAGS.bit7=1 时非 null（ACK / 心跳 / TIME_SYNC_REQ） */
  readonly ctrlHeader: CtrlHeader | null;
  readonly warnings: readonly string[];
}

/** v1（例程 60）包：首包含 10B 头，其余包纯数据按序拼接 */
export interface ParsedV1 {
  readonly kind: "v1";
  readonly frameIdx: number;
  readonly isFirst: boolean;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}

/** 解析失败：reason 必须是计数器名之一（保证"失败可见"） */
export interface ParseFail {
  readonly ok: false;
  readonly reason: CountersKey;
  readonly detail?: string;
}
export type ParseOk<T> = { readonly ok: true; readonly value: T };
export type ParseResult<T> = ParseOk<T> | ParseFail;

/** 已装配好的一帧（不可变，原则 P2） */
export interface FramePacket {
  readonly frameIdx: number;
  /** 逻辑帧号：把 16bit 回绕展开成单调递增（02 文档 §2.7） */
  readonly seq: number;
  readonly w: number;
  readonly h: number;
  readonly raw: Uint8Array;
  readonly pixel: "RGB565_BE" | "RGB565_LE";
  readonly events: EventBatch;
  readonly tArriveMs: number;
  /**
   * 帧时间轴（WIRE-V3 设计 §4.3：= 该帧 FIRST_OF_FRAME 包的 TS_US）。
   * µs→ms 换算；板端未标 TS_CALIBRATED 且 PC 已知 offset 时由 PC 侧代加 offset。
   * TS_VALID=0 / v2 通路（无时间戳字段）时为 undefined ⇒ 上层回退用 tArriveMs。
   */
  readonly tBoardMs?: number;
  readonly synthetic: boolean;
}

/** 数据源统计（1 Hz 聚合） */
export interface SourceStats {
  /** 被接受的包数（= 容器包数 − 被拒包数）；重复块算"被接受" */
  readonly packets: number;
  /** 收到的全部字节（原始段 + 事件段），前端画带宽用 */
  readonly bytes: number;
  /** Σ 被接受包的 RAW_LEN（**事件字节不计入**，被拒包不计入） */
  readonly bytesRaw: number;
  /** Σ 被接受包的 EV_LEN（事件流量单独统计） */
  readonly bytesEvents: number;
  readonly pps: number;
  readonly bps: number;
  readonly lastFrameIdx: number;
  readonly wraps: number;
  readonly tNowMs: number;
}

/** UART 遥测载荷（02 文档 §5.1，注意载荷是小端） */
export interface Telemetry {
  readonly maxLineW: number;
  readonly maxLineH: number;
  readonly lineW: number;
  readonly frameCnt: number;
  readonly pclkPeriod: number;
  readonly pclkTotal: number;
}

/** UART 帧回传（8bit 灰度） */
export interface TeleFrame {
  readonly w: number;
  readonly h: number;
  readonly gray: Uint8Array;
  readonly source: "camera" | "pattern";
}
