# =============================================================================
# flash_detect.tcl —— 只读探测：判定板上 SPI 配置 Flash 的型号与容量
# 用法: vivado.bat -mode batch -source <this> -log <log> -nojournal
# 判据: 行首锚定 ASCII 标记 FLASH_DETECT_RESULT=...
# =============================================================================
open_hw_manager
connect_hw_server -url localhost:3121
set tgt [lindex [get_hw_targets] 0]
puts "FD_TARGET=$tgt"
current_hw_target $tgt
catch { set_property PARAM.FREQUENCY 6000000 $tgt }
open_hw_target
set dev [lindex [get_hw_devices] 0]
puts "FD_DEVICE=$dev"
current_hw_device $dev
catch { refresh_hw_device -update_hw_probes false $dev }

puts "FD_DEV_PART=[get_property PART $dev]"

# --- 1) 器件上所有寄存器组属性（原文转储） ---
foreach p [lsort [list_property $dev]] {
    if {[string match "REGISTER*" $p]} {
        if {[catch { set v [get_property $p $dev] } e]} {
            puts "FD_PROP $p = <ERR: $e>"
        } else {
            puts "FD_PROP $p = $v"
        }
    }
}

# --- 2) get_cfgmem_parts：本机 Vivado 支持的配置存储器全集 ---
if {[catch { set allparts [get_cfgmem_parts] } e]} {
    puts "FD_CFGMEM_ERR=$e"
} else {
    puts "FD_CFGMEM_TOTAL=[llength $allparts]"
    foreach cp $allparts {
        set nm [get_property NAME $cp]
        if {[string match -nocase "*n25q*" $nm] || [string match -nocase "*m25p*" $nm] || [string match -nocase "*s25fl*" $nm] || [string match -nocase "*w25q*" $nm]} {
            puts "FD_CFGMEM_PART=$nm | SIZE=[get_property SIZE $cp] Mb | INTERFACE=[get_property INTERFACE $cp] | MANUF=[get_property MANUFACTURER $cp] | TYPE=[get_property TYPE $cp]"
        }
    }
    # 128 Mbit / SPI x4 候选
    puts "FD_CANDIDATES_128Mbit_SPIx4:"
    foreach cp $allparts {
        set nm [get_property NAME $cp]
        if {[string match -nocase "*128*" $nm] && [string match -nocase "*spi*" $nm]} {
            puts "FD_128=$nm | [get_property SIZE $cp] Mb | [get_property INTERFACE $cp]"
        }
    }
}

catch { close_hw_target }
catch { close_hw_manager }
puts "FLASH_DETECT_RESULT=DONE"
