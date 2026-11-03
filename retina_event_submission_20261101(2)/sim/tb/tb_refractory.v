//==============================================================================
// tb_refractory -- refractory 单模块仿真（L2 事件引擎，P1 可旁路）
// 判据（文档 §8）：
//   V1  同一像素连续 N 帧报事件，只放行 1 个（每像素跨帧不应期）
//   V2  i_bypass=1 时输出 = 输入（逐拍一致，零额外延迟）
//   V3  全局间隔生效：两事件间隔 < MIN_GAP_CLK 时第二个被抑制
//   V4  抑制不改变事件坐标/极性
//==============================================================================
`timescale 1ns / 1ps

module tb_refractory;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam IW = 8;
    localparam IH = 4;

    reg        rst_n  = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_byp   = 1'b0;
    reg        i_valid = 1'b0;
    reg [8:0]  i_x     = 9'd0;
    reg [7:0]  i_y     = 8'd0;
    reg        i_pol   = 1'b0;

    wire       o_valid, o_pol;
    wire [8:0] o_x;
    wire [7:0] o_y;

    // 每像素跨帧不应期实例（每 2 帧清扫一次）
    refractory #(.REFRACT_FRAMES(2), .MIN_GAP_CLK(0), .IMG_W(IW), .IMG_H(IH)) u_dut (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(i_vsync), .i_bypass(i_byp),
        .i_ev_valid(i_valid), .i_ev_x(i_x), .i_ev_y(i_y), .i_ev_pol(i_pol),
        .o_ev_valid(o_valid), .o_ev_x(o_x), .o_ev_y(o_y), .o_ev_pol(o_pol)
    );

    // 全局最小间隔实例
    wire       g_valid, g_pol;
    wire [8:0] g_x;
    wire [7:0] g_y;

    refractory #(.REFRACT_FRAMES(1), .MIN_GAP_CLK(5), .IMG_W(IW), .IMG_H(IH)) u_gap (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(i_vsync), .i_bypass(i_byp),
        .i_ev_valid(i_valid), .i_ev_x(i_x), .i_ev_y(i_y), .i_ev_pol(i_pol),
        .o_ev_valid(g_valid), .o_ev_x(g_x), .o_ev_y(g_y), .o_ev_pol(g_pol)
    );

    integer i, n;

    // 发一个事件并检查（非旁路路径延迟 2 拍）
    task send_ev;
        input [8:0]  x;
        input [7:0]  y;
        input        pol;
        input        exp_v;
        input        exp_pol;
        input [8*40-1:0] nm;
        begin
            @(negedge clk);
            i_valid = 1'b1; i_x = x; i_y = y; i_pol = pol;
            @(negedge clk);
            i_valid = 1'b0;
            @(negedge clk);
            if (o_valid !== exp_v) chk_fail(nm);
            else if (exp_v && ((o_x !== x) || (o_y !== y) || (o_pol !== exp_pol))) chk_fail(nm);
            else chk_pass(nm);
        end
    endtask

    // 跑一帧：vsync → 等清扫 → 发一个事件（固定像素 3,2）→ 检查是否放行
    task frame_ev;
        input exp_v;
        input [8*40-1:0] nm;
        begin
            @(negedge clk);
            i_vsync = 1'b1;
            @(negedge clk);
            i_vsync = 1'b0;
            repeat (12) @(negedge clk);         // 等冷却位图清扫（NBA=4 拍）完成
            send_ev(9'd3, 8'd2, 1'b1, exp_v, 1'b1, nm);
            repeat (4) @(negedge clk);
        end
    endtask

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        //======================================================================
        // V2：旁路（零额外延迟，逐拍一致）
        //======================================================================
        i_byp = 1'b1;
        @(negedge clk);
        i_valid = 1'b1; i_x = 9'd5; i_y = 8'd1; i_pol = 1'b0;
        #1;
        if (o_valid === 1'b1 && o_x === 9'd5 && o_y === 8'd1 && o_pol === 1'b0)
            chk_pass("V2_bypass_same_cycle");
        else
            chk_fail("V2_bypass_same_cycle");
        @(negedge clk);
        i_valid = 1'b0;
        #1;
        if (o_valid === 1'b0) chk_pass("V2_bypass_zero_latency"); else chk_fail("V2_bypass_zero_latency");
        @(negedge clk);
        i_byp = 1'b0;
        repeat (4) @(negedge clk);

        //======================================================================
        // V1/V4：同一像素连续 4 帧只放行 2 个（REFRACT_FRAMES=2 ⇒ 每 2 帧清扫一次）
        //         期望：放行 / 抑制 / 放行 / 抑制
        //======================================================================
        frame_ev(1'b1, "V1_frame1_pass");
        frame_ev(1'b0, "V1_frame2_suppressed");
        frame_ev(1'b1, "V1_frame3_pass");
        frame_ev(1'b0, "V1_frame4_suppressed");

        //======================================================================
        // V3：全局最小间隔（MIN_GAP_CLK=5）
        //   事件 A → 放行；2 拍后再来一个 → 被间隔抑制；10 拍后再来 → 放行
        //======================================================================
        @(negedge clk);
        i_vsync = 1'b1;
        @(negedge clk);
        i_vsync = 1'b0;
        repeat (12) @(negedge clk);

        // A：放行
        @(negedge clk);
        i_valid = 1'b1; i_x = 9'd1; i_y = 8'd1; i_pol = 1'b1;
        @(negedge clk);
        i_valid = 1'b0;
        @(negedge clk);
        if (g_valid === 1'b1) chk_pass("V3_gap_first_pass"); else chk_fail("V3_gap_first_pass");

        // B：距 A 的判定仅 2 拍 → 抑制
        @(negedge clk);
        i_valid = 1'b1; i_x = 9'd2; i_y = 8'd1; i_pol = 1'b1;
        @(negedge clk);
        i_valid = 1'b0;
        @(negedge clk);
        if (g_valid === 1'b0) chk_pass("V3_gap_blocks_close"); else chk_fail("V3_gap_blocks_close");

        // C：再等 10 拍 → 放行
        repeat (10) @(negedge clk);
        @(negedge clk);
        i_valid = 1'b1; i_x = 9'd3; i_y = 8'd1; i_pol = 1'b0;
        @(negedge clk);
        i_valid = 1'b0;
        @(negedge clk);
        if (g_valid === 1'b1 && g_x === 9'd3 && g_y === 8'd1 && g_pol === 1'b0)
            chk_pass("V3_gap_allows_after");
        else
            chk_fail("V3_gap_allows_after");

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
