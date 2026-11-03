//==============================================================================
// udp_merge.v —— 统一 UDP 打包器（原始帧段 + 事件段 → 同一条 UDP 流）
//
// 规格：docs/子模块设计/L2_通信/udp_merge.md（v2）
//       docs/05_experiments/协议v3设计_20261009/v3线协议设计.md（v3，本轮实现）
// 时钟域：clk_eth（125 MHz，由 eth_udp 的 RGMII RX 路径给出）
// 语言：Verilog-2001，ANSI 端口，单文件单模块
//
//------------------------------------------------------------------------------
// v3 统一包格式（WIRE_VER=3，UDP 负载，大端 BE —— v3 设计 §2.1）
//------------------------------------------------------------------------------
//   偏移  字段          长度  说明
//   0     MAGIC         4     F0 5A A5 30（v3 上行）
//   4     VER           1     0x03
//   5     HDR_LEN       1     0x18 = 24
//   6     FLAGS         1     bit0 RAW_PRESENT bit1 EV_PRESENT bit2 CRC_PRESENT
//                            bit3 TS_VALID bit4 TS_CALIBRATED
//                            bit5 FIRST_OF_FRAME bit6 LAST_OF_FRAME bit7 CTRL
//   7     MODE          1     0=RAW_EV 1=RAW_ONLY 2=EV_ONLY（每包都带，§3.1）
//   8     CHUNK_IDX     2     0..599（EV_ONLY / CTRL 恒 0）
//   10    FRAME_IDX     2     每帧 +1，65536 回绕
//   12    RAW_LEN       2     0 / 1280 / 末包 ≤1280
//   14    EV_LEN        2     0 或 5 的倍数
//   16    TS_US         6     48 bit 微秒（BE），每包都带（§4.2）
//   22    EV_REC_BYTES  1     0x05（0 = 本包无事件段）
//   23    RSVD          1     0x00
//   24    RAW_DATA      RAW_LEN   RGB565 高字节在前
//   24+R  EV_DATA       EV_LEN    事件记录，每条 5 B
//   尾部  CRC16         2     CRC-16/CCITT-FALSE，覆盖 [0 .. 24+RAW_LEN+EV_LEN-1]
//
//   事件记录（5 B，BE）：b0=X[7:0] b1={7'b0,X[8]} b2=Y[7:0] b3={7'b0,POL} b4=FLAGS
//
// 三模式（§3.1）：MODE0=RAW+EV（默认）/ MODE1=仅 RAW（EV_LEN 恒 0，事件不采集）/
//   MODE2=仅事件（无 RAW 槽，纯事件包容量 289 条）。模式切换在**帧边界**生效：
//   mode_q 仅在"发送管线静止"（IDLE && chunk_idx==0 && 环空）时跟随 i_mode，
//   传输中的帧永远以旧模式完整发完（§3.3-2，一帧内 MODE 恒定）。
//
// CTRL 包插入路径（§6.2）：i_ctrl_* 推入 256 B 小 FIFO，i_ctrl_commit 提交一包；
//   发送优先级高于数据包；内容为 downlink_cmd 构好的完整 UDP 负载（含包头与 CRC）。
//   ⚠️ 修复 P0-STALL-20261012：CTRL 包启动**必须**与数据包一样等 i_tx_ready ——
//      原实现在 eth_udp 忙（W_LOAD/W_WAIT）时抢发，整包被厂家栈静默忽略且
//      ctrl_pending 已释放 ⇒ ACK/心跳永久丢失（现场：心跳 0.83 Hz、命令 ACK 偶发超时）。
//
//------------------------------------------------------------------------------
// v2 兼容（WIRE_VER=2 编译期开关，§8.3 回退方案）
//------------------------------------------------------------------------------
//   WIRE_VER=2 时本模块行为与 2026-10-11 之前的版本**逐拍一致**：13 B 包头
//   F0 5A A5 0F、SEG_MASK、EV 上限 175 B、无 MODE/TS/CTRL。v3 专属端口悬空安全
//   （v2 路径不引用它们）。tb_udp_merge（WIRE_VER=2）保持全绿即回归证据。
//
//------------------------------------------------------------------------------
// ⚠️ MTU 红线（事实 H35 / skill 陷阱 10）
//------------------------------------------------------------------------------
//   v3 最坏包长：RAW_EV = 24+1280+165+2 = 1471；EV_ONLY = 24+1445+2 = 1471；
//   CTRL ≤ 82 ⇒ 全部 ≤ 1472，以太网帧 ≤ 1518，永不越线。
//   ★ 修复 F1-20261013：上面的"永"字原来**不成立** —— 排空交换（drain_swap）路径
//     会把收集页积压（可达 289 条）与 RAW 段同包组包（24+1280+1445+2 = 2751 B），
//     被 eth_udp 硬截断在 1472 B、事件尾部与 CRC 丢失（θ=1/δL=1 现场 26581/139802 包）。
//     修复：混合包上限判据改为"本包事件条数 > 33"（覆盖 drain 路径）+ 事件条数硬钳位
//     （见 ev_pure_pkt / ev_build_cap）。回归 TB：tb_udp_mtu_cap（修复前 FAIL → 修复后 PASS）。
//
//------------------------------------------------------------------------------
// 实现要点（v2 沿革，勿回退）
//------------------------------------------------------------------------------
//   · 原始段：像素按 16 bit 写入 CHUNK_SLOTS 槽环形缓冲（每槽 640 px = 1280 B）。
//   · 事件段：双页事件 RAM（收集页 / 待发页），包开始锁存待发页条数。
//     ★ v3：页深 289（MODE2 满包容量）；写入门限 = 当前模式容量（MODE2=289，
//       其余=33），保证"待发页 ≤ 本包容量"（发送即清空语义不变，无静默丢失）。
//   · 发送握手：i_tx_ready=1 时 o_tx_start 拉高 1 拍（同拍 o_tx_len 有效），
//     随后连续 o_tx_len 拍 o_tx_byte_en=1 推送负载字节。
//   · ⚠️ 两个已实测踩到的坑（勿回退）：
//     1) raw_ram/ev_ram 同步读 1 拍延迟，预取必须提前一拍；
//     2) 块缓冲地址 ≥12 bit（3×640+639=2559，10 bit 会回绕）。
//   · ⚠️ ram_style 与"无复位写口"是必须的（实测 2026-10-06，见下方注释）。
//
// 文档偏离（已报 lead，见 WP-D 报告与 v3 实现报告）：
//   1) RAW_CHUNK 默认 1280（文档 §3 写 1024）—— MTU 红线与 600 包整除。
//   2) 新增端口 i_tx_ready / i_cfg_en / o_stat_drop_px / o_stat_drop_ev / CRC16。
//   3) v3 新增端口 i_mode / i_ts_us / i_ts_valid / i_ts_calibrated / i_ev_en /
//      i_frame_decim / i_ev_flush_cyc / i_ctrl_* / o_ctrl_empty / o_frame_idx。
//   4) §5.1(3) 与 §6.3.3 的 offset 公式矛盾 → 以 §6.3.3 为准（见 ts_gen.v 头注）。
//==============================================================================

module udp_merge #(
    parameter WIRE_VER     = 3,           // 3 = v3 24B 包头；2 = v2 13B 包头（回退开关）
    parameter RAW_CHUNK    = 1280,        // 每包原始段字节数（必须整除 768000）
    parameter EV_REC_BYTES = 5,           // 每条事件记录字节数
    parameter EV_MAX_BYTES = 400,         // 每包事件段上限（被 MAX_PAYLOAD 自动钳位）
    parameter FRAME_DECIM  = 8,           // 原始帧回传抽帧比（v2 编译期值；v3 由 i_frame_decim 运行时给）
    parameter MAX_PAYLOAD  = 1472,        // UDP 负载硬上限（1500-20-8）
    parameter IMG_W        = 800,         // 原始帧宽（像素）
    parameter IMG_H        = 480,         // 原始帧高（像素）
    parameter EV_FLUSH_CYC = 65536,       // 事件看门狗（v2 编译期值；v3 由 i_ev_flush_cyc 运行时给）
    parameter CHUNK_SLOTS  = 4,           // 原始段环形缓冲槽数（≥2）
    parameter CRC_EN       = 1            // 1 = 尾部带 CRC16，0 = 不带
)(
    input  wire        clk_eth,           // 以太网域时钟（125 MHz）
    input  wire        rst_n_eth,         // 以太网域复位，低有效
    // ---- 原始帧流（CDC 后，clk_eth 域，1 px/clk）----
    input  wire        i_raw_valid,
    input  wire [15:0] i_raw_data,        // RGB565，高字节先出
    // ★ SEAM-LINKDROP-20261017：源侧"每帧首像素"marker（与 i_raw_data 同拍，1 = 本拍像素
    //   是相机帧的第 0 个像素）。它由 display_path 产生，和像素一起过 raw CDC FIFO 的
    //   第 17 bit ⇒ 无论中间丢多少像素/包，marker 与像素的相对顺序永远不脱钩。
    //   0 = 该源不提供 marker ⇒ 本模块退化为旧行为（帧首由自己数出来），见下方
    //   "兼容路径"。真实相机通路第一帧就有 marker，兼容路径在上板时永不启用。
    input  wire        i_raw_frame_start,
    // ---- 事件流（CDC-3 后，clk_eth 域）----
    input  wire        i_ev_valid,
    input  wire [8:0]  i_ev_x,
    input  wire [7:0]  i_ev_y,
    input  wire        i_ev_pol,
    // ---- 与 eth_udp 的握手 ----
    input  wire        i_tx_ready,        // eth_udp 可接收新包
    input  wire        i_cfg_en,          // 上行回传硬门（⚠️ 恒 1'b1 由 event_sink 接；
                                          //   0 = 停止数据包回传，画面不受影响。
                                          //   ★ 不得接 EV_EN/事件支路使能 —— 停流根因，
                                          //   见 event_sink 内 P0-STALL-20261012 注释）
    output reg         o_tx_start,        // 1 拍：请求发一包（同拍 o_tx_len 有效）
    output reg  [7:0]  o_tx_byte,         // 负载字节
    output reg         o_tx_byte_en,      // 字节有效
    output reg  [15:0] o_tx_len,          // 本包负载长度
    // ---- v3：三模式 / 时间戳 / 事件支路使能 / 运行时参数 ----
    input  wire [1:0]  i_mode,            // 0=RAW_EV 1=RAW_ONLY 2=EV_ONLY（sys_ctrl 同步副本）
    input  wire [47:0] i_ts_us,           // 对齐后 48bit µs（ts_gen）
    input  wire        i_ts_valid,        // FLAGS.bit3
    input  wire        i_ts_calibrated,   // FLAGS.bit4
    input  wire        i_ev_en,           // v3.1 EV_EN：0 = 不采集/不上行事件（原始回传不受影响）
    input  wire [7:0]  i_frame_decim,     // 运行时抽帧比（1..255；SET_PARAM tag 0x03）
    input  wire [23:0] i_ev_flush_cyc,    // 运行时事件看门狗（SET_PARAM tag 0x04）
    // ---- v3：动作字节（M4b；clk_eth 域，来自 act_state_cdc 的锁存输出）----
    //   byte23 = {VALID, CONF[4:0], CLASS[1:0]}；本模块在帧边界锁存一份，
    //   同一帧所有分片包用同一个值（契约 §2.5）。未接/无动作时恒 8'h00。
    input  wire [7:0]  i_act_byte,
    // ---- v3：下行 CTRL 包插入（downlink_cmd → 本模块小 FIFO）----
    input  wire        i_ctrl_wr_en,
    input  wire [7:0]  i_ctrl_data,
    input  wire        i_ctrl_commit,     // 1 拍：一包提交（长度 = 自上次发送起累计字节数）
    output wire        o_ctrl_empty,      // 1 = 可接收新 CTRL 包（生产者先查后建）
    // ---- 统计（调试/遥测）----
    output reg  [15:0] o_stat_drop_px,    // 因环形缓冲满而丢弃的像素数（自由计数）
    output reg  [15:0] o_stat_drop_ev,    // 因事件页满而丢弃的事件数（自由计数）
    output wire [15:0] o_frame_idx        // 当前帧序号（心跳/GET_STATUS TLV 0x87）
);

    //--------------------------------------------------------------------------
    // 常量
    //--------------------------------------------------------------------------
    localparam IS_V3            = (WIRE_VER >= 3);
    localparam HEAD_BYTES       = IS_V3 ? 24 : 13;
    localparam CRC_BYTES        = (CRC_EN != 0) ? 2 : 0;
    localparam PIX_PER_CHUNK    = RAW_CHUNK / 2;                       // 640
    localparam PIX_PER_FRAME    = IMG_W * IMG_H;                       // 384000
    localparam CHUNKS_PER_FRAME = PIX_PER_FRAME / PIX_PER_CHUNK;       // 600
    // 混合包事件容量：(MTU - 头 - RAW - CRC)/5*5 → v3=165(33条) / v2=175(35条)
    localparam EV_MAX_EFF       = ((MAX_PAYLOAD - HEAD_BYTES - RAW_CHUNK - CRC_BYTES)
                                   / EV_REC_BYTES) * EV_REC_BYTES;
    localparam EV_MAX_USE       = (((EV_MAX_BYTES < EV_MAX_EFF) ? EV_MAX_BYTES : EV_MAX_EFF)
                                   / EV_REC_BYTES) * EV_REC_BYTES;
    // 纯事件包容量（v3 EV_ONLY）：(MTU - 头 - CRC)/5*5 = 1445 B（289 条）；v2 = EV_MAX_USE
    localparam EV_PURE_BYTES    = IS_V3 ? (((MAX_PAYLOAD - HEAD_BYTES - CRC_BYTES)
                                          / EV_REC_BYTES) * EV_REC_BYTES) : EV_MAX_USE;
    localparam CAP_MIXED        = EV_MAX_USE  / EV_REC_BYTES;          // 33 (v3) / 35 (v2)
    localparam CAP_PURE         = EV_PURE_BYTES / EV_REC_BYTES;        // 289 (v3) / 35 (v2)
    localparam PAGE_REC         = CAP_PURE;                            // 事件页深（两页各一）
    localparam SLOTS            = (CHUNK_SLOTS < 2) ? 2 : ((CHUNK_SLOTS > 4) ? 4 : CHUNK_SLOTS);

    // 显式位宽常量（避免对无位宽 parameter 做位选，Verilog-2001 保守写法）
    localparam [15:0] HEAD_W      = HEAD_BYTES;
    localparam [15:0] CRC_W       = CRC_BYTES;
    localparam [15:0] RAW_CHUNK_W = RAW_CHUNK;
    localparam [10:0] PIXCH_11    = PIX_PER_CHUNK;
    localparam [9:0]  CAPMIX_10   = CAP_MIXED;
    localparam [9:0]  PAGE_10     = PAGE_REC;
    localparam [8:0]  CAPMIX_9    = CAP_MIXED;
    localparam [8:0]  CAPPURE_9   = CAP_PURE;
    localparam [4:0]  HEAD_M1     = HEAD_BYTES - 1;
    localparam [2:0]  EVREC_M1    = EV_REC_BYTES - 1;
    localparam [9:0]  PIXCH_M1    = PIX_PER_CHUNK - 1;
    localparam [15:0] CHUNK_M1    = CHUNKS_PER_FRAME - 1;
    localparam [15:0] DECIM_M1    = FRAME_DECIM - 1;
    localparam [18:0] PIXFR_M1    = PIX_PER_FRAME - 1;
    localparam [2:0]  SLOTS_3     = SLOTS;
    localparam [1:0]  SLOT_LAST   = SLOTS - 1;

    localparam [2:0] S_IDLE = 3'd0, S_HDR = 3'd1, S_RAW = 3'd2,
                     S_EV   = 3'd3, S_CRC = 3'd4, S_DONE = 3'd5, S_CTRL = 3'd6;

    //--------------------------------------------------------------------------
    // 存储
    //   raw_ram：SLOTS 槽 × 640 px × 16 bit（环形块缓冲）
    //   ev_ram ：2 页 × PAGE_REC 条 × 18 bit（{X[7:0],X[8],Y[7:0],POL}）
    //            v3 页深 289（MODE2 满包），v2 页深 35（与旧版一致）
    //
    // ⚠️ ram_style 是**必须**的，不是优化（实测 2026-10-06）：
    //   不加属性时 Vivado 会把两个数组都落到触发器上（raw_ram 40,960 FF +
    //   ev_ram 上万 FF），控制集爆掉 place_design（[Place 30-487]）。
    //   ev_ram 页深 289×18×2 ≈ 10.4 Kb → 分布式 RAM（LUTRAM）。
    //--------------------------------------------------------------------------
    (* ram_style = "block" *)       reg [15:0] raw_ram [0 : SLOTS*PIX_PER_CHUNK - 1];
    (* ram_style = "distributed" *) reg [17:0] ev_ram  [0 : 2*PAGE_REC       - 1];

    // ★ 修复 RAW-PHASE-20261017：每槽标签（像素域帧号 / chunk 号，槽首锁存）
    //   小数组（SLOTS×16×2 bit），写口在下方"无复位存储写口"块里，读口组合。
    //   语义：槽的所有权不变（wr_slot = rd_slot + n_full），标签只是
    //         该槽内容像素的"真实相位"，与出队顺序解耦。
    reg [15:0] tag_frame [0 : SLOTS - 1];
    reg [15:0] tag_chunk [0 : SLOTS - 1];

    //--------------------------------------------------------------------------
    // v3 模式锁存（§3.3：帧边界生效）
    //   mode_q 仅在"发送管线静止"时跟随 i_mode：IDLE && chunk_idx==0 && 环空。
    //   传输中的帧不可能被中途换模式（n_full>0 或 chunk_idx>0 时锁存被冻结）。
    //   v2 模式下 mode_q 恒 0 且不被引用（v2 路径不读它）。
    //--------------------------------------------------------------------------
    reg [1:0] mode_q;

    //--------------------------------------------------------------------------
    // v3 动作字节锁存（M4b；契约 §2.5：与 mode_q 同款，帧边界生效）
    //   每帧锁存一次 ⇒ 同一 frame_idx 的所有分片包 byte23 严格相同；
    //   帧传输期间（n_full>0 / chunk_idx>0）冻结，不会出现同帧两个值。
    //--------------------------------------------------------------------------
    reg [7:0] act_byte_q;
    // M4C：顶层已接 act_state_cdc（复位 0x00），端口接实后防 X 防护按 Lead 指示去掉
    wire [7:0] act_byte_s = i_act_byte;

    //--------------------------------------------------------------------------
    // 写侧（像素 → 环形槽）
    //--------------------------------------------------------------------------
    reg  [1:0]  wr_slot;         // 当前写入槽
    reg  [9:0]  wr_pix_cnt;      // 槽内像素计数 0..639
    reg  [2:0]  n_full;          // 环中待发槽数 0..SLOTS
    reg         chunk_send;      // 本槽是否回传（槽首锁存，避免帧边界串拍）
    reg  [18:0] pix_in_frame;
    reg  [15:0] frame_idx;
    reg  [15:0] chunk_idx;
    reg  [15:0] decim_cnt;
    reg         send_frame;

    //--------------------------------------------------------------------------
    // ★ 修复 RAW-PHASE-20261017（停原画再恢复后的粘性标签偏移 / 横向接缝）
    //   根因：chunk_idx/frame_idx 只在 raw_pop_now（出队）推进，而 MODE2 期间
    //   像素侧照常 pix_accept（pix_in_frame/wr_pix_cnt 前进、入队被 raw_en_q
    //   关闭）⇒ 标签相位与内容像素相位永久脱钩，按 chunk 序号拼帧的主机
    //   看到固定旋转 + 一条横向接缝。
    //   修复：标签改由像素域计数器给出（px_chunk/px_frame：每填满一个 chunk
    //   前进一格，与是否入队无关），槽首把 (px_frame,px_chunk) 锁存进该槽
    //   tag，发包时用它填 FRAME_IDX/CHUNK_IDX ⇒ 标签恒等于内容像素真实相位。
    //   恢复重同步：raw_en_q 上升沿（MODE2→恢复）若不在真实帧首就挂起
    //   resync_pending，丢弃当前半帧，等 pix_in_frame==0 && wr_pix_cnt==0
    //   才恢复入队 ⇒ 恢复后第一段原始段必是真实帧首 chunk0，绝不发半帧。
    //--------------------------------------------------------------------------
    reg  [15:0] px_chunk;        // 像素域 chunk 序号 0..CHUNK_M1（与入队无关）
    reg  [15:0] px_frame;        // 像素域帧序号（**只由帧首 marker 推进**，对主机单调）
    reg         raw_en_d;        // raw_en_q 打一拍：找 MODE2→恢复上升沿
    reg         resync_pending;  // 相位失守（丢像素/停回传）后等待下一个帧首 marker

    // ★ SEAM-LINKDROP-20261017 帧首同步状态：
    //   frame_seen  = 已经做过至少一次"帧首快照"（决定 px_frame 是 +1 还是从 0 起）；
    //   marker_seen = 见过**真实** i_raw_frame_start（=1 后兼容路径永久关闭，不再自己数帧首）。
    reg         frame_seen;
    reg         marker_seen;
    //   send_pend   = 上一次帧首采样出的「下一帧是否回传」判决（一级流水，见写侧末尾 snap 块）
    reg         send_pend;


    //--------------------------------------------------------------------------
    // 读侧 / 发送 FSM
    //--------------------------------------------------------------------------
    reg  [2:0]  state;
    reg  [1:0]  rd_slot;         // 当前发送槽
    reg  [4:0]  hdr_idx;
    reg  [9:0]  raw_pix_idx;
    reg         raw_phase;
    reg  [9:0]  raw_rd_addr;
    reg  [9:0]  ev_rec_idx;
    reg  [9:0]  ev_rec_cnt_r;
    reg  [2:0]  ev_byte_idx;
    reg  [9:0]  ev_rd_rec;
    reg  [1:0]  crc_idx;
    reg  [15:0] crc_reg;
    reg  [15:0] raw_len_r, ev_len_r, pkt_len_r;
    reg  [7:0]  seg_mask_r;
    reg  [15:0] frame_idx_r, chunk_idx_r;
    reg  [47:0] ts_r;            // v3：包头 TS_US（包首锁存）
    reg         ts_valid_r, ts_cal_r;
    reg         pkt_was_raw;     // 本包是否含原始段（S_DONE 出队判据）
    reg  [23:0] flush_cnt;

    reg  [15:0] raw_rdata;       // raw_ram 同步读（1 拍延迟）
    reg  [17:0] ev_rdata;        // ev_ram  同步读（1 拍延迟）
    reg         pkt_is_ctrl;     // 本包是 CTRL 包（S_DONE 释放小 FIFO 的判据）

    //--------------------------------------------------------------------------
    // 事件写侧（收集页）—— 页指针必须先于下方"组合"节声明（Verilog 先声明后引用）
    //--------------------------------------------------------------------------
    reg         ev_wr_page;
    reg  [8:0]  ev_rec_cnt0, ev_rec_cnt1;

    wire [8:0] ev_rec_wr  = ev_wr_page ? ev_rec_cnt1 : ev_rec_cnt0;
    wire [8:0] ev_rec_pd  = ev_wr_page ? ev_rec_cnt0 : ev_rec_cnt1;  // 待发页条数
    wire [9:0] ev_wr_base = ev_wr_page ? PAGE_10 : 10'd0;
    wire [9:0] ev_rd_base = ev_wr_page ? 10'd0 : PAGE_10;             // 待发页 = 非收集页
    wire [9:0] ev_wr_base_nxt = ev_wr_page ? 10'd0 : PAGE_10;         // 交换后的新收集页

    //--------------------------------------------------------------------------
    // v3 CTRL 包小 FIFO（256 B；生产者 = downlink_cmd，先查 o_ctrl_empty 再构包）
    //--------------------------------------------------------------------------
    reg  [7:0]  ctrl_mem [0:255];
    reg  [8:0]  ctrl_wr_ptr;
    reg  [8:0]  ctrl_len_q;
    reg         ctrl_pending;
    reg  [8:0]  ctrl_rd_ptr;

    //--------------------------------------------------------------------------
    // 组合：模式/事件门控与包结构（§3.1 / §6.3）
    //--------------------------------------------------------------------------
    // 事件上行使能：v2 恒 1；v3 = 非 RAW_ONLY 且 EV_EN=1
    wire        ev_up_en     = !IS_V3 || ((mode_q != 2'd1) && i_ev_en);
    // ★ v3 事件页写入门限 = 纯事件包容量（289）：收集页是缓冲。混合包的
    //   165 B 上限不走钳位，而是"积压 >33 时先发纯事件包"（raw 段在环里
    //   等待，帧完整性与 chunk 顺序不受影响）；v2 保持 35（逐位回归）。
    wire [8:0]  cap_recs_q   = IS_V3 ? CAPPURE_9 : CAPMIX_9;

    wire        raw_pending   = (n_full != 3'd0);
    // MODE2 不发原始包（写侧已停止入队，此处是第二道闸）
    wire        raw_pending_eff = raw_pending && (!IS_V3 || (mode_q != 2'd2));
    // 收集页条数（事件先落收集页；页交换发生在包尾 S_DONE）
    wire [8:0]  ev_rec_collect = ev_wr_page ? ev_rec_cnt1 : ev_rec_cnt0;
    // ★ v3 触发含收集页：MODE2 纯事件流下，包间无交换机会，事件全部堆在
    //   收集页 —— 若只看待发页会死锁（实测：事件收满收集页却永不出包）。
    //   v2 保持旧触发（逐位回归）。
    wire        ev_any        = IS_V3 ? ((ev_rec_pd != 9'd0) || (ev_rec_collect != 9'd0))
                                      : (ev_rec_pd != 9'd0);
    wire        ev_any_full   = IS_V3 ? ((ev_rec_pd >= cap_recs_q) || (ev_rec_collect >= cap_recs_q))
                                      : (ev_rec_pd >= cap_recs_q);
    // ★ v3 积压策略：本包事件条数 > 混合包上限(33) ⇒ 本包先发**纯事件包**（发空
    //   待发页/收集页，≤289 条 ≤ MTU），原始槽在环里多等一拍 —— 帧完整性、chunk
    //   顺序、"待发页发空才交换"的不变式全部保持，且切换期间不丢事件。
    //   MODE1（事件不上行）构包条数恒 0（页内容随交换清空 —— v3 §3.1 语义）。
    //   ⚠️ 判据落在下方 ev_pure_pkt（= 本包事件条数 > 33），不在本处按页判 —— 见 F1 注释。
    wire        ev_pending    = ev_any && ev_up_en;
    wire        ev_full_flush = ev_any_full;                          // 页满即发，防丢
    wire        flush_tick    = IS_V3 ? (flush_cnt >= {8'd0, i_ev_flush_cyc})
                                      : (flush_cnt == EV_FLUSH_CYC);
    wire        want_pkt      = raw_pending_eff | (ev_pending & (flush_tick | ev_full_flush));
    wire        pkt_go        = want_pkt & i_cfg_en & i_tx_ready & (state == S_IDLE);
    // ★ v3 排空交换：pkt_go 且待发页空而收集页有货 ⇒ 先换页再组包（发收集页）
    wire        drain_swap    = IS_V3 && (state == S_IDLE) && pkt_go &&
                                (ev_rec_pd == 9'd0) && (ev_rec_collect != 9'd0);
    wire [8:0]  ev_build_recs = !ev_up_en ? 9'd0 :
                                (drain_swap ? ev_rec_collect : ev_rec_pd);
    // ★ 修复 F1-20261013（θ=1/δL=1 高事件量下混合包超 MTU 被截断、CRC 丢失）：
    //   把"本包必须发**纯事件包**（不带 RAW 段）"的判据从"待发页 > 33"（pure_first）
    //   推广为"**本包事件条数 > 33**"，从而把 drain_swap 排空路径一并纳入：
    //     · drain_swap 时 ev_build_recs = ev_rec_collect（收集页积压，可达 289 条）；
    //     · 旧判据只看待发页 ev_rec_pd，而 drain_swap 的前提恰是 ev_rec_pd==0
    //       ⇒ 该闸在 drain 路径上永远不开 ⇒ 24+1280+1445+2 = 2751 B > MTU 1472，
    //       被 eth_udp 硬截断在 1472 B（包头 EV_LEN 仍是真实值）⇒ 事件尾部与 CRC
    //       整体丢失（现场 26581/139802 包不自洽，两个独立解析器一致）。
    //   纯事件包上界 = 24 + 289*5 + 2 = 1471 ≤ 1472 ⇒ 任何参数组合都不越线。
    //   v2（IS_V3=0）：ev_build_recs ≤ CAP_MIXED=35 ⇒ ev_pure_pkt 恒 0，行为与旧版逐字一致。
    wire        ev_pure_pkt   = (ev_build_recs > CAPMIX_9);
    // ★ 防御性硬钳位：页深已 ≤ CAP_PURE，此处保证"任何参数组合"下事件段不越 MTU 红线，
    //   且**包头 EV_LEN 与实发事件字节/CRC 同源**（都取 ev_build_cap）⇒ 不会出现
    //   "包头自述长度 ≠ 实发字节"的自相矛盾包。
    wire [8:0]  ev_build_cap  = (ev_build_recs > CAPPURE_9) ? CAPPURE_9 : ev_build_recs;
    wire [15:0] ev_pend_bytes = {7'd0, ev_build_cap} * EV_REC_BYTES;

    wire        ev_swap_now   = (state == S_DONE) || drain_swap;
    wire        raw_pop_now   = (state == S_DONE) & pkt_was_raw;

    // 槽基址（12 bit：3×640+639 = 2559，10 bit 会回绕 —— 实测踩过）
    wire [11:0] wr_slot_base = wr_slot * PIX_PER_CHUNK;
    wire [11:0] rd_slot_base = rd_slot * PIX_PER_CHUNK;

    //--------------------------------------------------------------------------
    // 包结构（每包按当前 mode_q 决定段结构 —— 结构上保证与 MODE 字节一致）
    //--------------------------------------------------------------------------
    // ★ F1 修复后：RAW 段与"本包事件条数 > 33"互斥（含 drain 路径）—— 详见 ev_pure_pkt 注释
    wire [15:0] pkt_raw_len = (raw_pending_eff && !ev_pure_pkt) ? RAW_CHUNK_W : 16'd0;
    wire [15:0] pkt_ev_len  = ev_up_en ? ev_pend_bytes : 16'd0;
    wire [15:0] pkt_len_w   = HEAD_W + pkt_raw_len + pkt_ev_len + CRC_W;

    // v3 FLAGS（数据包）：bit5/6 首末包按 CHUNK_IDX 给（§2.1）
    wire        pkt_first   = (raw_len_r != 16'd0) && (chunk_idx_r == 16'd0);
    wire        pkt_last    = (raw_len_r != 16'd0) && (chunk_idx_r == CHUNK_M1);
    wire [7:0]  flags_w     = {1'b0, pkt_last, pkt_first, ts_cal_r, ts_valid_r,
                               (CRC_EN != 0), (ev_len_r != 16'd0), (raw_len_r != 16'd0)};

    // 环形缓冲未满 ⇒ 环里还有空槽可以收新段
    wire        ring_ok       = (n_full != SLOTS_3);

    //--------------------------------------------------------------------------
    // ★ SEAM-LINKDROP-20261017：帧首同步（source frame marker → 强制相位快照）
    //
    //   要解决的现场问题（用户报"插拔网线后画面水平拼接复发"）：
    //   原实现里"帧内第几个像素"（pix_in_frame / px_chunk / px_frame）全部由**本模块
    //   自己**在 clk_eth 侧数。网线一拔，环满 ⇒ 像素被丢 ⇒ 源侧与本地计数永久差一个
    //   固定量，之后每一帧都从错误的位置开始拼 ⇒ 画面水平错位/拼接，直到复位。
    //
    //   修复思路："哪一个是帧首"是**源的属性**，必须由源侧告诉本模块，并且必须与像素
    //   **同路**过 CDC（event_sink 把 marker 塞进 raw FIFO 第 17 bit）。本模块在 marker
    //   那一拍做一次无条件快照：本拍像素就是 chunk0 的 pixel0 ⇒ 相位立刻重新对齐，
    //   不需要复位、也不会累积偏移。
    //
    //   兼容路径（marker_seen == 0，即从未见过真实 marker，例如老 TB / 未升级的源）：
    //   保持"自己数帧首"的旧行为——在 (wr_pix_cnt==0 && pix_in_frame==0) 这个旧的帧
    //   边界上也产生一次同样的快照（synth marker）。这样无 marker 的激励行为**逐拍等价**
    //   于修复前（见 tb_raw_phase* / tb_udp_mtu_cap / tb_stall_repro 的回归）；一旦真实
    //   marker 出现，兼容路径永久关闭，之后只认源侧 marker。
    //--------------------------------------------------------------------------
    wire        legacy_sync   = !marker_seen;          // 1 = 还没见过真实 marker（兼容路径）
    wire        frame_marker  = i_raw_valid & (i_raw_frame_start |
                                 (legacy_sync & (wr_pix_cnt == 10'd0) &
                                                (pix_in_frame == 19'd0)));
    wire        snap_now      = frame_marker & ring_ok; // 环满时无法快照（本拍像素丢弃）

    //--------------------------------------------------------------------------
    // ★ 像素接受 / 丢弃策略（SEAM-LINKDROP-20261017）
    //   正常：环里有空槽 ⇒ 接受。
    //   环满：丢弃（计入 o_stat_drop_px）—— 与旧实现一致。
    //   resync_pending（相位已失守，正在等下一个真帧首）：**只接受帧首快照那一个像素**，
    //   其余全部按"丢弃"计数。理由：这些像素属于一个已被判定作废的半帧，写进槽里也只
    //   会被快照覆盖；更重要的是它们**确实没有回传**，必须计入丢像素，否则 o_stat_drop_px
    //   会少报（丢包后主机看到"0 丢包"却画面缺行，无法定位）。
    //   兼容例外（legacy_sync，即还没见过任何真实 marker）：保持旧语义（pending 期间
    //   照常接受并推进计数）。否则老 TB / 未升级源在 MODE2 恢复时会死锁：
    //   计数冻结 ⇒ 合成帧首条件 (wr_pix_cnt==0 && pix_in_frame==0) 永不成立 ⇒ pending 永不解除。
    //--------------------------------------------------------------------------
    wire        accept_normal = i_raw_valid & ring_ok &
                                (!resync_pending | legacy_sync) & !snap_now;
    wire        pix_accept    = accept_normal | snap_now;   // 本拍像素被接受（含快照拍）
    wire        drop_px_now   = i_raw_valid & !pix_accept;  // 本拍像素被丢弃

    wire [15:0] px_frame_next = frame_seen ? (px_frame + 16'd1) : 16'd0;

    wire        chunk_fill_done = accept_normal & (wr_pix_cnt == PIXCH_M1);
    wire        frame_wrap    = accept_normal & (pix_in_frame == PIXFR_M1);

    // v3：原始槽入队门（MODE2 停止入队；入队中的帧由旧模式完整发完）
    wire        raw_en_q      = !IS_V3 || (mode_q != 2'd2);
    // v3：整帧发送门（2→0 切换后先让纯事件包把积压排空再恢复原始帧）
    wire        raw_frame_ok  = !IS_V3 || (ev_rec_pd <= CAPMIX_10) || (mode_q == 2'd2);
    // 运行时抽帧比（v3 = i_frame_decim-1，0 视为 1；v2 = 编译期参数）
    wire [15:0] decim_m1_eff  = IS_V3 ? ((({8'd0, i_frame_decim}) == 16'd0) ? 16'd0
                                      : {8'd0, i_frame_decim} - 16'd1) : DECIM_M1;
    // ★ SEAM-LINKDROP-20261017：本帧是否回传（判决点已搬到帧首快照，见写侧 snap 块）
    wire        send_now      = (decim_cnt >= decim_m1_eff);

    //--------------------------------------------------------------------------
    // CRC-16/CCITT-FALSE：poly 0x1021 / init 0xFFFF（逐字节，组合）
    //--------------------------------------------------------------------------
    function [15:0] crc16_step;
        input [15:0] crc;
        input [7:0]  dat;
        integer i;
        reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (i = 0; i < 8; i = i + 1)
                c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16_step = c;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 包头字节（v3：§2.1 的 24 B 布局 / v2：13 B 旧布局，逐字保留）
    //--------------------------------------------------------------------------
    function [7:0] hdr_byte;
        input [4:0] idx;
        begin
            if (IS_V3) begin
                case (idx)
                    5'd0 : hdr_byte = 8'hF0;
                    5'd1 : hdr_byte = 8'h5A;
                    5'd2 : hdr_byte = 8'hA5;
                    5'd3 : hdr_byte = 8'h30;              // ★ v3 上行魔数
                    5'd4 : hdr_byte = 8'h03;              // VER
                    5'd5 : hdr_byte = 8'h18;              // HDR_LEN = 24
                    5'd6 : hdr_byte = flags_w;            // FLAGS
                    5'd7 : hdr_byte = {6'd0, mode_q};     // MODE（每包都带）
                    5'd8 : hdr_byte = chunk_idx_r[15:8];
                    5'd9 : hdr_byte = chunk_idx_r[7:0];
                    5'd10: hdr_byte = frame_idx_r[15:8];
                    5'd11: hdr_byte = frame_idx_r[7:0];
                    5'd12: hdr_byte = raw_len_r[15:8];
                    5'd13: hdr_byte = raw_len_r[7:0];
                    5'd14: hdr_byte = ev_len_r[15:8];
                    5'd15: hdr_byte = ev_len_r[7:0];
                    5'd16: hdr_byte = ts_r[47:40];
                    5'd17: hdr_byte = ts_r[39:32];
                    5'd18: hdr_byte = ts_r[31:24];
                    5'd19: hdr_byte = ts_r[23:16];
                    5'd20: hdr_byte = ts_r[15:8];
                    5'd21: hdr_byte = ts_r[7:0];
                    5'd22: hdr_byte = (ev_len_r != 16'd0) ? 8'h05 : 8'h00;  // EV_REC_BYTES
                    5'd23: hdr_byte = act_byte_q;         // ★ M4b 动作字节（VALID|CONF|CLASS）
                    default: hdr_byte = 8'h00;            // RSVD=0
                endcase
            end
            else begin
                case (idx)                                 // ---- v2 原布局 ----
                    5'd0 : hdr_byte = 8'hF0;
                    5'd1 : hdr_byte = 8'h5A;
                    5'd2 : hdr_byte = 8'hA5;
                    5'd3 : hdr_byte = 8'h0F;
                    5'd4 : hdr_byte = frame_idx_r[15:8];
                    5'd5 : hdr_byte = frame_idx_r[7:0];
                    5'd6 : hdr_byte = seg_mask_r;
                    5'd7 : hdr_byte = chunk_idx_r[15:8];
                    5'd8 : hdr_byte = chunk_idx_r[7:0];
                    5'd9 : hdr_byte = raw_len_r[15:8];
                    5'd10: hdr_byte = raw_len_r[7:0];
                    5'd11: hdr_byte = ev_len_r[15:8];
                    5'd12: hdr_byte = ev_len_r[7:0];
                    default: hdr_byte = 8'h00;
                endcase
            end
        end
    endfunction

    //--------------------------------------------------------------------------
    // 事件记录的第 ph 个字节
    //--------------------------------------------------------------------------
    function [7:0] ev_byte;
        input [17:0] rec;      // {X[7:0], X[8], Y[7:0], POL}
        input [2:0]  ph;
        begin
            case (ph)
                3'd0: ev_byte = rec[17:10];      // X[7:0]
                3'd1: ev_byte = {7'b0, rec[9]};  // X[8]
                3'd2: ev_byte = rec[8:1];        // Y[7:0]
                3'd3: ev_byte = {7'b0, rec[0]};  // POL
                3'd4: ev_byte = 8'h00;           // FLAGS
                default: ev_byte = 8'h00;
            endcase
        end
    endfunction

    //--------------------------------------------------------------------------
    // 发送状态机 + 包头/负载推送
    //--------------------------------------------------------------------------
    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            state        <= S_IDLE;
            // ⚠️ rd_slot 的复位放在"写侧计数"块里（那里才是它唯一的驱动源）。
            //    两个 always 块驱动同一个 reg 会报 [Synth 8-6859]（仿真不报，极易漏）。
            hdr_idx      <= 5'd0;
            raw_pix_idx  <= 10'd0;
            raw_phase    <= 1'b0;
            raw_rd_addr  <= 10'd0;
            ev_rec_idx   <= 10'd0;
            ev_rec_cnt_r <= 10'd0;
            ev_byte_idx  <= 3'd0;
            ev_rd_rec    <= 10'd0;
            crc_idx      <= 2'd0;
            crc_reg      <= 16'hFFFF;
            raw_len_r    <= 16'd0;
            ev_len_r     <= 16'd0;
            pkt_len_r    <= 16'd0;
            seg_mask_r   <= 8'd0;
            frame_idx_r  <= 16'd0;
            chunk_idx_r  <= 16'd0;
            ts_r         <= 48'd0;
            ts_valid_r   <= 1'b0;
            ts_cal_r     <= 1'b0;
            pkt_was_raw  <= 1'b0;
            pkt_is_ctrl  <= 1'b0;
            flush_cnt    <= 24'd0;
            mode_q       <= 2'd0;                 // 上电默认 RAW_EV（§3.1）
            act_byte_q   <= 8'h00;                // 上电无动作（VALID=0）；帧后不清零
            ctrl_wr_ptr  <= 9'd0;
            ctrl_len_q   <= 9'd0;
            ctrl_pending <= 1'b0;
            ctrl_rd_ptr  <= 9'd0;
            o_tx_start   <= 1'b0;
            o_tx_byte    <= 8'd0;
            o_tx_byte_en <= 1'b0;
            o_tx_len     <= 16'd0;
        end
        else begin
            o_tx_start   <= 1'b0;
            o_tx_byte_en <= 1'b0;

            // ---- v3 CTRL 小 FIFO：写口自增 + 提交锁存（★ 单块收敛，勿拆）----
            //   ⚠️ P0 修复（2026-10-12）：ctrl_wr_ptr / ctrl_len_q / ctrl_pending 的
            //      全部赋值必须留在**本 always 块**内（含下方 S_DONE 分支的释放）。
            //      此前"写口"与"commit"各自独立成块 ⇒ 综合报 [Synth 8-6859]
            //      multi-driven net，常量驱动（复位 0）被保留、寄存器驱动被忽略
            //      ⇒ 板上 ctrl_pending 恒 0，ACK / 1Hz 心跳 / TIME_SYNC_REQ 上行
            //      整体失效（ModelSim 对多驱动合法 ⇒ 42 TB 全绿也拦不住）。
            //      自增（!ctrl_pending）与释放（ctrl_pending）条件互斥，无优先级冲突。
            if (i_ctrl_wr_en && !ctrl_pending)
                ctrl_wr_ptr <= ctrl_wr_ptr + 9'd1;
            if (i_ctrl_commit && !ctrl_pending && IS_V3) begin
                ctrl_len_q   <= ctrl_wr_ptr;   // 长度 = 自上次发送起累计的字节数
                ctrl_pending <= 1'b1;
            end

            // ---- v3 模式锁存（帧边界生效，§3.3）----
            if (IS_V3 && (state == S_IDLE) && (chunk_idx == 16'd0) && (n_full == 3'd0))
                mode_q <= i_mode;

            // ---- v3 动作字节锁存（M4b；与 mode_q 同条件，帧边界生效）----
            //   同一帧内所有分片包共用 act_byte_q ⇒ byte23 一致；判定更新只影响下一帧。
            if (IS_V3 && (state == S_IDLE) && (chunk_idx == 16'd0) && (n_full == 3'd0))
                act_byte_q <= act_byte_s;

            // 事件看门狗（每次组包清零，饱和计数）
            if (pkt_go)           flush_cnt <= 24'd0;
            else if (!flush_tick) flush_cnt <= flush_cnt + 24'd1;

            case (state)
                //--------------------------------------------------------------
                S_IDLE: begin
                    // ★ 修复 P0-STALL-20261012（CTRL 丢包 ⇒ 命令 ACK 偶发超时 / 心跳 <1 Hz）：
                    //   CTRL 包启动**必须**与数据包一样等 i_tx_ready。原实现只在数据分支
                    //   （pkt_go）里等反压，CTRL 分支无条件抢发 ⇒ 若此刻 eth_udp 正处于
                    //   W_LOAD/W_WAIT（上一包仍在发），它**完全忽略** i_tx_start 且不收字节
                    //   ⇒ 整条 CTRL 包（ACK / 心跳 / TIME_SYNC_REQ）被静默吞掉，且
                    //   ctrl_pending 已在 S_DONE 释放 ⇒ 命令端只能等超时。
                    //   现场符合度：丢包率 ≈ eth_udp 占空比 —— 满速原画（17285 pps）下
                    //   占空 ≈ 20%，实测心跳 50/60 s = 0.83 Hz（丢 17%）、5 条命令 2 条超时。
                    if (IS_V3 && ctrl_pending && i_tx_ready) begin
                        // ★ CTRL 包优先（§6.2；内容为 downlink_cmd 构好的完整负载）
                        o_tx_len    <= {7'd0, ctrl_len_q};
                        o_tx_start  <= 1'b1;
                        pkt_was_raw <= 1'b0;
                        pkt_is_ctrl <= 1'b1;
                        ctrl_rd_ptr <= 9'd0;
                        state       <= S_CTRL;
                    end
                    else if (pkt_go) begin
                        raw_len_r    <= pkt_raw_len;
                        ev_len_r     <= pkt_ev_len;
                        seg_mask_r   <= {6'b0, (pkt_ev_len != 16'd0), (pkt_raw_len != 16'd0)};
                        // ★ 修复 RAW-PHASE-20261017：含原始段的包用**槽 tag**
                        //   （该槽内容像素的真实相位）填 FRAME_IDX/CHUNK_IDX，
                        //   而不是出队计数器 ⇒ 标签永远跟随内容；
                        //   FIRST/LAST（flags bit5/6）由 chunk_idx_r 派生，自动正确。
                        //   纯事件包保持出队计数器的旧语义（主机不用它拼帧）。
                        if (pkt_raw_len != 16'd0) begin
                            frame_idx_r <= tag_frame[rd_slot];
                            chunk_idx_r <= tag_chunk[rd_slot];
                        end
                        else begin
                            frame_idx_r <= frame_idx;
                            chunk_idx_r <= chunk_idx;
                        end
                        ts_r         <= i_ts_us;       // §4.2：包首锁存采集时刻
                        ts_valid_r   <= i_ts_valid;
                        ts_cal_r     <= i_ts_calibrated;
                        pkt_was_raw  <= (pkt_raw_len != 16'd0);
                        pkt_is_ctrl  <= 1'b0;
                        pkt_len_r    <= pkt_len_w;
                        o_tx_len     <= pkt_len_w;
                        o_tx_start   <= 1'b1;
                        crc_reg      <= 16'hFFFF;
                        hdr_idx      <= 5'd0;
                        raw_pix_idx  <= 10'd0;
                        raw_phase    <= 1'b0;
                        raw_rd_addr  <= 10'd0;
                        ev_rec_idx   <= 10'd0;
                        ev_byte_idx  <= 3'd0;
                        ev_rd_rec    <= 10'd0;
                        ev_rec_cnt_r <= ev_up_en ? {1'b0, ev_build_cap} : 10'd0;
                        crc_idx      <= 2'd0;
                        state        <= S_HDR;
                    end
                end
                //--------------------------------------------------------------
                S_HDR: begin
                    o_tx_byte_en <= 1'b1;
                    o_tx_byte    <= hdr_byte(hdr_idx);
                    crc_reg      <= crc16_step(crc_reg, hdr_byte(hdr_idx));
                    if (hdr_idx == HEAD_M1) begin
                        hdr_idx <= 5'd0;
                        if (raw_len_r != 16'd0)     state <= S_RAW;
                        else if (ev_len_r != 16'd0) state <= S_EV;
                        else                        state <= S_CRC;
                    end
                    else hdr_idx <= hdr_idx + 5'd1;
                end
                //--------------------------------------------------------------
                S_RAW: begin
                    o_tx_byte_en <= 1'b1;
                    if (raw_phase == 1'b0) begin
                        o_tx_byte <= raw_rdata[15:8];
                        crc_reg   <= crc16_step(crc_reg, raw_rdata[15:8]);
                        raw_phase <= 1'b1;
                        // ⚠️ 预取必须在本拍发起（同步读 1 拍延迟），否则高字节取到上一像素
                        if (raw_pix_idx != PIXCH_M1)
                            raw_rd_addr <= raw_rd_addr + 10'd1;
                    end
                    else begin
                        o_tx_byte <= raw_rdata[7:0];
                        crc_reg   <= crc16_step(crc_reg, raw_rdata[7:0]);
                        raw_phase <= 1'b0;
                        if (raw_pix_idx == PIXCH_M1) begin
                            raw_pix_idx <= 10'd0;
                            state <= (ev_len_r != 16'd0) ? S_EV : S_CRC;
                        end
                        else raw_pix_idx <= raw_pix_idx + 10'd1;
                    end
                end
                //--------------------------------------------------------------
                S_EV: begin
                    o_tx_byte_en <= 1'b1;
                    o_tx_byte    <= ev_byte(ev_rdata, ev_byte_idx);
                    crc_reg      <= crc16_step(crc_reg, ev_byte(ev_rdata, ev_byte_idx));
                    if (ev_byte_idx == EVREC_M1) begin
                        ev_byte_idx <= 3'd0;
                        if (ev_rec_idx == (ev_rec_cnt_r - 10'd1)) begin
                            ev_rec_idx <= 10'd0;
                            state      <= S_CRC;
                        end
                        else ev_rec_idx <= ev_rec_idx + 10'd1;
                    end
                    else begin
                        // ⚠️ 同步读 1 拍延迟：倒数第 2 个字节就发起预取
                        if ((ev_byte_idx == (EVREC_M1 - 3'd1)) &&
                            (ev_rec_idx != (ev_rec_cnt_r - 10'd1)))
                            ev_rd_rec <= ev_rd_rec + 10'd1;
                        ev_byte_idx <= ev_byte_idx + 3'd1;
                    end
                end
                //--------------------------------------------------------------
                S_CRC: begin
                    if (CRC_BYTES != 0) begin
                        o_tx_byte_en <= 1'b1;
                        if (crc_idx == 2'd0) begin
                            o_tx_byte <= crc_reg[15:8];
                            crc_idx   <= 2'd1;
                        end
                        else begin
                            o_tx_byte <= crc_reg[7:0];
                            crc_idx   <= 2'd0;
                            state     <= S_DONE;
                        end
                    end
                    else state <= S_DONE;
                end
                //--------------------------------------------------------------
                S_CTRL: begin                          // v3：CTRL 包逐字节直通
                    o_tx_byte_en <= 1'b1;
                    o_tx_byte    <= ctrl_mem[ctrl_rd_ptr[7:0]];
                    if (ctrl_rd_ptr == (ctrl_len_q - 9'd1)) begin
                        state <= S_DONE;               // 出队/页交换在 S_DONE 统一
                    end
                    else ctrl_rd_ptr <= ctrl_rd_ptr + 9'd1;
                end
                //--------------------------------------------------------------
                S_DONE: begin
                    if (ctrl_pending && pkt_is_ctrl) begin
                        // CTRL 包发完：释放小 FIFO
                        ctrl_pending <= 1'b0;
                        ctrl_wr_ptr  <= 9'd0;
                    end
                    pkt_was_raw <= 1'b0;
                    pkt_is_ctrl <= 1'b0;
                    state <= S_IDLE;      // 环/事件页出队由组合信号完成
                end
                default: state <= S_IDLE;
            endcase
        end
    end

    // ★ 修复 P0-STALL-20261012（CTRL 包被静默丢弃 ⇒ 命令 ACK 丢、心跳丢）：
    //   "可接收新包"必须同时排除**本拍正在到达的 commit**。
    //   时序：commit 拍 C 时 i_ctrl_commit=1，但 ctrl_pending 要到 C+1 才为 1；
    //   而生产者（downlink_cmd）恰好也在 C+1 回到 B_IDLE 看 i_ctrl_empty ——
    //   若只看 !ctrl_pending，它会看到 1 并开始构包，而 C+1 起的字节写入与
    //   C+2 的 commit 都被 `!ctrl_pending` 门挡掉 ⇒ **整条 CTRL 包（ACK/心跳）
    //   被静默吞掉，且生产者已把请求消费掉**（现场 §4.6：ACK 偶发超时、心跳
    //   50/60 s；本复现 TB 里"构包期间到达的命令"100% 命中此洞）。
    //   典型命中：请求在构包期间到达 ⇒ 恰好在 B_COMMIT 的下一拍被取走。
    // 组合路径无环：i_ctrl_commit 是 downlink_cmd 的寄存器输出。
    assign o_ctrl_empty = !ctrl_pending && !i_ctrl_commit;

    //--------------------------------------------------------------------------
    // CTRL 小 FIFO 存储写口（★ 无复位：与下方存储写口同因 —— 带异步复位的 RAM
    //   写口会被 Vivado 溶解成触发器）。生产者契约：仅当 o_ctrl_empty 时构包推送。
    //   ⚠️ 三控制寄存器（ctrl_wr_ptr / ctrl_len_q / ctrl_pending）的赋值全部收在
    //      上面的主 FSM 块内（唯一驱动源）；本块只写 ctrl_mem 存储本体。
    //--------------------------------------------------------------------------
    always @(posedge clk_eth) begin
        if (i_ctrl_wr_en && !ctrl_pending)
            ctrl_mem[ctrl_wr_ptr[7:0]] <= i_ctrl_data;
    end

    //--------------------------------------------------------------------------
    // 写侧：像素入环形槽 + 帧/槽计数 + 抽帧
    //--------------------------------------------------------------------------
    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            wr_slot        <= 2'd0;
            rd_slot        <= 2'd0;      // 唯一驱动源（本块负责出队）
            wr_pix_cnt     <= 10'd0;
            n_full         <= 3'd0;
            chunk_send     <= 1'b1;
            pix_in_frame   <= 19'd0;
            frame_idx      <= 16'd0;
            chunk_idx      <= 16'd0;
            decim_cnt      <= 16'd0;
            send_frame     <= 1'b1;
            o_stat_drop_px <= 16'd0;
            px_chunk       <= 16'd0;
            px_frame       <= 16'd0;
            raw_en_d       <= 1'b1;   // 复位后不误触发一次重同步（否则白丢第一帧）
            resync_pending <= 1'b0;
            frame_seen     <= 1'b0;   // ★ 还没做过帧首快照 ⇒ 第一个快照的帧号从 0 起
            marker_seen    <= 1'b0;   // ★ 还没见过真实 marker ⇒ 兼容路径（自己数帧首）
            send_pend      <= 1'b1;   // ★ 复位后第一帧必发（与旧序列一致）
        end
        else begin
            // --- 槽首锁存"本槽是否回传"（帧边界与槽边界同拍时也不串拍）---
            if (pix_accept && (wr_pix_cnt == 10'd0))
                chunk_send <= send_frame;

            // --- 像素写入环形槽（存储本体在下方独立的"无复位写口"块里）---
            if (pix_accept) begin
                if (chunk_fill_done) begin
                    wr_pix_cnt <= 10'd0;
                    // ★ 修复 RAW-PHASE-20261017：像素域 chunk 标签每填满一槽前进一格
                    //   （与入队/出队完全解耦）⇒ MODE2 期间照常前进，恢复后
                    //   标签 = 真实像素相位，粘性偏移不可能再出现。
                    // ★ SEAM-LINKDROP-20261017：px_frame **不再**在这里自增 —— 帧号只由
                    //   帧首快照推进（写侧末尾 snap 块）。"哪个像素是帧首"只相信源侧
                    //   marker，不再依赖本模块能否数够 480 行。
                    px_chunk <= (px_chunk == CHUNK_M1) ? 16'd0 : (px_chunk + 16'd1);
                    // ★ v3：入队门 —— MODE2 停止入队（在途帧已由旧模式完整发完）
                    // ★ 修复：恢复重同步挂起期间同样不入队（丢弃半帧，见下方）
                    if (chunk_send && raw_en_q && !resync_pending) begin
                        // 入队：槽前进、待发数 +1
                        wr_slot <= (wr_slot == SLOT_LAST) ? 2'd0 : (wr_slot + 2'd1);
                        n_full  <= n_full + 3'd1;
                    end
                    // 非回传槽：原地复用（不改变 wr_slot / n_full）
                end
                else wr_pix_cnt <= wr_pix_cnt + 10'd1;
            end
            else if (drop_px_now) begin
                // 环满 / 重同步挂起期间被丢弃的像素（两者都确实没有回传）
                o_stat_drop_px <= o_stat_drop_px + 16'd1;
            end

            // --- 帧内像素计数 / 抽帧相位 ---
            // ★ 修复 P0-STALL-20261012（抽帧比在线改小 ⇒ 原始回传永久停摆，20:51 现场）：
            //   判据必须用 `>=` 而非 `==`。原实现 `decim_cnt == decim_m1_eff` 在
            //   i_frame_decim 由大改小时会失配：例 decim 8→1（阈值 7→0）时若
            //   decim_cnt 落在 [1,7]，它**永远不再等于 0** ⇒ send_frame 恒 0、
            //   chunk_send 恒 0、n_full 恒 0 ⇒ 原始段一段都不再入队回传，直到
            //   decim_cnt 自增绕过 16 bit（65536 帧 ≈ 36 min）才自愈（等效复位 = 重烧）。
            //   `>=` 在阈值不变时与 `==` **逐拍等价**（decim_cnt 永不超过阈值），
            //   仅在"阈值被改小"的异常相位把计数器立即钳回 0 ⇒ 下一帧即恢复。
            //   回归证据：tb_udp_merge(v2) / tb_wire_v3(v3) / tb_udp_decim_stall 全绿。
            // ★ SEAM-LINKDROP-20261017：抽帧判决已搬到写侧末尾的"帧首快照"（帧首才是
            //   可靠的"整帧已过"判据 —— 不再依赖本模块数满 480 行）；本块只留帧内计数。
            if (pix_accept) begin
                if (frame_wrap) pix_in_frame <= 19'd0;
                else            pix_in_frame <= pix_in_frame + 19'd1;
            end

            // --- ★ 修复 RAW-PHASE-20261017：MODE2→恢复 重同步 ---
            //   raw_en_q 上升沿：若此刻不正好停在真实帧首（pix_in_frame==0 且
            //   wr_pix_cnt==0），挂起重同步、丢弃当前半帧，等下一个真实帧首才
            //   恢复入队 ⇒ 恢复后第一段原始段 = 真实帧首 chunk0，绝不发半帧。
            //   若恰好停在帧首则无需丢弃（resync_pending=0，本拍即恢复入队）。
            //   注意：不清 n_full/rd_slot —— 维持 wr_slot = rd_slot + n_full
            //   不变式，环内旧槽由发送侧自然发完（它们带自己的正确标签）。
            raw_en_d <= raw_en_q;
            if (raw_en_q && !raw_en_d) begin
                resync_pending <= !(pix_accept && (wr_pix_cnt == 10'd0) &&
                                    (pix_in_frame == 19'd0));
            end
            // ★ SEAM-LINKDROP-20261017：环满丢像素 ⇒ 源侧与本地相位已经错开，必须悬挂
            //   重同步（丢掉当前半帧，等下一个真帧首重新对齐），否则"粘性偏移"会一直
            //   存在。清除条件挪到帧首快照（写侧末尾 snap 块）—— 那里才是可靠的真帧首。
            //   兼容路径（还没见过真实 marker）不挂：旧行为无需此改造（老逻辑已能自愈）。
            if (i_raw_valid && !ring_ok && !legacy_sync)
                resync_pending <= 1'b1;

            // --- 出队（发完一个原始段）+ 槽序号/帧序号 ---
            if (raw_pop_now) begin
                rd_slot <= (rd_slot == SLOT_LAST) ? 2'd0 : (rd_slot + 2'd1);
                n_full  <= n_full - 3'd1;
                if (chunk_idx == CHUNK_M1) begin
                    chunk_idx <= 16'd0;
                    frame_idx <= frame_idx + 16'd1;
                end
                else chunk_idx <= chunk_idx + 16'd1;
            end

            //--------------------------------------------------------------------------
            // ★ SEAM-LINKDROP-20261017：帧首快照（本帧第一个像素那一拍）
            //   放在本 always 的最末尾 ⇒ 同拍其它分支的赋值都被它覆盖（最后赋值者胜），
            //   保证"帧首这一拍"的语义唯一、不受帧内计数/重同步/出队分支影响。
            //   1) 相位归零：本拍像素就是 chunk0 的 pixel0 ⇒ wr_pix_cnt=1 / pix_in_frame=1
            //   2) 帧号只在此推进：px_frame_next = frame_seen ? px_frame+1 : 0
            //   3) 抽帧在此判决：本帧整帧是否回传（decim），与 ">= " 的钳位语义一致
            //   4) 重同步挂起在此清除（真帧首 = 恢复入队的唯一合法时刻）
            //   5) 不清 wr_slot / n_full / rd_slot：环里已排队的旧槽照常用自己的标签发完，
            //      wr_slot = rd_slot + n_full 不变式不受影响。
            //--------------------------------------------------------------------------
            if (snap_now) begin
                wr_pix_cnt     <= 10'd1;
                pix_in_frame   <= 19'd1;
                px_chunk       <= 16'd0;
                px_frame       <= px_frame_next;
                frame_seen     <= 1'b1;
                marker_seen    <= marker_seen | i_raw_frame_start;
                // ★ 抽帧判决（帧首决定，但用一级流水 send_pend 保住旧时序）：
                //   本帧回传与否 = send_pend（上一帧首就采样好的判决）；同一拍再用 decim_cnt
                //   采样出**下一帧**的判决。这样"取模计数器采样点"与旧实现（帧尾 frame_wrap
                //   判决）**逐拍等价**：i_frame_decim 在「上一帧帧尾 → 本帧帧首」这一拍窗口内
                //   变更时，本帧仍沿用变更前的判决（下一帧才生效），不会因为判决点从帧尾挪到
                //   帧首而多发/少发一帧。阈值不变时两种写法完全同序列。
                send_frame     <= send_pend;
                chunk_send     <= send_pend;   // 本帧 chunk0 的入队门（chunk1..9 从 send_frame 取）
                send_pend      <= send_now;
                decim_cnt      <= send_now ? 16'd0 : (decim_cnt + 16'd1);
                resync_pending <= 1'b0;
            end
        end
    end

    //--------------------------------------------------------------------------
    // 事件写侧：双页（收集页 / 待发页），一事件一写
    //   ★ v3：写入门限 = cap_recs_q（MODE2=289 / 其余=33），保证待发页条数
    //         永不超过本包容量 —— "发完即换页清空"的旧语义不变、无静默丢失。
    //   ★ v3：RAW_ONLY / EV_EN=0 时事件不上行：不采集、不计 drop（模式语义）。
    //   （页指针 ev_rec_wr/pd、页基址已在模块前部声明 —— 先声明后引用）
    //--------------------------------------------------------------------------

    // ★ 存储写口（下方独立"无复位写"块）用的使能与地址。
    //   与 v2 原实现逐字等价（v2：ev_up_en 恒 1、门限 35）：
    //     · ev_swap_now && i_ev_valid          → 地址 ev_wr_base_nxt
    //     · !ev_swap_now && i_ev_valid && 未满 → 地址 ev_wr_base + ev_rec_wr
    wire        ev_swap_take = i_ev_valid && ev_up_en;                    // 交换拍可收 1 条
    wire        ev_wr_en   = ev_swap_take ||
                             (i_ev_valid && ev_up_en && (ev_rec_wr < cap_recs_q));
    wire [9:0]  ev_wr_addr = ev_swap_now ? ev_wr_base_nxt : (ev_wr_base + {1'b0, ev_rec_wr});

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            ev_wr_page     <= 1'b0;
            ev_rec_cnt0    <= 9'd0;
            ev_rec_cnt1    <= 9'd0;
            o_stat_drop_ev <= 16'd0;
        end
        else begin
            if (ev_swap_now) begin
                // 页交换：旧收集页 → 新待发页（保留条数，下一包发）
                //         旧待发页 → 新收集页（清空）
                ev_wr_page <= ~ev_wr_page;
                if (ev_wr_page) ev_rec_cnt0 <= 9'd0;
                else            ev_rec_cnt1 <= 9'd0;
                // 交换同拍到的事件不丢，写进新收集页的第 0 条（写口在下方无复位块）
                if (ev_swap_take) begin
                    if (ev_wr_page) ev_rec_cnt0 <= 9'd1;
                    else            ev_rec_cnt1 <= 9'd1;
                end
            end
            else if (i_ev_valid && ev_up_en && (ev_rec_wr < cap_recs_q)) begin
                if (ev_wr_page) ev_rec_cnt1 <= ev_rec_cnt1 + 9'd1;
                else            ev_rec_cnt0 <= ev_rec_cnt0 + 9'd1;
            end
            else if (i_ev_valid && ev_up_en) begin
                o_stat_drop_ev <= o_stat_drop_ev + 16'd1;     // 事件页满，丢
            end
        end
    end

    //--------------------------------------------------------------------------
    // ★ 存储写口：**必须**是独立、无复位的 always 块（实测 2026-10-06）
    //   写条件与 v2 原实现逐字等价（仅事件写使能乘了 v3 的模式/使能门）。
    //   放进 `always @(posedge clk or negedge rst_n)` 会被 Vivado 判为
    //   "RAM is sensitive to asynchronous reset" ⇒ 溶解成几万触发器。
    //--------------------------------------------------------------------------
    always @(posedge clk_eth) begin
        if (pix_accept) begin
            // ★ SEAM-LINKDROP-20261017：帧首快照那一拍强制写到槽内偏移 0 —— 本拍像素
            //   是源侧声明的 chunk0 pixel0，原先可能落在半帧中间（正是画面拼接的直接原因）。
            raw_ram[wr_slot_base + {2'b0, (snap_now ? 10'd0 : wr_pix_cnt)}] <= i_raw_data;
            // ★ 修复 RAW-PHASE-20261017：槽首锁存本槽内容像素的真实相位标签
            //   （px_frame/px_chunk 在上一槽填满时已更新 ⇒ 本槽准确）
            // ★ SEAM-LINKDROP-20261017：快照拍也算槽首（且标签用**下一帧**帧号 + chunk0，
            //   因为 px_frame/px_chunk 要等本拍末才被 snap 块更新）。
            if (snap_now || (accept_normal && (wr_pix_cnt == 10'd0))) begin
                tag_frame[wr_slot] <= snap_now ? px_frame_next : px_frame;
                tag_chunk[wr_slot] <= snap_now ? 16'd0 : px_chunk;
            end
        end

        if (ev_wr_en)
            ev_ram[ev_wr_addr[9:0]] <= {i_ev_x[7:0], i_ev_x[8], i_ev_y, i_ev_pol};
    end

    //--------------------------------------------------------------------------
    // 同步读口（推断 BRAM：一写一读）
    //--------------------------------------------------------------------------
    always @(posedge clk_eth) begin
        raw_rdata <= raw_ram[rd_slot_base + {2'b0, raw_rd_addr}];
        ev_rdata  <= ev_ram [ev_rd_base  + ev_rd_rec];
    end

    assign o_frame_idx = frame_idx;

endmodule
