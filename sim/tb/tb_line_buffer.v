//==============================================================================
// tb_line_buffer -- line_buffer 单模块仿真
// 判据（文档 §8）：V1 写满一行后，读同列得到"上一行"数据
//                 V2 行首指针自动回绕正确（多行不错位）
//                 V3 读延迟恰为 1 拍
//                 （补）首行读到初值 0 ⇒ 边界补 0 语义成立
//                 （补）USE_BRAM=0 分支与 USE_BRAM=1 逐拍一致
//
// 时序模型（本 TB 的核心，务必看懂再改）：
//   每个像素：
//     negedge: 驱动 rd_addr=kk / wr_en=1 / wr_data=base+kk
//     #1     : posedge 尚未到来 ⇒ rd_bram 仍是"地址 kk-1"的数据  ← V3 判据
//     posedge: 读优先 —— o_rd_data <= 旧 mem[kk]；同时 mem[kk] <= 新值
//     #1     : rd_bram = 上一行的同列值                          ← V1 判据
//   wr_en 必须在 posedge 之后立刻撤销，否则同一个像素会被写两次（本 TB 首版就踩了这个坑）。
//==============================================================================
`timescale 1ns / 1ps

module tb_line_buffer;

    reg  clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam IMG_W  = 16;
    localparam ADDR_W = 4;

    reg               rst_n   = 1'b0;
    reg               wr_en   = 1'b0;
    reg  [7:0]        wr_data = 8'h00;
    reg  [ADDR_W-1:0] rd_addr = 4'h0;

    wire [7:0] rd_bram;
    wire [7:0] rd_lut;

    line_buffer #(.IMG_W(IMG_W), .DATA_W(8), .ADDR_W(ADDR_W), .USE_BRAM(1)) u_bram (
        .clk(clk), .rst_n(rst_n), .i_wr_en(wr_en), .i_wr_data(wr_data),
        .i_rd_addr(rd_addr), .o_rd_data(rd_bram)
    );

    line_buffer #(.IMG_W(IMG_W), .DATA_W(8), .ADDR_W(ADDR_W), .USE_BRAM(0)) u_lut (
        .clk(clk), .rst_n(rst_n), .i_wr_en(wr_en), .i_wr_data(wr_data),
        .i_rd_addr(rd_addr), .o_rd_data(rd_lut)
    );

    // ------------------------------------------------------------------
    // 写一行 base；期望读到"上一行"的 prev_base + kk
    // is_first=1 时上一行不存在（mem 初值 0），期望恒为 0
    // ------------------------------------------------------------------
    task run_line;
        input [7:0]     base;
        input [7:0]     prev_base;
        input integer   is_first;
        integer         kk;
        begin
            for (kk = 0; kk < IMG_W; kk = kk + 1) begin
                @(negedge clk);
                rd_addr = kk[ADDR_W-1:0];
                wr_en   = 1'b1;
                wr_data = base + kk[7:0];
                #1;
                // ---- V3: 读延迟恰 1 拍（此刻仍是上一个地址 kk-1 的数据）----
                if (kk > 0) begin
                    if (is_first) begin
                        if (rd_bram === 8'h00) chk_pass("V3_rd_latency_1");
                        else                   chk_fail("V3_rd_latency_1");
                    end else begin
                        if (rd_bram === (prev_base + kk[7:0] - 8'd1)) chk_pass("V3_rd_latency_1");
                        else                                          chk_fail("V3_rd_latency_1");
                    end
                end
                @(posedge clk);
                #1;
                wr_en = 1'b0;               // 立刻撤销，保证 1 px 只写 1 次
                // ---- V1: 读到上一行同列数据 ----
                if (is_first) begin
                    if (rd_bram === 8'h00) chk_pass("V1_first_line_is_zero");
                    else                   chk_fail("V1_first_line_is_zero");
                end else begin
                    if (rd_bram === (prev_base + kk[7:0])) chk_pass("V1_prev_line_data");
                    else                                   chk_fail("V1_prev_line_data");
                end
                // ---- 两个分支逐拍一致 ----
                if (rd_lut === rd_bram) chk_pass("V1_lut_branch_match");
                else                    chk_fail("V1_lut_branch_match");
            end
        end
    endtask

    initial begin
        repeat (3) @(negedge clk);
        if (rd_bram === 8'h00) chk_pass("V2_rst_read_zero");     else chk_fail("V2_rst_read_zero");
        if (rd_lut  === 8'h00) chk_pass("V2_rst_read_zero_lut"); else chk_fail("V2_rst_read_zero_lut");
        rst_n = 1'b1;
        @(negedge clk);

        // 第 0 行：写 10..25，读到的应是初值 0（边界补 0）
        run_line(8'd10,  8'd0,   1);
        // 第 1 行：写 100..115，读到的应是第 0 行的 10..25
        run_line(8'd100, 8'd10,  0);
        // 第 2 行：写 200..215，读到的应是第 1 行的 100..115  ← 验证写指针回绕
        run_line(8'd200, 8'd100, 0);
        // 第 3 行：写 30..45，读到的应是第 2 行的 200..215    ← 连续多行不错位
        run_line(8'd30,  8'd200, 0);

        wr_en = 1'b0;
        @(negedge clk);
        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
