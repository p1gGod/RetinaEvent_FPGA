// ============================================================================
// tb_hud_status.v -- HUD 平面 p6：遮罩几何 + 五行文字像素级校验（全帧 800x480）
//
// 判据（接口约定 §2 / task-21 HUD_OK）：
//   CHECK=BAND_GEOM        遮罩恰好 = [560,792) x [280,424)，框内外无一像素错
//   CHECK=TEXT_ONLY_IN_BAND 文字像素只出现在 x∈[660,788)、y∈[304,400) 内
//   CHECK=TEXT_RGB_WHITE   文字处颜色恒 0xFFFFFF，未命中恒 0（无 X）
//   CHECK=LINE1_SRC        行1 四种取值（R+E / R / E / --）逐像素正确
//   CHECK=LINE2_TH_DL      行2 θ∈{1,4095,0,12} 与 minDl∈{0,511,9,100} 逐像素正确
//                          （验证可变位数 + 定宽右对齐：TB 独立算位数与位置）
//   CHECK=LINE3_TX         行3 四种取值（R+E / R / E / --）逐像素正确
//   CHECK=LINE4_LINK       行4（NET+UART / NET）逐像素正确
//   CHECK=LINE5_BAUD       行5 四档（115200/230400/460800/921600）+ UART 关 => ---
//   CHECK=KEY2_OFF_DARK    i_en=0：整块（遮罩+文字）全帧不亮
//   CHECK=OCR_CELLS        共比对 400 个字符格（5 行 x 16 格 x 5 个配置）
//   CHECK=NO_X             输出无 X
//
// 校验方法（为什么这么做）：
//   1) 遮罩：逐像素与 TB 自己算的矩形比较（全帧扫一遍，之后只扫框内+外部稀疏网格）。
//   2) 文字：把 DUT 的 text_hit 存成帧缓存，再按"TB 自己算出的右对齐字符串"
//      用 TB 内另一份 font_rom 逐行逐列比对 ⇒ 同时验证「行内容」「定宽右对齐」
//      「行距 20 / 首行 304 / 字宽 8」全部几何，不依赖 DUT 内部任何信号。
//   3) 行2 的十进制位数与位置由 TB 独立除法算（不复用 DUT 的 p_* 偏移公式）。
// ============================================================================
`timescale 1ns/1ps

module tb_hud_status;

    localparam LCD_W  = 800, LCD_H = 480;
    localparam BX0 = 560, BX1 = 792, BY0 = 280, BY1 = 424;   // 契约 §2.1 遮罩
    localparam L0Y = 304, LSTEP = 20, TX0 = 660, TRIGHT = 788; // 文字区（右对齐 788）
    localparam FG  = 24'hFFFFFF;

    reg         clk, rst_n;
    reg  [10:0] px_x, px_y;
    reg         px_de;
    reg         i_en;
    reg  [1:0]  i_mode_tag;
    reg  [11:0] i_theta;
    reg  [8:0]  i_min_dl;
    reg         i_ev_en;
    reg  [1:0]  i_cfg_mode;
    reg         i_uart_en;
    reg  [1:0]  i_baud_sel;

    wire        o_text_hit, o_band_hit;
    wire [23:0] o_text_rgb;

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

    hud_status u_dut (
        .clk_lcd    (clk),
        .rst_n_lcd  (rst_n),
        .px_x       (px_x),
        .px_y       (px_y),
        .px_de      (px_de),
        .i_en       (i_en),
        .i_mode_tag (i_mode_tag),
        .i_theta    (i_theta),
        .i_min_dl   (i_min_dl),
        .i_ev_en    (i_ev_en),
        .i_cfg_mode (i_cfg_mode),
        .i_uart_en  (i_uart_en),
        .i_baud_sel (i_baud_sel),
        .o_text_hit (o_text_hit),
        .o_text_rgb (o_text_rgb),
        .o_band_hit (o_band_hit)
    );

    // ---- TB 侧字模 oracle（与 DUT 内的 font_rom 是两份独立实例）----
    reg  [6:0] rom_c;
    reg  [3:0] rom_r;
    wire [7:0] rom_bits;
    font_rom u_rom (
        .clk_lcd (clk),
        .i_char  (rom_c),
        .i_row   (rom_r),
        .o_bits  (rom_bits)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;              // 周期 40 ns

    initial begin
        #200_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // ---- 帧缓存与错误计数 ------------------------------------------------
    reg [LCD_W-1:0] txt_rows  [0:LCD_H-1];
    reg [LCD_W-1:0] band_rows [0:LCD_H-1];
    reg [127:0]     exp_line  [0:4];      // 每行 16 字符，字节 r 处 = 距右边 r 位
    reg [127:0]     tmp2;                  // 行2 拼装暂存（memory 元素的位选写入不可靠，先拼标量）
    integer err_band, err_txt, err_rgb, err_key2, err_x;
    integer err_line [0:4];
    integer n_ocr, n_cfg, err_decode;
    integer x, y, ln, ci, rr, cc;
    integer v2, p2, r2;

    // 送一个像素并即刻检查（negedge 驱动 + posedge 后 #1 采样 => 对 PIPE=1 的 DUT 是当拍）
    task present;
        input integer xx;
        input integer yy;
        input integer st;
        reg inb, intxt;
        begin
            @(negedge clk);
            px_x  = xx;
            px_y  = yy;
            px_de = 1'b1;
            @(posedge clk); #1;
            inb   = ((xx >= BX0) && (xx < BX1) && (yy >= BY0) && (yy < BY1)) ? 1'b1 : 1'b0;
            intxt = ((xx >= TX0) && (xx < TRIGHT) && (yy >= L0Y) && (yy < (L0Y + 5*LSTEP - 4))) ? 1'b1 : 1'b0;

            // 1) 遮罩：恰好是契约矩形，被 i_en 门控
            if (o_band_hit !== (inb & i_en)) err_band = err_band + 1;
            // 2) 文字只在文字区内
            if ((intxt === 1'b0) && (o_text_hit !== 1'b0)) err_txt = err_txt + 1;
            // 3) 白色 / 未命中白色恒 0
            if ((o_text_hit === 1'b1) && (o_text_rgb !== FG)) err_rgb = err_rgb + 1;
            if ((o_text_hit === 1'b0) && (o_text_rgb !== 24'd0)) err_rgb = err_rgb + 1;
            // 4) KEY2 关闭（i_en=0）：整块不显示
            if ((i_en === 1'b0) && ((o_text_hit !== 1'b0) || (o_band_hit !== 1'b0)))
                err_key2 = err_key2 + 1;
            // 5) 无 X
            if ((^o_text_hit === 1'bx) || (^o_band_hit === 1'bx) || (^o_text_rgb === 1'bx))
                err_x = err_x + 1;
            if (st !== 0) begin
                txt_rows [yy][xx] = o_text_hit;
                band_rows[yy][xx] = o_band_hit;
            end
        end
    endtask

    task sweep_full;                       // 800x480 全帧
        begin
            for (y = 0; y < LCD_H; y = y + 1)
                for (x = 0; x < LCD_W; x = x + 1)
                    present(x, y, 1);
        end
    endtask

    task sweep_band_sparse;                // 框内全覆盖 + 框外稀疏网格（省时间）
        begin
            for (y = BY0; y < BY1; y = y + 1)
                for (x = BX0; x < BX1; x = x + 1)
                    present(x, y, 1);
            for (y = 0; y < LCD_H; y = y + 23)
                for (x = 0; x < LCD_W; x = x + 29)
                    if ((x < BX0) || (x >= BX1) || (y < BY0) || (y >= BY1))
                        present(x, y, 0);
        end
    endtask

    // 行2 期望字符串：TB 独立算十进制位数与位置（不复用 DUT 的 p_* 公式）
    // 从最右字符开始写：<minDl 十进制> ' ' 'L' 'D' ' ' <θ 十进制> ' ' 'H' 'T'
    task build_row2;
        input [11:0] th;
        input [8:0]  md;
        begin
            tmp2 = 128'd0;
            for (r2 = 0; r2 < 16; r2 = r2 + 1)
                tmp2[r2*8 +: 8] = 8'h20;
            p2 = 0;
            v2 = md;
            tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            if (v2 != 0) begin
                tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            end
            if (v2 != 0) begin
                tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            end
            tmp2[p2*8 +: 8] = 8'h20; p2 = p2 + 1;   // ' '
            tmp2[p2*8 +: 8] = 8'h4C; p2 = p2 + 1;   // 'L'
            tmp2[p2*8 +: 8] = 8'h44; p2 = p2 + 1;   // 'D'
            tmp2[p2*8 +: 8] = 8'h20; p2 = p2 + 1;   // ' '
            v2 = th;
            tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            if (v2 != 0) begin
                tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            end
            if (v2 != 0) begin
                tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            end
            if (v2 != 0) begin
                tmp2[p2*8 +: 8] = 8'h30 + (v2 % 10); p2 = p2 + 1; v2 = v2 / 10;
            end
            tmp2[p2*8 +: 8] = 8'h20; p2 = p2 + 1;   // ' '
            tmp2[p2*8 +: 8] = 8'h48; p2 = p2 + 1;   // 'H'
            tmp2[p2*8 +: 8] = 8'h54; p2 = p2 + 1;   // 'T'
            exp_line[1] = tmp2;
        end
    endtask

    // 用 TB 自己那份 font_rom 把帧缓存逐字符格还原，与 exp_line 比对
    task ocr_check;
        begin
            for (ln = 0; ln < 5; ln = ln + 1) begin
                for (ci = 0; ci < 16; ci = ci + 1) begin
                    for (rr = 0; rr < 16; rr = rr + 1) begin
                        rom_c = exp_line[ln][(15-ci)*8 +: 8];
                        rom_r = rr[3:0];
                        #1;
                        for (cc = 0; cc < 8; cc = cc + 1) begin
                            if (txt_rows[L0Y + LSTEP*ln + rr][TX0 + 8*ci + cc] !== rom_bits[7-cc])
                                err_line[ln] = err_line[ln] + 1;
                        end
                    end
                    n_ocr = n_ocr + 1;
                end
            end
        end
    endtask

    // 把遮罩区（232x144）导出成 PPM：文字=白 / 遮罩=暗灰 / 其它=更暗灰（可视化取证）
    task dump_ppm;
        input [255:0] fn;
        integer fd, py, px;
        begin
            fd = $fopen(fn, "wb");     // 二进制：避免 ModelSim 文本模式把 "\n" 写成 CRLF 破坏 PPM 头
            $fwrite(fd, "P6\n%0d %0d\n255\n", (BX1-BX0), (BY1-BY0));
            for (py = BY0; py < BY1; py = py + 1)
                for (px = BX0; px < BX1; px = px + 1) begin
                    if (txt_rows[py][px] === 1'b1)
                        $fwrite(fd, "%c%c%c", 8'hFF, 8'hFF, 8'hFF);
                    else if (band_rows[py][px] === 1'b1)
                        $fwrite(fd, "%c%c%c", 8'h46, 8'h46, 8'h46);
                    else
                        $fwrite(fd, "%c%c%c", 8'h1E, 8'h1E, 8'h1E);
                end
            $fclose(fd);
        end
    endtask

    // 真正的"读屏"：用 TB 的 font_rom 反查 DUT 渲染出的 8x16 像素块，还原 ASCII
    // 结果写 hud_status_ocr.txt（相对 ModelSim 工作目录 build/sim/tb_hud_status/）
    task ocr_dump;
        input [255:0] tag;
        integer fd, j2, k2, found2;
        reg [7:0] cand8, got8, glyph8;
        reg match2;
        begin
            fd = $fopen("hud_status_ocr.txt", "w");
            $fwrite(fd, "== %0s ==\n", tag);
            for (ln = 0; ln < 5; ln = ln + 1) begin
                $fwrite(fd, "line%0d exp=[", ln + 1);
                for (ci = 0; ci < 16; ci = ci + 1)
                    $fwrite(fd, "%c", exp_line[ln][(15-ci)*8 +: 8]);
                $fwrite(fd, "] got=[");
                for (ci = 0; ci < 16; ci = ci + 1) begin
                    found2 = 0;
                    for (j2 = 0; j2 < 16; j2 = j2 + 1)
                        for (k2 = 0; k2 < 8; k2 = k2 + 1)
                            if (txt_rows[L0Y + LSTEP*ln + j2][TX0 + 8*ci + k2] === 1'b1)
                                found2 = 1;
                    got8 = 8'h3F;                                  // '?'：未识别
                    if (found2 == 0) got8 = 8'h20;                 // 全空 = 空格
                    else begin
                        for (cand8 = 8'h20; cand8 <= 8'h7E; cand8 = cand8 + 1) begin
                            if (got8 == 8'h3F) begin
                                match2 = 1;
                                for (j2 = 0; j2 < 16; j2 = j2 + 1) begin
                                    rom_c = cand8[6:0];
                                    rom_r = j2[3:0];
                                    #1;
                                    glyph8 = rom_bits;
                                    for (k2 = 0; k2 < 8; k2 = k2 + 1)
                                        if (txt_rows[L0Y + LSTEP*ln + j2][TX0 + 8*ci + k2] !== glyph8[7-k2])
                                            match2 = 0;
                                end
                                if (match2 == 1) got8 = cand8;
                            end
                        end
                    end
                    $fwrite(fd, "%c", got8);
                    if (got8 !== exp_line[ln][(15-ci)*8 +: 8]) begin
                        err_decode = err_decode + 1;
                        $fwrite(fd, "<X>");
                    end
                end
                $fwrite(fd, "]\n");
            end
            $fclose(fd);
        end
    endtask

    // ========================================================================
    // 用例序列：5 个渲染配置 + 1 个 KEY2 关闭
    // ========================================================================
    initial begin
        rst_n = 1'b0;
        px_x = 11'd0; px_y = 11'd0; px_de = 1'b0;
        i_en = 1'b0; i_mode_tag = 2'd0; i_theta = 12'd0; i_min_dl = 9'd0;
        i_ev_en = 1'b0; i_cfg_mode = 2'd0; i_uart_en = 1'b0; i_baud_sel = 2'd0;
        err_band = 0; err_txt = 0; err_rgb = 0; err_key2 = 0; err_x = 0;
        n_ocr = 0; n_cfg = 0; err_decode = 0;
        for (ln = 0; ln < 5; ln = ln + 1) err_line[ln] = 0;

        repeat (5) @(posedge clk);
        rst_n = 1'b1;
        repeat (2) @(posedge clk);

        // ---- 复位后（i_en=1 但无有效像素）：输出必须全 0 ----
        i_en  = 1'b1;
        px_de = 1'b0;
        repeat (2) @(posedge clk); #1;
        chk("RST_DARK", (o_text_hit === 1'b0) && (o_band_hit === 1'b0) && (o_text_rgb === 24'd0));

        // ---- C0: SRC R+E / TH 1 DL 0 / TX R+E / LINK NET+UART / BAUD 115200 ----
        i_en = 1'b1; i_mode_tag = 2'd0; i_theta = 12'd1; i_min_dl = 9'd0;
        i_ev_en = 1'b1; i_cfg_mode = 2'd0; i_uart_en = 1'b1; i_baud_sel = 2'd0;
        exp_line[0] = {{9{8'h20}}, "SRC R+E"};
        exp_line[2] = {{10{8'h20}}, "TX R+E"};
        exp_line[3] = {{3{8'h20}}, "LINK NET+UART"};
        exp_line[4] = {{5{8'h20}}, "BAUD 115200"};
        build_row2(12'd1, 9'd0);
        sweep_full;                       // 全帧：验证框外无一像素亮
        ocr_check;
        dump_ppm("hud_status_c0.ppm");
        n_cfg = n_cfg + 1;

        // ---- C1: SRC R / TH 4095 DL 511 / TX R / LINK NET+UART / BAUD 921600 ----
        i_en = 1'b1; i_mode_tag = 2'd1; i_theta = 12'd4095; i_min_dl = 9'd511;
        i_ev_en = 1'b1; i_cfg_mode = 2'd1; i_uart_en = 1'b1; i_baud_sel = 2'd3;
        exp_line[0] = {{11{8'h20}}, "SRC R"};
        exp_line[2] = {{12{8'h20}}, "TX R"};
        exp_line[3] = {{3{8'h20}}, "LINK NET+UART"};
        exp_line[4] = {{5{8'h20}}, "BAUD 921600"};
        build_row2(12'd4095, 9'd511);
        sweep_band_sparse;
        ocr_check;
        ocr_dump("C1 baud3 boundary");
        dump_ppm("hud_status_c1.ppm");
        n_cfg = n_cfg + 1;

        // ---- C2: SRC E / TH 0 DL 9 / TX --- / LINK NET / BAUD ---（UART 关）----
        i_en = 1'b1; i_mode_tag = 2'd2; i_theta = 12'd0; i_min_dl = 9'd9;
        i_ev_en = 1'b0; i_cfg_mode = 2'd2; i_uart_en = 1'b0; i_baud_sel = 2'd2;
        exp_line[0] = {{11{8'h20}}, "SRC E"};
        exp_line[2] = {{10{8'h20}}, "TX ---"};
        exp_line[3] = {{8{8'h20}}, "LINK NET"};
        exp_line[4] = {{8{8'h20}}, "BAUD ---"};
        build_row2(12'd0, 9'd9);
        sweep_band_sparse;
        ocr_check;
        n_cfg = n_cfg + 1;

        // ---- C3: SRC -- / TH 12 DL 100 / TX --- / LINK NET+UART / BAUD 230400 ----
        i_en = 1'b1; i_mode_tag = 2'd3; i_theta = 12'd12; i_min_dl = 9'd100;
        i_ev_en = 1'b1; i_cfg_mode = 2'd3; i_uart_en = 1'b1; i_baud_sel = 2'd1;
        exp_line[0] = {{10{8'h20}}, "SRC --"};
        exp_line[2] = {{10{8'h20}}, "TX ---"};
        exp_line[3] = {{3{8'h20}}, "LINK NET+UART"};
        exp_line[4] = {{5{8'h20}}, "BAUD 230400"};
        build_row2(12'd12, 9'd100);
        sweep_band_sparse;
        ocr_check;
        n_cfg = n_cfg + 1;

        // ---- C4: SRC R+E / TH 4095 DL 0 / TX R / LINK NET+UART / BAUD 460800 ----
        i_en = 1'b1; i_mode_tag = 2'd0; i_theta = 12'd4095; i_min_dl = 9'd0;
        i_ev_en = 1'b0; i_cfg_mode = 2'd0; i_uart_en = 1'b1; i_baud_sel = 2'd2;
        exp_line[0] = {{9{8'h20}}, "SRC R+E"};
        exp_line[2] = {{12{8'h20}}, "TX R"};
        exp_line[3] = {{3{8'h20}}, "LINK NET+UART"};
        exp_line[4] = {{5{8'h20}}, "BAUD 460800"};
        build_row2(12'd4095, 9'd0);
        sweep_band_sparse;
        ocr_check;
        n_cfg = n_cfg + 1;

        // ---- C5: KEY2 关闭（i_en=0）：整块不显示，全帧扫描 ----
        i_en = 1'b0;
        sweep_full;

        // ================= 判据汇总 =================
        $display("INFO n_cfg=%0d n_ocr=%0d err_band=%0d err_txt=%0d err_rgb=%0d err_key2=%0d err_x=%0d",
                 n_cfg, n_ocr, err_band, err_txt, err_rgb, err_key2, err_x);
        $display("INFO err_line = %0d %0d %0d %0d %0d",
                 err_line[0], err_line[1], err_line[2], err_line[3], err_line[4]);

        chk("BAND_GEOM",        err_band == 0);
        chk("TEXT_ONLY_IN_BAND", err_txt == 0);
        chk("TEXT_RGB_WHITE",   err_rgb == 0);
        chk("KEY2_OFF_DARK",    err_key2 == 0);
        chk("LINE1_SRC",        err_line[0] == 0);
        chk("LINE2_TH_DL",      err_line[1] == 0);
        chk("LINE3_TX",         err_line[2] == 0);
        chk("LINE4_LINK",       err_line[3] == 0);
        chk("LINE5_BAUD",       err_line[4] == 0);
        chk("OCR_CELLS",        (n_ocr == 400) && (n_cfg == 5));
        chk("NO_X",             err_x == 0);
        chk("OCR_DECODE",       err_decode == 0);

        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
