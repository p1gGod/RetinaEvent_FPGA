`timescale 1ns / 1ps
//==============================================================================
// tb_act3_ctrlhdr.v -- M4f ACT3_CTRLHDR (task-27)
//
// Defect: downlink_cmd pkt_byte() had idx 23 falling into "default" (0x00),
// so every CTRL/heartbeat frame carried BYTE23 = 0. Host resets its VALID-edge
// FSM on each heartbeat => one physical gesture is counted twice.
// Fix   : pkt_byte 7'd23 => act_byte_s (same clk_eth-domain latch that already
//         feeds the data-frame byte23 and TLV 0x92).
//
// DUT chain: act_state_cdc (clk_cam -> clk_eth) -> downlink_cmd (clk_eth)
//
// Checks (all ASCII):
//   P0_HB_BYTE23_00          no action after reset -> heartbeat byte23 = 0x00
//   P0_HB_CRC_OK             independent CRC16 over [0..30+clen-1] + header
//   P1_ACT_CDC_C5            pulse class=1 conf=17 -> latch 0xC5 after CDC
//   P2_ACK_BYTE23_C5         SET_PARAM ACK byte23 = 0xC5
//   P2_ACK_STATUS_OK         ACK status = 0
//   P2_ACK_CRC_OK            ACK CRC16 recomputed by TB
//   P2_CRC_INCLUDES_BYTE23   CRC over all bytes except idx 23 differs from the
//                            on-wire CRC => byte23 really is inside the CRC16
//                            coverage (R8: written before crc16_step)
//   P3_HB_BYTE23_C5          next heartbeat byte23 = 0xC5
//   P3_HB_CRC_OK
//   P4_NO_EARLY_CLEAR        at ACT_IDLE_CYC-2000 cycles still 0xC5
//   P4_IDLE_CLEAR_00         1.0 s idle window -> latch reads 0x00
//   P4_WINDOW_CYC            measured window = ACT_IDLE_CYC + CDC latency
//   P5_ACK_BYTE23_00         SET_PARAM ACK after clear -> byte23 = 0x00
//   P5_ACK_CRC_OK
//   P6_HB_BYTE23_00          heartbeat after clear -> byte23 = 0x00
//   P6_HB_CRC_OK
//
// Run: cd /e/workspace/FPGA_Comp/retina_event
//      pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_ctrlhdr
//==============================================================================

module tb_act3_ctrlhdr;

    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    always #4  clk_eth = ~clk_eth;      // 125 MHz
    always #10 clk_cam = ~clk_cam;      // 50 MHz
    reg rst_n = 1'b0;

    // ACT_IDLE_CYC = 50_000_000 => 1.0 s @ 50 MHz (production default value)
    localparam integer CYC    = 50_000_000;
    // heartbeat period 25 ms @125 MHz (production 1 Hz; shortened for sim)
    localparam integer HB_CYC = 3_125_000;

    integer errors = 0;
    integer checks = 0;

    task chk_pass; input [8*48-1:0] nm; begin
        checks = checks + 1;
        $display("CHECK=%0s PASS", nm);
    end endtask

    task chk_fail; input [8*48-1:0] nm; begin
        checks = checks + 1;
        $display("CHECK=%0s FAIL", nm);
        errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // Action source (clk_cam) -> act_state_cdc -> clk_eth
    //--------------------------------------------------------------------------
    reg        act_pulse = 1'b0;
    reg  [1:0] act_class = 2'd0;
    reg  [4:0] act_conf  = 5'd0;
    wire [7:0] act_byte_eth;

    act_state_cdc #(.ACT_IDLE_CYC(CYC)) u_act (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n),
        .i_act_pulse (act_pulse),
        .i_act_class (act_class),
        .i_act_conf  (act_conf),
        .clk_eth     (clk_eth),
        .rst_n_eth   (rst_n),
        .o_act_byte  (act_byte_eth)
    );

    task inject_act; input [1:0] cls; input [4:0] conf; begin
        @(negedge clk_cam);
        act_class = cls;
        act_conf  = conf;
        act_pulse = 1'b1;
        @(negedge clk_cam);
        act_pulse = 1'b0;
    end endtask

    task wait_act; input [7:0] exp; input integer maxcam;
        integer g;
        begin
            g = 0;
            while ((act_byte_eth !== exp) && (g < maxcam)) begin
                @(posedge clk_cam); g = g + 1;
            end
        end
    endtask

    // Idle-window measurement: both stamps use the pre-edge counter value,
    // so the difference is exact clock_cam cycles (independent of NBA order).
    integer cam_cyc_q   = 0;
    integer pulse_cyc_q = -1;
    integer clear_cyc_q = -1;
    reg     saw_c5      = 1'b0;   // must observe the active value before the clear
    always @(posedge clk_cam) begin
        if (rst_n) begin
            cam_cyc_q <= cam_cyc_q + 1;
            if (act_pulse) pulse_cyc_q <= cam_cyc_q;
            if (act_byte_eth === 8'hC5) saw_c5 <= 1'b1;
            if ((clear_cyc_q < 0) && saw_c5 && (act_byte_eth === 8'h00))
                clear_cyc_q <= cam_cyc_q;
        end
    end

    //--------------------------------------------------------------------------
    // DUT: downlink_cmd (same 125 MHz domain, other inputs tied off)
    //--------------------------------------------------------------------------
    reg         rx_valid = 1'b0;
    reg  [7:0]  rx_data  = 8'd0;
    reg         rx_done  = 1'b0;

    wire        cal_req;   wire [15:0] cal_seq; wire [47:0] board_ts;
    wire [47:0] ts_local, ts_aligned, offset_reg;
    wire        ts_valid, ts_cal, ts_stale;
    wire [15:0] rtt_us;
    wire [31:0] boot_id;

    wire [11:0] dl_theta;      wire dl_theta_upd;
    wire [8:0]  dl_min_dl;     wire dl_min_dl_upd;
    wire [1:0]  dl_mode_set;   wire dl_mode_set_upd;
    wire        dl_ev_en;      wire dl_ev_en_upd;
    wire [1:0]  dl_ev_res;     wire dl_ev_res_upd;
    wire [7:0]  dl_ser_decim;  wire dl_ser_decim_upd;
    wire [1:0]  dl_ser_agg;    wire dl_ser_agg_upd;
    wire [15:0] dl_ser_flush;  wire dl_ser_flush_upd;
    wire [15:0] dl_exp_cap;    wire dl_exp_cap_upd;
    wire        dl_accepted;
    wire [7:0]  dl_frame_decim;
    wire [23:0] dl_ev_flush_cyc;
    wire        period_wr_o;   wire [16:0] period_s_o;
    wire        force_cal_o;
    wire        off_wr_o;      wire [47:0] off_data_o;
    wire        sync_matched;
    wire        ctrl_wr_en;    wire [7:0] ctrl_data; wire ctrl_commit;
    wire [15:0] cnt_crc_fail, cnt_bad_op, cnt_reject;

    downlink_cmd #(
        .HEARTBEAT_CYC (HB_CYC),
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
        .i_net_state    (2'd1),
        .i_net_chg      (1'b0),
        .i_ser_drop     (8'h00),
        .i_mode         (2'd0),
        .i_ts_us        (48'd0),
        .i_ts_local_us  (48'd0),
        .i_ts_offset    (48'd0),
        .i_ts_valid     (1'b1),
        .i_ts_calibrated(1'b0),
        .i_ts_stale     (1'b0),
        .i_rtt_us       (16'd0),
        .i_boot_id      (32'h5254_4E41),
        .i_frame_idx    (16'd0),
        .i_drop_px      (16'd0),
        .i_drop_ev      (16'd0),
        .i_ev_en        (1'b1),
        .i_act_byte     (act_byte_eth),
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
        .o_exp_cap      (dl_exp_cap),
        .o_exp_cap_upd  (dl_exp_cap_upd),
        .o_ser_baud_sel (),
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

    //--------------------------------------------------------------------------
    // Downlink command construction / send (same as tb_downlink_cmd)
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

    reg [7:0]  pl [0:64];
    integer    plen;
    reg [7:0]  tx_b [0:96];
    integer    tx_n;
    reg [15:0] g_seq = 16'd100;

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
            g_seq = g_seq + 16'd1;
        end
    endtask

    task send_cmd; input [7:0] op; input integer corrupt;
        integer i;
        begin
            build_cmd(op, corrupt);
            for (i = 0; i < tx_n; i = i + 1) begin
                @(negedge clk_eth);
                rx_valid = 1'b1;
                rx_data  = tx_b[i];
                rx_done  = 1'b0;
            end
            @(negedge clk_eth);
            rx_valid = 1'b0;
            rx_data  = 8'h00;
            rx_done  = 1'b1;
            @(negedge clk_eth);
            rx_done  = 1'b0;
        end
    endtask

    //--------------------------------------------------------------------------
    // CTRL packet capture (REQ / heartbeat / ACK interleaved)
    //--------------------------------------------------------------------------
    reg [7:0] hist [0:16383];
    integer   hist_ptr = 0;
    integer   pkt_start = 0;
    integer   start_hist [0:63];
    reg [7:0] op_hist   [0:63];
    reg [7:0] st_hist   [0:63];
    integer   clen_hist [0:63];
    integer   n_pkts = 0;

    reg commit_d = 1'b0;
    always @(posedge clk_eth) begin
        commit_d <= ctrl_commit;
        if (ctrl_wr_en && (hist_ptr < 16383)) begin
            hist[hist_ptr] <= ctrl_data;
            hist_ptr = hist_ptr + 1;
        end
        if (commit_d && (n_pkts < 64)) begin
            start_hist[n_pkts] = pkt_start;
            op_hist  [n_pkts] = hist[pkt_start + 24];
            st_hist  [n_pkts] = hist[pkt_start + 25];
            clen_hist[n_pkts] = {hist[pkt_start + 28], hist[pkt_start + 29]};
            n_pkts    = n_pkts + 1;
            pkt_start = hist_ptr;
        end
    end

    function [7:0] histb;
        input integer pn;
        input integer off;
        begin
            histb = hist[start_hist[pn] + off];
        end
    endfunction

    //--------------------------------------------------------------------------
    // Packet checks
    //--------------------------------------------------------------------------
    integer scan_idx = 0;
    integer cur_pkt = -1;
    reg     pkt_ok = 1'b0;
    reg [15:0] a_crc_c, a_crc_e;

    task wait_pkt; input [7:0] op; input [8*48-1:0] nm;
        integer guard, j;
        begin
            guard = 0;
            cur_pkt = -1;
            while ((guard < 12000000) && (cur_pkt < 0)) begin
                @(posedge clk_eth);
                for (j = scan_idx; j < n_pkts; j = j + 1)
                    if ((op_hist[j] === op) && (st_hist[j] !== 8'hxx)) begin
                        cur_pkt = j;
                        scan_idx = j + 1;
                    end
                guard = guard + 1;
            end
            pkt_ok = (cur_pkt >= 0);
            if (pkt_ok) chk_pass(nm);
            else begin
                chk_fail(nm);
                $display("  [E] timeout waiting op=%02x (n_pkts=%0d)", op, n_pkts);
            end
        end
    endtask

    task chk_b23; input [7:0] exp; input [8*48-1:0] nm;
        begin
            if (!pkt_ok) chk_fail(nm);
            else if (histb(cur_pkt, 23) === exp) begin
                chk_pass(nm);
                $display("  [I] pkt=%0d op=%02x clen=%0d byte23=%02x hdr0..7=%02x %02x %02x %02x %02x %02x %02x %02x",
                         cur_pkt, op_hist[cur_pkt], clen_hist[cur_pkt], histb(cur_pkt,23),
                         histb(cur_pkt,0), histb(cur_pkt,1), histb(cur_pkt,2), histb(cur_pkt,3),
                         histb(cur_pkt,4), histb(cur_pkt,5), histb(cur_pkt,6), histb(cur_pkt,7));
            end
            else begin
                chk_fail(nm);
                $display("  [E] byte23=%02x exp=%02x pkt=%0d op=%02x",
                         histb(cur_pkt,23), exp, cur_pkt, op_hist[cur_pkt]);
            end
        end
    endtask

    task chk_crc; input [8*48-1:0] nm;
        integer i, clen;
        begin
            if (!pkt_ok) chk_fail(nm);
            else begin
                clen = clen_hist[cur_pkt];
                a_crc_c = 16'hFFFF;
                for (i = 0; i < (30 + clen); i = i + 1)
                    a_crc_c = crc16f(a_crc_c, histb(cur_pkt, i));
                a_crc_e = {histb(cur_pkt, 30 + clen), histb(cur_pkt, 31 + clen)};
                if ((a_crc_c === a_crc_e) &&
                    (histb(cur_pkt,0)===8'hF0) && (histb(cur_pkt,1)===8'h5A) &&
                    (histb(cur_pkt,2)===8'hA5) && (histb(cur_pkt,3)===8'h30) &&
                    (histb(cur_pkt,4)===8'h03) && (histb(cur_pkt,5)===8'h18) &&
                    ((histb(cur_pkt,6) & 8'h80) !== 8'h00)) chk_pass(nm);
                else begin
                    chk_fail(nm);
                    $display("  [E] CRC/magic: calc=%04x pkt=%04x clen=%0d h0..5=%02x %02x %02x %02x %02x %02x h6=%02x",
                             a_crc_c, a_crc_e, clen,
                             histb(cur_pkt,0), histb(cur_pkt,1), histb(cur_pkt,2),
                             histb(cur_pkt,3), histb(cur_pkt,4), histb(cur_pkt,5),
                             histb(cur_pkt,6));
                end
            end
        end
    endtask

    // R8 evidence: recompute CRC over every covered byte EXCEPT idx 23.
    // It must differ from the on-wire CRC, i.e. byte 23 is inside coverage.
    task chk_crc_skip23; input [8*48-1:0] nm;
        integer i, clen;
        begin
            if (!pkt_ok) chk_fail(nm);
            else begin
                clen = clen_hist[cur_pkt];
                a_crc_c = 16'hFFFF;
                for (i = 0; i < (30 + clen); i = i + 1)
                    if (i != 23) a_crc_c = crc16f(a_crc_c, histb(cur_pkt, i));
                a_crc_e = {histb(cur_pkt, 30 + clen), histb(cur_pkt, 31 + clen)};
                if (a_crc_c !== a_crc_e) chk_pass(nm);
                else begin
                    chk_fail(nm);
                    $display("  [E] CRC without byte23 still matches: %04x/%04x", a_crc_c, a_crc_e);
                end
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // Main flow
    //--------------------------------------------------------------------------
    integer g4;
    initial begin
        repeat (10) @(posedge clk_eth);
        rst_n = 1'b1;
        repeat (20) @(posedge clk_eth);

        //==== P0: reset state -> first heartbeat byte23 = 0x00 ==============
        wait_pkt(8'hF0, "P0_HB_FOUND");
        chk_b23(8'h00, "P0_HB_BYTE23_00");
        chk_crc("P0_HB_CRC_OK");

        //==== P1: pulse class=1 conf=17 -> 0xC5 through act_state_cdc =======
        inject_act(2'd1, 5'd17);
        wait_act(8'hC5, 2000);
        if (act_byte_eth === 8'hC5) chk_pass("P1_ACT_CDC_C5");
        else begin
            chk_fail("P1_ACT_CDC_C5");
            $display("  [E] act_byte_eth=%02x exp=C5", act_byte_eth);
        end

        //==== P2: SET_PARAM ACK carries byte23 = 0xC5 =======================
        pl[0]=8'h01; pl[1]=8'h02; pl[2]=8'h03; pl[3]=8'h09;   // THETA=777
        pl[4]=8'h02; pl[5]=8'h02; pl[6]=8'h00; pl[7]=8'h7B;   // MIN_DL=123
        plen = 8;
        send_cmd(8'h01, 0);
        wait_pkt(8'h01, "P2_ACK_FOUND");
        chk_b23(8'hC5, "P2_ACK_BYTE23_C5");
        if (pkt_ok && (st_hist[cur_pkt] === 8'h00)) chk_pass("P2_ACK_STATUS_OK");
        else begin
            chk_fail("P2_ACK_STATUS_OK");
            $display("  [E] ack status=%02x", (pkt_ok ? st_hist[cur_pkt] : 8'hxx));
        end
        chk_crc("P2_ACK_CRC_OK");
        chk_crc_skip23("P2_CRC_INCLUDES_BYTE23");

        //==== P3: next periodic heartbeat carries byte23 = 0xC5 ============
        wait_pkt(8'hF0, "P3_HB_FOUND");
        chk_b23(8'hC5, "P3_HB_BYTE23_C5");
        chk_crc("P3_HB_CRC_OK");

        //==== P4: 1.0 s idle window (ACT_IDLE_CYC clk_cam cycles) ===========
        // no early clear just before the window ends
        while ((cam_cyc_q < (pulse_cyc_q + CYC - 2000)) && (clear_cyc_q < 0))
            @(posedge clk_cam);
        if ((act_byte_eth === 8'hC5) && (clear_cyc_q < 0)) chk_pass("P4_NO_EARLY_CLEAR");
        else begin
            chk_fail("P4_NO_EARLY_CLEAR");
            $display("  [E] act_byte_eth=%02x clear_cyc=%0d pulse_cyc=%0d",
                     act_byte_eth, clear_cyc_q, pulse_cyc_q);
        end

        g4 = 0;
        while ((clear_cyc_q < 0) && (g4 < (CYC + 200000))) begin
            @(posedge clk_cam);
            g4 = g4 + 1;
        end
        if ((clear_cyc_q >= 0) && (act_byte_eth === 8'h00)) chk_pass("P4_IDLE_CLEAR_00");
        else begin
            chk_fail("P4_IDLE_CLEAR_00");
            $display("  [E] act_byte_eth=%02x clear_cyc=%0d", act_byte_eth, clear_cyc_q);
        end
        if ((clear_cyc_q - pulse_cyc_q) >= CYC && (clear_cyc_q - pulse_cyc_q) <= (CYC + 10))
            chk_pass("P4_WINDOW_CYC");
        else begin
            chk_fail("P4_WINDOW_CYC");
            $display("  [E] window=%0d cycles exp 50_000_000..+10", clear_cyc_q - pulse_cyc_q);
        end
        $display("  [I] idle window measured = %0d clk_cam cycles (CYC=%0d)",
                 clear_cyc_q - pulse_cyc_q, CYC);

        //==== P5: SET_PARAM ACK after clear -> byte23 = 0x00 ================
        send_cmd(8'h01, 0);
        wait_pkt(8'h01, "P5_ACK_FOUND");
        chk_b23(8'h00, "P5_ACK_BYTE23_00");
        chk_crc("P5_ACK_CRC_OK");

        //==== P6: heartbeat after clear -> byte23 = 0x00 ====================
        wait_pkt(8'hF0, "P6_HB_FOUND");
        chk_b23(8'h00, "P6_HB_BYTE23_00");
        chk_crc("P6_HB_CRC_OK");

        repeat (50) @(posedge clk_eth);

        $display("INFO tb_act3_ctrlhdr: checks=%0d errors=%0d", checks, errors);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

    // watchdog
    initial begin
        #2_000_000_000;   // 2 s sim time (case needs ~1.07 s)
        $display("TEST_RESULT=FAIL (timeout)");
        $display("INFO tb_act3_ctrlhdr: watchdog timeout");
        $finish;
    end

endmodule
