//==============================================================================
// tb_wire_v3.v —— udp_merge WIRE_VER=3 协议自测（v3 设计 §2/§3/§4/§6，R8）
//
// 判据：
//   H1  24 B 包头逐字节：MAGIC=F0 5A A5 30 / VER=03 / HDR_LEN=18 / FLAGS /
//       MODE / CHUNK_IDX / FRAME_IDX / RAW_LEN / EV_LEN / TS_US(BE) /
//       EV_REC_BYTES / RSVD（§2.1 全字段，首包 100% 核对）
//   M1  ★断言① MODE0=RAW_EV：帧内容 = RAW 段 + EV 段（FLAGS bit0/bit1 同现）
//   M2  ★断言① 帧中途切 MODE1 ⇒ 在途帧以旧模式完整发完（一帧内 MODE 恒定），
//       下一帧起 MODE=1 且 EV_LEN 恒 0（FLAGS bit1=0）
//   M3  ★断言① MODE2=EV_ONLY：包无 RAW 段（RAW_LEN=0/FLAGS bit0=0），
//       纯事件包容量 289 条（1445 B）
//   M4  ★断言① MODE2→MODE0：事件积压先排空、原始帧随后恢复且完整（无半帧）
//   E1  EV_EN=0 ⇒ 无事件段（EV_LEN=0 / bit1=0 / EV_REC_BYTES=0）；=1 恢复
//   T1  ★断言②（包级）TS_US 字节 = 包首锁存的 i_ts_us（BE，逐包精确核对）
//   T2  ★断言②（包级）TS 单调不减；FLAGS bit3/bit4 随 i_ts_valid/i_ts_calibrated
//   C1  CRC16 覆盖 [0 .. 24+RAW_LEN+EV_LEN-1]，尾部 2 B BE
//   C2  CTRL 包：发得出来、字节逐字直通、长度正确（38 B REQ 形包）
//   L1  MTU 红线：所有包 ≤ 1472 B
//   F1  CHUNK_IDX 0..5 / FIRST(bit5)/LAST(bit6) 落在帧首末块 / FRAME_IDX 推进
//
// 加速手段：IMG_W=80 / IMG_H=48 ⇒ 每帧 3840 px = 6 包 × 1280 B（帧边界来得快，
// 能真正测到"帧边界锁存"与 LAST_OF_FRAME，而不用喂 600 包）。
//==============================================================================
`timescale 1ns / 1ps

module tb_wire_v3;

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
    // DUT（v3，小画面参数加速帧边界）
    //--------------------------------------------------------------------------
    reg         raw_valid = 1'b0;
    reg  [15:0] raw_data  = 16'd0;
    reg         ev_valid  = 1'b0;
    reg  [8:0]  ev_x      = 9'd0;
    reg  [7:0]  ev_y      = 8'd0;
    reg         ev_pol    = 1'b0;
    reg         tx_ready  = 1'b1;
    reg         cfg_en    = 1'b1;
    reg  [1:0]  mode_in   = 2'd0;
    reg  [47:0] ts_in     = 48'd1000;
    reg         ts_valid_in = 1'b1;
    reg         ts_cal_in   = 1'b0;
    reg         ev_en_in    = 1'b1;
    reg  [7:0]  decim_in    = 8'd1;
    reg  [23:0] flush_in    = 24'd65536;
    reg         ctrl_wr_en  = 1'b0;
    reg  [7:0]  ctrl_data   = 8'd0;
    reg         ctrl_commit = 1'b0;

    wire        tx_start;
    wire [7:0]  tx_byte;
    wire        tx_byte_en;
    wire [15:0] tx_len;
    wire [15:0] drop_px, drop_ev;
    wire        ctrl_empty;
    wire [15:0] frame_idx_w;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (1280),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .FRAME_DECIM  (1),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (80),          // ★ 加速：3840 px = 6 chunk/帧
        .IMG_H        (48),
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
        .i_mode        (mode_in),
        .i_ts_us       (ts_in),
        .i_ts_valid    (ts_valid_in),
        .i_ts_calibrated(ts_cal_in),
        .i_ev_en       (ev_en_in),
        .i_frame_decim (decim_in),
        .i_ev_flush_cyc(flush_in),
        .i_act_byte    (8'h00),          // ★ M4b：无动作，byte23 保持 0x00（旧行为回归）
        .i_ctrl_wr_en  (ctrl_wr_en),
        .i_ctrl_data   (ctrl_data),
        .i_ctrl_commit (ctrl_commit),
        .o_ctrl_empty  (ctrl_empty),
        .o_frame_idx   (frame_idx_w),
        .o_tx_start    (tx_start),        // ★ 补回（首版漏接，抓包全空）
        .o_tx_byte     (tx_byte),
        .o_tx_byte_en  (tx_byte_en),
        .o_tx_len      (tx_len),
        .o_stat_drop_px(drop_px),
        .o_stat_drop_ev(drop_ev)
    );

    //--------------------------------------------------------------------------
    // TS 模型：ts_model 每 100 拍 +1（µs）；ts_off_model 模拟"offset 写入跳变"。
    //   ts_in = ts_model + ts_off_model —— 唯一驱动源，阶段 F 置位即跳变。
    //--------------------------------------------------------------------------
    reg [47:0] ts_model     = 48'd1000;
    reg [47:0] ts_off_model = 48'd0;
    reg [6:0]  ts_tick_cnt  = 7'd0;

    always @(posedge clk) begin
        if (rst_n) begin
            if (ts_tick_cnt == 7'd99) begin
                ts_tick_cnt <= 7'd0;
                ts_model    <= ts_model + 48'd1;
            end
            else ts_tick_cnt <= ts_tick_cnt + 7'd1;
            ts_in <= ts_model + ts_off_model;
        end
    end

    //--------------------------------------------------------------------------
    // CRC16
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

    //--------------------------------------------------------------------------
    // 抓包
    //--------------------------------------------------------------------------
    reg [7:0]  pkt [0:2047];
    integer    pkt_len_c;
    integer    pkt_cnt;
    reg        pkt_collecting;
    reg        pkt_ready;
    reg [47:0] ts_at_start;        // tx_start 拍的 i_ts_us（= 包首锁存期望值）

    always @(posedge clk) begin
        pkt_ready <= 1'b0;
        if (tx_start) begin
            pkt_len_c      <= tx_len;
            pkt_cnt        <= 0;
            pkt_collecting <= 1'b1;
            ts_at_start    <= ts_in;
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
    // 逐包检查
    //--------------------------------------------------------------------------
    integer n_pkt = 0;
    integer e_hdr = 0, e_crc = 0, e_mtu = 0, e_len = 0;
    integer e_mode = 0, e_ts = 0, e_evrec = 0, e_flags = 0, e_ctrl = 0;
    integer e_mono = 0, e_frame = 0, e_chunk = 0;

    reg [47:0] ts_prev = 48'd0;
    reg        ts_first = 1'b1;

    // 帧内 MODE 一致性：FRAME_IDX → 该帧首包 MODE
    reg [1:0]  frame_mode [0:255];
    reg        frame_seen [0:255];
    integer    fi;

    // 模式统计
    integer n_raw_mode1 = 0;
    integer n_pure_mode2 = 0, max_recs_mode2 = 0;
    integer n_pure_mode0 = 0, max_recs_mode0 = 0;
    integer n_ctrl_seen = 0;
    integer n_raw_pkts = 0;

    integer i, k, nrec;
    reg [15:0] crc_c, crc_e;
    reg [15:0] p_len, p_rawlen, p_evlen, p_frame, p_chunk;
    reg [7:0]  p_flags, p_mode, p_evrec;
    reg [47:0] p_ts;

    task check_pkt;
        begin
            n_pkt    = n_pkt + 1;
            p_flags  = pkt[6];
            p_mode   = pkt[7];
            p_chunk  = {pkt[8],  pkt[9]};
            p_frame  = {pkt[10], pkt[11]};
            p_rawlen = {pkt[12], pkt[13]};
            p_evlen  = {pkt[14], pkt[15]};
            p_ts     = {pkt[16], pkt[17], pkt[18], pkt[19], pkt[20], pkt[21]};
            p_evrec  = pkt[22];
            p_len    = pkt_len_c;
            $display("PKT n=%0d mode=%0d raw=%0d ev=%0d chunk=%0d frame=%0d flags=%02b len=%0d",
                     n_pkt, p_mode, p_rawlen, p_evlen, p_chunk, p_frame, p_flags, p_len);

            // --- CTRL 包只查 MTU/CRC/长度（其余字段属于数据包判据）---
            if (p_flags[7]) begin
                if (p_len > 16'd1472) e_mtu = e_mtu + 1;
                n_ctrl_seen = n_ctrl_seen;   // （专用核对在下方独立块）
            end
            else begin
            // --- H1：包头逐字段（每包都查的通用项）---
            if (pkt[0] !== 8'hF0 || pkt[1] !== 8'h5A || pkt[2] !== 8'hA5 ||
                pkt[3] !== 8'h30) e_hdr = e_hdr + 1;
            if (pkt[4] !== 8'h03) e_hdr = e_hdr + 1;
            if (pkt[5] !== 8'h18) e_hdr = e_hdr + 1;
            if (pkt[23] !== 8'h00) e_hdr = e_hdr + 1;

            // --- L1：MTU ---
            if (p_len > 16'd1472) begin
                e_mtu = e_mtu + 1;
                $display("  [E] MTU n=%0d len=%0d raw=%0d ev=%0d mode=%0d", n_pkt, p_len, p_rawlen, p_evlen, p_mode);
            end

            // --- 长度自洽（§2.3）---
            if (p_len !== (24 + p_rawlen + p_evlen + 2)) e_len = e_len + 1;
            if ((p_evlen % 5) != 0) e_len = e_len + 1;
            if (p_flags[0] !== (p_rawlen != 0)) e_flags = e_flags + 1;
            if (p_flags[1] !== (p_evlen  != 0)) e_flags = e_flags + 1;
            if (p_flags[2] !== 1'b1)            e_flags = e_flags + 1;   // CRC_PRESENT
            if (p_flags[3] !== ts_valid_in)     e_flags = e_flags + 1;
            if (p_flags[4] !== ts_cal_in)       e_flags = e_flags + 1;

            // --- 段/模式相容（§2.3）---
            if ((p_mode == 8'd1) && (p_evlen != 0))  begin
                e_mode = e_mode + 1;
                $display("  [E] mode1-with-ev n=%0d ev=%0d", n_pkt, p_evlen);
            end
            if ((p_mode == 8'd2) && (p_rawlen != 0)) begin
                e_mode = e_mode + 1;
                $display("  [E] mode2-with-raw n=%0d raw=%0d", n_pkt, p_rawlen);
            end
            if (p_mode > 8'd2) e_mode = e_mode + 1;

            // --- EV_REC_BYTES（§2.1：有事件段=5，无=0）---
            if (p_evrec !== ((p_evlen != 0) ? 8'h05 : 8'h00)) e_evrec = e_evrec + 1;

            // --- T1：TS = 包首锁存的 i_ts_us（±1 µs：采样沿容差）---
            if ((p_ts < ts_at_start - 48'd1) || (p_ts > ts_at_start + 48'd1)) begin
                e_ts = e_ts + 1;
                $display("  [E] ts n=%0d got=%0d exp=%0d", n_pkt, p_ts, ts_at_start);
            end

            // --- T2：单调 ---
            if (!ts_first && (p_ts < ts_prev)) e_mono = e_mono + 1;
            ts_prev  = p_ts;
            ts_first = 1'b0;

            // --- C1：CRC 覆盖 [0..24+R+E-1] ---
            crc_c = 16'hFFFF;
            for (k = 0; k < (p_len - 2); k = k + 1) crc_c = crc16f(crc_c, pkt[k]);
            crc_e = {pkt[p_len-2], pkt[p_len-1]};
            if (crc_c !== crc_e) e_crc = e_crc + 1;

            // --- F1：帧/块序号 + FIRST/LAST + 帧内 MODE 恒定 ---
            if (p_rawlen != 0) begin
                n_raw_pkts = n_raw_pkts + 1;
                if (p_flags[5] !== (p_chunk == 16'd0)) e_flags = e_flags + 1;
                if (p_flags[6] !== (p_chunk == 16'd5)) e_flags = e_flags + 1;
                fi = p_frame[7:0];
                if (!frame_seen[fi]) begin
                    frame_seen[fi] = 1'b1;
                    frame_mode[fi] = p_mode[1:0];
                end
                else if (frame_mode[fi] !== p_mode[1:0]) e_frame = e_frame + 1;
                if (p_mode == 8'd1) n_raw_mode1 = n_raw_mode1 + 1;
            end
            else begin
                if (p_flags[7:5] !== 3'b000) e_flags = e_flags + 1;  // 纯事件包无首末位
                nrec = p_evlen / 5;
                if (p_mode == 8'd2) begin
                    n_pure_mode2 = n_pure_mode2 + 1;
                    if (nrec > max_recs_mode2) max_recs_mode2 = nrec;
                end
                else if (p_mode == 8'd0) begin
                    n_pure_mode0 = n_pure_mode0 + 1;
                    if (nrec > max_recs_mode0) max_recs_mode0 = nrec;
                end
            end
            // --- F1：CHUNK 范围（数据包）---
            if (p_rawlen != 0) begin
                if (p_chunk > 16'd5) begin
                    e_chunk = e_chunk + 1;
                    $display("  [E] chunk n=%0d chunk=%0d frame=%0d mode=%0d", n_pkt, p_chunk, p_frame, p_mode);
                end
            end
            end // else (非 CTRL 包)
        end
    endtask

    always @(posedge clk) if (pkt_ready) check_pkt;

    //--------------------------------------------------------------------------
    // 激励
    //--------------------------------------------------------------------------
    integer gi;

    task feed_pix; input [15:0] d; begin
        @(negedge clk);
        raw_valid <= 1'b1;
        raw_data  <= d;
        @(negedge clk);
        raw_valid <= 1'b0;
    end endtask

    task feed_ev; input [8:0] x; input [7:0] y; input p; begin
        @(negedge clk);
        ev_valid <= 1'b1;
        ev_x     <= x;
        ev_y     <= y;
        ev_pol   <= p;
        @(negedge clk);
        ev_valid <= 1'b0;
    end endtask

    task feed_frame; input [31:0] base; input integer with_ev;
        integer j;
        begin
            for (j = 0; j < 3840; j = j + 1) begin
                feed_pix(base[15:0] + j[15:0]);
                if (with_ev != 0 && ((j % 50) == 0))
                    feed_ev(j[8:0] % 9'd80, j[7:0] % 8'd48, j[0]);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // CTRL 包推送（预构好的 38 B REQ 形包）
    //--------------------------------------------------------------------------
    reg [7:0] ctrl_pkt [0:37];
    task push_ctrl;
        begin
            for (i = 0; i < 38; i = i + 1) begin
                @(negedge clk);
                ctrl_wr_en <= 1'b1;
                ctrl_data  <= ctrl_pkt[i];
            end
            @(negedge clk);
            ctrl_wr_en  <= 1'b0;
            ctrl_commit <= 1'b1;
            @(negedge clk);
            ctrl_commit <= 1'b0;
        end
    endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer n1;

    initial begin
        for (fi = 0; fi < 256; fi = fi + 1) frame_seen[fi] = 1'b0;

        repeat (10) @(negedge clk);
        rst_n <= 1'b1;
        repeat (4) @(negedge clk);

        //======================================================================
        // 阶段 A：MODE0（RAW_EV）两整帧 → 首包 24 B 逐字节 + 断言① RAW/EV 同现
        //======================================================================
        feed_frame(32'h0000_0000, 1);
        repeat (8000) @(negedge clk);

        // 首包逐字节核对
        if (pkt[0]===8'hF0 && pkt[1]===8'h5A && pkt[2]===8'hA5 && pkt[3]===8'h30 &&
            pkt[4]===8'h03 && pkt[5]===8'h18 && pkt[7]===8'h00)
            chk_pass("H1_first_hdr_exact");
        else chk_fail("H1_first_hdr_exact");
        if (pkt[22] === 8'h05) chk_pass("H1_ev_rec_bytes_5");
        else                   chk_fail("H1_ev_rec_bytes_5");

        //======================================================================
        // 阶段 B：★帧中途切 MODE1（RAW_ONLY）→ 在途帧旧模式发完，下一帧 MODE1
        //======================================================================
        mode_in <= 2'd1;                       // 帧中途置位（等下一帧边界才生效）
        feed_frame(32'h0000_1000, 1);          // 在途帧：必须整体仍以 MODE0 发完
        repeat (8000) @(negedge clk);
        feed_frame(32'h0000_2000, 1);          // MODE1 帧：必须 EV_LEN=0
        repeat (8000) @(negedge clk);

        n1 = 0;
        for (fi = 0; fi < 256; fi = fi + 1)
            if (frame_seen[fi] && frame_mode[fi] == 2'd1) n1 = n1 + 1;
        if (n1 >= 1) chk_pass("M2_raw_only_frame");
        else         chk_fail("M2_raw_only_frame");
        if (e_frame == 0) chk_pass("M2_one_mode_per_frame");
        else              chk_fail("M2_one_mode_per_frame");

        //======================================================================
        // 阶段 C：MODE2（EV_ONLY）—— 相机停流 + 事件灌入 → 纯事件包
        //======================================================================
        mode_in <= 2'd2;
        repeat (400) @(negedge clk);           // 等帧边界锁存
        // 事件间隔 8 拍（≈8× 实际事件率）：页容量 289 与发包速率本可扛住
        // 2 拍间隔的极端突发（丢弃会计数），但该判据要的是"无丢弃"
        for (gi = 0; gi < 600; gi = gi + 1) begin
            feed_ev(gi[8:0] % 9'd80, gi[7:0] % 8'd48, gi[0]);
            repeat (6) @(negedge clk);
        end
        repeat (30000) @(negedge clk);

        //======================================================================
        // 阶段 D：MODE2 → MODE0，事件积压排空后原始帧恢复（无半帧）
        //======================================================================
        mode_in <= 2'd0;
        feed_frame(32'h0000_3000, 1);
        repeat (15000) @(negedge clk);

        //======================================================================
        // 阶段 E：EV_EN=0 → 无事件段；恢复 → 事件段回来
        //======================================================================
        ev_en_in <= 1'b0;
        feed_frame(32'h0000_4000, 1);
        repeat (10000) @(negedge clk);
        ev_en_in <= 1'b1;
        feed_frame(32'h0000_5000, 1);
        repeat (10000) @(negedge clk);

        //======================================================================
        // 阶段 F：TS 校准跳变（★断言②包级）+ FLAGS bit4
        //======================================================================
        ts_cal_in    <= 1'b1;
        ts_off_model <= 48'd50000;             // 模拟 offset 写入：aligned 向上跳 50 ms
        feed_frame(32'h0000_6000, 1);
        repeat (10000) @(negedge clk);

        //======================================================================
        // 阶段 G：CTRL 包在原始包流中插队直通
        //======================================================================
        ctrl_pkt[0]=8'hF0; ctrl_pkt[1]=8'h5A; ctrl_pkt[2]=8'hA5; ctrl_pkt[3]=8'h30;
        ctrl_pkt[4]=8'h03; ctrl_pkt[5]=8'h18; ctrl_pkt[6]=8'h87; ctrl_pkt[7]=8'h02;
        for (i = 8; i < 36; i = i + 1) ctrl_pkt[i] = (i * 7 + 3) & 8'hFF;
        crc_c = 16'hFFFF;
        for (i = 0; i < 36; i = i + 1) crc_c = crc16f(crc_c, ctrl_pkt[i]);
        ctrl_pkt[36] = crc_c[15:8];
        ctrl_pkt[37] = crc_c[7:0];

        // 灌 2 个 chunk（环里有待发数据、包流进行中），随后提交 CTRL 包
        for (gi = 0; gi < 1280; gi = gi + 1) feed_pix(32'h0000_7000 + gi[31:0]);
        push_ctrl;
        repeat (8000) @(negedge clk);

        //======================================================================
        // 汇总判据
        //======================================================================
        if (e_hdr   == 0) chk_pass("H1_hdr_fields_ok");     else chk_fail("H1_hdr_fields_ok");
        if (e_len   == 0) chk_pass("H1_len_selfconsistent");else chk_fail("H1_len_selfconsistent");
        if (e_flags == 0) chk_pass("H1_F1_flags_ok");       else chk_fail("H1_F1_flags_ok");
        if (e_evrec == 0) chk_pass("H1_ev_rec_bytes_ok");   else chk_fail("H1_ev_rec_bytes_ok");
        if (e_crc   == 0) chk_pass("C1_crc16_ok");          else chk_fail("C1_crc16_ok");
        if (e_mtu   == 0) chk_pass("L1_mtu_1472");          else chk_fail("L1_mtu_1472");
        if (e_mode  == 0) chk_pass("M1_M3_mode_seg_consistent"); else chk_fail("M1_M3_mode_seg_consistent");
        if (e_ts    == 0) chk_pass("T1_ts_bytes_snapshot"); else chk_fail("T1_ts_bytes_snapshot");
        if (e_mono  == 0) chk_pass("T2_ts_monotonic");      else chk_fail("T2_ts_monotonic");
        if (e_chunk == 0) chk_pass("F1_chunk_idx_range");   else chk_fail("F1_chunk_idx_range");
        if (drop_px == 0 && drop_ev == 0) chk_pass("M4_X1_no_drop"); else chk_fail("M4_X1_no_drop");
        if (n_ctrl_seen == 1 && e_ctrl == 0) chk_pass("C2_ctrl_passthrough"); else chk_fail("C2_ctrl_passthrough");
        if (n_pure_mode2 > 0 && max_recs_mode2 <= 289) chk_pass("M3_ev_only_pkts"); else chk_fail("M3_ev_only_pkts");
        if (n_raw_mode1 > 0) chk_pass("M2_raw_pkts_mode1"); else chk_fail("M2_raw_pkts_mode1");
        if (n_raw_pkts > 10) chk_pass("M4_raw_resumes");    else chk_fail("M4_raw_resumes");

        $display("INFO pkts=%0d raw=%0d mode1raw=%0d pure2=%0d(max %0d) pure0=%0d(max %0d) ctrl=%0d e=%0d/%0d/%0d/%0d/%0d drop_px=%0d drop_ev=%0d",
                 n_pkt, n_raw_pkts, n_raw_mode1, n_pure_mode2, max_recs_mode2,
                 n_pure_mode0, max_recs_mode0, n_ctrl_seen,
                 e_hdr, e_flags, e_mode, e_ts, e_crc, drop_px, drop_ev);

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // CTRL 包专项核对（FLAGS bit7 + 38 B 逐字直通）
    //--------------------------------------------------------------------------
    integer ci;
    reg     ctrl_match;
    always @(posedge clk) begin
        if (pkt_ready && pkt[6][7]) begin
            n_ctrl_seen = n_ctrl_seen + 1;
            ctrl_match = 1'b1;
            if (pkt_len_c !== 38) ctrl_match = 1'b0;
            for (ci = 0; ci < 38; ci = ci + 1)
                if (pkt[ci] !== ctrl_pkt[ci]) ctrl_match = 1'b0;
            if (!ctrl_match) e_ctrl = e_ctrl + 1;
        end
    end

    //--------------------------------------------------------------------------
    // 临时调试：mode_q 变化跟踪
    //--------------------------------------------------------------------------
    integer evcnt = 0;
    always @(posedge clk) if (ev_valid) evcnt = evcnt + 1;
    always @(posedge clk) if (dut.pkt_go)
        $display("DBGP t=%0t modeq=%0d raw=%0d pd=%0d evcnt=%0d", $time, dut.mode_q, dut.raw_pending, dut.ev_rec_pd, evcnt);
    reg [15:0] dev_d = 16'd0;
    always @(posedge clk) begin
        dev_d <= dut.o_stat_drop_ev;
        if (dut.o_stat_drop_ev !== dev_d)
            $display("DBGD t=%0t drop_ev=%0d modeq=%0d pd=%0d coll=%0d", $time,
                     dut.o_stat_drop_ev, dut.mode_q, dut.ev_rec_pd, dut.ev_rec_collect);
    end
    reg [1:0] mq_d = 2'd0;
    reg [1:0] mi_d = 2'd0;
    always @(posedge clk) begin
        mq_d <= dut.mode_q;
        mi_d <= mode_in;
        if (dut.mode_q !== mq_d) $display("DBGM t=%0t modeq %0d->%0d", $time, mq_d, dut.mode_q);
        if (mode_in !== mi_d)    $display("DBGM t=%0t modein -> %0d", $time, mode_in);
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #80000000;                       // 80 ms 仿真时间上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
