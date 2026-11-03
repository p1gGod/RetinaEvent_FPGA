//==============================================================================
// tb_vps_resample -- vps_resample 单模块仿真（L2 采集）
// 判据（文档 §8）：
//   V1  输出一帧 de 计数 = 400 × 240 = 96,000
//   V2  取的是 x/y 偶数位置的像素，且数据逐点不变（与参考模型比对）
//   V3  无乘法器/除法器（静态检查，见交付报告；本 TB 覆盖不到综合报告）
//   （补）o_vsync/o_de/o_data 固定 1 拍延迟且同拍对齐
//==============================================================================
`timescale 1ns / 1ps

module tb_vps_resample;

    reg clk = 1'b0;
    always #5 clk = ~clk;               // 10 ns / 100 MHz，功能仿真足够

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg rst_n = 1'b0;

    //--- 小实例：8×4 → 4×2，便于逐点核对 --------------------------------
    localparam SW = 8;
    localparam SH = 4;

    reg         s_vsync = 1'b0;
    reg         s_de    = 1'b0;
    reg  [15:0] s_data  = 16'h0000;
    wire        s_o_vsync;
    wire        s_o_de;
    wire [15:0] s_o_data;

    vps_resample #(
        .IN_W(SW), .IN_H(SH), .X_DECIM(2), .Y_DECIM(2), .OUT_W(SW/2), .OUT_H(SH/2)
    ) u_small (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(s_vsync), .i_de(s_de), .i_data(s_data),
        .o_vsync(s_o_vsync), .o_de(s_o_de), .o_data(s_o_data)
    );

    //--- 默认实例：800×480（V1 计数）-------------------------------------
    reg         b_vsync = 1'b0;
    reg         b_de    = 1'b0;
    reg  [15:0] b_data  = 16'h0000;
    wire        b_o_vsync;
    wire        b_o_de;
    wire [15:0] b_o_data;

    vps_resample u_big (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(b_vsync), .i_de(b_de), .i_data(b_data),
        .o_vsync(b_o_vsync), .o_de(b_o_de), .o_data(b_o_data)
    );

    reg  [31:0] b_de_cnt = 32'd0;

    always @(posedge clk) if (b_o_de) b_de_cnt <= b_de_cnt + 32'd1;

    //--- R1 链路回归：vps_pattern_gen(默认 800×480) → vps_resample(默认) ------
    //   规格（Lead R1 裁决）：
    //     每帧恰好 OUT_W×OUT_H = 96,000 个 de；每行恰好 400 个；
    //     vsync 当拍不得出像素；vsync 后第一行第一列 = (0,0)；行间 ≥1 拍干净间隙。
    //   用 MODE=0 水平灰度斜坡做列对齐证据：每行首像素 x=0 ⇒ 数据 0x0000，
    //   每行末像素 x=798 ⇒ lum=199 ⇒ 0xC638。
    reg  [1:0]  c_mode = 2'd0;
    reg         c_en   = 1'b0;
    wire        c_pv, c_pd;
    wire [15:0] c_pdata;

    vps_pattern_gen u_pat (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_mode(c_mode), .i_en(c_en),
        .o_vsync(c_pv), .o_de(c_pd), .o_data(c_pdata)
    );

    wire        c_rv, c_rd;
    wire [15:0] c_rdata;

    vps_resample u_rs (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(c_pv), .i_de(c_pd), .i_data(c_pdata),
        .o_vsync(c_rv), .o_de(c_rd), .o_data(c_rdata)
    );

    localparam [15:0] ROW_LAST = 16'hC638;   // x=798 → lum=199 → RGB565
    localparam [31:0] ROW_LEN  = 32'd400;
    localparam [31:0] FRM_LEN  = 32'd96000;

    reg [31:0] c_fr_de = 0, c_fr_latch = 0, c_row_de = 0, c_rows = 0;
    reg [31:0] c_bad_rows = 0, c_gap = 0, c_vs_de_bad = 0, c_bad_start = 0, c_bad_end = 0;
    reg [15:0] c_last_data = 0;
    reg        c_row_active = 0;
    reg        c_rv_d1 = 0;
    reg        c_arm = 0;                 // 1 = 开始干净计数（跳过起始的残帧）
    integer    rowlen [0:15];
    integer    rowidx = 0;
    integer    dbg_i;
    integer    c_vs_dbg = 0;

    always @(posedge clk) begin
        if (!rst_n || !c_arm) begin
            c_fr_de <= 0; c_fr_latch <= 0; c_row_de <= 0; c_rows <= 0;
            c_bad_rows <= 0; c_gap <= 0; c_vs_de_bad <= 0;
            c_bad_start <= 0; c_bad_end <= 0; c_last_data <= 0;
            c_row_active <= 0; c_rv_d1 <= 0;
        end else begin
            c_rv_d1 <= c_rv;
            c_gap   <= c_rd ? 32'd0 : (c_gap + 32'd1);
            if (c_rv && c_rd) c_vs_de_bad <= c_vs_de_bad + 32'd1;
            if (c_rv) begin
                if (c_row_active) begin
                    if (c_row_de != ROW_LEN)     c_bad_rows <= c_bad_rows + 32'd1;
                    if (c_last_data != ROW_LAST) c_bad_end  <= c_bad_end  + 32'd1;
                    c_rows <= c_rows + 32'd1;
                end
                c_fr_latch   <= c_fr_de;
                c_fr_de      <= 32'd0;
                c_row_de     <= 32'd0;
                c_row_active <= 1'b0;
            end else if (c_rd) begin
                c_fr_de <= c_fr_de + 32'd1;
                if (c_gap >= 32'd4) begin            // 行边界（≥4 拍干净间隙）
                    if (c_row_active) begin
                        if (c_row_de != ROW_LEN) begin
                            c_bad_rows <= c_bad_rows + 32'd1;
                            if (c_bad_rows < 4)
                                $display("      BADROW idx=%0d len=%0d", rowidx, c_row_de);
                        end
                        if (c_last_data != ROW_LAST) c_bad_end  <= c_bad_end  + 32'd1;
                        if (rowidx < 16) rowlen[rowidx] <= c_row_de;
                        rowidx <= rowidx + 1;
                        c_rows <= c_rows + 32'd1;
                    end
                    c_row_de     <= 32'd1;
                    c_row_active <= 1'b1;
                    if (c_rdata != 16'h0000) c_bad_start <= c_bad_start + 32'd1;
                end else begin
                    c_row_de <= c_row_de + 32'd1;
                end
                c_last_data <= c_rdata;
            end
        end
    end

    integer c_guard;
    integer c_vs_seen;

    integer  p;
    integer  rx;
    integer  ry;
    integer  n_out;
    reg      exp_keep;
    reg [15:0] val;

    initial begin
        //======================================================================
        // 小实例：连续像素流（x_cnt 满 IN_W 自动换行，无需行间空拍）
        //======================================================================
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        s_vsync = 1'b1;
        @(negedge clk);
        if (s_o_vsync === 1'b1) chk_pass("P1_vsync_1clk_delay"); else chk_fail("P1_vsync_1clk_delay");
        s_vsync = 1'b0;
        @(negedge clk);
        if (s_o_vsync === 1'b0) chk_pass("P2_vsync_pulse_1clk"); else chk_fail("P2_vsync_pulse_1clk");

        n_out   = 0;
        s_de    = 1'b1;
        s_data  = 16'h0000;
        for (p = 1; p <= SW*SH; p = p + 1) begin
            @(negedge clk);
            // 此刻观测到的是像素 p-1 的输出
            rx = (p - 1) % SW;
            ry = (p - 1) / SW;
            exp_keep = ((rx % 2) == 0) && ((ry % 2) == 0);
            if (s_o_de !== exp_keep) chk_fail("V2_decim_pattern");
            else if (exp_keep) begin
                n_out = n_out + 1;
                if (s_o_data !== {rx[7:0], ry[7:0]}) chk_fail("V2_decim_value");
                else                                 chk_pass("V2_decim_value");
            end
            if (p < SW*SH) s_data = (((p % SW) << 8) | (p / SW));   // 下一个像素 = {x, y}
        end
        if (n_out == (SW/2)*(SH/2)) chk_pass("V2_decim_count_small");
        else begin
            chk_fail("V2_decim_count_small");
            $display("      got %0d", n_out);
        end
        s_de = 1'b0;
        @(negedge clk);
        if (s_o_de === 1'b0) chk_pass("P3_de_zero_on_blank"); else chk_fail("P3_de_zero_on_blank");

        //======================================================================
        // V1：默认实例一帧 800×480 ⇒ 输出 de 计数 96,000
        //======================================================================
        b_de_cnt = 32'd0;
        b_vsync  = 1'b1;
        @(negedge clk);
        b_vsync  = 1'b0;
        @(negedge clk);
        b_data   = 16'h1234;
        b_de     = 1'b1;
        repeat (800*480) @(negedge clk);
        @(posedge clk);
        #1;
        b_de = 1'b0;
        if (b_de_cnt == 32'd96000) chk_pass("V1_frame_de_count_96000");
        else begin
            chk_fail("V1_frame_de_count_96000");
            $display("      got %0d", b_de_cnt);
        end

        //======================================================================
        // R1 链路回归：pattern_gen(800×480, MODE=0 斜坡) → resample
        //   C1 每帧 de 计数 = 96,000（旧实现 96,400 = 多一整行）
        //   C2 每行 de 计数 = 400
        //   C3 vsync 当拍无 de
        //   C4 每行首像素 x=0（数据 0x0000）、末像素 x=798（数据 0xC638）
        //   C5 行间 ≥1 拍干净间隙（由"行边界 = ≥4 拍 gap"的检测隐含）
        //======================================================================
        c_en = 1'b1;
        // 等第 1 个 vsync（现在它落在场消隐期），随后才开始干净计数
        c_guard = 0;
        while ((c_rv !== 1'b1) && (c_guard < 2000000)) begin @(negedge clk); c_guard = c_guard + 1; end
        @(negedge clk);
        c_arm = 1'b1;
        repeat (700000) @(negedge clk);       // ≈1.26 帧 ⇒ 至少锁存一个完整帧

        if (c_fr_latch == FRM_LEN) chk_pass("R1_frame_de_96000");
        else begin
            chk_fail("R1_frame_de_96000");
            $display("      got %0d (expect %0d)", c_fr_latch, FRM_LEN);
        end
        if (c_bad_rows == 0) chk_pass("R1_row_de_400_every_row"); else begin
            chk_fail("R1_row_de_400_every_row");
            $display("      rows with wrong length = %0d", c_bad_rows);
        end
        if (c_vs_de_bad == 0) chk_pass("R1_no_de_on_vsync"); else begin
            chk_fail("R1_no_de_on_vsync");
            $display("      de-on-vsync count = %0d", c_vs_de_bad);
        end
        if (c_bad_start == 0) chk_pass("R1_row_starts_at_x0"); else begin
            chk_fail("R1_row_starts_at_x0");
            $display("      bad row starts = %0d", c_bad_start);
        end
        if (c_bad_end == 0) chk_pass("R1_row_ends_at_x798"); else begin
            chk_fail("R1_row_ends_at_x798");
            $display("      bad row ends = %0d", c_bad_end);
        end

        //======================================================================
        // R1b：i_vsync 与 i_de **同拍** ⇒ vsync 当拍不得出像素
        //   （防"用复位前/上一行计数器"判 y_keep 造成越界像素）
        //   反例验证：去掉 RTL 里的 ~i_vsync 门控，本判据必须 FAIL。
        //======================================================================
        @(negedge clk);
        s_de = 1'b0; s_vsync = 1'b1;                  // 先单独复位，使 x_cnt=y_cnt=0
        @(negedge clk);
        s_vsync = 1'b0;
        repeat (4) @(negedge clk);
        @(negedge clk);
        s_vsync = 1'b1; s_de = 1'b1; s_data = 16'h0F0F;   // vsync 与有效像素同拍
        @(negedge clk);
        s_vsync = 1'b0; s_de = 1'b1; s_data = 16'h0F0F;
        if (s_o_vsync === 1'b1 && s_o_de === 1'b0) chk_pass("R1b_no_pixel_on_vsync");
        else                                       chk_fail("R1b_no_pixel_on_vsync");
        s_de = 1'b0;

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #60_000_000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
