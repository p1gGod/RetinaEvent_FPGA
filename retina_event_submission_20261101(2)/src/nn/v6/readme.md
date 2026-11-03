# nn/v6 —— v6 输入表征离线实验（可复跑）

## 目录
- `_common.py`：numpy-only 公共件，含窗/zone 常量、决策链状态机 replay_pulses、脉冲指标 pulse_metrics、window_hit_table、evaluate_predictions、全局量 global_features、torch 模型 train/predict/build_model。
- `convert_records.py`：records/20261030-212214_v5probe 的事件 CSV → 100ms 窗 npz（GRID_SHIFT=3，30x50，4 通道 [ON_now,OFF_now,ON_prev,OFF_prev] + 平移网格 + 17 全局量 + zone 标注）。需 pandas（见「依赖」；DSH 捆绑 python 已带 pandas，nn/.venv 默认没有）。
- `infer_v5.py`：用 nn/out_v5/nn_params_2cls.json 的 int8 权重逐窗推理（复用 nn/ref_cnn.py，禁 torch），输出 nn/out_v6/v5_probe.json。
- `exp_representations.py`：8 候选对比实验（c0/c1/c2/c3/c4/c5/c6/c7），2 折时间前后半、会话无泄漏；输出 nn/out_v6/representation_results.json + representation_table.csv。
- `int8_generic.py`：通用 int8 量化/前向（复用 nn/quantize.py 的位精确实现），支持 cnn/cnn_glob/scalar。

## 复跑
```bash
cd /e/workspace/FPGA_Comp
PYTHONUTF8=1 "C:/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe" nn/v6/convert_records.py
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v6/infer_v5.py
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v6/exp_representations.py            # 全候选，约 2 分钟
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v6/exp_representations.py --only c5_shift_glob
PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v6/exp_representations.py --only c4_8ch_400ms --calib 4000 --headroom 1.15  # 标定消融
```

## 依赖
- 仅 `convert_records.py` 需要 pandas（`pandas>=2.0`，见 `nn/v6/requirements.txt`）。这个依赖只服务于 v6 历史实验的数据导入，**v7/v7b 部署管线不需要 pandas**。
- 在 nn/.venv 中如未安装：`python -m pip install -r nn/v6/requirements.txt`。缺 pandas 时脚本会打印指引并以退出码 3 结束，不会静默降级或产生半成品输出。

## 注意
- 窗口/zone 常量以 `_common.py` 为唯一真源（GRID_SHIFT=3、WIN_MS=100、STRIDE_MS=50、DECISION_STEP=2、ONLINE_MARGIN_MIN=8、ONLINE_N_CONSEC=3）。
- 决策链与 probe_decide_sweep.py 逐位一致：每 100ms 决策、连续 3 次同 c 出 pulse、1.5s 不应期、1.0s 无活动清零。
- int8 结果由本目录 `int8_generic.py` 产出，不是 nn/quantize.py CLI 的产物；c1 的 py_match=1.0000 用于证明两者逐位一致。
- 输入文件只读，不改 nn/ 既有脚本与 nn/out_v5、nn/out_v4。
