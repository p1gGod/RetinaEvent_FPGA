#==============================================================================
# nn_synth_check.tcl -- standalone (non-project) synth -> opt -> place -> route
#                       check for nn_top (M3-fix v2, single-clock serial MAC)
#
# WHAT IT PROVES (task-21 criterion SYNTH_ACTION_OK):
#   1. nn_top + 5 submodules elaborate and synthesise on xc7a100tfgg484-2
#      without touching prj/retina_event.xpr (fully non-project flow);
#   2. the flow synth_design -> opt_design -> place_design -> route_design
#      runs to completion;
#   3. the 5718-word weight ROM is inferred as block RAM (ACT3_ROM_BRAM >= 1);
#   4. v2 acceptance envelope (single clock clk_cam 50 MHz):
#        WNS >= 0 @ 20 ns, LUT <= 12000, FF <= 12000, Slices <= 5000,
#        BRAM <= 20 tiles, 1 <= DSP <= 8, no fatal DRC,
#        and no REQP-1839/1840 (RAMB async control check) violations.
#
# RUN (from project root; system sleep blocked -- long Vivado runs must not be
#   frozen by the 30 min AC standby timeout):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tool\run_awake_cmd.ps1
#       -CommandLine '"E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat" -mode batch -nolog -nojournal -source tool/nn_synth_check.tcl'
#   (tool\run_awake_cmd.ps1 wraps ANY command line with SetThreadExecutionState;
#    E:\Tools\FPGABuilder_AMD\scripts\run_awake.ps1 can only wrap fpgab.bat.)
#
# OUTPUT MARKERS -- Vivado echoes executed Tcl source, so grep line-start:
#   (?m)^ACT3_LUT=  ^ACT3_FF=  ^ACT3_SLICES=  ^ACT3_BRAM=  ^ACT3_DSP=
#   ^ACT3_WNS=  ^ACT3_ROM_BRAM=  ^ACT3_DRC_*=  ^ACT3_SYNTH_OK=1
#
# NOTE: this file is pure ASCII on purpose. Tcl must be UTF-8 WITHOUT BOM
#   (Vivado Tcl does not skip a BOM: invalid command name "<BOM>...").
#
# V2 ARCHITECTURE NOTE: nn_top is now a SINGLE-CLOCK design (clk_cam, 50 MHz).
#   The engine runs a serial MAC (1 feature byte + 1 weight word per cycle),
#   feature buffers and the weight ROM are all block RAM, and every register
#   that drives a RAMB address/data/enable pin uses a SYNCHRONOUS reset
#   (that removes the DRC REQP-1839/1840 async-control warnings seen in v1).
#   The clk_200m / rst_n_200m ports are kept for pin-out compatibility but are
#   deprecated and drive nothing, so only clk_cam gets a real clock constraint.
#==============================================================================

# Synthesis runs single-threaded ON PURPOSE.  With the default 2-process
# multithreading Vivado 2020.2 spawns a helper process ("[Synth 8-7075] Helper
# process launched with PID ...") that on this host intermittently fails to read
# its own run/script files, aborting synth_design with messages such as
#   couldn't read file ".../scripts/rt/data/lib_core.tcl": no such file or directory
#   invalid command name "rt-undefined"   (in $rt::db resetHdlParse)
# The design is tiny, so 1 thread costs little and makes the run repeatable.
set_param general.maxThreads 1

set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
set rtl_dir    [file join $root src hdl nn]
set out_dir    [file join $root sim nn]
file mkdir $out_dir

set part_xc7a100t xc7a100tfgg484-2
puts "ACT3_ROOT=$root"
puts "ACT3_PART=$part_xc7a100t"

#------------------------------------------------------------------------------
# 1. read sources (include "nn_cfg.vh" resolves against each source file's own
#    directory, so no cd into src/hdl/nn is needed)
#------------------------------------------------------------------------------
# 不切进源码目录：synth_design 会在 CWD 下建 .Xil/ 运行目录（此前切进 src/hdl/nn
# 时子进程读 realtime/<top>.tcl 失败）。回退到工程根目录保持 .Xil 落在可写的构建区。
# v2 单时钟重构后 nn_top 不再例化 primitives/cdc_tog_word.v。
cd $root
set srcs [list \
    [file join $rtl_dir  nn_feat.v]     \
    [file join $rtl_dir  nn_engine.v]   \
    [file join $rtl_dir  nn_decide.v]   \
    [file join $rtl_dir  nn_rom.v]      \
    [file join $rtl_dir  nn_rom_data.v] \
    [file join $rtl_dir  nn_top.v] ]
foreach f $srcs {
    if {![file exists $f]} { error "ACT3_MISSING_SRC=$f" }
}
puts "ACT3_SRC_COUNT=[llength $srcs]"
read_verilog -verbose $srcs

#------------------------------------------------------------------------------
# 2. constraints: single 50 MHz camera clock (v2).  clk_200m is a deprecated
#    unloaded port, so it is deliberately left without a clock definition and
#    excluded from the input-delay list.
#------------------------------------------------------------------------------
synth_design -top nn_top -part $part_xc7a100t
puts "ACT3_STEP=synth_done"

create_clock -period 20.000 -name clk_cam [get_ports clk_cam]

# I/O timing: every real input/output is in the clk_cam domain (2 ns in/out delay)
# (build the input list by hand: remove_from_collection was not available in
#  this batch session -- "invalid command name" -- and a plain loop is portable)
set in_ports {}
foreach p [all_inputs] {
    set nm [get_property NAME $p]
    if {$nm ne "clk_cam" && $nm ne "clk_200m"} { lappend in_ports $p }
}
if {[llength $in_ports] > 0} { set_input_delay  -clock clk_cam 2.000 $in_ports }
if {[llength [all_outputs]] > 0} { set_output_delay -clock clk_cam 2.000 [all_outputs] }

#------------------------------------------------------------------------------
# 2b. out-of-context DRC scope.  This standalone run has NO pin-location and
#     NO IOSTANDARD constraints by construction (they live in pin.xdc and are
#     applied only in the integrated top, task-20), so NSTD-1/UCIO-1 would
#     always fire here.  Downgrade exactly those two to Warning so that
#     ACT3_DRC_FATAL counts only real design-rule errors.
#------------------------------------------------------------------------------
foreach chk {NSTD-1 UCIO-1} {
    if {[llength [get_drc_checks -quiet $chk]] > 0} {
        set_property SEVERITY {Warning} [get_drc_checks $chk]
    }
}

#------------------------------------------------------------------------------
# 3. implementation flow (no bitstream -- SYNTH_ACTION_OK is a flow/timing gate)
#------------------------------------------------------------------------------
opt_design
puts "ACT3_STEP=opt_done"
place_design
puts "ACT3_STEP=place_done"
route_design
puts "ACT3_STEP=route_done"

#------------------------------------------------------------------------------
# 4. reports on disk
#------------------------------------------------------------------------------
report_utilization -file [file join $out_dir nn_util.rpt]
report_utilization -hierarchical -file [file join $out_dir nn_util_hier.rpt]
report_timing_summary -delay_type max -max_paths 10 -file [file join $out_dir nn_timing.rpt]
set drc_file [file join $out_dir nn_drc.rpt]
if {[catch {report_drc -file $drc_file} drc_cmd_msg]} {
    puts "ACT3_DRC_CMD_WARN=$drc_cmd_msg"
}
puts "ACT3_REPORTS=[file join $out_dir nn_util.rpt]"

#------------------------------------------------------------------------------
# 5. metric extraction (post-route physical netlist)
#------------------------------------------------------------------------------
set lut_cells   [get_cells -hier -filter {REF_NAME =~ LUT*}]
set ff_cells    [get_cells -hier -filter {REF_NAME =~ FD*}]
set dsp_cells   [get_cells -hier -filter {REF_NAME =~ DSP48*}]
set remb36      [llength [get_cells -hier -filter {REF_NAME == RAMB36E1}]]
set remb18      [llength [get_cells -hier -filter {REF_NAME == RAMB18E1}]]
set luts        [llength $lut_cells]
set ffs         [llength $ff_cells]
set dsps        [llength $dsp_cells]
set bram_tiles  [expr {1.0 * $remb36 + 0.5 * $remb18}]

# occupied slice count: parse the "Slice" row out of the utilization report
set util_txt [report_utilization -return_string]
set slices "NA"
foreach line [split $util_txt "\n"] {
    if {[regexp {^\|\s+Slice\s+\|\s+([0-9]+)} $line -> sl]} { set slices $sl ; break }
}

# ROM -> BRAM inference proof: count RAMB cells whose instance path mentions rom
set rom_brams 0
foreach c [get_cells -hier -filter {REF_NAME =~ RAMB*}] {
    if {[string match "*rom*" $c]} { incr rom_brams }
}

# WNS: parse the timing summary table, fall back to the worst setup path slack
set wns "NA"
set tim_txt [report_timing_summary -delay_type max -return_string]
if {[regexp {WNS\(ns\)[^\n]*\n\s*-+[^\n]*\n\s+(-?[0-9]+\.[0-9]+)} $tim_txt -> w] } {
    set wns $w
} else {
    set worst_paths [get_timing_paths -delay_type max -max_paths 1 -nworst 1]
    if {[llength $worst_paths] > 0} { set wns [get_property SLACK $worst_paths] }
}

# DRC: count async-control warnings (REQP-1839 RAMB36 / REQP-1840 RAMB18) and
# fatal severities out of the report written by report_drc.
set drc_txt ""
if {[file exists $drc_file]} {
    set dfh [open $drc_file r]
    set drc_txt [read $dfh]
    close $dfh
}
if {[string length $drc_txt] == 0} { set drc_txt "na_empty_report" }
set drc_reqp_async [regexp -all {REQP-18(39|40)} $drc_txt]
set drc_fatal      [expr {[regexp -all -line {\|\s*Error\s*\|} $drc_txt] + [regexp -all -line {\|\s*Critical Warning\s*\|} $drc_txt]}]
set drc_viol "NA"
if {[regexp {Violations found:\s+([0-9]+)} $drc_txt -> dv]} { set drc_viol $dv }

set summary_fh [open [file join $out_dir nn_act3_summary.txt] w]
puts $summary_fh "ACT3_LUT=$luts"
puts $summary_fh "ACT3_FF=$ffs"
puts $summary_fh "ACT3_SLICES=$slices"
puts $summary_fh "ACT3_BRAM=[format %.1f $bram_tiles]"
puts $summary_fh "ACT3_DSP=$dsps"
puts $summary_fh "ACT3_WNS=$wns"
puts $summary_fh "ACT3_ROM_BRAM=$rom_brams"
puts $summary_fh "ACT3_RAMB36=$remb36"
puts $summary_fh "ACT3_RAMB18=$remb18"
puts $summary_fh "ACT3_DRC_FATAL=$drc_fatal"
puts $summary_fh "ACT3_DRC_VIOL=$drc_viol"
puts $summary_fh "ACT3_DRC_REQP_ASYNC=$drc_reqp_async"
puts $summary_fh "ACT3_PART=$part_xc7a100t"
close $summary_fh

puts "ACT3_LUT=$luts"
puts "ACT3_FF=$ffs"
puts "ACT3_SLICES=$slices"
puts "ACT3_BRAM=[format %.1f $bram_tiles]"
puts "ACT3_DSP=$dsps"
puts "ACT3_WNS=$wns"
puts "ACT3_ROM_BRAM=$rom_brams"
puts "ACT3_RAMB36=$remb36"
puts "ACT3_RAMB18=$remb18"
puts "ACT3_DRC_FATAL=$drc_fatal"
puts "ACT3_DRC_VIOL=$drc_viol"
puts "ACT3_DRC_REQP_ASYNC=$drc_reqp_async"

#------------------------------------------------------------------------------
# 6. acceptance gate for SYNTH_ACTION_OK (task-21 v2 envelope)
#    flow completes AND timing met (WNS >= 0 @ 20 ns) AND ROM mapped to BRAM
#    AND resources inside budget AND no fatal / async-control DRC.
#------------------------------------------------------------------------------
set fail_reasons {}
if {$wns eq "NA"} {
    lappend fail_reasons "WNS_NOT_FOUND"
} elseif {[expr {$wns < 0}]} {
    lappend fail_reasons "WNS_NEGATIVE"
}
if {$slices eq "NA"} {
    lappend fail_reasons "SLICES_NOT_FOUND"
} elseif {[expr {$slices > 5000}]} {
    lappend fail_reasons "SLICES_OVER_BUDGET"
}
if {$rom_brams < 1}          { lappend fail_reasons "ROM_NOT_IN_BRAM" }
if {$bram_tiles > 20}        { lappend fail_reasons "BRAM_OVER_BUDGET" }
if {$luts > 12000}           { lappend fail_reasons "LUT_OVER_BUDGET" }
if {$ffs > 12000}            { lappend fail_reasons "FF_OVER_BUDGET" }
if {$dsps < 1}               { lappend fail_reasons "DSP_NOT_INFERRED" }
if {$dsps > 8}               { lappend fail_reasons "DSP_OVER_BUDGET" }
if {$drc_fatal > 0}          { lappend fail_reasons "DRC_FATAL" }
if {$drc_reqp_async > 0}     { lappend fail_reasons "DRC_RAMB_ASYNC_CONTROL" }

if {[llength $fail_reasons] == 0} {
    puts "ACT3_SYNTH_OK=1"
} else {
    puts "ACT3_FAIL_REASON=[join $fail_reasons ,]"
    puts "ACT3_SYNTH_OK=0"
    error "ACT3_SYNTH_OK=0 ([join $fail_reasons ,])"
}