//==============================================================================
// tb_nn_top —— nn_top 端到端自检（事件流 -> 特征累积 -> 200 MHz 推理 -> 决策）
//
// 【验证思路】
//   TB 在 #1 通过分层赋值把 nn_rom_data.rom[0:`NN_ROM_WORDS-1] 覆盖成一个**稀疏可控网络**：
//   （★ M3e/task-51：ROM 改为 v7 5652 字（含 g1 段）。本 TB 只写 conv1/2/3 的
//     och0-cin0 / och1-cin1 单 tap 与 fc row1 的两个 tap，其余（含 g1_b/g1_w/fc 的
//     240..255 段）全 0 ⇒ g1 输出恒 0，logit 几何与旧 2 类版本相同。
//     NUM_CLASSES=2 时第 3 路 logit 仍由 nn_decide 钉成 -128，W7..W9 的 OFF 窗为 class1。）
//     · conv1/2/3 只保留 och0-cin0 与 och1-cin1 的**单一空间 tap** 权重 = 1；
//     · fc：logit0 全 0；logit1 = L3[ch0][pos] + L3[ch1][pos]；logit2 = 2*L3[ch1][pos]；
//     · bias / SH 全 0（>>0，无饱和 ⇒ 计数原样穿过）。
//   ★ M3c（绝对重新居中）后的信号链：TB 的事件全部落在中心像素 (200,120)，质心恒
//     (200,120) ⇒ 平移量恒 0 ⇒ 网格 cell(25,15)（= CELL_Y*NN_GRID_W+CELL_X = 775）。
//     该 cell 在卷积金字塔里的唯一穿透路径（输出像素读输入 (2o+ky,2o+kx)）：
//       grid(15,25) -tap(1,1)-> L1(7,12) -tap(1,0)-> L2(3,6) -tap(1,0)-> L3(1,3)
//     L3(1,3) 在 bufC 的下标 = 1*NN_L3_WO+3 = 8 ⇒ fc cin8（ON 通道）/ cin18（OFF 通道）。
//     （三个 tap 坐标全为奇数/唯一父节点，保证每个事件只穿透一次、不叠双计）
//   ⇒ logit0=0、logit1=ON事件数+OFF事件数、logit2=2*OFF事件数（每窗独立）。
//
//   于是可以用"每窗发几个 ON/OFF 事件"精确构造 logit / argmax / margin：
//     W0 空窗          -> [0,0,0]      class0 无 pulse
//     W1 ON 2          -> [0,2,0]      class1 margin2 < 8 不命中（margin 门槛）
//     W2..W4 ON 20×3   -> [0,20,0]     连续 3 窗同类别 -> PULSE#1 class1 conf20
//     W5 ON 20         -> refractory 内，不 pulse
//     W6 ON25+OFF20    -> [0,45,40]    class1 margin5 < 8 不命中（OFF 确实进张量）
//     W7 OFF 30        -> [0,30,60]    class2 第 1 窗（refractory 在 12.28 ms 结束）
//     W8 OFF 30        -> [0,30,60]    class2 第 2 窗
//     W9 OFF 40        -> [0,40,80]    class2 第 3 窗 -> PULSE#2 conf=min(40,31)=31
//     W10 空窗         -> [0,0,0]      不应再产生 pulse
//
// 【时序事实】窗口 = 66,000 clk_cam 拍（含 3,001 拍冻结拷贝）；一次推理
//   = 56,024 clk_cam 拍 ⇒ 决策在窗口边界 +56,030 拍左右出现，远早于下一个边界。
//   TB 以 o_dbg_win 沿为节拍：第 n 个边界 P_n 之前发的是第 n-1 个数据窗；
//   在 P_m 处可以检查 decision(W_{m-3})。
//==============================================================================
`timescale 1ns / 1ps
`include "../../src/hdl/nn/nn_cfg.vh"

module tb_nn_top;

    // 压测参数：WIN_CYC 缩到 500,000 拍（10 ms）。M3-fix v2 单时钟串行引擎一次推理
    // 实测 440,087 拍，加 3,001 拍冻结拷贝 = 443,088 < 500,000，仍有 5.7 万拍余量；
    // 产品值 NN_WIN_CYC=5,000,000 时余量更大。
    localparam WIN_CYC    = 500000;
    localparam REFRACTORY = 1200000;    // 24 ms ≈ 2.4 个窗（与原 2.3 窗同构）
    localparam MARGIN_MIN = `NN_MARGIN_MIN;  // M4g: deployment default (16), no longer hardcoded 8
    localparam N_CONSEC   = 3;

    // M3c（绝对重新居中）后网格坐标 = (x - (prev_cx-200))>>3。TB 把所有事件都放在
    // 图像中心像素 (200,120)：质心恒为 (200,120) ⇒ 平移量恒为 0，网格落点固定；
    // 若仍按老 TB 发在 cell(0,0)（x,y 在 0..7），质心 0 ⇒ 下一窗平移 -200 px，
    // 事件会被搬到格 (25,15)，老 TB 的 cell(0,0) 断言全部落空（见 EVIDENCE_M3c §5）。
    localparam integer EV_X = 200;                    // \`NN_IMG_W/2
    localparam integer EV_Y = 120;                    // \`NN_IMG_H/2
    localparam integer CELL_X = EV_X / 8;             // 25
    localparam integer CELL_Y = EV_Y / 8;             // 15
    localparam integer CELL_I = CELL_Y * `NN_GRID_W + CELL_X;   // 15*50+25 = 775
    // 稀疏网络几何（推导见 EVIDENCE_M3c §5）：
    //   grid(15,25) -conv1 tap(1,1)-> L1(7,12) -conv2 tap(1,0)-> L2(3,6)
    //   -conv3 tap(1,0)-> L3(1,3) -> fc 输入下标 = 1*5+3 = 8
    localparam integer L1_TAP = 4;   // (ky,kx)=(1,1) -> 1*3+1
    localparam integer L2_TAP = 3;   // (ky,kx)=(1,0) -> 1*3+0
    localparam integer L3_TAP = 3;   // (ky,kx)=(1,0)
    localparam integer FC_IDX = 8;   // L3 pos (oy=1,ox=3) -> 1*5+3

    //--------------------------------------------------------------------------
    // 时钟 / 复位（clk_cam 50 MHz、clk_200m 200 MHz）
    //--------------------------------------------------------------------------
    reg clk_cam  = 1'b0;
    reg clk_200m = 1'b0;
    always #10  clk_cam  = ~clk_cam;
    always #2.5 clk_200m = ~clk_200m;

    reg rst_n_cam  = 1'b0;
    reg rst_n_200m = 1'b0;

    reg        i_ev_valid = 1'b0;
    reg [8:0]  i_ev_x = 9'd0;
    reg [7:0]  i_ev_y = 8'd0;
    reg        i_ev_pol = 1'b0;

    wire        o_act_pulse;
    wire [1:0]  o_act_class;
    wire [4:0]  o_act_conf;
    wire        o_dbg_win;
    wire        o_dbg_busy;

    nn_top #(
        .WIN_CYC        (WIN_CYC),
        .REFRACTORY_CYC (REFRACTORY),
        .MARGIN_MIN     (MARGIN_MIN),
        .N_CONSEC       (N_CONSEC)
    ) dut (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n_cam),
        .i_ev_valid  (i_ev_valid),
        .i_ev_x      (i_ev_x),
        .i_ev_y      (i_ev_y),
        .i_ev_pol    (i_ev_pol),
        .o_act_pulse (o_act_pulse),
        .o_act_class (o_act_class),
        .o_act_conf  (o_act_conf),
        .o_dbg_win   (o_dbg_win),
        .o_dbg_busy  (o_dbg_busy),
        .clk_200m    (clk_200m),
        .rst_n_200m  (rst_n_200m)
    );

    //--------------------------------------------------------------------------
    // 计分 + 监视
    //--------------------------------------------------------------------------
    integer errors = 0;
    integer checks = 0;
    integer pulse_cnt = 0;
    integer win_runs  = 0;
    integer eng_runs  = 0;
    integer busy_ovl  = 0;
    reg [1:0] cap_class = 2'd0;
    reg [4:0] cap_conf  = 5'd0;
    reg       busy_d = 1'b0;
    integer t_win_pulse = 0;
    integer t_busy_rise = 0;
    integer t_busy_fall = 0;
    // 最近一次决策的锁存值（用于验证"两侧极性混合窗"的 logit/argmax/margin 算术）
    reg signed [7:0] dec_l1_cap     = 8'sd0;
    reg signed [7:0] dec_l2_cap     = 8'sd0;
    reg [1:0]        dec_class_cap  = 2'd0;
    reg [7:0]        dec_margin_cap = 8'd0;

    always @(posedge clk_cam) begin
        busy_d <= o_dbg_busy;
        if (o_dbg_win === 1'b1) begin
            win_runs    = win_runs + 1;
            t_win_pulse = $time;
            // 引擎必须在下一个窗口边界之前结束（不允许跨窗）
            if (o_dbg_busy === 1'b1) busy_ovl = busy_ovl + 1;
        end
        if ((o_dbg_busy === 1'b1) && (busy_d === 1'b0)) begin
            t_busy_rise = $time;
            eng_runs    = eng_runs + 1;
        end
        if ((o_dbg_busy === 1'b0) && (busy_d === 1'b1)) t_busy_fall = $time;
        if (o_act_pulse === 1'b1) begin
            pulse_cnt = pulse_cnt + 1;
            cap_class = o_act_class;
            cap_conf  = o_act_conf;
        end
    end

    // 每个窗口边界都应恰好启动一次引擎（v2 单时钟：数 busy 上升沿；busy 只在 i_start 后拉起）

    // 每次决策打印一行（调试用；判定只看 CHECK= 行）
    always @(posedge clk_cam) begin
        if (dut.u_dec.res_vld === 1'b1) begin
            dec_l1_cap     <= dut.u_dec.s1;
            dec_l2_cap     <= dut.u_dec.s2;
            dec_class_cap  <= dut.u_dec.cmb_c;
            dec_margin_cap <= dut.u_dec.cmb_m;
            $display("DEC t=%0t l0=%0d l1=%0d l2=%0d c=%0d m=%0d hit=%b cnt=%0d cnt_new=%0d refr=%0d refr_done=%b",
                     $time, $signed(dut.u_dec.s0), $signed(dut.u_dec.s1), $signed(dut.u_dec.s2),
                     dut.u_dec.cmb_c, dut.u_dec.cmb_m, dut.u_dec.cmb_hit,
                     dut.u_dec.hit_cnt, dut.u_dec.cnt_new, dut.u_dec.refr_cnt,
                     dut.u_dec.pulse_now);
        end
    end

    //--------------------------------------------------------------------------
    // 判据任务
    //--------------------------------------------------------------------------
    task chk;
        input [8*64-1:0] nm;
        input            cond;
        begin
            checks = checks + 1;
            if (cond === 1'b1) $display("CHECK=%0s PASS", nm);
            else begin
                errors = errors + 1;
                $display("CHECK=%0s FAIL", nm);
            end
        end
    endtask

    task chk_int;
        input [8*64-1:0] nm;
        input integer    got;
        input integer    exp;
        begin
            checks = checks + 1;
            if (got === exp) $display("CHECK=%0s PASS", nm);
            else begin
                errors = errors + 1;
                $display("CHECK=%0s FAIL got=%0d exp=%0d", nm, got, exp);
            end
        end
    endtask

    task chk_range;
        input [8*64-1:0] nm;
        input integer    got;
        input integer    lo;
        input integer    hi;
        begin
            checks = checks + 1;
            if ((got >= lo) && (got <= hi)) $display("CHECK=%0s PASS", nm);
            else begin
                errors = errors + 1;
                $display("CHECK=%0s FAIL got=%0d range=[%0d,%0d]", nm, got, lo, hi);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 激励任务
    //--------------------------------------------------------------------------
    integer t_pulse = 0;
    integer t_p1 = 0;
    integer per_a = 0;
    integer per_b = 0;
    reg [1:0] bank_cap = 2'd0;
    reg [1:0] bank_now_cap = 2'd0;

    // 等一个窗口边界（o_dbg_win 单拍），并记下时间与刚冻结的 bank
    task wait_win;
        begin
            @(posedge clk_cam);
            while (o_dbg_win !== 1'b1) @(posedge clk_cam);
            t_pulse      = $time;
            bank_now_cap = dut.win_bank;
            repeat (6) @(posedge clk_cam);
        end
    endtask

    // 单拍事件（在 negedge 驱动，posedge 采样正好一次）
    task send_ev;
        input [8:0] x;
        input [7:0] y;
        input       pol;
        begin
            @(negedge clk_cam);
            i_ev_valid = 1'b1;
            i_ev_x     = x;
            i_ev_y     = y;
            i_ev_pol   = pol;
            @(negedge clk_cam);
            i_ev_valid = 1'b0;
            @(negedge clk_cam);
        end
    endtask

    // 在中心像素 (200,120) 上发 n 个事件（M3c：质心恒在中心 ⇒ 平移量为 0，
    // 网格落点固定为 cell(CELL_X,CELL_Y)；重复同一像素对计数无影响）
    task send_ctr;
        input integer n;
        input         pol;
        reg [7:0] kk;
        begin
            for (kk = 8'd0; kk < n; kk = kk + 8'd1) begin
                send_ev(EV_X[8:0], EV_Y[7:0], pol);
            end
        end
    endtask

    //--------------------------------------------------------------------------
    // 稀疏网络：覆盖权重 ROM（#1：晚于 nn_rom_data 的 initial，早于首次推理）
    //--------------------------------------------------------------------------
    integer ri;
    initial begin
        #1;
        for (ri = 0; ri < `NN_ROM_WORDS; ri = ri + 1)
            dut.u_rom.u_rom_data.rom[ri] = 32'd0;

        // ---- M3c 中心事件几何（推导见文件头与 EVIDENCE_M3c §5）----
        // ON  链: och0/cin0 -conv1 tap(1,1)-> -conv2 tap(1,0)-> -conv3 tap(1,0)->
        // OFF 链: och1/cin1 -conv1 tap(1,1)-> -conv2 tap(1,0)-> -conv3 tap(1,0)->
        // 权重下标 = och*T + cin*9 + (ky*3+kx)；T=L1/2/3_T（36/72/144）
        dut.u_rom.u_rom_data.rom[`NN_W1_BASE + 0*`NN_L1_T + 0*9 + L1_TAP] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_W1_BASE + 1*`NN_L1_T + 1*9 + L1_TAP] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_W2_BASE + 0*`NN_L2_T + 0*9 + L2_TAP] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_W2_BASE + 1*`NN_L2_T + 1*9 + L2_TAP] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_W3_BASE + 0*`NN_L3_T + 0*9 + L3_TAP] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_W3_BASE + 1*`NN_L3_T + 1*9 + L3_TAP] = 32'd1;
        // fc: logit1 = L3[ch0][pos8](ON) + L3[ch1][pos8](OFF)；logit2 = 2*L3[ch1][pos8]
        // bufC 下标 = och*NN_L3_OUTHW + pos，pos = FC_IDX = 8
        dut.u_rom.u_rom_data.rom[`NN_WFC_BASE + 1*`NN_FC_CIN + FC_IDX] = 32'd1;
        dut.u_rom.u_rom_data.rom[`NN_WFC_BASE + 1*`NN_FC_CIN + (`NN_L3_OUTHW + FC_IDX)] = 32'd1;
        if (`NN_NUM_CLASSES >= 3)
            dut.u_rom.u_rom_data.rom[`NN_WFC_BASE + 2*`NN_FC_CIN + (`NN_L3_OUTHW + FC_IDX)] = 32'd2;
    end

    //--------------------------------------------------------------------------
    // 主流程
    //--------------------------------------------------------------------------
    integer t_meas0;

    initial begin
        $display("=== tb_nn_top: WIN_CYC=%0d REFRACTORY=%0d MARGIN_MIN=%0d N_CONSEC=%0d ===",
                 WIN_CYC, REFRACTORY, MARGIN_MIN, N_CONSEC);
        $display("DUT 参数: WIN_CYC=%0d REFRACTORY_CYC=%0d MARGIN_MIN=%0d N_CONSEC=%0d",
                 dut.WIN_CYC, dut.REFRACTORY_CYC, dut.MARGIN_MIN, dut.N_CONSEC);
        repeat (20) @(posedge clk_cam);
        rst_n_cam  = 1'b1;
        rst_n_200m = 1'b1;

        // ===================== P1：clear 9001 拍后的首个边界 =====================
        wait_win;
        t_p1 = t_pulse;
        chk("T0_READY_AFTER_CLEAR", dut.u_feat.o_ready === 1'b1);
        // W0：不发事件（class0 用例）

        // ===================== P2：冻结 W0（空窗）=====================
        wait_win;
        per_a = t_pulse - t_p1;
        send_ctr(2, 1'b1);                    // W1：ON 2

        // ===================== P3：decision(W0)=class0 =====================
        wait_win;
        per_b = t_pulse - t_p1 - per_a;
        chk("T1_WIN_PERIOD_STABLE", (per_a === per_b) && (per_a >= 9999960) && (per_a <= 10000040));
        chk_int("T2_CLASS0_NO_PULSE", pulse_cnt, 0);
        bank_cap = bank_now_cap;                // W1 冻结所在 bank
        chk_int("T3_TENSOR_ON_ONLY",  dut.u_feat.frz_mem[bank_cap*3000 + CELL_I], 2);
        chk_int("T3_TENSOR_OFF_ZERO", dut.u_feat.frz_mem[bank_cap*3000 + 1500 + CELL_I], 0);
        send_ctr(20, 1'b1);                   // W2：ON 20

        // ===================== P4：decision(W1)=margin 2 =====================
        wait_win;
        chk_int("T4_MARGIN_GATE_NO_PULSE", pulse_cnt, 0);
        send_ctr(20, 1'b1);                   // W3：ON 20

        // ===================== P5：decision(W2)=连续第 1 窗 =====================
        wait_win;
        chk_int("T5_CONSEC1_NO_PULSE", pulse_cnt, 0);
        send_ctr(20, 1'b1);                   // W4：ON 20

        // ===================== P6：decision(W3)=连续第 2 窗 =====================
        wait_win;
        chk_int("T5_CONSEC2_NO_PULSE", pulse_cnt, 0);
        send_ctr(20, 1'b1);                   // W5：ON 20（第 3 窗）

        // ===================== P7：decision(W4)=第 3 窗 -> PULSE#1 =====================
        wait_win;
        chk_int("T6_CONSEC3_PULSE1", pulse_cnt, 1);
        chk_int("T6_PULSE1_CLASS1", cap_class, 1);
        chk_int("T6_PULSE1_CONF20", cap_conf, 20);
        send_ctr(25, 1'b1);                   // W6：ON 25
        send_ctr(20, 1'b0);                   //      + OFF 20

        // ===================== P8：decision(W5) 在 refractory 内 =====================
        wait_win;
        chk_int("T7_REFRACTORY_BLOCK", pulse_cnt, 1);
        bank_cap = bank_now_cap;                // W6 冻结所在 bank
        chk_int("T8_TENSOR_BOTH_POL_ON",  dut.u_feat.frz_mem[bank_cap*3000 + CELL_I], 25);
        chk_int("T8_TENSOR_BOTH_POL_OFF", dut.u_feat.frz_mem[bank_cap*3000 + 1500 + CELL_I], 20);
        send_ctr(30, 1'b0);                   // W7：OFF 30

        // ===================== P9：decision(W6)=混合 margin 5 =====================
        wait_win;
        // W6 = ON25+OFF20：logit1=45、logit2=40、argmax=class1、margin=5 < 8 ⇒ 不命中
        // （该时刻亦在 refractory 内，但 margin 门槛独立成立）
        chk_int("T9_MIXED_LOGIT1",  $signed(dec_l1_cap), 45);
        if (`NN_NUM_CLASSES >= 3) begin
            chk_int("T9_MIXED_LOGIT2",  $signed(dec_l2_cap), 40);
            chk_int("T9_MIXED_CLASS1",  dec_class_cap, 1);
            chk_int("T9_MIXED_MARGIN5", dec_margin_cap, 5);
        end else begin
            // 2 类：logit2 被钉成 -128；logit1=45 vs max(0,-128) => margin 45
            chk_int("T9_MIXED_LOGIT2",  $signed(dec_l2_cap), -128);
            chk_int("T9_MIXED_CLASS1",  dec_class_cap, 1);
            chk_int("T9_MIXED_MARGIN_2CLS", dec_margin_cap, 45);
        end
        chk_int("T9_MIXED_MARGIN5_NO_HIT", pulse_cnt, 1);
        send_ctr(30, 1'b0);                   // W8：OFF 30 -> class2 第 2 窗

        // ===================== P10：decision(W7)=class2 连续第 1 窗 =====================
        wait_win;
        chk_int("TA_CLASS2_CONSEC1", pulse_cnt, 1);
        send_ctr(40, 1'b0);                   // W9：OFF 40 -> class2 第 3 窗（margin 40 -> conf 31）

        // ===================== P11：decision(W8)=class2 连续第 2 窗 =====================
        wait_win;
        chk_int("TA_CLASS2_CONSEC2", pulse_cnt, 1);
        // W10：不发事件（空窗 ⇒ decision=class0；且 pulse#2 后仍在 refractory 内）

        // ===================== P12：decision(W9)=连续第 3 窗 -> PULSE#2 =====================
        wait_win;
        chk_int("TB_CLASS2_PULSE2", pulse_cnt, 2);
        // 3 类：W7..W9 OFF 窗走 class2；2 类：第 3 路钉 -128，同一序列走 class1
        chk_int("TB_PULSE2_CLASS", cap_class, (`NN_NUM_CLASSES >= 3) ? 2 : 1);
        chk_int("TB_PULSE2_CONF31", cap_conf, 31);

        // 等最后一次推理结束（窗口边界 +44.3 万拍左右；v2 一次推理 440,087 拍）
        repeat (460000) @(posedge clk_cam);
        chk_int("TC_NO_SPURIOUS_PULSE", pulse_cnt, 2);
        chk_int("TD_ENGINE_ONE_PER_WIN", eng_runs - win_runs, 0);
        $display("  busy duration = %0d cycles, rise delay = %0d cycles",
                 (t_busy_fall - t_busy_rise) / 20, (t_busy_rise - t_win_pulse) / 20);
        chk_range("TE_BUSY_RISE_LE_100", (t_busy_rise - t_win_pulse) / 20, 0, 100);
        // ★ M3e/task-51（v7 融合引擎）：层链多一级 g1（16 像素 × 20 拍 = 320 拍），
        //   fc 输入 240 -> 256（每像素 +32 tap ⇒ +64 拍/2 像素），故 busy = 439,597+320+64
        //   = 439,981 拍（实测，见 EVIDENCE_M3e.md）。旧 2 类 439,597 的期望已失效。
        if (`NN_NUM_CLASSES >= 3)
            chk_range("TF_BUSY_DUR_440k", (t_busy_fall - t_busy_rise) / 20, 440000, 440200);
        else
            chk_range("TF_BUSY_DUR_V7_439981", (t_busy_fall - t_busy_rise) / 20, 439900, 440100);
        chk_int("TG_BUSY_NO_OVERLAP", busy_ovl, 0);
        chk_int("TH_NO_EVENT_DROP", dut.u_feat.o_dbg_drop, 0);
        chk_int("TI_WIN_COUNT", win_runs, 12);

        if (`NN_NUM_CLASSES < 3)
            $display("NOTE: NUM_CLASSES=2 -> class2 path skipped (fc row2 absent, logit2 pinned -128)");
        if (errors == 0) $display("TEST_RESULT=PASS (%0d checks)", checks);
        else             $display("TEST_RESULT=FAIL (%0d errors / %0d checks)", errors, checks);
        $finish;
    end

endmodule
