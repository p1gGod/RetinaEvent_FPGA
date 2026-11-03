TB_WINFEAT_OK=1
WINFEAT_SYNTH_OK=1
REGRESS_17TB_OK=1

# EVIDENCE_M3d — M3d 窗级部署特征前端（nn_winfeat）+ nn_winstat 累加扩展

task-48 / rtl2 / 2026-10-31。末行 M3D_OK=1。

---

## 0. 交付物与改动清单

| 文件 | 状态 | 行数 | md5 | 说明 |
| --- | --- | --- | --- | --- |
| src/rtl/nn/nn_winfeat.v | 新增 | 579 | dc4c1c62b7a90a4c270212bbb4edf3f9 | 4 个 module：nn_winfeat_mul / nn_winfeat_div / nn_winfeat_sqrt / nn_winfeat 顶层 |
| src/rtl/nn/nn_winstat.v | 改（仅加累加与快照输出） | 550 | 0c917b9e8386e20192723b7a0ccfe390 | 新增 Σx²/Σy² 累加 + o_snap_* 快照总线；既有端口语义未动 |
| sim/tb/tb_nn_winfeat.v | 新增 | 527 | 867192b7384c0921ccdd3ce01e9faf79 | phase1（18 组向量）+ phase2（9 个真实窗端到端） |
| sim/tb/tb_nn_winfeat.f | 新增 | 2 | ee637ed38f25944c51a57ba19f041d81 | src/hdl/nn/nn_winfeat.v + src/hdl/nn/nn_winstat.v |
| build/nn_winfeat_synth.tcl | 新增 | 55 | 11f991af1bdcd557c14c50b367b6a5e0 | synth+opt（不 place/route），模块名由 -tclargs 传（必须放最后） |
| build/gen_winfeat_golden.py | 新增 | 164 | 2cce54a9e61b7db7a46aadbba18875f9 | phase1 golden 生成器（读 nn/v7/intwin.py 语义） |
| sim/nn/EVIDENCE_M3d.md | 本文件 | — | — | — |

未改：nn_cfg.vh（本次不需新常量）、nn_engine.v、nn_feat.v、nn_top.v、nn_decide.v、top_retina_event.v、comms/**、prj/**。
（git status 里 nn_cfg.vh / nn_feat.v / nn_top.v / tb_nn_top.* 的改动来自 task-40/43，不是本卡。）

## 1. 权威参考实现（唯一真值，逐行抄录）

- nn/v7/intwin.py:65-100 subblock_stats()、:103-156 window_stats()（窗口统计整数定义）
- nn/v7/v7_feats.py:30-36 isqrt_arr()、:39-44 trunc_div()、:47-48 clip127()、:138 S、:145-151 REL_SUBSET、:222-258 python_row()
- nn/out_v7/INT8_CONTRACT.md（sha256 d321fa17…）：§2.2 第 59-113 行已逐条核对，与本卡实现**无出入**；§8 第 323 行「前端只需额外输出一个 S」指 S 只参与 dx_rel/dy_rel、不必对外输出 sx/sy —— 本实现把 S 完全留在 nn_winfeat 内部，符合该口径。
- 板上节奏（Lead m01939 裁决）：**100 ms 不重叠单窗**；训练侧 WIN_MS=100/STRIDE_MS=50 属训练增广，非板上节奏。

### 1.1 逐位公式（板侧实现口径）

    n   = NON + NOFF                  # Σ 不分极性（intwin.py:16-27）
    on  = NON ; off = NOFF
    Sx  = SX_on + SX_off ; Sy = SY_on + SY_off
    Sx2 = SX2 ; Sy2 = SY2             # 平方和按全体事件累加，不分极性
    if n > 0:
        cx = Sx // n                   # floor（无符号整除）
        cy = Sy // n
        varx = max(Sx2*n - Sx*Sx, 0)   # 负数截 0
        vary = max(Sy2*n - Sy*Sy, 0)
        den  = n*n
        sx = isqrt(varx // den)        # floor 除法 -> floor 开方
        sy = isqrt(vary // den)
    else:
        cx, cy 保持上一有效质心（首窗 200 / 120）；sx = sy = 0
    pcx, pcy = 上一窗 cx/cy（首窗 200 / 120）
    prev_n   = 上一窗 n（首窗 0）
    S        = max(isqrt(sx*sy), 8)    # 兜底 8，永不除零
    n_div16      = min(127, n >> 4)
    prev_n_div16 = min(127, prev_n >> 4)
    pol_bal      = clip127( trunc_div((on-off)*127, max(n,1)) )   # 向零截断
    dx_raw = cx - pcx ; dy_raw = cy - pcy
    dx = clip127(dx_raw >> 2) ; dy = clip127(dy_raw >> 1)         # 算术右移 = floor
    dx_rel = clip127((dx_raw << 6) // S) ; dy_rel = clip127((dy_raw << 6) // S)   # floor
    clip127(v) = max(-127, min(127, v))

## 2. 判据 (a)：golden 与窗口数（共 27 窗，要求 ≥12）

- phase1：18 组统计量向量，由 tool/gen_winfeat_golden.py 用 intwin.py 语义生成并交叉校验。
- phase2：9 个训练侧真实窗（nn/out_v7/golden_vectors.json 的 preprocess_vectors，经 tb_golden_v7.vh 内嵌）。

### 2.1 phase1 生成器自校验

命令：cd retina_event/build && ../../trainingData/.venv/Scripts/python.exe gen_winfeat_golden.py（交付副本 tool/gen_winfeat_golden.py），输出：
CROSSCHECK checked=840 bad=0（120 个随机窗 / 6000 事件；用 intwin.py 与「从累加量按公式重算」两路对比 cx/cy/sx/sy/pcx/pcy/prev_n 共 840 项，0 差异）。
覆盖面统计：VECTORS=18 neg_dx=10 floor_differs_from_trunc=6 neg_pol=4 rel_clip=9 ndiv16_clip=4
（18 组里 10 组 dx 为负、6 组能区分 floor 与 trunc、4 组 pol_bal 为负、9 组 dx_rel/dy_rel 被夹到 ±127、4 组 n_div16 饱和到 127。）
18 组类别：空窗 / 单事件(n=1) / 两角点 / 矩形 / 高斯 / n=4000 / 负 dx 夹 / 正 dx 夹 / 极小方差(S=8) / 边缘线 / 全 OFF / 全 ON / 远三点 / n=200 / 小簇 / n=1200 / n=5000 / 交替点。

TB 内联 VEC[i]=234'h…（LSB 起：prev_n[17:0],pcy[7:0],pcx[8:0],cy[7:0],cx[8:0],sy2[39:0],sx2[39:0],sy[24:0],sx[24:0],off[16:0],on[16:0],n[17:0]）与 EXP[i]=56'h…（LSB 起：n_div16,prev_n_div16,pol_bal,dx,dy,dx_rel,dy_rel）。

phase1 CHECK：18×13 + 5（复位）= **239 条全 PASS**；INFO_CYC_MAX=505。

## 3. 判据 (a)/(b)：phase2（nn_winstat → nn_winfeat 端到端，9 窗，171 条 CHECK）

TB 结构：u_ws（nn_winstat）收事件 → 窗沿 → o_snap_* → u_feat_pp（nn_winfeat）出 7 路特征；逐窗对拍①14 项统计量（n/on/off/Σx/Σy/Σx²/Σy²/本窗质心/上一窗 pcx/pcy/prev_n，统计量另用 TB 独立累加器求和）②7 路特征对 GV_PP_FEAT。

| # | 向量名 | n | RTL 7 路特征 | golden | cyc |
| --- | --- | --- | --- | --- | --- |
| 0 | pp01_centroid_floor w0 | 6 | 00_00_00_01_ec_05_cd | 同 | 504 |
| 1 | pp01_centroid_floor w1 | 6 | 00_00_00_02_05_13_13 | 同 | 504 |
| 2 | pp02_n_zero_carry w0 | 3 | 00_00_2a_f4_ee_81_81 | 同 | 504 |
| 3 | pp02_n_zero_carry w1 | 0 | 00_00_00_00_00_00_00 | 同 | 1 |
| 4 | pp03_clamp_and_sat w0 | 128 | 08_00_7d_31_3b_7f_7f | 同 | 504 |
| 5 | pp03_clamp_and_sat w1 | 128 | 08_08_81_9c_88_81_81 | 同 | 504 |
| 6 | pp04_square_hand w0 | 25 | 01_00_fb_f1_f6_81_d2 | 同 | 504 |
| 7 | pp05_slender_hand w0 | 15 | 00_00_f8_f1_fb_81_d2 | 同 | 504 |
| 8 | pp06_var_tiny_S_floor w0 | 12 | 00_00_00_00_00_00_00 | 同 | 504 |

9/9 窗逐位相等（TEST_RESULT=PASS，INFO_CHECK_TOTAL=410 = phase1 239 + phase2 171），RC=0。
n=0 的空窗 pp02 w1：o_snap_cx/cy 保持 w0 的 154/85、o_snap_pcx/pcy=154/85、7 路特征全 0 —— 与 intwin「n=0 保持上值」一致。
pp03 两窗现在是事件域内极值构造：w0 质心 (399,239) → dx=49/dy=59、dx_rel/dy_rel 夹到 +127；w1 质心 (0,0) → dx=-100/dy=-120、rel 夹到 -127；S 两窗都是 8（同格展布）。

## 4. 判据 (b)：边界用例覆盖

| 边界 | 覆盖方式 | 结果 |
| --- | --- | --- |
| n=0（保持上值、dx/dy=0、不除零） | phase1 空窗向量 + phase2 pp02 w1 | PASS |
| n=1 | phase1 单事件向量 | PASS |
| S 被 8 兜底（var=0） | phase1 极小方差向量 + phase2 pp06（同格展布） | PASS |
| pol_bal 正负截断方向 | phase1 neg_pol=4、floor≠trunc=6 组 | PASS |
| dx_rel/dy_rel 超 ±127 clip | phase1 rel_clip=9 组 + phase2 pp03 两窗（±127） | PASS |
| Σx²·n 大值不溢出 | phase1 n=4000 / n=5000 组（Σx²·n 达 3.2e9~2.0e10，仍在 59 位内）+ phase2 pp03 n=128 全 399/全程 0 | PASS |
| dx/dy 本身超 ±127 | 物理不可达（|dx_raw|≤399 ⇒ dx≤99；|dy_raw|≤239 ⇒ dy≤119），clip 保留防越界 | 说明性 |

## 5. 判据 (e)：位宽推导与每窗周期实测

### 5.1 位宽推导

nn_winstat 现状：n_on/n_off 各 17 位饱和（n 合计 18 位）、Σ 分极性 24 位饱和（合计 25 位中间和）、Σx²/Σy² 40 位饱和。

| 量 | 本实现宽度 | 上界推导 |
| --- | --- | --- |
| n（n_on+n_off） | on/off 各 17 位饱和 → n 18 位 | 上界 2^17+2^17，18 位 |
| on / off | 17 位饱和 | 每窗每极性事件数 |
| Σx / Σy | 24 位饱和 + 25 位中间和 | 饱和线 1.67e7 可容纳 n≤41900 个 x=399；物理 n≈数千 |
| Σx² / Σy² | 40 位饱和 | 399²×2^17=2.1e10 < 2^36，饱和线 2^40 留 16× 余量 |
| n² | 36 位 | 18×18 |
| Σx²·n | 58 位（乘法器输出 59 位） | 2^40×2^18=2^58 |
| (Σx)² | 50 位 | 25×25 |
| var_num = Σx²·n−(Σx)² | ≤58 位 | 被减数上界 |
| |on−off|·127 | 24 位 | 2^18×127≈3.3e7 |
| |dx|<<6 | 15 位 | ≤399×64=25536 |
| sx / sy（isqrt 输出） | 8 位实际（乘法器 10 位） | isqrt(var≤40000)≤200 |
| S = isqrt(sx·sy) | 10 位 | sx,sy≤200 ⇒ 积≤40000 |
| 商（varx//n² 等） | 59 位寄存器（保守，见 §8 可优化点） | varx//n² ≤ 40000 |
| 7 路特征 | 8 位 int8 补码 | clip127 |

该宽度集合是 INT8_CONTRACT.md §2.2 第 96-97 行建议（n≤2^11、Sx2/Sy2≤2^29、Sx2*n<2^42）的**保守超集**，无语义冲突。

### 5.2 每窗周期实测

- 非空窗：o_cyc_cnt=504 拍 = 10.08 us @50 MHz（预算 ≤1500 拍，占 100 ms 窗 0.010%）；phase1 INFO_CYC_MAX=505（含启动拍）。
- 空窗（n=0）：1~2 拍（跳过 6 乘 5 除 3 开方）。
- 构成：6 次乘法（25 迭代）+ 5 次除法（59 迭代）+ 3 次开方（10 迭代）+ 控制开销 ≈ 150+295+30+29 = 504。
- 三个算术单元另有 scratch 单元 TB（sim/tb/tb_winfeat_unit.v/.f，调试用、未列入交付物）：mul 9 例 / div 6 例 / sqrt 14 例全 PASS（其中 2 例首版期望值是我写错，BigInt 复核后修正）。

## 6. 独立佐证：旧 golden 的 pp03 含 1 个硬件不可表达事件（已由 coder3 修复）

现象：旧 golden（tb_golden_v7.vh sha256 704cd978…）下 phase2 只有 pp03 两窗失配（PP4_DX/PP4_DX_REL/PP4_DY_REL、PP5_DX/PP5_DX_REL），其余 7 窗逐位相同。

根因：旧 golden_vectors.json 的 preprocess_vectors[2]（pp03_clamp_and_sat）含 1 个事件 x=-7（全集合唯一负坐标；另有 1 个 x=402>399）。事件 x 字段 9 bit 无符号（0..511，真实传感器 0..399）⇒ 硬件只能表达 505（9'b1_1111_1001），参考实现按 python int 累加 -7（Σx² 记 49，硬件记 255025）。

数值链（当时 TB 日志 PPDBG4/PPDBG5）：
- pp03 w0：hw Σx=20507（cx=205）；ref Σx=19995（cx=199）⇒ dx=+1(hw) vs −1(ref)；hw w0 = 06_00_00_01_fe_0a_fa
- pp03 w1：hw Σx=20000（cx=200，pcx=205）⇒ dx=−2；ref cx=200（pcx=199）⇒ dx=0；hw w1 = 06_06_00_fe_01_d8_18

**用参考公式把该事件按无符号 505 重算，得到 w0=[6,0,0,1,-2,10,-6]、w1=[6,6,0,-2,1,-40,24]，与 RTL 实测逐字节相同**（同一次重算 signed=True 则复现旧 golden [6,0,0,-1,-2,-3,-7] / [6,6,0,0,1,8,24]）。
⇒ 结论：nn_winstat/nn_winfeat 的累加、除法方向、开方、饱和、位宽全部正确；差异只来自测试向量的不可表达输入。

处置（Lead m02291 裁决 A）：coder3 已改 gen_golden.py（事件域校验 x∈[0,511]/y∈[0,255]/pol/t 单调；pp03 改事件域内极值构造）并重生成 golden_vectors.json + tb_golden_v7.vh（GVEMAX 100→128，pp03 两窗各 128 事件；INT8_CONTRACT.md §7 记「x=-7 已删除」）。新 sha256：
- nn/out_v7/golden_vectors.json = 4f87125e6ea957c4fe25d248c07610647a628852c6f470915f2bf9e652329f94
- nn/out_v7/tb_golden_v7.vh = 017f78338c3836342a50eef330a35a990570bad771187a24ff281104af4ed5ca（= sim/tb/tb_golden_v7.vh，逐字节相同）
- 部署件未变：nn_params_v7.json = e61d26da…、nn_rom_data_v7.v = 316ba006…
重生成后本 TB 未改断言即 9/9 逐位相等（§3）。本段保留为「实现与参考公式在边界一致」的独立佐证。

## 7. n=0 的 cx/cy carry 与上电初值 (200,120) 的验证方式

- RTL：复位块 prev_cx <= CX_CENTER（=NN_IMG_W/2=200）、prev_cy <= CY_CENTER（=120）；仅在非空窗（win_nz）发布时更新，空窗保持。
- TB 三层验证：
  1. 上电初值：每个 case 用 pp_case_start 复位（rst_n_cam 低 6 拍）+ TB 侧 carry 变量置 tb_pcx=200/tb_pcy=120/tb_prev_n=0；随后第一个窗断言 o_snap_pcx==200 && o_snap_pcy==120 && o_snap_prev_n==0（6 个 case 各一次）。
  2. carry（n=0 保持）：pp02 的 w1 为空窗（GV_PP_EN=0）：断言 o_snap_cx==154 && o_snap_cy==85（=w0 质心，未归零/未回中心）、o_snap_pcx==154（下一窗的「上一窗质心」=被保持的质心，与 intwin 的 pcx=[200]+cx[:-1] 一致）、7 路特征全 0。
  3. pcx/pcy 每窗推进：phase2 每窗都把 o_snap_pcx/pcy/prev_n 与 TB 自己维护的 carry 变量对拍（w0 的 cx 成为 w1 的 pcx…），9 个窗口逐一对上。
- phase1 另用 VEC 直接注入 pcx/pcy/prev_n，覆盖「任意上一窗值」（不受 carry 链约束）。

## 8. 判据 (c)：资源（synth+opt，不 place/route）

命令（两次运行均 exit 0；Vivado 2020.2，part xc7a100tfgg484-2，-mode out_of_context）：

    cd retina_event
    pwsh -File ../temp_test/run_awake_cmd.ps1 E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
      -source tool/nn_winfeat_synth.tcl -log build/nn_winfeat_synth.log -journal build/nn_winfeat_synth.jou -tclargs nn_winfeat
    ... -tclargs nn_winstat（同模板，日志 build/nn_winstat_synth.log）

| 模块 | LUT | LUT as Mem | FF | DSP | BRAM |
| --- | --- | --- | --- | --- | --- |
| nn_winfeat（新） | 1068 | 0 | 1562 | 1 | 0 |
| nn_winstat（M3d 后） | 857 | 26 | 1035 | 0 | 0 |
| nn_winstat（task-40 基线） | 549 | 18 | 626 | 0 | 0 |
| **Δ（winfeat + winstat 差）** | **1376** | — | **1971** | **1** | **0** |

- 对比判据：ΔLUT 1376 > 800（超 576）；ΔDSP 1 ≤ 2 ✓；ΔBRAM36 0 ≤ 1 ✓。
- **Lead 批准口径（m02333 原文）**：『预算是估计值，实测 1376，超预算 576；经 Lead 批准按实测值收口，全系统增量在 M3e 用完整 nn_top 复测。』
- 成本构成（post-synth cell 数）：u_div 1016 / u_mul 588 / u_sqrt 200 / 顶层合计 3073 cells。瓶颈是 59 位 restoring 除法器（58 位分子 var_num）。可优化点（记录、本版不做）：换「先移位再除」或迭代收敛式开方。
- **LUT 口径**：OOC synth 与全系统 synth 不可直接相加（共享逻辑会被优化），+1376 只是**上界估计**；M3e 必须给全系统 synth 实测增量，基准 = act3c synth 基线 21,518 LUT / 12,058 FF / 87 BRAM / 7 DSP（同阶段比）。
- **护栏（Lead m02333）**：若 M3e 全系统 synth 后 LUT > 24,500（38.6%）或 FF > 14,500（11.4%），或 M3f impl 后 WNS < 0 / Slices > 8,500（61%），再回头考虑缩位宽方案 B（quotient 59→24、mul B 25→18、Σx²/Σy² 40→32）。现在不做。

## 9. 判据 (d)：既有 17 个 TB 回归

命令模板：cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>；汇总日志 build/regress_m3d.log。

| TB | RC | TB | RC |
| --- | --- | --- | --- |
| tb_act3_hdr | 0 | tb_uart_baud | 0 |
| tb_act3_tlv | 0 | tb_uart_link | 0 |
| tb_nn_feat | 0 | tb_stall_repro | 0 |
| tb_nn_engine | 0 | tb_udp_mtu_cap | 0 |
| tb_nn_top | 0 | tb_top_retina_event | 0 |
| tb_udp_merge | 0 | tb_nn_winstat | 0 |
| tb_wire_v3 | 0 | tb_act3_idleclr | 0 |
| tb_downlink_cmd | 0 | tb_act3_ctrlhdr | 0（首轮见下注） |
| tb_nn_integ | 0 | | |

首轮并发跑回归时，我在启动 tb_nn_winfeat 前执行了 taskkill //IM vsim.exe 清场，把当时正在跑的 tb_act3_ctrlhdr 误杀（日志缺 TEST_RESULT ⇒ RC=1）；单独复跑 tb_act3_ctrlhdr：EXIT=0、TEST_RESULT=PASS、21 条 CHECK 全 PASS。这是我这边的操作事故，不是回归失败。

## 10. 复现记录（命令 + 退出码）

| 项 | 命令 | 退出码 / 结果 |
| --- | --- | --- |
| 本卡 TB | cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_winfeat | EXIT=0，TEST_RESULT=PASS，410/410 CHECK PASS |
| synth | 见 §8 两条 vivado -source tool/nn_winfeat_synth.tcl ... -tclargs <mod> | 两次 exit 0，均打印 <MOD>_SYNTH_OK=1 |
| 回归 | 见 §9 | 17/17 RC=0（含 ctrlhdr 单跑修正） |

## 11. 结论

- nn_winfeat 在 clk_cam 单时钟、串行复用 1 乘 1 除 1 开方，504 拍/窗（预算 1500），把训练侧 7 路 fmin_n_rel7 特征逐位复现；nn_winstat 只增加 Σx²/Σy² 累加与窗末快照，既有端口语义不变。
- 27 个窗口（18 向量 + 9 真实窗）逐位对拍；两处除法方向（trunc vs floor）、S 兜底 8、n=0 carry 与首窗 (200,120) 全部按 intwin.py / v7_feats.py 验证。
- 资源 ΔLUT 1376（超预算 576）经 Lead 批准按实测收口；M3e 需用全系统 synth 复测并受 §8 护栏约束。
- nn_winfeat 尚未接入 nn_top（M3e/task-51），因此全系统 synth/impl 目前看不到它。

---

M3D_OK=1
