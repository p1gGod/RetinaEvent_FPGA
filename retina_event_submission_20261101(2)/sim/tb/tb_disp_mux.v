// ============================================================================
// tb_disp_mux.v -- KEY0 显示源选择 + 帧边界同步切换
//
// 判据（disp_mux.md §8）：
//   CHECK=LATENCY_PIPE1   PIPE=1：o_de 恰为输入 de 延迟 1 拍
//   CHECK=BASELINE_A      cfg_disp_mode=0 -> 输出恒为 A 路
//   CHECK=NO_EARLY_SWITCH 帧中切模式：本帧剩余 de 拍仍输出 A（不撕裂）
//   CHECK=SWITCH_AT_BND   帧边界（垂直消隐）之后输出 B
//   CHECK=DATA_INTEGRITY  输出只可能是 A/B 两个纯值，无毛刺、无 X
//   CHECK=INSTANT_MODE    SYNC_SWITCH=0 的第二实例：立即切换
//   CHECK=DE_NO_X         de 通路无 X
//
// 帧格式（TB 自造，DUT 的 V_VALID 设为 4 以缩短仿真）：
//   每帧 4 行 x 8 拍 de + 4 拍空隙，帧间空隙 20 拍 => 68 拍/帧
//
// 时序纪律：所有激励/判断都在 negedge 做，避开与 DUT 的 posedge 抢 delta。
// ============================================================================
`timescale 1ns/1ps

module tb_disp_mux;

    localparam VV        = 4;      // DUT V_VALID
    localparam ROW_DE    = 8;
    localparam ROW_GAP   = 4;
    localparam FRAME_GAP = 20;
    localparam A_VAL     = 16'hAAAA;
    localparam B_VAL     = 16'h5555;

    reg         clk_lcd, rst_n_lcd;
    reg         cfg_disp_mode;
    reg  [3:0]  row;
    reg  [4:0]  row_cyc;
    wire        g_de = (row < VV) && (row_cyc < ROW_DE);
    wire [15:0] a_data = A_VAL;
    wire [15:0] b_data = B_VAL;

    wire        o_de,  o_de_i;
    wire [15:0] o_data, o_data_i;

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

    disp_mux #(.SYNC_SWITCH(1), .PIPE(1), .V_VALID(VV)) u_dut (
        .clk_lcd(clk_lcd), .rst_n_lcd(rst_n_lcd), .cfg_disp_mode(cfg_disp_mode),
        .a_de(g_de), .a_data(a_data), .b_de(g_de), .b_data(b_data),
        .o_de(o_de), .o_data(o_data)
    );

    disp_mux #(.SYNC_SWITCH(0), .PIPE(1), .V_VALID(VV)) u_inst (
        .clk_lcd(clk_lcd), .rst_n_lcd(rst_n_lcd), .cfg_disp_mode(cfg_disp_mode),
        .a_de(g_de), .a_data(a_data), .b_de(g_de), .b_data(b_data),
        .o_de(o_de_i), .o_data(o_data_i)
    );

    // ---- 时钟 / 超时 --------------------------------------------------------
    initial clk_lcd = 1'b0;
    always #20 clk_lcd = ~clk_lcd;

    initial begin
        #500_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    // ---- 帧产生器 -----------------------------------------------------------
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) begin
            row <= 4'd0; row_cyc <= 5'd0;
        end else if (row < VV) begin
            if (row_cyc == (ROW_DE + ROW_GAP - 1)) begin row_cyc <= 5'd0; row <= row + 4'd1; end
            else row_cyc <= row_cyc + 5'd1;
        end else begin
            if (row_cyc == (FRAME_GAP - 1)) begin row_cyc <= 5'd0; row <= 4'd0; end
            else row_cyc <= row_cyc + 5'd1;
        end
    end

    // 帧间空隙的粘滞标志：**必须在 cfg 改变之后**才置位，
    // 否则第 1 帧的空隙就会把它置 1（TB 踩过：会误判一整帧）
    reg past_bnd, cfg_seen;
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd)          cfg_seen <= 1'b0;
        else if (cfg_disp_mode)  cfg_seen <= 1'b1;
    end
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd)                  past_bnd <= 1'b0;
        else if (cfg_seen && row == VV)  past_bnd <= 1'b1;
    end

    // ---- 监视 ---------------------------------------------------------------
    reg     g_de_d;
    integer lat_err, early_err, late_err, integ_err, x_err;
    integer a_cnt, b_cnt, late_cycles;

    initial begin
        g_de_d = 0;
        lat_err = 0; early_err = 0; late_err = 0; integ_err = 0; x_err = 0;
        a_cnt = 0; b_cnt = 0; late_cycles = 0;
    end

    always @(posedge clk_lcd) begin
        if (rst_n_lcd) begin
            g_de_d <= g_de;

            if (o_de !== g_de_d)      lat_err   = lat_err + 1;      // PIPE=1 延迟契约
            if (o_de === 1'bx)        x_err     = x_err + 1;

            // 只在 de 有效时检查数据完整性（消隐期输出寄存器的残留值无意义）
            if (o_de) begin
                if ((o_data !== A_VAL) && (o_data !== B_VAL)) integ_err = integ_err + 1;
                if (o_data === 16'hxxxx) x_err = x_err + 1;

                if (o_data == A_VAL) a_cnt = a_cnt + 1;
                if (o_data == B_VAL) b_cnt = b_cnt + 1;
                if (!past_bnd && o_data != A_VAL) early_err = early_err + 1;
                if ( past_bnd && o_data != B_VAL) late_err  = late_err + 1;
                if ( past_bnd) late_cycles = late_cycles + 1;
            end
        end
    end

    // 立即切换实例：armed 之后每个周期 o_data_i 必须是 B
    reg     inst_armed, inst_ok;
    integer inst_err;
    initial begin inst_armed = 0; inst_ok = 0; inst_err = 0; end

    always @(posedge clk_lcd) begin
        if (rst_n_lcd && inst_armed) begin
            if (o_data_i !== B_VAL) inst_err = inst_err + 1;
            else                    inst_ok  = 1;
        end
    end

    // ---- 激励（全部在 negedge 决策）----------------------------------------
    integer frames;
    initial begin
        rst_n_lcd     = 1'b0;
        cfg_disp_mode = 1'b0;
        repeat (5) @(negedge clk_lcd);
        rst_n_lcd = 1'b1;

        // 第 1 帧：基线（cfg=0）
        while (row != VV) @(negedge clk_lcd);

        // 第 2 帧第 1 行中间切模式（de 有效，属于"帧中切换"）
        while (!(row == 1 && row_cyc == 3)) @(negedge clk_lcd);
        cfg_disp_mode = 1'b1;

        @(negedge clk_lcd);
        @(negedge clk_lcd);
        inst_armed = 1'b1;

        // 再跑 3 帧
        frames = 0;
        while (frames < 3) begin
            @(negedge clk_lcd);
            if (row == 4'd3 && row_cyc == 5'd0) frames = frames + 1;
        end

        chk("LATENCY_PIPE1",   lat_err == 0);
        chk("BASELINE_A",      a_cnt > 0 && early_err == 0);
        chk("NO_EARLY_SWITCH", early_err == 0);
        chk("SWITCH_AT_BND",   late_cycles > 0 && late_err == 0 && b_cnt > 0);
        chk("DATA_INTEGRITY",  integ_err == 0);
        chk("INSTANT_MODE",    inst_ok == 1'b1 && inst_err == 0);
        chk("DE_NO_X",         x_err == 0);

        $display("INFO=a_cnt=%0d b_cnt=%0d late_cycles=%0d early=%0d late=%0d lat=%0d inst=%0d",
                 a_cnt, b_cnt, late_cycles, early_err, late_err, lat_err, inst_err);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
