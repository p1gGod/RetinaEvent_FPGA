// ============================================================================
// tb_hud_sprite.v -- OVL 平面 5（最高优先级）：图标/精灵
//
// 判据（hud_sprite.md §8）：
//   CHECK=PIXEL_ALL       全屏逐像素与 TB 几何模型一致（含包围盒/局部坐标）
//   CHECK=SPR0_RING       精灵 0（圆环）：逐像素一致 + 中心为**透明**（索引 0）
//   CHECK=SPR1_2_3        精灵 1/2/3（圆点/箭头/方框）：包围盒内逐像素一致
//   CHECK=BAD_ID          无效编号（id=5）整屏不命中
//   CHECK=TRANSPARENT     包围盒内索引 0 的像素不命中（§9.2）
//   CHECK=PALETTE         颜色 = 对应调色板项（4:4:4 位复制扩展）
//   CHECK=SCALE2          SCALE=2 实例命中数 = SCALE=1 的 4 倍（整数放大语义）
//   CHECK=OUT_BOX         包围盒外零命中
//   CHECK=PPM_FILE        导出 P6 PPM
// ============================================================================
`timescale 1ns/1ps

module tb_hud_sprite;

    localparam LCD_W = 800, LCD_H = 480;
    localparam SPR_X = 600, SPR_Y = 300;

    reg         clk, rst_n;
    reg  [10:0] sx, sy, X0, Y0, X1, Y1;
    reg         sweep_active, start;
    reg  [3:0]  sp_id;
    reg  [10:0] sp_x, sp_y;
    reg  [47:0] palette;

    wire        o_hit,  o_hit2;
    wire [23:0] o_rgb,  o_rgb2;

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

    hud_sprite #(.SCALE(1), .PIPE(1)) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx), .px_y(sy), .px_de(sweep_active), .ovl_en(1'b1),
        .ovl_hit(o_hit), .ovl_rgb(o_rgb),
        .i_sprite_id(sp_id), .i_sprite_x(sp_x), .i_sprite_y(sp_y), .i_palette(palette)
    );

    hud_sprite #(.SCALE(2), .PIPE(1)) u_dut2 (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx), .px_y(sy), .px_de(sweep_active), .ovl_en(1'b1),
        .ovl_hit(o_hit2), .ovl_rgb(o_rgb2),
        .i_sprite_id(sp_id), .i_sprite_x(sp_x), .i_sprite_y(sp_y), .i_palette(palette)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #60_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // ---- 扫描（窗口可设，便于按精灵包围盒快速遍历）------------------------
    always @(posedge clk) begin
        if (!rst_n) begin
            sx <= 11'd0; sy <= 11'd0; sweep_active <= 1'b0;
        end else if (start && !sweep_active) begin
            sweep_active <= 1'b1; sx <= X0; sy <= Y0;
        end else if (sweep_active) begin
            if (sx == X1 && sy == Y1) sweep_active <= 1'b0;
            else if (sx == X1) begin sx <= X0; sy <= sy + 11'd1; end
            else sx <= sx + 11'd1;
        end
    end

    reg [10:0] px, py;
    reg        pde;
    always @(posedge clk) begin px <= sx; py <= sy; pde <= sweep_active; end

    // ---- TB 几何模型（独立实现）-------------------------------------------
    function [2:0] spr_idx;
        input [3:0]  id;
        input [5:0]  lx;
        input [5:0]  ly;
        reg signed [6:0]  dxs, dys;
        reg signed [13:0] d2;
        reg [5:0] ady;
        begin
            dxs = $signed({1'b0, lx}) - 7'sd16;
            dys = $signed({1'b0, ly}) - 7'sd16;
            d2  = dxs*dxs + dys*dys;
            ady = dys[6] ? (6'd0 - dys[5:0]) : dys[5:0];
            spr_idx = 3'd0;
            case (id)
                4'd0: if ((d2 >= 14'sd36) && (d2 <= 14'sd144))               spr_idx = 3'd1;
                4'd1: if (d2 <= 14'sd49)                                     spr_idx = 3'd2;
                4'd2: if (((lx >= 6'd12) && (lx < 6'd27) && (ady <= (6'd27 - lx))) ||
                          ((lx >= 6'd4)  && (lx < 6'd12) && (ady <= 6'd3)))  spr_idx = 3'd3;
                4'd3: if ((lx < 6'd4) || (lx >= 6'd28) || (ly < 6'd4) || (ly >= 6'd28))
                                                                             spr_idx = 3'd4;
                default:                                                     spr_idx = 3'd0;
            endcase
        end
    endfunction

    function [23:0] pal_color;
        input [2:0] idx;
        reg [11:0] c;
        begin
            case (idx)
                3'd1: c = palette[11:0];
                3'd2: c = palette[23:12];
                3'd3: c = palette[35:24];
                3'd4: c = palette[47:36];
                default: c = 12'h000;
            endcase
            pal_color = {c[11:8], c[11:8], c[7:4], c[7:4], c[3:0], c[3:0]};
        end
    endfunction

    // 参考：用延迟 1 拍的坐标
    wire [10:0] lx1 = px - sp_x;
    wire [10:0] ly1 = py - sp_y;
    wire [10:0] boxw1 = 11'd32;          // SPR_W(32)*SCALE(1)
    wire in_box1 = (px >= sp_x) && (px < (sp_x + boxw1)) &&
                   (py >= sp_y) && (py < (sp_y + boxw1));
    wire [5:0] lxs1 = lx1[5:0];
    wire [5:0] lys1 = ly1[5:0];
    wire [2:0] ridx1 = spr_idx(sp_id, lxs1, lys1);
    wire       rexp_hit1 = in_box1 & pde & (ridx1 != 3'd0);
    wire [23:0] rexp_rgb1 = pal_color(ridx1);

    // SCALE=2 参考
    wire [10:0] lx2 = (px - sp_x) >> 1;
    wire [10:0] ly2 = (py - sp_y) >> 1;
    wire in_box2 = (px >= sp_x) && (px < (sp_x + 11'd64)) &&
                   (py >= sp_y) && (py < (sp_y + 11'd64));
    wire [2:0] ridx2 = spr_idx(sp_id, lx2[5:0], ly2[5:0]);
    wire       rexp_hit2 = in_box2 & pde & (ridx2 != 3'd0);

    // ---- 监视 ---------------------------------------------------------------
    integer err1, err2, hit1, hit2, de_cnt, phase_id;
    integer center_hit, out_box_err, zero_idx_hit;
    integer fd, ppm_pix, ppm_ok, ppm_en;
    integer ring_hits_s1, dot_hits_s2, dot_hits_s1;

    initial begin
        err1 = 0; err2 = 0; hit1 = 0; hit2 = 0; de_cnt = 0; phase_id = 0;
        center_hit = 0; out_box_err = 0; zero_idx_hit = 0;
        ppm_pix = 0; ppm_ok = 0; ppm_en = 0;
        ring_hits_s1 = 0; dot_hits_s2 = 0; dot_hits_s1 = 0;
        fd = $fopen("hud_sprite.ppm", "wb");
        if (fd != 0) begin $fwrite(fd, "P6\n800 480\n255\n"); ppm_ok = 1; end
    end

    always @(posedge clk) begin
        if (rst_n) begin
            if (o_hit !== rexp_hit1) err1 = err1 + 1;
            if (o_hit2 !== rexp_hit2) err2 = err2 + 1;
            if (o_hit && o_rgb !== rexp_rgb1) err1 = err1 + 1;

            if (pde) begin
                de_cnt = de_cnt + 1;
                if (o_hit) begin
                    hit1 = hit1 + 1;
                    if (phase_id == 0) ring_hits_s1 = ring_hits_s1 + 1;
                end
                if (o_hit2) hit2 = hit2 + 1;

                // 中心 8x8（环心）必须全透明——只在精灵 0（圆环）那一轮统计
                if (phase_id == 0 && in_box1 && (lxs1 >= 6'd14) && (lxs1 < 6'd18) &&
                    (lys1 >= 6'd14) && (lys1 < 6'd18) && o_hit)
                    center_hit = center_hit + 1;

                // 索引 0 的地方不得命中
                if (in_box1 && (ridx1 == 3'd0) && o_hit) zero_idx_hit = zero_idx_hit + 1;
                if (o_hit && !in_box1) out_box_err = out_box_err + 1;
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

    // ---- 激励 ---------------------------------------------------------------
    integer guard;
    task run_win;
        input [10:0] x0, y0, x1, y1;
        begin
            @(negedge clk);
            X0 = x0; Y0 = y0; X1 = x1; Y1 = y1;
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

    integer h1_before, h2_before;
    initial begin
        rst_n = 1'b0; start = 1'b0; sweep_active = 1'b0;
        sp_id = 4'd0; sp_x = SPR_X; sp_y = SPR_Y;
        palette = {12'h444, 12'h333, 12'h222, 12'h111};   // 入口4/3/2/1 = 444/333/222/111
        X0 = 11'd0; Y0 = 11'd0; X1 = LCD_W-1; Y1 = LCD_H-1;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;

        // 精灵 0（圆环）：全屏遍历 + PPM
        phase_id = 0; ppm_en = 1;
        run_win(11'd0, 11'd0, LCD_W-1, LCD_H-1);
        ppm_en = 0;

        // 精灵 1（圆点）：窗口要同时覆盖 SCALE=1(32x32) 与 SCALE=2(64x64) 包围盒
        sp_id = 4'd1; phase_id = 1;
        h1_before = hit1; h2_before = hit2;
        run_win(SPR_X-11'd2, SPR_Y-11'd2, SPR_X+11'd65, SPR_Y+11'd65);
        dot_hits_s1 = hit1 - h1_before;
        dot_hits_s2 = hit2 - h2_before;

        // 精灵 2/3：包围盒内
        sp_id = 4'd2; h1_before = hit1;
        run_win(SPR_X-11'd2, SPR_Y-11'd2, SPR_X+11'd34, SPR_Y+11'd34);
        sp_id = 4'd3; h1_before = hit1;
        run_win(SPR_X-11'd2, SPR_Y-11'd2, SPR_X+11'd34, SPR_Y+11'd34);

        // 无效编号：整屏不得命中
        sp_id = 4'd5; h1_before = hit1;
        run_win(11'd0, 11'd0, LCD_W-1, LCD_H-1);
        if (fd != 0) $fclose(fd);

        chk("PIXEL_ALL",    err1 == 0);
        chk("SPR0_RING",    ring_hits_s1 > 0 && center_hit == 0 && err1 == 0);
        chk("SPR1_2_3",     dot_hits_s1 > 0 && err2 == 0);
        chk("BAD_ID",       hit1 == h1_before);
        chk("TRANSPARENT",  zero_idx_hit == 0);
        chk("PALETTE",      err1 == 0 && ring_hits_s1 > 0);
        chk("SCALE2",       dot_hits_s2 == 4*dot_hits_s1 && dot_hits_s1 > 0);
        chk("OUT_BOX",      out_box_err == 0);
        chk("PPM_FILE",     ppm_ok == 1 && ppm_pix == (LCD_W*LCD_H));

        $display("INFO=ring=%0d dot1=%0d dot2=%0d center=%0d zeroidx=%0d outbox=%0d err1=%0d err2=%0d ppm=%0d",
                 ring_hits_s1, dot_hits_s1, dot_hits_s2, center_hit, zero_idx_hit, out_box_err, err1, err2, ppm_pix);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
