//==============================================================================
// eth_udp.v —— 厂家以太网协议栈（例程 60）的**包装/例化层**
//
// 规格：docs/子模块设计/L2_通信/eth_udp.md（§2 端口 / §3 参数 / §4 结构 / §9 陷阱）
// 接口：以 lead 冻结的顶层接口为准（2026-09-27 广播），与文档 §2 的差异见下。
//
// ⚠️ 本模块**不含任何厂家 RTL 的修改**：厂家源文件从 ref_original/ 只读复用，
//    由 tool/setup_vendor_rtl.ps1 拷贝（ref_original/README.md 有说明）。
//    例化的厂家模块：eth_top（其内部再例化 gmii_to_rgmii / arp / udp / eth_ctrl）。
//
//------------------------------------------------------------------------------
// 时钟结构（★ 关键，必须理解）
//------------------------------------------------------------------------------
//   厂家 gmii_to_rgmii.v 里写死一句：assign gmii_tx_clk = gmii_rx_clk;
//   而 gmii_rx_clk = BUFG(rgmii_rxc) —— 即**整条以太网协议栈都由 PHY 的 RX 时钟驱动**，
//   顶层无法在外部产生这个时钟（clk_rst_gen 文档 §1 也明确"不产生 RGMII RX 时钟"）。
//   冻结接口里 clk_eth = eth_rxc（顶层直接 assign），与栈内的 gmii_rx_clk 同源不同 BUFG。
//   ⇒ 本模块把**上行字节缓冲做成真双口 RAM**：写口在 clk_eth、读口在栈内的 gmii_rx_clk，
//     跨域控制只用"电平 + 翻转标志 + 2 级同步器"，不依赖两个 BUFG 的相位关系。
//     （同源同频，实测相位差为 0；但按 CDC 规矩写，才不怕将来换时钟方案。）
//
//------------------------------------------------------------------------------
// 上行包握手（与 udp_merge 约定）
//------------------------------------------------------------------------------
//   1) o_tx_ready=1 时，调用方拉高 i_tx_start **1 拍**，同拍 i_tx_len 有效；
//   2) 随后调用方连续（或带 i_tx_byte_en 间隔）推送 i_tx_len 个字节；
//   3) 字节收齐后本模块自动启动厂家 UDP 发送，o_tx_ready 拉低直到整包发完；
//   4) 超长保护：i_tx_len > MAX_TX_LEN 时**截断到 MAX_TX_LEN**（MTU 红线，H35），
//      保证以太网帧 ≤ 1518 B；i_tx_len == 0 直接忽略（不回 ready，不会死锁）。
//   ⚠️ 厂家 udp_tx.v 把 UDP 源/目的端口写死为 1234（不可参数化，改了就违反"不改厂家 RTL"）；
//      PC_PORT 参数仅作记录，实际端口恒为 1234（与文档 §3 默认值一致）。
//   ⚠️ 厂家 udp_tx.v 有 MIN_DATA_NUM=18：负载 <18 B 时按 18 B 发（多出字节补 0），
//      UDP 长度字段仍是真实长度。本工程最短包 = 纯事件包 13+5+2 = 20 B > 18，不受影响。
//
//------------------------------------------------------------------------------
// 与文档 §2 的差异（已报 lead）
//------------------------------------------------------------------------------
//   · 端口名以 lead 冻结接口为准：clk_200m → clk_ref_200m；不再引出 clk_eth（输入）；
//     去掉 eth_mdc/eth_mdio（厂家栈无 MDIO，PHY 用硬件默认值，实测可用）；
//     去掉 o_rec_*（PC 下发命令的接收通路；本期顶层的开始/停止用 RGS 使能代替）。
//   · 新增内部保护：i_tx_len 截断到 MAX_TX_LEN（MTU 红线）、等待超时自动回 IDLE。
//==============================================================================

module eth_udp #(
    parameter [47:0] BOARD_MAC   = 48'h00_11_22_33_44_55,   // 板卡 MAC（固定）
    parameter [31:0] BOARD_IP    = {8'd192,8'd168,8'd1,8'd10},   // 板卡 IP（固定）
    parameter [31:0] PC_IP       = {8'd192,8'd168,8'd1,8'd102},  // 目标 PC IP
    parameter [47:0] PC_MAC      = 48'hff_ff_ff_ff_ff_ff,   // 目标 MAC（ARP 学到前用广播）
    parameter [15:0] PC_PORT     = 16'd1234,                // 目标端口（厂家写死 1234）
    parameter        IDELAY_VALUE = 0,                      // RGMII 输入延时（tap×78 ps）
    parameter [15:0] MAX_TX_LEN  = 16'd1472,                // 单包负载硬上限（MTU 红线）
    parameter        BUF_BYTES   = 2048,                    // 上行缓冲深度（1 块 BRAM18K）
    parameter [15:0] WAIT_TIMEOUT = 16'hFFFF                // 等厂家 tx_done 的超时拍数
)(
    input  wire        clk_eth,        // = eth_rxc（PHY 给的 125 MHz）
    input  wire        rst_n_eth,      // 以太网域复位，低有效（异步置位/同步释放）
    input  wire        clk_ref_200m,   // IDELAYCTRL 参考（200 MHz，与 MIG 共用，H37）
    // ---- RGMII 引脚（底板 GE1 口）----
    input  wire        eth_rxc,
    input  wire        eth_rx_ctl,
    input  wire [3:0]  eth_rxd,
    output wire        eth_txc,
    output wire        eth_tx_ctl,
    output wire [3:0]  eth_txd,
    output wire        eth_rst_n,      // PHY 复位（低有效）
    // ---- 上行包接口（来自 udp_merge）----
    input  wire        i_tx_start,     // 1 拍：本包开始，同拍 i_tx_len 有效
    input  wire [7:0]  i_tx_byte,
    input  wire        i_tx_byte_en,   // 字节有效
    input  wire [15:0] i_tx_len,       // 本包字节数
    output wire        o_tx_ready,     // 可接收新包（udp_merge 的 i_tx_ready）
    // ---- v3 下行 RX 字节流（R2：厂家栈 rec_* 不再丢弃；gmii_rx_clk → clk_eth）----
    output wire        o_rx_rd_valid,  // FWFT：!empty 即有效（clk_eth 域）
    output wire [7:0]  o_rx_rd_data,
    input  wire        i_rx_rd_en,     // 读使能（消费方恒 1 即可，FIFO 内部按空门控）
    output wire        o_rx_pkt_done,  // 包边界脉冲（clk_eth 域，每包一个）
    output wire [15:0] o_rx_ovf        // RX FIFO 溢出计数（gmii_rx_clk 域自由计数）
);

    //--------------------------------------------------------------------------
    // 厂家栈接口线
    //--------------------------------------------------------------------------
    wire        gmii_rx_clk_w;      // = 栈内 BUFG(eth_rxc)
    wire        gmii_tx_clk_w;      // 厂家：assign gmii_tx_clk = gmii_rx_clk
    wire        udp_tx_start_en_w;
    wire [7:0]  tx_data_w;
    wire [15:0] tx_byte_num_w;
    wire        udp_tx_done_w;
    wire        tx_req_w;

    // 厂家栈其余输出（接收/ARP）本期不引出
    wire        rec_pkt_done_w, rec_en_w;
    wire [7:0]  rec_data_w;
    wire [15:0] rec_byte_num_w;

    //--------------------------------------------------------------------------
    // 上行字节缓冲：真双口 RAM（写 clk_eth / 读 gmii_tx_clk）
    //
    // ⚠️ ram_style 是**必须**的，不是优化（实测 2026-10-06）：不加属性时 Vivado 打印
    //   RAM "pkt_ram_reg" dissolved into registers ⇒ 2048×8 = 16,384 个触发器。
    //   与 udp_merge 的两个数组叠加后，全设计 FF 达 68,188、控制集 5,021，
    //   直接把 place_design 顶死（[Place 30-487]，缺 92 个 slice）。
    //--------------------------------------------------------------------------
    (* ram_style = "block" *) reg [7:0]  pkt_ram [0:BUF_BYTES-1];

    reg [10:0] wr_cnt;
    reg [10:0] rd_addr;
    reg [7:0]  rd_data;

    //--------------------------------------------------------------------------
    // 写侧状态机（clk_eth 域）
    //--------------------------------------------------------------------------
    localparam [1:0] W_IDLE = 2'd0, W_LOAD = 2'd1, W_WAIT = 2'd2;

    reg  [1:0]  wstate;
    reg  [15:0] len_r;          // 本包长度（跨到发送域使用，握手期间保持稳定）
    reg         start_tgl;      // 包就绪翻转标志（clk_eth → tx）
    reg  [15:0] to_cnt;         // LOAD/WAIT 超时计数

    // 发送域 → 写域：完成翻转标志 + 2 级同步
    reg         done_tgl;
    reg  [2:0]  done_sync;
    wire        done_edge = done_sync[2] ^ done_sync[1];

    // 发送域复位（异步置位 / 同步释放到 gmii_tx_clk）
    reg  [1:0]  rst_tx_sync;
    wire        rst_n_tx = rst_tx_sync[1];

    // 发送域 → 写域
    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) done_sync <= 3'b000;
        else            done_sync <= {done_sync[1:0], done_tgl};
    end

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            wstate    <= W_IDLE;
            wr_cnt    <= 11'd0;
            len_r     <= 16'd0;
            start_tgl <= 1'b0;
            to_cnt    <= 16'd0;
        end
        else begin
            case (wstate)
                //--------------------------------------------------------------
                W_IDLE: begin
                    to_cnt <= 16'd0;
                    if (i_tx_start && (i_tx_len != 16'd0)) begin
                        // MTU 红线：负载硬截断到 MAX_TX_LEN（H35）
                        len_r  <= (i_tx_len > MAX_TX_LEN) ? MAX_TX_LEN : i_tx_len;
                        wr_cnt <= 11'd0;
                        wstate <= W_LOAD;
                    end
                end
                //--------------------------------------------------------------
                W_LOAD: begin
                    to_cnt <= to_cnt + 16'd1;
                    if (to_cnt == WAIT_TIMEOUT) begin
                        wstate <= W_IDLE;                 // 调用方半途停手，自恢复
                    end
                    else if (i_tx_byte_en) begin
                        if (wr_cnt == (len_r[10:0] - 11'd1)) begin
                            start_tgl <= ~start_tgl;      // 通知发送域：包已就绪
                            wstate    <= W_WAIT;
                            to_cnt    <= 16'd0;
                        end
                        else wr_cnt <= wr_cnt + 11'd1;
                    end
                end
                //--------------------------------------------------------------
                W_WAIT: begin
                    to_cnt <= to_cnt + 16'd1;
                    if (done_edge || (to_cnt == WAIT_TIMEOUT)) wstate <= W_IDLE;
                end
                default: wstate <= W_IDLE;
            endcase
        end
    end

    assign o_tx_ready = (wstate == W_IDLE) & rst_n_eth;

    //--------------------------------------------------------------------------
    // ★ 存储写口：独立、无复位的 always 块（同 udp_merge，实测 2026-10-06）
    //   写条件与原 W_LOAD 分支逐字等价：wstate==W_LOAD && to_cnt!=WAIT_TIMEOUT && i_tx_byte_en
    //   放进 `always @(posedge clk_eth or negedge rst_n_eth)` 会被 Vivado 判为
    //   "RAM is sensitive to asynchronous reset signal" ⇒ 溶解成 16,384 个触发器。
    //--------------------------------------------------------------------------
    wire pkt_wr_en = (wstate == W_LOAD) && (to_cnt != WAIT_TIMEOUT) && i_tx_byte_en;
    always @(posedge clk_eth) begin
        if (pkt_wr_en) pkt_ram[wr_cnt] <= i_tx_byte;
    end

    //--------------------------------------------------------------------------
    // 发送侧（gmii_tx_clk 域 = 栈内 BUFG(eth_rxc)）
    //--------------------------------------------------------------------------
    reg  [2:0]  start_sync;
    reg         sending;
    reg         tx_start_en_r;
    reg  [15:0] tx_num_r;

    wire        start_edge = start_sync[2] ^ start_sync[1];

    always @(posedge gmii_tx_clk_w or negedge rst_n_eth) begin
        if (!rst_n_eth) rst_tx_sync <= 2'b00;
        else            rst_tx_sync <= {rst_tx_sync[0], 1'b1};
    end

    always @(posedge gmii_tx_clk_w or negedge rst_n_tx) begin
        if (!rst_n_tx) begin
            start_sync    <= 3'b000;
            sending       <= 1'b0;
            tx_start_en_r <= 1'b0;
            tx_num_r      <= 16'd0;
            rd_addr       <= 11'd0;
            done_tgl      <= 1'b0;
        end
        else begin
            start_sync    <= {start_sync[1:0], start_tgl};
            tx_start_en_r <= 1'b0;                    // 默认只拉 1 拍

            if (!sending) begin
                if (start_edge) begin
                    sending       <= 1'b1;
                    rd_addr       <= 11'd0;
                    tx_num_r      <= len_r;           // 握手期间稳定，可安全跨域
                    tx_start_en_r <= 1'b1;
                end
            end
            else begin
                if (tx_req_w) rd_addr <= rd_addr + 11'd1;
                if (udp_tx_done_w) begin
                    sending  <= 1'b0;
                    done_tgl <= ~done_tgl;
                end
            end
        end
    end

    // 读口（同步读，1 拍延迟）：厂家 udp_tx.v 的 tx_req 比数据相位早 1 拍拉高，
    // 正好对应"标准模式 FIFO（rd_en → 次拍 dout 有效）"，与参考实现
    // exp_ov5640_lcd_eth/prj_src/rtl/img_data_pkt_udp.v 的 async_fifo 用法一致。
    always @(posedge gmii_tx_clk_w) begin
        rd_data <= pkt_ram[rd_addr];
    end

    assign tx_data_w      = rd_data;
    assign tx_byte_num_w  = tx_num_r;

    //--------------------------------------------------------------------------
    // 厂家协议栈（只读复用，未做任何修改）
    //--------------------------------------------------------------------------
    eth_top #(
        .BOARD_MAC       (BOARD_MAC),
        .BOARD_IP        (BOARD_IP),
        .DES_MAC_DEFAULT (PC_MAC),
        .DES_IP_DEFAULT  (PC_IP),
        .IDELAY_VALUE    (IDELAY_VALUE)
    ) u_eth_top (
        .clk_200m        (clk_ref_200m),
        .sys_rst_n       (rst_n_eth),
        .eth_rxc         (eth_rxc),
        .eth_rx_ctl      (eth_rx_ctl),
        .eth_rxd         (eth_rxd),
        .eth_txc         (eth_txc),
        .eth_tx_ctl      (eth_tx_ctl),
        .eth_txd         (eth_txd),
        .eth_rst_n       (eth_rst_n),
        .gmii_tx_clk     (gmii_tx_clk_w),
        .udp_tx_start_en (udp_tx_start_en_w),
        .tx_data         (tx_data_w),
        .tx_byte_num     (tx_byte_num_w),
        .udp_tx_done     (udp_tx_done_w),
        .tx_req          (tx_req_w),
        .gmii_rx_clk     (gmii_rx_clk_w),
        .rec_pkt_done    (rec_pkt_done_w),
        .rec_en          (rec_en_w),
        .rec_data        (rec_data_w),
        .rec_byte_num    (rec_byte_num_w)
    );

    assign udp_tx_start_en_w = tx_start_en_r;

    //--------------------------------------------------------------------------
    // ★ v3 下行 RX 通路（R2）：厂家栈的 rec_* 原来被 unused_rec 显式丢弃；
    //   v3 用异步 FIFO 送进 clk_eth 域交给 downlink_cmd 解析（§6.1 软件白名单）。
    //
    //   · 厂家 udp_rx 语义（ref_original/eth/udp/udp_rx.v，只读复用）：
    //     rec_en=1 期间 rec_data 逐拍给出有效字节；rec_pkt_done 与**最后一个字节
    //     同拍**拉高 1 拍；rec_byte_num = 本包有效字节数。已过滤目的 IP/协议类型，
    //     不做目的端口过滤 ⇒ 用软件白名单（§6.1）。
    //   · 时钟：写 = gmii_rx_clk（栈内 BUFG），读 = clk_eth（顶层 assign 的
    //     eth_rxc 经另一 BUFG）—— 同频不同 BUFG，按 CDC 规矩走异步 FIFO。
    //   · 包边界：rec_pkt_done 在 gmii_rx_clk 域转成**翻转标志**（1 拍脉冲跨域
    //     可能被同频异相时钟漏采/重采），clk_eth 侧 3 级同步 + 沿检测还原脉冲。
    //     解析器按包头 LEN 计数消费，正常包不依赖该脉冲；它只用于坏包重同步。
    //   · 深度 2048 B ≥ 单包最大 1472 B（§8.2 风险表），溢出计入 o_rx_ovf。
    //--------------------------------------------------------------------------
    wire [7:0]  rxf_rd_data;
    wire        rxf_empty;
    wire        rxf_full_w;

    axis_fifo #(
        .DATA_W (8),
        .DEPTH  (2048),
        .FWFT   (1)
    ) u_rx_fifo (
        .wr_clk     (gmii_rx_clk_w),
        .wr_rst_n   (rst_n_eth),
        .i_wr_en    (rec_en_w),
        .i_wr_data  (rec_data_w),
        .o_full     (rxf_full_w),
        .o_wr_level (),
        .rd_clk     (clk_eth),
        .rd_rst_n   (rst_n_eth),
        .i_rd_en    (i_rx_rd_en),
        .o_rd_data  (rxf_rd_data),
        .o_empty    (rxf_empty),
        .o_rd_level ()
    );

    // RX FIFO 溢出计数（gmii_rx_clk 域）
    reg [15:0] rx_ovf_cnt;
    always @(posedge gmii_rx_clk_w or negedge rst_n_eth) begin
        if (!rst_n_eth)                     rx_ovf_cnt <= 16'd0;
        else if (rec_en_w && rxf_full_w)    rx_ovf_cnt <= rx_ovf_cnt + 16'd1;
    end
    assign o_rx_ovf = rx_ovf_cnt;

    // 包边界：gmii_rx_clk 域翻转标志 → clk_eth 3 级同步 → 沿检测
    reg        rx_done_tgl;
    reg [2:0]  rx_done_sync;
    reg        rx_done_d;

    always @(posedge gmii_rx_clk_w or negedge rst_n_eth) begin
        if (!rst_n_eth) rx_done_tgl <= 1'b0;
        else if (rec_pkt_done_w) rx_done_tgl <= ~rx_done_tgl;
    end

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            rx_done_sync <= 3'b000;
            rx_done_d    <= 1'b0;
        end
        else begin
            rx_done_sync <= {rx_done_sync[1:0], rx_done_tgl};
            rx_done_d    <= rx_done_sync[2];
        end
    end

    assign o_rx_pkt_done = rx_done_sync[2] ^ rx_done_d;
    assign o_rx_rd_valid = ~rxf_empty;
    assign o_rx_rd_data  = rxf_rd_data;

endmodule
