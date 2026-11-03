//==============================================================================
// tb_event_gen -- event_gen 单模块仿真（L2 事件引擎，P0 判决级）
// 判据（文档 §8）：
//   V1  lap = +θ → 1 个 ON；lap = θ−1 → 无事件
//   V2  lap = −θ（及更负）→ 1 个 OFF
//   V3  |ΔL| < MIN_DL 时即使 lap 超阈值也不出事件
//   V5  事件坐标与像素位置一致（无行列错位）—— **输入 de 稀疏**（模拟 resample 输出）
//   V6  阈值三档切换后事件率单调变化（灵敏 > 默认 > 迟钝）
//   （补）阈值/守卫端口优先、端口为 0 回落参数；POL_ON_IS_1=0 时极性取反
//
// ── R3 判据（Lead 裁决，2026-10-03）──────────────────────────────────────
//   R3_coord_follows_stream  输入什么 (i_x,i_y) 就上报什么 —— **故意用非光栅序列**
//                            （旧实现"自己数 de 脉冲"绝无可能复现该序列 ⇒ 必 FAIL）
//   R3_absolute_coord        直接喂 (300,200)（远超旧 EV_W=16 的回绕范围）⇒ 必须原样上报
//   R3_frame_invariant       同一坐标序列连跑 **5 帧** ⇒ 上报序列逐点一致（漂移 = 不合格）
//   R3_guard_uses_center_dl  守卫用的 i_dl_c 就是窗口中心像素的 ΔL（由 spatial_lap 给出，
//                            本模块不再猜延迟）—— 用"dl_c 小 ⇒ 不出事件"验证
//==============================================================================
`timescale 1ns / 1ps

module tb_event_gen;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam EW = 16;     // 小几何，便于逐点核对坐标
    localparam EH = 8;
    localparam NP = EW*EH;  // 128 像素

    reg        rst_n   = 1'b0;
    reg        i_de    = 1'b0;
    reg [11:0] i_lap   = 12'sd0;
    reg [8:0]  i_dl_c  = 9'd0;
    reg [8:0]  i_x     = 9'd0;
    reg [7:0]  i_y     = 8'd0;
    reg [11:0] i_theta = 12'd0;
    reg [8:0]  i_min   = 9'd0;

    wire       m_valid, p_valid;
    wire [8:0] m_x, p_x;
    wire [7:0] m_y, p_y;
    wire       m_pol, p_pol;

    // 主实例（默认阈值/守卫/极性）
    event_gen #(.THETA_ON(74), .THETA_OFF(74), .MIN_DL(2), .POL_ON_IS_1(1)) u_main (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(i_de),
        .i_lap(i_lap), .i_dl_c(i_dl_c), .i_x(i_x), .i_y(i_y),
        .i_theta(i_theta), .i_min_dl(i_min),
        .o_ev_valid(m_valid), .o_ev_x(m_x), .o_ev_y(m_y), .o_ev_pol(m_pol)
    );

    // 极性约定实例（ON 编码为 0）
    event_gen #(.THETA_ON(74), .THETA_OFF(74), .MIN_DL(2), .POL_ON_IS_1(0)) u_pol (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(i_de),
        .i_lap(i_lap), .i_dl_c(i_dl_c), .i_x(i_x), .i_y(i_y),
        .i_theta(i_theta), .i_min_dl(i_min),
        .o_ev_valid(p_valid), .o_ev_x(p_x), .o_ev_y(p_y), .o_ev_pol(p_pol)
    );

    // V6：三档阈值（灵敏 44 / 默认 74 / 迟钝 129）
    wire       a_valid, b_valid, c_valid;
    wire [8:0] a_x, b_x, c_x;
    wire [7:0] a_y, b_y, c_y;
    wire       a_pol, b_pol, c_pol;

    event_gen #(.THETA_ON(44),  .THETA_OFF(44),  .MIN_DL(2)) u_a (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(i_de),
        .i_lap(i_lap), .i_dl_c(i_dl_c), .i_x(i_x), .i_y(i_y),
        .i_theta(i_theta), .i_min_dl(i_min),
        .o_ev_valid(a_valid), .o_ev_x(a_x), .o_ev_y(a_y), .o_ev_pol(a_pol));

    event_gen #(.THETA_ON(74),  .THETA_OFF(74),  .MIN_DL(2)) u_b (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(i_de),
        .i_lap(i_lap), .i_dl_c(i_dl_c), .i_x(i_x), .i_y(i_y),
        .i_theta(i_theta), .i_min_dl(i_min),
        .o_ev_valid(b_valid), .o_ev_x(b_x), .o_ev_y(b_y), .o_ev_pol(b_pol));

    event_gen #(.THETA_ON(129), .THETA_OFF(129), .MIN_DL(2)) u_c (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(i_de),
        .i_lap(i_lap), .i_dl_c(i_dl_c), .i_x(i_x), .i_y(i_y),
        .i_theta(i_theta), .i_min_dl(i_min),
        .o_ev_valid(c_valid), .o_ev_x(c_x), .o_ev_y(c_y), .o_ev_pol(c_pol));

    integer cnt_a = 0, cnt_b = 0, cnt_c = 0;
    always @(posedge clk) begin
        if (a_valid) cnt_a <= cnt_a + 1;
        if (b_valid) cnt_b <= cnt_b + 1;
        if (c_valid) cnt_c <= cnt_c + 1;
    end

    integer p, bad_xy, got_ev, r, fi, px, py, bad_inv;
    integer lap_seq [0:6];
    integer xy_seq [0:NP-1];

    // 单像素判决
    task one_px;
        input [11:0] lap;
        input [8:0]  dl;
        input [11:0] th;
        input [8:0]  md;
        input        exp_v;
        input        exp_p;
        input [8*40-1:0] nm;
        begin
            @(negedge clk);
            i_de = 1'b1; i_lap = lap; i_dl_c = dl; i_theta = th; i_min = md;
            i_x = 9'd7; i_y = 8'd3;
            @(negedge clk);
            i_de = 1'b0;
            if (m_valid !== exp_v) chk_fail(nm);
            else if (exp_v && (m_pol !== exp_p)) chk_fail(nm);
            else chk_pass(nm);
            @(negedge clk);
        end
    endtask

    initial begin
        lap_seq[0] = 60;  lap_seq[1] = 100; lap_seq[2] = 200; lap_seq[3] = 30;
        lap_seq[4] = -60; lap_seq[5] = -100; lap_seq[6] = -200;

        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        //======================================================================
        // V1/V2：阈值边界（端口 = 0 ⇒ 回落参数 74；守卫端口 = 0 ⇒ 回落 2）
        //======================================================================
        one_px(12'sd74,  9'd10, 12'd0, 9'd0, 1'b1, 1'b1, "V1_lap_eq_theta_on");
        one_px(12'sd73,  9'd10, 12'd0, 9'd0, 1'b0, 1'b0, "V1_lap_below_theta");
        one_px(12'sd75,  9'd10, 12'd0, 9'd0, 1'b1, 1'b1, "V1_lap_above_theta");
        one_px(12'sd0,   9'd10, 12'd0, 9'd0, 1'b0, 1'b0, "V1_lap_zero");
        one_px(-12'sd74, 9'd10, 12'd0, 9'd0, 1'b1, 1'b0, "V2_lap_eq_minus_theta_off");
        one_px(-12'sd75, 9'd10, 12'd0, 9'd0, 1'b1, 1'b0, "V2_lap_below_minus_theta");
        one_px(-12'sd73, 9'd10, 12'd0, 9'd0, 1'b0, 1'b0, "V2_lap_above_minus_theta");

        //======================================================================
        // V3：最小亮度守卫（守卫输入现在就是窗口中心的 ΔL：i_dl_c）
        //======================================================================
        one_px(12'sd200,  9'd1,  12'd0, 9'd0, 1'b0, 1'b0, "V3_guard_blocks_dl1");
        one_px(12'sd200,  9'd2,  12'd0, 9'd0, 1'b1, 1'b1, "V3_guard_pass_dl2");
        one_px(12'sd200, -9'sd1, 12'd0, 9'd0, 1'b0, 1'b0, "V3_guard_blocks_neg_dl1");
        one_px(12'sd200, -9'sd2, 12'd0, 9'd0, 1'b1, 1'b1, "V3_guard_pass_neg_dl2");
        one_px(12'sd200,  9'd5,  12'd0, 9'd7, 1'b0, 1'b0, "V3_guard_port_override");

        //======================================================================
        // 阈值端口优先（i_theta = 200）
        //======================================================================
        one_px(12'sd100,  9'd10, 12'd200, 9'd0, 1'b0, 1'b0, "P1_theta_port_override_low");
        one_px(12'sd200,  9'd10, 12'd200, 9'd0, 1'b1, 1'b1, "P1_theta_port_override_high");

        //======================================================================
        // 极性约定（POL_ON_IS_1 = 0 的实例）
        //======================================================================
        @(negedge clk);
        i_de = 1'b1; i_lap = 12'sd200; i_dl_c = 9'd10; i_theta = 12'd0; i_min = 9'd0;
        i_x = 9'd11; i_y = 8'd5;
        @(negedge clk);
        i_de = 1'b0;
        if (p_valid === 1'b1 && p_pol === 1'b0) chk_pass("P2_pol_on_is_0");
        else                                    chk_fail("P2_pol_on_is_0");
        @(negedge clk);

        //======================================================================
        // R3：坐标必须"随流走"—— 输入什么 (x,y) 就上报什么
        //   故意用**非光栅**序列（x=(p*7+3)%16, y=(p*5+1)%8）：
        //   旧实现"自己数 de 脉冲"绝不可能复现该序列 ⇒ 必 FAIL。
        //   de 稀疏（1 拍有效 + 1 拍空）保持与真实链路一致。
        //======================================================================
        bad_xy = 0; got_ev = 0; bad_inv = 0;
        for (fi = 1; fi <= 5; fi = fi + 1) begin
            for (p = 0; p < NP; p = p + 1) begin
                px = (p*7 + 3) % EW;
                py = (p*5 + 1) % EH;
                @(negedge clk);
                i_de = 1'b1; i_lap = 12'sd200; i_dl_c = 9'd10;
                i_x = px[8:0]; i_y = py[7:0];
                @(negedge clk);
                i_de = 1'b0;
                if (m_valid === 1'b1) begin
                    if (fi == 1) got_ev = got_ev + 1;
                    if ((m_x !== px[8:0]) || (m_y !== py[7:0])) begin
                        if (fi == 1) begin
                            bad_xy = bad_xy + 1;
                            if (bad_xy <= 3) $display("      XY p=%0d got=(%0d,%0d) exp=(%0d,%0d)",
                                                      p, m_x, m_y, px, py);
                        end
                    end
                end else if (fi == 1) begin
                    bad_xy = bad_xy + 1;      // 每个像素都必须出事件
                end
                // 帧不变性：同一 p 的 (x,y) 上报值必须与第 1 帧完全一致
                if (m_valid === 1'b1) begin
                    if (fi == 1) xy_seq[p] = (m_x << 8) | m_y;
                    else if (xy_seq[p] !== ((m_x << 8) | m_y)) begin
                        bad_inv = bad_inv + 1;
                        if (bad_inv <= 3) $display("      INV p=%0d frm=%0d seq=%0d got=%0d",
                                                   p, fi, xy_seq[p], (m_x << 8) | m_y);
                    end
                end
                @(negedge clk);                 // 空拍
            end
        end
        if (got_ev == NP) chk_pass("R3_coord_follows_stream_count"); else begin
            chk_fail("R3_coord_follows_stream_count");
            $display("      got %0d (expect %0d)", got_ev, NP);
        end
        if (bad_xy == 0) chk_pass("R3_coord_follows_stream"); else begin
            chk_fail("R3_coord_follows_stream");
            $display("      coord mismatches = %0d", bad_xy);
        end
        if (bad_inv == 0) chk_pass("R3_frame_invariant"); else begin
            chk_fail("R3_frame_invariant");
            $display("      drifted = %0d", bad_inv);
        end

        //======================================================================
        // R3b：绝对坐标（远超旧 EV_W=16 的回绕范围）⇒ 必须原样上报
        //======================================================================
        @(negedge clk);
        i_de = 1'b1; i_lap = 12'sd200; i_dl_c = 9'd10; i_x = 9'd300; i_y = 8'd200;
        @(negedge clk);
        i_de = 1'b0;
        if (m_valid === 1'b1 && m_x === 9'd300 && m_y === 8'd200)
            chk_pass("R3_absolute_coord");
        else begin
            chk_fail("R3_absolute_coord");
            $display("      got valid=%0d x=%0d y=%0d (expect 1/300/200)", m_valid, m_x, m_y);
        end
        @(negedge clk);

        //======================================================================
        // V6：三档阈值 → 事件率单调（灵敏 > 默认 > 迟钝），且数值可预测
        //     序列 {60,100,200,30,−60,−100,−200}：θ=44→6 个，74→4 个，129→2 个
        //======================================================================
        cnt_a = 0; cnt_b = 0; cnt_c = 0;
        i_theta = 12'd0; i_min = 9'd0; i_dl_c = 9'd10;
        for (r = 0; r < 10; r = r + 1) begin
            for (p = 0; p < 7; p = p + 1) begin
                @(negedge clk);
                i_de = 1'b1; i_lap = lap_seq[p]; i_x = p[8:0]; i_y = r[7:0];
                @(negedge clk);
                i_de = 1'b0;
                @(negedge clk);
            end
        end
        if ((cnt_a == 60) && (cnt_b == 40) && (cnt_c == 20)) chk_pass("V6_theta_levels_monotonic");
        else begin
            chk_fail("V6_theta_levels_monotonic");
            $display("      counts a=%0d b=%0d c=%0d (expect 60/40/20)", cnt_a, cnt_b, cnt_c);
        end
        if ((cnt_a > cnt_b) && (cnt_b > cnt_c)) chk_pass("V6_rate_order"); else chk_fail("V6_rate_order");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
