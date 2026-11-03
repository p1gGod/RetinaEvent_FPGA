# 阶段复查：2026-10-31 冻结提交 + GitHub 同步

> 复查人：技术总监（独立复查，不参与本轮写代码）
> 复查日期：2026-10-31（Asia/Shanghai）
> 复查对象：本地 `main` 积压 31 个提交冻结并推送至 GitHub 私有仓 `scissorlight/FPGA_comp` 这一阶段
> 复查方式：**只读**。全程未执行任何 git 写操作、未构建/仿真/烧录、未改动 RTL/host/report 下任何文件
> 结论：**本阶段可以放行**（`PHASE_REVIEW_OK=1`），但存在 2 项需用户/Lead 拍板的收尾事项，见第 9 节

---

## 0. 机读判据

```text
PHASE_REVIEW_OK=1
REVIEW_OK=1
ORIGIN_TIP_MATCH=1
REMOTE_HEAD=ee5cd013a3e773e66e3c7fb3cdb87b2535204d92
SECRET_HITS=0
MAX_BLOB_BYTES=62915419
SIZE_VERDICT=WITHIN_LIMIT
DOC_FILES_UPDATED=4
DEV_AUDIT_REVIEWED=1
```

执行环境：`E:\workspace\FPGA_Comp`，Git for Windows bash，远端 `origin = https://github.com/scissorlight/FPGA_comp.git`（私有）。

| 判据 | 值 | 阈值/要求 | 判定 |
| --- | --- | --- | --- |
| 远端 tip 与本地 HEAD 一致 | 相等 | 必须相等 | ✅ |
| 未推送提交 / 未提交改动 | 0 / 0 | 必须为 0 | ✅ |
| 密钥命中 | 0 | 必须为 0 | ✅ |
| HEAD 最大已跟踪单文件 | 62,915,419 B（59.99 MiB） | < 100 MB 硬限 | ✅ |
| 本次推送最大新增 blob | 15,627,232 B（14.90 MiB） | < 100 MB 硬限 | ✅ |
| 本次推送新增体积 | 78,118,636 B（74.5 MiB） | < 2 GB 硬限 | ✅ |
| 仓库 `.git` 体积 | 626.21 MiB（656,624,467 B）实际 / 638 MiB 磁盘占用 | 官方建议 < 1 GB | ✅（余量约 362~374 MB，见 §8.3） |
| 冻结证据与交付包一致 | 一致 | 口径自洽 | ✅ |

`DEV_AUDIT_REVIEWED=1` 的说明：一线开发 `dev-frontline` 的 `report/tools/repo_size_audit.mjs`（21,605 B）与 `report/evidence/repo_size_audit_20261031.log`（3,861 B，`AUDIT_TIME=2026-10-31T03:28:54.330Z`）在本次复查过程中**已生成并已评审**，其机读数字与本报告实测**逐项一致**（见第 11 节）。其叙述性报告 `docs/07_review/07_仓库同步与库容体检_20261031.md` 在落盘时**仍未生成**，故评审范围限于"脚本 + 审计日志"，不含该文档。

---

## 1. 远端一致性（`ORIGIN_TIP_MATCH=1`）

```bash
$ git remote -v
origin  https://github.com/scissorlight/FPGA_comp.git (fetch)
origin  https://github.com/scissorlight/FPGA_comp.git (push)

$ git rev-parse HEAD
ee5cd013a3e773e66e3c7fb3cdb87b2535204d92

$ git ls-remote origin main        # 走网络实测，非本地缓存
ee5cd013a3e773e66e3c7fb3cdb87b2535204d92	refs/heads/main
[ls-remote exit: 0]
```

本地 `git status --porcelain` **输出 0 行**（工作树干净，无未提交改动、未跟踪残留）。分叉计数：

```bash
$ git status -sb
## main...origin/main

$ git rev-list --left-right --count origin/main...HEAD
0	0

$ git rev-list --count origin/main..HEAD
0
```

其余状态：仅 `main` 一个分支（`remotes/origin/HEAD -> origin/main`）、**无 tag**、**无 stash**、全历史 57 个提交。

**"31 个提交"独立复核**：直接比对远端引用更新记录（reflog 显示本次推送把 `origin/main` 从 `b2947c7` 推到 `ee5cd01`）：

```bash
$ git reflog show origin/main | head -2
ee5cd01 refs/remotes/origin/main@{0}: update by push
b2947c7 refs/remotes/origin/main@{1}: update by push

$ git rev-list --count b2947c7..ee5cd01
31
$ git merge-base --is-ancestor b2947c7 HEAD && echo YES
YES
```

→ **31 个提交**与任务陈述吻合，且 `b2947c7` 是 HEAD 的祖先（线性推进，无强推改写历史）。

提交内容抽检（最近 3 条）：

```text
ee5cd01 基线扩充：act8 空场景连续 4 小时被动监测零事件（2026-10-31）
e90ab74 协作记录收尾统计与冻结证据刷新（78 张卡全数完成）
e8930ac 交付包落盘：zip 校验值、解包复检与 submission 目录忽略
```

---

## 2. 库容实测（`MAX_BLOB_BYTES=62915419`、`SIZE_VERDICT=WITHIN_LIMIT`）

全部数字来自 `git ls-tree -r -l HEAD` 全量遍历（不抽查）：

```bash
$ git ls-tree -r --name-only HEAD | wc -l
4998

$ git ls-tree -r -l HEAD | awk '{s+=$4} END {print s}'
797580981                       # = 760.6 MiB

$ git ls-tree -r -l HEAD | sort -k4 -n -r | head -1
62915419  docs/05_experiments/板会_20261013/raw/mtu60_dump_sampled.bin
```

| 项 | 实测值 |
| --- | --- |
| HEAD 已跟踪文件数 | 4,998 |
| 已跟踪内容合计 | 797,580,981 B = **760.6 MiB** |
| 最大已跟踪单文件 | **62,915,419 B**（`docs/05_experiments/板会_20261013/raw/mtu60_dump_sampled.bin`） |
| > 100 MB 的已跟踪文件 | **0** |
| > 50 MB 的已跟踪文件 | 1（即上表最大文件） |
| `.git` 目录 | **638 MiB 磁盘占用**（`du -sm`）／**626.21 MiB = 656,624,467 B 实际字节**（`git count-objects` + 文件系统遍历，由一线开发独立测得），两者差额为簇对齐与目录项开销 |
| 已跟踪 `*.gen/` 构建产物 | **1,187 个文件 / 188,446,256 B = 179.7 MiB** |

**本次推送体量**（GitHub 2 GB/次推送硬限的现实对象是"新增对象"，故单独实测）：

```bash
$ git rev-list --objects b2947c7..ee5cd01 | awk '{print $1}' \
    | git cat-file --batch-check='%(objecttype) %(objectsize)' \
    | awk '$1=="blob"{s+=$2;n++} END {printf "new_blobs=%d new_bytes=%d new_MiB=%.1f\n",n,s,s/1048576}'
new_blobs=741 new_bytes=78118636 new_MiB=74.5
```

→ 与任务陈述的 "74.5 MiB" 完全一致。

**关键补充实测：100 MB 硬限对"推送内的任何 blob"生效（含新增后又删除的文件）**，因此不能只看 HEAD：

```bash
$ git rev-list --objects b2947c7..ee5cd01 | ... | sort -k2 -nr | head -1
blob 15627232 0a0844669e486f15196c7d62563327e33bca3d54     # 14.90 MiB
$ git rev-list --objects --all | ... | sort -k2 -nr | head -1
blob 62915419                                              # 与 HEAD 最大值相同
```

| 口径 | 最大 blob | 对 100 MB 硬限 |
| --- | --- | --- |
| 本次推送范围 `b2947c7..ee5cd01` | 15,627,232 B | ✅ 余量 6.4 倍 |
| 全历史 `--all` | 62,915,419 B | ✅ 余量 1.59 倍 |

**判定 `SIZE_VERDICT=WITHIN_LIMIT`**，依据三条红线逐项对照：

| 红线 | 限值 | 实测 | 判定 |
| --- | --- | --- | --- |
| GitHub 单文件硬限 | 100 MB | 最大 62,915,419 B（59.99 MiB） | ✅ 通过 |
| GitHub 单次推送硬限 | 2 GB | 本次新增 74.5 MiB | ✅ 通过（余量 27 倍） |
| GitHub 官方建议仓库体积 | < 1 GB | `.git` 638 MB | ✅ 通过（占用 64%，余量约 362 MB） |

---

## 3. 密钥/令牌泄漏扫描（`SECRET_HITS=0`）

扫描对象为 **HEAD 全部已跟踪文本文件**（`git grep -I` 跳过二进制，避免误扫位流与 npz），逐步加严两种口径：

```bash
$ for p in 'oc_sk_' 'ghp_' 'gho_' 'ghs_' 'github_pat_' 'AKIA' 'glpat-' 'xox[baprs]-' \
           'AIza' '-----BEGIN [A-Z ]*PRIVATE KEY-----' 'sk-[A-Za-z0-9]{20,}' 'eyJhbGciOi' ; do
    echo "PATTERN[$p] HITS=$(git grep -I -c -E -- "$p" HEAD -- . | awk -F: '{s+=$NF} END {print s+0}')"
  done
PATTERN[oc_sk_]   HITS=0
PATTERN[ghp_]     HITS=0
PATTERN[gho_]     HITS=0
PATTERN[ghs_]     HITS=0
PATTERN[github_pat_] HITS=0
PATTERN[AKIA]     HITS=23      # ← 需甄别
PATTERN[glpat-]   HITS=0
PATTERN[xox[baprs]-] HITS=0
PATTERN[AIza]     HITS=4       # ← 需甄别
PATTERN[-----BEGIN [A-Z ]*PRIVATE KEY-----] HITS=0
PATTERN[sk-[A-Za-z0-9]{20,}] HITS=0
PATTERN[eyJhbGciOi] HITS=0
```

**`AKIA`(23) 与 `AIza`(4) 全部为 base64 文本偶然命中，非密钥**。逐条比对上下文后确认：

- `AKIA`：23 处集中在 `retina_event/prj/.../ip/ila_sccb/hdl/blk_mem_gen_v8_4_vhsyn_rfs.vhd` 等 Vivado `blk_mem_gen` 生成的**内嵌字体 base64 大块**（14 个文件都是同族 IP 产物），以及 `docs/05_experiments/recording_and_labeling_20261030/evidence_anno.log` 里一段 `font-family: ...; base64,...` 的内联字体。例：`...XgAmBWIFYgAnBWYFZgAoBWoFag...` 这类连续 base64，`AKIA` 是其中 4 个字符的巧合。
- `AIza`：4 处全在 `exp_ov5640_eth60/.../async_fifo_2048x8b/hdl/blk_mem_gen_v8_4_vhsyn_rfs.vhd` 的同类 base64 块中（`...0BLqAIza4DqHIdU9yQg1sYJgPzDw...`），且两个文件互为同一 IP 的副本。

**凭证关键字口径交叉验证**（更宽的关键词，覆盖 `api_key` / `secret_key` / `access_token` / `passwd` / `password=`）：

```bash
$ git grep -I -l -i -E -- 'api[_-]?key|secret[_-]?key|access[_-]?token|passwd|password[[:space:]]*[=:]' HEAD -- .
HEAD:docs/05_experiments/recording_and_labeling_20261030/evidence_anno.log      # 同上，内联字体 base64
HEAD:host/app/tools/annotator/test/core.test.mjs                   # 见下，路径消毒测试
HEAD:host/app/tools/annotator/test/http_selfcheck.mjs              # 见下，路径消毒测试
```

后两条是**安全测试用例**，恰好说明该项目在防路径穿越，而非泄漏凭证：

```text
core.test.mjs:279        assert.throws(() => core.sanitizeRelPath("/etc/passwd"), /绝对路径/);
http_selfcheck.mjs:159   "/media/%2Fetc%2Fpasswd",
```

结论：**`SECRET_HITS=0`**（真阳性为零）。另附一条正面证据：仓库本身不含任何 `.env`、密钥文件或 CI 凭证文件（`git ls-files` 中无 `.env*`、`*.pem`、`*.p12`、`id_rsa*` 命中）。

---

## 4. 冻结证据链核对（只读，未改任何证据文件）

### 4.1 当前冻结口径的唯一权威值

`report/evidence/` 下存在**三个批次**的 TREE_HASH 记录，必须分清，否则会误判"证据互相矛盾"：

| 证据文件 | 冻结时点 | files | bytes | TREE_HASH | 性质 |
| --- | --- | --- | --- | --- | --- |
| `PACK_OK.log` | 2026-10-31 00:06 | 567 | 6,058,877 | `cf249d11…b5d6` | 更早批次（task-49 打包器验证） |
| `EVIDENCE_REPACK.log`@`43cbbbe` | 03:42:47 | 666 | 25,057,941 | `2b4d7911…e8fe` | 中间批次 |
| `EVIDENCE_REPACK.log`@`e90ab74` | 03:45:10 | 666 | 25,057,953 | `e0d3e6a2…1a31` | 中间批次（协作记录改字） |
| **`EVIDENCE_REPACK.log`@HEAD** | **06:22:30** | **666** | **25,060,025** | **`8b9f987b6c1ec78865d47d08f1e8987b86bdb2dcd994276bb1cdc588ee321ede`** | **当前交付冻结** |
| `PACK_COMPLIANT.log`@HEAD | 06:22:30 | 666 | 25,060,025 | 同上 `8b9f987b…` | 命名合规，与 REPACK 互证 |

`EVIDENCE_REPACK.log` 头部的冻结声明：

```text
REPACK_OK=1
打包器在同一工作树上连跑两次，`TREE_HASH` 相同（含 2026-10-31 06:22 四小时基线回填后的重冻结）、
文件数与字节数相同、命名检查 `bad=0`、包内相对引用 0 断链。冻结时点：2026-10-31 06:22:30（Asia/Shanghai）。
| PACK_SUMMARY files | 666 | 666 |
| PACK_SUMMARY bytes | 25,060,025 | 25,060,025 |
| TREE_HASH | 8b9f987b…31ede | 8b9f987b…31ede |
```

### 4.2 证据 vs 实际交付包：逐字节吻合

对 `submission/retina_event_submission_20261031.zip`（`submission/` 被 `.gitignore` 忽略，故不入库，但产物在盘上）：

```bash
$ ls -l submission/
-rw-r--r-- 1 Admin 197121 5906588 Oct 31 06:22 retina_event_submission_20261031.zip

$ unzip -l submission/retina_event_submission_20261031.zip | tail -1
 25060025                     748 files
```

拆解 748 这个数：

| 口径 | 值 | 出处 |
| --- | --- | --- |
| zip 条目总数 | 748 | `unzip -l` 汇总行 |
| 其中目录条目 | 82 | 以 `/` 结尾的条目 |
| **文件条目** | **748 − 82 = 666** | 与 `PACK_SUMMARY files=666` **完全一致** |
| zip 内字节总数 | **25,060,025** | 与 `PACK_SUMMARY bytes=25,060,025` **完全一致** |
| NAMECHECK entries | 748 | `EVIDENCE_REPACK.log`（= 文件 + 目录，口径自洽） |

→ 三项独立对齐：**666 文件 / 25,060,025 B / 748 条目**。交付包就是我方证据所述的那一版。

### 4.3 冻结是否被"本轮新提交"破坏 —— 本轮最关键的检查

时间线有 43 秒的可疑间隙，必须查实：

```text
冻结时点            2026-10-31 06:22:30   （EVIDENCE_REPACK.log 声明）
HEAD 提交时间       2026-10-31 06:23:13   （git log，晚 43 秒）
```

且 HEAD 提交 `ee5cd01` 改了 10 个文件，其中 `README.md`、`report/design_report.md` 等**确属打包输入**（见 4.4）。因此必须证明：冻结跑的是"改动后"的树，而不是"改动前"的旧树。

**证法**：HEAD 那笔提交给 README 追加了 act8 四小时基线文案，若冻结包含它，则**包内 README 必然含有同一文案**。

```bash
$ unzip -p submission/retina_event_submission_20261031.zip README.md | grep -n '241.2'
158:| act8 板级动作指标 | 未测量 | A1~A4 动作段验收未执行；空场景 241.2 分钟 0 次事件
     （20.1 分钟带录像 + 4 小时连续监测；95% 上界 0.149 / 0.0125 次/分） | …
```

其中 `241.2`、`0.149 / 0.0125`、`4 小时连续监测` 三个数字**只存在于 HEAD 版本**（`eeb4fd2` 版本写的是"20.1 分钟 0 次、0.149"）。包内 README 的 mtime 也是 `2026-10-31 06:22`，与冻结时点一致。

→ **冻结包含了 HEAD 的全部内容，证据链未被本轮提交破坏，✅ 通过**。

（说明：此处不能用"zip 内文件 sha256 == HEAD 文件 sha256"来比对。打包器会重写包内路径引用，`EVIDENCE_REPACK.log` §4 明确 `NORMALIZE_REWRITTEN_FILES=142 / NORMALIZE_REPLACEMENTS=463`，故文本文件必然字节不同；实测 `report/design_report.md`、`report/evaluation_report.md` 的哈希确实不等，属**预期行为**，不是缺陷。因此改用"新内容是否进入包内"的语义判据。）

### 4.4 一个必须记录的负载点：README 本身是打包输入

这一条直接约束"文档收尾"的操作顺序。`report/tools/pack_map.json` 共 66 条 `mappings`，其中显式收录仓库根 README：

```text
report/tools/pack_map.json:195   "source": "README.md"      ← 打包输入
```

而本次复查允许改的另外三个文件**均不在 mappings 里**（`docs/Lead任务台账.md`、`docs/README.md`、`docs/07_review/*`——全部 docs/ 映射只有 2 条，均与本次无关）。即：

| 本次改动文件 | 是否打包输入 | 改它会不会动 TREE_HASH |
| --- | --- | --- |
| `README.md` | **是**（pack_map 第 195 行） | **会** |
| `docs/Lead任务台账.md` | 否 | 不会 |
| `docs/README.md` | 否 | 不会 |
| `docs/07_review/08_phase_review_20261031.md`（新建） | 否 | 不会 |

**后果**：只要本轮之后又改了仓库根 `README.md`（本轮任务要求就必须改），**在 HEAD 上重跑打包器将不再复现 `TREE_HASH=8b9f987b…`**。这不是本轮引入的缺陷，而是"文档继续演进"与"冻结哈希可复现"之间的固有矛盾；`EVIDENCE_REPACK.log` §10 自己就写了"冻结后若再改文档需重跑本证据"。

**处置建议见 §9.1（需拍板）**。

---

## 5. `.gitignore` 实际生效性（逐条实测）

不是看文件写了什么，而是用 `git check-ignore -v` 逐条问 Git 本身：

```bash
$ for p in submission/ records/ row_datas/ temp_test/ submission/x.zip records/x.json row_datas/x.csv temp_test/x.v; do
    printf "%-24s -> " "$p"; git check-ignore -v "$p" || echo "NOT IGNORED"
  done
submission/            -> .gitignore:206:/submission/     submission/
records/               -> .gitignore:188:/records/        records/
row_datas/             -> .gitignore:186:/row_datas/      row_datas/
temp_test/             -> .gitignore:12:/temp_test/       temp_test/
submission/x.zip       -> .gitignore:206:/submission/     submission/x.zip
records/x.json         -> .gitignore:188:/records/        records/x.json
row_datas/x.csv        -> .gitignore:186:/row_datas/      row_datas/x.csv
temp_test/x.v          -> .gitignore:12:/temp_test/       temp_test/x.v
```

四条规则**全部命中，路径前缀与文件级都对**。再看"目录真的在盘上、但确实一个文件都没混进版本库"（被忽略目录仍可能被 `git add -f` 强塞）：

```bash
$ for d in submission records row_datas temp_test; do ...; done
submission: EXISTS (1 entries)
records:    EXISTS (5 entries)
row_datas:  EXISTS (1 entries)
temp_test:  EXISTS (132 entries)

$ git ls-files submission records row_datas temp_test | wc -l
0
```

→ **磁盘上共 139 个条目，版本库内 0 个**。规则不但是"写了"，而且是"真的挡住了"。

对应证据：`EVIDENCE_REPACK.log` 记录 `FORBIDDEN_PATHS=0`，与此独立实测一致。

### 5.1 一个历史遗留（本轮不动，仅登记）

`*.gen/`、`*.runs/`、`*.cache/`、`*.hw/`、`*.ip_user_files/` 均在 `.gitignore` 中声明忽略（第 1 节 Vivado 生成物），实测当前已有跟踪文件为：

| 类别 | 已跟踪数量 | 判定 |
| --- | --- | --- |
| `*.gen/` | **1,187 个文件 / 179.7 MiB** | ⚠️ **违反本仓自己的 .gitignore 策略（历史遗留）** |
| `*.cache/` | 0 | ✅ |
| `*.runs/` | 0 | ✅ |
| `*.hw/` | 0 | ✅ |
| `*.sim/` | 0 | ✅ |
| `*.ip_user_files/` | 0 | ✅ |

结论：只有 `*.gen/` 一类越界，且占了已跟踪内容的 **23.6%**（179.7 / 760.6 MiB）。这是早期为了"克隆即可重建 IP 产物"而 `git add -f` 进来的，属**历史遗留、非本轮引入**。按本轮纪律**不做任何处置**（禁止删除/移动已跟踪文件）；如需瘦身须单独立项（改写历史 + 强推，风险高），建议**不在此次参赛周期内动**，只登记为 §9.3 的遗留风险。

---

## 6. 文档口径核对

### 6.1 README「提交目录对照表」（第 3 节）—— 逐路径实测

表内 7 行官方目录，实际验证本仓库侧路径：

| 官方目录 | README 指向的本仓库路径 | 实测 |
| --- | --- | --- |
| `src/` | `retina_event/src/` | ✅ 存在 |
| `sim/` | `sim/` | ✅ 存在（`tb_*.v` 实测 **73 个**，与文中"73 个 testbench"一致） |
| `build/` | `build/`、`build/variant_act8_final/` | ✅ 均存在（后者按设计被 `.gitignore:158 /build/*` 忽略，见 6.3） |
| `board/` | `board/`、`retina_event/prj/retina_event.srcs/constrs_1/new/pin.xdc` | ✅ 均存在 |
| `data/` | `nn/`、`docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md` | ✅ 均存在 |
| `skill/` | `skill/` | ✅ 存在 |
| `report/` | `report/` | ✅ 存在 |

→ **对照表与实际文件一致，无断链**。

### 6.2 README「快速复现」（第 4 节）—— 脚本存在性实测

| README 引用 | 实测 |
| --- | --- |
| `build/setup_vendor_rtl.ps1` | ✅ 存在 |
| `build/check_vendor_manifest.ps1` | ✅ 存在 |
| `vendor_manifest.json` | ✅ 存在 |
| `build/build_inproc.tcl` | ✅ 存在 |
| `build/build_inproc_v7.tcl` | ✅ 存在 |
| `build/run_sim.ps1`（第 74 行，仓库内命令） | ✅ 存在 |
| `build/run_sim.ps1`（第 102 行） | ⚠️ 仓库内不存在——**但这是正确的**：该行位于「4.1 提交包内可执行的链路」，原文明确"提交包…没有 `retina_event/` 前缀；在包根执行"，指的是包内路径。仓库侧对应文件为 `build/run_sim.ps1` |

→ **口径正确，两处以"仓库根"和"包根"区分的路径没有写错**。这是一处容易被误判成 bug 的地方，特此记明。

### 6.3 一处需读者注意的口径（非错误，README 已自行披露）

第 3 节把 `build/` 映射到 `build/variant_act8_final/`，但该目录**被 gitignore 忽略、克隆后为空**：

```bash
$ git check-ignore -v build/variant_act8_final/retina_event.bit
.gitignore:158:/build/*   build/variant_act8_final/retina_event.bit

$ git ls-files retina_event/build
build/.gitkeep            # 只有一个占位文件
```

README 第 102/104 行已明确披露："仓库克隆不包含交付位流：`build/` 在 `.gitignore` 中…要在克隆上重新打包，需先把提交包内 `build/variant_act8_final/` 的六个文件放回"。→ **已披露，判定为轻微、可接受**，但克隆方若只看第 3 节表格会短暂困惑，已记入 §9.2。

### 6.4 README「交付证据索引」（第 5 节）—— 两处路径口径说明

表内链接按**包内小写名**书写（如 `report/evidence/pack_ok.log`），仓库内实际为**大写原名**（`PACK_OK.log`）。实测两种形态均可解析：

```text
report/evidence/report_design_ok.log   OK   （小写，包内名）
report/evidence/evidence_poster.log    OK
report/evidence/pack_ok.log            OK
report/evidence/evidence_readme.log    OK
report/evidence/evidence_license.log   OK
report/evidence/report_eval_ok.log     OK   （大写，仓库名）
```

README 第 122 行已解释该约定（"表内链接按包内小写文件名书写；仓库内这些证据日志保留大写原名…打包时统一转小写并改写引用"）。→ **自洽**。

⚠️ **但有一处真实的口径瑕疵，见 §8.2 第 1 项**：表内 `report/evidence/pack_ok.log` 被标注为"提交包目录、命名与哈希检查 / PACK_OK=1"，而该文件在**交付包内**仍然是旧批次内容（`files=567`），与被冻结包的 `files=666` 不一致。

### 6.5 任务台账（`docs/Lead任务台账.md`）—— 文件滞后已补，但**不得据此判断进度**

⚠️ **先纠正一个易犯的误读**：台账是**交接文档**，它自己停更 ≠ 项目进度停摆。本轮实测 git 显示 2026-10-29~10-31 **连续 31 个提交**在推进（见 §6.6），最后一条是 10-31 06:23。**判断进度的唯一依据是 git 提交与实测产物，不是任何一份交接文档的"最后更新"时间。**

复查前该文件的实测状态：206 行 / 52,853 B，头部"最后更新：**2026-10-18 17:35**"，末节为"十、★ 2026-10-18 运动预测与右侧栏滚动条（最后更新 22:40）"，收尾仍停在"用户验收通过后再统一 git 提交…最近提交 4281717"。

→ **只是这份文件自身滞后 13 天未维护**，中间的实际进展全部落在 git 里（且已随本轮推送同步）。**已补**：新增"十一、★ 2026-10-31 冻结提交与 GitHub 同步（收尾）"，其中含"这 13 天实际完成了什么（git 实证）"与**最新里程碑 = v7b 神经网络模型重训**，并同步头部时间戳。

### 6.6 进度的真实锚点：以 git 与实测产物为准（最新里程碑 = v7b 神经网络模型）

**本节是本报告对"当前进度"的定性依据**，替代任何交接文档的叙述。git 实证（`git log --since=2026-10-19`，共 31 条）：

| 日期 | 里程碑 | 代表提交 |
| --- | --- | --- |
| 10-29 | 上位机启动守卫修复；动作识别 M1c/M2/M4 落地 + 阶段复查；M2b 特征研究 | `be03f50`、`357de98`、`6458b41` |
| 10-30 | M4d/M4e（空窗清零、上升沿计数）；长录与标注工具；v5 实机误触实测；act3c 烧录定案；v6 表征实验 + v7 采集记录 | `d8ad664`、`a17bc82`、`945d43a`、`44f6ce3`、`0948345` |
| 10-31 00:00–03:10 | 设计报告七章初稿；十图定稿；海报与演示分镜；act8 烧板回填；**v7b 重训与契约入库**；打包工具链入轨；冻结双跑证据 | `6f41473`、`c868065`、`de83b4d`、`0896e2b`、`5727689`、`fa0f097`、`092b23d` |
| 10-31 03:43–06:23 | 交付包落盘 + zip 校验；TREE_HASH 定版；**act8 4 小时空场景基线**；协作记录收尾；推送同步 | `e8930ac`、`43cbbbe`、`ee5cd01` |

**最新里程碑（用户口径："昨晚跑完的神经网络模型"）——已逐项核实：**

产物时间戳（`find nn -printf` 实测）：

```text
2026-10-31 01:14  nn/out_v7b/model_v7b.pt            ← 重训模型产出
2026-10-31 01:16  nn/out_v7b/golden_vectors.json
2026-10-31 01:27  nn/out_v7b/s100_threshold_sweep.json
2026-10-31 02:43  nn/out_v7b/nn_rom_data_v7b.v       ← ROM/参数/黄金向量落定
2026-10-31 02:43  nn/out_v7b/nn_params_v7b.json
2026-10-31 02:44  nn/out_v7b/INT8_CONTRACT.md
2026-10-31 02:47  nn/REPORT_v7b_部署口径重训.md       ← 报告定稿
```

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 模型 | v7b：训练集混合 s50+s100 窗，评估与部署一律 s100 非重叠窗 | `nn/REPORT_v7b_部署口径重训.md` |
| 判决 | **`V7B_MODEL_OK=0`**——A 组硬负 pulse 2（门限 ≤1）、C 组 `d_wave` 0.0196（门限 ≤0.01）两项未达标，其余通过；**未放宽门限、未挑种子、未事后取整** | 同上 §0 |
| 但仍上板 | 是。权重仍作为 act8 部署权重，属**显式风险接受**（`docs/06_facts/03_v7b_deployment_decision.md`） | 同上 |
| 部署参数 | `MARGIN_MIN=16`、`N_CONSEC=3`、guard 0.5 s、决策节拍 100 ms、不应期 1.5 s | 同上 §1 |
| ROM 一致性 | `PARAMS_ROM_MATCH_OK=1`（5652/5652 words × 13 bit）、`TB_GOLDEN_SELFCHECK_OK=1`（vec=16） | 同上判据表；`nn/_evidence/V7B_CONTRACT_OK.log` |
| 契约 | `INT8_CONTRACT.md` 358 行 / 8 个二级节全命中（`H2_HIT=8/8`） | `nn/_evidence/V7B_CONTRACT_OK.log` |

→ 结论：**项目最新进展 = v7b 神经网络模型已于 2026-10-31 凌晨重训完成并定版（02:47），其结论 `V7B_MODEL_OK=0` 被如实保留、并以显式风险接受的方式部署到 act8**；随后才是冻结与推送。本报告的库容、密钥、冻结链结论都应挂在这条时间线上理解，**与"台账停在 10-18"无关**。

### 6.7 同一晚的第二块产出：官方提交文档全套（按 mtime 实测）

**这一节按"本地文件修改时间"排序取证**（用户提示口径：看最新进展按时间筛文件，而不是看交接文档）。10-31 当天被写过的文件按时间倒序（已剔除 `temp_test/`、`records/` 等忽略区）：

| 时间 | 文件 | 规模 | 性质 |
| --- | --- | --- | --- |
| 06:21 | `report/design_report.md` | 73,751 B | **设计报告**（官方提交物 #3） |
| 06:21 | `docs/04_contest/02_提交物清单.md` | 3,129 B | 提交物总清单与状态 |
| 06:21 | `docs/06_facts/02_metric_register.md` | 14,302 B | D8 口径（报告数字唯一来源） |
| 06:21 | `docs/05_…/act8_empty_baseline_20261031.md` + `EVIDENCE_ACT8_BASELINE.log` | 7,315 / 6,327 B | 4 小时基线证据 |
| 03:44 | `report/llm_collaboration.md` | 18,996 B | **大模型协作记录**（官方要求项） |
| 03:24 | `report/evaluation_report.md` | 60,323 B | **评测报告**（官方提交物 #7） |
| 02:54 | `report/figures/`（f2/f4/f5…/f12 等） | 10 张 SVG + `make_figures.py` 63,602 B | 报告图表定稿 |
| 02:44 | `report/demo_video_script.md` | 5,048 B | **演示视频分镜** |
| 02:34 | `docs/04_contest/05_report_outline_and_style.md` | 9,948 B | 文风与大纲约束 |
| 00:55 | `report/poster_en.svg` / `poster_en.md` | 2,725,488 / 3,969 B | **一页英文海报**（决赛加分项 #5） |
| 00:55 | `report/platform_checklist.md` | 4,800 B | **平台上传材料清单** |

**官方 7 项提交物对照（依据 `docs/04_contest/02_提交物清单.md`）**：

| # | 官方提交物 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 工程包（含综合实现报告、上板、实测、复现脚本） | ✅ | 打包器 `pack_submission.ps1` + `REPACK_OK=1`；act8 位流与时序/资源/DRC 随包 |
| 2 | 技能包 `skill/` | ✅ | 3 个包 + `_check` 自检 |
| 3 | 设计报告 | ✅ | `report/design_report.md` 73,751 B / 7 章 / 22 表 / 14,985 CJK |
| 4 | 目录结构（纯英文小写） | ✅ | `NAMECHECK bad=0`、例外仅 3 条 |
| 5 | 决赛：一页英文 PPT 海报 | ✅ | `report/poster_en.svg` 2.7 MB + `.md` |
| 6 | 平台上传必填（视频/概览图/实物照/授权书/关键词） | 🔶 **部分未完成** | `report/platform_checklist.md`，见 §9.8 |
| 7 | 评测报告 | 🔶 已成稿待回填 | `report/evaluation_report.md` 60,323 B / 8 章 / 12 图 / 221 条数字断言；**act8 动作段 A1~A4 待执行后回填** |

→ **判定：文档侧已基本就绪**（7 项里 5 项 ✅、2 项部分）。**剩余缺口集中在"需要人/实物/签名"的动作上，不是写作缺口**，详见 §9.8。这也修正了一个容易形成的错误印象：昨晚不只是"跑了模型"，**官方提交文档全套也同批定稿了**。

---

## 7. 本轮文档改动（`DOC_FILES_UPDATED=4`）

| # | 文件 | 改动性质 |
| --- | --- | --- |
| 1 | `README.md` | 新增「## 10. 仓库同步与库容（2026-10-31）」小节：私有仓地址、当前提交号、库容三条红线对照与结论 |
| 2 | `docs/Lead任务台账.md` | 新增「十一、★ 2026-10-31 冻结提交与 GitHub 同步（收尾）」；更新头部"最后更新"时间戳 |
| 3 | `docs/README.md` | 仅在第 1 节目录树 `07_调研与审阅/` 下**新增一行**收录本报告 |
| 4 | `docs/07_review/08_phase_review_20261031.md` | 本报告（新建） |

**未改动**（严格遵守白名单）：`report/` 下任何文件（含 `pack_map.json`、`PACK_OK.log`、`EVIDENCE_REPACK.log`、`PACK_COMPLIANT.log`、`repro_audit.md`、`check_report.mjs`）、全部 RTL、`host/`、`submission/`、`temp_test/`、`records/`、`row_datas/`。**未执行任何 git 写操作**（无 commit / push / tag / reset / add / rm --cached），**未构建/仿真/烧录**。

冻结摘要数字（`TREE_HASH`、`PACK_SUMMARY`）**一字未改**，本报告只引用、不重算。

---

## 8. 发现汇总

### 8.1 通过项（6 项）

1. 远端与本地完全一致：`origin/main` = 本地 HEAD = `ee5cd01…`，0 未推送、0 未提交改动、无 tag/stash 游离。
2. "31 个提交 / 74.5 MiB"与任务陈述逐字吻合（`b2947c7..ee5cd01`）。
3. 无密钥泄漏（`SECRET_HITS=0`，含对 `AKIA`/`AIza` 23+4 处 base64 误报的逐条甄别）。
4. 无超限大文件：HEAD 最大 62,915,419 B；推送范围最大仅 15,627,232 B；全历史无 >100 MB blob。
5. `.gitignore` 四条规则实测生效（`submission`/`records`/`row_datas`/`temp_test`，盘上 139 条目、库内 0）。
6. 冻结证据链自洽且包含 HEAD：666 文件 / 25,060,025 B / 748 条目三方对齐，包内 README 含 HEAD 独有的 act8 数字。

### 8.2 需处置项（2 项，均不影响"能否放行"，但影响"档案是否经得起事后核对"）

**P2-1｜包内 `pack_ok.log` 是旧批次快照，与其所在包的文件数自相矛盾。**

- 现象：交付包内 `report/evidence/pack_ok.log`（mtime `2026-10-31 00:06`，未随 06:22 重冻更新）声明
  `PACK_SUMMARY files=567 bytes=6058877`、`TREE_HASH=cf249d11…b5d6`；而该包实际是 666 文件 / 25,060,025 B。
- 影响：官方评委若在包内 `grep TREE_HASH`，唯一拿到的是 `cf249d11…` 与 567，与包本身对不上；而真正的权威冻结证据 `EVIDENCE_REPACK.log`/`PACK_COMPLIANT.log` 按 `pack_map.json` 的 `deny_globs` **有意不入包**（理由见其 §7：含打包自身哈希），于是包内没有任何一处能证明"666 / 8b9f987b…"。
- 定性：**不是本轮引入，也不是哈希算错**；是"权威证据有意出包 + 包内留了旧快照"造成的可核对性缺口。
- 建议（二选一，需 Lead/用户定）：(a) 在 README §5 该行加一句"（该证据为 00:06 批次快照，权威冻结口径见仓库 `EVIDENCE_REPACK.log`，不随包）"，仅改一行文字；(b) 下一版重冻时把 `PACK_OK` 一并重跑，使包内自洽。**本轮未改**（超出本报告"只引用不重算"的纪律，且会进一步偏离已冻结哈希）。

**P2-2｜仓库根 `README.md` 是打包输入，改它会让 `TREE_HASH` 不可复现。**

- 现象：`pack_map.json:195` 显式收录 `README.md`；本轮任务要求改 README，故 HEAD 之后重跑打包器将得到**不同于** `8b9f987b…` 的哈希。
- 影响：交付包 `submission/*.zip`（已冻结、已构建、在盘上）**不受影响**，它仍是 06:22:30 那一版且证据自洽；受影响的是"在最终 HEAD 上能否原地复现该哈希"这一审计属性。
- 定性：预期内的文档演进，非缺陷；`EVIDENCE_REPACK.log` §10 已写明该约束。
- 建议：见 §9.1。

### 8.3 只登记、不建议本轮处理（遗留）

**P3-1｜已跟踪 `*.gen/` 产物 1,187 个 / 179.7 MiB（占已跟踪内容 23.6%）**，违反本仓 `.gitignore` 第 1 节策略，属历史遗留（为"克隆可重建 IP"而 `git add -f`）。处置需改写历史，风险高于收益，**参赛周期内不动**。

**P3-2｜仓库体积余量收窄**：`.git` 实际 626.21 MiB（656,624,467 B），磁盘占用 638 MiB，对官方建议 1 GB 余约 362~374 MB。按本轮 74.5 MiB / 31 提交的速率，剩余预算约够 **4~5 轮**同等规模推送。其中 `GIT_LOOSE_OBJECTS=6152` 尚未归并（见 §11.3 建议 1，可通过一次 `git gc` 回收）。**建议今后大体积实测数据（如 62.9 MB 的 `raw/*.bin`）改走外部存储或发布附件**，不要继续入库。

---

## 9. 待拍板事项

### 9.1 ★ 冻结哈希与后续文档演进的处理（建议：接受现状 + 留档说明）

三选一，建议 **A**：

- **A（推荐）**：接受。交付 zip 已在 06:22:30 冻结且证据自洽；仓库文档（README/台账）继续演进并入库。在台账里写明"`TREE_HASH=8b9f987b…` 对应 `submission/retina_event_submission_20261031.zip`（2026-10-31 06:22:30 冻结），不对应 HEAD 之后的仓库树"，避免后人误判为"复现失败"。**代价**：极小，只需一句话。
- **B**：文档全部定稿后**重跑一次双跑冻结**（`pack_submission.ps1` + `check_pack_paths.mjs`），刷新 `EVIDENCE_REPACK.log`/`PACK_COMPLIANT.log` 与 zip，得到新 `TREE_HASH`。**代价**：需再动 `report/evidence/`（本轮禁区），且要重建交付包，风险与工时都高于 A。
- **C**：回退 README 改动以保哈希。**不推荐**：与任务要求直接冲突，且牺牲文档准确性换一个审计属性，不划算。

### 9.2 是否补一句 `pack_ok.log` 的批次说明（对应 §8.2 P2-1）

建议做 (a)：README §5 该行加一句限定，成本一行字。若选 B（重冻），则 (b) 自然解决。

### 9.3 是否允许队友克隆及使用方式

**可以放心让队友克隆**。除本报告外，一线开发的体检（`repo_size_audit.mjs`）已**实证跑通了克隆**，可作为独立佐证：

```text
git clone --no-hardlinks（本地路径克隆，模拟队友 clone 视角）
CLONE_SECONDS=14.8
CLONE_HEAD=ee5cd013a3e773e66e3c7fb3cdb87b2535204d92
CLONE_HEAD_MATCH=1
CLONE_TRACKED_FILES=4998
CLONE_FSCK_EXIT=0
CLONE_FSCK_TROUBLE_LINES=0
CLONE_BYTES=1454172572   CLONE_MIB=1409
CLONE_OK=1
```

→ 克隆 exit 0、HEAD 一致、文件数一致、`git fsck` 无 trouble（只有 5 个 `dangling blob`，属 `add`/`reset` 的正常残留，无害）。**克隆到盘上约需 1.4 GB**（760.6 MiB 工作树 + 626 MiB `.git`），提前告知队友磁盘需求。

但须口头点明两条（README 已写明，口头再说一次能省一次排障）：

1. 克隆**不含**交付位流：`build/` 被 gitignore，需从提交包取 `build/variant_act8_final/` 六个文件放回，否则打包器报 `MISSING_SOURCE` 并退出 1。
2. 克隆**不能**完整重建位流：厂家 RTL（正点原子，版权限制）不入库，需按 README 第 4 节步骤 0a/0b 补齐 26 个文件并过 `VENDOR_MANIFEST_OK=1`。**只做仿真与证据复核不需要厂家文件**（73 个 tb 自包含）。

### 9.4 dev-frontline 体检产物补评（`DEV_AUDIT_REVIEWED=1`，三份产物全覆盖）

三份产物均已落盘并**全部评审完毕**（详见第 11 节）：

| 产物 | 规模 | 状态 |
| --- | --- | --- |
| `report/tools/repo_size_audit.mjs` | 21,605 B / 508 行 | 已评审（判据实现、密钥特征、克隆逻辑逐段核查） |
| `report/evidence/repo_size_audit_20261031.log` | 3,861 B / 86 行 | 已评审（与脚本判据逐条对齐） |
| `docs/07_review/07_仓库同步与库容体检_20261031.md` | 17,059 B / 291 行 | 已评审（数字口径与风险清单） |

**评审结论：通过（PASS），不作 BLOCK。证据强度 = 中高。**
核心依据：其 9 项机读数字经我**独立复现后逐项一致**，且我另行验证了他未算的去重口径（3,254 唯一 blob / 558.29 MiB，与他的数字完全相同）。

另有 **4 项需补强**（均 P3、不阻断，见 §11.5）：①判据无负对照自证；②密钥 7 条特征存在 4 类覆盖缺口；③克隆走本地路径而非 GitHub，不足以单独支撑"队友视角"；④报告把 `TRACKED_FILES` 列成判据而脚本并不判它。

其中 ③ 与"体检产物是否入库"两项需 Lead 拍板，已并入 §9.5、§9.6。

### 9.5 Lead 拍板项（由 dev 体检报告 §7.3 转来，与我的判断合并）

dev 在 `07_…库容体检_20261031.md` §7.3 提了 3 项，我逐项给意见：

| # | 事项 | 总监意见 |
| --- | --- | --- |
| 1 | 3 个交付物是否入库？ | **建议入库**，但要分清三者的打包影响（⚠️ 我最初判断错了一处，已改正并实测）：<br>**① `report/tools/repo_size_audit.mjs` → 会改变 `TREE_HASH`**。`pack_map.json` 里 `report/tools` 是**目录映射**（包内确有其 `readme.md`），新增文件即新增包内条目。<br>**② `repo_size_audit_20261031.log` → 不影响**。命中 `exclude_globs` 的 `**/*.log`，除非加进 `log_exceptions` 否则不入包；入库需 `git add -f`（与 `report/evidence/` 下既有 21 份证据日志同样处理）。<br>**③ `07_…库容体检_20261031.md` → 不影响**。`docs/` 下只有 2 条映射（`docs/05_…flash_detect.tcl`、`docs/05_…capture_log_v7hands_20261030.md`），本文不在其中。<br>⇒ 若在意"冻结哈希可复现"，**①是唯一有影响的一项**；但 §9.1 已建议接受哈希不复现，故仍建议入库。 |
| 2 | A1/A2 的 213.20 MiB 生成物要不要清？ | **本轮不清**。与 §8.3 P3-1 一致：需 `git rm --cached` + 补 `.gitignore` + 重跑构建验证可重建性，属结构性改动，参赛周期内风险高于收益。 |
| 3 | `.git` 要不要 `git gc`？ | **可以，但须在文档定稿后单独做一次**。见 §11.3 建议 1；`prune-packable=5012` 说明有大量重复松散对象可回收。属 git 写操作，本轮无授权。 |

### 9.6 是否要补做"真实远端克隆"验证（我的新增建议）

现有 `CLONE_OK=1` 是**本地路径克隆**，只能证明本地对象库完整自洽（见 §11.5-Q4）。要拿到"队友真的能从 GitHub 拉下来"的确定性证据，唯一途径是：

```console
$ git clone https://github.com/scissorlight/FPGA_comp.git <tmp>   # 私有仓，需凭据
```

**这是只读操作**（只写临时目录），但**需要 GitHub 凭据/令牌**，超出我方授权，故未执行。**建议**：由用户或 Lead 在其终端跑一次（约 1.4 GB 下载），把 `rev-parse HEAD` 与 `ls-tree -r --name-only HEAD | wc -l` 的结果贴回；若两者分别为 `ee5cd01…` 与 `4998`，则"队友视角"结论由"中高"升为"已确证"。

### 9.7 是否要把密钥扫描扩到历史（我的新增建议）

现有扫描只覆盖 `HEAD` 树（见 §11.5-Q3），不覆盖"曾提交后删除"的历史密钥。鉴于本仓为私有参赛仓、全文本、无 CI 凭据，且我另行用 12 条更宽模式复核同样为 0 真阳性，**风险可接受**。若要彻底闭合，可加一条只读命令：

```console
$ git grep -I -n -E -e '<模式>' $(git rev-list --all) | head   # 或 git log -p 全历史扫
```

成本较高（全历史 57 提交），**建议作为可选项**，不作为放行前置。

### 9.8 ★ 平台上传剩余 4 项（必须由用户本人完成，非写作缺口）

依据 `report/platform_checklist.md`，官方"平台上传必填"6 项里已有 2 项定稿（3 个创新关键词、中英文作品简介），**剩余 4 项为人工/实物动作**。我逐项实测了当前真实状态，确认清单所述属实：

| # | 必填项 | 清单状态 | 我的实测复核 | 为什么只能用户做 |
| --- | --- | --- | --- | --- |
| 1 | **演示视频**（≤180 s / ≤300 MB / 1920×1080 H.264） | 🔶 分镜已定稿，待拍摄 | 分镜 `report/demo_video_script.md`（5,048 B）存在；**仓库内无成片**（`find -iname '*demo*.mp4'` 无命中；`records/` 下 26 个 mp4 是**采集录像**共 863 MB，不是演示片） | 需实拍：板卡+上位机屏同框、U 盘/相机录制、剪辑 |
| 2 | **作品概览图**（长边 ≥1920 px） | 🔶 源图已备，待导出 | 源图 `report/figures/f1_system_arch.svg`（13,241 B）在；**`report/figures/*.png` 实测 0 个**，未导出 | 需跑 `rsvg-convert`/ImageMagick（本机未装）或手工导出 |
| 3 | **开发板实物照**（3 张） | ⬜ 待拍 | 仓库内无实物照 | 需实物、相机、场景布置 |
| 4 | **承诺与授权书** | ⬜ 待用户签 | 仓库内无签名件 | **必须本人手写签名，不代签**（清单 §6 明确） |

> ⚠️ **时间风险最高的是第 1 项**。清单 §2 自己就把"演示视频是刚需"列为两项高风险之首，并要求"事件可视化一完成就开始拍素材，不要留到最后一周"。当前距 2026-10-31 冻结已进入收尾，**成片仍未开拍**——这是本项目当前**唯一的实质进度缺口**（其余均为可选优化或历史遗留）。
>
> 另注：`report/figures/f1_system_arch.svg` 是框图侧，若平台缩略图尺寸下可读性不足，清单 §4 已给降级预案（1600 px / 1280 px）。另需注意清单 §5 的构图约束：**不得出现学校标识、姓名、联系方式**（与海报"不含队伍信息"的要求一致）。

---

## 10. 复查方法声明

- 全部结论均以**只读命令实测**为据，命令与关键输出已随文摘录；未采信任务陈述中的既有盘点，均重新实测（且有 3 处独立复核后与陈述一致：31 提交、74.5 MiB、62,915,419 B）。
- 未执行任何会改变仓库状态的操作：无 git 写操作、无构建/仿真/烧录、未改 `report/` 与 RTL/host、未删除或移动任何已跟踪文件、未改写冻结摘要数字。
- 未对冻结证据做"重跑复算"（那需要跑打包器并写 `temp_test/`，超出本次只读授权）；改用**交付产物与证据的三方数字对齐 + 语义判据**替代，并在 §4.3 说明了为何不能逐字节比对。
- 环境限制：`DEV_AUDIT_REVIEWED=1` 的评审范围限于 `repo_size_audit.mjs` 与 `repo_size_audit_20261031.log`；其叙述性报告当时未生成。

---

## 11. 附：一线开发（dev-frontline）体检产物评审

评审对象（三份均已落盘，按此快照评审）：

| 产物 | 规模 | 状态 |
| --- | --- | --- |
| `report/tools/repo_size_audit.mjs` | 21,605 B / 508 行 | 已评审 |
| `report/evidence/repo_size_audit_20261031.log` | 3,861 B / 86 行（`AUDIT_TIME=2026-10-31T03:34:41.157Z`，`AUDIT_SECONDS=33.7`，`CLONE_SECONDS=14.6`） | 已评审 |
| `docs/07_review/07_仓库同步与库容体检_20261031.md` | 17,059 B / 291 行 | 已评审 |

> ⚠️ `AUDIT_TIME` 是 **UTC**，换算本地为 `2026-10-31 11:34:41 +08:00`。本次评审期间该日志被重新生成过一次（此前版本为 `03:28:54Z` = 本地 11:28：`WORKTREE_DIRTY_TRACKED=0`/`UNTRACKED=1`）；当前版本为 `WORKTREE_DIRTY_TRACKED=3`/`UNTRACKED=3`，与 dev 报告 §0 的说明一致。**所有判据数字在两次运行中未变**，仅工作区脏标记与耗时随并行改动变化。

### 11.1 数字对账：与本报告独立实测逐项一致

这是本次交叉验证的核心——两条彼此独立的取证路径给出同一组数字：

| 指标 | 总监实测（本报告 §2） | 一线开发审计日志 | 一致 |
| --- | --- | --- | --- |
| HEAD | `ee5cd013…204d92` | `ee5cd013a3e773e66e3c7fb3cdb87b2535204d92` | ✅ |
| 远端 `origin/main` | 同上（`ls-remote`） | 同上（`REMOTE_MAIN_MATCH=1`） | ✅ |
| 已跟踪文件数 | 4,998 | `TRACKED_FILES=4998` | ✅ |
| 已跟踪内容字节 | 797,580,981 | `TREE_BYTES=797580981` | ✅ |
| 已跟踪内容 MiB | 760.6 | `TREE_MIB=760.63` | ✅ |
| 最大 blob | 62,915,419 | `MAX_BLOB_BYTES=62915419` | ✅ |
| 最大 blob 路径 | `docs/05_experiments/板会_20261013/raw/mtu60_dump_sampled.bin` | 同 | ✅ |
| `.gen/` 已跟踪数 | 1,187 | `GEN_TRACKED=1187` | ✅ |
| 密钥命中 | 0 | `SECRET_HITS=0`（`SECRET_PATTERNS=7`） | ✅ |

→ 两条独立路径**九项全部一致**，无一处矛盾。这显著提高了本报告结论的可信度（不是同一脚本自我复述）。

**我另行复算、他未计算的两项（也对上了）**：

| 指标 | 他报告的值 | 我的独立复算 | 一致 |
| --- | --- | --- | --- |
| HEAD 唯一 blob 数 | 3,254 | `git ls-tree -r HEAD \| awk '{print $3}' \| sort -u \| wc -l` → **3254** | ✅ |
| 去重后内容体积 | 558.29 MiB | `… \| git cat-file --batch-check` 求和 → **585,408,139 B = 558.29 MiB** | ✅ |
| 已跟踪但被忽略 | 1,289（其中 `.gen/` 1,187） | `git ls-files -ci --exclude-standard \| wc -l` → **1289**；`grep -c '\.gen/'` → **1187** | ✅ |

### 11.2 他提供、本报告未覆盖的两项增量证据（已采纳）

1. **`.git` 精确字节**：`GIT_DIR_BYTES=656,624,467`（`GIT_DIR_MIB=626.21`）。这解释了本报告 `du -sm` 得到的 638 MiB：差额是磁盘簇对齐与目录项开销。`GIT_PACK_MIB=269.38`、`GIT_LOOSE_OBJECTS=6152`、`GIT_IN_PACK_OBJECTS=5012`——**游离对象偏多**，见 11.3 建议 1。
2. **干净克隆实证**：`CLONE_HEAD_MATCH=1`、`CLONE_TRACKED_FILES=4998`、`CLONE_FSCK_EXIT=0`、`CLONE_FSCK_TROUBLE_LINES=0`、`CLONE_OK=1`、`CLONE_MIB=1409`。本报告 §9.3 已据此改写（比我原先仅凭"路径存在性"推断要强得多）。

### 11.3 对 dev 产物的意见（4 条，均为建议非阻断）

1. **建议增加 `git gc` 归并游离对象**（对应 `GIT_LOOSE_OBJECTS=6152`、`prune-packable=5012`）。这是我方 `.git` 偏大的直接原因之一；属**安全的内务整理**（不改动任何提交内容）。⚠️ 但它是 **git 写操作**，本轮总监无此授权，应由 Lead 在文档定稿后统一提交前单独执行一次。
2. **判据阈值建议写明依据**：日志用 `CHECK TREE_MIB=760.63 (<= 800) PASS`，这个 **800 MiB 是自设内部门限**，与 GitHub 的 1 GB 官方建议不是同一口径。建议并列标注，避免后人误以为 800 是平台红线（他的报告 §1 已部分说明，但阈值表未标注"自设"）。
3. **`GEN_TRACKED=1187` 只报告不判定**（日志已注明"只报告，不参与判定"），与本报告 §5.1 定性一致——属历史遗留、本轮不处置。建议保持，**不要**在本轮引入删除已跟踪文件的操作。
4. **报告 §1 把 `TRACKED_FILES` 列成判据，但脚本并不判它**，且其"阈值"写作 `4998（±0）`——取值等于实测值，若真按此实现即为**恒真判据**。这属报告与脚本的口径不一致（脚本 `checks` 数组只有 `TREE_MIB` / `MAX_BLOB_BYTES` / `SECRET_HITS` / `CLONE_OK` 四项）。建议把该行改为"报告项"，与 `GEN_TRACKED` / `CLONE_MIB` 同列。

### 11.4 脚本行为的安全性核查（总监确认）

- 该脚本对 git 的调用**仅有两处 `spawnSync('git', …)`**：一个通用只读执行器（`repo_size_audit.mjs:112`）与一处 `git clone --no-hardlinks`（第 399 行）。实际执行的子命令均为只读（`ls-tree` / `rev-list` / `cat-file` / `ls-remote` / `grep` / `count-objects` / `status` / `fsck`）。
- **未发现** `commit` / `push` / `tag` / `reset` / `add` / `rm --cached` / `filter-repo` 等任何 git 写操作。
- 唯一的写入行为是向 `temp_test/repo_audit_20261031/clone` 做本地克隆，并在结束时 `rmSync(cloneDir, { recursive: true, force: true })` 自行删除（日志 `CLONE_DIR_REMOVED=1`）；目标在 `temp_test/` 内，属 `.gitignore` 覆盖范围，不污染仓库。
- 结论：**该脚本符合本轮"禁止 git 写操作"的纪律**，可作为正式体检工具留用。

### 11.5 对 Lead 四个质疑点的逐条作答

#### Q1｜脚本判据是否与证据日志一致？——**一致**

脚本 `repo_size_audit.mjs:470-476` 定义的 `checks` 与日志 `=== 判据核对 ===` 段逐条对应，无任何"日志有、代码无"或"代码算 A、日志印 B"的情况：

| 脚本判据 | 代码阈值来源 | 日志实际行 | 对齐 |
| --- | --- | --- | --- |
| `TREE_MIB <= 800` | `LIMITS.treeMib = 800`（第 41 行） | `CHECK TREE_MIB=760.63  (<= 800)  PASS` | ✅ |
| `MAX_BLOB_BYTES <= 104857600` | `LIMITS.maxBlobBytes`（第 42 行） | `CHECK MAX_BLOB_BYTES=62915419  (<= 104857600)  PASS` | ✅ |
| `SECRET_HITS = 0` | `LIMITS.secretHits = 0`（第 43 行） | `CHECK SECRET_HITS=0  (= 0)  PASS` | ✅ |
| `CLONE_OK = 1` | 第 447 行 `pass` 三元组 | `CHECK CLONE_OK=1  (= 1)  PASS` | ✅ |
| `REPO_HYGIENE_OK = allPass` | 第 477/497 行 | `REPO_HYGIENE_OK=1`；退出码 `allPass?0:1` | ✅ |

唯一不一致在**报告侧**而非代码侧：报告 §1 表把 `TRACKED_FILES` 标为判据并给 `PASS`（见 §11.3 第 4 条）。

#### Q2｜是否存在恒真判据 / 负对照缺失？——**代码层无恒真判据；负对照确实缺失**

- **无恒真**：4 条 `checks` 每一条都可失败（阈值来自 `LIMITS` 常量，非实测值回填）；`--skip-clone` 时 `cloneOk='SKIP'`，`'SKIP' !== '1'` → 必 FAIL，作者已在注释与报告 §7.1 明写"判据必然不过"，这是**可证伪性良好**的证据。
- **负对照缺失（属实）**：全脚本**搜不到任何 self-test / 反例 / fixture 注入**（`grep -E 'self-?test|negative|反例|NEG_'` 无命中）。也就是说：**没有任何用例证明"若真有密钥/超大文件，本脚本会报错"**。对比同一项目的打包任务（`report/evidence/PACK_OK.log` §4）是**做了**反例验证的（构造 `BADNAME.MD`、20,971,521 B 的 `big.bin` 证明检测器会触发）。这是本次评审**最主要的证据方法学缺口**。
- **影响评估（不阻断）**：因为**数字本身被我第二条独立路径复现**（§11.1 九项 + §11.1 追加三项，合计 12 项全对），所以"检测器是否有效"的风险被交叉验证大幅抵消。**建议补**：加一个 `--self-test` 模式，用 `temp_test/` 下构造的假 token 与 >100 MiB 假 blob 断言 `SECRET_HITS>0`、`MAX_BLOB_BYTES` FAIL。

#### Q3｜`git grep` 的 7 条特征覆盖够不够？——**主场景够，但有 4 类具体缺口**

7 条特征（`oc_sk_` / `sk-` / `ghp_` / `gh[pousr]_` / `\bAKIA[0-9A-Z]{16}\b` / `xox[baprs]-` / 私钥块）覆盖了最主流的云与代码托管平台，且**刻意加了长度下限规避误报**（他实测裸 `sk-` 命中 238 个文件、裸 `AKIA` 命中 14 个文件，均为误报）——这个取舍是对的，比无脑用裸模式更专业。

**但存在以下真实缺口**（我逐条验证过脚本里确实没有）：

| # | 未覆盖的形态 | 为什么现在不报 | 严重度 |
| --- | --- | --- | --- |
| 1 | `github_pat_…`（GitHub **fine-grained** PAT） | `gh[pousr]_[A-Za-z0-9]{36}` 只匹配 classic 家族的 5 个前缀，`github_pat_` 不在其中 | 中（本仓就在 GitHub） |
| 2 | `sk-proj-…`（OpenAI 新版项目密钥） | `sk-[A-Za-z0-9]{20,}` 要求 `sk-` 后**连续** 20 个字母数字，`sk-proj-` 的连字符会打断匹配 | 中 |
| 3 | `AIza…`（Google API key）、`glpat-`（GitLab）、Azure `AccountKey=` | 完全未列 | 低（本项目不涉及） |
| 4 | JWT（`eyJhbGciOi…`） | 未列 | 低 |
| 5 | **扫描范围只到 `HEAD`** | `grepArgs.push('HEAD')`（第 301 行）；**不含历史**。密钥若"提交后被删除"，此扫描漏掉，而 push 后它仍留在 GitHub 对象库 | **中高**（一旦发生就是真泄漏） |
| 6 | `-I` 跳过二进制 | 合理取舍，但意味着二进制里内嵌的凭据扫不到 | 低（本仓全文本为主） |

**交叉缓解**：我另行用 **12 条更宽模式**（含上述 1/2/3/4 与 `eyJhbGciOi`）独立扫过 `HEAD`，同样**0 真阳性**（`AKIA` 23 处、`AIza` 4 处均为 `blk_mem_gen` 内嵌字体 base64 的偶然命中，已逐条甄别）。故 `SECRET_HITS=0` **结论成立**，只是**覆盖率不完整**。补强建议见 §9.7。

#### Q4｜克隆用本地路径而非 GitHub，是否足以支撑"队友视角"？——**部分支撑，不足以单独成立**

- **能证明的**：本地对象库**完整自洽**——`fsck` 退出 0 且 `TROUBLE_LINES=0`、克隆后 HEAD 与源一致、文件数 4998 一致、`--no-hardlinks` 强制真实复制对象（不是硬链接"假装克隆"）。这一层结论是**硬的**。
- **不能证明的**：**队友从 GitHub 经 HTTPS 拉取是否成功**。本地克隆绕过了鉴权、网络、服务端打包完整性、以及 1.4 GB 传输。它是"本地仓库可分叉"的证明，不是"远端可克隆"的证明。
- **间接缓解有三条**（合起来使结论达到"中高"而非"低"）：
  1. `git ls-remote origin main` 是**真的走网络到 GitHub**的往返，返回的 tip 与本地 HEAD 相同（`REMOTE_MAIN_MATCH=1`）；
  2. 推送命令退出码 0——git 的 ref 更新是**原子**的，只有全部对象被服务端接收后 ref 才前进，故"远端已有该 tip"意味着对象已全部到达；
  3. 本地 `fsck` 干净 ⇒ 送出去的字节流内部一致。
- **要拿到确定性证据**，只能真跑一次 `git clone https://github.com/scissorlight/FPGA_comp.git`。它需要凭据，**超出我的授权**，已列为 §9.6 的拍板项。

### 11.6 评审结论汇总

| 维度 | 判定 |
| --- | --- |
| 脚本判据 vs 证据日志 | ✅ 一致（1 处不一致在报告侧，非代码侧） |
| 恒真判据 | ✅ 无（代码层 4 条均可失败，`--skip-clone` 为可证伪范例） |
| 负对照 | ⚠️ 缺失（P3，建议加 `--self-test`） |
| 密钥覆盖面 | ⚠️ 主场景够、有 6 处缺口（P3，结论仍成立，见 §9.7） |
| 克隆证据强度 | ⚠️ 中高，本地克隆不替代远端克隆（P3，见 §9.6） |
| 数字可复现性 | ✅ 12/12 项经我独立复现一致 |
| 只读纪律 | ✅ 无任何 git 写操作 |

**总判定：通过（PASS），不作 BLOCK。** 该产物可作为正式体检工具与归档证据留用；上述 ⚠️ 项均为**证据强度补强**，不改变任何既有结论（`REPO_HYGIENE_OK=1`、`SECRET_HITS=0`、`SIZE_VERDICT=WITHIN_LIMIT`）。
