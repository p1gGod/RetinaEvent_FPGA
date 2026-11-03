//==============================================================================
// tb_retina_core_wp -- 「上位机已验证工作点」在 RTL 上的等价性判据（2026-10-06 适配）
//
// 为什么需要这个 TB（它不是 tb_retina_core 的重复）：
//   tb_retina_core 用 θ=74 / 守卫=2 / **不应期旁路** 跑一套固定图案，验证的是"引擎结构对不对"。
//   而现场在上位机上扫出来的**可用工作点是 θ=1 / 守卫=20**（旧板端 θ=44 在本场景下
//   等于全黑：实测 1.1 事件/帧）。板子能不能真的跑到那个工作点、跑出来跟上位机算的
//   是不是同一件事 —— 这两条 tb_retina_core 都回答不了（它压根到不了 θ=1）。
//
// 本 TB 的做法：
//   · 复用与 retina_core 完全相同的**算法链**（vps_resample → px_luma → luma_log →
//     temporal_diff → spatial_lap → event_gen → refractory），但直接由 vps_pattern_gen
//     驱动，绕开 cam_tap / vps_mux 的 DVP 时序与"帧边界切换"不确定性；
//   · 输入图案序列与 tb_retina_core / 上位机 pattern.ts 的 tbPatternSequence **逐帧一致**：
//       帧 1~2 = 棋盘格(CHK)  帧 3~6 = 均匀场(UNI)  帧 7~12 = 运动方块(BLK)  帧 13+ = 均匀场
//   · 对多组 (θ, 守卫, 不应期旁路) 各跑一遍同样的 13 帧，打印逐帧事件数，
//     并把**每一条事件**（帧号 x y pol）转储到 wp_events.txt 供上位机逐条对拍。
//
// ★ 自校验（本 TB 可信度的前提）：
//   第 0 遍 (θ=74, 守卫=2, 旁路) 必须复现 tb_retina_core 的**已知 golden**
//        0,0,5841,0,0,0,4,0,64,0,64,0,4
//   复现不了就说明本 TB 的驱动/对齐与真链路不一致，后面几遍的数字一律不可信 ⇒ 直接 FAIL。
//
// ★ 帧号映射（与 tb_retina_core 同一约定）：
//   vps_pattern_gen 的 o_vsync 出现在**场消隐期最后一行行首**，所以
//   "第 k 个 vsync 之后、第 k+1 个 vsync 之前"的可见像素 = 图案帧 k。
//   复位后先等第 1 个 vsync 再把链子使能 ⇒ 链子看到的第 1 个可见帧 = 图案帧 1。
//
// 判据打印：CHECK=<名字> PASS|FAIL；收口恰好一行 TEST_RESULT=PASS|FAIL
//==============================================================================
`timescale 1ns / 1ps

module tb_retina_core_wp;

    localparam IN_W    = 800;
    localparam IN_H    = 480;
    localparam EV_W    = 400;
    localparam EV_H    = 240;
    localparam H_TOTAL = 1056;
    localparam V_TOTAL = 525;
    localparam FRAME   = H_TOTAL * V_TOTAL;      // 554,400 拍/帧 @50MHz
    localparam NFRAMES = 13;                     // 对拍帧数（与 tbPatternSequence 一致）
    localparam NCLOSE  = NFRAMES + 1;            // 需要关闭的帧数（含帧 0）
    localparam MAXF    = 32;
    localparam NPASS   = 5;

    localparam PM_RAMP  = 2'd0;
    localparam PM_CHK   = 2'd1;
    localparam PM_BLOCK = 2'd2;
    localparam PM_UNIF  = 2'd3;

    // ======================= 时钟 =======================
    reg clk_cam = 1'b0;
    always #10 clk_cam = ~clk_cam;               // 50 MHz

    integer errors = 0;
    // ⚠️ 这些循环变量必须在**用到它们的 task 之前**声明：ModelSim 对"先用后声明"报
    //    `(vlog-2730) Undefined variable`（不是 warning，直接编译失败）。
    integer p, f, fi, gi;

    // ======================= 复位 / 图案源 =======================
    reg        rst_n    = 1'b0;
    reg        chain_en = 1'b0;                  // 链子使能（在第 1 个 vsync 之后拉高）
    reg [1:0]  pat_mode = PM_CHK;

    wire        pat_vsync;
    wire        pat_de;
    wire [15:0] pat_data;

    vps_pattern_gen #(
        .IMG_W (IN_W), .IMG_H (IN_H),
        .H_TOTAL (H_TOTAL), .V_TOTAL (V_TOTAL), .FRAME_DIV (1)
    ) u_pat (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n),
        .i_mode    (pat_mode),
        .i_en      (1'b1),                       // 自由扫描，帧号自己推进
        .o_vsync   (pat_vsync),
        .o_de      (pat_de),
        .o_data    (pat_data)
    );

    // ======================= 算法链（与 retina_core B4/B5/B6 逐级同构）=======================
    wire rs_vsync, rs_de;
    wire [15:0] rs_data;

    vps_resample #(
        .IN_W (IN_W), .IN_H (IN_H),
        .X_DECIM (2), .Y_DECIM (2),
        .OUT_W (EV_W), .OUT_H (EV_H)
    ) u_resample (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n),
        .i_vsync   (pat_vsync & chain_en),
        .i_de      (pat_de    & chain_en),
        .i_data    (pat_data),
        .o_vsync   (rs_vsync),
        .o_de      (rs_de),
        .o_data    (rs_data)
    );

    // 首帧抑制（照抄 retina_core 的 R2 修复：只把"带过像素的帧"计作第一帧）
    reg first_frame = 1'b1;
    reg vs_had_px   = 1'b0;
    always @(posedge clk_cam) begin
        if (!rst_n) begin
            first_frame <= 1'b1;
            vs_had_px   <= 1'b0;
        end else begin
            if (rs_de) vs_had_px <= 1'b1;
            if (rs_vsync) begin
                if (vs_had_px) first_frame <= 1'b0;
                vs_had_px <= 1'b0;
            end
        end
    end

    wire        l1_vsync, l1_de;
    wire [7:0]  l1_y;

    px_luma u_px_luma (
        .clk_cam   (clk_cam), .rst_n_cam (rst_n),
        .i_vsync   (rs_vsync), .i_de (rs_de), .i_data (rs_data),
        .o_vsync   (l1_vsync), .o_de (l1_de), .o_y (l1_y)
    );

    wire        l2_vsync, l2_de;
    wire [7:0]  l2_l;

    luma_log #(.ROM_LATENCY (1), .USE_ROM_IP (0)) u_luma_log (
        .clk_cam   (clk_cam), .rst_n_cam (rst_n),
        .i_vsync   (l1_vsync), .i_de (l1_de), .i_y (l1_y),
        .o_vsync   (l2_vsync), .o_de (l2_de), .o_l (l2_l)
    );

    wire        l3_vsync, l3_de;
    wire [8:0]  l3_dl;

    temporal_diff #(.IMG_W (EV_W), .IMG_H (EV_H)) u_temporal_diff (
        .clk_cam       (clk_cam), .rst_n_cam (rst_n),
        .i_vsync       (l2_vsync), .i_de (l2_de), .i_l (l2_l),
        .i_first_frame (first_frame),
        .o_vsync       (l3_vsync), .o_de (l3_de), .o_dl (l3_dl)
    );

    wire        l4_vsync, l4_de;
    wire [11:0] l4_lap;
    wire [8:0]  l4_x;
    wire [7:0]  l4_y;
    wire [8:0]  l4_dl_c;

    spatial_lap #(.IMG_W (EV_W), .EDGE_MODE (0)) u_spatial_lap (
        .clk_cam   (clk_cam), .rst_n_cam (rst_n),
        .i_vsync   (l3_vsync), .i_de (l3_de), .i_dl (l3_dl),
        .o_vsync   (l4_vsync), .o_de (l4_de), .o_lap (l4_lap),
        .o_x (l4_x), .o_y (l4_y), .o_dl_c (l4_dl_c)
    );

    // ---- 本遍的工作点（由 initial 按 pass 设置）----
    reg [11:0] theta_r = 12'd74;
    reg [8:0]  md_r    = 9'd2;
    reg        rb_r    = 1'b1;                   // 1 = 不应期旁路

    wire        eg_valid;
    wire [8:0]  eg_x;
    wire [7:0]  eg_y;
    wire        eg_pol;

    event_gen u_event_gen (
        .clk_cam   (clk_cam), .rst_n_cam (rst_n),
        .i_de      (l4_de), .i_lap (l4_lap), .i_dl_c (l4_dl_c),
        .i_x (l4_x), .i_y (l4_y),
        .i_theta (theta_r), .i_min_dl (md_r),
        .o_ev_valid (eg_valid), .o_ev_x (eg_x), .o_ev_y (eg_y), .o_ev_pol (eg_pol)
    );

    wire        ev_valid;
    wire [8:0]  ev_x;
    wire [7:0]  ev_y;
    wire        ev_pol;

    refractory #(.IMG_W (EV_W), .IMG_H (EV_H)) u_refractory (
        .clk_cam   (clk_cam), .rst_n_cam (rst_n),
        .i_vsync   (l4_vsync), .i_bypass (rb_r),
        .i_ev_valid (eg_valid), .i_ev_x (eg_x), .i_ev_y (eg_y), .i_ev_pol (eg_pol),
        .o_ev_valid (ev_valid), .o_ev_x (ev_x), .o_ev_y (ev_y), .o_ev_pol (ev_pol)
    );

    // ======================= 记分板 =======================
    // 帧号 = "已关闭的 vsync 个数"。pat_vsync 出现在帧尾消隐期 ⇒ 关闭的正是该帧。
    integer fc_idx  = 0;                         // 正在计数的帧号
    integer ev_cnt  = 0;                         // 本帧累计事件数
    integer pass_i  = 0;                         // 当前遍号
    integer counts  [0:MAXF-1];
    integer counts_all [0:NPASS*MAXF-1];

    // 事件转储（供上位机逐条对拍）
    integer fd_dump;
    reg     dump_on = 1'b0;

    // 坐标范围观测（判据 3 用）：有效栅格是 399×239 ⇒ x ≤ 398、y ≤ 238
    integer x_max = 0;
    integer y_max = 0;

    // ---- 判决级全字段转储（只对 pass1 的帧 3）----
    //   用途：pass3/pass4 相对 pass1 少了 793 个事件，必须看清**判决的输入**是什么，
    //   而不是继续推理。这里把 spatial_lap 的每一个有效输出（坐标 / lap / 中心 ΔL）
    //   原样落盘 ⇒ 可与上位机逐像素对拍，差异点一次定位。
    integer fd_l4;
    reg     l4_dump_on = 1'b0;

    always @(negedge clk_cam) begin
        if (rst_n && l4_dump_on && (pass_i == 1) && (fc_idx == 3) && l4_de) begin
            $fwrite(fd_l4, "%0d %0d %0d %0d\n",
                    l4_x, l4_y, $signed(l4_lap), $signed(l4_dl_c));
        end
    end

    // 在 negedge 采样：DUT 的寄存器都在 posedge 更新，negedge 上已稳定，无竞争
    always @(negedge clk_cam) begin
        if (rst_n) begin
            if (ev_valid) begin
                ev_cnt = ev_cnt + 1;
                if (ev_x > x_max) x_max = ev_x;
                if (ev_y > y_max) y_max = ev_y;
                if (dump_on) $fwrite(fd_dump, "%0d %0d %0d %0d %0d\n",
                                     pass_i, fc_idx, ev_x, ev_y, ev_pol);
            end
            if (pat_vsync) begin
                if (fc_idx < MAXF) counts[fc_idx] = ev_cnt;
                fc_idx = fc_idx + 1;
                ev_cnt = 0;
            end
        end
    end

    // ======================= 工具 =======================
    task chk;
        input [8*64-1:0] nm;
        input            cond;
        begin
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); errors = errors + 1; end
        end
    endtask

    // 等到"已关闭帧数"达到 target（在 posedge 之后 #1 采样，避开 negedge 记分板的竞争）
    task wait_closed;
        input integer target;
        integer g;
        begin
            g = 0;
            while ((fc_idx < target) && (g < 4000000)) begin
                @(posedge clk_cam); #1;
                g = g + 1;
            end
            if (fc_idx < target) begin
                $display("CHECK=WP_wait_closed_%0d FAIL (fc_idx=%0d)", target, fc_idx);
                errors = errors + 1;
            end
        end
    endtask

    // 等本帧的 vsync（用于复位后对齐到图案帧边界）
    task wait_one_vsync;
        integer g;
        begin
            g = 0;
            while ((pat_vsync !== 1'b1) && (g < 4000000)) begin
                @(posedge clk_cam); #1;
                g = g + 1;
            end
            if (g >= 4000000) begin
                $display("CHECK=WP_pat_vsync_timeout FAIL");
                errors = errors + 1;
            end
        end
    endtask

    // 复位整条链 + 图案源，然后在图案帧边界使能链子
    //
    // ⚠️ 必须**同时清记分板**（fc_idx / ev_cnt / counts）：
    //    第一版漏了这一步，于是第 2 遍起 fc_idx 还停在上一遍的 15，
    //    `wait_closed(1..14)` 全部立刻返回 ⇒ 五遍跑出来的计数**完全一样**（都是上一遍的残留）。
    //    那正是本 TB 要防的事（"档位根本没生效"），所以这个坑本身也值得写下来。
    //    记分板在 rst_n=0 期间不动作，所以这里清它是安全的（不会被它改回去）。
    task reset_and_align;
        begin
            chain_en = 1'b0;
            rst_n    = 1'b0;
            fc_idx   = 0;
            ev_cnt   = 0;
            x_max    = 0;
            y_max    = 0;
            for (fi = 0; fi < MAXF; fi = fi + 1) counts[fi] = 0;

            // ⚠️ 必须**显式清这两个 BRAM**：RTL 的 rst_n **故意不清它们**
            //    （temporal_diff.frame_mem / refractory.cool_mem 都是
            //     (* ram_style="block" *) 数组，只靠 initial 块做上电初始化；
            //      板上只上电一次，所以复位清它们没有意义）。
            //    但本 TB 要在**同一次仿真里跑 5 遍**：不手清的话，第 N 遍会带着
            //    第 N-1 遍的余晖位/帧存继续跑。
            //    实测后果（这是个值得记下来的假线索）：pass3 比 pass1 少 793 个事件，
            //    而且 pass3(θ=1,md=32) 与 pass4(θ=3,md=18) **给出完全相同的集合** ——
            //    两组不同参数给出同一结果，本身就是"参数没生效"的典型迹象。
            //    顺着它查下去才发现：RTL 的判决输入（lap / 中心 ΔL）在整帧 95,361 个
            //    像素上与上位机**逐点完全一致**，|ΔL| 只有 103 / 152 两种取值
            //    ⇒ 守卫 20 与 32 本来就该给出同一个集合。793 全是上一遍残留的冷却位造成的。
            for (fi = 0; fi < 12000; fi = fi + 1) u_refractory.cool_mem[fi] = 8'h00;
            for (fi = 0; fi < 96000; fi = fi + 1) u_temporal_diff.frame_mem[fi] = 8'h00;

            repeat (16) @(posedge clk_cam);
            @(negedge clk_cam);
            rst_n = 1'b1;
            // 复位后 frame_cnt=0：第 1 个 vsync 关闭图案帧 0 ⇒ 之后链子看到的是图案帧 1
            wait_one_vsync();
            @(posedge clk_cam); #1;
            chain_en = 1'b1;
        end
    endtask

    // ======================= 图案序列（与 tbPatternSequence 逐帧一致）=======================
    task set_mode_for_frame;
        input integer fno;
        begin
            if      (fno <= 2)  pat_mode = PM_CHK;
            else if (fno <= 6)  pat_mode = PM_UNIF;
            else if (fno <= 12) pat_mode = PM_BLOCK;
            else                pat_mode = PM_UNIF;
        end
    endtask

    // 期望的逐帧事件数（golden）—— 由 tb_retina_core 实测，见本文件头
    integer gold0 [0:NFRAMES-1];
    integer got1  [0:NFRAMES-1];
    integer got2  [0:NFRAMES-1];
    integer got3  [0:NFRAMES-1];
    integer got4  [0:NFRAMES-1];

    // 各遍的 (theta, 守卫, 旁路)
    integer th_tab [0:NPASS-1];
    integer md_tab [0:NPASS-1];
    integer rb_tab [0:NPASS-1];

    initial begin
        // ---- 已知 golden（θ=74 / 守卫=2 / 旁路）----
        gold0[ 0]=0;    gold0[ 1]=0;    gold0[ 2]=5841; gold0[ 3]=0;
        gold0[ 4]=0;    gold0[ 5]=0;    gold0[ 6]=4;    gold0[ 7]=0;
        gold0[ 8]=64;   gold0[ 9]=0;    gold0[10]=64;   gold0[11]=0;
        gold0[12]=4;

        // ---- 工作点表 ----
        //   0: θ=74 / 守卫=2  / 旁路  → 自校验（必须复现 gold0）
        //   1: θ=1  / 守卫=20 / 旁路  → ★ 上位机已验证工作点，**无余晖**（算法核心对拍）
        //   2: θ=1  / 守卫=20 / 余晖开 → ★ 板端实际生效配置
        //   3: θ=1  / 守卫=32 / 余晖开 → 区域·省流
        //   4: θ=3  / 守卫=18 / 余晖开 → 运动边缘
        th_tab[0]=74; md_tab[0]=2;  rb_tab[0]=1;
        th_tab[1]=1;  md_tab[1]=20; rb_tab[1]=1;
        th_tab[2]=1;  md_tab[2]=20; rb_tab[2]=0;
        th_tab[3]=1;  md_tab[3]=32; rb_tab[3]=0;
        th_tab[4]=3;  md_tab[4]=18; rb_tab[4]=0;

        fd_dump = $fopen("wp_events.txt", "w");
        if (fd_dump == 0) $display("  [warn] cannot open wp_events.txt");
        fd_l4 = $fopen("wp_l4_f3.txt", "w");
        if (fd_l4 == 0) $display("  [warn] cannot open wp_l4_f3.txt");
        $fdisplay(fd_l4, "# pass1 frame3 spatial_lap outputs: x y lap dl_c");
        $fdisplay(fd_dump, "# tb_retina_core_wp event dump");
        $fdisplay(fd_dump, "# pass frame x y pol");
        $fdisplay(fd_dump, "# pass0: theta=74 guard=2  bypass=1 (self-check vs tb_retina_core golden)");
        $fdisplay(fd_dump, "# pass1: theta=1  guard=20 bypass=1 (verified working point, no refractory)");
        $fdisplay(fd_dump, "# pass2: theta=1  guard=20 bypass=0 (board configuration)");
        $fdisplay(fd_dump, "# pass3: theta=1  guard=32 bypass=0 (region-lean)");
        $fdisplay(fd_dump, "# pass4: theta=3  guard=18 bypass=0 (edge)");
        dump_on = 1'b1;
        l4_dump_on = 1'b1;

        for (p = 0; p < NPASS; p = p + 1) begin
            pass_i  = p;
            theta_r = th_tab[p][11:0];
            md_r    = md_tab[p][8:0];
            rb_r    = rb_tab[p][0];

            reset_and_align();
            $display("  [pass%0d] theta=%0d guard=%0d bypass=%0d @%0t",
                     p, theta_r, md_r, rb_r, $time);

            // 逐帧推进：先把帧 f 的图案设好，再等它关闭
            for (f = 0; f <= NFRAMES; f = f + 1) begin
                set_mode_for_frame(f);
                wait_closed(f + 1);
            end

            // 取本遍帧 1..13 的计数（帧 0 是复位后的空帧，不计）
            for (f = 1; f <= NFRAMES; f = f + 1) begin
                if (f < MAXF) counts_all[p*MAXF + f] = counts[f];
            end
            $display("  [pass%0d] counts f1..f13 = %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d",
                     p,
                     counts[1], counts[2], counts[3], counts[4], counts[5], counts[6],
                     counts[7], counts[8], counts[9], counts[10], counts[11], counts[12],
                     counts[13]);
        end

        dump_on = 1'b0;
        l4_dump_on = 1'b0;
        $fclose(fd_dump);
        $fclose(fd_l4);

        // ==================================================================
        // 判据 1（自校验）：pass0 必须复现 tb_retina_core 的已知 golden
        //   复现不了 ⇒ 本 TB 的驱动/对齐不可信，后面几遍一律不算数
        // ==================================================================
        begin : selfcheck
            integer bad;
            bad = 0;
            for (f = 1; f <= NFRAMES; f = f + 1) begin
                if (counts_all[0*MAXF + f] !== gold0[f-1]) begin
                    bad = bad + 1;
                    $display("      pass0 frame%0d got=%0d exp=%0d",
                             f, counts_all[0*MAXF + f], gold0[f-1]);
                end
            end
            if (bad === 0)
                $display("CHECK=WP_pass0_reproduces_tb_retina_core_golden PASS");
            else begin
                $display("CHECK=WP_pass0_reproduces_tb_retina_core_golden FAIL (%0d frames differ)", bad);
                errors = errors + 1;
            end
        end

        // ==================================================================
        // 判据 2（非真空兜底）：pass1（θ=1/守卫=20）必须**明显多于** pass0
        //   这一条是"适配真的生效了"的直接证据：旧档位基本没输出，新工作点有输出
        // ==================================================================
        begin : nonvacuous
            integer s0, s1, s2, s3, s4;
            s0 = 0; s1 = 0; s2 = 0; s3 = 0; s4 = 0;
            for (f = 1; f <= NFRAMES; f = f + 1) begin
                s0 = s0 + counts_all[0*MAXF + f];
                s1 = s1 + counts_all[1*MAXF + f];
                s2 = s2 + counts_all[2*MAXF + f];
                s3 = s3 + counts_all[3*MAXF + f];
                s4 = s4 + counts_all[4*MAXF + f];
            end
            $display("  [TOTAL] pass0(theta74,md2)=%0d pass1(theta1,md20,noRefr)=%0d pass2(theta1,md20,Refr)=%0d pass3(theta1,md32)=%0d pass4(theta3,md18)=%0d",
                     s0, s1, s2, s3, s4);
            if (s1 > s0 * 4)
                $display("CHECK=WP_theta1_much_more_output_than_theta74 PASS (%0d vs %0d)", s1, s0);
            else begin
                $display("CHECK=WP_theta1_much_more_output_than_theta74 FAIL (%0d vs %0d)", s1, s0);
                errors = errors + 1;
            end

            // ---- 以下三条断言的是"相等"，而且**都是本图案的性质，不是算法缺陷** ----
            //   为什么必须写成相等：这套图案的取值太"粗"，根本切不出这几档的差别。
            //   判据输入已用机器核对过（spatial_lap 整帧 95,361 个输出的 lap / 中心 ΔL
            //   与上位机逐点一致）：帧 3 的中心 |ΔL| 只有 103 / 152 两种取值，
            //   |lap| 最小 26 —— 所以：
            //     守卫 20 与 32：|ΔL| ≥ 103 > 32 ⇒ 两者放行完全相同的像素
            //     θ=1 与 θ=3：|lap| ≥ 26 > 3  ⇒ 两者切出完全相同的像素
            //   要**区分**这几档必须用真实场景（上位机的 θ 扫描就是这么做的：
            //   docs/05_experiments/上位机实测_20261006/，孤立率 2.8% vs 14.2%）。
            //   这里断言相等，是为了"如果哪天它们不等了"能立刻发现（而不是当成噪声）。
            if (s3 === s1)
                $display("CHECK=WP_guard20_eq_guard32_on_this_pattern PASS (%0d == %0d)", s3, s1);
            else begin
                $display("CHECK=WP_guard20_eq_guard32_on_this_pattern FAIL (%0d != %0d)", s3, s1);
                errors = errors + 1;
            end
            if (s4 === s1)
                $display("CHECK=WP_theta1_eq_theta3_on_this_pattern PASS (%0d == %0d)", s4, s1);
            else begin
                $display("CHECK=WP_theta1_eq_theta3_on_this_pattern FAIL (%0d != %0d)", s4, s1);
                errors = errors + 1;
            end

            // ---- 不应期在本图案下**不该**改变任何东西 ----
            //   前提：没有任何像素会在相邻两帧都出事件（事件只出现在"变化帧"，
            //   而相邻两个变化帧之间至少隔一个 0 事件帧）⇒ 冷却位永远来不及拦人。
            //   所以这里先证前提、再断言 pass1 == pass2。真实场景下不应期当然会削事件。
            begin : refr_inert
                integer cf, bad_pairs;
                bad_pairs = 0;
                for (cf = 1; cf < NFRAMES; cf = cf + 1) begin
                    if ((counts_all[1*MAXF + cf] > 0) && (counts_all[1*MAXF + cf + 1] > 0))
                        bad_pairs = bad_pairs + 1;
                end
                if (bad_pairs === 0)
                    $display("CHECK=WP_no_consecutive_event_frames PASS");
                else begin
                    $display("CHECK=WP_no_consecutive_event_frames FAIL (%0d 对相邻帧都有事件)", bad_pairs);
                    errors = errors + 1;
                end
                if (s2 === s1)
                    $display("CHECK=WP_refractory_inert_on_this_pattern PASS (%0d == %0d)", s2, s1);
                else begin
                    $display("CHECK=WP_refractory_inert_on_this_pattern FAIL (%0d != %0d)", s2, s1);
                    errors = errors + 1;
                end
            end

            // 每个工作点都必须真的出事件（不能有"全黑"的档位）
            if ((s1 > 0) && (s2 > 0) && (s3 > 0) && (s4 > 0))
                $display("CHECK=WP_all_presets_nonvacuous PASS");
            else begin
                $display("CHECK=WP_all_presets_nonvacuous FAIL (s1=%0d s2=%0d s3=%0d s4=%0d)",
                         s1, s2, s3, s4);
                errors = errors + 1;
            end
        end

        // ==================================================================
        // 判据 3：坐标必须落在有效栅格内（399×239，x≤398 / y≤238）
        //   非真空兜底：必须真的见过事件（x_max>0 且 y_max>0），否则"都在范围内"恒真
        // ==================================================================
        $display("  [COORD] x_max=%0d y_max=%0d (valid grid: x<=398 y<=238)", x_max, y_max);
        if ((x_max === 0) || (y_max === 0)) begin
            $display("CHECK=WP_coord_nonvacuous FAIL (x_max=%0d y_max=%0d: no event seen)", x_max, y_max);
            errors = errors + 1;
        end else if ((x_max <= 398) && (y_max <= 238))
            $display("CHECK=WP_coord_within_valid_grid PASS (x_max=%0d y_max=%0d)", x_max, y_max);
        else begin
            $display("CHECK=WP_coord_within_valid_grid FAIL (x_max=%0d y_max=%0d)", x_max, y_max);
            errors = errors + 1;
        end

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    // 全局超时保护（5 遍 × 约 14 帧 × 554,400 拍 ≈ 39M 拍 = 780 ms）
    initial begin
        #900000000;
        $display("TEST_RESULT=FAIL (timeout-global)");
        $finish;
    end

endmodule
