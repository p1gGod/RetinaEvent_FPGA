"""Train the P1 CNN on the M1 dataset (float32 teacher for quantization).

Evaluation is strictly session-level:
  * official M1 split: test sessions 191905/192720 (only class1 windows exist
    there, so the honest number is class1 recall, not 3-class accuracy);
  * a 5-fold session-grouped CV over all 20 sessions, used for the 3-class
    confusion matrix / per-class precision-recall.  Windows from one session
    never appear in both train and test of a fold.

Usage:
  python nn/train.py --seed 1234
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import NUM_CLASSES, P1CNN, build_model  # noqa: E402

NN_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = NN_DIR / "dataset_v3_w100.npz"
DEFAULT_OUT = NN_DIR / "out"
CLASS_NAMES = ("class0_none_or_board_move", "class1_hand_open_close", "class2_wave")


def load_dataset(path: Path) -> dict:
    d = np.load(path, allow_pickle=False)
    x = d["X_q"].astype(np.float32)
    y = d["y"].astype(np.int64)
    session = d["session"].astype(str)
    group = d["group"].astype(str)
    split = d["split"].astype(str)
    source = d["source"].astype(str)
    return {
        "path": str(path),
        "x": x,
        "y": y,
        "session": session,
        "group": group,
        "split": split,
        "source": source,
        "n": int(len(y)),
        "class_counts": {int(c): int((y == c).sum()) for c in range(NUM_CLASSES)},
        "win_ms": int(np.asarray(d["win_ms"]).reshape(-1)[0]),
        "stride_ms": int(np.asarray(d["stride_ms"]).reshape(-1)[0]),
        "channels": [str(v) for v in d["channels"]],
    }


def confusion_matrix(y_true: np.ndarray, y_pred: np.ndarray, n_classes: int = NUM_CLASSES) -> np.ndarray:
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    for t, p in zip(y_true.tolist(), y_pred.tolist()):
        cm[int(t), int(p)] += 1
    return cm


def per_class_metrics(cm: np.ndarray) -> dict:
    out: dict[str, dict] = {}
    n_classes = cm.shape[0]
    for c in range(n_classes):
        tp = int(cm[c, c])
        fp = int(cm[:, c].sum() - tp)
        fn = int(cm[c, :].sum() - tp)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        out[str(c)] = {
            "name": CLASS_NAMES[c],
            "support": int(cm[c, :].sum()),
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
        }
    return out


def summarize(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    cm = confusion_matrix(y_true, y_pred)
    present = [c for c in range(cm.shape[0]) if cm[c, :].sum() > 0]
    recalls = [cm[c, c] / cm[c, :].sum() for c in present]
    acc = float((y_true == y_pred).mean()) if len(y_true) else 0.0
    return {
        "n": int(len(y_true)),
        "accuracy": round(acc, 6),
        "balanced_accuracy": round(float(np.mean(recalls)), 6) if recalls else 0.0,
        "confusion": cm.tolist(),
        "per_class": per_class_metrics(cm),
    }


def assign_folds(sessions: np.ndarray, y: np.ndarray, group: np.ndarray, source: np.ndarray,
                 n_folds: int, seed: int) -> dict[str, int]:
    """Deterministic stratified round-robin over sessions (never split a session)."""
    uniq = sorted(set(sessions.tolist()))
    buckets: dict[str, list[str]] = {}
    for sess in uniq:
        mask = sessions == sess
        ys = y[mask]
        nonzero = ys[ys != 0]
        kind = int(np.bincount(nonzero, minlength=NUM_CLASSES).argmax()) if len(nonzero) else 0
        if str(source[mask][0]) == "board_move":
            kind = 0
        key = f"{kind}|{str(group[mask][0])}|{str(source[mask][0])}"
        buckets.setdefault(key, []).append(sess)
    # Within each bucket shuffle deterministically, then round-robin folds.
    # Offset advances per bucket so class2 sessions spread over distinct folds.
    fold_of: dict[str, int] = {}
    k = 0
    for key in sorted(buckets):
        members = list(buckets[key])
        random.Random(f"{seed}:{key}").shuffle(members)
        for sess in members:
            fold_of[sess] = k % n_folds
            k += 1
    return fold_of


def class_weights(y: np.ndarray) -> torch.Tensor:
    counts = np.bincount(y, minlength=NUM_CLASSES).astype(np.float64)
    counts = np.maximum(counts, 1.0)
    w = np.sqrt(float(len(y)) / (NUM_CLASSES * counts))
    w = np.clip(w, 0.5, 3.0)
    return torch.tensor(w, dtype=torch.float32)


def make_loader(x: np.ndarray, y: np.ndarray, batch_size: int, seed: int, shuffle: bool) -> DataLoader:
    ds = TensorDataset(torch.from_numpy(x), torch.from_numpy(y))
    gen = torch.Generator()
    gen.manual_seed(seed)
    return DataLoader(ds, batch_size=batch_size, shuffle=shuffle, generator=gen if shuffle else None,
                      num_workers=0, drop_last=False)


@torch.no_grad()
def predict(model: nn.Module, x: np.ndarray, batch_size: int = 512) -> np.ndarray:
    model.eval()
    out: list[np.ndarray] = []
    for i in range(0, len(x), batch_size):
        xb = torch.from_numpy(x[i:i + batch_size])
        out.append(model(xb).argmax(dim=1).numpy())
    return np.concatenate(out) if out else np.zeros(0, dtype=np.int64)


def train_one(x_tr: np.ndarray, y_tr: np.ndarray, x_te: np.ndarray, y_te: np.ndarray,
              seed: int, epochs: int, batch_size: int, lr: float, weight_decay: float,
              n_classes: int = NUM_CLASSES, verbose: bool = True) -> tuple[P1CNN, dict]:
    torch.manual_seed(seed)
    np.random.seed(seed)
    model = build_model(num_classes=n_classes)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    criterion = nn.CrossEntropyLoss(weight=class_weights(y_tr))
    loader = make_loader(x_tr, y_tr, batch_size, seed, shuffle=True)
    t0 = time.time()
    history: list[float] = []
    for epoch in range(1, epochs + 1):
        model.train()
        total = 0.0
        seen = 0
        for xb, yb in loader:
            opt.zero_grad(set_to_none=True)
            logits = model(xb)
            loss = criterion(logits, yb)
            loss.backward()
            opt.step()
            total += float(loss.item()) * len(yb)
            seen += len(yb)
        sched.step()
        history.append(round(total / max(1, seen), 6))
        if verbose and (epoch == 1 or epoch % 10 == 0 or epoch == epochs):
            print(f"    epoch {epoch:3d}/{epochs} loss={history[-1]:.4f} elapsed={time.time()-t0:.1f}s", flush=True)
    train_seconds = time.time() - t0
    pred = predict(model, x_te) if len(x_te) else np.zeros(0, dtype=np.int64)
    result = {
        "epochs": epochs,
        "batch_size": batch_size,
        "lr": lr,
        "weight_decay": weight_decay,
        "train_seconds": round(train_seconds, 2),
        "final_train_loss": history[-1] if history else None,
        "loss_curve": history,
        "test": summarize(y_te, pred) if len(y_te) else None,
    }
    return model, result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Train P1 CNN (M2)")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--cv-epochs", type=int, default=0, help="0 = same as --epochs")
    ap.add_argument("--no-cv", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    torch.set_num_threads(min(8, os.cpu_count() or 4))
    data = load_dataset(Path(args.data))
    x, y = data["x"], data["y"]
    print(f"[train] data={data['path']} n={data['n']} win={data['win_ms']}ms stride={data['stride_ms']}ms")
    print(f"[train] class counts={data['class_counts']} channels={data['channels']}")
    print(f"[train] official split: train={int((data['split']=='train').sum())} test={int((data['split']=='test').sum())}")

    tr = data["split"] == "train"
    te = data["split"] == "test"
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[train] === final model on official split ({int(tr.sum())} train / {int(te.sum())} test) ===", flush=True)
    model, final_res = train_one(x[tr], y[tr], x[te], y[te], args.seed, args.epochs,
                                 args.batch_size, args.lr, args.weight_decay,
                                 verbose=not args.quiet)
    ckpt = {
        "state_dict": model.state_dict(),
        "arch": "P1CNN",
        "num_classes": NUM_CLASSES,
        "grid": [30, 50],
        "in_ch": 4,
        "channels": data["channels"],
        "seed": args.seed,
        "epochs": args.epochs,
        "data": data["path"],
        "win_ms": data["win_ms"],
        "stride_ms": data["stride_ms"],
        "float_test": final_res["test"],
    }
    model_path = out_dir / "model.pt"
    torch.save(ckpt, model_path)
    print(f"[train] saved {model_path} params={model.param_count}")

    log: dict = {
        "seed": args.seed,
        "data": data["path"],
        "n_total": data["n"],
        "class_counts": data["class_counts"],
        "channels": data["channels"],
        "win_ms": data["win_ms"],
        "stride_ms": data["stride_ms"],
        "official_split": {
            "n_train": int(tr.sum()),
            "n_test": int(te.sum()),
            "test_sessions": sorted(set(data["session"][te].tolist())),
            "note": "M1 fixed holdout has only class1 windows; 3-class metrics come from grouped CV",
            "float_test": final_res["test"],
        },
        "final_model": {
            "path": str(model_path),
            "params": model.param_count,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "weight_decay": args.weight_decay,
            "train_seconds": final_res["train_seconds"],
            "final_train_loss": final_res["final_train_loss"],
        },
    }

    if not args.no_cv:
        n_folds = max(2, args.folds)
        fold_of = assign_folds(data["session"], y, data["group"], data["source"], n_folds, args.seed)
        print(f"[train] === {n_folds}-fold session-grouped CV ===")
        fold_rows: list[dict] = []
        all_true: list[np.ndarray] = []
        all_pred: list[np.ndarray] = []
        cv_epochs = args.cv_epochs or args.epochs
        for k in range(n_folds):
            val_sessions = sorted([s for s, f in fold_of.items() if f == k])
            val = np.isin(data["session"], val_sessions)
            trn = ~val
            print(f"[train] fold {k}: test_sessions={val_sessions} n_train={int(trn.sum())} n_test={int(val.sum())}", flush=True)
            fmodel, fres = train_one(x[trn], y[trn], x[val], y[val], args.seed + k + 1,
                                     cv_epochs, args.batch_size, args.lr, args.weight_decay,
                                     verbose=False)
            pred = predict(fmodel, x[val])
            all_true.append(y[val])
            all_pred.append(pred)
            row = {
                "fold": k,
                "test_sessions": val_sessions,
                "class_counts": {int(c): int((y[val] == c).sum()) for c in range(NUM_CLASSES)},
                **summarize(y[val], pred),
                "train_seconds": fres["train_seconds"],
            }
            fold_rows.append(row)
            print(f"[train]   fold {k} acc={row['accuracy']:.4f} bal={row['balanced_accuracy']:.4f} "
                  f"cm={row['confusion']} ({fres['train_seconds']:.1f}s)", flush=True)
        agg = summarize(np.concatenate(all_true), np.concatenate(all_pred))
        log["grouped_cv"] = {
            "n_folds": n_folds,
            "fold_assignment": {s: int(f) for s, f in sorted(fold_of.items())},
            "folds": fold_rows,
            "aggregate": agg,
        }
        print(f"[train] CV aggregate acc={agg['accuracy']:.4f} bal={agg['balanced_accuracy']:.4f} "
              f"cm={agg['confusion']}")
        for c, m in agg["per_class"].items():
            print(f"[train]   class{c} {m['name']}: P={m['precision']:.4f} R={m['recall']:.4f} n={m['support']}")

    log_path = out_dir / "train_log.json"
    log_path.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[train] wrote {log_path}")
    print("TRAIN_OK=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
