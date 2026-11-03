ACT3_IDLE_CLR_OK=1

# EVIDENCE_M4D — task-23 / M4d 动作字节空窗清零 + act3b 交付

- 日期：2026-10-29（本机时区 Asia/Shanghai）
- 工程：E:/workspace/FPGA_Comp/retina_event（Vivado 2020.2 / xc7a100tfgg484-2）
- 范围：仅 act_state_cdc.v 加空窗清零；位域/TLV/包长/CRC 不变；未改 udp_merge.v / downlink_cmd.v / event_sink.v / top_retina_event.v。
- 判据修订（Lead m00913）：原 (d) 的 "bit >= 2,700,000 B" 是防止写截断的人为下限，不作为工程判据；改为 d1~d4 四项可验证条件（见 §4）。本文件其余 (a)(b)(c)(e)(f) 不变。
- 首行 ACT3_IDLE_CLR_OK=1 依据本文件 §1~§6；末行 M4D_OK=1。

## 0. 改动清单

src/hdl/subsys/act_state_cdc.v（唯一 RTL 改动）：
- 新增参数 parameter integer ACT_IDLE_CYC = 50_000_000（50 MHz 下 1.0 s）；端口未变。
- 新增 26 位空窗计数器 idle_cnt；源域 always 块：
  - i_act_pulse 当拍：act_byte_s <= {1'b1,i_act_conf,i_act_class}；act_tog_s <= ~act_tog_s；idle_cnt <= 0；
  - idle_cnt == ACT_IDLE_CYC-1 且 act_byte_s != 0：act_byte_s <= 8'h00；act_tog_s <= ~act_tog_s（只翻一次）；idle_cnt 饱和保持；
  - 其余：idle_cnt <= idle_cnt + 1。
- 语义 = "最近一次判定 + 保持到空窗超时"；清零是慢变信号，cdc_tog_word(2 级同步 + SETTLE=3) 过域安全。
- 头注释同步更新（VALID 上升沿计数、位域/TLV/包长/CRC 不受影响）。

TB 新增：sim/tb/tb_act3_idleclr.v、sim/tb/tb_act3_idleclr.f（依赖 act_state_cdc.v + cdc_tog_word.v）。

## 1. (a) 新 TB tb_act3_idleclr —— TEST_RESULT=PASS (22 checks)，exit 0

命令：
  cd /e/workspace/FPGA_Comp/retina_event
  pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_idleclr
结果：run_sim 退出码 0（build/tb_act3_idleclr.run.log 内 IDLECLR_EXIT=0），日志 build/sim/tb_act3_idleclr/vsim.log，Elapsed 2:39。

CHECK 明细（全 PASS）：
  C1_reset_byte00            byte23=00
  C1_src_byte00              byte23=00（源域）
  C2_byte23_C5_class1_conf17 byte23=c5  （class=1,conf=17 ⇒ 0x80|(17<<2)|1 = 0xC5）
  C2_one_change_after_pulse  val=1
  C3_src_hold_before_idle    byte23=c5
  C3_idle_cnt_at_cyc_m1      val=49999999（ACT_IDLE_CYC-1=49,999,999 拍仍保持）
  C3_out_hold_before_idle    byte23=c5（过域后仍 c5）
  C4_cycle_since_pulse_CYC   val=50000000
  C4_src_clear_on_cycle      byte23=00（第 ACT_IDLE_CYC 拍清零）
  C4_out_clear               byte23=00
  C4_one_change_only         val=2（c5→00 只一次有效变化）
  C5_byte23_95_class1_conf5  byte23=95（0x80|(5<<2)|1 = 0x95）
  C5_one_change_after_pulse  val=3
  C6_no_clear_before_idle    byte23=95
  C6_counter_reset_on_pulse  val=1
  C6_hold_after_reset        byte23=95
  C6_no_extra_transition     val=3
  C7_first_byte23_A6         byte23=a6（class=2,conf=9）
  C7_first_one_change        val=4
  C7_reset_byte23_A6         byte23=a6（0.9 s 处再 pulse，计时重置）
  C7_hold_after_1s_from_first byte23=a6（首次 pulse 后 1.0 s 仍保持，证明重置而非周期清零）
  C7_no_extra_transition     val=4
TB 末尾：TEST_RESULT=PASS (22 checks)，Errors: 0, Warnings: 0。

过域监视（tb INFO）：o_act_byte changed c5 -> 00 @1000000404000；00 -> 95 @1000000660000；a6 段无额外跳变。

## 2. (b) 既有 13 TB 回归 —— 13/13 RC=0

命令：逐个 pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>；汇总日志 build/regress_m4d.log（末尾 REGRESS_DONE）。顺序与结果：

| # | TB | RC | TEST_RESULT |
|---|----|----|-------------|
| 1 | tb_act3_hdr | 0 | PASS |
| 2 | tb_act3_tlv | 0 | PASS |
| 3 | tb_nn_feat | 0 | PASS |
| 4 | tb_nn_engine | 0 | PASS |
| 5 | tb_nn_top | 0 | PASS |
| 6 | tb_udp_merge | 0 | PASS |
| 7 | tb_wire_v3 | 0 | PASS |
| 8 | tb_downlink_cmd | 0 | PASS |
| 9 | tb_uart_baud | 0 | PASS |
| 10 | tb_uart_link | 0 | PASS |
| 11 | tb_stall_repro | 0 | PASS |
| 12 | tb_udp_mtu_cap | 0 | PASS |
| 13 | tb_top_retina_event | 0 | PASS |

## 3. (c) TOP_ELAB_OK 保持 —— Errors: 0

目录 build/sim/top_elab23（files.f 为 src/hdl 全树 54 个 .v + sim/models 2 个 = 56 个绝对路径）：
  vlog -quiet -work work -f files.f                    → VLOG_RC=0
  vsim -c -voptargs=+acc -gSIM=1 -gUSE_DDR3=0 -gETH_EN=0 -gUART_EN=0 -do "quit -f" work.top_retina_event
                                                        → VSIM_RC=0，Errors: 0，Warnings: 4（既有 event_sink o_ev_dbg_* 少接），Loading work.top_retina_event(fast) 出现。
Warnings=4 为历史既有，与本次改动无关（未新增端口）。

## 4. (d) 构建与位流 —— 判据修订后 d1~d4

构建命令（run_awake 包裹，RETE_TAG=act3b，RETE_GENERICS="ETH_EN=1"）：
  cd E:/workspace/FPGA_Comp/retina_event
  pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
    E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source tool/build_inproc.tcl \
    -log build/act3b_build.log -journal build/act3b_build.jou -tclargs --full
结果：run_awake 退出码 0（build/act3b_build.console.log 末行 ACT3B_EXIT=0）；INPROC_RESULT=OK；INPROC_DONE=1；构建日志 ^ERROR: 计数 0；CRITICAL WARNING 6 条（去重后仅既有 ila_sccb / ila_dbg 未例化，历史遗留）。

d1) write_bitstream completed successfully（日志行）：
  build/act3b_build.log:7503  Writing bitstream E:/workspace/FPGA_Comp/build/variant_act3b/retina_event.bit...
  build/act3b_build.log:7504  INFO: [Vivado 12-1842] Bitgen Completed Successfully.
  build/act3b_build.log:7507  write_bitstream completed successfully
  交付流（同一 netlist 重新 place/route 后）build/act3b_deliver.log:882-886 同样三行齐全（Writing bitstream .../Bitgen Completed Successfully./write_bitstream completed successfully）。
d2) DRC 0 Error：build/variant_act3b/inproc_drc.rpt 与 timing_deliver_route_drc.rpt 均为 "Violations found: 95"（全部 warning；Error 计数 0）。
d3) 位流与 md5：
  路径：build/variant_act3b/retina_event.bit
  大小：2,675,095 B（COMPRESS=TRUE，完整位流，非截断）
  md5：**361713e0a455e5c1436365fe39dbd821**
  说明：全构建直接产物为同尺寸 2,675,095 B、md5 bee4517b84c2651dd82d1d6b9b0fa318；随后按 (e) 同配方复跑默认 place/route 交付流，写 bit 并覆盖为当前文件（md5 361713e0...），其 timing 报告为 timing_deliver.rpt。两种流程字节数完全一致 ⇒ 尺寸差异不是流程/压缩参数造成，而是 netlist 压缩率；act3 历史位流 2,757,099 / 2,909,183 B 同样证明尺寸不可作有效性判据。
  判据修订备注（Lead m00913）：原 ">= 2,700,000 B" 撤销，改为 d1/d2/d3/d4 四项。
d4) 上板（Lead 验证，2026-10-29 23:57，回填）：
  位流：E:/workspace/FPGA_Comp/build/variant_act3b/retina_event.bit，2,675,095 B
  烧前/烧后 md5 一致：**361713e0a455e5c1436365fe39dbd821**（烧前即 d3 值，烧后复核一致）
  烧写工具：temp_test/prog_bit.tcl，JTAG 6 MHz，目标 localhost:3121/xilinx_tcf/Digilent/210512180081（xc7a100t_0）
  结果：**End of startup status: HIGH / DONE_PIN=1 / EOS=1 / PROG_RESULT=OK**；Vivado 退出码 0
  烧后功能：网口恢复推流（旧面板 /api/stats 实测 5 s 内 80,117 包 / 102,549,915 B、frameIdx 147→280、crcFail=0、badMagic=0、badLength=0）⇒ 新位流在真机跑通。

## 5. (e) 时序 —— 交付 netlist WNS +0.125 / TNS 0 / WHS +0.034

交付流（build/act3b_deliver.tcl，与 build_inproc 相同的默认实现流程，post_synth.dcp 重跑）：
  open_checkpoint build/variant_act3b/post_synth.dcp → opt_design → place_design → route_design → report_timing_summary
  报告 build/variant_act3b/timing_deliver.rpt：
    WNS +0.125 ns / TNS 0.000 ns / TNS Failing Endpoints 0 / 总端点 76,849
    WHS +0.034 ns / THS 0.000 / THS Failing 0 / 总端点 76,826
    WPWS 0.000 / TPWS Failing 0
  与全构建 inproc_timing.rpt 数值一致（WNS +0.125 / WHS +0.034 / fail 0）。
  交付流退出码：Vivado exit 0（build/act3b_deliver.console.log 末行 ACT3B_DELIVER_EXIT=0），标记 ACT3B_DELIVER_OK=1。

负面数据（另一种布局变体，不作交付）：
  build/act3b_timingfix.tcl（opt_design → place_design -directive ExtraTimingOpt → phys_opt_design → route_design 默认）
  → build/variant_act3b/timing_b.rpt：WNS **-0.032** / TNS -0.032 / fail 1 / WHS +0.036。
  失败路径：u_event_sink/u_udp_merge/ev_rec_cnt0_reg[3]/C → o_tx_len_reg[12]/D（Path Group eth_rxc，Requirement 8.000 ns）。
  按判据未写 bit（TFB_PASS=0 / TFB_NO_BIT=1 / TIMINGFIX_B_OK=0）。该链即 act3 时 WNS -0.167 的同一条链，对布局极其敏感：ExtraTimingOpt 布局反而更差，默认布局 +0.125 达标。

## 6. (f) 资源 —— 全部预算内

基线（M3 验收后、M4 前）：LUT 18,973 / FF 11,296 / Slices 6,721 / BRAM 77.5 / DSP 6。
act3b 实测（build/variant_act3b/inproc_util_impl.rpt；交付流 timing_deliver_route_util.rpt 同值）：

| 资源 | 实测 | 基线 | Δ | 预算 | 结论 |
|------|------|------|-----|------|------|
| LUT | 20,545 | 18,973 | +1,572 | +8,000 | OK |
| FF | 11,848 | 11,296 | +552 | +8,000 | OK |
| Slices | 7,326 | 6,721 | +605 | +1,500 | OK |
| BRAM Tile | 87 | 77.5 | +9.5 | +20 | OK |
| DSP | 7 | 6 | +1 | +20 | OK |

## 7. 兼容性/不变项核对

- byte23 位域与 0x92 TLV len=1 不变；TLV/CTRL 长度逻辑未动（GET_STATUS 仍 71 B、全包 103 B）。
- udp_merge.v / downlink_cmd.v / event_sink.v / top_retina_event.v 本次零改动（git 不写；可用改动清单 §0 对照）。
- 清零只发生在 act_byte_s 寄存器（源域），不会引入新 CDC 路径；清零后 byte23=0x00（VALID=0）符合契约"未启用 0x00"。

### 7.1 prj/retina_event.xpr 工作区改动定性（非手工编辑）

git status 显示 M build/build_inproc_v7.tcl（mtime 2026-10-29 23:45:47，act3b 构建窗口内；diff 125 insertions / 80 deletions）。逐项核实：

- <File Path> 集合与 HEAD 对比：+8 / -1（其余 diff 为同一批 source 条目的顺序重排）
  + $PPRDIR/../src/hdl/subsys/act_state_cdc.v
  + $PPRDIR/../src/hdl/hud/hud_status.v
  + $PPRDIR/../src/hdl/nn/nn_top.v
  + $PPRDIR/../src/hdl/nn/nn_feat.v
  + $PPRDIR/../src/hdl/nn/nn_engine.v
  + $PPRDIR/../src/hdl/nn/nn_decide.v
  + $PPRDIR/../src/hdl/nn/nn_rom.v
  + $PPRDIR/../src/hdl/nn/nn_rom_data.v
  - $PSRCDIR/sources_1/ip/mig_7series_0_3/mig_a.prj（IP 文件列表项，Vivado 重排时由现有 mig_b.prj 取代）
- sources_1 <Config> 少 5 行：TopRTLFile 与 Generic OVL_TIMING_EN/OVL_SCAN_SEL/OVL_HTS/OVL_VTS（TopModule 仍为 top_retina_event）。
- 定性：这是被批准构建脚本 tool/build_inproc.tcl 的既有副作用，不是手工改 xpr。脚本 :101-108 remove_files/add_files 重建 src/hdl+ref_original 列表并补加新 RTL；:131 set_property generic $generics 把 fileset generic 设为本次 RETE_GENERICS（本次 ETH_EN=1，故旧 OVL_* 条目被清）；脚本 :119-122 自己就注明"会顺手改坏工程设置"。全部 8 个新增条目对应仓库中真实存在的文件（act_state_cdc.v 23:35 / hud_status.v 10-17 / nn_*.v 本次两分类改动）。
- 影响：构建/仿真不读 xpr 的这份列表（每次构建由 glob 重建 + set_property top_file :108），act3b 位流已上板 DONE=1 验证；工程 GUI 打开时按列表可见新增 RTL。OVL_* 是 overlay 时序实验用 generic（ov5640_timing_ovr.v / display_path.v 使用，默认 0=旁路），本次交付位流按默认旁路运行，未使用这些覆盖值；是否恢复工程里的 OVL_* 条目由 Lead 决定。
- 处置：按 Lead m00929，属"来源文件条目自动补充"一类，已在证据注明；本任务禁 git 写，不做回滚。若需恢复工程设置，请 Lead 在收尾 checkpoint 授权单独 git checkout -- build/build_inproc_v7.tcl（下次脚本构建仍会再次重写该文件）。

## 8. 结论

ACT3_IDLE_CLR_OK=1：
(a) tb_act3_idleclr PASS (22 checks) exit 0；
(b) 13/13 既有 TB RC=0；
(c) TOP_ELAB Errors 0；
(d) d1 write_bitstream completed successfully / d2 DRC 0 Error / d3 md5 361713e0a455e5c1436365fe39dbd821（2,675,095 B，COMPRESS=TRUE 非截断）/ d4 上板 DONE_PIN=1 / EOS=1 / End of startup status HIGH / PROG_RESULT=OK（烧前烧后 md5 一致；烧后 crcFail=0）；
(e) 交付 netlist WNS +0.125 / TNS 0 / WHS +0.034；ExtraTimingOpt 负面数据 WNS -0.032 已记录；
(f) ΔLUT +1,572 / ΔFF +552 / ΔSlices +605 / ΔBRAM +9.5 / ΔDSP +1，全在预算内。

M4D_OK=1
