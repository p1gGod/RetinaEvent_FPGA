#!/usr/bin/env python3
"""CNN 对照：与 probe_feat_study.py 同口径的 class2 留一会话 LOO。

只用 dataset_v3_w100.npz（M2 的 4x30x50 输入），固定 test 会话
191905/192720 恒为 test；每次留一条 class2 会话，train=其余全部。
输出逐折 class2/class1/class0 recall 与 3 分类 balanced accuracy。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import train as T

FIXED_TEST = ("retina-events-20261029-191905", "retina-events-20261029-192720")
DEFAULT_DATA = Path(__file__).with_name("dataset_v3_w100.npz")
OUT = Path(__file__).with_name("_feat_cnn_result.json")


def recalls(cm: np.ndarray) -> dict:
    out = {"cm": cm.tolist()}
    for c in range(cm.shape[0]):
        n = int(cm[c, :].sum())
        out[f"recall_class{c}"] = round(float(cm[c, c] / n), 6) if n else None
        out[f"n_class{c}"] = n
    present = [c for c in range(cm.shape[0]) if cm[c, :].sum() > 0]
    out["balanced_acc"] = round(float(np.mean([cm[c, c] / cm[c, :].sum() for c in present])), 6)
    out["acc"] = round(float(np.trace(cm) / max(1, cm.sum())), 6)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args(argv)
    data = T.load_dataset(Path(args.data))
    x, y, session = data["x"], data["y"], data["session"]
    class2_sessions = sorted(set(session[y == 2].tolist()))
    print(f"# data={args.data} n={len(y)} class2_sessions={class2_sessions} "
          f"epochs={args.epochs}")
    folds = []
    for fold, held in enumerate(class2_sessions):
        is_fixed = np.isin(session, list(FIXED_TEST))
        tr = ~(np.isin(session, [held]) | is_fixed)
        te = np.isin(session, [held]) | is_fixed
        model, res = T.train_one(
            x[tr], y[tr], x[te], y[te], seed=args.seed + fold,
            epochs=args.epochs, batch_size=128, lr=2e-3, weight_decay=1e-4,
            verbose=False)
        pred = T.predict(model, x[te])
        cm = T.confusion_matrix(y[te], pred)
        m = recalls(cm)
        m["held"] = held
        m["class2_n"] = int(((session[te] == held) & (y[te] == 2)).sum())
        m["train_n"] = int(tr.sum())
        folds.append(m)
        print(f"  held={held[-6:]} class2_n={m['class2_n']} "
              f"recall_class2={m['recall_class2']} recall_class1={m['recall_class1']} "
              f"recall_class0={m['recall_class0']} bal={m['balanced_acc']} "
              f"acc={m['acc']} train_s={res['train_seconds']}")
    c2 = [f["recall_class2"] for f in folds if f["recall_class2"] is not None]
    print(f"CNN_LFO class2 recall={np.mean(c2):.4f}+-{np.std(c2):.4f} folds={len(c2)}")
    out = {"data": args.data, "epochs": args.epochs, "seed": args.seed,
           "class2_sessions": class2_sessions, "folds": folds,
           "mean_recall_class2": float(np.mean(c2)),
           "std_recall_class2": float(np.std(c2))}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"# wrote {OUT}")
    print("CNN_LFO_DONE=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
