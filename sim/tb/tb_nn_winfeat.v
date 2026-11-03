//==============================================================================
// tb_nn_winfeat —— M3d 窗级部署特征前端自检（18 组 golden 向量）
//
// 【golden 来源】build/gen_winfeat_golden.py：
//   ① 用参考实现 nn/v7/intwin.py 的 subblock_stats + window_stats 在随机事件流上
//      交叉验证「原始累加量 → cx/cy/sx/sy/pcx/pcy/prev_n」公式（840 项，0 失配）；
//   ② 每个向量由真实事件坐标算出 n/on/off/Σx/Σy/Σx²/Σy²，其 7 路特征由
//      nn/v7/v7_feats.py 的 python_row（权威参考实现）给出；
//   ③ 向量间按真实窗序列串接 pcx/pcy（首窗 200/120）与 prev_n（首窗 0），
//      包含 n=0 空窗（carry 语义）。
//
// 【覆盖】空窗 n=0、单事件、两角点、矩形簇、高斯簇、n=4000（n_div16 饱和 127）、
//   负/正 dx_rel 夹 ±127、极小方差（S 下限 8）、全 ON / 全 OFF（pol_bal ±127）、
//   交替点（大方差）、n=1200/5000（prev_n_div16 饱和）。10 组负 dx，其中 6 组
//   dx*64 不被 S 整除 ⇒ 可区分「floor」与「向零截断」（floor 是契约）。
//
// 【运行】cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_winfeat
//   判据：TEST_RESULT=PASS 且无 CHECK=... FAIL，退出码 0。
//==============================================================================
`timescale 1ns / 1ps

module tb_nn_winfeat;
    reg clk_cam = 0;
    reg rst_n_cam = 0;
    always #10 clk_cam = ~clk_cam;          // 50 MHz

    // ---- DUT 输入（快照）----
    reg         i_snap_valid = 1'b0;
    reg  [17:0] i_n        = 18'd0;
    reg  [16:0] i_on       = 17'd0;
    reg  [16:0] i_off      = 17'd0;
    reg  [24:0] i_sx       = 25'd0;
    reg  [24:0] i_sy       = 25'd0;
    reg  [39:0] i_sx2      = 40'd0;
    reg  [39:0] i_sy2      = 40'd0;
    reg  [8:0]  i_cx       = 9'd0;
    reg  [7:0]  i_cy       = 8'd0;
    reg  [8:0]  i_pcx      = 9'd0;
    reg  [7:0]  i_pcy      = 8'd0;
    reg  [17:0] i_prev_n   = 18'd0;

    // ---- DUT 输出 ----
    wire        o_feat_valid;
    wire [7:0]  o_n_div16;
    wire [7:0]  o_prev_n_div16;
    wire [7:0]  o_pol_bal;
    wire [7:0]  o_dx;
    wire [7:0]  o_dy;
    wire [7:0]  o_dx_rel;
    wire [7:0]  o_dy_rel;
    wire        o_busy;
    wire [10:0] o_cyc_cnt;

    nn_winfeat dut (
        .clk_cam       (clk_cam),
        .rst_n_cam     (rst_n_cam),
        .i_snap_valid  (i_snap_valid),
        .i_n           (i_n),
        .i_on          (i_on),
        .i_off         (i_off),
        .i_sx          (i_sx),
        .i_sy          (i_sy),
        .i_sx2         (i_sx2),
        .i_sy2         (i_sy2),
        .i_cx          (i_cx),
        .i_cy          (i_cy),
        .i_pcx         (i_pcx),
        .i_pcy         (i_pcy),
        .i_prev_n      (i_prev_n),
        .o_feat_valid  (o_feat_valid),
        .o_n_div16     (o_n_div16),
        .o_prev_n_div16(o_prev_n_div16),
        .o_pol_bal     (o_pol_bal),
        .o_dx          (o_dx),
        .o_dy          (o_dy),
        .o_dx_rel      (o_dx_rel),
        .o_dy_rel      (o_dy_rel),
        .o_busy        (o_busy),
        .o_cyc_cnt     (o_cyc_cnt)
    );

    //==========================================================================
    // Phase 2：nn_winstat -> nn_winfeat 真实窗串接对拍
    //   golden = nn/out_v7/tb_golden_v7.vh（coder3 nn/v7/gen_tb_golden.py 从
    //   golden_vectors.json 生成，独立于本 TB 的 18 向量表；含 GV_PP_* 9 个
    //   真实预处理窗：pp01/pp02/pp03 各 2 窗、pp04/pp05/pp06 各 1 窗）。
    //   用途：证明「真实事件流 -> 累加 -> cx/cy/pcx/prev_n -> 7 路特征」端到端
    //   与训练侧逐值一致，且真实输入下累加量位宽足够。
    //==========================================================================
`include "tb_golden_v7.vh"

    // ---- nn_winstat（复位/事件源另建，不与 phase 1 共用输入）----
    reg         ws_valid = 1'b0;
    reg  [8:0]  ws_x = 9'd0;
    reg  [7:0]  ws_y = 8'd0;
    reg         ws_pol = 1'b0;
    reg         ws_tick = 1'b0;

    wire        ws_stat_valid;
    wire [15:0] ws_n_on;
    wire [15:0] ws_n_off;
    wire [23:0] ws_sx_on;
    wire [23:0] ws_sy_on;
    wire [23:0] ws_sx_off;
    wire [23:0] ws_sy_off;
    wire [8:0]  ws_cx;
    wire [7:0]  ws_cy;
    wire [9:0]  ws_dcx;
    wire [9:0]  ws_dcy;
    wire [9:0]  ws_shift_x;
    wire [9:0]  ws_shift_y;
    wire        ws_grid_valid;
    wire [5:0]  ws_grid_x;
    wire [4:0]  ws_grid_y;
    wire        ws_grid_pol;
    wire        ws_grid_par;
    wire [15:0] ws_clamp_cnt;
    wire        ws_snap_valid;
    wire [17:0] ws_snap_n;
    wire [16:0] ws_snap_on;
    wire [16:0] ws_snap_off;
    wire [24:0] ws_snap_sx;
    wire [24:0] ws_snap_sy;
    wire [39:0] ws_snap_sx2;
    wire [39:0] ws_snap_sy2;
    wire [8:0]  ws_snap_cx;
    wire [7:0]  ws_snap_cy;
    wire [8:0]  ws_snap_pcx;
    wire [7:0]  ws_snap_pcy;
    wire [17:0] ws_snap_prev_n;

    nn_winstat u_ws (
        .clk_cam        (clk_cam),
        .rst_n_cam      (rst_n_cam),
        .i_ev_valid     (ws_valid),
        .i_ev_x         (ws_x),
        .i_ev_y         (ws_y),
        .i_ev_pol       (ws_pol),
        .i_win_tick     (ws_tick),
        .o_stat_valid   (ws_stat_valid),
        .o_n_on         (ws_n_on),
        .o_n_off        (ws_n_off),
        .o_sum_x_on     (ws_sx_on),
        .o_sum_y_on     (ws_sy_on),
        .o_sum_x_off    (ws_sx_off),
        .o_sum_y_off    (ws_sy_off),
        .o_cx           (ws_cx),
        .o_cy           (ws_cy),
        .o_dcx          (ws_dcx),
        .o_dcy          (ws_dcy),
        .o_shift_x      (ws_shift_x),
        .o_shift_y      (ws_shift_y),
        .o_grid_valid   (ws_grid_valid),
        .o_grid_x       (ws_grid_x),
        .o_grid_y       (ws_grid_y),
        .o_grid_pol     (ws_grid_pol),
        .o_grid_par     (ws_grid_par),
        .o_clamp_cnt    (ws_clamp_cnt),
        .o_snap_valid   (ws_snap_valid),
        .o_snap_n       (ws_snap_n),
        .o_snap_on      (ws_snap_on),
        .o_snap_off     (ws_snap_off),
        .o_snap_sx      (ws_snap_sx),
        .o_snap_sy      (ws_snap_sy),
        .o_snap_sx2     (ws_snap_sx2),
        .o_snap_sy2     (ws_snap_sy2),
        .o_snap_cx      (ws_snap_cx),
        .o_snap_cy      (ws_snap_cy),
        .o_snap_pcx     (ws_snap_pcx),
        .o_snap_pcy     (ws_snap_pcy),
        .o_snap_prev_n  (ws_snap_prev_n)
    );

    // ---- nn_winfeat（直接吃 winstat 的窗末快照）----
    wire        pp_feat_valid;
    wire [7:0]  pp_n_div16;
    wire [7:0]  pp_prev_n_div16;
    wire [7:0]  pp_pol_bal;
    wire [7:0]  pp_dx;
    wire [7:0]  pp_dy;
    wire [7:0]  pp_dx_rel;
    wire [7:0]  pp_dy_rel;
    wire        pp_busy;
    wire [10:0] pp_cyc_cnt;

    nn_winfeat u_feat_pp (
        .clk_cam        (clk_cam),
        .rst_n_cam      (rst_n_cam),
        .i_snap_valid   (ws_snap_valid),
        .i_n            (ws_snap_n),
        .i_on           (ws_snap_on),
        .i_off          (ws_snap_off),
        .i_sx           (ws_snap_sx),
        .i_sy           (ws_snap_sy),
        .i_sx2          (ws_snap_sx2),
        .i_sy2          (ws_snap_sy2),
        .i_cx           (ws_snap_cx),
        .i_cy           (ws_snap_cy),
        .i_pcx          (ws_snap_pcx),
        .i_pcy          (ws_snap_pcy),
        .i_prev_n       (ws_snap_prev_n),
        .o_feat_valid   (pp_feat_valid),
        .o_n_div16      (pp_n_div16),
        .o_prev_n_div16 (pp_prev_n_div16),
        .o_pol_bal      (pp_pol_bal),
        .o_dx           (pp_dx),
        .o_dy           (pp_dy),
        .o_dx_rel       (pp_dx_rel),
        .o_dy_rel       (pp_dy_rel),
        .o_busy         (pp_busy),
        .o_cyc_cnt      (pp_cyc_cnt)
    );

    //--------------------------------------------------------------------------
    // golden 向量表（LSB 起：prev_n[17:0], pcy[7:0], pcx[8:0], cy[7:0], cx[8:0],
    //   sy2[39:0], sx2[39:0], sy[24:0], sx[24:0], off[16:0], on[16:0], n[17:0]）
    // EXP（LSB 起）：n_div16, prev_n_div16, pol_bal, dx, dy, dx_rel, dy_rel（int8 补码）
    //--------------------------------------------------------------------------
    reg [233:0] VEC [0:23];
    reg [55:0]  EXP [0:23];
    integer     NV;

    // 检查计数
    integer chk_total = 0;
    integer errors    = 0;
    integer vi;
    integer cyc_meas;
    integer t_snap;
    integer cyc_max;
    reg     busy_hi = 1'b0;
    integer pulse_cnt = 0;
    reg [8*48-1:0] nm;

    // 单调监视：feat_valid 脉冲数、busy 是否升起
    always @(posedge clk_cam) begin
        if (o_feat_valid) pulse_cnt <= pulse_cnt + 1;
        if (o_busy)       busy_hi   <= 1'b1;
    end

    //--------------------------------------------------------------------------
    // 检查任务（ASCII 打印）
    //--------------------------------------------------------------------------
    task chk_pass; input [8*48-1:0] n_in; begin
        chk_total = chk_total + 1;
        $display("CHECK=%0s PASS", n_in);
    end endtask

    task chk_fail; input [8*48-1:0] n_in; begin
        chk_total = chk_total + 1;
        $display("CHECK=%0s FAIL", n_in);
        errors = errors + 1;
    end endtask

    task chk_eq8; input [8*48-1:0] n_in; input [7:0] got; input [7:0] exp; begin
        if (got === exp) chk_pass(n_in);
        else begin
            chk_fail(n_in);
            $display("    [%0s] got=0x%02h (%0d) exp=0x%02h (%0d)", n_in, got, $signed(got), exp, $signed(exp));
        end
    end endtask

    task chk_eq1; input [8*48-1:0] n_in; input got; input exp; begin
        if (got === exp) chk_pass(n_in);
        else begin
            chk_fail(n_in);
            $display("    [%0s] got=%0b exp=%0b", n_in, got, exp);
        end
    end endtask

    task chk_ge; input [8*48-1:0] n_in; input integer got; input integer lo; input integer hi; begin
        if (got >= lo && got <= hi) chk_pass(n_in);
        else begin
            chk_fail(n_in);
            $display("    [%0s] got=%0d exp range [%0d,%0d]", n_in, got, lo, hi);
        end
    end endtask

    task chk_eqi; input [8*48-1:0] n_in; input integer got; input integer exp; begin
        if (got === exp) chk_pass(n_in);
        else begin
            chk_fail(n_in);
            $display("    [%0s] got=%0d exp=%0d", n_in, got, exp);
        end
    end endtask

    //==========================================================================
    // Phase 2：GV_PP 真实窗驱动与对拍
    //   每个 GV_PP 窗 = 一个真实 100 ms 窗（事件已由训练侧按 intwin.py 语义
    //   打包）。本 TB 只做两件事：① 把事件原样喂给 nn_winstat，检查其累加量
    //   （n/on/off/Σx/Σy/Σx²/Σy² 与 TB 侧同一事件集的直接求和一致，用来证明
    //   累加通道位宽足够、接线正确）；② 把 winstat 的窗末快照接进 nn_winfeat，
    //   7 路特征与 GV_PP_FEAT 逐值比较（训练侧 python_row 的权威结果）。
    //   注意：特征值比较不依赖 TB 自算，避免"自己验自己"。
    //==========================================================================
    integer pp_i;
    integer tb_n, tb_on, tb_off;
    integer tb_sx, tb_sy, tb_sx2, tb_sy2;
    integer tb_pcx, tb_pcy, tb_prev_n;
    reg [8:0] pp_ex;
    reg [7:0] pp_ey;
    reg       pp_ep;

    // 一个 GV_PP 窗：喂事件 -> 单拍 win_tick -> 快照/特征对拍
    task pp_win; input integer k; begin
        tb_n = 0; tb_on = 0; tb_off = 0;
        tb_sx = 0; tb_sy = 0; tb_sx2 = 0; tb_sy2 = 0;
        // 解包注意：gen_tb_golden.py 的 pack_msb 是"稠密"右对齐打包（元素 0 在
        // 已用段的最高位），所以元素 i 的位偏移是 (EN-1-i)*W，而不是 (GVEMAX-1-i)*W。
        for (pp_i = 0; pp_i < GV_PP_EN[k]; pp_i = pp_i + 1) begin
            pp_ex = GV_PP_EX[k][(GV_PP_EN[k]-1-pp_i)*9 +: 9];
            pp_ey = GV_PP_EY[k][(GV_PP_EN[k]-1-pp_i)*8 +: 8];
            pp_ep = GV_PP_EP[k][GV_PP_EN[k]-1-pp_i];
            tb_n   = tb_n + 1;
            tb_sx  = tb_sx  + pp_ex;
            tb_sy  = tb_sy  + pp_ey;
            tb_sx2 = tb_sx2 + pp_ex*pp_ex;
            tb_sy2 = tb_sy2 + pp_ey*pp_ey;
            if (pp_ep) tb_on = tb_on + 1; else tb_off = tb_off + 1;
            ws_valid = 1'b1; ws_x = pp_ex; ws_y = pp_ey; ws_pol = pp_ep;
            @(negedge clk_cam);
            ws_valid = 1'b0;
            @(negedge clk_cam);
            ws_valid = 1'b0;
        end
        repeat (40) @(negedge clk_cam);
        ws_tick = 1'b1; @(negedge clk_cam); ws_tick = 1'b0;

        while (ws_snap_valid !== 1'b1) @(negedge clk_cam);

        // ---- ① 累加量（winfeat 输入端）----
        $sformat(nm, "PP%0d_WS_N", k);     chk_eqi(nm, ws_snap_n,    tb_n);
        $sformat(nm, "PP%0d_WS_ON", k);    chk_eqi(nm, ws_snap_on,   tb_on);
        $sformat(nm, "PP%0d_WS_OFF", k);   chk_eqi(nm, ws_snap_off,  tb_off);
        $sformat(nm, "PP%0d_WS_SX", k);    chk_eqi(nm, ws_snap_sx,   tb_sx);
        $sformat(nm, "PP%0d_WS_SY", k);    chk_eqi(nm, ws_snap_sy,   tb_sy);
        $sformat(nm, "PP%0d_WS_SX2", k);   chk_eqi(nm, ws_snap_sx2,  tb_sx2);
        $sformat(nm, "PP%0d_WS_SY2", k);   chk_eqi(nm, ws_snap_sy2,  tb_sy2);
        // ---- carry 语义：pcx/pcy = 上一窗质心（首窗 200/120），prev_n = 上一窗 n ----
        $sformat(nm, "PP%0d_WS_PCX", k);    chk_eqi(nm, ws_snap_pcx,    tb_pcx);
        $sformat(nm, "PP%0d_WS_PCY", k);    chk_eqi(nm, ws_snap_pcy,    tb_pcy);
        $sformat(nm, "PP%0d_WS_PREV_N", k); chk_eqi(nm, ws_snap_prev_n, tb_prev_n);
        if (tb_n != 0) begin
            $sformat(nm, "PP%0d_WS_CX", k); chk_eqi(nm, ws_snap_cx, tb_sx / tb_n);
            $sformat(nm, "PP%0d_WS_CY", k); chk_eqi(nm, ws_snap_cy, tb_sy / tb_n);
            tb_pcx = tb_sx / tb_n;
            tb_pcy = tb_sy / tb_n;
        end else begin
            $sformat(nm, "PP%0d_WS_CX_HOLD", k); chk_eqi(nm, ws_snap_cx, tb_pcx);
            $sformat(nm, "PP%0d_WS_CY_HOLD", k); chk_eqi(nm, ws_snap_cy, tb_pcy);
        end
        tb_prev_n = tb_n;

        // ---- ② 7 路特征（GV_PP_FEAT 大端：elem0 = [55:48] = n_div16）----
        while (pp_feat_valid !== 1'b1) @(negedge clk_cam);
        $sformat(nm, "PP%0d_NDIV16", k);      chk_eq8(nm, pp_n_div16,      GV_PP_FEAT[k][55:48]);
        $sformat(nm, "PP%0d_PREV_NDIV16", k); chk_eq8(nm, pp_prev_n_div16, GV_PP_FEAT[k][47:40]);
        $sformat(nm, "PP%0d_POL_BAL", k);     chk_eq8(nm, pp_pol_bal,      GV_PP_FEAT[k][39:32]);
        $sformat(nm, "PP%0d_DX", k);          chk_eq8(nm, pp_dx,           GV_PP_FEAT[k][31:24]);
        $sformat(nm, "PP%0d_DY", k);          chk_eq8(nm, pp_dy,           GV_PP_FEAT[k][23:16]);
        $sformat(nm, "PP%0d_DX_REL", k);      chk_eq8(nm, pp_dx_rel,       GV_PP_FEAT[k][15:8]);
        $sformat(nm, "PP%0d_DY_REL", k);      chk_eq8(nm, pp_dy_rel,       GV_PP_FEAT[k][7:0]);
        $display("INFO PPDBG%0d rtl n=%0d on=%0d off=%0d sx=%0d sy=%0d sx2=%0d sy2=%0d cx=%0d cy=%0d pcx=%0d pcy=%0d pn=%0d",
                 k, ws_snap_n, ws_snap_on, ws_snap_off, ws_snap_sx, ws_snap_sy,
                 ws_snap_sx2, ws_snap_sy2, ws_snap_cx, ws_snap_cy, ws_snap_pcx, ws_snap_pcy, ws_snap_prev_n);
        $display("INFO PPDBG%0d tb  n=%0d on=%0d off=%0d sx=%0d sy=%0d sx2=%0d sy2=%0d",
                 k, tb_n, tb_on, tb_off, tb_sx, tb_sy, tb_sx2, tb_sy2);
        $display("INFO PP%0d n=%0d feat=%02h_%02h_%02h_%02h_%02h_%02h_%02h cyc=%0d",
                 k, tb_n, pp_n_div16, pp_prev_n_div16, pp_pol_bal, pp_dx, pp_dy,
                 pp_dx_rel, pp_dy_rel, pp_cyc_cnt);

        while (pp_busy !== 1'b0) @(negedge clk_cam);
        repeat (4) @(negedge clk_cam);
    end endtask

    // 每个 GV_PP case 前复位（pcx/pcy=200/120、prev_n=0 的 carry 初值）
    task pp_case_start; begin
        rst_n_cam = 1'b0;
        repeat (6) @(negedge clk_cam);
        rst_n_cam = 1'b1;
        repeat (6) @(negedge clk_cam);
        tb_pcx = 200; tb_pcy = 120; tb_prev_n = 0;
    end endtask

    // 快照驱动（从 VEC 解包）
    task drive_vec; input integer idx; begin
        i_prev_n = VEC[idx][17:0];
        i_pcy    = VEC[idx][25:18];
        i_pcx    = VEC[idx][34:26];
        i_cy     = VEC[idx][42:35];
        i_cx     = VEC[idx][51:43];
        i_sy2    = VEC[idx][91:52];
        i_sx2    = VEC[idx][131:92];
        i_sy     = VEC[idx][156:132];
        i_sx     = VEC[idx][181:157];
        i_off    = VEC[idx][198:182];
        i_on     = VEC[idx][215:199];
        i_n      = VEC[idx][233:216];
    end endtask

    function nox8; input [7:0] v; begin nox8 = ((^v) === 1'bx) ? 1'b0 : 1'b1; end endfunction

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    initial begin
        // ---- golden 向量（由 build/gen_winfeat_golden.py 生成，勿手改）----
    VEC[ 0] = 234'h000000000000000000000000000000000000000000000643c321e00000; EXP[ 0] = 56'h00000000000000;  // V0_empty
    VEC[ 1] = 234'h00010000800000001900000780000009c400000003840643c321e00000; EXP[ 1] = 56'h000000007f0000;  // V1_single
    VEC[ 2] = 234'h000200008000400031e0000ef0000026de1000000df2163bbb21e00001; EXP[ 2] = 56'hffffffff000000;  // V2_corners
    VEC[ 3] = 234'h000c0003800140009b80002c6000001fe32000000a5fe339db1ddc0002; EXP[ 3] = 56'h8181e2e8150000;  // V3_rect
    VEC[ 4] = 234'h001e00078003c003ba400150600001e006200000eebc27f5999cec000c; EXP[ 4] = 56'h7f7f3c25000001;  // V4_gauss
    VEC[ 5] = 234'h0fa003da81fac1881e407424d000cb83cd40004854bab643b3facc001e; EXP[ 5] = 56'hd3d8e1f2ff017f;  // V5_dense4000
    VEC[ 6] = 234'h00020000800040000000000f000000000000000007080003c321d80fa0; EXP[ 6] = 56'h108101ce007f00;  // V6_dxclipneg
    VEC[ 7] = 234'h000200010000000063c0000f0000004dbc20000007080c7bc001e00002; EXP[ 7] = 56'h007f00637f0000;  // V7_dxclippos
    VEC[ 8] = 234'h00040001000080004b00002580000015f920000015f924b4b63de00002; EXP[ 8] = 56'h7f810fc1000000;  // V8_tinyvar
    VEC[ 9] = 234'h0009000280010001b5e00085d000014cf5d000007c59bc2f6a5a580004; EXP[ 9] = 56'h7f7f2b3b0e0000;  // V9_edge
    VEC[10] = 234'h00320000000c80044b4001329000020c16200000b148557b1617b40009; EXP[10] = 56'h9881baca810003;  // V10_alloff
    VEC[11] = 234'h0032001900000004c4e001b1e000027c08d0000122e1661c52bd880032; EXP[11] = 56'h1d0e14057f0303;  // V11_allon
    VEC[12] = 234'h000300010000400031e0000ef0000026de1000000df2142a7b0e280032; EXP[12] = 56'he5e4e2f02a0300;  // V12_far3
    VEC[13] = 234'h00c8003500178014d140061730000b5de1e00003e807f6abe2153c0003; EXP[13] = 56'h2038161407000c;  // V13_u200
    VEC[14] = 234'h000700020000c000066000033000000017b000000017b0383b55f000c8; EXP[14] = 56'h8181c5cc120c00;  // V14_cluster7
    VEC[15] = 234'h04b001270098807765a0225bf0003ebd4b70001516edd65ba81c1c0007; EXP[15] = 56'h507f3731fe004b;  // V15_u1200
    VEC[16] = 234'h138804d5027781eeef2092aea00102bce570005b5033e653c32dd404b0; EXP[16] = 56'h02ff01ffff4b7f;  // V16_u5000
    VEC[17] = 234'h000500018000800063c000256000004dbc2000001f6824fbbb29e01388; EXP[17] = 56'hffecfff5197f00;  // V17_altern
        NV = 18;

        // ---- 复位 ----
        repeat (10) @(negedge clk_cam);
        rst_n_cam = 1'b1;
        repeat (5) @(negedge clk_cam);

        chk_eq1("R1_RESET_FEAT_VALID_LOW", o_feat_valid, 1'b0);
        chk_eq1("R2_RESET_BUSY_LOW",       o_busy,       1'b0);
        chk_eq1("R3_RESET_ALL_ZERO",
                (o_n_div16 | o_prev_n_div16 | o_pol_bal | o_dx | o_dy | o_dx_rel | o_dy_rel) === 8'h00,
                1'b1);
        chk_eq1("R4_RESET_NO_X",
                nox8(o_n_div16) & nox8(o_prev_n_div16) & nox8(o_pol_bal) &
                nox8(o_dx) & nox8(o_dy) & nox8(o_dx_rel) & nox8(o_dy_rel), 1'b1);
        repeat (100) @(negedge clk_cam);
        chk_eq1("R5_RESET_NO_SPURIOUS_VALID", (pulse_cnt == 0), 1'b1);

        cyc_max = 0;

        // ---- 逐向量 ----
        for (vi = 0; vi < NV; vi = vi + 1) begin
            drive_vec(vi);
            pulse_cnt = 0;
            busy_hi   = 1'b0;
            @(negedge clk_cam);
            i_snap_valid = 1'b1;
            t_snap = $time;
            @(negedge clk_cam);
            i_snap_valid = 1'b0;

            while (o_feat_valid !== 1'b1) @(negedge clk_cam);
            cyc_meas = ($time - t_snap) / 20;   // clk_cam 周期 20 ns

            $sformat(nm, "W%0d_NDIV16", vi);      chk_eq8(nm, o_n_div16,      EXP[vi][7:0]);
            $sformat(nm, "W%0d_PREV_NDIV16", vi); chk_eq8(nm, o_prev_n_div16, EXP[vi][15:8]);
            $sformat(nm, "W%0d_POL_BAL", vi);     chk_eq8(nm, o_pol_bal,      EXP[vi][23:16]);
            $sformat(nm, "W%0d_DX", vi);          chk_eq8(nm, o_dx,           EXP[vi][31:24]);
            $sformat(nm, "W%0d_DY", vi);          chk_eq8(nm, o_dy,           EXP[vi][39:32]);
            $sformat(nm, "W%0d_DX_REL", vi);      chk_eq8(nm, o_dx_rel,       EXP[vi][47:40]);
            $sformat(nm, "W%0d_DY_REL", vi);      chk_eq8(nm, o_dy_rel,       EXP[vi][55:48]);

            $sformat(nm, "W%0d_OUT_NO_X", vi);
            chk_eq1(nm, nox8(o_n_div16) & nox8(o_prev_n_div16) & nox8(o_pol_bal) &
                         nox8(o_dx) & nox8(o_dy) & nox8(o_dx_rel) & nox8(o_dy_rel), 1'b1);

            $sformat(nm, "W%0d_BUSY_RISE", vi);   chk_eq1(nm, busy_hi, 1'b1);

            if (VEC[vi][233:216] == 18'd0) begin
                // 空窗：n=0 短路，不启动除法/开方 ⇒ 极短
                $sformat(nm, "W%0d_EMPTY_FAST", vi);
                chk_ge(nm, cyc_meas, 2, 12);
            end else begin
                $sformat(nm, "W%0d_CYC_RANGE", vi);
                chk_ge(nm, cyc_meas, 380, 760);
                if (cyc_meas > cyc_max) cyc_max = cyc_meas;
            end
            $sformat(nm, "W%0d_CYCCNT_TRACK", vi);
            chk_ge(nm, (cyc_meas - o_cyc_cnt), -4, 8);
            $display("INFO W%0d cyc_meas=%0d o_cyc_cnt=%0d", vi, cyc_meas, o_cyc_cnt);

            // 脉冲唯一 + 回到空闲（留足时间抓重复 valid）
            repeat (500) @(negedge clk_cam);
            $sformat(nm, "W%0d_ONE_PULSE", vi);   chk_ge(nm, pulse_cnt, 1, 1);
            $sformat(nm, "W%0d_IDLE_AFTER", vi);  chk_eq1(nm, o_busy, 1'b0);
        end

        //======================================================================
        // Phase 2：GV_PP 真实窗（pp01..pp03 各 2 窗、pp04..pp06 各 1 窗 = 9 窗）
        //   case 组之间复位，保证每组的首窗 pcx/pcy=200/120、prev_n=0。
        //   组的划分来自训练侧 golden_vectors.json 的 case 结构（同一 case 内
        //   窗口连续，跨 case 不连续）。
        //======================================================================
        pp_case_start;
        pp_win(0); pp_win(1);           // pp01
        pp_case_start;
        pp_win(2); pp_win(3);           // pp02（其中 pp02_w1 为空窗 n=0）
        pp_case_start;
        pp_win(4); pp_win(5);           // pp03
        pp_case_start;
        pp_win(6);                      // pp04
        pp_case_start;
        pp_win(7);                      // pp05
        pp_case_start;
        pp_win(8);                      // pp06

        $display("INFO_GVP=%0d INFO_PP_CHECKS=done", GVP);
        $display("INFO_CHECK_TOTAL=%0d", chk_total);
        $display("INFO_CYC_MAX=%0d", cyc_max);
        $display("INFO_ERRORS=%0d", errors);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

    // 超时保护（10 ms 仿真时间）
    initial begin
        #10_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end
endmodule
