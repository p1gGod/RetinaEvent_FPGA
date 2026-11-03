# =============================================================================
# build_retina.tcl —— retina_event 一键重建（Vivado 2020.2）
#
#   open_project -> 收拾文件集(ref_original + src/hdl + 本工程 XDC) -> set top
#   -> generate_target all [get_ips]  （★ 工程拷到新路径后必须，否则 MIG 找不到）
#   -> 【进程内】synth_design -> opt_design -> place_design -> route_design -> write_bitstream
#   -> 收比特流到 build\retina_event.bit
#
# 为什么必须用 Vivado 2020.2：本工程的 IP（mig_7series v4.2 / clk_wiz / FIFO）
#   是 2020.2 定制的。用 2023.2 打开会把 .xpr 的 Product Version 改写，
#   IP 变成"2020.2 定制 / 2023.2 锁定"的混合状态（实测踩过，只能重新拷一份）。
#   ⇒ 绝不要用 2023.2 打开 retina_event.xpr。
#
# 为什么默认走**进程内**而不是 launch_runs：本机沙箱拦住了 run server
#   （rundef.js -> WScript.Shell/COM -> Access denied），launch_runs 必死；
#   进程内流程不需要 run server。详见下面"构建主体"一节的实测证据。
#
# 用法（工程根 = retina_event）：
#   vivado.bat -mode batch -source tool\build_retina.tcl -log ... -journal ... -tclargs <mode> <jobs> [top]
#     mode = --full   (默认) 进程内：综合 -> 实现 -> 写比特流
#            --inproc 同 --full（兼容 Lead 的 build_inproc 命名）
#            --dryrun 只做 elaborate 语法检查（synth_design -rtl），提前暴露
#                      RTL 语法错误与缺模块，不综合不写盘
#            --runs   用 reset_run/launch_runs 流程（仅限能拉起 run server 的会话）
#            --resume 沿用已有综合产物，只重跑实现 + 写 bit
#     jobs = 并行数（默认 12）
#     top  = 可选，覆盖顶层名（用于 --dryrun 的正向对照）
#
#   ⚠️ -tclargs 必须放在整条命令行的**最末尾**：它后面的 token 都会被当成脚本 argv，
#      把 -log/-journal 写在它后面就会被吞掉（日志跑到 CWD\vivado.log）。实测踩过。
#
# 判定：只看行首锚定的 ASCII 标记（Vivado 会回显 TCL 源码，不锚定会命中注释行）
#   BUILD_RESULT=OK | SYNTH_FAILED | IMPL_FAILED | ELAB_FAILED | NO_PROJECT | BAD_ARGS
#   BUILD_WNS= BUILD_WHS= BUILD_TNS= BUILD_THS= BUILD_LUT= BUILD_FF= BUILD_BRAM= BUILD_DSP=
#   BUILD_DRC_ERRORS= BUILD_CLOCKS= BUILD_CDC_*_PATHS= BUILD_BIT_BYTES= BUILD_BIT_MD5=
# =============================================================================

# -----------------------------------------------------------------------------
# 参数
# -----------------------------------------------------------------------------
set mode "--full"
set jobs 12
set top  "top_retina_event"
if {[llength $argv] >= 1} { set mode [lindex $argv 0] }
if {[llength $argv] >= 2} { set jobs [lindex $argv 1] }
# argv[2] 可选：覆盖顶层名 —— 用于 --dryrun 的正向对照
#   （例：拿完整存在的厂家顶层 ov5640_lcd 验证 elaborate 通路本身可用）
if {[llength $argv] >= 3} { set top [lindex $argv 2] }
# 模式：--full(默认，进程内综合→实现→比特流) | --inproc(同 --full)
#       --dryrun(只做 elaborate 语法检查，秒级~分钟级)
#       --runs(用 launch_runs 流程，仅限能拉起 run server 的会话)
#       --resume(沿用已有综合产物，只重跑实现)
if {[lsearch -exact {--full --inproc --resume --dryrun --runs} $mode] < 0} {
    puts "BUILD_RESULT=BAD_ARGS"
    puts "BUILD_BAD_MODE=$mode"
    exit 1
}

# -----------------------------------------------------------------------------
# 路径
# -----------------------------------------------------------------------------
set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
set prj_file   [file join $root prj retina_event.xpr]
set ref_dir    [file join $root ref_original]
set hdl_dir    [file join $root src hdl]
set xdc_file   [file join $root src constraints retina_event.xdc]
set out_dir    [file join $root build]
file mkdir $out_dir

puts "BUILD_MODE=$mode"
puts "BUILD_JOBS=$jobs"
puts "BUILD_ROOT=$root"
puts "BUILD_PRJ=$prj_file"
puts "BUILD_XDC=$xdc_file"
puts "BUILD_TOP=$top"

if {![file exists $prj_file]} {
    puts "BUILD_RESULT=NO_PROJECT"
    puts "BUILD_PRJ_MISSING=$prj_file"
    error "project not found: $prj_file"
}
if {![file exists $xdc_file]} {
    puts "BUILD_RESULT=BAD_ARGS"
    puts "BUILD_XDC_MISSING=$xdc_file"
    error "xdc not found: $xdc_file"
}

# -----------------------------------------------------------------------------
# 工具函数
# -----------------------------------------------------------------------------
proc norm {p} { string map {\\ /} [file normalize $p] }

# 递归收集 HDL 源文件（跳过 Vivado 临时目录）
proc collect_hdl {dir} {
    set out {}
    if {![file exists $dir]} { return $out }
    foreach ext {v sv vh svh} {
        foreach f [glob -nocomplain -directory $dir -type f "*.$ext"] { lappend out $f }
    }
    foreach sub [glob -nocomplain -directory $dir -type d *] {
        set n [file tail $sub]
        if {$n eq ".git" || $n eq ".Xil" || $n eq "work"} { continue }
        foreach f [collect_hdl $sub] { lappend out $f }
    }
    return $out
}

# 从 retina_event.xdc 里读端口契约表
#   # RETE_PORT|port|pin|iostd|note      必选端口（缺了就报 BUILD_PORT_MISSING）
#   # RETE_PORT_OPT|port|pin|iostd|note  可选端口（只计入"已知"，不报缺失）
# 返回 {required_rows optional_rows}
proc read_xdc_contract {xdc} {
    set rows {}
    set opts {}
    set fh [open $xdc r]
    while {[gets $fh line] >= 0} {
        if {[regexp {^#\s*RETE_PORT\|([^|]+)\|([^|]+)\|([^|]+)\|} $line m p pin std]} {
            # 跳过表头那行格式模板 `# RETE_PORT|<port>|<pin>|...`（实测会被当成真端口，
            # 让每次构建都白报一条 BUILD_PORT_MISSING=<port>）
            if {[string match "<*" $p]} { continue }
            lappend rows [list $p $pin $std]
        } elseif {[regexp {^#\s*RETE_PORT_OPT\|([^|]+)\|([^|]+)\|([^|]+)\|} $line m p pin std]} {
            if {[string match "<*" $p]} { continue }
            lappend opts [list $p $pin $std]
        }
    }
    close $fh
    return [list $rows $opts]
}

# 从 report_timing_summary 文本里抠 WNS/TNS/WHS/THS
# ⚠️ 真实版式是**空白分隔**（不是 `|` 表格！）：
#     WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns) ...
#     -------      -------  ---------------------  -------------------      -------      -------
#       0.741        0.000                      0                64537        0.026        0.000 ...
#   首版按 `|` 表格写正则 ⇒ 永远返回 "?"（实测踩过：构建成功但 BUILD_TNS/BUILD_THS/BUILD_DRC_* 全是 ?）。
proc parse_timing_summary {txt} {
    set lines [split $txt "\n"]
    set n [llength $lines]
    for {set i 0} {$i < $n} {incr i} {
        if {[string match "*WNS(ns)*TNS(ns)*" [lindex $lines $i]]} {
            for {set j [expr {$i+1}]} {$j < $n && $j < $i+10} {incr j} {
                set l [lindex $lines $j]
                if {[regexp {^\s*(-?[0-9]+\.[0-9]+)\s+(-?[0-9]+\.[0-9]+)\s+[0-9]+\s+[0-9]+\s+(-?[0-9]+\.[0-9]+)\s+(-?[0-9]+\.[0-9]+)} $l -> w t wh th]} {
                    return [list $w $t $wh $th]
                }
            }
        }
    }
    return [list "?" "?" "?" "?"]
}

# 实现后统一核查：时钟 / CDC 是否生效 / 资源 / 报告文件 / 引脚逐条 / 未约束 I/O
proc emit_post_checks {xdc_file out_dir} {
    puts "BUILD_CLOCKS=[get_clocks -quiet *]"
    puts "BUILD_NCLOCKS=[llength [get_clocks -quiet *]]"

    # ---- clk_lcd（25 MHz）是否真的被约束上了？ Lead 点名要的验证 ----
    # Vivado 的自动派生只在 MMCM/PLL 输出引脚发生，**不会穿过 fabric 分频寄存器**，
    # 所以 XDC 里必须手写 create_generated_clock -name clk_lcd；这里回头验它到底有没有生效。
    set c_lcd [get_clocks -quiet clk_lcd]
    if {[llength $c_lcd] > 0} {
        set per "?"
        catch { set per [get_property PERIOD $c_lcd] }
        puts "BUILD_CLK_LCD_PRESENT=1"
        puts "BUILD_CLK_LCD_PERIOD=$per"
        puts "BUILD_CLK_LCD_SOURCE=[get_property SOURCE_PINS $c_lcd]"
    } else {
        puts "BUILD_CLK_LCD_PRESENT=0"
        puts "BUILD_CLK_LCD_NOTE=create_generated_clock did not take effect (instance path wrong?)"
    }
    # 另报 200/50 MHz 两个 MMCM 派生件，便于一眼核对派生链
    foreach cn {clk_out1_clk_wiz_0 clk_out2_clk_wiz_0} {
        set cc [get_clocks -quiet $cn]
        if {[llength $cc] > 0} {
            set pp "?"
            catch { set pp [get_property PERIOD $cc] }
            puts "BUILD_CLK_$cn=$pp"
        }
    }

    # ---- CDC 约束是否真的生效？（Vivado 没有 get_clock_groups 命令，只能这样验）----
    # set_clock_groups -asynchronous 生效时，跨异步域的时序路径应当一条都取不到。
    # ⚠️ 必须加 -no_report_unconstrained：否则会把"未约束占位路径"也算进来。实测：
    #    timing_impl.rpt 的 Inter Clock Table 里 cam_pclk **一行都没有**、且报告写明
    #    "All user specified timing constraints are met."，但这里却报 1 条 ⇒ 假阳性。
    #    权威判据始终是 timing_impl.rpt 的 Inter Clock Table；本标记只作快速提示。
    set cdc_cam_sys 0
    set cdc_sys_cam 0
    set clk_cam [get_clocks -quiet cam_pclk]
    set clk_sys [get_clocks -include_generated_clocks -quiet sys_clk]
    if {[llength $clk_cam] > 0 && [llength $clk_sys] > 0} {
        if {[catch { set cdc_cam_sys [llength [get_timing_paths -no_report_unconstrained -from $clk_cam -to $clk_sys -max_paths 1 -nworst 1]] } err]} {
            puts "BUILD_CDC_PATH_QUERY_FAIL_1=$err"
        }
        if {[catch { set cdc_sys_cam [llength [get_timing_paths -no_report_unconstrained -from $clk_sys -to $clk_cam -max_paths 1 -nworst 1]] } err]} {
            puts "BUILD_CDC_PATH_QUERY_FAIL_2=$err"
        }
    } else {
        puts "BUILD_CDC_PATH_QUERY_SKIPPED=missing_clock"
    }
    puts "BUILD_CDC_CAM_TO_SYS_PATHS=$cdc_cam_sys"
    puts "BUILD_CDC_SYS_TO_CAM_PATHS=$cdc_sys_cam"
    if {$cdc_cam_sys > 0 || $cdc_sys_cam > 0} {
        puts "BUILD_CDC_WARNING=clock_groups_may_not_be_effective"
    }

    # ---- 资源 ----
    set util_txt [report_utilization -return_string]
    foreach line [split $util_txt "\n"] {
        if {[regexp {\|\s+Slice LUTs\s*\|\s+([0-9]+)} $line m v]}      { puts "BUILD_LUT=$v" }
        if {[regexp {\|\s+Slice Registers\s*\|\s+([0-9]+)} $line m v]} { puts "BUILD_FF=$v" }
        if {[regexp {\|\s+Block RAM Tile\s*\|\s+([0-9.]+)} $line m v]} { puts "BUILD_BRAM=$v" }
        if {[regexp {\|\s+DSPs\s*\|\s+([0-9]+)} $line m v]}            { puts "BUILD_DSP=$v" }
    }

    report_utilization    -file [file join $out_dir util_impl.rpt]
    report_timing_summary -file [file join $out_dir timing_impl.rpt]
    report_drc            -file [file join $out_dir drc_impl.rpt] -name drc_impl
    report_clocks         -file [file join $out_dir clocks_impl.rpt]

    # ---- DRC error 数（Lead 要的字段）----
    # ⚠️ 从**报告文件**解析，别用 `report_drc -return_string`：实测返回串里没有
    #    "N Infos, N Warnings, N Critical Warnings and N Errors" 那一行（首次构建
    #    三个 BUILD_DRC_* 全是 "?"）。文件里给的是规则表：
    #      | Rule | Severity | Description | Violations |
    #      | PLCK-12 | Warning | Clock Placer Checks | 1 |
    #   按 Severity 累加 Violations 即得 Error / Critical Warning / Warning 数。
    set drc_file [file join $out_dir drc_impl.rpt]
    set drc_err 0
    set drc_cw 0
    set drc_warn 0
    set drc_total "?"
    if {[file exists $drc_file]} {
        set fh [open $drc_file r]
        set drc_txt [read $fh]
        close $fh
        foreach l [split $drc_txt "\n"] {
            if {[regexp {Violations found:\s*([0-9]+)} $l -> t]} { set drc_total $t }
            if {[regexp {^\|\s*([A-Za-z0-9_-]+)\s*\|\s*(Error|Critical Warning|Warning)\s*\|[^|]*\|\s*([0-9]+)} $l -> rule sev cnt]} {
                if {$sev eq "Error"}            { incr drc_err  $cnt ; puts "BUILD_DRC_RULE_ERROR=$rule x$cnt" }
                if {$sev eq "Critical Warning"} { incr drc_cw   $cnt ; puts "BUILD_DRC_RULE_CRIT=$rule x$cnt" }
                if {$sev eq "Warning"}          { incr drc_warn $cnt ; puts "BUILD_DRC_RULE_WARN=$rule x$cnt" }
            }
        }
    } else {
        puts "BUILD_DRC_FILE_MISSING=$drc_file"
    }
    puts "BUILD_DRC_ERRORS=$drc_err"
    puts "BUILD_DRC_CRITICAL_WARNINGS=$drc_cw"
    puts "BUILD_DRC_WARNINGS=$drc_warn"
    puts "BUILD_DRC_VIOLATIONS_TOTAL=$drc_total"

    # ---- 引脚落点逐条核对（直接问实现后的设计，比读 XDC 可靠）----
    lassign [read_xdc_contract $xdc_file] contract opt_contract
    set pin_fail 0
    set port_missing 0
    foreach row $contract {
        lassign $row p pin std
        set objs [get_ports -quiet $p]
        if {[llength $objs] == 0} {
            puts "BUILD_PORT_MISSING=$p"
            incr port_missing
            continue
        }
        set ap "?"
        set as "?"
        catch { set ap [get_property PACKAGE_PIN $objs] }
        catch { set as [get_property IOSTANDARD $objs] }
        if {$ap ne $pin} { puts "BUILD_PIN_CHECK_FAIL=$p expected=$pin actual=$ap" ; incr pin_fail }
        if {$as ne $std} { puts "BUILD_IOSTD_CHECK_FAIL=$p expected=$std actual=$as" ; incr pin_fail }
    }
    puts "BUILD_PIN_CHECKED=[llength $contract]"
    puts "BUILD_PIN_CHECK_FAILS=$pin_fail"
    puts "BUILD_PORT_MISSING_COUNT=$port_missing"

    # ---- 未约束的 I/O（实现期 DRC UCIO-1 的根因）----
    set unconstrained 0
    foreach p [get_ports -quiet *] {
        set pin "?"
        catch { set pin [get_property PACKAGE_PIN [get_ports $p]] }
        if {$pin eq "" || $pin eq "?"} {
            puts "BUILD_PORT_UNCONSTRAINED=$p"
            incr unconstrained
        }
    }
    puts "BUILD_PORT_UNCONSTRAINED_COUNT=$unconstrained"
}

# -----------------------------------------------------------------------------
# 打开工程
# -----------------------------------------------------------------------------
open_project $prj_file
puts "BUILD_VIVADO=[version -short]"
puts "BUILD_PART=[get_property part [current_project]]"

set src_fs  [get_filesets sources_1]
set cons_fs [get_filesets constrs_1]

# ---- 0) ★ 关掉 automatic hierarchy update：换成"手动编译顺序"-----------------
# ⚠️ 实测根因（build\_accept_full.console.log，2026-10-03）：
#   在 automatic 模式下，即使 36 个 src/hdl 文件**都已在工程里**，Vivado 仍会：
#     WARNING:  [filemgmt 56-12] File '.../src/hdl/top/top_retina_event.v' cannot be
#               added to the project because it already exists in the project, skipping
#     CRITICAL WARNING: [filemgmt 20-742] The top module "top_retina_event" specified for
#               this project can not be validated. The current project is using automatic
#               hierarchy update mode, and hence a new suitable replacement top will be
#               automatically selected.
#   随后 synth_design 直接 `ERROR: [Synth 8-439] module 'top_retina_event' not found`。
#   工具自己在 Resolution 里给的解法就是：
#     set_property source_mgmt_mode None [current_project]      ← 手动编译顺序
#   ⇒ 手动模式下"fileset 里列了谁就读谁"，不再有"自动换顶层"这种不确定性，
#     构建也变成可复现的（这一点比 automatic 更适合交付）。
if {[catch { set_property source_mgmt_mode None [current_project] } err]} {
    puts "BUILD_SET_SRC_MGMT_FAIL=$err"
}
catch { puts "BUILD_SRC_MGMT_MODE=[get_property source_mgmt_mode [current_project]]" }

# ---- 1) 文件集收拾：源 ------------------------------------------------------
# 工程从厂家例程 37 拷来，原本已有一条 $PPRDIR/../ref_original/*.v。
# 做法对齐 Lead 已验证的 build_inproc.tcl：**先摘掉旧的 src/hdl + ref_original 条目再重加**。
# 只 add 不 remove 时 Vivado 报 [filemgmt 56-12] 跳过、层次结构不刷新 ⇒ 顶层"验证不了"。
foreach f [get_files -quiet -of $src_fs] {
    set nf [norm $f]
    if {[string match "*/src/hdl/*" $nf] || [string match "*/ref_original/*" $nf]} {
        catch { remove_files -quiet [list $f] }
    }
}
puts "BUILD_SRCSET_AFTER_REMOVE=[llength [get_files -quiet -of $src_fs]]"

set ref_files [collect_hdl $ref_dir]
set hdl_files {}
if {[file exists $hdl_dir]} { set hdl_files [collect_hdl $hdl_dir] }
puts "BUILD_NREF=[llength $ref_files]"
puts "BUILD_NHDL=[llength $hdl_files]"

foreach f $ref_files { puts "BUILD_REF=$f" }
foreach f $hdl_files { puts "BUILD_HDL=$f" }

if {[llength $ref_files] > 0} { add_files -fileset $src_fs -norecurse $ref_files }
if {[llength $hdl_files] > 0} { add_files -fileset $src_fs -norecurse $hdl_files }
puts "BUILD_SRCSET_AFTER_ADD=[llength [get_files -quiet -of $src_fs]]"
# 顶层此刻可能还没交付 —— 设 top 失败要报出来而不是直接崩（dryrun 下要给出清晰原因）
if {[catch { set_property top $top $src_fs } err]} {
    puts "BUILD_SET_TOP_FAIL=$err"
}
# 顶层 RTL 是否存在（dryrun 下缺文件是最常见的原因，先明确报出来）
set top_file [file join $hdl_dir top "$top.v"]
puts "BUILD_TOP_FILE_EXISTS=[file exists $top_file]"
# 显式钉住 top_file + 刷新编译顺序
if {[file exists $top_file]} {
    if {[catch { set_property top_file [norm $top_file] $src_fs } err]} {
        puts "BUILD_SET_TOP_FILE_FAIL=$err"
    }
}
if {[catch { update_compile_order -fileset $src_fs } err]} {
    puts "BUILD_UPDATE_COMPILE_ORDER_FAIL=$err"
}
if {[catch { set_property top $top [current_fileset] } err]} {
    puts "BUILD_SET_TOP_FAIL=$err"
}

# ---- 2) 文件集收拾：约束 ----------------------------------------------------
# 厂家 pin.xdc 与本工程 retina_event.xdc 会重复约束同一批引脚 ⇒ 必须把厂家那份移除。
foreach f [get_files -quiet -of $cons_fs] {
    if {[norm $f] ne [norm $xdc_file]} {
        puts "BUILD_REMOVE_CONSTR=$f"
        remove_files [list $f]
    }
}
add_files -fileset $cons_fs -norecurse $xdc_file
set_property target_constrs_file [norm $xdc_file] $cons_fs
puts "BUILD_CONSTRS=[get_files -quiet -of $cons_fs]"

# 源文件里是否有重复模块名（厂家 i2c_dri / lcd_driver 一个工程只能有一份）
#   ⚠️ 只查参加综合的源。必须跳过 .gen / .ip_user_files：
#      .gen 里的 IP 仿真件本来就同名（fifo_generator_vlog_beh.v 在 rd_fifo 与 wr_fifo
#      各一份；mig_7series_0_mig.v 与 mig_7series_0_mig_sim.v），不跳过会误报 9 条。
array set modmap {}
foreach f [get_files -quiet -of $src_fs] {
    if {[file extension $f] ni {.v .sv}} { continue }
    set nf [norm $f]
    if {[string match "*.gen/*" $nf] || [string match "*.ip_user_files/*" $nf]} { continue }
    set fh [open $f r]
    while {[gets $fh line] >= 0} {
        if {[regexp {^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)} $line m name]} {
            if {[info exists modmap($name)]} {
                puts "BUILD_DUP_MODULE=$name  a=$modmap($name)  b=$f"
            } else {
                set modmap($name) $f
            }
        }
    }
    close $fh
}
puts "BUILD_NMODULES=[array size modmap]"

# ---- 3) IP 输出产物（★ 拷贝到新路径后必须重新生成，否则 MIG 找不到）---------
# ⚠️ 实测（build\_probe_ip.console.log）：工程整份拷到新路径后，
#    .gen 里的 IP 产物被 Vivado 判为"不适用"，synth_design -rtl 直接报
#    [Synth 8-439] module 'mig_7series_0' not found（= skill §3.3 那个签名）。
#    执行 generate_target all [get_ips] 重新生成后，elaborate 一次通过（117 个端口）。
#    ⇒ 每次构建都显式生成一次；已是最新时是 no-op，代价很小。
set ips [get_ips]
puts "BUILD_NIPS=[llength $ips]"
if {[llength $ips] > 0} {
    puts "BUILD_STEP=generate_target all [get_ips]"
    if {[catch { generate_target all $ips } err]} {
        puts "BUILD_GEN_TARGET_FAIL=$err"
    } else {
        puts "BUILD_GEN_TARGET_OK=1"
    }
} else {
    puts "BUILD_GEN_TARGET_SKIPPED=no_ips"
}

# =============================================================================
# DRYRUN：只读文件 + elaborate 语法检查，不综合、不写盘
# =============================================================================
if {$mode eq "--dryrun"} {
    puts "BUILD_STEP=synth_design -rtl (elaborate only)"
    if {[catch { synth_design -rtl -name rtl_1 } err]} {
        puts "BUILD_ELAB_ERROR=$err"
        puts "BUILD_RESULT=ELAB_FAILED"
        catch { close_project }
        exit 1
    }
    puts "BUILD_ELAB=OK"

    set ports [get_ports -quiet *]
    puts "BUILD_NPORTS=[llength $ports]"
    foreach p $ports { puts "BUILD_PORT=$p" }

    # 与 XDC 端口契约表交叉核对
    lassign [read_xdc_contract $xdc_file] contract opt_contract
    set nreq [llength $contract]
    set missing 0
    set nmatch 0
    foreach row $contract {
        lassign $row p pin std
        set objs [get_ports -quiet $p]
        if {[llength $objs] == 0} {
            puts "BUILD_PORT_MISSING=$p   (XDC expects pin=$pin but top has no such port)"
            incr missing
            continue
        }
        incr nmatch
        set ap "?"
        set as "?"
        catch { set ap [get_property PACKAGE_PIN $objs] }
        catch { set as [get_property IOSTANDARD $objs] }
        if {$ap ne $pin} { puts "BUILD_PIN_CHECK_FAIL=$p expected=$pin actual=$ap" }
        if {$as ne $std} { puts "BUILD_IOSTD_CHECK_FAIL=$p expected=$std actual=$as" }
    }
    puts "BUILD_XDC_CONTRACT=$nreq"
    puts "BUILD_XDC_CONTRACT_MATCHED=$nmatch"
    puts "BUILD_XDC_CONTRACT_MISSING=$missing"

    # 反向：顶层有但 XDC 没约束的端口（会变成未约束 I/O ⇒ 实现期 DRC UCIO-1）
    #   DDR3 全组由 MIG 生成的 mig_7series_0.xdc 约束（70 条 PACKAGE_PIN），
    #   本工程 XDC 故意不重复写 ⇒ 这里跳过 ddr3_* 前缀，避免 70 行误报。
    set known {}
    foreach row $contract     { lappend known [lindex $row 0] }
    foreach row $opt_contract { lappend known [lindex $row 0] }
    set unconstrained 0
    foreach p $ports {
        if {[string match "ddr3_*" $p]} { continue }
        if {[lsearch -exact $known $p] < 0} {
            puts "BUILD_PORT_EXTRA=$p   (in top, not constrained by retina_event.xdc)"
            incr unconstrained
        }
    }
    puts "BUILD_PORT_EXTRA_COUNT=$unconstrained"

    # 时钟：不打印就不知道 MMCM 派生是否成立。
    # ⚠️ Vivado **没有** get_clock_groups 这个命令（实测：invalid command name），
    #    所以这里只报时钟清单；clock group 是否生效改用实现后的
    #    BUILD_CDC_* 路径计数验证（见下）。
    puts "BUILD_CLOCKS=[get_clocks -quiet *]"
    puts "BUILD_NCLOCKS=[llength [get_clocks -quiet *]]"
    puts "BUILD_DRYRUN=1"
    puts "BUILD_RESULT=OK"
    close_project
    return
}

# =============================================================================
# 构建主体：两种流程
#
#   ★ 默认走**进程内**流程。原因（实测原始证据 build\_full_control.console.log）：
#       [Sat Oct  3 20:09:25 2026] Launched synth_1...
#       [Sat Oct  3 20:09:25 2026] Waiting for synth_1 to finish...
#       .../retina_event.runs/synth_1/rundef.js(121, 5) JavaScript runtime error: Access denied
#       *** Running vivado with args -log clk_wiz_0.vds ... -source clk_wiz_0.tcl   ← 只写到这行就死
#     本机沙箱拦住了 run server（WSH/COM + 子进程）⇒ launch_runs 流程在本环境**跑不通**。
#     进程内流程不需要 run server，实测可用（Lead 侧 --synthonly 已交叉验证）。
#   ⚠️ 为什么不做"先试 launch_runs、失败再自动回退"：run server 被拦时
#      wait_on_run **不返回**（整个 vivado 进程直接退出），脚本根本没有机会执行回退分支。
#      ⇒ 所以默认就是进程内；--runs 只留给不受限会话（需要 resumable run 时用）。
# =============================================================================
set part [get_property part [current_project]]

if {$mode eq "--runs"} {
    puts "BUILD_FLOW=launch_runs"
    puts "BUILD_STEP=reset_run synth_1"
    reset_run synth_1
    puts "BUILD_STEP=launch_runs synth_1 -jobs $jobs"
    launch_runs synth_1 -jobs $jobs
    wait_on_run synth_1
    puts "BUILD_SYNTH_PROGRESS=[get_property PROGRESS [get_runs synth_1]]"
    puts "BUILD_SYNTH_STATUS=[get_property STATUS [get_runs synth_1]]"
    if {[get_property PROGRESS [get_runs synth_1]] ne "100%"} {
        puts "BUILD_SYNTH_ERRORS=[get_property STATS.ERRORS [get_runs synth_1]]"
        puts "BUILD_RESULT=SYNTH_FAILED"
        error "synthesis failed"
    }
    puts "BUILD_STEP=reset_run impl_1"
    reset_run impl_1
    puts "BUILD_STEP=launch_runs impl_1 -to_step write_bitstream -jobs $jobs"
    launch_runs impl_1 -to_step write_bitstream -jobs $jobs
    wait_on_run impl_1
    puts "BUILD_IMPL_PROGRESS=[get_property PROGRESS [get_runs impl_1]]"
    puts "BUILD_IMPL_STATUS=[get_property STATUS [get_runs impl_1]]"
    if {[get_property PROGRESS [get_runs impl_1]] ne "100%"} {
        puts "BUILD_IMPL_ERRORS=[get_property STATS.ERRORS [get_runs impl_1]]"
        puts "BUILD_RESULT=IMPL_FAILED"
        error "implementation failed"
    }
    puts "BUILD_WNS=[get_property STATS.WNS [get_runs impl_1]]"
    puts "BUILD_WHS=[get_property STATS.WHS [get_runs impl_1]]"
    puts "BUILD_TNS=[get_property STATS.TNS [get_runs impl_1]]"
    puts "BUILD_THS=[get_property STATS.THS [get_runs impl_1]]"
    puts "BUILD_STEP=open_run impl_1"
    open_run impl_1
} else {
    # ---- 进程内流程（--full / --inproc / --resume，本环境唯一可用）----------
    puts "BUILD_FLOW=in_process"
    puts "BUILD_PART_USED=$part"
    set synth_dcp [file join $out_dir post_synth.dcp]

    # 综合参数刻意与 Lead 已验证的 tool\build_inproc.tcl **逐字一致**：
    #   synth_design -top <top> -part <part> -flatten_hierarchy rebuilt -directive Default
    #   （不带 -jobs —— 该选项在进程内流程里无意义，且少一个可能报错的参数）
    if {$mode eq "--resume" && [file exists $synth_dcp]} {
        puts "BUILD_STEP=open_checkpoint $synth_dcp"
        if {[catch { open_checkpoint $synth_dcp } err]} {
            puts "BUILD_RESUME_ERROR=$err"
            puts "BUILD_RESULT=SYNTH_FAILED"
            catch { close_project }
            exit 1
        }
        puts "BUILD_SYNTH_REUSED=$synth_dcp"
    } else {
        puts "BUILD_STEP=synth_design -top $top -part $part -flatten_hierarchy rebuilt -directive Default"
        if {[catch { synth_design -top $top -part $part -flatten_hierarchy rebuilt -directive Default } err]} {
            puts "BUILD_SYNTH_ERROR=$err"
            puts "BUILD_RESULT=SYNTH_FAILED"
            catch { close_project }
            exit 1
        }
        puts "BUILD_SYNTH_OK=1"
        puts "BUILD_SYNTH_CELLS=[llength [get_cells -hier -quiet *]]"
        # 存 post_synth.dcp：① 让 --resume 可用 ② 出问题时可离线查单元/引脚名
        if {[catch { write_checkpoint -force $synth_dcp } err]} {
            puts "BUILD_WRITE_SYNTH_DCP_FAIL=$err"
        } else {
            puts "BUILD_SYNTH_DCP=$synth_dcp"
        }
    }

    # XDC 有没有真的生效？抽查 3 个受约束引脚。
    # （进程内流程靠 fileset 的约束集自动应用；若这里对不上说明约束没进来，必须立刻发现）
    set pend 0
    foreach chk {{sys_clk R4} {lcd_bl W9} {cam_pclk U18}} {
        lassign $chk pn pin
        set ap "?"
        catch { set ap [get_property PACKAGE_PIN [get_ports -quiet $pn]] }
        if {$ap ne $pin} { puts "BUILD_SYNTH_PIN_NOT_APPLIED=$pn expected=$pin actual=$ap" ; incr pend }
    }
    puts "BUILD_SYNTH_PIN_APPLY_FAILS=$pend"

    puts "BUILD_STEP=opt_design"
    if {[catch { opt_design } err]} {
        puts "BUILD_OPT_ERROR=$err" ; puts "BUILD_RESULT=IMPL_FAILED"
        catch { close_project } ; exit 1
    }
    puts "BUILD_STEP=place_design"
    if {[catch { place_design } err]} {
        puts "BUILD_PLACE_ERROR=$err" ; puts "BUILD_RESULT=IMPL_FAILED"
        catch { close_project } ; exit 1
    }
    puts "BUILD_STEP=route_design"
    if {[catch { route_design } err]} {
        puts "BUILD_ROUTE_ERROR=$err" ; puts "BUILD_RESULT=IMPL_FAILED"
        catch { close_project } ; exit 1
    }
    puts "BUILD_IMPL=OK"

    # 时序：进程内没有 run 对象，用 get_timing_paths + 摘要解析两条路取
    set wns "?" ; set whs "?" ; set tns "?" ; set ths "?"
    catch { set wns [get_property SLACK [get_timing_paths -delay_type max -max_paths 1 -nworst 1]] }
    catch { set whs [get_property SLACK [get_timing_paths -delay_type min -max_paths 1 -nworst 1]] }
    if {[catch { set ts [report_timing_summary -return_string] } err]} {
        puts "BUILD_TIMING_SUMMARY_FAIL=$err"
    } else {
        lassign [parse_timing_summary $ts] a b c d
        if {$a ne "?"} { set wns $a }
        if {$b ne "?"} { set tns $b }
        if {$c ne "?"} { set whs $c }
        if {$d ne "?"} { set ths $d }
    }
    puts "BUILD_WNS=$wns"
    puts "BUILD_WHS=$whs"
    puts "BUILD_TNS=$tns"
    puts "BUILD_THS=$ths"

    puts "BUILD_STEP=write_bitstream"
    set bit_inproc [file join $out_dir "$top.bit"]
    if {[catch { write_bitstream -force $bit_inproc } err]} {
        puts "BUILD_BITSTREAM_ERROR=$err"
        puts "BUILD_RESULT=IMPL_FAILED"
        catch { close_project }
        exit 1
    }
    puts "BUILD_BITSTREAM_FILE=$bit_inproc"
}

# =============================================================================
# 结果核查（已抽成 emit_post_checks 过程，两种流程共用）
#   · --runs / --resume ：上面已 open_run impl_1
#   · 进程内流程        ：route_design 之后当前设计就是实现后的设计
# =============================================================================
emit_post_checks $xdc_file $out_dir

# =============================================================================
# 收比特流
#   进程内流程写在 build\<top>.bit；launch_runs 流程写在 .runs\impl_1\*.bit
# =============================================================================
set bit_dst [file join $out_dir retina_event.bit]
set bit_src ""
set cand [file join $out_dir "$top.bit"]
if {[file exists $cand]} {
    set bit_src $cand
} else {
    set bit_files [glob -nocomplain -directory [file join $root prj retina_event.runs impl_1] -type f "*.bit"]
    if {[llength $bit_files] > 0} { set bit_src [lindex $bit_files 0] }
}
if {$bit_src eq "" || ![file exists $bit_src]} {
    puts "BUILD_RESULT=IMPL_FAILED  (no .bit found in either flow)"
    error "bitstream not produced"
}
if {[norm $bit_src] ne [norm $bit_dst]} { file copy -force $bit_src $bit_dst }
puts "BUILD_BIT_SRC=$bit_src"
puts "BUILD_BIT_DST=$bit_dst"
puts "BUILD_BIT_BYTES=[file size $bit_dst]"
set md5 0
catch { set md5 [lindex [split [exec cmd /c "certutil -hashfile \"$bit_dst\" MD5 | findstr /r \"^[0-9a-f]\""] "\n"] 0] }
puts "BUILD_BIT_MD5=$md5"

puts "BUILD_RESULT=OK"
