//==============================================================================
// tb_nn_integ -- task-43 (M3c) integration self-check (TB_INTEG_OK)
//
// DUT: nn_top (nn_winstat -> nn_feat -> nn_engine -> nn_decide)
//
// Reference model inside this TB (behavioral, independent of old RTL):
//   prev_cx/prev_cy = centroid of previous NON-EMPTY window, init (200,120)
//   shift_x = prev_cx - 200 ; shift_y = prev_cy - 120          (pixels)
//   x' = clamp(x - shift_x, 0, IMG_W-1) ; gx = x' >> GRID_SHIFT
//   y' = clamp(y - shift_y, 0, IMG_H-1) ; gy = y' >> GRID_SHIFT
//   cx = floor(sum_x / n) ; empty window keeps previous centroid
//   clamp counter increments once per event if x or y was clamped
// This matches nn/v7/intwin.py:113-127 (absolute re-centering, no recursion).
//
// Checks:
//   (a) equivalence with shift forced to 0: 32 windows of events symmetric
//       about (200,120) -> centroid exactly (200,120) -> shift 0. For every
//       window the frozen bank (ON/OFF) is compared cell-by-cell against the
//       TB golden model; the previous bank is also compared => all 4 channels
//       (ON_now/OFF_now/ON_prev/OFF_prev) covered.
//   (b) translation active: window 32 centroid (100,50) -> shift (-100,-70);
//       the 8 events of window 33 are checked one by one (incl. 2 clamps);
//       window 34 centroid (260,50) -> shift (60,-70); window 35 first event
//       x=8 -> x'=-52 -> clamp 0 -> gx 0, clamp count +1 (2 clamps total).
//   (c) one and only one window edge: win_tick / win_end / publish counted
//       and compared; window index and one epoch toggle per window.
//   (d) reset: shift 0, stats 0, no X on grid ports / glob bus (using
//       $isunknown), feature ready handshake.
//
// NOTE: $display/$error strings are ASCII only (ModelSim console is GBK).
//==============================================================================
`timescale 1ns / 1ps
`include "../../src/hdl/nn/nn_cfg.vh"

module tb_nn_integ;

    localparam integer WIN_CYC = 7000;   // short window (edge pipeline ~3.3k)
    localparam integer NW_SYM  = 32;     // equivalence windows (>= 30)
    localparam integer NW_TOT  = 36;     // 32 symmetric + 4 translation windows

    //--------------------------------------------------------------------------
    // clock / reset
    //--------------------------------------------------------------------------
    reg clk_cam  = 1'b0;
    reg clk_200m = 1'b0;
    always #10  clk_cam  = ~clk_cam;     // 50 MHz
    always #2.5 clk_200m = ~clk_200m;    // 200 MHz (unused by v2 nn_top)

    reg rst_n_cam  = 1'b0;
    reg rst_n_200m = 1'b0;

    reg        i_ev_valid = 1'b0;
    reg [8:0]  i_ev_x     = 9'd0;
    reg [7:0]  i_ev_y     = 8'd0;
    reg        i_ev_pol   = 1'b0;

    wire        o_act_pulse;
    wire [1:0]  o_act_class;
    wire [4:0]  o_act_conf;
    wire        o_dbg_win;
    wire        o_dbg_busy;
    wire [255:0] o_glob_bus;
    wire        o_glob_valid;

    nn_top #(
        .WIN_CYC        (WIN_CYC),
        .REFRACTORY_CYC (400000),
        .MARGIN_MIN     (`NN_MARGIN_MIN),   // M4g: deployment default
        .N_CONSEC       (3)
    ) dut (
        .clk_cam      (clk_cam),
        .rst_n_cam    (rst_n_cam),
        .i_ev_valid   (i_ev_valid),
        .i_ev_x       (i_ev_x),
        .i_ev_y       (i_ev_y),
        .i_ev_pol     (i_ev_pol),
        .o_act_pulse  (o_act_pulse),
        .o_act_class  (o_act_class),
        .o_act_conf   (o_act_conf),
        .o_dbg_win    (o_dbg_win),
        .o_dbg_busy   (o_dbg_busy),
        .clk_200m     (clk_200m),
        .rst_n_200m   (rst_n_200m),
        .o_glob_bus   (o_glob_bus),
        .o_glob_valid (o_glob_valid)
    );

    //--------------------------------------------------------------------------
    // check helpers
    //--------------------------------------------------------------------------
    integer errors    = 0;
    integer chk_total = 0;

    task chk_pass; input [8*56-1:0] nm; begin
        chk_total = chk_total + 1;
        $display("CHECK=%0s PASS", nm);
    end endtask

    task chk_fail; input [8*56-1:0] nm; begin
        chk_total = chk_total + 1;
        $display("CHECK=%0s FAIL", nm);
        errors = errors + 1;
    end endtask

    task chk_eq; input [8*56-1:0] nm; input [31:0] got; input [31:0] exp; begin
        if (got === exp) chk_pass(nm);
        else begin
            chk_fail(nm);
            $display("    [%0s] got=%0d (0x%0h) exp=%0d (0x%0h)", nm, got, got, exp, exp);
        end
    end endtask

    // X detection helper. ModelSim 2020.4 without -sv compiles $isunknown but
    // cannot execute it at run time (vsim-12023), so use the reduction XOR
    // property: any X bit makes the reduction result X.
    function has_x;
        input [255:0] v;
        begin
            has_x = (^v === 1'bx);
        end
    endfunction

    //--------------------------------------------------------------------------
    // golden model storage
    //--------------------------------------------------------------------------
    integer gold    [0:11999];   // 4 slots x (1500 ON + 1500 OFF) counts
    integer exp_gx  [0:1023];
    integer exp_gy  [0:1023];
    integer gx_hist [0:1023];
    integer gy_hist [0:1023];

    integer exp_n   = 0;         // number of expected grid events
    integer gptr    = 0;         // number of observed grid events
    integer grid_mm = 0;         // grid output mismatches
    integer stat_mm = 0;         // centroid mismatches
    integer bank_mm = 0;         // frozen bank mismatches
    integer shift_mm = 0;        // windows with non-zero shift in phase (a)
    integer unk_cnt = 0;         // X on grid outputs
    integer cmp_nz  = 0;         // non-zero cells actually compared

    integer tick_cnt = 0;
    integer end_cnt  = 0;
    integer stat_cnt = 0;
    integer par_tog  = 0;
    reg     prev_par = 1'b0;

    //--------------------------------------------------------------------------
    // monitors
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (dut.win_tick) tick_cnt = tick_cnt + 1;
        if (dut.win_end)  end_cnt  = end_cnt + 1;
        if (dut.ws_valid) stat_cnt = stat_cnt + 1;
        if (dut.ws_grid_par !== prev_par) begin
            par_tog  = par_tog + 1;
            prev_par = dut.ws_grid_par;
        end
        if (dut.ws_grid_valid) begin
            gx_hist[gptr] = dut.ws_grid_x;
            gy_hist[gptr] = dut.ws_grid_y;
            if (gptr < 8)
                $display("INFO_GRID gptr=%0d got=(%0d,%0d) par=%0d sh=(%0d,%0d) t=%0t",
                         gptr, dut.ws_grid_x, dut.ws_grid_y, dut.ws_grid_par,
                         dut.ws_shift_x, dut.ws_shift_y, $time);
            if (gptr < exp_n) begin
                if ((dut.ws_grid_x !== exp_gx[gptr]) ||
                    (dut.ws_grid_y !== exp_gy[gptr])) begin
                    grid_mm = grid_mm + 1;
                    if (grid_mm <= 10)
                        $display("GRID_MM idx=%0d got=(%0d,%0d) exp=(%0d,%0d)",
                                 gptr, dut.ws_grid_x, dut.ws_grid_y,
                                 exp_gx[gptr], exp_gy[gptr]);
                end
            end else begin
                grid_mm = grid_mm + 1;
                if (grid_mm <= 10) $display("GRID_MM idx=%0d unexpected event", gptr);
            end
            if (has_x({dut.ws_grid_x, dut.ws_grid_y})) unk_cnt = unk_cnt + 1;
            gptr = gptr + 1;
        end
    end

    //--------------------------------------------------------------------------
    // model state
    //--------------------------------------------------------------------------
    integer slot      = 0;       // golden slot of the window being fed
    integer m_n       = 0;
    integer m_sx      = 0;
    integer m_sy      = 0;
    integer m_shx     = 0;
    integer m_shy     = 0;
    integer m_clamp   = 0;
    integer clamp_base= 0;

    //--------------------------------------------------------------------------
    // feed one event (raw pixel coords), update model + golden
    //--------------------------------------------------------------------------
    task feed_ev;
        input [8:0] x;
        input [7:0] y;
        input       pol;
        integer xf, yf, gx, gy, cidx, cl;
        begin
            xf = x - m_shx;
            yf = y - m_shy;
            cl = 0;
            if (xf < 0)        begin xf = 0;   cl = 1; end
            else if (xf > 399) begin xf = 399; cl = 1; end
            if (yf < 0)        begin yf = 0;   cl = 1; end
            else if (yf > 239) begin yf = 239; cl = 1; end
            gx = xf >> 3;
            gy = yf >> 3;
            cidx = gy * `NN_GRID_W + gx;
            if (pol) begin
                if (gold[slot*`NN_BANK_DEPTH + cidx] < 255)
                    gold[slot*`NN_BANK_DEPTH + cidx] =
                        gold[slot*`NN_BANK_DEPTH + cidx] + 1;
            end else begin
                if (gold[slot*`NN_BANK_DEPTH + `NN_CELLS + cidx] < 255)
                    gold[slot*`NN_BANK_DEPTH + `NN_CELLS + cidx] =
                        gold[slot*`NN_BANK_DEPTH + `NN_CELLS + cidx] + 1;
            end
            if (exp_n < 8)
                $display("INFO_MODEL n=%0d raw=(%0d,%0d) sh=(%0d,%0d) -> (%0d,%0d) slot=%0d",
                         exp_n, x, y, m_shx, m_shy, gx, gy, slot);
            exp_gx[exp_n] = gx;
            exp_gy[exp_n] = gy;
            exp_n = exp_n + 1;
            m_n = m_n + 1;
            m_sx = m_sx + x;
            m_sy = m_sy + y;
            if (cl) m_clamp = m_clamp + 1;

            @(negedge clk_cam);
            i_ev_valid = 1'b1;
            i_ev_x     = x;
            i_ev_y     = y;
            i_ev_pol   = pol;
            @(negedge clk_cam);
            i_ev_valid = 1'b0;
        end
    endtask

    //--------------------------------------------------------------------------
    // compare one frozen bank (2 channels) and the previous bank (2 channels)
    //--------------------------------------------------------------------------
    task cmp_win;
        input integer widx;
        input integer sl;
        integer bk, bs, c, m;
        begin
            bk = widx % 3;
            bs = bk * `NN_BANK_DEPTH;
            m  = 0;
            for (c = 0; c < `NN_CELLS; c = c + 1) begin
                if (dut.u_feat.frz_mem[bs + c] !==
                    gold[sl*`NN_BANK_DEPTH + c]) m = m + 1;
                if (dut.u_feat.frz_mem[bs + `NN_CELLS + c] !==
                    gold[sl*`NN_BANK_DEPTH + `NN_CELLS + c]) m = m + 1;
                if (gold[sl*`NN_BANK_DEPTH + c] != 0) cmp_nz = cmp_nz + 1;
            end
            if (m != 0) begin
                bank_mm = bank_mm + m;
                $display("BANK_MM win=%0d bank=%0d cnt=%0d", widx, bk, m);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // clear one golden slot (a slot is reused every 4 windows)
    //--------------------------------------------------------------------------
    task clear_slot;
        input integer sl;
        integer c;
        begin
            for (c = 0; c < 2*`NN_CELLS; c = c + 1)
                gold[sl*`NN_BANK_DEPTH + c] = 0;
        end
    endtask

    //--------------------------------------------------------------------------
    // window event patterns
    //--------------------------------------------------------------------------
    task feed_sym;                 // 12 events, centroid exactly (200,120)
        integer k;
        begin
            for (k = 1; k <= 6; k = k + 1) begin
                feed_ev(200 + 8*k, 120 + 8*k, (k % 2));
                feed_ev(200 - 8*k, 120 - 8*k, ((k + 1) % 2));
            end
        end
    endtask

    task feed_w32;                 // centroid (100,50)
        begin
            feed_ev(96,  48, 1'b1);
            feed_ev(104, 52, 1'b1);
            feed_ev(96,  52, 1'b0);
            feed_ev(104, 48, 1'b0);
        end
    endtask

    task feed_w33;                 // 8 events, 2 of them clamp
        begin
            feed_ev(128, 40,  1'b1);   // -> (28,13)
            feed_ev(200, 80,  1'b1);   // -> (37,18)
            feed_ev(136, 48,  1'b1);   // -> (29,14)
            feed_ev(8,   8,   1'b0);   // -> (13,9)
            feed_ev(296, 160, 1'b0);   // -> (49,28)
            feed_ev(300, 120, 1'b1);   // x clamp 399 -> (49,23)
            feed_ev(100, 200, 1'b0);   // y clamp 239 -> (25,29)
            feed_ev(50,  30,  1'b1);   // -> (18,12)
        end
    endtask

    task feed_w34;                 // centroid (260,50)
        begin
            feed_ev(256, 48, 1'b1);
            feed_ev(264, 52, 1'b1);
            feed_ev(256, 52, 1'b0);
            feed_ev(264, 48, 1'b0);
        end
    endtask

    task feed_w35;                 // 4 events, 2 of them clamp (shift 60,-70)
        begin
            feed_ev(8,   100, 1'b1);   // x'=-52 clamp 0, y'=170 -> (0,21)
            feed_ev(100, 100, 1'b1);   // -> (5,21)
            feed_ev(40,  200, 1'b0);   // x'=-20 clamp 0, y'=270 clamp 239 -> (0,29)
            feed_ev(399, 10,  1'b0);   // -> (42,10)
        end
    endtask

    //--------------------------------------------------------------------------
    // main
    //--------------------------------------------------------------------------
    integer w, idx_w33, idx_w35;
    integer m_cx, m_cy, exp_sx, exp_sy;
    integer first_shift_x, first_shift_y;

    integer init_i;

    initial begin
        for (init_i = 0; init_i < 12000; init_i = init_i + 1) gold[init_i] = 0;
        for (init_i = 0; init_i < 1024; init_i = init_i + 1) begin
            exp_gx[init_i]  = 0;
            exp_gy[init_i]  = 0;
            gx_hist[init_i] = 0;
            gy_hist[init_i] = 0;
        end
        rst_n_cam  = 1'b0;
        rst_n_200m = 1'b0;
        repeat (20) @(negedge clk_cam);
        rst_n_cam  = 1'b1;
        rst_n_200m = 1'b1;
        repeat (10) @(negedge clk_cam);

        // ---------------- (d) reset state ----------------
        if (!has_x(o_glob_bus)) chk_pass("D1_RESET_GLOB_NOX");
        else begin chk_fail("D1_RESET_GLOB_NOX"); $display("    glob_bus has X"); end
        if (o_glob_bus === 256'd0) chk_pass("D2_RESET_GLOB_ZERO");
        else chk_fail("D2_RESET_GLOB_ZERO");
        if (!has_x({dut.ws_grid_x, dut.ws_grid_y,
                    dut.ws_shift_x, dut.ws_shift_y}))
            chk_pass("D3_RESET_GRID_PORTS_NOX");
        else chk_fail("D3_RESET_GRID_PORTS_NOX");
        if (!has_x({o_act_class, o_act_conf}))
            chk_pass("D4_RESET_ACT_NOX");
        else chk_fail("D4_RESET_ACT_NOX");
        chk_eq("D5_RESET_SHIFT_X_0",  dut.ws_shift_x, 0);
        chk_eq("D6_RESET_SHIFT_Y_0",  dut.ws_shift_y, 0);
        chk_eq("D7_RESET_STAT_VALID_0", dut.ws_valid, 0);
        chk_eq("D8_RESET_GRID_VALID_0", dut.ws_grid_valid, 0);
        chk_eq("D9_RESET_CLAMP_CNT_0",  dut.ws_clamp_cnt, 0);

        // ---------------- wait for feature RAM clear ----------------
        while (dut.feat_ready !== 1'b1) @(negedge clk_cam);
        chk_pass("D10_FEAT_READY");

        m_n = 0; m_sx = 0; m_sy = 0; m_shx = 0; m_shy = 0; m_clamp = 0;
        slot = 0;
        feed_sym;                      // window 0 events

        for (w = 0; w < NW_TOT; w = w + 1) begin
            // ---- window edge w (closes window w) ----
            while (dut.win_tick !== 1'b1) @(negedge clk_cam);
            while (dut.ws_valid !== 1'b1) @(negedge clk_cam);

            if (w == 0) begin
                first_shift_x = dut.ws_shift_x;
                first_shift_y = dut.ws_shift_y;
            end

            // ---- model centroid of window w ----
            m_cx = m_sx / m_n;
            m_cy = m_sy / m_n;
            if (dut.ws_cx !== m_cx) stat_mm = stat_mm + 1;
            if (dut.ws_cy !== m_cy) stat_mm = stat_mm + 1;

            // ---- (a) shift must stay 0 for symmetric windows ----
            if (w < NW_SYM) begin
                if ((dut.ws_shift_x !== 10'd0) || (dut.ws_shift_y !== 10'd0))
                    shift_mm = shift_mm + 1;
                if (dut.ws_dcx > 10'd1) shift_mm = shift_mm + 1;   // no motion
            end

            // ---- (b) published shift of translation windows ----
            if (w == NW_SYM) begin
                exp_sx = (m_cx - 200 + 1024) % 1024;
                exp_sy = (m_cy - 120 + 1024) % 1024;
                chk_eq("B1_SHIFT_W32_X_M100", dut.ws_shift_x, exp_sx);
                chk_eq("B2_SHIFT_W32_Y_M70",  dut.ws_shift_y, exp_sy);
                chk_eq("B3_W32_CX_100", dut.ws_cx, 100);
                chk_eq("B4_W32_CY_50",  dut.ws_cy, 50);
            end
            if (w == NW_SYM + 1) begin
                exp_sx = (m_cx - 200 + 1024) % 1024;
                exp_sy = (m_cy - 120 + 1024) % 1024;
                chk_eq("B5_SHIFT_W33_X_M48", dut.ws_shift_x, exp_sx);
                chk_eq("B6_SHIFT_W33_Y_M35", dut.ws_shift_y, exp_sy);
                chk_eq("B7_W33_CX_152", dut.ws_cx, 152);
                chk_eq("B8_W33_CY_85",  dut.ws_cy, 85);
            end
            if (w == NW_SYM + 2) begin
                chk_eq("B9_SHIFT_W34_X_60",  dut.ws_shift_x, 60);
                chk_eq("B10_SHIFT_W34_Y_M70", dut.ws_shift_y, 954);
            end

            // ---- feed the next window with the shift just published ----
            // reset the per-window sums BEFORE feeding (the centroid of window
            // w was computed above from the sums collected during iteration w-1)
            m_n = 0; m_sx = 0; m_sy = 0;
            if (w + 1 < NW_TOT) begin
                m_shx = m_cx - 200;
                m_shy = m_cy - 120;
                slot  = (w + 1) % 4;
                clear_slot(slot);
                clamp_base = dut.ws_clamp_cnt;
                m_clamp = 0;
                if (w + 1 < NW_SYM)          feed_sym;
                else if (w + 1 == NW_SYM)    feed_w32;
                else if (w + 1 == NW_SYM+1) begin idx_w33 = exp_n; feed_w33; end
                else if (w + 1 == NW_SYM+2)  feed_w34;
                else                        begin idx_w35 = exp_n; feed_w35; end
                repeat (8) @(negedge clk_cam);
                if (w + 1 == NW_SYM + 1)
                    chk_eq("B11_CLAMP_W33_2", dut.ws_clamp_cnt - clamp_base, 2);
                if (w + 1 == NW_SYM + 3)
                    chk_eq("B12_CLAMP_W35_2", dut.ws_clamp_cnt - clamp_base, 2);
            end

            // ---- wait the freeze of window w and compare bank(s) ----
            while (dut.win_end !== 1'b1) @(negedge clk_cam);
            cmp_win(w, w % 4);
            if (w >= 1) cmp_win(w - 1, (w - 1) % 4);
        end

        // let the monitors sample the last win_end bus cycle (the monitor runs
        // on posedge, the initial block wakes on negedge => one cycle skew)
        repeat (4) @(negedge clk_cam);

        // ---------------- (c) one and only one window edge ----------------
        chk_eq("C1_TICK_CNT_36",    tick_cnt, NW_TOT);
        chk_eq("C2_END_CNT_36",     end_cnt,  NW_TOT);
        chk_eq("C3_PUBLISH_CNT_36", stat_cnt, NW_TOT);
        chk_eq("C4_WIN_IDX_36",     dut.win_idx, NW_TOT);
        chk_eq("C5_PAR_TOGGLE_35",  par_tog, NW_TOT - 1);
        chk_eq("C6_GRID_EV_CNT",    gptr, exp_n);
        chk_eq("C7_GRID_EV_EXP_404", exp_n, 12*NW_SYM + 4 + 8 + 4 + 4);

        // ---------------- (a) equivalence / (b) landing points ----------------
        chk_eq("A1_GRID_EQ_MODEL",   grid_mm, 0);
        chk_eq("A2_CENTROID_EQ_MODEL", stat_mm, 0);
        chk_eq("A3_BANK_4CH_EQ_MODEL", bank_mm, 0);
        chk_eq("A4_SHIFT_ZERO_32WIN", shift_mm, 0);
        chk_eq("A5_CMP_NONZERO_CELLS", cmp_nz > 0, 1);

        chk_eq("B13_W33_E0_X", gx_hist[idx_w33 + 0], 28);
        chk_eq("B14_W33_E0_Y", gy_hist[idx_w33 + 0], 13);
        chk_eq("B15_W33_E1_X", gx_hist[idx_w33 + 1], 37);
        chk_eq("B16_W33_E1_Y", gy_hist[idx_w33 + 1], 18);
        chk_eq("B17_W33_E2_X", gx_hist[idx_w33 + 2], 29);
        chk_eq("B18_W33_E2_Y", gy_hist[idx_w33 + 2], 14);
        chk_eq("B19_W33_E3_X", gx_hist[idx_w33 + 3], 13);
        chk_eq("B20_W33_E3_Y", gy_hist[idx_w33 + 3], 9);
        chk_eq("B21_W33_E4_X", gx_hist[idx_w33 + 4], 49);
        chk_eq("B22_W33_E4_Y", gy_hist[idx_w33 + 4], 28);
        chk_eq("B23_W33_E5_X_CLAMP49", gx_hist[idx_w33 + 5], 49);
        chk_eq("B24_W33_E5_Y", gy_hist[idx_w33 + 5], 23);
        chk_eq("B25_W33_E6_X", gx_hist[idx_w33 + 6], 25);
        chk_eq("B26_W33_E6_Y_CLAMP29", gy_hist[idx_w33 + 6], 29);
        chk_eq("B27_W33_E7_X", gx_hist[idx_w33 + 7], 18);
        chk_eq("B28_W33_E7_Y", gy_hist[idx_w33 + 7], 12);

        chk_eq("B29_W35_E0_X_CLAMP0", gx_hist[idx_w35 + 0], 0);
        chk_eq("B30_W35_E0_Y",        gy_hist[idx_w35 + 0], 21);
        chk_eq("B31_W35_E1_X",        gx_hist[idx_w35 + 1], 5);
        chk_eq("B32_W35_E1_Y",        gy_hist[idx_w35 + 1], 21);
        chk_eq("B33_W35_E2_X_CLAMP0", gx_hist[idx_w35 + 2], 0);
        chk_eq("B34_W35_E2_Y_CLAMP29", gy_hist[idx_w35 + 2], 29);
        chk_eq("B35_W35_E3_X",        gx_hist[idx_w35 + 3], 42);
        chk_eq("B36_W35_E3_Y",        gy_hist[idx_w35 + 3], 10);
        chk_eq("B37_CLAMP_TOTAL_4",   dut.ws_clamp_cnt, 4);

        // ---------------- (d) first window shift = 0 ----------------
        chk_eq("D11_FIRST_WIN_SHIFT_X_0", first_shift_x, 0);
        chk_eq("D12_FIRST_WIN_SHIFT_Y_0", first_shift_y, 0);
        chk_eq("D13_GRID_NOX", unk_cnt, 0);

        $display("INFO_WIN=%0d INFO_GRID_EVENTS=%0d INFO_TICKS=%0d INFO_ENDS=%0d",
                 NW_TOT, gptr, tick_cnt, end_cnt);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else $display("TEST_RESULT=FAIL (errors=%0d)", errors);
        $display("INFO_CHECK_TOTAL=%0d", chk_total);
        $finish;
    end

endmodule
