"""Supplementary evaluation for the M2 reports.

Produces nn/out/eval_report.json with:
  * leave-one-parameter-group-out CV (3 groups);
  * ON/OFF channel ablation on the official test split, for the float and the
    int8 model separately;
  * official-split and grouped-CV metrics copied from train_log.json.

This script does not change the frozen M1 split; it only adds diagnostics.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train as T  # noqa: E402
from model import build_model  # noqa: E402
from quantize import forward_int8  # noqa: E402

NN_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = NN_DIR / "dataset_v3_w100.npz"
DEFAULT_OUT = NN_DIR / "out"


def group_cv(data: dict, seed: int, epochs: int, batch_size: int, lr: float,
             weight_decay: float) -> dict:
    groups = sorted(set(data["group"].tolist()))
    rows = []
    for gi, g in enumerate(groups):
        te = data["group"] == g
        tr = ~te
        model, res = T.train_one(data["x"][tr], data["y"][tr], data["x"][te], data["y"][te],
                                 seed + 100 + gi, epochs, batch_size, lr, weight_decay,
                                 verbose=False)
        row = {
            "held_out_group": g,
            "test_sessions": sorted(set(data["session"][te].tolist())),
            "class_counts": {int(c): int((data["y"][te] == c).sum()) for c in range(3)},
            **res["test"],
        }
        rows.append(row)
        print(f"[eval] group={g} n={row['n']} acc={row['accuracy']:.4f} "
              f"bal={row['balanced_accuracy']:.4f} cm={row['confusion']}")
    return {"groups": groups, "folds": rows}


def ablation(ckpt_path: Path, data: dict, params_path: Path) -> dict:
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    model = build_model(num_classes=ckpt.get("num_classes", 3))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    te = data["split"] == "test"
    x = data["x"][te].copy()
    y = data["y"][te]
    with torch.no_grad():
        base_pred = model(torch.from_numpy(x)).argmax(dim=1).numpy()
    base_acc = float((base_pred == y).mean())
    params = json.loads(params_path.read_text(encoding="utf-8"))
    base_q, _ = forward_int8(x.astype(np.int8), params)
    base_q_pred = base_q.argmax(axis=1)
    base_q_acc = float((base_q_pred == y).mean())
    channels = ["ON_now", "OFF_now", "ON_prev", "OFF_prev"]
    rows = []
    for ci, name in enumerate(channels):
        xz = x.copy()
        xz[:, ci, :, :] = 0.0
        with torch.no_grad():
            pred = model(torch.from_numpy(xz)).argmax(dim=1).numpy()
        acc = float((pred == y).mean())
        qz, _ = forward_int8(xz.astype(np.int8), params)
        qpred = qz.argmax(axis=1)
        qacc = float((qpred == y).mean())
        row = {
            "zeroed_channel": ci,
            "name": name,
            "float_accuracy": round(acc, 6),
            "float_drop_pp": round((base_acc - acc) * 100, 2),
            "int8_accuracy": round(qacc, 6),
            "int8_drop_pp": round((base_q_acc - qacc) * 100, 2),
        }
        rows.append(row)
        print(f"[eval] zero {name}: float acc={acc:.4f} drop={row['float_drop_pp']:+.2f}pp | "
              f"int8 acc={qacc:.4f} drop={row['int8_drop_pp']:+.2f}pp")
    return {
        "test_n": int(te.sum()),
        "class_counts": {int(c): int((y == c).sum()) for c in range(3)},
        "baseline_float_accuracy": round(base_acc, 6),
        "baseline_int8_accuracy": round(base_q_acc, 6),
        "rows": rows,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Supplementary M2 evaluation")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    args = ap.parse_args(argv)

    out = Path(args.out_dir)
    data = T.load_dataset(Path(args.data))
    train_log = json.loads((out / "train_log.json").read_text(encoding="utf-8"))

    print("[eval] leave-one-parameter-group-out CV")
    gcv = group_cv(data, args.seed, args.epochs, args.batch_size, args.lr, args.weight_decay)
    print("[eval] channel ablation on official test split")
    abl = ablation(out / "model.pt", data, out / "nn_params.json")

    report = {
        "data": str(args.data),
        "official_split": train_log.get("official_split"),
        "grouped_cv_5fold": train_log.get("grouped_cv", {}).get("aggregate"),
        "leave_one_parameter_group_out": gcv,
        "ablation": abl,
    }
    path = out / "eval_report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[eval] wrote {path}")
    print("EVAL_OK=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
