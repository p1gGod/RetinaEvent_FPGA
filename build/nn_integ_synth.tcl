# =============================================================================
# nn_integ_synth.tcl -- M3c (task-43) 全系统综合资源统计（**只 synth，不 place/route**）
#
# 目的：给出 nn_top/nn_feat/nn_winstat 接入主链后的全系统综合资源，
#       与 act3c 全构建基线（LUT 20,559 / FF 11,850 / Slices 7,327 / BRAM 87 / DSP 7）比对。
#       判据（task-43 f）：Delta LUT <= 1200、Delta DSP <= 1、Delta BRAM <= 2。
#
# 用法（CWD 任意）：
#   pwsh ../temp_test/run_awake_cmd.ps1 vivado.bat -mode batch -source tool/nn_integ_synth.tcl \
#        -log build/integ_synth.log -journal build/integ_synth.jou
#   （环境变量 RETE_GENERICS 可覆盖 generic，默认 "ETH_EN=1" 与 act3c 对齐）
#
# 输出标记（行首锚定）：INTEG_LUT / INTEG_FF / INTEG_SLICES / INTEG_LUTRAM /
#                       INTEG_BRAM / INTEG_DSP / INTEG_SYNTH_OK=1
# 注意：本文件必须无 BOM（本机坑 3）。
# =============================================================================

set root     "E:/workspace/FPGA_Comp/retina_event"
set prj_file "$root/prj/retina_event.xpr"
set part     "xc7a100tfgg484-2"
set top      "top_retina_event"
set outdir   "$root/build/integ_synth"
file mkdir $outdir

set generics "ETH_EN=1"
if {[info exists ::env(RETE_GENERICS)]} { set generics $::env(RETE_GENERICS) }

proc mark {k v} { puts "$k=$v" }

puts "INTEG_ROOT=$root"
puts "INTEG_TOP=$top"
puts "INTEG_PART=$part"
puts "INTEG_GENERICS=$generics"
puts "INTEG_OUTDIR=$outdir"

set __code [catch {

    if {![file exists $prj_file]} { error "project not found: $prj_file" }
    open_project $prj_file
    mark INTEG_STEP open_project

    # ---- 重建源码列表（与 tool/build_inproc.tcl 同一口径：src/hdl 两层 + ref_original 三层）----
    set hdl_files [list]
    foreach f [glob -nocomplain -directory "$root/src/hdl" -types f *.v] { lappend hdl_files $f }
    foreach d [glob -nocomplain -directory "$root/src/hdl" -types d *] {
        foreach f [glob -nocomplain -directory $d -types f *.v] { lappend hdl_files $f }
    }
    set ref_files [list]
    foreach f [glob -nocomplain -directory "$root/ref_original" -types f *.v] { lappend ref_files $f }
    foreach d [glob -nocomplain -directory "$root/ref_original" -types d *] {
        foreach f [glob -nocomplain -directory $d -types f *.v] { lappend ref_files $f }
        foreach e [glob -nocomplain -directory $d -types d *] {
            foreach f [glob -nocomplain -directory $e -types f *.v] { lappend ref_files $f }
        }
    }
    set srcs [concat $hdl_files $ref_files]
    puts "INTEG_NHDL=[llength $hdl_files] INTEG_NREF=[llength $ref_files]"

    set srcset [get_filesets sources_1]
    foreach f [get_files -quiet -of_objects $srcset] {
        if {[string match "*src/hdl/*" $f] || [string match "*ref_original/*" $f]} {
            remove_files -quiet $f
        }
    }
    add_files -norecurse -fileset $srcset $srcs
    set_property top $top $srcset
    set_property top_file "$root/src/hdl/top/top_retina_event.v" $srcset
    update_compile_order -fileset $srcset

    set xdc "$root/src/constraints/retina_event.xdc"
    set conset [get_filesets constrs_1]
    foreach f [get_files -quiet -of_objects $conset] {
        if {[string match "*retina_event.xdc" $f]} { remove_files -quiet $f }
    }
    if {[file exists $xdc]} { add_files -fileset $conset -norecurse $xdc }
    catch { set_property target_constrs_file $xdc $conset }
    catch { set_property generic $generics $srcset }
    puts "INTEG_FILESET_GENERIC=[get_property -quiet generic $srcset]"

    set ips [get_ips -quiet]
    if {[llength $ips] > 0} {
        generate_target all $ips
        mark INTEG_GEN_TARGET_OK 1
    } else {
        mark INTEG_GEN_TARGET_OK 0
    }

    mark INTEG_STEP synth_design
    synth_design -top $top -part $part -flatten_hierarchy rebuilt -directive Default
    mark INTEG_STEP synth_done

    report_utilization -file "$outdir/integ_util_synth.rpt"
    report_timing_summary -no_detailed_paths -file "$outdir/integ_timing_synth.rpt"

    # ---- 从 utilization 报告抓数（行首锚定）----
    set lut 0 ; set ff 0 ; set sl 0 ; set lutram 0 ; set bram 0 ; set dsp 0
    set fh [open "$outdir/integ_util_synth.rpt" r]
    set ut [read $fh] ; close $fh
    if {[regexp {\|\s*Slice LUTs\*?\s*\|\s*([0-9]+)} $ut -> v]} { set lut $v }
    if {[regexp {\|\s*Slice Registers\s*\|\s*([0-9]+)} $ut -> v]} { set ff $v }
    if {[regexp {\|\s*Slice\s*\|\s*([0-9]+)} $ut -> v]} { set sl $v }
    if {[regexp {\|\s*LUT as Memory\s*\|\s*([0-9]+)} $ut -> v]} { set lutram $v }
    if {[regexp {\|\s*Block RAM Tile\s*\|\s*([0-9]+)} $ut -> v]} { set bram $v }
    if {[regexp {\|\s*DSPs\s*\|\s*([0-9]+)} $ut -> v]} { set dsp $v }

    # 注：synth 阶段 report_utilization 无 "Slice"（CLB slices）行，slices 留 0；impl 阶段另报。
    mark INTEG_LUT     $lut
    mark INTEG_FF      $ff
    mark INTEG_SLICES  $sl
    mark INTEG_LUTRAM  $lutram
    mark INTEG_BRAM    $bram
    mark INTEG_DSP     $dsp

    # ---- 接线自证：三种实例都在综合网表里 ----
    mark INTEG_CELL_NNTOP      [llength [get_cells -quiet -hier -filter {NAME =~ *u_nn_top*}]]
    mark INTEG_CELL_WINSTAT    [llength [get_cells -quiet -hier -filter {NAME =~ *u_ws*}]]
    mark INTEG_CELL_ACTCDC     [llength [get_cells -quiet -hier -filter {NAME =~ *u_act_state_cdc*}]]
    mark INTEG_CELL_UDP_MERGE  [llength [get_cells -quiet -hier -filter {NAME =~ *u_udp_merge*}]]

    mark INTEG_SYNTH_OK 1
    close_project
} __err __opts]
if {$__code != 0} {
    puts "INTEG_ERROR=$__err"
    mark INTEG_SYNTH_OK 0
    catch { close_project }
    exit 1
}
puts "INTEG_DONE=1"
exit 0
