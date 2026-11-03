//==============================================================================
// tb_udp_decim_stall.v —— ★ 抽帧比在线改大改小 ⇒ 原始回传永久停摆 的复现/判定 TB
//
// 【背景】2026-10-12 20:51:08 现场（旧位流）：经网关下发 `board.setParam {frameDecim:1}`
//   （幂等值）后 0.2 s，板端原画停流；20:55 后"只发事件不发原画"（P0 报告 §4.7、排障报告
//   "现场突发"）。命令前的 20:48-20:50 实测原画速率 = 3.65 fps ≈ 29.7/8 ⇒ 板端当时处于
//   `i_frame_decim = 8`（抽帧 8:1）状态（旧 UI 把抽帧比写死为 8）。
//
// 【机理（udp_merge，v3 运行时抽帧）】
//   decim_cnt 每帧回绕 +1；"本帧是否回传" = (decim_cnt == i_frame_decim-1)；
//   decim_cnt 只在与阈值相等时才归零。
//   ⇒ 当 i_frame_decim 从大改小（例：8 → 1，阈值 7 → 0）而 decim_cnt 正处在
//      [新阈值+1, 旧阈值] 之间时，decim_cnt **永远不再等于 0**，于是 send_frame 恒 0、
//      chunk_send 恒 0、n_full 恒 0 ⇒ **原始段一个都不再入队/回传**，直到 decim_cnt
//      自增绕过 16 bit（65535 帧，≈36 min）才自愈。等效复位（JTAG 重烧）立即恢复 ——
//      与现场"只能 JTAG 重烧复活"完全一致。
//
// 【TB 结构】直接例化真实 udp_merge（缩小帧幅以压缩仿真时间：IMG_H=8 ⇒ 10 段/帧，
//   抽帧计数/阈值逻辑与 800×480 完全同一份代码）。
//
// 【判据】
//   D1 抽帧 8:1 生效期（改值前）：帧回传速率明显低于 1 帧/帧（结构自检）
//   D2 ★停流判据：把抽帧比从 8 改回 1（= 现场那条命令）后 3 帧内必须恢复回传
//      （≥ 20 段）；修复前 = 0 段 ⇒ FAIL（复现 20:51 停流）
//==============================================================================
`timescale 1ns / 1ps

module tb_udp_decim_stall;

    reg clk = 1'b0;
    reg rst_n = 1'b0;
    always #4 clk = ~clk;               // 125 MHz

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT：udp_merge（v3；10 段/帧 = 800×8/640）
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'h1234;
    reg  [7:0]  i_decim   = 8'd8;       // 起始 = 现场"掉到 3.65 fps"时的状态
    wire        o_tx_start, o_tx_byte_en;
    wire [7:0]  o_tx_byte;
    wire [15:0] o_tx_len;
    wire        o_ctrl_empty;
    wire [15:0] o_frame_idx, o_drop_px, o_drop_ev;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (1280),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (800),
        .IMG_H        (8),              // 10 段/帧（仅缩小帧幅，抽帧逻辑同一份代码）
        .CHUNK_SLOTS  (4),
        .CRC_EN       (1)
    ) u_merge (
        .clk_eth      (clk),
        .rst_n_eth    (rst_n),
        .i_raw_valid  (raw_valid),
        .i_raw_data   (raw_data),
        .i_raw_frame_start(1'b0),      // ★ SEAM-LINKDROP：本 TB 走 legacy（自己数帧首）路径
        .i_ev_valid   (1'b0),
        .i_ev_x       (9'd0),
        .i_ev_y       (8'd0),
        .i_ev_pol     (1'b0),
        .i_tx_ready   (1'b1),           // 单测：不引入 eth_udp 反压
        .i_cfg_en     (1'b1),
        .o_tx_start   (o_tx_start),
        .o_tx_byte    (o_tx_byte),
        .o_tx_byte_en (o_tx_byte_en),
        .o_tx_len     (o_tx_len),
        .i_mode       (2'd0),           // RAW_EV
        .i_ts_us      (48'd0),
        .i_ts_valid   (1'b0),
        .i_ts_calibrated(1'b0),
        .i_ev_en      (1'b1),
        .i_frame_decim(i_decim),
        .i_ev_flush_cyc(24'd65536),
        .i_act_byte   (8'h00),          // ★ M4b：无动作
        .i_ctrl_wr_en (1'b0),
        .i_ctrl_data  (8'd0),
        .i_ctrl_commit(1'b0),
        .o_ctrl_empty (o_ctrl_empty),
        .o_stat_drop_px(o_drop_px),
        .o_stat_drop_ev(o_drop_ev),
        .o_frame_idx  (o_frame_idx)
    );

    //--------------------------------------------------------------------------
    // 像素源（1 px/clk 连续灌）
    //--------------------------------------------------------------------------
    integer px = 0;
    always @(posedge clk) begin
        raw_valid <= 1'b1;
        raw_data  <= raw_data + 16'h0101;
        if (px == (800*8 - 1)) px = 0; else px = px + 1;
    end

    //--------------------------------------------------------------------------
    // 段计数器（抓 o_tx_start，等价"线上看到的原始段"）
    //--------------------------------------------------------------------------
    integer n_seg = 0;
    always @(posedge clk) if (o_tx_start) n_seg = n_seg + 1;

    // 帧回绕计数（层级引用 udp_merge 内的 frame_wrap；= "已被接受的像素"满一帧）
    integer n_wrap = 0;
    always @(posedge clk) if (u_merge.frame_wrap) n_wrap = n_wrap + 1;

    integer i, seg_a, seg_b, wrap_a;
    reg [15:0] decim_at_change;

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    initial begin
        rst_n = 1'b0;
        repeat (40) @(posedge clk);
        rst_n = 1'b1;
        repeat (20) @(posedge clk);

        // ---- 相位 A：抽帧 8:1（现场 20:48-20:50 的状态）----
        wrap_a = n_wrap;
        seg_a  = n_seg;
        for (i = 0; i < 9; i = i + 1) begin
            while (u_merge.frame_wrap == 1'b0) @(posedge clk);
            @(posedge clk);
            @(posedge clk);
        end
        $display("[DECIM-8] frames=%0d segs=%0d (expect ~1 frame of 10 segs per 8 frames)",
                 n_wrap - wrap_a, n_seg - seg_a);
        // 结构自检：9 帧内不可能把 9 帧的段（90）全回传
        if ((n_seg - seg_a) <= 30) chk_pass("D1_decim8_rate_limited");
        else begin
            $display("  [E] decim=8 却回传 %0d 段（>30）", n_seg - seg_a);
            chk_fail("D1_decim8_rate_limited");
        end

        // ---- 相位 B：等 decim_cnt 落到"非零"（这就是现场中招的相位）----
        while (u_merge.decim_cnt == 16'd0) @(posedge clk);
        decim_at_change = u_merge.decim_cnt;
        seg_b = n_seg;
        $display("[CHANGE] i_frame_decim 8 -> 1 at decim_cnt=%0d (field: SET_PARAM tag 0x03 = 1)",
                 decim_at_change);
        i_decim = 8'd1;                             // ★ 现场那条命令
        @(posedge clk);

        // ---- 相位 C：改值后 3 帧内必须恢复回传 ----
        for (i = 0; i < 3; i = i + 1) begin
            while (u_merge.frame_wrap == 1'b0) @(posedge clk);
            @(posedge clk);
            @(posedge clk);
        end
        $display("[AFTER] 3 frames: segs=%0d (healthy expect 30)", n_seg - seg_b);
        if ((n_seg - seg_b) >= 20) chk_pass("D2_raw_resumes_after_decim_change");
        else begin
            $display("  [STALL] decim 改小后 3 帧内只回传 %0d 段（<20）=> 原始回传永久停摆（复现）",
                     n_seg - seg_b);
            chk_fail("D2_raw_resumes_after_decim_change");
        end

        $display("  [SUMMARY] decim_cnt=%0d send_frame=%b n_full=%0d",
                 u_merge.decim_cnt, u_merge.send_frame, u_merge.n_full);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #50000000;                                   // 50 ms 上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
