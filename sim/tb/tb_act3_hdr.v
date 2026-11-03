//==============================================================================
// tb_act3_hdr.v -- M4b ACT3_HDR: offset23 action byte latch + CRC16 (task-11)
//
// DUT chain: act_state_cdc (clk_cam -> clk_eth) -> udp_merge (WIRE_VER=3)
// Checks (all ASCII):
//   ACT3_HDR_F1_6PKTS : frame 1 (no action yet) emits exactly 6 packets
//   ACT3_HDR_INIT_ZERO: byte23 == 0x00 before any valid decision
//   ACT3_HDR_INIT_CRC : CRC16 recomputed independently over the whole packet
//                       (header incl. byte23) matches the trailing CRC
//   ACT3_HDR_F2_6PKTS : frame 2 emits exactly 6 packets
//   ACT3_HDR_BYTE23_C6: pulse class=2 conf=17 -> byte23 == 8'hC6 on every
//                       packet of that frame (same-frame consistency)
//   ACT3_HDR_C6_CRC   : independent CRC16 over frame-2 packets matches
//   ACT3_HDR_FRAME_IDX: FRAME_IDX advances 0,1,2 across the three frames
//   ACT3_HDR_BYTE23_FD: pulse class=1 conf=31 -> byte23 == 8'hFD
//   ACT3_HDR_FD_CRC   : independent CRC16 over frame-3 packets matches
//
// Run: cd /e/workspace/FPGA_Comp/retina_event
//      pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_hdr
//==============================================================================
`timescale 1ns / 1ps

module tb_act3_hdr;

    //--------------------------------------------------------------------------
    // Clocks / reset (same domains as top: clk_eth 125 MHz, clk_cam 50 MHz)
    //--------------------------------------------------------------------------
    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    always #4  clk_eth = ~clk_eth;
    always #10 clk_cam = ~clk_cam;

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
    // DUT: udp_merge v3, small picture (3840 px = 6 chunks of 1280 B / frame)
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg         ev_valid  = 1'b0;
    reg  [8:0]  ev_x      = 9'd0;
    reg  [7:0]  ev_y      = 8'd0;
    reg         ev_pol    = 1'b0;
    reg         tx_ready  = 1'b1;
    reg         cfg_en    = 1'b1;
    reg  [1:0]  mode_in   = 2'd0;
    reg  [47:0] ts_in     = 48'd1000;
    reg         ts_valid_in = 1'b1;
    reg         ts_cal_in   = 1'b0;
    reg         ev_en_in    = 1'b1;
    reg  [7:0]  decim_in    = 8'd1;
    reg  [23:0] flush_in    = 24'd65536;
    reg         ctrl_wr_en  = 1'b0;
    reg  [7:0]  ctrl_data   = 8'd0;
    reg         ctrl_commit = 1'b0;

    wire        tx_start;
    wire [7:0]  tx_byte;
    wire        tx_byte_en;
    wire [15:0] tx_len;
    wire [15:0] drop_px, drop_ev;
    wire        ctrl_empty;
    wire [15:0] frame_idx_w;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (1280),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .FRAME_DECIM  (1),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (80),
        .IMG_H        (48),
        .EV_FLUSH_CYC (65536),
        .CRC_EN       (1)
    ) dut (
        .clk_eth       (clk_eth),
        .rst_n_eth     (rst_n),
        .i_raw_valid   (raw_valid),
        .i_raw_data    (raw_data),
        .i_raw_frame_start(1'b0),
        .i_ev_valid    (ev_valid),
        .i_ev_x        (ev_x),
        .i_ev_y        (ev_y),
        .i_ev_pol      (ev_pol),
        .i_tx_ready    (tx_ready),
        .i_cfg_en      (cfg_en),
        .i_mode        (mode_in),
        .i_ts_us       (ts_in),
        .i_ts_valid    (ts_valid_in),
        .i_ts_calibrated(ts_cal_in),
        .i_ev_en       (ev_en_in),
        .i_frame_decim (decim_in),
        .i_ev_flush_cyc(flush_in),
        .i_act_byte    (act_byte_eth),
        .i_ctrl_wr_en  (ctrl_wr_en),
        .i_ctrl_data   (ctrl_data),
        .i_ctrl_commit (ctrl_commit),
        .o_ctrl_empty  (ctrl_empty),
        .o_frame_idx   (frame_idx_w),
        .o_tx_start    (tx_start),
        .o_tx_byte     (tx_byte),
        .o_tx_byte_en  (tx_byte_en),
        .o_tx_len      (tx_len),
        .o_stat_drop_px(drop_px),
        .o_stat_drop_ev(drop_ev)
    );

    //--------------------------------------------------------------------------
    // CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
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
    // Packet capture
    //--------------------------------------------------------------------------
    reg [7:0]  pkt [0:2047];
    integer    pkt_len_c;
    integer    pkt_cnt;
    reg        pkt_collecting;
    reg        pkt_ready;

    always @(posedge clk_eth) begin
        pkt_ready <= 1'b0;
        if (tx_start) begin
            pkt_len_c      <= tx_len;
            pkt_cnt        <= 0;
            pkt_collecting <= 1'b1;
        end
        else if (pkt_collecting && tx_byte_en) begin
            pkt[pkt_cnt] <= tx_byte;
            pkt_cnt      <= pkt_cnt + 1;
            if (pkt_cnt == (pkt_len_c - 1)) begin
                pkt_collecting <= 1'b0;
                pkt_ready      <= 1'b1;
            end
        end
    end

    // archive up to 24 packets (stride 2048)
    reg [7:0]  cp [0:49151];
    integer    cp_len [0:23];
    integer    cp_cnt = 0;
    integer    bi;

    always @(posedge clk_eth) begin
        if (pkt_ready) begin
            for (bi = 0; bi < pkt_len_c; bi = bi + 1)
                cp[cp_cnt*2048 + bi] <= pkt[bi];
            cp_len[cp_cnt] <= pkt_len_c;
            cp_cnt <= cp_cnt + 1;
        end
    end

    function [7:0] cp_b;
        input integer p;
        input integer o;
        begin
            cp_b = cp[p*2048 + o];
        end
    endfunction

    //--------------------------------------------------------------------------
    // Checks
    //--------------------------------------------------------------------------
    integer e_byte = 0, e_crc = 0, e_len = 0, e_frame = 0, e_hdr = 0;

    task check_frame;
        input integer p0;
        input integer n;
        input [7:0]   exp_byte;
        input integer exp_frame;
        integer p, j;
        reg [15:0] cc, ce;
        begin
            for (p = 0; p < n; p = p + 1) begin
                // ---- header fields ----
                if (cp_b(p0+p, 0) !== 8'hF0 || cp_b(p0+p, 1) !== 8'h5A ||
                    cp_b(p0+p, 2) !== 8'hA5 || cp_b(p0+p, 3) !== 8'h30 ||
                    cp_b(p0+p, 4) !== 8'h03 || cp_b(p0+p, 5) !== 8'h18) begin
                    e_hdr = e_hdr + 1;
                    $display("  [E] pkt %0d header magic/ver/len bad", p0+p);
                end
                // ---- length: 24 B hdr + 1280 B raw + 2 B CRC ----
                if (cp_len[p0+p] !== 1306) begin
                    e_len = e_len + 1;
                    $display("  [E] pkt %0d len=%0d exp=1306", p0+p, cp_len[p0+p]);
                end
                // ---- byte23 (offset 23 of the 24 B header) ----
                if (cp_b(p0+p, 23) !== exp_byte) begin
                    e_byte = e_byte + 1;
                    $display("  [E] pkt %0d byte23=%02x exp=%02x",
                             p0+p, cp_b(p0+p, 23), exp_byte);
                end
                // ---- FRAME_IDX ----
                if ({cp_b(p0+p,10), cp_b(p0+p,11)} !== exp_frame[15:0]) begin
                    e_frame = e_frame + 1;
                    $display("  [E] pkt %0d frame=%0d exp=%0d", p0+p,
                             {cp_b(p0+p,10), cp_b(p0+p,11)}, exp_frame);
                end
                // ---- independent CRC16 over [0 .. len-3] (includes byte23) ----
                cc = 16'hFFFF;
                for (j = 0; j < (cp_len[p0+p] - 2); j = j + 1)
                    cc = crc16f(cc, cp_b(p0+p, j));
                ce = {cp_b(p0+p, cp_len[p0+p]-2), cp_b(p0+p, cp_len[p0+p]-1)};
                if (cc !== ce) begin
                    e_crc = e_crc + 1;
                    $display("  [E] pkt %0d crc calc=%04x pkt=%04x len=%0d",
                             p0+p, cc, ce, cp_len[p0+p]);
                end
            end
        end
    endtask

    task dump_info;
        input integer p;
        integer j2;
        reg [15:0] cc2, ce2;
        begin
            cc2 = 16'hFFFF;
            for (j2 = 0; j2 < (cp_len[p] - 2); j2 = j2 + 1)
                cc2 = crc16f(cc2, cp_b(p, j2));
            ce2 = {cp_b(p, cp_len[p]-2), cp_b(p, cp_len[p]-1)};
            $display("INFO pkt=%0d len=%0d frame=%0d chunk=%0d byte23=%02x hdr0..7=%02x %02x %02x %02x %02x %02x %02x %02x crc_calc=%04x crc_pkt=%04x",
                     p, cp_len[p], {cp_b(p,10),cp_b(p,11)}, {cp_b(p,8),cp_b(p,9)},
                     cp_b(p,23), cp_b(p,0), cp_b(p,1), cp_b(p,2), cp_b(p,3),
                     cp_b(p,4), cp_b(p,5), cp_b(p,6), cp_b(p,7), cc2, ce2);
        end
    endtask

    //--------------------------------------------------------------------------
    // Stimulus helpers
    //--------------------------------------------------------------------------
    task feed_pix; input [15:0] d; begin
        @(negedge clk_eth);
        raw_valid <= 1'b1;
        raw_data  <= d;
        @(negedge clk_eth);
        raw_valid <= 1'b0;
    end endtask

    task feed_frame; input [31:0] base;
        integer j;
        begin
            for (j = 0; j < 3840; j = j + 1)
                feed_pix(base[15:0] + j[15:0]);
        end
    endtask

    task inject_act; input [1:0] cls; input [4:0] cf;
        begin
            @(negedge clk_cam);
            act_class <= cls;
            act_conf  <= cf;
            act_pulse <= 1'b1;
            @(negedge clk_cam);
            act_pulse <= 1'b0;
            repeat (200) @(negedge clk_eth);   // CDC settle (2 sync + 3 settle)
        end
    endtask

    //--------------------------------------------------------------------------
    // Main sequence
    //--------------------------------------------------------------------------
    initial begin
        repeat (20) @(negedge clk_eth);
        rst_n <= 1'b1;
        repeat (50) @(negedge clk_eth);

        //======================================================================
        // Frame 1: no action yet -> byte23 must stay 0x00
        //======================================================================
        feed_frame(32'h0000_0000);
        repeat (40000) @(negedge clk_eth);
        if (cp_cnt === 6) chk_pass("ACT3_HDR_F1_6PKTS");
        else begin chk_fail("ACT3_HDR_F1_6PKTS");
                   $display("  [E] cp_cnt=%0d", cp_cnt); end

        e_byte = 0; e_crc = 0; e_len = 0; e_frame = 0; e_hdr = 0;
        check_frame(0, 6, 8'h00, 0);
        if (e_byte == 0)  chk_pass("ACT3_HDR_INIT_ZERO"); else chk_fail("ACT3_HDR_INIT_ZERO");
        if (e_crc  == 0)  chk_pass("ACT3_HDR_INIT_CRC");  else chk_fail("ACT3_HDR_INIT_CRC");
        if (e_len  == 0 && e_hdr == 0) chk_pass("ACT3_HDR_INIT_HDRLEN");
        else chk_fail("ACT3_HDR_INIT_HDRLEN");
        dump_info(0);

        //======================================================================
        // Frame 2: pulse class=2 conf=17 -> byte23 = 0x80|(17<<2)|2 = 0xC6
        //======================================================================
        inject_act(2'd2, 5'd17);
        feed_frame(32'h0000_1000);
        repeat (40000) @(negedge clk_eth);
        if (cp_cnt === 12) chk_pass("ACT3_HDR_F2_6PKTS");
        else begin chk_fail("ACT3_HDR_F2_6PKTS");
                   $display("  [E] cp_cnt=%0d", cp_cnt); end

        e_byte = 0; e_crc = 0; e_len = 0; e_frame = 0; e_hdr = 0;
        check_frame(6, 6, 8'hC6, 1);
        if (e_byte == 0) chk_pass("ACT3_HDR_BYTE23_C6");
        else begin chk_fail("ACT3_HDR_BYTE23_C6");
                   $display("  [E] %0d packets with wrong byte23", e_byte); end
        if (e_crc == 0) chk_pass("ACT3_HDR_C6_CRC"); else chk_fail("ACT3_HDR_C6_CRC");
        if (e_frame == 0) chk_pass("ACT3_HDR_FRAME_IDX_F2"); else chk_fail("ACT3_HDR_FRAME_IDX_F2");
        dump_info(6);

        //======================================================================
        // Frame 3: pulse class=1 conf=31 -> byte23 = 0x80|(31<<2)|1 = 0xFD
        //======================================================================
        inject_act(2'd1, 5'd31);
        feed_frame(32'h0000_2000);
        repeat (40000) @(negedge clk_eth);
        if (cp_cnt === 18) chk_pass("ACT3_HDR_F3_6PKTS");
        else begin chk_fail("ACT3_HDR_F3_6PKTS");
                   $display("  [E] cp_cnt=%0d", cp_cnt); end

        e_byte = 0; e_crc = 0; e_len = 0; e_frame = 0; e_hdr = 0;
        check_frame(12, 6, 8'hFD, 2);
        if (e_byte == 0) chk_pass("ACT3_HDR_BYTE23_FD");
        else begin chk_fail("ACT3_HDR_BYTE23_FD");
                   $display("  [E] %0d packets with wrong byte23", e_byte); end
        if (e_crc == 0) chk_pass("ACT3_HDR_FD_CRC"); else chk_fail("ACT3_HDR_FD_CRC");
        dump_info(12);

        // Frame index must advance 0 -> 1 -> 2.
        if ({cp_b(0,10),cp_b(0,11)} === 16'd0 &&
            {cp_b(6,10),cp_b(6,11)} === 16'd1 &&
            {cp_b(12,10),cp_b(12,11)} === 16'd2)
            chk_pass("ACT3_HDR_FRAME_IDX");
        else begin
            chk_fail("ACT3_HDR_FRAME_IDX");
            $display("  [E] frames=%0d/%0d/%0d",
                     {cp_b(0,10),cp_b(0,11)}, {cp_b(6,10),cp_b(6,11)},
                     {cp_b(12,10),cp_b(12,11)});
        end

        if (drop_px == 0 && drop_ev == 0) chk_pass("ACT3_HDR_NO_DROP");
        else begin chk_fail("ACT3_HDR_NO_DROP");
                   $display("  [E] drop_px=%0d drop_ev=%0d", drop_px, drop_ev); end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    // watchdog
    initial begin
        #80000000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
