#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v7 数据集构建（v7.1：RTL 等价整数路径，task-42）。

输入（只读）：
  records/20261030-222201_v7hands/chunk-000.{events,frames}.csv
  temp_test/v7_zones.json（权威分区清单，不改）
  nn/v7/control_7min_int.npz（由 nn/v7/rebuild_control.py 用同一整数路径重建的 7 min 对照）
输出：
  nn/v7/windows_v7.npz          （X_raw / X=平移归一化网格 / g 17 路 / 标签与元数据）
  nn/out_v7/build_summary_v2.json
  temp_test/v7/raw_v7hands.npz  （原始事件解析缓存）

v7.1 与 v7.0 的差异（见 nn/REPORT_v7_训练与量化.md）：
  - 质心改为原始像素域整数质心 floor(Sx/n)（旧版用网格单元中心浮点均值）；
  - 平移归一化在**原始像素域**做整数减法 + clamp[0,399]，再 >>3（旧版先 round 偏移再丢弃越界事件）；
  - n=0 窗的质心保持上一有效值（旧版重置为 200/120）；
  - 全局量 g 除 bal 外全部整数/整数派生（sx/sy/speed 用 floor sqrt），值以 float32 存储但精确；
  - 7 min 对照不再复用 nn/v6 的浮点转换结果，改用 rebuild_control.py 的整数结果；
  - 镜像 g 的 dsx/dsy 不再取负（sigma 是标量，翻 x 不变；旧版取负是错的）。
口径：grid 30x50、shift=3、100 ms 窗 / 50 ms 步、通道 [ON_now,OFF_now,ON_prev,OFF_prev]。
标签：empty=0, openclose_left=1, wave_left=2, hardneg/static/away=0, exclude=255（不进窗）。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("RETE_ROOT") or Path(__file__).resolve().parents[2])
sys.path.insert(0, str(ROOT / "nn" / "v7"))
import intwin as IW  # noqa: E402

REC = ROOT / "records" / "20261030-222201_v7hands"
ZONES_JSON = ROOT / "temp_test" / "v7_zones.json"
CTRL_NPZ = ROOT / "nn" / "v7" / "control_7min_int.npz"
V6_DIR = ROOT / "nn" / "v6"
OUT_NPZ = ROOT / "nn" / "v7" / "windows_v7.npz"
OUT_SUMMARY = ROOT / "nn" / "out_v7" / "build_summary_v2.json"
CACHE_DIR = ROOT / "temp_test" / "v7"
CACHE_NPZ = CACHE_DIR / "raw_v7hands.npz"

GRID_SHIFT = IW.GRID_SHIFT
GRID_W = IW.GRID_W
GRID_H = IW.GRID_H
N_CELLS = IW.N_CELLS
SAT = IW.SAT
WIN_MS = IW.WIN_MS
STRIDE_MS = IW.STRIDE_MS
CHANNELS = IW.CHANNELS
GLOBAL_NAMES = IW.GLOBAL_NAMES
GIDX = IW.GIDX
DATA_VERSION = "v7.1-int-rtl-eq"

LABEL_MAP = {
    "empty": 0,
    "away": 0,
    "static": 0,
    "hardneg": 0,
    "openclose_left": 1,
    "wave_left": 2,
    "exclude": 255,
}

HASH_KEYS = [
    "X_raw", "X", "g", "y", "zone", "view", "session", "t_ms", "center_ms",
    "fold", "aug", "hand", "role", "hint", "win_idx",
]


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_payload(payload: dict) -> str:
    h = hashlib.sha256()
    for k in HASH_KEYS:
        a = np.ascontiguousarray(payload[k])
        h.update(k.encode("utf-8"))
        h.update(str(a.dtype).encode("ascii"))
        h.update(str(a.shape).encode("ascii"))
        h.update(a.tobytes())
    return h.hexdigest()


def load_frames() -> np.ndarray:
    with open(REC / "chunk-000.frames.csv", "r", newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        hdr = next(rd)
        assert hdr[:3] == ["frame_idx", "t_board_ms", "t_arrive_ms"], hdr
        out = [int(row[1]) for row in rd]
    return np.asarray(out, dtype=np.int64)


def load_events_csv(n_expected: int):
    path = REC / "chunk-000.events.csv"
    t = np.empty(n_expected, dtype=np.int64)
    x = np.empty(n_expected, dtype=np.int16)
    y = np.empty(n_expected, dtype=np.int16)
    pol = np.empty(n_expected, dtype=np.int8)
    t0 = time.time()
    with open(path, "r", newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        hdr = next(rd)
        assert hdr[:5] == ["frame_idx", "frame_t_ms", "x", "y", "pol"], hdr
        i = 0
        for row in rd:
            if i >= n_expected:
                raise RuntimeError("events.csv 行数超过 meta 计数 %d" % n_expected)
            t[i] = int(row[1]); x[i] = int(row[2]); y[i] = int(row[3]); pol[i] = int(row[4])
            i += 1
            if i % 2000000 == 0:
                log("[v7] parse events %d / %d  %.1fs" % (i, n_expected, time.time() - t0))
    if i != n_expected:
        raise RuntimeError("events.csv 行数 %d != meta 计数 %d" % (i, n_expected))
    return t, x, y, pol


def load_cache_or_parse(board0: int):
    meta = json.loads((REC / "meta.json").read_text(encoding="utf-8"))
    n_expected = int(meta["counters"]["events"])
    src = REC / "chunk-000.events.csv"
    st = src.stat()
    if CACHE_NPZ.exists():
        with np.load(CACHE_NPZ, allow_pickle=False) as d:
            if (int(d["src_size"]) == st.st_size
                    and int(d["src_mtime_ns"]) == st.st_mtime_ns
                    and int(d["board0"]) == board0
                    and int(d["n_events"]) == n_expected):
                rel = d["rel"].astype(np.int64)
                x = d["x"].astype(np.int32)
                y = d["y"].astype(np.int32)
                pol = d["pol"].astype(np.int8)
                log("[v7] raw cache hit %s (%d events)" % (CACHE_NPZ, len(rel)))
                return rel, x, y, pol, meta
    t_abs, x, y, pol = load_events_csv(n_expected)
    rel = t_abs - board0
    order = np.argsort(rel, kind="stable")
    if not np.array_equal(order, np.arange(len(rel))):
        log("[v7] events not time-sorted; stable argsort applied")
        rel, x, y, pol = rel[order], x[order], y[order], pol[order]
    else:
        log("[v7] events already time-sorted")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE_NPZ, rel=rel.astype(np.int64), x=x.astype(np.int16),
             y=y.astype(np.int16), pol=pol.astype(np.int8),
             board0=np.int64(board0), n_events=np.int64(n_expected),
             src_size=np.int64(st.st_size), src_mtime_ns=np.int64(st.st_mtime_ns))
    log("[v7] raw cache written %s" % CACHE_NPZ)
    return rel, x, y, pol, meta


def build_windows(rel, x, y, pol):
    g0, n_win, n_sub = IW.n_windows(rel)
    log("[v7] grid origin=%d ms, windows=%d (100ms/50ms), sub-blocks=%d" % (g0, n_win, n_sub))
    sub = IW.subblock_stats(rel, x, y, pol, g0, n_sub)
    log("[v7] sub-block counts max=%d, out-of-grid events=%d"
        % (int(sub["sub_grid"].max()), sub["n_bad"]))
    st = IW.window_stats(sub, n_win)
    X_raw = IW.raw_grids(sub["sub_grid"], n_win)
    X_shift, event_lo, event_hi = IW.shifted_grids(rel, x, y, pol, g0, n_win, st, log=log)
    t0s = IW.window_t0(rel, g0, n_win)
    return X_raw, X_shift, st, t0s, g0, event_lo, event_hi, sub, n_win


def rtl_check(stats, X, x, y, pol, event_lo, event_hi, picks):
    """独立整数参考实现：逐窗重算统计量/质心/平移网格，与 intwin 输出逐位比较。"""
    g = stats["g"]
    rows = []
    ok_all = True
    for k in picks:
        a, b = int(event_lo[k]), int(event_hi[k])
        n = on = off = Sx = Sy = Sx2 = Sy2 = 0
        cnt = np.zeros((2, GRID_H, GRID_W), dtype=np.int64)
        cnt_raw = np.zeros((2, GRID_H, GRID_W), dtype=np.int64)
        pcx = int(g[k, GIDX["pcx"]]); pcy = int(g[k, GIDX["pcy"]])
        for i in range(a, b):
            xi = int(x[i]); yi = int(y[i]); pi = int(pol[i])
            n += 1
            if pi == 1:
                on += 1
            else:
                off += 1
            Sx += xi; Sy += yi; Sx2 += xi * xi; Sy2 += yi * yi
            gx = min(IW.X_PIX_MAX, max(0, xi - (pcx - 200))) >> GRID_SHIFT
            gy = min(IW.Y_PIX_MAX, max(0, yi - (pcy - 120))) >> GRID_SHIFT
            cnt[0 if pi == 1 else 1, gy, gx] += 1
            cnt_raw[0 if pi == 1 else 1, yi >> GRID_SHIFT, xi >> GRID_SHIFT] += 1
        if n > 0:
            cx = Sx // n; cy = Sy // n
            sx = math.isqrt(max(Sx2 * n - Sx * Sx, 0) // (n * n))
            sy = math.isqrt(max(Sy2 * n - Sy * Sy, 0) // (n * n))
        else:
            cx = int(g[k, GIDX["cx"]]); cy = int(g[k, GIDX["cy"]]); sx = sy = 0
        exp = {
            "n": (n, int(g[k, GIDX["n"]])), "on": (on, int(g[k, GIDX["on"]])),
            "off": (off, int(g[k, GIDX["off"]])), "cx": (cx, int(g[k, GIDX["cx"]])),
            "cy": (cy, int(g[k, GIDX["cy"]])), "sx": (sx, int(g[k, GIDX["sx"]])),
            "sy": (sy, int(g[k, GIDX["sy"]])),
            "dx": (cx - pcx if n else 0, int(g[k, GIDX["dx"]])),
            "dy": (cy - pcy if n else 0, int(g[k, GIDX["dy"]])),
        }
        grid_ok = bool(np.array_equal(np.clip(cnt[0], 0, SAT), X[k, 0].astype(np.int64))
                       and np.array_equal(np.clip(cnt[1], 0, SAT), X[k, 1].astype(np.int64)))
        feats_bad = {kk: v for kk, v in exp.items() if v[0] != v[1]}
        raw_ok = bool(np.array_equal(
            np.clip(cnt_raw[0], 0, SAT), stats["raw"][k, 0].astype(np.int64)) and
            np.array_equal(np.clip(cnt_raw[1], 0, SAT), stats["raw"][k, 1].astype(np.int64)))
        prev_ok = bool(k == 0 or (np.array_equal(X[k, 2], X[k - 1, 0])
                                  and np.array_equal(X[k, 3], X[k - 1, 1])))
        ok = grid_ok and raw_ok and prev_ok and not feats_bad
        ok_all = ok_all and ok
        rows.append({"win": int(k), "ok": ok, "grid_ok": grid_ok, "raw_ok": raw_ok, "prev_ok": prev_ok,
                     "feats_bad": feats_bad, "n": n, "n_g": int(g[k, GIDX["n"]])})
    return ok_all, rows


def load_zones():
    zj = json.loads(ZONES_JSON.read_text(encoding="utf-8"))
    zs = zj["zones"]
    z_t0 = np.array([int(round(z["t0"] * 1000)) for z in zs], dtype=np.int64)
    z_t1 = np.array([int(round(z["t1"] * 1000)) for z in zs], dtype=np.int64)
    names = [z["name"] for z in zs]
    views = [z["view"] for z in zs]
    labels = [z["label"] for z in zs]
    cls = np.array([LABEL_MAP[l] for l in labels], dtype=np.uint8)
    return zj, zs, z_t0, z_t1, names, views, cls


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_NPZ))
    ap.add_argument("--summary", default=str(OUT_SUMMARY))
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--n-check", type=int, default=200)
    args = ap.parse_args(argv)
    t_start = time.time()
    OUT_NPZ.parent.mkdir(parents=True, exist_ok=True)
    OUT_SUMMARY.parent.mkdir(parents=True, exist_ok=True)

    ft = load_frames()
    board0 = int(ft[0])
    log("[v7] frames=%d board0=%d span=%.3fs" % (len(ft), board0, (ft[-1] - ft[0]) / 1000.0))
    if args.no_cache and CACHE_NPZ.exists():
        CACHE_NPZ.unlink()
    rel, x, y, pol, meta = load_cache_or_parse(board0)
    log("[v7] events=%d rel=%d..%d ON=%d OFF=%d x=%d..%d y=%d..%d"
        % (len(rel), rel[0], rel[-1], int((pol == 1).sum()), int((pol == 0).sum()),
           int(x.min()), int(x.max()), int(y.min()), int(y.max())))
    X_raw, X_shift, stats, t0s, g0, event_lo, event_hi, sub, n_win = build_windows(rel, x, y, pol)
    stats["raw"] = X_raw

    zj, zs, z_t0, z_t1, z_names, z_views, z_cls = load_zones()
    centers = t0s + WIN_MS // 2
    zi = np.searchsorted(z_t0, centers, side="right") - 1
    in_zone = (zi >= 0) & (centers < z_t1[np.clip(zi, 0, len(zs) - 1)])
    label_all = np.full(n_win, 255, dtype=np.uint8)
    label_all[in_zone] = z_cls[zi[in_zone]]
    ex = z_cls == 255
    inter = np.zeros(n_win, dtype=bool)
    for a, b in zip(z_t0[ex], z_t1[ex]):
        inter |= (t0s < b) & (t0s + WIN_MS > a)
    keep = in_zone & (label_all != 255) & (~inter)
    log("[v7] zone assignment: in_zone=%d exclude_center=%d gap=%d intersect_exclude=%d kept=%d"
        % (int(in_zone.sum()), int((in_zone & (label_all == 255)).sum()),
           int((~in_zone).sum()), int((in_zone & (label_all != 255) & inter).sum()),
           int(keep.sum())))

    zone_counts = []
    for i, name in enumerate(z_names):
        centered = int(((zi == i) & in_zone).sum())
        kept = int(((zi == i) & keep).sum())
        zone_counts.append({"index": i, "name": name, "t0_ms": int(z_t0[i]), "t1_ms": int(z_t1[i]),
                            "label": zs[i]["label"], "view": z_views[i],
                            "windows_centered": centered, "windows_kept": kept,
                            "windows_dropped": centered - kept})
        log("[v7] ZONE %-18s view=%s label=%-15s t=%7.1f-%7.1fs centered=%4d kept=%4d dropped=%4d"
            % (name, z_views[i], zs[i]["label"], z_t0[i] / 1000.0, z_t1[i] / 1000.0,
               centered, kept, centered - kept))

    idx = np.nonzero(keep)[0]
    Xr = X_raw[idx]
    Xs = X_shift[idx]
    gg = stats["g"][idx]
    cls = label_all[idx]
    view = np.array([z_views[i] for i in zi[idx]], dtype="U2")
    zone_name = np.array([z_names[i] for i in zi[idx]], dtype="U20")
    ck = centers[idx]
    fold = (ck >= ((z_t0[zi[idx]] + z_t1[zi[idx]]) // 2)).astype(np.uint8)
    hand = np.where(np.isin(cls, [1, 2]) & (view == "A"), "left", "none").astype("U5")
    role = np.where(view == "A", "v7_primary", "v7_hardneg").astype("U12")
    hint = np.where(view == "A", "primary", "hardneg").astype("U10")
    session = np.array(["20261030-222201_v7hands"] * len(idx), dtype="U24")
    t_all = t0s[idx].astype(np.int32)
    center_all = ck.astype(np.int32)
    win_idx = idx.astype(np.int32)

    # ---- 镜像增强：仅 view A；x -> 399-x ----
    mA = view == "A"
    nA = int(mA.sum())
    mXr = Xr[mA][:, :, :, ::-1].copy()
    mXs = Xs[mA][:, :, :, ::-1].copy()
    mg = gg[mA].copy()
    mg[:, GIDX["cx"]] = 399.0 - mg[:, GIDX["cx"]]
    mg[:, GIDX["pcx"]] = 399.0 - mg[:, GIDX["pcx"]]
    mg[:, GIDX["dx"]] = -mg[:, GIDX["dx"]]
    m_cls = cls[mA]
    m_hand = np.where(np.isin(m_cls, [1, 2]), "right", "none").astype("U5")
    log("[v7] mirror: view A rows=%d -> +%d copies" % (nA, nA))

    # ---- 合并整数路径重建的 7 min session（对照 / 负样本；y=255 丢弃）----
    try:
        sys.path.insert(0, str(V6_DIR))
        import v6_common as C6  # noqa: E402  只读复用 7min 分区名
        c6_zones = C6.ZONES
        c6_names = C6.ZONE_NAMES
        assert list(C6.GLOBAL_NAMES) == GLOBAL_NAMES
    except Exception as e:  # pragma: no cover
        raise RuntimeError("无法复用 nn/v6/v6_common.py: %r" % (e,))
    if not CTRL_NPZ.exists():
        raise SystemExit("缺少 %s；先运行 nn/v7/rebuild_control.py" % CTRL_NPZ)
    with np.load(CTRL_NPZ, allow_pickle=False) as d7:
        y7 = d7["y"].astype(np.uint8)
        keep7 = y7 != 255
        Xr7 = d7["X_raw"][keep7].astype(np.int8)
        Xs7 = d7["X"][keep7].astype(np.int8)
        g7 = d7["g"][keep7].astype(np.float32)
        y7 = y7[keep7]
        z7 = d7["zone"][keep7].astype(np.int64)
        t7 = d7["t0_rel"][keep7].astype(np.int32)
        wi7 = np.nonzero(keep7)[0].astype(np.int32)
        sess7 = str(d7["session"])
    n7 = len(y7)
    fold7 = np.zeros(n7, dtype=np.uint8)
    for zi7 in np.unique(z7):
        m = z7 == zi7
        zz = c6_zones[int(zi7)]
        fold7[m] = ((t7[m] + WIN_MS // 2) >= (zz[0] + zz[1]) // 2).astype(np.uint8)
    zone7 = np.array([c6_names[int(z)] for z in z7], dtype="U20")
    view7 = np.array(["A7"] * n7, dtype="U2")
    hand7 = np.array(["none"] * n7, dtype="U5")
    role7 = np.array(["control_7min"] * n7, dtype="U12")
    hint7 = np.where(y7 == 0, "control_neg", "control_pos").astype("U10")
    session7 = np.array([sess7] * n7, dtype="U24")
    log("[v7] 7min control(int): kept=%d (dropped exclude=%d) y0=%d y1=%d y2=%d"
        % (n7, int((~keep7).sum()),
           int((y7 == 0).sum()), int((y7 == 1).sum()), int((y7 == 2).sum())))

    def cat(*arrs):
        return np.concatenate(arrs, axis=0)

    payload = {
        "X_raw": cat(Xr, mXr, Xr7),
        "X": cat(Xs, mXs, Xs7),
        "g": cat(gg, mg, g7),
        "y": cat(cls, m_cls, y7),
        "zone": cat(zone_name, zone_name[mA], zone7),
        "view": cat(view, view[mA], view7),
        "session": cat(session, session[mA], session7),
        "t_ms": cat(t_all, t_all[mA], t7),
        "center_ms": cat(center_all, center_all[mA], t7 + WIN_MS // 2),
        "fold": cat(fold, fold[mA], fold7),
        "aug": cat(np.zeros(len(idx), np.uint8), np.ones(nA, np.uint8),
                   np.zeros(n7, np.uint8)),
        "hand": cat(hand, m_hand, hand7),
        "role": cat(role, role[mA], role7),
        "hint": cat(hint, hint[mA], hint7),
        "win_idx": cat(win_idx, win_idx[mA], wi7),
    }
    payload = {k: np.ascontiguousarray(v) for k, v in payload.items()}

    # ---- RTL 等价自检：≥200 窗逐位比对整数算术 ----
    picks = np.linspace(0, n_win - 1, min(args.n_check, n_win)).astype(int)
    check_ok, check_rows = rtl_check(stats, X_shift, x, y, pol, event_lo, event_hi, picks)
    log("[v7] RTL_CHECK windows=%d ok=%s fails=%d"
        % (len(check_rows), check_ok, sum(1 for r in check_rows if not r["ok"])))
    for r in check_rows[:8]:
        log("[v7] RTLCHK win=%4d n=%5d n_g=%5d grid=%s raw=%s %s"
            % (r["win"], r["n"], r["n_g"], r["grid_ok"], r["raw_ok"],
               "OK" if r["ok"] else "FAIL"))

    payload.update({
        "win_ms": np.int64(WIN_MS), "stride_ms": np.int64(STRIDE_MS),
        "grid_shift": np.int64(GRID_SHIFT), "grid_w": np.int64(GRID_W),
        "grid_h": np.int64(GRID_H), "channels": np.array(CHANNELS),
        "global_names": np.array(GLOBAL_NAMES),
        "zones_json": np.array(json.dumps(zs, ensure_ascii=False)),
        "label_map_json": np.array(json.dumps(LABEL_MAP, ensure_ascii=False)),
    })
    h = sha256_payload(payload)
    log("[v7] CONTENT_HASH=%s" % h)

    y_all = payload["y"]
    aug_all = payload["aug"]
    hand_all = payload["hand"]
    left_open = int(((hand_all == "left") & (y_all == 1)).sum())
    left_wave = int(((hand_all == "left") & (y_all == 2)).sum())
    right_open = int(((hand_all == "right") & (y_all == 1)).sum())
    right_wave = int(((hand_all == "right") & (y_all == 2)).sum())
    ctrl_open = int(((payload["role"] == "control_7min") & (y_all == 1)).sum())
    ctrl_wave = int(((payload["role"] == "control_7min") & (y_all == 2)).sum())
    y_counts = {int(v): int((y_all == v).sum()) for v in np.unique(y_all)}
    view_counts = {str(v): int((payload["view"] == v).sum()) for v in np.unique(payload["view"])}
    role_counts = {str(v): int((payload["role"] == v).sum()) for v in np.unique(payload["role"])}
    zone_kept = {}
    for zname in np.unique(payload["zone"]):
        m = payload["zone"] == zname
        zone_kept[str(zname)] = {"total": int(m.sum()),
                                 "y0": int((y_all[m] == 0).sum()),
                                 "y1": int((y_all[m] == 1).sum()),
                                 "y2": int((y_all[m] == 2).sum()),
                                 "aug": int((aug_all[m] == 1).sum())}
    log("[v7] y counts=%s" % json.dumps(y_counts, sort_keys=True))
    log("[v7] view counts=%s role counts=%s" % (json.dumps(view_counts, sort_keys=True),
                                                json.dumps(role_counts, sort_keys=True)))
    log("[v7] MIRROR_BEFORE left_open=%d left_wave=%d | MIRROR_AFTER right_open=%d right_wave=%d"
        % (left_open, left_wave, right_open, right_wave))
    log("[v7] CONTROL_7MIN open=%d wave=%d (仅对照/负样本)" % (ctrl_open, ctrl_wave))
    log("[v7] TOTAL rows=%d (v7=%d + mirror=%d + control=%d)"
        % (len(y_all), len(idx), nA, n7))

    np.savez_compressed(args.out, **payload)
    log("[v7] wrote %s (%.1f MB)" % (args.out, Path(args.out).stat().st_size / 1e6))

    summary = {
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "data_version": DATA_VERSION,
        "session": "20261030-222201_v7hands",
        "control_session": sess7,
        "rec_dir": str(REC),
        "board0_ms": board0,
        "grid_origin_rel_ms": g0,
        "frames": len(ft), "events": int(len(rel)),
        "win_ms": WIN_MS, "stride_ms": STRIDE_MS, "grid_shift": GRID_SHIFT,
        "n_windows_session": n_win,
        "n_windows_v7_kept": int(len(idx)),
        "n_mirror": nA,
        "n_control_7min": n7,
        "n_rows": int(len(y_all)),
        "zones": zone_counts,
        "zone_kept": zone_kept,
        "y_counts": y_counts,
        "view_counts": view_counts,
        "role_counts": role_counts,
        "contract": {
            "coords": "events.csv x,y = raw pixel 400x240 integers; grid 50x30 via >>3",
            "window": "100 ms width, 50 ms stride, t0_k = grid_origin_rel_ms + 50k",
            "centroid": "cx=floor(Sx/n), cy=floor(Sy/n) in raw px; n==0 keeps last valid (init 200/120)",
            "sx": "isqrt((Sx2*n - Sx^2)//(n*n)) raw px, floor",
            "shift_normalize": "x'=clamp(x-(pcx-200),0,399), gx=x'>>3; y'=clamp(y-(pcy-120),0,239), gy=y'>>3; "
                               "pcx/pcy = previous window's integer centroid",
            "counts": "per-cell event count, saturate 127; channels [ON_now,OFF_now,ON_prev,OFF_prev]",
            "globals": "17 channels: 16 integer-valued (n,on,off,cx,cy,sx,sy,pcx,pcy,dx,dy,speed,dsx,dsy,frames,prev_n) + bal=(on-off)/n rational; deployment features are integerized separately",
            "arithmetic": "integer subtract + clamp + shift + 16-bit bincount; no multiplier in windowing",
        },
        "mirror": {"before": {"left_open": left_open, "left_wave": left_wave},
                   "after": {"right_open": right_open, "right_wave": right_wave},
                   "formula_grid": "x -> %d-1-x (=399-x)，通道不变" % (GRID_W * (1 << GRID_SHIFT)),
                   "formula_globals": "cx=399-cx, pcx=399-pcx, dx=-dx；dsx/dsy 不取负（sigma 为标量），"
                                      "cy/pcy/dy/sx/sy/n/on/off/bal/frames/prev_n 不变",
                   "policy": "只镜像 view A；view B 不镜像；镜像样本 aug=1 且 fold 与原窗相同"},
        "control_note": "7min session（20261030-212214_v5probe）只作负样本/对照，y=255 已丢弃；"
                        "其阳性标签有 2-6.5s 边界偏移，不建议当正样本训练",
        "fold": "每个 zone 内按时间中点前后半 0/1；镜像随原窗",
        "self_check": {"kind": "rtl_equivalence_200_windows",
                       "sample_n": len(check_rows), "all_ok": bool(check_ok),
                       "fails": sum(1 for r in check_rows if not r["ok"]),
                       "rows": check_rows},
        "content_hash": h,
        "content_hash_v7_0": "a65a66d0007760572b6f90f04b95e6a914fb9a37a964f486da23a215c1b72837",
        "npz": str(Path(args.out).resolve()),
        "elapsed_s": round(time.time() - t_start, 1),
        "cmd": "PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/build_v7.py",
    }
    Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log("[v7] summary -> %s" % args.summary)
    log("[v7] done in %.1fs" % (time.time() - t_start))
    return 0 if check_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
