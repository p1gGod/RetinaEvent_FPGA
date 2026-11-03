//==============================================================================
// tb_uart_link.v —— 串口链路 + 共用下行解析器集成仿真（判据①：串口下行命令进
//                    共用解析器 / 三路仲裁 / 遥测帧与 ASCII / 波特参数化）
//
// 判据：
//   L1  遥测帧（AA 55 54 4D + 16 B 载荷 + CRC8）逐字节 + ASCII 行逐字节
//   L2  'B'(0x42) 立即补发一帧遥测（RX 通路可用）
//   L3  事件帧字节流逐字节按序发出（uart_ev_tap 字节源契约）
//   L4  ★ 串口下行 SET_PARAM(tag 0x08 SER_DECIM=7) 进**共用解析器** downlink_cmd：
//       ACK(OPCODE=01/STATUS=0/CTRL_LEN=26，含 0x91 SER_BAUD_STATE) 经 CTRL 通路回串口，CRC16 正确，
//       且解析器写通道 o_ser_decim/o_ser_decim_upd 实际变化
//   L5  ★ 串口下行 GET_STATUS(0x04) → ACK CTRL_LEN=71（含 0x8D/0x8E/0x8F/0x90/0x91/★0x92）
//   L6  ★ 优先级新契约（2026-10-17 事件帧截断修复后）：AR_EV 内不再切去 AR_CT，
//       CTRL 只在**帧边界**受理 ⇒ 事件帧 N 字节必须在线路上连续（无任何插队字节），
//       ACK 整帧只能落在事件帧之前或之后，二者不得交叠
//   L7  流模式：串口帧间零散字节（'B' 等）不计 dlReject
//   L8  波特参数化：115200 / 460800 / 921600 实测字节周期 = 10/BAUD（±2%）
//==============================================================================
`timescale 1ns / 1ps

module tb_uart_link;

    //--------------------------------------------------------------------------
    // 时钟 / 复位
    //--------------------------------------------------------------------------
    reg clk_cam = 1'b0;
    reg clk_eth = 1'b0;
    always #10 clk_cam = ~clk_cam;      // 50 MHz
    always #4  clk_eth = ~clk_eth;      // 125 MHz

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // 遥测统计（喂给 instance A / B）
    //--------------------------------------------------------------------------
    reg  [23:0] st_ev  = 24'd12345;
    reg  [15:0] st_act = 16'd32768;
    reg  [23:0] st_cr  = 24'd876;
    reg  [31:0] st_fr  = 32'd4242;
    reg         st_mode= 1'b1;
    reg  [3:0]  st_key = 4'h5;
    reg         st_en  = 1'b1;

    //--------------------------------------------------------------------------
    // instance B 的事件帧字节源（模拟 uart_ev_tap 的 o_frdy/o_fbusy/o_fvalid/i_fack）
    //--------------------------------------------------------------------------
    reg [7:0]  evbuf [0:511];
    integer    evlen = 0;
    reg        ev_req = 1'b0;           // TB 置 1 = 有待发帧
    wire       ev_frdy;
    wire       ev_fbusy_w, ev_fvalid_w, ev_fack_w, ev_fstart_w;
    wire [7:0] ev_fdata_w;

    assign ev_frdy = ev_req;

    reg [1:0]  evmodel;
    integer    ev_ptr;
    reg        ev_fbusy = 1'b0, ev_fvalid = 1'b0;
    reg [7:0]  ev_fdata = 8'd0;

    always @(posedge clk_cam or negedge rst_n) begin
        if (!rst_n) begin
            evmodel <= 2'd0; ev_ptr <= 0; ev_fbusy <= 1'b0; ev_fvalid <= 1'b0;
            ev_fdata <= 8'd0;
        end
        else case (evmodel)
            2'd0: if (ev_fstart_w) begin      // 被仲裁器选中，开始串出
                      ev_fbusy <= 1'b1; ev_ptr <= 0; evmodel <= 2'd1;
                      ev_req   <= 1'b0;         // ★ 选中即撤 frdy（否则重复发同一帧）
                  end
            2'd1: begin                        // 3 拍后数据有效（对齐 tap 的 BRAM 流水）
                      ev_fdata <= evbuf[0]; ev_fvalid <= 1'b1; evmodel <= 2'd2;
                  end
            default: begin
                      if (ev_fack_w) begin
                          if (ev_ptr == (evlen - 1)) begin
                              ev_fbusy <= 1'b0; ev_fvalid <= 1'b0; evmodel <= 2'd0;
                          end
                          else begin
                              ev_ptr  <= ev_ptr + 1;
                              ev_fdata<= evbuf[ev_ptr + 1];
                              ev_fvalid<= 1'b1;
                          end
                      end
                  end
        endcase
    end

    //--------------------------------------------------------------------------
    // DUT A：遥测/ASCII/'B'（TELEM_PERIOD_MS=1，BAUD=1 Mbps 提速）
    //--------------------------------------------------------------------------
    wire txd_a;
    reg  rxd_a = 1'b1;
    wire urx_a, uack_a;

    wire ctrlv_a, ctrle_a, ctrlr_a;
    wire [7:0] ctrld_a;

    uart_link #(
        .CLK_HZ(50000000), .BAUD(1000000), .OS(16), .TELEM_PERIOD_MS(1)
    ) uA (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(rxd_a), .uart_txd(txd_a),
        .i_stat_ev_per_frame(st_ev), .i_stat_activity_q16(st_act), .i_stat_cr_x10(st_cr),
        .i_stat_frame_cnt(st_fr), .i_stat_mode(st_mode), .i_key_pressed(st_key),
        .i_cfg_ev_en(st_en),
        .i_frdy(1'b0), .i_fbusy(1'b0), .i_fvalid(1'b0), .i_fdata(8'd0),
        .o_fack(), .o_fstart(),
        .i_ctrl_valid(1'b0), .i_ctrl_data(8'd0), .i_ctrl_eop(1'b0), .o_ctrl_rd_en(),
        .o_urx_valid(urx_a), .o_urx_data(), .i_urx_ack(uack_a),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(2'd0), .i_baud_pending(1'b0), .o_baud_cur()  // ★ WIRE-U2：本 TB 不切档
    );
    assign uack_a = 1'b1;

    //--------------------------------------------------------------------------
    // DUT B：事件帧 + CTRL（含 bridge + downlink_cmd + ts_gen）
    //--------------------------------------------------------------------------
    reg  rxd_b = 1'b1;
    wire txd_b;
    wire        ctrl_valid_b, ctrl_eop_b, ctrl_rd_en_b;
    wire [7:0]  ctrl_data_b;
    wire        ctrl_empty_eth_b;
    wire        urx_valid_b, urx_ack_b;
    wire [7:0]  urx_data_b;

    uart_link #(
        .CLK_HZ(50000000), .BAUD(1000000), .OS(16), .TELEM_PERIOD_MS(100000)
    ) uB (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(rxd_b), .uart_txd(txd_b),
        .i_stat_ev_per_frame(st_ev), .i_stat_activity_q16(st_act), .i_stat_cr_x10(st_cr),
        .i_stat_frame_cnt(st_fr), .i_stat_mode(st_mode), .i_key_pressed(st_key),
        .i_cfg_ev_en(st_en),
        .i_frdy(ev_frdy), .i_fbusy(ev_fbusy), .i_fvalid(ev_fvalid), .i_fdata(ev_fdata),
        .o_fack(ev_fack_w), .o_fstart(ev_fstart_w),
        .i_ctrl_valid(ctrl_valid_b), .i_ctrl_data(ctrl_data_b), .i_ctrl_eop(ctrl_eop_b),
        .o_ctrl_rd_en(ctrl_rd_en_b),
        .o_urx_valid(urx_valid_b), .o_urx_data(urx_data_b), .i_urx_ack(urx_ack_b),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(2'd0), .i_baud_pending(1'b0), .o_baud_cur()  // ★ WIRE-U2：本 TB 不切档
    );

    wire        dl_ctrl_wr_en, dl_ctrl_commit;
    wire [7:0]  dl_ctrl_data;
    wire        dl_rx_valid, dl_rx_stream, dl_rx_pkt_done;
    wire [7:0]  dl_rx_data;

    uart_dl_bridge #(.CTRL_DEPTH(256), .URX_DEPTH(256)) u_br (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .clk_eth(clk_eth), .rst_n_eth(rst_n),
        .i_ctrl_wr_en(dl_ctrl_wr_en), .i_ctrl_data(dl_ctrl_data),
        .i_ctrl_commit(dl_ctrl_commit), .o_ctrl_full(),
        .o_ctrl_empty_eth(ctrl_empty_eth_b),
        .i_ctrl_rd_en(ctrl_rd_en_b), .o_ctrl_valid(ctrl_valid_b),
        .o_ctrl_data(ctrl_data_b), .o_ctrl_eop(ctrl_eop_b),
        .i_urx_valid(urx_valid_b), .i_urx_data(urx_data_b), .o_urx_ack(urx_ack_b),
        .i_eth_valid(1'b0), .i_eth_data(8'd0), .o_eth_rd_en(),
        .i_eth_pkt_done(1'b0),
        .o_dl_valid(dl_rx_valid), .o_dl_data(dl_rx_data), .o_dl_stream(dl_rx_stream),
        .o_dl_pkt_done(dl_rx_pkt_done),
        .o_stat_urx_ovf(), .o_stat_ctrl_ovf()
    );

    wire        dl_accepted;
    wire [1:0]  dl_ser_agg;
    wire        dl_ser_agg_upd;
    wire [7:0]  dl_ser_decim;
    wire        dl_ser_decim_upd;
    wire [1:0]  dl_ev_res;
    wire        dl_ev_res_upd;
    wire [15:0] dl_ser_flush;
    wire        dl_ser_flush_upd;
    wire [23:0] dl_flush_cyc;
    wire [7:0]  dl_frame_decim;
    wire [15:0] cnt_crc_bad, cnt_bad_op, cnt_reject;

    wire        cal_req;  wire [15:0] cal_seq;  wire [47:0] board_ts;
    wire [47:0] ts_local, ts_aligned, offset_reg;
    wire        ts_valid, ts_cal, ts_stale;
    wire [15:0] rtt_us;
    wire [31:0] boot_id;
    wire        sync_matched;

    downlink_cmd #(
        .HEARTBEAT_CYC (125_000_000),       // 1 s（本 TB 内不出现心跳）
        .FW_VER        (16'h0003),
        .WIRE_VER_B    (8'h03)
    ) u_dl (
        .clk_eth(clk_eth), .rst_n_eth(rst_n),
        .i_rx_valid(dl_rx_valid), .i_rx_data(dl_rx_data), .o_rx_rd_en(),
        .i_rx_pkt_done(dl_rx_pkt_done),
        .i_rx_stream(dl_rx_stream),
        .i_net_state(2'd0), .i_net_chg(1'b0), .i_ser_drop(8'h00),
        .i_mode(2'd0), .i_ts_us(ts_aligned), .i_ts_local_us(ts_local),
        .i_ts_offset(offset_reg), .i_ts_valid(ts_valid), .i_ts_calibrated(ts_cal),
        .i_ts_stale(ts_stale), .i_rtt_us(rtt_us), .i_boot_id(boot_id),
        .i_frame_idx(16'd0), .i_drop_px(16'd0), .i_drop_ev(16'd0),
        .i_ev_en(1'b1),
        .i_act_byte(8'h00),          // ★ M4b：无动作（TLV 0x92 值 0x00）
        .i_cal_req(cal_req), .i_cal_seq(cal_seq), .i_board_ts(board_ts),
        .o_sync_matched(sync_matched),
        .o_theta(), .o_theta_upd(), .o_min_dl(), .o_min_dl_upd(),
        .o_mode_set(), .o_mode_set_upd(),
        .o_ev_en(), .o_ev_en_upd(),
        .o_frame_decim(dl_frame_decim), .o_ev_flush_cyc(dl_flush_cyc),
        .o_ev_res(dl_ev_res), .o_ev_res_upd(dl_ev_res_upd),
        .o_ser_decim(dl_ser_decim), .o_ser_decim_upd(dl_ser_decim_upd),
        .o_ser_agg(dl_ser_agg), .o_ser_agg_upd(dl_ser_agg_upd),
        .o_ser_flush_ms(dl_ser_flush), .o_ser_flush_upd(dl_ser_flush_upd),
        .o_dl_accepted(dl_accepted),
        .o_period_wr(), .o_period_s(), .o_force_cal(), .o_off_wr(), .o_off_data(),
        .o_ctrl_wr_en(dl_ctrl_wr_en), .o_ctrl_data(dl_ctrl_data),
        .o_ctrl_commit(dl_ctrl_commit),
        .i_ctrl_empty(ctrl_empty_eth_b),
        .o_stat_dl_crc_fail(cnt_crc_bad), .o_stat_dl_bad_opcode(cnt_bad_op),
        .o_stat_dl_reject(cnt_reject),
        .o_ser_baud_sel(), .o_ser_baud_commit()  // ★ WIRE-U2：切档通路本 TB 不测（tb_uart_baud 专测）
    );

    ts_gen #(
        .CLK_DIV(125), .FIRST_CAL_US(48'd100_000_000), .CAL_PERIOD_S(17'd600)
    ) u_ts (
        .clk_eth(clk_eth), .rst_n_eth(rst_n),
        .i_off_wr_en(1'b0), .i_off_data(48'd0), .i_period_wr_en(1'b0), .i_period_s(17'd600),
        .i_force_cal(1'b0), .i_sync_matched(1'b0),
        .o_cal_req(cal_req), .o_cal_seq(cal_seq), .o_board_ts_us(board_ts),
        .o_ts_local_us(ts_local), .o_ts_aligned_us(ts_aligned), .o_ts_valid(ts_valid),
        .o_ts_calibrated(ts_cal), .o_ts_stale(ts_stale), .o_offset_reg(offset_reg),
        .o_rtt_us(rtt_us), .o_boot_id(boot_id)
    );

    //==========================================================================
    // 波特参数化实例（只测字节周期）
    //==========================================================================
    wire txd_115, txd_460, txd_921;
    uart_link #(.CLK_HZ(50000000), .BAUD(115200), .OS(16), .TELEM_PERIOD_MS(1)) uC (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(1'b1), .uart_txd(txd_115),
        .i_stat_ev_per_frame(24'd1), .i_stat_activity_q16(16'd1), .i_stat_cr_x10(24'd1),
        .i_stat_frame_cnt(32'd1), .i_stat_mode(1'b0), .i_key_pressed(4'd0),
        .i_cfg_ev_en(1'b1),
        .i_frdy(1'b0), .i_fbusy(1'b0), .i_fvalid(1'b0), .i_fdata(8'd0), .o_fack(), .o_fstart(),
        .i_ctrl_valid(1'b0), .i_ctrl_data(8'd0), .i_ctrl_eop(1'b0), .o_ctrl_rd_en(),
        .o_urx_valid(), .o_urx_data(), .i_urx_ack(1'b1),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(2'd0), .i_baud_pending(1'b0), .o_baud_cur()  // ★ WIRE-U2：本 TB 不切档
    );
    uart_link #(.CLK_HZ(50000000), .BAUD(460800), .OS(16), .TELEM_PERIOD_MS(1)) uD (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(1'b1), .uart_txd(txd_460),
        .i_stat_ev_per_frame(24'd1), .i_stat_activity_q16(16'd1), .i_stat_cr_x10(24'd1),
        .i_stat_frame_cnt(32'd1), .i_stat_mode(1'b0), .i_key_pressed(4'd0),
        .i_cfg_ev_en(1'b1),
        .i_frdy(1'b0), .i_fbusy(1'b0), .i_fvalid(1'b0), .i_fdata(8'd0), .o_fack(), .o_fstart(),
        .i_ctrl_valid(1'b0), .i_ctrl_data(8'd0), .i_ctrl_eop(1'b0), .o_ctrl_rd_en(),
        .o_urx_valid(), .o_urx_data(), .i_urx_ack(1'b1),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(2'd0), .i_baud_pending(1'b0), .o_baud_cur()  // ★ WIRE-U2：本 TB 不切档
    );
    uart_link #(.CLK_HZ(50000000), .BAUD(921600), .OS(16), .TELEM_PERIOD_MS(1)) uE (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(1'b1), .uart_txd(txd_921),
        .i_stat_ev_per_frame(24'd1), .i_stat_activity_q16(16'd1), .i_stat_cr_x10(24'd1),
        .i_stat_frame_cnt(32'd1), .i_stat_mode(1'b0), .i_key_pressed(4'd0),
        .i_cfg_ev_en(1'b1),
        .i_frdy(1'b0), .i_fbusy(1'b0), .i_fvalid(1'b0), .i_fdata(8'd0), .o_fack(), .o_fstart(),
        .i_ctrl_valid(1'b0), .i_ctrl_data(8'd0), .i_ctrl_eop(1'b0), .o_ctrl_rd_en(),
        .o_urx_valid(), .o_urx_data(), .i_urx_ack(1'b1),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(2'd0), .i_baud_pending(1'b0), .o_baud_cur()  // ★ WIRE-U2：本 TB 不切档
    );

    // 起始位间隔统计（最小间隔 = 背靠背字节 = 10 bit）
    time tmin_115 = 99999999, tmin_460 = 99999999, tmin_921 = 99999999;
    time tlast_115, tlast_460, tlast_921;
    initial begin tlast_115 = 0; tlast_460 = 0; tlast_921 = 0; end

    always @(negedge txd_115) begin
        if (tlast_115 != 0) begin
            if (($time - tlast_115) < tmin_115) tmin_115 = $time - tlast_115;
        end
        tlast_115 = $time;
    end
    always @(negedge txd_460) begin
        if (tlast_460 != 0) begin
            if (($time - tlast_460) < tmin_460) tmin_460 = $time - tlast_460;
        end
        tlast_460 = $time;
    end
    always @(negedge txd_921) begin
        if (tlast_921 != 0) begin
            if (($time - tlast_921) < tmin_921) tmin_921 = $time - tlast_921;
        end
        tlast_921 = $time;
    end

    //==========================================================================
    // 串口接收（字节流捕获）
    //==========================================================================
    localparam real BIT_A_NS  = 1000.0;     // 1 Mbps
    localparam real BIT_B_NS  = 1000.0;     // instance B 同 1 Mbps

    reg [7:0] rxa [0:8191]; integer na = 0; integer rxa_err = 0;
    reg [7:0] rxb [0:8191]; integer nb = 0; integer rxb_err = 0;

    // ⚠️ 每个接收进程必须有**自己的**循环变量与字节暂存：
    //    两个 forever 并发交错时共享 db/ii 会把对方的位采样写坏（本 TB 实测踩过）
    integer iia, iib;
    integer nedge_b = 0;
    always @(negedge txd_b) nedge_b = nedge_b + 1;
    reg [7:0] dba, dbb;

    initial begin : rx_a
        forever begin
            @(negedge txd_a);
            #(BIT_A_NS * 1.5);
            for (iia = 0; iia < 8; iia = iia + 1) begin
                dba[iia] = txd_a;
                #(BIT_A_NS);
            end
            if (txd_a !== 1'b1) rxa_err = rxa_err + 1;
            if (na < 8191) begin rxa[na] = dba; na = na + 1; end
        end
    end

    initial begin : rx_b
        forever begin
            @(negedge txd_b);
            #(BIT_B_NS * 1.5);
            for (iib = 0; iib < 8; iib = iib + 1) begin
                dbb[iib] = txd_b;
                #(BIT_B_NS);
            end
            if (txd_b !== 1'b1) rxb_err = rxb_err + 1;
            if (nb < 8191) begin rxb[nb] = dbb; nb = nb + 1; end
        end
    end

    //==========================================================================
    // TB 侧发送（bit 级）
    //==========================================================================
    task send_byte_a; input [7:0] b; input real bitns; integer k; begin
        rxd_a = 1'b0; #(bitns);
        for (k = 0; k < 8; k = k + 1) begin rxd_a = b[k]; #(bitns); end
        rxd_a = 1'b1; #(bitns);
    end endtask

    task send_byte_b; input [7:0] b; input real bitns; integer k; begin
        rxd_b = 1'b0; #(bitns);
        for (k = 0; k < 8; k = k + 1) begin rxd_b = b[k]; #(bitns); end
        rxd_b = 1'b1; #(bitns);
    end endtask

    //==========================================================================
    // 工具：CRC
    //==========================================================================
    function [7:0] crc8f;
        input [7:0] crc; input [7:0] dat;
        integer j; reg [7:0] c;
        begin
            c = crc ^ dat;
            for (j = 0; j < 8; j = j + 1) c = c[7] ? ((c << 1) ^ 8'h07) : (c << 1);
            crc8f = c;
        end
    endfunction

    function [15:0] crc16f;
        input [15:0] crc; input [7:0] dat;
        integer j; reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (j = 0; j < 8; j = j + 1) c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16f = c;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 期望 ASCII 行（与 uart_telemetry 同格式）
    //--------------------------------------------------------------------------
    reg [7:0] exp_buf [0:255];
    integer   exp_len = 0;

    task put_ch; input [7:0] c; begin exp_buf[exp_len] = c; exp_len = exp_len + 1; end endtask
    task put_dec; input [31:0] v;
        integer k; reg [31:0] p; integer started; reg [7:0] dig; reg [31:0] vv;
        begin
            vv = v; started = 0; p = 32'd1000000000;
            for (k = 0; k < 10; k = k + 1) begin
                dig = 8'd0;
                while (vv >= p) begin vv = vv - p; dig = dig + 8'd1; end
                if ((dig != 8'd0) || (started != 0) || (k == 9)) begin
                    put_ch(8'h30 + dig);
                    started = 1;
                end
                p = p / 32'd10;
            end
        end
    endtask

    task build_exp; begin
        exp_len = 0;
        put_ch(8'h54); put_ch(8'h20); put_ch(8'h66); put_ch(8'h72); put_ch(8'h3D);
        put_dec(st_fr);
        put_ch(8'h20); put_ch(8'h65); put_ch(8'h76); put_ch(8'h3D); put_dec({8'b0, st_ev});
        put_ch(8'h20); put_ch(8'h61); put_ch(8'h63); put_ch(8'h74); put_ch(8'h3D); put_dec({16'b0, st_act});
        put_ch(8'h20); put_ch(8'h63); put_ch(8'h72); put_ch(8'h3D); put_dec({8'b0, st_cr});
        put_ch(8'h20); put_ch(8'h6D); put_ch(8'h6F); put_ch(8'h64); put_ch(8'h65); put_ch(8'h3D); put_dec({31'b0, st_mode});
        put_ch(8'h20); put_ch(8'h6B); put_ch(8'h65); put_ch(8'h79); put_ch(8'h3D); put_dec({28'b0, st_key});
        put_ch(8'h20); put_ch(8'h65); put_ch(8'h6E); put_ch(8'h3D); put_dec({31'b0, st_en});
        put_ch(8'h0D); put_ch(8'h0A);
    end endtask

    function integer find_tel;         // 找 instance A 里最后一个完整遥测帧起点
        input integer dummy;
        integer j, m, found;
        begin
            found = -1;
            for (j = 0; j <= (na - 22); j = j + 1)
                if (rxa[j] === 8'hAA && rxa[j+1] === 8'h55 && rxa[j+2] === 8'h54 && rxa[j+3] === 8'h4D)
                    if ((j + 21 + 60) <= na)     // 该帧 + ASCII 行都已收全
                        found = j;
            find_tel = found;
        end
    endfunction

    function [7:0] exp_pay; input [3:0] k; begin
        case (k)
            4'd0 : exp_pay = st_fr[31:24];
            4'd1 : exp_pay = st_fr[23:16];
            4'd2 : exp_pay = st_fr[15:8];
            4'd3 : exp_pay = st_fr[7:0];
            4'd4 : exp_pay = st_ev[23:16];
            4'd5 : exp_pay = st_ev[15:8];
            4'd6 : exp_pay = st_ev[7:0];
            4'd7 : exp_pay = st_act[15:8];
            4'd8 : exp_pay = st_act[7:0];
            4'd9 : exp_pay = st_cr[23:16];
            4'd10: exp_pay = st_cr[15:8];
            4'd11: exp_pay = st_cr[7:0];
            4'd12: exp_pay = {7'b0, st_mode};
            4'd13: exp_pay = {4'b0, st_key};
            4'd14: exp_pay = {7'b0, st_en};
            default: exp_pay = 8'h01;
        endcase
    end endfunction

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer b0, j, k, nrep;
    reg [7:0] crc_c;
    reg [7:0] cmd [0:31];
    integer   clen;
    integer   ecnt_a, ecnt_b;           // 事件帧字节在 rxb 中的命中计数
    integer   ev_first_idx, ev_last_idx;
    integer   ack_idx, ack_clen, ack_op, ack_st;
    integer   ev_first, ack_len_b;        // ★ L6 新契约：连续帧起点 / ACK 整帧长度
    reg [15:0] acrc_c, acrc_e;
    reg        ok;
    reg [7:0]  ev_last_byte;

    // 构造下行命令
    task build_cmd; input [7:0] op; input integer plen; begin
        cmd[0]=8'hF0; cmd[1]=8'h5A; cmd[2]=8'hA5; cmd[3]=8'h31;
        cmd[4]=8'h03; cmd[5]=op; cmd[6]=8'h00; cmd[7]=8'h01;
        cmd[8]=(plen>>8); cmd[9]=plen[7:0];
        clen = 10 + plen;
        begin : cc
            reg [15:0] c; integer q;
            c = 16'hFFFF;
            for (q = 0; q < clen; q = q + 1) c = crc16f(c, cmd[q]);
            cmd[clen] = c[15:8]; cmd[clen+1] = c[7:0];
            clen = clen + 2;
        end
    end endtask

    task send_cmd_b; input real bitns; integer q; begin
        for (q = 0; q < clen; q = q + 1) send_byte_b(cmd[q], bitns);
    end endtask

    initial begin
        //======================================================================
        // 复位 + 事件帧准备
        //======================================================================
        repeat (10) @(negedge clk_cam);
        rst_n <= 1'b1;
        repeat (20) @(negedge clk_cam);

        // L1：周期遥测（instance A）
        wait (na >= 130);
        b0 = find_tel(0);
        if (b0 < 0) chk_fail("L1_tel_found");
        else begin
            chk_pass("L1_tel_found");
            if ((rxa[b0]===8'hAA)&&(rxa[b0+1]===8'h55)&&(rxa[b0+2]===8'h54)&&(rxa[b0+3]===8'h4D))
                chk_pass("L1_tel_magic");
            else chk_fail("L1_tel_magic");
            ok = 1;
            for (j = 0; j < 16; j = j + 1)
                if (rxa[b0+4+j] !== exp_pay(j[3:0])) ok = 0;
            if (ok != 0) chk_pass("L1_tel_payload");
            else begin
                chk_fail("L1_tel_payload");
                $display("  [E] payload[0..7]=%02x %02x %02x %02x %02x %02x %02x %02x",
                         rxa[b0+4],rxa[b0+5],rxa[b0+6],rxa[b0+7],rxa[b0+8],rxa[b0+9],rxa[b0+10],rxa[b0+11]);
            end
            crc_c = 8'h00;
            for (j = 0; j < 20; j = j + 1) crc_c = crc8f(crc_c, rxa[b0+j]);
            if (crc_c === rxa[b0+20]) chk_pass("L1_tel_crc8");
            else chk_fail("L1_tel_crc8");
            build_exp;
            ok = 1;
            for (j = 0; j < exp_len; j = j + 1)
                if (rxa[b0+21+j] !== exp_buf[j]) begin
                    if (ok != 0) $display("  [E] ascii 首错 idx=%0d got=%02x exp=%02x (exp_len=%0d)",
                                          j, rxa[b0+21+j], exp_buf[j], exp_len);
                    ok = 0;
                end
            if (ok != 0) chk_pass("L1_tel_ascii");
            else begin
                chk_fail("L1_tel_ascii");
                $display("  [E] ascii[0..7]=%02x %02x %02x %02x %02x %02x %02x %02x",
                         rxa[b0+21],rxa[b0+22],rxa[b0+23],rxa[b0+24],rxa[b0+25],rxa[b0+26],rxa[b0+27],rxa[b0+28]);
            end
        end

        // L2：'B' 立即补发
        nrep = na;
        send_byte_a(8'h42, BIT_A_NS);
        k = 0;
        while ((na < (nrep + 25)) && (k < 40000)) begin @(negedge clk_cam); k = k + 1; end
        if (na >= (nrep + 25)) chk_pass("L2_cmd_b_resend");
        else chk_fail("L2_cmd_b_resend");

        // L3：事件帧按序串出（instance B）
        evlen = 100;
        for (j = 0; j < evlen; j = j + 1) evbuf[j] = 8'hE0 + j[7:0];
        ev_req <= 1'b1;
        k = 0;
        while ((nb < evlen) && (k < 200000)) begin @(negedge clk_cam); k = k + 1; end
        ecnt_b = 0;
        for (j = 0; j < evlen; j = j + 1)
            if (rxb[j] === (8'hE0 + j[7:0])) ecnt_b = ecnt_b + 1;
        if (ecnt_b == evlen) chk_pass("L3_event_bytes_in_order");
        else begin
            chk_fail("L3_event_bytes_in_order");
            $display("  [E] 命中 %0d/%0d nb=%0d", ecnt_b, evlen, nb);
            $display("  [E] rxb[0..15]=%02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x",
                     rxb[0],rxb[1],rxb[2],rxb[3],rxb[4],rxb[5],rxb[6],rxb[7],
                     rxb[8],rxb[9],rxb[10],rxb[11],rxb[12],rxb[13],rxb[14],rxb[15]);
        end

        //======================================================================
        // L4：串口下行 SET_PARAM(tag 0x08 SER_DECIM=7) → 共用解析器 + ACK 回串口
        //======================================================================
        ev_req <= 1'b0;                       // 让事件帧停下，线路干净
        repeat (200) @(negedge clk_cam);
        nb = 0;
        // payload = 08 01 07
        build_cmd(8'h01, 3);
        cmd[10]=8'h08; cmd[11]=8'h01; cmd[12]=8'h07;
        begin : fix_crc
            reg [15:0] c; integer q;
            c = 16'hFFFF;
            for (q = 0; q < 13; q = q + 1) c = crc16f(c, cmd[q]);
            cmd[13] = c[15:8]; cmd[14] = c[7:0];
            clen = 15;
        end
        send_cmd_b(BIT_B_NS);
        k = 0;
        while ((nb < 62) && (k < 200000)) begin @(negedge clk_cam); k = k + 1; end   // 58 B + 余量
        // 找 CTRL 帧（F0 5A A5 30）
        ack_idx = -1;
        for (j = 0; j <= (nb - 30); j = j + 1)
            if (ack_idx < 0 && rxb[j]===8'hF0 && rxb[j+1]===8'h5A && rxb[j+2]===8'hA5 &&
                rxb[j+3]===8'h30 && rxb[j+24]===8'h01)
                ack_idx = j;
        if (ack_idx >= 0) begin
            chk_pass("L4_ack_present_over_uart");
            ack_clen = {rxb[ack_idx+28], rxb[ack_idx+29]};
            ack_op   = rxb[ack_idx+24];
            ack_st   = rxb[ack_idx+25];
            if (ack_clen === 26) chk_pass("L4_ack_ctrl_len_26");
            else begin
                chk_fail("L4_ack_ctrl_len_26");
                $display("  [E] clen=%0d", ack_clen);
            end
            if ((ack_op === 8'h01) && (ack_st === 8'h00)) chk_pass("L4_ack_op_status");
            else chk_fail("L4_ack_op_status");
            acrc_c = 16'hFFFF;
            for (j = 0; j < (30 + ack_clen); j = j + 1) acrc_c = crc16f(acrc_c, rxb[ack_idx+j]);
            acrc_e = {rxb[ack_idx+30+ack_clen], rxb[ack_idx+31+ack_clen]};
            if (acrc_c === acrc_e) chk_pass("L4_ack_crc16");
            else begin
                chk_fail("L4_ack_crc16");
                $display("  [E] crc %04x/%04x", acrc_c, acrc_e);
            end
            // SER_STATE 第 1 字节（TLV 0x8E 的值[0] = SER_DECIM）应为 7
            if ((rxb[ack_idx+30+14]===8'h8E) && (rxb[ack_idx+30+16]===8'd7))
                chk_pass("L4_ack_ser_decim_readback7");
            else begin
                chk_fail("L4_ack_ser_decim_readback7");
                $display("  [E] tlv=%02x %02x %02x", rxb[ack_idx+44], rxb[ack_idx+45], rxb[ack_idx+46]);
            end
            // ★ SCCB 集成：TLV 0x90 EXP_CAP_STATE（offset 30+19..22，默认 0x1710）
            if ((rxb[ack_idx+30+19]===8'h90) && (rxb[ack_idx+30+20]===8'd2) &&
                (rxb[ack_idx+30+21]===8'h17) && (rxb[ack_idx+30+22]===8'h10))
                chk_pass("L4_ack_expcap_tlv_default");
            else begin
                chk_fail("L4_ack_expcap_tlv_default");
                $display("  [E] tlv@49=%02x %02x %02x%02x",
                         rxb[ack_idx+49], rxb[ack_idx+50], rxb[ack_idx+51], rxb[ack_idx+52]);
            end
            // ★ WIRE-U2：TLV 0x91 SER_BAUD_STATE（offset 30+23..26，默认档 0 = 115200）
            if ((rxb[ack_idx+30+23]===8'h91) && (rxb[ack_idx+30+24]===8'd1) &&
                (rxb[ack_idx+30+25]===8'd0))
                chk_pass("L4_ack_baud_tlv_default");
            else begin
                chk_fail("L4_ack_baud_tlv_default");
                $display("  [E] baud tlv@53=%02x %02x %02x",
                         rxb[ack_idx+53], rxb[ack_idx+54], rxb[ack_idx+55]);
            end
        end
        else chk_fail("L4_ack_present_over_uart");
        // 解析器写通道实际变化
        k = 0;
        while (((dl_ser_decim !== 8'd7) || (dl_ser_decim_upd !== 1'b1)) && (k < 20000)) begin
            @(posedge clk_eth); k = k + 1;
        end
        if (dl_ser_decim === 8'd7) chk_pass("L4_parser_write_landed");
        else begin
            chk_fail("L4_parser_write_landed");
            $display("  [E] o_ser_decim=%0d", dl_ser_decim);
        end
        if (dl_ser_decim_upd === 1'b1) chk_pass("L4_parser_toggle");
        else chk_fail("L4_parser_toggle");

        //======================================================================
        // L5：串口下行 GET_STATUS → ACK CTRL_LEN=71（含 0x8D/0x8E/0x8F/0x90/0x91/★0x92）
        //======================================================================
        nb = 0;
        build_cmd(8'h04, 0);
        send_cmd_b(BIT_B_NS);
        // ★ 不能等固定字节数：instance B 的 ASCII 遥测行（约 70~90 B）会插在 ACK 之前，
        //   ACK 起点随遥测相位漂移 ⇒ 改成像 L6 那样轮询扫 ACK 头（F0 5A A5 30 + opcode 04）。
        ack_idx = -1;
        k = 0;
        while ((ack_idx < 0) && (k < 400000)) begin
            @(negedge clk_cam); k = k + 1;
            if (((k % 200) == 0) && (nb >= 40)) begin : l5_scan
                for (j = 0; j <= (nb - 40); j = j + 1)
                    if (ack_idx < 0 && rxb[j]===8'hF0 && rxb[j+1]===8'h5A && rxb[j+2]===8'hA5 &&
                        rxb[j+3]===8'h30 && rxb[j+24]===8'h04)
                        ack_idx = j;
            end
        end
        // 等这条 103 B 的 ACK 整帧收完
        k = 0;
        while ((ack_idx >= 0) && (nb < (ack_idx + 107)) && (k < 200000)) begin
            @(negedge clk_cam); k = k + 1;
        end
        if (ack_idx >= 0) begin
            chk_pass("L5_getstatus_ack");
            ack_clen = {rxb[ack_idx+28], rxb[ack_idx+29]};
            if (ack_clen === 71) chk_pass("L5_clen71");
            else begin
                chk_fail("L5_clen71");
                $display("  [E] clen=%0d", ack_clen);
            end
            if ((rxb[ack_idx+30+50]===8'h8D) && (rxb[ack_idx+30+53]===8'h8E) &&
                (rxb[ack_idx+30+58]===8'h8F)) chk_pass("L5_new_tlvs_present");
            else begin
                chk_fail("L5_new_tlvs_present");
                $display("  [E] tlv@50=%02x @53=%02x @58=%02x",
                         rxb[ack_idx+80], rxb[ack_idx+83], rxb[ack_idx+88]);
            end
            // ★ SCCB 集成：TLV 0x90 EXP_CAP_STATE（offset 30+61..64，默认 0x1710）
            if ((rxb[ack_idx+30+61]===8'h90) && (rxb[ack_idx+30+62]===8'd2) &&
                (rxb[ack_idx+30+63]===8'h17) && (rxb[ack_idx+30+64]===8'h10))
                chk_pass("L5_expcap_tlv_default");
            else begin
                chk_fail("L5_expcap_tlv_default");
                $display("  [E] tlv@91=%02x %02x %02x%02x",
                         rxb[ack_idx+91], rxb[ack_idx+92], rxb[ack_idx+93], rxb[ack_idx+94]);
            end
            // ★ WIRE-U2：TLV 0x91 SER_BAUD_STATE（offset 30+65..68，档 0）
            if ((rxb[ack_idx+30+65]===8'h91) && (rxb[ack_idx+30+66]===8'd1) &&
                (rxb[ack_idx+30+67]===8'd0))
                chk_pass("L5_baud_tlv_default");
            else begin
                chk_fail("L5_baud_tlv_default");
                $display("  [E] baud tlv@95=%02x %02x %02x",
                         rxb[ack_idx+95], rxb[ack_idx+96], rxb[ack_idx+97]);
            end
            // ★ M4b：TLV 0x92 ACTION_STATE（offset 30+68..70，无动作 ⇒ 92 01 00）
            if ((rxb[ack_idx+30+68]===8'h92) && (rxb[ack_idx+30+69]===8'd1) &&
                (rxb[ack_idx+30+70]===8'h00))
                chk_pass("L5_action_tlv_zero");
            else begin
                chk_fail("L5_action_tlv_zero");
                $display("  [E] action tlv@98=%02x %02x %02x",
                         rxb[ack_idx+98], rxb[ack_idx+99], rxb[ack_idx+100]);
            end
            acrc_c = 16'hFFFF;
            for (j = 0; j < (30 + ack_clen); j = j + 1) acrc_c = crc16f(acrc_c, rxb[ack_idx+j]);
            acrc_e = {rxb[ack_idx+30+ack_clen], rxb[ack_idx+31+ack_clen]};
            if (acrc_c === acrc_e) chk_pass("L5_crc16");
            else chk_fail("L5_crc16");
        end
        else begin
            chk_fail("L5_getstatus_ack");
            $display("  [E] 未扫到 GET_STATUS ACK（nb=%0d）", nb);
        end

        //======================================================================
        // L6：优先级 —— 事件帧整帧不可被 CTRL 打断（2026-10-17 修复后的新契约）
        //   修复内容：AR_EV 内不再因 ct_hold 切去 AR_CT（切走再回来会把 CTRL 字节
        //   插进帧中部，主机按 EV_LEN+CRC16 校验整帧必坏）；CTRL 只在 AR_IDLE 的
        //   帧边界受理。故断言：
        //     ① 200 B 事件帧在线上**连续**（中间无任何插队字节）—— 强断言
        //     ② ACK 整帧落在事件帧之前**或**之后，绝不与帧交叠
        //   旧断言"ACK 起点早于事件帧最后一字节"= 允许中途插队，已被修复推翻，
        //   且其通过与否只取决于发命令时事件帧是否已开始（线路残留字节会影响
        //   nb 阈值的满足时刻），本质上不可判定。
        //======================================================================
        evlen = 200;
        for (j = 0; j < evlen; j = j + 1) evbuf[j] = 8'hA0 + j[7:0];
        nb = 0;
        ev_req <= 1'b1;
        // ★ 先等"真的有一帧事件数据在播"：用"连续事件字节命中数 ≥ 20"判定，
        //   而不是用总字节数（线路上的遥测/ASCII 残留会把总字节阈值提前满足）。
        k = 0;
        ecnt_b = 0;
        while ((ecnt_b < 20) && (k < 200000)) begin
            @(negedge clk_cam); k = k + 1;
            if ((k % 100) == 0) begin : l6_pre
                integer s2, q2, run, best2;
                best2 = 0;
                for (s2 = 0; s2 < nb; s2 = s2 + 1) begin
                    run = 0;
                    while ((s2 + run) < nb && (run < evlen) &&
                           (rxb[s2+run] === (8'hA0 + run[7:0]))) run = run + 1;
                    if (run > best2) best2 = run;
                end
                ecnt_b = (best2 > 20) ? 20 : best2;
            end
        end
        // 事件帧已在播 ⇒ 插入下行命令，其 ACK 必须等到帧边界
        build_cmd(8'h04, 0);
        send_cmd_b(BIT_B_NS);
        // ★ 等"连续事件帧"与"ACK 帧"都过线（轮询扫描，不依赖字节数阈值）
        k = 0;
        ev_first = -1;
        ack_idx  = -1;
        while (((ev_first < 0) || (ack_idx < 0)) && (k < 800000)) begin
            @(negedge clk_cam); k = k + 1;
            if ((k % 500) == 0) begin : l6_scan
                integer s3, q3, hit3;
                ev_first = -1;
                for (s3 = 0; s3 <= (nb - evlen); s3 = s3 + 1) begin
                    hit3 = 1;
                    for (q3 = 0; q3 < evlen; q3 = q3 + 1) begin
                        if (rxb[s3+q3] !== (8'hA0 + q3[7:0])) begin
                            hit3 = 0;
                            q3   = evlen;
                        end
                    end
                    if ((hit3 != 0) && (ev_first < 0)) ev_first = s3;
                end
                ack_idx = -1;
                for (s3 = 0; s3 <= (nb - 40); s3 = s3 + 1)
                    if (ack_idx < 0 && rxb[s3]===8'hF0 && rxb[s3+1]===8'h5A &&
                        rxb[s3+2]===8'hA5 && rxb[s3+3]===8'h30 && rxb[s3+24]===8'h04)
                        ack_idx = s3;
            end
        end
        ev_req <= 1'b0;
        ev_last_idx = (ev_first >= 0) ? (ev_first + evlen - 1) : (-1);
        // ① 事件帧整帧连续（无插队字节）
        if (ev_first >= 0) chk_pass("L6_event_frame_contiguous");
        else begin
            chk_fail("L6_event_frame_contiguous");
            $display("  [E] 未找到连续 %0d B 事件帧（nb=%0d）", evlen, nb);
        end
        // ② ACK 整帧不与事件帧交叠 + CRC16 正确
        if (ack_idx >= 0) begin
            ack_clen  = {rxb[ack_idx+28], rxb[ack_idx+29]};
            ack_len_b = 30 + ack_clen + 2;
            if ((ev_first < 0) || ((ack_idx + ack_len_b) <= ev_first) || (ack_idx > ev_last_idx))
                chk_pass("L6_ack_not_inside_event_frame");
            else begin
                chk_fail("L6_ack_not_inside_event_frame");
                $display("  [E] ack[%0d..%0d] 交叠事件帧[%0d..%0d]",
                         ack_idx, ack_idx + ack_len_b - 1, ev_first, ev_last_idx);
            end
            acrc_c = 16'hFFFF;
            for (j = 0; j < (30 + ack_clen); j = j + 1) acrc_c = crc16f(acrc_c, rxb[ack_idx+j]);
            acrc_e = {rxb[ack_idx+30+ack_clen], rxb[ack_idx+31+ack_clen]};
            if (acrc_c === acrc_e) chk_pass("L6_ack_crc16");
            else begin
                chk_fail("L6_ack_crc16");
                $display("  [E] crc %04x/%04x clen=%0d", acrc_c, acrc_e, ack_clen);
            end
        end
        else begin
            chk_fail("L6_ack_present");
            $display("  [E] 事件帧后未见 ACK（nb=%0d ev_first=%0d）", nb, ev_first);
        end
        // ③ 事件帧全部字节都出现在线上
        begin : l6_sub
            integer idx, cnt, bp;
            idx = 0; cnt = 0;
            for (bp = 0; bp < nb; bp = bp + 1)
                if (idx < evlen && rxb[bp] === (8'hA0 + idx[7:0])) begin
                    idx = idx + 1; cnt = cnt + 1;
                end
            ecnt_b = cnt;
        end
        if (ecnt_b == evlen) chk_pass("L6_event_frame_complete");
        else begin
            chk_fail("L6_event_frame_complete");
            $display("  [E] 命中 %0d/%0d", ecnt_b, evlen);
        end

        //======================================================================
        // L7：流模式 —— 帧间杂散字节（'B'）不计 dlReject（设计 §3.7）
        //======================================================================
        send_byte_b(8'h42, BIT_B_NS);          // 串口链路上的单字节命令
        repeat (4000) @(negedge clk_cam);
        if (cnt_reject === 16'd0) chk_pass("L7_stream_no_reject");
        else begin
            chk_fail("L7_stream_no_reject");
            $display("  [E] reject=%0d", cnt_reject);
        end
        if (cnt_crc_bad === 16'd0) chk_pass("L7_no_bad_crc");
        else chk_fail("L7_no_bad_crc");

        //======================================================================
        // L8：波特参数化（最小起始位间隔 = 10 bit）
        //======================================================================
        // 相邻下落沿最小间隔 = 2 bit（0-1-0 图案）：115200 → 17361 ns
        if ((tmin_115 > 16840) && (tmin_115 < 17890)) chk_pass("L8_baud_115200");
        else begin
            chk_fail("L8_baud_115200");
            $display("  [E] tmin_115=%0t ns（期望 17361 = 2 bit）", tmin_115);
        end
        if ((tmin_460 > 4210) && (tmin_460 < 4473)) chk_pass("L8_baud_460800");
        else begin
            chk_fail("L8_baud_460800");
            $display("  [E] tmin_460=%0t ns（期望 4340 = 2 bit）", tmin_460);
        end
        if ((tmin_921 > 2105) && (tmin_921 < 2237)) chk_pass("L8_baud_921600");
        else begin
            chk_fail("L8_baud_921600");
            $display("  [E] tmin_921=%0t ns（期望 2170 = 2 bit）", tmin_921);
        end

        $display("INFO na=%0d nb=%0d rxa_err=%0d rxb_err=%0d rej=%0d badcrc=%0d decim=%0d",
                 na, nb, rxa_err, rxb_err, cnt_reject, cnt_crc_bad, dl_ser_decim);
        if (rxa_err == 0) chk_pass("L1_framing_ok"); else chk_fail("L1_framing_ok");
        if (rxb_err == 0) chk_pass("L3_framing_ok"); else chk_fail("L3_framing_ok");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #200000000;                         // 200 ms
        $display("TEST_RESULT=FAIL (timeout) na=%0d nb=%0d", na, nb);
        $finish;
    end

endmodule
