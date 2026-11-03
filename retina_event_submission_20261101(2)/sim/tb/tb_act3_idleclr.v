//==============================================================================
// tb_act3_idleclr —— task-23 (M4d) 动作字节空窗清零验证
//   C1 reset -> 0x00
//   C2 pulse(class=1,conf=17) -> 0xC5（0x80|(17<<2)|1；VALID=1）
//   C3 连续 ACT_IDLE_CYC-1 拍无 pulse，源域/过域后仍为 0xC5（不得提前清零）
//   C4 第 ACT_IDLE_CYC 拍源域回 0x00，过域后 0x00 且只发生一次变化
//   C5 清零后再 pulse(class=1,conf=5) -> 0x95
//   C6 间隔 < ACT_IDLE_CYC 的连续 pulse 重置计时器，不触发清零
//   ACT_IDLE_CYC 取 RTL 默认 50_000_000（1.0 s @50 MHz）。
//==============================================================================
`timescale 1ns / 1ps

module tb_act3_idleclr;

    localparam integer CYC = 50_000_000;   // 与 act_state_cdc 默认参数一致

    reg        clk_cam;
    reg        clk_eth;
    reg        rst_n_cam;
    reg        rst_n_eth;
    reg        i_act_pulse;
    reg [1:0]  i_act_class;
    reg [4:0]  i_act_conf;
    wire [7:0] o_act_byte;

    integer chk_pass;
    integer chk_fail;

    // 过域后 o_act_byte 的变化次数（每次变化 +1，用于 C4 "只变一次"）
    reg [7:0] mon_last;
    integer   mon_chg;

    // 自最近一次 pulse 起的 clk_cam 拍数（与被测 RTL 的 idle_cnt 同相位）
    integer   cyc_since;

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                    cyc_since <= 0;
        else if (i_act_pulse)              cyc_since <= 0;
        else                               cyc_since <= cyc_since + 1;
    end

    act_state_cdc #(
        .ACT_IDLE_CYC (CYC)
    ) dut (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n_cam),
        .i_act_pulse (i_act_pulse),
        .i_act_class (i_act_class),
        .i_act_conf  (i_act_conf),
        .clk_eth     (clk_eth),
        .rst_n_eth   (rst_n_eth),
        .o_act_byte  (o_act_byte)
    );

    always #10 clk_cam = ~clk_cam;   // 50 MHz
    always #4  clk_eth = ~clk_eth;   // 125 MHz

    always @(posedge clk_eth) begin
        if (!rst_n_eth) begin
            mon_last <= 8'h00;
            mon_chg  <= 0;
        end
        else if (o_act_byte !== mon_last) begin
            mon_chg  <= mon_chg + 1;
            mon_last <= o_act_byte;
            $display("INFO: o_act_byte changed %02h -> %02h @%0t", mon_last, o_act_byte, $time);
        end
    end

    task chk8(input [8*56-1:0] nm, input [7:0] got, input [7:0] exp);
        begin
            if (got === exp) begin
                chk_pass = chk_pass + 1;
                $display("CHECK=%0s PASS (byte23=%02h)", nm, got);
            end
            else begin
                chk_fail = chk_fail + 1;
                $display("CHECK=%0s FAIL (got=%02h exp=%02h)", nm, got, exp);
            end
        end
    endtask

    task chki(input [8*56-1:0] nm, input integer got, input integer exp);
        begin
            if (got === exp) begin
                chk_pass = chk_pass + 1;
                $display("CHECK=%0s PASS (val=%0d)", nm, got);
            end
            else begin
                chk_fail = chk_fail + 1;
                $display("CHECK=%0s FAIL (got=%0d exp=%0d)", nm, got, exp);
            end
        end
    endtask

    // 在 negedge 驱动 pulse（1 拍），任务返回时该拍已过去
    task pulse(input [1:0] cls, input [4:0] conf);
        begin
            @(negedge clk_cam);
            i_act_pulse = 1'b1;
            i_act_class = cls;
            i_act_conf  = conf;
            @(negedge clk_cam);
            i_act_pulse = 1'b0;
            i_act_class = 2'd0;
            i_act_conf  = 5'd0;
        end
    endtask

    integer i;

    initial begin
        clk_cam     = 1'b0;
        clk_eth     = 1'b0;
        rst_n_cam   = 1'b0;
        rst_n_eth   = 1'b0;
        i_act_pulse = 1'b0;
        i_act_class = 2'd0;
        i_act_conf  = 5'd0;
        chk_pass    = 0;
        chk_fail    = 0;

        #100;
        rst_n_cam = 1'b1;
        rst_n_eth = 1'b1;
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);

        // ---------------- C1：复位后 0x00 ----------------
        chk8("C1_reset_byte00", o_act_byte, 8'h00);
        chk8("C1_src_byte00",   dut.act_byte_s, 8'h00);

        // ---------------- C2：pulse(class=1,conf=17) -> 0xC5 ----------------
        pulse(2'd1, 5'd17);
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);
        // 0x80 | (17<<2) | 1 = 0x80|0x44|0x01 = 0xC5（VALID=1）
        chk8("C2_byte23_C5_class1_conf17", o_act_byte, 8'hC5);
        chki("C2_one_change_after_pulse",  mon_chg, 1);

        // ---------------- C3：CYC-1 拍无 pulse 仍为 0xC5 ----------------
        // 用 cyc_since（每拍计数、pulse 当拍清 0）精确等到"距 pulse 恰好 CYC-1 拍"
        wait (cyc_since == CYC - 1);
        #1;
        chk8("C3_src_hold_before_idle", dut.act_byte_s, 8'hC5);
        chki("C3_idle_cnt_at_cyc_m1",   dut.idle_cnt, CYC - 1);
        chk8("C3_out_hold_before_idle", o_act_byte, 8'hC5);

        // ---------------- C4：第 CYC 拍清零，且只变一次 ----------------
        @(posedge clk_cam);
        #1;
        chki("C4_cycle_since_pulse_CYC", cyc_since, CYC);
        chk8("C4_src_clear_on_cycle", dut.act_byte_s, 8'h00);
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);
        chk8("C4_out_clear",          o_act_byte, 8'h00);
        chki("C4_one_change_only",    mon_chg, 2);

        // ---------------- C5：再 pulse(class=1,conf=5) -> 0x95 ----------------
        pulse(2'd1, 5'd5);
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);
        // 0x80 | (5<<2) | 1 = 0x80|0x14|0x01 = 0x95
        chk8("C5_byte23_95_class1_conf5", o_act_byte, 8'h95);
        chki("C5_one_change_after_pulse", mon_chg, 3);

        // ---------------- C6：pulse 重置空窗计时器 ----------------
        // 第一次 pulse 后走 CYC-1000 拍（< CYC），不得清零
        for (i = 0; i < CYC - 1000; i = i + 1) @(posedge clk_cam);
        chk8("C6_no_clear_before_idle", o_act_byte, 8'h95);
        // 再来一次 pulse（间隔 < CYC）：计时器必须重置
        pulse(2'd1, 5'd5);
        @(posedge clk_cam); #1;
        chki("C6_counter_reset_on_pulse", dut.idle_cnt, 1);
        // 若计时器未重置，第二次 pulse 后约 1000 拍就会清零；等 1500 拍仍应为 0x95
        for (i = 0; i < 1500; i = i + 1) @(posedge clk_cam);
        chk8("C6_hold_after_reset",     o_act_byte, 8'h95);
        chki("C6_no_extra_transition",  mon_chg, 3);

        // ---------------- C7：间隔 0.9*CYC 的 pulse 重置计时，超 1.0*CYC 仍保持 ----------------
        // 在 C6 之后重新起算：先 pulse(class=2,conf=9) -> 0xA6（0x80|0x24|0x02）
        pulse(2'd2, 5'd9);
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);
        chk8("C7_first_byte23_A6", o_act_byte, 8'hA6);
        chki("C7_first_one_change", mon_chg, 4);
        // 第一拍后走 0.9*CYC 拍（略小于 ACT_IDLE_CYC），在"原 1.0 s 清零点"之前再注入
        for (i = 0; i < (CYC * 9) / 10; i = i + 1) @(posedge clk_cam);
        pulse(2'd2, 5'd9);
        for (i = 0; i < 30; i = i + 1) @(posedge clk_eth);
        chk8("C7_reset_byte23_A6", o_act_byte, 8'hA6);
        // 从第一次 pulse 起已超过 1.0*CYC：若按"周期清零"会归 0，重置语义下仍为 0xA6
        for (i = 0; i < (CYC / 10) + 3000; i = i + 1) @(posedge clk_cam);
        chk8("C7_hold_after_1s_from_first", o_act_byte, 8'hA6);
        chki("C7_no_extra_transition", mon_chg, 4);

        if (chk_fail == 0) begin
            $display("TEST_RESULT=PASS (%0d checks)", chk_pass);
        end
        else begin
            $display("TEST_RESULT=FAIL (%0d fail / %0d pass)", chk_fail, chk_pass);
        end
        $finish;
    end

endmodule
