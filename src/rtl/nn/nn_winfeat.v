//==============================================================================
// nn_winfeat —— M3d 窗级部署特征前端（7 路 int8，clk_cam 单时钟）
//
// 【干什么】每个窗末（i_snap_valid 单拍）吃一份 nn_winstat 的累计量快照，用**纯
//   整数**、串行复用一个乘法器/除法器/开方器，算出训练侧 fmin_n_rel7 的 7 路
//   部署特征（顺序即 fmin_n_rel7，见 nn/v7/v7_feats.py:149）：
//      ① n_div16      = min(127, n >> 4)
//      ② prev_n_div16 = min(127, prev_n >> 4)
//      ③ pol_bal      = clip127( trunc_div((on-off)*127, max(n,1)) )   ← 向零截断
//      ④ dx           = clip127( (cx - pcx) >>> 2 )                     ← 算术右移
//      ⑤ dy           = clip127( (cy - pcy) >>> 1 )
//      ⑥ dx_rel       = clip127( (dx_raw << 6) // S )                   ← floor
//      ⑦ dy_rel       = clip127( (dy_raw << 6) // S )
//   其中 S = max(isqrt(sx*sy), 8)，sx/sy 是**像素**单位标准差：
//      var_x = (Σx²·n − (Σx)²) // n²，sx = isqrt(var_x)（intwin.py:113-129）
//   ★两处除法方向不同（照抄 v7_feats.py，不许改）：
//      · pol_bal 用 trunc_div（向零截断，v7_feats.py:39-44）
//      · dx_rel/dy_rel 用 Python 的 //（向下取整，负数更负）
//
// 【语义边界（与 intwin.py 逐位一致）】
//   · n = 0（空窗）：n_div16=0、pol_bal=0、dx=dy=0、dx_rel=dy_rel=0；
//     prev_n_div16 仍按上一窗 n 计算；不启动除法/开方（永不除零）。
//   · n > 0 但窗口内全部事件同一点：var=0 ⇒ sx=sy=0 ⇒ S=8（下限兜底）。
//   · dx/dy 的输入 cx/pcx 都是 9/8 bit 图像坐标（≤399/239），|dx_raw|≤399、
//     |dy_raw|≤239，因此 ④⑤ 的 clip 在实际范围内不会触发（保留以防越界输入）；
//     clip 真正生效的是 ⑥⑦（S 最小 8 时 |dx_rel| 可达 399*64/8=3192）。
//
// 【时延】一个窗一次完整计算 = 6 次乘法(25 拍) + 5 次除法(59 拍) + 3 次开方(10 拍)
//   + 控制开销 ≈ 490~500 拍 @50 MHz ≈ 10 us，占 100 ms 窗的 0.01%（预算 1500 拍）。
//   计算在窗末快照之后独立进行，不占 nn_winstat 的 52 拍窗沿计算期，也不挡事件
//   通路；窗口周期远大于计算期，因此 busy 期间到来的新快照会被忽略（有文档说明）。
//
// 【位宽】见下方各声明注释与 sim/nn/EVIDENCE_M3d.md 的推导表。
//==============================================================================
`timescale 1ns / 1ps

//------------------------------------------------------------------------------
// 串行乘法器：A(40bit) × B(25bit) → P(59bit)，25 迭代（一次 59 位加法/拍）
//   B 的每一位逐拍右移，A 逐拍左移，累加器 59 位。
//   合法输入范围内积不会越过 59 bit（Sx2·n ≤ 2^58、Sx² ≤ 2^50、sx·sy ≤ 2^18）。
//------------------------------------------------------------------------------
module nn_winfeat_mul (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        i_start,
    input  wire [39:0] i_a,
    input  wire [24:0] i_b,
    output reg         o_done,
    output reg  [58:0] o_p
);
    reg        busy;
    reg [58:0] a_r, acc;
    reg [24:0] b_r;
    reg [4:0]  cnt;
    wire [58:0] acc_n = b_r[0] ? (acc + a_r) : acc;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            busy   <= 1'b0;
            o_done <= 1'b0;
            a_r    <= 59'd0;
            b_r    <= 25'd0;
            acc    <= 59'd0;
            cnt    <= 5'd0;
            o_p    <= 59'd0;
        end else begin
            o_done <= 1'b0;
            if (i_start && !busy) begin
                busy <= 1'b1;
                a_r  <= {19'd0, i_a};
                b_r  <= i_b;
                acc  <= 59'd0;
                cnt  <= 5'd24;
            end else if (busy) begin
                if (cnt == 5'd0) begin
                    busy   <= 1'b0;
                    o_done <= 1'b1;
                    o_p    <= acc_n;
                end else begin
                    acc <= acc_n;
                    a_r <= a_r << 1;
                    b_r <= b_r >> 1;
                    cnt <= cnt - 5'd1;
                end
            end
        end
    end
endmodule

//------------------------------------------------------------------------------
// 串行 restoring 除法器：无符号 NUM(59bit) / DEN(36bit) → Q(59bit) + REM(37bit)
//   59 迭代（每拍移入 1 位被除数、试减一次），DEN 必须 > 0（上游保证：n>0、S>=8）。
//------------------------------------------------------------------------------
module nn_winfeat_div (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        i_start,
    input  wire [58:0] i_num,
    input  wire [35:0] i_den,
    output reg         o_done,
    output reg  [58:0] o_q,
    output reg  [36:0] o_rem
);
    reg        busy;
    reg [58:0] num_r, quot_r;
    reg [36:0] rem_r;
    reg [35:0] den_r;
    reg [5:0]  cnt;
    wire [36:0] sh  = {rem_r[35:0], num_r[58]};
    wire        ge  = (sh >= {1'b0, den_r});
    wire [36:0] sub = sh - {1'b0, den_r};

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            busy   <= 1'b0;
            o_done <= 1'b0;
            num_r  <= 59'd0;
            quot_r <= 59'd0;
            rem_r  <= 37'd0;
            den_r  <= 36'd0;
            cnt    <= 6'd0;
            o_q    <= 59'd0;
            o_rem  <= 37'd0;
        end else begin
            o_done <= 1'b0;
            if (i_start && !busy) begin
                busy   <= 1'b1;
                num_r  <= i_num;
                den_r  <= i_den;
                rem_r  <= 37'd0;
                quot_r <= 59'd0;
                cnt    <= 6'd58;
            end else if (busy) begin
                if (cnt == 6'd0) begin
                    busy   <= 1'b0;
                    o_done <= 1'b1;
                    o_q    <= {quot_r[57:0], ge};
                    o_rem  <= ge ? sub : sh;
                end else begin
                    rem_r  <= ge ? sub : sh;
                    num_r  <= {num_r[57:0], 1'b0};
                    quot_r <= {quot_r[57:0], ge};
                    cnt    <= cnt - 6'd1;
                end
            end
        end
    end
endmodule

//------------------------------------------------------------------------------
// 逐位开方器：V(20bit) → ROOT(10bit) = floor(sqrt(V))，10 迭代（每拍 2 bit）
//   经典 digit-by-digit：rem = (rem<<2)|pair; trial = (root<<2)|1;
//   rem >= trial ? (rem-=trial, root=(root<<1)|1) : root=root<<1
//------------------------------------------------------------------------------
module nn_winfeat_sqrt (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        i_start,
    input  wire [19:0] i_val,
    output reg         o_done,
    output reg  [9:0]  o_root
);
    reg        busy;
    reg [19:0] val_r;
    reg [11:0] rem_r;
    reg [9:0]  root_r;
    reg [3:0]  cnt;
    wire [1:0]  pair  = val_r[19:18];
    wire [13:0] rem2  = {rem_r[11:0], pair};
    wire [13:0] trial = {2'b00, root_r[9:0], 2'b01};
    wire        ge    = (rem2 >= trial);
    wire [11:0] rem_n = ge ? (rem2[11:0] - trial[11:0]) : rem2[11:0];
    wire [9:0]  root_n = ge ? {root_r[8:0], 1'b1} : {root_r[8:0], 1'b0};

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            busy   <= 1'b0;
            o_done <= 1'b0;
            val_r  <= 20'd0;
            rem_r  <= 12'd0;
            root_r <= 10'd0;
            cnt    <= 4'd0;
            o_root <= 10'd0;
        end else begin
            o_done <= 1'b0;
            if (i_start && !busy) begin
                busy   <= 1'b1;
                val_r  <= i_val;
                rem_r  <= 12'd0;
                root_r <= 10'd0;
                cnt    <= 4'd9;
            end else if (busy) begin
                if (cnt == 4'd0) begin
                    busy   <= 1'b0;
                    o_done <= 1'b1;
                    o_root <= root_n;
                end else begin
                    val_r  <= {val_r[17:0], 2'b00};
                    rem_r  <= rem_n;
                    root_r <= root_n;
                    cnt    <= cnt - 4'd1;
                end
            end
        end
    end
endmodule

//==============================================================================
// 顶层：快照 → 7 路特征（串行慢速状态机，每窗一次）
//==============================================================================
module nn_winfeat (
    input  wire        clk_cam,
    input  wire        rst_n_cam,

    // ---- 窗末快照（来自 nn_winstat.o_snap_*，i_snap_valid 单拍有效）----
    input  wire        i_snap_valid,
    input  wire [17:0] i_n,          // 本窗事件总数
    input  wire [16:0] i_on,
    input  wire [16:0] i_off,
    input  wire [24:0] i_sx,         // Σx（两极性合并）
    input  wire [24:0] i_sy,
    input  wire [39:0] i_sx2,        // Σx²
    input  wire [39:0] i_sy2,
    input  wire [8:0]  i_cx,         // 本窗质心 floor(Σx/n)（空窗 = 保持值）
    input  wire [7:0]  i_cy,
    input  wire [8:0]  i_pcx,        // 上一窗质心
    input  wire [7:0]  i_pcy,
    input  wire [17:0] i_prev_n,     // 上一窗事件总数

    // ---- 7 路部署特征（int8 补码，顺序 = fmin_n_rel7）----
    output reg         o_feat_valid, // 单拍
    output reg  [7:0]  o_n_div16,
    output reg  [7:0]  o_prev_n_div16,
    output reg  [7:0]  o_pol_bal,
    output reg  [7:0]  o_dx,
    output reg  [7:0]  o_dy,
    output reg  [7:0]  o_dx_rel,
    output reg  [7:0]  o_dy_rel,

    output wire        o_busy,       // 1=窗末计算中
    output reg  [10:0] o_cyc_cnt     // 上一窗计算占用拍数（证据/调试）
);
    //--------------------------------------------------------------------------
    // 0. 状态机编码与快照寄存器
    //--------------------------------------------------------------------------
    localparam [4:0]
        ST_IDLE     = 5'd0,
        ST_M_SX2N   = 5'd1,
        ST_M_SXSX   = 5'd2,
        ST_M_SY2N   = 5'd3,
        ST_M_SYSY   = 5'd4,
        ST_M_N2     = 5'd5,
        ST_D_VARX   = 5'd6,
        ST_Q_SX     = 5'd7,
        ST_D_VARY   = 5'd8,
        ST_Q_SY     = 5'd9,
        ST_M_SXY    = 5'd10,
        ST_Q_S      = 5'd11,
        ST_D_POLBAL = 5'd12,
        ST_D_DXREL  = 5'd13,
        ST_D_DYREL  = 5'd14,
        ST_OUT      = 5'd15,
        ST_EMPTY    = 5'd16,
        ST_WAIT     = 5'd17;

    // 操作标签（结果回写用）
    localparam [4:0]
        OP_M_SX2N = 5'd1,  OP_M_SXSX = 5'd2,  OP_M_SY2N = 5'd3,
        OP_M_SYSY = 5'd4,  OP_M_N2   = 5'd5,  OP_M_SXY  = 5'd6,
        OP_D_VARX = 5'd7,  OP_D_VARY = 5'd8,  OP_D_POL  = 5'd9,
        OP_D_DX   = 5'd10, OP_D_DY   = 5'd11,
        OP_Q_SX   = 5'd12, OP_Q_SY   = 5'd13, OP_Q_S   = 5'd14;

    reg [4:0]  st;
    reg [4:0]  st_next;     // 当前等待结束后要去的状态
    reg [4:0]  op_tag;      // 当前串行操作标签
    reg [1:0]  wk;          // 0=等乘法 1=等除法 2=等开方

    // 快照寄存器
    reg [17:0] n_r;
    reg [16:0] on_r, off_r;
    reg [24:0] sx_r, sy_r;
    reg [39:0] sx2_r, sy2_r;
    reg [8:0]  cx_r, pcx_r;
    reg [7:0]  cy_r, pcy_r;
    reg [17:0] prev_n_r;

    // 中间结果
    reg [58:0] r_sx2n, r_sxsx, r_sy2n, r_sysy, r_n2, r_sxy;
    reg [58:0] r_varx_q, r_vary_q, r_pol_q, r_dx_q, r_dy_q;
    reg [36:0] r_dx_rem, r_dy_rem;
    reg [9:0]  r_sx, r_sy, r_s;

    reg [10:0] cyc_cnt;

    //--------------------------------------------------------------------------
    // 1. 派生量（组合；来自快照寄存器）
    //--------------------------------------------------------------------------
    // n_div16 / prev_n_div16：n 18bit ⇒ >>4 后 14bit，再与 127 取小
    wire [13:0] n_div16_w  = n_r[17:4];
    wire [13:0] pn_div16_w = prev_n_r[17:4];
    wire [7:0]  n_div16_v  = (n_div16_w  > 14'd127) ? 8'd127 : n_div16_w[7:0];
    wire [7:0]  pn_div16_v = (pn_div16_w > 14'd127) ? 8'd127 : pn_div16_w[7:0];

    // 有符号差（显式扩宽 + $signed，避免无符号减法丢符号）
    wire signed [10:0] dx_raw = $signed({2'b00, cx_r})  - $signed({2'b00, pcx_r});
    wire signed [8:0]  dy_raw = $signed({1'b0, cy_r})   - $signed({1'b0, pcy_r});
    wire signed [17:0] pol_dif = $signed({1'b0, on_r})  - $signed({1'b0, off_r});

    wire [10:0] dx_abs  = dx_raw[10] ? (~dx_raw + 11'd1) : dx_raw;
    wire [8:0]  dy_abs  = dy_raw[8]  ? (~dy_raw + 9'd1)  : dy_raw;
    wire [17:0] pol_abs = pol_dif[17] ? (~pol_dif + 18'd1) : pol_dif;

    wire [24:0] pol_num  = pol_abs * 7'd127;                  // ≤ 8.32e6（24bit）
    wire [16:0] dxrel_num = {1'b0, dx_abs} << 6;              // ≤ 32704（16bit）
    wire [14:0] dyrel_num = {1'b0, dy_abs} << 6;              // ≤ 16320（14bit）

    // ④⑤ 的算术右移 + clip（clip 在实际坐标范围不会触发，保留防御）
    wire signed [10:0] dx_q_v = dx_raw >>> 2;
    wire signed [8:0]  dy_q_v = dy_raw >>> 1;
    wire [7:0] dx_v = (dx_q_v > 11'sd127)  ? 8'd127 :
                      (dx_q_v < -11'sd127) ? 8'h81  : dx_q_v[7:0];
    wire [7:0] dy_v = (dy_q_v > 9'sd127)   ? 8'd127 :
                      (dy_q_v < -9'sd127)  ? 8'h81  : dy_q_v[7:0];

    // var_num = Σx²·n − (Σx)²（Cauchy-Schwarz 保证 ≥0；防御性 clamp 到 0）
    wire [58:0] varx_num = (r_sx2n >= r_sxsx) ? (r_sx2n - r_sxsx) : 59'd0;
    wire [58:0] vary_num = (r_sy2n >= r_sysy) ? (r_sy2n - r_sysy) : 59'd0;
    wire [35:0] n2_w     = r_n2[35:0];

    // 开方输入（正常 ≤159201，防御性饱和到 20bit）
    wire [19:0] sqv_varx = (r_varx_q > 59'd1048575) ? 20'hFFFFF : r_varx_q[19:0];
    wire [19:0] sqv_vary = (r_vary_q > 59'd1048575) ? 20'hFFFFF : r_vary_q[19:0];
    wire [19:0] sqv_sxy  = (r_sxy    > 59'd1048575) ? 20'hFFFFF : r_sxy[19:0];

    // S = max(isqrt(sx*sy), 8)
    wire [9:0]  s_val = (r_s < 10'd8) ? 10'd8 : r_s;

    // ⑥⑦ floor 除法修正：num<0 且余数非零 ⇒ 商再 +1（幅值）
    wire [58:0] dxq_adj = (dx_raw[10] && (r_dx_rem != 37'd0)) ? (r_dx_q + 59'd1) : r_dx_q;
    wire [58:0] dyq_adj = (dy_raw[8]  && (r_dy_rem != 37'd0)) ? (r_dy_q + 59'd1) : r_dy_q;
    wire [7:0]  dxrel_abs = (dxq_adj > 59'd127) ? 8'd127 : dxq_adj[7:0];
    wire [7:0]  dyrel_abs = (dyq_adj > 59'd127) ? 8'd127 : dyq_adj[7:0];
    wire [7:0]  dx_rel_v  = dx_raw[10] ? (~dxrel_abs + 8'd1) : dxrel_abs;
    wire [7:0]  dy_rel_v  = dy_raw[8]  ? (~dyrel_abs + 8'd1) : dyrel_abs;

    // ③ pol_bal（向零截断：幅值除法后补符号）
    wire [7:0]  pol_abs_q = r_pol_q[7:0];
    wire [7:0]  pol_bal_v = pol_dif[17] ? (~pol_abs_q + 8'd1) : pol_abs_q;

    //--------------------------------------------------------------------------
    // 2. 三个串行功能单元的实例化与操作数
    //--------------------------------------------------------------------------
    wire        mu_start = (st == ST_M_SX2N) || (st == ST_M_SXSX) ||
                           (st == ST_M_SY2N) || (st == ST_M_SYSY) ||
                           (st == ST_M_N2)   || (st == ST_M_SXY);
    wire        dv_start = (st == ST_D_VARX) || (st == ST_D_VARY) ||
                           (st == ST_D_POLBAL) || (st == ST_D_DXREL) ||
                           (st == ST_D_DYREL);
    wire        sq_start = (st == ST_Q_SX) || (st == ST_Q_SY) || (st == ST_Q_S);

    wire [39:0] mu_a = (st == ST_M_SX2N) ? sx2_r :
                       (st == ST_M_SXSX) ? {15'd0, sx_r} :
                       (st == ST_M_SY2N) ? sy2_r :
                       (st == ST_M_SYSY) ? {15'd0, sy_r} :
                       (st == ST_M_N2)   ? {22'd0, n_r} :
                       (st == ST_M_SXY)  ? {30'd0, r_sx} : 40'd0;
    wire [24:0] mu_b2 =
                       (st == ST_M_SX2N) ? {7'd0, n_r} :
                       (st == ST_M_SXSX) ? {15'd0, sx_r} :
                       (st == ST_M_SY2N) ? {7'd0, n_r} :
                       (st == ST_M_SYSY) ? {15'd0, sy_r} :
                       (st == ST_M_N2)   ? {7'd0, n_r} :
                       (st == ST_M_SXY)  ? {15'd0, r_sy} : 25'd0;

    wire [58:0] dv_num = (st == ST_D_VARX)   ? varx_num :
                         (st == ST_D_VARY)   ? vary_num :
                         (st == ST_D_POLBAL) ? {34'd0, pol_num} :
                         (st == ST_D_DXREL)  ? {42'd0, dxrel_num} :
                         (st == ST_D_DYREL)  ? {44'd0, dyrel_num} : 59'd0;
    wire [35:0] dv_den = (st == ST_D_VARX || st == ST_D_VARY) ? n2_w :
                         (st == ST_D_POLBAL) ? {18'd0, n_r} :
                         (st == ST_D_DXREL || st == ST_D_DYREL) ? {26'd0, s_val} : 36'd0;

    wire [19:0] sq_val = (st == ST_Q_SX) ? sqv_varx :
                         (st == ST_Q_SY) ? sqv_vary :
                         (st == ST_Q_S)  ? sqv_sxy : 20'd0;

    wire        mu_done;
    wire        dv_done;
    wire        sq_done;
    wire [58:0] mu_p;
    wire [58:0] dv_q;
    wire [36:0] dv_rem;
    wire [9:0]  sq_root;

    nn_winfeat_mul u_mul (
        .clk(clk_cam), .rst_n(rst_n_cam), .i_start(mu_start),
        .i_a(mu_a), .i_b(mu_b2), .o_done(mu_done), .o_p(mu_p)
    );
    nn_winfeat_div u_div (
        .clk(clk_cam), .rst_n(rst_n_cam), .i_start(dv_start),
        .i_num(dv_num), .i_den(dv_den), .o_done(dv_done), .o_q(dv_q), .o_rem(dv_rem)
    );
    nn_winfeat_sqrt u_sqrt (
        .clk(clk_cam), .rst_n(rst_n_cam), .i_start(sq_start),
        .i_val(sq_val), .o_done(sq_done), .o_root(sq_root)
    );

    wire wait_done = (wk == 2'd0) ? mu_done : (wk == 2'd1) ? dv_done : sq_done;

    assign o_busy = (st != ST_IDLE);

    //--------------------------------------------------------------------------
    // 3. 主状态机
    //--------------------------------------------------------------------------
    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            st           <= ST_IDLE;
            st_next      <= ST_IDLE;
            op_tag       <= 5'd0;
            wk           <= 2'd0;
            n_r          <= 18'd0;
            on_r         <= 17'd0;
            off_r        <= 17'd0;
            sx_r         <= 25'd0;
            sy_r         <= 25'd0;
            sx2_r        <= 40'd0;
            sy2_r        <= 40'd0;
            cx_r         <= 9'd0;
            pcx_r        <= 9'd0;
            cy_r         <= 8'd0;
            pcy_r        <= 8'd0;
            prev_n_r     <= 18'd0;
            r_sx2n       <= 59'd0;
            r_sxsx       <= 59'd0;
            r_sy2n       <= 59'd0;
            r_sysy       <= 59'd0;
            r_n2         <= 59'd0;
            r_sxy        <= 59'd0;
            r_varx_q     <= 59'd0;
            r_vary_q     <= 59'd0;
            r_pol_q      <= 59'd0;
            r_dx_q       <= 59'd0;
            r_dy_q       <= 59'd0;
            r_dx_rem     <= 37'd0;
            r_dy_rem     <= 37'd0;
            r_sx         <= 10'd0;
            r_sy         <= 10'd0;
            r_s          <= 10'd0;
            cyc_cnt      <= 11'd0;
            o_feat_valid <= 1'b0;
            o_n_div16    <= 8'd0;
            o_prev_n_div16 <= 8'd0;
            o_pol_bal    <= 8'd0;
            o_dx         <= 8'd0;
            o_dy         <= 8'd0;
            o_dx_rel     <= 8'd0;
            o_dy_rel     <= 8'd0;
            o_cyc_cnt    <= 11'd0;
        end else begin
            o_feat_valid <= 1'b0;

            // 周期计数（证据用）：每次窗末计算从 0 起数
            if (st == ST_IDLE) cyc_cnt <= 11'd0;
            else if (cyc_cnt != 11'h7FF) cyc_cnt <= cyc_cnt + 11'd1;

            // 串行单元完成 → 按标签回写结果（与状态机并行）
            if (mu_done) begin
                case (op_tag)
                    OP_M_SX2N: r_sx2n <= mu_p;
                    OP_M_SXSX: r_sxsx <= mu_p;
                    OP_M_SY2N: r_sy2n <= mu_p;
                    OP_M_SYSY: r_sysy <= mu_p;
                    OP_M_N2:   r_n2   <= mu_p;
                    OP_M_SXY:  r_sxy  <= mu_p;
                    default: ;
                endcase
            end
            if (dv_done) begin
                case (op_tag)
                    OP_D_VARX: r_varx_q <= dv_q;
                    OP_D_VARY: r_vary_q <= dv_q;
                    OP_D_POL:  r_pol_q  <= dv_q;
                    OP_D_DX:   begin r_dx_q <= dv_q; r_dx_rem <= dv_rem; end
                    OP_D_DY:   begin r_dy_q <= dv_q; r_dy_rem <= dv_rem; end
                    default: ;
                endcase
            end
            if (sq_done) begin
                case (op_tag)
                    OP_Q_SX: r_sx <= sq_root;
                    OP_Q_SY: r_sy <= sq_root;
                    OP_Q_S:  r_s   <= sq_root;
                    default: ;
                endcase
            end

            case (st)
            // ---------------- 空闲：等窗末快照 ----------------
            ST_IDLE: begin
                if (i_snap_valid) begin
                    n_r      <= i_n;
                    on_r     <= i_on;
                    off_r    <= i_off;
                    sx_r     <= i_sx;
                    sy_r     <= i_sy;
                    sx2_r    <= i_sx2;
                    sy2_r    <= i_sy2;
                    cx_r     <= i_cx;
                    cy_r     <= i_cy;
                    pcx_r    <= i_pcx;
                    pcy_r    <= i_pcy;
                    prev_n_r <= i_prev_n;
                    if (i_n == 18'd0)
                        st <= ST_EMPTY;   // 空窗：不启动任何串行单元
                    else
                        st <= ST_M_SX2N;
                end
            end

            // ---------------- 乘法：Σx²·n、Σx²、Σy²·n、Σy²、n²、sx·sy ----------------
            ST_M_SX2N: begin op_tag <= OP_M_SX2N; wk <= 2'd0; st_next <= ST_M_SXSX; st <= ST_WAIT; end
            ST_M_SXSX: begin op_tag <= OP_M_SXSX; wk <= 2'd0; st_next <= ST_M_SY2N; st <= ST_WAIT; end
            ST_M_SY2N: begin op_tag <= OP_M_SY2N; wk <= 2'd0; st_next <= ST_M_SYSY; st <= ST_WAIT; end
            ST_M_SYSY: begin op_tag <= OP_M_SYSY; wk <= 2'd0; st_next <= ST_M_N2;   st <= ST_WAIT; end
            ST_M_N2:   begin op_tag <= OP_M_N2;   wk <= 2'd0; st_next <= ST_D_VARX; st <= ST_WAIT; end
            ST_M_SXY:  begin op_tag <= OP_M_SXY;  wk <= 2'd0; st_next <= ST_Q_S;    st <= ST_WAIT; end

            // ---------------- 除法：var_x、var_y、pol_bal、dx_rel、dy_rel ----------------
            ST_D_VARX:   begin op_tag <= OP_D_VARX; wk <= 2'd1; st_next <= ST_Q_SX;     st <= ST_WAIT; end
            ST_D_VARY:   begin op_tag <= OP_D_VARY; wk <= 2'd1; st_next <= ST_Q_SY;     st <= ST_WAIT; end
            ST_D_POLBAL: begin op_tag <= OP_D_POL;  wk <= 2'd1; st_next <= ST_D_DXREL;  st <= ST_WAIT; end
            ST_D_DXREL:  begin op_tag <= OP_D_DX;   wk <= 2'd1; st_next <= ST_D_DYREL;  st <= ST_WAIT; end
            ST_D_DYREL:  begin op_tag <= OP_D_DY;   wk <= 2'd1; st_next <= ST_OUT;      st <= ST_WAIT; end

            // ---------------- 开方：sx、sy、S ----------------
            ST_Q_SX: begin op_tag <= OP_Q_SX; wk <= 2'd2; st_next <= ST_D_VARY; st <= ST_WAIT; end
            ST_Q_SY: begin op_tag <= OP_Q_SY; wk <= 2'd2; st_next <= ST_M_SXY;  st <= ST_WAIT; end
            ST_Q_S:  begin op_tag <= OP_Q_S;  wk <= 2'd2; st_next <= ST_D_POLBAL; st <= ST_WAIT; end

            // ---------------- 等待串行单元完成 ----------------
            ST_WAIT: begin
                if (wait_done) st <= st_next;
            end

            // ---------------- 输出（7 路特征 + 单拍 valid）----------------
            ST_OUT: begin
                o_feat_valid   <= 1'b1;
                o_n_div16      <= n_div16_v;
                o_prev_n_div16 <= pn_div16_v;
                o_pol_bal      <= pol_bal_v;
                o_dx           <= dx_v;
                o_dy           <= dy_v;
                o_dx_rel       <= dx_rel_v;
                o_dy_rel       <= dy_rel_v;
                o_cyc_cnt      <= cyc_cnt + 11'd1;
                st <= ST_IDLE;
            end

            // ---------------- 空窗短路（n=0：不除零，7 路除 prev_n_div16 全 0）----------------
            ST_EMPTY: begin
                o_feat_valid   <= 1'b1;
                o_n_div16      <= 8'd0;
                o_prev_n_div16 <= pn_div16_v;
                o_pol_bal      <= 8'd0;
                o_dx           <= 8'd0;
                o_dy           <= 8'd0;
                o_dx_rel       <= 8'd0;
                o_dy_rel       <= 8'd0;
                o_cyc_cnt      <= cyc_cnt + 11'd1;
                st <= ST_IDLE;
            end

            default: st <= ST_IDLE;
            endcase
        end
    end
endmodule
