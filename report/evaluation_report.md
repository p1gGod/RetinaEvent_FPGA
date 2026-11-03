# 动作识别系统评测报告（M9d）

- 报告日期：2026-10-31
- 评测对象：v5 两分类实机链路、v7 与 v7b 离线二分类链路、act3c 已实测位流、act7 构建位流、act8 已烧板并完成 A1~A4 验收位流
- 证据日志：report/evidence/report_eval_ok.log
- 图表目录：report 下 figures 子目录

## 1. 结论先行

- 事件流规模已测清。v5probe 长录 432.143 s、11,516 帧、10,312,327 事件、23,863.23 事件每秒；v7hands 长录 256.088 s、6,831 帧、7,913,893 事件、30,903.02 事件每秒（源：report/evidence/event_stream_stats.json sessions.v5probe 与 sessions.v7hands）。
- v5 在板上 432.04 s 内产生 118 条脉冲，全程 16.4 次/分；开合 61 条、31.02 次/分，挥手 47 条、30.32 次/分，换手 8 条、34.29 次/分，手静止与空桌面均为 0（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:59-67）。v5 对各类手部运动给出相近密度，动作类别区分有限（源：同上:89）。
- v7 离线 s50 折级开合召回 16/17=0.9412，无守卫 pooled 为 17/17=1.000（源：nn/out_v7/results_v7_final.json:4637-4638,4655-4656）。s100 板端口径下开合 17/17，挥手 5 条 pulse，静止与空桌面均为 0，硬负 5 条 pulse（源：nn/REPORT_s100_部署口径复核.md:76）。int8 最低一致率 0.970775，未达 0.99 上板门槛（源：results_v7_final.json:6405）。
- act3c 实现资源为 LUT 20,559（32.43%）、FF 11,850（9.35%）、Slice 7,327（46.23%）、BRAM 87（64.44%）、DSP 7（2.92%）、IOB 140（49.12%）（源：build/variant_act3c/inproc_util_impl.rpt:34,39,72,104,119,130）。最终布线 WNS +0.306 ns、TNS 0、WHS +0.036 ns（源：build/variant_act3c/timing_deliver.rpt:131）。
- act7 已生成 v7 位流，WNS +0.059 ns、TNS 0，资源 LUT 22,371（35.29%）、FF 14,325（11.30%）、Slice 7,968（50.27%）（源：sim/nn/EVIDENCE_M3f.md:15,108-112）。act8 已用 v7b ROM 与 Explore 重跑，WNS +0.215 ns、LUT 22,383（35.30%）、Slice 8,026（50.64%），位流 2,839,107 B、md5 5ec55ec07c44f2503df63f1bb160a6e6，已于 2026-10-31 02:02 烧板（DONE_PIN=1 / EOS=1 / PROG_RESULT=OK），已于 2026-10-31 15:49–16:26 完成 4 轮 A1~A4 上板验收（3 轮有效：A3 召回 14/20、19/20、15/20，累计 48/60=0.80；A1/A2 零误触；A4 共 1 条退场过渡；G2 未稳定达标，详见 7.1 节）（源：report/evidence/act8_artifacts.txt:4-7,14-16；sim/nn/EVIDENCE_M3j.md:228-246）。v7b 在 s100 下把挥手 5→1、硬负 5→2，硬负与镜像 d_wave 仍两项未达标（源：docs/06_facts/03_v7b_deployment_decision.md:18-23）。
- 单次推理 440,087 拍、50 MHz 下 8.80 ms，占 100 ms 窗的 8.80%（源：sim/nn/EVIDENCE_M3.md:29,121,123）。上位机匹配时延 p50 85.612 ms、p95 97.555 ms，但只有 4 个匹配样本（源：docs/05_experiments/action_recognition_20261029/report.md:231）。

图 F10 把 8.80 ms 推理、37.49 ms 帧锁存、85.612 ms 匹配中位与 300 ms 契约上限放在同一条时间轴上（图见 [图 F10](<figures/f10_latency.svg>)）。图中 500 ms 轮询周期来自上位机契约（源：docs/03_tech/05_action_uplink_contract.md:462）。这些锚点覆盖不同环节，不能相加成单次端到端时延。

本报告的证据分为真机与离线两层。真机层只有 v5 的 432 s 事件计数，离线层覆盖 v6 与 v7 的表征、量化与决策链。两层证据的样本、时间基准与测试集都不同，正文在每处标注来源与适用范围（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53-67 与 nn/out_v7/results_v7_final.json:24）。

## 2. 测试平台与环境

评测硬件为 AMD Artix-7 xc7a100tfgg484-2 开发板（正点原子达芬奇Pro），工具链为 Vivado 2020.2 与 ModelSim SE 2020.4（源：docs/04_contest/05_report_outline_and_style.md:84-85）。板上历史行为来自 variant_act3c：2026-10-30 21:10:36 烧录，2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a（源：docs/06_facts/00_current_status.md:28）。当前板已换 act8：2026-10-31 02:02 烧录，2,839,107 B，md5 5ec55ec07c44f2503df63f1bb160a6e6（源：docs/06_facts/02_metric_register.md:16 与 sim/nn/EVIDENCE_M3j.md:228-246）。act7 未烧板，只作构建结果；act8 已烧板但未做动作验收，故板上动作结论仍只取 act3c。

### 2.1 窗口径与统计口径

本报告把窗级结果分成两套口径。s50 是训练口径，窗宽 100 ms、步长 50 ms，全会话 5,120 窗；s100 是板端口径，窗宽 100 ms、步长 100 ms，全会话 2,560 窗（源：nn/REPORT_s100_部署口径复核.md:14-17）。两套窗的 now 内容与 prev 定义都不同，窗数也正好减半（源：同上:26,36）。

同一模型在两种窗口径下的硬负率不同，报告统一采用 s100 板端口径。v7 权重在 s50 带守卫评估中硬负 1 次（源：nn/out_v7/results_v7_final.json:4652）。同一权重换到 s100 后硬负 5 次，总 pulse 从原生 s50 的 67 增到 97（源：nn/REPORT_s100_部署口径复核.md:76 与 nn/REPORT_v7b_部署口径重训.md:216）。原生 s50 表的硬负为 3、总 pulse 67，与带守卫的 1 不是同一条统计，s50 的 1 与 s100 的 5 也不能直接相减或平均（源：nn/REPORT_v7b_部署口径重训.md:213,216）。v7b 在 s100 下硬负 2 次、总 pulse 74（源：nn/REPORT_v7b_部署口径重训.md:213,216）。

报告中的误触发率如未特别注明，一律指 s100 板端口径。s50 数字只作训练侧对照，不参与门限判定（源：nn/REPORT_s100_部署口径复核.md:76）。v5 的板上 ACTION 计数不适用 s100 口径，按脉冲数除以段时长统计，仍在第 4 章单独标注（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:67）。事件流计数（events.csv 行数与事件每秒）是原始传感器统计，不按 100 ms 决策窗重采样，与 s100 误触发率无关（源：report/evidence/event_stream_stats.json）。

事件流分辨率为 400×240 像素，网格特征按 x>>3 与 y>>3 落到 50×30（源：docs/03_tech/06_rtl_design_and_pitfalls.md:143-144）。板上决策节拍为 100 ms 不重叠窗，连续 3 窗同类锁存，不应期 1.5 s，空窗 1.0 s 清零（源：docs/04_contest/05_report_outline_and_style.md:90）。上行数据经 UDP 1234 进入用户面板，评测脚本只读事件与视频文件，不绑定该端口（源：docs/05_experiments/m5_board_acceptance_20261029.md:237）。

时间基准取 frames.csv 的 t_board_ms，事件时间取 events.csv 的 frame_t_ms，视频定位取 frame_idx（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:55）。三段长录的实测有效帧率分别为 26.646、26.616、26.671 fps（源：同上:53）。mp4 容器按 30 fps 写入，容器时间等于墙钟乘 0.889，按秒 seek 会快约 12%（源：同上:23）。

act3c 的主时钟为 50 MHz，以太网接收时钟为 125 MHz，两者在 timing_deliver.rpt 中分别以 clk_out2 与 eth_rxc 列出（源：build/variant_act3c/timing_deliver.rpt:189,220）。eth_rxc 域的 WNS 为 +0.306 ns，对应 8,236 个端点；clk_out2 域的 WNS 为 +2.695 ns，对应 43,201 个端点（源：同上）。全设计一共 76,854 个时序端点之中有 76,831 个端点满足建立时间，WNS +0.306 ns、TNS 0（源：同上:131）。

v5 实机数据来自板上 ACTION 计数与同一段录像的离线回放，板上计数是唯一有真机事件通路的证据（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53-67）。v7 数据来自 20261030-222201_v7hands 的离线推理，没有在板上运行 v7 权重（源：docs/06_facts/00_current_status.md:28）。两类证据在报告中分章列出，不用离线结果替代真机结论。

采集链路为 OV5640 摄像头、事件引擎、UDP 回传与上位机网关。原始帧与事件流分开落盘，长录按 chunk 切分，每个 chunk 含 mp4、events.csv、frames.csv 与 labels.json（源：docs/03_tech/05_action_uplink_contract.md:109）。评测只读这些落盘文件，不重新采集，因此结果可复算（源：report/evidence/event_stream_stats.json）。chunk 边界按帧边界切分，不截断同一帧的事件（源：docs/03_tech/05_action_uplink_contract.md:419）。

图 F1 给出采集、事件引擎、显示、回传与推理的连接关系，图中节点数 9、箭头数 10（源：report 下 figures/make_figures.py 的 f1 函数）。图 F1 把原始帧通路与事件通路分开画，避免把显示链路误当成推理输入（图见 [图 F1](<figures/f1_system_arch.svg>)）。位流、工具版本与上表口径一致，图内不重复标注（源：figure_data_table.csv f1）。

| 项目 | 值 | 数据来源 |
|---|---|---|
| 器件 | AMD Artix-7 xc7a100tfgg484-2（正点原子达芬奇Pro） | docs/04_contest/05_report_outline_and_style.md:84 |
| 工具版本 | Vivado 2020.2、ModelSim SE 2020.4 | docs/04_contest/05_report_outline_and_style.md:85 |
| 当前板上位流 | variant_act8_final，2,839,107 B，md5 5ec55ec07c44f2503df63f1bb160a6e6 | docs/06_facts/02_metric_register.md:16；sim/nn/EVIDENCE_M3j.md:228-246 |
| 当前烧录时间 | 2026-10-31 02:02，DONE_PIN=1 / EOS=1 / PROG_RESULT=OK | sim/nn/EVIDENCE_M3j.md:241 |
| 上次动作实测位流 | variant_act3c，2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a | docs/06_facts/00_current_status.md:28 |
| 上次烧录时间 | 2026-10-30 21:10:36 | docs/06_facts/00_current_status.md:28 |
| 事件分辨率 | 400×240 像素，网格 50×30（>>3） | docs/03_tech/06_rtl_design_and_pitfalls.md:143-144 |
| 决策节拍 | 100 ms 不重叠窗，连续 3 窗，不应期 1.5 s，空窗 1.0 s 清零 | docs/04_contest/05_report_outline_and_style.md:90 |
| 上行端口 | UDP 1234（评测脚本不绑定） | docs/05_experiments/m5_board_acceptance_20261029.md:237 |
| 时间基准 | frames.csv t_board_ms、events.csv frame_t_ms、video frame_idx | docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:55 |

## 3. 数据与标签来源

本报告使用三段主录与一段短探针。v5probe 用于真机 v5 评测，v7hands 用于 v7 离线留出，round2 指 20261030-215700_v6clean，用于 v6 表征验证与标签边界复核（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:49-53）。20261030-214353_v6clean 只有 21.978 s，作为短探针列出，不参与主结论（源：report/evidence/event_stream_stats.json sessions.v6clean384）。四段均记录 0 丢帧、0 丢事件（源：各会话 meta.json counters）。

| 会话 | 用途 | 帧数 | 事件数 | 板卡跨度 s | 有效 fps | 事件每秒 | 数据来源 |
|---|---|---:|---:|---:|---:|---:|---|
| 20261030-212214_v5probe | v5 真机评测 | 11,516 | 10,312,327 | 432.143 | 26.646 | 23,863.23 | report/evidence/event_stream_stats.json sessions.v5probe |
| 20261030-214353_v6clean | 短探针 | 587 | 2,052 | 21.978 | 26.663 | 93.37 | report/evidence/event_stream_stats.json sessions.v6clean384 |
| 20261030-215700_v6clean | round2 表征验证 | 5,174 | 6,012,765 | 194.356 | 26.616 | 30,936.86 | report/evidence/event_stream_stats.json sessions.v6clean |
| 20261030-222201_v7hands | v7 离线留出 | 6,831 | 7,913,893 | 256.088 | 26.671 | 30,903.02 | report/evidence/event_stream_stats.json sessions.v7hands |

四段合计 24,108 帧、24,241,037 事件（源：report/evidence/event_stream_stats.json 四会话 frames/events 相加，逐行来源见上表）。v5probe 与 v7hands 的事件率都在 2.4 万至 3.1 万事件每秒，v6clean384 只有 93.37 事件每秒（源：report/evidence/event_stream_stats.json sessions.*.events_per_s）。高事件率场景的 100 ms 桶 p95 为 9,582.35 至 10,979.6 事件，最大桶 67,256 事件（源：同上 bucket100_p95 与 bucket100_max）。v6clean384 的 p95 仅 15 事件，只适合做标签边界检查，不适合做吞吐结论。

有效 fps 由帧数除以板卡跨度得到，不采用容器声明的 30 fps（源：report 下 figures/stream_stats.py 的 frames/span 计算）。v5probe 为 11,516÷432.143=26.646 fps，v7hands 为 6,831÷256.088=26.671 fps（源：report/evidence/event_stream_stats.json sessions.*.fps_effective）。按容器 30 fps 换算会把 1 s 的实际时间压成 0.889 s，事件率与段时长都会被高估约 12.5%（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:23）。

图 F2(a) 按分区给出事件率，空桌面 26.9 至 35.4 事件每秒，静止段 685.8，动作与硬负段 14,528.7 至 82,627.2（图见 [图 F2](<figures/f2_data_volume.svg>)，源：report/evidence/event_stream_stats.json v7_zones）。图 F2(b) 给出四段会话的事件 CSV 与原始帧字节比，分别为 0.03607、0.00013、0.04589、0.04665（源：同上 sessions.*.events_csv_ratio）。事件流把数据量压到原始帧的 3.6% 至 4.7%，短探针只有 0.013%（源：同上）。

图 F3 把事件处理管线画成 8 级，包含事件写入、坐标平移、clamp、网格化、桶累加与特征输出（图见 [图 F3](<figures/f3_event_pipeline.svg>)，源：report 下 figures/make_figures.py 的 f3 函数）。图中标注每像素 2 拍平移与 1 拍网格化，板上按 50 MHz 单时钟推进（源：sim/nn/EVIDENCE_M3.md:31）。图 F3 的时间单位是拍，不是毫秒，读图时按 20 ns 每拍换算（源：同上）。管线在窗口边界前完成特征冻结，推理不抢占事件累积（源：同上:29）。

v5probe 的段标签由用户口头报时，按 frames.csv 首帧到达时间对齐（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:55）。v7hands 的相位边界不用秒表，改用 t_board_ms 的逐 2 s dx 中位数，开合约 6 至 16、挥手约 20 至 38（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:21）。v6clean 的 11 个标注段在事件流复核时出现偏移，挥手起点最多偏 3.5 s、终点最多偏 6.5 s（源：nn/REPORT_v6_表征实验.md:118-124）。

每个 chunk 的 frames.csv 给出 frame_idx、t_board_ms 与 t_arrive_ms 三列，frame_idx 严格递增（源：docs/03_tech/05_action_uplink_contract.md:109）。时间轴以 t_board_ms 为准，t_arrive_ms 只用于诊断网络抖动，不参与标签对齐（源：同上）。videoFrame 取 frame_idx，videoTime 等于 frame_idx 除以 fpsNominal，标注与回放都按这条映射（源：同上:462）。

标签误差主要来自三处。口头报时只有秒级精度，换手与开合交界处会混入瞬时动作；mp4 容器时间轴压缩 11.1%，按秒定位会累积偏差；v6clean 的部分静止段前 6.5 s 实际仍在挥手（源：nn/REPORT_v6_表征实验.md:123-124）。报告统一用 frame_idx 与 t_board_ms 复核，不用容器秒数反推。v5probe 的 118 条脉冲中 117 条落在标签段内，1 条落在挥手窗后边界外（源：measure_v5_false_triggers_20261030.md:67）。

v7 的切分按窗中心落段，和 exclude 段相交的窗直接丢弃；原始 5,120 窗保留 4,589 窗，另加 3,279 个镜像副本和 6,579 个 7 min 对照窗，数据集共 14,447 行（源：nn/REPORT_v7_数据集.md:9-11,41）。镜像只对 view A 生效，view B 不镜像，避免把视角切换混进训练（源：同上:19-36）。两个转动段不进入任何训练或验证窗（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:19）。

## 4. v5 实机评测

v5 是当前唯一有板上事件通路证据的模型。板上 432.04 s 内共记录 118 条 ACTION 脉冲，全程 16.4 次/分，conf 饱和到 31 的占 64.4%（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:67）。空桌面 0 条，手静止 A 与 B 均为 0 条，人不在画面 1 条（源：同上:59-65）。这说明 v5 在无运动场景没有明显误触。

开合段 118 s 内 61 条，31.02 次/分；挥手段 93 s 内 47 条，30.32 次/分；换手/摆位段 14 s 内 8 条，34.29 次/分（源：同上:61-65）。三段都接近 1.5 s 不应期的 40 次/分上限，分别达到 77.6%、75.8%、85.7%（源：同上:89）。脉冲最小间隔 1,687 ms，大于 1.5 s 整定值，没有因不应期被压制后重复报的迹象（源：同上:81-87）。

各段次每分按脉冲数除以段时长再乘 60 计算，不扣除 0.5 s 守卫带（源：measure_v5_false_triggers_20261030.md:61-65）。开合段 61÷118×60=31.02，挥手段 47÷93×60=30.32，换手 8÷14×60=34.29（源：同上）。全程 118÷432.04×60=16.4，是混合动作下的平均值，不能与单段率直接比较（源：同上:67）。

v5 的评测在同一块板、同一光照、同一机位下完成。摄像头为 OV5640，分辨率 400×240，事件率约 2.4 万每秒（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:49-53）。这些条件在其他场景不保证成立，报告不给跨场景外推（源：measure_v5_false_triggers_20261030.md:145）。

同一段录像的离线回放给出 60 条开合脉冲、46 条挥手脉冲、1 条静止误触，挥手 29.68 次/分（源：同上:134-136）。回放与板上计数差 1 条，说明复跑没有跑偏（源：同上:143）。这是同一录制的交叉验证，不是独立测试集，不能用于泛化结论（源：同上:145）。

v5 对开合、挥手、换手都给近似相同的脉冲密度，说明它主要响应手部运动，动作类别区分有限（源：同上:89）。挥手窗级 class1 命中率为 0.652，等于每三个挥手窗就有一个被判成开合（源：同上:129）。该行为不满足低于 1 次/分的误触发门限，v5 不能作为交付模型（源：docs/04_contest/05_report_outline_and_style.md:92）。

运动学统计给出 v5 失效的物理解释。挥手 100 ms 窗事件数 8,506，开合 1,925，相差 4.4 倍；质心速度 p50 只差 1.19 倍（源：measure_v5_false_triggers_20261030.md:99-103）。相邻窗网格互相关开合 0.60、挥手 0.49，手静止 0.58，区分度有限（源：同上）。v5 输入没有显式平移归一化，卷积核先看到整体位移，于是把挥手判成开合（源：同上:106）。conf 31 在 118 条中占 76 条，开合 37/61、换手 5/8、挥手 33/47 都饱和，抬高阈值的空间很小（源：同上:93）。

图 F7 汇总的 v7 留出组开合脉冲率为 30.77 次/分，与 v5 实机的 31.02 次/分接近（图见 [图 F7](<figures/f7_heldout_rates.svg>)，源：figure_data_table.csv f7 与 measure_v5_false_triggers_20261030.md:61）。两个数字来自不同模型和不同测试集，只说明量级相近。图 F7 的挥手、静止、空桌面为 0，说明 v7 的类别区分明显好于 v5（源：figure_data_table.csv f7）。

| 段 | 相对秒 | 秒数 | 脉冲数 | 次/分 | conf31 | 数据来源 |
|---|---:|---:|---:|---:|---:|---|
| 空桌面 | 0–50 | 50 | 0 | 0.00 | 0 | measure_v5_false_triggers_20261030.md:59 |
| 人不在画面 | 50–128 | 78 | 1 | 0.77 | 1 | measure_v5_false_triggers_20261030.md:60 |
| 开合 | 128–246 | 118 | 61 | 31.02 | 37（60.7%） | measure_v5_false_triggers_20261030.md:61 |
| 手静止 A | 246–281 | 35 | 0 | 0.00 | 0 | measure_v5_false_triggers_20261030.md:62 |
| 换手/重新摆位 | 281–295 | 14 | 8 | 34.29 | 5（62.5%） | measure_v5_false_triggers_20261030.md:63 |
| 手静止 B | 295–328 | 33 | 0 | 0.00 | 0 | measure_v5_false_triggers_20261030.md:64 |
| 挥手 | 328–421 | 93 | 47 | 30.32 | 33（70.2%） | measure_v5_false_triggers_20261030.md:65 |
| 挥手窗后边界 | 421.289 | — | 1 | — | 1 | measure_v5_false_triggers_20261030.md:66 |
| 合计 | 0–432.04 | 432.04 | 118 | 16.4 | 76（64.4%） | measure_v5_false_triggers_20261030.md:67 |

## 5. v7 离线评测

v7 使用 fmin_n_rel7 的 7 路全局特征，特征名为 n_div16、prev_n_div16、pol_bal、dx、dy、dx_rel、dy_rel（源：nn/out_v7/results_v7_final.json:4-13）。模型仍是 int8 二分类，输入保留 4 通道平移归一化网格，每 100 ms 窗推理一次（源：nn/REPORT_v7_数据集.md:48-58）。v7 数据集共 14,447 行，y0、y1、y2 分别为 5,067、5,480、3,900（源：nn/REPORT_v7_数据集.md:41）。

7 路全局量分成三类。n_div16 与 prev_n_div16 描述当前窗与前一窗的归一化事件数；pol_bal 描述极性平衡；dx、dy、dx_rel、dy_rel 描述平移与相对平移（源：nn/out_v7/results_v7_final.json:4-13）。这组特征把 v5 缺失的平移量显式送入分类器，同时保留 4 通道网格作为局部形状输入（源：nn/REPORT_v7_数据集.md:48-58）。训练与推理使用同一组特征名，特征顺序在 json 中固定（源：results_v7_final.json:4-13）。

A 组按时间折分。两个折的测试窗数为 3,935 与 3,933，窗准确率为 0.9042 与 0.8754（源：results_v7_final.json:29-31,2330-2332）。pooled 开合召回 0.9412，对应 16/17 块；去掉 0.5 s 守卫带后为 17/17=1.000（源：同上:4637-4638,4655-4656）。pooled 挥手窗级命中 5/510=0.0098，静止 0 脉冲，空桌面 0 脉冲，硬负样本 1 脉冲（源：同上:4643-4652）。守卫带按 zone 首尾各 0.5 s、5 个决策点排除（源：同上:4653-4654）。

B 组按远区时间切分，远区前一半训练、后一半测试，镜像样本不进入训练（源：同上:5617）。测试集 940 窗，窗准确率 0.916，混淆矩阵为 376、24、55、485（源：同上:5622-5629）。开合块召回 3/3，挥手脉冲为 0（源：同上:5639-5640）。远区只有 open_L_far 与 wave_L_far 两段，样本量小于 A 组（源：同上:5618-5620）。

C 组检查镜像一致性。d_open_max 为 0.0，d_open_chunk_diff_max 为 0，d_wave_max 为 0.0078，gate_chunk_pass 为 true（源：同上:6375-6379）。不做镜像训练时，aug0 到 aug1 的开合召回降到 4/9 与 7/9（源：同上:6386-6393）。镜像侧是合成副本，只能证明左右对称性，不能替代真实右手数据（源：同上:6318）。

D 组检查空场景。v7 的 empty_A 与 empty_A2 分别有 150 与 160 个低事件窗，命中均为 0（源：同上:6434-6441）。7 min 对照的 empty_desk 段 500 窗、250 决策、0 脉冲（源：同上:6446-6453）。int8 决策链的 D_empty 仍给出 static_fp_per_min_max 0.882，超过 0.5 次/分门限（源：同上:6425）。

Q 组检查 int8 一致性。A 组留出一致率为 0.970775 与 0.987796，B_distance 为 0.982979（源：同上:6401-6406）。最低值 0.970775 低于 0.99 上板门槛，QAT 训练 8 epoch 仍未补齐（源：同上:6405-6408）。Q_int8.int8_decision.pass 为 false，触发项是 D_empty 的 0.882 次/分，A_time 判据本身通过（源：同上:6410-6429）。

四组判据覆盖时间、距离、镜像与空场景。A 组回答同分布留出，B 组回答远区迁移，C 组回答左右对称，D 组回答空场景误触（源：results_v7_final.json:24,5616,6317,6432）。四组都通过各自的块级门，但 Q_int8 的整链 pass 仍为 false（源：同上:6429）。原因是 int8 静止误触 0.882 次/分超过 0.5 次/分门限（源：同上:6425）。

训练折的样本量为 5,112 与 5,115，测试折为 3,935 与 3,933（源：results_v7_final.json:29-30,2330-2331）。7 min 对照集有 6,579 窗，其中 empty_desk 500 窗、static_a 350 窗、static_b 330 窗（源：同上:6445-6493）。对照集只用于空场景与静止检查，不进入主训练（源：nn/REPORT_v7_数据集.md:38）。

RTL 引擎的逐位一致由 E2 组 golden 模型覆盖，E2_GOLD_COVER 与三层 BYTE_EXACT 全部通过（源：sim/nn/EVIDENCE_M3.md:42）。这条证据针对 v2 串行引擎与 v1 数学等价，不针对 v7 权重（源：同上:31）。v7 权重的 RTL 参数、ROM 与位流已在 act7 批次生成，实测见本章 5.3 节（源：sim/nn/EVIDENCE_M3f.md:5,108-117）。

图 F9 给出 v7 训练、镜像与 7 min 对照的窗数构成，raw、mirror、control 分别为 4,589、3,279、6,579（图见 [图 F9](<figures/f9_data_composition.svg>)，源：nn/REPORT_v7_数据集.md:19-41）。三类合计 14,447 行，与 npz 总行数一致（源：同上:41）。图 F9 的 5 组柱状数 1,560、1,020、400、619、990 来自 zone 窗数（源：同上:19-31）。

| 组 | 判据 | 结果 | 数据来源 |
|---|---|---|---|
| A_time | 时间折留出，pooled 开合与挥手 | 折窗 acc 0.9042/0.8754；开合 16/17；无守卫 17/17；挥手 5/510；硬负 1 脉冲 | results_v7_final.json:31,2332,4637-4638,4652,4655-4656,4705 |
| B_distance | 远区时间切分 | 940 窗；acc 0.916；混淆 376/24/55/485；开合 3/3 | results_v7_final.json:5617-5629,5639-5640 |
| C_mirror | 镜像训练，左右对称门 | d_open_max 0.0；d_wave_max 0.0078；gate 通过 | results_v7_final.json:6375-6379 |
| D_empty | 空桌面与低事件窗 | 150/160 低事件窗 0 命中；对照 500 窗 0 脉冲；int8 静止 0.882 次/分 | results_v7_final.json:6425,6434-6453 |
| Q_int8 | 量化一致率与决策链 | 0.970775 / 0.987796 / 0.982979；pass=false | results_v7_final.json:6401-6429 |
| Golden | RTL 逐位比对 | E2_GOLD_COVER、三层 BYTE_EXACT 全过 | sim/nn/EVIDENCE_M3.md:42 |

### 5.1 决策门限标定

s100 部署口径下扫描了 margin 六档与连续窗数三档，共 18 组（源：nn/out_v7b/s100_threshold_sweep.json:1-12）。每组统计开合块命中、挥手脉冲、静止率、空桌面脉冲与硬负脉冲（源：同上）。图 F11 把 N_CONSEC 三档拆成三个面板，蓝线为开合命中、红线为硬负脉冲（图见 [图 F11](<figures/f11_threshold_sweep.svg>)）。

| margin | N_CONSEC | 开合命中 | 挥手 pulse | 静止（次/分） | 空桌面 pulse | 硬负 pulse | 总 pulse | 数据来源 |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 8 | 3 | 17/17 | 1 | 0.0 | 0 | 3 | 88 | s100_threshold_sweep.json:3-12 |
| 8 | 4 | 16/17 | 1 | 0.0 | 0 | 2 | 77 | s100_threshold_sweep.json:15-24 |
| 8 | 5 | 16/17 | 1 | 0.0 | 0 | 2 | 66 | s100_threshold_sweep.json:27-36 |
| 12 | 3 | 16/17 | 1 | 0.0 | 0 | 2 | 84 | s100_threshold_sweep.json:39-48 |
| 12 | 4 | 16/17 | 1 | 0.0 | 0 | 2 | 71 | s100_threshold_sweep.json:51-60 |
| 12 | 5 | 16/17 | 1 | 0.0 | 0 | 2 | 57 | s100_threshold_sweep.json:63-72 |
| 16 | 3 | 17/17 | 1 | 0.0 | 0 | 2 | 74 | s100_threshold_sweep.json:75-84 |
| 16 | 4 | 16/17 | 1 | 0.0 | 0 | 2 | 57 | s100_threshold_sweep.json:87-96 |
| 16 | 5 | 14/17 | 1 | 0.0 | 0 | 2 | 44 | s100_threshold_sweep.json:99-108 |
| 24 | 3 | 15/17 | 1 | 0.0 | 0 | 2 | 44 | s100_threshold_sweep.json:111-120 |
| 24 | 4 | 14/17 | 1 | 0.0 | 0 | 1 | 32 | s100_threshold_sweep.json:123-132 |
| 24 | 5 | 8/17 | 1 | 0.0 | 0 | 1 | 22 | s100_threshold_sweep.json:135-144 |
| 32 | 3 | 9/17 | 1 | 0.0 | 0 | 1 | 23 | s100_threshold_sweep.json:147-156 |
| 32 | 4 | 6/17 | 1 | 0.0 | 0 | 0 | 12 | s100_threshold_sweep.json:159-168 |
| 32 | 5 | 3/17 | 1 | 0.0 | 0 | 0 | 7 | s100_threshold_sweep.json:171-180 |
| 48 | 3 | 1/17 | 0 | 0.0 | 0 | 0 | 2 | s100_threshold_sweep.json:183-192 |
| 48 | 4 | 0/17 | 0 | 0.0 | 0 | 0 | 0 | s100_threshold_sweep.json:195-204 |
| 48 | 5 | 0/17 | 0 | 0.0 | 0 | 0 | 0 | s100_threshold_sweep.json:207-216 |

s100 板端口径下，8/3 与 16/3 在开合 17/17、挥手 1、静止 0、空桌面 0 四项相同（源：nn/out_v7b/s100_threshold_sweep.json:3-12,75-84）。16/3 把硬负从 3 降到 2，总 pulse 从 88 降到 74（源：同上）。24/4 把硬负压到 1，开合掉到 14/17，不可接受（源：同上:123-132）。8/3 的 88 条 pulse 高于 16/3 的 74 条，硬负也多 1 条，所以部署取 16/3（源：同上）。

### 5.2 部署口径重训（v7b）

本节 pulse 数均为 s100 板端口径。v7 权重在 s100 板端口径下挥手 5 条、硬负 5 条，总 pulse 97（源：nn/REPORT_s100_部署口径复核.md:76）。v7b 用 s50 与 s100 混合重训后，挥手 1 条、硬负 2 条、总 pulse 74（源：nn/REPORT_v7b_部署口径重训.md:212-216）。开合仍为 17/17，静止 0 次/分，空桌面 0 条（源：docs/06_facts/03_v7b_deployment_decision.md:18-21）。重训主要补偿 prev 晚 50 ms 与 dx/dy 时基偏移，判别能力没有实质提升（源：nn/REPORT_v7b_部署口径重训.md:220-222）。

两项指标未达内部门槛。硬负 pulse 为 2，高于 ≤1 的门限；镜像 d_wave 为 0.0196，高于 ≤0.01 的门限（源：docs/06_facts/03_v7b_deployment_decision.md:22-23）。这两项写成未通过，不做取整或换口径处理（源：同上:25）。V7B_MODEL_OK 记为 0，v7b 仍作为 act8 权重是一次显式风险接受（源：同上:8-9）。

s100 板端口径下，硬负的 2 条脉冲来自 view B 的卷纸与打字，对应约 46.5 s 素材，折算约 2.6 次/分（源：docs/06_facts/03_v7b_deployment_decision.md:22,43）。部署视角 A 下的真实误报率仍未测量，须由 A1~A4 上板验收给出（源：同上:48）。镜像 d_wave 从 v7 的 0.0078 退化到 0.0196，方向是左右手通用性（源：同上:44）。

### 5.3 act7 与 act8 构建实测

v7 链路的 RTL 参数、ROM 与位流已在 act7 批次一次构建成功，批次目录为 build/variant_act7（源：sim/nn/EVIDENCE_M3f.md:5）。act7 最终布线 WNS +0.059 ns、TNS 0、WHS +0.027 ns、THS 0，全部时序约束满足（源：同上:15,57）。WNS 只有 8 ns 周期的 0.74%，比 act3c 的 +0.306 ns 少 247 ps（源：同上:20,74）。

act7 资源为 LUT 22,371（35.29%）、FF 14,325（11.30%）、Slice 7,968（50.27%）、BRAM 87（64.44%）、DSP 8（3.33%）、IOB 140（49.12%）（源：sim/nn/EVIDENCE_M3f.md:108-117）。相对 act3c，LUT 增 1,812、FF 增 2,475、Slice 增 641、BRAM 不变、DSP 增 1、IOB 不变（源：同上）。资源仍低于预算的 LUT +2,800、FF +3,200、BRAM +7、DSP +8（源：docs/03_tech/04_action_recognition_selection.md:177-181）。

act7 位流为 2,835,423 B，md5 9c13668c029c9d3a248cf69cbec03582，构建耗时 10 分 06 秒（源：sim/nn/EVIDENCE_M3f.md:42,128-129）。act3c 位流为 2,890,875 B，md5 a5fff751e20019d7e80a3a953f7f8c5a，两者相差 55,452 B（源：docs/06_facts/00_current_status.md:28；sim/nn/EVIDENCE_M3f.md:19）。act7 尚未烧板，板上时延与误触率本版未测量（源：sim/nn/EVIDENCE_M3f.md:6）。

act8 在同一 RTL 上换 v7b ROM（源：build/act8_romswap.log:2,15,28），首轮 Default 构建 WNS +0.188 ns，按预置脚本以 Explore 加 phys_opt 重跑后交付 WNS +0.215 ns、TNS 0、WHS +0.017 ns、THS 0（源：build/variant_act8_final/chosen.txt:3；report/evidence/act8_artifacts.txt:7-12）。act8 的 setup 端点 84,390、hold 端点 84,367，全部时序约束满足（源：build/variant_act8_final/timing.rpt:131,134）。act8 资源为 LUT 22,383（35.30%）、FF 14,325（11.30%）、Slice 8,026（50.64%）、BRAM 86.5（64.07%）、DSP 8（3.33%）、IOB 140（49.12%）（源：build/variant_act8_final/util.rpt:34,39,72,104,119,130）。

act8 位流为 2,839,107 B，md5 5ec55ec07c44f2503df63f1bb160a6e6（源：report/evidence/act8_artifacts.txt:4-5）。相对 act7，WNS 提高 0.156 ns，LUT 增 12、FF 不变、Slice 增 58、BRAM 减 0.5、位流增 3,684 B（源：同上 与 build/variant_act8_final/util.rpt:34,39,72,104）。act8 采用 v7b 权重与 margin=16、N_CONSEC=3 部署门限，仍属风险接受版本（源：docs/06_facts/03_v7b_deployment_decision.md:4,10,9）。act8 已于 2026-10-31 02:02 烧板，DONE_PIN=1 / EOS=1 / PROG_RESULT=OK，并于同日 15:49–16:26 完成 4 轮 A1~A4 上板验收（3 轮有效，A3 累计 48/60=0.80，A1/A2 零误触，A4 共 1 条退场过渡，G2 未稳定达标）；板上时延仍无逐条时间戳，本版未测量（源：sim/nn/EVIDENCE_M3j.md:228-246；docs/06_facts/02_metric_register.md:82；records/20261031-162341_verify_v7/acceptance.md）。

图 F12 把 act3c、act7 与 act8 的时序、六项资源占比与位流大小并排（图见 [图 F12](<figures/f12_act7_vs_act3c.svg>)）。图内位流差 act7−act3c 为 55,452 B、act8−act7 为 3,684 B；WNS 差 act7−act3c 为 0.247 ns（源：figure_data_table.csv f12）。图 F11 与图 F12 的每个数值都写入 figure_data_table.csv，可逐行回查（源：同上）。

## 6. 资源与时序

act3c 是上一次 v5 动作实测所用位流，资源为 LUT 20,559（32.43%）、FF 11,850（9.35%）、Slice 7,327（46.23%）、BRAM 87（64.44%）、DSP 7（2.92%）、IOB 140（49.12%）（源：build/variant_act3c/inproc_util_impl.rpt:34,39,72,104,119,130）。相对 M0 基线 18,973 / 11,296 / 6,721 / 77.5 / 6 / 140，实测增量为 +1,586 / +554 / +606 / +9.5 / +1 / 0（源：docs/03_tech/04_action_recognition_selection.md:77-81）。预算新增为 +2,800 / +3,200 / +800 / +7 / +8 / 0，LUT、FF、BRAM、DSP 均低于预算，Slice 多 606（源：同上:177-181）。

引擎接入主设计的单独对比在 M3c：Slice LUT 从 21,518 增到 21,913，增 395（源：sim/nn/EVIDENCE_M3c.md:176）。该增量不是 act3c 最终布线值，M0 到 act3c 的 +1,586 包含引擎、回传与修复（源：同上；build/variant_act3c/inproc_util_impl.rpt:34）。因此不能把 +1,586 全部记到神经网络（源：docs/03_tech/04_action_recognition_selection.md:77 与 inproc_util_impl.rpt:34）。

资源余量以 Slice 最紧，46.23%；BRAM 64.44% 次之（源：build/variant_act3c/inproc_util_impl.rpt:72,104）。LUT 与 FF 占用都低于 33%，IOB 49.12% 与引脚分配一致（源：同上:34,39,130）。比例按 xc7a100t 的 63,400 LUT、126,800 FF、15,850 Slice、135 BRAM、240 DSP、285 IOB 归一（源：docs/03_tech/04_action_recognition_selection.md:74-82）。

act3c 最终布线 WNS 为 +0.306 ns、TNS 为 0、WHS 为 +0.036 ns，76,854 个 setup 端点全部满足（源：build/variant_act3c/timing_deliver.rpt:131）。中间版本 inproc_timing.rpt 的 WNS 为 -0.175 ns，不作为交付结论（源：docs/04_contest/05_report_outline_and_style.md:87）。v1 的 -7.001 ns 与 v2 的 +8.827 ns 是不同约束与不同实现，不能直接连成收敛曲线（源：sim/nn/EVIDENCE_M3.md:205）。

最紧的时钟域是 125 MHz 的 eth_rxc，WNS +0.306 ns、TNS 0（源：build/variant_act3c/timing_deliver.rpt:189）。50 MHz 的 clk_out2 域 WNS +2.695 ns、43,201 个端点，余量更大（源：同上:220）。限制来自跨时钟或以太网通路，不是 50 MHz 主时钟（源：同上:131）。

单次推理在 50 MHz 下 440,087 拍、8.80 ms（源：sim/nn/EVIDENCE_M3.md:29）。周期分解为 2×208,080 加 6×3,987 加 5，合计 440,087 拍（源：同上:121）。100 ms 窗占空比 8.80%，K=6 的 600 ms 窗为 827,154 拍、16.54 ms、2.76%（源：同上:123-125）。

图 F4 画 act3c、act7、act8 三代资源，图 F5 画六组 WNS（图见 [图 F4](<figures/f4_resources.svg>) 与 [图 F5](<figures/f5_timing.svg>)）。两图数值与本节表同源，figure_data_table.csv 现有 182 行带源数据点（源：report/figures/figure_data_table.csv）。图 F4 的 Slice 标签用 act3c 46.23% 与 act8 50.64%，分别对应 Slice 行（源：report/figures/f4_resources.svg）。单窗时间预算见 [图 F6](<figures/f6_cycle_budget.svg>)。

| 资源 | M0 基线 | 预算新增 | act3c 实测 | 占器件 | Δ 相对基线 | 数据来源 |
|---|---:|---:|---:|---:|---:|---|
| Slice LUT | 18,973 | +2,800 | 20,559 | 32.43% | +1,586 | 04_action_recognition_selection.md:77,177；inproc_util_impl.rpt:34 |
| Slice Registers | 11,296 | +3,200 | 11,850 | 9.35% | +554 | 04_action_recognition_selection.md:78,178；inproc_util_impl.rpt:39 |
| Slices | 6,721 | +800 | 7,327 | 46.23% | +606 | 04_action_recognition_selection.md:79,179；inproc_util_impl.rpt:72 |
| Block RAM Tile | 77.5 | +7 | 87 | 64.44% | +9.5 | 04_action_recognition_selection.md:80,180；inproc_util_impl.rpt:104 |
| DSP48E1 | 6 | +8 | 7 | 2.92% | +1 | 04_action_recognition_selection.md:81,181；inproc_util_impl.rpt:119 |
| Bonded IOB | 140 | 0 | 140 | 49.12% | 0 | 04_action_recognition_selection.md:82；inproc_util_impl.rpt:130 |

表 6-2 把 act3c、act7、act8 的资源并列，并给出每一步增量（源：build/variant_act3c/inproc_util_impl.rpt:34,39,72,104,119,130；sim/nn/EVIDENCE_M3f.md:108-117；build/variant_act8_final/util.rpt:34,39,72,104,119,130）。act7 相对 act3c 增 LUT 1,812、FF 2,475、Slice 641、DSP 1，BRAM 与 IOB 不变（源：同上）。act8 相对 act7 只增 LUT 12、Slice 58、BRAM 减 0.5，FF、DSP、IOB 不变（源：同上）。

| 资源 | act3c | act7 | Δ1（act7−act3c） | act8 | Δ2（act8−act7） | 增量来源 | 数据来源 |
|---|---:|---:|---:|---:|---:|---|---|
| Slice LUT | 20,559 | 22,371 | +1,812 | 22,383 | +12 | Δ1：v7 两分类网络与 7 路全局特征 MLP；其中 nn_winfeat +1,068。Δ2：v7b ROM 与 margin 16 | EVIDENCE_M3f.md:108,121；act8_romswap.log:2,44；chosen.txt:3 |
| Slice Registers | 11,850 | 14,325 | +2,475 | 14,325 | 0 | Δ1：nn_winfeat +1,562 与特征通路；Δ2：无新增寄存器 | EVIDENCE_M3f.md:111,121；variant_act8_final/util.rpt:39 |
| Slices | 7,327 | 7,968 | +641 | 8,026 | +58 | Δ1：v7 前端与决策链展开；Δ2：v7b ROM 替换与 Explore/phys_opt 布局 | EVIDENCE_M3f.md:112；act8_romswap.log:2；chosen.txt:3 |
| Block RAM Tile | 87 | 87 | 0 | 86.5 | -0.5 | Δ1：无 BRAM 增量；Δ2：v7b 权重替换使 BRAM Tile 分数降 0.5（实现报告口径） | EVIDENCE_M3f.md:113；variant_act8_final/util.rpt:104 |
| DSP48E1 | 7 | 8 | +1 | 8 | 0 | Δ1：nn_winfeat 的乘加；Δ2：无新增 | EVIDENCE_M3f.md:116,121；variant_act8_final/util.rpt:119 |
| Bonded IOB | 140 | 140 | 0 | 140 | 0 | 两代都不改引脚分配 | EVIDENCE_M3f.md:117；variant_act8_final/util.rpt:130 |

表 6-3 把三代的时序与位流并列（源：build/variant_act3c/timing_deliver.rpt:131；sim/nn/EVIDENCE_M3f.md:15,57,128-129；build/variant_act8_final/timing.rpt:131；report/evidence/act8_artifacts.txt:4,5,7,9,11）。act7 把 WNS 从 +0.306 ns 压到 +0.059 ns，端点从 76,854 增到 84,405（源：同上）。act8 用 Explore 加 phys_opt 把 WNS 提到 +0.215 ns，端点 84,390，TNS 与 THS 仍为 0（源：build/variant_act8_final/chosen.txt:3 与 timing.rpt:131）。

| 项目 | act3c | act7 | Δ1（act7−act3c） | act8 | Δ2（act8−act7） | 数据来源 |
|---|---:|---:|---:|---:|---:|---|
| WNS（ns） | +0.306 | +0.059 | -0.247 | +0.215 | +0.156 | variant_act3c/timing_deliver.rpt:131；EVIDENCE_M3f.md:15；variant_act8_final/timing.rpt:131 |
| TNS（ns） | 0 | 0 | 0 | 0 | 0 | 同上 |
| WHS（ns） | +0.036 | +0.027 | -0.009 | +0.017 | -0.010 | 同上 |
| THS（ns） | 0 | 0 | 0 | 0 | 0 | 同上 |
| setup 端点数 | 76,854 | 84,405 | +7,551 | 84,390 | -15 | 同上 |
| 位流（B） | 2,890,875 | 2,835,423 | -55,452 | 2,839,107 | +3,684 | docs/06_facts/00_current_status.md:28；EVIDENCE_M3f.md:128；act8_artifacts.txt:4 |
| 位流 md5 | a5fff751e20019d7e80a3a953f7f8c5a | 9c13668c029c9d3a248cf69cbec03582 | - | 5ec55ec07c44f2503df63f1bb160a6e6 | - | docs/06_facts/00_current_status.md:28；EVIDENCE_M3f.md:129；act8_artifacts.txt:5 |

act8 的位流全文件 md5 为 5ec55ec07c44f2503df63f1bb160a6e6，剥离 127 B 头后的载荷 md5 为 dcbcf543210c33cb22625128bc5f6b97（载荷 2,838,980 B，源：build/variant_act8_final/md5.txt:11,18）。act7 的 +0.059 ns 只有 8 ns 周期的 0.74%，比 act3c 的 +0.306 ns 少 247 ps（源：sim/nn/EVIDENCE_M3f.md:20,74）。最差路径从 act3c 的 CDC FIFO 读指针到 raw_ram 地址端，迁到 act7 的 udp_merge 包长链，逻辑级数从 7 级增到 14 级（源：同上:93-102）。act8 的 WNS 回到 +0.215 ns，为 8 ns 周期的 2.69%，但 setup 端点仍比 act3c 多 7,536（源：build/variant_act8_final/timing.rpt:131；本报告相减）。

act7 的资源增量主要来自 v7 两分类网络、7 路全局特征 MLP 与决策链替换 v5 运动检测器（源：sim/nn/EVIDENCE_M3f.md:108-117,121）。模块级可归因的是 nn_winfeat 的 +1,068 LUT、+1,562 FF、+1 DSP，其余为特征筛选、回传与实现收敛的共同增量（源：同上:121）。act8 只换 v7b ROM 与 margin 16，LUT 增 12、Slice 增 58、BRAM 减 0.5，可归因到权重替换与 Explore/phys_opt 实现选择（源：build/act8_romswap.log:2,44；build/variant_act8_final/chosen.txt:3）。

act8 已构建并于 2026-10-31 02:02 烧板，是当前板上位流（源：sim/nn/EVIDENCE_M3j.md:228-246）。A1~A4 板级验收已于 2026-10-31 15:49–16:26 执行 4 轮（3 轮有效），act8 的动作指标按 7.1 节逐轮结果填写，G2 召回门槛未稳定达标（源：records/20261031-160544_verify_v7/acceptance.md、records/20261031-161557_verify_v7/acceptance.md、records/20261031-162341_verify_v7/acceptance.md）。报告不把离线 17/17 填进 act8 板上格，也不把 act7 构建值当成交付结论（源：report/evidence/act8_artifacts.txt:20-21）。待 task-70 回填后，本节资源与时序不改，只补第 7 章动作表（源：docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md:17-18）。

## 7. 与基线对比

v5 在同一段 7 min 录像上给出 24/24 开合块检出、0.652 挥手窗级命中、16.4 次/分全程误触发（源：measure_v5_false_triggers_20261030.md:67,129,135）。v6 的 c3_shift 与 c5_shift_glob 把挥手窗级命中降到 0.0817 与 0.0575，开合仍为 24/24（源：nn/REPORT_v6_表征实验.md:56,59）。c5 的手静止脉冲为 0，int8 一致率 0.9565，未达 0.99（源：同上:3）。

决策链离线标定用 v4 两分类模型在 1,729 窗、20 会话上回放 849 个决策点，总时长 1.415 min（源：nn/REPORT_决策链标定.md:8-10）。class1 动作段 27/27 检出，挥手被两分类模型判成 class1 共 6 个 pulse，折合 4.24 次/分（源：同上:11-12）。该结果证明决策链常量可复现，也暴露两分类模型没有挥手类的结构性缺口（源：同上:12）。

v7 在独立 256 s 会话上给出 s100 开合 17/17、挥手 5 条、硬负 5 条、总 pulse 97（源：nn/REPORT_s100_部署口径复核.md:76）。同一权重的 s50 折级开合 16/17=0.9412、无守卫 pooled 17/17=1.000、挥手窗级 5/510=0.0098，只作训练侧对照（源：results_v7_final.json:4637-4638,4655-4656,4696,4704-4705）。v7 的 s50 挥手窗级命中比 c5 低约 5.9 倍，开合折级低 0.059，两者测试集不同（源：nn/REPORT_v6_表征实验.md:59、results_v7_final.json:4638,4655,4705；倍数与差值由本报告相除/相减）。

代价方面，v7 从 17 路全局量筛到 7 路，特征名为 n_div16、prev_n_div16、pol_bal、dx、dy、dx_rel、dy_rel（源：results_v7_final.json:4-13）。输入仍需 4 通道网格，act7 已生成 RTL 参数与位流，但未烧板（源：sim/nn/EVIDENCE_M3f.md:6）。因此表中 v7 一列是离线结果，不是板上指标。

v5、c3、c5 三列来自同一段 7 min 录制，v7 一列来自独立的 222201 会话，样本与场景不同（源：measure_v5_false_triggers_20261030.md:145 与 results_v7_final.json:4631）。表中的数值不能直接做显著性比较，只能看改动方向与量级（源：nn/REPORT_v6_表征实验.md:1 与 results_v7_final.json:24）。v7 的 A 组 16/17 与 17/17 也因守卫带不同而并列，不能只取较高值。

三次改动各有代价。c3 把挥手窗级命中从 0.652 降到 0.0817，静止误触为 0.88 次/分；c5 把静止误触降到 0，挥手命中 0.0575，int8 一致率 0.9565（源：nn/REPORT_v6_表征实验.md:3,56,59）。v7 把 s50 挥手窗级命中降到 0.0098，开合折级 0.9412，代价是数据集从 5,120 窗筛到 4,589 窗并增加镜像与对照（源：results_v7_final.json:4637,4705 与 nn/REPORT_v7_数据集.md:9-11）。这些代价不在同一测试集上，不能合成为一个总分（源：measure_v5_false_triggers_20261030.md:145）。

图 F8 把 v5、c3、c5、v7 的挥手误命中率与开合召回并列，v7 标注为 fold-level（图见 [图 F8](<figures/f8_iteration.svg>)）。图 F8 的注记说明折级 16/17 与 pooled 17/17 口径不同（源：figure_data_table.csv f8）。图 F8 的挥手 0.010 只统计 wave 两段 1,020 窗、510 决策，不含硬负样本（源：results_v7_final.json:4695-4705）。

| 版本 | 开合检出 | 挥手误报（窗级/脉冲） | 误触发 | 测试集 | 数据来源 |
|---|---:|---:|---:|---|---|
| v5 | 24/24 | 0.652 | 16.4 次/分 | 7 min 同段离线回放 | measure_v5_false_triggers_20261030.md:67,129,135 |
| v6 c3_shift | 24/24 | 0.0817 | 静止 0.88 次/分 | 7 min 留出 | nn/REPORT_v6_表征实验.md:56 |
| v6 c5_shift_glob | 24/24 | 0.0575 | 静止 0 次/分 | 7 min 留出 | nn/REPORT_v6_表征实验.md:59 |
| v7 (s100) | 17/17 | 5 条 pulse | 硬负 5 条 pulse | v7hands s100 评估集 | nn/REPORT_s100_部署口径复核.md:76 |

板级结果按三个阶段分开写，避免把构建结果当成上板实测。act3c 已在板上运行并做过 v5 实机验收，是唯一有真机动作计数的阶段（源：docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53-67）。act7 已完成 v7 ROM 的构建与时序验收，但未烧板，只有位流、资源和时序三类实测（源：sim/nn/EVIDENCE_M3f.md:5-6,15,108-117）。act8 已完成 v7b ROM 的构建并烧板，WNS +0.215 ns，随后完成 3 轮有效的 A1~A4 板级验收（源：sim/nn/EVIDENCE_M3j.md:228-246；records/20261031-162341_verify_v7/acceptance.md）。act7 与 act8 都是候选交付位流，最终交付以上板验收通过的版本为准，不能把 act7 写成最终交付。

表 7-2 把四个来源并列：v5 板上实测（act3c）、v7 离线 int8、act7 已实测构建、act8 已烧板并完成 A1~A4（源：docs/06_facts/02_metric_register.md:16,35-36 与 report/evidence/act8_artifacts.txt:1-21）。表中每个数字带源；无法测量的格子写明原因，不用离线值顶替（源：同上）。表中「本版未测量」表示该格没有实测证据，不是零值。

| 指标 | act3c 已实测（v5 板上） | v7 离线 int8 | act7 已实测（构建） | act8 已烧板并验收 | 口径与数据来源 |
|---|---|---|---|---|---|
| 开合检出 | 24/24（同段回放） | 17/17（s100） | 本版未测量（未烧板） | 48/60=0.80（3 轮有效：14/20、19/20、15/20） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:135；nn/REPORT_s100_部署口径复核.md:76；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 挥手误报 | 0.652 窗级；47 脉冲、30.32 次/分 | 5 条 pulse | 本版未测量（未烧板） | 本版未测量（A1~A4 不含挥手段） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:63,129；nn/REPORT_s100_部署口径复核.md:76；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 手静止误触 | 0 条 | 0 次/分 | 本版未测量（未烧板） | 0 条（A2 三轮共 180.4 s） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:59-65；nn/REPORT_s100_部署口径复核.md:76；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 空桌面误触 | 0 条 | 0 条（150/160 低事件窗 0 命中） | 本版未测量（未烧板） | 0 条（A1 三轮共 180.4 s） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:59-65；nn/REPORT_s100_部署口径复核.md:117-118；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 硬负 pulse | 本版未测量（无硬负集） | 5 条 | 本版未测量（未烧板） | 本版未测量（A1~A4 不含硬负集） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53-67；nn/REPORT_s100_部署口径复核.md:76；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 板上时延 | 本版未测量（计数无逐条时间戳） | 不适用（离线评估） | 本版未测量（未烧板） | 本版未测量（事件无逐条时延戳） | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |
| 位流大小 | 2,890,875 B | 不适用（离线评估） | 2,835,423 B | 2,839,107 B | docs/06_facts/00_current_status.md:28；sim/nn/EVIDENCE_M3f.md:19；report/evidence/act8_artifacts.txt:4 |
| 时序 WNS | +0.306 ns | 不适用（离线评估） | +0.059 ns | +0.215 ns | build/variant_act3c/timing_deliver.rpt:131；sim/nn/EVIDENCE_M3f.md:15；build/variant_act8_final/timing.rpt:131 |
| Slice LUT | 20,559 | 不适用（离线评估） | 22,371 | 22,383 | build/variant_act3c/inproc_util_impl.rpt:34；sim/nn/EVIDENCE_M3f.md:108；build/variant_act8_final/util.rpt:34 |
| Slices | 7,327 | 不适用（离线评估） | 7,968 | 8,026 | build/variant_act3c/inproc_util_impl.rpt:72；sim/nn/EVIDENCE_M3f.md:112；build/variant_act8_final/util.rpt:72 |
| 位流 md5 | a5fff751e20019d7e80a3a953f7f8c5a | 不适用（离线评估） | 9c13668c029c9d3a248cf69cbec03582 | 5ec55ec07c44f2503df63f1bb160a6e6 | docs/06_facts/00_current_status.md:28；sim/nn/EVIDENCE_M3f.md:129；report/evidence/act8_artifacts.txt:5 |
| 动作计数通路 | ACTION 计数实机 | numpy int8 离线 | RTL 已构建未烧板 | RTL 已烧板并完成 4 轮 A1~A4 | docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:53；nn/out_v7/results_v7_final.json:24；sim/nn/EVIDENCE_M3f.md:6；report/evidence/act8_artifacts.txt:20 |

表 7-3 列出上板验收的逐项判据与实际结果（4 轮实测，逐轮明细见 7.1 节；源：docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md:17-18）。A1 与 A4 要求手离开画面 60 s 与 20 s 内 0 条 class1/class2（源：同上:104,107）。A2 要求手在画面静止 60 s 内 0 条，A3 要求 20 次开合中 TP≥17 且 false≤1（源：同上:105-106）。5 轮合计真值 100 次、总召回≥0.85、总误触发<1 次/分（源：同上:18,20）。

| 项目 | 内容 | 状态 | 数据来源 |
|---|---|---|---|
| A1 双手离开 | 每轮 0–60 s，false=0 | 4 轮全 0（3 轮有效累计 180.4 s） | records/20261031-162341_verify_v7/acceptance.md；m5_board_acceptance_v2_20261030.md:104 |
| A2 手静止 | 60–120 s，false=0 | 4 轮全 0（3 轮有效累计 180.4 s） | records/20261031-162341_verify_v7/acceptance.md；m5_board_acceptance_v2_20261030.md:105 |
| A3 开合 20 次 | 方案 120–190 s（本轮脚本实测 121.0–161.1 s），TP≥17，false≤1 | 有效 3 轮 TP=14/20、19/20、15/20，累计 48/60=0.800；最好一轮 19/20 | records/20261031-160544_verify_v7/acceptance.md、records/20261031-161557_verify_v7/acceptance.md；m5_board_acceptance_v2_20261030.md:106 |
| A4 双手离开 | 方案 190–210 s（本轮脚本实测 161.4–181.7 s），false=0 | 3 轮 0/1/0（1 条为退场过渡；guard 0 口径下 2 条） | records/20261031-161557_verify_v7/acceptance.md；m5_board_acceptance_v2_20261030.md:107 |
| 5 轮汇总 | TP≥85，false≤5，<1 次/分 | 实际执行 4 轮（1 轮无效）；有效 3 轮 TP=48/60=0.800，A1+A2+A4 false 合计 1 条/421.1 s=0.143 次/分 | records/20261031-162341_verify_v7/acceptance.md；m5_board_acceptance_v2_20261030.md:18,20 |

### 7.1 act8 上板验收结果（2026-10-31 实测）

act8 验收工具 v1.2.0 于 02:39 交付（`ACCEPT_FIX_OK=1`，自检 `CHECK_SUMMARY=PASS PASS_COUNT=41 FAIL_COUNT=0`、`ACCEPT_SELFTEST=PASS`）。2026-10-31 15:49–16:26 在板上同一 act8 位流（md5 5ec55ec0…）上连续执行 4 轮 A1~A4；第 1 轮 A4 段双手未离开画面，协议未执行，判为无效轮；其余 3 轮有效。本节数字全部抄自 `records/<session>/acceptance.md`，未重算门限，也未重跑挑结果。

| 轮次 | 会话目录 | 时段 | A1 false | A2 false | A3 TP/20 | A4 false（guard 0.5 s） | VERIFY_PASS | 未过项 |
|---|---|---|---:|---:|---:|---:|---|---|
| 1 | `records/20261031-154917_verify_v7` | 15:49:17–15:52:22 | 0 | 0 | 9/20=0.450 | 6 | 0 | 无效轮（A4 手未出画） |
| 2 | `records/20261031-160544_verify_v7` | 16:05:44–16:08:47 | 0 | 0 | 14/20=0.700 | 0 | 0 | G2 |
| 3 | `records/20261031-161557_verify_v7` | 16:15:57–16:18:59 | 0 | 0 | 19/20=0.950 | 1 | 0 | G3a |
| 4 | `records/20261031-162341_verify_v7` | 16:23:41–16:26:43 | 0 | 0 | 15/20=0.750 | 0 | 0 | G2 |

三次有效运行的汇总：

| 项目 | 判据 | 实测（3 轮） | 结果 |
|---|---|---|---|
| G1 动作计数 | 单轮真值 20 次 | 每轮 20 个真值窗，3 轮共 60 次 | PASS |
| G2 A3 召回 | `TP≥17/20` 且 `recall≥0.85` | 14/20、19/20、15/20；累计 48/60=0.800 | FAIL（未稳定达标，最好一轮 19/20） |
| G3a A1/A4 | 两段均 0 条 class1/2 | A1 三轮全 0；A4 0/1/0（退场过渡） | FAIL（1 条） |
| G3b A2 | 0 条 | 三轮全 0（累计 180.4 s） | PASS |
| G3c 非 A3 误触率 | `<1.0` 次/分 | 0.000 / 0.427 / 0.000 次/分；3 轮合并 1 条/421.1 s=0.143 次/分 | PASS |
| class2 | 全轮 `=0` | 0 | PASS |
| `VERIFY_PASS` | 以上 gate 全过 | 3 轮均为 0 | FAIL |

| 阶段 | 3 轮累计时长（s） | false（class1/class2） | 真值次数 | TP |
|---|---:|---:|---:|---:|
| A1 双手离开 | 180.4 | 0 | — | — |
| A2 手静止 | 180.4 | 0 | — | — |
| A3 开合 | 120.2 | 0（无重复、无 class2） | 60 | 48 |
| A4 双手离开 | 60.3 | 1 | — | — |

口径说明：

- A3 漏检集中在每轮段首。第 2 轮首条在 A3 起后 4.5 s（125.72 s），第 4 轮首条在 123.70 s；逐轮漏检窗号见各轮 `acceptance.md` 的 A3 明细。三次有效运行的召回在 0.700–0.950 之间浮动，属执行节拍差异，本报告按实测区间记录，不外推。
- A4 的 1 条为退场过渡：第 3 轮 seq 194、相对 162.779 s、class1、conf 31、reason `valid_rise`，位于 A4 段起点（161.443 s）后 1.34 s；该时刻双手仍在画面内并快速移出，属真实运动而非凭空误报，但按判据计 false。
- guard 0.00 对照：第 2 轮 A4 另有 1 条落在 0.5 s 守卫带内（原始 1 条、剔除后 0 条），故零守卫口径下 G3a 亦为 FAIL。本节主口径沿用 0.5 s。
- 第 1 轮的 A4=6 与 A3=9/20 不作系统指标：抽帧确认 A3 结束后双手仍在画面内，A4 协议未执行；与第 3、4 轮 A4 全 0 的对照也说明这 6 条来自操作，不是位流行为。
- **协议口径偏离（2026-10-31 复核订正，须与上表同读）**：本轮一键脚本 v1.2.0 的阶段时长是 A1 60 / A2 60 / **A3 40** / A4 20 ≈ 182 s（`temp_test/accept/OPERATOR_GUIDE.md` 第 24 行同样写 40 秒，脚本与操作卡自洽），而 M5 v2 与其自定的协议权威 `temp_test/verify_v7.ps1` 规定的是 A1 60 / A2 60 / **A3 70** / A4 20 = 210 s（A3 的 160–190 s 为第 20 次之后的 30 s 静止保持段）。**未同步的是 M5 方案与 `verify_v7.ps1`，不是执行环节。** 因此：①A3 段「动作后不重复触发」的静止保持检验本轮**没有执行**，§7.3 中 A3 的「false≤1」只覆盖段内动作窗；②按 M5 §2.1 的 `durationOk = |durationMs − 210000| ≤ 2000` 判据，四轮时长均约 182 s，**没有一轮满足方案原文的「有效轮」定义**——本节所说「3 轮有效」指协议执行有效（第 1 轮 A4 段双手未出画），不等于满足 §2.1 的元数据有效性；③M5 的 5 轮 × 210 s 设计目标仍未执行。该偏离不改变任何 gate 的方向（G2 与 G3a 本就 FAIL），但本节不应被读作 M5 v2 的正式 5 轮验收结果。
- 统计区间（按 M5 §2.2 要求补报，复核计算）：三次有效运行合计 48/60 的 Wilson 95% 区间为 **[0.682, 0.882]**；单轮 14/20 [0.481, 0.855]、19/20 [0.764, 0.991]、15/20 [0.531, 0.888]。三档区间下限均低于 0.85 门限，与点估计的 FAIL 判定一致。

## 8. 局限与不可复现的部分

act7 位流未烧板；act8 位流已随 v7b 权重在 2026-10-31 02:02 烧板，并于同日完成 4 轮 A1~A4 上板验收（3 轮有效，A3 召回 0.70–0.95，G2 未稳定达标）（源：sim/nn/EVIDENCE_M3f.md:6；sim/nn/EVIDENCE_M3j.md:228-246；records/20261031-162341_verify_v7/acceptance.md）。当前板上运行的是 act8，act3c 的 v5 两分类实测属于历史数据（源：docs/06_facts/02_metric_register.md:16）。act3c 时代的 ACTION 计数只能证明 v5 引擎在跑，不能证明 v7 的 0.9412 开合召回（源：docs/06_facts/00_current_status.md:28）。

镜像侧全部是合成副本。C_mirror 的 d_open_max 为 0.0 只说明左右镜像后的输出一致，不说明真实右手数据的分布（源：results_v7_final.json:6375-6379）。不做镜像训练时开合召回降到 4/9 与 7/9，说明对称性不能替代真实样本（源：同上:6386-6393）。真实右手数据未采集，报告不把它写成已覆盖。

标注数据只覆盖单人、单桌面与固定机位。v7hands 在 157 至 162 s 转动摄像头，235 至 239 s 转回，两个转动段被排除（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:19）。视角 B 只作硬负样本，不能当作视角 A 的训练数据（源：同上）。多人、遮挡、不同光照与不同距离均未采集。

事件流本身不是动作真值。events.csv 记录的是传感器输出，标签来自人工分段，二者时间基准不同（源：docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:55）。v5 的 118 条脉冲按 ACTION 计数统计，计数器没有逐条时间戳，只能按段汇总（源：measure_v5_false_triggers_20261030.md:53）。因此报告给的是段级率，不是逐事件精度。

标注工具与长录网关已通过各自测试，但标注质量没有做双人一致性检验。annotator 的单测覆盖核心换算与 HTTP 契约，不覆盖人工标签正确性（源：docs/05_experiments/recording_and_labeling_20261030/evidence_anno.log）。标签边界误差按事件流复核的最大偏移记录，未做统计推断（源：nn/REPORT_v6_表征实验.md:118-124）。

静默数据只有 1.415 min，0 个事件在 95% 置信下只能把误触发上界约束到约 2.1 次/分（源：nn/REPORT_决策链标定.md:42）。要证明低于 0.5 次/分至少需要约 6 min 静默数据（源：同上）。v7 的空桌面证据只有 0.5167 min，更短（源：results_v7_final.json:4649）。v5 的 0 次静止与 0 次空桌面同样不能外推到更长时间。

int8 一致率最低 0.970775，未达 0.99，Q_int8.int8_decision.pass 为 false（源：results_v7_final.json:6405,6429）。端到端时延只有 4 个匹配样本，p50 85.612 ms、p95 97.555 ms，不能当作总体分布（源：docs/05_experiments/action_recognition_20261029/report.md:231）。v5 的 118 条脉冲来自一次 432 s 录制，也不能外推到其他光照与距离（源：measure_v5_false_triggers_20261030.md:67）。

未测量项还包括强光与弱光下的极性偏置、长录丢包与重传、不同镜头焦距下的坐标缩放。现有四段录制的 counters 均为 0 丢帧、0 丢事件，只覆盖当前光照与固定焦距（源：各会话 meta.json counters）。这些条件改变后，事件率、网格占用与决策链门限不能直接沿用（源：docs/03_tech/05_action_uplink_contract.md:462）。

未测量项还包括电源纹波与温度对时序的影响。act3c 的 WNS +0.306 ns、act7 的 +0.059 ns、act8 的 +0.215 ns 都是默认实现条件下的布线结果（源：build/variant_act3c/timing_deliver.rpt:131、sim/nn/EVIDENCE_M3f.md:15 与 build/variant_act8_final/timing.rpt:131）。act7 余量只有 0.059 ns，比 act3c 少 247 ps；act8 的 Explore 轮把余量拉回 0.215 ns（源：sim/nn/EVIDENCE_M3f.md:20 与 report/evidence/act8_artifacts.txt:7）。温度与电压角变化后余量会缩小，报告不给最坏角结论（源：docs/04_contest/05_report_outline_and_style.md:87）。

未测量项包括功耗、结温、长时间漂移、多人场景、真实右手样本与 v7 板上时延。这些项目在现有证据里没有数据，报告不给估计值（源：docs/06_facts/00_current_status.md:28）。v5 的 16.4 次/分与 v7b 的 2.6 次/分均只在各自测试集内成立，不能互换（源：measure_v5_false_triggers_20261030.md:67 与 docs/06_facts/03_v7b_deployment_decision.md:43）。v7 在 s100 下的硬负为 5 条，v7b 为 2 条，两者都来自 view B 素材（源：nn/REPORT_s100_部署口径复核.md:76 与 docs/06_facts/03_v7b_deployment_decision.md:22）。跨场景泛化尚未测量。

| 项目 | 现状 | 影响 | 数据来源 |
|---|---|---|---|
| v7/v7b 上板 | act8 已烧板并完成 4 轮 A1~A4（3 轮有效） | A3 召回 0.70–0.95（累计 48/60=0.80），A1/A2 零误触，A4 1 条；G2 未稳定达标；板上时延仍属未测量 | records/20261031-162341_verify_v7/acceptance.md；sim/nn/EVIDENCE_M3j.md:228-246 |
| act7 时序余量 | WNS +0.059 ns，比 act3c 少 247 ps | act8 若转负须回退或改版 | sim/nn/EVIDENCE_M3f.md:20；03_v7b_deployment_decision.md:50 |
| act8 时序余量 | WNS +0.215 ns，比 act7 高 0.156 ns | 仍只有 8 ns 周期的 2.69%，未做最坏角 | build/variant_act8_final/timing.rpt:131；report/evidence/act8_artifacts.txt:7 |
| 真实右手 | 只有镜像合成副本 | 左右对称门不能证明真实分布 | results_v7_final.json:6375-6393 |
| 静默时长 | 1.415 min，v7 空桌面 0.5167 min | 误触发上界只能到约 2.1 次/分 | nn/REPORT_决策链标定.md:42 |
| int8 一致率 | 最低 0.970775，pass=false | 未达 0.99 上板门槛 | results_v7_final.json:6405,6429 |
| 端到端时延 | 4 个匹配样本 | 不能给总体分布 | docs/05_experiments/action_recognition_20261029/report.md:231 |
| 功耗与结温 | 未测量 | 无长时间稳定性结论 | docs/06_facts/00_current_status.md:28 |

复现图表时运行 PYTHONUTF8=1 nn/.venv/Scripts/python.exe report 下 figures/make_figures.py，末行应为 FIGURES_OK=1（源：report 下 figures/make_figures.py）。数字校验运行 report 下 figures/verify_numbers.py，末行应为 NUMBERS_VERIFIED=1（源：report 下 figures/verify_numbers.py）。文风自查运行 report 下 figures/style_check.py，末行应为 STYLE_CHECK_OK=1（源：report 下 figures/style_check.py）。
