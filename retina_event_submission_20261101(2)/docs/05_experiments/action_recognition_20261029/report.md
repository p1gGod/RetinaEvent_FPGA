# M4 上位机动作回传 — 实施报告

- 任务：task-10（M4 上位机动作回传）
- 负责人：host（上位机/前端）
- 日期：2026-10-29（Asia/Shanghai）
- 仓库：E:/workspace/FPGA_Comp，上位机根 E:/workspace/FPGA_Comp/host/app
- 权威契约：docs/03_tech/05_action_uplink_contract.md
- 结论：**四条自动判据全部成立**（见 §1）。浏览器人工验收 3 项尚未执行（见 §5），不计入通过。

## 1. 判据总表

| 判据 | 结果 | 关键数字 | 证据 |
|---|---|---|---|
| PROTO_OK | **1** | 新增协议单测 14/14 通过（要求 >=8） | EVIDENCE_PROTO.log |
| API_OK | **1** | 合成 v3 注入 E2E 21/21 检查 PASS；真实 curl 4 接口；网关单测 15/15 | EVIDENCE_API.log |
| UI_OK | **1** | web 构建退出码 0；actionmap 单测 24/24；web 全量 237/237 | EVIDENCE_UI.log |
| 全量回归 | **1** | npm test 610/610，27 suites，0 fail；typecheck 0；web build 0 | EVIDENCE_PROTO.log / EVIDENCE_UI.log |

补充说明：

- API_OK 的"合成 v3 注入"由 /tmp/action_e2e.ts 完成：dgram 发 600 段全帧（800×480×2=768000 B，CHUNK=1280），再以 fetch 断言 21 项；随后用真实 curl 对运行中的网关抽查 4 个接口（含 POST→405 gitbash 退出码 0）。E2E 退出时 E2E_RESULT=PASS checks=21 fails=0。
- 判据都只依赖自动化命令；未把"人工未执行"伪装成通过。
- 所有证据文件位于 docs/05_experiments/action_recognition_20261029/。

## 2. 实现概要

### 2.1 协议层（byte23 + TLV 0x92）

- host/app/packages/protocol/src/constants.ts:43 新增 OFF3.ACTION=23；:45 保留 RSVD=23 兼容别名。
- 同文件 :71-76 新增 ACT3 = { VALID:1<<7, CONF_SHIFT:2, CONF_MASK:0x1f, CLASS_MASK:0x03 }。
- 同文件 :84 ACT_CLASS_NAMES = ["无动作","握拳→张开","张开→握拳","保留"]。
- 同文件 :276 新增 CTRL.TLV.ACTION_STATE=0x92（len=1，只随 GET_STATUS ACK 尾追；注释同步 CTRL_LEN 68→71 的板端登记）。
- host/app/packages/protocol/src/codec/v3.ts:59-66 decodeActionState(raw)：入参先 &0xff，返回 {valid,conf,class}；全 0 包也安全，永不抛错。
- 同文件 :72-76 encodeActionState：测试/联板自检用，越界 conf/class 夹值。
- parseV3Packet 仍未消费 byte23（A12 用例钉住既有行为）：协议层只提供"读字节"，不改变包长/既有解析。
- TLV 0x92 已登记为已知 tag，不再触发 ctrlReq 误判；A13/A14 覆盖 len=1 与 len≠1 两种形态。

### 2.2 网关（采集、事件环、三个只读接口）

- host/app/gateway/src/action.ts（新增）：
  - actionRawOfPacket(buf,pkt)：CTRL 包 TLV 0x92 len=1 优先，否则读 buf[OFF3.ACTION]；TLV 是 GET_STATUS ACK 的显式快照真值。
  - ActionStore：快照 + 64 条事件环（单页 32），事件只在 valid=true 且 class 与上一条事件不同时生成；valid=false 只更新快照；不触发任何执行。
  - normalizeActionConfig：校验 v/minConf/map.action/map.target；非法输入抛明确错误（WS 回 -32602），不静默改写。
  - setConfig 后按新映射重算已缓存快照/事件的 mapped，避免改完映射 API 还显示旧动作。
- host/app/gateway/src/pipeline/processor.ts:86-89：每个成功解析的 v3 包调用 actionStore.observe(...)；位置在 CTRL 分支之前，保证 GET_STATUS ACK 也能更新快照。
- host/app/gateway/src/ipc/api.ts:274 起：/api/action（快照）、/api/action/events（长轮询，after/timeoutMs，timeout=true 非错误）、/api/action/config（镜像）。无完整帧时 /api/action 与 events 返回 503 + reason；未知 /api 子路径 404 + endpoints 清单。
  - 快照除契约 §4.1 字段外，另给任务书 API_OK 列的兼容镜像：seq（最近事件 seq，0=还没有事件）、tMs（=快照 tArriveMs，不可判定时 null）、source（=config.source）。三字段是超集、不改变契约字段语义；契约消费者可忽略。
- host/app/gateway/src/ipc/ws.ts：config.set 接受 actionMap（仅该键，校验 v===1）；config 快照带上 actionMap，供前端恢复镜像。
- host/app/gateway/src/ipc/http.ts:66-88：把 /api/* 分派移到 method 检查之前。非 GET/HEAD 的 /api 请求由 api.ts 回契约 §4.0 的"本接口只读：仅支持 GET/HEAD"；静态文件路径仍回旧的"只支持 GET/HEAD"。**405 状态码与正文均符合契约。**
- 路由落点偏差：任务书白名单说"在 gateway/src/ipc/http.ts 挂 3 个 GET 路由"，但本仓库既有 /api 路由层在 gateway/src/ipc/api.ts（http.ts 只做入口）。实际 3 个 GET 实现在 api.ts，该文件不在任务书白名单；未改 gateway/src/main.ts（曾尝试注入 ApiContext.action，因白名单已完整回退，git diff 为空）。**请求 Lead 判定此偏差是否接受。**

### 2.3 前端（动作卡片、映射、localStorage、API 文档）

- host/app/web/src/actionmap.ts（新增，纯逻辑、storage 注入）：
  - 常量 ACTION_MAP_STORAGE_KEY="actionMap"（:40）、ACTION_MIN_INTERVAL_MS=1000、ACTION_SAME_CLASS_HOLD_MS=10000、ACTION_TARGET_EXPORTER（raw→rawbin / events→csv / overlay→pngzip / statsOnly→null）。
  - loadActionMap/saveActionMap：损坏、版本不符、storage 不可用均回落默认 + warning；save 重新校验并把 updatedAtMs 设为 nowMs。
  - shouldTrigger：valid && class∈{1,2} && conf>=minConf && 与上次类别不同 && 间隔>=1000ms；class3 永不触发。
- host/app/web/src/ui/sidebar.ts：动作卡片 cA 插在运动预测 cM 之后、渲染图层栈 c4 之前（:1217 root.insertBefore(cA.card, c4.card)，运行时 DOM 顺序 c3→cM→cA→c4）；三行控件（类别 0/1/2 的 action+target、minConf 0..31、结果/状态/API 文档按钮）；结果行右侧有「计数 N」chip（本页打开以来 VALID=1 且 class1/2 的事件数，本地累计，见 main.ts :1875；契约没有 count 字段，不新增 API 字段）；class0 的 action 固定 none 且 disabled；控件 600ms 内不回写避免抢焦点。
- host/app/web/src/main.ts：
  - :290 启动读取 localStorage（损坏 warning toast）；:1917 改动后 saveActionMap + WS config.set；失败 toast，不静默。
  - :2128 startActionPolling：500ms 快照 + 10s 长轮询；document.hidden 暂停；恢复后重置游标。
  - :1820 runActionEventsLoop：首次/恢复 after<0 只对齐 lastSeq、丢弃历史事件（契约 §5.6）；唯一执行入口 executeActionEvent；:1875 对 VALID=1 且 class∈{1,2} 的事件本地计数。
  - :1900 execAction：startRecord/stopRecord 落 setRecording（录制唯一入口）；startAndAutoExport 在停止后按 target 调 runAutoActionExport。
  - :1959 exportStatsNow 只导出统计；:2118 openActionApiDoc 纯前端弹窗（Esc/遮罩关闭）。
- host/app/web/src/style.css：动作卡片/结果/API 文档弹窗样式，沿用现有变量与暗色主题。

## 3. 复现命令与证据

```bash
cd host/app

# 协议单测（14/14）
node --experimental-strip-types --test packages/protocol/test/action_byte.test.ts

# 网关 API 单测（15/15）
node --experimental-strip-types --test gateway/test/action_api.test.ts

# 前端动作映射单测（24/24）
node --experimental-strip-types --test web/test/actionmap.test.ts

# 类型检查 / web 构建 / 全量回归
npm run typecheck
npm run build --workspace web
npm test
```

实跑数字（2026-10-29T21:57:00+08:00，node v24.12.0；补计数字段并清 CSS EOF 后的最终重跑）：

- action_byte：tests 14 / pass 14 / fail 0，EXIT=0
- action_api：tests 15 / pass 15 / fail 0，EXIT=0
- actionmap：tests 24 / suites 5 / pass 24 / fail 0，EXIT=0
- web 全量：tests 237 / suites 27 / pass 237 / fail 0，EXIT=0
- npm test：tests 610 / suites 27 / pass 610 / fail 0，duration_ms 19555.925，EXIT=0
- typecheck：EXIT=0（无输出）
- build --workspace web：EXIT=0，vite v5.4.21，66 modules，dist/assets/app.js 158.95 kB（gzip 64.68 kB），built in 471ms

实时端到端（独立测试网关，未触碰用户面板的 UDP 1234/WS 8787）：

```bash
cd host/app
node --experimental-strip-types gateway/src/main.ts --udp --bind 127.0.0.1 --port 12400 --ws-port 8900 --serve
# 另一终端：
node --experimental-strip-types /tmp/action_e2e.ts
```

- E2E：E2E_RESULT=PASS，checks=21，fails=0，DURATION_MS=1199；覆盖 503 基线、合法 v3 快照（含 seq/tMs/source 镜像）、events after=-1/长轮询唤醒、config.set 生效与历史 mapped 重算、非法 v 拒绝、timeout=true、valid=0 不产事件且不推进 seq、404。
- 真实 curl：GET /api/action 200；GET /api/action/events?after=-1&timeoutMs=0 200；GET /api/action/config 200；POST /api/action → 405，正文"本接口只读：仅支持 GET/HEAD"，curl 退出码 0。
- 完整 stdout 见 EVIDENCE_API.log；协议/回归见 EVIDENCE_PROTO.log；前端见 EVIDENCE_UI.log。

## 4. 改动文件清单

修改（已跟踪）：

| 文件 | 说明 |
|---|---|
| host/app/packages/protocol/src/constants.ts | OFF3.ACTION=23、ACT3 位域、ACT_CLASS_NAMES、CTRL.TLV.ACTION_STATE=0x92 |
| host/app/packages/protocol/src/codec/v3.ts | decodeActionState/encodeActionState；不改变 parseV3Packet 的 byte23 行为 |
| host/app/gateway/src/ipc/http.ts | /api/* 分派先于 method 检查，405 正文交 api.ts |
| host/app/gateway/src/ipc/api.ts | **不在任务书白名单**；3 个 GET 路由与 ActionStore 回退读取（见 §6.4） |
| host/app/gateway/src/ipc/ws.ts | config.set 仅接受 actionMap 键；config 快照带 actionMap |
| host/app/gateway/src/pipeline/processor.ts | 每个 v3 包 observe byte23/TLV 0x92 |
| host/app/web/src/main.ts | localStorage 映射、轮询、事件执行、导出、API 文档弹窗 |
| host/app/web/src/ui/sidebar.ts | 动作卡片 cA 与三行控件 |
| host/app/web/src/style.css | 动作卡片/结果/API 文档样式 |

新增（未跟踪）：

| 文件 | 说明 |
|---|---|
| host/app/gateway/src/action.ts | ActionStore、actionRawOfPacket、配置规范化 |
| host/app/gateway/test/action_api.test.ts | 15 项网关单测 |
| host/app/packages/protocol/test/action_byte.test.ts | 14 项协议单测 |
| host/app/web/src/actionmap.ts | 前端映射纯逻辑 |
| host/app/web/test/actionmap.test.ts | 24 项前端单测 |
| docs/05_experiments/action_recognition_20261029/EVIDENCE_PROTO.log | 协议证据 |
| docs/05_experiments/action_recognition_20261029/EVIDENCE_API.log | API/E2E/curl 证据 |
| docs/05_experiments/action_recognition_20261029/EVIDENCE_UI.log | Web 构建/单测/人工清单 |
| docs/05_experiments/action_recognition_20261029/report.md | 本报告 |

未改：gateway/src/main.ts（曾试注入，已回退）、transport/**、web/test/motion_predict.test.ts、retina_event/**、nn/**、docs 其他文件。

## 5. 人工验收清单（本次未执行）

本会话不打开浏览器，也不干扰用户正在用的网页面板（PID 12616，UDP 1234/WS 8787）。以下步骤在独立 12400/8900 测试网关上做，不影响用户面板；在有人实际点过之前结果一律记"未执行"。

### A. 卡片数值随 /api/action 变

- 步骤：起测试网关；浏览器开 http://127.0.0.1:8900/；用 /tmp/inject_one.ts 注入 byte23=0xA1 的完整 v3 帧；观察「动作识别」卡片。
- 预期：标题右侧显示 "byte23 0xA1"；类别=握拳→张开、置信度=8/31；计数随每次注入 +1；停止注入后停在最后快照，ageMs 继续增大。
- 结果：**未执行（需人工开浏览器）**

### B. 下拉切换后 localStorage 键 actionMap 持久化

- 步骤：在卡片里改 class1/class2 的「操作 × 导出目标」与 minConf；刷新页面；DevTools → Application → Local Storage 检查键 actionMap；同时 GET /api/action/config。
- 预期：刷新后下拉保持用户值；localStorage.actionMap 含 {v:1,updatedAtMs,minConf,map}；网关 config.source="ui" 且 map 与页面一致；非法配置被拒绝而不是静默改写。
- 结果：**未执行（需人工开浏览器）**

### C. API 文档弹窗可开合

- 步骤：点卡片底部「API 文档」；按 Esc；再点开、点遮罩。
- 预期：弹窗含三个接口的路径/字段/错误码与 curl 示例；Esc 与遮罩都能关闭；打开弹窗不影响轮询与录制按钮。
- 结果：**未执行（需人工开浏览器）**

## 6. 与任务书/契约的偏差（重要，需 Lead 知悉）

1. **API 字段口径（已用超集兼容）**：任务书 API_OK 写 /api/action 返回 {ok,valid,class,className,conf,seq,tMs,source}；契约 §4.1 实际是 base{ok,uptimeMs,uiUrl} + available/frameIdx/tArriveMs/ageMs/raw/valid/class/className/conf/mapped，seq/tMs 在 events 事件里、source 在 config 里。实现以契约字段为主，**额外**返回 seq/tMs/source 三个兼容镜像（seq=最近事件序号/0、tMs=快照 tArriveMs、source=映射来源），从而同时满足任务书机读判据与契约语义；若评审认为不应多给字段，删掉这三行即可，契约字段不受影响。
2. **类别语义冲突**：任务书正文 class1=手部开合（任一方向）、class2=横向挥手；契约 §2.1 与 ACT_CLASS_NAMES 是 1=握拳→张开、2=张开→握拳、3=保留。实现按契约。**若 RTL 侧按任务书把 class2 编成"横向挥手"，两侧语义会对不上，请 Lead 与 rtl 确认后再联板。**
3. **锚点漂移**：任务书写 setRecording 在 main.ts:1365、exportNow 在 :1609；实际 :1427/:1677。constants.ts OFF3.RSVD 原 :37，实际 ACTION 在 :43。codec/v3 parseV3Packet 原写 88-196，实际从 :132 起，byte23 解码在 :59-66。以实际代码为准。
4. **路由落点/白名单**：3 个 GET 路由实际落在 gateway/src/ipc/api.ts（既有路由层），该文件不在任务书白名单；http.ts（白名单内）只改分派顺序。未改 main.ts。若 Lead 要求严格白名单，需要把 api.ts 追加入允许清单，或另行安排重构；当前没有第三种不破坏既有路由的落点。
5. **config 响应是超集**：同时给嵌套 config{v,updatedAtMs,minConf,map} 与扁平 minConf/map。多给字段、不改语义；契约未禁止额外字段。
6. **405 文案已修正**：之前全局 method 检查会回"只支持 GET/HEAD"；现在 /api 的非 GET/HEAD 回契约 §4.0 的"本接口只读：仅支持 GET/HEAD"（405），E2E 与真实 curl 都验证。
7. **TLV 0x92 的读取范围**：网关 actionRawOfPacket 对任何带 ctrlHeader 的包优先取 0x92 len=1；契约约定板端只随 GET_STATUS ACK 尾追。这是"宽容读取"，并未放宽对板端的要求，也未改包解析。
8. **available 口径**：/api/action 的 available 只在 processor 见过 v3 动作字节后为 true；若最近只收到 v2/无帧，仍按契约给 available:false+reason，不会拿 byte23=0 冒充"无动作"。

## 7. 遗留问题 / 未验证

1. **浏览器人工验收 3 项未执行**（§5 A/B/C）。UI_OK=1 只代表构建与自动单测；真实 DOM 行为（卡片刷新、下拉持久化、Esc/遮罩）需人工复核。
2. **无真实板卡/眼动数据**：所有注入均为合成 v3 帧；未验证 RTL 实际写 byte23 的时序、TLV 0x92 尾追、以及动作类别在真实数据上的分布。联板需与 rtl/coder 对齐类别语义（§6.2）。
3. **网关映射镜像不落盘**：网关进程重启后 /api/action/config 回到 source=default；浏览器 localStorage 仍在，但页面启动时不会主动把本地映射推给网关，需用户改一次下拉或后续补一行启动同步。当前卡片执行仍用本地映射，功能不受影响，只是 API 镜像短暂不一致。
4. **/api/action 的 503 优先级**：无完整帧时先 503，即使 ActionStore 已有动作快照也不返回；这是按契约"还没有完整帧"语义实现。若希望"有动作字节就尽量给快照"，需契约层面确认。
5. **TLS/鉴权/多用户**不在本任务范围；网关仍是本机 HTTP/WS。
6. **验收脚本在 /tmp**（action_e2e.ts、inject_one.ts），未纳入仓库；证据文件已固化 stdout。若需长期回归，建议后续把 E2E 脚本收进 gateway/test 或 tools（本任务白名单不允许新增该路径）。

## 8. 备注

- 测试网关只使用 UDP 12400 / HTTP+WS 8900，未绑定 1234/8787，未 kill 用户面板进程（PID 12616）。
- 未执行任何 git 写操作（commit/push/stash/checkout 均无）；未安装依赖；未跑 Vivado。
- 本次只写 docs/05_experiments/action_recognition_20261029/ 下 4 个交付文件。

## 9. 类别语义更新与补充说明（task-14，2026-10-29）

1. **类别语义按当前权威定义更新**：class0=无动作、class1=手部开合（握拳↔张开，任一方向合并为一类）、class2=横向挥手、class3=保留。字节位域不变（bit7 VALID / bit6..2 CONF / bit1..0 CLASS，offset 23 未动）；protocol/gateway/web 的 `ACT_CLASS_NAMES` 与 API `className` 现统一返回 `无动作 / 手部开合 / 横向挥手 / 保留`。本文件前文（§2.3、§6.2）写于语义切换前的“握拳→张开 / 张开→握拳”表述仅作历史记录，以本节为准。
2. **路由落点由 Lead 事后确认**：三个只读 GET 实际位于 `gateway/src/ipc/api.ts`；任务书白名单漏列该文件，Lead 已确认接受、不回退。`gateway/src/ipc/http.ts` 只把 `/api` 分派提前到 method 检查之前，以保证 405 契约文案。
3. **API 超集镜像字段**：`seq`/`tMs`/`source` 属任务书兼容用的「超集镜像字段」，契约只规定 `ok/valid/class/className/conf`；这三个字段非契约，未来可能移除。
4. **证据与归档**：ACT3_NAMES_OK=1 见 `EVIDENCE_NAMES.log`；`action_e2e.ts` 已从 `/tmp` 原样归档到本目录（SHA-256 一致，不加入 npm test glob；脚本内旧文案未改）。
5. **白名单外必要改动**：`web/src/main.ts` 的「API 文档」弹窗示例 JSON 原本含旧 className；为满足判据①（界面/API className 不允许旧文案），示例已同步改为`手部开合`。`main.ts` 不在 task-14 白名单，属必要越界，请 Lead 确认。

## 10. M5 评测工具（task-16，2026-10-29）

1. **目标与产物**：新增现场评测 CLI，操作员用键盘标注真实类别，工具经网关**只读** GET
   /api/action* 采集判定，输出混淆矩阵、各类 P/R/F1、accuracy、balanced accuracy、
   误触发次数/分钟、漏检数、总判定数、置信度分档与判定延迟。用于 M5 上板验收
   （≥100 次动作、准确率 ≥85%、误触发 <1 次/min）。新增：
   host/app/tools/action_eval.mjs、host/app/tools/test/action_eval.test.ts、
   host/app/tools/README.md；证据 EVIDENCE_EVAL.log。未改 gateway/**、packages/**、web/**，
   未改 tools/launch.mjs、tools/record_events.mjs，未新增任何写接口或依赖。

2. **判据结果**：ACTION_EVAL_OK=1。
   - 合成 E2E：E2E_RESULT=PASS checks=28 fails=0，退出码 0；UDP 127.0.0.1:12400 /
     HTTP+WS 127.0.0.1:8900（均避开用户面板的 1234/8787），协议编码器构造 600 段
     完整 v3 帧回环注入，长轮询采集。
   - 单测：11/11 通过，退出码 0，覆盖窗口匹配、超时漏检、同窗口重复只计一次、
     无动作区间误触发、置信度分档、CSV/JSON 字段完整，以及参数/script/位域边界。
   - 全量 npm test：621/621，27 suites，0 fail，退出码 0；npm run typecheck 退出码 0。
     全量较上一轮 610 增加 11 个 action_eval 单测，根 package.json 的 test glob 已含
     tools/test/**/*.test.ts，未改配置。

3. **E2E 手算混淆矩阵**（5 次合成动作，与脚本内断言一致）：

   | 真值\预测 | class1 | class2 | class3 | miss |
   |---|---|---|---|---|
   | class1 | 2 | 1 | 0 | 0 |
   | class2 | 0 | 1 | 0 | 1 |
   | class3 | 0 | 0 | 0 | 0 |

   matched=4、missed=1、wrong=1（truth4 被判成 class2）、duplicates=0、
   falseTriggers=1（约 96 ms 处无真值窗口的 class2）、accuracy=50.0%、
   balanced accuracy=0.5834、macroF1=60.0%、误触发=13.913/min；
   class1 support3 TP2 FP0 FN1（P/R/F1=1/0.6667/0.8），
   class2 support2 TP1 FP2 FN1（P/R/F1=0.3333/0.5/0.4）。
   匹配延迟 n=4，p50=85.612 ms / p95=97.555 ms；M5 门槛在 5 次合成动作下显示未达标
   属预期，用于验证门槛判定本身。

4. **匹配口径**（README 与 --help 同口径）：真值标注后 windowMs（默认 3000 ms）内第一个
   未消费判定算一次；每个动作窗口只消费一次，多余判定计重复且不重复计误触发；无动作
   区间内 class!=0 判定计误触发；已标注但窗口内无判定计漏检；class0 判定不计入预测，
   class3 仅按预测类统计。脚本模式真值 tMs 相对取得事件游标基线后的采集起点。

5. **运行方式**：现场一行命令（连已有面板 API，只读、不占 1234/8787）：

       cd E:/workspace/FPGA_Comp/host/app && node --experimental-strip-types tools/action_eval.mjs --api http://127.0.0.1:8787 --out "$TEMP/action_eval_m5"

   键位 1=手部开合、2=横向挥手、0=无动作、空格/回车确认、q 退出。合成回归用
   --e2e --udp-port 12400 --ws-port 8900。结果写 action_eval.csv 与
   action_eval_summary.json，summary 的 m5Acceptance 直接给出三项门槛是否成立。

6. **限制与未验证**：本会话没有真实板卡/眼动数据，E2E 全是合成 v3 帧；没有执行
   ≥100 次真实动作的 M5 现场验收，因此 M5 门槛尚未在真实数据上验证。未做浏览器人工
   操作（工具是 CLI）。类别语义按 task-14 后的当前定义（class1=手部开合、
   class2=横向挥手）；若 RTL 侧仍按旧定义写 class2，评测会把两侧错位记入混淆矩阵。
   评测工具只用 GET /api/action*，不改变网关映射，不触发录制/导出。

## 11. 动作卡片等待态（task-17，2026-10-29）

1. **问题与目标**：当前位流还没有启用动作回传，byte23 恒为 0（VALID=0）。卡片如果只看
   当前帧，会长期显示「无动作」，演示时会被误认为动作识别失效。本任务只改前端：本页
   从未收到 VALID=1 时显示「等待板卡动作引擎 · 当前位流未启用动作回传」；收到过一次
   VALID=1 后，即使再回到 VALID=0 也只显示「无动作」，不再回到等待态。

2. **实现**：sidebar.ts 增加纯状态机 actionResultState(prevSawValid, av) 和常量
   ACTION_PENDING_TEXT；mountSidebar 闭包内用 let actionSawValid 保存「本页是否见过
   VALID=1」。该标志只驻内存：不写 localStorage、不新增 API 字段、不引持久化；
   刷新页面即新会话。未改 gateway/**、packages/protocol/**、web/src/main.ts、tools/**。
   新增 web/test/action_pending.test.ts，4 个用例覆盖等待→收到 VALID→回到 VALID=0 的
   单调状态，以及旧面板 404 无新快照时不崩溃、不误报。

3. **判据结果**：ACT3_PENDING_OK=1。单测 4/4（node --test --experimental-strip-types
   web/test/action_pending.test.ts，EXIT=0）；全量 npm test 625/625（28 suites，
   0 fail，EXIT=0）；npm run typecheck EXIT=0；npm run build --workspace web EXIT=0
   （vite v5.4.21，66 modules，app.js 159.10 kB，gzip 64.81 kB，460 ms）。
   证据见 EVIDENCE_PENDING.log。

4. **真实零字节流冒烟**：按 Lead 指示，用隔离网关（UDP 127.0.0.1:12777、
   HTTP/WS 127.0.0.1:8917，避开 1234/8787）接收 600 段完整 v3 帧，byte23=0x00；
   GET /api/action 返回 200，available=true、frameIdx=9901、raw=0、valid=false、
   class=0、className="无动作"、conf=0、mapped=null。前端对同一字段组合返回等待
   文案，与单测①一致；真实零字节流不会被显示成「无动作」。

5. **旧面板发现（M5 检查项）**：用户正在跑的 8787 面板是 PID 12616，创建于
   2026/10/29 20:38:27，早于 /api/action 落地；其 GET /api/action 返回 404
   「未知接口: /api/action」，而 /api 的 endpoint 表也没有动作三项。这不是前端 bug，
   但意味着 M5 上板前必须重启面板才能使用新接口；**动作卡片的等待态也只有在重启后的
   新面板里才可见。** 按 Lead 要求，本次没有重启/干扰该进程，也没有绑定 1234/8787。
   旧面板 404 时 main.ts 的轮询直接 return、不更新 actionView，卡片保持上次状态；
   单测④覆盖了这条不崩溃/不误报的边界。

6. **未验证与边界**：本会话没有真实浏览器人工操作，等待→恢复态的视觉验收留给 M5
   上板；真实板卡动作回传仍受当前位流限制。另：task-17 白名单/禁令包含 tools/**，
   因此 task-16 的 README「首次使用先跑键位自检」提示未在本任务落笔，需要时请单列
   授权补一行。

## 12. 检测计数口径（task-24，2026-10-29）

1. **问题与背景**：原 `ActionStore.observe()` 只在「class 与上一条事件不同」时记事件，
   且 VALID=0 直接 return；而板侧旧位流的动作字节是电平保持的（判定后 VALID 恒为 1）。
   两者叠加 ⇒ 用户连续做同一种动作时 byte23 完全相同，上位机最多只能记 1 次，
   M5 的「≥100 次 / 准确率 ≥85%」无法统计。板侧 task-23 新增 1.0 s 空窗清零：
   判定后 1.0 s 无新 pulse 就把 byte23 归 0，于是每次动作都会产生一个 VALID 上升沿。

2. **唯一口径**：一次「检测」= byte23 的 VALID 由 0 变 1（上升沿），**或** class 发生变化；
   两者任一都记一次，累计进 `count`。具体边界：
   - VALID 0->1：记一次，即使 class 与上一次相同（连续做握拳/张开的关键路径）。
   - class 变化：记一次，即使 VALID 一直保持 1（reason=class_change）。
   - VALID 1->0：不记（回落不是新检测）。
   - 连续 VALID 1->1、byte23 完全相同：不记。
   - conf 变化但 VALID 保持 1：不记。置信度是状态量/质量分，不是新动作事件；
     若按 conf 变化计数，会把同一次判定中的抖动重复计成多次，M5 的检测次数将
     与真值动作数不可比，直接虚高准确率分母。
   - 事件对象新增 `reason: "valid_rise" | "class_change"`；既有字段名与语义一律不动。

3. **实现**：`gateway/src/action.ts` 用 `prevValid`/`prevClass` 保存上一包的边沿状态，
   `count` 单调累加（不受 64 条事件环容量限制，reset 清零）；`GET /api/action` 只增
   `count`（available=false 时为 0，available=true 时为 `getCount()`；503 分支不加）。
   前端 `main.ts` 直接消费网关 `count`，删掉原先 events 循环里的本地自增（避免双计），
   卡片文案改为「检测次数」；`tools/action_eval.mjs` 在采集前后读 `/api/action` 的
   count，summary 新增 `detectionCount`/`eventCount`/`gatewayCountStart`/
   `gatewayCountEnd`/`countMatchesEvents`，CSV 六列契约未动。

4. **与 M5 验收的关系**：现场跑 `action_eval` 时，检测次数取网关 `count` 的起止差值；
   准确率/召回/误触发仍按「真值标注窗口 vs 事件流」计算，二者分工明确：
   `count` 回答「一共检测了多少次」，事件流回答「每次检测落在哪个真值窗口」。
   前提是板端 task-23 的 1.0 s 空窗清零生效；若仍用旧的恒电平位流，同一种动作
   重复做只会出现一个上升沿，`count` 会偏小，此时不能把 `count` 当作动作次数。

5. **验证**：`ACTION_COUNT_OK=1`。单测 34/34（新增 8 个计数用例，含「连续 1->1 不记」
   与「VALID 0->1 即使 class 相同也记」两个关键反例）；全量 `npm test` 633/633（28 suites，
   0 fail）、`typecheck` RC=0；隔离网关 E2E（UDP 12777 / HTTP 8917）注入
   valid 0->1->0->1（class 恒 1）后 `count` 从 0 增到 2，`events?after=0` 取回 2 条
   （reason 均为 valid_rise）；`npm run build --workspace web` RC=0，产物中「检测次数」
   出现 3 次。证据见 `EVIDENCE_COUNT.log`。

6. **边界与未验证**：本会话没有真实板卡，E2E 全是合成 v3 帧；板侧 1.0 s 空窗清零
   尚未与上位机联调。用户正在跑的 8787 面板是旧网关（无 `/api/action`），需重启后才
   能看到「检测次数」；本次未 kill、未绑定 1234/8787。若一次动作在板端产生多次
   合法性变化（例如 class1->class2），按本口径会记 2 次，M5 分析时需以事件流解释
   差异，不要只看 count 差值。

## 13. CTRL 包不计数的过滤（task-26，2026-10-30）

1. **问题根因**：v3 板端 `downlink_cmd.v` 的 `pkt_byte()` 里，BYTE23 位于 default 分支
   = `8'h00`；也就是说 **1 Hz 心跳（0xF0）与除 GET_STATUS 外的所有 ACK 头里 byte23 都是 0**。
   网关 `processor.ts` 对每个解析成功的 v3 包都调用 `actionStore.observe()`，心跳的
   byte23=0 被当成「无动作」把 `prevValid` 打回 false；下一条 0xFD 数据包又被判成
   VALID 上升沿 ⇒ `count` 被 1 Hz 心跳系统性放大。现场痕迹与此吻合：event
   seq 43530→43531 只隔 43 ms、43349→43371 隔 831 ms，物理上绝不可能穿过板侧 1.5 s
   不应期；32 条事件里 30 条 conf 都是饱和的 31。**这不是板端动作识别变差，而是网关把
   「包不携带动作字节」误读成了「当前无动作」。**

2. **修复（只动网关侧，不重烧板卡）**：新增
   `gateway/src/action.ts:79 hasActionStateTlv(pkt: ParsedV3): boolean`，只认
   `ctrlHeader` 里 `tag===0x92 && value.length===1` 的权威 TLV；malformed 0x92
   （len≠1）返回 false，避免它回退到 byte23 又触发同一个 bug。`processor.ts:96` 把
   `observe()` 的条件改成 `!r.value.ctrl || hasActionStateTlv(r.value)`：
   - 普通数据包：照旧每包 observe()，快照/计数/事件语义完全不变；
   - CTRL 包：只有带 0x92 的 GET_STATUS ACK 才 observe()（它本来就是动作快照最权威的
     来源）；心跳/其它 ACK 不再触碰 actionStore，但仍照旧走 `onCtrl` 状态通道。

3. **验证**：`GATEWAY_ACTION_FILTER_OK=1`，证据见 `EVIDENCE_CTRLFILTER.log`。
   - 新增 5 条网关单测（`gateway/test/action_api.test.ts`）：无 TLV 心跳夹在两条
     0xFD 之间不改变 count/快照；带 0x92 的 GET_STATUS ACK 仍更新快照并计数；数据包
     0xFD→0x00→0xFD 仍记 1 次 valid_rise；连续 20 条心跳零事件；helper 对 malformed
     0x92 返回 false。该文件 27/27 通过。
   - 隔离 E2E（UDP 127.0.0.1:12400 / HTTP+WS 127.0.0.1:8919；未碰 1234/8787）：
     完整 600 段 v3 帧后 count=1；1 Hz 心跳 ×5 + 26 fps 数据包跑 5 s，修复前
     count=6，修复后 count=1；同一数据流每 1.5 s 让 byte23 归零一次（4 次），
     增量 delta=4（=归零次数），累计 count=1（Phase A 基线）+4=5，证明真实空窗
     清零仍被计数。
   - 全量回归：`npm test` 638/638（28 suites，0 fail，duration 19719.2047 ms），
     `npm run typecheck` exit 0。

4. **边界**：修复前用户面板是 PID 12616（2026-10-29 20:38 启动）；提交时 8787 已由
   PID 14432 监听（只读 GET /api/action 返回 uptimeMs=31456408，约 8.7 h，仍早于本
   修复），因此必须再次重启面板才会加载 M4g 过滤。本会话按 Lead 要求未 kill、未绑定
   1234/8787。没有真实板卡，E2E 心跳/数据包均为协议编码器合成的 v3 包。修复只过滤
   动作通道，心跳的 CTRL 解析和 WS 状态展示不受影响；`/api/action` 字段与 `count`
   语义不变，只是不再被心跳虚增。
