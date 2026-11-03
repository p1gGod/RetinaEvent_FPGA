TRAIN_V5_OK=1

# M2d 训练 v5：挥手不再误判为手部开合（task-29）

**结论**：推荐 **A 二分类折叠**，部署件（int8，全部 1729 窗训练）离线决策链回放同时满足 挥手 pulse=0（基线 6）、class1 段召回 27/27、静默误触 0.000 次/分、板移 0。

## 1. 判据（部署件 = 全部数据训练 + int8 权重回放，与 task-28 基线同口径）

| 判据 | 目标 | A 二分类折叠 | B 三分类 | 说明 |
|---|---|---|---|---|
| INT8_MATCH | ≥0.99 | 0.991324 | 0.938693 | 全部 1729 窗 float/int8 argmax 一致率 |
| WAVE_PULSES | ≤1 | 0 | 0 | 3 条挥手会话回放总 pulse（基线 6） |
| CLASS1_RECALL_SEGS | ≥26/27 | 27/27 | 27/27 | class1 动作段检出 |
| STATIC_FP_PER_MIN | ≤0.5 | 0.000 | 0.000 | 非 210307 会话 y=0 窗 pulse / 静默分钟 |
| 板移 210307 | 0 | 0 | 0 | 板移噪声会话 |
| 回放配置 | 线上 8/3 | 8/3 | 8/3 | MARGIN_MIN / N_CONSEC |

## 2. 留一会话交叉验证（honest / 该会话从未参与训练；每折单独量化后的 int8 权重回放，20 折 LOO）

| 指标 | A 二分类折叠 | B 三分类 |
|---|---|---|
| 窗口级 accuracy | 0.8652 | 0.8352 |
| class1 窗口 recall | 0.8659 | 0.8459 |
| 挥手窗判成 class2 比例 | — | 0.4244 |
| 挥手 pulse（各自配置） | 0 | 0 |
| class1 段召回 | 19/27 | 12/27 |
| 静默误触 | 0.000 次/分 | 0.000 次/分 |

## 3. 训练与量化

- 数据：E:\workspace\FPGA_Comp\nn\dataset_v4_w100.npz，1729 窗 / 20 会话，y=0:823 / y=1:701 / y=2:205；win=100ms stride=50ms。
- 网络：nn/model.py P1CNN（conv1 8x14x24 / conv2 16x6x11 / conv3 24x2x5 / fc 240->N），无 BN/dropout。
- 训练：Adam lr=0.002 wd=1.0e-04，CosineAnnealing，40 epoch，batch=128，seed=1234；class_weight=sqrt(N/(C*n)) clip[0.5,3.0]。
- A 路线：y=2 全部重标为 0，并给挥手窗样本权重 3.0（5-fold session-grouped 选出）。
- B 路线：保留三分类，class2=wave（205 窗）。
- 量化：nn/quantize.py per-output-channel int8 + 校准集=全部训练窗；int8 前向另用 nn/ref_cnn.py 逐位复算。
- 部署件都是在**全部窗口**上训练（与 v4 一致），因此第 1 节是 in-sample 回放；第 2 节才是泛化估计。

## 4. 决策链回放细节

- 100 ms 决策步（start_offset=2），nn_decide：hit=(argmax==class1)&&margin>=MARGIN_MIN，连续 N_CONSEC 次出 pulse，pulse 后 1.5 s refractory。
- 2 分类 margin=|logit0-logit1|；3 分类 margin=logit1-max(logit0,logit2)（命中类固定为 1，与二分类口径一致）。
- A：回放配置 8/3，pulse 总数 46（class1 46 + 挥手 0 + 静默 0 + 板移 0），class1 重复段 18，VALID 上升沿==pulse：True。
- B：回放配置 8/3，pulse 总数 40（class1 40 + 挥手 0 + 静默 0 + 板移 0），class1 重复段 13，VALID 上升沿==pulse：True。

## 5. 推荐与局限

- A 与 B 都用同一份数据、同一网络、同一量化/回放代码；部署件都在全部窗口上训练（与 v4 同口径），第 2 节是 LOO 泛化列。
- 推荐 A 二分类折叠：挥手 pulse 0（基线 6），class1 27/27，静默 0.000 次/分，INT8_MATCH 0.991324，配置 8/3（=线上配置，无需改 RTL 常量）。
- B 三分类 未选：挥手 0、class1 27/27、静默 0.000 次/分、INT8 0.938693（四判据通过=否）。
- A 二分类折叠 LOO（留一会话）回放：挥手 0、class1 19/27、静默 0.000 次/分；class1 窗口 recall 0.8659。
- B 三分类 LOO（留一会话）回放：挥手 0、class1 12/27、静默 0.000 次/分；class1 窗口 recall 0.8459。
- 局限：全部决策窗只有 1.415 min，1 个事件=0.71 次/分，所以 0 事件在 95% 置信下仍只能约束到约 2.1 次/分；挥手只有 3 条会话/205 个 y=2 决策窗，LOO 列才是对『新录一段挥手』的诚实估计。
- 部署建议：A 二分类折叠 的 ROM/参数见产物；上板后用新录的挥手会话再回放一次，确认 LOO 列趋势。

## 6. 产物与复现

- A：nn_params_2cls.json（5476 字 ROM，json 75347 B，sha256 1903bc994b3e…）
- B：nn_params_3cls.json（5718 字 ROM，json 75489 B，sha256 ac373b0da32a…）
- dataset_v5：dataset_v5_w100.npz（1 MB，新增 y_fold / wave_mask / loo_fold / label_for_recommended_route）
- 报告：REPORT_训练v5.md；证据：TRAIN_V5.log

复现命令（cwd=E:/workspace/FPGA_Comp）：

```
E:/workspace/FPGA_Comp/nn/.venv/Scripts/python.exe nn/train_v5.py --route all
E:/workspace/FPGA_Comp/nn/.venv/Scripts/python.exe nn/check_rom_2cls.py --json E:\workspace\FPGA_Comp\nn\out_v5\nn_params_2cls.json --rom E:\workspace\FPGA_Comp\nn\out_v5\nn_rom_data_2cls.v --evid E:\workspace\FPGA_Comp\nn\out_v5\ROM2_CHECK_v5.log
```
