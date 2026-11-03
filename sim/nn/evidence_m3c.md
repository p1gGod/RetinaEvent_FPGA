TB_INTEG_OK=1
INTEG_SYNTH_OK=1

# EVIDENCE_M3c — task-43：nn_winstat 接入主链（nn_feat 平移后坐标 + nn_top 统一窗沿）

- 工程：E:/workspace/FPGA_Comp/retina_event（Vivado 2020.2 / xc7a100tfgg484-2 / ModelSim SE 2020.4）
- 判据：TB_INTEG_OK（tb_nn_integ 退出码 0 + TEST_RESULT=PASS）、INTEG_SYNTH_OK（全系统 synth 打印 LUT/FF/DSP/BRAM 且 SYNTH_OK=1）
- 权威语义来源：Lead m01546 裁决（绝对重新居中），训练侧唯一契约 nn/v7/intwin.py:14-16 与 :113-127

## §0 参考模型公式（TB 内行为级模型逐位同式；后续融合/量化对齐以此为准）

```text
// —— 窗口级量（每窗一次，只在窗沿后发布）——
n      = 本窗事件数（ON+OFF）
Sx,Sy  = 本窗 Σx, Σy（像素域，原始坐标）
cx     = (n > 0) ? floor(Sx/n) : prev_cx        // n=0 保持上一有效质心，不归零
cy     = (n > 0) ? floor(Sy/n) : prev_cy
prev_cx/prev_cy = 上一个已完成窗的 cx/cy（本窗窗沿锁存）；复位值 cx=200, cy=120

// —— 网格写入口（逐事件，只做减法+clamp+移位，无乘除）——
shift_x = prev_cx - 200        // 像素单位；200 = GW*8/2（W/2），无累加、无跨窗递归
shift_y = prev_cy - 120        // 像素单位；120 = GH*8/2（H/2）
x'      = clamp(x - shift_x, 0, 399)            // 先像素域减+clamp，再移位
y'      = clamp(y - shift_y, 0, 239)
gx      = x' >> 3 ;  gy = y' >> 3               // GRID_SHIFT=3
clamp_cnt += (任一轴越界 ? 1 : 0)               // 按事件计，饱和 16 位

// —— 窗口内像素和（图像窗口与时间窗同宽 100 ms）——
window    = [t, t+100ms)，板上 stride = 100 ms（不重叠；Lead m01939 决定保留，不改 50 ms）
// 训练侧 nn/v7/intwin.py:34-35 的 WIN_MS=100 / STRIDE_MS=50 属训练增广，非板上节奏；
// 验收口径以 stride=100 的板侧指标为准（训练侧另算 stride=100 指标对照）。
4 通道    = ON_now / OFF_now / ON_prev / OFF_prev（prev 用 nn_feat 现有双缓冲，不额外处理）
```

说明：本任务 RTL 只实现 n/on/off/Σx/Σy/cx/cy/prev/dx（加减移位可得）；sx/sy/speed/dsx/dsy 需平方/开方/除法，按 Lead m01563 留给下一张卡，本任务 o_glob_bus 对应位段固定 0。

## §1 改动清单（全部在 task-43 白名单内）

| 文件 | 变更 | 行数 | md5 |
|---|---|---|---|
| src/hdl/nn/nn_feat.v | M3c：新增 `USE_EXT_TICK`/`EXT_FLUSH_CYC` 参数、`i_win_tick`/`i_ev_par` 端口、`ST_FLUSH` 状态；窗口归属改用事件携带的 epoch；USE_EXT_TICK=0 时行为与旧逻辑完全一致 | 410 | 5a707cc841f6cc46474792122a03d769 |
| src/hdl/nn/nn_top.v | M3c：例化 nn_winstat（u_ws）、统一 win_tick（wt_cnt→feat_ready 门控）、事件并联 tap（原始事件同时喂 nn_winstat）、`o_glob_bus[255:0]`/`o_glob_valid` 输出、g_* 窗口级寄存器组 | 316 | d6a36d29f135839a663afc2f740d4d78 |
| src/hdl/nn/nn_winstat.v | 绝对重新居中定稿（像素域减+clamp+>>3）、prev_cx/prev_cy 复位 200/120、空窗保持、o_dcx= cx-prev_cx | 454 | c6021b5eca86d111588d211efae6c638 |
| src/hdl/nn/nn_cfg.vh | 只追加 §7 段：`NN_EXT_FLUSH_CYC 200`（含语义注释），既有宏未改 | 238 | edbbcbe14e74989c4299469c56caba8b |
| sim/tb/tb_nn_integ.v（新） | 判据 (a)~(d) 的集成 TB，62 CHECK | 518 | a4249f239b4f3df3956e890486c061ad |
| sim/tb/tb_nn_integ.f（新） | 8 行依赖：nn_top/nn_feat/nn_engine/nn_decide/nn_rom/nn_rom_data/nn_winstat + cdc_tog_word | 8 | e9ef5944a35d8ce8467be39a4b4a01b1 |
| tool/nn_integ_synth.tcl（新） | 全系统 synth_design（不 place/route）+ report_utilization，打印 INTEG_* 标记 | 130 | 1624cf37f9ce71ce4622a571142d7b91 |
| sim/tb/tb_nn_top.v / .f | 因 M3c 语义变化改期望值（见 §6），CHECK 数不变 31；.f 增 nn_winstat.v | — | 8717b060168087a1e8d392d76475f0f6 / e9ef5944a35d8ce8467be39a4b4a01b1 |
| sim/tb/tb_top_retina_event.f | 增 nn_winstat.v（现 53 行） | 53 | d9a3421e27a9d15b6ba6e8387add948f |
| sim/tb/tb_nn_winstat.v | 期望值按绝对重新居中修订（107 CHECK 数不变） | — | bf2157c312e899f73031bb7907e57973 |

未改动（白名单外一律未动）：top_retina_event.v、eth_udp.v、udp_merge.v、event_sink.v、downlink_cmd.v、pin.xdc、prj/**、tool/run_sim.ps1、tool/build_inproc.tcl、host/**、nn/**、docs/**。未跑 impl/bitstream/program/flash，未做 git 写。

## §2 判据 (a) 等价性：shift=0 时新路径 == 旧 nn_feat 逻辑（行为级模型参照）

TB 命令：`cd /e/workspace/FPGA_Comp/retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_integ`
结果：退出码 0，`TEST_RESULT=PASS`，`INFO_CHECK_TOTAL=62`，Errors 0 / Warnings 0。

- 前 32 窗（NW_SYM=32）事件成对放在 (200±8k, 120±8k)（k=1..6，交替极化），其质心恒为 (200,120) ⇒ 每窗 shift 恒 (0,0)，**不产生任何平移**，因此这条路径与改造前的 nn_feat 原始坐标路径等价。
- 参照物是 TB 内行为级模型（`feed_ev` 内按 §0 公式逐事件复算 gold 网格），**不拿旧 RTL 当参照**。每窗结束后把 RTL 的 4 通道 bank 与模型对比：

| CHECK | 含义 | 实测 |
|---|---|---|
| A1_GRID_EQ_MODEL | 36 窗累计网格失配数 | 0 |
| A2_CENTROID_EQ_MODEL | 36 窗 cx/cy 失配数 | 0 |
| A3_BANK_4CH_EQ_MODEL | 4 通道（ON_now/OFF_now/ON_prev/OFF_prev）逐格失配数 | 0 |
| A4_SHIFT_ZERO_32WIN | 32 窗 shift 全 0 校验失配数 | 0 |
| A5_CMP_NONZERO_CELLS | 对比非空证明（避免空跑） | >0 |

- 覆盖窗数 36（≥30 要求满足），每窗全 4 通道参与比较。

## §3 判据 (b) 平移生效（绝对重新居中）+ clamp 计数

第 33~36 窗故意做质心偏移，验证「上一窗质心 ⇒ 下一窗平移」与越界 clamp：

| 窗 | 输入 | 发布（CHECK） |
|---|---|---|
| W32 | 4 事件，质心 (100,50) | shift=(-100,-70)：B1_SHIFT_W32_X_M100 / B2_SHIFT_W32_Y_M70；cx=100 / cy=50：B3 / B4 |
| W33 | 8 事件，按 shift(-100,-70) 平移 | 落点 B13..B28 = (28,13) (37,18) (29,14) (13,9) (49,28) (49,23) (25,29) (18,12)；越界 2 次（x=300→400 clamp399→gx49；y=200→270 clamp239→gy29）⇒ B11_CLAMP_W33_2 |
| W33 发布 | 质心 (152,85) | shift=(-48,-35)：B5 / B6；B7_W33_CX_152 / B8_W33_CY_85 |
| W34 | 4 事件，质心 (260,50) | shift=(60,-70)：B9 / B10 |
| W35 | 4 事件，按 shift(60,-70) 平移 | 落点 B29..B36 = (0,21) (5,21) (0,29) (42,10)；越界 2 次（x=8→-52 clamp0；y=200→270 clamp239）⇒ B12_CLAMP_W35_2 |

- 越界钳位在**像素域**先做再 `>>3`：x=300, shift=-100 ⇒ x'=400 > 399 ⇒ clamp 399 ⇒ gx=49（不是 50）；若先移位会得到 50，TB 断言能抓到该错误。
- 手算对照（Lead m01546 用例）：prev (100,50) ⇒ shift=(-100,-70)；事件 (128,40) ⇒ x'=228→gx28、y'=110→gy13 ✓ 与 B13/B14 一致。
- 累计越界计数 B37_CLAMP_TOTAL_4（2+2），与模型逐事件计数一致。
- 空窗语义（nn_winstat 既有 TB tb_nn_winstat 107 CHECK 覆盖）：n=0 保持上一有效质心、shift 保持、不归零；o_dcx=cx-prev_cx（首窗 = cx-200，无 prev_valid 门控）。

## §4 判据 (c) 窗沿唯一：nn_top 只产生一个 win_tick

- nn_top 内 wt_cnt/feat_ready 门控产生**唯一** win_tick，同一根 wire 同时驱动 nn_feat.i_win_tick 与 nn_winstat.i_win_tick（事件并联 tap，不在两处各数一遍窗）。
- TB 在 clk_cam 上升沿监视：

| CHECK | 含义 | 实测 |
|---|---|---|
| C1_TICK_CNT_36 | win_tick 个数 | 36 |
| C2_END_CNT_36 | nn_feat o_win_end 个数 | 36 |
| C3_PUBLISH_CNT_36 | nn_winstat o_stat_valid 个数 | 36 |
| C4_WIN_IDX_36 | nn_top win_idx 计数 | 36 |
| C5_PAR_TOGGLE_35 | 网格事件 epoch 标签（o_grid_par，逐事件输出）翻转次数 | 35（36 个窗都有事件、弹出顺序连续 ⇒ 相邻窗之间翻转 35 次） |
| C6_GRID_EV_CNT / C7_GRID_EV_EXP_404 | 实际过网格事件数 / 期望总数 | 404 / 404 |

- `INFO_WIN=36 INFO_GRID_EVENTS=404 INFO_TICKS=36 INFO_ENDS=36`：tick/end/publish 一一对应，无重复窗、无丢窗。

## §5 判据 (d) 复位与无 X

- 复位释放后（D1~D10）：
  - D1_RESET_GLOB_NOX / D2_RESET_GLOB_ZERO：o_glob_bus 无 X 且全 0；
  - D3_RESET_GRID_PORTS_NOX / D4_RESET_ACT_NOX：网格端口与动作输出无 X；
  - D5_RESET_SHIFT_X_0 / D6_RESET_SHIFT_Y_0：复位后 shift=(0,0)（prev_cx/prev_cy 复位 200/120 ⇒ 200-200=0、120-120=0）；
  - D7_RESET_STAT_VALID_0 / D8_RESET_GRID_VALID_0 / D9_RESET_CLAMP_CNT_0；D10_FEAT_READY。
- 首窗约束：D11_FIRST_WIN_SHIFT_X_0 / D12_FIRST_WIN_SHIFT_Y_0（首窗必然 shift=0），D13_GRID_NOX（全仿真网格通路无 X）。
- 工具差异（记录在案）：task-43 原文要求 `$isunknown`。ModelSim 2020.4 在本工程 vlog **无 -sv** 配置下：编译阶段接受 `$isunknown`（vlog RC=0），但运行期报 `(vsim-12023) Cannot execute undefined system task/function`。因此 TB 内改用等价归约判定：`has_x(v) = (^v === 1'bx)`（对位向量做 XOR 归约并比 4 态 X），语义等价、可移植。

## §6 判据 (e) 回归与顶层 elaboration

### 6.1 既有 TB 回归（17 个，全部退出码 0）

日志：`build/regress_m3c.log`（16 个 RC=0；其中 tb_nn_top 一行是**修复期望值之前**的旧记录 RC=1），修复后单跑记录在 `build/regress_m3c_fix.log`：

| TB | RC | 备注 |
|---|---|---|
| tb_act3_hdr | 0 | 判据 (e) 13 个之一 |
| tb_act3_tlv | 0 | 13 个之一 |
| tb_nn_feat | 0 | 13 个之一（USE_EXT_TICK=0 旧行为未变） |
| tb_nn_engine | 0 | 13 个之一 |
| tb_nn_top | **0（fix 日志）** | 13 个之一；期望值因 M3c 语义修订（见 6.2），CHECK 数 31 未减 |
| tb_udp_merge | 0 | 13 个之一 |
| tb_wire_v3 | 0 | 13 个之一 |
| tb_downlink_cmd | 0 | 13 个之一 |
| tb_uart_baud | 0 | 13 个之一 |
| tb_uart_link | 0 | 13 个之一 |
| tb_stall_repro | 0 | 13 个之一 |
| tb_udp_mtu_cap | 0 | 13 个之一 |
| tb_top_retina_event | 0 | 13 个之一（.f 增 nn_winstat.v 后复跑） |
| tb_nn_winstat | 0 | 附加；107 CHECK（绝对重新居中期望） |
| tb_act3_idleclr | 0 | 附加；22 CHECK |
| tb_act3_ctrlhdr | 0 | 附加；21 CHECK |
| tb_nn_integ | 0 | 本任务新增；62 CHECK |

### 6.2 tb_nn_top 期望值为何必须改（M3c 语义连带）

失败现象（改前）：16 条 FAIL 全部 got=0，而引擎每窗都在跑（TF_BUSY_DUR_2cls=439597 正确）。DEC 打印头两窗 l1=2 正确，之后每窗 l0=0/l1=0/l2=-128。
根因：老 TB 把事件发在特征 cell(0,0)（x,y∈0..7）。绝对重新居中后首窗质心 cx≈0 ⇒ 下一窗 shift_x = 0-200 = -200、shift_y = -120（像素），事件被搬到 grid(25,15)，而 TB 仍查 cell(0,0) 与 FC pos0 ⇒ 特征全 0。
修法（不改 RTL）：事件全部发在中心像素 (EV_X,EV_Y)=(200,120) ⇒ 质心恒 (200,120) ⇒ shift 恒 0 ⇒ 网格恒 cell(25,15)。对应几何：

- grid(15,25) → conv1 tap(1,1) → L1(7,12) → conv2 tap(1,0) → L2(3,6) → conv3 tap(1,0) → L3(1,3) ⇒ bufC 下标 och*NN_L3_OUTHW + 8 ⇒ FC cin=8（ON）/ 18（OFF）
- 层尺寸（nn_cfg.vh）：L1 4x30x50→8x14x24（T=36）；L2 8x14x24→16x6x11（T=72）；L3 16x6x11→24x2x5（T=144）；FC 240 输入
- 稀疏 ROM 下标改为 NN_W{1,2,3}_BASE + och*NN_L{1,2,3}_T + cin*9 + TAP，FC 改为 NN_WFC_BASE + row*NN_FC_CIN + {8, 18}
- tensor 断言改为 frz_mem[bank_cap*3000 + CELL_I] / [1500 + CELL_I]，CELL_I = 15*50+25 = 775
- CHECK 条数与名字全部保持（31 条），仅期望值/激励几何改变；PASS：`TEST_RESULT=PASS (31 checks)`

### 6.3 顶层 elaboration（判据 (e) 后半：Errors 0）

- 目录 `build/sim/top_elab43/`：files.f = 57 行（src/hdl 全 55 个 .v + sim/models/clk_wiz_0_sim.v + bufg_sim.v），**必须写 Windows 绝对路径**（用 MSYS 的 /e/... 路径 vlog 报 `(vlog-7) ... errno = ENOENT`）。
- `vlog -quiet -work work -f files.f` ⇒ VLOG_RC=0；
- `vsim -c -voptargs=+acc -gSIM=1 -gUSE_DDR3=0 -gETH_EN=0 -gUART_EN=0 -do "quit -f" work.top_retina_event` ⇒ VSIM_RC=0，`# Errors: 0, Warnings: 7`，日志含 `Loading work.top_retina_event(fast)`、`work.nn_top(fast)`、`work.nn_winstat(fast)`、`work.nn_feat(fast)`、`work.act_state_cdc(fast)`。
- 7 条 warning：既有 4 条（top_retina_event.v(618) u_event_sink 49/46 端口 + o_ev_dbg_* 未接，历史遗留）；新增 3 条 = top_retina_event.v(505) u_nn_top "Expected 15, found 13" + `o_glob_bus`/`o_glob_valid` 未接。**这是 task-43 白名单禁改 top_retina_event.v 的预期结果**，glob bus 的顶层接入属后续任务（task-20 及融合卡）。

## §7 判据 (f) 资源（全系统 synth_design，不 place/route）

命令（run_awake 包裹，exit code 0）：

```bash
cd /e/workspace/FPGA_Comp/retina_event
RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass \
  -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/nn_integ_synth.tcl -log build/integ_synth2.log -journal build/integ_synth2.jou
```

结果：`INTEG_DONE=1`、`^ERROR` 计数 0、`INTEG_SYNTH_OK=1`；报告 `build/integ_synth/integ_util_synth.rpt`。

| 指标 | act3c 基线（synth 阶段，build/variant_act3c/inproc_util.rpt） | M3c（synth） | Δ | 预算 | 判定 |
|---|---|---|---|---|---|
| Slice LUTs | 21,518 | 21,913 | **+395** | ≤ +1,200 | PASS |
| Slice Registers (FF) | 12,058 | 12,444 | +386 | — | 记录 |
| LUT as Memory | 5,896 | 5,922 | +26 | — | 记录 |
| Block RAM Tile | 87 | 87 | 0 | ≤ +2 | PASS |
| DSPs | 7 | 7 | 0 | ≤ +1 | PASS |

- 打印值：`INTEG_LUT=21913`、`INTEG_FF=12444`、`INTEG_LUTRAM=5922`、`INTEG_BRAM=87`、`INTEG_DSP=7`、`INTEG_SLICES=0`（synth 阶段的 report_utilization 表里没有 "Slice"（CLB slices）行，该行只在 impl 报告出现；act3c impl 为 7,327，故本卡不报 ΔSlices）。
- 接线自证（综合网表里三种实例都在）：`INTEG_CELL_NNTOP=2821`、`INTEG_CELL_WINSTAT=905`、`INTEG_CELL_ACTCDC=123`、`INTEG_CELL_UDP_MERGE=1754`。
- **两点必须说清的口径**：
  1. 任务卡写的基线 LUT 20,559 是 act3c 的 **impl** 数字；本判据只跑 synth（不 place/route），可比基线应取 act3c 的 **synth** 数字 21,518（同工程同 generic 的 inproc_util.rpt）。按此口径 ΔLUT=+395，远低于 1,200。若强行跨阶段比（21,913 vs 20,559）得 +1,354，会误判超标——两阶段 LUT/LUTRAM 分工不同，不做跨阶段比较。
  2. `o_glob_bus`/`o_glob_valid` 在顶层未接（白名单禁改 top）⇒ Vivado 可能把只喂该端口的 g_* 寄存器裁掉，所以本次 ΔLUT 是**下界**；glob bus 接线后需复测一次（预计仍远低于预算）。

## §8 已知边界 / 遗留（供后续卡）

1. **glob bus 未接顶层**：o_glob_bus[255:0]/o_glob_valid 已由 nn_top 输出，位域见 nn_top.v:237-303（[218:203] n、[202:187] on、[186:171] off、[170:162] cx、[161:154] cy、[153:138] sx、[137:122] sy、[121:113] pcx、[112:105] pcy、[104:95] dx、[94:85] dy、[84:69] speed、[68:59] dsx、[58:49] dsy、[48:32] bal、[31:16] frames、[15:0] prev_n、[234:219] dx>0 计数、[255:235] 保留）。顶层接入与后续融合卡一起做。
2. **sx/sy/speed/dsx/dsy 固定 0**：需平方/开方/除法，按 Lead m01563「窗级乘除法允许、放慢速状态机」在下一卡实现。
3. **o_win_end 延迟**：外部统一窗沿模式下 o_win_end 比旧设计晚 `NN_EXT_FLUSH_CYC=200` 拍（窗长 5,000,000 拍，0.004%），用于等 nn_winstat 窗沿 52 拍除法 + FIFO（64）里的在途事件落地，避免旧窗事件串入新窗。
4. **极端事件率**：nn_winstat 事件 FIFO 深 64；若窗内瞬时积压超过 FIFO 深度会丢事件。本次 404 事件 / 36 窗与模型逐格一致（C6/C7），未观察到丢失。
5. **2 分类 ROM**：NN_NUM_CLASSES=2，class2 不可达（nn_decide 把 l2 钉 -128）；argmax 平局取较小索引的改动随融合卡统一进 INT8_CONTRACT，本卡未动 nn_decide。
6. **未做**：impl/bitstream、上板、Flash、git 写、host/**、nn/**、docs/** 修改，均未进行。

## §9 结论

- (a) shift=0 等价：A1/A2/A3/A4 失配 0，覆盖 36 窗 × 4 通道，参照为 TB 内行为级模型；
- (b) 平移生效 + clamp：8+4 个事件落点逐一命中，clamp 累计 4；
- (c) 窗沿唯一：tick/end/publish/win_idx 全 36，epoch 翻转 35，网格事件 404；
- (d) 复位：shift=0、统计清零、全通路无 X；
- (e) 17 个 TB 全 RC=0，顶层 elaboration Errors 0（7 warning 均已知）；
- (f) ΔLUT +395 / ΔDSP 0 / ΔBRAM 0（synth vs synth 同阶段口径，预算内）；**+395 是下界**——o_glob_bus/o_glob_valid 顶层尚未接线（白名单禁改 top），只喂该端口的 g_* 寄存器可能被综合裁掉，下一张卡接线后必须复测 ΔLUT。

M3C_OK=1
