//==============================================================================
// eth_top_sim_model.v —— **仿真专用**的厂家 eth_top 行为级替身（模块名故意叫 eth_top）
//
// 为什么需要它：
//   厂家以太网栈（gmii_to_rgmii/rgmii_rx/rgmii_tx）依赖 IDELAYE2/IDDR/ODDR/
//   BUFIO/BUFG 等 Xilinx 原语，纯 ModelSim 环境（无 unisim 库）跑不起来。
//   本文件按厂家 udp_tx.v 的**逐拍时序**复刻发送侧握手，让 eth_udp 的
//   "缓冲 + 跨域 + 重放" 逻辑可以离线协议级验证。
//
// ⚠️ 使用纪律：
//   · 模块名与厂家 eth_top **同名互斥**：仿真时 .f 里只列本文件；综合时只列
//     ref_original/eth_top.v（厂家原件）。**同一编译绝不能同时收录两者**。
//   · 本文件不是厂家代码，也不替代上板验证（RGMII 时序/IDELAY/ARP 只能上板确认）。
//
// 时序依据（读厂家 exp_ov5640_lcd_eth/prj_src/rtl/eth/udp/udp_tx.v 得出）：
//   · 厂家 tx_req 是"标准模式 FIFO"读信号：比数据相位**早 1 拍**拉高，
//     数据相位共 tx_byte_num 拍；tx_req 高电平共 tx_byte_num 拍。
//   · 即：cycle B 起 tx_req=1，cycle C=B+1 起连续 tx_byte_num 拍数据相位，
//     tx_req 到 C+n-2 拉低，数据相位结束后 1 拍 tx_done 拉高。
//   · gmii_to_rgmii.v 里 assign gmii_tx_clk = gmii_rx_clk（= BUFG(eth_rxc)）。
//==============================================================================

module eth_top #(
    parameter [47:0] BOARD_MAC       = 48'h00_11_22_33_44_55,
    parameter [31:0] BOARD_IP        = {8'd192,8'd168,8'd1,8'd10},
    parameter [47:0] DES_MAC_DEFAULT = 48'hff_ff_ff_ff_ff_ff,
    parameter [31:0] DES_IP_DEFAULT  = {8'd192,8'd168,8'd1,8'd102},
    parameter        IDELAY_VALUE    = 0
)(
    input  wire        clk_200m,
    input  wire        sys_rst_n,
    input  wire        eth_rxc,
    input  wire        eth_rx_ctl,
    input  wire [3:0]  eth_rxd,
    output wire        eth_txc,
    output wire        eth_tx_ctl,
    output wire [3:0]  eth_txd,
    output wire        eth_rst_n,
    output wire        gmii_tx_clk,
    input  wire        udp_tx_start_en,
    input  wire [7:0]  tx_data,
    input  wire [15:0] tx_byte_num,
    output wire        udp_tx_done,
    output wire        tx_req,
    output wire        gmii_rx_clk,
    output wire        rec_pkt_done,
    output wire        rec_en,
    output wire [7:0]  rec_data,
    output wire [15:0] rec_byte_num
);

    localparam HDR_CYC = 8;         // 首部相位拍数（check_sum/preamble/eth/ip/udp）

    // ---- 时钟：与厂家一致（rx/tx 同源，都来自 eth_rxc）----
    assign gmii_rx_clk = eth_rxc;
    assign gmii_tx_clk = eth_rxc;
    assign eth_rst_n   = sys_rst_n;

    // ---- RGMII 发送引脚：行为级模型不产生真实 RGMII 波形 ----
    assign eth_txc     = 1'b0;
    assign eth_tx_ctl  = 1'b0;
    assign eth_txd     = 4'b0000;

    // ---- 接收侧：本期不使用（顶层未引出）----
    assign rec_pkt_done = 1'b0;
    assign rec_en       = 1'b0;
    assign rec_data     = 8'h00;
    assign rec_byte_num = 16'd0;

    // ---- 发送握手（逐拍复刻 udp_tx.v）----
    reg        start_d;
    reg  [1:0] state;
    reg  [15:0] n_r, req_cnt, hdr_cnt;
    reg        tx_req_r, tx_done_r;

    assign tx_req      = tx_req_r;
    assign udp_tx_done = tx_done_r;

    // ---- 记录（供 TB 用层次引用检查）----
    reg  [7:0] pay [0:2047];        // 最近一包收到的负载字节
    integer    pay_n;               // 最近一包字节数
    integer    n_pkt;               // 收到的包数
    reg [15:0] last_len;
    reg  [7:0] hdr [0:63];          // 以太网+IP+UDP 首部 42 B（按参数拼）

    wire start_pulse = udp_tx_start_en & (~start_d);

    always @(posedge gmii_tx_clk or negedge sys_rst_n) begin
        if (!sys_rst_n) begin
            start_d   <= 1'b0;
            state     <= 2'd0;
            n_r       <= 16'd0;
            req_cnt   <= 16'd0;
            hdr_cnt   <= 16'd0;
            tx_req_r  <= 1'b0;
            tx_done_r <= 1'b0;
            pay_n     <= 0;
            n_pkt     <= 0;
            last_len  <= 16'd0;
        end
        else begin
            start_d   <= udp_tx_start_en;
            tx_done_r <= 1'b0;

            case (state)
                //--------------------------------------------------------------
                2'd0: begin
                    if (start_pulse) begin
                        state    <= 2'd1;
                        n_r      <= tx_byte_num;
                        last_len <= tx_byte_num;
                        hdr_cnt  <= 16'd0;
                        pay_n    <= 0;
                    end
                end
                //--------------------------------------------------------------
                2'd1: begin                     // 首部相位
                    if (hdr_cnt == (HDR_CYC - 1)) begin
                        state    <= 2'd2;
                        req_cnt  <= 16'd0;
                        tx_req_r <= 1'b1;       // cycle B
                        // 按参数拼以太网/IP/UDP 首部（供 TB 核对参数透传）
                        hdr[0]  <= DES_MAC_DEFAULT[47:40];
                        hdr[1]  <= DES_MAC_DEFAULT[39:32];
                        hdr[2]  <= DES_MAC_DEFAULT[31:24];
                        hdr[3]  <= DES_MAC_DEFAULT[23:16];
                        hdr[4]  <= DES_MAC_DEFAULT[15:8];
                        hdr[5]  <= DES_MAC_DEFAULT[7:0];
                        hdr[6]  <= BOARD_MAC[47:40];
                        hdr[7]  <= BOARD_MAC[39:32];
                        hdr[8]  <= BOARD_MAC[31:24];
                        hdr[9]  <= BOARD_MAC[23:16];
                        hdr[10] <= BOARD_MAC[15:8];
                        hdr[11] <= BOARD_MAC[7:0];
                        hdr[12] <= 8'h08;       // ethertype = 0x0800
                        hdr[13] <= 8'h00;
                        hdr[14] <= 8'h45;       // IPv4, IHL=5
                        hdr[15] <= 8'h00;
                        hdr[16] <= (tx_byte_num + 16'd28) >> 8;   // IP total length
                        hdr[17] <= (tx_byte_num + 16'd28) & 8'hFF;
                        hdr[18] <= 8'h00; hdr[19] <= 8'h00;
                        hdr[20] <= 8'h00; hdr[21] <= 8'h00;
                        hdr[22] <= 8'h40;       // TTL
                        hdr[23] <= 8'h11;       // UDP
                        hdr[24] <= 8'h00; hdr[25] <= 8'h00;       // checksum
                        hdr[26] <= BOARD_IP[31:24];
                        hdr[27] <= BOARD_IP[23:16];
                        hdr[28] <= BOARD_IP[15:8];
                        hdr[29] <= BOARD_IP[7:0];
                        hdr[30] <= DES_IP_DEFAULT[31:24];
                        hdr[31] <= DES_IP_DEFAULT[23:16];
                        hdr[32] <= DES_IP_DEFAULT[15:8];
                        hdr[33] <= DES_IP_DEFAULT[7:0];
                        hdr[34] <= 8'h04; hdr[35] <= 8'hD2;       // 源端口 1234
                        hdr[36] <= 8'h04; hdr[37] <= 8'hD2;       // 目的端口 1234
                        hdr[38] <= (tx_byte_num + 16'd8) >> 8;    // UDP 长度
                        hdr[39] <= (tx_byte_num + 16'd8) & 8'hFF;
                        hdr[40] <= 8'h00; hdr[41] <= 8'h00;       // UDP checksum
                    end
                    else hdr_cnt <= hdr_cnt + 16'd1;
                end
                //--------------------------------------------------------------
                2'd2: begin                     // 数据相位
                    if ((req_cnt >= 16'd1) && (req_cnt <= n_r)) begin
                        pay[req_cnt - 16'd1] <= tx_data;
                        pay_n <= req_cnt;
                    end
                    if (req_cnt == n_r) begin
                        tx_req_r  <= 1'b0;
                        tx_done_r <= 1'b1;
                        state     <= 2'd0;
                        n_pkt     <= n_pkt + 1;
                    end
                    else begin
                        if ((n_r == 16'd1) ? (req_cnt == 16'd0)
                                           : (req_cnt == (n_r - 16'd2)))
                            tx_req_r <= 1'b0;   // 厂家：tx_req 到数据相位倒数第 2 拍拉低
                        req_cnt <= req_cnt + 16'd1;
                    end
                end
                default: state <= 2'd0;
            endcase
        end
    end

endmodule
