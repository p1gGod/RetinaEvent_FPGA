//==============================================================================
// event_sink -- 事件去向分发（L3）
//
// 规格：retina_event/docs/子模块设计/L3_L4_集成/event_sink.md
//
// 职责：
//   1. 把 retina_core 出来的 EVS 事件流经 **CDC-3**（异步 FIFO）送到 clk_eth → udp_merge；
//   2. 把统计值经 **CDC-2**（两级同步器，慢变）送到 clk_lcd → hud_panel；
//   3. 把相机原始像素流经 **CDC-RAW**（异步 FIFO）送到 clk_eth → udp_merge 的"原始帧段"；
//   4. 使能门控：`i_cfg_en` 只**关事件支路**（事件不采集、不进 CDC-3、不上行）；
//      原始帧回传**不受它影响**（v3.1 EV_EN 语义，见 B2 的 udp_merge 实例处注释）；
//      显示通路完全不受影响。
//
// ⚠️ 为什么事件必须走 FIFO 而不是 sync_ff：x/y/pol 同时变化，逐位同步会得到错误坐标。
// ⚠️ 为什么统计可以用 sync_ff：每帧才变一次（26.4 Hz），且只是屏上数字，偶发一次中间态无害。
// ⚠️ 相机原始流可选抽帧（udp_merge 的 FRAME_DECIM 参数）。**本工程默认 = 1（不抽帧）**，
//    理由是"上位机模拟处理"必须与板端引擎同一时间基才能 1:1 对照（见下方参数处的 H62 说明）。
//==============================================================================
`timescale 1ns / 1ps

module event_sink #(
    parameter EV_W        = 400,
    parameter EV_H        = 240,
    parameter CDC3_DEPTH  = 1024,       // 事件 FIFO 深度（必须 2 的幂）
    parameter RAW_DEPTH   = 2048,       // 原始像素 FIFO 深度（必须 2 的幂）
    parameter RAW_CHUNK   = 1280,       // 每包原始段字节数（< MTU）
    // ------------------------------------------------------------------------
    // ★★ H62 选项 (a)（2026-10-07，用户裁决）：**原始帧不抽帧**，让"上位机模拟处理"
    //    与板端引擎跑在**同一个时间基**上。
    //
    //    为什么必须这样：板端事件链挂在 cam_tap 上，跑**每一个相机帧**（26.4 fps）；
    //    而网关的 HostEventProcessor 只能在**收到的原始帧**之间做差分。
    //    原来 FRAME_DECIM=8 ⇒ 上位机的 ΔL 是"相隔 8 个相机帧（≈300 ms）"的差分，
    //    比板端（相隔 1 帧，37.9 ms）大好几倍 ⇒ **同一组 (θ, 守卫) 在两边不是同一件事**，
    //    用户按上位机调出来的档位搬到板子上视觉上不会一样（实测比值 ≈ 4.8，
    //    见 docs/05_experiments 的相机通路修复记录与事实登记册 H62）。
    //
    //    =1 之后两边**逐帧同源**，(θ, 守卫) 可 1:1 通用，"上位机模拟处理"才真正是
    //    同构对照而不是另一种算法。
    //
    //    代价（已实测，不是估算）：回传带宽 ×8 —— 600 块/帧 × 1295 B × 26.4 fps
    //    ≈ **20.5 MB/s / 164 Mbps**（1 GbE 装得下，RTL 发送侧占空 ≈ 21%）。
    //    风险在网关/UI 侧的收包与推流，所以改完必须看 pps / idxGap / crcFail /
    //    framesSeen 是否仍然健康。要退回省流模式把这里改回 8 即可（只影响回传，
    //    **不影响板端事件链**）。
    // ------------------------------------------------------------------------
    parameter FRAME_DECIM = 1,          // 原始帧抽帧比（1 = 每帧都回传，两边同一时间基）
    parameter WIRE_VER    = 3,          // ★ v3：线协议版本（2 = v2 13B 包头，回退开关）
    parameter CDC2_STAGES = 2
)(
    // ---------------- cam_pclk 域：相机原始像素（只读 tap）----------------
    input  wire         cam_pclk,
    input  wire         rst_n_pclk,
    input  wire         i_raw_valid,
    input  wire [15:0]  i_raw_data,
    // ★ SEAM-LINKDROP-20261017：帧首像素 1 拍 marker（与 i_raw_data 同拍、同 cam_pclk 域）
    //   它跟着像素一起进 CDC-RAW FIFO 的第 17 bit ⇒ 读侧拿到的 marker 与像素
    //   严格保持源侧相对顺序，任何丢像素/丢包之后 udp_merge 都能重新对齐帧相位。
    input  wire         i_raw_frame_start,

    // ---------------- clk_cam 域：事件流 + 统计 ----------------
    input  wire         clk_cam,
    input  wire         rst_n_cam,
    input  wire         i_ev_valid,
    input  wire [8:0]   i_ev_x,
    input  wire [7:0]   i_ev_y,
    input  wire         i_ev_pol,
    input  wire [23:0]  i_stat_ev_per_frame,
    input  wire [15:0]  i_stat_activity_q16,
    input  wire [23:0]  i_stat_cr_x10,
    input  wire [31:0]  i_stat_frame_cnt,
    input  wire [31:0]  i_stat_ev_total,
    input  wire         i_cfg_en,           // 事件支路总使能

    // ---------------- clk_eth 域：打包上行 ----------------
    input  wire         clk_eth,
    input  wire         rst_n_eth,
    input  wire         i_tx_ready,         // eth_udp 反压（ETH_EN=0 时由顶层接 1'b1）
    // ★ v3：三模式 / 时间戳 / 运行时参数 / 下行 CTRL 通路（全部 clk_eth 域）
    input  wire [1:0]   i_mode,             // 0=RAW_EV 1=RAW_ONLY 2=EV_ONLY
    input  wire [47:0]  i_ts_us,            // 对齐后 48bit µs（ts_gen）
    input  wire         i_ts_valid,
    input  wire         i_ts_calibrated,
    input  wire         i_ev_en,            // v3.1 EV_EN
    input  wire [7:0]   i_frame_decim,      // 运行时抽帧比（SET_PARAM tag 0x03）
    input  wire [23:0]  i_ev_flush_cyc,     // 运行时事件看门狗（SET_PARAM tag 0x04）
    // ★ M4b：动作字节（VALID|CONF|CLASS），由 act_state_cdc 锁存后送入，直通 udp_merge
    input  wire [7:0]   i_act_byte,
    input  wire         i_ctrl_wr_en,       // 下行 CTRL 包推送（downlink_cmd）
    input  wire [7:0]   i_ctrl_data,
    input  wire         i_ctrl_commit,
    output wire         o_ctrl_empty,       // 1 = 构包器可写下一包
    output wire [15:0]  o_frame_idx,        // 当前帧序号（心跳/GET_STATUS）
    output wire         o_tx_start,
    output wire [7:0]   o_tx_byte,
    output wire         o_tx_byte_en,
    output wire [15:0]  o_tx_len,
    output wire [15:0]  o_stat_drop_px,
    output wire [15:0]  o_stat_drop_ev,
    output wire [15:0]  o_stat_ev_fifo_ovf,

    // ---------------- clk_lcd 域：CDC-2 后的统计（给 HUD）----------------
    input  wire         clk_lcd,
    input  wire         rst_n_lcd,
    output wire [23:0]  o_stat_ev_per_frame_lcd,
    output wire [15:0]  o_stat_activity_q16_lcd,
    output wire [23:0]  o_stat_cr_x10_lcd,
    output wire [31:0]  o_stat_frame_cnt_lcd,

    // ---------------- 调试引出（clk_cam 原始事件流）----------------
    output wire [8:0]   o_ev_dbg_x,
    output wire [7:0]   o_ev_dbg_y,
    output wire         o_ev_dbg_valid
);

    localparam EVF_AW  = $clog2(CDC3_DEPTH);
    localparam RAWF_AW = $clog2(RAW_DEPTH);

    // ========================================================================
    // B5: 调试引出（原样）
    // ========================================================================
    assign o_ev_dbg_x     = i_ev_x;
    assign o_ev_dbg_y     = i_ev_y;
    assign o_ev_dbg_valid = i_ev_valid & i_cfg_en;

    // ========================================================================
    // B1 + B2: CDC-3 —— 事件流 clk_cam → clk_eth（异步 FIFO，携带 x/y/pol）
    // ========================================================================
    wire             evf_full;
    wire [EVF_AW:0]  evf_wr_level;
    wire [17:0]      evf_rd_data;
    wire             evf_empty;
    wire [EVF_AW:0]  evf_rd_level;

    wire ev_wr_en = i_ev_valid & i_cfg_en;

    axis_fifo #(
        .DATA_W (18),
        .DEPTH  (CDC3_DEPTH),
        .FWFT   (1)
    ) u_cdc3_fifo (
        .wr_clk     (clk_cam),
        .wr_rst_n   (rst_n_cam),
        .i_wr_en    (ev_wr_en & ~evf_full),
        .i_wr_data  ({i_ev_x, i_ev_y, i_ev_pol}),
        .o_full     (evf_full),
        .o_wr_level (evf_wr_level),
        .rd_clk     (clk_eth),
        .rd_rst_n   (rst_n_eth),
        .i_rd_en    (~evf_empty),
        .o_rd_data  (evf_rd_data),
        .o_empty    (evf_empty),
        .o_rd_level (evf_rd_level)
    );

    reg [15:0] ev_ovf_cnt;
    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        ev_ovf_cnt <= 16'd0;
        else if (ev_wr_en && evf_full)         ev_ovf_cnt <= ev_ovf_cnt + 16'd1;
    end
    assign o_stat_ev_fifo_ovf = ev_ovf_cnt;

    // ========================================================================
    // CDC-RAW —— 相机原始像素 cam_pclk → clk_eth（异步 FIFO）
    // ========================================================================
    wire             rawf_full;
    wire [RAWF_AW:0] rawf_wr_level;
    wire [16:0]      rawf_rd_data;      // ★ 17 bit = {帧首 marker, 像素[15:0]}
    wire             rawf_empty;
    wire [RAWF_AW:0] rawf_rd_level;

    // ★ SEAM-LINKDROP-20261017：raw FIFO 由 16 bit 扩到 17 bit —— 把"每帧首像素"这个
    //   1 bit marker **和像素塞进同一个 FIFO**，而不是另走一根脉冲线。
    //   为什么：另走脉冲在 CDC 里与像素是两条独立路径，丢包/反压时无法保证"marker 落在
    //   正确的像素之前"；同一 FIFO 里读写指针天然对齐，顺序不可能错。
    //   代价：FIFO 每字多 1 bit + 读侧多一个 mux 抽头（BRAM 位宽从 16→17，深度不变）。
    axis_fifo #(
        .DATA_W (17),
        .DEPTH  (RAW_DEPTH),
        .FWFT   (1)
    ) u_cdc_raw_fifo (
        .wr_clk     (cam_pclk),
        .wr_rst_n   (rst_n_pclk),
        .i_wr_en    (i_raw_valid & ~rawf_full),
        .i_wr_data  ({i_raw_frame_start, i_raw_data}),
        .o_full     (rawf_full),
        .o_wr_level (rawf_wr_level),
        .rd_clk     (clk_eth),
        .rd_rst_n   (rst_n_eth),
        .i_rd_en    (~rawf_empty),
        .o_rd_data  (rawf_rd_data),
        .o_empty    (rawf_empty),
        .o_rd_level (rawf_rd_level)
    );

    // ========================================================================
    // 打包器（统一 UDP 负载：原始段 + 事件段，固定 1280 B 分包，不超 MTU）
    // ========================================================================
    // udp_merge 的输入是"有效即取"语义 ⇒ 用窗口把 FIFO 的 FWFT 输出转成 1 拍脉冲
    //（FWFT：!empty 时数据已有效；这里每拍取一个，正是连续流式的语义）
    // ⚠️ 必须先声明后使用（Verilog 不允许先引用后声明）
    wire rawf_rd_data_valid = ~rawf_empty;
    wire evf_rd_data_valid  = ~evf_empty;

    // ★ SEAM-LINKDROP-20261017：拆出 marker 与像素（marker 只在帧首像素那一拍为 1）
    wire        rawf_marker = rawf_rd_data[16];
    wire [15:0] rawf_pix    = rawf_rd_data[15:0];

    wire [8:0] evf_x   = evf_rd_data[17:9];
    wire [7:0] evf_y   = evf_rd_data[8:1];
    wire       evf_pol = evf_rd_data[0];

    udp_merge #(
        .WIRE_VER     (WIRE_VER),
        .RAW_CHUNK    (RAW_CHUNK),
        .FRAME_DECIM  (FRAME_DECIM),
        .IMG_W        (800),
        .IMG_H        (480),
        .MAX_PAYLOAD  (1472)
    ) u_udp_merge (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n_eth),
        .i_raw_valid    (rawf_rd_data_valid),
        .i_raw_data     (rawf_pix),
        .i_raw_frame_start (rawf_marker),       // ★ SEAM-LINKDROP（帧首像素 marker）
        .i_ev_valid     (evf_rd_data_valid),
        .i_ev_x         (evf_x),
        .i_ev_y         (evf_y),
        .i_ev_pol       (evf_pol),
        .i_tx_ready     (i_tx_ready),           // ★ 实测修复：原为 1'b1 ⇒ 每包静默丢失
        // ⚠️⚠️ 修复 P0-STALL-20261012（停流根因，见 docs/05_experiments/停流修复_20261012）：
        //     此处**必须恒 1'b1**（= 上行回传使能恒定开），不能再接 `i_cfg_en`。
        //   原接线 `i_cfg_en` = top 的 cfg_ev_en = "事件支路使能"。而 udp_merge 的
        //   i_cfg_en 是**整个上行回传的硬门**（pkt_go = ... & i_cfg_en），两者语义
        //   不同名同义：v3 期间 cfg_ev_en 恒 1 所以看不出，v3.1 起 EV_EN 命令
        //   （0x05）接管 cfg_ev_en ⇒ **一条 `EV_EN=0` 就把原画回传也一起关死**
        //   （现场 2026-10-12 22:18:14：EV_EN=0 后原画全停、心跳照发、只能重烧复活）。
        //   EV_EN 的规范语义（udp_merge.i_ev_en 端口注释）："0 = 不采集/不上行事件
        //   （原始回传不受影响）" ⇒ 事件支路门控**只走 i_ev_en 与本模块的 ev_wr_en**，
        //   不得触碰上行门。若日后确需"一键停回传"，请另加独立 RGS 位，勿复用 EV_EN。
        .i_cfg_en       (1'b1),                 // ★ 修复点（P0-STALL-20261012）
        // ---- v3 ----
        .i_mode         (i_mode),
        .i_ts_us        (i_ts_us),
        .i_ts_valid     (i_ts_valid),
        .i_ts_calibrated(i_ts_calibrated),
        .i_ev_en        (i_ev_en),
        .i_frame_decim  (i_frame_decim),
        .i_ev_flush_cyc (i_ev_flush_cyc),
        .i_act_byte     (i_act_byte),           // ★ M4b：byte23 来源（每帧锁存）
        .i_ctrl_wr_en   (i_ctrl_wr_en),
        .i_ctrl_data    (i_ctrl_data),
        .i_ctrl_commit  (i_ctrl_commit),
        .o_ctrl_empty   (o_ctrl_empty),
        .o_frame_idx    (o_frame_idx),
        .o_tx_start     (o_tx_start),
        .o_tx_byte      (o_tx_byte),
        .o_tx_byte_en   (o_tx_byte_en),
        .o_tx_len       (o_tx_len),
        .o_stat_drop_px (o_stat_drop_px),
        .o_stat_drop_ev (o_stat_drop_ev)
    );

    // ========================================================================
    // B3: CDC-2 —— 统计值 clk_cam → clk_lcd（慢变，两级同步器即可）
    // ========================================================================
    sync_ff #(.WIDTH(24), .STAGES(CDC2_STAGES)) u_sync_ev_pf (
        .dest_clk   (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src      (i_stat_ev_per_frame), .o_dst (o_stat_ev_per_frame_lcd)
    );
    sync_ff #(.WIDTH(16), .STAGES(CDC2_STAGES)) u_sync_act (
        .dest_clk   (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src      (i_stat_activity_q16), .o_dst (o_stat_activity_q16_lcd)
    );
    sync_ff #(.WIDTH(24), .STAGES(CDC2_STAGES)) u_sync_cr (
        .dest_clk   (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src      (i_stat_cr_x10), .o_dst (o_stat_cr_x10_lcd)
    );
    sync_ff #(.WIDTH(32), .STAGES(CDC2_STAGES)) u_sync_fcnt (
        .dest_clk   (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src      (i_stat_frame_cnt), .o_dst (o_stat_frame_cnt_lcd)
    );

endmodule
