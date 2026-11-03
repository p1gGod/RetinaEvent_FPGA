`timescale 1ns / 1ps
module tb_winfeat_unit;
    reg clk = 0;
    reg rst_n = 0;
    always #10 clk = ~clk;

    reg         m_st = 0;
    reg  [39:0] m_a = 0;
    reg  [24:0] m_b = 0;
    wire        m_done;
    wire [58:0] m_p;
    nn_winfeat_mul u_m (.clk(clk), .rst_n(rst_n), .i_start(m_st), .i_a(m_a), .i_b(m_b), .o_done(m_done), .o_p(m_p));

    reg         d_st = 0;
    reg  [58:0] d_num = 0;
    reg  [35:0] d_den = 0;
    wire        d_done;
    wire [58:0] d_q;
    wire [36:0] d_rem;
    nn_winfeat_div u_d (.clk(clk), .rst_n(rst_n), .i_start(d_st), .i_num(d_num), .i_den(d_den), .o_done(d_done), .o_q(d_q), .o_rem(d_rem));

    reg         s_st = 0;
    reg  [19:0] s_val = 0;
    wire        s_done;
    wire [9:0]  s_root;
    nn_winfeat_sqrt u_s (.clk(clk), .rst_n(rst_n), .i_start(s_st), .i_val(s_val), .o_done(s_done), .o_root(s_root));

    integer errors = 0;
    integer chk = 0;

    task mul_case; input [39:0] a; input [24:0] b; input [58:0] exp; begin
        m_a = a; m_b = b; m_st = 1; @(negedge clk); m_st = 0;
        while (m_done !== 1'b1) @(negedge clk);
        chk = chk + 1;
        if (m_p === exp) $display("CHECK=MUL_%0d PASS", chk);
        else begin
            $display("CHECK=MUL_%0d FAIL", chk);
            $display("    a=%0d b=%0d got=%0d exp=%0d", a, b, m_p, exp);
            errors = errors + 1;
        end
        repeat (2) @(negedge clk);
    end endtask

    task div_case; input [58:0] num; input [35:0] den; input [58:0] eq; input [36:0] er; begin
        d_num = num; d_den = den; d_st = 1; @(negedge clk); d_st = 0;
        while (d_done !== 1'b1) @(negedge clk);
        chk = chk + 1;
        if (d_q === eq && d_rem === er) $display("CHECK=DIV_%0d PASS", chk);
        else begin
            $display("CHECK=DIV_%0d FAIL", chk);
            $display("    num=%0d den=%0d gotq=%0d gotr=%0d expq=%0d expr=%0d", num, den, d_q, d_rem, eq, er);
            errors = errors + 1;
        end
        repeat (2) @(negedge clk);
    end endtask

    task sqrt_case; input [19:0] v; input [9:0] er; begin
        s_val = v; s_st = 1; @(negedge clk); s_st = 0;
        while (s_done !== 1'b1) @(negedge clk);
        chk = chk + 1;
        if (s_root === er) $display("CHECK=SQRT_%0d PASS", chk);
        else begin
            $display("CHECK=SQRT_%0d FAIL", chk);
            $display("    v=%0d got=%0d exp=%0d", v, s_root, er);
            errors = errors + 1;
        end
        repeat (2) @(negedge clk);
    end endtask

    initial begin
        repeat (5) @(negedge clk);
        rst_n = 1;
        repeat (2) @(negedge clk);

        mul_case(40'd1000, 25'd1000, 59'd1000000);
        mul_case(40'd3000000, 25'd5000, 59'd15000000000);
        mul_case(40'd1013625, 25'd5000, 59'd5068125000);
        mul_case(40'd1013625, 25'd1013625, 59'd1027437650625);
        mul_case(40'd65535, 25'd65535, 59'd4294836225);
        mul_case(40'd123456, 25'd654321, 59'd80779853376);
        mul_case(40'd1048575, 25'd1048575, 59'd1099511627775);
        mul_case(40'd1, 25'd1, 59'd1);
        mul_case(40'd0, 25'd12345, 59'd0);

        div_case(59'd5068125000, 36'd25000000, 59'd202, 37'd18125000);
        div_case(59'd123456789, 36'd1000, 59'd123456, 37'd789);
        div_case(59'd5, 36'd3, 59'd1, 37'd2);
        div_case(59'd0, 36'd7, 59'd0, 37'd0);
        div_case(59'd300000000000, 36'd25000000, 59'd12000, 37'd0);
        div_case(59'd1099511627775, 36'd999999, 59'd1099512, 37'd727287);

        sqrt_case(20'd0, 10'd0);
        sqrt_case(20'd1, 10'd1);
        sqrt_case(20'd2, 10'd1);
        sqrt_case(20'd3, 10'd1);
        sqrt_case(20'd4, 10'd2);
        sqrt_case(20'd15, 10'd3);
        sqrt_case(20'd16, 10'd4);
        sqrt_case(20'd99, 10'd9);
        sqrt_case(20'd100, 10'd10);
        sqrt_case(20'd1024, 10'd32);
        sqrt_case(20'd54261, 10'd232);
        sqrt_case(20'd12996, 10'd114);
        sqrt_case(20'd159201, 10'd399);
        sqrt_case(20'd1048575, 10'd1023);

        $display("CHECKS=%0d ERRORS=%0d", chk, errors);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else $display("TEST_RESULT=FAIL");
        $finish;
    end
endmodule
