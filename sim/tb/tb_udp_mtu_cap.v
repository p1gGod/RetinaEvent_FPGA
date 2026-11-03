//==============================================================================
// tb_udp_mtu_cap.v —— ★ F1 复现/回归 TB：θ=1/δL=1 高事件量下混合包超 MTU 被截断
//
// 【为什么有这个 TB】
//   2026-10-12 v3 联板验证（θ=1/δL=1，事件率 ≈5 MB/s）抓到 26581/139802 包
//   "长度不自洽 + CRC 坏"（两个独立解析器一致，raw/item1_mismatch_probe.txt 8 例）：
//   线上包被截断在 **1472 B**，而包头自述 1691..2251 B ⇒ 事件段尾部与 CRC 整体丢失。
//   本 TB 在 RTL 级复刻该触发机制，并对**每一条**输出包逐字节断言。
//
// 【现场机制 → TB 场景（1:1 映射）】
//   现场：发送停摆窗口（反压/环满）内事件堆在收集页（写入门限 = 纯事件包容量 289 条），
//         窗口结束后的第一包同时满足 [待发页空 ev_rec_pd==0] + [收集页有货 ev_rec_collect!=0]
//         + [环里有原始槽 raw_pending_eff] ⇒ 落 udp_merge 的 drain_swap 排空交换路径。
//   本 TB：① 连续灌原始像素（环里始终有槽）；② 反压停摆 2200 拍（TB 把 eth_udp 的
//         o_tx_ready 与门为 0），其间注入 200 条事件；③ 放开反压 ⇒ 下一包即 drain_swap。
//
// 【判据（对每一条输出包，用独立 CRC/长度解析器）】
//   L1  MTU 红线：负载 ≤ 1472 B（udp_merge 头注"MTU 红线" / eth_udp MAX_TX_LEN）
//   L2  包头自述长度 = 实发字节数（24 + RAW_LEN + EV_LEN + 2）
//   L3  CRC16/CCITT-FALSE 覆盖 [0 .. 24+RAW+EV-1]，尾部 2 B BE（逐包复核）
//   L4  混合包上限：RAW_LEN=1280 ⇒ EV_LEN ≤ 165（33 条）
//   L5  纯事件包上限：RAW_LEN=0 ⇒ EV_LEN ≤ 1445（289 条）、EV_LEN % 5 == 0
//   L6  ★现场症状复现判据：把 eth_udp 的 MTU 硬截断规则（eth_udp.v:148-150
//       `len_r <= (i_tx_len > MAX_TX_LEN) ? MAX_TX_LEN : i_tx_len`）回放在抓到包上，
//       要求"截断后长度 = 自述长度"（= **不发生截断**、CRC 在线上完整）
//   L7  停摆后原始段必须补发（RAW 槽只延后一包、不吞帧）
//
// 【修复前 / 修复后】
//   修复前：③ 之后第一包 = 24+1280+200*5+2 = 2306 B ⇒ L1/L2/L6 FAIL（复现现场）
//   修复后：该包退化为纯事件包 24+0+1000+2 = 1026 B；RAW 由下一包补发（1306 B）⇒ 全 PASS
//   ⚠️ 本 TB 不随修复改动一行（DUT = 真实 udp_merge + 真实 eth_udp），修复前 FAIL /
//      修复后 PASS 同源可比。
//==============================================================================
`timescale 1ns / 1ps

module tb_udp_mtu_cap;

    //--------------------------------------------------------------------------
    // 时钟 / 复位
    //--------------------------------------------------------------------------
    reg clk_eth = 1'b0;
    reg clk200  = 1'b0;
    always #4   clk_eth = ~clk_eth;      // 125 MHz（= eth_rxc）
    always #2.5 clk200  = ~clk200;       // 200 MHz（IDELAYCTRL 参考）

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*56-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*56-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT：真实 udp_merge（v3 正式参数：RAW_CHUNK=1280 / IMG 800×480 / MAX_PAYLOAD=1472）
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg         ev_valid  = 1'b0;
    reg  [8:0]  ev_x      = 9'd0;
    reg  [7:0]  ev_y      = 8'd0;
    reg         ev_pol    = 1'b0;
    reg         tx_gate   = 1'b1;      // 1 = 正常；0 = TB 注入反压（现场"发送停摆窗口"）
    wire        eth_tx_ready;
    wire        tx_ready_eff = eth_tx_ready & tx_gate;

    reg  [1:0]  mode_in     = 2'd0;    // MODE0 = RAW+EV（现场档）
    reg  [47:0] ts_in       = 48'd1000;
    reg         ts_valid_in = 1'b1;
    reg         ts_cal_in   = 1'b0;
    reg         ev_en_in    = 1'b1;
    reg  [7:0]  decim_in    = 8'd1;
    reg  [23:0] flush_in    = 24'd65536;
    reg         ctrl_wr_en  = 1'b0;
    reg  [7:0]  ctrl_data   = 8'd0;
    reg         ctrl_commit = 1'b0;

    wire        tx_start, tx_byte_en, ctrl_empty;
    wire [7:0]  tx_byte;
    wire [15:0] tx_len, drop_px, drop_ev, frame_idx_w;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (1280),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .FRAME_DECIM  (1),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (800),
        .IMG_H        (480),
        .EV_FLUSH_CYC (65536),
        .CRC_EN       (1)
    ) dut (
        .clk_eth       (clk_eth),
        .rst_n_eth     (rst_n),
        .i_raw_valid   (raw_valid),
        .i_raw_data    (raw_data),
        .i_raw_frame_start(1'b0),      // ★ SEAM-LINKDROP：本 TB 走 legacy（自己数帧首）路径
        .i_ev_valid    (ev_valid),
        .i_ev_x        (ev_x),
        .i_ev_y        (ev_y),
        .i_ev_pol      (ev_pol),
        .i_tx_ready    (tx_ready_eff),
        .i_cfg_en      (1'b1),
        .i_mode        (mode_in),
        .i_ts_us       (ts_in),
        .i_ts_valid    (ts_valid_in),
        .i_ts_calibrated(ts_cal_in),
        .i_ev_en       (ev_en_in),
        .i_frame_decim (decim_in),
        .i_ev_flush_cyc(flush_in),
        .i_act_byte    (8'h00),          // ★ M4b：无动作
        .i_ctrl_wr_en  (ctrl_wr_en),
        .i_ctrl_data   (ctrl_data),
        .i_ctrl_commit (ctrl_commit),
        .o_ctrl_empty  (ctrl_empty),
        .o_frame_idx   (frame_idx_w),
        .o_tx_start    (tx_start),
        .o_tx_byte     (tx_byte),
        .o_tx_byte_en  (tx_byte_en),
        .o_tx_len      (tx_len),
        .o_stat_drop_px(drop_px),
        .o_stat_drop_ev(drop_ev)
    );

    //--------------------------------------------------------------------------
    // 真实 eth_udp（握手/反压/MTU 截断）+ 厂家栈行为级替身 eth_top（与 top 同构接线）
    //--------------------------------------------------------------------------
    eth_udp #(
        .BOARD_MAC  (48'h00_11_22_33_44_55),
        .BOARD_IP   ({8'd192,8'd168,8'd1,8'd10}),
        .PC_IP      ({8'd192,8'd168,8'd1,8'd102}),
        .PC_MAC     (48'hff_ff_ff_ff_ff_ff),
        .MAX_TX_LEN (16'd1472),
        .BUF_BYTES  (2048)
    ) u_eth (
        .clk_eth      (clk_eth),
        .rst_n_eth    (rst_n),
        .clk_ref_200m (clk200),
        .eth_rxc      (clk_eth),
        .eth_rx_ctl   (1'b0),
        .eth_rxd      (4'b0000),
        .eth_txc      (),
        .eth_tx_ctl   (),
        .eth_txd      (),
        .eth_rst_n    (),
        .i_tx_start   (tx_start),
        .i_tx_byte    (tx_byte),
        .i_tx_byte_en (tx_byte_en),
        .i_tx_len     (tx_len),
        .o_tx_ready   (eth_tx_ready),
        .o_rx_rd_valid(),
        .o_rx_rd_data (),
        .i_rx_rd_en   (1'b1),
        .o_rx_pkt_done(),
        .o_rx_ovf     ()
    );

    //--------------------------------------------------------------------------
    // 原始像素源：连续灌（1 px/clk）—— 保证环里始终有槽（raw_pending_eff=1）
    //--------------------------------------------------------------------------
    reg  [15:0] px_seed  = 16'h1234;
    reg         feed_raw = 1'b0;
    always @(posedge clk_eth) begin
        raw_valid <= feed_raw;
        raw_data  <= px_seed;
        if (feed_raw) px_seed <= px_seed + 16'h0111;
    end

    //--------------------------------------------------------------------------
    // 事件注入（负沿驱动避开与 DUT 正沿采样的竞争）
    //--------------------------------------------------------------------------
    integer ev_seed = 0;
    task inject_events; input integer n; integer k; begin
        for (k = 0; k < n; k = k + 1) begin
            @(negedge clk_eth);
            ev_valid <= 1'b1;
            ev_x     <= ev_seed[8:0];
            ev_y     <= ev_seed[7:0];
            ev_pol   <= ev_seed[0];
            ev_seed  = ev_seed + 37;
        end
        @(negedge clk_eth);
        ev_valid <= 1'b0;
    end endtask

    //--------------------------------------------------------------------------
    // 发端抓包器（udp_merge 输出口 = 线上真实负载）+ 独立 CRC/长度解析器
    //--------------------------------------------------------------------------
    reg  [7:0]  pkt_mem [0:4095];
    integer     n_bytes;
    reg  [15:0] cur_len;
    reg         in_pkt;

    integer n_pkt, n_raw_pkt, n_ev_pkt, n_mtu_viol, n_len_bad, n_crc_bad, n_mix_viol;
    integer n_trunc_replay, n_ev_rec_total_viol;
    integer post_stall_pkt;
    reg     raw_after_stall;
    reg     saw_stall_marker;
    reg     pre_stall_pkt_done;

    integer     i, bb;
    reg [15:0]  h_rawlen, h_evlen, h_crc_rx, h_crc_calc;
    reg [7:0]   h_flags;
    integer     body_len, replay_len;

    // ---- CRC16/CCITT-FALSE（独立实现，不复用 DUT 代码）----
    function [15:0] crc16_ccitt;
        input integer n;
        integer k, b;
        reg [15:0] c;
        begin
            c = 16'hFFFF;
            for (k = 0; k < n; k = k + 1) begin
                c = c ^ {pkt_mem[k], 8'h00};
                for (b = 0; b < 8; b = b + 1)
                    c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            end
            crc16_ccitt = c;
        end
    endfunction

    task check_pkt; begin
        n_pkt = n_pkt + 1;
        h_flags  = pkt_mem[6];
        h_rawlen = {pkt_mem[12], pkt_mem[13]};
        h_evlen  = {pkt_mem[14], pkt_mem[15]};

        if (!h_flags[7]) begin                       // 数据包（本 TB 不产 CTRL 包）
            // --- 包头魔数/版本 ---
            if (!(pkt_mem[0]==8'hF0 && pkt_mem[1]==8'h5A && pkt_mem[2]==8'hA5 &&
                  pkt_mem[3]==8'h30 && pkt_mem[4]==8'h03 && pkt_mem[5]==8'h18)) begin
                n_len_bad = n_len_bad + 1;
                if (n_len_bad <= 4) $display("  [HDR] magic/VER/HDR_LEN bad");
            end
            // --- L1 MTU 红线 ---
            if (cur_len > 1472) begin
                n_mtu_viol = n_mtu_viol + 1;
                if (n_mtu_viol <= 4)
                    $display("  [MTU] len=%0d > 1472  RAW_LEN=%0d EV_LEN=%0d(=%0d recs) chunk=%0d",
                        cur_len, h_rawlen, h_evlen, h_evlen/5, {pkt_mem[8], pkt_mem[9]});
            end
            // --- L2 自述长度 = 实发字节 ---
            body_len = 24 + h_rawlen + h_evlen + 2;
            if (body_len != cur_len) begin
                n_len_bad = n_len_bad + 1;
                if (n_len_bad <= 4)
                    $display("  [LEN] got len=%0d expected=%0d (diff %0d)", cur_len, body_len,
                        cur_len - body_len);
            end
            // --- L3 CRC 逐包复核 ---
            h_crc_rx   = {pkt_mem[24+h_rawlen+h_evlen], pkt_mem[24+h_rawlen+h_evlen+1]};
            h_crc_calc = crc16_ccitt(24+h_rawlen+h_evlen);
            if (h_crc_rx !== h_crc_calc) begin
                n_crc_bad = n_crc_bad + 1;
                if (n_crc_bad <= 4)
                    $display("  [CRC] rx=%04x calc=%04x (len=%0d RAW=%0d EV=%0d)",
                        h_crc_rx, h_crc_calc, cur_len, h_rawlen, h_evlen);
            end
            // --- L4/L5 段容量上限 ---
            if (h_rawlen == 16'd1280) begin
                n_raw_pkt = n_raw_pkt + 1;
                if (h_evlen > 16'd165) begin
                    n_mix_viol = n_mix_viol + 1;
                    if (n_mix_viol <= 4)
                        $display("  [MIX] mixed pkt EV_LEN=%0d > 165 (=%0d recs > 33 rec cap)",
                            h_evlen, h_evlen/5);
                end
            end
            else begin
                n_ev_pkt = n_ev_pkt + 1;
                if (h_rawlen != 16'd0) n_mix_viol = n_mix_viol + 1;
                if ((h_evlen > 16'd1445) || (h_evlen % 5 != 0)) begin
                    n_ev_rec_total_viol = n_ev_rec_total_viol + 1;
                    if (n_ev_rec_total_viol <= 4)
                        $display("  [PURE] pure-event pkt EV_LEN=%0d out of range (cap 1445)", h_evlen);
                end
            end
            // --- L6 现场症状复现：eth_udp 硬截断规则回放（eth_udp.v:148-150）---
            replay_len = (cur_len > 1472) ? 1472 : cur_len;
            if (replay_len != body_len) begin       // 线上包缺尾 ⇒ 现场"CRC 丢失"
                n_trunc_replay = n_trunc_replay + 1;
                if (n_trunc_replay <= 4)
                    $display("  [TRUNC] on-wire %0d B vs hdr-declared %0d B => tail (incl CRC) lost",
                        replay_len, body_len);
            end
        end
    end endtask

    always @(posedge clk_eth) begin
        if (tx_start) begin
            cur_len <= tx_len;
            n_bytes <= 0;
            in_pkt  <= 1'b1;
        end
        if (in_pkt && tx_byte_en) begin
            if (n_bytes < 4096) pkt_mem[n_bytes] = tx_byte;
            n_bytes <= n_bytes + 1;
            if (n_bytes == (cur_len - 16'd1)) begin
                in_pkt <= 1'b0;
                if (saw_stall_marker) begin
                    post_stall_pkt <= post_stall_pkt + 1;
                    if (post_stall_pkt == 0) begin
                        $display("  [POST-STALL-PKT] first pkt after stall: len=%0d RAW_LEN=%0d EV_LEN=%0d(=%0d recs)",
                            cur_len, {pkt_mem[12],pkt_mem[13]}, {pkt_mem[14],pkt_mem[15]},
                            {pkt_mem[14],pkt_mem[15]}/5);
                    end
                    if ({pkt_mem[12],pkt_mem[13]} == 16'd1280) raw_after_stall <= 1'b1;
                end
                else pre_stall_pkt_done <= 1'b1;
                check_pkt;                        // ★ 逐包判据在包尾统一执行
            end
        end
    end

    //--------------------------------------------------------------------------
    // 主激励序列
    //--------------------------------------------------------------------------
    initial begin
        n_bytes = 0; cur_len = 16'd0; in_pkt = 1'b0;
        n_pkt = 0; n_raw_pkt = 0; n_ev_pkt = 0;
        n_mtu_viol = 0; n_len_bad = 0; n_crc_bad = 0; n_mix_viol = 0;
        n_trunc_replay = 0; n_ev_rec_total_viol = 0;
        post_stall_pkt = 0; raw_after_stall = 1'b0;
        saw_stall_marker = 1'b0; pre_stall_pkt_done = 1'b0;

        $display("==== tb_udp_mtu_cap: F1 high-event-rate drain path MTU-cap repro/regress ====");
        rst_n    = 1'b0;
        feed_raw = 1'b0;
        repeat (20) @(posedge clk_eth);
        rst_n = 1'b1;
        repeat (20) @(posedge clk_eth);

        // ---- P1 基线：连续灌原始像素，等首包发完（其 S_DONE 交换把"空收集页"换到待发页）----
        feed_raw = 1'b1;
        bb = 0;
        while ((pre_stall_pkt_done != 1'b1) && (bb < 20000)) begin
            @(posedge clk_eth); bb = bb + 1;
        end
        $display("  [P1] baseline first pkt done (raw_pkts=%0d ev_pkts=%0d)", n_raw_pkt, n_ev_pkt);

        // ---- P2 停摆窗口（复刻现场：反压窗口内事件堆在收集页）----
        tx_gate = 1'b0;
        repeat (2200) @(posedge clk_eth);          // 等在途包发完 + 环填满
        inject_events(200);                        // ★ 200 条事件（远大于混合包 33 条上限）
        @(posedge clk_eth);
        saw_stall_marker = 1'b1;                   // 此后第一包 = 现场 drain 路径那一包
        tx_gate = 1'b1;                            // 放开反压 ⇒ 下一包走 drain_swap

        // ---- P3 等停摆后 3 包（drain 包 + RAW 补发包）----
        bb = 0;
        while ((post_stall_pkt < 3) && (bb < 60000)) begin
            @(posedge clk_eth); bb = bb + 1;
        end
        repeat (200) @(posedge clk_eth);

        // ---- 汇总 ----
        $display("  pkt stats: total=%0d (with RAW=%0d / pure-EV=%0d)", n_pkt, n_raw_pkt, n_ev_pkt);
        $display("  violation counts: MTU=%0d len=%0d CRC=%0d mixcap=%0d purecap=%0d trunc=%0d",
            n_mtu_viol, n_len_bad, n_crc_bad, n_mix_viol, n_ev_rec_total_viol, n_trunc_replay);

        if (n_pkt > 3)                     chk_pass("packets_emitted");
        else                               chk_fail("packets_emitted");
        if (n_mtu_viol == 0)               chk_pass("MTU_le_1472");
        else                               chk_fail("MTU_le_1472");
        if (n_len_bad == 0)                chk_pass("hdr_len_eq_bytes");
        else                               chk_fail("hdr_len_eq_bytes");
        if (n_crc_bad == 0)                chk_pass("crc16_all_pkts");
        else                               chk_fail("crc16_all_pkts");
        if (n_mix_viol == 0)               chk_pass("mixed_ev_le_165");
        else                               chk_fail("mixed_ev_le_165");
        if (n_ev_rec_total_viol == 0)      chk_pass("pure_ev_le_1445");
        else                               chk_fail("pure_ev_le_1445");
        if (n_trunc_replay == 0)           chk_pass("no_line_truncation");
        else                               chk_fail("no_line_truncation");
        if (raw_after_stall == 1'b1)       chk_pass("raw_resent_after_stall");
        else                               chk_fail("raw_resent_after_stall");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL (errors=%0d)", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护（不许无限跑）
    //--------------------------------------------------------------------------
    initial begin
        #3000000;                                  // 3 ms 仿真上限
        $display("CHECK=timeout_no_hang FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
