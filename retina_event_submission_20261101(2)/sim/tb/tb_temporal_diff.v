//==============================================================================
// tb_temporal_diff -- temporal_diff 单模块仿真（L2 事件引擎）
// 判据（文档 §8）：
//   V1  同一位置连续两帧（L=100 → L=120）输出 ΔL = +20
//   V2  静态序列（两帧全同）输出 ΔL = 0 全程
//   V3  首帧不产生假事件（i_first_frame 期间 o_de 恒 0）
//   V4  地址覆盖完整（一帧内每个像素恰好写一次 ⇒ o_de 计数 = IMG_W×IMG_H）
//
// 小几何 16×8 = 128 像素，连续流驱动（x_cnt 满 IMG_W 自动换行，无需行间空拍）。
//==============================================================================
`timescale 1ns / 1ps

module tb_temporal_diff;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam IW = 16;
    localparam IH = 8;
    localparam NP = IW*IH;      // 128

    reg        rst_n = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_de    = 1'b0;
    reg  [7:0] i_l     = 8'h00;
    reg        i_first = 1'b0;

    wire       o_vsync, o_de;
    wire [8:0] o_dl;

    temporal_diff #(.IMG_W(IW), .IMG_H(IH), .ADDR_W(7)) u_dut (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(i_vsync), .i_de(i_de), .i_l(i_l), .i_first_frame(i_first),
        .o_vsync(o_vsync), .o_de(o_de), .o_dl(o_dl)
    );

    function [7:0] pattern;         // L(x,y) ∈ [16,143]，留出 ±20 偏移余量
        input integer x;
        input integer y;
        begin
            pattern = ((x*8 + y*3) & 8'h7F) + 8'd16;
        end
    endfunction

    integer k;
    integer bad;
    integer de_cnt;
    integer bad_de;

    // 驱动一帧并检查 ΔL；off = 相对基准图案的偏移
    task drive_frame;
        input integer off;
        input integer first;
        input integer chk_en;
        input integer exp_dl;
        integer j;
        begin
            i_first = first[0];
            @(negedge clk);
            i_vsync = 1'b1;
            @(negedge clk);
            i_vsync = 1'b0;
            i_de    = 1'b1;
            i_l     = pattern(0,0) + off[7:0];
            for (j = 1; j <= NP; j = j + 1) begin
                @(negedge clk);
                if (o_de === 1'b1) begin
                    de_cnt = de_cnt + 1;
                    if (chk_en != 0) begin
                        if (o_dl !== exp_dl[8:0]) begin
                            bad = bad + 1;
                            if (bad <= 3) $display("      mismatch px=%0d got=%0d expect=%0d | addr=%0d addr_d1=%0d lprev=%0d ld1=%0d",
                                                   j-1, $signed(o_dl), exp_dl,
                                                   u_dut.addr, u_dut.addr_d1,
                                                   u_dut.l_prev, u_dut.l_d1);
                        end
                    end
                end else if (chk_en != 0) begin
                    bad_de = bad_de + 1;        // 连续流下应当每拍都有 de
                end
                if (j < NP) i_l = pattern(j % IW, j / IW) + off[7:0];
            end
            @(negedge clk);
            i_de = 1'b0;
        end
    endtask

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        bad    = 0;
        bad_de = 0;

        //======================================================================
        // 帧 1：首帧（i_first_frame=1）→ V3：o_de 恒 0
        //======================================================================
        de_cnt = 0;
        drive_frame(0, 1, 0, 0);
        if (de_cnt == 0) chk_pass("V3_first_frame_no_event"); else begin
            chk_fail("V3_first_frame_no_event");
            $display("      o_de count in first frame = %0d", de_cnt);
        end

        //======================================================================
        // 帧 2：与帧 1 完全相同 → V2：ΔL = 0 全程；V4：de 计数 = 128
        //======================================================================
        de_cnt = 0;
        drive_frame(0, 0, 1, 0);
        $display("      after frame1: mem[0]=%0d mem[1]=%0d mem[126]=%0d mem[127]=%0d",
                 u_dut.frame_mem[0], u_dut.frame_mem[1], u_dut.frame_mem[126], u_dut.frame_mem[127]);
        if (bad == 0) chk_pass("V2_static_dl_zero"); else begin
            chk_fail("V2_static_dl_zero");
            $display("      dl mismatches = %0d", bad);
        end
        if (de_cnt == NP) chk_pass("V4_addr_cover_128"); else begin
            chk_fail("V4_addr_cover_128");
            $display("      o_de count = %0d (expect %0d)", de_cnt, NP);
        end

        //======================================================================
        // 帧 3：比帧 2 亮 +20 → V1：ΔL = +20
        //======================================================================
        bad = 0;
        drive_frame(20, 0, 1, 20);
        if (bad == 0) chk_pass("V1_dl_plus_20"); else begin
            chk_fail("V1_dl_plus_20");
            $display("      dl mismatches = %0d", bad);
        end

        //======================================================================
        // 帧 4：回到基准（比帧 3 暗 −20）→ ΔL = −20（S9 负值语义）
        //======================================================================
        bad = 0;
        drive_frame(0, 0, 1, -20);
        if (bad == 0) chk_pass("P1_dl_minus_20"); else begin
            chk_fail("P1_dl_minus_20");
            $display("      dl mismatches = %0d", bad);
        end

        //======================================================================
        // 控制对齐：o_vsync 与 o_de 同拍
        //======================================================================
        if (bad_de == 0) chk_pass("P2_de_every_cycle"); else chk_fail("P2_de_every_cycle");

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
