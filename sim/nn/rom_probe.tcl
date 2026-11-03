# rom_probe.tcl  -- 诊断用：单独综合 nn_rom_data，确认 5718x32 ROM 的 BRAM 取法
# （只写 sim/nn/ 下，属于 task-21 白名单；跑完可删）
set script_dir [file dirname [file normalize [info script]]]
set root [file normalize [file join $script_dir .. ..]]
set out_dir [file join $root sim nn]
set src [file join $root src hdl nn nn_rom_data.v]
puts "ROMP_SRC=$src"
puts "ROMP_EXISTS=[file exists $src]"
set_param general.maxThreads 1
read_verilog $src
synth_design -top nn_rom_data -part xc7a100tfgg484-2
set r36 [llength [get_cells -hier -filter {REF_NAME == RAMB36E1}]]
set r18 [llength [get_cells -hier -filter {REF_NAME == RAMB18E1}]]
puts "ROMP_RAMB36=$r36"
puts "ROMP_RAMB18=$r18"
report_utilization -file [file join $out_dir rom_probe_util.rpt]
puts "ROMP_DONE=1"
