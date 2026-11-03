//==============================================================================
// tb_stall_repro.v —— ★ P0 停流复现 TB（2026-10-12 现场突发 22:18 的命令序列回放）
//
// 【为什么有这个 TB】
//   2026-10-12 22:18:14 经网关连发 5 条命令后，板端**上行原画流全停**（≥3.5 min 不自愈）；
//   22:18:33-36 的 8 条 GET_STATUS 仍全 OK；JTAG 重烧同一位流可复活（P0 验收报告 §4.7）。
//   本 TB 用**与现场同一条命令序列**（opcode/SEQ 逐条一致）在 RTL 级回放。
//
// 【被测链路】与 top_retina_event 的 B2/B5.1/B5.2/B6 同构（全部真实 RTL）：
//   TB 造下行字节流 → downlink_cmd（125 MHz，RX 侧直接灌；eth_udp 的 RX FIFO 通路
//        由 tb_eth_udp 覆盖，且现场已证"命令侧完好"）
//      → toggle+值 CDC（sync_ff）→ sys_ctrl（50 MHz）
//      → cfg_ev_en / cfg_mode 回 CDC → ★ event_sink（真实模块：使能门控 + CDC-RAW/CDC-3
//        + udp_merge 打包）→ eth_udp（真实握手/反压/MTU 截断）+ eth_top 行为级替身
//   ★ 本 TB **不改一行**：停流相关的门控逻辑在 event_sink / udp_merge 内，修复前后
//     TB 完全一致（判据才成立）。
//
// 【现场命令序列（raw/rpc_after_burn.txt 原文）】
//   22:18:10 GET_STATUS seq=2 / 22:18:12 GET_STATUS seq=3 / 22:18:12 EV_EN=1 seq=4
//   22:18:14 EV_EN=0 seq=5 / 22:18:14 SET_PARAM theta=44 seq=6
//   22:18:33..36 GET_STATUS seq=7..14（8 条）
//   ⚠️ 时序压缩：现场命令间隔约 2 s；本 TB 用 20 µs（1:1e5）。数据面没有秒级状态
//      （唯一秒级量 = 心跳计数器，TB 已缩为 0.1 ms），故压缩不改语义。
//
// 【判据】
//   A1 基线：命令前回传原始段 ≥ 100                          —— "停流前是好的"
//   B1 现场 13 条命令全部 ACK（STATUS=OK、无 BAD_*）          —— 命令通路可用
//   B2 EV_EN=0 的命令被板端 ACK                              —— 命令确已执行（这才是停流诱因）
//   C1 ★停流判据：命令后回传原始段 ≥ 100                     —— 修复前 FAIL = 复现停摆
//   C2 命令后 CTRL 心跳仍出现 ≥ 3 条                         —— 停的是数据面，不是整块板
//   C3 无半包（udp_merge 声明长度 = 实发字节，eth_udp 握手自洽）
//==============================================================================
`timescale 1ns / 1ps

module tb_stall_repro;

    //--------------------------------------------------------------------------
    // 时钟：clk_eth 125 MHz（= eth_rxc）/ clk_cam 50 MHz / clk200 / cam_pclk
    //--------------------------------------------------------------------------
    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    reg clk200  = 1'b0;
    reg cam_pclk= 1'b0;
    always #4   clk_eth  = ~clk_eth;
    always #10  clk_cam  = ~clk_cam;
    always #2.5 clk200   = ~clk200;
    always #3.7 cam_pclk = ~cam_pclk;      // ≈135 MHz（相机像素域代表时钟）

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // 公共线
    //--------------------------------------------------------------------------
    wire [11:0] dl_theta;        wire dl_theta_upd;
    wire [8:0]  dl_min_dl;       wire dl_min_dl_upd;
    wire [1:0]  dl_mode_set;     wire dl_mode_set_upd;
    wire        dl_ev_en;        wire dl_ev_en_upd;
    wire        dl_accepted;
    wire [7:0]  dl_frame_decim;
    wire [23:0] dl_ev_flush_cyc;
    wire        ts_cal_req;      wire [15:0] ts_cal_seq;  wire [47:0] ts_board_ts;
    wire [47:0] ts_local, ts_aligned, ts_offset;   wire [15:0] ts_rtt;
    wire        ts_valid, ts_cal, ts_stale;         wire [31:0] ts_boot_id;
    wire        ts_sync_matched, ts_period_wr, ts_force_cal, ts_off_wr;
    wire [16:0] ts_period_s;     wire [47:0] ts_off_data;
    wire        ctrl_wr_en;      wire [7:0] ctrl_data;  wire ctrl_commit;
    wire        ctrl_empty;
    // ---- 先声明后引用（Verilog-2001：端口连接里的名字不能后声明）----
    wire [1:0]  cfg_mode_eth;    wire cfg_ev_en_eth;
    wire [15:0] udp_drop_px, udp_drop_ev, udp_frame_idx;
    wire        udp_tx_start, udp_tx_byte_en;
    wire [7:0]  udp_tx_byte;
    wire [15:0] udp_tx_len;
    wire        eth_tx_ready;

    //--------------------------------------------------------------------------
    // 1) downlink_cmd（真实 RTL）
    //--------------------------------------------------------------------------
    reg         rx_valid = 1'b0;
    reg  [7:0]  rx_data  = 8'd0;
    reg         rx_done  = 1'b0;

    downlink_cmd #(
        .HEARTBEAT_CYC (32'd12500),      // TB 缩短：0.1 ms（现场 1 s；只改节拍）
        .FW_VER        (16'h0003),
        .WIRE_VER_B    (8'h03)
    ) u_dl (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n),
        .i_rx_valid     (rx_valid),
        .i_rx_data      (rx_data),
        .o_rx_rd_en     (),
        .i_rx_pkt_done  (rx_done),
        .i_rx_stream    (1'b0),
        .i_net_state    (2'd2),
        .i_net_chg      (1'b0),
        .i_ser_drop     (8'h00),
        .i_mode         (cfg_mode_eth),
        .i_ts_us        (ts_aligned),
        .i_ts_local_us  (ts_local),
        .i_ts_offset    (ts_offset),
        .i_ts_valid     (ts_valid),
        .i_ts_calibrated(ts_cal),
        .i_ts_stale     (ts_stale),
        .i_rtt_us       (ts_rtt),
        .i_boot_id      (ts_boot_id),
        .i_frame_idx    (udp_frame_idx),
        .i_drop_px      (udp_drop_px),
        .i_drop_ev      (udp_drop_ev),
        .i_ev_en        (cfg_ev_en_eth),
        .i_act_byte     (8'h00),            // ★ M4b：无动作（TLV 0x92 值 0x00）
        .i_cal_req      (ts_cal_req),
        .i_cal_seq      (ts_cal_seq),
        .i_board_ts     (ts_board_ts),
        .o_sync_matched (ts_sync_matched),
        .o_theta        (dl_theta),
        .o_theta_upd    (dl_theta_upd),
        .o_min_dl       (dl_min_dl),
        .o_min_dl_upd   (dl_min_dl_upd),
        .o_mode_set     (dl_mode_set),
        .o_mode_set_upd (dl_mode_set_upd),
        .o_ev_en        (dl_ev_en),
        .o_ev_en_upd    (dl_ev_en_upd),
        .o_frame_decim  (dl_frame_decim),
        .o_ev_flush_cyc (dl_ev_flush_cyc),
        .o_ev_res       (),
        .o_ev_res_upd   (),
        .o_ser_decim    (),
        .o_ser_decim_upd(),
        .o_ser_agg      (),
        .o_ser_agg_upd  (),
        .o_ser_flush_ms (),
        .o_ser_flush_upd(),
        .o_ser_baud_sel   (),      // ★ WIRE-U2：切档通路本 TB 不测（tb_uart_baud 专测）
        .o_ser_baud_commit(),
        .o_dl_accepted  (dl_accepted),
        .o_period_wr    (ts_period_wr),
        .o_period_s     (ts_period_s),
        .o_force_cal    (ts_force_cal),
        .o_off_wr       (ts_off_wr),
        .o_off_data     (ts_off_data),
        .o_ctrl_wr_en   (ctrl_wr_en),
        .o_ctrl_data    (ctrl_data),
        .o_ctrl_commit  (ctrl_commit),
        .i_ctrl_empty   (ctrl_empty),
        .o_stat_dl_crc_fail  (),
        .o_stat_dl_bad_opcode(),
        .o_stat_dl_reject    ()
    );

    //--------------------------------------------------------------------------
    // 2) ts_gen（真实 RTL，日程缩短）
    //--------------------------------------------------------------------------
    ts_gen #(
        .CLK_DIV          (125),
        .FIRST_CAL_US     (48'd1500),
        .CAL_PERIOD_S     (17'd600),
        .RETRY_GAP0_US    (48'd40),
        .RETRY_GAP1_US    (48'd60),
        .RETRY_GAP2_US    (48'd80),
        .STALE_BACKOFF_US (48'd300),
        .RETRY_N          (16'd3),
        .BOOT_ID          (32'h5254_4E41)
    ) u_ts (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n),
        .i_off_wr_en    (ts_off_wr),
        .i_off_data     (ts_off_data),
        .i_period_wr_en (ts_period_wr),
        .i_period_s     (ts_period_s),
        .i_force_cal    (ts_force_cal),
        .i_sync_matched (ts_sync_matched),
        .o_cal_req      (ts_cal_req),
        .o_cal_seq      (ts_cal_seq),
        .o_board_ts_us  (ts_board_ts),
        .o_ts_local_us  (ts_local),
        .o_ts_aligned_us(ts_aligned),
        .o_ts_valid     (ts_valid),
        .o_ts_calibrated(ts_cal),
        .o_ts_stale     (ts_stale),
        .o_offset_reg   (ts_offset),
        .o_rtt_us       (ts_rtt),
        .o_boot_id      (ts_boot_id)
    );

    //--------------------------------------------------------------------------
    // 3) toggle+值 CDC（clk_eth → clk_cam，照抄 top）
    //--------------------------------------------------------------------------
    wire [11:0] theta_set_cam;  wire theta_set_cam_upd;
    wire [8:0]  min_dl_set_cam; wire min_dl_set_cam_upd;
    wire [1:0]  mode_set_cam;   wire mode_set_cam_upd;
    wire        ev_en_set_cam;  wire ev_en_set_cam_upd;
    sync_ff #(.WIDTH(12), .STAGES(2)) u_s1 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_theta),     .o_dst(theta_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s2 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_theta_upd), .o_dst(theta_set_cam_upd));
    sync_ff #(.WIDTH(9),  .STAGES(2)) u_s3 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_min_dl),    .o_dst(min_dl_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s4 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_min_dl_upd),.o_dst(min_dl_set_cam_upd));
    sync_ff #(.WIDTH(2),  .STAGES(2)) u_s5 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_mode_set),  .o_dst(mode_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s6 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_mode_set_upd), .o_dst(mode_set_cam_upd));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s7 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_en),     .o_dst(ev_en_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s8 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_en_upd), .o_dst(ev_en_set_cam_upd));

    //--------------------------------------------------------------------------
    // 4) sys_ctrl（真实 RTL；键悬空 = 无按键）
    //--------------------------------------------------------------------------
    wire       cfg_disp_mode;  wire [1:0] cfg_mode;
    wire [1:0] cfg_theta_sel;  wire [3:0] cfg_layer_en;
    wire       cfg_ev_en;      wire [11:0] cfg_theta;
    wire [8:0] cfg_min_dl;     wire stat_mode;
    wire [3:0] key_pressed;

    sys_ctrl #(
        .CLK_FREQ_HZ (1000),
        .DEBOUNCE_MS (100)   // ⚠️ 不可缩到 1：CNT_MAX=1 会把"复位释放时 key_sync 的
                             //    2 拍暂态 0"当成一次真实按键按下（key_fall[3] 触发
                             //    ⇒ o_mode 误进 EV_ONLY）。实板 CNT_MAX=50,000 不会。
                             //    本 TB 用 100 拍消抖，既快又能滤掉该暂态。
    ) u_sc (
        .clk_cam         (clk_cam),
        .rst_n_cam       (rst_n),
        .i_key           (4'b1111),
        .i_mode_set_val  (mode_set_cam),
        .i_mode_set_upd  (mode_set_cam_upd),
        .i_theta_set_val (theta_set_cam),
        .i_theta_set_upd (theta_set_cam_upd),
        .i_min_dl_set_val(min_dl_set_cam),
        .i_min_dl_set_upd(min_dl_set_cam_upd),
        .i_ev_en_set_val (ev_en_set_cam),
        .i_ev_en_set_upd (ev_en_set_cam_upd),
        .i_ev_res_set_val    (2'd0),
        .i_ev_res_set_upd    (1'b0),
        .i_ser_decim_set_val (8'd32),
        .i_ser_decim_set_upd (1'b0),
        .i_ser_agg_set_val   (2'd0),
        .i_ser_agg_set_upd   (1'b0),
        .i_ser_flush_set_val (16'd20),
        .i_ser_flush_set_upd (1'b0),
        .o_cfg_disp_mode (cfg_disp_mode),
        .o_mode          (cfg_mode),
        .o_cfg_theta_sel (cfg_theta_sel),
        .o_cfg_layer_en  (cfg_layer_en),
        .o_cfg_ev_en     (cfg_ev_en),
        .o_cfg_theta     (cfg_theta),
        .o_cfg_min_dl    (cfg_min_dl),
        .o_stat_mode     (stat_mode),
        .o_key_pressed   (key_pressed),
        .o_ev_res        (),
        .o_ser_decim     (),
        .o_ser_agg       (),
        .o_ser_flush_ms  ()
    );

    // ---- 模式/事件使能回跨域（clk_cam → clk_eth，照抄 top）----
    sync_ff #(.WIDTH(2), .STAGES(2)) u_r1 (.dest_clk(clk_eth), .dest_rst_n(rst_n),
        .i_src(cfg_mode),  .o_dst(cfg_mode_eth));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_r2 (.dest_clk(clk_eth), .dest_rst_n(rst_n),
        .i_src(cfg_ev_en), .o_dst(cfg_ev_en_eth));

    //--------------------------------------------------------------------------
    // 5) ★ event_sink（真实 RTL：使能门控 + CDC-RAW/CDC-3 + udp_merge）
    //    唯一被"改造"的是厂家以太网栈用 eth_top_sim_model.v（行为级替身）
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg         ev_valid  = 1'b0;
    reg  [8:0]  ev_x      = 9'd0;
    reg  [7:0]  ev_y      = 8'd0;
    reg         ev_pol    = 1'b0;

    event_sink #(
        .EV_W      (400),
        .EV_H      (240),
        .RAW_CHUNK (1280),
        .FRAME_DECIM (1),
        .WIRE_VER  (3)
    ) u_sink (
        .cam_pclk       (cam_pclk),
        .rst_n_pclk     (rst_n),
        .i_raw_valid    (raw_valid),
        .i_raw_data     (raw_data),
        .i_raw_frame_start(1'b0),      // ★ SEAM-LINKDROP：本 TB 走 legacy（自己数帧首）路径
        .clk_cam        (clk_cam),
        .rst_n_cam      (rst_n),
        .i_ev_valid     (ev_valid),
        .i_ev_x         (ev_x),
        .i_ev_y         (ev_y),
        .i_ev_pol       (ev_pol),
        .i_stat_ev_per_frame (24'd0),
        .i_stat_activity_q16 (16'd0),
        .i_stat_cr_x10  (24'd0),
        .i_stat_frame_cnt (32'd0),
        .i_stat_ev_total (32'd0),
        .i_cfg_en       (cfg_ev_en),        // ★ 与 top 逐字一致：事件支路总使能
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n),
        .i_tx_ready     (eth_tx_ready),     // ★ eth_udp 反压
        .i_mode         (cfg_mode_eth),
        .i_ts_us        (ts_aligned),
        .i_ts_valid     (ts_valid),
        .i_ts_calibrated(ts_cal),
        .i_ev_en        (cfg_ev_en_eth),
        .i_frame_decim  (dl_frame_decim),
        .i_ev_flush_cyc (dl_ev_flush_cyc),
        .i_act_byte     (8'h00),            // ★ M4b：无动作
        .i_ctrl_wr_en   (ctrl_wr_en),
        .i_ctrl_data    (ctrl_data),
        .i_ctrl_commit  (ctrl_commit),
        .o_ctrl_empty   (ctrl_empty),
        .o_frame_idx    (udp_frame_idx),
        .o_tx_start     (udp_tx_start),
        .o_tx_byte      (udp_tx_byte),
        .o_tx_byte_en   (udp_tx_byte_en),
        .o_tx_len       (udp_tx_len),
        .o_stat_drop_px (udp_drop_px),
        .o_stat_drop_ev (udp_drop_ev),
        .o_stat_ev_fifo_ovf (),
        .clk_lcd        (clk_cam),
        .rst_n_lcd      (rst_n),
        .o_stat_ev_per_frame_lcd (),
        .o_stat_activity_q16_lcd (),
        .o_stat_cr_x10_lcd       (),
        .o_stat_frame_cnt_lcd    (),
        .o_ev_dbg_x     (),
        .o_ev_dbg_y     (),
        .o_ev_dbg_valid ()
    );

    //--------------------------------------------------------------------------
    // 6) eth_udp（真实 RTL：TX 握手 / 反压 / MTU 截断）+ eth_top 行为级替身
    //--------------------------------------------------------------------------
    eth_udp #(
        .BOARD_MAC  (48'h00_11_22_33_44_55),
        .BOARD_IP   ({8'd192,8'd168,8'd1,8'd10}),
        .PC_IP      ({8'd192,8'd168,8'd1,8'd102}),
        .PC_MAC     (48'hff_ff_ff_ff_ff_ff),
        .MAX_TX_LEN (16'd1472),
        .BUF_BYTES  (2048)
    ) u_eth (
        .clk_eth      (clk_eth),
        .rst_n_eth    (rst_n),
        .clk_ref_200m (clk200),
        .eth_rxc      (clk_eth),
        .eth_rx_ctl   (1'b0),
        .eth_rxd      (4'b0000),
        .eth_txc      (),
        .eth_tx_ctl   (),
        .eth_txd      (),
        .eth_rst_n    (),
        .i_tx_start   (udp_tx_start),
        .i_tx_byte    (udp_tx_byte),
        .i_tx_byte_en (udp_tx_byte_en),
        .i_tx_len     (udp_tx_len),
        .o_tx_ready   (eth_tx_ready),
        .o_rx_rd_valid(),
        .o_rx_rd_data (),
        .i_rx_rd_en   (1'b1),
        .o_rx_pkt_done(),
        .o_rx_ovf     ()
    );

    //--------------------------------------------------------------------------
    // 7) 原始像素源（cam_pclk 域，800×480 连续帧）
    //    真实相机 ≈11.4 M px/s；此处刻意灌满（1 px/clk）以压缩仿真时间：
    //    停流机理（使能门控 / 抽帧计数）与时基无关，只与"帧是否推进"有关。
    //--------------------------------------------------------------------------
    integer px_in_frame = 0;
    reg  [15:0] px_seed = 16'h1234;

    always @(posedge cam_pclk) begin
        raw_valid <= 1'b1;
        raw_data  <= px_seed;
        px_seed   <= px_seed + 16'h0101;
        if (px_in_frame == (800*480 - 1)) px_in_frame = 0;
        else                              px_in_frame = px_in_frame + 1;
    end

    // ---- 事件源（clk_cam 域）：每 500 拍一个事件 ----
    integer ev_tick = 0;
    reg [8:0] ev_xc = 9'd0;
    always @(posedge clk_cam) begin
        ev_tick = ev_tick + 1;
        ev_valid <= 1'b0;
        if (ev_tick % 500 == 0) begin
            ev_valid <= 1'b1;
            ev_x     <= ev_xc;
            ev_y     <= ev_xc[7:0];
            ev_pol   <= ev_xc[0];
            ev_xc    <= ev_xc + 9'd7;
        end
    end

    //--------------------------------------------------------------------------
    // 8) 发端抓包器（udp_merge 输出口 = eth_udp 输入口，等价"线上看到的包"）
    //--------------------------------------------------------------------------
    reg [7:0]  h_flags, h_op, h_status;
    reg [15:0] h_rawlen, h_evlen;
    integer    n_bytes, cur_len;
    integer    n_raw_pkts, n_ev_pkts, n_ctrl_pkts, n_hb;
    integer    base_raw, post_raw, post_hb, post_ctrl, base_ctrl;
    integer    n_ack;
    reg [7:0]  ack_op  [0:31];
    reg [7:0]  ack_st  [0:31];
    reg [15:0] ack_seq [0:31];        // ACK 的 SEQ 回显（现场按 SEQ 配对）
    reg        ack_bad;
    integer    i;
    reg [7:0]  h_seq_hi, h_seq_lo;

    initial begin
        n_bytes = 0; cur_len = 0;
        n_raw_pkts = 0; n_ev_pkts = 0; n_ctrl_pkts = 0; n_hb = 0;
        base_raw = 0; post_raw = 0; post_hb = 0; post_ctrl = 0; base_ctrl = 0;
        n_ack = 0; ack_bad = 0;
        h_flags = 8'h00; h_op = 8'h00; h_status = 8'h00;
        h_seq_hi = 8'h00; h_seq_lo = 8'h00;
        h_rawlen = 16'd0; h_evlen = 16'd0;
    end

    always @(posedge clk_eth) begin
        if (udp_tx_start) begin
            cur_len <= udp_tx_len;
            n_bytes <= 0;
            h_flags <= 8'h00;
        end
        if (udp_tx_byte_en) begin
            case (n_bytes)
                6 : h_flags <= udp_tx_byte;
                12: h_rawlen[15:8] <= udp_tx_byte;
                13: h_rawlen[7:0]  <= udp_tx_byte;
                14: h_evlen[15:8]  <= udp_tx_byte;
                15: h_evlen[7:0]   <= udp_tx_byte;
                24: h_op     <= udp_tx_byte;
                25: h_status <= udp_tx_byte;
                26: h_seq_hi <= udp_tx_byte;
                27: h_seq_lo <= udp_tx_byte;
                default: ;
            endcase
            n_bytes <= n_bytes + 1;

            if (n_bytes == (cur_len - 1)) begin          // 本包结束
                if (h_flags[7]) begin                    // CTRL
                    n_ctrl_pkts <= n_ctrl_pkts + 1;
                    if (h_op == 8'hF0) n_hb <= n_hb + 1;
                    if ((h_op >= 8'h01) && (h_op <= 8'h05) && (n_ack < 32)) begin
                        ack_op[n_ack] <= h_op;
                        ack_st[n_ack] <= h_status;
                        ack_seq[n_ack] <= {h_seq_hi, h_seq_lo};
                        n_ack <= n_ack + 1;
                        if (h_status !== 8'h00) ack_bad <= 1;
                    end
                end
                else if (h_flags[0]) n_raw_pkts <= n_raw_pkts + 1;   // 含原始段
                else                 n_ev_pkts  <= n_ev_pkts  + 1;   // 纯事件包
            end
        end
    end

    //--------------------------------------------------------------------------
    // 8b) 诊断：每次"合法下行帧被接受"（派发）时的构包器状态
    //--------------------------------------------------------------------------
    always @(posedge clk_eth) begin
        if (u_dl.o_dl_accepted)
            $display("  [DISPATCH] t=%0t op=0x%02x seq=%0d | bstate=%0d r_kind=%0d ctrl_pending=%0d ctrl_len_q=%0d",
                     $time, u_dl.op_r, u_dl.seq_r, u_dl.bstate, u_dl.r_kind,
                     u_sink.u_udp_merge.ctrl_pending, u_sink.u_udp_merge.ctrl_len_q);
    end

    //--------------------------------------------------------------------------
    // 9) 下行包构造与发送（与 tb_downlink_cmd 同款；CRC16/CCITT-FALSE）
    //--------------------------------------------------------------------------
    function [15:0] crc16f;
        input [15:0] crc;
        input [7:0]  dat;
        integer i2;
        reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (i2 = 0; i2 < 8; i2 = i2 + 1)
                c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16f = c;
        end
    endfunction

    reg [7:0] pl [0:32];
    reg [7:0] tx_b [0:96];
    integer   plen, tx_n;

    task build_cmd; input [7:0] op; input [15:0] sq;
        integer k;
        reg [15:0] c;
        begin
            tx_b[0]=8'hF0; tx_b[1]=8'h5A; tx_b[2]=8'hA5; tx_b[3]=8'h31;
            tx_b[4]=8'h03;
            tx_b[5]=op;
            tx_b[6]=sq[15:8]; tx_b[7]=sq[7:0];
            tx_b[8]=plen[15:8]; tx_b[9]=plen[7:0];
            for (k = 0; k < plen; k = k + 1) tx_b[10+k] = pl[k];
            tx_n = 10 + plen;
            c = 16'hFFFF;
            for (k = 0; k < tx_n; k = k + 1) c = crc16f(c, tx_b[k]);
            tx_b[tx_n]   = c[15:8];
            tx_b[tx_n+1] = c[7:0];
            tx_n = tx_n + 2;
        end
    endtask

    task send_cmd; input [7:0] op; input [15:0] sq;
        integer k;
        begin
            build_cmd(op, sq);
            for (k = 0; k < tx_n; k = k + 1) begin
                @(negedge clk_eth);
                rx_valid <= 1'b1;
                rx_data  <= tx_b[k];
                rx_done  <= 1'b0;
            end
            @(negedge clk_eth);
            rx_valid <= 1'b0;
            rx_data  <= 8'h00;
            rx_done  <= 1'b1;
            @(negedge clk_eth);
            rx_done  <= 1'b0;
        end
    endtask

    task cmd_get_status; input [15:0] sq; begin plen = 0; send_cmd(8'h04, sq); end endtask
    task cmd_ev_en; input [15:0] sq; input [7:0] en; begin
        pl[0] = en; plen = 1; send_cmd(8'h05, sq);
    end endtask
    task cmd_set_theta; input [15:0] sq; input [15:0] v; begin
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=v[15:8]; pl[3]=v[7:0];
        plen = 4; send_cmd(8'h01, sq);
    end endtask

    task wait_clk; input integer n; integer k; begin
        for (k = 0; k < n; k = k + 1) @(posedge clk_eth);
    end endtask

    //--------------------------------------------------------------------------
    // 10) 主流程
    //--------------------------------------------------------------------------
    initial begin
        rst_n = 1'b0;
        repeat (40) @(posedge clk_eth);
        rst_n = 1'b1;
        repeat (20) @(posedge clk_eth);

        // ---- 相位 A：基线（管道灌满即可，不等整帧）----
        wait_clk(250000);
        base_raw  = n_raw_pkts;
        base_ctrl = n_ctrl_pkts;
        $display("[PHASE-A] baseline: raw=%0d ev=%0d ctrl=%0d hb=%0d drop_px=%0d n_full=%0d",
                 base_raw, n_ev_pkts, base_ctrl, n_hb, udp_drop_px, u_sink.u_udp_merge.n_full);
        if (base_raw >= 40) chk_pass("A1_baseline_raw_flow");
        else begin
            $display("  [E] baseline raw chunks=%0d (<40)", base_raw);
            chk_fail("A1_baseline_raw_flow");
        end

        // ---- 相位 B：现场命令序列（22:18:10 → 22:18:36；时序压缩 1:1e5）----
        $display("[PHASE-B] replay 22:18 cmd sequence (opcode/SEQ verbatim)");
        cmd_get_status(16'd2);        wait_clk(2500);
        cmd_get_status(16'd3);        wait_clk(2500);
        cmd_ev_en    (16'd4, 8'd1);   wait_clk(2500);
        cmd_ev_en    (16'd5, 8'd0);   wait_clk(2500);
        cmd_set_theta(16'd6, 16'd44); wait_clk(2500);
        for (i = 7; i <= 14; i = i + 1) begin
            cmd_get_status(i[15:0]);
            wait_clk(2500);
        end
        $display("[PHASE-B] done: n_ack=%0d ctrl=%0d (cfg_ev_en now=%0d)",
                 n_ack, n_ctrl_pkts, cfg_ev_en);

        // ---- 相位 C：命令后 ----
        post_raw = n_raw_pkts;
        post_hb  = n_hb;
        wait_clk(400000);
        post_raw  = n_raw_pkts - post_raw;
        post_hb   = n_hb - post_hb;
        post_ctrl = n_ctrl_pkts - base_ctrl;
        $display("[PHASE-C] after cmds: raw=%0d (ev=%0d ctrl=%0d hb=%0d)",
                 post_raw, n_ev_pkts, post_ctrl, post_hb);

        // B1：13 条命令全部 ACK 且 STATUS=OK
        //     ⚠️ 修复前此判据**预期 FAIL**：CTRL 包不经 i_tx_ready 门控即开包，
        //        eth_udp 忙时（W_LOAD/W_WAIT）整包被吞 ⇒ 现场 §4.6 的"ACK 偶发超时"
        //        与 0.83 Hz 心跳（丢 ~17%，≈ eth_udp 占空比）同源。
        $display("  [CTRL-LOSS] cmd ACK = %0d / 13 (field sec.4.6: 2 of 5 timed out)", n_ack);
        if ((n_ack >= 13) && (ack_bad == 0)) chk_pass("B1_all_cmd_ack_ok");
        else begin
            $display("  [E] n_ack=%0d (need>=13) ack_bad=%0d", n_ack, ack_bad);
            chk_fail("B1_all_cmd_ack_ok");
        end

        // B2：EV_EN=0 命令被 ACK（opcode 0x05 出现过）
        begin : b2
            reg found_ev;
            found_ev = 1'b0;
            for (i = 0; i < 32; i = i + 1)
                if (ack_op[i] == 8'h05) found_ev = 1'b1;
            if (found_ev) chk_pass("B2_ev_en_cmd_acknowledged");
            else begin
                $display("  [E] no EV_EN(0x05) ACK");
                chk_fail("B2_ev_en_cmd_acknowledged");
            end
        end

        $display("  [ACK-LIST] n=%0d", n_ack);
        for (i = 0; i < n_ack; i = i + 1)
            $display("    ack[%0d] op=0x%02x seq=%0d st=0x%02x", i, ack_op[i], ack_seq[i], ack_st[i]);

        // C1：★停流判据
        if (post_raw >= 40) chk_pass("C1_raw_resumes_after_cmds");
        else begin
            $display("  [STALL] raw chunks after cmds = %0d (need >=40) => DATA PLANE STALLED (repro)",
                     post_raw);
            chk_fail("C1_raw_resumes_after_cmds");
        end

        // C2：CTRL 心跳仍在（停的是数据面，不是整块板）
        if (post_hb >= 3) chk_pass("C2_heartbeat_alive_after_cmds");
        else begin
            $display("  [E] heartbeat after cmds = %0d (need >=3)", post_hb);
            chk_fail("C2_heartbeat_alive_after_cmds");
        end

        $display("  [SUMMARY] raw=%0d ev_pkts=%0d ctrl=%0d hb=%0d ev_recs_x5=%0d",
                 n_raw_pkts, n_ev_pkts, n_ctrl_pkts, n_hb, h_evlen);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200000000;                                  // 200 ms 仿真上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
