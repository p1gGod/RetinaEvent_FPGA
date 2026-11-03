//==============================================================================
// nn_top —— 动作识别子系统顶层（M3-fix v2：单时钟 clk_cam 50 MHz）
//
//   clk_cam 域（50 MHz，单一时钟）
//   ─────────────────────────────────────────────────────────────
//   i_ev_* ─► nn_feat：窗口内 per-cell ON/OFF 饱和计数（cur_mem）
//      │        窗口边界 → cur 拷进 frz_mem[bank]（K+1 bank 轮转）
//      │        o_win_end（单拍）/ o_win_bank / o_win_tog
//      ├─► nn_engine：i_start=o_win_end，i_bank_now=o_win_bank
//      │        ↕ o_feat_addr / o_rd_q（寄存读，1 拍）
//      │        ↕ nn_rom（地址 reg + BRAM 寄存读，共 2 拍）
//      │        ↓ o_res_l0/1/2 + o_res_tog（一次推理结束翻一次）
//      └─► nn_decide：锁存 3 个 logit → argmax + margin → 连续 N 窗 / 不应期
//               ↓ o_act_pulse / o_act_class / o_act_conf
//
// 【为什么 v1 的 CDC 没了（task-21）】v1 是 clk_cam 累积 + clk_200m 推理的
//   双时钟设计，有 1 条 bank 跨域和 3 条 logit 跨域（都用 cdc_tog_word）。实测
//   200 MHz 域每拍宽读 36~240 个激活并行乘加根本无法布线（WNS -7 ns、
//   Slices 98.7%），所以引擎改成 50 MHz 串行取数（每拍 1 激活 + 1 权重 = 1 MAC），
//   整条链路单时钟：跨域与握手自然消失，nn_decide 的 i_tog 三路共用
//   eng_res_tog（同拍提交，三路一起锁存）。
//
// 【时机预算（实测，@50 MHz）】
//   窗口边界 → 拷贝 3001 拍 → 引擎启动（1 拍）→ 引擎约 43.6 万拍（≈8.7 ms）
//   → nn_decide 当拍出结论 ⇒ 一次推理约 43.7 万拍，占 100 ms（5,000,000 拍）
//   窗口的 8.7%，远小于窗口，窗口不会重叠丢推理。
//
// 【端口兼容】clk_200m / rst_n_200m 保留但**不再使用**（v2 单时钟；TB 可继续
//   驱动，综合时是空输入，不产生任何内部负载）。
//
// 【复位】rst_n_cam 低有效异步复位（全部时序逻辑同一时钟域）；nn_feat 复位后
//   先清 frz+cur 共 9000+3000 字（约 9001 拍）才 o_ready，这期间不发窗口事件。
//
// 【M3c（task-43）：平移归一化接入主链】
//   原始事件 i_ev_* 先过 nn_winstat（统计本窗 n/Σ/质心，按上一窗质心位移做
//   gx/gy clamp 到网格），平移后的网格事件再进 nn_feat 累积 —— 即网络看到的
//   是「跨窗对齐后的网格」，与训练侧 converter 的平移归一化一致。
//   窗口沿由本模块统一产生：feat_ready 之后 wt_cnt 从 0 数到 WIN_CYC-1（与旧
//   nn_feat 内部 win_cnt 相位逐拍一致），该单拍 win_tick 同时送 u_feat.i_win_tick
//   与 u_ws.i_win_tick ⇒ 全网只有一个窗沿，不存在两套计数。
//   nn_feat 用 USE_EXT_TICK=1：事件带 nn_winstat 的窗口 epoch（i_ev_par），窗沿
//   后先等 200 拍（`NN_EXT_FLUSH_CYC）让在途事件落地再冻结，窗沿附近不串窗。
//   o_win_end 因此比旧设计晚 200 拍（占 5,000,000 拍窗口的 0.004%）。
//
// 【M3c：o_glob_bus】窗口级 17 路全局量寄存器组（u_glob 区）在 o_stat_valid 后
//   打一拍输出，字节序/位域见 EVIDENCE_M3c.md；本任务不做 sx/sy/speed/dsx/dsy
//   （需平方/开方/除法），对应位段固定 0。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_top #(
    parameter integer WIN_CYC        = `NN_WIN_CYC,
    parameter integer REFRACTORY_CYC = `NN_REFRACTORY_CYC,
    parameter integer MARGIN_MIN     = `NN_MARGIN_MIN,
    parameter integer N_CONSEC       = `NN_N_CONSEC
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_ev_valid,
    input  wire [8:0]  i_ev_x,
    input  wire [7:0]  i_ev_y,
    input  wire        i_ev_pol,
    output wire        o_act_pulse,
    output wire [1:0]  o_act_class,
    output wire [4:0]  o_act_conf,
    output wire        o_dbg_win,       // 单拍：窗口冻结完成
    output wire        o_dbg_busy,      // 引擎忙（同域，直接输出 busy 打一拍）

    // ---- v2 起不再使用（保留端口以兼容已有 TB/上层连线）----
    input  wire        clk_200m,
    input  wire        rst_n_200m,

    // ---- M3c 新增：窗口级 17 路全局量打包总线（MSB->LSB 顺序见 EVIDENCE_M3c.md）----
    output wire [255:0] o_glob_bus,
    output wire         o_glob_valid
);

    //--------------------------------------------------------------------------
    // 0. 统一窗沿（M3c）：全网唯一的 win_tick
    //    feat_ready 拉高后 wt_cnt 从 0 数到 WIN_CYC-1（与旧 nn_feat 内部 win_cnt
    //    相位逐拍一致：首个 RUN 拍 win_cnt=0，第 WIN_CYC-1 个 RUN 拍请求边界）。
    //--------------------------------------------------------------------------
    wire                     feat_ready;
    wire [`NN_BANK_AW-1:0]   win_bank;
    wire                     win_tog;
    wire                     win_end;
    wire [15:0]              feat_drop;
    wire [`NN_FRZ_AW-1:0]    feat_addr;
    wire [`NN_CNT_W-1:0]     feat_q;

    reg  [31:0] wt_cnt;
    wire        win_tick = feat_ready && (wt_cnt == WIN_CYC - 1);

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam)       wt_cnt <= 32'd0;
        else if (!feat_ready) wt_cnt <= 32'd0;
        else if (win_tick)    wt_cnt <= 32'd0;
        else                  wt_cnt <= wt_cnt + 32'd1;
    end

    //--------------------------------------------------------------------------
    // 1. 平移归一化前端（clk_cam）：raw 事件 -> 上一窗质心位移 -> 网格坐标
    //    ★ 与 u_feat 共用同一根 win_tick（判据：全网只有一个窗沿）
    //    ★ 统计以**输入事件**为准（不做 x/y 过滤，与 nn_winstat 契约一致）
    //--------------------------------------------------------------------------
    wire        ws_valid;
    wire [15:0] ws_n_on, ws_n_off;
    wire [23:0] ws_sx_on, ws_sy_on, ws_sx_off, ws_sy_off;
    wire [8:0]  ws_cx;
    wire [7:0]  ws_cy;
    wire [9:0]  ws_dcx, ws_dcy;
    wire [9:0]  ws_shift_x, ws_shift_y;
    wire        ws_grid_valid;
    wire [5:0]  ws_grid_x;
    wire [4:0]  ws_grid_y;
    wire        ws_grid_pol, ws_grid_par;
    wire [15:0] ws_clamp_cnt;

    // ---- M3d/task-48：窗末快照（给 nn_winfeat 算 7 路部署特征）----
    wire        ws_snap_valid;
    wire [17:0] ws_snap_n, ws_snap_prev_n;
    wire [16:0] ws_snap_on, ws_snap_off;
    wire [24:0] ws_snap_sx, ws_snap_sy;
    wire [39:0] ws_snap_sx2, ws_snap_sy2;
    wire [8:0]  ws_snap_cx, ws_snap_pcx;
    wire [7:0]  ws_snap_cy, ws_snap_pcy;

    // ---- M3e/task-51：7 路全局量特征（nn_winfeat 输出），喂 nn_engine 的 g1 支路 ----
    wire [7:0]  gf_n_div16, gf_prev_n_div16, gf_pol_bal;
    wire [7:0]  gf_dx, gf_dy, gf_dx_rel, gf_dy_rel;
    wire        gf_valid;
    wire [10:0] gf_cyc_cnt;

    nn_winstat u_ws (
        .clk_cam      (clk_cam),
        .rst_n_cam    (rst_n_cam),
        .i_ev_valid   (i_ev_valid),
        .i_ev_x       (i_ev_x),
        .i_ev_y       (i_ev_y),
        .i_ev_pol     (i_ev_pol),
        .i_win_tick   (win_tick),
        .o_stat_valid (ws_valid),
        .o_n_on       (ws_n_on),
        .o_n_off      (ws_n_off),
        .o_sum_x_on   (ws_sx_on),
        .o_sum_y_on   (ws_sy_on),
        .o_sum_x_off  (ws_sx_off),
        .o_sum_y_off  (ws_sy_off),
        .o_cx         (ws_cx),
        .o_cy         (ws_cy),
        .o_dcx        (ws_dcx),
        .o_dcy        (ws_dcy),
        .o_shift_x    (ws_shift_x),
        .o_shift_y    (ws_shift_y),
        .o_grid_valid (ws_grid_valid),
        .o_grid_x     (ws_grid_x),
        .o_grid_y     (ws_grid_y),
        .o_grid_pol   (ws_grid_pol),
        .o_grid_par   (ws_grid_par),
        .o_clamp_cnt  (ws_clamp_cnt),
        // M3d：窗末快照（n/on/off/Σx/Σy/Σx²/Σy²/cx/cy/上一窗 pcx/pcy/prev_n）
        .o_snap_valid (ws_snap_valid),
        .o_snap_n     (ws_snap_n),
        .o_snap_on    (ws_snap_on),
        .o_snap_off   (ws_snap_off),
        .o_snap_sx    (ws_snap_sx),
        .o_snap_sy    (ws_snap_sy),
        .o_snap_sx2   (ws_snap_sx2),
        .o_snap_sy2   (ws_snap_sy2),
        .o_snap_cx    (ws_snap_cx),
        .o_snap_cy    (ws_snap_cy),
        .o_snap_pcx   (ws_snap_pcx),
        .o_snap_pcy   (ws_snap_pcy),
        .o_snap_prev_n(ws_snap_prev_n)
    );

    //--------------------------------------------------------------------------
    // 1b. 窗级部署特征（M3d 交付的 nn_winfeat）：7 路 int8，供 v7 g1 支路
    //     ★ 它在窗末快照后 504 拍算完；nn_engine 要等 nn_feat 冻结（窗沿后 200 拍）
    //       再拷贝 3001 拍才启动，所以特征在引擎启动前早已稳定，无需握手。
    //--------------------------------------------------------------------------
    nn_winfeat u_winfeat (
        .clk_cam       (clk_cam),
        .rst_n_cam     (rst_n_cam),
        .i_snap_valid  (ws_snap_valid),
        .i_n           (ws_snap_n),
        .i_on          (ws_snap_on),
        .i_off         (ws_snap_off),
        .i_sx          (ws_snap_sx),
        .i_sy          (ws_snap_sy),
        .i_sx2         (ws_snap_sx2),
        .i_sy2         (ws_snap_sy2),
        .i_cx          (ws_snap_cx),
        .i_cy          (ws_snap_cy),
        .i_pcx         (ws_snap_pcx),
        .i_pcy         (ws_snap_pcy),
        .i_prev_n      (ws_snap_prev_n),
        .o_feat_valid  (gf_valid),
        .o_n_div16     (gf_n_div16),
        .o_prev_n_div16(gf_prev_n_div16),
        .o_pol_bal     (gf_pol_bal),
        .o_dx          (gf_dx),
        .o_dy          (gf_dy),
        .o_dx_rel      (gf_dx_rel),
        .o_dy_rel      (gf_dy_rel),
        .o_busy        (),
        .o_cyc_cnt     (gf_cyc_cnt)
    );

    //--------------------------------------------------------------------------
    // 2. 特征累积（clk_cam）：输入 = 平移后的网格坐标
    //    gx 是 (x>>3) 归一化后的网格列，左移 GRID_SHIFT 位后由 nn_feat 内部再
    //    >>GRID_SHIFT 复原 ⇒ cell 与原逻辑完全相同（shift=0 时逐格等价）。
    //--------------------------------------------------------------------------
    nn_feat #(
        .WIN_CYC        (WIN_CYC),
        .USE_EXT_TICK   (1),
        .EXT_FLUSH_CYC  (`NN_EXT_FLUSH_CYC)
    ) u_feat (
        .clk_cam    (clk_cam),
        .rst_n_cam  (rst_n_cam),
        .i_ev_valid (ws_grid_valid),
        .i_ev_x     ({ws_grid_x, {`NN_GRID_SHIFT{1'b0}}}),
        .i_ev_y     ({ws_grid_y, {`NN_GRID_SHIFT{1'b0}}}),
        .i_ev_pol   (ws_grid_pol),
        .o_ready    (feat_ready),
        .o_win_bank (win_bank),
        .o_win_tog  (win_tog),
        .o_win_end  (win_end),
        .o_dbg_drop (feat_drop),
        .i_rd_addr  (feat_addr),
        .o_rd_q     (feat_q),
        .i_win_tick (win_tick),
        .i_ev_par   (ws_grid_par)
    );

    //--------------------------------------------------------------------------
    // 权重 ROM + 推理引擎（同一 clk_cam）
    //--------------------------------------------------------------------------
    wire [`NN_ROM_AW-1:0] rom_addr;
    wire [31:0]           rom_dout;
    wire                  eng_busy;
    wire                  eng_res_tog;
    wire [`NN_CNT_W-1:0]  eng_l0, eng_l1, eng_l2;

    nn_rom u_rom (
        .clk    (clk_cam),
        .i_addr (rom_addr),
        .o_dout (rom_dout)
    );

    nn_engine u_eng (
        .clk         (clk_cam),
        .rst_n       (rst_n_cam),
        .i_start     (win_end),          // 窗口冻结完成的同一拍启动
        .i_bank_now  (win_bank),
        .o_feat_addr (feat_addr),
        .i_feat_data (feat_q),
        // ★ task-51 / 审计 D5：g1 支路 7 路特征（独立 8bit 端口，有符号）
        .i_g1_f0     (gf_n_div16),
        .i_g1_f1     (gf_prev_n_div16),
        .i_g1_f2     (gf_pol_bal),
        .i_g1_f3     (gf_dx),
        .i_g1_f4     (gf_dy),
        .i_g1_f5     (gf_dx_rel),
        .i_g1_f6     (gf_dy_rel),
        .o_rom_addr  (rom_addr),
        .i_rom_data  (rom_dout),
        .o_busy      (eng_busy),
        .o_res_tog   (eng_res_tog),
        .o_res_l0    (eng_l0),
        .o_res_l1    (eng_l1),
        .o_res_l2    (eng_l2)
    );

    //--------------------------------------------------------------------------
    // 时序决策（clk_cam，同域：三路共用 eng_res_tog）
    //--------------------------------------------------------------------------
    wire [1:0] dec_dbg_class;
    wire [7:0] dec_dbg_margin;
    wire [2:0] dec_dbg_cnt;
    wire       dec_dbg_hit;
    wire       dec_dbg_refr;

    nn_decide #(
        .REFRACTORY_CYC (REFRACTORY_CYC),
        .MARGIN_MIN     (MARGIN_MIN),
        .N_CONSEC       (N_CONSEC)
    ) u_dec (
        .clk         (clk_cam),
        .rst_n       (rst_n_cam),
        .i_l0        (eng_l0),
        .i_l1        (eng_l1),
        .i_l2        (eng_l2),
        .i_tog       ({3{eng_res_tog}}),
        .o_act_pulse (o_act_pulse),
        .o_act_class (o_act_class),
        .o_act_conf  (o_act_conf),
        .o_dbg_class (dec_dbg_class),
        .o_dbg_margin(dec_dbg_margin),
        .o_dbg_cnt   (dec_dbg_cnt),
        .o_dbg_hit   (dec_dbg_hit),
        .o_dbg_refr  (dec_dbg_refr)
    );

    //--------------------------------------------------------------------------
    // 3. 窗口级全局量寄存器组（M3c）：ws_valid 后打一拍输出
    //    位域（o_glob_bus，MSB->LSB；顺序 = nn/v6/v6_common.py GLOBAL_NAMES）：
    //      [255:235] 保留 0
    //      [234:219] dx>0 窗口计数（RTL 扩展位段，训练侧暂无对应项）
    //      [218:203] n            [202:187] on           [186:171] off
    //      [170:162] cx           [161:154] cy
    //      [153:138] sx(=0)       [137:122] sy(=0)
    //      [121:113] pcx          [112:105] pcy
    //      [104:95]  dx           [94:85]   dy
    //      [84:69]   speed(=0)    [68:59]   dsx(=0)      [58:49] dsy(=0)
    //      [48:32]   bal = on-off（17 bit 有符号补码）
    //      [31:16]   frames（窗口序号计数）             [15:0] prev_n
    //    未实现项（sx/sy/speed/dsx/dsy 需平方/开方/除法）固定 0，后续任务填。
    //--------------------------------------------------------------------------
    reg [15:0] g_n, g_on, g_off, g_prev_n;
    reg [8:0]  g_cx, g_pcx;
    reg [7:0]  g_cy, g_pcy;
    reg [9:0]  g_dx, g_dy;
    reg [16:0] g_bal;
    reg [15:0] g_frames;
    reg [15:0] g_pos_dx;
    reg [15:0] win_idx;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            g_n <= 16'd0; g_on <= 16'd0; g_off <= 16'd0; g_prev_n <= 16'd0;
            g_cx <= 9'd0; g_cy <= 8'd0; g_pcx <= 9'd0; g_pcy <= 8'd0;
            g_dx <= 10'd0; g_dy <= 10'd0; g_bal <= 17'd0;
            g_frames <= 16'd0; g_pos_dx <= 16'd0; win_idx <= 16'd0;
        end else begin
            if (ws_valid) begin
                g_on   <= ws_n_on;
                g_off  <= ws_n_off;
                g_n    <= (({1'b0, ws_n_on} + {1'b0, ws_n_off}) > 17'd65535)
                          ? 16'hFFFF : (ws_n_on + ws_n_off);
                g_prev_n <= g_n;                // 上一窗 n（更新前锁存）
                g_cx   <= ws_cx;
                g_cy   <= ws_cy;
                g_pcx  <= g_cx;                 // 上一窗质心
                g_pcy  <= g_cy;
                g_dx   <= ws_dcx;
                g_dy   <= ws_dcy;
                g_bal  <= {1'b0, ws_n_on} - {1'b0, ws_n_off};
                g_frames <= (g_frames == 16'hFFFF) ? 16'hFFFF : (g_frames + 16'd1);
                // dx>0 窗口计数（dcx 为 10 bit 有符号补码；0 不计）
                if ((ws_dcx != 10'd0) && (ws_dcx[9] == 1'b0))
                    g_pos_dx <= (g_pos_dx == 16'hFFFF) ? 16'hFFFF : (g_pos_dx + 16'd1);
            end
            if (win_tick) win_idx <= win_idx + 16'd1;
        end
    end

    reg glob_valid_r;
    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) glob_valid_r <= 1'b0;
        else            glob_valid_r <= ws_valid;
    end

    assign o_glob_bus = { 21'd0, g_pos_dx,
                          g_n, g_on, g_off, g_cx, g_cy,
                          16'd0, 16'd0,              // sx, sy（未实现）
                          g_pcx, g_pcy, g_dx, g_dy,
                          16'd0,                     // speed（未实现）
                          10'd0, 10'd0,              // dsx, dsy（未实现）
                          g_bal, g_frames, g_prev_n };
    assign o_glob_valid = glob_valid_r;

    //--------------------------------------------------------------------------
    // 调试输出
    //--------------------------------------------------------------------------
    assign o_dbg_win = win_end;

    reg busy_sync;
    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) busy_sync <= 1'b0;
        else            busy_sync <= eng_busy;
    end
    assign o_dbg_busy = busy_sync;

endmodule