//==============================================================================
// tb_udp_merge.v —— udp_merge 离线协议自测（不需要网卡）
//
// 判据（文档 §8 V1~V5 + WP-D 补充）：
//   V1  MTU：每个 UDP 负载 ≤ 1472 B（永不超过安全线）
//   V2  原始段：600 包 × 1280 B 拼回一帧，与源像素逐字节一致
//   V3  事件段：解码出的 X/Y/POL 与喂入序列逐条一致
//   V4  FRAME_IDX 步长恒为 1；CHUNK_IDX 0..599 严格递增后回 0
//   V5  同一包内同时存在原始段与事件段（SEG_MASK=3）
//   V6  包头字段自洽（MAGIC / SEG_MASK / RAW_LEN / EV_LEN / 总长）
//   V7  CRC16 正确（CRC-16/CCITT-FALSE）
//   V8  正常速率下 o_stat_drop_px == 0 且 o_stat_drop_ev == 0
//   V9  纯事件包（相机停流看门狗）路径正确：RAW_LEN=0 / SEG_MASK=2
//   V10 i_cfg_en=0 时完全停止回传
//
// 另外：把所有收到的包 dump 到 build/sim/tb_udp_merge/rtl_packets.hex，
//       供 tool/receive_udp.py --from-rtl-dump 做 RTL↔PC 脚本交叉验证。
//==============================================================================
`timescale 1ns / 1ps

module tb_udp_merge;

    //--------------------------------------------------------------------------
    // 时钟 / 复位
    //--------------------------------------------------------------------------
    reg clk = 1'b0;
    always #4 clk = ~clk;              // 125 MHz

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg         ev_valid  = 1'b0;
    reg  [8:0]  ev_x      = 9'd0;
    reg  [7:0]  ev_y      = 8'd0;
    reg         ev_pol    = 1'b0;
    reg         tx_ready  = 1'b1;
    reg         cfg_en    = 1'b1;

    wire        tx_start;
    wire [7:0]  tx_byte;
    wire        tx_byte_en;
    wire [15:0] tx_len;
    wire [15:0] drop_px, drop_ev;

    udp_merge #(
        .WIRE_VER     (2),     // ★ v3 回归：本 TB 保持 v2 13B 包头金标准（v3 断言在 tb_wire_v3）
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
        .clk_eth       (clk),
        .rst_n_eth     (rst_n),
        .i_raw_valid   (raw_valid),
        .i_raw_data    (raw_data),
        .i_raw_frame_start(1'b0),      // ★ SEAM-LINKDROP：本 TB 走 legacy（自己数帧首）路径
        .i_ev_valid    (ev_valid),
        .i_ev_x        (ev_x),
        .i_ev_y        (ev_y),
        .i_ev_pol      (ev_pol),
        .i_tx_ready    (tx_ready),
        .i_cfg_en      (cfg_en),
        .i_act_byte    (8'h00),        // ★ M4b：无动作（v2 路径不引用）
        .o_tx_start    (tx_start),
        .o_tx_byte     (tx_byte),
        .o_tx_byte_en  (tx_byte_en),
        .o_tx_len      (tx_len),
        .o_stat_drop_px(drop_px),
        .o_stat_drop_ev(drop_ev)
    );

    //--------------------------------------------------------------------------
    // 抓包：o_tx_start 锁存长度，随后按 o_tx_byte_en 收字节
    //--------------------------------------------------------------------------
    reg [7:0]  pkt [0:2047];
    integer    pkt_len_c;
    integer    pkt_cnt;
    reg        pkt_collecting;
    reg        pkt_ready;

    always @(posedge clk) begin
        pkt_ready <= 1'b0;
        if (tx_start) begin
            pkt_len_c      <= tx_len;
            pkt_cnt        <= 0;
            pkt_collecting <= 1'b1;
        end
        else if (pkt_collecting && tx_byte_en) begin
            pkt[pkt_cnt] <= tx_byte;
            pkt_cnt      <= pkt_cnt + 1;
            if (pkt_cnt == (pkt_len_c - 1)) begin
                pkt_collecting <= 1'b0;
                pkt_ready      <= 1'b1;
            end
        end
    end

    //--------------------------------------------------------------------------
    // 期望值：像素模式 = 全局像素序号 g[15:0]（高字节先出）
    //--------------------------------------------------------------------------
    function [15:0] crc16f;
        input [15:0] crc;
        input [7:0]  dat;
        integer i;
        reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (i = 0; i < 8; i = i + 1)
                c = c[15] ? ((c << 1) ^ 16'h1021) : (c << 1);
            crc16f = c;
        end
    endfunction

    // 事件期望队列
    reg [8:0] exp_x [0:16383];
    reg [7:0] exp_y [0:16383];
    reg       exp_p [0:16383];
    integer   ev_head = 0;
    integer   ev_tail = 0;

    // 统计
    integer n_pkt = 0, n_raw = 0, n_evp = 0, n_both = 0;
    integer n_ev_only = 0;
    integer n_pkt_before = 0;
    integer err_len = 0, err_magic = 0, err_mask = 0, err_crc = 0;
    integer err_raw = 0, err_chunk = 0, err_frame = 0, err_ev = 0;
    integer n_raw_bytes = 0;
    integer first_bad_off = -1;

    // 期望的块/帧序号
    integer exp_chunk = 0;
    integer exp_frame = 0;
    integer exp_raw_pkts = 0;

    integer fd;
    integer g_pix_total = 0;

    //--------------------------------------------------------------------------
    // 逐包判据
    //--------------------------------------------------------------------------
    integer i, k, r, off, nrec, gidx;
    reg [15:0] crc_c, crc_e;
    reg [7:0]  exp_byte;
    reg [15:0] p_len, p_rawlen, p_evlen, p_frame, p_chunk;
    reg [7:0]  p_mask;
    reg [8:0]  d_x;
    reg [7:0]  d_y;
    reg        d_p;
    reg [31:0] gpix;
    reg [63:0] w64;

    task dump_pkt;
        integer g, b, nvalid;
        begin
            if (fd == 0) begin
                // 没打开文件就跳过
            end
            else begin
                $fwrite(fd, "%0d %0d %0d %0d %0d %0d ",
                        p_frame, p_chunk, p_mask, p_rawlen, p_evlen, p_len);
                for (g = 0; g < ((p_len + 7) / 8); g = g + 1) begin
                    w64 = 64'd0;
                    for (b = 0; b < 8; b = b + 1)
                        if ((g*8 + b) < p_len) w64 = {w64[55:0], pkt[g*8 + b]};
                    // ⚠️ 最后一组可能不足 8 字节：必须把有效字节**左对齐**（补零在右），
                    //    否则 %016x 的前导零会把字节序列整体右移，PC 端 [:len] 截断会读错。
                    nvalid = p_len - g*8;
                    if (nvalid > 8) nvalid = 8;
                    if (nvalid < 8) w64 = w64 << ((8 - nvalid) * 8);
                    $fwrite(fd, "%016x", w64);
                end
                $fwrite(fd, "\n");
            end
        end
    endtask

    task check_pkt;
        begin
            n_pkt = n_pkt + 1;
            p_len    = pkt_len_c;
            p_mask   = pkt[6];
            p_rawlen = {pkt[9],  pkt[10]};
            p_evlen  = {pkt[11], pkt[12]};
            p_frame  = {pkt[4],  pkt[5]};
            p_chunk  = {pkt[7],  pkt[8]};

            // --- V1：MTU 红线 ---
            if (p_len > 1472) begin
                err_len = err_len + 1;
                $display("  [E] MTU 越线: len=%0d", p_len);
            end

            // --- V6：包头字段自洽 ---
            if (pkt[0] !== 8'hF0 || pkt[1] !== 8'h5A ||
                pkt[2] !== 8'hA5 || pkt[3] !== 8'h0F) err_magic = err_magic + 1;

            if (p_mask[0] !== (p_rawlen != 0)) err_mask = err_mask + 1;
            if (p_mask[1] !== (p_evlen  != 0)) err_mask = err_mask + 1;
            if (p_mask[7:2] !== 6'b0)          err_mask = err_mask + 1;
            if (p_rawlen !== 16'd1280 && p_rawlen !== 16'd0) err_len = err_len + 1;
            if ((p_evlen % 5) != 0 || p_evlen > 175) err_len = err_len + 1;
            if (p_len !== (13 + p_rawlen + p_evlen + 2)) err_len = err_len + 1;

            // --- V7：CRC16 ---
            crc_c = 16'hFFFF;
            for (k = 0; k < (p_len - 2); k = k + 1) crc_c = crc16f(crc_c, pkt[k]);
            crc_e = {pkt[p_len-2], pkt[p_len-1]};
            if (crc_c !== crc_e) begin
                err_crc = err_crc + 1;
                $display("  [E] CRC16 错: calc=%04x got=%04x len=%0d", crc_c, crc_e, p_len);
            end

            // --- V2：原始段逐字节 ---
            if (p_rawlen != 0) begin
                n_raw = n_raw + 1;
                n_raw_bytes = n_raw_bytes + p_rawlen;
                for (k = 0; k < p_rawlen; k = k + 1) begin
                    gpix = p_frame * 384000 + p_chunk * 640 + (k >> 1);
                    exp_byte = ((k & 1) == 0) ? gpix[15:8] : gpix[7:0];
                    if (pkt[13 + k] !== exp_byte) begin
                        if (err_raw == 0 && first_bad_off < 0) begin
                            first_bad_off = k;
                            $display("  [E] 原始段字节不符: frame=%0d chunk=%0d off=%0d got=%02x exp=%02x",
                                     p_frame, p_chunk, k, pkt[13+k], exp_byte);
                        end
                        err_raw = err_raw + 1;
                    end
                end
                // --- V4：块序号 / 帧序号严格推进 ---
                if (p_chunk !== exp_chunk || p_frame !== exp_frame) begin
                    err_chunk = err_chunk + 1;
                    if (err_chunk <= 4)
                        $display("  [E] 序号错: got frame=%0d chunk=%0d, exp frame=%0d chunk=%0d",
                                 p_frame, p_chunk, exp_frame, exp_chunk);
                end
                exp_chunk = exp_chunk + 1;
                if (exp_chunk == 600) begin
                    exp_chunk = 0;
                    exp_frame = exp_frame + 1;
                end
                exp_raw_pkts = exp_raw_pkts + 1;
            end

            // --- V3：事件段 ---
            if (p_evlen != 0) begin
                n_evp = n_evp + 1;
                nrec = p_evlen / 5;
                for (r = 0; r < nrec; r = r + 1) begin
                    off = 13 + p_rawlen + r*5;
                    d_x = {pkt[off+1][0], pkt[off]};
                    d_y = pkt[off+2];
                    d_p = pkt[off+3][0];
                    if (pkt[off+1][7:1] !== 7'b0 || pkt[off+3][7:1] !== 7'b0 ||
                        pkt[off+4] !== 8'h00) err_ev = err_ev + 1;
                    if (ev_head >= ev_tail) begin
                        err_ev = err_ev + 1;
                        if (err_ev <= 4) $display("  [E] 事件多于喂入");
                    end
                    else begin
                        if (d_x !== exp_x[ev_head] || d_y !== exp_y[ev_head] ||
                            d_p !== exp_p[ev_head]) begin
                            err_ev = err_ev + 1;
                            if (err_ev <= 4)
                                $display("  [E] 事件不符: got %0d/%0d/%0d exp %0d/%0d/%0d",
                                         d_x, d_y, d_p, exp_x[ev_head], exp_y[ev_head], exp_p[ev_head]);
                        end
                        ev_head = ev_head + 1;
                    end
                end
            end

            if (p_rawlen != 0 && p_evlen != 0) n_both = n_both + 1;

            dump_pkt;
        end
    endtask

    always @(posedge clk) if (pkt_ready) check_pkt;

    //--------------------------------------------------------------------------
    // 激励：喂像素 + 喂事件
    //--------------------------------------------------------------------------
    integer gi;
    reg [8:0] fx;
    reg [7:0] fy;
    reg       fp;

    task feed_pix; input [15:0] d; begin
        @(negedge clk);
        raw_valid <= 1'b1;
        raw_data  <= d;
        @(negedge clk);
        raw_valid <= 1'b0;
    end endtask

    task feed_ev; input [8:0] x; input [7:0] y; input p; begin
        exp_x[ev_tail] = x;
        exp_y[ev_tail] = y;
        exp_p[ev_tail] = p;
        ev_tail = ev_tail + 1;
        @(negedge clk);
        ev_valid <= 1'b1;
        ev_x     <= x;
        ev_y     <= y;
        ev_pol   <= p;
        @(negedge clk);
        ev_valid <= 1'b0;
    end endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer npix;
    reg [31:0] ev_seq;

    initial begin
        fd = $fopen("rtl_packets.hex", "w");
        if (fd == 0) $display("[warn] 无法创建 rtl_packets.hex，跳过 dump");

        repeat (10) @(negedge clk);
        rst_n <= 1'b1;
        repeat (4) @(negedge clk);

        //======================================================================
        // 阶段 1：整帧 + 下一帧头两块（FRAME_DECIM=1）
        //======================================================================
        npix   = 386560;          // 384000（帧0 全帧）+ 2560（帧1 前 4 块）
        ev_seq = 0;
        for (gi = 0; gi < npix; gi = gi + 1) begin
            feed_pix(gi[15:0]);
            g_pix_total = g_pix_total + 1;
            if ((gi % 100) == 0) begin
                fx = ev_seq[8:0];
                fy = ev_seq[7:0];
                fp = ev_seq[0];
                feed_ev(fx, fy, fp);
                ev_seq = ev_seq + 1;
            end
            @(negedge clk);       // 节拍：约 4 拍/像素
        end

        // 等最后一包发完
        repeat (4000) @(negedge clk);

        //======================================================================
        // 阶段 2：相机停流 → 看门狗补发纯事件包
        //======================================================================
        feed_ev(9'd7, 8'd9, 1'b1);
        feed_ev(9'd8, 8'd10, 1'b0);
        repeat (70000) @(negedge clk);

        //======================================================================
        // 阶段 3：cfg_en=0 → 完全停发
        //======================================================================
        cfg_en <= 1'b0;
        repeat (20) @(negedge clk);
        n_pkt_before = n_pkt;
        for (gi = 0; gi < 20; gi = gi + 1) feed_ev(gi[8:0], gi[7:0], gi[0]);
        repeat (8000) @(negedge clk);
        if (n_pkt == n_pkt_before) chk_pass("V10_cfg_en_0_stops_tx");
        else                       chk_fail("V10_cfg_en_0_stops_tx");

        //======================================================================
        // 汇总判据
        //======================================================================
        if (err_len    == 0) chk_pass("V1_V6_len_mtu_ok");    else chk_fail("V1_V6_len_mtu_ok");
        if (err_magic  == 0) chk_pass("V6_magic_ok");         else chk_fail("V6_magic_ok");
        if (err_mask   == 0) chk_pass("V6_seg_mask_ok");      else chk_fail("V6_seg_mask_ok");
        if (err_crc    == 0) chk_pass("V7_crc16_ok");         else chk_fail("V7_crc16_ok");
        if (err_raw    == 0) chk_pass("V2_raw_bytes_exact");  else chk_fail("V2_raw_bytes_exact");
        if (err_chunk  == 0) chk_pass("V4_idx_sequence_ok");  else chk_fail("V4_idx_sequence_ok");
        if (err_ev     == 0) chk_pass("V3_event_decode_ok");  else chk_fail("V3_event_decode_ok");
        if (n_both     >  0) chk_pass("V5_raw_and_ev_same_pkt"); else chk_fail("V5_raw_and_ev_same_pkt");
        if (n_raw      == 604) chk_pass("V2_604_raw_pkts");   else chk_fail("V2_604_raw_pkts");
        if (drop_px    == 0) chk_pass("V8_no_pixel_drop");    else chk_fail("V8_no_pixel_drop");
        if (drop_ev    == 0) chk_pass("V8_no_event_drop");    else chk_fail("V8_no_event_drop");
        if (n_ev_only  >  0) chk_pass("V9_event_only_pkt");   else chk_fail("V9_event_only_pkt");
        if (exp_raw_pkts == n_raw) chk_pass("V2_raw_pkt_count_consistent"); else chk_fail("V2_raw_pkt_count_consistent");

        $display("INFO packets=%0d raw=%0d ev=%0d both=%0d raw_bytes=%0d drop_px=%0d drop_ev=%0d",
                 n_pkt, n_raw, n_evp, n_both, n_raw_bytes, drop_px, drop_ev);

        $fclose(fd);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 纯事件包计数
    //--------------------------------------------------------------------------
    always @(posedge clk) begin
        if (pkt_ready && pkt[9] == 8'd0 && pkt[10] == 8'd0 &&
            (pkt[11] != 8'd0 || pkt[12] != 8'd0))
            n_ev_only = n_ev_only + 1;
    end

    //--------------------------------------------------------------------------
    // 超时保护（有界，不无限跑）
    //--------------------------------------------------------------------------
    initial begin
        #60000000;                       // 60 ms 仿真时间上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
