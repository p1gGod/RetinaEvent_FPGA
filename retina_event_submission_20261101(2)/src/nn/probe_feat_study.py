#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M2b: 跨会话特征/窗口方案对照实验（只读数据集原始事件）。

目标：回答 class2(横向挥手) 在跨会话留出下能否达到可部署召回，并给出
recommended 输入契约（K 时间片 / WIN_MS / 网格 / 归一化 / 增强）与采集协议。

设计要点（详见 REPORT_特征与窗口方案.md）：
- 只用原始 20 个会话事件，重新按配置切窗，标签沿用 extract_events 的活动段标注；
- 评估协议与 SEP3 对齐：class2 每次留 1 条会话，训练集为其余会话；
  测试集 = 固定留出会话 191905/192720（class1+class0） + 被留出会话全部窗，
  这样 3 类 balanced acc 有意义，class2 recall 只在被留出会话的真实 class2 窗上统计；
- class1 做同口径 LFO 对照；class0（含板移硬负样本）作为背景类参与训练/测试；
- 分类器固定为 class-balanced ridge（numpy 实现），避免不同配置换分类器造成混淆。
"""
import argparse
import json
import os
import sys
import numpy as np

import build_dataset_v2 as B
import extract_events as E

ROOT = "E:/workspace/FPGA_Comp/row_datas/原始采集数据"
FIXED_TEST = ("retina-events-20261029-191905", "retina-events-20261029-192720")
W, H = 400, 240
RIDGE_LAMBDA = 1.0


# ---------------------------------------------------------------------------
# 特征
# ---------------------------------------------------------------------------
def _empty_grid(K, gw, gh):
    return np.zeros((K, 2, gh, gw), dtype=np.float32)


def dim_features(sess, t0, t1, cfg):
    """无量纲特征：所有量除以窗内手部尺度 s，不含绝对坐标/密度/格数。"""
    K = int(cfg["K"])
    win = int(cfg["win_ms"])
    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    n = b - a
    variant0 = cfg.get("dim_variant", "dim_only")
    if n <= 0:
        if variant0 in ("density_only", "two"):
            return np.zeros(2, dtype=np.float64)
        if variant0 == "minimal":
            return np.zeros(5, dtype=np.float64)
        if variant0 == "dim_density":
            return np.zeros(2 * K + 10, dtype=np.float64)
        return np.zeros(2 * K + 8, dtype=np.float64)
    xs = sess.x[a:b].astype(np.float64)
    ys = sess.y[a:b].astype(np.float64)
    pol = sess.pol[a:b]
    ts = sess.t[a:b] - t0
    if cfg.get("scale_mode", "bbox") == "cells":
        cells = len(np.unique((ys // 8).astype(np.int64) * 50 + (xs // 8).astype(np.int64)))
        s = 8.0 * np.sqrt(max(cells, 1))
    else:
        w = float(np.percentile(xs, 95) - np.percentile(xs, 5))
        h = float(np.percentile(ys, 95) - np.percentile(ys, 5))
        s = max(w, h)
    s = max(s, 1.0)
    k = np.clip((ts * K) // max(1, win), 0, K - 1)
    kc = np.bincount(k, minlength=K).astype(np.float64)
    cx = np.bincount(k, weights=xs, minlength=K) / np.maximum(kc, 1.0)
    cy = np.bincount(k, weights=ys, minlength=K) / np.maximum(kc, 1.0)
    on = np.bincount(k, weights=pol, minlength=K) / np.maximum(kc, 1.0)
    dx = np.diff(cx) / s
    dy = np.diff(cy) / s
    swing_x = (float(cx.max()) - float(cx.min())) / s
    swing_y = (float(cy.max()) - float(cy.min())) / s
    path = float(np.abs(dx).sum() + np.abs(dy).sum())
    h0 = K // 2
    half_dx = (float(cx[h0:].mean()) - float(cx[:h0].mean())) / s
    half_dy = (float(cy[h0:].mean()) - float(cy[:h0].mean())) / s
    w_px = float(np.percentile(xs, 95) - np.percentile(xs, 5))
    h_px = float(np.percentile(ys, 95) - np.percentile(ys, 5))
    bbox_ratio = w_px / max(h_px, 1.0)
    horiz = (float(cx.max()) - float(cx.min())) / max(
        (float(cx.max()) - float(cx.min())) + (float(cy.max()) - float(cy.min())), 1e-9)
    signed = np.sign(on - 0.5)
    signed = signed[signed != 0]
    flip_rate = float(np.mean(signed[1:] != signed[:-1])) if len(signed) > 1 else 0.0
    on_std = float(on.std())
    pol_flip = float(np.mean(pol[1:] != pol[:-1])) if n > 1 else 0.0
    base = np.concatenate([dx, dy, np.array(
        [swing_x, swing_y, path, half_dx, half_dy, bbox_ratio, horiz,
         flip_rate, on_std, pol_flip])])
    variant = variant0
    dens = np.array([np.log1p(n), n / max(1.0, win / 1000.0)])
    if variant == "density_only":
        return dens
    if variant == "two":
        return np.array([swing_x, horiz], dtype=np.float64)
    if variant == "minimal":
        return np.array([swing_x, swing_y, horiz, flip_rate, bbox_ratio], dtype=np.float64)
    if variant == "dim_density":
        return np.concatenate([base, dens])
    return base


def window_features(sess, t0, t1, cfg):
    """返回 1-D 特征。cfg: K, win_ms, grid=(gw,gh), mode, prev"""
    K = int(cfg["K"])
    win = int(cfg["win_ms"])
    gw, gh = cfg["grid"]
    mode = cfg["mode"]
    if mode == "dim":
        return dim_features(sess, t0, t1, cfg)
    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    n = b - a
    ts = sess.t[a:b] - t0
    xs = sess.x[a:b]
    ys = sess.y[a:b]
    pol = sess.pol[a:b]
    k = np.clip((ts * K) // max(1, win), 0, K - 1)
    ch = 1 - pol
    feats = []
    if mode in ("grid", "grid_norm", "grid_motion", "grid_norm_motion"):
        gx = np.clip((xs * gw) // W, 0, gw - 1)
        gy = np.clip((ys * gh) // H, 0, gh - 1)
        idx = ((k * 2 + ch) * gh + gy) * gw + gx
        grid = np.bincount(idx, minlength=K * 2 * gh * gw).reshape(K, 2, gh, gw).astype(np.float32)
        if mode in ("grid_norm", "grid_norm_motion"):
            tot = grid.sum(axis=(2, 3), keepdims=True)
            grid = grid / np.maximum(tot, 1.0)
        feats.append(np.log1p(grid).ravel())
        tot = grid.sum(axis=(2, 3)).ravel()
        feats.append(np.log1p(tot))
    if mode in ("motion", "grid_motion", "grid_norm_motion", "motion_xy"):
        kc = np.bincount(k, minlength=K).astype(np.float64)
        cx = np.bincount(k, weights=xs, minlength=K) / np.maximum(kc, 1.0)
        cy = np.bincount(k, weights=ys, minlength=K) / np.maximum(kc, 1.0)
        sx = np.sqrt(np.maximum(np.bincount(k, weights=(xs - cx[k]) ** 2, minlength=K) / np.maximum(kc, 1.0), 0))
        sy = np.sqrt(np.maximum(np.bincount(k, weights=(ys - cy[k]) ** 2, minlength=K) / np.maximum(kc, 1.0), 0))
        on = np.bincount(k, weights=pol, minlength=K) / np.maximum(kc, 1.0)
        fset = cfg.get("feature_set", "full")
        if fset == "nodens":
            mcols = [cx / W, cy / H, sx / W, sy / H, on]
        elif fset == "strict":
            mcols = [cx / W, cy / H, on]
        elif fset == "density_only":
            mcols = [np.log1p(kc)]
        else:
            mcols = [cx / W, cy / H, sx / W, sy / H, np.log1p(kc), on]
        m = np.stack(mcols, axis=1).ravel()
        # 质心轨迹/摆动/方向变化
        cx_n = cx / W
        dx = np.diff(cx_n)
        dy = np.diff(cy / H)
        swing = float(cx_n.max() - cx_n.min()) if K else 0.0
        path = float(np.abs(dx).sum() + np.abs(dy).sum())
        sgn = np.sign(dx)
        sgn = sgn[sgn != 0]
        flips = float(np.sum(sgn[1:] != sgn[:-1])) if len(sgn) > 1 else 0.0
        bbox_w = (xs.max() - xs.min()) / W if n else 0.0
        bbox_h = (ys.max() - ys.min()) / H if n else 0.0
        if fset == "density_only":
            agg_list = [bbox_w, bbox_h, float(np.log1p(n)),
                        float(n) / max(1, win / 1000.0)]
        elif fset in ("nodens", "strict"):
            agg_list = [swing, path, flips]
        else:
            agg_list = [swing, path, flips, bbox_w, bbox_h,
                        float(np.log1p(n)), float(n) / max(1, win / 1000.0)]
        agg = np.array(agg_list, dtype=np.float64)
        feats.append(m)
        feats.append(agg)
    if mode == "motion_xy":
        # 每片 x/y 一维直方图（绝对位置）
        nxb, nyb = cfg.get("xy_bins", (20, 12))
        ix = ((k * 2 + ch) * nxb + np.clip((xs * nxb) // W, 0, nxb - 1))
        hx = np.bincount(ix, minlength=K * 2 * nxb).reshape(K, 2, nxb).astype(np.float32)
        iy = ((k * 2 + ch) * nyb + np.clip((ys * nyb) // H, 0, nyb - 1))
        hy = np.bincount(iy, minlength=K * 2 * nyb).reshape(K, 2, nyb).astype(np.float32)
        feats.append(np.log1p(hx).ravel())
        feats.append(np.log1p(hy).ravel())
    return np.concatenate([np.asarray(f, dtype=np.float64).ravel() for f in feats])


def build_config_dataset(specs, cfg, verbose=False):
    win = int(cfg["win_ms"])
    if cfg.get("stride_mode") == "nonoverlap":
        stride = win
    else:
        stride = int(cfg.get("stride_ms") or 50)
    Xs, ys, sess_names, dens = [], [], [], []
    for sp in specs:
        sess = sp.session
        segs = E.annotate_cycles(sess, E.detect_segments(sess))
        starts = E.window_starts(int(sess.frame_times[0]), int(sess.frame_times[-1]), win, stride)
        feats = [window_features(sess, int(t0), int(t0) + win, cfg) for t0 in starts]
        labels = [E.label_window(int(t0), int(t0) + win, segs, win, sp.cls)[0] for t0 in starts]
        if feats:
            Xs.append(np.stack(feats))
            ys.append(np.asarray(labels, dtype=np.uint8))
            sess_names.extend([sess.name] * len(feats))
            for t0 in starts:
                a = int(np.searchsorted(sess.frame_times, t0, side="left"))
                b = int(np.searchsorted(sess.frame_times, int(t0) + win, side="left"))
                nf = max(1, b - a)
                ne = int(np.searchsorted(sess.t, int(t0) + win, side="left")
                         - np.searchsorted(sess.t, int(t0), side="left"))
                dens.append(ne / nf)
        if verbose:
            print(f"  {sess.name[-6:]} cls={sp.cls} n={len(feats)}")
    X = np.concatenate(Xs, axis=0) if Xs else np.empty((0, 0))
    y = np.concatenate(ys, axis=0) if ys else np.empty(0, np.uint8)
    return X, y, np.asarray(sess_names), np.asarray(dens, np.float64), specs


# ---------------------------------------------------------------------------
# 分类器
# ---------------------------------------------------------------------------
def fit_ridge(Xtr, ytr, n_classes=3, lam=RIDGE_LAMBDA, balanced=True):
    mu = Xtr.mean(axis=0)
    sd = Xtr.std(axis=0)
    sd[sd < 1e-6] = 1.0
    Z = (Xtr - mu) / sd
    Y = np.zeros((len(ytr), n_classes), dtype=np.float64)
    Y[np.arange(len(ytr)), ytr] = 1.0
    if balanced:
        cnt = np.bincount(ytr, minlength=n_classes).astype(np.float64)
        w_cls = np.where(cnt > 0, 1.0 / np.maximum(cnt, 1.0), 0.0)
        w_cls *= len(ytr) / max(w_cls.sum(), 1e-9)
        w = w_cls[ytr]
    else:
        w = np.ones(len(ytr))
    Zt = Z.T
    A = (Zt * w) @ Z + lam * np.eye(Z.shape[1])
    Bmat = (Zt * w) @ Y
    Wc = np.linalg.solve(A, Bmat)
    return mu, sd, Wc


def predict_ridge(model, X, n_classes=3):
    mu, sd, Wc = model
    Z = (X - mu) / sd
    return np.argmax(Z @ Wc, axis=1)


def metrics(y_true, y_pred, n_classes=3):
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    for t, p in zip(y_true, y_pred):
        cm[int(t), int(p)] += 1
    present = [c for c in range(n_classes) if cm[c].sum() > 0]
    recalls = {}
    for c in range(n_classes):
        d = cm[c].sum()
        recalls[c] = float(cm[c, c] / d) if d else None
    bal = float(np.mean([recalls[c] for c in present])) if present else 0.0
    acc = float(np.trace(cm) / max(1, cm.sum()))
    return {"acc": acc, "balanced_acc": bal, "recalls": recalls, "cm": cm.tolist(),
            "n": int(cm.sum()), "present": present}


def augment_mirror(X, y, cfg):
    """空间水平镜像增强；只对包含 grid/xy 直方图/质心的特征生效。"""
    K = int(cfg["K"])
    gw, gh = cfg["grid"]
    mode = cfg["mode"]
    chunks = []
    pos = 0
    if mode in ("grid", "grid_norm", "grid_motion", "grid_norm_motion"):
        n = K * 2 * gh * gw
        chunks.append(("grid", pos, pos + n, (K, 2, gh, gw), gw))
        pos += n
        chunks.append(("raw", pos, pos + K * 2, None, None)); pos += K * 2
    if mode in ("motion", "grid_motion", "grid_norm_motion", "motion_xy"):
        fset = cfg.get("feature_set", "full")
        nm = {"full": 6, "nodens": 5, "strict": 3, "density_only": 1}[fset]
        na = {"full": 7, "nodens": 3, "strict": 3, "density_only": 4}[fset]
        n = K * nm
        chunks.append(("motion", pos, pos + n, (K, nm), None)); pos += n
        chunks.append(("raw", pos, pos + na, None, None)); pos += na
    if mode == "motion_xy":
        nxb, nyb = cfg.get("xy_bins", (20, 12))
        n = K * 2 * nxb
        chunks.append(("xh", pos, pos + n, (K, 2, nxb), nxb)); pos += n
        n = K * 2 * nyb
        chunks.append(("yh", pos, pos + n, (K, 2, nyb), nyb)); pos += n
    Xm = X.copy()
    for kind, a, b, shape, width in chunks:
        if kind in ("grid", "xh"):
            Xm[:, a:b] = X[:, a:b].reshape((X.shape[0],) + shape)[:, :, :, ::-1].reshape(X.shape[0], -1)
        elif kind == "motion":
            fset = cfg.get("feature_set", "full")
            nm = {"full": 6, "nodens": 5, "strict": 3, "density_only": 1}[fset]
            V = X[:, a:b].reshape(X.shape[0], K, nm).copy()
            if fset != "density_only":
                V[:, :, 0] = 1.0 - V[:, :, 0]  # 质心 x 镜像
            Xm[:, a:b] = V.reshape(X.shape[0], -1)
    return Xm, y.copy()


# ---------------------------------------------------------------------------
# 评估
# ---------------------------------------------------------------------------
def evaluated_config(specs, cfg, use_aug=True, verbose=False):
    X, y, names, dens, _ = build_config_dataset(specs, cfg, verbose=verbose)
    if cfg.get("exclude_sessions"):
        keep = ~np.isin(names, cfg["exclude_sessions"])
        X, y, names, dens = X[keep], y[keep], names[keep], dens[keep]
    if cfg.get("density_band"):
        lo, hi = cfg["density_band"]
        keep = (y != 2) | ((dens >= lo) & (dens <= hi))
        X, y, names, dens = X[keep], y[keep], names[keep], dens[keep]
    is_fixed = np.isin(names, list(FIXED_TEST))
    class2_sessions = [sp.session.name for sp in specs if sp.cls == 2]
    if cfg.get("exclude_sessions"):
        class2_sessions = [n for n in class2_sessions if n not in cfg["exclude_sessions"]]
    folds = []
    held_list = cfg.get("held_class2") or class2_sessions
    for held in held_list:
        tr = ~(np.isin(names, [held]) | is_fixed)
        te = np.isin(names, [held]) | is_fixed
        Xtr, ytr = X[tr], y[tr]
        if use_aug:
            Xa, ya = augment_mirror(Xtr, ytr, cfg)
            Xtr, ytr = np.concatenate([Xtr, Xa]), np.concatenate([ytr, ya])
        model = fit_ridge(Xtr, ytr, lam=float(cfg.get("lam", RIDGE_LAMBDA)))
        pred = predict_ridge(model, X[te])
        m = metrics(y[te], pred)
        c2 = (names[te] == held) & (y[te] == 2)
        recall_c2 = float(np.mean(pred[c2] == 2)) if c2.sum() else None
        folds.append({"held": held, "class2_n": int(c2.sum()),
                      "recall_class2": recall_c2, "balanced_acc": m["balanced_acc"],
                      "acc": m["acc"], "cm": m["cm"]})
    return folds


def evaluated_lfo(specs, cfg, use_aug=True, max_folds=None):
    """class1 同口径留一会话（对照，证明不是只对 class2 调参）。"""
    X, y, names, dens, _ = build_config_dataset(specs, cfg)
    if cfg.get("exclude_sessions"):
        keep = ~np.isin(names, cfg["exclude_sessions"])
        X, y, names, dens = X[keep], y[keep], names[keep], dens[keep]
    is_fixed = np.isin(names, list(FIXED_TEST))
    class1_sessions = [sp.session.name for sp in specs if sp.cls == 1]
    if max_folds:
        class1_sessions = class1_sessions[:max_folds]
    folds = []
    for held in class1_sessions:
        tr = ~(np.isin(names, [held]) | is_fixed)
        te = np.isin(names, [held]) | is_fixed
        Xtr, ytr = X[tr], y[tr]
        if use_aug:
            Xa, ya = augment_mirror(Xtr, ytr, cfg)
            Xtr, ytr = np.concatenate([Xtr, Xa]), np.concatenate([ytr, ya])
        model = fit_ridge(Xtr, ytr, lam=float(cfg.get("lam", RIDGE_LAMBDA)))
        pred = predict_ridge(model, X[te])
        m = metrics(y[te], pred)
        c1 = (names[te] == held) & (y[te] == 1)
        rec = float(np.mean(pred[c1] == 1)) if c1.sum() else None
        folds.append({"held": held, "class1_n": int(c1.sum()),
                      "recall_class1": rec, "balanced_acc": m["balanced_acc"]})
    return folds


def _scale_stats(sess, t0, t1):
    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    fa = int(np.searchsorted(sess.frame_times, t0, side="left"))
    fb = int(np.searchsorted(sess.frame_times, t1, side="left"))
    n = b - a
    nf = max(1, fb - fa)
    if n <= 0:
        return None
    xs = sess.x[a:b]
    ys = sess.y[a:b]
    bw = (int(xs.max()) - int(xs.min()) + 1) / W
    bh = (int(ys.max()) - int(ys.min()) + 1) / H
    cells = len(np.unique((ys // 8) * 50 + (xs // 8)))
    return n / nf, bw, bh, float(np.sqrt(cells))


def distance_stats(specs, cfg):
    win = int(cfg["win_ms"])
    stride = win if cfg.get("stride_mode") == "nonoverlap" else int(cfg.get("stride_ms") or 50)
    acc = {1: [], 2: []}
    for sp in specs:
        if sp.cls not in (1, 2):
            continue
        sess = sp.session
        segs = E.annotate_cycles(sess, E.detect_segments(sess))
        starts = E.window_starts(int(sess.frame_times[0]), int(sess.frame_times[-1]), win, stride)
        for t0 in starts:
            lab, _ = E.label_window(int(t0), int(t0) + win, segs, win, sp.cls)
            if lab == 0:
                continue
            st = _scale_stats(sess, int(t0), int(t0) + win)
            if st is not None:
                acc[lab].append(st)
    out = {}
    for c in (1, 2):
        arr = np.asarray(acc[c], dtype=np.float64)
        if len(arr) == 0:
            out[c] = {"n": 0}
            continue
        out[c] = {"n": int(len(arr))}
        for i, key in enumerate(("dens_ev_per_frame", "bbox_w", "bbox_h", "sqrt_cells")):
            q = np.percentile(arr[:, i], [25, 50, 75])
            out[c][key] = {"q25": round(float(q[0]), 4), "median": round(float(q[1]), 4),
                           "q75": round(float(q[2]), 4)}
    return out


def _dim_window_stats(sess, t0, t1, cfg):
    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    fa = int(np.searchsorted(sess.frame_times, t0, side="left"))
    fb = int(np.searchsorted(sess.frame_times, t1, side="left"))
    n = b - a
    nf = max(1, fb - fa)
    if n <= 0:
        return None
    xs = sess.x[a:b].astype(np.float64)
    ys = sess.y[a:b].astype(np.float64)
    pol = sess.pol[a:b]
    ts = sess.t[a:b] - t0
    w = float(np.percentile(xs, 95) - np.percentile(xs, 5))
    h = float(np.percentile(ys, 95) - np.percentile(ys, 5))
    cells = len(np.unique((ys // 8).astype(np.int64) * 50 + (xs // 8).astype(np.int64)))
    if cfg.get("scale_mode", "bbox") == "cells":
        s = 8.0 * np.sqrt(max(cells, 1))
    else:
        s = max(w, h)
    s = max(s, 1.0)
    K = int(cfg["K"])
    win = int(cfg["win_ms"])
    k = np.clip((ts * K) // max(1, win), 0, K - 1)
    kc = np.bincount(k, minlength=K).astype(np.float64)
    cx = np.bincount(k, weights=xs, minlength=K) / np.maximum(kc, 1.0)
    cy = np.bincount(k, weights=ys, minlength=K) / np.maximum(kc, 1.0)
    on = np.bincount(k, weights=pol, minlength=K) / np.maximum(kc, 1.0)
    swing_x = (float(cx.max()) - float(cx.min())) / s
    swing_y = (float(cy.max()) - float(cy.min())) / s
    bbox_ratio = w / max(h, 1.0)
    horiz = (float(cx.max()) - float(cx.min())) / max(
        (float(cx.max()) - float(cx.min())) + (float(cy.max()) - float(cy.min())), 1e-9)
    return (n / nf, (int(xs.max()) - int(xs.min()) + 1) / W,
            (int(ys.max()) - int(ys.min()) + 1) / H, float(np.sqrt(cells)),
            swing_x, swing_y, bbox_ratio, horiz)


def dimensionless_stats(specs, cfg):
    win = int(cfg["win_ms"])
    stride = win if cfg.get("stride_mode") == "nonoverlap" else int(cfg.get("stride_ms") or 50)
    acc = {1: [], 2: []}
    for sp in specs:
        if sp.cls not in (1, 2):
            continue
        sess = sp.session
        segs = E.annotate_cycles(sess, E.detect_segments(sess))
        starts = E.window_starts(int(sess.frame_times[0]), int(sess.frame_times[-1]), win, stride)
        for t0 in starts:
            lab, _ = E.label_window(int(t0), int(t0) + win, segs, win, sp.cls)
            if lab == 0:
                continue
            st = _dim_window_stats(sess, int(t0), int(t0) + win, cfg)
            if st is not None:
                acc[lab].append(st)
    keys = ("dens_ev_per_frame", "bbox_w", "bbox_h", "sqrt_cells",
            "swing_x_over_s", "swing_y_over_s", "bbox_ratio", "horizontality")
    out = {}
    for c in (1, 2):
        arr = np.asarray(acc[c], dtype=np.float64)
        if len(arr) == 0:
            out[c] = {"n": 0}
            continue
        out[c] = {"n": int(len(arr))}
        for i, key in enumerate(keys):
            q = np.percentile(arr[:, i], [25, 50, 75])
            out[c][key] = {"q25": round(float(q[0]), 4), "median": round(float(q[1]), 4),
                           "q75": round(float(q[2]), 4)}
    return out


def summarize(folds):
    vals = [f["recall_class2"] for f in folds if f["recall_class2"] is not None]
    bals = [f["balanced_acc"] for f in folds]
    return (float(np.mean(vals)) if vals else None,
            float(np.std(vals)) if vals else None,
            float(np.mean(bals)), float(np.std(bals)))


CONFIGS = [
    {"name": "C1_grid25x15_K4_w100", "K": 4, "win_ms": 100, "grid": (25, 15), "mode": "grid", "desc": "现行 4 通道思想的时间片版：K=4/100ms/25x15 原始计数"},
    {"name": "C2_grid25x15_K4_w200", "K": 4, "win_ms": 200, "grid": (25, 15), "mode": "grid"},
    {"name": "C3_grid10x6_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid"},
    {"name": "C4_grid10x6_K8_w800", "K": 8, "win_ms": 800, "grid": (10, 6), "mode": "grid"},
    {"name": "C5_grid10x6_K8_w400_norm", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_norm"},
    {"name": "C6_motion_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion"},
    {"name": "C7_motion_xy_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion_xy", "xy_bins": (20, 12)},
    {"name": "C8_grid_motion_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_motion"},
    {"name": "C9_grid_norm_motion_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_norm_motion"},
    {"name": "C10_grid_motion_K8_w800", "K": 8, "win_ms": 800, "grid": (10, 6), "mode": "grid_motion"},
    {"name": "C11_grid_motion_K4_w400", "K": 4, "win_ms": 400, "grid": (10, 6), "mode": "grid_motion"},
    {"name": "C12_grid_motion_K12_w600", "K": 12, "win_ms": 600, "grid": (10, 6), "mode": "grid_motion"},
    {"name": "C13_motion_shape_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "strict"},
    {"name": "C14_motion_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion"},
    {"name": "C15_motion_K8_w800", "K": 8, "win_ms": 800, "grid": (10, 6), "mode": "motion"},
    {"name": "C16_motion_K12_w400", "K": 12, "win_ms": 400, "grid": (10, 6), "mode": "motion"},
    {"name": "C17_motion_K4_w400", "K": 4, "win_ms": 400, "grid": (10, 6), "mode": "motion"},
    {"name": "C18_motion_K6_w300", "K": 6, "win_ms": 300, "grid": (10, 6), "mode": "motion"},
    {"name": "C19_motion_grid5x3_K8_w400", "K": 8, "win_ms": 400, "grid": (5, 3), "mode": "grid_motion"},
    {"name": "C20_motion_grid5x3_norm_K8_w400", "K": 8, "win_ms": 400, "grid": (5, 3), "mode": "grid_norm_motion"},
    {"name": "C21_motion_nodens_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "nodens"},
    {"name": "C22_motion_strict_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "strict"},
    {"name": "C23_density_only_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "density_only"},
    {"name": "C24_motion_nodens_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "nodens"},
    {"name": "C25_motion_full_K8_w400_nonoverlap", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "stride_mode": "nonoverlap"},
    {"name": "C26_motion_full_K8_w400_clean", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "exclude_sessions": ["retina-events-20261029-210102"]},
    {"name": "C27_motion_full_K8_w400_keephard", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "held_class2": ["retina-events-20261029-211950", "retina-events-20261029-212036"]},
    {"name": "C28_motion_full_K8_w400_densband", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "density_band": (1000, 2400)},
    {"name": "C29_motion_nodens_K8_w400_densband", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "nodens", "density_band": (1000, 2400)},
    {"name": "C30_motion_strict_K8_w400_densband", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "density_band": (1000, 2400)},
    {"name": "C31_grid_norm_motion_strict_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_norm_motion", "feature_set": "strict"},
    {"name": "C32_grid_norm_motion_strict_K8_w400_densband", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_norm_motion", "feature_set": "strict", "density_band": (1000, 2400)},
    {"name": "C33_grid_norm_only_K8_w400", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "grid_norm"},
    {"name": "C34_motion_strict_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict"},
    {"name": "C35_motion_strict_K12_w600", "K": 12, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict"},
    {"name": "C36_motion_strict_K8_w600_densband", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "density_band": (1000, 2400)},
    {"name": "C37_motion_strict_K8_w600_nonoverlap", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "stride_mode": "nonoverlap"},
    {"name": "C38_motion_strict_K8_w600_clean", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "exclude_sessions": ["retina-events-20261029-210102"]},
    {"name": "C39_motion_strict_K8_w600_keephard", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "held_class2": ["retina-events-20261029-211950", "retina-events-20261029-212036"]},
    {"name": "C40_motion_strict_K8_w600_aug", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "motion", "feature_set": "strict", "lam": 1.0},
    {"name": "D1_dim_only_K8_w600_bbox", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only"},
    {"name": "D2_dim_density_K8_w600_bbox", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_density"},
    {"name": "D3_density_only_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "density_only"},
    {"name": "D4_dim_only_K8_w400_bbox", "K": 8, "win_ms": 400, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only"},
    {"name": "D5_dim_only_K8_w600_cells", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only", "scale_mode": "cells"},
    {"name": "D6_dim_only_K12_w600_bbox", "K": 12, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only"},
    {"name": "D7_dim_only_K8_w800_bbox", "K": 8, "win_ms": 800, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only"},
    {"name": "D8_dim_only_K8_w600_densband", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only", "density_band": (1000, 2400)},
    {"name": "D9_dim_density_K8_w600_densband", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_density", "density_band": (1000, 2400)},
    {"name": "D10_dim_only_K8_w600_nonoverlap", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "dim_only", "stride_mode": "nonoverlap"},
    {"name": "E1_dim_two_scalars_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "two"},
    {"name": "E2_dim_two_scalars_K8_w600_densband", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "two", "density_band": (1000, 2400)},
    {"name": "E3_dim_minimal_K8_w600", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "minimal"},
    {"name": "E4_dim_minimal_K8_w600_densband", "K": 8, "win_ms": 600, "grid": (10, 6), "mode": "dim", "dim_variant": "minimal", "density_band": (1000, 2400)},
]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=ROOT)
    ap.add_argument("--configs", default="all")
    ap.add_argument("--no-aug", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--mode", choices=("table", "lfo", "cov", "dimstats"), default="table")
    ap.add_argument("--config", default="C34_motion_strict_K8_w600")
    args = ap.parse_args(argv)
    specs = B.load_v2_sessions(args.data_root)
    print(f"# sessions={len(specs)} class1={sum(s.cls==1 for s in specs)} "
          f"class2={sum(s.cls==2 for s in specs)} class0={sum(s.cls==0 for s in specs)}")
    if args.mode == "lfo":
        cfg = next(c for c in CONFIGS if c["name"] == args.config)
        folds = evaluated_lfo(specs, cfg, use_aug=not args.no_aug)
        vals = [f["recall_class1"] for f in folds if f["recall_class1"] is not None]
        print(f"{cfg['name']} class1 LFO: recall={np.mean(vals):.4f}+-{np.std(vals):.4f} "
              f"fold_n={len(folds)}")
        for f in folds:
            print(f"  {f['held'][-6:]} n={f['class1_n']} recall={f['recall_class1']:.4f} "
                  f"bal={f['balanced_acc']:.4f}")
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_feat_lfo_result.json"),
                  "w", encoding="utf-8") as fh:
            json.dump({"config": cfg["name"], "folds": folds}, fh, ensure_ascii=False, indent=2)
        print("LFO_DONE=1")
        return 0
    if args.mode == "dimstats":
        cfg = next(c for c in CONFIGS if c["name"] == args.config)
        out = dimensionless_stats(specs, cfg)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_feat_dimstats.json"),
                  "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print("DIMSTATS_DONE=1")
        return 0
    if args.mode == "cov":
        cfg = next(c for c in CONFIGS if c["name"] == args.config)
        out = distance_stats(specs, cfg)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_feat_cov_result.json"),
                  "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print("COV_DONE=1")
        return 0
    rows = []
    for cfg in CONFIGS:
        if args.configs != "all" and cfg["name"] not in args.configs.split(","):
            continue
        folds = evaluated_config(specs, cfg, use_aug=not args.no_aug, verbose=args.verbose)
        mean, std, bmean, bstd = summarize(folds)
        rows.append({"config": cfg["name"], "folds": folds, "mean_recall_class2": mean,
                     "std_recall_class2": std, "mean_balanced_acc": bmean,
                     "std_balanced_acc": bstd})
        print(f"{cfg['name']}: recall_class2={mean:.4f}+-{std:.4f} "
              f"balanced_acc={bmean:.4f}+-{bstd:.4f} folds="
              + ",".join(f"{f['held'][-6:]}:{f['recall_class2']:.3f}" for f in folds))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_feat_study_result.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f"# wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
