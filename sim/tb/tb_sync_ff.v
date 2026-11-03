//==============================================================================
// tb_sync_ff -- sync_ff 单模块仿真
// 判据（文档 §8）：V1 输入变化后第 STAGES 拍输出更新
//                 V2 复位期间输出为 0
//                 （补）多比特向量同步后数值一致
//==============================================================================
`timescale 1ns / 1ps

module tb_sync_ff;

    reg  clk = 1'b0;
    always #5 clk = ~clk;              // 100 MHz

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    // ---------------- WIDTH=1, STAGES=2 ----------------
    reg        rst_n = 1'b0;
    reg        i_src = 1'b0;
    wire       o_dst;

    sync_ff #(.WIDTH(1), .STAGES(2)) u_dut (
        .dest_clk   (clk),
        .dest_rst_n (rst_n),
        .i_src      (i_src),
        .o_dst      (o_dst)
    );

    // ---------------- WIDTH=8, STAGES=3 ----------------
    reg  [7:0] i_v = 8'h00;
    wire [7:0] o_v;

    sync_ff #(.WIDTH(8), .STAGES(3)) u_dut8 (
        .dest_clk   (clk),
        .dest_rst_n (rst_n),
        .i_src      (i_v),
        .o_dst      (o_v)
    );

    initial begin
        // V2: 复位期间输出为 0
        repeat (4) @(negedge clk);
        if (o_dst === 1'b0) chk_pass("V2_rst_zero"); else chk_fail("V2_rst_zero");
        if (o_v   === 8'h00) chk_pass("V2_rst_zero_vec"); else chk_fail("V2_rst_zero_vec");

        rst_n = 1'b1;
        @(negedge clk);

        // V1: 输入在第 N 个 negedge 变化，第 N+STAGES 个 negedge 输出更新
        @(negedge clk); i_src = 1'b1;
        @(negedge clk); if (o_dst === 1'b0) chk_pass("V1_delay1_still0"); else chk_fail("V1_delay1_still0");
        @(negedge clk); if (o_dst === 1'b1) chk_pass("V1_delay2_up");      else chk_fail("V1_delay2_up");

        // 下降沿同理
        @(negedge clk); i_src = 1'b0;
        @(negedge clk); if (o_dst === 1'b1) chk_pass("V1_fall_delay1"); else chk_fail("V1_fall_delay1");
        @(negedge clk); if (o_dst === 1'b0) chk_pass("V1_fall_delay2"); else chk_fail("V1_fall_delay2");

        // 多比特：STAGES=3 ⇒ 3 个 negedge 后数值一致
        @(negedge clk); i_v = 8'hA5;
        @(negedge clk); if (o_v === 8'h00) chk_pass("V1_vec_stage1"); else chk_fail("V1_vec_stage1");
        @(negedge clk); if (o_v === 8'h00) chk_pass("V1_vec_stage2"); else chk_fail("V1_vec_stage2");
        @(negedge clk); if (o_v === 8'hA5) chk_pass("V1_vec_stage3"); else chk_fail("V1_vec_stage3");

        // 复位后再验证一次：立刻清 0
        rst_n = 1'b0;
        repeat (2) @(negedge clk);
        if (o_v === 8'h00 && o_dst === 1'b0) chk_pass("V2_rst_again"); else chk_fail("V2_rst_again");

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #100000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
