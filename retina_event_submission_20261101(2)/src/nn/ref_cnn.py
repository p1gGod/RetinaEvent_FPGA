"""Bit-exact numpy reference implementation of the int8 P1 pipeline.

This is an independent implementation of the RTL arithmetic:
  acc = sum(w_int8 * x_int8) + bias_int32
  y   = clip(acc >> SH[out_ch], -128, 127); ReLU after conv, none after fc

It reads nn/out/nn_params.json and recomputes predictions from the dataset.
--check compares ref argmax against the predictions produced by quantize.py
(nn/out/quant_test_preds.npz) on the whole official test split.

Usage:
  python nn/ref_cnn.py --check
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

NN_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = NN_DIR / "dataset_v3_w100.npz"
DEFAULT_PARAMS = NN_DIR / "out" / "nn_params.json"
DEFAULT_PREDS = NN_DIR / "out" / "quant_test_preds.npz"


def load_params(path: Path) -> list[dict]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    layers = []
    for layer in doc["layers"]:
        layers.append({
            "name": layer["name"],
            "w": np.asarray(layer["weight_int8"], dtype=np.int64).reshape(layer["weight_shape"]),
            "b": np.asarray(layer["bias_int32"], dtype=np.int64),
            "sh": np.asarray(layer["SH"], dtype=np.int64),
        })
    return layers


def conv_ref(x: np.ndarray, layer: dict, relu: bool = True) -> np.ndarray:
    """Direct patch-based conv, k=3, stride=2, pad=0 (independent of quantize.py)."""
    w = layer["w"]
    b = layer["b"]
    sh = layer["sh"]
    n, cin, h, wd = x.shape
    cout, _, k, _ = w.shape
    oh = (h - k) // 2 + 1
    ow = (wd - k) // 2 + 1
    out = np.empty((n, cout, oh, ow), dtype=np.int64)
    for oy in range(oh):
        for ox in range(ow):
            patch = x[:, :, oy * 2:oy * 2 + k, ox * 2:ox * 2 + k].astype(np.int64)
            acc = np.einsum("nckl,ockl->no", patch, w)
            acc += b.reshape(1, -1)
            acc = acc >> sh.reshape(1, -1)
            acc = np.clip(acc, -128, 127)
            if relu:
                acc = np.maximum(acc, 0)
            out[:, :, oy, ox] = acc
    return out.astype(np.int8)


def fc_ref(x: np.ndarray, layer: dict) -> np.ndarray:
    flat = np.ascontiguousarray(x).reshape(x.shape[0], -1).astype(np.int64)
    acc = flat @ layer["w"].T + layer["b"].reshape(1, -1)
    acc = acc >> layer["sh"].reshape(1, -1)
    return np.clip(acc, -128, 127).astype(np.int8)


def forward_ref(x: np.ndarray, layers: list[dict], collect: bool = False) -> tuple[np.ndarray, dict]:
    acts = x.astype(np.int8)
    stats: dict[str, dict] = {}
    for layer in layers:
        before = acts
        if layer["name"] == "fc":
            acts = fc_ref(acts, layer)
        else:
            acts = conv_ref(acts, layer, relu=True)
        stats[layer["name"]] = {
            "in_min": int(before.min()), "in_max": int(before.max()),
            "in_mean": round(float(before.mean()), 4),
            "out_min": int(acts.min()), "out_max": int(acts.max()),
            "out_mean": round(float(acts.mean()), 4),
        }
    return acts, stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bit-exact numpy reference for P1 int8")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--params", default=str(DEFAULT_PARAMS))
    ap.add_argument("--preds", default=str(DEFAULT_PREDS))
    ap.add_argument("--check", action="store_true", help="compare against quantize.py predictions")
    ap.add_argument("--samples", type=int, default=20)
    args = ap.parse_args(argv)

    layers = load_params(Path(args.params))
    d = np.load(args.data, allow_pickle=False)
    split = d["split"].astype(str)
    te = split == "test"
    x_te = d["X_q"][te].astype(np.int8)
    y_te = d["y"][te].astype(np.int64)
    idx_te = np.where(te)[0]

    logits, stats = forward_ref(x_te, layers, collect=True)
    pred = logits.argmax(axis=1).astype(np.int64)
    print(f"[ref] layers={[l['name'] for l in layers]}")
    print(f"[ref] test windows={len(x_te)}")
    for name, s in stats.items():
        print(f"[ref] {name}: in=[{s['in_min']},{s['in_max']}] mean={s['in_mean']} "
              f"out=[{s['out_min']},{s['out_max']}] mean={s['out_mean']}")

    rng = np.random.default_rng(7)
    pick = rng.choice(len(x_te), size=min(args.samples, len(x_te)), replace=False)
    print(f"[ref] sample windows ({len(pick)}):")
    for i in pick.tolist():
        stats_i = {}
        acts = x_te[i:i + 1]
        trace = []
        for layer in layers:
            before = acts
            if layer["name"] == "fc":
                acts = fc_ref(acts, layer)
            else:
                acts = conv_ref(acts, layer, relu=True)
            trace.append(f"{layer['name']}:in[{int(before.min())},{int(before.max())}]"
                         f"out[{int(acts.min())},{int(acts.max())}]")
        print(f"[ref]   idx={int(idx_te[i])} y={int(y_te[i])} ref_argmax={int(pred[i])} "
              f"ref_logits={logits[i].tolist()} " + " ".join(trace))

    if args.check:
        q = np.load(args.preds, allow_pickle=False)
        q_pred = np.asarray(q["pred_int8"], dtype=np.int64)
        q_true = np.asarray(q["y_true"], dtype=np.int64)
        if len(q_pred) != len(pred):
            print(f"REF_CHECK_FAILED: length mismatch ref={len(pred)} quant={len(q_pred)}")
            return 1
        if not np.array_equal(q_true, y_te):
            print("REF_CHECK_FAILED: test label order mismatch")
            return 1
        agree = float((pred == q_pred).mean())
        mism = int((pred != q_pred).sum())
        ref_acc = float((pred == y_te).mean())
        quant_acc = float((q_pred == y_te).mean())
        print(f"[ref] agreement ref vs quantize.py = {agree:.6f} ({len(pred)-mism}/{len(pred)}), mismatches={mism}")
        print(f"[ref] ref_acc={ref_acc:.4f} quant_acc={quant_acc:.4f}")
        print(f"REF_AGREEMENT={agree:.6f}")
        ok = agree >= 0.99
        print(f"REF_OK={1 if ok else 0}")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
