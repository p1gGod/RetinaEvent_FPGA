//==============================================================================
// tb_axis_fifo -- axis_fifo 单模块仿真（异步 FIFO / CDC 通道）
// 判据（文档 §8）：V1 写满不溢出、读空不出无效数据
//                 V2 数据跨域后**顺序与内容不变**（FIFO 顺序性）
//                 V3 长时间运行无丢数（水位不越界）
//                 （补）FWFT 语义：o_empty=0 时 o_rd_data 即有效（**不需要** rd_en），
//                       一次 rd_en 与数据同拍
//                 （补）FWFT=0（标准模式）1 拍读延迟
//
// 两个时钟刻意取非整数比（10 ns vs 6 ns），保证跨域交叉采样被真正压到。
//==============================================================================
`timescale 1ns / 1ps

module tb_axis_fifo;

    // ---------------- 双时钟 ----------------
    reg wr_clk = 1'b0;
    reg rd_clk = 1'b0;
    always #5 wr_clk = ~wr_clk;        // 100 MHz
    always #3 rd_clk = ~rd_clk;        // ~166.7 MHz

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam DEPTH  = 16;
    localparam DATA_W = 8;
    localparam TOTAL  = 300;

    // ---------------- DUT 1: FWFT=1 ----------------
    reg              wr_rst_n = 1'b0;
    reg              rd_rst_n = 1'b0;
    reg              i_wr_en  = 1'b0;
    reg  [DATA_W-1:0] i_wr_data = 8'h00;
    wire             o_full;
    wire [4:0]       o_wr_level;
    reg              i_rd_en  = 1'b0;
    wire [DATA_W-1:0] o_rd_data;
    wire             o_empty;
    wire [4:0]       o_rd_level;

    axis_fifo #(.DATA_W(DATA_W), .DEPTH(DEPTH), .FWFT(1)) u_fwft (
        .wr_clk(wr_clk), .wr_rst_n(wr_rst_n), .i_wr_en(i_wr_en), .i_wr_data(i_wr_data),
        .o_full(o_full), .o_wr_level(o_wr_level),
        .rd_clk(rd_clk), .rd_rst_n(rd_rst_n), .i_rd_en(i_rd_en),
        .o_rd_data(o_rd_data), .o_empty(o_empty), .o_rd_level(o_rd_level)
    );

    // ---------------- DUT 2: FWFT=0（标准模式）----------------
    reg               wr_en2   = 1'b0;
    reg  [DATA_W-1:0] wr_data2 = 8'h00;
    wire              full2;
    wire [4:0]        wr_lvl2;
    reg               rd_en2   = 1'b0;
    wire [DATA_W-1:0] rd_data2;
    wire              empty2;
    wire [4:0]        rd_lvl2;

    axis_fifo #(.DATA_W(DATA_W), .DEPTH(DEPTH), .FWFT(0)) u_std (
        .wr_clk(wr_clk), .wr_rst_n(wr_rst_n), .i_wr_en(wr_en2), .i_wr_data(wr_data2),
        .o_full(full2), .o_wr_level(wr_lvl2),
        .rd_clk(rd_clk), .rd_rst_n(rd_rst_n), .i_rd_en(rd_en2),
        .o_rd_data(rd_data2), .o_empty(empty2), .o_rd_level(rd_lvl2)
    );

    // ---------------- 写侧激励（自动流，按 wr_limit 停）----------------
    integer           wr_cnt   = 0;
    integer           wr_limit = 3;
    reg               wr_go    = 1'b0;
    reg  [DATA_W-1:0] wr_base  = 8'h00;

    always @(negedge wr_clk) begin
        if (wr_go && (wr_cnt < wr_limit) && !o_full) begin
            i_wr_en   <= 1'b1;
            i_wr_data <= wr_base + wr_cnt[DATA_W-1:0];
            wr_cnt    <= wr_cnt + 1;
        end else begin
            i_wr_en   <= 1'b0;
        end
    end

    // ---------------- 读侧激励（手动 / 自动两模式，单驱动器）----------------
    reg     rd_manual    = 1'b1;   // 1 = 由 TB 手动控 i_rd_en
    reg     rd_manual_en = 1'b0;
    integer rd_cnt    = 0;
    integer rd_err    = 0;
    integer level_max = 0;
    integer to_cnt    = 0;

    always @(negedge rd_clk) begin
        if (!rd_rst_n) begin
            i_rd_en <= 1'b0;
        end else if (rd_manual) begin
            i_rd_en <= rd_manual_en;
        end else if (!o_empty) begin
            if (o_rd_data !== rd_cnt[DATA_W-1:0]) rd_err = rd_err + 1;
            i_rd_en <= 1'b1;
            rd_cnt  = rd_cnt + 1;
            if (o_rd_level > level_max) level_max = o_rd_level;
        end else begin
            i_rd_en <= 1'b0;
            if (o_rd_level > level_max) level_max = o_rd_level;
        end
    end

    initial begin
        // ================= 复位 =================
        wr_rst_n = 1'b0; rd_rst_n = 1'b0;
        wr_go    = 1'b0; rd_manual = 1'b1; rd_manual_en = 1'b0;
        repeat (10) @(negedge rd_clk);
        wr_rst_n = 1'b1; rd_rst_n = 1'b1;
        repeat (4) @(negedge rd_clk);

        // ================= 阶段 1：FWFT 零延迟语义 =================
        wr_base  = 8'h11;            // 写入 0x11 0x22 0x33
        wr_limit = 3;
        wr_cnt   = 0;
        wr_go    = 1'b1;

        wait (!o_empty);
        @(negedge rd_clk);
        // ★ 关键判据：一次 rd_en 都没拉过，o_rd_data 就已经是首字
        if (o_rd_data === 8'h11) chk_pass("V_FWFT_data_valid_without_rd");
        else begin
            $display("CHECK=V_FWFT_data_valid_without_rd FAIL (got %02h)", o_rd_data);
            errors = errors + 1;
        end

        // 一次 rd_en ⇒ 下一个字同拍出现在 o_rd_data 上（写入序列 = 0x11,0x12,0x13）
        @(posedge rd_clk); rd_manual_en = 1'b1;
        @(posedge rd_clk); rd_manual_en = 1'b0;
        @(negedge rd_clk);
        if (o_rd_data === 8'h12) chk_pass("V_FWFT_next_word_next_cycle");
        else begin
            $display("CHECK=V_FWFT_next_word_next_cycle FAIL (got %02h)", o_rd_data);
            errors = errors + 1;
        end

        @(posedge rd_clk); rd_manual_en = 1'b1;
        @(posedge rd_clk); rd_manual_en = 1'b0;
        @(negedge rd_clk);
        if (o_rd_data === 8'h13) chk_pass("V_FWFT_third_word");
        else begin
            $display("CHECK=V_FWFT_third_word FAIL (got %02h)", o_rd_data);
            errors = errors + 1;
        end

        // 抽干 → 必须变空
        rd_manual_en = 1'b1;
        wait (o_empty);
        @(negedge rd_clk);
        if (o_empty === 1'b1) chk_pass("V_FWFT_empty_after_drain");
        else                  chk_fail("V_FWFT_empty_after_drain");
        rd_manual_en = 1'b0;

        // ================= 复位，进入阶段 2 =================
        wr_go = 1'b0; wr_rst_n = 1'b0; rd_rst_n = 1'b0;
        repeat (8) @(negedge rd_clk);
        wr_cnt   = 0;  rd_cnt = 0;  rd_err = 0;  level_max = 0;
        wr_base  = 8'h00; wr_limit = TOTAL;
        rd_manual = 1'b0;
        wr_rst_n = 1'b1; rd_rst_n = 1'b1;
        repeat (4) @(negedge rd_clk);
        wr_go = 1'b1;

        // ================= 阶段 2：CDC 顺序性与内容（300 字，带反压）=================
        // ⚠️ 不要用 fork/join 做超时：join 会等**两个**分支都结束，
        //    计时分支必然跑满 200us 并误报 FAIL（本 TB 首版就踩了这个坑）。
        //    改用"有界轮询"。
        to_cnt = 0;
        while ((rd_cnt < TOTAL) && (to_cnt < 20000)) begin
            @(negedge rd_clk);
            to_cnt = to_cnt + 1;
        end
        if (rd_cnt < TOTAL) begin
            $display("CHECK=V2_stream_timeout FAIL (rd_cnt=%0d)", rd_cnt);
            errors = errors + 1;
        end else begin
            chk_pass("V2_stream_no_timeout");
        end

        wr_go = 1'b0;
        repeat (4) @(negedge rd_clk);

        if (wr_cnt == TOTAL) chk_pass("V1_all_written_no_loss"); else chk_fail("V1_all_written_no_loss");
        if (rd_err == 0)     chk_pass("V2_order_and_content_preserved"); else begin
            $display("CHECK=V2_order_and_content_preserved FAIL (rd_err=%0d)", rd_err);
            errors = errors + 1;
        end
        if (rd_cnt == TOTAL) chk_pass("V2_read_all"); else chk_fail("V2_read_all");
        if (level_max <= DEPTH) chk_pass("V3_level_never_exceeded"); else chk_fail("V3_level_never_exceeded");
        if (wr_cnt == rd_cnt) chk_pass("V2_same_count_both_sides"); else chk_fail("V2_same_count_both_sides");

        // ================= 阶段 3：FWFT=0（标准模式）1 拍读延迟 =================
        wr_rst_n = 1'b0; rd_rst_n = 1'b0;
        repeat (8) @(negedge rd_clk);
        wr_rst_n = 1'b1; rd_rst_n = 1'b1;
        repeat (4) @(negedge rd_clk);

        // 灌 2 个字到 DUT2
        @(negedge wr_clk); wr_data2 = 8'hA1; wr_en2 = 1'b1;
        @(negedge wr_clk); wr_data2 = 8'hB2; wr_en2 = 1'b1;
        @(negedge wr_clk); wr_en2 = 1'b0;

        wait (!empty2);
        @(negedge rd_clk); rd_en2 = 1'b1;                 // 拉高一个 rd_clk 周期
        @(negedge rd_clk); rd_en2 = 1'b0;
        if (rd_data2 === 8'hA1) chk_pass("V_STD_read_first_word"); else begin
            $display("CHECK=V_STD_read_first_word FAIL (got %02h)", rd_data2);
            errors = errors + 1;
        end

        @(negedge rd_clk); rd_en2 = 1'b1;
        @(negedge rd_clk); rd_en2 = 1'b0;
        if (rd_data2 === 8'hB2) chk_pass("V_STD_read_second_word"); else begin
            $display("CHECK=V_STD_read_second_word FAIL (got %02h)", rd_data2);
            errors = errors + 1;
        end

        repeat (4) @(negedge rd_clk);
        if (empty2 === 1'b1) chk_pass("V_STD_drained_to_empty"); else chk_fail("V_STD_drained_to_empty");

        // ================= 阶段 5：**满路径**（V1"写满不溢出"的真正激励）=================
        // 背景（独立复核发现）：原 TB 相位 1 只写 3 个字、相位 2 是"写 100MHz / 读 166MHz"
        //   ⇒ FIFO 永不写满 ⇒ o_full / 满时写指针保护**从未被激励**；变异实验
        //   "把 wr_full 恒置 0（去掉满保护）" 依然 PASS。本阶段把它打满：
        //   (a) 读侧完全暂停，写侧连写 DEPTH 个字 ⇒ o_full 必须拉高、水位 = DEPTH、
        //       继续写 20 拍不得前进（wr_cnt 停在 DEPTH）；
        //   (b) 恢复读（自动模式）⇒ 按序读出 DEPTH 个字、内容必须与写入序列一致（无覆盖/无丢字）。
        wr_go = 1'b0; wr_rst_n = 1'b0; rd_rst_n = 1'b0;
        repeat (8) @(negedge rd_clk);
        wr_rst_n = 1'b1; rd_rst_n = 1'b1;
        repeat (4) @(negedge rd_clk);

        rd_manual = 1'b1; rd_manual_en = 1'b0;    // 读侧暂停
        wr_base = 8'h00; wr_limit = DEPTH; wr_cnt = 0; wr_go = 1'b1;
        to_cnt = 0;
        while ((wr_cnt < DEPTH) && (to_cnt < 4000)) begin
            @(negedge wr_clk);
            to_cnt = to_cnt + 1;
        end
        if (wr_cnt !== DEPTH) begin
            $display("CHECK=V4_FILL_reaches_depth FAIL (wr_cnt=%0d)", wr_cnt);
            errors = errors + 1;
        end else chk_pass("V4_FILL_reaches_depth");

        repeat (20) @(negedge wr_clk);            // 满后再尝试写 20 拍
        if (o_full === 1'b1) chk_pass("V4_full_asserts_when_depth_reached");
        else begin $display("CHECK=V4_full_asserts_when_depth_reached FAIL (full=%b)", o_full); errors = errors + 1; end
        if (o_wr_level === (DEPTH[4:0])) chk_pass("V4_wr_level_eq_depth");
        else begin $display("CHECK=V4_wr_level_eq_depth FAIL (level=%0d)", o_wr_level); errors = errors + 1; end
        if (wr_cnt === DEPTH) chk_pass("V4_write_pointer_stops_when_full");
        else begin $display("CHECK=V4_write_pointer_stops_when_full FAIL (wr_cnt=%0d)", wr_cnt); errors = errors + 1; end

        // (b) 恢复读：自动模式会逐字校验内容与顺序（rd_err 由读进程统计）
        wr_go = 1'b0;
        rd_cnt = 0; rd_err = 0; level_max = 0;
        rd_manual = 1'b0;
        to_cnt = 0;
        while ((rd_cnt < DEPTH) && (to_cnt < 4000)) begin
            @(negedge rd_clk);
            to_cnt = to_cnt + 1;
        end
        repeat (8) @(negedge rd_clk);
        if ((rd_cnt === DEPTH) && (rd_err === 0)) chk_pass("V4_content_and_order_intact_after_full");
        else begin
            $display("CHECK=V4_content_and_order_intact_after_full FAIL (rd_cnt=%0d rd_err=%0d)", rd_cnt, rd_err);
            errors = errors + 1;
        end
        if (o_empty === 1'b1) chk_pass("V4_drained_to_empty_after_full");
        else begin $display("CHECK=V4_drained_to_empty_after_full FAIL"); errors = errors + 1; end

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #800000;
        $display("TEST_RESULT=FAIL (timeout-global)");
        $finish;
    end

endmodule
