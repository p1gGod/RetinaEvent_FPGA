//==============================================================================
// tb_vps_pattern_gen -- vps_pattern_gen 单模块仿真（L2 采集）
// 判据（文档 §8）：
//   V1  四种模式输出与期望一致（逐点硬编码期望值，非公式自证）
//   V3  MODE=2 运动方块位置随帧号移动（联仿基础）
//   V2  MODE=3 均匀场逐帧完全相同（事件引擎"静止零事件"的前提，本 TB 验静态一致性）
//   （补）每帧 o_de 计数恰 = IMG_W×IMG_H（无气泡）；i_en=0 时 de=0 且 data=0
//
// 采样方法：DUT 自由扫描，o_de 脉冲在**全局 de 计数**上是严格连续的，
//   故 de 序号 k 唯一确定像素 (x = k%IMG_W, y = k/IMG_W)，第 f 帧起点 = f·IMG_W·IMG_H。
//==============================================================================
`timescale 1ns / 1ps

module tb_vps_pattern_gen;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg rst_n = 1'b0;

    //--- 小实例：1024×32（斜坡跨满 0..255），H_TOTAL=1040, V_TOTAL=48 -------
    localparam SW  = 1024;
    localparam SH  = 32;
    localparam SHF = SW*SH;              // 32768

    reg  [1:0] s_mode = 2'd0;
    reg        s_en   = 1'b1;
    wire       s_vsync, s_de;
    wire [15:0] s_data;

    vps_pattern_gen #(
        .IMG_W(SW), .IMG_H(SH), .H_TOTAL(1040), .V_TOTAL(48), .FRAME_DIV(1)
    ) u_small (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_mode(s_mode), .i_en(s_en),
        .o_vsync(s_vsync), .o_de(s_de), .o_data(s_data)
    );

    //--- 大实例：512×264（含方块 y 区间 200..263），MODE=2 -------------------
    localparam BW  = 512;
    localparam BH  = 264;
    localparam BHF = BW*BH;              // 135168

    reg  [1:0] b_mode = 2'd2;
    reg        b_en   = 1'b1;
    wire       b_vsync, b_de;
    wire [15:0] b_data;

    vps_pattern_gen #(
        .IMG_W(BW), .IMG_H(BH), .H_TOTAL(528), .V_TOTAL(300), .FRAME_DIV(1)
    ) u_big (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_mode(b_mode), .i_en(b_en),
        .o_vsync(b_vsync), .o_de(b_de), .o_data(b_data)
    );

    //--- 全局 de 计数 + 目标像素采样 ---------------------------------------
    reg [31:0] s_cnt = 32'd0;
    reg [15:0] s_c0, s_c1, s_c2, s_c3, s_c4, s_c5, s_c6, s_c7, s_c8;
    reg        s_g0, s_g1, s_g2, s_g3, s_g4, s_g5, s_g6, s_g7, s_g8;

    always @(posedge clk) begin
        if (!rst_n) begin
            s_cnt <= 32'd0;
        end else if (s_de) begin
            case (s_cnt)
                32'd0:                     begin s_c0 <= s_data; s_g0 <= 1'b1; end
                32'd400:                   begin s_c1 <= s_data; s_g1 <= 1'b1; end
                32'd1020:                  begin s_c2 <= s_data; s_g2 <= 1'b1; end
                32'd5120:                  begin s_c3 <= s_data; s_g3 <= 1'b1; end
                (32'd32768 + 32'd0):       begin s_c4 <= s_data; s_g4 <= 1'b1; end
                (32'd32768 + 32'd16):      begin s_c5 <= s_data; s_g5 <= 1'b1; end
                (32'd32768 + 32'd16384):   begin s_c6 <= s_data; s_g6 <= 1'b1; end
                (32'd32768 + 32'd16400):   begin s_c7 <= s_data; s_g7 <= 1'b1; end
                (32'd65536 + 32'd5000):    begin s_c8 <= s_data; s_g8 <= 1'b1; end
            endcase
            s_cnt <= s_cnt + 32'd1;
        end
    end

    reg [31:0] b_cnt = 32'd0;
    reg [15:0] b_c0, b_c1, b_c2, b_c3;

    always @(posedge clk) begin
        if (!rst_n) begin
            b_cnt <= 32'd0;
        end else if (b_de) begin
            case (b_cnt)
                32'd117810:                     b_c0 <= b_data;   // 帧0 (50,230) 方块外
                32'd117890:                     b_c1 <= b_data;   // 帧0 (130,230) 方块内
                (32'd135168 + 32'd117860):      b_c2 <= b_data;   // 帧1 (100,230) 已移出
                (32'd135168 + 32'd117891):      b_c3 <= b_data;   // 帧1 (131,230) 已移入
            endcase
            b_cnt <= b_cnt + 32'd1;
        end
    end

    integer guard;
    reg [31:0] snap;

    //--- 有界等待：等 de 计数到达目标 ---------------------------------------
    task wait_de_s; input [31:0] tgt; begin
        guard = 0;
        while ((s_cnt < tgt) && (guard < 4000000)) begin
            @(negedge clk);
            guard = guard + 1;
        end
    end endtask

    task wait_de_b; input [31:0] tgt; begin
        guard = 0;
        while ((b_cnt < tgt) && (guard < 4000000)) begin
            @(negedge clk);
            guard = guard + 1;
        end
    end endtask

    initial begin
        //======================================================================
        // 小实例 frame0：MODE=0 水平灰度斜坡
        //======================================================================
        s_mode = 2'd0;
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        wait_de_s(SHF);
        if (s_cnt == SHF) chk_pass("V1_de_count_per_frame"); else begin
            chk_fail("V1_de_count_per_frame");
            $display("      got %0d (expect %0d)", s_cnt, SHF);
        end
        if (s_g0 && s_c0 === 16'h0000) chk_pass("V1_mode0_ramp_x0");   else chk_fail("V1_mode0_ramp_x0");
        if (s_g1 && s_c1 === 16'h632C) chk_pass("V1_mode0_ramp_x400"); else chk_fail("V1_mode0_ramp_x400");
        if (s_g2 && s_c2 === 16'hFFFF) chk_pass("V1_mode0_ramp_x1020");else chk_fail("V1_mode0_ramp_x1020");
        if (s_g3 && s_c3 === 16'h0000) chk_pass("V1_mode0_row_indep"); else chk_fail("V1_mode0_row_indep");

        //======================================================================
        // 小实例 frame1：MODE=1 棋盘格（16×16）
        //======================================================================
        s_mode = 2'd1;
        wait_de_s(2*SHF);
        if (s_g4 && s_c4 === 16'h0000) chk_pass("V1_mode1_chk_00");   else chk_fail("V1_mode1_chk_00");
        if (s_g5 && s_c5 === 16'hFFFF) chk_pass("V1_mode1_chk_16_0"); else chk_fail("V1_mode1_chk_16_0");
        if (s_g6 && s_c6 === 16'hFFFF) chk_pass("V1_mode1_chk_0_16"); else chk_fail("V1_mode1_chk_0_16");
        if (s_g7 && s_c7 === 16'h0000) chk_pass("V1_mode1_chk_16_16");else chk_fail("V1_mode1_chk_16_16");

        //======================================================================
        // 小实例 frame2：MODE=3 均匀场（逐帧完全相同 ⇒ 后续联仿"零事件"前提）
        //======================================================================
        s_mode = 2'd3;
        wait_de_s(3*SHF);
        // MODE3 lum=0x80 ⇒ RGB565 = {0x80[7:3], 0x80[7:2], 0x80[7:3]} = {16,32,16} = 0x8410
        if (s_g8 && s_c8 === 16'h8410) chk_pass("V2_mode3_uniform");
        else begin
            chk_fail("V2_mode3_uniform");
            $display("      got 0x%04X g8=%0d cnt=%0d", s_c8, s_g8, s_cnt);
        end

        //======================================================================
        // i_en = 0：输出全 0 且 de = 0（窗口要足够长，跨过消隐区）
        //======================================================================
        @(negedge clk);
        s_en = 1'b0;
        snap = s_cnt;
        repeat (2000) @(negedge clk);
        if (s_cnt == snap) chk_pass("P1_en0_no_de"); else chk_fail("P1_en0_no_de");
        if (s_data === 16'h0000) chk_pass("P1_en0_data_zero"); else chk_fail("P1_en0_data_zero");
        s_en = 1'b1;
        repeat (30000) @(negedge clk);
        if (s_cnt > snap) chk_pass("P2_en1_resume"); else chk_fail("P2_en1_resume");

        //======================================================================
        // 大实例 frame0/frame1：MODE=2 运动方块（bx = 100 + frame_cnt[7:0]）
        //   大实例从复位起自由运行，故用"任意 158,400 拍窗口内恰 BHF 个 de"验计数
        //======================================================================
        wait_de_b(32'd253100);            // 覆盖帧 1 的两个目标像素
        if (b_c0 === 16'h2104) chk_pass("V3_block_f0_outside"); else chk_fail("V3_block_f0_outside");
        if (b_c1 === 16'hFFFF) chk_pass("V3_block_f0_inside");  else chk_fail("V3_block_f0_inside");
        if (b_c2 === 16'h2104) chk_pass("V3_block_f1_moved_out"); else chk_fail("V3_block_f1_moved_out");
        if (b_c3 === 16'hFFFF) chk_pass("V3_block_f1_moved_in");  else chk_fail("V3_block_f1_moved_in");

        snap = b_cnt;
        repeat (528*300) @(negedge clk);  // 恰一帧周期
        if ((b_cnt - snap) == BHF) chk_pass("V3_block_de_count");
        else begin
            chk_fail("V3_block_de_count");
            $display("      got %0d (expect %0d)", b_cnt - snap, BHF);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #40_000_000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
