//==============================================================================
// tb_nn_engine —— nn_engine 自检（1. directed 定向 + 2. 全网络 golden 逐字节比对）
//
// 【验证策略】
//   RUN1（定向）：ROM 只填 conv1 少数系数，验证
//     · 通道顺序 [ON_now,OFF_now,ON_prev,OFF_prev]：och0 中心 tap 权重 1/2/4/8，
//       特征四区分别 1/2/4/8 => 期望 1+4+16+64 = 85（若顺序错会得 40）
//     · 每像素 bias（och1 => 100）、每通道 SH（och2 SH=1 => 50）
//     · 负饱和 + ReLU（och3：-900 => -128 => 0）、正饱和（och4：9*127 => 127）
//     · fc 不 ReLU / 负数保留（fc bias 50 / 0 / -50）
//   RUN2（golden）：随机小权重网络，TB 内用同一 ROM/特征跑整数 golden 模型，在
//     层切换点逐字节比对 L1(2688)/L2(1056)/L3(240) 输出与 3 个 logit。
//     层切换点判据：dut.layer==2 时 L1 已写完 bufA；dut.layer==3 时 L2 已写完 bufB；
//     结束后 bufC[0:239]=L3 输出。
//
// 【TB 与 DUT 的时序契约】本 TB 的 ROM/特征存储器模型都是"1 拍寄存读"：
//   always @(posedge clk) rom_q <= rom_mem[rom_addr];
//   ⇒ TB 提供 1 拍延迟。由于 DUT 的 o_rom_addr 本身就是寄存器，权重路径**总延迟 2 拍**；
//   而 o_feat_addr 是组合输出，特征路径**总延迟 1 拍**。DUT 内部按这两个不同延迟对齐，
//   TB 侧不需要做任何补偿。
//
// 【v2（单时钟串行 MAC）的差异】时钟 50 MHz；激活缓存改名为 dut.bufA/bufB/bufC
//   （L1/L2/L3 输出各一个数组，不再复用两个数组）；写口比 S_FIN 晚 1 拍提交，
//   所以层刚切换后要 repeat(4) 再比对最后一格。
//   [M3e/task-51 v7] 一次推理实测 439,981 拍 = conv1 209,664 + conv2 158,400 +
//   conv3 70,560 + g1 320 + fc 1037（2 类）。层链 L1->L2->L3->G1->FC，g1 为 7 路
//   全局量点积层（本 TB 把 7 路输入全接 0，g1_b/g1_SH 不被 fill_random 覆盖而保持 0
//   ⇒ 即使 g1 权重随机，acc=0 且 ReLU 后仍恒 0 ⇒ fc 的 240..255 tap 贡献为 0，golden
//   只需 conv3 的 240 路）。另加 E2_G1_DECOUPLE 检查 bufC[240..255] 全 0，证明 fc 的
//   256 路输入中后 16 路是独立段、不污染 conv3 的 240 路。
//==============================================================================
`timescale 1ns / 1ps
`include "../../src/hdl/nn/nn_cfg.vh"

module tb_nn_engine;

    //--------------------------------------------------------------------------
    // 时钟 / 复位 / 输入
    //--------------------------------------------------------------------------
    reg clk = 0;
    reg rst_n = 0;
    always #10 clk = ~clk;                  // 50 MHz（M3-fix v2：引擎与特征同域）

    reg        i_start = 0;
    reg  [1:0] bank_now  = 2'd0;            // 本窗 = bank0（DUT 内部推 bin(now-i)）

    wire [13:0] feat_addr;
    wire [7:0]  feat_data;
    wire [12:0] rom_addr;
    wire [31:0] rom_data;
    wire        busy, res_tog;
    wire [7:0]  res_l0, res_l1, res_l2;
    wire signed [7:0] g1z = 8'sd0;          // v7：G1 支路 7 路输入全 0

    //--------------------------------------------------------------------------
    // ROM / 特征存储器模型（1 拍延迟读）
    //--------------------------------------------------------------------------
    reg [31:0] rom_mem  [0:8191];
    reg [7:0]  feat_mem [0:8999];
    reg [31:0] rom_q;
    reg [7:0]  feat_q;

    always @(posedge clk) begin
        rom_q  <= rom_mem[rom_addr];
        feat_q <= feat_mem[feat_addr];
    end
    assign rom_data  = rom_q;
    assign feat_data = feat_q;

    nn_engine dut (
        .clk         (clk),
        .rst_n       (rst_n),
        .i_start     (i_start),
        .i_bank_now  (bank_now),
        .o_feat_addr (feat_addr),
        .i_feat_data (feat_data),
        .i_g1_f0     (g1z),
        .i_g1_f1     (g1z),
        .i_g1_f2     (g1z),
        .i_g1_f3     (g1z),
        .i_g1_f4     (g1z),
        .i_g1_f5     (g1z),
        .i_g1_f6     (g1z),
        .o_rom_addr  (rom_addr),
        .i_rom_data  (rom_data),
        .o_busy      (busy),
        .o_res_tog   (res_tog),
        .o_res_l0    (res_l0),
        .o_res_l1    (res_l1),
        .o_res_l2    (res_l2)
    );

    //--------------------------------------------------------------------------
    // golden 模型（与 DUT 完全相同的整数语义）
    //--------------------------------------------------------------------------
    reg [7:0] gold_l1 [0:2687];
    reg [7:0] gold_l2 [0:1055];
    reg [7:0] gold_l3 [0:239];
    reg [7:0] gold_log [0:2];

    function signed [7:0] w8;               // ROM 权重字（低 8 位，有符号）
        input [13:0] a;
        begin w8 = rom_mem[a]; end
    endfunction

    function signed [31:0] b32;             // ROM bias 字（32 位有符号）
        input [13:0] a;
        begin b32 = rom_mem[a]; end
    endfunction

    function signed [7:0] q8;               // 特征/激活值（0..127，按正数参与乘）
        input [13:0] a;
        begin q8 = feat_mem[a]; end
    endfunction

    function signed [7:0] post;             // 移位 -> 饱和 -> (conv)ReLU
        input signed [31:0] v;
        input [7:0] sh;
        input       isfc;
        reg signed [31:0] s;
        begin
            s = v >>> sh;
            if (s > 32'sd127)       s = 32'sd127;
            else if (s < -32'sd128) s = -32'sd128;
            if (!isfc && (s < 0))   s = 32'sd0;
            post = s[7:0];
        end
    endfunction

    integer gi, gj, gk, go, gci, gky, gkx;
    reg signed [31:0] ga;
    reg [7:0] gsh;

    task g_l1;
        begin
            for (go = 0; go < 8; go = go + 1) begin
                gsh = rom_mem[`NN_SH1_BASE + go];
                for (gj = 0; gj < 14; gj = gj + 1)
                for (gi = 0; gi < 24; gi = gi + 1) begin
                    ga = b32(`NN_B1_BASE + go);
                    for (gci = 0; gci < 4; gci = gci + 1)
                    for (gky = 0; gky < 3; gky = gky + 1)
                    for (gkx = 0; gkx < 3; gkx = gkx + 1)
                        ga = ga + w8(`NN_W1_BASE + go*36 + gci*9 + gky*3 + gkx)
                                * q8(((gci & 2) ? 6000 : 0) + ((gci & 1) ? 1500 : 0)
                                     + (gj*2 + gky)*50 + gi*2 + gkx);
                    gold_l1[go*336 + gj*24 + gi] = post(ga, gsh, 1'b0);
                end
            end
        end
    endtask

    task g_l2;
        begin
            for (go = 0; go < 16; go = go + 1) begin
                gsh = rom_mem[`NN_SH2_BASE + go];
                for (gj = 0; gj < 6; gj = gj + 1)
                for (gi = 0; gi < 11; gi = gi + 1) begin
                    ga = b32(`NN_B2_BASE + go);
                    for (gci = 0; gci < 8; gci = gci + 1)
                    for (gky = 0; gky < 3; gky = gky + 1)
                    for (gkx = 0; gkx < 3; gkx = gkx + 1)
                        ga = ga + w8(`NN_W2_BASE + go*72 + gci*9 + gky*3 + gkx)
                                * $signed({1'b0, gold_l1[gci*336 + (gj*2 + gky)*24 + gi*2 + gkx]});
                    gold_l2[go*66 + gj*11 + gi] = post(ga, gsh, 1'b0);
                end
            end
        end
    endtask

    task g_l3;
        begin
            for (go = 0; go < 24; go = go + 1) begin
                gsh = rom_mem[`NN_SH3_BASE + go];
                for (gj = 0; gj < 2; gj = gj + 1)
                for (gi = 0; gi < 5; gi = gi + 1) begin
                    ga = b32(`NN_B3_BASE + go);
                    for (gci = 0; gci < 16; gci = gci + 1)
                    for (gky = 0; gky < 3; gky = gky + 1)
                    for (gkx = 0; gkx < 3; gkx = gkx + 1)
                        ga = ga + w8(`NN_W3_BASE + go*144 + gci*9 + gky*3 + gkx)
                                * $signed({1'b0, gold_l2[gci*66 + (gj*2 + gky)*11 + gi*2 + gkx]});
                    gold_l3[go*10 + gj*5 + gi] = post(ga, gsh, 1'b0);
                end
            end
        end
    endtask

    task g_fc;
        begin
            for (go = 0; go < `NN_FC_COUT; go = go + 1) begin
                gsh = rom_mem[`NN_SHFC_BASE + go];
                ga = b32(`NN_BFC_BASE + go);
                for (gci = 0; gci < 240; gci = gci + 1)
                    ga = ga + w8(`NN_WFC_BASE + go*`NN_FC_CIN + gci)
                            * $signed({1'b0, gold_l3[gci]});
                gold_log[go] = post(ga, gsh, 1'b1);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 工具
    //--------------------------------------------------------------------------
    integer errors = 0;
    integer i, t0, t1, nbad, nzero;
    reg tog_before;
    reg [31:0] rseed;

    task chk;
        input [8*44-1:0] nm;
        input ok;
        begin
            if (ok) $display("CHECK=%0s PASS", nm);
            else begin
                $display("CHECK=%0s FAIL", nm);
                errors = errors + 1;
            end
        end
    endtask

    // NUM_CLASSES=2 时 class2 相关判据不适用：打印 SKIP（不减少 CHECK 行数、不算失败）
    task skip;
        input [8*44-1:0] nm;
        begin
            $display("CHECK=%0s SKIP (NUM_CLASSES=%0d, class2 unused)", nm, `NN_NUM_CLASSES);
        end
    endtask

    task do_start;
        begin
            @(negedge clk);
            i_start = 1'b1;
            @(negedge clk);
            i_start = 1'b0;
        end
    endtask

    task wait_layer;
        input [1:0] l;
        begin
            while (dut.layer !== l) @(posedge clk);
        end
    endtask

    task wait_idle;
        begin
            while (busy !== 1'b0) @(posedge clk);
            repeat (2) @(posedge clk);
        end
    endtask

    function [7:0] rnd_w;                   // 随机权重 [0,3]（非负，避免 ReLU 把整层压成 0）
        input dummy;
        begin rnd_w = ($random(rseed) & 32'd3); end
    endfunction

    function [7:0] rnd_f;                   // 随机特征 [0,7]
        input dummy;
        begin rnd_f = ($random(rseed) & 32'd7); end
    endfunction

    integer rb;

    //--------------------------------------------------------------------------
    // RUN1 定向激励
    //--------------------------------------------------------------------------
    task fill_directed;
        begin
            for (i = 0; i < 8192; i = i + 1) rom_mem[i]  = 32'd0;
            for (i = 0; i < 9000; i = i + 1) feat_mem[i] = 8'd0;
            // 四个通道区（now=bank0, prev=bank2）
            for (i = 0;    i < 1500; i = i + 1) feat_mem[i]      = 8'd1;   // ON_now
            for (i = 1500; i < 3000; i = i + 1) feat_mem[i]      = 8'd2;   // OFF_now
            for (i = 6000; i < 7500; i = i + 1) feat_mem[i]      = 8'd4;   // ON_prev
            for (i = 7500; i < 9000; i = i + 1) feat_mem[i]      = 8'd8;   // OFF_prev
            // conv1 och0：中心 tap 权重 1/2/4/8（通道顺序探针）
            rom_mem[`NN_W1_BASE + 0*36 + 0*9 + 8] = 32'd1;
            rom_mem[`NN_W1_BASE + 0*36 + 1*9 + 8] = 32'd2;
            rom_mem[`NN_W1_BASE + 0*36 + 2*9 + 8] = 32'd4;
            rom_mem[`NN_W1_BASE + 0*36 + 3*9 + 8] = 32'd8;
            // och1：只有 bias=100
            rom_mem[`NN_B1_BASE + 1] = 32'd100;
            // och2：权重 100 + SH=1 => 50
            rom_mem[`NN_W1_BASE + 2*36 + 0*9 + 8] = 32'd100;
            rom_mem[`NN_SH1_BASE + 2] = 32'd1;
            // och3：权重 100、bias -1000 => -900 => 饱和 -128 => ReLU 0
            rom_mem[`NN_W1_BASE + 3*36 + 0*9 + 8] = 32'd100;
            rom_mem[`NN_B1_BASE + 3] = -32'sd1000;
            // och4：ch0 九个 tap 全 127 => 9*127*1 => 正饱和 127
            for (i = 0; i < 9; i = i + 1)
                rom_mem[`NN_W1_BASE + 4*36 + 0*9 + i] = 32'd127;
            // fc：bias 50 / 0 / -50（后层权重全 0 => 输入 0）
            rom_mem[`NN_BFC_BASE + 0] = 32'd50;
            if (`NN_NUM_CLASSES >= 3) rom_mem[`NN_BFC_BASE + 2] = -32'sd50;
        end
    endtask

    //--------------------------------------------------------------------------
    // RUN2 随机激励
    //--------------------------------------------------------------------------
    task fill_random;
        begin
            for (i = 0; i < 8192; i = i + 1) rom_mem[i]  = 32'd0;
            for (i = 0; i < 9000; i = i + 1) feat_mem[i] = rnd_f(1'b0);
            // 权重（4 个权重段连续：W1..WFC，2 类时到 WFC_BASE+WFC_WORDS）
            for (i = 0; i < `NN_WFC_BASE + `NN_WFC_WORDS; i = i + 1) rom_mem[i] = {24'd0, rnd_w(1'b0)};
            gold_log[2] = 8'd0;
            // bias：conv1 8 个、conv2 16 个、conv3 24 个，范围 [-8,7]
            for (i = 0; i < 8;  i = i + 1) begin
                rb = ($random(rseed) & 32'd15) - 32'd8; rom_mem[`NN_B1_BASE + i] = rb;
            end
            for (i = 0; i < 16; i = i + 1) begin
                rb = ($random(rseed) & 32'd15) - 32'd8; rom_mem[`NN_B2_BASE + i] = rb;
            end
            for (i = 0; i < 24; i = i + 1) begin
                rb = ($random(rseed) & 32'd15) - 32'd8; rom_mem[`NN_B3_BASE + i] = rb;
            end
            for (i = 0; i < `NN_FC_COUT; i = i + 1) begin
                rb = ($random(rseed) & 32'd15) - 32'd8; rom_mem[`NN_BFC_BASE + i] = rb;
            end
            // SH：把每层输出铺开到 ~[0,30]（实测 SH=6 会把 L1 全压成 0，golden 覆盖不足）
            for (i = 0; i < 8;  i = i + 1) rom_mem[`NN_SH1_BASE + i] = 32'd4;
            for (i = 0; i < 16; i = i + 1) rom_mem[`NN_SH2_BASE + i] = 32'd5;
            for (i = 0; i < 24; i = i + 1) rom_mem[`NN_SH3_BASE + i] = 32'd7;
            for (i = 0; i < `NN_FC_COUT; i = i + 1) rom_mem[`NN_SHFC_BASE + i] = 32'd8;
        end
    endtask

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    initial begin
        rseed = 32'h5EED_1234;
        for (i = 0; i < 8192; i = i + 1) rom_mem[i]  = 32'd0;
        for (i = 0; i < 9000; i = i + 1) feat_mem[i] = 8'd0;

        rst_n = 1'b0;
        repeat (4) @(posedge clk);
        rst_n = 1'b1;
        repeat (2) @(posedge clk);

        //=================== RUN 1：定向 ===================
        fill_directed;
        $display("---- RUN1 directed ----");
        t0 = $time;
        do_start;
        wait_layer(2'd2);                                  // L1 输出已写完
        repeat (4) @(posedge clk);                         // 等最后一条写提交（写使能晚 1 拍）
        chk("E1_L1_CH_ORDER",     dut.bufA[0]       === 8'd85);
        chk("E1_L1_CH_ORDER_LAST", dut.bufA[335]    === 8'd85);   // och0 最后一格（全像素恒 85）
        chk("E1_L1_BIAS",         dut.bufA[336]     === 8'd100);
        chk("E1_L1_BIAS_LAST",    dut.bufA[336+335] === 8'd100);
        chk("E1_L1_SH_PER_CH",    dut.bufA[672]     === 8'd50);
        chk("E1_L1_NEG_SAT_RELU", dut.bufA[1008]    === 8'd0);
        chk("E1_L1_POS_SAT",      dut.bufA[1344]    === 8'd127);
        chk("E1_L1_ZERO_CH",      dut.bufA[1680]    === 8'd0);
        wait_idle;
        t1 = $time;
        chk("E1_BUSY_RELEASED",   busy === 1'b0);
        chk("E1_FC_L0_POS",       res_l0 === 8'd50);
        chk("E1_FC_L1_ZERO",      res_l1 === 8'd0);
        if (`NN_NUM_CLASSES >= 3) chk("E1_FC_L2_NEG_KEEP", res_l2 === 8'hCE); // -50，fc 不 ReLU
        else                      skip("E1_FC_L2_NEG_KEEP");
        $display("  RUN1 cycles=%0d (v7 439981 = 209664+158400+70560+320+1037)", (t1 - t0) / 20);
        // v7 一次推理 439,981 拍（旧 2 类 439,597 + g1 层 320 拍 + fc 240->256 多 64 拍）
        chk("E1_CYCLE_CNT", ((t1 - t0) / 20 > 439900) && ((t1 - t0) / 20 < 440100));

        //=================== RUN 2：golden 逐字节 ===================
        fill_random;
        $display("---- RUN2 golden ----");
        g_l1;
        g_l2;
        g_l3;
        g_fc;
        nzero = 0;
        for (i = 0; i < 2688; i = i + 1) if (gold_l1[i] == 8'd0) nzero = nzero + 1;
        $display("  gold_l1 zeros=%0d / 2688", nzero);
        // 覆盖判据：非零 > 30%（ReLU 会吃掉一部分，但绝不能全零）且 logit 不能三个相同
        if (`NN_NUM_CLASSES >= 3)
            chk("E2_GOLD_COVER", (nzero < 1881) &&
                                  !((gold_log[0] === gold_log[1]) && (gold_log[1] === gold_log[2])));
        else
            chk("E2_GOLD_COVER", (nzero < 1881) && !(gold_log[0] === gold_log[1]));
        $display("  gold_log=%0d/%0d/%0d", $signed(gold_log[0]), $signed(gold_log[1]), $signed(gold_log[2]));
        tog_before = res_tog;
        t0 = $time;
        do_start;

        wait_layer(2'd2);                                  // L1 已写完 bufA
        repeat (4) @(posedge clk);                         // 等最后一条写提交
        nbad = 0;
        for (i = 0; i < 2688; i = i + 1)
            if (dut.bufA[i] !== gold_l1[i]) begin
                nbad = nbad + 1;
                if (nbad <= 4)
                    $display("  L1 mismatch idx=%0d dut=%0d gold=%0d",
                             i, dut.bufA[i], gold_l1[i]);
            end
        chk("E2_L1_BYTE_EXACT", nbad === 0);

        wait_layer(2'd3);                                  // L2 已写完 bufB
        repeat (4) @(posedge clk);
        nbad = 0;
        for (i = 0; i < 1056; i = i + 1)
            if (dut.bufB[i] !== gold_l2[i]) begin
                nbad = nbad + 1;
                if (nbad <= 4)
                    $display("  L2 mismatch idx=%0d dut=%0d gold=%0d",
                             i, dut.bufB[i], gold_l2[i]);
            end
        chk("E2_L2_BYTE_EXACT", nbad === 0);

        wait_idle;
        t1 = $time;
        nbad = 0;
        for (i = 0; i < 240; i = i + 1)
            if (dut.bufC[i] !== gold_l3[i]) begin
                nbad = nbad + 1;
                if (nbad <= 4)
                    $display("  L3 mismatch idx=%0d dut=%0d gold=%0d",
                             i, dut.bufC[i], gold_l3[i]);
            end
        chk("E2_L3_BYTE_EXACT", nbad === 0);

        // v7：bufC[240..255] 是 g1 输出段（本 TB 输入全 0 ⇒ 恒 0），不得被 conv3 污染
        nbad = 0;
        for (i = `NN_FC_CONV_IN; i < `NN_FC_CIN; i = i + 1)
            if (dut.bufC[i] !== 8'd0) begin
                nbad = nbad + 1;
                if (nbad <= 4)
                    $display("  G1 segment mismatch idx=%0d dut=%0d", i, dut.bufC[i]);
            end
        chk("E2_G1_DECOUPLE", nbad === 0);
        $display("  logits dut=%0d/%0d/%0d gold=%0d/%0d/%0d",
                 $signed(res_l0), $signed(res_l1), $signed(res_l2),
                 $signed(gold_log[0]), $signed(gold_log[1]), $signed(gold_log[2]));
        if (`NN_NUM_CLASSES >= 3)
            chk("E2_LOGITS_EXACT", (res_l0 === gold_log[0]) &&
                                   (res_l1 === gold_log[1]) &&
                                   (res_l2 === gold_log[2]));
        else
            chk("E2_LOGITS_EXACT", (res_l0 === gold_log[0]) &&
                                   (res_l1 === gold_log[1]) &&
                                   (res_l2 === 8'h00)); // 2 类时第 3 路不驱动，保持 0
        chk("E2_TOG_ONCE",     res_tog === ~tog_before);
        $display("  RUN2 cycles=%0d", (t1 - t0) / 20);
        chk("E2_CYCLE_CNT", ((t1 - t0) / 20 > 439900) && ((t1 - t0) / 20 < 440100));

        //=================== 汇总 ===================
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

endmodule
