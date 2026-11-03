//==============================================================================
// nn_winstat —— 动作识别「平移归一化」前端（M3b，clk_cam 单时钟）
//
// 【干什么】把事件流按「上一窗质心的绝对重新居中」做平移归一化，再交给网格：
//   ① 窗口内统计 ON/OFF 各自的事件数 n 与 Σx/Σy（逐事件累加，clk_cam 域）；
//   ② 窗口沿 i_win_tick 到来时冻结统计，串行 restoring 除法求质心 cx/cy
//      （纯整数、无乘法器、无除法器 IP ⇒ DSP=0）；
//   ③ 平移量 = 上一窗质心的**绝对重新居中**（唯一契约 = 训练侧
//      nn/v7/intwin.py:14-16 / 113-127，逐位一致；M3c/task-43 起生效）：
//        shift_x = pcx - CX_CENTER (200 = IMG_W/2)
//        shift_y = pcy - CY_CENTER (120 = IMG_H/2)
//      pcx/pcy = 上一个**有效**窗的整数质心 floor(Σ/n)，复位值 200/120；
//      n=0 的空窗不更新质心（保持上一有效值）。**无累加、无跨窗递归**。
//   ④ 事件写网格前先在**像素域**减 + clamp，再折算到格：
//        x' = clamp(x - shift_x, 0, IMG_W-1);  gx = x' >> GRID_SHIFT
//        y' = clamp(y - shift_y, 0, IMG_H-1);  gy = y' >> GRID_SHIFT
//      任一轴被夹住时 o_clamp_cnt++（每条事件最多 +1）。
//   ★M3c 修订（旧版两处错，task-43 Lead 裁决）：旧版把**像素**位移直接减在**格**
//     坐标上（8 倍过补偿），且用窗间增量 Δ 而非绝对重新居中 —— 两者都已按
//     intwin.py 改正；tb_nn_winstat 的期望值同步更新。
//
// 【契约（task-43 / nn_cfg.vh）】
//   · 平移量只能由**上一窗**统计量得到：本模块在窗沿才冻结统计并算质心，事件
//     路径上的 shift 寄存器在窗沿之后才更新 ⇒ 本窗事件绝不可能影响本窗 shift
//     （TB 用「窗内喂极端事件、检查 shift 不变」抓这个区别）。
//   · 空窗（n=0）：不做除法（无除零），cx/cy 按
//     `NN_WS_EMPTY_CENTROID_HOLD 保持上一有效值；shift 保持 = pcx-CENTER
//     （即与上一窗相同的平移量，不归零）；Δ 输出 0，但仍输出
//     o_stat_valid（n=0、Σ=0）。
//   · o_dcx/o_dcy = cx - pcx，pcx 复位值 200/120、总取上一**有效**窗质心
//     （与 intwin.py 的 dx = cx - pcx 完全一致；首窗不再强制 0）。
//   · 时延：窗沿 → o_stat_valid ≈ 52 拍（2 次 24 迭代除法 + 少量开销），远小于
//     5000 拍预算；稳态单事件 → o_grid_valid 为 2 拍。
//
// 【窗沿计算期的事件怎么办】位移要等串行除法算完（≈52 拍）才能生效，这段
//   时间窗内事件**不能丢**也不能提前用旧位移。做法：事件先按写入顺序进 64 深
//   FIFO，并带 1 bit「窗口 epoch」标签；本模块用 1 bit win_par 记当前窗口。
//     · 标签 == 当前 win_par  ⇒ 属于当前窗口，用 shift_cur 弹出；
//     · 标签 != 当前 win_par  ⇒ 是上一窗残留，用 shift_prev（上一窗位移）弹出。
//   弹出侧每拍处理 1 条，保证事件顺序，且每条事件都用「它所属窗口」的位移。
//   ★M3c：该 1 bit 窗口标签随事件从 o_grid_par 输出，供 nn_feat 用它给事件
//     打上窗口归属（事件经本模块有 2 拍流水/窗沿 FIFO 延迟，nn_feat 不能再
//     按「到达时刻」判断归属，否则窗沿前的在途事件会被记进新窗）。
//   队列长度受窗沿计算期限制（≈52 条 < 64），正常契约事件率下不会满；真满了
//   会丢事件（本任务 TB 用「入队计数 = 出队计数」证明没有丢）。
//
// 【★M3d 新增（task-48）】为 nn_winfeat 的 7 路部署特征额外产出：
//   · Σx²/Σy² 逐事件累加（40 bit 饱和）——方差 sx/sy 需要，导出 o_snap_sx2/o_snap_sy2；
//   · 窗末快照总线 o_snap_*（与 o_stat_valid 同拍、单拍有效）：本窗 n/on/off/Σx/Σy/
//     Σx²/Σy²/质心 + 上一窗质心 pcx/pcy + 上一窗事件数 prev_n；
//   · 既有端口语义与平移/网格通路**完全不变**（新增端口全部是输出，nn_top 可暂不接）。
//   pcx/pcy/prev_n 在窗沿锁存（此时 prev_cx/prev_cy 尚未被本窗更新），其余在发布拍
//   锁存，因此下游一次采样即可拿到与 intwin.py 同窗口索引的全部输入。
//
// 【坐标过滤】本模块不做 x/y 范围过滤：统计以输入事件为准（上游 nn_feat 已过滤
//   并可丢弃越界事件）；写网格侧用 clamp 兜住越界坐标。这样 TB 的「已知 4 点」
//   用例（含 x=IMG_W 边界点）可以原样喂进来。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_winstat (
    input  wire        clk_cam,        // 50 MHz，与 nn_feat / nn_top 同域
    input  wire        rst_n_cam,      // 低有效异步复位

    // ---- 事件输入（clk_cam 域；与 nn_feat 的 i_ev_* 同源）----
    input  wire        i_ev_valid,     // 单拍
    input  wire [8:0]  i_ev_x,         // 契约 [0,NN_IMG_W)
    input  wire [7:0]  i_ev_y,         // 契约 [0,NN_IMG_H)
    input  wire        i_ev_pol,       // 1=ON, 0=OFF

    // ---- 窗口沿（单拍；由 nn_top / nn_feat 产生）----
    input  wire        i_win_tick,

    // ---- 上一窗统计（o_stat_valid 单拍更新）----
    output reg         o_stat_valid,
    output reg  [15:0] o_n_on,
    output reg  [15:0] o_n_off,
    output reg  [23:0] o_sum_x_on,
    output reg  [23:0] o_sum_y_on,
    output reg  [23:0] o_sum_x_off,
    output reg  [23:0] o_sum_y_off,
    output reg  [8:0]  o_cx,           // 上一窗 ON+OFF 全体质心
    output reg  [7:0]  o_cy,
    output reg  [9:0]  o_dcx,          // 有符号补码：cx_k - cx_{k-1}
    output reg  [9:0]  o_dcy,

    // ---- 当前生效平移量（有符号补码，写网格前做减法用）----
    output wire [9:0]  o_shift_x,
    output wire [9:0]  o_shift_y,

    // ---- 平移后的网格事件（每条输入事件最多对应一条）----
    output reg         o_grid_valid,
    output reg  [5:0]  o_grid_x,       // [0,GW-1]
    output reg  [4:0]  o_grid_y,       // [0,GH-1]
    output reg         o_grid_pol,
    output reg         o_grid_par,     // 该事件所属窗口的 epoch（= FIFO 标签，M3c 给 nn_feat 用）
    output reg  [15:0] o_clamp_cnt,    // 被 clamp 的事件计数（饱和）

    // ---- ★M3d：窗末特征快照（与 o_stat_valid 同拍、单拍有效）----
    //   一次窗末把 nn_winfeat 需要的全部累计量锁存后并行给出，下游不必再跨窗沿
    //   采样。pcx/pcy/prev_n 是**上一窗**的质心与事件数（intwin.py 语义：
    //   pcx = [200]+cx[:-1]、prev_n = [0]+n[:-1]）。
    output reg         o_snap_valid,
    output reg  [17:0] o_snap_n,       // 本窗事件总数 n = n_on+n_off
    output reg  [16:0] o_snap_on,
    output reg  [16:0] o_snap_off,
    output reg  [24:0] o_snap_sx,      // Σx（全体事件，两点极性合并）
    output reg  [24:0] o_snap_sy,
    output reg  [39:0] o_snap_sx2,     // Σx²（★M3d 新增累加）
    output reg  [39:0] o_snap_sy2,
    output reg  [8:0]  o_snap_cx,      // 本窗质心（空窗 = 保持值）
    output reg  [7:0]  o_snap_cy,
    output reg  [8:0]  o_snap_pcx,     // 上一窗质心（pcx/pcy）
    output reg  [7:0]  o_snap_pcy,
    output reg  [17:0] o_snap_prev_n   // 上一窗事件总数（prev_n）
);

    //--------------------------------------------------------------------------
    // 0. 派生常量（形状全部来自 nn_cfg.vh，不写字面量）
    //--------------------------------------------------------------------------
    localparam integer GW      = `NN_GRID_W;          // 50
    localparam integer GH      = `NN_GRID_H;          // 30
    localparam integer FD      = `NN_WS_FIFO_DEPTH;   // 64
    localparam integer FAW     = `NN_WS_FIFO_AW;      // 6
    localparam integer FCW     = FAW + 1;              // 7

    localparam [5:0]     GX_MAX = GW - 1;             // 49
    localparam [4:0]     GY_MAX = GH - 1;             // 29
    // 绝对重新居中的图像中心与像素域 clamp 上界（M3c：与 intwin.py 一致）
    localparam [9:0] CX_CENTER = `NN_IMG_W / 2;      // 200
    localparam [9:0] CY_CENTER = `NN_IMG_H / 2;      // 120
    localparam [8:0] PX_MAX    = `NN_IMG_W - 1;      // 399
    localparam [7:0] PY_MAX    = `NN_IMG_H - 1;      // 239
    localparam integer   GW_M1  = GW - 1;
    localparam integer   GH_M1  = GH - 1;
    localparam [FCW-1:0] FD_CNT = FD;

    //--------------------------------------------------------------------------
    // 1. 声明
    //--------------------------------------------------------------------------
    // 窗口内统计累加器（内部比输出宽 1 bit，避免输出饱和反过来影响除法）
    reg [16:0] acc_n_on, acc_n_off;
    reg [23:0] acc_sx_on, acc_sy_on, acc_sx_off, acc_sy_off;

    // 窗沿冻结副本（o_stat_valid 发布的就是它）
    reg [16:0] f_n_on, f_n_off;
    reg [23:0] f_sx_on, f_sy_on, f_sx_off, f_sy_off;

    // ★M3d：Σx²/Σy² 逐事件平方和（40 bit 饱和 = 2^40-1）。
    //   物理上界 n*399² ≤ 4.2e10（36 bit，n<=2^18）⇒ 正常输入永不饱和；
    //   宽度推导与饱和依据见 sim/nn/EVIDENCE_M3d.md。
    reg [39:0] acc_sx2, acc_sy2;
    reg [39:0] f_sx2, f_sy2;

    // ★M3d：上一窗事件数（prev_n，供 nn_winfeat 的 prev_n_div16）
    reg [17:0] prev_n_w;

    // 窗口 epoch（FIFO 标签；每窗翻一次）
    reg        win_par;

    // 除法器 / 忙标志
    reg        busy;           // 1=窗沿计算期（禁止 FIFO 弹出）
    reg        dv_act;         // 除法器工作中
    reg        dv_phase;       // 0=算 cx, 1=算 cy
    reg [4:0]  dv_cnt;         // 剩余迭代拍数（24 -> 0）
    reg [23:0] dv_num;         // 分子移位寄存器
    reg [18:0] dv_rem;         // 余数
    reg [23:0] dv_quot;        // 商（MSB -> LSB）
    reg [17:0] dv_div;         // 分母 n（18 bit，最大 2*131071）
    reg [23:0] dv_qx;          // cx 的商

    // 平移量 / 上一窗质心
    reg [9:0]  shift_cur_x, shift_cur_y;    // 本窗生效
    reg [9:0]  shift_prev_x, shift_prev_y;  // 上一窗生效（给残留事件用）
    reg [8:0]  prev_cx;
    reg [7:0]  prev_cy;
    reg        prev_valid;

    // 事件缓冲
    (* ram_style = "distributed" *) reg [18:0] fifo_mem [0:FD-1];
    reg [FAW-1:0] wr_ptr, rd_ptr;
    reg [FCW-1:0] fifo_cnt;

    //--------------------------------------------------------------------------
    // 2. 窗口统计：逐事件累加 + 窗沿冻结/清零
    //    窗沿当拍若有事件，该事件归入**新窗**（先冻结/清零，再加它）
    //--------------------------------------------------------------------------
    wire [17:0] win_n_total = {1'b0, acc_n_on} + {1'b0, acc_n_off};
    wire        win_nz      = (win_n_total != 18'd0);

    wire [24:0] sx_on_add  = {1'b0, acc_sx_on}  + {16'd0, i_ev_x};
    wire [24:0] sy_on_add  = {1'b0, acc_sy_on}  + {16'd0, i_ev_y};
    wire [24:0] sx_off_add = {1'b0, acc_sx_off} + {16'd0, i_ev_x};
    wire [24:0] sy_off_add = {1'b0, acc_sy_off} + {16'd0, i_ev_y};

    // ★M3d：逐事件平方（i_ev_x 9 bit ⇒ x²≤261121 18 bit；i_ev_y 8 bit ⇒ y²≤65025 16 bit）
    wire [17:0] ev_x2   = i_ev_x * i_ev_x;
    wire [15:0] ev_y2   = i_ev_y * i_ev_y;
    wire [40:0] sx2_add = {1'b0, acc_sx2} + {23'd0, ev_x2};
    wire [40:0] sy2_add = {1'b0, acc_sy2} + {23'd0, ev_y2};

    // 冻结统计的总量：除法器算 cy 时 acc 早已被清零 ⇒ 必须用 f_*
    wire [17:0] f_n_total = {1'b0, f_n_on} + {1'b0, f_n_off};
    wire [24:0] f_sx_tot  = {1'b0, f_sx_on} + {1'b0, f_sx_off};
    wire [24:0] f_sy_tot  = {1'b0, f_sy_on} + {1'b0, f_sy_off};
    wire [23:0] f_sx_sat  = (f_sx_tot > 25'hFFFFFF) ? 24'hFFFFFF : f_sx_tot[23:0];
    wire [23:0] f_sy_sat  = (f_sy_tot > 25'hFFFFFF) ? 24'hFFFFFF : f_sy_tot[23:0];

    // 窗沿（BUSY 期间的 tick 忽略：窗口周期必须远大于窗沿计算期）
    wire win_tick_fire = i_win_tick && !busy;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            acc_n_on   <= 17'd0;
            acc_n_off  <= 17'd0;
            acc_sx_on  <= 24'd0;
            acc_sy_on  <= 24'd0;
            acc_sx_off <= 24'd0;
            acc_sy_off <= 24'd0;
            f_n_on     <= 17'd0;
            f_n_off    <= 17'd0;
            f_sx_on    <= 24'd0;
            f_sy_on    <= 24'd0;
            f_sx_off   <= 24'd0;
            f_sy_off   <= 24'd0;
            acc_sx2    <= 40'd0;
            acc_sy2    <= 40'd0;
            f_sx2      <= 40'd0;
            f_sy2      <= 40'd0;
            prev_n_w   <= 18'd0;
            win_par    <= 1'b0;
        end else if (win_tick_fire) begin
            // ---- 冻结本窗统计（o_stat_valid 发布用）----
            f_n_on   <= acc_n_on;
            f_n_off  <= acc_n_off;
            f_sx_on  <= acc_sx_on;
            f_sy_on  <= acc_sy_on;
            f_sx_off <= acc_sx_off;
            f_sy_off <= acc_sy_off;
            f_sx2    <= acc_sx2;
            f_sy2    <= acc_sy2;
            // ★M3d：窗末特征快照的「上一窗」部分（pcx/pcy 取更新前的 prev_cx/prev_cy）
            o_snap_pcx    <= prev_cx;
            o_snap_pcy    <= prev_cy;
            o_snap_prev_n <= prev_n_w;
            prev_n_w      <= win_n_total;
            win_par  <= ~win_par;
            // ---- 清空累加器；窗沿同拍的事件归新窗 ----
            if (i_ev_valid) begin
                acc_n_on   <= i_ev_pol ? 17'd1 : 17'd0;
                acc_n_off  <= i_ev_pol ? 17'd0 : 17'd1;
                acc_sx_on  <= i_ev_pol ? {15'd0, i_ev_x} : 24'd0;
                acc_sy_on  <= i_ev_pol ? {16'd0, i_ev_y} : 24'd0;
                acc_sx_off <= i_ev_pol ? 24'd0 : {15'd0, i_ev_x};
                acc_sy_off <= i_ev_pol ? 24'd0 : {16'd0, i_ev_y};
                acc_sx2    <= {22'd0, ev_x2};
                acc_sy2    <= {24'd0, ev_y2};
            end else begin
                acc_n_on   <= 17'd0;
                acc_n_off  <= 17'd0;
                acc_sx_on  <= 24'd0;
                acc_sy_on  <= 24'd0;
                acc_sx_off <= 24'd0;
                acc_sy_off <= 24'd0;
                acc_sx2    <= 40'd0;
                acc_sy2    <= 40'd0;
            end
        end else if (i_ev_valid) begin
            // ---- 逐事件累加（n 饱和 17 bit、Σ 饱和 24 bit）----
            if (i_ev_pol) begin
                acc_n_on  <= (acc_n_on == 17'h1FFFF) ? 17'h1FFFF : (acc_n_on + 17'd1);
                acc_sx_on <= (sx_on_add > 25'hFFFFFF) ? 24'hFFFFFF : sx_on_add[23:0];
                acc_sy_on <= (sy_on_add > 25'hFFFFFF) ? 24'hFFFFFF : sy_on_add[23:0];
            end else begin
                acc_n_off  <= (acc_n_off == 17'h1FFFF) ? 17'h1FFFF : (acc_n_off + 17'd1);
                acc_sx_off <= (sx_off_add > 25'hFFFFFF) ? 24'hFFFFFF : sx_off_add[23:0];
                acc_sy_off <= (sy_off_add > 25'hFFFFFF) ? 24'hFFFFFF : sy_off_add[23:0];
            end
            // ★M3d：平方和按全体事件累加（不分极性，与 intwin.py 的 Sx2/Sy2 一致）
            acc_sx2 <= sx2_add[40] ? 40'hFFFFFFFFFF : sx2_add[39:0];
            acc_sy2 <= sy2_add[40] ? 40'hFFFFFFFFFF : sy2_add[39:0];
        end
    end

    //--------------------------------------------------------------------------
    // 3. 串行 restoring 除法器（先 Σx/n，再 Σy/n；24 迭代/次）
    //    只在 n != 0 时启动 ⇒ 永不除零
    //--------------------------------------------------------------------------
    wire [24:0] win_sx_tot = {1'b0, acc_sx_on} + {1'b0, acc_sx_off};
    wire [24:0] win_sy_tot = {1'b0, acc_sy_on} + {1'b0, acc_sy_off};
    wire [23:0] win_sx_sat = (win_sx_tot > 25'hFFFFFF) ? 24'hFFFFFF : win_sx_tot[23:0];
    wire [23:0] win_sy_sat = (win_sy_tot > 25'hFFFFFF) ? 24'hFFFFFF : win_sy_tot[23:0];

    wire [18:0] dv_sh   = {dv_rem[17:0], dv_num[23]};
    wire        dv_ge   = (dv_sh >= {1'b0, dv_div});
    wire [18:0] dv_sub  = dv_sh - {1'b0, dv_div};

    // 除法完成（商已就绪；下一拍发布统计并解除 BUSY）
    wire dv_done_w = dv_act && (dv_cnt == 5'd0) && dv_phase;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            busy     <= 1'b0;
            dv_act   <= 1'b0;
            dv_phase <= 1'b0;
            dv_cnt   <= 5'd0;
            dv_num   <= 24'd0;
            dv_rem   <= 19'd0;
            dv_quot  <= 24'd0;
            dv_div   <= 18'd0;
            dv_qx    <= 24'd0;
        end else begin
            if (win_tick_fire && win_nz) begin
                busy     <= 1'b1;
                dv_act   <= 1'b1;
                dv_phase <= 1'b0;
                dv_cnt   <= 5'd24;
                dv_rem   <= 19'd0;
                dv_quot  <= 24'd0;
                dv_div   <= win_n_total;
                dv_num   <= win_sx_sat;
            end else if (dv_act) begin
                if (dv_cnt != 5'd0) begin
                    dv_num  <= {dv_num[22:0], 1'b0};
                    dv_quot <= {dv_quot[22:0], dv_ge};
                    dv_rem  <= dv_ge ? dv_sub : dv_sh;
                    dv_cnt  <= dv_cnt - 5'd1;
                end else if (!dv_phase) begin
                    // cx 完成，接着算 cy（分子必须取冻结统计：acc 已清零）
                    dv_qx    <= dv_quot;
                    dv_phase <= 1'b1;
                    dv_num   <= f_sy_sat;
                    dv_rem   <= 19'd0;
                    dv_quot  <= 24'd0;
                    dv_cnt   <= 5'd24;
                end else begin
                    // cy 完成（商在本拍稳定，发布在下拍）
                    dv_act <= 1'b0;
                    busy   <= 1'b0;
                end
            end
        end
    end

    //--------------------------------------------------------------------------
    // 4. 结果发布 / 平移量更新
    //    · 非空窗：dv_done_w 当拍按「冻结统计」发布；Δ=新质心-上一有效质心
    //    · 空窗：窗沿当拍直接发布（n=0、Σ=0、质心保持、Δ=0、shift=0）
    //--------------------------------------------------------------------------
    wire [8:0] cx_val = (dv_qx   > 24'd511) ? 9'd511 : dv_qx[8:0];
    wire [7:0] cy_val = (dv_quot > 24'd255) ? 8'd255 : dv_quot[7:0];
    wire [9:0] dcx_v  = {1'b0, cx_val} - {1'b0, prev_cx};   // 模 1024 补码
    wire [9:0] dcy_v  = {1'b0, cy_val} - {1'b0, prev_cy};

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            o_stat_valid <= 1'b0;
            o_n_on       <= 16'd0;
            o_n_off      <= 16'd0;
            o_sum_x_on   <= 24'd0;
            o_sum_y_on   <= 24'd0;
            o_sum_x_off  <= 24'd0;
            o_sum_y_off  <= 24'd0;
            o_cx         <= 9'd0;
            o_cy         <= 8'd0;
            o_dcx        <= 10'd0;
            o_dcy        <= 10'd0;
            shift_cur_x  <= 10'd0;
            shift_cur_y  <= 10'd0;
            shift_prev_x <= 10'd0;
            shift_prev_y <= 10'd0;
            prev_cx      <= CX_CENTER[8:0];   // 200（intwin.py 复位值）
            prev_cy      <= CY_CENTER[7:0];   // 120
            prev_valid   <= 1'b0;
            // ★M3d：窗末特征快照
            o_snap_valid <= 1'b0;
            o_snap_n     <= 18'd0;
            o_snap_on    <= 17'd0;
            o_snap_off   <= 17'd0;
            o_snap_sx    <= 25'd0;
            o_snap_sy    <= 25'd0;
            o_snap_sx2   <= 40'd0;
            o_snap_sy2   <= 40'd0;
            o_snap_cx    <= 9'd0;
            o_snap_cy    <= 8'd0;
        end else begin
            o_stat_valid <= 1'b0;
            o_snap_valid <= 1'b0;   // ★M3d：与 o_stat_valid 同拍的单拍脉冲

            if (dv_done_w) begin
                // ---------------- 非空窗：发布统计 ----------------
                o_stat_valid <= 1'b1;
                o_n_on       <= f_n_on[16] ? 16'hFFFF : f_n_on[15:0];
                o_n_off      <= f_n_off[16] ? 16'hFFFF : f_n_off[15:0];
                o_sum_x_on   <= f_sx_on;
                o_sum_y_on   <= f_sy_on;
                o_sum_x_off  <= f_sx_off;
                o_sum_y_off  <= f_sy_off;
                o_cx         <= cx_val;
                o_cy         <= cy_val;
                // Δ = cx - pcx（pcx 复位 200/120、总取上一有效窗质心）
                // ★M3c：与 intwin.py 的 dx = cx - pcx 一致，首窗不再强制 0
                o_dcx        <= dcx_v;
                o_dcy        <= dcy_v;

                // 平移量 = **绝对重新居中**：shift = pcx - CENTER（无累加、无递归）。
                // 上一窗残留事件继续用 shift_prev（它们所属窗的平移量）。
                shift_prev_x <= shift_cur_x;
                shift_prev_y <= shift_cur_y;
                shift_cur_x  <= {1'b0, cx_val} - CX_CENTER;
                shift_cur_y  <= {1'b0, cy_val} - CY_CENTER;

                prev_cx    <= cx_val;
                prev_cy    <= cy_val;
                prev_valid <= 1'b1;

                // ★M3d：窗末特征快照（n/on/off/Σ/Σ²/本窗质心；pcx/pcy/prev_n 已在窗沿锁存）
                o_snap_valid <= 1'b1;
                o_snap_n     <= f_n_total;
                o_snap_on    <= f_n_on;
                o_snap_off   <= f_n_off;
                o_snap_sx    <= f_sx_tot;
                o_snap_sy    <= f_sy_tot;
                o_snap_sx2   <= f_sx2;
                o_snap_sy2   <= f_sy2;
                o_snap_cx    <= cx_val;
                o_snap_cy    <= cy_val;
            end else if (win_tick_fire && !win_nz) begin
                // ---------------- 空窗：不除零 ----------------
                o_stat_valid <= 1'b1;
                o_n_on       <= 16'd0;
                o_n_off      <= 16'd0;
                o_sum_x_on   <= 24'd0;
                o_sum_y_on   <= 24'd0;
                o_sum_x_off  <= 24'd0;
                o_sum_y_off  <= 24'd0;
                o_dcx        <= 10'd0;
                o_dcy        <= 10'd0;

                // ★M3d：空窗快照（n=0、Σ=0、质心保持值；供 nn_winfeat 走 n=0 短路）
                o_snap_valid <= 1'b1;
                o_snap_n     <= 18'd0;
                o_snap_on    <= 17'd0;
                o_snap_off   <= 17'd0;
                o_snap_sx    <= 25'd0;
                o_snap_sy    <= 25'd0;
                o_snap_sx2   <= 40'd0;
                o_snap_sy2   <= 40'd0;
                o_snap_cx    <= prev_cx;
                o_snap_cy    <= prev_cy;

                shift_prev_x <= shift_cur_x;
                shift_prev_y <= shift_cur_y;
                // 空窗不更新质心 ⇒ 平移量保持 = pcx - CENTER（与上一窗相同，不归零）；
                // 与 intwin.py 的 pcx carry-forward 一致。
                shift_cur_x  <= {1'b0, prev_cx} - CX_CENTER;
                shift_cur_y  <= {1'b0, prev_cy} - CY_CENTER;

                if (`NN_WS_EMPTY_CENTROID_HOLD != 0) begin
                    o_cx <= prev_cx;
                    o_cy <= prev_cy;
                end else begin
                    o_cx <= 9'd0;
                    o_cy <= 8'd0;
                    prev_cx <= 9'd0;
                    prev_cy <= 8'd0;
                end
            end
        end
    end

    assign o_shift_x = shift_cur_x;
    assign o_shift_y = shift_cur_y;

    //--------------------------------------------------------------------------
    // 5. 事件缓冲 + 网格写入（减法 + clamp）
    //--------------------------------------------------------------------------
    wire [18:0] pop_ev  = fifo_mem[rd_ptr];
    wire        pop     = (fifo_cnt != {FCW{1'b0}}) && !busy;
    wire        push    = i_ev_valid && (fifo_cnt != FD_CNT);
    wire        cur_par = win_tick_fire ? ~win_par : win_par;

    wire        pop_pol = pop_ev[17];
    wire        pop_tag = pop_ev[18];

    // 所属窗口的平移量（**像素**单位）：本窗用 shift_cur，上一窗残留用 shift_prev
    wire [9:0]  pop_sx = (pop_tag == win_par) ? shift_cur_x : shift_prev_x;
    wire [9:0]  pop_sy = (pop_tag == win_par) ? shift_cur_y : shift_prev_y;

    // ★M3c：先在**像素域**减 + clamp，再折算到格（与 intwin.py 逐位一致）：
    //   x' = clamp(x - shift_x, 0, IMG_W-1);  gx = x' >> GRID_SHIFT
    // 12 bit 有符号运算：x∈[0,399]、|shift|<=511 ⇒ 范围 [-511, 910] 不溢出。
    wire [11:0] x_sh = {3'd0, pop_ev[8:0]}  - {{2{pop_sx[9]}}, pop_sx};
    wire [11:0] y_sh = {4'd0, pop_ev[16:9]} - {{2{pop_sy[9]}}, pop_sy};
    wire        x_neg = x_sh[11];
    wire        y_neg = y_sh[11];
    wire        x_hi  = (x_sh > {4'd0, PX_MAX});
    wire        y_hi  = (y_sh > {5'd0, PY_MAX});

    wire [8:0]  x_fin = x_neg ? 9'd0 : (x_hi ? PX_MAX : x_sh[8:0]);
    wire [7:0]  y_fin = y_neg ? 8'd0 : (y_hi ? PY_MAX : y_sh[7:0]);

    // clamp 后的像素坐标 >>GRID_SHIFT 必落在 [0,GW-1]x[0,GH-1]（399>>3=49, 239>>3=29）
    wire [5:0]  gx_fin = x_fin[8:3];
    wire [4:0]  gy_fin = y_fin[7:3];
    wire        any_clamp = x_neg | y_neg | x_hi | y_hi;

    // 事件缓冲存储单独成块：**不能**带异步复位，否则 Vivado 会把 64x19 的数组
    // 拆成寄存器（"RAM is sensitive to asynchronous reset signal"）而不是分布式 RAM
    always @(posedge clk_cam) begin
        if (push)
            fifo_mem[wr_ptr] <= {cur_par, i_ev_pol, i_ev_y, i_ev_x};
    end

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            wr_ptr       <= {FAW{1'b0}};
            rd_ptr       <= {FAW{1'b0}};
            fifo_cnt     <= {FCW{1'b0}};
            o_grid_valid <= 1'b0;
            o_grid_x     <= 6'd0;
            o_grid_y     <= 5'd0;
            o_grid_pol   <= 1'b0;
            o_grid_par   <= 1'b0;
            o_clamp_cnt  <= 16'd0;
        end else begin
            o_grid_valid <= 1'b0;

            if (push) begin
                wr_ptr <= wr_ptr + 1'b1;
            end

            if (pop) begin
                rd_ptr       <= rd_ptr + 1'b1;
                o_grid_valid <= 1'b1;
                o_grid_x     <= gx_fin;
                o_grid_y     <= gy_fin;
                o_grid_pol   <= pop_pol;
                o_grid_par   <= pop_tag;
                if (any_clamp)
                    o_clamp_cnt <= (o_clamp_cnt == 16'hFFFF) ? 16'hFFFF
                                                             : (o_clamp_cnt + 16'd1);
            end

            fifo_cnt <= fifo_cnt + (push ? 1'd1 : 1'd0) - (pop ? 1'd1 : 1'd0) ;
        end
    end

endmodule
