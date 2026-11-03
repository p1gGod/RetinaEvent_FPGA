// ============================================================================
// tb_hud_event_layer.v -- OVL 平面 2：事件位图**透明**叠加层（逐像素 + PPM）
//
// 与 tb_event_render 用**同一份**位图图案，便于两张 PPM 交叉比对几何位置。
//
// 判据（hud_event_layer.md §8）：
//   CHECK=ADDR_FORMULA    o_bmp_rd_addr == ey*200 + (ex>>1)（16bit 冻结接口）
//   CHECK=PIXEL_ALL       800x480 全像素：命中 = (状态!=0)，颜色按类别一致
//   CHECK=ON_0XC          文档 §8 V1：位图 0xC -> ON 红 0xFF3030
//   CHECK=TRANSPARENT     位图为 0（含 0x8）处**不命中**（不遮挡原图）
//   CHECK=HIT_COUNT       命中像素数 = 4 x 非零事件像素数（手算交叉校验）
//   CHECK=BLOCK_2X2       ×2 放大：相邻 2x2 屏像素命中与颜色一致
//   CHECK=PPM_FILE        导出 P6 PPM（供与 event_render.ppm 比对位置）
// ============================================================================
`timescale 1ns/1ps

module tb_hud_event_layer;

    localparam LCD_W = 800, LCD_H = 480;
    localparam WORDS = 48000;

    reg         clk, rst_n;
    reg  [10:0] sx, sy;
    reg         sweep_active, start;
    reg  [10:0] px, py;
    reg         pde;

    wire [15:0] bmp_addr;
    reg  [7:0]  bmp_rd;
    wire        o_hit;
    wire [23:0] o_rgb;

    reg  [7:0]  bmp [0:WORDS-1];
    always @(posedge clk) bmp_rd <= bmp[bmp_addr];

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

    function [3:0] ev_status;              // ★ 必须与 tb_event_render 完全一致
        input [8:0] ex;
        input [7:0] ey;
        begin
            if (ex == {1'b0, ey})                                    ev_status = 4'h7;
            else if (((ex[8:4] + ey[7:4]) & 1) == 0)                 ev_status = 4'hF;
            else if (ex >= 9'd100 && ex < 9'd150 && ey >= 8'd100 && ey < 8'd120)
                                                                    ev_status = 4'h3;
            else if (ex >= 9'd200 && ex < 9'd260 && ey >= 8'd30  && ey < 8'd60)
                                                                    ev_status = 4'h1;
            else if (ex >= 9'd300 && ex < 9'd320 && ey >= 8'd150 && ey < 8'd160)
                                                                    ev_status = 4'h8;
            else if (ex >= 9'd350 && ex < 9'd370 && ey >= 8'd20  && ey < 8'd40)
                                                                    ev_status = 4'hC;
            else                                                     ev_status = 4'h0;
        end
    endfunction

    function [23:0] exp_rgb;
        input [3:0] st;
        begin
            if (st[2:0] >= 3'd4)     exp_rgb = st[3] ? 24'hFF3030 : 24'h3080FF;
            else if (st[2:0] >= 3'd2) exp_rgb = st[3] ? 24'h902020 : 24'h204878;
            else                      exp_rgb = 24'h404040;
        end
    endfunction

    hud_event_layer u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(sx), .px_y(sy), .px_de(sweep_active), .ovl_en(1'b1),
        .ovl_hit(o_hit), .ovl_rgb(o_rgb),
        .o_bmp_rd_addr(bmp_addr), .i_bmp_rd_data(bmp_rd)
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

    always @(posedge clk) begin
        px <= sx; py <= sy; pde <= sweep_active;
    end

    // ---- 位图填充（与 tb_event_render 同源）-------------------------------
    integer i, j;
    initial begin
        for (i = 0; i < 240; i = i + 1)
            for (j = 0; j < 200; j = j + 1)
                bmp[i*200 + j] = { ev_status(2*j+1, i), ev_status(2*j, i) };
    end

    // ---- 监视 ---------------------------------------------------------------
    integer err_hit, err_rgb, err_addr, de_cnt, hit_cnt, exp_hits;
    integer n_zero_px, hit_zero_err;
    integer onC_hit, onC_rgb_err, onC_seen;
    integer err_2x2;
    integer fd, ppm_pix, ppm_ok;

    reg [10:0] ex_c, ey_c;
    reg [3:0]  st_c;
    reg [23:0] o_rgb_d;
    reg        o_hit_d;
    reg [23:0] row_snap [0:799];
    reg        row_snap_v [0:799];

    initial begin
        err_hit = 0; err_rgb = 0; err_addr = 0; de_cnt = 0; hit_cnt = 0; exp_hits = 0;
        n_zero_px = 0; hit_zero_err = 0;
        onC_hit = 0; onC_rgb_err = 0; onC_seen = 0;
        err_2x2 = 0;
        ppm_pix = 0; ppm_ok = 0;
        fd = $fopen("hud_event_layer.ppm", "wb");
        if (fd != 0) begin $fwrite(fd, "P6\n800 480\n255\n"); ppm_ok = 1; end
        // 手算参考：**强度非 0** 的事件像素数 x 4（SCALE=2 -> 2x2 块）
        //   （0x8 = 极性残留、强度 0 -> 透明，不计）
        for (i = 0; i < 240; i = i + 1)
            for (j = 0; j < 400; j = j + 1)
                if (ev_status(j, i) != 4'h0 && ev_status(j, i) != 4'h8) exp_hits = exp_hits + 4;
    end

    always @(posedge clk) begin
        if (rst_n) begin
            if (bmp_addr !== (sy[9:1] * 16'd200 + {9'd0, sx[10:2]})) err_addr = err_addr + 1;

            if (pde) begin
                de_cnt  = de_cnt + 1;
                ex_c    = px[10:1];
                ey_c    = py[9:1];
                st_c    = (ex_c[0]) ? bmp[ey_c*200 + ex_c[9:1]][7:4]
                                    : bmp[ey_c*200 + ex_c[9:1]][3:0];

                // 4bit 语义：bit[2:0]==0（含 0x8 极性残留）视为"无事件" -> 透明
                if ((st_c[2:0] != 3'd0) !== o_hit) err_hit = err_hit + 1;
                if (st_c[2:0] == 3'd0) begin
                    n_zero_px = n_zero_px + 1;
                    if (o_hit) hit_zero_err = hit_zero_err + 1;
                end else begin
                    if (o_hit) begin
                        hit_cnt = hit_cnt + 1;
                        if (o_rgb !== exp_rgb(st_c)) err_rgb = err_rgb + 1;
                    end
                end

                // 文档 §8 V1 显式用例：位图 = 0xC
                if (st_c == 4'hC && px[0] == 1'b0 && py[0] == 1'b0) begin
                    onC_seen = onC_seen + 1;
                    if (o_hit) onC_hit = onC_hit + 1;
                    if (o_rgb !== 24'hFF3030) onC_rgb_err = onC_rgb_err + 1;
                end

                // 2x2 一致性：横向比上一拍（px-1，同行）；纵向比上一扫描行同列
                if (px[0] == 1'b1) begin
                    if (o_hit !== o_hit_d) err_2x2 = err_2x2 + 1;
                    else if (o_hit && o_rgb !== o_rgb_d) err_2x2 = err_2x2 + 1;
                end
                if (py[0] == 1'b1) begin
                    if (o_hit !== row_snap_v[px[10:0]]) err_2x2 = err_2x2 + 1;
                    else if (o_hit && o_rgb !== row_snap[px[10:0]]) err_2x2 = err_2x2 + 1;
                end
                if (py[0] == 1'b0) begin
                    row_snap[px[10:0]]   <= o_rgb;
                    row_snap_v[px[10:0]] <= o_hit;
                end
            end

            o_hit_d <= o_hit;
            o_rgb_d <= o_rgb;

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
    initial begin
        rst_n = 1'b0; start = 1'b0;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);
        start = 1'b1;
        @(negedge clk);
        start = 1'b0;
        while (sweep_active) @(negedge clk);
        repeat (3) @(negedge clk);
        if (fd != 0) $fclose(fd);

        chk("ADDR_FORMULA", err_addr == 0);
        chk("PIXEL_ALL",    err_hit == 0 && err_rgb == 0 && de_cnt == (LCD_W*LCD_H));
        chk("ON_0XC",       onC_seen > 0 && onC_hit == onC_seen && onC_rgb_err == 0);
        chk("TRANSPARENT",  n_zero_px > 0 && hit_zero_err == 0);
        chk("HIT_COUNT",    hit_cnt == exp_hits);
        chk("BLOCK_2X2",    err_2x2 == 0);
        chk("PPM_FILE",     ppm_ok == 1 && ppm_pix == (LCD_W*LCD_H));

        $display("INFO=de=%0d hits=%0d exp_hits=%0d zero=%0d err_hit=%0d err_rgb=%0d onC=%0d/%0d err2x2=%0d",
                 de_cnt, hit_cnt, exp_hits, n_zero_px, err_hit, err_rgb, onC_hit, onC_seen, err_2x2);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
