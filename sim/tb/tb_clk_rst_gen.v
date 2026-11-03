//==============================================================================
// tb_clk_rst_gen -- clk_rst_gen 单模块仿真
// 判据（文档 §8）：V1 locked 在复位后有限拍内置 1
//                 V2 各域 rst_n_x 比本域时钟晚 >= 2 拍释放
//                 V3 复位期间不出现 X 态传播
//                 （补）三路输出频率正确（用半周期测量）
//
// 仿真时用 sim/models/ 下的行为级 clk_wiz_0 + BUFG 替身（见 tb_clk_rst_gen.f）。
//==============================================================================
`timescale 1ns / 1ps

module tb_clk_rst_gen;

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg sys_clk   = 1'b0;
    reg sys_rst_n = 1'b0;
    always #10 sys_clk = ~sys_clk;      // 50 MHz

    wire o_clk_200m, o_clk_lcd, o_clk_cam, o_locked;
    wire o_rst_n_200m, o_rst_n_lcd, o_rst_n_cam;

    clk_rst_gen #(.RST_SYNC_STAGES(3)) u_dut (
        .sys_clk      (sys_clk),
        .sys_rst_n    (sys_rst_n),
        .o_clk_200m   (o_clk_200m),
        .o_clk_lcd    (o_clk_lcd),
        .o_clk_cam    (o_clk_cam),
        .o_locked     (o_locked),
        .o_rst_n_200m (o_rst_n_200m),
        .o_rst_n_lcd  (o_rst_n_lcd),
        .o_rst_n_cam  (o_rst_n_cam)
    );

    // ---------------- 频率测量：半周期 ----------------（用计数器法，避免依赖事件顺序）
    integer cyc_200 = 0, cyc_lcd = 0, cyc_cam = 0;
    always @(posedge o_clk_200m) if (o_rst_n_200m) cyc_200 = cyc_200 + 1;
    always @(posedge o_clk_lcd)  if (o_rst_n_lcd)  cyc_lcd = cyc_lcd + 1;
    always @(posedge o_clk_cam)  if (o_rst_n_cam)  cyc_cam = cyc_cam + 1;

    // ---------------- 复位释放时刻记录 ----------------
    real t_rst_200m = -1.0, t_rst_lcd = -1.0, t_rst_cam = -1.0;
    initial begin
        wait (o_rst_n_200m === 1'b1); #0.1 t_rst_200m = $realtime;
    end
    initial begin
        wait (o_rst_n_lcd  === 1'b1); #0.1 t_rst_lcd  = $realtime;
    end
    initial begin
        wait (o_rst_n_cam  === 1'b1); #0.1 t_rst_cam  = $realtime;
    end

    integer i;

    initial begin
        // ================= V3: 复位期间无 X =================
        repeat (20) @(posedge o_clk_cam);
        // repeat 在时钟还没起来时也要安全：先等一会儿
        #200;
        if (o_rst_n_200m === 1'b0 && o_rst_n_lcd === 1'b0 && o_rst_n_cam === 1'b0)
            chk_pass("V3_rst_low_during_reset");
        else
            chk_fail("V3_rst_low_during_reset");

        if (o_locked !== 1'bx) chk_pass("V3_no_x_on_locked"); else chk_fail("V3_no_x_on_locked");

        // ================= V1: locked 有限拍内置 1 =================
        sys_rst_n = 1'b1;
        begin : wait_locked
            integer to;
            to = 0;
            while ((o_locked !== 1'b1) && (to < 20000)) begin
                @(posedge sys_clk);
                to = to + 1;
            end
            if (o_locked === 1'b1) chk_pass("V1_locked_asserts");
            else                   chk_fail("V1_locked_asserts");
        end

        // ================= V2: 各域复位释放 >= 2 拍 =================
        // ⚠️ 必须先等**三路**复位都真的释放了再下结论：o_locked 由 sys_clk 域同步（~1040ns），
        //    而 clk_cam/clk_lcd 域的复位链要 ~1060ns 才释放 —— 检查早于释放会读到 t=-1.0。
        wait (o_rst_n_200m === 1'b1);
        wait (o_rst_n_cam  === 1'b1);
        wait (o_rst_n_lcd  === 1'b1);
        #10;
        // 替身 clk_wiz_0 行为：t=1000ns 时 locked 拉高 ⇒ rst_n_async 在 1000ns 释放。
        // 各级同步链 3 拍，故释放时刻应 >= 1000ns + 2 个本域周期。
        //   200 MHz 周期 5 ns  ⇒ >= 1010 ns
        //   clk_cam/clk_lcd 由 50 MHz 打拍 ⇒ >= 1040 ns
        if (t_rst_200m >= 1010.0) chk_pass("V2_rst_200m_sync_release"); else begin
            $display("CHECK=V2_rst_200m_sync_release FAIL (t=%0.1f)", t_rst_200m); errors = errors + 1;
        end
        if (t_rst_cam  >= 1040.0) chk_pass("V2_rst_cam_sync_release"); else begin
            $display("CHECK=V2_rst_cam_sync_release FAIL (t=%0.1f)", t_rst_cam); errors = errors + 1;
        end
        if (t_rst_lcd  >= 1040.0) chk_pass("V2_rst_lcd_sync_release"); else begin
            $display("CHECK=V2_rst_lcd_sync_release FAIL (t=%0.1f)", t_rst_lcd); errors = errors + 1;
        end

        // ================= 频率校验（在 100 us 窗口内数上升沿）=================
        cyc_200 = 0; cyc_lcd = 0; cyc_cam = 0;
        #100000;                        // 100 us
        // 期望：200 MHz → 20000；50 MHz → 5000；25 MHz → 2500（±1%）
        if ((cyc_200 > 19800) && (cyc_200 < 20200)) chk_pass("F_clk_200m_is_200MHz"); else begin
            $display("CHECK=F_clk_200m_is_200MHz FAIL (cyc=%0d)", cyc_200); errors = errors + 1;
        end
        if ((cyc_cam > 4950) && (cyc_cam < 5050)) chk_pass("F_clk_cam_is_50MHz"); else begin
            $display("CHECK=F_clk_cam_is_50MHz FAIL (cyc=%0d)", cyc_cam); errors = errors + 1;
        end
        if ((cyc_lcd > 2475) && (cyc_lcd < 2525)) chk_pass("F_clk_lcd_is_25MHz"); else begin
            $display("CHECK=F_clk_lcd_is_25MHz FAIL (cyc=%0d)", cyc_lcd); errors = errors + 1;
        end

        // ================= 撤销 sys_rst_n：复位必须重新拉低 =================
        sys_rst_n = 1'b0;
        repeat (4) @(posedge o_clk_200m);
        if (o_rst_n_200m === 1'b0 && o_rst_n_cam === 1'b0 && o_rst_n_lcd === 1'b0)
            chk_pass("V2_async_assert_immediate");
        else
            chk_fail("V2_async_assert_immediate");

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #2000000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
