//==============================================================================
// tb_uart_tx_frame.v -- UART event-frame TX integrity under CTRL contention
//
// Why: field capture on COM6 (115200, 4000 ms, 13700 B) shows 3 of 54 v3 frames
//      failing CRC16, all of them LONG event frames that were cut short:
//        off=4626 total=1471 ev=1445   (next telemetry magic at +31 B)
//        off=9248 total=1471 ev=1445
//        off=10831 total=1021 ev=995
//      With a 1 Hz host gateway (GET_STATUS every second) the failure rate grows
//      to ~29%, so CTRL preemption at a byte boundary is the prime suspect.
//
// This TB instantiates the REAL uart_ev_tap + REAL uart_link, seals a full
// EV_MAX=289-record event frame (EvLen=1445, total 1471 B -- exactly the field
// frame) and injects CTRL bytes while that frame is streaming. The UART line is
// decoded bit-exactly and every frame is re-assembled + CRC-checked the same way
// the host deframer does it.
//
// PASS criteria:
//   E1  at least one long event frame was received
//   E2  every event frame on the wire has a correct CRC16 (CCITT-FALSE)
//   E3  every event frame is followed immediately by the next frame magic
//   E4  no foreign bytes between frames (host would resync here)
//   E5  the no-CTRL control case is clean (proves the harness itself)
//
// On failure the TB prints UART_TX_FAIL_REPRO=1 plus the byte offset, declared
// length and where the next frame magic appeared.
//
// Clocking: 50 MHz. BAUD = CLK_HZ/16 -> the fractional accumulator emits one
// os_tick per clock, so one bit is exactly 16 clocks and one byte 160 clocks.
// That keeps a 1471 B frame at 235k clocks while staying bit-accurate.
//==============================================================================
`timescale 1ns/1ps

module tb_uart_tx_frame;

    localparam CLK_HZ   = 50_000_000;
    localparam BAUD     = 3_125_000;      // CLK_HZ/16 -> 16 clk/bit exactly
    localparam EV_MAX   = 289;            // 289 x 5 B = 1445 B payload
    localparam TELEM_MS = 60000;            // telemetry practically off: keeps the
                                            // captured byte stream deterministic              // aggressive telemetry, same family as field
    localparam EV_TOTAL = 24 + EV_MAX*5 + 2;   // 1471 B, matches field capture
    localparam RXN      = 16384;

    reg clk = 1'b0;
    always #10 clk = ~clk;                // 50 MHz

    reg rst_n = 1'b0;

    //--------------------------------------------------------------------------
    // Event source (raw retina event stream)
    //--------------------------------------------------------------------------
    reg         ev_valid = 1'b0;
    reg  [8:0]  ev_x     = 9'd0;
    reg  [7:0]  ev_y     = 8'd0;
    reg         ev_pol   = 1'b0;
    reg  [31:0] frame_cnt= 32'd0;
    reg  [1:0]  mode_i   = 2'd0;          // MODE0 = RAW_EV
    reg         ev_en    = 1'b1;
    reg  [7:0]  ser_decim= 8'd1;          // keep every event
    reg  [1:0]  ev_res   = 2'd0;
    reg  [1:0]  ser_agg  = 2'd0;          // RAW
    reg  [15:0] flush_ms = 16'd1000;      // watchdog far away: we want full frames

    wire        tap_frdy, tap_fbusy, tap_fvalid;
    wire [7:0]  tap_fdata;
    wire        tap_fack, tap_fstart;
    wire [7:0]  tap_drop;

    uart_ev_tap #(
        .CLK_HZ      (CLK_HZ),
        .EV_MAX_PACK (EV_MAX)
    ) u_tap (
        .clk           (clk),
        .rst_n         (rst_n),
        .i_ev_valid    (ev_valid),
        .i_ev_x        (ev_x),
        .i_ev_y        (ev_y),
        .i_ev_pol      (ev_pol),
        .i_frame_cnt   (frame_cnt),
        .i_mode        (mode_i),
        .i_ev_en       (ev_en),
        .i_ser_decim   (ser_decim),
        .i_ev_res      (ev_res),
        .i_ser_agg     (ser_agg),
        .i_ser_flush_ms(flush_ms),
        .o_frdy        (tap_frdy),
        .o_fbusy       (tap_fbusy),
        .o_fvalid      (tap_fvalid),
        .o_fdata       (tap_fdata),
        .i_fack        (tap_fack),
        .i_fstart      (tap_fstart),
        .o_stat_drop   (tap_drop)
    );

    //--------------------------------------------------------------------------
    // CTRL byte FIFO model (FWFT, same contract as uart_dl_bridge)
    //--------------------------------------------------------------------------
    reg  [7:0] cf [0:255];
    reg  [7:0] cf_rd = 8'd0;
    reg  [7:0] cf_wr = 8'd0;
    wire       ctrl_valid = (cf_rd != cf_wr);
    wire [7:0] ctrl_data  = cf[cf_rd];
    wire       ctrl_eop   = 1'b0;
    wire       ctrl_rd_en;

    //--------------------------------------------------------------------------
    // Real link
    //--------------------------------------------------------------------------
    wire        uart_txd;
    wire        urx_valid;
    wire [7:0]  urx_data;
    wire [15:0] st_b_cmd, st_rx_drop;

    uart_link #(
        .CLK_HZ          (CLK_HZ),
        .BAUD            (BAUD),
        .OS              (16),
        .TELEM_PERIOD_MS (TELEM_MS),
        .ASCII_TELEM     (1)
    ) u_link (
        .clk_cam                (clk),
        .rst_n_cam              (rst_n),
        .uart_rxd               (1'b1),
        .uart_txd               (uart_txd),
        .i_stat_ev_per_frame    (24'd0),
        .i_stat_activity_q16    (16'd0),
        .i_stat_cr_x10          (24'd0),
        .i_stat_frame_cnt       (32'd0),
        .i_stat_mode            (1'b0),
        .i_key_pressed          (4'd0),
        .i_cfg_ev_en            (1'b1),
        .i_frdy                 (tap_frdy),
        .i_fbusy                (tap_fbusy),
        .i_fvalid               (tap_fvalid),
        .i_fdata                (tap_fdata),
        .o_fack                 (tap_fack),
        .o_fstart               (tap_fstart),
        .i_ctrl_valid           (ctrl_valid),
        .i_ctrl_data            (ctrl_data),
        .i_ctrl_eop             (ctrl_eop),
        .o_ctrl_rd_en           (ctrl_rd_en),
        .o_urx_valid            (urx_valid),
        .o_urx_data             (urx_data),
        .i_urx_ack              (1'b0),
        .o_stat_b_cmd           (st_b_cmd),
        .o_stat_rx_drop         (st_rx_drop),
        .i_baud_sel             (2'd0),      // ★ WIRE-U2：非标准 BAUD（3.125 Mbps）⇒ 旁路恒不切
        .i_baud_pending         (1'b0),
        .o_baud_cur             ()
    );

    always @(posedge clk) begin
        if (!rst_n)                        cf_rd <= 8'd0;
        else if (ctrl_rd_en && (cf_rd != cf_wr)) cf_rd <= cf_rd + 8'd1;
    end

    //--------------------------------------------------------------------------
    // UART receiver: 16 clk/bit, 8N1, LSB first, idle high
    //--------------------------------------------------------------------------
    reg  [7:0] rxbuf [0:RXN-1];
    integer    n_rx   = 0;
    integer    rx_frm = 0;                 // framing (stop bit) errors
    reg        rx_busy= 1'b0;
    integer    rx_cnt = 0;
    reg        txd_d  = 1'b1;
    reg  [7:0] rx_sh  = 8'd0;

    always @(posedge clk) begin
        txd_d <= uart_txd;
        if (!rx_busy) begin
            if (txd_d && !uart_txd) begin
                rx_busy <= 1'b1;
                rx_cnt  <= 0;
                rx_sh   <= 8'd0;
            end
        end
        else begin
            rx_cnt <= rx_cnt + 1;
            case (rx_cnt)
                24:  rx_sh[0] <= uart_txd;
                40:  rx_sh[1] <= uart_txd;
                56:  rx_sh[2] <= uart_txd;
                72:  rx_sh[3] <= uart_txd;
                88:  rx_sh[4] <= uart_txd;
                104: rx_sh[5] <= uart_txd;
                120: rx_sh[6] <= uart_txd;
                136: rx_sh[7] <= uart_txd;
                152: begin
                         if (uart_txd !== 1'b1) begin
                             rx_frm <= rx_frm + 1;
                             $display("RX framing error at byte %0d", n_rx);
                         end
                         if (n_rx < RXN) rxbuf[n_rx] <= rx_sh;
                         n_rx   <= n_rx + 1;
                         rx_busy<= 1'b0;
                     end
                default: ;
            endcase
        end
    end

    //--------------------------------------------------------------------------
    // State trace (root-cause instrumentation, capped)
    //--------------------------------------------------------------------------
    integer    tr_cnt = 0;
    reg  [2:0] ar_d   = 3'd0;
    reg        sv_d   = 1'b0;
    always @(posedge clk) begin
        ar_d <= u_link.ar;
        sv_d <= u_tap.stream_valid;
        if (rst_n && (u_link.ar != ar_d)) begin
            if (tr_cnt < 900) begin
                tr_cnt <= tr_cnt + 1;
                $display("TRACE t=%0t ar=%0d->%0d ev_got=%0d ct_hold=%0d tx_busy=%0d tx_req=%0d fvalid=%0d fbusy=%0d tst=%0d str_ptr=%0d str_len=%0d svalid=%0d rvalid=%0d",
                         $time, ar_d, u_link.ar, u_link.ev_got, u_link.ct_hold,
                         u_link.tx_busy, u_link.tx_req, tap_fvalid, tap_fbusy,
                         u_tap.tst, u_tap.str_ptr, u_tap.str_len,
                         u_tap.stream_valid, tap_frdy);
            end
        end
        if (rst_n && sv_d && !u_tap.stream_valid) begin
            if (tr_cnt < 900) begin
                tr_cnt <= tr_cnt + 1;
                $display("TRACE t=%0t STREAM END str_ptr=%0d str_len=%0d (ev bytes sent since start)",
                         $time, u_tap.str_ptr, u_tap.str_len);
            end
        end
    end

    //--------------------------------------------------------------------------
    // Helpers
    //--------------------------------------------------------------------------
    function [15:0] crc16_range;
        input integer start;
        input integer len;
        integer i, b;
        reg [15:0] c;
        begin
            c = 16'hFFFF;
            for (i = 0; i < len; i = i + 1) begin
                c = c ^ {rxbuf[start+i], 8'h00};
                for (b = 0; b < 8; b = b + 1)
                    c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            end
            crc16_range = c;
        end
    endfunction

    function is_magic;
        input integer p;
        begin
            is_magic = (p + 3 < n_rx) &&
                       (((rxbuf[p]==8'hF0) && (rxbuf[p+1]==8'h5A) &&
                         (rxbuf[p+2]==8'hA5) && (rxbuf[p+3]==8'h30)) ||
                        ((rxbuf[p]==8'hAA) && (rxbuf[p+1]==8'h55) &&
                         (rxbuf[p+2]==8'h54) && (rxbuf[p+3]==8'h4D)));
        end
    endfunction

    integer pr_lo, pr_hi;
    integer pr_ev, pr_ev_bad, pr_telem, pr_foreign;
    integer pr_trunc_pos, pr_trunc_len, pr_trunc_decl;

    task parse_stream;
        integer i, j, evlen, total;
        reg [15:0] crc_v;
        begin
            pr_ev = 0; pr_ev_bad = 0; pr_telem = 0; pr_foreign = 0;
            pr_trunc_pos = -1; pr_trunc_len = 0; pr_trunc_decl = 0;
            i = pr_lo;
            while (i < pr_hi) begin
                if ((i + 3 < pr_hi) && (rxbuf[i]==8'hF0) && (rxbuf[i+1]==8'h5A) &&
                    (rxbuf[i+2]==8'hA5) && (rxbuf[i+3]==8'h30)) begin
                    evlen = rxbuf[i+14]*256 + rxbuf[i+15];
                    total = 24 + evlen + 2;
                    pr_ev = pr_ev + 1;
                    if (i + total <= pr_hi) begin
                        crc_v = crc16_range(i, 24 + evlen);
                        if (crc_v === {rxbuf[i+24+evlen], rxbuf[i+25+evlen]}) begin
                            i = i + total;
                        end
                        else begin
                            pr_ev_bad = pr_ev_bad + 1;
                            j = i + 4;
                            while ((j + 3 < pr_hi) && !is_magic(j)) j = j + 1;
                            if (pr_trunc_pos < 0) begin
                                pr_trunc_pos  = i;
                                pr_trunc_decl = total;
                                pr_trunc_len  = j - i;
                            end
                            i = (j + 3 < pr_hi) ? j : pr_hi;
                        end
                    end
                    else begin
                        pr_ev_bad = pr_ev_bad + 1;
                        if (pr_trunc_pos < 0) begin
                            pr_trunc_pos  = i;
                            pr_trunc_decl = total;
                            pr_trunc_len  = pr_hi - i;
                        end
                        i = pr_hi;
                    end
                end
                else if ((i + 3 < pr_hi) && (rxbuf[i]==8'hAA) && (rxbuf[i+1]==8'h55) &&
                         (rxbuf[i+2]==8'h54) && (rxbuf[i+3]==8'h4D)) begin
                    pr_telem = pr_telem + 1;
                    j = i + 21;
                    while ((j + 1 < pr_hi) && !((rxbuf[j]==8'h0D) && (rxbuf[j+1]==8'h0A))) j = j + 1;
                    i = (j + 1 < pr_hi) ? (j + 2) : pr_hi;
                end
                else begin
                    pr_foreign = pr_foreign + 1;
                    i = i + 1;
                end
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // Bookkeeping
    //--------------------------------------------------------------------------
    integer err_cnt   = 0;
    integer ev_total  = 0;
    integer ev_bad_all= 0;
    integer telem_all = 0;
    integer foreign_all = 0;
    integer stray_all   = 0;
    integer ctrl_total  = 0;
    integer ctrl_case_ev = 0;
    integer ctrl_case_bad= 0;
    integer k, ci;
    integer c0_len = 0;      // case 0 stream length (clean reference)
    integer c1_lo  = 0;      // case 1 stream start offset
    integer c1_len = 0;
    integer c2_lo  = 0;
    integer c2_len = 0;
    integer c3_lo  = 0;
    integer c3_len = 0;

    task do_case;
        input integer cid;
        input integer n_ctrl;
        input integer inject_byte;     // stream byte offset where the CTRL request lands
        input integer n_frames;
        integer m;
        begin
            $display("---- CASE %0d: ctrl_bytes=%0d inject_at_byte=%0d n_frames=%0d ----",
                     cid, n_ctrl, inject_byte, n_frames);
            rst_n   = 1'b0;
            ev_valid= 1'b0;
            cf_wr   = 8'd0;
            frame_cnt = 32'd0;
            repeat (30) @(posedge clk);
            rst_n = 1'b1;
            repeat (30) @(posedge clk);

            // The tap latches SER_DECIM / FLUSH_MS only on a camera frame edge
            // (i_frame_cnt change). Without one, flush_ms_q stays 0 and the
            // watchdog seals a bogus short frame -- emulate the real 30 fps edge.
            frame_cnt = 32'd1;
            repeat (10) @(posedge clk);

            // first frame: exactly EV_MAX records -> EV_LEN=1445 (field size)
            for (m = 0; m < EV_MAX; m = m + 1) begin
                @(negedge clk);
                ev_valid = 1'b1;
                ev_x     = m[8:0];
                ev_y     = m[7:0];
                ev_pol   = m[0];
                @(negedge clk);
                ev_valid = 1'b0;
                repeat (7) @(negedge clk);
            end
            $display("CASE %0d: frame1 fed rec_cnt=%0d af_cnt=%0d drop=%0d",
                     cid, u_tap.rec_cnt, u_tap.af_cnt, tap_drop);

            while (!u_tap.stream_valid) @(posedge clk);
            $display("CASE %0d: stream started str_len=%0d", cid, u_tap.str_len);

            // extra frames must be fed while frame 1 streams: the tap keeps only
            // one sealed frame, a second frame sealed before streaming is dropped
            for (m = 0; m < EV_MAX * (n_frames - 1); m = m + 1) begin
                @(negedge clk);
                ev_valid = 1'b1;
                ev_x     = m[8:0];
                ev_y     = m[7:0];
                ev_pol   = m[0];
                @(negedge clk);
                ev_valid = 1'b0;
                repeat (7) @(negedge clk);
            end
            if (n_frames > 1)
                $display("CASE %0d: extra frame(s) fed rec_cnt=%0d frdy=%0d drop=%0d",
                         cid, u_tap.rec_cnt, tap_frdy, tap_drop);

            // CTRL request (heartbeat GET_STATUS response) arrives at a byte
            // boundary somewhere inside the event frame
            if (n_ctrl > 0) begin
                while ((u_tap.str_ptr < inject_byte) && u_tap.stream_valid) @(posedge clk);
                for (m = 0; m < n_ctrl; m = m + 1) begin
                    cf[cf_wr] = 8'h42 + m[7:0];
                    cf_wr     = cf_wr + 8'd1;
                end
                $display("CASE %0d: injected %0d CTRL bytes at str_ptr=%0d",
                         cid, n_ctrl, u_tap.str_ptr);
            end

            // drain: wait until no frame is streaming and none is pending
            for (m = 0; m < 2_000_000; m = m + 1) begin
                @(posedge clk);
                if (!u_tap.stream_valid && !tap_frdy) m = 2_000_000;
            end
            repeat (4000) @(posedge clk);

            pr_lo = (cid == 0) ? 0 : pr_hi;
            pr_hi = n_rx;
            parse_stream;
            $display("CASE %0d RESULT: bytes=%0d ev_frames=%0d ev_bad=%0d telem=%0d stray=%0d",
                     cid, pr_hi - pr_lo, pr_ev, pr_ev_bad, pr_telem, pr_foreign);
            if (pr_trunc_pos >= 0)
                $display("CASE %0d TRUNCATED EVENT FRAME: at stream offset %0d, declared total=%0d, only %0d B before next magic",
                         cid, pr_trunc_pos - pr_lo, pr_trunc_decl, pr_trunc_len);
            ev_total    = ev_total + pr_ev;
            ev_bad_all  = ev_bad_all + pr_ev_bad;
            telem_all   = telem_all + pr_telem;
            foreign_all = foreign_all + pr_foreign;
            stray_all   = stray_all + pr_foreign;
            ctrl_total  = ctrl_total + n_ctrl;
            if (cid == 0) begin
                ctrl_case_ev  = pr_ev;
                ctrl_case_bad = pr_ev_bad;
                c0_len = pr_hi - pr_lo;
            end
            if (cid == 1) begin c1_lo = pr_lo; c1_len = pr_hi - pr_lo; end
            if (cid == 2) begin c2_lo = pr_lo; c2_len = pr_hi - pr_lo; end
            if (cid == 3) begin c3_lo = pr_lo; c3_len = pr_hi - pr_lo; end
        end
    endtask

    task chk;
        input [8*40:1] nm;
        input ok;
        begin
            if (ok) $display("CHECK=%0s PASS", nm);
            else begin
                $display("CHECK=%0s FAIL", nm);
                err_cnt = err_cnt + 1;
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // Main
    //--------------------------------------------------------------------------
    initial begin
        $display("tb_uart_tx_frame: CLK_HZ=%0d BAUD=%0d EV_MAX=%0d frame=%0d B",
                 CLK_HZ, BAUD, EV_MAX, EV_TOTAL);

        // case 0: control, no CTRL, one long frame
        do_case(0, 0, 0, 1);
        // case 1: 4-byte CTRL burst (heartbeat reply) early inside the frame
        do_case(1, 4, 100, 1);
        // case 2: 4-byte CTRL burst near the end of the frame
        do_case(2, 4, 1400, 1);
        // case 3: same CTRL burst inside frame 1, a second frame is queued
        do_case(3, 4, 100, 2);

        $display("TOTAL: ev_frames=%0d ev_bad=%0d telem=%0d foreign=%0d rx_framing_err=%0d",
                 ev_total, ev_bad_all, telem_all, foreign_all, rx_frm);

        chk("E0_control_case_clean",   (ctrl_case_ev >= 1) && (ctrl_case_bad == 0));
        chk("E1_long_ev_frames_seen",  (ev_total >= 5));
        chk("E2_ev_crc_all_ok",        (ev_bad_all == 0));
        chk("E3_ctrl_bytes_only_between_frames", (stray_all == ctrl_total));
        chk("E4_no_rx_framing_err",    (rx_frm == 0));

        $display("SUMMARY: ev_frames=%0d ev_bad=%0d ctrl_injected=%0d stray_in_stream=%0d",
                 ev_total, ev_bad_all, ctrl_total, stray_all);
        if ((ev_bad_all != 0) || (stray_all != ctrl_total))
            $display("UART_TX_FAIL_REPRO=1 bad_ev_frames=%0d ctrl_misplaced_bytes=%0d",
                     ev_bad_all, (ctrl_total - stray_all));
        else
            $display("UART_TX_FIX_OK=1");

        if (err_cnt == 0) $display("TEST_RESULT=PASS");
        else              $display("TEST_RESULT=FAIL errors=%0d", err_cnt);
        $finish;
    end

    initial begin
        #50_000_000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
