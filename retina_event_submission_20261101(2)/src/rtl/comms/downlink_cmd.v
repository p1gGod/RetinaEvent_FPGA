//==============================================================================
// downlink_cmd.v —— 以太网下行命令解析 / ACK 构包（WIRE-V3 §6，R3；v3.1 增补 EV_EN）
//
// 设计依据：docs/05_experiments/协议v3设计_20261009/v3线协议设计.md
//   §6.1  下行包：MAGIC_D=F0 5A A5 31 / VER=3 / OPCODE / SEQ(2) / LEN(2) /
//         PAYLOAD / CRC16(CCITT-FALSE，覆盖 [0..10+LEN-1])。
//         软件白名单（§6.1 端口过滤的现实）：MAGIC_D + VER + CRC + OPCODE 白名单
//         全过才接受；CRC 错 ⇒ dlCrcFail++ 不回应；OPCODE 非白名单 ⇒
//         dlBadOpcode++ 不回应；魔数/版本不符 ⇒ dlReject++ 丢弃到包尾。
//   §6.2  ACK / 心跳：v3 上行 24 B 头（FLAGS.bit7=CTRL、bit2=CRC）+ 6 B 控制头
//         (OPCODE/STATUS/SEQ/CTRL_LEN) + TLV + CRC16（覆盖 [0..30+CTRL_LEN-1]）。
//   §6.3  SET_PARAM(0x01) 原子写（先全验后写）；SET_MODE(0x02) 幂等；
//         TIME_SYNC(0x03) offset = FLAG? HOST−t4 : HOST+RTT_HALF−t4；
//         GET_STATUS(0x04) 全量 TLV；0xF0 心跳 1 Hz；0x83 TIME_SYNC_REQ 转发。
//   v3.1  EV_EN(0x05)：1 B 载荷（1=使能 0=禁用），ACK TLV 0x8C（2026-10-11 批准）。
//
// TLV 字节数速查（tag1+len1+value 合计）：MODE/TS_FLAGS/EV_EN/EV_RES/NET_STATE/ACTION_STATE=3、
// THETA/MIN_DL/RTT/FRAME_IDX=4、FW=5、SER_STATE=5、DROP/BOOT_ID=6、TS_OFFSET=8、EXP_CAP=4 ⇒
//   SET_PARAM ACK=26 / SET_MODE ACK=3 / TIME_SYNC ACK=11 / EV_EN ACK=3 /
//   GET_STATUS ACK=71（★M4b；TLV 68→71） / 心跳=25 / REQ=6（裸 6 B BOARD_TS_US）。
//
// ★ WIRE-U1 串口路线扩展（2026-10-12，设计 §3.7/§5.3；见 UART 实现报告 §2.6）：
//   · SET_PARAM 新 tag（**按存在写**：未出现的 tag 不动其寄存器，与 §6.3.1
//     "TLV 列表"语义一致；既有 0x01..0x06 保持 v3 原行为不动——回归保护）：
//       0x07 EV_RES(1B 0/1/2)  0x08 SER_DECIM(1B 1..255)
//       0x09 SER_AGG(1B 0/1/2) 0x0A SER_EV_FLUSH_MS(2B 5..1000)
//     互斥规则（§3.5）：写后 SER_AGG≠0 且 EV_RES≠0 ⇒ STATUS=BAD_VALUE 整条不写。
//   · 上行 TLV：0x8D EV_RES_STATE(1)/0x8E SER_STATE(3={DECIM,AGG,uartEvDrop})/
//     0x8F NET_STATE(1：0=DOWN/1=UP/2=UNKNOWN)——进 SET_PARAM ACK / GET_STATUS / 心跳。
//
// ★ SCCB 集成扩展（2026-10-13，sccb_patch 集成任务；见 sccb集成报告 §3/§4）：
//   · SET_PARAM 新 tag **0x0B EXP_CAP（2 B，MSB 先，单位 = 行）**，值域 [4, 5904]：
//       4    = sccb_patch 的 EXP_CAP_MIN（至少 4 行）
//       5904 = 0x1710 = 厂家基线原上限（**不放宽**，与 EXP_CAP_MAX 一致）
//     越界 ⇒ STATUS=BAD_VALUE(0x04) 且**整条不写**（沿用 §6.3.1 原子性与 §3.5 模式）。
//     写成功后按"按存在写"输出 o_exp_cap（16 bit 电平）+ o_exp_cap_upd（toggle）：
//     top 用 cdc_tog_word 过域到 clk_cam 的 sys_ctrl，其 o_exp_cap_upd 再进
//     display_path 的 sccb_patch ⇒ **沿 = 重跑整条 4 条 SCCB 写序列**（新值生效）。
//   · 上行 TLV **0x90 EXP_CAP_STATE（len=2，BE）**：进 SET_PARAM ACK 与 GET_STATUS
//     （写后读回；GET_STATUS 读 o_exp_cap = 真值源）。心跳不加（与 0x8D 同款处理）。
//   · 长度变化：SET_PARAM ACK CTRL_LEN 19 → **23**（全包 51 → 55 B）；
//     GET_STATUS ACK CTRL_LEN 61 → **65**（全包 93 → 97 B）。上位机必须同步！
//   · 串口（连续字节流）与 UDP 共用本解析器：`i_rx_stream=1` 时坏字节**逐字节重同步**
//     （P_SKIP 语义不适用）、帧间零散字节不计 dlReject；`i_rx_stream=0`（或不接）时
//     保持 UDP 原行为（丢弃到包尾后靠 pkt_done 重同步）。
//   · `o_dl_accepted`：合法下行帧被接受（CRC 过 + OPCODE 白名单）的 1 拍脉冲，
//     供 link_detect 的 L2 应用层判据（§5.1）使用。
//   · `i_net_chg`：探测状态变化脉冲 ⇒ 立即插发一条状态 CTRL（§5.3）。
//
// ★ WIRE-U2 串口波特率 4 档运行时切换（2026-10-17，见接口约定 §1 与波特率RTL报告）：
//   · SET_PARAM 新 tag **0x0C SER_BAUD（1 B，0..3）**：0=115200 / 1=230400 /
//     2=460800 / 3=921600，复位默认 0（=115200，与 uart_link 的 UART_BAUD 参数一致）。
//     越界（>3）⇒ STATUS=BAD_VALUE(0x04)；长度≠1 ⇒ BAD_LEN(0x03)；两者都**整条不写**
//     （含不切换波特率）——与 0x0B 同款原子语义。
//   · 上行 TLV **0x91 SER_BAUD_STATE（len=1）**：进 SET_PARAM ACK（0x90 之后）与
//     GET_STATUS；心跳不加（与 0x8D/0x90 同款处理）。
//   · 长度变化：SET_PARAM ACK CTRL_LEN 23 → **26**（全包 55 → 58 B）；
//     GET_STATUS ACK CTRL_LEN 65 → **68**（全包 97 → 100 B）。上位机必须同步！
//   · 切换时机（关键）：`o_ser_baud_commit` 只在 ACK 整包（B_CRC2 推完 CRC 低字节、
//     B_COMMIT 那一拍）翻转 ⇒ 串口侧收到 commit 时 ACK 全部字节**已写入 CTRL 通道**；
//     uart_link 再等"FIFO 排空 + TX 移位完 + 线路空闲"才真正改分频（迟滞见该模块）。
//   · 交叉读回语义：ACK/GET_STATUS 里的 0x91 取 pkt_ser_baud（= 本次写入值 / 当前真值），
//     因此"写 2 后立刻 GET_STATUS"读到的是 2，即使 uart_link 侧可能还没切完。
//
// ★ M4b 动作回传（2026-10-29，task-11；契约 docs/03_tech/05_action_uplink_contract.md）：
//   · 上行 TLV **0x92 ACTION_STATE（len=1）**：value = byte23 =
//     {VALID, CONF[4:0], CLASS[1:0]}，与数据帧 byte23 **同源**（同一个 act_state_cdc 锁存值；
//     本模块直接读 i_act_byte 端口，不再自行锁存/重算 ⇒ 两条通道严格同快照，契约 §3 末段）。
//   · **只**随 GET_STATUS(0x04) ACK 尾追（0x91 之后）；SET_PARAM ACK / 心跳 / 其它 ACK 不加。
//   · 长度变化：GET_STATUS ACK CTRL_LEN 68 → **71**（全包 100 → 103 B）。上位机须同步；
//     旧 68 B（100 B）帧仍按 TLV 顺序解析，未知 tag 跳过即可（契约要求向后兼容）。
//   · 无有效判定时 = 0x00（VALID=0），不是"缺 TLV"。
//
// 时钟域：clk_eth（与 eth_udp 的 RX 异步 FIFO 读侧、udp_merge、ts_gen 同域，无 CDC）。
// 参数寄存器（θ/δL/模式/事件使能）走 toggle + 同值双 CDC（top 内 sync_ff）进
// clk_cam 的 sys_ctrl —— last-writer-wins（§3.2）。
//
// ⚠️ 本模块不解析 ARP / 非 UDP 载荷 —— 厂家 udp_rx 已过滤目的 IP 与协议类型，
//    其余"到板 IP 的任何 UDP 载荷"都会进解析器，首字节比较即短路（§6.1 副作用）。
//==============================================================================
`timescale 1ns / 1ps

module downlink_cmd #(
    parameter          HEARTBEAT_CYC = 125_000_000,  // 1 Hz @125 MHz（§6.3.5，TB 可改小）
    parameter [15:0]   FW_VER        = 16'h0003,     // TLV 0x8A FW_VER
    parameter [7:0]    WIRE_VER_B    = 8'h03         // TLV 0x8A WIRE_VER
)(
    input  wire        clk_eth,
    input  wire        rst_n_eth,
    // ---- RX 字节流（eth_udp RX 异步 FIFO 读侧，FWFT：i_rx_valid=!empty）----
    input  wire        i_rx_valid,
    input  wire [7:0]  i_rx_data,
    output wire        o_rx_rd_en,      // 恒 1：FIFO 内部按空门控
    input  wire        i_rx_pkt_done,   // 包边界脉冲（clk_eth 域）：重同步 / 半包丢弃
    // ---- 串口路线扩展（WIRE-U1）----
    input  wire        i_rx_stream,     // 1 = 本拍字节来自连续字节流（串口）：坏字节逐字节重同步
    input  wire [1:0]  i_net_state,     // link_detect 状态：0=DOWN/1=UP/2=UNKNOWN（TLV 0x8F）
    input  wire        i_net_chg,       // 状态变化 1 拍脉冲 ⇒ 即时插发一条状态 CTRL
    input  wire [7:0]  i_ser_drop,      // uartEvDrop[7:0]（clk_cam 域两级同步后，TLV 0x8E 第 3 字节）
    // ---- 板级状态输入（构 ACK / 心跳用，构包起点统一快照）----
    input  wire [1:0]  i_mode,          // 当前模式（sys_ctrl 同步副本）
    input  wire [47:0] i_ts_us,         // 对齐后时间戳（包头 TS 字段来源）
    input  wire [47:0] i_ts_local_us,   // 本机时间戳（算 t4）
    input  wire [47:0] i_ts_offset,     // offset_reg（TLV 0x84）
    input  wire        i_ts_valid,
    input  wire        i_ts_calibrated,
    input  wire        i_ts_stale,
    input  wire [15:0] i_rtt_us,        // 最近 RTT（TLV 0x85）
    input  wire [31:0] i_boot_id,
    input  wire [15:0] i_frame_idx,
    input  wire [15:0] i_drop_px,
    input  wire [15:0] i_drop_ev,
    input  wire        i_ev_en,         // 当前事件支路使能（GET_STATUS 读回）
    // ★ M4b：动作字节（VALID|CONF|CLASS），来自 act_state_cdc 的同一份锁存值（TLV 0x92）
    input  wire [7:0]  i_act_byte,
    // ---- ts_gen 的 TIME_SYNC_REQ 转发（§5.1 第 1 步）----
    input  wire        i_cal_req,       // 1 拍脉冲
    input  wire [15:0] i_cal_seq,
    input  wire [47:0] i_board_ts,      // t2
    output reg         o_sync_matched,  // TIME_SYNC 的 SEQ 匹配最近 REQ（ts_gen 记 RTT）
    // ---- 参数写入输出（θ/δL/模式/事件使能 = toggle + 稳定值，top 内 sync_ff 过域）----
    output reg  [11:0] o_theta,
    output reg         o_theta_upd,
    output reg  [8:0]  o_min_dl,
    output reg         o_min_dl_upd,
    output reg  [1:0]  o_mode_set,
    output reg         o_mode_set_upd,
    output reg         o_ev_en,         // ★ v3.1 EV_EN 写入值
    output reg         o_ev_en_upd,     // ★ v3.1 EV_EN 翻转标志
    output reg  [7:0]  o_frame_decim,   // 电平值（udp_merge 直接采用）
    output reg  [23:0] o_ev_flush_cyc,  // 电平值
    // ---- ★ WIRE-U1 串口参数写入输出（toggle + 稳定值，top 内 sync_ff 过域）----
    output reg  [1:0]  o_ev_res,        // SET_PARAM tag 0x07 写入值
    output reg         o_ev_res_upd,    // 翻转标志
    output reg  [7:0]  o_ser_decim,     // tag 0x08（1..255）
    output reg         o_ser_decim_upd,
    output reg  [1:0]  o_ser_agg,       // tag 0x09（0/1/2）
    output reg         o_ser_agg_upd,
    output reg  [15:0] o_ser_flush_ms,  // tag 0x0A（5..1000 ms）
    output reg         o_ser_flush_upd,
    // ---- ★ SCCB 集成：曝光上限运行时可写（tag 0x0B，→ sys_ctrl → sccb_patch）----
    output reg  [15:0] o_exp_cap,       // cap（行，4..5904）；复位默认 = 0x1710（基线档）
    output reg         o_exp_cap_upd,   // toggle：沿 = "cap 已改" ⇒ 补写序列重跑
    // ---- ★ WIRE-U2：串口波特率 4 档运行时切换（tag 0x0C，→ uart_link）----
    output reg  [1:0]  o_ser_baud_sel,  // 0=115200 / 1=230400 / 2=460800 / 3=921600
    output reg         o_ser_baud_commit, // toggle：沿 = "ACK 整包已写入 CTRL 通道" ⇒ 可切换
    output reg         o_dl_accepted,   // 1 拍：合法下行帧被接受（CRC 过 + OPCODE 白名单）
    output reg         o_period_wr,     // 1 拍（ts_gen 校准周期）
    output reg  [16:0] o_period_s,
    output reg         o_force_cal,     // 1 拍（ts_gen 立即校准）
    output reg         o_off_wr,        // 1 拍（ts_gen offset 写入）
    output reg  [47:0] o_off_data,
    // ---- CTRL 包推送（→ udp_merge 内部小 FIFO，优先于数据包）----
    output reg         o_ctrl_wr_en,
    output reg  [7:0]  o_ctrl_data,
    output reg         o_ctrl_commit,
    input  wire        i_ctrl_empty,
    // ---- 统计（观测 / ILA）----
    output reg  [15:0] o_stat_dl_crc_fail,
    output reg  [15:0] o_stat_dl_bad_opcode,
    output reg  [15:0] o_stat_dl_reject
);

    //--------------------------------------------------------------------------
    // 常量（§6.1 / §6.2 / §6.3 / v3.1）
    //--------------------------------------------------------------------------
    localparam [7:0] OP_SET_PARAM = 8'h01;
    localparam [7:0] OP_SET_MODE  = 8'h02;
    localparam [7:0] OP_TIME_SYNC = 8'h03;
    localparam [7:0] OP_GET_STATUS= 8'h04;
    localparam [7:0] OP_EV_EN     = 8'h05;   // ★ v3.1 增补（lead 批准 2026-10-11）
    localparam [7:0] OP_STATUS_HB = 8'hF0;
    localparam [7:0] OP_TIME_REQ  = 8'h83;

    localparam [7:0] ST_OK        = 8'h00;
    localparam [7:0] ST_BAD_LEN   = 8'h03;
    localparam [7:0] ST_BAD_VALUE = 8'h04;

    localparam [7:0] T_THETA      = 8'h01;
    localparam [7:0] T_MIN_DL     = 8'h02;
    localparam [7:0] T_FRAME_DECIM= 8'h03;
    localparam [7:0] T_EV_FLUSH   = 8'h04;
    localparam [7:0] T_CAL_PERIOD = 8'h05;
    localparam [7:0] T_FORCE_CAL  = 8'h06;
    // ★ WIRE-U1 §3.7 串口路线新 tag（下一未用码）
    localparam [7:0] T_EV_RES     = 8'h07;
    localparam [7:0] T_SER_DECIM  = 8'h08;
    localparam [7:0] T_SER_AGG    = 8'h09;
    localparam [7:0] T_SER_FLUSH  = 8'h0A;
    localparam [7:0] T_EXP_CAP    = 8'h0B;   // ★ SCCB 集成：曝光上限（2B，4..5904）
    localparam [7:0] T_SER_BAUD   = 8'h0C;   // ★ WIRE-U2 串口波特率档位（1B，0..3）
    // ★ 曝光上限值域（与 sccb_patch 的 EXP_CAP_MIN/EXP_CAP_MAX 一致；改这里要同步）
    localparam [15:0] EXP_CAP_MIN = 16'd4;
    localparam [15:0] EXP_CAP_MAX = 16'h1710;      // 5904 = 厂家基线原上限，不放宽

    localparam [7:0] U_MODE       = 8'h81;
    localparam [7:0] U_THETA      = 8'h82;
    localparam [7:0] U_MIN_DL     = 8'h83;
    localparam [7:0] U_TS_OFFSET  = 8'h84;
    localparam [7:0] U_RTT        = 8'h85;
    localparam [7:0] U_TS_FLAGS   = 8'h86;
    localparam [7:0] U_FRAME_IDX  = 8'h87;
    localparam [7:0] U_DROP       = 8'h88;
    localparam [7:0] U_BOOT_ID    = 8'h89;
    localparam [7:0] U_FW         = 8'h8A;
    localparam [7:0] U_EV_EN      = 8'h8C;   // ★ v3.1 增补 TLV（读回事件支路使能）
    // ★ WIRE-U1 §3.7/§5.3 新 TLV
    localparam [7:0] U_EV_RES     = 8'h8D;   // 分辨率档读回（1 B）
    localparam [7:0] U_SER_STATE  = 8'h8E;   // {SER_DECIM, SER_AGG, uartEvDrop}（3 B）
    localparam [7:0] U_NET_STATE  = 8'h8F;   // 0=DOWN / 1=UP / 2=UNKNOWN（1 B）
    localparam [7:0] U_EXP_CAP    = 8'h90;   // ★ 曝光上限读回（2 B，BE，行；4..5904）
    localparam [7:0] U_SER_BAUD   = 8'h91;   // ★ WIRE-U2 波特率档位读回（1 B，0..3）
    localparam [7:0] U_ACTION     = 8'h92;   // ★ M4b 动作状态读回（1 B = byte23）

    // ---- 串口流模式（i_rx_stream 的防御性量化：未接端口 = Z ⇒ 按 UDP 语义 0）----
    wire rx_stream_s = (i_rx_stream === 1'b1);
    // ---- NET_STATE 量化（未接 = Z ⇒ 0=DOWN，进 TLV 不留 X）----
    wire [1:0] net_state_s = (i_net_state === 2'b10) ? 2'd2 :
                             (i_net_state === 2'b01) ? 2'd1 : 2'd0;
    // ---- 动作字节直读（M4C：顶层已接实；上电 0x00 由 act_state_cdc 复位保证）----
    wire [7:0] act_byte_s = i_act_byte;

    //--------------------------------------------------------------------------
    // CRC-16/CCITT-FALSE（与 udp_merge / 上位机 codec/crc.ts 同一套）
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
    // 解析状态机（每个状态消费自己的字节并并入 CRC，杜绝错位）
    //--------------------------------------------------------------------------
    localparam [3:0] P_MAGIC0=4'd0, P_MAGIC1=4'd1, P_MAGIC2=4'd2, P_MAGIC3=4'd3,
                     P_VER=4'd4, P_OP=4'd5, P_SEQ0=4'd6, P_SEQ1=4'd7,
                     P_LEN0=4'd8, P_LEN1=4'd9, P_PAYLOAD=4'd10,
                     P_CRC0=4'd11, P_CRC1=4'd12, P_DISPATCH=4'd13, P_SKIP=4'd14;

    reg [3:0]  pstate;
    reg [15:0] crc_rx;
    reg [7:0]  op_r;
    reg [15:0] seq_r;
    reg [15:0] len_r;
    reg [15:0] pay_left;
    reg [7:0]  crc_hi_r;
    reg        crc_match;      // P_CRC1 拍的比对结果（P_DISPATCH 无条件节使用）

    // ---- SET_PARAM 的 TLV 流式解析 ----
    reg [1:0]  tlv_st;          // 0=tag 1=len 2=value
    reg [7:0]  tlv_tag;
    reg [7:0]  tlv_len;
    reg [7:0]  tlv_got;
    reg [15:0] val16;
    reg [31:0] val32;

    reg        tlv_bad_len;     // TLV 结构越出载荷 / 已知 tag 长度不符
    reg        tlv_bad_val;     // 任一值越界（原子性：整条不写）
    reg        tlv_seen;        // 至少一条 TLV（LEN=0 ⇒ BAD_LEN）
    reg [15:0] s_theta;
    reg [15:0] s_min_dl;
    reg [15:0] s_decim;
    reg [31:0] s_flush;
    reg [31:0] s_period;
    reg [7:0]  s_force;
    reg [7:0]  unsup_tag [0:7];
    reg [3:0]  unsup_cnt;

    // ---- ★ WIRE-U1：全部 SET_PARAM tag 一律"按存在写"（§6.3.1 TLV 列表语义）----
    //   理由：若维持 v3 实现的"每次 OK 都写全部暂存值"，则只带新 tag（如 SER_DECIM）
    //   的命令会把**未出现的** θ/δL/抽帧/看门狗清零（实测风险，见实现报告 §6.1）。
    reg        p_theta;
    reg        p_mindl;
    reg        p_decim_o;       // 旧 tag 0x03 FRAME_DECIM
    reg        p_flush_o;       // 旧 tag 0x04 EV_FLUSH_CYC
    reg        p_period;
    // ---- ★ WIRE-U1：SER 参数暂存 + "存在标志"（按存在写）----
    reg [7:0]  s_ev_res;
    reg [7:0]  s_ser_decim;
    reg [7:0]  s_ser_agg;
    reg [15:0] s_ser_flush;
    reg        p_ev_res;
    reg        p_decim;
    reg        p_agg;
    reg        p_flush;
    // ---- ★ SCCB 集成：曝光上限暂存 + 存在标志（按存在写）----
    reg [15:0] s_exp_cap;
    reg        p_exp_cap;
    // ---- ★ WIRE-U2：波特率档位暂存 + 存在标志 ----
    reg [7:0]  s_ser_baud;
    reg        p_ser_baud;

    // 写后生效值（present ? staged : current）——互斥校验用（§3.5）
    wire [1:0] eff_ev_res  = p_ev_res  ? s_ev_res[1:0]   : o_ev_res;
    wire [1:0] eff_ser_agg = p_agg     ? s_ser_agg[1:0]  : o_ser_agg;
    wire       excl_viol   = (eff_ser_agg != 2'd0) && (eff_ev_res != 2'd0);

    // ---- SET_MODE / EV_EN / TIME_SYNC 载荷 ----
    reg [7:0]  s_mode;
    reg [7:0]  s_ev_en;
    reg [47:0] s_host_ts;
    reg [15:0] s_rtt_half;
    reg [7:0]  s_flag;
    reg [3:0]  pay_bidx;        // 定长载荷字节序号（≤9）

    //--------------------------------------------------------------------------
    // 派发暂存（dispatch → builder）
    //--------------------------------------------------------------------------
    localparam [1:0] K_NONE=2'd0, K_ACK=2'd1, K_HB=2'd2, K_REQ=2'd3;

    reg [1:0]  r_kind;
    reg [7:0]  r_opcode;
    reg [7:0]  r_status;
    reg [15:0] r_seq;
    reg [1:0]  r_mode;
    reg [15:0] r_theta;
    reg [15:0] r_min_dl;
    reg [7:0]  r_ev_en;
    reg [1:0]  r_ev_res;        // ★ WIRE-U1（ACK TLV 0x8D 读回）
    reg [7:0]  r_ser_decim;     // ★ WIRE-U1（ACK TLV 0x8E[0]）
    reg [1:0]  r_ser_agg;       // ★ WIRE-U1（ACK TLV 0x8E[1]）
    reg [15:0] r_exp_cap;       // ★ SCCB 集成（ACK TLV 0x90 读回）
    reg [1:0]  r_ser_baud;      // ★ WIRE-U2（ACK TLV 0x91 读回）
    reg        r_baud_commit;   // ★ WIRE-U2：本包 ACK 写完后请求切换
    reg [47:0] r_ts_off;
    reg [7:0]  r_ts_flags;
    reg [47:0] r_req_ts;
    reg        hb_due;

    //--------------------------------------------------------------------------
    // ★ 修复 P0-STALL-20261012（构包请求两级缓冲：r_* = 待取，p_* = 在途）
    //   原实现把 parser 派发的请求（r_*）**直接当在途构包源**（pkt_byte/tlv_byte
    //   逐字节读 r_*），于是：
    //     ① 新命令的派发若落在 B_RUN/B_CRC（构包中），在途包的 opcode/SEQ/STATUS
    //        会被新值改写（错包）；
    //     ② 该请求随后被 B_COMMIT 的 `r_kind <= K_NONE` 抹掉 ⇒ **这条命令永远
    //        收不到 ACK**（只能等主机 1 s 超时）——现场 §4.6 "5 条里 2 条超时"的
    //        同型机理；本 TB 用 22:18 序列复现时命中的正是 GET_STATUS seq=2。
    //   修法：B_IDLE 取走请求时**快照到 p_**（在途包只用 p_*），并把 r_kind 立即
    //   置 K_NONE；由于 parser 的派发赋值在本 always 块中位于其后，**同拍新派发
    //   仍然生效**（既不丢也不串包）。REQ/心跳走各自独立来源（req_l/req_seq_l/
    //   req_ts_l、hb_seq），不再借用 r_* 槽。
    //--------------------------------------------------------------------------
    reg [1:0]  pkt_kind;
    reg [7:0]  pkt_opcode;
    reg [7:0]  pkt_status;
    reg [15:0] pkt_seq;
    reg [1:0]  pkt_mode;
    reg [15:0] pkt_theta;
    reg [15:0] pkt_min_dl;
    reg [7:0]  pkt_ev_en;
    reg [1:0]  pkt_ev_res;
    reg [7:0]  pkt_ser_decim;
    reg [1:0]  pkt_ser_agg;
    reg [15:0] pkt_exp_cap;     // ★ SCCB 集成（ACK TLV 0x90 的在途快照）
    reg [1:0]  pkt_ser_baud;    // ★ WIRE-U2（ACK TLV 0x91 的在途快照）
    reg        pkt_baud_commit; // ★ WIRE-U2
    reg [47:0] pkt_ts_off;
    reg [7:0]  pkt_ts_flags;
    reg [47:0] pkt_req_ts;

    reg [15:0] hb_seq;
    reg [31:0] hb_cnt;
    reg        req_l;           // REQ 锁存（构包器忙时不得丢失）
    reg [15:0] req_seq_l;
    reg [47:0] req_ts_l;
    reg        net_chg_l;       // ★ WIRE-U1：探测状态变化锁存（构包器忙时不得丢失）
    reg        frame_stream;    // ★ 当前在途帧是否始于串口流（决定 pkt_done 是否适用）

    wire [7:0] tflags_snap = {2'b00, 1'b0, i_ts_stale, i_ts_calibrated};

    //--------------------------------------------------------------------------
    // TIME_SYNC 的 offset 计算（§6.3.3；t4 = 派发时刻的本机 µs）
    //   FLAG.bit0=1 ⇒ offset = HOST − t4（直接对基准）
    //   FLAG.bit0=0 ⇒ offset = HOST + RTT_HALF − t4；RTT_HALF=0 且 SEQ 匹配
//                 本板未决 REQ ⇒ 自算 (t4−t2)/2（标准 NTP 形式）
    //--------------------------------------------------------------------------
    wire [47:0] t4_now     = i_ts_local_us;
    wire [47:0] rtt_self   = (t4_now - i_board_ts) >> 1;         // (t4−t2)/2
    wire [15:0] rtt_half_e = (s_rtt_half != 16'd0) ? s_rtt_half : rtt_self[15:0];
    wire [47:0] off_calc   = s_flag[0] ? (s_host_ts - t4_now)
                                       : (s_host_ts + {32'd0, rtt_half_e} - t4_now);
    wire        seq_match  = (seq_r == i_cal_seq);

    //--------------------------------------------------------------------------
    // 构包器（B_*）：等 CTRL FIFO 空 → 快照 → 逐字节推送 → commit
    //--------------------------------------------------------------------------
    localparam [2:0] B_IDLE=3'd0, B_WAIT=3'd1, B_SNAP=3'd2, B_RUN=3'd3,
                     B_CRC1=3'd4, B_CRC2=3'd5, B_COMMIT=3'd6;
    reg [2:0]  bstate;
    reg [6:0]  b_idx;
    reg [6:0]  b_total;         // 全包字节数 = 32 + CTRL_LEN（最大 82）
    reg [15:0] b_crc;
    reg [47:0] b_ts;
    reg [15:0] b_frame;
    reg [1:0]  b_mode;
    reg [7:0]  b_flags;
    reg [15:0] b_clen;          // CTRL_LEN
    reg [7:0]  b_byte;          // 本拍要推的字节（与 CRC 同源，杜绝错位）
    reg        b_baud_commit;   // ★ WIRE-U2：本包是"波特率切换"的 ACK

    // CTRL_LEN 由 kind/opcode/status 决定（与 tlv_byte 的布局严格对应）
    function [15:0] ctrl_len_of;
        input [1:0] kind;
        input [7:0] opcode;
        input [7:0] status;
        begin
            if (kind == K_REQ)          ctrl_len_of = 16'd6;   // 裸 BOARD_TS_US[47:0]
            else if (kind == K_HB)      ctrl_len_of = 16'd25;  // 3+3+6+4+6+3(★NET_STATE)
            else if (status != ST_OK)   ctrl_len_of = 16'd0;
            else case (opcode)
                OP_SET_MODE:   ctrl_len_of = 16'd3;    // MODE
                OP_TIME_SYNC:  ctrl_len_of = 16'd11;   // TS_OFFSET(8)+TS_FLAGS(3)
                OP_EV_EN:      ctrl_len_of = 16'd3;    // EV_EN
                OP_GET_STATUS: ctrl_len_of = 16'd71;   // 全量（★M4b：再追加 ACTION_STATE 3B）
                default:       ctrl_len_of = 16'd26;   // SET_PARAM: MODE+THETA+MIN_DL+EV_RES+SER_STATE+EXP_CAP+★BAUD
            endcase
        end
    endfunction

    // TLV 区第 i 字节（i 从 0 起）—— 纯组合译码
    // ★ 修复 P0-STALL-20261012：构包源一律取 p_*（在途快照），不再读 r_*（待取槽）
    function [7:0] tlv_byte;
        input [1:0]  kind;
        input [7:0]  opcode;
        input [7:0]  status;
        input [6:0]  i;        // TLV 区偏移
        reg [15:0] th, md;
        begin
            th = pkt_theta;
            md = pkt_min_dl;
            if (kind == K_REQ) begin
                // §5.1 (1)：OPCODE=0x83 的载荷 = 裸 6 B BOARD_TS_US[47:0]（BE）
                case (i)
                    6'd0: tlv_byte = pkt_req_ts[47:40];
                    6'd1: tlv_byte = pkt_req_ts[39:32];
                    6'd2: tlv_byte = pkt_req_ts[31:24];
                    6'd3: tlv_byte = pkt_req_ts[23:16];
                    6'd4: tlv_byte = pkt_req_ts[15:8];
                    default: tlv_byte = pkt_req_ts[7:0];
                endcase
            end
            else if (kind == K_HB) begin
                case (i)
                    6'd0 : tlv_byte = U_MODE;      // MODE (3)
                    6'd1 : tlv_byte = 8'd1;
                    6'd2 : tlv_byte = {6'd0, pkt_mode};
                    6'd3 : tlv_byte = U_TS_FLAGS;  // TS_FLAGS (3)
                    6'd4 : tlv_byte = 8'd1;
                    6'd5 : tlv_byte = pkt_ts_flags;
                    6'd6 : tlv_byte = U_DROP;      // DROP_PX/EV (6)
                    6'd7 : tlv_byte = 8'd4;
                    6'd8 : tlv_byte = i_drop_px[15:8];
                    6'd9 : tlv_byte = i_drop_px[7:0];
                    6'd10: tlv_byte = i_drop_ev[15:8];
                    6'd11: tlv_byte = i_drop_ev[7:0];
                    6'd12: tlv_byte = U_FRAME_IDX; // FRAME_IDX (4)
                    6'd13: tlv_byte = 8'd2;
                    6'd14: tlv_byte = i_frame_idx[15:8];
                    6'd15: tlv_byte = i_frame_idx[7:0];
                    6'd16: tlv_byte = U_BOOT_ID;   // BOOT_ID (6)
                    6'd17: tlv_byte = 8'd4;
                    6'd18: tlv_byte = i_boot_id[31:24];
                    6'd19: tlv_byte = i_boot_id[23:16];
                    6'd20: tlv_byte = i_boot_id[15:8];
                    6'd21: tlv_byte = i_boot_id[7:0];
                    6'd22: tlv_byte = U_NET_STATE; // ★ WIRE-U1 NET_STATE (3)
                    6'd23: tlv_byte = 8'd1;
                    default: tlv_byte = {6'd0, net_state_s};
                endcase
            end
            else begin // K_ACK
                if (status != ST_OK) begin
                    tlv_byte = 8'h00;              // 非 OK：不带 TLV（CTRL_LEN=0）
                end
                else case (opcode)
                    OP_SET_MODE: begin             // TLV: MODE (3 B)
                        case (i)
                            6'd0: tlv_byte = U_MODE;
                            6'd1: tlv_byte = 8'd1;
                            default: tlv_byte = {6'd0, pkt_mode};
                        endcase
                    end
                    OP_EV_EN: begin                // ★ v3.1 TLV: EV_EN (3 B)
                        case (i)
                            6'd0: tlv_byte = U_EV_EN;
                            6'd1: tlv_byte = 8'd1;
                            default: tlv_byte = pkt_ev_en;
                        endcase
                    end
                    OP_TIME_SYNC: begin            // TLV: TS_OFFSET(8) + TS_FLAGS(3)
                        case (i)
                            6'd0 : tlv_byte = U_TS_OFFSET;
                            6'd1 : tlv_byte = 8'd6;
                            6'd2 : tlv_byte = pkt_ts_off[47:40];
                            6'd3 : tlv_byte = pkt_ts_off[39:32];
                            6'd4 : tlv_byte = pkt_ts_off[31:24];
                            6'd5 : tlv_byte = pkt_ts_off[23:16];
                            6'd6 : tlv_byte = pkt_ts_off[15:8];
                            6'd7 : tlv_byte = pkt_ts_off[7:0];
                            6'd8 : tlv_byte = U_TS_FLAGS;
                            6'd9 : tlv_byte = 8'd1;
                            default: tlv_byte = pkt_ts_flags;
                        endcase
                    end
                    OP_GET_STATUS: begin           // 全量 TLV（71 B；★M4b 尾追 0x92）
                        case (i)
                            6'd0 : tlv_byte = U_MODE;
                            6'd1 : tlv_byte = 8'd1;
                            6'd2 : tlv_byte = {6'd0, pkt_mode};
                            6'd3 : tlv_byte = U_THETA;
                            6'd4 : tlv_byte = 8'd2;
                            6'd5 : tlv_byte = th[15:8];
                            6'd6 : tlv_byte = th[7:0];
                            6'd7 : tlv_byte = U_MIN_DL;
                            6'd8 : tlv_byte = 8'd2;
                            6'd9 : tlv_byte = md[15:8];
                            6'd10: tlv_byte = md[7:0];
                            6'd11: tlv_byte = U_TS_OFFSET;
                            6'd12: tlv_byte = 8'd6;
                            6'd13: tlv_byte = pkt_ts_off[47:40];
                            6'd14: tlv_byte = pkt_ts_off[39:32];
                            6'd15: tlv_byte = pkt_ts_off[31:24];
                            6'd16: tlv_byte = pkt_ts_off[23:16];
                            6'd17: tlv_byte = pkt_ts_off[15:8];
                            6'd18: tlv_byte = pkt_ts_off[7:0];
                            6'd19: tlv_byte = U_RTT;
                            6'd20: tlv_byte = 8'd2;
                            6'd21: tlv_byte = i_rtt_us[15:8];
                            6'd22: tlv_byte = i_rtt_us[7:0];
                            6'd23: tlv_byte = U_TS_FLAGS;
                            6'd24: tlv_byte = 8'd1;
                            6'd25: tlv_byte = pkt_ts_flags;
                            6'd26: tlv_byte = U_FRAME_IDX;
                            6'd27: tlv_byte = 8'd2;
                            6'd28: tlv_byte = i_frame_idx[15:8];
                            6'd29: tlv_byte = i_frame_idx[7:0];
                            6'd30: tlv_byte = U_DROP;
                            6'd31: tlv_byte = 8'd4;
                            6'd32: tlv_byte = i_drop_px[15:8];
                            6'd33: tlv_byte = i_drop_px[7:0];
                            6'd34: tlv_byte = i_drop_ev[15:8];
                            6'd35: tlv_byte = i_drop_ev[7:0];
                            6'd36: tlv_byte = U_BOOT_ID;
                            6'd37: tlv_byte = 8'd4;
                            6'd38: tlv_byte = i_boot_id[31:24];
                            6'd39: tlv_byte = i_boot_id[23:16];
                            6'd40: tlv_byte = i_boot_id[15:8];
                            6'd41: tlv_byte = i_boot_id[7:0];
                            6'd42: tlv_byte = U_FW;
                            6'd43: tlv_byte = 8'd3;
                            6'd44: tlv_byte = FW_VER[15:8];
                            6'd45: tlv_byte = FW_VER[7:0];
                            6'd46: tlv_byte = WIRE_VER_B;
                            6'd47: tlv_byte = U_EV_EN;   // ★ v3.1
                            6'd48: tlv_byte = 8'd1;
                            6'd49: tlv_byte = pkt_ev_en;
                            6'd50: tlv_byte = U_EV_RES;      // ★ WIRE-U1 EV_RES_STATE (3)
                            6'd51: tlv_byte = 8'd1;
                            6'd52: tlv_byte = {6'd0, pkt_ev_res};
                            6'd53: tlv_byte = U_SER_STATE;   // ★ WIRE-U1 SER_STATE (5)
                            6'd54: tlv_byte = 8'd3;
                            6'd55: tlv_byte = pkt_ser_decim;
                            6'd56: tlv_byte = {6'd0, pkt_ser_agg};
                            6'd57: tlv_byte = i_ser_drop;
                            6'd58: tlv_byte = U_NET_STATE;   // ★ WIRE-U1 NET_STATE (3)
                            6'd59: tlv_byte = 8'd1;
                            6'd60: tlv_byte = {6'd0, net_state_s};
                            6'd61: tlv_byte = U_EXP_CAP;     // ★ SCCB 集成 EXP_CAP_STATE (4)
                            6'd62: tlv_byte = 8'd2;
                            6'd63: tlv_byte = pkt_exp_cap[15:8];
                            7'd64: tlv_byte = pkt_exp_cap[7:0];
                            7'd65: tlv_byte = U_SER_BAUD;    // ★ WIRE-U2 BAUD_STATE (4)
                            7'd66: tlv_byte = 8'd1;
                            7'd67: tlv_byte = {6'd0, pkt_ser_baud};
                            7'd68: tlv_byte = U_ACTION;      // ★ M4b ACTION_STATE (3)
                            7'd69: tlv_byte = 8'd1;
                            default: tlv_byte = act_byte_s;  // 直读同源锁存值（不另存快照）
                        endcase
                    end
                    default: begin                 // OP_SET_PARAM：MODE/THETA/MIN_DL + ★WIRE-U1 SER + ★SCCB EXP_CAP
                        case (i)
                            6'd0: tlv_byte = U_MODE;
                            6'd1: tlv_byte = 8'd1;
                            6'd2: tlv_byte = {6'd0, pkt_mode};
                            6'd3: tlv_byte = U_THETA;
                            6'd4: tlv_byte = 8'd2;
                            6'd5: tlv_byte = th[15:8];
                            6'd6: tlv_byte = th[7:0];
                            6'd7: tlv_byte = U_MIN_DL;
                            6'd8: tlv_byte = 8'd2;
                            6'd9: tlv_byte = md[15:8];
                            6'd10: tlv_byte = md[7:0];
                            6'd11: tlv_byte = U_EV_RES;      // ★ EV_RES_STATE (3)
                            6'd12: tlv_byte = 8'd1;
                            6'd13: tlv_byte = {6'd0, pkt_ev_res};
                            6'd14: tlv_byte = U_SER_STATE;   // ★ SER_STATE (5)
                            6'd15: tlv_byte = 8'd3;
                            6'd16: tlv_byte = pkt_ser_decim;
                            6'd17: tlv_byte = {6'd0, pkt_ser_agg};
                            6'd18: tlv_byte = i_ser_drop;
                            6'd19: tlv_byte = U_EXP_CAP;     // ★ EXP_CAP_STATE (4)
                            6'd20: tlv_byte = 8'd2;
                            6'd21: tlv_byte = pkt_exp_cap[15:8];
                            7'd22: tlv_byte = pkt_exp_cap[7:0];
                            7'd23: tlv_byte = U_SER_BAUD;    // ★ WIRE-U2 BAUD_STATE (4)
                            7'd24: tlv_byte = 8'd1;
                            default: tlv_byte = {6'd0, pkt_ser_baud};
                        endcase
                    end
                endcase
            end
        end
    endfunction

    // 全包第 idx 字节（0..31+CTRL_LEN-1）：24 B 头 + 6 B 控制头 + TLV
    function [7:0] pkt_byte;
        input [6:0] idx;
        begin
            if (idx < 7'd24) begin
                case (idx)
                    7'd0 : pkt_byte = 8'hF0;
                    7'd1 : pkt_byte = 8'h5A;
                    7'd2 : pkt_byte = 8'hA5;
                    7'd3 : pkt_byte = 8'h30;          // 上行魔数第 4 字节
                    7'd4 : pkt_byte = 8'h03;          // VER
                    7'd5 : pkt_byte = 8'h18;          // HDR_LEN=24
                    7'd6 : pkt_byte = b_flags;        // bit7 CTRL / bit2 CRC / bit3/4 TS
                    7'd7 : pkt_byte = {6'd0, b_mode};
                    7'd8 : pkt_byte = 8'h00;          // CHUNK_IDX=0
                    7'd9 : pkt_byte = 8'h00;
                    7'd10: pkt_byte = b_frame[15:8];
                    7'd11: pkt_byte = b_frame[7:0];
                    7'd12: pkt_byte = 8'h00;          // RAW_LEN=0
                    7'd13: pkt_byte = 8'h00;
                    7'd14: pkt_byte = 8'h00;          // EV_LEN=0
                    7'd15: pkt_byte = 8'h00;
                    7'd16: pkt_byte = b_ts[47:40];
                    7'd17: pkt_byte = b_ts[39:32];
                    7'd18: pkt_byte = b_ts[31:24];
                    7'd19: pkt_byte = b_ts[23:16];
                    7'd20: pkt_byte = b_ts[15:8];
                    7'd21: pkt_byte = b_ts[7:0];
                    7'd22: pkt_byte = 8'h00;          // EV_REC_BYTES=0（无事件段）
                    // ★ M4f：BYTE23 = 动作字节（契约 §2.1「每包都带 byte23」）。
                    //   CTRL/心跳头同样携带，否则上位机每收心跳会重置 VALID 边沿
                    //   状态机 ⇒ 同一次动作被记两次。与数据帧/TLV 0x92 同源
                    //   （act_state_cdc 过域锁存，clk_eth 域慢变，只读不写）。
                    7'd23: pkt_byte = act_byte_s;
                    default: pkt_byte = 8'h00;        // RSVD=0
                endcase
            end
            else if (idx == 7'd24) pkt_byte = pkt_opcode;
            else if (idx == 7'd25) pkt_byte = pkt_status;
            else if (idx == 7'd26) pkt_byte = pkt_seq[15:8];
            else if (idx == 7'd27) pkt_byte = pkt_seq[7:0];
            else if (idx == 7'd28) pkt_byte = b_clen[15:8];
            else if (idx == 7'd29) pkt_byte = b_clen[7:0];
            else pkt_byte = tlv_byte(pkt_kind, pkt_opcode, pkt_status, idx - 7'd30);
        end
    endfunction

    //--------------------------------------------------------------------------
    // 主时序
    //--------------------------------------------------------------------------
    integer ui;

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            pstate              <= P_MAGIC0;
            crc_rx              <= 16'hFFFF;
            op_r                <= 8'd0;
            seq_r               <= 16'd0;
            len_r               <= 16'd0;
            pay_left            <= 16'd0;
            crc_hi_r            <= 8'd0;
            crc_match           <= 1'b0;
            tlv_st              <= 2'd0;
            tlv_tag             <= 8'd0;
            tlv_len             <= 8'd0;
            tlv_got             <= 8'd0;
            val16               <= 16'd0;
            val32               <= 32'd0;
            tlv_bad_len         <= 1'b0;
            tlv_bad_val         <= 1'b0;
            tlv_seen            <= 1'b0;
            s_theta             <= 16'd0;
            s_min_dl            <= 16'd0;
            s_decim             <= 16'd0;
            s_flush             <= 32'd0;
            s_period            <= 32'd0;
            s_force             <= 8'd0;
            s_mode              <= 8'd0;
            s_ev_en             <= 8'd0;
            s_ev_res            <= 8'd0;
            s_ser_decim         <= 8'd32;      // WIRE-U1 §3.7 默认 SER_DECIM=32
            s_ser_agg           <= 8'd0;
            s_ser_flush         <= 16'd20;     // 默认 20 ms
            s_exp_cap           <= EXP_CAP_MAX;// ★ SCCB 集成：默认 = 基线档 0x1710
            p_theta             <= 1'b0;
            p_mindl             <= 1'b0;
            p_decim_o           <= 1'b0;
            p_flush_o           <= 1'b0;
            p_period            <= 1'b0;
            p_ev_res            <= 1'b0;
            p_decim             <= 1'b0;
            p_agg               <= 1'b0;
            p_flush             <= 1'b0;
            p_exp_cap           <= 1'b0;
            // ---- ★ WIRE-U2：波特率档位（复位默认 = 档 0 = 115200，与 uart_link 一致）----
            s_ser_baud          <= 8'd0;
            p_ser_baud          <= 1'b0;
            s_host_ts           <= 48'd0;
            s_rtt_half          <= 16'd0;
            s_flag              <= 8'd0;
            pay_bidx            <= 4'd0;
            unsup_cnt           <= 4'd0;
            for (ui = 0; ui < 8; ui = ui + 1) unsup_tag[ui] <= 8'h00;
            r_kind              <= K_NONE;
            r_opcode            <= 8'd0;
            r_status            <= ST_OK;
            r_seq               <= 16'd0;
            r_mode              <= 2'd0;
            r_theta             <= 16'd0;
            r_min_dl            <= 16'd0;
            r_ev_en             <= 8'h01;
            r_ev_res            <= 2'd0;
            r_ser_decim         <= 8'd32;
            r_ser_agg           <= 2'd0;
            r_exp_cap           <= EXP_CAP_MAX;     // ★ SCCB 集成：复位默认 = 基线档
            r_ser_baud          <= 2'd0;            // ★ WIRE-U2
            r_baud_commit       <= 1'b0;
            r_ts_off            <= 48'd0;
            r_ts_flags          <= 8'h00;
            r_req_ts            <= 48'd0;
            pkt_kind            <= K_NONE;
            pkt_opcode          <= 8'd0;
            pkt_status          <= ST_OK;
            pkt_seq             <= 16'd0;
            pkt_mode            <= 2'd0;
            pkt_theta           <= 16'd0;
            pkt_min_dl          <= 16'd0;
            pkt_ev_en           <= 8'h01;
            pkt_ev_res          <= 2'd0;
            pkt_ser_decim       <= 8'd32;
            pkt_ser_agg         <= 2'd0;
            pkt_exp_cap         <= EXP_CAP_MAX;     // ★ SCCB 集成
            pkt_ser_baud        <= 2'd0;            // ★ WIRE-U2
            pkt_baud_commit     <= 1'b0;
            pkt_ts_off          <= 48'd0;
            pkt_ts_flags        <= 8'h00;
            pkt_req_ts          <= 48'd0;
            hb_due              <= 1'b0;
            hb_seq              <= 16'd0;
            hb_cnt              <= 32'd0;
            req_l               <= 1'b0;
            req_seq_l           <= 16'd0;
            req_ts_l            <= 48'd0;
            net_chg_l           <= 1'b0;
            frame_stream        <= 1'b0;
            bstate              <= B_IDLE;
            b_idx               <= 7'd0;
            b_total             <= 7'd0;
            b_crc               <= 16'hFFFF;
            b_ts                <= 48'd0;
            b_frame             <= 16'd0;
            b_mode              <= 2'd0;
            b_flags             <= 8'h00;
            b_clen              <= 16'd0;
            b_byte              <= 8'h00;
            b_baud_commit       <= 1'b0;            // ★ WIRE-U2
            // ---- 输出寄存器复位（toggle 类从 0 开始，对侧按"变化沿"采用）----
            o_theta             <= 12'd1;      // 复位默认 = HOST_PRESETS[0]（与 sys_ctrl 一致）
            o_theta_upd         <= 1'b0;
            o_min_dl            <= 9'd20;
            o_min_dl_upd        <= 1'b0;
            o_mode_set          <= 2'd0;
            o_mode_set_upd      <= 1'b0;
            o_ev_en             <= 1'b1;       // 复位默认：事件支路使能
            o_ev_en_upd         <= 1'b0;
            o_frame_decim       <= 8'd1;       // 现值：不抽帧（H62 裁决，禁止改动）
            o_ev_flush_cyc      <= 24'd65536;  // 现值：udp_merge 参数默认
            // ---- ★ WIRE-U1 串口参数复位默认（设计 §3.7 / §6.3）----
            o_ev_res            <= 2'd0;
            o_ev_res_upd        <= 1'b0;
            o_ser_decim         <= 8'd32;      // 默认抽点 32
            o_ser_decim_upd     <= 1'b0;
            o_ser_agg           <= 2'd0;       // 默认 RAW 档
            o_ser_agg_upd       <= 1'b0;
            o_ser_flush_ms      <= 16'd20;     // 默认 20 ms
            o_ser_flush_upd     <= 1'b0;
            // ---- ★ SCCB 集成：曝光上限复位默认 = 基线档（与 sccb_patch 参数一致）----
            o_exp_cap           <= EXP_CAP_MAX;   // 0x1710 = 5904 行
            o_exp_cap_upd       <= 1'b0;
            // ---- ★ WIRE-U2：波特率档位输出（toggle 从 0 开始，对侧按变化沿采用）----
            o_ser_baud_sel      <= 2'd0;
            o_ser_baud_commit   <= 1'b0;
            o_dl_accepted       <= 1'b0;
            o_period_wr         <= 1'b0;
            o_period_s          <= 17'd600;
            o_force_cal         <= 1'b0;
            o_off_wr            <= 1'b0;
            o_off_data          <= 48'd0;
            o_sync_matched      <= 1'b0;
            o_ctrl_wr_en        <= 1'b0;
            o_ctrl_data         <= 8'd0;
            o_ctrl_commit       <= 1'b0;
            o_stat_dl_crc_fail  <= 16'd0;
            o_stat_dl_bad_opcode<= 16'd0;
            o_stat_dl_reject    <= 16'd0;
        end
        else begin
            // ---- 默认脉冲 ----
            o_period_wr    <= 1'b0;
            o_force_cal    <= 1'b0;
            o_off_wr       <= 1'b0;
            o_sync_matched <= 1'b0;
            o_ctrl_wr_en   <= 1'b0;
            o_ctrl_commit  <= 1'b0;
            o_dl_accepted  <= 1'b0;

            // ---- 心跳计时（§6.3.5：1 Hz，不占数据配额）----
            if (hb_cnt == HEARTBEAT_CYC - 32'd1) begin
                hb_cnt  <= 32'd0;
                hb_due  <= 1'b1;
            end
            else hb_cnt <= hb_cnt + 32'd1;

            // ---- REQ 锁存（构包器忙时不得丢失：校准重试依赖它）----
            if (i_cal_req) begin
                req_l     <= 1'b1;
                req_seq_l <= i_cal_seq;
                req_ts_l  <= i_board_ts;
            end

            // ---- ★ WIRE-U1：探测状态变化锁存（即时插发一条状态 CTRL，§5.3）----
            if (i_net_chg) net_chg_l <= 1'b1;

            //==================================================================
            // 构包器（优先级：REQ > ACK > 心跳；心跳可丢，REQ 不可丢）
            //==================================================================
            case (bstate)
                B_IDLE: begin
                    pkt_baud_commit <= 1'b0;    // ★ WIRE-U2：默认本包不带切换
                    if (req_l) begin
                        // 转发 TIME_SYNC_REQ（§5.1）：OPCODE=0x83, STATUS=0,
                        // SEQ=板端自增, CTRL_LEN=6, 载荷 = BOARD_TS_US[47:0]
                        // ★ 直接进 p_*（在途槽）：不占用 r_* （r_* 是 ACK 的待取槽）
                        pkt_kind  <= K_REQ;
                        pkt_opcode<= OP_TIME_REQ;
                        pkt_status<= ST_OK;
                        pkt_seq   <= req_seq_l;
                        pkt_req_ts<= req_ts_l;
                        req_l     <= 1'b0;
                        hb_due    <= 1'b0;
                        bstate    <= i_ctrl_empty ? B_SNAP : B_WAIT;
                    end
                    else if (r_kind != K_NONE) begin
                        // ★ 取走请求：快照到 p_* 并立刻释放 r_*（同拍新派发由下方
                        //   parser 段覆盖 ⇒ 不丢；在途包不再随 r_* 漂移 ⇒ 不串包）
                        pkt_kind      <= r_kind;
                        pkt_opcode    <= r_opcode;
                        pkt_status    <= r_status;
                        pkt_seq       <= r_seq;
                        pkt_mode      <= r_mode;
                        pkt_theta     <= r_theta;
                        pkt_min_dl    <= r_min_dl;
                        pkt_ev_en     <= r_ev_en;
                        pkt_ev_res    <= r_ev_res;
                        pkt_ser_decim <= r_ser_decim;
                        pkt_ser_agg   <= r_ser_agg;
                        pkt_exp_cap   <= r_exp_cap;    // ★ SCCB 集成
                        pkt_ser_baud  <= r_ser_baud;   // ★ WIRE-U2
                        //   "ACK 整包写完后才切换"的握手：本包是波特率 ACK 才带 commit
                        pkt_baud_commit <= r_baud_commit;
                        r_baud_commit <= 1'b0;
                        pkt_ts_off    <= r_ts_off;
                        pkt_ts_flags  <= r_ts_flags;
                        pkt_req_ts    <= r_req_ts;
                        r_kind      <= K_NONE;
                        bstate      <= i_ctrl_empty ? B_SNAP : B_WAIT;
                    end
                    else if (net_chg_l) begin
                        // ★ WIRE-U1 §5.3：探测状态变化即时插发一条状态 CTRL
                        //   （与心跳同结构：MODE/TS_FLAGS/DROP/FRAME_IDX/BOOT_ID/NET_STATE）
                        pkt_kind  <= K_HB;
                        pkt_opcode<= OP_STATUS_HB;
                        pkt_status<= ST_OK;
                        hb_seq    <= hb_seq + 16'd1;
                        pkt_seq   <= hb_seq;
                        pkt_mode  <= i_mode;
                        pkt_ts_flags  <= tflags_snap;
                        net_chg_l <= 1'b0;
                        hb_due    <= 1'b0;
                        bstate    <= i_ctrl_empty ? B_SNAP : B_WAIT;
                    end
                    else if (hb_due) begin
                        // 周期 STATUS 心跳（0xF0）：MODE/TS_FLAGS/DROP_*/FRAME_IDX/BOOT_ID
                        pkt_kind  <= K_HB;
                        pkt_opcode<= OP_STATUS_HB;
                        pkt_status<= ST_OK;
                        hb_seq    <= hb_seq + 16'd1;
                        pkt_seq   <= hb_seq;
                        pkt_mode  <= i_mode;
                        pkt_ts_flags  <= tflags_snap;
                        hb_due    <= 1'b0;
                        bstate    <= i_ctrl_empty ? B_SNAP : B_WAIT;
                    end
                end
                B_WAIT: begin
                    if (i_ctrl_empty) bstate <= B_SNAP;
                end
                B_SNAP: begin   // 构包起点统一快照（81 拍内这些值不允许漂移）
                    b_ts    <= i_ts_us;
                    b_frame <= i_frame_idx;
                    b_mode  <= i_mode;
                    b_flags <= {1'b1, 2'b00, i_ts_calibrated, i_ts_valid, 1'b1, 2'b00};
                    b_clen  <= ctrl_len_of(pkt_kind, pkt_opcode, pkt_status);
                    b_baud_commit <= pkt_baud_commit;   // ★ WIRE-U2
                    b_crc   <= 16'hFFFF;
                    b_idx   <= 7'd0;
                    bstate  <= B_RUN;
                end
                B_RUN: begin
                    b_byte       <= pkt_byte(b_idx);
                    o_ctrl_data  <= pkt_byte(b_idx);
                    o_ctrl_wr_en <= 1'b1;
                    b_crc        <= crc16_step(b_crc, pkt_byte(b_idx));
                    if (b_idx == (7'd29 + b_clen[6:0])) begin   // 30+clen-1
                        b_idx   <= 7'd0;
                        bstate  <= B_CRC1;
                    end
                    else b_idx <= b_idx + 7'd1;
                end
                B_CRC1: begin                       // 尾部 CRC 高字节
                    // ★ CRC 字段 = 余式本身（不再 step）：B_CRC1 推高字节并暂存
                    //   低字节；曾误把高字节再 step 一轮推其低位（TB 抓到）。
                    b_byte       <= b_crc[7:0];
                    o_ctrl_data  <= b_crc[15:8];
                    o_ctrl_wr_en <= 1'b1;
                    bstate       <= B_CRC2;
                end
                B_CRC2: begin                       // 尾部 CRC 低字节
                    o_ctrl_data  <= b_byte;
                    o_ctrl_wr_en <= 1'b1;
                    bstate       <= B_COMMIT;
                end
                B_COMMIT: begin
                    // ★ r_kind 已在 B_IDLE 取出时释放 —— 此处**不得**再清（否则会抹掉
                    //   构包期间新到的命令请求 ⇒ 现场 §4.6 型 ACK 丢失）
                    o_ctrl_commit <= 1'b1;
                    // ★ WIRE-U2：整包（含 TLV 0x91）已在上一拍全部写入 CTRL 通道
                    //   ⇒ 此刻才允许串口侧切分频；uart_link 还会等 FIFO 排空 + TX 移完
                    if (b_baud_commit) begin
                        o_ser_baud_sel    <= pkt_ser_baud;
                        o_ser_baud_commit <= ~o_ser_baud_commit;
                        b_baud_commit     <= 1'b0;
                    end
                    bstate        <= B_IDLE;
                end
                default: bstate <= B_IDLE;
            endcase

            //==================================================================
            // 解析状态机（逐字节，i_rx_valid 时推进）
            //==================================================================
            if (i_rx_valid) begin
                case (pstate)
                    P_MAGIC0: begin                     // b0 = F0
                        frame_stream <= rx_stream_s;    // ★ 本帧来源（决定 pkt_done 是否适用）
                        if (i_rx_data == 8'hF0) begin
                            crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                            pstate <= P_MAGIC1;
                        end
                        else if (rx_stream_s) begin
                            // ★ WIRE-U1：连续字节流中帧间零散字节（如 'B'）忽略且不计
                            //   dlReject，保持 P_MAGIC0 继续扫描（设计 §3.7）
                            pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_MAGIC1: begin                     // b1 = 5A
                        if (i_rx_data == 8'h5A) begin
                            crc_rx <= crc16_step(crc_rx, i_rx_data);
                            pstate <= P_MAGIC2;
                        end
                        else if (rx_stream_s) begin
                            // 逐字节重同步：本字节可能是新帧头（F0 5A ... 情形）
                            if (i_rx_data == 8'hF0) begin
                                crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                                pstate <= P_MAGIC1;
                            end
                            else pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_MAGIC2: begin                     // b2 = A5
                        if (i_rx_data == 8'hA5) begin
                            crc_rx <= crc16_step(crc_rx, i_rx_data);
                            pstate <= P_MAGIC3;
                        end
                        else if (rx_stream_s) begin
                            if (i_rx_data == 8'hF0) begin
                                crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                                pstate <= P_MAGIC1;
                            end
                            else pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_MAGIC3: begin                     // b3 = 31（下行方向）
                        if (i_rx_data == 8'h31) begin
                            crc_rx <= crc16_step(crc_rx, i_rx_data);
                            pstate <= P_VER;
                        end
                        else if (rx_stream_s) begin
                            if (i_rx_data == 8'hF0) begin
                                crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                                pstate <= P_MAGIC1;
                            end
                            else pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_VER: begin                        // b4 = VER（必须是 3）
                        if (i_rx_data == 8'h03) begin
                            crc_rx <= crc16_step(crc_rx, i_rx_data);
                            pstate <= P_OP;
                        end
                        else if (rx_stream_s) begin
                            if (i_rx_data == 8'hF0) begin
                                crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                                pstate <= P_MAGIC1;
                            end
                            else pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_OP: begin                         // b5 = OPCODE
                        op_r   <= i_rx_data;
                        crc_rx <= crc16_step(crc_rx, i_rx_data);
                        pstate <= P_SEQ0;
                    end
                    P_SEQ0: begin                       // b6 = SEQ[15:8]
                        seq_r[15:8] <= i_rx_data;
                        crc_rx <= crc16_step(crc_rx, i_rx_data);
                        pstate <= P_SEQ1;
                    end
                    P_SEQ1: begin                       // b7 = SEQ[7:0]
                        seq_r[7:0] <= i_rx_data;
                        crc_rx <= crc16_step(crc_rx, i_rx_data);
                        pstate <= P_LEN0;
                    end
                    P_LEN0: begin                       // b8 = LEN[15:8]
                        len_r[15:8] <= i_rx_data;
                        crc_rx <= crc16_step(crc_rx, i_rx_data);
                        pstate <= P_LEN1;
                    end
                    P_LEN1: begin                       // b9 = LEN[7:0]
                        len_r[7:0] <= i_rx_data;
                        pay_left   <= {len_r[15:8], i_rx_data};
                        pay_bidx   <= 4'd0;
                        crc_rx     <= crc16_step(crc_rx, i_rx_data);
                        // ---- 载荷解析复位 ----
                        tlv_st      <= 2'd0;
                        tlv_bad_len <= 1'b0;
                        tlv_bad_val <= 1'b0;
                        tlv_seen    <= 1'b0;
                        unsup_cnt   <= 4'd0;
                        // ★ WIRE-U1：按存在写的"存在标志"复位
                        p_theta     <= 1'b0;
                        p_mindl     <= 1'b0;
                        p_decim_o   <= 1'b0;
                        p_flush_o   <= 1'b0;
                        p_period    <= 1'b0;
                        p_ev_res    <= 1'b0;
                        p_decim     <= 1'b0;
                        p_agg       <= 1'b0;
                        p_flush     <= 1'b0;
                        p_exp_cap   <= 1'b0;
                        p_ser_baud  <= 1'b0;                  // ★ WIRE-U2
                        pstate      <= ({len_r[15:8], i_rx_data} != 16'd0) ? P_PAYLOAD : P_CRC0;
                    end
                    P_PAYLOAD: begin
                        crc_rx  <= crc16_step(crc_rx, i_rx_data);
                        pay_left<= pay_left - 16'd1;
                        case (op_r)
                        //------------------------------------------------------
                        OP_SET_PARAM: begin
                            case (tlv_st)
                                2'd0: begin                      // tag
                                    tlv_tag  <= i_rx_data;
                                    tlv_seen <= 1'b1;
                                    tlv_st   <= 2'd1;
                                end
                                2'd1: begin                      // len
                                    tlv_len <= i_rx_data;
                                    tlv_got <= 8'd0;
                                    if (i_rx_data == 8'd0) begin
                                        // len=0 的已知 tag：结构错（未知 tag len=0 可跳过）
                                        if (tlv_tag <= T_SER_BAUD) tlv_bad_len <= 1'b1;
                                        tlv_st <= 2'd0;
                                    end
                                    else tlv_st <= 2'd2;
                                end
                                default: begin                   // value 字节
                                    tlv_got <= tlv_got + 8'd1;
                                    case (tlv_tag)
                                        T_THETA, T_MIN_DL, T_FRAME_DECIM: begin
                                            val16 <= {val16[7:0], i_rx_data};
                                        end
                                        T_EV_FLUSH, T_CAL_PERIOD: begin
                                            val32 <= {val32[23:0], i_rx_data};
                                        end
                                        T_FORCE_CAL: begin
                                            s_force <= i_rx_data;
                                        end
                                        // ---- ★ WIRE-U1 新 tag（1 B 值直接暂存）----
                                        T_EV_RES:    s_ev_res    <= i_rx_data;
                                        T_SER_DECIM: s_ser_decim <= i_rx_data;
                                        T_SER_AGG:   s_ser_agg   <= i_rx_data;
                                        // ---- 2 B 值（MSB 先入）----
                                        T_SER_FLUSH: val16 <= {val16[7:0], i_rx_data};
                                        T_EXP_CAP:   val16 <= {val16[7:0], i_rx_data};  // ★ SCCB 集成
                                        T_SER_BAUD:  s_ser_baud <= i_rx_data;          // ★ WIRE-U2
                                        default: begin
                                            // 未知 tag：跳过值并记录（§6.3.1 前向兼容）
                                            if (unsup_cnt < 4'd8) begin
                                                unsup_tag[unsup_cnt[2:0]] <= tlv_tag;
                                                unsup_cnt <= unsup_cnt + 4'd1;
                                            end
                                        end
                                    endcase
                                    if (tlv_got + 8'd1 == tlv_len) begin
                                        // 值收齐：校验（只记录，不写 —— §6.3.1 原子性）
                                        tlv_st <= 2'd0;
                                        case (tlv_tag)
                                            T_THETA: begin
                                                if (tlv_len != 8'd2) tlv_bad_len <= 1'b1;
                                                else begin
                                                    p_theta <= 1'b1;
                                                    s_theta <= {val16[7:0], i_rx_data};
                                                    if ({val16[7:0], i_rx_data} > 16'd4095)
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            T_MIN_DL: begin
                                                if (tlv_len != 8'd2) tlv_bad_len <= 1'b1;
                                                else begin
                                                    p_mindl <= 1'b1;
                                                    s_min_dl <= {val16[7:0], i_rx_data};
                                                    // 9 bit 寄存器上限（U7：单位/上限待权威定义）
                                                    if ({val16[7:0], i_rx_data} > 16'd511)
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            T_FRAME_DECIM: begin
                                                if (tlv_len != 8'd2) tlv_bad_len <= 1'b1;
                                                else begin
                                                    p_decim_o <= 1'b1;
                                                    s_decim <= {val16[7:0], i_rx_data};
                                                    if (({val16[7:0], i_rx_data} == 16'd0) ||
                                                        ({val16[7:0], i_rx_data} > 16'd255))
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            T_EV_FLUSH: begin
                                                if (tlv_len != 8'd4) tlv_bad_len <= 1'b1;
                                                else begin
                                                    p_flush_o <= 1'b1;
                                                    s_flush <= {val32[23:0], i_rx_data};
                                                    if ({val32[23:0], i_rx_data} < 32'd4 ||
                                                        {val32[23:0], i_rx_data} > 32'd1048576)
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            T_CAL_PERIOD: begin
                                                if (tlv_len != 8'd4) tlv_bad_len <= 1'b1;
                                                else begin
                                                    p_period <= 1'b1;
                                                    s_period <= {val32[23:0], i_rx_data};
                                                    if ({val32[23:0], i_rx_data} < 32'd60 ||
                                                        {val32[23:0], i_rx_data} > 32'd86400)
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            T_FORCE_CAL: begin
                                                if (tlv_len != 8'd1) tlv_bad_len <= 1'b1;
                                                else if (i_rx_data != 8'd1) tlv_bad_val <= 1'b1;
                                            end
                                            // ---- ★ WIRE-U1 新 tag 校验（存在标志 + 值域）----
                                            T_EV_RES: begin
                                                p_ev_res <= 1'b1;
                                                if (tlv_len != 8'd1) tlv_bad_len <= 1'b1;
                                                else if (i_rx_data > 8'd2) tlv_bad_val <= 1'b1;
                                            end
                                            T_SER_DECIM: begin
                                                p_decim <= 1'b1;
                                                if (tlv_len != 8'd1) tlv_bad_len <= 1'b1;
                                                else if (i_rx_data == 8'd0) tlv_bad_val <= 1'b1; // 1..255
                                            end
                                            T_SER_AGG: begin
                                                p_agg <= 1'b1;
                                                if (tlv_len != 8'd1) tlv_bad_len <= 1'b1;
                                                else if (i_rx_data > 8'd2) tlv_bad_val <= 1'b1;
                                            end
                                            T_SER_FLUSH: begin
                                                p_flush <= 1'b1;
                                                if (tlv_len != 8'd2) tlv_bad_len <= 1'b1;
                                                else begin
                                                    s_ser_flush <= {val16[7:0], i_rx_data};
                                                    if (({val16[7:0], i_rx_data} < 16'd5) ||
                                                        ({val16[7:0], i_rx_data} > 16'd1000))
                                                        tlv_bad_val <= 1'b1;
                                                end
                                            end
                                            // ---- ★ SCCB 集成：曝光上限（2B，值域 4..5904）----
                                            T_EXP_CAP: begin
                                                p_exp_cap <= 1'b1;
                                                if (tlv_len != 8'd2) tlv_bad_len <= 1'b1;
                                                else begin
                                                    s_exp_cap <= {val16[7:0], i_rx_data};
                                                    if (({val16[7:0], i_rx_data} < EXP_CAP_MIN) ||
                                                        ({val16[7:0], i_rx_data} > EXP_CAP_MAX))
                                                        tlv_bad_val <= 1'b1;   // 越界 ⇒ 整条不写
                                                end
                                            end
                                            // ---- ★ WIRE-U2：波特率档位（1B，0..3）----
                                            T_SER_BAUD: begin
                                                p_ser_baud <= 1'b1;
                                                if (tlv_len != 8'd1) tlv_bad_len <= 1'b1;
                                                else if (i_rx_data > 8'd3) tlv_bad_val <= 1'b1;
                                            end
                                            default: ;     // 未知 tag 已在 value 分支记录
                                        endcase
                                    end
                                end
                            endcase
                        end
                        //------------------------------------------------------
                        OP_SET_MODE: begin
                            if (pay_bidx == 4'd0) s_mode <= i_rx_data;
                        end
                        //------------------------------------------------------
                        OP_EV_EN: begin                // ★ v3.1：1 B 载荷
                            if (pay_bidx == 4'd0) s_ev_en <= i_rx_data;
                        end
                        //------------------------------------------------------
                        OP_TIME_SYNC: begin
                            case (pay_bidx)
                                4'd0: s_host_ts[47:40] <= i_rx_data;
                                4'd1: s_host_ts[39:32] <= i_rx_data;
                                4'd2: s_host_ts[31:24] <= i_rx_data;
                                4'd3: s_host_ts[23:16] <= i_rx_data;
                                4'd4: s_host_ts[15:8]  <= i_rx_data;
                                4'd5: s_host_ts[7:0]   <= i_rx_data;
                                4'd6: s_rtt_half[15:8] <= i_rx_data;
                                4'd7: s_rtt_half[7:0]  <= i_rx_data;
                                default: s_flag <= i_rx_data;
                            endcase
                        end
                        //------------------------------------------------------
                        default: ;     // GET_STATUS / 其它：载荷字节仅计数
                        endcase
                        pay_bidx <= pay_bidx + 4'd1;
                        if (pay_left == 16'd1) pstate <= P_CRC0;
                    end
                    P_CRC0: begin                       // CRC 高字节（不并入 CRC）
                        crc_hi_r  <= i_rx_data;
                        pstate    <= P_CRC1;
                    end
                    P_CRC1: begin                       // CRC 低字节 → 比对（本拍才见低字节）
                        crc_match <= (crc_rx === {crc_hi_r, i_rx_data});
                        pstate    <= P_DISPATCH;
                    end
                    P_DISPATCH: begin
                        // 派发在下方无条件节完成；本臂只处理"背靠背新包"的首字节，
                        // 否则新包的 0xF0 会被吞掉（实测：派发曾依赖 rx_valid 才推进）
                        if (i_rx_data == 8'hF0) begin
                            crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                            pstate <= P_MAGIC1;
                        end
                        else if (rx_stream_s) begin
                            // ★ 串口流：帧间零散字节忽略、不计 dlReject（§3.7）
                            pstate <= P_MAGIC0;
                        end
                        else begin
                            o_stat_dl_reject <= o_stat_dl_reject + 16'd1;
                            pstate <= P_SKIP;
                        end
                    end
                    P_SKIP: begin
                        // 丢弃到包尾（软件白名单拒绝路径，§6.1）
                        // ★ 防御：流模式下若仍处于 P_SKIP，遇到 F0 立即重同步
                        if (rx_stream_s && (i_rx_data == 8'hF0)) begin
                            crc_rx <= crc16_step(16'hFFFF, i_rx_data);
                            pstate <= P_MAGIC1;
                        end
                    end
                    default: pstate <= P_MAGIC0;
                endcase
            end

            //==================================================================
            // 派发（不依赖 i_rx_valid —— 包尾后 FIFO 可能已空，若等下一包的
            // 首字节才派发会吞掉它。pstate：本拍 rx_valid 时由上方字节臂接管
            // （背靠背新包按 MAGIC0 处理），否则回 MAGIC0 等待。
            //==================================================================
            if (pstate == P_DISPATCH) begin
                        // ★ WIRE-U2：每条命令默认"不切换波特率"；仅 SET_PARAM 且
                        //   0x0C 通过校验并在 OK 分支里才置 1（BAD_LEN/BAD_VALUE 不切）
                        r_baud_commit <= 1'b0;
                        // ★ WIRE-U1 §5.1 L2：合法下行帧（CRC 过 + OPCODE 白名单）被接受
                        o_dl_accepted <= crc_match && (op_r >= OP_SET_PARAM) && (op_r <= OP_EV_EN);
                        if (!crc_match) begin
                            o_stat_dl_crc_fail <= o_stat_dl_crc_fail + 16'd1;  // 不回应
                        end
                        else case (op_r)
                            //--------------------------------------------------
                            OP_SET_PARAM: begin
                                r_kind   <= K_ACK;
                                r_opcode <= OP_SET_PARAM;
                                r_seq    <= seq_r;
                                r_mode   <= i_mode;
                                r_ts_off <= i_ts_offset;
                                r_ts_flags <= tflags_snap;
                                if ((len_r == 16'd0) || tlv_bad_len) begin
                                    r_status <= ST_BAD_LEN;
                                end
                                else if (tlv_bad_val) begin
                                    r_status <= ST_BAD_VALUE;      // 整条不写（原子性）
                                end
                                else if (excl_viol) begin
                                    // ★ WIRE-U1 §3.5 互斥：SER_AGG≠0 与 EV_RES≠0 不可共存
                                    r_status <= ST_BAD_VALUE;      // 整条不写
                                end
                                else begin
                                    r_status  <= ST_OK;
                                    // ---- 统一提交（§6.3.1：先全验后写，此处全过）----
                                    // ★ 按存在写：未出现的 tag 保持原值（TLV 列表语义）
                                    if (p_theta) begin
                                        o_theta     <= s_theta[11:0];
                                        o_theta_upd <= ~o_theta_upd;
                                        r_theta     <= s_theta;
                                    end
                                    else r_theta <= {4'd0, o_theta};
                                    if (p_mindl) begin
                                        o_min_dl     <= s_min_dl[8:0];
                                        o_min_dl_upd <= ~o_min_dl_upd;
                                        r_min_dl     <= s_min_dl;
                                    end
                                    else r_min_dl <= {7'd0, o_min_dl};
                                    if (p_decim_o) o_frame_decim  <= s_decim[7:0];
                                    if (p_flush_o) o_ev_flush_cyc <= s_flush[23:0];
                                    // ---- ★ WIRE-U1 新增：按存在写（未出现的 tag 不动）----
                                    if (p_ev_res) begin
                                        o_ev_res     <= s_ev_res[1:0];
                                        o_ev_res_upd <= ~o_ev_res_upd;
                                        r_ev_res     <= s_ev_res[1:0];
                                    end
                                    if (p_decim) begin
                                        o_ser_decim     <= s_ser_decim;
                                        o_ser_decim_upd <= ~o_ser_decim_upd;
                                        r_ser_decim     <= s_ser_decim;
                                    end
                                    if (p_agg) begin
                                        o_ser_agg     <= s_ser_agg[1:0];
                                        o_ser_agg_upd <= ~o_ser_agg_upd;
                                        r_ser_agg     <= s_ser_agg[1:0];
                                    end
                                    if (p_flush) begin
                                        o_ser_flush_ms  <= s_ser_flush;
                                        o_ser_flush_upd <= ~o_ser_flush_upd;
                                    end
                                    // ---- ★ SCCB 集成：曝光上限（按存在写 + 重触发 toggle）----
                                    //   等值写入：值不重复写入、toggle 不翻转（零副作用）；
                                    //   ACK 读回仍是"写后读回"（同值）。
                                    if (p_exp_cap) begin
                                        r_exp_cap <= s_exp_cap;
                                        if (s_exp_cap != o_exp_cap) begin
                                            o_exp_cap     <= s_exp_cap;
                                            o_exp_cap_upd <= ~o_exp_cap_upd;
                                        end
                                    end
                                    else r_exp_cap <= o_exp_cap;    // 未出现该 tag ⇒ 读回当前真值
                                    // ---- ★ WIRE-U2：波特率档位（按存在写）----
                                    //   只有本分支（全部校验通过）才置 commit ⇒ 越界/长度错
                                    //   的命令"整条不写"语义对波特率同样成立（原子拒绝）。
                                    if (p_ser_baud) begin
                                        r_ser_baud    <= s_ser_baud[1:0];
                                        r_baud_commit <= 1'b1;
                                    end
                                    else r_ser_baud <= o_ser_baud_sel;
                                    if (p_period && (s_period != 32'd0)) begin
                                        o_period_wr <= 1'b1;
                                        o_period_s  <= s_period[16:0];
                                    end
                                    if (s_force == 8'd1) o_force_cal <= 1'b1;
                                end
                            end
                            //--------------------------------------------------
                            OP_SET_MODE: begin
                                r_kind     <= K_ACK;
                                r_opcode   <= OP_SET_MODE;
                                r_seq      <= seq_r;
                                r_mode     <= s_mode[1:0];
                                r_ts_off   <= i_ts_offset;
                                r_ts_flags <= tflags_snap;
                                if (len_r != 16'd1)          r_status <= ST_BAD_LEN;
                                else if (s_mode > 8'd2)      r_status <= ST_BAD_VALUE;
                                else begin
                                    r_status <= ST_OK;
                                    if (s_mode[1:0] != i_mode) begin
                                        // last-writer-wins（§3.2）；等值写入零副作用（§3.3-6）
                                        o_mode_set     <= s_mode[1:0];
                                        o_mode_set_upd <= ~o_mode_set_upd;
                                    end
                                end
                            end
                            //--------------------------------------------------
                            OP_TIME_SYNC: begin
                                r_kind     <= K_ACK;
                                r_opcode   <= OP_TIME_SYNC;
                                r_seq      <= seq_r;
                                r_ts_off   <= off_calc[47:0];
                                r_ts_flags <= 8'h01;               // bit0 calibrated
                                r_mode     <= i_mode;
                                if (len_r != 16'd9) begin
                                    r_status <= ST_BAD_LEN;
                                end
                                else begin
                                    o_off_data <= off_calc[47:0];
                                    o_off_wr   <= 1'b1;
                                    o_sync_matched <= seq_match;
                                    r_status   <= ST_OK;
                                end
                            end
                            //--------------------------------------------------
                            OP_EV_EN: begin            // ★ v3.1：事件支路开关
                                r_kind     <= K_ACK;
                                r_opcode   <= OP_EV_EN;
                                r_seq      <= seq_r;
                                r_mode     <= i_mode;
                                r_ts_off   <= i_ts_offset;
                                r_ts_flags <= tflags_snap;
                                if (len_r != 16'd1)        r_status <= ST_BAD_LEN;
                                else if (s_ev_en > 8'd1)   r_status <= ST_BAD_VALUE;
                                else begin
                                    r_status <= ST_OK;
                                    r_ev_en  <= s_ev_en;
                                    if (s_ev_en[0] != i_ev_en) begin
                                        // 等值写入零副作用（与 SET_MODE 幂等规则一致）
                                        o_ev_en     <= s_ev_en[0];
                                        o_ev_en_upd <= ~o_ev_en_upd;
                                    end
                                end
                            end
                            //--------------------------------------------------
                            OP_GET_STATUS: begin
                                r_kind     <= K_ACK;
                                r_opcode   <= OP_GET_STATUS;
                                r_seq      <= seq_r;
                                r_status   <= (len_r != 16'd0) ? ST_BAD_LEN : ST_OK;
                                r_mode     <= i_mode;
                                r_theta    <= {4'd0, o_theta};
                                r_min_dl   <= {7'd0, o_min_dl};
                                r_ev_en    <= {7'd0, i_ev_en};
                                // ★ WIRE-U1：GET_STATUS 读回 SER 参数组（去程 o_* 即真值源）
                                r_ev_res   <= o_ev_res;
                                r_ser_decim<= o_ser_decim;
                                r_ser_agg  <= o_ser_agg;
                                r_exp_cap  <= o_exp_cap;    // ★ SCCB 集成：读回真值源
                                r_ser_baud <= o_ser_baud_sel;   // ★ WIRE-U2：去程 o_* 即真值源
                                r_ts_off   <= i_ts_offset;
                                r_ts_flags <= tflags_snap;
                            end
                            //--------------------------------------------------
                            default: begin
                                o_stat_dl_bad_opcode <= o_stat_dl_bad_opcode + 16'd1;
                            end
                        endcase
                if (!i_rx_valid) pstate <= P_MAGIC0;
            end

            // 包边界：重同步 / 丢弃半包（解析按长度计数，正常包不依赖它）
            // ★ WIRE-U1：仅当在途帧来自 UDP 包（!frame_stream）时才响应——串口帧被
            //   UDP 包尾脉冲打断会造成串口命令丢失（两种来源在入口合流，见 uart_dl_bridge）
            if (i_rx_pkt_done && (pstate != P_MAGIC0) && !frame_stream) pstate <= P_MAGIC0;

        end
    end

    assign o_rx_rd_en = 1'b1;

    // b_total 保留（现按 b_clen 逐段推进；供波形观察全包长度）
    always @(*) b_total = 7'd32 + b_clen[6:0];

endmodule
