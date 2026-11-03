BIT7_OK=1
# task-52（M3f）证据：act7 一次完整构建（v7 位流，含时序与资源报告，不烧板）

- 负责人：rtl2；日期：2026-10-31；工程：E:/workspace/FPGA_Comp/retina_event
- 结论：v7 链路（nn_winstat + nn_winfeat + G1 融合引擎 + v7 ROM + byte23 修复）用既有进程内脚本一次完整构建成功，默认流程（Default 指令）即满足全部时序约束；位流落 build/variant_act7/retina_event.bit = 2,835,423 B。
- 本卡**未**烧板、未 Flash、未 open_hw_manager；未改 src/hdl/**、未新增源文件、未做 git 写。
- 路径约定：除特别标注外，所有路径相对 retina_event/。

## 0. 判据对照（任务卡 (a)~(f)）

| 判据 | 要求 | 实测 | 结论 |
|---|---|---|---|
| (a) 构建 | run_awake 包裹 tool/build_inproc.tcl，Vivado 退出码 0 | run_awake_cmd.ps1 exit 0；Vivado exit 0；INPROC_RESULT=OK、INPROC_DONE=1 | PASS |
| (b) 位流 | build/variant_act7/retina_event.bit > 2,000,000 B | 2,835,423 B，md5 9c13668c029c9d3a248cf69cbec03582 | PASS |
| (c) 时序 | WNS>=0、TNS=0、WHS>=0、THS=0（取 variant_act7 报告） | WNS +0.059 / TNS 0.000（fail 0）/ WHS +0.027 / THS 0.000（fail 0）；"All user specified timing constraints are met." | PASS |
| (d) 资源 | LUT/FF/Slice/BRAM/DSP/IOB 绝对值+占比+相对 act3c 增量 | 见 §3 表 | PASS |
| (e) 证据 | 本文件，首行 BIT7_OK=1，含命令/耗时/资源/时序/bit md5/未烧板声明 | 本文件 | PASS |
| (f) 失败不凑时序 | 时序为负时停下列违例路径等裁决 | 本次 WNS=+0.059>=0，未触发任何 RTL 改动；未跑第二轮 | N/A（正向） |

- 判读补充（Lead m02812 要求）：(c) 是本轮**第一次 Default 指令**的结果（opt/place/route 无 -directive、未跑 Explore 第二轮）；WNS +0.059 ns 属**极薄**余量（8 ns 周期的 0.74%，比 act3c 的 +0.306 少 247 ps）。(f) 第二轮未触发；Explore+phys_opt 脚本 tool/build_inproc_v7.tcl 已按 Lead 指令预置给 act8（见 §2.4/§7.1）。

## 1. 构建命令与耗时

### 1.1 命令原文（在 retina_event/ 下执行）
~~~
cd /e/workspace/FPGA_Comp/retina_event
RETE_TAG=act7 RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass \
  -File /e/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/build_inproc.tcl -log build/act7_build.log -journal build/act7_build.jou \
  -tclargs --full
~~~
- 用 temp_test/run_awake_cmd.ps1 而非 E:/Tools/FPGABuilder_AMD/scripts/run_awake.ps1：后者只接受 fpgab.bat 的参数（内部固定调用 fpgab.bat），不能直接包裹任意命令；两者用的是同一套 SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) 防休眠机制，本次命令执行期间 sleep 被阻止（脚本首行/末行各打印一次），满足「run_awake 包裹后台跑」的要求。
- 脚本内置参数：root=E:/workspace/FPGA_Comp/retina_event、prj=prj/retina_event.xpr、part=xc7a100tfgg484-2、top=top_retina_event、mode=--full、generics=ETH_EN=1、outdir=build/variant_act7。

### 1.2 起止时间与总耗时

| 项 | 值 |
|---|---|
| 开始 | 2026-10-31T00:46:42+08:00（build/act7_start.txt） |
| 结束 | 2026-10-31 00:56:48（日志 "Exiting Vivado at Sat Oct 31 00:56:48 2026"） |
| 总耗时 | 10 分 06 秒 |
| synth_design | 4 分 32 秒（cpu 4:02） |
| opt_design | 0 分 27 秒 |
| place_design | 1 分 57 秒 |
| route_design | 1 分 57 秒 |
| write_bitstream | 0 分 29 秒 |

- 步骤标记序列：INPROC_STEP=open_project -> generate_target all -> synth_design -> synth_done -> opt_design -> place_design -> route_design -> impl_done -> write_bitstream -> INPROC_BIT_BYTES=2835423 -> INPROC_RESULT=OK -> INPROC_DONE=1。

## 2. 时序（最终布线，build/variant_act7/inproc_timing.rpt，副本 timing_deliver.rpt）

### 2.1 设计与约束摘要

| 项 | WNS(ns) | TNS(ns) | TNS Failing | TNS Total | WHS(ns) | THS(ns) | THS Failing | THS Total | WPWS(ns) | TPWS(ns) | TPWS Failing | TPWS Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 值 | **0.059** | **0.000** | 0 | 84,405 | **0.027** | **0.000** | 0 | 84,382 | 0.000 | 0.000 | 0 | 21,644 |

- 报告原文：“All user specified timing constraints are met.”（inproc_timing.rpt:134）。
- Timing constraint 全部满足，无 Slack (VIOLATED) 路径（全文件 0 处）。

### 2.2 最差 setup 路径（第一次 Default 就收敛，余量仅 0.059 ns —— 极薄）
~~~
Slack (MET) : 0.059ns (required time - arrival time)
  Source:      u_event_sink/u_udp_merge/ev_wr_page_reg/C   (FDCE, eth_rxc 8.000ns)
  Destination: u_event_sink/u_udp_merge/o_tx_len_reg[9]/D  (FDCE, eth_rxc)
  Path Group:  eth_rxc；Path Type: Setup (Slow)
  Requirement: 8.000ns
  Data Path Delay: 7.892ns (logic 2.952 (37.4%) + route 4.940 (62.6%))
  Logic Levels: 14 (CARRY4=4 LUT3=2 LUT4=1 LUT5=2 LUT6=5)
  Clock Path Skew: -0.046ns；Clock Uncertainty: 0.035ns
~~~
- **第一次 Default 指令就收敛**：本轮 opt/place/route 全部用 Default（无任何 -directive），WNS 即 +0.059 >= 0，任务卡「时序风险条款」的第二轮授权未触发（见 §2.4）。
- **余量极薄**：+0.059 ns 只有 8.000 ns 周期的 **0.74%**，比 act3c 交付的 +0.306 ns 少 **247 ps**。任何 ROM/RTL/约束/布局变化都可能把它压负，act8 必须重测，不能引用本次数字。
- 与任务卡「时序风险条款」预判一致：最差路径落在 u_event_sink（eth_rxc 125 MHz）的走线主导链上；但它与 act3c 交付时那条最差路径**不是同一条 net**（源、终点、逻辑级数都不同），见 §2.5。

### 2.3 最差 hold 路径
~~~
Slack (MET) : 0.037ns (arrival time - required time)
  Source:      u_retina_core/u_cam_tap/px_r_reg[12]/C (cam_pclk 20.833ns)
  Destination: u_retina_core/u_cdc0_fifo/g_rtl.mem_reg/DIADI[12] (RAMB36E1, cam_pclk)
  Path Group: cam_pclk；Hold (Fast)；Data Path Delay 0.383ns
~~~

### 2.4 时序风险条款执行情况
- 任务卡步骤 1：第一轮用现有脚本原样跑（Default），完整记录 —— 已执行，WNS=+0.059>=0。
- 任务卡步骤 2 的前提是 WNS<0；本次未触发，因此 act7 **未**跑 Explore+phys_opt 第二轮（白名单允许但按条款不需要），也不存在第二轮耗时。
- 任务卡步骤 3/4：两轮都负的情形未发生；本文件不存在「第二次」分段。
- 后续动作（Lead m02812/m02817 补充授权）：为 act8 预先准备 `tool/build_inproc_v7.tcl` —— 由 tool/build_inproc.tcl 逐字复制，只在 opt/place/route 三条命令上加 `-directive Explore`，并在 route_design 之后插一行 `phys_opt_design`，其余逐字不动（13,427 B、无 BOM、md5 785978677e8f9088a285c869ba9046b3；与 md5 9ea4afa6cb636490e89458f7ed3fbec4 的原脚本相比恰好 3 处命令加参数 + 1 行插入）。**act7 本身仍只跑了一轮 Default**，此脚本尚未被调用。

### 2.5 act7 最差路径 vs act3c 最差路径：不是同一条，拥塞点迁移了

| 项 | act3c 交付（build/variant_act3c/timing_deliver.rpt:1378，WNS +0.306） | act7 本次（build/variant_act7/inproc_timing.rpt:426，WNS +0.059） |
|---|---|---|
| 时钟 / Path Group | eth_rxc，8.000 ns | eth_rxc，8.000 ns |
| Source | u_event_sink/u_cdc_raw_fifo/g_rtl.rd_ptr_gray_reg[5]/C（FDRE） | u_event_sink/u_udp_merge/ev_wr_page_reg/C（FDCE） |
| Destination | u_event_sink/u_udp_merge/raw_ram_reg_1/ADDRARDADDR[13]（RAMB36E1 地址端） | u_event_sink/u_udp_merge/o_tx_len_reg[9]/D（FDCE，包长寄存器） |
| Data Path Delay | 7.061 ns（logic 2.203 = 31.2% + route 4.858 = 68.8%） | 7.892 ns（logic 2.952 = 37.4% + route 4.940 = 62.6%） |
| Logic Levels | 7（CARRY4×3 + LUT2×2 + LUT6×2） | 14（CARRY4×4 + LUT3×2 + LUT4×1 + LUT5×2 + LUT6×5） |
| 端点总数（setup） | 76,854 | 84,405 |

**判断：不是同一条路径。** act3c 的瓶颈是 CDC raw FIFO 读指针灰码 → udp_merge 的 raw_ram 写地址（RAM 地址端，7 级逻辑）；act7 的瓶颈变成 udp_merge **内部**的 ev_wr_page（事件写页/计数）→ o_tx_len（包长计算，14 级逻辑）。两者同属 u_event_sink / eth_rxc 这一个拥塞簇，但 net 不同 —— 加入 nn_winfeat + nn_winstat + 引擎 v7 段（LUT +1,812 / FF +2,475 / 端点 +7,551）后，**拥塞点从「CDC FIFO → RAM 地址」迁移到了「事件包长计算链」**。这也解释了为什么这两处 RTL 本卡都没动、WNS 却从 +0.306 掉到 +0.059：不是某一条固定路径恶化，而是布局拥塞重新分布。后续若要治这条，应针对 udp_merge 的包长组合链（want_pkt / pkt_len_w → o_tx_len）做预寄存或路径分组/局部 pblock，而不是继续盯 raw_ram 地址端。

## 3. 资源（实现后，build/variant_act7/inproc_util_impl.rpt，副本 util_deliver.rpt）

| 项 | act7 实测 | 占比 | act3c 基线 | 增量 |
|---|---|---|---|---|
| Slice LUTs | **22,371** | 35.29% | 20,559 | **+1,812** |
| (LUT as Logic) | 16,449 | 25.94% | - | - |
| (LUT as Memory) | 5,922 | 31.17% | (同) | 0 |
| Slice Registers (FF) | **14,325** | 11.30% | 11,850 | **+2,475** |
| Slice | **7,968** | 50.27% | 7,327 | **+641** |
| Block RAM Tile | **87** | 64.44% | 87 | **0** |
| (RAMB36/FIFO) | 82 | 60.74% | - | - |
| (RAMB18) | 10 | 3.70% | - | - |
| DSPs | **8** | 3.33% | 7 | **+1** |
| Bonded IOB | **140** | 49.12% | 140 | **0** |

- 说明：act3c 基线取任务卡给的实现后数字（LUT 20,559 / FF 11,850 / Slice 7,327 / BRAM 87 / DSP 7 / IOB 140）。
- 与 task-51 的 synth 数字（LUT 23,368 / FF 14,533）差异属正常：synth 是逻辑综合阶段，impl 的 opt/place 会做常量传播/重构/寄存器重定时并消耗等价逻辑，口径不同不能混用；impl 才是上板口径。
- 增量构成：nn_winfeat（窗级 7 路特征，OOC 实测 1,068 LUT/1,562 FF/1 DSP）+ nn_winstat 的 Σx²/Σy² 累加与快照 + 引擎 v7 的 g1 段与 fc 256 路。

## 4. 位流

| 项 | 值 |
|---|---|
| 路径 | E:/workspace/FPGA_Comp/build/variant_act7/retina_event.bit |
| 字节数 | 2,835,423（> 2,000,000 门槛） |
| md5 | 9c13668c029c9d3a248cf69cbec03582 |
| bitgen | build/act7_build.log:7702 "Writing bitstream ..."; :7703 "Bitgen Completed Successfully."; :7706 "write_bitstream completed successfully" |
| 同目录报告 | inproc_timing.rpt（+timing_deliver.rpt）/ inproc_util_impl.rpt（+util_deliver.rpt）/ inproc_drc.rpt / inproc_timing_synth.rpt / inproc_util.rpt / post_synth.dcp |

- 源码-位流一致性说明：act7 构建后按 Lead 订正（m02812）把 src/hdl/nn/nn_rom.v 头注释「5718 字」改为「5,652 字」（两处，**纯注释**；文件现 29 行、md5 56b31e4ba8636272eee925fbd813da38）。注释不参与综合，act7 位流与该注释修改**逻辑等价**；逐字节可复现的「源码 = 位流」基线由 act8 建立（act8 构建时的源码即含此订正）。

## 5. 构建日志健康度

- Vivado exit code 0；run_awake_cmd 末行 "sleep blocking released; exit code = 0"；ACT7_EXIT=0。
- INPROC_RESULT=OK；INPROC_DONE=1；INPROC_BIT_BYTES=2835423。
- 日志 "^ERROR:" 计数 **0**。
- CRITICAL WARNING 计数 6，去重后只有 2 类：ila_sccb / ila_dbg 的 XDC 因模块未例化（ILA_EN=0）不读 —— 与 act3/act3b/act3c 全部历史构建同源，非本次引入。
- DRC（build/variant_act7/inproc_drc.rpt，Design State: Fully Routed）：Violations found 98，**0 Error、0 Critical Warning**，全部为 Warning（BUFC-1/CHECK-3/DPIP/DPOP/IOSR/PLCK/REQP/RPBF/RTSTAT 等既有类别）；Vivado 日志原文 "DRC finished with 0 Errors, 2 Warnings"（impl_drc 阶段）。
- 源文件清单：INPROC_NHDL=56（act3c 时为 54）。新增的 2 个是 task-40 的 src/hdl/nn/nn_winstat.v 与 task-48 的 src/hdl/nn/nn_winfeat.v，由 build_inproc.tcl 的递归 glob 自动收集，**本卡没有新增/修改任何源文件**。
- 已知副作用（沿用既有说明）：open_project + remove/add_files 会重写 prj/retina_event.xpr 的 source 列表；本卡不提交 git，不回滚。

## 6. ROM 版本切换流程（v7 -> v7b，一步可复跑；本卡只用 v7 构建，不写 v7b 的任何假设）

前置冻结项（Lead 口径，v7b 只换权重数值）：ROM_WORDS=5652、13 bit 地址、15 个段基址（conv1_w 0 / conv2_w 288 / conv3_w 1440 / g1_w 4896 / fc_w 5008 / conv1_b 5520 / conv2_b 5528 / conv3_b 5544 / g1_b 5568 / fc_b 5584 / conv1_sh 5586 / conv2_sh 5594 / conv3_sh 5610 / g1_sh 5634 / fc_sh 5650）、n_out=2、K=7、g1 16x7、fc 输入 256。

~~~
# 1) 换 ROM（整文件替换，模块名/端口不变）
cp nn/out_v7b/nn_rom_data_v7b.v src/rtl/nn/nn_rom_data.v

# 2) 用同一套黄金向量生成器重生成 vectors（新增 --json/--out 参数；默认值仍是 v7）
cd /e/workspace/FPGA_Comp
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/gen_engine_v7_vectors.py \
    --json nn/out_v7b/golden_vectors.json \
    --out sim/tb/tb_nn_engine_v7_vectors.vh

# 3) 校验 ROM 布局冻结项（cfg <-> rom_offsets.json；默认读 v7，可传 v7b 的 offsets）
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/check_cfg_v7.py nn/out_v7b/rom_offsets.json   # 期望 CFG_V7_BAD=0

# 4) 重跑逐层对拍引擎 TB + 顶层集成 TB（golden 随新权重重生成，期望值随之更新）
cd retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine_v7   # TEST_RESULT=PASS
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_top         # TEST_RESULT=PASS

# 5) 重新构建（下一卡 act8；与本次 act7 完全同一条链路，只换 tag/产物目录）
RETE_TAG=act8 RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass \
  -File /e/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/build_inproc.tcl -log build/act8_build.log -journal build/act8_build.jou -tclargs --full
~~~

- 本次已验证生成器的确定性：参数化后用默认路径重生成，产物 md5 = 7e75b4976af37422cdc0fa4e3e7dff64，与现有 sim/tb/tb_nn_engine_v7_vectors.vh **逐字节相同**（121,010 B），因此换 ROM 时只有 golden 内容变化才改变 TB 期望。
- check_cfg_v7.py 也已支持可选 offsets 路径（改动后默认路径仍输出 CFG_V7_OK=1）。

## 7. act7 与后续 act8 对照（同一 RTL、两个 ROM 版本；act8 由下一卡填）

| 指标 | act7（v7 ROM） | act8（v7b ROM，待打） |
|---|---|---|
| WNS / TNS | +0.059 / 0.000 | TBD |
| WHS / THS | +0.027 / 0.000 | TBD |
| LUT / FF / Slice | 22,371 / 14,325 / 7,968 | TBD |
| BRAM / DSP / IOB | 87 / 8 / 140 | TBD |
| 位流字节 / md5 | 2,835,423 / 9c13668c029c9d3a248cf69cbec03582 | TBD |

### 7.1 act8 两轮策略与预置脚本（Lead m02812/m02817 补充授权）
- 触发条件：act8（v7b ROM）用 Default 构建完后**若 WNS < 0.2 ns**（act7 已只剩 0.059，概率高），立即用 `tool/build_inproc_v7.tcl` 再跑一轮（opt/place/route 全 `-directive Explore` + route 后 `phys_opt_design`）；两版并排比 WNS 与资源，**选收敛更好的作交付位流**。act7 位流保留作兜底，不删。
- 脚本已就绪：tool/build_inproc_v7.tcl（13,427 B、无 BOM、md5 785978677e8f9088a285c869ba9046b3），与 tool/build_inproc.tcl（md5 9ea4afa6cb636490e89458f7ed3fbec4）的差异恰好是 opt/place/route 各加 `-directive Explore` + route 后一行 `phys_opt_design`，其余逐字相同。用法：把 §6 第 5 步的 `-source tool/build_inproc.tcl` 换成 `-source tool/build_inproc_v7.tcl`，tag/日志另取（如 act8e）以免覆盖第一轮报告。

## 8. 声明
- **本次未烧板**：未执行 program_hw_devices / boot_hw_device / write_cfgmem / open_hw_manager，未连接 JTAG 或网口。
- 未执行任何 git 写操作；未改 host/**、nn/**、docs/**。

## 8.1 部署参数变更：MARGIN_MIN 8→16（2026-10-31）

- **变更**：`src/hdl/nn/nn_cfg.vh:91` 由 `NN_MARGIN_MIN 8` 改为 **16**；`:90 NN_N_CONSEC 3` 不变。grep 佐证：`grep -n NN_MARGIN_MIN src/rtl/nn/nn_cfg.vh` → 第 91 行；文件 254 行 md5 `3325047ce2659039c0934c3bd6a00ddb`。
- **依据**：task-63 的 s100 门限扫描 18 组中，16/3 对 8/3 全维占优：open 17/17、wave 1、static 0、empty 0 相同，hardneg 3→2、总 pulses 88→74；远距离组 open 仍 3/3、pulses 7→5。报告引用 `nn/REPORT_v7b_部署口径重训.md`（截至本变更落盘时该文件尚未出现在工作区；v7b 五件套的 build_meta.json 已写 deploy_config，可交叉核对）。
- **与 v7b 产物一致**：`grep -o '"margin_min"[^,]*' nn/out_v7b/nn_params_v7b.json` → 16；`"n_consec"` → 3；`"eval_stride"` → 100，与 nn_cfg.vh 完全一致。
- **TB 影响清单与重跑结果**（2026-10-31 01:12–01:19）：

| TB | 受影响原因 | TB 改动 | 结果 |
|---|---|---|---|
| tb_nn_top | 例化 nn_top/nn_decide | `:47 localparam MARGIN_MIN = 8` → `` `NN_MARGIN_MIN ``（`:92` 引用）；断言未改 | RC=0，31 CHECK 全 PASS；日志 `MARGIN_MIN=16` |
| tb_nn_integ | 例化 nn_top/nn_decide | `:68 .MARGIN_MIN (8)` → `` (`NN_MARGIN_MIN) ``；断言未改 | RC=0，TEST_RESULT=PASS |
| tb_top_retina_event | 走顶层默认参数 | 无 | RC=0，TEST_RESULT=PASS |
| tb_nn_engine_v7 | 不例化 nn_decide | 无 | RC=0，76 CHECK 全 PASS（复核未受影响） |
| tb_nn_feat / tb_nn_engine / tb_nn_winstat / tb_nn_winfeat / tb_act3_* | 不经过 nn_decide 或直接注入 byte23 | 无 | 期望不受门限影响 |

- **旧期望→新期望**：**无**。原因：所有"应命中"场景 margin ≥ 20（T6_PULSE1_CONF20 即 margin=20；TB_PULSE2_CONF31 已饱和）> 16；唯一门限负例 T9_MIXED_MARGIN5_NO_HIT 的 margin=5 < 16 仍不命中；16 恰落在两者之间，因此 31 条 CHECK 未删、未改期望，全部 PASS。

## 9. 复现命令（本次 act7）
~~~
cd /e/workspace/FPGA_Comp/retina_event
RETE_TAG=act7 RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source tool/build_inproc.tcl -log build/act7_build.log -journal build/act7_build.jou -tclargs --full
md5sum build/variant_act7/retina_event.bit   # 9c13668c029c9d3a248cf69cbec03582
grep -n 'Design Timing Summary' -A 6 build/variant_act7/inproc_timing.rpt
~~~

M3F_OK=1
