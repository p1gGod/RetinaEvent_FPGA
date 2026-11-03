//==============================================================================
// tb_px_luma -- px_luma 单模块仿真（L2 事件引擎）
// 判据（文档 §8）：
//   V1  与厂家 rgb2ycbcr 逐点一致（固定测试向量，期望值独立手算）
//   V2  边界：全 0（黑）→ 0；全 1（白）→ 255
//   V3  de 与 y 同拍（固定 1 拍延迟，不差拍）
//   （补）USE_DSP=0 / USE_DSP=1 两条 generate 分支结果 bit-exact 相同
//==============================================================================
`timescale 1ns / 1ps

module tb_px_luma;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n  = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_de    = 1'b0;
    reg [15:0] i_data  = 16'h0000;

    wire       o_vsync, o_de;
    wire [7:0] o_y;

    wire       o_lut_vsync, o_lut_de;
    wire [7:0] o_lut_y;

    px_luma #(.COEF_R(77), .COEF_G(150), .COEF_B(29), .USE_DSP(1)) u_dut (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(i_vsync), .i_de(i_de), .i_data(i_data),
        .o_vsync(o_vsync), .o_de(o_de), .o_y(o_y)
    );

    px_luma #(.COEF_R(77), .COEF_G(150), .COEF_B(29), .USE_DSP(0)) u_lut (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(i_vsync), .i_de(i_de), .i_data(i_data),
        .o_vsync(o_lut_vsync), .o_de(o_lut_de), .o_y(o_lut_y)
    );

    reg [15:0] vec [0:8];
    reg [ 7:0] exp [0:8];
    reg [ 7:0] white_y;
    integer    n;
    integer    bad;

    initial begin
        // 期望值 = (77·{R,R[4:2]} + 150·{G,G[5:4]} + 29·{B,B[4:2]}) >> 8，独立算得
        vec[0] = 16'h0000; exp[0] = 8'd0;     // 黑
        vec[1] = 16'hFFFF; exp[1] = 8'd255;   // 白（V2）
        vec[2] = 16'hF800; exp[2] = 8'd76;    // 纯红
        vec[3] = 16'h07E0; exp[3] = 8'd149;   // 纯绿
        vec[4] = 16'h001F; exp[4] = 8'd28;    // 纯蓝
        vec[5] = 16'h8410; exp[5] = 8'd130;   // 中灰
        vec[6] = 16'h1234; exp[6] = 8'd63;
        vec[7] = 16'hBDEF; exp[7] = 8'd182;
        vec[8] = 16'h5A5A; exp[8] = 8'd94;

        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        //======================================================================
        // V1/V2：固定向量逐点比对
        //======================================================================
        bad = 0;
        for (n = 0; n < 9; n = n + 1) begin
            @(negedge clk);
            i_de   = 1'b1;
            i_data = vec[n];
            @(negedge clk);
            if (o_de !== 1'b1) bad = bad + 1;
            if (o_y  !== exp[n]) bad = bad + 1;
            if (o_lut_y !== o_y) bad = bad + 1;     // USE_DSP 两分支一致
            if (n == 1) white_y = o_y;              // 白场（V2）
        end
        if (bad == 0) chk_pass("V1_vectors_match_vendor"); else chk_fail("V1_vectors_match_vendor");
        if (white_y === 8'd255) chk_pass("V2_white_255"); else chk_fail("V2_white_255");

        //======================================================================
        // V3：控制与数据同拍（固定 1 拍）
        //======================================================================
        @(negedge clk);
        i_de    = 1'b0;
        i_data  = 16'h0000;
        i_vsync = 1'b1;
        @(negedge clk);
        if (o_de === 1'b0 && o_vsync === 1'b1 && o_y === 8'd0)
            chk_pass("V3_ctrl_data_same_cycle");
        else
            chk_fail("V3_ctrl_data_same_cycle");
        i_vsync = 1'b0;
        @(negedge clk);
        if (o_vsync === 1'b0) chk_pass("V3_vsync_1clk"); else chk_fail("V3_vsync_1clk");

        //======================================================================
        // 黑场复位值：全 0 输入 → 0
        //======================================================================
        @(negedge clk);
        i_de = 1'b1; i_data = 16'h0000;
        @(negedge clk);
        if (o_y === 8'd0 && o_de === 1'b1) chk_pass("V2_black_zero"); else chk_fail("V2_black_zero");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #100000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
