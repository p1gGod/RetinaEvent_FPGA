FEATSTUDY_OK=1

# 特征与窗口方案（M2b / task-13）

日期：2026-10-29（Asia/Shanghai）
数据：nn/dataset_v3_w100.npz 对应的 20 条会话（class1 16 条、class2 3 条、class0 1 条板移噪声 + 各会话 none 窗）。
说明：首行 FEATSTUDY_OK=1 表示本任务判据（≥6 行跨会话配置表、recommended class2 LOO≥0.60、采集协议与 RTL 影响评估齐全）已满足；它不等于量产验收。本报告明确写出「当前仍不可部署」的证据与补录条件。

## 0. 结论摘要

- 现行 M2 CNN（4×30×50、100 ms）同口径 class2 留一会话 LOO 只有 0.4226（逐折 0.017/0.703/0.548），说明单帧纹理张量跨会话抓不住横向挥手。
- 手工运动学特征显著更强：C6（K=8/WIN=400 ms/10×6 网格+质心轨迹）class2 0.9000；C34（strict，K=8/WIN=600 ms）0.9037；非重叠 C37 0.9444（但每折仅 5/6/6 个 class2 窗）。
- 但 0.90 有很大一部分来自「离镜头更近」：class2 密度中位 3205 ev/frame，class1 为 1314；class2 的 sqrt(前景格数) 中位 32.5，class1 为 24.2；只用密度特征 C23 也有 0.8453。把 class2 限制到 class1 常见密度 1000~2400 后，C28/C36/C29/D8（分别是 C6/C34/C21/D1 的密度匹配版本）掉到 0.512/0.847/0.554/0.477（后三组每折 class2 只剩 4~9 个窗，方差很大）。
- 按 Lead 的无量纲化要求，新增 D/E 组。24 维无量纲组 D1 全量 class2 LOO=0.8635，但密度匹配后 D8=0.4769；只保留 5 个标量 E3=0.8761、密度匹配 E4=0.5926；只保留 2 个标量 E1=0.8770、密度匹配 E2=0.6343。E1/E3 的 3 分类 balanced acc 只有 0.570/0.730，因为 class0 大量 none 窗被误判；它们只能作为**辅助标量**，不能单独替代网格。
- 因此推荐契约是：**保持 4×30×50 输入不变，另加 2 个无量纲标量（摆幅/s、horizontality）进入 FC 前的小分支**；但这只是「值得做融合验证」的推荐，不是可部署结论。E2 密度匹配 0.634、每折仅 4/8/9 个 class2 窗，仍不能证明统一距离下的稳健性。若补录后 E2 仍低于 0.75，应回退到 2 类（无/有动作），横向挥手作为实验性类别。

## 1. 实验协议

- 数据来源：E:/workspace/FPGA_Comp/nn/dataset_v3_w100.npz 对应的原始 20 条会话；所有特征直接从原始事件重新切窗，不使用 npz 固定通道，避免「窗口/通道被数据生产脚本锁死」。
- 固定 test：retina-events-20261029-191905、retina-events-20261029-192720 两条 class1 会话；它们始终不进训练。
- class2 留一会话 LOO：每次留出 1 条 class2 会话（210102/211950/212036）全部窗，train=其余所有会话，test=被留会话全部窗 ∪ 固定 test。
- class2 recall 只在被留会话的真实 class2 窗上计算；balanced acc 对 test 中实际出现的类取平均；class0/class1 recall 为各折 test 上的均值。
- 窗口步长单位均为 ms。默认 stride=50（重叠，与 M2 数据一致）；nonoverlap 时 stride=WIN_MS（窗长内不重叠）。
- 分类器：class-balanced ridge，λ=1.0；训练集按类别频数倒数加权；默认水平镜像增强（网格/质心特征），dim 组没有定义镜像变换，等同无增强。
- 判据口径：class2 LOO recall 的「全量」和「密度匹配」分别报告；不把密度匹配后的低值藏起来。

## 2. 跨会话配置结果（≥6 行，逐折与均值）

class0/class1 recall 为各折 test 上该类召回的平均（不同折 test 会话不同，故不是同一批样本）；class2 recall 为留出会话 class2 窗召回的平均；balanced acc 为各折 3 类 balanced accuracy 的平均。Δ 为相对现行基线 0.229 的绝对提升，× 为倍数。

| 配置名 | K | WIN_MS | grid | aug | class0 recall | class1 recall | class2 recall | 3类 balanced acc | 相对 0.229 |
|---|---:|---:|---|---|---:|---:|---:|---:|---|
| C6_motion_full | 8 | 400 | 10×6 | mirror | 0.957 | 0.826 | 0.9000 | 0.8944 | +0.671 / 3.93× |
| C21_motion_nodens | 8 | 400 | 10×6 | mirror | 0.906 | 0.596 | 0.8718 | 0.7910 | +0.643 / 3.81× |
| C25_motion_full_nonoverlap | 8 | 400 | 10×6 | mirror | 1.000 | 0.889 | 0.8889 | 0.9259 | +0.660 / 3.88× |
| C34_motion_strict | 8 | 600 | 10×6 | mirror | 0.686 | 0.575 | 0.9037 | 0.7216 | +0.675 / 3.95× |
| C36_motion_strict_densband | 8 | 600 | 10×6 | mirror | 0.707 | 0.504 | 0.8472 | 0.6865 | +0.618 / 3.70× |
| C37_motion_strict_nonoverlap | 8 | 600 | 10×6 | mirror | 0.519 | 0.778 | 0.9444 | 0.7469 | +0.715 / 4.12× |
| C38_motion_strict_clean | 8 | 600 | 10×6 | mirror | 0.571 | 0.551 | 0.8900 | 0.6706 | +0.661 / 3.89× |
| C39_motion_strict_keephard | 8 | 600 | 10×6 | mirror | 0.669 | 0.587 | 0.9122 | 0.7227 | +0.683 / 3.98× |
| D1_dim24_only | 8 | 600 | 10×6 标量 | none | 0.807 | 0.767 | 0.8635 | 0.8129 | +0.635 / 3.77× |
| D8_dim24_densband | 8 | 600 | 10×6 标量 | none | 0.789 | 0.667 | 0.4769 | 0.6443 | +0.248 / 2.08× |
| E1_dim2_only | 8 | 600 | n/a | none | 0.123 | 0.709 | 0.8770 | 0.5696 | +0.648 / 3.83× |
| E2_dim2_densband | 8 | 600 | n/a | none | 0.161 | 0.682 | 0.6343 | 0.4923 | +0.405 / 2.77× |
| E3_dim5_only | 8 | 600 | n/a | none | 0.566 | 0.749 | 0.8761 | 0.7304 | +0.647 / 3.83× |
| E4_dim5_densband | 8 | 600 | n/a | none | 0.337 | 0.743 | 0.5926 | 0.5575 | +0.364 / 2.59× |
| M2_CNN_4x30x50 | 1 | 100 | 30×50 | none | 1.000 | 0.868 | 0.4226 | 0.7637 | +0.194 / 1.85× |

补充（不在上表内，避免表过宽）：
- C1（K=4/WIN=100/25×15 原始计数）class2=0.0719；C3（K=8/WIN=400/10×6 原始计数）0.6354；C9（归一化网格+运动）0.8119；C13（shape-only 运动，strict）0.7859；C31（grid_norm_motion strict）0.7746、密度匹配 C32=0.0417；C33（只归一化网格）0.6051。原始网格仍明显低；归一化运动网格提升到 0.77~0.81，但仍低于 C6/C34 的 0.90，说明 class2 的判别信息主要是「运动轨迹/方向」而不是单帧空间纹理。
- D2（24 维+密度）0.8711、D3（密度 only）0.8760、D4（24 维 w400）0.8786、D5（cells 尺度）0.8572、D6（K=12）0.8475、D7（w800）0.8342。

## 3. 推荐配置与逐折

推荐（建议进入融合验证的版本）：
- 保持 M2 的 CNN 输入 4×30×50（100 ms 帧、4 通道 ON_now/OFF_now/ON_prev/OFF_prev）不变。
- 额外 600 ms 标量分支：K=8 个 75 ms 时间片；每片算 x/y 质心 cx/cy（事件加权）和 ON 比例。
- 尺度 s = max(p95(x)-p05(x), p95(y)-p05(y))（窗内；s<1 时取 1）。
- 2 个标量特征：swing_x_over_s=(max cx-min cx)/s；horizontality=(max cx-min cx)/((max cx-min cx)+(max cy-min cy)+eps)。
- 不做空间平移归一化（Lead 已实测质心归一化更差，绝对位置/背景有信息）；标量分支不使用绝对坐标、绝对密度、绝对前景格数。
- 增强：CNN 用水平镜像；标量分支的镜像只翻转 dx/half_dx 符号，swing/horizontality 不变，可视为无增强。
- 训练：会话级 LOO（固定 test 不参与）；ridge 用 class-balanced 权重；若融合，CNN 与标量分支联合微调，至少 3 个随机种子。

为什么是 E1（2 标量）而不是 D1（24 维）或 E3（5 标量）：
- D1 全量 0.8635 看似好，但密度匹配后 0.4769，说明 24 维在「近距离」线索被移除后不稳。
- E3 全量 0.8761、匹配 0.5926；E1 全量 0.8770、匹配 0.6343。三者全量接近，但 E1 在匹配子集最高，且 RTL 只需 2 个标量。
- E1 的 3 分类 balanced acc 只有 0.5696（class0 recall 0.123），因此它**不能单独当分类器**；只能作为 CNN 的辅助输入。融合后 class0/class1 由 CNN 负责，class2 由标量补足，这一假设尚未实测，列为下一步。

逐折 class2 recall：

| 折（留出会话） | E1 全量 | E2 密度匹配 | D1 全量 | D8 密度匹配 | C34 strict | M2 CNN |
|---|---:|---:|---:|---:|---:|---:|
| 210102 | 0.849 | 0.500 | 0.868 | 0.500 | 0.887 | 0.017 |
| 211950 | 0.826 | 0.625 | 0.870 | 0.375 | 0.942 | 0.703 |
| 212036 | 0.956 | 0.778 | 0.853 | 0.556 | 0.882 | 0.548 |
| 均值±std | 0.877±0.057 | 0.634±0.114 | 0.864±0.008 | 0.477±0.076 | 0.904±0.027 | 0.423±0.294 |

class1 同口径对照（D1，16 折 LFO）：0.6516±0.1193（逐折 0.333~0.846）。这说明手工无量纲特征对 class1 也不强，不能替代 CNN；E1 的 class1 recall 均值 0.709 也低于 CNN 的 0.868。

## 4. 密度消融与距离协变量

### 4.1 三档消融（K=8/WIN=400 或 600，class2 LOO 均值）

| 档 | 配置 | class2 recall | 3类 balanced acc |
|---|---|---:|---:|
| 全特征 | C6 motion full w400 | 0.9000 | 0.8944 |
| 去全部密度类特征 | C21 motion nodens w400 | 0.8718 | 0.7910 |
| 只用密度类特征 | C23 density-only w400 | 0.8453 | 0.8638 |
| 无量纲全量 | D1 dim24 w600 | 0.8635 | 0.8129 |
| 无量纲+密度 | D2 dim24+density w600 | 0.8711 | 0.8964 |
| 只用密度（dim 组） | D3 density-only w600 | 0.8760 | 0.8130 |

结论：密度单独就有 0.845~0.876，和全特征几乎一样高；去掉密度只掉 0.03，说明密度不是唯一主因，但它是很强的「距离伪线索」。

### 4.2 距离/尺度协变量（C34 活跃窗，w600 重叠）

| 量 | class1（n=631）q25 / 中位 / q75 | class2（n=190）q25 / 中位 / q75 |
|---|---|---|
| 密度 ev/frame | 860 / 1314 / 1793 | 2785 / 3205 / 4000 |
| bbox_w / 画面宽 | 0.845 / 0.928 / 0.998 | 0.968 / 0.998 / 0.998 |
| bbox_h / 画面高 | 0.983 / 0.996 / 0.996 | 0.996 / 0.996 / 0.996 |
| sqrt(前景 8px 格数) | 20.53 / 24.17 / 27.70 | 30.25 / 32.50 / 34.90 |
| swing_x / s | 0.263 / 0.418 / 1.068 | 0.543 / 0.619 / 0.686 |
| swing_y / s | 0.330 / 0.537 / 0.815 | 0.125 / 0.208 / 0.311 |
| bbox 宽高比 | 1.083 / 1.354 / 1.742 | 1.096 / 1.201 / 1.467 |
| horizontality | 0.396 / 0.491 / 0.586 | 0.673 / 0.747 / 0.808 |

读法：
- class2 密度中位是 class1 的约 2.4 倍，bbox 宽几乎贴满画面（0.998），sqrt 前景格数中位 32.5 vs 24.2；三类独立证据都指向「class2 录得更近/更贴边」。
- class2 只有 21/190=11.1% 的窗落在 1000~2400 ev/frame 的 class1 常见密度带；用这个带做匹配后，每折 class2 只剩 4/8/9 个窗，统计功效很低。
- 无量纲 swing_x/s 并没有出现 Lead 预期的「class1 0.2~0.5、class2 2~3」：class1 中位 0.418（q75 1.068），class2 中位 0.619（q75 0.686），反而有较大重叠；因为 p95-p05 尺度被背景/满屏事件污染，不是干净的手部尺寸。horizontality 的分离更好（0.491 vs 0.747），但仍有重叠。这解释了为什么 D1 全量 0.864、匹配后只剩 0.477。

### 4.3 密度匹配后的结果

| 配置（密度匹配版） | 同族全量版本 | class2 LOO（1000~2400） | 匹配后每折 n |
|---|---:|---:|---|
| C28 full densband（C6 全量 0.9000） | 0.9000 | 0.5119 | 17（w400） |
| C36 strict densband（C34 全量 0.9037） | 0.9037 | 0.8472 | 4,8,9（w600） |
| C29 nodens densband（C21 全量 0.8718） | 0.8718 | 0.5536 | 4,8,9 |
| D8 dim24 densband（D1 全量 0.8635） | 0.8635 | 0.4769 | 4,8,9 |
| E2 2 标量（E1 全量 0.8770） | 0.8770 | 0.6343 | 4,8,9 |
| E4 5 标量（E3 全量 0.8761） | 0.8761 | 0.5926 | 4,8,9 |
| D9 dim24+密度（D2 全量 0.8711） | 0.8711 | 0.8380 | 4,8,9 |

结论：加上密度后匹配集回到 0.838，说明匹配集里的 class2 仍然主要靠密度/距离被识别；E1/E2 是唯一在匹配集 ≥0.6 的无密度组，但 0.634 的余量很小，且每折只有 4/8/9 个窗。不能据此写「统一距离下已可部署」。

## 5. 采集协议（补录必须按这个执行）

当前数据的两类都太近：class2 bbox_w 中位 0.998，class1 0.928；class2 密度中位 3205，class1 1314。要证明「挥手 vs 开合」可分，必须把距离/占画面比例变成受控变量。

| 项目 | 要求 | 当前数据 |
|---|---|---|
| 手部 bbox 宽占画面 | 0.30~0.55（目标 0.40），同一批数据内不超过 ±0.08 | class1 0.928、class2 0.998（贴边） |
| 每帧事件密度 | 800~2000 ev/frame（400×240），两类都落在此带 | class1 中位 1314、class2 3205 |
| 横向摆幅 | ≥120 px（画面宽 30%），目标 150~250 px | 已有 159~268 px，但伴随近距 |
| 摆动频率 | 0.8~2.5 Hz，每段至少 3 个完整周期 | 1.4~2.2 Hz，基本满足 |
| 单段时长/段数 | 每段 5 s；每个条件 ≥3 段；每类 ≥3 条独立会话（最终 ≥6~9 条） | class2 3 条会话/205 窗；class1 16 条 |
| 距离/角度/手别/背景 | 3 个距离（bbox 0.30/0.42/0.55）× 左/右手 × 2 种背景；±30° yaw 各至少 1 条 | 未覆盖，当前基本是同一近距机位 |
| 板移硬负样本 | ≥3 段独立位移，每段 5 s；保留 none 窗 | 1 条 210307/95 窗 |
| 验收 | 每段录完立即用本报告脚本算 bbox_w/密度；不达标重录，不靠事后挑选 | — |

补录量建议：class2 至少 3 条独立会话 × 3 段 × 5 s（45 s 有效活动），优先覆盖 3 个距离；若只补同机位 5 s×3 段，只能扩窗数，不能解决距离混淆，不能作为验收依据。

## 6. RTL 影响评估

当前 M2 契约（P1 CNN）冻结为：conv1 4×30×50→8×14×24、conv2→16×6×11、conv3→24×2×5、fc 240→3；ROM 5718 字；无 BN/dropout。推荐方案不改变该 CNN，只加 2 个标量分支。

| 项 | 2 标量（E1，推荐） | 5 标量（E3，备选） |
|---|---|---|
| 输入通道/张量 | 4×30×50 不变 | 4×30×50 不变 |
| 标量窗 | 600 ms / K=8×75 ms | 同左 |
| 尺度/直方图缓存 | x 400 bin×16 bit + y 240 bin×16 bit = 10,240 bit，约 1 个 BRAM18 | 同左 |
| 每片累加器 | 8 片 ×（sum_x 21b + sum_y 21b + count 13b + on_count 13b）≈ 544 FF | 同左 |
| 除法 | 1 个共享 24/13 bit 顺序除法器，每窗 8 次，约 160 cycle | 同左 |
| FC 增量 | +2 输入×3 类=6 权重；ROM 5718→5724 字（13 bit 地址不变） | +5×3=15 权重；ROM 5733 字 |
| 估算 LUT/BRAM/DSP | +0.6~1.2k LUT，+1 BRAM18，+0~1 DSP | 与 2 标量基本相同（+~100 LUT） |
| 延迟 | 600 ms 窗 + 3 连判（600 ms 步长）= 1.8 s；若沿用 400 ms 窗+3 连判=1.2 s | 同左 |
| 不应期 | 至少 1 个窗（0.6 s），避免同一次挥手重复触发 | 同左 |

说明：若 RTL 用 min/max 代替 p95/p05，可省掉直方图（只留 400/240 个比较器），但对单点噪声敏感；建议保留直方图或加 2 帧去噪，代价仍是 1 个 BRAM。24 维 D1 需要 +72 个 FC 权重和更多除法/累加，且匹配后只有 0.477，不推荐。

## 7. 风险与未完成

1. class2 只有 3 条独立会话，每折 53~69 个重叠窗、非重叠仅 5~9 个；0.90 的均值方差很大，210102 在 CNN 折上只有 0.017。3 条会话不足以估计会话级方差。
2. 距离混淆未解决：class2 密度 2.4×、bbox 贴边、sqrt 前景格数 32.5 vs 24.2；匹配后只剩 4/8/9 个 class2 窗，E1 0.634 的 95% 区间很宽。
3. 24 维无量纲组匹配后 0.477，说明「去掉绝对密度/位置」本身不够；p95-p05 尺度被背景污染，swing/s 分布与预期不符。
4. 2 标量 E1 的 3 分类 balanced acc 仅 0.570（class0 recall 0.123），不能单独用；与 CNN 的融合尚未训练/验证，本报告不声称融合有效。
5. class1 LFO 只有 0.652（D1），手工特征对开合也弱；最终仍应保留 CNN 主分支。
6. 采集协议是建议值，尚未用新数据验证；补录后必须重跑本报告脚本与 SEP3 式会话留出。
7. RTL 估算未综合：直方图/除法器的 LUT/时序需在 M3 用实际综合报告确认；1.8 s 延迟对交互体验是否可接受需产品确认。

## 8. 复现命令

以下命令均在 E:/workspace/FPGA_Comp/nn 下执行，Python 用 trainingData/.venv/Scripts/python.exe（numpy 足够；CNN 对照用 nn/.venv 的 torch）：

    python probe_feat_study.py --mode table --configs C6_motion_K8_w400,C21_motion_nodens_K8_w400,C25_motion_full_K8_w400_nonoverlap
    python probe_feat_study.py --mode table --configs C34_motion_strict_K8_w600,C36_motion_strict_K8_w600_densband,C37_motion_strict_K8_w600_nonoverlap,C38_motion_strict_K8_w600_clean,C39_motion_strict_K8_w600_keephard
    python probe_feat_study.py --mode table --configs D1_dim_only_K8_w600_bbox,D2_dim_density_K8_w600_bbox,D3_density_only_K8_w600,D4_dim_only_K8_w400_bbox,D5_dim_only_K8_w600_cells,D6_dim_only_K12_w600_bbox,D7_dim_only_K8_w800_bbox,D8_dim_only_K8_w600_densband,D9_dim_density_K8_w600_densband
    python probe_feat_study.py --mode table --configs E1_dim_two_scalars_K8_w600,E2_dim_two_scalars_K8_w600_densband,E3_dim_minimal_K8_w600,E4_dim_minimal_K8_w600_densband
    python probe_feat_study.py --mode lfo --config D1_dim_only_K8_w600_bbox
    python probe_feat_study.py --mode dimstats --config D1_dim_only_K8_w600_bbox
    python probe_cnn_lfo.py --epochs 40

## 9. 改动清单

- 新建 E:/workspace/FPGA_Comp/nn/probe_feat_study.py：配置生成、dim_features、evaluated_config/evaluated_lfo、dimensionless_stats、table/lfo/cov/dimstats 模式。
- 新建 E:/workspace/FPGA_Comp/nn/probe_cnn_lfo.py：M2 CNN 同口径 3 折 class2 LOO 对照。
- 新建 E:/workspace/FPGA_Comp/nn/REPORT_特征与窗口方案.md（本文件）。
- 新建 E:/workspace/FPGA_Comp/nn/_evidence/FEATSTUDY_OK.log（判据、命令、关键输出、EXIT=0）。
- 未改 nn/out/**、dataset_v3_w*.npz、retina_event/**、host/app/**、docs/**；未跑 Vivado/综合/烧录；未做 git 写操作。
