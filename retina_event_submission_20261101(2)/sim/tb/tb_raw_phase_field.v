//==============================================================================
// tb_raw_phase_field.v -- RAW label vs content phase at FIELD scale (80 chunks/frame)
//   sibling of tb_raw_phase.v (small 10-chunk frame, fast baseline); this one
//   reproduces the field shape: a MODE2 stay that crosses whole frame borders.
//
// BUG UNDER TEST (retina_event/src/hdl/comms/udp_merge.v):
//   The RAW chunk/frame labels (chunk_idx / frame_idx) only advance on
//   raw_pop_now (= dequeue/send done, udp_merge.v:733-742), while the pixel
//   side keeps accepting pixels during MODE2: pix_accept = i_raw_valid &
//   (n_full != SLOTS_3) (udp_merge.v:339) stays 1, so wr_pix_cnt and
//   pix_in_frame keep advancing (udp_merge.v:697-709 / :724-731) while
//   nothing is enqueued (raw_en_q = 0 in MODE2, udp_merge.v:700-706).
//   => after MODE2 -> MODE0 the label phase and the pixel-content phase are
//      permanently offset (sticky). The first RAW chunk handed to the host
//      after recovery is labelled CHUNK_IDX=0 while its first pixel is NOT
//      pixel 0 of a frame: the host stitches the frame with a fixed rotation
//      and shows one horizontal seam where the label wraps.
//
// WHAT THIS TB ASSERTS (desired behaviour -- must PASS only after the fix):
//   A1  no pixel is ever dropped (o_stat_drop_px == 0 for the whole case)
//   A2  first RAW chunk after MODE2->MODE0: CHUNK_IDX==0, FIRST_OF_FRAME==1
//       and its first content pixel is pixel 0 of the frame
//   A3  every RAW chunk: CHUNK_IDX == content_start/640 (label follows the
//       content pixels), and the 640 pixels of a chunk are consecutive
//   A4  for one FRAME_IDX the chunk sequence is 0..CHUNKS-1 exactly once (no gap, no
//       duplicate, a new FRAME_IDX always starts at chunk 0, no half frame at
//       the end of the case)
//   A5  FRAME_IDX is monotonic (never goes backwards)
//   A6  RAW_LEN is 1280 on every RAW chunk
//
// GEOMETRY: IMG_W=800 IMG_H=64 => 51200 px/frame = 80 chunks. The product
// config is 800x480 = 384000 px = 600 chunks/frame; this TB keeps a frame
// small enough to simulate but large enough that a MODE2 stay of a few hundred
// thousand pixels crosses whole frames -- the field shape (the host reported a
// ~240-chunk rotation, i.e. a MODE2 stay of 153600..154239 px mod 384000).
// The pixel DATA value is the pixel index inside the frame (0..51199), so the
// packet content itself carries its raster phase. With no pixel drops the
// content start of a chunk must be a multiple of 640.
//
// THREE CASES, pixel stream CONTINUOUS during MODE2 (as on the real board:
// pix_accept does not depend on the mode, so the stale offset must grow with
// the MODE2 pixel count, mod one frame):
//   case0 STALL=  3072 px -> offset floor( 3072/640)            =  4 chunks (inside one frame)
//   case1 STALL=200000 px -> offset floor((200000%51200)/640)   = 72 chunks (crosses 3 frame borders)
//   case2 STALL=800000 px -> offset floor((800000%51200)/640)   = 50 chunks (crosses 15 frame borders)
// Normal feeding is 3 clk/pixel (one chunk = 1920 clk > 1308 clk send time, so
// the 4-slot ring never overflows); while in MODE2 the ring is empty and the
// pixel is fed at 1 px/clk.
//==============================================================================
`timescale 1ns / 1ps

module tb_raw_phase_field;

    //--------------------------------------------------------------------------
    // geometry / stimulus configuration
    //--------------------------------------------------------------------------
    localparam IMG_W   = 800;
    localparam IMG_H   = 64;
    localparam PIXFR   = IMG_W * IMG_H;   // 6400 pixels per frame
    localparam PIXCH   = 640;             // pixels per RAW chunk (RAW_CHUNK/2)
    localparam CHUNKS  = PIXFR / PIXCH;   // 10 chunks per frame
    localparam STALL_A = 3072;            // MODE2 hold, case 0  (< 1 frame)
    localparam STALL_B = 200000;          // MODE2 hold, case 1  (3.9 frames)
    localparam STALL_C = 800000;          // MODE2 hold, case 2  (15.6 frames)

    reg clk = 1'b0;
    always #4 clk = ~clk;                 // 125 MHz

    reg rst_n = 1'b0;

    integer errors = 0;

    task chk_pass_c; input [8*48-1:0] nm; input integer cid; begin
        $display("CHECK=%0s_case%0d PASS", nm, cid);
    end endtask

    task chk_fail_c; input [8*48-1:0] nm; input integer cid; begin
        $display("CHECK=%0s_case%0d FAIL", nm, cid);
        errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg  [1:0]  mode_in   = 2'd0;

    wire        tx_start;
    wire [7:0]  tx_byte;
    wire        tx_byte_en;
    wire [15:0] tx_len;
    wire        ctrl_empty;
    wire [15:0] frame_idx_w;
    wire [15:0] drop_px;
    wire [15:0] drop_ev;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (1280),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (IMG_W),
        .IMG_H        (IMG_H),
        .CHUNK_SLOTS  (4),
        .CRC_EN       (1)
    ) u_merge (
        .clk_eth         (clk),
        .rst_n_eth       (rst_n),
        .i_raw_valid     (raw_valid),
        .i_raw_data      (raw_data),
        .i_raw_frame_start(1'b0),      // ★ SEAM-LINKDROP：本 TB 走 legacy（自己数帧首）路径
        .i_ev_valid      (1'b0),
        .i_ev_x          (9'd0),
        .i_ev_y          (8'd0),
        .i_ev_pol        (1'b0),
        .i_tx_ready      (1'b1),
        .i_cfg_en        (1'b1),
        .o_tx_start      (tx_start),
        .o_tx_byte       (tx_byte),
        .o_tx_byte_en    (tx_byte_en),
        .o_tx_len        (tx_len),
        .i_mode          (mode_in),
        .i_ts_us         (48'd0),
        .i_ts_valid      (1'b0),
        .i_ts_calibrated (1'b0),
        .i_ev_en         (1'b1),
        .i_frame_decim   (8'd1),
        .i_ev_flush_cyc  (24'd65536),
        .i_act_byte      (8'h00),        // ★ M4b：无动作
        .i_ctrl_wr_en    (1'b0),
        .i_ctrl_data     (8'd0),
        .i_ctrl_commit   (1'b0),
        .o_ctrl_empty    (ctrl_empty),
        .o_stat_drop_px  (drop_px),
        .o_stat_drop_ev  (drop_ev),
        .o_frame_idx     (frame_idx_w)
    );

    //--------------------------------------------------------------------------
    // Ethernet packet capture (same scheme as tb_wire_v3)
    //--------------------------------------------------------------------------
    reg [7:0] pkt [0:2047];
    integer   pkt_len_c   = 0;
    integer   pkt_cnt     = 0;
    reg       pkt_collecting = 1'b0;
    reg       pkt_ready      = 1'b0;

    always @(posedge clk) begin
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

    //--------------------------------------------------------------------------
    // per-case statistics (reset at the start of every case)
    //--------------------------------------------------------------------------
    integer    case_id      = 0;
    integer    e_phase      = 0;   // A3  label != content phase
    integer    e_contig     = 0;   // A3b content pixels not consecutive
    integer    e_first      = 0;   // A2  first chunk after resume wrong
    integer    e_mono       = 0;   // A5  FRAME_IDX backwards
    integer    e_seq        = 0;   // A4  frame/chunk sequence broken
    integer    e_len        = 0;   // A6  packet length / non-raw packet
    integer    e_drop       = 0;   // A1  tb-side drop bookkeeping
    integer    have_prev    = 0;
    integer    n_raw        = 0;
    integer    n_resume_hit = 0;
    integer    since_resume = 999;
    reg [15:0] last_frame   = 16'd0;
    reg [15:0] last_chunk   = 16'd0;
    reg [15:0] exp_chunk    = 16'd0;
    reg        resume_armed = 1'b0;

    task reset_case_stats; begin
        e_phase      = 0;
        e_contig     = 0;
        e_first      = 0;
        e_mono       = 0;
        e_seq        = 0;
        e_len        = 0;
        e_drop       = 0;
        have_prev    = 0;
        n_raw        = 0;
        n_resume_hit = 0;
        since_resume = 999;
        last_frame   = 16'd0;
        last_chunk   = 16'd0;
        exp_chunk    = 16'd0;
        resume_armed = 1'b0;
    end endtask

    //--------------------------------------------------------------------------
    // packet checker
    //--------------------------------------------------------------------------
    task check_pkt;
        reg [15:0] pi;
        reg [15:0] first_idx, lbl_exp, got_idx, exp_idx;
        reg [15:0] p_chunk, p_frame, p_rawlen;
        reg [7:0]  p_flags;
        reg        ok_contig;
    begin
        p_flags  = pkt[6];
        p_chunk  = {pkt[8],  pkt[9]};
        p_frame  = {pkt[10], pkt[11]};
        p_rawlen = {pkt[12], pkt[13]};

        if (p_rawlen == 16'd0) begin
            $display("  [E] case%0d unexpected non-RAW packet len=%0d flags=%02b",
                     case_id, pkt_len_c, p_flags);
            e_len = e_len + 1;
        end
        else begin
            n_raw = n_raw + 1;
            if (p_rawlen != 16'd1280) begin
                e_len = e_len + 1;
                $display("  [E] case%0d pkt#%0d RAW_LEN=%0d expected 1280",
                         case_id, n_raw, p_rawlen);
            end

            first_idx = {pkt[24], pkt[25]};   // raw pixel 0, big endian
            if (since_resume < 999) since_resume = since_resume + 1;

            if (since_resume < 8) begin
                $display("  PKT_AFTER_RESUME case%0d n=%0d FRAME_IDX=%0d CHUNK_IDX=%0d content_start=%0d FIRST=%b",
                         case_id, since_resume, p_frame, p_chunk, first_idx, p_flags[5]);
            end

            // ---- A3: the label must follow the content pixels -------------
            lbl_exp = first_idx / 16'd640;
            if (p_chunk != lbl_exp) begin
                e_phase = e_phase + 1;
                $display("  [E] case%0d pkt#%0d LABEL/CONTENT MISMATCH: CHUNK_IDX=%0d but content starts at pixel %0d (== chunk %0d), FRAME_IDX=%0d flags=%02b",
                         case_id, n_raw, p_chunk, first_idx, lbl_exp, p_frame, p_flags);
            end

            // ---- A3b: the 640 pixels of a chunk are consecutive -----------
            ok_contig = 1'b1;
            for (pi = 16'd0; pi < 16'd640; pi = pi + 16'd1) begin
                got_idx = {pkt[24 + 2*pi], pkt[24 + 2*pi + 1]};
                exp_idx = first_idx + pi;
                if (got_idx !== exp_idx) ok_contig = 1'b0;
            end
            if (!ok_contig) begin
                e_contig = e_contig + 1;
                $display("  [E] case%0d pkt#%0d content pixels not consecutive from pixel %0d (CHUNK_IDX=%0d)",
                         case_id, n_raw, first_idx, p_chunk);
            end

            // ---- A2: first RAW chunk after MODE2 -> MODE0 ------------------
            if (resume_armed) begin
                resume_armed = 1'b0;
                n_resume_hit = n_resume_hit + 1;
                since_resume = 0;
                if ((p_chunk != 16'd0) || (first_idx != 16'd0) || (p_flags[5] != 1'b1)) begin
                    e_first = e_first + 1;
                    $display("  [E] case%0d FIRST RAW PKT AFTER RESUME: CHUNK_IDX=%0d content_start=%0d FIRST_OF_FRAME=%b FRAME_IDX=%0d  (expected CHUNK_IDX=0 content_start=0 FIRST=1)",
                             case_id, p_chunk, first_idx, p_flags[5], p_frame);
                end
                else begin
                    $display("  INFO case%0d first RAW pkt after resume OK: CHUNK_IDX=0 content_start=0 FRAME_IDX=%0d",
                             case_id, p_frame);
                end
            end

            // ---- A4/A5: frame & chunk bookkeeping --------------------------
            if (have_prev == 0) begin
                if (p_chunk != 16'd0) begin
                    e_seq = e_seq + 1;
                    $display("  [E] case%0d first RAW pkt of case has CHUNK_IDX=%0d", case_id, p_chunk);
                end
            end
            else if (p_frame < last_frame) begin
                e_mono = e_mono + 1;
                $display("  [E] case%0d FRAME_IDX went backwards %0d -> %0d",
                         case_id, last_frame, p_frame);
            end
            else if (p_frame == last_frame) begin
                if (exp_chunk == 16'd0) begin
                    e_seq = e_seq + 1;
                    $display("  [E] case%0d FRAME_IDX %0d repeated after its last chunk (CHUNK_IDX=%0d)",
                             case_id, p_frame, p_chunk);
                end
                else if (p_chunk != exp_chunk) begin
                    e_seq = e_seq + 1;
                    $display("  [E] case%0d FRAME_IDX %0d chunk gap: got CHUNK_IDX=%0d expected %0d",
                             case_id, p_frame, p_chunk, exp_chunk);
                end
            end
            else begin  // p_frame > last_frame
                if (p_chunk != 16'd0) begin
                    e_seq = e_seq + 1;
                    $display("  [E] case%0d new FRAME_IDX %0d does not start at CHUNK_IDX=0 (got %0d)",
                             case_id, p_frame, p_chunk);
                end
            end

            exp_chunk  = (p_chunk == (CHUNKS - 1)) ? 16'd0 : (p_chunk + 16'd1);
            last_frame = p_frame;
            last_chunk = p_chunk;
            have_prev  = 1;
        end
    end endtask

    always @(posedge clk) if (pkt_ready) check_pkt;

    //--------------------------------------------------------------------------
    // pixel stimulus
    //--------------------------------------------------------------------------
    reg [15:0] tb_idx = 16'd0;   // pixel index inside the frame, also the data
    integer    px_fed = 0;       // pixels driven by the TB
    integer    n_acc  = 0;       // pixels accepted by the DUT (u_merge.pix_accept)

    always @(posedge clk) if (u_merge.pix_accept) n_acc = n_acc + 1;

    task set_mode; input [1:0] m; begin
        @(posedge clk);
        mode_in <= m;
    end endtask

    task wait_mode; input [1:0] m; input integer maxc;
        integer g;
    begin
        g = 0;
        @(posedge clk);
        while ((u_merge.mode_q != m) && (g < maxc)) begin
            @(posedge clk);
            g = g + 1;
        end
        if (u_merge.mode_q != m) begin
            $display("  [E] case%0d MODE%0d did not latch (mode_q=%0d)", case_id, m, u_merge.mode_q);
            errors = errors + 1;
        end
        else begin
            $display("  INFO case%0d MODE%0d latched", case_id, m);
        end
    end endtask

    // 1 pixel per 3 clock cycles (normal streaming rate)
    task feed_px_paced; begin
        @(posedge clk);
        raw_valid <= 1'b1;
        raw_data  <= tb_idx;
        tb_idx    <= (tb_idx == (PIXFR - 1)) ? 16'd0 : (tb_idx + 16'd1);
        px_fed    = px_fed + 1;
        @(posedge clk);
        raw_valid <= 1'b0;
        @(posedge clk);
    end endtask

    // 1 pixel per clock cycle (MODE2 hold: ring is empty, nothing is enqueued)
    task feed_px_fast; begin
        @(posedge clk);
        raw_valid <= 1'b1;
        raw_data  <= tb_idx;
        tb_idx    <= (tb_idx == (PIXFR - 1)) ? 16'd0 : (tb_idx + 16'd1);
        px_fed    = px_fed + 1;
    end endtask

    // wait until the sender is idle and the chunk ring is empty
    task wait_drain;
        integer g;
    begin
        g = 0;
        while (((u_merge.state != 3'd0) || (u_merge.n_full != 3'd0)) && (g < 20000)) begin
            @(posedge clk);
            g = g + 1;
        end
        if (g >= 20000) begin
            $display("  [E] case%0d wait_drain timeout: state=%0d n_full=%0d chunk_idx=%0d",
                     case_id, u_merge.state, u_merge.n_full, u_merge.chunk_idx);
            errors = errors + 1;
        end
        repeat (8) @(posedge clk);
    end endtask

    //--------------------------------------------------------------------------
    // one full case
    //--------------------------------------------------------------------------
    task do_case; input integer cid; input integer nstall;
        integer j;
        integer rem;
        integer guard;
    begin
        case_id = cid;
        reset_case_stats;
        raw_valid <= 1'b0;
        rst_n     <= 1'b0;
        mode_in   <= 2'd0;
        tb_idx     = 16'd0;
        px_fed     = 0;
        n_acc      = 0;
        repeat (10) @(posedge clk);
        rst_n <= 1'b1;
        repeat (6) @(posedge clk);
        $display("INFO case%0d START (MODE2 hold = %0d pixels)", cid, nstall);

        //---- phase A: two entire frames in MODE0, paced -------------------
        for (j = 0; j < 2*PIXFR; j = j + 1) feed_px_paced;
        wait_drain;
        if ((u_merge.pix_in_frame == 19'd0) && (u_merge.wr_pix_cnt == 10'd0) &&
            (u_merge.n_full == 3'd0) && (u_merge.chunk_idx == 16'd0)) begin
            chk_pass_c("D0_aligned_before_mode2", cid);
        end
        else begin
            $display("  [E] case%0d not aligned before MODE2: pix_in_frame=%0d wr_pix_cnt=%0d n_full=%0d chunk_idx=%0d",
                     cid, u_merge.pix_in_frame, u_merge.wr_pix_cnt,
                     u_merge.n_full, u_merge.chunk_idx);
            chk_fail_c("D0_aligned_before_mode2", cid);
        end
        $display("  INFO case%0d phase A done: px_fed=%0d raw_pkts=%0d frame_idx=%0d",
                 cid, px_fed, n_raw, frame_idx_w);

        //---- phase B: stop the raw stream (MODE2) at the frame boundary ---
        set_mode(2'd2);
        wait_mode(2'd2, 200);

        //---- phase C: keep feeding pixels while nothing is enqueued ------
        for (j = 0; j < nstall; j = j + 1) feed_px_fast;
        @(posedge clk);
        raw_valid <= 1'b0;   // last pixel was seen on this edge
        @(posedge clk);
        $display("  INFO case%0d phase C done: px_fed=%0d (raw_en_q=%b n_full=%0d)",
                 cid, px_fed, u_merge.raw_en_q, u_merge.n_full);

        //---- phase D: back to MODE0 (resume the raw stream) --------------
        mode_in <= 2'd0;
        @(posedge clk);
        resume_armed = 1'b1;
        wait_mode(2'd0, 200);

        //---- phase E: feed up to the frame boundary + 3 whole frames -----
        rem = nstall - (nstall / PIXFR) * PIXFR;   // pixels into the frame
        if (rem == 0) rem = PIXFR;                 // stay frame aligned
        rem = PIXFR - rem;                         // to the next frame start
        $display("  INFO case%0d phase E: feed %0d px to the frame boundary + %0d px",
                 cid, rem, 3*PIXFR);
        for (j = 0; j < rem; j = j + 1) feed_px_paced;
        for (j = 0; j < 3*PIXFR; j = j + 1) feed_px_paced;
        wait_drain;
        $display("  INFO case%0d phase E done: px_fed=%0d raw_pkts=%0d frame_idx=%0d tb_idx=%0d",
                 cid, px_fed, n_raw, frame_idx_w, tb_idx);

        //---- case verdicts ----------------------------------------------
        if ((e_drop == 0) && (drop_px == 16'd0) && (n_acc == px_fed)) begin
            chk_pass_c("A1_no_pixel_drop", cid);
        end
        else begin
            $display("  [E] case%0d pixel drop: o_stat_drop_px=%0d accepted=%0d fed=%0d",
                     cid, drop_px, n_acc, px_fed);
            chk_fail_c("A1_no_pixel_drop", cid);
        end

        if ((e_first == 0) && (n_resume_hit == 1)) begin
            chk_pass_c("A2_first_raw_after_resume", cid);
        end
        else begin
            $display("  [E] case%0d A2: errors=%0d hits=%0d (expected hits=1)",
                     cid, e_first, n_resume_hit);
            chk_fail_c("A2_first_raw_after_resume", cid);
        end

        if (e_phase == 0) begin
            chk_pass_c("A3_label_matches_content_phase", cid);
        end
        else begin
            $display("  [E] case%0d A3: %0d RAW chunks whose label does not match the content phase",
                     cid, e_phase);
            chk_fail_c("A3_label_matches_content_phase", cid);
        end

        if (e_contig == 0) chk_pass_c("A3b_content_contiguous", cid);
        else begin
            $display("  [E] case%0d A3b: %0d RAW chunks with non-consecutive content",
                     cid, e_contig);
            chk_fail_c("A3b_content_contiguous", cid);
        end

        if ((e_seq == 0) && (exp_chunk == 16'd0)) begin
            chk_pass_c("A4_frame_chunk_sequence", cid);
        end
        else begin
            $display("  [E] case%0d A4: sequence errors=%0d tail_exp_chunk=%0d (expected 0 = no half frame)",
                     cid, e_seq, exp_chunk);
            chk_fail_c("A4_frame_chunk_sequence", cid);
        end

        if (e_mono == 0) chk_pass_c("A5_frame_idx_monotonic", cid);
        else begin
            $display("  [E] case%0d A5: %0d FRAME_IDX regressions", cid, e_mono);
            chk_fail_c("A5_frame_idx_monotonic", cid);
        end

        if (e_len == 0) chk_pass_c("A6_pkt_len_sane", cid);
        else chk_fail_c("A6_pkt_len_sane", cid);

        if (n_raw > 30) chk_pass_c("D1_enough_raw_pkts", cid);
        else begin
            $display("  [E] case%0d D1: only %0d RAW chunks captured", cid, n_raw);
            chk_fail_c("D1_enough_raw_pkts", cid);
        end

        $display("INFO case%0d SUMMARY: px_fed=%0d raw_pkts=%0d e_phase=%0d e_first=%0d e_seq=%0d e_mono=%0d e_contig=%0d e_len=%0d drop_px=%0d",
                 cid, px_fed, n_raw, e_phase, e_first, e_seq, e_mono, e_contig, e_len, drop_px);
    end endtask

    //--------------------------------------------------------------------------
    // main
    //--------------------------------------------------------------------------
    initial begin
        $display("INFO tb_raw_phase_field: IMG_W=%0d IMG_H=%0d PIXFR=%0d CHUNKS=%0d", IMG_W, IMG_H, PIXFR, CHUNKS);
        do_case(0, STALL_A);
        do_case(1, STALL_B);
        do_case(2, STALL_C);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #80000000;   // 80 ms guard
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
