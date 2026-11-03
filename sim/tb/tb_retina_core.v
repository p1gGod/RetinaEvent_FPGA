//==============================================================================
// tb_retina_core -- L3 事件引擎子系统（retina_core）端到端集成仿真
//
// 规格：retina_event/docs/子模块设计/L3_L4_集成/retina_core.md §8
// 实现阶段架构性决策见 src/hdl/subsys/retina_core.v 文件头
//   （事件按 event_gen 输出的绝对坐标写位图 + 帧末全位图衰减扫描）
//
// ★ 驱动方式（三处必须绕开的工程事实，均已在报告里给出证据）：
//   1) 不做真实 DVP 时序；视频源用内置图案源（i_cfg_src=1 → vps_pattern_gen）。
//   2) vps_mux 的"帧边界同步切换"判据取自 **A 路（相机）的 vsync 上升沿**
//      （vps_mux.v B1：if (a_al[17] & ~a_vs_d1) sel_r <= i_sel）。
//      A 路全静默 ⇒ 永远切不到图案源。故 TB 先给一次"最小相机帧起始"
//      （vsync 脉冲 + 2 字节 href ⇒ 组包出 1 个带 frame_pending 的像素）。
//   3) **上电时 sel_r 的初值不可依赖**（实测：X 解析后可能直接停在图案源，见报告
//      "复核结论"一节）。故复位期间 i_cfg_src=0，让 sel_r 无论如何都是 0（相机），
//      再在"图案帧 0 的垂直消隐期"改成 1 并触发相机帧起始 ⇒ 切换时刻完全确定，
//      引擎第 1 个"像素帧"必定 = 图案帧 1，后续帧号一一对齐。
//   4) 时钟：clk_cam 50MHz(20ns)、clk_lcd 25MHz(40ns)、cam_pclk≈48MHz(20.833ns)。
//
// ★ 预测模型（判据的算术依据）：
//   lum=0xFF→Y=255→L=255；lum=0x20→Y=32→L=43；lum=0x80→Y=81→L=101
//   运动方块 bx=100+n，2×2 抽点后覆盖事件列 [s(n), s(n)+32)，s(n)=50+ceil(n/2)；
//   行恒为 [200,264) → 事件行 [100,132)（32 行）
//   ⇒ 方块移动 1 个事件像素的那一帧：ΔL 只在"新前缘列"=+212、"旧后缘列"=−212 两列非零
//     ⇒ 4 邻域拉普拉斯 >>2 = ±106 ≥ θ=74 ⇒ **恰好 64 个事件**（前缘列全 ON、后缘列全 OFF）
//   ⇒ 同位置的帧 ΔL≡0 ⇒ 0 事件（2×2 抽点后每两帧才动 1 个事件像素）
//   ⇒ 移位帧 n：OFF 列 = 50 + n/2、ON 列 = 81 + (n+1)/2（整数除）
//
// ★ 帧号映射（重要，所有判据都按此编号）：
//   inc(k) = o_stat_frame_cnt 第 k 次递增 = 图案帧 (k-1) 的起点（k>=2）
//   窗口 k = inc(k-1)..inc(k) 之间的事件 = 图案帧 (k-2) 的事件（k>=3）
//   即：**图案帧 n 的事件 = win_ev[n+2]**
//   图案帧 1 = 引擎处理的第 1 个像素帧（帧存全 0，应被 i_first_frame 抑制）
//
// ★ 仿真规模：真实尺寸 IN_W=800/IN_H=480/EV_W=400/EV_H=240，H_TOTAL=1056/V_TOTAL=525
//   ⇒ 一帧 554,400 拍(clk_cam) = 11.088ms；共 23 帧 ≈ 246ms 仿真时间。
//
// 判据打印：CHECK=<名字> PASS|FAIL；收口恰好一行 TEST_RESULT=PASS|FAIL
//==============================================================================
`timescale 1ns / 1ps

module tb_retina_core;

    // ======================= 尺寸 / 几何常量 =======================
    localparam IN_W   = 800;
    localparam IN_H   = 480;
    localparam EV_W   = 400;
    localparam EV_H   = 240;
    localparam H_TOTAL = 1056;
    localparam V_TOTAL = 525;
    localparam FRAME  = H_TOTAL * V_TOTAL;      // 554,400 clk_cam 拍/帧
    localparam BLANK_T = IN_H * H_TOTAL;        // 506,880：垂直消隐起点
    localparam WPL    = EV_W / 2;               // 200 个 8bit 字/行
    localparam BMP_WORDS = EV_W * EV_H / 2;     // 48,000 字
    localparam THETA  = 74;                     // 与 event_gen 默认 θ=0.20 一致

    localparam PM_RAMP  = 2'd0;
    localparam PM_CHK   = 2'd1;                 // 棋盘格（静态）
    localparam PM_BLOCK = 2'd2;                 // 运动方块
    localparam PM_UNIF  = 2'd3;                 // 均匀场（静态）

    localparam MAXF  = 40;                      // 最多跟踪的帧窗口
    localparam MAXEV = 4096;                    // 每帧最多保存的事件坐标
    localparam CAP   = 4096;                    // 捕获环形缓冲
    localparam SERMAX = 16;                     // 衰减序列最大点数

    localparam [31:0] WAIT_GUARD = 32'd2000000; // 每个帧递增最多等 2M 拍（≈4 帧）

    // ======================= 时钟 =======================
    reg clk_cam = 1'b0;
    reg clk_lcd = 1'b0;
    reg cam_pclk = 1'b0;
    always #10      clk_cam  = ~clk_cam;        // 50 MHz
    always #20      clk_lcd  = ~clk_lcd;        // 25 MHz
    always #10.4165 cam_pclk = ~cam_pclk;       // ≈48 MHz（OV5640 PCLK 实测 20.833ns）

    // ======================= DUT =======================
    reg         rst_n_cam = 1'b0;
    reg  [7:0]  i_cam_data = 8'h00;
    reg         i_cam_vsync = 1'b0;
    reg         i_cam_href  = 1'b0;

    reg         i_cfg_ev_en = 1'b1;
    reg  [11:0] i_cfg_theta = THETA[11:0];
    reg  [8:0]  i_cfg_min_dl = 9'd2;
    reg  [1:0]  i_cfg_src = 2'd0;               // 复位期间 = 相机，保证 sel_r=0 确定
    reg  [1:0]  i_cfg_pattern_mode = PM_CHK;
    reg         i_cfg_decay_en = 1'b1;
    reg  [2:0]  i_cfg_decay_step = 3'd1;
    reg         i_cfg_refr_bypass = 1'b1;

    reg  [15:0] i_bmp_rd_addr = 16'h0000;

    wire        o_ev_valid;
    wire [8:0]  o_ev_x;
    wire [7:0]  o_ev_y;
    wire        o_ev_pol;
    wire [7:0]  o_bmp_rd_data;
    wire [23:0] o_stat_ev_per_frame;
    wire [15:0] o_stat_activity_q16;
    wire [23:0] o_stat_cr_x10;
    wire [31:0] o_stat_frame_cnt;
    wire [31:0] o_stat_ev_total;
    wire [15:0] o_stat_ev_fifo_ovf;
    wire [15:0] o_stat_px_fifo_ovf;

    wire        rst_n_pclk = rst_n_cam;   // 顶层由 sync_ff 同步；TB 直接同源（复位沿很慢，无碍）

    retina_core #(
        .IN_W (IN_W), .IN_H (IN_H), .EV_W (EV_W), .EV_H (EV_H),
        .DECAY_EN (1), .DECAY_STEP (1), .EVF_DEPTH (32), .PIPE_LAT (12)
    ) u_dut (
        .cam_pclk (cam_pclk), .rst_n_pclk (rst_n_pclk),
        .i_cam_data (i_cam_data), .i_cam_vsync (i_cam_vsync), .i_cam_href (i_cam_href),
        .clk_cam (clk_cam), .rst_n_cam (rst_n_cam), .clk_lcd (clk_lcd),
        .i_cfg_ev_en (i_cfg_ev_en), .i_cfg_theta (i_cfg_theta),
        .i_cfg_min_dl (i_cfg_min_dl), .i_cfg_src (i_cfg_src),
        .i_cfg_pattern_mode (i_cfg_pattern_mode), .i_cfg_decay_en (i_cfg_decay_en),
        .i_cfg_decay_step (i_cfg_decay_step), .i_cfg_refr_bypass (i_cfg_refr_bypass),
        .o_ev_valid (o_ev_valid), .o_ev_x (o_ev_x), .o_ev_y (o_ev_y), .o_ev_pol (o_ev_pol),
        .i_bmp_rd_addr (i_bmp_rd_addr), .o_bmp_rd_data (o_bmp_rd_data),
        .o_stat_ev_per_frame (o_stat_ev_per_frame), .o_stat_activity_q16 (o_stat_activity_q16),
        .o_stat_cr_x10 (o_stat_cr_x10), .o_stat_frame_cnt (o_stat_frame_cnt),
        .o_stat_ev_total (o_stat_ev_total),
        .o_stat_ev_fifo_ovf (o_stat_ev_fifo_ovf), .o_stat_px_fifo_ovf (o_stat_px_fifo_ovf)
    );

    // ======================= 记分板 / 监视器 =======================
    integer errors = 0;
    integer inc_count = 0;              // o_stat_frame_cnt 递增次数
    reg [31:0] fc_prev = 32'd0;
    integer tb_ev_total = 0;
    integer cap_n = 0;
    integer cap_x [0:CAP-1];
    integer cap_y [0:CAP-1];
    integer cap_p [0:CAP-1];
    integer cap_xmin = 0, cap_xmax = 0, cap_ymin = 0, cap_ymax = 0;

    integer win_ev   [0:MAXF];          // 窗口 k 内的事件数
    integer win_stat [0:MAXF];          // 同一时刻 o_stat_ev_per_frame 的值
    integer win_n    [0:MAXF];          // 已保存的坐标个数（截断到 MAXEV）
    integer win_ovf  [0:MAXF];
    integer frm_x [0:MAXF*MAXEV-1];
    integer frm_y [0:MAXF*MAXEV-1];
    integer frm_p [0:MAXF*MAXEV-1];
    integer inc_ns [0:MAXF];            // 每次递增的时刻（ns）
    integer win_px [0:MAXF];            // 每个窗口内 align_de_w 的拍数（= stats_counter 的 px_f，查丢像素）
    integer px_in_win = 0;
    integer stat_mid [0:MAXF];          // 同一帧"帧内中段"再采一次 o_stat_ev_per_frame（验稳定性）
    integer cyc_in_frame = 0;

    reg [255:0] exp_y_mask = 256'd0;    // 事件期望行 100..131
    integer jj, mm;

    // ---- 引擎输入图捕获（R3 契约 #2/#3 用：坐标必须"随流走"，与像素位置一致）----
    //   捕获 l1_y（px_luma 输出 = 抽点后亮度）按 de 脉冲顺序铺成 400×240 的图；
    //   每个 de 脉冲一个像素 ⇒ 图里的行/列就是引擎流里的行/列，可与事件 bbox 对拍。
    localparam MAPFRAMES = 10;          // 捕获 10 帧（奇偶交替：奇数帧=方块帧）
    localparam DECAY_OBS = 8;           // 余晖衰减观测点数（7,6,5,4,3,2,1,0 需要 8 点）
    localparam MAP_INC0  = 26;          // 相位E 起始递增号（= 17+DECAY_OBS+1）
    reg [7:0] img [0:MAPFRAMES*96000-1];
    integer cap_slot = -1;              // -1 = 关闭
    integer cap_pix  = 0;

    // 在 negedge 采样（各信号已稳定，避免与 DUT 的 NBA 同沿竞争）
    always @(negedge clk_cam) begin
        if (rst_n_cam === 1'b1) begin
            cyc_in_frame = cyc_in_frame + 1;
            if (u_dut.align_de_w === 1'b1) px_in_win = px_in_win + 1;   // 引擎每帧像素数（与 px_f 同源）
            if ((cyc_in_frame === 100000) && (inc_count >= 1) && (inc_count <= MAXF))
                stat_mid[inc_count] = o_stat_ev_per_frame;   // 帧内中段再采一次（应与帧首锁存值相同）
            if (cap_slot >= 0 && cap_slot < MAPFRAMES && cap_pix < 96000) begin
                if (u_dut.l1_de === 1'b1) begin
                    img[cap_slot*96000 + cap_pix] = u_dut.l1_y;
                    cap_pix = cap_pix + 1;
                end
            end
            if (o_ev_valid === 1'b1) begin
                tb_ev_total = tb_ev_total + 1;
                if (cap_n < CAP) begin
                    cap_x[cap_n] = o_ev_x;
                    cap_y[cap_n] = o_ev_y;
                    cap_p[cap_n] = o_ev_pol;
                    if (cap_n == 0) begin
                        cap_xmin = o_ev_x; cap_xmax = o_ev_x;
                        cap_ymin = o_ev_y; cap_ymax = o_ev_y;
                    end else begin
                        if (o_ev_x < cap_xmin) cap_xmin = o_ev_x;
                        if (o_ev_x > cap_xmax) cap_xmax = o_ev_x;
                        if (o_ev_y < cap_ymin) cap_ymin = o_ev_y;
                        if (o_ev_y > cap_ymax) cap_ymax = o_ev_y;
                    end
                end
                cap_n = cap_n + 1;
            end
            if (o_stat_frame_cnt !== fc_prev) begin
                fc_prev = o_stat_frame_cnt;
                inc_count = inc_count + 1;
                cyc_in_frame = 0;                   // 帧内计时复位（帧内中段采样用）
                if (cap_slot >= 0) begin            // 帧边界 ⇒ 换捕获槽（下一帧用下一个槽）
                    cap_slot = cap_slot + 1;
                    cap_pix  = 0;
                    if (cap_slot >= MAPFRAMES) cap_slot = -1;
                end
                // 逐窗口诊断（报告证据用）：包围盒 + 少量样本坐标
                $display("  [窗口%0d = 图案帧%0d] n=%0d bbox=(x %0d..%0d, y %0d..%0d)",
                         inc_count, inc_count-2, cap_n, cap_xmin, cap_xmax, cap_ymin, cap_ymax);
                if ((cap_n > 0) && (cap_n <= 200)) begin
                    for (mm = 0; mm < 12 && mm < cap_n; mm = mm + 1)
                        $display("        ev%0d: x=%0d y=%0d pol=%0d", mm, cap_x[mm], cap_y[mm], cap_p[mm]);
                end
                if (inc_count <= MAXF) begin
                    win_ev[inc_count]   = cap_n;
                    win_px[inc_count]   = px_in_win;
                    px_in_win           = 0;
                    win_stat[inc_count] = o_stat_ev_per_frame;
                    win_ovf[inc_count]  = (cap_n > MAXEV) ? 1 : 0;
                    win_n[inc_count]    = (cap_n > MAXEV) ? MAXEV : cap_n;
                    inc_ns[inc_count]   = $time;
                    for (mm = 0; mm < MAXEV; mm = mm + 1) begin
                        if (mm < cap_n) begin
                            frm_x[inc_count*MAXEV + mm] = cap_x[mm];
                            frm_y[inc_count*MAXEV + mm] = cap_y[mm];
                            frm_p[inc_count*MAXEV + mm] = cap_p[mm];
                        end
                    end
                end
                cap_n = 0;
            end
        end
    end

    initial begin
        for (jj = 100; jj <= 131; jj = jj + 1) exp_y_mask[jj] = 1'b1;
    end

    // ======================= 通用打印 =======================
    task chk;
        input [8*64-1:0] nm;
        input            cond;
        begin
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); errors = errors + 1; end
        end
    endtask

    task chk_int;
        input [8*64-1:0] nm;
        input integer    got;
        input integer    exp;
        begin
            if (got === exp) $display("CHECK=%0s PASS", nm);
            else begin
                $display("CHECK=%0s FAIL (got=%0d exp=%0d)", nm, got, exp);
                errors = errors + 1;
            end
        end
    endtask

    // 名字里带帧号的判据（名字用 $sformat 现场拼，避免 %0d 被当成字面量打印）
    task chk_fi;
        input [8*48-1:0] fmtstr;
        input integer    fno;
        input integer    got;
        input integer    exp;
        reg [8*64-1:0] nm;
        begin
            $sformat(nm, fmtstr, fno);
            if (got === exp) $display("CHECK=%0s PASS", nm);
            else begin
                $display("CHECK=%0s FAIL (got=%0d exp=%0d)", nm, got, exp);
                errors = errors + 1;
            end
        end
    endtask

    task chk_fb;
        input [8*48-1:0] fmtstr;
        input integer    fno;
        input            cond;
        reg [8*64-1:0] nm;
        begin
            $sformat(nm, fmtstr, fno);
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); errors = errors + 1; end
        end
    endtask

    task die;
        input [8*64-1:0] nm;
        begin
            $display("CHECK=%0s FAIL", nm);
            errors = errors + 1;
            $display("TEST_RESULT=FAIL errors=%0d (fatal)", errors);
            $finish;
        end
    endtask

    // ======================= 帧同步 / 激励 =======================
    task wait_inc;
        input integer target;
        integer guard;
        begin
            guard = 0;
            while ((inc_count < target) && (guard < WAIT_GUARD)) begin
                @(posedge clk_cam);
                guard = guard + 1;
            end
            if (inc_count < target) begin
                $display("  [fatal] 等待第 %0d 次帧递增超时（inc=%0d, guard=%0d）",
                         target, inc_count, guard);
                die("FRAME_sync_timeout");
            end
        end
    endtask

    // 相对"刚返回的帧起点"等到该帧的垂直消隐期（消隐 = 506880..554400 拍），
    // 在消隐期改配置 ⇒ 下一帧整帧生效，不会制造半帧错位。
    task wait_blank;
        begin
            repeat (BLANK_T + 20000) @(posedge clk_cam);
        end
    endtask

    // 最小相机"帧起始"：vsync 脉冲 + 2 字节 href ⇒ cam_tap 组出 1 个带 frame_pending 的像素
    //   ⇒ 该字出 FIFO 时 vps_vsync_cam 高 1 拍 ⇒ vps_mux 的 A 路沿 ⇒ sel_r 切到 i_sel。
    task cam_frame_start;
        begin
            @(negedge cam_pclk); i_cam_vsync = 1'b1; i_cam_href = 1'b0; i_cam_data = 8'hFF;
            repeat (4) @(negedge cam_pclk);
            @(negedge cam_pclk); i_cam_vsync = 1'b0;
            @(negedge cam_pclk); i_cam_href = 1'b1;  i_cam_data = 8'hAA;   // 字节 1
            @(negedge cam_pclk);                     i_cam_data = 8'h55;   // 字节 2
            @(negedge cam_pclk); i_cam_href = 1'b0;
            repeat (4) @(negedge cam_pclk);
        end
    endtask

    // ======================= 位图 B 口（clk_lcd 同步读，1 拍延迟）=======================
    task bmp_read;
        input  integer a;
        output [7:0]   d;
        begin
            @(negedge clk_lcd);
            i_bmp_rd_addr = a[15:0];
            @(posedge clk_lcd);
            #1 d = o_bmp_rd_data;
        end
    endtask

    function [3:0] nibble_of;
        input [7:0] w;
        input integer xbit;         // 该像素的 x[0]：0 = 低半字节，1 = 高半字节
        begin
            nibble_of = xbit ? w[7:4] : w[3:0];
        end
    endfunction

    function integer addr_of;
        input integer x, y;
        begin
            addr_of = y * WPL + (x >> 1);
        end
    endfunction

    // ======================= 主要事件分析 =======================
    // 检查"方块移动 1 个事件像素"的那一帧（图案帧 n）：恰好 64 个事件、2 列、每列 32 行
    // 行号 = 100..131、极性正确（前缘列 ON / 后缘列 OFF）
    task chk_change_frame;
        input integer fno;          // 图案帧号 n（窗口 = n+2）
        input integer exp_off;
        input integer exp_on;
        integer wk, ei, eidx, ex, ey, ep, bad, n_off, n_on;
        reg [255:0] ym_off, ym_on;
        begin
            wk = fno + 2;
            chk_fi("F%0d_change_event_count", fno, win_ev[wk], 64);
            n_off = 0; n_on = 0; bad = 0; ym_off = 256'd0; ym_on = 256'd0;
            for (ei = 0; ei < win_n[wk]; ei = ei + 1) begin
                eidx = wk*MAXEV + ei;
                ex = frm_x[eidx]; ey = frm_y[eidx]; ep = frm_p[eidx];
                if (ep === 0) begin
                    n_off = n_off + 1;
                    if ((ex !== exp_off) || (ey < 100) || (ey > 131)) bad = bad + 1;
                    else ym_off[ey] = 1'b1;
                end else begin
                    n_on = n_on + 1;
                    if ((ex !== exp_on) || (ey < 100) || (ey > 131)) bad = bad + 1;
                    else ym_on[ey] = 1'b1;
                end
            end
            chk_fi("F%0d_change_off_column_count", fno, n_off, 32);
            chk_fi("F%0d_change_on_column_count",  fno, n_on,  32);
            chk_fi("F%0d_change_coord_out_of_range", fno, bad, 0);
            chk_fb("F%0d_change_off_rows_100_131", fno, ym_off === exp_y_mask);
            chk_fb("F%0d_change_on_rows_100_131",  fno, ym_on  === exp_y_mask);
        end
    endtask

    // 该图案帧全部事件是否落在指定矩形内
    task chk_all_in_box;
        input [8*64-1:0] nm;
        input integer fno;
        input integer x0, x1, y0, y1;
        integer wk, ei, eidx, bad;
        begin
            wk = fno + 2; bad = 0;
            for (ei = 0; ei < win_n[wk]; ei = ei + 1) begin
                eidx = wk*MAXEV + ei;
                if ((frm_x[eidx] < x0) || (frm_x[eidx] > x1) ||
                    (frm_y[eidx] < y0) || (frm_y[eidx] > y1)) bad = bad + 1;
            end
            if (win_ev[wk] > win_n[wk]) bad = bad + (win_ev[wk] - win_n[wk]);
            if (win_ev[wk] === 0) begin
                // 非真空兜底：本帧一个事件都没有时，不能算 PASS（否则"全在框内"恒真）
                $display("CHECK=%0s FAIL (本帧 0 事件，无法证明坐标)", nm);
                errors = errors + 1;
            end else if (bad === 0) $display("CHECK=%0s PASS (n=%0d)", nm, win_ev[wk]);
            else begin
                $display("CHECK=%0s FAIL (out=%0d, total=%0d)", nm, bad, win_ev[wk]);
                errors = errors + 1;
            end
        end
    endtask

    task chk_frame_zero;
        input [8*64-1:0] nm;
        input integer    fno;
        begin
            if (win_ev[fno+2] === 0) $display("CHECK=%0s PASS (F%0d)", nm, fno);
            else begin
                $display("CHECK=%0s FAIL (F%0d n=%0d)", nm, fno, win_ev[fno+2]);
                errors = errors + 1;
            end
        end
    endtask

    // ======================= 位图 dump（供 tool/bitmap_dump.py 渲染）=======================
    task dump_full_bitmap;
        input [8*80-1:0] fname;
        integer fd, a;
        reg [7:0] dw;
        begin
            fd = $fopen(fname, "w");
            if (fd == 0) begin
                $display("  [warn] 无法打开 dump 文件: %0s", fname);
            end else begin
                $fdisplay(fd, "# retina_core bitmap dump  EV_W=%0d EV_H=%0d words=%0d",
                          EV_W, EV_H, BMP_WORDS);
                $fdisplay(fd, "# addr = y*%0d + (x>>1); lo nibble = x even, hi nibble = x odd", WPL);
                $fdisplay(fd, "# bit[3] = polarity(1=ON), bit[2:0] = afterglow strength");
                $fdisplay(fd, "# sim time = %0t", $time);
                for (a = 0; a < BMP_WORDS; a = a + 1) begin
                    bmp_read(a, dw);
                    $fdisplay(fd, "%0d %h", a, dw);
                end
                $fclose(fd);
                $display("  [dump] %0s 写毕 (t=%0t)", fname, $time);
            end
        end
    endtask

    task count_nonzero_bitmap;
        output integer nz;
        integer a;
        reg [7:0] dw;
        begin
            nz = 0;
            for (a = 0; a < BMP_WORDS; a = a + 1) begin
                bmp_read(a, dw);
                if (dw !== 8'h00) nz = nz + 1;
            end
        end
    endtask

    // ======================= 主流程 =======================
    integer kk, ii, nz, nz_mid, series_n, si2;
    integer hot_off_a, hot_off_b, hot_on_a, hot_on_b;      // 图案帧 11 的跟踪单元
    integer v6_off_a, v6_off_b, v6_on_a, v6_on_b;          // 图案帧 9 的 V6 单元
    integer off_series [0:SERMAX-1];
    integer on_series  [0:SERMAX-1];
    reg [7:0] wd1, wd2;
    integer found_off, found_on;
    integer cold_a [0:3];
    integer v22, d1;
    reg [3:0] prev_on;
    reg [7:0] cw;
    integer nf9;

    initial begin
        for (ii = 0; ii < SERMAX; ii = ii + 1) begin off_series[ii] = -1; on_series[ii] = -1; end
        wd1 = 8'h00; wd2 = 8'h00; cw = 8'h00; prev_on = 4'd0;
        cold_a[0] = 40551;   // x=302 y=202（棋盘格 8px 块的内部，全程不该有事件）
        cold_a[1] = 39753;   // x=306 y=198
        cold_a[2] = 41349;   // x=298 y=206
        cold_a[3] = 42150;   // x=300 y=210

        // ---------------- 复位（i_cfg_src=0：相机，保证 sel_r 确定 = 0）----------------
        rst_n_cam = 1'b0;
        i_cam_data = 8'h00; i_cam_vsync = 1'b0; i_cam_href = 1'b0;
        i_cfg_ev_en = 1'b1; i_cfg_theta = THETA[11:0]; i_cfg_min_dl = 9'd2;
        i_cfg_src = 2'd0; i_cfg_pattern_mode = PM_CHK;
        i_cfg_decay_en = 1'b1; i_cfg_decay_step = 3'd1; i_cfg_refr_bypass = 1'b1;
        i_bmp_rd_addr = 16'h0000;

        repeat (8) @(posedge clk_cam);
        @(negedge clk_cam); rst_n_cam = 1'b1;         // 下一个 posedge = 图案帧 0 的第 1 拍

        // ---------------- 图案帧 0 的消隐期：切到图案源（切换时刻完全确定）----------------
        repeat (BLANK_T + 20000) @(posedge clk_cam);
        i_cfg_src = 2'd1;
        cam_frame_start();                             // A 路 vsync ⇒ sel_r <= 1
        $display("  [激励] 图案帧 0 消隐期切到图案源 @%0t（该方法线后引擎第 1 个像素帧 = 图案帧 1）",
                 $time);

        // ================= 相位 A：棋盘格（静态）=================
        wait_inc(1);                                   // 相机 vsync 形成的"空窗口"
        wait_inc(2);                                   // 图案帧 1 开始（第 1 个像素帧）
        wait_inc(3);                                   // 窗口 3 = 图案帧 1
        if (win_ev[3] === 0) $display("CHECK=A1_first_frame_suppression PASS");
        else begin
            $display("CHECK=A1_first_frame_suppression FAIL (首帧事件数=%0d，期望 0)", win_ev[3]);
            errors = errors + 1;
        end
        chk("A1_window_nonvacuous_reached", (inc_count >= 3));   // 走到这里说明帧同步正常
        // 注意：这里不能判"已经出现过事件"——R2 生效后首帧本该被抑制，此处必然还没事件。
        // 全轮非真空兜底放到最后：STAT_engine_activity_nonzero（用 DUT 自己的 o_stat_ev_total）。

        wait_blank();                                  // 图案帧 2 的消隐期
        i_cfg_pattern_mode = PM_UNIF;                  // 图案帧 3 起 = 均匀场

        wait_inc(4);                                   // 窗口 4 = 图案帧 2（静态棋盘格第 2 帧）
        if (win_ev[4] === 0) $display("CHECK=A2_static_checker_steady_zero PASS");
        else begin
            $display("CHECK=A2_static_checker_steady_zero FAIL (静态场景事件数=%0d)", win_ev[4]);
            errors = errors + 1;
        end

        wait_inc(5);                                   // 窗口 5 = 图案帧 3（棋盘格→均匀场 突变帧）
        if (win_ev[5] > 0) $display("CHECK=B0_scene_change_has_events PASS (n=%0d)", win_ev[5]);
        else begin
            $display("CHECK=B0_scene_change_has_events FAIL (突变帧 0 事件)");
            errors = errors + 1;
        end

        wait_inc(6);                                   // 窗口 6 = 图案帧 4
        chk_frame_zero("V1_uniform_zero_F4", 4);
        wait_inc(7);                                   // 窗口 7 = 图案帧 5
        chk_frame_zero("V1_uniform_zero_F5", 5);
        wait_blank();                                  // 图案帧 6 的消隐期
        i_cfg_pattern_mode = PM_BLOCK;                 // 图案帧 7 起 = 运动方块

        // ================= 相位 C：运动方块 =================
        wait_inc(8);                                   // 窗口 8 = 图案帧 6（均匀场静态第 3 帧）
        chk_frame_zero("V1_uniform_zero_F6", 6);

        wait_inc(9);                                   // 窗口 9 = 图案帧 7（方块出现，突变帧）
        if (win_ev[9] > 0) $display("CHECK=C0_block_appear_has_events PASS (n=%0d)", win_ev[9]);
        else begin $display("CHECK=C0_block_appear_has_events FAIL (n=0)"); errors = errors + 1; end
        chk_all_in_box("C0_block_appear_in_band", 7, 45, 90, 98, 133);

        wait_inc(10);                                  // 窗口 10 = 图案帧 8（span 54，同位置）
        chk_frame_zero("V2_same_pos_frame_zero_F8", 8);

        // ---- 图案帧 9：方块移动 1 个事件像素（span 54 -> 55）----
        wait_inc(11);                                  // 窗口 11 = 图案帧 9
        // s(8)=50+4=54（旧后缘），s(9)=50+5=55 ⇒ ON 列 = 55+31 = 86
        chk_change_frame(9, 54, 86);
        chk_all_in_box("V2_F9_events_in_block_band", 9, 45, 90, 98, 133);
        nf9 = win_n[11];

        // ---- V6：热点单元必须 > 0；从未写过事件的冷单元必须 = 0 ----
        begin : v6_pick
            integer ei, eidx;
            found_off = 0; found_on = 0;
            for (ei = 0; ei < win_n[11]; ei = ei + 1) begin
                eidx = 11*MAXEV + ei;
                if (frm_y[eidx] === 110) begin
                    if (frm_p[eidx] === 0) begin
                        v6_off_a = addr_of(frm_x[eidx], 110);
                        v6_off_b = frm_x[eidx] & 1;
                        found_off = 1;
                    end else begin
                        v6_on_a = addr_of(frm_x[eidx], 110);
                        v6_on_b = frm_x[eidx] & 1;
                        found_on = 1;
                    end
                end
            end
        end
        if (found_off && found_on) $display("CHECK=V6_F9_hot_cells_located PASS (off_a=%0d on_a=%0d)",
                                            v6_off_a, v6_on_a);
        else begin $display("CHECK=V6_F9_hot_cells_located FAIL"); errors = errors + 1; end

        // B 口 1 拍延迟的显式证伪：先读热（非零），立刻读冷（必须 0）；
        // 若读延迟不是 1 拍（例如 2 拍），冷读会拿到上一次热单元的值 ⇒ 会 FAIL
        if (found_on && found_off) begin
            bmp_read(v6_on_a, wd1);
            bmp_read(cold_a[0], wd2);
            if (nibble_of(wd1, v6_on_b) > 0)
                $display("CHECK=V6_bport_hot_cell_nonzero PASS (v=%0d)", nibble_of(wd1, v6_on_b));
            else begin
                $display("CHECK=V6_bport_hot_cell_nonzero FAIL (v=%0d)", nibble_of(wd1, v6_on_b));
                errors = errors + 1;
            end
            if (wd2 === 8'h00) $display("CHECK=V6_bport_1cycle_latency PASS");
            else begin $display("CHECK=V6_bport_1cycle_latency FAIL (cold word=%h)", wd2); errors = errors + 1; end
        end

        begin : v6_cold
            integer ci, cnz;
            cnz = 0;
            for (ci = 0; ci < 4; ci = ci + 1) begin
                bmp_read(cold_a[ci], cw);
                if (cw !== 8'h00) cnz = cnz + 1;
            end
            if (cnz === 0) $display("CHECK=V6_never_written_cells_zero PASS");
            else begin $display("CHECK=V6_never_written_cells_zero FAIL (nonzero=%0d)", cnz); errors = errors + 1; end
        end

        // 图案帧 9 全部 64 个事件坐标 → 位图对应半字节必须 > 0（地址/半字节选择的基础校验）
        begin : v6_event_cells
            integer ei, ex, ey, ea, eb, miss;
            reg [7:0] ew;
            miss = 0;
            for (ei = 0; ei < nf9; ei = ei + 1) begin
                ex = frm_x[11*MAXEV + ei];
                ey = frm_y[11*MAXEV + ei];
                ea = addr_of(ex, ey);
                eb = ex & 1;
                bmp_read(ea, ew);
                if (nibble_of(ew, eb) == 0) miss = miss + 1;
            end
            if (nf9 === 0) begin
                $display("CHECK=V6_all_F9_event_cells_nonzero FAIL (该帧 0 事件，无法证明位图写入)");
                errors = errors + 1;
            end else if (miss === 0) $display("CHECK=V6_all_F9_event_cells_nonzero PASS (n=%0d)", nf9);
            else begin
                $display("CHECK=V6_all_F9_event_cells_nonzero FAIL (miss=%0d/%0d)", miss, nf9);
                errors = errors + 1;
            end
        end

        // ---- 位图转储（人眼核对用；此刻方块阶段写入的热点单元还活着）----
        dump_full_bitmap("bmp_after_block.txt");
        count_nonzero_bitmap(nz_mid);   // 方块阶段必然写过位图 ⇒ 这个非零计数是"末尾全零"判据的非真空前提
        $display("  [位图] 方块阶段非零字数 = %0d（末尾清零判据的非真空前提）", nz_mid);

        wait_inc(12);                                  // 窗口 12 = 图案帧 10（同位置）
        chk_frame_zero("V2_same_pos_frame_zero_F10", 10);

        // ---- 图案帧 11：再移动 1 个事件像素（span 55 -> 56）----
        wait_inc(13);                                  // 窗口 13 = 图案帧 11
        chk_change_frame(11, 55, 87);
        chk_all_in_box("V2_F11_events_in_block_band", 11, 45, 90, 98, 133);

        // 图案帧 11 的 y=110 两个单元作为衰减跟踪对象
        begin : pick_track
            integer ei, eidx;
            found_off = 0; found_on = 0;
            for (ei = 0; ei < win_n[13]; ei = ei + 1) begin
                eidx = 13*MAXEV + ei;
                if (frm_y[eidx] === 110) begin
                    if (frm_p[eidx] === 0) begin
                        hot_off_a = addr_of(frm_x[eidx], 110);
                        hot_off_b = frm_x[eidx] & 1;
                        found_off = 1;
                    end else begin
                        hot_on_a = addr_of(frm_x[eidx], 110);
                        hot_on_b = frm_x[eidx] & 1;
                        found_on = 1;
                    end
                end
            end
        end
        if (found_off && found_on) $display("CHECK=V5F11_track_cells_located PASS (off_a=%0d on_a=%0d)",
                                            hot_off_a, hot_on_a);
        else begin $display("CHECK=V5F11_track_cells_located FAIL"); errors = errors + 1; end

        // ================= 相位 D：余晖衰减（V5）=================
        // 衰减点 0：图案帧 12 起点（图案帧 11 的事件已写完，并已被图案帧 11 的扫描衰减过一次）
        series_n = 0;
        if (found_off && found_on) begin
            bmp_read(hot_off_a, wd1); off_series[0] = nibble_of(wd1, hot_off_b);
            bmp_read(hot_on_a,  wd2); on_series[0]  = nibble_of(wd2, hot_on_b);
            $display("  [衰减] 点0 @图案帧12起点: off=%0d on=%0d", off_series[0], on_series[0]);
        end
        series_n = 1;

        wait_blank();                                  // 图案帧 12 的消隐期
        i_cfg_pattern_mode = PM_UNIF;                  // 图案帧 13 = 方块消失（突变帧）

        // 衰减点 1..OBS：图案帧 13 起
        //   观测点数要够：若"事件写入落在本帧扫描之后"，首次观测值就是 7（未被同帧衰减一格），
        //   ⇒ 7,6,5,4,3,2,1,0 需要 8 个点才看得到"归零"。
        for (kk = 14; kk <= (13 + DECAY_OBS); kk = kk + 1) begin
            wait_inc(kk);
            if (found_off && found_on) begin
                bmp_read(hot_off_a, wd1); off_series[series_n] = nibble_of(wd1, hot_off_b);
                bmp_read(hot_on_a,  wd2); on_series[series_n]  = nibble_of(wd2, hot_on_b);
                $display("  [衰减] 点%0d @图案帧%0d起点: off=%0d on=%0d", series_n, kk+1,
                         off_series[series_n], on_series[series_n]);
            end
            series_n = series_n + 1;
        end

        chk_frame_zero("D0_block_still_frame_zero_F12", 12);
        $display("  [帧统计] F13(方块消失)=%0d", win_ev[15]);

        // ---- 衰减判据 ----
        begin : decay_check
            integer i2, mono_ok, step_ok, off_zero_at, reached;
            mono_ok = 1; step_ok = 1; off_zero_at = -1; reached = 0;
            for (i2 = 1; i2 < series_n; i2 = i2 + 1) begin
                if (off_series[i2] > off_series[i2-1]) mono_ok = 0;
                if (!reached) begin
                    if (off_series[i2] !== 0) begin
                        if (off_series[i2] !== (off_series[i2-1] - 1)) step_ok = 0;
                    end else begin
                        reached = 1; off_zero_at = i2;
                    end
                end
            end
            chk("V5_decay_monotonic", (mono_ok == 1) && (off_series[0] > 0));
            chk("V5_decay_step_exactly_1", step_ok == 1);
            if (reached) $display("CHECK=V5_decay_reaches_zero PASS (观测点 %0d)", off_zero_at);
            else begin $display("CHECK=V5_decay_reaches_zero FAIL (序列未归零)"); errors = errors + 1; end
            if (reached && ((off_zero_at+1) < series_n) && (on_series[off_zero_at] > 0))
                $display("CHECK=V5_afterglow_polarity_bit_kept PASS (on=%0d)", on_series[off_zero_at]);
            else begin
                $display("CHECK=V5_afterglow_polarity_bit_kept FAIL (off_zero_at=%0d on=%0d)",
                         off_zero_at, (off_zero_at >= 0) ? on_series[off_zero_at] : -1);
                errors = errors + 1;
            end
            for (i2 = 0; i2 < series_n; i2 = i2 + 1)
                $display("    series[%0d] off=%0d on=%0d", i2, off_series[i2], on_series[i2]);
        end

        // ---- decay_step=3：运行时可配 + 快速清零 ----
        //   （若前面没能定位到热点单元，说明该帧根本没有事件——判据直接计 FAIL，避免读到 X）
        prev_on = on_series[series_n-1];
        i_cfg_decay_step = 3'd3;
        wait_inc(14 + DECAY_OBS);
        if (!(found_off && found_on)) begin
            $display("CHECK=V5_decay_step_config_takes_effect FAIL (无热点单元，无法跟踪)");
            errors = errors + 1;
        end else begin
            bmp_read(hot_on_a, wd2);
            v22 = nibble_of(wd2, hot_on_b);
            d1  = (prev_on > 3) ? (prev_on - 3) : 0;
            $display("  [衰减] dstep=3 后 @图案帧%0d起点: on=%0d (上一观测 %0d)", 13 + DECAY_OBS + 1, v22, prev_on);
            if (v22 === d1 && d1 > 0) $display("CHECK=V5_decay_step_config_takes_effect PASS");
            else begin
                $display("CHECK=V5_decay_step_config_takes_effect FAIL (got=%0d exp=%0d)", v22, d1);
                errors = errors + 1;
            end
        end

        wait_inc(15 + DECAY_OBS);
        bmp_read(hot_on_a, wd2);
        $display("  [衰减] dstep=3 第二帧: on=%0d", nibble_of(wd2, hot_on_b));
        wait_inc(16 + DECAY_OBS);
        bmp_read(hot_on_a, wd2);
        $display("  [衰减] dstep=3 第三帧: on=%0d", nibble_of(wd2, hot_on_b));

        // ---- 全位图清零 + 最终 dump ----
        wait_inc(17 + DECAY_OBS);
        count_nonzero_bitmap(nz);
        dump_full_bitmap("bmp_final.txt");
        // 非真空兜底：必须"先写过（nz_mid>0）"再"清回 0"，否则这条判据没有意义
        if (nz_mid === 0) begin
            $display("CHECK=V5_bitmap_all_zero_final FAIL (前提不成立：方块阶段位图就是全 0，无事件写入过)");
            errors = errors + 1;
        end else if (nz === 0)
            $display("CHECK=V5_bitmap_all_zero_final PASS (曾写过 %0d 个非零字，末尾归零)", nz_mid);
        else begin
            $display("CHECK=V5_bitmap_all_zero_final FAIL (nonzero=%0d，未清干净)", nz);
            errors = errors + 1;
        end

        // ================= 相位 E：坐标映射不变性（Lead 定的 R3 契约 #2/#3）=================
        //   做法（全自动，不靠手算偏移、不靠人工看图）：
        //     · 连续 10 帧每帧交替 PM_UNIF / PM_BLOCK ⇒ "方块帧"= 整场突变帧，
        //       事件只出在方块边界 ⇒ 事件 bbox 与"引擎输入图里方块 bbox"应只差一个常数平移；
        //     · 捕获每个方块帧的 l1_y 整帧图（400×240，按 de 脉冲铺）⇒ 自动定位方块 bbox；
        //     · 只挑"确实是方块稳定帧"的窗口：事件数 n 在 [1,64] 且事件 bbox 恰为 32×32；
        //       筛选条件逐帧打印（否则下次分不清是 RTL 错还是筛错）。
        $display("  [相位E] 开始坐标映射不变性测试（10 帧，交替 均匀/方块；MAP_INC0=%0d）", MAP_INC0);
        cap_slot = 0; cap_pix = 0;
        for (kk = 0; kk < MAPFRAMES; kk = kk + 1) begin
            wait_inc(kk + MAP_INC0);
            if ((kk % 2) == 0) i_cfg_pattern_mode = PM_BLOCK;   // 偶数帧 = 方块（被测帧 ⇒ 奇数槽）
            else               i_cfg_pattern_mode = PM_UNIF;    // 奇数帧 = 均匀（对照场）
        end
        wait_inc(23 + MAPFRAMES);
        cap_slot = -1;

        begin : map_invariance
            integer m, slot, px, x0, x1, y0, y1, evx0, evx1, evy0, evy1, wi;
            integer ok_ident, ok_within, n_img_ok, n_ev_ok, n_sel;
            integer off_dx [0:4];
            integer off_dy [0:4];
            integer img_w  [0:4];
            integer img_h  [0:4];
            integer sel    [0:4];       // 选中的窗口号（打印筛选依据用）
            ok_ident = 1; ok_within = 1; n_img_ok = 0; n_ev_ok = 0; n_sel = 0;
            // 槽位映射（实测）：cap_slot 在帧递增处推进，槽 s 捕获的正是 win[MAP_INC0 + s]；
            //   本相位 kk 偶数 ⇒ 该帧设为 PM_BLOCK（被测帧），kk 奇数 ⇒ PM_UNIF（对照场）。
            //   ⇒ 被测帧 = 奇数槽 1,3,5,7,9，对应窗口 MAP_INC0+slot（已被上面实测数据验证）。
            for (m = 0; m < 5; m = m + 1) begin
                slot = 2*m + 1;
                wi   = MAP_INC0 + slot;
                sel[m] = wi;
                // ---- 图像 bbox：在槽 slot 的 400×240 图里找亮块（l1_y == 255） ----
                x0 = 9999; x1 = -1; y0 = 9999; y1 = -1;
                for (px = 0; px < 96000; px = px + 1) begin
                    if (img[slot*96000 + px] === 8'hFF) begin
                        if ((px % 400) < x0) x0 = px % 400;
                        if ((px % 400) > x1) x1 = px % 400;
                        if ((px / 400) < y0) y0 = px / 400;
                        if ((px / 400) > y1) y1 = px / 400;
                    end
                end
                img_w[m] = (x1 >= x0) ? (x1 - x0 + 1) : 0;
                img_h[m] = (y1 >= y0) ? (y1 - y0 + 1) : 0;
                // ---- 事件 bbox：本帧事件 ----
                evx0 = 9999; evx1 = -1; evy0 = 9999; evy1 = -1;
                for (px = 0; px < win_n[wi]; px = px + 1) begin
                    if (frm_x[wi*MAXEV + px] < evx0) evx0 = frm_x[wi*MAXEV + px];
                    if (frm_x[wi*MAXEV + px] > evx1) evx1 = frm_x[wi*MAXEV + px];
                    if (frm_y[wi*MAXEV + px] < evy0) evy0 = frm_y[wi*MAXEV + px];
                    if (frm_y[wi*MAXEV + px] > evy1) evy1 = frm_y[wi*MAXEV + px];
                end
                // ---- 筛选：只认"真方块稳定帧"：0 < n <= 64 且事件 bbox 恰 32×32 ----
                //   （整场突变帧 n 上千、均匀场帧 n=0，两者都必须排除，否则比的是错东西）
                $display("  [相位E] 槽%0d/窗口%0d 筛选: n=%0d 事件bbox=(x %0d..%0d,y %0d..%0d) 图bbox=(x %0d..%0d,y %0d..%0d,%0dx%0d)",
                         slot, wi, win_ev[wi], evx0, evx1, evy0, evy1, x0, x1, y0, y1, img_w[m], img_h[m]);
                if ((img_w[m] === 32) && (img_h[m] === 32)) n_img_ok = n_img_ok + 1;
                if ((win_ev[wi] >= 1) && (win_ev[wi] <= 64) && (evx1 >= evx0) && (evy1 >= evy0) &&
                    ((evx1-evx0+1) === img_w[m]) && ((evy1-evy0+1) === img_h[m])) n_ev_ok = n_ev_ok + 1;
                if ((win_ev[wi] >= 1) && (win_ev[wi] <= 64) &&
                    (evx1 >= evx0) && (evy1 >= evy0) && (img_w[m] === 32) && (img_h[m] === 32)) begin
                    off_dx[n_sel] = evx0 - x0;
                    off_dy[n_sel] = evy0 - y0;
                    if (n_sel > 0 && (off_dx[n_sel] !== off_dx[0] || off_dy[n_sel] !== off_dy[0])) ok_ident = 0;
                    if ((off_dx[n_sel] > 1) || (off_dx[n_sel] < -1) ||
                        (off_dy[n_sel] > 1) || (off_dy[n_sel] < -1)) ok_within = 0;
                    $display("        ⇒ 采纳：图origin=(%0d,%0d) 事件origin=(%0d,%0d) offset=(%0d,%0d)",
                             x0, y0, evx0, evy0, off_dx[n_sel], off_dy[n_sel]);
                    n_sel = n_sel + 1;
                end else begin
                    $display("        ⇒ 排除（不是方块稳定帧）");
                end
            end
            // #1 非真空兜底 + 尺寸：5 个该帧图 bbox 必须都是 32×32
            if (n_img_ok === 5) $display("CHECK=R3_map_image_bbox_32x32 PASS");
            else begin $display("CHECK=R3_map_image_bbox_32x32 FAIL (ok=%0d/5)", n_img_ok); errors = errors + 1; end
            // #2 事件 bbox 必须与图 bbox 同尺寸（否则"事件不在方块上"）
            if (n_ev_ok === 5) $display("CHECK=R3_map_event_bbox_matches_image PASS");
            else begin $display("CHECK=R3_map_event_bbox_matches_image FAIL (ok=%0d/5)", n_ev_ok); errors = errors + 1; end
            // #3 连续 5 帧的映射平移必须完全一致（必须有 5 帧通过筛选，否则判 FAIL 而不是真空 PASS）
            if (n_sel === 5 && ok_ident)
                $display("CHECK=R3_map_offset_identical_over_5_frames PASS (dx=%0d dy=%0d, 窗口 %0d/%0d/%0d/%0d/%0d)",
                         off_dx[0], off_dy[0], sel[0], sel[1], sel[2], sel[3], sel[4]);
            else begin
                $display("CHECK=R3_map_offset_identical_over_5_frames FAIL (通过筛选的帧数=%0d/5)", n_sel);
                for (m = 0; m < n_sel; m = m + 1)
                    $display("        frame%0d offset=(%0d,%0d)", m, off_dx[m], off_dy[m]);
                errors = errors + 1;
            end
            // #4 原点差 ≤1 px（Lead：宁可"绝对偏移小"也不要漂移；两条都查）
            if (n_sel === 5 && ok_within) $display("CHECK=R3_map_offset_within_1px PASS");
            else begin $display("CHECK=R3_map_offset_within_1px FAIL (通过筛选的帧数=%0d/5)", n_sel); errors = errors + 1; end
        end

        // ================= 健康度 / 统计自洽 =================
        if (o_stat_ev_fifo_ovf === 16'd0) $display("CHECK=HEALTH_ev_fifo_ovf_zero PASS");
        else begin $display("CHECK=HEALTH_ev_fifo_ovf_zero FAIL (%0d)", o_stat_ev_fifo_ovf); errors = errors + 1; end
        if (o_stat_px_fifo_ovf === 16'd0) $display("CHECK=HEALTH_px_fifo_ovf_zero PASS");
        else begin $display("CHECK=HEALTH_px_fifo_ovf_zero FAIL (%0d)", o_stat_px_fifo_ovf); errors = errors + 1; end

        $display("  [统计] TB 计事件总数=%0d, o_stat_ev_total=%0d, o_stat_frame_cnt=%0d",
                 tb_ev_total, o_stat_ev_total, o_stat_frame_cnt);
        chk_int("STAT_total_matches_tb", o_stat_ev_total, tb_ev_total);

        // ---- 全轮非真空兜底（engine-dev 建议：直接用 DUT 自己的 o_ev_total）----
        //   意义：若事件链整轮一个事件都没有，则本 TB 里所有"期望 0"的判据都是真空 PASS，
        //   必须整轮判 FAIL。用 DUT 内部计数器 + TB 独立计数两个来源交叉验证。
        if (o_stat_ev_total > 0 && tb_ev_total > 0)
            $display("CHECK=STAT_engine_activity_nonzero PASS (ev_total=%0d)", o_stat_ev_total);
        else begin
            $display("CHECK=STAT_engine_activity_nonzero FAIL (DUT ev_total=%0d, TB=%0d —— 事件链整轮无事件)",
                     o_stat_ev_total, tb_ev_total);
            errors = errors + 1;
        end
        // 说明：o_stat_cr_x10 / o_stat_activity_q16 是"上一帧"的锁存值，而本 TB 结尾若干帧本就无
        // 事件（余晖衰减阶段），末值必然回到饱和/0，因此**不适合**在收尾处判结构正确性；
        // 结构性兜底用上面的 ev_total（DUT 内部计数器）+ tb_ev_total（TB 独立计数）交叉即可。

        begin : stat_frame_check
            integer si, bad;
            bad = 0;
            for (si = 2; si <= inc_count; si = si + 1) begin
                if (win_stat[si] !== win_ev[si]) begin
                    bad = bad + 1;
                    $display("    [统计不符] inc=%0d stat=%0d tb=%0d", si, win_stat[si], win_ev[si]);
                end
            end
            if (bad === 0) $display("CHECK=STAT_per_frame_matches_tb PASS");
            else begin $display("CHECK=STAT_per_frame_matches_tb FAIL (bad=%0d)", bad); errors = errors + 1; end
        end

        // ---- 帧内稳定性：同一帧"帧首锁存"与"帧内中段(第 100000 拍)"再采的值必须相同 ----
        //   （补强 STAT_per_frame_matches_tb 的半自证性：若锁存时机错/被中途改写，这里会 FAIL）
        begin : stat_stable_check
            integer si, bad, nvalid;
            bad = 0; nvalid = 0;
            // 末尾 2 个窗口的"帧内第 100000 拍"可能还没到（仿真在最后帧中途收尾）⇒ 不纳入
            for (si = 2; si <= (inc_count - 2); si = si + 1) begin
                if (stat_mid[si] !== win_stat[si]) begin
                    bad = bad + 1;
                    $display("    [帧内不稳定] inc=%0d 帧首=%0d 帧中=%0d", si, win_stat[si], stat_mid[si]);
                end
                nvalid = nvalid + 1;
            end
            if ((bad === 0) && (nvalid >= 10))
                $display("CHECK=STAT_latch_stable_within_frame PASS (覆盖 %0d 帧)", nvalid);
            else begin
                $display("CHECK=STAT_latch_stable_within_frame FAIL (bad=%0d nvalid=%0d)", bad, nvalid);
                errors = errors + 1;
            end
        end

        // 帧周期自检（用两次递增之间的绝对时间差）
        begin : period_check
            integer dcyc;
            dcyc = (inc_ns[4] - inc_ns[3]) / 20;   // clk_cam 周期 20ns
            $display("  [几何] 标称帧周期 = %0d 拍；实测 inc3->inc4 间隔 = %0d 拍", FRAME, dcyc);
            if (dcyc === FRAME) $display("CHECK=FRAME_period_is_H_TOTAL_x_V_TOTAL PASS");
            else begin
                $display("CHECK=FRAME_period_is_H_TOTAL_x_V_TOTAL FAIL (got=%0d)", dcyc);
                errors = errors + 1;
            end
        end

        // ---- 整系统无丢像素：每个稳定窗口的 align_de_w 拍数必须 = 96,000（=400×240）----
        //   与 stats_counter 的 px_f 同源（同一根 de），所以这条同时回答
        //   "axis_fifo 容量 15→16 后每帧像素数是否仍是 96,000"。
        begin : px_per_frame_check
            integer si, bad, n_exact, mn, mx;
            bad = 0; n_exact = 0; mn = 999999; mx = -1;
            for (si = 3; si <= 22; si = si + 1) begin
                if (win_px[si] === 96000) n_exact = n_exact + 1;
                if ((win_px[si] > (96000 + 16)) || (win_px[si] < (96000 - 16))) bad = bad + 1;
                if (win_px[si] < mn) mn = win_px[si];
                if (win_px[si] > mx) mx = win_px[si];
            end
            $display("  [像素] 窗口 3..22 每帧 align_de_w 拍数：min=%0d max=%0d，恰为 96000 的窗口 = %0d/20",
                     mn, mx, n_exact);
            if ((bad === 0) && (n_exact >= 19)) $display("CHECK=STAT_px_per_frame_96000 PASS");
            else begin
                $display("CHECK=STAT_px_per_frame_96000 FAIL (越界窗口=%0d, 恰等 96000 的窗口=%0d/20, min=%0d max=%0d)",
                         bad, n_exact, mn, mx);
                errors = errors + 1;
            end
        end

        // ================= 逐帧事件数汇总（报告用）=================
        for (si2 = 2; si2 <= inc_count; si2 = si2 + 1)
            $display("  [窗口事件数] inc%0d (图案帧%0d) = %0d", si2, si2-2, win_ev[si2]);

        // ================= 收口 =================
        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    // 全局超时保护（有界轮询以外再兜一层）
    initial begin
        #550000000;    // 550 ms 仿真时间（预期流程 ≈ 370 ms，含相位E 的 10 帧坐标不变性测试）
        $display("TEST_RESULT=FAIL (timeout-global)");
        $finish;
    end

endmodule
