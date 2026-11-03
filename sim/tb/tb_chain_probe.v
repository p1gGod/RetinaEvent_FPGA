//==============================================================================
// tb_chain_probe -- 只读诊断 TB（不参与交付，Vivado 不编译；只在 sim/tb/）
//
// 目的：把与 retina_core 完全相同的引擎链复现出来，验证 R3 修复后：
//   · spatial_lap.o_vsync 每帧恰好 1 个脉冲（Bug A 已修）
//   · event_gen 事件数从 0 变成非 0（Bug B 已修）
//   · 事件坐标落在运动方块的**真实位置**上（R3：坐标随流走）
// 链路：vps_pattern_gen(MODE=2 运动方块) → vps_resample → px_luma → luma_log
//       → temporal_diff → spatial_lap → event_gen
// 方块几何：图案空间 x∈[100+frame, 164+frame)、y∈[200,264)
//       ⇒ 抽点后 x∈[50,82)、y∈[100,132)
//==============================================================================
`timescale 1ns / 1ps

module tb_chain_probe;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    reg        rst_n = 1'b0;
    reg  [1:0] i_mode = 2'd2;      // 2 = 运动方块
    reg        i_en   = 1'b1;

    //--- 采集 --------------------------------------------------------------
    wire        pv, pd;
    wire [15:0] pdata;
    vps_pattern_gen #(.IMG_W(800), .IMG_H(480), .H_TOTAL(1056), .V_TOTAL(525), .FRAME_DIV(1)) u_pat (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_mode(i_mode), .i_en(i_en),
        .o_vsync(pv), .o_de(pd), .o_data(pdata)
    );

    wire        rv, rd;
    wire [15:0] rdata;
    vps_resample u_rs (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(pv), .i_de(pd), .i_data(pdata),
        .o_vsync(rv), .o_de(rd), .o_data(rdata)
    );

    //--- 引擎链 ------------------------------------------------------------
    wire       l1v, l1d;
    wire [7:0] l1y;
    px_luma u_l1 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(rv), .i_de(rd), .i_data(rdata),
        .o_vsync(l1v), .o_de(l1d), .o_y(l1y)
    );

    wire       l2v, l2d;
    wire [7:0] l2l;
    luma_log #(.ROM_LATENCY(1), .USE_ROM_IP(0)) u_l2 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(l1v), .i_de(l1d), .i_y(l1y),
        .o_vsync(l2v), .o_de(l2d), .o_l(l2l)
    );

    reg  first_frame = 1'b1;
    reg  vs_had_px   = 1'b0;
    always @(posedge clk) begin
        if (!rst_n) begin
            first_frame <= 1'b1;
            vs_had_px   <= 1'b0;
        end else begin
            if (rd) vs_had_px <= 1'b1;
            if (rv) begin
                if (vs_had_px) first_frame <= 1'b0;
                vs_had_px <= 1'b0;
            end
        end
    end

    wire       l3v, l3d;
    wire [8:0] l3dl;
    temporal_diff #(.IMG_W(400), .IMG_H(240), .ADDR_W(17), .BRAM_PACK("4Kx9")) u_l3 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(l2v), .i_de(l2d), .i_l(l2l),
        .i_first_frame(first_frame),
        .o_vsync(l3v), .o_de(l3d), .o_dl(l3dl)
    );

    wire        l4v, l4d;
    wire [11:0] l4lap;
    wire [8:0]  l4x, l4dlc;
    wire [7:0]  l4y;
    spatial_lap #(.IMG_W(400), .CENTER_GAIN(4), .NORM_SHIFT(2), .EDGE_MODE(0)) u_l4 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_vsync(l3v), .i_de(l3d), .i_dl(l3dl),
        .o_vsync(l4v), .o_de(l4d), .o_lap(l4lap),
        .o_x(l4x), .o_y(l4y), .o_dl_c(l4dlc)
    );

    wire       evv, evp;
    wire [8:0] evx;
    wire [7:0] evy;
    event_gen #(.THETA_ON(74), .THETA_OFF(74), .MIN_DL(2), .POL_ON_IS_1(1)) u_l5 (
        .clk_cam(clk), .rst_n_cam(rst_n), .i_de(l4d),
        .i_lap(l4lap), .i_dl_c(l4dlc), .i_x(l4x), .i_y(l4y),
        .i_theta(12'd0), .i_min_dl(9'd0),
        .o_ev_valid(evv), .o_ev_x(evx), .o_ev_y(evy), .o_ev_pol(evp)
    );

    //--- 逐帧统计 ----------------------------------------------------------
    integer ev_frame = 0, frm = 0;
    integer n_de = 0, n_l4v = 0, n_l3d = 0, n_l4d = 0, n_evv = 0, n_lap_over = 0;
    integer ev_xmin, ev_xmax, ev_ymin, ev_ymax;
    integer dbg = 0;

    always @(posedge clk) begin
        if (rd)   n_de  = n_de  + 1;
        if (l3d)  n_l3d = n_l3d + 1;
        if (l4d)  n_l4d = n_l4d + 1;
        if (l4v)  n_l4v = n_l4v + 1;
        if (l4d && $signed(l4lap) >= 12'sd74) n_lap_over = n_lap_over + 1;
        if (evv) begin
            ev_frame = ev_frame + 1;
            n_evv    = n_evv + 1;
            if (evx < ev_xmin) ev_xmin = evx;
            if (evx > ev_xmax) ev_xmax = evx;
            if (evy < ev_ymin) ev_ymin = evy;
            if (evy > ev_ymax) ev_ymax = evy;
            if (frm >= 2 && dbg < 6) begin
                dbg = dbg + 1;
                $display("      EV frm=%0d x=%0d y=%0d pol=%0d lap=%0d dl_c=%0d",
                         frm, evx, evy, evp, $signed(l4lap), $signed(l4dlc));
            end
        end
        if (rv) begin
            $display("      FRAME %0d: ev=%0d l4v=%0d l3d=%0d l4d=%0d lap>=74=%0d rs_de=%0d | ev_x[%0d..%0d] ev_y[%0d..%0d]",
                     frm, ev_frame, n_l4v, n_l3d, n_l4d, n_lap_over, n_de,
                     ev_xmin, ev_xmax, ev_ymin, ev_ymax);
            ev_frame = 0; n_de = 0; n_l4v = 0; n_l3d = 0; n_l4d = 0; n_lap_over = 0;
            ev_xmin = 4096; ev_xmax = 0; ev_ymin = 4096; ev_ymax = 0;
            frm = frm + 1;
        end
    end

    integer guard;

    initial begin
        ev_xmin = 4096; ev_xmax = 0; ev_ymin = 4096; ev_ymax = 0;
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);
        guard = 0;
        while ((frm < 6) && (guard < 6000000)) begin @(negedge clk); guard = guard + 1; end
        $display("      PROBE DONE frames=%0d guard=%0d", frm, guard);
        $display("TEST_RESULT=PASS");
        $finish;
    end

    initial begin
        #120_000_000;
        $display("      PROBE TIMEOUT frm=%0d", frm);
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
