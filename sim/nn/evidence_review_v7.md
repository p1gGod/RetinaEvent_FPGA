RTL_REVIEW_V7_OK=1
# task-54 v7 INT8 契约 × RTL 独立审查（A 段只读比对 + B 段独立复跑，均已完成）

- 状态：**A 段 + B 段全部完成**（2026-10-31，rtl）。A 段只读比对（task-51 交付前）出 9 条差异；B 段在 task-51 交付后独立复跑并重算，**新增差异 0 条**。
- 结论：A 段 **9 条差异**（严重 4 / 高 1 / 中 3 / 低 1）+ 7 项验证通过 + 3 项待办；**没有发现权重/偏置/SH 的数值错位**；最严重的是 **D1 滑窗时基**（训练 50 ms 滑窗 vs 板端 100 ms 连续 bin），属契约/系统级，已由 Lead 裁决交 task-59，不在 task-51 范围。B 段复核见 §10：D2/D3/D4/D5 已修复且复核通过，B 段通过。
- 详细清单：`temp_test/rtl/review/diff_list_A.md`；复跑脚本：`temp_test/rtl/review/check_a.py`（A 段）、`temp_test/rtl/review/check_b.py`（B 段）；日志：`check_a_run.log`、`check_b_run.log`、`build/regress_review_v7.log`。

## 1. 范围与输入

- 输入（sha256，check_a.py 实测）：`nn/out_v7/INT8_CONTRACT.md` 429a446d68cbc22b（24,867 B）；`rom_offsets.json` ce3339a92c546d12；`nn_params_v7.json` e61d26dacf13167a；`nn_rom_data_v7.v` 316ba0066ff1224f；`golden_vectors.json` 4f87125e6ea957c4；`tb_golden_v7.vh` 017f78338c383634。
- RTL：`src/rtl/nn/` 全部（nn_cfg.vh、nn_engine.v、nn_top.v、nn_feat.v、nn_winfeat.v、nn_winstat.v、nn_decide.v、nn_rom.v、nn_rom_data.v）。
- 性质：**只读**。未修改任何 RTL/契约/白名单文件；未跑综合、未烧板、未做 git 写。
- 方法：check_a.py 自动校验（sha256/ROM 逐字/布局/int32 上界/golden 结构/cfg 偏移解析）+ 人工逐行比对契约 §1/§2.2/§3/§4/§5/§7。

## 2. A 段自动校验（RC=0，末行 A_CHECK_PASS=1）

命令（CWD=E:\workspace\FPGA_Comp）：

```
python temp_test/rtl/review/check_a.py > temp_test/rtl/review/check_a_run.log 2>&1; echo RC=$?
```

实测输出（22 行，节选关键行）：

```
A_CHECK_SHA256_nn_rom_data_v7_v=1 got=316ba0066ff1224f
A_CHECK_SHA256_nn_params_v7_json=1 got=e61d26dacf13167a
A_CHECK_ROM_DEPTH=1 words=5652
A_CHECK_ROM_MODULE=1
A_CHECK_LAYOUT=1
A_CHECK_WEIGHT_FLAT_ORDER=1
A_CHECK_BIAS=1
A_CHECK_SH=1
A_INT32_BOUND conv1=289948 conv2=249124 conv3=445362 g1=82301 fc=504597
A_INT32_GOLDEN_MAX_ABS=198948
A_CHECK_INT32_NO_OVERFLOW=1 worst_bits=19
A_CHECK_GOLDEN_STRUCT=1 vectors=9
A_CHECK_GOLDEN_HEADER=1
A_GOLDEN_HEADER_MISSING=X_int8,CONV1,CONV2,ACC
A_CFG_CURRENT W1_BASE=0 W2_BASE=288 W3_BASE=1440 WFC_BASE=4896 B1_BASE=5376 B2_BASE=5384 B3_BASE=5400 BFC_BASE=5424 SH1_BASE=5426 SH2_BASE=5434 SH3_BASE=5450 SHFC_BASE=5474 ROM_WORDS=5476
A_CFG_DIVERGENCES=9 B1_BASE:5376!=5520 ... ROM_WORDS:5476!=5652
A_CHECK_PASS=1
```

要点：ROM 5652 字逐字与 params 相等（三段展平顺序 conv1/2/3 `[oc][ic][ky][kx]`、g1 `[ch][i]`、fc `[oc][k]`）；bias/SH 逐字相等；int32 最坏 19 bit；9 组 golden 结构完整；头部数组与 JSON 逐字节一致，但缺 X/conv1/conv2/acc（P2）。

> 版本说明：上面的 `A_CFG_CURRENT`/`A_CFG_DIVERGENCES=9` 是 A 段在 task-51 交付**前**的原始运行（对应旧 RTL）。task-51 交付后 B 段用 `--expect-cfg-equal` 模式复跑，结果为 `A_CFG_DIVERGENCES=0`、`A_CURRENT_ROM_DEPTH=5652`、`A_CHECK_PASS=1`（见 §10.6）。

## 3. 差异清单（摘要）

| ID | 级别 | 契约锚点 | RTL 锚点 | 差异 | 归属 |
|---|---|---|---|---|---|
| D1 | 严重 | L44/L47/L280 | nn_cfg.vh:87；nn_engine.v:136-155；nn_feat.v:265 | prev 窗：训练 [T-150,T-50]（50 ms 步滑窗）vs 板端 [T-200,T-100]（100 ms 连续 bin）⇒ ch0..3 与 5 路特征分布不同 | Lead 决策（nn_feat 不在 task-51 白名单） |
| D2 | 严重 | L114-122、L208-220 | nn_engine.v:81,95-119,228-229,234-236,334-350,396-399；nn_cfg.vh:206-209 | g1 未实现；layer 2 bit 用满；conv/FC 二分 ⇒ g1 落 default 读 fc 参数、tap_last 永不到、ReLU 丢失 | task-51 |
| D3 | 严重 | L121、L231/L240 | nn_cfg.vh:152-153；nn_engine.v:131,162-164,184,357-376 | fc 输入 256 而 bufC 240；g1 的 16 个输出无地址 | task-51 |
| D4 | 严重 | L202-242 | nn_cfg.vh:188-200 | ROM 段偏移两分类旧布局，9 处偏差（首个 B1 5376≠5520）；WFC 480 vs 512 字 | task-51（cfg+ROM+engine 同批） |
| D5 | 高 | L96-110、L117 | nn_engine.v:194；nn_top.v:120-180；nn_winfeat.v:211-242 | g1 的 7 路输入无引擎端口/顶层通路；winfeat 未例化；无 o_feat_bus；有符号扩展/拼接顺序风险 | task-51（依赖 task-48） |
| D6 | 中 | L280 | tb_nn_engine 实测 | 440,087（3 类）vs 439,601（2 类）；v7 估算 439,985，余量 2,015 拍 | task-51（TB 口径） |
| D7 | 中 | L290 | nn_decide.v（无 idle 输入）；v6_common.py:103-156 | 「空窗 1 s 清连续计数」评测未实现；IDLE 只清 VALID 字节；按字面改会改 pulse 序列 | 契约澄清（Lead） |
| D8 | 中 | L96-110 | nn_winfeat.v:211-242 | task-51 文案的 o_feat_bus 不存在（7 个独立端口）；拼接顺序易反 | task-51 + 文档 |
| D9 | 低 | L291 | nn_decide.v:155 | o_act_conf=min(margin,31) vs 契约 o_margin 全精度 | 文档（保持现状） |

## 4. 最严重一条：D1 滑窗时基（建议 Lead 先定口径）

- 训练契约：50 ms 子块累加，**窗口=相邻两个子块（100 ms 宽、50 ms 步）**；决策每 2 窗（100 ms）；prev 窗是上一滑窗（与 now 重叠 50 ms）；平移归一化用「上一窗质心」；通道 2/3 是上一窗自己的平移网格。
- 板端 RTL：nn_feat 每 100 ms 冻结一个 bin（nn_cfg.vh:87 `WIN_CYC=5,000,000`），engine 的 prev = 上一个连续 bin（`ch_base_of`，nn_engine.v:136-155）。
- 结果：决策时刻 T 的 now 窗一致（[T-100,T]），但训练 prev=[T-150,T-50]、板端 prev=[T-200,T-100]。由于当前窗的平移量 offx=pcx-200 也取上一窗质心，**ch0..ch3 全部不同**；7 路特征里依赖上一窗的 5 路（prev_n_div16、dx、dy、dx_rel、dy_rel）不同；只有 n_div16/pol_bal 只看当前窗。
- 影响：引擎 TB 直接喂 X 仍会过（数学没变），但实机输入分布≠训练，v7 的 class2 可辨识性问题可能与此有关。
- 三个处置选项：(a) nn_feat 改 50 ms 子块 + 4 bank / 前端合成滑窗（新任务，动 feat/engine/winstat/winfeat 与周期预算）；(b) 训练侧改 prev=上一决策窗（100 ms 非重叠）重训重导；(c) 若认定 100 ms 连续 bin 就是部署口径，改 v7 契约与 intwin/v7_eval 的 stride（50→100）并重算指标。**task-51 白名单不含 nn_feat.v，本条不在其范围内。**

## 5. 验证通过项（无差异）

- V1 ROM 5652 字与 params 逐字相等（三段顺序、符号扩展、负值）；bias/SH 逐字；sha256 一致。
- V2 int32 不溢出：worst 19 bit；golden max|acc|=198,948。
- V3 per-channel SH：engine S_PIX0 发 `L_SBASE+och`（nn_engine.v:294）→ ROM 2 拍延迟 → S_PIX2 采（:300），每通道独立，符合契约 §4 L127。
- V4 符号扩展：`mac_b` 取 `i_rom_data[7:0]` 且 signed（:218）；bias 32 bit 有符号。
- V5 golden 头部：GV_CONV3/G1/FC/FEAT/CLASS 与 JSON 9 组逐字节一致。
- V6 决策：argmax 平局取小索引、hit=(class!=0 && margin≥8)、连续 3 窗、refractory 75,000,000 与 v6_common replay 一致（D7 除外）。
- V7 卷积几何/顺序：L1 8x14x24 T=36 ROWSTEP=54、L2 16x6x11 T=72 ROWSTEP=28、L3 24x2x5 T=144 ROWSTEP=14，与契约 §3 一致。

## 6. 给 task-51 实现者的高危点（A 段结论）

1. **g1 必须新增「点积模式 + is_relu」**，不能只加一个 case：layer 位宽/层码、tap_last、tap 推进、ReLU、pix_base、ch_base_of 六处都要显式处理；g1 参数 CIN=7/T=7/COUT=16/WBASE=4896/BBASE=5568/SBASE=5634，结果写 bufC[240+ch]。
2. **ROM 偏移必须同批改**：cfg 从 B1 起 9 个常量 + nn_rom_data.v 5652 字；否则 WFC 480/512 会让 g1_w 与 fc_w 混叠、bias/SH 全错。
3. **bufC 扩到 256**、fc L_CIN=256、WFC=512 字，否则 fc k≥240 越界。
4. **7 路 feat 拼接顺序**：LSB=n_div16 … MSB=dy_rel；有符号扩展；建议在 nn_top 里加注释并在 TB 中既有「直接喂 feat」又有一组「走 winfeat 总线」的等价性检查（若时间允许）。
5. **周期口径**：TB 打印 i_start→o_busy 落的实测拍数，与 439,601（2 类）基线同口径；v7 目标 ≤442,000。

## 7. 待办与 B 段计划

- P1：nn_winfeat 未例化（task-48）；其 7 路算术（trunc/floor/S floor 8/n=0）等 task-48 证据后复核，A 段不下结论。
- P2：`tb_golden_v7.vh` 缺 X_int8/conv1/conv2 out_int8/acc_int32；task-51 逐层对拍需从 JSON 另抽（建议 Lead 允许新增一个生成 .vh，否则 TB 体积约 120 KB hex）。**B 段已关闭**：Lead 批准后 task-51 新增 `sim/tb/tb_nn_engine_v7_vectors.vh`（121,010 B，脚本 `temp_test/rtl2/gen_engine_v7_vectors.py` 生成），check_b.py 已验证其与 `golden_vectors.json` 前 6 组逐元素一致。
- P3：cfg/ROM/engine 同批改；改后 `check_a.py` 应输出 `A_CFG_DIVERGENCES=0`、`ROM_WORDS=5652`。**B 段已复核通过**：15 个基址 + `NN_ROM_WORDS=5652` 与 `rom_offsets.json` 全等。
- B 段（task-51 交付后）：独立复跑 `tb_nn_engine_v7`（不采信 task-51 日志，自己跑）、17 个既有 TB 全 RC=0、抽 golden 2 组重算 conv/g1/fc 逐字节、ROM sha256 复核、对照本清单逐条复核 task-51 的 diff、本文件首行改 `RTL_REVIEW_V7_OK=1`，再 task-54 complete。

## 8. 本次实测踩的坑

- `golden_vectors.json`（493 KB）必须 `open(..., encoding='utf-8')`，Windows 默认 GBK 会 UnicodeDecodeError。
- `rom_offsets.json` 是 dict，段表在 `sections` 列表、字段是 `length`（不是 `words`）。
- `tb_golden_v7.vh` 的 GV_CLASS 是 `2'b01` 二进制字面量（按 'h 解析会 IndexError）；其余 GV_* 是 hex。
- nn_cfg.vh 含函数式宏 `NN_CV_HO(h)`/`NN_CV_WO(w)`/`NN_CV_ROWSTEP(h,w,ho,wo)`，解析器必须先做参数替换（括号配对）再求值，否则层尺寸算错。
- 用 run_code 的 String.raw 模板写含正则反斜杠的 Python 会报 `Expected unicode escape`；改为源码中零反斜杠/零反引号（chr(96) 表示反引号、字符串方法代替正则）即可。

## 9. 复现

```
cd /e/workspace/FPGA_Comp
python temp_test/rtl/review/check_a.py > temp_test/rtl/review/check_a_run.log 2>&1; echo RC=$?   # 0
tail -1 temp_test/rtl/review/check_a_run.log    # A_CHECK_PASS=1
```

B 段复现见 §10.9。

## 10. B 段：task-51 交付后的独立复核（2026-10-31，rtl）

### 10.1 结论（B 段通过）

- **B 段通过，新增差异 0 条。** A 段 9 条处置：D2/D3/D4/D5 已由 task-51 修复并经静态 + 数值双重复核通过；D1 交 task-59（Lead 裁决，不在本卡）；D6 周期实测 439,981 ≤ 442,000；D7/D9 文档问题、RTL 不改；D8 采用 7 个独立 8 bit 端口（无 o_feat_bus），与 winfeat 端口一一对应。
- 复核方式：不采信 task-51 的日志与结论，全部独立复跑 + 独立脚本重算（ROM sha256、15 段逐字、9 组 golden 的 g1/fc 重算、vectors provenance、conv1 抽值）；未修改任何 RTL/白名单文件。

### 10.2 tb_nn_engine_v7 独立复跑

命令（CWD = retina_event）：

    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine_v7

结果（日志 build/review_v7_engine.log）：RC=0，末行 TEST_RESULT=PASS，**76 条 CHECK 全 PASS / 0 FAIL**；11 次完整推理（6 组 golden + B1..B5 定向）每次均 ENGINE_V7_RUN_CYC_439981，并命中 ENGINE_V7_CYC_BUDGET_442000 PASS。

| 对拍项 | 组数/值数 | 结果 |
|---|---|---|
| conv1 out_int8 | 6 组 × 2688 值 | 逐值 PASS |
| conv2 out_int8 | 6 组 × 1056 值 | 逐值 PASS |
| conv3 out_int8 | 6 组 × 240 值 | 逐值 PASS |
| g1 out_int8 | 6 组 × 16 值 | 逐值 PASS |
| fc / logits | 6 组 × 2 值 | 逐值 PASS |
| B1 全零网络 | 各层 + logits 全 0 | PASS（证明无死循环） |
| B2 g1 独立通路 | logit0=120（=Σch），logit1=0 | PASS |
| B3 clamp | g1 127 / ReLU 0；fc 127 / -128 | PASS |
| B4 平局 | logit0=logit1=5 | PASS |
| B5 bufC 分界 | bufC[239]=1（conv3_b[23]）、bufC[240]=2（g1_b[0]）；logit0=1、logit1=2 | PASS |

### 10.3 17 个既有 TB 独立回归

命令（每个 TB 单独起进程；日志 build/regress_review_v7.log，逐 TB build/rs_<tb>.log）：

    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>

| TB | RC | CHECK PASS | 末行 |
|---|---|---|---|
| tb_act3_hdr | 0 | 13 | TEST_RESULT=PASS |
| tb_act3_tlv | 0 | 4 | TEST_RESULT=PASS |
| tb_nn_feat | 0 | 38 | TEST_RESULT=PASS |
| tb_nn_engine | 0 | 20 | TEST_RESULT=PASS（另 1 条 SKIP，见下） |
| tb_nn_top | 0 | 31 | TEST_RESULT=PASS (31 checks) |
| tb_udp_merge | 0 | 14 | TEST_RESULT=PASS |
| tb_wire_v3 | 0 | 19 | TEST_RESULT=PASS |
| tb_downlink_cmd | 0 | 87 | TEST_RESULT=PASS |
| tb_uart_baud | 0 | 46 | TEST_RESULT=PASS |
| tb_uart_link | 0 | 34 | TEST_RESULT=PASS |
| tb_stall_repro | 0 | 5 | TEST_RESULT=PASS |
| tb_udp_mtu_cap | 0 | 8 | TEST_RESULT=PASS |
| tb_top_retina_event | 0 | 15 | TEST_RESULT=PASS |
| tb_nn_winstat | 0 | 107 | TEST_RESULT=PASS |
| tb_act3_idleclr | 0 | 22 | TEST_RESULT=PASS (22 checks) |
| tb_act3_ctrlhdr | 0 | 21 | TEST_RESULT=PASS |
| tb_nn_integ | 0 | 62 | TEST_RESULT=PASS |

合计 **17/17 RC=0，546 条 CHECK PASS，0 FAIL**，日志末行 DONE。另补跑 tb_nn_winfeat（对齐 task-51 的 19 TB 口径）：RC=0、410 CHECK PASS、TEST_RESULT=PASS。

注：tb_nn_engine 实际 21 条 CHECK = 20 PASS + 1 SKIP（E1_FC_L2_NEG_KEEP 在 NUM_CLASSES=2 下按设计 SKIP）；task-51 证据文字「21 CHECK 全 PASS」应改为「20 PASS + 1 SKIP」。

### 10.4 D2 静态复核：layer 位宽扩展后是否引入新死锁/忙等

- 状态 4 bit（S_IDLE=0..S_DONE=9）；除 S_IDLE 等 i_start 外，**每个状态每拍都无条件改 state**。
- S_TAP1 三个分支覆盖全部情形：tap_last（cin==L_CIN-1）→ S_FIN；is_dot（g1/fc）→ cin+1；conv → kx→ky→cin 推进。
- S_FIN 四分支覆盖 ox→oy→och→层切换，层链 L1→L2→L3→G1→FC→S_DONE；主 case 末尾 default → S_IDLE。
- g1 的 7 tap：cin=0..6 恰 7 次即 tap_last_dot；fc 的 256 tap 同理。
- 实测支持：11 次推理全部精确停在 439,981 拍（同一数值、无抖动），B1 全零网络输出全 0 且正常返回，无忙等。
- 引擎内部无超时计数器（仅 TB watchdog 400 ms 兜底）；结论：**无新增非终态/忙等路径**。

### 10.5 D3 越界复核：bufC 240 → 256

- bufC 深度 = NN_FC_CIN = 256；写地址 reg [7:0]。
- g1 写：bufc_waddr <= NN_FC_CONV_IN + och ⇒ 240..255，16 路全部落在界内。
- conv3 写：och*10 + oy*5 + ox，最大 23*10+1*5+4 = 239（与 g1 段 240..255 不重叠）。
- fc 读：act_c_q <= bufC[act_addr[7:0]]，fc 时 act_addr=cin=0..255，恰为「conv3 的 240 + g1 的 16」。
- ROM 段：WFC 末址 = 5008 + 1*256 + 255 = 5519 < B1 5520，不与 bias 段重叠。

### 10.6 数值核对（独立脚本，非 task-51 日志）

- temp_test/rtl/review/check_b.py：**43/43 PASS，RC=0，末行 B_CHECK_PASS=1**（日志 check_b_run.log，摘要 check_b_result.json）。覆盖：
  - ROM：sha256 = 316ba006…（= nn/out_v7/nn_rom_data_v7.v），5652 字，地址 13 bit；
  - 15 段逐字 = nn_params_v7.json（含负值符号扩展），WFC 段 5008..5519、WG 段 4896..5007 单独再查；
  - nn_cfg.vh 的 15 个基址 + NN_ROM_WORDS=5652 与 rom_offsets.json 全等 ⇒ A 段 D4 的 9 处发散归零；
  - g1/fc 地址映射 + 数值：用 ROM 原始字按 WG=4896+ch*7+i、BG=5568+ch、SHG=5634+ch、WFC=5008+oc*256+k、BFC=5584+oc、SHFC=5650+oc 重算 golden 9 组全部 g1(16) 与 fc(2)，逐值相等；fc 输入 k=0..239=conv3 flatten、k=240..255=g1[ch] 在 9 组全部成立（B_FC_IN_TAIL_IS_G1 PASS）；
  - vectors provenance：tb_nn_engine_v7_vectors.vh 121,010 B（≤256 KB），头注释 sha256 = golden sha，8 个数组与 golden 前 6 组逐元素一致，生成脚本 temp_test/rtl2/gen_engine_v7_vectors.py 存在（85 行、小端 pack、含 fc 尾部断言）；
  - conv1 首层抽值：用 GV_X + ROM（W1 0 / B1 5520 / SH1 5586、T=36）按 (ic*30+2oy+ky)*50+(2ox+kx) 重算 2 组共 5 个抽值，与 TB 期望 GV_C1 全等（B_CONV1_SAMPLES PASS）。
- check_a.py --expect-cfg-equal 复跑：RC=0、A_CFG_DIVERGENCES=0、A_CURRENT_ROM_DEPTH=5652、A_CHECK_PASS=1（A 段首次运行是旧 RTL，A_CFG_DIVERGENCES=9）。

### 10.7 task-51 diff 人工审查（git diff -U0，只读）

- nn_engine.v：全部 hunk 落在 8 处 —— 端口 +i_g1_f0..f6、layer 3 bit/层码、is_fc/is_g1/is_dot/is_relu 解耦、层参数 case（G1 分支）、act_bus/q_out、tap_last、pix_base/ch_base_of、S_FIN 写缓存与层链；**MAC 算术、移位/饱和、ROM 读时序、状态编码未动** ⇒ 无与目标无关的功能改动。
- nn_top.v：只加 winfeat 例化、7 路接线、win_tick 统一；对外端口集合未变。
- nn_feat.v 的改动（+66 行）来自 M3c/task-43 的 USE_EXT_TICK/EXT_FLUSH_CYC，与 task-51 无关。

### 10.8 与 task-51 证据的差异（3 条，均不影响数值结论）

1. tb_nn_engine 的 CHECK：实测 20 PASS + 1 SKIP（E1_FC_L2_NEG_KEEP，NUM_CLASSES=2），task-51 写「21 CHECK 全 PASS」应改。
2. 契约版本：A 段读 INT8_CONTRACT.md sha 429a446d（24,867 B）；B 段现场为 d321fa17（26,183 B，= task-51 引用）⇒ 契约在 A 段后更新；本卡数值核对以 rom_offsets.json/nn_params_v7.json/golden_vectors.json 为准，A 段 §3 表内的契约行号属旧版。
3. 文档笔误：nn/v7/gen_golden.py:259 metadata 写 trunc_div，golden 与 RTL 均为 floor（coder3 修注释）；nn_rom.v 头注释「5718 字」过时（v7 = 5652）。

### 10.9 复现（B 段）

    cd /e/workspace/FPGA_Comp
    python temp_test/rtl/review/check_b.py                            # B_CHECK_PASS=1
    python temp_test/rtl/review/check_a.py --expect-cfg-equal         # A_CFG_DIVERGENCES=0
    cd retina_event
    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine_v7
    # 17 个既有 TB 循环见 build/regress_review_v7.log

## 11. B 段踩的坑

- check_a.py 期望表把 NN_WFC_BASE 写成 v6 旧值 4896（v7 = 5008）⇒ 复跑才暴露；同时原脚本的 A_CHECK_PASS 拼接在 fails 非空时 TypeError、且缺 import sys；新增 --expect-cfg-equal 模式时一并修好。
- nn_cfg.vh 中以反引号开头的值宏（如 NN_W1_WORDS）会被函数式宏解析器误判 ⇒ 必须校验括号内是否为纯标识符列表。
- Python 含中文输出重定向到文件时按 Windows locale（GBK）编码，grep 显示乱码；证据脚本输出保持 ASCII。
- job_output wait 超过 run_code 单次 120 s 会整程序超时（后台 job 本身继续跑）；改为每次 ≤90 s 分次 wait。

（A/B 两段审计结束。B 段通过：新增差异 0；A 段 9 条全部处置。task-54 完成。）

