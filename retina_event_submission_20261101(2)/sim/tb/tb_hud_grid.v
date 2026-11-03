// ============================================================================
// tb_hud_grid.v -- OVL 平面 1：等距网格 + 边框（逐像素 + PPM 出图）
//
// 判据（hud_grid.md §8）：
//   CHECK=PIXEL_ALL    800x480 全像素与 TB 独立参考一致（命中 + 颜色）
//   CHECK=V_LINES      非边框行（y=100）上竖线正好 20 条（x=0,40,...,760）
//   CHECK=H_LINES      非边框列（x=100）上横线正好 12 条（y=0,40,...,440）
//   CHECK=BORDER_CNT   边框像素数 = 800*480 - 796*476 = 5104（手算）
//   CHECK=BORDER_COLOR 边框用 BORDER_COLOR(0x00A0FF)，网格线用 GRID_COLOR(0x202020)
//   CHECK=EN_GATE      ovl_en=0 时整帧命中数为 0
//   CHECK=DE_GATE      px_de=0 时命中数为 0
//   CHECK=PPM_FILE     导出 P6 PPM，像素数 = 384000
// ============================================================================
`timescale 1ns/1ps

module tb_hud_grid;

    localparam LCD_W = 800, LCD_H = 480;
    localparam STEP  = 40;
    localparam BW    = 2;
    localparam GRID_COLOR   = 24'h202020;
    localparam BORDER_COLOR = 24'h00A0FF;

    reg         clk, rst_n;
    reg  [10:0] sx, sy;
    reg         sweep_active, start;
    integer     phase;                 // 0 = ovl_en 1；1 = ovl_en 0
    reg         ovl_en_r;

    wire        o_hit;
    wire [23:0] o_rgb;

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

    hud_grid #(
        .GRID_STEP_X(STEP), .GRID_STEP_Y(STEP),
        .GRID_COLOR(GRID_COLOR), .BORDER_COLOR(BORDER_COLOR),
        .BORDER_W(BW), .H_VALID(LCD_W), .V_VALID(LCD_H), .PIPE(1)
    ) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx), .px_y(sy), .px_de(sweep_active), .ovl_en(ovl_en_r),
        .ovl_hit(o_hit), .ovl_rgb(o_rgb)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #50_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            sx <= 11'd0; sy <= 11'd0; sweep_active <= 1'b0;
        end else if (start && !sweep_active) begin
            sweep_active <= 1'b1; sx <= 11'd0; sy <= 11'd0;
        end else if (sweep_active) begin
            if (sx == LCD_W-1 && sy == LCD_H-1) sweep_active <= 1'b0;
            else if (sx == LCD_W-1) begin sx <= 11'd0; sy <= sy + 11'd1; end
            else sx <= sx + 11'd1;
        end
    end

    // 输出 1 拍延迟 ⇒ 用上一拍的坐标做参考
    reg [10:0] px, py;
    reg        pde, pen;
    always @(posedge clk) begin
        px <= sx; py <= sy; pde <= sweep_active; pen <= ovl_en_r;
    end

    // ---- 参考模型 ----------------------------------------------------------
    wire [10:0] x_mod = px % STEP;
    wire [10:0] y_mod = py % STEP;
    wire        v_line = (x_mod == 11'd0);
    wire        h_line = (y_mod == 11'd0);
    wire        border = (px < BW) || (px >= (LCD_W - BW)) ||
                         (py < BW) || (py >= (LCD_H - BW));
    wire        exp_hit = pde & pen & (v_line | h_line | border);
    wire [23:0] exp_rgb = border ? BORDER_COLOR : GRID_COLOR;

    // ---- 监视 ---------------------------------------------------------------
    integer err_pix, err_hit, de_cnt;
    integer n_border, n_grid, hits_row100, hits_col100;
    integer hits_p1, hits_p0;
    integer fd, ppm_pix, ppm_ok;

    initial begin
        err_pix = 0; err_hit = 0; de_cnt = 0;
        n_border = 0; n_grid = 0; hits_row100 = 0; hits_col100 = 0;
        hits_p1 = 0; hits_p0 = 0;
        ppm_pix = 0; ppm_ok = 0;
        fd = $fopen("hud_grid.ppm", "wb");
        if (fd != 0) begin $fwrite(fd, "P6\n800 480\n255\n"); ppm_ok = 1; end
    end

    always @(posedge clk) begin
        if (rst_n) begin
            de_cnt = de_cnt + 1;
            if (o_hit !== exp_hit) err_hit = err_hit + 1;

            if (o_hit) begin
                if (o_rgb !== exp_rgb) err_pix = err_pix + 1;
                if (border) n_border = n_border + 1;
                else        n_grid   = n_grid + 1;
                if (phase == 0) hits_p1 = hits_p1 + 1;
                else            hits_p0 = hits_p0 + 1;
                if (py == 11'd100) hits_row100 = hits_row100 + 1;
                if (px == 11'd100) hits_col100 = hits_col100 + 1;
            end

            if (ppm_ok && pde) begin
                $fwrite(fd, "%c%c%c",
                        o_hit ? o_rgb[23:16] : 8'h00,
                        o_hit ? o_rgb[15:8]  : 8'h00,
                        o_hit ? o_rgb[7:0]   : 8'h00);
                ppm_pix = ppm_pix + 1;
            end
        end
    end

    // ---- 激励 ---------------------------------------------------------------
    integer guard;
    task run_sweep;
        begin
            @(negedge clk);
            start = 1'b1;
            @(negedge clk);
            start = 1'b0;
            guard = 0;
            while (sweep_active && guard < 500000) begin
                @(negedge clk); guard = guard + 1;
            end
            repeat (3) @(negedge clk);
        end
    endtask

    initial begin
        rst_n = 1'b0; start = 1'b0; phase = 0; ovl_en_r = 1'b1;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;
        run_sweep;                       // 阶段 0：ovl_en=1（写入 PPM）
        phase = 1; ovl_en_r = 1'b0;
        run_sweep;                       // 阶段 1：ovl_en=0
        if (fd != 0) $fclose(fd);

        // 手算：py=100（非 40 倍数、非边框行）上
        //   竖线 x=0,40,...,760 -> 20 条
        //   边框列 x=0,1,798,799 -> x=1/798/799 是额外 3 个（x=0 已算）
        //   => 23
        // px=100 上：
        //   横线 y=0,40,...,440 -> 12 条
        //   边框行 y=0,1,478,479 -> y=1/478/479 额外 3 个
        //   => 15
        chk("PIXEL_ALL",    err_hit == 0 && err_pix == 0 && de_cnt > 2*(LCD_W*LCD_H));
        chk("V_LINES",      hits_row100 == 23);
        chk("H_LINES",      hits_col100 == 15);
        chk("BORDER_CNT",   n_border == (LCD_W*LCD_H - (LCD_W-2*BW)*(LCD_H-2*BW)));
        chk("BORDER_COLOR", err_pix == 0 && n_grid > 0);
        chk("EN_GATE",      hits_p0 == 0);
        chk("DE_GATE",      hits_p1 > 0);
        chk("PPM_FILE",     ppm_ok == 1 && ppm_pix == 2*(LCD_W*LCD_H));

        $display("INFO=hits=%0d border=%0d grid=%0d row100=%0d col100=%0d err_hit=%0d err_rgb=%0d",
                 hits_p1, n_border, n_grid, hits_row100, hits_col100, err_hit, err_pix);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
