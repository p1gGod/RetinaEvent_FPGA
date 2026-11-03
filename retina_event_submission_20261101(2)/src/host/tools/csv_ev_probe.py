"""Ad-hoc probe #2 of the GUI-exported event CSVs.

Key questions:
  1. Are coordinates inside the 400x240 event grid at all?  (y up to 254 was seen)
  2. What does one frame actually look like -> write a PNG so we can *see* it.
  3. Is there a per-frame drift of the event field (the user reports the pattern
     sliding right-to-left)?
"""
import os
import sys
import numpy as np
import pandas as pd
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_csv_probe_out")
os.makedirs(OUT, exist_ok=True)

EV_W, EV_H = 400, 240

for path in sys.argv[1:]:
    tag = os.path.splitext(os.path.basename(path))[0][-6:]
    df = pd.read_csv(path)
    print("=" * 78)
    print(os.path.basename(path), " rows:", len(df))
    fr = df["frame_idx"].to_numpy()
    uniq = np.unique(fr)
    cnt = df.groupby("frame_idx").size()
    print("frames: %d  idx %d..%d  events/frame mean %.1f min %d max %d"
          % (len(uniq), fr.min(), fr.max(), cnt.mean(), cnt.min(), cnt.max()))
    print("frame_idx step histogram:",
          pd.Series(np.diff(uniq)).value_counts().head(8).to_dict())
    print("pol:", df["pol"].value_counts().to_dict(),
          " flags:", df["flags"].value_counts().to_dict())
    print("x range %d..%d   y range %d..%d" % (df.x.min(), df.x.max(), df.y.min(), df.y.max()))
    print("count x>399: %d    count y>239: %d    (%.2f%% of rows)"
          % ((df.x > EV_W - 1).sum(), (df.y > EV_H - 1).sum(),
             100.0 * (df.y > EV_H - 1).sum() / len(df)))
    yh = np.bincount(df.y.to_numpy(), minlength=256)
    print("y histogram 0..15 :", yh[0:16].tolist())
    print("y histogram 224..255:", yh[224:256].tolist())

    # --- one PNG per selected frame, ON=red OFF=blue on the 400x240 grid ---
    sel = list(uniq[:4]) + list(uniq[-2:])
    sel = sorted(set(sel))
    tiles = []
    for f in sel:
        sub = df[df.frame_idx == f]
        img = np.zeros((EV_H, EV_W, 3), dtype=np.uint8)
        # fold out-of-grid coordinates back with modulo so we can see them
        yy = (sub.y.to_numpy() % EV_H)
        xx = (sub.x.to_numpy() % EV_W)
        on = sub.pol.to_numpy() == 1
        img[yy[on], xx[on]] = (255, 60, 60)
        img[yy[~on], xx[~on]] = (60, 120, 255)
        tiles.append((f, img))
    strip = np.concatenate([t[1] for t in tiles], axis=1)
    p = os.path.join(OUT, "frames_%s.png" % tag)
    Image.fromarray(strip).resize((strip.shape[1], strip.shape[0]), Image.NEAREST).save(p)
    print("wrote", p, " frames:", [t[0] for t in tiles])

    # --- global occupancy image over all frames ---
    img = np.zeros((EV_H, EV_W, 3), dtype=np.uint8)
    yy = df.y.to_numpy() % EV_H
    xx = df.x.to_numpy() % EV_W
    H = np.zeros((EV_H, EV_W), dtype=np.int64)
    np.add.at(H, (yy, xx), 1)
    print("occupancy: nonzero %d/%d  mean %.2f  max %d"
          % ((H > 0).sum(), EV_W * EV_H, H.mean(), H.max()))
    colsum = H.sum(axis=0)
    rowsum = H.sum(axis=1)
    print("col-sum mean per 25-col block:",
          [int(colsum[i:i + 25].mean()) for i in range(0, EV_W, 25)])
    print("row-sum mean per 20-row block:",
          [int(rowsum[i:i + 20].mean()) for i in range(0, EV_H, 20)])
    print("col-sum: nonzero cols %d/400   row-sum: nonzero rows %d/240"
          % ((colsum > 0).sum(), (rowsum > 0).sum()))
    nm = H.astype(float) / max(1, H.max())
    rgb = np.zeros((EV_H, EV_W, 3), dtype=np.uint8)
    rgb[..., 0] = (nm * 255).astype(np.uint8)
    rgb[..., 1] = (nm * 255).astype(np.uint8)
    rgb[..., 2] = (nm * 255).astype(np.uint8)
    p = os.path.join(OUT, "occupancy_%s.png" % tag)
    Image.fromarray(rgb).save(p)
    print("wrote", p)

    # --- frame-to-frame drift: best 2D integer shift of the occupancy grid ---
    grids = []
    for f in uniq[:6]:
        sub = df[df.frame_idx == f]
        g = np.zeros((EV_H, EV_W), dtype=float)
        np.add.at(g, (sub.y.to_numpy() % EV_H, sub.x.to_numpy() % EV_W), 1.0)
        grids.append(g)
    print("frame-to-frame best 2D shift (dx in -6..6, dy in -6..6):")
    for i in range(1, len(grids)):
        a = grids[i - 1] - grids[i - 1].mean()
        best, bs = None, -1e18
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                b = np.roll(np.roll(grids[i], dy, axis=0), dx, axis=1)
                b = b - b.mean()
                sc = float((a * b).sum())
                if sc > bs:
                    bs, best = sc, (dx, dy)
        print("   %d -> %d : dx=%+d dy=%+d" % (uniq[i - 1], uniq[i], best[0], best[1]))
