# =============================================================================
# flash_program_v3.tcl -- 第三次固化：修正 hw_cfgmem 句柄流
#   Vivado 2020.2 / 达芬奇Pro XC7A100T / N25Q128 (128Mb SPIx4)
#
# 上次失败的根因（tool\flash_h63_retry.log）：
#   每个候选都报 [Labtoolstcl 44-486] No matching hw_cfgmems found
#   => program_hw_cfgmem 拿到的 hw_cfgmem 句柄是空的（脚本用了 current_hw_cfgmem，
#      该变量在 create_hw_cfgmem 之后并不指向新建的 cfgmem）。
#
# 本版严格按官方句柄流：
#   create_hw_cfgmem -hw_device $dev <part>
#   set cm [get_property PROGRAM.HW_CFGMEM $dev]   <-- 从器件取回句柄
#   all PROGRAM.* 属性设在 $cm 上
#   program_hw_cfgmem -hw_cfgmem $cm
#
# 用法（CWD = retina_event 工程根；-tclargs 必须最后）：
#   vivado.bat -mode batch -source tool\flash_program_v3.tcl \
#              -log tool\flash_h63_v3.log -nojournal \
#              -tclargs build\retina_event_h63_20261009.mcs
# =============================================================================

set mcsfile ""
if {[llength $argv] >= 1} { set mcsfile [lindex $argv 0] }
set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
if {$mcsfile eq ""} {
    set mcsfile [file join $root build retina_event_h63_20261009.mcs]
} else {
    set mcsfile [file normalize $mcsfile]
}
puts "FLASH_MCS=$mcsfile"
if {![file exists $mcsfile]} { puts "FLASH_PROG_RESULT=NO_MCSFILE" ; error "mcs not found" }
puts "FLASH_MCS_BYTES=[file size $mcsfile]"

# ---- 连接 ---------------------------------------------------------------
open_hw_manager
if {[catch { connect_hw_server -url localhost:3121 } e]} {
    puts "FLASH_PROG_RESULT=HW_SERVER_FAIL: $e" ; error "hw_server connect failed"
}
set tgt [lindex [get_hw_targets] 0]
if {$tgt eq ""} { puts "FLASH_PROG_RESULT=NO_TARGET" ; catch { close_hw_manager } ; error "no hw target" }
puts "FLASH_TARGET=$tgt"
current_hw_target $tgt
if {[catch { set_property PARAM.FREQUENCY 6000000 $tgt } e]} {
    puts "FLASH_FREQ_SET_FAIL=$e"
} else {
    puts "FLASH_FREQ=6000000"
}
if {[catch { open_hw_target } e]} { puts "FLASH_PROG_RESULT=OPEN_TARGET_FAIL: $e" ; catch {close_hw_manager} ; error "open_hw_target" }

# ---- 严格句柄流 ----------------------------------------------------------
set dev [lindex [get_hw_devices] 0]
if {$dev eq ""} { puts "FLASH_PROG_RESULT=NO_DEVICE" ; error "no device" }
current_hw_device $dev
puts "FLASH_DEVICE=$dev"
catch { refresh_hw_device -update_hw_probes false $dev }
puts "FLASH_DEV_REFRESHED=1"

# ---- 候选零件枚举 --------------------------------------------------------
set allp {}
catch { set allp [get_cfgmem_parts] }
puts "CFGMEM_ALL_COUNT=[llength $allp]"
set spi128 {}
foreach p $allp { if {[string match -nocase {*128*spi-x1_x2_x4} $p]} { lappend spi128 $p } }
set spi128 [lsort -unique $spi128]
puts "CFGMEM_128_SPIX4_COUNT=[llength $spi128]"
foreach p $spi128 { puts "CFGMEM_128=$p" }

# 候选顺序：mt25ql128-* -> s25fl128sxxxxxx0-spi-x1_x2_x4 -> 其它
set ordered {}
foreach p $spi128 { if {[string match -nocase {mt25ql128*} $p]} { lappend ordered $p } }
foreach p $spi128 { if {[string match -nocase {s25fl128sxxxxxx0-spi-x1_x2_x4} $p] && [lsearch -exact $ordered $p] < 0} { lappend ordered $p } }
foreach p $spi128 { if {[lsearch -exact $ordered $p] < 0} { lappend ordered $p } }
puts "TRY_ORDER_COUNT=[llength $ordered]"
foreach p $ordered { puts "TRY_ORDER=$p" }

# ---- 逐候选尝试 ----------------------------------------------------------
set idx 0
set winner ""
set saw44_486 0
foreach part $ordered {
    incr idx
    puts "FLASH_TRY_BEGIN=$idx PART=$part"
    # 清掉可能存在的旧句柄
    foreach old [get_hw_cfgmems -quiet] { catch { delete_hw_cfgmem $old } }
    puts "HW_CFGMEMS_BEFORE=[get_hw_cfgmems -quiet]"

    if {[catch { create_hw_cfgmem -hw_device $dev $part } e]} {
        puts "FLASH_TRY_CREATE_FAIL=$part :: $e"
        continue
    }
    puts "HW_CFGMEMS_AFTER=[get_hw_cfgmems -quiet]"

    # ★ 关键：从器件上取回"已挂上"的句柄
    set cm ""
    if {[catch { set cm [get_property PROGRAM.HW_CFGMEM $dev] } e]} {
        puts "FLASH_GET_HANDLE_ERR=$e"
    }
    puts "FLASH_CFGMEM_HANDLE=$cm"
    puts "FLASH_CFGMEM_HANDLE_EMPTY=[expr {[string trim $cm] eq ""}]"
    if {[string trim $cm] eq ""} {
        puts "FLASH_TRY_SKIP_EMPTY_HANDLE=$part"
        continue
    }

    # 注意：必须逐条 set_property，不能把 [list $mcsfile] 放进花括号字面量 foreach 里
    # （花括号内不做变量/命令替换，会把 "[list" 和 "$mcsfile]" 当字面量传给 set_property）
    set okv 1
    if {[catch { set_property PROGRAM.FILES       [list $mcsfile] $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.FILES :: $e" ; set okv 0 }
    if {[catch { set_property PROGRAM.BLANK_CHECK 0 $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.BLANK_CHECK :: $e" ; set okv 0 }
    if {[catch { set_property PROGRAM.ERASE       1 $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.ERASE :: $e" ; set okv 0 }
    if {[catch { set_property PROGRAM.CFG_PROGRAM 1 $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.CFG_PROGRAM :: $e" ; set okv 0 }
    if {[catch { set_property PROGRAM.VERIFY      1 $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.VERIFY :: $e" ; set okv 0 }
    if {[catch { set_property PROGRAM.CHECKSUM    0 $cm } e]} { puts "FLASH_SETPROP_FAIL=PROGRAM.CHECKSUM :: $e" ; set okv 0 }
    if {!$okv} { puts "FLASH_TRY_SETPROP_FAILED=$part" ; continue }
    catch { puts "FLASH_CFGMEM_FILES=[get_property PROGRAM.FILES $cm]" }

    puts "FLASH_PROGRAM_CALL=program_hw_cfgmem -hw_cfgmem $cm"
    if {[catch { program_hw_cfgmem -hw_cfgmem $cm } e]} {
        puts "FLASH_TRY_PROGRAM_ERR=$part :: $e"
        if {[string match -nocase {*44-486*} $e]} { set saw44_486 1 ; puts "FLASH_SAW_44_486=1" }
        catch { puts "FLASH_POST_ERR_HW_CFGMEMS=[get_hw_cfgmems -quiet]" }
        continue
    }
    set winner $part
    puts "FLASH_TRY_RESULT=OK PART=$part"
    break
}

if {$winner eq ""} {
    puts "FLASH_SAW_44_486=$saw44_486"
    puts "FLASH_PROG_RESULT=ALL_CANDIDATES_FAILED"
    catch { puts "FLASH_FINAL_HW_CFGMEMS=[get_hw_cfgmems -quiet]" }
    catch { close_hw_target }
    catch { close_hw_manager }
    error "no candidate worked"
}

puts "FLASH_PART_USED=$winner"
puts "FLASH_PROG_RESULT=OK"
puts "FLASH_VERIFY=OK"
catch { refresh_hw_device -update_hw_probes false $dev }
catch { puts "FLASH_CONFIG_STATUS=[get_property REGISTER.CONFIG_STATUS $dev]" }
catch { close_hw_target }
catch { close_hw_manager }
puts "FLASH_DONE=1"
