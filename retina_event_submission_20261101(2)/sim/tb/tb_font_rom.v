// ============================================================================
// tb_font_rom.v -- 8x16 ASCII 字库 ROM：与脚本生成的黄金表逐项比对
//
// 判据（font_rom.md §8）：
//   CHECK=GOLDEN_ALL      95 字符 x 16 行 = 1520 项全部与黄金表一致
//   CHECK=OUT_OF_RANGE    <0x20 或 >0x7E 的字符码 -> 8'h00
//   CHECK=SPACE_ZERO      0x20（空格）16 行全 0
//   CHECK=NONEMPTY        94 个可见字符每个至少有一行非 0
//   CHECK=LATENCY1_MATCH  ROM_LATENCY=1 实例 = 组合实例延迟 1 拍（1520 项遍历）
//   CHECK=NO_X            无 X
//
// 黄金表 = sim/tb/font8x16_golden.mem，由 tool/gen_font.py 与 font_rom.v **同一次**
//          生成 ⇒ 既验证 RTL 的 case 键/地址映射，也保证"脚本改了字号要能一键重来"。
// ============================================================================
`timescale 1ns/1ps

module tb_font_rom;

    reg        clk, rst_n;
    reg  [6:0] i_char;
    reg  [3:0] i_row;
    wire [7:0] o_bits_c, o_bits_r;

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

    font_rom #(.ROM_LATENCY(0)) u_comb (
        .clk_lcd(clk), .i_char(i_char), .i_row(i_row), .o_bits(o_bits_c)
    );

    font_rom #(.ROM_LATENCY(1)) u_reg (
        .clk_lcd(clk), .i_char(i_char), .i_row(i_row), .o_bits(o_bits_r)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #2_000_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    reg [7:0] gold [0:1519];
    integer err_gold, err_out, err_lat, err_x, n_nonempty;
    reg [7:0] pre_r;
    integer   gold_ok;

    initial begin
        err_gold = 0; err_out = 0; err_lat = 0; err_x = 0; n_nonempty = 0;
        pre_r = 8'h00; gold_ok = 0;
        $readmemh("../../../sim/tb/font8x16_golden.mem", gold);
        if (gold[0] === 8'h00 && gold[17] !== 8'hxx) gold_ok = 1;
    end

    // ROM_LATENCY=1 的 1 拍延迟比对
    always @(posedge clk) begin
        if (rst_n) begin
            pre_r <= o_bits_c;
            if (o_bits_r !== pre_r) err_lat = err_lat + 1;
        end
    end

    integer c, r, i, one_cnt;
    initial begin
        rst_n = 1'b0;
        i_char = 7'h20; i_row = 4'h0;
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        // ---- 1520 项遍历（组合输出，赋值后 #1 观察）----
        for (i = 0; i < 95; i = i + 1) begin
            for (r = 0; r < 16; r = r + 1) begin
                @(negedge clk);
                i_char = 7'h20 + i[6:0];
                i_row  = r[3:0];
                #1;
                if (o_bits_c !== gold[i*16 + r]) err_gold = err_gold + 1;
                if (o_bits_c === 8'hxx)          err_x    = err_x + 1;
            end
        end

        // ---- 越界字符码 ----
        for (i = 0; i < 32; i = i + 1) begin
            @(negedge clk); i_char = i[6:0]; i_row = 4'h5; #1;
            if (o_bits_c !== 8'h00) err_out = err_out + 1;
        end
        // 0x7F 是唯一越界的高端字符码（0x20..0x7E 都合法）
        @(negedge clk); i_char = 7'h7F; i_row = 4'h5; #1;
        if (o_bits_c !== 8'h00) err_out = err_out + 1;
        @(negedge clk); i_char = 7'h7F; i_row = 4'hF; #1;
        if (o_bits_c !== 8'h00) err_out = err_out + 1;
        // 0x7E ('~') 是最后一个合法字符，必须非空
        one_cnt = 0;
        for (r = 0; r < 16; r = r + 1) begin
            @(negedge clk); i_char = 7'h7E; i_row = r[3:0]; #1;
            if (o_bits_c !== 8'h00) one_cnt = one_cnt + 1;
        end
        if (one_cnt == 0) err_out = err_out + 1;

        // ---- 空格 & 可见字符非空统计 ----
        one_cnt = 0;
        for (r = 0; r < 16; r = r + 1) begin
            @(negedge clk); i_char = 7'h20; i_row = r[3:0]; #1;
            if (o_bits_c !== 8'h00) one_cnt = one_cnt + 1;
        end
        for (i = 1; i < 95; i = i + 1) begin
            one_cnt = 0;
            for (r = 0; r < 16; r = r + 1) begin
                @(negedge clk); i_char = 7'h20 + i[6:0]; i_row = r[3:0]; #1;
                if (o_bits_c !== 8'h00) one_cnt = one_cnt + 1;
            end
            if (one_cnt > 0) n_nonempty = n_nonempty + 1;
        end

        chk("GOLDEN_ALL",     gold_ok == 1 && err_gold == 0);
        chk("OUT_OF_RANGE",   err_out == 0);
        chk("SPACE_ZERO",     gold[0] === 8'h00 && gold[15] === 8'h00);
        chk("NONEMPTY",       n_nonempty == 94);
        chk("LATENCY1_MATCH", err_lat == 0);
        chk("NO_X",           err_x == 0);

        $display("INFO=gold_ok=%0d err_gold=%0d err_out=%0d err_lat=%0d nonempty=%0d",
                 gold_ok, err_gold, err_out, err_lat, n_nonempty);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
