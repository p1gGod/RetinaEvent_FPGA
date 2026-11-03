//==============================================================================
// tb_nn_winstat —— nn_winstat 单模块仿真（M3b 判据 TB_WINSTAT_OK）
//
// 覆盖 task-40 判据（CHECK 名与证据 EVIDENCE_M3b.md 一一对应）：
//   ★M3c 语义修订（Lead m01546，权威契约 = nn/v7/intwin.py:113-127）：
//     平移量 = 上一有效窗质心的**绝对重新居中** shift = pcx - (200,120)，单位为像素；
//     事件写网格 = clamp(pixel - shift, 0, IMG-1) >> 3（**先像素域 clamp 再折算到格**）；
//     无累加、无跨窗递归；空窗不更新质心 => 平移量保持（不归零）；
//     o_dcx/o_dcy = cx - pcx（窗间增量，pcx 复位 200/120）
//   (a) 空窗：n=0、Sigma=0、质心保持上一有效值、Delta=0、shift 保持、无除零/无 X
//   (b) 单点事件：n=1  =>  cx=x、cy=y；首窗 dcx = cx-200、shift = cx-200
//   (c) 已知 4 点质心：Sigma 与质心逐值复算，误差 0
//       （点集按任务书 "x/2 缩放后的整数输入"：x=800 超出 9 bit 端口，
//         故喂 (0,0),(0,0),(200,200),(400,0) => Sigma_x=600、cx=150；
//         另加一组端口内可表示的原值 (0,0),(0,0),(400,200),(400,0)）
//   (d) 3 窗序列：窗 k 的事件写网格用 shift = cx_{k-1} - (200,120)（绝对重新居中）；
//       只用上一窗统计量（窗内喂极端事件，shift 在窗沿前不变）；
//       像素域越界 clamp 到 [0,399]x[0,239] 再 >>3，o_clamp_cnt 按事件计数
//   (e) 窗沿 -> o_stat_valid <= 5000 clk_cam；稳态单事件 -> o_grid_valid <= 4 拍
//   (f) 资源/综合见 tool/nn_winstat_synth.tcl（本 TB 不涉及）
//
// 约定：$display / $error 全 ASCII（ModelSim 控制台为 GBK）
//==============================================================================
`timescale 1ns / 1ps

module tb_nn_winstat;

    // ---- 时钟：50 MHz ------------------------------------------------------
    reg clk_cam = 1'b0;
    always #10 clk_cam = ~clk_cam;

    integer cyc = 0;
    always @(posedge clk_cam) cyc <= cyc + 1;

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

    // ---- DUT ---------------------------------------------------------------
    reg        rst_n_cam  = 1'b0;
    reg        i_ev_valid = 1'b0;
    reg [8:0]  i_ev_x     = 9'd0;
    reg [7:0]  i_ev_y     = 8'd0;
    reg        i_ev_pol   = 1'b0;
    reg        i_win_tick = 1'b0;

    wire        o_stat_valid;
    wire [15:0] o_n_on, o_n_off;
    wire [23:0] o_sum_x_on, o_sum_y_on, o_sum_x_off, o_sum_y_off;
    wire [8:0]  o_cx;
    wire [7:0]  o_cy;
    wire [9:0]  o_dcx, o_dcy;
    wire [9:0]  o_shift_x, o_shift_y;
    wire        o_grid_valid;
    wire [5:0]  o_grid_x;
    wire [4:0]  o_grid_y;
    wire        o_grid_pol;
    wire [15:0] o_clamp_cnt;

    nn_winstat dut (
        .clk_cam      (clk_cam),
        .rst_n_cam    (rst_n_cam),
        .i_ev_valid   (i_ev_valid),
        .i_ev_x       (i_ev_x),
        .i_ev_y       (i_ev_y),
        .i_ev_pol     (i_ev_pol),
        .i_win_tick   (i_win_tick),
        .o_stat_valid (o_stat_valid),
        .o_n_on       (o_n_on),
        .o_n_off      (o_n_off),
        .o_sum_x_on   (o_sum_x_on),
        .o_sum_y_on   (o_sum_y_on),
        .o_sum_x_off  (o_sum_x_off),
        .o_sum_y_off  (o_sum_y_off),
        .o_cx         (o_cx),
        .o_cy         (o_cy),
        .o_dcx        (o_dcx),
        .o_dcy        (o_dcy),
        .o_shift_x    (o_shift_x),
        .o_shift_y    (o_shift_y),
        .o_grid_valid (o_grid_valid),
        .o_grid_x     (o_grid_x),
        .o_grid_y     (o_grid_y),
        .o_grid_pol   (o_grid_pol),
        .o_clamp_cnt  (o_clamp_cnt)
    );

    // ---- 统计 / 网格事件监视 ----------------------------------------------
    reg [5:0] cap_gx [0:511];
    reg [4:0] cap_gy [0:511];
    reg       cap_gp [0:511];
    integer   cap_cyc [0:511];
    integer   cap_n = 0;

    integer   ev_cnt   = 0;   // 喂入事件数
    integer   tick_cnt = 0;   // 窗沿数
    integer   stat_cnt = 0;   // o_stat_valid 脉冲数
    integer   x_err    = 0;   // 输出 X 次数

    always @(negedge clk_cam) begin
        if (o_grid_valid === 1'b1) begin
            if (cap_n < 512) begin
                cap_gx[cap_n] = o_grid_x;
                cap_gy[cap_n] = o_grid_y;
                cap_gp[cap_n] = o_grid_pol;
                cap_cyc[cap_n] = cyc;
            end
            cap_n = cap_n + 1;
        end
        if (o_stat_valid === 1'b1) stat_cnt = stat_cnt + 1;
        if (rst_n_cam === 1'b1) begin
            if (((^o_cx) === 1'bx) || ((^o_cy) === 1'bx) ||
                ((^o_shift_x) === 1'bx) || ((^o_shift_y) === 1'bx) ||
                ((^o_grid_valid) === 1'bx) || ((^o_stat_valid) === 1'bx) ||
                ((^o_n_on) === 1'bx) || ((^o_n_off) === 1'bx) ||
                ((^o_sum_x_on) === 1'bx) || ((^o_sum_x_off) === 1'bx))
                x_err = x_err + 1;
        end
    end

    // ---- 激励任务 ----------------------------------------------------------
    task do_reset; begin
        @(negedge clk_cam);
        rst_n_cam  = 1'b0;
        i_ev_valid = 1'b0;
        i_win_tick = 1'b0;
        cap_n = 0; ev_cnt = 0; tick_cnt = 0; stat_cnt = 0;
        repeat (5) @(negedge clk_cam);
        rst_n_cam = 1'b1;
        repeat (3) @(negedge clk_cam);
    end endtask

    task send_ev; input [8:0] x; input [7:0] y; input p; begin
        @(negedge clk_cam);
        i_ev_valid = 1'b1; i_ev_x = x; i_ev_y = y; i_ev_pol = p;
        ev_cnt = ev_cnt + 1;
        @(negedge clk_cam);
        i_ev_valid = 1'b0;
    end endtask

    task win_tick_t; begin
        @(negedge clk_cam);
        i_win_tick = 1'b1;
        tick_cnt = tick_cnt + 1;
        @(negedge clk_cam);
        i_win_tick = 1'b0;
    end endtask

    // 窗沿同拍带一条事件（事件归入新窗）
    task tick_with_ev; input [8:0] x; input [7:0] y; input p; begin
        @(negedge clk_cam);
        i_win_tick = 1'b1; i_ev_valid = 1'b1;
        i_ev_x = x; i_ev_y = y; i_ev_pol = p;
        tick_cnt = tick_cnt + 1; ev_cnt = ev_cnt + 1;
        @(negedge clk_cam);
        i_win_tick = 1'b0; i_ev_valid = 1'b0;
    end endtask

    task wait_stat; begin
        // 先看当前拍：空窗在窗沿同拍发布（单拍脉冲），等下一个 negedge 会漏掉
        while (o_stat_valid !== 1'b1) @(negedge clk_cam);
    end endtask

    // 收尾：再打一拍窗沿把残余事件排空，然后检查 "喂入数 == 网格输出数"
    task drain_check; input [8*56-1:0] nm; begin
        win_tick_t;
        wait_stat;
        repeat (12) @(negedge clk_cam);
        if ((ev_cnt == cap_n) && (stat_cnt == tick_cnt))
            chk_pass(nm);
        else begin
            chk_fail(nm);
            $display("    [%0s] ev_cnt=%0d cap_n=%0d stat_cnt=%0d tick_cnt=%0d",
                     nm, ev_cnt, cap_n, stat_cnt, tick_cnt);
        end
    end endtask

    // ---- 主流程 ------------------------------------------------------------
    integer cap_base;
    integer cap_base2;
    integer t0, t1, lat;
    integer t_ev, lat_ev;

    initial begin
        if ($test$plusargs("DUMP")) begin
            // no-op: 波形由 run_sim -Vcd 打开
        end

        // =====================================================================
        // A. 复位值 / 无 X
        // =====================================================================
        do_reset;
        chk_eq("A1_RESET_SHIFT_X_0",      o_shift_x,     32'd0);
        chk_eq("A2_RESET_SHIFT_Y_0",      o_shift_y,     32'd0);
        chk_eq("A3_RESET_CX_0",           o_cx,          32'd0);
        chk_eq("A4_RESET_CY_0",           o_cy,          32'd0);
        chk_eq("A5_RESET_STAT_VALID_0",   o_stat_valid,  32'd0);
        chk_eq("A6_RESET_GRID_VALID_0",   o_grid_valid,  32'd0);
        chk_eq("A7_RESET_CLAMP_CNT_0",    o_clamp_cnt,   32'd0);

        // =====================================================================
        // B. (b) 单点事件：n=1 => cx=x, cy=y
        // =====================================================================
        do_reset;
        send_ev(9'd123, 8'd77, 1'b1);
        win_tick_t;
        wait_stat;
        chk_eq("B1_SINGLE_N_ON_1",   o_n_on,     32'd1);
        chk_eq("B2_SINGLE_N_OFF_0",  o_n_off,    32'd0);
        chk_eq("B3_SINGLE_SUM_X_123",o_sum_x_on, 32'd123);
        chk_eq("B4_SINGLE_SUM_Y_77", o_sum_y_on, 32'd77);
        chk_eq("B5_SINGLE_CX_123",   o_cx,       32'd123);
        chk_eq("B6_SINGLE_CY_77",    o_cy,       32'd77);
        // ★M3c：pcx 复位 200 => dcx = 123-200 = -77（10 bit 补码 947）；shift 同值
        chk_eq("B7_SINGLE_DCX_M77",   o_dcx,      32'd947);
        chk_eq("B8_SINGLE_SHIFT_X_M77",o_shift_x, 32'd947);
        drain_check("B9_SINGLE_EV_NO_LOSS");

        // =====================================================================
        // C. (c) 已知 4 点：质心 = Sigma/n（纯整数，误差 0）
        //    任务书点集 (0,0),(0,0),(400,200),(800,0) 按 "x/2 缩放" 喂入
        //    => (0,0),(0,0),(200,200),(400,0)：Sigma_x=600, Sigma_y=200, n=4
        // =====================================================================
        do_reset;
        send_ev(9'd0,   8'd0,   1'b1);
        send_ev(9'd0,   8'd0,   1'b0);
        send_ev(9'd200, 8'd200, 1'b1);
        send_ev(9'd400, 8'd0,   1'b0);
        win_tick_t;
        wait_stat;
        chk_eq("C1_KNOWN4_N_ON_2",    o_n_on,      32'd2);
        chk_eq("C2_KNOWN4_N_OFF_2",   o_n_off,     32'd2);
        chk_eq("C3_KNOWN4_SUM_X_ON_200",  o_sum_x_on,  32'd200);
        chk_eq("C4_KNOWN4_SUM_Y_ON_200",  o_sum_y_on,  32'd200);
        chk_eq("C5_KNOWN4_SUM_X_OFF_400", o_sum_x_off, 32'd400);
        chk_eq("C6_KNOWN4_SUM_Y_OFF_0",   o_sum_y_off, 32'd0);
        chk_eq("C7_KNOWN4_CX_150",    o_cx,        32'd150);
        chk_eq("C8_KNOWN4_CY_50",     o_cy,        32'd50);
        // ★M3c：dcx = 150-200 = -50（10 bit 补码 974）
        chk_eq("C9_KNOWN4_DCX_M50", o_dcx,     32'd974);
        drain_check("C10_KNOWN4_EV_NO_LOSS");

        // C2：端口内可表示的原值点集 (0,0),(0,0),(400,200),(400,0)
        do_reset;
        send_ev(9'd0,   8'd0,   1'b1);
        send_ev(9'd0,   8'd0,   1'b0);
        send_ev(9'd400, 8'd200, 1'b1);
        send_ev(9'd400, 8'd0,   1'b0);
        win_tick_t;
        wait_stat;
        chk_eq("C11_RAW4_SUM_X_800", o_sum_x_on + o_sum_x_off, 32'd800);
        chk_eq("C12_RAW4_SUM_Y_200", o_sum_y_on + o_sum_y_off, 32'd200);
        chk_eq("C13_RAW4_CX_200",    o_cx, 32'd200);
        chk_eq("C14_RAW4_CY_50",     o_cy, 32'd50);
        drain_check("C15_RAW4_EV_NO_LOSS");

        // =====================================================================
        // D. (d) 3 窗序列：平移量只在下一窗生效（上一窗统计量，绝对重新居中）
        //    W1 质心 (100,50)   => shift1 = (100-200, 50-120) = (-100,-70)
        //    W2 质心 (116,50)   => shift2 = (-84,-70)  => W3 事件按此平移
        //    W3 质心 (259,22)   => shift3 = (59,-98)
        // =====================================================================
        do_reset;
        send_ev(9'd96,  8'd48, 1'b1);
        send_ev(9'd104, 8'd52, 1'b1);
        send_ev(9'd96,  8'd52, 1'b1);
        send_ev(9'd104, 8'd48, 1'b1);
        win_tick_t;
        wait_stat;
        chk_eq("D1_W1_CX_100",    o_cx,      32'd100);
        chk_eq("D2_W1_CY_50",     o_cy,      32'd50);
        // ★M3c：dcx = 100-200 = -100 => 924；shift = 100-200 => 924
        chk_eq("D3_W1_DCX_M100",    o_dcx,     32'd924);
        chk_eq("D4_W1_SHIFT_X_M100",o_shift_x, 32'd924);

        // W2：喂入后、窗沿前 shift 必须还是 W1 的值 -100（不能用本窗统计量）
        send_ev(9'd112, 8'd48, 1'b1);
        send_ev(9'd120, 8'd52, 1'b1);
        send_ev(9'd112, 8'd52, 1'b1);
        send_ev(9'd120, 8'd48, 1'b1);
        chk_eq("D5_W2_SHIFT_NOT_CURRENT", o_shift_x, 32'd924);
        win_tick_t;
        wait_stat;
        chk_eq("D6_W2_CX_116",    o_cx,      32'd116);
        chk_eq("D7_W2_DCY_0",     o_dcy,     32'd0);
        chk_eq("D8_W2_DCX_16",    o_dcx,     32'd16);
        // ★M3c：shift = (116-200, 50-120) = (-84,-70) => 940 / 954
        chk_eq("D9_W2_SHIFT_X_M84",o_shift_x, 32'd940);
        chk_eq("D10_W2_SHIFT_Y_M70",o_shift_y, 32'd954);

        // W3：4 条事件按 shift=(-84,-70) 平移（像素域加偏移后 clamp，全在界内不截断）
        cap_base = cap_n;
        send_ev(9'd128, 8'd40, 1'b1);
        send_ev(9'd200, 8'd80, 1'b0);
        send_ev(9'd136, 8'd48, 1'b1);
        send_ev(9'd8,   8'd8,  1'b0);
        repeat (8) @(negedge clk_cam);
        chk_eq("D11_W3_GRID_CNT_4",   cap_n - cap_base, 32'd4);
        // (128,40)->(212,110)->(26,13)；(200,80)->(284,150)->(35,18)
        // (136,48)->(220,118)->(27,14)；(8,8)->(92,78)->(11,9)
        chk_eq("D12_GRID0_X_26", cap_gx[cap_base+0], 32'd26);
        chk_eq("D13_GRID0_Y_13", cap_gy[cap_base+0], 32'd13);
        chk_eq("D14_GRID1_X_35", cap_gx[cap_base+1], 32'd35);
        chk_eq("D15_GRID1_Y_18", cap_gy[cap_base+1], 32'd18);
        chk_eq("D16_GRID2_X_27", cap_gx[cap_base+2], 32'd27);
        chk_eq("D17_GRID2_Y_14", cap_gy[cap_base+2], 32'd14);
        chk_eq("D18_GRID3_X_11", cap_gx[cap_base+3], 32'd11);
        chk_eq("D19_GRID3_Y_9",  cap_gy[cap_base+3], 32'd9);
        // 新语义下 4 条事件全在界内 => clamp 计数 0（旧语义此处为 1）
        chk_eq("D20_CLAMP_CNT_0", o_clamp_cnt, 32'd0);

        // 窗内再喂 4 条极端事件（x=400），窗沿前 shift 必须仍为 W2 的 -84
        send_ev(9'd400, 8'd0, 1'b1);
        send_ev(9'd400, 8'd0, 1'b1);
        send_ev(9'd400, 8'd0, 1'b1);
        send_ev(9'd400, 8'd0, 1'b1);
        chk_eq("D21_W3_SHIFT_STILL_M84", o_shift_x, 32'd940);
        win_tick_t;
        wait_stat;
        // Sigma_x = 472 + 1600 = 2072, n = 8 => cx = 259；Sigma_y = 176 => cy = 22
        chk_eq("D22_W3_CX_259",     o_cx,      32'd259);
        chk_eq("D23_W3_CY_22",      o_cy,      32'd22);
        chk_eq("D24_W3_DCX_143",    o_dcx,     32'd143);
        chk_eq("D25_W3_DCY_NEG28",  o_dcy,     32'd996);   // 10-bit 补码
        // ★M3c：shift = 259-200 = 59（不再是窗间增量 143）
        chk_eq("D26_W3_SHIFT_X_59",o_shift_x, 32'd59);
        drain_check("D27_SEQ_EV_NO_LOSS");

        // =====================================================================
        // E. 负位移 + 像素域上界 clamp（W4 质心 (96,60) => shift = (-104,-60)）
        //    W5 事件：像素域 +(104,60) 后 clamp 再 >>3：
        //      (0,232)   -> (104,292->239) -> (13,29)
        //      (392,232) -> (496->399,292->239) -> (49,29)   [x,y 均截断，计 1]
        //      (0,0)     -> (104,60) -> (13,7)
        // =====================================================================
        do_reset;
        send_ev(9'd96,  8'd48, 1'b1);
        send_ev(9'd104, 8'd52, 1'b1);
        send_ev(9'd96,  8'd52, 1'b1);
        send_ev(9'd104, 8'd48, 1'b1);
        win_tick_t;
        wait_stat;
        chk_eq("E1_W4_CX_100", o_cx, 32'd100);

        send_ev(9'd92,  8'd58, 1'b1);
        send_ev(9'd100, 8'd62, 1'b1);
        send_ev(9'd92,  8'd62, 1'b1);
        send_ev(9'd100, 8'd58, 1'b1);
        win_tick_t;
        wait_stat;
        chk_eq("E2_W4_CX_96",       o_cx,     32'd96);
        chk_eq("E3_W4_CY_60",       o_cy,     32'd60);
        chk_eq("E4_W4_DCX_NEG4",    o_dcx,    32'd1020);  // -4
        chk_eq("E5_W4_DCY_10",      o_dcy,    32'd10);
        // ★M3c：shift = (96-200, 60-120) = (-104,-60) => 920 / 964
        chk_eq("E6_SHIFT_X_M104",   o_shift_x,32'd920);
        chk_eq("E7_SHIFT_Y_M60",    o_shift_y,32'd964);

        cap_base2 = cap_n;
        send_ev(9'd0,   8'd232, 1'b1);   // (104,292) y clamp 239 -> (13,29)
        send_ev(9'd392, 8'd232, 1'b1);   // (496,292) x,y clamp 399/239 -> (49,29)
        send_ev(9'd0,   8'd0,   1'b1);   // (104,60) -> (13,7)
        repeat (8) @(negedge clk_cam);
        chk_eq("E8_GRID0_X_13",   cap_gx[cap_base2+0], 32'd13);
        chk_eq("E9_GRID0_Y_CLAMP29", cap_gy[cap_base2+0], 32'd29);
        chk_eq("E10_GRID1_X_CLAMP49", cap_gx[cap_base2+1], 32'd49);
        chk_eq("E11_GRID1_Y_CLAMP29", cap_gy[cap_base2+1], 32'd29);
        chk_eq("E12_GRID2_X_13",  cap_gx[cap_base2+2], 32'd13);
        chk_eq("E13_GRID2_Y_7",   cap_gy[cap_base2+2], 32'd7);
        chk_eq("E14_CLAMP_CNT_2", o_clamp_cnt, 32'd2);
        win_tick_t;
        wait_stat;
        // Sigma_x = 392, n=3 => cx=130 (floor 130.67)；Sigma_y=464 => cy=154
        chk_eq("E15_FLOOR_CX_130", o_cx, 32'd130);
        chk_eq("E16_FLOOR_CY_154", o_cy, 32'd154);
        drain_check("E17_NEGDELTA_EV_NO_LOSS");

        // =====================================================================
        // F. (a) 空窗：n=0、Sigma=0、质心保持、Delta=0、shift 保持、无除零
        // =====================================================================
        do_reset;
        send_ev(9'd96,  8'd48, 1'b1);
        send_ev(9'd104, 8'd52, 1'b1);
        send_ev(9'd104, 8'd48, 1'b1);
        send_ev(9'd96,  8'd52, 1'b1);
        win_tick_t;
        wait_stat;
        chk_eq("F0_PRE_CX_100", o_cx, 32'd100);
        win_tick_t;                       // 空窗
        wait_stat;
        chk_eq("F1_EMPTY_N_ON_0",    o_n_on,      32'd0);
        chk_eq("F2_EMPTY_N_OFF_0",   o_n_off,     32'd0);
        chk_eq("F3_EMPTY_SUM_X_ON_0",o_sum_x_on,  32'd0);
        chk_eq("F4_EMPTY_SUM_Y_ON_0",o_sum_y_on,  32'd0);
        chk_eq("F5_EMPTY_SUM_X_OFF_0",o_sum_x_off,32'd0);
        chk_eq("F6_EMPTY_SUM_Y_OFF_0",o_sum_y_off,32'd0);
        chk_eq("F7_EMPTY_CX_HOLD_100", o_cx,      32'd100);
        chk_eq("F8_EMPTY_CY_HOLD_50",  o_cy,      32'd50);
        chk_eq("F9_EMPTY_DCX_0",     o_dcx,       32'd0);
        chk_eq("F10_EMPTY_DCY_0",    o_dcy,       32'd0);
        // ★M3c：空窗不更新质心 => 平移量保持上一窗的 (-100,-70)
        chk_eq("F11_EMPTY_SHIFT_X_M100",o_shift_x, 32'd924);
        chk_eq("F12_EMPTY_SHIFT_Y_M70", o_shift_y, 32'd954);
        cap_base = cap_n;
        send_ev(9'd100, 8'd100, 1'b1);    // 平移保持 (-100,-70): (200,170)->(25,21)
        repeat (8) @(negedge clk_cam);
        chk_eq("F13_AFTER_EMPTY_GRID_X_25", cap_gx[cap_base], 32'd25);
        chk_eq("F14_AFTER_EMPTY_GRID_Y_21", cap_gy[cap_base], 32'd21);
        drain_check("F15_EMPTY_EV_NO_LOSS");

        // =====================================================================
        // G. (e) 时延：窗沿 -> o_stat_valid <= 5000 拍；单事件 -> 网格 <= 4 拍
        // =====================================================================
        do_reset;
        send_ev(9'd96,  8'd48, 1'b1);
        send_ev(9'd104, 8'd52, 1'b1);
        send_ev(9'd104, 8'd48, 1'b1);
        send_ev(9'd96,  8'd52, 1'b1);
        @(negedge clk_cam); t0 = cyc;
        win_tick_t;
        wait_stat;
        t1  = cyc;
        lat = t1 - t0;
        $display("INFO_STAT_LAT_CYC=%0d", lat);
        if (lat <= 5000) chk_pass("G1_STAT_LAT_LE5000");
        else begin chk_fail("G1_STAT_LAT_LE5000"); $display("    lat=%0d", lat); end

        cap_base = cap_n;
        @(negedge clk_cam); t_ev = cyc;
        i_ev_valid = 1'b1; i_ev_x = 9'd64; i_ev_y = 8'd64; i_ev_pol = 1'b1;
        ev_cnt = ev_cnt + 1;
        @(negedge clk_cam);
        i_ev_valid = 1'b0;
        while (cap_n == cap_base) @(negedge clk_cam);
        lat_ev = cap_cyc[cap_base] - t_ev;
        $display("INFO_EV_LAT_CYC=%0d", lat_ev);
        if (lat_ev <= 4) chk_pass("G2_EV_LAT_LE4");
        else begin chk_fail("G2_EV_LAT_LE4"); $display("    lat_ev=%0d", lat_ev); end
        drain_check("G3_LAT_EV_NO_LOSS");

        // =====================================================================
        // H. 窗沿边界：窗沿同拍事件 + 计算期事件都要用**新窗**的位移
        //    W1 质心 (100,50) => shift1=(-100,-70)；W2 质心 (110,50) => shift2=(-90,-70)
        //    W3 质心 (132,50) => shift3=(-68,-70) => W4 事件按 (-68,-70) 平移
        //    窗沿同拍事件 (200,80)  -> (268,150) -> grid (33,18)
        //    计算期事件   (360,232) -> (428->399, 302->239) -> grid (49,29)
        // =====================================================================
        do_reset;
        send_ev(9'd96,  8'd48, 1'b1);
        send_ev(9'd104, 8'd52, 1'b1);
        send_ev(9'd96,  8'd52, 1'b1);
        send_ev(9'd104, 8'd48, 1'b1);
        win_tick_t; wait_stat;
        chk_eq("H1_W1_CX_100", o_cx, 32'd100);

        send_ev(9'd106, 8'd48, 1'b1);
        send_ev(9'd114, 8'd52, 1'b1);
        send_ev(9'd106, 8'd52, 1'b1);
        send_ev(9'd114, 8'd48, 1'b1);
        win_tick_t; wait_stat;
        chk_eq("H2_W2_CX_110",  o_cx,      32'd110);
        chk_eq("H3_W2_DCX_10",  o_dcx,     32'd10);
        // ★M3c：shift = 110-200 = -90 => 934
        chk_eq("H4_W3_SHIFT_M90",o_shift_x, 32'd934);

        send_ev(9'd128, 8'd48, 1'b1);
        send_ev(9'd136, 8'd52, 1'b1);
        send_ev(9'd128, 8'd52, 1'b1);
        send_ev(9'd136, 8'd48, 1'b1);
        repeat (4) @(negedge clk_cam);           // 等 W3 的 4 条事件全部弹出
        cap_base = cap_n;
        tick_with_ev(9'd200, 8'd80, 1'b1);       // 窗沿同拍，归新窗
        repeat (5) @(negedge clk_cam);
        // 计算期再喂一条
        i_ev_valid = 1'b1; i_ev_x = 9'd360; i_ev_y = 8'd232; i_ev_pol = 1'b1;
        ev_cnt = ev_cnt + 1;
        @(negedge clk_cam);
        i_ev_valid = 1'b0;
        wait_stat;
        chk_eq("H5_W3_CX_132",   o_cx,      32'd132);
        chk_eq("H6_W3_DCX_22",   o_dcx,     32'd22);
        // ★M3c：shift = 132-200 = -68 => 956
        chk_eq("H7_W4_SHIFT_M68", o_shift_x, 32'd956);
        repeat (10) @(negedge clk_cam);
        chk_eq("H8_BOUND_EV_GRID_X_33",  cap_gx[cap_base+0], 32'd33);
        chk_eq("H9_BOUND_EV_GRID_Y_18",  cap_gy[cap_base+0], 32'd18);
        chk_eq("H10_BUSY_EV_GRID_X_CLAMP49", cap_gx[cap_base+1], 32'd49);
        chk_eq("H11_BUSY_EV_GRID_Y_29", cap_gy[cap_base+1], 32'd29);
        drain_check("H12_BOUND_EV_NO_LOSS");

        // =====================================================================
        // 汇总
        // =====================================================================
        chk_eq("Z1_NO_X_ON_OUTPUTS", x_err, 32'd0);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else begin $display("TEST_RESULT=FAIL (errors=%0d)", errors); end
        $display("INFO_CHECK_TOTAL=%0d", chk_total);
        $finish;
    end

endmodule
