# 提交工程打包工具（M9h）

本目录把仓库源码整理成比赛官方目录结构，并做文件名合规、单文件体积和幂等检查。
输出固定写到 `temp_test/pack`（已被 `.gitignore` 忽略），不会写仓库根 `submission/`。
工具只读源文件，**不执行 Vivado、不跑综合、不烧录**。

## 一键打包

在仓库根执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File report/tools/pack_submission.ps1 -Out temp_test/pack
```

成功时最后一行是：

```text
PACK_SUMMARY files=<n> bytes=<n> skipped=<n>
```

并在其上一行打印 `TREE_HASH=<sha256>`。`skipped` 统计三类文件：

- 单文件超过 20 MB 被跳过，打印 `SKIP <目标路径> <字节>`；
- 目标名含非 ASCII 且没有 `ascii_alias` 的源文件，打印 `NOASCII_SKIP <源路径>` 并写入输出根 `noascii_skipped.md`（不再静默跳过）；
- 其他不合规组件（空格、非法符号等）打印 `SKIPNAME <源路径> ...` 后被跳过。

`skipped` 只统计超体积和真正无法命名的文件；下划线开头、证据日志、`ascii_alias` 重命名都不计入 `skipped`。

任一必需路径缺失、命名检查失败或出现目标冲突时退出非 0，且**不会**打印 `PACK_SUMMARY`。

映射条目的 `required: false` 与 `optional: true` 等价：源文件尚未交付时打印 `WARN optional-missing` 并跳过，不让整包失败；`required` 顶层数组仍单独检查目标树。

## 快照模式（打包器确定性）

真实工作树在开发期会被并发写。为单独证明打包器本身确定，使用 `-Snapshot`：主程序先按 `pack_map.json` 把应入包的源文件一次性复制到 `temp_test/pack_snapshot/<yyyymmdd-hhmmss>/`，再从该快照打包。

```powershell
# 第一次：创建快照并打包
powershell -NoProfile -ExecutionPolicy Bypass -File report/tools/pack_submission.ps1 -Out temp_test/pack_snap1 -Snapshot
# 第二次：复用同一快照，再打一次
powershell -NoProfile -ExecutionPolicy Bypass -File report/tools/pack_submission.ps1 -Out temp_test/pack_snap2 -SnapshotDir temp_test/pack_snapshot/<yyyymmdd-hhmmss>
```

快照模式打印 `SNAPSHOT_DIR=`、`SNAPSHOT_FILES=`、`SNAPSHOT_BYTES=`；复用再打时多打印 `SNAPSHOT_REUSED=1`。同一个快照连跑两次，若 `PACK_SUMMARY` 与 `TREE_HASH` 完全一致，记 `PACK_DETERMINISTIC=1`。`-Snapshot` 与 `-SnapshotDir` 不能同时用；`-SnapshotDir` 必须位于 `temp_test/pack_snapshot/` 下。

失败前置（复制前检查，避免产出“缺报告”的包）：

- `report/evaluation_report.md` 不存在 -> `ERROR report/evaluation_report.md 不存在：等 task-45 交付后再打包`，退出码 4；
- `report/figures` 下 `*.svg` 少于 8 个 -> 报实际数量并退出 4。

成功时在 `TREE_HASH` 前还会打印 `FORBIDDEN_PATHS=0` 与 `FIGURE_SVGS=<n>`；`FORBIDDEN_PATHS` 非 0 表示包内混入了 `ref_original/` 或 `exp_ov5640_lcd_eth/` 路径，按失败处理（退出码 5）。

## 包内路径检查

打包后运行：

```bash
node report/tools/check_pack_paths.mjs --pack temp_test/pack
```

它做五类检查，全部只读：(1) 解析包内 `report/**/*.md` 正文与链接里的 `figures/` 路径，逐个确认是普通文件；(2) 扫描 `report/**/*.md` 与根 `README.md` 中所有以 `report/`、`src/`、`build/`、`board/`、`skill/`、`docs/` 开头的相对引用，逐个断言在**包内**存在，缺失打印 `DANGLING_REF <from>:<line> -> <path>` 并退出 1；(3) 把仓库源目录别名 `src/hdl` 视作包内 `src/rtl`，命中时打印 `ALIAS_APPLIED` 与命中次数（源目录名到包内目录名），不要求改报告正文；(4) 扫描 `retina_event/`、`nn/`、`host/`、`ref_original/`、`exp_ov5640_lcd_eth/` 等上游路径，计入 `EXTERNAL_REF` 并按唯一路径首次位置各打一条，**不作为断链失败**；(5) 扫 `report/figures/*.svg` 得全集 N，逐个断言至少被报告按相对路径引用，输出 `FIGURES=N refs_ok=N missing_refs=[...]`，并检查 SVG/图表文件名全小写。

跨包引用（`retina_event/`、`nn/`、`host/`、`ref_original/`、`exp_ov5640_lcd_eth/`）不随提交包分发，只计入 `EXTERNAL_REF`，不参与断链失败判定。dry-run 包当前有 33 个唯一跨包路径，按首次出现位置各列一条（清单放在代码块中，避免被检查器当成新的引用）：

```text
- NOTICE
- vendor_manifest.json
- build/build_inproc.tcl
- docs/06_facts/00_current_status.md
- sim/nn/EVIDENCE_M3.md
- build/variant_act3c/retina_event.bit
- build/variant_act3c/timing_deliver.rpt
- build/variant_act7/timing_deliver.rpt
- sim/nn/EVIDENCE_M3j.md
- nn/.venv/Scripts/python.exe
- host/app
- host/app/tools/annotator
- nn/out_v7/results_v7_final.json
- nn/REPORT_s100_部署口径复核.md
- build/variant_act3c/inproc_util_impl.rpt
- sim/nn/EVIDENCE_M3f.md
- nn/REPORT_v7b_部署口径重训.md
- nn/REPORT_v6_表征实验.md
- nn/REPORT_v7_数据集.md
- nn/out_v7b/s100_threshold_sweep.json
- build/variant_act7
- build/act8_romswap.log
- build/variant_act8_final/chosen.txt
- build/variant_act8_final/timing.rpt
- build/variant_act8_final/util.rpt
- sim/nn/EVIDENCE_M3c.md
- nn/REPORT_决策链标定.md
- nn/out_v7/nn_params_v7.json
- nn/v7/v7_feats.py
- nn/v7/intwin.py
- retina_event/src/hdl
- retina_event/sim
- retina_event/tool
```

引用检查的两个口径：**大小写敏感**（逐段用 `readdirSync` 精确匹配，避免 Windows 上 `act8_artifacts.txt` 与 `act8_artifacts.txt` 被误判为同一个文件）；**跳过通配前缀**（如 `board/EVIDENCE_*.log`、`skill/_check/EVIDENCE*.log`，正则只截到通配符前的 `EVIDENCE_`，按通配 token 跳过，不当作真实路径）。缩进代码块里的导出命令输出（如 `f1_overview_1920.png`）不是入包交付物，也跳过。**有图无引用、有引用无文件都失败**；最后打印官方 3.3.5.4 八项对照表。末行 `PACK_PATH_CHECK_OK=1` 表示全通过；有缺失时打印 `MISSING_FIGURE_PATH` 或 `DANGLING_REF` 清单并退出 1。

## 冻结回填（提交包摘要）

提交包冻结后，最后一次真实树打包的摘要回填如下。三个值都是定宽占位，冻结时只替换等长字符，不改变本 README 的字节数；`TREE_HASH` 由 `check_names.py` 对排序后的“相对路径|字节数”清单做 sha256 得到。

```text
files=000000 bytes=0000000000 TREE_HASH=0000000000000000000000000000000000000000000000000000000000000000
```

## dry-run 快照证据

最终冻结前先跑 dry-run：从真实工作树建快照，同一快照连打两次，若 `PACK_SUMMARY` 与 `TREE_HASH` 完全一致记 `PACK_DETERMINISTIC=1`。证据写在 `report/evidence/evidence_repack_dryrun.log`（首行 `REPACK_DRYRUN_OK=1`），记录 files、bytes、TREE_HASH、NAMECHECK、INTERNAL_REFS、INTERNAL_MISSING、EXTERNAL_REF 与 README 检查数字；它不作为最终提交摘要。最终冻结件在真实工作树冻结后生成，二者不混用。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `pack_submission.ps1` | 打包主程序：读映射、复制、生成文件、检查 required、调用命名检查、打印摘要 |
| `pack_map.json` | 唯一映射表：源路径 -> 目标路径、include/exclude、排除规则、required/optional、生成文件 |
| `check_names.py` | 独立命名/体积/清单检查器；可单独跑，也可由主程序调用 |
| `check_pack_paths.mjs` | 检查包内 figures/内部相对引用（大小写敏感）、SVG 逐图引用/大小写与官方八项目录，独立只读运行 |
| `README.md` | 本说明 |

## 官方目录与映射

输出树固定为：`README.md`、`src/rtl`、`src/host`、`src/nn`、`sim/tb`、`sim/nn`、`build`、`board`、`data`、`skill`、`report`、`report/evidence`；根另有 `LICENSE`、`NOTICE` 与 `vendor_manifest.json`。`report/` 下同时带 `figures/`（定稿 SVG 与生成脚本）、`tools/`（本打包工具自身）以及 poster、demo 脚本与平台清单。
映射全部写在 `pack_map.json`，主程序不硬编码源路径：

- `src/rtl` <- `retina_event/src/hdl`；`sim` <- `retina_event/sim`；
- `build` <- `retina_event/tool` 顶层 `*.tcl` / `*.ps1`；另有三个构建产物目录：`build/variant_act8_final`（交付位流 2,839,107 B、`timing.rpt`、`util.rpt`、`drc.rpt`、`chosen.txt`、`md5.txt`）、`build/variant_act3c`（`timing_deliver.rpt`、`inproc_util_impl.rpt`、位流 2,890,875 B）与 `build/variant_act7`（`timing_deliver.rpt`、`util_deliver.rpt`）；`act8_romswap.log` 由 `log_exceptions` 放行；
- `board` <- `pin.xdc`、`retina_event.xdc` 与 JTAG/Flash 烧录脚本；task-72 交付的 `board/readme.md`（原名 `board/readme.md`，按小写规则改名）、`board/measurements.md`、`board/extract_measurements.py` 三条 `required:true`；README 同时链接 `board/board_vs_offline_v5.md` 与 `board/evidence_board_doc.log`，两条以 `required:false` 随包带上，后者由 `log_exceptions` 的 `board/EVIDENCE_*.log` 放行；
- `src/host` <- `host/app` 的 `gateway`、`packages`、`web/src`、`tools` 与配置；排除 `node_modules/`、`dist/`；
- `src/nn` <- `nn` 下的 `.py`、`v6/v7` 的 `.md` 与 13 份中文报告（目标名改为英文 `report_*.md`）；不取 `.npz`、`.pt`、`out*/`；历史探针 `_recon1.py`~`_recon5.py` 已按 lead 批准排除，`v6/*.py`、`v6/readme.md` 与 `_qc_probe.py` 保留（被 v6 报告与两分类证据引用）；
- `data` <- `nn` 的四个小 JSON 与 `docs` 中 v7 实机数据说明（改名为 `data/readme.md`）；不取 CSV 全量；
- `skill` <- `skill/` 的 `.py`、`.md`、`.txt`、`.json`、`.log`；`skill/README.md` 优先用源文件，缺失时用 `pack_map.json` 的 `generated_files` 兜底；`skill/_check/` 及其 `EVIDENCE*.log` 是技能包自检证据，必须进包；
- `report` <- `report/llm_collaboration.md`（必需）；`report/design_report.md` 存在则复制，缺失只打 `WARN optional-missing`；`report/evaluation_report.md` **必需**，缺失时主程序在复制前直接失败；`report/evidence` 的 include 为 `*.log`、`*.json`、`*.txt`、`*.md`、`*.mjs`、`*.csv`、`*.svg`，判据日志、`event_stream_stats.json`、`check_*.mjs` 与 `crossdoc_*` 文档随包；`event_stream_stats.json` 列入 `required`；
- `report/figures` <- 定稿 `*.svg`、`make_figures.py`、`figure_data_table.csv` 与图表辅助脚本；排除 `preview/` 与 `__pycache__/`；
- `report/tools` <- 打包脚本、映射表、`check_names.py` 与本说明，评审可据此重跑打包；排除 `__pycache__/`；
- `report/poster_en.md`、`report/poster_en.svg`、`report/demo_video_script.md`、`report/platform_checklist.md` 各按同名文件复制；
- 根 `LICENSE`、`NOTICE` 与 `vendor_manifest.json`（目标名 `vendor_manifest.json`）进包；
- docs 不整树入包：主程序扫根 `README.md` 与 `report/**/*.md`，把实际出现的 `docs/` 路径动态加入本次映射（目录引用只展开该目录下 `*.md`、`*.txt`、`*.log`）；docs 全树 109 MB 不入包，报告新增 docs 引用会自动跟上。

## 命名规则与改名流程

官方 3.3.5.4 允许目录/文件名（含扩展名）使用字母、数字、下划线、连字符；首字符也可以是这三类字符。实现正则：

```text
^[a-z0-9_][a-z0-9._-]*$
```

`.MD`、`.PNG`、中文目录与空格均不合规；`_check`、`_probe` 这类下划线开头名字合法，必须进包（尤其是 `skill/_check/` 与它的 `EVIDENCE*.log`）。`_recon1.py`~`_recon5.py` 名字合法，但属一次性历史探针，按 lead 批准在映射层排除。

大小写例外只剩三条：根 `README.md` 与 `skill/README.md` 是官方指南点名的固定路径，根 `LICENSE` 是任务书要求的 MIT 许可文件。其余目标名一律 ASCII 小写，包括 `board/readme.md` -> `board/readme.md`、`report/evidence/act8_artifacts.txt` -> `report/evidence/act8_artifacts.txt`、`report/evidence/report_eval_ok.log` -> `report/evidence/report_eval_ok.log`、`docs/06_facts/` -> `docs/06_facts/` 等。

改名由 `normalize_pack.mjs --root <pack> --map name_map.json` 在复制完成后统一执行，规则集中在 `name_map.json` 的 `dirs`（8 条目录映射）、`files`（30 条文件映射）、`basenames`（正文裸文件名改写）与 `content_rules`（`*.f` 依赖清单的 `src/hdl` -> `src/rtl` 等）。改名同时改写包内文本文件（`.md`/`.txt`/`.json`/`.mjs`/`.py`/`.csv`/`.log`/`.tcl`/`.ps1`/`.v`/`.vh`/`.f`/`.html`/`.yml`/`.bat`/`.cmd`/`.sh`）里的路径引用，最后再扫一遍残留，任一 `UNMAPPED`/`LEFTOVER`/`BADPATHS` 非零则打包失败。
不再产出 `noascii_skipped.md`：零跳过时不写文件，确有跳过时写一份命名检查清单到证据目录（文件名 pack_namecheck.txt，仅在有跳过项时生成，避免给评委留空审计产物）。

## 断链收尾

改名后由 `fix_pack_links.mjs --pack <dir>` 做一次链接收尾：包内可解析的仓库风格链接（如 `retina_event/src/hdl`、`host/app`）改写成相对包路径；确实指向包外文件（未随包发布的内部日志、原始录像、厂家驱动）的链接降级为「`文件 <path>，未随包发布`」文本，避免评委点到 404。收尾后 `check_pack_paths.mjs` 的 `INTERNAL_MISSING=0` 与独立链接扫描均为 0。

## 复现前提

打包器读工作树，不读 git。交付位流与三套构建产物目录不在版本库里（`build/` 被忽略），在干净克隆上打包前需先补回 `build/variant_act8_final/`（六个文件）与 `variant_act3c`、`variant_act7` 的报告；缺 `variant_act8_final` 时打包器报 `MISSING_SOURCE` 并退出 1，属预期保护。

## 排除与体积

`pack_map.json` 的 `exclude_globs` 统一排除：`.git/`、`temp_test/`、`records/*.mp4`、`*.jou`、`*.log`、`*.pb`、`node_modules/`、`dist/`、`coverage/`、`__pycache__/`、`.venv/`、`.Xil/`、`*.pyc`、`.gitkeep`，以及只作内部复核的旧版协作说明（中文文件名，留在仓库、不入包）。
判据凭证日志是白名单：`report/evidence/*.log`、`docs/**/EVIDENCE_*.log`、`skill/_check/EVIDENCE*.log`、`board/EVIDENCE_*.log` 由 `log_exceptions` 放行；冻结自证材料 `EVIDENCE_REPACK.log` 与 `PACK_COMPLIANT.log` 含打包自身哈希，故不入包（避免自引用导致哈希不可复现），只在仓库内留档。
单文件上限由 `max_file_bytes` 控制（默认 20 MB）；超限打印 `SKIP` 并计入 `skipped`。

## 审计口径（task-67）

- **绝对路径**：扫描包内 `E:\workspace`、`E:/workspace`、`C:\Users` 等前缀，区分“运行时硬编码”和“注释/帮助文本”。历史探针脚本只在 `pack_map.json` 的 exclude 里排除，不用排除构建、仿真、训练、验证入口来规避问题；入口脚本的 `RETE_ROOT`/脚本自身位置推导由 rtl2/coder2 修改，复扫后的运行时硬编码文件数记入验收证据。
- **厂家 RTL 隔离**：审计以 `vendor_manifest.json` 的 26 个文件为精确清单，逐个断言不在包内；包内 `src/rtl` 与 `sim/` 的厂家名称/「盗版必究」/ALIENTEK 等 RTL 标记为 0。严格文本扫描仍会命中 18 个文件、25 行 `Xilinx` 字样（Vivado 报告头、原语说明注释、证据日志里的工具命令）；这些是工具自身产物或引用，不是厂家 RTL 源码，**严格文本扫描非 0 是已识别并接受的事实**，因此不以“出现 Xilinx 单词”判失败。判定隔离是否成功的证据是 26 文件全部 `NOT_IN_PACK` 且厂家 RTL 标记为 0，而不是全文零命中。
- **匿名**：包内 `LICENSE` 的署名行中性，MIT 正文 5/5，无机构与个人标识。自动扫描保留 0 违规结果；4 条强命中均为技术词或禁则说明文字（逐条列在证据日志的假阳性清单里），供评审复核。
- **大文件**：唯一超过 1 MB 的是 `report/poster_en.svg`（2,725,488 B），内嵌两段 TTF 字体；保留自包含优先于体积的取舍，避免他机缺字体导致版式漂移；无外部 `<image>` 或 `data:image` 引用。

## 非 ASCII 与 NOASCII_SKIPPED

`pack_map.json` 顶层 `ascii_aliases` 给非 ASCII 源路径配置 ASCII 目标，例如：

```json
"host/app/tools/annotator/打开标注.bat": "src/host/tools/annotator/open_annotator.bat"
```

命中别名时打印 `RENAME <源路径> -> <目标路径>`，并按别名目标落盘。没有别名的非 ASCII 文件打印 `NOASCII_SKIP <源路径>`，并逐条写入输出根 `noascii_skipped.md`：

```text
NOASCII_SKIPPED=<n>
- <源路径> — <原因>
```

即使没有跳过项也会生成该文件并写 `NOASCII_SKIPPED=0`；`RENAMES=<n>` 与 `NOASCII_SKIPPED=<n>` 打印在 `TREE_HASH` 前，便于证据直接 grep。`check_names.py` 只检查输出树，不感知别名，所以别名目标必须是合法小写名。

## 命名检查独立用法

```bash
python report/tools/check_names.py --root temp_test/pack \
  --manifest temp_test/pack.manifest.txt \
  --exceptions README.md,skill/README.md,LICENSE,board/evidence_board_doc.log
```

输出末尾：

```text
NAMECHECK entries=<n> bad=<n> skipped=<n>
TREE_HASH=<sha256>
```

退出码：`0` 合规且无超限；`1` 有 BADNAME；`2` 仅超限；`3` 参数/根目录错误。
清单格式为按相对路径排序的 `相对路径|字节数`，`TREE_HASH` 是这份清单的 sha256；连续两次打包该值应一致。

## 反例验证（temp_test 内）

```bash
mkdir -p 'temp_test/pack_negative/中文目录'
printf 'x\n' > 'temp_test/pack_negative/中文目录/readme.txt'
printf 'x\n' > temp_test/pack_negative/BADNAME.MD
truncate -s 20971521 temp_test/pack_negative/big.bin
python report/tools/check_names.py --root temp_test/pack_negative
```

预期：中文目录与 `BADNAME.MD` 打印 `BADNAME`（退出码 1），`big.bin` 打印 `SKIP 20971521`。
再用最小测试映射跑主程序，可验证复制阶段确实跳过超限文件；详见 `report/evidence/pack_ok.log`。

## 证据

`report/evidence/pack_ok.log` 首行 `PACK_OK=1`，记录精确命令、退出码、`PACK_SUMMARY`、连续两次 `TREE_HASH`、`NAMECHECK`、`RENAMES`、`NOASCII_SKIPPED` 与反例输出。
`*.log` 被 `.gitignore` 忽略，提交证据时由负责人使用 `git add -f`（本工具本身不做 git 写操作）。
