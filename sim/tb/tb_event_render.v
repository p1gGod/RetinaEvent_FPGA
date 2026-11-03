// ============================================================================
// tb_event_render.v -- 事件位图 -> 800x480 不透明事件画面（逐像素 + PPM 出图）
//
// 判据（event_render.md §8）：
//   CHECK=ADDR_FORMULA     o_bmp_rd_addr == ey*200 + (ex>>1)（16bit 冻结接口）
//   CHECK=DE_ALIGN_1       o_de 恰为 i_px_de 延迟 1 拍（BRAM 读延迟补偿）
//   CHECK=PIXEL_ALL        800x480 全部 384000 个像素逐点与参考一致
//   CHECK=ON_RED           位图 0xF -> 0xF800（ON 红）
//   CHECK=OFF_BLUE         位图 0x7 -> 0x001F（OFF 蓝）
//   CHECK=DECAY_BANDS      位图 0x3 -> 0x0010（中档余晖）、0x1 -> 0x4208（最弱）
//   CHECK=ZERO_IS_BLACK    位图 0x0 / 0x8（强度归零）-> 黑，且**不透明**
//   CHECK=BLOCK_2X2        ×2 放大：相邻 2x2 屏像素同色（由逐点比对隐含 + 显式统计）
//   CHECK=PPM_FILE         导出 P6 PPM 并核对字节数 = 800*480*3 + 15
//
// 位图模型：48,000 个 8bit 字（2 event px/字），同步读 1 拍（与真实 BRAM 一致）。
// ============================================================================
`timescale 1ns/1ps

module tb_event_render;

    localparam EV_W  = 400, EV_H = 240;
    localparam LCD_W = 800, LCD_H = 480;
    localparam WORDS = 48000;

    reg         clk, rst_n;
    reg  [10:0] sx, sy;
    reg         sweep_active, start;
    reg  [10:0] px, py;
    reg         pde;

    wire [15:0] bmp_addr;
    reg  [7:0]  bmp_rd;
    wire        o_de;
    wire [15:0] o_data;

    reg  [7:0]  bmp [0:WORDS-1];
    always @(posedge clk) bmp_rd <= bmp[bmp_addr];      // 同步读 1 拍

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

    // ---- 参考模型（TB 侧独立实现，直接按位图内容算期望）--------------------
    function [3:0] ev_status;            // 生成位图用的图案
        input [8:0] ex;
        input [7:0] ey;
        begin
            if (ex == {1'b0, ey})                                    ev_status = 4'h7;  // 对角 OFF
            else if (((ex[8:4] + ey[7:4]) & 1) == 0)                 ev_status = 4'hF;  // 棋盘 ON
            else if (ex >= 9'd100 && ex < 9'd150 && ey >= 8'd100 && ey < 8'd120)
                                                                    ev_status = 4'h3;  // 中档余晖
            else if (ex >= 9'd200 && ex < 9'd260 && ey >= 8'd30  && ey < 8'd60)
                                                                    ev_status = 4'h1;  // 最弱余晖
            else if (ex >= 9'd300 && ex < 9'd320 && ey >= 8'd150 && ey < 8'd160)
                                                                    ev_status = 4'h8;  // 极性位残留
            else if (ex >= 9'd350 && ex < 9'd370 && ey >= 8'd20  && ey < 8'd40)
                                                                    ev_status = 4'hC;  // 文档 §8 V1 用例
            else                                                     ev_status = 4'h0;
        end
    endfunction

    function [15:0] exp_color;           // 文档 §3 参数表 + 4bit 语义
        input [3:0] st;
        begin
            if (st[2:0] == 3'd0)       exp_color = 16'h0000;   // 黑（不透明）
            else if (st[2:0] >= 3'd4)  exp_color = st[3] ? 16'hF800 : 16'h001F;
            else if (st[2:0] >= 3'd2)  exp_color = st[3] ? 16'h9000 : 16'h0010;
            else                       exp_color = 16'h4208;
        end
    endfunction

    function [23:0] rgb565_to_888;
        input [15:0] p;
        begin
            rgb565_to_888 = {p[15:11], p[13:11], p[10:5], p[9:8], p[4:0], p[2:0]};
        end
    endfunction

    event_render u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .i_px_x(sx), .i_px_y(sy), .i_px_de(sweep_active),
        .o_bmp_rd_addr(bmp_addr), .i_bmp_rd_data(bmp_rd),
        .o_de(o_de), .o_data(o_data)
    );

    // ---- 时钟 / 超时 --------------------------------------------------------
    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #50_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // ---- 扫描发生（连续 384000 拍 de）--------------------------------------
    always @(posedge clk) begin
        if (!rst_n) begin
            sx <= 11'd0; sy <= 11'd0; sweep_active <= 1'b0;
        end else if (start && !sweep_active && sx == 11'd0 && sy == 11'd0) begin
            sweep_active <= 1'b1;
        end else if (sweep_active) begin
            if (sx == LCD_W-1 && sy == LCD_H-1) begin sweep_active <= 1'b0; end
            else if (sx == LCD_W-1) begin sx <= 11'd0; sy <= sy + 11'd1; end
            else sx <= sx + 11'd1;
        end
    end

    always @(posedge clk) begin
        px  <= sx;
        py  <= sy;
        pde <= sweep_active;
    end

    // ---- 位图填充（与 ev_status 同源；字内：低 4bit = ex 偶，高 4bit = ex 奇）----
    integer i, j;
    initial begin
        for (i = 0; i < EV_H; i = i + 1)
            for (j = 0; j < (EV_W/2); j = j + 1)
                bmp[i*(EV_W/2) + j] = { ev_status(2*j+1, i), ev_status(2*j, i) };
    end

    // ---- 监视 ---------------------------------------------------------------
    integer err_pix, err_de, err_addr, err_x, de_cnt;
    integer n_on, n_off, n_mid, n_weak, n_bg, err_2x2;
    integer fd, ppm_pix, ppm_ok;

    reg [10:0] ex_c, ey_c;
    reg [3:0]  st_c;
    reg [15:0] col_c;

    initial begin
        err_pix = 0; err_de = 0; err_addr = 0; err_x = 0; de_cnt = 0;
        n_on = 0; n_off = 0; n_mid = 0; n_weak = 0; n_bg = 0; err_2x2 = 0;
        ppm_pix = 0; ppm_ok = 0;
        fd = $fopen("event_render.ppm", "wb");
        if (fd != 0) begin
            $fwrite(fd, "P6\n800 480\n255\n");
            ppm_ok = 1;
        end
    end

    always @(posedge clk) begin
        if (rst_n) begin
            // 地址公式（组合，与当前 sx/sy 同拍）
            if (bmp_addr !== (sy[9:1] * 16'd200 + {9'd0, sx[10:2]})) err_addr = err_addr + 1;

            // de 延迟 1 拍
            if (o_de !== pde) err_de = err_de + 1;

            if (o_de) begin
                de_cnt  = de_cnt + 1;
                ex_c    = px[10:1];
                ey_c    = py[9:1];
                st_c    = (ex_c[0]) ? bmp[ey_c*200 + ex_c[9:1]][7:4]
                                    : bmp[ey_c*200 + ex_c[9:1]][3:0];
                col_c   = exp_color(st_c);

                if (o_data !== col_c) begin
                    err_pix = err_pix + 1;
                    if (err_pix <= 8)
                        $display("DBG%0d px=%0d py=%0d ex=%0d ey=%0d st=%h exp=%h got=%h rd=%h addr=%0d",
                                 err_pix, px, py, ex_c, ey_c, st_c, col_c, o_data, bmp_rd, bmp_addr);
                end
                if (o_data === 16'hxxxx) err_x = err_x + 1;

                case (st_c)
                    4'h0, 4'h8: n_bg   = n_bg   + 1;
                    4'hF, 4'hC: n_on   = n_on   + 1;
                    4'h7:       n_off  = n_off  + 1;
                    4'h3:       n_mid  = n_mid  + 1;
                    4'h1:       n_weak = n_weak + 1;
                    default:    n_bg   = n_bg   + 1;
                endcase

                if (ppm_ok) begin
                    $fwrite(fd, "%c%c%c",
                            rgb565_to_888(o_data) >> 16,
                            (rgb565_to_888(o_data) >> 8) & 8'hFF,
                            rgb565_to_888(o_data) & 8'hFF);
                    ppm_pix = ppm_pix + 1;
                end
            end
        end
    end

    // 显式 2x2 块一致性：
    //   横向：px[0]==1 时输出必须与上一拍（px 偶）相同
    //   纵向：py[0]==1 时输出必须与上一扫描行同列相同（row_snap 只在 py 偶时刷新）
    reg [15:0] o_data_d;
    reg [15:0] row_snap [0:799];
    always @(posedge clk) begin
        if (rst_n) begin
            o_data_d <= o_data;
            if (o_de) begin
                if (px[0] == 1'b1 && o_data !== o_data_d)            err_2x2 = err_2x2 + 1;
                if (py[0] == 1'b1 && o_data !== row_snap[px[10:0]])  err_2x2 = err_2x2 + 1;
                if (py[0] == 1'b0) row_snap[px[10:0]] <= o_data;
            end
        end
    end

    // ---- 激励 ---------------------------------------------------------------
    initial begin
        rst_n = 1'b0;
        start = 1'b0;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);
        start = 1'b1;
        @(negedge clk);
        start = 1'b0;

        while (sweep_active || de_cnt < (LCD_W*LCD_H)) @(negedge clk);
        repeat (4) @(negedge clk);

        if (fd != 0) $fclose(fd);

        chk("ADDR_FORMULA",  err_addr == 0);
        chk("DE_ALIGN_1",    err_de == 0);
        chk("PIXEL_ALL",     de_cnt == (LCD_W*LCD_H) && err_pix == 0);
        chk("ON_RED",        n_on   > 0);
        chk("OFF_BLUE",      n_off  > 0);
        chk("DECAY_BANDS",   n_mid  > 0 && n_weak > 0);
        chk("ZERO_IS_BLACK", n_bg   > 0);
        chk("BLOCK_2X2",     err_2x2 == 0);
        chk("PPM_FILE",      ppm_ok == 1 && ppm_pix == (LCD_W*LCD_H));
        chk("NO_X",          err_x == 0);

        $display("INFO=de=%0d err_pix=%0d err_addr=%0d err_de=%0d on=%0d off=%0d mid=%0d weak=%0d bg=%0d ppm=%0d",
                 de_cnt, err_pix, err_addr, err_de, n_on, n_off, n_mid, n_weak, n_bg, ppm_pix);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
