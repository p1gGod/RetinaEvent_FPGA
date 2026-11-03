//==============================================================================
// tb_nn_feat —— nn_feat 单模块仿真（M3 判据 TB_FEAT_OK）
//
// 验证目标（冻结契约，见 src/hdl/nn/nn_cfg.vh）：
//   F1 上电清零：frz 9000 + cur 3000 清完后 o_ready 才拉高（≈9001 拍）
//   F2 坐标->格：cell=(y>>3)*50+(x>>3)；ON 落 addr_cell=0+cell，OFF 落 1500+cell
//   F3 同格累加 + 8 bit 饱和（260 个 ON 同格 -> 255）
//   F4 坐标边界 (399,239)->cell 1499；越界 x=400 的事件被丢弃并计数
//   F5 窗口冻结：frz[bank*3000+addr] 内容正确、cur 清零、o_win_bank 0->1->2->0
//   F6 特征读口（M3-fix 起与累积同域 clk_cam）：o_rd_q = min(127,count)，1 拍延迟
//   F7 窗口周期：o_win_end 间隔 = WIN_CYC（8000 拍），单拍脉冲，o_win_tog 每窗翻转
//   F8 边界不丢事件：在 ST_COPY 期间注入的事件归到**下一个**窗口（gen 过滤生效）
//   F9 全程 o_dbg_drop 只统计真实丢弃（越界 1 次），有效事件 0 丢弃
//==============================================================================
`timescale 1ns / 1ps

module tb_nn_feat;

    // ---- 时钟：50 MHz + 200 MHz -------------------------------------------
    reg clk_cam = 1'b0;
    always #10 clk_cam = ~clk_cam;              // 20 ns
    reg clk_200m = 1'b0;
    always #2.5 clk_200m = ~clk_200m;           // 5 ns

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask
    task chk_eq; input [8*48-1:0] nm; input [31:0] got; input [31:0] exp; begin
        if (got === exp) chk_pass(nm);
        else begin
            chk_fail(nm);
            $display("    [%0s] got=0x%0h (%0d) exp=0x%0h (%0d)", nm, got, got, exp, exp);
        end
    end endtask

    // ---- DUT --------------------------------------------------------------
    localparam WIN_CYC = 8000;                  // TB 缩小窗口，加快仿真

    reg        rst_n_cam  = 1'b0;
    reg        rst_n_200m = 1'b0;
    reg        i_ev_valid = 1'b0;
    reg [8:0]  i_ev_x     = 9'd0;
    reg [7:0]  i_ev_y     = 8'd0;
    reg        i_ev_pol   = 1'b0;
    wire       o_ready;
    wire [1:0] o_win_bank;
    wire       o_win_tog;
    wire       o_win_end;
    wire [15:0] o_dbg_drop;
    reg [13:0] i_rd_addr  = 14'd0;
    wire [7:0] o_rd_q;

    nn_feat #(.WIN_CYC(WIN_CYC)) dut (
        .clk_cam(clk_cam), .rst_n_cam(rst_n_cam),
        .i_ev_valid(i_ev_valid), .i_ev_x(i_ev_x), .i_ev_y(i_ev_y), .i_ev_pol(i_ev_pol),
        .o_ready(o_ready), .o_win_bank(o_win_bank), .o_win_tog(o_win_tog),
        .o_win_end(o_win_end), .o_dbg_drop(o_dbg_drop),
        .i_rd_addr(i_rd_addr), .o_rd_q(o_rd_q)
    );

    // ---- 事件发送（每个任务调用 = 1 个事件，占 1 个 clk_cam 拍）--------------
    task send_ev; input [8:0] x; input [7:0] y; input p; begin
        @(negedge clk_cam);
        i_ev_valid = 1'b1; i_ev_x = x; i_ev_y = y; i_ev_pol = p;
        @(negedge clk_cam);
        i_ev_valid = 1'b0;
    end endtask

    task wait_drain; begin
        while (dut.fifo_cnt !== 10'd0) @(posedge clk_cam);
        repeat (8) @(posedge clk_cam);
    end endtask

    task wait_win_end; begin
        @(posedge clk_cam);
        while (dut.o_win_end !== 1'b1) @(posedge clk_cam);
    end endtask

    // ---- 主流程 ------------------------------------------------------------
    integer cyc;
    integer k;
    integer win_no;
    time    t_we [0:4];
    reg [1:0] exp_bank;
    reg [7:0] q_val;
    reg       tog_prev;

    initial begin
        // ---------- F1 上电清零 ----------
        repeat (4) @(posedge clk_cam);
        rst_n_cam  <= 1'b1;
        rst_n_200m <= 1'b1;
        rst_n_cam  = 1'b1;
        rst_n_200m = 1'b1;
        cyc = 0;
        while ((o_ready !== 1'b1) && (cyc < 20000)) begin
            @(posedge clk_cam);
            cyc = cyc + 1;
        end
        $display("[info] clear done after %0d clk_cam cycles, o_ready=%0b", cyc, o_ready);
        if (cyc >= 8900 && cyc <= 9200) chk_pass("F1_clear_9001cyc_before_ready");
        else                            chk_fail("F1_clear_9001cyc_before_ready");

        // ---------- 窗口 0：F2/F3/F4 ----------
        send_ev(9'd7,  8'd7,  1'b1);            // ON  cell 0    -> cur[0]
        send_ev(9'd7,  8'd7,  1'b1);
        send_ev(9'd7,  8'd7,  1'b1);            // 3 次同格
        send_ev(9'd8,  8'd8,  1'b0);            // OFF cell 51   -> cur[1500+51]
        send_ev(9'd399, 8'd239, 1'b1);          // 边界 cell 1499
        wait_drain;
        chk_eq("F2_on_cell0_cnt3",       dut.cur_mem[0],    8'd3);
        chk_eq("F2_off_cell51_in_1500",  dut.cur_mem[1551], 8'd1);
        chk_eq("F4_edge_cell1499",       dut.cur_mem[1499], 8'd1);
        chk_eq("F2_on_other_cell_zero",  dut.cur_mem[1],    8'd0);
        chk_eq("F2_off_channel_base_zero", dut.cur_mem[1500], 8'd0);

        // 饱和：260 个 ON 落在同一格（cell 612）
        for (k = 0; k < 260; k = k + 1) send_ev(9'd100, 8'd100, 1'b1);
        wait_drain;
        chk_eq("F3_saturate_255", dut.cur_mem[612], 8'd255);

        // 越界事件：x=400 应被丢弃，且不进 cur
        send_ev(9'd400, 8'd10, 1'b1);
        repeat (10) @(posedge clk_cam);
        chk_eq("F4_oob_event_dropped", o_dbg_drop, 16'd1);
        chk_eq("F4_oob_event_not_stored", dut.cur_mem[0], 8'd3);

        // ---------- 窗口 0 冻结 ----------
        wait_win_end;                            // o_win_end 脉冲拍
        t_we[0] = $time;
        chk_eq("F5_win_bank0", o_win_bank, 2'd0);
        chk_eq("F5_win_tog1", o_win_tog, 1'd1);
        @(posedge clk_cam);
        chk_eq("F7_win_end_single_cycle", dut.o_win_end, 1'b0);
        // frz[0*3000+addr]
        chk_eq("F5_frz_bank0_on_cell0",   dut.frz_mem[0],    8'd3);
        chk_eq("F5_frz_bank0_off_cell51", dut.frz_mem[1551], 8'd1);
        chk_eq("F5_frz_bank0_saturate",   dut.frz_mem[612],  8'd255);
        chk_eq("F5_frz_bank0_edge1499",   dut.frz_mem[1499], 8'd1);
        // cur 清零
        chk_eq("F5_cur_cleared_cell0",    dut.cur_mem[0],    8'd0);
        chk_eq("F5_cur_cleared_cell612",  dut.cur_mem[612],  8'd0);
        chk_eq("F5_cur_cleared_cell1499", dut.cur_mem[1499], 8'd0);

        // ---------- 窗口 1：F6 读口 / F8 边界事件 ----------
        // q = min(127,count)
        @(negedge clk_cam); i_rd_addr = 14'd612;
        repeat (3) @(posedge clk_cam);
        q_val = o_rd_q;
        chk_eq("F6_q_sat_127", q_val, 8'd127);
        @(negedge clk_cam); i_rd_addr = 14'd0;
        repeat (3) @(posedge clk_cam);
        q_val = o_rd_q;
        chk_eq("F6_q_pass_3", q_val, 8'd3);
        @(negedge clk_cam); i_rd_addr = 14'd1551;
        repeat (3) @(posedge clk_cam);
        q_val = o_rd_q;
        chk_eq("F6_q_off_cell51", q_val, 8'd1);
        @(negedge clk_cam); i_rd_addr = 14'd0;

        // 窗口 1 内 2 个 ON 事件
        send_ev(9'd7, 8'd7, 1'b1);
        send_ev(9'd7, 8'd7, 1'b1);
        wait_drain;
        chk_eq("F8_win1_cur_cnt2", dut.cur_mem[0], 8'd2);

        // 等到拷贝阶段，在拷贝期间注入 1 个事件 -> 应归到窗口 2
        while (dut.state !== 3'd5) @(negedge clk_cam);   // ST_COPY
        send_ev(9'd7, 8'd7, 1'b1);
        chk_pass("F8_inject_during_copy");

        wait_win_end;
        t_we[1] = $time;
        chk_eq("F5_win_bank1", o_win_bank, 2'd1);
        chk_eq("F5_win_tog2", o_win_tog, 1'd0);
        chk_eq("F8_bank1_only_2",      dut.frz_mem[3000], 8'd2);
        chk_eq("F8_bank0_untouched",   dut.frz_mem[0],    8'd3);
        wait_drain;                              // 冻结后新窗口排空 FIFO
        chk_eq("F8_new_win_cur_1", dut.cur_mem[0], 8'd1);
        chk_eq("F9_drop_still_1", o_dbg_drop, 16'd1);

        // ---------- 窗口 2 ----------
        wait_win_end;
        t_we[2] = $time;
        chk_eq("F5_win_bank2", o_win_bank, 2'd2);
        chk_eq("F8_copy_event_lands_win2", dut.frz_mem[6000], 8'd1);
        chk_eq("F5_bank0_still", dut.frz_mem[0], 8'd3);

        // ---------- 窗口 3：bank 轮转回 0 ----------
        wait_win_end;
        t_we[3] = $time;
        chk_eq("F5_win_bank_rotate0", o_win_bank, 2'd0);

        // ---------- F7 窗口周期 ----------
        $display("[info] win_end t0=%0t t1=%0t t2=%0t t3=%0t", t_we[0], t_we[1], t_we[2], t_we[3]);
        if ((t_we[1] - t_we[0]) == 160000) chk_pass("F7_period_win0_1");
        else chk_fail("F7_period_win0_1");
        if ((t_we[2] - t_we[1]) == 160000) chk_pass("F7_period_win1_2");
        else chk_fail("F7_period_win1_2");
        if ((t_we[3] - t_we[2]) == 160000) chk_pass("F7_period_win2_3");
        else chk_fail("F7_period_win2_3");

        // ---------- 收尾 ----------
        chk_eq("F9_drop_final_1", o_dbg_drop, 16'd1);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL (errors=%0d)", errors);
        $finish;
    end

    // ---- 超时保护 ----------------------------------------------------------
    initial begin
        #20000000;                               // 20 us*1000 = 20 ms 上限
        $display("CHECK=TB_TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
