//==============================================================================
// tb_sccb_ila_dump.v —— sccb_patch 波形转储 TB（**仅供离线解码器验证**，不判 PASS/FAIL）
//
// 目的（2026-10-13 曝光生效验证任务）：在上板 ILA 之前，先在仿真里把
//   "补写器在真实总线上的 4 条写事务波形" 落成**与 ILA CSV 同格式**的文件，
//   用它验证离线解码器 `sccb_decode.py`（列名/字节序/ACK 位口径）⇒
//   避免把"解码器 bug"当成"板子结论"。
//
// 覆盖两个 cap 值：
//   cap=4     （EXP_CAP_MIN，命令档）→ 期望 data 字节 = 00/04
//   cap=5904  （0x1710，基线档）     → 期望 data 字节 = 17/10
//
// 从机模型：`pullup(cam_sda)` + 在第 9 位（patch_sda_oe=0 且 owner=1）把 pad 拉低
//   ⇒ 第 9 位读到 0（= 从机应答）⇒ DUT 的 o_ack_cnt 应到 4。
//
// 转储格式（与 `write_hw_ila_data -csv_file` 同构）：
//   行1 = 列名（带引号），行2 = "Radix - HEX" 说明行，行3+ = 每拍一行的十六进制值。
//==============================================================================
`timescale 1ns / 1ps

module tb_sccb_ila_dump;

    localparam integer CLK_HALF = 10;          // 50 MHz

    reg clk = 1'b0;
    always #CLK_HALF clk = ~clk;

    reg rst_n = 1'b0;

    // ---- DUT 接口 ----
    reg         init_done = 1'b0;
    reg  [12:0] i_vts     = 13'd900;
    reg  [15:0] i_cap_val = 16'd4;
    reg         i_cap_upd = 1'b0;

    wire        o_owner, o_scl, o_sda_out, o_sda_oe;
    wire [2:0]  o_done_cnt, o_ack_cnt;
    wire        o_patch_done;

    wire        cam_sda;                       // pad（开漏 + 上拉）
    pullup(cam_sda);

    // 主机：owner=1 且 oe=1 时推挽驱动 pad（与 display_path 的 mux 同构）
    wire mst_drv   = (o_owner === 1'b1) && (o_sda_oe === 1'b1);
    // 从机：第 9 位（oe=0 且 owner=1）拉低（开漏应答）
    wire slave_drv = (o_owner === 1'b1) && (o_sda_oe === 1'b0);
    assign cam_sda = mst_drv   ? o_sda_out : 1'bz;
    assign cam_sda = slave_drv ? 1'b0      : 1'bz;

    sccb_patch #(
        .EN            (1'b1),
        .EXP_CAP_LINES (16'h1710),
        .EXP_CAP_MAX   (16'h1710),
        .EXP_CAP_MIN   (16'd4),
        .CAP_FROM_VTS  (1'b0),
        .CAP_FROM_CMD  (1'b1)
    ) u_dut (
        .clk          (clk),
        .rst_n        (rst_n),
        .init_done    (init_done),
        .i_vts        (i_vts),
        .i_cap_val    (i_cap_val),
        .i_cap_upd    (i_cap_upd),
        .i_dri_scl    (1'b1),
        .i_dri_sda    (1'b1),
        .i_sda        (cam_sda),
        .o_owner      (o_owner),
        .o_scl        (o_scl),
        .o_sda_out    (o_sda_out),
        .o_sda_oe     (o_sda_oe),
        .o_done_cnt   (o_done_cnt),
        .o_ack_cnt    (o_ack_cnt),
        .o_patch_done (o_patch_done)
    );

    // ---- 观测寄存器（与 display_path 的观测 bundle 同构）----
    reg dbg_sda_pad_r = 1'b1;
    reg dbg_capupd_s1 = 1'b0, dbg_capupd_s2 = 1'b0;
    reg [2:0] dbg_done_d = 3'd0;
    wire dbg_txn_mark = (o_done_cnt != dbg_done_d);
    always @(posedge clk) begin
        dbg_sda_pad_r <= cam_sda;
        dbg_capupd_s1 <= i_cap_upd;
        dbg_capupd_s2 <= dbg_capupd_s1;
        dbg_done_d    <= o_done_cnt;
    end

    // ========================================================================
    // ★ 正向对照档 P2（MAN_EXP_EN=1）：4 条上限 + 3 条手动曝光
    //   cap=4 ⇒ 0x3503=0x01（AEC 手动）+ 0x3501=0x00 + 0x3502=0x40（4 行曝光）
    // ========================================================================
    reg         init_done_p2 = 1'b0;
    wire        p2_owner, p2_scl, p2_sda_out, p2_sda_oe;
    wire [2:0]  p2_done_cnt, p2_ack_cnt;
    wire        p2_patch_done;
    wire        p2_sda;
    pullup(p2_sda);
    wire p2_mst_drv   = (p2_owner === 1'b1) && (p2_sda_oe === 1'b1);
    wire p2_slave_drv = (p2_owner === 1'b1) && (p2_sda_oe === 1'b0);
    assign p2_sda = p2_mst_drv   ? p2_sda_out : 1'bz;
    assign p2_sda = p2_slave_drv ? 1'b0       : 1'bz;

    sccb_patch #(
        .EN            (1'b1),
        .EXP_CAP_LINES (16'h1710),
        .EXP_CAP_MAX   (16'h1710),
        .EXP_CAP_MIN   (16'd4),
        .CAP_FROM_VTS  (1'b0),
        .CAP_FROM_CMD  (1'b1),
        .WR_AEC_CTRL   (1'b0),
        .MAN_EXP_EN    (1'b1)
    ) u_dut_p2 (
        .clk          (clk),
        .rst_n        (rst_n),
        .init_done    (init_done_p2),
        .i_vts        (13'd900),
        .i_cap_val    (16'd4),
        .i_cap_upd    (1'b0),
        .i_dri_scl    (1'b1),
        .i_dri_sda    (1'b1),
        .i_sda        (p2_sda),
        .o_owner      (p2_owner),
        .o_scl        (p2_scl),
        .o_sda_out    (p2_sda_out),
        .o_sda_oe     (p2_sda_oe),
        .o_done_cnt   (p2_done_cnt),
        .o_ack_cnt    (p2_ack_cnt),
        .o_patch_done (p2_patch_done)
    );

    integer fd2;
    integer nsamp2 = 0;
    initial begin
        fd2 = $fopen("sccb_ila_dump_p2.csv", "w");
        $fwrite(fd2, "\"patch_owner\",\"patch_scl\",\"dbg_sda_pad_r\",\"patch_sda_oe\",\"patch_sda\",");
        $fwrite(fd2, "\"dri_scl\",\"cam_init_done_w\",\"patch_done\",\"dbg_capupd_s2\",\"dbg_txn_mark\",");
        $fwrite(fd2, "\"patch_done_cnt\",\"patch_ack_cnt\",\"i_exp_cap_val\"
");
        $fwrite(fd2, "Radix - HEX
");
    end
    always @(posedge clk) begin
        if (fd2 != 0) begin
            $fwrite(fd2, "%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%04x
",
                    p2_owner, p2_scl, p2_sda, p2_sda_oe, p2_sda_out,
                    1'b1, init_done_p2, p2_patch_done, 1'b0, (p2_done_cnt != 3'd0),
                    p2_done_cnt, p2_ack_cnt, 16'd4);
            nsamp2 = nsamp2 + 1;
        end
    end

    integer fd;

    integer nsamp = 0;
    initial begin
        fd = $fopen("sccb_ila_dump.csv", "w");
        $fwrite(fd, "\"patch_owner\",\"patch_scl\",\"dbg_sda_pad_r\",\"patch_sda_oe\",\"patch_sda\",");
        $fwrite(fd, "\"dri_scl\",\"cam_init_done_w\",\"patch_done\",\"dbg_capupd_s2\",\"dbg_txn_mark\",");
        $fwrite(fd, "\"patch_done_cnt\",\"patch_ack_cnt\",\"i_exp_cap_val\"\n");
        $fwrite(fd, "Radix - HEX\n");
    end

    // ========================================================================
    // ★ 实验档 P1（WR_AEC_CTRL=1）：先写 0x3A00=0x7C，再写 4 条上限
    //   目的：① 验证 RTL 真的多写一条 0x3A00 事务（离线解码器解出 5 条）
    //         ② 给"上板 P1 位流"提供仿真对照（板上用 ILA 抓同一条序列）
    // ========================================================================
    reg         init_done_p1 = 1'b0;
    reg  [15:0] i_cap_val_p1 = 16'd4;
    wire        p1_owner, p1_scl, p1_sda_out, p1_sda_oe;
    wire [2:0]  p1_done_cnt, p1_ack_cnt;
    wire        p1_patch_done;
    wire        p1_sda;
    pullup(p1_sda);
    wire p1_mst_drv   = (p1_owner === 1'b1) && (p1_sda_oe === 1'b1);
    wire p1_slave_drv = (p1_owner === 1'b1) && (p1_sda_oe === 1'b0);
    assign p1_sda = p1_mst_drv   ? p1_sda_out : 1'bz;
    assign p1_sda = p1_slave_drv ? 1'b0       : 1'bz;

    sccb_patch #(
        .EN            (1'b1),
        .EXP_CAP_LINES (16'h1710),
        .EXP_CAP_MAX   (16'h1710),
        .EXP_CAP_MIN   (16'd4),
        .CAP_FROM_VTS  (1'b0),
        .CAP_FROM_CMD  (1'b1),
        .WR_AEC_CTRL   (1'b1),
        .AEC_CTRL_VAL  (8'h7c)
    ) u_dut_p1 (
        .clk          (clk),
        .rst_n        (rst_n),
        .init_done    (init_done_p1),
        .i_vts        (13'd900),
        .i_cap_val    (i_cap_val_p1),
        .i_cap_upd    (1'b0),
        .i_dri_scl    (1'b1),
        .i_dri_sda    (1'b1),
        .i_sda        (p1_sda),
        .o_owner      (p1_owner),
        .o_scl        (p1_scl),
        .o_sda_out    (p1_sda_out),
        .o_sda_oe     (p1_sda_oe),
        .o_done_cnt   (p1_done_cnt),
        .o_ack_cnt    (p1_ack_cnt),
        .o_patch_done (p1_patch_done)
    );

    integer fd1;
    integer nsamp1 = 0;
    initial begin
        fd1 = $fopen("sccb_ila_dump_p1.csv", "w");
        $fwrite(fd1, "\"patch_owner\",\"patch_scl\",\"dbg_sda_pad_r\",\"patch_sda_oe\",\"patch_sda\",");
        $fwrite(fd1, "\"dri_scl\",\"cam_init_done_w\",\"patch_done\",\"dbg_capupd_s2\",\"dbg_txn_mark\",");
        $fwrite(fd1, "\"patch_done_cnt\",\"patch_ack_cnt\",\"i_exp_cap_val\"\n");
        $fwrite(fd1, "Radix - HEX\n");
    end
    always @(posedge clk) begin
        if (fd1 != 0) begin
            $fwrite(fd1, "%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%04x\n",
                    p1_owner, p1_scl, p1_sda, p1_sda_oe, p1_sda_out,
                    1'b1, init_done_p1, p1_patch_done, 1'b0, (p1_done_cnt != 3'd0),
                    p1_done_cnt, p1_ack_cnt, i_cap_val_p1);
            nsamp1 = nsamp1 + 1;
        end
    end

    always @(posedge clk) begin
        if (fd != 0) begin
            $fwrite(fd, "%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%01x,%04x\n",
                    o_owner, o_scl, dbg_sda_pad_r, o_sda_oe, o_sda_out,
                    1'b1, init_done, o_patch_done, dbg_capupd_s2, dbg_txn_mark,
                    o_done_cnt, o_ack_cnt, i_cap_val);
            nsamp = nsamp + 1;
        end
    end

    // ---- 激励 ----
    // 时间线（clk 周期 20 ns）：
    //   0        : 复位
    //   200 ns   : 释放复位
    //   1 us     : init_done 上升沿（武装）→ 第 1 轮：cap=4
    //   3000 us  : 改 cap=5904 + toggle（重触发）→ 第 2 轮
    //   6000 us  : 收尾
    initial begin
        rst_n = 1'b0;
        repeat (10) @(posedge clk);
        rst_n = 1'b1;

        repeat (45) @(posedge clk);
        init_done = 1'b1;                       // 武装第 1 轮

        // ★ P1 实例：稍后武装（避免两个实例的波形完全重叠，便于解码对照）
        repeat (100) @(posedge clk);
        init_done_p1 = 1'b1;                    // P1 单轮（cap=4 + 0x3A00=0x7C）
        repeat (100) @(posedge clk);
        init_done_p2 = 1'b1;                    // P2 单轮（cap=4 + 手动曝光 4 行）

        #3_000_000;                             // 等第 1 轮跑完（~612 us）→ 3 ms
        @(posedge clk);
        i_cap_val = 16'h1710;
        i_cap_upd = ~i_cap_upd;                 // ★ toggle 语义：翻转并保持（一次写入 = 一次翻转）

        #3_000_000;
        repeat (10) @(posedge clk);
        $display("DUMP_DONE samples=%0d done_cnt=%0d ack_cnt=%0d patch_done=%b",
                 nsamp, o_done_cnt, o_ack_cnt, o_patch_done);
        $display("DUMP_P1 samples=%0d done_cnt=%0d ack_cnt=%0d patch_done=%b",
                 nsamp1, p1_done_cnt, p1_ack_cnt, p1_patch_done);
        $display("DUMP_P2 samples=%0d done_cnt=%0d ack_cnt=%0d patch_done=%b",
                 nsamp2, p2_done_cnt, p2_ack_cnt, p2_patch_done);
        if (o_done_cnt == 3'd4) $display("CHECK=DUMP_done_cnt_4 PASS");
        else                    $display("CHECK=DUMP_done_cnt_4 FAIL (got %0d)", o_done_cnt);
        if (o_ack_cnt == 3'd4)  $display("CHECK=DUMP_ack_cnt_4 PASS");
        else                    $display("CHECK=DUMP_ack_cnt_4 FAIL (got %0d)", o_ack_cnt);
        if (o_patch_done === 1'b1) $display("CHECK=DUMP_patch_done PASS");
        else                       $display("CHECK=DUMP_patch_done FAIL");
        // 第二轮（重触发）后 done_cnt/ack_cnt 会从 0 重新计到 4 ⇒ 仍应为 4
        if ((o_done_cnt == 3'd4) && (o_ack_cnt == 3'd4) && (o_patch_done === 1'b1))
            $display("TEST_RESULT=PASS");
        else
            $display("TEST_RESULT=FAIL");
        $fclose(fd);
        fd = 0;
        $fclose(fd1);
        fd1 = 0;
        $fclose(fd2);
        fd2 = 0;
        $finish;
    end

    initial begin
        #20_000_000;                             // 20 ms 看门狗
        $display("DUMP_WATCHDOG samples=%0d", nsamp);
        if (fd != 0) $fclose(fd);
        $finish;
    end

endmodule
