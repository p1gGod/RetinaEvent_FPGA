// ============================================================================
// tb_hud_text.v -- OVL 平面 4：固定文案逐像素渲染（逐像素 + PPM + H40 回归）
//
// 判据（hud_text.md §8）：
//   CHECK=PIXEL_ALL       800x480 全像素命中与 TB 独立参考一致
//   CHECK=CHAR_CODE       o_char_code 与 TB 自己那份文案逐字符一致（验证字符串索引）
//   CHECK=CHAR_ROW        o_char_row == dy[4:1]（0..15）
//   CHECK=H40_NO_REPEAT   ★H40 回归：2 倍放大时字形**不得上下重复**——
//                         同一字符格的上半( dy 0..15)与下半( dy 16..31)命中数必须不同
//   CHECK=HIT_TOTAL       命中总数 = Σ 字形行 popcount × SCALE²（手算交叉校验）
//   CHECK=TEXT_AREA       文字只出现在 [TEXT_X,+512) x [TEXT_Y,+32) 内
//   CHECK=EN_GATE         ovl_en=0 整帧命中 0
//   CHECK=PPM_FILE        导出 P6 PPM，像素数 = 384000
// ============================================================================
`timescale 1ns/1ps

module tb_hud_text;

    localparam LCD_W = 800, LCD_H = 480;
    localparam TEXT_X = 8, TEXT_Y = 40;
    localparam CH_W = 16, CH_H = 32;      // CHAR_W(8)*SCALE(2), CHAR_H(16)*SCALE(2)

    reg         clk, rst_n;
    reg  [10:0] sx, sy;
    reg         sweep_active, start;
    integer     phase;
    reg         ovl_en_r;

    wire        o_hit;
    wire [23:0] o_rgb;
    wire [6:0]  o_char_code;
    wire [3:0]  o_char_row;

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

    hud_text #(.PIPE(1)) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx), .px_y(sy), .px_de(sweep_active), .ovl_en(ovl_en_r),
        .ovl_hit(o_hit), .ovl_rgb(o_rgb),
        .o_char_code(o_char_code), .o_char_row(o_char_row)
    );

    // ---- TB 侧独立参考：自己一份文案 + 自己一个字形 ROM ---------------------
    parameter [255:0] TB_TEXT = "RETINA EVENT HUD  ON/OFF 400x240";
    wire [10:0] tb_tx   = sx - TEXT_X;
    wire [10:0] tb_ty   = sy - TEXT_Y;
    wire [6:0]  tb_cx_c = tb_tx[9:4];
    wire [6:0]  tb_cx   = (tb_cx_c > 7'd31) ? 7'd31 : tb_cx_c;
    wire [7:0]  tb_char = TB_TEXT[(31 - tb_cx) * 8 +: 8];
    wire [3:0]  tb_row  = tb_ty[4:1];

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

    reg [10:0] px, py;
    reg        pde, pen;
    always @(posedge clk) begin
        px <= sx; py <= sy; pde <= sweep_active; pen <= ovl_en_r;
    end

    // ---- 参考判定（用延迟 1 拍的坐标对齐 PIPE=1 输出）---------------------
    wire [10:0] dx = px - TEXT_X;
    wire [10:0] dy = py - TEXT_Y;
    wire in_area = (px >= TEXT_X) && (px < (TEXT_X + 32*CH_W)) &&
                   (py >= TEXT_Y) && (py < (TEXT_Y + CH_H));
    wire [5:0] cxi = dx[9:4];
    wire [2:0] coli = dx[4:1];
    wire [3:0] rowi = dy[4:1];
    wire [7:0] ref_char = TB_TEXT[(31 - cxi) * 8 +: 8];

    wire [7:0] ref_glyph;
    font_rom u_ref_font_pix (
        .clk_lcd(clk), .i_char(ref_char[6:0]), .i_row(rowi), .o_bits(ref_glyph)
    );

    wire ref_bit = ref_glyph[7 - coli];
    wire exp_hit = in_area & ref_bit & pde & pen;

    // ---- 监视 ---------------------------------------------------------------
    integer err_hit, err_rgb, err_cc, err_cr, de_cnt;
    integer hits_p0, hits_p1, top_hits, bot_hits, out_area_err;
    integer fd, ppm_pix, ppm_ok, ppm_en;

    initial begin
        err_hit = 0; err_rgb = 0; err_cc = 0; err_cr = 0; de_cnt = 0;
        hits_p0 = 0; hits_p1 = 0; top_hits = 0; bot_hits = 0; out_area_err = 0;
        ppm_pix = 0; ppm_ok = 0; ppm_en = 0;
        fd = $fopen("hud_text.ppm", "wb");
        if (fd != 0) begin $fwrite(fd, "P6\n800 480\n255\n"); ppm_ok = 1; end
    end

    always @(posedge clk) begin
        if (rst_n) begin
            // 组合观察端口：与**当前**坐标同拍
            if (sweep_active && (sx >= TEXT_X) && (sx < TEXT_X + 32*CH_W) &&
                (sy >= TEXT_Y) && (sy < TEXT_Y + CH_H)) begin
                if (o_char_code !== tb_char[6:0]) err_cc = err_cc + 1;
                if (o_char_row  !== tb_row)       err_cr = err_cr + 1;
            end

            if (o_hit !== exp_hit) err_hit = err_hit + 1;
            if (o_rgb !== 24'hFFFFFF) err_rgb = err_rgb + 1;

            if (pde) begin
                de_cnt = de_cnt + 1;
                if (o_hit) begin
                    if (phase == 0) hits_p0 = hits_p0 + 1;
                    else            hits_p1 = hits_p1 + 1;
                    if (py < TEXT_Y + 16) top_hits = top_hits + 1;
                    else                  bot_hits = bot_hits + 1;
                    if (!in_area) out_area_err = out_area_err + 1;
                end
            end

            if (ppm_ok && ppm_en && pde) begin
                $fwrite(fd, "%c%c%c",
                        o_hit ? o_rgb[23:16] : 8'h00,
                        o_hit ? o_rgb[15:8]  : 8'h00,
                        o_hit ? o_rgb[7:0]   : 8'h00);
                ppm_pix = ppm_pix + 1;
            end
        end
    end

    // ---- 手算命中总数：Σ_char Σ_row popcount(glyph row) × SCALE² ------------
    // 单独一个 font_rom 实例，由 TB 直接驱动（不依赖扫描坐标）
    reg  [6:0] pc_char;
    reg  [3:0] pc_row;
    wire [7:0] pc_bits;
    font_rom u_pc_font (
        .clk_lcd(clk), .i_char(pc_char), .i_row(pc_row), .o_bits(pc_bits)
    );

    integer hp, ci, ri, bi;
    integer exp_total;
    reg [7:0] ch8;

    task calc_exp_total;
        begin
            exp_total = 0;
            for (ci = 0; ci < 32; ci = ci + 1) begin
                ch8     = TB_TEXT[(31-ci)*8 +: 8];
                pc_char = ch8[6:0];
                for (ri = 0; ri < 16; ri = ri + 1) begin
                    pc_row = ri[3:0];
                    #1;
                    for (bi = 0; bi < 8; bi = bi + 1)
                        if (pc_bits[bi]) exp_total = exp_total + 4;   // SCALE² = 4
                end
            end
        end
    endtask

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
        calc_exp_total;                  // 先算好手算参考
        ppm_en = 1;
        run_sweep;
        ppm_en = 0;
        phase = 1; ovl_en_r = 1'b0;
        run_sweep;
        if (fd != 0) $fclose(fd);

        chk("PIXEL_ALL",      err_hit == 0 && de_cnt == 2*(LCD_W*LCD_H));
        chk("CHAR_CODE",      err_cc == 0);
        chk("CHAR_ROW",       err_cr == 0);
        chk("H40_NO_REPEAT",  top_hits != bot_hits && top_hits > 0 && bot_hits > 0);
        chk("HIT_TOTAL",      hits_p0 == exp_total && exp_total > 0);
        chk("TEXT_AREA",      out_area_err == 0);
        chk("EN_GATE",        hits_p1 == 0);
        chk("PPM_FILE",       ppm_ok == 1 && ppm_pix == (LCD_W*LCD_H));
        chk("COLOR",          err_rgb == 0);

        $display("INFO=hits=%0d exp_total=%0d top=%0d bot=%0d err_hit=%0d err_cc=%0d err_cr=%0d",
                 hits_p0, exp_total, top_hits, bot_hits, err_hit, err_cc, err_cr);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
