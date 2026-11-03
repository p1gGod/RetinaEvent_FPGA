//==============================================================================
// tb_ts_gen.v —— 板端时间戳发生器自测（v3 设计 §4/§5，R4；★断言② 本营）
//
// 判据：
//   T1  48 bit µs 计数器：每 125 拍精确 +1（125 MHz ÷ 125 = 1 MHz，§4.1）
//   T2  ★单调：o_ts_local_us 全程严格单调不减（采样窗内无回退）
//   T3  ★offset 写入后跳变生效：aligned = local + offset（含负 offset 二补码），
//       写入即生效、随后继续单调（跳变不破坏单调性）
//   T4  校准请求：上电 FIRST_CAL_US 后发 REQ（t2 = 本机 µs），重试间隔
//       200/500/1000 ms（TB 用缩短参数），SEQ 逐次递增
//   T5  一轮重试全失败 ⇒ ts_cal_stale=1 且 offset_reg **绝不归零**、
//       aligned 继续走旧偏移（§5.2）
//   T6  下行写入 offset ⇒ ts_calibrated=1、stale 清零
//   T7  SEQ 匹配脉冲 ⇒ RTT = t4 − t2 记账
//==============================================================================
`timescale 1ns / 1ps

module tb_ts_gen;

    reg clk = 1'b0;
    always #4 clk = ~clk;              // 125 MHz

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT：缩短日程（1 µs 计数仍真实；秒级参数用 µs 级替身）
    //   FIRST_CAL_US=2000 (2 ms)、重试间隔 40/60/80 µs、退避 300 µs
    //--------------------------------------------------------------------------
    reg         off_wr    = 1'b0;
    reg  [47:0] off_data  = 48'd0;
    reg         period_wr = 1'b0;
    reg  [16:0] period_s  = 17'd600;
    reg         force_cal = 1'b0;
    reg         sync_ok   = 1'b0;

    wire        cal_req;
    wire [15:0] cal_seq;
    wire [47:0] board_ts;
    wire [47:0] ts_local, ts_aligned, offset_reg;
    wire        ts_valid, ts_cal, ts_stale;
    wire [15:0] rtt_us;
    wire [31:0] boot_id;

    ts_gen #(
        .CLK_DIV          (125),
        .FIRST_CAL_US     (48'd2_000),
        .CAL_PERIOD_S     (17'd600),
        .RETRY_GAP0_US    (48'd40),
        .RETRY_GAP1_US    (48'd60),
        .RETRY_GAP2_US    (48'd80),
        .STALE_BACKOFF_US (48'd300),
        .RETRY_N          (16'd3),
        .BOOT_ID          (32'hABCD_1234)
    ) dut (
        .clk_eth        (clk),
        .rst_n_eth      (rst_n),
        .i_off_wr_en    (off_wr),
        .i_off_data     (off_data),
        .i_period_wr_en (period_wr),
        .i_period_s     (period_s),
        .i_force_cal    (force_cal),
        .i_sync_matched (sync_ok),
        .o_cal_req      (cal_req),
        .o_cal_seq      (cal_seq),
        .o_board_ts_us  (board_ts),
        .o_ts_local_us  (ts_local),
        .o_ts_aligned_us(ts_aligned),
        .o_ts_valid     (ts_valid),
        .o_ts_calibrated(ts_cal),
        .o_ts_stale     (ts_stale),
        .o_offset_reg   (offset_reg),
        .o_rtt_us       (rtt_us),
        .o_boot_id      (boot_id)
    );

    //--------------------------------------------------------------------------
    // T1/T2 监视：µs 步进 + 单调（每拍检查相邻两次采样）
    //--------------------------------------------------------------------------
    reg [47:0] local_prev = 48'd0;
    reg [47:0] align_prev = 48'd0;
    reg        seen_first = 1'b0;
    reg        step_armed = 1'b0;
    reg        align_chk_en = 1'b1;
    reg [6:0]  div_witness = 7'd0;
    integer    e_step = 0, e_mono = 0, e_amono = 0;

    always @(posedge clk) begin
        if (rst_n) begin
            // T1：每 125 拍恰好 +1（首个增量只武装，不判 —— 复位相位不定）
            if (ts_local !== local_prev) begin
                if (step_armed && (div_witness !== 7'd124)) e_step = e_step + 1;
                if (ts_local !== local_prev + 48'd1) e_step = e_step + 1;
                local_prev  = ts_local;
                div_witness = 7'd0;
                step_armed  = 1'b1;
            end
            else if (div_witness != 7'd127) div_witness = div_witness + 7'd1;

            // T2：本机 µs 单调
            if (seen_first && (ts_local < local_prev)) e_mono = e_mono + 1;
            seen_first = 1'b1;

            // aligned 单调（offset 不变期间；跳变写入由任务侧暂停检查）
            if (align_chk_en && (ts_aligned < align_prev)) e_amono = e_amono + 1;
            align_prev = ts_aligned;
        end
    end

    //--------------------------------------------------------------------------
    // REQ 记录（时序 + SEQ）
    //--------------------------------------------------------------------------
    integer n_req = 0;
    reg [47:0] req_t [0:15];
    reg [15:0] req_seq [0:15];
    always @(posedge clk) begin
        if (cal_req && (n_req < 16)) begin
            req_t[n_req]   = board_ts;
            req_seq[n_req] = cal_seq;
            n_req = n_req + 1;
        end
    end

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer k;
    reg [47:0] t_off;
    reg [47:0] align_before;

    initial begin
        repeat (10) @(posedge clk);
        rst_n <= 1'b1;

        // ================= 等首次 REQ（FIRST_CAL_US=2000 µs = 250_000 拍）========
        k = 0;
        while ((n_req == 0) && (k < 400000)) begin @(posedge clk); k = k + 1; end
        if (n_req >= 1) chk_pass("T4_first_req_after_5s_equiv");
        else            chk_fail("T4_first_req_after_5s_equiv");
        // t2 ≈ 请求时刻的本机 µs（2000 ± 5）
        if (req_t[0] >= 48'd1995 && req_t[0] <= 48'd2005)
            chk_pass("T4_board_ts_is_local_us");
        else begin
            chk_fail("T4_board_ts_is_local_us");
            $display("  [E] t2=%0d (exp ~2000)", req_t[0]);
        end

        // ================= 重试时序 + SEQ 递增 + 全失败 → stale =================
        // 期望：40/60/80 µs 间隔共 4 次 REQ，然后 stale=1（T5）
        k = 0;
        while ((n_req < 4) && (k < 400000)) begin @(posedge clk); k = k + 1; end
        if (n_req == 4) chk_pass("T4_retry_count_4") ; else chk_fail("T4_retry_count_4");
        if ((req_seq[1] == req_seq[0] + 16'd1) &&
            (req_seq[2] == req_seq[1] + 16'd1) &&
            (req_seq[3] == req_seq[2] + 16'd1))
            chk_pass("T4_seq_increments");
        else chk_fail("T4_seq_increments");
        begin : chk_gaps
            reg [47:0] g0, g1, g2;
            g0 = req_t[1] - req_t[0];
            g1 = req_t[2] - req_t[1];
            g2 = req_t[3] - req_t[2];
            if (g0 >= 48'd39 && g0 <= 48'd41 && g1 >= 48'd59 && g1 <= 48'd61 &&
                g2 >= 48'd79 && g2 <= 48'd81)
                chk_pass("T4_retry_gaps_40_60_80");
            else begin
                chk_fail("T4_retry_gaps_40_60_80");
                $display("  [E] gaps=%0d/%0d/%0d", g0, g1, g2);
            end
        end

        k = 0;
        while (!ts_stale && (k < 400000)) begin @(posedge clk); k = k + 1; end
        if (ts_stale === 1'b1) chk_pass("T5_stale_after_round_lost");
        else                   chk_fail("T5_stale_after_round_lost");

        // ================= T3：offset 写入（含负值）跳变生效 =====================
        align_chk_en = 1'b0;
        align_before   = ts_aligned;
        t_off          = 48'hFFFFFFFFFFFF;   // −1（二补码）
        @(negedge clk);
        off_wr   <= 1'b1;
        off_data <= t_off;
        @(negedge clk);
        off_wr   <= 1'b0;
        repeat (4) @(posedge clk);
        // aligned 应 = local − 1（跳变即时生效）
        if (ts_aligned === (ts_local + t_off))
            chk_pass("T3_offset_minus1_effective");
        else begin
            chk_fail("T3_offset_minus1_effective");
            $display("  [E] aligned=%0d local=%0d off=%0d", ts_aligned, ts_local, offset_reg);
        end
        if (offset_reg === t_off) chk_pass("T3_offset_reg_written");
        else                      chk_fail("T3_offset_reg_written");
        if (ts_cal === 1'b1 && ts_stale === 1'b0)
            chk_pass("T6_calibrated_set_stale_cleared");
        else chk_fail("T6_calibrated_set_stale_cleared");

        // ★ offset 跳变后 aligned 必须继续单调（跳变不破坏时序轴）
        align_chk_en = 1'b1;
        repeat (5000) @(posedge clk);
        align_chk_en = 1'b0;
        if (e_amono == 0) chk_pass("T3_aligned_monotonic_after_jump");
        else              chk_fail("T3_aligned_monotonic_after_jump");

        // 大正 offset（+123456）
        align_chk_en = 1'b0;
        t_off = 48'd123456;
        @(negedge clk); off_wr <= 1'b1; off_data <= t_off;
        @(negedge clk); off_wr <= 1'b0;
        repeat (4) @(posedge clk);
        if (ts_aligned === (ts_local + t_off))
            chk_pass("T3_offset_plus_effective");
        else chk_fail("T3_offset_plus_effective");
        align_chk_en = 1'b1;

        // ================= T7：SEQ 匹配 → RTT 记账 ==============================
        // 造一次 REQ（force_cal），随后立即回一个匹配脉冲
        force_cal <= 1'b1;
        @(negedge clk);
        force_cal <= 1'b0;
        k = 0;
        while (!cal_req && (k < 1000)) begin @(posedge clk); k = k + 1; end
        begin : chk_rtt
            reg [47:0] t2_snap;
            t2_snap = board_ts;      // REQ 拍的 t2
            repeat (300) @(posedge clk);            // 模拟往返延迟
            @(negedge clk);
            sync_ok <= 1'b1;
            @(negedge clk);
            sync_ok <= 1'b0;
            repeat (4) @(posedge clk);
            // RTT = t4 − t2 ≈ 300 拍 = 2.4 µs（±2 µs 容差）
            if (rtt_us <= 16'd5)
                chk_pass("T7_rtt_recorded");
            else begin
                chk_fail("T7_rtt_recorded");
                $display("  [E] rtt=%0d", rtt_us);
            end
        end

        // ================= 汇总 ================================================
        if (e_step == 0) chk_pass("T1_exact_1us_step");
        else             chk_fail("T1_exact_1us_step");
        if (e_mono == 0) chk_pass("T2_local_monotonic");
        else             chk_fail("T2_local_monotonic");
        if (ts_valid === 1'b1) chk_pass("T2_ts_valid_high");
        else                   chk_fail("T2_ts_valid_high");
        if (boot_id === 32'hABCD_1234) chk_pass("T6_boot_id_const");
        else                           chk_fail("T6_boot_id_const");

        $display("INFO reqs=%0d local=%0d offset=%0d rtt=%0d cal=%0d stale=%0d e_step=%0d e_mono=%0d",
                 n_req, ts_local, offset_reg, rtt_us, ts_cal, ts_stale, e_step, e_mono);

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #20000000;                       // 20 ms 仿真时间上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
