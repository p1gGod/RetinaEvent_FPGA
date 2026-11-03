//==============================================================================
// tb_stats_counter -- stats_counter 单模块仿真（L2 事件引擎，P0）
// 判据（文档 §8）：
//   V1  注入 N 个事件/帧 → o_ev_per_frame = N
//   V2  注入 96 个事件（ρ=0.1%）→ CR_x10 ≈ 6667（640000/ev 口径）
//   V3  统计值在**帧边界**更新（帧内保持不变）
//   V4  长跑不溢出：10,000 帧后 o_frame_cnt / o_ev_total 正确
//   V5  静止场景（0 事件）→ ρ = 0，CR 饱和
//   （补）i_px_valid 统计的每帧像素数 = IMG_W×IMG_H（层次化引用 px_lat 检查）
//==============================================================================
`timescale 1ns / 1ps

module tb_stats_counter;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n   = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_ev    = 1'b0;
    reg        i_px    = 1'b0;

    wire [23:0] m_evpf, m_cr;
    wire [15:0] m_act;
    wire [31:0] m_frm, m_tot;

    // 默认几何（400×240，PX=96000）
    stats_counter #(.IMG_W(400), .IMG_H(240), .B_PX(16), .B_EV(24), .Q_FRAC(16)) u_main (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(i_vsync),
        .i_ev_valid(i_ev), .i_px_valid(i_px),
        .o_ev_per_frame(m_evpf), .o_activity_q16(m_act), .o_cr_x10(m_cr),
        .o_frame_cnt(m_frm), .o_ev_total(m_tot)
    );

    // 小几何（8×4，PX=32）用于长跑
    reg        s_vsync = 1'b0;
    reg        s_ev    = 1'b0;
    wire [23:0] s_evpf, s_cr;
    wire [15:0] s_act;
    wire [31:0] s_frm, s_tot;

    stats_counter #(.IMG_W(8), .IMG_H(4), .B_PX(16), .B_EV(24), .Q_FRAC(16)) u_small (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(s_vsync),
        .i_ev_valid(s_ev), .i_px_valid(1'b0),
        .o_ev_per_frame(s_evpf), .o_activity_q16(s_act), .o_cr_x10(s_cr),
        .o_frame_cnt(s_frm), .o_ev_total(s_tot)
    );

    integer k, n;

    // 跑一帧：vsync → 注入 nev 个事件（可选驱动 npix 个像素）→ vsync 锁存
    task frame;
        input integer nev;
        input integer npix;
        integer j;
        begin
            @(negedge clk);
            i_vsync = 1'b1; i_ev = 1'b0; i_px = 1'b0;
            @(negedge clk);
            i_vsync = 1'b0;
            for (j = 0; j < nev; j = j + 1) begin
                @(negedge clk);
                i_ev = 1'b1;
            end
            @(negedge clk);
            i_ev = 1'b0;
            for (j = 0; j < npix; j = j + 1) begin
                @(negedge clk);
                i_px = 1'b1;
            end
            @(negedge clk);
            i_px = 1'b0;
            // 帧边界锁存
            @(negedge clk);
            i_vsync = 1'b1;
            @(negedge clk);
            i_vsync = 1'b0;
        end
    endtask

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        //======================================================================
        // V1/V2/V5：默认几何
        //======================================================================
        // 帧 1：96 个事件 + 96,000 个像素
        frame(96, 96000);
        if (m_evpf == 24'd96) chk_pass("V1_ev_per_frame_96"); else begin
            chk_fail("V1_ev_per_frame_96");
            $display("      got %0d", m_evpf);
        end
        // ρ = 96/96000 × 65536 = 65.5 → 65
        if (m_act == 16'd65) chk_pass("V2_activity_q16_65"); else begin
            chk_fail("V2_activity_q16_65");
            $display("      got %0d (expect 65)", m_act);
        end
        // px_lat = 96000（层次化引用：i_px_valid 自检计数）
        if (u_main.px_lat == 24'd96000) chk_pass("P1_px_lat_96000"); else begin
            chk_fail("P1_px_lat_96000");
            $display("      got %0d", u_main.px_lat);
        end
        // CR_x10 = round(640000/96) = 6667（除法器 24 拍后才出）
        repeat (40) @(negedge clk);
        if ((m_cr >= 24'd6660) && (m_cr <= 24'd6670)) chk_pass("V2_cr_x10_6670"); else begin
            chk_fail("V2_cr_x10_6670");
            $display("      got %0d (expect ≈6667)", m_cr);
        end

        //======================================================================
        // V3：帧内统计值保持不变，只在帧边界更新
        //   （frame() 已经以一次 vsync 收尾 ⇒ 当前已在新帧内，直接注入事件）
        //======================================================================
        for (k = 0; k < 500; k = k + 1) begin
            @(negedge clk);
            i_ev = 1'b1;
        end
        @(negedge clk);
        i_ev = 1'b0;
        // 帧内：o_ev_per_frame 必须仍是上一帧的 96
        if (m_evpf == 24'd96) chk_pass("V3_hold_within_frame"); else chk_fail("V3_hold_within_frame");
        // 帧边界后 → 500
        @(negedge clk);
        i_vsync = 1'b1;
        @(negedge clk);
        i_vsync = 1'b0;
        if (m_evpf == 24'd500) chk_pass("V3_update_at_frame_boundary"); else begin
            chk_fail("V3_update_at_frame_boundary");
            $display("      got %0d (expect 500)", m_evpf);
        end
        repeat (40) @(negedge clk);
        // CR_x10 = round(640000/500) = 1280
        if ((m_cr >= 24'd1276) && (m_cr <= 24'd1284)) chk_pass("V2_cr_x10_1280"); else begin
            chk_fail("V2_cr_x10_1280");
            $display("      got %0d (expect ≈1280)", m_cr);
        end

        //======================================================================
        // V5：静止场景（0 事件）→ ρ = 0，CR 饱和
        //======================================================================
        frame(0, 100);
        if (m_evpf == 24'd0 && m_act == 16'd0) chk_pass("V5_static_rho_zero"); else chk_fail("V5_static_rho_zero");
        repeat (40) @(negedge clk);
        if (m_cr == 24'hFFFFFF) chk_pass("V5_static_cr_saturate"); else begin
            chk_fail("V5_static_cr_saturate");
            $display("      got %0d", m_cr);
        end

        //======================================================================
        // V4：小几何长跑 10,000 帧，每帧 1 个事件 → 不溢出、计数正确
        //======================================================================
        for (n = 0; n < 10000; n = n + 1) begin
            @(negedge clk);
            s_vsync = 1'b1; s_ev = 1'b1;
            @(negedge clk);
            s_vsync = 1'b0; s_ev = 1'b0;
            repeat (40) @(negedge clk);     // 帧周期 40 拍（> 除法器 24 拍）
        end
        if (s_frm == 32'd10000) chk_pass("V4_frame_cnt_10000"); else begin
            chk_fail("V4_frame_cnt_10000");
            $display("      got %0d", s_frm);
        end
        if (s_tot == 32'd10000) chk_pass("V4_ev_total_10000"); else begin
            chk_fail("V4_ev_total_10000");
            $display("      got %0d", s_tot);
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200_000_000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
