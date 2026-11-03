// ============================================================================
// tb_lcd_scanout.v -- 800x480 @25MHz DE 模式时序 + 坐标/DE/RGB 同拍契约
//
// 判据（lcd_scanout.md §8 + Lead 冻结的"坐标与 de 同拍"）：
//   CHECK=FRAME_DE_COUNT   一帧 de 有效拍数 = 800*480 = 384000
//   CHECK=ROW_RUN_LEN      每个 de 连续段长度 = 800（行）
//   CHECK=ROW_GAP          行间空隙 = H_TOTAL-H_VALID = 256，一帧正好 479 个
//   CHECK=X_SEQUENCE       每个 de 段内 o_pixel_xpos 依次 0..799
//   CHECK=Y_SEQUENCE       o_pixel_ypos 依次 0..479（每行一个）
//   CHECK=FRAME_PERIOD     两帧首个 de 上升沿间隔 = 1056*525 = 554400 拍
//   CHECK=HSVS_DE_MODE     DE 模式下 hs/vs 恒高（厂家做法）
//   CHECK=PCLK_EQ_CLK      像素时钟 = clk_lcd
//   CHECK=RGB_PASSTHROUGH  PIPE=0 时 o_lcd_rgb565 与 i_pixel_data 同拍一致
//   CHECK=PIPE_INSTANCE    PIPE=2 实例的 de/rgb/坐标恰为基准拍延迟 2 拍
//   CHECK=XY_RANGE         坐标恒在 0..799 / 0..479
// ============================================================================
`timescale 1ns/1ps

module tb_lcd_scanout;

    localparam H_SYNC = 128, H_BACK = 88, H_VALID = 800, H_FRONT = 40;
    localparam V_SYNC = 2,   V_BACK = 33, V_VALID = 480, V_FRONT = 10;
    localparam H_TOTAL = H_SYNC + H_BACK + H_VALID + H_FRONT;   // 1056
    localparam V_TOTAL = V_SYNC + V_BACK + V_VALID + V_FRONT;   // 525
    localparam FRAME_CYCLES = H_TOTAL * V_TOTAL;                // 554400

    reg         clk_lcd;
    reg         rst_n_lcd;
    reg  [15:0] i_pixel_data;
    wire        o_lcd_de, o_lcd_hs, o_lcd_vs, o_lcd_pclk;
    wire [15:0] o_lcd_rgb565;
    wire [10:0] o_pixel_xpos, o_pixel_ypos;

    wire        o_de2, o_hs2, o_vs2, o_pclk2;
    wire [15:0] o_rgb2;
    wire [10:0] o_x2, o_y2;

    integer n_fail;
    initial n_fail = 0;
    task chk;
        input [255:0] nm;
        input         cond;
        begin
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); n_fail = n_fail + 1; end
        end
    endtask

    lcd_scanout #(
        .H_SYNC(H_SYNC), .H_BACK(H_BACK), .H_VALID(H_VALID), .H_FRONT(H_FRONT),
        .V_SYNC(V_SYNC), .V_BACK(V_BACK), .V_VALID(V_VALID), .V_FRONT(V_FRONT),
        .PIPE(0), .HSVS_DE_MODE(1)
    ) u_dut (
        .clk_lcd(clk_lcd), .rst_n_lcd(rst_n_lcd), .i_pixel_data(i_pixel_data),
        .o_lcd_de(o_lcd_de), .o_lcd_hs(o_lcd_hs), .o_lcd_vs(o_lcd_vs),
        .o_lcd_pclk(o_lcd_pclk), .o_lcd_rgb565(o_lcd_rgb565),
        .o_pixel_xpos(o_pixel_xpos), .o_pixel_ypos(o_pixel_ypos)
    );

    lcd_scanout #(
        .H_SYNC(H_SYNC), .H_BACK(H_BACK), .H_VALID(H_VALID), .H_FRONT(H_FRONT),
        .V_SYNC(V_SYNC), .V_BACK(V_BACK), .V_VALID(V_VALID), .V_FRONT(V_FRONT),
        .PIPE(2), .HSVS_DE_MODE(0)
    ) u_pipe2 (
        .clk_lcd(clk_lcd), .rst_n_lcd(rst_n_lcd), .i_pixel_data(i_pixel_data),
        .o_lcd_de(o_de2), .o_lcd_hs(o_hs2), .o_lcd_vs(o_vs2),
        .o_lcd_pclk(o_pclk2), .o_lcd_rgb565(o_rgb2),
        .o_pixel_xpos(o_x2), .o_pixel_ypos(o_y2)
    );

    // ---- 时钟 / 超时 --------------------------------------------------------
    initial clk_lcd = 1'b0;
    always #20 clk_lcd = ~clk_lcd;      // 40 ns -> 25 MHz

    initial begin
        #60_000_000;                    // 60 ms 实时间保护（> 2 帧 44.4 ms）
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // 输入数据在 negedge 变化（避免与 posedge 监视器抢 delta）
    initial i_pixel_data = 16'h0000;
    always @(negedge clk_lcd) if (rst_n_lcd) i_pixel_data <= i_pixel_data + 16'h1234;

    // ---- 监视 ---------------------------------------------------------------
    reg        de_d;
    wire       de_rise = o_lcd_de & ~de_d;
    wire       de_fall = ~o_lcd_de & de_d;

    integer cyc, n_runs, run_len, gap_len, x_exp, de_cnt, de_frame1;
    integer n_gap256, n_gapother, gap_other;
    integer err_runlen, err_x, err_y, err_xend;
    integer cyc_first, cyc_second;
    reg     hs_bad, vs_bad, pclk_bad, rgb_bad, xrange_bad, yrange_bad;

    reg [1:0]   base_de_p;
    reg [31:0]  base_rgb_p;
    reg [1:0]   x2_p, y2_p;
    reg         p2_started;
    integer     p2_err, p2_checks;

    initial begin
        cyc = 0; n_runs = 0; run_len = 0; gap_len = 0; x_exp = 0; de_cnt = 0; de_frame1 = -1;
        n_gap256 = 0; n_gapother = 0; gap_other = -1;
        err_runlen = 0; err_x = 0; err_y = 0; err_xend = 0;
        cyc_first = -1; cyc_second = -1;
        hs_bad = 0; vs_bad = 0; pclk_bad = 0; rgb_bad = 0;
        xrange_bad = 0; yrange_bad = 0;
        base_de_p = 0; base_rgb_p = 0; x2_p = 0; y2_p = 0;
        p2_started = 0; p2_err = 0; p2_checks = 0;
        de_d = 1'b0;
    end

    always @(posedge clk_lcd) begin
        if (rst_n_lcd) begin
            cyc  = cyc + 1;
            de_d <= o_lcd_de;

            if (o_lcd_hs   !== 1'b1)   hs_bad   = 1;
            if (o_lcd_vs   !== 1'b1)   vs_bad   = 1;
            if (o_lcd_pclk !== clk_lcd) pclk_bad = 1;
            if (o_lcd_rgb565 !== i_pixel_data) rgb_bad = 1;

            if (o_lcd_de) begin
                de_cnt  = de_cnt + 1;
                run_len = run_len + 1;
                if (o_pixel_xpos !== x_exp[10:0]) err_x = err_x + 1;
                if (o_pixel_xpos > 11'd799)       xrange_bad = 1;
                if (o_pixel_ypos > 11'd479)       yrange_bad = 1;
                x_exp = x_exp + 1;
            end else begin
                gap_len = gap_len + 1;
            end

            if (de_rise) begin
                n_runs = n_runs + 1;
                if (n_runs == 1) begin
                    cyc_first = cyc;
                end
                if (n_runs == 481) begin
                    cyc_second = cyc;
                    de_frame1  = de_cnt - 1;   // 当前这一拍已是第 2 帧首个 de
                end
                // 行间空隙：只统计第 2..480 个段之前的那 479 个空隙
                if (n_runs > 1 && n_runs <= 480) begin
                    if (gap_len == 256) n_gap256 = n_gap256 + 1;
                    else begin
                        n_gapother = n_gapother + 1;
                        if (gap_other < 0) gap_other = gap_len;
                    end
                end
                // 行号：第 n 段（n<=480）的 y = n-1；第 481 段是下一帧第 0 行
                if (n_runs <= 480) begin
                    if (o_pixel_ypos !== (n_runs - 1)) err_y = err_y + 1;
                end else begin
                    if (o_pixel_ypos !== 11'd0) err_y = err_y + 1;
                end
                gap_len = 0;
            end

            if (de_fall) begin
                if (run_len != 800) err_runlen = err_runlen + 1;
                if (x_exp   != 800) err_xend   = err_xend + 1;
                run_len = 0;
                x_exp   = 0;
            end
        end
    end

    // PIPE=2 实例：复位后前 600 拍检查延迟契约
    always @(posedge clk_lcd) begin
        if (rst_n_lcd) begin
            base_de_p  <= {base_de_p[0],  o_lcd_de};
            base_rgb_p <= {base_rgb_p[15:0], i_pixel_data};
            x2_p       <= {x2_p[0], o_pixel_xpos};
            y2_p       <= {y2_p[0], o_pixel_ypos};
            if (cyc > 5 && cyc < 600) begin
                p2_started <= 1'b1;
                p2_checks  = p2_checks + 1;
                if (o_de2  !== base_de_p[1])       p2_err = p2_err + 1;
                if (o_rgb2 !== base_rgb_p[31:16])  p2_err = p2_err + 1;
                if (o_x2   !== x2_p[1])            p2_err = p2_err + 1;
                if (o_y2   !== y2_p[1])            p2_err = p2_err + 1;
            end
        end
    end

    // ---- 激励与判定 ---------------------------------------------------------
    initial begin
        rst_n_lcd = 1'b0;
        repeat (10) @(posedge clk_lcd);
        rst_n_lcd = 1'b1;

        while (n_runs < 481) @(posedge clk_lcd);

        chk("FRAME_DE_COUNT",  de_frame1 == (H_VALID * V_VALID));
        chk("ROW_RUN_LEN",     err_runlen == 0);
        chk("ROW_GAP",         n_gap256 == 479 && n_gapother == 0);
        chk("X_SEQUENCE",      err_x == 0 && err_xend == 0);
        chk("Y_SEQUENCE",      err_y == 0 && n_runs == 481);
        chk("FRAME_PERIOD",    (cyc_second - cyc_first) == FRAME_CYCLES);
        chk("HSVS_DE_MODE",    hs_bad == 0 && vs_bad == 0);
        chk("PCLK_EQ_CLK",     pclk_bad == 0);
        chk("RGB_PASSTHROUGH", rgb_bad == 0);
        chk("PIPE_INSTANCE",   p2_started == 1'b1 && p2_err == 0 && p2_checks > 500);
        chk("XY_RANGE",        xrange_bad == 0 && yrange_bad == 0);

        $display("INFO=frame_cycles=%0d de=%0d runs=%0d gap256=%0d gap_other=%0d(%0d) p2chk=%0d",
                 cyc_second - cyc_first, de_cnt, n_runs, n_gap256, n_gapother, gap_other, p2_checks);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else begin
            $display("INFO=n_fail=%0d err_run=%0d err_x=%0d err_xend=%0d err_y=%0d",
                     n_fail, err_runlen, err_x, err_xend, err_y);
            $display("TEST_RESULT=FAIL");
        end
        $finish;
    end

endmodule
