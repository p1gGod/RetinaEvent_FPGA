# 动作回传与上位机契约（M3.5）

| 项 | 内容 |
|---|---|
| 文档代号 | **CONTRACT-ACT v1.3** |
| 状态 | **冻结**（v1.0 2026-10-29 定稿；v1.3 2026-10-30 增补 §11 长录接口，§2~§6 线协议/CRC 不变；自此字节分配、TLV 线格式、HTTP 形状、actionMap schema 不再各自发挥） |
| 上游 | [04_action_recognition_selection.md](04_action_recognition_selection.md)（M0）、WIRE-V3 线协议冻结设计（文件 ../05_实验与实测/协议v3设计_20261009/v3线协议设计.md，未随包发布） |
| 下游 | M4（板端 RTL 动作字节 + TLV 0x92 落位）、M5（网关只读 API + 前端卡片 + 动作→操作） |
| 性质 | **契约文档**：只冻结接口，不写实现；本轮不改任何源码/RTL/测试 |
| 结论分级 | **【实测】** = 本轮命令/读码得到的事实；**【文档】** = 有路径行号可点；**【推断】** = 按代码结构推导，需上板验证 |

---

## 0. 结论速览（冻结清单）

| # | 冻结项 | 取值 | 依据 |
|---|---|---|---|
| F1 | 上行数据帧 `offset 23` | 由 "RSVD 必须 0x00" 改为**动作字节**；位分配见 §2 | 本文件 §2；M0 §1.3 |
| F2 | 上行 CTRL TLV | 新增 **tag `0x92`（ACTION_STATE），len=1，value = 同一动作字节** | 本文件 §3 |
| F3 | TLV 0x92 出现位置 | **只随 GET_STATUS(0x04) ACK** 尾追；SET_PARAM/SET_MODE/TIME_SYNC ACK 与 1 Hz 心跳**不加** | 本文件 §3.2 |
| F4 | 只读 HTTP 接口 | `GET /api/action`、`GET /api/action/events?after=&timeoutMs=`、`GET /api/action/config`；仅 GET/HEAD | 本文件 §4 |
| F5 | 动作→操作映射 | 操作 `{none,startRecord,stopRecord,startAndAutoExport}` × 目标 `{raw,events,overlay,statsOnly}` | 本文件 §5.2/§5.3 |
| F6 | 持久化 | 浏览器 `localStorage` 键 **`actionMap`**（JSON schema 见 §5.4）；网关只持有**只读运行镜像** | 本文件 §5.4 |
| F7 | CRC 顺序 | `offset 23` 必须在**进入 CRC 累加之前**定值；CRC 覆盖 [0..len) 含整段 24 B 头 | 本文件 §6 |
| F8 | 下行命令 | **v1 不新增任何下行 tag**（动作分类器开关/阈值属板端固件参数，M4 另议） | 本文件 §1 |

---

## 1. 范围与非目标

**范围**

1. 板端 → PC 的**动作分类结果**（每帧 1 B）如何放进 v3 数据帧头、如何在 CTRL 通道读回；
2. 网关暴露给外部程序/页面的**三个只读 HTTP 接口**的请求、响应、超时与错误码；
3. 前端「动作识别」卡片的字段、动作→录制操作映射、`actionMap` 持久化 schema，以及**执行动作时必须复用的唯一录制入口**。

**非目标（明确不做，避免后续返工）**

- 不提供任何 HTTP 写接口（POST/PUT/DELETE）。本项目的 `/api/*` 是只读旁路，写操作一律走既有 WS RPC（`config.set` / `board.*`）。【文档】`host/app/gateway/src/ipc/api.ts:96-100` 已有 405 守卫。
- 不新增下行命令、不改 `downlink_cmd.v` 的下行 tag 表（0x01..0x0C 保持不动）。
- 不把动作识别结果并入 v2 帧/遥测帧；v2、回放、合成源下动作接口返回 `available:false`。
- 不在本契约规定分类器算法/精度（M0 §4~§7 负责），只规定**接口与字节**。
- 不改 `host/app/web/src/export/registry.ts` 既有 5 个导出器；`statsOnly` 走独立轻量统计导出（§5.3）。

---

## 2. `offset 23` 位分配（冻结）

### 2.1 位图

24 B v3 包头的第 23 字节（0 基偏移）原为 `RSVD`，WIRE-V3 要求写 `0x00`。【文档】`host/app/packages/protocol/src/constants.ts:37`（`OFF3.RSVD = 23`）、`docs/05_experiments/协议v3设计_20261009/v3线协议设计.md:59`

```
 bit7  bit6 ............ bit2   bit1 bit0
 ┌─────┬──────────────────────┬───────────┐
 │VALID│     CONF (5 bit)      │ CLASS(2b) │
 └─────┴──────────────────────┴───────────┘
```

| 位 | 名称 | 含义 | 值域 |
|---|---|---|---|
| 7 | `VALID` | 本次分类结果有效 | 0/1 |
| 6..2 | `CONF` | 置信度，越大越可信（**不是**概率百分比） | 0..31 |
| 1..0 | `CLASS` | 0=无动作（含板移等"无动作窗"），1=手部开合（任一方向），2=横向挥手，3=保留 | 0..3 |

- 编码：`raw = (VALID<<7) | ((CONF & 0x1F)<<2) | (CLASS & 0x03)`。
- 未启用识别功能时整字节写 `0x00`（`VALID=0`），与旧 v3 规范逐字节兼容。
- `VALID=1` 且 `CLASS=0` 是**合法且常见**的组合（"结果有效：此刻无动作"）。
- `CLASS=3` 为保留值：上位机必须当作"无动作"处理、**不得执行任何映射操作**；板端 v1 不得产生。
- 上位机解码失败/未实现时按 `{valid:false, conf:0, cls:0}` 处理，不抛错、不丢帧。

### 2.2 编码/解码唯一实现（M5 落地位置）

放在协议包（`host/app/packages/protocol/src`）而不是页面里，避免两套位运算：

```ts
export interface ActionState { readonly valid: boolean; readonly conf: number; readonly cls: 0 | 1 | 2 | 3 }

export function decodeActionState(raw: number): ActionState {
  return { valid: (raw & 0x80) !== 0, conf: (raw >> 2) & 0x1f, cls: ((raw & 0x03) as 0 | 1 | 2 | 3) };
}
export function encodeActionState(a: ActionState): number {
  return ((a.valid ? 1 : 0) << 7) | ((a.conf & 0x1f) << 2) | (a.cls & 0x03);
}
```

> **命名差异（M4 落地后补注）**：实际代码为 `ActionState` / `decodeActionState` / `encodeActionState`（【实测】`host/app/packages/protocol/src/codec/v3.ts:46,59,72`，位常量 `ACT3`）。初版稿的 `*ActionByte` 只是设计名，语义与本 §2 冻结位定义一致。

### 2.3 兼容性论证（为什么旧上位机不会被写坏的字节骗到）

1. **旧解析器根本不读 byte23**：【实测】`host/app/packages/protocol/src/codec/v3.ts:88-196` 的 `parseV3Packet` 只按 `OFF3` 读 0..22 的字段，全文没有 `OFF3.RSVD` 的读取；`ParsedV3` 类型（`host/app/packages/protocol/src/types.ts:85-115`）也没有该字段。
2. **RSVD==0 没有被断言**：【实测】全仓库 `OFF3.RSVD` 仅出现在 `constants.ts:37` 的定义处；测试构造器 `host/app/packages/protocol/test/helpers.ts:121` 只是**写入** `out[23] = 0`，没有断言。⇒ 旧版上位机收到 `byte23=0xA1` 不会拒包。
3. **CRC 覆盖整包**：`codec/v3.ts:141-147` 对 `buf[0..hdr+rawLen+evLen)` 求 CRC16，包含 byte23。⇒ 只要板端按 §6 先写 byte23 再累 CRC，整包 CRC 自洽，旧/新上位机都过。
4. **前向兼容规则仍成立**：旧上位机把 byte23 当保留字节忽略；新上位机从同一字节解出动作。若有第三方实现坚持"RSVD 必须 0"，那是它违反 WIRE-V3 §2.3 的"保留字节接收方忽略"精神，本项目不为其让路（WIRE-V3 §2.3 只对**发送方**要求写 0）。【推断】

### 2.4 取值示例

| 场景 | VALID | CONF | CLASS | 字节 |
|---|---|---|---|---|
| 识别未启用 / 旧固件 | 0 | 0 | 0 | `0x00` |
| 有效：无动作，置信度 20 | 1 | 20 | 0 | `0x80 \| (20<<2) = 0xD0` |
| 有效：手部开合，置信度 8 | 1 | 8 | 1 | `0x80 \| 32 \| 1 = 0xA1` |
| 有效：横向挥手，置信度 31 | 1 | 31 | 2 | `0x80 \| 124 \| 2 = 0xFE` |
| 保留（不得产生） | 1 | 0 | 3 | `0x83` |

### 2.5 板端写入约束（给 M4）

- 写入点是 `src/rtl/comms/udp_merge.v` 的 `hdr_byte()` 函数：`5'd23` 目前落到 `default: hdr_byte = 8'h00`（【实测】`src/rtl/comms/udp_merge.v:457-485`，default 在 :478-485）。
- **每帧锁存一次**：与 `mode_q` 同款，在帧起始（`frame_idx` 变化/新帧第一拍）把最新分类结果锁存进 `action_byte_q`，保证**同一 frame_idx 的所有分片包 byte23 相同**。否则 PC 在一帧的 600 个包里读到不同 CLASS，动作触发会抖动。
- **1.0 s 空窗清零（v1.2，M4d）**：`src/rtl/subsys/act_state_cdc.v:41` 的 `ACT_IDLE_CYC = 50_000_000` 拍（50 MHz 下 1.0 s）为空窗阈值；每次识别 pulse 都重置 26 位 `idle_cnt`（:68-89）。连续 `ACT_IDLE_CYC` 拍没有新 pulse 且锁存值非 0 时，`act_byte_s` 回 `8'h00`（VALID=0）且 toggle 只翻转一次（【实测】`sim/tb/tb_act3_idleclr.v` 22 checks PASS，见 `sim/tb/tb_act3_idleclr.v`）。
- **一次检测 = 一个 pulse = VALID 0→1 一次**：清零后下一次同类动作会重新拉高 VALID，因而能被再次计数；VALID 持续为 1 且 CLASS 不变（哪怕 CONF 变）**不是**一次新检测。上位机按“VALID 上升沿或 CLASS 变化”记事件，见 §4.2。
- 多分片帧（RAW 1280 B/包，600 包/帧）的行格式不变；byte23 只改 1 B 的值，不改包头长度、不改 MTU。

---

## 3. 上行 CTRL TLV `0x92`（冻结）

### 3.1 线格式

TLV 位于 v3 CTRL 包的 `offset 30` 起（【实测】`docs/05_experiments/协议v3设计_20261009/v3线协议设计.md:271-273`；RTL 构包 `src/rtl/comms/downlink_cmd.v:10-11,17-20`）：

| 字节 | 字段 | 值 |
|---|---|---|
| 0 | `tag` | `0x92` |
| 1 | `len` | `1`（固定） |
| 2 | `value` | 动作字节，**与 `offset 23` 同值同编码** |

- 完整 CTRL 包 = 24 B 包头（`FLAGS.bit7(CTRL)=1`、`FLAGS.bit2(CRC)=1`、`RAW_LEN=EV_LEN=0`）+ 6 B 控制头（OPCODE/STATUS/SEQ/CTRL_LEN，`offset 24..29`）+ TLV + 2 B CRC16（覆盖 `[0..30+CTRL_LEN-1]`）。
- 目前全仓库**不存在** tag `0x92`；已用上行 tag 到 `0x91`（`0x8A` 版本、`0x8B` unsupported、`0x8C` EV_EN、`0x8D/8E/8F/90/91` 各状态）。`0x92` 是下一个空闲位。【实测】`grep 0x92 retina_event/ host/ docs/` 无命中；tag 表见 `host/app/packages/protocol/src/constants.ts:180-225` 与 `downlink_cmd.v:17-29,39,55`。

### 3.2 何时发（与既有 CTRL_LEN 对齐）

| 包 | 是否带 0x92 | CTRL_LEN 变化 | 理由 |
|---|---|---|---|
| `GET_STATUS(0x04)` ACK | **是**（TLV 列表末尾） | **68 → 71**（全包 100 → 103 B） | 读状态时同时读回"最近一次动作结果"，语义完整 |
| `SET_PARAM(0x01)` ACK | 否 | 26 不变 | 写参数与动作无关；避免每次写参数变长 |
| `SET_MODE(0x02)` ACK | 否 | 3 不变 | 同上 |
| `TIME_SYNC(0x03)` ACK | 否 | 11 不变 | 同上 |
| 1 Hz STATUS 心跳（OPCODE=0xF0） | 否 | 25 不变 | 心跳已被现场与测试钉住 25；动作主通道是数据帧 byte23 |

【实测】既有长度表：`downlink_cmd.v:17-20`（SET_PARAM ACK 19→23→26、GET_STATUS 61→65→68、心跳 25）、`host/app/packages/protocol/src/constants.ts:246-251` 的注释与 `CTRL.LEN` 登记值。

- **上位机不得硬编码 CTRL_LEN=68**：解析按 TLV 实际 `len` 自洽（既有解析器已如此，且测试 `host/app/gateway/test/v3link.test.ts:569-629` 覆盖了 61/65/68 三代帧）。新增 0x92 后旧固件的 68 帧仍须照常解析（`action` 保持 null，不清空最近值）。
- 旧固件没有 0x92 时：`/api/action` 的 `available` 仍可按数据帧 byte23 给出（主通道），但**若数据帧也没有**（v2/回放）则 `available:false`。

### 3.3 解析约束

- 未知 tag 忽略、不整包失败（WIRE-V3 §6.3.1 前向兼容原则）。
- `0x92` 的 `len ≠ 1` ⇒ 该 TLV 忽略并计数一次（`badTlv` 或等价计数器，**不丢整包**）。
- 收到 0x92 只更新"最近动作结果"快照；**不触发**动作执行（执行链路见 §5.6，由长轮询/卡片侧按帧 byte23 驱动）。

### 3.4 与数据帧 byte23 的关系

- **主通道**：每个数据帧的 byte23（每帧必有，3.3 fps 下延迟 ≤300 ms）。
- **辅助通道**：GET_STATUS 的 0x92（按需读回，给"帧流已停但想知道最后结果"的调试场景）。
- 两者必须来自**同一寄存器快照**（同一个 `action_byte_q`），不允许 CTRL 路径自行重算或额外锁存另一份。
- 空窗清零同样作用于 0x92：超过 1.0 s 无新 pulse 后，GET_STATUS ACK 尾部的 0x92 value 也回 `0x00`（len 仍为 1，ACK 仍 103 B）。

---

## 4. 三个只读 HTTP 接口（冻结）

### 4.0 通用约定

- 方法：**只允许 GET / HEAD**；其它方法 → `405`，正文 `本接口只读：仅支持 GET/HEAD`（与既有行为一致，【实测】`host/app/gateway/src/ipc/api.ts:96-100`）。
- 响应：`application/json; charset=utf-8`、`Cache-Control: no-store`、`Access-Control-Allow-Origin: *`（既有 `sendJson` 口径，`api.ts:41-50`）。
- 公共字段：`ok`、`uptimeMs`、`uiUrl`（既有 `base` 口径，`api.ts:103-107`）——三个新接口全部继承。
- 参数解析失败一律回退默认值并夹在值域内（既有 `intParam`，`api.ts:73-79`）。
- 未知子路径 → `404 { ok:false, error:"未知接口: <path>", endpoints } `（`api.ts:257`）。
- `HEAD` 与 `GET` 同状态码/同 Content-Type，正文按 HTTP 规范不返回。

### 4.1 `GET /api/action` —— 最近一次动作结果

**参数**：无。

**200（有新帧且可判定）**：

```json
{
 "ok": true,
 "uptimeMs": 73842,
 "uiUrl": "http://127.0.0.1:8787/",
 "available": true,
 "frameIdx": 512,
 "tArriveMs": 1793299234567,
 "ageMs": 87,
 "raw": 161,
 "valid": true,
 "class": 1,
 "className": "手部开合",
 "conf": 8,
 "mapped": { "action": "startRecord", "target": "raw" },
 "count": 7
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `available` | boolean | 是否拿到过**v3 实时帧**的 byte23；v2/回放/合成源恒 `false` |
| `frameIdx` | number | 该结果所属帧的板侧帧号（16 bit） |
| `tArriveMs` / `ageMs` | number | 帧到达网关的墙钟 ms / 距现在的毫秒数（`ageMs = Date.now()-arrivedAtMs`） |
| `raw` | number | byte23 原值 0..255 |
| `valid` / `class` / `conf` | boolean / 0..3 / 0..31 | §2 解码结果 |
| `className` | string | `无动作` / `手部开合` / `横向挥手` / `保留`（唯一来源 `ACT_CLASS_NAMES`，`constants.ts:84`） |
| `mapped` | object\|null | 按**当前生效 actionMap** 映射出的操作；`valid=false` 或 `class=3` 时为 `null` |
| `count` | number | **累计检测次数**（v1.2，M4e）：自网关启动起，VALID 上升沿或 CLASS 变化各 +1；只增不改，不受 long-poll 游标/事件环容量影响；`available:false` 时为 0 |

**200（有帧但不可判定）**：

```json
{ "ok": true, "uptimeMs": 1000, "uiUrl": "http://127.0.0.1:8787/", "available": false,
  "reason": "当前数据源不是 v3 实时帧（v2/回放/合成），没有动作字节" }
```

**503（一帧都没收到）**：`{ ok:false, uptimeMs, uiUrl, available:false, error:"还没有收到任何完整帧（检查板子/网口/UDP 端口）" }`（与 `/api/frame.json` 同文案，`api.ts:145`）。

### 4.2 `GET /api/action/events?after=&timeoutMs=` —— 长轮询动作事件

语义与既有 `/api/frames/next` 完全同构（【实测】`api.ts:225-255` + `host/app/gateway/src/pipeline/latest.ts:98-113`），只把"帧"换成"动作事件数组"。

| 参数 | 默认 | 值域 | 说明 |
|---|---|---|---|
| `after` | `-1` | int32 | 只返回 `seq > after` 的事件；`after=-1` ⇒ 立即返回"当前最新 1 条"（没有则按 timeout 等第一条） |
| `timeoutMs` | `5000` | 0..60000 | 无新事件时的最长等待；`0` ⇒ 立即判定超时 |

**事件定义（网关侧，唯一口径；v1.2 改为上升沿/类别变化）**：每当 `decodeActionState(raw).valid === true`，且满足 `VALID` 由 0 变 1（`reason="valid_rise"`）**或** VALID 保持 1 时 `class` 相对上一条有效字节发生变化（`reason="class_change"`）时，记录一条事件；VALID 持续 1 且类别不变（conf 变化不算）不记。`valid=false` 的帧**不产生事件**，只把上升沿状态复位。环形缓冲容量 **64** 条，`seq` 从 1 单调递增（每次网关启动重置）；`count` 独立累加、不因环形淘汰而减小。

**200（有事件）**：

```json
{
 "ok": true,
 "uptimeMs": 73842,
 "uiUrl": "http://127.0.0.1:8787/",
 "lastSeq": 42,
 "events": [
  { "seq": 42, "tMs": 1793299234567, "frameIdx": 512, "raw": 161,
    "valid": true, "class": 1, "className": "手部开合", "conf": 8,
    "mapped": { "action": "startRecord", "target": "raw" },
    "reason": "valid_rise" }
 ],
 "dropped": 0
}
```

- `reason`：`"valid_rise"`（VALID 0→1，板侧 1.0 s 空窗清零后每次动作都会重新出现）或 `"class_change"`（VALID 保持 1 但类别变了）；两者都只记一次、不双计。
- 单次最多返回 **32** 条（`seq` 升序）；若 `after < 最旧事件 seq - 1` ⇒ `dropped = 最旧 seq - 1 - after`（显式告知丢了历史，不静默）。
- `dropped` 只统计"因缓冲淘汰而无法交付"的条数，正常路径恒 0。

**200（超时，无新事件）**：

```json
{ "ok": false, "uptimeMs": 73842, "uiUrl": "http://127.0.0.1:8787/",
  "timeout": true, "lastSeq": 42, "events": [], "dropped": 0,
  "error": "在 5000 ms 内没有新的动作事件" }
```

**503（从未收到 v3 实时帧）**：同 §4.1 的 503 文案。`500`：内部等待异常，正文 `等待动作事件失败: <原因>`（与 `api.ts:251-253` 同款）。

### 4.3 `GET /api/action/config` —— 当前生效的 actionMap（只读镜像）

**参数**：无。

```json
{
 "ok": true,
 "uptimeMs": 73842,
 "uiUrl": "http://127.0.0.1:8787/",
 "source": "ui",
 "updatedAtMs": 1793299200000,
 "config": {
  "v": 1,
  "updatedAtMs": 1793299200000,
  "minConf": 8,
  "map": {
   "0": { "action": "none", "target": "statsOnly" },
   "1": { "action": "startRecord", "target": "raw" },
   "2": { "action": "stopRecord", "target": "raw" }
  }
 }
}
```

- `source`：`"ui"` = 网关收到过前端通过 WS `config.set {actionMap: ...}` 推来的配置；`"default"` = 从未收到过（网关启动后到页面首次同步前），此时 `updatedAtMs: null`。
- **唯一持久化副本在浏览器**（`localStorage` 键 `actionMap`，§5.4）。网关不落盘、不读盘；它只做"最近一次 UI 推送值"的只读镜像，供外部脚本读取。网关重启后到 UI 重连前，本接口退化为 `source:"default"`——这是**已知且可接受**的语义，文档与响应字段都不假装它是持久配置。
- 网关侧实现要点：WS `config.set` 白名单需接受键 `actionMap`（新增，由 M5 落地；不得把该键放进 `control` 的传输配置）。

### 4.4 错误码汇总

| 场景 | 状态码 | 正文 |
|---|---|---|
| 非 GET/HEAD | 405 | 纯文本 `本接口只读：仅支持 GET/HEAD` |
| 未知 `/api/action/*` 子路径 | 404 | JSON `{ok:false,error:"未知接口: <path>",endpoints}` |
| 从未收到帧（`/api/action`、`/action/events`） | 503 | JSON，含 `available:false` 与错误文案 |
| 长轮询超时 | **200**（不是 408/504） | JSON `ok:false,timeout:true`（与 `/api/frames/next` 同款） |
| 内部异常 | 500 | 纯文本（等待失败原因） |

### 4.5 端点到 `/api` 索引

M5 落地时把三个新端点写进 `api.ts:29-39` 的 `ENDPOINTS` 表（`/api` 与 404 都会带出），描述文本分别写「最近一次动作识别结果」「长轮询动作事件」「动作→操作映射（只读镜像）」。

---

## 5. 前端「动作识别」卡片与 `actionMap`

### 5.1 卡片位置与结构

- 位置：侧栏卡片序列 `连接与指标 → 传输方式 → 事件流 → 参数控制 → 运动预测 → 渲染图层栈`（【实测】`host/app/web/src/ui/sidebar.ts:1074` 的 `root.append(c1, cT, c2, c3, cM, c4)`）。新卡片插在**运动预测之后、渲染图层栈之前**，沿用 `cardHead(title,right)`（`sidebar.ts:172-179`）与 `kv` 行样式。
- 卡片标题：`动作识别`；右上角小字：`byte23`（状态源标识）。
- 行：
  1. 当前结果：`手部开合 · 置信度 8/31` 或 `无动作` / `识别未启用` / `无数据（等待 v3 帧）`；
  2. 映射三行（class0/1/2）：操作下拉（`none/startRecord/stopRecord/startAndAutoExport`）+ 目标下拉（`raw/events/overlay/statsOnly`）；`class 0` 的操作固定 `none`（下拉禁用）；
  3. `minConf` 数字输入（0..31，默认 8）与"`仅 VALID 且置信度 ≥ minConf 才执行`"的说明；
  4. 状态行：最近事件 `#seq · class · 时间`、`source: ui|default`、持久化状态（"已保存到浏览器"）；
  5. 右下角按钮「API 文档」（§5.7）。
- 卡片**不得**新增任何写 HTTP 请求；配置保存只写 `localStorage` + WS `config.set`。

### 5.2 操作枚举语义（冻结）

| 操作 | 行为 | 幂等/防重 |
|---|---|---|
| `none` | 不做事（只更新卡片显示） | — |
| `startRecord` | 调 `setRecording(true)`；已在录制则**空操作**（不重清缓冲） | 由 `main.ts:1366` 同值 return 保证 |
| `stopRecord` | 调 `setRecording(false)`；未在录制则**空操作** | 同上 |
| `startAndAutoExport` | `setRecording(true)` + 置"停止后自动导出一次"标志（导出目标 = 该条规则的 `target`） | 停止分支只导出一次，导出后清标志 |

触发门槛（三条同时满足）：`valid=1`、`conf ≥ minConf`、`class ∈ {1,2}` 且**与上一条已执行结果不同**（边沿触发）；同一 class 持续 10 s 只执行一次。两次执行最小间隔 **1000 ms**（防抖，不写进 schema，固定语义）。

### 5.3 目标枚举语义（冻结）

| target | 自动导出内容 | 复用现有实现 |
|---|---|---|
| `raw` | 原始帧（RGB565 `.bin`，含逐字节对拍清单） | `ExporterId "rawbin"`（`web/src/export/registry.ts:44-47`） |
| `events` | 事件流 `.csv`（每条事件一行） | `ExporterId "csv"`（`registry.ts:49-52`） |
| `overlay` | 叠加图 PNG 序列 `.zip` | `ExporterId "pngzip"`（`registry.ts:33-37`） |
| `statsOnly` | 只写统计（帧号/到达时刻/事件数/是否含原始像素），**不导出任何图像** | 无现成槽位：M5 新增轻量统计导出（建议文件名前缀 `retina-stats`），**不改** `EXPORTERS` 的 5 个既有条目 |

说明：这 4 个 target 与 `web/src/export/render.ts:26` 的渲染目标 `raw|events|overlay|post` **不是同一层**——`post` 不进本枚举；自动导出只在"停止录制"时发生，目标决定导出格式族，不改变录制行为。`target` 对 `none/startRecord/stopRecord` 不生效（仍必须合法，便于后续扩展）。

### 5.4 `actionMap` 持久化 schema（冻结）

- 存储位置：浏览器 `localStorage`，**键名精确为 `actionMap`**（不带前缀；本项目此前未使用 localStorage，这是第一个键，命名冲突风险为 0）。
- 值：JSON 字符串，结构如下（示例即默认值）：

```json
{
  "v": 1,
  "updatedAtMs": 1793299200000,
  "minConf": 8,
  "map": {
    "0": { "action": "none",         "target": "statsOnly" },
    "1": { "action": "startRecord",  "target": "raw" },
    "2": { "action": "stopRecord",   "target": "raw" }
  }
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `v` | number | 当前 `1`；读到 ≠1 时**重置为默认值**并提示（不猜旧格式） |
| `map` | object | 必须含键 `"0"`、`"1"`、`"2"`；不接受 `"3"`；缺键按默认补 |
| `map["0"].action` | enum | 必须为 `"none"`；其它值保存时回落 `"none"` |
| `action` | enum | `none|startRecord|stopRecord|startAndAutoExport` |
| `target` | enum | `raw|events|overlay|statsOnly` |
| `minConf` | number | 整数 0..31，默认 8；越界取最近边界 |
| `updatedAtMs` | number | 写入时时戳（`Date.now()`），只读展示 |

- 校验失败（JSON 坏/字段非法）：整体回落到默认值 + 一条 toast 说明"动作映射配置损坏，已恢复默认"，**不静默改用户数据**。
- 读取：页面启动时读一次并校验；写入：用户改下拉/输入时立即写 `localStorage` 并推送 WS `config.set { actionMap: <同一个对象> }`（密钥映射教训见 `host/app/web/src/hostparams.ts:1-9`：界面键与网关键必须单点映射，别让 UI 键名直接钻进网关）。
- 兼容：网关未收到过 `actionMap` 时 `/api/action/config` 回默认值 + `source:"default"`；前端卡片此时也以本地默认值为准，不阻塞。

### 5.5 录制唯一入口与自动导出落点（务必复用）

- **唯一入口**：`host/app/web/src/main.ts:1365` 的 `setRecording(v: boolean)`，注释明确"R 键与底栏「录制」按钮共用这一个入口"（`main.ts:1359`）。全仓库 `grep toggleRecord` **零命中**——任务书里若出现 `toggleRecord`，是命名偏差，以本文件为准。
- 已有调用点：R 键 `main.ts:1712`、底栏按钮 `main.ts:1761`。动作通道**不得**新增自己的 toggle 逻辑，只能调 `setRecording(true/false)`。
- 副作用须知：`setRecording(true)` 会 `recorder.clear()` 并清 `recPair`（`main.ts:1369-1370`）——动作触发开始录制会**丢掉上一次未导出的缓冲**。这是既有设计（`main.ts:1361-1364` 注释已说明），卡片文案必须提示；`startAndAutoExport` 因自动导出在停止时发生，用户不必手动导出。
- 自动导出落点：`setRecording(false)` 分支末尾（`main.ts:1376-1399`，通知之后）检查"停止后自动导出"标志，命中则调 `exportNow(exporterId(target))`（`main.ts:1609`；导出规格见 `registry.ts:60-64`）；`statsOnly` 调 §5.3 的独立统计导出。导出失败/缓冲为空必须 toast 明说（原则：不静默丢数据）。
- 手动导出路径（`exportCurrentFrame` `main.ts:1625`、`exportClip` `main.ts:1653`）与动作通道互不影响；动作通道不改变当前 `exportTarget` 选择（`main.ts:226`），只在导出的那一次临时使用规则里的 target。

### 5.6 数据流与触发规则（防"加载即执行历史"）

1. **显示**：卡片每 500 ms 轮询 `GET /api/action`（页面 `document.hidden` 时暂停；恢复可见立即拉一次）。数据源仅此接口，不解析 WS 二进制。
2. **触发**：卡片持有 `lastSeq`，用 `GET /api/action/events?after=lastSeq&timeoutMs=10000` 长轮询；每收到事件：先`lastSeq = lastSeq ??? seq`（取最大），再按 §5.2/§5.3 执行映射。
3. **首次调用**：`after=-1` 的返回**只用于初始化 `lastSeq`，绝不执行**（否则打开页面会重放历史动作、甚至触发一次"开始录制"清掉缓冲）。之后一律用 `after=lastSeq`。
4. **页面隐藏/恢复**：隐藏时暂停轮询；恢复时**丢弃积压**（以最新 `lastSeq` 重新开始），不做补偿执行——摄像机前的人早已做完动作，补执行只会产生垃圾录制。
5. **多标签页**：每个标签页各自轮询/执行；本契约不提供跨标签互斥（后续如需，用 `navigator.locks` 或网关侧 seq 抢占，M5 可加，但不改本节接口）。已知风险登记在 §9。
6. **执行来源**：动作执行只发生在**浏览器页面**内（录制缓冲在页面内存里）；页面关闭时网关仍可被 `/api/action/events` 外部消费，但"录制"不会发生。这是本契约的明确边界，不假装网关能替页面录制。

### 5.7 「API 文档」弹窗

卡片右下角按钮打开一个模态（纯前端，不发网络请求）：内容 = 本文 §4 的接口表 + 三个 200 示例 + 一句"只读、仅 GET/HEAD、长轮询超时返回 200 ok:false"的提示。文案必须与本节一致；接口变更时先改本文件再改弹窗（文档是权威）。

---

## 6. CRC 顺序约束（RTL 证据）

### 6.1 现状证据（【实测】逐行读码）

| 事实 | 位置 |
|---|---|
| v3 包头 24 B，`offset 23` 在 `hdr_byte()` 里落到 `default: 8'h00` | `src/rtl/comms/udp_merge.v:457-485`（default 在 :478-485）；`HEAD_BYTES = IS_V3 ? 24 : 13` 在 :146 |
| CRC-16/CCITT-FALSE：poly `0x1021`、init `0xFFFF` | `udp_merge.v:439-450`；复位 `crc_idx<=0`、`crc_reg<=16'hFFFF` 在 :543-544 |
| **头字节与 CRC 累加在同一拍**：`o_tx_byte<=hdr_byte(hdr_idx); crc_reg<=crc16_step(crc_reg, hdr_byte(hdr_idx));` | `udp_merge.v:655-656`（发头字节处） |
| RAW 段累 CRC（:670/:678）、事件段累 CRC（:691） | 同上 |
| CRC 在 `S_CRC` 先发高字节（:713）再发低字节（:717） | `udp_merge.v:696,709-717` |
| **`eth_udp.v` 不含任何 CRC 逻辑**（`grep -i crc` 零命中）——CRC 全部在 `udp_merge` | `src/rtl/comms/eth_udp.v` 全文 |
| MTU 红线：`i_tx_len > MAX_TX_LEN` 截断（H35），超 MTU 会丢 CRC | `eth_udp.v:28`；`udp_merge.v:58` 注释、`PC_IP` :47、`MAX_TX_LEN` :51 |
| 上位机侧 CRC 覆盖 `[0 .. 24+RAW+EV-1]`（含 byte23），失败整包弃 | `host/app/packages/protocol/src/codec/v3.ts:141-147` |

### 6.2 结论与禁令

**结论**：在现有发送 FSM 中，`hdr_byte()` **先返回**该字节，同一拍就把它送进 `crc16_step`，所以"**先写 offset 23、再算 CRC**"在结构上天然成立——M4 只需把 `5'd23` 分支的返回值改成锁存的 `action_byte_q`（当前是 default `0x00`），**CRC 通路一行都不用改**。【实测/推断】

**禁令（M4 评审必查）**：

1. 禁止在 CRC 已累加完成之后（`S_CRC` 前）再"补写/覆盖"`o_tx_byte` 的第 23 字节——CRC 与线上字节会不一致，上位机 `crcFail` 整包丢弃。
2. 禁止绕过 `hdr_byte()` 在发送路径外侧单独塞 byte23；所有头字节必须走同一函数，保证 CRC 与发送字节同源。
3. 禁止为放动作字段扩大包头（`HDR_LEN` 保持 24）或加大单包——MTU 截断（`eth_udp.v:28`、`udp_merge.v:58`）会直接丢 CRC。
4. 同一帧的所有分片包 byte23 必须相同（§2.5 的每帧锁存）。

### 6.3 验收判据（M4）

- 抓包命中 `byte23=0xA1` 的数据包，用 `parseV3Packet` 解析：`ok=true`、`crc16Present=true`、无 `crcFail` 计数。
- 600 包/帧中随机抽 20 包，同一 `frameIdx` 的 byte23 全等。
- 旧固件（byte23=0x00）抓包回放：解析与 CRC 行为逐字节不变（回归）。

---

## 7. 实施清单（M4 / M5）

| 层 | 改动 | 必测 |
|---|---|---|
| RTL（M4） | `udp_merge.v`：新增 `action_byte_q`（帧起始锁存）+ `hdr_byte(5'd23)` 分支；`downlink_cmd.v`：GET_STATUS ACK 尾追 TLV 0x92，CTRL_LEN 68→71 | 抓包 CRC 全过、同帧一致、旧帧回归（§6.3） |
| 协议包（M5） | `constants.ts` 增 `ACTION_TLV=0x92`、`CTRL.LEN.GET_STATUS_ACK_ACT=71`；`ParsedV3` 增 `actionByte`（可选字段，缺省 `undefined`）；`decodeActionState/encodeActionState` | 单测：0x00/0xA1/0xFF 解码、CRC 含 byte23、旧 68 帧兼容 |
| 网关（M5） | `api.ts` 三端点 + `ActionStore`（最新结果 + 64 条事件环 + 长轮询）；`ENDPOINTS` 登记；`ApiContext` 注入 action store；WS `config.set` 接受 `actionMap` 键并在 `/api/action/config` 回显 | 405/404/503/超时 200、after 语义、dropped、source 切换 |
| 前端（M5） | `sidebar.ts:1074` 前插卡片；`actionMap` 读写/校验模块；动作执行调 `setRecording`（`main.ts:1365`）+ `exportNow`（`main.ts:1609`）；API 文档弹窗 | 边沿触发/防抖、minConf、class0 不执行、首调不执行历史、停止后自动导出一次、缓冲清空提示 |

---

## 8. 契约判据（可执行）

| ID | 判据 | 方法 |
|---|---|---|
| C-1 | 位分配唯一：`decodeActionState(0xA1) = {valid:true, conf:8, cls:1}`，`encodeActionState` 逆变换一致 | 单测（§2.2 实现） |
| C-2 | 旧 v3 帧（byte23=0x00）与新帧（byte23=0xA1）都能 `parseV3Packet ok` 且 CRC 通过 | 单测用真实包长/CRC 构造 |
| C-3 | TLV 0x92 = tag`0x92`+len`1`+byte23，且只出现在 GET_STATUS ACK；CTRL_LEN=71 全包 103 B；心跳仍 25、SET_PARAM 仍 26 | 构造/解析双向单测 + 抓包 |
| C-4 | `/api/action` 200/503/available:false 三态字段齐全，`mapped` 随 actionMap 变化 | 网关单测（注入假 store） |
| C-5 | `/api/action/events`：`after=-1` 有事件立即返回最新 1 条；`timeoutMs=0` 立即超时且 200；`after` 落后返回 `dropped>0`；`seq` 升序、≤32 条 | 网关单测 |
| C-6 | 三个接口非 GET/HEAD 一律 405；未知子路径 404；`ENDPOINTS` 能列出 | 单测 |
| C-7 | `actionMap` 写入/读回 schema 一致；坏 JSON/坏枚举回落默认且可观测（toast 文案存在） | 前端单测（jsdom/纯函数） |
| C-8 | 动作执行只调 `setRecording`，且 startAndAutoExport 在停止后调用一次导出；首调 after=-1 不执行 | 前端单测/代码审查（grep 唯一入口） |
| C-9 | RTL 抓包：同 frameIdx 的 byte23 全等；`parseV3Packet` 无 crcFail | M4 上板（§6.3） |

---

## 9. 遗留与风险

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | 网关重启后 `/api/action/config` 退化为 `source:"default"`（持久化在浏览器） | 外部脚本可能读到默认映射 | 文档已写明；M5 若需要进程级持久化，另立契约（不在本版） |
| R2 | 多标签页各自执行动作 | 同一动作可能触发两次录制操作 | 幂等 `setRecording` 缓解；跨页互斥留 M5+ |
| R3 | 动作分类器 10 Hz、画面 3.3 fps：byte23 的更新粒度受帧约束 | 动作触发延迟 ≤300 ms + 分类延迟 | 可接受（M0 §4.3 建议节拍）；卡片显示 500 ms 轮询 |
| R4 | `startRecord` 触发会清空未导出缓冲（`main.ts:1369`） | 用户可能丢上一段 | 卡片文案明示；`startAndAutoExport` 在停止时自动导出降低风险 |
| R5 | `statsOnly` 无现成导出器 | M5 需新增轻量统计导出 | 已冻结语义，不改既有 5 个导出器 |
| R6 | 分类器 v1 的 CONF 语义（0..31）尚无标定 | 阈值 8 只是起点 | M0/M5 用现场数据标定；本契约只冻结位宽 |

---

## 10. 参考

1. [04_action_recognition_selection.md](04_action_recognition_selection.md)（M0，2026-10-29；offset23 位分配与 CRC 约束的初稿）
2. v3线协议设计.md（文件 ../05_实验与实测/协议v3设计_20261009/v3线协议设计.md，未随包发布）（WIRE-V3 冻结设计；§2.1 包头、§6.2 ACK/CTRL、§6.3 TLV）
3. 04_动作识别调研_20261029.md（文件 ../07_调研与审阅/04_动作识别调研_20261029.md，未随包发布）（M0 调研与引用）
4. `host/app/packages/protocol/src/constants.ts`（`OFF3`/`FLAGS3`/`CTRL`/`LIMITS3`）
5. `host/app/packages/protocol/src/codec/v3.ts`（`parseV3Packet`，CRC 覆盖整包）
6. `host/app/gateway/src/ipc/api.ts`（只读 API 口径、405/404/长轮询范式）
7. `host/app/gateway/src/pipeline/latest.ts`（`waitFrame` 长轮询实现）
8. `host/app/web/src/main.ts`（`setRecording` 唯一入口、导出入口）
9. `host/app/web/src/export/render.ts` / `registry.ts`（导出目标与导出器登记表）
10. `host/app/web/src/ui/sidebar.ts`（卡片挂载点）
11. `src/rtl/comms/udp_merge.v`（`hdr_byte`、CRC 累加顺序）
12. `src/rtl/comms/eth_udp.v`（无 CRC、MTU 截断、`PC_IP`）

---

## 11. 长录接口与文件布局（v1.3 增补）

> 来源：2026-10-30 实现与实测（task-30/31/32/35），详见 长录与标注 REPORT（文件 ../05_实验与实测/长录与标注_20261030/REPORT.md，未随包发布） 与同目录证据日志。本节只冻结**上位机侧**长录 HTTP/文件契约，不改 §2~§6 的线协议、TLV 与 CRC。

### 11.1 定位：与 §5.5 的浏览器缓冲录制不是同一件事

| | §5.5 浏览器缓冲录制 | 本节长录（gateway recorder） |
|---|---|---|
| 运行位置 | 浏览器页面内存 | 网关进程内（Node + ffmpeg 子进程） |
| 触发 | 动作卡片 / 页面按钮 | `--record` 启动即开录，或 `POST /rec/start` |
| 关闭浏览器 | 停止/丢失 | **不中断**，继续写盘 |
| 产物 | 页面导出（mp4/csv 等） | `records/<session>/chunk-00N.*` 分段落盘 |
| 用途 | 短片段回看/导出 | 长时间连续采集 + 标注 |

要点：长录**不经过浏览器缓冲**，与 §5.5 的 `setRecording` 互不影响；两者可以同时存在。网关无论是否带 `--record` 都挂载 `/rec/*`，区别只是启动时是否自动开录。

### 11.2 HTTP 接口（只有 3 个）

| 方法 | 路径 | 成功 | 失败 |
|---|---|---|---|
| GET / HEAD | `/rec/status` | 200 `{ok:true, ...RecorderStatus}` | 405 + `Allow: GET, HEAD` |
| POST | `/rec/start` | 200 `{ok:true, ...RecorderStatus}` | 400 参数/JSON 非法；409 已在录；413 body > 64 KB；500 启动失败 |
| POST | `/rec/stop` | 200 `{ok:true, ...RecorderStatus}`（幂等） | 405 + `Allow: POST`；500 停止失败 |

- `/rec/start` body 可省略或 `{"label":"..."}`；`label` 为字符串，trim 后长度 1..64，禁止 `\ / : * ? " < > |` 与控制字符；**未知字段一律 400**（不做静默忽略）。
- `/rec/status` 不缓存（`Cache-Control: no-store`）；未知 `/rec*` 路径 404。
- 错误响应统一 `{ok:false,error:"..."}`；成功响应把 `RecorderStatus` 平铺在 `ok` 旁。

### 11.3 `RecorderStatus` 字段

```ts
{
  active: boolean;
  session: string | null;        // 当前/最近会话目录名
  root: string;                  // 录制根目录（默认 E:/workspace/FPGA_Comp/records）
  startedAt: string | null;      // ISO
  endedAt: string | null;        // ISO；录制中为 null
  reason: string | null;         // "api" | "signal" | "ffmpeg_failed" | "disk_low" | ...
  chunk: RecorderChunkView | null;
  chunks: RecorderChunkView[];   // 已开始过的 chunk（含当前）
  counters: {
    frames: number;              // 收到的帧
    events: number;              // 收到的事件
    droppedFrames: number;       // 背压队列满丢弃
    droppedEvents: number;
    bytes: number;               // 原始帧字节（800*480*2 = 768000 B/帧）
  };
  durationMs: number;
  bytesVideo: number;            // 已封口 chunk 的 videoBytes 之和 + 当前 .recording.mp4 实时体积
  diskFreeBytes: number | null;  // 录制根盘可用字节；首次 statfs 采样前 null，之后约 10 s 缓存
  ffmpeg: { path: string; restarts: number; lastError: string | null; pending: number };
}
```

`RecorderChunkView` 含 `index, video, events, frames, framesWritten, eventsWritten, fragBytes, videoBytes, finished, sealError`。**UI 必须区分两个体积**：主行显示 `bytesVideo`（视频文件实际大小），原始量 `counters.bytes` 只作次行参考；二者不能混算，也不能用 `counters.bytes` 冒充视频大小。

### 11.4 目录与分段

```text
<root>/<session>/
  meta.json
  chunk-000.video.mp4          # 封口后的可播放视频（-c copy +faststart）
  chunk-000.events.csv
  chunk-000.frames.csv
  chunk-000.labels.json        # 标注工具写，可选
  chunk-001.* ...
  # 录制中当前段是 chunk-00N.recording.mp4；封口成功后改名为 .video.mp4
```

- 默认每 5 分钟切一段（`--record-chunk-min` 可改）；切段先开新 chunk，再后台封口旧 chunk，不阻塞采集。
- 编码：原始 `rgb565be` 800×480 → libx264 `veryfast/zerolatency/crf 23`，容器 30 fps；分段封口用 `-c copy -movflags +faststart`。
- ffmpeg 异常只自动重开一次；第二次失败则 `stop("ffmpeg_failed")`，不无限重启。`ffmpeg.restarts` 可观测。
- `meta.json` 在每次 chunk 封口/停止时串行更新：`{version:1,session,startedAt,endedAt,profile,fpsNominal:30,chunks:[{index,video,events,frames,fragBytes,videoBytes}],counters:{...},reason?}`。

### 11.5 CSV 列（冻结）

- `chunk-00N.events.csv`：`frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts`（8 列，CRLF；无事件时也写表头）。
- `chunk-00N.frames.csv`：`frame_idx,t_board_ms,t_arrive_ms`（3 列，CRLF；每收到一帧写一行）。
- `frame_idx` **每个 chunk 内从 0 严格递增**，不是全局帧号；跨 chunk 用 `session + chunk + frame_idx` 定位。
- 同一帧的事件共用 `frameTimeBase = t_board_ms ?? t_arrive_ms`，`frame_t_ms` 由该帧时间基换算，保证同帧事件可归组。

### 11.6 时间对齐铁律（务必遵守）

**唯一权威是 `frames.csv` 的 `frame_idx ↔ t_board_ms`；视频容器里的 30 fps 只是标称播放速率，不是真实采集节拍。**

- 实测（2026-10-30，`--synth` 60 s）：实际 1312 帧（≈21.87 fps），容器固定 30 fps ⇒ 视频时长 43.733333 s，**时长短 27.1%、等效播放快 37.2%**。
- 真实板卡约 26.7 fps ⇒ 同一容器**时长短 11.0%、等效播放快 12.4%**。
- **用 ffmpeg `-ss` 从 `.video.mp4` 抠图时，目标秒数要按 `26.7/30 ≈ 0.889` 换算**（板卡秒 → 容器秒）；反向把容器时长换算回板卡时长要乘 `30/26.7 ≈ 1.124`。这是 2026-10-30 长录实测陷阱，不适用于 `--synth`（21.87 fps，系数更小）。
- 因此：**禁止**用 `video.currentTime` 或容器时长反推板卡时间；标注/评测/训练一律用 `frames.csv.t_board_ms`（标注工具内部用相对首帧偏移，写盘时换算回绝对板卡毫秒）。

### 11.7 `labels.json` v1（标注工具产物）

```json
{
  "version": 1,
  "session": "20261030-205305_rec",
  "chunk": 0,
  "fpsNominal": 30,
  "types": [{ "id": 0, "name": "无动作", "color": "#888888" }],
  "segments": [{
    "id": "seg-...",
    "startMs": 1793364786542,
    "endMs": 1793364790123,
    "startFrame": 12,
    "endFrame": 45,
    "typeId": 1,
    "note": ""
  }],
  "updatedAt": "2026-10-30T21:00:00.000Z"
}
```

- `types[].id=0` 固定为「无动作」，不可删除；类型上限 10 个（含 0）。
- `startMs/endMs` 是**绝对板卡毫秒**（等于 `frames.csv.t_board_ms` 刻度，首帧通常不是 0）；`startFrame/endFrame` 是该 chunk 的 `frame_idx`。
- 缺失/损坏的 labels 由工具重建默认值；保存失败不静默丢，页面顶部红条可重试。
- 导出 `chunk-00N.segments.csv`：`id,startMs,endMs,startFrame,endFrame,typeId,typeName,note`（UTF-8 无 BOM，CRLF）。

### 11.8 标注工具（annotator）

- 零 npm 依赖，纯 Node 内置模块 + 原生 JS/canvas/video，不进 workspace 构建。
- 启动：`cd host/app/tools/annotator && node server.mjs`（或双击 `打开标注.bat`）；默认 `http://127.0.0.1:8790`。
- **只绑 127.0.0.1**，端口 8790 可改；明确禁用 1234/8787（用户实时链路）。
- 默认根 `E:\workspace\FPGA_Comp\records`，`--root` 可改；`--no-open` 不自动开浏览器。
- 快捷键：Space 播放/暂停、←/→ 逐帧、S 切分、Delete 删除、Ctrl+S 保存、Alt+1..9 赋类型；改动 800 ms 防抖自动保存。

### 11.9 验收判据（2026-10-30 实测）

| 判据 | 方法 | 结果 |
|---|---|---|
| `REC_CORE_OK=1` | `record_unit.test.ts` + `record_api.test.ts` | 18/18 pass |
| `WEB_REC_UI_OK=1` | `web/test/rec_ui.test.ts` | 13/13 pass |
| `REC_INTEGRATION_OK=1` | 真 ffmpeg 3 s/60 s E2E | 60 s 样本 1312 帧 / 46,767,466 B / 0 dropped |
| `ANNO_CORE_OK=1` | annotator 四套（core/http/realdata/browser） | 30+10+8+10 全过 |

证据：`EVIDENCE_REC_CORE.log`（文件 ../05_实验与实测/长录与标注_20261030/EVIDENCE_REC_CORE.log，未随包发布）、`EVIDENCE_REC_LIVE.log`（文件 ../05_实验与实测/长录与标注_20261030/EVIDENCE_REC_LIVE.log，未随包发布）、`EVIDENCE_REC_UI_BYTES.log`（文件 ../05_实验与实测/长录与标注_20261030/EVIDENCE_REC_UI_BYTES.log，未随包发布）、`evidence_anno.log`（文件 ../05_实验与实测/长录与标注_20261030/evidence_anno.log，未随包发布）。

---

## 12. 变更记录

| 版本 | 日期 | 变更 | 影响 |
|---|---|---|---|
| v1.0 | 2026-10-29 | 初版冻结：byte23 位分配、TLV `0x92`、三只读 API、`actionMap` schema、CRC 顺序 | M4/M5 实现依据 |
| v1.1 | 2026-10-29 | 类别语义定案（随 M4 落地，task-14）：`0` 无动作（含板移等无动作窗）/ `1` 手部开合（原"握拳→张开""张开→握拳"两方向合并，任一方向均报 class 1）/ `2` 横向挥手 / `3` 保留；卡片与 API 的 `className` 同步；解码实现名落地为 `decodeActionState/encodeActionState` | 旧 v1.0 文档与历史证据日志里的"握拳→张开 / 张开→握拳"文案作废；**线格式与接口不变**，class1 不再区分方向，旧上位机无感 |
| **v1.2** | **2026-10-30** | 本轮 4 条：① §2.5 增加 **1.0 s 空窗清零**（`ACT_IDLE_CYC=50_000_000 @50 MHz`，VALID 回 0，TLV 0x92 同步）；② 明确“一次检测 = 一次 VALID 上升沿”，板侧电平保持不再导致重复动作只计 1 次；③ §4.2 事件增加 `reason`（`valid_rise` / `class_change`）；④ §4.1 `/api/action` 增加累计 `count`（只增不改） | **线格式、帧长、TLV len=1/ACK 103 B 均不变**；旧上位机按 CLASS 变化事件仍可工作；新增字段为增量。class2 横向挥手仍为实验性、未部署，详见登记册 D16 |
| **v1.3** | **2026-10-30** | 新增 **§11 长录接口与文件布局**：`/rec/start`、`/rec/stop`、`/rec/status` 三接口，`RecorderStatus`（含 `bytesVideo`/`diskFreeBytes`/`ffmpeg.restarts`）、`meta.json`、`events.csv` 8 列、`frames.csv` 3 列、时间对齐铁律、`labels.json` v1 与 annotator 用法/端口；原变更记录顺延为 §12 | **只增上位机侧契约，不改线协议/TLV/CRC**；长录在网关进程内，与 §5.5 浏览器缓冲录制并存且互不影响 |

---

CONTRACT_OK=1
