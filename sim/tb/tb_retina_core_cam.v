//==============================================================================
// tb_retina_core_cam -- retina_core real-camera-path end-to-end integration sim
//
// WHY THIS TB EXISTS (the only reason):
//   tb_retina_core / tb_retina_core_wp both drive the video source from
//   vps_pattern_gen, whose `de` is **dense inside a line** (800 consecutive
//   high cycles, gaps only during blanking).
//   On the real board the camera path is NOT like that: after
//   cam_tap -> axis_fifo (CDC-0), retina_core uses `~cdc0_empty` as `de`.
//   That is a **"there is data this cycle" strobe**, not a blanking-qualified
//   data enable.  Because clk_cam (50 MHz) is twice the pixel rate
//   (48 MHz pclk / 2 = 24 MHz) the FIFO is empty most of the time, so `de`
//   is a sparse 1-high/1-low pulse train with **no blanking gap at all**.
//
//   => vps_resample's `else x_cnt <= 0;` ("reset between lines") fires on every
//      de-low cycle, x_cnt can never reach IN_W-1=799, y_cnt never increments,
//      so the **2x2 decimation is silently bypassed**.
//   => downstream temporal_diff's pix_cnt saturates at 96,000 while the frame
//      really carries ~384,000 de pulses, so the frame store reads back a
//      **constant** => dL degenerates to (L - const) => spatial_lap becomes a
//      pure **spatial edge detector** => the board's event field is a static
//      edge map of the scene, not a motion region.
//   => spatial_lap's 8-bit y_cnt wraps over 384000/400 = 960 rows => o_y emits
//      239..254, i.e. coordinates outside the 400x240 grid (the exported CSV
//      from the board showed exactly y in 0..254 with 4.58% of rows over 239).
//
//   This TB replays that whole chain with real DVP timing + the real CDC-0
//   topology.  All criteria are **mechanism-level**, not tuned thresholds:
//     CAM_de_per_frame_96000   de pulses entering spatial_lap per frame == 400*240
//     CAM_y_within_grid        every event y <= 238 (structural grid limit 399x239)
//     CAM_events_at_bar_edges  static background + a bar moving 2 input px/frame
//                              => events may only appear on 2 known columns
//     CAM_ev_count_2x239       events per frame == 2 cols * 239 rows == 478
//     CAM_x_spread_small       event x span <= 4 (would be hundreds if bypassed)
//     CAM_px_fifo_no_overflow  CDC-0 drops no pixel (one dropped pixel shears all)
//
// Printing convention: CHECK=<name> PASS|FAIL, exactly one TEST_RESULT= line.
// NOTE: all $display text is ASCII on purpose -- the ModelSim console on this
//       machine is GBK and mangles UTF-8 source strings into `??????`.
//==============================================================================
`timescale 1ns / 1ps

module tb_retina_core_cam;

    // ======================= geometry / timing =======================
    localparam IN_W   = 800;
    localparam IN_H   = 480;
    localparam EV_W   = 400;
    localparam EV_H   = 240;

    localparam H_ACT  = IN_W * 2;        // 1600 cam_pclk (2 bytes per pixel)
    localparam H_BLK  = 400;             // horizontal blanking (cam_pclk)
    localparam H_TOT  = H_ACT + H_BLK;
    localparam V_BLK  = 40;              // vertical blanking (lines)
    localparam V_TOT  = IN_H + V_BLK;
    localparam VS_LEN = 4;               // vsync high lines (inside vblank)

    localparam THETA  = 12'd1;           // board preset 0: (theta=1, guard=20)
    localparam MIND   = 9'd20;

    localparam BAR_W  = 64;              // bright bar width (input pixels)
    localparam BAR_X0 = 200;             // bar start x (input px, +2 per frame)
    localparam NF     = 6;               // camera frames simulated

    // ======================= clocks =======================
    reg clk_cam  = 1'b0;
    reg clk_lcd  = 1'b0;
    reg cam_pclk = 1'b0;
    always #10        clk_cam  = ~clk_cam;     // 50 MHz (same as on board)
    always #20        clk_lcd  = ~clk_lcd;     // 25 MHz
    always #10.40625  cam_pclk = ~cam_pclk;    // 48.05 MHz (ILA measured 20.812 ns)

    // ======================= camera stimulus (DVP) =======================
    reg  [7:0] cam_data  = 8'h00;
    reg        cam_vsync = 1'b0;
    reg        cam_href  = 1'b0;
    integer    cc = 0;                   // byte index inside the line
    integer    cl = 0;                   // line index
    integer    cam_frame = 0;            // camera frame counter

    // grey -> RGB565 (same packing as vps_pattern_gen: {lum[7:3], lum[7:2], lum[7:3]})
    function [15:0] px565;
        input [7:0] lum;
        begin px565 = {lum[7:3], lum[7:2], lum[7:3]};
        end
    endfunction

    // Scene: STATIC vertical-stripe background (does not change with time)
    //        + a bright bar that moves right by 2 input px every frame.
    //   The static background is the key: a correct temporal difference yields
    //   exactly zero events on it.  If the temporal difference degenerates into
    //   a spatial edge detector, the whole background lights up -- impossible to
    //   confuse with the real answer.
    function [7:0] scene_lum;
        input integer x;
        input integer y;
        input integer f;
        integer bx;
        begin
            bx = BAR_X0 + 2 * f;
            if ((x >= bx) && (x < (bx + BAR_W))) scene_lum = 8'hF0;
            else if ((x % 40) < 20)               scene_lum = 8'h30;
            else                                  scene_lum = 8'h50;
        end
    endfunction

    wire [15:0] cur_px = px565(scene_lum(cc / 2, cl, cam_frame));

    // drive on negedge (cam_tap samples on posedge -> half a cycle of setup)
    always @(negedge cam_pclk) begin
        if (cl < IN_H && cc < H_ACT) begin
            cam_href = 1'b1;
            cam_data = ((cc % 2) == 0) ? cur_px[15:8] : cur_px[7:0];
        end else begin
            cam_href = 1'b0;
            cam_data = 8'h00;
        end
        cam_vsync = ((cl >= IN_H) && (cl < IN_H + VS_LEN)) ? 1'b1 : 1'b0;

        if (cc == H_TOT - 1) begin
            cc = 0;
            if (cl == V_TOT - 1) begin
                cl = 0;
                cam_frame = cam_frame + 1;
            end else cl = cl + 1;
        end else cc = cc + 1;
    end

    // ======================= DUT =======================
    reg         rst_n_cam = 1'b0;
    reg         i_cfg_ev_en = 1'b1;
    reg  [11:0] i_cfg_theta = THETA;
    reg  [8:0]  i_cfg_min_dl = MIND;
    reg  [1:0]  i_cfg_src = 2'd0;          // 0 = camera
    reg  [1:0]  i_cfg_pattern_mode = 2'd3;
    reg         i_cfg_decay_en = 1'b1;
    reg  [2:0]  i_cfg_decay_step = 3'd1;
    reg         i_cfg_refr_bypass = 1'b1;  // bypass refractory: event counts are computable
    reg  [15:0] i_bmp_rd_addr = 16'h0000;

    wire        o_ev_valid;
    wire [8:0]  o_ev_x;
    wire [7:0]  o_ev_y;
    wire        o_ev_pol;
    wire [7:0]  o_bmp_rd_data;
    wire [23:0] o_stat_ev_per_frame;
    wire [15:0] o_stat_activity_q16;
    wire [23:0] o_stat_cr_x10;
    wire [31:0] o_stat_frame_cnt;
    wire [31:0] o_stat_ev_total;
    wire [15:0] o_stat_ev_fifo_ovf;
    wire [15:0] o_stat_px_fifo_ovf;

    retina_core #(
        .IN_W (IN_W), .IN_H (IN_H), .EV_W (EV_W), .EV_H (EV_H),
        .DECAY_EN (1), .DECAY_STEP (1), .EVF_DEPTH (32), .PIPE_LAT (12)
    ) u_dut (
        .cam_pclk (cam_pclk), .rst_n_pclk (rst_n_cam),
        .i_cam_data (cam_data), .i_cam_vsync (cam_vsync), .i_cam_href (cam_href),
        .clk_cam (clk_cam), .rst_n_cam (rst_n_cam), .clk_lcd (clk_lcd),
        .i_cfg_ev_en (i_cfg_ev_en), .i_cfg_theta (i_cfg_theta),
        .i_cfg_min_dl (i_cfg_min_dl), .i_cfg_src (i_cfg_src),
        .i_cfg_pattern_mode (i_cfg_pattern_mode), .i_cfg_decay_en (i_cfg_decay_en),
        .i_cfg_decay_step (i_cfg_decay_step), .i_cfg_refr_bypass (i_cfg_refr_bypass),
        .o_ev_valid (o_ev_valid), .o_ev_x (o_ev_x), .o_ev_y (o_ev_y), .o_ev_pol (o_ev_pol),
        .i_bmp_rd_addr (i_bmp_rd_addr), .o_bmp_rd_data (o_bmp_rd_data),
        .o_stat_ev_per_frame (o_stat_ev_per_frame), .o_stat_activity_q16 (o_stat_activity_q16),
        .o_stat_cr_x10 (o_stat_cr_x10), .o_stat_frame_cnt (o_stat_frame_cnt),
        .o_stat_ev_total (o_stat_ev_total),
        .o_stat_ev_fifo_ovf (o_stat_ev_fifo_ovf), .o_stat_px_fifo_ovf (o_stat_px_fifo_ovf)
    );

    // ======================= scoreboard =======================
    integer errors = 0;
    task chk;
        input [8*64-1:0] nm;
        input            cond;
        begin
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); errors = errors + 1; end
        end
    endtask

    task chk_int;
        input [8*64-1:0] nm;
        input integer    got;
        input integer    exp;
        begin
            if (got === exp) $display("CHECK=%0s PASS", nm);
            else begin
                $display("CHECK=%0s FAIL (got=%0d exp=%0d)", nm, got, exp);
                errors = errors + 1;
            end
        end
    endtask

    // ---- per-window stats (window = between rising edges of l3_vsync, which is
    //      exactly the interval spatial_lap's row/col counters are reset over) ----
    integer win_de     [0:NF+2];
    integer win_ev     [0:NF+2];
    integer win_evmax  [0:NF+2];
    integer win_ymax   [0:NF+2];
    integer win_xmin   [0:NF+2];
    integer win_xmax   [0:NF+2];
    integer win_off    [0:NF+2];
    integer win_on     [0:NF+2];
    integer win_seen   [0:NF+2];
    integer win_nonev  [0:NF+2];
    integer win_nony   [0:NF+2];
    integer win_cola   [0:NF+2];    // first distinct event column seen
    integer win_colb   [0:NF+2];    // second distinct event column seen
    integer win_ncol   [0:NF+2];    // number of distinct event columns
    integer win_badcol [0:NF+2];    // events on a column that is neither cola nor colb

    integer de_cur = 0, ev_cur = 0, evmax_cur = 0, off_cur = 0, on_cur = 0;
    integer ymax_cur = 0, xmin_cur = 0, xmax_cur = 0;
    integer cola_cur = 0, colb_cur = 0, ncol_cur = 0, badcol_cur = 0;
    integer seen_cur = 0;      // 0 = no event seen yet in this window
    integer yseen_cur = 0;     // 0 = no event with a valid y seen yet
    integer win_idx = 0;
    integer ymax_all = 0, yseen_all = 0;
    integer global_bad_y = 0;

    reg l3_vs_d = 1'b0;

    // global count of events whose y is outside the 400x240 grid (limit 239)
    always @(posedge clk_cam) begin
        if (o_ev_valid === 1'b1) begin
            if (o_ev_y > (EV_H - 2)) global_bad_y = global_bad_y + 1;
        end
    end

    // frame boundary = rising edge of l3_vsync (spatial_lap's counter reset point)
    always @(posedge clk_cam) begin
        l3_vs_d <= u_dut.l3_vsync;
        if (u_dut.l3_vsync === 1'b1 && l3_vs_d === 1'b0) begin
            if (win_idx <= NF + 1) begin
                win_de[win_idx]    = de_cur;
                win_ev[win_idx]    = ev_cur;
                win_evmax[win_idx] = evmax_cur;
                win_ymax[win_idx]  = ymax_cur;
                win_xmin[win_idx]  = xmin_cur;
                win_xmax[win_idx]  = xmax_cur;
                win_off[win_idx]   = off_cur;
                win_on[win_idx]    = on_cur;
                win_seen[win_idx]   = seen_cur;
                win_nonev[win_idx]  = (ev_cur == 0) ? 1 : 0;
                win_nony[win_idx]   = (yseen_cur == 0) ? 1 : 0;
                win_cola[win_idx]   = cola_cur;
                win_colb[win_idx]   = colb_cur;
                win_ncol[win_idx]   = ncol_cur;
                win_badcol[win_idx] = badcol_cur;
            end
            win_idx = win_idx + 1;
            de_cur = 0; ev_cur = 0; evmax_cur = 0; off_cur = 0; on_cur = 0;
            ymax_cur = 0; xmin_cur = 0; xmax_cur = 0;
            cola_cur = 0; colb_cur = 0; ncol_cur = 0; badcol_cur = 0;
            seen_cur = 0; yseen_cur = 0;
        end else begin
            if (u_dut.l3_de === 1'b1) de_cur = de_cur + 1;
            if (o_ev_valid === 1'b1) begin
                ev_cur = ev_cur + 1;
                if (!seen_cur) begin
                    xmin_cur = o_ev_x; xmax_cur = o_ev_x;
                    cola_cur = o_ev_x; ncol_cur = 1;
                    seen_cur = 1;
                end else begin
                    if (o_ev_x < xmin_cur) xmin_cur = o_ev_x;
                    if (o_ev_x > xmax_cur) xmax_cur = o_ev_x;
                    if (ncol_cur == 1) begin
                        if (o_ev_x !== cola_cur) begin
                            colb_cur = o_ev_x;
                            ncol_cur = 2;
                        end
                    end else if ((o_ev_x !== cola_cur) && (o_ev_x !== colb_cur)) begin
                        badcol_cur = badcol_cur + 1;
                    end
                end
                if (o_ev_x > evmax_cur) evmax_cur = o_ev_x;
                if (!yseen_cur || (o_ev_y > ymax_cur)) begin
                    ymax_cur  = o_ev_y;
                    yseen_cur = 1;
                end
                if (!yseen_all || (o_ev_y > ymax_all)) begin
                    ymax_all  = o_ev_y;
                    yseen_all = 1;
                end
                if (o_ev_pol === 1'b1) on_cur  = on_cur  + 1;
                else                   off_cur = off_cur + 1;
            end
        end
    end

    // ---- event dump (for offline event-by-event comparison with the host) ----
    integer fd;
    initial begin
        fd = $fopen("cam_events.txt", "w");
        if (fd != 0) $fdisplay(fd, "# cam_frame x y pol");
    end

    always @(posedge clk_cam) begin
        if (o_ev_valid === 1'b1 && fd != 0)
            $fdisplay(fd, "%0d %0d %0d %0d", cam_frame, o_ev_x, o_ev_y, o_ev_pol);
    end

    // ======================= main =======================
    integer w, guard, exp_off, exp_on, exp_n;

    initial begin
        rst_n_cam = 1'b0;
        repeat (20) @(posedge clk_cam);
        @(negedge clk_cam); rst_n_cam = 1'b1;

        guard = 0;
        while ((win_idx < NF + 2) && (guard < 40000000)) begin
            @(posedge clk_cam);
            guard = guard + 1;
        end

        $display("  [CAM] simulated camera frames = %0d ; windows = %0d", cam_frame, win_idx);
        $display("  [WIN] idx      de      ev   ev_ymax  colA  colB  ncol  badcol    off     on");
        for (w = 0; w <= NF + 1; w = w + 1) begin
            $display("         %0d  %0d  %0d  %0d  %0d  %0d  %0d  %0d  %0d  %0d",
                     w, win_de[w], win_ev[w], win_ymax[w],
                     win_cola[w], win_colb[w], win_ncol[w], win_badcol[w],
                     win_off[w], win_on[w]);
        end

        // ---- criterion 1: de pulses entering spatial_lap per frame == 400*240 ----
        begin : de_check
            integer i, bad, n_ok, mn, mx;
            bad = 0; n_ok = 0; mn = 99999999; mx = -1;
            for (i = 2; i <= NF; i = i + 1) begin
                if (win_de[i] !== (EV_W * EV_H)) bad = bad + 1;
                else n_ok = n_ok + 1;
                if (win_de[i] < mn) mn = win_de[i];
                if (win_de[i] > mx) mx = win_de[i];
            end
            $display("  [de/frame] windows 2..%0d: min=%0d max=%0d ; == %0d in %0d/%0d",
                     NF, mn, mx, EV_W * EV_H, n_ok, NF - 1);
            chk("CAM_de_per_frame_96000", (bad === 0) && (n_ok === (NF - 1)));
        end

        // ---- criterion 2: no event may carry a y outside the grid ----
        chk_int("CAM_no_event_y_over_238", global_bad_y, 0);
        chk("CAM_global_ymax_within_grid", (yseen_all === 1) && (ymax_all <= (EV_H - 2)));
        $display("  [global] max event y = %0d (grid limit %0d, seen=%0d)",
                 ymax_all, EV_H - 2, yseen_all);

        // ---- criteria 3/4/5/6: the bar moves 2 input px/frame => 1 event px/frame ----
        //   Bar covers input x in [200+2f, 200+2f+64).
        //   After the fix the decimator keeps the EVEN input columns (x = 2X), exactly
        //   like vps_pattern_gen -> host engine.ts (`sx = 2*x`), so the bar covers the
        //   event columns X in [100+f, 131+f] (32 columns wide).
        //   Going from frame f-1 to f the only changed columns are
        //       X = 99+f   (bright -> dark, OFF)   and   X = 131+f  (dark -> bright, ON)
        //   The 4-neighbour Laplacian spreads the response over 3 columns, but the guard
        //   |dL| >= 20 only holds on the CENTRE column (the neighbours have centre
        //   dL = 0) => exactly 2 columns * 239 rows (y = 0..238) = 478 events.
        //
        //   Window i <-> camera frame i.  That mapping is not assumed: it is pinned by
        //   two independent facts printed above -- every settled window carries exactly
        //   96,000 de pulses (= one complete frame of active pixels) and the measured
        //   column pair advances by exactly +1 per window (perfectly linear over
        //   6 windows, so no off-by-one in the window/frame indexing).
        //   Window 1 is skipped: the reset is released in the middle of a camera frame,
        //   and before the first camera vsync tag exists the counters are not yet
        //   frame-aligned, so the frame store is written misaligned once.  That is a
        //   one-frame post-reset artifact (also present at board power-up, ~38 ms),
        //   not part of the steady-state behaviour under test.
        begin : edge_check
            integer i, f, bad_n, bad_x, bad_ncol;
            bad_n = 0; bad_x = 0; bad_ncol = 0;
            for (i = 2; i <= NF; i = i + 1) begin
                f = i;                           // window i <-> camera frame i
                exp_off = 99 + f;
                exp_on  = 131 + f;
                exp_n   = 2 * (EV_H - 1);        // 2 cols * 239 rows
                if (win_ev[i] !== exp_n) begin
                    bad_n = bad_n + 1;
                    $display("      [frame %0d] ev=%0d exp=%0d cols exp %0d/%0d seen %0d/%0d",
                             f, win_ev[i], exp_n, exp_off, exp_on,
                             win_cola[i], win_colb[i]);
                end
                if (!(((win_cola[i] === exp_off) && (win_colb[i] === exp_on)) ||
                      ((win_cola[i] === exp_on)  && (win_colb[i] === exp_off)))) begin
                    bad_x = bad_x + 1;
                    $display("      [frame %0d] cols %0d/%0d do not match expected %0d/%0d",
                             f, win_cola[i], win_colb[i], exp_off, exp_on);
                end
                if ((win_ncol[i] !== 2) || (win_badcol[i] !== 0)) begin
                    bad_ncol = bad_ncol + 1;
                    $display("      [frame %0d] ncol=%0d badcol=%0d (expect exactly 2 columns)",
                             f, win_ncol[i], win_badcol[i]);
                end
            end
            $display("  [geometry] windows 2..%0d: %0d windows with wrong event count, %0d with wrong columns, %0d with !=2 columns",
                     NF, bad_n, bad_x, bad_ncol);
            chk("CAM_ev_count_2x239", bad_n === 0);
            chk("CAM_events_at_bar_edges", bad_x === 0);
            chk("CAM_event_columns_exactly_2", bad_ncol === 0);
        end

        // ---- criterion 6: CDC-0 loses no pixel ----
        chk_int("CAM_px_fifo_no_overflow", o_stat_px_fifo_ovf, 0);
        chk_int("CAM_ev_fifo_no_overflow", o_stat_ev_fifo_ovf, 0);

        // ---- non-vacuous fallback: events must really have happened ----
        chk("CAM_engine_activity_nonzero", (o_stat_ev_total > 0));

        if (fd != 0) $fclose(fd);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #400_000_000;    // 400 ms simulation cap
        $display("CHECK=CAM_timeout FAIL");
        $display("TEST_RESULT=FAIL (timeout-global)");
        $finish;
    end

endmodule
