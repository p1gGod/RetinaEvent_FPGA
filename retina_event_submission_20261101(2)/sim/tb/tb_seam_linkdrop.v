//==============================================================================
// tb_seam_linkdrop.v —— ★ 网线插拔（环形缓冲满 ⇒ 丢像素/丢帧首标记）后
//                        画面「水平拼接」复发 的复现 + 修复回归 TB
//
// 【现场现象】2026-10-17 用户插拔网线后，画面水平拼接（左右两半错位）复发，
//   且**不会自愈**，只有复位（重烧）才恢复。
//
// 【机理（修复前 udp_merge）】
//   "帧内第几个像素"（pix_in_frame / px_chunk / px_frame）全部由 udp_merge 自己在
//   clk_eth 侧数。网线一断 ⇒ 发送停 ⇒ 环形缓冲满（n_full == SLOTS）⇒ 像素被丢 ⇒
//   本地计数比源侧少 ⇒ 相位永久错开（粘性偏移）⇒ 每一帧都从错误位置开始拼 ⇒
//   屏幕上一整条水平接缝。恢复后不会自愈：丢多少就永久差多少。
//
// 【修复】源侧（display_path）每帧首像素给 1 拍 o_raw_frame_start，随像素一起过 CDC
//   （event_sink 的 raw FIFO 16→17 bit），udp_merge 在 marker 那一拍做**无条件帧相位
//   快照**（wr_pix_cnt/pix_in_frame/px_chunk/px_frame/标签全部按帧首重置）。
//   环满时 marker 也会被丢 ⇒ 挂 resync_pending，等下一个 marker 重新对齐。
//   正常无丢时 marker 恰好落在旧的帧边界 ⇒ 严格 no-op（不改变任何既有行为）。
//
// 【TB 结构】直接例化真实 udp_merge（WIRE_VER=3，帧幅缩小到 800×8 ⇒ 10 段/帧，
//   段/帧/标签/快照逻辑与 800×480 是同一份代码）。像素源 1 px / 3 clk
//   （TX 每段 1306 clk / 640 px ⇒ 2.04 clk/px，源略慢 ⇒ 稳态刚好不丢像素，
//   这样才能构造"干净基线 → 人为环满 → 恢复"的三段式）。
//   像素内容 = 全局像素序号（低 16 bit）⇒ 段内逐像素 +1，且
//   content % PIX_PER_FRAME == chunk*640  ⇒ 标签与内容必须严格对齐（拼接的直接判据）。
//
// 【判据】
//   A1  首个原始段 tag = frame0/chunk0
//   A2  干净基线 3 帧 = 30 段
//   A3  干净基线丢像素计数 = 0（TB 侧 + DUT o_stat_drop_px 两侧）
//   A4  干净基线：包长度/魔数/标签与内容对齐/段内连续 全对
//   A5  干净基线：帧号逐帧 +1（严格）
//   B1  环满进入（n_full == CHUNK_SLOTS）
//   B2  环满丢像素 ⇒ resync_pending 置位
//   B3  环满期间帧首 marker 被丢（≥1 个）
//   C1  恢复后出现新帧的 chunk0，且 content%6400 == 0（相位回到帧首）
//   C2  恢复后 ≥3 帧：标签/内容对齐、段内连续、内容严格递增（无旧槽复用/半帧残留）
//   C3  帧首快照之后不再丢像素（丢计数冻结）
//   C5  重同步挂起期间丢的像素有界（≤ 1 帧，且必须被 o_stat_drop_px 计入）
//   C4  恢复有界（4 帧内出现新帧 chunk0）
//   D1  全程 tag 单调（帧号单调、帧内段号 +1、跨帧段号回 0）
//   D2  DUT o_stat_drop_px == TB 侧统计的丢弃像素数
//   --- 场景 E（中途复位 + 首个真 marker 恰遇环满被丢）---
//   E1  复位后再次进入环满
//   E2  真 marker 在环满窗口被丢（marker_seen 仍为 0）
//   E3  被丢之后 marker_seen 仍是 0（仍在 legacy 合成路径）
//   E4  放开发送端后第一个真 marker 成功快照（marker_seen 0→1）
//   E5  legacy 接管期错位数有界（≤ 1 帧 + 1 段；内容跨复位归零只 +1）
//   E6  snap 之后严格窗口（2 整帧）：对齐/段内连续/内容递增/帧序列 全零增量
//   E7  复位后 DUT 丢像素计数与 TB 统计一致
//==============================================================================
`timescale 1ns / 1ps

module tb_seam_linkdrop;

    //--------------------------------------------------------------------------
    // 帧/段几何（与 800×480 同一份逻辑，仅缩小帧高以压缩仿真时间）
    //--------------------------------------------------------------------------
    localparam IMG_W         = 800;
    localparam IMG_H         = 8;
    localparam PIX_PER_FRAME = IMG_W * IMG_H;        // 6400
    localparam PIX_PER_CHUNK = 640;                  // RAW_CHUNK(1280B)/2
    localparam NCHUNK        = PIX_PER_FRAME / PIX_PER_CHUNK;   // 10
    localparam RAW_BYTES     = PIX_PER_CHUNK * 2;    // 1280
    localparam PKT_LEN       = 24 + RAW_BYTES + 2;   // 1306（头 24 + 原始段 + CRC16）
    localparam FULL_SLOTS    = 4;                    // CHUNK_SLOTS
    localparam PACE          = 3;                    // clk / px（> 2.04 ⇒ 稳态不丢）

    reg clk = 1'b0;
    reg rst_n = 1'b0;
    always #4 clk = ~clk;                            // 125 MHz

    integer errors = 0;
    task chk_pass; input [8*56-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*56-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask
    task chk; input [8*56-1:0] nm; input cond; begin
        if (cond) chk_pass(nm); else chk_fail(nm);
    end endtask

    //--------------------------------------------------------------------------
    // DUT：udp_merge（v3）
    //--------------------------------------------------------------------------
    reg         raw_valid  = 1'b0;
    reg  [15:0] raw_data   = 16'h0000;
    reg         raw_fs     = 1'b0;     // ★ 帧首标记（源侧 display_path 产生）
    reg         fs_mask    = 1'b0;     // 场景 E 专用：屏蔽源侧 marker（模拟"源还没开始打标记"）
    reg         tx_ready   = 1'b1;
    reg         stall      = 1'b0;

    wire        o_tx_start, o_tx_byte_en;
    wire [7:0]  o_tx_byte;
    wire [15:0] o_tx_len;
    wire        o_ctrl_empty;
    wire [15:0] o_drop_px, o_drop_ev, o_frame_idx;

    udp_merge #(
        .WIRE_VER     (3),
        .RAW_CHUNK    (RAW_BYTES),
        .EV_REC_BYTES (5),
        .EV_MAX_BYTES (400),
        .MAX_PAYLOAD  (1472),
        .IMG_W        (IMG_W),
        .IMG_H        (IMG_H),
        .CHUNK_SLOTS  (4),
        .CRC_EN       (1)
    ) u_merge (
        .clk_eth         (clk),
        .rst_n_eth       (rst_n),
        .i_raw_valid     (raw_valid),
        .i_raw_data      (raw_data),
        .i_raw_frame_start(raw_fs),
        .i_ev_valid      (1'b0),
        .i_ev_x          (9'd0),
        .i_ev_y          (8'd0),
        .i_ev_pol        (1'b0),
        .i_tx_ready      (tx_ready),
        .i_cfg_en        (1'b1),
        .o_tx_start      (o_tx_start),
        .o_tx_byte       (o_tx_byte),
        .o_tx_byte_en    (o_tx_byte_en),
        .o_tx_len        (o_tx_len),
        .i_mode          (2'd0),          // RAW_EV
        .i_ts_us         (48'd0),
        .i_ts_valid      (1'b0),
        .i_ts_calibrated (1'b0),
        .i_ev_en         (1'b1),
        .i_frame_decim   (8'd1),          // 不抽帧：每帧都回传
        .i_ev_flush_cyc  (24'd65536),
        .i_act_byte      (8'h00),        // ★ M4b：无动作
        .i_ctrl_wr_en    (1'b0),
        .i_ctrl_data     (8'd0),
        .i_ctrl_commit   (1'b0),
        .o_ctrl_empty    (o_ctrl_empty),
        .o_stat_drop_px  (o_drop_px),
        .o_stat_drop_ev  (o_drop_ev),
        .o_frame_idx     (o_frame_idx)
    );

    //--------------------------------------------------------------------------
    // 像素源：1 px / PACE clk，帧首像素带 marker，内容 = 全局像素序号
    //--------------------------------------------------------------------------
    reg  [15:0] src_px = 16'd0;
    reg  [1:0]  pace   = 2'd0;

    always @(posedge clk) begin
        if (!rst_n) begin
            raw_valid <= 1'b0;
            raw_fs    <= 1'b0;
            raw_data  <= 16'h0000;
            src_px    <= 16'd0;
            pace      <= 2'd0;
        end else begin
            if (pace == (PACE - 1)) begin
                pace      <= 2'd0;
                raw_valid <= 1'b1;
                raw_fs    <= ((src_px % PIX_PER_FRAME) == 0) && !fs_mask;
                raw_data  <= src_px;
                src_px    <= src_px + 16'd1;
            end else begin
                pace      <= pace + 2'd1;
                raw_valid <= 1'b0;
                raw_fs    <= 1'b0;
            end
        end
    end

    //--------------------------------------------------------------------------
    // 丢像素 / 环满 / 重同步挂起 的观测（TB 侧独立统计，与 DUT 对账）
    //--------------------------------------------------------------------------
    wire ring_full = (u_merge.n_full == FULL_SLOTS);

    integer tb_drop      = 0;      // 被丢掉的像素数（TB 侧，口径与 DUT 一致）
    integer tb_mark_full = 0;      // 环满期间被丢掉的帧首 marker 数
    integer n_mark_legacy = 0;     // 其中发生在 marker_seen==0（legacy 路径）期间的
    integer stall_mark   = 0;      // 缓停期间源侧发出的 marker 数
    reg     ring_full_seen  = 1'b0;
    reg     ring_full_seen2 = 1'b0;   // 场景 E（复位后）
    reg     pending_seen    = 1'b0;

    // ★ 丢像素口径 = DUT 的 drop_px_now：
    //   环满（ring_ok=0）任何像素都丢；重同步挂起期间除"帧首快照那一拍"外全丢；
    //   legacy 路径（marker_seen==0、未见过真 marker）不挂 pending，只有环满会丢。
    always @(posedge clk) if (rst_n) begin
        if (raw_valid && (ring_full || (u_merge.resync_pending && !raw_fs)))
            tb_drop = tb_drop + 1;
        if (raw_valid && ring_full && raw_fs) begin
            tb_mark_full = tb_mark_full + 1;
            if (u_merge.marker_seen == 1'b0) n_mark_legacy = n_mark_legacy + 1;
        end
        if (ring_full)              ring_full_seen <= 1'b1;
        if (u_merge.resync_pending) pending_seen   <= 1'b1;
        if (stall && raw_valid && raw_fs) stall_mark = stall_mark + 1;
    end

    //--------------------------------------------------------------------------
    // 发端抓包 + 逐包判据（等价"主机在线上收到的包"）
    //--------------------------------------------------------------------------
    reg  [7:0] pb [0:2047];
    integer    pn = 0;
    integer    cur_len = 0;
    reg        cap_en = 1'b0;

    integer phase = 0;            // 0=复位 1=干净基线 2=缓停 3=恢复 4=收尾

    integer n_pkt      = 0;       // 收到的包总数
    integer n_raw_pkt  = 0;       // 其中含原始段的包数
    integer n_chunk0   = 0;       // chunk==0 的原始段数
    integer last_c0_frame = -1;
    integer last_c0_pos   = -1;

    integer prev_frame = 0, prev_chunk = 0, prev_last_px = 0;
    reg     prev_valid = 1'b0;
    integer first_frame = -1, first_chunk = -1;

    integer err_magic = 0, err_len = 0, err_align = 0, err_step = 0;
    integer err_px_inc = 0, err_tag_seq = 0, err_seqA = 0;

    integer rl, el, fr, ch, k, c0, pv, d;
    reg     bad;

    task analyze;
        begin
            n_pkt = n_pkt + 1;

            // ---- 头（v3 上行 24 B）----
            if ((pb[0]!==8'hF0)||(pb[1]!==8'h5A)||(pb[2]!==8'hA5)||
                (pb[3]!==8'h30)||(pb[4]!==8'h03)||(pb[5]!==8'h18))
                err_magic = err_magic + 1;

            ch = {pb[8],  pb[9]};
            fr = {pb[10], pb[11]};
            rl = {pb[12], pb[13]};
            el = {pb[14], pb[15]};

            if (rl != 0) begin
                n_raw_pkt = n_raw_pkt + 1;

                if (first_frame < 0) begin
                    first_frame = fr;
                    first_chunk = ch;
                end

                if ((rl != RAW_BYTES) || (cur_len != PKT_LEN))
                    err_len = err_len + 1;

                // ---- 内容（16 bit 像素）----
                c0  = {pb[24], pb[25]};
                pv  = c0;
                bad = 1'b0;
                for (k = 1; k < PIX_PER_CHUNK; k = k + 1) begin
                    if ({pb[24+2*k], pb[25+2*k]} !== ((pv + 1) & 16'hFFFF))
                        bad = 1'b1;
                    pv = {pb[24+2*k], pb[25+2*k]};
                end
                if (bad) err_step = err_step + 1;

                // ---- ★ 标签与内容对齐（水平拼接的直接判据）----
                if ((c0 % PIX_PER_FRAME) != (ch * PIX_PER_CHUNK)) begin
                    err_align = err_align + 1;
                    if (err_align <= 4)
                        $display("  [E] tag/content misalign: frame=%0d chunk=%0d content0=%0d (expect pos %0d) at t=%0t",
                                 fr, ch, c0, ch*PIX_PER_CHUNK, $time);
                end

                // ---- 内容严格递增（旧槽复用 / 半帧残留 会破坏它）----
                if (prev_valid) begin
                    d = (c0 - prev_last_px) & 16'hFFFF;
                    if ((d == 0) || (d >= 16'h8000)) begin
                        err_px_inc = err_px_inc + 1;
                        if (err_px_inc <= 4)
                            $display("  [E] content not increasing: prev_last=%0d now=%0d (stale slot?)",
                                     prev_last_px, c0);
                    end
                    // ---- tag 单调 ----
                    if (fr == prev_frame) begin
                        if (ch != prev_chunk + 1) err_tag_seq = err_tag_seq + 1;
                    end else if (fr < prev_frame) begin
                        err_tag_seq = err_tag_seq + 1;
                    end else begin
                        if (ch != 0) err_tag_seq = err_tag_seq + 1;
                        // 干净基线里帧号必须逐帧 +1（无丢像素）
                        if ((phase == 1) && (fr != prev_frame + 1)) err_seqA = err_seqA + 1;
                    end
                end

                if (ch == 0) begin
                    n_chunk0      = n_chunk0 + 1;
                    last_c0_frame = fr;
                    last_c0_pos   = c0 % PIX_PER_FRAME;
                end

                prev_frame   = fr;
                prev_chunk   = ch;
                prev_last_px = pv;
                prev_valid   = 1'b1;
            end
        end
    endtask

    always @(posedge clk) begin
        if (!rst_n) begin
            pn     <= 0;
            cap_en <= 1'b0;
        end else begin
            if (o_tx_start) begin
                pn      <= 0;
                cur_len <= o_tx_len;
                cap_en  <= 1'b1;
            end else if (o_tx_byte_en && cap_en) begin
                pb[pn] = o_tx_byte;
                pn <= pn + 1;
                if ((pn + 1) == cur_len) begin
                    cap_en <= 1'b0;
                    analyze;
                end
            end
        end
    end

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer n_pkt_a, drop_a, drop_dut_a, align_a, step_a, pxinc_a, tagseq_a;
    integer drop_base2, mark_c2, align_c2, step_c2, pxinc_c2, tagseq_c2;
    integer drop_rst, snap_e, align_e, step_e, pxinc_e, tagseq_e, raw_target;
    integer frame_min, chunk0_before, pkt_before, drop_before, drop_recov;
    integer recov_frame, t;
    integer budget;

    initial begin
        // ---- 复位 ----
        rst_n = 1'b0;
        repeat (40) @(posedge clk);
        rst_n = 1'b1;
        phase = 1;
        repeat (10) @(posedge clk);

        //======================================================================
        // A：干净基线（3 帧 = 30 段，稳态不丢像素）
        //======================================================================
        budget = 0;
        while ((n_raw_pkt < 3*NCHUNK) && (budget < 200000)) begin
            @(posedge clk); budget = budget + 1;
        end
        n_pkt_a = n_raw_pkt;
        $display("[A] clean baseline: pkts=%0d raw=%0d tb_drop=%0d dut_drop=%0d first=%0d/%0d",
                 n_pkt, n_raw_pkt, tb_drop, o_drop_px, first_frame, first_chunk);

        chk("A1_first_seg_tag_0_0", (first_frame == 0) && (first_chunk == 0));
        chk("A2_clean_3_frames_30_segs", (n_pkt_a >= 3*NCHUNK));
        chk("A3_clean_no_drop", (tb_drop == 0) && (o_drop_px == 16'd0));
        chk("A4_clean_tag_content_aligned", (err_magic==0) && (err_len==0) &&
                                            (err_align==0) && (err_step==0));
        chk("A5_clean_frame_seq_strict", (err_tag_seq==0) && (err_px_inc==0) && (err_seqA==0));

        // 快照（B/C 段对账用）
        drop_a     = tb_drop;
        drop_dut_a = o_drop_px;
        align_a    = err_align;
        step_a     = err_step;
        pxinc_a    = err_px_inc;
        tagseq_a   = err_tag_seq;

        //======================================================================
        // B：插拔网线 —— 发送端停摆 ⇒ 环形缓冲满 ⇒ 丢像素 + 丢帧首 marker
        //======================================================================
        phase = 2;
        stall    = 1'b1;
        tx_ready = 1'b0;

        // 等环满 + 至少 2 个帧首 marker 打在环满窗口里
        budget = 0;
        while (!(ring_full_seen && (stall_mark >= 2)) && (budget < 300000)) begin
            @(posedge clk); budget = budget + 1;
        end
        $display("[B] link-drop stall: ring_full=%b pending=%b tb_drop=%0d (delta %0d) mark_dropped=%0d",
                 ring_full_seen, pending_seen, tb_drop, tb_drop - drop_a, tb_mark_full);

        chk("B1_ring_full_reached", ring_full_seen);
        chk("B2_resync_pending_set", pending_seen);
        chk("B3_frame_marker_dropped_while_full", (tb_mark_full > 0));
        chk("B4_pixels_dropped_while_full", ((tb_drop - drop_a) > 0));

        //======================================================================
        // C：网线插回 ⇒ 发送恢复，帧相位必须重新对齐（修复前 = 永久错位）
        //======================================================================
        frame_min     = u_merge.px_frame + 16'd1;   // 恢复后第一个真实帧号
        chunk0_before = n_chunk0;
        pkt_before    = n_pkt;
        drop_before   = tb_drop;
        phase = 3;
        stall    = 1'b0;
        tx_ready = 1'b1;

        // 等"恢复帧的 chunk0"（帧号 ≥ frame_min 且相位 0）
        recov_frame = -1;
        budget = 0;
        while ((recov_frame < 0) && (budget < 300000)) begin
            @(posedge clk); budget = budget + 1;
            if ((n_chunk0 > chunk0_before) && (last_c0_frame >= frame_min) && (recov_frame < 0))
                recov_frame = last_c0_frame;
        end
        $display("[C] recovery: frame_min=%0d recov_frame=%0d c0_pos=%0d in %0d clk",
                 frame_min, recov_frame, last_c0_pos, budget);
        // ★ 重同步挂起期间（发到帧首 marker 之前）那点像素是**故意丢掉的半帧**，
        //   必须计入 o_stat_drop_px（这正是本次修复要保证的"不再静默丢像素"）。
        //   长度上界 1 帧 ⇒ 单独一条有界判据；C3 的"恢复后不再丢"从快照那一刻起算。
        $display("[C] drops during resync (discarded half frame) = %0d (bound %0d)",
                 tb_drop - drop_before, PIX_PER_FRAME);
        chk("C5_recovery_drop_bounded", ((tb_drop - drop_before) <= PIX_PER_FRAME));
        drop_recov = tb_drop;

        chk("C4_recovery_bounded", (recov_frame >= 0) && (budget < 4*PIX_PER_FRAME*PACE));
        chk("C1_chunk0_phase_back_to_0", (recov_frame >= frame_min) && (last_c0_pos == 0) &&
                                         (u_merge.resync_pending == 1'b0));

        // 恢复后至少再跑 3 个完整帧
        budget = 0;
        while ((prev_frame < recov_frame + 3) && (budget < 400000)) begin
            @(posedge clk); budget = budget + 1;
        end
        $display("[C] post-recovery: frames %0d..%0d pkts=%0d drops_since_snap=%0d",
                 recov_frame, prev_frame, n_pkt - pkt_before, tb_drop - drop_recov);

        chk("C2_post_recovery_aligned",
            (err_align == align_a) && (err_step == step_a) &&
            (err_px_inc == pxinc_a) && (n_pkt - pkt_before >= 3*NCHUNK));
        chk("C3_no_drop_after_recovery", (tb_drop == drop_recov));
        chk("D1_tag_monotonic_all", (err_tag_seq == tagseq_a));

        //======================================================================
        // D：丢像素计数对账（DUT 16 bit 自由计数 vs TB 观测）
        //======================================================================
        $display("[D] drop accounting: tb=%0d dut=%0d (mod 65536) stall_mark=%0d",
                 tb_drop, o_drop_px, stall_mark);
        chk("D2_drop_counter_match", (o_drop_px == ((tb_drop & 16'hFFFF))));

        //======================================================================
        // E：★ 首个真 marker 恰遇环满被丢（marker_seen 仍为 0）⇒ legacy 合成路径
        //    短暂接管 ⇒ ring 一有空间，下一个真 marker 立刻重新对齐。
        //    【为什么必须单独覆盖】marker_seen 只在"快照成功"时置位；若上电/复位后
        //    头几个真 marker 恰好落在环满窗口里被丢掉，DUT 手里一个真 marker 都没
        //    见过 ⇒ legacy_sync=1 ⇒ 仍按旧办法自己数帧首（合成 marker），且环满丢像素
        //    时不挂 resync_pending（保住旧语义）。这一段会发出**相位错开的段**
        //    （长度上界 1 帧），第一个"环不满时的真 marker"一到就永久切换成真 marker
        //    同步（marker_seen 0→1，此后不再走合成路径）。
        //    构造：中途脉冲复位（DUT 与源一起归零、marker_seen 清 0）⇒ 屏蔽源侧
        //    marker（源"还没开始打标记"）+ tx_ready=0 把环填满 ⇒ 打开 marker，
        //    这些真 marker 全落在环满窗口里被丢（marker_seen 仍 0）⇒ 放开发送端，
        //    环排空后下一个真 marker 成功快照（0→1）⇒ 相位重新对齐、错位不再增长。
        //======================================================================
        drop_base2 = tb_drop;
        mark_c2    = tb_mark_full;
        align_c2   = err_align;
        step_c2    = err_step;
        pxinc_c2   = err_px_inc;
        tagseq_c2  = err_tag_seq;

        phase    = 5;
        tx_ready = 1'b0;
        stall    = 1'b1;
        fs_mask  = 1'b1;            // 复位后先不打 marker
        rst_n    = 1'b0;
        repeat (40) @(posedge clk);
        rst_n     = 1'b1;
        drop_rst  = tb_drop;        // DUT o_stat_drop_px 已被复位清零 ⇒ 从这里重新对账
        // 环填满（源 1 px / 3 clk，4 段 = 2560 px ≈ 7680 clk）
        budget = 0;
        while (!ring_full_seen2 && (budget < 200000)) begin
            @(posedge clk);
            if (ring_full) ring_full_seen2 = 1'b1;
            budget = budget + 1;
        end
        $display("[E] after reset: ring_full=%b marker_seen=%b tb_drop=%0d budget=%0d",
                 ring_full_seen2, u_merge.marker_seen, tb_drop, budget);

        // 打开真 marker：此刻环仍满 ⇒ 全部被丢（marker_seen 保持 0）
        fs_mask = 1'b0;
        budget = 0;
        while (((tb_mark_full - mark_c2) < 1) && (budget < 200000)) begin
            @(posedge clk); budget = budget + 1;
        end
        $display("[E] real markers dropped while full: %0d (marker_seen=%b legacy_marks=%0d) in %0d clk",
                 tb_mark_full - mark_c2, u_merge.marker_seen, n_mark_legacy, budget);
        chk("E1_ring_full_after_reset", ring_full_seen2);
        chk("E2_marker_dropped_while_full", ((tb_mark_full - mark_c2) > 0));
        chk("E3_marker_seen_still_0_after_drop", (u_merge.marker_seen == 1'b0));

        // 放开发送端：环排空 ⇒ 下一个真 marker 立刻快照成功（marker_seen 0→1）
        stall    = 1'b0;
        tx_ready = 1'b1;
        snap_e   = -1;
        budget   = 0;
        while ((snap_e < 0) && (budget < 8*PIX_PER_FRAME*PACE)) begin
            @(posedge clk); budget = budget + 1;
            if (u_merge.marker_seen) snap_e = budget;
        end
        $display("[E] first successful snap after %0d clk (marker_seen=%b)", budget, u_merge.marker_seen);
        chk("E4_first_marker_realigns", (snap_e >= 0));
        // legacy 接管期允许错位（长度有界 ⇒ 最多 1 帧 = NCHUNK 段，再留 1 段余量）；
        // 内容在复位处归零会让"跨复位递增"判定 +1（TB 观测口径，非 DUT 缺陷）。
        $display("[E] legacy window: d_align=%0d d_step=%0d d_pxinc=%0d d_tagseq=%0d",
                 err_align - align_c2, err_step - step_c2,
                 err_px_inc - pxinc_c2, err_tag_seq - tagseq_c2);
        chk("E5_legacy_window_bounded", ((err_align - align_c2) <= (NCHUNK + 1)) &&
                                        ((err_step == step_c2)) &&
                                        ((err_px_inc - pxinc_c2) <= 1));

        // 等 snap 之前已排队的段全部发完（FULL_SLOTS+4 段），再取"严格窗口"基线
        raw_target = n_raw_pkt + FULL_SLOTS + 4;
        budget = 0;
        while ((n_raw_pkt < raw_target) && (budget < 200000)) begin
            @(posedge clk); budget = budget + 1;
        end
        align_e  = err_align;  step_e  = err_step;
        pxinc_e  = err_px_inc; tagseq_e = err_tag_seq;
        raw_target = n_raw_pkt + 2*NCHUNK;   // 再跑 2 整帧
        budget = 0;
        while ((n_raw_pkt < raw_target) && (budget < 400000)) begin
            @(posedge clk); budget = budget + 1;
        end
        $display("[E] strict window: segs=%0d d_align=%0d d_step=%0d d_pxinc=%0d d_tagseq=%0d",
                 n_raw_pkt - (raw_target - 2*NCHUNK),
                 err_align - align_e, err_step - step_e,
                 err_px_inc - pxinc_e, err_tag_seq - tagseq_e);
        chk("E6_strict_after_snap", (n_raw_pkt >= raw_target) &&
            (err_align == align_e) && (err_step == step_e) &&
            (err_px_inc == pxinc_e) && (err_tag_seq == tagseq_e));
        // 复位后丢像素对账（o_stat_drop_px 已随复位清零）
        $display("[E] drop accounting after reset: tb=%0d dut=%0d", tb_drop - drop_rst, o_drop_px);
        chk("E7_drop_counter_match_after_reset", (o_drop_px == ((tb_drop - drop_rst) & 16'hFFFF)));

        $display("  [SUMMARY] pkts=%0d raw=%0d chunk0=%0d err(magic=%0d len=%0d align=%0d step=%0d pxinc=%0d tagseq=%0d)",
                 n_pkt, n_raw_pkt, n_chunk0, err_magic, err_len, err_align, err_step,
                 err_px_inc, err_tag_seq);
        phase = 4;
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #20000000;                                   // 20 ms 上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
