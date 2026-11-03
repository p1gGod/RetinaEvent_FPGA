//==============================================================================
// tb_link_detect.v —— 通信接口检测器（WIRE-U1 §5）仿真
//
// 判据（超时数字按参数等比缩小；状态机逻辑与真值逐拍一致）：
//   D1  复位后 UNKNOWN（2）/ net_ok=0；首判延时内不发探针
//   D2  首判延时（FIRST_MS）到点发第 1 支探针
//   D3  探针间隔 = PROBE_GAP_MS（±20%）
//   D4  探针数 = 3；3 次全无应答 ⇒ NET_DOWN（净 ok=0，TLV 值 0）
//   D5  状态变化产生 1 拍 o_state_chg（UP↔DOWN 各一次）
//   D6  PROBING 期间任一次合法下行 ⇒ NET_UP（不必等满 3 次）
//   D7  NET_UP 维持：T_HOLD 内有合法下行则保持；连续超时 ⇒ DOWN
//   D8  NET_DOWN 退避：RECHECK_MS 后重探一轮（新一轮探针再次出现）
//   D9  NET_DOWN 期间任何合法下行 ⇒ 立即 UP
//   D10 eth_plug=0：不发探针，首判延时后直接 DOWN；不再起新轮
//==============================================================================
`timescale 1ns / 1ps

module tb_link_detect;

    localparam CLK_HZ = 100_000;        // 10 µs 周期；1 ms = 100 拍
    localparam FIRST_MS      = 50;
    localparam PROBE_N       = 3;
    localparam PROBE_GAP_MS  = 20;
    localparam PROBE_WAIT_MS = 10;
    localparam HOLD_MS       = 30;
    localparam RECHECK_MS    = 40;

    reg clk = 1'b0;
    always #5000 clk = ~clk;            // 10 µs
    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT①：eth_plug=1（主状态机）
    //--------------------------------------------------------------------------
    reg        dl_valid = 1'b0;
    wire       probe_req, net_ok, state_chg;
    wire [1:0] net_state;

    link_detect #(
        .CLK_HZ        (CLK_HZ),
        .FIRST_MS      (FIRST_MS),
        .PROBE_N       (PROBE_N),
        .PROBE_GAP_MS  (PROBE_GAP_MS),
        .PROBE_WAIT_MS (PROBE_WAIT_MS),
        .HOLD_MS       (HOLD_MS),
        .RECHECK_MS    (RECHECK_MS)
    ) dut (
        .clk_eth (clk), .rst_n_eth (rst_n),
        .i_eth_plug (1'b1),
        .i_dl_valid (dl_valid),
        .o_probe_req (probe_req),
        .o_net_ok (net_ok),
        .o_net_state (net_state),
        .o_state_chg (state_chg)
    );

    // 探针计数 + 时间戳
    integer n_probe = 0;
    time    t_probe = 0;
    time    t_gap = 0;
    integer n_chg = 0;
    time    t_last_chg = 0;

    always @(posedge clk) begin
        if (probe_req) begin
            n_probe = n_probe + 1;
            t_gap   = $time - t_probe;
            t_probe = $time;
        end
        if (state_chg) begin
            n_chg = n_chg + 1;
            t_last_chg = $time;
        end
    end

    //--------------------------------------------------------------------------
    // DUT②：eth_plug=0（无网线）
    //--------------------------------------------------------------------------
    wire probe_req2, net_ok2, state_chg2;
    wire [1:0] net_state2;
    integer n_probe2 = 0;

    link_detect #(
        .CLK_HZ        (CLK_HZ),
        .FIRST_MS      (FIRST_MS),
        .PROBE_N       (PROBE_N),
        .PROBE_GAP_MS  (PROBE_GAP_MS),
        .PROBE_WAIT_MS (PROBE_WAIT_MS),
        .HOLD_MS       (HOLD_MS),
        .RECHECK_MS    (RECHECK_MS)
    ) dut2 (
        .clk_eth (clk), .rst_n_eth (rst_n),
        .i_eth_plug (1'b0),
        .i_dl_valid (1'b0),
        .o_probe_req (probe_req2),
        .o_net_ok (net_ok2),
        .o_net_state (net_state2),
        .o_state_chg ()
    );

    always @(posedge clk) if (probe_req2) n_probe2 = n_probe2 + 1;

    //--------------------------------------------------------------------------
    // 工具
    //--------------------------------------------------------------------------
    task wait_ms; input integer ms; begin
        repeat (ms * (CLK_HZ / 1000)) @(posedge clk);
    end endtask

    task pulse_dl; begin
        @(negedge clk);
        dl_valid <= 1'b1;
        @(negedge clk);
        dl_valid <= 1'b0;
    end endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    initial begin
        repeat (10) @(posedge clk);
        rst_n <= 1'b1;
        repeat (10) @(posedge clk);

        // D1：UNKNOWN / 无网
        if (net_state === 2'd2) chk_pass("D1_unknown_at_reset");
        else begin
            chk_fail("D1_unknown_at_reset");
            $display("  [E] state=%0d", net_state);
        end
        if ((net_ok === 1'b0) && (net_state2 === 2'd2)) chk_pass("D1_net_ok_low");
        else chk_fail("D1_net_ok_low");

        wait_ms (FIRST_MS - 15);
        if (n_probe == 0) chk_pass("D1_no_probe_before_first_ms");
        else begin
            chk_fail("D1_no_probe_before_first_ms");
            $display("  [E] n_probe=%0d", n_probe);
        end

        // D2：首判延时后第 1 支探针
        wait_ms (30);                     // 累计 65 ms（>50）
        if (n_probe == 1) chk_pass("D2_first_probe_at_50ms");
        else begin
            chk_fail("D2_first_probe_at_50ms");
            $display("  [E] n_probe=%0d", n_probe);
        end

        // D3/D4：间隔 20 ms，3 支后全失败 ⇒ DOWN（t≈100 ms：50+10+10+10+10+10）
        wait_ms (50);                     // 累计 115 ms（>100，且 <140 重探点）
        if (n_probe == 3) chk_pass("D4_exactly_three_probes");
        else begin
            chk_fail("D4_exactly_three_probes");
            $display("  [E] n_probe=%0d", n_probe);
        end
        if ((t_gap > (PROBE_GAP_MS * 1000000 * 8 / 10)) &&
            (t_gap < (PROBE_GAP_MS * 1000000 * 12 / 10)))
            chk_pass("D3_probe_gap_20ms");
        else begin
            chk_fail("D3_probe_gap_20ms");
            $display("  [E] t_gap=%0t ns（期望 ~20000000）", t_gap);
        end
        if ((net_state === 2'd0) && (net_ok === 1'b0)) chk_pass("D4_net_down_after_3_timeouts");
        else begin
            chk_fail("D4_net_down_after_3_timeouts");
            $display("  [E] state=%0d", net_state);
        end
        if ((n_chg >= 1) && (t_last_chg > 0)) chk_pass("D5_state_chg_pulse");
        else chk_fail("D5_state_chg_pulse");

        // D8：退避 40 ms 后重探一轮（新一轮探针）
        begin : d8
            integer np0;
            np0 = n_probe;
            wait_ms (RECHECK_MS + 30);    // 累计 215 ms
            if (n_probe > np0) chk_pass("D8_recheck_round_probes");
            else begin
                chk_fail("D8_recheck_round_probes");
                $display("  [E] n_probe=%0d np0=%0d", n_probe, np0);
            end
        end

        // D9：DOWN 期间收到合法下行 ⇒ 立即 UP
        pulse_dl;
        wait_ms (2);
        if ((net_state === 2'd1) && (net_ok === 1'b1)) chk_pass("D9_down_to_up_on_dl");
        else begin
            chk_fail("D9_down_to_up_on_dl");
            $display("  [E] state=%0d", net_state);
        end

        // D7：UP 维持 —— HOLD 内有合法下行则保持
        wait_ms (HOLD_MS - 10);
        pulse_dl;                          // 刷新维持窗口
        wait_ms (HOLD_MS - 10);
        if (net_state === 2'd1) chk_pass("D7_up_held_with_dl");
        else begin
            chk_fail("D7_up_held_with_dl");
            $display("  [E] state=%0d", net_state);
        end
        // 连续超时 ⇒ DOWN
        wait_ms (HOLD_MS + 15);
        if (net_state === 2'd0) chk_pass("D7_up_to_down_on_timeout");
        else begin
            chk_fail("D7_up_to_down_on_timeout");
            $display("  [E] state=%0d", net_state);
        end

        // D6：PROBING 期间收到合法下行 ⇒ UP（重探轮里应答）
        begin : d6
            integer k;
            k = 0;
            while ((net_state !== 2'd1) && (k < 400)) begin
                // 每 5 ms 打一次"合法下行"，模拟上位机在听
                wait_ms (5);
                pulse_dl;
                k = k + 1;
            end
            if (net_state === 2'd1) chk_pass("D6_dl_during_probing_to_up");
            else chk_fail("D6_dl_during_probing_to_up");
        end

        // D10：eth_plug=0 实例：首判延时后直接 DOWN，且不发探针
        if (n_probe2 == 0) chk_pass("D10_plug0_no_probe");
        else begin
            chk_fail("D10_plug0_no_probe");
            $display("  [E] n_probe2=%0d", n_probe2);
        end
        if ((net_state2 === 2'd0) && (net_ok2 === 1'b0)) chk_pass("D10_plug0_down");
        else begin
            chk_fail("D10_plug0_down");
            $display("  [E] state2=%0d", net_state2);
        end

        $display("INFO probe=%0d chg=%0d state=%0d plug0_state=%0d probe2=%0d",
                 n_probe, n_chg, net_state, net_state2, n_probe2);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #800000000;                         // 800 ms 上限（测试序列 ~400 ms）
        $display("TEST_RESULT=FAIL (timeout) probe=%0d state=%0d", n_probe, net_state);
        $finish;
    end

endmodule
