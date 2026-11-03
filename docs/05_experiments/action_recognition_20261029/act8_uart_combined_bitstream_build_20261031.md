# act8 + UART_LINK_EN 合体位流构建记录（2026-10-31）

> 对象：`build/variant_act8_uart/retina_event.bit`（新建，未烧板）。
> 动因：现役 `variant_act8_final` 的 `RETE_GENERICS` 只有 `ETH_EN=1`，`UART_LINK_EN` 一直是 RTL 默认值 0（`src/rtl/top/top_retina_event.v:33 parameter UART_LINK_EN = 0`），因此 act 线的 UART 事件回传 / 遥测 / CTRL 通道只存在于源码，未进入现役位流。本次补构建"以太网 + UART 链路"同时打开的合一位流，作为后续上板验证的备选件。
> 结论一句话：**构建成功、时序全正、UART 链路网表实测已例化（`UART_LINK_CELLS=2055`），位流 2,726,527 B / md5 `34843361199dcbea33ec16473a3fe308`；本记录只做构建与网表验证，未烧板、未跑验收。**

## 1. 判据真值

| 判据 | 要求 | 实测 | 结果 |
|---|---|---|---|
| `INPROC_RESULT` | `OK` | `OK`（日志 L7928） | ✅ |
| `INPROC_DONE` | `1` | `1`（日志 L8154） | ✅ |
| `^ERROR:` 计数 | `0` | `0` | ✅ |
| `INPROC_FILESET_GENERIC` | 同时含 `ETH_EN=1`、`UART_LINK_EN=1` | `ETH_EN=1 UART_LINK_EN=1`（日志 L63） | ✅ |
| `UART_LINK_CELLS` | `>=1` | `2055`（post_synth.dcp 实测，见 §4） | ✅ |
| `INPROC_WNS` | `>=0` | `0.296`（日志 L7780） | ✅ |
| `INPROC_WHS` | `>=0` | `0.042`（日志 L7782） | ✅ |
| `RTL_UNCHANGED` | `1` | `1`（`git diff --stat -- retina_event/src` 为空） | ✅ |
| `BIT_MD5` | — | `34843361199dcbea33ec16473a3fe308` | ✅ |
| `BIT_SIZE` | — | `2726527` B | ✅ |
| `PAYLOAD_MD5` | — | `210a20fc22ff10d5532cbe03c1689502`（`PAYLOAD_OFFSET=127`、`PAYLOAD_LEN=2726400`） | ✅ |

构建基线：`git rev-parse HEAD` = `6308691b038b1d303d50c9784e9c6c539d83694d`（`6308691`，"文档与 skill 维护：fpga-board-docs 升级到 2026-10-31 现状（2026-10-31）"，2026-10-31 13:33:35 +0800）。`retina_event/src/**` 与 `tool/build_inproc_v7.tcl` 在本轮前后均未改动。

## 2. 命令原文

```bash
cd /e/workspace/FPGA_Comp/retina_event

RETE_TAG=act8_uart \
RETE_GENERICS="ETH_EN=1 UART_LINK_EN=1" \
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File "E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1" \
  "E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat" \
  -mode batch \
  -source tool/build_inproc_v7.tcl \
  -log build/act8_uart_build.log \
  -journal build/act8_uart_build.jou \
  -tclargs --full
```

说明（均为既有流程，未自创）：

| 项 | 为什么这么写 |
|---|---|
| `RETE_TAG=act8_uart` | `build_inproc_v7.tcl` 在 `RETE_TAG` 非空时把产物写 `build/variant_<tag>/`，避免覆盖现役 `variant_act8_final/` |
| `RETE_GENERICS="ETH_EN=1 UART_LINK_EN=1"` | 两个 generic 通过环境变量注入 tcl，并同时写进工程 fileset 的 generic 设置 |
| `run_awake_cmd.ps1` 包裹 | 执行期间抑制系统待机；新机曾出现"系统待机会把长构建冻结 13 小时"（skill 陷阱 19） |
| `-tclargs --full` | 必须是整条命令行最后一个参数（skill 陷阱 11），否则 Vivado 会把 tclargs 当 tcl 脚本名 |

环境：Vivado v2020.2（`E:/Programs/Xilinx/Vivado/2020.2`），器件 `xc7a100tfgg484-2`，顶层 `top_retina_event`，`-flatten_hierarchy rebuilt -directive Default`，综合文件集 56 个 HDL。全程 CPU/内存正常，未触发待机。

## 3. 日志关键行

日志 `build/act8_uart_build.log`（670,595 B / 654 KiB，8156 行）。以下行号可直接 `sed -n 'Np'` 复核：

| 行号 | 原文（截取） |
|---|---|
| 44 | `INPROC_GENERICS=ETH_EN=1 UART_LINK_EN=1` |
| 46 | `INPROC_TAG=act8_uart` |
| 48 | `INPROC_OUTDIR=E:/workspace/FPGA_Comp/build/variant_act8_uart` |
| 63 | `INPROC_FILESET_GENERIC=ETH_EN=1 UART_LINK_EN=1` |
| 88 | `	Parameter UART_LINK_EN bound to: 1 - type: integer` |
| 281 | `INFO: [Synth 8-6157] synthesizing module 'uart_link' [E:/workspace/FPGA_Comp/src/rtl/comms/uart_link.v:37]` |
| 320 | `INFO: [Synth 8-6155] done synthesizing module 'uart_link' (23#1) [...uart_link.v:37]` |
| 7082 | `INPROC_CELL_ETH_UDP=2443` |
| 7083 | `INPROC_CELL_UART_TLM=0`（该 marker 查的是 `u_uart_telemetry`，本设计未例化，**不能**当 UART 链路证据） |
| 7780 | `INPROC_WNS=0.296` |
| 7781 | `INPROC_TNS=0.000` |
| 7782 | `INPROC_WHS=0.042` |
| 7783 | `INPROC_THS=0.000` |
| 7883 | `write_bitstream completed successfully` |
| 7889 | `INPROC_LUT=29266` |
| 7890 | `INPROC_FF=19638` |
| 7891 | `INPROC_BRAM=89` |
| 7892 | `INPROC_DSP=9` |
| 7928 | `INPROC_RESULT=OK` |
| 8154 | `INPROC_DONE=1` |
| 8156 | `INFO: [Common 17-206] Exiting Vivado at Sat Oct 31 17:13:54 2026...` |

`Parameter UART_LINK_EN bound to: 1`（L88）是"参数真的被顶层绑定成 1"的直接证据，比 fileset 标记更硬；L281/L320 说明 `uart_link` 模块确实被综合。两者与 §4 的网表实测互为三层印证。

6 条 `CRITICAL WARNING` 全部同型：`[Designutils 20-1280] Could not find module 'ila_sccb' / 'ila_dbg'. The XDC file .../ila_v6_2/constraints/ila.xdc will not be read for any cell of this module.` —— 这两个 ILA IP 在当前顶层未例化（调试期残留），其 XDC 自然无处可挂。历史构建同样出现，不影响功能与时序判定。

## 4. UART 链路网表实测（不靠日志）

脚本：`temp_test/lead/check_uart_link.tcl`（新建，仅本地验证用，不落仓库）。做法：`open_checkpoint E:/workspace/FPGA_Comp/build/variant_act8_uart/post_synth.dcp` → `get_cells -hier -quiet -filter {NAME =~ *u_uart_link*}` → 按 `REF_NAME` 交叉验证 → 打印端口方向。

运行：`pwsh -NoProfile -ExecutionPolicy Bypass -File temp_test/run_awake_cmd.ps1 E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source temp_test/lead/check_uart_link.tcl -log <OS temp>/check_uart_link_act8uart.log -nojournal`，exit 0。

| 观测项 | 实测 |
|---|---|
| `UART_LINK_CELLS` | **2055**（`g_uart_link.u_uart_link` 下全部单元：FDRE / LUT / MUXF7 / CARRY4 等） |
| `UART_LINK_MODULES` | 1 → `g_uart_link.u_uart_link` |
| `UART_DL_BRIDGE_CELLS` | 1 → `g_uart_link.u_uart_dl_bridge` |
| `UART_EV_TAP_CELLS` | 1 → `g_uart_link.u_uart_ev_tap` |
| `UART_PORTS` | 2 → `uart_rxd`（IN）、`uart_txd`（OUT） |
| `TOTAL_CELLS` | 62089 |
| `ETH_UDP_CELLS` | 2443（与综合期 `INPROC_CELL_ETH_UDP=2443` 完全一致） |
| `CHECP_TOP` | `top_retina_event` |
| `UART_NETLIST_VERDICT` | `PRESENT` |

即：`generate` 块 `g_uart_link`（`top_retina_event.v:860`）确实被展开，`u_uart_link` / `u_uart_dl_bridge` / `u_uart_ev_tap` 三个子模块都在网表里，串口收发端口也接出来了。`ETH_UDP_CELLS` 与综合期 marker 对上，说明这份 dcp 就是本次构建产物，验证没有张冠李戴。

## 5. 位流与 md5

| 项 | 值 |
|---|---|
| 文件 | `build/variant_act8_uart/retina_event.bit` |
| 大小 | 2,726,527 B |
| 全文件 md5 | `34843361199dcbea33ec16473a3fe308` |
| 载荷偏移 / 长度 | 127 / 2,726,400 |
| 载荷 md5 | `210a20fc22ff10d5532cbe03c1689502` |
| 头长 | 127 B（magic 13 B + `a` 3+64 + `b` 3+13 + `c` 3+11 + `d` 3+9） |
| 头部 `a` 字段 | `top_retina_event;COMPRESS=TRUE;UserID=0XFFFFFFFF;Version=2020.2` |
| 头部 `b` 字段 | `7a100tfgg484` |
| 头部 `c` 字段 | `2026/10/31`，`d` 字段 `17:13:52` |

与现役件同格式（`variant_act8_final` 同样是 `PAYLOAD_OFFSET=127`、`COMPRESS=TRUE`），所以两件的"大小"可直接比较，但**字节数不是逻辑规模的度量**（见 §7）。

## 6. 时序与资源

时序（`variant_act8_uart/inproc_timing.rpt`）：

| 指标 | 值 | 失败项 |
|---|---|---|
| WNS / TNS | `+0.296 ns` / `0.000 ns` | 0 / 98392 |
| WHS / THS | `+0.042 ns` / `0.000 ns` | 0 / 98369 |
| WPWS | `0.000 ns` | 0 / 26964 |

报告原文：`All user specified timing constraints are met.`

资源（`inproc_util_impl.rpt`）：

| 资源 | 用量 | 占比 |
|---|---|---|
| LUT | 29,266 | 46.16% |
| FF | 19,638 | 15.49% |
| BRAM | 89.5 / 135 | 66.30% |
| DSP | 9 / 240 | 3.75% |

DRC（`inproc_drc.rpt`）：101 条，**全部是 Warning，无 Error / Critical**。明细：`BUFC-1` 4、`CHECK-3` 2、`DPIP-1` 7、`DPOP-1` 6、`DPOP-2` 7、`IOSR-1` 9、`PLCK-12` 1、`PLCK-23` 1、`REQP-1709` 1、`REQP-1839` 20、`REQP-1840` 20、`RPBF-3` 22、`RTSTAT-10` 1。与现役件同族（未限制 I/O、无板级约束的部分照旧）。

## 7. 与现役 `variant_act8_final` 的差异

| 项 | `variant_act8_final`（现役） | `variant_act8_uart`（本次） | 变化 |
|---|---|---|---|
| generics | `ETH_EN=1` | `ETH_EN=1 UART_LINK_EN=1` | +UART 链路 |
| UART 链路单元 | 0（未例化） | 2055 | +2055 |
| 位流大小 | 2,839,107 B | 2,726,527 B | **−112,580 B（−3.97%）** |
| 全文件 md5 | `5ec55ec07c44f2503df63f1bb160a6e6` | `34843361199dcbea33ec16473a3fe308` | — |
| 载荷 md5 | `dcbcf543210c33cb22625128bc5f6b97` | `210a20fc22ff10d5532cbe03c1689502` | — |
| LUT | 22,383（35.30%） | 29,266（46.16%） | **+6,883** |
| FF | 14,325（11.30%） | 19,638（15.49%） | +5,313 |
| BRAM | 86.5（64.07%） | 89.5（66.30%） | +3.0 |
| DSP | 8（3.33%） | 9（3.75%） | +1 |
| WNS | +0.215 ns | +0.296 ns | +0.081 ns |
| WHS | +0.017 ns | +0.042 ns | +0.025 ns |
| 实现策略 | `opt/place/route -directive Explore` + `phys_opt_design` | 同（`tool/build_inproc_v7.tcl:199-204`） | 一致 |

**为什么位流变小了、逻辑却变多了**：两件都是 `COMPRESS=TRUE`，字节数是压缩后的结果，取决于内容的可压缩率，不随 LUT/FF 单调增长。本次多出 2055 个单元（UART 链路），资源上涨、时序仍余 0.296/0.042 ns，位流反而小了 3.97% —— 属压缩率波动，不是"逻辑被裁掉"。判断规模只看 LUT/FF/BRAM/DSP 四列。

## 8. 构建耗时与产物

| 项 | 值 |
|---|---|
| 起止 | 2026-10-31 17:03:19 → 17:13:54（635 s / 10 分 35 秒） |
| 综合（synth_design） | cpu 4:35 / elapsed 5:03 |
| 写位流（write_bitstream） | cpu 43 s / elapsed 30 s，峰值内存 3,036 MB |
| 产物目录 | `build/variant_act8_uart/`：`retina_event.bit`、`post_synth.dcp`（9,425,305 B）、`inproc_timing.rpt`、`inproc_timing_synth.rpt`、`inproc_util.rpt`、`inproc_util_impl.rpt`、`inproc_drc.rpt` |
| 无 `.ltx` | 进程内 `write_bitstream` 不写 `.ltx`（`tool/build_inproc_v7.tcl` 注释已说明），故本件**没有** ILA 探针文件 |
| 日志 / 日志回放 | `build/act8_uart_build.log`（670,595 B）、`act8_uart_build.jou` |

耗时与现役件同量级（同 tcl、同策略、同机），未出现异常重试。

## 9. 合规与副作用（如实记录）

**没有做的事**：未烧板、未用 JTAG / Flash、未跑 ModelSim、未做任何 git 写操作（add / commit / push / tag / reset / checkout / update-index 全都没执行）；未改 `retina_event/src/**`、`tool/build_inproc_v7.tcl`、`retina_event/prj/**`；未覆盖 `build/variant_act8_final/` 与 `submission/`。

**构建自己动了一个 tracked 文件**：`build/build_inproc_v7.tcl`（构建 tcl 会把 generic 写进工程文件），被追加了一行 `        <Generic Name="UART_LINK_EN" Val="1"/>`。已用 `sed -i '/<Generic Name="UART_LINK_EN" Val="1"\/>/d'` 删除该行，并复核：行数 996→995，`git show HEAD:build/build_inproc_v7.tcl` 与工作区 `cmp` 字节完全一致，`git hash-object --path` == `git rev-parse HEAD:` == `f4c9ad889afa4d064cce79ab4b6d311b6052d239`，`git diff` / `git diff --raw` / `git diff --stat` 均为空。

但 `git status --porcelain` 仍显示 ` M`：`git diff-files --quiet` 退出 1、`git diff --quiet` 退出 0，即**索引里的 stat 缓存过期，不是内容差异**。按"不做任何 git 写"的约束，我没有执行 `git update-index --refresh`；内容已与 HEAD 一致，后续 `git add` 不会把它当改动。需要刷新的同学可执行 `git update-index --refresh`（或 `git checkout -- build/build_inproc_v7.tcl`）。

**新增的未跟踪/忽略文件**（均被 `.gitignore` 覆盖，`git status` 不显示）：`build/variant_act8_uart/`（见 §8）、`build/act8_uart_build.log`、`.jou`、`retina_event/.Xil/`、`temp_test/lead/check_uart_link.tcl`。现役件 `variant_act8_final/retina_event.bit` 的 md5 仍为 `5ec55ec0…`、mtime 仍是 10-31 01:53，未被触碰。

## 10. 复现

```bash
# 1) 构建（同 §2，约 11 分钟）
cd /e/workspace/FPGA_Comp/retina_event
RETE_TAG=act8_uart RETE_GENERICS="ETH_EN=1 UART_LINK_EN=1" \
  pwsh -NoProfile -ExecutionPolicy Bypass \
  -File ../temp_test/run_awake_cmd.ps1 E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat \
  -mode batch -source tool/build_inproc_v7.tcl \
  -log build/act8_uart_build.log -journal build/act8_uart_build.jou -tclargs --full

# 2) 判据抽查（全部应命中）
grep -nE '^INPROC_(GENERICS|FILESET_GENERIC|RESULT|DONE|WNS|WHS)=|Parameter UART_LINK_EN bound' build/act8_uart_build.log
grep -cE '^ERROR:' build/act8_uart_build.log        # 期望 0

# 3) 网表实测（UART_LINK_CELLS 必须 >0，且 ETH_UDP_CELLS 应与 INPROC_CELL_ETH_UDP 一致）
cd /e/workspace/FPGA_Comp
pwsh -NoProfile -ExecutionPolicy Bypass -File temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source temp_test/lead/check_uart_link.tcl -log /tmp/check_uart_link.log -nojournal
```

## 11. 未做 / 待决策

- **未上板**：本件只到"位流 + 网表"层，UART 事件回传 / 遥测 / CTRL 的真实链路（波特率、帧格式、上位机解析）尚未在板上验证。
- **未替换现役件**：`variant_act8_final` 仍是板上/交付口径的现役位流；是否用本件替换，取决于后续 UART 回传验证结果与 Lead 的烧写窗口安排。
- **未重建冻结包**：`submission/retina_event_submission_20261031.zip` 未动。

ACT8_UART_BIT_OK=1
