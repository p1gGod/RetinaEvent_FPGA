# hier_util.tcl -- report per-hierarchy utilization from a synthesized checkpoint.
# Read-only diagnosis; no project is opened, no constraints are touched.
# KEEP THIS FILE WITHOUT A BOM (Vivado's Tcl does not skip one).
#
# Usage (CWD anywhere):
#   vivado.bat -mode batch -nolog -nojournal -source tool\hier_util.tcl ^
#       -log tool\hier_util.log -tclargs <dcp> <rpt>

# 缺省路径由脚本位置推导（tool/ 的上一级 = retina_event），不硬编码绝对路径。
set root [file normalize [file join [file dirname [info script]] ..]]
set dcp [file join $root build variant_eth post_synth.dcp]
set rpt [file join $root build variant_eth util_hier.rpt]
if {[llength $argv] >= 1} { set dcp [lindex $argv 0] }
if {[llength $argv] >= 2} { set rpt [lindex $argv 1] }

puts "HIER_DCP=$dcp"
puts "HIER_RPT=$rpt"

if {[catch {
    open_checkpoint $dcp
    report_utilization -hierarchical -hierarchical_depth 4 -file $rpt
    puts "HIER_RESULT=OK"
} err]} {
    puts "HIER_ERROR=$err"
    puts "HIER_RESULT=FAILED"
    exit 1
}
exit 0
