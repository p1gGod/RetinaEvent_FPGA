<div align="center">

# 仿视网膜事件驱动视觉系统

**AMD 自主选题 · 初级组**
**器件：XC7A100T-FGG484-2（Artix-7）**

纯 Verilog RTL 事件驱动视觉前端，无软核。

</div>

## 1. 作品与赛道

作品面向静态场景占多数的视觉前端。OV5640 采集 800×480 画面。FPGA 内只输出亮度变化事件。事件在片上完成整形与二分类手势判别。全部逻辑用 Verilog RTL 实现，不依赖软核。

事件流经千兆以太网回传上位机。板上当前运行 `variant_act8_final`。资源、时序与位流见第 6 节。

设计细节见 [设计报告](report/design_report.md)。系统说明见 [作品说明书](docs/01_product/product_manual.md)。

## 2. 这是什么

系统在 FPGA 内把 800×480 画面转换为 400×240 亮度变化事件。片上完成事件整形与 100 ms 窗二分类手势判别。事件流与动作状态经千兆以太网回传上位机。

## 3. 提交目录对照表

| 官方目录 | 本仓库路径 | 里面是什么 |
| --- | --- | --- |
| `src/` | `retina_event/src/` | 自研 RTL：事件生成、事件整形、动作推理、显示与回传 |
| `sim/` | `sim/` | 73 个 testbench、NN 仿真证据与波形脚本 |
| `build/` | `build/`、`build/variant_act8_final/` | 构建与烧录脚本、act8 交付位流与时序/资源/DRC 报告 |
| `board/` | `board/`、`retina_event/prj/retina_event.srcs/constrs_1/new/pin.xdc` | 引脚与时序约束、JTAG/Flash 烧录脚本、板级测量表 |
| `data/` | `nn/`、`docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md` | 数据集统计与侦察结果、数据采集记录说明（原始录像与 CSV 不进包） |
| `skill/` | `skill/` | 三项可复用的 FPGA 工程技能包 |
| `report/` | `report/` | 设计报告、评测报告、图表与机读证据 |

上表是仓库路径。提交包内目录名与文件名按官方 3.3.5.4 全部 ASCII 小写（如 `docs/06_facts`、`board/readme.md`、`report/evidence/pack_ok.log`），大小写例外只有官方点名的 `README.md`、`skill/README.md` 与任务书要求的 `LICENSE`。包内改名与链接改写由 `report/tools/normalize_pack.mjs` 与 `fix_pack_links.mjs` 自动完成，映射表在 `name_map.json`。

## 4. 快速复现

环境为 Vivado 2020.2 与 ModelSim SE 2020.4。官方推荐 Vivado 2026.1 或 2025.2。本工程在 2020.2 上完成全部构建与时序复跑。迁移到 2026.1 的差异本版未测量。

以下命令在仓库根目录执行。`vivado.bat` 与 `pwsh` 需要在 PATH 中。命令中的相对路径以仓库根为基准。

### 步骤 0：准备厂家依赖（仅完整构建需要）

公开仓库与提交包不包含正点原子厂家 RTL，版权归正点原子，见 NOTICE（文件 NOTICE，未随包发布）。完整综合与实现需要 26 个驱动文件，路径、字节数与 sha256 见 [vendor_manifest.json](vendor_manifest.json)。

来源为正点原子达芬奇Pro 随板资料中的例程 37（摄像头 → DDR3 → LCD）与例程 60（以太网协议栈）。私有开发仓可从 `exp_ov5640_lcd_eth/prj_src/rtl/` 取；公开克隆请按清单的 `path` 放入 `retina_event/ref_original/`。

```powershell
# 0a) 私有仓已归档厂家源码时，一键补齐；-Check 只检查不拷贝
powershell -NoProfile -ExecutionPolicy Bypass -File build/setup_vendor_rtl.ps1 -Check

# 0b) 校验清单：26 条路径、字节数与 sha256
powershell -NoProfile -ExecutionPolicy Bypass -File build/check_vendor_manifest.ps1
```

第二条命令输出 `VENDOR_MANIFEST_OK=1` 才继续构建。厂家源码目录缺失时，校验脚本会改验 `retina_event/ref_original/` 中已放置的文件。

只做仿真与证据复核不需要厂家文件：`sim/tb/` 与 `run_sim.ps1` 自包含（73 个 `tb_*.v`，`.f` 不引用 `ref_original/`），可直接执行步骤 3。包内没有 `retina_event/` 前缀，改用第 4.1 节的包内命令。

```powershell
# 1) 版本核对：应为 Vivado 2020.2
vivado.bat -version

# 2) 综合、实现、生成位流：默认策略，产物写 build/variant_<tag>
cd retina_event
$env:RETE_TAG = "act8"
$env:RETE_GENERICS = "ETH_EN=1"
vivado.bat -mode batch -source tool/build_inproc.tcl -tclargs --full

# 3) 仿真：任一 testbench，退出码 0 表示 TEST_RESULT=PASS
cd ..
pwsh -NoProfile -File build/run_sim.ps1 -Tb tb_retina_core
```

上面是默认策略命令。本仓库交付位流 `variant_act8_final` 用另一套脚本构建，复现步骤如下：

```powershell
cd retina_event
$env:RETE_TAG = "act8"
$env:RETE_GENERICS = "ETH_EN=1"
# Explore + phys_opt：第一轮默认策略 WNS +0.188 ns，第二轮 +0.215 ns，取优后作为交付
vivado.bat -mode batch -source tool/build_inproc_v7.tcl -tclargs --full
```

两套脚本的差别只在 `opt_design`/`place_design`/`route_design` 的 directive 与 `phys_opt_design` 一处，其余流程相同，产物都写 `build/variant_<tag>/`。位流可复现性以**载荷哈希**判断：`.bit` 文件头含构建时间，整文件 md5 不可复现；按文件头 `e` 字段解析载荷偏移后取 md5，交付位流载荷为 2,838,980 B / `dcbcf543210c33cb22625128bc5f6b97`，同一脚本重建可得到逐字节相同的载荷。

工程根默认按脚本位置推导（脚本位于 `tool/`，上溯两级即仓库根/`retina_event`）；可用环境变量 `RETE_ROOT` 覆盖；无需改脚本。仿真的 ModelSim 路径在脚本顶部。

不要用 Vivado 图形界面直接打开 `build/build_inproc_v7.tcl` 重建：工程文件里记录的是开发机的生成目录与厂家文件路径，克隆后打开会报 `Project 1-313` / `1-312`，Vivado 会把 `ref_original/` 与生成目录回退到原开发机路径。重建请走上面的 tcl。

### 4.1 提交包内可执行的链路

提交包按官方八项布局组织，没有 `retina_event/` 前缀；在包根执行：

```powershell
# 仿真：73 个 testbench 自包含，不需要厂家文件（.f 依赖已按包内路径写为 src/rtl/）
pwsh -NoProfile -File build/run_sim.ps1 -Tb tb_retina_core
```

仓库克隆不包含交付位流：`build/` 在 `.gitignore` 中，位流与时序/资源报告不进版本库。要在克隆上重新打包，需先把提交包内 `build/variant_act8_final/` 的六个文件放回 `build/variant_act8_final/`（或按第 4 节命令自行构建），否则打包器报 `MISSING_SOURCE build/variant_act8_final` 并退出 1。

完整位流构建在包内不可执行，原因写在明处：厂家 DDR3/MIG 与显示 RTL 有版权限制，不随包分发；`build/build_inproc*.tcl` 依赖 `prj/retina_event.xpr` 与 `ref_original/`。补齐厂家文件与工程文件的步骤见第 4 节 0a/0b 两条命令，校验用 `check_vendor_manifest.ps1`。包内 `build/variant_act8_final/` 提供交付位流与时序、资源、DRC 报告，用于核对第 6 节数字。

## 5. 交付证据索引

| 证据入口 | 内容 | 首行判据 / 说明 |
| --- | --- | --- |
| [report/design_report.md](report/design_report.md) | 设计报告：选题、架构、RTL、时序与资源 | 文档，正文口径对齐 D8 |
| [report/evaluation_report.md](report/evaluation_report.md) | 评测报告：数据集、训练、离线评估与图表 | 图表见 `report/figures`，判据见 report_eval_ok.log |
| [skill/README.md](skill/README.md) | 三项 FPGA 工程技能包及自检入口 | 目录与 README 校验见 `_check` |
| [report/evidence/report_design_ok.log](report/evidence/report_design_ok.log) | 设计报告机读检查 | REPORT_DESIGN_OK=1 |
| [report/evidence/evidence_poster.log](report/evidence/evidence_poster.log) | 英文海报、演示分镜与平台清单检查 | POSTER_OK=1 |
| [report/evidence/pack_ok.log](report/evidence/pack_ok.log) | 提交包目录、命名与哈希检查 | PACK_OK=1（包内该文件是 00:06 批次快照 `files=567`；本次交付 666 文件 / 25,060,025 B 以下一行 `EVIDENCE_REPACK.log` 的 `TREE_HASH=8b9f987b…` 为准） |
| 冻结双跑证据 `EVIDENCE_REPACK.log` | 文件数、字节数、两次 `TREE_HASH` | REPACK_OK=1（存于仓库证据目录，不入包） |
| 命名合规证据 `PACK_COMPLIANT.log` | 命名、位流入包与路径检查汇总 | PACK_COMPLIANT_OK=1（存于仓库证据目录，不入包） |
| [report/evidence/evidence_readme.log](report/evidence/evidence_readme.log) | 本 README 的链接、数字与禁用词检查 | README_SUBMIT_OK=1 |
| [report/evidence/evidence_license.log](report/evidence/evidence_license.log) | 根 LICENSE 与厂家依赖清单检查 | LICENSE_OK=1（含 VENDOR_MANIFEST_OK=1） |
| [report/evidence/report_eval_ok.log](report/evidence/report_eval_ok.log) | 评测报告与图表机读检查 | REPORT_EVAL_OK=1 |

其余机读证据：`EVIDENCE_DESIGN_REPRO.log`（DESIGN_REPRO_OK=1）、`EVIDENCE_EVAL_BACKFILL.log`（EVAL_BACKFILL_OK=1）、`EVIDENCE_FIG_ACT8.log`（FIGURES_ACT8_OK=1）、`EVIDENCE_FIG_LOWER.log`（FIG_LOWER_OK=1）、`EVIDENCE_REPACK_DRYRUN.log`（REPACK_DRYRUN_OK=1）、冷启动审计记录（`EVIDENCE_REPRO_AUDIT.log`，REPRO_AUDIT_OK=1，仓库内留档，不随包）。表内链接按包内小写文件名书写；仓库内这些证据日志保留大写原名（`EVIDENCE_LICENSE.log`、`EVIDENCE_POSTER.log`、`EVIDENCE_README.log`、`PACK_OK.log`、`REPORT_DESIGN_OK.log`、`report_eval_ok.log`），打包时统一转小写并改写引用，因此链接在包内可点。冻结双跑与命名合规证据（`EVIDENCE_REPACK.log`、`PACK_COMPLIANT.log`）含打包自身哈希，仅留仓库证据目录、不入包。

## 6. 关键指标一屏表

| 指标 | act3c（上次动作实测所用） | act8（当前交付） | 源文件（相对仓库根） |
| --- | --- | --- | --- |
| LUT | 20,559 / 63,400（32.43%） | 22,383 / 63,400（35.30%） | `docs/06_facts/02_metric_register.md`（D8-R2/R12/R3） |
| FF | 11,850 / 126,800（9.35%） | 14,325 / 126,800（11.30%） | 同上（D8-R2/R12/R3） |
| Slice | 7,327（46.23%） | 8,026（50.64%） | 同上（D8-R2/R12/R3） |
| BRAM | 87 / 135（64.44%） | 86.5 / 135（64.07%） | 同上（D8-R2/R12/R3） |
| DSP | 7 / 240（2.92%） | 8 / 240（3.33%） | 同上（D8-R2/R12/R3） |
| IOB | 140（49.12%） | 140（49.12%） | 同上（D8-R2/R12/R3） |
| WNS / TNS / WHS | +0.306 ns；TNS 0，WHS +0.036 ns | +0.215 ns；TNS 0，WHS +0.017 ns | 同上（D8-R1/R12） |
| 事件流回传 | ≈15,940 pps（UDP 包率） | 同链路，本版沿用 | `docs/06_facts/00_current_status.md` §1（D8-H6） |
| 动作回传延迟 | 板上判别 8.80 ms/窗；端到端回传本版未测量 | 板级判别与回传延迟本版未测量 | `sim/nn/EVIDENCE_M3.md`（D8-R5） |
| 板上位流 | `variant_act3c`，2,890,875 B，md5 `a5fff751e20019d7e80a3a953f7f8c5a` | `variant_act8_final`，2,839,107 B；全文 md5 `5ec55ec07c44f2503df63f1bb160a6e6`，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97` | `build/variant_act3c/retina_event.bit`、`build/variant_act8_final/retina_event.bit`（D8-M6/M12） |
| v7 离线留出准确率 | — | 两折 0.9042 / 0.8754（未合并，非 pooled；均值 0.8898），离线非板上 | `nn/out_v7/results_v7_final.json`（D8-A7） |

表中数字全部取自 docs/06_facts 的 D8 口径。原始报告：act3c 在 `build/variant_act3c/`，act8 在 `build/variant_act8_final/`；act3c 作为历史动作实测位流保留。未产生的数字写“本版未测量”，不补猜。

⚠️ **当前上板位流与验收口径**：2026-10-31 17:26 起板上运行的是 `variant_act8_uart`（2,726,527 B，全文 md5 `34843361199dcbea33ec16473a3fe308`，载荷 md5 `210a20fc22ff10d5532cbe03c1689502`，WNS +0.296，LUT 46.16% / BRAM 66.30%），即在 act8 交付逻辑上并联 UART v3 链路（事件回传 + 遥测 + CTRL，115200\~921600 四档），以太网与动作识别部分不变。第 6 节与第 8 节的 A1~A4 验收数字、空场景基线都是在 `variant_act8_final` 上取得；`variant_act8_uart` 只补测了串口链路与判定功能，**未重跑 A1~A4**。两个位流都随包分发：`build/variant_act8_final/`（历史动作验收位流）与 `build/variant_act8_uart/`（当前上板位流，含 `.mcs` Flash 镜像）。

## 7. 许可与第三方

自研 RTL、脚本与上位机代码采用 MIT 许可，全文见 [LICENSE](LICENSE)。第三方清单与厂家版权声明见 NOTICE（文件 NOTICE，未随包发布）。OV5640 驱动、LCD 时序、DDR3 与以太网协议栈来自正点原子达芬奇Pro 随板例程。原始文件放在 `ref_original/`，不随仓库分发，按第 4 节步骤 0 在本地补齐。

## 8. 版本与时间

本版 README 更新于 2026-10-31。板上运行 `variant_act8_final`（v7b 两分类权重 + `MARGIN_MIN=16`，md5 见第 6 节）。该位流于 2026-10-31 02:02 烧板，`DONE_PIN=1` / `EOS=1` / `PROG_RESULT=OK`。空场景零误报已实测（20.1 分钟带录像 + 4 小时连续被动监测，均 0 次；0 事件上界分别 0.149 / 0.0125 次/分）；A1~A4 动作段验收已于同日 15:49–16:26 执行 4 轮（3 轮有效：A3 召回 14/20、19/20、15/20，累计 48/60=0.80；A1/A2 零误触；A4 共 1 条退场过渡），G2（≥0.85）未稳定达标已如实记录。v7 模型离线留出准确率两折 0.9042 / 0.8754（未合并）；评测报告与设计报告对 act8 的口径一致。

class2 横向挥手保持实验性，不随本版部署。位流构建与时序记录见 [当前状态](docs/06_facts/00_current_status.md)。资源与时序口径以 D8 为准。
## 9 已知未达标与风险接受

以下三项在提交时点未达标或未验证，如实列出。判据未达标的记录不修改门限、不重新取样至通过。

| 项 | 状态 | 实测 / 门限 | 处置 |
| --- | --- | --- | --- |
| v7b 模型自动判据 | 未达标（`V7B_MODEL_OK=0`） | 硬负样本 pulse 2（门限 ≤1）；镜像迁移 `d_wave` 0.0196（门限 ≤0.01） | 权重仍作为 act8 部署权重，属显式风险接受，见 [docs/06_facts/03_v7b_deployment_decision.md](docs/06_facts/03_v7b_deployment_decision.md) |
| act8 板级动作指标 | 已测，G2 未稳定达标 | A1~A4 执行 4 轮（3 轮有效）：A3 召回 48/60=0.80（最好 19/20），G2 ≥0.85 未稳定达标；A1/A2 零误触；A4 1 条退场过渡；空场景 241.2 分钟 0 次事件 | 见 `report/evaluation_report.md` §7.1；缺口如实记录，不调门限、不重跑挑结果 |
| act8 时序余量 | 通过但薄 | WNS +0.215 ns（act3c 为 +0.306 ns） | 最差路径在 `udp_merge` 事件包长链，后续版本需预寄存 |

回退判据：若 A1（双手离开画面）出现静止误报，v7b 权重失效，回退 act3c/v5 或重训；若 act8 时序在他人环境不收敛，回退 act7（`variant_act7`，WNS +0.059 ns）。

## 10. 仓库同步与库容（2026-10-31）

私有仓：`https://github.com/scissorlight/FPGA_comp.git`（分支 `main`）。冻结提交 `ee5cd013a3e773e66e3c7fb3cdb87b2535204d92`，本地与 `origin/main` 已一致（31 个提交、74.5 MiB 已同步）。历史冻结包 `submission/retina_event_submission_20261031.zip`（2026-10-31 06:22:30，666 文件 / 25,060,025 B）保留作证据；**当前交付包为 `submission/retina_event_submission_20261101.zip`（2026-11-01，683 文件 / 36,626,595 B 树体积）**，已并入 §7.1 验收回填、串口动作回传与 `variant_act8_uart` 上板位流。两包的 `TREE_HASH`、双跑结果与 zip 校验值记录在仓库内 `report/evidence` 下的 REPACK 日志（按 `pack_map.json` 不入包）。

库容实测（`git ls-tree -r -l HEAD` 全量）：已跟踪 4,998 文件 / 760.6 MiB，`HEAD` 最大单文件 62,915,419 B（板会录制的原始转储 `mtu60_dump_sampled.bin`，超出单文件上限故不入包），`.git` 638 MB。三条红线对照：单文件 100 MB 硬限 ✅（余量 1.59 倍）、单次推送 2 GB 硬限 ✅、官方建议仓库 < 1 GB ✅（占用 64%）。

⚠️ **冻结哈希的适用边界**：`TREE_HASH` 只对应生成它的那一次冻结包（10-31 包 `8b9f987b…`；11-01 包见 REPACK 日志），**不对应本提交之后的仓库树**——`README.md` 与 `report/tools/` 都是打包输入，本节与体检工具落库后再跑打包器会得到新哈希。要复现原哈希须回到冻结提交前的树或重做一次双跑冻结。远端可达性：`git ls-remote` 与 HTTPS 部分克隆（`--depth 1 --filter=blob:none`）均返回同一 HEAD 与 4,998 条文件清单。

红线：单文件不得超 100 MB；单次推送不得超 2 GB；新增大体积实测数据（录像、`raw/*.bin`）不再入库，避免继续侵蚀 < 1 GB 余量。完整复查记录与遗留项（已跟踪 `*.gen/` 产物 1,187 个 / 179.7 MiB 属历史遗留，本轮不处置）见 [docs/07_review/08_phase_review_20261031.md](docs/07_review/08_phase_review_20261031.md)。
