//==============================================================================
// ts_gen.v —— 板端采集时间戳发生器（WIRE-V3 §4 / §5，R4）
//
// 设计依据：docs/05_experiments/协议v3设计_20261009/v3线协议设计.md
//   §4.1  48 bit 微秒计数器：clk_eth 125 MHz ÷ 125 = 1 MHz，精确整除无漂移；
//         2^48 µs ≈ 8.9 年 ⇒ 设计上视为不回绕。
//   §4.2  取值 = 本包负载首字节的采集时刻（打包侧在包首锁存，见 udp_merge）。
//   §5.1  校准方向：板端发起 TIME_SYNC_REQ（OPCODE=0x83，CTRL 包）→ PC 下行
//         TIME_SYNC（1235）→ 板端写 offset_reg。offset 为 48 bit 二补码，
//         aligned = local + offset（48 bit 自然回绕）。
//   §5.2  首次校准上电后 5 s；周期 TS_CAL_PERIOD_S（默认 600 s，SET_PARAM tag
//         0x05 可改 60..86400）；重试间隔 200/500/1000 ms（SEQ 递增）；3 次重试
//         全失败 ⇒ 保留旧 offset（绝不归零）、置 ts_cal_stale，60 s 后再起一轮。
//   §5.3  与 udp_merge 同在 clk_eth 域 ⇒ 无 CDC。下行字节经 eth_udp 的 RX
//         异步 FIFO 已进 clk_eth 域后才写 offset_reg。
//
// ⚠️ §5.1 流程图第 (3) 步写 "offset = t1 + RTT/2 − t2"，与 §6.3.3 的操作定义
//    "offset = HOST_TS_US + RTT_HALF − t4_rx"（FLAG=0）相差一个 RTT。
//    本实现以 §6.3.3（板端处理公式）为准：RTT_HALF=0 且 SEQ 匹配本板 REQ 时
//    自算 RTT/2 = (t4 − t2)/2，代回即得标准 NTP 形式 t1 − (t2+t4)/2。
//    两处矛盾已登记到实现报告"遗留问题"。
//
// BOOT_ID（§6.2 tag 0x89）：FPGA 无非易失存储 ⇒ 上电值恒为参数 BOOT_ID，
//   只用于"同一次开机内"的 TLV 自证；跨复位判别由上位机 tsEpochReset 承担。
//==============================================================================
`timescale 1ns / 1ps

module ts_gen #(
    parameter          CLK_DIV        = 125,            // 125 MHz / 125 = 1 µs
    parameter [47:0]   FIRST_CAL_US   = 48'd5_000_000,  // 首次校准：上电后 5 s（§5.2）
    parameter [16:0]   CAL_PERIOD_S   = 17'd600,        // 复位默认校准周期（秒）
    parameter [47:0]   RETRY_GAP0_US  = 48'd200_000,    // 重试间隔（§5.2）
    parameter [47:0]   RETRY_GAP1_US  = 48'd500_000,
    parameter [47:0]   RETRY_GAP2_US  = 48'd1_000_000,
    parameter [47:0]   STALE_BACKOFF_US = 48'd60_000_000, // 一轮全失败后退避 60 s
    parameter [15:0]   RETRY_N        = 16'd3,          // 每轮重试次数（200/500/1000 各一次）
    parameter [31:0]   BOOT_ID        = 32'h5254_4E41   // "RTNA"
)(
    input  wire        clk_eth,
    input  wire        rst_n_eth,
    // ---- offset 写入（downlink_cmd，同 clk_eth 域，§6.3.3）----
    input  wire        i_off_wr_en,
    input  wire [47:0] i_off_data,       // 48 bit 二补码低 48 位
    // ---- 校准周期写入（SET_PARAM tag 0x05，60..86400 已由下行侧校验）----
    input  wire        i_period_wr_en,
    input  wire [16:0] i_period_s,
    // ---- 立即校准一次（SET_PARAM tag 0x06 值 1，一次性动作）----
    input  wire        i_force_cal,
    // ---- 下行 TIME_SYNC 与本板未决 REQ 的 SEQ 匹配脉冲（downlink_cmd）----
    input  wire        i_sync_matched,
    // ---- REQ 发送请求（→ downlink_cmd CTRL 构包器，§5.1 第 1 步）----
    output reg         o_cal_req,        // 1 拍脉冲
    output reg  [15:0] o_cal_seq,        // 本次 REQ 的 SEQ（重试递增，可去重）
    output reg  [47:0] o_board_ts_us,    // t2 = 发送时刻本机 µs
    // ---- 状态引出 ----
    output reg  [47:0] o_ts_local_us,    // 板端本机 µs（未校准）
    output wire [47:0] o_ts_aligned_us,  // local + offset（48 bit 自然回绕）
    output wire        o_ts_valid,       // 计数器运行即有效（FLAGS.bit3）
    output reg         o_ts_calibrated,  // 已校准（FLAGS.bit4 / TS_FLAGS.bit0）
    output reg         o_ts_stale,       // 校准过期（TS_FLAGS.bit1）
    output reg  [47:0] o_offset_reg,     // 当前偏移（TLV 0x84 TS_OFFSET）
    output reg  [15:0] o_rtt_us,         // 最近一次匹配往返 RTT = t4 − t2（饱和 16 bit）
    output wire [31:0] o_boot_id
);

    //--------------------------------------------------------------------------
    // µs 计数器：CLK_DIV 分频（125 MHz → 1 MHz，精确整除，§4.1）
    //--------------------------------------------------------------------------
    localparam [6:0] DIV_M1 = CLK_DIV - 1;   // Verilog-2001 不允许对 parameter 位选

    reg [6:0] div_cnt;

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            div_cnt      <= 7'd0;
            o_ts_local_us <= 48'd0;
        end
        else if (div_cnt == DIV_M1) begin
            div_cnt       <= 7'd0;
            o_ts_local_us <= o_ts_local_us + 48'd1;
        end
        else div_cnt <= div_cnt + 7'd1;
    end

    assign o_ts_valid = 1'b1;   // 复位释放后计数器即运行（每包都带 TS，§4.2）

    // aligned = local + offset（二补码加法 = 48 bit 自然回绕，§5.3）
    assign o_ts_aligned_us = o_ts_local_us + o_offset_reg;

    assign o_boot_id = BOOT_ID;

    //--------------------------------------------------------------------------
    // 1 µs × 常量 = 校准日程（全部常量乘法，无变量除法 H23）
    //--------------------------------------------------------------------------
    function [47:0] s_to_us;        // 秒 → µs（最大 86400 s < 2^47）
        input [16:0] s;
        begin
            s_to_us = {31'd0, s} * 48'd1_000_000;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 校准请求状态机（§5.1 / §5.2）
    //   IDLE      ：等待 next_cal_at（首次 = FIRST_CAL_US）或 i_force_cal
    //   WAIT_RESP ：REQ 已发（SEQ 递增），等 i_sync_matched 或重试超时
    //               重试间隔 200/500/1000 ms；RETRY_N 次全失败 ⇒ stale=1，
    //               保留旧 offset（绝不归零），退避 60 s 后回到 IDLE
    //--------------------------------------------------------------------------
    localparam [1:0] C_IDLE = 2'd0, C_WAIT = 2'd1;

    reg [1:0]  cstate;
    reg [16:0] period_q;        // 校准周期（秒），复位 = CAL_PERIOD_S
    reg [47:0] next_cal_at;     // 下次发起校准的本机时刻（µs）
    reg [47:0] deadline_us;     // 本次 REQ 的重试期限
    reg [15:0] retry_left;
    reg [15:0] seq_q;           // REQ 序号（每次发送 +1）
    reg        req_pend;        // 有 REQ 未决（等待 PC 应答）
    reg [47:0] t2_pend;         // 未决 REQ 的发送时刻（算 RTT 用）
    reg [1:0]  retry_idx;       // 选择重试间隔 0/1/2

    wire round_due = (o_ts_local_us >= next_cal_at);

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            cstate         <= C_IDLE;
            period_q       <= CAL_PERIOD_S;
            next_cal_at    <= FIRST_CAL_US;
            deadline_us    <= 48'd0;
            retry_left     <= 16'd0;
            seq_q          <= 16'd0;
            req_pend       <= 1'b0;
            t2_pend        <= 48'd0;
            retry_idx      <= 2'd0;
            o_cal_req      <= 1'b0;
            o_cal_seq      <= 16'd0;
            o_board_ts_us  <= 48'd0;
            o_ts_calibrated<= 1'b0;
            o_ts_stale     <= 1'b0;
            o_offset_reg   <= 48'd0;
            o_rtt_us       <= 16'd0;
        end
        else begin
            o_cal_req <= 1'b0;                          // 默认 1 拍脉冲

            // ---- 下行写入通道 ----
            if (i_period_wr_en) period_q <= i_period_s;
            if (i_off_wr_en) begin
                o_offset_reg    <= i_off_data;          // 绝不归零：只被显式写入
                o_ts_calibrated <= 1'b1;                // §6.3.3 随后回 ACK
                o_ts_stale      <= 1'b0;
            end

            // ---- RTT 记账：TIME_SYNC 的 SEQ 匹配本板未决 REQ（§5.1 第 3 步）----
            if (i_sync_matched && req_pend) begin
                req_pend <= 1'b0;
                o_rtt_us <= (o_ts_local_us - t2_pend);  // 48 bit 截断 = 饱和语义的近似
            end

            case (cstate)
                //----------------------------------------------------------
                C_IDLE: begin
                    if (round_due || i_force_cal) begin
                        // 发起 REQ（§5.1 第 1 步）：t2 = 本机 µs
                        seq_q         <= seq_q + 16'd1;
                        o_cal_seq     <= seq_q + 16'd1;
                        o_board_ts_us <= o_ts_local_us;
                        o_cal_req     <= 1'b1;
                        t2_pend       <= o_ts_local_us;
                        req_pend      <= 1'b1;
                        retry_left    <= RETRY_N;
                        retry_idx     <= 2'd0;
                        deadline_us   <= o_ts_local_us + RETRY_GAP0_US;
                        cstate        <= C_WAIT;
                    end
                end
                //----------------------------------------------------------
                C_WAIT: begin
                    if (i_sync_matched && req_pend) begin
                        // 校准成功：安排下一周期（§5.2 周期校准）
                        next_cal_at <= o_ts_local_us + s_to_us(period_q);
                        cstate      <= C_IDLE;
                    end
                    else if (!req_pend) begin
                        // PC 主动 TIME_SYNC（非应答本板 REQ）也已写 offset：
                        // 同样按周期重新安排，避免立刻再发 REQ
                        next_cal_at <= o_ts_local_us + s_to_us(period_q);
                        cstate      <= C_IDLE;
                    end
                    else if (o_ts_local_us >= deadline_us) begin
                        if (retry_left != 16'd0) begin
                            // 重试（SEQ 递增可去重，§5.2）
                            // 间隔：REQ1→REQ2=GAP0(200ms)，REQ2→REQ3=GAP1(500ms)，
                            //       REQ3→REQ4=GAP2(1000ms) —— 每次重试安排的是
                            //       "距上一次尝试"的下一个间隔（retry_idx 指向已用间隔）
                            seq_q         <= seq_q + 16'd1;
                            o_cal_seq     <= seq_q + 16'd1;
                            o_board_ts_us <= o_ts_local_us;
                            o_cal_req     <= 1'b1;
                            t2_pend       <= o_ts_local_us;
                            retry_left    <= retry_left - 16'd1;
                            deadline_us   <= o_ts_local_us +
                                             ((retry_idx == 2'd0) ? RETRY_GAP1_US :
                                              (retry_idx == 2'd1) ? RETRY_GAP2_US :
                                                                   RETRY_GAP2_US);
                            if (retry_idx != 2'd2) retry_idx <= retry_idx + 2'd1;
                        end
                        else begin
                            // 一轮全失败：保留旧 offset、置 stale，60 s 后再来
                            o_ts_stale  <= 1'b1;
                            req_pend    <= 1'b0;
                            next_cal_at <= o_ts_local_us + STALE_BACKOFF_US;
                            cstate      <= C_IDLE;
                        end
                    end
                end
                //----------------------------------------------------------
                default: cstate <= C_IDLE;
            endcase
        end
    end

endmodule
