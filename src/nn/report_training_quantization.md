TRAIN_OK=1 QUANT_OK=1 REF_OK=1

# M2 训练与量化报告（P1 int8 CNN）

TRAIN_OK=1 QUANT_OK=1 REF_OK=1

本报告对应 task-7（M2）。所有数字均来自本机实测，命令与退出码见
nn/_evidence/TRAIN_OK.log、QUANT_OK.log、REF_OK.log。训练/量化脚本只读
M1 的 dataset_v3_w100.npz，没有修改任何 dataset/stats 文件。

## 1. 结论摘要

| 项目 | 数值 | 说明 |
|---|---|---|
| 数据 | 1729 窗（100 ms 窗 / 50 ms 步进） | w100，20 会话 |
| 类别窗口数 | class0=823（含板移 95）/ class1=701 / class2=205 | M1 v3 口径 |
| 官方固定 test | n=189，acc=0.9153，balanced=0.9328 | 只有 class0/class1，无 class2 |
| 会话分组 5 折 CV | acc=0.8346，balanced=0.7599 | 全部 1729 窗各测一次 |
| CV class2 recall | 0.5415（P=0.4955） | 3 个会话，折间 0.19~0.76 |
| float 测试准确率 | 0.9153 | 官方 test |
| int8 测试准确率 | 0.9577（drop = -4.23 pp） | 官方 test，见 §5 的统计警告 |
| float/int8 argmax 一致率 | 0.9577（181/189） | 8 个窗口预测不同 |
| 逐位参考一致率 | 1.0000（189/189） | REF_OK=1 |
| ROM | 5718 字，独立结构检查通过 | nn/out/nn_rom_data.v |

三条判据的机读输出（实测）：
- TRAIN_OK=1（train.py 末行打印，EXIT=0）
- QUANT_OK=1（quantize.py 末行打印，EXIT=0）
- REF_OK=1（ref_cnn.py --check 末行打印，EXIT=0）

## 2. 数据与切分

- 数据文件：E:/workspace/FPGA_Comp/nn/dataset_v3_w100.npz（只读）。
- 输入：X_q，int8，shape (N,4,30,50)，通道顺序 [ON_now, OFF_now, ON_prev, OFF_prev]，
  网格 GRID_SHIFT=3 -> 30x50；窗长 100 ms，步进 50 ms。
- 类别映射（M1b/M1c）：class0=无动作或板子位移噪声；class1=手部开合（动作一+动作二合并）；
  class2=横向挥手（动作三，3 个会话）。
- 官方固定切分（M1 已定，未改动）：test = 191905 + 192720 两条会话，共 189 窗；
  其余 18 条会话 train，共 1540 窗。**官方 test 只有 class1 与其会话内的 class0 窗，
  没有 class2**，因此不能在官方 test 上计算 3 类混淆矩阵。
- 为给出 3 类指标，额外做 5 折“按会话分组”CV：20 条会话按 (类别, 参数组, source)
  分层后确定性轮转分到 5 折，同一会话绝不跨 train/test；每个窗口恰好被测试一次。
  该 CV 只用于报告，不参与模型选择。
- 说明：5 折中 class2 只出现在 3 折（每折留出 1 条 class2 会话，训练集仍有另外 2 条），
  另 2 折的 test 没有 class2，故 balanced accuracy 只在“该折存在的类”上平均。

## 3. 模型与训练

- 网络：model.py 的 P1CNN，与 M3 RTL 契约逐字一致：
  conv1 4x30x50 -> 8x14x24（k3,s2,p0），conv2 -> 16x6x11，conv3 -> 24x2x5，
  fc 240 -> 3；conv 后 ReLU，fc 不 ReLU；无 BatchNorm、无 dropout。
- 参数量：5667 = 权重 5616 + 偏置 51。
- 训练：Adam，lr=2e-3，cosine 退火 40 epoch，batch=128，weight_decay=1e-4，
  seed=1234，CPU（torch 2.15.0+cpu），最终模型在官方 train split（1540 窗）训练。
- 损失：交叉熵，类别权重按 sqrt(平衡权重) 计算（clipped 0.5~3.0），以缓解 class2 少样本。
- 最终模型 2.6 s 训完；5 折 CV 每折 2.5~3.2 s。

## 4. 训练结果

### 4.1 官方固定 test（189 窗，只有 class0/class1）

- accuracy = 0.915344，balanced_accuracy = 0.932773
- 混淆矩阵（行=true，列=pred，顺序 0/1/2）：
  [[70, 0, 0],
   [8, 103, 8],
   [0, 0, 0]]
- 每类：class0 P=0.8974 R=1.0000（n=70）；class1 P=1.0000 R=0.8655（n=119）；
  class2 n=0（无法评估）。
- 解读：class0（该 test 会话中活动段之外的窗）全部识别；class1 有 8 窗被当成 class0、
  8 窗被当成 class2。

### 4.2 会话分组 5 折 CV（1729 窗，3 类）

- accuracy = 0.834586，balanced_accuracy = 0.759945
- 混淆矩阵（行=true，列=pred）：
  [[765, 32, 26],
   [ 47, 567, 87],
   [  6,  88, 111]]
- 每类：
  class0 P=0.935208 R=0.929526 F1=0.932358（n=823）
  class1 P=0.825328 R=0.808845 F1=0.817003（n=701）
  class2 P=0.495536 R=0.541463 F1=0.517483（n=205）
- 每折：acc = 0.7890 / 0.9490 / 0.8286 / 0.8692 / 0.7547；
  class2 recall（有 class2 的 3 折，support 58/74/73）= 0.1897 / 0.7568 / 0.6027。
  折间差异大，说明 class2 跨会话泛化仍不稳定；详见 REPORT_评估.md。

## 5. int8 量化与 ROM

### 5.1 量化方案

- 输入就是 dataset 的 X_q（int8，计数饱和 127），输入 scale s_x=1.0，不需要额外缩放。
- 对每一层：把上一层每个输入通道的激活 scale s_x 折进权重目标
  w_eff = w_f * s_x，然后每个输出通道取 A[oc] = max|w_eff|/127，
  w_q = round(w_eff/A[oc]) clip 到 [-127,127]（int8）。
- 每输出通道的 requant 移位 SH[oc] 选为 round(log2(s_y_target/A[oc]))，clamp 0..31；
  实际输出 scale 为 s_y = A[oc] * 2^SH[oc]（必须是 2 的幂关系，满足 RTL 契约）。
  SH 只依赖 A 和校准得到的输出上限，RTL 只存整数 SH，不存浮点 scale。
- bias：b_q = round(b_f/A[oc])，全部落在 int32 内。
- 校准集：从 train split 随机取 512 窗（固定 rng seed=1234）；**没有使用官方 test 选 scale**。
- 各层 SH（逐通道）：
  conv1: [7,8,8,7,8,8,7,8]
  conv2: [10,10,8,8,8,9,9,9,10,8,8,10,8,8,10,9]
  conv3: [9,8,8,8,8,9,9,7,9,8,8,8,9,9,9,9,8,8,8,8,8,10,10,8]
  fc:    [10,8,9]
  全部为整数且 0<=SH<=31；conv 输出 ReLU，fc 不 ReLU。

### 5.2 量化精度

- 官方 test：float acc=0.9153，int8 acc=0.9577，drop=-4.23 pp（int8 反而高 8 个窗口）。
- int8 混淆矩阵：[[70,0,0],[8,111,0],[0,0,0]]；float/int8 argmax 一致率 0.9577（181/189）。
- 训练子集前 256 窗：float/int8 argmax 一致率 0.9883。
- **统计警告**：官方 test 只有 189 窗，8 个窗口差异约 4.2 pp；这里的“负掉点”是小样本
  波动 + 量化噪声的正则化效果，不能声称 int8 本质上优于 float。判据只要求 drop<=2 pp，
  实测 -4.23 pp，满足。
- int8 逐层输出统计（官方 test）：conv1/2/3 的输出都出现 127 上饱和（out_max=127），
  fc 输出 [-105,127]；说明校准取 max 时仍可能在测试集上裁剪。若后续 RTL 实测精度下降，
  优先检查这里，可把校准窗数从 512 提高到全 train 或改用 99.9 分位 + 饱和率约束
  （会改变 SH，需要重跑 quantize.py 并重新 ref 对拍）。

### 5.3 ROM

- 文件：E:/workspace/FPGA_Comp/nn/out/nn_rom_data.v（199497 B），由 quantize.py 生成，
  禁止手写。
- 模块：nn_rom_data(output reg [31:0] o_dout, input clk, input [12:0] i_addr);
  reg [31:0] rom [0:5717]; initial begin ... end; always @(posedge clk) o_dout <= rom[i_addr];
- 布局：5616 权重 + 51 bias + 51 SH = 5718 字：
  [0,288) conv1 w；[288,1440) conv2 w；[1440,4896) conv3 w；[4896,5616) fc w；
  [5616,5667) int32 bias（8/16/24/3）；[5667,5718) SH 低 8 位（8/16/24/3）。
- 权重按 (out_ch, in_ch, ky, kx) 行主序；fc 按 (out_ch, in_ch) 行主序；bias/SH 按
  conv1/conv2/conv3/fc 连续排列。
- 独立检查：check_rom.py 解析 .v 的 5718 条 rom 赋值，与 nn_params.json 逐字比较；
  ROM_CHECK_OK=1，地址 0..5717 连续无重复。

## 6. 逐位参考模型

- ref_cnn.py --check 用独立 patch-based numpy（int64 累加 -> 算术右移 -> 饱和 [-128,127]
  -> ReLU；fc 无 ReLU）重算官方 test 全部 189 窗。
- 与 quantize.py 的 int8 预测比较：一致 189/189，agreement=1.000000，REF_OK=1。
- 随机抽 20 窗打印了每层 in/out 的 min/max/mean（见 REF_OK.log）；其中空窗（class0）
  的 logits 为 [0,-1,-2] 这类接近零的整数，说明近零输入时模型默认 class0，属预期。
- 注意：ref 与 quantize 共用 nn_params.json，但卷积实现路径不同（patch einsum vs
  shifted-slice einsum），逐位一致说明整数语义在本机 Python 两种实现间自洽；这不等价于
  在 FPGA 上综合验证，RTL 仿真由 task-6/M3 负责。

## 7. 已知限制与风险

1. 官方固定 test 只有 class0/class1（无 class2），3 类指标全部来自额外的分组 CV；
   部署前不能用官方 test 的 0.9153 代表 3 类精度。
2. class2 只有 3 条会话、205 窗（占 11.9%），CV class2 recall 0.54，折间 0.19~0.76；
   M1 SEP3（ridge）跨会话 class2 recall 仅 0.2289。当前模型不能证明 class2 已可部署。
3. 5 折 CV 的窗口来自同一批会话，窗间 50 ms 步进重叠；虽然会话不跨折，但同一会话内
   窗口高度相关，有效样本量远小于 1729，置信区间比按独立同分布算出来的宽。
4. int8 在 189 窗 test 上“涨点”是 8 窗差异，不能作为量化优越性的证据；量化权重/SH 的
   选择只用了 train 校准集，没有 test 泄漏。
5. conv 输出出现 127 饱和；若上板后类别偏移，先查饱和与校准集代表性。
6. 训练没有做数据增强；class2 的采集条件（距离/角度/背景/相位）仍单一。
7. 未运行 Vivado/ModelSim（按任务约束），ROM 的语法/资源由 M3 综合验证。

## 8. 复现命令

    cd E:/workspace/FPGA_Comp/nn
    .venv/Scripts/python.exe train.py --seed 1234 --epochs 40
    .venv/Scripts/python.exe quantize.py
    .venv/Scripts/python.exe check_rom.py
    .venv/Scripts/python.exe ref_cnn.py --check
    .venv/Scripts/python.exe eval.py

## 9. 产出清单

- nn/model.py、nn/train.py、nn/quantize.py、nn/ref_cnn.py、nn/eval.py、nn/check_rom.py
- nn/out/model.pt、nn/out/train_log.json
- nn/out/nn_params.json、nn/out/nn_rom_data.v
- nn/out/quant_test_preds.npz、nn/out/eval_report.json
- nn/_evidence/TRAIN_OK.log、QUANT_OK.log、REF_OK.log
