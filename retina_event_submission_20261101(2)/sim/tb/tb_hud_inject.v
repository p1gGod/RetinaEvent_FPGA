// ============================================================================
// tb_hud_inject.v -- 「颜色」一级注入（OVL 消费方）+ PPM 出图
//
// 判据（hud_inject.md §8）：
//   CHECK=LATENCY_PIPE1   PIPE=1：o_de 恰为 i_bg_de 延迟 1 拍
//   CHECK=BG_EXPAND       hit=0 -> o_rgb888 = RGB565 位复制扩展（TB 独立算式）
//   CHECK=OVERLAY_RGB     hit=1 -> o_rgb888 = i_ovl_rgb（整值替换，无 alpha）
//   CHECK=OVL_COUNT       被叠加像素数 = 手算矩形面积 200x100 = 20000
//   CHECK=NO_LEAK         hit 全 0 的一整帧：叠加像素数 = 0，颜色全部等于背景
//   CHECK=PPM_TWO_FILES   两帧各导出一张 P6 PPM，像素数各 = 384000
//   CHECK=NO_X            输出无 X
//
// ★ WIRE-U3（2026-10-17，接口约定 §2.3）新增遮罩通道 i_dim：
//   CHECK=DIM_LEVEL        dim=1 且 hit=0 -> o_rgb888 = 背景每通道 >>1（TB 独立算式）
//   CHECK=DIM_COUNT        被压暗像素数 = 遮罩面积 232x144 = 33408
//   CHECK=PPM_DIM_FILE     压暗帧另导一张 P6 PPM（384000 像素）+ 画面可见
//   遮罩区域内绝不能出现白字（文字由 hud_stack 的 p6 覆盖，本模块只做二值 mux）。
//
// ★ 三态红线：本 TB 只验"颜色"这一项；lcd_rgb 的 inout/三态结构不在本模块、
//   也不在本 TB 的范围内（那由 lcd_rgb_top_ovl + 上板读屏 ID 回归覆盖）。
// ============================================================================
`timescale 1ns/1ps

module tb_hud_inject;

    localparam LCD_W = 800, LCD_H = 480;
    localparam OVL_RGB = 24'h123456;

    reg         clk, rst_n;
    reg  [10:0] sx, sy;
    reg         sweep_active, start;
    integer     phase;              // 0 = 带叠加；1 = 纯背景

    wire        i_bg_de = sweep_active;
    wire [15:0] i_bg565 = {sx[7:0], sy[7:0]};
    wire        i_hit   = (phase == 0) && (sx >= 11'd100) && (sx < 11'd300) &&
                          (sy >= 11'd50)  && (sy < 11'd150);
    // ★ WIRE-U3：遮罩区域 = 接口约定 §2.1 的 232x144（560..792 x 280..424）
    wire        i_dim   = (phase == 2) && (sx >= 11'd560) && (sx < 11'd792) &&
                          (sy >= 11'd280) && (sy < 11'd424);

    wire        o_de;
    wire [23:0] o_rgb888;

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

    hud_inject #(.PIPE(1)) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .i_bg_rgb565(i_bg565), .i_bg_de(i_bg_de),
        .i_ovl_hit(i_hit), .i_ovl_rgb(OVL_RGB),
        .i_dim(i_dim),
        .o_rgb888(o_rgb888), .o_de(o_de)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #120_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // ---- 扫描发生（可重复启动，每次 384000 拍 de）---------------------------
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

    // ---- TB 侧独立参考 ------------------------------------------------------
    function [23:0] exp565to888;
        input [15:0] p;
        begin
            exp565to888 = {p[15:11], p[13:11], p[10:5], p[9:8], p[4:0], p[2:0]};
        end
    endfunction

    // 背景 >>1（每通道丢最低位）——独立于 DUT 的参考算式
    function [23:0] exp565dim;
        input [15:0] p;
        reg   [23:0] e;
        begin
            e = exp565to888(p);
            exp565dim = {1'b0, e[23:17], 1'b0, e[15:9], 1'b0, e[7:1]};
        end
    endfunction

    reg [15:0] bg_d;
    reg        de_d, hit_d, dim_d;
    always @(posedge clk) begin
        bg_d  <= i_bg565;
        de_d  <= i_bg_de;
        hit_d <= i_hit;
        dim_d <= i_dim;
    end

    // ---- 监视 ---------------------------------------------------------------
    integer err_de, err_bg, err_ovl, err_x, de_cnt;
    integer err_dim, dim_cnt_p2;
    integer ovl_cnt_p0, ovl_cnt_p1, ppm_p0, ppm_p1, ppm_p2, ppm_ok;
    integer fd0, fd1, fd2;

    initial begin
        err_de = 0; err_bg = 0; err_ovl = 0; err_x = 0; de_cnt = 0;
        err_dim = 0; dim_cnt_p2 = 0;
        ovl_cnt_p0 = 0; ovl_cnt_p1 = 0; ppm_p0 = 0; ppm_p1 = 0; ppm_p2 = 0; ppm_ok = 0;
        fd0 = $fopen("hud_inject_overlay.ppm", "wb");
        fd1 = $fopen("hud_inject_bgonly.ppm", "wb");
        fd2 = $fopen("hud_inject_dim.ppm", "wb");
        if (fd0 != 0) $fwrite(fd0, "P6\n800 480\n255\n");
        if (fd1 != 0) $fwrite(fd1, "P6\n800 480\n255\n");
        if (fd2 != 0) $fwrite(fd2, "P6\n800 480\n255\n");
        if (fd0 != 0 && fd1 != 0 && fd2 != 0) ppm_ok = 1;
    end

    always @(posedge clk) begin
        if (rst_n) begin
            if (o_de !== de_d) err_de = err_de + 1;
            if (o_de === 1'bx) err_x  = err_x + 1;
            if (o_rgb888 === 24'hxxxxxx) err_x = err_x + 1;

            if (o_de) begin
                de_cnt = de_cnt + 1;
                if (hit_d) begin
                    // 叠加优先：遮罩区内的文字像素也必须整值替换成 ovl 色（无 alpha）
                    if (o_rgb888 !== OVL_RGB) err_ovl = err_ovl + 1;
                    if (phase == 0) ovl_cnt_p0 = ovl_cnt_p0 + 1;
                    else            ovl_cnt_p1 = ovl_cnt_p1 + 1;
                end else if (dim_d) begin
                    // ★ 遮罩：背景每通道 >>1
                    if (o_rgb888 !== exp565dim(bg_d)) err_dim = err_dim + 1;
                    if (phase == 2) dim_cnt_p2 = dim_cnt_p2 + 1;
                end else begin
                    if (o_rgb888 !== exp565to888(bg_d)) err_bg = err_bg + 1;
                end

                if (ppm_ok) begin
                    if (phase == 0) begin
                        $fwrite(fd0, "%c%c%c", o_rgb888[23:16], o_rgb888[15:8], o_rgb888[7:0]);
                        ppm_p0 = ppm_p0 + 1;
                    end else if (phase == 1) begin
                        $fwrite(fd1, "%c%c%c", o_rgb888[23:16], o_rgb888[15:8], o_rgb888[7:0]);
                        ppm_p1 = ppm_p1 + 1;
                    end else begin
                        $fwrite(fd2, "%c%c%c", o_rgb888[23:16], o_rgb888[15:8], o_rgb888[7:0]);
                        ppm_p2 = ppm_p2 + 1;
                    end
                end
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
            while ((sweep_active || de_d) && guard < 500000) begin
                @(negedge clk); guard = guard + 1;
            end
        end
    endtask

    initial begin
        rst_n = 1'b0; start = 1'b0; phase = 0;
        repeat (10) @(negedge clk);
        rst_n = 1'b1;

        run_sweep;                      // 阶段 0：带叠加
        phase = 1;
        run_sweep;                      // 阶段 1：纯背景
        phase = 2;
        run_sweep;                      // 阶段 2：带遮罩（背景压暗 50%）
        repeat (4) @(negedge clk);

        if (fd0 != 0) $fclose(fd0);
        if (fd1 != 0) $fclose(fd1);
        if (fd2 != 0) $fclose(fd2);

        chk("LATENCY_PIPE1", err_de == 0);
        chk("BG_EXPAND",     err_bg == 0);
        chk("OVERLAY_RGB",   err_ovl == 0);
        chk("OVL_COUNT",     ovl_cnt_p0 == (200*100));
        chk("NO_LEAK",       ovl_cnt_p1 == 0 && err_ovl == 0);
        chk("PPM_TWO_FILES", ppm_ok == 1 && ppm_p0 == (LCD_W*LCD_H) && ppm_p1 == (LCD_W*LCD_H));
        chk("NO_X",          err_x == 0);
        // ★ WIRE-U3 遮罩通道
        chk("DIM_LEVEL",     err_dim == 0);
        chk("DIM_COUNT",     dim_cnt_p2 == (232*144));
        chk("PPM_DIM_FILE",  ppm_ok == 1 && ppm_p2 == (LCD_W*LCD_H));

        $display("INFO=de=%0d ovl0=%0d ovl1=%0d err_bg=%0d err_ovl=%0d err_de=%0d ppm0=%0d ppm1=%0d err_dim=%0d dim2=%0d ppm2=%0d",
                 de_cnt, ovl_cnt_p0, ovl_cnt_p1, err_bg, err_ovl, err_de, ppm_p0, ppm_p1,
                 err_dim, dim_cnt_p2, ppm_p2);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
