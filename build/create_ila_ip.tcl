# create_ila_ip.tcl -- create the debug ILA IP used by top_retina_event's
#                      `generate if (ILA_EN != 0)` block.
#
# WHY TWO INSTANCES OF ONE IP: the camera side must be clocked by cam_pclk and the
# display side by clk_lcd; an ILA has exactly one clock. Two instances of the SAME
# IP keep the .xci count at one (probe widths must therefore be identical).
#
# Probe map (same for both instances; widths 1,1,8,16,16,16,1,8 = 67 bits):
#   probe0 1   cam: cam_href     | lcd: lcd_de
#   probe1 1   cam: cam_vsync    | lcd: lcd_vs
#   probe2 8   cam: cam_data     | lcd: lcd_rgb[23:16]
#   probe3 16  cam: dbg_cnt200   | lcd: stat_fcnt_lcd[15:0]
#   probe4 16  cam: 0            | lcd: {8'd0, lcd_rgb[7:0]}
#   probe5 16  cam: 0            | lcd: stat_ev_pf_lcd[15:0]
#   probe6 1   cam: 0            | lcd: eth_tx_ctl
#   probe7 8   cam: 0            | lcd: {7'd0, lcd_hs}
#
# KEEP THIS FILE WITHOUT A BOM.
# Usage: vivado.bat -mode batch -nolog -nojournal -source tool\create_ila_ip.tcl -log tool\create_ila_ip.log

set root   "E:/workspace/FPGA_Comp/retina_event"
set prj    "$root/prj/retina_event.xpr"
set ipdir  "$root/prj/retina_event.srcs/sources_1/ip"

if {[catch {

    open_project $prj
    puts "ILA_IP_STEP=open_project"

    if {[llength [get_ips -quiet ila_dbg]] == 0} {
        create_ip -name ila -vendor xilinx.com -library ip -version 6.2 \
                  -module_name ila_dbg -dir $ipdir
        puts "ILA_IP_CREATED=1"
    } else {
        puts "ILA_IP_CREATED=0 (already present)"
    }

    set_property -dict [list \
        CONFIG.C_NUM_OF_PROBES {8} \
        CONFIG.C_PROBE0_WIDTH  {1}  \
        CONFIG.C_PROBE1_WIDTH  {1}  \
        CONFIG.C_PROBE2_WIDTH  {8}  \
        CONFIG.C_PROBE3_WIDTH  {16} \
        CONFIG.C_PROBE4_WIDTH  {16} \
        CONFIG.C_PROBE5_WIDTH  {16} \
        CONFIG.C_PROBE6_WIDTH  {1}  \
        CONFIG.C_PROBE7_WIDTH  {8}  \
        CONFIG.C_DATA_DEPTH    {4096} \
    ] [get_ips ila_dbg]

    # ---- ★ 必须关掉 OOC 综合（实测 2026-10-06）--------------------------------
    #   ILA 默认带 `ila_dbg_ooc.xdc` ⇒ 工程流会给它建一个 **OOC 综合 run**。
    #   本工程的构建走**进程内** `synth_design`（`tool/build_inproc.tcl`），
    #   不会去跑那个 OOC run ⇒ 综合报
    #       ERROR: [Synth 8-439] module 'ila_dbg' not found
    #   —— 与事实 H38 / 坑 10 的 MIG 是同一类问题。
    #   解法与 MIG 一致：`generate_synth_checkpoint false` ⇒ 该 IP 改为**全局
    #   （in-context）综合**，进程内流程就能看到它的网表。
    if {[catch { set_property generate_synth_checkpoint false [get_files ila_dbg.xci] } err]} {
        puts "ILA_IP_OOC_SET_WARN=$err"
    }
    foreach ip [get_ips -quiet] {
        set f [get_files -quiet -of_objects $ip]
        set g "-"
        catch { set g [get_property generate_synth_checkpoint $f] }
        puts "ILA_IP_OOC name=[get_property NAME $ip] generate_synth_checkpoint=$g"
    }

    generate_target all [get_ips ila_dbg]
    puts "ILA_IP_STEP=generate_target"

    set ip [get_ips ila_dbg]
    puts "ILA_IP_NAME=[get_property IPDEF $ip]"
    puts "ILA_IP_DEPTH=[get_property CONFIG.C_DATA_DEPTH $ip]"
    puts "ILA_IP_NPROBES=[get_property CONFIG.C_NUM_OF_PROBES $ip]"
    puts "ILA_IP_RESULT=OK"
    close_project

} err]} {
    puts "ILA_IP_ERROR=$err"
    puts "ILA_IP_RESULT=FAILED"
    catch { close_project }
    exit 1
}
exit 0
