# 上位机工具

本目录放着与上位机（网关 / Web 面板 / 协议）配合的离线命令行工具。多数是排障脚本，
少数是交付给验收流程的工具——`action_eval.mjs` 属于后者。

## action_eval.mjs —— M5 动作识别现场评测

用**操作员键盘标注真实类别**，同时从网关的**只读**动作 API 采集固件判定，最后输出
混淆矩阵、各类别 P/R/F1、准确率、误触发次数/分钟、漏检和判定延迟。用于 M5 上板验收：

- 有效动作 ≥ 100 次；
- 准确率 ≥ 85%；
- 误触发 < 1 次/分钟。

### 只读与端口约定

工具只发 `GET /api/action*`（含 `/api/action/events` 长轮询），不写配置、不触发录制、
不新增任何接口。它不会占用或绑定 UDP 1234 / WS 8787；如果本机面板正在用这两个端口，
工具直接连面板的 HTTP API 即可，不会干扰它。

合成 E2E（`--e2e`）会自己启动一个隔离网关，硬性要求：

- UDP 端口 ≥ 12400，且禁止 1234；
- HTTP/WS 端口 ≥ 8800，且禁止 8787；
- 默认 `127.0.0.1:12400` + `127.0.0.1:8900`。

### 交互模式（现场验收）

先确认网关已经启动、板卡/回放数据已进入网关（浏览器面板能看到画面）：

```bash
cd E:/workspace/FPGA_Comp/host/app
node --experimental-strip-types tools/action_eval.mjs \
  --api http://127.0.0.1:8787 \
  --out "$TEMP/action_eval_m5"
```

键位：

| 键 | 含义 |
| --- | --- |
| `1` | 选择真实类别 = 手部开合（class 1） |
| `2` | 选择真实类别 = 横向挥手（class 2） |
| `0` | 标记“无动作”区间 |
| 空格 / 回车 | 确认当前选择并记一条真值 |
| `q`（或 Ctrl-C） | 结束采集并落盘 |

节奏：操作员做一个动作后按 `1` 或 `2`，再按空格/回车确认；确认时刻即真值窗口起点。
每次标注后等判定出现在终端（`[pred] ...`）再标下一个。结束前建议等一个默认 3 s 的匹配窗口，
让最后一个判定到达。`0` 只作为“无动作”真值标记记录，不参与召回率，但用于说明评测区间。

### 脚本 / E2E 模式（回归、CI）

`--script <truth.json>` 用固定真值时间线回放，适合排除键盘操作后的自动回归。
真值时间 `tMs` 是相对采集起点（取得事件游标基线之后）的毫秒数。支持三种根结构
（字段别名可混用）：

```json
[
  { "tMs": 300, "class": 1 },
  { "tMs": 1100, "class": "横向挥手" }
]
```

```json
{ "timeline": [
  { "atMs": 300, "cls": "hand" },
  { "atMs": 1100, "cls": "wave" }
] }
```

也接受 `{ "truth": [...] }`、`{ "events": [...] }`；数组项可写成 `[tMs, class]`。
类别别名：`0/无动作/none`、`1/手部开合/hand`、`2/横向挥手/wave`。真值不允许 class 3（保留类）。

合成 E2E 用协议编码器构造 v3 包，从本机回环 UDP 注入网关，再用长轮询采集，
最后在脚本内断言混淆矩阵与手算一致：

```bash
cd E:/workspace/FPGA_Comp/host/app
node --experimental-strip-types tools/action_eval.mjs \
  --e2e --udp-port 12400 --ws-port 8900 \
  --out "$TEMP/action_eval_e2e"
```

成功时最后一行是 `E2E_RESULT=PASS checks=<n> fails=0`，退出码 0。它不依赖真实板卡。

### 匹配口径（实现与证据都按这个）

1. 每条 class 1/2 真值标注开启一个窗口 `[T, T + windowMs]`（默认 3000 ms）。
2. 窗口内**第一个未被消费**的判定算匹配；同一窗口内后续判定计“重复”，不重复计误触发。
3. 已标注动作但窗口内没有任何判定 → 漏检（miss）。
4. 落在所有动作窗口之外的 `class != 0` 判定 → 误触发，计入误触发次数/分钟。
5. class 0 判定不计入预测；class 3 是保留类，只按预测类别统计，不应由固件产生。
6. 错分同时记该真值类的 FN 和预测类的 FP。

注意：网关只在“有效动作且 class 发生变化”时产生事件，所以同一动作的持续帧不会刷屏。
交互标注时按一次键只记一条真值；不要为同一个动作连续按多次。

### 输出

`--out <dir>` 下生成两个文件（目录不存在会自动创建）：

- `action_eval.csv`：表头固定 `t_ms,kind,class,className,conf,matched`。
  `kind` 是 `truth` 或 `pred`；真值行的 `conf` 为空；`matched` 为 `true/false`。
- `action_eval_summary.json`：混淆矩阵、per-class P/R/F1、accuracy、balanced accuracy、
  macro F1、误触发/分钟、漏检数、总判定数、置信度分档、匹配/传输延迟、
  `m5Acceptance`（100 次 / 85% / <1 次每分钟三项是否达标）以及运行元数据。

混淆矩阵行是真值类别 1/2/3，列是预测类别 1/2/3 加 `miss`。`accuracy` 的分母是
“动作真值数 + 误触发数”，所以误触发会直接拉低准确率。

### 单元测试

```bash
cd E:/workspace/FPGA_Comp/host/app
node --test --experimental-strip-types tools/test/action_eval.test.ts
```

根目录 `npm test` 的 glob 已包含 `tools/test/**/*.test.ts`，无需额外配置。
