#==============================================================================
# nn_winfeat / nn_winstat synth-only check (M3d task-48 criterion c)
#   - synth_design + opt_design ONLY (no place/route, no bitstream)
#   - module name passed as last argv entry (after -tclargs), e.g.
#       vivado -mode batch -source tool/nn_winfeat_synth.tcl -tclargs nn_winfeat
#   - prints <MOD>_LUT / <MOD>_FF / <MOD>_DSP / <MOD>_BRAM and <MOD>_SYNTH_OK=1
# NOTE: ASCII only, no BOM (Vivado Tcl does not skip BOM).
# Run from retina_event/ :
#   vivado -mode batch -source tool/nn_winfeat_synth.tcl -tclargs nn_winfeat
#   vivado -mode batch -source tool/nn_winfeat_synth.tcl -tclargs nn_winstat
#==============================================================================
set part xc7a100tfgg484-2
set top  [lindex $argv 0]
if {$top eq ""} { set top nn_winfeat }
set out  build
file mkdir $out
set tag $top
set TAG [string toupper $tag]

read_verilog src/hdl/nn/$tag.v
synth_design -top $tag -part $part -mode out_of_context -include_dirs src/hdl/nn
opt_design

report_utilization -file $out/${tag}_util.rpt
report_timing_summary -no_header -no_detailed_paths -file $out/${tag}_timing.rpt -warn_on_violation

# ---- primitive counts (post-synth, out-of-context) ----
set n_lut_cells [llength [get_cells -hier -filter {REF_NAME =~ LUT*}]]
set n_lutram    [llength [get_cells -hier -filter {REF_NAME =~ RAM*}]]
set n_ff        [llength [get_cells -hier -filter {REF_NAME =~ FD*}]]
set n_dsp       [llength [get_cells -hier -filter {REF_NAME =~ DSP48*}]]
set n_bram      [llength [get_cells -hier -filter {REF_NAME =~ RAMB*}]]

set lut_util "-"
set lut_mem  "-"
set ff_util  "-"
if {[file exists $out/${tag}_util.rpt]} {
    set fh [open $out/${tag}_util.rpt r]
    set txt [read $fh]
    close $fh
    if {[regexp -line {\|\s*Slice LUTs\*?\s*\|\s*(\d+)} $txt -> v]} { set lut_util $v }
    if {[regexp -line {\|\s*LUT as Memory\s*\|\s*(\d+)} $txt -> v]} { set lut_mem $v }
    if {[regexp -line {\|\s*Slice Registers\s*\|\s*(\d+)} $txt -> v]} { set ff_util $v }
    if {[regexp -line {\|\s*Register as Flip Flop\s*\|\s*(\d+)} $txt -> v]} { set ff_util $v }
}

puts "${TAG}_LUT=$lut_util"
puts "${TAG}_LUT_MEMORY=$lut_mem"
puts "${TAG}_FF=$ff_util"
puts "${TAG}_LUT_CELLS=$n_lut_cells"
puts "${TAG}_LUTRAM_CELLS=$n_lutram"
puts "${TAG}_FF_CELLS=$n_ff"
puts "${TAG}_DSP=$n_dsp"
puts "${TAG}_BRAM=$n_bram"
puts "${TAG}_SYNTH_OK=1"
