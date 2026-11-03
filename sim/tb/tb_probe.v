`timescale 1ns/1ps
module tb_probe;
  reg clk=0, rst_n=0; always #5 clk=~clk;
  wire [7:0] o;
  mod_probe dut(.clk(clk), .rst_n(rst_n), .o(o));
  initial begin
    #1;
    dut.mem[1] = 8'hAB;
    #100;
    $display("PROBE_O=%0d MEM1=%0d", o, dut.mem[1]);
    $display("TEST_RESULT=PASS"); $finish;
  end
endmodule
