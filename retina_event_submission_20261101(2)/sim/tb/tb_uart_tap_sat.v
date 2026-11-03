//==============================================================================
// tb_uart_tap_sat.v -- task-13: uart_ev_tap saturation corruption
//
// Purpose
//   Prove/disprove the field symptom: at high event density the serial event
//   frames keep framing (magic / EV_LEN / next magic exactly 1471 B later) but
//   the host CRC16 fails.  Payload bytes are unchanged => the corruption is in
//   the *tap* (seal-time CRC over the bank), not in the UART byte stream.
//
// Structure
//   - real uart_ev_tap DUT (CLK_HZ=50 MHz, EV_MAX_PACK=289 => 1471 B frames)
//   - event record injector driven at a chosen rate (records / cycles)
//   - TX consumer paced exactly like a 115200 8N1 UART link:
//     one byte ack per BYTE_CYCLES = 10*CLK_HZ/BAUD = 4340 cycles (86.8 us)
//   - independent checker: framing, EV_LEN, CRC16 over received bytes, and the
//     injected record sequence (x,y -> idx must advance by 1 within a frame)
//
// Scenario A (saturation): 1 record / 10 cycles  => 1.29 MB/s of record bytes,
//                          far above the 11.52 KB/s wire => seals overlap TX
// Scenario B (low rate)  : 1 record / 40000 cycles => frame every 231 ms
//                          = 6.4 KB/s of frames (<= 7 KB/s reference)
//
// Judgement
//   TAP_SAT_FAIL_REPRO=1  current RTL shows >=1 "framing ok, CRC wrong" frame
//   TAP_SAT_FIX_OK=1      A: 0 corrupt frames + drops > 0 (pressure is real)
//                         B: 0 corrupt frames at low rate
//   TEST_RESULT=PASS only when TAP_SAT_FIX_OK=1
//
// ASCII-only $display.
//==============================================================================
`timescale 1ns / 1ps

module tb_uart_tap_sat;

    //--------------------------------------------------------------------------
    // parameters
    //--------------------------------------------------------------------------
    localparam CLK_HZ      = 50_000_000;
    localparam BAUD        = 115200;
    localparam BYTE_CYCLES = (10 * CLK_HZ) / BAUD;      // 4340 cycles = 86.8 us

    localparam EV_GAP_SAT  = 10;                        // 1 rec / 200 ns  (~2000x line rate)
    localparam EV_GAP_LOW  = 40000;                     // 1 rec / 800 us  (~6.4 KB/s, <= 7 KB/s)
    localparam EV_GAP_MILD = 10850;                     // 1 rec / 217 us  (~2x line rate)

    localparam SAT_NS      = 2_000_000_000;             // 2.0 s saturated
    localparam LOW_NS      = 700_000_000;               // 0.7 s low rate (>= 3 frames)
    localparam MILD_NS     = 500_000_000;               // 0.5 s mild (>= 5 frames)
    localparam WDOG_NS     = 64'd4_200_000_000;         // 64-bit: sum of phases overflows 32-bit

    localparam EV_MAX_PACK = 289;                       // 289*5 = 1445 B payload

    //--------------------------------------------------------------------------
    // clock / reset
    //--------------------------------------------------------------------------
    reg clk = 1'b0;
    always #10 clk = ~clk;
    reg rst_n = 1'b0;

    //--------------------------------------------------------------------------
    // DUT ports
    //--------------------------------------------------------------------------
    reg         i_ev_valid = 1'b0;
    reg  [8:0]  i_ev_x     = 9'd0;
    reg  [7:0]  i_ev_y     = 8'd0;
    reg         i_ev_pol   = 1'b0;
    reg  [31:0] i_frame_cnt = 32'd0;
    reg  [1:0]  i_mode     = 2'd0;
    reg         i_ev_en    = 1'b1;
    reg  [7:0]  i_ser_decim = 8'd1;
    reg  [1:0]  i_ev_res   = 2'd0;
    reg  [1:0]  i_ser_agg  = 2'd0;
    reg  [15:0] i_ser_flush_ms = 16'd20;

    wire        o_frdy;
    wire        o_fbusy;
    wire        o_fvalid;
    wire [7:0]  o_fdata;
    reg         i_fack   = 1'b0;
    reg         i_fstart = 1'b0;
    wire [7:0]  o_stat_drop;

    uart_ev_tap #(
        .CLK_HZ      (CLK_HZ),
        .EV_MAX_PACK (EV_MAX_PACK)
    ) dut (
        .clk             (clk),
        .rst_n           (rst_n),
        .i_ev_valid      (i_ev_valid),
        .i_ev_x          (i_ev_x),
        .i_ev_y          (i_ev_y),
        .i_ev_pol        (i_ev_pol),
        .i_frame_cnt     (i_frame_cnt),
        .i_mode          (i_mode),
        .i_ev_en         (i_ev_en),
        .i_ser_decim     (i_ser_decim),
        .i_ev_res        (i_ev_res),
        .i_ser_agg       (i_ser_agg),
        .i_ser_flush_ms  (i_ser_flush_ms),
        .o_frdy          (o_frdy),
        .i_fstart        (i_fstart),
        .o_fdata         (o_fdata),
        .o_fvalid        (o_fvalid),
        .i_fack          (i_fack),
        .o_fbusy         (o_fbusy),
        .o_stat_drop     (o_stat_drop)
    );

    //--------------------------------------------------------------------------
    // record injector
    //--------------------------------------------------------------------------
    integer   ev_k      = 0;        // record sequence number (content reference)
    integer   ev_gap    = 0;
    reg       ev_enable = 1'b0;
    reg [1:0] phase     = 2'd0;     // 0 = saturation, 1 = low rate

    always @(posedge clk) begin
        if (!rst_n) begin
            ev_gap     <= EV_GAP_SAT;
            i_ev_valid <= 1'b0;
        end else begin
            i_ev_valid <= 1'b0;
            if (!ev_enable) begin
                ev_gap <= 0;
            end else if (ev_gap == 0) begin
                i_ev_valid <= 1'b1;
                i_ev_x     <= ev_k % 400;
                i_ev_y     <= (ev_k / 400) % 256;
                i_ev_pol   <= ev_k % 2;
                ev_k       <= ev_k + 1;
                ev_gap     <= ((phase == 2'd0) ? EV_GAP_SAT :
                               (phase == 2'd1) ? EV_GAP_LOW : EV_GAP_MILD) - 1;
            end else begin
                ev_gap <= ev_gap - 1;
            end
        end
    end

    //--------------------------------------------------------------------------
    // frame boundary: push every 125 ms (== 8 fps), also latches ser config
    //--------------------------------------------------------------------------
    integer fcnt_cyc = 0;
    always @(posedge clk) begin
        if (!rst_n) begin
            fcnt_cyc <= 0;
        end else if (fcnt_cyc == 6_249_999) begin
            fcnt_cyc    <= 0;
            i_frame_cnt <= i_frame_cnt + 32'd1;
        end else begin
            fcnt_cyc <= fcnt_cyc + 1;
        end
    end

    //--------------------------------------------------------------------------
    // statistics
    //--------------------------------------------------------------------------
    integer frames_rx    = 0;
    integer good_frames  = 0;
    integer crc_bad      = 0;
    integer crc_only_bad = 0;   // framing ok + content ok + only tail CRC wrong
    integer content_bad  = 0;   // payload rewritten (H1/H3 fingerprint)
    integer len_bad      = 0;
    integer framing_bad  = 0;
    integer recs_total   = 0;   // records received on the wire
    integer dropped_recs = 0;   // records skipped in the index sequence (drops)
    integer max_gap      = 1;

    // read-port race / bank overwrite monitors
    integer port_conflict = 0;  // SL_CRC phase0 collides with a TX port take
    integer seal_cyc      = 0;  // cycles in SL_CRC
    integer seal_ovl      = 0;  // SL_CRC while stream_valid
    integer ack_in_seal   = 0;  // acks landing in SL_CRC
    integer h1_stream     = 0;  // write bank == bank_stream
    integer h1_ready      = 0;  // write bank == bank_ready
    integer wr_off_bank   = 0;  // writes outside bank_collect (PE spill into next bank)
    integer drop_inc      = 0;  // o_stat_drop change events
    integer tot_ack       = 0;

    reg [7:0] drop_d = 8'd0;

    wire [2:0] wr_bank_now  = dut.wr_addr[13:11];   // BANK_BYTES = 2048 => addr[13:11]
    wire [2:0] bank_str_now = {1'b0, dut.bank_stream};
    wire [2:0] bank_rdy_now = {1'b0, dut.bank_ready};
    wire [2:0] bank_col_now = {1'b0, dut.bank_collect};
    // --- write-order monitor: PE writes must be strictly sequential inside a bank ---
    integer  wr_seq_bad = 0;
    integer  exp_off    = 0;
    integer  dbg_n      = 0;
    always @(posedge clk) begin
        if (!rst_n) begin
            exp_off <= 24;
        end else begin
            if (dut.sl == 3'd5) exp_off <= 24;   // SL_DONE: next frame starts at +24
            if (dut.wr_en && (dut.sl == 3'd0)) begin
                if (dut.wr_addr[10:0] != exp_off[10:0]) begin
                    wr_seq_bad <= wr_seq_bad + 1;
                    if (dbg_n < 8) begin
                        dbg_n <= dbg_n + 1;
                        $display("[SAT] WR_SEQ_BAD t=%0d ns addr=%0d off=%0d exp=%0d data=%02h pe_wj=%0d pe=%0d",
                                 $time, dut.wr_addr, dut.wr_addr[10:0], exp_off, dut.wr_data,
                                 dut.pe_wj, dut.pe);
                    end
                end
                exp_off <= dut.wr_addr[10:0] + 1;
            end
        end
    end

    // --- per-byte collection-epoch shadow ---------------------------------
    // Every fbuf write is stamped with the collection epoch that produced it; a
    // new epoch starts when the PE writes byte0 of the first record of a bank
    // (addr == bank_base+24).  A published frame whose records span two epochs
    // proves the bank was (partially) rewritten by another collection pass.
    integer    coll_ep  = 0;
    integer    ep_now   = 0;
    integer    ep_brk   = 0;
    integer    ep_base_i = 0;
    integer    ep_j2    = 0;
    integer    ep_nch   = 0;
    integer    ep_last  = 0;
    integer    nd       = 0;
    integer    ws_cnt   = 0;
    integer    ws_gap   = 0;
    reg [31:0] wsq [0:6143];
    reg [31:0] wts [0:6143];
    // absorber-FIFO pointer integrity
    integer    rd_jump = 0;
    integer    wr_jump = 0;
    integer    cnt_bad = 0;
    integer    push_n  = 0;
    integer    pop_n   = 0;
    reg [4:0]  prd     = 5'd0;
    reg [4:0]  pwr     = 5'd0;
    always @(posedge clk) begin
        if (rst_n) begin
            if (dut.af_wr != pwr) begin
                if (dut.af_wr != (pwr + 5'd1)) wr_jump <= wr_jump + 1;
                push_n <= push_n + 1;
                pwr    <= dut.af_wr;
            end
            if (dut.af_rd != prd) begin
                if (dut.af_rd != (prd + 5'd1)) rd_jump <= rd_jump + 1;
                pop_n <= pop_n + 1;
                prd   <= dut.af_rd;
            end
            if ((dut.af_wr - dut.af_rd) != dut.af_cnt[4:0]) cnt_bad <= cnt_bad + 1;
        end
    end
    reg [15:0] wep [0:6143];
    reg [2:0]  str_bank_snap = 3'd0;
    wire [13:0] ep_first_addr = (dut.bank_collect == 2'd0) ? 14'd24 :
                                (dut.bank_collect == 2'd1) ? 14'd2072 : 14'd4120;
    always @(posedge clk) begin
        if (!rst_n) coll_ep <= 0;
        else if (dut.wr_en) begin
            ep_now = (dut.wr_addr == ep_first_addr) ? (coll_ep + 1) : coll_ep;
            coll_ep          <= ep_now;
            wep[dut.wr_addr] <= ep_now[15:0];
            ws_cnt           <= ws_cnt + 1;
            wsq[dut.wr_addr] <= ws_cnt;
            wts[dut.wr_addr] <= $time;
        end
    end

    // --- bank lifecycle trace ---------------------------------------------
    reg [2:0] sl_d = 3'd0;
    always @(posedge clk) begin
        if (!rst_n) begin
            sl_d <= 3'd0;
        end else begin
            sl_d <= dut.sl;
            // streamer latches a frame
            if ((dut.tst == 2'd0) && dut.i_fstart && dut.ready_valid) begin
                str_bank_snap <= {1'b0, dut.bank_ready};
                $display("[SAT] TS_OFF   t=%0d bank_ready=%0d len=%0d collect=%0d stream=%0d pe_woff=%0d rec_cnt=%0d ev_bytes=%0d",
                         $time, dut.bank_ready, dut.ready_len, dut.bank_collect, dut.bank_stream,
                         dut.pe_woff, dut.rec_cnt, dut.ev_bytes);
            end
            // seal decision
            if ((dut.sl == 3'd5) && (sl_d != 3'd5)) begin
                if (!dut.ready_valid && dut.have_free)
                    $display("[SAT] SL_DONE_PUB t=%0d bank=%0d len=%0d ev_bytes=%0d rec_cnt=%0d new_collect=%0d",
                             $time, dut.bank_collect, dut.ready_len, dut.ev_bytes, dut.rec_cnt, dut.new_collect);
                else
                    $display("[SAT] SL_DONE_DROP t=%0d bank=%0d rec_cnt=%0d pe_woff=%0d ready_valid=%0d stream=%0d have_free=%0d",
                             $time, dut.bank_collect, dut.rec_cnt, dut.pe_woff,
                             dut.ready_valid, dut.bank_stream, dut.have_free);
            end
        end
    end

    wire       tx_port_take =
        ((dut.tst == 2'd3) && i_fack) ||
        ((dut.tst == 2'd0) && i_fstart && dut.ready_valid);

    //--------------------------------------------------------------------------
    // independent CRC16 (same polynomial, init 0xFFFF)
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

    //--------------------------------------------------------------------------
    // frame checker
    //--------------------------------------------------------------------------
    reg [7:0] rx [0:4095];
    integer   rx_len  = 0;
    integer   slot    = 0;
    integer   c_state = 0;

    integer jj, kk, ev_len, exp_len, nrec, firstbad, cok;
    integer hdr_ok, len_ok, crc_ok, firstbad_j, bad_idx;
    integer prev, delta, bad_delta;
    integer bx, by, bidx, idx0;
    reg [15:0] crc_v;

    task check_frame;
        begin
            frames_rx = frames_rx + 1;
            hdr_ok = 1; len_ok = 1; crc_ok = 1; cok = 1;
            firstbad = -1; firstbad_j = -1; bad_idx = 0; idx0 = 0;
            ev_len = 0; exp_len = 0; nrec = 0; crc_v = 16'hFFFF;
            if (rx_len < 26) begin
                hdr_ok = 0; len_ok = 0; crc_ok = 0; cok = 0;
            end else begin
                if ((rx[0] !== 8'hF0) || (rx[1] !== 8'h5A) || (rx[2] !== 8'hA5) ||
                    (rx[3] !== 8'h30) || (rx[4] !== 8'h03) || (rx[5] !== 8'h18) ||
                    (rx[22] !== 8'h05) || (rx[23] !== 8'h00)) hdr_ok = 0;
                ev_len  = rx[14] * 256 + rx[15];
                exp_len = 24 + ev_len + 2;
                nrec    = ev_len / 5;
                if (((ev_len % 5) !== 0) || (ev_len > 1445) || (rx_len !== exp_len)) begin
                    len_ok = 0; crc_ok = 0; cok = 0;
                end else begin
                    crc_v = 16'hFFFF;
                    for (kk = 0; kk < 24 + ev_len; kk = kk + 1)
                        crc_v = crc16f(crc_v, rx[kk]);
                    if (crc_v !== {rx[24+ev_len], rx[25+ev_len]}) crc_ok = 0;
                    for (jj = 0; jj < nrec; jj = jj + 1) begin
                        bx   = rx[24+5*jj] + 256 * rx[24+5*jj+1];
                        by   = rx[24+5*jj+2];
                        bidx = bx + 400 * by;
                        if (jj == 0) idx0 = bidx;
                        recs_total = recs_total + 1;
                        // byte-level validity: 5-byte record layout, real coordinate
                        if ((rx[24+5*jj+4] !== 8'h00) ||
                            (rx[24+5*jj+1] > 8'h01) ||
                            (rx[24+5*jj+3] > 8'h01) ||
                            (bx > 399) ||
                            ((bidx % 2) !== rx[24+5*jj+3])) begin
                            cok = 0;
                            if (firstbad < 0) begin
                                firstbad   = 24 + 5 * jj;
                                firstbad_j = jj;
                                bad_idx    = bidx;
                                bad_delta  = -1;
                            end
                        end
                        // sequence invariant: received indices must be a strictly
                        // increasing subsequence mod 102400 (drops allowed, no
                        // reordering / no duplicate / no invented index)
                        if (jj > 0) begin
                            delta = (bidx - prev) % 102400;
                            if (delta < 0) delta = delta + 102400;
                            if (delta > max_gap) max_gap = delta;
                            if ((delta == 0) || (delta > 51200)) begin
                                cok = 0;
                                if (firstbad < 0) begin
                                    firstbad   = 24 + 5 * jj;
                                    firstbad_j = jj;
                                    bad_idx    = bidx;
                                    bad_delta  = delta;
                                end
                            end
                            else dropped_recs = dropped_recs + (delta - 1);
                        end
                        prev = bidx;
                    end
                end
            end
            if (hdr_ok == 0) framing_bad = framing_bad + 1;
            if (len_ok == 0) len_bad = len_bad + 1;
            if (crc_ok == 0) begin
                crc_bad = crc_bad + 1;
                if (cok != 0) crc_only_bad = crc_only_bad + 1;
            end
            if (cok == 0) content_bad = content_bad + 1;
            if ((hdr_ok != 0) && (len_ok != 0) && (crc_ok != 0) && (cok != 0)) begin
                good_frames = good_frames + 1;
                $display("[SAT] FRAME#%0d OK len=%0d ev_len=%0d crc=%04h",
                         frames_rx, rx_len, ev_len, crc_v);
            end else begin
                $display("[SAT] FRAME#%0d BAD len=%0d ev_len=%0d hdr_ok=%0d len_ok=%0d crc_ok=%0d content_ok=%0d firstbad_off=%0d",
                         frames_rx, rx_len, ev_len, hdr_ok, len_ok, crc_ok, cok, firstbad);
                $display("[SAT]   hdr[0..7]  =%02h %02h %02h %02h %02h %02h %02h %02h",
                         rx[0], rx[1], rx[2], rx[3], rx[4], rx[5], rx[6], rx[7]);
                $display("[SAT]   hdr[8..15] =%02h %02h %02h %02h %02h %02h %02h %02h",
                         rx[8], rx[9], rx[10], rx[11], rx[12], rx[13], rx[14], rx[15]);
                $display("[SAT]   hdr[16..23]=%02h %02h %02h %02h %02h %02h %02h %02h",
                         rx[16], rx[17], rx[18], rx[19], rx[20], rx[21], rx[22], rx[23]);
                if ((cok == 0) && (firstbad >= 0))
                    $display("[SAT]   firstbad rec#%0d off=%0d got=%02h %02h %02h %02h %02h exp_idx=%0d got_idx=%0d",
                             firstbad_j, firstbad,
                             rx[24+5*firstbad_j], rx[25+5*firstbad_j], rx[26+5*firstbad_j],
                             rx[27+5*firstbad_j], rx[28+5*firstbad_j],
                             ((idx0 + firstbad_j) % 102400), bad_idx);
                if ((cok == 0) && (firstbad_j >= 0)) begin
                    for (kk = firstbad_j - 4; kk <= firstbad_j + 4; kk = kk + 1) begin
                        if ((kk >= 0) && (kk < nrec) && (24 + 5*kk + 4 < 4096))
                            $display("[SAT]     rec#%0d x=%0d y=%0d pol=%0d idx=%0d raw=%02h %02h %02h %02h %02h",
                                     kk, {1'b0, rx[24+5*kk+1]}, rx[24+5*kk+2], rx[24+5*kk+3],
                                     (rx[24+5*kk] + 256*rx[24+5*kk+1] + 400*rx[24+5*kk+2]),
                                     rx[24+5*kk], rx[24+5*kk+1], rx[24+5*kk+2],
                                     rx[24+5*kk+3], rx[24+5*kk+4]);
                    end
                end
                // does the wire equal the bank at check time?  (read-port race
                // would corrupt the earlier bytes only at seal/stream time)
                begin
                    nd = 0;
                    ep_nch = 0;
                    for (ep_j2 = 0; ep_j2 < rx_len; ep_j2 = ep_j2 + 1) begin
                        if (rx[ep_j2] !== dut.fbuf[str_bank_snap*2048 + ep_j2]) begin
                            nd = nd + 1;
                            if (ep_nch < 6) begin
                                ep_nch = ep_nch + 1;
                                $display("[SAT]   WIRE!=BANK off=%0d wire=%02h bank=%02h",
                                         ep_j2, rx[ep_j2], dut.fbuf[str_bank_snap*2048 + ep_j2]);
                            end
                        end
                    end
                    $display("[SAT]   WIRE_vs_BANK diffs=%0d of %0d (bank=%0d)",
                             nd, rx_len, str_bank_snap);
                end
                // write-sequence stamps: one monotone pass => wsq increases with
                // the record index; a rewrite pass shows up as a step back
                if (cok == 0) begin
                    ws_gap = 0;
                    for (kk = 0; kk < 288; kk = kk + 1)
                        if (wsq[str_bank_snap*2048 + 24 + 5*kk] >=
                            wsq[str_bank_snap*2048 + 24 + 5*(kk+1)])
                            ws_gap = ws_gap + 1;
                    $display("[SAT]   WTS r0=%0d r20=%0d r23=%0d r24=%0d r25=%0d r288=%0d",
                             wts[str_bank_snap*2048+24], wts[str_bank_snap*2048+24+100],
                             wts[str_bank_snap*2048+24+115], wts[str_bank_snap*2048+24+120],
                             wts[str_bank_snap*2048+24+125], wts[str_bank_snap*2048+24+1440]);
                    $display("[SAT]   WSEQ stepbacks=%0d r0=%0d r20=%0d r23=%0d r24=%0d r25=%0d r288=%0d",
                             ws_gap,
                             wsq[str_bank_snap*2048+24], wsq[str_bank_snap*2048+24+100],
                             wsq[str_bank_snap*2048+24+115], wsq[str_bank_snap*2048+24+120],
                             wsq[str_bank_snap*2048+24+125], wsq[str_bank_snap*2048+24+1440]);
                end
                // which collection epoch wrote each byte of the streamed bank?
                if (cok == 0) begin
                    ep_base_i = str_bank_snap * 2048;
                    ep_brk = 0;
                    for (kk = 0; kk < 288; kk = kk + 1)
                        if (wep[ep_base_i+24+5*kk] > wep[ep_base_i+24+5*(kk+1)])
                            ep_brk = ep_brk + 1;
                    $display("[SAT]   EPOCH bank=%0d base=%0d ep(r0)=%0d ep(r1)=%0d ep(r2)=%0d ep(r23)=%0d ep(r24)=%0d ep(r25)=%0d ep(r288)=%0d breaks=%0d",
                             str_bank_snap, ep_base_i,
                             wep[ep_base_i+24], wep[ep_base_i+29], wep[ep_base_i+34],
                             wep[ep_base_i+24+115], wep[ep_base_i+24+120], wep[ep_base_i+24+125],
                             wep[ep_base_i+24+1440], ep_brk);
                    ep_nch  = 0;
                    ep_last = wep[ep_base_i+24];
                    for (ep_j2 = 1; ep_j2 < 289; ep_j2 = ep_j2 + 1) begin
                        if (wep[ep_base_i+24+5*ep_j2] != ep_last) begin
                            ep_nch = ep_nch + 1;
                            if (ep_nch <= 10)
                                $display("[SAT]     EPCHG rec#%0d ep %0d -> %0d",
                                         ep_j2, ep_last, wep[ep_base_i+24+5*ep_j2]);
                            ep_last = wep[ep_base_i+24+5*ep_j2];
                        end
                    end
                    $display("[SAT]     EPCHG total_changes=%0d", ep_nch);
                end
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // TX consumer: exactly 1 byte ack per BYTE_CYCLES (115200 8N1 pace)
    //--------------------------------------------------------------------------
    localparam C_IDLE = 0;
    localparam C_RX   = 1;
    localparam C_END  = 2;

    always @(posedge clk) begin
        if (!rst_n) begin
            c_state  <= C_IDLE;
            i_fstart <= 1'b0;
            i_fack   <= 1'b0;
            rx_len   <= 0;
            slot     <= 0;
        end else begin
            i_fstart <= 1'b0;
            case (c_state)
                C_IDLE: begin
                    i_fack <= 1'b0;
                    if (o_frdy) begin
                        i_fstart <= 1'b1;
                        rx_len   <= 0;
                        slot     <= 0;
                        c_state  <= C_RX;
                        $display("[SAT] TX_START t=%0d ns", $time);
                    end
                end
                C_RX: begin
                    i_fack <= 1'b0;
                    if (slot != 0) begin
                        slot <= slot - 1;
                    end else if (o_fvalid && (rx_len < 4096)) begin
                        rx[rx_len] = o_fdata;
                        rx_len     <= rx_len + 1;
                        i_fack     <= 1'b1;              // one-cycle ack
                        slot       <= BYTE_CYCLES - 1;   // next byte 86.8 us later
                    end else if (!o_fbusy && (rx_len > 0)) begin
                        c_state <= C_END;
                    end
                end
                C_END: begin
                    i_fack <= 1'b0;
                    check_frame;
                    c_state <= C_IDLE;
                end
                default: c_state <= C_IDLE;
            endcase
        end
    end

    //--------------------------------------------------------------------------
    // race / H1 monitors
    //--------------------------------------------------------------------------
    always @(posedge clk) begin
        if (rst_n) begin
            if (dut.sl == 3'd3) begin
                seal_cyc <= seal_cyc + 1;
                if (dut.stream_valid) seal_ovl <= seal_ovl + 1;
            end
            if (i_fack) begin
                tot_ack <= tot_ack + 1;
                if (dut.sl == 3'd3) ack_in_seal <= ack_in_seal + 1;
            end
            if (tx_port_take && (dut.sl == 3'd3) && (dut.crc_ph == 2'd0))
                port_conflict <= port_conflict + 1;
            if (dut.wr_en && dut.stream_valid && (wr_bank_now == bank_str_now))
                h1_stream <= h1_stream + 1;
            if (dut.wr_en && dut.ready_valid && (wr_bank_now == bank_rdy_now))
                h1_ready <= h1_ready + 1;
            if (dut.wr_en && (wr_bank_now != bank_col_now))
                wr_off_bank <= wr_off_bank + 1;
            if (o_stat_drop !== drop_d) drop_inc <= drop_inc + 1;
        end
        drop_d <= o_stat_drop;
    end

    //--------------------------------------------------------------------------
    // phase snapshots / main flow
    //--------------------------------------------------------------------------
    integer sat_frames, sat_good, sat_crc, sat_conly, sat_cbad, sat_lbad, sat_fbad;
    integer sat_conflict, sat_seal, sat_ovl, sat_ackseal, sat_h1s, sat_h1r, sat_dropinc, sat_off;
    integer low_frames, low_good, low_crc, low_conly, low_cbad, low_lbad, low_fbad, low_dropinc;
    integer mid_recs, mid_drops;
    integer mild_frames, mild_good, mild_crc, mild_conly, mild_cbad, mild_lbad, mild_fbad, mild_dropinc;
    integer mild_recs, mild_drops;
    reg     sat_ok, low_ok, mild_ok;
    time    t0;

    initial begin
        $display("[SAT] ==== tb_uart_tap_sat: CLK_HZ=%0d BAUD=%0d BYTE_CYCLES=%0d SAT_NS=%0d LOW_NS=%0d MILD_NS=%0d ====",
                 CLK_HZ, BAUD, BYTE_CYCLES, SAT_NS, LOW_NS, MILD_NS);
        rst_n          = 1'b0;
        ev_enable      = 1'b0;
        phase          = 2'd0;
        i_ser_decim    = 8'd1;
        i_ser_agg      = 2'd0;
        i_ev_res       = 2'd0;
        i_ser_flush_ms = 16'd20;
        i_mode         = 2'd0;
        i_ev_en        = 1'b1;
        repeat (20) @(posedge clk);
        rst_n = 1'b1;
        repeat (10) @(posedge clk);

        // one frame edge first: latches ser config (default decim would be 32)
        @(posedge clk); i_frame_cnt <= i_frame_cnt + 32'd1;
        repeat (10) @(posedge clk);

        //======================================================================
        // phase A: saturation
        //======================================================================
        $display("[SAT] ---- phase A (saturation, 1 rec / %0d cycles) begin at %0d ns ----",
                 EV_GAP_SAT, $time);
        phase = 2'd0; t0 = $time; ev_enable = 1'b1;
        while ($time < t0 + SAT_NS) @(posedge clk);
        ev_enable = 1'b0;
        while (c_state != C_IDLE) @(posedge clk);
        repeat (5) @(posedge clk);

        sat_frames   = frames_rx;    sat_good  = good_frames;
        sat_crc      = crc_bad;      sat_conly = crc_only_bad;
        sat_cbad     = content_bad;  sat_lbad  = len_bad;  sat_fbad = framing_bad;
        sat_conflict = port_conflict; sat_seal = seal_cyc; sat_ovl  = seal_ovl;
        sat_ackseal  = ack_in_seal;  sat_dropinc = drop_inc;
        sat_h1s      = h1_stream;    sat_h1r    = h1_ready;   sat_off = wr_off_bank;
        $display("[SAT] phase A end  t=%0d ns frames=%0d good=%0d crc_bad=%0d crc_only=%0d content_bad=%0d len_bad=%0d framing_bad=%0d",
                 $time, sat_frames, sat_good, sat_crc, sat_conly, sat_cbad, sat_lbad, sat_fbad);
        $display("[SAT] phase A probe conflict=%0d seal_cyc=%0d seal_overlap=%0d ack_in_seal=%0d ack_total=%0d h1_stream=%0d h1_ready=%0d drop_inc=%0d drop_stat=%0d",
                 sat_conflict, sat_seal, sat_ovl, sat_ackseal, tot_ack,
                 sat_h1s, sat_h1r, sat_dropinc, o_stat_drop);

        //======================================================================
        // phase B: low rate (<= 7 KB/s of frames)
        //======================================================================
        rst_n = 1'b0;
        repeat (20) @(posedge clk);
        rst_n = 1'b1;
        repeat (10) @(posedge clk);
        @(posedge clk); i_frame_cnt <= i_frame_cnt + 32'd1;
        repeat (10) @(posedge clk);
        $display("[SAT] ---- phase B (low rate, 1 rec / %0d cycles ~ 6.4 KB/s) begin at %0d ns ----",
                 EV_GAP_LOW, $time);
        phase = 2'd1; t0 = $time; ev_enable = 1'b1;
        while ($time < t0 + LOW_NS) @(posedge clk);
        ev_enable = 1'b0;
        while (c_state != C_IDLE) @(posedge clk);
        repeat (5) @(posedge clk);

        low_frames  = frames_rx    - sat_frames;
        low_good    = good_frames  - sat_good;
        low_crc     = crc_bad      - sat_crc;
        low_conly   = crc_only_bad - sat_conly;
        low_cbad    = content_bad  - sat_cbad;
        low_lbad    = len_bad      - sat_lbad;
        low_fbad    = framing_bad  - sat_fbad;
        low_dropinc = drop_inc     - sat_dropinc;
        $display("[SAT] phase B end  t=%0d ns frames=%0d good=%0d crc_bad=%0d crc_only=%0d content_bad=%0d len_bad=%0d framing_bad=%0d drop_inc=%0d",
                 $time, low_frames, low_good, low_crc, low_conly, low_cbad, low_lbad, low_fbad, low_dropinc);

        mid_recs  = recs_total;
        mid_drops = dropped_recs;

        //======================================================================
        // phase C: mild saturation (~2x line rate == field-like overload)
        //======================================================================
        rst_n = 1'b0;
        repeat (20) @(posedge clk);
        rst_n = 1'b1;
        repeat (10) @(posedge clk);
        @(posedge clk); i_frame_cnt <= i_frame_cnt + 32'd1;
        repeat (10) @(posedge clk);
        $display("[SAT] ---- phase C (mild saturation, 1 rec / %0d cycles ~ 2x line rate) begin at %0d ns ----",
                 EV_GAP_MILD, $time);
        phase = 2'd2; t0 = $time; ev_enable = 1'b1;
        while ($time < t0 + MILD_NS) @(posedge clk);
        ev_enable = 1'b0;
        while (c_state != C_IDLE) @(posedge clk);
        repeat (5) @(posedge clk);

        mild_frames  = frames_rx    - sat_frames - low_frames;
        mild_good    = good_frames  - sat_good   - low_good;
        mild_crc     = crc_bad      - sat_crc    - low_crc;
        mild_cbad    = content_bad  - sat_cbad   - low_cbad;
        mild_lbad    = len_bad      - sat_lbad   - low_lbad;
        mild_fbad    = framing_bad  - sat_fbad   - low_fbad;
        mild_dropinc = drop_inc     - sat_dropinc - low_dropinc;
        mild_recs    = recs_total   - mid_recs;
        mild_drops   = dropped_recs - mid_drops;
        $display("[SAT] phase C end  t=%0d ns frames=%0d good=%0d crc_bad=%0d content_bad=%0d len_bad=%0d framing_bad=%0d drop_inc=%0d recs=%0d dropped_recs=%0d",
                 $time, mild_frames, mild_good, mild_crc, mild_cbad, mild_lbad, mild_fbad,
                 mild_dropinc, mild_recs, mild_drops);

        //======================================================================
        // verdict
        //======================================================================
        // No-frame phase must NOT be silently folded into OK: report it as SKIPPED
        // with an explicit reason (Lead m00951 item 2).
        if (sat_frames == 0)
            $display("[SAT] SKIP phase A (saturation): 0 frames received in %0d ns (frame period ~128 ms)",
                     SAT_NS);
        if (low_frames == 0)
            $display("[SAT] SKIP phase B (low rate 6.4 KB/s): 0 frames received in %0d ns (need > 128 ms/frame)",
                     LOW_NS);
        if (mild_frames == 0)
            $display("[SAT] SKIP phase C (mild 2x line): 0 frames received in %0d ns (need > 64 ms/frame)",
                     MILD_NS);

        sat_ok  = (sat_frames >= 8) && (sat_dropinc > 0) &&
                  (sat_crc == 0) && (sat_cbad == 0) && (sat_lbad == 0) && (sat_fbad == 0);
        low_ok  = (low_frames >= 2) &&
                  (low_crc == 0) && (low_cbad == 0) && (low_lbad == 0) && (low_fbad == 0);
        mild_ok = (mild_frames >= 2) &&
                  (mild_crc == 0) && (mild_cbad == 0) && (mild_lbad == 0) && (mild_fbad == 0);
        if ((low_frames > 0) && (low_frames < 2))
            $display("[SAT] NOTE phase B under-filled: %0d frame(s), need >= 2 -> treated as NOT OK", low_frames);
        if ((mild_frames > 0) && (mild_frames < 2))
            $display("[SAT] NOTE phase C under-filled: %0d frame(s), need >= 2 -> treated as NOT OK", mild_frames);

        $display("[SAT] ==== summary ====");
        $display("[SAT] A_sat : frames=%0d good=%0d crc_bad=%0d (crc_only=%0d) content_bad=%0d len_bad=%0d framing_bad=%0d drop_inc=%0d",
                 sat_frames, sat_good, sat_crc, sat_conly, sat_cbad, sat_lbad, sat_fbad, sat_dropinc);
        $display("[SAT] A_port: conflict=%0d seal_cyc=%0d seal_overlap=%0d ack_in_seal=%0d h1_stream=%0d h1_ready=%0d wr_off_bank=%0d",
                 sat_conflict, sat_seal, sat_ovl, sat_ackseal, sat_h1s, sat_h1r, sat_off);
        $display("[SAT] B_low : frames=%0d good=%0d crc_bad=%0d content_bad=%0d len_bad=%0d framing_bad=%0d drop_inc=%0d",
                 low_frames, low_good, low_crc, low_cbad, low_lbad, low_fbad, low_dropinc);
        $display("[SAT] C_mild: frames=%0d good=%0d crc_bad=%0d content_bad=%0d len_bad=%0d framing_bad=%0d drop_inc=%0d recs=%0d dropped_recs=%0d",
                 mild_frames, mild_good, mild_crc, mild_cbad, mild_lbad, mild_fbad,
                 mild_dropinc, mild_recs, mild_drops);
        $display("[SAT] E_afifo: pushes=%0d pops=%0d rd_jump=%0d wr_jump=%0d cnt_bad=%0d o_stat_drop=%0d",
                 push_n, pop_n, rd_jump, wr_jump, cnt_bad, o_stat_drop);
        $display("[SAT] D_total: recs_on_wire=%0d dropped_recs=%0d max_gap=%0d",
                 recs_total, dropped_recs, max_gap);

        if ((sat_crc > 0) || (sat_cbad > 0) || (sat_lbad > 0) || (sat_fbad > 0) ||
            (mild_crc > 0) || (mild_cbad > 0) || (mild_lbad > 0) || (mild_fbad > 0)) begin
            $display("TAP_SAT_FAIL_REPRO=1 sat_corrupt_frames=%0d crc_only=%0d content_bad=%0d mild_corrupt_frames=%0d",
                     sat_crc + sat_cbad + sat_lbad + sat_fbad, sat_conly, sat_cbad,
                     mild_crc + mild_cbad + mild_lbad + mild_fbad);
        end else begin
            $display("TAP_SAT_FAIL_REPRO=0 (no corruption reproduced)");
        end

        if (sat_ok && low_ok && mild_ok) begin
            $display("TAP_SAT_FIX_OK=1");
            $display("TEST_RESULT=PASS");
        end else begin
            $display("TAP_SAT_FIX_OK=0 sat_ok=%0d(sat_frames=%0d drop_inc=%0d crc_bad=%0d content_bad=%0d) low_ok=%0d(low_frames=%0d crc_bad=%0d content_bad=%0d) mild_ok=%0d(mild_frames=%0d crc_bad=%0d content_bad=%0d)",
                     sat_ok, sat_frames, sat_dropinc, sat_crc, sat_cbad, low_ok, low_frames, low_crc, low_cbad,
                     mild_ok, mild_frames, mild_crc, mild_cbad);
            $display("TEST_RESULT=FAIL");
        end
        $display("[SAT] done at %0d ns", $time);
        $finish;
    end

    // watchdog
    initial begin
        #(WDOG_NS);
        $display("[SAT] WATCHDOG timeout at %0d ns", $time);
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
