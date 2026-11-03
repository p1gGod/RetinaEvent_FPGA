# EVIDENCE M4C — nn_top 顶层集成 + 动作字节（byte23 / TLV 0x92）回传 + act3 位流

ACT3_INTEG_OK=1
ACT3_RESOURCE_OK=1
ACT3_TB_REGRESSION_OK=1
ACT3_PORTMAP_OK=1
TIMINGFIX_B_OK=1

- 日期：2026-10-29
- 任务：task-20（M4c 顶层集成 + 两分类位流），构建 tag = act3
- 工具：Vivado 2020.2 / xc7a100tfgg484-2 / ModelSim SE 2020.4
- 说明：本证据记录 **act3 位流**（已由 Lead 于 23:32 烧板验证 DONE=1）。该位流中的
  act_state_cdc 是 M4b 版（电平保持）；后续 task-23（M4d）把该模块改为
  "空窗清零"，另见 EVIDENCE_M4D.md。本文件对应上板对照位流，
  build/variant_act3/** 保留不动。

## ACT3_INTEG_OK=1 — 完整构建

命令（在 E:/workspace/FPGA_Comp/retina_event 下，run_awake 包裹）：

```
RETE_TAG=act3
RETE_GENERICS=ETH_EN=1
pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/build_inproc.tcl -log build/act3_build.log \
  -journal build/act3_build.jou -tclargs --full
```

| 项 | 实测 |
|---|---|
| run_awake 退出码 | 0（日志：[run_awake_cmd] ... exit code = 0） |
| 构建结果 | INPROC_RESULT=OK / INPROC_DONE=1 |
| 位流（完整构建） | build/variant_act3/retina_event.bit = 2,757,099 B，md5 fb7038819a3f53845b3a46a1d85b93cb |
| 构建 ERROR 计数 | 0 |
| CRITICAL WARNING | 6 条日志行，去重后仅 2 个既有模块未例化：ila_sccb、ila_dbg（旧日志 fix4_baud_build.log 同样存在，非本次引入） |
| DRC | 0 Error；95 Warning（Violations found: 95；DPIP/DPOP/IOSR/PLCK/REQP/RPBF/RTSTAT 等既有项） |
| 初始时序（完整构建） | WNS −0.167 ns / TNS −0.486 ns / 5 failing endpoints / WHS +0.042 ns（eth_rxc，单条事件包长路径族） |
| 交付位流（物理复跑后） | build/variant_act3/retina_event.bit = 2,909,183 B，md5 ce8685419b95417c347fe5d3b31aa0f7 |
| 交付时序（物理复跑后） | WNS **+0.228 ns** / TNS 0.000 / 0 failing endpoints / WHS **+0.031 ns**（build/variant_act3/timing_deliver.rpt） |

> 时序结论（禁止表述为"时序通过"）：act3 完整构建本身 WNS −0.167 ns，经一次
> ExtraTimingOpt 物理复跑后交付净表 WNS **+0.228 ns**（含一次 ExtraTimingOpt 复跑）。
> 该位流已于 23:32 上板验证 DONE_PIN=1 / EOS=1，面板 /api/stats 恢复增长
> （pps 15,941、crcFail 0、badMagic 0、badLength 0）。板上统计随后暴露出 M4b
> "电平保持"语义无法按 VALID 上升沿计数的问题，已转 task-23（M4d）处理。

## ACT3_RESOURCE_OK=1 — 资源

基线（Lead 给定，M3 验收后）：LUT 18,973 / FF 11,296 / Slices 6,721 / BRAM 77.5 / DSP 6。

| 资源 | 基线 | act3 完整构建 | Δ | 预算 | 判定 |
|---|---:|---:|---:|---:|---|
| LUT | 18,973 | 20,501 | +1,528 | ≤ +8,000 | PASS |
| FF | 11,296 | 11,827 | +531 | ≤ +8,000 | PASS |
| Slices | 6,721 | 7,171 | +450 | ≤ +1,500 | PASS |
| BRAM Tile | 77.5 | 87 | +9.5 | ≤ +20 | PASS |
| DSP | 6 | 7 | +1 | ≤ +20 | PASS |

交付净表（ExtraTimingOpt 复跑，timing_b_util.rpt）：LUT 20,515 / FF 11,827 /
Slices 7,831 / BRAM Tile 87 / DSP 7 ⇒ Δ +1,542 / +531 / +1,110 / +9.5 / +1，
仍在预算内。

## ACT3_TB_REGRESSION_OK=1 — 13 个 TB 回归

命令（逐个）：`cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>`
日志：build/regress_m4c_final.log（2026-10-29 23:33–23:38）；判定：日志含
TEST_RESULT=PASS 且无 FAIL。

| # | TB | RC |
|---:|---|---:|
| 1 | tb_nn_feat | 0 |
| 2 | tb_nn_engine | 0 |
| 3 | tb_nn_top | 0 |
| 4 | tb_act3_hdr | 0 |
| 5 | tb_act3_tlv | 0 |
| 6 | tb_udp_merge | 0 |
| 7 | tb_wire_v3 | 0 |
| 8 | tb_downlink_cmd | 0 |
| 9 | tb_uart_baud | 0 |
| 10 | tb_uart_link | 0 |
| 11 | tb_stall_repro | 0 |
| 12 | tb_udp_mtu_cap | 0 |
| 13 | tb_top_retina_event | 0 |

13/13 RC=0。注：首次回归时 tb_top_retina_event 因 .f 未含 nn 源文件报
"Module 'nn_top' is not defined"；已在 sim/tb/tb_top_retina_event.f 增加
src/hdl/nn/nn_feat.v / nn_engine.v / nn_decide.v / nn_rom.v / nn_rom_data.v /
nn_top.v 六行（现 52 行），重跑 PASS。

两分类专项（tb_nn_engine / tb_nn_top）在 NUM_CLASSES=2 下：
- tb_nn_engine：E1_FC_L2_NEG_KEEP 打印 SKIP（class2 unused），其余 CHECK 全 PASS，TEST_RESULT=PASS；
- tb_nn_top：TEST_RESULT=PASS (31 checks)，含 T9_MIXED_MARGIN_2CLS、TB_PULSE2_CLASS(class1)、TF_BUSY_DUR_2cls。

## ACT3_PORTMAP_OK=1 — 接线表

### 1) u_nn_top 实例（src/hdl/top/top_retina_event.v:505-519）对 nn_top 签名（src/hdl/nn/nn_top.v:43-57）

| nn_top 端口（行号） | 方向/宽度 | top_retina_event.v 连接（行号/信号） | 下游去向 |
|---|---|---|---|
| clk_cam (43) | in 1 | clk_cam（:506） | 既有相机像素时钟域 |
| rst_n_cam (44) | in 1 | rst_n_cam（:507） | 相机域复位 |
| i_ev_valid (45) | in 1 | ev_valid（:508） | capture 事件流有效 |
| i_ev_x (46) | in 9 | ev_x（:509） | capture 事件 X |
| i_ev_y (47) | in 8 | ev_y（:510） | capture 事件 Y |
| i_ev_pol (48) | in 1 | ev_pol（:511） | capture 事件极性 |
| o_act_pulse (49) | out 1 | nn_act_pulse（:512）→ u_act_state_cdc.i_act_pulse（:608） | CDC 源域锁存/脉冲 |
| o_act_class (50) | out 2 | nn_act_class（:513）→ u_act_state_cdc.i_act_class（:609） | CDC 源域锁存 |
| o_act_conf (51) | out 5 | nn_act_conf（:514）→ u_act_state_cdc.i_act_conf（:610） | CDC 源域锁存 |
| o_dbg_win (52) | out 1 | 空接（:515） | 仅调试 |
| o_dbg_busy (53) | out 1 | 空接（:516） | 仅调试 |
| clk_200m (56) | in 1 | clk_200m（:517） | v2 单时钟保留、不使用 |
| rst_n_200m (57) | in 1 | rst_n_200m（:518） | 同上 |

顶层声明：:501-503 `wire nn_act_pulse; wire [1:0] nn_act_class; wire [4:0] nn_act_conf;`。

### 2) 唯一动作 CDC 实例（src/hdl/subsys/act_state_cdc.v，实例 :604-616）

| act_state_cdc 端口 | 连接 |
|---|---|
| clk_cam | clk_cam（:605） |
| rst_n_cam | rst_n_cam（:606） |
| i_act_pulse | nn_act_pulse（:608，来自 u_nn_top.o_act_pulse） |
| i_act_class | nn_act_class（:609） |
| i_act_conf | nn_act_conf（:610） |
| clk_eth | clk_eth（:611） |
| rst_n_eth | rst_n_eth（:612） |
| o_act_byte | act_byte_eth（:613；wire 声明 :602） |

### 3) 同一快照的两处下游（不重算、不另锁存）

| 下游 | 实例位置 | 连接 |
|---|---|---|
| event_sink → udp_merge（帧 byte23） | top :646 | .i_act_byte(act_byte_eth) |
| downlink_cmd（GET_STATUS TLV 0x92） | top :733 | .i_act_byte(act_byte_eth) |

### 4) 编译/elaboration 证据（ModelSim）

- 目录 build/sim/top_elab20，filelist 全绝对路径共 56 个 .v（src/hdl 54 + sim/models/clk_wiz_0_sim.v + bufg_sim.v）。
- `vlog -quiet -work work -f files.f` → rc=0。
- `vsim -c -voptargs=+acc -gSIM=1 -gUSE_DDR3=0 -gETH_EN=0 -gUART_EN=0 -do "quit -f" work.top_retina_event` → rc=0，Errors: 0，Warnings: 4（既有 event_sink o_ev_dbg_* 少接）；Loading work.top_retina_event / nn_top / act_state_cdc / event_sink / downlink_cmd 均出现。

## TIMINGFIX_B_OK=1 — 交付净表时序（Lead 指定物理变体）

- 问题：act3 完整构建 WNS −0.167 ns（eth_rxc，5 个失败端点），失败路径为
  udp_merge 事件包长路径族（ev_rec_cnt*/flush_cnt* → o_tx_len_reg[9..14]，
  13~15 级逻辑，logic 3.45 ns + route 4.68 ns）。
- 方法（build/act3_timingfix_b.tcl，完全按 Lead m00693）：
  `open_checkpoint post_synth.dcp → opt_design → place_design -directive ExtraTimingOpt
  → phys_opt_design（默认，post-place）→ route_design（默认，无 Explore/-tns_cleanup）
  → report_timing_summary`，达标才 `write_bitstream`。
- 结果（build/variant_act3/timing_b.rpt / timing_deliver.rpt）：

| 指标 | 值 |
|---|---|
| WNS | **+0.228 ns** |
| TNS | 0.000 ns（失败端点 0） |
| WHS | **+0.031 ns**（THS 失败 0） |
| 总端点 | 76,788（建立）/ 76,765（保持），全设计 0 违例 |

- 交付物：build/variant_act3/retina_event.bit = 2,909,183 B，md5 ce8685419b95417c347fe5d3b31aa0f7；
  timing_deliver.rpt；构建日志 build/act3_timingfix_b.log（TFB_DONE=1，TIMINGFIX_B_OK=1）。
- 历史对照（不作为交付）：默认流程 WNS −0.167；post-route AggressiveExplore 零收益；
  route_design -directive Explore 更差（WNS −0.392）。

## 附：103 B GET_STATUS ACK 构成（M4b 契约，act3 已验证）

24 B v3 头 + 6 B 控制头 + 71 B TLV + 2 B CRC16 = 103 B。
TLV 从 byte30 起；TLV 0x92（tag/len/value）位于 [98]/[99]/[100]；CRC16 覆盖
[0..100]，结果放 [101]/[102]。tb_act3_tlv 实测：clen=71、total=103、
tail=92 01 <byte23>、CRC 自洽；无动作时 0x92 的 value=0x00。
数据帧 byte23 与 TLV 0x92 同源（同一个 act_state_cdc 锁存值）。

M4C_OK=1
