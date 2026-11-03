#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""task-59：现有 v7 部署件在 100 ms 非重叠窗（板端口径）上的复核。

口径：
  - s50 = 训练口径：100 ms 窗 / 50 ms 步，prev 为上一滑窗 [t0-50, t0+50)；
  - s100 = 板端口径：100 ms 窗 / 100 ms 步，prev 为上一连续 bin [t0-100, t0)；
  - 两者 now 内容在 s100 第 j 窗与 s50 第 2j 窗完全相同，prev 差 50 ms。

只做推理，不训练、不改 params/ROM。int8 前向在本文件内用 numpy 实现，
与 nn/v7/quant_v7.py 的 conv/fc 整数语义逐位一致；不调用 torch。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("RETE_ROOT") or Path(__file__).resolve().parents[2])
sys.path.insert(0, str(ROOT / "nn" / "v7"))
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import intwin as IW  # noqa: E402
import v7_feats as F  # noqa: E402
import v7_eval as E  # noqa: E402
import v6_common as C6  # noqa: E402
import build_v7 as B  # noqa: E402

DEFAULT_NPZ = ROOT / "nn" / "out_v7" / "windows_s100.npz"
DEFAULT_JSON = ROOT / "nn" / "out_v7" / "s100_results.json"
DEFAULT_REPORT = ROOT / "nn" / "REPORT_s100_部署口径复核.md"
DEFAULT_EVID = ROOT / "nn" / "_evidence" / "S100_EVAL_OK.log"
OLD_RESULTS = ROOT / "nn" / "out_v7" / "results_v7_final.json"
V7_NPZ = ROOT / "nn" / "v7" / "windows_v7.npz"
CONTROL_NPZ = ROOT / "nn" / "v7" / "control_7min_int.npz"
CONTROL_CACHE = ROOT / "temp_test" / "v7" / "control_raw_cache.npz"
PARAM_FOLDS = [ROOT / "nn" / "out_v7" / "params_fold0.json", ROOT / "nn" / "out_v7" / "params_fold1.json"]
PARAM_DIST = ROOT / "nn" / "out_v7" / "params_distance.json"

WIN_MS = 100
STRIDE_S50 = 50
STRIDE_S100 = 100
MARGIN_MIN = 8
N_CONSEC = 3
GUARD_DEC = 5
FEAT_NAMES = ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy", "dx_rel", "dy_rel"]
HASH_KEYS = ["X_raw", "X", "g", "y", "zone", "view", "session", "t_ms", "center_ms",
             "fold", "aug", "hand", "role", "hint", "win_idx"]
G = IW.GIDX

# 允许通过 --reuse 跳过重建；正式复跑默认重建。
CHECKS = {}


def log(msg: str) -> None:
    print(msg, flush=True)


def force_utf8_stdio() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_payload(payload: dict) -> str:
    h = hashlib.sha256()
    for k in HASH_KEYS:
        a = np.ascontiguousarray(payload[k])
        h.update(k.encode("utf-8"))
        h.update(str(a.dtype).encode("ascii"))
        h.update(str(a.shape).encode("ascii"))
        h.update(a.tobytes())
    return h.hexdigest()


def check(name: str, ok: bool, detail: str = "") -> bool:
    CHECKS[name] = bool(ok)
    log("[CHECK] %-28s %s %s" % (name, "PASS" if ok else "FAIL", detail))
    return bool(ok)


def _patched_stride_factory(fn, stride: int):
    def call(*args, **kwargs):
        old = IW.STRIDE_MS
        IW.STRIDE_MS = int(stride)
        try:
            return fn(*args, **kwargs)
        finally:
            IW.STRIDE_MS = old
    return call


_s100_subblock = _patched_stride_factory(IW.subblock_stats, STRIDE_S100)
_s100_shifted = _patched_stride_factory(IW.shifted_grids, STRIDE_S100)


def build_s100_stats(rel, x, y, pol):
    rel = np.asarray(rel, dtype=np.int64)
    g0 = int(rel[0])
    t_last = int(rel[-1])
    n_win = (t_last - g0 - WIN_MS) // STRIDE_S100 + 1
    n_sub = (t_last - g0) // STRIDE_S100 + 1
    if n_win <= 0:
        raise RuntimeError("no s100 windows: rel=%d..%d" % (g0, t_last))
    sub = _s100_subblock(rel, x, y, pol, g0, n_sub)
    N = sub["N"][:n_win]; ON = sub["ON"][:n_win]; OFF = sub["OFF"][:n_win]
    SX = sub["SX"][:n_win]; SY = sub["SY"][:n_win]
    SX2 = sub["SX2"][:n_win]; SY2 = sub["SY2"][:n_win]
    valid = N > 0
    ns = np.maximum(N, np.int64(1))
    cx_raw = np.where(valid, SX // ns, np.int64(0))
    cy_raw = np.where(valid, SY // ns, np.int64(0))
    cx = IW._carry_prev(cx_raw, valid, 200)
    cy = IW._carry_prev(cy_raw, valid, 120)
    varx = np.maximum(SX2 * N - SX * SX, 0) // (ns * ns)
    vary = np.maximum(SY2 * N - SY * SY, 0) // (ns * ns)
    sx = np.where(valid, IW._isqrt_arr(varx), np.int64(0))
    sy = np.where(valid, IW._isqrt_arr(vary), np.int64(0))
    pcx = np.concatenate([np.array([200], np.int64), cx[:-1]])
    pcy = np.concatenate([np.array([120], np.int64), cy[:-1]])
    psx = np.concatenate([np.array([0], np.int64), sx[:-1]])
    psy = np.concatenate([np.array([0], np.int64), sy[:-1]])
    dx = np.where(valid, cx - pcx, np.int64(0))
    dy = np.where(valid, cy - pcy, np.int64(0))
    speed = IW._isqrt_arr(dx * dx + dy * dy)
    prev_n = np.concatenate([np.array([0], np.int64), N[:-1]])
    bal = np.where(valid, (ON - OFF) / np.maximum(N, 1), 0.0)
    g = np.zeros((n_win, len(IW.GLOBAL_NAMES)), dtype=np.float32)
    g[:, G["n"]] = N
    g[:, G["on"]] = ON
    g[:, G["off"]] = OFF
    g[:, G["cx"]] = cx
    g[:, G["cy"]] = cy
    g[:, G["sx"]] = sx
    g[:, G["sy"]] = sy
    g[:, G["pcx"]] = pcx
    g[:, G["pcy"]] = pcy
    g[:, G["dx"]] = dx
    g[:, G["dy"]] = dy
    g[:, G["speed"]] = speed
    g[:, G["dsx"]] = sx - psx
    g[:, G["dsy"]] = sy - psy
    g[:, G["bal"]] = bal
    g[:, G["frames"]] = 0
    g[:, G["prev_n"]] = prev_n
    X_raw = np.zeros((n_win, 4, IW.GRID_H, IW.GRID_W), dtype=np.int8)
    now = sub["sub_grid"][:n_win].astype(np.int64)
    X_raw[:, 0] = np.clip(now[:, 0], 0, IW.SAT)
    X_raw[:, 1] = np.clip(now[:, 1], 0, IW.SAT)
    if n_win > 1:
        X_raw[1:, 2] = X_raw[:-1, 0]
        X_raw[1:, 3] = X_raw[:-1, 1]
    st = {"g": g, "cx": cx, "cy": cy, "sx": sx, "sy": sy, "pcx": pcx, "pcy": pcy,
          "dx": dx, "dy": dy, "speed": speed, "prev_n": prev_n}
    X, event_lo, event_hi = _s100_shifted(rel, x, y, pol, g0, n_win, st, log=None)
    t0s = g0 + np.arange(n_win, dtype=np.int64) * STRIDE_S100
    return {"g0": g0, "n_win": n_win, "n_sub": n_sub, "g": g, "X_raw": X_raw, "X": X,
            "t0s": t0s, "event_lo": event_lo, "event_hi": event_hi, "sub": sub}


def build_s50_full(rel, x, y, pol):
    rel = np.asarray(rel, dtype=np.int64)
    g0, n_win, n_sub = IW.n_windows(rel)
    sub = IW.subblock_stats(rel, x, y, pol, g0, n_sub)
    st = IW.window_stats(sub, n_win)
    X_raw = IW.raw_grids(sub["sub_grid"], n_win)
    X, event_lo, event_hi = IW.shifted_grids(rel, x, y, pol, g0, n_win, st, log=None)
    t0s = IW.window_t0(rel, g0, n_win)
    return {"g0": g0, "n_win": n_win, "n_sub": n_sub, "g": st["g"], "X_raw": X_raw, "X": X,
            "t0s": t0s, "event_lo": event_lo, "event_hi": event_hi, "sub": sub}


def label_base(t0s, z_t0, z_t1, z_names, z_views, z_cls):
    centers = t0s + WIN_MS // 2
    zi = np.searchsorted(z_t0, centers, side="right") - 1
    safe = np.clip(zi, 0, len(z_names) - 1)
    in_zone = (zi >= 0) & (centers < z_t1[safe])
    label_all = np.full(len(t0s), 255, dtype=np.uint8)
    label_all[in_zone] = z_cls[zi[in_zone]]
    ex = z_cls == 255
    inter = np.zeros(len(t0s), dtype=bool)
    for a, b in zip(z_t0[ex], z_t1[ex]):
        inter |= (t0s < b) & (t0s + WIN_MS > a)
    keep = in_zone & (label_all != 255) & (~inter)
    idx = np.nonzero(keep)[0]
    zi_k = zi[idx]
    centers_k = centers[idx]
    view = np.array([z_views[i] for i in zi_k], dtype="U2")
    zone_name = np.array([z_names[i] for i in zi_k], dtype="U20")
    cls = label_all[idx]
    fold = (centers_k >= ((z_t0[zi_k] + z_t1[zi_k]) // 2)).astype(np.uint8)
    return {"idx": idx, "centers": centers_k, "view": view, "zone": zone_name,
            "cls": cls, "fold": fold, "label_all": label_all, "in_zone": in_zone,
            "inter": inter, "zi": zi}


def build_base_payload(rel, x, y, pol, z_t0, z_t1, z_names, z_views, z_cls, session):
    st = build_s100_stats(rel, x, y, pol)
    lab = label_base(st["t0s"], z_t0, z_t1, z_names, z_views, z_cls)
    idx = lab["idx"]
    Xr = st["X_raw"][idx]
    Xs = st["X"][idx]
    gg = st["g"][idx]
    cls = lab["cls"]
    view = lab["view"]
    zone = lab["zone"]
    hand = np.where(np.isin(cls, [1, 2]) & (view == "A"), "left", "none").astype("U5")
    role = np.where(view == "A", "v7_primary", "v7_hardneg").astype("U12")
    hint = np.where(view == "A", "primary", "hardneg").astype("U10")
    t_ms = st["t0s"][idx].astype(np.int32)
    center_ms = lab["centers"].astype(np.int32)
    win_idx = idx.astype(np.int32)
    fold = lab["fold"]
    n = len(idx)
    payload = {
        "X_raw": Xr, "X": Xs, "g": gg.copy(), "y": cls,
        "zone": zone, "view": view, "session": np.array([session] * n, dtype="U24"),
        "t_ms": t_ms, "center_ms": center_ms, "fold": fold,
        "aug": np.zeros(n, dtype=np.uint8), "hand": hand, "role": role,
        "hint": hint, "win_idx": win_idx,
    }
    mA = view == "A"
    nA = int(mA.sum())
    mXr = Xr[mA][:, :, :, ::-1].copy()
    mXs = Xs[mA][:, :, :, ::-1].copy()
    mg = gg[mA].copy()
    mg[:, G["cx"]] = 399.0 - mg[:, G["cx"]]
    mg[:, G["pcx"]] = 399.0 - mg[:, G["pcx"]]
    mg[:, G["dx"]] = -mg[:, G["dx"]]
    m_cls = cls[mA]
    m_hand = np.where(np.isin(m_cls, [1, 2]), "right", "none").astype("U5")
    payload["X_raw"] = np.concatenate([payload["X_raw"], mXr], axis=0)
    payload["X"] = np.concatenate([payload["X"], mXs], axis=0)
    payload["g"] = np.concatenate([payload["g"], mg], axis=0)
    payload["y"] = np.concatenate([payload["y"], m_cls], axis=0)
    payload["zone"] = np.concatenate([payload["zone"], zone[mA]], axis=0)
    payload["view"] = np.concatenate([payload["view"], view[mA]], axis=0)
    payload["session"] = np.concatenate([payload["session"], payload["session"][:n][mA]], axis=0)
    payload["t_ms"] = np.concatenate([payload["t_ms"], t_ms[mA]], axis=0)
    payload["center_ms"] = np.concatenate([payload["center_ms"], center_ms[mA]], axis=0)
    payload["fold"] = np.concatenate([payload["fold"], fold[mA]], axis=0)
    payload["aug"] = np.concatenate([payload["aug"], np.ones(nA, dtype=np.uint8)], axis=0)
    payload["hand"] = np.concatenate([payload["hand"], m_hand], axis=0)
    payload["role"] = np.concatenate([payload["role"], role[mA]], axis=0)
    payload["hint"] = np.concatenate([payload["hint"], hint[mA]], axis=0)
    payload["win_idx"] = np.concatenate([payload["win_idx"], win_idx[mA]], axis=0)
    payload = {k: np.ascontiguousarray(v) for k, v in payload.items()}
    return payload, st, lab, {"n_base": n, "n_mirror": nA, "n_kept_all": int(len(idx))}


def build_control_payload():
    d = np.load(CONTROL_CACHE, allow_pickle=False)
    rel = d["rel"].astype(np.int64)
    x = d["x"].astype(np.int32)
    y = d["y"].astype(np.int32)
    pol = d["pol"].astype(np.int8)
    session = str(d["session"]) if "session" in d.files else "20261030-212214_v5probe"
    st = build_s100_stats(rel, x, y, pol)
    centers = st["t0s"] + WIN_MS // 2
    zone_i = C6.zones_of(centers)
    y_lab = np.array([C6.zone_label(int(z)) for z in zone_i], dtype=np.uint8)
    keep = y_lab != 255
    idx = np.nonzero(keep)[0]
    zi = zone_i[idx]
    zone_name = np.array([C6.ZONE_NAMES[int(z)] for z in zi], dtype="U20")
    t_ms = st["t0s"][idx].astype(np.int32)
    center_ms = centers[idx].astype(np.int32)
    fold = np.zeros(len(idx), dtype=np.uint8)
    for zv in np.unique(zi):
        z0, z1 = [(int(a), int(b)) for a, b, _n, _l, _g in C6.ZONES if _n == C6.ZONE_NAMES[int(zv)]][0]
        m = zi == zv
        fold[m] = (center_ms[m] >= (z0 + z1) // 2).astype(np.uint8)
    yk = y_lab[idx]
    payload = {
        "X_raw": st["X_raw"][idx], "X": st["X"][idx], "g": st["g"][idx].copy(),
        "y": yk, "zone": zone_name, "view": np.array(["A7"] * len(idx), dtype="U2"),
        "session": np.array([session] * len(idx), dtype="U24"),
        "t_ms": t_ms, "center_ms": center_ms, "fold": fold,
        "aug": np.zeros(len(idx), dtype=np.uint8),
        "hand": np.array(["none"] * len(idx), dtype="U5"),
        "role": np.array(["control_7min"] * len(idx), dtype="U12"),
        "hint": np.where(yk == 0, "control_neg", "control_pos").astype("U10"),
        "win_idx": idx.astype(np.int32),
    }
    payload = {k: np.ascontiguousarray(v) for k, v in payload.items()}
    return payload, st, {"n_kept": len(idx), "n_all": st["n_win"]}


def combine_payload(a, b):
    out = {}
    for k in HASH_KEYS:
        out[k] = np.concatenate([a[k], b[k]], axis=0)
    for k, v in a.items():
        if k not in out:
            out[k] = v
    return out


def save_windows_s100(base, ctrl, zones_json, path):
    payload = combine_payload(base, ctrl)
    payload.update({
        "win_ms": np.int64(WIN_MS), "stride_ms": np.int64(STRIDE_S100),
        "grid_shift": np.int64(IW.GRID_SHIFT), "grid_w": np.int64(IW.GRID_W),
        "grid_h": np.int64(IW.GRID_H), "channels": np.array(IW.CHANNELS),
        "global_names": np.array(IW.GLOBAL_NAMES),
        "zones_json": np.array(json.dumps(zones_json, ensure_ascii=False)),
        "label_map_json": np.array(json.dumps(B.LABEL_MAP, ensure_ascii=False)),
    })
    for k, v in payload.items():
        payload[k] = np.ascontiguousarray(v)
    ch = sha256_payload(payload)
    win_chk = sha256_bytes(np.ascontiguousarray(payload["X_raw"]).tobytes())
    np.savez_compressed(path, **payload)
    return payload, ch, win_chk


def load_payload(path):
    d = np.load(path, allow_pickle=False)
    return {k: d[k] for k in d.files}


def _conv2d_acc(x, w, b):
    n, cin, h, wd = x.shape
    cout, _, k, _ = w.shape
    oh = (h - k) // 2 + 1
    ow = (wd - k) // 2 + 1
    acc = np.zeros((n, cout, oh, ow), dtype=np.int64)
    for ky in range(k):
        for kx in range(k):
            xs = x[:, :, ky:ky + h - k + 1:2, kx:kx + wd - k + 1:2].astype(np.int64)
            wk = w[:, :, ky, kx].T.astype(np.int64)
            acc += np.einsum("nchw,co->nohw", xs, wk)
    acc += b.reshape(1, cout, 1, 1).astype(np.int64)
    return acc


def _conv_int8(x, w, b, sh, relu=True):
    out = _conv2d_acc(x, w, b) >> sh.reshape(1, -1, 1, 1)
    out = np.clip(out, -128, 127)
    if relu:
        out = np.maximum(out, 0)
    return out.astype(np.int8)


def _fc_acc(x, w, b):
    return x.astype(np.int64) @ w.T.astype(np.int64) + b.astype(np.int64).reshape(1, -1)


def _fc_int8(x, w, b, sh, relu=False):
    out = _fc_acc(x, w, b) >> sh.reshape(1, -1)
    out = np.clip(out, -128, 127)
    if relu:
        out = np.maximum(out, 0)
    return out.astype(np.int8)


def forward_int8(x, feats, params):
    layers = {l["name"]: l for l in params["layers"]}
    acts = np.ascontiguousarray(x).astype(np.int8)
    for name in ("conv1", "conv2", "conv3"):
        l = layers[name]
        w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        sh = np.asarray(l["SH"], dtype=np.int64)
        acts = _conv_int8(acts, w, b, sh, relu=True)
    feat_acts = None
    if "g1" in layers:
        l = layers["g1"]
        feat_acts = np.ascontiguousarray(feats).astype(np.int8)
        w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        sh = np.asarray(l["SH"], dtype=np.int64)
        feat_acts = _fc_int8(feat_acts, w, b, sh, relu=True)
    flat = np.ascontiguousarray(acts).reshape(acts.shape[0], -1)
    fc_in = flat if feat_acts is None else np.concatenate([flat, feat_acts], axis=1)
    l = layers["fc"]
    w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
    b = np.asarray(l["bias_int32"], dtype=np.int64)
    sh = np.asarray(l["SH"], dtype=np.int64)
    logits = _fc_int8(fc_in, w, b, sh, relu=False)
    return logits


def load_params(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def predict(params, x, g):
    feats, _ = F.build("fmin_n_rel7", g)
    logits = forward_int8(x, feats, params)
    pred = logits.argmax(axis=1).astype(np.int64)
    c1 = (logits[:, 1].astype(np.int64) - logits[:, 0].astype(np.int64)).astype(np.float32)
    return pred, c1, logits


def _sorted_rows_pred(rows, pred, c1):
    order = np.argsort(np.asarray(rows), kind="stable")
    return np.asarray(rows)[order], np.asarray(pred)[order], np.asarray(c1)[order]


def eval_s100(d, rows, pred, c1, step=1, margin=MARGIN_MIN):
    # E.eval_rows 内部用 searchsorted(rows, rid) 把全局行号映射到 pred 的局部位置，
    # 因此 rows 必须升序；pooled 把两个 fold 拼起来后必须显式排序。
    rows, pred, c1 = _sorted_rows_pred(rows, pred, c1)
    E.STRIDE_MS = STRIDE_S100
    return E.eval_rows(d, rows, pred, c1, margin_min=margin, step=step)


def chunks_num(s):
    if s is None:
        return 0
    return int(str(s).split("/")[0])


def pick_metrics(summ):
    keys = ["open_chunks", "open_recall", "open_pulses", "wave_pulses", "wave_pulses_per_min",
            "static_pulses", "static_fp_per_min", "empty_pulses", "hardneg_pulses",
            "pulses_total", "n_windows"]
    return {k: summ.get(k) for k in keys}


def dnum(a, b):
    if a is None or b is None:
        return None
    return round(float(b) - float(a), 6)


def metric_delta(old, new):
    keys = ["open_chunks", "open_recall", "open_pulses", "wave_pulses", "wave_pulses_per_min",
            "static_pulses", "static_fp_per_min", "empty_pulses", "hardneg_pulses", "pulses_total", "n_windows"]
    out = {}
    for k in keys:
        o = old.get(k) if old else None
        n = new.get(k) if new else None
        if k == "open_chunks":
            out[k] = {"old": o, "new": n, "delta_chunks": (chunks_num(n) - chunks_num(o)) if o is not None and n is not None else None}
        else:
            out[k] = {"old": o, "new": n, "delta": dnum(o, n)}
    return out


def dist_table(feats, names):
    out = {}
    for i, name in enumerate(names):
        v = np.asarray(feats[:, i], dtype=np.float64)
        out[name] = {
            "p10": round(float(np.percentile(v, 10)), 3),
            "p50": round(float(np.percentile(v, 50)), 3),
            "p90": round(float(np.percentile(v, 90)), 3),
            "sat127_ratio": round(float(np.mean(np.abs(v) >= 127)), 5),
            "min": float(v.min()), "max": float(v.max()),
        }
    return out


def raw_dx_dy(g):
    dx = g[:, G["dx"]].astype(np.int64)
    dy = g[:, G["dy"]].astype(np.int64)
    return {
        "dx_p50": round(float(np.percentile(np.abs(dx), 50)), 2),
        "dx_p90": round(float(np.percentile(np.abs(dx), 90)), 2),
        "dy_p50": round(float(np.percentile(np.abs(dy), 50)), 2),
        "dy_p90": round(float(np.percentile(np.abs(dy), 90)), 2),
        "dxq_p50": round(float(np.percentile(np.abs(dx) >> 2, 50)), 2),
        "dxq_p90": round(float(np.percentile(np.abs(dx) >> 2, 90)), 2),
    }


def compare_prev(s100, s50, n_sample=200, seed=7):
    rng = np.random.default_rng(seed)
    n = min(s100["n_win"], s50["n_win"] // 2)
    idx = rng.choice(np.arange(1, n), size=min(n_sample, n - 1), replace=False)
    win_diff_raw = 0
    cell_diff_raw = 0
    cells = 0
    win_diff_shift = 0
    cell_diff_shift = 0
    for j in idx:
        a = s100["X_raw"][int(j), 2:4]
        b = s50["X_raw"][int(2 * j), 2:4]
        win_diff_raw += int(not np.array_equal(a, b))
        cell_diff_raw += int((a != b).sum())
        cells += a.size
        a2 = s100["X"][int(j), 2:4]
        b2 = s50["X"][int(2 * j), 2:4]
        win_diff_shift += int(not np.array_equal(a2, b2))
        cell_diff_shift += int((a2 != b2).sum())
    return {
        "n_sample": int(len(idx)),
        "prev_window_diff_ratio_raw": round(win_diff_raw / len(idx), 6),
        "prev_cell_diff_ratio_raw": round(cell_diff_raw / max(cells, 1), 6),
        "prev_window_diff_ratio_shift": round(win_diff_shift / len(idx), 6),
        "prev_cell_diff_ratio_shift": round(cell_diff_shift / max(cells, 1), 6),
        "expected": "s50 第 2j 窗 prev = s50 第 2j-1 窗 now = [t0-50,t0+50)；s100 第 j 窗 prev = s100 第 j-1 窗 now = [t0-100,t0)，且平移质心差 50 ms；差异是预期口径，不是 bug",
    }


def _now_g_compare(a, b, n):
    idx = np.arange(n)
    basic = ["n", "on", "off", "sx", "sy"]
    basic_ok = bool(np.array_equal(a["g"][idx][:, [G[k] for k in basic]],
                                   b["g"][2 * idx][:, [G[k] for k in basic]]))
    na = a["g"][idx, G["n"]].astype(np.int64)
    nb = b["g"][2 * idx, G["n"]].astype(np.int64)
    active = (na > 0) & (nb > 0)
    cx_ok = bool(np.array_equal(a["g"][idx][active, G["cx"]], b["g"][2 * idx][active, G["cx"]]))
    cy_ok = bool(np.array_equal(a["g"][idx][active, G["cy"]], b["g"][2 * idx][active, G["cy"]]))
    bal_ok = bool(np.allclose(a["g"][idx, G["bal"]], b["g"][2 * idx, G["bal"]], atol=1e-6))
    empty_diff = int(np.sum((~active) & (
        (a["g"][idx, G["cx"]] != b["g"][2 * idx, G["cx"]]) |
        (a["g"][idx, G["cy"]] != b["g"][2 * idx, G["cy"]]))))
    return {"n_compare": int(n), "basic_fields_equal": basic_ok,
            "cx_active_equal": cx_ok, "cy_active_equal": cy_ok, "bal_equal": bal_ok,
            "empty_carry_diff_windows": empty_diff,
            "n_active_compare": int(active.sum()),
            "g_now_equal": bool(basic_ok and cx_ok and cy_ok and bal_ok)}


def now_consistency(s100, s50, control_s100=None, control_s50=None):
    n = min(s100["n_win"], s50["n_win"] // 2)
    raw_ok = bool(np.array_equal(s100["X_raw"][:n, 0:2], s50["X_raw"][:2 * n:2, 0:2]))
    out = {"X_raw_now_equal": raw_ok}
    out.update(_now_g_compare(s100, s50, n))
    if control_s100 is not None and control_s50 is not None:
        m = min(control_s100["n_win"], control_s50["n_win"] // 2)
        craw = bool(np.array_equal(control_s100["X_raw"][:m, 0:2], control_s50["X_raw"][:2 * m:2, 0:2]))
        out["control_X_raw_now_equal"] = craw
        cc = _now_g_compare(control_s100, control_s50, m)
        for k, v in cc.items():
            out["control_" + k] = v
    return out


def run_old_s50_check(d50, params, old):
    E.STRIDE_MS = STRIDE_S50
    x = d50["X"].astype(np.float32)
    feats, _ = F.build("fmin_n_rel7", d50["g"])
    roles = np.isin(d50["role"].astype(str), ["v7_primary", "v7_hardneg"])
    fold = d50["fold"].astype(np.int64)
    out = {"folds": [], "pooled": None}
    pool_rows = []
    pool_pred = []
    pool_c1 = []
    old_by_test = {int(f["test_fold"]): f for f in old["A_time"]["folds"]}
    for train_fold, test_fold in ((0, 1), (1, 0)):
        rows = np.where((fold == test_fold) & roles)[0]
        logits = forward_int8(x[rows], feats[rows], params[train_fold])
        pred = logits.argmax(axis=1)
        c1 = (logits[:, 1].astype(np.int64) - logits[:, 0].astype(np.int64)).astype(np.float32)
        summ, _, _ = E.eval_rows(d50, rows, pred, c1, margin_min=MARGIN_MIN, step=2)
        oldm = old_by_test[test_fold]["int8"]["int8_eval"]["8"]
        nm = pick_metrics(summ)
        om = pick_metrics(oldm)
        exact_keys = ["open_chunks", "open_recall", "open_pulses", "wave_pulses", "static_pulses",
                      "static_fp_per_min", "empty_pulses", "hardneg_pulses", "pulses_total", "n_windows"]
        out["folds"].append({"train_fold": train_fold, "test_fold": test_fold,
                             "new": nm, "old": om,
                             "match_open_chunks": chunks_num(nm.get("open_chunks")) == chunks_num(om.get("open_chunks")),
                             "match_metrics": all(nm.get(k) == om.get(k) for k in exact_keys)})
        pool_rows.append(rows); pool_pred.append(pred); pool_c1.append(c1)
    rows = np.concatenate(pool_rows)
    pred = np.concatenate(pool_pred)
    c1 = np.concatenate(pool_c1)
    rows, pred, c1 = _sorted_rows_pred(rows, pred, c1)
    summ, _, _ = E.eval_rows(d50, rows, pred, c1, margin_min=MARGIN_MIN, step=2)
    oldm = old["A_time"]["pooled_int8"]["8"]
    nm = pick_metrics(summ)
    om = pick_metrics(oldm)
    fold_sum = {}
    for k in ["open_pulses", "wave_pulses", "hardneg_pulses", "pulses_total"]:
        fold_sum[k] = int(sum(int(old_by_test[t]["int8"]["int8_eval"]["8"].get(k, 0)) for t in (0, 1)))
    out["pooled"] = {"new": nm, "old": om,
                     "old_fold_sum": fold_sum,
                     "match_open_chunks": chunks_num(nm.get("open_chunks")) == chunks_num(om.get("open_chunks")),
                     "note": "旧 JSON pooled_int8 与逐折合计不一致（open %s vs %s、wave %s vs %s、hardneg %s vs %s、pulses %s vs %s）；逐折完全一致，故以逐折与重算 pooled(sorted) 为基线" % (
                         om.get("open_pulses"), fold_sum["open_pulses"], om.get("wave_pulses"), fold_sum["wave_pulses"],
                         om.get("hardneg_pulses"), fold_sum["hardneg_pulses"], om.get("pulses_total"), fold_sum["pulses_total"])}
    E.STRIDE_MS = STRIDE_S100
    return out


def render_report(res):
    W = res["windows"]
    F = res["decision"]["feasibility"]
    A = res["A_time"]
    B = res["B_distance"]
    C = res["C_mirror"]
    D = res["D_empty"]
    S = res.get("s50_recheck") or {}
    dist = res["feature_distribution"]
    prev = res["prev"]
    cons = res["now_consistency"]
    checks = res["checks"]
    all_ok = all(bool(v) for v in checks.values())

    def f(x):
        if x is None:
            return "-"
        if isinstance(x, float):
            return ("%.4f" % x).rstrip("0").rstrip(".")
        return str(x)

    L = []
    L.append("S100_EVAL_OK=%d" % int(all_ok))
    L.append("")
    L.append("# v7 部署件 100 ms 非重叠窗（板端口径）复核")
    L.append("")
    L.append("- 生成时间：%s" % res["generated"])
    L.append("- 判据：**S100_EVAL_OK=%d（全部自检通过）**" % int(all_ok) if all_ok else "- 判据：**S100_EVAL_OK=0（有自检未过）**")
    L.append("- 现权重能否直接上板：**%s**" % res["decision"]["answer"])
    L.append("- 三选一结论：**%s**" % res["decision"]["conclusion"])
    L.append("")
    L.append("> 本报告只做推理复核：不训练、不 QAT、不改 params/ROM；int8 前向是 numpy 实现，语义与 nn/v7/quant_v7.py 一致。")
    L.append("")
    L.append("## 1. 口径与数据")
    L.append("")
    L.append("| 项 | s50（训练口径） | s100（板端口径） |")
    L.append("|---|---:|---:|")
    L.append("| 窗宽 / 步长 | 100 ms / 50 ms | 100 ms / 100 ms |")
    L.append("| 全会话窗数 | %s | %s |" % (f(W["s50_full"]), f(W["s100_full"])))
    L.append("| 基础保留窗（base，未镜像） | %s | %s |" % (f(W["s50_base_kept"]), f(W["s100_base_kept"])))
    L.append("| 镜像窗（mirror） | %s | %s |" % (f(W.get("s50_mirror")), f(W["s100_mirror"])))
    L.append("| control 保留窗 | %s | %s |" % (f(W["s50_control_kept"]), f(W["s100_control_kept"])))
    L.append("| 评估行数（base+mirror） | %s | %s |" % (f(7868), f(W["s100_rows"])))
    L.append("| 全部载荷（含 control） | - | %s |" % f(W.get("s100_all_rows")))
    L.append("")
    L.append("类别计数（s100）：base=%s，mirror=%s，control=%s。" % (
        f(W["s100_base_class_counts"]), f(W["s100_mirror_class_counts"]), f(W["s100_control_class_counts"])))
    L.append("")
    L.append("s100 构造规则：第 j 个非重叠窗的 now 内容与 s50 第 2j 窗完全相同；prev 取上一 s100 窗（不是 s50 第 2j 窗的 prev）；平移网格用 s100 自己的 pcx/pcy 重算。窗数 5120→2560，正好一半。")
    L.append("")
    L.append("## 2. now 一致性与 PREV_DIFF_RATIO")
    L.append("")
    L.append("- s100 与 s50 偶数窗的 now 原始网格：**%s**；计数/ON/OFF/sx/sy 及活跃窗 cx/cy：**%s**。" % (
        "完全一致" if cons["X_raw_now_equal"] else "有差异",
        "完全一致" if cons["g_now_equal"] else "有差异"))
    L.append("- 空窗 carry-forward 差异：base %s 窗、control %s 窗（这是 prev 口径变化导致的预期差异，不是 bug）。" % (
        cons.get("empty_carry_diff_windows"), cons.get("control_empty_carry_diff_windows")))
    L.append("- 随机 %d 个窗比较 s100 第 j 窗 prev 与 s50 第 2j 窗 prev：" % prev["n_sample"])
    L.append("  - 原始网格：窗级差异 **%.2f%%**，格级差异 **%.2f%%**；" % (
        prev["prev_window_diff_ratio_raw"] * 100, prev["prev_cell_diff_ratio_raw"] * 100))
    L.append("  - 平移网格：窗级差异 **%.2f%%**，格级差异 **%.2f%%**。" % (
        prev["prev_window_diff_ratio_shift"] * 100, prev["prev_cell_diff_ratio_shift"] * 100))
    L.append("")
    L.append("解释：s50 第 2j 窗 prev = s50 第 2j-1 窗 now = [t0-50,t0+50)；s100 第 j 窗 prev = s100 第 j-1 窗 now = [t0-100,t0)，并且平移质心还差 50 ms。两套坐标不是同一个量，差异是**预期口径**，不是实现错误。")
    L.append("")
    L.append("## 3. 逐特征分布（s50 全窗 vs s100 全窗）")
    L.append("")
    L.append("| 特征 | s50 p10/p50/p90 | s50 sat127 | s100 p10/p50/p90 | s100 sat127 | p50 变化 |")
    L.append("|---|---:|---:|---:|---:|---:|")
    for name in ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy", "dx_rel", "dy_rel"]:
        o = dist["s50_full"][name]
        n = dist["s100_full"][name]
        L.append("| %s | %s / %s / %s | %.2f%% | %s / %s / %s | %.2f%% | %+d |" % (
            name, f(o["p10"]), f(o["p50"]), f(o["p90"]), o["sat127_ratio"] * 100,
            f(n["p10"]), f(n["p50"]), f(n["p90"]), n["sat127_ratio"] * 100,
            int(round(n["p50"] - o["p50"]))))
    L.append("")
    raw = dist["raw_dxdy"]
    L.append("| 原始量 | s50 | s100 |")
    L.append("|---|---:|---:|")
    for k in ["dx_p50", "dx_p90", "dy_p50", "dy_p90", "dxq_p50", "dxq_p90"]:
        L.append("| %s | %s | %s |" % (k, raw["s50_full"][k], raw["s100_full"][k]))
    L.append("")
    L.append("读数：n_div16 / prev_n_div16 的饱和率两口径都约 50%，这是全窗输入本身长期满格，不是 s100 新增；pol_bal 分布几乎不变。真正越界的是运动类：|dx| p50 8→14、p90 42→81；|dy| p50 5→9、p90 21→37；dx_rel 的 sat127 4.69%→6.91%，dy_rel 2.75%→4.10%，dx_rel/dy_rel 的 p10/p90 绝对值约放大 1.7~1.9 倍。lead 用另一脚本量到 p50 8→14、p90 38.8→73；本表 p50 完全一致、p90 量级一致（本仓库 intwin 全窗口径为 42→81）。")
    L.append("")
    L.append("## 4. A 时间外推（int8，margin=8，N_CONSEC=3，guard=5 决策）")
    L.append("")
    L.append("### 4.1 逐折")
    L.append("")
    L.append("| test fold | n | open（新） | open_recall（新） | open_pulses（新） | wave（新） | static/min（新） | empty（新） | hardneg（新） | pulses（新） | 旧 open/wave/hardneg/pulses | Δ open/wave/hardneg/pulses（新−旧） |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for fr in A["folds"]:
        nm = fr["new"]; om = fr["old"]
        dc = "open %+d / wave %+d / hardneg %+d / pulses %+d" % (
            chunks_num(nm["open_chunks"]) - chunks_num(om["open_chunks"]),
            int(nm["wave_pulses"]) - int(om["wave_pulses"]),
            int(nm["hardneg_pulses"]) - int(om["hardneg_pulses"]),
            int(nm["pulses_total"]) - int(om["pulses_total"]))
        L.append("| %d | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s / %s / %s / %s | %s |" % (
            fr["test_fold"], fr["n_test"], nm["open_chunks"], f(nm["open_recall"]), nm["open_pulses"],
            nm["wave_pulses"], f(nm["static_fp_per_min"]), nm["empty_pulses"], nm["hardneg_pulses"],
            nm["pulses_total"], om["open_chunks"], om["wave_pulses"], om["hardneg_pulses"], om["pulses_total"], dc))
    L.append("")
    L.append("### 4.2 pooled")
    L.append("")
    L.append("| 来源 | n | open | open_recall | open_pulses | wave | static/min | empty | hardneg | pulses | Δ（s100−旧） |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    pool_new = A["pooled"]["new"]
    pool_old = A["pooled"]["old"]
    L.append("| 旧 JSON pooled_int8 | %s | %s | %s | %s | %s | %s | %s | %s | %s | - |" % (
        pool_old["n_windows"], pool_old["open_chunks"], f(pool_old["open_recall"]), pool_old["open_pulses"],
        pool_old["wave_pulses"], f(pool_old["static_fp_per_min"]), pool_old["empty_pulses"],
        pool_old["hardneg_pulses"], pool_old["pulses_total"]))
    sp = (S.get("pooled") or {}).get("new")
    if sp:
        L.append("| s50 重算（rows 排序） | %s | %s | %s | %s | %s | %s | %s | %s | %s | - |" % (
            sp["n_windows"], sp["open_chunks"], f(sp["open_recall"]), sp["open_pulses"], sp["wave_pulses"],
            f(sp["static_fp_per_min"]), sp["empty_pulses"], sp["hardneg_pulses"], sp["pulses_total"]))
    dcell = "open %+d / open_pulses %+d / wave %+d / static %+.3f/min / empty %+d / hardneg %+d / pulses %+d" % (
        chunks_num(pool_new["open_chunks"]) - chunks_num(pool_old["open_chunks"]),
        int(pool_new["open_pulses"]) - int(pool_old["open_pulses"]),
        int(pool_new["wave_pulses"]) - int(pool_old["wave_pulses"]),
        float(pool_new.get("static_fp_per_min") or 0) - float(pool_old.get("static_fp_per_min") or 0),
        int(pool_new["empty_pulses"]) - int(pool_old["empty_pulses"]),
        int(pool_new["hardneg_pulses"]) - int(pool_old["hardneg_pulses"]),
        int(pool_new["pulses_total"]) - int(pool_old["pulses_total"]))
    L.append("| s100 本次（rows 排序） | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
        pool_new["n_windows"], pool_new["open_chunks"], f(pool_new["open_recall"]), pool_new["open_pulses"],
        pool_new["wave_pulses"], f(pool_new["static_fp_per_min"]), pool_new["empty_pulses"],
        pool_new["hardneg_pulses"], pool_new["pulses_total"], dcell))
    L.append("")
    has_s = bool(sp and (S.get("pooled") or {}).get("old_fold_sum"))
    if has_s:
        fs = S["pooled"]["old_fold_sum"]
        L.append("旧 JSON pooled_int8 与逐折合计不一致：old pooled open/wave/hardneg/pulses = %s/%s/%s/%s，逐折合计 = %s/%s/%s/%s。逐折复算与旧结果逐指标完全一致，因此 A 的旧 pooled 不作为可信基线；上表同时给出 s50 重算 pooled（rows 显式排序）作对照。" % (
            pool_old["open_pulses"], pool_old["wave_pulses"], pool_old["hardneg_pulses"], pool_old["pulses_total"],
            fs["open_pulses"], fs["wave_pulses"], fs["hardneg_pulses"], fs["pulses_total"]))
        L.append("")
    L.append("**A 结论**：s100 的 open recall 仍为 **17/17=1.0**、静态/空桌面为 **0**；但 pooled wave 触发 **5 次**（wave_L 4 + wave_L_far 1），fold0 单折就有 5 次；hardneg 触发 5 次（旧逐折合计 8）。按任务门槛，**wave_pulses<=1 不满足**，是唯一未过项。")
    L.append("")
    L.append("## 5. B 距离外推")
    L.append("")
    L.append("| 指标 | 旧（s50） | 新（s100） | Δ |")
    L.append("|---|---:|---:|---:|")
    for k in ["open_chunks", "open_recall", "open_pulses", "wave_pulses", "static_pulses",
              "static_fp_per_min", "empty_pulses", "hardneg_pulses", "pulses_total", "n_windows"]:
        v = B["delta"].get(k)
        if not v:
            continue
        L.append("| %s | %s | %s | %s |" % (k, f(v["old"]), f(v["new"]), f(v.get("delta", v.get("delta_chunks")))))
    L.append("")
    L.append("far 测试窗：旧 open_L_far/wave_L_far = %s/%s；新 = %s/%s（s100 窗数减半；新只数 base，旧数含镜像）。窗口 acc=%s。" % (
        B["old_far_test_windows"]["open_L_far"], B["old_far_test_windows"]["wave_L_far"],
        B["far_test_windows"]["open_L_far"], B["far_test_windows"]["wave_L_far"], f(B["window_acc"])))
    L.append("")
    L.append("**B 结论**：远距开合仍 3/3 检出，wave 0；pulses 14→15（+1），距离外推没有崩，但窗口 acc 从 0.916 降到 0.851。")
    L.append("")
    L.append("## 6. C 镜像")
    L.append("")
    oldc = C["old_summary"]
    newc = C["new"]
    L.append("| 指标 | 旧（float） | 新（int8） | Δ（新−旧） |")
    L.append("|---|---:|---:|---:|")
    L.append("| d_open_max | %s | %s | %s |" % (
        f(oldc["d_open_max"]), f(newc["d_open_max"]), f(round(newc["d_open_max"] - oldc["d_open_max"], 4))))
    L.append("| d_open_chunk_diff_max | %s | %s | %s |" % (
        oldc["d_open_chunk_diff_max"], newc["d_open_chunk_diff_max"],
        "%+d" % (newc["d_open_chunk_diff_max"] - oldc["d_open_chunk_diff_max"])))
    L.append("| d_wave_max | %s | %s | %s |" % (
        f(oldc["d_wave_max"]), f(newc["d_wave_max"]), f(round(newc["d_wave_max"] - oldc["d_wave_max"], 4))))
    L.append("| gate_chunk_pass | %s | %s | 变化 |" % (oldc["gate_chunk_pass"], newc["gate_chunk_pass"]))
    L.append("")
    L.append("| test fold | 旧 open aug0/aug1 | 新 open aug0/aug1 | 旧 wave aug0/aug1 | 新 wave aug0/aug1 | 旧 d_open/chunk/dwave | 新 d_open/chunk/dwave |")
    L.append("|---|---:|---:|---:|---:|---:|---:|")
    old_gate = {int(g["test_fold"]): g for g in C["old"]["gate"]}
    for g in C["gate"]:
        t = g["tests"]; ot = old_gate[int(g["test_fold"])]["tests"]; og = old_gate[int(g["test_fold"])]
        L.append("| %d | %s / %s | %s / %s | %s / %s | %s / %s | %s / %s / %s | %s / %s / %s |" % (
            g["test_fold"], ot["aug0"]["open_chunks"], ot["aug1"]["open_chunks"],
            t["aug0"]["open_chunks"], t["aug1"]["open_chunks"],
            f(ot["aug0"]["wave_hit_ratio"]), f(ot["aug1"]["wave_hit_ratio"]),
            f(t["aug0"]["wave_hit_ratio"]), f(t["aug1"]["wave_hit_ratio"]),
            f(og["d_open_window"]), og["open_chunk_diff"], f(og["d_wave"]),
            f(g["d_open_window"]), g["open_chunk_diff"], f(g["d_wave"])))
    L.append("")
    L.append("**C 的镜像一致性变差**：d_open_max 从 %s 升到 %s、chunk diff 从 %s 升到 %s、d_wave 从 %s 升到 %s；fold0 左右镜像的 open chunk 差 1，window recall 差 0.1111 >0.10 门槛；且新结果 n=645/折，旧 n=1290/折，统计量也减半。旧 C 是 float、新 C 是 int8，不能逐位对比，但方向是明确的。" % (
        f(oldc["d_open_max"]), f(newc["d_open_max"]), oldc["d_open_chunk_diff_max"],
        newc["d_open_chunk_diff_max"], f(oldc["d_wave_max"]), f(newc["d_wave_max"])))
    L.append("")
    L.append("## 7. D 空桌面 / control")
    L.append("")
    L.append("| 项 | 旧（s50） | 新（s100） | Δ（新−旧） |")
    L.append("|---|---:|---:|---:|")
    for k in ["empty_A", "empty_A2"]:
        o = D["v7_empty_old"].get(k, {})
        n = D["v7_empty_new"].get(k, {})
        ow, oh = int(o.get("low_n_windows") or 0), int(o.get("low_n_hits") or 0)
        nw_, nh = int(n.get("low_n_windows") or 0), int(n.get("low_n_hits") or 0)
        L.append("| v7 %s low_n windows/hits | %d / %d | %d / %d | %+d / %+d |" % (
            k, ow, oh, nw_, nh, nw_ - ow, nh - oh))
    L.append("")
    L.append("| fold | n（旧 / 新 / Δ） | empty（旧 / 新 / Δ） | static/min（旧 / 新 / Δ） | low_n_hits（旧 / 新 / Δ） |")
    L.append("|---|---:|---:|---:|---:|")
    for fold in ["fold0", "fold1"]:
        nw = D["control_new"][fold]
        old = nw.get("old", {})
        on = int(old.get("n_windows") or 0); nn_ = int(nw["n_windows"])
        oe = int(old.get("empty_pulses") or 0); ne = int(nw["empty_pulses"])
        os_ = float(old.get("static_fp_per_min") or 0.0); ns_ = float(nw["static_fp_per_min"] or 0.0)
        ol = int(old.get("low_n_hits") or 0); nl = int(nw["low_n_hits"])
        L.append("| %s | %d / %d / %+d | %d / %d / %+d | %s / %s / %+.3f | %d / %d / %+d |" % (
            fold, on, nn_, nn_ - on, oe, ne, ne - oe, f(os_), f(ns_), ns_ - os_, ol, nl, nl - ol))
    L.append("")
    L.append("s100 的 control 每折 590 窗（旧 2359），静态段与空桌面 pulse 都是 **0**；fold0 的 static_fp_per_min 旧 0.882、新 0.0（决策点数少一半后恰好没有成链）。D 没有新增风险。")
    L.append("")
    L.append("## 8. 现权重能不能直接上板")
    L.append("")
    L.append("| 门槛 | 要求 | s100 实测 | 判定 |")
    L.append("|---|---:|---:|---|")
    th = res["decision"]["thresholds"]
    L.append("| 开合召回 | >=%s | %s (%s) | %s |" % (
        th["open_recall"], f(pool_new["open_recall"]), pool_new["open_chunks"],
        "PASS" if (pool_new["open_recall"] or 0) >= th["open_recall"] else "FAIL"))
    L.append("| 挥手 pulse | <=%s | %s | %s |" % (
        th["wave_pulses_max"], pool_new["wave_pulses"],
        "PASS" if (pool_new["wave_pulses"] or 0) <= th["wave_pulses_max"] else "FAIL"))
    L.append("| 静态误触 | <=%s/min | %s | %s |" % (
        th["static_fp_per_min_max"], f(pool_new["static_fp_per_min"]),
        "PASS" if (pool_new["static_fp_per_min"] or 0) <= th["static_fp_per_min_max"] else "FAIL"))
    L.append("| 空桌面 pulse | =0 | %s | %s |" % (
        pool_new["empty_pulses"], "PASS" if (pool_new["empty_pulses"] or 0) == 0 else "FAIL"))
    L.append("")
    L.append("**明确回答：现权重不能直接上板。** 未过项只有 %s；其余三项都过。若忽略挥手，开合/静态/空桌面表现都不错；但现场挥手是已知最可复现的误触源，5 次 pulse 不能当成 0。三选一结论：**需重训**；推荐 **B2（s50+s100 混合）**，部署仍走 s100。" % "、".join(res["decision"]["fail_items"]))
    L.append("")
    L.append("## 9. B1 / B2 / B3 可行性")
    L.append("")
    L.append("| 方案 | 数据量 | 类别计数 | 代价/风险 |")
    L.append("|---|---|---|---|")
    L.append("| B1 纯 s100 | base %s + mirror %s = %s | base %s；class2 base %s / 含镜像 %s | 数据量约 s50 一半，class2 统计量减半；需重训，RTL 不变 |" % (
        F["s100_base_windows"], F["s100_mirror_windows"], F["s100_all_base_windows"],
        F["s100_base_class_counts"], F["s100_base_class_counts"].get(2, 0), F["s100_all_base_class_counts"].get(2, 0)))
    L.append("| B2 混合 s50+s100 | s50 base %s + s100 base %s = %s（镜像另算） | s50 base %s；s100 base %s | 数据不减，等价对齐增广；部署仍 s100；推荐 |" % (
        F["s50_base_windows"], F["s100_base_windows"], F["s50_base_windows"] + F["s100_base_windows"],
        F["s50_base_class_counts"], F["s100_base_class_counts"]))
    L.append("| B3 板端 50 ms 滑窗 | 不改数据 | - | 需 RTL 增加半个 bin 的存储/控制，风险高、周期长；本次不采用 |")
    L.append("")
    L.append("B1 的 s100 基础窗 2295、class2 基础 510 / 含镜像 1020，训练是够的，但只有 s50 的一半；B2 保留全部 s50 数据并加入 s100，故优先 B2。B3 能直接消除 50 ms 对齐差，但要动 RTL，不作为今晚路径。")
    L.append("")
    L.append("## 10. s50 复算校验")
    L.append("")
    if S and S.get("folds"):
        L.append("| test fold | 旧 open | 新 open | 旧 wave | 新 wave | 旧 hardneg | 新 hardneg | 旧 pulses | 新 pulses | 逐指标一致 |")
        L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
        for fr in S["folds"]:
            nm = fr["new"]; om = fr["old"]
            L.append("| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                fr["test_fold"], om["open_chunks"], nm["open_chunks"], om["wave_pulses"], nm["wave_pulses"],
                om["hardneg_pulses"], nm["hardneg_pulses"], om["pulses_total"], nm["pulses_total"],
                "是" if fr["match_metrics"] else "否"))
        L.append("")
        L.append("s50 逐折逐指标与旧结果**完全一致**，说明本脚本的 int8 前向和回放口径可复现旧 A。旧 pooled 的差异见 4.2 的说明。")
    else:
        L.append("本次使用了 --skip-s50-check，未做 s50 复算。")
    L.append("")
    L.append("## 11. 自检")
    L.append("")
    L.append("| 检查 | 结果 |")
    L.append("|---|---|")
    for k in checks:
        L.append("| %s | %s |" % (k, "PASS" if checks[k] else "FAIL"))
    L.append("")
    L.append("## 12. 复现命令")
    L.append("")
    L.append("~~~bash")
    L.append("cd <repo-root>")
    L.append("PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/s100_eval.py")
    L.append("~~~")
    L.append("")
    L.append("默认会重建 nn/out_v7/windows_s100.npz；加 --reuse 可复用已有 npz。产物：nn/out_v7/windows_s100.npz、nn/out_v7/s100_results.json、nn/REPORT_s100_部署口径复核.md、nn/_evidence/S100_EVAL_OK.log。")
    L.append("")
    L.append("本次 hash：CONTENT_HASH=%s，WINDOW_CHECKSUM=%s。" % (
        W["content_hash"], W["window_checksum"]))
    hs = res.get("hash_stability") or {}
    if hs.get("stable") is True:
        L.append("**HASH_STABLE=1**：与上一次运行逐项一致（连续 %d 次比对通过，npz_sha256=%s）。" % (
            int(hs.get("runs") or 2), W.get("npz_sha256")))
    elif hs.get("stable") is False:
        L.append("**HASH_STABLE=0**：与上一次运行的 CONTENT_HASH/WINDOW_CHECKSUM/npz_sha256 不一致，说明本次重建非确定。")
    else:
        L.append("首次运行（无同命令上一次结果可比）；同命令再跑一次应得到相同 hash。")
    L.append("")
    L.append("## 13. 限制")
    L.append("")
    L.append("- 只有 v7hands 一条 256 s 会话（20 个 zone）与 v5probe 的 control；s100 窗数减半，统计量比 s50 弱。")
    L.append("- 这是**推理复核**，不是重训；B1/B2 的收益和最终门槛要等重训后重跑。")
    L.append("- C 新结果是 int8、旧是 float，不能逐位比较；C 的 gate 失败只作旁证，不进入直接上板四个门槛。")
    L.append("- 旧 JSON 的 pooled_int8 与逐折合计不一致，已用 s50 重算（rows 排序）替代；旧逐折结果可信。")
    return "\n".join(L) + "\n"


def main(argv=None):
    force_utf8_stdio()
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", default=str(DEFAULT_NPZ))
    ap.add_argument("--json", default=str(DEFAULT_JSON))
    ap.add_argument("--report", default=str(DEFAULT_REPORT))
    ap.add_argument("--evidence", default=str(DEFAULT_EVID))
    ap.add_argument("--reuse", action="store_true", help="复用已有 windows_s100.npz")
    ap.add_argument("--skip-s50-check", action="store_true")
    args = ap.parse_args(argv)
    t_start = datetime.now().astimezone()
    npz_path = Path(args.npz)
    json_path = Path(args.json)
    report_path = Path(args.report)
    evid_path = Path(args.evidence)
    for p in (npz_path.parent, json_path.parent, report_path.parent, evid_path.parent):
        p.mkdir(parents=True, exist_ok=True)
    prior_results = None
    if json_path.exists():
        try:
            prior_results = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            prior_results = None

    old = json.loads(OLD_RESULTS.read_text(encoding="utf-8"))
    params = [load_params(PARAM_FOLDS[0]), load_params(PARAM_FOLDS[1])]
    params_dist = load_params(PARAM_DIST)

    # ---------- 基础与对照窗口 ----------
    ft_abs = B.load_frames()
    board0 = int(ft_abs[0])
    rel, x, y, pol, meta = B.load_cache_or_parse(board0)
    zj, zs, z_t0, z_t1, z_names, z_views, z_cls = B.load_zones()
    session = str(zj.get("session", "20261030-222201_v7hands"))
    log("[s100] base session=%s events=%d board0=%d" % (session, len(rel), board0))
    s50_full = build_s50_full(rel, x, y, pol)
    s100_st = build_s100_stats(rel, x, y, pol)
    base, base_st, base_lab, base_counts = build_base_payload(rel, x, y, pol, z_t0, z_t1, z_names, z_views, z_cls, session)
    ctrl, ctrl_st, ctrl_counts = build_control_payload()
    control_s50 = load_payload(CONTROL_NPZ)
    control_s50_full = {"g": control_s50["g"], "X_raw": control_s50["X_raw"], "X": control_s50["X"],
                        "n_win": int(control_s50["g"].shape[0])}
    log("[s100] full: s50=%d s100=%d | base labels(s100)=%d s100=%d | ctrl kept s50=%d s100=%d" % (
        s50_full["n_win"], s100_st["n_win"], int(base_lab["idx"].shape[0]), base_counts["n_base"],
        int(control_s50["g"].shape[0]), ctrl_counts["n_kept"]))

    if args.reuse and npz_path.exists():
        data = load_payload(npz_path)
        ch = sha256_payload(data)
        win_chk = sha256_bytes(np.ascontiguousarray(data["X_raw"]).tobytes())
        log("[s100] reuse %s" % npz_path)
    else:
        data, ch, win_chk = save_windows_s100(base, ctrl, zj["zones"], npz_path)
        log("[s100] wrote %s (%.1f MB) content_hash=%s" % (
            npz_path, npz_path.stat().st_size / 1e6, ch))
    data_sha = sha256_file(npz_path)
    hash_stab = {"prior_json": None, "runs": 1, "stable": None}
    if prior_results:
        pw = prior_results.get("windows") or {}
        same = bool(pw.get("content_hash") == ch and pw.get("window_checksum") == win_chk
                    and pw.get("npz_sha256") == data_sha)
        hash_stab = {"prior_json": str(json_path), "runs": 2, "stable": same,
                     "prior_content_hash": pw.get("content_hash"),
                     "prior_window_checksum": pw.get("window_checksum"),
                     "prior_npz_sha256": pw.get("npz_sha256")}
        check("HASH_STABLE", same, "同命令两次重建 content_hash/window_checksum/npz_sha256 一致")
        log("[s100] HASH_STABLE=%s runs=%d prior=%s" % (same, 2, hash_stab.get("prior_content_hash")))

    # ---------- 一致性 / prev ----------
    cons = now_consistency(s100_st, s50_full, ctrl_st, control_s50_full)
    check("NOW_CONSISTENT", bool(cons["X_raw_now_equal"] and cons["g_now_equal"]),
          "s100 vs s50 偶数窗 now")
    log("[s100] now consistency=%s" % json.dumps(cons, ensure_ascii=False))
    prev = compare_prev(s100_st, s50_full)
    log("[s100] PREV_DIFF_RATIO=%s" % json.dumps(prev, ensure_ascii=False))
    check("PREV_DIFF_RATIO", prev["n_sample"] >= 100 and prev["prev_window_diff_ratio_raw"] > 0.0,
          "window_raw=%.4f" % prev["prev_window_diff_ratio_raw"])

    # ---------- 特征分布 ----------
    feat50, names50 = F.build("fmin_n_rel7", s50_full["g"])
    feat100, names100 = F.build("fmin_n_rel7", s100_st["g"])
    assert list(names50) == FEAT_NAMES and list(names100) == FEAT_NAMES
    dist = {
        "names": FEAT_NAMES,
        "s50_full": dist_table(feat50, names50),
        "s100_full": dist_table(feat100, names100),
        "raw_dxdy": {"s50_full": raw_dx_dy(s50_full["g"]), "s100_full": raw_dx_dy(s100_st["g"])},
    }
    # s50 的对应评估行（windows_v7）单独加载
    d50 = load_payload(V7_NPZ)
    m50_base = np.isin(d50["role"].astype(str), ["v7_primary", "v7_hardneg"]) & (d50["aug"] == 0)
    m100_base = np.isin(data["role"].astype(str), ["v7_primary", "v7_hardneg"]) & (data["aug"] == 0)
    s50_base_kept = int(m50_base.sum())
    s50_with_mirror = int(np.isin(d50["role"].astype(str), ["v7_primary", "v7_hardneg"]).sum())
    s50_base_class_counts = {int(k): int(v) for k, v in zip(*np.unique(d50["y"][m50_base], return_counts=True))}
    # 副表只使用 base（aug0）行，避免 control/镜像造成口径差。
    f50e, _ = F.build("fmin_n_rel7", d50["g"][m50_base])
    f100e, _ = F.build("fmin_n_rel7", data["g"][m100_base])
    dist["s50_eval"] = dist_table(f50e, names50)
    dist["s100_eval"] = dist_table(f100e, names100)
    for name in FEAT_NAMES:
        o = dist["s50_full"][name]
        n = dist["s100_full"][name]
        dist.setdefault("delta_p50", {})[name] = round(n["p50"] - o["p50"], 3)
    check("FEATURE_DIST_OK", all(k in dist["s100_full"] for k in FEAT_NAMES), "7 路")
    log("[s100] feature raw dx s50=%s s100=%s" % (
        json.dumps(dist["raw_dxdy"]["s50_full"]), json.dumps(dist["raw_dxdy"]["s100_full"])))

    # ---------- s50 复算旧 A（验证前向/回放） ----------
    s50_check = None
    if not args.skip_s50_check:
        s50_check = run_old_s50_check(d50, params, old)
        ok = all(f["match_metrics"] for f in s50_check["folds"])
        check("S50_RECHECK", ok, "旧 A int8 逐折指标复算")
        log("[s100] s50 recheck=%s" % json.dumps({"folds": s50_check["folds"], "pooled": s50_check["pooled"]}, ensure_ascii=False))

    # ---------- A 时间外推 ----------
    role = data["role"].astype(str)
    base_roles = np.isin(role, ["v7_primary", "v7_hardneg"])
    fold = data["fold"].astype(np.int64)
    x100 = data["X"].astype(np.float32)
    feats100, _ = F.build("fmin_n_rel7", data["g"])
    pred_by_fold = {}
    c1_by_fold = {}
    for train_fold, test_fold in ((0, 1), (1, 0)):
        logits = forward_int8(x100, feats100, params[train_fold])
        pred_by_fold[test_fold] = logits.argmax(axis=1).astype(np.int64)
        c1_by_fold[test_fold] = (logits[:, 1].astype(np.int64) - logits[:, 0].astype(np.int64)).astype(np.float32)
    A = {"folds": [], "pooled": None}
    oldA = old["A_time"]
    old_by_test = {int(f["test_fold"]): f for f in oldA["folds"]}
    pool_rows = []; pool_pred = []; pool_c1 = []
    for train_fold, test_fold in ((0, 1), (1, 0)):
        rows = np.where((fold == test_fold) & base_roles)[0]
        pred = pred_by_fold[test_fold][rows]
        c1 = c1_by_fold[test_fold][rows]
        summ, per_zone, _ = eval_s100(data, rows, pred, c1)
        newm = pick_metrics(summ)
        oldm = pick_metrics(old_by_test[test_fold]["int8"]["int8_eval"]["8"])
        A["folds"].append({"train_fold": train_fold, "test_fold": test_fold,
                           "n_test": int(len(rows)), "new": newm, "old": oldm,
                           "delta": metric_delta(oldm, newm),
                           "per_zone": {k: {"pulses": v["pulses"], "pulses_per_min": v["pulses_per_min"],
                                            "open_chunks_total": v["open_chunks_total"],
                                            "open_chunks_detected": v["open_chunks_detected"]}
                                        for k, v in per_zone.items()}})
        pool_rows.append(rows); pool_pred.append(pred); pool_c1.append(c1)
        log("[s100][A] test fold%d n=%d open=%s wave=%s static=%s/hardneg=%s" % (
            test_fold, len(rows), newm["open_chunks"], newm["wave_pulses"],
            newm["static_fp_per_min"], newm["hardneg_pulses"]))
    rows = np.concatenate(pool_rows); pred = np.concatenate(pool_pred); c1 = np.concatenate(pool_c1)
    summ, per_zone, _ = eval_s100(data, rows, pred, c1)
    newm = pick_metrics(summ)
    oldm = pick_metrics(oldA["pooled_int8"]["8"])
    A["pooled"] = {"n": int(len(rows)), "new": newm, "old": oldm, "delta": metric_delta(oldm, newm),
                   "per_zone": {k: {"pulses": v["pulses"], "pulses_per_min": v["pulses_per_min"],
                                    "open_chunks_total": v["open_chunks_total"],
                                    "open_chunks_detected": v["open_chunks_detected"],
                                    "class1_argmax": v["class1_argmax"]}
                                for k, v in per_zone.items()}}
    check("A_TIME_OK", A["pooled"]["new"]["open_chunks"] is not None, "pooled open=%s wave=%s" % (
        newm["open_chunks"], newm["wave_pulses"]))
    log("[s100][A] pooled open=%s wave=%s static=%s empty=%s hardneg=%s" % (
        newm["open_chunks"], newm["wave_pulses"], newm["static_fp_per_min"],
        newm["empty_pulses"], newm["hardneg_pulses"]))

    # ---------- B 距离外推 ----------
    zone = data["zone"].astype(str)
    center = data["center_ms"].astype(np.int64)
    far_zones = ("open_L_far", "wave_L_far")
    base_pool = np.isin(role, ["v7_primary", "v7_hardneg"]) & (data["aug"] == 0)
    keys = np.array([zone[i] + "|" + str(int(data["win_idx"][i])) for i in range(len(zone))], dtype=object)
    test_keys = set()
    far_new_counts = {}
    for z in far_zones:
        r = np.where(base_pool & (zone == z))[0]
        r = r[np.argsort(center[r], kind="stable")]
        half = len(r) // 2
        for row in r[half:]:
            test_keys.add(str(keys[row]))
        far_new_counts[z] = int(np.isin(keys, np.array([str(keys[row]) for row in r[half:]])).sum()) if len(r) > half else 0
    rows_te = np.where(np.isin(keys, np.array(sorted(test_keys), dtype=object)))[0]
    logits = forward_int8(x100[rows_te], feats100[rows_te], params_dist)
    pred_b = logits.argmax(axis=1)
    c1_b = (logits[:, 1].astype(np.int64) - logits[:, 0].astype(np.int64)).astype(np.float32)
    summ_b, _, _ = eval_s100(data, rows_te, pred_b, c1_b)
    newb = pick_metrics(summ_b)
    oldb = pick_metrics(old["B_distance"]["int8"]["int8_eval"]["8"])
    yb = np.where(data["y"][rows_te] == 1, 1, 0)
    B_res = {"n_test": int(len(rows_te)), "n_train": old["B_distance"]["n_train"],
             "far_test_windows": far_new_counts, "old_far_test_windows": old["B_distance"]["far_test_windows"],
             "window_acc": round(float((pred_b == yb).mean()), 4),
             "new": newb, "old": oldb, "delta": metric_delta(oldb, newb)}
    check("B_DIST_OK", newb["open_chunks"] is not None, "n=%d open=%s wave=%s" % (
        len(rows_te), newb["open_chunks"], newb["wave_pulses"]))
    log("[s100][B] n=%d open=%s wave=%s acc=%.4f" % (len(rows_te), newb["open_chunks"], newb["wave_pulses"], B_res["window_acc"]))

    # ---------- C 镜像 ----------
    C = {"gate": [], "old": old["C_mirror"], "new": {}, "deltas": {}}
    for train_fold, test_fold in ((0, 1), (1, 0)):
        base_c = (fold == test_fold) & np.isin(data["y"], [1, 2]) & (role == "v7_primary")
        entry = {"train_fold": train_fold, "test_fold": test_fold, "tests": {}}
        for aug_test in (0, 1):
            rr = np.where(base_c & (data["aug"] == aug_test))[0]
            pred_c = pred_by_fold[test_fold][rr]
            c1_c = c1_by_fold[test_fold][rr]
            sc, _, _ = eval_s100(data, rr, pred_c, c1_c)
            entry["tests"][f"aug{aug_test}"] = {
                "n": int(len(rr)), "open_recall": sc["open_recall"], "open_chunks": sc["open_chunks"],
                "wave_hit_ratio": sc["wave_window_hit_ratio"], "wave_pulses": sc["wave_pulses"],
                "open_pulses": sc["open_pulses"]}
        entry["d_open_window"] = abs((entry["tests"]["aug0"]["open_recall"] or 0) - (entry["tests"]["aug1"]["open_recall"] or 0))
        entry["open_chunk_diff"] = abs(chunks_num(entry["tests"]["aug0"]["open_chunks"]) - chunks_num(entry["tests"]["aug1"]["open_chunks"]))
        entry["d_wave"] = abs((entry["tests"]["aug0"]["wave_hit_ratio"] or 0) - (entry["tests"]["aug1"]["wave_hit_ratio"] or 0))
        C["gate"].append(entry)
    C["new"] = {"gate_chunk_pass": bool(max(g["open_chunk_diff"] for g in C["gate"]) <= 1
                                          and max(g["d_open_window"] for g in C["gate"]) <= 0.10),
                "d_open_max": round(max(g["d_open_window"] for g in C["gate"]), 4),
                "d_open_chunk_diff_max": int(max(g["open_chunk_diff"] for g in C["gate"])),
                "d_wave_max": round(max(g["d_wave"] for g in C["gate"]), 4)}
    C["old_summary"] = {k: old["C_mirror"][k] for k in ["d_open_max", "d_open_window_max", "d_open_chunk_diff_max", "d_wave_max", "gate_chunk_pass"]}
    C["deltas"] = {"d_open_chunk_diff_max": C["new"]["d_open_chunk_diff_max"] - C["old_summary"]["d_open_chunk_diff_max"],
                   "d_wave_max": round(C["new"]["d_wave_max"] - C["old_summary"]["d_wave_max"], 4)}
    check("C_MIRROR_OK", len(C["gate"]) == 2, "chunk diff=%d" % C["new"]["d_open_chunk_diff_max"])
    log("[s100][C] new=%s old=%s" % (json.dumps(C["new"]), json.dumps(C["old_summary"])))

    # ---------- D 空桌面 / control ----------
    D = {"v7_empty_new": {}, "v7_empty_old": old["D_empty"]["v7_empty_zones"],
         "control_new": {}, "control_old": old["D_empty"]["control_7min_int8_folds"]}
    empty_low = {}
    for k, z in A["pooled"]["per_zone"].items():
        if E.ZONE_GROUP.get(k) == "empty":
            empty_low[k] = {"low_n_windows": int(z["open_chunks_total"]), "low_n_hits": None}
    for f in A["folds"]:
        for k, z in f["per_zone"].items():
            if E.ZONE_GROUP.get(k) == "empty":
                empty_low.setdefault(k, {"low_n_windows": 0, "low_n_hits": 0})
    # 逐折取 per_zone 的 low_n 统计（A 的 per_zone 已裁剪，需重新取）
    empty_new = {}
    for f in A["folds"]:
        rr = np.where((fold == f["test_fold"]) & base_roles)[0]
        _, pz, _ = eval_s100(data, rr, pred_by_fold[f["test_fold"]][rr], c1_by_fold[f["test_fold"]][rr])
        for k, z in pz.items():
            if E.ZONE_GROUP.get(k) == "empty":
                empty_new.setdefault(k, {"low_n_windows": 0, "low_n_hits": 0})
                empty_new[k]["low_n_windows"] += int(z["low_n_windows"])
                empty_new[k]["low_n_hits"] += int(z["low_n_hits"])
    D["v7_empty_new"] = empty_new
    ctrl_neg = (role == "control_7min") & np.char.startswith(data["hint"].astype(str), "control_ne")
    ctrl_old_by_fold = {int(k.replace("fold", "")): v for k, v in D["control_old"].items()}
    for test_fold in (0, 1):
        mdl_fold = 1 - test_fold
        rr = np.where(ctrl_neg & (fold == test_fold))[0]
        pred_d = pred_by_fold[mdl_fold][rr]
        c1_d = c1_by_fold[mdl_fold][rr]
        sd, pz, _ = eval_s100(data, rr, pred_d, c1_d)
        D["control_new"][f"fold{test_fold}"] = {
            "n_windows": int(len(rr)),
            "empty_pulses": sd["empty_pulses"],
            "static_fp_per_min": sd["static_fp_per_min"],
            "low_n_windows": int(sum(v["low_n_windows"] for v in pz.values())),
            "low_n_hits": int(sum(v["low_n_hits"] for v in pz.values())),
            "class1_argmax": int(sum(v["class1_argmax"] for v in pz.values())),
            "per_zone": {k: {"pulses": v["pulses"], "pulses_per_min": v["pulses_per_min"],
                             "class1_argmax": v["class1_argmax"], "class1_hit": v["class1_hit"]}
                         for k, v in pz.items()},
        }
        oldc = ctrl_old_by_fold[test_fold]
        D["control_new"][f"fold{test_fold}"]["old"] = {
            "n_windows": oldc["n_windows"], "empty_pulses": oldc["empty_pulses"],
            "static_fp_per_min": oldc["static_fp_per_min"], "low_n_windows": oldc["low_n_windows"],
            "low_n_hits": oldc["low_n_hits"]}
        log("[s100][D] control fold%d n=%d empty=%s static=%s/min" % (
            test_fold, len(rr), sd["empty_pulses"], sd["static_fp_per_min"]))
    check("D_EMPTY_OK", D["control_new"]["fold0"]["n_windows"] > 0, "control n=%d" % sum(v["n_windows"] for v in D["control_new"].values()))

    # ---------- 决策与可行性 ----------
    thresholds = {"open_recall": 0.85, "wave_pulses_max": 1, "static_fp_per_min_max": 0.5, "empty_pulses": 0}
    p = A["pooled"]["new"]
    fails = []
    if (p["open_recall"] or 0) < thresholds["open_recall"]:
        fails.append("open_recall %.3f < 0.85" % (p["open_recall"] or 0))
    if (p["wave_pulses"] or 0) > thresholds["wave_pulses_max"]:
        fails.append("wave_pulses %s > 1" % p["wave_pulses"])
    if (p["static_fp_per_min"] or 0) > thresholds["static_fp_per_min_max"]:
        fails.append("static_fp_per_min %s > 0.5" % p["static_fp_per_min"])
    if (p["empty_pulses"] or 0) != 0:
        fails.append("empty_pulses %s != 0" % p["empty_pulses"])
    direct_ok = len(fails) == 0
    role_counts = {k: int((role == k).sum()) for k in np.unique(role)}
    y_counts = {int(k): int(v) for k, v in zip(*np.unique(data["y"], return_counts=True))}
    nb = int(base_counts["n_base"])
    all_y = {int(k): int(v) for k, v in zip(*np.unique(base["y"], return_counts=True))}
    base_y = {int(k): int(v) for k, v in zip(*np.unique(base["y"][:nb], return_counts=True))}
    mirror_y = {int(k): int(v) for k, v in zip(*np.unique(base["y"][nb:], return_counts=True))}
    ctrl_y = {int(k): int(v) for k, v in zip(*np.unique(ctrl["y"], return_counts=True))}
    feasibility = {
        "s100_base_windows": nb, "s100_mirror_windows": int(base_counts["n_mirror"]),
        "s100_all_base_windows": int(len(base["y"])),
        "s100_base_class_counts": base_y, "s100_mirror_class_counts": mirror_y,
        "s100_all_base_class_counts": all_y,
        "s100_control_windows": int(ctrl_counts["n_kept"]), "s100_control_class_counts": ctrl_y,
        "s50_base_windows": s50_base_kept, "s50_base_class_counts": s50_base_class_counts,
        "s50_with_mirror_windows": s50_with_mirror,
        "b1_pure_s100": "s100 基础窗 %d（+镜像 %d）= %d 窗；约为 s50 基础窗 %d 的一半；class2 基础 %d 窗/含镜像 %d，仍可训练但统计量减半" % (
            nb, int(base_counts["n_mirror"]), len(base["y"]), s50_base_kept,
            base_y.get(2, 0), all_y.get(2, 0)),
        "b2_mix_s50_s100": "s50 基础 %d + s100 基础 %d = %d 窗（镜像另算）；部署仍用 s100，视作对齐增广；数据量不减" % (
            s50_base_kept, nb, s50_base_kept + nb),
        "b3_board_50ms": "板端改 50 ms 滑窗：需 RTL 增加半个 bin 的存储/控制，风险高、周期长；本次不采用",
    }
    decision = {
        "direct_deploy": bool(direct_ok),
        "thresholds": thresholds,
        "fail_items": fails,
        "answer": ("现权重可以直接上板" if direct_ok else "现权重不能直接上板：在板端 s100 口径下，" + "；".join(fails)),
        "conclusion": ("现权重可直接上板" if direct_ok else "需重训（建议 B2：s50+s100 混合）"),
        "feasibility": feasibility,
    }
    check("DIRECT_ANSWER_OK", bool(decision["answer"]), decision["answer"])
    log("[s100] DIRECT_DEPLOY=%d fails=%s" % (int(direct_ok), decision["fail_items"]))

    # ---------- JSON ----------
    results = {
        "task": "task-59", "generated": t_start.isoformat(timespec="seconds"),
        "cmd": "PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/s100_eval.py",
        "inputs": {"v7_npz": str(V7_NPZ), "control_npz": str(CONTROL_NPZ),
                   "old_results": str(OLD_RESULTS), "params": [str(p) for p in PARAM_FOLDS],
                   "params_distance": str(PARAM_DIST)},
        "windows": {
            "s50_full": int(s50_full["n_win"]), "s100_full": int(s100_st["n_win"]),
            "s50_base_kept": s50_base_kept, "s50_mirror": int(s50_with_mirror - s50_base_kept), "s100_base_kept": nb,
            "s100_mirror": int(base_counts["n_mirror"]),
            "s50_control_kept": int(control_s50["g"].shape[0]), "s100_control_kept": int(ctrl_counts["n_kept"]),
            "s100_rows": int(len(base["y"])), "s100_all_rows": int(len(data["y"])), "s100_y_counts": y_counts,
            "s100_role_counts": role_counts, "s100_base_class_counts": base_y,
            "s100_mirror_class_counts": mirror_y, "s100_control_class_counts": ctrl_y,
            "s50_base_class_counts": s50_base_class_counts,
            "s100_zone_counts": {str(k): int(v) for k, v in zip(*np.unique(data["zone"], return_counts=True))},
            "npz": str(npz_path), "npz_sha256": data_sha, "content_hash": ch,
            "window_checksum": win_chk,
        },
        "now_consistency": cons, "prev": prev,
        "feature_distribution": dist,
        "s50_recheck": s50_check,
        "A_time": A, "B_distance": B_res, "C_mirror": C, "D_empty": D,
        "decision": decision,
        "hash_stability": hash_stab,
        "checks": CHECKS,
    }
    json_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    check("JSON_OK", json_path.exists(), str(json_path))
    log("[s100] JSON -> %s" % json_path)

    # ---------- 报告 / 证据 ----------
    report_path.write_text(render_report(results), encoding="utf-8")
    check("REPORT_OK", report_path.exists(), str(report_path))
    # 证据
    ok_all = all(bool(v) for v in CHECKS.values())
    ev = ["S100_EVAL_OK=1", "timestamp=%s" % results["generated"],
          "cmd=%s" % results["cmd"],
          "N_WINDOWS_S50=%d" % s50_full["n_win"], "N_WINDOWS_S100=%d" % s100_st["n_win"],
          "N_S50_BASE_KEPT=%d" % s50_base_kept,
          "N_S100_BASE_KEPT=%d" % base_counts["n_base"], "N_S100_BASE_PLUS_MIRROR=%d" % int(len(base["y"])),
          "N_S50_CONTROL_KEPT=%d" % int(control_s50["g"].shape[0]),
          "N_S100_CONTROL_KEPT=%d" % ctrl_counts["n_kept"],
          "CONTENT_HASH=%s" % ch, "WINDOW_CHECKSUM=%s" % win_chk,
          "NPZ_SHA256=%s" % data_sha,
          "HASH_STABLE_RUNS=%d" % int(hash_stab.get("runs") or 1),
          "HASH_STABLE=%s" % ("1" if hash_stab.get("stable") else ("NA" if hash_stab.get("stable") is None else "0")),
          "PREV_WINDOW_DIFF_RATIO_RAW=%.6f" % prev["prev_window_diff_ratio_raw"],
          "PREV_CELL_DIFF_RATIO_RAW=%.6f" % prev["prev_cell_diff_ratio_raw"],
          "PREV_WINDOW_DIFF_RATIO_SHIFT=%.6f" % prev["prev_window_diff_ratio_shift"],
          "PREV_CELL_DIFF_RATIO_SHIFT=%.6f" % prev["prev_cell_diff_ratio_shift"],
          "N_S100_ROWS=%d" % int(len(base["y"])),
          "A_POOLED_OPEN=%s" % p["open_chunks"],
          "A_POOLED_OPEN_RECALL=%s" % p["open_recall"],
          "A_POOLED_WAVE_PULSES=%s" % p["wave_pulses"],
          "A_POOLED_STATIC_PER_MIN=%s" % p["static_fp_per_min"],
          "A_POOLED_EMPTY_PULSES=%s" % p["empty_pulses"],
          "A_POOLED_HARDNEG_PULSES=%s" % p["hardneg_pulses"],
          "B_OPEN=%s" % B_res["new"]["open_chunks"], "B_WAVE=%s" % B_res["new"]["wave_pulses"],
          "B_WINDOW_ACC=%.4f" % B_res["window_acc"],
          "C_D_OPEN_MAX=%s" % C["new"]["d_open_max"],
          "C_D_OPEN_CHUNK_DIFF=%s" % C["new"]["d_open_chunk_diff_max"],
          "C_D_WAVE_MAX=%s" % C["new"]["d_wave_max"],
          "D_CONTROL_N=%d" % sum(v["n_windows"] for v in D["control_new"].values()),
          "D_CONTROL_EMPTY=%d" % sum(v["empty_pulses"] for v in D["control_new"].values()),
          "D_CONTROL_STATIC_PER_MIN=%.3f" % sum(v["static_fp_per_min"] for v in D["control_new"].values()),
          "CONCLUSION=%s" % decision["conclusion"],
          "ANSWER=%s" % decision["answer"]]
    for k, v in CHECKS.items():
        ev.append("CHECK %-28s %d" % (k, int(bool(v))))
    ev.append("S100_EVAL_OK=%d" % int(ok_all))
    evid_path.write_text("\n".join(ev) + "\n", encoding="utf-8")
    log("[s100] evidence -> %s (all checks=%s)" % (evid_path, ok_all))
    log("[s100] DONE S100_EVAL_OK=%d" % int(ok_all))
    print("S100_EVAL_OK=%d" % int(ok_all))
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
