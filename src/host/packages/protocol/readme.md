# @retina/protocol —— 冻结契约（M1 期间不要改这里）

> **这是上位机里唯一"不许各自实现"的地方**（设计原则 **P1**）：协议编解码只写一份，网关与前端共用。
> 权威依据：[../../docs/02_通信协议对齐.md../../../../docs/02_通信协议对齐.md)（线格式）+ [../../docs/04_后端设计.md../../../../docs/04_后端设计.md)（IPC）。

## 1. 已经冻结的东西（**只读**）

| 文件 | 内容 | 状态 |
|---|---|---|
| <code>src/constants.ts</code> | 全部偏移量/魔数/上限/计数器名/图层 z 序/IPC 头 | ✅ 冻结 |
| <code>src/types.ts</code> | <code>Profile / FramePacket / EventRecord / Counters / ParseResult &lt;T&gt;</code> … | ✅ 冻结 |
| <code>src/profile.ts</code> | <code>validateProfile()</code> + 4 个内置 profile + <code>formatProfileError()</code> | ✅ 冻结 |
| <code>src/ipc.ts</code> | <code>encodeIpc() / decodeIpc() / RPC_METHODS</code>（16B 首部，大端） | ✅ 冻结 |
| <code>src/counters.ts</code> | <code>createCounters() / bump() / gapOf() / FrameIndexUnwrapper</code> | ✅ 冻结 |
| <code>src/rtpkt.ts</code> | 回放容器 <code>encodeRtpkt() / iterRtpkt() / countRtpkt()</code>（**纯内存**，别在这里 import node:fs） | ✅ 冻结 |
| <code>src/interfaces.ts</code> | 五个插槽 <code>IFrameSource / ICodec / IPostProcessor / IExporter / IRecorder</code> | ✅ 冻结（SPI v1） |
| <code>src/codec/*</code> | <code>parseV2Packet / parseV1Packet / decodeEvents / parseTelemetry / crc8 / crc16 / decodeRgb565</code> | 🔶 **Lead 实现中**，签名见 §2 |

> ⚠️ **并行纪律**：其它工作流（gateway / web / tools）**不得**修改本包任何文件。
> 需要新增能力 → 找 Lead，由 Lead 在 package 内加。

## 2. 协议层函数签名（已冻结，先照签名写代码）

<pre>
// src/codec/crc.ts
export function crc8(data: Uint8Array, init?: number): number
export function crc16(data: Uint8Array, init?: number): number

// src/codec/v2.ts —— UDP v2（udp_merge）
export interface ParseV2Options { readonly profile: Profile; readonly strictCrc?: boolean }
export function parseV2Packet(buf: Uint8Array, opts: ParseV2Options): ParseResult&lt;ParsedV2&gt;

// src/codec/v1.ts —— UDP v1（例程 60：首包 10B 头 + 各 1280B 数据）
export interface V1Ctx { readonly profile: Profile; readonly expectChunk: number | null }
export function parseV1Packet(buf: Uint8Array, ctx: V1Ctx): ParseResult&lt;ParsedV1&gt;

// src/codec/events.ts —— EV_DATA → EventRecord[]
export interface DecodedEvents { readonly records: readonly EventRecord[]; readonly partialBytes: number; readonly raw: Uint8Array }
export function decodeEvents(data: Uint8Array, recBytes: number): DecodedEvents

// src/codec/telem.ts —— UART
export function parseTelemetry(payload16: Uint8Array): ParseResult&lt;Telemetry&gt;   // 载荷小端
export function parseTeleFrame(header5: Uint8Array): { w: number; h: number; mode: number } | null   // W/H 大端

// src/codec/rgb565.ts
export function decodeRgb565(raw: Uint8Array, rgba: Uint8ClampedArray, byteOrder: "BE" | "LE"): void
</pre>

## 3. 关键判据（会被测试逐条查）

| # | 判据 | 出处 |
|---|---|---|
| P1 | 包长自洽：<code>len == 13+RAW_LEN+EV_LEN</code>（无 CRC）或 <code>…+2</code>（有 CRC）；两者都不符 → <code>badLength</code> | 02 §2.2 |
| P2 | <code>len &gt; 1472</code> → <code>oversize</code>；声明长度 &gt; 实到字节 → <code>truncated</code> | H35 |
| P3 | <code>SEG_MASK</code> 与 <code>RAW_LEN&gt;0</code> 不一致时**以 SEG_MASK 为准**并计 <code>segInconsistent</code> | 02 §2.2 |
| P4 | <code>SEG_MASK</code> 保留位非 0 → 只记 <code>segNotice</code>，**不报错**（前向兼容） | 02 §2.2 |
| P5 | 事件记录长度**参数化**；<code>EV_LEN % recBytes ≠ 0</code> → 丢余数并计 <code>evPartial</code>，绝不错位整包 | 02 §2.4 |
| P6 | 保留位（x[8] 之外的位、POL 高位、TS8）**一律忽略**，只取 x/y/pol | 02 §2.4 |
| P7 | 整数一律**大端**（v1 的 W/H 也是大端）；UART 遥测载荷是**小端** | 02 §1/§5 |
| P8 | v1 与 v2 **魔数相同**（缺口 G6）⇒ 不能用魔数区分版本，必须靠 profile | 02 §7 G6 |
| P9 | 解析失败必须返回 <code>{ok:false, reason:&lt;计数器名&gt;}</code>，**不许抛异常** | P6 原则 |
| P10 | 不改输入缓冲（<code>subarray</code> 可以，但不得写入） | 原则 P2 |

## 4. Golden 向量契约（tools 产出，protocol/gateway/tools 共同消费）

路径：<code>host/testdata/golden/&lt;id&gt;.rtpkt</code>（RTPKT 容器）+ <code>&lt;id&gt;.expected.json</code>

<pre>
{
  "id": "g01_min_frame",
  "profile": "retina-v2-800x480-e5",
  "description": "一帧 750 包、无事件",
  "packets": 750,
  "expect": {
    "frames": 1,
    "frameIdx": [1],
    "bytesRaw": 768000,
    "eventCount": 0,
    "counters": { "aborted": 0, "badMagic": 0, "badLength": 0, "evPartial": 0 }
  },
  "rawSha256": "…"      // 完整帧的 sha256（十六进制）；帧不完整时为 null
}
</pre>

**七个**向量（02 文档 §10 + 缺口 G3 与重复块口径）：

| 向量 | 包数 | 钉住的判据 |
|---|---|---|
| <code>g01_min_frame</code> | 750 | 整帧逐字节一致（sha256）+ 无事件 |
| <code>g02_ev_only</code> | 2 | 纯事件包（SEG_MASK=0b10，G3）+ 事件真值逐条 + evPartial |
| <code>g03_drop_chunk</code> | 749 | 缺块 ⇒ <code>aborted=1</code>、零帧、不错位 |
| <code>g04_wrap</code> | 2 | FRAME_IDX 回绕 ⇒ <code>idxGap=0</code>、<code>aborted=2</code>（换帧 + flush 两次结算） |
| <code>g05_bad_crc</code> | 4 | CRC16 末包被拒 ⇒ <code>crcFail=1</code>、bytesRaw 只含好包 |
| <code>g06_legacy</code> | 600 | v1（例程 60 格式）大端 H/V + 1280B 顺序拼接 |
| <code>g07_dup_chunk</code> | 3 | 重复块 ⇒ <code>dupChunk=1</code>、**重复包仍计入 bytesRaw**（与 packets 对账）、<code>aborted=1</code> |

### 4.1 语义冻结（2026-10-03；三边一致：golden-tools 产出 / gateway 消费 / protocol 判定）

| 项 | 冻结定义（**唯一解释**） |
|---|---|
| <code>frames</code> | **完整交付**的原始帧数；缺块未凑齐的帧**不算** |
| 完整性判据 | v2：已接受且去重的 <code>CHUNK_IDX</code> 数 == <code>profile.chunksPerFrame</code>；LEGACY：首包起顺序拼满 600×1280 |
| <code>aborted</code> | **只统计声明了原始段（SEG_MASK.bit0=1）的未完成帧**：超时（<code>FRAME_TIMEOUT_MS</code>）或**流结束 flush** 时结算 +1 |
| 纯事件包 | <code>SEG_MASK=0b10</code> **不参与原始帧生命周期**：不计 aborted、不占 <code>CHUNK_IDX</code>；事件按 <code>FRAME_IDX</code> 归批，帧号切换或 flush 时作为 <code>EVENTS</code> 批次下发 |
| <code>bytesRaw</code> | **通过校验（magic/长度/CRC/MTU 全过）的包**的 <code>RAW_LEN</code> 之和。⚠️ ① 被拒包**不计入** ② **事件字节（EV_LEN）不计入**（单独计 <code>bytesEvents</code>）③ **重复块（同 CHUNK_IDX 二次到达）要计入**并同时记 <code>dupChunk</code> —— 理由：<code>stats.packets</code> 也把重复块算作"被接受"，两者必须能对上账；重复块是异常，**统计上要暴露而不是隐藏** |
| <code>eventCount</code> | 解码出的记录总数；每包的余数丢弃每次计 1 个 <code>evPartial</code> |
| <code>packets</code> | **容器里实际的包数**；测试必须校验它 == <code>iterRtpkt</code> 数出来的数量 |
| 网关侧 <code>stats.packets</code> | **被接受**的包数 = 容器包数 − 被拒包数（badMagic/badLength/oversize/truncated/crcFail）。⚠️ 与 expected 的 <code>packets</code> **不是同一个量**，别直接比 |
| <code>counters</code> | **子集比对**：只比较列出的键且要求严格相等；未列出的键不参与断言。每个向量必须列出与其缺陷相关的计数器 |
| <code>rawSha256</code> | 完整帧字节的 sha256（十六进制小写）；帧不完整时为 <code>null</code> |
| 事件真值 | 需逐条核对事件坐标/极性时，额外产出 <code>&lt;id&gt;.events.json</code>（<code>[{"x":..,"y":..,"pol":..}]</code>）；**不要把真值写死在代码里** |

## 5. 怎么跑测试（**零测试依赖**）

<pre>
cd host/app
npm test                 # 全部（protocol + gateway + tools）
npm run test:protocol    # 只跑协议层
</pre>

Node 24 原生执行 <code>.ts</code>（类型剥离），不需要 jest/vitest/tsx。
写法要求：**只用可擦除语法**（禁 <code>enum</code> / 命名空间 / 参数属性），类型导入用 <code>import type</code>。
