//==============================================================================
// uart_link.v —— 串口回传链路（WIRE-U1 §2/§3，R1）
//
// 设计依据：docs/05_experiments/UART路线设计_20261011/UART回传协议设计.md
//   §2.3  时钟 clk_cam（50 MHz）；波特发生器 = 分数累加器（每拍 acc += BAUD×OS，
//         溢出出过采样 tick ⇒ 平均位速率**精确 = BAUD，0 ppm**）——骨架复用
//         uart_telemetry.v（921600 已验证），BAUD 参数化（115200/460800/921600）
//   §3.1  三族帧共用一条 TX：A 遥测帧 AA 55 54 4D（21 B，原样保留，含 ASCII 行）、
//         B 事件帧（uart_ev_tap 提供字节流）、C CTRL 帧（downlink_cmd 构包经
//         uart_dl_bridge 过域）；发送优先级 **CTRL > 遥测 > 事件帧**
//   §3.4  遥测最多插队（21 + ≈90 B ≈ 10 ms@115200），对事件帧延迟影响 <10 ms；
//         事件帧一旦开串**整帧不打断**（CTRL 也只在帧边界受理；2026-10-17 修：
//         原先允许 CTRL 在字节边界插队，会把 CTRL 字节插进事件帧内部 ⇒ 主机
//         F0 5A A5 30 + CRC16 整帧失效，现场 v3CrcFail 5.5%→28.8%）
//   §3.7  'B'(0x42) 单字节命令保留：立即补发一帧遥测；该字节同时转发给
//         downlink_cmd（共用解析器，帧间零散字节按 §3.7 忽略）
//   §2.2  不依赖任何 MODEM 联络信号（无 CTS/RTS）；8N1 / LSB first / 空闲高
//
// ★ WIRE-U2 串口波特率 4 档运行时切换（2026-10-17；接口约定 §1 / 波特率RTL报告）：
//   · 档位 0..3 = 115200 / 230400 / 460800 / 921600；复位档 = baud_sel_of(BAUD)，
//     即顶层参数 BAUD 仍决定上电速率（默认 115200 ⇒ 档 0），**不会**改变既有行为。
//   · 换档请求从 downlink_cmd 经 cdc_tog_word（值+toggle 成对过域）进 clk_cam：
//     i_baud_sel（电平）+ i_baud_pending（1 拍）。本模块先锁存再等"真空闲"。
//   · ⚠️ 换档时刻必须**整条 ACK 已在线上串完**：CTRL FIFO 空 + 无预取 + TX 不再
//     移位 + 仲裁器 AR_IDLE + 事件帧未在发 + 接收器空闲且线路高。理由：CTRL FIFO
//     只吃字节，真正的移位在本模块 TX 引擎里，FIFO 一空就换会把末字节截断。
//   · os_tick 累加器**不重置**（自由运行）：RX 起始位检测按 os_tick 采电平，若在
//     空闲期把累加器钉在 0 会停止 os_tick ⇒ 下一字节永远检测不到起始位。
//   · 非标准 BAUD（TB 的 1 Mbps / 3.125 Mbps）⇒ 走原 OS_STEP 旁路、永不切换。
//
// 端口分三类：遥测统计输入（clk_cam）、事件帧源（uart_ev_tap）、
//             CTRL 字节流（uart_dl_bridge，已过域）；
//             RX 字节流输出到 uart_dl_bridge（转发给共用解析器）。
//==============================================================================
`timescale 1ns / 1ps

module uart_link #(
    parameter CLK_HZ          = 50_000_000,
    parameter BAUD            = 115200,     // 115200 / 460800 / 921600 参数化
    parameter OS              = 16,         // 过采样倍数
    parameter TELEM_PERIOD_MS = 250,        // 遥测周期
    parameter CRC8_POLY       = 8'h07,
    parameter ASCII_TELEM     = 1
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        uart_rxd,            // E14（LVCMOS33）
    output wire        uart_txd,            // D17（LVCMOS33）
    // ---- 遥测统计（clk_cam 域）----
    input  wire [23:0] i_stat_ev_per_frame,
    input  wire [15:0] i_stat_activity_q16,
    input  wire [23:0] i_stat_cr_x10,
    input  wire [31:0] i_stat_frame_cnt,
    input  wire        i_stat_mode,
    input  wire [3:0]  i_key_pressed,
    input  wire        i_cfg_ev_en,
    // ---- 事件帧源（uart_ev_tap）----
    input  wire        i_frdy,
    input  wire        i_fbusy,             // 事件帧正在串出（uart_ev_tap.o_fbusy）
    input  wire        i_fvalid,
    input  wire [7:0]  i_fdata,
    output reg         o_fack,
    output reg         o_fstart,
    // ---- CTRL 字节流（uart_dl_bridge，clk_cam 读侧；FWFT）----
    input  wire        i_ctrl_valid,
    input  wire [7:0]  i_ctrl_data,
    input  wire        i_ctrl_eop,          // 包头边界 token（不作为数据发送）
    output reg         o_ctrl_rd_en,        // 消费头字节（同拍）
    // ---- RX 字节流输出（→ uart_dl_bridge → downlink_cmd 共用解析器）----
    output reg         o_urx_valid,
    output reg  [7:0]  o_urx_data,
    input  wire        i_urx_ack,
    // ---- 统计 ----
    output reg  [15:0] o_stat_b_cmd,        // 收到 'B' 次数
    output reg  [15:0] o_stat_rx_drop,      // RX 字节未被消费而覆盖（饱和）
    // ---- ★ WIRE-U2：4 档波特率运行时切换（downlink_cmd SET_PARAM tag 0x0C）----
    input  wire [1:0]  i_baud_sel,          // 目标档位 0..3；不接（Z）⇒ 取复位档
    input  wire        i_baud_pending,      // 1 拍脉冲：档位已请求（top 内跨域后）
    output reg  [1:0]  o_baud_cur           // 当前**生效**档位（观测/调试/读回）
);

    //==========================================================================
    // 仲裁器状态（提前声明：遥测触发块要引用 tel_start）
    //==========================================================================
    localparam [2:0] AR_IDLE = 3'd0, AR_TL = 3'd1, AR_EV = 3'd2, AR_CT = 3'd3;

    reg [2:0]  ar;
    reg        tel_start;       // 遥测序列启动 1 拍（格式化复位/其中触发）
    reg [7:0]  tl_idx;          // 遥测序列字节序号（0..20 帧 / 21 等 ASCII / 22.. 行）
    reg [7:0]  send_len;        // ASCII 行长度
    reg        ct_hold;         // 已预取一个 CTRL 字节待发
    reg [7:0]  ct_byte;
    reg        ev_got;          // 事件帧已取到至少 1 个字节（防"起步即退"）
                                //   源侧 i_fstart 后要约 1~3 拍才拉 i_fbusy/i_fvalid，
                                //   若不设此标志，仲裁器会在起帧后第一拍误判"帧已结束"
                                //   ⇒ 事件帧永远发不出去（本 TB 实测抓到的真实缺陷）

    //==========================================================================
    // 波特率过采样 tick（分数累加器：平均位速率精确 = BAUD）
    //==========================================================================
    localparam [26:0] OS_STEP = BAUD * OS;
    localparam [26:0] CLK_W   = CLK_HZ;
    localparam [7:0]  OS_LAST = OS - 1;
    localparam [7:0]  OS_HALF8= OS / 2;

    //==========================================================================
    // ★ WIRE-U2：4 档波特率运行时切换（下位机 SET_PARAM tag 0x0C 驱动）
    //
    //  · 档位 0..3 = 115200 / 230400 / 460800 / 921600；步进 = 档位波特率 × OS
    //  · 复位档 = baud_sel_of(BAUD) ⇒ 顶层不接新端口时与改动前**逐比特一致**
    //  · 非标准 BAUD（TB 用 1 Mbps / 3.125 Mbps）⇒ BAUD_IS_STD=0：
    //    os_step_w 恒 = OS_STEP 且 baud_apply 恒 0（永不切换）⇒ 既有 TB 回归零影响
    //  · 切换迟滞 baud_apply（组合）：必须**整条 ACK 已串完**才换分频 ——
    //    CTRL FIFO 空(!i_ctrl_valid) + 无预取(!ct_hold) + TX 不在移位(!tx_busy)
    //    + 无待发请求(!tx_req) + 仲裁器空闲(ar==AR_IDLE) + 事件帧未在发(!i_fbusy)
    //    + 接收器空闲态(rx_state==0) 且 线路空闲高(rxd_sync[1])。
    //    ⚠️ 漏掉 !tx_busy 会把 ACK 最后一个字节截断（AR_IDLE 时 TX 仍在移位）。
    //  · 累加器**不重置**：os_tick 必须自由运行（RX 起始位检测靠每个 os_tick 采电平）；
    //    切换瞬间 os_acc 相位不连续最多 1 个 os_tick = 1/16 位，而 RX 每个字节都在
    //    起始位重新锚定相位、TX 每字节起点 tx_os<=0 ⇒ 不影响任何字节的采样点。
    //  · 未接端口（Z）防御：i_baud_pending / i_baud_sel 一律 === 量化，Z ⇒ 复位档。
    //==========================================================================
    localparam [26:0] OS_STEP_B0 = 115_200 * OS;
    localparam [26:0] OS_STEP_B1 = 230_400 * OS;
    localparam [26:0] OS_STEP_B2 = 460_800 * OS;
    localparam [26:0] OS_STEP_B3 = 921_600 * OS;

    function [1:0] baud_sel_of;
        input integer b;
        begin
            if      (b == 921_600) baud_sel_of = 2'd3;
            else if (b == 460_800) baud_sel_of = 2'd2;
            else if (b == 230_400) baud_sel_of = 2'd1;
            else                   baud_sel_of = 2'd0;
        end
    endfunction

    localparam [1:0] SEL_RST = baud_sel_of(BAUD);
    localparam BAUD_IS_STD = (BAUD == 115_200) || (BAUD == 230_400) ||
                             (BAUD == 460_800) || (BAUD == 921_600);

    wire       baud_pend_s = (i_baud_pending === 1'b1);
    wire [1:0] baud_sel_s  = (i_baud_sel === 2'b11) ? 2'd3 :
                             (i_baud_sel === 2'b10) ? 2'd2 :
                             (i_baud_sel === 2'b01) ? 2'd1 :
                             (i_baud_sel === 2'b00) ? 2'd0 : SEL_RST;

    reg  [1:0] baud_sel;
    reg        baud_pend;
    reg  [1:0] baud_pend_val;

    wire [26:0] os_step_w = !BAUD_IS_STD  ? OS_STEP :
                            (baud_sel == 2'd3) ? OS_STEP_B3 :
                            (baud_sel == 2'd2) ? OS_STEP_B2 :
                            (baud_sel == 2'd1) ? OS_STEP_B1 : OS_STEP_B0;

    wire baud_apply;   // 组合；assign 定义在 RX 引擎之后（依赖 rx_state/rxd_sync）

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            baud_sel      <= SEL_RST;
            baud_pend     <= 1'b0;
            baud_pend_val <= SEL_RST;
            o_baud_cur    <= SEL_RST;
        end
        else begin
            if (baud_pend && baud_apply) begin
                baud_sel   <= baud_pend_val;        // 只有"线路真空闲"时才换分频
                o_baud_cur <= baud_pend_val;
                baud_pend  <= baud_pend_s;
                if (baud_pend_s) baud_pend_val <= baud_sel_s;
            end
            else if (baud_pend_s) begin
                baud_pend     <= 1'b1;
                baud_pend_val <= baud_sel_s;
            end
        end
    end

    reg  [26:0] os_acc;
    reg         os_tick;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            os_acc  <= 27'd0;
            os_tick <= 1'b0;
        end
        else begin
            if (os_acc + os_step_w >= CLK_W) begin
                os_acc  <= os_acc + os_step_w - CLK_W;
                os_tick <= 1'b1;
            end
            else begin
                os_acc  <= os_acc + os_step_w;
                os_tick <= 1'b0;
            end
        end
    end

    //==========================================================================
    // UART 发送（16× 过采样，8N1）——与 uart_telemetry 同骨架
    //==========================================================================
    reg  [7:0] tx_shift;
    reg  [4:0] tx_bit;
    reg  [7:0] tx_os;
    reg        tx_busy;
    reg        txd_r;
    reg  [7:0] tx_byte_i;
    reg        tx_req;          // 发送方请求（电平，引擎接收后由发送方撤）

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            tx_shift <= 8'd0;
            tx_bit   <= 5'd0;
            tx_os    <= 8'd0;
            tx_busy  <= 1'b0;
            txd_r    <= 1'b1;
        end
        else if (os_tick) begin
            if (!tx_busy) begin
                txd_r <= 1'b1;
                if (tx_req) begin
                    tx_busy  <= 1'b1;
                    tx_bit   <= 5'd0;
                    tx_os    <= 8'd0;
                    tx_shift <= tx_byte_i;
                    txd_r    <= 1'b0;               // 起始位
                end
            end
            else if (tx_os == OS_LAST) begin
                tx_os <= 8'd0;
                if (tx_bit == 5'd9) begin
                    tx_busy <= 1'b0;                // 停止位发完
                    txd_r   <= 1'b1;
                end
                else begin
                    tx_bit <= tx_bit + 5'd1;
                    if (tx_bit < 5'd8) txd_r <= tx_shift[tx_bit];
                    else               txd_r <= 1'b1;
                end
            end
            else tx_os <= tx_os + 8'd1;
        end
    end

    assign uart_txd = txd_r;

    //==========================================================================
    // UART 接收（16× 过采样，中点采样）
    //==========================================================================
    reg  [1:0] rxd_sync;
    reg        rxd_d;
    reg  [2:0] rx_state;
    reg  [7:0] rx_os;
    reg  [2:0] rx_bit;
    reg  [7:0] rx_shift;
    reg        rx_done;
    reg  [7:0] rx_byte;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            rxd_sync <= 2'b11;
            rxd_d    <= 1'b1;
            rx_state <= 3'd0;
            rx_os    <= 8'd0;
            rx_bit   <= 3'd0;
            rx_shift <= 8'd0;
            rx_done  <= 1'b0;
            rx_byte  <= 8'd0;
        end
        else begin
            rxd_sync <= {rxd_sync[0], uart_rxd};
            rxd_d    <= rxd_sync[1];
            rx_done  <= 1'b0;

            if (os_tick) begin
                case (rx_state)
                    3'd0: begin
                        // ★ 修复 RX 起始位漏检（2026-10-13，sccb_patch 集成任务附带发现；
                        //   证据见 docs/05_experiments/sccb集成_20261013/sccb集成报告.md §5）：
                        //   原实现 `if (rxd_d && !rxd_sync[1])` 是**下降沿检测**，条件只在
                        //   边沿后**恰好 1 拍**为真；而本分支只在 os_tick 拍求值，
                        //   而 os_tick 间隔 = CLK_HZ/(BAUD*OS) 拍（本 TB 1 Mbps/50 MHz =
                        //   3.125 拍；板端 115200 baud = 27 拍）。⇒ 边沿与 os_tick 窗口
                        //   不对齐时**整个字节漏收**（实测：98 个 rxd_b 下降沿只解出 27 字节；
                        //   同一串字节要么全收要么全丢，因为字节周期恰好是 os_tick 图案
                        //   周期的整数倍）。
                        //   改为**电平检测**：低电平即进入起始位候选，紧接的 state 1 在
                        //   半位中点复核仍为低才认可 ⇒ 毛刺（<半个位）仍被滤除，
                        //   而检测不再依赖相位。停止位为高时 state 0 不会触发。
                        if (!rxd_sync[1]) begin
                            rx_state <= 3'd1;
                            rx_os    <= 8'd0;
                        end
                    end
                    3'd1: begin
                        if (rx_os == OS_HALF8) begin
                            if (!rxd_sync[1]) begin         // 中点仍低 ⇒ 真起始位
                                rx_state <= 3'd2;
                                rx_bit   <= 3'd0;
                            end
                            else rx_state <= 3'd0;
                            rx_os <= 8'd0;
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                    3'd2: begin
                        // ⚠️ 数据位采样间隔必须是 **1 bit（OS_LAST+1 拍）**：
                        //    早期版本误用 OS_HALF8（0.5 bit）⇒ 每半位采一次，收到的
                        //    字节与真值无关（uart_telemetry.v 同源缺陷，本轮一并修复）。
                        //    采样点 = 起始位中点 0.56b + k×1.0b（k=1..8），落在每位中心。
                        if (rx_os == OS_LAST) begin
                            rx_shift <= {rxd_sync[1], rx_shift[7:1]};
                            rx_os    <= 8'd0;
                            if (rx_bit == 3'd7) rx_state <= 3'd3;
                            else                rx_bit   <= rx_bit + 3'd1;
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                    default: begin                          // 停止位（同样 1 bit 步进）
                        if (rx_os == OS_LAST) begin
                            rx_os    <= 8'd0;
                            rx_state <= 3'd0;
                            if (rxd_sync[1]) begin          // 停止位正确
                                rx_byte <= rx_shift;
                                rx_done <= 1'b1;
                            end
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                endcase
            end
        end
    end

    // ★ WIRE-U2：切换前提（组合逻辑）——依赖 rx_state / rxd_sync ⇒ 定义在 RX 引擎之后
    assign baud_apply = BAUD_IS_STD && (ar == AR_IDLE) && !i_ctrl_valid && !ct_hold &&
                        !tx_busy && !tx_req && !i_fbusy &&
                        (rx_state == 3'd0) && rxd_sync[1];

    //==========================================================================
    // RX 字节分发：'B' 本地译码（立即补发遥测）+ 全部字节转发（共用解析器）
    //==========================================================================
    reg [7:0]  urx_hold;
    reg        cmd_b;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            o_urx_valid <= 1'b0;
            o_urx_data  <= 8'd0;
            urx_hold    <= 8'd0;
            cmd_b       <= 1'b0;
            o_stat_b_cmd<= 16'd0;
            o_stat_rx_drop <= 16'd0;
        end
        else begin
            cmd_b <= 1'b0;

            if (o_urx_valid && i_urx_ack) o_urx_valid <= 1'b0;

            if (rx_done) begin
                if (rx_byte == 8'h42) begin             // 'B'：立即补发遥测
                    cmd_b       <= 1'b1;
                    o_stat_b_cmd<= o_stat_b_cmd + 16'd1;
                end
                if (o_urx_valid && !i_urx_ack) begin
                    // 前一个字节未取走 ⇒ 丢弃并计数（不静默）
                    o_stat_rx_drop <= o_stat_rx_drop + 16'd1;
                end
                o_urx_valid <= 1'b1;
                o_urx_data  <= rx_byte;
            end
        end
    end

    //==========================================================================
    // CRC8（poly 0x07 / init 0x00 / MSB-first）——遥测帧用
    //==========================================================================
    function [7:0] crc8_step;
        input [7:0] crc;
        input [7:0] dat;
        integer i;
        reg [7:0] c;
        begin
            c = crc ^ dat;
            for (i = 0; i < 8; i = i + 1)
                c = c[7] ? ((c << 1) ^ CRC8_POLY) : (c << 1);
            crc8_step = c;
        end
    endfunction

    //==========================================================================
    // 遥测周期 / 触发（'B' 立即补发）
    //==========================================================================
    localparam [23:0] TELEM_DIV = TELEM_PERIOD_MS * (CLK_HZ / 1000);

    reg  [23:0] telem_cnt;
    reg         tele_pend;      // 有一次待发遥测

    wire tele_tick = (telem_cnt == TELEM_DIV);

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            telem_cnt <= 24'd0;
            tele_pend <= 1'b0;
        end
        else begin
            if (tele_tick) telem_cnt <= 24'd0;
            else           telem_cnt <= telem_cnt + 24'd1;

            if (cmd_b) begin
                tele_pend <= 1'b1;
                telem_cnt <= 24'd0;
            end
            else if (tele_tick) tele_pend <= 1'b1;
            else if (tel_start) tele_pend <= 1'b0;      // 已受理
        end
    end

    //==========================================================================
    // 遥测帧字节源（21 B：AA 55 54 4D + 16 B 载荷 + CRC8）
    //==========================================================================
    reg  [7:0]  bin_idx;
    reg  [7:0]  bin_crc;
    reg  [31:0] st_fr, st_ev, st_cr;
    reg  [15:0] st_act;
    reg         st_mode, st_en;
    reg  [3:0]  st_key;

    function [7:0] pay_byte;
        input [3:0] k;
        begin
            case (k)
                4'd0 : pay_byte = st_fr[31:24];
                4'd1 : pay_byte = st_fr[23:16];
                4'd2 : pay_byte = st_fr[15:8];
                4'd3 : pay_byte = st_fr[7:0];
                4'd4 : pay_byte = st_ev[23:16];
                4'd5 : pay_byte = st_ev[15:8];
                4'd6 : pay_byte = st_ev[7:0];
                4'd7 : pay_byte = st_act[15:8];
                4'd8 : pay_byte = st_act[7:0];
                4'd9 : pay_byte = st_cr[23:16];
                4'd10: pay_byte = st_cr[15:8];
                4'd11: pay_byte = st_cr[7:0];
                4'd12: pay_byte = {7'b0, st_mode};
                4'd13: pay_byte = {4'b0, st_key};
                4'd14: pay_byte = {7'b0, st_en};
                default: pay_byte = 8'h01;              // PROTO_VER
            endcase
        end
    endfunction

    wire [7:0] bin_byte_w = (bin_idx < 8'd4) ? ((bin_idx == 8'd0) ? 8'hAA :
                                               (bin_idx == 8'd1) ? 8'h55 :
                                               (bin_idx == 8'd2) ? 8'h54 : 8'h4D)
                                             : (bin_idx < 8'd20) ? pay_byte(bin_idx[3:0] - 4'd4)
                                             : bin_crc;

    //==========================================================================
    // ASCII 行格式化（与 uart_telemetry 同实现：十进制，逐位试减式串行除法）
    //==========================================================================
    reg  [7:0]  line_buf [0:95];
    reg  [6:0]  line_len;
    reg         line_ready;

    reg  [3:0]  f_state;
    reg  [4:0]  f_phase;
    reg  [4:0]  f_lit_i;
    reg  [31:0] f_val, f_q;
    reg  [4:0]  f_rem;
    reg  [5:0]  f_bit;
    reg  [3:0]  f_dig [0:11];
    reg  [3:0]  f_ndig;
    reg  [3:0]  f_ei;
    reg         f_started;

    localparam [3:0] F_IDLE = 4'd0, F_LIT = 4'd1, F_DIV = 4'd2,
                     F_STORE= 4'd3, F_EMIT= 4'd4, F_NEXT= 4'd5;

    function [4:0] lit_len;
        input [2:0] li;
        begin
            case (li)
                3'd0: lit_len = 5'd5;   // "T fr="
                3'd1: lit_len = 5'd4;   // " ev="
                3'd2: lit_len = 5'd5;   // " act="
                3'd3: lit_len = 5'd4;   // " cr="
                3'd4: lit_len = 5'd6;   // " mode="
                3'd5: lit_len = 5'd5;   // " key="
                3'd6: lit_len = 5'd4;   // " en="
                default: lit_len = 5'd2; // "\r\n"
            endcase
        end
    endfunction

    function [7:0] lit_byte;
        input [2:0] li;
        input [4:0] i;
        begin
            lit_byte = 8'h20;
            case (li)
                3'd0: case (i) 5'd0: lit_byte = 8'h54; 5'd1: lit_byte = 8'h20;
                              5'd2: lit_byte = 8'h66; 5'd3: lit_byte = 8'h72;
                              5'd4: lit_byte = 8'h3D; default: ; endcase
                3'd1: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h65;
                              5'd2: lit_byte = 8'h76; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase
                3'd2: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h61;
                              5'd2: lit_byte = 8'h63; 5'd3: lit_byte = 8'h74;
                              5'd4: lit_byte = 8'h3D; default: ; endcase
                3'd3: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h63;
                              5'd2: lit_byte = 8'h72; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase
                3'd4: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h6D;
                              5'd2: lit_byte = 8'h6F; 5'd3: lit_byte = 8'h64;
                              5'd4: lit_byte = 8'h65; 5'd5: lit_byte = 8'h3D;
                              default: ; endcase
                3'd5: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h6B;
                              5'd2: lit_byte = 8'h65; 5'd3: lit_byte = 8'h79;
                              5'd4: lit_byte = 8'h3D; default: ; endcase
                3'd6: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h65;
                              5'd2: lit_byte = 8'h6E; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase
                default: case (i) 5'd0: lit_byte = 8'h0D;
                                  default: lit_byte = 8'h0A; endcase
            endcase
        end
    endfunction

    function [31:0] phase_val;
        input [4:0] ph;
        begin
            case (ph)
                5'd1 : phase_val = st_fr;
                5'd3 : phase_val = st_ev;
                5'd5 : phase_val = {16'b0, st_act};
                5'd7 : phase_val = st_cr;
                5'd9 : phase_val = {31'b0, st_mode};
                5'd11: phase_val = {28'b0, st_key};
                default: phase_val = {31'b0, st_en};
            endcase
        end
    endfunction

    reg  [4:0]  rem2;
    reg  [31:0] q2;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            f_state   <= F_IDLE;
            f_phase   <= 5'd0;
            f_lit_i   <= 5'd0;
            f_val     <= 32'd0;
            f_q       <= 32'd0;
            f_rem     <= 5'd0;
            f_bit     <= 6'd0;
            f_ndig    <= 4'd0;
            f_ei      <= 4'd0;
            f_started <= 1'b0;
            line_len  <= 7'd0;
            line_ready<= 1'b0;
            st_fr     <= 32'd0;  st_ev <= 32'd0;  st_cr <= 32'd0;
            st_act    <= 16'd0;  st_mode <= 1'b0; st_key <= 4'd0; st_en <= 1'b0;
        end
        else begin
            case (f_state)
                F_IDLE: begin
                    // line_ready 是粘滞标志：下一轮格式化开始时才清
                    if (tel_start) begin
                        st_fr   <= i_stat_frame_cnt;
                        st_ev   <= {8'b0, i_stat_ev_per_frame};
                        st_act  <= i_stat_activity_q16;
                        st_cr   <= {8'b0, i_stat_cr_x10};
                        st_mode <= i_stat_mode;
                        st_key  <= i_key_pressed;
                        st_en   <= i_cfg_ev_en;
                        line_len   <= 7'd0;
                        line_ready <= 1'b0;
                        f_phase  <= 5'd0;
                        f_lit_i  <= 5'd0;
                        f_state  <= F_LIT;
                    end
                end
                F_LIT: begin
                    if ((f_phase[0] == 1'b0) && (ASCII_TELEM != 0)) begin
                        line_buf[line_len] <= lit_byte(f_phase[4:1], f_lit_i);
                        line_len <= line_len + 7'd1;
                        if (f_lit_i == (lit_len(f_phase[4:1]) - 5'd1)) begin
                            f_lit_i <= 5'd0;
                            f_phase <= f_phase + 5'd1;
                        end
                        else f_lit_i <= f_lit_i + 5'd1;
                    end
                    else if ((f_phase[0] == 1'b0) && (ASCII_TELEM == 0)) begin
                        f_lit_i <= 5'd0;
                        f_phase <= f_phase + 5'd1;
                    end
                    else begin
                        f_val     <= phase_val(f_phase);
                        f_q       <= 32'd0;
                        f_rem     <= 5'd0;
                        f_bit     <= 6'd0;
                        f_ndig    <= 4'd0;
                        f_started <= 1'b0;
                        f_state   <= F_DIV;
                    end
                end
                F_DIV: begin
                    if (f_bit == 6'd32) f_state <= F_STORE;
                    else begin
                        rem2 = {f_rem[3:0], f_val[5'd31 - f_bit[4:0]]};
                        q2   = {f_q[30:0], 1'b0};
                        if (rem2 >= 5'd10) begin
                            f_rem <= rem2 - 5'd10;
                            f_q   <= q2 | 32'd1;
                        end
                        else begin
                            f_rem <= rem2;
                            f_q   <= q2;
                        end
                        f_bit <= f_bit + 6'd1;
                    end
                end
                F_STORE: begin
                    f_dig[f_ndig] <= f_rem[3:0];
                    f_ndig        <= f_ndig + 4'd1;
                    if (f_q == 32'd0) begin
                        f_ei    <= 4'd0;
                        f_state <= F_EMIT;
                    end
                    else begin
                        f_val  <= f_q;
                        f_q    <= 32'd0;
                        f_rem  <= 5'd0;
                        f_bit  <= 6'd0;
                        f_state<= F_DIV;
                    end
                end
                F_EMIT: begin
                    if ((f_ei < f_ndig) && (f_dig[f_ndig - 4'd1 - f_ei] != 4'd0 || f_started ||
                                            (f_ei == (f_ndig - 4'd1)))) begin
                        line_buf[line_len] <= 8'h30 + {4'b0, f_dig[f_ndig - 4'd1 - f_ei]};
                        line_len  <= line_len + 7'd1;
                        f_started <= 1'b1;
                    end
                    f_ei <= f_ei + 4'd1;
                    if (f_ei >= f_ndig) begin
                        f_state <= F_NEXT;
                        f_ei    <= 4'd0;
                    end
                end
                F_NEXT: begin
                    f_phase <= f_phase + 5'd1;
                    if (f_phase >= 5'd14) begin
                        line_ready <= 1'b1;
                        f_state    <= F_IDLE;
                    end
                    else f_state <= F_LIT;
                end
                default: f_state <= F_IDLE;
            endcase
        end
    end

    //==========================================================================
    // 三路发送仲裁：CTRL > 遥测 > 事件帧（§3.1/§3.4）
    //==========================================================================
    // CTRL 预取（在本拍：token 丢弃 / 取字节；FWFT 头字节同拍有效）
    wire ct_fetch = (!ct_hold) && i_ctrl_valid;
    wire ct_tok   = ct_fetch && i_ctrl_eop;
    wire ct_byte_ok = ct_fetch && !i_ctrl_eop;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            ar         <= AR_IDLE;
            tel_start  <= 1'b0;
            tl_idx     <= 8'd0;
            send_len   <= 8'd0;
            ct_hold    <= 1'b0;
            ct_byte    <= 8'd0;
            tx_req     <= 1'b0;
            tx_byte_i  <= 8'd0;
            bin_idx    <= 8'd0;
            bin_crc    <= 8'd0;
            o_fack     <= 1'b0;
            o_fstart   <= 1'b0;
            o_ctrl_rd_en <= 1'b0;
            ev_got     <= 1'b0;
        end
        else begin
            tel_start    <= 1'b0;
            o_fack       <= 1'b0;
            o_fstart     <= 1'b0;
            o_ctrl_rd_en <= ct_fetch;      // 预取即消费 FIFO 头（token/字节同拍）

            // ---- CTRL 预取（最高优先，任何状态都做）----
            if (ct_byte_ok) begin
                ct_byte <= i_ctrl_data;
                ct_hold <= 1'b1;
            end

            case (ar)
                //--------------------------------------------------------------
                AR_IDLE: begin
                    tx_req <= 1'b0;
                    if (ct_hold) begin
                        ar <= AR_CT;
                    end
                    else if (tele_pend) begin
                        tel_start <= 1'b1;
                        tl_idx    <= 8'd0;
                        bin_idx   <= 8'd0;
                        bin_crc   <= 8'd0;
                        ar        <= AR_TL;
                    end
                    else if (i_frdy) begin
                        o_fstart <= 1'b1;
                        ev_got   <= 1'b0;
                        ar       <= AR_EV;
                    end
                end
                //--------------------------------------------------------------
                AR_TL: begin                        // 21 B 遥测帧 → 等 ASCII → 行
                    if (tl_idx < 8'd21) begin
                        if (!tx_req) begin
                            if (!tx_busy) begin
                                tx_byte_i <= bin_byte_w;
                                tx_req    <= 1'b1;
                            end
                        end
                        else if (tx_busy) begin
                            tx_req <= 1'b0;
                            if (bin_idx < 8'd20) bin_crc <= crc8_step(bin_crc, bin_byte_w);
                            if (tl_idx == 8'd20) begin
                                tl_idx <= 8'd21;        // → ASCII 等待
                            end
                            else begin
                                bin_idx <= bin_idx + 8'd1;
                                tl_idx  <= tl_idx + 8'd1;
                            end
                        end
                    end
                    else if (tl_idx == 8'd21) begin
                        tx_req <= 1'b0;
                        if (line_ready || (ASCII_TELEM == 0)) begin
                            send_len <= (ASCII_TELEM != 0) ? line_len : 8'd0;
                            tl_idx   <= 8'd22;
                        end
                    end
                    else if (ASCII_TELEM == 0) ar <= AR_IDLE;
                    else if (send_len == 8'd0) ar <= AR_IDLE;
                    else begin
                        if (!tx_req) begin
                            if (!tx_busy) begin
                                tx_byte_i <= line_buf[tl_idx - 8'd22];
                                tx_req    <= 1'b1;
                            end
                        end
                        else if (tx_busy) begin
                            tx_req <= 1'b0;
                            if ((tl_idx - 8'd22) == (send_len - 8'd1)) ar <= AR_IDLE;
                            else tl_idx <= tl_idx + 8'd1;
                        end
                    end
                end
                //--------------------------------------------------------------
                AR_EV: begin                        // 事件帧字节流（整帧不可被 CTRL 打断）
                    if (!tx_req) begin
                        // ★ 2026-10-17 修（UART 事件帧截断）：这里**不许**再因
                        //   ct_hold 切去 AR_CT —— 切走再回来只是把 CTRL 字节插进
                        //   事件帧中部，主机按 EV_LEN+CRC16 校验整帧必坏（现场
                        //   v3CrcFail 5.5%→28.8% 的主因）。CTRL 只在 AR_IDLE
                        //   的帧边界受理，最长等待一帧（1471 B≈128 ms@115200）。
                        if (i_fvalid) begin
                            if (!tx_busy) begin
                                tx_byte_i <= i_fdata;
                                tx_req    <= 1'b1;
                                o_fack    <= 1'b1;      // 从 tap 取走一个字节
                                ev_got    <= 1'b1;
                            end
                        end
                        else if (ev_got && !i_fbusy) begin
                            ar <= AR_IDLE;              // 帧串完（tap 已收尾）
                        end
                    end
                    else if (tx_busy) begin
                        tx_req <= 1'b0;
                    end
                end
                //--------------------------------------------------------------
                default: begin                      // AR_CT：发 CTRL 字节（一字节一进）
                    if (ct_hold) begin
                        if (!tx_req) begin
                            if (!tx_busy) begin
                                tx_byte_i <= ct_byte;
                                tx_req    <= 1'b1;
                            end
                        end
                        else if (tx_busy) begin
                            tx_req  <= 1'b0;
                            ct_hold <= 1'b0;            // 该字节已发出；下一拍再预取
                        end
                    end
                    else if (i_fbusy) begin
                        // ★ 防御性续发路径：正常情况 AR_CT 只从 AR_IDLE 进入（帧
                        //   边界），此处不会命中；但若将来又允许帧中打断，源侧
                        //   （uart_ev_tap）在整帧串完前一直 o_fbusy=1、o_fvalid 挂住
                        //   待发字节，必须回 AR_EV 续发，否则事件帧等不到下一次
                        //   o_fstart 而卡死。i_fbusy=0 ⇒ 帧已收尾 ⇒ IDLE。
                        ar <= AR_EV;
                    end
                    else ar <= AR_IDLE;
                end
            endcase
        end
    end

endmodule
