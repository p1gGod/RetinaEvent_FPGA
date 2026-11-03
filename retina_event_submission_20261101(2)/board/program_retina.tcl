# =============================================================================
# program_retina.tcl —— JTAG 烧录 retina_event 比特流（Vivado 2020.2 / hw_server）
#
# 用法（工程根 = retina_event）：
#   vivado.bat -mode batch -source tool\program_retina.tcl
#              -log tool\program_retina.log -tclargs build\retina_event.bit
#   （-tclargs 放最后；不带参数时默认用 build\retina_event.bit）
#
# ⚠️ 本板两个实测坑（事实 H43 / traps §16）：
#   1. 默认 JTAG 频率在本板（板载 FTDI FT2232H）**太高**，program_hw_devices 会报
#      [Xicom 50-38] Reading intermittently wrong data from core /
#      "is not a valid CseXsdb Slave core" / [Labtools 27-3176]。
#      ⇒ 必须 set_property PARAM.FREQUENCY 6000000。降到 6 MHz 后一次成功
#        （End of startup status: HIGH）。只读的 JTAG 链探测在默认频率下是正常的，
#        所以这个错误**不是板子问题、更不是 RTL 问题**，别去改设计。
#   2. 不要用 set_property PROGRAM.FILES —— 那会报 [Labtools 27-2151] No bitstream specified。
#      正确做法是 create_hw_bitstream -hw_device $dev <path.bit> 再 program_hw_devices $dev。
#
# 判定：只看行首锚定的 ASCII 标记 PROG_RESULT=OK（不要 grep 中文日志）。
# =============================================================================

set bitfile ""
if {[llength $argv] >= 1} { set bitfile [lindex $argv 0] }

set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
if {$bitfile eq ""} { set bitfile [file join $root build retina_event.bit] } else { set bitfile [file normalize $bitfile] }

puts "PROG_BIT=$bitfile"
if {![file exists $bitfile]} {
    puts "PROG_RESULT=NO_BITFILE"
    error "bitfile not found: $bitfile"
}
puts "PROG_BIT_BYTES=[file size $bitfile]"

# ---- 连接硬件服务器 ---------------------------------------------------------
open_hw_manager
if {[catch {connect_hw_server -url localhost:3121} err]} {
    puts "PROG_RESULT=HW_SERVER_FAIL: $err"
    error "hw_server connect failed"
}

set tgt [lindex [get_hw_targets] 0]
if {$tgt eq ""} {
    puts "PROG_RESULT=NO_TARGET  (板子上电了吗？用数据线而不是充电线？jtagserver.exe 是否占用 FTDI？)"
    catch { close_hw_manager }
    error "no hw target"
}
puts "PROG_TARGET=$tgt"
current_hw_target $tgt

# ---- ★ JTAG 降频到 6 MHz（本板必须）-----------------------------------------
if {[catch { set_property PARAM.FREQUENCY 6000000 $tgt } err]} {
    puts "PROG_FREQ_SET_FAIL=$err"
} else {
    puts "PROG_FREQ=6000000"
}

if {[catch { open_hw_target } err]} {
    puts "PROG_RESULT=OPEN_TARGET_FAIL: $err"
    catch { close_hw_manager }
    error "open_hw_target failed"
}

set dev [lindex [get_hw_devices] 0]
if {$dev eq ""} {
    puts "PROG_RESULT=NO_DEVICE"
    catch { close_hw_target }
    catch { close_hw_manager }
    error "no hw device"
}
puts "PROG_DEVICE=$dev"
# ⚠️ 集成修复（Lead，实测）：本机 `get_property REGISTER.IDCODE` 会抛
#   `[Labtoolstcl 44-56] hw_device [xc7a100t_0] does not have a [REGISTER.IDCODE] property`
#   —— 这只是**取属性**失败，**不影响烧录**（之前的 JTAG 探测已经列到了 xc7a100t_0）。
#   首版没把它包在 catch 里，导致脚本在这一行直接中止、根本没走到 program_hw_devices。
catch { puts "PROG_IDCODE=[get_property REGISTER.IDCODE $dev]" }
current_hw_device $dev
catch { refresh_hw_device -update_hw_probes false $dev }
catch { reset_hw_device $dev }

# ---- 创建 bitstream 句柄并烧录（**不要**用 set_property PROGRAM.FILES）-------
if {[catch { create_hw_bitstream -hw_device $dev $bitfile } err]} {
    puts "PROG_RESULT=CREATE_BITSTREAM_FAIL: $err"
    catch { close_hw_target }
    catch { close_hw_manager }
    error "create_hw_bitstream failed"
}
puts "PROG_BITSTREAM_CREATED=1"

if {[catch { program_hw_devices $dev } err]} {
    puts "PROG_RESULT=PROGRAM_FAIL: $err"
    puts "PROG_HINT=若是 [Xicom 50-38] / [Labtools 27-3176]，先杀残留 hw_server/cs_server 再重试；本脚本已把频率降到 6 MHz"
    catch { close_hw_target }
    catch { close_hw_manager }
    error "program_hw_devices failed"
}

refresh_hw_device -update_hw_probes false $dev
# ⚠️ 集成修复（Lead，实测）：本机 `REGISTER.CONFIG_STATUS.BITSTREAM_DONE` 同样会抛
#   `[Labtoolstcl 44-56] ... does not have a [REGISTER.CONFIG_STATUS.BITSTREAM_DONE] property`。
#   首版没包 catch ⇒ **已经烧成功（End of startup status: HIGH）却在最后一行崩掉、退出码 1**，
#   很容易被误判成"烧录失败"。真正的成功判据是 `[Labtools 27-3164] End of startup status: HIGH`。
catch { puts "PROG_BITSTREAM_DONE=[get_property REGISTER.CONFIG_STATUS.BITSTREAM_DONE $dev]" }

catch { close_hw_target }
catch { close_hw_manager }
puts "PROG_RESULT=OK"
