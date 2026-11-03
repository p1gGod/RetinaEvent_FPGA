//==============================================================================
// clk_wiz_0_sim.v -- clk_wiz_0 的行为级**仿真替身**（只用于 ModelSim，不进 Vivado 工程）
//
// 端口与真 IP 完全一致（取自厂家 `.veo` 例化模板）：
//   clk_out1 (200 MHz) / clk_out2 (50 MHz) / reset / locked / clk_in1
// 输入假定 50 MHz（周期 20 ns）。
//
// ⚠️ 千万不要把本文件加进 Vivado 工程的 sources —— 会与真 IP 的 `clk_wiz_0` 重名。
//==============================================================================
`timescale 1ns / 1ps

module clk_wiz_0 (
    output wire clk_out1,       // 200 MHz
    output wire clk_out2,       //  50 MHz
    input  wire reset,
    output wire locked,
    input  wire clk_in1         //  50 MHz
);

    reg c1 = 1'b0;
    reg c2 = 1'b0;

    always #2.5 c1 = ~c1;       // 5.0 ns 周期 = 200 MHz
    always #10  c2 = ~c2;       // 20.0 ns 周期 =  50 MHz

    reg locked_r = 1'b0;
    initial begin
        locked_r = 1'b0;
        #1000;                  // 1 us 后锁定（真 MMCM 量级）
        if (reset) locked_r = 1'b0;
        else       locked_r = 1'b1;
    end

    assign clk_out1 = c1;
    assign clk_out2 = c2;
    assign locked   = locked_r;

endmodule
