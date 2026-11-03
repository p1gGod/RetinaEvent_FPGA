//==============================================================================
// tb_sys_ctrl -- sys_ctrl 单模块仿真
// 判据（文档 §8）：V1 按键抖动 < 20 ms 不改变输出
//                 V2 **按一下只切换一次**（按住不动不再翻转）
//                 V3 松手后状态保持（不是"按住生效"）
//                 V4 工作点档位按 4 个**已验证预设**循环：
//                    (1,20) → (1,32) → (3,18) → (44,1) → 回 (1,20)
//                    且复位默认 = (1,20)（θ 与守卫必须**成对**译码，逐个核对数值）
//                 （补）图层预设 / 事件使能开关 / o_key_pressed 极性
//
// ⚠️ 按 skill 的实测经验（fpga-builder-amd §4 坑 8）：TB 用 parameter 把
//    消抖计数上限改小（2000 而非 1,000,000），否则一条 TB 要跑 20 ms 仿真时间。
//    CNT_MAX 的真实值由 RTL 参数表达式保证，单独核对即可。
//==============================================================================
`timescale 1ns / 1ps

module tb_sys_ctrl;

    localparam TB_FREQ    = 100000;     // 名义 100 kHz
    localparam TB_DEB_MS  = 20;
    localparam TB_CNT_MAX = TB_FREQ/1000*TB_DEB_MS;   // = 2000 拍

    reg clk = 1'b0;
    always #5 clk = ~clk;               // 100 MHz 实际时钟

    integer errors = 0;

    task chk_pass; input [8*32-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*32-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n_cam = 1'b0;
    reg  [3:0] i_key     = 4'b1111;

    wire       o_cfg_disp_mode;
    wire [1:0] o_mode;              // ★ v3：回传模式
    wire [1:0] o_cfg_theta_sel;
    wire [3:0] o_cfg_layer_en;
    wire       o_cfg_ev_en;
    wire [11:0] o_cfg_theta;
    wire [8:0]  o_cfg_min_dl;
    wire       o_stat_mode;
    wire [3:0] o_key_pressed;

    // ★ v3 下行写入通道（本 TB 不测下行，悬空安全：toggle 恒 0 无沿）
    wire [11:0] nc_theta = 12'd0;
    wire [8:0]  nc_mindl = 9'd0;
    wire [1:0]  nc_mode  = 2'd0;

    sys_ctrl #(
        .CLK_FREQ_HZ   (TB_FREQ),
        .DEBOUNCE_MS   (TB_DEB_MS),
        .THETA_ENTRIES (4)
    ) u_dut (
        .clk_cam         (clk),
        .rst_n_cam       (rst_n_cam),
        .i_key           (i_key),
        .i_mode_set_val  (nc_mode),
        .i_mode_set_upd  (1'b0),
        .i_theta_set_val (nc_theta),
        .i_theta_set_upd (1'b0),
        .i_min_dl_set_val(nc_mindl),
        .i_min_dl_set_upd(1'b0),
        .i_ev_en_set_val (1'b1),
        .i_ev_en_set_upd (1'b0),
        .o_cfg_disp_mode (o_cfg_disp_mode),
        .o_mode          (o_mode),
        .o_cfg_theta_sel (o_cfg_theta_sel),
        .o_cfg_layer_en  (o_cfg_layer_en),
        .o_cfg_ev_en     (o_cfg_ev_en),
        .o_cfg_theta     (o_cfg_theta),
        .o_cfg_min_dl    (o_cfg_min_dl),
        .o_stat_mode     (o_stat_mode),
        .o_key_pressed   (o_key_pressed)
    );

    // 工作点档位期望值（**必须与上位机 HOST_PRESETS 逐个一致**）
    //   0 = 运动区域 theta=1 / guard=20   ← 上电默认
    //   1 = 区域省流 theta=1 / guard=32
    //   2 = 运动边缘 theta=3 / guard=18
    //   3 = 旧板端   theta=44 / guard=1   （对照用）
    // 注意：$display 一律 ASCII —— ModelSim 按 GBK 写 console，中文会乱码（已知坑）。
    task chk_wp;
        input [1:0]  sel;
        input [11:0] exp_theta;
        input [8:0]  exp_md;
        input [8*40-1:0] nm;
        begin
            if ((o_cfg_theta === exp_theta) && (o_cfg_min_dl === exp_md))
                $display("CHECK=%0s PASS (theta=%0d guard=%0d)", nm, o_cfg_theta, o_cfg_min_dl);
            else begin
                $display("CHECK=%0s FAIL (sel=%0d got theta=%0d guard=%0d, exp theta=%0d guard=%0d)",
                         nm, sel, o_cfg_theta, o_cfg_min_dl, exp_theta, exp_md);
                errors = errors + 1;
            end
        end
    endtask

    // ---------------- 模式翻转次数监视 ----------------
    integer disp_changes = 0;
    reg     disp_prev    = 1'b0;
    always @(posedge clk) begin
        if (rst_n_cam) begin
            if (o_cfg_disp_mode !== disp_prev) begin
                disp_changes = disp_changes + 1;
                disp_prev    = o_cfg_disp_mode;
            end
        end else begin
            disp_prev = o_cfg_disp_mode;
        end
    end

    // ---------------- 按一下 / 松开 一个键 ----------------
    task press_key;
        input integer k;
        begin
            @(negedge clk); i_key[k] = 1'b0;                    // 按下
            repeat (TB_CNT_MAX + 200) @(posedge clk);           // 等消抖完成
            if (o_key_pressed[k] === 1'b1) begin
                $display("CHECK=key%0d_pressed_detected PASS", k);
            end else begin
                $display("CHECK=key%0d_pressed_detected FAIL", k);
                errors = errors + 1;
            end
            repeat (TB_CNT_MAX) @(posedge clk);                 // 继续按住
            @(negedge clk); i_key[k] = 1'b1;                    // 松开
            repeat (TB_CNT_MAX + 200) @(posedge clk);
            if (o_key_pressed[k] === 1'b0) begin
                $display("CHECK=key%0d_released_detected PASS", k);
            end else begin
                $display("CHECK=key%0d_released_detected FAIL", k);
                errors = errors + 1;
            end
        end
    endtask

    integer k;

    initial begin
        repeat (10) @(posedge clk);
        rst_n_cam = 1'b1;
        repeat (10) @(posedge clk);

        // ================= 复位默认值 =================
        if (o_cfg_disp_mode === 1'b0) chk_pass("RST_disp_mode_0"); else chk_fail("RST_disp_mode_0");
        if (o_mode === 2'd0)          chk_pass("RST_mode_raw_ev"); else chk_fail("RST_mode_raw_ev");
        if (o_cfg_theta_sel === 2'd0) chk_pass("RST_theta_sel_0"); else chk_fail("RST_theta_sel_0");
        if (o_cfg_layer_en  === 4'b1111) chk_pass("RST_layer_en_all_on"); else chk_fail("RST_layer_en_all_on");
        if (o_cfg_ev_en     === 1'b1) chk_pass("RST_ev_en_on"); else chk_fail("RST_ev_en_on");
        if (o_stat_mode     === 1'b0) chk_pass("RST_stat_mode_follows"); else chk_fail("RST_stat_mode_follows");
        if (o_key_pressed   === 4'b0000) chk_pass("RST_no_key_pressed"); else chk_fail("RST_no_key_pressed");

        // ================= V1: 抖动不改变输出 =================
        // 20 次 100 拍（= 5% 消抖时间）的毛刺，必须被完全滤掉
        for (k = 0; k < 20; k = k + 1) begin
            @(negedge clk); i_key[0] = 1'b0;
            repeat (100) @(posedge clk);
            @(negedge clk); i_key[0] = 1'b1;
            repeat (100) @(posedge clk);
        end
        if (disp_changes == 0) chk_pass("V1_bounce_rejected"); else chk_fail("V1_bounce_rejected");
        if (o_cfg_disp_mode === 1'b0) chk_pass("V1_mode_unchanged_after_bounce"); else chk_fail("V1_mode_unchanged_after_bounce");

        // ================= V2/V3: 按一下切换一次，松手保持 =================
        press_key(0);
        if (disp_changes == 1) chk_pass("V2_toggle_exactly_once"); else begin
            $display("CHECK=V2_toggle_exactly_once FAIL (changes=%0d)", disp_changes);
            errors = errors + 1;
        end
        if (o_cfg_disp_mode === 1'b1) chk_pass("V2_mode_now_event"); else chk_fail("V2_mode_now_event");
        if (o_stat_mode === 1'b1)     chk_pass("V2_stat_mode_follows"); else chk_fail("V2_stat_mode_follows");

        // 松手后长时间保持
        repeat (TB_CNT_MAX * 3) @(posedge clk);
        if (o_cfg_disp_mode === 1'b1 && disp_changes == 1)
            chk_pass("V3_holds_after_release");
        else
            chk_fail("V3_holds_after_release");

        // 再按一次 → 回到 0
        press_key(0);
        if (disp_changes == 2 && o_cfg_disp_mode === 1'b0) chk_pass("V2_second_press_toggles_back");
        else chk_fail("V2_second_press_toggles_back");

        // ================= V4: 工作点档位 0→1→2→3→0 =================
        // 复位后的档位 0 必须**已经是**已验证工作点 θ=1 / 守卫=20（上电即生效）
        chk_wp(2'd0, 12'd1, 9'd20, "V4_preset0_region_theta1_md20");
        press_key(1);
        if (o_cfg_theta_sel === 2'd1) chk_pass("V4_theta_1"); else begin
            $display("CHECK=V4_theta_1 FAIL (sel=%0d)", o_cfg_theta_sel); errors = errors + 1;
        end
        chk_wp(2'd1, 12'd1, 9'd32, "V4_preset1_lean_theta1_md32");
        press_key(1);
        if (o_cfg_theta_sel === 2'd2) chk_pass("V4_theta_2"); else begin
            $display("CHECK=V4_theta_2 FAIL (sel=%0d)", o_cfg_theta_sel); errors = errors + 1;
        end
        chk_wp(2'd2, 12'd3, 9'd18, "V4_preset2_edge_theta3_md18");
        press_key(1);
        if (o_cfg_theta_sel === 2'd3) chk_pass("V4_theta_3"); else begin
            $display("CHECK=V4_theta_3 FAIL (sel=%0d)", o_cfg_theta_sel); errors = errors + 1;
        end
        chk_wp(2'd3, 12'd44, 9'd1, "V4_preset3_legacy_theta44_md1");
        press_key(1);
        if (o_cfg_theta_sel === 2'd0) chk_pass("V4_theta_wrap_to_0"); else begin
            $display("CHECK=V4_theta_wrap_to_0 FAIL (sel=%0d)", o_cfg_theta_sel); errors = errors + 1;
        end
        // 绕回后必须又回到已验证工作点（不是绕回一个别的值）
        chk_wp(2'd0, 12'd1, 9'd20, "V4_wrap_back_to_region");
        // 非真空兜底：三档之间的 θ 必须**真的不同**（否则"档位"是装饰）
        press_key(1); press_key(1);      // → 2 (edge, theta=3)
        if (o_cfg_theta !== 12'd1) chk_pass("V4_theta_actually_changes"); else begin
            $display("CHECK=V4_theta_actually_changes FAIL (theta still %0d)", o_cfg_theta);
            errors = errors + 1;
        end
        press_key(1); press_key(1);      // → 0 回默认，后面的判据不受影响

        // ================= 图层预设轮换 =================
        press_key(2);
        if (o_cfg_layer_en === 4'b0111) chk_pass("L_layer_0111"); else chk_fail("L_layer_0111");
        press_key(2);
        if (o_cfg_layer_en === 4'b0011) chk_pass("L_layer_0011"); else chk_fail("L_layer_0011");
        press_key(2);
        if (o_cfg_layer_en === 4'b0001) chk_pass("L_layer_0001"); else chk_fail("L_layer_0001");
        press_key(2);
        if (o_cfg_layer_en === 4'b1111) chk_pass("L_layer_wrap_1111"); else chk_fail("L_layer_wrap_1111");

        // ================= KEY3：回传模式两态 RAW_EV ↔ EV_ONLY ================
        // ★ v3 键位裁决（2026-10-11）：原"事件支路使能"键位取消（o_cfg_ev_en 恒 1，
        //   v3.1 起由下行 EV_EN 命令控制）；KEY3 改绑回传模式两态切换，
        //   LCD 显示源随之投影（EV_ONLY ⇒ 事件画面，RAW_EV ⇒ KEY0 拍板）。
        press_key(3);
        if (o_mode === 2'd2) chk_pass("K3_mode_ev_only"); else chk_fail("K3_mode_ev_only");
        if (o_cfg_disp_mode === 1'b1) chk_pass("K3_disp_projects_event"); else chk_fail("K3_disp_projects_event");
        if (o_stat_mode === 1'b1)     chk_pass("K3_stat_mode_follows");   else chk_fail("K3_stat_mode_follows");
        press_key(3);
        if (o_mode === 2'd0) chk_pass("K3_mode_back_raw_ev"); else chk_fail("K3_mode_back_raw_ev");
        if (o_cfg_disp_mode === 1'b0) chk_pass("K3_disp_back_raw"); else chk_fail("K3_disp_back_raw");
        // 事件支路使能不再绑键：保持恒 1（下行 EV_EN 命令负责，见 tb_downlink_cmd）
        if (o_cfg_ev_en === 1'b1) chk_pass("K3_ev_en_const_on"); else chk_fail("K3_ev_en_const_on");

        // ================= 多键独立 =================
        @(negedge clk); i_key = 4'b1011;         // KEY2 按下（位 2 = 0）
        repeat (TB_CNT_MAX + 200) @(posedge clk);
        if (o_key_pressed === 4'b0100) chk_pass("MULTI_independent_polarity"); else begin
            $display("CHECK=MULTI_independent_polarity FAIL (pressed=%b)", o_key_pressed);
            errors = errors + 1;
        end
        @(negedge clk); i_key = 4'b1111;
        repeat (TB_CNT_MAX + 200) @(posedge clk);

        if (errors == 0) $display("TEST_RESULT=PASS"); else $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #20000000;
        $display("TEST_RESULT=FAIL (timeout)");
        $finish;
    end

endmodule
