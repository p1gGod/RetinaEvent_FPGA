//==============================================================================
// tb_mode_cdc.v —— ★ F3 复现/回归 TB：SET_MODE "值 + toggle" 两条独立同步链的
//                  CDC 竞态导致命令偶发**永久丢失**
//
// 【现场取证（v3 联板验证 2026-10-12，只读引用）】
//   · raw/item1_mode_write_5rounds.txt：5 轮 SET_MODE 1→0 中**轮 4 确认丢失**（读回仍=1）
//   · raw/item6_ws_record_75s.csv：66.1 s 一条 board.setMode(0) 收到 ACK ok:true，
//     但 65-75 s 桶 EVENTS 恒 0（MODE1 特征）、随后读回 TLV 0x81 mode=1
//   · 复现率 ≈2/44；对照 10 轮 20/20 生效 ⇒ 不是"下行丢包"（那个连 ACK 都没有）
//
// 【根因（代码级）】
//   源域（downlink_cmd.v:1272-1273）值与 toggle **同拍**翻转；跨域（top_retina_event.v
//   :186-192）用**两条互相独立的 sync_ff**（WIDTH 2 与 1、同为 2 级）⇒ 一级触发器在
//   同一目标域沿对两组信号**独立判决**，观察到"值新/toggle 新"最多差 1 个目标域周期。
//   消费侧（sys_ctrl.v:169）按 toggle 变化沿采值 ⇒ toggle 先到就采到**旧值**，
//   而 toggle 只翻一次（电平式）⇒ 该次写**永久丢失**。
//
// 【本 TB 的 DUT 由 .f 文件选择（同一份激励、同一套判据）】
//   · mode_cdc_dut_legacy.v = 修复前结构逐字副本 ⇒ 预期 TEST_RESULT=FAIL（复现）
//   · mode_cdc_dut_fixed.v  = 交付结构（cdc_tog_word 静默窗握手）⇒ 预期 PASS
//   两种运行都在本文件同一份激励下完成 ⇒ "修复前 FAIL / 修复后 PASS" 同源可比。
//
// 【激励：三种错拍用例（锚定最坏相位）】
//   命令发射锚定在 **clk_cam 上升沿 +1 ns**（最坏相位，确定性可复现），
//   再用"输入路径等效滞后"注入三种错拍（= 两条链判决差 / 走线偏斜的等效模型）：
//     K1 toggle 先到 ：值路径滞后 **1 个目标域周期（20 ns）** —— 判决差上界
//     K2 同拍       ：值路径滞后 2 ns（同拍 + 走线偏斜）
//     K3 toggle 后到 ：toggle 路径滞后 20 ns（值先到，对照）
//   K4：33 条命令轮转三种错拍 × 5 种锚点相位（统计口径）
//
// 【判据】每条命令后 30 个 clk_cam 拍内 o_mode（真实 sys_ctrl 输出）必须 = 下发值。
//==============================================================================
`timescale 1ns / 1ps

module tb_mode_cdc;

    //--------------------------------------------------------------------------
    // 时钟 / 复位
    //--------------------------------------------------------------------------
    reg clk_eth = 1'b0;
    reg clk_cam = 1'b0;
    always #4  clk_eth = ~clk_eth;      // 125 MHz 源域（= downlink_cmd/clk_eth）
    always #10 clk_cam = ~clk_cam;      // 50 MHz  目标域（= sys_ctrl/clk_cam）
    reg rst_n = 1'b0;

    integer errors = 0;
    integer lost_n = 0;
    task chk_pass; input [8*56-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*56-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1; lost_n = lost_n + 1;
    end endtask

    //--------------------------------------------------------------------------
    // 源域模型：值与 toggle **同拍**翻转（= downlink_cmd OP_SET_MODE 的真实行为）
    //--------------------------------------------------------------------------
    reg [1:0] src_val_r = 2'd0;
    reg       src_tog_r = 1'b0;

    //--------------------------------------------------------------------------
    // 错拍注入：DUT 输入路径等效滞后（决出"两条独立链判决差"的最坏情形）
    //   注意：延迟只加在 DUT 输入路径上（TB 侧），DUT 本身两个变体都不带延迟。
    //--------------------------------------------------------------------------
    wire [1:0] val_d0  = src_val_r;
    wire [1:0] val_d2;  assign #2  val_d2  = src_val_r;    // 走线偏斜 2 ns
    wire [1:0] val_d20; assign #20 val_d20 = src_val_r;    // 1 个目标域周期
    wire       tog_d0  = src_tog_r;
    wire       tog_d20; assign #20 tog_d20 = src_tog_r;

    reg  [1:0] skew_case = 2'd0;                          // 0=无 1=K2 2=K1 3=K3
    wire [1:0] dut_val = (skew_case == 2'd1) ? val_d2  :
                         (skew_case == 2'd2) ? val_d20 : val_d0;
    wire       dut_tog = (skew_case == 2'd3) ? tog_d20 : tog_d0;

    //--------------------------------------------------------------------------
    // DUT：跨域结构（由 .f 选择 legacy / fixed 变体，接口一致）
    //--------------------------------------------------------------------------
    wire [1:0] dst_val;
    wire       dst_tog;

    mode_cdc_dut u_dut (
        .dst_clk   (clk_cam),
        .dst_rst_n (rst_n),
        .i_val     (dut_val),
        .i_tog     (dut_tog),
        .o_val     (dst_val),
        .o_tog     (dst_tog)
    );

    //--------------------------------------------------------------------------
    // 真实消费者：sys_ctrl（一字不改；DUT 的输出接它的 mode 写入口）
    //--------------------------------------------------------------------------
    wire [1:0]  cfg_mode;
    wire [11:0] cfg_theta;
    wire [8:0]  cfg_min_dl;

    sys_ctrl #(
        .CLK_FREQ_HZ (1000),
        .DEBOUNCE_MS (100)      // ⚠️ 不可缩到 1（复位释放瞬态会被当成按键，见 tb_stall_repro）
    ) u_sc (
        .clk_cam              (clk_cam),
        .rst_n_cam            (rst_n),
        .i_key                (4'b1111),
        .i_mode_set_val       (dst_val),
        .i_mode_set_upd       (dst_tog),
        .i_theta_set_val      (12'd1),
        .i_theta_set_upd      (1'b0),
        .i_min_dl_set_val     (9'd20),
        .i_min_dl_set_upd     (1'b0),
        .i_ev_en_set_val      (1'b1),
        .i_ev_en_set_upd      (1'b0),
        .i_ev_res_set_val     (2'd0),
        .i_ev_res_set_upd     (1'b0),
        .i_ser_decim_set_val  (8'd32),
        .i_ser_decim_set_upd  (1'b0),
        .i_ser_agg_set_val    (2'd0),
        .i_ser_agg_set_upd    (1'b0),
        .i_ser_flush_set_val  (16'd20),
        .i_ser_flush_set_upd  (1'b0),
        .o_cfg_disp_mode      (),
        .o_mode               (cfg_mode),
        .o_cfg_theta_sel      (),
        .o_cfg_layer_en       (),
        .o_cfg_ev_en          (),
        .o_cfg_theta          (cfg_theta),
        .o_cfg_min_dl         (cfg_min_dl),
        .o_stat_mode          (),
        .o_key_pressed        (),
        .o_ev_res             (),
        .o_ser_decim          (),
        .o_ser_agg            (),
        .o_ser_flush_ms       ()
    );

    //--------------------------------------------------------------------------
    // 命令发射：值/toggle 同拍翻转，锚定 (posedge clk_cam)+anchor_ns
    //--------------------------------------------------------------------------
    task issue_cmd; input [1:0] v; input integer anchor_ns; begin
        @(posedge clk_cam);
        #(anchor_ns);
        src_val_r = v;                      // 阻塞赋值：值与 toggle 严格同拍
        src_tog_r = ~src_tog_r;
    end endtask

    // 单条命令判据：30 个目标域拍内 o_mode 必须 = 下发值
    integer k_wait;
    task check_cmd; input [1:0] want; input [8*56-1:0] nm; begin
        k_wait = 0;
        while ((cfg_mode !== want) && (k_wait < 30)) begin
            @(posedge clk_cam); k_wait = k_wait + 1;
        end
        if (cfg_mode === want) chk_pass(nm);
        else begin
            $display("  [LOST-WRITE] want mode=%0d got=%0d after %0d clk_cam cycles",
                     want, cfg_mode, k_wait);
            chk_fail(nm);
        end
    end endtask

    //--------------------------------------------------------------------------
    // 主激励
    //--------------------------------------------------------------------------
    integer i;
    integer lost_before_k4;
    initial begin
        $display("==== tb_mode_cdc: SET_MODE value/toggle CDC race (F3) ====");
        rst_n = 1'b0;
        repeat (20) @(posedge clk_cam);
        rst_n = 1'b1;
        repeat (20) @(posedge clk_cam);

        // ---------- K1：toggle 先到（判决差上界 = 1 目标域周期）----------
        skew_case = 2'd2;
        issue_cmd(2'd1, 1);  check_cmd(2'd1, "K1_toggle_first_val1");
        issue_cmd(2'd2, 1);  check_cmd(2'd2, "K1_toggle_first_val2");
        issue_cmd(2'd0, 1);  check_cmd(2'd0, "K1_toggle_first_val0");
        issue_cmd(2'd1, 1);  check_cmd(2'd1, "K1_toggle_first_val1b");

        // ---------- K2：同拍 + 值路径 2 ns 走线偏斜 ----------
        skew_case = 2'd1;
        issue_cmd(2'd2, 1);  check_cmd(2'd2, "K2_same_cycle_val2");
        issue_cmd(2'd0, 1);  check_cmd(2'd0, "K2_same_cycle_val0");
        issue_cmd(2'd1, 1);  check_cmd(2'd1, "K2_same_cycle_val1");
        issue_cmd(2'd2, 1);  check_cmd(2'd2, "K2_same_cycle_val2b");

        // ---------- K3：toggle 后到（值先到，对照）----------
        skew_case = 2'd3;
        issue_cmd(2'd0, 1);  check_cmd(2'd0, "K3_toggle_late_val0");
        issue_cmd(2'd1, 1);  check_cmd(2'd1, "K3_toggle_late_val1");
        issue_cmd(2'd2, 1);  check_cmd(2'd2, "K3_toggle_late_val2");
        issue_cmd(2'd0, 1);  check_cmd(2'd0, "K3_toggle_late_val0b");

        // ---------- K4：33 条命令轮转 3 种错拍 × 5 种锚点相位（统计口径）----------
        lost_before_k4 = lost_n;
        for (i = 0; i < 33; i = i + 1) begin
            case (i % 3)
                0: skew_case = 2'd2;            // toggle 先到
                1: skew_case = 2'd1;            // 同拍 + 偏斜
                default: skew_case = 2'd3;      // toggle 后到
            endcase
            // 值序列 0/1/2 轮转且保证与上一拍不同
            issue_cmd((i % 3) == 0 ? 2'd0 : ((i % 3) == 1 ? 2'd1 : 2'd2),
                      (i % 5) * 4 + 1);         // 锚点相位 1/5/9/13/17 ns
            k_wait = 0;
            while ((cfg_mode !== ((i % 3) == 0 ? 2'd0 : ((i % 3) == 1 ? 2'd1 : 2'd2))) &&
                   (k_wait < 30)) begin
                @(posedge clk_cam); k_wait = k_wait + 1;
            end
            if (cfg_mode !== ((i % 3) == 0 ? 2'd0 : ((i % 3) == 1 ? 2'd1 : 2'd2))) begin
                $display("  [LOST-WRITE-K4] cmd#%0d skew=%0d want=%0d got=%0d",
                         i, skew_case, ((i % 3) == 0 ? 2'd0 : ((i % 3) == 1 ? 2'd1 : 2'd2)), cfg_mode);
                lost_n = lost_n + 1;
            end
            @(posedge clk_cam); @(posedge clk_cam);
        end
        if (lost_n == lost_before_k4) chk_pass("K4_33cmds_no_lost_write");
        else                          chk_fail("K4_33cmds_no_lost_write");

        $display("  total lost writes = %0d", lost_n);
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL (errors=%0d)", errors);
        $finish;
    end

    //--------------------------------------------------------------------------
    // 超时保护
    //--------------------------------------------------------------------------
    initial begin
        #200000;
        $display("CHECK=timeout_no_hang FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule
