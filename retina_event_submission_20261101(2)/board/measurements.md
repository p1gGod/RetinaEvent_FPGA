# 板上实测与离线参考比对

结论：板上 act3c 共输出 118 条动作事件，离线同源回放 116 条，差值为 +2。逐段数字与出处见第 2 节和第 7 节。

- 生成命令：python board/extract_measurements.py，仅用标准库，路径以本脚本为基准。
- 复跑记录：`board/evidence_board_doc.log`，含命令、条目数与全部自检结果。
- 数字口径：板上为 act3c 位流实测，离线为 v5 权重同源回放。
- 引用格式：源文件:行号，逐条条目见第 7 节抽取索引。

## 1 位流身份

本工程保留四个可对照的位流版本，其中只有 act3c 已上板并产生动作事件。act3 曾于 2026-10-29 23:32 烧板验证通路，act3b 与 act7 均未烧板。位流大小与 md5 由脚本对文件直接计算，并与下表出处逐字比对。

| 版本 | 位流大小（B） | md5 | 构建或烧录时间 | 上板 | 权重 | 源 |
|---|---|---|---|---|---|---|
| act3 | 2,909,183 | ce8685419b95417c347fe5d3b31aa0f7 | 2026-10-29 23:32 烧录 | 是 | v4 两分类 | `sim/nn/EVIDENCE_M4C.md:39`；`docs/06_facts/01_fact_register.md:617`；`docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:213` |
| act3b | 2,675,095 | 361713e0a455e5c1436365fe39dbd821 | 2026-10-29 构建 | 否 | v4 两分类 | `docs/06_facts/00_current_status.md:298`；`docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:213` |
| act3c | 2,890,875 | a5fff751e20019d7e80a3a953f7f8c5a | 2026-10-30 21:10:36 烧录 | 是 | v5 两分类 + byte23 修复 | `docs/06_facts/00_current_status.md:28` |
| act7 | 2,835,423 | 9c13668c029c9d3a248cf69cbec03582 | 2026-10-31T00:46:42 至 2026-10-31 00:56:48 | 否 | v7（7 路全局量 + 256 输入 fc） | `sim/nn/EVIDENCE_M3f.md:5`；`sim/nn/EVIDENCE_M3f.md:40` |

act3 与 act3b 的权重为 v4 两分类，两者构建均早于 v5 ROM 落盘（源：`docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:213`）。act7 为 v7 链路首次完整构建，默认流程一次收敛（源：`sim/nn/EVIDENCE_M3f.md:20`）。

## 2 act3c 上板实测与离线参考逐项比对

板上实测来自会话 records/20261030-212214_v5probe，采样时长 432.143 s。离线参考用 v5 权重对同一事件流逐窗回放并逐段统计。原始比对输出见 [board_vs_offline_v5.md](board_vs_offline_v5.md)。

| 区段 | 板上 | 离线 | Δ | confident | phase-drift | isolated 板 | isolated 离线 | Δt p50（ms） | Δt p90（ms） | 源 |
|---|---|---|---|---|---|---|---|---|---|---|
| 空桌面 | 0 | 0 | +0 | 0 | 0 | 0 | 0 | - | - | `board/board_vs_offline_v5.md:13` |
| 无人 | 1 | 1 | +0 | 1 | 0 | 0 | 0 | 55.0 | 55.0 | `board/board_vs_offline_v5.md:14` |
| 开合 | 61 | 60 | +1 | 53 | 4 | 4 | 3 | 71.0 | 317.4 | `board/board_vs_offline_v5.md:15` |
| 手静止 A | 0 | 1 | -1 | 0 | 0 | 0 | 1 | - | - | `board/board_vs_offline_v5.md:16` |
| 换手 | 8 | 7 | +1 | 7 | 0 | 1 | 0 | 61.0 | 442.8 | `board/board_vs_offline_v5.md:17` |
| 手静止 B | 0 | 0 | +0 | 0 | 0 | 0 | 0 | - | - | `board/board_vs_offline_v5.md:18` |
| 挥手 | 47 | 46 | +1 | 23 | 23 | 1 | 0 | 61.0 | 358.6 | `board/board_vs_offline_v5.md:19` |
| 结束段 | 1 | 1 | +0 | 1 | 0 | 0 | 0 | 434.0 | 434.0 | `board/board_vs_offline_v5.md:20` |
| 合计 | 118 | 116 | +2 | 85 | 27 | 6 | 4 | - | - | `board/board_vs_offline_v5.md:21` |

- 记录链：板上文件记录 121 条，保留 120 条。录制内有效 118 条，离线 pulse 116 条。
- 对齐：frame_offset 为 1793365856477.0 ms，最近帧残差中位数 9.0 ms，校正量为 -9.0 ms。
- 离线参数：窗口 8,641 个、决策点 4,320 个、g0 为 37 ms、offset 为 2。
- confident 配对 85 对；开合段 p50 71.0 ms、p90 317.4 ms，各区段见上表。
- phase-drift 27 对单独统计，不并入 p50 与 p90。
- isolated 事件 6 条只在板上、4 条只在离线。

## 3 时序与资源实测

结论：act3c 最终布线 WNS 为 +0.306 ns，act7 为 +0.059 ns，两者 TNS 与 THS 均为 0。act7 的 LUT 比 act3c 多 1,812 个，FF 多 2,475 个，BRAM 与 IOB 持平。

### 3.1 时序

| 指标 | act3c | act7 | 源 |
|---|---|---|---|
| WNS（ns） | +0.306 | +0.059 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |
| TNS（ns） | 0.000 | 0.000 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |
| WHS（ns） | +0.036 | +0.027 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |
| THS（ns） | 0.000 | 0.000 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |
| setup 端点 | 76,854 | 84,405 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |
| hold 端点 | 76,831 | 84,382 | `build/variant_act3c/timing_deliver.rpt:131`；`build/variant_act7/inproc_timing.rpt:131` |

act3c 时序取 timing_deliver.rpt。同目录 inproc_timing.rpt 的 WNS -0.175 ns 属中间版，不采用（源：`sim/nn/EVIDENCE_M2E.md:158`）。

### 3.2 资源占用

| 资源 | act3c | 占比 | act7 | 占比 | 源 |
|---|---|---|---|---|---|
| LUT | 20,559 | 32.43% | 22,371 | 35.29% | `build/variant_act3c/inproc_util_impl.rpt:34`；`build/variant_act7/inproc_util_impl.rpt:34` |
| FF | 11,850 | 9.35% | 14,325 | 11.30% | `build/variant_act3c/inproc_util_impl.rpt:39`；`build/variant_act7/inproc_util_impl.rpt:39` |
| Slice | 7,327 | 46.23% | 7,968 | 50.27% | `build/variant_act3c/inproc_util_impl.rpt:72`；`build/variant_act7/inproc_util_impl.rpt:72` |
| BRAM Tile | 87 | 64.44% | 87 | 64.44% | `build/variant_act3c/inproc_util_impl.rpt:104`；`build/variant_act7/inproc_util_impl.rpt:104` |
| DSP | 7 | 2.92% | 8 | 3.33% | `build/variant_act3c/inproc_util_impl.rpt:119`；`build/variant_act7/inproc_util_impl.rpt:119` |
| IOB | 140 | 49.12% | 140 | 49.12% | `build/variant_act3c/inproc_util_impl.rpt:130`；`build/variant_act7/inproc_util_impl.rpt:130` |

act3c 布线 DRC 为 95 条警告、0 错误；act7 为 98 条警告、0 错误（源：`sim/nn/EVIDENCE_M2E.md:128`；`sim/nn/EVIDENCE_M3f.md:141`）。

### 3.3 器件容量

| 资源 | 容量 | act3c | act7 | 源 |
|---|---|---|---|---|
| LUT | 63,400 | 20,559 | 22,371 | `build/variant_act3c/inproc_util_impl.rpt:34` |
| FF | 126,800 | 11,850 | 14,325 | `build/variant_act3c/inproc_util_impl.rpt:39` |
| Slice | 15,850 | 7,327 | 7,968 | `build/variant_act3c/inproc_util_impl.rpt:72` |
| BRAM Tile | 135 | 87 | 87 | `build/variant_act3c/inproc_util_impl.rpt:104` |
| DSP | 240 | 7 | 8 | `build/variant_act3c/inproc_util_impl.rpt:119` |
| IOB | 285 | 140 | 140 | `build/variant_act3c/inproc_util_impl.rpt:130` |

容量取自 xc7a100tfgg484-2 数据手册，与登记册逐项一致（源：`docs/06_facts/02_metric_register.md:27`）。

## 4 事件流健康

四次录像的采集侧计数均为 0 丢帧与 0 丢事件。事件率与事件密度取自统计文件，并与各录像目录 meta.json 的计数器交叉核对一致。

| 会话 | 帧数 | 事件数 | 采样时长（s） | 事件/秒 | 事件/帧 | 丢帧 | 丢事件 | 源 |
|---|---|---|---|---|---|---|---|---|
| v5probe（act3c 实测） | 11,516 | 10,312,327 | 432.143 | 23863.23 | 895.48 | 0 | 0 | `report/evidence/event_stream_stats.json:8`；`records/20261030-212214_v5probe/meta.json:29` |
| v6clean384（短会话） | 587 | 2,052 | 21.978 | 93.37 | 3.5 | 0 | 0 | `report/evidence/event_stream_stats.json:45`；`records/20261030-214353_v6clean/meta.json:21` |
| v6clean | 5,174 | 6,012,765 | 194.356 | 30936.86 | 1162.11 | 0 | 0 | `report/evidence/event_stream_stats.json:82`；`records/20261030-215700_v6clean/meta.json:21` |
| v7hands（v7 前端） | 6,831 | 7,913,893 | 256.088 | 30903.02 | 1158.53 | 0 | 0 | `report/evidence/event_stream_stats.json:119`；`records/20261030-222201_v7hands/meta.json:21` |

- v5probe 的事件流同时用于第 2 节的离线回放。
- v6clean384 为 587 帧短会话，事件率 93.37 事件/秒，只作采集健康对照。
- v7hands 采集 6,831 帧与 7,913,893 条事件。
- 四会话的 meta.json counters 与统计文件逐项相等。

## 5 结论与不一致项解释

板上输出与离线参考在次数与时间上一致，差值为 +2 条，占板上 118 条的 1.7%。差异可由相位漂移、孤立事件与视角三类机制解释。

1. 相位漂移：27 对差额落在 600 ms 至 1500 ms 之间，单独统计。板上 pulse 是触发时刻，离线取窗口中心，漂移随窗序号累积。
2. 次数差：开合 +1、换手 +1、挥手 +1、手静止 -1，四段净差 +2。逐段数值见第 2 节表。
3. 孤立事件：板上 6 条、离线 4 条，位置见原始输出第 44 至 47 行。
4. 置信度饱和：118 条中 76 条 conf=31，占 64.4%。开合 37/61、换手 5/8、挥手 33/47 均触顶，阈值上调空间小。
5. 视角差异：view B 只作硬负样本，不进入训练与部署指标。打字与端纸杯的 dx 为 9 至 11 像素，与开合段 5.8 至 9.0 重叠，跨视角判别力有限（源：`docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:171`）。
6. 判定：板上与离线同源回放一致，可作为 3.3.5.1 的实测输出与参考结果比对材料。

## 6 未测量与未验证

下表列出五项未完成项，均不改变 act3c 的实测比对结论。

| 项 | 状态 | 影响 | 源 |
|---|---|---|---|
| act7 烧板 | 未烧板 | v7 功能只有 TB 与离线证据 | `sim/nn/EVIDENCE_M3f.md:192` |
| Flash 固化 | 未实测 | 只影响脱机上电自启 | `docs/05_experiments/m5_board_acceptance_20261029.md:129` |
| act3c 烧录日志 | 未留存 | 身份靠时间戳与行为反证旁证 | `docs/06_facts/00_current_status.md:299` |
| act7 源码到位流逐字节复现 | 未建立 | 注释修改逻辑等价，基线留到 act8 | `sim/nn/EVIDENCE_M3f.md:133` |
| 部署视角真实误报率 | 未测量 | 只有 view B 的 46.5 s 素材 | `docs/06_facts/03_v7b_deployment_decision.md:48` |

## 7 抽取索引（155 条）

每条格式为 键、值、源文件:行号。脚本对每条值做源行包含校验，任一条失败即退出码 1。

| 键 | 值 | 源文件:行号 |
|---|---|---|
| `act3_bit_bytes` | 2,909,183 | `sim/nn/EVIDENCE_M4C.md:39` |
| `act3_bit_md5` | ce8685419b95417c347fe5d3b31aa0f7 | `sim/nn/EVIDENCE_M4C.md:39` |
| `act3_burn_time` | 2026-10-29 23:32 | `docs/06_facts/01_fact_register.md:617` |
| `act3_delivery_wns_ns` | 0.228 | `sim/nn/EVIDENCE_M4C.md:40` |
| `act3_full_build_lut` | 20,501 | `sim/nn/EVIDENCE_M4C.md:54` |
| `act3b_bit_bytes` | 2,675,095 | `docs/06_facts/00_current_status.md:298` |
| `act3b_bit_md5` | 361713e0a455e5c1436365fe39dbd821 | `docs/06_facts/00_current_status.md:298` |
| `act3b_weight_note` | v4 两分类 | `docs/06_facts/00_current_status.md:298` |
| `act3c_bit_bytes` | 2,890,875 | `docs/06_facts/00_current_status.md:28` |
| `act3c_bit_md5` | a5fff751e20019d7e80a3a953f7f8c5a | `docs/06_facts/00_current_status.md:28` |
| `act3c_burn_time` | 2026-10-30 21:10:36 | `docs/06_facts/00_current_status.md:28` |
| `act7_bit_bytes` | 2,835,423 | `sim/nn/EVIDENCE_M3f.md:5` |
| `act7_bit_md5` | 9c13668c029c9d3a248cf69cbec03582 | `sim/nn/EVIDENCE_M3f.md:14` |
| `act7_build_start` | 2026-10-31T00:46:42 | `sim/nn/EVIDENCE_M3f.md:40` |
| `act7_build_end` | 2026-10-31 00:56:48 | `sim/nn/EVIDENCE_M3f.md:41` |
| `act7_build_total` | 10 分 06 秒 | `sim/nn/EVIDENCE_M3f.md:42` |
| `act3c_drc_warnings` | 95 | `sim/nn/EVIDENCE_M2E.md:107` |
| `act3c_drc_errors` | 0 | `sim/nn/EVIDENCE_M2E.md:107` |
| `act7_drc_warnings` | 98 | `sim/nn/EVIDENCE_M3f.md:141` |
| `act7_drc_errors` | 0 | `sim/nn/EVIDENCE_M3f.md:141` |
| `act3c_build_flow` | 9 分 39 秒 | `sim/nn/EVIDENCE_M2E.md:103` |
| `act3c_timingfix` | 4 分 30 秒 | `sim/nn/EVIDENCE_M2E.md:122` |
| `act3c_build_total` | 14 分 09 秒 | `sim/nn/EVIDENCE_M2E.md:145` |
| `act3c_wns_ns` | 0.306 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act3c_tns_ns` | 0.000 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act3c_whs_ns` | 0.036 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act3c_ths_ns` | 0.000 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act3c_setup_endpoints` | 76,854 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act3c_hold_endpoints` | 76,831 | `build/variant_act3c/timing_deliver.rpt:131` |
| `act7_wns_ns` | 0.059 | `build/variant_act7/inproc_timing.rpt:131` |
| `act7_tns_ns` | 0.000 | `build/variant_act7/inproc_timing.rpt:131` |
| `act7_whs_ns` | 0.027 | `build/variant_act7/inproc_timing.rpt:131` |
| `act7_ths_ns` | 0.000 | `build/variant_act7/inproc_timing.rpt:131` |
| `act7_setup_endpoints` | 84,405 | `build/variant_act7/inproc_timing.rpt:131` |
| `act7_hold_endpoints` | 84,382 | `build/variant_act7/inproc_timing.rpt:131` |
| `act3c_lut` | 20,559 | `build/variant_act3c/inproc_util_impl.rpt:34` |
| `act3c_lut_pct` | 32.43 | `build/variant_act3c/inproc_util_impl.rpt:34` |
| `act3c_lut_capacity` | 63,400 | `build/variant_act3c/inproc_util_impl.rpt:34` |
| `act3c_ff` | 11,850 | `build/variant_act3c/inproc_util_impl.rpt:39` |
| `act3c_ff_pct` | 9.35 | `build/variant_act3c/inproc_util_impl.rpt:39` |
| `act3c_ff_capacity` | 126,800 | `build/variant_act3c/inproc_util_impl.rpt:39` |
| `act3c_slice` | 7,327 | `build/variant_act3c/inproc_util_impl.rpt:72` |
| `act3c_slice_pct` | 46.23 | `build/variant_act3c/inproc_util_impl.rpt:72` |
| `act3c_slice_capacity` | 15,850 | `build/variant_act3c/inproc_util_impl.rpt:72` |
| `act3c_bram` | 87 | `build/variant_act3c/inproc_util_impl.rpt:104` |
| `act3c_bram_pct` | 64.44 | `build/variant_act3c/inproc_util_impl.rpt:104` |
| `act3c_bram_capacity` | 135 | `build/variant_act3c/inproc_util_impl.rpt:104` |
| `act3c_dsp` | 7 | `build/variant_act3c/inproc_util_impl.rpt:119` |
| `act3c_dsp_pct` | 2.92 | `build/variant_act3c/inproc_util_impl.rpt:119` |
| `act3c_dsp_capacity` | 240 | `build/variant_act3c/inproc_util_impl.rpt:119` |
| `act3c_iob` | 140 | `build/variant_act3c/inproc_util_impl.rpt:130` |
| `act3c_iob_pct` | 49.12 | `build/variant_act3c/inproc_util_impl.rpt:130` |
| `act3c_iob_capacity` | 285 | `build/variant_act3c/inproc_util_impl.rpt:130` |
| `act7_lut` | 22,371 | `build/variant_act7/inproc_util_impl.rpt:34` |
| `act7_lut_pct` | 35.29 | `build/variant_act7/inproc_util_impl.rpt:34` |
| `act7_lut_capacity` | 63,400 | `build/variant_act7/inproc_util_impl.rpt:34` |
| `act7_ff` | 14,325 | `build/variant_act7/inproc_util_impl.rpt:39` |
| `act7_ff_pct` | 11.30 | `build/variant_act7/inproc_util_impl.rpt:39` |
| `act7_ff_capacity` | 126,800 | `build/variant_act7/inproc_util_impl.rpt:39` |
| `act7_slice` | 7,968 | `build/variant_act7/inproc_util_impl.rpt:72` |
| `act7_slice_pct` | 50.27 | `build/variant_act7/inproc_util_impl.rpt:72` |
| `act7_slice_capacity` | 15,850 | `build/variant_act7/inproc_util_impl.rpt:72` |
| `act7_bram` | 87 | `build/variant_act7/inproc_util_impl.rpt:104` |
| `act7_bram_pct` | 64.44 | `build/variant_act7/inproc_util_impl.rpt:104` |
| `act7_bram_capacity` | 135 | `build/variant_act7/inproc_util_impl.rpt:104` |
| `act7_dsp` | 8 | `build/variant_act7/inproc_util_impl.rpt:119` |
| `act7_dsp_pct` | 3.33 | `build/variant_act7/inproc_util_impl.rpt:119` |
| `act7_dsp_capacity` | 240 | `build/variant_act7/inproc_util_impl.rpt:119` |
| `act7_iob` | 140 | `build/variant_act7/inproc_util_impl.rpt:130` |
| `act7_iob_pct` | 49.12 | `build/variant_act7/inproc_util_impl.rpt:130` |
| `act7_iob_capacity` | 285 | `build/variant_act7/inproc_util_impl.rpt:130` |
| `board_empty_desk` | 0 | `board/board_vs_offline_v5.md:13` |
| `offline_empty_desk` | 0 | `board/board_vs_offline_v5.md:13` |
| `board_absent` | 1 | `board/board_vs_offline_v5.md:14` |
| `offline_absent` | 1 | `board/board_vs_offline_v5.md:14` |
| `board_openclose` | 61 | `board/board_vs_offline_v5.md:15` |
| `offline_openclose` | 60 | `board/board_vs_offline_v5.md:15` |
| `board_static_a` | 0 | `board/board_vs_offline_v5.md:16` |
| `offline_static_a` | 1 | `board/board_vs_offline_v5.md:16` |
| `board_reposition` | 8 | `board/board_vs_offline_v5.md:17` |
| `offline_reposition` | 7 | `board/board_vs_offline_v5.md:17` |
| `board_static_b` | 0 | `board/board_vs_offline_v5.md:18` |
| `offline_static_b` | 0 | `board/board_vs_offline_v5.md:18` |
| `board_wave` | 47 | `board/board_vs_offline_v5.md:19` |
| `offline_wave` | 46 | `board/board_vs_offline_v5.md:19` |
| `board_end` | 1 | `board/board_vs_offline_v5.md:20` |
| `offline_end` | 1 | `board/board_vs_offline_v5.md:20` |
| `board_openclose_confident` | 53 | `board/board_vs_offline_v5.md:15` |
| `board_openclose_phase` | 4 | `board/board_vs_offline_v5.md:15` |
| `board_wave_confident` | 23 | `board/board_vs_offline_v5.md:19` |
| `board_wave_phase` | 23 | `board/board_vs_offline_v5.md:19` |
| `dt_p50_absent` | 55.0 | `board/board_vs_offline_v5.md:14` |
| `dt_p90_absent` | 55.0 | `board/board_vs_offline_v5.md:14` |
| `dt_p50_openclose` | 71.0 | `board/board_vs_offline_v5.md:15` |
| `dt_p90_openclose` | 317.4 | `board/board_vs_offline_v5.md:15` |
| `dt_p50_reposition` | 61.0 | `board/board_vs_offline_v5.md:17` |
| `dt_p90_reposition` | 442.8 | `board/board_vs_offline_v5.md:17` |
| `dt_p50_wave` | 61.0 | `board/board_vs_offline_v5.md:19` |
| `dt_p90_wave` | 358.6 | `board/board_vs_offline_v5.md:19` |
| `dt_p50_end` | 434.0 | `board/board_vs_offline_v5.md:20` |
| `dt_p90_end` | 434.0 | `board/board_vs_offline_v5.md:20` |
| `board_events` | 118 | `board/board_vs_offline_v5.md:21` |
| `offline_events` | 116 | `board/board_vs_offline_v5.md:21` |
| `board_offline_delta` | +2 | `board/board_vs_offline_v5.md:21` |
| `matched_confident` | 85 | `board/board_vs_offline_v5.md:21` |
| `phase_drift_pairs` | 27 | `board/board_vs_offline_v5.md:21` |
| `isolated_board` | 6 | `board/board_vs_offline_v5.md:21` |
| `isolated_offline` | 4 | `board/board_vs_offline_v5.md:21` |
| `offline_windows` | 8,641 | `board/board_vs_offline_v5.md:7` |
| `offline_decision_points` | 4,320 | `board/board_vs_offline_v5.md:7` |
| `offline_g0_ms` | 37 | `board/board_vs_offline_v5.md:7` |
| `frame_offset_ms` | 1793365856477.0 | `board/board_vs_offline_v5.md:51` |
| `align_residual_median_ms` | 9.0 | `board/board_vs_offline_v5.md:51` |
| `board_record_events` | 121 | `board/board_vs_offline_v5.md:53` |
| `board_kept_events` | 120 | `board/board_vs_offline_v5.md:53` |
| `params_sha256` | 1903bc994b3e2a6ffe5782e0691aebf27f04a9c00ab14c2da86c8cc3815be583 | `board/board_vs_offline_v5.md:5` |
| `measure_openclose_count` | 61 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:13` |
| `measure_wave_count` | 47 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:13` |
| `measure_swap_count` | 8 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:13` |
| `measure_still_count` | 0 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:13` |
| `conf_sat_count` | 76 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:93` |
| `conf_sat_total` | 118 | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:93` |
| `board_pps` | 15,940 | `docs/06_facts/00_current_status.md:32` |
| `part_number` | xc7a100tfgg484-2 | `docs/06_facts/02_metric_register.md:11` |
| `vivado_version` | 2020.2 | `docs/06_facts/02_metric_register.md:12` |
| `modelsim_version` | 2020.4 | `docs/06_facts/02_metric_register.md:12` |
| `sys_clk_mhz` | 50 | `docs/06_facts/02_metric_register.md:13` |
| `stream_v5probe_frames` | 11,516 | `report/evidence/event_stream_stats.json:8` |
| `stream_v5probe_events` | 10,312,327 | `report/evidence/event_stream_stats.json:9` |
| `stream_v5probe_span_s` | 432.143 | `report/evidence/event_stream_stats.json:13` |
| `stream_v5probe_events_per_s` | 23863.23 | `report/evidence/event_stream_stats.json:15` |
| `stream_v5probe_events_per_frame` | 895.48 | `report/evidence/event_stream_stats.json:16` |
| `stream_v5probe_droppedFrames` | 0 | `records/20261030-212214_v5probe/meta.json:29` |
| `stream_v5probe_droppedEvents` | 0 | `records/20261030-212214_v5probe/meta.json:30` |
| `stream_v6clean384_frames` | 587 | `report/evidence/event_stream_stats.json:45` |
| `stream_v6clean384_events` | 2,052 | `report/evidence/event_stream_stats.json:46` |
| `stream_v6clean384_span_s` | 21.978 | `report/evidence/event_stream_stats.json:50` |
| `stream_v6clean384_events_per_s` | 93.37 | `report/evidence/event_stream_stats.json:52` |
| `stream_v6clean384_events_per_frame` | 3.5 | `report/evidence/event_stream_stats.json:53` |
| `stream_v6clean384_droppedFrames` | 0 | `records/20261030-214353_v6clean/meta.json:21` |
| `stream_v6clean384_droppedEvents` | 0 | `records/20261030-214353_v6clean/meta.json:22` |
| `stream_v6clean_frames` | 5,174 | `report/evidence/event_stream_stats.json:82` |
| `stream_v6clean_events` | 6,012,765 | `report/evidence/event_stream_stats.json:83` |
| `stream_v6clean_span_s` | 194.356 | `report/evidence/event_stream_stats.json:87` |
| `stream_v6clean_events_per_s` | 30936.86 | `report/evidence/event_stream_stats.json:89` |
| `stream_v6clean_events_per_frame` | 1162.11 | `report/evidence/event_stream_stats.json:90` |
| `stream_v6clean_droppedFrames` | 0 | `records/20261030-215700_v6clean/meta.json:21` |
| `stream_v6clean_droppedEvents` | 0 | `records/20261030-215700_v6clean/meta.json:22` |
| `stream_v7hands_frames` | 6,831 | `report/evidence/event_stream_stats.json:119` |
| `stream_v7hands_events` | 7,913,893 | `report/evidence/event_stream_stats.json:120` |
| `stream_v7hands_span_s` | 256.088 | `report/evidence/event_stream_stats.json:124` |
| `stream_v7hands_events_per_s` | 30903.02 | `report/evidence/event_stream_stats.json:126` |
| `stream_v7hands_events_per_frame` | 1158.53 | `report/evidence/event_stream_stats.json:127` |
| `stream_v7hands_droppedFrames` | 0 | `records/20261030-222201_v7hands/meta.json:21` |
| `stream_v7hands_droppedEvents` | 0 | `records/20261030-222201_v7hands/meta.json:22` |

## 8 复现

1. 在仓库根执行 python board/extract_measurements.py。
2. 期望退出码为 0，末行输出 BOARD_DOC_OK=1。
3. 生成 board/measurements.md，证据写入 board/evidence_board_doc.log。
4. 脚本只用标准库，不依赖 Vivado、ModelSim 与板卡。
