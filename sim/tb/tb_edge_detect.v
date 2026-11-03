//==============================================================================
// tb_edge_detect -- edge_detect 单模块仿真
// 判据（文档 §8）：V1 上升沿输出 1 拍 o_rise
//                 V2 连续电平不产生重复脉冲
//                 V3 复位后第 1 拍不产生假沿（RST_LEVEL 语义）
//                 （补）下降沿 / o_any
//==============================================================================
`timescale 1ns / 1ps

module tb_edge_detect;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg  rst_n  = 1'b0;
    reg  i_sig  = 1'b1;                 // 本板按键低有效：复位期间为 1

    wire o_rise, o_fall, o_any;

    edge_detect #(.RST_LEVEL(1)) u_hi (
        .clk(clk), .rst_n(rst_n), .i_sig(i_sig),
        .o_rise(o_rise), .o_fall(o_fall), .o_any(o_any)
    );

    // 复位期间为 0 的实例，验证 RST_LEVEL=0 不产生假沿
    reg  i_lo = 1'b0;
    wire r_lo, f_lo, a_lo;
    edge_detect #(.RST_LEVEL(0)) u_lo (
        .clk(clk), .rst_n(rst_n), .i_sig(i_lo),
        .o_rise(r_lo), .o_fall(f_lo), .o_any(a_lo)
    );

    initial begin
        // ---- V3: 复位期间无假沿 ----
        repeat (4) @(negedge clk);
        if (o_rise === 1'b0 && o_fall === 1'b0) chk_pass("V3_no_false_edge_in_reset");
        else chk_fail("V3_no_false_edge_in_reset");
        if (r_lo === 1'b0 && f_lo === 1'b0) chk_pass("V3_rstlevel0_no_false_edge");
        else chk_fail("V3_rstlevel0_no_false_edge");

        rst_n = 1'b1;
        @(negedge clk);

        // ---- V1: 上升/下降沿恰好 1 拍 ----
        // ⚠️ o_rise/o_fall 是**组合**输出：i_sig 一变，脉冲立刻出现（不等时钟），
        //    再过一个 posedge 后消失。所以必须在"变化后、posedge 前"观察。
        i_sig = 1'b0;
        #1;
        if (o_fall === 1'b1) chk_pass("V1_fall_pulse_1cycle"); else chk_fail("V1_fall_pulse_1cycle");
        @(negedge clk);
        if (o_fall === 1'b0 && o_rise === 1'b0) chk_pass("V1_pulse_width_exactly_1"); else chk_fail("V1_pulse_width_exactly_1");

        i_sig = 1'b1;
        #1;
        if (o_rise === 1'b1) chk_pass("V1_rise_pulse_1cycle"); else chk_fail("V1_rise_pulse_1cycle");
        if (o_any  === 1'b1) chk_pass("V1_any_on_rise"); else chk_fail("V1_any_on_rise");
        @(negedge clk);
        if (o_rise === 1'b0) chk_pass("V1_rise_pulse_width_1"); else chk_fail("V1_rise_pulse_width_1");

        // ---- V2: 连续电平不产生重复脉冲 ----
        repeat (6) begin
            @(negedge clk);
            if (o_rise !== 1'b0 || o_any !== 1'b0) begin
                chk_fail("V2_no_repeat_on_level");
            end
        end
        chk_pass("V2_no_repeat_on_level");

        // ---- 复位后第 1 拍不产生假沿（RST_LEVEL=1 与当前电平一致）----
        rst_n = 1'b0;
        repeat (2) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);
        if (o_fall === 1'b0 && o_rise === 1'b0) chk_pass("V3_no_edge_right_after_rst_release");
        else chk_fail("V3_no_edge_right_after_rst_release");

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #100000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
