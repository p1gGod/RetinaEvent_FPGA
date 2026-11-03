# 串口动作轮询与快照防污染（2026-10-31）

- 日期：2026-10-31
- 执行：一线代码开发（dev-frontline）
- 任务来源：Lead 消息 m00612（串口 1 Hz `GET_STATUS` 轮询）+ m00677（串口事件帧污染动作快照的根因与判据）
- 改动范围：`host/app/gateway/src/` 3 个文件 + 1 个新测试；**未改 RTL、未改前端、未重启网关、无任何 git 写操作**

**结论：串口通道下网关每秒发一次 `GET_STATUS`（silent，不推 CTRL 事件），并把串口通道的动作喂入收紧为「只认权威 TLV 0x92」；网口/回放/合成三条路径行为零变化。typecheck 通过，网关测试 273/273 全绿（新增 13 例）。**

## 1 判据真值

| 判据 | 值 | 证据 / 口径 |
| --- | --- | --- |
| `UART_POLL_IMPL_OK` | 1 | `gateway/src/main.ts:503-562` 的 `startUartStatusPoll()`；`:605` 接线、`:822` 停表 |
| `GATEWAY_TYPECHECK_OK` | 1 | `npm run typecheck` exit 0（0 error） |
| `GATEWAY_TEST_OK` | 1 | `npm run test:gateway`：tests 273 / pass 273 / fail 0 |
| `NEW_TEST_CASES` | 13 | A1–A9（轮询 9 例）+ B1–B4（串口快照 4 例） |
| `SERIAL_NO_BYTE23_OBSERVE_OK` | 1 | B1/B3：`rawCapable:false` 下无 TLV 的事件包 / 心跳包都不喂 `observe()` |
| `SRC_FILES_CHANGED` | 3 | `main.ts` +118、`processor.ts` +17/−2、`v3link.ts` +38/−8 |
| `NO_UI_CHANGE` | 1 | `git status --porcelain` 无 `host/app/web/`、无 `packages/` |
| `UART_STATUS_POLL_OK` | 1 | 见末行 |

`SRC_FILES_CHANGED=3` 与 A 阶段的 `<=2` 口径的差异说明：处理器侧判据是 m00677 追加要求 B 才出现的，Lead 在同一消息里把 `processor.ts` 追加进白名单；3 个文件是"轮询（main/v3link）+ 喂入收紧（processor）"的最小集合，**不是越界**。

## 2 缺口：为什么"心跳已经是 1 Hz"还要再加轮询

### 2.1 现有心跳的真实行为

`host/app/gateway/src/transport/live.ts:1101-1110` 给串口源装的心跳，`send` 就是 `getStatus({ heartbeat: true })`（`DOWNLINK.OPCODE.GET_STATUS` = 0x04），周期缺省 1000 ms；它有两道门（`transport/serial.ts:639-655`）：

```ts
if (now - this.lastDownlinkAtMs < 1000) { heartbeatSkippedRecentDownlink++; return; }
if (hb.canSend !== undefined && !hb.canSend()) { heartbeatSkippedInFlight++; return; }
```

`lastDownlinkAtMs` 在**每一次真实下行写入**时刷新（包括心跳自己写的那一帧）。所以它虽然不是"没有轮询"，但有三个缺口：

1. **不保证严格 1 Hz**：与任何别处的下行撞在同一秒内就被跳过（实测 `skippedRecentDownlink=57 / sent=1029`，约 5%）。
2. **会整体停摆**：`serialHeartbeatMs=0`（observer 模式，`live.ts:1047` `observer ? 0 : …`）或握手期没有心跳，就完全没有定向下行；`serialHeartbeatMs` 目前**没有** CLI 参数暴露（`host/app/gateway/src/main.ts` 里没有 `--serial-heartbeat` 解析，它只是 `LiveTransportManager` 的选项），所以在现有命令行下无法用开关关掉心跳来单独验接管路径。
3. **恰恰是"最近下行"这道门会让第二个 1 Hz 下行源把它锁死**：如果我们裸加一个独立 1 Hz 定时器，两个源的相位一旦靠拢，心跳每拍都落在"上一秒内已有下行"里被跳过 ⇒ `heartbeat.sent/ack` 冻住、串口健康度统计失真。这正是本次要避免的污染。

### 2.2 快照被串口事件帧覆盖（m00677 根因）

串口事件帧与 v3 24 B 头逐字节同构，但板端 `src/rtl/comms/uart_ev_tap.v:203-232` 封头时第 23 索引走 `default: 8'h00`（OFF3.ACTION 恒 0）。`processor.ts` 原先只看 `!ctrl || hasActionStateTlv`，于是**每一条没有原始段的串口事件帧都会以 `byte23=0` 调用 `observe()`**，把 TLV 0x92 读到的真值覆盖成"无动作"。

活体侧证（见 §7）：`/api/action` 的 `ageMs` 在 150 ms 间隔内从 658 掉到 112，而心跳只有 1 Hz，唯一可能在同一秒内多次刷新的写者就是事件帧（实测约 2.5 帧/s）。`frameIdx` 在 30068 → 30102 → 30095 之间非单调跳变，也正是多流共用一个计数位的表现。

## 3 改动

### 3.1 摘要

```
$ git diff --stat -- host/app/gateway/src
 host/app/gateway/src/main.ts               | 118 +++++++++++++++++++++++++++++
 host/app/gateway/src/pipeline/processor.ts |  17 ++++-
 host/app/gateway/src/pipeline/v3link.ts    |  38 +++++++---
 3 files changed, 163 insertions(+), 10 deletions(-)
```

另有新建未跟踪文件 `host/app/gateway/test/uart_status_poll.test.ts`（301 行 / 13 例）。

### 3.2 关键 hunk 1：串口通道只认权威 TLV（`pipeline/processor.ts`）

```ts
// 串口（rawCapable=false）的事件帧 24 B 头里 OFF3.ACTION 恒 0（uart_ev_tap.v 的
// `default: 8'h00`），照旧每帧 observe 会以"无动作"覆盖 GET_STATUS ACK 读到的真值。
private readonly rawCapable: boolean;

const authoritative = hasActionStateTlv(r.value);
if (this.rawCapable === false ? authoritative : (!r.value.ctrl || authoritative)) {
  actionStore.observe(actionRawOfPacket(buf, r.value), r.value.frameIdx, tArriveMs);
}
```

- `rawCapable` 由 transport 构造时透传（`transport/base.ts:94`，串口 `serial.ts:289` 是 `false`，UDP/回放缺省 `true`）。
- 网口/回放/合成：判据仍是 `!ctrl || has TLV 0x92`，与改动前**逐字节等价**。

### 3.3 关键 hunk 2：silent 下行（`pipeline/v3link.ts`）

```ts
private command(opcode: number, payload: Uint8Array, heartbeat = false, silent = false): Promise<AckResult> {
  …
  if (!silent) {
    this.emitCtrlEvent({ kind: "ack", opcode: r.opcode, seq: r.seq, ok: r.ok,
                         status: r.status, detail: r.detail, atMs,
                         ...(heartbeat ? { heartbeat: true } : {}) });
  }
```

```ts
getStatus(opts: { readonly heartbeat?: boolean; readonly silent?: boolean } = {}): Promise<AckResult> {
  return this.command(DOWNLINK.OPCODE.GET_STATUS, new Uint8Array(0),
                      opts.heartbeat === true, opts.silent === true);
}
```

silent **只掐推送**：SEQ 分配、ACK 按 SEQ 匹配、超时结算、`inFlight`/`pending` 口径全部不变。没有复用 `heartbeat`，因为 `heartbeat=true` 会写 `hbAck/hbFail/hbLastAckAtMs/hbLastRttMs` 这套 0xF0 专用健康度（`v3link.ts:207-233`）。

### 3.4 关键 hunk 3：轮询定时器（`main.ts`）

```ts
export const UART_STATUS_POLL_MS = 1000;
export const UART_STATUS_POLL_HEARTBEAT_FRESH_MS = 900;

export function startUartStatusPoll(deps: { … }): StatusPollHandle {
  const tick = (): void => {
    const live = deps.getLive();
    if (live === null || live.kind !== "uart") return;          // 只服务串口
    const link = live.v3link;
    if (!link.seenV3 || link.inFlight > 0) return;              // 老固件 / 用户命令在飞
    const hbAckAtMs = link.heartbeatStats?.().lastAckAtMs ?? null;
    if (hbAckAtMs !== null && nowMs() - hbAckAtMs <= freshMs) return;  // 心跳本秒已刷过
    polls += 1;
    void link.getStatus({ silent: true }).then(…, …);
  };
  const timer = setIntervalFn(tick, deps.intervalMs ?? UART_STATUS_POLL_MS);
  unrefTimer(timer);                                            // 不挂住进程退出
  return { stop: () => clearIntervalFn(timer), get polls() { return polls; } };
}
```

接线：`main.ts:579` 声明 → `:605` `statusPoll = startUartStatusPoll({ getLive: () => live, log: (m) => log(m) });`（紧跟 `calTimer` 两行之后）→ `close()` 里 `:822` `if (statusPoll !== null) statusPoll.stop();`（紧跟 `clearInterval(calTimer)`）。

## 4 设计取舍

| 问题 | 选择 | 理由 |
| --- | --- | --- |
| 为什么只在 `kind === "uart"` 下轮询 | 网口/回放/合成三路一行不发 | 这三路的动作字节本来就随数据包到达（`rawCapable=true`，`processor.ts` 每包 `observe`），再发下行只会白增流量与 ACK 事件；回放/合成甚至没有板端可答，必然超时刷错误日志 |
| 为什么必须 `inFlight === 0` | 用户命令在飞就跳过本拍 | TLV 0x92 是按 SEQ 匹配的一次性应答；用户点"刷新状态/改参数"时若并发插一条 GET_STATUS，会让用户命令的等待与 ACK 语义纠缠（且实际串口 921600 下也不是瓶颈） |
| 为什么用 `silent` 而不是 `heartbeat` | 新增第 4 个参数 | `heartbeat=true` 会把 `hbAck/hbFail/lastRttMs` 变成"轮询 + 心跳"混合口径，串口连接卡与 `/api/stats` 的心跳健康度立刻失真；silent 只掐 `emitCtrlEvent`，前端「最近命令」/toast 不被每秒一次的自动查询刷屏（`web/src/main.ts:975` 的 `ackTracker.note(…)` 只吃 ctrl ack 事件，因此前端零改动） |
| 为什么还要"心跳新鲜就跳过" | `lastAckAtMs` 在 900 ms 内则不发 | 心跳本身就是一条 GET_STATUS，其 ACK 也带 0x92 也喂快照 ⇒ 心跳活着时轮询纯属重复；更重要的是避开 §2.1 第 3 条"两个 1 Hz 源把心跳的 1 s 门锁死" |
| 为什么阈值 900 ms（< 1000） | 留 100 ms 相位余量 | 心跳 ACK 落在 tick 边界附近时，用 900 ms 判"本秒已覆盖"，不会因为抖几毫秒就多发一条 |
| 为什么不用 `heartbeat:true` 的 `sent` 计数判断 | 用 ACK 时间戳 | `sent` 只反映"发了"，ACK 时间戳才反映"板端回了、快照真被刷新了" |

## 5 测试

### 5.1 命令与输出

```
$ cd /e/workspace/FPGA_Comp/host/app && npm run typecheck      # exit 0，无输出错误
$ node --test --experimental-strip-types "gateway/test/uart_status_poll.test.ts"
✔ A1 串口 + 心跳从未 ACK：每个周期发一次 GET_STATUS，且带 silent（不推 CTRL 事件）
✔ A2 网口 / 回放 / 合成通道：一次都不发（动作字节随数据包到达，轮询纯属多余流量）
✔ A3 inFlight>0（用户命令在飞）：跳过本轮，命令落地后恢复（S8 不打断用户操作）
✔ A4 未见过 v3 上行（v2 固件）：不发，避免白刷板端 dlReject 计数
✔ A5 心跳刚 ACK 过（≤900 ms）：跳过；心跳停摆后由轮询接管
✔ A6 缺省周期 = UART_STATUS_POLL_MS = 1000 ms；stop() 后定时器被清掉
✔ A7 ACK 超时：只记日志、不重试、不停机；连续失败只在第 1 次打日志
✔ A8 发送阶段直接抛错（串口写失败）：包成日志，不产生未处理 rejection
✔ A9 真 V3Link：silent 的 ACK 不进 emitCtrlEvent（面板「最近命令」不被轮询污染），普通命令照常推
✔ B1 串口（rawCapable=false）事件帧 byte23=0x00：不得喂动作快照
✔ B2 串口 + GET_STATUS ACK 的 TLV 0x92：喂快照，且 class/conf 与字节一致
✔ B3 串口 + 无 TLV 的 CTRL（心跳 / 其它 ACK）：同样不喂快照
✔ B4 网口 / 回放（rawCapable=true）：数据包 byte23 照旧每包更新快照（B 组修复不得波及）
ℹ tests 13  ℹ pass 13  ℹ fail 0  ℹ duration_ms 957.96
```

```
$ npm run test:gateway
ℹ tests 273  ℹ pass 273  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ duration_ms 20136.79
```

基线 260 + 新增 13 = 273，无回归。

### 5.2 覆盖点与真实语义的对应

- A1/A2 断的是"发了/没发"（用 `link.getStatus` 的注入桩记录每次调用的 `opts`），不是日志字符串。
- A5 用注入的 `nowMs` 把心跳 ACK 时间戳拨进/拨出 900 ms 窗口，断言同一套 tick 逻辑在两个相位下的两条分支。
- A6 用注入的 `setIntervalFn/clearIntervalFn` 捕获实参毫秒数与 `stop()` 是否真的 `clearInterval`。
- A9 用**真** `V3Link` 走完整 `command() → encodeDownlink → onCtrlPacket(ACK) → finish()`，断言 silent 时 `onCtrlEvent` 零调用、普通命令 1 次调用——这是"前端不被污染"的唯一可信证据（桩测不出来）。
- B2 的期望值来自 `decodeActionState(0xa1)`（协议包自己的解码器），不是手写常量，避免测试与实现同错。

## 6 工作区状态（`git status --porcelain` 全量，19 行）

```
 M README.md
 M docs/04_contest/02_提交物清单.md
 M docs/04_contest/05_report_outline_and_style.md
 M docs/06_facts/01_fact_register.md
 M docs/06_facts/02_metric_register.md
 M docs/Lead任务台账.md
 M docs/README.md
 M host/app/gateway/src/main.ts
 M host/app/gateway/src/pipeline/processor.ts
 M host/app/gateway/src/pipeline/v3link.ts
 M report/design_report.md
 M report/evaluation_report.md
 M docs/06_facts/00_current_status.md
?? _recover/
?? docs/05_experiments/action_recognition_20261029/act8_board_acceptance_a1a4_20261031.md
?? docs/05_experiments/action_recognition_20261029/act8_uart_combined_bitstream_build_20261031.md
?? docs/05_experiments/action_recognition_20261029/uart_action_status_polling_20261031.md
?? docs/07_review/11_阶段复查_act8验收_20261031.md
?? docs/07_review/12_功能清单复核_20261031.md
?? host/app/gateway/test/uart_status_poll.test.ts
```

本人的行只有 5 条：3 个 ` M` 源文件 + 2 个 `??`（测试与本报告）；其余 `docs/**`、`README.md`、`report/**`、`docs/06_facts/00_current_status.md`、`_recover/` 是 Lead/技术总监的并发改动，**不是本次产物**。全程 `git` 只读（无 add/commit/push/checkout/reset）。

## 7 活体证据：`/api/action` 被事件帧刷新（原始输出）

采集方式（只读，未重启网关，跑的是**改动前**的旧进程）：`curl -s http://127.0.0.1:8787/api/action` 连采 5 次、间隔约 150 ms。原始 JSON 每次 324 B，下面是一份完整原件：

```json
{
 "ok": true,
 "uptimeMs": 72115942,
 "uiUrl": "http://127.0.0.1:8787/",
 "available": true,
 "frameIdx": 30068,
 "tArriveMs": 1793439895937,
 "ageMs": 658,
 "raw": 0,
 "valid": false,
 "class": 0,
 "className": "无动作",
 "conf": 0,
 "mapped": null,
 "seq": 304,
 "tMs": 1793439895937,
 "source": "ui",
 "count": 304
}
```

5 次采样的关键字段（`/tmp/action_probe_raw.txt` 原件）：

| # | uptimeMs | frameIdx | tArriveMs | ageMs | raw | valid | count |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 72115942 | 30068 | 1793439895937 | 658 | 0 | false | 304 |
| 2 | 72116221 | 30102 | 1793439896762 | 112 | 0 | false | 304 |
| 3 | 72116471 | 30095 | 1793439896937 | 187 | 0 | false | 304 |
| 4 | 72116729 | 30095 | 1793439896937 | 445 | 0 | false | 304 |
| 5 | 72116984 | 30095 | 1793439896937 | 700 | 0 | false | 304 |

同时段 `/api/stats`（两次间隔 2.001 s）：

| 字段 | 第 1 次 | 第 2 次 | 解读 |
| --- | --- | --- | --- |
| `config.transport.uart.deframer.v3Frames` | 4946 | 4951 | 2 s 内多 5 帧 ⇒ 事件帧约 2.5 帧/s |
| `config.transport.uart.deframer.telemFrames` | 4372 | 4377 | 遥测 5 帧/2 s |
| `config.transport.uart.deframer.telemCrcFail` / `v3CrcFail` | 0 / 2 | 0 / 2 | 串口链路无新错 |
| `stats.bytesRaw` / `bytesEvents` | 0 / 778200 | 0 / 778200 | 串口通路上没有原始段（只有事件段） |
| `heartbeat.sent` / `heartbeat.ack` | 1029 / 1029 | 1031 / 1031 | 心跳确实是 1 Hz、全 ACK |
| `heartbeat.skippedRecentDownlink` | 57 | 57 | 约 5% 被"最近下行"门控跳过 |
| `heartbeat.lastRttMs` | 3 | 3 | 板端应答 3 ms |

**推断**：心跳只有 1 Hz，不可能在 150 ms 的采样间隔里把 `ageMs` 从 658 拉到 112；能在这个节拍上写快照的只有 `v3Frames` 那 2.5 帧/s 的事件帧。这与 `uart_ev_tap.v` 的 `default: 8'h00` 完全吻合：**快照被"每条事件帧一次、值为 0"地反复覆盖**。

**诚实边界**：当前板端采到的确实也是"无动作"（`raw=0`），所以从**数值**上无法区分"真无动作"和"被 0 覆盖"；上表的判定依据是 **RTL 代码 + 刷新节拍**，不是数值差。新代码生效后，串口通道的写入方只剩 ACK 里的 TLV 0x92，事件帧不再有写入权；届时若板端真检测到动作，`raw` 就能稳定保持直到下一条 ACK。

## 8 副作用、未做与边界

- **没有重启网关**（按约束，127.0.0.1:8787 的进程仍是旧代码），所以本次活体数据只能证明"旧进程存在污染"，不能证明"新进程已修复"；后者需 Lead 重启后复验（§9）。
- **没有改 RTL**：正解是让 `uart_ev_tap` 也把 OFF3.ACTION 填成 `act_state_cdc` 的锁存值（与数据帧 byte23 同源），但那要重综合、重烧板，超出本轮范围，建议单独立项（可参照 `downlink_cmd.v` 里 0x92 的取数逻辑）。
- 新增每秒一条下行（仅串口、且心跳空闲时）：在 921600 下是一条 12 B 下行帧（10 B 定长头 + 2 B CRC，GET_STATUS 无载荷）+ 板端 103 B 全包 ACK（CTRL_LEN 71，实测 RTT 3 ms），相对 4 帧/s 遥测的占用可忽略；上行 `bytesDropped` 无变化（230832 → 231092，随运行时长线性增长，与轮询无关）。
- 定时器用 `unrefTimer`，不会挂住进程退出；`close()` 里 `stop()`，热切通道不会泄漏定时器。
- 未改 `.gitignore`、未改前端、未动 `submission/`、未做任何 git 写操作。

## 9 复现与 Lead 验收步骤

```bash
cd /e/workspace/FPGA_Comp/host/app
npm run typecheck                 # 期望 exit 0
npm run test:gateway              # 期望 tests 273 / pass 273 / fail 0
```

重启网关后（由 Lead 执行，串口 COM9@921600）：

```bash
# 1) 轮询生效：串口下应每秒一条 GET_STATUS，且不进 CTRL 事件流
curl -s http://127.0.0.1:8787/api/stats    | node -e '…过滤 heartbeat/deframer…'
# 2) 快照只由 ACK 刷新：无动作时 raw/valid 应稳定为 0/false，ageMs ≤ ~1000（由心跳或轮询保证）
curl -s http://127.0.0.1:8787/api/action
# 3) 前端不被刷屏：面板「最近命令」不应每秒多出一条 GET_STATUS
```

验收观察点：`heartbeat.sent/ack` 仍按 1 Hz 增长且 `skippedRecentDownlink` 不因新轮询暴涨（说明未锁死心跳）；`/api/action` 的 `ageMs` 始终 ≤ 约 1000 ms（心跳活着时由心跳覆盖，心跳停摆时由轮询覆盖）。

**注意**：命令行没有 `--serial-heartbeat` 之类的开关（`serialHeartbeatMs` 只是 `LiveTransportManager` 的选项，`main.ts` 未解析），所以**无法用命令行单独关掉心跳来验证接管**；若要验证接管分支，只能用 observer 模式（`live.ts:1047` 的 `observer ? 0 : …`）或临时改缺省值（不建议）。接管分支已由 A5 用注入时钟单测覆盖。

## 10 判据块

（复跑命令见 §5；逐条真值见 §1。以下为机读块，末行即总体判据。）

UART_POLL_IMPL_OK=1
GATEWAY_TYPECHECK_OK=1
GATEWAY_TEST_OK=1
NEW_TEST_CASES=13
SERIAL_NO_BYTE23_OBSERVE_OK=1
SRC_FILES_CHANGED=3
NO_UI_CHANGE=1
UART_STATUS_POLL_OK=1

---

## C 串口模式 `/api/action`：无完整帧但有快照 ⇒ 200（task-6，2026-10-31 追加）

### C.1 现象与真因

串口 EV_ONLY 链路（`act8_uart` 位流）上板端只回 24 B 事件帧、遥测帧与 CTRL ACK，**永远不会有完整 800×480 帧**；而动作快照来自 GET_STATUS ACK 尾部的权威 TLV 0x92（上一轮 A+B 已打通）。但 `host/app/gateway/src/ipc/api.ts` 的 `/api/action` 第一道门是"有没有帧"：

```ts
const f = ctx.store.getFrame();
if (f === null) { /* 503「还没有收到任何完整帧」 */ }
```

于是即使 `actionStore` 里已经有快照，纯串口模式下也一律 503 —— 面板看不到任何手势结果。**TLV 那半边是好的，卡在 API 层的门控顺序上。**

### C.2 Lead 实测证据（原样，未改数值）

| 对象 | 实测 |
| --- | --- |
| GET_STATUS ACK | `ctrl=true opcode=4 ctrlLen=71 len=103`；TLV 序列 `[[129,1],[130,2],[131,2],[132,6],[133,2],[134,1],[135,2],[136,4],[137,4],[138,3],[140,1],[141,1],[142,3],[143,1],[144,2],[145,1],[146,1]]` ⇒ **0x92 存在且 len=1**，`hasActionStateTlv` 为真、`observe()` 有被调用 |
| 事件帧 | `ctrl=false`、`raw23=0`（`src/rtl/comms/uart_ev_tap.v` 的 `default: 8'h00`）⇒ 上一轮 B 门控方向正确，事件帧不再污染快照 |
| 心跳包 | `opcode=240 ctrlLen=25 len=57`；TLV `[[129,1],[134,1],[136,4],[135,2],[137,4],[143,1]]` ⇒ 无 0x92，被正确忽略 |
| 实例 | 纯串口 `--serial COM9 --ws-port 8788` |

### C.3 改动（只动 api.ts，纯插入 27 行、0 删除）

```
$ git diff --stat -- host/app/gateway/src/ipc/api.ts
 host/app/gateway/src/ipc/api.ts | 27 +++++++++++++++++++++++++++
 1 file changed, 27 insertions(+)
```

关键 hunk（`if (f === null)` 分支内新增前置判断，其余代码一字未动）：

```ts
if (f === null) {
  // 串口 EV_ONLY 没有完整帧，但 GET_STATUS ACK 的 TLV 0x92 已写了快照 ⇒ 有快照就给 200
  const snapNoFrame = action.getSnapshot();
  if (snapNoFrame !== null) {
    sendJson(res, 200, {
      ...base,
      available: true,
      frameIdx: snapNoFrame.frameIdx,
      tArriveMs: snapNoFrame.tArriveMs,
      ageMs: nowMs - snapNoFrame.tArriveMs,
      raw: snapNoFrame.raw,
      valid: snapNoFrame.valid,
      class: snapNoFrame.class,
      className: snapNoFrame.className,
      conf: snapNoFrame.conf,
      mapped: snapNoFrame.mapped,
      seq: action.getLastEventSeq(),
      tMs: snapNoFrame.tArriveMs,
      source: action.getConfigView().source,
      count: action.getCount(),
      reason: "串口事件-only 链路：无完整帧，动作快照来自 GET_STATUS TLV 0x92",
    });
    return true;
  }
  // 既无帧又无快照：保持原 503 与原文案
  sendJson(res, 503, { ...base, ok: false, available: false, error: "还没有收到任何完整帧（检查板子/网口/UDP 端口）" });
  return true;
}
```

### C.4 三态对照

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 无帧 + 有快照（串口 EV_ONLY，本轮修复点） | **503** | **200 `available:true`**，字段全取快照，附 `reason` 说明来源 |
| 无帧 + 无快照 | 503 +「还没有收到任何完整帧（检查板子/网口/UDP 端口）」 | **不变** |
| 有帧 + 有快照 | 200 `available:true`（字段见契约 §4.1） | **逐字段不变**：不出现 `reason`，`frameIdx/tArriveMs/ageMs/raw/valid/class/className/conf/mapped/seq/tMs/source/count` 全同 |
| 有帧 + 无快照 | 200 `available:false` +「当前数据源不是 v3 实时帧（v2/回放/合成），没有动作字节」 | **不变** |

`/api/action/events` 未改：它本就用 `action.hasSnapshot` 判 503，串口下有快照时原本就是 200（等不到事件 ⇒ `timeout:true`）。前端零改动：web 早就按 `available/reason` 分支展示。

### C.5 测试

```
$ node --test --experimental-strip-types "gateway/test/action_api_uart.test.ts"
✔ C1 串口无完整帧 + 有快照 ⇒ 200 available:true（task-6 的核心修复）
✔ C2 串口无完整帧 + 无快照 ⇒ 仍是 503，文案逐字不变（不得把错误码改宽）
✔ C3 有帧 + 有快照 ⇒ 与改动前逐字段一致，且不得多出 reason（回归）
✔ C4 有帧 + 无快照 ⇒ 仍是 200 available:false + 原 reason（回归）
ℹ tests 4  ℹ pass 4  ℹ fail 0

$ npm run typecheck            # exit 0，0 error
$ npm run test:gateway
ℹ tests 277  ℹ pass 277  ℹ fail 0  ℹ duration_ms 20210.72
```

基线 273 + 新增 4 = 277。C3 用 `Object.keys(j).sort()` 钉死字段集合（17 个键），防止以后有人在有帧链路里"顺手"加 `reason`。

### C.6 未做与边界

- **未重启网关、未碰 8787/8788 进程**：新代码的活体确认需 Lead 用自己的串口实例重启后复验；当前跑着的旧进程仍会 503，属预期。
- **未改 RTL**：`uart_ev_tap.v` 的 `default: 8'h00` 仍然存在（上一轮已论证：串口反面靠 processor 门控挡住即可，RTL 修复要重综合重烧板，单独立项）。
- **未改契约文案**：503 的 error、available:false 的 reason 均逐字保留；新分支只多给一个 `reason` 字段，不改任何既有字段语义。
- 未改 `web/**`、`packages/**`、`processor.ts`/`main.ts`/`v3link.ts`；无任何 git 写操作（工作树 2 个改动可审：`api.ts` 修改 + 新测试文件）。

### C.7 判据块（task-6）

UART_ACTION_API_OK=1
GATEWAY_TYPECHECK_OK=1
GATEWAY_TEST_OK=1
NEW_TEST_CASES=4
NO_UI_CHANGE=1
NO_RTL_CHANGE=1
NO_GIT_WRITE=1

---

## D 心跳让位：心跳启用时轮询零下行（task-7，2026-10-31 追加）

### D.1 现象（8787 活体实测，串口通道切过来 25 s 后）

```
transport.uart.heartbeat = { enabled: true, intervalMs: 1000,
                             sent: 0, ack: 0, skippedRecentDownlink: 25, lastAtMs: null }
```

同一时刻 `/api/action` 每秒正常刷新（`ageMs` 109~959 ms、`frameIdx` 每秒 +27）—— 说明 A 轮询在跑，而**心跳一次都没发出去**。

### D.2 机理（鸡生蛋）

`host/app/gateway/src/transport/serial.ts` 的心跳闸门：

```ts
if (now - this.lastDownlinkAtMs < 1000) { this.heartbeatSkippedRecentDownlink++; return; }
```

A 轮询每 1 s 写一次 GET_STATUS，把 `lastDownlinkAtMs` 一直压在 1000 ms 以内 ⇒ 心跳每一拍都被判"最近有下行"而跳过 ⇒ `heartbeat.sent/ack` 永久冻在 0、面板心跳健康度失真。

上一轮用「`heartbeatStats().lastAckAtMs` 在 900 ms 内就跳过轮询」做互斥，方向反了：它把"最近有没有 ACK"当配置用。心跳一旦被饿死，`lastAckAtMs` 永远不新鲜 ⇒ 守卫恒为"放行" ⇒ 轮询继续饿死心跳。**互斥判据必须取配置（心跳启用与否），不能取运行时 ACK 时刻。**

### D.3 修法（`main.ts`，44 insertions / 9 deletions）

`startUartStatusPoll` 新增两个配置输入，tick 里在 `kind === "uart"` 之后立刻判：

```ts
readonly heartbeatEnabled?: () => boolean;   // 缺省 undefined = 没有心跳 ⇒ 轮询照常跑
readonly heartbeatIntervalMs?: () => number; // 0 = 关闭

// tick 内（早于任何 link 判据，保证"零下行"）：
if (deps.heartbeatEnabled?.() === true && (deps.heartbeatIntervalMs?.() ?? UART_STATUS_POLL_MS) > 0) return;
```

`runGateway` 接线取**配置真值**（不是 ACK 时刻）：`LiveTransportManager.statusView().uart.heartbeat`，与 `/api/stats` 的 `transport.uart.heartbeat` 同源（`live.ts:441` 的 `uartStatusView()` = `SerialTransport.statusView()` 的 `heartbeat.enabled/intervalMs` + V3Link 的 ACK 统计）：

```ts
const heartbeatConfig = (): { enabled: boolean; intervalMs: number } | null => {
  if (live === null) return null;
  try {
    const hb = live.statusView().uart?.["heartbeat"];
    if (typeof hb !== "object" || hb === null) return null;
    const v = hb as { enabled?: unknown; intervalMs?: unknown };
    return { enabled: v.enabled === true, intervalMs: typeof v.intervalMs === "number" ? v.intervalMs : 0 };
  } catch { return null; }
};
statusPoll = startUartStatusPoll({
  getLive: () => live,
  log: (m) => log(m),
  heartbeatEnabled: () => heartbeatConfig()?.enabled === true,
  heartbeatIntervalMs: () => heartbeatConfig()?.intervalMs ?? 0,
});
```

读不到（udp 主通道、初始化瞬间、异常）一律当"没有心跳"⇒ 轮询接管（安全侧：宁可多一次 1 Hz 查询，也不让 `/api/action` 冻住）。原「900 ms ACK 新鲜度」守卫**保留**，但降级为二次保险：只覆盖"心跳刚被关掉、ACK 尾巴还在飞"的交接窗口。

### D.4 让位后的行为矩阵

| 串口心跳配置 | 轮询 | `/api/action` 刷新来源 |
| --- | --- | --- |
| `enabled=true, intervalMs=1000`（缺省，主串口通道） | **零下行** | 心跳的 1 Hz GET_STATUS ACK（TLV 0x92） |
| `serialHeartbeatMs=0` | 正常 1 Hz | 轮询（silent） |
| observer 旁路（UDP 主通道下的第二串口） | 不适用（`live.kind === "udp"` 直接 return） | 数据包 byte23 |
| 非串口通道（udp/replay/synth） | 零下行 | 数据包 byte23 |

### D.5 测试（D 组 4 例，全部打假链路，不碰真串口）

```
$ node --test --experimental-strip-types "gateway/test/uart_status_poll.test.ts"
✔ D1 心跳启用（enabled=true, intervalMs=1000）：一次下行都不发，polls 恒为 0
✔ D2 心跳关闭（enabled=false）：轮询照常接管，逐周期发
✔ D3 enabled=true 但 intervalMs=0（心跳配置为关）：按「没有心跳」处理，轮询照常发
✔ D4 网口通道 + 心跳启用：仍然一次都不发（让位判据只在 uart 下才可能生效）
ℹ tests 17  ℹ pass 17  ℹ fail 0

$ npm run typecheck            # exit 0，0 error
$ npm run test:gateway
ℹ tests 281  ℹ pass 281  ℹ fail 0  ℹ duration_ms 21163.02
```

D1/D4 断言的是 `link.calls.length === 0`（真实下行次数），不只是 `polls` 计数；D2/D3 则同时断言 `polls === calls.length` 且首条带 `silent`。

### D.6 残留风险（只报告，不在本轮白名单内修）

- **心跳偶尔自己跳过**：闸门是 `< 1000` 而定时器就是 1000 ms，相位抖动会让个别拍被判"最近有下行"（上一轮实测 `skippedRecentDownlink` 占 ~5%，33/624）。心跳在位时轮询让位，所以那一秒没有 0x92 刷新，`/api/action` 的 `ageMs` 偶尔会到 ~2 s。要压到严格 ≤1 s，得改 `transport/serial.ts` 的闸门（如 `< intervalMs - ε`）或让两者按相位错开 —— 文件不在本轮白名单，未动。
- 若心跳启用但板端不回 ACK（链路半断），轮询同样让位 ⇒ `/api/action` 会陈旧；这属于链路故障，由传输层健康度/自动回退负责，且此时任何 1 Hz 请求都不会更准。
- 本轮未重启 8787/8788，也未烧板；新代码的活体确认（`heartbeat.sent/ack` 每秒 +1）需 Lead 重启串口实例后复验。

### D.7 判据块（task-7）

UART_POLL_HEARTBEAT_YIELD_OK=1
GATEWAY_TYPECHECK_OK=1
GATEWAY_TEST_OK=1
NEW_TEST_CASES=4
NO_UI_CHANGE=1
NO_RTL_CHANGE=1
NO_GIT_WRITE=1
