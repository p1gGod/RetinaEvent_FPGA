#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校验 nn/v7/windows_v7.npz：分区一致性、view/aug 策略、镜像等价、排除段无窗、计数。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("RETE_ROOT") or Path(__file__).resolve().parents[2])
NPZ = ROOT / "nn" / "v7" / "windows_v7.npz"
SUM = ROOT / "nn" / "out_v7" / "build_summary_v2.json"
ZONES_JSON = ROOT / "temp_test" / "v7_zones.json"
GLOBAL_NAMES = ["n", "on", "off", "cx", "cy", "sx", "sy", "pcx", "pcy", "dx", "dy",
                "speed", "dsx", "dsy", "bal", "frames", "prev_n"]
G = {n: i for i, n in enumerate(GLOBAL_NAMES)}
fails = []


def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg, flush=True)
    if not cond:
        fails.append(msg)


d = np.load(NPZ, allow_pickle=False)
s = json.loads(SUM.read_text(encoding="utf-8"))
zj = json.loads(ZONES_JSON.read_text(encoding="utf-8"))

X = d["X"]; Xr = d["X_raw"]; g = d["g"]; y = d["y"]
zone = d["zone"]; view = d["view"]; sess = d["session"]
tms = d["t_ms"]; fold = d["fold"]; aug = d["aug"]
hand = d["hand"]; role = d["role"]; hint = d["hint"]; wi = d["win_idx"]
N = len(y)
print("N=%d" % N)
ok(X.shape == (N, 4, 30, 50) and X.dtype == np.int8, "X shape/dtype %s %s" % (X.shape, X.dtype))
ok(Xr.shape == X.shape and g.shape == (N, 17) and g.dtype == np.float32, "X_raw/g shape")
ok(list(d["global_names"]) == GLOBAL_NAMES, "GLOBAL_NAMES order unchanged")
ok(int(d["grid_w"]) == 50 and int(d["grid_h"]) == 30 and int(d["grid_shift"]) == 3, "grid consts")
ok(int(d["win_ms"]) == 100 and int(d["stride_ms"]) == 50, "window consts")

# 分区清单与权威 json 一致
zs = zj["zones"]
sum_zones = s["zones"]
ok(len(sum_zones) == len(zs), "zone count %d == json %d" % (len(sum_zones), len(zs)))
for a, b in zip(sum_zones, zs):
    same = (a["name"] == b["name"] and a["t0_ms"] == int(round(b["t0"] * 1000))
            and a["t1_ms"] == int(round(b["t1"] * 1000)) and a["label"] == b["label"]
            and a["view"] == b["view"])
    if not same:
        ok(False, "zone mismatch %r vs %r" % (a, b))
print("PASS zone list matches v7_zones.json")
print("PASS zone windows: " + ", ".join("%s=%d" % (z["name"], z["windows_kept"])
                                        for z in sum_zones))

ex_names = [z["name"] for z in zs if z["label"] == "exclude"]
ex0 = [int(round(z["t0"] * 1000)) for z in zs if z["label"] == "exclude"]
ex1 = [int(round(z["t1"] * 1000)) for z in zs if z["label"] == "exclude"]
v7sess = np.array([str(x) == "20261030-222201_v7hands" for x in sess])
bad_ex = 0
for a, b in zip(ex0, ex1):
    # v7 session 内：窗区间与排除段相交都不允许（中心判定 + 相交丢弃双保险）
    bad_ex += int((((tms < b) & (tms + 100 > a)) & v7sess).sum())
ok(bad_ex == 0, "no window intersects exclude zones (count=%d)" % bad_ex)
ok(not any(str(n) in set(ex_names) for n in np.unique(zone)), "no exclude zone names in npz")

# 标签 / view / role 策略
ok(all(int(v) in (0, 1, 2) for v in np.unique(y)), "y only 0/1/2: %s" % np.unique(y).tolist())
ok(set(np.unique(view).tolist()) <= {"A", "B", "A7"}, "view values %s" % np.unique(view).tolist())
b = view == "B"
ok(int((aug[b] != 0).sum()) == 0, "view B never mirrored (aug=0)")
a7 = view == "A7"
ok(int((aug[a7] != 0).sum()) == 0 and int(((role == "control_7min") == a7).sum()) == N,
   "A7 == control_7min and never mirrored")
m = aug == 1
ok(bool(np.all(view[m] == "A")), "aug=1 only view A")
# 镜像行与原行一一对应：按出现顺序配对
origA = np.nonzero((view == "A") & (aug == 0))[0]
mir = np.nonzero(m)[0]
ok(len(origA) == len(mir), "mirror count %d == viewA originals %d" % (len(mir), len(origA)))
ok(bool(np.all(y[origA] == y[mir])), "mirror y equal")
ok(bool(np.all(fold[origA] == fold[mir])), "mirror fold equal")
ok(bool(np.all(tms[origA] == tms[mir])), "mirror t_ms equal")
ok(bool(np.all(zone[origA] == zone[mir])), "mirror zone equal")
ok(bool(np.all(hand[origA][y[origA] >= 1] == "left")), "original left-hand at gesture rows")
ok(bool(np.all(hand[mir][y[mir] >= 1] == "right")), "mirror right-hand at gesture rows")
ok(bool(np.all(hint[origA] == hint[mir])), "mirror hint equal")
ok(bool(np.all(X[mir] == X[origA][:, :, :, ::-1])), "X mirror == flip(x)")
ok(bool(np.all(Xr[mir] == Xr[origA][:, :, :, ::-1])), "X_raw mirror == flip(x)")

gm = g[mir].copy(); go = g[origA]
ok(bool(np.allclose(gm[:, G["cx"]], 399.0 - go[:, G["cx"]], atol=1e-4)), "mirror cx = 399-cx")
ok(bool(np.allclose(gm[:, G["pcx"]], 399.0 - go[:, G["pcx"]], atol=1e-4)), "mirror pcx = 399-pcx")
ok(bool(np.allclose(gm[:, G["dx"]], -go[:, G["dx"]], atol=1e-4)), "mirror dx = -dx")
ok(bool(np.allclose(gm[:, G["dsx"]], go[:, G["dsx"]], atol=1e-4)), "mirror dsx unchanged (sigma is scalar)")
for k in ("cy", "pcy", "dy", "sy", "sx", "n", "on", "off", "bal", "frames", "prev_n", "speed", "dsy"):
    ok(bool(np.allclose(gm[:, G[k]], go[:, G[k]], atol=1e-4)), "mirror %s unchanged" % k)

# 计数一致性
yv = {int(v): int((y == v).sum()) for v in np.unique(y)}
ok(yv == {int(k): int(v) for k, v in s["y_counts"].items()}, "y counts match summary %s" % yv)
vc = {str(v): int((view == v).sum()) for v in np.unique(view)}
ok(vc == {str(k): int(v) for k, v in s["view_counts"].items()}, "view counts match %s" % vc)
rc = {str(v): int((role == v).sum()) for v in np.unique(role)}
ok(rc == {str(k): int(v) for k, v in s["role_counts"].items()}, "role counts match %s" % rc)
n_v7 = int(((role != "control_7min") & (aug == 0)).sum())
ok(n_v7 == s["n_windows_v7_kept"], "v7 kept rows %d == summary" % n_v7)
ok(int(m.sum()) == s["n_mirror"], "mirror rows %d" % int(m.sum()))
ok(N == s["n_rows"], "N rows == summary")


# ---- v7.1 整数路径附加断言 ----
ok(s.get("data_version") == "v7.1-int-rtl-eq", "data_version == v7.1-int-rtl-eq")
sc = s.get("self_check", {})
ok(sc.get("kind") == "rtl_equivalence_200_windows" and sc.get("sample_n", 0) >= 200
   and sc.get("all_ok") is True and sc.get("fails") == 0,
   "RTL equivalence self-check %d windows all_ok" % sc.get("sample_n", -1))
gfrac = np.abs(g - np.round(g))
gnames = [str(x) for x in d["global_names"]]
bad_cols = [gnames[i] for i in range(len(gnames))
            if gnames[i] != "bal" and int((gfrac[:, i] > 1e-6).sum()) > 0]
ok(not bad_cols, "16/17 globals integer-valued (non-int except bal: %s)" % bad_cols)
ok(bool(np.allclose(g[:, G["bal"]],
                    np.where(g[:, G["n"]] > 0, (g[:, G["on"]] - g[:, G["off"]]) / np.maximum(g[:, G["n"]], 1), 0),
                    atol=1e-6)), "bal == (on-off)/n")
gi = np.ascontiguousarray(g).astype(np.int64)
ok(bool(np.all(gi[:, G["on"]] + gi[:, G["off"]] == gi[:, G["n"]])),
   "on + off == n for all rows")
sel = gi[:, G["n"]] > 0
ok(bool(np.all(gi[sel, G["dx"]] == gi[sel, G["cx"]] - gi[sel, G["pcx"]])),
   "dx == cx - pcx when n>0")
for label, mask in (("v7_primary", (role == "v7_primary") & (aug == 0)),
                    ("control_7min", role == "control_7min")):
    idxs = np.nonzero(mask)[0]
    kk = wi[idxs]
    steps = np.diff(kk)
    ok(bool(np.all(steps > 0)), "%s win_idx ascending (%d rows)" % (label, len(idxs)))
    adj = np.nonzero(steps == 1)[0]
    cur = idxs[adj + 1]
    prv = idxs[adj]
    bad = int(np.sum(gi[cur, G["pcx"]] != gi[prv, G["cx"]]))
    ok(bad == 0, "%s pcx[k] == cx[k-1] (%d adjacent pairs, bad=%d)" % (label, len(adj), bad))
    bad2 = int(np.sum(X[cur, 2] != X[prv, 0])) + int(np.sum(X[cur, 3] != X[prv, 1]))
    ok(bad2 == 0, "%s shifted prev channels == prev now (bad=%d)" % (label, bad2))

# 7min 对照标签
c7 = role == "control_7min"
ok(int((y[c7] == 0).sum()) == 2359 and int((y[c7] == 1).sum()) == 2360
   and int((y[c7] == 2).sum()) == 1860, "control 7min y counts 2359/2360/1860")

# 哈希
import hashlib
HASH_KEYS = ["X_raw", "X", "g", "y", "zone", "view", "session", "t_ms", "center_ms",
             "fold", "aug", "hand", "role", "hint", "win_idx"]
h = hashlib.sha256()
for k in HASH_KEYS:
    arr = np.ascontiguousarray(d[k])
    h.update(k.encode()); h.update(str(arr.dtype).encode()); h.update(str(arr.shape).encode())
    h.update(arr.tobytes())
ok(h.hexdigest() == s["content_hash"], "content hash == summary (%s)" % h.hexdigest()[:16])
print("V7_CHECK_OK=%d FAILS=%d" % (0 if fails else 1, len(fails)))
sys.exit(0 if not fails else 1)
