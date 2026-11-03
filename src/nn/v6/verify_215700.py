# -*- coding: utf-8 -*-
"""task-38：在独立 session（20261030-215700_v6clean）上对 c5/c4 的留出折模型做只推理验证。
两折模型均在 20261030-212214_v5probe 上训练（fold0/fold1 各一个），本 session 从不参与 fit。
输出 nn/out_v6/verify_215700.json + 终端紧凑表。
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

DATA7 = ROOT / "nn" / "v6" / "windows" / "real_w100.npz"
DATAV = ROOT / "nn" / "out_v6" / "verify_215700_windows.npz"
OUT = ROOT / "nn" / "out_v6" / "verify_215700.json"
MODELS = ROOT / "nn" / "out_v6" / "models" / "verify"
CAL_MAX = 1024
CANDIDATES = {
    "c5_shift_glob": ("c5", "Xs"),
    "c4_8ch_400ms": ("c4", "X4"),
}


def train_fold_models():
    d = np.load(DATA7, allow_pickle=False)
    X, Xs, feats, feat_names, X4, X4s = E.build_inputs(d)
    y = d["y"].astype(np.int64)
    zone = d["zone"].astype(np.int64)
    fold = E.fold_assignment(zone, y)
    arrays = {"Xs": Xs, "X4": X4}
    models = {}
    MODELS.mkdir(parents=True, exist_ok=True)
    for cand, (kind, akey) in CANDIDATES.items():
        models[cand] = {}
        for f in (0, 1):
            tr = fold == f
            has_glob = kind == "c5"
            t0 = time.time()
            ftr = feats[tr] if has_glob else None
            model, _dt = E.train_candidate(kind, arrays[akey][tr], ftr, y[tr], 1234 + f)
            tr_idx = np.where(tr)[0]
            step = max(1, len(tr_idx) // CAL_MAX)
            cal_idx = tr_idx[::step][:CAL_MAX]
            qp = IG.quantize_generic(model, arrays[akey][cal_idx],
                                     feats[cal_idx] if has_glob else None)
            p = MODELS / ("%s_trainfold%d_params.json" % (cand, f))
            p.write_text(json.dumps({"candidate": cand, "train_fold": f, "data": str(DATA7),
                                     "params": qp}, ensure_ascii=False), encoding="utf-8")
            models[cand][f] = qp
            print("[train] %-14s fold%d n=%d %.1fs -> %s" % (cand, f, int(tr.sum()), time.time() - t0, p.name))
    return models


def load_verify():
    dv = np.load(DATAV, allow_pickle=False)
    X, Xs, feats, feat_names, X4, X4s = E.build_inputs(dv)
    zones = json.loads(str(dv["zones_json"]))
    zone_names = [z[2] for z in zones]
    zone_ids = dv["zone"].astype(np.int64)
    center = dv["center_rel"].astype(np.int64)
    return {"X": X, "Xs": Xs, "X4": X4, "feats": feats, "zones": zones,
            "zone_names": zone_names, "zone": zone_ids, "center": center,
            "open_chunk": dv["open_chunk"].astype(np.int32),
            "n": len(zone_ids)}


def zone_profiles(dv):
    prof = {}
    for zi, z in enumerate(dv["zones"]):
        t0s, t1s, name, label, group = z
        m = dv["zone"] == zi
        n = int(m.sum())
        prof[name] = {
            "t0_ms": int(round(t0s * 1000)), "t1_ms": int(round(t1s * 1000)) if t1s < 1e8 else None,
            "label": int(label), "group": group, "n_windows": n,
            "minutes": round(n * C.WIN_MS / 60000.0, 4),
        }
    return prof


def metrics(pred, score, dv, margin_min, n_consec=C.ONLINE_N_CONSEC):
    dec = C.decision_indices(dv["n"])
    t0 = dv["center"][dec] - C.WIN_MS // 2
    hit = (pred[dec] == 1) & (score[dec] >= margin_min)
    pulses = C.replay_pulses(t0, hit, score[dec], pred[dec], n_consec=n_consec)
    prof = zone_profiles(dv)
    per = {}
    by_zone_pulses = {}
    for p in pulses:
        cms = int(p["center_ms"])
        zid = len(dv["zones"]) - 1
        for zi, z in enumerate(dv["zones"]):
            a = int(round(z[0] * 1000)); b = int(round(z[1] * 1000)) if z[1] < 1e8 else 1 << 60
            if a <= cms < b:
                zid = zi
                break
        by_zone_pulses[zid] = by_zone_pulses.get(zid, 0) + 1
    chunk_pulses = {}
    for p in pulses:
        cms = int(p["center_ms"])
        idx = int(np.searchsorted(dv["center"], cms))
        idx = min(max(idx, 0), dv["n"] - 1)
        k = int(dv["open_chunk"][idx])
        if k >= 0:
            chunk_pulses[k] = chunk_pulses.get(k, 0) + 1
    for zi, z in enumerate(dv["zones"]):
        name = z[2]
        m = dv["zone"] == zi
        n = int(m.sum())
        if n == 0:
            per[name] = {"n_windows": 0}
            continue
        sc = score[m]; pc = pred[m]
        n_p = int(by_zone_pulses.get(zi, 0))
        minutes = n * C.WIN_MS / 60000.0
        per[name] = {
            "n_windows": n, "minutes": round(minutes, 4),
            "pulses": n_p,
            "pulses_per_min": round(n_p / minutes, 4) if minutes > 0 else None,
            "class1_argmax_ratio": round(float((pc == 1).mean()), 4),
            "class1_hit_ratio": round(float(((pc == 1) & (sc >= margin_min)).mean()), 4),
            "mean_c1_score": round(float(sc.mean()), 3),
            "p90_c1_score": round(float(np.percentile(sc, 90)), 3),
        }
        if z[4] == "open":
            ch = dv["open_chunk"][m]
            chunks = sorted(set(int(x) for x in ch if x >= 0))
            det = sum(1 for k in chunks if chunk_pulses.get(k, 0) > 0)
            per[name]["open_chunks_total"] = len(chunks)
            per[name]["open_chunks_detected"] = det
            per[name]["open_chunk_recall"] = round(det / len(chunks), 4) if chunks else None
            per[name]["chunks_with_pulses"] = det
    return {"margin_min": int(margin_min), "n_decision_windows": int(len(dec)),
            "pulses_total": int(len(pulses)),
            "zones": per}


def main():
    t0 = time.time()
    print("[verify] 训练两折留出模型（7 min 段），本 session 不参与训练")
    models = train_fold_models()
    dv = load_verify()
    print("[verify] session windows=%d zones=%s" % (dv["n"], ",".join(dv["zone_names"])))
    out = {"session": "20261030-215700_v6clean", "data": str(DATAV),
           "trained_on": "nn/v6/windows/real_w100.npz (20261030-212214_v5probe)",
           "note": "只推理不训练；两折模型分别训练于 7 min 段 fold0/fold1，同一代码同一决策链",
           "windows": int(dv["n"]), "zone_profiles": zone_profiles(dv),
           "candidates": {}}
    ref = json.loads((ROOT / "nn" / "out_v6" / "representation_results.json").read_text(encoding="utf-8"))
    refmap = {r["candidate"]: r for r in ref["candidates"]}
    for cand, (kind, akey) in CANDIDATES.items():
        Xv = dv[akey]; fv = dv["feats"]
        out["candidates"][cand] = {"folds": {}, "summary": {}}
        for f in (0, 1):
            qp = models[cand][f]
            # 训练折模型只保留 int8 参数（部署口径）；float 参考取 7 min 段的留出结果，直接用 int8 权重跑量化前向（部署口径）；float 参考取 7 min 的留出结果
            lq = IG.forward_generic(Xv, fv, qp)
            pql = lq.astype(np.float64)
            pred_q = pql.argmax(axis=1).astype(np.int64)
            c1_q = (pql[:, 1] - np.maximum(pql[:, 0], pql[:, 2])).astype(np.float32)
            rec = {}
            for mm in (8, 16, 24):
                rec["m%d" % mm] = metrics(pred_q, c1_q, dv, mm)
            rec["pred_class1_window_count"] = int((pred_q == 1).sum())
            out["candidates"][cand]["folds"]["trainfold%d" % f] = rec
        # 汇总（两折平均的每段 pulse / 每分钟 / class1 比例）
        sm = {}
        for mm in (8, 16, 24):
            per_zone = {}
            for name in dv["zone_names"]:
                rows = [out["candidates"][cand]["folds"]["trainfold%d" % f]["m%d" % mm]["zones"].get(name, {})
                        for f in (0, 1)]
                rows = [r for r in rows if r.get("n_windows")]
                if not rows:
                    per_zone[name] = {"n_windows": 0}
                    continue
                per_zone[name] = {
                    "n_windows": rows[0]["n_windows"],
                    "minutes": rows[0]["minutes"],
                    "pulses_mean": round(float(np.mean([r["pulses"] for r in rows])), 2),
                    "pulses_per_min_mean": round(float(np.mean([r["pulses_per_min"] for r in rows])), 3),
                    "class1_argmax_ratio_mean": round(float(np.mean([r["class1_argmax_ratio"] for r in rows])), 4),
                    "class1_hit_ratio_mean": round(float(np.mean([r["class1_hit_ratio"] for r in rows])), 4),
                }
                if "open_chunk_recall" in rows[0]:
                    per_zone[name]["open_chunk_recall_mean"] = round(
                        float(np.mean([r["open_chunk_recall"] for r in rows])), 4)
            sm["m%d" % mm] = per_zone
        out["candidates"][cand]["summary"] = sm
        # 7 min 段参考
        r7 = refmap.get(cand)
        if r7:
            out["candidates"][cand]["reference_7min"] = {
                "configs": {k: {kk: v[kk] for kk in ("pulses_total", "static_fp", "static_fp_per_min",
                                                     "empty_fp", "openclose_chunks_detected",
                                                     "openclose_chunks_total", "openclose_chunk_recall",
                                                     "wave_pulses", "wave_pulses_per_min")}
                            for k, v in r7["configs"].items()},
                "int8": {kk: r7["int8"][kk] for kk in ("pulses_total", "static_fp", "static_fp_per_min",
                                                       "empty_fp", "openclose_chunks_detected",
                                                       "openclose_chunks_total", "openclose_chunk_recall",
                                                       "wave_pulses", "wave_pulses_per_min")},
            }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    # ---- 终端紧凑表 ----
    print("\n[int8] session=215700  (pulse 数 / 每分钟)")
    hdr = "%-8s %-3s %-4s" % ("cand", "fld", "m")
    print(hdr + " " + " ".join("%-12s" % n[:12] for n in dv["zone_names"]))
    for cand in CANDIDATES:
        for f in (0, 1):
            for mm in (8, 16, 24):
                row = out["candidates"][cand]["folds"]["trainfold%d" % f]["m%d" % mm]["zones"]
                cells = []
                for n in dv["zone_names"]:
                    z = row.get(n, {})
                    cells.append("%d/%.1f" % (z.get("pulses", 0), (z.get("pulses_per_min") or 0)))
                print("%-8s %-3d %-4d %s" % (cand[:8], f, mm, " ".join("%-12s" % c for c in cells)))
    print("\n[int8] 两折平均：开合召回 / 挥手窗 class1 比例（hit8） / 静态段 pulse")
    for cand in CANDIDATES:
        sm = out["candidates"][cand]["summary"]
        for mm in (8, 16, 24):
            z = sm["m%d" % mm]
            opr = [z[n]["open_chunk_recall_mean"] for n in dv["zone_names"]
                   if z.get(n, {}).get("open_chunk_recall_mean") is not None]
            wv = [z[n]["class1_hit_ratio_mean"] for n in ("wave_R", "wave_L") if z.get(n)]
            st = ["%s=%s" % (n, z[n]["pulses_mean"]) for n in ("static_A", "static_B", "motion_tail", "empty_A", "empty_B") if z.get(n)]
            print("%-14s m%-2d open_recall=%s wave_hit8=%s %s" % (
                cand, mm, ["%.3f" % x for x in opr], ["%.4f" % x for x in wv], " ".join(st)))
    print("\n[verify] wrote %s  %.1fs" % (OUT, time.time() - t0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
