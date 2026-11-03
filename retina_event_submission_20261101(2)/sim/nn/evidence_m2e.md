ROM_SWAP_OK=1
TB_REGRESS_OK=1
SYNTH_ACT3C_OK=1

# EVIDENCE_M2E — v5 两分类 ROM 接入 + act3c 位流（task-34 / M2e）

日期：2026-10-30（Asia/Shanghai）
产物目录：E:/workspace/FPGA_Comp/build/variant_act3c/
结论：三项判据全部通过；交付位流 build/variant_act3c/retina_event.bit（2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a），**未烧板**（Lead 决定时机）。

## 0. 变更清单

| # | 文件 | 变更 | 说明 |
|---|------|------|------|
| 1 | src/hdl/nn/nn_rom_data.v | 整文件替换 | 与 nn/out_v5/nn_rom_data_2cls.v 字节相同（cpy 后 cmp 一致）。191,933 B，md5 9406a8900640931a51e4f4ed09a259ca。模块名 nn_rom_data、端口 (o_dout/clk/i_addr[12:0])、reg [31:0] rom [0:5475]、总字数 5476、13 位地址均不变；文件头 layout 注释与 v4 逐行一致。 |
| 2 | src/hdl/nn/nn_cfg.vh | **未改** | NN_NUM_CLASSES 早就是 2（HEAD 状态，非本任务改动）；ROM 布局宏由 NN_FC_COUT 加法链自动推导为 WFC=4896/B1=5376/SH1=5426/ROM_WORDS=5476。 |
| 3 | build/rom_check_m2e.py | 新增（仅验证脚本） | 从 nn/out_v5/nn_params_2cls.json 独立复算 5476 字并与 .v 逐字对拍；位于 build/，不参与综合。 |
| 4 | sim/tb/** | **未改** | 15 个既有 TB 全部原样通过，无期望值需要修改（见 §2）。 |
| 5 | 工作树既有改动 | 随本次构建进入 bit | src/hdl/comms/downlink_cmd.v 的 byte23 修复（task-27：CTRL 帧头 7'd23 输出 act_byte_s，:652-656）在本次构建中生效；本次未改该文件。 |

## 1. (a) ROM_SWAP_OK=1 — ROM 替换与独立对拍

### 1.1 字节级替换校验

命令（cwd = retina_event/）：
```
cp ../nn/out_v5/nn_rom_data_2cls.v src/hdl/nn/nn_rom_data.v
cmp src/hdl/nn/nn_rom_data.v ../nn/out_v5/nn_rom_data_2cls.v
```
结果：CMP_IDENTICAL（cmp 退出码 0，无输出）；文件 191,933 B，md5 9406a8900640931a51e4f4ed09a259ca。
rom[ 行数：v4 旧文件 = 5,477、v5 新文件 = 5,477（同一统计口径：含 reg [31:0] rom [0:5475] 声明行；字面量均为 5,476 条，由 §1.2 的 contiguous 检查确认）。

### 1.2 独立复算对拍（不引用任何既有 checker 的结论）

脚本 build/rom_check_m2e.py 独立实现打包契约：
- conv1 → conv2 → conv3 → fc 权重依序连续，每个 int8 占一个 ROM 字，符号扩展为 32 位；
- 同层次序的 bias_int32 依序，按 u32 二补码；
- 同层次序的 SH 依序，取低 8 位（高 24 位 0）；
- 与 src/hdl/nn/nn_rom_data.v 中 32'h 字面量逐字比较，并断言布局基址。

命令与结果（cwd = retina_event/）：
```
python build/rom_check_m2e.py        # 退出码 0，日志 build/rom_check_m2e.log
M2E_ROM_CHECK_OK=1
M2E_MISMATCHES=0
M2E_FIRST_DIFF=-
M2E_FIRST_WORD=FFFFFFA3
M2E_LAST_WORD=00000009
M2E_CHECKED_WORDS=5476/5476
CHECK 行共 43 条，全部 PASS，0 FAIL
```
关键断言：
- layer_order_conv1_conv2_conv3_fc PASS；权重 288/1152/3456/480 = 5376、bias 50、SH 50、总 5476 PASS；
- base_W1=0 / base_W2=288 / base_W3=1440 / base_WFC=4896 / base_B1=5376 / base_SH1=5426 全 PASS（JSON 内 fc_word_base/bias_base/sh_base/rom_words 与推导值一致）；
- layout（cnn_params.layout）逐段起点 0/288/1440/4896/5376/5426 PASS；
- rom_contiguous PASS（min=0 max=5475，恰好 5476 个不同地址）；
- module_name_nn_rom_data / addr_port_13（input [12:0] i_addr）/ reg_decl_0_5475 / no_readmemh PASS；
- 首字 0xFFFFFFA3 = -93（v5 权重第 0 个 int8），末字 0x00000009 = fc 第 2 通道 SH=9。

说明（一处自纠）：SH 字在 ROM 中存的是**移位量**（acc >> SH，取值 7..10），不是 2 的幂值本身。第一版脚本误按"2 的幂"断言导致 4 条 FAIL，核对 nn_engine.v（S_FIN 的 acc >> SH）后把断言改为 SH ∈ [1,31] 并复跑，43 条全 PASS；此改动只影响断言形式，与 0 mismatch 无关（首版已是 0 mismatch）。

## 2. (b) TB_REGRESS_OK=1 — 既有 TB 回归

命令（逐个执行，cwd = retina_event/；日志 build/regress_<tb>.log，汇总 build/regress_m2e.log）：
```
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>
```
| # | TB | 退出码 | 结果行 |
|---|----|--------|--------|
| 1 | tb_act3_hdr | 0 | TEST_RESULT=PASS |
| 2 | tb_act3_tlv | 0 | TEST_RESULT=PASS |
| 3 | tb_act3_idleclr | 0 | TEST_RESULT=PASS (22 checks) |
| 4 | tb_act3_ctrlhdr | 0 | TEST_RESULT=PASS |
| 5 | tb_nn_feat | 0 | TEST_RESULT=PASS |
| 6 | tb_nn_engine | 0 | TEST_RESULT=PASS |
| 7 | tb_nn_top | 0 | TEST_RESULT=PASS (31 checks) |
| 8 | tb_udp_merge | 0 | TEST_RESULT=PASS |
| 9 | tb_wire_v3 | 0 | TEST_RESULT=PASS |
| 10 | tb_downlink_cmd | 0 | TEST_RESULT=PASS |
| 11 | tb_uart_baud | 0 | TEST_RESULT=PASS |
| 12 | tb_uart_link | 0 | TEST_RESULT=PASS |
| 13 | tb_stall_repro | 0 | TEST_RESULT=PASS |
| 14 | tb_udp_mtu_cap | 0 | TEST_RESULT=PASS |
| 15 | tb_top_retina_event | 0 | TEST_RESULT=PASS |

- 13 个任务卡要求的既有 TB 全 RC=0；另 2 个（tb_act3_idleclr / tb_act3_ctrlhdr，由 task-23/task-27 引入，覆盖 ACT_IDLE_CYC 清零与 CTRL 帧头 byte23）也 RC=0，合计 15/15。
- **本任务未修改任何 TB**：无「改前/改后/原因」记录（无需改）。
- 为什么 ROM 换权重不影响 nn TB 期望：tb_nn_top 在 #1 通过分层赋值把 nn_rom_data.rom[0:NN_ROM_WORDS-1] 覆盖成稀疏可控网络（tb_nn_top.v:245-269），tb_nn_engine 用自带 rom_mem 模型（tb_nn_engine.v:53-62），二者不依赖真实权重数值；tb_nn_feat 不引用 ROM；其余通信/动作 TB 与 ROM 无关。

## 3. (c) SYNTH_ACT3C_OK=1 — act3c 构建、时序与位流

### 3.1 第一遍：默认全流程（tool/build_inproc.tcl）

命令（cwd = retina_event/；run_awake_cmd.ps1 包裹防止系统待机冻结长构建）：
```
RETE_TAG=act3c RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass -File \
  E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source tool/build_inproc.tcl \
  -log build/act3c_build.log -journal build/act3c_build.jou -tclargs --full
```
结果：
- run_awake 退出码 ACT3C_EXIT=0；INPROC_RESULT=OK；INPROC_DONE=1；ERROR 计数 0。
- 耗时：20:15:15 启动 → 20:24:54 位流生成（含综合/实现/bitgen）约 **9 分 39 秒**。
- 位流（中间产物，被第二遍覆盖）：build/variant_act3c/retina_event.bit = 2,788,919 B，md5 c4585a8f4bed5c62ec0938653e5df1e9。
- 时序（build/variant_act3c/inproc_timing.rpt）：**WNS -0.175 / TNS -0.175 / 1 failing endpoint / WHS +0.042 / THS 0 fail**（总端点 76,854 / 76,831）。失败 1 条为已知路径族：
  u_event_sink/u_udp_merge/ev_rec_cnt0_reg[2]/C → u_event_sink/u_udp_merge/o_tx_len_reg[12]/D，Path Group eth_rxc，Requirement 8.000 ns，Data Path Delay 7.914 ns（logic 2.961 / route 4.953），13 级逻辑（CARRY4×4 + LUT3/4/5/6）。与 act3/act3b 时同一条包长计算链，对布局敏感（act3 首跑 -0.167、act3b 全构建 +0.125、本次 -0.175）。
- DRC（build/variant_act3c/inproc_drc.rpt）：Violations found 95，全部 Warning，**0 Error**。

### 3.2 第二遍：时序修复（ExtraTimingOpt 布局，交付位流）

按 task-23 已验收的同配方（build/act3c_timingfix.tcl）：open post_synth.dcp → opt_design → place_design -directive ExtraTimingOpt → phys_opt_design（默认）→ route_design（默认）→ report_timing_summary → 全部 slack ≥0 才 write_bitstream 并覆盖交付位流。

命令（cwd = retina_event/、同样 run_awake 包裹）：
```
RETE_TAG 由 dcp 决定，无需重综合：
pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source build/act3c_timingfix.tcl \
  -log build/act3c_timingfix.log -journal build/act3c_timingfix.jou
```
结果：
- ACT3C_FIX_EXIT=0；TIMINGFIX_B_OK=1；TFB_PASS=1；TFB_DONE=1；各阶段 0 Critical Warnings / 0 Errors。
- 耗时：20:25:32 → 20:30:02 约 **4 分 30 秒**。
- 时序（交付报告 build/variant_act3c/timing_deliver.rpt）：
  **WNS +0.306 / TNS 0.000 / 0 failing endpoint / WHS +0.036 / THS 0 fail**（总端点 76,854 / 76,831）。
- write_bitstream：`write_bitstream completed successfully`、`INFO: [Vivado 12-1842] Bitgen Completed Successfully.`。
- 交付位流：**build/variant_act3c/retina_event.bit = 2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a**
  （同目录 retina_event_b.bit 为同内容副本；timing_deliver.rpt 为该 netlist 的时序报告）。
- DRC（build/variant_act3c/timing_b_drc.rpt）：Violations found 95，全部 Warning（BUFC-1/CHECK-3/DPIP-1/DPOP-1/DPOP-2/IOSR-1/PLCK-12/PLCK-23/REQP-1709 等既有项），**0 Error**，与全构建一致。

### 3.3 资源（相对 act3b 基线）

| 资源 | act3b 基线 | act3c 全构建 | Δ vs act3b | act3c 交付（ExtraTimingOpt netlist） | Δ vs act3b | 预算 |
|------|-----------|--------------|-----------|--------------------------------------|-----------|------|
| Slice LUTs | 20,545 | 20,559 | +14 | 20,571 | +26 | ≤ +8,000 |
| Slice Registers | 11,848 | 11,850 | +2 | 11,850 | +2 | ≤ +8,000 |
| CLB Slices | 7,326 | 7,327 | +1 | 7,829 | +503 | ≤ +1,500 |
| Block RAM Tile | 87 | 87 | 0 | 87 | 0 | ≤ +20 |
| DSPs | 7 | 7 | 0 | 7 | 0 | ≤ +20 |
| Bonded IOB | 140 | 140 | 0 | 140 | 0 | — |

说明：交付 netlist 的 Slices 比全构建多 502，是 ExtraTimingOpt + phys_opt 为压时序复制/搬移逻辑造成的布局变化（LUT 仅 +12、FF 不变），仍在 Slices 预算（+1,500）内。资源来源：全构建 build/variant_act3c/inproc_util_impl.rpt，修复 netlist build/variant_act3c/timing_b_util.rpt。

### 3.4 构建总耗时

默认全流程 9 分 39 秒 + ExtraTimingOpt 复跑 4 分 30 秒 ≈ **14 分 09 秒**（不含人工）。

## 4. 兼容性与范围

- 本任务只换 ROM 内容：NN_NUM_CLASSES=2、ROM 布局（5476 字 / 13 位地址）、nn_decide 阈值常量（NN_MARGIN_MIN/N_CON_SEC/REFRACTORY_CYC/NN_K_TIME_BINS）全部未动 ⇒ 决策行为仍按既有 2 类契约。
- 工作树里 task-27 的 CTRL 帧头 byte23 修复（downlink_cmd.v:652-656）随本次综合进入 bit：CTRL ACK/上报帧 byte23 = 动作字节（CRC 覆盖范围内写入，R8 约束保持）。
- 未烧板、未 git、未改 prj/**、nn/**、docs/**、host/**；位流仍在 build/variant_act3c/ 下等 Lead 决定烧写时机。
- build/rom_check_m2e.py 只是证据生成脚本（build/ 目录内，不参与综合、不进版本库）。

## 5. 结论

- ROM_SWAP_OK=1：字节一致（191,933 B，md5 9406a890…），独立复算 5476/5476 字 **0 mismatch**，布局基址全对。
- TB_REGRESS_OK=1：15/15 TB 退出码 0（13 个任务卡要求项 + 2 个既有新增项），未改任何 TB。
- SYNTH_ACT3C_OK=1：act3c 全流程 exit 0 / INPROC_RESULT=OK / DRC 0 Error；首跑 WNS -0.175（1 条已知包长链），按既有 ExtraTimingOpt 配方复跑后 **WNS +0.306 / TNS 0.000 / WHS +0.036**，write_bitstream 成功；交付位流 2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a；资源全在预算内（LUT +26 / FF +2 / Slices +503 / BRAM 0 / DSP 0）。

M2E_OK=1
