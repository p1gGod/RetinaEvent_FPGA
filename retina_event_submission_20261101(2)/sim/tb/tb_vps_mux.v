//==============================================================================
// tb_vps_mux -- vps_mux 单模块仿真（L2 采集）
// 判据（文档 §8）：
//   V1  i_sel 变化后，输出在**下一个帧边界**才切换
//   V2  不产生半帧拼接（每帧数据全来自同一源）
//   V3  两路都不使能时输出 de = 0
//   （补）ALIGN_LATENCY=2 分支与 LATENCY=0 输出严格差 2 拍
//==============================================================================
`timescale 1ns / 1ps

module tb_vps_mux;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n = 1'b0;
    reg [1:0]  i_sel = 2'd0;
    reg        a_vsync = 1'b0, a_de = 1'b0;
    reg [15:0] a_data  = 16'hAAAA;
    reg        b_vsync = 1'b0, b_de = 1'b0;
    reg [15:0] b_data  = 16'h5555;

    wire        o_vsync, o_de;
    wire [15:0] o_data;

    wire        o2_vsync, o2_de;
    wire [15:0] o2_data;

    vps_mux #(.ALIGN_LATENCY(0)) u0 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_sel(i_sel),
        .a_vsync(a_vsync), .a_de(a_de), .a_data(a_data),
        .b_vsync(b_vsync), .b_de(b_de), .b_data(b_data),
        .o_vsync(o_vsync), .o_de(o_de), .o_data(o_data)
    );

    vps_mux #(.ALIGN_LATENCY(2)) u2 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_sel(i_sel),
        .a_vsync(a_vsync), .a_de(a_de), .a_data(a_data),
        .b_vsync(b_vsync), .b_de(b_de), .b_data(b_data),
        .o_vsync(o2_vsync), .o_de(o2_de), .o_data(o2_data)
    );

    // u0 输出延迟 2 拍的参考
    reg [17:0] ref_d1, ref_d2;
    always @(posedge clk) begin
        if (!rst_n) begin
            ref_d1 <= 18'd0;
            ref_d2 <= 18'd0;
        end else begin
            ref_d1 <= {o_vsync, o_de, o_data};
            ref_d2 <= ref_d1;
        end
    end

    integer i;
    integer bad_a;
    integer bad_b;
    integer bad_align;
    integer n_de;

    // 驱动一个周期（组合输出立即检查），并核对 LATENCY=2 实例
    task cyc;
        input        av, ad, bv, bd;
        input [15:0] adt, bdt;
        input [1:0]  sel;
        input        exp_de;
        input [15:0] exp_data;
        begin
            a_vsync = av; a_de = ad; a_data = adt;
            b_vsync = bv; b_de = bd; b_data = bdt;
            i_sel   = sel;
            #1;
            if (o_de !== exp_de) begin
                chk_fail("V1_sel_frame_sync");
            end else if (exp_de && (o_data !== exp_data)) begin
                chk_fail("V2_no_half_frame");
            end else begin
                chk_pass("V2_no_half_frame");
            end
            @(negedge clk);
            if ({o2_vsync, o2_de, o2_data} !== ref_d2) bad_align = bad_align + 1;
        end
    endtask

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        bad_align = 0;

        //======================================================================
        // 帧 1：sel=0 → 输出 A；帧中切 sel=1，输出必须仍是 A（帧同步）
        //======================================================================
        bad_a = 0;
        n_de  = 0;
        cyc(1'b1, 1'b0, 1'b1, 1'b0, 16'hAAAA, 16'h5555, 2'd0, 1'b0, 16'h0000);
        for (i = 0; i < 8; i = i + 1) begin
            // 第 4 个数据周期开始请求切到 B
            cyc(1'b0, 1'b1, 1'b0, 1'b1, 16'hAAAA, 16'h5555,
                (i >= 3) ? 2'd1 : 2'd0, 1'b1, 16'hAAAA);
            n_de = n_de + 1;
            if (o_data !== 16'hAAAA) bad_a = bad_a + 1;
        end
        if (bad_a == 0) chk_pass("V1_sel_frame_sync"); else chk_fail("V1_sel_frame_sync");
        if (n_de == 8) chk_pass("V2_frame_a_complete"); else chk_fail("V2_frame_a_complete");

        // 帧间空拍
        cyc(1'b0, 1'b0, 1'b0, 1'b0, 16'hAAAA, 16'h5555, 2'd1, 1'b0, 16'h0000);
        cyc(1'b0, 1'b0, 1'b0, 1'b0, 16'hAAAA, 16'h5555, 2'd1, 1'b0, 16'h0000);
        if (o_de === 1'b0) chk_pass("V3_both_idle_de0"); else chk_fail("V3_both_idle_de0");

        //======================================================================
        // 帧 2：帧边界 vsync → 切换生效，输出 B；帧中切回 0 必须等到下一帧
        //======================================================================
        bad_b = 0;
        n_de  = 0;
        cyc(1'b1, 1'b0, 1'b1, 1'b0, 16'hAAAA, 16'h5555, 2'd1, 1'b0, 16'h0000);
        for (i = 0; i < 8; i = i + 1) begin
            cyc(1'b0, 1'b1, 1'b0, 1'b1, 16'hAAAA, 16'h5555,
                (i >= 4) ? 2'd0 : 2'd1, 1'b1, 16'h5555);
            n_de = n_de + 1;
            if (o_data !== 16'h5555) bad_b = bad_b + 1;
        end
        if (bad_b == 0) chk_pass("V1_sel_frame_sync_to_b"); else chk_fail("V1_sel_frame_sync_to_b");
        if (n_de == 8) chk_pass("V2_frame_b_complete"); else chk_fail("V2_frame_b_complete");

        cyc(1'b0, 1'b0, 1'b0, 1'b0, 16'hAAAA, 16'h5555, 2'd0, 1'b0, 16'h0000);

        //======================================================================
        // 帧 3：帧边界 → 切回 A
        //======================================================================
        cyc(1'b1, 1'b0, 1'b1, 1'b0, 16'hAAAA, 16'h5555, 2'd0, 1'b0, 16'h0000);
        cyc(1'b0, 1'b1, 1'b0, 1'b1, 16'hAAAA, 16'h5555, 2'd0, 1'b1, 16'hAAAA);
        cyc(1'b0, 1'b1, 1'b0, 1'b1, 16'hAAAA, 16'h5555, 2'd0, 1'b1, 16'hAAAA);
        chk_pass("V1_sel_frame_sync_back_to_a");

        //======================================================================
        // 集成回归（Lead 报告的反例，2026-10-03）：
        //   **a_vsync 恒 0（模拟"没有摄像头 / 相机没出图"）**，只有 b 正常出帧。
        //   R1  i_sel=1 ⇒ 输出必须来自 B（不能因为 a 无帧边界就永远选不上）
        //   R2  中途把 i_sel 改回 0 ⇒ 必须在 **b 的帧边界** 切换（不再依赖 a）
        //   ⚠️ 把 vps_mux 退回"只在 a_vsync 帧边界切换"的写法时，这两条必须 FAIL。
        //======================================================================
        bad_b = 0;
        cyc(1'b0, 1'b0, 1'b1, 1'b0, 16'hAAAA, 16'h5555, 2'd1, 1'b0, 16'h0000);  // b 帧边界
        for (i = 0; i < 4; i = i + 1) begin
            cyc(1'b0, 1'b0, 1'b0, 1'b1, 16'hAAAA, 16'h5555, 2'd1, 1'b1, 16'h5555);
            if (o_data !== 16'h5555) bad_b = bad_b + 1;
        end
        if (bad_b == 0) chk_pass("R1_no_camera_selects_b"); else chk_fail("R1_no_camera_selects_b");

        bad_a = 0;
        for (i = 0; i < 4; i = i + 1) begin
            cyc(1'b0, 1'b0, 1'b0, 1'b1, 16'hAAAA, 16'h5555, 2'd0, 1'b1, 16'h5555);
            if (o_data !== 16'h5555) bad_a = bad_a + 1;
        end
        if (bad_a == 0) chk_pass("R2_switch_waits_for_b_frame"); else chk_fail("R2_switch_waits_for_b_frame");

        // b 的帧边界 → 此刻才切回 A
        cyc(1'b0, 1'b0, 1'b1, 1'b0, 16'hAAAA, 16'h5555, 2'd0, 1'b0, 16'h0000);
        // 下一拍 b_de=1：若已切到 A，则 o_de 必为 0（a 无数据）
        a_vsync = 1'b0; a_de = 1'b0; a_data = 16'hAAAA;
        b_vsync = 1'b0; b_de = 1'b1; b_data = 16'h5555;
        i_sel   = 2'd0;
        #1;
        if (o_de === 1'b0) chk_pass("R2_switch_at_b_frame_boundary");
        else               chk_fail("R2_switch_at_b_frame_boundary");
        @(negedge clk);
        if ({o2_vsync, o2_de, o2_data} !== ref_d2) bad_align = bad_align + 1;

        //======================================================================
        // ALIGN_LATENCY=2 分支
        //======================================================================
        if (bad_align == 0) chk_pass("P1_align_latency2_matches");
        else begin
            chk_fail("P1_align_latency2_matches");
            $display("      mismatch cycles = %0d", bad_align);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
