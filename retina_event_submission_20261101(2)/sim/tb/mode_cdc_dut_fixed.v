//==============================================================================
// mode_cdc_dut_fixed.v —— ★ F3 修复后 DUT：值+toggle 成对跨域（静默窗握手）
//
// 内容 = top_retina_event.v 现在对 mode 通道的接法，逐字一致：
//   cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3))  ← 取代两条独立 sync_ff
//
// 运行方式（全量回归默认路径，见 tb_mode_cdc.f）：
//   pwsh -File tool\run_sim.ps1 -Tb tb_mode_cdc
//==============================================================================
`timescale 1ns / 1ps

module mode_cdc_dut #(
    parameter SETTLE = 3
)(
    input  wire       dst_clk,
    input  wire       dst_rst_n,
    input  wire [1:0] i_val,
    input  wire       i_tog,
    output wire [1:0] o_val,
    output wire       o_tog
);

    // ---- 修复后结构（top_retina_event.v 同款接法）----
    cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(SETTLE)) u_cdc_mode (
        .dst_clk   (dst_clk),
        .dst_rst_n (dst_rst_n),
        .i_src_val (i_val),
        .i_src_tog (i_tog),
        .o_dst_val (o_val),
        .o_dst_tog (o_tog));

endmodule
