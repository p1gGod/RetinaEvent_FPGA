`timescale 1ns / 1ps
//==============================================================================
// tb_nn_engine_v7 —— task-51 (M3e) 融合引擎逐层对拍 TB
//
// 对拍对象：nn_engine (v7: conv1->conv2->conv3->g1->fc) + nn_rom + nn_rom_data
// 参考数据：nn/out_v7/golden_vectors.json 的 6 组 net_vectors（由
//   temp_test/rtl2/gen_engine_v7_vectors.py 打包成 tb_nn_engine_v7_vectors.vh，
//   TB 只读十六进制常量，不解析 JSON）。
//
// 逐层对拍：每跑完一次推理，直接读 RTL 的激活缓存与输出寄存器：
//   conv1 -> u_eng.bufA[0..2687]     8x14x24
//   conv2 -> u_eng.bufB[0..1055]     16x6x11
//   conv3 -> u_eng.bufC[0..239]      24x2x5
//   g1    -> u_eng.bufC[240..255]    16
//   fc    -> u_eng.o_res_l0/l1       2（l2 恒 0，2 类）
// 激活输入：conv1 的 4 通道输入由 o_feat_addr 反解通道/单元后从 GV_X 取；
//   i_bank_now 固定 0 => 通道映射 age=(bank==0)?0:(BANKS-bank)、ch=age*2+pol。
//
// 定向边界（B 段，直接改写 u_rom.u_rom_data.rom，不依赖 golden）：
//   B1 空窗/全零网络 => 所有层与 logits 全 0（也证明不死循环/不挂起）
//   B2 g1 单独 + fc 分界：g1_b[ch]=ch、g1_w 对角 1、fc 只取 240..255
//      => g1 out=ch、logit0=sum(ch)=120、logit1=0（SH=0 路径）
//   B3 clamp 上下饱和：g1_b[0]=2000 => 127；g1_b[1]=-2000 => ReLU 0；
//      fc 正饱和 127、负饱和 -128
//   B4 平局：两输出通道同权重同输入 => logit0==logit1==5（平局由 nn_decide 处理，
//      规则 argmax 取较小索引 class0，见 golden tie_cases）
//   B5 conv3 侧分界：conv3_b[23]=1 => bufC[239]=1，fc_w[0][239]=1 且 [0][240]=0；
//      g1_b[0]=2 => bufC[240]=2，fc_w[1][240]=1 => logit1=2（证明 g1 落在 240 而不是 239）
//
// 周期：单次推理 busy 高电平拍数实测 439,981（budget <=442,000）
//==============================================================================
`include "../../src/hdl/nn/nn_cfg.vh"

module tb_nn_engine_v7;

    // ---- golden 向量常量（自动生成，禁止手改）----
    `include "tb_nn_engine_v7_vectors.vh"

    reg clk, rst_n;
    initial clk = 1'b0;
    always #10 clk = ~clk;

    reg  i_start;
    reg  [`NN_BANK_AW-1:0] i_bank_now;
    wire [`NN_FRZ_AW-1:0] feat_addr;
    reg  [`NN_CNT_W-1:0]  feat_data;
    wire [`NN_ROM_AW-1:0] rom_addr;
    wire [31:0]                rom_dout;
    wire                       busy, res_tog;
    wire [`NN_CNT_W-1:0]   res_l0, res_l1, res_l2;
    reg signed [7:0] f0, f1, f2, f3, f4, f5, f6;

    nn_rom u_rom (
        .clk    (clk),
        .i_addr (rom_addr),
        .o_dout (rom_dout)
    );

    nn_engine u_eng (
        .clk        (clk),
        .rst_n      (rst_n),
        .i_start    (i_start),
        .i_bank_now (i_bank_now),
        .o_feat_addr(feat_addr),
        .i_feat_data(feat_data),
        .i_g1_f0    (f0),
        .i_g1_f1    (f1),
        .i_g1_f2    (f2),
        .i_g1_f3    (f3),
        .i_g1_f4    (f4),
        .i_g1_f5    (f5),
        .i_g1_f6    (f6),
        .o_rom_addr (rom_addr),
        .i_rom_data (rom_dout),
        .o_busy     (busy),
        .o_res_tog  (res_tog),
        .o_res_l0   (res_l0),
        .o_res_l1   (res_l1),
        .o_res_l2   (res_l2)
    );

    //--------------------------------------------------------------------------
    // golden 向量访问函数（大位向量常量取字节）
    //--------------------------------------------------------------------------
    function [7:0] gvx(input integer v, input integer i);
        begin gvx = GV_X[(v * `GV_X_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_c1(input integer v, input integer i);
        begin gv_c1 = GV_C1[(v * `GV_C1_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_c2(input integer v, input integer i);
        begin gv_c2 = GV_C2[(v * `GV_C2_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_c3(input integer v, input integer i);
        begin gv_c3 = GV_C3[(v * `GV_C3_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_g1(input integer v, input integer i);
        begin gv_g1 = GV_G1[(v * `GV_G1_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_fc(input integer v, input integer i);
        begin gv_fc = GV_FC[(v * `GV_FC_LEN + i) * 8 +: 8]; end
    endfunction
    function [7:0] gv_ft(input integer v, input integer i);
        begin gv_ft = GV_FT[(v * `GV_FT_LEN + i) * 8 +: 8]; end
    endfunction

    //--------------------------------------------------------------------------
    // conv1 输入：从组合激活地址反解 (bank, pol, cell) 后取 X
    //--------------------------------------------------------------------------
    reg x_zero;
    integer cur_v;
    integer a_bank, a_pol, a_cell, a_age, a_ch;
    reg [7:0] xtmp;
    always @(*) begin
        a_bank = feat_addr / `NN_BANK_DEPTH;
        a_pol  = (feat_addr % `NN_BANK_DEPTH) / `NN_CELLS;
        a_cell = feat_addr % `NN_CELLS;
        a_age  = (a_bank == 0) ? 0 : (`NN_BANKS - a_bank);
        a_ch   = a_age * 2 + a_pol;
        if (x_zero) xtmp = 8'h00;
        else        xtmp = gvx(cur_v, a_ch * `NN_CELLS + a_cell);
        feat_data = xtmp;
    end

    //--------------------------------------------------------------------------
    // 检查计数与打印
    //--------------------------------------------------------------------------
    integer chk_cnt, err_cnt;
    task chk(input [8*40-1:0] nm, input integer ok);
        begin
            chk_cnt = chk_cnt + 1;
            if (ok) $display("CHECK=%0s PASS", nm);
            else begin
                err_cnt = err_cnt + 1;
                $display("CHECK=%0s FAIL", nm);
            end
        end
    endtask
    task chkval(input [8*32-1:0] nm, input integer got, input integer exp);
        begin
            chk_cnt = chk_cnt + 1;
            if (got === exp) $display("CHECK=%0s PASS (got=%0d)", nm, got);
            else begin
                err_cnt = err_cnt + 1;
                $display("CHECK=%0s FAIL (got=%0d exp=%0d)", nm, got, exp);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // ROM 改写（定向用例用）与单次推理驱动
    //--------------------------------------------------------------------------
    task rom_clear;
        integer k;
        begin
            for (k = 0; k < `NN_ROM_WORDS; k = k + 1) u_rom.u_rom_data.rom[k] = 32'h00000000;
        end
    endtask
    task rom_set(input integer a, input [31:0] d);
        begin u_rom.u_rom_data.rom[a] = d; end
    endtask

    integer run_cyc;
    task do_run;
        integer k;
        begin
            while (busy === 1'b1) @(negedge clk);
            @(negedge clk);
            i_start = 1'b1;
            @(negedge clk);
            i_start = 1'b0;
            k = 0;
            while ((busy !== 1'b1) && (k < 100)) begin k = k + 1; @(negedge clk); end
            k = 0;
            while ((busy === 1'b1) && (k < 600000)) begin k = k + 1; @(negedge clk); end
            run_cyc = k;
            repeat (2) @(negedge clk);
        end
    endtask

    //--------------------------------------------------------------------------
    // 逐层对拍（which: 1=conv1 2=conv2 3=conv3 4=g1 5=fc）
    //--------------------------------------------------------------------------
    task cmp_layer(input [8*24-1:0] nm, input integer v, input integer which);
        integer i, got, exp, bad, len;
        begin
            bad = 0;
            if (which == 1)      len = `NN_L1_COUT * `NN_L1_OUTHW;
            else if (which == 2) len = `NN_L2_COUT * `NN_L2_OUTHW;
            else if (which == 3) len = `NN_L3_COUT * `NN_L3_OUTHW;
            else if (which == 4) len = `NN_G1_COUT;
            else                 len = `NN_FC_COUT;
            for (i = 0; i < len; i = i + 1) begin
                if (which == 1) begin
                    got = u_eng.bufA[i]; exp = gv_c1(v, i);
                end else if (which == 2) begin
                    got = u_eng.bufB[i]; exp = gv_c2(v, i);
                end else if (which == 3) begin
                    got = u_eng.bufC[i]; exp = gv_c3(v, i);
                end else if (which == 4) begin
                    got = u_eng.bufC[`NN_FC_CONV_IN + i]; exp = gv_g1(v, i);
                end else begin
                    got = (i == 0) ? res_l0 : res_l1;
                    exp = gv_fc(v, i);
                end
                if (got[7:0] !== exp[7:0]) begin
                    bad = bad + 1;
                    if (bad <= 5)
                        $display("  MISMATCH %0s v%0d [%0d] got=%02x exp=%02x", nm, v, i, got[7:0], exp[7:0]);
                end
            end
            chk_cnt = chk_cnt + 1;
            if (bad == 0)
                $display("CHECK=%0s[%0d] PASS (%0d values)", nm, v, len);
            else begin
                err_cnt = err_cnt + 1;
                $display("CHECK=%0s[%0d] FAIL (%0d/%0d mismatch)", nm, v, bad, len);
            end
        end
    endtask

    integer v, i, j, bad, zsum;
    initial begin
        chk_cnt = 0; err_cnt = 0;
        rst_n = 1'b0; i_start = 1'b0; i_bank_now = {`NN_BANK_AW{1'b0}};
        x_zero = 1'b0; cur_v = 0;
        f0 = 8'sd0; f1 = 8'sd0; f2 = 8'sd0; f3 = 8'sd0;
        f4 = 8'sd0; f5 = 8'sd0; f6 = 8'sd0;
        repeat (6) @(negedge clk);
        rst_n = 1'b1;
        repeat (3) @(negedge clk);
        $display("INFO TB_START GVN=%0d", `GVN);

        //================ A 段：6 组 golden 窗口逐层对拍 ================
        for (v = 0; v < `GVN; v = v + 1) begin
            cur_v = v;
            x_zero = 1'b0;
            f0 = gv_ft(v, 0); f1 = gv_ft(v, 1); f2 = gv_ft(v, 2); f3 = gv_ft(v, 3);
            f4 = gv_ft(v, 4); f5 = gv_ft(v, 5); f6 = gv_ft(v, 6);
            do_run;
            $display("INFO VEC%0d feat=%02x %02x %02x %02x %02x %02x %02x logits=%02x/%02x cyc=%0d",
                     v, f0, f1, f2, f3, f4, f5, f6, res_l0, res_l1, run_cyc);
            chkval("ENGINE_V7_RUN_CYC_439981", run_cyc, 439981);
            chk("ENGINE_V7_CYC_BUDGET_442000", (run_cyc <= 442000));
            chk("ENGINE_V7_NO_X_LOGITS", (^{res_l0, res_l1, res_l2} !== 1'bx));
            chkval("ENGINE_V7_RES_L2_ZERO", res_l2, 0);
            cmp_layer("ENGINE_V7_CONV1_ALL", v, 1);
            cmp_layer("ENGINE_V7_CONV2_ALL", v, 2);
            cmp_layer("ENGINE_V7_CONV3_ALL", v, 3);
            cmp_layer("ENGINE_V7_G1_ALL", v, 4);
            cmp_layer("ENGINE_V7_FC_ALL", v, 5);
        end

        //================ B1：空窗 / 全零网络 ================
        rom_clear;
        x_zero = 1'b1;
        f0 = 8'sd0; f1 = 8'sd0; f2 = 8'sd0; f3 = 8'sd0; f4 = 8'sd0; f5 = 8'sd0; f6 = 8'sd0;
        do_run;
        zsum = 0;
        for (i = 0; i < `NN_L1_COUT * `NN_L1_OUTHW; i = i + 1) zsum = zsum + u_eng.bufA[i];
        chkval("B1_CONV1_ALL_ZERO", zsum, 0);
        zsum = 0;
        for (i = 0; i < `NN_L2_COUT * `NN_L2_OUTHW; i = i + 1) zsum = zsum + u_eng.bufB[i];
        chkval("B1_CONV2_ALL_ZERO", zsum, 0);
        zsum = 0;
        for (i = 0; i < `NN_L3_COUT * `NN_L3_OUTHW; i = i + 1) zsum = zsum + u_eng.bufC[i];
        chkval("B1_CONV3_ALL_ZERO", zsum, 0);
        zsum = 0;
        for (i = 0; i < `NN_G1_COUT; i = i + 1) zsum = zsum + u_eng.bufC[`NN_FC_CONV_IN + i];
        chkval("B1_G1_ALL_ZERO", zsum, 0);
        chkval("B1_LOGIT0_ZERO", res_l0, 0);
        chkval("B1_LOGIT1_ZERO", res_l1, 0);
        chkval("B1_RUN_CYC_439981", run_cyc, 439981);

        //================ B2：g1 单独 + fc 分界(240..255) ================
        rom_clear;
        for (i = 0; i < `NN_G1_COUT; i = i + 1) begin
            rom_set(`NN_BG_BASE + i, i);
            rom_set(`NN_SHG_BASE + i, 32'h0);
            for (j = 0; j < `NN_G1_CIN; j = j + 1)
                rom_set(`NN_WG_BASE + i * `NN_G1_CIN + j, ((j % `NN_G1_CIN) == (i % `NN_G1_CIN)) ? 32'h1 : 32'h0);
            rom_set(`NN_WFC_BASE + 0 * `NN_FC_CIN + `NN_FC_CONV_IN + i, 32'h1);
        end
        rom_set(`NN_SHFC_BASE + 0, 32'h0);
        rom_set(`NN_SHFC_BASE + 1, 32'h0);
        x_zero = 1'b1;
        f0 = 8'sd0; f1 = 8'sd0; f2 = 8'sd0; f3 = 8'sd0; f4 = 8'sd0; f5 = 8'sd0; f6 = 8'sd0;
        do_run;
        bad = 0;
        for (i = 0; i < `NN_G1_COUT; i = i + 1)
            if (u_eng.bufC[`NN_FC_CONV_IN + i] !== i[7:0]) begin
                bad = bad + 1;
                $display("  MISMATCH B2 g1[%0d] got=%02x exp=%02x", i, u_eng.bufC[`NN_FC_CONV_IN + i], i);
            end
        chkval("B2_G1_OUT_EQ_CH", bad, 0);
        chkval("B2_LOGIT0_SUM_CH_120", res_l0, 120);
        chkval("B2_LOGIT1_ZERO", res_l1, 0);
        chkval("B2_RUN_CYC_439981", run_cyc, 439981);

        //================ B3：clamp 上下饱和 + SH=0 ================
        rom_clear;
        rom_set(`NN_BG_BASE + 0, 32'd2000);
        rom_set(`NN_BG_BASE + 1, -32'd2000);
        rom_set(`NN_SHG_BASE + 0, 32'h0);
        rom_set(`NN_SHG_BASE + 1, 32'h0);
        rom_set(`NN_WFC_BASE + 0 * `NN_FC_CIN + `NN_FC_CONV_IN + 0, 32'h1);
        rom_set(`NN_WFC_BASE + 1 * `NN_FC_CIN + `NN_FC_CONV_IN + 0, -32'sd3);
        rom_set(`NN_SHFC_BASE + 0, 32'h0);
        rom_set(`NN_SHFC_BASE + 1, 32'h0);
        do_run;
        chkval("B3_G1_CLAMP_POS_127", u_eng.bufC[`NN_FC_CONV_IN + 0], 127);
        chkval("B3_G1_CLAMP_NEG_RELU_0", u_eng.bufC[`NN_FC_CONV_IN + 1], 0);
        chkval("B3_FC_POS_SAT_127", res_l0, 127);
        chkval("B3_FC_NEG_SAT_M128", res_l1, 8'h80);

        //================ B4：平局（两路 logit 相等）=================
        rom_clear;
        rom_set(`NN_BG_BASE + 1, 32'd5);
        rom_set(`NN_SHG_BASE + 1, 32'h0);
        rom_set(`NN_WFC_BASE + 0 * `NN_FC_CIN + `NN_FC_CONV_IN + 1, 32'h1);
        rom_set(`NN_WFC_BASE + 1 * `NN_FC_CIN + `NN_FC_CONV_IN + 1, 32'h1);
        rom_set(`NN_SHFC_BASE + 0, 32'h0);
        rom_set(`NN_SHFC_BASE + 1, 32'h0);
        do_run;
        chkval("B4_LOGIT0_5", res_l0, 5);
        chkval("B4_LOGIT1_5", res_l1, 5);
        chk("B4_TIE_EQUAL", (res_l0 === res_l1));
        $display("INFO B4 tie logits equal -> nn_decide picks smaller class index (class0)");

        //================ B5：conv3 侧分界(239) 与 g1 落点(240) ================
        rom_clear;
        rom_set(`NN_B3_BASE + 23, 32'h1);
        rom_set(`NN_SH3_BASE + 23, 32'h0);
        rom_set(`NN_WFC_BASE + 0 * `NN_FC_CIN + 239, 32'h1);
        rom_set(`NN_WFC_BASE + 0 * `NN_FC_CIN + `NN_FC_CONV_IN + 0, 32'h0);
        rom_set(`NN_WFC_BASE + 1 * `NN_FC_CIN + `NN_FC_CONV_IN + 0, 32'h1);
        rom_set(`NN_BG_BASE + 0, 32'h2);
        rom_set(`NN_SHG_BASE + 0, 32'h0);
        rom_set(`NN_SHFC_BASE + 0, 32'h0);
        rom_set(`NN_SHFC_BASE + 1, 32'h0);
        do_run;
        chkval("B5_BUF239_CONV3_1", u_eng.bufC[239], 1);
        chkval("B5_BUF240_G1_2", u_eng.bufC[`NN_FC_CONV_IN + 0], 2);
        chkval("B5_LOGIT0_FROM_239", res_l0, 1);
        chkval("B5_LOGIT1_FROM_240", res_l1, 2);

        $display("INFO_CHECK_TOTAL=%0d", chk_cnt);
        $display("INFO_ERRORS=%0d", err_cnt);
        if (err_cnt == 0) $display("TEST_RESULT=PASS");
        else              $display("TEST_RESULT=FAIL (errors=%0d)", err_cnt);
        $finish;
    end

    // 看门狗：正常 11 次推理约 97 ms 仿真时间
    initial begin
        #400_000_000;
        $display("TIMEOUT: engine did not finish");
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
