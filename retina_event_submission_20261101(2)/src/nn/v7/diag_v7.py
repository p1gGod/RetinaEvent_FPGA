# -*- coding: utf-8 -*-
"""task-42 诊断：B 距离外推的误差来源（幅度 vs 运动）与 int8 一致率瓶颈（clip/calib）。"""
import json, sys, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for p in ("nn/v7", "nn/v6", "nn"):
    sys.path.insert(0, str(ROOT / p))
import v6_common as C, v7_eval as E, v7_feats as F, quant_v7 as QV, train_v7 as T

d = E.load(ROOT / "nn/v7/windows_v7.npz")
m = E.masks(d)
x_all = d["X"].astype(np.float32)
feats, fnames = F.build("fmin_n", d["g"])
torch, nn = C._torch()
torch.set_num_threads(4)
G = C.GIDX


def train(fold=None, near_only=False):
    rows, yb = T.rows_train_full(d, m, fold=fold, near_only=near_only)
    sw = T.sample_weights(rows, m, 3.0)
    return T.train_binary(x_all[rows], feats[rows], yb, sw, seed=1234, epochs=30), rows


def scale_rows(rows, k):
    """幅度缩放：网格计数 *k（饱和 127），n_div16/prev_n_div16 *k；ratio 与 dx/dy 不变。"""
    x = np.clip(x_all[rows] * k, 0, 127).astype(np.float32)
    f = feats[rows].copy()
    f[:, 0] = np.clip(f[:, 0] * k, 0, 127)
    f[:, 1] = np.clip(f[:, 1] * k, 0, 127)
    return x, f


def pred1(model, x, f):
    pred, c1, logits = T.predict(model, x, f)
    return pred, c1, logits


def zone_stats():
    zone = d["zone"].astype(str)
    n = d["g"][:, G["n"]]
    dx = d["g"][:, G["dx"]]
    sel = m["primary"] | m["hardneg"]
    out = {}
    for z in ("open_L_near", "open_L_far", "wave_L", "wave_L_far", "empty_A", "empty_A2", "still_B", "typing"):
        s = sel & (zone == z) & (m["aug"] == 0)
        if not s.any():
            continue
        out[z] = {"n_windows": int(s.sum()), "n_p50": float(np.percentile(n[s], 50)),
                  "n_p90": float(np.percentile(n[s], 90)), "dx_p50": float(np.percentile(dx[s], 50))}
    return out


print("[diag] zone stats", json.dumps(zone_stats(), ensure_ascii=False), flush=True)

# ---------- B: near 训 far 测，测试幅度补偿 ----------
t0 = time.time()
model_b, rows_tr = train(near_only=True)
zone = d["zone"].astype(str)
rows_far = np.where(np.isin(zone, ("open_L_far", "wave_L_far")) & (m["aug"] == 0))[0]
rows_near = np.where(np.isin(zone, ("open_L_near", "wave_L")) & (m["aug"] == 0))[0]
rows_neg = np.where(m["hardneg"] | (m["primary"] & (m["y"] == 0)))[0][:800]
res_b = {}
for tag, rows in (("far", rows_far), ("near", rows_near), ("neg", rows_neg)):
    for k in (1.0, 2.0, 4.0):
        x, f = scale_rows(rows, k)
        pred, c1, _ = pred1(model_b, x, f)
        res_b[f"{tag}_x{k}"] = {"pred1_ratio": round(float((pred == 1).mean()), 3),
                                "mean_c1": round(float(c1.mean()), 3),
                                "frac_c1_ge8": round(float((c1 >= 8).mean()), 3)}
print("[diag] B amplitude sweep", json.dumps(res_b, ensure_ascii=False), flush=True)

# ---------- int8: fold1 训 fold0 测 ----------
model_a, rows_tr_a = train(fold=1)
rows_te = np.where((m["fold"] == 0) & (m["primary"] | m["hardneg"]))[0]
feat_te = feats[rows_te].astype(np.int8)
logits_f = T.predict_logits(model_a, x_all[rows_te], feats[rows_te])
pred_f = logits_f.argmax(1)
res_q = {}
for tag, cn, hr in (("calib2048_hr1.0", 2048, 1.0), ("calib2048_hr1.05", 2048, 1.05),
                    ("calib2048_hr1.10", 2048, 1.10), ("calib6000_hr1.0", 6000, 1.0)):
    rng = np.random.default_rng(1234)
    cal = np.sort(rng.choice(rows_tr_a, size=min(cn, len(rows_tr_a)), replace=False))
    p = QV.quantize_v7(model_a, x_all[cal], feats[cal].astype(np.int8), headroom=hr)
    li, _ = QV.forward_int8_v7(x_all[rows_te], feat_te, p)
    res_q[tag] = {"agree": round(float((li.argmax(1) == pred_f).mean()), 4),
                  "rom_words": p["rom_words"], "clip": {}, "act_ratio": {}}
    # 每层 float 激活 vs int8 上限（clip 检查）
    xt = torch.from_numpy(x_all[rows_te]); ft = torch.from_numpy(feats[rows_te])
    with torch.no_grad():
        h1 = model_a.c1(xt); h2 = model_a.c2(h1); h3 = model_a.c3(h2); g1 = model_a.feat(ft)
    acts = {"conv1": h1.numpy(), "conv2": h2.numpy(), "conv3": h3.numpy(), "g1": g1.numpy()}
    for l in p["layers"]:
        n = l["name"]
        if n not in acts:
            continue
        a = acts[n]
        sy = np.asarray(l["s_y_out"]).reshape([1, -1] + [1] * (a.ndim - 2)) if a.ndim > 2 else np.asarray(l["s_y_out"]).reshape(1, -1)
        lim = sy * 127.0
        over = float((a > lim + 1e-9).mean())
        res_q[tag]["clip"][n] = round(over, 5)
        res_q[tag]["act_ratio"][n] = round(float((np.abs(a) / np.maximum(lim, 1e-9)).max()), 3)
print("[diag] int8 variants", json.dumps(res_q, ensure_ascii=False), flush=True)
(ROOT / "nn/out_v7/diag_v7.json").write_text(json.dumps({"zone_stats": zone_stats(), "B": res_b, "Q": res_q},
                                                        ensure_ascii=False, indent=1), encoding="utf-8")
print("[diag] elapsed", round(time.time() - t0, 1), "s", flush=True)
