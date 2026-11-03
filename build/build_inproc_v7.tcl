# =============================================================================
# build_inproc.tcl -- 进程内一对一构建（**不使用 launch_runs / run server**）
#
# 为什么需要它（本机实测，2026-10-03）：
#   `launch_runs synth_1` 在本机当前会话里会**挂死**：
#     · `prj/retina_event.runs/synth_1/runme.log` 只写了 "*** Running vivado ... clk_wiz_0.tcl"
#     · 出现 `vrs`（Vivado Run Server）进程，但它与父 vivado 都**几乎不耗 CPU**
#       （实测 20 s 内父进程 CPU 只涨 0.05 s）⇒ 是**子进程/命名管道 IPC 被拦**，
#       不是设计问题、不是 IP 问题（fpga-builder-amd skill §4 坑 1 的同类现象）。
#   ⇒ 改用**一次性进程内**流程：synth_design → opt_design → place_design → route_design
#      → write_bitstream。**同一份工程、同一套约束、同一个 part**，只是不再走 run server。
#   实测：同样环境下 `vivado -mode batch -source` 直接跑 `synth_design` **正常完成**。
#
# 用法（CWD 任意）：
#   vivado.bat -mode batch -source tool\build_inproc.tcl -log ... -journal ... -tclargs <mode>
#   mode = --full（默认）| --synthonly | --resume
#
# ⚠️ -tclargs 必须是整条命令行的**最后一个参数**（本机实测坑 11）。
# ⚠️ 本文件必须**无 BOM** 保存（本机实测坑 3）。
# =============================================================================

# root: RETE_ROOT 可覆盖；缺省由脚本位置推导（tool/ 的上一级），不硬编码绝对路径。
if {[info exists env(RETE_ROOT)] && $env(RETE_ROOT) ne ""} {
    set root $env(RETE_ROOT)
} else {
    set root [file normalize [file join [file dirname [info script]] ..]]
}
set prj_file  "$root/prj/retina_event.xpr"
set part      "xc7a100tfgg484-2"
set top       "top_retina_event"

# ---- 参数 ----------------------------------------------------------------
#   argv[0] = mode（--full | --synthonly | --resume）
#
#   generics / tag **走环境变量**，不走 argv：
#     RETE_GENERICS = 如 "ETH_EN=1"（原样透传 synth_design -generic）
#     RETE_TAG      = 非空时全部产物写到 build/variant_<tag>/，不覆盖交付产物
#
#   ⚠️ 实测坑（2026-10-06）：`-tclargs --full ETH_EN=1 eth` 里的 `=` 会被 Vivado
#      吞掉，脚本收到的是 argv = {--full ETH_EN 1 eth} ⇒ generics="ETH_EN"、
#      tag="1"，并生成一条**无值**的 `-generic ETH_EN`。所以 name=value 一律
#      用环境变量传，argv 只留给没有 `=` 的 mode。
set mode "--full"
if {[llength $argv] >= 1} { set mode [lindex $argv 0] }

set generics ""
if {[info exists ::env(RETE_GENERICS)]} { set generics $::env(RETE_GENERICS) }
set tag ""
if {[info exists ::env(RETE_TAG)]} { set tag $::env(RETE_TAG) }

set outdir "$root/build"
if {$tag ne ""} {
    set outdir [file join $root build "variant_$tag"]
    file mkdir $outdir
}
set bitfile "$outdir/retina_event.bit"

puts "INPROC_ROOT=$root"
puts "INPROC_PRJ=$prj_file"
puts "INPROC_TOP=$top"
puts "INPROC_PART=$part"
puts "INPROC_MODE=$mode"
puts "INPROC_GENERICS=$generics"
puts "INPROC_TAG=$tag"
puts "INPROC_OUTDIR=$outdir"
puts "INPROC_BITFILE=$bitfile"

# ---- 用行首锚定的标记，便于外部判定（坑 13）--------------------------------
proc mark {k v} { puts "$k=$v" }

# ⚠️ 三参 catch：只写 `catch {...} err` 会把 --synthonly 的提前 `return`
#    （Tcl 返回码 TCL_RETURN = 2）当成失败 ⇒ 明明综合成功却报 INPROC_RESULT=FAILED
#    （实测 2026-10-06：同一次运行里先打印 SYNTH_OK、紧接着又打印 FAILED）。
set __code [catch {

    if {![file exists $prj_file]} {
        mark INPROC_RESULT PRJ_MISSING
        error "project not found: $prj_file"
    }

    open_project $prj_file
    mark INPROC_STEP open_project

    # ---- 显式把源码/约束加进工程（不依赖之前 run 的副作用）------------------
    #      只加 src/hdl + ref_original；**绝不加 sim/**（那里有 clk_wiz_0/BUFG 仿真桩，
    #      会与真 IP 重名冲突）。
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
    puts "INPROC_NHDL=[llength $hdl_files]"
    puts "INPROC_NREF=[llength $ref_files]"

    set srcset [get_filesets sources_1]
    # 先移除旧的（避免重复添加报错），再加
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
    puts "INPROC_XDC=$xdc"

    # ---- 保护 .xpr：本脚本用 remove_files/add_files 重建文件列表，会**顺手改坏**工程设置。
    #   实测两处副作用（2026-10-06，看 `git diff prj/retina_event.xpr`）：
    #     ① remove_files/add_files XDC 会把 `TargetConstrsFile` 掉掉 ⇒ 工程流可能拿不到目标约束
    #     ② `synth_design -generic X=1` 会把 X **写进 .xpr** ⇒ 下一次构建被上一次的参数污染
    #   两处都在这里显式还原/覆盖，保证"工程状态只由本次请求决定"。
    if {[catch { set_property target_constrs_file $xdc $conset } err]} {
        puts "INPROC_TARGET_CONSTRS_WARN=$err"
    }
    puts "INPROC_TARGET_CONSTRS=[get_property -quiet target_constrs_file $conset]"

    # 参数覆盖的**单一来源**：fileset 的 generic 属性（工程流 launch_runs 读的也是它）。
    # 空串 = 显式清空，避免上一次变体构建留下的 generic 继续生效。
    if {[catch { set_property generic $generics $srcset } err]} {
        puts "INPROC_GENERIC_SET_WARN=$err"
    }
    puts "INPROC_FILESET_GENERIC=[get_property -quiet generic $srcset]"

    # ---- 顶层再确认一次（part 不在 fileset 上设，2020.2 无该 property；
    #      实际 part 由工程本身 + synth_design -part 双重指定）----
    set_property top $top [current_fileset]
    puts "INPROC_ACTUAL_TOP=[get_property top [current_fileset]]"
    puts "INPROC_ACTUAL_PART=[get_property part [current_project]]"

    # ---- 确保 IP 产物存在（新路径拷贝后必须重新生成，否则 [Synth 8-439]）----
    set ips [get_ips -quiet]
    if {[llength $ips] > 0} {
        puts "INPROC_STEP generate_target all"
        generate_target all $ips
        mark INPROC_GEN_TARGET_OK 1
    } else {
        mark INPROC_GEN_TARGET_OK 0
    }

    # =====================================================================
    # 1. 综合（进程内，不用 run server）
    # =====================================================================
    if {$mode ne "--resume"} {
        puts "INPROC_STEP synth_design"
        # 注意：**不再用** `-generic`。参数覆盖统一走上面的 fileset 属性，
        # 否则命令行的 generic 会被写回 .xpr、污染下一次构建。
        set synth_args [list -top $top -part $part -flatten_hierarchy rebuilt -directive Default]
        puts "INPROC_SYNTH_ARGS=$synth_args"
        synth_design {*}$synth_args
        mark INPROC_STEP synth_done
        # ---- 参数覆盖生效性自证：ETH_EN/UART_EN=1 时 generate 分支必须真例化出单元 ----
        if {$generics ne ""} {
            mark INPROC_CELL_ETH_UDP  [llength [get_cells -quiet -hier -filter {NAME =~ *u_eth_udp*}]]
            mark INPROC_CELL_UART_TLM [llength [get_cells -quiet -hier -filter {NAME =~ *u_uart_telemetry*}]]
        }
        write_checkpoint -force $outdir/post_synth.dcp
    } else {
        if {[file exists $outdir/post_synth.dcp]} {
            puts "INPROC_STEP open_checkpoint post_synth"
            open_checkpoint $outdir/post_synth.dcp
        } else {
            error "resume requested but $outdir/post_synth.dcp missing"
        }
    }

    # 综合报告
    set lut  [llength [get_cells -hier -filter {PRIMITIVE_TYPE =~ CLB.LUT.* && NAME =~ *LUT*}]]
    report_utilization -file $outdir/inproc_util.rpt
    report_timing_summary -no_detailed_paths -file $outdir/inproc_timing_synth.rpt
    puts "INPROC_SYNTH_LUT_PLACEHOLDER=$lut"

    if {$mode eq "--synthonly"} {
        mark INPROC_RESULT SYNTH_OK
        close_project
        return
    }

    # =====================================================================
    # 2. 实现（进程内）
    # =====================================================================
    puts "INPROC_STEP opt_design"
    opt_design -directive Explore
    puts "INPROC_STEP place_design"
    place_design -directive Explore
    puts "INPROC_STEP route_design"
    route_design -directive Explore
    phys_opt_design
    mark INPROC_STEP impl_done

    # =====================================================================
    # 3. 报告 + 时序
    # =====================================================================
    report_timing_summary -file $outdir/inproc_timing.rpt
    report_utilization    -file $outdir/inproc_util_impl.rpt
    report_drc            -file $outdir/inproc_drc.rpt

    set wns 0.0 ; set whs 0.0 ; set tns 0.0 ; set ths 0.0
    set fh [open "$outdir/inproc_timing.rpt" r]
    set txt [read $fh] ; close $fh
    # 从 "Design Timing Summary" 表格里抠数字（行首锚定）
    if {[regexp -line {^\s*(-?[0-9]+\.[0-9]+)\s+(-?[0-9]+\.[0-9]+)\s+[0-9]+\s+[0-9]+\s+(-?[0-9]+\.[0-9]+)\s+(-?[0-9]+\.[0-9]+)} $txt -> wns tns whs ths]} {
        # 命中的是 "WNS(ns) TNS(ns) TNS Failing TNS Total WHS(ns) THS(ns) ..." 那一行
    }
    mark INPROC_WNS $wns
    mark INPROC_TNS $tns
    mark INPROC_WHS $whs
    mark INPROC_THS $ths

    # 更稳的做法：直接问 property
    catch {
        mark INPROC_WNS [get_property STATS.WNS [get_runs -quiet]]
    }

    # =====================================================================
    # 4. 比特流
    # =====================================================================
    puts "INPROC_STEP write_bitstream"
    write_bitstream -force $bitfile
    if {[file exists $bitfile]} {
        mark INPROC_BIT_BYTES [file size $bitfile]
        mark INPROC_BIT $bitfile
    } else {
        mark INPROC_BIT_BYTES 0
    }

    # ---- 调试探针文件 .ltx（ILA 抓波形**必需**）----------------------------
    #   ⚠️ 实测 2026-10-06：本进程内流程里 `write_bitstream` **不会**顺手写出 .ltx
    #      （设计里确实有 dbg_hub + 2 个 ILA），而硬件管理器缺了它就报
    #        [Labtools 27-188] Use refresh_hw_device command, with a valid
    #                           [debug_nets.ltx] file before running this command.
    #      且没有 .ltx 时 `get_hw_probes` 一个都取不到（[Labtoolstcl 44-131]），
    #      连"靠自动探测抓波形"这条退路也走不通。
    #   ⇒ 显式调用 write_debug_probes。无调试核的构建会失败，故包 catch 不当错误。
    if {[catch { write_debug_probes -force "$outdir/retina_event.ltx" } err]} {
        puts "INPROC_LTX_WARN=$err"
    } else {
        mark INPROC_LTX "$outdir/retina_event.ltx"
        if {[file exists "$outdir/retina_event.ltx"]} {
            mark INPROC_LTX_BYTES [file size "$outdir/retina_event.ltx"]
        }
    }

    # ---- 资源与时钟 ----
    catch {
        set util_txt [read [open "$outdir/inproc_util_impl.rpt" r]]
        if {[regexp {\|\s*Slice LUTs\s*\|\s*([0-9]+)} $util_txt -> v]} { mark INPROC_LUT $v }
        if {[regexp {\|\s*Slice Registers\s*\|\s*([0-9]+)} $util_txt -> v]} { mark INPROC_FF $v }
        if {[regexp {\|\s*Block RAM Tile\s*\|\s*([0-9]+)} $util_txt -> v]} { mark INPROC_BRAM $v }
        if {[regexp {\|\s*DSPs\s*\|\s*([0-9]+)} $util_txt -> v]} { mark INPROC_DSP $v }
    }
    catch {
        set tc [get_clocks]
        foreach c $tc {
            puts "INPROC_CLOCK=[get_property NAME $c] period=[get_property PERIOD $c]"
        }
    }
    catch {
        set drc [read [open "$outdir/inproc_drc.rpt" r]]
        if {[regexp {(\d+) Infos, (\d+) Warnings, (\d+) Critical Warnings and (\d+) Errors} $drc -> i w cw e]} {
            mark INPROC_DRC_ERRORS $e
            mark INPROC_DRC_CRIT $cw
        }
    }

    mark INPROC_RESULT OK
    close_project

} __err __opts]
if {$__code == 2} {
    # TCL_RETURN：--synthonly 的正常提前退出，不是失败
    puts "INPROC_SYNTHONLY_EARLY_EXIT=1"
    puts "INPROC_DONE=1"
    exit 0
}
if {$__code != 0} {
    puts "INPROC_ERROR=$__err"
    mark INPROC_RESULT FAILED
    catch { close_project }
    exit 1
}

puts "INPROC_DONE=1"
exit 0
