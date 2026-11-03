//==============================================================================
// vps_mux -- 同域两路 VPS 二选一，**帧边界同步切换**（L2 采集，P1）
//
// 规格：retina_event/docs/子模块设计/L2_采集/vps_mux.md §2/§3/§4/§6
//   B1 选择寄存器 sel_r **只在帧边界（vsync 上升沿）更新**
//   B2 输出多路 o_* = (sel_r==1) ? B : A     （sel_r==2 为预留的"回放"，当前按 A 处理）
//   B3 可选对齐：ALIGN_LATENCY > 0 时对 A/B 各加一级 delay_pipe（L1 原语，端口见文档 §2）
//
// ⚠️ §9.1：必须帧同步切换，否则事件引擎会因"源突变"产生满屏假事件。
// ⚠️ §9.2：两路输入必须同域（clk_cam）。
//
// 切换判据取【对齐后】的 a_vsync（ALIGN_LATENCY != 0 时，a_vsync 与 a_data 同拍延迟，
// 故在其上升沿切换可保证 B 路也正好落在帧边界上）。
//==============================================================================
`timescale 1ns / 1ps

module vps_mux #(
    parameter ALIGN_LATENCY = 0     // 0 = 不对齐；1~8 = 对 A/B 各延迟这么多拍
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire [1:0]  i_sel,       // 0=相机(A)，1=自检(B)，2=回放(预留)
    input  wire        a_vsync,
    input  wire        a_de,
    input  wire [15:0] a_data,
    input  wire        b_vsync,
    input  wire        b_de,
    input  wire [15:0] b_data,
    output wire        o_vsync,
    output wire        o_de,
    output wire [15:0] o_data
);

    //--------------------------------------------------------------------------
    // B3：可选对齐（打包成 18 bit 一次延迟，A/B 各一路）
    //--------------------------------------------------------------------------
    wire [17:0] a_al;
    wire [17:0] b_al;

    generate
        if (ALIGN_LATENCY == 0) begin : g_noalign
            assign a_al = {a_vsync, a_de, a_data};
            assign b_al = {b_vsync, b_de, b_data};
        end else begin : g_align
            delay_pipe #(.WIDTH(18), .LATENCY(ALIGN_LATENCY)) u_dly_a (
                .clk     (clk_cam),
                .rst_n   (rst_n_cam),
                .i_data  ({a_vsync, a_de, a_data}),
                .o_data  (a_al)
            );
            delay_pipe #(.WIDTH(18), .LATENCY(ALIGN_LATENCY)) u_dly_b (
                .clk     (clk_cam),
                .rst_n   (rst_n_cam),
                .i_data  ({b_vsync, b_de, b_data}),
                .o_data  (b_al)
            );
        end
    endgenerate

    //--------------------------------------------------------------------------
    // B1：帧边界同步的选择寄存器（内联 1 拍沿检测，语义同 edge_detect）
    //
    // ⚠️ 集成修复（Lead，2026-10-03）：**不能只在 a_vsync（相机）的帧边界切换**。
    //    那样在"没有摄像头 / 相机没出图"时，a_vsync 永不出现 ⇒ sel_r 永远停在复位值 0
    //    ⇒ **自检图案源永远选不上**，直接违背 vps_mux / vps_pattern_gen 的设计目的
    //    （文档 §1："无摄像头也能跑通引擎"）。
    //    实测症状：top 层系统仿真里 i_cfg_src=1 但事件数恒为 0、统计帧计数恒为 0。
    //    修法：**任一源的帧边界都允许切换** + 复位时直接用 i_sel 预置。
    //--------------------------------------------------------------------------
    reg [1:0] sel_r;
    reg       a_vs_d1;
    reg       b_vs_d1;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            sel_r   <= i_sel;          // 复位即按请求选源（无相机时也能立刻出自检图案）
            a_vs_d1 <= 1'b0;
            b_vs_d1 <= 1'b0;
        end else begin
            a_vs_d1 <= a_al[17];
            b_vs_d1 <= b_al[17];
            // 任一源出现帧边界即可切换（避免"另一源不出图就永远切不过去"）
            if ((a_al[17] & ~a_vs_d1) | (b_al[17] & ~b_vs_d1)) sel_r <= i_sel;
        end
    end

    //--------------------------------------------------------------------------
    // B2：输出多路
    //--------------------------------------------------------------------------
    assign o_vsync = (sel_r == 2'd1) ? b_al[17]    : a_al[17];
    assign o_de    = (sel_r == 2'd1) ? b_al[16]    : a_al[16];
    assign o_data  = (sel_r == 2'd1) ? b_al[15:0]  : a_al[15:0];

endmodule
