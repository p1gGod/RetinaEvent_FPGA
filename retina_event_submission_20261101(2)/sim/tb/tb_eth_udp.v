//==============================================================================
// tb_eth_udp.v —— eth_udp 协议级仿真（厂家栈用行为级替身 eth_top_sim_model.v）
//
// 为什么是"协议级"：厂家以太网栈依赖 IDELAYE2/IDDR/ODDR/BUFIO/BUFG 原语，
//   纯 ModelSim 跑不起来（skill 已记录）。本 TB 用 sim/tb/eth_top_sim_model.v
//   （模块名 eth_top，按厂家 udp_tx.v 逐拍复刻握手）替换厂家栈，
//   从而把 eth_udp 自己的逻辑（字节缓冲 / 跨域握手 / 重放 / MTU 截断）**离线验证**。
//
// 判据：
//   V1  复位后 o_tx_ready=1；复位期间 o_tx_ready=0
//   V2  1295 B 包（= udp_merge 真实原始包长）逐字节送达厂家发送口
//   V3  o_tx_ready 在封包期拉低、发完自动拉高（背靠背两包都正确）
//   V4  MTU 红线：i_tx_len=1600 被截断到 1472，绝不多发一字节
//   V5  最大负载 1472 B 可正确发送
//   V6  以太网/IP/UDP 首部字段正确（目的MAC/源MAC/ethertype/源IP/目的IP/UDP长度/端口）
//   V7  i_tx_len=0 被忽略（不发包、不锁死 ready）
//
// ⚠️ 本 TB 验证的是"eth_udp 与厂家栈之间的接口与逻辑"；
//    RGMII 时序、IDELAY、ARP 应答、真实网卡收包**只能上板确认**。
//==============================================================================
`timescale 1ns / 1ps

module tb_eth_udp;

    //--------------------------------------------------------------------------
    // 时钟：eth_rxc = clk_eth（顶层就是 assign clk_eth = eth_rxc）
    //--------------------------------------------------------------------------
    reg clk125 = 1'b0;      // 125 MHz
    reg clk200 = 1'b0;      // 200 MHz（IDELAYCTRL 参考）
    always #4  clk125 = ~clk125;
    always #2.5 clk200 = ~clk200;

    wire eth_rxc_w = clk125;        // 顶层：assign clk_eth = eth_rxc

    reg rst_n = 1'b0;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    //--------------------------------------------------------------------------
    // DUT
    //--------------------------------------------------------------------------
    reg         i_tx_start   = 1'b0;
    reg  [7:0]  i_tx_byte    = 8'd0;
    reg         i_tx_byte_en = 1'b0;
    reg  [15:0] i_tx_len     = 16'd0;
    wire        o_tx_ready;
    wire        eth_txc, eth_tx_ctl, eth_rst_n;
    wire [3:0]  eth_txd;

    eth_udp #(
        .BOARD_MAC   (48'h00_11_22_33_44_55),
        .BOARD_IP    ({8'd192,8'd168,8'd1,8'd10}),
        .PC_IP       ({8'd192,8'd168,8'd1,8'd102}),
        .PC_MAC      (48'hff_ff_ff_ff_ff_ff),
        .MAX_TX_LEN  (16'd1472),
        .BUF_BYTES   (2048)
    ) dut (
        .clk_eth      (eth_rxc_w),
        .rst_n_eth    (rst_n),
        .clk_ref_200m (clk200),
        .eth_rxc      (eth_rxc_w),
        .eth_rx_ctl   (1'b0),
        .eth_rxd      (4'b0000),
        .eth_txc      (eth_txc),
        .eth_tx_ctl   (eth_tx_ctl),
        .eth_txd      (eth_txd),
        .eth_rst_n    (eth_rst_n),
        .i_tx_start   (i_tx_start),
        .i_tx_byte    (i_tx_byte),
        .i_tx_byte_en (i_tx_byte_en),
        .i_tx_len     (i_tx_len),
        .o_tx_ready   (o_tx_ready)
    );

    //--------------------------------------------------------------------------
    // 负载模式（TB 与检查共用）
    //--------------------------------------------------------------------------
    function [7:0] pat;
        input integer j;
        input integer id;
        begin
            pat = (j * 7 + id * 13 + 3) & 8'hFF;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 发一包（严格按 udp_merge 的握手：start 1 拍 + 连续字节）
    //--------------------------------------------------------------------------
    integer g, j;
    task send_pkt; input integer len; input integer id;
        begin
            g = 0;
            while ((o_tx_ready !== 1'b1) && (g < 200000)) begin
                @(posedge clk125);
                g = g + 1;
            end
            @(negedge clk125);
            i_tx_start   <= 1'b1;
            i_tx_len     <= len[15:0];
            i_tx_byte    <= pat(0, id);
            i_tx_byte_en <= 1'b0;
            @(negedge clk125);
            i_tx_start   <= 1'b0;
            for (j = 0; j < len; j = j + 1) begin
                i_tx_byte    <= pat(j, id);
                i_tx_byte_en <= 1'b1;
                @(negedge clk125);
            end
            i_tx_byte_en <= 1'b0;
            @(negedge clk125);
        end
    endtask

    // 等待厂家发送口收完 n 包
    integer gp;
    task wait_pkts; input integer n;
        begin
            gp = 0;
            while ((dut.u_eth_top.n_pkt < n) && (gp < 200000)) begin
                @(posedge clk125);
                gp = gp + 1;
            end
        end
    endtask

    // 检查最近一包的负载
    integer k, bad;
    task check_payload; input integer len; input integer id;
        begin
            bad = 0;
            for (k = 0; k < len; k = k + 1)
                if (dut.u_eth_top.pay[k] !== pat(k, id)) begin
                    if (bad == 0)
                        $display("  [E] pay[%0d] got=%02x exp=%02x", k,
                                 dut.u_eth_top.pay[k], pat(k, id));
                    bad = bad + 1;
                end
            if (bad == 0) chk_pass("payload_bytes_exact");
            else begin
                chk_fail("payload_bytes_exact");
                $display("  [E] 负载不符字节数=%0d / %0d", bad, len);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer n_before;

    initial begin
        //======================================================================
        // V1 复位期间 / 复位后 ready
        //======================================================================
        repeat (10) @(posedge clk125);
        if (o_tx_ready === 1'b0) chk_pass("V1_ready_low_in_reset");
        else                     chk_fail("V1_ready_low_in_reset");

        rst_n <= 1'b1;
        repeat (10) @(posedge clk125);
        if (o_tx_ready === 1'b1) chk_pass("V1_ready_high_after_reset");
        else                     chk_fail("V1_ready_high_after_reset");

        if (eth_rst_n === 1'b1)  chk_pass("V1_phy_rst_released");
        else                     chk_fail("V1_phy_rst_released");

        //======================================================================
        // V2 1295 B 包（udp_merge 的真实原始包长）
        //======================================================================
        n_before = dut.u_eth_top.n_pkt;
        send_pkt(1295, 1);
        @(posedge clk125);
        if (o_tx_ready === 1'b0) chk_pass("V3_ready_low_while_busy");
        else                     chk_fail("V3_ready_low_while_busy");

        wait_pkts(n_before + 1);
        if (dut.u_eth_top.n_pkt == (n_before + 1)) chk_pass("V2_pkt_received");
        else                                       chk_fail("V2_pkt_received");
        if (dut.u_eth_top.pay_n == 1295) chk_pass("V2_len_1295");
        else begin
            chk_fail("V2_len_1295");
            $display("  [E] pay_n=%0d", dut.u_eth_top.pay_n);
        end
        check_payload(1295, 1);

        // ready 应自动回到 1
        gp = 0;
        while ((o_tx_ready !== 1'b1) && (gp < 20000)) begin @(posedge clk125); gp = gp + 1; end
        if (o_tx_ready === 1'b1) chk_pass("V3_ready_recovers");
        else                     chk_fail("V3_ready_recovers");

        //======================================================================
        // V6 首部字段（参数透传 + 长度计算）
        //======================================================================
        if (dut.u_eth_top.hdr[0]  === 8'hFF && dut.u_eth_top.hdr[1]  === 8'hFF &&
            dut.u_eth_top.hdr[2]  === 8'hFF && dut.u_eth_top.hdr[3]  === 8'hFF &&
            dut.u_eth_top.hdr[4]  === 8'hFF && dut.u_eth_top.hdr[5]  === 8'hFF)
            chk_pass("V6_dst_mac_broadcast");
        else chk_fail("V6_dst_mac_broadcast");

        if (dut.u_eth_top.hdr[6]  === 8'h00 && dut.u_eth_top.hdr[7]  === 8'h11 &&
            dut.u_eth_top.hdr[8]  === 8'h22 && dut.u_eth_top.hdr[9]  === 8'h33 &&
            dut.u_eth_top.hdr[10] === 8'h44 && dut.u_eth_top.hdr[11] === 8'h55)
            chk_pass("V6_src_mac");
        else chk_fail("V6_src_mac");

        if (dut.u_eth_top.hdr[12] === 8'h08 && dut.u_eth_top.hdr[13] === 8'h00)
            chk_pass("V6_ethertype_ipv4");
        else chk_fail("V6_ethertype_ipv4");

        if (dut.u_eth_top.hdr[26] === 8'd192 && dut.u_eth_top.hdr[27] === 8'd168 &&
            dut.u_eth_top.hdr[28] === 8'd1   && dut.u_eth_top.hdr[29] === 8'd10 &&
            dut.u_eth_top.hdr[30] === 8'd192 && dut.u_eth_top.hdr[31] === 8'd168 &&
            dut.u_eth_top.hdr[32] === 8'd1   && dut.u_eth_top.hdr[33] === 8'd102)
            chk_pass("V6_ip_src_dst");
        else chk_fail("V6_ip_src_dst");

        if (dut.u_eth_top.hdr[23] === 8'h11) chk_pass("V6_proto_udp");
        else                                 chk_fail("V6_proto_udp");

        if (dut.u_eth_top.hdr[34] === 8'h04 && dut.u_eth_top.hdr[35] === 8'hD2 &&
            dut.u_eth_top.hdr[36] === 8'h04 && dut.u_eth_top.hdr[37] === 8'hD2)
            chk_pass("V6_udp_port_1234");
        else chk_fail("V6_udp_port_1234");

        // UDP 长度 = 1295 + 8 = 1303 = 0x0517
        if (dut.u_eth_top.hdr[38] === 8'h05 && dut.u_eth_top.hdr[39] === 8'h17)
            chk_pass("V6_udp_len_1303");
        else begin
            chk_fail("V6_udp_len_1303");
            $display("  [E] udp len=%02x%02x", dut.u_eth_top.hdr[38], dut.u_eth_top.hdr[39]);
        end

        //======================================================================
        // V3 背靠背第二包
        //======================================================================
        n_before = dut.u_eth_top.n_pkt;
        send_pkt(1295, 2);
        wait_pkts(n_before + 1);
        if (dut.u_eth_top.n_pkt == (n_before + 1)) chk_pass("V3_back_to_back");
        else                                       chk_fail("V3_back_to_back");
        check_payload(1295, 2);

        //======================================================================
        // V4 MTU 红线：请求 1600 B → 必须截断到 1472
        //======================================================================
        n_before = dut.u_eth_top.n_pkt;
        send_pkt(1600, 3);
        wait_pkts(n_before + 1);
        if (dut.u_eth_top.n_pkt == (n_before + 1)) chk_pass("V4_oversize_sent");
        else                                       chk_fail("V4_oversize_sent");
        if (dut.u_eth_top.pay_n == 1472) chk_pass("V4_mtu_clamp_1472");
        else begin
            chk_fail("V4_mtu_clamp_1472");
            $display("  [E] 超长包实际发出 %0d 字节（应 1472）", dut.u_eth_top.pay_n);
        end
        check_payload(1472, 3);

        //======================================================================
        // V5 最大负载 1472 B
        //======================================================================
        n_before = dut.u_eth_top.n_pkt;
        send_pkt(1472, 4);
        wait_pkts(n_before + 1);
        if (dut.u_eth_top.pay_n == 1472) chk_pass("V5_max_payload_1472");
        else                             chk_fail("V5_max_payload_1472");
        check_payload(1472, 4);

        //======================================================================
        // V7 i_tx_len = 0：不发包、不锁死
        //======================================================================
        n_before = dut.u_eth_top.n_pkt;
        @(negedge clk125);
        i_tx_start <= 1'b1; i_tx_len <= 16'd0;
        @(negedge clk125);
        i_tx_start <= 1'b0;
        repeat (2000) @(posedge clk125);
        if ((dut.u_eth_top.n_pkt == n_before) && (o_tx_ready === 1'b1))
            chk_pass("V7_zero_len_ignored");
        else chk_fail("V7_zero_len_ignored");

        $display("INFO pkts=%0d last_len=%0d", dut.u_eth_top.n_pkt, dut.u_eth_top.pay_n);

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #4000000;                       // 4 ms
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
