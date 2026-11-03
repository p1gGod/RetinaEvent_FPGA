# -*- coding: utf-8 -*-
"""task-38 敏感性分析：标签边界与原始事件率对不上（wave_R 实际到 ~106s、static_B 只有 107-120s 真静止），
用“干净子区间”重算 pulse 指标，并输出全部 pulse 明细（时间/类别/分数）。
只推理，不训练；复用 verify_215700.py 落盘的两折 int8 参数。
"""
from __future__ import annotations
import json, sys, time
from pathlib import Path
import numpy as np

ROOT = Path("E:/workspace/FPGA_Comp")
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C
import exp_representations as E
import int8_generic as IG

DATAV = ROOT / "nn" / "out_v6" / "verify_215700_windows.npz"
MODELS = ROOT / "nn" / "out_v6" / "models" / "verify"
OUT = ROOT / "nn" / "out_v6" / "verify_215700_clean.json"
CANDIDATES = {"c5_shift_glob": ("c5", "Xs"), "c4_8ch_400ms": ("c4", "X4")}
# 干净子区间（由逐秒事件计数裁定：50-52 仍是开合、100-106 仍在挥手、107 起才真静止）
CLEAN = [("empty_A", 2000, 20000), ("openclose_R", 20000, 52000),
         ("static_A", 53000, 70000), ("wave_R", 70000, 106000),
         ("static_B", 107000, 120000), ("openclose_L", 120000, 145000),
         ("wave_L", 145000, 170000), ("motion_tail", 170000, 183000),
         ("empty_B", 183000, 194000)]


def zone_of(ms):
    for n, a, b in CLEAN:
        if a <= ms < b:
            return n
    return "excluded"


def main():
    t_start = time.time()
    dv = np.load(DATAV, allow_pickle=False)
    X, Xs, feats, feat_names, X4, X4s = E.build_inputs(dv)
    center = dv["center_rel"].astype(np.int64)
    n = len(center)
    out = {"session": "20261030-215700_v6clean", "note": "干净子区间敏感性分析；pulse 明细",
           "clean_ranges_ms": CLEAN, "windows": int(n), "candidates": {}}
    hdr = "%-14s %-4s %-3s %s" % ("cand", "fld", "m", " ".join("%-11s" % c[0] for c in CLEAN[2:]))
    print(hdr)
    for cand, (kind, akey) in CANDIDATES.items():
        out["candidates"][cand] = {}
        Xv = {"Xs": Xs, "X4": X4}[akey]; fv = feats if kind == "c5" else None
        for f in (0, 1):
            qp = json.loads((MODELS / ("%s_trainfold%d_params.json" % (cand, f))).read_text(encoding="utf-8"))["params"]
            lq = IG.forward_generic(Xv, fv, qp).astype(np.float64)
            pred = lq.argmax(axis=1).astype(np.int64)
            c1 = (lq[:, 1] - np.maximum(lq[:, 0], lq[:, 2])).astype(np.float32)
            dec = C.decision_indices(n)
            t0 = center[dec] - C.WIN_MS // 2
            rec = {}
            for mm in (8, 16, 24):
                hit = (pred[dec] == 1) & (c1[dec] >= mm)
                pulses = C.replay_pulses(t0, hit, c1[dec], pred[dec])
                plist = [{"t_ms": int(p["center_ms"]), "zone": zone_of(int(p["center_ms"])),
                          "class": int(p["class_pred"]), "score": round(float(p["margin"]), 2)} for p in pulses]
                zones = {}
                for name, a, b in CLEAN:
                    wm = (center >= a) & (center < b)
                    nz = int(wm.sum())
                    minutes = nz * C.WIN_MS / 60000.0
                    zp = [p for p in plist if p["zone"] == name]
                    zones[name] = {
                        "n_windows": nz, "minutes": round(minutes, 4),
                        "pulses": len(zp),
                        "pulses_per_min": round(len(zp) / minutes, 3) if minutes > 0 else None,
                        "class1_argmax_ratio": round(float((pred[wm] == 1).mean()), 4) if nz else None,
                        "class1_hit_ratio": round(float(((pred[wm] == 1) & (c1[wm] >= mm)).mean()), 4) if nz else None,
                        "mean_c1_score": round(float(c1[wm].mean()), 3) if nz else None,
                    }
                rec["m%d" % mm] = {"zones": zones, "pulses": plist,
                                   "wave_pulses": len([p for p in plist if p["zone"] in ("wave_R", "wave_L")]),
                                   "wave_pulses_per_min": round(len([p for p in plist if p["zone"] in ("wave_R", "wave_L")]) /
                                                                ((34 / 60.0) + (25 / 60.0)), 3),
                                   "static_pulses": len([p for p in plist if p["zone"] in ("static_A", "static_B")]),
                                   "motion_tail_pulses": len([p for p in plist if p["zone"] == "motion_tail"])}
                row = " ".join("%d/%.1f" % (zones[c[0]]["pulses"], zones[c[0]]["pulses_per_min"] or 0) for c in CLEAN[2:])
                print("%-14s %-4d %-3d %s" % (cand, f, mm, row))
            out["candidates"][cand]["trainfold%d" % f] = rec
        # 两折平均
        sm = {}
        for mm in (8, 16, 24):
            zavg = {}
            for name, _a, _b in CLEAN:
                rows = [out["candidates"][cand]["trainfold%d" % f]["m%d" % mm]["zones"][name] for f in (0, 1)]
                zavg[name] = {k: round(float(np.mean([r[k] for r in rows])), 3)
                              for k in ("pulses", "pulses_per_min", "class1_hit_ratio")}
            sm["m%d" % mm] = zavg
        out["candidates"][cand]["summary_mean"] = sm
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n[clean] 两折平均 pulse：")
    for cand in CANDIDATES:
        for mm in (8, 16, 24):
            sm = out["candidates"][cand]["summary_mean"]["m%d" % mm]
            print("%-14s m%-2d staticA=%.1f staticB=%.1f (%s/min) wave=%.1f (%s/min) tail=%.1f empty=%.1f+%.1f" % (
                cand, mm, sm["static_A"]["pulses"], sm["static_B"]["pulses"],
                round((sm["static_A"]["pulses"] + sm["static_B"]["pulses"]) / 0.5, 3),
                sm["wave_R"]["pulses"] + sm["wave_L"]["pulses"],
                round((sm["wave_R"]["pulses"] + sm["wave_L"]["pulses"]) / ((34 + 25) / 60.0), 3),
                sm["motion_tail"]["pulses"], sm["empty_A"]["pulses"], sm["empty_B"]["pulses"]))
    print("\n[clean] wrote %s %.1fs" % (OUT, time.time() - t_start))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
