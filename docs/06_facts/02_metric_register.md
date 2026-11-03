# 参赛口径登记（D8）

> 用途：参赛文档中出现的数字、版本、语义，以本表为唯一权威出处。正文首次引用时标注本表编号。
> 规则：本表只登记已核实口径；未产生的数字写“本版未覆盖”，不得在其它文档补猜。
> 维护：director。最近更新：2026-10-31。

## 1 器件、工具与构建

| 编号 | 口径 | 数值 / 结论 | 权威来源 | 证据强度 |
|---|---|---|---|---|
| M1 | 目标器件 | AMD Artix-7 `xc7a100tfgg484-2`（正点原子达芬奇Pro） | `build/build_inproc_v7.tcl` | 实测（Vivado 工程） |
| M2 | 开发工具 | Vivado 2020.2、ModelSim SE 2020.4 | `docs/06_facts/00_current_status.md` §6.1 | 实测（本机版本） |
| M3 | 系统时钟 | `sys_clk` 50 MHz，引脚 R4，非专用时钟引脚（CLOCK_DEDICATED_ROUTE FALSE） | `src/rtl/top/top_retina_event.v`、XDC | 实测 |
| M4 | 摄像头输入 | OV5640，800×480 RGB565，8 位 DVP，PCLK≈48 MHz，实测帧率 26.4~27.0 fps | `docs/06_facts/00_current_status.md` §2、`docs/05_experiments` 采集报告 | 实测（ILA + 帧率反推） |
| M5 | 事件分辨率 | 400×240；由 800×480 经 ÷2×÷2 降采样 | `src/rtl/subsys/retina_core.v` | 实测（仿真 + 上板） |
| M6 | 当前板上位流 | `variant_act8_final`，2026-10-31 02:02 烧录，2,839,107 B，md5 `5ec55ec07c44f2503df63f1bb160a6e6` | `build/variant_act8_final/retina_event.bit`、`sim/nn/EVIDENCE_M3j.md` §11 | 实测（PROG_RESULT=OK / DONE_PIN=1 / EOS=1） |
| M7 | 位流内容 | v7b 两分类权重 + `NN_MARGIN_MIN=16` + 既有 task-27 byte23 修复；含 v7 前端与 7 路全局量 MLP；当前板上为 act8 | `sim/nn/EVIDENCE_M3j.md`、`nn/out_v7b/nn_params_v7b.json` | 实测（构建 + 烧板） |
| M8 | 构建时间 | act3c 全流程 9 min 39 s；ExtraTimingOpt 追加 4 min 30 s | `sim/nn/EVIDENCE_M2E.md` | 实测（本机构建） |
| M9 | act7 构建 | `variant_act7`，2026-10-31 00:56 生成，2,835,423 B，md5 `9c13668c029c9d3a248cf69cbec03582`；含 v7 前端 nn_winfeat/nn_winstat，未烧板 | `build/variant_act7/retina_event.bit`、`docs/06_facts/00_current_status.md` | 实测（构建产物） |
| M12 | act8 构建与烧板 | `variant_act8_final`（Explore 轮），2026-10-31 01:40 生成，2,839,107 B，全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97`（头 127 B，载荷 2,838,980 B）；2026-10-31 02:02 烧板，`DONE_PIN=1` / `EOS=1` / `PROG_RESULT=OK`；未做板级动作验收 | `build/variant_act8_final/retina_event.bit`、`sim/nn/EVIDENCE_M3j.md` | 实测（构建 + 烧板）；口径订正：初版按 168 B 计算有误，2026-10-31 由 rtl 复核发现 |
| M13 | act8 空场景被动基线 | 2026-10-31 01:59:36 → 02:19:42（+08:00），被动监测 1206.5 s、223 次分页轮询，动作事件 0 条（0.00 次/分；0 事件 95% 单侧上界约 0.149 次/分），`dropped=0`；同步录像 `records/20261031-015936_act8_empty` 32,163 帧 / 19,750 事件 / 5 chunks / `droppedFrames=0` / `droppedEvents=0`。另于 02:22 → 06:22 做连续被动监测 14,405.3 s / 2,614 次轮询，动作事件 0 条，0 事件 95% 上界降至 0.0125 次/分；两次观测合计 241.2 min、0 事件。只覆盖无人静态场景（无录像段无人体入画复核），不等同 M5 A1~A4 验收 | `records/20261031-015936_act8_empty/meta.json`、`temp_test/lead/passive_act8_empty_summary.json`、`docs/05_experiments/action_recognition_20261029/act8_empty_baseline_20261031.md` | 实测（板上录像 + 网关事件轮询） |
| M14 | act8 上板 A1~A4 验收 | 2026-10-31 15:49–16:26，同一 act8 位流 4 轮（3 轮有效）：A3 召回 14/20、19/20、15/20，累计 48/60=0.800；A1 与 A2 各 0 条（累计 180.4 s）；A4 共 1 条（退场过渡）；非 A3 误触发 1 条/421.1 s=0.143 次/分；`VERIFY_PASS=0`（G2 未稳定达标） | `records/20261031-154917_verify_v7/`、`records/20261031-160544_verify_v7/`、`records/20261031-161557_verify_v7/`、`records/20261031-162341_verify_v7/` 的 `acceptance.md` / `acceptance.json` | 实测（板上） |

## 2 时序与资源

| 编号 | 口径 | 数值 | 权威来源 | 证据强度 |
|---|---|---|---|---|
| R1 | act3c 最终时序 | WNS `+0.306 ns`、TNS 0、WHS `+0.036 ns` | `build/variant_act3c/timing_deliver.rpt` | 实测（布线后报告） |
| R2 | act3c 实现资源 | LUT 20,559（32.43%）、FF 11,850（9.35%）、Slice 7,327（46.23%）、BRAM 87（64.44%）、DSP 7（2.92%）、IOB 140（49.12%） | `build/variant_act3c/inproc_util_impl.rpt` | 实测 |
| R3 | 器件容量 | LUT 63,400、FF 126,800、Slice 15,850、BRAM 135、DSP 240、IOB 285 | `xc7a100tfgg484-2` 数据手册 | 文档 |
| R4 | NN 核资源（综合） | LUT 1,108、FF 400、Slice 356、BRAM 10.5、DSP 1、WNS `+8.827 ns` @20 ns | `sim/nn/EVIDENCE_M3.md` | 实测（OOC 综合） |
| R5 | NN 推理时间 | 440,087 拍 @50 MHz = 8.80 ms/窗；占 100 ms 窗 8.8% | `sim/nn/EVIDENCE_M3.md` | 实测（仿真） |
| R6 | 单窗 MAC | 208,080 MAC（3 类配置；2 类配置 207,840 MAC） | `sim/nn/EVIDENCE_M3.md`、`docs/03_tech/04_action_recognition_selection.md` | 实测（计数） |
| R7 | 片上 BRAM 预算 | 显示帧缓存不占 BRAM；事件引擎与 NN 合计约 54/135（40%），余量 81 | `docs/02_design/02_memory_hierarchy.md` | 推断（按模块累加） |
| R8 | 200 MHz 并行方案 | WNS `-7.001 ns`、Slice 98.69%、DSP 0，已否决 | `sim/nn/EVIDENCE_M3.md` | 实测（综合失败） |
| R9 | act7 时序 | WNS `+0.059 ns`、TNS 0、WHS `+0.027 ns`、THS 0，时序端点 84,405 | `build/variant_act7/timing_deliver.rpt:131` | 实测（布线后报告） |
| R10 | act7 资源 | LUT 22,371（35.29%）、FF 14,325（11.30%）、Slice 7,968（50.27%）、BRAM 87（64.44%）、DSP 8（3.33%）、IOB 140（49.12%）；相对 act3c 增量 `+1,812 / +2,475 / +641 / 0 / +1 / 0`；最差路径 14 级逻辑、布线占比 62.6% | `build/variant_act7/inproc_util_impl.rpt`、`timing_deliver.rpt:426-435` | 实测（布线后报告） |
| R11 | v7b 部署判据与接受决定 | s100：开合 17/17、挥手 pulse 1、静止 0、空桌面 0、硬负 pulse 2、镜像 `d_wave=0.0196`；硬负 2 > 1 与 `d_wave` > 0.01 两项未通过，`V7B_MODEL_OK=0`；Lead 2026-10-31 01:15 以决策记录接受风险并选 v7b 构建 act8，接受不等于改判 | `docs/06_facts/03_v7b_deployment_decision.md`、`nn/out_v7b/s100_threshold_sweep.json` | 决策（基于离线评估）；板级未测 |
| R12 | act8 时序与资源 | WNS `+0.215 ns`、TNS 0、WHS `+0.017 ns`、THS 0；LUT 22,383（35.30%）、FF 14,325（11.30%）、Slice 8,026（50.64%）、BRAM 86.5（64.07%）、DSP 8（3.33%）、IOB 140（49.12%）；相对 act7 增量 `+12 / 0 / +58 / −0.5 / 0 / 0`；最差路径 14 级、布线 52.3% | `build/variant_act8_final/timing.rpt`、`util.rpt` | 实测（布线后报告） |

## 3 动作识别与回传

| 编号 | 口径 | 数值 / 结论 | 权威来源 | 证据强度 |
|---|---|---|---|---|
| A1 | 部署模型 | int8 二分类（class0 无动作、class1 手部开合），4 通道 50×30，每 100 ms 一窗 | `sim/nn/EVIDENCE_M2E.md`、`docs/03_tech/05_action_uplink_contract.md` | 实测 |
| A2 | 决策节拍 | 窗 100 ms 不重叠；连续 3 窗同类锁存；不应期 1.5 s；空窗 1.0 s 清零 | `src/rtl/nn/nn_decide.v`、`nn_cfg.vh` | 实测（源码 + 仿真） |
| A3 | 类别语义 | class0 无动作（含板移）；class1 手部开合任一方向；class2 横向挥手；class3 保留 | `docs/03_tech/05_action_uplink_contract.md` §2.1 | 决策（冻结契约 v1.3） |
| A4 | byte23 位域 | bit7 VALID、bit6..2 CONF（0..31）、bit1..0 CLASS；CRC 覆盖 byte23 | `docs/03_tech/05_action_uplink_contract.md` §2.2 | 决策 + 实测（协议单测） |
| A5 | 回传接口 | `GET /api/action`、`GET /api/action/events`、`GET /api/action/config` | 同上 §5 | 实测（curl） |
| A6 | v5 实机计数 | 118 条脉冲 / 432 s；开合 61、挥手 47；最小间隔 1,687 ms | `docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md` | 实测（设备输出，非人工真值） |
| A7 | v7 离线结果 | 留出 A_time 两折窗准确率 0.9042 / 0.8754（未合并；均值 0.8898 非 pooled）。s100 板端口径：开合 17/17、挥手 pulse 5、硬负 pulse 5、静止 0、空桌面 0。s50 训练口径：折级开合 16/17=0.9412，去掉 0.5 s 守卫带后 17/17=1.000；挥手窗级命中 5/510=0.0098。pulse 数与窗级命中率是两个量，不合并 | `nn/out_v7/results_v7_final.json` | 离线（未上板） |
| A8 | v7 位流状态 | v7 前端已进 `variant_act7`（未烧板）；v7b 已进 `variant_act8_final` 并于 2026-10-31 02:02 烧板；板上当前为 act8；空场景 20.1 分钟零误报已实测（0 事件，95% 单侧上界约 0.149 次/分）；板级动作计数待 A1~A4 | `sim/nn/EVIDENCE_M3j.md`、`records/20261031-015936_act8_empty/meta.json`、`temp_test/lead/passive_act8_empty_summary.json` | 实测（构建 + 烧板 + 空场景被动监测） |
| A9 | prev 窗语义 | 板端：决策时刻 T 的输入为 [T-200,T)；now=[T-100,T)，prev=[T-200,T-100)（100 ms 非重叠上一 bin）。训练侧：100 ms 窗、50 ms 步，prev 通道是上一滑窗自己的平移网格，对应 [T-150,T-50)（与 now 重叠 50 ms）。两者错位 50 ms，影响由 task-59 用现有部署件量化，结论待补 | `src/rtl/nn/nn_cfg.vh`（NN_K_TIME_BINS=2、NN_WIN_CYC=5,000,000）、`src/rtl/nn/nn_feat.v`、`nn/v7/intwin.py` 窗口定义、`sim/nn/EVIDENCE_REVIEW_V7.md` §4 | 实测（RTL + 训练源码）；影响待量化 |
| A10 | conf 与 margin | `conf=min(margin,31)` 是 5 bit 饱和显示值；判据量用全精度 `margin`；两分类 `margin=abs(s0 - s1)`（logit2 钉 -128，平局取 class0）；`o_margin` 的契约表述以本行为准 | `src/rtl/nn/nn_decide.v:155`、`nn/REPORT_决策链标定.md:27`、`sim/nn/EVIDENCE_REVIEW_V7.md` D9 | 实测（RTL 源码） |
| A11 | v7b 部署裁决 | 部署门限 `MARGIN_MIN=16`、`N_CONSEC=3`。s100：开合 17/17、挥手 pulse 1、静止 0、空桌面 0、硬负 pulse 2、镜像 `d_wave=0.0196`；`V7B_MODEL_OK=0`（硬负 2 > 1、`d_wave` > 0.01 两项未过）。v7 并排：开合 17/17、挥手 5、硬负 5、静止 0、空桌面 0，v7b 四项不劣、两项改善。仍选 v7b 作 act8 权重，接受三条风险：view B 打字误报未知、左手通用性弱于 v7、时序余量（act7 `+0.059 ns`，act8 实测 `+0.215 ns`）；复查条件：A1~A4 出现手静止仍报动作则失效，act8 时序不收敛回退 act7（act8 已收敛，回退条件未触发） | `docs/06_facts/03_v7b_deployment_decision.md`、`nn/out_v7/` | 决策（Lead 2026-10-31 01:15，基于 s100 离线评估）；act8 已烧板，板级未测 |

## 4 时间、数据与坐标

| 编号 | 口径 | 数值 / 结论 | 权威来源 | 证据强度 |
|---|---|---|---|---|
| T1 | 唯一时间轴 | `frames.csv` 的 `frame_idx` ↔ `t_board_ms` 为唯一权威；容器 30 fps 只是标称 | `docs/03_tech/05_action_uplink_contract.md` §11.4 | 决策 + 实测 |
| T2 | 容器时间压缩 | 真实板卡 26.6~26.7 fps ⇒ 容器时长为墙钟的 0.889，播放快约 12.4% | `docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md` §2.3 | 实测（ffprobe + 帧计数） |
| T3 | 事件坐标 | `events.csv` 的 x/y 为 400×240 原始像素；网格 50×30 需 `>>3` | `docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md` §3.3 | 实测（逐窗复算） |
| T4 | 动作位移量 | 开合 5.8~9.0 原始像素/100 ms；挥手 23.9~31.3；分离 ≥2.6 倍 | 同上 §3.3 | 实测（离线统计） |
| T5 | 一次采集丢包 | v7hands 6,831 帧 / 7,913,893 事件 / 0 丢帧 / 0 丢事件 | `records/20261030-222201_v7hands/meta.json`、`capture_log_v7hands_20261030.md` §2 | 实测 |
| T6 | 视频帧率 | 板上实际 26.6~26.7 fps；`--synth` 约 21.5 fps | `docs/03_tech/05_action_uplink_contract.md` §11.4 | 实测 |

## 5 上位机与运行前置

| 编号 | 口径 | 数值 / 结论 | 权威来源 | 证据强度 |
|---|---|---|---|---|
| H1 | 网络前置 | “以太网”网卡必须静态 `192.168.1.102/24`；板端 PC_IP 写死该地址 | `host/README.md` 排障表、`docs/06_facts/01_fact_register.md` H80 | 实测 |
| H2 | 绑定失败行为 | 非本机地址时 fail-fast 打印 `BIND_ADDR_NOT_LOCAL` 并以 exit 2 退出 | `host/app/gateway/src/main.ts`、`docs/07_review/上位机启动失败修复_复审_20261029.md` | 实测 |
| H3 | 启动守卫 | 默认 7,000 ms；生效值 `max(7,000, udpProbeMs + 3,000)`；超时立即 exit 2 | `host/app/gateway/src/main.ts` | 实测 |
| H4 | 真实启动耗时 | UDP 本地回环 351~365 ms；真实网卡 326~396 ms；带 `--serve` 774 ms | `docs/05_experiments/上位机启动_20261029/复审_evidence.log` | 实测 |
| H5 | 上位机测试 | `npm test` 670 tests / 669 pass / 1 skip / 0 fail | `docs/05_experiments/recording_and_labeling_20261030/REPORT.md` | 实测 |
| H6 | 实时链路 | 用户面板 192.168.1.102:1234 + 127.0.0.1:8787，pps≈15,940，healthz 200 | `docs/06_facts/00_current_status.md` §1 | 实测 |

## 6 未决与边界

| 编号 | 事项 | 当前状态 |
|---|---|---|
| O1 | v7 参数与 ROM 字数 | `nn/out_v7/nn_params_v7.json` 为 5,652 words / 7 路；`results_v7_hw2.json` 为 5,668 words / 8 路，换 ROM 前必须定版 |
| O2 | v7 板级数字 | act7 已构建未烧板；act8 已构建并烧板（2026-10-31 02:02）；空场景 20.1 分钟零误报已实测（0 事件）；act8 的 A1~A4 已测（2026-10-31，3 轮有效，A3 48/60=0.80，G2 未稳定达标，见 M14）；v7 板级数字仍未产生 |
| O3 | 远距泛化 | 离线 B_diag_near_to_far 开合 1/6，>2 m 仍是缺口 |
| O4 | 长录拔电恢复 | 未测试 |
| O5 | 串口/auto 预检 | 非 udp 模式不触发 BIND 预检，仍等 25 s 超时 |

## 7 引用写法

正文引用本表时写“（D8-M6）”或“（[口径登记](02_metric_register.md#1-器件工具与构建)）”。
同一数字不得在正文另注一个不同来源；发现冲突先改本表，再改正文。

*相关：[事实与决策登记册](01_fact_register.md) · 参赛文档大纲与文风约束（文件 ../04_赛事与合规/05_report_outline_and_style.md，未随包发布）*
