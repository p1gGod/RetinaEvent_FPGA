# M5 动作识别上板验收方案（2026-10-29）

- **文档性质**：方案，不是验收记录。本文所有“上板命令”均为**未实测（需板卡 + 用户在场）**；只有标注“实测”的桌面命令在本机跑过。
- **适用对象**：M4b RTL（byte23 动作字段 + TLV 0x92）+ M4c 集成（<code>nn_top</code> 例化）+ M4-ui（动作卡片 + actionMap）合入之后。
- **当前基线**：HEAD = <code>357de98</code>（2026-10-29 22:10）；M4/M4-ui 改动仍在工作树未提交；M4b RTL 任务 task-11 与 M4c 集成 task-20 均未完成（task-20 <code>blocked_by = task-6 + task-11</code>）；<code>top_retina_event.v</code> 尚未例化动作引擎；用户面板 PID 12616 是 20:38 启动的旧网关，<code>/api/action</code> 返回 404。
- **结论**：M5 **现在不能开始**，Gate 0 未通过（见 §1）。本方案定义“怎么验、怎么退”，不代替验收；任何一条上板命令都必须在用户在场、板卡上电、JTAG/网线可用的条件下执行。

> 证据等级约定：**实测** = 本机命令跑过 / 构建报告可查；**文档** = 工具源码、历史报告、厂家资料；**推断** = 尚未上板验证的判断，必须能被后续证伪。

---

## 0. 一页结论

| 项 | 当前值 | 来源 |
|---|---|---|
| 代码是否已合入 M4c | 否：<code>grep -n "nn_top" src/rtl/top/top_retina_event.v</code> 0 命中 | 实测（2026-10-29 22:18） |
| 面板是否支持动作 API | 否：<code>GET /api/action</code> = 404，错误“未知接口: /api/action” | 实测（2026-10-29 22:18） |
| 板卡是否在推流 | 是：<code>/api/stats</code> pps = 15,975，packets = 95,355,862 | 实测（2026-10-29 22:18） |
| 当前板端是否有动作 TLV | 否：<code>board_rpc.mjs --get-status</code> 的 tlvs 无 action/0x92 字段 | 实测（2026-10-29 22:18） |
| M4c 构建包装脚本 | 不存在：<code>build/m5_action_variant_build.ps1</code> 缺失 | 实测 |
| 桌面回归工具 | <code>action_eval.mjs --help</code> exit 0；<code>--e2e</code> PASS checks=28 fails=0 | 实测（2026-10-29 22:18） |
| 结论 | **Gate 0 未过，M5 阻塞**；先完成 §1 的 6 个阻塞项 | 实测 + 推断 |

---

## 1. 前置检查清单（Gate 0，全部必过）

在 <code>E:\workspace\FPGA_Comp</code> 下执行；第 4 项之后需要用户在场。

| 编号 | 检查项 | 命令（Git Bash / PowerShell） | 通过判据 | 当前状态（2026-10-29 22:18） |
|---|---|---|---|---|
| G0-01 | M4b/M4c + M4-ui 已合入同一 HEAD | <code>git status --short</code>；<code>git log --oneline -3</code> | 工作树无未提交的源文件；HEAD 含 M4b/M4c/M4-ui 提交 | **未通过**：M4/M4-ui 仍在工作树（他人进行中） |
| G0-02 | 动作引擎已例化 | <code>grep -n "nn_top" src/rtl/top/top_retina_event.v</code> | 至少 1 行例化 | **未通过**：0 命中 |
| G0-03 | byte23/TLV 0x92 已接入 | <code>grep -n "action_byte\|0x92\|ACTION_STATE" src/rtl/comms/udp_merge.v</code> | 命中 byte23 锁存/0x92 组装路径 | **未检查**（依赖 G0-01） |
| G0-04 | M4c 构建包装脚本存在 | <code>test -f build/m5_action_variant_build.ps1; echo $?</code> | 0 | **未通过**：脚本不存在 |
| G0-05 | 用户面板是新版网关 | <code>curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/action</code> | 200 | **未通过**：404（旧面板，必须重启） |
| G0-06 | 只读 API 三件套可用 | 见 §3.5 的 <code>curl</code> 三条 | action 200 / config 200 / events 503 或 200 | **未通过**：均 404 |
| G0-07 | 板卡在推流且 pps 正常 | <code>curl -s http://127.0.0.1:8787/api/stats</code> | pps 15,000~17,000，badMagic/crcFail 为 0 | **通过**：pps 15,975，计数器无异常 |
| G0-08 | 网卡地址正确 | <code>ipconfig</code> 看“以太网” | 静态 192.168.1.102/24 | **通过**（实测） |
| G0-09 | 1234/8787 只有一个网关 | <code>netstat -ano \| grep -E ":(1234\|8787)\s"</code> | 各只有 1 个 PID，且是当前面板 | **通过**：PID 12616 同时持 1234/8787 |
| G0-10 | 没有正在录制 | 浏览器面板右上角/时间轴显示“未录制” | 显示“未录制” | **未检查**（需用户确认；不要只看 API） |
| G0-11 | 桌面回归工具可用 | <code>node --experimental-strip-types tools/action_eval.mjs --help</code>；<code>--e2e --udp-port 12411 --ws-port 8911</code> | help exit 0；E2E 末行 PASS | **通过**：help exit 0；E2E PASS checks=28 fails=0 |
| G0-12 | 构建/烧录环境就绪 | Vivado 2020.2 路径存在；<code>pktmon help</code> exit 0；E: 盘 ≥ 2 GB；无其他 Vivado 批处理 | 全部成立 | **未检查**（上板前做） |
| G0-13 | 已知好位流可回退 | <code>md5sum build/variant_fix6_seam/retina_event.bit</code> | md5 = 87cae9539244fe562222bd659929e6be | **通过**：md5 一致 |

**阻塞项**：G0-01、G0-02、G0-03、G0-04、G0-05、G0-06。前四项由 RTL/host 负责，G0-05/G0-06 由面板重启解决；**任何一项未过，不允许烧 M4c 位流**。

---

## 2. 两条上板路径

### 2.0 先分清两种位流（M4c 前置，别拿现成位流等动作）

- **当前位流（G / 用户 Flash 里的位流）**：<code>top_retina_event.v</code> **尚未例化 <code>nn_top</code>**（实测 <code>grep -n "nn_top"</code> = 0 命中）；数据帧 byte23 恒为 <code>0x00</code>，<code>/api/action</code> 只能返回“无动作/等待板卡动作引擎”。**用当前位流跑本方案的动作验收，必然全 0，这不是模型失败**。
- **M4c 之后的位流**：M3 的动作引擎是独立子系统，集成任务 **task-20（M4c）** 已建，<code>blocked_by = task-6 + task-11</code>；只有 task-20 完成、<code>top_retina_event</code> 例化 <code>nn_top</code>、byte23/TLV 0x92 接通后，才允许按 §3 做动作验收。
- **进入 §3 的硬前提**：<code>GET /api/action</code> 返回 <code>available:true</code>，且 <code>GET_STATUS</code> ACK 尾部出现 <code>0x92 0x01 &lt;byte23&gt;</code>；否则回到 §1 的 G0-02/G0-03，不要开始动作采集。
- 本节两条路径（JTAG/Flash）都只解决“把哪个位流放进板子”；**动作功能是否存在由 M4c 决定，不由烧录方式决定**。

### 2.1 路径 A：JTAG 易失烧录（推荐）

#### 2.1.1 构建 M4c 位流

前置：G0-01~G0-04 通过；<code>build/m5_action_variant_build.ps1</code> 由 RTL 提供（复制 G 的包装脚本，只改 <code>RETE_TAG=m5_action</code>）。本方案**不创建**该脚本（task-18 白名单只允许 docs 与 .gitignore）。

包装脚本应等价于（路径用正斜杠，Vivado 可直接接受）：

~~~powershell
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:RETE_GENERICS = 'UART_LINK_EN=1'
$env:RETE_TAG      = 'm5_action'
$vivado = 'E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat'
& $vivado -mode batch -source tool/build_inproc.tcl -log build/m5_action_build.log -journal build/m5_action_build.jou -tclargs --full
~~~

执行（**未实测，需板卡/工具链**）：

~~~powershell
cd E:/workspace/FPGA_Comp/retina_event
powershell -NoProfile -ExecutionPolicy Bypass -File build/m5_action_variant_build.ps1 > build/m5_action_console.txt 2>&1
echo "M5_BUILD_EXIT=$LASTEXITCODE"
~~~

构建判据（全部满足才允许烧）：

| 项 | 判据 | 说明 |
|---|---|---|
| 进程退出 | <code>M5_BUILD_EXIT=0</code> | 包装脚本退出码 |
| 位流 | <code>build/variant_m5_action/retina_event.bit</code> 存在，大小/ md5 记录 | 不得覆盖 <code>build/retina_event.bit</code> 锚点 |
| 构建结果 | <code>grep -n "INPROC_RESULT=OK" build/m5_action_build.log</code> | 以 ASCII 锚点为准 |
| 时序 | WNS ≥ 0，WHS ≥ 0，failing endpoints = 0 | 上板硬门槛；负 slack 不许烧 |
| DRC | error = 0 | warning 允许，但 Critical 必须逐条看 |
| 资源上限 | LUT ≤ 32,000；Slices ≤ 10,800；BRAM36 ≤ 96；DSP ≤ 20 | 见附录 B 的预算纠偏 |

构建耗时参考：G 位流实测 **761.9 s**（synth 6:23、opt 0:36、place 2:11、route 2:04、write_bitstream 0:33，来源：<code>docs/05_experiments/网线插拔拼接_20261018/构建报告_G.md</code>）。M4c 集成动作引擎后，建议预留 **15~25 min**；若超过 30 min 无进展，查 Vivado 日志而不是重复启动第二个构建。

防待机：长构建必须防待机，优先用项目约定的 <code>run_awake.ps1</code> 包裹（本机工作树当前未找到该脚本，<code>find</code> 0 命中，见证据）；没有脚本时用内联 <code>SetThreadExecutionState(ES_CONTINUOUS 或 ES_SYSTEM_REQUIRED = 2147483649)</code> 兜底。本机 AC 待机 30 min，历史上有 route_design 被冻结 13 h 19 min 的教训（实测，见 fpga-builder-amd skill）。构建结束后恢复 <code>2147483648</code>。

#### 2.1.2 烧录（JTAG volatile）

~~~powershell
cd E:/workspace/FPGA_Comp/retina_event
& 'E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat' -mode batch -source tool/program_retina.tcl -log tool/program_m5.log -journal tool/program_m5.jou -tclargs build/variant_m5_action/retina_event.bit
echo "M5_PROGRAM_EXIT=$LASTEXITCODE"
~~~

- **若本项目已接入 FPGABuilder**（目录存在 <code>fpga_project.yaml</code>），等价的临时烧录命令是：
  ~~~powershell
  fpgab.bat vivado program --bitfile build/variant_m5_action/retina_event.bit
  ~~~
  但 <code>retina_event/</code> 当前**没有 fpga_project.yaml**，且本机 <code>where fpgab.bat</code> 无结果（实测，见证据）；因此本仓库实际走下面的 <code>program_retina.tcl</code>，两种方式都只烧易失位流、掉电丢失。
- <code>program_retina.tcl:22-27</code> 接受第一个 <code>-tclargs</code> 作为位流路径，默认才是 <code>build/retina_event.bit</code>；**必须显式传 M4c 变体位流**。
- <code>:53</code> 强制 JTAG 6 MHz（本板 FT2232H 必须；默认频率会报 [Xicom 50-38]/[Labtools 27-3176]）。
- 成功判据：日志行首锚定 <code>PROG_RESULT=OK</code>，且出现 <code>[Labtools 27-3164] End of startup status: HIGH</code>。
- 烧后只读复核：<code>jtag_detect.tcl</code> 的 <code>CONFIG_STATUS</code> 中 <code>BIT14_DONE_PIN=1</code>、<code>BIT04_EOS=1</code>；不要写 Flash。
- **上板命令未实测（需板卡 + 用户在场）**。

#### 2.1.3 烧后最小验证

1. 板卡不重启网关也可继续收流；若面板重启过，按 §3.1 等 <code>/healthz</code> 200。
2. <code>board_rpc.mjs --get-status</code> 应仍 exit 0；但该工具**不暴露 TLV 原始字节**，不能单独证明 0x92 存在。
3. 真正的证据是 <code>GET /api/action</code>：从 <code>available:false</code> 变为 <code>available:true</code>，且 <code>class</code>/<code>conf</code> 随动作变化；持续 false 则回 §6 的 F-02。

### 2.2 路径 B：Flash 固化（可选，不阻塞 M5）

- 板载 N25Q128（16 MB，文档/原理图）；Vivado 2020.2 的 <code>program_hw_cfgmem</code> 自动化在本机多次失败（27-3347/27-3176，历史实测），且 2020.2 不一定有条目。
- **M5 验收不要求 Flash**：JTAG volatile 已能证明动作引擎功能；Flash 只影响“脱机上电自启”。
- 如用户要求固化：用 Vivado Hardware Manager GUI 手动 Add Configuration Memory Device（<code>n25q128-3.3v-spi-x1_x2_x4</code> 一类），Program/Verify 后断电重上电，记录 <code>FLASH_PROGRAM=OK</code>/失败码；**不要把 GUI 步骤写成自动化脚本入库**，也不要在 M5 现场首次尝试 Flash。
- **未实测（需板卡 + 用户在场）**。

---

## 3. 验收指标与可执行命令

### 3.1 先重启面板（G0-05/G0-06 的修复动作）

当前面板 PID 12616 启动于 20:38:27，早于 <code>/api/action</code> 落地，因此 404。M5 前必须换成最新 gateway 代码。

**顺序（不要跳步）**：

1. 浏览器面板确认“未录制”。若在录制，先点停止并等导出完成；Ctrl+C 的自动导出只作兜底，不代替正常停止（录制缓冲在前端侧，风险判断属推断）。
2. 关闭旧面板：优先在启动器控制台按 Ctrl+C；确认 1234/8787 释放：
   ~~~bash
   netstat -ano | grep -E ':(1234|8787)\s'
   ~~~
   两行都不应再出现旧 PID。若仍被占用，先查 PID 再 <code>taskkill /PID &lt;pid&gt; /T /F</code>；**不得同时起两个网关**（Windows 同址同端口 UDP <code>reuseAddr</code> 是先绑定者独占收包，第二个会收 0 包，历史实测）。
3. 重启用户路径（用户在场，双击）：
   <code>E:/workspace/FPGA_Comp/host/app/启动-接开发板.bat</code>
   或无人值守的等价路径（不弹浏览器）：
   ~~~bash
   cd E:/workspace/FPGA_Comp/host/app
   node tools/launch.mjs --udp --no-open
   ~~~
4. 等就绪（最多 25 s；启动器自身有等待）：
   ~~~bash
   for i in $(seq 1 30); do
     code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz)
     [ "$code" = "200" ] && break
     sleep 1
   done
   echo "HEALTHZ=$code"
   ~~~
5. 三件套确认：
   ~~~bash
   curl -s -o /dev/null -w 'ACTION=%{http_code}\n' http://127.0.0.1:8787/api/action
   curl -s -o /dev/null -w 'CONFIG=%{http_code}\n' http://127.0.0.1:8787/api/action/config
   curl -s -o /dev/null -w 'EVENTS=%{http_code}\n' 'http://127.0.0.1:8787/api/action/events?after=-1&timeoutMs=0'
   ~~~
   通过：ACTION=200、CONFIG=200、EVENTS=200 或 503（503 只表示“还没有完整 v3 帧”，不是故障；见 §3.5）。
6. 前端出现“等待板卡动作引擎”是**新版面板的正常等待态**；旧面板 404 时前端是否保持等待态，以 host 的 action_pending 单测/实测为准（本方案未验证，按 **推断** 记录，不据此判 M5 通过）。

### 3.2 三门槛（硬判据）

<code>action_eval.mjs</code> 的门槛在 <code>tools/action_eval.mjs:436-447</code>（实测源码）：

| 指标 | 门槛 | 计算口径 |
|---|---|---|
| actionCount | ≥ 100 | 真值中 class 1/2 的标注条数（class 0 不计） |
| accuracy | ≥ 0.85 | correct / (actionTruths + falseTriggers) |
| falseTriggersPerMin | < 1 | 所有动作窗口之外的 class≠0 判定数 × 60000 / durationMs |

三项**同时**满足才 <code>m5Acceptance.pass = true</code>；工具**没有**逐类 recall 的自动门槛，但验收记录必须逐类写：<code>perClass["1"]</code> 与 <code>perClass["2"]</code> 的 <code>support/tp/fp/fn/precision/recall/f1</code> 全部抄入报告。class1 recall 低于 0.85 要解释；class2 用 §3.4 的 0.75 展示门。

**测试编排（建议 120 次动作，留 20% 余量）**：

| 场次 | 内容 | 动作数 | 时长 |
|---|---|---|---|
| S1 | 手部开合（class1）40 + 无动作背景 | 40 | 10 min |
| S2 | 横向挥手（class2）40 + 无动作背景 | 40 | 10 min |
| S3 | 混合 20/20 + 无动作背景 | 40 | 10 min |
| 合计 | — | **120**（class1 60 / class2 60） | 约 30 min + 准备 |

每一场前后各留 **≥ 2 min 无动作**，用于观察误触发；无动作区间可按 <code>0</code> 记录，但 class0 不参与 recall，只用于说明评测区间。

操作协议（按 <code>host/app/tools/README.md:48-50</code> 与工具实现）：

- 操作员做一个动作后按 <code>1</code> 或 <code>2</code>，再按空格/回车确认；**确认时刻才是真值窗口起点**（窗口默认 3 s）。
- 每次标注后等终端出现 <code>[pred] ...</code> 再标下一个；不要为同一个动作连按多次。
- **已知口径风险（必须现场先校准）**：窗口起点晚于动作发生；如果固件只在 class 变化时发一次事件，而操作员在动作结束后才确认，判定可能落在窗口之前而被记为漏检。M5 开始前先用 5~10 次小样本确认 <code>[pred]</code> 能在确认后 3 s 内出现；若系统性不出现，改为在动作开始/进行中按键，**不要改匹配窗口或门槛来凑绿**。
- 结束前等一个完整 3 s 窗口，避免最后一个判定未到。

执行（**未实测，需真实板卡/操作员**）：

~~~bash
cd E:/workspace/FPGA_Comp/host/app
node --experimental-strip-types tools/action_eval.mjs --api http://127.0.0.1:8787 --out "$TEMP/action_eval_m5" --duration-ms &lt;本场实际墙钟毫秒&gt;
~~~

关于 <code>--duration-ms</code>：工具在未传时用“最后一条真值/判定的相对时间”作分母；若最后一段无动作且无误触发，分母会被截短。**必须传本场实际采集墙钟**（例如 600000），并在记录里同时写秒表时间；**禁止为了降低误触发率虚报更大的时长**，这是验收造假。

结果读取：

~~~bash
node -e "const j=require(process.env.TEMP+'/action_eval_m5/action_eval_summary.json'); console.log(JSON.stringify(j.m5Acceptance,null,2)); console.log('class2',JSON.stringify(j.perClass['2'])); console.log('durationMs',j.durationMs)"
~~~

记录四个机读值：

~~~text
M5_ACTION_COUNT=<summary.m5Acceptance.actionCount>
M5_ACCURACY=<summary.m5Acceptance.accuracy>
M5_FALSE_TRIGGERS_PER_MIN=<summary.m5Acceptance.falseTriggersPerMin>
M5_CLASS1_RECALL=<summary.perClass["1"].recall>
M5_CLASS2_RECALL=<summary.perClass["2"].recall>
M5_BYTE23_MATCH=<50/50 或失败数>
M5_TLV92=OK|FAIL
M5_DURATION_MS=<summary.durationMs>
M5_RESULT=PASS|FAIL
~~~

### 3.3 协议一致性抽检（byte23 / TLV 0x92）

目的：证明 <code>/api/action</code> 的 <code>raw</code>/<code>class</code>/<code>conf</code> 来自板端真实字节，而不是网关自造；同时确认 TLV 0x92 只在 GET_STATUS ACK 尾部追加。

#### 3.3.1 byte23 抽检 ≥50 帧

前置：M4c 位流已烧、面板已停（Windows 同址同端口 UDP 是先绑定者独占收包；不停面板抓不到）、1234 空闲。**当前 G 位流 byte23 恒 0，抽检只能得到 0，不能证明动作通路**。

抓包（收满 50 个不同 frameIdx 的首包后自动退出；日志落 TEMP）：

~~~bash
cd E:/workspace/FPGA_Comp/host/app
node - > "$TEMP/m5_byte23.log" <<'JS'
const dgram = require('node:dgram');
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const seen = new Map();
sock.on('message', (m) => {
  if (m.length < 24 || m[0] !== 0xf0 || m[1] !== 0x5a || m[2] !== 0xa5 || m[3] !== 0x30) return;
  if ((m[6] & 0x80) !== 0) return; // 跳过 CTRL/ACK
  const frame = (m[10] << 8) | m[11];
  if (seen.has(frame)) return;
  seen.set(frame, m[23]);
  console.log('FRAME=' + frame + ' BYTE23=0x' + m[23].toString(16).padStart(2, '0'));
  if (seen.size >= 50) sock.close();
});
sock.bind(1234, '192.168.1.102', () => console.log('READY 192.168.1.102:1234'));
setTimeout(() => {
  if (seen.size < 50) { console.error('TIMEOUT frames=' + seen.size); process.exitCode = 4; }
  try { sock.close(); } catch {}
}, 30000);
JS
wc -l "$TEMP/m5_byte23.log"
~~~

然后重启最新面板，按 <code>/api/action</code> 或 <code>action_eval</code> 的 CSV 记录 ≥50 个 <code>frameIdx + raw</code>，与 <code>m5_byte23.log</code> 逐帧对照：

~~~bash
curl -s http://127.0.0.1:8787/api/action
~~~

判据：同 frameIdx 的 byte23 与 <code>/api/action</code> 的 <code>raw</code> **50/50 相等**（至少 50 帧）；记录 <code>M5_BYTE23_MATCH=50/50</code>。不等即 F-02/F-12，停止 M5。

#### 3.3.2 TLV 0x92 尾追

前置：M4c 位流；面板停、1234 空闲。用独立抓包器发 GET_STATUS 并抓板端 ACK（**不要用 1234 上的面板同时抓**）：

~~~bash
cd E:/workspace/FPGA_Comp/host/app
node tools/udp_sniff_v3.mjs --bind 192.168.1.102 --port 1234 --n 200 --ms 8000 --send-downlink --dump "$TEMP/m5_ctrl.bin"
~~~

判据：

- ACK 是 CTRL 包（<code>flags &amp; 0x80</code>），<code>CTRL_LEN=71</code>（整包 103 B）；旧 68 字节 ACK 仍应被接受，不硬编码 CTRL_LEN。
- 载荷尾部 3 B 为 <code>92 01 &lt;byte23&gt;</code>，且 <code>&lt;byte23&gt;</code> 与该 ACK 对应的同一帧 byte23 相同；TLV 不上心跳。
- 记录 <code>M5_TLV92=OK|FAIL</code>；工具只打印载荷前 32 B，**尾部必须看 <code>m5_ctrl.bin</code> 原始字节**（按 CTRL 包边界，不要全局搜 <code>92 01</code>）。
- **未实测（需 M4c 位流 + 板卡）**；本方案不提供伪造 TLV 的脚本。

### 3.4 class2 展示条件（附加，不是 action_eval 的第四门槛）

- 若对外宣称支持 class2：<code>perClass["2"].recall ≥ 0.75</code>，且 summary 中 class2 的 support ≥ 40（否则样本不足，不能下结论）。
- class2 recall 在 0.75~0.85：只能标“实验性 class2”，不能作为验收卖点；需在报告里写明。
- class2 recall < 0.75：按 §4 回退两类（class1 + none），**不要靠调低 0.75 或删测试来通过**。
- 该 0.75 来自项目决策口径（跨会话 class2 recall 历史 0.2289~0.5415，见登记册 C11），**不是工具自动门槛**；来源标“决策/文档”。

#### 3.4.1 类别数裁决门槛（离线 LOO，硬门槛）

M5 现场测试**不是**决定“做几类”的场合——类别数在**离线**就该定死，现场只验证“已经定下来的那套”。因此在上板之前，必须先用会话级 LOO（留一会话）离屏结果过下面这道门：

| 上线形态 | 必须**同时**满足（离线会话级 LOO） | 不满足怎么办 |
|---|---|---|
| **三分类**（none / 手部开合 / 横向挥手） | class2 recall ≥ **0.75** · class1 recall ≥ **0.85** · class0 recall ≥ **0.85** · balanced acc ≥ **0.85** | 回退两分类（§4.2），**不得**只挑好看的那一项报 |
| **两分类**（none / 手部开合） | balanced acc ≥ **0.90** · class1 recall ≥ **0.90** · class0 recall ≥ **0.95** | 不上板，回训练侧改特征/窗口（见 M2b 报告） |

口径要求（缺一项即判定无效）：

- **会话级**切分，不是窗口级随机切分（100 ms 窗高度相关，窗口级切分会泄漏）。
- class2 的 LOO 折数 = class2 会话条数（当前 3 条：<code>210102 / 211950 / 212036</code>）⇒ **每折每类窗数必须一并写出**，并注明“统计意义弱”；support &lt; 40 的类不得下结论（同 §3.4）。
- 固定 test 会话 <code>191905 / 192720</code>（189 窗，**无 class2**）永远不进训练、也不能用于 class2 判决；它只用于回归“官方固定 test 没退化”。
- 量化后（int8）指标与 float 指标都要报；两者 argmax 一致率 &lt; 0.95 视为量化有问题，先修量化再谈上板。
- 门槛来源：项目决策口径（登记册 D15 / C11；历史数字 class2 跨会话 LOO 0.2289~0.5415，M2b CNN 主线 0.4226），**不是 action_eval 的自动门槛**，工具不会替你判。


### 3.5 API 契约抽查

| 请求 | 期望 | 说明 |
|---|---|---|
| <code>GET /api/action</code> | 200；<code>available</code> + <code>frameIdx</code>/<code>class</code>/<code>conf</code>/<code>mapped</code> | 无 v3 帧时 200 + <code>available:false</code>；从未收帧 503 |
| <code>GET /api/action/events?after=-1&amp;timeoutMs=0</code> | 503（从未收帧）或 200 + 事件/超时 | 前端首次用 after=-1 只初始化 seq，不执行历史动作 |
| <code>GET /api/action/config</code> | 200；<code>source:"ui"</code> 或 <code>"default"</code> + map | 网关只读镜像；持久化在浏览器 localStorage |
| <code>POST /api/action</code> | 405“本接口只读” | 不得写配置 |
| <code>GET /api/nope</code> | 404 + endpoints | 未知接口 |

命令示例：

~~~bash
curl -s -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8787/api/action
curl -s -w '\nHTTP=%{http_code}\n' 'http://127.0.0.1:8787/api/action/events?after=-1&timeoutMs=0'
curl -s -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8787/api/action/config
curl -s -X POST -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8787/api/action
~~~

### 3.6 前端动作卡片 + 录制映射（M4-ui，人工）

1. 新面板打开动作卡片；无动作帧时显示“等待板卡动作引擎”，有帧后显示 class/conf。
2. 在卡片里配置：class1 → <code>startRecord</code>/target raw，class2 → <code>stopRecord</code>/target raw，<code>minConf</code>=8；刷新页面确认 localStorage 持久化；点恢复默认确认 source 变 <code>default</code>。
3. 做一次 class1：面板进入“录制中”，<code>row_datas/</code> 出现新的 raw 文件；做一次 class2：停止录制，文件大小稳定。**不要删除用户已有 row_datas**。
4. 动作卡片显示“无数据/等待”不是失败；只有“有动作帧但卡片不更新”才是失败（转 F-12）。
5. <code>action_eval</code> 只读，**不会触发录制**；不要拿它验证录制映射。

---

## 4. 回退方案（具体、可执行）

### 4.1 位流回退到已知 G

前提：G 位流仍在 <code>build/variant_fix6_seam/retina_event.bit</code>，md5 = <code>87cae9539244fe562222bd659929e6be</code>（实测）。

~~~powershell
cd E:/workspace/FPGA_Comp/retina_event
& 'E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat' -mode batch -source tool/program_retina.tcl -log tool/program_rollback_g.log -journal tool/program_rollback_g.jou -tclargs build/variant_fix6_seam/retina_event.bit
~~~

判据同 §2.1.2：<code>PROG_RESULT=OK</code> + EOS HIGH；回退后 pps 应恢复 15k~17k，<code>/api/action</code> 回到“无动作数据”而不是崩溃。**不要用 build_retina.ps1 重新构建 G**（它会覆盖交付锚点，且默认 UART_LINK_EN=0，文档/实测）。

### 4.2 class2 不达标 → 两类

- 触发：§3.4 的 class2 recall < 0.75，或 class2 误触发占主导。
- 动作：M2 重新训练/量化，把 class2 样本并入“无动作/其他”，输出两类模型；host 只展示 class1；M5 用 class1 100 次重跑三门槛。
- 禁止：改 <code>ACT_CLASS_NAMES</code> 把 class2 改名成 class1、删 class2 测试、把 0.75 改成 0.5。

### 4.3 200 MHz 时序不收敛 → 100 MHz

- 触发：WNS < 0 或 failing endpoints > 0。
- 动作：用 M4c 集成后提供的时钟 generic（例如 <code>NN_CLK_MHZ=100</code>，以 RTL 实际参数名为准）重建；重跑时序/资源门；再烧。
- 禁止：现场手改 XDC 压时钟、关闭时序检查、带负 slack 烧板。

### 4.4 资源超预算 → 先砍通道，再砍宽度

按顺序，**每一步都重新构建并记录数字**：

1. 8 lane → 6 lane；
2. 6 lane → 4 lane；
3. 仍超：100 ms 窗口/特征宽度缩减（需 M2 重新训练/量化，属于模型变更，不在 M5 现场“顺手改”）；
4. 仍超：停止 M5，回报 Lead；**不得放宽 §2.1.1 的资源上限**。

### 4.5 准确率/误触发不达标

- 先查标注错误/端口串流/双网关（pps 正常但包被旧进程抢走时，判定会全错）；再查 class2 混淆；最后才怀疑模型。
- 不达标就**不发布**；收集更多数据重训，不调门槛、不删失败样本。
- 误触发高且集中在 class2：优先按 §4.2 回退两类。

### 4.6 面板/API 回退

- <code>/api/action</code> 404：重启最新面板；仍 404 说明部署的不是新 gateway，停止 M5。
- 端口被占：<code>netstat -ano</code> 找 PID，先停旧网关；**不要**让两个进程同时 bind 1234。
- 板卡/网卡：只在 192.168.1.102/24 上验收；改网卡不属于 M5 范围，需用户授权。

---

## 5. 时间预算

| 阶段 | 预计 | 说明 |
|---|---:|---|
| Gate 0（代码/面板/网络/工具） | 30~60 min | 面板重启 5 min；M4c 集成合入与构建脚本检查 15~30 min |
| M4c 构建 | 15~25 min | G 实测 761.9 s；动作引擎增加后留余量；失败重试 +20 min |
| 烧录 + 最小验证 | 5~10 min | JTAG 6 MHz；EOS HIGH；<code>/api/action</code> 变 available |
| 动作采集（3 场） | 40~60 min | 120 次动作 + 背景；用户全程在场 |
| 分析与报告 | 15~20 min | summary/CSV/截图/机读值 |
| **合计** | **约 2~3 h** | 首次构建/时序失败则 +1~2 h；建议预留 4 h 窗口 |

- 构建期间保持系统唤醒（内联 <code>SetThreadExecutionState</code>），不要在构建中让机器待机。
- 动作采集必须用户在场；远程/无人值守只能做合成 E2E，不能代替 M5。
- 若 40 min 内无法过 Gate 0，停止并回报，不要用旧面板/旧位流“先跑一遍”。

---

## 6. 失败分类表

| 编号 | 现象 | 最可能原因 | 判定命令/证据 | 处理 | 阻塞 M5？ |
|---|---|---|---|---|---|
| F-01 | <code>/api/action</code> 404 | 旧面板（当前 PID 12616） | <code>curl -w %{http_code}</code>；body“未知接口” | 按 §3.1 重启最新面板 | 是 |
| F-02 | action 200 但 <code>available:false</code> 持续 | 未烧 M4c / 无 v3 帧 / byte23/TLV 未接 | <code>/api/stats</code> pps；<code>board_rpc --get-status</code>；pktmon | 查 G0-02/03；重烧 M4c | 是 |
| F-03 | <code>/api/action/events</code> 503 | 从未收到完整 v3 帧 | <code>/api/health</code> latestFrame；pps | 先恢复收流；不是接口故障 | 是（动作测试前） |
| F-04 | actionCount < 100 | 标注不足/工具提前退出 | <code>summary.m5Acceptance.actionCount</code> | 补做动作，不调门槛 | 是 |
| F-05 | accuracy < 0.85 | 模型/标注/窗口口径 | confusionMatrix/perClass；小样本校准 | 分析后重训/重测；不调门槛 | 是 |
| F-06 | falseTriggersPerMin ≥ 1 | 背景动作/class2 混淆/分母造假 | CSV 的窗口外判定；<code>durationMs</code> | 查背景；class2 回归 §4.2；**不得虚报时长** | 是 |
| F-07 | class2 recall < 0.75 | class2 跨会话弱（C11） | <code>perClass["2"].recall</code>；support | 回退两类 | 条件（仅宣称 class2 时） |
| F-08 | WNS < 0 / failing endpoints | 200 MHz 不收敛 | <code>inproc_util_impl.rpt</code>；build log | 100 MHz 重建（§4.3） | 是（烧录前） |
| F-09 | LUT/Slices/BRAM/DSP 超上限 | 动作引擎资源超预算 | 同上；对比附录 B | 8→6→4 lane；再减宽度 | 是 |
| F-10 | <code>PROG_RESULT != OK</code> | JTAG 频率/线/驱动/hw_server | program log；6 MHz；设备管理器 | 按 6 MHz/换线/关占用；重试 | 是 |
| F-11 | 重启后 <code>/healthz</code> 非 200 | 网关崩溃/端口占用/网卡漂移 | 启动器窗口；<code>netstat</code>；ipconfig | 先释放端口/改回 192.168.1.102 | 是 |
| F-12 | 有动作帧但卡片不更新 | M4-ui/actionMap 未接好 | <code>/api/action</code> 有数据；浏览器 console | 由 host 修；不要用 action_eval 代替 | 是（UI 验收） |
| F-13 | 录制不开始/不停止 | actionMap 配置/边沿/minConf | 卡片 source=ui；class/conf；localStorage | 重配；查 M4-ui 单测 | 是（UI 验收） |
| F-14 | E2E <code>E2E_RESULT=FAIL</code> | 工具/协议回归 | 重新跑 12411/8911 的 E2E | 先修工具，不在 1234/8787 上试 | 是（工具不可用） |
| F-15 | 两个网关同时 bind 1234 | 旧进程未退/启动器重复 | <code>netstat -ano</code>；pps 正常但 action 不更新 | 杀旧进程；只保留一个 | 是 |
| F-16 | 板卡 ping 不通/假 ping | Meta/Clash TUN 抢路由（H49） | <code>arp -a</code>；实际 UDP pps | 按 H49 处理；不要改防火墙 | 是 |

---

## 附录 A：本机当前实测证据（2026-10-29 22:18，桌面命令）

~~~text
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz
200

$ curl -s http://127.0.0.1:8787/api/stats
stats.pps=15975  stats.packets=95355862  lastFrameIdx=150  counters.badMagic=0/crcFail=0

$ curl -s -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8787/api/action
HTTP=404  error="未知接口: /api/action"

$ curl -s -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8787/api/action/config
HTTP=404  error="未知接口: /api/action/config"

$ node --experimental-strip-types tools/action_eval.mjs --help
AE_HELP_EXIT=0

$ node --experimental-strip-types tools/action_eval.mjs --e2e --udp-port 12411 --ws-port 8911 --out "$TEMP/action_eval_e2e_m5plan"
E2E_RESULT=PASS checks=28 fails=0  （exit 0）
summary: actionCount=5  accuracy=0.5  falseTriggersPerMin=13.904  pass=false（合成 5 次，未达 100 属预期）

$ node tools/board_rpc.mjs --get-status
BOARD_RPC_EXIT=0，16 ms；tlvs 有 fwVer=3/frameIdx=596/evEn=true，**无 action/0x92**

$ git check-ignore -v retina_event/tight_setup_hold_pins.txt
.gitignore:189:/retina_event/tight_setup_hold_pins.txt  retina_event/tight_setup_hold_pins.txt（exit 0）

$ md5sum build/variant_fix6_seam/retina_event.bit
87cae9539244fe562222bd659929e6be
~~~

结论：**当前面板 404、M4b RTL + M4c 集成均未完成、没有 M5 位流**；本方案中的上板命令全部未执行。

## 附录 B：预算基线纠偏（重要）

<code>docs/03_tech/04_action_recognition_selection.md</code> 的百分比基于旧基线（LUT 18,973 / Slices 6,721），但 G 位流实际（实测，<code>build/variant_fix6_seam/inproc_util_impl.rpt</code>）：

| 资源 | G 实测 | 占比 | P1 增量（文档/推断） | M5 预测 | 预测占比 |
|---|---:|---:|---:|---:|---:|
| LUT | 26,334 / 63,400 | 41.54% | +2,800 | 29,134 | 45.95% |
| FF | 16,703 / 126,800 | 13.17% | +3,200 | 19,903 | 15.70% |
| **Slices** | **9,133 / 15,850** | **57.62%** | **+800** | **9,933** | **62.67%** |
| BRAM36 | 76 + RAMB18 9（合计 80.5） | 59.63% | +7 | 87.5 | 64.81% |
| DSP | 7 / 240 | 2.92% | +8 | 15 | 6.25% |

- **Slices 仍是最紧项**（9,133 已 57.62%）；旧文档的 42.40% 会低估压力。M5 资源门按上表，不按 18,973/6,721 的旧百分比。
- 时序基线：WNS +0.243 ns、WHS +0.029 ns、0 失败端点（G，实测）；P1 增量后是否仍非负是 M5 的首要风险，必须构建后实测，不能引用旧报告。

## 附录 C：验收记录模板

~~~text
M5_GATE0=PASS|FAIL
M5_BIT_PATH=E:/workspace/FPGA_Comp/build/variant_m5_action/retina_event.bit
M5_BIT_MD5=<md5>
M5_BUILD_WNS=<ns>
M5_BUILD_WHS=<ns>
M5_BUILD_FAILING_ENDPOINTS=<n>
M5_LUT=<n>  M5_SLICES=<n>  M5_BRAM=<n>  M5_DSP=<n>
M5_PROGRAM_RESULT=OK|FAIL
M5_ACTION_COUNT=<n>
M5_ACCURACY=<0.xx>
M5_FALSE_TRIGGERS_PER_MIN=<x.xxx>
M5_CLASS1_RECALL=<0.xx>
M5_CLASS2_RECALL=<0.xx 或 N/A>
M5_BYTE23_MATCH=<n/50>
M5_TLV92=OK|FAIL
M5_DURATION_MS=<n>
M5_RESULT=PASS|FAIL
M5_NOTE=<失败项/回退动作>
~~~

---

M5PLAN_OK=1
