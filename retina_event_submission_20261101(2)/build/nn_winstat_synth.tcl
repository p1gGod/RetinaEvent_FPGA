#==============================================================================
# nn_winstat synth-only check (M3b task-40 criterion f)
#   - synth_design + opt_design ONLY (no place/route, no bitstream)
#   - prints WINSTAT_LUT / WINSTAT_FF / WINSTAT_DSP / WINSTAT_BRAM
#   - prints WINSTAT_SYNTH_OK=1 on success
# NOTE: ASCII only, no BOM (Vivado Tcl does not skip BOM).
# Run from retina_event/ :
#   vivado -mode batch -source tool/nn_winstat_synth.tcl
#==============================================================================
set part xc7a100tfgg484-2
set top  nn_winstat
set out  build
file mkdir $out

read_verilog src/hdl/nn/nn_winstat.v
synth_design -top $top -part $part -mode out_of_context
opt_design

report_utilization -file $out/winstat_util.rpt
report_timing_summary -no_header -no_detailed_paths -file $out/winstat_timing.rpt -warn_on_violation

# ---- primitive counts (post-synth, out-of-context) ----
set n_lut_cells [llength [get_cells -hier -filter {REF_NAME =~ LUT*}]]
set n_lutram    [llength [get_cells -hier -filter {REF_NAME =~ RAM*}]]
set n_ff        [llength [get_cells -hier -filter {REF_NAME =~ FD*}]]
set n_dsp       [llength [get_cells -hier -filter {REF_NAME =~ DSP48*}]]
set n_bram      [llength [get_cells -hier -filter {REF_NAME =~ RAMB*}]]

# ---- numbers from report_utilization (Slice LUTs / Slice Registers) ----
set lut_util "-"
set lut_mem  "-"
set ff_util  "-"
if {[file exists $out/winstat_util.rpt]} {
    set fh [open $out/winstat_util.rpt r]
    set txt [read $fh]
    close $fh
    if {[regexp -line {\|\s*Slice LUTs\*?\s*\|\s*(\d+)} $txt -> v]} { set lut_util $v }
    if {[regexp -line {\|\s*LUT as Memory\s*\|\s*(\d+)} $txt -> v]} { set lut_mem $v }
    if {[regexp -line {\|\s*Slice Registers\s*\|\s*(\d+)} $txt -> v]} { set ff_util $v }
    if {[regexp -line {\|\s*Register as Flip Flop\s*\|\s*(\d+)} $txt -> v]} { set ff_util $v }
}

puts "WINSTAT_LUT=$lut_util"
puts "WINSTAT_LUT_MEMORY=$lut_mem"
puts "WINSTAT_FF=$ff_util"
puts "WINSTAT_LUT_CELLS=$n_lut_cells"
puts "WINSTAT_LUTRAM_CELLS=$n_lutram"
puts "WINSTAT_FF_CELLS=$n_ff"
puts "WINSTAT_DSP=$n_dsp"
puts "WINSTAT_BRAM=$n_bram"
puts "WINSTAT_SYNTH_OK=1"
