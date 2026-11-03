# -*- coding: utf-8 -*-
"""独立验证 session -> 100ms 窗（与 convert_records.py 同口径，标签用 lead 给的 215700 协议表）。
用法：python nn/v6/convert_verify_session.py [--rec-dir DIR] [--out NPZ] [--session NAME]
"""
from __future__ import annotations
import argparse, json, time
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path("E:/workspace/FPGA_Comp")
import sys
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402

# lead 提供的协议标签（相对秒，[a,b)）；255=exclude，class1=开合，class2=挥手
ZONES_215700 = [
    (0.0,   1.0,   "startup",     255, "exclude"),
    (1.0,   20.0,  "empty_A",     0,   "static"),
    (20.0,  50.0,  "openclose_R", 1,   "open"),
    (50.0,  70.0,  "static_A",    0,   "static"),
    (70.0,  100.0, "wave_R",      2,   "wave"),
    (100.0, 120.0, "static_B",    0,   "static"),   # 脏静态（残余小动作），单列
    (120.0, 145.0, "openclose_L", 1,   "open"),
    (145.0, 170.0, "wave_L",      2,   "wave"),
    (170.0, 183.0, "motion_tail", 2,   "wave"),     # 视频确认仍在挥/抽手，单列
    (183.0, 194.0, "empty_B",     0,   "static"),
    (194.0, 1e9,   "end",         255, "exclude"),
]


def load_session(rec_dir: Path):
    ev_parts, fr_parts = [], []
    for p in sorted(rec_dir.glob("chunk-*.events.csv")):
        fr = p.with_name(p.name.replace(".events.csv", ".frames.csv"))
        ev_parts.append(pd.read_csv(p, usecols=["frame_t_ms", "x", "y", "pol"],
                                    dtype={"frame_t_ms": np.int64, "x": np.int16,
                                           "y": np.int16, "pol": np.int8}))
        fr_parts.append(pd.read_csv(fr, dtype={"t_board_ms": np.int64}))
    ev = pd.concat(ev_parts, ignore_index=True)
    fr = pd.concat(fr_parts, ignore_index=True)
    t = ev["frame_t_ms"].to_numpy(np.int64)
    x = ev["x"].to_numpy(np.int32)
    y = ev["y"].to_numpy(np.int32)
    pol = ev["pol"].to_numpy(np.int8)
    order = np.argsort(t, kind="stable")
    t, x, y, pol = t[order], x[order], y[order], pol[order]
    ft_abs_all, fidx_all = fr["t_board_ms"].to_numpy(np.int64), fr["frame_idx"].to_numpy(np.int64)
    order_f = np.argsort(ft_abs_all, kind="stable")
    ft_abs, fidx = ft_abs_all[order_f], fidx_all[order_f]
    return t, x, y, pol, ft_abs, fidx


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rec-dir", default="records/20261030-215700_v6clean")
    ap.add_argument("--out", default="nn/out_v6/verify_215700_windows.npz")
    ap.add_argument("--session", default="20261030-215700_v6clean")
    args = ap.parse_args(argv)
    t0 = time.time()
    rec = Path(args.rec_dir)
    t_abs, x, y, pol, ft_abs, fidx = load_session(rec)
    board0 = int(ft_abs[0])
    ft = ft_abs - board0
    rel = t_abs - board0
    print("[conv] frames=%d events=%d board0=%d rel=%d..%d" % (len(ft), len(rel), board0, rel[0], rel[-1]))
    print("[conv] pol ON=%d OFF=%d  x=%d..%d y=%d..%d" % (int((pol == 1).sum()), int((pol == 0).sum()),
          int(x.min()), int(x.max()), int(y.min()), int(y.max())))
    g0 = int(rel[0]); t_last = int(rel[-1])
    n_win = (t_last - g0 - C.WIN_MS) // C.STRIDE_MS + 1
    n_sub = (t_last - g0) // C.STRIDE_MS + 2
    print("[conv] grid origin=%d windows=%d" % (g0, n_win))

    sidx = (rel - g0) // C.STRIDE_MS
    gx = x >> C.GRID_SHIFT
    gy = y >> C.GRID_SHIFT
    ok = (gx >= 0) & (gx < C.GRID_W) & (gy >= 0) & (gy < C.GRID_H)
    cid = gy[ok] * C.GRID_W + gx[ok]
    ch = (1 - pol[ok]).astype(np.int64)
    flat = sidx[ok] * (2 * C.N_CELLS) + ch * C.N_CELLS + cid
    sub = np.bincount(flat, minlength=n_sub * 2 * C.N_CELLS).reshape(n_sub, 2, C.GRID_H, C.GRID_W)
    assert int(sub.sum()) == int(ok.sum())
    sub = sub.astype(np.uint16)
    del flat, cid, ch, gx, gy, ok, sidx

    t0s = np.arange(n_win, dtype=np.int64) * C.STRIDE_MS + g0
    centers = t0s + C.WIN_MS // 2
    frames = (np.searchsorted(ft, t0s + C.WIN_MS, side="left")
              - np.searchsorted(ft, t0s, side="left")).astype(np.int32)
    event_lo = np.searchsorted(rel, t0s, side="left")
    event_hi = np.searchsorted(rel, t0s + C.WIN_MS, side="left")

    X_q = np.zeros((n_win, 4, C.GRID_H, C.GRID_W), dtype=np.int8)
    Xq_shift = np.zeros_like(X_q)
    g = np.zeros((n_win, len(C.GLOBAL_NAMES)), dtype=np.float32)
    cellx = (np.arange(C.GRID_W) * (1 << C.GRID_SHIFT) + (1 << (C.GRID_SHIFT - 1))).astype(np.float64)
    celly = (np.arange(C.GRID_H) * (1 << C.GRID_SHIFT) + (1 << (C.GRID_SHIFT - 1))).astype(np.float64)

    prev_now = np.zeros((2, C.GRID_H, C.GRID_W), dtype=np.int64)
    prev_shift = np.zeros((2, C.GRID_H, C.GRID_W), dtype=np.int8)
    prev_n = 0.0; pcx, pcy, psx, psy = 200.0, 120.0, 0.0, 0.0
    CH_BLOCK = 256
    for k0 in range(0, n_win, CH_BLOCK):
        k1 = min(n_win, k0 + CH_BLOCK)
        sb = sub[k0:k1 + 1].astype(np.int64)
        blk = sb[:-1] + sb[1:]
        for i in range(k1 - k0):
            k = k0 + i
            now = blk[i]
            X_q[k, 0] = np.clip(now[0], 0, C.SAT)
            X_q[k, 1] = np.clip(now[1], 0, C.SAT)
            X_q[k, 2] = np.clip(prev_now[0], 0, C.SAT)
            X_q[k, 3] = np.clip(prev_now[1], 0, C.SAT)
            cnt = now.sum(axis=0).astype(np.float64)
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
            g[k, C.GIDX["n"]] = n; g[k, C.GIDX["on"]] = on; g[k, C.GIDX["off"]] = off
            g[k, C.GIDX["cx"]] = cx; g[k, C.GIDX["cy"]] = cy
            g[k, C.GIDX["sx"]] = sx; g[k, C.GIDX["sy"]] = sy
            g[k, C.GIDX["pcx"]] = pcx; g[k, C.GIDX["pcy"]] = pcy
            g[k, C.GIDX["dx"]] = cx - pcx; g[k, C.GIDX["dy"]] = cy - pcy
            g[k, C.GIDX["speed"]] = float(np.hypot(cx - pcx, cy - pcy))
            g[k, C.GIDX["dsx"]] = sx - psx; g[k, C.GIDX["dsy"]] = sy - psy
            g[k, C.GIDX["bal"]] = (on - off) / n if n > 0 else 0.0
            g[k, C.GIDX["frames"]] = float(frames[k])
            g[k, C.GIDX["prev_n"]] = prev_n
            offx = int(round(pcx - 200.0)); offy = int(round(pcy - 120.0))
            a, b = int(event_lo[k]), int(event_hi[k])
            if b > a:
                xs = x[a:b] - offx; ys = y[a:b] - offy
                gxs = xs >> C.GRID_SHIFT; gys = ys >> C.GRID_SHIFT
                sok = (gxs >= 0) & (gxs < C.GRID_W) & (gys >= 0) & (gys < C.GRID_H)
                if sok.any():
                    cid2 = gys[sok] * C.GRID_W + gxs[sok]
                    ch2 = (1 - pol[a:b][sok]).astype(np.int64)
                    cnt2 = np.bincount(ch2 * C.N_CELLS + cid2, minlength=2 * C.N_CELLS).reshape(2, C.GRID_H, C.GRID_W)
                    Xq_shift[k, 0] = np.clip(cnt2[0], 0, C.SAT)
                    Xq_shift[k, 1] = np.clip(cnt2[1], 0, C.SAT)
            Xq_shift[k, 2] = prev_shift[0]
            Xq_shift[k, 3] = prev_shift[1]
            prev_now = now
            prev_shift = np.stack([Xq_shift[k, 0], Xq_shift[k, 1]]).astype(np.int8)
            prev_n = n; pcx, pcy, psx, psy = cx, cy, sx, sy
        del blk, sb
        if (k0 // CH_BLOCK) % 4 == 0:
            print("[conv] windows %d/%d %.1fs" % (k1, n_win, time.time() - t0), flush=True)

    znames = [z[2] for z in ZONES_215700]
    zone = np.full(n_win, len(ZONES_215700) - 1, dtype=np.int64)
    for i, (a, b, _n, _l, _g) in enumerate(ZONES_215700):
        zone[(centers >= a * 1000) & (centers < b * 1000)] = i
    # open 5s 块编号（每个开合段内从段起点算）
    open_chunk = np.full(n_win, -1, dtype=np.int32)
    open_zone_ids = [i for i, z in enumerate(ZONES_215700) if z[4] == "open"]
    for zi in open_zone_ids:
        a = ZONES_215700[zi][0] * 1000
        b = ZONES_215700[zi][1] * 1000
        m = (centers >= a) & (centers < b)
        open_chunk[m] = (zi * 1000 + ((centers[m] - a) // 5000)).astype(np.int32)

    np.savez_compressed(args.out, X_q=X_q, Xq_shift=Xq_shift, g=g,
                        t0_rel=t0s.astype(np.int32), center_rel=centers.astype(np.int32),
                        zone=zone.astype(np.int16), open_chunk=open_chunk, frames=frames,
                        zones_json=np.array(json.dumps(ZONES_215700, ensure_ascii=False)),
                        session=np.array(args.session), boards0=np.int64(board0),
                        grid_origin=np.int64(g0))
    print("[conv] saved %s  windows=%d  %.1fs" % (args.out, n_win, time.time() - t0))
    for i, z in enumerate(ZONES_215700):
        m = zone == i
        if m.any():
            print("[conv] %-11s win=%4d ev/win=%8.1f" % (z[2], int(m.sum()), float(g[m, C.GIDX["n"]].mean())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
