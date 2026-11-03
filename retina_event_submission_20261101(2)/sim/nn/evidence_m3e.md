TB_ENGINE_V7_OK=1
ENGINE_SYNTH_OK=1
REGRESS_19TB_OK=1
# task-51（M3e）证据：v7 融合引擎（G1 全局量支路 + fc 输入 256 + v7 ROM 定版接入）

- 负责人：rtl2；日期：2026-10-31；工程：E:/workspace/FPGA_Comp/retina_event
- 结论：nn_engine 由「4 通道 CNN -> 3 分类」改为 v7「CNN + 7 路全局量 G1 支路 -> 二分类」；6 组 golden 向量逐层逐字节相等；19 个 TB 回归全 RC=0；全系统 synth OK。资源相对 M3d 基线 +1,455 LUT（超任务卡 +900 预算 555），按 Lead 裁决（口径修正，见 §7.4）以实测值收口。
- 路径约定：除特别标注外，所有路径相对 retina_event/。

## 0. 交付物清单（md5 = md5sum，sha256 用于 ROM/契约）

| 文件 | 行数 | 字节 | 摘要 |
|---|---|---|---|
| src/hdl/nn/nn_cfg.vh | 254 | 15,534 | md5 29894badf0efb3af90e8ac0801e9097a |
| src/hdl/nn/nn_rom_data.v | 5672 | 197,178 | md5 5292446495620e49514f6fd90a8589d5；sha256 316ba0066ff1224f7c2e4afe923510fa75e83b8932f58f461f62edc005d62d16（= nn/out_v7/nn_rom_data_v7.v） |
| src/hdl/nn/nn_engine.v | 497 | 23,602 | md5 c64f3482bdd98aa0d31361a68db87a26 |
| src/hdl/nn/nn_top.v | 386 | 17,382 | md5 7a48b349d70462bbc1597c511cb9f18e |
| sim/tb/tb_nn_engine_v7.v | 362 | 15,529 | md5 629922f30648875ffabc2e34a9b9a87a（新建） |
| sim/tb/tb_nn_engine_v7.f | 3 | 68 | md5 b0bd3d209275ca9c426a2dd473dec950（新建） |
| sim/tb/tb_nn_engine_v7_vectors.vh | 27 | 121,010 | md5 7e75b4976af37422cdc0fa4e3e7dff64（生成物，禁手改） |
| tool/nn_engine_synth_v7.tcl | 135 | 6,145 | md5 4af4ed57eefa6163dd901bb8a7fe0a7b（新建） |
| sim/tb/tb_nn_engine.v（改 v7 期望） | 456 | 19,738 | md5 5294cf92e63ceff11ccfdf04bed23326 |
| sim/tb/tb_nn_top.v（改周期期望） | 417 | 19,814 | md5 59c511700d67b2655e560c81155955a6 |
| sim/tb/tb_nn_top.f / tb_nn_integ.f / tb_top_retina_event.f | 9 / 9 / 54 | - | 各加一行 src/hdl/nn/nn_winfeat.v |
| temp_test/rtl2/gen_engine_v7_vectors.py | 85 | 3,547 | md5 ff43e7845af49309035a982962a7a4e1（生成脚本，非交付物） |
| temp_test/rtl2/check_cfg_v7.py | - | - | md5 c07fd8ad6cd17bd2123a52eb9b75c026（独立校验脚本，非交付物） |

## 1. 权威输入（只读，本卡未改 nn/**、docs/**、host/**）

- nn/out_v7/rom_offsets.json：rom_words=5652、addr_bits=13、params_sha256=e61d26dacf13167a2fc06ee4c0aaec6d8040e87d9c9c51a7cd0f6a9e00a0b9f1、rom_sha256=316ba0066ff1224f7c2e4afe923510fa75e83b8932f58f461f62edc005d62d16。
- nn/out_v7/INT8_CONTRACT.md：sha256 d321fa176703f9fd72e94d717ec2420b9e16331ad9694b4f00af185c65063985（26,183 B）；§argmax 平局取较小索引、fc clamp(-128,127)、conv/g1 clamp(0,127)+ReLU、SH 逐通道。
- nn/out_v7/golden_vectors.json：sha256 4f87125e6ea957c4fe25d248c07610647a628852c6f470915f2bf9e652329f94（task-48 重生成版，去掉不可表达事件 x=-7）。
- nn/out_v7/nn_params_v7.json：sha256 e61d26da…（与 rom_offsets 一致）。

## 2. RTL 改动（逐文件）

### 2.1 nn_cfg.vh
- §3 新增 G1 段：NN_G1_CIN=7 / NN_G1_COUT=16 / NN_G1_T=7；NN_FC_CONV_IN=(NN_L3_COUT*NN_L3_OUTHW)=240；NN_FC_CIN=(NN_FC_CONV_IN+NN_G1_COUT)=256；NN_FC_T=256；NN_WFC_WORDS=2*256=512。
- §4 整段按 v7 布局重写（宏链推导，非硬编码）：W1=0 / W2=288 / W3=1440 / WG=4896 / WFC=5008 / B1=5520 / B2=5528 / B3=5544 / BG=5568 / BFC=5584 / SH1=5586 / SH2=5594 / SH3=5610 / SHG=5634 / SHFC=5650 / ROM_WORDS=5652；NN_ROM_AW 仍 13。
- §5 layer 编码扩为 3 bit：NN_LAYER1=3'd1 / NN_LAYER2=3'd2 / NN_LAYER3=3'd3 / NN_LAYERG1=3'd4 / NN_LAYERFC=3'd0（conv 用 ky/kx，g1/fc 点积，区别在 is_relu 与激活来源）。

### 2.2 nn_rom_data.v
- 整文件替换为 nn/out_v7/nn_rom_data_v7.v（两次 sha256 相同，见 §0），模块名/端口不变：nn_rom_data(output reg [31:0] o_dout, input clk, input [12:0] i_addr)，rom[0:5651]。

### 2.3 nn_engine.v（v7）
- 端口新增 input wire signed [7:0] i_g1_f0..i_g1_f6（:76-82；顺序 LSB 语义 n_div16/prev_n_div16/pol_bal/dx/dy/dx_rel/dy_rel），其余端口不变。
- layer 改 reg [2:0]；新增 is_fc/is_g1/is_dot/is_relu（:122-124）：is_dot = fc|g1（tap 只沿 cin 推进、无 ky/kx），is_relu = ~is_fc（conv1/2/3 与 g1 都 ReLU，fc 不 ReLU）。
- 层参数组合 case 新增 NN_LAYERG1（:151）：L_CIN=7 / L_T=7 / L_HO=1 / L_WO=1 / L_COUT=16 / WBASE=NN_WG_BASE / BBASE=NN_BG_BASE / SBASE=NN_SHG_BASE；FC 分支 L_CIN=256 / L_T=256。
- g1 输入锁存 g1_f0..f6（S_IDLE 的 i_start 拍）与 feat_sel 选择器（:169-183，case(cin[2:0])）。
- bufC 由 240 扩到 [0:NN_FC_CIN-1]=256（:192）；act_addr：fc = cin、g1 = 0（:224）；act_bus：g1 = feat_sel、fc/L2/L3 = act_q（:255）；q_out 用 is_relu 门控（:290）；tap_last = is_dot ? tap_last_dot : tap_last_conv（:298）；S_PIX4 pix_base = is_dot ? 0 : ...。
- S_FIN：L1->bufA[och*336+oy*24+ox]、L2->bufB[och*66+oy*11+ox]、L3->bufC[och*10+oy*5+ox]、G1->bufC[240+och]、FC->o_res_l0/l1/l2（och 只有 2 类 => l2 保持复位 0）。
- 层链 L1->L2->L3->G1->FC->S_DONE。

### 2.4 nn_top.v（只做接线，不动对外端口集合）
- 统一窗沿 win_tick = feat_ready && (wt_cnt == WIN_CYC-1)（:93），同时送 u_feat.i_win_tick 与 u_ws.i_win_tick。
- u_ws（:135）的 13 个 o_snap_* 接 nn_winfeat u_winfeat（:183-208）：i_snap_valid/i_n/i_on/i_off/i_sx/i_sy/i_sx2/i_sy2/i_cx/i_cy/i_pcx/i_pcy/i_prev_n；输出 o_n_div16..o_dy_rel -> gf_*。
- u_eng（:253）新增 .i_g1_f0(gf_n_div16) ... .i_g1_f6(gf_dy_rel)（:261-267），其余端口不变。
- 7 路已由 nn_winfeat 输出为 int8 有符号 wire，直接进引擎，不造 o_feat_bus（审计 D8）。

## 3. 审计 9 条 -> 本卡处置（依据 sim/nn/EVIDENCE_REVIEW_V7.md）

| ID | 级别 | 审计差异 | 本卡处置 | 证据 |
|---|---|---|---|---|
| D1 | 严重 | 训练 50 ms 滑窗 vs 板端 100 ms 连续 bin（prev 窗时基） | 本卡范围外：WIN_CYC 仍 32'd5000000（100 ms 非重叠，nn_cfg.vh:87），nn_feat 未改；Lead 已另派 task-59 | §2.1（未改该行） |
| D2 | 严重 | g1 未实现，layer 2 bit 用满，ReLU/tap_last 走错分支 | 已修：layer 3 bit + G1 层码 + is_dot/is_relu 解耦五处（tap_last/tap 推进/pix_base/ch_base_of/act_bus+q_out） | §2.3、§4.3 B2/B3/B5 |
| D3 | 严重 | fc 输入 256 而 bufC 240，g1 16 个输出无地址 | 已修：bufC 扩 256，g1 写 bufC[240+ch]，fc L_CIN=256 | §4.2 每向量 G1_ALL/FC_ALL 逐值；§4.3 B5 分界 |
| D4 | 严重 | ROM 段偏移 9 处旧布局，WFC 480 vs 512 | 已修：cfg §4 整段重写 + ROM 同批替换；独立脚本对 rom_offsets.json 15/15 段基址 OK | §5 CFG_V7_OK=1 |
| D5 | 高 | g1 7 路输入无端口/顶层通路，winfeat 未例化 | 已修：nn_engine 加 7 个 int8 端口；nn_top 例化 nn_winfeat 并直连 | §2.4、§4.2 |
| D6 | 中 | 周期口径（旧 439,601 / 440,087） | 实测 439,981，预算 442,000；tb_nn_engine_v7 每向量断言，tb_nn_engine/tb_nn_top 期望同步 | §4.4、§6 |
| D7 | 中 | 空窗 1 s 清连续计数未实现 | nn_decide 未改（Lead 裁定，文档注明；IDLE 只清 byte23） | §9 遗留 |
| D8 | 中 | 任务卡文案 o_feat_bus 不存在、拼接顺序易反 | 采用 7 个独立 8 bit 端口（不造总线），nn_top 注释写明 LSB=n_div16..MSB=dy_rel | §2.4 |
| D9 | 低 | o_act_conf=min(margin,31) vs 契约全精度 | nn_decide 保持现状，文档注明 | §9 遗留 |

## 4. TB_ENGINE_V7_OK=1（tb_nn_engine_v7）

### 4.1 命令与结果
~~~
cd /e/workspace/FPGA_Comp/retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine_v7
=> [PASS] tb_nn_engine_v7；exit code 0；TEST_RESULT=PASS；INFO_CHECK_TOTAL=76；INFO_ERRORS=0
~~~
- .f 三行：src/hdl/nn/nn_engine.v / src/hdl/nn/nn_rom.v / src/hdl/nn/nn_rom_data.v。
- TB 结构：DUT = nn_engine + nn_rom；6 组 golden 向量（GVN=6）逐层聚合比对，B1..B5 定向用例通过层级写 ROM（dut.u_rom.u_rom_data.rom）构造。
- 向量 .vh 由 temp_test/rtl2/gen_engine_v7_vectors.py 从 golden_vectors.json 生成（X 6000 / conv1 2688 / conv2 1056 / conv3 240 / g1 16 / fc 2 / fc.in 256 逐组长度断言 + fc.in[0:240]==conv3、fc.in[240:256]==g1 拼接契约断言），元素 i 在 bit [i*8 +: 8]。

### 4.2 6 组 golden 向量逐层对拍（全部 bit-exact）

| 向量 | golden id | 7 路 feat（hex） | logits（hex/十进制） | conv1 2688 | conv2 1056 | conv3 240 | g1 16 | fc 2 | 周期 |
|---|---|---|---|---|---|---|---|---|---|
| VEC0 | gv_01_open_left_aug0 | 00 00 b4 06 fa 10 f8 | fe/ff (-2/-1) | PASS | PASS | PASS | PASS | PASS | 439,981 |
| VEC1 | gv_02_open_left_aug1 | 00 00 81 1f 0a 7f 7f | fb/fd (-5/-3) | PASS | PASS | PASS | PASS | PASS | 439,981 |
| VEC2 | gv_03_wave_left | 7f 65 05 ff fe fa fa | 01/f3 (1/-13) | PASS | PASS | PASS | PASS | PASS | 439,981 |
| VEC3 | gv_04_empty_A | 00 00 00 00 00 00 00 | ff/ff (-1/-1) | PASS | PASS | PASS | PASS | PASS | 439,981 |
| VEC4 | gv_05_static_a | 36 3e 2a fd fa f6 f4 | 05/f7 (5/-9) | PASS | PASS | PASS | PASS | PASS | 439,981 |
| VEC5 | gv_06_tie1 | 00 00 00 00 00 00 00 | ff/ff (-1/-1) | PASS | PASS | PASS | PASS | PASS | 439,981 |

- 每组 9 条 CHECK：ENGINE_V7_RUN_CYC_439981 / ENGINE_V7_CYC_BUDGET_442000 / ENGINE_V7_NO_X_LOGITS / ENGINE_V7_RES_L2_ZERO / CONV1_ALL(2688 values) / CONV2_ALL(1056) / CONV3_ALL(240) / G1_ALL(16) / FC_ALL(2) => 6*9=54 条。
- 逐层含义：conv1 = bufA[0:2687]，conv2 = bufB[0:1055]，conv3 = bufC[0:239]，g1 = bufC[NN_FC_CONV_IN..NN_FC_CIN-1]=bufC[240:255]，fc = o_res_l0/o_res_l1。

### 4.3 定向边界用例（22 条 CHECK，覆盖任务卡四类边界 + g1/fc 分界）

| 组 | 构造 | 判据 | 实测 |
|---|---|---|---|
| B1 空窗/全零网络 | ROM 全 0 + 特征全 0 | bufA/bufB/bufC[0:239]/bufC[240:255] 全 0、logit0/1=0、周期 439,981（7 条） | 全 PASS |
| B2 g1 通路 + fc 求和 | g1_b[ch]=ch、SHG=0、WG 对角 1；fc_w[0][240+ch]=1 | bufC[240+ch]==ch；logit0=0+1+...+15=120；logit1=0（4 条） | 120 / 0 PASS |
| B3 clamp 上/下饱和 + ReLU | g1_b[0]=2000、g1_b[1]=-2000；fc_w[0][240]=1、fc_w[1][240]=-3 | bufC[240]=127；bufC[241]=0（g1 也接 ReLU）；logit0=127；logit1=-128（8'h80，打印 got=128）（4 条） | PASS |
| B4 平局 | fc_w[0][241]=fc_w[1][241]=1、g1_b[1]=5 | logit0==logit1==5（平局交给 nn_decide 取较小索引）（3 条） | PASS |
| B5 g1/fc 分界 | conv3_b[23]=1、fc_w[0][239]=1 且 fc_w[0][240]=0；g1_b[0]=2、fc_w[1][240]=1 | bufC[239]=1、bufC[240]=2；logit0 只由 239 贡献=1；logit1 由 240 贡献=2（4 条） | PASS |

### 4.4 实测周期（439,981 拍 <= 442,000 预算）

| 阶段 | 拍数 | 推导（每像素 = 5 拍头 + 1 拍 S_FIN + 2*T 拍 MAC） |
|---|---|---|
| conv1 | 209,664 | 2688 px * (6 + 2*36=78) |
| conv2 | 158,400 | 1056 px * (6 + 2*72=150) |
| conv3 | 70,560 | 240 px * (6 + 2*144=294) |
| g1 | 320 | 16 px * (6 + 2*7=20) |
| fc | 1,037 | 2 px * (6 + 2*256=518) + S_DONE 1 |
| 合计 | 439,981 | 旧 2 类 439,597 + g1 320 + fc 240->256 多 64 |

- 探针：build/sim/v7_compile/tb_cyc.v（统计 o_busy 高电平拍）= 439,981；tb_nn_engine_v7 的 6 组向量与 B1..B5 实测同为 439,981。
- @50 MHz = 8.80 ms，占 100 ms 窗 8.8%。预算 442,000 => 余量 2,019 拍。

## 5. ROM 布局独立校验（CFG_V7_OK=1）

命令：cd /e/workspace/FPGA_Comp && ./trainingData/.venv/Scripts/python.exe temp_test/rtl2/check_cfg_v7.py

~~~
CFG_CHECK NN_W1_BASE   got=0     exp=0     OK
CFG_CHECK NN_W2_BASE   got=288   exp=288   OK
CFG_CHECK NN_W3_BASE   got=1440  exp=1440  OK
CFG_CHECK NN_WG_BASE   got=4896  exp=4896  OK
CFG_CHECK NN_WFC_BASE  got=5008  exp=5008  OK
CFG_CHECK NN_B1_BASE   got=5520  exp=5520  OK
CFG_CHECK NN_B2_BASE   got=5528  exp=5528  OK
CFG_CHECK NN_B3_BASE   got=5544  exp=5544  OK
CFG_CHECK NN_BG_BASE   got=5568  exp=5568  OK
CFG_CHECK NN_BFC_BASE  got=5584  exp=5584  OK
CFG_CHECK NN_SH1_BASE  got=5586  exp=5586  OK
CFG_CHECK NN_SH2_BASE  got=5594  exp=5594  OK
CFG_CHECK NN_SH3_BASE  got=5610  exp=5610  OK
CFG_CHECK NN_SHG_BASE  got=5634  exp=5634  OK
CFG_CHECK NN_SHFC_BASE got=5650  exp=5650  OK
CFG_ROM_WORDS got=5652 exp=5652 OK
CFG_ROM_AW got=13 exp=13 OK
CFG_XCHECK NN_W1_WORDS 288 / NN_W2_WORDS 1152 / NN_W3_WORDS 3456 / NN_WG_WORDS 112 / NN_WFC_WORDS 512 / NN_G1_CIN 7 / NN_G1_COUT 16 / NN_FC_CONV_IN 240 / NN_FC_CIN 256 / NN_NUM_CLASSES 2 全 OK
ROM_HEX_WORDS=5652
CFG_V7_BAD=0
CFG_V7_OK=1
~~~

- 方法：脚本解析 nn_cfg.vh 的宏定义（含 NN_CV_HO/NN_CV_WO/NN_CV_ROWSTEP 函数式宏展开）后逐值求值，与 nn/out_v7/rom_offsets.json 的 sections[start] 比对；ROM 字数用 nn_rom_data.v 里 32 bit 字面量计数（5652 个）。
- 该脚本自证：NN_FC_CONV_IN=240 / NN_FC_CIN=256 => WFC_WORDS=512（不是旧 480），g1_w 与 fc_w 不混叠。

## 6. 回归（19 个 TB，全 RC=0；日志 build/regress_m3e.log）

命令：cd retina_event && pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>（逐个跑，退出码见下表）

| # | TB | RC |
|---|---|---|
| 1 | tb_act3_hdr | 0 |
| 2 | tb_act3_tlv | 0 |
| 3 | tb_nn_feat | 0 |
| 4 | tb_nn_engine | 0 |
| 5 | tb_nn_top | 0 |
| 6 | tb_udp_merge | 0 |
| 7 | tb_wire_v3 | 0 |
| 8 | tb_downlink_cmd | 0 |
| 9 | tb_uart_baud | 0 |
| 10 | tb_uart_link | 0 |
| 11 | tb_stall_repro | 0 |
| 12 | tb_udp_mtu_cap | 0 |
| 13 | tb_top_retina_event | 0 |
| 14 | tb_nn_winstat | 0 |
| 15 | tb_act3_idleclr | 0 |
| 16 | tb_act3_ctrlhdr | 0 |
| 17 | tb_nn_integ | 0 |
| 18 | tb_nn_engine_v7 | 0 |
| 19 | tb_nn_winfeat | 0 |

- 17 个既有 TB + 2 个本阶段新增（tb_nn_engine_v7 / tb_nn_winfeat）。
- tb_nn_engine（改 v7 期望）：**20 PASS + 1 SKIP**（CHECK 行数 20 -> 21，**新增 E2_G1_DECOUPLE**，断言 bufC[240:255] 全 0，证明 fc 的 256 路输入后 16 路是独立段；E1_CYCLE_CNT/E2_CYCLE_CNT 期望改 439,900..440,100，CHECK 名保留；未删任何 CHECK）。SKIP 项 = E1_FC_L2_NEG_KEEP：NUM_CLASSES=2 时第 3 路 logit 被 nn_decide 钉 -128、该断言不适用，tb 的 skip() 打印 `CHECK=E1_FC_L2_NEG_KEEP SKIP (NUM_CLASSES=2, class2 unused)`，不参与 PASS/FAIL 判定、CHECK 行数不减（Lead m02812 订正：此前「21 CHECK 全 PASS」措辞不准确）。该订正后（仅 nn_rom.v 头注释改动，无逻辑变化）已复跑 tb_nn_engine：EXIT=0、TEST_RESULT=PASS、20 PASS + 1 SKIP（build/sim/tb_nn_engine/vsim.log:37 为 SKIP 行、:53 为 TEST_RESULT）。
- tb_nn_top：31 CHECK 全 PASS（CHECK 数不变）；TF_BUSY_DUR_2cls 改名为 TF_BUSY_DUR_V7_439981、区间改 439,900..440,100（旧期望 439,500..439,700 因新增 g1 层 320 拍 + fc 256 路多 64 拍而不再成立）；文件头注释加 M3e 说明。
- 其余 17 个 TB 未改期望值（既有断言仍成立）。

## 7. ENGINE_SYNTH_OK=1（全系统 synth_design，不 place/route）

### 7.1 命令与结果
~~~
cd /e/workspace/FPGA_Comp/retina_event
RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass \
  -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 \
  E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch \
  -source tool/nn_engine_synth_v7.tcl -log build/integ_synth_v7.log -journal build/integ_synth_v7.jou
=> run_awake exit code 0（VIVADO_RC=0）；ACT_V7_STEP=synth_done；ACT_V7_DONE=1
~~~
- 0 条 ERROR；6 条 CRITICAL WARNING 全为既有 ila_sccb / ila_dbg（ILA_EN=0 未例化，与 act3/act3b 全构建同源）。
- 网表自证（get_cells -hier）：u_nn_top 6,874 / u_ws 1,743 / u_winfeat 3,030 / u_eng 991 / u_feat 735 / u_act_state_cdc 123 / u_udp_merge 1,768 个 cell => nn_winfeat 与 v7 引擎都在综合网表里。

### 7.2 资源（build/integ_synth_v7/act_v7_util_synth.rpt）

| 项 | M3d 全系统 synth 基线 | v7 本次 | 增量 | 任务卡预算 | 结论 |
|---|---|---|---|---|---|
| Slice LUTs | 21,913 | 23,368 | +1,455 | <= +900 | **超 555（Lead 裁决接受，见 7.4）** |
| LUT as Memory | 5,922 | 5,922 | 0 | - | OK |
| Slice Registers (FF) | 12,444 | 14,533 | +2,089 | - | Lead 护栏 14,500：超 33（0.2%，噪声级） |
| Block RAM Tile | 87 | 87 | 0 | <= +2 | OK |
| DSPs | 7 | 8 | +1 | <= +2 | OK |

- 器件占用：LUT 23,368/63,400 = 36.86%；FF 14,533/126,800 = 11.46%；BRAM 87/135 = 64.4%；DSP 8/240 = 3.3%。
- 与 M3d 基线同阶段（synth vs synth）、同一 TCL 口径（同一 project、同一 fileset 重建流程、同 ETH_EN=1）。

### 7.3 LUT 增量构成（为什么 +1,455）
- nn_winfeat 接入是主项：task-48 OOC synth 实测 1,068 LUT / 1,562 FF / 1 DSP（out-of-context，不含顶层布线/其它逻辑），此前 M3d 基线里 nn_winfeat 尚未被 nn_top 例化。
- 引擎 v7 改动（g1 点积层 320 拍状态机 + bufC 240->256 + fc tap 256 + 7 路 feat 选择器）为余量。
- 任务卡的 +900 预算把「OOC 增量」当「全系统增量」叠加，未把 nn_winfeat 的 1,068 LUT 计入 => 预算本身偏低。

### 7.4 Lead 裁决（2026-10-31，m02706/m02711 摘要）
原文要点：「按实测值收口（方案 A），本卡内不做缩位宽。理由：+900 是把 OOC 增量当全系统增量叠加的估算错误；口径以全系统同阶段 synth 为准：LUT 21,913 -> 23,368（Δ+1,455，占器件 36.9%）、FF 12,444 -> 14,533（11.5%）、DSP 7->8、BRAM/LUTRAM 不变；FF 只超护栏 33（0.2%），噪声级，不构成动作理由。真正的约束是 act3c 那条走线主导路径（u_event_sink/u_cdc_raw_fifo -> u_udp_merge/raw_ram，eth_rxc 125 MHz，7.06 ns 里 68.8% 是走线），只有 place/route 能回答。」

=> 本卡以实测值收口：ENGINE_SYNTH_OK=1；资源超 +900 预算 555 属**口径修正**，不是失败；不缩位宽，时序收敛留给 task-52（act7 完整构建 place/route）回答。

## 8. 复现命令
~~~
cd /e/workspace/FPGA_Comp
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/gen_engine_v7_vectors.py   # 重新生成 tb_nn_engine_v7_vectors.vh
./trainingData/.venv/Scripts/python.exe temp_test/rtl2/check_cfg_v7.py              # CFG_V7_OK=1
cd retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_engine_v7    # TB_ENGINE_V7_OK
RETE_GENERICS="ETH_EN=1" pwsh -NoProfile -ExecutionPolicy Bypass -File E:/workspace/FPGA_Comp/temp_test/run_awake_cmd.ps1 E:/Programs/Xilinx/Vivado/2020.2/bin/vivado.bat -mode batch -source tool/nn_engine_synth_v7.tcl -log build/integ_synth_v7.log -journal build/integ_synth_v7.jou
~~~

## 9. 结论与遗留
- 判据：TB_ENGINE_V7_OK=1（76 CHECK 全 PASS，6 组向量逐层 bit-exact + B1..B5 边界）、ENGINE_SYNTH_OK=1（synth 完成，资源按 Lead 裁决收口）、回归 19/19 RC=0。
- 遗留（不在本卡范围，已在 §3 表标注）：D1 prev 窗时基（task-59）；D7 空窗 1 s 清连续计数（nn_decide 未改）；D9 conf=min(margin,31) 文档注明；o_glob_bus/o_glob_valid 顶层仍未接（下一张卡接线后再复测资源增量）。
- 未烧板、未 impl/place/route/write_bitstream、未做 git 写。
- 已知副作用：本 TCL 与 tool/build_inproc.tcl 同源，open_project + add_files 会重写 prj/retina_event.xpr（M3c/M3d 已记录，未做 git 操作）。

M3E_OK=1
