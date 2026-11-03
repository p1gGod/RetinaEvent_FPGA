#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""task-36 第 3 步：候选输入表征对比（c0 标量对照 / c1 基线 4ch / c2 4ch+全局 /
c3 平移归一化 / c4 400ms 8ch / c5 平移+全局）。

协议：
  - 只用真实长录的标注窗（y!=255）；留出按「每段内时间前后半」2 折，训练/测试互斥。
  - 每个候选：2 个折模型 -> 拼出全部窗的 held-out 预测（不含该窗所在折的训练数据）。
  - 后处理沿用板卡决策链：每 100ms 决策一次、N_CONSEC=3、1.5s 不应期、1.0s 空窗清零；margin 网格 4/8/16/24。
  - 指标：脉冲级（静默误触/分、开合 5s 段检出、挥手 pulse/min）+ 窗级（挥手 class1 比例）。
输出 nn/out_v6/representation_results.json + representation_table.csv + stdout 紧凑表。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path("E:/workspace/FPGA_Comp")
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402
import int8_generic as IG  # noqa: E402
sys.path.insert(0, str(ROOT / "nn"))
import quantize as Q  # noqa: E402

DEFAULT_DATA = ROOT / "nn" / "v6" / "windows" / "real_w100.npz"
DEFAULT_OUT = ROOT / "nn" / "out_v6"
LABELED_ZONES = [0, 2, 3, 5, 6]   # empty_desk, openclose, static_a, static_b, wave


def stack_history(X, offsets=(6, 4, 2, 0)):
    """把 [t-300,t-200,t-100,t] 的 now 两通道拼成 8ch（K=4, 400ms）。"""
    n = len(X)
    out = np.zeros((n, 2 * len(offsets), C.GRID_H, C.GRID_W), dtype=np.int8)
    for j, off in enumerate(offsets):
        src = np.zeros_like(X[:, 0:2])
        if off == 0:
            src[:] = X[:, 0:2]
        else:
            src[off:] = X[:-off, 0:2]
        out[:, 2 * j:2 * j + 2] = src
    return out


def build_inputs(d):
    X = d["X_q"]
    Xs = d["Xq_shift"]
    g = d["g"]
    feats13, names13 = C.global_features(g)
    # 17 路全局量 = 13 基础 + 上窗质心 2 + on/off 占比 2（都在同一窗内可算）
    n = g[:, C.GIDX["n"]]
    on = g[:, C.GIDX["on"]]
    off = g[:, C.GIDX["off"]]
    safe = np.maximum(n, 1.0)
    extra = np.stack([(g[:, C.GIDX["pcx"]] - 200.0) / 120.0,
                      (g[:, C.GIDX["pcy"]] - 120.0) / 80.0,
                      on / safe, off / safe], axis=1).astype(np.float32)
    feats = np.concatenate([feats13, extra], axis=1)
    feat_names = names13 + ["pcx", "pcy", "on_ratio", "off_ratio"]
    X4 = stack_history(X)
    X4s = stack_history(Xs)
    return X, Xs, feats, feat_names, X4, X4s


def fold_assignment(zone, y):
    fold = np.full(len(y), -1, dtype=np.int64)
    for zi in LABELED_ZONES:
        idx = np.where((zone == zi) & (y != 255))[0]
        half = len(idx) // 2
        fold[idx[:half]] = 0
        fold[idx[half:]] = 1
    return fold


def _scalar_model(n_feat, n_out=3):
    torch, nn = C._torch()
    return nn.Sequential(nn.Linear(n_feat, 32), nn.ReLU(),
                         nn.Linear(32, 16), nn.ReLU(),
                         nn.Linear(16, n_out))


def train_scalar(ftr, ytr, seed, epochs=30, batch=128, lr=2e-3, wd=1e-4, n_out=3):
    torch, nn = C._torch()
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    counts = np.bincount(ytr, minlength=n_out).astype(np.float64)
    counts[counts == 0] = 1.0
    w = np.clip(np.sqrt(len(ytr) / (n_out * counts)), 0.5, 3.0)
    cw = torch.tensor(w, dtype=torch.float32)
    model = _scalar_model(ftr.shape[1], n_out)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    lossf = nn.CrossEntropyLoss(weight=cw)
    xt = torch.from_numpy(np.ascontiguousarray(ftr)).float()
    yt = torch.from_numpy(np.ascontiguousarray(ytr)).long()
    for _ep in range(epochs):
        perm = rng.permutation(len(yt))
        model.train()
        for i in range(0, len(yt), batch):
            idx = perm[i:i + batch]
            opt.zero_grad()
            loss = lossf(model(xt[idx]), yt[idx])
            loss.backward()
            opt.step()
        sched.step()
    model.eval()
    return model


def predict_scalar(model, feats):
    torch, _ = C._torch()
    with torch.no_grad():
        logits = model(torch.from_numpy(np.ascontiguousarray(feats)).float()).numpy()
    pred = logits.argmax(axis=1).astype(np.int64)
    srt = np.sort(logits, axis=1)
    margin = (srt[:, -1] - srt[:, -2]).astype(np.float32)
    c1 = logits[:, 1] - np.maximum(logits[:, 0], logits[:, 2])
    return pred, margin.astype(np.float32), c1.astype(np.float32), logits


def train_candidate(kind, Xtr, ftr, ytr, seed):
    n_out = 3
    torch, _nn = C._torch()
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    t0 = time.time()
    model = C.train_model(Xtr, ytr, feat=ftr, seed=seed, epochs=30, batch=128,
                          lr=2e-3, wd=1e-4, n_out=n_out, kind=kind)
    return model, time.time() - t0


def predict_all(model, X, feats):
    return C.predict_model(model, X, feat=feats)


def evaluate_candidate(name, X, feats, y, zone, center, fold, seed=1234, cal_max=1024):
    pred_final = np.zeros(len(y), dtype=np.int64)
    score_final = np.zeros(len(y), dtype=np.float32)
    margin_final = np.zeros(len(y), dtype=np.float32)
    pred_q_final = np.zeros(len(y), dtype=np.int64)
    score_q_final = np.zeros(len(y), dtype=np.float32)
    fold_models = {}
    t_train = 0.0
    int8_agree_num = 0
    int8_agree_den = 0
    int8_agree_all_num = 0
    int8_agree_all_den = 0
    match_quantize_py = None
    for f in (0, 1):
        tr = fold == f
        te = fold == 1 - f
        ytr = y[tr].astype(np.int64)
        ftr = feats[tr] if feats is not None else None
        if X is None:
            _t = time.time()
            model = train_scalar(ftr, ytr, seed + f, epochs=30, n_out=3)
            dt = time.time() - _t
            pred, margin, c1, _lg = predict_scalar(model, feats)
        else:
            Xtr = X[tr]
            model, dt = train_candidate(name, Xtr, ftr, ytr, seed + f)
            pred, margin, c1, _lg = predict_all(model, X, feats)
        t_train += dt
        # ---- int8 量化（nn/quantize.py 折叠规则）+ int8 前向 ----
        cal = min(cal_max, int(tr.sum()))
        tr_idx = np.where(tr)[0]
        _step = max(1, len(tr_idx) // cal)
        cal_idx = tr_idx[::_step][:cal]   # 跨段均匀采样，避免只用空桌面标定（否则高活动窗严重 clip）
        x_cal = None if X is None else X[cal_idx]
        f_cal = feats[cal_idx] if feats is not None else None
        qp = IG.quantize_generic(model, x_cal, f_cal)
        logits_q = IG.forward_generic(X, feats, qp)
        pred_q = logits_q.argmax(axis=1).astype(np.int64)
        c1_q = (logits_q[:, 1] - np.maximum(logits_q[:, 0], logits_q[:, 2])).astype(np.float32)
        fold_models[f] = {"n_train": int(tr.sum()), "train_s": round(dt, 2),
                          "int8_kind": qp["kind"], "int8_layers": len(qp["layers"]),
                          "int8_agree_heldout": round(float((pred_q[te] == pred[te]).mean()), 6)}
        int8_agree_num += int((pred_q[te] == pred[te]).sum())
        int8_agree_den += int(te.sum())
        int8_agree_all_num += int((pred_q == pred).sum())
        int8_agree_all_den += len(y)
        if name == "c1_4ch" and f == 0:
            # 自检：通用量化器在 c1（标准 P1CNN 4ch/3cls）上应与 nn/quantize.py 逐位一致
            from types import SimpleNamespace
            shim = SimpleNamespace(conv1=model.c1, conv2=model.c2, conv3=model.c3, fc=model.fc)
            qp_py = Q.quantize_model(shim, x_cal)
            logits_py, _ = Q.forward_int8(X, qp_py)
            match_quantize_py = float((logits_py.argmax(axis=1) == pred_q).mean())
        pred_final[te] = pred[te]
        score_final[te] = c1[te]
        margin_final[te] = margin[te]
        pred_q_final[te] = pred_q[te]
        score_q_final[te] = c1_q[te]
        if f == 0:
            miss = ~(te | tr)
            pred_final[miss] = pred[miss]
            score_final[miss] = c1[miss]
            margin_final[miss] = margin[miss]
            pred_q_final[miss] = pred_q[miss]
            score_q_final[miss] = c1_q[miss]
    res = {
        "candidate": name,
        "fold_models": fold_models,
        "train_s_total": round(t_train, 2),
        "heldout_window_acc": round(float((pred_final[y != 255] == y[y != 255]).mean()), 4),
        "heldout_per_class_recall": {},
        "configs": {},
        "window_class1_ratio": {},
    }
    for cls, cname in ((0, "none"), (1, "openclose"), (2, "wave")):
        m = (y == cls)
        res["heldout_per_class_recall"][cname] = round(float((pred_final[m] == cls).mean()), 4) if m.any() else None
    dec = C.decision_indices(len(y))
    for margin_min in (4, 8, 16, 24):
        pm = C.evaluate_predictions(pred_final, score_final, center, zone, dec,
                                    margin_min=margin_min, n_consec=C.ONLINE_N_CONSEC)
        key = "m%d_n3" % margin_min
        res["configs"][key] = {
            "margin_min": margin_min,
            "pulses_total": pm["pulses_total"],
            "static_fp": pm["static_fp"],
            "static_fp_per_min": pm["static_fp_per_min"],
            "empty_fp": pm["empty_fp"],
            "openclose_pulses": pm["openclose_pulses"],
            "openclose_chunks_detected": pm["openclose_chunks_detected"],
            "openclose_chunks_total": pm["openclose_chunks_total"],
            "openclose_chunk_recall": pm["openclose_chunk_recall"],
            "wave_pulses": pm["wave_pulses"],
            "wave_pulses_per_min": pm["wave_pulses_per_min"],
            "excluded_pulses": pm["excluded_pulses"],
            "window_table": pm["window_table"],
        }
    # ---- int8 汇总 ----
    pm_q = C.evaluate_predictions(pred_q_final, score_q_final, center, zone, dec,
                                  margin_min=C.ONLINE_MARGIN_MIN, n_consec=C.ONLINE_N_CONSEC)
    by_zone = {}
    for zi, zname in enumerate(C.ZONE_NAMES):
        m = zone == zi
        by_zone[zname] = round(float((pred_q_final[m] == pred_final[m]).mean()), 6) if m.any() else None
    strong = margin_final >= C.ONLINE_MARGIN_MIN
    decision_float = (pred_final == 1) & (score_final >= C.ONLINE_MARGIN_MIN)
    decision_int8 = (pred_q_final == 1) & (score_q_final >= C.ONLINE_MARGIN_MIN)
    res["int8"] = {
        "agree_heldout": round(int8_agree_num / max(1, int8_agree_den), 6),
        "agree_all_windows": round(int8_agree_all_num / max(1, int8_agree_all_den), 6),
        "agree_by_zone": by_zone,
        "agree_float_margin_ge8": round(float((pred_q_final[strong] == pred_final[strong]).mean()), 6) if strong.any() else None,
        "decision_hit_agreement": round(float((decision_int8 == decision_float).mean()), 6),
        "match_quantize_py": match_quantize_py,
        "pulses_total": pm_q["pulses_total"],
        "static_fp": pm_q["static_fp"], "static_fp_per_min": pm_q["static_fp_per_min"],
        "empty_fp": pm_q["empty_fp"],
        "openclose_pulses": pm_q["openclose_pulses"],
        "openclose_chunks_detected": pm_q["openclose_chunks_detected"],
        "openclose_chunks_total": pm_q["openclose_chunks_total"],
        "openclose_chunk_recall": pm_q["openclose_chunk_recall"],
        "wave_pulses": pm_q["wave_pulses"], "wave_pulses_per_min": pm_q["wave_pulses_per_min"],
        "wave_window_hit8": pm_q["window_table"]["wave"].get("class1_hit_ratio"),
    }
    # 挥手窗 class1 比例（hit 口径 + argmax 口径），用 margin=8
    wt = res["configs"]["m8_n3"]["window_table"]
    for zname, s in wt.items():
        if s.get("n"):
            res["window_class1_ratio"][zname] = {
                "hit8": s["class1_hit_ratio"],
                "argmax": s["class1_argmax_ratio"],
                "n": s["n"],
            }
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--only", default="", help="逗号分隔候选名，空=全部")
    ap.add_argument("--calib", type=int, default=1024, help="每折标定窗数上限")
    ap.add_argument("--headroom", type=float, default=1.0, help="act_max 头寸倍数")
    args = ap.parse_args(argv)
    t0 = time.time()
    IG.HEADROOM = args.headroom
    d = np.load(args.data, allow_pickle=False)
    X, Xs, feats, feat_names, X4, X4s = build_inputs(d)
    y = d["y"].astype(np.int64)
    zone = d["zone"].astype(np.int64)
    center = d["center_rel"].astype(np.int64)
    fold = fold_assignment(zone, y)
    print("[exp] windows=%d labeled=%d folds: f0=%d f1=%d excluded=%d" %
          (len(y), int((y != 255).sum()), int((fold == 0).sum()),
           int((fold == 1).sum()), int((fold < 0).sum())))
    print("[exp] labeled per zone: " + " ".join(
        "%s=%d" % (C.ZONE_NAMES[zi], int(((zone == zi) & (y != 255)).sum()))
        for zi in LABELED_ZONES))
    print("[exp] global feats: %d (%s)" % (len(feat_names), ",".join(feat_names)))
    print("[exp] c4/c6 8ch = now 通道 at k-6,k-4,k-2,k (400ms)")

    cands = [
        ("c0_scalar", None, feats),
        ("c1_4ch", X, None),
        ("c2_4ch_glob", X, feats),
        ("c3_shift", Xs, None),
        ("c4_8ch_400ms", X4, None),
        ("c6_shift_8ch_400ms", X4s, None),
        ("c5_shift_glob", Xs, feats),
        ("c7_shift_8ch_glob", X4s, feats),
    ]
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    results = []
    for name, xin, ftr in cands:
        if only and name not in only:
            continue
        print("[exp] === %s ===" % name, flush=True)
        r = evaluate_candidate(name, xin, ftr, y, zone, center, fold, seed=args.seed, cal_max=args.calib)
        results.append(r)
        c = r["configs"]["m8_n3"]
        print("  acc=%.4f recall=%s" % (r["heldout_window_acc"], r["heldout_per_class_recall"]))
        print("  8/3: static=%d fp_min=%s empty=%d open_pulse=%d chunks=%d/%d recall=%s "
              "wave_pulse=%d wave/min=%s excl=%d total=%d train=%.1fs" % (
                  c["static_fp"], C.fmt(c["static_fp_per_min"]), c["empty_fp"],
                  c["openclose_pulses"], c["openclose_chunks_detected"],
                  c["openclose_chunks_total"], C.fmt(c["openclose_chunk_recall"]),
                  c["wave_pulses"], C.fmt(c["wave_pulses_per_min"]), c["excluded_pulses"],
                  c["pulses_total"], r["train_s_total"]))
        iq = r["int8"]
        print("  int8: agree_heldout=%s agree_all=%s py_match=%s | wave_pulse=%d/min=%s "
              "static=%d/min=%s empty=%d open_recall=%s" % (
                  C.fmt(iq["agree_heldout"], 6), C.fmt(iq["agree_all_windows"], 6),
                  C.fmt(iq["match_quantize_py"], 6),
                  iq["wave_pulses"], C.fmt(iq["wave_pulses_per_min"]),
                  iq["static_fp"], C.fmt(iq["static_fp_per_min"]), iq["empty_fp"],
                  C.fmt(iq["openclose_chunk_recall"])))
        for m in (4, 8, 16, 24):
            r2 = r["configs"]["m%d_n3" % m]
            print("    m=%-2d wave_win_hit=%s wave_pulse/min=%s static/min=%s open_recall=%s" % (
                m,
                C.fmt(r2["window_table"]["wave"]["class1_hit_ratio"]),
                C.fmt(r2["wave_pulses_per_min"]), C.fmt(r2["static_fp_per_min"]),
                C.fmt(r2["openclose_chunk_recall"])))
        print("  wave window class1: hit8=%s argmax=%s" % (
            C.fmt(r["window_class1_ratio"]["wave"]["hit8"]),
            C.fmt(r["window_class1_ratio"]["wave"]["argmax"])))

    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    payload = {
        "task": "task-36",
        "data": str(args.data),
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "protocol": {
            "folds": "每标注段内按时间前后半 2 折；held-out 预测不漏训练",
            "decision_cadence_ms": C.WIN_MS,
            "n_consec": C.ONLINE_N_CONSEC,
            "refractory": "1.5s",
            "idle_clear": "1.0s",
            "margin_grid": [4, 8, 16, 24],
            "openclose_chunks": "开合区间按 5s 分块（27 段类比）",
        },
        "feature_names": feat_names,
        "elapsed_s": None,
        "candidates": results,
    }
    payload["elapsed_s"] = round(time.time() - t0, 2)
    (out / "representation_results.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    # CSV 主表（8/3 档）
    rows = ["candidate,heldout_acc,int8_agree,int8_agree_all,int8_py_match,static_fp,"
            "static_fp_per_min,empty_fp,open_chunks_det,total,open_chunk_recall,"
            "wave_pulses,wave_pulses_per_min,wave_win_hit8,wave_win_argmax,excluded_pulses,train_s"]
    for r in results:
        c = r["configs"]["m8_n3"]
        w = r["window_class1_ratio"].get("wave", {})
        rows.append(",".join([
            r["candidate"], C.fmt(r["heldout_window_acc"]),
            C.fmt(r["int8"]["agree_heldout"], 6), C.fmt(r["int8"]["agree_all_windows"], 6),
            C.fmt(r["int8"]["match_quantize_py"], 6),
            str(c["static_fp"]),
            C.fmt(c["static_fp_per_min"]),
            str(c["empty_fp"]),
            "%d/%d" % (c["openclose_chunks_detected"], c["openclose_chunks_total"]),
            C.fmt(c["openclose_chunk_recall"]),
            str(c["wave_pulses"]), C.fmt(c["wave_pulses_per_min"]),
            C.fmt(w.get("hit8")), C.fmt(w.get("argmax")),
            str(c["excluded_pulses"]), C.fmt(r["train_s_total"]),
        ]))
    (out / "representation_table.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print("[exp] saved %s/representation_results.json (+ .csv) in %.1fs" %
          (out, time.time() - t0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
