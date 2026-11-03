//==============================================================================
// tb_uart_telemetry.v —— uart_telemetry 单模块仿真
//
// 判据（文档 §8 V1~V4 + WP-D 补充）：
//   V1  帧格式正确：起始位/停止位无错（TB 独立 UART 接收器，1.5 位中点采样）
//   V2  遥测帧头 AA 55 54 4D 正确
//   V3  16 字节载荷与喂入的统计量逐字节一致（大端）
//   V4  CRC8（poly 0x07/init 0x00）正确，覆盖帧头 4 B + 载荷 16 B
//   V5  ASCII 行与 TB 独立算出的期望字符串逐字节一致（含大数/前导零）
//   V6  波特率正确：实测字节周期 = 10 位 × 1085.069 ns（±1.5%）
//   V7  收到 'B' 命令立即补发一帧（RX 16× 过采样通路可用）
//   V8  统计量变化后，后续帧的载荷/ASCII 同步更新
//
// 说明：为缩短仿真时间，本 TB 用 TELEM_PERIOD_MS=1（默认 250 ms 只是计数器常量，
//       机制相同）；另有一个默认参数实例，确认默认参数可正常 elaborate。
//==============================================================================
`timescale 1ns / 1ps

module tb_uart_telemetry;

    //--------------------------------------------------------------------------
    // 时钟 / 复位（clk_cam = 50 MHz）
    //--------------------------------------------------------------------------
    reg clk = 1'b0;
    always #10 clk = ~clk;

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    localparam real BIT_NS = 1085.069;      // 1/921600 s

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    reg  [23:0] st_ev  = 24'd100;
    reg  [15:0] st_act = 16'd32768;
    reg  [23:0] st_cr  = 24'd876;
    reg  [31:0] st_fr  = 32'd1;
    reg         st_mode= 1'b1;
    reg  [3:0]  st_key = 4'h5;
    reg         st_en  = 1'b1;

    reg         rxd_line = 1'b1;
    wire        txd;

    uart_telemetry #(
        .CLK_HZ          (50000000),
        .BAUD            (921600),
        .OS              (16),
        .TELEM_PERIOD_MS (1),
        .CRC8_POLY       (8'h07),
        .ASCII_TELEM     (1)
    ) dut (
        .clk_cam            (clk),
        .rst_n_cam          (rst_n),
        .uart_rxd           (rxd_line),
        .uart_txd           (txd),
        .i_stat_ev_per_frame(st_ev),
        .i_stat_activity_q16(st_act),
        .i_stat_cr_x10      (st_cr),
        .i_stat_frame_cnt   (st_fr),
        .i_stat_mode        (st_mode),
        .i_key_pressed      (st_key),
        .i_cfg_ev_en        (st_en)
    );

    wire txd_def;
    uart_telemetry u_def (                  // 默认参数实例（只做 elaborate 检查）
        .clk_cam(clk), .rst_n_cam(rst_n), .uart_rxd(1'b1), .uart_txd(txd_def),
        .i_stat_ev_per_frame(24'd0), .i_stat_activity_q16(16'd0), .i_stat_cr_x10(24'd0),
        .i_stat_frame_cnt(32'd0), .i_stat_mode(1'b0), .i_key_pressed(4'd0),
        .i_cfg_ev_en(1'b0)
    );

    //--------------------------------------------------------------------------
    // TB 侧独立 UART 接收器
    //--------------------------------------------------------------------------
    reg  [7:0] rxq [0:1023];
    integer    nbyte  = 0;
    integer    rx_err = 0;
    time       t_start [0:1023];

    integer i;
    reg [7:0] db;

    initial begin : rx_proc
        forever begin
            @(negedge txd);
            #(BIT_NS * 1.5);
            for (i = 0; i < 8; i = i + 1) begin
                db[i] = txd;
                #(BIT_NS);
            end
            if (txd !== 1'b1) rx_err = rx_err + 1;   // 停止位检查（此刻在停止位中点）
            if (nbyte < 1024) begin
                rxq[nbyte]     = db;
                t_start[nbyte] = $time - (BIT_NS * 9.5);
                nbyte          = nbyte + 1;
            end
        end
    end

    //--------------------------------------------------------------------------
    // TB 侧 UART 发送（给 DUT 发 'B'）
    //--------------------------------------------------------------------------
    task tb_send; input [7:0] b; integer k; begin
        rxd_line = 1'b0; #(BIT_NS);
        for (k = 0; k < 8; k = k + 1) begin
            rxd_line = b[k]; #(BIT_NS);
        end
        rxd_line = 1'b1; #(BIT_NS);
    end endtask

    //--------------------------------------------------------------------------
    // TB 侧十进制格式化（用"试减 10 的幂"，与 DUT 的串行除法是不同实现）
    //--------------------------------------------------------------------------
    reg [7:0] exp_buf [0:255];
    integer   exp_len = 0;

    task put_ch; input [7:0] c; begin exp_buf[exp_len] = c; exp_len = exp_len + 1; end endtask

    task put_dec; input [31:0] v;
        integer k; reg [31:0] p; integer started; reg [7:0] dig; reg [31:0] vv;
        begin
            vv = v; started = 0; p = 32'd1000000000;
            for (k = 0; k < 10; k = k + 1) begin
                dig = 8'd0;
                while (vv >= p) begin vv = vv - p; dig = dig + 8'd1; end
                if ((dig != 8'd0) || (started != 0) || (k == 9)) begin
                    put_ch(8'h30 + dig);
                    started = 1;
                end
                p = p / 32'd10;
            end
        end
    endtask

    task build_exp; begin
        exp_len = 0;
        put_ch(8'h54); put_ch(8'h20); put_ch(8'h66); put_ch(8'h72); put_ch(8'h3D);
        put_dec(st_fr);
        put_ch(8'h20); put_ch(8'h65); put_ch(8'h76); put_ch(8'h3D);
        put_dec({8'b0, st_ev});
        put_ch(8'h20); put_ch(8'h61); put_ch(8'h63); put_ch(8'h74); put_ch(8'h3D);
        put_dec({16'b0, st_act});
        put_ch(8'h20); put_ch(8'h63); put_ch(8'h72); put_ch(8'h3D);
        put_dec({8'b0, st_cr});
        put_ch(8'h20); put_ch(8'h6D); put_ch(8'h6F); put_ch(8'h64); put_ch(8'h65); put_ch(8'h3D);
        put_dec({31'b0, st_mode});
        put_ch(8'h20); put_ch(8'h6B); put_ch(8'h65); put_ch(8'h79); put_ch(8'h3D);
        put_dec({28'b0, st_key});
        put_ch(8'h20); put_ch(8'h65); put_ch(8'h6E); put_ch(8'h3D);
        put_dec({31'b0, st_en});
        put_ch(8'h0D); put_ch(8'h0A);
    end endtask

    //--------------------------------------------------------------------------
    // 期望载荷 / CRC8
    //--------------------------------------------------------------------------
    function [7:0] crc8f;
        input [7:0] crc;
        input [7:0] dat;
        integer j;
        reg [7:0] c;
        begin
            c = crc ^ dat;
            for (j = 0; j < 8; j = j + 1)
                c = c[7] ? ((c << 1) ^ 8'h07) : (c << 1);
            crc8f = c;
        end
    endfunction

    function [7:0] exp_pay; input [3:0] k; begin
        case (k)
            4'd0 : exp_pay = st_fr[31:24];
            4'd1 : exp_pay = st_fr[23:16];
            4'd2 : exp_pay = st_fr[15:8];
            4'd3 : exp_pay = st_fr[7:0];
            4'd4 : exp_pay = st_ev[23:16];
            4'd5 : exp_pay = st_ev[15:8];
            4'd6 : exp_pay = st_ev[7:0];
            4'd7 : exp_pay = st_act[15:8];
            4'd8 : exp_pay = st_act[7:0];
            4'd9 : exp_pay = st_cr[23:16];
            4'd10: exp_pay = st_cr[15:8];
            4'd11: exp_pay = st_cr[7:0];
            4'd12: exp_pay = {7'b0, st_mode};
            4'd13: exp_pay = {4'b0, st_key};
            4'd14: exp_pay = {7'b0, st_en};
            default: exp_pay = 8'h01;
        endcase
    end endfunction

    //--------------------------------------------------------------------------
    // 找帧：最后一个"帧 + 完整 ASCII 行"都在缓冲里的帧起点
    //--------------------------------------------------------------------------
    function integer find_last_frame;
        input integer dummy;                // Verilog-2001 函数至少要有 1 个输入
        integer j, m, found;
        begin
            found = -1;
            for (j = 0; j <= (nbyte - 22); j = j + 1) begin
                if (rxq[j] === 8'hAA && rxq[j+1] === 8'h55 &&
                    rxq[j+2] === 8'h54 && rxq[j+3] === 8'h4D) begin
                    m = 0;
                    while ((m < 200) && ((j + 21 + m) < nbyte) && (rxq[j+21+m] !== 8'h0A))
                        m = m + 1;
                    if ((m < 200) && ((j + 21 + m) < nbyte)) found = j;
                end
            end
            find_last_frame = found;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 检查一帧
    //--------------------------------------------------------------------------
    integer jj, alen, ok;
    reg [7:0] crc_c;

    task check_frame; input integer b0; input [8*32-1:0] tag;
        begin
            if (b0 < 0) begin
                chk_fail({tag, "_found"});
            end
            else begin
                chk_pass({tag, "_found"});

                // V2 帧头
                if (rxq[b0] === 8'hAA && rxq[b0+1] === 8'h55 &&
                    rxq[b0+2] === 8'h54 && rxq[b0+3] === 8'h4D) chk_pass({tag, "_hdr"});
                else begin
                    chk_fail({tag, "_hdr"});
                    $display("  [E] hdr=%02x %02x %02x %02x", rxq[b0], rxq[b0+1], rxq[b0+2], rxq[b0+3]);
                end

                // V3 载荷
                ok = 1;
                for (jj = 0; jj < 16; jj = jj + 1)
                    if (rxq[b0+4+jj] !== exp_pay(jj[3:0])) begin
                        if (ok != 0) $display("  [E] payload[%0d] got=%02x exp=%02x",
                                              jj, rxq[b0+4+jj], exp_pay(jj[3:0]));
                        ok = 0;
                    end
                if (ok != 0) chk_pass({tag, "_payload"}); else chk_fail({tag, "_payload"});

                // V4 CRC8（覆盖前 20 字节）
                crc_c = 8'h00;
                for (jj = 0; jj < 20; jj = jj + 1) crc_c = crc8f(crc_c, rxq[b0+jj]);
                if (crc_c === rxq[b0+20]) chk_pass({tag, "_crc8"});
                else begin
                    chk_fail({tag, "_crc8"});
                    $display("  [E] CRC8 calc=%02x got=%02x", crc_c, rxq[b0+20]);
                end

                // V5 ASCII 行
                alen = 0;
                while ((alen < 200) && (rxq[b0+21+alen] !== 8'h0A)) alen = alen + 1;
                alen = alen + 1;                       // 含 \n
                build_exp;
                if (alen !== exp_len) begin
                    chk_fail({tag, "_ascii_len"});
                    $display("  [E] ascii 长度 got=%0d exp=%0d", alen, exp_len);
                end
                else begin
                    ok = 1;
                    for (jj = 0; jj < alen; jj = jj + 1)
                        if (rxq[b0+21+jj] !== exp_buf[jj]) begin
                            if (ok != 0) $display("  [E] ascii[%0d] got=%02x exp=%02x",
                                                  jj, rxq[b0+21+jj], exp_buf[jj]);
                            ok = 0;
                        end
                    if (ok != 0) chk_pass({tag, "_ascii"}); else chk_fail({tag, "_ascii"});
                end
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 有界等待（不用 fork/join）
    //--------------------------------------------------------------------------
    integer guard;
    task wait_bytes; input integer n; begin
        guard = 0;
        while ((nbyte < n) && (guard < 3000000)) begin
            @(posedge clk);
            guard = guard + 1;
        end
    end endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer n_before, b0;
    real    byte_ns;

    initial begin
        repeat (8) @(negedge clk);
        rst_n <= 1'b1;
        repeat (4) @(negedge clk);

        //======================================================================
        // 测试 1：周期遥测
        //======================================================================
        wait_bytes(90);
        b0 = find_last_frame(0);
        check_frame(b0, "T1_periodic");

        //======================================================================
        // 测试 2：'B' 命令立即补发
        //======================================================================
        n_before = nbyte;
        tb_send(8'h42);                     // 'B'
        wait_bytes(n_before + 90);
        b0 = find_last_frame(0);
        check_frame(b0, "T2_cmd_B");

        //======================================================================
        // 测试 3：统计量变化 → 后续帧同步更新（大数/零值/前导零）
        //======================================================================
        st_fr   <= 32'd123456789;
        st_ev   <= 24'd16777215;
        st_act  <= 16'd65535;
        st_cr   <= 24'd0;
        st_mode <= 1'b0;
        st_key  <= 4'hF;
        st_en   <= 1'b0;
        n_before = nbyte;
        wait_bytes(n_before + 200);         // ≥2 帧
        b0 = find_last_frame(0);
        check_frame(b0, "T3_updated");

        $display("INFO nbyte=%0d rx_err=%0d", nbyte, rx_err);

        // V1 帧格式（起始/停止位）
        if (rx_err == 0) chk_pass("V1_framing_ok"); else chk_fail("V1_framing_ok");

        // V6 波特率：相邻起始位间隔 = 10 位时间（期望 10850.7 ns，±1.5%）
        if (nbyte >= 40) begin
            byte_ns = (t_start[30] - t_start[10]) / 20.0;
            if ((byte_ns > 10688.0) && (byte_ns < 11013.0)) chk_pass("V6_baud_rate");
            else begin
                chk_fail("V6_baud_rate");
                $display("  [E] 字节周期实测 %0.1f ns（期望 10850.7）", byte_ns);
            end
        end
        else chk_fail("V6_baud_rate");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #12000000;                          // 12 ms 上限
        $display("TEST_RESULT=FAIL (timeout) nbyte=%0d", nbyte);
        $finish;
    end

endmodule
