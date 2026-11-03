# =============================================================================
# flash_retry.tcl —— 第二次尝试：用兼容的 cfgmem part 把 h63 的 .mcs 写进 SPI Flash
#   Vivado 2020.2 / 达芬奇Pro XC7A100T / JTAG 6 MHz
# 用法（CWD = retina_event 工程根）：
#   vivado.bat -mode batch -source tool\flash_retry.tcl -log tool\flash_h63_retry.log -nojournal \
#              -tclargs build\retina_event_h63_20261009.mcs
# 安全：只写 h63 的 .mcs；每次候选失败即换下一个；全部失败则停手（不硬写无关 part）
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
if {![file exists $mcsfile]} { puts "FLASH_PROG_RESULT=NO_MCSFILE" ; error "mcs not found: $mcsfile" }
puts "FLASH_MCS_BYTES=[file size $mcsfile]"

open_hw_manager
if {[catch { connect_hw_server -url localhost:3121 } e]} {
    puts "FLASH_PROG_RESULT=HW_SERVER_FAIL: \$e" ; error "hw_server connect failed"
}
set tgt [lindex [get_hw_targets] 0]
if {$tgt eq ""} { puts "FLASH_PROG_RESULT=NO_TARGET" ; catch { close_hw_manager } ; error "no hw target" }
puts "FLASH_TARGET=$tgt"
current_hw_target $tgt
catch { set_property PARAM.FREQUENCY 6000000 $tgt }
puts "FLASH_FREQ=6000000"
open_hw_target
set dev [lindex [get_hw_devices] 0]
puts "FLASH_DEVICE=$dev"
current_hw_device $dev
catch { refresh_hw_device -update_hw_probes false $dev }

# ---- 步骤3：列出 Vivado 支持的全部 128Mb SPIx4 候选 ------------------------
set spi128 {}
if {[catch { set allp [get_cfgmem_parts *128*] } e]} { set allp {} ; puts "P128_QUERY_ERR=\$e" }
puts "P128_RAW_COUNT=[llength $allp]"
foreach p $allp {
    # 只要恰好 spi-x1_x2_x4（7 系列不支持 x8）；排除 _x8 后缀的伪匹配
    if {[string match -nocase {*spi-x1_x2_x4} $p]} { lappend spi128 $p }
}
set spi128 [lsort -unique $spi128]
puts "P128_COUNT=[llength $spi128]"
foreach p $spi128 { puts "P128=$p" }

# ---- 候选优先级：与资料型号同名者优先 ---------------------------------------
set prio {mt25ql128 n25q128 s25fl128 is25lp128 is25wp128 w25q128 mx25l128 mx25u128 mt25qu128 gd25q128}
set ordered {}
foreach key $prio {
    foreach p $spi128 {
        if {[string match -nocase "*$key*" $p] && [lsearch -exact $ordered $p] < 0} { lappend ordered $p }
    }
}
foreach p $spi128 { if {[lsearch -exact $ordered $p] < 0} { lappend ordered $p } }
puts "TRY_ORDER_COUNT=[llength $ordered]"
foreach p $ordered { puts "TRY_ORDER=$p" }

# ---- 步骤4：逐候选尝试 ------------------------------------------------------
set MAXTRY 10
set n 0
set idx 0
set winner ""
foreach part $ordered {
    if {$n >= $MAXTRY} { puts "TRY_LIMIT_REACHED=$MAXTRY" ; break }
    incr n
    incr idx
    puts "TRY_BEGIN=$idx PART=$part"
    catch { delete_hw_cfgmem [current_hw_cfgmem] }
    if {[catch { create_hw_cfgmem -hw_device $dev $part } e]} {
        puts "TRY_CREATE_FAIL=$part :: $e"
        continue
    }
    set cm [current_hw_cfgmem]
    puts "TRY_CFGMEM=$cm PART=$part"
    if {[catch {
        set_property PROGRAM.BLANK_CHECK 0 $cm
        set_property PROGRAM.ERASE       1 $cm
        set_property PROGRAM.CFG_PROGRAM 1 $cm
        set_property PROGRAM.VERIFY      1 $cm
        set_property PROGRAM.CHECKSUM    0 $cm
        set_property PROGRAM.ADDRESS_RANGE {use_file} $cm
        set_property PROGRAM.FILES       [list $mcsfile] $cm
    } e]} {
        puts "TRY_SETPROP_FAIL=$part :: $e"
        catch { delete_hw_cfgmem $cm }
        continue
    }
    if {[catch { program_hw_cfgmem -hw_cfgmem $cm } e]} {
        puts "TRY_PROGRAM_FAIL=$part :: $e"
        catch { delete_hw_cfgmem $cm }
        continue
    }
    set winner $part
    puts "TRY_PROGRAM_OK=$part"
    break
}

if {$winner ne ""} {
    puts "FLASH_CFGMEM_PART=$winner"
    puts "FLASH_PROG_RESULT=OK"
    puts "FLASH_VERIFY=OK"
} else {
    puts "FLASH_PROG_RESULT=FAIL"
    puts "FLASH_VERIFY=NA"
}
catch { close_hw_target }
catch { close_hw_manager }
puts "FLASH_DONE=1"
