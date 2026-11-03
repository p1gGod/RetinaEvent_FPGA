# =============================================================================
# flash_program.tcl —— 把 h63 基线位流的 .mcs 写入板上 SPI 配置 Flash（Vivado 2020.2）
#
# 用法（CWD = retina_event 工程根；-tclargs 放最后）：
#   vivado.bat -mode batch -source tool\flash_program.tcl -log tool\flash_h63.log -nojournal \
#              -tclargs build\retina_event_h63_20261009.mcs
#   不带参数时默认 build\retina_event_h63_20261009.mcs
#
# 前置事实（实测 + 原理图）：
#   * 板上配置 Flash = N25Q128（128 Mbit = 16 MB），接口 SPIx4
#     —— 依据 1：核心板原理图 / my_board_info.md 「配置 Flash = N25Q128（16 MB）」
#     —— 依据 2：器件寄存器实测 REGISTER.CONFIG_STATUS.M[2:0] = 001 ⇒ Master SPI 配置模式
#     —— 依据 3：本机 Vivado cfgmem 列表中对应 part 名 = n25q128-3.3v-spi-x1_x2_x4
#   * JTAG 必须降频到 6 MHz（板载 FTDI FT2232H；默认频率报 [Xicom 50-38]）—— 事实 H43
#
# 判定：只看行首锚定的 ASCII 标记
#   FLASH_PROG_RESULT=OK  /  FLASH_VERIFY=OK   （不要 grep 中文日志）
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

# ---- 连接硬件服务器（与 program_retina.tcl 同一套实测流程）------------------
open_hw_manager
if {[catch { connect_hw_server -url localhost:3121 } e]} {
    puts "FLASH_PROG_RESULT=HW_SERVER_FAIL: $e" ; error "hw_server connect failed"
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

# ---- 创建配置存储器对象 -----------------------------------------------------
# 候选 part 名（实测：Vivado 2020.2 的 get_cfgmem_parts 中**不存在** n25q128-3.3v-spi-x1_x2_x4，
# 只有 n25q32/n25q64；Micron N25Q128 的同族后继型号 mt25ql128 才是本版本可用的 128Mb/3.3V/SPI 条目）
set cfmpart ""
foreach c [list mt25ql128-spi-x1_x2_x4 n25q128-3.3v-spi-x1_x2_x4 s25fl128sxxxxxx0-spi-x1_x2_x4] {
    if {[catch { set hit [get_cfgmem_parts $c] } e]} { set hit "" }
    puts "FLASH_CFGMEM_PROBE=$c -> [expr {[llength $hit] > 0 ? "FOUND" : "MISSING"}]"
    if {$cfmpart eq "" && [llength $hit] > 0} { set cfmpart $c }
}
if {$cfmpart eq ""} { puts "FLASH_PROG_RESULT=NO_CFGMEM_PART" ; catch { close_hw_target } ; catch { close_hw_manager } ; error "cfgmem part not found" }
puts "FLASH_CFGMEM_PART=$cfmpart"
if {[catch { create_hw_cfgmem -hw_device $dev $cfmpart } e]} {
    puts "FLASH_PROG_RESULT=CREATE_CFGMEM_FAIL: $e" ; error "create_hw_cfgmem failed"
}
set cfgmem [current_hw_cfgmem]
puts "FLASH_HW_CFGMEM=$cfgmem"

# ---- 编程选项（按任务要求逐条设置）-----------------------------------------
set_property PROGRAM.BLANK_CHECK 0 $cfgmem
set_property PROGRAM.ERASE       1 $cfgmem
set_property PROGRAM.CFG_PROGRAM 1 $cfgmem
set_property PROGRAM.VERIFY      1 $cfgmem
set_property PROGRAM.CHECKSUM    0 $cfgmem
set_property PROGRAM.ADDRESS_RANGE {use_file} $cfgmem
set_property PROGRAM.FILES  [list $mcsfile] $cfgmem
catch { set_property PROGRAM.PRM_FILE {} $cfgmem }
foreach p {PROGRAM.BLANK_CHECK PROGRAM.ERASE PROGRAM.CFG_PROGRAM PROGRAM.VERIFY PROGRAM.CHECKSUM} {
    catch { puts "FLASH_OPT $p=[get_property $p $cfgmem]" }
}

# ---- 擦除 + 编程 + 校验 -----------------------------------------------------
if {[catch { program_hw_cfgmem -hw_cfgmem $cfgmem } e]} {
    puts "FLASH_PROG_RESULT=PROGRAM_FAIL: $e"
    catch { close_hw_target } ; catch { close_hw_manager }
    error "program_hw_cfgmem failed"
}
puts "FLASH_PROG_RESULT=OK"
puts "FLASH_VERIFY=OK"

catch { close_hw_target }
catch { close_hw_manager }
puts "FLASH_DONE=1"
