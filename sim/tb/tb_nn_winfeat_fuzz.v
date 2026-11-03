//==============================================================================
// tb_nn_winfeat_fuzz —— M3i/task-68 窗级特征前端随机差分测试（winstat + winfeat 串联）
//
// 【测什么】nn_winstat → nn_winfeat 的真实数据通路（不是直接灌快照）：按生成器
//   给出的可复现事件序列逐窗喂入，窗沿打 i_win_tick，检查
//     · 12 项窗末快照（n/on/off/Σx/Σy/Σx²/Σy²/cx/cy/pcx/pcy/prev_n）
//     · 7 路部署特征（n_div16/prev_n_div16/pol_bal/dx/dy/dx_rel/dy_rel，逐值比对）
//     · 平移 clamp 计数增量（o_clamp_cnt 差分 = 本窗被 clamp 事件数）
//   期望值不由 TB 重算，全部来自 tb_nn_winfeat_fuzz.vh，其真值链路是
//   nn/v7/intwin.py（subblock_stats/window_stats）+ nn/v7/v7_feats.py（python_row），
//   即训练侧权威实现（生成器 temp_test/rtl/fuzz/gen_winfeat_fuzz_vectors.py）。
//
// 【口径】部署窗 = 100 ms 非重叠窗（与 nn_top 的 i_win_tick 一致）；pcx/pcy =
//   上一有效窗质心（空窗 carry，首窗 200/120），prev_n = 上一窗事件数（首窗 0）。
//   坐标全在端口域：x 0..511（9 bit）、y 0..255（8 bit）。
//
// 【判定】逐窗 CHECK=<组><窗>_<字段> PASS|FAIL（失配打印 got/exp）；末行
//   TEST_RESULT=PASS（errors==0）。固定 seed，向量文件由脚本生成，勿手改。
//==============================================================================
`timescale 1ns / 1ps
module tb_nn_winfeat_fuzz;
`include "tb_nn_winfeat_fuzz.vh"

    reg clk_cam = 1'b0;
    always #10 clk_cam = ~clk_cam;   // 50 MHz
    reg rst_n_cam = 1'b0;

    //--------------------------------------------------------------------------
    // nn_winstat 驱动与输出
    //--------------------------------------------------------------------------
    reg         ws_valid = 1'b0;
    reg  [8:0]  ws_x = 9'd0;
    reg  [7:0]  ws_y = 8'd0;
    reg         ws_pol = 1'b0;
    reg         ws_tick = 1'b0;

    wire        ws_stat_valid;
    wire [15:0] ws_n_on, ws_n_off;
    wire [23:0] ws_sum_x_on, ws_sum_y_on, ws_sum_x_off, ws_sum_y_off;
    wire [8:0]  ws_cx;
    wire [7:0]  ws_cy;
    wire [9:0]  ws_dcx, ws_dcy, ws_shift_x, ws_shift_y;
    wire        ws_grid_valid;
    wire [5:0]  ws_grid_x;
    wire [4:0]  ws_grid_y;
    wire        ws_grid_pol, ws_grid_par;
    wire [15:0] ws_clamp_cnt;
    wire        ws_snap_valid;
    wire [17:0] ws_snap_n, ws_snap_prev_n;
    wire [16:0] ws_snap_on, ws_snap_off;
    wire [24:0] ws_snap_sx, ws_snap_sy;
    wire [39:0] ws_snap_sx2, ws_snap_sy2;
    wire [8:0]  ws_snap_cx, ws_snap_pcx;
    wire [7:0]  ws_snap_cy, ws_snap_pcy;

    nn_winstat u_ws (
        .clk_cam(clk_cam),
        .rst_n_cam(rst_n_cam),
        .i_ev_valid(ws_valid),
        .i_ev_x(ws_x),
        .i_ev_y(ws_y),
        .i_ev_pol(ws_pol),
        .i_win_tick(ws_tick),
        .o_stat_valid(ws_stat_valid),
        .o_n_on(ws_n_on),
        .o_n_off(ws_n_off),
        .o_sum_x_on(ws_sum_x_on),
        .o_sum_y_on(ws_sum_y_on),
        .o_sum_x_off(ws_sum_x_off),
        .o_sum_y_off(ws_sum_y_off),
        .o_cx(ws_cx),
        .o_cy(ws_cy),
        .o_dcx(ws_dcx),
        .o_dcy(ws_dcy),
        .o_shift_x(ws_shift_x),
        .o_shift_y(ws_shift_y),
        .o_grid_valid(ws_grid_valid),
        .o_grid_x(ws_grid_x),
        .o_grid_y(ws_grid_y),
        .o_grid_pol(ws_grid_pol),
        .o_grid_par(ws_grid_par),
        .o_clamp_cnt(ws_clamp_cnt),
        .o_snap_valid(ws_snap_valid),
        .o_snap_n(ws_snap_n),
        .o_snap_on(ws_snap_on),
        .o_snap_off(ws_snap_off),
        .o_snap_sx(ws_snap_sx),
        .o_snap_sy(ws_snap_sy),
        .o_snap_sx2(ws_snap_sx2),
        .o_snap_sy2(ws_snap_sy2),
        .o_snap_cx(ws_snap_cx),
        .o_snap_cy(ws_snap_cy),
        .o_snap_pcx(ws_snap_pcx),
        .o_snap_pcy(ws_snap_pcy),
        .o_snap_prev_n(ws_snap_prev_n)
    );

    //--------------------------------------------------------------------------
    // nn_winfeat：输入直连 winstat 的窗末快照（真实级联，无 TB 侧改写）
    //--------------------------------------------------------------------------
    wire        pp_feat_valid;
    wire [7:0]  pp_n_div16, pp_prev_n_div16, pp_pol_bal;
    wire [7:0]  pp_dx, pp_dy, pp_dx_rel, pp_dy_rel;
    wire        pp_busy;
    wire [10:0] pp_cyc_cnt;

    nn_winfeat u_feat (
        .clk_cam(clk_cam),
        .rst_n_cam(rst_n_cam),
        .i_snap_valid(ws_snap_valid),
        .i_n(ws_snap_n),
        .i_on(ws_snap_on),
        .i_off(ws_snap_off),
        .i_sx(ws_snap_sx),
        .i_sy(ws_snap_sy),
        .i_sx2(ws_snap_sx2),
        .i_sy2(ws_snap_sy2),
        .i_cx(ws_snap_cx),
        .i_cy(ws_snap_cy),
        .i_pcx(ws_snap_pcx),
        .i_pcy(ws_snap_pcy),
        .i_prev_n(ws_snap_prev_n),
        .o_feat_valid(pp_feat_valid),
        .o_n_div16(pp_n_div16),
        .o_prev_n_div16(pp_prev_n_div16),
        .o_pol_bal(pp_pol_bal),
        .o_dx(pp_dx),
        .o_dy(pp_dy),
        .o_dx_rel(pp_dx_rel),
        .o_dy_rel(pp_dy_rel),
        .o_busy(pp_busy),
        .o_cyc_cnt(pp_cyc_cnt)
    );

    //--------------------------------------------------------------------------
    // 判据基础设施
    //--------------------------------------------------------------------------
    integer errors = 0;
    integer chk_total = 0;
    reg [8*48-1:0] nm;

    task chk_pass;
        input [8*48-1:0] n_in;
        begin
            chk_total = chk_total + 1;
            $display("CHECK=%0s PASS", n_in);
        end
    endtask

    task chk_eqi;
        input [8*48-1:0] n_in;
        input integer got;
        input integer exp;
        begin
            if (got === exp) begin
                chk_pass(n_in);
            end else begin
                chk_total = chk_total + 1;
                errors = errors + 1;
                $display("CHECK=%0s FAIL got=%0d exp=%0d", n_in, got, exp);
            end
        end
    endtask

    task chk_eqb;
        input [8*48-1:0] n_in;
        input [7:0] got;
        input integer exp;
        reg [7:0] eu;
        begin
            eu = exp;
            if (got === eu) begin
                chk_pass(n_in);
            end else begin
                chk_total = chk_total + 1;
                errors = errors + 1;
                $display("CHECK=%0s FAIL got=%0d exp=%0d", n_in, $signed(got), exp);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 状态
    //--------------------------------------------------------------------------
    integer ev_cursor = 0;
    integer gi, wi, ii, en, w;
    reg [17:0] ev;
    reg [8:0]  ex;
    reg [7:0]  ey;
    reg        ep;
    reg [55:0]  exp_feat;
    reg [233:0] exp_snap;
    integer exp_f0, exp_f1, exp_f2, exp_f3, exp_f4, exp_f5, exp_f6;
    integer cl_before, cl_after;

    task run_window;
        input integer gidx;
        input integer lidx;
        begin
            w = F_WSTART(gidx) + lidx;
            en = F_EN(w);
            cl_before = ws_clamp_cnt;
            for (ii = 0; ii < en; ii = ii + 1) begin
                ev = FUZZ_EV[ev_cursor*18 +: 18];
                ev_cursor = ev_cursor + 1;
                ex = ev[8:0];
                ey = ev[16:9];
                ep = ev[17];
                @(negedge clk_cam);
                ws_valid = 1'b1;
                ws_x = ex;
                ws_y = ey;
                ws_pol = ep;
                @(negedge clk_cam);
                ws_valid = 1'b0;
            end
            repeat (40) @(negedge clk_cam);
            // 窗沿：单拍 i_win_tick
            ws_tick = 1'b1;
            @(negedge clk_cam);
            ws_tick = 1'b0;
            // 等窗末快照（非空窗 ≈52 拍后、空窗 1~2 拍后）
            while (ws_snap_valid !== 1'b1) @(negedge clk_cam);

            exp_snap = FUZZ_SNAP[w];
            $sformat(nm, "G%0dW%0d_WS_N", gidx, lidx);
            chk_eqi(nm, ws_snap_n, exp_snap[233:216]);
            $sformat(nm, "G%0dW%0d_WS_ON", gidx, lidx);
            chk_eqi(nm, ws_snap_on, exp_snap[215:199]);
            $sformat(nm, "G%0dW%0d_WS_OFF", gidx, lidx);
            chk_eqi(nm, ws_snap_off, exp_snap[198:182]);
            $sformat(nm, "G%0dW%0d_WS_SX", gidx, lidx);
            chk_eqi(nm, ws_snap_sx, exp_snap[181:157]);
            $sformat(nm, "G%0dW%0d_WS_SY", gidx, lidx);
            chk_eqi(nm, ws_snap_sy, exp_snap[156:132]);
            $sformat(nm, "G%0dW%0d_WS_SX2", gidx, lidx);
            chk_eqi(nm, ws_snap_sx2, exp_snap[131:92]);
            $sformat(nm, "G%0dW%0d_WS_SY2", gidx, lidx);
            chk_eqi(nm, ws_snap_sy2, exp_snap[91:52]);
            $sformat(nm, "G%0dW%0d_WS_CX", gidx, lidx);
            chk_eqi(nm, ws_snap_cx, exp_snap[51:43]);
            $sformat(nm, "G%0dW%0d_WS_CY", gidx, lidx);
            chk_eqi(nm, ws_snap_cy, exp_snap[42:35]);
            $sformat(nm, "G%0dW%0d_WS_PCX", gidx, lidx);
            chk_eqi(nm, ws_snap_pcx, exp_snap[34:26]);
            $sformat(nm, "G%0dW%0d_WS_PCY", gidx, lidx);
            chk_eqi(nm, ws_snap_pcy, exp_snap[25:18]);
            $sformat(nm, "G%0dW%0d_WS_PREVN", gidx, lidx);
            chk_eqi(nm, ws_snap_prev_n, exp_snap[17:0]);

            // 7 路部署特征（int8 补码逐值比对）
            while (pp_feat_valid !== 1'b1) @(negedge clk_cam);
            exp_feat = FUZZ_EXP[w];
            exp_f0 = $signed(exp_feat[55:48]);
            exp_f1 = $signed(exp_feat[47:40]);
            exp_f2 = $signed(exp_feat[39:32]);
            exp_f3 = $signed(exp_feat[31:24]);
            exp_f4 = $signed(exp_feat[23:16]);
            exp_f5 = $signed(exp_feat[15:8]);
            exp_f6 = $signed(exp_feat[7:0]);
            $sformat(nm, "G%0dW%0d_NDIV16", gidx, lidx);
            chk_eqb(nm, pp_n_div16, exp_f0);
            $sformat(nm, "G%0dW%0d_PREVN16", gidx, lidx);
            chk_eqb(nm, pp_prev_n_div16, exp_f1);
            $sformat(nm, "G%0dW%0d_POLBAL", gidx, lidx);
            chk_eqb(nm, pp_pol_bal, exp_f2);
            $sformat(nm, "G%0dW%0d_DX", gidx, lidx);
            chk_eqb(nm, pp_dx, exp_f3);
            $sformat(nm, "G%0dW%0d_DY", gidx, lidx);
            chk_eqb(nm, pp_dy, exp_f4);
            $sformat(nm, "G%0dW%0d_DXREL", gidx, lidx);
            chk_eqb(nm, pp_dx_rel, exp_f5);
            $sformat(nm, "G%0dW%0d_DYREL", gidx, lidx);
            chk_eqb(nm, pp_dy_rel, exp_f6);

            cl_after = ws_clamp_cnt;
            $sformat(nm, "G%0dW%0d_CLAMP", gidx, lidx);
            chk_eqi(nm, cl_after - cl_before, FUZZ_CLAMP[w]);

            $display("INFO W%0d %0s n=%0d rtl=%0d,%0d,%0d,%0d,%0d,%0d,%0d exp=%0d,%0d,%0d,%0d,%0d,%0d,%0d clamp=%0d cyc=%0d",
                     w, FUZZ_TAG[w], ws_snap_n,
                     $signed(pp_n_div16), $signed(pp_prev_n_div16), $signed(pp_pol_bal),
                     $signed(pp_dx), $signed(pp_dy), $signed(pp_dx_rel), $signed(pp_dy_rel),
                     exp_f0, exp_f1, exp_f2, exp_f3, exp_f4, exp_f5, exp_f6,
                     cl_after - cl_before, pp_cyc_cnt);

            while (pp_busy !== 1'b0) @(negedge clk_cam);
            repeat (4) @(negedge clk_cam);
        end
    endtask

    //--------------------------------------------------------------------------
    // 主流程：每个用例组先复位（pcx/pcy/prev_n 回 200/120/0），再逐窗跑
    //--------------------------------------------------------------------------
    initial begin
        ev_cursor = 0;
        repeat (10) @(negedge clk_cam);
        rst_n_cam = 1'b1;
        repeat (5) @(negedge clk_cam);
        for (gi = 0; gi < `FUZZ_NG; gi = gi + 1) begin
            rst_n_cam = 1'b0;
            repeat (6) @(negedge clk_cam);
            rst_n_cam = 1'b1;
            repeat (6) @(negedge clk_cam);
            for (wi = 0; wi < F_WLEN(gi); wi = wi + 1) begin
                run_window(gi, wi);
            end
        end
        $display("INFO_NEV_USED=%0d", ev_cursor);
        $display("INFO_CHECK_TOTAL=%0d", chk_total);
        $display("INFO_ERRORS=%0d", errors);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else $display("TEST_RESULT=FAIL");
        $finish;
    end

    initial begin
        #50_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule