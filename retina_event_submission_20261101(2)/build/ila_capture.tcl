# ila_capture.tcl -- capture BOTH debug ILAs from the ILA_EN=1 build.
#
# Two captures per ILA, separated by a delay, so that monotonic counters
# (stat_fcnt_lcd on the LCD side) prove the pipeline is actually advancing rather
# than showing one frozen snapshot.
#
# ⚠️ The board's JTAG must be dropped to 6 MHz (same reason as programming: the
#    default frequency intermittently corrupts reads on this FTDI FT2232H).
# ⚠️ PROBES.FILE / FULL_PROBES.FILE must point at the .ltx written next to the
#    bitstream by write_bitstream; without it get_hw_ilas returns nothing.
#
# KEEP THIS FILE WITHOUT A BOM.
# Usage:
#   vivado.bat -mode batch -nolog -nojournal -source tool\ila_capture.tcl ^
#       -log tool\ila_capture.log -tclargs build\variant_ila\retina_event.ltx build\variant_ila

set ltx    "E:/workspace/FPGA_Comp/build/variant_ila/retina_event.ltx"
set outdir "E:/workspace/FPGA_Comp/build/variant_ila"
if {[llength $argv] >= 1} { set ltx    [lindex $argv 0] }
if {[llength $argv] >= 2} { set outdir [lindex $argv 1] }

puts "ILACAP_LTX=$ltx"
puts "ILACAP_OUTDIR=$outdir"

open_hw_manager
connect_hw_server -url localhost:3121
set tgt [lindex [get_hw_targets] 0]
current_hw_target $tgt
catch { set_property PARAM.FREQUENCY 6000000 $tgt }
open_hw_target

set dev [lindex [get_hw_devices] 0]
current_hw_device $dev
refresh_hw_device -update_hw_probes false $dev

# ⚠️ 实测 2026-10-06：`write_bitstream` 在本进程内流程下**没有**顺手写出 .ltx
#    （设计里确实有 dbg_hub 与两个 ILA）。所以 .ltx 是**可选**的：
#    有就用（探针名字/位宽更准），没有就靠硬件管理器**自动探测**调试核 ——
#    位宽来自 ILA 核自身配置，抓波形照样可行。
if {[file exists $ltx]} {
    set_property PROBES.FILE      $ltx $dev
    set_property FULL_PROBES.FILE $ltx $dev
    refresh_hw_device $dev
    puts "ILACAP_PROBES_FILE=used"
} else {
    puts "ILACAP_PROBES_FILE=absent (falling back to auto-detection)"
    refresh_hw_device $dev
}

set ilas [get_hw_ilas]
puts "ILACAP_NILA=[llength $ilas]"
if {[llength $ilas] == 0} {
    puts "ILACAP_RESULT=NO_ILA"
    catch { close_hw_target }
    catch { close_hw_manager }
    error "no hw_ila found (bitstream has no debug cores?)"
}

proc cap_one {ila tag} {
    reset_hw_ila $ila
    run_hw_ila $ila
    wait_on_hw_ila $ila
    set d [upload_hw_ila_data $ila]
    set f [format "%s/ila_%s.csv" $::outdir $tag]
    write_hw_ila_data -csv_file $f -force $d
    puts "ILACAP_WROTE=$f"
}

set n 0
foreach ila $ilas {
    incr n
    # Identify by the clock of the core: the camera core runs on cam_pclk, the
    # display core on clk_lcd.
    set ck "-"
    catch { set ck [get_property CLK $ila] }
    puts "ILACAP_ILA_$n=$ila CLK=$ck"
    foreach p [get_hw_probes -of_objects $ila] {
        puts "ILACAP_PROBE_$n [get_property NAME $p] width=[get_property WIDTH $p]"
    }

    # Trigger on the "active video" probe of whichever core this is.
    # ⚠️ MEASURED: with the .ltx loaded, Vivado keeps the ORIGINAL net names, so
    #    `get_hw_probes -filter {NAME =~ *probe0*}` matches nothing and no trigger
    #    is armed — the free-running window then often lands in blanking (observed:
    #    cam_href high 0/4096, lcd_de high 0/4096) which looks like "the display is
    #    dead". Trigger on the real names instead.
    set armed 0
    foreach nm {cam_href_IBUF lcd_de_OBUF} {
        set pp [get_hw_probes -quiet -of_objects $ila -filter "NAME =~ *$nm*"]
        if {$pp ne ""} {
            if {[catch { set_property TRIGGER_COMPARE_VALUE eq1'b1 $pp } e]} {
                puts "ILACAP_TRIG_WARN=$e"
            } else {
                puts "ILACAP_TRIG=$pp"
                set armed 1
            }
        }
    }
    if {!$armed} { puts "ILACAP_TRIG=none (free-running capture)" }

    cap_one $ila "cap${n}_a"
    after 1500
    cap_one $ila "cap${n}_b"
}

close_hw_target
close_hw_manager
puts "ILACAP_RESULT=OK"
exit 0
