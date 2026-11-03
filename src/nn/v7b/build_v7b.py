# -*- coding: utf-8 -*-
"""task-63 v7b 部署件构建：s50+s100 混合训练，s100 口径评估/量化，产 nn/out_v7b 五件套。

一条命令：
  PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7b/build_v7b.py
复跑复用已训练模型（验证产物可复现）：
  ... build_v7b.py --reuse-model

说明：本脚本只写 nn/v7b/ 与 nn/out_v7b/，不改 nn/v7/、nn/out_v7/、retina_event/、host/、docs/。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
V7B = ROOT / "nn" / "v7b"
OUT = ROOT / "nn" / "out_v7b"
DATA = V7B / "windows_v7b.npz"
MODEL = OUT / "model_v7b.pt"
PARAMS = OUT / "nn_params_v7b.json"
ROM = OUT / "nn_rom_data_v7b.v"
OFFSETS = OUT / "rom_offsets.json"
GOLDEN = OUT / "golden_vectors.json"
TB = OUT / "tb_golden_v7.vh"
HASHES = OUT / "artifact_hashes.json"
META = OUT / "build_meta.json"
GOLDEN_MTIME = 1793380575  # 2026-10-30T17:16:15Z; frozen tb_golden_v7.vh header time, pin it
PY = sys.executable

for p in (ROOT / "nn", ROOT / "nn" / "v7", ROOT / "nn" / "v6"):
    sys.path.insert(0, str(p))

import v6_common as C  # noqa: E402
import v7_eval as E  # noqa: E402
import v7_feats as F  # noqa: E402
import train_v7 as T  # noqa: E402
import quant_v7 as QV  # noqa: E402


def force_utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dataset_hash(d: dict) -> str:
    h = hashlib.sha256()
    for k in sorted(d):
        a = np.ascontiguousarray(d[k])
        h.update(k.encode("utf-8"))
        h.update(str(a.dtype).encode("ascii"))
        h.update(str(a.shape).encode("ascii"))
        h.update(a.tobytes())
    return h.hexdigest()


def build_combined_data() -> dict:
    if DATA.exists():
        d = dict(np.load(DATA, allow_pickle=False))
        print("[v7b] reuse data %s n=%d sha=%s" % (DATA, len(d["y"]), sha256_file(DATA)), flush=True)
        return d
    d50 = dict(np.load(ROOT / "nn/v7/windows_v7.npz", allow_pickle=False))
    d100 = dict(np.load(ROOT / "nn/out_v7/windows_s100.npz", allow_pickle=False))
    d = {}
    for k in d50:
        if d50[k].shape == ():
            d[k] = d50[k]
        else:
            d[k] = np.concatenate([d50[k], d100[k]], axis=0)
    # 标量键只存在于 s50
    for k in ("win_ms", "stride_ms", "grid_shift", "grid_w", "grid_h", "channels",
              "global_names", "zones_json", "label_map_json"):
        if k in d50:
            d[k] = d50[k]
    d["win_ms"] = np.asarray(100, dtype=np.int64)
    d["stride_ms"] = np.asarray(100, dtype=np.int64)
    V7B.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(DATA, **d)
    print("[v7b] wrote %s n=%d s50=%d s100=%d" % (DATA, len(d["y"]), len(d50["y"]), len(d100["y"])), flush=True)
    return d


def pairing_check(d: dict, m: dict) -> dict:
    n50 = len(np.load(ROOT / "nn/v7/windows_v7.npz", allow_pickle=False)["y"])
    is100 = np.zeros(len(d["y"]), dtype=bool)
    is100[n50:] = True
    base = m["primary"] | m["hardneg"] | m["control_neg"]
    keys50 = {}
    zone = d["zone"].astype(str)
    for i in np.where(base & ~is100)[0]:
        k = (zone[i], str(d["session"][i]), int(d["aug"][i]), int(d["center_ms"][i]))
        keys50[k] = int(d["fold"][i])
    n100 = int((base & is100).sum())
    bad = 0
    missing = 0
    for i in np.where(base & is100)[0]:
        k = (zone[i], str(d["session"][i]), int(d["aug"][i]), int(d["center_ms"][i]))
        if k not in keys50:
            missing += 1
        elif keys50[k] != int(d["fold"][i]):
            bad += 1
    return {"n_train_base": int(base.sum()), "n_s100_base": n100, "n_s50_base": int((base & ~is100).sum()),
            "paired": n100 - missing, "missing": int(missing), "badfold": int(bad),
            "s100_base_only": int((m["primary"] | m["hardneg"])[is100].sum()),
            "s100_primary": int((m["primary"] & is100).sum()),
            "s100_hardneg": int((m["hardneg"] & is100).sum()),
            "per_fold_hardneg_train": {str(f): int((m["hardneg"] & base & (d["fold"] == f)).sum()) for f in (0, 1)},
            "per_fold_hardneg_eval": {str(f): int((m["hardneg"] & is100 & (d["fold"] == f)).sum()) for f in (0, 1)}}


def patch_gen_golden() -> Path:
    src = (ROOT / "nn/v7/gen_golden.py").read_text(encoding="utf-8")
    src = src.replace('OUT = ROOT / "nn/out_v7"', 'OUT = ROOT / "nn/out_v7b"')
    src = src.replace("nn_params_v7.json", "nn_params_v7b.json")
    src = src.replace("model_v7.pt", "model_v7b.pt")
    src = src.replace("nn/v7/windows_v7.npz", "nn/v7b/windows_v7b.npz")
    src = src.replace("fpga_comp.v7.int8_golden.v1", "fpga_comp.v7b.int8_golden.v1")
    old = '"generated_utc": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),'
    new = '"generated_utc": "2026-10-30T00:00:00Z",'
    if old not in src:
        raise SystemExit("gen_golden generated_utc line not found")
    src = src.replace(old, new)
    dst = V7B / "gen_golden_v7b.py"
    dst.write_text(src, encoding="utf-8")
    return dst


def run_cmd(args, log):
    p = subprocess.run([str(a) for a in args], cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONUTF8="1"))
    log.append("$ " + " ".join(str(a) for a in args))
    if p.stdout:
        log.append(p.stdout.rstrip())
    if p.stderr:
        log.append("[stderr] " + p.stderr.rstrip())
    if p.returncode != 0:
        raise SystemExit("command failed rc=%d: %s" % (p.returncode, " ".join(str(a) for a in args)))
    return p.stdout


def main():
    force_utf8_stdio()
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse-model", action="store_true")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--calib-n", type=int, default=2048)
    args = ap.parse_args()
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    log = []

    d = build_combined_data()
    m = E.masks(d)
    x_all = d["X"].astype(np.float32)
    feats, feat_names = F.build("fmin_n_rel7", d["g"])
    pair = pairing_check(d, m)
    print("[v7b] pairing", json.dumps(pair, ensure_ascii=False), flush=True)

    rows_tr, yb_tr = T.rows_train_full(d, m)
    sw_tr = T.sample_weights(rows_tr, m, 3.0, 1.0)
    print("[v7b] train rows=%d (s50+s100) wave=%d hardneg=%d control_neg=%d" % (
        len(rows_tr), int(m["wave"][rows_tr].sum()), int(m["hardneg"][rows_tr].sum()),
        int(m["control_neg"][rows_tr].sum())), flush=True)

    if args.reuse_model:
        if not MODEL.exists():
            raise SystemExit("--reuse-model but model not found: %s" % MODEL)
        import torch
        ck = torch.load(str(MODEL), map_location="cpu", weights_only=False)
        model = C.build_model("bin", n_in=4, n_feat=len(feat_names), n_out=2)
        model.load_state_dict(ck["state_dict"])
        model.v7_feat_names = list(feat_names)
        print("[v7b] reuse model %s" % MODEL, flush=True)
    else:
        model = T.train_binary(x_all[rows_tr], feats[rows_tr], yb_tr, sw_tr,
                               seed=args.seed, epochs=args.epochs)
        model.v7_feat_names = list(feat_names)
        import torch
        torch.save({"state_dict": model.state_dict(), "num_classes": 2,
                    "feat_names": list(feat_names), "arch": "v7_cnn_glob_bin",
                    "data_sha256": sha256_file(DATA), "seed": args.seed,
                    "epochs": args.epochs, "wave_weight": 3.0,
                    "train_rows": int(len(rows_tr))}, MODEL)
        print("[v7b] trained model -> %s (%.1fs)" % (MODEL, time.time() - t0), flush=True)

    rng = np.random.default_rng(args.seed)
    if len(rows_tr) > args.calib_n:
        cal = np.sort(rng.choice(rows_tr, size=args.calib_n, replace=False))
    else:
        cal = np.asarray(rows_tr)
    params = QV.quantize_v7(model, x_all[cal], feats[cal].astype(np.int8), headroom=1.0)
    params["deploy_config"] = {"margin_min": 16, "n_consec": 3, "guard_s": 0.5,
                               "cadence_ms": 100, "decision_step": 1, "eval_stride": 100}
    params["task"] = "task-63"
    errs = QV.check_params_v7(params)
    if errs:
        raise SystemExit("params errors: %s" % errs)
    if params["rom_words"] != 5652:
        raise SystemExit("rom_words %d != 5652" % params["rom_words"])
    if params["feat_names"] != list(feat_names):
        raise SystemExit("feat_names mismatch")
    PARAMS.write_text(json.dumps(params, ensure_ascii=False, indent=1), encoding="utf-8")
    words = QV.write_rom_v7(ROM, params)
    if len(words) != 5652:
        raise SystemExit("rom words %d" % len(words))
    print("[v7b] params/ROM wrote words=%d errors=%d" % (len(words), len(errs)), flush=True)

    # 元数据 JSON 里只写仓库相对 POSIX 路径，避免把本机绝对路径带进交付件。
    out = run_cmd([PY, ROOT / "nn/v7/check_params_rom.py",
                   "--params", "nn/out_v7b/nn_params_v7b.json",
                   "--rom", "nn/out_v7b/nn_rom_data_v7b.v",
                   "--offsets-json", "nn/out_v7b/rom_offsets.json"], log)
    if "PARAMS_ROM_MATCH_OK=1" not in out:
        raise SystemExit("PARAMS_ROM_MATCH_OK not 1")
    print("[v7b] PARAMS_ROM_MATCH_OK=1", flush=True)

    gscript = patch_gen_golden()
    out = run_cmd([PY, gscript], log)
    os.utime(GOLDEN, (GOLDEN_MTIME, GOLDEN_MTIME))
    print("[v7b] golden generated", flush=True)
    # 用仓库相对路径调用生成器，确保 TB 头部 provenance 与冻结版 d5e35956 一致。
    out = run_cmd([PY, Path("nn/v7b/gen_tb_golden_v7b.py"), "--json", Path("nn/out_v7b/golden_vectors.json"), "--out", Path("nn/out_v7b/tb_golden_v7.vh")], log)
    if "TB_GOLDEN_SELFCHECK_OK=1" not in out:
        raise SystemExit("TB golden gen selfcheck failed")
    out = run_cmd([PY, ROOT / "nn/v7b/gen_tb_golden_v7b.py", "--json", GOLDEN, "--out", TB, "--check"], log)
    if "TB_GOLDEN_SELFCHECK_OK=1" not in out:
        raise SystemExit("TB golden check failed")
    print("[v7b] TB_GOLDEN_SELFCHECK_OK=1", flush=True)

    hashes = {"dataset_npz": sha256_file(DATA), "dataset_content": dataset_hash(d),
              "params": sha256_file(PARAMS), "rom": sha256_file(ROM),
              "offsets": sha256_file(OFFSETS), "golden": sha256_file(GOLDEN),
              "tb": sha256_file(TB), "model": sha256_file(MODEL)}
    stable = None
    if args.reuse_model and HASHES.exists():
        prev = json.loads(HASHES.read_text(encoding="utf-8"))
        stable = all(prev.get(k) == v for k, v in hashes.items())
    HASHES.write_text(json.dumps(hashes, ensure_ascii=False, indent=1), encoding="utf-8")

    # 最终模型在训练集上的 int8 自检（非泛化声明）
    feat_i = None if feats is None else feats.astype(np.int8)
    logits_i, _ = QV.forward_int8_v7(x_all, feat_i, params)
    pred_i = logits_i.argmax(axis=1)
    yb_all = m["y_bin"]
    cm = np.bincount(yb_all * 2 + pred_i, minlength=4).reshape(2, 2)
    in_sample = {"n": int(len(yb_all)), "accuracy": round(float((pred_i == yb_all).mean()), 6),
                 "confusion": {"true0_pred0": int(cm[0, 0]), "true0_pred1": int(cm[0, 1]),
                               "true1_pred0": int(cm[1, 0]), "true1_pred1": int(cm[1, 1])}}
    # 留出折上的部署 margin 16/3 数字见本次交付的 fixed-weight BCD 结果，不在本脚本重训 LOO。

    meta = {"task": "task-63", "reuse_model": bool(args.reuse_model), "epochs": args.epochs,
            "seed": args.seed, "train_rows": int(len(rows_tr)), "calib_rows": int(len(cal)),
            "pairing": pair, "hashes": hashes, "hash_stable": stable,
            "in_sample_int8": in_sample, "rom_words": params["rom_words"],
            "deploy_config": params["deploy_config"], "elapsed_s": round(time.time() - t0, 1),
            "cmd": " ".join([Path(PY).name, "nn/v7b/build_v7b.py"] + (["--reuse-model"] if args.reuse_model else []))}
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "build.log").write_text("\n".join(log) + "\n", encoding="utf-8")

    print("[v7b] in_sample_int8", json.dumps(in_sample, ensure_ascii=False), flush=True)
    print("[v7b] hashes", json.dumps(hashes, ensure_ascii=False), flush=True)
    print("[v7b] HASH_STABLE=%s" % (1 if stable else (0 if stable is False else "NA")), flush=True)
    print("[v7b] BUILD_OK=1 elapsed=%.1fs" % (time.time() - t0), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
