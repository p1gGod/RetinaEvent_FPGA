// ============================================================================
// tb_hud_panel.v -- OVL 平面 3：仪表盘 / 统计条
//
// 判据（hud_panel.md §8）：
//   CHECK=PANEL_RECT     命中只出现在面板矩形内，且整块面板 320x152 = 48640 像素全命中
//   CHECK=DIGITS_FPS     line3 "MODE:R+E FPS:026" 逐位核对（v3.1 模式标签 + 帧率）
//   CHECK=BAR_LEN        条长 ∝ ρ：rho=0.5 -> 100x10=1000；rho=0.25 -> 50x10=500
//   CHECK=BAR_TRACK      条槽剩余部分 = (304-bar_len)x10
//   CHECK=DIGITS_EV      "123456" 逐位与 o_char_code 一致（含位数顺序）
//   CHECK=DIGITS_CRX10   "004567"
//   CHECK=DIGITS_PCT     ρ=0.5 -> "050"（百分比 x100 定点）
//   CHECK=TEXT_PIX       文字像素 = FG_COLOR 且只落在 3 行文字区内
//   CHECK=DE_GATE        px_de=0 时不命中
//   CHECK=PPM_FILE       导出 P6 PPM，像素数 = 384000
// ============================================================================
`timescale 1ns/1ps

module tb_hud_panel;

    localparam LCD_W = 800, LCD_H = 480;
    localparam PX = 8, PY = 8, PW = 320, PH = 152;   // ★ v3.1: 面板加高（line3）
    localparam TX_OFF = 8, CELL_W = 16;
    localparam BAR_XOFF = 8, BAR_Y0 = PH - 14, BAR_Y1 = PH - 4, BAR_W = PW - 16;

    localparam FG_COLOR  = 24'hFFFFFF;
    localparam BG_COLOR  = 24'h101820;
    localparam BAR_COLOR = 24'hE04040;
    localparam BAR_TRACK = 24'h202830;

    reg         clk, rst_n;
    reg  [10:0] sx, sy, X1, Y1;
    reg         sweep_active, start;
    reg         man_en;
    reg  [10:0] man_x, man_y;
    reg  [15:0] q16;
    reg  [23:0] evpf, crx10;
    reg  [1:0]  mode_tag;
    reg  [7:0]  fps_val;

    wire [10:0] sx_eff = man_en ? man_x : sx;
    wire [10:0] sy_eff = man_en ? man_y : sy;

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

    hud_panel #(.PIPE(1)) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx_eff), .px_y(sy_eff), .px_de(sweep_active), .ovl_en(1'b1),
        .ovl_hit(o_hit), .ovl_rgb(o_rgb),
        .i_activity_q16(q16), .i_ev_per_frame(evpf), .i_cr_x10(crx10),
        .i_frame_cnt(32'd1000),
        .i_mode_tag(mode_tag), .i_fps(fps_val),
        .o_char_code(o_char_code), .o_char_row(o_char_row)
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
            if (sx == X1 && sy == Y1) sweep_active <= 1'b0;
            else if (sx == X1) begin sx <= 11'd0; sy <= sy + 11'd1; end
            else sx <= sx + 11'd1;
        end
    end

    reg [10:0] px, py;
    reg        pde;
    always @(posedge clk) begin px <= sx; py <= sy; pde <= sweep_active; end

    // ---- 参考 --------------------------------------------------------------
    wire in_panel = (px >= PX) && (px < (PX+PW)) && (py >= PY) && (py < (PY+PH));
    wire [10:0] lx = px - PX;
    wire [10:0] ly = py - PY;
    wire bar_track = (lx >= BAR_XOFF) && (lx < (BAR_XOFF + BAR_W)) &&
                     (ly >= BAR_Y0) && (ly < BAR_Y1);

    // ---- 监视 ---------------------------------------------------------------
    integer err_hit, err_col, de_cnt;
    integer hit_cnt, out_rect_err, fg_cnt, fg_out_err, de_gate_hits;
    integer bar_fill_s1, bar_track_s1, bar_fill_s2;
    integer fd, ppm_pix, ppm_ok, ppm_en, phase;

    initial begin
        err_hit = 0; err_col = 0; de_cnt = 0;
        hit_cnt = 0; out_rect_err = 0; fg_cnt = 0; fg_out_err = 0; de_gate_hits = 0;
        bar_fill_s1 = 0; bar_track_s1 = 0; bar_fill_s2 = 0;
        ppm_pix = 0; ppm_ok = 0; ppm_en = 0; phase = 0;
        fd = $fopen("hud_panel.ppm", "wb");
        if (fd != 0) begin $fwrite(fd, "P6\n800 480\n255\n"); ppm_ok = 1; end
    end

    always @(posedge clk) begin
        if (rst_n) begin
            if (o_hit !== in_panel) err_hit = err_hit + 1;

            if (pde) begin
                de_cnt = de_cnt + 1;
                if (o_hit) begin
                    hit_cnt = hit_cnt + 1;
                    if (!in_panel) out_rect_err = out_rect_err + 1;
                    if (o_rgb == FG_COLOR) begin
                        fg_cnt = fg_cnt + 1;
                        if (!(ly >= 4 && ly < 132)) fg_out_err = fg_out_err + 1; // ★ v3.1: 4 行
                    end
                    if (o_rgb == BAR_COLOR) begin
                        if (phase == 0) bar_fill_s1 = bar_fill_s1 + 1;
                        else            bar_fill_s2 = bar_fill_s2 + 1;
                    end
                    if (phase == 0 && o_rgb == BAR_TRACK) bar_track_s1 = bar_track_s1 + 1;
                    if (o_rgb != FG_COLOR && o_rgb != BAR_COLOR &&
                        o_rgb != BAR_TRACK && o_rgb != BG_COLOR) err_col = err_col + 1;
                end
            end

            // 文字像素必须落在条形区之外
            if (pde && o_hit && bar_track && o_rgb == FG_COLOR) fg_out_err = fg_out_err + 1;

            if (ppm_ok && ppm_en && pde) begin
                $fwrite(fd, "%c%c%c",
                        o_hit ? o_rgb[23:16] : 8'h00,
                        o_hit ? o_rgb[15:8]  : 8'h00,
                        o_hit ? o_rgb[7:0]   : 8'h00);
                ppm_pix = ppm_pix + 1;
            end
        end
    end

    // ---- 单字符检查（手动坐标，o_char_code 组合输出）----------------------
    integer cc_err;
    initial cc_err = 0;
    task chk_char;
        input [1:0]  line;
        input [4:0]  cx;
        input [7:0]  exp;
        input [255:0] nm;
        begin
            @(negedge clk);
            man_en = 1'b1;
            man_x  = PX + TX_OFF + cx*CELL_W + 11'd3;
            man_y  = PY + ((line == 2'd0) ? 11'd4  :
                           (line == 2'd1) ? 11'd36 :
                           (line == 2'd2) ? 11'd68 : 11'd100) + 11'd1;   // ★ v3.1: line3
            #1;
            if (o_char_code !== exp[6:0]) begin
                cc_err = cc_err + 1;
                $display("CHKCHAR %0s line=%0d cx=%0d got=%h(%c) exp=%h(%c)",
                         nm, line, cx, o_char_code, o_char_code, exp[6:0], exp[6:0]);
            end
            @(negedge clk);
            man_en = 1'b0;
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
        rst_n = 1'b0; start = 1'b0; man_en = 1'b0; man_x = 11'd0; man_y = 11'd0;
        X1 = LCD_W-1; Y1 = LCD_H-1;
        q16 = 16'd32768;                    // rho = 0.5 -> bar_len = 100
        evpf = 24'd123456;
        crx10 = 24'd4567;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;

        phase = 0; ppm_en = 1;
        run_sweep;                          // rho = 0.5
        ppm_en = 0;

        phase = 1; q16 = 16'd16384;         // rho = 0.25 -> bar_len = 50
        run_sweep;

        // ---- 数字逐位核对（含位数顺序）----
        q16 = 16'd32768;                    // 复位 rho=0.5，使百分比 = 50 -> "050"
        mode_tag = 2'd0; fps_val = 8'd26;   // ★ v3.1: line3 = "MODE:R+E FPS:026"
        chk_char(2'd3, 5'd0, "M", "L3_0");
        chk_char(2'd3, 5'd3, "E", "L3_3");
        chk_char(2'd3, 5'd4, ":", "L3_4");
        chk_char(2'd3, 5'd5, "R", "L3_5");
        chk_char(2'd3, 5'd6, "+", "L3_6");
        chk_char(2'd3, 5'd7, "E", "L3_7");
        chk_char(2'd3, 5'd9,  "F", "L3_9");
        chk_char(2'd3, 5'd12, ":", "L3_12");
        chk_char(2'd3, 5'd13, "0", "L3_13");
        chk_char(2'd3, 5'd14, "2", "L3_14");
        chk_char(2'd3, 5'd15, "6", "L3_15");
        mode_tag = 2'd2;                    // ★ v3.1: EV_ONLY -> "MODE:E  FPS:026"
        chk_char(2'd3, 5'd5, "E", "L3_tag2_5");
        chk_char(2'd3, 5'd6, " ", "L3_tag2_6");
        mode_tag = 2'd1;                    // ★ v3.1: RAW_ONLY -> "MODE:R  FPS:026"
        chk_char(2'd3, 5'd5, "R", "L3_tag1_5");
        mode_tag = 2'd0;
        chk_char(2'd0, 5'd0, "E", "L0_0");
        chk_char(2'd0, 5'd5, ":", "L0_5");
        chk_char(2'd0, 5'd6,  "1", "L0_6");
        chk_char(2'd0, 5'd7,  "2", "L0_7");
        chk_char(2'd0, 5'd8,  "3", "L0_8");
        chk_char(2'd0, 5'd9,  "4", "L0_9");
        chk_char(2'd0, 5'd10, "5", "L0_10");
        chk_char(2'd0, 5'd11, "6", "L0_11");

        chk_char(2'd1, 5'd0, "C", "L1_0");
        chk_char(2'd1, 5'd5, ":", "L1_5");
        chk_char(2'd1, 5'd6,  "0", "L1_6");
        chk_char(2'd1, 5'd7,  "0", "L1_7");
        chk_char(2'd1, 5'd8,  "4", "L1_8");
        chk_char(2'd1, 5'd9,  "5", "L1_9");
        chk_char(2'd1, 5'd10, "6", "L1_10");
        chk_char(2'd1, 5'd11, "7", "L1_11");

        chk_char(2'd2, 5'd0, "R", "L2_0");
        chk_char(2'd2, 5'd3, ":", "L2_3");
        chk_char(2'd2, 5'd4, "0", "L2_4");
        chk_char(2'd2, 5'd5, "5", "L2_5");
        chk_char(2'd2, 5'd6, "0", "L2_6");
        chk_char(2'd2, 5'd7, "%", "L2_7");

        if (fd != 0) $fclose(fd);

        chk("PANEL_RECT",   err_hit == 0 && out_rect_err == 0 && hit_cnt == 2*(PW*PH));
        chk("BAR_LEN",      bar_fill_s1 == (100*10) && bar_fill_s2 == (50*10));
        chk("BAR_TRACK",    bar_track_s1 == ((BAR_W - 100)*10));
        chk("DIGITS_EV",    cc_err == 0);
        chk("DIGITS_CRX10", cc_err == 0);
        chk("DIGITS_PCT",   cc_err == 0);
        chk("DIGITS_FPS",   cc_err == 0);
        chk("TEXT_PIX",     fg_cnt > 0 && fg_out_err == 0);
        chk("COLOR_SET",    err_col == 0);
        chk("DE_GATE",      de_cnt == 2*(LCD_W*LCD_H));
        chk("PPM_FILE",     ppm_ok == 1 && ppm_pix == (LCD_W*LCD_H));

        $display("INFO=hits=%0d fill1=%0d fill2=%0d track1=%0d fg=%0d err_hit=%0d err_col=%0d cc_err=%0d",
                 hit_cnt, bar_fill_s1, bar_fill_s2, bar_track_s1, fg_cnt, err_hit, err_col, cc_err);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
