#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""task-42 v7 训练与量化主脚本。

实验：
  A 时间外推：train fold0 -> test fold1，train fold1 -> test fold0（全部窗，含硬负/静默）
  B 距离外推：near 正样本（open_L_near + wave_L）训练 -> far（open_L_far + wave_L_far）测试
  C 镜像迁移：每折方向 × {只用真实正样本, 只用镜像正样本} 训练 -> 在真实/镜像正样本上各测一次
  Q int8：每个留出实验单独量化，统计 float argmax vs int8 argmax 一致率
  D 空桌面：留出空桌面窗 n<50 的 class1 命中必须为 0
  F 最终模型：全部训练数据训练 -> 量化 -> 保存 model.pt / params / ROM / 契约 / golden vectors

判据（写进 nn/_evidence/V7_MODEL_OK.log）：
  (a) 时间外推开合块召回 >= 0.85, 挥手窗 class1 命中率 <= 0.15, 静默误触 <= 0.5/min
  (b) 距离外推 far 开合 >= 0.75, 挥手 <= 0.20
  (c) 镜像迁移开合召回差 <= 0.10, 挥手命中差 <= 0.10
  (d) 空桌面 n<50 窗零误触
  (e) int8 argmax 一致率 >= 0.99（(a)(b) 留出窗）
  (f) 一条命令可复跑 + seed/哈希入证据
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "nn" / "v7"))
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402
import v7_feats as F  # noqa: E402
import v7_eval as E  # noqa: E402
import quant_v7 as QV  # noqa: E402

DEFAULT_DATA = ROOT / "nn" / "v7" / "windows_v7.npz"
DEFAULT_OUT = ROOT / "nn" / "out_v7"
MARGINS = (8, 16, 24)
EVAL_STEP = 2  # 决策节奏：2 窗 = 100 ms（板侧）；--stride 50 时改为 1（体检用）


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def train_binary(x, feats, yb, sw, seed=1234, epochs=30, batch=128, lr=2e-3, wd=1e-4,
                 hn=None, hn_lam=0.0, hn_margin=4.0):
    torch, nn = C._torch()
    torch.set_num_threads(4)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    counts = np.bincount(yb, minlength=2).astype(np.float64)
    counts[counts == 0] = 1.0
    cw = np.clip(np.sqrt(len(yb) / (2.0 * counts)), 0.5, 3.0)
    cw_t = torch.tensor(cw, dtype=torch.float32)
    model = C.build_model("bin", n_in=x.shape[1],
                          n_feat=(0 if feats is None else feats.shape[1]), n_out=2)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    lossf = nn.CrossEntropyLoss(weight=cw_t, reduction="none")
    xt = torch.from_numpy(np.ascontiguousarray(x)).float()
    yt = torch.from_numpy(np.ascontiguousarray(yb)).long()
    ft = torch.from_numpy(np.ascontiguousarray(feats)).float() if feats is not None else None
    swt = torch.from_numpy(np.ascontiguousarray(sw)).float()
    hnt = torch.from_numpy(np.ascontiguousarray(hn.astype(np.float32))) if hn is not None else None
    for _ep in range(epochs):
        perm = rng.permutation(len(yt))
        model.train()
        for i in range(0, len(yt), batch):
            idx = perm[i:i + batch]
            opt.zero_grad()
            out = model(xt[idx], ft[idx]) if ft is not None else model(xt[idx])
            loss = (lossf(out, yt[idx]) * swt[idx]).sum() / swt[idx].sum().clamp(min=1e-6)
            if hnt is not None and hn_lam > 0:
                idxt = torch.as_tensor(idx)
                hm = hnt[idxt] > 0.5
                if bool(hm.any()):
                    hi = torch.nonzero(hm).squeeze(1)
                    c1h = out[hi, 1] - out[hi, 0]
                    loss = loss + float(hn_lam) * torch.relu(c1h + float(hn_margin)).mean()
            loss.backward()
            opt.step()
        sched.step()
    model.eval()
    return model


def predict(model, x, feats):
    pred, margin, c1, logits = C.predict_model(model, x, feat=feats)
    return pred, c1, logits


def eval_margins(d, rows, pred, c1, margins=MARGINS, keep_zones=False, step=None):
    out = {}
    if step is None:
        step = EVAL_STEP
    for mg in margins:
        summ, per_zone, _ = E.eval_rows(d, rows, pred, c1, margin_min=mg, step=step)
        out[str(mg)] = summ
        if keep_zones:
            out[str(mg)]["per_zone"] = per_zone
    return out


def quantize_and_match(model, d, x_all, feats_all, rows_train, rows_test, calib_n=2048,
                       headroom=1.0, seed=0, debug_rows=(), qat_epochs=0, wave_weight=3.0,
                       feat_names=()):
    """量化 model（calib 用 rows_train），在 rows_test 上算 float/int8 一致率。"""
    if feat_names:
        model.v7_feat_names = list(feat_names)
    rng = np.random.default_rng(seed)
    if calib_n and len(rows_train) > calib_n:
        cal_rows = np.sort(rng.choice(rows_train, size=calib_n, replace=False))
    else:
        cal_rows = np.asarray(rows_train)
    feat_cal = None if feats_all is None else feats_all[cal_rows].astype(np.int8)
    params = QV.quantize_v7(model, x_all[cal_rows], feat_cal, headroom=headroom)
    feat_te = None if feats_all is None else feats_all[rows_test].astype(np.int8)
    logits_i, stats = QV.forward_int8_v7(x_all[rows_test], feat_te, params)
    logits_f = predict_logits(model, x_all[rows_test], None if feats_all is None else feats_all[rows_test])
    pred_f = logits_f.argmax(axis=1)
    pred_i = logits_i.argmax(axis=1)
    agree = float((pred_f == pred_i).mean())
    yb_te = np.where(d["y"][rows_test] == 1, 1, 0)
    cm_i = np.bincount(yb_te * 2 + pred_i, minlength=4).reshape(2, 2)
    cm_f = np.bincount(yb_te * 2 + pred_f, minlength=4).reshape(2, 2)
    # 逐组一致率
    zone = d["zone"].astype(str)[rows_test]
    per_zone = {}
    for z in np.unique(zone):
        m = zone == z
        per_zone[z] = {"n": int(m.sum()), "agree": round(float((pred_f[m] == pred_i[m]).mean()), 4)}
    # 按真实标签分组的一致率（lead m01124 要求定位翻转窗类别）
    yv_te = d["y"][rows_test]
    agree_by_y = {}
    for k in (0, 1, 2):
        sel = yv_te == k
        if sel.any():
            agree_by_y[str(k)] = {"n": int(sel.sum()),
                                  "agree": round(float((pred_f[sel] == pred_i[sel]).mean()), 4)}
            if k == 2:
                # 挥手窗单列：class1 判定（部署关注的是被判成手部开合）
                agree_by_y["2_class1"] = {"n": int(sel.sum()),
                                          "agree": round(float(((pred_f[sel] == 1) == (pred_i[sel] == 1)).mean()), 4)}
    # float/int8 的 class1 score 相关
    c1_f = logits_f[:, 1] - logits_f[:, 0]
    c1_i = logits_i[:, 1].astype(np.int64) - logits_i[:, 0].astype(np.int64)
    # int8 域决策指标
    eval_i = eval_margins(d, rows_test, pred_i, c1_i.astype(np.float32))
    info = {
        "n": int(len(rows_test)), "agree": round(agree, 6),
        "per_zone": per_zone, "agree_by_y": agree_by_y, "int8_eval": eval_i,
        "logit_scale_shared": params["logit_scale_shared"],
        "rom_words": params["rom_words"],
        "calib_n": int(len(cal_rows)),
        "confusion_int8": {"true0_pred0": int(cm_i[0, 0]), "true0_pred1": int(cm_i[0, 1]),
                           "true1_pred0": int(cm_i[1, 0]), "true1_pred1": int(cm_i[1, 1])},
        "confusion_float": {"true0_pred0": int(cm_f[0, 0]), "true0_pred1": int(cm_f[0, 1]),
                            "true1_pred0": int(cm_f[1, 0]), "true1_pred1": int(cm_f[1, 1])},
        "params": params,
    }
    # golden 调试窗
    if debug_rows:
        dbg = {}
        for tag, ridx in debug_rows.items():
            fv = None if feats_all is None else np.asarray([feats_all[ridx]]).astype(np.int8)
            xi = x_all[ridx:ridx + 1]
            li, _st, dg = QV.forward_int8_v7(xi, fv, params, debug=True)
            lf = predict_logits(model, xi, None if feats_all is None else feats_all[ridx:ridx + 1])
            dbg[tag] = {"row": int(ridx), "logits_int8": [int(v) for v in li[0]],
                        "logits_float": [float(v) for v in lf[0]],
                        "layers": {k: v for k, v in dg.items()}}
        info["debug"] = dbg
    # ---------------- QAT：固定 A/SH/s_y，用整数链路 STE 微调，再重算一致性 ----------------
    if qat_epochs:
        import qat_v7 as QAT
        agree_before = info["agree"]
        yb_tr = np.where(d["y"][rows_train] == 1, 1, 0).astype(np.int64)
        sw_tr = np.where(d["y"][rows_train] == 2, float(wave_weight), 1.0).astype(np.float32)
        feat_tr = None if feats_all is None else feats_all[rows_train].astype(np.int8)
        model = QAT.qat_finetune(model, params, x_all[rows_train], feat_tr, yb_tr, sw_tr,
                                 epochs=qat_epochs, seed=seed)
        params = QAT.refresh_params(model, params)
        logits_f = predict_logits(model, x_all[rows_test], None if feats_all is None else feats_all[rows_test])
        pred_f = logits_f.argmax(axis=1)
        logits_i, _st = QV.forward_int8_v7(x_all[rows_test], feat_te, params)
        pred_i = logits_i.argmax(axis=1)
        agree = float((pred_f == pred_i).mean())
        cm_i = np.bincount(yb_te * 2 + pred_i, minlength=4).reshape(2, 2)
        per_zone = {}
        for z in np.unique(zone):
            mz = zone == z
            per_zone[z] = {"n": int(mz.sum()), "agree": round(float((pred_f[mz] == pred_i[mz]).mean()), 4)}
        agree_by_y = {}
        for k in (0, 1, 2):
            sel = yv_te == k
            if sel.any():
                agree_by_y[str(k)] = {"n": int(sel.sum()),
                                      "agree": round(float((pred_f[sel] == pred_i[sel]).mean()), 4)}
                if k == 2:
                    agree_by_y["2_class1"] = {"n": int(sel.sum()),
                                              "agree": round(float(((pred_f[sel] == 1) == (pred_i[sel] == 1)).mean()), 4)}
        c1_i = logits_i[:, 1].astype(np.int64) - logits_i[:, 0].astype(np.int64)
        eval_i = eval_margins(d, rows_test, pred_i, c1_i.astype(np.float32))
        info.update({"agree": round(agree, 6), "per_zone": per_zone, "agree_by_y": agree_by_y,
                     "int8_eval": eval_i, "logit_scale_shared": params["logit_scale_shared"],
                     "confusion_int8": {"true0_pred0": int(cm_i[0, 0]), "true0_pred1": int(cm_i[0, 1]),
                                        "true1_pred0": int(cm_i[1, 0]), "true1_pred1": int(cm_i[1, 1])},
                     "params": params,
                     "qat": {"epochs": int(qat_epochs), "agree_before": agree_before,
                             "agree_after": round(agree, 6)}})
    return info


def predict_logits(model, x, feats):
    torch, _ = C._torch()
    with torch.no_grad():
        xt = torch.from_numpy(np.ascontiguousarray(x)).float()
        ft = None if feats is None else torch.from_numpy(np.ascontiguousarray(feats)).float()
        out = model(xt, ft) if ft is not None else model(xt)
        return out.cpu().numpy()


def select_neg_rows(d, m, fold=None):
    sel = (m["primary"] & (m["y"] == 0)) | m["hardneg"] | m["control_neg"]
    if fold is not None:
        sel = sel & (m["fold"] == fold)
    return np.where(sel)[0]


def rows_train_full(d, m, fold=None, aug_pos=None, near_only=False):
    """pos + wave + neg 的训练行。"""
    pos = m["pos"].copy()
    if aug_pos is not None:
        pos &= (m["aug"] == aug_pos)
    if near_only:
        zone = d["zone"].astype(str)
        pos &= np.isin(zone, ("open_L_near", "wave_L"))
    wave = m["wave"].copy()
    if near_only:
        wave &= np.isin(d["zone"].astype(str), ("wave_L",))
    neg = (m["primary"] & (m["y"] == 0)) | m["hardneg"] | m["control_neg"]
    if fold is not None:
        pos &= (m["fold"] == fold)
        wave &= (m["fold"] == fold)
        neg &= (m["fold"] == fold)
    sel = pos | wave | neg
    rows = np.where(sel)[0]
    yb = np.where(m["y"][rows] == 1, 1, 0).astype(np.int64)
    return rows, yb


def sample_weights(rows, m, wave_weight, hardneg_weight=1.0):
    sw = np.ones(len(rows), dtype=np.float32)
    sw[m["wave"][rows]] = wave_weight
    if hardneg_weight != 1.0:
        sw[m["hardneg"][rows]] = hardneg_weight
    return sw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--feats", default="f7n")
    ap.add_argument("--wave-weight", type=float, default=3.0)
    ap.add_argument("--hardneg-weight", type=float, default=1.0)
    ap.add_argument("--hn-lambda", type=float, default=0.0)
    ap.add_argument("--hn-margin", type=float, default=4.0)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--calib-n", type=int, default=2048)
    ap.add_argument("--headroom", type=float, default=1.0)
    ap.add_argument("--qat-epochs", type=int, default=8)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--only", default="a,b,c,d,q,final")
    ap.add_argument("--results", default="results_v7.json")
    ap.add_argument("--stride", type=int, default=100, choices=(50, 100),
                    help="决策节奏：100=板侧每 100ms 一次决策（判据）；50=每窗一次（体检）")
    args = ap.parse_args()
    global EVAL_STEP
    EVAL_STEP = 2 if args.stride >= 100 else 1
    t_start = time.time()
    if args.quick:
        args.epochs = 4
        args.calib_n = 256
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    d = E.load(args.data)
    m = E.masks(d)
    x_all = d["X"].astype(np.float32)
    eval_roles = m["primary"] | m["hardneg"]  # (a) 只测 v7 标注区（7min 仅作 control_neg 负样本/空桌面复核）
    if args.feats == "none":
        feats_all = None
        feat_names = []
    else:
        feats_all, feat_names = F.build(args.feats, d["g"])
    print(f"[v7] data={args.data} n={len(d['y'])} feats={args.feats} F={len(feat_names)} "
          f"wave_weight={args.wave_weight} epochs={args.epochs} seed={args.seed}", flush=True)
    print(f"[v7] feat_names={feat_names}", flush=True)

    results = {
        "task": "task-42", "seed": args.seed, "feats": args.feats,
        "feat_names": feat_names, "wave_weight": args.wave_weight,
        "epochs": args.epochs, "data": {"path": str(args.data), "sha256": sha256_file(args.data),
                                        "n": int(len(d["y"]))},
        "stride": args.stride, "eval_step": EVAL_STEP,
        "cmd": " ".join([Path(sys.executable).name, str(Path(__file__)), "--data", args.data,
                         "--out-dir", args.out_dir, "--feats", args.feats,
                         "--wave-weight", str(args.wave_weight), "--epochs", str(args.epochs),
                         "--seed", str(args.seed), "--calib-n", str(args.calib_n)]),
        "A_time": {}, "B_distance": {}, "C_mirror": {}, "Q_int8": {}, "D_empty": {}, "final": {},
    }
    only = set(s.strip() for s in args.only.split(",") if s.strip())

    # ---------------- A 时间外推 + int8 一致率 ----------------
    fold_models = {}
    if "a" in only:
        folds = []
        pooled_rows, pooled_pred, pooled_c1 = [], [], []
        pooled_i_rows, pooled_i_logits = [], []
        for train_fold, test_fold in ((0, 1), (1, 0)):
            t0 = time.time()
            rows_tr, yb_tr = rows_train_full(d, m, fold=train_fold)
            sw_tr = sample_weights(rows_tr, m, args.wave_weight, args.hardneg_weight)
            model = train_binary(x_all[rows_tr], None if feats_all is None else feats_all[rows_tr],
                                 yb_tr, sw_tr, seed=args.seed, epochs=args.epochs,
                                 hn=m["hardneg"][rows_tr], hn_lam=args.hn_lambda,
                                 hn_margin=args.hn_margin)
            rows_te = np.where((m["fold"] == test_fold) & eval_roles)[0]
            pred, c1, logits = predict(model, x_all[rows_te], None if feats_all is None else feats_all[rows_te])
            yb_te = np.where(m["y"][rows_te] == 1, 1, 0)
            ev = eval_margins(d, rows_te, pred, c1, keep_zones=True)
            win_acc = float((pred == yb_te).mean())
            q = quantize_and_match(model, d, x_all, feats_all, rows_tr, rows_te,
                                   calib_n=args.calib_n, headroom=args.headroom, seed=args.seed,
                               qat_epochs=args.qat_epochs, wave_weight=args.wave_weight,
                               feat_names=feat_names)
            # int8-in-the-loop：同一量化参数在留出窗 + 7min control 负样本上回放
            feat_i_te = None if feats_all is None else feats_all[rows_te].astype(np.int8)
            li_te, _ = QV.forward_int8_v7(x_all[rows_te], feat_i_te, q["params"])
            ctrl_rows = np.where(m["control_neg"])[0]
            feat_i_ctrl = None if feats_all is None else feats_all[ctrl_rows].astype(np.int8)
            li_ctrl, _ = QV.forward_int8_v7(x_all[ctrl_rows], feat_i_ctrl, q["params"])
            i8_ctrl = {"n_windows": int(len(ctrl_rows)),
                       "eval": eval_margins(d, ctrl_rows, li_ctrl.argmax(axis=1),
                                            (li_ctrl[:, 1] - li_ctrl[:, 0]).astype(np.float32),
                                            keep_zones=True)}
            pooled_i_rows.append(rows_te)
            pooled_i_logits.append(li_te)
            fold_models[test_fold] = model
            torch, _ = C._torch()
            torch.save({"state_dict": model.state_dict(), "num_classes": 2,
                        "feat_names": feat_names, "feats": args.feats},
                       out / f"model_fold{train_fold}.pt")
            cm = np.bincount(yb_te * 2 + pred, minlength=4).reshape(2, 2)
            folds.append({
                "train_fold": train_fold, "test_fold": test_fold,
                "n_train": int(len(rows_tr)), "n_test": int(len(rows_te)),
                "window_acc": round(win_acc, 4),
                "confusion_win": {"true0_pred0": int(cm[0, 0]), "true0_pred1": int(cm[0, 1]),
                                  "true1_pred0": int(cm[1, 0]), "true1_pred1": int(cm[1, 1])},
                "eval": ev,
                "int8": {"agree": q["agree"], "per_zone": q["per_zone"],
                         "agree_by_y": q.get("agree_by_y"), "qat": q.get("qat"),
                         "int8_eval": q["int8_eval"], "logit_scale_shared": q["logit_scale_shared"],
                         "int8_control": i8_ctrl},
                "secs": round(time.time() - t0, 1),
            })
            pooled_rows.append(rows_te)
            pooled_pred.append(pred)
            pooled_c1.append(c1)
            params_path = out / f"params_fold{train_fold}.json"
            params_path.write_text(json.dumps(q["params"], ensure_ascii=False), encoding="utf-8")
            print(f"[v7][A] train fold{train_fold} -> test fold{test_fold}: acc={win_acc:.4f} "
                  f"int8_agree={q['agree']:.4f} m8 open={ev['8']['open_chunks']} "
                  f"wave_hit={ev['8']['wave_window_hit_ratio']} static={ev['8']['static_fp_per_min']}/min "
                  f"empty={ev['8']['empty_pulses']} ({time.time() - t0:.0f}s)", flush=True)
        pooled_rows = np.concatenate(pooled_rows)
        pooled_pred = np.concatenate(pooled_pred)
        pooled_c1 = np.concatenate(pooled_c1)
        pooled_eval = eval_margins(d, pooled_rows, pooled_pred, pooled_c1)
        pi_rows = np.concatenate(pooled_i_rows)
        pi_logits = np.concatenate(pooled_i_logits)
        pi_pred = pi_logits.argmax(axis=1)
        pi_c1 = (pi_logits[:, 1].astype(np.int64) - pi_logits[:, 0].astype(np.int64)).astype(np.float32)
        pooled_i_eval = eval_margins(d, pi_rows, pi_pred, pi_c1)
        results["A_time"] = {
            "folds": folds,
            "pooled": {mg: pooled_eval[mg] for mg in pooled_eval},
            "pooled_int8": {mg: pooled_i_eval[mg] for mg in pooled_i_eval},
            "int8_agree_min": round(min(f["int8"]["agree"] for f in folds), 6),
            "int8_decision_gate": {
                "rule": "lead m01200: A_time pooled m8 open_chunks >= 15/17, wave <=0.5/min, static <=0.5/min, empty 0, hardneg 0",
                "open_chunks": pooled_i_eval["8"]["open_chunks"],
                "wave_pulses": pooled_i_eval["8"]["wave_pulses"],
                "wave_pulses_per_min": pooled_i_eval["8"]["wave_pulses_per_min"],
                "static_fp_per_min": pooled_i_eval["8"]["static_fp_per_min"],
                "empty_pulses": pooled_i_eval["8"]["empty_pulses"],
                "hardneg_pulses": pooled_i_eval["8"]["hardneg_pulses"],
            },
        }

    # ---------------- B 距离（lead m01124：far 区内时间留出为 gate；近训远测降级诊断） ----------------
    if "b" in only:
        t0 = time.time()
        zone = d["zone"].astype(str)
        center = d["center_ms"].astype(np.int64)
        pool = (m["primary"] | m["hardneg"]) & (m["aug"] == 0)
        far_zones = ("open_L_far", "wave_L_far")
        keys = np.char.add(np.char.add(zone.astype(str), "|"), d["win_idx"].astype(str))
        far_te = np.zeros(len(zone), dtype=bool)
        test_keys = set()
        for z in far_zones:
            r = np.where(pool & (zone == z))[0]
            r = r[np.argsort(center[r], kind="stable")]
            half = len(r) // 2
            for row in r[half:]:
                test_keys.add(str(keys[row]))
        far_te = np.isin(keys, np.array(sorted(test_keys)))
        rows_te = np.where(far_te)[0]
        # 训练集：全部 view A 段（含 far 前半与镜像副本）+ 硬负 + control 负样本，排除 far 后半及其镜像
        rows_tr = np.where((m["primary"] | m["hardneg"] | m["control_neg"]) & ~far_te)[0]
        sw_tr = sample_weights(rows_tr, m, args.wave_weight, args.hardneg_weight)
        model = train_binary(x_all[rows_tr], None if feats_all is None else feats_all[rows_tr],
                             np.where(m["y"][rows_tr] == 1, 1, 0).astype(np.int64), sw_tr,
                             seed=args.seed, epochs=args.epochs)
        pred, c1, _ = predict(model, x_all[rows_te], None if feats_all is None else feats_all[rows_te])
        ev = eval_margins(d, rows_te, pred, c1, keep_zones=True)
        yb_te = np.where(m["y"][rows_te] == 1, 1, 0)
        cm = np.bincount(yb_te * 2 + pred, minlength=4).reshape(2, 2)
        q = quantize_and_match(model, d, x_all, feats_all, rows_tr, rows_te,
                               calib_n=args.calib_n, headroom=args.headroom, seed=args.seed,
                               qat_epochs=args.qat_epochs, wave_weight=args.wave_weight,
                               feat_names=feat_names)
        results["B_distance"] = {
            "protocol": "far_zone_time_split (far first half train / far second half test, mirrors excluded from train)",
            "far_test_windows": {z: int((far_te & (zone == z)).sum()) for z in far_zones},
            "n_train": int(len(rows_tr)), "n_test": int(len(rows_te)),
            "window_acc": round(float((pred == yb_te).mean()), 4),
            "confusion_win": {"true0_pred0": int(cm[0, 0]), "true0_pred1": int(cm[0, 1]),
                              "true1_pred0": int(cm[1, 0]), "true1_pred1": int(cm[1, 1])},
            "eval": ev,
            "int8": {"agree": q["agree"], "per_zone": q["per_zone"], "agree_by_y": q["agree_by_y"],
                     "qat": q.get("qat"), "int8_eval": q["int8_eval"]},
            "secs": round(time.time() - t0, 1),
        }
        (out / "params_distance.json").write_text(json.dumps(q["params"], ensure_ascii=False), encoding="utf-8")
        print(f"[v7][B] far time-split: m8 open={ev['8']['open_chunks']} "
              f"wave_hit={ev['8']['wave_window_hit_ratio']} int8_agree={q['agree']:.4f} "
              f"({time.time() - t0:.0f}s)", flush=True)

        # 诊断：近训远测（原口径，不 gate；lead 要求照常报）
        t1 = time.time()
        rows_tr2, yb_tr2 = rows_train_full(d, m, near_only=True)
        sw2 = sample_weights(rows_tr2, m, args.wave_weight, args.hardneg_weight)
        model2 = train_binary(x_all[rows_tr2], None if feats_all is None else feats_all[rows_tr2],
                              yb_tr2, sw2, seed=args.seed, epochs=args.epochs)
        rows_far = np.where((zone == "open_L_far") | (zone == "wave_L_far"))[0]
        pred2, c12, _ = predict(model2, x_all[rows_far], None if feats_all is None else feats_all[rows_far])
        ev2 = eval_margins(d, rows_far, pred2, c12, keep_zones=True)
        q2 = quantize_and_match(model2, d, x_all, feats_all, rows_tr2, rows_far,
                                calib_n=args.calib_n, headroom=args.headroom, seed=args.seed,
                               qat_epochs=args.qat_epochs, wave_weight=args.wave_weight,
                               feat_names=feat_names)
        results["B_diag_near_to_far"] = {
            "n_train": int(len(rows_tr2)), "n_test": int(len(rows_far)),
            "eval": ev2, "int8_agree": q2["agree"],
            "window_acc": round(float((pred2 == np.where(m["y"][rows_far] == 1, 1, 0)).mean()), 4),
            "secs": round(time.time() - t1, 1),
        }
        print(f"[v7][B-diag] near->far: m8 open={ev2['8']['open_chunks']} "
              f"wave_hit={ev2['8']['wave_window_hit_ratio']} int8_agree={q2['agree']:.4f}", flush=True)

    # ---------------- C 镜像（lead m01124：训练含镜像增强，留出左右召回差为 gate） ----------------
    if "c" in only:
        gate = []
        diag = []
        for train_fold, test_fold in ((0, 1), (1, 0)):
            t0 = time.time()
            rows_tr, yb_tr = rows_train_full(d, m, fold=train_fold)  # aug0 + aug1 都进训练
            sw_tr = sample_weights(rows_tr, m, args.wave_weight, args.hardneg_weight)
            model = train_binary(x_all[rows_tr], None if feats_all is None else feats_all[rows_tr],
                                 yb_tr, sw_tr, seed=args.seed, epochs=args.epochs)
            base = (m["fold"] == test_fold) & (m["pos"] | m["wave"]) & m["primary"]
            entry = {"train_fold": train_fold, "test_fold": test_fold, "tests": {}}
            for aug_test in (0, 1):
                r_te = np.where(base & (m["aug"] == aug_test))[0]
                pred, c1, _ = predict(model, x_all[r_te],
                                      None if feats_all is None else feats_all[r_te])
                summ, per_zone, _ = E.eval_rows(d, r_te, pred, c1, margin_min=8, step=EVAL_STEP)
                entry["tests"][f"aug{aug_test}"] = {
                    "n": int(len(r_te)), "open_recall": summ["open_recall"],
                    "open_chunks": summ["open_chunks"],
                    "wave_hit_ratio": summ["wave_window_hit_ratio"],
                    "wave_pulses": summ["wave_pulses"],
                    "open_pulses": summ["open_pulses"],
                }
            entry["d_open_window"] = abs((entry["tests"]["aug0"]["open_recall"] or 0)
                                         - (entry["tests"]["aug1"]["open_recall"] or 0))
            def _chunks(cc):
                return int(str(cc).split("/")[0])
            entry["open_chunk_diff"] = abs(_chunks(entry["tests"]["aug0"]["open_chunks"])
                                           - _chunks(entry["tests"]["aug1"]["open_chunks"]))
            entry["d_wave"] = abs((entry["tests"]["aug0"]["wave_hit_ratio"] or 0)
                                  - (entry["tests"]["aug1"]["wave_hit_ratio"] or 0))
            entry["d_open"] = entry["d_open_window"]
            entry["secs"] = round(time.time() - t0, 1)
            gate.append(entry)
            print(f"[v7][C] train fold{train_fold} (aug0+aug1) -> test fold{test_fold}: "
                  f"aug0 open={entry['tests']['aug0']['open_chunks']} "
                  f"aug1 open={entry['tests']['aug1']['open_chunks']} "
                  f"d_open_win={entry['d_open_window']:.3f} chunk_diff={entry['open_chunk_diff']} "
                  f"d_wave={entry['d_wave']:.3f}", flush=True)

            # 诊断：aug0 训 -> aug1 测（原口径，不 gate）
            rows0, yb0 = rows_train_full(d, m, fold=train_fold, aug_pos=0)
            sw0 = sample_weights(rows0, m, args.wave_weight, args.hardneg_weight)
            model0 = train_binary(x_all[rows0], None if feats_all is None else feats_all[rows0],
                                  yb0, sw0, seed=args.seed, epochs=args.epochs)
            r_diag = np.where(base & (m["aug"] == 1))[0]
            pd, cd, _ = predict(model0, x_all[r_diag],
                                None if feats_all is None else feats_all[r_diag])
            sd, _, _ = E.eval_rows(d, r_diag, pd, cd, margin_min=8, step=EVAL_STEP)
            diag.append({"train_fold": train_fold, "aug_train": 0, "aug_test": 1,
                         "open_recall": sd["open_recall"], "open_chunks": sd["open_chunks"],
                         "wave_hit_ratio": sd["wave_window_hit_ratio"]})
            print(f"[v7][C-diag] aug0->aug1: open={sd['open_chunks']} "
                  f"wave_hit={sd['wave_window_hit_ratio']}", flush=True)
        results["C_mirror"] = {
            "protocol": "train with mirror augmentation (aug0+aug1), held-out fold split by aug: "
                        "|recall(left)-recall(right)| gate",
            "gate": gate,
            "d_open_max": round(max(g["d_open"] for g in gate), 4),
            "d_open_window_max": round(max(g["d_open_window"] for g in gate), 4),
            "d_open_chunk_diff_max": int(max(g["open_chunk_diff"] for g in gate)),
            "d_wave_max": round(max(g["d_wave"] for g in gate), 4),
            "gate_chunk_pass": bool(max(g["open_chunk_diff"] for g in gate) <= 1
                                    and max(g["d_open_window"] for g in gate) <= 0.10),
            "gate_rule": "lead m01200: |chunk diff| <= 1 AND |window recall diff| <= 0.10",
            "diagnostic_aug0_to_aug1": diag,
        }

    # ---------------- D 空桌面（用 A 的留出结果即可，单独抽出来核对） ----------------
    if "d" in only and results.get("A_time"):
        empty_zs = {}
        for f in results["A_time"]["folds"]:
            ev = f["eval"]["8"]["per_zone"]
            for z, v in ev.items():
                if E.ZONE_GROUP.get(z) == "empty":
                    empty_zs.setdefault(z, []).append(v)
        ctrl = {}
        for train_fold, test_fold in ((0, 1), (1, 0)):
            ctrl_rows = np.where((m["fold"] == test_fold) & m["control_neg"])[0]
            mdl = fold_models[test_fold]
            pr, cc, _ = predict(mdl, x_all[ctrl_rows], None if feats_all is None else feats_all[ctrl_rows])
            ev = eval_margins(d, ctrl_rows, pr, cc, keep_zones=True)
            per = ev["8"]["per_zone"]
            ctrl[f"fold{test_fold}"] = {
                "n_windows": int(len(ctrl_rows)),
                "empty_desk": per.get("empty_desk"),
                "static_a": per.get("static_a"),
                "static_b": per.get("static_b"),
                "openclose": per.get("openclose"),
                "low_n_windows": int(sum(ev["8"]["groups"][g]["low_n_windows"]
                                         for g in ev["8"]["groups"])),
                "low_n_hits": int(sum(ev["8"]["groups"][g]["low_n_hits"]
                                      for g in ev["8"]["groups"])),
                "empty_pulses": int(ev["8"]["empty_pulses"]),
            }
        i8c = {}
        for f in results["A_time"]["folds"]:
            ev8 = f["int8"]["int8_control"]["eval"]["8"]
            per = ev8["per_zone"]
            i8c[f"fold{f['test_fold']}"] = {
                "n_windows": f["int8"]["int8_control"]["n_windows"],
                "empty_desk": per.get("empty_desk"),
                "static_a": per.get("static_a"),
                "static_b": per.get("static_b"),
                "openclose": per.get("openclose"),
                "static_fp_per_min": ev8["static_fp_per_min"],
                "empty_pulses": ev8["empty_pulses"],
                "low_n_windows": int(sum(ev8["groups"][g]["low_n_windows"] for g in ev8["groups"])),
                "low_n_hits": int(sum(ev8["groups"][g]["low_n_hits"] for g in ev8["groups"])),
            }
        results["D_empty"] = {"v7_empty_zones": {z: {"low_n_windows": sum(v["low_n_windows"] for v in vs),
                                                     "low_n_hits": sum(v["low_n_hits"] for v in vs)}
                                                for z, vs in empty_zs.items()},
                              "control_7min_folds": ctrl,
                              "control_7min_int8_folds": i8c}

    # ---------------- QAT/量化汇总（取 A 的折模型已算好） ----------------
    if "q" in only and results.get("A_time"):
        agrees = [f["int8"]["agree"] for f in results["A_time"]["folds"]]
        results["Q_int8"] = {
            "A_heldout_agree": agrees, "A_heldout_agree_min": round(min(agrees), 6),
            "B_heldout_agree": (results.get("B_distance", {}).get("int8", {}).get("agree")),
            "qat_epochs": args.qat_epochs,
            "criterion_e": None,
        }
        b_agree = results["Q_int8"]["B_heldout_agree"]
        vals = list(agrees) + ([b_agree] if b_agree is not None else [])
        results["Q_int8"]["criterion_e"] = round(min(vals), 6) if vals else None
        dg = results["A_time"]["int8_decision_gate"]
        ctrl_i8 = results.get("D_empty", {}).get("control_7min_int8_folds", {})
        static_max = max((v["static_fp_per_min"] or 0) for v in ctrl_i8.values()) if ctrl_i8 else None
        empty_sum = sum((v["empty_pulses"] or 0) for v in ctrl_i8.values()) if ctrl_i8 else None
        low_n_hits = sum(v["low_n_hits"] for v in ctrl_i8.values()) if ctrl_i8 else None
        b8 = results.get("B_distance", {}).get("int8", {}).get("int8_eval", {}).get("8", {})
        results["Q_int8"]["int8_decision"] = {
            "A_time": dg,
            "B_distance": {"open_chunks": b8.get("open_chunks"),
                           "wave_pulses": b8.get("wave_pulses"),
                           "wave_pulses_per_min": b8.get("wave_pulses_per_min")},
            "D_empty": {"static_fp_per_min_max": static_max, "empty_pulses_sum": empty_sum,
                        "low_n_hits_sum": low_n_hits},
            "pass": bool(int(str(dg["open_chunks"]).split("/")[0]) >= 15
                         and (dg["wave_pulses_per_min"] or 0) <= 0.5
                         and (dg["static_fp_per_min"] or 0) <= 0.5 and dg["empty_pulses"] == 0
                         and dg["hardneg_pulses"] == 0
                         and (static_max is None or static_max <= 0.5)
                         and (empty_sum in (None, 0)) and (low_n_hits in (None, 0))),
        }

    # ---------------- 最终模型 + 部署件 ----------------
    if "final" in only:
        t0 = time.time()
        rows_tr, yb_tr = rows_train_full(d, m)
        sw_tr = sample_weights(rows_tr, m, args.wave_weight, args.hardneg_weight)
        model = train_binary(x_all[rows_tr], None if feats_all is None else feats_all[rows_tr],
                             yb_tr, sw_tr, seed=args.seed, epochs=args.epochs,
                             hn=m["hardneg"][rows_tr], hn_lam=args.hn_lambda,
                             hn_margin=args.hn_margin)
        model.v7_feat_names = list(feat_names)
        # 部署件量化：calib 用全部训练行（最多 calib_n）
        q = quantize_and_match(model, d, x_all, feats_all, rows_tr, rows_tr,
                               calib_n=args.calib_n, headroom=args.headroom, seed=args.seed,
                               qat_epochs=args.qat_epochs, wave_weight=args.wave_weight,
                               feat_names=feat_names)
        params = q["params"]
        errors = QV.check_params_v7(params)
        words = QV.write_rom_v7(out / "nn_rom_data_v7.v", params)
        (out / "nn_params_v7.json").write_text(json.dumps(params, ensure_ascii=False, indent=1),
                                               encoding="utf-8")
        torch, _ = C._torch()
        torch.save({"state_dict": model.state_dict(), "num_classes": 2,
                    "feat_names": feat_names, "arch": "v7_cnn_glob_bin",
                    "data": results["data"], "seed": args.seed,
                    "wave_weight": args.wave_weight, "feats": args.feats,
                    "in_sample_int8_agree": q["agree"]}, out / "model_v7.pt")
        results["final"] = {
            "n_train": int(len(rows_tr)), "feats": args.feats, "feat_names": feat_names,
            "in_sample_window_acc": None,
            "in_sample_int8_agree": q["agree"],
            "rom_words": params["rom_words"], "rom_sha256": sha256_file(out / "nn_rom_data_v7.v"),
            "params_sha256": sha256_file(out / "nn_params_v7.json"),
            "contract_errors": errors,
            "in_sample_eval": q["int8_eval"],
            "layout": params["layout"], "logit_scale_shared": params["logit_scale_shared"],
            "layer_summary": [{"name": l["name"], "shape": l["weight_shape"], "SH": l["SH"],
                               "A": l["A_scale"], "s_x_in": l["s_x_in"], "s_y_out": l["s_y_out"],
                               "max_abs_w_q": l["max_abs_w_q"]} for l in params["layers"]],
        }
        print(f"[v7][final] rows={len(rows_tr)} int8_agree={q['agree']:.4f} "
              f"rom_words={params['rom_words']} errors={len(errors)} ({time.time() - t0:.0f}s)", flush=True)

    results["elapsed_s"] = round(time.time() - t_start, 1)
    rp = Path(args.results)
    if not rp.is_absolute():
        rp = out / rp
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[v7] results -> {rp} ({results['elapsed_s']}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
