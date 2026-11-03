//==============================================================================
// tb_cam_tap -- cam_tap 单模块仿真（L2 采集）
// 判据（文档 §8）：
//   V1  8→16bit 组包顺序正确（已知字节序列 → 期望像素）
//   V2  o_px_valid 每 2 拍 1 次
//   V3  一帧 o_px_valid 计数 = 800 × 480 = 384,000
//   V4  只读：源文件端口表里没有任何 "output ... cam_*"（脚本级扫描）
//   V5  （补）o_frame_start / o_line_start 为 1 拍脉冲
//   V6  （补）MSB_FIRST=0 时字节顺序翻转
//==============================================================================
`timescale 1ns / 1ps

module tb_cam_tap;

    //--- 时钟：cam_pclk ≈ 48 MHz（20.833 ns），取 20 ns 便于计数 -------------
    reg cam_pclk = 1'b0;
    always #10 cam_pclk = ~cam_pclk;

    integer errors = 0;

    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n_pclk = 1'b0;
    reg  [7:0] i_cam_data = 8'h00;
    reg        i_cam_vsync = 1'b0;
    reg        i_cam_href  = 1'b0;

    wire        o_px_valid;
    wire [15:0] o_px_data;
    wire        o_frame_start;
    wire        o_line_start;

    reg        msb_first = 1'b1;        // V6 用第二实例翻转字节序

    cam_tap #(.MSB_FIRST(1), .SAMPLE_ON_FALL(0)) u_dut (
        .cam_pclk      (cam_pclk),
        .rst_n_pclk    (rst_n_pclk),
        .i_cam_data    (i_cam_data),
        .i_cam_vsync   (i_cam_vsync),
        .i_cam_href    (i_cam_href),
        .o_px_valid    (o_px_valid),
        .o_px_data     (o_px_data),
        .o_frame_start (o_frame_start),
        .o_line_start  (o_line_start)
    );

    // MSB_FIRST=0 的对照实例（同一激励，只比字节顺序）
    wire        o_px_valid_b;
    wire [15:0] o_px_data_b;

    cam_tap #(.MSB_FIRST(0), .SAMPLE_ON_FALL(0)) u_dut_lsb (
        .cam_pclk      (cam_pclk),
        .rst_n_pclk    (rst_n_pclk),
        .i_cam_data    (i_cam_data),
        .i_cam_vsync   (i_cam_vsync),
        .i_cam_href    (i_cam_href),
        .o_px_valid    (o_px_valid_b),
        .o_px_data     (o_px_data_b),
        .o_frame_start (),
        .o_line_start  ()
    );

    //--- V3：跨整帧的 valid 计数（posedge 采样，独立于 TB 主流程） -----------
    reg [31:0] px_cnt = 32'd0;
    always @(posedge cam_pclk) begin
        if (!rst_n_pclk) px_cnt <= 32'd0;
        else if (o_px_valid) px_cnt <= px_cnt + 32'd1;
    end

    integer i;
    integer k;
    reg [7:0] bytes [0:15];
    reg [15:0] px_expected;
    reg [31:0] cnt_before;
    reg [31:0] valid_before;
    reg        prev_valid;

    //--- V4：源文件端口表扫描（只读检查）-----------------------------------
    integer      fd;
    integer      rc;
    reg [8*256-1:0] line;
    reg [8*512-1:0] v4_path;   // +CAM_TAP_SRC 覆盖路径（跨机用 RETE_ROOT 生成）

    function integer out_followed_by_cam;   // "output" 之后 20 字符内出现 "cam_"
        input [8*256-1:0] s;
        integer p;
        integer q;
        reg [7:0] c0, c1, c2, c3, c4, c5;
        begin
            out_followed_by_cam = 0;
            for (p = 0; p < 250; p = p + 1) begin
                c0 = s[(p+0)*8 +: 8];
                c1 = s[(p+1)*8 +: 8];
                c2 = s[(p+2)*8 +: 8];
                c3 = s[(p+3)*8 +: 8];
                c4 = s[(p+4)*8 +: 8];
                c5 = s[(p+5)*8 +: 8];
                if (c0 == "o" && c1 == "u" && c2 == "t" &&
                    c3 == "p" && c4 == "u" && c5 == "t") begin
                    for (q = p; q < p + 20; q = q + 1) begin
                        if (s[(q+0)*8 +: 8] == "c" &&
                            s[(q+1)*8 +: 8] == "a" &&
                            s[(q+2)*8 +: 8] == "m" &&
                            s[(q+3)*8 +: 8] == "_") out_followed_by_cam = 1;
                    end
                end
            end
        end
    endfunction

    integer v4_bad;
    integer v4_opened;
    integer v2_bad;

    initial begin
        //======================================================================
        // 复位 + 起始
        //======================================================================
        repeat (4) @(negedge cam_pclk);
        rst_n_pclk = 1'b1;
        @(negedge cam_pclk);

        //======================================================================
        // V5：vsync / href 上升沿 → 1 拍脉冲
        //   o_frame_start / o_line_start 是**组合**输出，必须在驱动后立即观察
        //======================================================================
        @(negedge cam_pclk);
        i_cam_vsync = 1'b1;
        #1;
        if (o_frame_start === 1'b1) chk_pass("V5_frame_start_pulse"); else chk_fail("V5_frame_start_pulse");
        @(negedge cam_pclk);
        if (o_frame_start === 1'b0) chk_pass("V5_frame_start_1clk");  else chk_fail("V5_frame_start_1clk");
        i_cam_vsync = 1'b0;
        @(negedge cam_pclk); @(negedge cam_pclk);

        //======================================================================
        // V1/V2：连续字节流组包（href=1 期间每拍一个字节，2 拍 = 1 像素）
        //   节拍：字节 k 在 negedge k 驱动 → 在 posedge k+1 被采样
        //         ⇒ 偶数量 negedge k 上可观测到像素 {bytes[k-2], bytes[k-1]}
        //======================================================================
        bytes[0]  = 8'h12; bytes[1]  = 8'h34; bytes[2]  = 8'h56; bytes[3]  = 8'h78;
        bytes[4]  = 8'hAB; bytes[5]  = 8'hCD; bytes[6]  = 8'h00; bytes[7]  = 8'hFF;
        bytes[8]  = 8'h5A; bytes[9]  = 8'hA5; bytes[10] = 8'h01; bytes[11] = 8'h80;
        bytes[12] = 8'hFF; bytes[13] = 8'hFF; bytes[14] = 8'h00; bytes[15] = 8'h01;

        i_cam_href = 1'b0;
        i_cam_data = 8'hAA;                 // 行外字节：必须被丢弃
        @(negedge cam_pclk);
        i_cam_data = 8'hBB;
        @(negedge cam_pclk);

        i_cam_href = 1'b1;                  // href 上升沿
        i_cam_data = bytes[0];
        #1;                                 // 组合脉冲立即观察
        if (o_line_start === 1'b1) chk_pass("V5_line_start_pulse"); else chk_fail("V5_line_start_pulse");
        if (o_px_valid === 1'b0)   chk_pass("V1_first_byte_no_pixel"); else chk_fail("V1_first_byte_no_pixel");

        for (k = 1; k < 16; k = k + 1) begin
            @(negedge cam_pclk);
            i_cam_data = bytes[k];
            if (k >= 2) begin                      // 此刻观测到的像素 = {b[k-2], b[k-1]}
                px_expected = {bytes[k-2], bytes[k-1]};
                if (k % 2 == 0) begin
                    if (o_px_valid === 1'b1 && o_px_data === px_expected)
                        chk_pass("V1_pack_msb_first");
                    else
                        chk_fail("V1_pack_msb_first");
                    if (o_px_valid_b === 1'b1 && o_px_data_b === {bytes[k-1], bytes[k-2]})
                        chk_pass("V6_pack_lsb_first");
                    else
                        chk_fail("V6_pack_lsb_first");
                end else begin
                    if (o_px_valid === 1'b0) chk_pass("V2_valid_gap_1clk");
                    else                     chk_fail("V2_valid_gap_1clk");
                end
            end
        end
        // 最后一对之后的第 1 拍仍有 1 个像素
        @(negedge cam_pclk);
        if (o_px_valid === 1'b1 && o_px_data === {bytes[14], bytes[15]})
            chk_pass("V1_pack_last_pixel");
        else
            chk_fail("V1_pack_last_pixel");

        //======================================================================
        // V2：o_px_valid 每 2 拍 1 次（href 保持期间的脉冲间隔）
        //======================================================================
        prev_valid = o_px_valid;
        v2_bad = 0;
        valid_before = px_cnt;
        for (i = 0; i < 200; i = i + 1) begin
            @(negedge cam_pclk);
            if (o_px_valid === 1'b1 && prev_valid === 1'b1) v2_bad = v2_bad + 1;
            prev_valid = o_px_valid;
        end
        if (v2_bad == 0) chk_pass("V2_valid_every_2clk"); else chk_fail("V2_valid_every_2clk");
        // 200 拍应恰好 100 个像素脉冲
        if ((px_cnt - valid_before) == 32'd100) chk_pass("V2_valid_rate_halved");
        else                                    chk_fail("V2_valid_rate_halved");

        //======================================================================
        // V3：一帧 800×480 ⇔ 768,000 个字节 ⇒ 384,000 个 o_px_valid
        //   字节 #n 在 posedge n 被采样；pack 发生在 byte_flag=1 的拍
        //   ⇒ M 个 negedge（各跟一个 posedge）后共发生 floor((M+1)/2) 次 pack
        //======================================================================
        i_cam_href = 1'b0;
        @(negedge cam_pclk);
        @(negedge cam_pclk);                // 消化 V2 段的残留脉冲
        cnt_before = px_cnt;
        i_cam_href = 1'b1;
        i_cam_data = 8'h3C;
        repeat (768000) @(negedge cam_pclk);
        @(posedge cam_pclk);                // 让最后一个像素脉冲被计数
        #1;
        if ((px_cnt - cnt_before) == 32'd384000) chk_pass("V3_frame_px_count_384000");
        else begin
            chk_fail("V3_frame_px_count_384000");
            $display("      got %0d", px_cnt - cnt_before);
        end
        i_cam_href = 1'b0;
        @(negedge cam_pclk);
        @(negedge cam_pclk);
        if (o_px_valid === 1'b0) chk_pass("V1_no_pixel_after_href"); else chk_fail("V1_no_pixel_after_href");

        //======================================================================
        // V4：只读检查 —— 源文件里没有 "output ... cam_*"
        //======================================================================
        v4_bad    = 0;
        v4_opened = 0;
        // 路径不写死：优先 +CAM_TAP_SRC=<path>（跨机可传 $RETE_ROOT/src/hdl/capture/cam_tap.v），
        // 否则按 run_sim 的工作目录（build/sim/<tb>/）依次尝试相对路径。
        fd = 0;
        if ($value$plusargs("CAM_TAP_SRC=%s", v4_path)) begin
            fd = $fopen(v4_path, "r");
            if (fd != 0) $display("INFO V4_SRC=%0s", v4_path);
        end
        if (fd == 0) fd = $fopen("../../../src/hdl/capture/cam_tap.v", "r");
        if (fd == 0) fd = $fopen("../src/hdl/capture/cam_tap.v", "r");
        if (fd == 0) fd = $fopen("src/hdl/capture/cam_tap.v", "r");
        if (fd != 0) begin
            v4_opened = 1;
            rc = $fgets(line, fd);
            while (rc != 0) begin
                if (out_followed_by_cam(line)) v4_bad = v4_bad + 1;
                rc = $fgets(line, fd);
            end
            $fclose(fd);
            if (v4_bad == 0) chk_pass("V4_readonly_no_cam_output");
            else             chk_fail("V4_readonly_no_cam_output");
        end else begin
            chk_fail("V4_readonly_no_cam_output");
            $display("      (无法打开 cam_tap.v 做端口扫描)");
        end

        //======================================================================
        // 汇总
        //======================================================================
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--- 超时保护：40 ms 仿真时间 -------------------------------------------
    initial begin
        #40_000_000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
