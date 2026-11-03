# M5 上板验收方案 v2（v7b/act8 版，2026-10-31 回填）

> **状态：方案，act8 已烧板，M5 动作段验收未执行。** 本文定义“怎么判、判到什么数”，不是验收记录；执行后必须另存证据日志并回填。前置条件 P4（`nn/out_v7b/INT8_CONTRACT.md`）的文件已于 2026-10-31 02:27 生成（20,642 B，sha256 `abd04d90…`），§8 四条复算命令均指向真实脚本，按“契约正文 + 可复算命令”闭环；文件尚未入库，由 coder2 在 task-73/P2 后一并入库，不阻塞本方案；执行工具已于 2026-10-31 02:39 交付 `ACCEPT_FIX_OK=1`，并通过 41 项自检（`CHECK_SUMMARY=PASS PASS_COUNT=41 FAIL_COUNT=0`、`ACCEPT_SELFTEST=PASS`）；**待用户在板前执行 A1~A4**。本次计划只跑 1 轮快速验收（20 次动作），口径见 §0 与 §2.0。
>
> **适用位流**：`variant_act8_final`（v7b 二分类权重 + `nn_winstat` 平移归一化前端 + 7 路全局量 MLP + byte23 修复），2026-10-31 02:02 已烧板，2,839,107 B，全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97`（头 127 B，载荷 2,838,980 B）。ROM 为 v7b 5,652 words；参数与布局以 `nn/out_v7b/nn_params_v7b.json`、`rom_offsets.json` 为准。本方案可在 act8 上执行；P4 已闭环，执行工具已通过 41 项自检，待用户按 §3.3 执行。
>
> **不适用**：act3c（`build/variant_act3c/retina_event.bit`，md5 `a5fff751e20019d7e80a3a953f7f8c5a`）是 v5 两分类 + byte23，**不含** `nn_winstat` / 全局量 MLP；它是历史版本，拿它跑本方案会把“前端没上板”误判成“模型不行”。
>
> **协议权威**：阶段时长与 `/rec/start|stop` 行为以 `temp_test/verify_v7.ps1`（41 行，已存在）为准；本次一键执行以 `temp_test/accept/run_acceptance.ps1` 与 `temp_test/verify/analyze_acceptance.py` 为准，它实现了同一 A1→A4 顺序，并由分析器读取 zones 里的 `bin_ms`。本文只引用脚本行为，**不重写、不复制成另一份脚本**；任何阶段时长或节拍冲突以修复后的脚本为准。task-74 已交付：A3 提示为“每 2 秒 1 次，共 20 次”，`bin_ms` 改为运行时写入；自检覆盖 70 s 均匀 20 次 TP20 PASS、前 10 s 挤 20 次 TP3 FAIL 等五类 gate。
>
> 证据等级：阈值/协议来自任务书与 2026-10-29 M5 方案（**文档**）；v7b 二分类与 class 语义来自 `nn/out_v7b/INT8_CONTRACT.md` / `nn/out_v7b/nn_params_v7b.json`（**文档/代码证据**）；“act3c 不含 v7 前端、act8 含 v7b 前端”来自源码与位流比对（**实测/代码证据**）；**本次 1 轮动作段验收尚未执行**（**推断**，待证伪）。act8 空场景被动基线已另测（20.1 min 带录像 + 4 小时连续监测，均 0 事件，合并上界约 0.0124 次/分），见 `act8_empty_baseline_20261031.md`；空场景不能替代本方案的动作段验收。

---

## 0. 一页结论

- **设计目标**：5 轮 × 210 s，每轮四段：A1 双手离开 60 s → A2 手在画面静止 60 s → A3 开合 20 次 70 s → A4 离开 20 s；合计 100 次真值动作。
- **本次实测口径**：1 轮快速验收，20 次真值动作，约 210 s + 准备 10 s ≈ 3.6 min。本次只给单轮点估计与 Wilson 区间，**不宣称达到“100 次、5 轮”的设计目标**。
- 三门槛分两列：设计目标 / 本次口径，详见 §2.0。本次门槛 2 仍为单轮 TP≥17/20；门槛 3 的分母是 A1+A2+A4 的实测时长（约 140 s），不是 5 轮总时长。
- 每轮独立判定，**任一轮 FAIL 则整体 FAIL**，不允许用其它轮的高分补偿；只有“采集无效”（时长/丢帧/class2）可以重跑，性能 FAIL 不能靠重跑挑结果。
- 5 轮设计目标合计：`TP≥85`、`false≤5`、`false/min<1`（5/1050×60=0.286/min）；本次不套用这组合计值。
- 机读末行：单轮为 `VERIFY_PASS` / `VERIFY_FAIL_ITEMS`（`analyze_acceptance.py`），`VERIFY_PASS=1` 覆盖 G1/G2/G3a/G3b/G3c；设计目标 5 轮汇总为 `M5V7_RESULT=PASS|FAIL`，另有 `M5V7_ACTION_COUNT` / `M5V7_RECALL` / `M5V7_FALSE_PER_MIN`。
- **A3 跟脚本节拍做，每 2 秒 1 次，共 20 次**（约 40 s，70 s 段留 30 s 静止余量）。没有脚本节拍只能做功能冒烟，不能算正式验收，因为逐次真值起点无法确定。
- 单轮 20 次的统计功效有限：17/20 的 Wilson 95% 区间约 0.64–0.95，下限远低于 0.85；17/20 只是点估计达线，不能据此宣称总体召回 ≥0.85。

---

## 1. 前置条件（不满足不开始）

| # | 条件 | 检查命令/证据 | 不满足时 |
|---|---|---|---|
| P1 | 板上是 act8/v7b 构建，不是 act3c | 位流 md5 `5ec55ec0…` + `src/hdl/nn/nn_rom_data.v` 与 `nn/out_v7b/nn_rom_data_v7b.v` 一致（**5,652 words**，sha256 `4288488d…`） | 停止；换回 act8 或重构建，不得用 act3c |
| P2 | 源码含 `nn_winstat` 前端，且 `nn_top` 已例化 `u_ws` / `u_feat` | `grep -n "nn_winstat\|u_ws\|u_feat" src/rtl/nn/nn_top.v` | 停止；前端未接主链 |
| P3 | 源码含全局特征 + 全局量 MLP 的引擎分支 | `grep -n "glob\|g1\|feat8" src/rtl/nn/nn_engine.v src/rtl/nn/nn_top.v`；act8 的 ROM 含 `g1_w 4896/112`、`g1_b 5568/16`、`g1_sh 5634/16`（7 路全局量） | 停止；引擎未消费全局量，不能用 v7b 权重 |
| P4 | v7b INT8 契约已定稿 | `nn/out_v7b/INT8_CONTRACT.md`（20,642 B，sha256 `abd04d90…`）与 `golden_vectors.json` 存在；§8 四条复算命令指向 `build_v7b.py` / `gen_tb_golden_v7b.py` / `check_params_rom.py` / `quant_v7.py`；文件尚未入库，由 task-73/P2 处理 | 文件缺失，或 §8 命令指向不存在的脚本时停止；仅“未入库”不阻塞本方案 |
| P5 | 板卡网络正确 | PC 以太网静态 `192.168.1.102/24`；`ping 192.168.1.102` 本机通；板卡在推流 | 按 H80 修网卡；不得用 DHCP |
| P6 | 只有一个网关持有 1234 | `netstat -ano | findstr :1234` 只应有一个 PID；`curl -fsS http://127.0.0.1:8787/healthz` 返回 200 | 先停旧网关；**绝不允许两个进程同时 bind 1234** |
| P7 | 实时链路正常 | `/api/stats` 的 `pps` 在 15,000–17,000；`trail` 含 `udp OK` | 先排查板卡/网卡；不要开始录制 |
| P8 | 动作 API 是 v7 二分类 | `curl -fsS http://127.0.0.1:8787/api/action` 返回 `available:true`；classMap 只有 class0/class1；不出现 class2 | 停止；映射不对 |
| P9 | 磁盘与端口 | `records/` 剩余空间 ≥5 GB；8787 可访问；1234 被唯一网关持有 | 清理/停其它程序 |
| P10 | 场景与 v7 采集一致 | 同一摄像头视角（view A）、同一桌面/白杯位置、800×480 全画面；操作员手部无遮挡 | 停止；换场景等于换域 |
| P11 | 验收工具已修复 | `ACCEPT_FIX_OK=1`（2026-10-31 02:39）；`--selfcheck` 输出 `CHECK_SUMMARY=PASS PASS_COUNT=41 FAIL_COUNT=0` 与 `ACCEPT_SELFTEST=PASS`；A3 提示为每 2 秒 1 次、`bin_ms` 由运行时写入 | 停止并回报 Lead；自检未过时执行会按错误口径切窗，TP 不可信 |

> v7 是**二分类**：class0 = 无动作/静止，class1 = 手部开合。挥手在部署契约里折进 class0 硬负（`nn/v7/gen_golden.py:61` 注“挥手窗（y=2，部署折 class0 硬负）”）。因此本方案**不测 class2**；一旦出现 class2，直接判该轮 FAIL（映射/权重不对）。

---

## 2. 三门槛的可执行定义

### 2.0 设计目标与本次实测口径

| 门槛 | 设计目标（5 轮） | 本次实测口径（1 轮） | 本次是否宣称达标 |
|---|---|---|---|
| 1 动作计数 | 100 次（5×20） | 20 次 | **否**；达 100 次需 5 轮 |
| 2 单轮召回 | 每轮 ≥0.85，即 TP≥17/20；5 轮合计 TP≥85/100 | 单轮 TP≥17/20，并给 Wilson 95% 区间 | 仅单轮点估计，不宣称总体 ≥0.85 |
| 3 误触发 | 总 false≤5、false/min<1（5 轮合计） | G3a A1/A4=0、G3b A2=0、G3c A1+A2+A4<1/min；A3 段外脉冲只展示 | 仅单轮 gate；样本短、功效有限，A3 脉冲不改判 |

> 本次执行 1 轮的理由：A3 的 20 次开合已经能给出召回点估计与区间；100 次需要 5 轮约 18 min，安排在时间允许时追加。单轮 20 次的区间很宽，17/20 的 Wilson 95% 区间约 0.64–0.95，不能把“点估计达线”写成“总体召回达线”。

### 2.1 门槛 1：动作计数（设计目标 ≥100；本次 20）

- 真值动作数（设计目标）= 5 轮 × 每轮 20 次开合 = **100**；本次只跑 1 轮，真值动作数 = **20**，不宣称达到 100。
- `actionCount` 是**真值数**，不是检测数；检测数另记 `TP`。
- 只有“有效轮”才计入 100：单轮 `meta` 时长 210±2 s、`counters.droppedFrames=0`、`counters.droppedEvents=0`、无 class2。无效轮整轮作废重跑，**不补 partial**。
- 性能 FAIL 的轮不能重跑充数；5 轮必须连续按协议完成（轮间可休息 60 s，但不得换场景/换人）。

### 2.2 门槛 2：真动作召回（设计目标 ≥0.85；本次单轮 TP≥17/20）

- 每轮 20 个真值窗，第 k 次开合的真值起点由脚本写入 zones 的 A3 `bin_ms` 推出：

  `t_k = T0 + 120000 + bin_ms*k`（ms，k=0..19），判定窗 `W_k = [t_k, t_k + bin_ms)`。

- `bin_ms` 由 `run_acceptance.ps1` 运行时按 `round(actual_s*1000/truth)` 写入 `verify_v7_zones.json`，**不再硬编码 1500**；`analyze_acceptance.py` 读该值切窗。本次脚本节拍为每 2 秒 1 次、20 次占 A3 前 40 s，因此 `bin_ms` 约 2000；最终以 zones 文件的实际值为准。
- `T0 = records/<session>/meta.json` 的 `startedAt`（ISO UTC，`Date.parse` 后为 epoch ms）。
- **TP**：`W_k` 内**第一条** `class=1` 事件；每个 `W_k` 最多记 1 个 TP。
- **FN**：`W_k` 内没有 `class=1` 事件。
- **重复触发**：同一个 `W_k` 内第 2 条及以后的 `class=1` 事件 → 记 false（不改变 TP）。
- **class2**：任何阶段出现都记 false，且该轮直接 FAIL。
- **class0**：`class=0` 是“有效但无动作”，**不计误触发**，也不计 TP；只用于排查。
- 单轮 `recall = TP / 20`，要求 `TP ≥ max(16, ceil(0.85*20)) = 17`。总召回 `totalTP / 100 ≥ 0.85`（`totalTP ≥ 85`）。
- 本次只执行 1 轮，判定 `TP ≥ 17`；同时报 Wilson 95% 区间（17/20 约 0.64–0.95，16/20 约 0.58–0.92），用区间说明 20 次样本的不确定性，不用点估计替代总体结论。

### 2.3 门槛 3：误触发 gate（G3a/G3b/G3c）

- **误触发**：`class=1` 或 `class=2` 事件落在任何 `W_k` 之外。A1/A2/A4 中任何 `class=1/2` 都算 false；A3 的 160–190 s 静止段（第 20 次结束后）与 `W_k` 内的重复触发也逐条记录，但按 2026-10-31 Lead 裁决只作观察项，不参与 `VERIFY_PASS`。
- 单轮误触发率 = `falseCount * 60000 / durationMs`。**本次口径**的分母取 A1+A2+A4 的实测时长（约 140,000 ms，A3 的 70 s 不计入），1 条事件即 0.43 次/分。
- 判定按 Lead 2026-10-31 裁决拆成三条 gate，由 `analyze_acceptance.py` 一次判定：
  - **G3a**：A1 与 A4 的 false 均 **= 0**；
  - **G3b**：A2 的 false **= 0**（比 `<=1.0/min` 更严，60 s 内 1 条也 FAIL）；
  - **G3c**：非 A3 区段（A1+A2+A4）总误触发率 `< 1.0 次/分`，验收报告同时打印分子与分母；
  - A3 段落窗外脉冲、A3 窗内重复触发、class2 均逐条列在 `acceptance.md`，其中 class2 另由类别 gate 直接 FAIL；A3 脉冲不单独 gate。
- 设计目标 5 轮的汇总仍要求 `totalFalse ≤5`、`totalFalsePerMin <1`；本次单轮不套用合计值。若 A2 出现 1 条脉冲而 G3c 通过，仍按 G3b 判 `VERIFY_PASS=0`，并把该条单列为“B1 风险（view A 手静止误报）”，不放宽 gate。

### 2.4 判定公式（设计目标 5 轮 / 本次单轮）

```
oneRoundPass = durationOk && droppedOk && class2 == 0
               && G3a && G3b && G3c && TP >= 17

G3a = falseA1 == 0 && falseA4 == 0
G3b = falseA2 == 0
G3c = nonA3False * 60000 / (durationA1 + durationA2 + durationA4) < 1.0
durationOk = |durationMs - 210000| <= 2000
droppedOk  = droppedFrames == 0 && droppedEvents == 0
roundPass  = oneRoundPass  // 设计目标追加轮次时沿用同一定义
finalPass  = all(roundPass for r1..r5)
             && actionCount == 100 && totalTP >= 85
             && totalFalse <= 5 && totalFalsePerMin < 1
```

> 本次只判 `oneRoundPass`（1 轮 20 次），不计算 `finalPass`；`finalPass` 保留给追加到 5 轮后的 Lead 汇总。单轮与 5 轮的逐轮判定现在使用同一套 G1/G2/G3a/G3b/G3c；差别只在“1 轮 20 次”与“5 轮 100 次”的汇总。

> 注意：这与 2026-10-29 旧 M5 的 `accuracy = correct/(truth+false)` 不是同一个指标；v2 按任务书拆成“召回”和“误触发率”，不要拿旧 `M5_ACCURACY` 直接比较。

---

## 3. 四段实测协议（每轮 210 s）

### 3.1 阶段表（与 `temp_test/verify_v7.ps1` 的 `$phases` 一致）

| 阶段 | 相对 T0 | 时长 | 操作员动作 | 期望动作事件 | 机读判据（硬） |
|---|---:|---:|---|---|---|
| A1 | 0–60 s | 60 s | **双手离开画面**，桌面/杯子不要动；可自然站立 | **0 条 class1/class2** | `falseA1 == 0`；≥1 即 FAIL |
| A2 | 60–120 s | 60 s | 手放进画面（与 A3 同一起始位置）**保持静止**，不刻意比划 | **0 条 class1/class2** | `falseA2 == 0`；≥1 即 FAIL |
| A3 | 120–190 s | 70 s | 跟脚本节拍做 **20 次张开-握拳**，每 2 秒 1 次（前 40 s）；第 20 次后双手保持静止在画面内，直到 A4 开始 | **TP 17–20 条**；false ≤1 | `TP>=17 && falseA3<=1`；class2 直接 FAIL |
| A4 | 190–210 s | 20 s | **双手离开画面**，保持到脚本提示结束 | **0 条 class1/class2** | `falseA4 == 0`；≥1 即 FAIL |

- A3 的 20 次动作只占 120–160 s；**160–190 s 是静止保持段**，不是“可以随便动”。这段的任何动作都算 false（且会破坏“动作后不重复触发”的检验）。
- A1/A4 不是“手不动”，而是**手离开画面**；A2 才是“手在画面但静止”。三者不能合并。
- 每段开始 1 声、结束 2 声，具体以脚本屏幕提示为准；操作员以屏幕/提示音为准，不自行读秒。
- 轮间至少休息 60 s，保持摄像头/桌面/杯子位置不变；换人/换椅子高度需重新做 5 轮。

### 3.2 A3 节拍（正式验收的硬要求）

- 节拍由 `run_acceptance.ps1` 在 A3 段播放：每 2 秒 1 声，共 20 声；第 k 声（k=0..19）对应第 k 次开合。20 次占 120–160 s，160–190 s 留 30 s 静止保持。
- 每次动作窗 2 s：听到第 k 声开始张开，在下一次节拍前完成握拳/复位。2 s 大于板上 1.5 s 不应期，正常情况下每次动作能形成独立上升沿。
- 真值窗由脚本写入 zones 的 `bin_ms` 与 `T0` 推算，**不由操作员按键标注**。脚本启动录制、进入 A3 与节拍共用同一时钟；若操作员错过第 0 声，本轮作废重跑，不要“从中间补”。
- 操作员不需要另设手机节拍器。没有脚本节拍时，只能数 A3 总检测数做冒烟，**不能**计算逐次 TP/召回，不能作为 M5 验收。

### 3.3 单轮流程（操作员卡片）

1. 确认 §1 的 P1–P11 全过；工具已通过 41 项自检，按本节流程执行。操作员不需要另设节拍器。
2. 在仓库根 `E:/workspace/FPGA_Comp` 执行：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File temp_test/accept/run_acceptance.ps1 -Label verify_v7_r1
   ```

3. 按屏幕提示开始 A1：双手离开画面 60 s。
4. 60 s 后进入 A2：手放进画面，静止 60 s。
5. 120 s 进入 A3：**跟脚本节拍，每 2 秒做 1 次开合，共 20 次**；第 20 次后手保持静止，直到 190 s。
6. 190 s 进入 A4：手离开画面 20 s；按屏幕提示结束，不自行读秒。
7. 脚本自动 `POST /rec/stop`、拉取事件并调用 `analyze_acceptance.py`；产物在 `records/<session>/` 下的 `acceptance.md`、`acceptance.json`、`action_events.json`、`verify_v7_zones.json`。
8. 检查 `records/<session>/meta.json` 的 `counters.droppedFrames/droppedEvents` 均为 0，`acceptance.md` 含 `VERIFY_PASS=1` 或明确的失败项；否则本轮无效或 FAIL，按脚本输出处理。
9. 本次只跑 1 轮（20 次真值），不宣称达到设计目标 100 次。追加轮次时再跑一次脚本并换 `-Label verify_v7_r2`，由 Lead 汇总；不改脚本、不合并轮次挑结果。

> `verify_v7.ps1` 的 `$began = Get-Date` 在 `POST /rec/start` **返回之后**；而 `recorder.start()` 先取 `started=this.now()` 再 mkdir/writeMeta，所以 `meta.startedAt` 比 `$began` 早一个 POST 往返（实测/代码推断 <0.1 s）。本方案一律用 `meta.startedAt` 作为 T0，不用 `$began`；两者差异 <0.1 s，相对于 2 s 窗可忽略，但必须在证据里记录该假设。

---

## 4. 事件拉取（可直接复制运行）

### 4.1 为什么必须每轮拉一次

- 网关动作事件环容量 **64 条**，单页最多 **32 条**；设计目标 5 轮约 100+ 条，本次 1 轮约 20 条。无论 1 轮还是 5 轮，都必须每轮结束立即拉，晚拉会被环覆盖。
- 返回里 `dropped>0` 表示环溢出；**该轮判失败并重跑**，不要用缺失数据算指标。
- 事件只在 `VALID 0→1` 或类别变化时产生；`VALID` 保持 1 且同类不会重复产生事件。板上 `ACT_IDLE_CYC=50_000_000` 拍（50 MHz） = **1.0 s** 无新判定才清零，所以 2 s/次的节奏能保证每次动作各有一个上升沿。

### 4.2 初始化（只做一次，丢弃旧事件）

```bash
export API=http://127.0.0.1:8787
export OUT="$TEMP/m5_v7"
mkdir -p "$OUT"
curl -fsS "$API/healthz" >/dev/null && echo HEALTHZ_OK

# 只取 lastSeq 当游标，不把旧事件写进 events.jsonl
node --input-type=module - "$OUT/cursor.txt" <<'NODE'
import fs from 'node:fs';
const f = process.argv[2];
const r = await fetch('http://127.0.0.1:8787/api/action/events?after=-1&timeoutMs=0');
if (!r.ok) { console.error('HTTP_' + r.status); process.exit(5); }
const j = await r.json();
if (j.dropped > 0) { console.error('DROPPED_ON_INIT=' + j.dropped); process.exit(4); }
fs.writeFileSync(f, String(j.lastSeq));
console.log('CURSOR_INIT=' + j.lastSeq);
NODE
```

### 4.3 拉取脚本 `pull.mjs`（写一次）

```bash
cat > "$OUT/pull.mjs" <<'NODE'
import fs from 'node:fs';
const [api, cursorFile, outFile] = process.argv.slice(2);
if (!api || !cursorFile || !outFile) {
  console.error('usage: node pull.mjs <apiBase> <cursorFile> <outFile>');
  process.exit(2);
}
let after = Number(fs.readFileSync(cursorFile, 'utf8').trim());
for (let guard = 0; guard < 256; guard++) {
  const u = new URL('/api/action/events', api);
  u.searchParams.set('after', String(after));
  u.searchParams.set('timeoutMs', '0');
  const r = await fetch(u);
  if (r.status === 503) { console.error('ACTION_API_503'); process.exit(3); }
  if (!r.ok) { console.error('HTTP_' + r.status); process.exit(5); }
  const j = await r.json();
  if (j.dropped > 0) { console.error('ACTION_EVENTS_DROPPED=' + j.dropped); process.exit(4); }
  if (j.events && j.events.length > 0) {
    fs.appendFileSync(outFile, j.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    after = j.lastSeq;
    if (j.events.length < 32) continue;
  }
  if (!j.events || j.events.length === 0) break;
}
fs.writeFileSync(cursorFile, String(after));
console.log('CURSOR=' + after);
NODE
```

### 4.4 每轮结束后立即执行

```bash
node "$OUT/pull.mjs" "$API" "$OUT/cursor.txt" "$OUT/events.jsonl"
```

- 正常输出 `CURSOR=<lastSeq>`；若 `ACTION_EVENTS_DROPPED>0` / `HTTP_503`，该轮无效。
- `events.jsonl` 只追加，不覆盖；分析脚本按 `seq` 去重。
- 不要用 `after=-1` 做每轮拉取（它只返回最新 1 条，会漏事件）；`after=-1` 只用于 §4.2 初始化游标。

---

## 5. 设计目标 5 轮的手工汇总路径（本次不用）

> 本次 1 轮验收由 `run_acceptance.ps1` 调 `analyze_acceptance.py` 生成 `acceptance.md` / `acceptance.json`，判决以其中 `VERIFY_PASS` / `VERIFY_FAIL_ITEMS` 为准。本节 `analyze.mjs` 是早期 5 轮手工汇总脚本，未读取 `zones` 的 `bin_ms`，**不能用于本次判定**；保留它只用于说明 5 轮汇总字段。它也没有门槛 3 的完整拦截（见 §5.4），不要把它当成通过依据。

### 5.1 分析脚本 `analyze.mjs`（仅设计目标手工路径）

```bash
cat > "$OUT/analyze.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const recordRoot = process.argv[2] ?? 'records';
const eventsFile = process.argv[3] ?? path.join(process.env.TEMP ?? '.', 'm5_v7', 'events.jsonl');
const ROUNDS = 5, SECONDS = 210, A3_START_S = 120, A3_BIN_MS = 2000, TRUTH_PER_ROUND = 20; // 仅示形状；正式以 analyze_acceptance.py 读 zones.bin_ms 为准
const rawEvents = fs.existsSync(eventsFile)
  ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s))
  : [];
const bySeq = new Map();
for (const e of rawEvents) bySeq.set(e.seq, e);
const events = [...bySeq.values()];

const rounds = [];
for (const name of fs.readdirSync(recordRoot)) {
  const m = /_verify_v7_r(\d+)$/.exec(name);
  if (!m) continue;
  const metaPath = path.join(recordRoot, name, 'meta.json');
  if (!fs.existsSync(metaPath)) continue;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const t0 = Date.parse(meta.startedAt);
  const t1 = meta.endedAt ? Date.parse(meta.endedAt) : NaN;
  rounds.push({ r: Number(m[1]), name, meta, t0, t1 });
}
rounds.sort((a, b) => a.r - b.r);
if (rounds.length !== ROUNDS) {
  console.error('ROUNDS_FOUND=' + rounds.length + ' (need ' + ROUNDS + ')');
  process.exit(2);
}

let totalTp = 0, totalFalse = 0, totalDurationMs = 0, allPass = true;
const lines = [];
for (const rd of rounds) {
  const durationMs = Number.isFinite(rd.t1) ? rd.t1 - rd.t0 : NaN;
  const evs = events
    .filter((e) => e.tMs >= rd.t0 && e.tMs < rd.t0 + SECONDS * 1000)
    .sort((a, b) => a.tMs - b.tMs);
  const hit = new Array(TRUTH_PER_ROUND).fill(null);
  const falseEvents = [];
  const phaseFalse = { A1: 0, A2: 0, A3: 0, A4: 0 };
  let class2 = 0;
  for (const e of evs) {
    const rel = e.tMs - rd.t0;
    const ph = rel < 60000 ? 'A1' : rel < 120000 ? 'A2' : rel < 190000 ? 'A3' : 'A4';
    if (e.class === 2) {
      class2 += 1;
      falseEvents.push({ ...e, phase: ph });
      phaseFalse[ph] += 1;
      continue;
    }
    if (e.class !== 1) continue; // class0（有效但无动作）不算误触发
    if (ph === 'A3') {
      const relA3 = rel - A3_START_S * 1000;
      const k = Math.floor(relA3 / A3_BIN_MS);
      const inBin = relA3 >= 0 && k >= 0 && k < TRUTH_PER_ROUND && relA3 < (k + 1) * A3_BIN_MS;
      if (inBin && hit[k] === null) {
        hit[k] = e;
        continue;
      }
    }
    falseEvents.push({ ...e, phase: ph });
    phaseFalse[ph] += 1;
  }
  const tp = hit.filter(Boolean).length;
  const fn = TRUTH_PER_ROUND - tp;
  const falseCount = falseEvents.length;
  const recall = tp / TRUTH_PER_ROUND;
  const falsePerMin = falseCount * 60000 / durationMs;
  const durationOk = Number.isFinite(durationMs) && Math.abs(durationMs - SECONDS * 1000) <= 2000;
  const counters = rd.meta.counters ?? {};
  const droppedOk = (counters.droppedFrames ?? 0) === 0 && (counters.droppedEvents ?? 0) === 0;
  const roundPass = durationOk && droppedOk && class2 === 0 &&
    phaseFalse.A1 === 0 && phaseFalse.A2 === 0 && phaseFalse.A4 === 0 &&
    phaseFalse.A3 <= 1 && tp >= 17;
  if (!roundPass) allPass = false;
  totalTp += tp;
  totalFalse += falseCount;
  totalDurationMs += durationMs;
  lines.push(
    'ROUND r' + rd.r + ' session=' + rd.name +
    ' duration=' + (durationMs / 1000).toFixed(1) + 's' +
    ' dropped=' + (counters.droppedFrames ?? '?') + '/' + (counters.droppedEvents ?? '?') +
    ' | A1 false=' + phaseFalse.A1 + ' A2 false=' + phaseFalse.A2 +
    ' A3 TP=' + tp + ' FN=' + fn + ' false=' + phaseFalse.A3 +
    ' A4 false=' + phaseFalse.A4 +
    ' | recall=' + recall.toFixed(3) + ' false/min=' + falsePerMin.toFixed(3) +
    (class2 ? ' CLASS2=' + class2 : '') + ' => ' + (roundPass ? 'PASS' : 'FAIL')
  );
}

const totalRecall = totalTp / (ROUNDS * TRUTH_PER_ROUND);
const totalFalsePerMin = totalFalse * 60000 / totalDurationMs;
const actionCount = ROUNDS * TRUTH_PER_ROUND;
const finalPass = allPass && totalTp >= 85 && totalFalsePerMin < 1;
lines.push('');
lines.push('TOTAL actionCount=' + actionCount + ' TP=' + totalTp +
  ' recall=' + totalRecall.toFixed(3) + ' false=' + totalFalse +
  ' false/min=' + totalFalsePerMin.toFixed(3));
lines.push('M5V7_ACTION_COUNT=' + actionCount);
lines.push('M5V7_RECALL=' + totalRecall.toFixed(4));
lines.push('M5V7_FALSE_PER_MIN=' + totalFalsePerMin.toFixed(4));
lines.push('M5V7_RESULT=' + (finalPass ? 'PASS' : 'FAIL'));
console.log(lines.join('\n'));
process.exit(finalPass ? 0 : 1);
NODE
```

### 5.2 运行

```bash
cd E:/workspace/FPGA_Comp
node "$OUT/analyze.mjs" records "$OUT/events.jsonl" | tee "$OUT/analyze.log"
echo EXIT=$?
```

正常输出示例（合成 PASS 数据，仅示形状，不是实测）：

```
ROUND r1 ... A1 false=0 A2 false=0 A3 TP=20 FN=0 false=0 A4 false=0 | recall=1.000 false/min=0.000 => PASS
...
TOTAL actionCount=100 TP=100 recall=1.000 false=0 false/min=0.000
M5V7_ACTION_COUNT=100
M5V7_RECALL=1.0000
M5V7_FALSE_PER_MIN=0.0000
M5V7_RESULT=PASS
```

- `EXIT=0` 仅表示该手工脚本的 `finalPass=true`；`EXIT=1` 为 FAIL；`EXIT=2` 为“找不到 5 个 `_verify_v7_rN` 录制目录”。
- 如果输出 `ROUNDS_FOUND=4`：检查第 5 轮 `-Label` 是否拼错，或录制是否失败；不要手改脚本凑 5。
- 本节脚本不读 `zones.bin_ms`，也没有门槛 3 的 A2/A3/总计拦截；即使 `M5V7_RESULT=PASS`，也只能当参考，不能当 M5 结论。

### 5.3 结果口径

| 机读字段 | 含义 | 通过条件 |
|---|---|---|
| `M5V7_ACTION_COUNT` | 真值动作数（5×20） | `==100` |
| `M5V7_RECALL` | `totalTP/100` | `>=0.8500` |
| `M5V7_FALSE_PER_MIN` | `totalFalse*60000/总时长` | `<1.0000` |
| `M5V7_RESULT` | 逐轮 + 总计 | `PASS` |

> 逐轮 `TP≥17` 已隐含总 `TP≥85`；总检查仍显式列出，防止脚本被改坏后只看总数。上表是设计目标 5 轮手工路径的字段，不是本次单轮字段。

### 5.4 本次单轮产物与 gate 覆盖

- 本次以 `records/<session>/acceptance.md` 与 `acceptance.json` 为准：`acceptance.json` 的 `verify_pass`、`gates.primary.roles.A1/A2/A3/A4`、`gates.primary.failures` 是机读结果；`acceptance.md` 首部含 `VERIFY_PASS=1` 或 `VERIFY_FAIL_ITEMS`。
- **`VERIFY_PASS` 覆盖哪几条门槛**：当前分析器覆盖 G1（动作计数/录制有效性）、G2（A3 召回与 TP）、G3a（A1/A4 false=0）、G3b（A2 false=0）、G3c（A1+A2+A4 总误触发率 <1.0/min）；五条全为 1 才是 `VERIFY_PASS=1`。门槛 3 由 G3a/G3b/G3c 三条合成，不再需要验收人手工重算。
- A3 段落窗外脉冲、窗内重复触发只在 `acceptance.md` 展示，不 gate；class2 由类别 gate 直接 FAIL。若真实验收出现 A2 1 条脉冲、G3c 仍通过，按 G3b 报 `VERIFY_PASS=0`，并单列“B1 风险（view A 手静止误报）”，不放宽 gate。
- 当前 `analyze_acceptance.py` 已覆盖五条 gate，`--selfcheck` 的 41 项全部通过（含 A2 一脉冲 G3b FAIL、2 条 140 s 0.855 PASS 等正反例）；不再需要手工重算 gate。

---

## 6. 证据留存与判定

### 6.1 每轮必须保存

- `records/<session>/meta.json`（T0/时长/counters/chunks）；
- `records/<session>/frames.csv` / `events.csv`（录制原始数据；至少保留 meta 和事件 CSV）；
- `records/<session>/acceptance.md` / `acceptance.json` / `action_events.json` / `verify_v7_zones.json`（一键脚本四件套）；
- `$OUT/events.jsonl`（动作事件，按 seq 去重前；手工路径保留）；
- `run_acceptance.ps1` 的控制台转录（阶段提示、节拍、`/rec/start|stop` 返回）；
- `acceptance.md` 的 gate 明细（G1/G2/G3a/G3b/G3c）与 A3 观察项（段外脉冲/窗内重复）；
- act8 位流路径 + md5 + 构建日志摘要（写进验收记录）。

### 6.2 判定顺序

1. 先查 P1–P11；任一不满足，**不开始**；工具已通过 41 项自检，可按流程执行。
2. 每轮结束查 `meta` 有效性和 `dropped`；无效轮重跑，不计数。
3. 本次 1 轮：读 `acceptance.md` 的 `VERIFY_PASS` / `VERIFY_FAIL_ITEMS`；五条 gate（G1/G2/G3a/G3b/G3c）已全覆盖，`VERIFY_PASS=1` 即本轮 PASS，不需要再手工重算。
4. 设计目标 5 轮追加后，才使用 `analyze.mjs` 的 `M5V7_*` 汇总；逐轮仍以 `acceptance.md` 的 `VERIFY_PASS` 为准。
5. `PASS` 才能写“M5 通过”；`FAIL` 必须按 §6.3 归类，不得只写“效果不好”。

### 6.3 FAIL 归因（至少写一条）

| 代号 | 现象 | 优先排查 |
|---|---|---|
| V7-F1 | `/api/action` 404 / `available:false` | 位流没接 `nn_top` / 网关没收到 v3 帧 |
| V7-F2 | 全程 0 事件 | byte23 VALID 位、act_state_cdc、`/api/action` 映射 |
| V7-F3 | A1/A2/A4 有事件 | 背景运动/自动曝光/人像在画面内；先看事件坐标 |
| V7-F4 | A3 TP<17 但 FN 均匀 | 节拍错拍/T0 偏移；先核对第 k 声与 `t_k`、`zones.bin_ms` |
| V7-F5 | A3 TP<17 且集中在后段 | 手疲劳/幅度变小；换人重跑，不调阈值 |
| V7-F6 | A3 重复触发多 | 1.0 s 空窗/不应期；板上 `ACT_IDLE_CYC` 与契约 |
| V7-F7 | class2 出现 | v7 权重不是二分类/映射表错；停止验收 |
| V7-F8 | 录制丢帧/丢事件 | USB/磁盘/CPU；该轮作废，先修采集 |
| V7-F9 | 事件环 `dropped>0` | 拉取太晚；改为每轮拉，环 64 条 |
| V7-F10 | 单轮时长不是 210 s | 脚本被改/手动停录；恢复 `run_acceptance.ps1` 原版，重跑 |

---

## 7. 与 2026-10-29 旧 M5 方案的差异

| 项 | 旧 M5（2026-10-29） | v2（本文） |
|---|---|---|
| 模型 | v5 两分类/三分类讨论，class2 实验性 | v7 **二分类**；wave 折 class0 硬负；class2 出现即 FAIL |
| 动作数 | 建议 120 次（40/40/40 或 20/20） | 设计目标 **100 次**（5×20）；本次 **20 次**（1 轮），不宣称 100 |
| 统计 | `accuracy=correct/(truth+false)` | **逐轮 recall + 三门槛 gate**，不用旧 accuracy |
| A3 真值 | 操作员按 1/2 确认，3 s 真值窗 | **脚本每 2 秒 1 声、20 次铺 40 s；`zones.bin_ms` 由运行时写入并读取**，不靠人工按键 |
| 门槛 3 | false 总数/率，无分段落 gate | **G3a A1/A4=0、G3b A2=0、G3c A1+A2+A4 <1/min**；A3 段外脉冲只展示 |
| 轮次 | 单场长测 | 本次 **1 轮 210 s**；设计目标 **5 轮独立 210 s**，任一轮 FAIL 即整体 FAIL |
| 事件拉取 | 旧 action_eval 工具 | `/api/action/events` + `pull.mjs`，每轮拉、环 64 条 |
| 当前可跑性 | 旧方案也依赖 M5 位流 | **act8 已烧板；P4 已闭环；工具已通过 41 项自检，待用户执行 A1~A4** |

---

## 8. 风险与证据边界

1. **必须用 act8/v7b**：act8 已烧板（md5 `5ec55ec0…`，ROM 5,652 words，含 `nn_winstat`/全局量 MLP）；act3c（`a5fff751…`，v5 5,476 words）不含前端，误用会把“前端未上板”判成“v7 不行”。
2. **P4 已闭环、文件待入库**：`nn/out_v7b/INT8_CONTRACT.md` 已生成（2026-10-31 02:27，20,642 B，sha256 `abd04d90…`），§8 四条复算命令均指向真实脚本，按“契约正文 + 可复算命令”结案；文件尚未入库，由 task-73/P2 处理。离线 `in_sample_int8_agree` 不是上板精度；正式验收仍看本方案 gate。
3. **挥手未纳入本协议**：v7 把 wave 折 class0 硬负；本方案只测“开合”，不能宣称“挥手不误触发”。挥手需要单独的负样本段（建议后续加 A5，不与本 5 轮混算）。
4. **脚本节拍是自动环节，操作员仍可能错拍**：漏掉第 0 声、跟错半拍会让 TP 偏低；证据里必须记录工具自检结果、节拍是否按屏幕提示完成，不能事后猜。
5. **T0 偏差**：`meta.startedAt` 与脚本 `$began` 差一个 POST 往返（代码推断 <0.1 s）；2 s 窗下可接受，但若网关/面板卡顿 >0.1 s，本轮作废。
6. **事件环 64 条**：5 轮共 100+ 事件；必须每轮拉。若操作员连续跑完 5 轮才拉，早期事件被覆盖，`dropped>0` 判失败（这是设计约束，不是模型问题）。
7. **端口纪律**：验收使用用户面板 8787 + 板卡 1234；同一时刻只能有一个网关 bind 1234（Windows UDP `reuseAddr` 先绑定者独占收包）。开始前 `netstat` 确认；结束后不要留第二个网关。
8. **本方案未执行**：§0 的“1 轮/20 次”是本次口径，“5 轮/100 次”是设计目标，均不是实测结果；所有“通过条件”待用户在板前执行 A1~A4；工具已就绪，P4 已闭环。证据等级：**推断（待证伪）**。
9. **A2 严格 gate 的后果**：A2 只要出现 1 条脉冲，G3b 即 FAIL、`VERIFY_PASS=0`，即使 G3c 通过也不改判；该条单列为“B1 风险（view A 手静止误报）”，按实际结果记录。

---

## 9. 附：执行记录模板（复制到新文件后填写）

```text
M5 v2 执行记录
日期/操作员：
位流路径 / md5 / 构建日志：
v7 ROM words / md5：
契约 INT8_CONTRACT.md / golden_vectors.json：
P1..P10 检查结果：
本次轮次=1 / 真值动作=20（设计目标 5 轮/100，不宣称达标）
工具版本 / 自检结果（ACCEPT_FIX_OK=1, PASS_COUNT=41）：
轮次 | session | 时长 | dropped | G3a A1/A4 | G3b A2 | G3c 非A3 false/min | A3 TP/truth | A3 观察脉冲 | VERIFY_PASS | 失败项
r1 ...
VERIFY_PASS=0/1
VERIFY_FAIL_ITEMS=
A3 段外脉冲 / 窗内重复（只展示）：
B1 风险（A2 手静止误报，如有）：
设计目标 5 轮追加时另填：M5V7_ACTION_COUNT / M5V7_RECALL / M5V7_FALSE_PER_MIN / M5V7_RESULT
失败归因（V7-F#）：
备注（节拍/换人/异常）：
```
