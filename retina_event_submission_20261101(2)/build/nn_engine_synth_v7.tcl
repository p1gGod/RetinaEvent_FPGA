# =============================================================================
# nn_engine_synth_v7.tcl -- M3e (task-51) 全系统综合资源统计（**只 synth，不 place/route**）
#
# 目的：给出 v7 融合引擎（nn_engine G1 支路 + fc 256 输入 + nn_winfeat 接入 nn_top）
#       后的全系统综合资源，与 M3d 全系统 synth 基线
#       （LUT 21,913 / FF 12,444 / LUTRAM 5,922 / BRAM 87 / DSP 7）比对。
#       判据（task-51）：Delta LUT <= 900、Delta DSP <= 2、Delta BRAM <= 2。
#
# 用法（CWD 任意）：
#   pwsh ../temp_test/run_awake_cmd.ps1 vivado.bat -mode batch -source tool/nn_engine_synth_v7.tcl \
#        -log build/integ_synth_v7.log -journal build/integ_synth_v7.jou
#   （环境变量 RETE_GENERICS 可覆盖 generic，默认 "ETH_EN=1" 与 act3c 对齐）
#
# 输出标记（行首锚定）：ACT_V7_LUT / ACT_V7_FF / ACT_V7_SLICES / ACT_V7_LUTRAM /
#                       ACT_V7_BRAM / ACT_V7_DSP / ENGINE_SYNTH_OK=1
# 注意：本文件必须无 BOM（本机坑 3）。
# =============================================================================

set root     "E:/workspace/FPGA_Comp/retina_event"
set prj_file "$root/prj/retina_event.xpr"
set part     "xc7a100tfgg484-2"
set top      "top_retina_event"
set outdir   "$root/build/integ_synth_v7"
file mkdir $outdir

set generics "ETH_EN=1"
if {[info exists ::env(RETE_GENERICS)]} { set generics $::env(RETE_GENERICS) }

proc mark {k v} { puts "$k=$v" }

puts "ACT_V7_ROOT=$root"
puts "ACT_V7_TOP=$top"
puts "ACT_V7_PART=$part"
puts "ACT_V7_GENERICS=$generics"
puts "ACT_V7_OUTDIR=$outdir"

set __code [catch {

    if {![file exists $prj_file]} { error "project not found: $prj_file" }
    open_project $prj_file
    mark ACT_V7_STEP open_project

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
    puts "ACT_V7_NHDL=[llength $hdl_files] ACT_V7_NREF=[llength $ref_files]"

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
    puts "ACT_V7_FILESET_GENERIC=[get_property -quiet generic $srcset]"

    set ips [get_ips -quiet]
    if {[llength $ips] > 0} {
        generate_target all $ips
        mark ACT_V7_GEN_TARGET_OK 1
    } else {
        mark ACT_V7_GEN_TARGET_OK 0
    }

    mark ACT_V7_STEP synth_design
    synth_design -top $top -part $part -flatten_hierarchy rebuilt -directive Default
    mark ACT_V7_STEP synth_done

    report_utilization -file "$outdir/act_v7_util_synth.rpt"
    report_timing_summary -no_detailed_paths -file "$outdir/act_v7_timing_synth.rpt"

    # ---- 从 utilization 报告抓数（行首锚定）----
    set lut 0 ; set ff 0 ; set sl 0 ; set lutram 0 ; set bram 0 ; set dsp 0
    set fh [open "$outdir/act_v7_util_synth.rpt" r]
    set ut [read $fh] ; close $fh
    if {[regexp {\|\s*Slice LUTs\*?\s*\|\s*([0-9]+)} $ut -> v]} { set lut $v }
    if {[regexp {\|\s*Slice Registers\s*\|\s*([0-9]+)} $ut -> v]} { set ff $v }
    if {[regexp {\|\s*Slice\s*\|\s*([0-9]+)} $ut -> v]} { set sl $v }
    if {[regexp {\|\s*LUT as Memory\s*\|\s*([0-9]+)} $ut -> v]} { set lutram $v }
    if {[regexp {\|\s*Block RAM Tile\s*\|\s*([0-9]+)} $ut -> v]} { set bram $v }
    if {[regexp {\|\s*DSPs\s*\|\s*([0-9]+)} $ut -> v]} { set dsp $v }

    # 注：synth 阶段 report_utilization 无 "Slice"（CLB slices）行，slices 留 0；impl 阶段另报。
    mark ACT_V7_LUT     $lut
    mark ACT_V7_FF      $ff
    mark ACT_V7_SLICES  $sl
    mark ACT_V7_LUTRAM  $lutram
    mark ACT_V7_BRAM    $bram
    mark ACT_V7_DSP     $dsp

    # ---- 接线自证：三种实例都在综合网表里 ----
    mark ACT_V7_CELL_NNTOP      [llength [get_cells -quiet -hier -filter {NAME =~ *u_nn_top*}]]
    mark ACT_V7_CELL_WINSTAT    [llength [get_cells -quiet -hier -filter {NAME =~ *u_ws*}]]
    mark ACT_V7_CELL_ACTCDC     [llength [get_cells -quiet -hier -filter {NAME =~ *u_act_state_cdc*}]]
    mark ACT_V7_CELL_UDP_MERGE  [llength [get_cells -quiet -hier -filter {NAME =~ *u_udp_merge*}]]
    mark ACT_V7_CELL_WINFEAT    [llength [get_cells -quiet -hier -filter {NAME =~ *u_winfeat*}]]
    mark ACT_V7_CELL_ENGINE     [llength [get_cells -quiet -hier -filter {NAME =~ *u_eng*}]]
    mark ACT_V7_CELL_FEAT       [llength [get_cells -quiet -hier -filter {NAME =~ *u_feat*}]]

    mark ENGINE_SYNTH_OK 1
    close_project
} __err __opts]
if {$__code != 0} {
    puts "ACT_V7_ERROR=$__err"
    mark ENGINE_SYNTH_OK 0
    catch { close_project }
    exit 1
}
puts "ACT_V7_DONE=1"
puts "ENGINE_SYNTH_OK=[expr {$__code == 0 ? 1 : 0}]"
exit 0
