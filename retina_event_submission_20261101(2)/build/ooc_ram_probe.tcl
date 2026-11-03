# ooc_ram_probe.tcl -- synthesize ONE module out-of-context and report whether its
# arrays became block RAM or got "dissolved into registers".
#
# WHY: the full-design build reports
#        RAM "raw_ram_reg" / "ev_ram_reg" / "pkt_ram_reg" dissolved into registers
#      even with (* ram_style = "block" *) present. This probe isolates the module
#      from the project / clock context to tell "code pattern is wrong" apart from
#      "context (clock/flatten) breaks inference".
#
# KEEP THIS FILE WITHOUT A BOM.
#
# Usage (CWD anywhere):
#   vivado.bat -mode batch -nolog -nojournal -source tool\ooc_ram_probe.tcl ^
#       -log tool\ooc_probe.log -tclargs <top_module> <file1> [file2 ...]

set top  [lindex $argv 0]
set files [lrange $argv 1 end]
set part "xc7a100tfgg484-2"

puts "OOC_TOP=$top"
puts "OOC_NFILES=[llength $files]"
puts "OOC_PART=$part"

if {$top eq "" || [llength $files] == 0} {
    puts "OOC_RESULT=BAD_ARGS"
    exit 1
}

if {[catch {
    read_verilog $files
    synth_design -top $top -part $part -flatten_hierarchy none -directive Default
    report_utilization -file "E:/workspace/FPGA_Comp/build/ooc_${top}_util.rpt"
    # RAM inference outcome
    set br [llength [get_cells -quiet -hier -filter {PRIMITIVE_TYPE =~ BMEM.*}]]
    puts "OOC_RAMB_CELLS=$br"
    puts "OOC_RESULT=OK"
} err]} {
    puts "OOC_ERROR=$err"
    puts "OOC_RESULT=FAILED"
    exit 1
}
exit 0
