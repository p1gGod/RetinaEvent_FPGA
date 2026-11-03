# REPORT：录制质量门禁（QC）与数据集 v4

- 生成时间：2026-10-29 22:38:01 +0800
- 生成脚本：nn/build_dataset_v4.py（qc_clip.py 提供阈值/判定，build_dataset_v2.py 提供会话表/切分/窗口构建，extract_events.py 提供解析与 npz 写出）
- 数据根：E:\workspace\FPGA_Comp\row_datas\原始采集数据
- 数据集：E:\workspace\FPGA_Comp\nn\dataset_v4_w100.npz（win=100 ms，stride=50 ms，1729 窗，X_q (1729, 4, 30, 50)，X_counts (1729, 4, 30, 50)）
- 判定：**V4_OK=1**；会话 20 条（v2 已知 20 + rglob 新目录 0）；QC PASS 3 / FAIL 17

> 工程裁决：QC 的三档判定在 v4 里**只作协变量与警告，不作硬过滤**。密度 800~2,000 是「理想采集带」，不是历史数据不合格的判决；历史数据的价值是先训出可用网络，新数据到位后再按 qc_pass 加权/重训。

## 1. QC 阈值（单一来源 qc_clip.DEFAULT_THRESHOLDS，本脚本不复制数值实现）

| 阈值 | 值 | 含义 |
|---|---|---|
| density_min / density_max | 800 / 2000 ev/frame | 每帧事件数中位数的理想采集带 |
| active_duration_ms | 2000 ms | 活跃段最短时长 |
| swing_px | 120 px | 横向去趋势摆幅下限 |
| cycles | 3 | 完整摆动周期数下限（过零法/2） |
| active_ratio | 0.35 | 活跃帧占比下限 |
| active_frame_events | 60 ev/frame | 活跃帧判定阈值 |

## 2. 逐会话 QC 表（20 条会话逐条判定，可复核）

| # | 会话(后6位) | 类 | 源 | 判定 | 帧/活跃 | 时长/活跃(s) | 密度p50 | 摆幅x/y(px) | 横向度 | 周期 | 占比 | 原因 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 190957 | class1 | camera | FAIL | 76/43 | 4.76/1.73 | 112.0 | 129.8/110.6 | 0.540 | 3.0 | 0.566 | 每帧事件数中位 112.0 ev/frame < 下限 800（活跃帧均值 1,367 ev/frame）；活跃段 1.73s < 下限 2.00s |
| 2 | 191620 | class1 | camera | FAIL | 46/43 | 3.03/2.21 | 1,053.5 | 111.0/205.1 | 0.351 | 3.0 | 0.935 | 横向摆幅(去趋势质心) 111.0px < 下限 120px |
| 3 | 191905 | class1 | camera | FAIL | 97/59 | 4.72/3.06 | 523.0 | 144.0/173.5 | 0.454 | 2.5 | 0.608 | 每帧事件数中位 523.0 ev/frame < 下限 800（活跃帧均值 1,454 ev/frame）；完整摆动周期 2.5 < 下限 3（符号变化 5 次） |
| 4 | 194250 | class1 | camera | FAIL | 73/33 | 4.50/1.20 | 2.0 | 106.1/123.6 | 0.462 | 3.0 | 0.452 | 每帧事件数中位 2.0 ev/frame < 下限 800（活跃帧均值 1,868 ev/frame）；活跃段 1.20s < 下限 2.00s；横向摆幅(去趋势质心) 106.1px < 下限 120px |
| 5 | 194508 | class1 | camera | FAIL | 48/42 | 3.78/2.47 | 817.5 | 128.2/189.4 | 0.404 | 2.5 | 0.875 | 密度接近门限：每帧事件数中位 817.5 ev/frame；完整摆动周期 2.5 < 下限 3（符号变化 5 次） |
| 6 | 194707 | class1 | camera | FAIL | 111/41 | 4.85/2.20 | 3.0 | 129.1/79.5 | 0.619 | 2.5 | 0.369 | 每帧事件数中位 3.0 ev/frame < 下限 800（活跃帧均值 1,407 ev/frame）；完整摆动周期 2.5 < 下限 3（符号变化 5 次） |
| 7 | 192251 | class1 | camera | FAIL | 43/21 | 4.58/0.75 | 5.0 | 47.5/23.5 | 0.669 | 3.0 | 0.488 | 每帧事件数中位 5.0 ev/frame < 下限 800（活跃帧均值 2,192 ev/frame）；活跃段 0.75s < 下限 2.00s；横向摆幅(去趋势质心) 47.5px < 下限 120px |
| 8 | 192531 | class1 | camera | FAIL | 54/54 | 3.21/3.21 | 1,226.5 | 144.8/159.4 | 0.476 | 2.0 | 1.000 | 完整摆动周期 2.0 < 下限 3（符号变化 4 次） |
| 9 | 192720 | class1 | camera | FAIL | 111/72 | 4.87/3.45 | 927.0 | 189.5/148.3 | 0.561 | 1.5 | 0.649 | 完整摆动周期 1.5 < 下限 3（符号变化 3 次） |
| 10 | 195138 | class1 | camera | FAIL | 94/48 | 4.84/2.70 | 108.0 | 131.6/155.4 | 0.459 | 2.5 | 0.511 | 每帧事件数中位 108.0 ev/frame < 下限 800（活跃帧均值 1,369 ev/frame）；完整摆动周期 2.5 < 下限 3（符号变化 5 次） |
| 11 | 195348 | class1 | camera | FAIL | 31/30 | 1.63/1.07 | 956.0 | 116.3/180.3 | 0.392 | 3.0 | 0.968 | 活跃段 1.07s < 下限 2.00s；横向摆幅(去趋势质心) 116.3px < 下限 120px |
| 12 | 195624 | class1 | camera | FAIL | 118/58 | 4.87/3.22 | 32.5 | 179.8/166.9 | 0.519 | 3.0 | 0.492 | 每帧事件数中位 32.5 ev/frame < 下限 800（活跃帧均值 1,026 ev/frame） |
| 13 | 204439 | class1 | camera | PASS | 92/65 | 4.79/3.18 | 1,254.5 | 139.1/123.3 | 0.530 | 3.0 | 0.707 | — |
| 14 | 204709 | class1 | camera | FAIL | 104/57 | 4.86/2.74 | 147.0 | 228.0/105.4 | 0.684 | 5.0 | 0.548 | 每帧事件数中位 147.0 ev/frame < 下限 800（活跃帧均值 1,042 ev/frame） |
| 15 | 204054 | class1 | camera | PASS | 73/56 | 4.31/2.90 | 1,715.0 | 206.4/152.5 | 0.575 | 5.0 | 0.767 | — |
| 16 | 204214 | class1 | camera | PASS | 80/55 | 4.88/2.74 | 1,152.5 | 153.1/163.5 | 0.484 | 4.5 | 0.688 | — |
| 17 | 210102 | class2 | camera | FAIL | 113/74 | 4.86/2.76 | 3,229.0 | 239.9/151.0 | 0.614 | 3.5 | 0.655 | 每帧事件数中位 3,229.0 ev/frame > 上限 2,000（活跃帧均值 4,243 ev/frame；活跃帧 74/113） |
| 18 | 211950 | class2 | camera | FAIL | 127/98 | 4.88/4.24 | 3,046.0 | 176.6/211.4 | 0.455 | 7.0 | 0.772 | 每帧事件数中位 3,046.0 ev/frame > 上限 2,000（活跃帧均值 3,148 ev/frame；活跃帧 98/127） |
| 19 | 212036 | class2 | camera | FAIL | 128/94 | 4.83/3.48 | 2,420.0 | 260.9/130.8 | 0.666 | 5.0 | 0.734 | 每帧事件数中位 2,420.0 ev/frame > 上限 2,000（活跃帧均值 2,749 ev/frame；活跃帧 94/128） |
| 20 | 210307 | class0 | board_move | FAIL | 115/72 | 4.83/2.65 | 1,569.0 | 225.3/114.1 | 0.664 | 2.5 | 0.626 | 完整摆动周期 2.5 < 下限 3（符号变化 5 次） |

> 表内「摆幅x/y」「横向度」是**整段口径**（整段会话的活跃帧质心，qc_clip.motion_features），与逐窗特征（窗内全部帧）口径不同，不可混用。例：211950（class2 横向挥手）整段口径 swing_y=211.4px > swing_x=176.6px、horizontality=0.455 —— 说明那一段「横向挥手」其实上下漂得比左右还多，这是要重录的原因之一；而它的整段密度 p50=3,046 ev/frame，是判 FAIL 的**唯一**硬项（摆幅/周期/占比其余四项都过）。

## 3. 达标 / 不达标会话清单

- **PASS（3 条）**：204439(class1)、204054(class1)、204214(class1)
- **WARN（0 条）**：无
- **FAIL（17 条）**：
  - 每帧事件数中位：11 条 —— 190957、191905、194250、194707、192251、195138、195624、204709、210102、211950、212036
  - 完整摆动周期：7 条 —— 191905、194508、194707、192531、192720、195138、210307
  - 活跃段：4 条 —— 190957、194250、192251、195348
  - 横向摆幅(去趋势质心)：4 条 —— 191620、194250、192251、195348
  - 密度接近门限：每帧事件数中位：1 条 —— 194508

## 4. 类别计数：过滤前 vs 只保留 qc_pass 窗

| 类别 | 过滤前·窗 | 过滤前·会话 | 过滤后·窗 | 过滤后·会话 | 变化 |
|---|---|---|---|---|---|
| class0 | 823 | 1 | 115 | 0 | 823 → 115 |
| class1 | 701 | 16 | 160 | 3 | 701 → 160 |
| class2 | 205 | 3 | 0 | 0 | 205 → 0 |

- 合计：过滤前 1729 窗 / 20 会话 → 只保留 qc_pass 后 275 窗 / 3 会话（占 15.9% 窗）。
- 窗级密度落在理想采集带 [800, 2000] 内的比例：**17.3%**（仅供参考，不作过滤）。

<span style="color:red">**⚠ 红字警告：class2 只保留 qc_pass 窗后归零**（过滤前 205 窗 → 过滤后 0 窗）。硬过滤会让 class2 无法训练/评估，所以 v4 **不做硬过滤**，qc_pass 只作为协变量与加权依据。</span>

> 结论：**不做硬过滤**。v4 里 qc_pass=1 的窗只占 15.9%，若按它硬过滤，class2 会归零、class1 只剩 3 条会话，训练无从谈起。正确用法是新数据到位后按 qc_pass 做样本加权（或重建 v4 后重训），而不是删数据。

## 5. 逐窗协变量（字段定义与分布）

qc_pass / qc_verdict 是**会话级**判定按会话广播到窗（QC 的判定单位是会话：摆幅/周期/密度都是整段尺度）；其余均为**窗级**实测值，由 qc_clip.window_scalars(sess, t0, t1) 用与 QC 同一份运动公式（qc_clip.motion_features）算出，v4 脚本里没有第二套公式。

| 字段 | dtype | 定义 | p05 | p50 | p95 | min | max |
|---|---|---|---|---|---|---|---|
| density_p50 | float32 | 窗内每帧事件数中位数（ev/frame） | 0.0000 | 15.0000 | 3976.6000 | 0.0000 | 7196.0000 |
| active_frames | int16 | 窗内活跃帧数（frame_counts >= active_frame_events） | 0.0000 | 1.0000 | 3.0000 | 0.0000 | 4.0000 |
| swing_px | float32 | 窗内逐帧质心 x 线性去趋势后的 ptp（px） | 0.0000 | 0.0000 | 74.0301 | 0.0000 | 401.2632 |
| scalar_swing_x | float32 | swing_x / s，s=max(窗内事件 x/y 的 p95-p05)（clamp>=1），无量纲 | 0.0000 | 0.0000 | 0.2985 | 0.0000 | 2.6692 |
| scalar_horiz | float32 | swing_x/(swing_x+swing_y)，无量纲，∈[0,1] | 0.0000 | 0.0000 | 0.9049 | 0.0000 | 0.9968 |
| qc_pass | uint8 | 会话判定==PASS 则 1（会话级广播） | — | — | — | 0 | 1 |
| qc_verdict | <U5 | 会话判定字符串（会话级广播） | — | — | — | FAIL/PASS |  |

## 6. 会话级切分自检

- SESSION_SPLIT_PASS=1（同一会话的窗绝不跨 train/test）。train 窗 1540，test 窗 189；test 会话（v2 固定留出）：retina-events-20261029-191905、retina-events-20261029-192720

## 7. 新增目录 / rglob 补入

- 递归扫描 E:\workspace\FPGA_Comp\row_datas\原始采集数据/**/retina-events-*.csv：v2 已覆盖 20 条，本次 rglob 新增 0 条，无法判类 0 条。
- 本次没有出现 v2 会话表之外的新 CSV（新增目录数据会自动经 rglob 进入，已存在路径按 normcase 去重）。

## 8. dataset_v4 npz 字段

- 本构建校验的必需字段 28 个：X_counts, X_q, y, file, session, group, action, file_idx, seg_id, seg_start_frame, seg_end_frame, t_ms, win_ms, stride_ms, split_reason, source, split, split_mode, group_assumption, cls, class_name, density_p50, active_frames, swing_px, qc_pass, qc_verdict, scalar_swing_x, scalar_horiz
- X_counts uint16 (1729, 4, 30, 50)、X_q int8 (1729, 4, 30, 50)，通道 = ('ON_now', 'OFF_now', 'ON_prev', 'OFF_prev')；y uint8 三类（0/1/2）。
- 与 v3 的关系：X/y/窗口位置逐窗一致（同 build_dataset_v2.build_v2 与 extract_events.build_dataset），v4 只**追加**协变量字段，不改 v3 文件。

## 9. 自检结果（机读）

- SESSIONS_FOUND = 1
- NO_UNKNOWN_DIR = 1
- QC_ALL_SESSIONS_SCORED = 1
- QC_VERDICT_VALID = 1
- WINDOW_CONSERVATION = 1
- COVARIATE_ALIGN = 1
- COVARIATE_LENGTHS = 1
- SESSION_SPLIT_PASS = 1
- CLASS2_ALIVE_IN_FULL = 1
- NPZ_FIELDS_OK = 1

## 10. 融合训练

<!-- FUSION_SECTION_BEGIN -->
**融合训练（详见 nn/REPORT_融合与裁决.md）**

- 会话级 LOO 20 折，固定 test 会话 191905/192720 永不进训练。
- 3 分类 LOO 汇总：CNN-only bal=0.7398（c0/c1/c2 R = 0.928/0.813/0.478）；CNN+标量 bal=0.7453（0.930/0.809/0.498）。
- lead 硬门槛：FAIL；M5 文档口径：FAIL。
- 两分类回退 B1（class1 vs 其余）：balanced=0.8501。
- 标量增量：Δclass2=+1.95 pp、Δbal=+0.55 pp ⇒ 标量分支不值得上 RTL（增量 < 3 pp，不足以抵消 RTL 面积/时序成本）
- ROM：7700 字（5718 前缀不变 + 1982 融合头），地址表见 nn/REPORT_融合与裁决.md 第 5 节。

<!-- FUSION_SECTION_END -->

## 11. 新数据到手后的命令

~~~bash
cd E:/workspace/FPGA_Comp/nn
# 1) 先验新录像是否达标（目录递归；最后一行是汇总 JSON）
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe qc_clip.py "E:/workspace/FPGA_Comp/row_datas/原始采集数据"
# 2) 重建 v4 数据集（自动 rglob 收进新目录）
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe build_dataset_v4.py
# 3) 重训融合管线（会话级 LOO + out_v4 产物）
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe train_fusion.py
~~~

