# -*- coding: utf-8 -*-
"""训练 c4/c5 全量部署模型并保存（float state_dict + int8 params json），供独立录像验证用。"""
import argparse, json, os, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v6_common as C
import exp_representations as E
import int8_generic as IG


def spread_idx(mask_idx, n):
    if len(mask_idx) <= n:
        return mask_idx
    return mask_idx[np.linspace(0, len(mask_idx) - 1, n).astype(np.int64)]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="nn/v6/windows/real_w100.npz")
    ap.add_argument("--out-dir", default="nn/out_v6/models")
    ap.add_argument("--calib", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args(argv)
    os.makedirs(args.out_dir, exist_ok=True)
    torch, _nn = C._torch()
    d = np.load(args.data, allow_pickle=False)
    X, Xs, feats, feat_names, X4, X4s = E.build_inputs(d)
    y = d["y"].astype(np.int64)
    zone = d["zone"].astype(np.int64)
    tr = np.where(y != 255)[0]
    spec = {
        "c4_8ch_400ms": ("cnn8", X4[tr], feats[tr], feats[tr]),
        "c5_shift_glob": ("cnn_glob", Xs[tr], feats[tr], feats[tr]),
    }
    # 标定窗：所有标注窗等间隔采样
    cal_idx = spread_idx(tr, args.calib)
    out = {}
    for name, (kind, xin, ftr, _f) in spec.items():
        t0 = time.time()
        model, dt = E.train_candidate(kind, xin, ftr, y[tr], args.seed)
        xq = X4 if kind == "cnn8" else Xs
        pred, margin, c1, logits = E.predict_all(model, xq, feats)
        acc = float((pred[tr] == y[tr]).mean())
        params = IG.quantize_generic(model, xq[cal_idx], feats[cal_idx])
        pq = IG.forward_generic(xq, feats, params)
        agree = float((pq[tr].argmax(axis=1) == logits[tr].argmax(axis=1)).mean())
        out[name] = {
            "kind": kind, "train_acc": acc, "int8_agree_all": agree,
            "calib_windows": len(cal_idx), "train_seconds": dt,
            "feature_names": feat_names,
        }
        torch.save(model.state_dict(), os.path.join(args.out_dir, name + ".pt"))
        with open(os.path.join(args.out_dir, name + "_params.json"), "w", encoding="utf-8") as f:
            json.dump({"meta": out[name], "params": params}, f, ensure_ascii=False)
        print("[save] %-14s acc=%.4f int8_agree=%.4f train=%.1fs -> %s" % (name, acc, agree, dt, args.out_dir))
    with open(os.path.join(args.out_dir, "models_meta.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("DONE_MODELS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
