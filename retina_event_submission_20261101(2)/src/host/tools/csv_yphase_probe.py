"""Decisive structural test on the exported event CSVs.

Hypothesis: the board's spatial_lap row counter is never reset by vsync, so it
free-runs and wraps mod 256.  Signature:
  * every frame covers exactly 240 consecutive y values out of 0..255
  * exactly one contiguous gap of ~16 missing y values
  * the gap position advances by -16 (i.e. +240 mod 256) every frame
"""
import sys
import numpy as np
import pandas as pd

for path in sys.argv[1:]:
    df = pd.read_csv(path)
    print("=" * 78)
    print(path)
    uniq = np.unique(df["frame_idx"].to_numpy())
    print("frame  n     ymin ymax  yvals  missing-in-0..254                     "
          " xmin xmax  n(y>239)")
    prev_gap_start = None
    for f in uniq:
        sub = df[df.frame_idx == f]
        y = sub.y.to_numpy()
        ys = np.unique(y)
        present = set(ys.tolist())
        missing = [v for v in range(255) if v not in present]
        # compress the missing list into ranges
        rngs = []
        for v in missing:
            if rngs and v == rngs[-1][1] + 1:
                rngs[-1][1] = v
            else:
                rngs.append([v, v])
        txt = ",".join("%d-%d" % (a, b) if a != b else str(a) for a, b in rngs)
        print("%6d %5d %4d %4d %5d  %-42s %4d %4d  %6d"
              % (f, len(sub), y.min(), y.max(), len(ys), txt[:42],
                 sub.x.min(), sub.x.max(), int((y > 239).sum())))
    # x side too: does x ever reach 399?
    x = df.x.to_numpy()
    print("x==399 rows: %d   x histogram tail (392..399): %s"
          % (int((x == 399).sum()),
             np.bincount(x, minlength=400)[392:400].tolist()))
