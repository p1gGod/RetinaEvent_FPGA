# M3 证据：int8 CNN 动作识别子系统（nn_top）—— M3-fix v2

- 任务：task-21（M3-fix：单时钟 50 MHz、去 200 MHz 与跨域 CDC、特征/激活全落 BRAM、串行单 MAC、强制 DSP）；上游 task-6（M3 RTL）、Lead 追加要求 m00553（输入形状参数化）与 m00951（NUM_CLASSES 参数化、性能与 BRAM 账目）
- 日期：2026-10-29；本机：ModelSim SE 2020.4 / Vivado 2020.2，part xc7a100tfgg484-2
- 工程根：E:/workspace/FPGA_Comp/retina_event
- 结论：**M3_RTL_OK=1**（四条判据全绿，另有 PARAM_READY=1）

| 判据 | 命令（工程根） | 退出码 | 关键输出 | 结论 |
|---|---|---|---|---|
| TB_FEAT_OK | pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_feat | 0 | `# TEST_RESULT=PASS`，CHECK PASS=38 / FAIL=0 | PASS |
| TB_ENGINE_OK | pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine | 0 | `# TEST_RESULT=PASS`，CHECK PASS=20 / FAIL=0 | PASS |
| TB_TOP_OK | pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_top | 0 | `# TEST_RESULT=PASS (31 checks)`，CHECK PASS=31 / FAIL=0 | PASS |
| SYNTH_ACTION_OK | powershell -NoProfile -ExecutionPolicy Bypass -File tool/run_awake_cmd.ps1 -CommandLine "\"E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat\" -mode batch -nolog -nojournal -source tool/nn_synth_check.tcl" | 0 | `ACT3_SYNTH_OK=1`、`ACT3_LUT=1108 ACT3_FF=400 ACT3_SLICES=356 ACT3_BRAM=10.5 ACT3_DSP=1 ACT3_WNS=8.827` | PASS |

- 三条仿真判据的完整日志：build/sim/tb_nn_feat/vsim.log、build/sim/tb_nn_engine/vsim.log、build/sim/tb_nn_top/vsim.log。
- 综合布线控制台（第 4 次重试成功的那轮）：sim/nn/nn_synth_console.log；报告 sim/nn/nn_util.rpt、sim/nn/nn_util_hier.rpt、sim/nn/nn_timing.rpt、sim/nn/nn_drc.rpt；机读汇总 sim/nn/nn_act3_summary.txt。

## 0. v1（200 MHz 单 MAC/周期）为什么必须推倒重来

| 指标 | v1 实测（sim/nn/nn_synth_run_1.log） | v2 实测（本轮） |
|---|---|---|
| LUT | 28,023 | 1,108（LUT 原语；report_utilization 折算 Slice LUTs 1,026） |
| FF | 66,423（act_a/act_b 两块 4096x8 被拆成寄存器） | 400 |
| Slices | 15,643 / 15,850 = 98.69% | 356 / 15,850 = 2.25% |
| Block RAM | 8.5 tiles | 10.5 tiles |
| DSP48 | 0（int8 乘加全推成 LUT） | 1 |
| WNS | **-7.001 ns @ 5 ns**（不收敛） | **+8.827 ns @ 20 ns** |
| 异步复位 BRAM 违例 | REQP-1839（cur_mem ADDRARDADDR） | 0 |
| 一次推理延迟 | 224,095 拍 @200 MHz = 1.12 ms | 440,087 拍 @50 MHz = 8.80 ms |

v1 的致命项不是周期数，而是：Slices 98.7% 无法与主设计（6,721 slices）共存；DSP=0 说明乘加全走 LUT；200 MHz 下单周期「宽取数 + 累加」路径 12 ns，物理上不可能收敛。v2 因此按 Lead 指令改成 **单时钟 clk_cam 50 MHz + 全 BRAM + 串行单 MAC**，数学逐位不变（见 §2 的 golden 比对）。

## 1. TB_FEAT_OK=1（tb_nn_feat.v，WIN_CYC 压到 8000 拍）
- 退出码 0，末行 `# TEST_RESULT=PASS`，CHECK 38 条全 PASS、0 FAIL。
- 覆盖：坐标 >>3 落格（含 (399,239)->cell1499、x=400 越界被丢并计数）；同格同极性累加；8 bit 饱和（255 封顶）；窗口边界 now->prev 搬移（bank 0->1->2->0）与旧窗清零；ON/OFF 通道分离（ch0/ch1 与 ch2/ch3）；q=min(127,count) 不右移；窗口周期精确（F7_period_win0_1/1_2/2_3 三对都等于 8000 clk_cam 拍）；复位清零 9001 拍后才 ready；拷贝期间到达的事件归入下一窗；o_dbg_drop 全程仅 1。
- 代表性 CHECK 行：`# CHECK=F1_clear_9001cyc_before_ready PASS`、`# CHECK=F7_period_win1_2 PASS`、`# CHECK=F9_drop_final_1 PASS`。
- v2 变化：nn_feat 去掉 clk_200m/rst_n_200m 端口，frz 读口改在 clk_cam 域（同步复位），其余逻辑未动。

## 2. TB_ENGINE_OK=1（tb_nn_engine.v，clk=50 MHz，ROM/特征由 TB 驱动）
- 退出码 0，末行 `# TEST_RESULT=PASS`，CHECK 20 条全 PASS、0 FAIL；单次推理 cycles=440,087（E1_CYCLE_CNT / E2_CYCLE_CNT 两次 RUN 相同）。
- E1 组（手算小用例）：通道顺序、bias、每通道 SH 独立、负饱和+ReLU、正饱和、零通道、busy 释放、fc 不 ReLU + 负数算术右移（E1_FC_L0_POS / E1_FC_L1_ZERO / E1_FC_L2_NEG_KEEP）。
- E2 组（TB 内 golden model，随机权重全网络逐字节比对）：E2_GOLD_COVER / E2_L1_BYTE_EXACT / E2_L2_BYTE_EXACT / E2_L3_BYTE_EXACT / E2_LOGITS_EXACT / E2_TOG_ONCE / E2_CYCLE_CNT —— v2 串行引擎与 v1 的数学逐位一致。
- 引擎时序（v2）：状态 S_IDLE -> S_PIX0..S_PIX4（每像素固定 5 拍：发 SH 地址 / 收 SH + 发 bias / 收 bias / 初始化像素 + 发首个权重地址）-> S_TAP0（组合发激活地址）/ S_TAP1（1 次 MAC + 权重地址 +1）×T -> S_FIN（移位、饱和、ReLU、写缓存、推进像素）-> S_DONE。每像素 6 拍 + 2T 拍（每 tap 2 拍：1 拍发地址 + BRAM 寄存读，1 拍乘加）。
- ROM 读口仍是 2 拍延迟（o_rom_addr 寄存 + nn_rom_data 的 BRAM 寄存读）；特征读口 1 拍（frz 读口寄存）。TB 中 E2 的逐字节比对是唯一的强判据（手算用例抓不到时序错位）。

## 3. TB_TOP_OK=1（tb_nn_top.v，WIN_CYC=500000 / REFRACTORY=1200000 / MARGIN_MIN=8 / N_CONSEC=3）
- 退出码 0，末行 `# TEST_RESULT=PASS (31 checks)`，CHECK 31 条全 PASS、0 FAIL。
- 参数（TB 缩比，只为仿真时间）：WIN_CYC=500,000 拍（10 ms）代替 5,000,000；REFRACTORY=1,200,000 拍（24 ms，约 2.4 窗）；其余与 nn_cfg.vh 一致。
- 覆盖：T0_READY_AFTER_CLEAR；T1_WIN_PERIOD_STABLE（10,000,000 ns = 500,000 拍）；T2_CLASS0_NO_PULSE；T3_TENSOR_ON_ONLY/OFF_ZERO；T4_MARGIN_GATE_NO_PULSE；T5_CONSEC1/2_NO_PULSE；T6_CONSEC3_PULSE1 / PULSE1_CLASS1 / PULSE1_CONF20；T7_REFRACTORY_BLOCK；T8 双极性张量 (25,20)；T9_MIXED_LOGIT1=45 / LOGIT2=40 / CLASS1 / MARGIN5 / MARGIN5_NO_HIT；TA_CLASS2_CONSEC1/2；TB_CLASS2_PULSE2 / PULSE2_CLASS2 / PULSE2_CONF31；TC_NO_SPURIOUS_PULSE；TD_ENGINE_ONE_PER_WIN；TE_BUSY_RISE_LE_100；TF_BUSY_DUR_440k；TG_BUSY_NO_OVERLAP；TH_NO_EVENT_DROP；TI_WIN_COUNT=12。
- 12 个窗口的决策轨迹（TB 打印的 DEC 行，l0 恒 0）：logit1/logit2 = (0,0) (0,0) (2,0) (20,0) (20,0) (20,0) [pulse#1] (20,0) (45,40) (30,60) (30,60) (40,80) [pulse#2] (0,0)。第 6 行连续第 3 窗 class1（margin=20 -> conf=20）产生 pulse#1；第 11 行连续第 3 窗 class2（margin=40 夹到 31）产生 pulse#2；refractory 内窗口不 pulse。
- 引擎忙时间实测：`busy duration = 440083 cycles, rise delay = 2 cycles`（TB 打印）——与 §2 的 440,087 拍一致（相差 4 拍是 busy 2FF 同步与 start 边沿对齐）。每窗恰好启动一次（TD）、忙期不跨窗（TG）、忙上升沿距窗口边界 2 拍（TE）。
- v2 变化：TB 时钟只保留 clk_cam（#10）；eng_runs 改为数 o_dbg_busy 上升沿（v2 无 eng_start 端口）。

## 4. SYNTH_ACTION_OK=1（tool/nn_synth_check.tcl：synth -> opt -> place -> route -> report）

运行方式（防待机会话冻结；工程内 run_awake_cmd.ps1 是纯 ASCII 的通用包装，退出码透传；E:/Tools/FPGABuilder_AMD/scripts/run_awake.ps1 只能包 fpgab.bat）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File tool/run_awake_cmd.ps1 -CommandLine "\"E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat\" -mode batch -nolog -nojournal -source tool/nn_synth_check.tcl"
```

退出码 0（第 4 次尝试；第 1~3 次是 Vivado synthesis helper 进程环境抖动，10 s 内失败、与本设计无关，重试即通）。判据行（行首锚定；Vivado 会回显 TCL 源码）：

```
ACT3_ROOT=E:/workspace/FPGA_Comp/retina_event
ACT3_PART=xc7a100tfgg484-2
ACT3_SRC_COUNT=6
ACT3_STEP=synth_done
ACT3_STEP=opt_done
ACT3_STEP=place_done
ACT3_STEP=route_done
ACT3_LUT=1108
ACT3_FF=400
ACT3_SLICES=356
ACT3_BRAM=10.5
ACT3_DSP=1
ACT3_WNS=8.827
ACT3_ROM_BRAM=4
ACT3_RAMB36=9
ACT3_RAMB18=3
ACT3_DRC_FATAL=0
ACT3_DRC_VIOL=7
ACT3_DRC_REQP_ASYNC=0
ACT3_SYNTH_OK=1
```

约束：只对 clk_cam 建 20 ns 时钟（v2 内部单时钟；clk_200m/rst_n_200m 端口保留但无内部负载、故意不约束），输入/输出各 2 ns 延迟避免未约束路径污染 WNS。

判据门限（task-21）与实测：

| 门限 | 要求 | 实测 | 判定 |
|---|---|---|---|
| 时序 WNS @20 ns | >= 0 | +8.827 ns（TNS 0.000，0/2533 failing，WPWS 8.870） | PASS |
| Slice LUTs | <= 12,000 | 1,026（Logic 882 + LUTRAM 144）= 1.62% | PASS |
| FF | <= 12,000 | 400 = 0.32% | PASS |
| Slices | <= 5,000 | 356 = 2.25% | PASS |
| Block RAM | <= 20 tiles | 10.5 = 7.78%（RAMB36 x9 + RAMB18 x3） | PASS |
| DSP48 | 1..8 | 1 = 0.42% | PASS |
| 权重 ROM 在 BRAM | >= 1 | ACT3_ROM_BRAM=4（3 RAMB36 + 1 RAMB18，层次报告 u_rom 行） | PASS |
| DRC 致命 | = 0 | 0（7 条全是 Warning：NSTD-1/UCIO-1 各 1、CFGBVS-1、DPIP-1 x2、DPOP-1、DPOP-2） | PASS |
| REQP-1839/1840 | = 0 | 0 | PASS |

层次资源（sim/nn/nn_util_hier.rpt）：

| 实例 | LUT | LUTRAM | FF | RAMB36 | RAMB18 | DSP |
|---|---|---|---|---|---|---|
| nn_top | 1,026 | 144 | 400 | 9 | 3 | 1 |
| u_feat | 381 | 144 | 111 | 5 | 0 | 0 |
| u_eng | 500 | 0 | 189 | 1 | 2 | 1 |
| u_rom | 1 | 0 | 0 | 3 | 1 | 0 |
| u_dec | 144 | 0 | 99 | 0 | 0 | 0 |

DRC 说明：NSTD-1/UCIO-1 在本 OOC 脚本里被降级为 Warning（脚本 §2b 显式 set_property SEVERITY），因为引脚/IOSTANDARD 约束属于集成任务的 pin.xdc，本脚本按构造没有 XDC；其余 DRC 仍严格计数，REQP-18xx 已归零。

## 4.1 性能定量（Lead m00951 的「为什么这么快」）

| 量 | 值 |
|---|---|
| 一次推理 MAC 数 | 208,080 = conv1 96,768（4x9x336x8）+ conv2 76,032（8x9x66x16）+ conv3 34,560（16x9x10x24）+ fc 720（240x3） |
| 输出像素数 | 3,987 = 2,688 + 1,056 + 240 + 3 |
| TB 实测周期 | 440,087 拍 = 2x208,080（每 MAC 2 拍）+ 6x3,987（每像素固定开销）+ 5 |
| 50 MHz 下耗时 | 8.80 ms |
| 与 1 个 bin（100 ms = 5,000,000 拍）之比 | **8.80%**（440,087 / 5,000,000）——推理在下一次窗口边界前很早就完成，引擎与特征累积完全不冲突 |
| MAC 吞吐 | 0.473 MAC/cycle = 25 MMAC/s（单 DSP） |
| K=6（6 bin x 100 ms = 600 ms 窗） | MAC 401,616 -> 827,154 拍 = 16.54 ms = 600 ms 窗的 2.76% |

与 4.48 ms 量级估计的对齐：4.48 ms = 224,095 拍 @50 MHz，就是 v1「单 MAC/每拍」的周期数。v2 每 MAC 用 2 拍（1 拍发读地址、让 BRAM 寄存输出，1 拍乘加累加），所以周期数翻倍到 440,087；两者同处 5~10 ms 量级，结论（远小于 100 ms 窗）不变。

## 4.2 BRAM 账目（用于和 director 的 M0 预算表对账）

| 数组 | RTL 尺寸 | 位宽 x 深度（工具映射口径） | 实测 tiles | 容量 |
|---|---|---|---|---|
| u_feat/frz_mem（K+1 个 bin x 2 极性） | 9000 x 8 | 8K x 8 双端口 | 4 RAMB36 | 72 kbit |
| u_feat/cur_mem（当前 bin 累积） | 3000 x 8 | 2K x 8 双端口 | 1 RAMB36 | 24 kbit |
| u_eng/bufA（conv1 激活） | 2688 x 8 | 2K x 8 | 1 RAMB36 | 21.5 kbit |
| u_eng/bufB（conv2 激活） | 1056 x 8 | 1K x 8 | 1 RAMB18 | 8.4 kbit |
| u_eng/bufC（fc 输入） | 240 x 8 | 240 x 8 | 1 RAMB18 | 1.9 kbit |
| u_rom/u_rom_data（权重+bias+SH） | 5718 x 32 | 见下 | 3 RAMB36 + 1 RAMB18 = 3.5 | 声明 183 kbit |
| u_feat/fifo_mem（事件 FIFO） | 512 x 13 | 分布式 RAM（RAM64X1D x8 + RAM64M x32） | 0（144 LUTRAM） | 6.5 kbit |
| 合计 | | | **10.5 tiles** | |

- 特征存储与任务书文字的差异：任务书建议「3000 格 x 2 bank x 32 bit = 192 kbit」，RTL 实际用「(K+1) 个 bin x 3000 x 8 bit = 72 kbit（K=2）」，即 8 bit 饱和计数直接存、量化 q=min(127,count) 在读口做；省 120 kbit（约 3.3 tiles），且 K=8 时 FRZ_DEPTH=27000 仍只约 168 kbit。功能等价（TB_FEAT 的饱和/量化用例证明）。
- ROM：RTL 声明 5718 x 32 = 182,976 bit；实测 3 RAMB36 + 1 RAMB18 = 3.5 tiles（物理容量 129,024 bit < 声明位数 ⇒ 综合对字表做了窄化）。为排除「顶层例化方式导致」的可能，单独对 nn_rom_data 做非工程综合（sim/nn/rom_probe.tcl，日志 sim/nn/rom_probe_console.log）得到同样的 3 RAMB36 + 1 RAMB18；再用 sim/nn/rom_probe2.tcl 逐 cell 读位宽：o_dout_reg_0/1/2 的 READ_WIDTH_A=4、o_dout_reg_3 的 READ_WIDTH_A=2 ⇒ ROM 实际以 **14 bit 字宽**存储，输出端符号扩展到 32 位。原因：占位 ROM 的 5718 个字（int8 权重符号扩展、±4095 量级 bias、SH<=15）全部落在 int14 有符号范围内，Vivado 的 ROM 位宽压缩去掉了恒定的高位。M2 换成真实权重后若 bias 超出 int14 范围，工具会自动保留更多位宽（tiles 略增）；功能等价由综合保证。
- 与 M0 预算（权重 2 + 激活 5 = 7 tiles）对比：ROM 实际 3.5、特征/激活 5.0（frz 4 + cur 1）+ 引擎激活 2.0（bufA 1 + bufB/bufC 各 0.5）= 10.5；比预算多 3.5 tiles，仍远低于 20 tiles 门限，器件共 135 tiles（占 7.78%）。

## 5. NUM_CLASSES 参数化（Lead m00951）

`nn_cfg.vh` 第 2 节新增 `define NN_NUM_CLASSES 3`，`NN_FC_COUT = NN_NUM_CLASSES`，ROM 末段（WFC/bias/SH）全部由这个参数推导；nn_engine 只在 `och==2` 时写 o_res_l2；nn_decide 在 NUM_CLASSES=2 时把第 3 路钉成 int8 最小（-128），class2 永不胜出。切换两分类只需改 `NN_NUM_CLASSES` + 用生成器重出 nn_rom_data.v，RTL 主体不动。

NUM_CLASSES=3（默认，K=2）地址推导（与 M2 交付的 5,718 字布局逐值一致）：

| 段 | 基址 | 字数 |
|---|---|---|
| W1 | 0 | 288 |
| W2 | 288 | 1152 |
| W3 | 1440 | 3456 |
| WFC | 4896 | 720 |
| B1/B2/B3 | 5616 / 5624 / 5640 | 8 / 16 / 24 |
| BFC | 5664 | 3 |
| SH1/SH2/SH3 | 5667 / 5675 / 5691 | 8 / 16 / 24 |
| SHFC | 5715 | 3 |
| ROM_WORDS | | **5718** |

NUM_CLASSES=2（K=2，按生成器实际导出的形状推导）：

| 段 | 基址 | 字数 |
|---|---|---|
| W1/W2/W3 | 0 / 288 / 1440 | 288 / 1152 / 3456 |
| WFC | 4896 | 480（3 行 -> 2 行，-240） |
| B1/B2/B3 | 5376 / 5384 / 5400 | 8 / 16 / 24 |
| BFC | 5424 | 2 |
| SH1/SH2/SH3 | 5426 / 5434 / 5450 | 8 / 16 / 24 |
| SHFC | 5474 | 2 |
| ROM_WORDS | | **5476** |

- 与 Lead 给的「bias 51->50、ROM 5,717 字、SH 同布局」不一致，数据如下：要得到 5,717（只少 1 字）必须「保留第 3 行 fc 权重 720 字 + SHFC 仍 3 字，只把 bias 少 1 字」；而生成器在两分类时 fc 权重只导出 2 行（480 字）、bias/SH 各 2 字，故是 5,476（-242）。ROM_AW 两种情况都仍是 13（5476/5718 < 8192），不影响端口位宽。若 M2b 希望保留 3 类槽位（固定 720+51）以便两/三类共用同一 ROM 尺寸，把 `NN_WFC_WORDS` 与 SH 段字数改成固定上限即可（一行改动），功能上无差别——等 Lead 定。
- 注意：ROM 字数变化不是「裁掉尾字」能实现的（fc 权重段在中间），nn_rom_data.v 必须整表重生成。

## 6. 参数化（Lead m00553）

- **PARAM_READY=1**
- 支持 K_TIME_BINS = 2..8。约束推导：IN_CH = 2K；BANKS = K+1；FRZ_DEPTH = (K+1)x3000（K=8 -> 27000，FRZ_AW=15）；L1_T = 18K（K=8 -> 144）；ROM 字数 = 8*18K + 16*72 + 24*144 + 720 + 102 = 6582 @K=8 < 8192 => ROM_AW 仍 13；激活缓存深度 4096 不受影响（最大层 2688/1056/240/3）。
- K=2 等价性证据：参数化重构后三个 TB 逐位仍全 PASS（38 / 20 / 31，见 §1~§3）；nn_cfg.vh 的 ROM 基址链在 K=2 时手工验算为 0 / 288 / 1440 / 4896 / 5616 / 5624 / 5640 / 5664 / 5667 / 5675 / 5691 / 5715 / 5718，与 M2 冻结布局逐字一致；引擎地址映射 ch(2i+pol) = bank((now-i) mod BANKS) 在 K=2 时退化为 ch0=ON_now、ch1=OFF_now、ch2=ON_prev、ch3=OFF_prev。
- 改 K 的方法：只改 nn_cfg.vh 的 `NN_K_TIME_BINS`（nn_rom_data.v 需按新 IN_CH 重新生成），RTL 不动；nn_feat 的时间片划分由 `WIN_CYC`（=单个 bin 长度）与 `NN_BANKS` 推导，不写死 2 段。
- 600 ms 窗的合理实例：**K=6 x 100 ms**（只改 `NN_K_TIME_BINS=6`，`NN_WIN_CYC` 不动）；或 **K=8 x 75 ms**（`NN_K_TIME_BINS=8` + `NN_WIN_CYC=3_750_000`，75 ms x 50 MHz 是整数拍）。两者都只改宏；K=8 时 BANKS=9、FRZ_DEPTH=27000（约 8 个 RAMB36），ROM 按新 IN_CH 重生成（6582 字 < 8192）。
- 网络输入总时长 = K x WIN_CYC = `NN_TOTAL_SPAN_CYC`（nn_cfg.vh 第 2 节，默认 2 x 100 ms = 200 ms）。

## 7. 契约偏差与说明（需 Lead / M2b 知悉）
1. 通道顺序：docs/03_tech/04_action_recognition_selection.md 第 3.2 节写 c0=上一窗ON、c1=上一窗OFF、c2=当前ON、c3=当前OFF，与任务书冻结顺序 [ch0=ON_now, ch1=OFF_now, ch2=ON_prev, ch3=OFF_prev] 不同。RTL 按任务书实现（Lead m00702 已确认以本实现为准，文档由 director 修）；训练侧 M2 导出权重时必须按任务书顺序。
2. 引擎性能：任务书预估「约 4000 周期/次、约 20 us」，实测 440,087 拍 @50 MHz = 8.80 ms（每 MAC 2 拍 + 每像素 6 拍固定开销）。仍只占 100 ms bin 的 8.8%，契约不受影响；详细分解见 §4.1。
3. 特征存储形态：任务书文字建议 3000 格 x 2 bank x 32 bit（192 kbit），RTL 用 (K+1) x 3000 x 8 bit（K=2 时 72 kbit）+ 读口量化 q=min(127,count)。功能等价、更省 BRAM，见 §4.2。
4. 本子系统未集成进 top_retina_event（按任务书/白名单，集成是后续任务）；nn_top 的事件口直接对接 event_gen 的 ev_valid/x/y/pol。
5. v2 单时钟后 clk_200m/rst_n_200m 端口保留但无内部负载（TB 仍可驱动），集成时可直接接 clk_wiz_0 或悬空——建议集成任务决定是否在 nn_top 端口清单里删掉。

## 8. 踩过的坑与处置

| 坑 | 症状 | 处置 |
|---|---|---|
| Vivado synthesis helper 进程间歇崩 | `invalid command name "rt-undefined"`、`couldn't read file .../scripts/rt/data/unimacro/unimacro_verilog.tcl: No error`、或只报 `synth_design failed` 无具体 ERROR；均在 10 s 内失败 | 环境抖动，重试即通（本轮综合第 4 次成功）；`set_param general.maxThreads 1` 不能根治 |
| .Xil 落在源码目录 | `couldn't read file .../src/hdl/nn/.Xil/.../realtime/nn_top.tcl` | TCL 里 cd 到工程根；read_verilog 用绝对路径时 Vivado 仍按源文件目录解析 `include` |
| RAM 推断硬规则 | `Synth 8-3391`（异步复位 / 同块多写口）、`Synth 8-6156` | 数组写入放无异步复位 always 块，每数组只写一条语句；地址/数据/使能先用组合 mux 成一套写口 |
| **ram_style="block" 被忽略** | LUTRAM 映射表出现 bufA/bufB/bufC（属性写了 block 也无效，Vivado 无提示） | 根因是「读数据先经 case(mux) 再进寄存器」；拆成每块 RAM 各自一个读寄存器（act_a_q/act_b_q/act_c_q）后再 mux，三块 buf 全部进 BRAM（bufA 1 RAMB36、bufB/bufC 各 1 RAMB18，LUTRAM 从 900 降到 144） |
| **多驱动 net 只在综合暴露** | `CRITICAL WARNING: Synth 8-6859 multi-driven net on pin Q ... act_q_reg[7] ... 2nd driver GND` + 8-6858，RTL 仿真全 PASS | act_q 被「缓存读块」和「状态机复位分支」两处驱动；把复位放进读块（同步复位）并删掉状态机里的赋值，单一驱动 |
| BRAM 异步复位违例 REQP-1839 | `RAMB36 async control check`，地址/使能来自异步复位寄存器 | 数组写口/读口都改成同步复位（v2 起全设计无异步复位数组） |
| 200 MHz 单周期宽取数 | v1 WNS -7.001 ns @5 ns、Slices 98.69%、DSP 0 | v2 改单时钟 50 MHz + 每 MAC 2 拍串行取数 + `(* use_dsp = "yes" *)` 强制 DSP，WNS +8.827 ns |
| TCL 兼容性 | `invalid command name "remove_from_collection"` | 手写 foreach 遍历 all_inputs 排除时钟 |
| TCL 编码 | UTF-8 BOM 报 `invalid command name` | TCL 存 ASCII/无 BOM；判定行用 `^ACT3_` 行首锚定（Vivado 回显 TCL 源码） |
| 重定向目录 | 目标目录不存在时 tee/vivado 管道断裂、进程被杀 | 先 `mkdir -p sim/nn` 再重定向 |
| RTL：寄存器读 RAM 的读改写 | 2 拍会读到上一地址旧值（计数少 3/4） | RMW 必须 3 拍：发地址 -> 等 1 拍 -> 写 |
| RTL：FIFO 计数同拍 push/pop | 两条非阻塞赋值后者覆盖前者，事件被吞（260 个只累计 173） | 合成一条 `fifo_cnt <= fifo_cnt + push - pop` |
| RTL：ROM 读出延迟 | 误按 1 拍设计导致 bias/SH 错位一拍，手算用例仍过、golden 比对才抓到 | 按 2 拍（地址寄存 + BRAM 寄存读）排时序 |
| TB：稀疏权重 tap | OFF 链误用中心 tap4，OFF 通道恒 0 | 改为 tap0（窗口原点），ON/OFF 双链正常 |
| TB：class2 置信度 | 三窗都为 30 时 conf=30 而期望 31 | 第三窗改 40 事件，margin=40 -> 夹到 31 |
| 五类场景 TB 的时间参数 | 引擎 440k 拍 > 旧 WIN_CYC 66k | TB 改用 WIN_CYC=500,000 / REFRACTORY=1,200,000（只改时间参数，CHECK 条数不减：38/20/31） |

## 9. 复现命令汇总
```
cd E:/workspace/FPGA_Comp/retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_feat
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_top
powershell -NoProfile -ExecutionPolicy Bypass -File tool/run_awake_cmd.ps1 -CommandLine "\"E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat\" -mode batch -nolog -nojournal -source tool/nn_synth_check.tcl"
```

M3_RTL_OK=1
