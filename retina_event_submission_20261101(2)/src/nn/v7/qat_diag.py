# -*- coding: utf-8 -*-
"""int8 一致率瓶颈诊断：翻转窗的 float margin 分布、权重/激活量化各占多少。"""
import sys, time, copy
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for p in ("nn/v7", "nn/v6", "nn"):
    sys.path.insert(0, str(ROOT / p))
import v6_common as C, v7_eval as E, v7_feats as F, quant_v7 as QV, train_v7 as T
import torch

d = E.load(ROOT / "nn/v7/windows_v7.npz")
m = E.masks(d)
x_all = d["X"].astype(np.float32)
feats, names = F.build("fmin_n_rel", d["g"])
torch, nn = C._torch()
torch.set_num_threads(4)

rows_tr, yb_tr = T.rows_train_full(d, m, fold=0)
sw = T.sample_weights(rows_tr, m, 3.0)
model = T.train_binary(x_all[rows_tr], feats[rows_tr], yb_tr, sw, seed=1234, epochs=30)
model.v7_feat_names = list(names)
rows_te = np.where((m["fold"] == 1) & (m["primary"] | m["hardneg"]))[0]
params = QV.quantize_v7(model, x_all[rows_tr], feats[rows_tr].astype(np.int8), headroom=1.0)
li, _ = QV.forward_int8_v7(x_all[rows_te], feats[rows_te].astype(np.int8), params)
lf = T.predict_logits(model, x_all[rows_te], feats[rows_te])
pf, pi = lf.argmax(1), li.argmax(1)
yv = d["y"][rows_te]
df = lf[:, 1] - lf[:, 0]
di = li[:, 1].astype(np.int64) - li[:, 0].astype(np.int64)
sy = params["logit_scale_shared"]
print("s_y", sy, "float logit range", float(lf.min()), float(lf.max()),
      "int8 range", int(li.min()), int(li.max()), flush=True)
print("agree", round(float((pf == pi).mean()), 4), "ties_int8", int((li[:, 0] == li[:, 1]).sum()), flush=True)
print("bins |float margin|/s_y : n / agree / float_pred1_ratio", flush=True)
r = np.abs(df) / sy
prev = 0.0
for edge in (0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 1e9):
    s = (r >= prev) & (r < edge)
    if s.any():
        print(f"  [{prev:5.1f},{edge:5.1f}) n={int(s.sum()):5d} agree={float((pf[s]==pi[s]).mean()):.4f} "
              f"p1={float((pf[s]==1).mean()):.3f}", flush=True)
    prev = edge
print("frac |m|<1LSB", round(float((r < 1).mean()), 4), " <2LSB", round(float((r < 2).mean()), 4),
      " <4LSB", round(float((r < 4).mean()), 4), flush=True)
# 决策级一致（margin>=8 的 class1 命中判定）
hitf = (pf == 1) & (df >= 8)
hiti = (pi == 1) & (di >= 8)
print("decision agree", round(float((hitf == hiti).mean()), 4),
      "hitf", int(hitf.sum()), "hiti", int(hiti.sum()), flush=True)
# 权重 dequant 后的 float 前向 vs int8（仅激活量化差异）
mdl = copy.deepcopy(model)
sd = mdl.state_dict()
for l in params["layers"]:
    nm = {"conv1": "c1", "conv2": "c2", "conv3": "c3", "g1": "g1", "fc": "fc"}[l["name"]]
    w = np.asarray(l["weight_int8"], dtype=np.float64).reshape(l["weight_shape"])
    A = np.asarray(l["A_scale"], dtype=np.float64); sx = np.asarray(l["s_x_in"], dtype=np.float64)
    bq = np.asarray(l["bias_int32"], dtype=np.float64)
    if w.ndim == 4:
        wd = w * A.reshape(-1, 1, 1, 1) / sx.reshape(1, -1, 1, 1)
        sd[nm + ".weight"] = torch.as_tensor(wd, dtype=torch.float32)
        sd[nm + ".bias"] = torch.as_tensor(bq * A, dtype=torch.float32)
    else:
        wd = w * A.reshape(-1, 1) / sx.reshape(1, -1)
        sd[nm + ".weight"] = torch.as_tensor(wd, dtype=torch.float32)
        sd[nm + ".bias"] = torch.as_tensor(bq * A, dtype=torch.float32)
mdl.load_state_dict(sd)
ld = T.predict_logits(mdl, x_all[rows_te], feats[rows_te])
pdd = ld.argmax(1)
print("dequant-weight float vs int8 agree", round(float((pdd == pi).mean()), 4), flush=True)
print("float vs dequant-weight agree", round(float((pf == pdd).mean()), 4), flush=True)
