"""Decode the board's per-frame event sets out of the gateway's /api/events.png.

Why this works (see packages/retina/src/bitmap.ts):
  EventBitmap.apply() writes intensity 1.0 for a fresh event and EventBitmap.step()
  multiplies every active cell by `decay` (0.55) each frame, then rewrites the RGBA.
  So a pixel written by *this* frame's event list is EXACTLY (255,77,99) for ON or
  (77,155,255) for OFF, while anything older is dimmed by 0.55^n -> never equal.
  => fresh pixels == exactly the event set of that frame.

  And apply() skips coordinates outside [0,w)x[0,h) (`if (r.x < 0 || r.x >= w ...)
  continue`), while `count` is raw `records.length`.  => **fresh_count < count is a
  hard, on-board proof that the board emitted coordinates outside the 400x240 grid**
  (which is exactly the H63 signature: y = 240..254).
"""
import glob
import json
import os
import re
import sys
import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "_exact")
mode = sys.argv[1] if len(sys.argv) > 1 else "board"

with open(os.path.join(src, "index_" + mode + ".json"), encoding="utf-8") as f:
    index = json.load(f)
counts = {int(k): int(v) for k, v in index["counts"].items()}

ON = np.array([255, 77, 99], dtype=np.uint8)
OFF = np.array([77, 155, 255], dtype=np.uint8)

out = {}
bad_range = []
mismatch = []
for path in sorted(glob.glob(os.path.join(src, "ev_*.png"))):
    m = re.search(r"ev_(\d+)\.png$", os.path.basename(path))
    if m is None:
        continue
    f = int(m.group(1))
    a = np.asarray(Image.open(path).convert("RGB"))
    h, w, _ = a.shape
    eq_on = np.all(a == ON, axis=2)
    eq_off = np.all(a == OFF, axis=2)
    n_on = int(eq_on.sum())
    n_off = int(eq_off.sum())
    c = counts.get(f, -1)
    evs = []
    for yy, xx in np.argwhere(eq_on):
        evs.append([int(xx), int(yy), 1])
    for yy, xx in np.argwhere(eq_off):
        evs.append([int(xx), int(yy), 0])
    out[str(f)] = {"count": c, "fresh": n_on + n_off, "on": n_on, "off": n_off, "ev": evs}
    if c >= 0 and (n_on + n_off) != c:
        mismatch.append((f, c, n_on + n_off))
    if n_on + n_off == c and c >= 0:
        pass

res = {
    "mode": mode,
    "png_size": [w, h],
    "frames": out,
}
with open(os.path.join(src, "exactsets_" + mode + ".json"), "w", encoding="utf-8") as fp:
    json.dump(res, fp)

print("mode =", mode, " decoded frames =", len(out), " png =", w, "x", h)
n_eq = sum(1 for v in out.values() if v["count"] >= 0 and v["fresh"] == v["count"])
n_lt = sum(1 for v in out.values() if v["count"] >= 0 and v["fresh"] < v["count"])
n_gt = sum(1 for v in out.values() if v["count"] >= 0 and v["fresh"] > v["count"])
# ASCII 汇总行（ModelSim/控制台编码把中文打成 ? 时，这一行仍可读）
print("ONBOARD_RANGE_CHECK fresh_eq_count=%d/%d  fresh_lt_count=%d  fresh_gt_count=%d"
      % (n_eq, len(out), n_lt, n_gt))
print("fresh == count 的帧： %d / %d" % (n_eq, len(out)))
print("fresh <  count 的帧： %d   <-- 非 0 就说明有坐标落在 400x240 网格之外（H63 指纹）" % n_lt)
print("fresh >  count 的帧： %d   <-- 只可能是解码异常" % n_gt)
if mismatch:
    print("不等的帧（前 12 个） frameIdx, count, fresh:")
    for row in mismatch[:12]:
        print("   ", row)
tot_f = sum(v["fresh"] for v in out.values())
tot_c = sum(v["count"] for v in out.values() if v["count"] >= 0)
print("合计 fresh = %d, 合计 count = %d" % (tot_f, tot_c))
