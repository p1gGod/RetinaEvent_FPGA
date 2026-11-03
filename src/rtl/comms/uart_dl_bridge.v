//==============================================================================
// uart_dl_bridge.v —— 串口 ↔ 下行解析器桥（WIRE-U1 §3.7/§7.1；R1/R4 交点）
//
// 作用（两条 CDC 通路 + 一个字节级合流器）：
//   ① CTRL 出（clk_eth → clk_cam）：downlink_cmd 构好的 v3 CTRL 包字节流
//      （o_ctrl_wr_en/o_ctrl_data + o_ctrl_commit）打包进 9 bit 异步 FIFO
//      （bit8 = 包头结束 token），读侧交给 uart_link 的 CTRL 高优先通路。
//   ② 串口 RX 入（clk_cam → clk_eth）：uart_link 解析出的接收字节进 8 bit 异步
//      FIFO，读侧与以太网 RX 字节流**合流**后送 downlink_cmd —— UDP 与串口
//      **共用同一份解析器**（设计 §7.1，不写第二份）。
//
// 合流规则（字节级，无损）：
//   · 以太网优先（UDP 包是突发，几百字节/包，几微秒排空；串口 115200 下
//     一字节 86.8 µs，不会因等待而丢）；串口字节在以太网空闲的拍上取。
//   · 两个 FIFO 都是 FWFT：o_rd_data 与 o_empty=0 同拍有效；本模块把
//     "呈现的字节"与"对应 FIFO 的读使能"严格同拍对齐 ⇒ 不吞字节、不重复。
//   · o_dl_stream 标记本拍字节来自串口（downlink_cmd 用它切换"逐字节重同步"
//     语义）；以太网包尾脉冲在串口字节被服务后的 4 拍内屏蔽，避免打断
//     串口在途帧的解析（串口没有包边界概念，设计 §3.7）。
//
// 时钟域：clk_eth（写/读任一侧）与 clk_cam；FIFO 用 L1 原语 axis_fifo。
//==============================================================================
`timescale 1ns / 1ps

module uart_dl_bridge #(
    parameter CTRL_DEPTH = 256,     // CTRL 出 FIFO 深度（一个最大包 82 B + token）
    parameter URX_DEPTH  = 256      // 串口 RX 入 FIFO 深度
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        clk_eth,
    input  wire        rst_n_eth,
    // ---- ① CTRL 出：clk_eth 写侧（downlink_cmd）----
    input  wire        i_ctrl_wr_en,
    input  wire [7:0]  i_ctrl_data,
    input  wire        i_ctrl_commit,   // 包尾（推一个 token）
    output wire        o_ctrl_full,
    output wire        o_ctrl_empty_eth,// CTRL FIFO 空（同步到 clk_eth：开新包的流控门）
    // ---- ① CTRL 出：clk_cam 读侧（uart_link）----
    input  wire        i_ctrl_rd_en,
    output wire        o_ctrl_valid,
    output wire [7:0]  o_ctrl_data,
    output wire        o_ctrl_eop,      // 头字节是包尾 token（不作为数据发送）
    // ---- ② 串口 RX 入：clk_cam 写侧（uart_link）----
    input  wire        i_urx_valid,
    input  wire [7:0]  i_urx_data,
    output wire        o_urx_ack,
    // ---- ② 合流：clk_eth 侧（以太网 RX 入 / 解析器出）----
    input  wire        i_eth_valid,
    input  wire [7:0]  i_eth_data,
    output wire        o_eth_rd_en,
    input  wire        i_eth_pkt_done,
    output wire        o_dl_valid,
    output wire [7:0]  o_dl_data,
    output wire        o_dl_stream,     // 1 = 本拍字节来自串口
    output wire        o_dl_pkt_done,
    // ---- 统计 ----
    output reg  [15:0] o_stat_urx_ovf,  // 串口 RX FIFO 满（clk_cam 域计数）
    output reg  [15:0] o_stat_ctrl_ovf  // CTRL FIFO 满（clk_eth 域计数）
);

    //==========================================================================
    // ① CTRL 出 FIFO（9 bit：{token, byte}）
    //==========================================================================
    wire [8:0] ctrl_rdata;
    wire       ctrl_empty;
    wire       ctrl_full_w;
    wire       ctrl_wr = i_ctrl_commit | i_ctrl_wr_en;
    wire [8:0] ctrl_wd = i_ctrl_commit ? 9'h100 : {1'b0, i_ctrl_data};

    axis_fifo #(
        .DATA_W (9),
        .DEPTH  (CTRL_DEPTH),
        .FWFT   (1)
    ) u_ctrl_fifo (
        .wr_clk     (clk_eth),
        .wr_rst_n   (rst_n_eth),
        .i_wr_en    (ctrl_wr),
        .i_wr_data  (ctrl_wd),
        .o_full     (ctrl_full_w),
        .o_wr_level (),
        .rd_clk     (clk_cam),
        .rd_rst_n   (rst_n_cam),
        .i_rd_en    (i_ctrl_rd_en),
        .o_rd_data  (ctrl_rdata),
        .o_empty    (ctrl_empty),
        .o_rd_level ()
    );

    assign o_ctrl_full  = ctrl_full_w;
    assign o_ctrl_valid = ~ctrl_empty;
    assign o_ctrl_data  = ctrl_rdata[7:0];
    assign o_ctrl_eop   = ctrl_rdata[8];

    // CTRL FIFO 空 → clk_eth（clk_eth 用它做"能否开新 CTRL 包"的流控门；
    // 该门只防溢出，滞后一两个包不会破坏协议——包间以 token 分界）
    reg ctrl_empty_s1, ctrl_empty_s2;

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            ctrl_empty_s1 <= 1'b1;
            ctrl_empty_s2 <= 1'b1;
        end
        else begin
            ctrl_empty_s1 <= ctrl_empty;
            ctrl_empty_s2 <= ctrl_empty_s1;
        end
    end

    assign o_ctrl_empty_eth = ctrl_empty_s2;

    // CTRL 溢出计数（clk_eth；满时写入被 FIFO 丢弃 ⇒ 该包不完整，主机 CRC 兜底）
    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth)                          o_stat_ctrl_ovf <= 16'd0;
        else if (ctrl_wr && ctrl_full_w)          o_stat_ctrl_ovf <= o_stat_ctrl_ovf + 16'd1;
    end

    //==========================================================================
    // ② 串口 RX 入 FIFO（8 bit）
    //==========================================================================
    wire [7:0] urx_rdata;
    wire       urx_empty;
    wire       urx_full;
    wire       urx_rd_en;

    axis_fifo #(
        .DATA_W (8),
        .DEPTH  (URX_DEPTH),
        .FWFT   (1)
    ) u_urx_fifo (
        .wr_clk     (clk_cam),
        .wr_rst_n   (rst_n_cam),
        .i_wr_en    (i_urx_valid),
        .i_wr_data  (i_urx_data),
        .o_full     (urx_full),
        .o_wr_level (),
        .rd_clk     (clk_eth),
        .rd_rst_n   (rst_n_eth),
        .i_rd_en    (urx_rd_en),
        .o_rd_data  (urx_rdata),
        .o_empty    (urx_empty),
        .o_rd_level ()
    );

    // clk_cam 侧溢出计数（满时 uart_link 侧收不到 ack ⇒ 自行丢弃并计数）
    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam)                     o_stat_urx_ovf <= 16'd0;
        else if (i_urx_valid && urx_full)   o_stat_urx_ovf <= o_stat_urx_ovf + 16'd1;
    end

    assign o_urx_ack = i_urx_valid && !urx_full;

    //==========================================================================
    // ② 合流：以太网优先，串口补空；同拍对齐"呈现字节 ↔ 读使能"
    //==========================================================================
    wire eth_take = i_eth_valid;                    // FWFT：!empty 即有效
    wire urx_take = (!eth_take) && (!urx_empty);

    assign o_dl_valid  = eth_take | urx_take;
    assign o_dl_data   = eth_take ? i_eth_data : urx_rdata;
    assign o_eth_rd_en = eth_take;                  // 消费本拍呈现的以太网字节
    assign urx_rd_en   = urx_take;                  // 消费本拍呈现的串口字节
    assign o_dl_stream = urx_take;                  // downlink_cmd.i_rx_stream

    // 串口字节刚被服务的 4 拍内屏蔽以太网包尾脉冲（保护串口在途帧）
    reg [2:0] urx_recent;

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth)          urx_recent <= 3'd0;
        else if (urx_take)       urx_recent <= 3'd4;
        else if (urx_recent != 3'd0) urx_recent <= urx_recent - 3'd1;
    end

    assign o_dl_pkt_done = i_eth_pkt_done && (urx_recent == 3'd0);

endmodule
