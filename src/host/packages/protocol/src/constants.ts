// 线格式常量 —— 唯一权威定义处。
// 依据 host/docs/02_通信协议对齐.md。改线格式必须先改这里 + 02 文档，再改实现。
// ⚠️ 禁止在其它文件里散落偏移量/魔数（协议层只允许从这里取）。

/** UDP 包魔数（v2 与 v1 相同 —— 缺口 G6，故不能用魔数区分新旧格式）。保留供旧记录回放 */
export const MAGIC = new Uint8Array([0xf0, 0x5a, 0xa5, 0x0f]);

/**
 * UDP v3 魔数（WIRE-V3 设计 §2.1 / §6.1）：第 4 字节同时编码版本与方向。
 * 30 = 上行（板 → PC，端口 1234），31 = 下行（PC → 板，端口 1235）。
 * 前三字节与 v2 相同，便于嗅探器/抓包过滤器复用；分派只看第 4 字节（设计 §2.3 定位规则）。
 */
export const MAGIC_V3 = new Uint8Array([0xf0, 0x5a, 0xa5, 0x30]);
export const MAGIC_V3_DOWN = new Uint8Array([0xf0, 0x5a, 0xa5, 0x31]);

/** v3 线协议版本字节（设计 §2.1：魔数与 VER 必须同时匹配） */
export const WIRE_V3 = 3;

/**
 * UDP v3 上行 24 字节包头偏移（WIRE-V3 设计 §2.1 逐字节定义）。
 * v2 的 OFF 保留不动（旧记录/旧 pcap 回放只读路径，设计 §7.2"v2 常量改名而非删除"）。
 */
export const OFF3 = {
  MAGIC: 0,
  VER: 4,
  /** 头长自描述字节；=24，>24 时按它跳过附加头（前向兼容，设计 §2.3） */
  HDR_LEN: 5,
  FLAGS: 6,
  MODE: 7,
  CHUNK_IDX: 8,
  FRAME_IDX: 10,
  RAW_LEN: 12,
  EV_LEN: 14,
  /** 48 bit 板端微秒时间戳（大端），每包都带（设计 §4.2） */
  TS_US: 16,
  EV_REC_BYTES: 22,
  /**
   * 动作识别字节（**动作回传契约** §2.1，2026-10-29 启用）：
   * bit7 VALID | bit6..2 CONF(0..31) | bit1..0 CLASS(0..3)；识别未启用时板端写 0x00。
   * 位于 24 B 定长头内 ⇒ 所有 v3 上行包（数据/CTRL）都带它，不需要改包长。
   * 旧设计里这字节叫 RSVD（保留），语义现在归 ACTION —— 下方 RSVD 是兼容别名。
   */
  ACTION: 23,
  /** 旧名兼容：WIRE-V3 早期版本把 byte23 记为保留字节（现在 = ACTION） */
  RSVD: 23,
  /** 包头总长；偏移 24 起为 RAW_DATA */
  HEADER: 24,
} as const;

/** v3 FLAGS 位定义（设计 §2.1；v2 的 SEG_MASK 升级而来，bit0/bit1 语义不变） */
export const FLAGS3 = {
  RAW_PRESENT: 1 << 0,
  EV_PRESENT: 1 << 1,
  CRC_PRESENT: 1 << 2,
  TS_VALID: 1 << 3,
  TS_CALIBRATED: 1 << 4,
  FIRST_OF_FRAME: 1 << 5,
  LAST_OF_FRAME: 1 << 6,
  CTRL: 1 << 7,
} as const;

/** v3 MODE 字节（设计 §3.1；每包都带，是网关判断当前模式的主通道） */
export const MODE3 = { RAW_EV: 0, RAW_ONLY: 1, EV_ONLY: 2 } as const;

/**
 * v3 动作字节（byte23 = OFF3.ACTION）位域，唯一权威 = 动作回传契约 §2.1：
 * bit7 VALID；bit6..2 CONF（0..31，越大越可信）；bit1..0 CLASS（0..3）。
 * 为什么单独一组常量：协议解码、网关快照、前端卡片三处必须共用同一位定义，
 * 任何一处自己移位都会出现"卡片和 API 显示不同类别"的现场问题。
 */
export const ACT3 = {
  VALID: 1 << 7,
  CONF_SHIFT: 2,
  CONF_MASK: 0x1f,
  CLASS_MASK: 0x03,
} as const;

/**
 * CLASS 显示名（当前唯一权威语义；索引即 CLASS 值）。
 * 0=无动作/静止、1=手部开合（任一方向合并为一类）、2=横向挥手、3=保留
 * （**保留类必须当无动作、不执行任何映射**）。
 * 字节位域不变：bit7 VALID / bit6..2 CONF / bit1..0 CLASS；本轮只改显示文案，offset 23 不动。
 */
export const ACT_CLASS_NAMES = ["无动作", "手部开合", "横向挥手", "保留"] as const;

/**
 * v3 上限（设计 §2.3）：包头 +11 B 后事件段容量收窄为 165 B（33 条 5B 记录）。
 * RAW_LEN ≤ 1472−24−2 = 1446；EV_LEN ≤ 1472−24−2−1 = 1445。
 */
export const LIMITS3 = { MAX_PAYLOAD: 1472, RAW_LEN: 1446, EV_LEN: 1445 } as const;

/**
 * 串口波特率四档（**串口提速增补**，2026-10-17 与板端定案，契约见
 * `docs/05_实验与实测/串口提速与屏上状态_20261017/接口约定.md` §1）：
 * 线上只传 1 B 档位码（0..3），不传 baud 数值。顺序即 code 顺序，禁止重排。
 * 上行 TLV 0x91 的读回值也必须是这张表里的生效档。
 */
export const SERIAL_BAUD_RATES = [115200, 230400, 460800, 921600] as const;
export type SerialBaud = (typeof SERIAL_BAUD_RATES)[number];

/** baud 数值 → 档位码 0..3；非法档返回 null（调用方必须明确报错，不得静默取默认）。 */
export function serialBaudCode(baud: number): number | null {
  const i = SERIAL_BAUD_RATES.indexOf(baud as SerialBaud);
  return i >= 0 ? i : null;
}

/** 档位码 0..3 → baud 数值；未知码返回 null（旧/新固件前向兼容：不认识就是不认识）。 */
export function serialBaudOfCode(code: number): number | null {
  return SERIAL_BAUD_RATES[code] ?? null;
}

/**
 * v3 下行命令集（PC → 板，目的端口 1235；设计 §6）。
 * 全部幂等；SEQ 板端必须在 ACK 中回声（设计 §6.1）。
 *
 * ⚠️ EV_EN = 0x05 是对已冻结 v3 设计的**增补（v3.1，2026-10-11 用户批准）**：
 *   §6.1 的 OPCODE 表只定义了 0x01..0x04，按其编号规则取下一个未用命令码 0x05。
 *   语义 = 板上事件支路开关（1=使能 / 0=禁用；禁用时事件数据停止上行、原画回传不受影响）。
 *   载荷 1 B（0/1），ACK 复用 §6.2 通用机制（STATUS=OK / 非 0 值）。
 *   该命令码在设计文档维护时统一登记回 §6.1 —— 字节级定义见实现报告"协议增补 EV_EN"一节，
 *   板端并行实现方以同一规则取码，联板前双方核对字节一致。
 */
export const DOWNLINK = {
  PORT: 1235,
  /** 下行包定长头字节数（MAGIC_D 4 + VER 1 + OPCODE 1 + SEQ 2 + LEN 2） */
  HEADER: 10,
  OPCODE: { SET_PARAM: 0x01, SET_MODE: 0x02, TIME_SYNC: 0x03, GET_STATUS: 0x04, EV_EN: 0x05 } as const,
  STATUS: { OK: 0, BAD_CRC: 1, BAD_OPCODE: 2, BAD_LEN: 3, BAD_VALUE: 4, BUSY: 5, UNSUPPORTED: 6 } as const,
  /**
   * SET_PARAM 载荷 TLV tag（设计 §6.3.1）。
   * 0x07..0x0A 为 **v3.1+UART 扩展**（板端实现报告 §3.3 ④，2026-10-12 与板端字节级对齐）：
   * RTL `downlink_cmd.v` 的 T_EV_RES/T_SER_DECIM/T_SER_AGG/T_SER_FLUSH 与下表逐值一致。
   * 语义 = 按存在写 + SER_AGG 与 EV_RES 互斥（BAD_VALUE 整条不写）。
   * 0x0B 为 **sccb 集成增补**（2026-10-13 与板端字节级对齐，见本表 EXP_CAP 注释与 `EXP_CAP_LIMITS`）。
   */
  TAG: {
    THETA: 0x01,
    MIN_DL: 0x02,
    FRAME_DECIM: 0x03,
    EV_FLUSH_CYC: 0x04,
    TS_CAL_PERIOD_S: 0x05,
    TS_FORCE_CAL: 0x06,
    /** 串口事件分辨率档（0=全分辨率 / 1=÷2 / 2=÷4；板端坐标量化） */
    EV_RES: 0x07,
    /** 串口事件均匀抽点 1..255（每 N 条取第 N 条；默认 32） */
    SER_DECIM: 0x08,
    /** 串口事件聚合 0=RAW / 1=GRID 8×6 每帧 / 2=GRID 16×12 每 4 帧（默认 0） */
    SER_AGG: 0x09,
    /** RAW 档短帧看门狗 5..1000 ms（u16 BE；默认 20） */
    SER_EV_FLUSH_MS: 0x0a,
    /**
     * OV5640 AEC 曝光上限（**sccb 集成增补**，2026-10-13 与板端字节级对齐；
     * 板端 `downlink_cmd.v` 的 T_EXP_CAP 与 sccb_patch 的 EXP_CAP_MIN/MAX 逐值一致）。
     * len 2（u16 BE，单位 = 行，与 0x3a02/03/0x3a14/15 直接对应），值域见 `EXP_CAP_LIMITS`；
     * 越界 ⇒ STATUS=0x04 BAD_VALUE 且**整条 SET_PARAM 不写**（原子性同既有 tag）。
     * 复位默认 0x1710（5904）= 厂家基线原上限；写入后板端约 1 ms 内重跑整条曝光寄存器写序列，
     * 等值写入零副作用（不重触发）。ACK 带写后读回 TLV 0x90。
     */
    EXP_CAP: 0x0b,
    /**
     * 串口波特率档位（**串口提速增补 tag 0x0C**，2026-10-17 与板端定案）：
     * len 1，值 = 档位码 0..3（见 `SERIAL_BAUD_RATES`：0=115200/1=230400/2=460800/3=921600）。
     * 板端先写待生效、ACK 用 TLV 0x91 读回新档，ACK 全部字节发完且 TX 空闲后才切分频；
     * 旧位流可回 STATUS=0x04 BAD_VALUE / 不认该 tag（上位机据此走 B5 降级提示）。
     */
    SER_BAUD: 0x0c,
  } as const,
} as const;

/**
 * 板端 EXP_CAP 值域（**sccb 集成报告 §4.1 / §9.1**，2026-10-13）：
 * RTL `sccb_patch.EXP_CAP_MIN=4` / `EXP_CAP_MAX=5904`（= 0x1710 厂家基线原上限，不放宽）。
 * 越界时板端回 STATUS=BAD_VALUE **且整条 SET_PARAM 不写**（同包其它合法 tag 一并被拦）——
 * 上位机经 `clampExpCap()` 主动钳位，消除该连坐陷阱（与 `MIN_DL_LIMITS` 同一先例）。
 */
export const EXP_CAP_LIMITS = { MIN: 4, MAX: 5904 } as const;

/**
 * 板端 MIN_DL 寄存器值域（**统一把关报告 Q-7 / P-5**）：
 * RTL 寄存器为 9 bit（0..511），>511 → STATUS=BAD_VALUE **且 SET_PARAM 原子性整条不写**
 * （同包其它合法参数一并被拦）。上位机经 `clampMinDl()` 主动钳位，消除该连坐陷阱。
 * 单位/上限待算法组 U7 定案 —— 本钳位属总监建议的先行缓解，可回退（改回 0..65535 只需改此表）。
 */
export const MIN_DL_LIMITS = { MIN: 0, MAX: 511 } as const;

/**
 * v3 上行 CTRL 包（ACK / STATUS 心跳 / TIME_SYNC_REQ；设计 §6.2）。
 * 24 B v3 包头之后跟 6 B 控制头（OPCODE/STATUS/SEQ/CTRL_LEN），再跟 TLV 或裸载荷。
 */
export const CTRL = {
  /** 控制头字节数（OPCODE 1 + STATUS 1 + SEQ 2 + CTRL_LEN 2） */
  HEADER: 6,
  OPCODE: {
    SET_PARAM: 0x01,
    SET_MODE: 0x02,
    TIME_SYNC: 0x03,
    GET_STATUS: 0x04,
    /** 板端主动发起的时间校准请求（设计 §5.1） */
    TIME_SYNC_REQ: 0x83,
    /** 1 Hz 周期状态心跳（设计 §6.3.5） */
    STATUS_HEARTBEAT: 0xf0,
  } as const,
  /**
   * 上行 TLV tag（设计 §6.2 表；与下行 tag 命名空间独立）。
   * EV_EN=0x8C 为 v3.1 增补；0x8D/0x8E/0x8F 为 UART 板端扩展（板端实现报告 §3.2/§3.3，
   * 2026-10-12 字节级对齐：GET_STATUS CTRL_LEN=61 尾部追加、心跳 CTRL_LEN=25 尾追 0x8F）；
   * 0x90 为 **sccb 集成增补**（2026-10-13：SET_PARAM ACK / GET_STATUS 尾追，见 CTRL.LEN 登记表）。
   */
  TLV: {
    MODE: 0x81,
    THETA: 0x82,
    MIN_DL: 0x83,
    TS_OFFSET: 0x84,
    TS_RTT_US: 0x85,
    TS_FLAGS: 0x86,
    FRAME_IDX: 0x87,
    /**
     * DROP_PX / DROP_EV。**双语义**（2026-10-12 拆读，总监建议 P-2 方向一）：
     * ① 板端已烧录形态 = **单条 len 4**：值 = DROP_PX[15:8],PX[7:0],EV[15:8],EV[7:0]（先 PX 后 EV）；
     * ② 旧兼容形态 = 同 tag 出现两次、各 len 2（第一条 PX、第二条 EV）。
     * `interpretStatusTlvs` 两种都认 —— 单条 len≥4 优先拆读。
     */
    DROP: 0x88,
    BOOT_ID: 0x89,
    /**
     * FW_VER / WIRE_VER。**双语义**同 0x88：
     * ① 板端已烧录形态 = **单条 len 3**：值 = FW_VER[15:8],FW[7:0],WIRE_VER（先 FW 后 WIRE）；
     * ② 旧兼容形态 = 两条：第一条 len2 = FW_VER、第二条 len1 = WIRE_VER。
     */
    VERSION: 0x8a,
    UNSUPPORTED_TAGS: 0x8b,
    /**
     * EV_EN 写后读回（**v3.1 增补**，命令码 0x05；2026-10-11 与板端对齐定案）：
     * len 1，值 = 事件支路使能位（1=使能 / 0=禁用）。
     * 出现在两处：EV_EN 的 ACK（STATUS=OK + 本 TLV，CTRL_LEN=3）与 GET_STATUS 的 TLV 列表尾部
     * （随 0x8D/0x8E 之后，见 CTRL.LEN.GET_STATUS_ACK=61）。PC 侧事件开关状态以此读回为准。
     */
    EV_EN: 0x8c,
    /**
     * EV_RES 写后读回（**UART 扩展**，对应下行 tag 0x07）：len 1，0=全分辨率 / 1=÷2 / 2=÷4。
     * 出现在 SET_PARAM 的 ACK（CTRL_LEN=23）与 GET_STATUS（CTRL_LEN=65）。
     */
    EV_RES_STATE: 0x8d,
    /**
     * 串口事件支路状态（**UART 扩展**）：len 3 =
     * SER_DECIM(1，1..255) + SER_AGG(1，0=RAW/1=GRID8×6/2=GRID16×12) + uartEvDrop[7:0]（串口丢事件计数）。
     * 出现在 SET_PARAM 的 ACK 与 GET_STATUS。
     */
    SER_STATE: 0x8e,
    /**
     * 网口可用性检测器状态（**UART 扩展**，link_detect）：len 1，值见 CTRL.NET_STATE。
     * 出现在心跳 / 状态插发与 GET_STATUS 尾部；探测状态变化时板端立即插发一条心跳形态 CTRL。
     */
    NET_STATE: 0x8f,
    /**
     * EXP_CAP 写后读回（**sccb 集成增补**，对应下行 tag 0x0B；2026-10-13 与板端定案对齐）：
     * len 2（u16 BE，行），值域 4..5904（`EXP_CAP_LIMITS`）。
     * 出现在两处：SET_PARAM 的 ACK（STATUS=OK + 本 TLV，写后读回 = 本次写入值）与
     * GET_STATUS 的 TLV 列表尾部（真值源 = 板端 o_exp_cap 寄存器）。
     * **心跳 / 状态插发不含它**（CTRL_LEN=25 不变，避免无谓改心跳长度）。
     * 越界被拒时（STATUS=0x04 BAD_VALUE）本 TLV 仍返回**旧值**（芯片内未变）。
     */
    EXP_CAP_STATE: 0x90,
    /**
     * 串口当前生效波特率档位读回（**串口提速增补 TLV 0x91**，len 1，值 = `SERIAL_BAUD_RATES` 下标）。
     * 出现在 SET_PARAM ACK 的 TLV 末尾（0x90 之后）与 GET_STATUS ACK 末尾。
     * 缺 0x91 ⇒ 板端 = 旧位流，上位机 `boardBaud` 必须为 null（不得拿下发值顶替真值）。
     */
    SER_BAUD_STATE: 0x91,
    /**
     * 动作识别状态（**动作回传契约** §3，2026-10-29 新增 TLV 0x92）：len=1，值 = byte23 原样
     * （与包头 OFF3.ACTION 同一位域，便于抓包时只读 TLV 的行数器/上位机交叉核对）。
     * 只随 GET_STATUS(0x04) ACK 尾追：CTRL_LEN 68 → **71**；SET_PARAM ACK / 心跳 / 状态插发**不带**。
     * 上位机以 byte23 为主真值，TLV 只作旁证（缺它 ⇒ 板端旧位流，不影响解析）。
     */
    ACTION_STATE: 0x92,
  } as const,
  /**
   * CTRL_LEN 登记表（板端实现报告 §3.2/§3.3 + sccb 集成报告 §9.3 的字节级真值；与 RTL `ctrl_len_of` 逐值一致）。
   * ⚠️ 上位机解析**不硬断言**长度（按线上声明的 CTRL_LEN 自洽校验，天然前向兼容）；
   *    本表供测试/文档/联板核对引用 —— 板端改长度而这里没跟着改，就是两侧不再对齐的信号。
   * 2026-10-13（sccb 集成）：SET_PARAM ACK 19→**23**、GET_STATUS ACK 61→**65**（各尾追
   *    `90 02 <hi> <lo>` = EXP_CAP_STATE(4)）；**心跳/状态插发仍 25**（不含 0x90）。
   *   旧固件（19/61，无 0x90）与新固件（23/65）都能解析 —— 解析只看包内声明的长度。
   * 2026-10-17（串口提速）：SET_PARAM ACK 23→**26**、GET_STATUS ACK 65→**68**
   *   （各尾追 `91 01 <code>` = SER_BAUD_STATE(3)）；心跳仍 25。
   *   旧位流（无 0x91）的 23/65 仍能解析 —— 解析只按线上声明长度与 TLV 实际 len。
   */
  LEN: {
    SET_PARAM_ACK: 26,
    SET_MODE_ACK: 3,
    TIME_SYNC_ACK: 11,
    EV_EN_ACK: 3,
    GET_STATUS_ACK: 68,
    /**
     * GET_STATUS ACK 带 TLV 0x92（动作状态）后的长度：68 + 3（tag+len+1B）= **71**。
     * 只作测试/文档/联板核对引用 —— 解析仍只看线上声明的 CTRL_LEN（旧 68 位流照样能解析）。
     */
    GET_STATUS_ACK_ACT: 71,
    /** 1 Hz 心跳 / 状态插发（结构相同）：MODE(3)+TS_FLAGS(3)+DROP(6)+FRAME_IDX(4)+BOOT_ID(6)+NET_STATE(3) */
    HEARTBEAT: 25,
    TIME_SYNC_REQ: 6,
  } as const,
  /**
   * NET_STATE 值（TLV 0x8F，link_detect 唯一真值）：
   * 0=DOWN（网口不可用，UART 回传通道）/ 1=UP（网口可用）/ 2=UNKNOWN（尚未首判）。
   */
  NET_STATE: { DOWN: 0, UP: 1, UNKNOWN: 2 } as const,
  /** TS_FLAGS 位（设计 §6.2 tag 0x86） */
  TS_FLAG: { CALIBRATED: 1 << 0, STALE: 1 << 1, EPOCH_RESET: 1 << 2 } as const,
} as const;

/** v3 校准相关常量（设计 §5.2）：PC 主动校准周期默认 600 s；时间回退判定阈值 1 s */
export const CALIB = { PERIOD_US: 600_000_000, EPOCH_RESET_US: 1_000_000 } as const;

/** UDP v2（udp_merge）13 字节定长包头偏移。见 02 文档 §2.1 */
export const OFF = {
  MAGIC: 0,
  FRAME_IDX: 4,
  SEG_MASK: 6,
  CHUNK_IDX: 7,
  RAW_LEN: 9,
  EV_LEN: 11,
  /** 包头总长；偏移 13 起为 RAW_DATA */
  HEADER: 13,
} as const;

/** SEG_MASK 位定义 */
export const SEG = { RAW: 0b01, EVENTS: 0b10, RESERVED_MASK: 0b11111100 } as const;

/** UDP 负载硬上限 = 1500 − 20(IP) − 8(UDP)。事实登记册 H35 */
export const MAX_PAYLOAD = 1472;

/** UDP v1（厂家例程 60 格式）常量。见 02 文档 §4 */
export const V1 = { HEADER: 10, PKT_DATA: 1280, FIRST_PKT: 1290 } as const;

/** UART 遥测包：AA 55 54 4D | 16B 载荷 | CRC8（覆盖前 20 B，含魔数；与 RTL uart_link.v 一致） */
export const TELEM = { MAGIC: new Uint8Array([0xaa, 0x55, 0x54, 0x4d]), HDR: 4, PAYLOAD: 16, CRC: 1, TOTAL: 21 } as const;

/** UART 帧回传：A5 5A 46 4D | W(2,BE) | H(2,BE) | mode(1) | W*H 字节 */
export const FRAME_TELE = { MAGIC: new Uint8Array([0xa5, 0x5a, 0x46, 0x4d]), HDR: 9 } as const;

/** CRC8（遥测）：多项式 0x07，初值 0x00 */
export const CRC8 = { POLY: 0x07, INIT: 0x00 } as const;
// CRC16（v2 尾部）：poly 0x1021、init 0xFFFF、不反转、不异或输出 —— 即 CRC-16/CCITT-FALSE。
// 公开检查值：crc16("123456789") = 0x29B1（已由单元测试对拍）。
//
// ⚠️ 2026-10-06 修正：原为 XMODEM（init 0x0000，检查值 0x31C3），与 RTL 不一致。
//    RTL `udp_merge.v` 明确写 "CRC-16/CCITT-FALSE（poly 0x1021 / init 0xFFFF）"，
//    init 寄存器初值 `16'hFFFF`。用 `tb_udp_merge` dump 出的真实包字节实测：
//    605/605 个包的尾部 CRC 都等于 CCITT-FALSE，XMODEM 命中 0 个。
//    ⇒ 若保持 XMODEM，板子发来的**每一个包**都会被判 crcFail 丢弃，画面恒黑。
//    依据：RTL 为线格式权威（host/docs/02_通信协议对齐.md 开头立场）。
export const CRC16 = { POLY: 0x1021, INIT: 0xffff } as const;

/** 帧装配超时：≈3 个回传帧周期（3.3 fps）。见 04 文档 §5 */
export const FRAME_TIMEOUT_MS = 1000;

/**
 * 计数器名（状态栏必须逐项显示，原则 P6 "不静默"）。
 * 2026-10-11（WIRE-V3 §7.2）增补 9+1 个：badVersion / badHdrLen / modeNotice / tsEpochReset /
 * tsCalFail / idxWrap / dlCrcFail / dlBadOpcode / dlReject（§7.2 明列）+ modeConflict（§7.2 网关行
 * "MODE 双源校验不一致 ⇒ 计 modeConflict"）。
 * 2026-10-13 增补 1 个：**evOrphan**（事件无帧）—— 纯事件包先到、而它所属帧号已被跳过（丢帧/跳号/
 * 模式切换）且从未交付过 ⇒ 真正无法归属任何帧，显式丢弃并计数。修前这条路径是无条件清环＝静默丢失。
 * 见 `docs/05_实验与实测/网关事件修复_20261013/网关事件修复报告.md`。
 */
export const COUNTER_KEYS = [
  "badMagic", "badLength", "oversize", "truncated", "crcFail", "idxGap",
  "aborted", "dupChunk", "evPartial", "evDrop", "evOrphan", "uiDrop", "segInconsistent",
  "segNotice", "pluginTimeout", "pluginError",
  "badVersion", "badHdrLen", "modeNotice", "tsEpochReset", "tsCalFail", "idxWrap",
  "dlCrcFail", "dlBadOpcode", "dlReject", "modeConflict",
] as const;

/** 图层 z 序（03 文档 §3）。图层必须取这里的值，禁止各写各的 z */
export const LAYER_Z = {
  BACKGROUND: 0, RAW: 100, EVENTS: 200, HUD: 300, POSTPROC: 400, INTERACT: 500,
} as const;

/** IPC：WS 消息类型与 16 字节二进制首部（04 文档 §7.1） */
export const IPC = {
  TYPE_FRAME_RAW: 0x01,
  TYPE_EVENTS: 0x02,
  TYPE_STATS: 0x03,
  /** v3 下行命令结果 / 不可用原因（WIRE-V3 设计 §7.2 "新增 TYPE_CTRL"） */
  TYPE_CTRL: 0x04,
  HEADER: 16,
  /** FRAME_RAW 载荷布局版本：0 = 无板端时间戳（v2 老布局），1 = 版本字节后带 8B float64 毫秒 */
  FRAME_LAYOUT_V2: 0,
  FRAME_LAYOUT_BOARD_TS: 1,
  FLAG_THINNED: 0b0001,
  FLAG_KEYFRAME: 0b0010,
  FLAG_SYNTHETIC: 0b0100,
  /**
   * 这批事件是**上位机同构算法**算出来的，不是板端发来的（2026-10-06 新增）。
   * 前端据此在 L2 图层上标出来源 —— 否则"板端结果"和"上位机模拟结果"看起来一模一样，
   * 对照就失去意义了。
   */
  FLAG_HOST_SIM: 0b1000,
} as const;

/** 像素格式编码（02 文档 §1：RGB565 高位在前） */
export const PIXEL = { RGB565_BE: 0, RGB565_LE: 1 } as const;

/**
 * 板卡网络参数。注意：本工程 XDC 用**底板 GE1（Y18）**口；插口必须与 XDC 一致（H36/H45）。
 * downPort = v3 下行命令端口（WIRE-V3 设计 §6.1，避开上行 1234）。
 */
export const BOARD = { ip: "192.168.1.10", port: 1234, downPort: 1235, mac: "00-11-22-33-44-55", pcIp: "192.168.1.102" } as const;
