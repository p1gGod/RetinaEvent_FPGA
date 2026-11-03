//==============================================================================
// tb_act3_tlv.v -- M4b ACT3_TLV: GET_STATUS(0x04) ACK tail TLV 0x92 (task-11)
//
// DUT chain: act_state_cdc (clk_cam -> clk_eth) -> downlink_cmd (clk_eth)
// Checks (all ASCII):
//   ACT3_TLV_ZERO_103B : no valid decision -> ACK CTRL_LEN=71, total 103 B,
//                        tail 3 B = 92 01 00, CRC16 valid
//   ACT3_TLV_C6_103B   : pulse class=2 conf=17 -> tail = 92 01 C6, CRC valid
//   ACT3_TLV_FD_103B   : pulse class=1 conf=31 -> tail = 92 01 FD, CRC valid
//   ACT3_TLV_LEGACY    : TLV offsets 0x81/0x8A/0x8C/0x8D/0x8E/0x8F/0x90/0x91
//                        unchanged (old 68 B payload still parses)
//
// Run: cd /e/workspace/FPGA_Comp/retina_event
//      pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_tlv
//==============================================================================
`timescale 1ns / 1ps

module tb_act3_tlv;

    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    always #4  clk_eth = ~clk_eth;     // 125 MHz
    always #10 clk_cam = ~clk_cam;     // 50 MHz
    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // Action source (clk_cam domain) -> act_state_cdc -> clk_eth
    //--------------------------------------------------------------------------
    reg        act_pulse = 1'b0;
    reg  [1:0] act_class = 2'd0;
    reg  [4:0] act_conf  = 5'd0;
    wire [7:0] act_byte_eth;

    act_state_cdc u_act (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n),
        .i_act_pulse (act_pulse),
        .i_act_class (act_class),
        .i_act_conf  (act_conf),
        .clk_eth     (clk_eth),
        .rst_n_eth   (rst_n),
        .o_act_byte  (act_byte_eth)
    );

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
        .HEARTBEAT_CYC (32'd200000),
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
        .i_net_state    (2'd0),
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
    reg [15:0] g_seq = 16'd200;

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
                rx_valid <= 1'b1;
                rx_data  <= tx_b[i];
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

    //--------------------------------------------------------------------------
    // CTRL packet capture
    //--------------------------------------------------------------------------
    reg [7:0] hist [0:8191];
    integer   hist_ptr = 0;
    integer   pkt_start = 0;
    integer   start_hist [0:15];
    reg [7:0] op_hist   [0:15];
    integer   clen_hist [0:15];
    integer   n_pkts = 0;
    reg       commit_d = 1'b0;

    always @(posedge clk_eth) begin
        commit_d <= ctrl_commit;
        if (ctrl_wr_en && (hist_ptr < 8191)) begin
            hist[hist_ptr] <= ctrl_data;
            hist_ptr = hist_ptr + 1;
        end
        if (commit_d && (n_pkts < 16)) begin
            start_hist[n_pkts] = pkt_start;
            op_hist  [n_pkts] = hist[pkt_start + 24];
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
    // Wait / check GET_STATUS ACK
    //--------------------------------------------------------------------------
    integer ack_pkt = -1;
    integer e_ack = 0;

    task wait_ack04; input integer from_pkt;
        integer k, j;
        begin
            ack_pkt = -1;
            k = 0;
            while ((ack_pkt < 0) && (k < 50000)) begin
                @(posedge clk_eth); k = k + 1;
                for (j = from_pkt; j < n_pkts; j = j + 1)
                    if (op_hist[j] === 8'h04) ack_pkt = j;
            end
        end
    endtask

    task check_ack; input integer pn; input [7:0] exp_byte;
        integer clen, total, j;
        reg [15:0] cc, ce;
        reg ok;
        begin
            ok = 1'b1;
            clen  = clen_hist[pn];
            total = 30 + clen + 2;
            // length: CTRL_LEN must be 71, total (incl. no other envelope) = 103 B
            if (clen !== 71) begin
                ok = 1'b0;
                $display("  [E] clen=%0d exp=71", clen);
            end
            if (total !== 103) begin
                ok = 1'b0;
                $display("  [E] total=%0d exp=103", total);
            end
            // header sanity
            if (!(histb(pn,0)===8'hF0 && histb(pn,1)===8'h5A &&
                  histb(pn,2)===8'hA5 && histb(pn,3)===8'h30 &&
                  histb(pn,4)===8'h03 && histb(pn,5)===8'h18 &&
                  (histb(pn,6) & 8'h80) !== 8'h00)) begin
                ok = 1'b0;
                $display("  [E] ACK header bad h0..6=%02x %02x %02x %02x %02x %02x %02x",
                         histb(pn,0),histb(pn,1),histb(pn,2),histb(pn,3),
                         histb(pn,4),histb(pn,5),histb(pn,6));
            end
            // tail TLV 0x92 at offset 30+68..70
            if (!(histb(pn,30+68)===8'h92 && histb(pn,30+69)===8'd1 &&
                  histb(pn,30+70)===exp_byte)) begin
                ok = 1'b0;
                $display("  [E] tail TLV got %02x %02x %02x exp 92 01 %02x",
                         histb(pn,98), histb(pn,99), histb(pn,100), exp_byte);
            end
            // legacy TLV offsets must be unchanged
            if (!(histb(pn,30)===8'h81 && histb(pn,72)===8'h8A &&
                  histb(pn,77)===8'h8C && histb(pn,80)===8'h8D &&
                  histb(pn,83)===8'h8E && histb(pn,88)===8'h8F &&
                  histb(pn,91)===8'h90 && histb(pn,95)===8'h91)) begin
                ok = 1'b0;
                $display("  [E] legacy offsets bad 81=%02x 8A=%02x 8C=%02x 8D=%02x 8E=%02x 8F=%02x 90=%02x 91=%02x",
                         histb(pn,30), histb(pn,72), histb(pn,77), histb(pn,80),
                         histb(pn,83), histb(pn,88), histb(pn,91), histb(pn,95));
            end
            // CRC16 over [0 .. 30+clen-1]
            cc = 16'hFFFF;
            for (j = 0; j < (30 + clen); j = j + 1) cc = crc16f(cc, histb(pn, j));
            ce = {histb(pn, 30 + clen), histb(pn, 31 + clen)};
            if (cc !== ce) begin
                ok = 1'b0;
                $display("  [E] crc calc=%04x pkt=%04x", cc, ce);
            end
            if (ok) e_ack = 0; else e_ack = 1;
            $display("INFO ack pn=%0d clen=%0d total=%0d tail=%02x%02x%02x hdr0..7=%02x%02x%02x%02x%02x%02x%02x%02x crc=%04x/%04x",
                     pn, clen, total, histb(pn,98), histb(pn,99), histb(pn,100),
                     histb(pn,0),histb(pn,1),histb(pn,2),histb(pn,3),
                     histb(pn,4),histb(pn,5),histb(pn,6),histb(pn,7), cc, ce);
        end
    endtask

    //--------------------------------------------------------------------------
    // Stimulus
    //--------------------------------------------------------------------------
    task inject_act; input [1:0] cls; input [4:0] cf;
        begin
            @(negedge clk_cam);
            act_class <= cls;
            act_conf  <= cf;
            act_pulse <= 1'b1;
            @(negedge clk_cam);
            act_pulse <= 1'b0;
            repeat (300) @(negedge clk_eth);
        end
    endtask

    integer pkt0;

    initial begin
        repeat (20) @(negedge clk_eth);
        rst_n <= 1'b1;
        repeat (300) @(negedge clk_eth);

        //======================================================================
        // Case 1: no valid decision yet -> TLV 0x92 = 92 01 00
        //======================================================================
        pkt0 = n_pkts;
        plen = 0;
        send_cmd(8'h04, 0);
        wait_ack04(pkt0);
        if (ack_pkt >= 0) begin
            check_ack(ack_pkt, 8'h00);
            if (e_ack == 0) chk_pass("ACT3_TLV_ZERO_103B");
            else            chk_fail("ACT3_TLV_ZERO_103B");
        end
        else begin
            chk_fail("ACT3_TLV_ZERO_103B");
            $display("  [E] no GET_STATUS ACK seen (n_pkts=%0d)", n_pkts);
        end

        //======================================================================
        // Case 2: pulse class=2 conf=17 -> TLV value 0xC6
        //======================================================================
        inject_act(2'd2, 5'd17);
        pkt0 = n_pkts;
        send_cmd(8'h04, 0);
        wait_ack04(pkt0);
        if (ack_pkt >= 0) begin
            check_ack(ack_pkt, 8'hC6);
            if (e_ack == 0) chk_pass("ACT3_TLV_C6_103B");
            else            chk_fail("ACT3_TLV_C6_103B");
        end
        else begin
            chk_fail("ACT3_TLV_C6_103B");
            $display("  [E] no GET_STATUS ACK seen (n_pkts=%0d)", n_pkts);
        end

        //======================================================================
        // Case 3: pulse class=1 conf=31 -> TLV value 0xFD
        //======================================================================
        inject_act(2'd1, 5'd31);
        pkt0 = n_pkts;
        send_cmd(8'h04, 0);
        wait_ack04(pkt0);
        if (ack_pkt >= 0) begin
            check_ack(ack_pkt, 8'hFD);
            if (e_ack == 0) chk_pass("ACT3_TLV_FD_103B");
            else            chk_fail("ACT3_TLV_FD_103B");
        end
        else begin
            chk_fail("ACT3_TLV_FD_103B");
            $display("  [E] no GET_STATUS ACK seen (n_pkts=%0d)", n_pkts);
        end

        if (n_pkts === 3) chk_pass("ACT3_TLV_LEGACY");
        else begin
            chk_fail("ACT3_TLV_LEGACY");
            $display("  [E] expected 3 ACK packets (one per GET_STATUS), got %0d", n_pkts);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #2000000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
