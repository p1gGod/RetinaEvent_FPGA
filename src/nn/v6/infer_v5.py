#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v5（2 分类 int8）在真实长录逐窗推理：捷径量化证据（task-36 第 2 步）。

禁 torch：只 import nn/ref_cnn.py 的 int8 参考前向。
同时跑两种输入：原始 4 通道网格（X_q）与上一窗质心平移归一化网格（Xq_shift），
后者是「不重训、只加一个减法器能否消掉挥手」的快速检验。
输出 nn/out_v6/v5_probe.json；stdout 只打紧凑表。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path("E:/workspace/FPGA_Comp")
sys.path.insert(0, str(ROOT / "nn"))
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import ref_cnn  # noqa: E402
import v6_common as C  # noqa: E402

DEFAULT_DATA = ROOT / "nn" / "v6" / "windows" / "real_w100.npz"
DEFAULT_PARAMS = ROOT / "nn" / "out_v5" / "nn_params_2cls.json"
DEFAULT_OUT = ROOT / "nn" / "out_v6" / "v5_probe.json"


def load_layers(path: Path):
    doc = json.loads(path.read_text(encoding="utf-8"))
    layers = []
    for L in doc["cnn_params"]["layers"]:
        layers.append({
            "name": str(L["name"]),
            "w": np.asarray(L["weight_int8"], dtype=np.int64).reshape(tuple(L["weight_shape"])),
            "b": np.asarray(L["bias_int32"], dtype=np.int64),
            "sh": np.asarray(L["SH"], dtype=np.int64),
        })
    return doc, layers


def forward_int8(X: np.ndarray, layers, batch: int = 512) -> np.ndarray:
    logits = []
    for i in range(0, len(X), batch):
        lg, _ = ref_cnn.forward_ref(np.ascontiguousarray(X[i:i + batch]), layers)
        logits.append(lg.astype(np.int64))
    return np.concatenate(logits, axis=0)


def probe(X, tag, zone, center, layers):
    t0 = time.time()
    lg = forward_int8(X, layers)
    pred = lg.argmax(axis=1).astype(np.int64)
    margin = np.abs(lg[:, 0] - lg[:, 1]).astype(np.int64)
    hit = (pred == 1) & (margin >= C.ONLINE_MARGIN_MIN)
    dec = C.decision_indices(len(X))
    res = {
        "tag": tag,
        "n_windows": int(len(X)),
        "n_decision": int(len(dec)),
        "forward_s": round(time.time() - t0, 2),
        "window_table": {},
        "decision_table": {},
        "pulses_online_8_3": {},
    }
    for zi, zname in enumerate(C.ZONE_NAMES):
        m = zone == zi
        if not m.any():
            continue
        md = m[dec]
        res["window_table"][zname] = {
            "n": int(m.sum()),
            "class1_argmax_ratio": round(float((pred[m] == 1).mean()), 4),
            "class1_hit_ratio": round(float(hit[m].mean()), 4),
            "mean_margin": round(float(margin[m].mean()), 2),
            "margin_ge31_ratio": round(float((margin[m] >= C.CONF_MAX).mean()), 4),
        }
        res["decision_table"][zname] = {
            "n": int(md.sum()),
            "class1_argmax_ratio": round(float((pred[dec][md] == 1).mean()), 4),
            "class1_hit_ratio": round(float(hit[dec][md].mean()), 4),
        }
    t0d = t0_arr = None
    # 连续决策时间轴 + 基线 8/3 回放
    center_dec = center[dec]
    t0d = t0_arr = center_dec - C.WIN_MS // 2
    zd = zone[dec]
    pulses = C.replay_pulses(t0d, hit[dec], margin[dec], pred[dec])
    pm = C.pulse_metrics(pulses, zd, center_dec)
    res["pulses_online_8_3"] = pm
    res["pulse_list"] = [
        {"j": p["j"], "center_ms": p["center_ms"], "class_pred": p["class_pred"],
         "margin": p["margin"], "zone": C.ZONE_NAMES[int(zd[p["j"]])]}
        for p in pulses
    ]
    return res


def fmt_table(res):
    lines = ["[v5/%s] windows=%d decisions=%d forward=%.1fs" %
             (res["tag"], res["n_windows"], res["n_decision"], res["forward_s"])]
    lines.append("  zone          n_all  arg1   hit1   meanMargin  >=31  | n_dec  hit1_dec")
    for zname, s in res["window_table"].items():
        d = res["decision_table"][zname]
        lines.append("  %-12s %5d  %5.3f  %5.3f  %8.1f  %5.3f | %5d  %7.3f" %
                     (zname, s["n"], s["class1_argmax_ratio"], s["class1_hit_ratio"],
                      s["mean_margin"], s["margin_ge31_ratio"], d["n"], d["class1_hit_ratio"]))
    pm = res["pulses_online_8_3"]
    lines.append("  [8/3] pulses=%d wave=%d static_fp=%d/%s per_min=%s empty_fp=%d open_pulses=%d "
                 "open_chunks=%d/%d wave_pulses_per_min=%s excluded=%d" % (
                     pm["pulses_total"], pm["wave_pulses"], pm["static_fp"],
                     pm["static_minutes"], C.fmt(pm["static_fp_per_min"]),
                     pm["empty_fp"], pm["openclose_pulses"],
                     pm["openclose_chunks_detected"], pm["openclose_chunks_total"],
                     C.fmt(pm["wave_pulses_per_min"]), pm["excluded_pulses"]))
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--params", default=str(DEFAULT_PARAMS))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--no-shift", action="store_true")
    args = ap.parse_args(argv)
    t0 = time.time()
    d = np.load(args.data, allow_pickle=False)
    X = d["X_q"]; Xs = d["Xq_shift"]
    center = d["center_rel"].astype(np.int64)
    zone = C.zones_of(center)
    doc, layers = load_layers(Path(args.params))
    print("[v5] params=%s classes=%s layers=%s" %
          (Path(args.params).name, doc.get("num_classes"), [L["name"] for L in layers]))
    result = {
        "data": str(args.data), "params": str(args.params),
        "num_classes": int(doc.get("num_classes", 2)),
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "probes": {},
        "elapsed_s": None,
    }
    r = probe(X, "orig4ch", zone, center, layers)
    print(fmt_table(r))
    result["probes"]["orig4ch"] = r
    if not args.no_shift:
        rs = probe(Xs, "shift4ch", zone, center, layers)
        print(fmt_table(rs))
        result["probes"]["shift4ch"] = rs
    result["elapsed_s"] = round(time.time() - t0, 2)
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[v5] saved %s  elapsed=%.1fs" % (out, time.time() - t0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
