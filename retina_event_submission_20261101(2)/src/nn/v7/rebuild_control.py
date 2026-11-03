#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 RTL 等价整数路径重建 7 min control session（20261030-212214_v5probe）。

与 nn/v6/convert_records.py 相同的窗口划分（g0=首事件 rel、100ms 窗 / 50ms 步），
但坐标/质心/平移归一化全部走 nn/v7/intwin.py 的整数路径（与板上 nn_winstat/nn_feat 一致）。

输出：
  nn/v7/control_7min_int.npz
  temp_test/v7/control_raw_cache.npz（原始事件缓存）
  nn/out_v7/control_7min_int_summary.json
"""
from __future__ import annotations

import argparse
import csv
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
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C6  # noqa: E402  只读复用 7min 分区定义

REC = ROOT / "records" / "20261030-212214_v5probe"
OUT = ROOT / "nn" / "v7" / "control_7min_int.npz"
CACHE = ROOT / "temp_test" / "v7" / "control_raw_cache.npz"
SUMMARY = ROOT / "nn" / "out_v7" / "control_7min_int_summary.json"


def log(msg):
    print(msg, flush=True)


def load_frames():
    parts = []
    for ci in (0, 1):
        p = REC / ("chunk-%03d.frames.csv" % ci)
        with open(p, "r", newline="", encoding="utf-8") as f:
            rd = csv.reader(f)
            hdr = next(rd)
            assert hdr[:3] == ["frame_idx", "t_board_ms", "t_arrive_ms"], hdr
            parts.extend(int(row[1]) for row in rd)
    return np.asarray(parts, dtype=np.int64)


def load_events(n_expected: int):
    """流式解析两个 chunk 的 events.csv（标准库 csv）。"""
    t = np.empty(n_expected, dtype=np.int64)
    x = np.empty(n_expected, dtype=np.int16)
    y = np.empty(n_expected, dtype=np.int16)
    pol = np.empty(n_expected, dtype=np.int8)
    t0 = time.time()
    i = 0
    for ci in (0, 1):
        p = REC / ("chunk-%03d.events.csv" % ci)
        with open(p, "r", newline="", encoding="utf-8") as f:
            rd = csv.reader(f)
            hdr = next(rd)
            assert hdr[:5] == ["frame_idx", "frame_t_ms", "x", "y", "pol"], hdr
            for row in rd:
                if i >= n_expected:
                    raise RuntimeError("events 行数超过 meta 计数 %d" % n_expected)
                t[i] = int(row[1]); x[i] = int(row[2]); y[i] = int(row[3]); pol[i] = int(row[4])
                i += 1
                if i % 2000000 == 0:
                    log("[ctrl] parse events %d / %d  %.1fs" % (i, n_expected, time.time() - t0))
    if i != n_expected:
        raise RuntimeError("events 行数 %d != meta %d" % (i, n_expected))
    return t, x, y, pol


def load_or_parse(board0: int, n_expected: int):
    src = [REC / "chunk-000.events.csv", REC / "chunk-001.events.csv"]
    if CACHE.exists():
        with np.load(CACHE, allow_pickle=False) as d:
            ok = (int(d["board0"]) == board0 and int(d["n_events"]) == n_expected)
            for j, p in enumerate(src):
                st = p.stat()
                ok = ok and int(d["src_size_%d" % j]) == st.st_size
                ok = ok and int(d["src_mtime_%d" % j]) == st.st_mtime_ns
            if ok:
                log("[ctrl] raw cache hit %s (%d events)" % (CACHE, len(d["rel"])))
                return (d["rel"].astype(np.int64), d["x"].astype(np.int32),
                        d["y"].astype(np.int32), d["pol"].astype(np.int8))
    t_abs, x, y, pol = load_events(n_expected)
    rel = t_abs - board0
    order = np.argsort(rel, kind="stable")
    if not np.array_equal(order, np.arange(len(rel))):
        log("[ctrl] events not time-sorted; stable argsort applied")
        rel, x, y, pol = rel[order], x[order], y[order], pol[order]
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    st0, st1 = src[0].stat(), src[1].stat()
    np.savez(CACHE, rel=rel.astype(np.int64), x=x.astype(np.int16), y=y.astype(np.int16),
             pol=pol.astype(np.int8), board0=np.int64(board0), n_events=np.int64(n_expected),
             src_size_0=np.int64(st0.st_size), src_mtime_0=np.int64(st0.st_mtime_ns),
             src_size_1=np.int64(st1.st_size), src_mtime_1=np.int64(st1.st_mtime_ns))
    log("[ctrl] raw cache written %s" % CACHE)
    return rel, x, y, pol


def rtl_check(g, X, sub, x, y, pol, event_lo, event_hi, g0, picks):
    """独立整数参考实现：逐窗重算统计量/质心/平移网格，与 intwin 输出逐位比较。"""
    rows = []
    ok_all = True
    for k in picks:
        a, b = int(event_lo[k]), int(event_hi[k])
        n = on = off = Sx = Sy = Sx2 = Sy2 = 0
        cnt = np.zeros((2, IW.GRID_H, IW.GRID_W), dtype=np.int64)
        pcx = int(g[k, IW.GIDX["pcx"]]); pcy = int(g[k, IW.GIDX["pcy"]])
        for i in range(a, b):
            xi = int(x[i]); yi = int(y[i]); pi = int(pol[i])
            n += 1
            if pi == 1:
                on += 1
            else:
                off += 1
            Sx += xi; Sy += yi; Sx2 += xi * xi; Sy2 += yi * yi
            gx = min(IW.X_PIX_MAX, max(0, xi - (pcx - 200))) >> IW.GRID_SHIFT
            gy = min(IW.Y_PIX_MAX, max(0, yi - (pcy - 120))) >> IW.GRID_SHIFT
            cnt[0 if pi == 1 else 1, gy, gx] += 1
        if n > 0:
            cx = Sx // n; cy = Sy // n
            sx = math.isqrt(max(Sx2 * n - Sx * Sx, 0) // (n * n))
            sy = math.isqrt(max(Sy2 * n - Sy * Sy, 0) // (n * n))
        else:
            cx = int(g[k, IW.GIDX["cx"]]); cy = int(g[k, IW.GIDX["cy"]]); sx = sy = 0
        chk = {
            "win": int(k),
            "n": (n, int(g[k, IW.GIDX["n"]])),
            "on": (on, int(g[k, IW.GIDX["on"]])),
            "off": (off, int(g[k, IW.GIDX["off"]])),
            "cx": (cx, int(g[k, IW.GIDX["cx"]])),
            "cy": (cy, int(g[k, IW.GIDX["cy"]])),
            "sx": (sx, int(g[k, IW.GIDX["sx"]])),
            "sy": (sy, int(g[k, IW.GIDX["sy"]])),
            "dx": (cx - pcx if n else 0, int(g[k, IW.GIDX["dx"]])),
            "grid": (cnt[0].tolist(), cnt[1].tolist()),
        }
        got0 = X[k, 0].astype(np.int64); got1 = X[k, 1].astype(np.int64)
        grid_ok = bool(np.array_equal(np.clip(cnt[0], 0, 127), got0)
                       and np.array_equal(np.clip(cnt[1], 0, 127), got1))
        feats_ok = all(v[0] == v[1] for key, v in chk.items() if key not in ("grid", "win"))
        ok = grid_ok and feats_ok
        ok_all = ok_all and ok
        rows.append({"win": int(k), "ok": ok, "grid_ok": grid_ok, "feats_ok": feats_ok,
                     "n": n, "n_g": int(g[k, IW.GIDX["n"]])})
    return ok_all, rows


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--n-check", type=int, default=200)
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args(argv)
    t_start = time.time()
    if args.no_cache and CACHE.exists():
        CACHE.unlink()
    meta = json.loads((REC / "meta.json").read_text(encoding="utf-8"))
    n_expected = int(meta["counters"]["events"])
    ft_abs = load_frames()
    board0 = int(ft_abs[0])
    ft = ft_abs - board0
    log("[ctrl] frames=%d board0=%d span=%.3fs" % (len(ft), board0, (ft[-1] - ft[0]) / 1000.0))
    rel, x, y, pol = load_or_parse(board0, n_expected)
    g0, n_win, n_sub = IW.n_windows(rel)
    log("[ctrl] events=%d rel=%d..%d g0=%d n_win=%d n_sub=%d" % (len(rel), rel[0], rel[-1], g0, n_win, n_sub))
    sub = IW.subblock_stats(rel, x, y, pol, g0, n_sub)
    frames = (np.searchsorted(ft, np.arange(n_win) * IW.STRIDE_MS + g0 + IW.WIN_MS, side="left")
              - np.searchsorted(ft, np.arange(n_win) * IW.STRIDE_MS + g0, side="left")).astype(np.int32)
    st = IW.window_stats(sub, n_win, frames)
    X_raw = IW.raw_grids(sub["sub_grid"], n_win)
    X, event_lo, event_hi = IW.shifted_grids(rel, x, y, pol, g0, n_win, st,
                                             log=lambda m: log(m))
    log("[ctrl] n_bad_events=%d max_window_n=%d" % (sub["n_bad"], int(st["n"].max())))
    picks = np.linspace(0, n_win - 1, min(args.n_check, n_win)).astype(int)
    ok_all, rows = rtl_check(st["g"], X, sub, x, y, pol, event_lo, event_hi, g0, picks)
    log("[ctrl] RTL_CHECK windows=%d ok=%s fails=%d" % (len(rows), ok_all,
                                                        sum(1 for r in rows if not r["ok"])))

    centers = IW.window_t0(rel, g0, n_win) + IW.WIN_MS // 2
    zone = C6.zones_of(centers)
    y_lab = np.array([C6.zone_label(int(z)) for z in zone], dtype=np.uint8)
    open_seg = np.array([C6.open_chunk(int(c)) for c in centers], dtype=np.int32)
    wave_seg = np.array([C6.wave_chunk(int(c)) for c in centers], dtype=np.int32)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.out,
        X_raw=X_raw, X=X, g=st["g"], y=y_lab, zone=zone.astype(np.int8),
        t0_rel=IW.window_t0(rel, g0, n_win).astype(np.int32),
        center_rel=centers.astype(np.int32), frames=frames,
        open_seg=open_seg, wave_seg=wave_seg,
        win_ms=np.int64(IW.WIN_MS), stride_ms=np.int64(IW.STRIDE_MS),
        grid_shift=np.int64(IW.GRID_SHIFT), grid_w=np.int64(IW.GRID_W), grid_h=np.int64(IW.GRID_H),
        channels=np.array(IW.CHANNELS), global_names=np.array(IW.GLOBAL_NAMES),
        session=np.array("20261030-212214_v5probe"),
        board0=np.int64(board0), grid_origin=np.int64(g0),
    )
    log("[ctrl] wrote %s (%.1f MB)" % (args.out, Path(args.out).stat().st_size / 1e6))

    per_zone = {}
    for zi, zname in enumerate(C6.ZONE_NAMES):
        m = zone == zi
        if not m.any():
            continue
        gn = st["g"][m, IW.GIDX["n"]]
        per_zone[zname] = {"windows": int(m.sum()),
                           "mean_events_per_window": round(float(gn.mean()), 1),
                           "p90_events": round(float(np.percentile(gn, 90)), 1),
                           "mean_sx_px": round(float(st["g"][m, IW.GIDX["sx"]].mean()), 1),
                           "mean_speed_px": round(float(st["g"][m, IW.GIDX["speed"]].mean()), 1),
                           "frac_n_gt_30": round(float((gn > 30).mean()), 3)}
    summ = {
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "session": "20261030-212214_v5probe",
        "rec_dir": str(REC), "board0_ms": board0, "grid_origin_rel_ms": g0,
        "n_frames": len(ft), "n_events": int(len(rel)), "n_windows": n_win,
        "win_ms": IW.WIN_MS, "stride_ms": IW.STRIDE_MS, "grid_shift": IW.GRID_SHIFT,
        "y_counts": {int(v): int((y_lab == v).sum()) for v in np.unique(y_lab)},
        "rtl_check": {"windows": len(rows), "all_ok": ok_all,
                      "fails": sum(1 for r in rows if not r["ok"]),
                      "sample": rows[:10]},
        "per_zone": per_zone,
        "contract": "coords=raw px 400x240; centroid=floor(sum/n) keep-last on n=0; "
                    "shift=clamp(x-(pcx-200),0,399)>>3; sx=isqrt; int64 exact; "
                    "only subtraction+clamp+shift (no multiplier)",
        "cmd": "PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/rebuild_control.py",
        "elapsed_s": round(time.time() - t_start, 1),
    }
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(summ, ensure_ascii=False, indent=2), encoding="utf-8")
    log("[ctrl] summary -> %s" % SUMMARY)
    log("[ctrl] done in %.1fs" % (time.time() - t_start))
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
