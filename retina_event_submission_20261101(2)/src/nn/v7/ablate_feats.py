#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""特征消融：fold0 训练 -> fold1 留出，比较 f17 / 各整数部署特征集 / 无特征(纯 CNN)。"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "nn" / "v7"))
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402
import v7_feats as F  # noqa: E402
import v7_eval as E  # noqa: E402

DEFAULT_DATA = ROOT / "nn" / "v7" / "windows_v7.npz"
DEFAULT_OUT = ROOT / "nn" / "out_v7"


def train_binary(x, feats, yb, sw, seed=1234, epochs=30, batch=128, lr=2e-3, wd=1e-4):
    torch, nn = C._torch()
    torch.set_num_threads(min(8, 4))
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    counts = np.bincount(yb, minlength=2).astype(np.float64)
    counts[counts == 0] = 1.0
    cw = np.clip(np.sqrt(len(yb) / (2.0 * counts)), 0.5, 3.0)
    cw_t = torch.tensor(cw, dtype=torch.float32)
    model = C.build_model("bin", n_in=x.shape[1], n_feat=(0 if feats is None else feats.shape[1]), n_out=2)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    lossf = nn.CrossEntropyLoss(weight=cw_t, reduction="none")
    xt = torch.from_numpy(np.ascontiguousarray(x)).float()
    yt = torch.from_numpy(np.ascontiguousarray(yb)).long()
    ft = torch.from_numpy(np.ascontiguousarray(feats)).float() if feats is not None else None
    swt = torch.from_numpy(np.ascontiguousarray(sw)).float()
    for _ep in range(epochs):
        perm = rng.permutation(len(yt))
        model.train()
        for i in range(0, len(yt), batch):
            idx = perm[i:i + batch]
            opt.zero_grad()
            out = model(xt[idx], ft[idx]) if ft is not None else model(xt[idx])
            loss = (lossf(out, yt[idx]) * swt[idx]).sum() / swt[idx].sum().clamp(min=1e-6)
            loss.backward()
            opt.step()
        sched.step()
    model.eval()
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--modes", default="none,f17,f12s,f12n,fmin_s,fmin_n,f7n,f9s")
    ap.add_argument("--wave-weight", type=float, default=3.0)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--out", default=str(DEFAULT_OUT / "feat_ablation.json"))
    args = ap.parse_args()

    d = E.load(args.data)
    m = E.masks(d)
    x_all = d["X"].astype(np.float32)
    rows_tr, yb_tr = E.train_set(d, m, fold=0)
    sw_tr = E.sample_weights(rows_tr, m["y"], m["wave_weight_row"] > 0)
    rows_te, yb_te = E.train_set(d, m, fold=1)
    print(f"[ablate] train rows={len(rows_tr)} (pos={int(yb_tr.sum())}, wave={int((m['wave'][rows_tr]).sum())}) "
          f"test rows={len(rows_te)}", flush=True)

    results = {}
    for mode in args.modes.split(","):
        mode = mode.strip()
        t0 = time.time()
        if mode == "none":
            ftr = fte = None
            names = []
        else:
            f_all, names = F.build(mode, d["g"])
            ftr = f_all[rows_tr]
            fte = f_all[rows_te]
        model = train_binary(x_all[rows_tr], ftr, yb_tr, sw_tr,
                             seed=args.seed, epochs=args.epochs)
        pred, margin, c1, logits = C.predict_model(model, x_all[rows_te], feat=fte)
        win_acc = float((pred == yb_te).mean())
        row = {"n_feat": len(names), "names": names, "window_acc": round(win_acc, 4),
               "train_s": round(time.time() - t0, 1), "margins": {}}
        for mg in (8, 16, 24):
            summ, per_zone, _ = E.eval_rows(d, rows_te, pred, c1, margin_min=mg)
            row["margins"][str(mg)] = {
                "open_recall": summ["open_recall"], "open_chunks": summ["open_chunks"],
                "wave_hit_ratio": summ["wave_window_hit_ratio"],
                "wave_pulses": summ["wave_pulses"],
                "static_fp_per_min": summ["static_fp_per_min"],
                "static_pulses": summ["static_pulses"],
                "empty_pulses": summ["empty_pulses"],
                "empty_low_n_hits": summ["empty_low_n_hits"],
                "hardneg_pulses": summ["hardneg_pulses"],
            }
        results[mode] = row
        r8 = row["margins"]["8"]
        print(f"[ablate] {mode:7s} F={len(names):2d} acc={win_acc:.4f} "
              f"m8: open={r8['open_chunks']} wave_hit={r8['wave_hit_ratio']} "
              f"wave_p={r8['wave_pulses']} static={r8['static_fp_per_min']}/min "
              f"empty={r8['empty_pulses']} ({row['train_s']}s)", flush=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"rows_train": len(rows_tr), "rows_test": len(rows_te),
                               "wave_weight": args.wave_weight, "results": results},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[ablate] -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
