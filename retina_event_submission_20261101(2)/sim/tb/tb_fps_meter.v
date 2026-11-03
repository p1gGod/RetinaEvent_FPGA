//==============================================================================
// tb_fps_meter.v —— LCD 帧率表自测（用户需求 2026-10-11）
//
// 判据：
//   F1  采集帧率 = 窗口内帧计数增量（按已知激励速率核对）
//   F2  事件帧率 = 窗口内"有事件帧"数（只计 i_ev_per_frame != 0 的帧）
//   F3  i_show_ev 选择：事件/合成画面 → 事件帧率；纯原始 → 采集帧率
//   F4  模式标签随 i_mode 寄存输出
//   F5  饱和：帧率超 255 输出 255（不回卷）
//
// 激励：帧周期 100 拍、窗口 1000 拍 ⇒ 每窗口恰 10 帧；偶数帧带事件 ⇒ 事件帧率 5。
//==============================================================================
`timescale 1ns / 1ps

module tb_fps_meter;

    reg clk = 1'b0;
    always #1 clk = ~clk;

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    // 激励（单驱动源）：帧周期 100 拍；偶数帧带事件；阶段 3 每拍一帧
    reg [31:0] frame_cnt = 32'd0;
    reg [23:0] ev_pf     = 24'd0;
    reg        show_ev   = 1'b0;
    reg [1:0]  mode_in   = 2'd0;
    reg        fast_mode = 1'b0;
    reg [6:0]  div = 7'd0;

    always @(posedge clk) begin
        if (!rst_n) begin
            div      <= 7'd0;
            frame_cnt<= 32'd0;
            ev_pf    <= 24'd0;
        end
        else if (fast_mode) begin
            frame_cnt <= frame_cnt + 32'd1;
            ev_pf     <= 24'd123;
        end
        else if (div == 7'd99) begin
            div       <= 7'd0;
            frame_cnt <= frame_cnt + 32'd1;
            ev_pf     <= (frame_cnt[0] == 1'b0) ? 24'd123 : 24'd0;
        end
        else div <= div + 7'd1;
    end

    wire [7:0] fps;
    wire [1:0] mode_tag;

    fps_meter #(
        .CLK_FREQ_HZ (1000)            // 窗口 = 1000 拍（TB 加速）
    ) dut (
        .clk_cam        (clk),
        .rst_n_cam      (rst_n),
        .i_frame_cnt    (frame_cnt),
        .i_ev_per_frame (ev_pf),
        .i_show_ev      (show_ev),
        .i_mode         (mode_in),
        .o_fps          (fps),
        .o_mode_tag     (mode_tag)
    );

    integer k;
    initial begin
        repeat (10) @(posedge clk);
        rst_n <= 1'b1;

        // ---- 阶段 1：纯原始画面（show_ev=0）→ 采集帧率 = 10 ----
        show_ev = 1'b0;
        mode_in = 2'd1;
        repeat (2600) @(posedge clk);      // 跨 2 个完整窗口
        if (fps === 8'd10) chk_pass("F1_capture_fps_10");
        else begin
            chk_fail("F1_capture_fps_10");
            $display("  [E] fps=%0d (exp 10)", fps);
        end
        if (mode_tag === 2'd1) chk_pass("F4_mode_tag_reg");
        else                   chk_fail("F4_mode_tag_reg");

        // ---- 阶段 2：事件画面（show_ev=1）→ 事件帧率 = 5 ----
        show_ev = 1'b1;
        mode_in = 2'd2;
        repeat (2600) @(posedge clk);
        if (fps === 8'd5) chk_pass("F2_F3_event_fps_5");
        else begin
            chk_fail("F2_F3_event_fps_5");
            $display("  [E] fps=%0d (exp 5)", fps);
        end
        if (mode_tag === 2'd2) chk_pass("F4_mode_tag_ev");
        else                   chk_fail("F4_mode_tag_ev");

        // ---- 阶段 3：饱和（每拍一帧 ⇒ 窗口 1000 帧 → 255）----
        show_ev   = 1'b0;
        fast_mode = 1'b1;
        repeat (2600) @(posedge clk);
        if (fps === 8'hFF) chk_pass("F5_fps_saturate_255");
        else begin
            chk_fail("F5_fps_saturate_255");
            $display("  [E] fps=%0d", fps);
        end

        $display("INFO fps=%0d mode_tag=%0d", fps, mode_tag);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #1000000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
