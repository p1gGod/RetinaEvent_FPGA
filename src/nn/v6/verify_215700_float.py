# -*- coding: utf-8 -*-
"""task-38 附加：在独立 session 上比较 float 折模型与 int8 参数量化前向的窗级一致性。
只做推理；两个折模型仍在 7min 段训练。"""
from __future__ import annotations
import json, sys, time
from pathlib import Path
import numpy as np

ROOT = Path("E:/workspace/FPGA_Comp")
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C
import exp_representations as E
import int8_generic as IG

DATA7 = ROOT / "nn" / "v6" / "windows" / "real_w100.npz"
DATAV = ROOT / "nn" / "out_v6" / "verify_215700_windows.npz"
MODELS = ROOT / "nn" / "out_v6" / "models" / "verify"
OUT = ROOT / "nn" / "out_v6" / "verify_215700_float_vs_int8.json"
CAL_MAX = 1024
CANDIDATES = {"c5_shift_glob": ("c5", "Xs"), "c4_8ch_400ms": ("c4", "X4")}
CLEAN = [("empty_A", 2000, 20000), ("openclose_R", 20000, 52000),
         ("static_A", 53000, 70000), ("wave_R", 70000, 106000),
         ("static_B", 107000, 120000), ("openclose_L", 120000, 145000),
         ("wave_L", 145000, 170000), ("motion_tail", 170000, 183000),
         ("empty_B", 183000, 194000)]


def main():
    t0 = time.time()
    d = np.load(DATA7, allow_pickle=False)
    X7, Xs7, f7, _n7, X47, X4s7 = E.build_inputs(d)
    y = d["y"].astype(np.int64); zone = d["zone"].astype(np.int64)
    fold = E.fold_assignment(zone, y)
    dv = np.load(DATAV, allow_pickle=False)
    Xv, Xsv, fv, _fn, X4v, X4sv = E.build_inputs(dv)
    center = dv["center_rel"].astype(np.int64)
    dec = C.decision_indices(len(center))
    arr7 = {"Xs": Xs7, "X4": X47}; arrv = {"Xs": Xsv, "X4": X4v}
    out = {"session": "20261030-215700_v6clean", "note": "float 折模型 vs int8 参数量化前向；只推理",
           "candidates": {}}
    print("%-14s %-4s %-6s %-6s %-6s %s" % ("cand", "fld", "agree", "decAgr8", "waveL_f/i", "per_clean_zone_agree"))
    for cand, (kind, akey) in CANDIDATES.items():
        out["candidates"][cand] = {}
        g = kind == "c5"
        for f in (0, 1):
            tr = fold == f
            model, _dt = E.train_candidate(kind, arr7[akey][tr], f7[tr] if g else None, y[tr], 1234 + f)
            qp = json.loads((MODELS / ("%s_trainfold%d_params.json" % (cand, f))).read_text(encoding="utf-8"))["params"]
            pf, mf, c1f, lf = E.predict_all(model, arrv[akey], fv if g else None)
            lq = IG.forward_generic(arrv[akey], fv if g else None, qp).astype(np.float64)
            pq = lq.argmax(axis=1).astype(np.int64)
            c1q = (lq[:, 1] - np.maximum(lq[:, 0], lq[:, 2])).astype(np.float32)
            rec = {"agree_all_windows": round(float((pf == pq).mean()), 5),
                   "decision_hit_agreement": {}, "clean_zone": {}, "float_clean": {}, "int8_clean": {}}
            t0d = center[dec] - C.WIN_MS // 2

            def clean_pulses(pred, c1s, mm):
                hp = (pred[dec] == 1) & (c1s[dec] >= mm)
                ps = C.replay_pulses(t0d, hp, c1s[dec], pred[dec])
                cnt = {}
                for p in ps:
                    ms = int(p["center_ms"])
                    zn = "excluded"
                    for name, a, b in CLEAN:
                        if a <= ms < b:
                            zn = name
                            break
                    cnt[zn] = cnt.get(zn, 0) + 1
                return cnt

            for mm in (8, 16, 24):
                hf = (pf[dec] == 1) & (c1f[dec] >= mm)
                hq = (pq[dec] == 1) & (c1q[dec] >= mm)
                rec["decision_hit_agreement"]["m%d" % mm] = round(float((hf == hq).mean()), 5)
                rec["float_clean"]["m%d" % mm] = clean_pulses(pf, c1f, mm)
                rec["int8_clean"]["m%d" % mm] = clean_pulses(pq, c1q, mm)
            for name, a, b in CLEAN:
                wm = (center >= a) & (center < b)
                if not wm.any():
                    continue
                rec["clean_zone"][name] = {
                    "n": int(wm.sum()),
                    "agree": round(float((pf[wm] == pq[wm]).mean()), 4),
                    "float_arg1": round(float((pf[wm] == 1).mean()), 4),
                    "int8_arg1": round(float((pq[wm] == 1).mean()), 4),
                }
            out["candidates"][cand]["trainfold%d" % f] = rec
            wl = rec["clean_zone"].get("wave_L", {})
            fc = rec["float_clean"]["m8"]; ic = rec["int8_clean"]["m8"]
            print("%-14s %-4d %-6.4f %-6.4f %-6s F:waveR=%d waveL=%d static=%d | I:waveR=%d waveL=%d static=%d" % (
                cand, f, rec["agree_all_windows"], rec["decision_hit_agreement"]["m8"],
                "%s/%s" % (wl.get("float_arg1"), wl.get("int8_arg1")),
                fc.get("wave_R", 0), fc.get("wave_L", 0), fc.get("static_A", 0) + fc.get("static_B", 0),
                ic.get("wave_R", 0), ic.get("wave_L", 0), ic.get("static_A", 0) + ic.get("static_B", 0)))
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("[float-vs-int8] wrote %s %.1fs" % (OUT, time.time() - t0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
