//==============================================================================
// stats_counter -- 事件计数 / 活动像素占比 ρ / 数据量降低倍数 CR（L2 事件引擎，P0）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/stats_counter.md §2/§3/§4/§6
//   B1 每帧事件计数 ev_f；B2 帧边界锁存 ev_lat + 清零
//   B3 活动占比 ρ = ev_lat / (IMG_W·IMG_H)，输出 Q_FRAC 定点（默认 Q16）
//   B4 数据量降低倍数 CR×10 = (10·B_PX·IMG_W·IMG_H / B_EV) / ev_lat
//   B5 累计 32 bit：总事件数 / 总帧数
//
// 除法的定点化（事实 H23：数据通路禁止变量除法）：
//   · ρ 的分母 IMG_W·IMG_H 是**常数** ⇒ 用常数除法，综合器优化为"乘倒数 + 移位"。
//   · CR 的分母是变量 ev_lat ⇒ **不写成组合除法器**，而用一个小型**时序恢复余数除法器**
//     （24 拍，只在 vsync 后启动一次，消隐期内完成）。资源 = 24 bit 减法器 + 5 bit 计数，
//     远小于组合变量除法器，且不会进入逐像素关键路径。
//   · ev_lat = 0 ⇒ CR 饱和为 24'hFFFFFF。
//
// 口径（文档 §3/§9.1 要求写清）：
//   CR = (B_PX · px) / (B_EV · ev)，默认 B_PX=16（RGB565 基线）、B_EV=24（事件编码位宽）
//   ⇒ CR×10 = 640000 / ev。ev=96 → 6667（ρ=0.1%）；ev=960 → 667；ev=9600 → 67。
//
// i_px_valid 按文档 §2 标注为"可选"：本实现用它统计每帧实际像素数 px_f/px_lat
//   （供仿真自检 px_lat == IMG_W·IMG_H），而 ρ/CR 的分母按 §4 用**常量** IMG_W·IMG_H。
//   ⇒ 不引入变量分母，也不会因该端口未接线而破坏统计口径。
//
// ⚠️ §9.2 中间结果位宽：ev_lat×65536 需 40 bit，本实现用 48 bit 中间量。
// ⚠️ §9.3 跨域副本（clk_lcd）由 event_sink 提供（文档 §2 末行允许），本模块只出 clk_cam 域值。
//==============================================================================
`timescale 1ns / 1ps

module stats_counter #(
    parameter IMG_W  = 400,         // 像素总数基准宽
    parameter IMG_H  = 240,         // 像素总数基准高
    parameter B_PX   = 16,          // 帧式基线位宽（RGB565）
    parameter B_EV   = 24,          // 事件编码位宽（坐标+极性+保留）
    parameter Q_FRAC = 16           // 占比定点小数位
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_vsync,         // 帧边界（1 拍脉冲或电平，内部取上升沿）
    input  wire        i_ev_valid,      // 事件脉冲（计数）
    input  wire        i_px_valid,      // 像素有效（可选，统计每帧实际像素数）
    output reg  [23:0] o_ev_per_frame,  // 本帧事件数（锁存）
    output reg  [15:0] o_activity_q16,  // ρ × 65536
    output reg  [23:0] o_cr_x10,        // 降低倍数 ×10（饱和）
    output reg  [31:0] o_frame_cnt,     // 总帧数
    output reg  [31:0] o_ev_total       // 总事件数
);

    localparam PX = IMG_W * IMG_H;                          // 96,000
    localparam [47:0] CR_NUM = (B_PX * PX * 10) / B_EV;     // 640,000

    //--------------------------------------------------------------------------
    // B1/B2/B5：计数与帧边界锁存
    //--------------------------------------------------------------------------
    reg [23:0] ev_f;
    reg [23:0] ev_lat;
    reg [23:0] px_f;
    reg [23:0] px_lat;
    reg        vs_d1;

    wire vs_rise = i_vsync & ~vs_d1;

    //--------------------------------------------------------------------------
    // B3：活动占比（常数分母，零变量除法）
    //--------------------------------------------------------------------------
    wire [47:0] act_num = {{24{1'b0}}, ev_f} << Q_FRAC;
    wire [47:0] act_quo = act_num / PX;
    wire [15:0] act_q16 = (act_quo > 48'd65535) ? 16'hFFFF : act_quo[15:0];

    //--------------------------------------------------------------------------
    // B4：CR×10 的时序恢复余数除法器（24 拍一次，vsync 后启动）
    //--------------------------------------------------------------------------
    localparam [23:0] CR_NUM24 = (CR_NUM > 48'd16777215) ? 24'hFFFFFF : CR_NUM[23:0];

    reg        div_busy;
    reg [4:0]  div_cnt;
    reg [24:0] div_rem;
    reg [24:0] div_den;
    reg [23:0] div_num;
    reg [23:0] div_quo;

    // ⚠️ 恢复余数法：比较必须用**左移并带进新位之后**的余数，不能用手移前的值
    //    （首版把 div_ge 建在移位前的 div_rem 上，结果 640048/96 得 4095 而非 6667，
    //      被 tb_stats_counter 的 CR 判据抓住）。
    wire [24:0] div_sh    = {div_rem[23:0], div_num[23]};
    wire        div_ge    = (div_sh >= div_den);
    wire [24:0] div_rem_n = div_ge ? (div_sh - div_den) : div_sh;
    wire [23:0] div_quo_n = {div_quo[22:0], div_ge};

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            ev_f            <= 24'd0;
            ev_lat          <= 24'd0;
            px_f            <= 24'd0;
            px_lat          <= 24'd0;
            o_ev_per_frame  <= 24'd0;
            o_activity_q16  <= 16'd0;
            o_cr_x10        <= 24'hFFFFFF;
            o_frame_cnt     <= 32'd0;
            o_ev_total      <= 32'd0;
            vs_d1           <= 1'b0;
            div_busy        <= 1'b0;
            div_cnt         <= 5'd0;
            div_rem         <= 25'd0;
            div_den         <= 25'd0;
            div_num         <= 24'd0;
            div_quo         <= 24'd0;
        end else begin
            vs_d1 <= i_vsync;

            // ---- 逐拍累计 ----
            if (i_ev_valid) begin
                ev_f       <= ev_f + 1'b1;
                o_ev_total <= o_ev_total + 1'b1;
            end
            if (i_px_valid) px_f <= px_f + 1'b1;

            // ---- 帧边界锁存 + 清零（vsync 上升沿）----
            if (vs_rise) begin
                ev_lat         <= ev_f;
                px_lat         <= px_f;
                o_ev_per_frame <= ev_f;
                o_activity_q16 <= act_q16;
                o_frame_cnt    <= o_frame_cnt + 1'b1;
                ev_f           <= 24'd0;
                px_f           <= 24'd0;
            end

            // ---- B4：CR 除法器 ----
            if (!div_busy) begin
                if (vs_rise) begin
                    if (ev_f == 24'd0) begin
                        o_cr_x10 <= 24'hFFFFFF;         // 无事件 ⇒ 饱和
                    end else begin
                        div_den  <= {1'b0, ev_f};
                        div_num  <= CR_NUM24 + {19'd0, ev_f[23:1]};   // 舍入：+ ev/2
                        div_quo  <= 24'd0;
                        div_rem  <= 25'd0;
                        div_cnt  <= 5'd0;
                        div_busy <= 1'b1;
                    end
                end
            end else begin
                div_rem <= div_rem_n;
                div_quo <= div_quo_n;
                div_num <= {div_num[22:0], 1'b0};
                div_cnt <= div_cnt + 1'b1;
                if (div_cnt == 5'd23) begin
                    div_busy <= 1'b0;
                    o_cr_x10 <= div_quo_n;
                end
            end
        end
    end

endmodule
