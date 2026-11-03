//==============================================================================
// nn_rom —— 权重/bias/SH 只读存储器（400 MHz 级同步读口，综合必须推断成 BRAM）
//
// 【结构】本模块只是 nn_rom_data（脚本生成的 5,652 字 ROM）的薄封装：
//   · 单独一层封装的目的：nn_engine / nn_top / TB 都只依赖 nn_rom 的端口，
//     生成文件 nn_rom_data.v 可以被 tool/nn_gen_placeholder.py 整份重写而不动别处；
//   · 读口 1 拍延迟（同步读）：addr 在 C 拍给出，dout 在 C+1 拍有效。
//   · 综合：reg 数组 + initial 初始化 + 同步读 ⇒ Vivado 推断 block RAM；
//     生成文件里另有 (* rom_style = "block" *) 显式锁定。
//
// 【TB 覆盖】tb_nn_top 在 #1 通过分层赋值覆盖 u_rom_data.rom 的 5,652 个字，
//   构造稀疏可控网络（实测 ModelSim 分层写 reg 数组有效）。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_rom (
    input  wire                  clk,
    input  wire [`NN_ROM_AW-1:0] i_addr,
    output wire [31:0]           o_dout
);

    nn_rom_data u_rom_data (
        .o_dout (o_dout),
        .clk    (clk),
        .i_addr (i_addr)
    );

endmodule
