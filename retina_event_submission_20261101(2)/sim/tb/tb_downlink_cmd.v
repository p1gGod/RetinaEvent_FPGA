//==============================================================================
// tb_downlink_cmd.v —— 下行命令通路集成自测（v3 §6 + v3.1 EV_EN；★断言③ 本营）
//
// 被测链路（与 top_retina_event 的 B2/B5.1/B5.2 同构）：
//   TB 模拟 PC 下行字节流 → downlink_cmd（125 MHz）→ toggle+值 CDC →
//   sys_ctrl（50 MHz）工作点寄存器；ACK/心跳/REQ 经 o_ctrl_* 回 TB 解析。
//
// 判据：
//   S1  ★断言③ SET_PARAM(θ,δL) 写入后 sys_ctrl.o_cfg_theta/o_cfg_min_dl
//       **实际变化**（跨时钟域落地），ACK 写后读回值一致
//   S2  SET_PARAM 原子性：一条含越界 TLV ⇒ BAD_VALUE，θ/δL 整条不写
//   S3  SET_MODE：0/1/2 落地 o_mode；幂等（等值重发 ACK OK、零副作用）
//   S4  SET_MODE 越界 ⇒ BAD_VALUE；LEN 错 ⇒ BAD_LEN；模式不变
//   S5  ★v3.1 EV_EN：写 0 ⇒ o_cfg_ev_en=0；写 1 恢复；值 3 ⇒ BAD_VALUE
//   S6  TIME_SYNC：FLAG=1 ⇒ offset = HOST − t4（精确）；FLAG=0+RTT_HALF ⇒
//       offset = HOST + RTT_HALF − t4；长度错 ⇒ BAD_LEN
//   S7  坏 CRC ⇒ dlCrcFail++、不回应、不写
//   S8  坏 OPCODE ⇒ dlBadOpcode++、不回应
//   S9  坏 MAGIC/VER ⇒ dlReject++、不回应
//   S10 GET_STATUS ⇒ CTRL_LEN=65，TLV 0x81/0x8C/0x8A/0x90 在位
//   S11 TIME_SYNC_REQ 转发：OPCODE=0x83、CTRL_LEN=6（载荷 = t2）
//   S12 每条 ACK：CRC16 正确、STATUS/SEQ 字段在位；周期心跳 0xF0 出现
//   —— ★ SCCB 集成（2026-10-13）新增 ——
//   S17 ★SET_PARAM tag 0x0B EXP_CAP=746：ACK CTRL_LEN=23、TLV 0x90 读回 0x02EA、
//       downlink_cmd.o_exp_cap 与 sys_ctrl.cfg_exp_cap 双双落地、重触发 toggle 翻一次
//   S18 ★越界（7000 / 3）⇒ BAD_VALUE 且**整条不写**（同条里的合法 tag 也不写）
//   S19 ★按存在写：不带 0x0B 的命令不改 exp_cap（ACK TLV 0x90 仍读回 746）
//==============================================================================
`timescale 1ns / 1ps

module tb_downlink_cmd;

    // 时钟：clk_eth 125 MHz / clk_cam 50 MHz（与顶层一致）
    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    always #4   clk_eth = ~clk_eth;
    always #10  clk_cam = ~clk_cam;

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT 互联（复制 top 的 CDC 结构）
    //--------------------------------------------------------------------------
    wire        cal_req;  wire [15:0] cal_seq;  wire [47:0] board_ts;
    wire [47:0] ts_local, ts_aligned, offset_reg;
    wire        ts_valid, ts_cal, ts_stale;
    wire [15:0] rtt_us;
    wire [31:0] boot_id;

    reg         rx_valid = 1'b0;
    reg  [7:0]  rx_data  = 8'd0;
    reg         rx_done  = 1'b0;

    wire [11:0] dl_theta;        wire dl_theta_upd;
    wire [8:0]  dl_min_dl;       wire dl_min_dl_upd;
    wire [1:0]  dl_mode_set;     wire dl_mode_set_upd;
    wire        dl_ev_en;        wire dl_ev_en_upd;
    // ★ WIRE-U1 新增
    wire [1:0]  dl_ev_res;       wire dl_ev_res_upd;
    wire [7:0]  dl_ser_decim;    wire dl_ser_decim_upd;
    wire [1:0]  dl_ser_agg;      wire dl_ser_agg_upd;
    wire [15:0] dl_ser_flush;    wire dl_ser_flush_upd;
    // ★ SCCB 集成：曝光上限运行时可写
    wire [15:0] dl_exp_cap;      wire dl_exp_cap_upd;
    wire        dl_accepted;
    // o_dl_accepted 计数（WIRE-U1 §5.1 L2 判据来源）
    integer n_dl_acc = 0;
    always @(posedge clk_eth) if (dl_accepted) n_dl_acc = n_dl_acc + 1;
    // ★ SCCB 集成：EXP_CAP 重触发 toggle **翻转次数**（clk_cam 域，每次"已接受的改值"翻 1 次）
    //   ⚠️ 计数块放在 sys_ctrl 例化之后（cfg_exp_cap_upd 需先声明后使用）
    //   ⚠️ 必须数"沿"而不是数"电平"（toggle 是电平式，高位会持续很多拍）
    integer n_expcap_upd = 0;
    reg     exp_cap_upd_q = 1'b0;
    reg     capcnt_en = 1'b0;      // 复位释放后才使能计数（避开上电 X 态误计）
    wire [7:0]  dl_frame_decim;
    wire [23:0] dl_ev_flush_cyc;
    wire        period_wr_o;     wire [16:0] period_s_o;
    wire        force_cal_o;
    wire        off_wr_o;        wire [47:0] off_data_o;
    wire        sync_matched;
    wire        ctrl_wr_en;  wire [7:0] ctrl_data;  wire ctrl_commit;
    wire [15:0] cnt_crc_fail, cnt_bad_op, cnt_reject;
    wire [1:0]  cfg_mode_eth;      // 模式/事件使能回跨域（clk_cam → clk_eth，复制 top）
    wire        cfg_ev_en_eth;

    downlink_cmd #(
        .HEARTBEAT_CYC (32'd200000),     // TB 缩短：1.6 ms
        .FW_VER        (16'h0003),
        .WIRE_VER_B    (8'h03)
    ) u_dl (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n),
        .i_rx_valid     (rx_valid),
        .i_rx_data      (rx_data),
        .o_rx_rd_en     (),
        .i_rx_pkt_done  (rx_done),
        .i_rx_stream    (1'b0),          // 本 TB 走 UDP 语义（非串口流）
        .i_net_state    (2'd0),
        .i_net_chg      (1'b0),
        .i_ser_drop     (8'h00),
        .i_mode         (cfg_mode_eth),
        .i_ts_us        (ts_aligned),
        .i_ts_local_us  (ts_local),
        .i_ts_offset    (offset_reg),
        .i_ts_valid     (ts_valid),
        .i_ts_calibrated(ts_cal),
        .i_ts_stale     (ts_stale),
        .i_rtt_us       (rtt_us),
        .i_boot_id      (boot_id),
        .i_frame_idx    (16'd0),
        .i_drop_px      (16'd0),
        .i_drop_ev      (16'd0),
        .i_ev_en        (cfg_ev_en_eth),
        .i_act_byte     (8'h00),          // ★ M4b：无动作（TLV 0x92 值 0x00）
        .i_cal_req      (cal_req),
        .i_cal_seq      (cal_seq),
        .i_board_ts     (board_ts),
        .o_sync_matched (sync_matched),
        .o_theta        (dl_theta),
        .o_theta_upd    (dl_theta_upd),
        .o_min_dl       (dl_min_dl),
        .o_min_dl_upd   (dl_min_dl_upd),
        .o_mode_set     (dl_mode_set),
        .o_mode_set_upd (dl_mode_set_upd),
        .o_ev_en        (dl_ev_en),
        .o_ev_en_upd    (dl_ev_en_upd),
        .o_ev_res       (dl_ev_res),
        .o_ev_res_upd   (dl_ev_res_upd),
        .o_ser_decim    (dl_ser_decim),
        .o_ser_decim_upd(dl_ser_decim_upd),
        .o_ser_agg      (dl_ser_agg),
        .o_ser_agg_upd  (dl_ser_agg_upd),
        .o_ser_flush_ms (dl_ser_flush),
        .o_ser_flush_upd(dl_ser_flush_upd),
        .o_exp_cap      (dl_exp_cap),        // ★ SCCB 集成
        .o_exp_cap_upd  (dl_exp_cap_upd),
        .o_ser_baud_sel   (),        // ★ WIRE-U2：切档通路本 TB 不测（tb_uart_baud 专测）
        .o_ser_baud_commit(),
        .o_dl_accepted  (dl_accepted),
        .o_frame_decim  (dl_frame_decim),
        .o_ev_flush_cyc (dl_ev_flush_cyc),
        .o_period_wr    (period_wr_o),
        .o_period_s     (period_s_o),
        .o_force_cal    (force_cal_o),
        .o_off_wr       (off_wr_o),
        .o_off_data     (off_data_o),
        .o_ctrl_wr_en   (ctrl_wr_en),
        .o_ctrl_data    (ctrl_data),
        .o_ctrl_commit  (ctrl_commit),
        .i_ctrl_empty   (1'b1),
        .o_stat_dl_crc_fail  (cnt_crc_fail),
        .o_stat_dl_bad_opcode(cnt_bad_op),
        .o_stat_dl_reject    (cnt_reject)
    );

    // ts_gen（缩短日程；FIRST_CAL 1500 µs）
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
        .i_off_wr_en    (off_wr_o),
        .i_off_data     (off_data_o),
        .i_period_wr_en (period_wr_o),
        .i_period_s     (period_s_o),
        .i_force_cal    (force_cal_o),
        .i_sync_matched (sync_matched),
        .o_cal_req      (cal_req),
        .o_cal_seq      (cal_seq),
        .o_board_ts_us  (board_ts),
        .o_ts_local_us  (ts_local),
        .o_ts_aligned_us(ts_aligned),
        .o_ts_valid     (ts_valid),
        .o_ts_calibrated(ts_cal),
        .o_ts_stale     (ts_stale),
        .o_offset_reg   (offset_reg),
        .o_rtt_us       (rtt_us),
        .o_boot_id      (boot_id)
    );

    // ---- toggle+值 CDC（clk_eth → clk_cam，复制 top 结构）----
    wire [11:0] theta_set_cam;  wire theta_set_cam_upd;
    wire [8:0]  min_dl_set_cam; wire min_dl_set_cam_upd;
    wire [1:0]  mode_set_cam;   wire mode_set_cam_upd;
    wire        ev_en_set_cam;  wire ev_en_set_cam_upd;

    sync_ff #(.WIDTH(12), .STAGES(2)) u_s1 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_theta),    .o_dst(theta_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s2 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_theta_upd),.o_dst(theta_set_cam_upd));
    sync_ff #(.WIDTH(9),  .STAGES(2)) u_s3 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_min_dl),   .o_dst(min_dl_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s4 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_min_dl_upd),.o_dst(min_dl_set_cam_upd));
    sync_ff #(.WIDTH(2),  .STAGES(2)) u_s5 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_mode_set), .o_dst(mode_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s6 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_mode_set_upd),.o_dst(mode_set_cam_upd));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s7 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_en),    .o_dst(ev_en_set_cam));
    sync_ff #(.WIDTH(1),  .STAGES(2)) u_s8 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_en_upd),.o_dst(ev_en_set_cam_upd));

    // ★ WIRE-U1 SER 参数组 CDC（同款 toggle+值）
    wire [1:0]  ev_res_set_cam;    wire ev_res_set_cam_upd;
    wire [7:0]  ser_decim_set_cam; wire ser_decim_set_cam_upd;
    wire [1:0]  ser_agg_set_cam;   wire ser_agg_set_cam_upd;
    wire [15:0] ser_flush_set_cam; wire ser_flush_set_cam_upd;
    sync_ff #(.WIDTH(2), .STAGES(2)) u_s9  (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_res),      .o_dst(ev_res_set_cam));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_s10 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ev_res_upd),  .o_dst(ev_res_set_cam_upd));
    sync_ff #(.WIDTH(8), .STAGES(2)) u_s11 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_decim),   .o_dst(ser_decim_set_cam));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_s12 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_decim_upd), .o_dst(ser_decim_set_cam_upd));
    sync_ff #(.WIDTH(2), .STAGES(2)) u_s13 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_agg),     .o_dst(ser_agg_set_cam));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_s14 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_agg_upd), .o_dst(ser_agg_set_cam_upd));
    sync_ff #(.WIDTH(16), .STAGES(2)) u_s15 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_flush),   .o_dst(ser_flush_set_cam));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_s16 (.dest_clk(clk_cam), .dest_rst_n(rst_n),
        .i_src(dl_ser_flush_upd), .o_dst(ser_flush_set_cam_upd));

    // ★ SCCB 集成：EXP_CAP 走**与 top 相同的 cdc_tog_word**（F3 修复后的成对过域）
    wire [15:0] exp_cap_set_cam;  wire exp_cap_set_cam_upd;
    cdc_tog_word #(.WIDTH(16), .STAGES(2), .SETTLE(3)) u_cdccap (
        .dst_clk (clk_cam), .dst_rst_n (rst_n),
        .i_src_val (dl_exp_cap),     .i_src_tog (dl_exp_cap_upd),
        .o_dst_val (exp_cap_set_cam), .o_dst_tog (exp_cap_set_cam_upd));

    // sys_ctrl（键悬空，消抖参数缩到最小）
    wire       cfg_disp_mode;  wire [1:0] cfg_mode;
    wire [1:0] cfg_theta_sel;  wire [3:0] cfg_layer_en;
    wire       cfg_ev_en;      wire [11:0] cfg_theta;
    wire [8:0] cfg_min_dl;     wire stat_mode;
    wire [3:0] key_pressed;
    wire [1:0] cfg_ev_res;     wire [7:0] cfg_ser_decim;
    wire [1:0] cfg_ser_agg;    wire [15:0] cfg_ser_flush_ms;
    wire [15:0] cfg_exp_cap;   wire cfg_exp_cap_upd;   // ★ SCCB 集成

    sys_ctrl #(
        .CLK_FREQ_HZ (1000),
        .DEBOUNCE_MS (1)
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
        .i_ev_res_set_val    (ev_res_set_cam),
        .i_ev_res_set_upd    (ev_res_set_cam_upd),
        .i_ser_decim_set_val (ser_decim_set_cam),
        .i_ser_decim_set_upd (ser_decim_set_cam_upd),
        .i_ser_agg_set_val   (ser_agg_set_cam),
        .i_ser_agg_set_upd   (ser_agg_set_cam_upd),
        .i_ser_flush_set_val (ser_flush_set_cam),
        .i_ser_flush_set_upd (ser_flush_set_cam_upd),
        .i_exp_cap_set_val   (exp_cap_set_cam),     // ★ SCCB 集成
        .i_exp_cap_set_upd   (exp_cap_set_cam_upd),
        .o_cfg_disp_mode (cfg_disp_mode),
        .o_mode          (cfg_mode),
        .o_cfg_theta_sel (cfg_theta_sel),
        .o_cfg_layer_en  (cfg_layer_en),
        .o_cfg_ev_en     (cfg_ev_en),
        .o_cfg_theta     (cfg_theta),
        .o_cfg_min_dl    (cfg_min_dl),
        .o_stat_mode     (stat_mode),
        .o_key_pressed   (key_pressed),
        .o_ev_res        (cfg_ev_res),
        .o_ser_decim     (cfg_ser_decim),
        .o_ser_agg       (cfg_ser_agg),
        .o_ser_flush_ms  (cfg_ser_flush_ms),
        .o_exp_cap       (cfg_exp_cap),        // ★ SCCB 集成
        .o_exp_cap_upd   (cfg_exp_cap_upd)
    );

    // 模式/事件使能回跨域（clk_cam → clk_eth，复制 top）
    sync_ff #(.WIDTH(2), .STAGES(2)) u_r1 (.dest_clk(clk_eth), .dest_rst_n(rst_n),
        .i_src(cfg_mode),   .o_dst(cfg_mode_eth));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_r2 (.dest_clk(clk_eth), .dest_rst_n(rst_n),
        .i_src(cfg_ev_en),  .o_dst(cfg_ev_en_eth));

    // ★ SCCB 集成：EXP_CAP 重触发 toggle 沿计数（clk_cam 域；cfg_exp_cap_upd 已声明）
    always @(posedge clk_cam) begin
        exp_cap_upd_q <= cfg_exp_cap_upd;
        if (capcnt_en && (exp_cap_upd_q !== cfg_exp_cap_upd)) n_expcap_upd = n_expcap_upd + 1;
    end

    //--------------------------------------------------------------------------
    // 下行包构造与发送
    //--------------------------------------------------------------------------
    function [15:0] crc16f;
        input [15:0] crc;
        input [7:0]  dat;
        integer i;
        reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (i = 0; i < 8; i = i + 1)
                c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16f = c;
        end
    endfunction

    reg [7:0]  pl [0:64];      // 载荷（调用方填充）
    integer    plen;           // 载荷字节数
    reg [7:0]  tx_b [0:96];    // 完整下行包
    integer    tx_n;
    reg [15:0] g_seq = 16'd100;
    reg [15:0] last_seq;

    task build_cmd; input [7:0] op; input integer corrupt;
        integer i;
        reg [15:0] c;
        begin
            tx_b[0]=8'hF0; tx_b[1]=8'h5A; tx_b[2]=8'hA5; tx_b[3]=8'h31;
            tx_b[4]=8'h03;
            tx_b[5]=op;
            tx_b[6]=g_seq[15:8]; tx_b[7]=g_seq[7:0];
            tx_b[8]=plen[15:8];  tx_b[9]=plen[7:0];
            for (i = 0; i < plen; i = i + 1) tx_b[10+i] = pl[i];
            tx_n = 10 + plen;
            c = 16'hFFFF;
            for (i = 0; i < tx_n; i = i + 1) c = crc16f(c, tx_b[i]);
            if (corrupt == 1) c = c ^ 16'h0001;
            tx_b[tx_n]   = c[15:8];
            tx_b[tx_n+1] = c[7:0];
            tx_n = tx_n + 2;
            last_seq = g_seq;
            g_seq = g_seq + 16'd1;
        end
    endtask

    task send_cmd; input [7:0] op; input integer corrupt;
        integer i;
        begin
            build_cmd(op, corrupt);
            for (i = 0; i < tx_n; i = i + 1) begin
                @(negedge clk_eth);
                rx_valid <= 1'b1;
                rx_data  <= tx_b[i];
                rx_done  <= 1'b0;
            end
            @(negedge clk_eth);
            rx_valid <= 1'b0;
            rx_data  <= 8'h00;
            rx_done  <= 1'b1;      // 包边界脉冲
            @(negedge clk_eth);
            rx_done  <= 1'b0;
        end
    endtask

    //--------------------------------------------------------------------------
    // CTRL 包历史捕获（REQ/心跳/ACK 交错，全部存档按需检查）
    //--------------------------------------------------------------------------
    reg [7:0] hist [0:16383];
    integer   hist_ptr = 0;
    integer   pkt_start = 0;
    integer   start_hist [0:63];
    reg [7:0] op_hist   [0:63];
    reg [7:0] st_hist   [0:63];
    integer   clen_hist [0:63];
    integer   n_pkts = 0;
    integer   n_ack_hist = 0;      // 仅统计命令 ACK（op 0x01..0x05）

    reg commit_d = 1'b0;
    always @(posedge clk_eth) begin
        commit_d <= ctrl_commit;
        if (ctrl_wr_en && (hist_ptr < 16383)) begin
            hist[hist_ptr] <= ctrl_data;
            hist_ptr = hist_ptr + 1;
        end
        // ★ 记录滞后 commit 一拍：commit 拍最后一个字节同拍推送（非阻塞写），
        //   当拍读会拿到旧值 —— 等一拍所有字节都稳定后再入档。
        if (commit_d && (n_pkts < 64)) begin
            start_hist[n_pkts] = pkt_start;
            op_hist  [n_pkts] = hist[pkt_start + 24];
            st_hist  [n_pkts] = hist[pkt_start + 25];
            clen_hist[n_pkts] = {hist[pkt_start + 28], hist[pkt_start + 29]};
            if (op_hist[n_pkts] <= 8'h05) n_ack_hist = n_ack_hist + 1;
            n_pkts    = n_pkts + 1;
            pkt_start = hist_ptr;
        end
    end

    // 按序号取历史包的字节
    function [7:0] histb;
        input integer pn;
        input integer off;
        begin
            histb = hist[start_hist[pn] + off];
        end
    endfunction

    //--------------------------------------------------------------------------
    // ACK 等待与校验（扫历史，跳过心跳/REQ）
    //--------------------------------------------------------------------------
    integer scan_idx = 0;
    integer cur_pkt = -1;
    reg [15:0] a_clen, a_crc_c, a_crc_e;
    reg [7:0]  a_status;
    integer ai2;
    reg crc_ok;

    task wait_ack; input [7:0] op; input [8*48-1:0] nm;
        integer guard, j;
        begin
            guard = 0;
            cur_pkt = -1;
            while ((guard < 300000)) begin
                @(posedge clk_eth);
                for (j = scan_idx; j < n_pkts; j = j + 1)
                    if ((op_hist[j] === op) && (st_hist[j] !== 8'hxx)) begin
                        cur_pkt  = j;
                        scan_idx = j + 1;
                    end
                if (cur_pkt >= 0) guard = 300000;    // 找到即退出
                guard = guard + 1;
            end
            if (cur_pkt < 0) begin
                chk_fail(nm);
                $display("  [E] ACK(op=%02x) 超时", op);
            end
            else begin
                a_clen   = clen_hist[cur_pkt];
                a_status = st_hist[cur_pkt];
                // CRC16 覆盖 [0..30+CTRL_LEN-1]（§6.2）
                a_crc_c = 16'hFFFF;
                for (ai2 = 0; ai2 < (30 + a_clen); ai2 = ai2 + 1)
                    a_crc_c = crc16f(a_crc_c, histb(cur_pkt, ai2));
                a_crc_e = {histb(cur_pkt, 30 + a_clen), histb(cur_pkt, 31 + a_clen)};
                begin : crcchk
                    reg [7:0] flags_b;
                    flags_b = histb(cur_pkt, 6);
                    crc_ok = (a_crc_c === a_crc_e) &&
                             (histb(cur_pkt,0)===8'hF0 && histb(cur_pkt,1)===8'h5A &&
                              histb(cur_pkt,2)===8'hA5 && histb(cur_pkt,3)===8'h30) &&
                             (histb(cur_pkt,4)===8'h03) && (histb(cur_pkt,5)===8'h18) &&
                             (flags_b[7] === 1'b1);
                end
                if (crc_ok) chk_pass(nm);
                else begin
                    chk_fail(nm);
                    $display("  [E] ACK 非法: clen=%0d crc %04x/%04x st=%02x",
                             a_clen, a_crc_c, a_crc_e, a_status);
                    $display("  [D] h0..5=%02x %02x %02x %02x %02x %02x h6=%02x h24=%02x h25=%02x",
                             histb(cur_pkt,0),histb(cur_pkt,1),histb(cur_pkt,2),
                             histb(cur_pkt,3),histb(cur_pkt,4),histb(cur_pkt,5),
                             histb(cur_pkt,6),histb(cur_pkt,24),histb(cur_pkt,25));
                end
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer k, j;
    reg [47:0] exp_off;
    reg        cal_req_seen = 1'b0;
    reg        hb_seen = 1'b0;

    initial begin
        repeat (10) @(posedge clk_eth);
        rst_n <= 1'b1;
        repeat (20) @(posedge clk_eth);
        capcnt_en = 1'b1;               // ★ 此后才开始计 EXP_CAP 重触发沿

        //======================================================================
        // S1：★SET_PARAM(θ=777, δL=123) → 工作点实际变化（跨域落地）
        //======================================================================
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=8'h03; pl[3]=8'h09;   // THETA=0x0309=777
        pl[4]=8'h02; pl[5]=8'h02; pl[6]=8'h00; pl[7]=8'h7B;   // MIN_DL=123
        plen = 8;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S1_setparam_ack_valid");
        if (a_status === 8'h00) chk_pass("S1_setparam_status_ok");
        else                    chk_fail("S1_setparam_status_ok");
        // ACK TLV 写后读回（idx 30.. = MODE(3) THETA(4) MIN_DL(4)）
        if (histb(cur_pkt,30)===8'h81 && histb(cur_pkt,33)===8'h82 &&
            {histb(cur_pkt,35),histb(cur_pkt,36)}===16'd777 &&
            histb(cur_pkt,37)===8'h83 && {histb(cur_pkt,39),histb(cur_pkt,40)}===16'd123)
            chk_pass("S1_ack_readback_theta_mindl");
        else chk_fail("S1_ack_readback_theta_mindl");
        // ★断言③：clk_cam 域 sys_ctrl 输出实际变化
        k = 0;
        while (((cfg_theta !== 12'd777) || (cfg_min_dl !== 9'd123)) && (k < 20000)) begin
            @(posedge clk_cam); k = k + 1;
        end
        if (cfg_theta === 12'd777 && cfg_min_dl === 9'd123)
            chk_pass("S3_theta_mindl_changed_on_board");   // ★断言③
        else begin
            chk_fail("S3_theta_mindl_changed_on_board");
            $display("  [E] theta=%0d min_dl=%0d", cfg_theta, cfg_min_dl);
        end

        //======================================================================
        // S2：原子性（θ 合法 + δL=600 越界 ⇒ 整条不写）
        //======================================================================
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=8'h01; pl[3]=8'h00;   // THETA=256
        pl[4]=8'h02; pl[5]=8'h02; pl[6]=8'h02; pl[7]=8'h58;   // MIN_DL=600（>511）
        plen = 8;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S2_atomic_ack_valid");
        if (a_status === 8'h04) chk_pass("S2_atomic_bad_value");
        else                    chk_fail("S2_atomic_bad_value");
        repeat (3000) @(posedge clk_cam);
        if (cfg_theta === 12'd777 && cfg_min_dl === 9'd123)
            chk_pass("S2_atomic_no_partial_write");
        else chk_fail("S2_atomic_no_partial_write");

        //======================================================================
        // S3：SET_MODE(2) 落地 + 幂等 + RAW_ONLY(1) 仅下行可达
        //======================================================================
        pl[0]=8'h02; plen = 1;
        send_cmd(8'h02, 0);
        wait_ack(8'h02, "S3_setmode_ack_valid");
        k = 0;
        while ((cfg_mode !== 2'd2) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_mode === 2'd2) chk_pass("S3_mode2_on_board");
        else                   chk_fail("S3_mode2_on_board");
        send_cmd(8'h02, 0);                    // 幂等重发
        wait_ack(8'h02, "S3_setmode_idem_ack");
        if (a_status === 8'h00) chk_pass("S3_setmode_idem_ok");
        else                    chk_fail("S3_setmode_idem_ok");
        repeat (3000) @(posedge clk_cam);
        if (cfg_mode === 2'd2) chk_pass("S3_setmode_idem_no_flip");
        else                   chk_fail("S3_setmode_idem_no_flip");
        pl[0]=8'h01; plen = 1;
        send_cmd(8'h02, 0);
        wait_ack(8'h02, "S3_setmode1_ack");
        k = 0;
        while ((cfg_mode !== 2'd1) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_mode === 2'd1) chk_pass("S3_mode1_via_downlink");
        else                   chk_fail("S3_mode1_via_downlink");
        pl[0]=8'h00; plen = 1;
        send_cmd(8'h02, 0);
        wait_ack(8'h02, "S3_setmode0_ack");
        repeat (5000) @(posedge clk_cam);

        //======================================================================
        // S4：SET_MODE 越界 / LEN 错
        //======================================================================
        pl[0]=8'h05; plen = 1;
        send_cmd(8'h02, 0);
        wait_ack(8'h02, "S4_setmode5_ack");
        if (a_status === 8'h04) chk_pass("S4_setmode5_bad_value");
        else                    chk_fail("S4_setmode5_bad_value");
        plen = 0;
        send_cmd(8'h02, 0);
        wait_ack(8'h02, "S4_setmode_len0_ack");
        if (a_status === 8'h03) chk_pass("S4_setmode_len0_bad_len");
        else                    chk_fail("S4_setmode_len0_bad_len");
        repeat (3000) @(posedge clk_cam);
        if (cfg_mode === 2'd0) chk_pass("S4_mode_unchanged");
        else                   chk_fail("S4_mode_unchanged");

        //======================================================================
        // S5：★v3.1 EV_EN
        //======================================================================
        pl[0]=8'h00; plen = 1;
        send_cmd(8'h05, 0);
        wait_ack(8'h05, "S5_even_ack_valid");
        if (histb(cur_pkt,30)===8'h8C && histb(cur_pkt,32)===8'h00)
            chk_pass("S5_ack_tlv_8c");
        else chk_fail("S5_ack_tlv_8c");
        k = 0;
        while ((cfg_ev_en !== 1'b0) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_ev_en === 1'b0) chk_pass("S5_ev_en_off_on_board");
        else                    chk_fail("S5_ev_en_off_on_board");
        pl[0]=8'h01; plen = 1;
        send_cmd(8'h05, 0);
        wait_ack(8'h05, "S5_even_on_ack");
        k = 0;
        while ((cfg_ev_en !== 1'b1) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_ev_en === 1'b1) chk_pass("S5_ev_en_restored");
        else                    chk_fail("S5_ev_en_restored");
        pl[0]=8'h03; plen = 1;
        send_cmd(8'h05, 0);
        wait_ack(8'h05, "S5_even_val3_ack");
        if (a_status === 8'h04) chk_pass("S5_ev_en_val3_bad");
        else                    chk_fail("S5_ev_en_val3_bad");

        //======================================================================
        // S6：TIME_SYNC（FLAG=1 直接对基准 / FLAG=0+RTT_HALF）
        //======================================================================
        pl[0]=8'h00; pl[1]=8'h00; pl[2]=8'h00;             // HOST[47:0] = 123456
        pl[3]=8'h01; pl[4]=8'hE2; pl[5]=8'h40;             //   = 00 00 00 01 E2 40
        pl[6]=8'h00; pl[7]=8'h00;                          // RTT_HALF=0
        pl[8]=8'h01;                                       // FLAG=1
        plen = 9;
        send_cmd(8'h03, 0);
        wait_ack(8'h03, "S6_timesync_ack_valid");
        if (a_status === 8'h00) chk_pass("S6_timesync_status_ok");
        else                    chk_fail("S6_timesync_status_ok");
        if (ts_aligned === (ts_local + offset_reg))
            chk_pass("S6_aligned_selfconsistent");
        else chk_fail("S6_aligned_selfconsistent");
        // offset = HOST − t4：t4 与检查点相差构包耗时（<1 µs），容差 ±8 µs
        exp_off = 48'd123456 - ts_local;
        if ((offset_reg > exp_off - 48'd8) && (offset_reg < exp_off + 48'd8))
            chk_pass("S6_offset_host_minus_t4");
        else begin
            chk_fail("S6_offset_host_minus_t4");
            $display("  [E] off=%0d exp~%0d", offset_reg, exp_off);
        end
        // FLAG=0 + RTT_HALF=50：offset = HOST + 50 − t4
        pl[3]=8'h01; pl[4]=8'h00; pl[5]=8'h40;             // HOST[47:0] = 65600
        pl[6]=8'h00; pl[7]=8'h32;                          // RTT_HALF=50
        pl[8]=8'h00;                                       // FLAG=0
        plen = 9;
        send_cmd(8'h03, 0);
        wait_ack(8'h03, "S6_timesync2_ack");
        exp_off = 48'd65600 + 48'd50 - ts_local;
        if ((offset_reg > exp_off - 48'd8) && (offset_reg < exp_off + 48'd8))
            chk_pass("S6_offset_host_plus_half_minus_t4");
        else begin
            chk_fail("S6_offset_host_plus_half_minus_t4");
            $display("  [E] off=%0d exp~%0d", offset_reg, exp_off);
        end
        // 长度错
        plen = 8;
        send_cmd(8'h03, 0);
        wait_ack(8'h03, "S6_timesync_len_ack");
        if (a_status === 8'h03) chk_pass("S6_timesync_len_bad");
        else                    chk_fail("S6_timesync_len_bad");

        //======================================================================
        // S7/S8/S9：坏 CRC / 坏 OPCODE / 坏 MAGIC（均不回应）
        //======================================================================
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=8'h00; pl[3]=8'h10;
        pl[4]=8'h02; pl[5]=8'h02; pl[6]=8'h00; pl[7]=8'h40;   // δL=64
        plen = 8;
        j = n_ack_hist;
        send_cmd(8'h01, 1);                    // 坏 CRC
        repeat (5000) @(posedge clk_eth);
        if (cnt_crc_fail == 16'd1) chk_pass("S7_badcrc_counted");
        else                       chk_fail("S7_badcrc_counted");
        if (n_ack_hist == j) chk_pass("S7_bad_crc_no_reply");
        else                 chk_fail("S7_bad_crc_no_reply");
        repeat (3000) @(posedge clk_cam);
        if (cfg_min_dl === 9'd123) chk_pass("S7_bad_crc_no_write");
        else                       chk_fail("S7_bad_crc_no_write");

        plen = 1; pl[0]=8'h01;
        j = n_ack_hist;
        send_cmd(8'h77, 0);                    // 坏 OPCODE（白名单外）
        repeat (5000) @(posedge clk_eth);
        if (cnt_bad_op == 16'd1) chk_pass("S8_bad_opcode_counted");
        else                     chk_fail("S8_bad_opcode_counted");
        if (n_ack_hist == j) chk_pass("S8_bad_opcode_no_reply");
        else                 chk_fail("S8_bad_opcode_no_reply");

        // 坏 MAGIC：F0 5A A5 30（上行魔数当下行）
        tx_b[0]=8'hF0; tx_b[1]=8'h5A; tx_b[2]=8'hA5; tx_b[3]=8'h30;
        tx_b[4]=8'h03; tx_b[5]=8'h02; tx_b[6]=8'h00; tx_b[7]=8'h01;
        tx_b[8]=8'h00; tx_b[9]=8'h01; tx_b[10]=8'h01;
        begin : fix_bad_magic
            reg [15:0] c; integer i2;
            c = 16'hFFFF;
            for (i2 = 0; i2 < 11; i2 = i2 + 1) c = crc16f(c, tx_b[i2]);
            tx_b[11]=c[15:8]; tx_b[12]=c[7:0];
        end
        j = n_ack_hist;
        for (k = 0; k < 13; k = k + 1) begin
            @(negedge clk_eth);
            rx_valid <= 1'b1; rx_data <= tx_b[k]; rx_done <= 1'b0;
        end
        @(negedge clk_eth); rx_valid <= 1'b0; rx_done <= 1'b1;
        @(negedge clk_eth); rx_done <= 1'b0;
        repeat (5000) @(posedge clk_eth);
        if (cnt_reject >= 16'd1) chk_pass("S9_bad_magic_rejected");
        else                     chk_fail("S9_bad_magic_rejected");
        if (n_ack_hist == j) chk_pass("S9_bad_magic_no_reply");
        else                 chk_fail("S9_bad_magic_no_reply");
        repeat (3000) @(posedge clk_cam);
        if (cfg_mode === 2'd0) chk_pass("S9_bad_magic_no_effect");
        else                   chk_fail("S9_bad_magic_no_effect");

        //======================================================================
        // S10：GET_STATUS（CTRL_LEN=71=61+EXP_CAP_STATE(4)+BAUD_STATE(3)+★M4b ACTION_STATE(3)）
        //======================================================================
        plen = 0;
        send_cmd(8'h04, 0);
        wait_ack(8'h04, "S10_getstatus_ack_valid");
        if (a_clen === 16'd71) chk_pass("S10_getstatus_clen71");
        else begin
            chk_fail("S10_getstatus_clen71");
            $display("  [E] clen=%0d", a_clen);
        end
        if (histb(cur_pkt,30)===8'h81 && histb(cur_pkt,77)===8'h8C && histb(cur_pkt,72)===8'h8A)
            chk_pass("S10_getstatus_tlvs");
        else chk_fail("S10_getstatus_tlvs");
        // ★ WIRE-U1 新 TLV：0x8D@80 / 0x8E@83 / 0x8F@88
        if (histb(cur_pkt,80)===8'h8D && histb(cur_pkt,83)===8'h8E && histb(cur_pkt,88)===8'h8F)
            chk_pass("S10_wireu1_tlvs_present");
        else begin
            chk_fail("S10_wireu1_tlvs_present");
            $display("  [E] tlv@80=%02x @83=%02x @88=%02x",
                     histb(cur_pkt,80), histb(cur_pkt,83), histb(cur_pkt,88));
        end
        // ★ M4b 新 TLV 0x92 ACTION_STATE：tag@98 len@99 值@100（旧 68B 兼容 / 无动作 ⇒ 0x00）
        if (histb(cur_pkt,98)===8'h92 && histb(cur_pkt,98+1)===8'd1 &&
            histb(cur_pkt,98+2)===8'h00)
            chk_pass("S10_action_tlv_zero");
        else begin
            chk_fail("S10_action_tlv_zero");
            $display("  [E] tlv@98=%02x @99=%02x @100=%02x",
                     histb(cur_pkt,98), histb(cur_pkt,99), histb(cur_pkt,100));
        end
        // ★ SCCB 集成新 TLV 0x90 EXP_CAP_STATE：tag@91 len@92 值@93..94（默认 0x1710）
        if (histb(cur_pkt,91)===8'h90 && histb(cur_pkt,92)===8'd2 &&
            histb(cur_pkt,93)===8'h17 && histb(cur_pkt,94)===8'h10)
            chk_pass("S10_expcap_tlv_default_1710");
        else begin
            chk_fail("S10_expcap_tlv_default_1710");
            $display("  [E] tlv@91=%02x @92=%02x @93=%02x @94=%02x",
                     histb(cur_pkt,91), histb(cur_pkt,92), histb(cur_pkt,93), histb(cur_pkt,94));
        end

        //======================================================================
        // S13（WIRE-U1）：SET_PARAM 只带 tag 0x08 SER_DECIM=7
        //   · 按存在写：θ/δL 保持 777/123 不动（v3 旧实现会清零 —— 本断言防回归）
        //   · ACK CTRL_LEN=26（★SCCB 追加 EXP_CAP_STATE(4) + ★WIRE-U2 BAUD_STATE(4)），
        //     TLV 0x8E 的值[0] = 7
        //======================================================================
        pl[0]=8'h08; pl[1]=8'h01; pl[2]=8'h07; plen = 3;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S13_serdecim_ack_valid");
        if (a_clen === 16'd26) chk_pass("S13_ack_clen26");
        else begin
            chk_fail("S13_ack_clen26");
            $display("  [E] clen=%0d", a_clen);
        end
        if (a_status === 8'h00) chk_pass("S13_status_ok");
        else chk_fail("S13_status_ok");
        if ((histb(cur_pkt,44)===8'h8E) && (histb(cur_pkt,45)===8'd3) &&
            (histb(cur_pkt,46)===8'd7)) chk_pass("S13_ack_serstate_decim7");
        else begin
            chk_fail("S13_ack_serstate_decim7");
            $display("  [E] tlv44=%02x tlv46=%02x", histb(cur_pkt,44), histb(cur_pkt,46));
        end
        // ★ 按存在写：本条没带 0x0B ⇒ ACK TLV 0x90 读回当前真值（默认 0x1710）
        if (histb(cur_pkt,49)===8'h90 && histb(cur_pkt,50)===8'd2 &&
            histb(cur_pkt,51)===8'h17 && histb(cur_pkt,52)===8'h10)
            chk_pass("S13_ack_expcap_tlv_kept_default");
        else begin
            chk_fail("S13_ack_expcap_tlv_kept_default");
            $display("  [E] tlv@49=%02x @51..52=%02x%02x",
                     histb(cur_pkt,49), histb(cur_pkt,51), histb(cur_pkt,52));
        end
        k = 0;
        while ((cfg_ser_decim !== 8'd7) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_ser_decim === 8'd7) chk_pass("S13_serdecim_on_board");
        else begin
            chk_fail("S13_serdecim_on_board");
            $display("  [E] cfg_ser_decim=%0d", cfg_ser_decim);
        end
        if ((cfg_theta === 12'd777) && (cfg_min_dl === 9'd123))
            chk_pass("S13_presence_write_keeps_theta_mindl");
        else begin
            chk_fail("S13_presence_write_keeps_theta_mindl");
            $display("  [E] theta=%0d min_dl=%0d（应保持 777/123）", cfg_theta, cfg_min_dl);
        end

        //======================================================================
        // S14（WIRE-U1 §3.5 互斥）：SER_AGG=1 与 EV_RES=1 同条 ⇒ BAD_VALUE 整条不写
        //======================================================================
        pl[0]=8'h09; pl[1]=8'h01; pl[2]=8'h01;    // SER_AGG=1
        pl[3]=8'h07; pl[4]=8'h01; pl[5]=8'h01;    // EV_RES=1
        plen = 6;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S14_excl_ack_valid");
        if (a_status === 8'h04) chk_pass("S14_excl_bad_value");
        else begin
            chk_fail("S14_excl_bad_value");
            $display("  [E] status=%02x", a_status);
        end
        repeat (3000) @(posedge clk_cam);
        if ((cfg_ser_agg === 2'd0) && (cfg_ev_res === 2'd0))
            chk_pass("S14_excl_no_write");
        else begin
            chk_fail("S14_excl_no_write");
            $display("  [E] agg=%0d ev_res=%0d", cfg_ser_agg, cfg_ev_res);
        end

        //======================================================================
        // S15（WIRE-U1）：只带 tag 0x09 SER_AGG=1 ⇒ OK；EV_RES 保持 0、DECIM 保持 7
        //======================================================================
        pl[0]=8'h09; pl[1]=8'h01; pl[2]=8'h01; plen = 3;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S15_seragg_ack_valid");
        if (a_status === 8'h00) chk_pass("S15_seragg_ok");
        else chk_fail("S15_seragg_ok");
        k = 0;
        while ((cfg_ser_agg !== 2'd1) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if ((cfg_ser_agg === 2'd1) && (cfg_ev_res === 2'd0) && (cfg_ser_decim === 8'd7))
            chk_pass("S15_seragg_on_board_and_others_kept");
        else begin
            chk_fail("S15_seragg_on_board_and_others_kept");
            $display("  [E] agg=%0d ev_res=%0d decim=%0d", cfg_ser_agg, cfg_ev_res, cfg_ser_decim);
        end

        //======================================================================
        // S17（★SCCB 集成）：SET_PARAM tag 0x0B EXP_CAP=746=0x02EA
        //   · ACK CTRL_LEN=26、STATUS=OK、TLV 0x90@49..52 = 90 02 02 EA（写后读回）
        //   · downlink_cmd.o_exp_cap 落地；clk_cam 域 sys_ctrl.cfg_exp_cap 落地
        //   · 重触发 toggle（cfg_exp_cap_upd）恰好翻 1 次 ⇒ sccb_patch 重跑一轮
        //======================================================================
        pl[0]=8'h0B; pl[1]=8'h02; pl[2]=8'h02; pl[3]=8'hEA; plen = 4;   // EXP_CAP=746
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S17_expcap_ack_valid");
        if (a_status === 8'h00) chk_pass("S17_expcap_status_ok");
        else begin chk_fail("S17_expcap_status_ok"); $display("  [E] status=%02x", a_status); end
        if (a_clen === 16'd26) chk_pass("S17_ack_clen26");
        else begin chk_fail("S17_ack_clen26"); $display("  [E] clen=%0d", a_clen); end
        if (histb(cur_pkt,49)===8'h90 && histb(cur_pkt,50)===8'd2 &&
            histb(cur_pkt,51)===8'h02 && histb(cur_pkt,52)===8'hEA)
            chk_pass("S17_ack_expcap_tlv_readback_746");
        else begin
            chk_fail("S17_ack_expcap_tlv_readback_746");
            $display("  [E] tlv@49=%02x @50=%02x @51=%02x @52=%02x",
                     histb(cur_pkt,49), histb(cur_pkt,50), histb(cur_pkt,51), histb(cur_pkt,52));
        end
        if (dl_exp_cap === 16'd746) chk_pass("S17_expcap_out_746");
        else begin chk_fail("S17_expcap_out_746"); $display("  [E] o_exp_cap=%0d", dl_exp_cap); end
        k = 0;
        while ((cfg_exp_cap !== 16'd746) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if (cfg_exp_cap === 16'd746) chk_pass("S17_expcap_on_board_746");
        else begin chk_fail("S17_expcap_on_board_746"); $display("  [E] cfg_exp_cap=%0d", cfg_exp_cap); end
        if (n_expcap_upd == 1) chk_pass("S17_rearm_toggle_once");
        else begin chk_fail("S17_rearm_toggle_once"); $display("  [E] n_upd=%0d", n_expcap_upd); end

        //======================================================================
        // S18（★SCCB 集成）：越界 ⇒ BAD_VALUE 且**整条不写**
        //   ① 0x0B=7000（>5904）+ 合法的 0x08 SER_DECIM=9 同条 ⇒ 两个都不写
        //   ② 0x0B=3（<4）⇒ BAD_VALUE，exp_cap 保持 746
        //======================================================================
        pl[0]=8'h0B; pl[1]=8'h02; pl[2]=8'h1B; pl[3]=8'h58;   // EXP_CAP=7000（越上界）
        pl[4]=8'h08; pl[5]=8'h01; pl[6]=8'h09;                // SER_DECIM=9（合法，应被整条拦下）
        plen = 7;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S18_expcap_hi_ack_valid");
        if (a_status === 8'h04) chk_pass("S18_expcap_hi_bad_value");
        else begin chk_fail("S18_expcap_hi_bad_value"); $display("  [E] status=%02x", a_status); end
        repeat (3000) @(posedge clk_cam);
        if ((cfg_exp_cap === 16'd746) && (cfg_ser_decim === 8'd7))
            chk_pass("S18_hi_whole_frame_not_written");
        else begin
            chk_fail("S18_hi_whole_frame_not_written");
            $display("  [E] cap=%0d decim=%0d（应保持 746/7）", cfg_exp_cap, cfg_ser_decim);
        end
        if (dl_exp_cap === 16'd746) chk_pass("S18_hi_out_kept_746");
        else begin chk_fail("S18_hi_out_kept_746"); $display("  [E] o_exp_cap=%0d", dl_exp_cap); end

        pl[0]=8'h0B; pl[1]=8'h02; pl[2]=8'h00; pl[3]=8'h03; plen = 4;   // EXP_CAP=3（越下界）
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S18_expcap_lo_ack_valid");
        if (a_status === 8'h04) chk_pass("S18_expcap_lo_bad_value");
        else begin chk_fail("S18_expcap_lo_bad_value"); $display("  [E] status=%02x", a_status); end
        repeat (3000) @(posedge clk_cam);
        if ((cfg_exp_cap === 16'd746) && (n_expcap_upd == 1))
            chk_pass("S18_lo_no_write_no_rearm");
        else begin
            chk_fail("S18_lo_no_write_no_rearm");
            $display("  [E] cap=%0d n_upd=%0d（应保持 746/1）", cfg_exp_cap, n_expcap_upd);
        end

        //======================================================================
        // S19（★SCCB 集成）：边界值 4 与 5904 都被接受（值域闭合），
        //   且"按存在写"：不带 0x0B 的 SET_PARAM 不改 exp_cap、不重触发
        //======================================================================
        pl[0]=8'h0B; pl[1]=8'h02; pl[2]=8'h00; pl[3]=8'h04; plen = 4;   // 下界 4
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S19_expcap_min_ack");
        if (a_status === 8'h00) chk_pass("S19_expcap_min4_ok");
        else begin chk_fail("S19_expcap_min4_ok"); $display("  [E] status=%02x", a_status); end
        pl[0]=8'h0B; pl[1]=8'h02; pl[2]=8'h17; pl[3]=8'h10; plen = 4;   // 上界 5904
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S19_expcap_max_ack");
        if (a_status === 8'h00) chk_pass("S19_expcap_max5904_ok");
        else begin chk_fail("S19_expcap_max5904_ok"); $display("  [E] status=%02x", a_status); end
        k = 0;
        while ((cfg_exp_cap !== 16'd5904) && (k < 20000)) begin @(posedge clk_cam); k = k + 1; end
        if ((cfg_exp_cap === 16'd5904) && (n_expcap_upd == 3))
            chk_pass("S19_expcap_max_on_board_rearm3");
        else begin
            chk_fail("S19_expcap_max_on_board_rearm3");
            $display("  [E] cap=%0d n_upd=%0d（应 5904/3）", cfg_exp_cap, n_expcap_upd);
        end
        // 不带 0x0B、且 THETA 等值（777）⇒ 零副作用，TLV 0x90 仍读回 0x1710
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=8'h03; pl[3]=8'h09; plen = 4;
        send_cmd(8'h01, 0);
        wait_ack(8'h01, "S19_absent_expcap_ack");
        if ((a_status === 8'h00) && (histb(cur_pkt,49)===8'h90) &&
            (histb(cur_pkt,51)===8'h17) && (histb(cur_pkt,52)===8'h10) &&
            (n_expcap_upd == 3))
            chk_pass("S19_absent_expcap_kept_no_rearm");
        else begin
            chk_fail("S19_absent_expcap_kept_no_rearm");
            $display("  [E] st=%02x tlv@49=%02x %02x%02x n_upd=%0d",
                     a_status, histb(cur_pkt,49), histb(cur_pkt,51), histb(cur_pkt,52), n_expcap_upd);
        end

        //======================================================================
        // S16（WIRE-U1 §5.1 L2）：合法下行帧脉冲 o_dl_accepted 计数 ≥ 本轮命令数
        //======================================================================
        if (n_dl_acc >= 8) chk_pass("S16_dl_accepted_pulses");
        else begin
            chk_fail("S16_dl_accepted_pulses");
            $display("  [E] n_dl_acc=%0d", n_dl_acc);
        end

        //======================================================================
        // S11：TIME_SYNC_REQ 转发（FIRST_CAL_US=1500 µs ⇒ 等 REQ 出现）
        //======================================================================
        k = 0;
        while ((cal_req_seen == 1'b0) && (k < 400000)) begin @(posedge clk_eth); k = k + 1; end
        if (cal_req_seen) chk_pass("S11_time_sync_req_seen");
        else              chk_fail("S11_time_sync_req_seen");
        // 历史里应有 OPCODE=0x83 且 CTRL_LEN=6 的包（载荷 = t2）
        // ★ 轮询等待：cal_req_seen 只说明 ts_gen 拉了请求，构包+入档还要几十拍
        begin : scan_req
            integer found;
            found = -1;
            k = 0;
            while ((found < 0) && (k < 400000)) begin
                @(posedge clk_eth);
                for (j = 0; j < n_pkts; j = j + 1)
                    if ((op_hist[j] === 8'h83) && (clen_hist[j] == 6)) found = j;
                k = k + 1;
            end
            if (found >= 0) chk_pass("S11_req_pkt_format");
            else            chk_fail("S11_req_pkt_format");
        end

        //======================================================================
        // S12：周期心跳（HEARTBEAT_CYC=200k 拍 = 1.6 ms）
        //======================================================================
        k = 0;
        while ((hb_seen == 1'b0) && (k < 400000)) begin @(posedge clk_eth); k = k + 1; end
        if (hb_seen) chk_pass("S12_heartbeat_0xF0");
        else         chk_fail("S12_heartbeat_0xF0");

        $display("INFO pkts=%0d acks=%0d crc_fail=%0d bad_op=%0d reject=%0d mode=%0d theta=%0d mindl=%0d even=%0d",
                 n_pkts, n_ack_hist, cnt_crc_fail, cnt_bad_op, cnt_reject,
                 cfg_mode, cfg_theta, cfg_min_dl, cfg_ev_en);

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // REQ / 心跳监视
    //--------------------------------------------------------------------------
    integer hb_byte_cnt = 0;

    always @(posedge clk_eth) begin
        if (cal_req) cal_req_seen <= 1'b1;
        if (ctrl_wr_en) begin
            hb_byte_cnt = hb_byte_cnt + 1;
            if (hb_byte_cnt == 25) begin           // OPCODE 字节（0 起，第 25 字节 = idx24）
                if (ctrl_data === 8'hF0) hb_seen <= 1'b1;
                hb_byte_cnt = 0;
            end
        end
        else if (ctrl_commit) hb_byte_cnt = 0;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #20000000;                       // 20 ms 仿真时间上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
