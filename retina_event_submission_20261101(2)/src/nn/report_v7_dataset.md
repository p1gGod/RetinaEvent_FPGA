V7_DATA_OK=1

# v7 数据集构建报告（M2h，task-39）

新 session `records/20261030-222201_v7hands`（256.16 s / 6,831 帧 / 7,913,893 事件 / 0 丢帧）
已按 `temp_test/v7_zones.json` 权威分区转换为 100 ms 窗（50 ms 步）数据集，并做左右镜像增强。
产出：`nn/v7/windows_v7.npz`（14,447 行，10.5 MB）、`nn/v7/build_v7.py`、`nn/v7/check_v7.py`、
`nn/out_v7/build_summary.json`、`nn/_evidence/V7_DATA_OK.log`。本卡只做数据，不训练。

## 1. 分区与前缀口径

session 起帧 `t_board_ms = 2,340,799`，事件相对时间 `rel = frame_t_ms - board0`（0..256,088 ms），
窗 `k` 起点 `g0 + 50k`（`g0=0`）、中心 `+50 ms`；zone 归属按**窗中心**判定，
与 exclude 段**相交**的窗也丢弃（双保险）。共 5,120 窗，保留 4,589 窗（view A 3,279 + view B 1,310），
gap/transit 丢弃 331 窗，两个 exclude 段丢弃 200 窗。

| zone | view | label→y | t0–t1 (s) | 中心落段 | 保留 | 丢弃 | 保留行(含镜像) |
|---|---|---|---|---|---|---|---|
| empty_A | A | empty→0 | 0–15 | 299 | 299 | 0 | 598 |
| open_L | A | openclose_left→1 | 16–45 | 580 | 580 | 0 | 1160 |
| wave_L | A | wave_left→2 | 46–77 | 620 | 620 | 0 | 1240 |
| gap_away | A | away→0 | 78–82 | 80 | 80 | 0 | 160 |
| open_L_near | A | openclose_left→1 | 83–105 | 440 | 440 | 0 | 880 |
| open_L_far | A | openclose_left→1 | 107–134 | 540 | 540 | 0 | 1080 |
| wave_L_far | A | wave_left→2 | 136–156 | 400 | 400 | 0 | 800 |
| EXCLUDE_rotate_to_B | X | exclude→255 | 157–162.5 | 110 | 0 | 110 | 0 |
| typing | B | hardneg→0 | 163–185 | 440 | 440 | 0 | 440 |
| cup_paper | B | hardneg→0 | 186–209.5 | 470 | 470 | 0 | 470 |
| still_B | B | static→0 | 214–234 | 400 | 400 | 0 | 400 |
| EXCLUDE_rotate_back | X | exclude→255 | 235–239.5 | 90 | 0 | 90 | 0 |
| empty_A2 | A | empty→0 | 240–256 | 320 | 320 | 0 | 640 |

分区清单逐字段（name/t0/t1/label/view）与 `v7_zones.json` 一致（代码直接读取该 JSON，不改文件）；
两个转动段窗数为 0，且没有窗区间与 exclude 段相交（`check_v7.py` 断言）。

## 2. 标签与总行数

- v7 原窗（aug=0，不含对照）：y0=2,009 / y1=1,560 / y2=1,020（合计 4,589）。
- 镜像副本（aug=1）：y0=699 / y1=1,560 / y2=1,020（合计 3,279）。
- 7 min 对照（role=control_7min）：y0=2,359 / y1=2,360 / y2=1,860（合计 6,579；y=255 的 2,062 窗已丢弃）。
- npz 总行数 14,447；y 总计数 0/1/2 = 5,067 / 5,480 / 3,900。
- 增强前左手：开合 1,560 窗、挥手 1,020 窗（右手 0）；增强后右手副本：开合 1,560、挥手 1,020；
  增强后总：开合 3,120、挥手 2,040（不含 7 min 对照）。

## 3. 输入表征（c5 口径）

窗 100 ms / 步 50 ms，网格 30×50（GRID_SHIFT=3，x 0..399、y 0..239），饱和 127。
两个网格数组同时保留：

- `X_raw`：4 通道原始计数 `[ON_now, OFF_now, ON_prev, OFF_prev]`（v4/v6 c1 口径，对照用）。
- `X`：4 通道**平移归一化**网格（c5 口径）：`offx=round(pcx-200)`、`offy=round(pcy-120)`，
  事件坐标 `x-offx, y-offy` 后取网格；**只用上一窗**质心（pcx/pcy），当前窗统计量不参与归一化；
  通道 2/3 是上一窗平移网格的 ON/OFF。板上只需减法 + clamp/移位，无乘法器。
- `g`：17 路全局量，顺序固定为
  `n, on, off, cx, cy, sx, sy, pcx, pcy, dx, dy, speed, dsx, dsy, bal, frames, prev_n`
  （raw px / 计数；空窗 cx=200、cy=120、sx=sy=0）。7 min 对照窗的 `frames` 沿用 v6 值，v7 新 session 该列填 0（未使用）。

## 4. 镜像增强（view A only）

对 view A 的每个窗追加一份副本（`aug=1`），view B 不镜像：

- 网格：`X[:, :, ::-1]`（等价 raw 坐标 `x → 399-x`，即尾轴 `j → 49-j`；通道序不变，ON/OFF 与时间先后不交换）。
- 全局量：`cx → 399-cx`、`pcx → 399-pcx`、`dx → -dx`、`dsx → -dsx`；
  `cy/pcy/dy/sy/sx/n/on/off/bal/speed/frames/prev_n` 不变（水平镜像不改变这些量）。
- 镜像行的 `y / zone / view / t_ms / fold` 与原窗相同，`hand` 在手势窗由 left 改 right；
  `hint` 不变（primary）。
- 注意：`X` 是**先平移归一化再整幅翻转**。它严格等价于最终网格的 `j→49-j`；
  若改写成"先把原始事件 x→399-x 再按镜像后的上一窗质心平移"，两者平移量相差 ≤1 像素（≤1 格），
  属于增强的亚像素差异，不影响标签与通道语义。

## 5. view B 与 7 min 对照的用法（重要）

- `view="B"`（typing / cup_paper / still_B）：y=0 硬负样本，`aug=0`、`role="v7_hardneg"`、`hint="hardneg"`。
  **不得当作 view A 训练样本**：训练时必须保留 view 字段，view B 只进负样本/难负样本桶；
  其手势动作语义与部署视角不同，且摄像头位置未共视。
- `view="A7"`（7 min session `20261030-212214_v5probe`）：`role="control_7min"`，只作负样本/对照。
  其阳性标签有 2–6.5 s 边界偏移（v6 已坐实），**不建议当正样本训练**；推荐只用 `hint="control_neg"`
  （y=0，2,359 窗）做静态/空桌面对照。`y=255` 的 exclude 窗已从 npz 删除。

## 6. fold 定义

每个 zone 内按时间中点切前后半：`fold = 0 if center < (t0+t1)/2 else 1`；镜像随原窗同 fold。
v7 原窗 fold 0/1 = 2,294/2,295（均衡）；对照按 v6 原 zone 中点切。训练时按 fold 做留出，
同一时间点的镜像副本不会跨折泄漏。

## 7. 自检与可复现性

- 同一命令连跑两次（共享 raw 事件缓存）：`CONTENT_HASH=a65a66d0007760572b6f90f04b95e6a914fb9a37a964f486da23a215c1b72837`
  两次完全一致（hash 覆盖 X_raw/X/g/y/zone/view/session/t_ms/center_ms/fold/aug/hand/role/hint/win_idx）。
- 抽 20 窗用源事件复算：`n` 全部精确相等，质心误差最大 0.375 / 0.25 网格单位（判据 ≤1）。
- `nn/v7/check_v7.py`：`V7_CHECK_OK=1`（50 项 PASS，含分区一致、exclude 无窗、view B 未镜像、
  镜像数组逐位等于 flip、cx/dx 符号、计数与 hash 一致）。
- npz 字段：`X_raw, X, g, y, zone, view, session, t_ms, center_ms, fold, aug, hand, role, hint, win_idx,
  win_ms, stride_ms, grid_shift, grid_w, grid_h, channels, global_names, zones_json, label_map_json`。
  `zone/view/session/hand/role/hint` 为定长 unicode 数组；`y` uint8（0/1/2，无 255）；`t_ms` 为窗起点
  （相对各自 session 的 board0，跨 session 用 `session` 区分）。

## 8. 复现命令

```bash
cd /e/workspace/FPGA_Comp
# 构建（首次解析 7,913,893 事件约 8–15 s；之后走 temp_test/v7/raw_v7hands.npz 缓存，约 3.5 s）
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/build_v7.py
# 自检
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/check_v7.py
```

## 9. 给 task-40（v7 训练 + QAT）的建议

1. 训练主集：`role in {"v7_primary"} & y in {0,1,2}`，含 `aug=0/1`（3,279 + 3,279 行）；
   fold 留出按 `fold` 切。
2. 难负样本：`view=="B"`（1,310 行，aug=0）只当负样本，加样本权重而非当正类；
   若担心视角偏移，先用它做独立误触评估，再决定是否混训。
3. 对照：`role=="control_7min" & y==0`（2,359 行）可当额外负样本；7 min 的 y=1/2 不要当正样本。
4. 类别极不均衡（v7 主集 0:2,009 / 1:1,560 / 2:1,020），沿用 sqrt 平衡或按窗加权；
   左手/右手镜像各半，可另测"仅左手"与"左右合并"两种训练口径的泛化差。
5. int8 现状：c5 在旧数据上 float-vs-int8 约 0.93–0.96，未过 0.99；v7 训练卡需按 lead 计划做逐输出通道 scale + QAT，
   并给出"训练侧量化公式 == RTL 整数公式"的黄金契约（本数据集不涉及量化）。
