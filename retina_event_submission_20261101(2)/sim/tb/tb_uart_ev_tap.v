//==============================================================================
// tb_uart_ev_tap.v —— uart_ev_tap 单模块仿真（WIRE-U1 §3/§6，判据①RAW/GRID/CRC）
//
// 判据：
//   E1  RAW 档字节序列：289 条满包 ⇒ 24 B 头逐字段 + 289×5 记录逐字节 + CRC16
//   E2  DECIM=4 均匀抽点：12 事件 ⇒ 3 条（保持"每 N 条取第 N 条"语义）
//   E3  EV_RES 坐标量化：RES=1 → x>>1/y>>1（RES=2 同理）
//   E4  GRID 8×6：块心坐标 + {计数[6:0],POL} + FIRST/LAST + CRC
//   E5  GRID 16×12 每 4 帧：前 3 个帧边界不发，第 4 个边界发；块心 25/20 网格
//   E6  恒定带宽：事件率 ×10（48 → 480 条）时帧字节数不变（48 条记录）
//   E7  MODE=1 不发事件帧
//   E8  满包 FLAGS.LAST=0 / 看门狗短帧 LAST=1；FIRST 每相机帧只置一次
//
// 注：为缩短仿真，CLK_HZ=1 MHz（US_DIV=1，µs 计数每拍 +1）——周期数与
//     50 MHz 真设计**逐拍一致**（看门狗/帧计数全是拍计数），仿真快 50×。
//==============================================================================
`timescale 1ns / 1ps

module tb_uart_ev_tap;

    localparam CLK_HZ = 1_000_000;
    reg clk = 1'b0;
    always #500 clk = ~clk;             // 1 µs 周期

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    reg         i_ev_valid = 1'b0;
    reg  [8:0]  i_ev_x = 9'd0;
    reg  [7:0]  i_ev_y = 8'd0;
    reg         i_ev_pol = 1'b0;
    reg  [31:0] i_frame_cnt = 32'd0;
    reg  [1:0]  i_mode = 2'd0;
    reg         i_ev_en = 1'b1;
    reg  [7:0]  i_ser_decim = 8'd32;
    reg  [1:0]  i_ev_res = 2'd0;
    reg  [1:0]  i_ser_agg = 2'd0;
    reg  [15:0] i_ser_flush_ms = 16'd20;

    wire        o_frdy, o_fbusy, o_fvalid;
    wire [7:0]  o_fdata;
    reg         i_fack = 1'b0, i_fstart = 1'b0;
    wire [7:0]  o_stat_drop;

    uart_ev_tap #(
        .CLK_HZ      (CLK_HZ),
        .EV_MAX_PACK (289)
    ) dut (
        .clk             (clk),
        .rst_n           (rst_n),
        .i_ev_valid      (i_ev_valid),
        .i_ev_x          (i_ev_x),
        .i_ev_y          (i_ev_y),
        .i_ev_pol        (i_ev_pol),
        .i_frame_cnt     (i_frame_cnt),
        .i_mode          (i_mode),
        .i_ev_en         (i_ev_en),
        .i_ser_decim     (i_ser_decim),
        .i_ev_res        (i_ev_res),
        .i_ser_agg       (i_ser_agg),
        .i_ser_flush_ms  (i_ser_flush_ms),
        .o_frdy          (o_frdy),
        .o_fbusy         (o_fbusy),
        .o_fvalid        (o_fvalid),
        .o_fdata         (o_fdata),
        .i_fack          (i_fack),
        .i_fstart        (i_fstart),
        .o_stat_drop     (o_stat_drop)
    );

    //--------------------------------------------------------------------------
    // 帧字节捕获
    //--------------------------------------------------------------------------
    reg [7:0] rx [0:8191];
    integer   nrx = 0;

    //--------------------------------------------------------------------------
    // 工具任务
    //--------------------------------------------------------------------------
    integer g;

    task new_frame_edge; begin
        i_frame_cnt <= i_frame_cnt + 32'd1;
        repeat (4000) @(posedge clk);      // 间隔 > 一次封帧（AGG=2 扫 192 块 ~1400 拍）
    end endtask

    task send_ev; input [8:0] x; input [7:0] y; input p; begin
        @(negedge clk);
        i_ev_valid <= 1'b1;
        i_ev_x     <= x;
        i_ev_y     <= y;
        i_ev_pol   <= p;
        @(negedge clk);
        i_ev_valid <= 1'b0;
        repeat (9) @(negedge clk);       // FIFO + PE（2~6 拍）排空
    end endtask

    task wait_ready; input [8*48-1:0] nm; input integer maxcyc;
        begin
            g = 0;
            while ((o_frdy !== 1'b1) && (g < maxcyc)) begin
                @(posedge clk); g = g + 1;
            end
            if (o_frdy !== 1'b1) begin
                chk_fail(nm);
                $display("  [E] o_frdy 超时（%0d 拍）", maxcyc);
            end
            else chk_pass(nm);
        end
    endtask

    task fetch_frame; input integer maxb;
        begin
            nrx = 0;
            @(negedge clk);
            i_fstart <= 1'b1;
            @(negedge clk);
            i_fstart <= 1'b0;
            g = 0;
            while ((g < 400000) && (nrx < maxb)) begin
                @(negedge clk);
                if (o_fvalid === 1'b1) begin
                    rx[nrx] = o_fdata;
                    nrx     = nrx + 1;
                    i_fack  <= 1'b1;
                end
                else i_fack <= 1'b0;
                g = g + 1;
                if ((nrx > 0) && (o_fbusy !== 1'b1) && (o_fvalid !== 1'b1) && (i_fack !== 1'b1))
                    g = 400000;          // 帧结束
            end
            @(negedge clk);
            i_fack <= 1'b0;
        end
    endtask

    //--------------------------------------------------------------------------
    // 独立 CRC16 / 期望帧构造
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

    // 校验一帧的公共头部/CRC（返回 EV_LEN）
    reg [15:0] evlen_g;
    reg [15:0] crc_c, crc_e;

    task check_common; input [8*48-1:0] tag; begin
        crc_c = 16'hFFFF;
        for (g = 0; g < (24 + evlen_g); g = g + 1) crc_c = crc16f(crc_c, rx[g]);
        crc_e = {rx[24+evlen_g], rx[25+evlen_g]};
        // 魔数/VER/HDR_LEN
        if ((rx[0]===8'hF0) && (rx[1]===8'h5A) && (rx[2]===8'hA5) && (rx[3]===8'h30) &&
            (rx[4]===8'h03) && (rx[5]===8'h18)) chk_pass({tag, "_magic_ver"});
        else begin
            chk_fail({tag, "_magic_ver"});
            $display("  [E] hdr=%02x %02x %02x %02x %02x %02x", rx[0],rx[1],rx[2],rx[3],rx[4],rx[5]);
        end
        // EV_REC_BYTES / RSVD / RAW_LEN / CHUNK_IDX
        if ((rx[22]===8'h05) && (rx[23]===8'h00) && (rx[12]===8'h00) && (rx[13]===8'h00) &&
            (rx[8]===8'h00) && (rx[9]===8'h00)) chk_pass({tag, "_evrec_rawlen"});
        else chk_fail({tag, "_evrec_rawlen"});
        // EV_LEN 字段 = 24+evlen 处与长度自洽
        if ({rx[14],rx[15]} === evlen_g) chk_pass({tag, "_evlen_field"});
        else begin
            chk_fail({tag, "_evlen_field"});
            $display("  [E] evlen field=%04x exp=%04x", {rx[14],rx[15]}, evlen_g);
        end
        // TS != 0
        if ({rx[16],rx[17],rx[18],rx[19],rx[20],rx[21]} !== 48'd0) chk_pass({tag, "_ts_nonzero"});
        else chk_fail({tag, "_ts_nonzero"});
        // 尾部 CRC
        if (crc_c === crc_e) chk_pass({tag, "_crc16"});
        else begin
            chk_fail({tag, "_crc16"});
            $display("  [E] crc calc=%04x got=%04x", crc_c, crc_e);
        end
    end endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer i;
    reg [7:0] exp_rec [0:1023];     // 期望记录字节
    reg [8:0] ex_x; reg [7:0] ex_y; reg [6:0] ex_cnt; reg ex_pol;

    initial begin
        repeat (10) @(posedge clk);
        rst_n <= 1'b1;
        repeat (10) @(posedge clk);

        //======================================================================
        // E1：RAW 满包 289 条 —— 头字段 + 全记录 + CRC
        //======================================================================
        i_ser_decim    = 8'd1;
        i_ev_res       = 2'd0;
        i_ser_agg      = 2'd0;
        i_ser_flush_ms = 16'd1000;
        i_mode         = 2'd0;
        new_frame_edge;                     // 帧边界 ⇒ 配置生效
        for (i = 0; i < 289; i = i + 1)
            send_ev(i[8:0] % 400, (i * 7) % 240, i[0]);
        evlen_g = 16'd1445;
        wait_ready("E1_full_frdy", 20000);
        fetch_frame(2000);
        if (nrx === 1471) chk_pass("E1_frame_len");
        else begin
            chk_fail("E1_frame_len");
            $display("  [E] nrx=%0d exp=1471", nrx);
        end
        check_common("E1");
        if (rx[6] === 8'h2E) chk_pass("E1_flags_full");   // FLAGS=0010_1110：FIRST=1（本帧首发）/LAST=0   // FIRST=0(非首帧)/LAST=0/EV/CRC/TS
        else begin
            chk_fail("E1_flags_full");
            $display("  [E] flags=%02x", rx[6]);
        end
        if (rx[7] === 8'h00) chk_pass("E1_mode_byte");
        else chk_fail("E1_mode_byte");
        // FRAME_IDX = 上一帧边界对应的计数（new_frame_edge 后 i_frame_cnt=1）
        if ({rx[10],rx[11]} === 16'd1) chk_pass("E1_frame_idx");
        else begin
            chk_fail("E1_frame_idx");
            $display("  [E] fid=%04x", {rx[10],rx[11]});
        end
        // 289 条记录逐字节
        begin : e1_rec
            integer bad;
            bad = 0;
            for (i = 0; i < 289; i = i + 1) begin
                ex_x = i[8:0] % 400;
                ex_y = (i * 7) % 240;
                if (rx[24+i*5+0] !== ex_x[7:0] || rx[24+i*5+1] !== {7'b0, ex_x[8]} ||
                    rx[24+i*5+2] !== ex_y || rx[24+i*5+3] !== {7'b0, i[0]} ||
                    rx[24+i*5+4] !== 8'h00) begin
                    if (bad == 0) $display("  [E] rec[%0d] got=%02x %02x %02x %02x %02x",
                        i, rx[24+i*5], rx[24+i*5+1], rx[24+i*5+2], rx[24+i*5+3], rx[24+i*5+4]);
                    bad = bad + 1;
                end
            end
            if (bad == 0) chk_pass("E1_records_bytewise");
            else chk_fail("E1_records_bytewise");
        end

        //======================================================================
        // E2：DECIM=4 均匀抽点（12 事件 ⇒ 3 条：第 4/8/12 条）
        //======================================================================
        i_ser_decim    = 8'd4;
        i_ser_flush_ms = 16'd5;             // 5 ms（=5000 拍 @CLK_HZ=1MHz）看门狗
        new_frame_edge;
        for (i = 0; i < 12; i = i + 1)
            send_ev(9'd10 + i[8:0], 8'd50 + i[7:0], 1'b1);
        wait_ready("E2_decim_frdy", 20000);
        fetch_frame(200);
        evlen_g = 16'd15;
        if (nrx === 41) chk_pass("E2_len_41");
        else begin
            chk_fail("E2_len_41");
            $display("  [E] nrx=%0d", nrx);
        end
        check_common("E2");
        // 记录 = 第 4/8/12 条：x=10+3=13, 10+7=17, 10+11=21
        if ((rx[24]===8'd13) && (rx[29]===8'd17) && (rx[34]===8'd21) &&
            (rx[24+4]===8'h00) && (rx[6]===8'h6E))   // FLAGS=0110_1110：FIRST=LAST=1（看门狗短帧）
            chk_pass("E2_decim_pick_and_last");
        else begin
            chk_fail("E2_decim_pick_and_last");
            $display("  [E] x0=%0d x1=%0d x2=%0d flags=%02x", rx[24], rx[29], rx[34], rx[6]);
        end

        //======================================================================
        // E3：EV_RES=1 坐标量化（x,y 各 >>1）
        //======================================================================
        i_ser_decim    = 8'd1;
        i_ev_res       = 2'd1;
        i_ser_flush_ms = 16'd5;
        new_frame_edge;
        send_ev(9'd201, 8'd101, 1'b0);
        send_ev(9'd399, 8'd239, 1'b1);
        wait_ready("E3_res_frdy", 20000);
        fetch_frame(200);
        evlen_g = 16'd10;
        if ((rx[24]===8'd100) && (rx[26]===8'd50) && (rx[29]===8'd199) && (rx[31]===8'd119))
            chk_pass("E3_quant_shift1");
        else begin
            chk_fail("E3_quant_shift1");
            $display("  [E] (%0d,%0d) (%0d,%0d)", rx[24], rx[26], rx[29], rx[31]);
        end
        check_common("E3");

        //======================================================================
        // E4：GRID 8×6（每帧）—— 块心 + 计数 + FIRST/LAST
        //======================================================================
        i_ev_res       = 2'd0;
        i_ser_agg      = 2'd1;
        i_ser_decim    = 8'd1;
        new_frame_edge;                     // AGG 生效
        // 块(0,0)：x<50,y<40 3 条 ON；块(7,5)：x>=350,y>=200 2 条 OFF；块(3,2)：1 条 ON
        send_ev(9'd10, 8'd10, 1'b1);
        send_ev(9'd20, 8'd20, 1'b1);
        send_ev(9'd30, 8'd30, 1'b1);
        send_ev(9'd360, 8'd210, 1'b0);
        send_ev(9'd390, 8'd230, 1'b0);
        send_ev(9'd175, 8'd100, 1'b1);
        new_frame_edge;                     // 帧边界 ⇒ GRID 封帧
        wait_ready("E4_grid_frdy", 20000);
        fetch_frame(400);
        evlen_g = 16'd15;
        if (nrx === 41) chk_pass("E4_len_41");
        else begin
            chk_fail("E4_len_41");
            $display("  [E] nrx=%0d", nrx);
        end
        check_common("E4");
        // 块(0,0) 心 = (25,20)，计数 3，POL=1
        if ((rx[24]===8'd25) && (rx[25]===8'h00) && (rx[26]===8'd20) && (rx[27]===8'h07))
            chk_pass("E4_blk00_center_cnt3_on");
        else begin
            chk_fail("E4_blk00_center_cnt3_on");
            $display("  [E] b0=%02x %02x %02x %02x", rx[24],rx[25],rx[26],rx[27]);
        end
        // 块(3,2) 心 = (175,100)，计数 1
        if ((rx[29]===8'd175) && (rx[31]===8'd100) && (rx[32]===8'h03))
            chk_pass("E4_blk32_center_cnt1_on");
        else begin
            chk_fail("E4_blk32_center_cnt1_on");
            $display("  [E] b1=%02x %02x %02x", rx[29],rx[31],rx[32]);
        end
        // 块(7,5) 心 = (375,220)，计数 2，POL=0
        if ((rx[34]===8'd119) && (rx[35]===8'h01) && (rx[36]===8'd220) && (rx[37]===8'h04))
            chk_pass("E4_blk75_center_cnt2_off");
        else begin
            chk_fail("E4_blk75_center_cnt2_off");
            $display("  [E] b2=%02x %02x %02x %02x", rx[34],rx[35],rx[36],rx[37]);
        end
        if (rx[6] === 8'h6E) chk_pass("E4_flags_first_last");
        else begin
            chk_fail("E4_flags_first_last");
            $display("  [E] flags=%02x", rx[6]);
        end

        //======================================================================
        // E5：GRID 16×12 每 4 帧（首次封帧后窗口相位归零 ⇒ 后续可精确核对）
        //======================================================================
        i_ser_agg   = 2'd2;
        i_ser_decim = 8'd1;
        new_frame_edge;                     // AGG=2 生效
        send_ev(9'd100, 8'd100, 1'b1);      // 块 (4,5) 心 = (4*25+12=112, 5*20+10=110)
        // 相位未知：≤4 个相机帧边界内必封一帧（192 块扫描 ~1400 拍）
        g = 0;
        while ((o_frdy !== 1'b1) && (g < 8)) begin
            new_frame_edge;                 // 每次 4000 拍 > 封帧耗时
            g = g + 1;
        end
        if (o_frdy === 1'b1) chk_pass("E5_agg2_first_within_4");
        else                 chk_fail("E5_agg2_first_within_4");
        fetch_frame(400);
        // 窗口相位已对齐（封帧即 sub_cnt 归零）：每边界 1 条 × 3，第 4 个边界封帧
        send_ev(9'd100, 8'd100, 1'b1);
        new_frame_edge;
        send_ev(9'd101, 8'd101, 1'b1);
        new_frame_edge;
        send_ev(9'd102, 8'd102, 1'b1);
        new_frame_edge;
        repeat (20) @(posedge clk);
        if (o_frdy !== 1'b1) chk_pass("E5_no_frame_before_4th");
        else                 chk_fail("E5_no_frame_before_4th");
        new_frame_edge;                     // 第 4 个边界 ⇒ 封帧
        wait_ready("E5_agg2_frdy", 20000);
        fetch_frame(400);
        evlen_g = 16'd5;
        check_common("E5");
        if ((rx[24]===8'd112) && (rx[26]===8'd110) && (rx[27]===8'h07))
            chk_pass("E5_agg2_center_cnt3");   // {count=3, POL=1}
        else begin
            chk_fail("E5_agg2_center_cnt3");
            $display("  [E] agg2=%02x %02x %02x %02x", rx[24],rx[25],rx[26],rx[27]);
        end

        //======================================================================
        // E6：恒定带宽（AGG=1）：48 条事件（每块 1 条） vs 480 条（每块 10 条）
        //======================================================================
        i_ser_agg   = 2'd1;
        new_frame_edge;
        begin : e6a
            integer bx, by;
            for (by = 0; by < 6; by = by + 1)
                for (bx = 0; bx < 8; bx = bx + 1)
                    send_ev(bx*50 + 5, by*40 + 5, 1'b1);
        end
        new_frame_edge;
        wait_ready("E6a_frdy", 20000);
        fetch_frame(400);
        begin : e6_chk
            integer n1, n2;
            n1 = nrx;
            // 第二组：每块 10 条
            new_frame_edge;
            begin : e6b
                integer bx2, by2, k2;
                for (by2 = 0; by2 < 6; by2 = by2 + 1)
                    for (bx2 = 0; bx2 < 8; bx2 = bx2 + 1)
                        for (k2 = 0; k2 < 10; k2 = k2 + 1)
                            send_ev(bx2*50 + k2*3, by2*40 + k2, 1'b1);
            end
            new_frame_edge;
            wait_ready("E6b_frdy", 40000);
            fetch_frame(400);
            n2 = nrx;
            if ((n1 === 266) && (n2 === 266)) chk_pass("E6_constant_bandwidth");
            else begin
                chk_fail("E6_constant_bandwidth");
                $display("  [E] n1=%0d n2=%0d（应 48 条记录 = 266 B）", n1, n2);
            end
            // 480 条事件那帧的第 1 条记录计数应为 10
            if (rx[27] === 8'h15) chk_pass("E6_count_saturates_to_10");
            else begin
                chk_fail("E6_count_saturates_to_10");
                $display("  [E] cnt=%02x", rx[27]);
            end
        end

        //======================================================================
        // E7：MODE=1 不发事件帧
        //======================================================================
        i_mode      = 2'd1;
        i_ser_agg   = 2'd0;
        i_ser_decim = 8'd1;
        i_ser_flush_ms = 16'd5;
        new_frame_edge;
        for (i = 0; i < 300; i = i + 1)
            send_ev(i[8:0] % 400, (i) % 240, 1'b1);   // 超过满包阈值
        repeat (12000) @(posedge clk);                 // 超过看门狗 5 ms
        if (o_frdy !== 1'b1) chk_pass("E7_mode1_no_frame");
        else chk_fail("E7_mode1_no_frame");

        //======================================================================
        // E8：恢复 + 下一满包 LAST=0 & FIRST=1（同相机帧内首发）
        //======================================================================
        i_mode <= 2'd0;
        repeat (4) @(posedge clk);
        new_frame_edge;
        for (i = 0; i < 289; i = i + 1)
            send_ev(i[8:0] % 400, (i * 3) % 240, 1'b0);
        wait_ready("E8_frdy", 20000);
        fetch_frame(2000);
        if (rx[6] === 8'h2E) chk_pass("E8_flags_first_not_last");
        else begin
            chk_fail("E8_flags_first_not_last");
            $display("  [E] flags=%02x", rx[6]);
        end

        $display("INFO nrx=%0d drop=%0d", nrx, o_stat_drop);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #200000000;                         // 200 ms 仿真上限
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
