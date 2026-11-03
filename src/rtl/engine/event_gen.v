//==============================================================================
// event_gen -- 中心-周边响应 → ON/OFF 事件的双阈值判决（L2 事件引擎，P0 核心判决级）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/event_gen.md §2/§3/§4/§6
//   lap ≥ +θ  → ON（变亮）；lap ≤ −θ → OFF（变暗）；|lap| < θ → 无事件
//   最小亮度守卫：|ΔL| < MIN_DL 时不出事件（抑制暗区量化噪声假事件，§9.2 列 P0）
//   输出 = 坐标 + 极性，固定 1 拍输出寄存延迟（坐标与 i_de 同拍对齐后寄存）
//
// ── R3 契约：**坐标与守卫 ΔL 都随流走，本模块不重建任何上游已知的信息** ──
//   （Lead 裁决，2026-10-03；tb_event_gen 的 R3_* 判据守住）
//   · i_x / i_y 直接来自 spatial_lap 的 o_x / o_y（窗口中心像素的坐标），
//     与 i_lap / i_dl_c **同拍** ⇒ 本模块**没有任何内部 x/y 计数**，
//     也**不需要 i_vsync 复位**（原 i_vsync 端口已删除）。
//   · i_dl_c 直接来自 spatial_lap 的 o_dl_c（**同一个窗口中心像素**的 ΔL）
//     ⇒ 守卫不再依赖任何 delay_pipe 猜延迟（实测该延迟随 de 稀疏度在 4~5 拍间变化，
//        固定补偿必然错位 ⇒ 事件被全部门掉）。
//   · 旧实现（自己按 de 脉冲数坐标 + 用 temporal_diff 的原始 ΔL 做守卫）已废弃：
//     实测事件坐标偏移 (x−95, y−88) 且逐帧漂移 ≈ −25 行/帧（移位帧 0 事件）。
//
// 阈值来源（文档未规定优先级，本实现取"端口优先、端口为 0 时回落编译期默认"）：
//   θ_on  = (i_theta  != 0) ? i_theta  : THETA_ON      ← 端口为 0 语义无意义（会全屏触发）
//   θ_off = (i_theta  != 0) ? i_theta  : THETA_OFF     ← 单端口 i_theta 默认对称
//   min   = (i_min_dl != 0) ? i_min_dl : MIN_DL
//   ⚠️ 副作用：i_min_dl = 0 不再表示"关闭守卫"；要关闭守卫请把 MIN_DL 也设为 0。
//
// ⚠️ §9.1 θ 必须在 spatial_lap 的 NORM_SHIFT **之后**标定（两模块默认值成对定义）。
// ⚠️ §9.3 lap 是 S12 ⇒ 比较必须用 $signed，否则负值会被当成大正数。
// ⚠️ §9.5 极性约定 (POL_ON_IS_1) 必须与 event_render / hud_event_layer / PC 端一致。
//==============================================================================
`timescale 1ns / 1ps

module event_gen #(
    parameter THETA_ON    = 74,     // ON  阈值（L LSB；θ=0.20 自然对数 ≈ 74）
    parameter THETA_OFF   = 74,     // OFF 阈值（默认对称）
    parameter MIN_DL      = 2,      // 最小亮度守卫（|ΔL| < MIN_DL 不出事件）
    parameter POL_ON_IS_1 = 1       // 1 = ON 编码为 1；0 = ON 编码为 0
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_de,        // 有效限定符（可稀疏）
    input  wire [11:0] i_lap,       // 中心-周边响应（S12；归一化后 S10）
    input  wire [8:0]  i_dl_c,      // 🔧 R3：**窗口中心像素**的 ΔL（S9，来自 spatial_lap.o_dl_c）
    input  wire [8:0]  i_x,         // 🔧 R3：窗口中心像素列（来自 spatial_lap.o_x）
    input  wire [7:0]  i_y,         // 🔧 R3：窗口中心像素行（来自 spatial_lap.o_y）
    input  wire [11:0] i_theta,     // 正阈值（来自 RGS）
    input  wire [8:0]  i_min_dl,    // 最小亮度守卫门限（来自 RGS）
    output reg         o_ev_valid,  // 本拍有事件
    output reg  [8:0]  o_ev_x,      // 0..399
    output reg  [7:0]  o_ev_y,      // 0..239
    output reg         o_ev_pol     // 1 = ON（变亮），0 = OFF（变暗）
);

    //--------------------------------------------------------------------------
    // B2/B3：阈值译码 + 有符号比较 + 最小亮度守卫
    //--------------------------------------------------------------------------
    wire [11:0] theta_on_w  = (i_theta != 12'd0) ? i_theta : THETA_ON[11:0];
    wire [11:0] theta_off_w = (i_theta != 12'd0) ? i_theta : THETA_OFF[11:0];
    wire [8:0]  min_dl_w    = (i_min_dl != 9'd0) ? i_min_dl : MIN_DL[8:0];

    wire on  = ($signed(i_lap) >=  $signed(theta_on_w));
    wire off = ($signed(i_lap) <= -$signed(theta_off_w));

    wire [8:0] dl_abs = i_dl_c[8] ? (~i_dl_c + 9'd1) : i_dl_c;    // 取绝对值（S9）
    wire       guard  = (dl_abs >= min_dl_w);

    //--------------------------------------------------------------------------
    // B4/B5：事件组装 + 输出打拍（坐标与 i_de 同拍，直接随流寄存 1 拍）
    //--------------------------------------------------------------------------
    wire ev_comb = i_de & (on | off) & guard;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            o_ev_valid <= 1'b0;
            o_ev_x     <= 9'd0;
            o_ev_y     <= 8'd0;
            o_ev_pol   <= 1'b0;
        end else begin
            o_ev_valid <= ev_comb;
            o_ev_x     <= i_x;      // 🔧 R3：坐标随流走（不再有内部计数）
            o_ev_y     <= i_y;
            o_ev_pol   <= (POL_ON_IS_1 != 0) ? on : ~on;
        end
    end

endmodule
