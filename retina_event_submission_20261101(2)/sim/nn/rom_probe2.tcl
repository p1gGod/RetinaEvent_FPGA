# rom_probe2.tcl -- 看 5718x32 ROM 实际映射到 RAMB 的位宽（诊断用，sim/nn/ 白名单内）
set script_dir [file dirname [file normalize [info script]]]
set root [file normalize [file join $script_dir .. ..]]
set src [file join $root src hdl nn nn_rom_data.v]
set_param general.maxThreads 1
read_verilog $src
synth_design -top nn_rom_data -part xc7a100tfgg484-2
foreach c [get_cells -hier -filter {REF_NAME =~ RAMB*}] {
  set nm [get_property NAME $c]
  set rw [get_property -quiet READ_WIDTH_A $c]
  set rw2 [get_property -quiet READ_WIDTH_B $c]
  set ww [get_property -quiet WRITE_WIDTH_A $c]
  puts "ROMP2_CELL=$nm RW_A=$rw RW_B=$rw2 WW_A=$ww"
}
puts "ROMP2_DONE=1"
