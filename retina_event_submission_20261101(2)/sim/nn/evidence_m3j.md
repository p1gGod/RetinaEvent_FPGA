ACT8_OK=1
BIT8_OK=1

# EVIDENCE_M3j — act8 交付位流（v7b ROM + NN_MARGIN_MIN=16）

- 任务卡：task-70（M3j act8）
- 构建日期：2026-10-31 01:21–01:50（+0800）
- 交付位流：`build/variant_act8_final/retina_event.bit`
- 结论：可交付；**未烧板**（烧板由 Lead 执行）

## 0. 交付件与哈希

| 文件 | 说明 | 实测 |
|---|---|---|
| `build/variant_act8_final/retina_event.bit` | 交付位流（= act8e Explore 版） | 2,839,107 B；全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`；头长 127 B；载荷（offset 127 起）2,838,980 B、md5 `dcbcf543210c33cb22625128bc5f6b97`；头部 c=2026/10/31 d=01:40:32 |
| `build/variant_act8_final/md5.txt` | 全文件/载荷 md5、头长与字段表、头部日期时刻、策略、时序 | md5 `e275dfff27b623088332a2f855276622` |
| `build/variant_act8_final/timing.rpt` | = act8e/timing_deliver.rpt | md5 `d3d0bc36943078e6e5802c9fa37b1d25` |
| `build/variant_act8_final/util.rpt` | = act8e/util_deliver.rpt | md5 `263b0e9c04d84d0ebf49e4d795c20c92` |
| `build/variant_act8_final/chosen.txt` | `CHOSEN=explore` + 理由 | md5 `a24035fe96aa785a9be84c0f1ba4782d` |
| `src/hdl/nn/nn_rom_data.v` | v7b ROM（5652 words） | 5672 行；sha256 `4288488d66dd2f22bfc946b0698f29170cbc702ef21a68bcc4a646831e1bc41f` |
| `sim/tb/tb_nn_engine_v7_vectors.vh` | v7b golden 向量（参数化重生成） | 121,011 B / 27 行；sha256 `421004df16df80914ad34a524ef931fd1b974261c9557d5deb495aea76f81039` |
| `sim/tb/tb_golden_v7.vh` | 定版向量头（Lead 三方交叉验证） | sha256 `d5e359563fdd64e8c2547383fe69ea6522eeb705af61f00af54d325d85753f96` |
| `src/hdl/nn/nn_cfg.vh` | 含 `NN_MARGIN_MIN 16`（:91） | 254 行；sha256 `42239ff048f50bd6630b73d99883c3ddbc9fae1d3dd3ef7a5631a751be05d6a9` |
| `nn/out_v7b/nn_params_v7b.json` | 部署参数源 | sha256 `7f63cdc5dfb1ef82ab700a41ec9460cef9386a926abe199e9db14f773089ef77` |
| `nn/out_v7b/rom_offsets.json` | 布局权威 | sha256 `ccfadfe82f0f778eb8f62ca95bbd113965e4a6033f191e357071471a01abbaf3` |
| `nn/out_v7b/golden_vectors.json` | golden 向量源 | sha256 `364c934b3668ccc3f31e84358c46b07a0e2b970eb5b3613d3c2673632a804596` |
| `temp_test/rtl2/bit_payload_md5.py` | 解析变长 .bit 头（本设计 127 B）+ 载荷 md5 可复跑脚本 | 见 §5 |
| `temp_test/rtl2/rom_freeze_check.py` | 布局冻结独立自检 | ROM_FREEZE_OK=1 |
| `temp_test/rtl2/gen_engine_v7_vectors.py` | 向量生成（参数化，可复跑） | GVN=6 |

## 1. 判据 (a)：ROM 切换 §6 五步（命令 + 退出码）

日志：`build/act8_romswap.log`。

1. **换 ROM**
   `cp nn/out_v7b/nn_rom_data_v7b.v src/rtl/nn/nn_rom_data.v` → RC=0
   - PRE sha256 `316ba0066ff1224f7c2e4afe923510fa75e83b8932f58f461f62edc005d62d16` → POST `4288488d66dd2f22bfc946b0698f29170cbc702ef21a68bcc4a646831e1bc41f`
   - 5672 行（首行 `module nn_rom_data`，模块名/端口不变）
2. **重生成向量**
   `../trainingData/.venv/Scripts/python.exe temp_test/rtl2/gen_engine_v7_vectors.py --json nn/out_v7b/golden_vectors.json --out sim/tb/tb_nn_engine_v7_vectors.vh` → RC=0
   - 121,011 B；sha256 `421004df16df80914ad34a524ef931fd1b974261c9557d5deb495aea76f81039`（旧 v7 `2d9b7073…`）
   - 输出 GVN=6；JSON sha256 前缀 `364c934b…`
3. **CFG 与布局交叉校验**
   `../trainingData/.venv/Scripts/python.exe temp_test/rtl2/check_cfg_v7.py nn/out_v7b/rom_offsets.json` → RC=0
   - `CFG_V7_BAD=0`、`CFG_V7_OK=1`；15 段基址 + `ROM_WORDS=5652` + `NN_ROM_AW=13` + 10 项 xcheck 全 OK
4. **定版 tb_golden**
   `cp nn/out_v7b/tb_golden_v7.vh sim/tb/tb_golden_v7.vh` → RC=0；sha256 `d5e35956…`
5. **四 TB 复跑**（见 §3）全 RC=0

## 2. 判据 (b)：布局冻结自检

独立脚本 `temp_test/rtl2/rom_freeze_check.py`（解析 ROM 与 JSON，不依赖 RTL 宏）：

```
ROM_WORDS_PARSED=5652 DECL=[0:5651] ADDR_MIN=0 ADDR_MAX=5651
ROM_FIRST=0xffffffcc ROM_LAST=0x00000008
SECTIONS=15 CHAIN_END=5652 BAD=0 rom_words_json=5652 addr_bits=13
ROM_FREEZE_OK=1
```

15 段链（与 `nn/out_v7b/rom_offsets.json` 全等）：
conv1_w 0/288、conv2_w 288/1152、conv3_w 1440/3456、g1_w 4896/112、fc_w 5008/512、
conv1_b 5520/8、conv2_b 5528/16、conv3_b 5544/24、g1_b 5568/16、fc_b 5584/2、
conv1_sh 5586/8、conv2_sh 5594/16、conv3_sh 5610/24、g1_sh 5634/16、fc_sh 5650/2。

向量文件为参数化重生成（非手拷）：`gen_engine_v7_vectors.py --json … --out …`，GVN=6，长度断言 X 6000 / conv1 2688 / conv2 1056 / conv3 240 / g1 16 / fc 2 / fc.in 256 全过。

## 3. 判据 (c)：TB 复核（v7b ROM + MARGIN_MIN=16）

命令统一：`cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>`；日志 `build/act8_tb.log`、`build/sim/<tb>/vsim.log`。

| TB | 退出码 | 结果 | CHECK |
|---|---|---|---|
| tb_nn_engine_v7 | 0 | TEST_RESULT=PASS | 76（INFO_CHECK_TOTAL=76，INFO_ERRORS=0） |
| tb_nn_top | 0 | PASS (31 checks) | 31 |
| tb_nn_integ | 0 | TEST_RESULT=PASS | 62（INFO_CHECK_TOTAL=62） |
| tb_nn_winfeat | 0 | TEST_RESULT=PASS | 410（INFO_CHECK_TOTAL=410） |
| tb_top_retina_event | 0 | TEST_RESULT=PASS | 15 条 CHECK 全 PASS |

无 CHECK 删除、无判据降低。

## 4. 判据 (d)(e)：两轮构建并排与选优

### 4.1 命令

```bash
# 第一轮 Default（act8）
cd retina_event
RETE_TAG=act8 RETE_GENERICS="ETH_EN=1" \
  pwsh -NoProfile -ExecutionPolicy Bypass -File ../temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/build_inproc.tcl -log build/act8_build.log -journal build/act8_build.jou -tclargs --full
# → ACT8_EXIT=0；01:21:32 起，01:30:42 止

# 第二轮 Explore + phys_opt（act8e）
RETE_TAG=act8e RETE_GENERICS="ETH_EN=1" \
  pwsh -NoProfile -ExecutionPolicy Bypass -File ../temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/build_inproc_v7.tcl -log build/act8e_build.log -journal build/act8e_build.jou -tclargs --full
# → ACT8E_EXIT=0；01:31:21 起，01:40:33 止
```

`-tclargs` 均放最后；TCL 无 BOM。两轮均 `INPROC_RESULT=OK`、`INPROC_DONE=1`、`^ERROR:` 计数 0、`INPROC_NHDL=56`。
CRITICAL WARNING 各 6 条，去重后仅为既有 `ila_dbg`/`ila_sccb` 无模块匹配的 XDC 提示（ILA_EN=0 历史遗留）。

### 4.2 并排表

| 轮次 | 策略 | WNS (ns) | TNS (ns) | WHS (ns) | THS (ns) | 端点 (setup/hold) | LUT | FF | Slice | LUTRAM | BRAM Tile | DSP | IOB | bit 体积 | 全文件 md5 | 载荷 md5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| act8 | Default | +0.188 | 0.000 | +0.020 | 0.000 | 84,390 / 84,367 | 22,384 | 14,325 | 8,025 | 5,922 | 86.5 | 8 | 140 | 2,838,703 | `51f9a665233e845717f81b8d4c4ff71e` | `f1197e9aaa1b6c2e26fa2653aa847a5e` |
| **act8e** | **Explore+phys_opt** | **+0.215** | 0.000 | +0.017 | 0.000 | 84,390 / 84,367 | **22,383** | 14,325 | 8,026 | 5,922 | 86.5 | 8 | 140 | 2,839,107 | `5ec55ec07c44f2503df63f1bb160a6e6` | `dcbcf543210c33cb22625128bc5f6b97` |

两轮 DRC 均 98 violations、**0 Error**、Design State: Fully Routed。WPWS/TPWS 均 0.000、0 failing，`All user specified timing constraints are met.`

**选优：act8e（Explore）为交付件。** 理由：WNS 多 27 ps（+0.215 vs +0.188），资源等价（LUT 少 1、Slice 多 1 属布线噪声），hold 仍为正（+0.017 ns）。虽 WHS 比 Default 少 3 ps，但两版均通过且 setup 是限制项。

### 4.3 最差路径（两轮同一条，eth_rxc 8.000 ns）

`u_event_sink/u_udp_merge/flush_cnt_reg[11]/C → u_event_sink/u_udp_merge/o_tx_len_reg[12]/D`
- 14 级逻辑（CARRY4=6 LUT4=1 LUT5=3 LUT6=4）；Data Path 7.561 ns（logic 3.609 = 47.7%，route 3.952 = 52.3%）
- DCD 4.375 ns、skew −0.248 ns、uncertainty 0.035 ns；slack act8 +0.188 / act8e +0.215
- 与 act7 那条（`ev_wr_page_reg → o_tx_len_reg[9]`）同属 udp_merge 事件包长链，非 act3c 的 `rd_ptr_gray → raw_ram ADDRARDADDR`。

## 5. 载荷可复现证明（构建脚本改造 + act8r 重建）

### 5.1 脚本改造（仅路径解析，不碰流程）

三个脚本的 root 硬编码改为：`RETE_ROOT` 可覆盖，缺省按 `[info script]` 上溯（`tool/` 的上一级 = `retina_event`）：

```tcl
if {[info exists env(RETE_ROOT)] && $env(RETE_ROOT) ne ""} {
    set root $env(RETE_ROOT)
} else {
    set root [file normalize [file join [file dirname [info script]] ..]]
}
```

- `tool/build_inproc.tcl`：只改 root 解析（第 22 行起）；原文件备份 `build/act8_script_backup/build_inproc.tcl` md5 `9ea4afa6cb636490e89458f7ed3fbec4` → 改后 `ba8dd1cbc695aa32b5e597a8ba798181`
- `tool/build_inproc_v7.tcl`：同上；备份 `785978677e8f9088a285c869ba9046b3` → `4a0b237f1d0341d395026527a97b9888`
- `tool/hier_util.tcl`：第 9-10 行同类硬编码，改 root 相对默认路径；备份 `4a65a8c9a2f94b47c67847750546d2c7` → `7d3ed8d032ef67a1a6d1e86e1c4433c1`
- 三文件均无 BOM、ASCII 语法部分不变；构建日志 `INPROC_ROOT=E:/workspace/FPGA_Comp/retina_event`（推导正确）

### 5.2 act8r 重建（同 ROM、同 Explore 策略）

```bash
RETE_TAG=act8r RETE_GENERICS="ETH_EN=1" \
  pwsh .../run_awake_cmd.ps1 .../vivado.bat -mode batch \
  -source tool/build_inproc_v7.tcl -log build/act8r_build.log -journal build/act8r_build.jou -tclargs --full
```
→ `ACT8R_EXIT=0`，`INPROC_RESULT=OK`；01:41:28 起，01:50:41 止；WNS +0.215 / TNS 0 / WHS +0.017 / THS 0；LUT 22,383 / FF 14,325 / Slice 8,026 / BRAM 86.5 / DSP 8；bit 2,839,107 B。

### 5.3 全文件 md5 vs 载荷对比（脚本 `temp_test/rtl2/bit_payload_md5.py`）

Xilinx .bit 的头长**不是固定的**：它随 design 名等字段长度变化，不可硬编码。本设计的头长 **127 B** = 13 B 魔数 + a(1+2+64) + b(1+2+13) + c(1+2+11) + d(1+2+9) + e(1+4)，e 的 4 字节大端长度字段 @123..126 = 2,838,980，载荷从 **offset 127** 开始：127 + 2,838,980 = 2,839,107 = 文件大小（自洽）。头部含构建日期/时刻（c=日期、d=时刻），故全文件 md5 在两次构建间**必然**不同；判据改为载荷 md5。脚本已改为解析头（`HEADER_SELF_CHECK=1`，断言 payload_off+len==文件大小）。**初版曾按 168 B 口径记录，已订正（原因见上）**：旧 2,838,939/`71a0d469…` 是从第 168 字节起的尾部哈希，多切掉 41 B。

| 构建 | 全文件 md5 | 头部 c / d | 载荷长度 | 载荷 md5 |
|---|---|---|---|---|
| act8（Default） | `51f9a665233e845717f81b8d4c4ff71e` | 2026/10/31 / 01:30:40 | 2,838,576 | `f1197e9aaa1b6c2e26fa2653aa847a5e` |
| act8e（交付） | `5ec55ec07c44f2503df63f1bb160a6e6` | 2026/10/31 / 01:40:32 | 2,838,980 | `dcbcf543210c33cb22625128bc5f6b97` |
| act8r（重建） | `6b9deb6f54dc9d458ffbeaffe3c46c93` | 2026/10/31 / 01:50:40 | 2,838,980 | `dcbcf543210c33cb22625128bc5f6b97` |

```
PAYLOAD_MATRIX:
  PAIR[0,1]=0   # act8  vs act8e：策略不同 ⇒ 布线不同 ⇒ 载荷不同（预期）
  PAIR[0,2]=0   # act8  vs act8r：同上
  PAIR[1,2]=1   # act8e vs act8r：同策略 + 改后脚本 ⇒ 载荷逐字节相同
PAYLOAD_IDENTICAL=0   # 三文件里 act8 不同；act8e/act8r 两者载荷相同
HEADER_SELF_CHECK=1   # 三文件头部全部解析成功，payload_off+len==文件大小
```

**结论**：脚本改造不改变设计产物；act8e 与 act8r 的全文件 md5 差异仅来自头部时间戳（01:40:32 vs 01:50:40），载荷 2,838,980 B 完全一致（PAYLOAD_IDENTICAL=1 对 1,2 对）。原脚本/环境无隐藏依赖。act8（Default）载荷不同是因为 Directive 不同，符合预期。

复跑命令：
```
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/bit_payload_md5.py \
  build/variant_act8/retina_event.bit \
  build/variant_act8e/retina_event.bit \
  build/variant_act8r/retina_event.bit
```

## 6. 本次构建包含的 RTL/配置变更

| 变更 | 时间 | 位置 | 内容 |
|---|---|---|---|
| v7b ROM 换入 | 2026-10-31 01:20 | `src/hdl/nn/nn_rom_data.v` | sha256 `4288488d…`，5652 words/13 bit，布局与 `rom_offsets.json` 全等 |
| MARGIN_MIN 8→16 | 2026-10-31 01:13 | `src/hdl/nn/nn_cfg.vh:91` | `define NN_MARGIN_MIN 16`（N_CONSEC=3 不变）；依据 task-63 s100 门限扫描（16/3 对 8/3 全维占优：open 17/17、wave 1、static 0、empty 0 相同；hardneg 3→2、总 pulses 88→74）。与 `nn_params_v7b.json` deploy_config 一致 |

TB 适配（无期望值改动、无 CHECK 删除）：`tb_nn_top.v:47` localparam `MARGIN_MIN = 8` → ``NN_MARGIN_MIN``；`tb_nn_integ.v:68` `.MARGIN_MIN(8)` → `.MARGIN_MIN(`NN_MARGIN_MIN)``。原因：应命中场景 margin≥20（T6 conf20）、负例 margin=5，16 落在两者之间，全部断言不敏感。`nn/REPORT_v7b_部署口径重训.md` 在改动时尚不存在（任务卡/s100 复核报告已有该口径），证据按 Lead 原文引用该路径。

## 7. act7 ↔ act8 并排

| 项 | act7 | act8（交付） | 变化 |
|---|---|---|---|
| ROM | v7（5652 words） | v7b（5652 words） | 权重数值换版，布局冻结 |
| MARGIN_MIN | 8 | 16 | 判定门限收紧 |
| WNS | +0.059 | **+0.215** | +156 ps |
| TNS / WHS / THS | 0 / +0.027 / 0 | 0 / +0.017 / 0 | hold 仍为正 |
| LUT / FF / Slice | 22,371 / 14,325 / 7,968 | 22,383 / 14,325 / 8,026 | +12 / 0 / +58 |
| BRAM / DSP / IOB | 87 / 8 / 140 | 86.5 / 8 / 140 | −0.5 / 0 / 0 |
| bit 体积 | 2,835,423 | 2,839,107 | +3,684 B |
| 全文件 md5 | `9c13668c029c9d3a248cf69cbec03582` | `5ec55ec07c44f2503df63f1bb160a6e6` | 新位流 |
| 构建耗时 | 10m06s | 9m12s | — |

## 8. 未烧板声明

本次**未执行**任何 program/flash/烧板操作；`build/variant_act8_final/retina_event.bit` 等待 Lead 烧板验证（DONE/EOS/End of startup status）。

## 9. 复现命令摘要

```bash
# ROM 换入与自检
cp nn/out_v7b/nn_rom_data_v7b.v src/rtl/nn/nn_rom_data.v
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/gen_engine_v7_vectors.py \
  --json nn/out_v7b/golden_vectors.json --out sim/tb/tb_nn_engine_v7_vectors.vh
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/check_cfg_v7.py nn/out_v7b/rom_offsets.json
cp nn/out_v7b/tb_golden_v7.vh sim/tb/tb_golden_v7.vh
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/rom_freeze_check.py

# 构建（正文 §4.1）；载荷复现比对（正文 §5.3）
```

## 10. 结论

- v7b ROM（5652 words/13 bit）与 MARGIN_MIN=16 已进入交付位流；布局冻结、CFG 交叉校验、ROM 独立解析三方一致。
- act8 Default / act8e Explore 两轮均收敛（WNS +0.188 / +0.215，TNS=0，WHS>0，DRC 0 Error）；选 act8e 为交付。
- 构建脚本路径改造不改变产物：act8e 与 act8r 载荷 md5 相同（`dcbcf543…`，2,838,980 B），全文件 md5 仅差头部时间戳。
- 风险（供烧板后验证）：WNS 余量 +0.215 ns 仍薄（8 ns 的 2.7%），限制路径集中在 `u_event_sink/u_udp_merge` 事件包长链且 route 占 52.3%；如板上出现事件帧 CRC 异常/丢帧，优先怀疑该路径族。

## 11. 烧板记录（2026-10-31 02:02，Lead 执行）

本节为构建完成后的追加记录。§8「未烧板声明」是**构建时点**的状态描述，与本节不矛盾，原内容未改动。

| 项 | 值 |
|---|---|
| 位流 | `build/variant_act8_final/retina_event.bit` |
| 大小 | 2,839,107 B |
| 全文件 md5 | `5ec55ec07c44f2503df63f1bb160a6e6` |
| 载荷 md5（offset 127 起，2,838,980 B） | `dcbcf543210c33cb22625128bc5f6b97` |
| TARGET | `localhost:3121/xilinx_tcf/Digilent/210512180081` |
| FREQ_SET | 6,000,000（6 MHz） |
| DEVICE | `xc7a100t_0` |
| 结果 | **DONE_PIN=1 / EOS=1 / PROG_RESULT=OK** |

烧板后发流恢复判据：

- 网关 `frameIdx` 从 0 重新递增（现场拉到 477），说明 PL 复位后重新出帧、包序号链重建；
- 空场景 `/api/action` 返回 raw=0、valid=false、class=0，符合「无动作时 byte23=0x00」契约。

### 11.1 附：tb_cam_tap 绝对路径清理（脚本可移植性）

`sim/tb/tb_cam_tap.v` 中原先唯一写死的绝对路径（V4 源码端口扫描的 `$fopen`）已移除：优先 `+CAM_TAP_SRC=<path>`，否则按 run_sim 工作目录依次尝试相对路径 `../../../src/hdl/capture/cam_tap.v`、`../src/hdl/capture/cam_tap.v`、`src/hdl/capture/cam_tap.v`。文件 md5 `46ea7131bebe03d2bd3fda1a47773ff9`。

- 复跑 `pwsh -File tool/run_sim.ps1 -Tb tb_cam_tap` → RC=0、`TEST_RESULT=PASS`、31/31 CHECK PASS（`V4_readonly_no_cam_output` PASS，源文件确实被打开、非跳过）；
- 手工 `vsim +CAM_TAP_SRC=E:/workspace/FPGA_Comp/src/rtl/capture/cam_tap.v` → 打印 `INFO V4_SRC=...`、PASS，覆盖路径可用。

> **勘误（2026-10-31 02:43）**：coder2 对 `nn/out_v7b/rom_offsets.json` 做了路径归一化重生成（绝对路径 → 仓库相对 POSIX 路径），其 sha256 由 `ccfadfe8…` 变为 `3796fd55…`；内容字段未变（15 段基址、5,652 字、ROM_WORDS/AW 等仍逐项一致），部署五件中 params/rom/golden/tb 四件 sha256 逐字未变（DEPLOY_ARTIFACTS_UNCHANGED=1）。§0 表中的旧 sha 为当时记录，保留不改；本证据所有结论不受影响，不涉及重建与位流。

M3J_OK=1
