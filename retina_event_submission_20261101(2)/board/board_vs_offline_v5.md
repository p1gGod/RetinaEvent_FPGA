# 板上实测 vs 离线 int8 全链对拍

- 会话：records\20261030-212214_v5probe
- 权重：nn\out_v5\nn_params_2cls.json
- 权重 sha256：1903bc994b3e2a6ffe5782e0691aebf27f04a9c00ab14c2da86c8cc3815be583（前 12 位 1903bc994b3e）
- 管线：v5（intwin 整数网格 + int8 前向 + 决策链；未使用 torch/float 前向）
- 离线窗口：8641（g0=37 ms，决策点 4320，offset=2）

## 逐段对照

| zone | group | board | offline | Δ | confident matched | phase-drift matched | isolated board | isolated offline | |dt| p50 ms | |dt| p90 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| empty_desk | empty | 0 | 0 | +0 | 0 | 0 | 0 | 0 | - | - |
| absent | absent | 1 | 1 | +0 | 1 | 0 | 0 | 0 | 55.0 | 55.0 |
| openclose | open | 61 | 60 | +1 | 53 | 4 | 4 | 3 | 71.0 | 317.4 |
| static_a | static | 0 | 1 | -1 | 0 | 0 | 0 | 1 | - | - |
| reposition | swap | 8 | 7 | +1 | 7 | 0 | 1 | 0 | 61.0 | 442.8 |
| static_b | static | 0 | 0 | +0 | 0 | 0 | 0 | 0 | - | - |
| wave | wave | 47 | 46 | +1 | 23 | 23 | 1 | 0 | 61.0 | 358.6 |
| end | end | 1 | 1 | +0 | 1 | 0 | 0 | 0 | 434.0 | 434.0 |
| **合计** | - | **118** | **116** | **+2** | **85** | **27** | **6** | **4** | - | - |

## 三类差异

### 1. 次数差

- openclose：board 61 vs offline 60，Δ=+1
- static_a：board 0 vs offline 1，Δ=-1
- reposition：board 8 vs offline 7，Δ=+1
- wave：board 47 vs offline 46，Δ=+1

### 2. 时间差（配对后 |Δt|）

- confident 配对：板侧 pulse 时间与离线 pulse center 的 |Δt|；阈值 600 ms，gap penalty 300 ms。
- absent：|Δt| p50=55.0 ms, p90=55.0 ms
- openclose：|Δt| p50=71.0 ms, p90=317.4 ms
- reposition：|Δt| p50=61.0 ms, p90=442.8 ms
- wave：|Δt| p50=61.0 ms, p90=358.6 ms
- end：|Δt| p50=434.0 ms, p90=434.0 ms
- phase-drift 配对（>600 ms 且 <=1500 ms，单独统计，不计入上面的 p50/p90）：共 27 对；board pulse 是触发事件时刻，离线是窗口中心，相位漂移会累积。

### 3. 只在一侧出现的孤立事件

- openclose：board-only [157233, 193045, 201745, 245322]；offline-only [162487, 195987, 209087]
- static_a：board-only []；offline-only [246187]
- reposition：board-only [294824]；offline-only []
- wave：board-only [382952]；offline-only []

## 时间对齐

- 板上事件 tMs 与 frames.csv t_arrive_ms 同 epoch；frame_offset=1793365856477.0 ms，最近帧残差 median=9.0 ms（p10=8.0, p90=9.0）。
- 对齐只用时间（frame_idx 是段内局部序号，不用于对齐）；应用校正 -9.0 ms。
- 板上事件：文件记录 121 条，保留 120 条（class>=1 且 valid），录制内 118 条；离线 pulse 116。

## 权重与命令

- PARAMS=nn\out_v5\nn_params_2cls.json
- PARAMS_SHA12=1903bc994b3e
- 复现：见 README.md；本次脚本会打印同样的一行 PARAMS_SHA12。

