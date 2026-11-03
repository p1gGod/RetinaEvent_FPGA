# -*- coding: utf-8 -*-
"""QAT 冒烟：fold0 训 fold1 测，比较 PTQ 与 QAT 后的 float-vs-int8 argmax 一致率。"""
import sys, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for p in ("nn/v7", "nn/v6", "nn"):
    sys.path.insert(0, str(ROOT / p))
import v6_common as C, v7_eval as E, v7_feats as F, quant_v7 as QV, train_v7 as T
import qat_v7 as QAT

d = E.load(ROOT / "nn/v7/windows_v7.npz")
m = E.masks(d)
x_all = d["X"].astype(np.float32)
feats, names = F.build("fmin_n_rel", d["g"])
torch, nn = C._torch()
torch.set_num_threads(4)

rows_tr, yb_tr = T.rows_train_full(d, m, fold=0)
feat_names = names
sw = T.sample_weights(rows_tr, m, 3.0)
t0 = time.time()
model = T.train_binary(x_all[rows_tr], feats[rows_tr], yb_tr, sw, seed=1234, epochs=30)
model.v7_feat_names = list(names)
rows_te = np.where((m["fold"] == 1) & (m["primary"] | m["hardneg"]))[0]
params = QV.quantize_v7(model, x_all[rows_tr], feats[rows_tr].astype(np.int8), headroom=1.0)
li, _ = QV.forward_int8_v7(x_all[rows_te], feats[rows_te].astype(np.int8), params)
lf = T.predict_logits(model, x_all[rows_te], feats[rows_te])
pf, pi = lf.argmax(1), li.argmax(1)
print("PTQ agree", round(float((pf == pi).mean()), 4), "errors", len(QV.check_params_v7(params)), flush=True)
yb = np.where(d["y"][rows_te] == 1, 1, 0).astype(np.int64)
sw_te = T.sample_weights(rows_te, m, 3.0)
QAT.qat_finetune(model, params, x_all[rows_tr], feats[rows_tr].astype(np.int8), yb_tr, sw,
                 epochs=8, seed=1234, verbose=True)
print("QAT done", round(time.time() - t0, 1), "s", flush=True)
params2 = QAT.refresh_params(model, params)
li2, _ = QV.forward_int8_v7(x_all[rows_te], feats[rows_te].astype(np.int8), params2)
lf2 = T.predict_logits(model, x_all[rows_te], feats[rows_te])
pf2, pi2 = lf2.argmax(1), li2.argmax(1)
print("QAT agree", round(float((pf2 == pi2).mean()), 4), flush=True)
yv = d["y"][rows_te]
for k in (0, 1, 2):
    s = yv == k
    if s.any():
        print(" y", k, "n", int(s.sum()), "PTQ", round(float((pf[s] == pi[s]).mean()), 4),
              "QAT", round(float((pf2[s] == pi2[s]).mean()), 4), flush=True)
# int8 域的决策指标
c1_i = li2[:, 1].astype(np.int64) - li2[:, 0].astype(np.int64)
ev, _, _ = E.eval_rows(d, rows_te, pi2, c1_i.astype(np.float32), margin_min=8)
print("int8 eval m8 open", ev["open_chunks"], "wave_hit", ev["wave_window_hit_ratio"],
      "static", ev["static_fp_per_min"], "empty", ev["empty_pulses"], flush=True)
print("elapsed", round(time.time() - t0, 1), "s")
