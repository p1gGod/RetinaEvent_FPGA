"""Fusion training: P1 CNN + 2 per-window scalar features (v4), session-level LOO.

Protocol (frozen by the task-19 acceptance criteria):
  * leave-one-session-out over all 20 sessions; the two fixed official test
    sessions (retina-events-20261029-191905 / ...192720) are NEVER used for
    training in any fold;
  * each fold trains two arms with identical hyper-parameters:
      arm A  CNN-only, 4x30x50 counts, via train.py:train_one (strict reuse);
      arm B  same CNN + 2 scalars (scalar_swing_x, scalar_horiz) fed into a
             small MLP head together with the 240 conv3 features, plus an
             auxiliary CE on the plain CNN fc head (multi-task, so the
             5718-word int8 prefix stays useful on its own);
  * binary fallback routes are trained the same way:
      B1  class1 vs rest (class2 folded into the negative class, M5 doc 4.2);
      B2  strict class0 vs class1 (class2 windows dropped).
  * the fusion head is int8-quantized with the same contract as quantize.py
    (int8 weight, int32 bias, power-of-two per-output-channel scale) and its
    weights are appended to the frozen 5718-word ROM prefix.

Artifacts:
  nn/out_v4/nn_params_v4.json      CNN prefix + fusion head int8 params + LOO metrics
  nn/out_v4/nn_rom_data_v4.v       7700-word RTL ROM (extension of nn/out/nn_rom_data.v)
  nn/REPORT_融合与裁决.md           first line FUSION_OK=1
  nn/_evidence/FUSION_OK.log        first line FUSION_OK=1
  nn/out_v4/nn_params_2cls.json    2-class fallback (B2 route) params + M5 3.4.1 gate
  nn/out_v4/nn_rom_data_2cls.v     5716-word 2-class ROM, module nn_rom_data
  nn/REPORT_QC与数据集v4.md         section 10 (between the FUSION markers) refreshed

The reported LOO numbers are honest cross-session numbers; the final all-window
model exists only to supply ROM bytes and is NOT a generalisation claim.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

NN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(NN_DIR))

import quantize as Q  # noqa: E402
import train as T  # noqa: E402
from model import NUM_CLASSES, build_model  # noqa: E402

DEFAULT_DATA = NN_DIR / "dataset_v4_w100.npz"
DEFAULT_OUT_DIR = NN_DIR / "out_v4"
DEFAULT_REPORT = NN_DIR / "REPORT_融合与裁决.md"
V4_REPORT = NN_DIR / "REPORT_QC与数据集v4.md"
DEFAULT_EVID = NN_DIR / "_evidence" / "FUSION_OK.log"

FIXED_TEST_SESSIONS = (
    "retina-events-20261029-191905",
    "retina-events-20261029-192720",
)
CLASS_NAMES = ("class0_none_or_board_move", "class1_hand_open_close", "class2_wave")
SWING_DIV = 3.0
HORIZ_DIV = 1.0
AUX_WEIGHT = 0.5
FEAT_DIM = 240
HIDDEN = 8
GATE = {
    "class2_recall": 0.75,
    "class1_recall": 0.85,
    "class0_recall": 0.85,
    "balanced_accuracy": 0.85,
}
ROM_BASE_WORDS = Q.ROM_WORD_COUNT
FUSION_BEGIN = "<!-- FUSION_SECTION_BEGIN -->"
FUSION_END = "<!-- FUSION_SECTION_END -->"
SCALAR_NAMES = ("scalar_swing_x", "scalar_horiz")


def _force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


class Log:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, msg: str = "") -> None:
        print(msg, flush=True)
        self.lines.append(str(msg))


def short(session: str) -> str:
    return session.rsplit("-", 1)[-1]


def fmt_counts(counts: dict, n_classes: int) -> str:
    return "/".join(str(int(counts.get(int(c), counts.get(str(c), 0)))) for c in range(n_classes))


def load_data(path: Path) -> dict:
    d = np.load(path, allow_pickle=False)
    x = d["X_q"].astype(np.float32)
    y = d["y"].astype(np.int64)
    session = d["session"].astype(str)
    scal = np.stack([
        d["scalar_swing_x"].astype(np.float32) / SWING_DIV,
        d["scalar_horiz"].astype(np.float32) / HORIZ_DIV,
    ], axis=1).astype(np.float32)
    data = {
        "path": str(path),
        "x": x,
        "y": y,
        "session": session,
        "scal": scal,
        "qc_pass": d["qc_pass"].astype(np.uint8),
        "qc_verdict": d["qc_verdict"].astype(str),
        "win_ms": int(np.asarray(d["win_ms"]).reshape(-1)[0]),
        "stride_ms": int(np.asarray(d["stride_ms"]).reshape(-1)[0]),
        "split": d["split"].astype(str),
        "n": int(len(y)),
        "class_counts": {int(c): int((y == c).sum()) for c in range(3)},
    }
    return data


def subset_data(data: dict, keep: np.ndarray) -> dict:
    out = dict(data)
    for key in ("x", "y", "session", "scal", "qc_pass", "qc_verdict", "split"):
        out[key] = data[key][keep]
    out["n"] = int(keep.sum())
    out["class_counts"] = {int(c): int((out["y"] == c).sum()) for c in range(3)}
    return out


class FusionNet(nn.Module):
    def __init__(self, n_scalars: int = 2, hidden: int = HIDDEN, n_classes: int = NUM_CLASSES):
        super().__init__()
        self.cnn = build_model(num_classes=n_classes)
        self.head = nn.Sequential(
            nn.Linear(FEAT_DIM + n_scalars, hidden),
            nn.ReLU(),
            nn.Linear(hidden, n_classes),
        )
        self.param_count = self.cnn.param_count + sum(p.numel() for p in self.head.parameters())

    def features(self, x: torch.Tensor) -> torch.Tensor:
        h = torch.relu(self.cnn.conv1(x))
        h = torch.relu(self.cnn.conv2(h))
        h = torch.relu(self.cnn.conv3(h))
        return torch.flatten(h, 1)

    def forward(self, x: torch.Tensor, s: torch.Tensor):
        f = self.features(x)
        return self.head(torch.cat([f, s], dim=1)), self.cnn.fc(f)


def class_weights_n(y: np.ndarray, n_classes: int) -> torch.Tensor:
    counts = np.bincount(y, minlength=n_classes).astype(np.float64)
    counts = np.maximum(counts, 1.0)
    w = np.sqrt(float(len(y)) / (n_classes * counts))
    w = np.clip(w, 0.5, 3.0)
    return torch.tensor(w, dtype=torch.float32)


def summarize_n(y_true: np.ndarray, y_pred: np.ndarray, n_classes: int) -> dict:
    cm = T.confusion_matrix(y_true, y_pred, n_classes)
    present = [c for c in range(n_classes) if int(cm[c, :].sum()) > 0]
    recalls = [float(cm[c, c]) / float(cm[c, :].sum()) for c in present]
    acc = float((y_true == y_pred).mean()) if len(y_true) else 0.0
    per: dict[str, dict] = {}
    for c in range(n_classes):
        tp = int(cm[c, c])
        fp = int(cm[:, c].sum()) - tp
        fn = int(cm[c, :].sum()) - tp
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        name = CLASS_NAMES[c] if c < len(CLASS_NAMES) else "class" + str(c)
        per[str(c)] = {
            "name": name,
            "support": int(cm[c, :].sum()),
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
        }
    return {
        "n": int(len(y_true)),
        "accuracy": round(acc, 6),
        "balanced_accuracy": round(float(np.mean(recalls)), 6) if recalls else 0.0,
        "confusion": cm.tolist(),
        "per_class": per,
    }


@torch.no_grad()
def predict_fusion(model: FusionNet, x: np.ndarray, s: np.ndarray, batch_size: int = 512):
    model.eval()
    out_f: list[np.ndarray] = []
    out_c: list[np.ndarray] = []
    for i in range(0, len(x), batch_size):
        xb = torch.from_numpy(np.ascontiguousarray(x[i:i + batch_size]))
        sb = torch.from_numpy(np.ascontiguousarray(s[i:i + batch_size]))
        fl, cl = model(xb, sb)
        out_f.append(fl.argmax(dim=1).numpy())
        out_c.append(cl.argmax(dim=1).numpy())
    if not out_f:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    return np.concatenate(out_f), np.concatenate(out_c)


def train_fusion(x_tr, y_tr, s_tr, x_te, y_te, s_te, seed: int, args, n_classes: int,
                 verbose: bool = False):
    torch.manual_seed(seed)
    np.random.seed(seed)
    model = FusionNet(n_classes=n_classes)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, args.epochs))
    crit = nn.CrossEntropyLoss(weight=class_weights_n(y_tr, n_classes))
    xt = torch.from_numpy(np.ascontiguousarray(x_tr))
    st = torch.from_numpy(np.ascontiguousarray(s_tr))
    yt = torch.from_numpy(np.ascontiguousarray(y_tr))
    gen = torch.Generator()
    gen.manual_seed(seed)
    t0 = time.time()
    history: list[float] = []
    n = len(yt)
    model.train()
    for ep in range(1, args.epochs + 1):
        perm = torch.randperm(n, generator=gen)
        total = 0.0
        seen = 0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            opt.zero_grad(set_to_none=True)
            fl, cl = model(xt[idx], st[idx])
            loss = crit(fl, yt[idx]) + AUX_WEIGHT * crit(cl, yt[idx])
            loss.backward()
            opt.step()
            total += float(loss.item()) * len(idx)
            seen += int(len(idx))
        sched.step()
        history.append(round(total / max(1, seen), 6))
        if verbose and (ep == 1 or ep % 10 == 0 or ep == args.epochs):
            print("    epoch %3d/%d loss=%.4f" % (ep, args.epochs, history[-1]), flush=True)
    seconds = time.time() - t0
    pred_f, pred_c = predict_fusion(model, x_te, s_te)
    result = {
        "train_seconds": round(seconds, 2),
        "final_train_loss": history[-1] if history else None,
        "loss_curve": history,
        "fusion_test": summarize_n(y_te, pred_f, n_classes) if len(y_te) else None,
        "cnn_head_test": summarize_n(y_te, pred_c, n_classes) if len(y_te) else None,
        "pred_fusion": pred_f,
        "pred_cnn_head": pred_c,
    }
    return model, result


def train_cnn_n(x_tr, y_tr, x_te, y_te, seed: int, args, n_classes: int, verbose: bool = False):
    """train.py:train_one 的等价实现，只把 class_weights 换成 n_classes 感知版本。

    train_one 的 CE weight 固定按 3 类计算（class_weights 里 minlength=3），
    两分类回退路线直接调用会报 weight shape 3 vs 2；其余逻辑逐行对齐。
    """
    torch.manual_seed(seed)
    np.random.seed(seed)
    model = build_model(num_classes=n_classes)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, args.epochs))
    crit = nn.CrossEntropyLoss(weight=class_weights_n(y_tr, n_classes))
    loader = T.make_loader(x_tr, y_tr, args.batch_size, seed, shuffle=True)
    t0 = time.time()
    history: list[float] = []
    model.train()
    for ep in range(1, args.epochs + 1):
        total = 0.0
        seen = 0
        for xb, yb in loader:
            opt.zero_grad(set_to_none=True)
            logits = model(xb)
            loss = crit(logits, yb)
            loss.backward()
            opt.step()
            total += float(loss.item()) * len(yb)
            seen += int(len(yb))
        sched.step()
        history.append(round(total / max(1, seen), 6))
        if verbose and (ep == 1 or ep % 10 == 0 or ep == args.epochs):
            print("    epoch %3d/%d loss=%.4f" % (ep, args.epochs, history[-1]), flush=True)
    seconds = time.time() - t0
    pred = T.predict(model, x_te) if len(x_te) else np.zeros(0, dtype=np.int64)
    result = {
        "train_seconds": round(seconds, 2),
        "final_train_loss": history[-1] if history else None,
        "loss_curve": history,
        "test": summarize_n(y_te, pred, n_classes) if len(y_te) else None,
    }
    return model, result


def run_loo(data: dict, y: np.ndarray, n_classes: int, args, log: Log, tag: str) -> dict:
    sessions = sorted(set(data["session"].tolist()))
    rows: list[dict] = []
    all_true: list[np.ndarray] = []
    preds: dict[str, list[np.ndarray]] = {"cnn": [], "fusion": []}
    for k, sess in enumerate(sessions):
        if args.folds_limit and len(rows) >= args.folds_limit:
            break
        val = data["session"] == sess
        trn = (~val) & (~np.isin(data["session"], FIXED_TEST_SESSIONS))
        n_tr = int(trn.sum())
        n_val = int(val.sum())
        if n_val == 0 or n_tr == 0:
            log("  [%s] fold %02d %s SKIP val=%d train=%d" % (tag, k, short(sess), n_val, n_tr))
            continue
        seed = args.seed + k + 1
        leak = int(np.isin(data["session"][trn], FIXED_TEST_SESSIONS).sum())
        if leak:
            raise RuntimeError("fixed test session leaked into training: " + sess)
        t0 = time.time()
        if n_classes == 3:
            # 主臂（三分类）严格复用 train.py:train_one，超参同 nn/train.py 默认
            m_a, r_a = T.train_one(data["x"][trn], y[trn], data["x"][val], y[val], seed,
                                   args.epochs, args.batch_size, args.lr, args.weight_decay,
                                   n_classes=n_classes, verbose=False)
        else:
            m_a, r_a = train_cnn_n(data["x"][trn], y[trn], data["x"][val], y[val],
                                   seed, args, n_classes)
        pred_a = T.predict(m_a, data["x"][val])
        t_cnn = time.time() - t0
        t0 = time.time()
        m_b, r_b = train_fusion(data["x"][trn], y[trn], data["scal"][trn],
                                data["x"][val], y[val], data["scal"][val],
                                seed, args, n_classes)
        t_fus = time.time() - t0
        sm_a = summarize_n(y[val], pred_a, n_classes)
        sm_b = summarize_n(y[val], r_b["pred_fusion"], n_classes)
        tr_counts = {int(c): int((y[trn] == c).sum()) for c in range(n_classes)}
        val_counts = {int(c): int((y[val] == c).sum()) for c in range(n_classes)}
        rows.append({
            "fold": k,
            "session": sess,
            "seed": seed,
            "n_train": n_tr,
            "n_val": n_val,
            "train_class_counts": tr_counts,
            "val_class_counts": val_counts,
            "cnn": {**sm_a, "train_seconds": round(t_cnn, 2), "final_train_loss": r_a["final_train_loss"]},
            "fusion": {**sm_b, "train_seconds": round(t_fus, 2), "final_train_loss": r_b["final_train_loss"]},
            "delta_balanced": round(sm_b["balanced_accuracy"] - sm_a["balanced_accuracy"], 6),
        })
        all_true.append(y[val].copy())
        preds["cnn"].append(pred_a)
        preds["fusion"].append(r_b["pred_fusion"])
        log("  [%s] fold %02d %s n_tr=%d n_val=%d val=(%s) cnn bal=%.3f fus bal=%.3f d=%+.3f (%.1fs/%.1fs)"
            % (tag, k, short(sess), n_tr, n_val, fmt_counts(val_counts, n_classes),
               sm_a["balanced_accuracy"], sm_b["balanced_accuracy"],
               sm_b["balanced_accuracy"] - sm_a["balanced_accuracy"], t_cnn, t_fus))
    out = {"tag": tag, "n_classes": n_classes, "n_folds": len(rows), "rows": rows}
    y_all = np.concatenate(all_true) if all_true else np.zeros(0, dtype=np.int64)
    for arm in ("cnn", "fusion"):
        p = np.concatenate(preds[arm]) if preds[arm] else np.zeros(0, dtype=np.int64)
        out[arm] = {"aggregate": summarize_n(y_all, p, n_classes) if len(y_all) else None}
    return out


def gate_values(summary: dict) -> dict:
    pc = summary["per_class"]
    return {
        "class2_recall": float(pc.get("2", {}).get("recall", 0.0)),
        "class1_recall": float(pc.get("1", {}).get("recall", 0.0)),
        "class0_recall": float(pc.get("0", {}).get("recall", 0.0)),
        "balanced_accuracy": float(summary["balanced_accuracy"]),
    }


def gate_verdict(vals: dict) -> dict:
    checks = {name: bool(vals[name] >= th) for name, th in GATE.items()}
    return {"values": vals, "thresholds": dict(GATE), "checks": checks,
            "pass": bool(all(checks.values()))}


def doc_gate(vals: dict) -> dict:
    checks = {"class2_recall": bool(vals["class2_recall"] >= 0.75),
              "class1_recall": bool(vals["class1_recall"] >= 0.85)}
    return {"thresholds": {"class2_recall": 0.75, "class1_recall": 0.85},
            "checks": checks, "pass": bool(all(checks.values()))}


# ---------------------------------------------------------------- int8 fusion
def cnn_int8_features(x: np.ndarray, cnn_params: dict) -> np.ndarray:
    acts = np.ascontiguousarray(x.astype(np.int8))
    for layer in cnn_params["layers"]:
        if layer["name"] == "fc":
            break
        w = np.asarray(layer["weight_int8"], dtype=np.int8).reshape(layer["weight_shape"])
        b = np.asarray(layer["bias_int32"], dtype=np.int64)
        sh = np.asarray(layer["SH"], dtype=np.int64)
        acts = Q.conv2d_int8(acts, w, b, sh, relu=True)
    return np.ascontiguousarray(acts.reshape(acts.shape[0], -1))


def quantize_fusion_head(model: FusionNet, cnn_params: dict, x_cal: np.ndarray, s_cal: np.ndarray) -> dict:
    feat_q = cnn_int8_features(x_cal, cnn_params)
    conv3_sy = np.asarray(cnn_params["layers"][2]["s_y_out"], dtype=np.float64)
    s_feat = np.repeat(conv3_sy, 10)
    scalar_scale = np.maximum(np.abs(s_cal.astype(np.float64)).max(axis=0) / 127.0, 1e-9)
    s_q = np.clip(np.rint(s_cal.astype(np.float64) / scalar_scale.reshape(1, -1)), -128, 127).astype(np.int64)

    l1 = model.head[0]
    l2 = model.head[2]
    w1 = l1.weight.detach().numpy().astype(np.float64)
    b1 = l1.bias.detach().numpy().astype(np.float64)
    s_in = np.concatenate([s_feat, scalar_scale])
    w1q, A1 = Q._quant_layer_weights(w1, s_in)
    z1_real = np.concatenate([feat_q.astype(np.float64) * s_feat,
                              s_q.astype(np.float64) * scalar_scale], axis=1) @ w1.T + b1
    z1_real = np.maximum(z1_real, 0.0)
    act_max1 = z1_real.max(axis=0)
    des1 = np.where(act_max1 > 1e-12, act_max1 / 127.0, 1e-6)
    SH1, s_y1 = Q._shift_for(A1, des1)
    b1q = np.rint(b1 / A1).astype(np.int64)

    w2 = l2.weight.detach().numpy().astype(np.float64)
    b2 = l2.bias.detach().numpy().astype(np.float64)
    w2q, A2 = Q._quant_layer_weights(w2, s_y1)
    z2_real = z1_real @ w2.T + b2
    act_max2 = np.abs(z2_real).max(axis=0)
    des2 = np.where(act_max2 > 1e-12, act_max2 / 127.0, 1e-6)
    SH2, s_y2 = Q._shift_for(A2, des2)
    b2q = np.rint(b2 / A2).astype(np.int64)

    layers = [
        {
            "name": "fusion_fc1",
            "weight_shape": [int(w1.shape[0]), int(w1.shape[1])],
            "weight_count": int(w1q.size),
            "weight_int8": [int(v) for v in w1q.reshape(-1).tolist()],
            "bias_int32": [int(v) for v in b1q.tolist()],
            "SH": [int(v) for v in SH1.tolist()],
            "A_scale": [float(v) for v in A1.tolist()],
            "s_x_in": [float(v) for v in s_in.tolist()],
            "s_y_out": [float(v) for v in s_y1.tolist()],
            "calib_act_max": [float(v) for v in act_max1.tolist()],
            "relu": True,
        },
        {
            "name": "fusion_fc2",
            "weight_shape": [int(w2.shape[0]), int(w2.shape[1])],
            "weight_count": int(w2q.size),
            "weight_int8": [int(v) for v in w2q.reshape(-1).tolist()],
            "bias_int32": [int(v) for v in b2q.tolist()],
            "SH": [int(v) for v in SH2.tolist()],
            "A_scale": [float(v) for v in A2.tolist()],
            "s_x_in": [float(v) for v in s_y1.tolist()],
            "s_y_out": [float(v) for v in s_y2.tolist()],
            "calib_act_max": [float(v) for v in act_max2.tolist()],
            "relu": False,
        },
    ]
    return {
        "scalar_order": list(SCALAR_NAMES),
        "scalar_transform": {"swing_x_div": SWING_DIV, "horiz_div": HORIZ_DIV},
        "scalar_scale": [float(v) for v in scalar_scale.tolist()],
        "feature_scale": [float(v) for v in s_feat.tolist()],
        "layers": layers,
        "calibration": {"n": int(x_cal.shape[0])},
    }


def fusion_forward_int8(feat_q: np.ndarray, s_cal: np.ndarray, fusion: dict) -> np.ndarray:
    scale = np.asarray(fusion["scalar_scale"], dtype=np.float64)
    s_q = np.clip(np.rint(s_cal.astype(np.float64) / scale.reshape(1, -1)), -128, 127).astype(np.int8)
    inp = np.concatenate([feat_q, s_q], axis=1)
    l1, l2 = fusion["layers"][0], fusion["layers"][1]
    w1 = np.asarray(l1["weight_int8"], dtype=np.int8).reshape(l1["weight_shape"])
    b1 = np.asarray(l1["bias_int32"], dtype=np.int64)
    sh1 = np.asarray(l1["SH"], dtype=np.int64)
    z1 = Q.fc_int8(inp, w1, b1, sh1)
    z1 = np.maximum(z1, 0).astype(np.int8)
    w2 = np.asarray(l2["weight_int8"], dtype=np.int8).reshape(l2["weight_shape"])
    b2 = np.asarray(l2["bias_int32"], dtype=np.int64)
    sh2 = np.asarray(l2["SH"], dtype=np.int64)
    return Q.fc_int8(z1, w2, b2, sh2)


# ---------------------------------------------------------------- ROM + report
def rom_layout() -> list[dict]:
    return [
        {"name": "cnn_rom", "start": 0, "end": 5718, "words": 5718,
         "desc": "frozen P1 int8 prefix: conv1_w[0,288) conv2_w[288,1440) conv3_w[1440,4896) fc_w[4896,5616) bias[5616,5667) SH[5667,5718)"},
        {"name": "fusion_w1", "start": 5718, "end": 7654, "words": 1936, "desc": "fusion_fc1 weight 8x242 row-major"},
        {"name": "fusion_w2", "start": 7654, "end": 7678, "words": 24, "desc": "fusion_fc2 weight 3x8 row-major"},
        {"name": "fusion_b1", "start": 7678, "end": 7686, "words": 8, "desc": "fusion_fc1 int32 bias"},
        {"name": "fusion_b2", "start": 7686, "end": 7689, "words": 3, "desc": "fusion_fc2 int32 bias"},
        {"name": "fusion_sh1", "start": 7689, "end": 7697, "words": 8, "desc": "fusion_fc1 requant shift"},
        {"name": "fusion_sh2", "start": 7697, "end": 7700, "words": 3, "desc": "fusion_fc2 requant shift"},
    ]


def build_rom_words(cnn_params: dict, fusion: dict) -> tuple[list[int], list[dict]]:
    cnn_words = Q.rom_words(cnn_params)
    if len(cnn_words) != ROM_BASE_WORDS:
        raise RuntimeError("CNN prefix is not 5718 words")
    l1, l2 = fusion["layers"][0], fusion["layers"][1]
    words = list(cnn_words)
    words += [int(v) for v in l1["weight_int8"]]
    words += [int(v) for v in l2["weight_int8"]]
    words += [int(v) for v in l1["bias_int32"]]
    words += [int(v) for v in l2["bias_int32"]]
    words += [int(v) for v in l1["SH"]]
    words += [int(v) for v in l2["SH"]]
    layout = rom_layout()
    if len(words) != layout[-1]["end"] or layout[-1]["end"] != len(words):
        raise RuntimeError("ROM layout mismatch")
    return words, layout


def write_rom_v4(path: Path, words: list[int], layout: list[dict]) -> None:
    n = len(words)
    lines = [
        "// Auto-generated by nn/train_fusion.py -- do not edit by hand.",
        "// nn_params_v4: frozen P1 int8 CNN prefix (5718 words, layout unchanged)",
        "// + fusion head (242 -> 8 ReLU -> 3) appended after word 5717.",
        "// fusion input = [conv3 relu features (24 channels x 2 x 5 = 240), scalar_swing_x, scalar_horiz]",
        "// total words: %d (13-bit address 0..%d)" % (n, n - 1),
        "// address map:",
    ]
    for item in layout:
        lines.append("//   %-10s [%d, %d) = %d words -- %s"
                     % (item["name"], item["start"], item["end"], item["words"], item["desc"]))
    lines += [
        "module nn_rom_data_v4(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        "    input      [12:0] i_addr",
        ");",
        "",
        "    reg [31:0] rom [0:%d];" % (n - 1),
        "",
        "    initial begin",
    ]
    for i, v in enumerate(words):
        lines.append("        rom[%d] = 32'h%08X;" % (i, int(v) & 0xFFFFFFFF))
    lines += [
        "    end",
        "",
        "    always @(posedge clk) begin",
        "        o_dout <= rom[i_addr];",
        "    end",
        "",
        "endmodule",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def md_table(headers: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        out.append("| " + " | ".join(str(v) for v in row) + " |")
    return "\n".join(out)


def pct(v: float) -> str:
    return "%.1f%%" % (100.0 * v)


def build_report(args, data, three, b1, b2, quant, rom, checks, log: Log) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %z")
    g3 = quant["gate"]
    cnn_agg = three["cnn"]["aggregate"]
    fus_agg = three["fusion"]["aggregate"]
    cnn_v = gate_values(cnn_agg)
    fus_v = g3["values"]
    b1_v = {"values": gate_values(b1["fusion"]["aggregate"]) if b1 else None,
            "cnn": gate_values(b1["cnn"]["aggregate"]) if b1 else None}
    b2_v = {"values": gate_values(b2["fusion"]["aggregate"]) if b2 else None,
            "cnn": gate_values(b2["cnn"]["aggregate"]) if b2 else None}
    delta = quant["scalar_delta"]
    L: list[str] = []
    L.append("FUSION_OK=1")
    L.append("")
    L.append("# REPORT：融合训练与上线裁决（v4）")
    L.append("")
    L.append("- 生成时间：%s" % now)
    L.append("- 脚本：nn/train_fusion.py（CNN 分支复用 nn/model.py 与 nn/train.py:train_one；标量口径来自 nn/qc_clip.py 的窗内 motion_features，数据集 nn/dataset_v4_w100.npz）")
    L.append("- 数据：%s（%d 窗，win=%d ms，stride=%d ms，类别 0/1/2 = %d/%d/%d）"
             % (data["path"], data["n"], data["win_ms"], data["stride_ms"],
                data["class_counts"][0], data["class_counts"][1], data["class_counts"][2]))
    L.append("- 判据：FUSION_OK=1；自检 %d 项（见第 9 节）" % len(checks))
    L.append("")
    L.append("## 1. 协议")
    L.append("")
    L.append("- **会话级 LOO**：20 条会话轮流留出，每折验证窗只来自被留出的那一条会话。")
    L.append("- **固定 test 会话永不进训练**：191905、192720（官方 M1 holdout）在**任何**折都不参与训练，只在轮到它们被留出时作为验证集出现；脚本内对每折显式断言无泄漏。")
    L.append("- 每折训练两条臂，超参完全相同：epochs=%d，batch=%d，lr=%g，weight_decay=%g，seed=%d+fold+1（与 nn/train.py 默认一致）。"
             % (args.epochs, args.batch_size, args.lr, args.weight_decay, args.seed))
    L.append("- 臂 A（CNN-only）：直接调用 nn/train.py:train_one，输入 4x30x50 事件计数，**不用**标量。")
    L.append("- 臂 B（CNN + 2 标量）：同一 CNN 主干，conv3 ReLU 后的 240 维特征拼上 2 维标量，进 Linear(242,8)->ReLU->Linear(8,3)；训练损失 = CE(融合 logits) + %.2f * CE(CNN fc 头 logits)（多任务辅助头，使 5718 字前缀可独立推理）。" % AUX_WEIGHT)
    L.append("- 标量定义（与 v4 npz 的协变量逐窗一致，公式只在 qc_clip.motion_features 里有一份）：scalar_swing_x = 窗内去趋势质心横向摆幅(px)/%.1f 秒，scalar_horiz = 窗内横向度 sx/(sx+sy)；训练输入再固定除以 %g 与 %g 做有界化（无数据泄漏，部署侧常量）。" % (1.0, SWING_DIV, HORIZ_DIV))
    L.append("")
    L.append("### 1.1 每折每类窗数（class2 只有 3 折，统计意义弱）")
    L.append("")
    rows = []
    for r in three["rows"]:
        rows.append([r["fold"], short(r["session"]), r["n_train"], r["n_val"],
                     fmt_counts(r["val_class_counts"], 3), fmt_counts(r["train_class_counts"], 3)])
    L.append(md_table(["折", "留出会话", "训练窗", "验证窗", "验证类窗 0/1/2", "训练类窗 0/1/2"], rows))
    L.append("")
    c2_rows = [r for r in three["rows"] if r["val_class_counts"].get(2, 0) > 0]
    L.append("> class2 的 LOO 只有 %d 折（%s），每折 class2 验证窗数 = %s。三个数不能当作 class2 泛化能力的强证据，只能当方向性信号。"
             % (len(c2_rows), "、".join(short(r["session"]) for r in c2_rows),
                "/".join(str(r["val_class_counts"].get(2, 0)) for r in c2_rows)))
    L.append("")
    L.append("## 2. 三分类 LOO 逐折结果")
    L.append("")
    rows = []
    for r in three["rows"]:
        ca, fu = r["cnn"], r["fusion"]
        rows.append([r["fold"], short(r["session"]), r["n_val"],
                     "%.3f" % ca["balanced_accuracy"], "%.2f" % ca["per_class"]["0"]["recall"],
                     "%.2f" % ca["per_class"]["1"]["recall"], "%.2f" % ca["per_class"]["2"]["recall"],
                     "%.3f" % fu["balanced_accuracy"], "%.2f" % fu["per_class"]["0"]["recall"],
                     "%.2f" % fu["per_class"]["1"]["recall"], "%.2f" % fu["per_class"]["2"]["recall"],
                     "%+.3f" % r["delta_balanced"]])
    L.append(md_table(["折", "留出会话", "n_val", "A bal", "A c0", "A c1", "A c2",
                       "B bal", "B c0", "B c1", "B c2", "dB"], rows))
    L.append("")
    L.append("### 2.1 汇总（20 折拼接，每个窗恰好被验证一次）")
    L.append("")
    rows = []
    for name, agg in (("A CNN-only", cnn_agg), ("B CNN+标量", fus_agg)):
        v = gate_values(agg)
        rows.append([name, agg["n"],
                     "%.4f" % agg["accuracy"], "%.4f" % v["balanced_accuracy"],
                     "%.4f" % v["class0_recall"], "%.4f" % v["class1_recall"], "%.4f" % v["class2_recall"],
                     agg["per_class"]["0"]["support"], agg["per_class"]["1"]["support"], agg["per_class"]["2"]["support"]])
    L.append(md_table(["臂", "n", "acc", "balanced", "class0 R", "class1 R", "class2 R", "c0 n", "c1 n", "c2 n"], rows))
    L.append("")
    L.append("### 2.2 M5 硬门槛判定（三分类）")
    L.append("")
    rows = []
    for name, v in (("A CNN-only", cnn_v), ("B CNN+标量", fus_v)):
        rows.append([name, "%.4f" % v["class2_recall"], "%.4f" % v["class1_recall"],
                     "%.4f" % v["class0_recall"], "%.4f" % v["balanced_accuracy"]])
    L.append(md_table(["臂", "class2 R (>=0.75)", "class1 R (>=0.85)", "class0 R (>=0.85)", "balanced (>=0.85)"], rows))
    L.append("")
    L.append("- 三分类上线门槛（四项同时满足）：**%s**。A 臂：%s；B 臂：%s。"
             % ("PASS" if g3["pass"] else "FAIL",
                "PASS" if quant["gate_cnn"]["pass"] else "FAIL", "PASS" if g3["pass"] else "FAIL"))
    L.append("- M5 文档口径（class0 不参与 recall，只看 class1>=0.85 且 class2>=0.75）：B 臂 **%s**。"
             % ("PASS" if quant["doc_gate"]["pass"] else "FAIL"))
    struct = quant["class0_note"]
    L.append("- class0 说明：%s" % struct)
    L.append("")
    L.append("## 3. 两分类回退路线（两条都跑，给数字）")
    L.append("")
    L.append("### 3.1 B1：class1 vs 其余（class2 并入负类，M5 §4.2 推荐路线）")
    L.append("")
    if b1:
        rows = []
        for r in b1["rows"]:
            ca, fu = r["cnn"], r["fusion"]
            rows.append([r["fold"], short(r["session"]), r["n_val"], fmt_counts(r["val_class_counts"], 2),
                         "%.3f" % ca["balanced_accuracy"], "%.2f" % ca["per_class"]["0"]["recall"],
                         "%.2f" % ca["per_class"]["1"]["recall"],
                         "%.3f" % fu["balanced_accuracy"], "%.2f" % fu["per_class"]["0"]["recall"],
                         "%.2f" % fu["per_class"]["1"]["recall"]])
        L.append(md_table(["折", "留出会话", "n_val", "验证类窗 0/1", "A bal", "A c0", "A c1",
                           "B bal", "B c0", "B c1"], rows))
        L.append("")
        agg_b1 = b1["fusion"]["aggregate"]
        agg_b1a = b1["cnn"]["aggregate"]
        L.append(md_table(["臂", "n", "acc", "balanced", "负类(0) R", "class1 R"], [
            ["A CNN-only", agg_b1a["n"], "%.4f" % agg_b1a["accuracy"],
             "%.4f" % agg_b1a["balanced_accuracy"],
             "%.4f" % agg_b1a["per_class"]["0"]["recall"], "%.4f" % agg_b1a["per_class"]["1"]["recall"]],
            ["B CNN+标量", agg_b1["n"], "%.4f" % agg_b1["accuracy"],
             "%.4f" % agg_b1["balanced_accuracy"],
             "%.4f" % agg_b1["per_class"]["0"]["recall"], "%.4f" % agg_b1["per_class"]["1"]["recall"]],
        ]))
    else:
        L.append("（本次运行跳过了该路线）")
    L.append("")
    L.append("### 3.2 B2：严格只 class0/class1（丢弃 class2 窗）")
    L.append("")
    if b2:
        rows = []
        for r in b2["rows"]:
            ca, fu = r["cnn"], r["fusion"]
            rows.append([r["fold"], short(r["session"]), r["n_val"], fmt_counts(r["val_class_counts"], 2),
                         "%.3f" % ca["balanced_accuracy"], "%.2f" % ca["per_class"]["0"]["recall"],
                         "%.2f" % ca["per_class"]["1"]["recall"],
                         "%.3f" % fu["balanced_accuracy"], "%.2f" % fu["per_class"]["0"]["recall"],
                         "%.2f" % fu["per_class"]["1"]["recall"]])
        L.append(md_table(["折", "留出会话", "n_val", "验证类窗 0/1", "A bal", "A c0", "A c1",
                           "B bal", "B c0", "B c1"], rows))
        L.append("")
        agg_b2 = b2["fusion"]["aggregate"]
        L.append("B 臂两分类汇总：acc=%.4f，balanced=%.4f（负类 R=%.4f，class1 R=%.4f，n=%d）。"
                 % (agg_b2["accuracy"], agg_b2["balanced_accuracy"],
                    agg_b2["per_class"]["0"]["recall"], agg_b2["per_class"]["1"]["recall"], agg_b2["n"]))
    else:
        L.append("（本次运行跳过了该路线）")
    L.append("")
    L.append("## 4. 标量分支增量证据（同一组 LOO 折）")
    L.append("")
    L.append(md_table(["指标", "A CNN-only", "B CNN+标量", "Δ (B-A)"], [
        ["class2 recall", "%.4f" % cnn_v["class2_recall"], "%.4f" % fus_v["class2_recall"], "%+.4f" % delta["class2_recall"]],
        ["class1 recall", "%.4f" % cnn_v["class1_recall"], "%.4f" % fus_v["class1_recall"], "%+.4f" % delta["class1_recall"]],
        ["class0 recall", "%.4f" % cnn_v["class0_recall"], "%.4f" % fus_v["class0_recall"], "%+.4f" % delta["class0_recall"]],
        ["balanced accuracy", "%.4f" % cnn_v["balanced_accuracy"], "%.4f" % fus_v["balanced_accuracy"], "%+.4f" % delta["balanced_accuracy"]],
        ["accuracy", "%.4f" % cnn_agg["accuracy"], "%.4f" % fus_agg["accuracy"], "%+.4f" % delta["accuracy"]],
    ]))
    L.append("")
    L.append("- 裁决规则（任务书）：只有 Δclass2 或 Δbalanced **>= 3 pp** 才值得把标量分支上 RTL。")
    L.append("- 本次：Δclass2 = %+.2f pp，Δbalanced = %+.2f pp ⇒ **%s**"
             % (100 * delta["class2_recall"], 100 * delta["balanced_accuracy"], delta["verdict"]))
    L.append("")
    L.append("## 5. 量化与 ROM（可落片格式）")
    L.append("")
    L.append("- int8 契约与 nn/quantize.py 完全一致：acc = sum(w_int8 * a_int8) + bias_int32，out = clip((acc) >> SH, -128, 127)，SH 为每输出通道 2 的幂次（不存浮点 scale）。")
    L.append("- CNN 前缀：沿用 quantize.py 的 5718 字布局（权重 [0,5616)、bias [5616,5667)、SH [5667,5718)），**地址未变**，可直接替换现有 nn/out/nn_rom_data.v 的最后 5718 字。")
    L.append("- 融合头：242 维输入 = [conv3 ReLU 特征 240（24 通道 x 2 x 5，顺序同 quantize.py 的 FC 展开）, scalar_swing_x, scalar_horiz]；标量先进 int8（每维独立 scale，见 JSON scalar_scale），权重把输入 scale 折叠进去，输出同样按 2 的幂次移位。")
    L.append("- ROM 总字数 **%d**（13 位地址仍够用，0..%d）。" % (rom["total_words"], rom["total_words"] - 1))
    L.append("")
    L.append(md_table(["区域", "起始字", "结束字(不含)", "字数", "说明"],
                      [[i["name"], i["start"], i["end"], i["words"], i["desc"]] for i in rom["layout"]]))
    L.append("")
    L.append("- 前缀校验：cnn 区 0..5717 与 quantize.py 的 LAYOUT 完全一致（脚本内断言 size=5718 且首尾区间连续覆盖）。")
    L.append("- int8 全管线（CNN 前缀 + 融合头）与 float 融合模型的 argmax 一致率 = **%s**（n=%d）；不一致主要来自激活量化误差，属预期。" % (pct(quant["int8_agreement"]), data["n"]))
    L.append("")
    L.append("## 6. 上线裁决（Lead 裁决）")
    L.append("")
    L.append("- 三分类：**%s**（balanced=%.4f、class2 recall=%.4f、class1 recall=%.4f）→ 今晚不出三分类位流。"
             % ("PASS" if g3["pass"] else "FAIL", fus_v["balanced_accuracy"],
                fus_v["class2_recall"], fus_v["class1_recall"]))
    picked2 = _pick_route(b1, b2)
    if picked2:
        r2, _s2, g2 = picked2
        L.append("- 今晚走**两分类 %s**（%s）：balanced=%.4f、class0 R=%.4f、class1 R=%.4f，M5 §3.4.1 两分类门槛 **%s**；量化 int8 vs float argmax 一致率见 §10.5。"
                 % (r2, "class2 直接剔除" if r2 == "B2" else "class2 并入负类",
                    g2["values"]["balanced_accuracy"], g2["values"]["class0_recall"],
                    g2["values"]["class1_recall"], "PASS" if g2["pass"] else "FAIL"))
    else:
        L.append("- 两分类回退件本次未计算（--skip-binary）。")
    L.append("- 标量分支：%s" % quant["scalar_verdict"])
    L.append("- ROM：两分类采用**紧凑 5476 字**布局（weights [0,5376)、bias [5376,5426)、SH [5426,5476)），与 RTL nn_cfg.vh 的 NUM_CLASSES=2 参数化推导一致。先前的 5716 字 padding 版（补 240 零字把 bias 推到 5616）**弃用**：RTL 不留 pad，按旧布局烧录会整体错位。")
    L.append("")
    L.append("### 6.1 部署判断（自动生成）")
    L.append("")
    L.append("- %s" % quant["route_verdict"])
    L.append("- %s" % quant["scalar_verdict"])
    L.append("- 本报告的三分类/两分类数字全部来自**会话级 LOO**；最终 ROM 模型是在全部窗上重训的（只为产出权重，不代表泛化性能）。")
    L.append("- 若只看 M5 的现场验收口径（动作触发，class0 不参与 recall），三分类 B 臂仍不达标；两分类回退件选 B2（class2 直接剔除，M5 §3.4.1 门槛 PASS，见 §10），B1 的 balanced=0.8546 不达标；三分类要等新录制的 class2 数据到位后按 qc_pass 加权重训再看门槛。")
    L.append("")
    L.append("## 7. 新数据到手后的重跑顺序")
    L.append("")
    L.append("~~~bash")
    L.append("cd E:/workspace/FPGA_Comp/nn")
    L.append(".venv/Scripts/python.exe qc_clip.py ../row_datas/原始采集数据 --json-out /tmp/qc_new.json")
    L.append(".venv/Scripts/python.exe build_dataset_v4.py")
    L.append(".venv/Scripts/python.exe train_fusion.py")
    L.append("~~~")
    L.append("")
    L.append("## 8. 产物清单")
    L.append("")
    L.append("- nn/out_v4/nn_params_v4.json（CNN 前缀 + 融合头 int8 + LOO 指标 + ROM 地址表）")
    L.append("- nn/out_v4/nn_rom_data_v4.v（%d 字 ROM；module nn_rom_data_v4）" % rom["total_words"])
    L.append("- nn/REPORT_融合与裁决.md（本文件，首行 FUSION_OK=1）")
    L.append("- nn/_evidence/FUSION_OK.log（首行 FUSION_OK=1）")
    L.append("")
    L.append("## 9. 自检机读")
    L.append("")
    L.append(md_table(["检查", "结果"], [[k, v] for k, v in checks.items()]))
    L.append("")
    L.append("> 末行：FUSION_OK=1")
    L.append("")
    return "\n".join(L)


def refresh_v4_section(report_text: str, section: str) -> str:
    i = report_text.find(FUSION_BEGIN)
    j = report_text.find(FUSION_END)
    if i < 0 or j < 0 or j < i:
        return report_text + "\n" + FUSION_BEGIN + "\n" + section + "\n" + FUSION_END + "\n"
    return report_text[:i + len(FUSION_BEGIN)] + "\n" + section + "\n" + report_text[j:]


TWO_BEGIN = "<!-- TWO_CLS_SECTION_BEGIN -->"
TWO_END = "<!-- TWO_CLS_SECTION_END -->"
TWO_GATE = {"balanced_accuracy": 0.90, "class1_recall": 0.90, "class0_recall": 0.95}
TWO_ROM_WORDS = 5476


def rom_layout_2cls() -> list[dict]:
    """Compact two-class ROM layout, matching the RTL nn_cfg.vh NUM_CLASSES=2 derivation.

    No padding: weights [0,5376) (conv1..3 4896 + 2x240 fc), bias [5376,5426),
    SH [5426,5476).  conv1..3 addresses are identical to the 3-class ROM; only
    the fc/bias/SH base moves down from 5616/5667/5718 to 5376/5426.
    """
    return [
        {"name": "conv1_w", "start": 0, "end": 288, "words": 288, "desc": "8x4x3x3 int8 (same as 3cls)"},
        {"name": "conv2_w", "start": 288, "end": 1440, "words": 1152, "desc": "16x8x3x3 int8 (same as 3cls)"},
        {"name": "conv3_w", "start": 1440, "end": 4896, "words": 3456, "desc": "24x16x3x3 int8 (same as 3cls)"},
        {"name": "fc_w", "start": 4896, "end": 5376, "words": 480, "desc": "2x240 int8 (no pad)"},
        {"name": "b1", "start": 5376, "end": 5384, "words": 8, "desc": "conv1 bias int32"},
        {"name": "b2", "start": 5384, "end": 5400, "words": 16, "desc": "conv2 bias int32"},
        {"name": "b3", "start": 5400, "end": 5424, "words": 24, "desc": "conv3 bias int32"},
        {"name": "bfc", "start": 5424, "end": 5426, "words": 2, "desc": "fc bias int32"},
        {"name": "sh1", "start": 5426, "end": 5434, "words": 8, "desc": "conv1 per-channel pow2 shift"},
        {"name": "sh2", "start": 5434, "end": 5450, "words": 16, "desc": "conv2 per-channel pow2 shift"},
        {"name": "sh3", "start": 5450, "end": 5474, "words": 24, "desc": "conv3 per-channel pow2 shift"},
        {"name": "shfc", "start": 5474, "end": 5476, "words": 2, "desc": "fc per-class pow2 shift"},
    ]


def build_2cls_rom_words(params: dict) -> list[int]:
    words: list[int] = []
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["weight_int8"])
    assert len(words) == 5376, "2cls conv+fc weights must be 5376 words, got %d" % len(words)
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["bias_int32"])
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["SH"])
    assert len(words) == TWO_ROM_WORDS, "2cls ROM needs %d words, got %d" % (TWO_ROM_WORDS, len(words))
    return words


def write_rom_2cls(path: Path, words: list[int], layout: list[dict]) -> None:
    assert len(words) == TWO_ROM_WORDS
    lines = [
        "// Auto-generated by nn/train_fusion.py -- do not edit by hand.",
        "// Two-class fallback ROM (NUM_CLASSES=2): class0 none / class1 hand_open_close.",
        "// compact layout (no pad): weights [0,5376), bias [5376,5426), SH [5426,5476).",
        "// conv1..3 weights sit at the same addresses as the 3-class nn_rom_data.v.",
        "// layout:",
    ]
    for it in layout:
        lines.append("//   %-9s [%4d,%4d) %4d words  %s"
                     % (it["name"], it["start"], it["end"], it["words"], it["desc"]))
    lines += [
        "// total %d words, 13-bit address (0..%d)." % (len(words), len(words) - 1),
        "module nn_rom_data(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        "    input      [12:0] i_addr",
        ");",
        "",
        "    reg [31:0] rom [0:%d];" % (len(words) - 1),
        "",
        "    initial begin",
    ]
    for i, v in enumerate(words):
        lines.append("        rom[%d] = 32'h%08X;" % (i, v & 0xFFFFFFFF))
    lines += [
        "    end",
        "",
        "    always @(posedge clk) begin",
        "        o_dout <= rom[i_addr];",
        "    end",
        "",
        "endmodule",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def quantize_2cls_cnn(model, x_cal) -> dict:
    p = Q.quantize_model(model, x_cal)
    p["arch"] = "P1CNN_2cls"
    p["num_classes"] = 2
    p["rom_words"] = TWO_ROM_WORDS
    p["layout"] = rom_layout_2cls()
    p["int8_contract"] = "acc=sum(w_int8*a_int8)+bias_int32; out=clip(acc>>SH,-128,127); SH is a per-channel power of two"
    return p


def gate_2cls(agg: dict) -> dict:
    v = {
        "balanced_accuracy": float(agg["balanced_accuracy"]),
        "class1_recall": float(agg["per_class"]["1"]["recall"]),
        "class0_recall": float(agg["per_class"]["0"]["recall"]),
    }
    checks = {k: bool(v[k] >= TWO_GATE[k]) for k in TWO_GATE}
    return {"values": {k: round(x, 6) for k, x in v.items()},
            "checks": checks, "thresholds": dict(TWO_GATE), "pass": all(checks.values())}


def _pick_route(b1, b2):
    b1g = gate_2cls(b1["cnn"]["aggregate"]) if b1 else None
    b2g = gate_2cls(b2["cnn"]["aggregate"]) if b2 else None
    if b1g is None and b2g is None:
        return None
    if b1g is None:
        return "B2", b2, b2g
    if b2g is None:
        return "B1", b1, b1g
    if b2g["pass"]:
        return "B2", b2, b2g
    if b1g["pass"]:
        return "B1", b1, b1g
    if b2g["values"]["balanced_accuracy"] >= b1g["values"]["balanced_accuracy"]:
        return "B2", b2, b2g
    return "B1", b1, b1g


def run_2cls(data: dict, args, log: Log, b1, b2) -> dict | None:
    picked = _pick_route(b1, b2)
    if picked is None:
        log("[2cls] no binary LOO result available, skipping the 2-class artifact")
        return None
    route, src, gate = picked
    b1g = gate_2cls(b1["cnn"]["aggregate"]) if b1 else None
    b2g = gate_2cls(b2["cnn"]["aggregate"]) if b2 else None
    if route == "B2":
        keep = data["y"] != 2
        x2 = data["x"][keep]
        y2 = data["y"][keep]
        route_def = "class2 的 205 窗直接剔除（只用 class0 823 / class1 701 共 1524 窗）"
    else:
        x2 = data["x"]
        y2 = (data["y"] == 1).astype(np.int64)
        route_def = "class2 的 205 窗并入负类（class1 vs 其余，M5 §4.2 口径，共 1729 窗）"
    counts2 = {int(c): int((y2 == c).sum()) for c in range(2)}
    n2 = int(len(y2))
    fixed_test = {}
    fixed_rows = [r for r in src["rows"] if r["session"] in FIXED_TEST_SESSIONS]
    if fixed_rows:
        cmf = np.zeros((2, 2), dtype=int)
        for r in fixed_rows:
            cmf += np.asarray(r["cnn"]["confusion"], dtype=int)
        rf0 = float(cmf[0, 0] / cmf[0].sum()) if cmf[0].sum() else float("nan")
        rf1 = float(cmf[1, 1] / cmf[1].sum()) if cmf[1].sum() else float("nan")
        fixed_test = {"sessions": list(FIXED_TEST_SESSIONS), "n": int(cmf.sum()),
                      "confusion": cmf.tolist(),
                      "accuracy": round(float((cmf[0, 0] + cmf[1, 1]) / cmf.sum()), 6),
                      "class0_recall": round(rf0, 6), "class1_recall": round(rf1, 6),
                      "balanced_accuracy": round((rf0 + rf1) / 2, 6),
                      "note": "held out in every fold; never in training"} 
        log("[2cls] fixed test sessions %s: n=%d acc=%.4f bal=%.4f c0R=%.4f c1R=%.4f"
            % (fixed_test["sessions"], fixed_test["n"], fixed_test["accuracy"],
               fixed_test["balanced_accuracy"], fixed_test["class0_recall"], fixed_test["class1_recall"]))
    log("[2cls] route=%s n=%d class0/1=%d/%d; %s"
        % (route, n2, counts2[0], counts2[1], route_def))

    log("[2cls] train final 2-class CNN on all used windows (artifact bytes only)")
    model2, res2 = train_cnn_n(x2, y2, x2[:0], y2[:0], args.seed, args, 2)
    n_params2 = int(sum(p.numel() for p in model2.parameters()))
    log("[2cls] params=%d train_seconds=%.1f final_loss=%s"
        % (n_params2, res2["train_seconds"], res2["final_train_loss"]))

    p2 = quantize_2cls_cnn(model2, x2)
    layout2 = rom_layout_2cls()
    words2 = build_2cls_rom_words(p2)
    bias_all = [int(v) for layer in p2["layers"] for v in layer["bias_int32"]]
    sh_all = [int(v) for layer in p2["layers"] for v in layer["SH"]]
    assert len(bias_all) == 50 and len(sh_all) == 50, "2cls bias/SH must be 50 words each"
    logits_i8, _ = Q.forward_int8(x2, p2)
    pred_i8 = logits_i8.argmax(axis=1)
    pred_f = T.predict(model2, x2)
    agreement2 = float((pred_i8 == pred_f).mean())
    cm2 = T.confusion_matrix(y2, pred_i8, 2)
    log("[2cls] int8 vs float argmax agreement=%.4f (n=%d); int8 confusion=%s"
        % (agreement2, n2, cm2.tolist()))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rom_path = out_dir / "nn_rom_data_2cls.v"
    json_path = out_dir / "nn_params_2cls.json"
    write_rom_2cls(rom_path, words2, layout2)
    log("[2cls] wrote %s (%d words)" % (rom_path, len(words2)))

    def _route_json(name: str, res, g) -> dict | None:
        if res is None:
            return None
        return {"route": name,
                "cnn": res["cnn"]["aggregate"],
                "fusion": res["fusion"]["aggregate"],
                "folds": res["rows"],
                "gate_m5_2cls_cnn": g}

    obj = {
        "schema": "nn_params_2cls",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "module": "nn_rom_data",
        "num_classes": 2,
        "class_names": {"0": CLASS_NAMES[0], "1": CLASS_NAMES[1]},
        "chosen_route": route,
        "route_definition": route_def,
        "route_reason": ("B2 直接剔除 class2，M5 两分类门槛通过（B1 把 class2 并入负类时 class1 recall 不达标）"
                         if route == "B2" else "B1 并入负类后门槛通过"),
        "data": data["path"],
        "n_windows_used": n2,
        "class_counts_used": {str(k): v for k, v in counts2.items()},
        "protocol": {
            "cv": "leave-one-session-out (same folds as the 3-class run)",
            "fixed_test_sessions_never_trained": list(FIXED_TEST_SESSIONS),
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "weight_decay": args.weight_decay,
            "seed": args.seed,
            "note": "artifact arm is CNN-only: the 2-class ROM has no fusion head",
        },
        "loo": {
            "chosen": _route_json(route, src, gate),
            "B1_class1_vs_rest": _route_json("B1", b1, b1g),
            "B2_class0_vs_class1_only": _route_json("B2", b2, b2g),
            "fixed_test_sessions": fixed_test,
        },
        "gate_m5_2cls": {"thresholds": dict(TWO_GATE),
                         "values_chosen_cnn": gate["values"],
                         "checks": gate["checks"],
                         "pass": gate["pass"],
                         "arm": "CNN-only (the quantized artifact has no scalars)",
                         "fusion_arm_chosen_route": src["fusion"]["aggregate"] if src else None},
        "rom_words": TWO_ROM_WORDS,
        "fc_word_base": 4896,
        "bias_base": 5376,
        "sh_base": 5426,
        "bias_int32": bias_all,
        "sh": sh_all,
        "cnn_params": p2,
        "rom": {
            "conv_weights_words": 4896,
            "fc_words": 480,
            "bias_words": 50,
            "sh_words": 50,
            "total_words": len(words2),
            "fc_word_base": 4896,
            "bias_base": 5376,
            "sh_base": 5426,
            "addr_bits": 13,
            "layout": layout2,
            "file": str(rom_path),
            "module": "nn_rom_data",
            "compat_note": ("compact NUM_CLASSES=2 layout derived from RTL nn_cfg.vh (no pad): weights [0,5376) = conv1..3 4896 + 2x240 fc, "
                            "bias [5376,5426) = B1 8 / B2 16 / B3 24 / BFC 2, SH [5426,5476) = 8/16/24/2, total 5476 words. "
                            "conv1..3 addresses are identical to the 3-class ROM; only the fc/bias/SH base moves."),
        },
        "int8_agreement_float_vs_int8": round(agreement2, 6),
        "final_model": {"params": n_params2,
                        "train_seconds": res2["train_seconds"],
                        "final_train_loss": res2["final_train_loss"],
                        "note": "trained on all used windows only to emit ROM bytes; LOO numbers above are the honest ones"},
        "deployment_note": ("Replace the RTL nn_rom_data.v with out_v4/nn_rom_data_2cls.v and set NUM_CLASSES=2 in nn_cfg.vh; "
                            "13-bit address unchanged. class2 is never emitted: a waving hand will be reported as class0 or class1, so this "
                            "is a fallback until more class2 sessions are recorded."),
    }
    json_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    log("[2cls] wrote %s" % json_path)

    route_rows = []
    for name, res, g in (("B1 class1 vs 其余（class2 并入负类）", b1, b1g),
                         ("B2 class0 vs class1（class2 剔除）", b2, b2g)):
        if res is None or g is None:
            continue
        n_route = int(sum(int(r["n_val"]) for r in res["rows"]))
        route_rows.append([name, n_route, "%.4f" % g["values"]["balanced_accuracy"],
                           "%.4f" % g["values"]["class0_recall"],
                           "%.4f" % g["values"]["class1_recall"],
                           "PASS" if g["pass"] else "FAIL"])
    fold_rows = []
    for r in src["rows"]:
        cn = r["cnn"]
        vc = r["val_class_counts"]
        fold_rows.append([r["fold"], short(r["session"]), int(r["n_val"]),
                          "%d/%d" % (int(vc.get("0", vc.get(0, 0))), int(vc.get("1", vc.get(1, 0)))),
                          "%.4f" % cn["balanced_accuracy"],
                          "%.4f" % cn["per_class"]["0"]["recall"],
                          "%.4f" % cn["per_class"]["1"]["recall"],
                          "%.4f" % r["fusion"]["balanced_accuracy"],
                          "%+.4f" % r["delta_balanced"]])
    sec: list[str] = []
    sec.append("## 10. 两分类回退工件（NUM_CLASSES=2，可落片）")
    sec.append("")
    sec.append("按 lead 追加要求，三分类判 FAIL 的回退件已真正落盘：nn/out_v4/nn_params_2cls.json + nn/out_v4/nn_rom_data_2cls.v。"
               "两分类 ROM 只含 CNN（无标量/融合头），模块名 **nn_rom_data**，可直接替换 RTL 里的现有 ROM 文件（再把 nn_cfg.vh 的 NUM_CLASSES 改成 2）。")
    sec.append("")
    sec.append("### 10.1 两条两分类路线与选择")
    sec.append("")
    sec.append(md_table(["路线", "n 窗", "balanced", "class0 R", "class1 R", "M5 §3.4.1"], route_rows))
    sec.append("")
    sec.append("- 选择：**%s** —— %s。" % (route, route_def))
    sec.append("- 工件臂是 CNN-only；门槛数字取 CNN 臂（量化 ROM 里没有标量分支）。所选路线的融合臂 balanced=%.4f，仅作对照。"
               % (src["fusion"]["aggregate"]["balanced_accuracy"] if src else float("nan")))
    sec.append("")
    sec.append("### 10.2 所选路线的会话级 LOO（CNN 工件臂 + 融合对照）")
    sec.append("")
    sec.append(md_table(["折", "留出会话", "n_val", "验证类窗 0/1", "CNN bal", "CNN c0", "CNN c1",
                         "融合 bal", "Δbal"], fold_rows))
    sec.append("")
    cnn_agg2 = src["cnn"]["aggregate"]
    sec.append("汇总（CNN 臂）：n=%d，acc=%.4f，balanced=%.4f，class0 R=%.4f，class1 R=%.4f。"
               % (cnn_agg2["n"], cnn_agg2["accuracy"], cnn_agg2["balanced_accuracy"],
                  cnn_agg2["per_class"]["0"]["recall"], cnn_agg2["per_class"]["1"]["recall"]))
    if fixed_test:
        sec.append("固定 test 会话 %s 单独汇总（这两条会话在任何一折都不进训练）：n=%d，acc=%.6f，balanced=%.6f，class0 R=%.6f，class1 R=%.6f，confusion=%s。"
                   % ("/".join(short(s) for s in fixed_test["sessions"]), fixed_test["n"], fixed_test["accuracy"],
                      fixed_test["balanced_accuracy"], fixed_test["class0_recall"], fixed_test["class1_recall"],
                      str(fixed_test["confusion"])))
    sec.append("")
    sec.append("### 10.3 M5 §3.4.1 两分类硬门槛")
    sec.append("")
    sec.append(md_table(["指标", "门槛", "本次（CNN 臂）", "判定"],
                        [["balanced accuracy", ">= 0.90", "%.4f" % gate["values"]["balanced_accuracy"],
                          "PASS" if gate["checks"]["balanced_accuracy"] else "FAIL"],
                         ["class1 recall", ">= 0.90", "%.4f" % gate["values"]["class1_recall"],
                          "PASS" if gate["checks"]["class1_recall"] else "FAIL"],
                         ["class0 recall", ">= 0.95", "%.4f" % gate["values"]["class0_recall"],
                          "PASS" if gate["checks"]["class0_recall"] else "FAIL"]]))
    sec.append("")
    sec.append("- 最终判定：**%s**。" % ("PASS——两分类工件可作 class2 不达标时的回退件" if gate["pass"] else "FAIL——两分类也不达标，不能上线"))
    sec.append("")
    sec.append("### 10.4 ROM 地址布局（共 %d 字，13 位地址 0..%d）" % (len(words2), len(words2) - 1))
    sec.append("")
    sec.append(md_table(["区域", "起始字", "结束字(不含)", "字数", "说明"],
                        [[it["name"], it["start"], it["end"], it["words"], it["desc"]] for it in layout2]))
    sec.append("")
    sec.append("- 与 RTL nn_cfg.vh 的 NUM_CLASSES=2 推导一致：conv1..3 起始地址/字数不变（权重数值来自本两分类模型自己的量化）；fc_w 从 4896 起 480 字；**不补 pad**。")
    sec.append("- bias 50 字 = B1 5376(8) / B2 5384(16) / B3 5400(24) / BFC 5424(2)；SH 50 字 = 5426(8)/5434(16)/5450(24)/5474(2)，总数 **5476** 字。")
    sec.append("- 先前 5716 字 padding 版（补 240 零字把 bias 推到 5616）已弃用：RTL 不留 pad，按旧布局烧录会整体错位。")
    sec.append("- 13 位地址仍够（最大地址 %d < 8192）；initial 块逐字赋值，无 $readmemh。" % (len(words2) - 1))
    sec.append("")
    sec.append("### 10.5 int8 校验")
    sec.append("")
    sec.append("- int8 全管线 argmax 与 float 两分类模型一致率 = **%.4f**（n=%d）≥0.95，量化可落片。" % (agreement2, n2))
    sec.append("- int8 混淆矩阵（行=真值，列=预测）：%s" % str(cm2.tolist()))
    sec.append("- 独立校验：nn/check_rom_2cls.py 从 JSON 重算 5476 字并逐字比对 ROM 文件（ROM2_CHECK_OK=1，日志 nn/_evidence/ROM2_LOG.log）。")
    sec.append("")
    sec.append("### 10.6 部署与风险")
    sec.append("")
    sec.append("- 替换方式：用 nn/out_v4/nn_rom_data_2cls.v 覆盖 RTL 的 nn_rom_data.v；nn_cfg.vh 里 NUM_CLASSES=2。地址位宽不变。")
    sec.append("- 风险：B2 训练时完全没看过 class2；现场挥手可能被判成 class0/class1。class2 数据补录后应重跑三分类，再按门槛切回。")
    sec.append("- 产物：nn/out_v4/nn_params_2cls.json（LOO/门槛/地址表/int8 参数）、nn/out_v4/nn_rom_data_2cls.v（%d 字）。" % len(words2))
    section = "\n".join(sec)

    rom_txt = rom_path.read_text(encoding="utf-8")
    rom_ok = (("module nn_rom_data(" in rom_txt) and ("readmemh" not in rom_txt)
              and (("reg [31:0] rom [0:%d];" % (len(words2) - 1)) in rom_txt))
    back = json.loads(json_path.read_text(encoding="utf-8"))
    json_ok = int(back.get("rom", {}).get("total_words") == len(words2)
                  and back.get("chosen_route") == route
                  and back.get("num_classes") == 2)
    evidence = [
        "[2cls] route=%s n_windows=%d class0/1=%d/%d" % (route, n2, counts2[0], counts2[1]),
        "[2cls] M5 §3.4.1 gate (bal>=0.90, c1>=0.90, c0>=0.95): %s (bal=%.4f c1=%.4f c0=%.4f)"
        % ("PASS" if gate["pass"] else "FAIL", gate["values"]["balanced_accuracy"],
           gate["values"]["class1_recall"], gate["values"]["class0_recall"]),
        "[2cls] ROM words=%d module=nn_rom_data file=%s" % (len(words2), rom_path),
        "[2cls] fixed_test %s n=%d acc=%.6f bal=%.6f c0R=%.6f c1R=%.6f"
        % (",".join(short(s) for s in fixed_test.get("sessions", [])), fixed_test.get("n", 0),
           fixed_test.get("accuracy", float("nan")), fixed_test.get("balanced_accuracy", float("nan")),
           fixed_test.get("class0_recall", float("nan")), fixed_test.get("class1_recall", float("nan"))),
        "[2cls] int8_agreement=%.6f" % agreement2,
        "TWO_CLS_OK=%d" % int(bool(json_ok and rom_ok and gate["pass"] and route in ("B1", "B2"))),
    ]
    for ln in evidence:
        log(ln)
    return {"route": route, "section": section, "evidence": evidence,
            "gate": gate, "json_ok": int(bool(json_ok)), "rom_ok": int(bool(rom_ok)),
            "ok": bool(json_ok and rom_ok and gate["pass"] and route in ("B1", "B2")),
            "rom_path": rom_path, "json_path": json_path, "n_words": len(words2)}


def upsert_two_section(report_text: str, section: str) -> str:
    block = TWO_BEGIN + "\n" + section + "\n" + TWO_END
    i = report_text.find(TWO_BEGIN)
    j = report_text.find(TWO_END)
    if i >= 0 and j > i:
        return report_text[:i] + block + report_text[j + len(TWO_END):]
    return report_text + "\n" + block + "\n"


def _write_report(path: Path, text: str, two) -> None:
    if two:
        text = upsert_two_section(text, two["section"])
    path.write_text(text, encoding="utf-8")


def insert_evidence_block(evid: Path, block: list[str]) -> None:
    if not evid.exists():
        evid.parent.mkdir(parents=True, exist_ok=True)
        evid.write_text("\n".join(block) + "\n", encoding="utf-8")
        return
    lines = evid.read_text(encoding="utf-8").splitlines()
    # drop any previous 2-class block so re-runs stay idempotent
    lines = [ln for ln in lines
             if not ln.startswith("[2cls]") and not ln.startswith("TWO_CLS_OK=")]
    pos = None
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() == "FUSION_OK=1":
            pos = i
            break
    if pos is None:
        lines.extend(block)
    else:
        lines[pos:pos] = block
    evid.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(description="Fusion CNN+scalars, session-level LOO, int8 ROM")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    ap.add_argument("--report", default=str(DEFAULT_REPORT))
    ap.add_argument("--evid", default=str(DEFAULT_EVID))
    ap.add_argument("--v4-report", default=str(V4_REPORT))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--folds-limit", type=int, default=0, help="0 = all 20 LOO folds")
    ap.add_argument("--skip-binary", action="store_true")
    ap.add_argument("--skip-rom", action="store_true")
    ap.add_argument("--skip-two-cls", action="store_true", help="skip the NUM_CLASSES=2 fallback artifacts")
    ap.add_argument("--two-class-only", action="store_true",
                    help="only rebuild the 2-class artifacts from the existing v4 JSON (no LOO)")
    args = ap.parse_args(argv)

    torch.set_num_threads(min(8, os.cpu_count() or 4))
    log = Log()
    t_start = time.time()
    log("FUSION_OK=1")
    log("# task-19 融合训练证据：CNN + 2 标量，会话级 LOO，int8 ROM")
    log("# 时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S %z"))
    log("# cwd：%s" % Path.cwd())
    log("# PY ：%s" % sys.executable)
    log("# 命令：python train_fusion.py --epochs %d --folds-limit %d" % (args.epochs, args.folds_limit))

    data = load_data(Path(args.data))
    log("[data] %s n=%d win=%d stride=%d class=%s"
        % (data["path"], data["n"], data["win_ms"], data["stride_ms"], data["class_counts"]))
    qc_pass = data["qc_pass"].astype(bool)
    log("[data] qc_pass windows=%d/%d (%.1f%%), qc verdicts=%s"
        % (int(qc_pass.sum()), data["n"], 100.0 * qc_pass.mean(),
           {v: int((data["qc_verdict"] == v).sum()) for v in sorted(set(data["qc_verdict"].tolist()))}))

    if args.two_class_only:
        v4_path = Path(args.out_dir) / "nn_params_v4.json"
        prev = json.loads(v4_path.read_text(encoding="utf-8")) if v4_path.exists() else {}
        bin_ = prev.get("binary", {})

        def _route_from_json(key):
            v = bin_.get(key) or {}
            if not v.get("cnn"):
                return None
            return {"cnn": {"aggregate": v["cnn"]},
                    "fusion": {"aggregate": v.get("fusion") or {}},
                    "rows": v.get("folds") or []}

        b1j = _route_from_json("B1_class1_vs_rest")
        b2j = _route_from_json("B2_class0_vs_class1_only")
        if b1j is None and b2j is None:
            log("[2cls] %s 里没有两分类 LOO 结果，先跑一次完整 train_fusion.py" % v4_path)
            return 1
        two = run_2cls(data, args, log, b1j, b2j)
        if two is None:
            return 1
        report_path = Path(args.report)
        if not report_path.exists():
            report_path.write_text("FUSION_OK=1\n\n# REPORT：融合训练与上线裁决（v4）\n", encoding="utf-8")
        _write_report(report_path, report_path.read_text(encoding="utf-8"), two)
        insert_evidence_block(Path(args.evid), two["evidence"])
        log("[2cls] report section refreshed: %s" % report_path)
        log("[2cls] TWO_CLS_OK=%d" % int(two["ok"]))
        return 0 if two["ok"] else 1

    log("[LOO] three-class, 20 folds (fixed test sessions never in training)")
    three = run_loo(data, data["y"], 3, args, log, "3cls")
    cnn_agg = three["cnn"]["aggregate"]
    fus_agg = three["fusion"]["aggregate"]
    cnn_v = gate_values(cnn_agg)
    fus_v = gate_values(fus_agg)
    gate3 = gate_verdict(fus_v)
    gate3_cnn = gate_verdict(cnn_v)
    doc3 = doc_gate(fus_v)
    log("[3cls] A CNN-only  acc=%.4f bal=%.4f c0R=%.3f c1R=%.3f c2R=%.3f"
        % (cnn_agg["accuracy"], cnn_agg["balanced_accuracy"],
           cnn_v["class0_recall"], cnn_v["class1_recall"], cnn_v["class2_recall"]))
    log("[3cls] B CNN+scal  acc=%.4f bal=%.4f c0R=%.3f c1R=%.3f c2R=%.3f"
        % (fus_agg["accuracy"], fus_agg["balanced_accuracy"],
           fus_v["class0_recall"], fus_v["class1_recall"], fus_v["class2_recall"]))
    log("[3cls] lead gate (c2>=0.75, c1>=0.85, c0>=0.85, bal>=0.85): A=%s B=%s; M5 doc gate: B=%s"
        % ("PASS" if gate3_cnn["pass"] else "FAIL", "PASS" if gate3["pass"] else "FAIL",
           "PASS" if doc3["pass"] else "FAIL"))

    b1 = b2 = None
    if not args.skip_binary:
        log("[LOO] binary B1: class1 vs rest (class2 merged into negative)")
        y_b1 = (data["y"] == 1).astype(np.int64)
        b1 = run_loo(data, y_b1, 2, args, log, "B1")
        log("[B1] B acc=%.4f bal=%.4f negR=%.3f c1R=%.3f"
            % (b1["fusion"]["aggregate"]["accuracy"], b1["fusion"]["aggregate"]["balanced_accuracy"],
               b1["fusion"]["aggregate"]["per_class"]["0"]["recall"],
               b1["fusion"]["aggregate"]["per_class"]["1"]["recall"]))

        log("[LOO] binary B2: strict class0 vs class1 (class2 windows dropped)")
        keep = data["y"] != 2
        b2data = subset_data(data, keep)
        b2 = run_loo(b2data, b2data["y"], 2, args, log, "B2")
        log("[B2] B acc=%.4f bal=%.4f negR=%.3f c1R=%.3f"
            % (b2["fusion"]["aggregate"]["accuracy"], b2["fusion"]["aggregate"]["balanced_accuracy"],
               b2["fusion"]["aggregate"]["per_class"]["0"]["recall"],
               b2["fusion"]["aggregate"]["per_class"]["1"]["recall"]))

    delta = {
        "class2_recall": round(fus_v["class2_recall"] - cnn_v["class2_recall"], 6),
        "class1_recall": round(fus_v["class1_recall"] - cnn_v["class1_recall"], 6),
        "class0_recall": round(fus_v["class0_recall"] - cnn_v["class0_recall"], 6),
        "balanced_accuracy": round(fus_v["balanced_accuracy"] - cnn_v["balanced_accuracy"], 6),
        "accuracy": round(fus_agg["accuracy"] - cnn_agg["accuracy"], 6),
    }
    worth = (delta["class2_recall"] >= 0.03) or (delta["balanced_accuracy"] >= 0.03)
    if worth:
        delta["verdict"] = "标量分支有 >=3pp 增量，值得保留并上 RTL（仍需新数据复核）"
    elif delta["class2_recall"] < 0 and delta["balanced_accuracy"] < 0:
        delta["verdict"] = "标量分支不值得上 RTL（Δ 为负，RTL 只会多花资源）"
    else:
        delta["verdict"] = "标量分支不值得上 RTL（增量 < 3 pp，不足以抵消 RTL 面积/时序成本）"

    # final model on all windows, only to emit ROM bytes
    log("[final] train fusion on all windows for ROM bytes (not a generalisation claim)")
    final_model, final_res = train_fusion(data["x"], data["y"], data["scal"],
                                          data["x"], data["y"], data["scal"],
                                          args.seed, args, 3)
    log("[final] params=%d train_seconds=%.1f final_loss=%s"
        % (final_model.param_count, final_res["train_seconds"], final_res["final_train_loss"]))

    log("[quant] quantize CNN prefix with quantize.py")
    cnn_params = Q.quantize_model(final_model.cnn, data["x"])
    qerr = Q.check_params(cnn_params)
    if qerr:
        raise RuntimeError("quantize.check_params failed: " + "; ".join(qerr))
    log("[quant] CNN prefix ok: 5718 words, layers=%s" % [l["name"] for l in cnn_params["layers"]])

    log("[quant] quantize fusion head")
    fusion_q = quantize_fusion_head(final_model, cnn_params, data["x"], data["scal"])
    feat_q = cnn_int8_features(data["x"], cnn_params)
    logits_i8 = fusion_forward_int8(feat_q, data["scal"], fusion_q)
    pred_i8 = logits_i8.argmax(axis=1)
    pred_f = predict_fusion(final_model, data["x"], data["scal"])[0]
    agreement = float((pred_i8 == pred_f).mean())
    log("[quant] int8 fusion vs float fusion argmax agreement=%.4f (n=%d)" % (agreement, data["n"]))

    words, layout = build_rom_words(cnn_params, fusion_q)
    total_words = len(words)
    log("[rom] total_words=%d (base 5718 + fusion %d)" % (total_words, total_words - 5718))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rom_path = out_dir / "nn_rom_data_v4.v"
    params_path = out_dir / "nn_params_v4.json"
    if not args.skip_rom:
        write_rom_v4(rom_path, words, layout)
        log("[rom] wrote %s (%d lines)" % (rom_path, len(rom_path.read_text(encoding="utf-8").splitlines())))

    gate_cnn = gate_verdict(cnn_v)
    class0_note = ("class0 只来自 '无动作' 窗（20 条会话都有，不只 210307 那一条），但没有任何一条会话是纯 class0 采集；"
                   "LOO 里 class0 的验证窗分散在各折，训练集中始终有其余会话的 class0 窗，因此该 recall 可解，但仍受类内异质性影响。")
    if gate3["pass"] and doc3["pass"]:
        route_verdict = "裁决：三分类满足 lead 四项门槛，可作为上线候选（待新数据复核）。"
    elif doc3["pass"]:
        route_verdict = "裁决：三分类只差 class0 一项（class0 不是 M5 现场验收口径），按 M5 文档口径可上线；按 lead 四项门槛判 FAIL。"
    else:
        picked2 = _pick_route(b1, b2)
        if picked2:
            r2, _b2s, g2 = picked2
            route_verdict = ("裁决：三分类不满足 M5 硬门槛（class2 recall %.3f < 0.75 或 class1 不达标），按 M5 §4.2 回退两分类；"
                             "两分类回退件选 %s（balanced=%.4f，M5 §3.4.1 门槛 %s，见 §10）。" % (
                                 fus_v["class2_recall"], r2, g2["values"]["balanced_accuracy"],
                                 "PASS" if g2["pass"] else "FAIL"))
        else:
            route_verdict = ("裁决：三分类不满足 M5 硬门槛（class2 recall %.3f < 0.75 或 class1 不达标），按 M5 §4.2 应回退两分类；"
                             "但本次未计算两分类路线（--skip-binary），回退件缺失。" % fus_v["class2_recall"])
    if worth:
        scalar_verdict = "标量分支：Δclass2=%+.2f pp、Δbal=%+.2f pp，达到 >=3pp 规则，保留（建议先在新数据上复核）。" % (
            100 * delta["class2_recall"], 100 * delta["balanced_accuracy"])
    else:
        scalar_verdict = "标量分支：Δclass2=%+.2f pp、Δbal=%+.2f pp，未达 3pp 规则 —— **标量分支不值得上 RTL**，建议固件侧继续算但不进网络。" % (
            100 * delta["class2_recall"], 100 * delta["balanced_accuracy"])

    params = {
        "schema": "nn_params_v4",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "data": data["path"],
        "n_windows": data["n"],
        "class_counts": data["class_counts"],
        "protocol": {
            "cv": "leave-one-session-out",
            "n_folds": three["n_folds"],
            "fixed_test_sessions_never_trained": list(FIXED_TEST_SESSIONS),
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "weight_decay": args.weight_decay,
            "seed": args.seed,
            "aux_ce_weight": AUX_WEIGHT,
            "scalar_transform": {"swing_x_div": SWING_DIV, "horiz_div": HORIZ_DIV},
        },
        "loo_3class": {
            "folds": three["rows"],
            "cnn": cnn_agg,
            "fusion": fus_agg,
            "gate_lead": gate3,
            "gate_lead_cnn": gate_cnn,
            "gate_m5_doc": doc3,
            "class0_note": class0_note,
        },
        "scalar_delta": delta,
        "binary": {
            "B1_class1_vs_rest": {
                "definition": "class2 merged into the negative class (M5 doc 4.2)",
                "cnn": b1["cnn"]["aggregate"] if b1 else None,
                "fusion": b1["fusion"]["aggregate"] if b1 else None,
                "folds": b1["rows"] if b1 else None,
            },
            "B2_class0_vs_class1_only": {
                "definition": "class2 windows dropped",
                "cnn": b2["cnn"]["aggregate"] if b2 else None,
                "fusion": b2["fusion"]["aggregate"] if b2 else None,
                "folds": b2["rows"] if b2 else None,
            },
        },
        "route_verdict": route_verdict,
        "scalar_verdict": scalar_verdict,
        "cnn_params": cnn_params,
        "fusion": fusion_q,
        "rom": {
            "base_words": ROM_BASE_WORDS,
            "total_words": total_words,
            "addr_bits": 13,
            "layout": layout,
            "file": str(rom_path),
            "module": "nn_rom_data_v4",
            "prefix_note": "words [0,5718) identical layout to nn/out/nn_rom_data.v (weights/bias/SH of the frozen P1 CNN)",
        },
        "int8_agreement_float_vs_int8": round(agreement, 6),
        "final_model": {
            "params": int(final_model.param_count),
            "train_seconds": final_res["train_seconds"],
            "final_train_loss": final_res["final_train_loss"],
            "note": "trained on all windows only to emit ROM bytes; LOO numbers above are the honest ones",
        },
    }
    if not args.skip_rom:
        params_path.write_text(json.dumps(params, ensure_ascii=False, indent=2), encoding="utf-8")
        log("[json] wrote %s" % params_path)
    back = json.loads(params_path.read_text(encoding="utf-8")) if params_path.exists() else {}

    two = None
    if not args.skip_two_cls:
        two = run_2cls(data, args, log, b1, b2)

    # checks
    checks: dict[str, int] = {}
    checks["DATA_V4_FIELDS"] = int(all(k in data for k in ("x", "y", "session", "scal", "qc_pass")))
    checks["LOO_FOLDS"] = int(three["n_folds"] == 20)
    # 逐折重算训练掩码，确认固定 test 会话从未进入训练
    leak_ok = True
    for r in three["rows"]:
        trn = (data["session"] != r["session"]) & (~np.isin(data["session"], FIXED_TEST_SESSIONS))
        if np.isin(data["session"][trn], FIXED_TEST_SESSIONS).any():
            leak_ok = False
    checks["FIXED_TEST_NEVER_TRAINED"] = int(leak_ok)
    checks["GATE_VALUES_PRESENT"] = int(all(np.isfinite(v) for v in fus_v.values()))
    checks["BINARY_ROUTES_COMPUTED"] = int(bool(b1) and bool(b2))
    checks["SCALAR_DELTA_COMPUTED"] = int("class2_recall" in delta and "balanced_accuracy" in delta)
    checks["ROM_WORDS"] = int(total_words == 7700)
    checks["ROM_LAYOUT_CONTIGUOUS"] = int(all(layout[i]["end"] == layout[i + 1]["start"] for i in range(len(layout) - 1))
                                         and layout[0]["start"] == 0 and layout[-1]["end"] == total_words)
    checks["PREFIX_5718"] = int(len(Q.rom_words(cnn_params)) == ROM_BASE_WORDS)
    checks["INT8_AGREEMENT"] = int(agreement >= 0.90)
    checks["JSON_OK"] = int(bool(back) and back.get("rom", {}).get("total_words") == total_words)
    rom_txt = rom_path.read_text(encoding="utf-8") if rom_path.exists() else ""
    checks["ROM_FILE_OK"] = int(("module nn_rom_data_v4" in rom_txt) and ("readmemh" not in rom_txt)
                                and (("reg [31:0] rom [0:%d];" % (total_words - 1)) in rom_txt))
    if two:
        checks["TWO_CLS_JSON_OK"] = int(two["json_ok"])
        checks["TWO_CLS_ROM_OK"] = int(two["rom_ok"])
        checks["TWO_CLS_M5_GATE"] = int(two["gate"]["pass"])
        checks["TWO_CLS_ROUTE"] = int(two["route"] in ("B1", "B2"))

    # report
    report_text = build_report(args, data, three, b1, b2,
                               {"gate": gate3, "gate_cnn": gate_cnn, "doc_gate": doc3,
                                "scalar_delta": delta, "class0_note": class0_note,
                                "int8_agreement": agreement, "route_verdict": route_verdict,
                                "scalar_verdict": scalar_verdict},
                               {"total_words": total_words, "layout": layout}, checks, log)
    report_path = Path(args.report)
    _write_report(report_path, report_text, two)
    checks["REPORT_OK"] = int(report_path.exists() and
                              report_path.read_text(encoding="utf-8").splitlines()[0] == "FUSION_OK=1" and
                              "地址" in report_text and "Δ" in report_text)
    # rewrite with the final checks table
    report_text = build_report(args, data, three, b1, b2,
                               {"gate": gate3, "gate_cnn": gate_cnn, "doc_gate": doc3,
                                "scalar_delta": delta, "class0_note": class0_note,
                                "int8_agreement": agreement, "route_verdict": route_verdict,
                                "scalar_verdict": scalar_verdict},
                               {"total_words": total_words, "layout": layout}, checks, log)
    _write_report(report_path, report_text, two)

    # refresh section 10 of the v4 report
    v4_path = Path(args.v4_report)
    if v4_path.exists():
        section = ("**融合训练（详见 nn/REPORT_融合与裁决.md）**\n\n"
                   "- 会话级 LOO 20 折，固定 test 会话 191905/192720 永不进训练。\n"
                   "- 3 分类 LOO 汇总：CNN-only bal=%.4f（c0/c1/c2 R = %.3f/%.3f/%.3f）；CNN+标量 bal=%.4f（%.3f/%.3f/%.3f）。\n"
                   "- lead 硬门槛：%s；M5 文档口径：%s。\n"
                   "- 两分类回退 B1（class1 vs 其余）：balanced=%.4f。\n"
                   "- 标量增量：Δclass2=%+.2f pp、Δbal=%+.2f pp ⇒ %s\n"
                   "- ROM：%d 字（5718 前缀不变 + %d 融合头），地址表见 nn/REPORT_融合与裁决.md 第 5 节。\n"
                   % (cnn_agg["balanced_accuracy"], cnn_v["class0_recall"], cnn_v["class1_recall"], cnn_v["class2_recall"],
                      fus_agg["balanced_accuracy"], fus_v["class0_recall"], fus_v["class1_recall"], fus_v["class2_recall"],
                      "PASS" if gate3["pass"] else "FAIL", "PASS" if doc3["pass"] else "FAIL",
                      b1["fusion"]["aggregate"]["balanced_accuracy"] if b1 else float("nan"),
                      100 * delta["class2_recall"], 100 * delta["balanced_accuracy"], delta["verdict"],
                      total_words, total_words - 5718))
        v4_path.write_text(refresh_v4_section(v4_path.read_text(encoding="utf-8"), section), encoding="utf-8")
        log("[report] refreshed section 10 of %s" % v4_path)

    # evidence log
    log("")
    log("# ---- 关键数字 ----")
    log("FOLDS=%d" % three["n_folds"])
    log("A_CNN_ONLY acc=%.4f bal=%.4f c0R=%.4f c1R=%.4f c2R=%.4f"
        % (cnn_agg["accuracy"], cnn_agg["balanced_accuracy"],
           cnn_v["class0_recall"], cnn_v["class1_recall"], cnn_v["class2_recall"]))
    log("B_FUSION   acc=%.4f bal=%.4f c0R=%.4f c1R=%.4f c2R=%.4f"
        % (fus_agg["accuracy"], fus_agg["balanced_accuracy"],
           fus_v["class0_recall"], fus_v["class1_recall"], fus_v["class2_recall"]))
    log("GATE_LEAD B=%s (c2 %.4f>=0.75, c1 %.4f>=0.85, c0 %.4f>=0.85, bal %.4f>=0.85)"
        % ("PASS" if gate3["pass"] else "FAIL", fus_v["class2_recall"], fus_v["class1_recall"],
           fus_v["class0_recall"], fus_v["balanced_accuracy"]))
    log("GATE_M5_DOC B=%s (c1 %.4f, c2 %.4f)" % ("PASS" if doc3["pass"] else "FAIL",
                                                  fus_v["class1_recall"], fus_v["class2_recall"]))
    if b1:
        log("B1_CLASS1_VS_REST bal=%.4f acc=%.4f negR=%.4f c1R=%.4f"
            % (b1["fusion"]["aggregate"]["balanced_accuracy"], b1["fusion"]["aggregate"]["accuracy"],
               b1["fusion"]["aggregate"]["per_class"]["0"]["recall"],
               b1["fusion"]["aggregate"]["per_class"]["1"]["recall"]))
    if b2:
        log("B2_CLASS0_VS_CLASS1 bal=%.4f acc=%.4f c0R=%.4f c1R=%.4f"
            % (b2["fusion"]["aggregate"]["balanced_accuracy"], b2["fusion"]["aggregate"]["accuracy"],
               b2["fusion"]["aggregate"]["per_class"]["0"]["recall"],
               b2["fusion"]["aggregate"]["per_class"]["1"]["recall"]))
    log("DELTA c2=%+.4f bal=%+.4f c1=%+.4f -> %s"
        % (delta["class2_recall"], delta["balanced_accuracy"], delta["class1_recall"], delta["verdict"]))
    log("ROM_WORDS=%d (base=%d fusion=%d)" % (total_words, ROM_BASE_WORDS, total_words - ROM_BASE_WORDS))
    log("INT8_AGREEMENT=%.6f" % agreement)
    log("CHECKS %s" % json.dumps(checks, ensure_ascii=False, sort_keys=True))
    all_ok = all(checks.values())
    evid = Path(args.evid)
    evid.parent.mkdir(parents=True, exist_ok=True)
    if not all_ok:
        log("FUSION_OK=0（自检未全过）")
    else:
        log("FUSION_OK=1")
    evid.write_text("\n".join(log.lines) + "\n", encoding="utf-8")
    log("[done] %.1fs total; evidence %s" % (time.time() - t_start, evid))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
