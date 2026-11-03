# act8 空场景被动基线（2026-10-31 02:00–02:20）

> 状态：**已完成的一次板上被动监测**，不是 M5 动作段验收，也不是 v7b 的完整误触发结论。
> 适用位流：`variant_act8_final`（v7b 两分类权重 + `NN_MARGIN_MIN=16` + `nn_winstat` 前端），2026-10-31 02:02 烧板。
> 证据等级：**实测**（板上录像 + 网关事件轮询）；效力范围见 §5。

## 1. 结论

act8（v7b 权重 + `NN_MARGIN_MIN=16`）在**无人、静态场景**下连续监测 1,206.5 s（20 min 06 s），`/api/action/events` 返回动作事件 **0 条**，即 **0.00 次/分**。按 0 事件 Poisson 单侧 95% 上界近似 `3/n`，该场景的误触发率上界约 **0.149 次/分**。

同一静态场景在监测结束后继续做连续 4 小时被动监测（2026-10-31 02:22 → 06:22，14,405.3 s（240.1 min，2,614 次分页轮询）），动作事件仍为 **0 条**，0 事件 95% 上界降到约 **0.0125 次/分**。两次观测合并后的结论是：该静态场景在 4 小时 05 分里没有产生一次动作事件。

这条基线的用途是关闭 v7b 风险接受中的“空场景误触发”一项，并给 A1/A2/A4 的“无人/静止段 0 次”提供部署前证据。它不能替代 A1~A4 动作段验收，也不能证明 view B 的打字/卷纸不误报。

## 2. 环境与口径

| 项 | 值 | 来源 |
|---|---|---|
| 位流 | `build/variant_act8_final/retina_event.bit` | 实测 |
| 位流大小 / 全文件 md5 | 2,839,107 B / `5ec55ec07c44f2503df63f1bb160a6e6` | 实测（`md5sum`） |
| 载荷 md5 | `dcbcf543210c33cb22625128bc5f6b97`（头 127 B，载荷 2,838,980 B） | 实测（D8-M12） |
| 烧板 | 2026-10-31 02:02，`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1` | 实测（烧写记录） |
| 录像会话 | `records/20261031-015936_act8_empty`，label=`act8_empty` | 实测 |
| 录像窗口 | 2026-10-31 01:59:36.058 → 02:19:42.923（+08:00），1206.865 s | 实测（`meta.json`） |
| 被动监测窗口 | 1206.5 s（20.1 min），223 次分页轮询 | 实测（`passive_act8_empty_summary.json`） |
| 观测口 | `GET /api/action/events?after=<seq>&limit=32`，起始锚点 `seq=143` | 实测 |

现场为同一静态场景：墙面、桌沿、白色瓶体、黑色底座；抽帧 4 张（chunk-000 第 5 s / 第 120 s、chunk-002 第 150 s、chunk-004 第 5 s）均无人体或手部入画。抽帧路径：`temp_test/lead/frames/a_t05.png`、`b_t120.png`、`c_t300.png`、`d_t1150.png`。

## 3. 方法

1. 先读 `GET /api/action` 的 `seq` 作为起始锚点（本次 143），只统计锚点之后的新事件；不能从 0 开始拉，否则会把网关 64 条事件环里的历史事件误算进本次窗口。
2. 每 400 ms 调 `GET /api/action/events?after=<lastSeq>&limit=32`，按 `seq` 去重，追加到 JSONL；同时记录 `dropped`。
3. 结束时补一次轮询，把窗口尾部未取走的事件取完；汇总写入 `passive_act8_empty_summary.json`。
4. 同一时间用网关内置录制记录原始事件与视频（`/rec/start` → 监测 → `/rec/stop`），用 `meta.json` 的 counters 检查丢帧/丢事件。

> 本次 `passive_act8_empty.jsonl` 为 0 字节，是因为窗口内**确实没有动作事件**；实际轮询次数、事件数、dropped 与 lastSeq 记录在 `passive_act8_empty_summary.json`，不是“日志丢失”。

## 4. 结果

### 4.1 动作事件

| 指标 | 值 |
|---|---:|
| 监测时长 | 1206.5 s |
| 分页轮询次数 | 223 |
| 动作事件数 | 0 |
| 点估计 | 0.00 次/分 |
| 0 事件 95% 单侧上界（Poisson 近似 `3/n`） | 0.149 次/分 |
| `dropped` | 0 |
| 起始锚点 / 结束 lastSeq | 143 / 143 |
| 错误 | 无 |

`lastSeq` 停在 143，说明窗口内没有新事件；`dropped=0` 说明事件环没有溢出丢页。同步采样的 `/api/action` 均为 `raw=0 / valid=false / class=0`，与空场景字节一致。

### 4.2 录像完整性

| 指标 | 值 |
|---|---:|
| frames | 32,163 |
| events | 19,750 |
| chunks | 5 |
| droppedFrames | 0 |
| droppedEvents | 0 |
| bytes | 24,701,184,000 |
| 视频文件 | 5 段，合计 67,467,822 B（约 67 MB） |
| 有效帧率（frames / 录像时长） | 约 26.65 fps |

录像计数器与 `meta.json` 一致，无丢帧、无丢事件；视频足够覆盖整个窗口，可用于人工复核“画面里确实没有人”。

## 5. 效力边界

1. **只覆盖无人静态场景**。v7b 已知风险“view B 打字/卷纸误报”需要有人在场才可测，本基线不能替代。
2. **不等同于 M5 A1/A2/A4**。A1/A2/A4 是协议段，要求操作员按节拍、按位置执行，并与 A3 动作段连续完成；本基线是连续空场景，没有 A3，也没有 A1~A4 的轮次结构。
3. **观测点在网关侧**。`/api/action/events` 读的是 byte23 解析后的 VALID/CLASS；板侧未留 ILA，无法独立证明“板端从未产生 pulse”。但 32,163 帧录像、223 次 API 轮询与 4 次抽帧三条证据一致。
4. **20 分钟样本只给上界**。0 事件不能证明真实误触发率恰好为 0；0.149 次/分是 95% 单侧上界的工程近似，不是无限时长的保证。
5. **4 小时长基线不在本文结论内**。02:22 起另外起跑的 4 小时被动监测未纳入本文；若后续引用，需单独写结果与有效性检查。
6. **风险接受状态不变**。空场景零误报只关闭一项风险；v7b 的 `V7B_MODEL_OK=0` 仍是 0，硬负 pulse 2 与 `d_wave=0.0196` 两项未达标不因本基线改判。

## 6. 复现

```bash
cd E:/workspace/FPGA_Comp
# 前置：act8 已烧板；网关在 127.0.0.1:8787；1234 只有一个网关持有
node temp_test/lead/passive_monitor.mjs --seconds 1200 --out temp_test/lead/passive_act8_empty.jsonl
```

- 监测前先确认 `GET /api/action` 可读，并记录其 `seq` 作为锚点；脚本会自动跳过历史。
- 监测期间不要开第二个网关，不要碰 1234/8787 上的用户链路。
- 需要同时留原始录像时，另起 `POST /rec/start` / `POST /rec/stop`，再用 `meta.json` 核对 counters。
- 结果文件：`temp_test/lead/passive_act8_empty_summary.json`；事件明细文件为空是正常结果（0 条事件）。

## 7. 相关文档

- v7b 部署裁决与风险接受：`docs/06_facts/03_v7b_deployment_decision.md`
- 参赛口径登记：`docs/06_facts/02_metric_register.md`（D8-M13）
- M5 上板验收方案 v2：`docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md`
- 设计报告：`report/design_report.md` §4.3.2
## 7 四小时连续监测（02:22 → 06:22）

| 项 | 值 |
|---|---|
| 命令 | `node temp_test/lead/passive_monitor.mjs --seconds 14400 --poll 500 --out temp_test/lead/passive_act8_overnight.jsonl` |
| 时长 / 轮询次数 | 14,405.3 s（240.1 min）/ 2,614 页 |
| 动作事件 | 0 条（`events=0`） |
| 分页丢事件提示 | `dropped_hint=0` |
| 起始锚点 | `seq=143`（与 §3 同法，跳过事件环历史） |
| 0 事件 95% 上界 | `3 / (14405.3/60) = 0.0125` 次/分 |

该次监测不录像，只读 `/api/action/events`；结束行写入 `temp_test/lead/passive_act8_overnight.jsonl` 的 `PASSIVE_SUMMARY`。两次观测（20.1 min 带录像 + 240.1 min 无录像）合计 241.2 min、0 事件，合并上界约 0.0124 次/分。

