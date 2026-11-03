`timescale 1ns/1ps
`include "nn_cfg_probe.vh"
module mod_probe(input clk, input rst_n, output reg [7:0] o);
  reg [7:0] mem [0:3];
  initial begin mem[0]=8'h11; mem[1]=8'h22; mem[2]=8'h33; mem[3]=8'h44; end
  reg [7:0] q;
  always @(posedge clk) q <= mem[1];
  always @(posedge clk) if (!rst_n) o <= `PROBE_VAL; else o <= q;
endmodule
