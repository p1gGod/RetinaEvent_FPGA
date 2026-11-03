#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 records/20261030-212214_v5probe 的两段 events.csv 转成 100 ms 窗口 npz（v6 表征实验用）。

与 v4/v5 训练集完全一致的口径：
  - 坐标 x,y 为 400x240 原始事件坐标；网格 shift=3 -> 50x30
  - 通道 [ON_now, OFF_now, ON_prev, OFF_prev]，pol=1(ON) -> 通道 0（同 extract_events.count_window）
  - 窗口 100 ms、步长 50 ms；首个窗口起点 = 首个事件时刻（同 extract_events.window_starts）
  - 计数饱和到 127 存 int8；另存平移归一化网格（按上一窗质心平移，c3 表征）
输出：nn/v6/windows/real_w100.npz + convert_summary.json
用法：python nn/v6/convert_records.py [--max-events N] [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

try:
    import pandas as pd
except ImportError:
    # 不降级：缺 pandas 直接退出，避免生成半成品 npz。
    print(
        "[v6] 本脚本需要 pandas：python -m pip install -r nn/v6/requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(3)

ROOT = Path(os.environ.get("RETE_ROOT") or Path(__file__).resolve().parents[2])
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402

REC = ROOT / "records" / "20261030-212214_v5probe"
DEFAULT_OUT = ROOT / "nn" / "v6" / "windows" / "real_w100.npz"


def load_frames():
    parts = []
    for ci in (0, 1):
        p = REC / f"chunk-{ci:03d}.frames.csv"
        fr = pd.read_csv(p, dtype={"frame_idx": np.int64, "t_board_ms": np.int64,
                                   "t_arrive_ms": np.int64})
        parts.append(fr)
    fr = pd.concat(parts, ignore_index=True)
    return fr["t_board_ms"].to_numpy(np.int64), fr["frame_idx"].to_numpy(np.int64)


def load_events(max_events: int | None = None):
    cols = ["frame_t_ms", "x", "y", "pol"]
    dtypes = {"frame_t_ms": np.int64, "x": np.int16, "y": np.int16, "pol": np.int8}
    parts = []
    for ci in (0, 1):
        p = REC / f"chunk-{ci:03d}.events.csv"
        df = pd.read_csv(p, usecols=cols, dtype=dtypes)
        parts.append(df)
    df = pd.concat(parts, ignore_index=True)
    t = df["frame_t_ms"].to_numpy(np.int64)
    x = df["x"].to_numpy(np.int32)
    y = df["y"].to_numpy(np.int32)
    pol = df["pol"].to_numpy(np.int8)
    del df, parts
    order = np.argsort(t, kind="stable")
    if not np.array_equal(order, np.arange(len(t))):
        t, x, y, pol = t[order], x[order], y[order], pol[order]
    if max_events:
        t, x, y, pol = t[:max_events], x[:max_events], y[:max_events], pol[:max_events]
    return t, x, y, pol


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-events", type=int, default=0)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    t_start = time.time()

    ft_abs, _fidx = load_frames()
    board0 = int(ft_abs[0])
    ft = ft_abs - board0
    print("[conv] frames=%d board0=%d, frame span rel=%d..%d" % (len(ft), board0, ft[0], ft[-1]))

    t_abs, x, y, pol = load_events(args.max_events or None)
    n_ev = len(t_abs)
    rel = t_abs - board0
    print("[conv] events=%d rel=%d..%d pol1(ON)=%d pol0(OFF)=%d" %
          (n_ev, rel[0], rel[-1], int((pol == 1).sum()), int((pol == 0).sum())))
    raw_x_range = (int(x.min()), int(x.max())); raw_y_range = (int(y.min()), int(y.max()))
    print("[conv] x range=%d..%d  y range=%d..%d" % (raw_x_range + raw_y_range))

    g0 = int(rel[0])
    t_last = int(rel[-1])
    n_win = (t_last - g0 - C.WIN_MS) // C.STRIDE_MS + 1
    if n_win < 10:
        print("[conv] too few windows"); return 2
    sub_bin = C.STRIDE_MS
    n_sub = (t_last - g0) // sub_bin + 2
    print("[conv] grid origin=%d ms, windows=%d (100ms/50ms), sub-blocks=%d" % (g0, n_win, n_sub))

    # 50ms 子块计数：一次 bincount（索引 = sidx * 2*1500 + ch*1500 + cell）
    sidx = (rel - g0) // sub_bin
    gx = x >> C.GRID_SHIFT
    gy = y >> C.GRID_SHIFT
    ok = (gx >= 0) & (gx < C.GRID_W) & (gy >= 0) & (gy < C.GRID_H)
    n_bad = int((~ok).sum())
    cid = gy[ok] * C.GRID_W + gx[ok]
    ch = (1 - pol[ok]).astype(np.int64)  # pol=1(ON) -> 0
    flat = sidx[ok] * (2 * C.N_CELLS) + ch * C.N_CELLS + cid
    sub = np.bincount(flat, minlength=n_sub * 2 * C.N_CELLS).reshape(n_sub, 2, C.GRID_H, C.GRID_W)
    sub_max = int(sub.max())
    print("[conv] sub-block counts: max=%d, out-of-grid events=%d" % (sub_max, n_bad))
    assert int(sub.sum()) == n_ev - n_bad
    assert sub_max <= 65535, "50ms sub-block count overflow uint16: %d" % sub_max
    sub = sub.astype(np.uint16)
    del flat, cid, ch, gx, gy, ok, sidx

    X_q = np.zeros((n_win, 4, C.GRID_H, C.GRID_W), dtype=np.int8)
    Xq_shift = np.zeros_like(X_q)
    g = np.zeros((n_win, len(C.GLOBAL_NAMES)), dtype=np.float32)
    t0s = np.arange(n_win, dtype=np.int64) * C.STRIDE_MS + g0
    frames = (np.searchsorted(ft, t0s + C.WIN_MS, side="left")
              - np.searchsorted(ft, t0s, side="left")).astype(np.int32)

    # 事件指针（rel 已排序）
    event_lo = np.searchsorted(rel, t0s, side="left")
    event_hi = np.searchsorted(rel, t0s + C.WIN_MS, side="left")

    prev_now = np.zeros((2, C.GRID_H, C.GRID_W), dtype=np.int64)
    prev_shift = np.zeros((2, C.GRID_H, C.GRID_W), dtype=np.int8)
    prev_n = 0.0
    pcx = 200.0
    pcy = 120.0
    psx = 0.0
    psy = 0.0
    cellx = (np.arange(C.GRID_W) * (1 << C.GRID_SHIFT) + (1 << (C.GRID_SHIFT - 1))).astype(np.float64)
    celly = (np.arange(C.GRID_H) * (1 << C.GRID_SHIFT) + (1 << (C.GRID_SHIFT - 1))).astype(np.float64)
    gx_idx = np.arange(C.GRID_W, dtype=np.float64)

    CH_BLOCK = 256
    for k0 in range(0, n_win, CH_BLOCK):
        k1 = min(n_win, k0 + CH_BLOCK)
        sb = sub[k0:k1 + 1].astype(np.int64)
        blk = (sb[:-1] + sb[1:])  # (B, 2, H, W)：窗口 k = sub[k]+sub[k+1]
        for i in range(k1 - k0):
            k = k0 + i
            now = blk[i]
            X_q[k, 0] = np.clip(now[0], 0, C.SAT)
            X_q[k, 1] = np.clip(now[1], 0, C.SAT)
            X_q[k, 2] = np.clip(prev_now[0], 0, C.SAT)
            X_q[k, 3] = np.clip(prev_now[1], 0, C.SAT)
            # ---- 全局量（now 网格）----
            cnt = now.sum(axis=0).astype(np.float64)          # (30,50)
            n = float(cnt.sum())
            on = float(now[0].sum()); off = float(now[1].sum())
            if n > 0:
                cx = float((cnt.sum(axis=0) * cellx).sum() / n)
                cy = float((cnt.sum(axis=1) * celly).sum() / n)
                varx = float((cnt.sum(axis=0) * (cellx - cx) ** 2).sum() / n)
                vary = float((cnt.sum(axis=1) * (celly - cy) ** 2).sum() / n)
                sx = float(np.sqrt(max(varx, 0.0))); sy = float(np.sqrt(max(vary, 0.0)))
            else:
                cx, cy, sx, sy = 200.0, 120.0, 0.0, 0.0
            g[k, C.GIDX["n"]] = n
            g[k, C.GIDX["on"]] = on
            g[k, C.GIDX["off"]] = off
            g[k, C.GIDX["cx"]] = cx
            g[k, C.GIDX["cy"]] = cy
            g[k, C.GIDX["sx"]] = sx
            g[k, C.GIDX["sy"]] = sy
            g[k, C.GIDX["pcx"]] = pcx
            g[k, C.GIDX["pcy"]] = pcy
            g[k, C.GIDX["dx"]] = cx - pcx
            g[k, C.GIDX["dy"]] = cy - pcy
            g[k, C.GIDX["speed"]] = float(np.hypot(cx - pcx, cy - pcy))
            g[k, C.GIDX["dsx"]] = sx - psx
            g[k, C.GIDX["dsy"]] = sy - psy
            g[k, C.GIDX["bal"]] = (on - off) / n if n > 0 else 0.0
            g[k, C.GIDX["frames"]] = float(frames[k])
            g[k, C.GIDX["prev_n"]] = prev_n
            # ---- 平移归一化网格（c3）：按上一窗质心把画面中心搬到 (200,120) ----
            offx = int(round(pcx - 200.0)); offy = int(round(pcy - 120.0))
            a, b = int(event_lo[k]), int(event_hi[k])
            if b > a:
                xs = x[a:b] - offx
                ys = y[a:b] - offy
                gxs = xs >> C.GRID_SHIFT
                gys = ys >> C.GRID_SHIFT
                sok = (gxs >= 0) & (gxs < C.GRID_W) & (gys >= 0) & (gys < C.GRID_H)
                if sok.any():
                    cid2 = gys[sok] * C.GRID_W + gxs[sok]
                    ch2 = (1 - pol[a:b][sok]).astype(np.int64)
                    flat2 = ch2 * C.N_CELLS + cid2
                    cnt2 = np.bincount(flat2, minlength=2 * C.N_CELLS).reshape(2, C.GRID_H, C.GRID_W)
                    Xq_shift[k, 0] = np.clip(cnt2[0], 0, C.SAT)
                    Xq_shift[k, 1] = np.clip(cnt2[1], 0, C.SAT)
            Xq_shift[k, 2] = prev_shift[0]
            Xq_shift[k, 3] = prev_shift[1]
            # ---- 滚动状态 ----
            prev_now = now
            prev_shift = np.stack([Xq_shift[k, 0], Xq_shift[k, 1]]).astype(np.int8)
            prev_n = n
            pcx, pcy, psx, psy = cx, cy, sx, sy
        del blk, sb
        if (k0 // CH_BLOCK) % 4 == 0:
            print("[conv] windows %d/%d  %.1fs" % (k1, n_win, time.time() - t_start), flush=True)

    centers = t0s + C.WIN_MS // 2
    zone = C.zones_of(centers)
    y = np.array([C.zone_label(z) for z in zone.tolist()], dtype=np.uint8)  # 255=exclude
    open_seg = np.array([C.open_chunk(c) for c in centers.tolist()], dtype=np.int32)
    wave_seg = np.array([C.wave_chunk(c) for c in centers.tolist()], dtype=np.int32)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "session": "20261030-212214_v5probe",
        "source": "real_7min_recording",
        "rec_dir": str(REC),
        "board0_ms": board0,
        "grid_origin_rel_ms": g0,
        "win_ms": C.WIN_MS, "stride_ms": C.STRIDE_MS, "grid_shift": C.GRID_SHIFT,
        "grid_w": C.GRID_W, "grid_h": C.GRID_H,
        "channels": list(C.CHANNELS),
        "zones": [{"t0_ms": z[0], "t1_ms": z[1], "name": z[2], "label": z[3], "group": z[4]}
                  for z in C.ZONES],
        "n_windows": int(n_win),
        "n_events": int(n_ev),
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "note": "X_q 为 v4/v5 口径的 4 通道 int8；Xq_shift 按上一窗质心平移后计数；g 为全局量（raw px）",
    }
    np.savez_compressed(
        out,
        X_q=X_q, Xq_shift=Xq_shift, g=g,
        t0_rel=t0s.astype(np.int32), center_rel=centers.astype(np.int32),
        y=y, zone=zone.astype(np.int8), open_seg=open_seg, wave_seg=wave_seg,
        frames=frames,
        win_ms=np.int64(C.WIN_MS), stride_ms=np.int64(C.STRIDE_MS),
        grid_shift=np.int64(C.GRID_SHIFT),
        session=np.array(meta["session"]),
        boards0=np.int64(board0), grid_origin=np.int64(g0),
        zones_json=np.array(json.dumps(meta["zones"], ensure_ascii=False)),
    )

    # 摘要
    summ = {"meta": meta, "per_zone": {}}
    for zi, zname in enumerate(C.ZONE_NAMES):
        m = zone == zi
        if not m.any():
            continue
        gn = g[m, C.GIDX["n"]]
        summ["per_zone"][zname] = {
            "windows": int(m.sum()),
            "mean_events_per_window": round(float(gn.mean()), 1),
            "p50_events": round(float(np.percentile(gn, 50)), 1),
            "p90_events": round(float(np.percentile(gn, 90)), 1),
            "mean_sx_raw_px": round(float(g[m, C.GIDX["sx"]].mean()), 1),
            "mean_sy_raw_px": round(float(g[m, C.GIDX["sy"]].mean()), 1),
            "mean_speed_raw_px_per_win": round(float(g[m, C.GIDX["speed"]].mean()), 1),
            "frac_n_gt_30": round(float((gn > 30).mean()), 3),
        }
    json_path = out.parent / "convert_summary.json"
    json_path.write_text(json.dumps(summ, ensure_ascii=False, indent=2), encoding="utf-8")

    print("[conv] saved %s (%.1f MB) in %.1fs" %
          (out, out.stat().st_size / 1e6, time.time() - t_start))
    print("[conv] raw x-range=%d..%d y-range=%d..%d" % (raw_x_range + raw_y_range))
    for zname, s in summ["per_zone"].items():
        print("[conv] %-11s win=%4d  ev/win=%8.1f  sx=%6.1f  speed=%7.1f  n>30=%.2f" %
              (zname, s["windows"], s["mean_events_per_window"], s["mean_sx_raw_px"],
               s["mean_speed_raw_px_per_win"], s["frac_n_gt_30"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
