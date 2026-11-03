RTL_REVIEW_V8_OK=1
# task-71 act8 独立复核（A 段：ROM/布局/golden/回归/diff 审查；B 段：交付位流/时序/资源独立核对，均已完成）

- 状态：**A 段 + B 段全部完成**（2026-10-31，rtl）。B 段核对交付件 `build/variant_act8_final/retina_event.bit`（Explore 版），时序/资源/位流身份与 `EVIDENCE_M3j.md` 一致；仅发现 1 类 bit 头长度/载荷命名的元数据笔误（2 处表述、同一根因，§9.4/§9.8；不影响交付件）。
- 性质：只读复核。未修改任何 RTL/TB/nn 源文件；未跑 Vivado 综合/实现；未烧板；未做 git 写。
- 脚本与日志：`temp_test/rtl/review8/check_act8.py`、`check_act8_run.log`、`probe_rom_diff.py`、`run_regress20.sh`、`regress_review_v8_run1.log`、`run_regress20b.sh`。
- 结论：ROM 与 v7b params **逐字 MISMATCH=0**；15 段基址与 rom_offsets.json 全等；10 组 golden 的 g1(160 值)+fc(20 值)+fc acc 全等；20 个 TB 回归全绿（一次负载抖动重试 3/3 通过）；act8 源码改动可逐文件隔离为 6 个文件，其中 cfg 与 tb_nn_top 各只改 1 行（md5 还原证明）；交付位流全文件 md5/大小、时序、资源全部与 M3j 证据一致，act8e/act8r 真 payload 逐字节相同。

## 1. 输入与哈希（sha256 / md5，实测）

| 文件 | 哈希 | 说明 |
| --- | --- | --- |
| nn/out_v7b/nn_params_v7b.json | sha256 7f63cdc5dfb1ef82ab700a41ec9460cef9386a926abe199e9db14f773089ef77 | 权重/偏置/SH 权威 |
| nn/out_v7b/nn_rom_data_v7b.v | sha256 4288488d66dd2f22bfc946b0698f29170cbc702ef21a68bcc4a646831e1bc41f | 197,178 B / 5,672 行 |
| src/rtl/nn/nn_rom_data.v | sha256 4288488d66dd2f22bfc946b0698f29170cbc702ef21a68bcc4a646831e1bc41f | 与上者逐字节相同 |
| nn/out_v7b/golden_vectors.json | sha256 364c934b3668ccc3f31e84358c46b07a0e2b970eb5b3613d3c2673632a804596 | 10 组 net_vectors |
| nn/out_v7b/rom_offsets.json | sha256 ccfadfe82f0f778eb8f62ca95bbd113965e4a6033f191e357071471a01abbaf3 | 15 段 |
| sim/tb/tb_nn_engine_v7_vectors.vh | sha256 421004df16df80914ad34a524ef931fd1b974261c9557d5deb495aea76f81039 | 生成物，头注释源 sha=364c934b |
| sim/tb/tb_golden_v7.vh | sha256 d5e359563fdd64e8c2547383fe69ea6522eeb705af61f00af54d325d85753f96 | 生成物，头注释源 sha=364c934b |
| src/rtl/nn/nn_cfg.vh | md5 3325047ce2659039c0934c3bd6a00ddb | act8 仅 MARGIN 行 |
- 勘误（2026-10-31 02:45）：nn/out_v7b/rom_offsets.json 于 02:43 路径归一化重生成（绝对路径改仓库相对 POSIX 路径），sha256 ccfadfe8… → 3796fd55d889f64a94ba41f39f288161c0c168ee6c2f04a6dff1f23d54d0f6f6；该文件属派生索引，15 段基址、5,652 字及 params/rom 哈希字段与五件套其余四个文件逐字未变，RTL_REVIEW_V8_OK=1 结论不受影响。

## 2. (a) ROM ↔ params 逐字重建（脚本自己实现，不复用 Lead/rtl2 脚本）

命令（CWD=E:/workspace/FPGA_Comp）：

```
/c/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe \
  temp_test/rtl/review8/check_act8.py > temp_test/rtl/review8/check_act8_run.log 2>&1; echo RC=$?
```

关键实测行：

```
PASS PARAMS_SHA_EXPECTED 7f63cdc5dfb1ef82ab700a41ec9460cef9386a926abe199e9db14f773089ef77
PASS REBUILT_WORD_COUNT 5652
PASS ROM_VS_PARAMS_MISMATCH_ZERO mismatch=0
ROM_PARAMS_MISMATCH=0
ACT8_CHECKS=26
ACT8_FAILS=0
ACT8_CHECK_PASS=1
```

- 重建顺序严格按 params 的 layout：conv1_w/conv2_w/conv3_w 为 `[oc][ic][ky][kx]` int8，g1_w 为 `[ch][i]`，fc_w 为 `[oc][k]`；权重负值做 32 位符号扩展；bias 为 int32；SH 为无符号。
- 5,652 个 32 bit 字全部逐字相等，MISMATCH=0。

## 3. (b) 15 段基址与 ROM 参数

| 段 | start | length |
| --- | --- | --- |
| conv1_w | 0 | 288 |
| conv2_w | 288 | 1,152 |
| conv3_w | 1,440 | 3,456 |
| g1_w | 4,896 | 112 |
| fc_w | 5,008 | 512 |
| conv1_b | 5,520 | 8 |
| conv2_b | 5,528 | 16 |
| conv3_b | 5,544 | 24 |
| g1_b | 5,568 | 16 |
| fc_b | 5,584 | 2 |
| conv1_sh | 5,586 | 8 |
| conv2_sh | 5,594 | 16 |
| conv3_sh | 5,610 | 24 |
| g1_sh | 5,634 | 16 |
| fc_sh | 5,650 | 2 |

- `NN_ROM_WORDS=5652`、`NN_ROM_AW=13`；15 段连续无空洞（start+length=下一段 start）。
- nn_cfg.vh 的 15 个 `*_BASE` 宏经自写宏求值器（含 NN_CV_HO/NN_CV_WO/NN_CV_ROWSTEP 函数宏）展开后与 rom_offsets.json 逐项相等，`CFG_15_BASES_EQUAL bad=0`。

## 4. (c) golden 手算复核（ROM 原始字，10 组全做）

- g1：16 路 × 10 组 = **160 值**逐值等于 golden out_int8；算法 acc=BG[ch]+Σ_{i=0..6} WG[ch][i]*feat[i]，`clip(acc>>SHG[ch],-128,127)` 后 ReLU。
- fc：2 路 × 10 组 = **20 值**逐值等于 golden out_int8；fc acc_int32 2×10 全等；fc 不 ReLU。
- fc 输入拼接：k=0..239 为 conv3 flatten，k=240..255 为 g1 16 路；10 组均 `FC_IN_TAIL_IS_G1` 通过。
- 地址公式与被测实现一致：WG=4896+ch*7+i、BG=5568+ch、SHG=5634+ch、WFC=5008+oc*256+k、BFC=5584+oc、SHFC=5650+oc。

```
PASS GOLDEN_HAS_10_VECTORS count=10
PASS G1_VALUES_ALL bad_groups=0 values=160
PASS FC_VALUES_ALL bad_groups=0 values=20
PASS FC_ACC_INT32_ALL bad=0
PASS FC_IN_TAIL_IS_G1 bad=0
ACT8_GOLDEN_GROUPS=10
```

## 5. (d) 20 个 TB 独立回归（自己跑，不复用 rtl2 日志）

命令（CWD=E:/workspace/FPGA_Comp/retina_event，逐个 TB）：

```
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <TB>
```

第一次全量（log：`build/regress_review_v8.log`，副本 `temp_test/rtl/review8/regress_review_v8_run1.log`）：

| TB | RC | CHECK PASS | CHECK FAIL | 末行 |
| --- | --- | --- | --- | --- |
| tb_act3_hdr | 0 | 13 | 0 | TEST_RESULT=PASS |
| tb_act3_tlv | 0 | 4 | 0 | TEST_RESULT=PASS |
| tb_nn_feat | 0 | 38 | 0 | TEST_RESULT=PASS |
| tb_nn_engine | 0 | 20 | 0 | TEST_RESULT=PASS |
| tb_nn_top | 0 | 31 | 0 | TEST_RESULT=PASS (31 checks) |
| tb_udp_merge | 0 | 14 | 0 | TEST_RESULT=PASS |
| tb_wire_v3 | 0 | 19 | 0 | TEST_RESULT=PASS |
| tb_downlink_cmd | 0 | 87 | 0 | TEST_RESULT=PASS |
| tb_uart_baud | 0 | 46 | 0 | TEST_RESULT=PASS |
| tb_uart_link | 0 | 34 | 0 | TEST_RESULT=PASS |
| tb_stall_repro | 0 | 5 | 0 | TEST_RESULT=PASS |
| tb_udp_mtu_cap | 0 | 8 | 0 | TEST_RESULT=PASS |
| tb_top_retina_event | 0 | 15 | 0 | TEST_RESULT=PASS |
| tb_nn_winstat | 0 | 107 | 0 | TEST_RESULT=PASS |
| tb_act3_idleclr | 0 | 22 | 0 | TEST_RESULT=PASS (22 checks) |
| tb_act3_ctrlhdr | 1（首跑） | 12 | 0 | 无 TEST_RESULT（vsim 中断） |
| tb_nn_integ | 0 | 62 | 0 | TEST_RESULT=PASS |
| tb_nn_engine_v7 | 0 | 76 | 0 | TEST_RESULT=PASS |
| tb_nn_winfeat | 0 | 410 | 0 | TEST_RESULT=PASS |
| tb_nn_winfeat_fuzz | 0 | 1,500 | 0 | TEST_RESULT=PASS |

- 首跑只有 tb_act3_ctrlhdr RC=1：vsim 打印到 12 条 CHECK 后中断，无 FAIL、无 TEST_RESULT；随后**单独连跑 3 次全部 21 CHECK PASS / TEST_RESULT=PASS**（日志 `build/rs8_ctrlhdr_retry1..3.log`）。判为串行批量仿真时的偶发中断（环境负载），不是 RTL 回归。
- tb_nn_engine 的 21 条输出为 20 PASS + 1 SKIP（E1_FC_L2_NEG_KEEP，NUM_CLASSES=2 时该用例不适用）；SKIP 不计 FAIL。
- 第二次全量回归（log：`build/regress_review_v8_run2.log`）：**20/20 RC=0，CHECK PASS 合计 2,532，FAIL=0**；tb_act3_ctrlhdr 本次 21 CHECK PASS。

### 5.1 第二次全量回归（20/20 绿）

- 命令同 §5，脚本 `temp_test/rtl/review8/run_regress20b.sh`；日志 `build/regress_review_v8_run2.log`，逐 TB `build/rs8b_<TB>.log`。
- 结果：`REGRESS_START 2026-10-31T02:01:27` → `REGRESS_DONE 2026-10-31T02:10:07`；**20 个 TB 全部 RC=0、TEST_RESULT=PASS、CHECK FAIL=0**。
- CHECK PASS 合计 2,532：13+4+38+20+31+14+19+87+46+34+5+8+15+107+22+21+62+76+410+1,500。
- 本轮的 tb_act3_ctrlhdr = 21 CHECK PASS（21 个判据 = 首跑中断前 12 条 + 后 9 条），证明首跑 RC=1 是偶发中断。

### 5.2 tb_act3_ctrlhdr 首跑 RC=1 的原始事实（环境性中断）

- 首跑日志原样保留：`build/rs8_tb_act3_ctrlhdr.log`（487 B）。文件内为 12 条 `CHECK=... PASS`、**0 条 `CHECK=... FAIL`**、**没有 `TEST_RESULT=` 行**；驱动脚本末尾打印 `[FAIL] tb_act3_ctrlhdr (vsim rc=1, PASS=False FAIL=False)`。
- 首跑汇总行保留：`build/regress_review_v8.log` 中 `tb_act3_ctrlhdr RC=1 CHECK_PASS=12 CHECK_FAIL=0`（无 TEST_RESULT 字段）。
- 单独连续重跑 3 次：`build/rs8_ctrlhdr_retry1.log`、`retry2.log`、`retry3.log`，每次均为 **21/21 CHECK PASS、0 FAIL、末行 `TEST_RESULT=PASS`**；第二次全量回归（`build/rs8b_tb_act3_ctrlhdr.log`）同样 21/21 PASS。
- 结论：中断发生在第 12 条检查之后、第 13 条之前，vsim 以 rc=1 退出且未产生任何失败断言；同二进制随后 4 次运行（3 次单跑 + 1 次全量）全部通过 ⇒ 判为批量串行仿真时的**环境性中断**，不是 RTL 回归。注：`build/sim/tb_act3_ctrlhdr/vsim.log` 是 run_sim 的固定工作目录，已被后续重跑覆盖，首跑细节以上述 driver 日志为准。

## 6. (e) act8 git diff 审查（逐文件列改动类型）

- 基线：v7 交付 md5 记录在 `sim/nn/EVIDENCE_M3e.md` §0；act8 的改动没有独立 commit（git 95f7cbb 是 director 2026-10-31 01:36 的全量检查点，一次性包含 v7+act8），因此用**哈希还原证明 + mtime** 隔离。

| 文件 | act8 改动类型 | 证据 |
| --- | --- | --- |
| src/hdl/nn/nn_rom_data.v | 生成物整体替换（纯数据） | 19 行结构行逐字不变；5,652 字中 5,501 字不同；sha 316ba006→4288488d；大小同为 197,178 B / 5,672 行 |
| src/hdl/nn/nn_cfg.vh | `NN_MARGIN_MIN` 8→16（含注释），**单行** | 把第 91 行替换回 v6 的 `8` 行后全文 md5 = 29894badf0efb3af90e8ac0801e9097a（= v7 交付 md5） |
| sim/tb/tb_nn_top.v | MARGIN_MIN 局部参数 8→`NN_MARGIN_MIN`，**单行** | 还原为 `localparam MARGIN_MIN = 8;` 后 md5 = 59c511700d67b2655e560c81155955a6（= v7 交付 md5） |
| sim/tb/tb_nn_integ.v | `.MARGIN_MIN(8)`→`.MARGIN_MIN(`NN_MARGIN_MIN)`；断言未改 | 62 CHECK 数与 v7 相同；md5 13e7ff34… |
| sim/tb/tb_golden_v7.vh | 由 v7b golden 重新生成 | 头注释源 sha=364c934b（= out_v7b/golden_vectors.json） |
| sim/tb/tb_nn_engine_v7_vectors.vh | 由 v7b golden 重新生成 | 60,066 个值全等于 golden 前 6 组；头注释源 sha=364c934b |

- RTL 逻辑文件未动（md5 与 v7 交付相同）：nn_engine.v c64f3482bdd98aa0d31361a68db87a26、nn_top.v 7a48b349d70462bbc1597c511cb9f18e。
- nn_feat/nn_decide/nn_winfeat/nn_winstat/nn_rom.v 的 mtime 均早于 act8（22:51–00:59）；nn_rom.v 的「5718→5652」注释订正记录在 EVIDENCE_M3f.md:133，属 act7 后、act8 前的纯注释改动。
- 结论：act8 的源码增量 = 1 个纯数据 ROM + 6 个文件（其中 2 个只改 1 行），**没有夹带 RTL 逻辑改动**。

## 7. (f) TB 生成物 provenance（补充校验）

- tb_nn_engine_v7_vectors.vh：121,011 B（< 256 KB）；GVN=6；8 个数组宽度均为 8*6*LEN；按小端解包后 60,066 个值与 golden 前 6 组逐元素相等（X 6,000 / conv1 2,688 / conv2 1,056 / conv3 240 / g1 16 / fc 2 / feat 7 / logits 2）。
- tb_golden_v7.vh：头注释源 sha=364c934b，与 golden_vectors.json 一致；生成器标记存在（gen_tb_golden_v7b.py）。

## 8. A 段坑表（脚本实现）

1. nn_cfg.vh 有函数式宏 `NN_CV_HO(h)` / `NN_CV_WO(w)` / `NN_CV_ROWSTEP(h,w,ho,wo)`：自写宏求值器必须支持带参宏，否则基址链在 NN_L3_HO 处报 undefined；函数宏递归合法，循环检测只对对象宏。
2. 宏表达式含 `>>`（NN_GRID_W = NN_IMG_W >> NN_GRID_SHIFT），字符白名单必须放行 `<` `>`；Verilog 整数除需换成 Python `//`。
3. vectors .vh 的 8 个数组是「6 组打包在一个 localparam」：宽度 = 8*GVN*LEN，元素 0 在最低字节；tb_golden_v7.vh 相反（元素 0 在最高位）。
4. run_code 的模板禁用反斜杠/反引号/`${`；路径用 E:/ 形式，反引号用 chr(96) 生成。

## 9. B 段：交付位流独立核对（已完成，45 项断言 RC=0）

Lead 指定的最终交付件为 `build/variant_act8_final/retina_event.bit`（Explore 版，等于 `variant_act8e`）对齐 `sim/nn/EVIDENCE_M3j.md`。独立脚本 `temp_test/rtl/review8/check_bit_act8.py`（不读 M3j 的任何中间脚本），日志 `temp_test/rtl/review8/check_bit_act8_run.log`，末行 `BIT8_CHECK_PASS=1`。

### 9.1 位流身份（实测）

| 项 | 实测 | 与 M3j 对照 |
| --- | --- | --- |
| 文件 | `build/variant_act8_final/retina_event.bit` | 同 |
| 大小 | 2,839,107 B | 一致 |
| 全文件 md5 | `5ec55ec07c44f2503df63f1bb160a6e6` | §0/§4.2 一致 |
| 头部日期 / 时刻 | 2026/10/31 / 01:40:32 | 一致 |
| 头部长度 | **127 B**（由 c/d/e 字段解析，含日期 11 B、时刻 9 B、e 字段 4 B 长度） | M3j 写 168 B，**不一致**（§9.4） |
| e 字段声明长度 | 2,838,980 B | M3j 写 2,838,939 B，**不一致**（§9.4） |
| 真实 payload md5 | `dcbcf543210c33cb22625128bc5f6b97`（= bytes[127:]） | M3j 写 `71a0d469…`（= bytes[168:]），**口径不同**（§9.4） |
| 与 act8e 位流 | 逐字节相同（md5 相同） | 一致（M3j 称交付=act8e） |
| act8r 可复现 | 全文件 md5 `6b9deb6f54dc9d458ffbeaffe3c46c93`；与 act8e 仅头部 127 B 不同；bytes[127:] 与 bytes[168:] 均逐字节相同 | 一致（结论成立；数值口径见 §9.4） |
| 报告副本 | timing.rpt md5 `d3d0bc36943078e6e5802c9fa37b1d25` = act8e/timing_deliver.rpt；util.rpt md5 `263b0e9c04d84d0ebf49e4d795c20c92` = act8e/util_deliver.rpt | 一致 |
| chosen.txt / md5.txt | md5 `a24035fe96aa785a9be84c0f1ba4782d` / `e0c21ebe05bf788b4aa15203e1eb0750` | 一致 |

### 9.2 时序（`build/variant_act8_final/timing.rpt:125-134`，Vivado 2020.2）

| 指标 | 实测 | M3j §4.2 |
| --- | --- | --- |
| WNS | +0.215 ns | +0.215 |
| TNS / fail | 0.000 / 0 | 0.000 / 0 |
| WHS | +0.017 ns | +0.017 |
| THS / fail | 0.000 / 0 | 0.000 / 0 |
| setup / hold endpoints | 84,390 / 84,367 | 84,390 / 84,367 |
| WPWS / TPWS | 0.000 / 0.000 | 0.000 / 0.000 |
| 约束结论 | `All user specified timing constraints are met.` | 同 |

### 9.3 资源（`build/variant_act8_final/util.rpt`，Design State: Physopt postRoute）

| 资源 | 实测 | M3j §4.2 |
| --- | --- | --- |
| Slice LUTs | 22,383（LUT as Logic 16,461 + LUT as Memory 5,922） | 22,383 / LUTRAM 5,922 |
| Slice Registers | 14,325 | 14,325 |
| Slice | 8,026 | 8,026 |
| Block RAM Tile | 86.5（RAMB36 82 + RAMB18 9） | 86.5 |
| DSPs | 8 | 8 |
| Bonded IOB | 140 | 140 |

- DRC：`drc.rpt` 共 98 条、全部 Warning、**0 Error/Critical Warning**；与 M3j 一致。

### 9.4 与 M3j 的差异：bit 头长度/载荷口径（2 处表述、同一根因，元数据级）

> 闭合说明（2026-10-31）：E1/E2 已由 rtl2 于 02:2x 按本卡执行修正 —— `temp_test/rtl2/bit_payload_md5.py` 改为解析变长头（`HEADER_LEN=127`），`EVIDENCE_M3j.md` §0/§5.3 的载荷改为 2,838,980 B / `dcbcf543…`，`build/variant_act8_final/md5.txt` 重写（md5 `e275dfff…`，含 `HEADER_LEN=127`、`PAYLOAD_MD5=dcbcf543…`）。本节以下保留为发现时的原始记录。

- M3j §0 与 §5.3 写「Xilinx .bit 头部 168 B，剥头后 payload 2,838,939 B、md5 71a0d469…」。
- 实测本文件头部为 **127 B**：`c` 字段 11 B 日期、`d` 字段 9 B 时刻、`e` 字段 4 B 大端长度（声明 2,838,980）；127 + 2,838,980 = 2,839,107 = 文件大小，完全自洽。
- 从第 168 字节起的尾部确实长 2,838,939 B、md5 71a0d469…，但它是「bytes[168:]」而非 bitstream payload；真实 payload（bytes[127:]）md5 为 `dcbcf543210c33cb22625128bc5f6b97`。
- 根因：`temp_test/rtl2/bit_payload_md5.py:15` 硬编码 `HDR_LEN = 168`，没有解析 `e` 字段。Xilinx 头部长度随 design name 字段变长（本设计 64 B），不是固定 168。
- 影响评估：**不影响**交付件身份（全文件 md5/大小正确）、时序/资源、以及「act8e 与 act8r 可复现」结论（两种口径下 bytes 都逐字节相同）；仅 M3j 的两个数字/命名需要订正。建议把 `bit_payload_md5.py` 改为解析 `e` 字段（本卡只读，未改 rtl2 文件）。

### 9.5 B 段结论

- 判据 (f) 通过：WNS/TNS/WHS/THS、端点、LUT/FF/Slice/LUTRAM/BRAM/DSP/IOB、bit 大小/md5 全部与 M3j 一致；唯一差异是 bit 头长度/载荷命名（§9.4，元数据）。
- 判据 (g)：本文件首行 `RTL_REVIEW_V8_OK=1`。
- 重建可复现（Lead 额外要求）：act8r 重新构建的位流与 act8e 仅头部 127 B（日期/时刻）不同，真实 payload 逐字节相同（md5 均为 dcbcf543…）⇒「改完 build_inproc root 路径后重建，位流内容不变」在 payload 层成立；全文件 md5 必随头部时间戳变化，属 Xilinx 正常行为。静态复核另见 A 段：`RETE_ROOT` 可覆盖、缺省由脚本位置推导、无绝对路径、无 BOM，两脚本 diff 仅 Explore/phys_opt 指令。
- 边界：本卡不跑 Vivado、不烧板。位流「由当前 RTL/v7b ROM 构建」的证据链 = ROM sha256 4288488d + cfg sha256 42239ff0 + 源文件 mtime（ROM 01:20、cfg 01:13，构建 01:31–01:40）+ act8e/act8r 载荷逐字节相同；未做功能级上板验证。

### 9.6 交叉证据：换机/重建可复现（rtl2 执行，本卡引用并独立复核）

- rtl2 用同一构建策略重建一轮（act8r）并对比交付轮 act8e：`PAYLOAD_IDENTICAL=1`；其脚本 `temp_test/rtl2/bit_payload_md5.py` 以「剥 168 B 头」口径测得两轮载荷均为 2,838,939 B、md5 `71a0d4698ba17b88ef1df1c9bbb734b5`。执行者是 rtl2，不是本卡。
- 本卡独立复测两文件：bytes[168:] 逐字节相同（md5 `71a0d469…`），bytes[127:]（真实 bitstream payload）也逐字节相同（md5 `dcbcf543210c33cb22625128bc5f6b97`）；全文件 md5 差异只来自 127 B 头部的时间戳（01:40:32 vs 01:50:40）。
- 结论：无论按哪种起点口径，重建产物内容一致 ⇒「改完 build_inproc root 路径后重建位流不变」成立（整文件 md5 随时间戳变化是 Xilinx .bit 的正常行为）。

### 9.7 烧板事实（Lead 独立记录，本卡未复验）

- 2026-10-31 02:02，Lead 本人完成烧板：`DONE_PIN=1`、`EOS=1`、`PROG_RESULT=OK`；TARGET `210512180081` @ 6 MHz；烧后板卡恢复事件流。
- 位流路径 `build/variant_act8_final/retina_event.bit`（2,839,107 B，全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`），即本证据 §9.1 独立核对的对象。
- 来源：Lead 消息（m02586）中的独立操作记录，**不是 rtl2 自述**。本卡只读、未烧板，仅作为交付件可上板的事实引用。

### 9.8 勘误清单（与 EVIDENCE_M3j 不一致的数字/命名；本卡不改他人文件）

| ID | M3j 位置 | M3j 原文 | 实测 | 影响与建议 |
| --- | --- | --- | --- | --- |
| E1 | §0 表（:15）、文件表（:27）、§5.3（:154/159/160/237） | 「头部 168 B」「剥 168 B 头」 | 本文件头部 **127 B**（c=11、d=9、e=4 字段，e 声明 2,838,980；127+2,838,980=2,839,107） | 168 不是头部长度，而是字节偏移。建议把 `bit_payload_md5.py` 改为解析 `e` 字段并订正 M3j 措辞；不影响交付件身份、时序、资源、重建结论 |
| E2 | §0 表（:15）、§5.3 表（:159-160） | 「载荷 md5 71a0d469…（2,838,939 B）」 | bytes[168:] 确为 2,838,939 B / md5 71a0d469…；但 bitstream payload（bytes[127:]）为 **2,838,980 B / md5 dcbcf543210c33cb22625128bc5f6b97** | 数值本身正确、命名不当（应称「bytes[168:] 尾部」）。两轮一致性结论不受影响；建议 M3j 补真实 payload 值或改口径 |

- 未发现其它数字与 M3j 不一致：bit 大小/md5、WNS/TNS/WHS/THS、setup/hold 端点、LUT/FF/Slice/LUTRAM/BRAM/DSP/IOB、DRC 98/0 全部逐项一致。

## 10. 复现

```
cd E:/workspace/FPGA_Comp
C:/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe temp_test/rtl/review8/check_act8.py
C:/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe temp_test/rtl/review8/probe_rom_diff.py
C:/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe temp_test/rtl/review8/check_bit_act8.py
cd retina_event
bash ../temp_test/rtl/review8/run_regress20.sh
```

首跑日志 `build/regress_review_v8.log`；第二次 `build/regress_review_v8_run2.log`；重试 `build/rs8_ctrlhdr_retry1..3.log`；checker 日志 `temp_test/rtl/review8/check_act8_run.log` 与 `temp_test/rtl/review8/check_bit_act8_run.log`。

- 载荷校验：**必须用解析式脚本**（解析 .bit 的 `e` 字段得长度与起点），不要再用固定 168 B 偏移。`check_bit_act8.py` 已按解析式实现（本文件头 127 B、payload 2,838,980 B、md5 `dcbcf543210c33cb22625128bc5f6b97`）；rtl2 的 `temp_test/rtl2/bit_payload_md5.py` 已改为解析头（`HEADER_LEN=127`）。