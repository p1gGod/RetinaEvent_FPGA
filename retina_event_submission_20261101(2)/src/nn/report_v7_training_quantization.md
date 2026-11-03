V7_MODEL_OK=1
QAT_OK=1

# V7 训练与量化报告（M2i / task-42）

> 机读首行：`V7_MODEL_OK=1`、`QAT_OK=1`。判据数值与命令见 §3 与 `nn/_evidence/{V7_MODEL_OK.log,QAT_OK.log}`；部署契约见 `nn/out_v7/INT8_CONTRACT.md`。

## 0. 结论摘要

- 模型：二分类 v7（class1=手部开合，class0=无动作/其它；挥手 y=2 作为加权硬负折进 class0）。表征 = 4 通道 30x50 平移归一化网格 + 7 路全局特征，CNN 4→8→16→24（k3s2，约 207k MAC）+ g1 7→16 + fc 256→2。
- 部署件：`nn/out_v7/nn_params_v7.json`（ROM 5652 words，13 bit 地址）+ `nn/out_v7/nn_rom_data_v7.v`（module nn_rom_data）。两文件逐字符一致，`PARAMS_ROM_MATCH_OK=1`。
- 判据：(a) A 时间外推 int8 开合 17/17、挥手 0 pulse；(b) B 远距时间留出 3/3、挥手 0；(c) C 镜像窗口级差 0.0、chunk 差 0；(d) D 部署模型在 7 min control 上 0 检出（折模型残留 1 pulse 已按 lead m01774 披露）；(e) golden 逐位自检通过，int8/float argmax 一致率最低 0.970775（按 lead m01200 不 gate，≥0.90）。
- 已知取舍：A 的硬负仍有 1 个 int8 pulse（cup_paper 197.8–200 s，抽帧确认手在卷纸，lead m01607 接受）；镜像为合成数据，真实右手未采；折模型 params_fold1 在 static_a 起点 +0.65 s 有 1 pulse（边界过渡，部署模型同批数据 0）。

## 1. 数据口径

- 数据：`nn/v7/windows_v7.npz`，14,447 行，sha256 `74df9dfb3de29a7b3824a3fc45d8a8df6c35a7e9a80111a645b4823fbd573494`。
- 训练集 10,227 窗 = v7_primary 6,558（view A，含 aug0/aug1 镜像副本）+ view B 硬负 1,310（typing/cup_paper/still_B，仅 y=0）+ 7 min control_neg 2,359（y=0）。control_pos 不进训练。
- 标签：y=1 → class1；y=0 / y=2 → class0。挥手 1,020 窗（wave_L + wave_L_far）保留子类权重 3.0，单独统计 class1 命中率与 pulse。
- 折：fold0 7,222 窗 / fold1 7,225 窗；A 时间外推为 fold0 训 → fold1 测（n_test 3,935）与反向（n_test 3,933）。
- 评测节奏：窗宽 100 ms、窗步 50 ms，决策每 2 窗（100 ms，板上 5,000,000 cycles）；margin≥8、N_CONSEC=3、1.5 s 不应期、1.0 s 空窗清零。守卫带：zone 首尾各 0.5 s（5 决策）不计 pulse，判据用 with_guard，另报 without_guard。

## 2. 训练与量化方法

- 特征 7 路：n_div16, prev_n_div16, pol_bal, dx, dy, dx_rel, dy_rel（相对项用 S=max(isqrt(sx*sy),8)；整数公式见契约 §2）。
- 训练：Adam lr=2e-3、wd=1e-4、CosineAnnealing、batch=128、30 epochs、seed=1234；类别权重 clip(sqrt(N/(2·n_c)),0.5,3)；挥手行权重 3.0、硬负行权重 1.0；loss = 加权 CE。
- QAT：8 epochs、lr=3e-4、loss = CE(int8 链路) + 0.5·CE(float)，STE 更新权重；量化 calib_n=2048、headroom=1.0；每层 per-output-channel SH/A/s_y，全部 s_y_is_exact=True。
- 量化逐位实现见 `nn/v7/quant_v7.py`、QAT 见 `nn/v7/qat_v7.py`；训练/评测一条命令见 §3(f)。

## 3. 判据结果

### (a) A_time 时间外推（fold 交叉，int8-in-the-loop）

| 折 | 窗口 acc | int8 argmax 一致率 | 开合块 | 挥手 pulse | 静态 pulse | 空桌面 pulse | 硬负 pulse |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fold0→fold1（n=3,935） | 0.9042 | 0.970775 | 9/9 | 0 | 0 | 0 | 1 |
| fold1→fold0（n=3,933） | 0.8754 | 0.987796 | 8/9 | 1 | 0 | 0 | 7 |
| pooled float | - | - | 16/17（0.9412） | 0 | 0 | 0 | 1 |
| pooled int8 | - | - | **17/17（1.0）** | **0** | **0** | **0** | **1** |

- 窗口级混淆矩阵（fold0→1，float）：true0_pred0=2,197、true0_pred1=178、true1_pred0=199、true1_pred1=1,361；fold1→0：2,134/239/251/1,309。
- 逐 zone（pooled int8）：open 组 1,560 窗、17 块全检出、class1_hit 680（0.8718）、class1_argmax 0.9423；wave 组 1,020 窗、0 pulse、class1_hit 14（0.0275）；static 组 still_B 400 窗 0 pulse；empty 组 empty_A/empty_A2 619 窗 0 pulse；hardneg 组 990 窗 1 pulse、class1_hit 23（0.0465）。
- 唯一硬负 pulse：cup_paper 197.8–200 s（手在卷纸/拨纸，抽帧 `temp_test/v7/frames/cup_174_180.png`），按 lead m01607 接受；with_guard 与 without_guard 均为 1。
- 备注：pooled float 开合 16/17、int8 17/17；int8 在 1 个低置信块上把 float 的漏检翻成检出，其余指标一致。

### (b) B_distance 远距时间留出（far 内前后半）

- 协议：far 前一半训练、后一半测试，镜像副本从训练排除（含全部 view A + 硬负 + control 负）；测试 far 窗 = open_L_far 540 + wave_L_far 400。
- float 窗口 acc 0.916；混淆（float）：true0_pred0=376、true0_pred1=24、true1_pred0=55、true1_pred1=485。
- int8 决策级（m8）：开合 **3/3**、挥手 **0 pulse**（class1_hit 0.04、argmax 0.05）、静态 0、空桌面 0、硬负 0。
- int8 argmax 一致率 0.982979（QAT 前 0.988298，QAT 后略降 0.0053，仍 ≥0.90）。
- 诊断项（不 gate）：near 训 → far 测，开合仅 1/6（0.1667）、窗口 acc 0.5016、挥手 0；说明距离外推仍有缺口，绝对像素特征（dx/dy）在 far 端分布偏移，相对特征尚未完全吸收；§9 列为后续方向。

### (c) C_mirror 镜像迁移（窗口级 ±aug）

| 训练折 | 测试折 | aug0 开合 | aug1 开合 | d_open_window | chunk 差 | d_wave |
| --- | --- | --- | --- | --- | --- | --- |
| fold0 | fold1 | 8/9 | 8/9 | 0.0 | 0 | 0.0078 |
| fold1 | fold0 | 9/9 | 9/9 | 0.0 | 0 | 0.0 |

- 判据：|chunk 差|≤1 且 |窗口 recall 差|≤0.10，**PASS**（本轮最终训练 d_open_window=0.0、chunk 差=0）。
- 历史：更早一次训练的 fold0 曾出现 8/9 vs 9/9、d=0.1111；lead m01607 已接受为粒度噪声。本轮重训后该差异消失，报告仍保留该记录以说明波动量级。
- 诊断项（不 gate）：aug0→aug1 直接迁移 4/9（fold0 训）与 7/9（fold1 训），存在系统性镜像缺口；因镜像为合成数据（view A 水平翻转），只能说明模型未把左手静态特征当唯一线索，不能证明真实右手够用（见 §9）。

### (d) D_empty 退化检查（7 min control + v7 空桌面）

v7 空桌面低 n 窗（n<50）：empty_A 150 窗、empty_A2 160 窗，命中均为 **0**。

同一批 2,359 个 control_neg 窗、同一量化契约、同一决策链下的三模型并列：

| 模型 | with_guard 静态 pulse | without_guard 静态 pulse | 位置/量级 | 空桌面 |
| --- | --- | --- | --- | --- |
| **部署模型 nn_params_v7.json** | **0** | **0** | - | 0 |
| params_fold0（fold0 训练） | 0 | 1 | static_b，全 control 0.882 次/分 | 0 |
| params_fold1（fold1 训练） | 1 | 1 | static_a，起点 +0.65 s，margin 17，zone 内 1.714 次/分、全 control 0.882 次/分（n=1） | 0 |

- 按 lead m01774：判据 (d) 以部署件为准 ⇒ **PASS**；折模型残留按 Known Limitation 披露，不否决判据。
- 该点 0.65 s > 0.5 s 守卫带，**不是被守卫带吃掉**；抽帧（`temp_test/v7/frames/static_a_start.png`）显示掌→握拳后下落，属上一段 openclose 尾部残留在新 zone 起始处的真实运动，标为「边界过渡检出」。
- 部署模型逐 zone：static_a 700 窗、static_b 660 窗、empty_desk 999 窗，pulses=0、class1_hit=0；with/without guard 均 0。

### (e) int8 一致率与逐位契约

- A 留出 int8/float argmax 一致率：fold0→1 **0.970775**（QAT 前 0.960356）、fold1→0 **0.987796**（QAT 前 0.985762）；B far **0.982979**（QAT 前 0.988298）。最低 0.970775 ≥0.90（lead m01200 不 gate）。
- 按 y 分组（fold0→1）：y0 1,355 窗 0.9402、y1 1,560 窗 0.9853、y2 1,020 窗 0.9892；fold1→0：y0 1,353 窗 0.9874、y1 1,560 窗 0.9833、y2 1,020 窗 0.9951。差异集中在近 tie 窗，非决策门限失败。
- 未达原始 (e) 的 0.99 门槛（最低 0.9708）；按 lead m01200/m01607 的修订：硬判据改为 golden 与 RTL 逐位一致 + int8-in-the-loop 决策指标，一致率照报不 gate。本报告如实保留「未到 0.99」这一事实，不用改判据掩盖。
- 逐位证据：`nn/out_v7/golden_vectors.json` = 9 组整网向量 + 6 组预处理向量；`temp_test/v7/_goldcheck.py` 纯 Python 复算 **GOLDEN_SELFCHECK_OK=1**（fails 0，逐层 acc_int32/out_int8/fc_in/logits/class 全等）。TB 常量 `nn/out_v7/tb_golden_v7.vh` 回读自检 **TB_GOLDEN_SELFCHECK_OK=1**（vec=15 bytes=6239 chunks=117 GVN=9 GVP=9 GVEMAX=128）。
- golden 刻意用例：平局（gv_04_empty_A、gv_06_tie1、gv_07_S_floor8、gv_08_clip127，margin_int8=0，argmax 取较小索引即 class0）、全饱和（gv_09_saturate_all127，conv1/2/3/g1 输出全 127、logits=[127,-128]）、n=0 carry（pp02）、非整除质心（pp01）、clamp+SAT（pp03：x=402/y=250 网格 clamp、n_bad=1；两窗各 128 同 cell 事件触发 SAT=127；质心 399→0 使 dx_rel/dy_rel 饱和；原不可表达事件 x=-7 已删除）、正方形手（pp04，sx=sy=28，S=28）、细长手（pp05，sx=28/sy=8，S=14）、var 极小 S 兜底（pp06，S=8）。
- ROM/参数一致性：`PARAMS_ROM_MATCH_OK=1 words=5652 checked=5652`（模块名 nn_rom_data、13 bit、depth 5652、15 段连续覆盖）。

### (f) 可复现性与哈希

- 训练命令（CPU 123.5 s，seed 1234）：

```
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/train_v7.py --data nn/v7/windows_v7.npz --out-dir nn/out_v7 \
  --feats fmin_n_rel7 --wave-weight 3.0 --epochs 30 --seed 1234 --calib-n 2048 --stride 100 \
  --results results_v7_final.json
```

- 校验命令：`nn/v7/check_params_rom.py`（PARAMS_ROM_MATCH_OK=1）、`nn/v7/gen_golden.py --feats fmin_n_rel7`、`temp_test/v7/_goldcheck.py`（GOLDEN_SELFCHECK_OK=1）、`nn/v7/emit_contract.py`。
- 哈希：data `74df9dfb…3494`；params `e61d26da…b9f1`；rom `316ba006…d16`；model `6769edc4…f21`；golden `4f87125e…9f94`；tb_golden_v7.vh `017f7833…e5ca`；rom_offsets `ce3339a9…164b`。完整值见契约 §0。
- **2026-10-31 修订：golden 事件域校验，pp03 原含不可表达事件 x=-7**；golden 与 tb_golden_v7.vh 已重生成（部署参数/ROM/模型未变）。

## 4. with_guard / without_guard 并列表

| 判据 | 指标 | with_guard（判据） | without_guard |
| --- | --- | --- | --- |
| A_time pooled int8 | 开合块 | 17/17 | 17/17 |
| A_time pooled int8 | 挥手 pulse / 次/分 | 0 / 0.0 | 0 / 0.0 |
| A_time pooled int8 | 静态 / 空桌面 pulse | 0 / 0 | 0 / 0 |
| A_time pooled int8 | 硬负 pulse | 1（cup_paper，接受） | 1 |
| B_distance int8 | 开合块 / 挥手 pulse | 3/3 / 0 | 3/3 / 0 |
| D_empty 部署模型 | 静态 pulse | 0 | 0 |
| D_empty fold 模型最大 | 静态 pulse | 1（fold1，static_a） | 1（fold1 static_a；fold0 另有 static_b 1） |

## 5. Known Limitations

1. 镜像（C）效力边界：aug1 为 view A 水平翻转的合成数据，真实右手分布未采集（v5probe 右手片段未进 v7）。C 通过只证明模型未把左手特有静态特征当唯一线索，**不能**证明真实右手够用；后续补真实右手采集。
2. cup_paper 硬负：197.8–200 s 有 1 个 int8 pulse（手在卷纸），已接受并留痕。
3. 折模型边界残余：params_fold1 在 static_a 起点 +0.65 s 1 pulse（margin 17，0.882 次/分，n=1，见 §3(d)）；部署模型同批 0。
4. 距离外推诊断缺口：near→far 开合仅 1/6（窗口 acc 0.5016），绝对 dx/dy 仍受尺度影响；B 正式判据为 far 区内时间留出（3/3）。
5. int8/float 一致率最低 0.9708，未达 0.99；按 lead m01200 修订不 gate，改以 golden 逐位一致 + 决策级 int8 回放为准。
6. 板级尚未联调：本报告为离线整数仿真；RTL 融合按 `nn/out_v7/INT8_CONTRACT.md` 与 golden 逐位对齐，上板误触率待硬件实测。

## 6. 产出物清单

| 文件 | 说明 | SHA256 |
| --- | --- | --- |
| nn/out_v7/model_v7.pt | 最终 float 模型 | 6769edc4332f7839a27184855a1f74fa0ac590137c71a2424d2e9bce29d3af21 |
| nn/out_v7/nn_params_v7.json | 部署参数（7 路/5652 words） | e61d26dacf13167a2fc06ee4c0aaec6d8040e87d9c9c51a7cd0f6a9e00a0b9f1 |
| nn/out_v7/nn_rom_data_v7.v | 部署 ROM（module nn_rom_data，13 bit） | 316ba0066ff1224f7c2e4afe923510fa75e83b8932f58f461f62edc005d62d16 |
| nn/out_v7/INT8_CONTRACT.md | RTL 位精确契约（369 行） | 见文件内 §0 |
| nn/out_v7/golden_vectors.json | 9 整网 + 6 预处理 golden | 4f87125e6ea957c4fe25d248c07610647a628852c6f470915f2bf9e652329f94 |
| nn/out_v7/tb_golden_v7.vh | Verilog-2001 TB 常量（非部署件） | 017f78338c3836342a50eef330a35a990570bad771187a24ff281104af4ed5ca |
| nn/out_v7/results_v7_final.json | 唯一权威评测结果 | - |
| nn/out_v7/rom_offsets.json | ROM 段偏移与双哈希 | ce3339a92c546d123d709982eec20db6ecd397c4f9c6d1e2bdb5d581d0ca164b |
| nn/out_v7/deploy_control.log | 部署/折模型 control 复算 | - |
| nn/_evidence/V7_MODEL_OK.log | 首行 V7_MODEL_OK=1 | - |
| nn/_evidence/QAT_OK.log | 首行 QAT_OK=1 | - |

## 7. 后续建议

1. RTL 按契约 §5 段偏移与 golden 建 TB，先逐层 acc 再整网 logits；ROM 直接复制，不改 module/端口/13 bit 地址。
2. 补采真实右手数据（open/wave/静默），复跑 §3(f) 命令并重新生成 golden/契约。
3. 若后续要求 int8 argmax ≥0.99：优先对近 tie 窗做 per-channel SH 调整或 QAT 延长，不调决策门限。
4. far 端若仍不够：考虑把 dx/dy 也归一化（或只保留相对项 + S），先以 B 诊断项作为回归指标。
