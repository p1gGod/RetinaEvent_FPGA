# EVIDENCE — task-40 / M3b：nn_winstat 平移归一化前端 RTL

TB_WINSTAT_OK=1
WINSTAT_SYNTH_OK=1

日期：2026-10-30 22:48（Asia/Shanghai）
工程：E:/workspace/FPGA_Comp/retina_event（Vivado 2020.2 / ModelSim SE-64 2020.4）
器件：xc7a100tfgg484-2

---

## 0. 交付物 / 改动清单（全部在白名单内）

| 文件 | 说明 | 大小 | md5 |
|---|---|---|---|
| src/hdl/nn/nn_winstat.v | **新增**：平移归一化前端（431 行） | 19,821 B | fb1743535aa1f3a417b4de72aac87788 |
| src/hdl/nn/nn_cfg.vh | **追加** §6 常量（226 行；原 211 行一字未改，git diff = 15 insertions） | — | 3ebdc205e30cf0dce2bc3904185da3ba |
| sim/tb/tb_nn_winstat.v | **新增**：判据 TB（107 个 CHECK） | — | 9cfca492a413677318ffe00647e306aa |
| sim/tb/tb_nn_winstat.f | **新增**：依赖清单（仅 src/hdl/nn/nn_winstat.v） | — | — |
| tool/nn_winstat_synth.tcl | **新增**：synth+opt 判据脚本（无 BOM、ASCII 注释） | — | d35076253771cc095f7c629578729643 |

nn_cfg.vh §6（新增，只追加）：

```verilog
// ---- §6 平移归一化前端（nn_winstat）----
`define NN_WS_FIFO_DEPTH          64
`define NN_WS_FIFO_AW              6
`define NN_WS_EMPTY_CENTROID_HOLD  1
```

未改动（按任务书禁令）：src/hdl/nn/nn_top.v、nn_decide.v、nn_engine.v、nn_feat.v、nn_rom*.v、
src/hdl/top/top_retina_event.v、eth_udp.v、udp_merge.v、event_sink.v、pin.xdc、prj/**、
tool/run_sim.ps1、host/**、nn/**、docs/**。未跑 impl / bitstream / program / flash，未做 git 写。

git status（只读）：`M src/rtl/nn/nn_cfg.vh` + 4 个 `??` 新文件（上表）；
nn/out_v7、nn/v7、nn/REPORT_v7_*.md 为他人未跟踪产物，与本任务无关。

---

## 1. (a) 空窗：n=0、质心保持、Δ=0、平移量=0、无除零 / 无 X  ✅

命令：

```
cd retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_winstat
=> RUN_RC=0, TEST_RESULT=PASS, INFO_CHECK_TOTAL=107, Errors: 0, Warnings: 0
```

语义在 nn_cfg.vh 里写死：`NN_WS_EMPTY_CENTROID_HOLD = 1` ⇒ 空窗 `cx/cy 保持上一有效值`（不保持则清零）。

| CHECK | 结果 |
|---|---|
| F1_EMPTY_N_ON_0 / F2_EMPTY_N_OFF_0 | n_on=0、n_off=0 |
| F3..F6_EMPTY_SUM_*_0 | Σx_on=Σy_on=Σx_off=Σy_off=0 |
| F7_EMPTY_CX_HOLD_100 / F8_EMPTY_CY_HOLD_50 | 质心保持上一有效值 (100,50)，未清零 |
| F9_EMPTY_DCX_0 / F10_EMPTY_DCY_0 | Δ=0 |
| F11_EMPTY_SHIFT_X_0 / F12_EMPTY_SHIFT_Y_0 | 平移量=0（空窗后一窗不平移） |
| F13/F14_AFTER_EMPTY_GRID_X/Y_12 | 空窗后第一条事件 (100,100) → grid (12,12)，未被平移 |
| A1..A7 | 复位后 shift/cx/cy/stat_valid/grid_valid/clamp_cnt 全 0 |
| Z1_NO_X_ON_OUTPUTS | 全流程输出无 X（TB 每个 negedge 扫 cx/cy/shift/n/grid/stat 的 XOR 归约） |

除零：除法器只在 `win_tick_fire && win_nz` 时启动（n=0 直接走空窗发布路径，不启动除法），
源码 nn_winstat.v:229（启动条件）+ nn_winstat.v:322（空窗分支）。

---

## 2. (b) 单点事件：n=1 ⇒ cx=x、cy=y  ✅

事件 (x=123, y=77, ON)：

| CHECK | 实测 |
|---|---|
| B1_SINGLE_N_ON_1 | o_n_on=1 |
| B2_SINGLE_N_OFF_0 | o_n_off=0 |
| B3_SINGLE_SUM_X_123 / B4_SINGLE_SUM_Y_77 | Σx=123、Σy=77 |
| B5_SINGLE_CX_123 / B6_SINGLE_CY_77 | cx=123、cy=77 |
| B7_SINGLE_DCX_0 / B8_SINGLE_SHIFT_X_0 | 首窗无上一质心 ⇒ Δ=0、shift=0 |

---

## 3. (c) 已知 4 点复算：Σ 与质心误差 0  ✅

任务书点集 (x,y)=(0,0),(0,0),(400,200),(800,0)，注明"用 x/2 缩放后的整数输入"。
i_ev_x 只有 9 bit（0..511），800 不可表示 ⇒ **按 x/2 缩放喂入**：
(0,0,ON),(0,0,OFF),(200,200,ON),(400,0,OFF)。

| CHECK | 实测 | 手算 |
|---|---|---|
| C1_KNOWN4_N_ON_2 / C2_N_OFF_2 | 2 / 2 | 2 / 2 |
| C3_SUM_X_ON_200 / C4_SUM_Y_ON_200 | 200 / 200 | 0+200 / 0+200 |
| C5_SUM_X_OFF_400 / C6_SUM_Y_OFF_0 | 400 / 0 | 0+400 / 0+0 |
| C7_KNOWN4_CX_150 | 150 | (200+400)/4 = 150 |
| C8_KNOWN4_CY_50 | 50 | (200+0)/4 = 50 |
| C9_KNOWN4_DCX_0_FIRST | 0 | 首窗 Δ=0 |

另加一组**端口内可表示的原值**（不加缩放）做交叉验证：
(0,0,ON),(0,0,OFF),(400,200,ON),(400,0,OFF) ⇒ C11 Σx=800、C12 Σy=200、C13 cx=200、C14 cy=50，全 PASS。
证据采纳"两组都复算"的口径：质心算法 Σ/n 误差 0。

---

## 4. (d) 3 窗序列：只用上一窗统计量 + 越界 clamp  ✅

### 4.1 位移链路（W1→W2→W3）

| 窗 | 喂入事件 | 质心 | Δ（=cx_k−cx_{k−1}） | 下一窗 shift |
|---|---|---|---|---|
| W1 | (96,48),(104,52),(96,52),(104,48) | (100,50) | 0（首窗） | 0 |
| W2 | (112,48),(120,52),(112,52),(120,48) | (116,50) | +16 | **16** |
| W3 | (128,40),(200,80),(136,48),(8,8) + 4×(400,0) | (259,22) | +143 / −28 | **143** |

W3 事件写网格（x>>3 − 16，y>>3 − 0），逐条断言：

| CHECK | 事件 | 期望 | 实测 |
|---|---|---|---|
| D12/D13 | (128,40) | (0,5) | (0,5) |
| D14/D15 | (200,80) | (9,10) | (9,10) |
| D16/D17 | (136,48) | (1,6) | (1,6) |
| D18/D19 | (8,8) | gx=1−16=−15 → **clamp 0**，gy=1 | (0,1) |
| D20_CLAMP_CNT_1 | — | clamp 计数 1 | 1 |

### 4.2 「只能用上一窗统计量」的两处反证

- **D5_W2_SHIFT_NOT_CURRENT**：W2 的 4 条事件全部喂入、窗沿未到之前，o_shift_x 仍为 0
  （若用本窗统计量，此处会立刻变成 W2 质心位移）。
- **D21_W3_SHIFT_STILL_16**：W3 窗内再喂 4×(400,0)（会把本窗质心拉到 259），窗沿前 o_shift_x 仍为 16。

因果方向：shift 寄存器只在**窗沿除法完成拍**（dv_done_w）更新（nn_winstat.v:294-321），
事件路径只读 shift_cur/shift_prev，不参与统计 ⇒ 结构上不可能"用本窗"。

### 4.3 负位移 / 上下界 clamp / 整数 floor

| CHECK | 说明 | 实测 |
|---|---|---|
| E4_W4_DCX_NEG4 | Δx = 96−100 = −4，10 bit 补码 | 1020 (0x3FC) |
| E5_W4_DCY_10 | Δy = 60−50 = +10 | 10 |
| E6/E7_SHIFT | o_shift_x=1020、o_shift_y=10 | ✓ |
| E8/E9 | (0,232) → gx=0+4=4、gy=29−10=19 | (4,19) |
| E10/E11 | (392,232) → gx=49+4=53 → **上界 clamp 49**、gy=19 | (49,19) |
| E12/E13 | (0,0) → gx=4、gy=0−10=−10 → **下界 clamp 0** | (4,0) |
| E14_CLAMP_CNT_2 | 两条事件被夹 | 2 |
| E15/E16 | 392/3=130.67→130、464/3=154.67→154（纯整数 floor） | 130 / 154 |

clamp 范围：gx∈[0,49]（GW−1）、gy∈[0,29]（GH−1），GW=50/GH=30 全由 nn_cfg.vh 形状宏推导。

### 4.4 窗沿边界（计算期事件不丢、用新窗位移）

H 组：W1 质心 100（Δ=0）、W2 质心 110（Δ=10）、W3 质心 132（Δ=22）。

| CHECK | 场景 | 实测 |
|---|---|---|
| H8/H9 | **窗沿同拍**事件 (200,80)，归入新窗 W4 | (3,10) = (25−22, 10) |
| H10/H11 | 窗沿后 5 拍（除法进行中）事件 (360,232) | (23,29) = (45−22, 29) |
| H12_BOUND_EV_NO_LOSS | 入队事件数 == 出队网格事件数 | ✓ |

### 4.5 事件不丢（全局）

每个用例组末尾 drain_check：`ev_cnt == cap_n`（喂入事件数 == o_grid_valid 拍数）且
`stat_cnt == tick_cnt`（每个窗沿恰好一次 o_stat_valid）。B9/C10/C15/D27/E17/F15/G3/H12 全 PASS。

---

## 5. (e) 时延（$time / 周期计数断言）  ✅

| CHECK | 判据 | 实测 |
|---|---|---|
| G1_STAT_LAT_LE5000 | 窗沿 → o_stat_valid ≤ 5000 clk_cam | **52 拍**（INFO_STAT_LAT_CYC=52；2×24 迭代除法 + 装载/发布开销） |
| G2_EV_LAT_LE4 | 稳态单事件 → o_grid_valid ≤ 4 拍 | **2 拍**（INFO_EV_LAT_CYC=2） |

5000 拍预算仅用时 1.04%；真实窗周期为 5,000,000 拍（NN_WIN_CYC），余量 4 个数量级。

---

## 6. (f) 综合：只跑 synth + opt，LUT 增量 ≤600、DSP=0、BRAM≤1  ✅

命令（TCL 无 BOM；run_awake 包裹防待机；`-tclargs` 未使用）：

```
cd retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/nn_winstat_synth.tcl \
  -log build/winstat_synth.log -journal build/winstat_synth.jou
=> VIVADO_RC=0
```

脚本内容：`read_verilog src/hdl/nn/nn_winstat.v` → `synth_design -top nn_winstat -part xc7a100tfgg484-2 -mode out_of_context`
→ `opt_design` → `report_utilization` + `report_timing_summary`。**没有** place/route/bitstream。

实测（build/winstat_util.rpt，Design State = Optimized）：

| 项 | 值 | 判据 |
|---|---|---|
| WINSTAT_LUT（Slice LUTs） | **549** | ≤600 ✅（余量 51） |
| 其中 LUT as Memory（分布式 RAM） | 18 | — |
| WINSTAT_FF（Slice Registers） | 626 | — |
| WINSTAT_DSP | **0** | =0 ✅ |
| WINSTAT_BRAM（Block RAM Tile） | **0** | ≤1 ✅ |
| WINSTAT_SYNTH_OK | **1** | ✅ |

综合日志中的 6 条 warning 均为 out-of-context 属性（无时钟缓冲/无时序约束/无 DSP/BRAM cell 匹配），
无 ERROR、无 CRITICAL WARNING。

---

## 7. 设计要点与已复盘的坑

1. **单时钟**：全部逻辑在 clk_cam（50 MHz），本模块没有 CDC（对齐 nn_top 单时钟域）。
2. **事件缓冲用分布式 RAM**：64 深 × 19 bit（tag 1 + pol 1 + y 8 + x 9）。
   第一版把写入放在带异步复位的 always 块里，Vivado 报
   `RAM is sensitive to asynchronous reset signal ... dissolved into registers`
   ⇒ LUT 781 / FF 1461。把存储写入拆成**不带复位**的独立 always 块后推断为分布式 RAM
   ⇒ LUT 549 / FF 626（LUTRAM 18）。这是本次唯一的综合返工点。
3. **除法器**：单串行 restoring（24 位分子 / 18 位分母，24 迭代 × 2 相），
   无 `/` 运算符、无乘法器 IP ⇒ DSP=0；n=0 不启动 ⇒ 无除零。
4. **窗口 epoch 标签**：FIFO 每项带 1 bit 窗口号；计算期内残留的上一窗事件用 shift_prev 弹出，
   新窗事件用 shift_cur，保证"每条事件用它所属窗口的位移"。
5. **首窗 Δ=0**：以 prev_valid 门控 o_dcx/o_dcy 与 shift 更新（TB B7/C9/D3/E1 断言）。
6. **不做 x/y 过滤**：统计以输入事件为准（上游 nn_feat 已过滤），写网格侧 clamp 兜住越界点；
   TB 的 x=400 边界点因此可以原样喂入。
7. **o_clamp_cnt**：16 位饱和计数（满后保持 0xFFFF）。

已知限制（写进后续集成注意事项）：

- 窗沿计算期 ≈52 拍内不接受新窗沿（`win_tick_fire = i_win_tick && !busy`）；实际窗周期 5,000,000 拍，无风险。
- 计算期 FIFO 最大积压 ≈52 条 < 64 深；超出会丢事件（TB 用入队=出队计数证明本任务场景不丢）。
- 本任务**只交付前端模块**，未接入 nn_top / top_retina_event（接口已按任务书冻结，接线属后续任务）。

---

## 8. 判据汇总

| 判据 | 值 | 依据 |
|---|---|---|
| TB_WINSTAT_OK | **1** | `run_sim.ps1 -Tb tb_nn_winstat` RUN_RC=0，TEST_RESULT=PASS，107/107 CHECK PASS，Errors 0 / Warnings 0 |
| WINSTAT_SYNTH_OK | **1** | VIVADO_RC=0，WINSTAT_SYNTH_OK=1，LUT 549 / DSP 0 / BRAM 0 |
| (a) 空窗 | ✅ | F1..F14 + A1..A7 + Z1 |
| (b) 单点 | ✅ | B1..B8 |
| (c) 已知 4 点 | ✅ | C1..C15（含 x/2 缩放说明） |
| (d) 3 窗 / 上一窗统计 / clamp | ✅ | D1..D27、E1..E17、H1..H12 |
| (e) ≤5000 拍 / 单事件 ≤4 拍 | ✅ | G1=52 拍、G2=2 拍 |
| (f) LUT≤600 / DSP=0 / BRAM≤1 | ✅ | 549 / 0 / 0 |

末行：

M3B_OK=1
