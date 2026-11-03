"""Analyse the on-board /api/events.png captures (board vs host event field).

The bitmap is the gateway's 400x240 event grid rendered as RGBA
(ON = red, OFF = blue, with afterglow fading to darker shades).
"""
import glob
import os
import sys
import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "_onboard")

for mode in ("board", "host"):
    files = sorted(glob.glob(os.path.join(src, mode + "_*.png")))
    print("=" * 78)
    print(mode, " :", len(files), "captures")
    tiles = []
    for f in files:
        im = Image.open(f).convert("RGB")
        a = np.asarray(im).astype(int)
        h, w, _ = a.shape
        r, g, b = a[..., 0], a[..., 1], a[..., 2]
        # fresh ON = strong red, fresh OFF = strong blue (afterglow is dimmer)
        on = (r > 150) & (r - b > 60) & (r - g > 60)
        off = (b > 150) & (b - r > 60) & (b - g > 40)
        any_ev = (r > 12) | (b > 12)
        ys, xs = np.nonzero(any_ev)
        # "fresh" pixel count should be <= count (duplicates collapse); any pixel
        # written out of range would be dropped by the typed array => a deficit.
        print("  %-22s %dx%d  freshON=%5d freshOFF=%5d sum=%5d  bbox x %3d..%3d y %3d..%3d"
              % (os.path.basename(f), w, h, int(on.sum()), int(off.sum()),
                 int(on.sum() + off.sum()),
                 xs.min() if xs.size else -1, xs.max() if xs.size else -1,
                 ys.min() if ys.size else -1, ys.max() if ys.size else -1))
        tiles.append(a)
    # horizontal strip for eyeballing
    if tiles:
        strip = np.concatenate(tiles, axis=1).astype(np.uint8)
        out = os.path.join(src, "strip_" + mode + ".png")
        Image.fromarray(strip).save(out)
        print("  strip ->", out)
