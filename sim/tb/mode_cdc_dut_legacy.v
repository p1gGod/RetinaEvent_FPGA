//==============================================================================
// mode_cdc_dut_legacy.v —— ★ F3 复现夹具：**修复前**的 SET_MODE 跨域结构（逐字副本）
//
// 用途：给 tb_mode_cdc 提供"修复前 DUT"。内容与 2026-10-12 的 top_retina_event.v
//       :186-192 逐字一致 —— 值(WIDTH=2) 与 toggle(WIDTH=1) 是**两条互相独立的
//       sync_ff**（各自 2 级），direct 送 sys_ctrl（不套静默窗）。
//
// 运行方式（只做复现取证，**不进全量回归**：文件名不匹配 tb_*.v）：
//   pwsh -File tool\run_sim.ps1 -Tb tb_mode_cdc -Deps `
//     src/hdl/primitives/sync_ff.v,src/hdl/primitives/edge_detect.v, `
//     src/hdl/control/sys_ctrl.v,sim/tb/mode_cdc_dut_legacy.v
//
// ⚠️ 该夹具预期 **TEST_RESULT=FAIL**（复现 F3 丢写）；它证明"同一份激励确实能抓到竞态"，
//    不能证明修复有效 —— 修复有效性看 tb_mode_cdc + mode_cdc_dut_fixed.v 的 PASS。
//==============================================================================
`timescale 1ns / 1ps

module mode_cdc_dut (
    input  wire       dst_clk,
    input  wire       dst_rst_n,
    input  wire [1:0] i_val,
    input  wire       i_tog,
    output wire [1:0] o_val,
    output wire       o_tog
);

    // ---- 修复前结构（top_retina_event.v:186-192 逐字副本）----
    sync_ff #(.WIDTH(2), .STAGES(2)) u_cdc2_mode_set (
        .dest_clk (dst_clk), .dest_rst_n (dst_rst_n),
        .i_src (i_val), .o_dst (o_val));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_cdc2_mode_upd (
        .dest_clk (dst_clk), .dest_rst_n (dst_rst_n),
        .i_src (i_tog), .o_dst (o_tog));

endmodule
