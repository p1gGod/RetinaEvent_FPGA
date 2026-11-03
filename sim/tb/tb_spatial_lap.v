//==============================================================================
// tb_spatial_lap -- spatial_lap 单模块仿真（L2 事件引擎）
// 判据（文档 §8）：
//   V1  阶梯边缘输入 ⇒ 边缘处响应非零
//   V2  均匀场输入 ⇒ 内部响应恒为 0
//   V3  与参考模型逐点一致（含边界规则）—— TB 侧黄金模型逐点对拍
//   V5  边界行/列与参考模型一致（EDGE_MODE=0 补 0 / =1 复制 各测一遍）
//
// ★ 关键：**输入 de 必须是稀疏的**（模拟 vps_resample 的 x 方向 2 抽 1：
//   有效行内隔一拍才 1 个有效像素），并且再测一遍**不规则间隔**。
//   用连续 de 是测不出"消隐清零列计数"这个集成 bug 的（实测漏过一轮）。
//   反例验证：把 RTL 列计数改回"i_de 为低就清零"，本 TB 必须 FAIL。
//
// ── R3 判据（Lead 裁决，2026-10-03；坐标必须"随流走"）──────────────────
//   S1_vsync_passthrough   每帧必须恰好 1 个 o_vsync 脉冲（反例：把 vs_d 放回
//                          if(de2) 里 ⇒ 消隐期 vsync 丢失 ⇒ 0 脉冲 ⇒ FAIL）
//   S2_xy_center_correct   逐点断言 o_x/o_y == 窗口中心 (ecx,ecy)、o_dl_c == 中心像素 ΔL
//   S2b_impulse_position   3×3 冲击：中心点输出必须正好落在 (IMP_X,IMP_Y)、
//                          四邻域响应 == −10（= (0−40)>>2）
//   S3_xy_frame_invariant  **连续 5 帧**同一像素位置必须映射到同一 (x,y)（漂移 = 不合格）
//
// 窗口中心映射（与 RTL 一致）：第 k 个输出（k 从 0 起）的中心
//   cy = k/(IMG_W−1)，cx = k%(IMG_W−1)     —— 每行第一个像素被抑制（抽头跨行）
//   输出总数 = (IMG_W−1)×(IMG_H−1)
//   邻域有效性：u 需 cy≥1；l 需 cx≥1；r 需 cx≤IMG_W−2；d 恒有效
//   越界抽头：EDGE_MODE=0 → 0；EDGE_MODE=1 → 复制中心值 c
//==============================================================================
`timescale 1ns / 1ps

module tb_spatial_lap;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam IW = 16;
    localparam IH = 8;
    localparam NP = IW*IH;              // 128 个输入像素
    localparam NO = (IW-1)*(IH-1);      // 105 个输出
    localparam IMP_X = 5;               // R3 冲击列
    localparam IMP_Y = 3;               // R3 冲击行
    localparam IMP_V = 40;              // 冲击幅度 ⇒ 中心 lap = (4*40)>>2 = 40

    reg        rst_n   = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_de    = 1'b0;
    reg [8:0]  i_dl    = 9'd0;

    wire        o_vs0, o_vs1;
    wire        o_de0, o_de1;
    wire [11:0] o_lap0, o_lap1;
    wire [8:0]  o_x0,  o_x1;
    wire [7:0]  o_y0,  o_y1;
    wire [8:0]  o_dlc0, o_dlc1;

    spatial_lap #(.IMG_W(IW), .CENTER_GAIN(4), .NORM_SHIFT(2), .EDGE_MODE(0)) u_e0 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(i_vsync), .i_de(i_de), .i_dl(i_dl),
        .o_vsync(o_vs0), .o_de(o_de0), .o_lap(o_lap0),
        .o_x(o_x0), .o_y(o_y0), .o_dl_c(o_dlc0)
    );

    spatial_lap #(.IMG_W(IW), .CENTER_GAIN(4), .NORM_SHIFT(2), .EDGE_MODE(1)) u_e1 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(i_vsync), .i_de(i_de), .i_dl(i_dl),
        .o_vsync(o_vs1), .o_de(o_de1), .o_lap(o_lap1),
        .o_x(o_x1), .o_y(o_y1), .o_dl_c(o_dlc1)
    );

    //--- 黄金模型 -----------------------------------------------------------
    integer img [0:NP-1];

    function [11:0] ref_lap;
        input integer cy;
        input integer cx;
        input integer em;           // 0 = 补 0；1 = 复制
        integer ic, iu, idd, il, ir;
        begin
            ic  = img[cy*IW + cx];
            iu  = (cy >= 1)      ? img[(cy-1)*IW + cx] : ((em != 0) ? ic : 0);
            idd = (cy+1 <= IH-1) ? img[(cy+1)*IW + cx] : ((em != 0) ? ic : 0);
            il  = (cx >= 1)      ? img[cy*IW + cx - 1] : ((em != 0) ? ic : 0);
            ir  = (cx+1 <= IW-1) ? img[cy*IW + cx + 1] : ((em != 0) ? ic : 0);
            ref_lap = (4*ic - (iu + idd + il + ir)) >>> 2;
        end
    endfunction

    integer j, x, y, v, g, gap;
    integer k, ecy, ecx;
    integer bad0, bad1, bad_de, got_de;
    reg [11:0] exp0, exp1;

    //--- R3 统计量 ----------------------------------------------------------
    integer bad_xy, bad_dlc, bad_inv, bad_vs;
    integer vs_cnt, frame_no, fi;
    integer imp_seen, imp_bad, nb_bad, nb_seen;
    integer xy_seq [0:NO-1];        // 帧 1 的坐标序列（(x<<8)|y）

    // 逐拍检查（每个 negedge 调用一次）
    task check_out;
        begin
            if (o_vs0 === 1'b1) vs_cnt = vs_cnt + 1;       // S1
            if (o_de0 !== o_de1) bad_de = bad_de + 1;      // 两实例 de 必须一致
            if (o_de0 === 1'b1) begin
                got_de = got_de + 1;
                if (k < NO) begin
                    ecy = k / (IW-1);
                    ecx = k % (IW-1);
                    exp0 = ref_lap(ecy, ecx, 0);
                    exp1 = ref_lap(ecy, ecx, 1);
                    if ($signed(o_lap0) !== $signed(exp0)) begin
                        bad0 = bad0 + 1;
                        if (bad0 <= 3) $display("      E0 k=%0d cy=%0d cx=%0d got=%0d exp=%0d",
                                                k, ecy, ecx, $signed(o_lap0), $signed(exp0));
                    end
                    if ($signed(o_lap1) !== $signed(exp1)) begin
                        bad1 = bad1 + 1;
                        if (bad1 <= 3) $display("      E1 k=%0d cy=%0d cx=%0d got=%0d exp=%0d",
                                                k, ecy, ecx, $signed(o_lap1), $signed(exp1));
                    end
                    // ---- R3：坐标 / 中心 ΔL 必须逐点等于期望 ----
                    if (o_x0 !== ecx) begin
                        bad_xy = bad_xy + 1;
                        if (bad_xy <= 3) $display("      XY k=%0d got_x=%0d exp_x=%0d", k, o_x0, ecx);
                    end
                    if (o_y0 !== ecy) begin
                        bad_xy = bad_xy + 1;
                        if (bad_xy <= 3) $display("      XY k=%0d got_y=%0d exp_y=%0d", k, o_y0, ecy);
                    end
                    if ($signed(o_dlc0) !== img[ecy*IW + ecx]) begin
                        bad_dlc = bad_dlc + 1;
                        if (bad_dlc <= 3) $display("      DLC k=%0d got=%0d exp=%0d",
                                                   k, $signed(o_dlc0), img[ecy*IW+ecx]);
                    end
                    // ---- R3：帧不变性（同一 k 的坐标必须与帧 1 完全一致）----
                    if (frame_no == 1) xy_seq[k] = (o_x0 << 8) | o_y0;
                    else if (xy_seq[k] !== ((o_x0 << 8) | o_y0)) begin
                        bad_inv = bad_inv + 1;
                        if (bad_inv <= 3) $display("      INV k=%0d frm=%0d seq=%0d got=%0d",
                                                   k, frame_no, xy_seq[k], (o_x0 << 8) | o_y0);
                    end
                    // ---- R3：冲击点必须落在已知位置 ----
                    if (frame_no >= 1) begin
                        if (o_x0 == IMP_X && o_y0 == IMP_Y) begin
                            imp_seen = imp_seen + 1;
                            if ($signed(o_lap0) !== 12'sd40) begin
                                imp_bad = imp_bad + 1;
                                if (imp_bad <= 3) $display("      IMP lap=%0d (expect 40)", $signed(o_lap0));
                            end
                        end
                        if (((o_x0 == IMP_X-1) || (o_x0 == IMP_X+1)) && (o_y0 == IMP_Y) ||
                            ((o_y0 == IMP_Y-1) || (o_y0 == IMP_Y+1)) && (o_x0 == IMP_X)) begin
                            nb_seen = nb_seen + 1;
                            if ($signed(o_lap0) !== -12'sd10) begin
                                nb_bad = nb_bad + 1;
                                if (nb_bad <= 3) $display("      NB lap=%0d (expect -10)", $signed(o_lap0));
                            end
                        end
                    end
                end
                k = k + 1;
            end
        end
    endtask

    // 跑一帧：mode 0 = 伪随机、1 = 均匀场、2 = 阶梯边缘、3 = 3×3 冲击
    //         irregular = 0 → 稀疏 de（每 2 拍 1 个）；1 → 不规则间隔
    task run_frame;
        input integer mode;
        input integer irregular;
        integer p;
        begin
            for (y = 0; y < IH; y = y + 1) begin
                for (x = 0; x < IW; x = x + 1) begin
                    if (mode == 0)      v = ((x*7 + y*13) & 63) - 32;
                    else if (mode == 1) v = 5;
                    else if (mode == 2) v = (x >= 8) ? 40 : -40;
                    else                v = 0;                       // mode 3：先全 0
                    img[y*IW + x] = v;
                end
            end
            if (mode == 3) img[IMP_Y*IW + IMP_X] = IMP_V;            // 3×3 冲击（单点）

            @(negedge clk);
            i_vsync = 1'b1; i_de = 1'b0;
            @(negedge clk);
            i_vsync = 1'b0;

            k = 0; got_de = 0;

            for (p = 0; p < NP; p = p + 1) begin
                // 1 拍有效像素
                @(negedge clk);
                i_de = 1'b1;
                i_dl = img[p];
                check_out;
                // gap 拍空拍（稀疏/不规则）
                gap = irregular ? ((p % 4) + 1) : 1;
                for (g = 0; g < gap; g = g + 1) begin
                    @(negedge clk);
                    i_de = 1'b0;
                    check_out;
                end
            end
            // 收尾：让最后几个输出出来
            repeat (6) begin
                @(negedge clk);
                i_de = 1'b0;
                check_out;
            end
        end
    endtask

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        bad0 = 0; bad1 = 0; bad_de = 0;
        bad_xy = 0; bad_dlc = 0; bad_inv = 0; bad_vs = 0;
        imp_seen = 0; imp_bad = 0; nb_bad = 0; nb_seen = 0;
        frame_no = 0;

        //======================================================================
        // 帧 1：伪随机图像 + **稀疏 de**（每 2 拍 1 个有效像素）
        //   ⇒ 覆盖 V3/V5 与"de 稀疏时 o_de 必须出现"（消隐清零 bug 的证伪点）
        //======================================================================
        frame_no = 1;
        vs_cnt = 0;
        run_frame(0, 0);
        if (got_de == NO) chk_pass("P1_sparse_de_out_count"); else begin
            chk_fail("P1_sparse_de_out_count");
            $display("      got %0d (expect %0d)", got_de, NO);
        end
        if (bad0 == 0) chk_pass("V3_golden_edgemode0"); else begin
            chk_fail("V3_golden_edgemode0");
            $display("      mismatches = %0d", bad0);
        end
        if (bad1 == 0) chk_pass("V5_golden_edgemode1"); else begin
            chk_fail("V5_golden_edgemode1");
            $display("      mismatches = %0d", bad1);
        end
        if (bad_de == 0) chk_pass("P2_both_inst_de_equal"); else chk_fail("P2_both_inst_de_equal");
        if (bad_xy == 0) chk_pass("S2_xy_center_correct"); else begin
            chk_fail("S2_xy_center_correct");
            $display("      bad (x,y) = %0d", bad_xy);
        end
        if (bad_dlc == 0) chk_pass("S2c_dl_center_correct"); else begin
            chk_fail("S2c_dl_center_correct");
            $display("      bad center dL = %0d", bad_dlc);
        end
        if (vs_cnt == 1) chk_pass("S1_vsync_passthrough"); else begin
            chk_fail("S1_vsync_passthrough");
            $display("      o_vsync pulses = %0d (expect 1)", vs_cnt);
        end

        //======================================================================
        // 帧 2：同样的图像 + **不规则 de 间隔**（1~4 拍随机间隔）
        //   ⇒ 证明列抽头按 de 推进（de-gated）而非按拍推进
        //======================================================================
        bad0 = 0; bad1 = 0; bad_de = 0;
        bad_xy = 0; bad_dlc = 0; bad_inv = 0; bad_vs = 0;
        frame_no = 2; vs_cnt = 0;
        run_frame(0, 1);
        if (got_de == NO) chk_pass("P3_irregular_de_out_count"); else begin
            chk_fail("P3_irregular_de_out_count");
            $display("      got %0d (expect %0d)", got_de, NO);
        end
        if (bad0 == 0 && bad1 == 0) chk_pass("P3_irregular_de_golden");
        else begin
            chk_fail("P3_irregular_de_golden");
            $display("      mismatches E0=%0d E1=%0d", bad0, bad1);
        end
        if (bad_xy == 0 && bad_dlc == 0) chk_pass("P3_irregular_xy_golden");
        else begin
            chk_fail("P3_irregular_xy_golden");
            $display("      bad xy=%0d dlc=%0d", bad_xy, bad_dlc);
        end

        //======================================================================
        // 帧 3：均匀场 → V2 内部响应恒 0（黄金模型同样）
        //======================================================================
        bad0 = 0; bad1 = 0; bad_de = 0; bad_xy = 0; bad_dlc = 0;
        frame_no = 3; vs_cnt = 0;
        run_frame(1, 0);
        if (bad0 == 0 && bad1 == 0) chk_pass("V2_uniform_zero");
        else begin
            chk_fail("V2_uniform_zero");
            $display("      mismatches E0=%0d E1=%0d", bad0, bad1);
        end

        //======================================================================
        // 帧 4：阶梯边缘（左 −40 / 右 +40）→ V1 平坦区为 0、边缘处非零
        //======================================================================
        bad0 = 0; bad1 = 0; bad_de = 0; bad_xy = 0; bad_dlc = 0;
        frame_no = 4; vs_cnt = 0;
        run_frame(2, 0);
        if (bad0 == 0) chk_pass("V1_step_edge_golden"); else begin
            chk_fail("V1_step_edge_golden");
            $display("      mismatches = %0d", bad0);
        end
        if (ref_lap(3, 2, 0) == 12'sd0) chk_pass("V1_flat_region_zero");
        else                            chk_fail("V1_flat_region_zero");
        if (ref_lap(3, 7, 0) != 12'sd0 && ref_lap(3, 8, 0) != 12'sd0)
            chk_pass("V1_edge_region_nonzero");
        else
            chk_fail("V1_edge_region_nonzero");

        //======================================================================
        // R3 主判据：3×3 冲击图 **连续 5 帧**（帧不变性 + 已知位置）
        //   · 帧 1 记录坐标序列，帧 2~5 必须逐点一致（漂移 = FAIL）
        //   · 冲击点 (IMP_X,IMP_Y) 每帧必须出现 1 次、lap == 40、四邻域 == −10
        //   · 每帧必须恰好 1 个 o_vsync（S1 反例点）
        //======================================================================
        bad_inv = 0; imp_seen = 0; imp_bad = 0; nb_seen = 0; nb_bad = 0; bad_vs = 0;
        for (fi = 1; fi <= 5; fi = fi + 1) begin
            bad0 = 0; bad1 = 0; bad_de = 0; bad_xy = 0; bad_dlc = 0;
            frame_no = fi; vs_cnt = 0;
            run_frame(3, 0);
            if (vs_cnt != 1) bad_vs = bad_vs + 1;
            if (bad_xy != 0 || bad_dlc != 0) begin
                $display("      R3 frame %0d: bad_xy=%0d bad_dlc=%0d", fi, bad_xy, bad_dlc);
                bad_vs = bad_vs + 1;
            end
        end
        if (bad_inv == 0) chk_pass("S3_xy_frame_invariant"); else begin
            chk_fail("S3_xy_frame_invariant");
            $display("      drifted positions = %0d", bad_inv);
        end
        if (imp_seen == 5 && imp_bad == 0) chk_pass("S2b_impulse_position"); else begin
            chk_fail("S2b_impulse_position");
            $display("      impulse seen=%0d (expect 5) bad=%0d", imp_seen, imp_bad);
        end
        if (nb_seen == 20 && nb_bad == 0) chk_pass("S2d_impulse_neighbors"); else begin
            chk_fail("S2d_impulse_neighbors");
            $display("      neighbors seen=%0d (expect 20) bad=%0d", nb_seen, nb_bad);
        end
        if (bad_vs == 0) chk_pass("S1_vsync_5frames"); else begin
            chk_fail("S1_vsync_5frames");
            $display("      bad frames (vsync/xy) = %0d", bad_vs);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #500000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
