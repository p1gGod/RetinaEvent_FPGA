//==============================================================================
// tb_uart_baud.v —— WIRE-U2 串口 4 档运行时波特率切换（task-19）验收 TB
//
// 契约（docs/05_experiments/串口提速与屏上状态_20261017/接口约定.md §1）：
//   · 档位 0..3 = 115200 / 230400 / 460800 / 921600，复位默认档 0；
//   · 下行 SET_PARAM tag 0x0C len=1（值 0..3）；
//   · 上行 TLV 0x91 SER_BAUD_STATE len=1（SET_PARAM ACK 末尾、GET_STATUS ACK 末尾）；
//   · CTRL_LEN：SET_PARAM 26（全包 58 B）、GET_STATUS 68（全包 100 B）；
//   · 切换只在 ACK 全部字节写进 CTRL 通道之后、TX 真正空闲时生效；
//   · 越界值 → STATUS=0x04 BAD_VALUE 整条拒绝，不切换；len!=1 → STATUS=0x03 BAD_LEN。
//
// DUT 结构：uart_link(clk_cam 50 MHz, BAUD=115200, OS=16, TELEM_PERIOD_MS=20)
//           + uart_dl_bridge + downlink_cmd(clk_eth 125 MHz)
//           + top 同款 cdc_tog_word(WIDTH=2) 换档通路。
//   TB 侧发送/接收都按"当前档位"的实时位宽（real 延时），因此
//   **ACK 能否在旧波特率下被正确解码**本身就是"ACK 在旧档发完才切换"的判据。
//
// 判据：
//   P1  复位默认档 0（o_baud_cur==0），线路实测位宽 = 1/115200 ±3%
//   P2  遥测周期 = TELEM_PERIOD_MS（20 ms），档 0 与档 3 各测一次
//   P3  115200 下 SET_PARAM{0x0C=3} → ACK 58 B/clen=26/0x91=3/CRC16 正确，
//       且 ACK 自身位宽仍是 115200（旧档发完）→ 之后 o_baud_cur 才变 3
//   P4  切档后线路位宽 = 1/921600 ±3% + 遥测周期不变
//   P5  921600 下 GET_STATUS → ACK 100 B/clen=68/0x91=3（RX 也按新档）
//   P6  921600 下 SET_PARAM{0x0C=1} → ACK 0x91=1，切 230400（ACK 仍在 921600 发完）
//   P7  230400 下 GET_STATUS → clen=68 / 0x91=1 / 位宽 230400
//   P8  越界值 0x0C=9 → STATUS=0x04，0x91 保持 1，不切换
//   P9  len=2 → STATUS=0x03，0x91 保持 1，不切换
//   P10 不含 0x0C 的 SET_PARAM → STATUS=0x00，0x91 保持 1，不切换
//   P11 切回档 0（115200），位宽回到 1/115200
//   P12 全程无帧错误（每字节停止位中点采样均为高）
//==============================================================================
`timescale 1ns / 1ps

module tb_uart_baud;

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
    // 线路
    //--------------------------------------------------------------------------
    wire txd;
    reg  rxd = 1'b1;

    //--------------------------------------------------------------------------
    // 遥测统计输入（常数）
    //--------------------------------------------------------------------------
    wire [23:0] st_ev  = 24'd100;
    wire [15:0] st_act = 16'd2000;
    wire [23:0] st_cr  = 24'd10;
    wire [31:0] st_fr  = 32'd7;
    wire        st_mode= 1'b1;
    wire [3:0]  st_key = 4'h3;
    wire        st_en  = 1'b1;

    //--------------------------------------------------------------------------
    // CTRL / bridge / downlink
    //--------------------------------------------------------------------------
    wire        ctrl_valid, ctrl_eop, ctrl_rd_en;
    wire [7:0]  ctrl_data;
    wire        ctrl_empty_eth;
    wire        urx_valid, urx_ack;
    wire [7:0]  urx_data;
    wire        dl_ctrl_wr_en, dl_ctrl_commit;
    wire [7:0]  dl_ctrl_data;
    wire        dl_rx_valid, dl_rx_stream, dl_rx_pkt_done;
    wire [7:0]  dl_rx_data;
    wire        dl_accepted;
    wire [7:0]  dl_ser_decim;
    wire        dl_ser_decim_upd;
    wire [15:0] cnt_crc_bad, cnt_bad_op, cnt_reject;
    wire        cal_req;  wire [15:0] cal_seq;  wire [47:0] board_ts;
    wire [47:0] ts_local, ts_aligned, offset_reg;
    wire        ts_valid, ts_cal, ts_stale;
    wire [15:0] rtt_us;
    wire [31:0] boot_id;
    wire        sync_matched;

    // ★ WIRE-U2 换档通路（与 top_retina_event 的 g_uart_link 内一致）
    wire [1:0]  dl_baud_sel;
    wire        dl_baud_commit;
    wire [1:0]  baud_sel_cam;
    wire        baud_tog_cam;
    wire [1:0]  baud_cur;
    reg         baud_tog_d = 1'b0;
    wire        baud_pend_pulse;

    cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3)) u_cdc2_baud (
        .dst_clk   (clk_cam),
        .dst_rst_n (rst_n),
        .i_src_val (dl_baud_sel),
        .i_src_tog (dl_baud_commit),
        .o_dst_val (baud_sel_cam),
        .o_dst_tog (baud_tog_cam)
    );

    always @(posedge clk_cam or negedge rst_n) begin
        if (!rst_n) baud_tog_d <= 1'b0;
        else        baud_tog_d <= baud_tog_cam;
    end
    assign baud_pend_pulse = baud_tog_cam ^ baud_tog_d;

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    uart_link #(
        .CLK_HZ(50000000), .BAUD(115200), .OS(16),
        .TELEM_PERIOD_MS(20), .ASCII_TELEM(0)
    ) uL (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .uart_rxd(rxd), .uart_txd(txd),
        .i_stat_ev_per_frame(st_ev), .i_stat_activity_q16(st_act), .i_stat_cr_x10(st_cr),
        .i_stat_frame_cnt(st_fr), .i_stat_mode(st_mode), .i_key_pressed(st_key),
        .i_cfg_ev_en(st_en),
        .i_frdy(1'b0), .i_fbusy(1'b0), .i_fvalid(1'b0), .i_fdata(8'd0),
        .o_fack(), .o_fstart(),
        .i_ctrl_valid(ctrl_valid), .i_ctrl_data(ctrl_data), .i_ctrl_eop(ctrl_eop),
        .o_ctrl_rd_en(ctrl_rd_en),
        .o_urx_valid(urx_valid), .o_urx_data(urx_data), .i_urx_ack(urx_ack),
        .o_stat_b_cmd(), .o_stat_rx_drop(),
        .i_baud_sel(baud_sel_cam), .i_baud_pending(baud_pend_pulse), .o_baud_cur(baud_cur)
    );

    uart_dl_bridge #(.CTRL_DEPTH(256), .URX_DEPTH(256)) u_br (
        .clk_cam(clk_cam), .rst_n_cam(rst_n), .clk_eth(clk_eth), .rst_n_eth(rst_n),
        .i_ctrl_wr_en(dl_ctrl_wr_en), .i_ctrl_data(dl_ctrl_data),
        .i_ctrl_commit(dl_ctrl_commit), .o_ctrl_full(),
        .o_ctrl_empty_eth(ctrl_empty_eth),
        .i_ctrl_rd_en(ctrl_rd_en), .o_ctrl_valid(ctrl_valid),
        .o_ctrl_data(ctrl_data), .o_ctrl_eop(ctrl_eop),
        .i_urx_valid(urx_valid), .i_urx_data(urx_data), .o_urx_ack(urx_ack),
        .i_eth_valid(1'b0), .i_eth_data(8'd0), .o_eth_rd_en(),
        .i_eth_pkt_done(1'b0),
        .o_dl_valid(dl_rx_valid), .o_dl_data(dl_rx_data), .o_dl_stream(dl_rx_stream),
        .o_dl_pkt_done(dl_rx_pkt_done),
        .o_stat_urx_ovf(), .o_stat_ctrl_ovf()
    );

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
        .o_frame_decim(), .o_ev_flush_cyc(),
        .o_ev_res(), .o_ev_res_upd(),
        .o_ser_decim(dl_ser_decim), .o_ser_decim_upd(dl_ser_decim_upd),
        .o_exp_cap(), .o_exp_cap_upd(),
        .o_ser_agg(), .o_ser_agg_upd(),
        .o_ser_flush_ms(), .o_ser_flush_upd(),
        .o_dl_accepted(dl_accepted),
        .o_period_wr(), .o_period_s(), .o_force_cal(), .o_off_wr(), .o_off_data(),
        .o_ctrl_wr_en(dl_ctrl_wr_en), .o_ctrl_data(dl_ctrl_data),
        .o_ctrl_commit(dl_ctrl_commit),
        .i_ctrl_empty(ctrl_empty_eth),
        .o_stat_dl_crc_fail(cnt_crc_bad), .o_stat_dl_bad_opcode(cnt_bad_op),
        .o_stat_dl_reject(cnt_reject),
        .o_ser_baud_sel(dl_baud_sel), .o_ser_baud_commit(dl_baud_commit)
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
    // 串口接收：位宽由 TB 侧 cur_baud 决定（切换确认后由测试流程改写）
    //==========================================================================
    real      cur_baud = 115200.0;
    real      bt_ns;
    reg [7:0] rxb [0:32767];
    time      tt  [0:32767];        // 每个字节的起始沿时刻
    integer   nb = 0;
    integer   rx_framing_err = 0;
    time      xerr_t [0:255];          // 每次帧错误的字节起始沿时刻
    integer   xerr_n = 0;
    integer   ii;
    reg [7:0] dbb;
    time      tstart;

    initial begin : rx_mon
        forever begin
            @(negedge txd);
            tstart = $time;
            bt_ns  = 1.0e9 / cur_baud;
            #(bt_ns * 1.5);
            for (ii = 0; ii < 8; ii = ii + 1) begin
                dbb[ii] = txd;
                #(bt_ns);
            end
            // ★ 注意：上面的 for 循环最后一次 #(bt_ns) 已把时间推到 9.5 bit
            //   = 停止位中点。绝不能在此再多等 1 bit（会越到下一个起始位，
            //   采样窗口 10.5 bit > 帧周期 10.06 bit ⇒ 每个字节都漏起始沿）。
            if (txd !== 1'b1) begin
                rx_framing_err = rx_framing_err + 1;
                if (xerr_n < 256) begin xerr_t[xerr_n] = tstart; xerr_n = xerr_n + 1; end
            end
            if (nb < 32767) begin
                rxb[nb] = dbb;
                tt [nb] = tstart;
                nb = nb + 1;
            end
        end
    end

    //==========================================================================
    // 换档追踪：观测器/发送器始终跟随 DUT 实际档位（o_baud_cur）。
    //  手工“确认后赋值”会漏掉换档后紧跟的那个字节（旧波特率采样 → 假帧错误）。
    //==========================================================================
    always @(baud_cur) begin
        case (baud_cur)
          2'd0:    cur_baud = 115200.0;
          2'd1:    cur_baud = 230400.0;
          2'd2:    cur_baud = 460800.0;
          default: cur_baud = 921600.0;
        endcase
    end

    //==========================================================================
    // TB 侧发送（按 cur_baud 的实时位宽）
    //==========================================================================
    task send_byte; input [7:0] b; integer kk; real bts; begin
        bts = 1.0e9 / cur_baud;
        rxd = 1'b0; #(bts);
        for (kk = 0; kk < 8; kk = kk + 1) begin rxd = b[kk]; #(bts); end
        rxd = 1'b1; #(bts);
    end endtask

    //==========================================================================
    // 工具：CRC16 / 组包
    //==========================================================================
    function [15:0] crc16f;
        input [15:0] crc; input [7:0] dat;
        integer j; reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (j = 0; j < 8; j = j + 1) c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16f = c;
        end
    endfunction

    reg [7:0] cmd [0:63];
    integer   clen;
    integer   q;

    task cmd_head; input [7:0] op; input integer plen; begin
        cmd[0]=8'hF0; cmd[1]=8'h5A; cmd[2]=8'hA5; cmd[3]=8'h31;
        cmd[4]=8'h03; cmd[5]=op; cmd[6]=8'h00; cmd[7]=8'h01;
        cmd[8]=plen[15:8]; cmd[9]=plen[7:0];
        clen = 10 + plen;
    end endtask

    task cmd_finish; reg [15:0] c; begin
        c = 16'hFFFF;
        for (q = 0; q < clen; q = q + 1) c = crc16f(c, cmd[q]);
        cmd[clen]   = c[15:8];
        cmd[clen+1] = c[7:0];
        clen = clen + 2;
    end endtask

    task cmd_send; begin
        for (q = 0; q < clen; q = q + 1) send_byte(cmd[q]);
    end endtask

    task send_setparam_baud; input [7:0] code; begin
        cmd_head(8'h01, 3);
        cmd[10]=8'h0C; cmd[11]=8'h01; cmd[12]=code;
        cmd_finish;
        cmd_send;
    end endtask

    task send_setparam_baud2; input [7:0] v0; input [7:0] v1; begin
        cmd_head(8'h01, 4);
        cmd[10]=8'h0C; cmd[11]=8'h02; cmd[12]=v0; cmd[13]=v1;
        cmd_finish;
        cmd_send;
    end endtask

    task send_setparam_decim; input [7:0] v; begin
        cmd_head(8'h01, 3);
        cmd[10]=8'h08; cmd[11]=8'h01; cmd[12]=v;
        cmd_finish;
        cmd_send;
    end endtask

    task send_getstatus; begin
        cmd_head(8'h04, 0);
        cmd_finish;
        cmd_send;
    end endtask

    //==========================================================================
    // ACK 搜索 / 等待
    //==========================================================================
    integer   nb0 = 0;
    integer   ack_i = -1;
    integer   ack_clen;
    integer   ack_st;

    // [t0,t1] 区间内的帧错误个数
    function integer errs_in; input time t0; input time t1; integer j; begin
        errs_in = 0;
        for (j = 0; j < xerr_n; j = j + 1)
            if ((xerr_t[j] >= t0) && (xerr_t[j] <= t1)) errs_in = errs_in + 1;
    end endfunction

    // 等 ACK 收齐：先按 F0 5A A5 30 + op 定位起点，再等满 plen 字节
    task wait_ack_n; input integer from; input [7:0] op; input integer plen;
        integer kk; integer qq; begin
        ack_i = -1; kk = 0;
        while (((ack_i < 0) || (nb < (ack_i + plen))) && (kk < 4000000)) begin
            @(negedge clk_cam); kk = kk + 1;
            if ((ack_i < 0) && ((nb - from) >= 40)) begin
                for (qq = from; qq <= (nb - 40); qq = qq + 1)
                    if ((ack_i < 0) && rxb[qq]===8'hF0 && rxb[qq+1]===8'h5A &&
                        rxb[qq+2]===8'hA5 && rxb[qq+3]===8'h30 && rxb[qq+24]===op) ack_i = qq;
            end
        end
    end endtask

    reg [15:0] acrc_c, acrc_e;

    task scan_ack; input [7:0] op; begin
        ack_i = -1;
        for (q = nb0; q <= (nb - 40); q = q + 1)
            if (ack_i < 0 && rxb[q]===8'hF0 && rxb[q+1]===8'h5A && rxb[q+2]===8'hA5 &&
                rxb[q+3]===8'h30 && rxb[q+24]===op)
                ack_i = q;
    end endtask

    task wait_ack; input [7:0] op; input integer plen; integer kk; begin
        ack_i = -1; kk = 0;
        while (((ack_i < 0) || (nb < (ack_i + 30 + plen + 2))) && (kk < 2000000)) begin
            @(negedge clk_cam); kk = kk + 1;
            if (((kk % 200) == 0) && ((nb - nb0) >= 40)) scan_ack(op);
        end
    end endtask

    // 等第 idx 个字节之后再收到 n 个字节
    task settle_from; input integer idx; input integer n; integer kk; begin
        kk = 0;
        while (((idx < 0) || (nb < (idx + n))) && (kk < 2000000)) begin
            @(negedge clk_cam); kk = kk + 1;
        end
    end endtask

    // ACK 自身位宽（ns，跨 10 个字节 = 100 bit 平均）——证明它在**旧档**发完
    real bt_meas;
    task ack_bitwidth; integer a, b; begin
        a = ack_i; b = ack_i + 10;
        bt_meas = 0.0;
        if ((b < nb) && (tt[b] > tt[a])) bt_meas = (tt[b] - tt[a]) / (10.0 * (b - a));
    end endtask

    real want_bt;
    task exp_bt; input integer code; begin
        case (code)
            0: want_bt = 1.0e9 / 115200.0;
            1: want_bt = 1.0e9 / 230400.0;
            2: want_bt = 1.0e9 / 460800.0;
            default: want_bt = 1.0e9 / 921600.0;
        endcase
    end endtask

    task chk_bt; input [8*48-1:0] nm; input integer code; begin
        exp_bt(code);
        $display("  bit width %0.1f ns (nominal %0.1f ns, baud code %0d, %0.0f bps)",
                 bt_meas, want_bt, code, 1.0e9 / want_bt);
        if ((bt_meas > want_bt*0.97) && (bt_meas < want_bt*1.03)) chk_pass(nm);
        else begin
            chk_fail(nm);
            $display("  [E] bit width %0.1f ns (expect %0.1f ns, baud code %0d)", bt_meas, want_bt, code);
        end
    end endtask

    //==========================================================================
    // 等 DUT 报告生效档位 / 等遥测帧
    //==========================================================================
    task wait_baud; input [1:0] want; integer kk; begin
        kk = 0;
        while ((baud_cur !== want) && (kk < 2000000)) begin @(negedge clk_cam); kk = kk + 1; end
    end endtask

    integer tel_i = -1;
    task scan_tel; input integer from; begin
        tel_i = -1;
        for (q = from; q <= (nb - 4); q = q + 1)
            if (tel_i < 0 && rxb[q]===8'hAA && rxb[q+1]===8'h55 &&
                rxb[q+2]===8'h54 && rxb[q+3]===8'h4D) tel_i = q;
    end endtask

    task wait_tel; input integer from; integer kk; begin
        tel_i = -1; kk = 0;
        if ((nb - from) >= 4) scan_tel(from);
        while ((tel_i < 0) && (kk < 4000000)) begin
            @(negedge clk_cam); kk = kk + 1;
            if (((kk % 500) == 0) && (nb >= (from + 4))) scan_tel(from);
        end
        if (tel_i >= 0) settle_from(tel_i, 21);      // 21 B 遥测帧（ASCII_TELEM=0）
    end endtask

    // 用遥测帧连续 21 个字节的起始沿测位宽
    task tel_bitwidth; input integer idx; integer a, b; begin
        a = idx; b = idx + 20;
        bt_meas = 0.0;
        if ((b < nb) && (tt[b] > tt[a])) bt_meas = (tt[b] - tt[a]) / (10.0 * (b - a));
    end endtask

    //==========================================================================
    // 公用：ACK 通用校验（CRC16 + clen + status）
    //==========================================================================
    task ack_common; integer a; begin
        a = ack_i;
        ack_clen = {rxb[a+28], rxb[a+29]};
        ack_st   = rxb[a+25];
        acrc_c = 16'hFFFF;
        for (q = 0; q < (30 + ack_clen); q = q + 1) acrc_c = crc16f(acrc_c, rxb[a+q]);
        acrc_e = {rxb[a+30+ack_clen], rxb[a+31+ack_clen]};
        if (acrc_c === acrc_e) chk_pass("P_ack_crc16");
        else begin chk_fail("P_ack_crc16");
                   $display("  [E] crc %04x/%04x idx=%0d clen=%0d", acrc_c, acrc_e, a, ack_clen); end
    end endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    integer t0, t1;
    integer e0;
    integer kk;

    initial begin
        rst_n = 1'b0;
        repeat (20) @(negedge clk_cam);
        rst_n = 1'b1;

        //----------------------------------------------------------------------
        // P1：复位默认档 0 + 位宽 115200
        //----------------------------------------------------------------------
        repeat (1000) @(negedge clk_cam);       // 20 us
        if (baud_cur === 2'd0) chk_pass("P1_rst_baud0");
        else begin chk_fail("P1_rst_baud0"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        nb0 = nb;
        wait_tel(nb0);
        if (tel_i >= 0) begin
            tel_bitwidth(tel_i);
            chk_bt("P1_bit_115200", 0);
        end
        else begin chk_fail("P1_bit_115200"); $display("  [E] no telemetry frame seen, nb=%0d", nb); end

        //----------------------------------------------------------------------
        // P2（档 0）：遥测周期 = 20 ms
        //----------------------------------------------------------------------
        t0 = tel_i;
        nb0 = nb;
        wait_tel(nb0);
        if ((t0 >= 0) && (tel_i > t0)) begin
            t1 = tel_i;
            if (((tt[t1] - tt[t0]) > 19_600_000) && ((tt[t1] - tt[t0]) < 20_400_000))
                chk_pass("P2_tel_period_baud0");
            else begin chk_fail("P2_tel_period_baud0");
                       $display("  [E] period %0d ns (expect 20 ms +/-2%%)", tt[t1] - tt[t0]); end
        end
        else begin chk_fail("P2_tel_period_baud0"); $display("  [E] check failed"); end

        //----------------------------------------------------------------------
        // P3：档 0（115200）下发 SET_PARAM{0x0C=3}
        //----------------------------------------------------------------------
        nb0 = nb;
        e0  = rx_framing_err;
        send_setparam_baud(8'd3);
        wait_ack_n(nb0, 8'h01, 58);
        if (ack_i >= 0) begin
            ack_common;
            if ((nb - ack_i) >= 58) chk_pass("P3_ack_len58");
            else begin chk_fail("P3_ack_len58");
                       $display("  [E] got %0d B (expect 58)", nb - ack_i); end
            if (ack_clen === 26) chk_pass("P3_ack_clen26");
            else begin chk_fail("P3_ack_clen26"); $display("  [E] clen=%0d", ack_clen); end
            if (ack_st === 8'h00) chk_pass("P3_ack_status0");
            else begin chk_fail("P3_ack_status0"); $display("  [E] status=%02x", ack_st); end
            if ((rxb[ack_i+30+23]===8'h91) && (rxb[ack_i+30+24]===8'd1) &&
                (rxb[ack_i+30+25]===8'd3)) chk_pass("P3_ack_baud_tlv3");
            else begin chk_fail("P3_ack_baud_tlv3");
                       $display("  [E] tlv@%0d=%02x %02x %02x", ack_i+53,
                                rxb[ack_i+53], rxb[ack_i+54], rxb[ack_i+55]); end
            ack_bitwidth;
            chk_bt("P3_ack_at_115200", 0);
            if (errs_in(tt[ack_i], tt[ack_i+57]) === 0) chk_pass("P3_ack_no_framing_err");
            else begin chk_fail("P3_ack_no_framing_err");
                       $display("  [E] framing err in ACK window: %0d", errs_in(tt[ack_i], tt[ack_i+57])); end
        end
        else begin chk_fail("P3_ack_recv"); $display("  [E] no SET_PARAM ACK (nb=%0d)", nb); end

        wait_baud(2'd3);
        if (baud_cur === 2'd3) chk_pass("P3_switch_to_3");
        else begin chk_fail("P3_switch_to_3"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        //----------------------------------------------------------------------
        // P4：档 3（921600）位宽 + 遥测周期
        //  ⚠️ 档位已生效：TB 接收器改为 921600
        //----------------------------------------------------------------------
        nb0 = nb;
        wait_tel(nb0);
        if (tel_i >= 0) begin
            tel_bitwidth(tel_i);
            chk_bt("P4_bit_921600", 3);
            t0 = tel_i;
            nb0 = nb;
            wait_tel(nb0);
            if (tel_i > t0) begin
                t1 = tel_i;
                if (((tt[t1] - tt[t0]) > 19_600_000) && ((tt[t1] - tt[t0]) < 20_400_000))
                    chk_pass("P4_tel_period_baud3");
                else begin chk_fail("P4_tel_period_baud3");
                           $display("  [E] period %0d ns (expect 20 ms +/-2%%)", tt[t1] - tt[t0]); end
            end
            else begin chk_fail("P4_tel_period_baud3"); $display("  [E] check failed"); end
        end
        else begin
            chk_fail("P4_bit_921600"); chk_fail("P4_tel_period_baud3");
            $display("  [E] no telemetry frame after switch (nb=%0d)", nb);
        end

        //----------------------------------------------------------------------
        // P5：921600 下 GET_STATUS（RX 也必须在新档）
        //----------------------------------------------------------------------
        nb0 = nb;
        e0  = rx_framing_err;
        send_getstatus;
        wait_ack_n(nb0, 8'h04, 103);
        if (ack_i >= 0) begin
            ack_common;
            if ((nb - ack_i) >= 103) chk_pass("P5_ack_len103");
            else begin chk_fail("P5_ack_len103");
                       $display("  [E] got %0d B (expect 103)", nb - ack_i); end
            if (ack_clen === 71) chk_pass("P5_clen71");
            else begin chk_fail("P5_clen71"); $display("  [E] clen=%0d", ack_clen); end
            if (ack_st === 8'h00) chk_pass("P5_status0");
            else begin chk_fail("P5_status0"); $display("  [E] status=%02x", ack_st); end
            if ((rxb[ack_i+30+65]===8'h91) && (rxb[ack_i+30+66]===8'd1) &&
                (rxb[ack_i+30+67]===8'd3)) chk_pass("P5_baud_tlv3");
            else begin chk_fail("P5_baud_tlv3");
                       $display("  [E] tlv@%0d=%02x %02x %02x", ack_i+95,
                                rxb[ack_i+95], rxb[ack_i+96], rxb[ack_i+97]); end
            // ★ M4b：TLV 0x92 ACTION_STATE（无动作 ⇒ 92 01 00）
            if ((rxb[ack_i+30+68]===8'h92) && (rxb[ack_i+30+69]===8'd1) &&
                (rxb[ack_i+30+70]===8'h00)) chk_pass("P5_action_tlv_zero");
            else begin chk_fail("P5_action_tlv_zero");
                       $display("  [E] tlv@98=%02x %02x %02x",
                                rxb[ack_i+98], rxb[ack_i+99], rxb[ack_i+100]); end
            ack_bitwidth;
            chk_bt("P5_rx_tx_at_921600", 3);
            if (errs_in(tt[ack_i], tt[ack_i+102]) === 0) chk_pass("P5_no_framing_err");
            else begin chk_fail("P5_no_framing_err");
                       $display("  [E] framing err in ACK window: %0d", errs_in(tt[ack_i], tt[ack_i+102])); end
        end
        else begin chk_fail("P5_ack_recv"); $display("  [E] no GET_STATUS ACK (nb=%0d)", nb); end

        //----------------------------------------------------------------------
        // P6：921600 下切到档 1（230400）
        //----------------------------------------------------------------------
        nb0 = nb;
        send_setparam_baud(8'd1);
        wait_ack_n(nb0, 8'h01, 58);
        if (ack_i >= 0) begin
            ack_clen = {rxb[ack_i+28], rxb[ack_i+29]};
            ack_st   = rxb[ack_i+25];
            if ((ack_st === 8'h00) && (ack_clen === 26)) chk_pass("P6_ack_ok");
            else begin chk_fail("P6_ack_ok");
                       $display("  [E] st=%02x clen=%0d", ack_st, ack_clen); end
            if ((rxb[ack_i+30+23]===8'h91) && (rxb[ack_i+30+25]===8'd1))
                chk_pass("P6_ack_baud_tlv1");
            else begin chk_fail("P6_ack_baud_tlv1");
                       $display("  [E] tlv=%02x %02x %02x",
                                rxb[ack_i+53], rxb[ack_i+54], rxb[ack_i+55]); end
            ack_bitwidth;
            chk_bt("P6_ack_at_921600", 3);
        end
        else begin chk_fail("P6_ack_recv"); $display("  [E] no ACK (nb=%0d)", nb); end

        wait_baud(2'd1);
        if (baud_cur === 2'd1) chk_pass("P6_switch_to_1");
        else begin chk_fail("P6_switch_to_1"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        //----------------------------------------------------------------------
        // P7：230400 下 GET_STATUS
        //----------------------------------------------------------------------
        nb0 = nb;
        e0  = rx_framing_err;
        send_getstatus;
        wait_ack_n(nb0, 8'h04, 103);
        if (ack_i >= 0) begin
            ack_clen = {rxb[ack_i+28], rxb[ack_i+29]};
            ack_st   = rxb[ack_i+25];
            if ((ack_st === 8'h00) && (ack_clen === 71) && ((nb - ack_i) >= 103))
                chk_pass("P7_getstatus_ok");
            else begin chk_fail("P7_getstatus_ok");
                       $display("  [E] st=%02x clen=%0d len=%0d", ack_st, ack_clen, nb - ack_i); end
            if ((rxb[ack_i+30+65]===8'h91) && (rxb[ack_i+30+67]===8'd1))
                chk_pass("P7_baud_tlv1");
            else begin chk_fail("P7_baud_tlv1");
                       $display("  [E] tlv=%02x %02x %02x",
                                rxb[ack_i+95], rxb[ack_i+96], rxb[ack_i+97]); end
            // ★ M4b：TLV 0x92 ACTION_STATE（无动作 ⇒ 92 01 00）
            if ((rxb[ack_i+30+68]===8'h92) && (rxb[ack_i+30+69]===8'd1) &&
                (rxb[ack_i+30+70]===8'h00)) chk_pass("P7_action_tlv_zero");
            else begin chk_fail("P7_action_tlv_zero");
                       $display("  [E] tlv@98=%02x %02x %02x",
                                rxb[ack_i+98], rxb[ack_i+99], rxb[ack_i+100]); end
            ack_bitwidth;
            chk_bt("P7_at_230400", 1);
            if (errs_in(tt[ack_i], tt[ack_i+102]) === 0) chk_pass("P7_no_framing_err");
            else begin chk_fail("P7_no_framing_err");
                       $display("  [E] framing err in ACK window: %0d", errs_in(tt[ack_i], tt[ack_i+102])); end
        end
        else begin chk_fail("P7_getstatus_ok"); chk_fail("P7_baud_tlv1");
                   $display("  [E] no GET_STATUS ACK (nb=%0d)", nb); end

        //----------------------------------------------------------------------
        // P8：越界值 0x0C=9 → STATUS=0x04，不切换
        //----------------------------------------------------------------------
        nb0 = nb;
        send_setparam_baud(8'd9);
        wait_ack_n(nb0, 8'h01, 32);
        if (ack_i >= 0) begin
            ack_st = rxb[ack_i+25];
            if (ack_st === 8'h04) chk_pass("P8_badval_status4");
            else begin chk_fail("P8_badval_status4"); $display("  [E] status=%02x", ack_st); end
            // ★ 非 OK 的 ACK 不带 TLV：ctrl_len_of(status!=OK)=0 ⇒ 整包 24+6+0+2 = 32 B（既有 WIRE-V3 行为）
            if ({rxb[ack_i+28], rxb[ack_i+29]} === 16'd0) chk_pass("P8_rej_clen0");
            else begin chk_fail("P8_rej_clen0");
                       $display("  [E] clen=%0d", {rxb[ack_i+28], rxb[ack_i+29]}); end
            // 档位不变由随后的 GET_STATUS 读回验证（错误 ACK 里没有 0x91）
            nb0 = nb;
            send_getstatus;
            wait_ack_n(nb0, 8'h04, 100);
            if (ack_i >= 0) begin
                if ((rxb[ack_i+30+65]===8'h91) && (rxb[ack_i+30+67]===8'd1))
                    chk_pass("P8_badval_baud_kept");
                else begin chk_fail("P8_badval_baud_kept");
                           $display("  [E] gs tlv=%02x %02x %02x",
                                    rxb[ack_i+95], rxb[ack_i+96], rxb[ack_i+97]); end
            end
            else begin chk_fail("P8_badval_baud_kept");
                       $display("  [E] no GET_STATUS ACK (nb=%0d)", nb); end
        end
        else begin chk_fail("P8_badval_status4"); chk_fail("P8_rej_clen0");
                   chk_fail("P8_badval_baud_kept"); $display("  [E] no ACK (nb=%0d)", nb); end

        repeat (200000) @(negedge clk_cam);         // 4 ms 观察窗
        if (baud_cur === 2'd1) chk_pass("P8_no_switch");
        else begin chk_fail("P8_no_switch");
                   $display("  [E] o_baud_cur=%0d (must not switch)", baud_cur); end

        //----------------------------------------------------------------------
        // P9：len=2 → STATUS=0x03，不切换
        //----------------------------------------------------------------------
        nb0 = nb;
        send_setparam_baud2(8'd0, 8'd1);
        wait_ack_n(nb0, 8'h01, 32);
        if (ack_i >= 0) begin
            ack_st = rxb[ack_i+25];
            if (ack_st === 8'h03) chk_pass("P9_badlen_status3");
            else begin chk_fail("P9_badlen_status3"); $display("  [E] status=%02x", ack_st); end
            if ({rxb[ack_i+28], rxb[ack_i+29]} === 16'd0) chk_pass("P9_rej_clen0");
            else begin chk_fail("P9_rej_clen0");
                       $display("  [E] clen=%0d", {rxb[ack_i+28], rxb[ack_i+29]}); end
            nb0 = nb;
            send_getstatus;
            wait_ack_n(nb0, 8'h04, 100);
            if (ack_i >= 0) begin
                if ((rxb[ack_i+30+65]===8'h91) && (rxb[ack_i+30+67]===8'd1))
                    chk_pass("P9_badlen_baud_kept");
                else begin chk_fail("P9_badlen_baud_kept");
                           $display("  [E] gs tlv=%02x %02x %02x",
                                    rxb[ack_i+95], rxb[ack_i+96], rxb[ack_i+97]); end
            end
            else begin chk_fail("P9_badlen_baud_kept");
                       $display("  [E] no GET_STATUS ACK (nb=%0d)", nb); end
        end
        else begin chk_fail("P9_badlen_status3"); chk_fail("P9_rej_clen0");
                   chk_fail("P9_badlen_baud_kept"); $display("  [E] no ACK (nb=%0d)", nb); end

        repeat (200000) @(negedge clk_cam);
        if (baud_cur === 2'd1) chk_pass("P9_no_switch");
        else begin chk_fail("P9_no_switch"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        //----------------------------------------------------------------------
        // P10：不含 0x0C 的 SET_PARAM → STATUS=0，档位不变
        //----------------------------------------------------------------------
        nb0 = nb;
        send_setparam_decim(8'd7);
        wait_ack_n(nb0, 8'h01, 58);
        if (ack_i >= 0) begin
            ack_st = rxb[ack_i+25];
            if (ack_st === 8'h00) chk_pass("P10_ok_status0");
            else begin chk_fail("P10_ok_status0"); $display("  [E] status=%02x", ack_st); end
            if ((rxb[ack_i+30+23]===8'h91) && (rxb[ack_i+30+25]===8'd1))
                chk_pass("P10_baud_kept");
            else begin chk_fail("P10_baud_kept");
                       $display("  [E] tlv=%02x %02x %02x",
                                rxb[ack_i+53], rxb[ack_i+54], rxb[ack_i+55]); end
        end
        else begin chk_fail("P10_ok_status0"); chk_fail("P10_baud_kept");
                   $display("  [E] no ACK (nb=%0d)", nb); end
        repeat (100000) @(negedge clk_cam);
        if (baud_cur === 2'd1) chk_pass("P10_no_switch");
        else begin chk_fail("P10_no_switch"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        //----------------------------------------------------------------------
        // P11：切回档 0（115200）
        //----------------------------------------------------------------------
        nb0 = nb;
        send_setparam_baud(8'd0);
        wait_ack_n(nb0, 8'h01, 58);
        if (ack_i >= 0) begin
            ack_st = rxb[ack_i+25];
            if ((ack_st === 8'h00) && (rxb[ack_i+30+23]===8'h91) && (rxb[ack_i+30+25]===8'd0))
                chk_pass("P11_ack_back_to_0");
            else begin chk_fail("P11_ack_back_to_0");
                       $display("  [E] st=%02x tlv=%02x %02x %02x", ack_st,
                                rxb[ack_i+53], rxb[ack_i+54], rxb[ack_i+55]); end
            ack_bitwidth;
            chk_bt("P11_ack_at_230400", 1);
        end
        else begin chk_fail("P11_ack_back_to_0"); chk_fail("P11_ack_at_230400");
                   $display("  [E] no ACK (nb=%0d)", nb); end
        wait_baud(2'd0);
        if (baud_cur === 2'd0) chk_pass("P11_switch_to_0");
        else begin chk_fail("P11_switch_to_0"); $display("  [E] o_baud_cur=%0d", baud_cur); end

        nb0 = nb;
        wait_tel(nb0);
        if (tel_i >= 0) begin
            tel_bitwidth(tel_i);
            chk_bt("P11_bit_115200_again", 0);
        end
        else begin chk_fail("P11_bit_115200_again"); $display("  [E] no telemetry frame seen, nb=%0d", nb); end

        //----------------------------------------------------------------------
        // P12：全程无帧错误
        //----------------------------------------------------------------------
        if (rx_framing_err === 0) chk_pass("P12_no_framing_err");
        else begin
            chk_fail("P12_no_framing_err");
            $display("  [E] framing_err=%0d", rx_framing_err);
            for (kk = 0; kk < xerr_n; kk = kk + 1)
                $display("      xerr[%0d] t=%0t", kk, xerr_t[kk]);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

endmodule
