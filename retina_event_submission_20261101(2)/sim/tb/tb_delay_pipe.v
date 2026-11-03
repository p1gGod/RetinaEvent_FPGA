//==============================================================================
// tb_delay_pipe -- delay_pipe 单模块仿真
// 判据（文档 §8）：V1 输出恰为输入延迟 LATENCY 拍
//                 V2 LATENCY=0 与直通 bit-exact
//                 V3 复位后全 0
//==============================================================================
`timescale 1ns / 1ps

module tb_delay_pipe;

    reg  clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg         rst_n = 1'b0;
    reg  [15:0] din   = 16'h0000;

    wire [15:0] d1;     // LATENCY=1
    wire [15:0] d3;     // LATENCY=3
    wire [15:0] d0;     // LATENCY=0（组合直通）
    wire [7:0]  d8;     // WIDTH=8 参数化检查

    delay_pipe #(.WIDTH(16), .LATENCY(1)) u_d1 (.clk(clk), .rst_n(rst_n), .i_data(din), .o_data(d1));
    delay_pipe #(.WIDTH(16), .LATENCY(3)) u_d3 (.clk(clk), .rst_n(rst_n), .i_data(din), .o_data(d3));
    delay_pipe #(.WIDTH(16), .LATENCY(0)) u_d0 (.clk(clk), .rst_n(rst_n), .i_data(din), .o_data(d0));
    delay_pipe #(.WIDTH(8),  .LATENCY(2)) u_d8 (.clk(clk), .rst_n(rst_n), .i_data(din[7:0]), .o_data(d8));

    // V2: LATENCY=0 是纯组合
    initial begin
        #1 din = 16'h1234;
        #1;
        if (d0 === 16'h1234) chk_pass("V2_lat0_passthrough"); else chk_fail("V2_lat0_passthrough");
        din = 16'h0000;
    end

    initial begin
        // V3: 复位后全 0
        repeat (4) @(negedge clk);
        if (d1 === 16'h0000 && d3 === 16'h0000 && d8 === 8'h00) chk_pass("V3_rst_zero");
        else chk_fail("V3_rst_zero");

        rst_n = 1'b1;
        @(negedge clk);

        // V1: LATENCY=1 —— 输入在 negedge 变化，下一个 negedge 输出即为该值
        @(negedge clk); din = 16'hAAAA;
        @(negedge clk); if (d1 === 16'hAAAA) chk_pass("V1_lat1"); else chk_fail("V1_lat1");

        // LATENCY=3 —— 第 1、2 拍还没到，第 3 拍到
        @(negedge clk); din = 16'h5555;
        @(negedge clk); if (d3 === 16'hAAAA) chk_pass("V1_lat3_p1"); else chk_fail("V1_lat3_p1");
        @(negedge clk); if (d3 === 16'hAAAA) chk_pass("V1_lat3_p2"); else chk_fail("V1_lat3_p2");
        @(negedge clk); if (d3 === 16'h5555) chk_pass("V1_lat3_p3"); else chk_fail("V1_lat3_p3");

        // WIDTH=8 / LATENCY=2：延的是"2 拍前的 din[7:0]"（上一步 din=0x5555 ⇒ 0x55）
        @(negedge clk); din = 16'hBEEF;
        @(negedge clk); if (d8 === 8'h55) chk_pass("V1_w8_lat2_p1"); else chk_fail("V1_w8_lat2_p1");
        @(negedge clk); if (d8 === 8'hEF) chk_pass("V1_w8_lat2_p2"); else chk_fail("V1_w8_lat2_p2");

        // 逐拍流：连续喂递增值，验证 1 拍吞吐无气泡
        @(negedge clk);
        din = 16'h0001; @(negedge clk);
        din = 16'h0002; @(negedge clk);
        din = 16'h0003; @(negedge clk);
        din = 16'h0004; @(negedge clk);
        if (d1 === 16'h0004) chk_pass("V1_stream_throughput"); else chk_fail("V1_stream_throughput");

        // 复位立刻生效
        rst_n = 1'b0;
        @(negedge clk);
        if (d1 === 16'h0000 && d3 === 16'h0000) chk_pass("V3_rst_immediate"); else chk_fail("V3_rst_immediate");

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #100000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
