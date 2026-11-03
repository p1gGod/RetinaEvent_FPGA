//==============================================================================
// bufg_sim.v -- Xilinx BUFG 的**仿真替身**（只用于 ModelSim，不进 Vivado 工程）
//
// 真 BUFG 是 unisims_ver 库里的原语；ModelSim 默认没编译该库，故提供等价行为级模型。
// 行为：理想全局时钟缓冲 = 直连（不含延迟/驱动能力建模，本项目仿真不需要）。
//
// ⚠️ 不要把它加进 Vivado 工程的 sources（会与 unisims 的 BUFG 冲突）。
//==============================================================================
`timescale 1ns / 1ps

module BUFG (
    input  wire I,
    output wire O
);

    assign O = I;

endmodule
