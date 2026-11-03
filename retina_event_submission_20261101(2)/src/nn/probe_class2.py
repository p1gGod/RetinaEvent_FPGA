#!/usr/bin/env python3
"""SEP2 探针：横向挥手(class2) vs 手部开合(class1) 可分性。

只读 dataset_v2_w100.npz：
  - 特征：4 通道 30x50 网格做 5x5 空间池化 -> 10x6x4=240 维，再 log1p；
  - 分类器：ridge 最小二乘（numpy 自带求解，无新依赖）；
  - 评估：class1 留一会话（LFO，16 折）；class2 只有 1 条会话（task-9 已允许），
    按时间后半段留出（前 50% 训练 / 后 50% 测试），逐折统计准确率与混淆矩阵；
  - 学习曲线：每折用 m 个 class1 训练窗 + class2 前半段，评估固定测试集，外推所需补录量。
输出末行 SEP2_OK=1。
"""
import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NPZ_DEFAULT = os.path.join(HERE, "dataset_v2_w100.npz")
GRID_W, GRID_H = 50, 30
POOL_R, POOL_C = 5, 5
N_BLOCKS = (GRID_H // POOL_R) * (GRID_W // POOL_C)  # 6*10=60
RIDGE_LAMBDA = 1.0
TARGET_ACC = 0.90


def pool_features(X_counts):
    """(n,4,30,50) uint16 -> (n, 240) float32，按 5x5 块求和后 log1p。"""
    X = np.asarray(X_counts, dtype=np.float32)
    n = X.shape[0]
    v = X.reshape(n, 4, GRID_H // POOL_R, POOL_R, GRID_W // POOL_C, POOL_C)
    pooled = v.sum(axis=(3, 5))  # (n,4,6,10)
    return np.log1p(pooled.reshape(n, -1))


def fit_ridge(Xtr, ytr, lam=RIDGE_LAMBDA):
    """二分类 ridge：标签 one-hot，返回 (d+1, 2) 权重（最后一行为 bias）。"""
    Xb = np.hstack([np.asarray(Xtr, np.float32),
                    np.ones((len(Xtr), 1), np.float32)])
    Y = np.zeros((len(ytr), 2), np.float32)
    Y[np.arange(len(ytr)), np.asarray(ytr, int)] = 1.0
    A = Xb.T @ Xb + lam * np.eye(Xb.shape[1], dtype=np.float32)
    W = np.linalg.solve(A, Xb.T @ Y)
    return W


def predict(W, X):
    Xb = np.hstack([np.asarray(X, np.float32),
                    np.ones((len(X), 1), np.float32)])
    return np.argmax(Xb @ W, axis=1)


def confusion(y_true, y_pred):
    """返回 2x2 混淆矩阵，行=真实(0=class1,1=class2)，列=预测。"""
    cm = np.zeros((2, 2), dtype=np.int64)
    for t, p in zip(np.asarray(y_true, int), np.asarray(y_pred, int)):
        cm[t, p] += 1
    return cm


def metrics(cm):
    total = int(cm.sum())
    acc = float(np.trace(cm) / total) if total else 0.0
    recalls = []
    for c in (0, 1):
        denom = int(cm[c].sum())
        recalls.append(float(cm[c, c] / denom) if denom else 0.0)
    return {
        "n": total,
        "acc": round(acc, 4),
        "balanced_acc": round(float(np.mean(recalls)), 4),
        "recall_class1": round(recalls[0], 4),
        "recall_class2": round(recalls[1], 4),
    }


def load_data(path):
    with np.load(path, allow_pickle=False) as z:
        X = z["X_counts"]
        y = np.asarray(z["y"]).astype(int)
        meta = {k: np.asarray(z[k]) for k in
                ("session", "t_rel_ms", "group", "source", "split", "win_ms", "stride_ms")}
    m1 = y == 1
    m2 = y == 2
    X1, X2 = X[m1], X[m2]
    sess1, sess2 = meta["session"][m1], meta["session"][m2]
    t1, t2 = meta["t_rel_ms"][m1], meta["t_rel_ms"][m2]
    wave_sessions = sorted(set(sess2.tolist()))
    n_wave_total = int(np.isin(meta["session"], wave_sessions).sum())
    board_mask = meta["source"] == "board_move"
    board_sessions = sorted(set(meta["session"][board_mask].tolist()))
    n_board = int(board_mask.sum())
    n_board_total = int(np.isin(meta["session"], board_sessions).sum()) if board_sessions else 0
    return {
        "X1": pool_features(X1), "X2": pool_features(X2),
        "session1": sess1, "session2": sess2,
        "t1": t1, "t2": t2,
        "group1": meta["group"][m1], "group2": meta["group"][m2],
        "win_ms": int(meta["win_ms"][0]), "stride_ms": int(meta["stride_ms"][0]),
        "n1": int(m1.sum()), "n2": int(m2.sum()),
        "n_wave_total": n_wave_total, "n_board": n_board, "n_board_total": n_board_total,
    }


def class2_time_split(t2):
    """class2 单会话：按时间中位数分前半/后半（避免同一时刻窗跨两侧）。"""
    cut = int(np.median(t2))
    train = np.where(t2 < cut)[0]
    test = np.where(t2 >= cut)[0]
    return train, test, cut


def lfo_eval(data):
    """class1 留一会话 + class2 时间后半段留出；逐折训练/评估。"""
    X1, X2 = data["X1"], data["X2"]
    sess1 = data["session1"]
    t2 = data["t2"]
    c2_tr, c2_te, cut = class2_time_split(t2)
    folds = []
    y_true, y_pred = [], []
    for name in sorted(set(sess1.tolist())):
        held = np.where(sess1 == name)[0]
        keep = np.where(sess1 != name)[0]
        Xtr = np.vstack([X1[keep], X2[c2_tr]])
        ytr = np.concatenate([np.zeros(len(keep), int), np.ones(len(c2_tr), int)])
        Xte = np.vstack([X1[held], X2[c2_te]])
        yte = np.concatenate([np.zeros(len(held), int), np.ones(len(c2_te), int)])
        W = fit_ridge(Xtr, ytr)
        pred = predict(W, Xte)
        cm = confusion(yte, pred)
        rows = {
            "held_session": str(name),
            "n_class1_test": int(len(held)),
            "class1_acc": round(float((pred[:len(held)] == 0).mean()), 4),
            "class2_test_acc": round(float((pred[len(held):] == 1).mean()), 4),
            "cm": cm.tolist(),
        }
        folds.append(rows)
        y_true.extend(yte.tolist())
        y_pred.extend(pred.tolist())
    cm_total = confusion(y_true, y_pred)
    return folds, cm_total, metrics(cm_total), (c2_tr, c2_te, cut)


def learning_curve(data, folds_names, c2_tr, c2_te, sizes):
    """每折 class1 固定用「除留出会话外的全部窗口」，class2 只用 m2 个前半段窗，
    评估固定测试集；同时报告 class2 召回（挑数据量的关键指标）。"""
    X1, X2 = data["X1"], data["X2"]
    sess1 = data["session1"]
    rng = np.random.default_rng(20261029)
    out = []
    for m in sizes:
        mm = min(int(m), len(c2_tr))
        if mm < 2:
            continue
        accs, rec2 = [], []
        for name in folds_names:
            held = np.where(sess1 == name)[0]
            keep = np.where(sess1 != name)[0]
            pick = rng.choice(c2_tr, size=mm, replace=False)
            Xtr = np.vstack([X1[keep], X2[pick]])
            ytr = np.concatenate([np.zeros(len(keep), int), np.ones(mm, int)])
            Xte = np.vstack([X1[held], X2[c2_te]])
            yte = np.concatenate([np.zeros(len(held), int), np.ones(len(c2_te), int)])
            W = fit_ridge(Xtr, ytr)
            pred = predict(W, Xte)
            accs.append(float((pred == yte).mean()))
            rec2.append(float((pred[len(held):] == 1).mean()))
        out.append({"m_class2": int(mm), "mean_acc": round(float(np.mean(accs)), 4),
                    "mean_recall_class2": round(float(np.mean(rec2)), 4),
                    "std_acc": round(float(np.std(accs)), 4)})
    return out


def extrapolate(curve, target=TARGET_ACC, tail=4):
    """只拟合曲线尾部（tail 个点）的 class2 召回 ~ log(m2)：前面的快速上升会把斜率
    拉大、导致「再加几个窗就够」的假外推；尾部才代表饱和区。"""
    tail = curve[-tail:] if len(curve) >= tail else curve
    ms = np.array([c["m_class2"] for c in tail], float)
    accs = np.array([c["mean_recall_class2"] for c in tail], float)
    if len(ms) < 2:
        return {"reachable": False, "reason": "学习曲线点不足"}
    x = np.log(ms)
    slope, intercept = np.polyfit(x, accs, 1)
    x_need = (target - intercept) / slope
    m_need = float(np.exp(x_need))
    return {
        "reachable": bool(slope > 0 and m_need <= 4 * ms.max()),
        "tail_m": [int(v) for v in ms],
        "tail_recall": [round(float(v), 4) for v in accs],
        "slope_per_log_tail": round(float(slope), 4),
        "max_recall_observed": round(float(accs.max()), 4),
        "pred_m_class2": int(round(m_need)) if np.isfinite(m_need) and m_need < 1e9 else None,
        "cap_4x_max": bool(m_need > 4 * ms.max()),
        "note": "尾部拟合；m 为 class2 前半段重叠窗数，补录量按同等覆盖率折算录制秒数",
    }


def effect_size(data):
    X1, X2 = data["X1"], data["X2"]
    mu1, mu2 = X1.mean(axis=0), X2.mean(axis=0)
    s1, s2 = X1.std(axis=0), X2.std(axis=0)
    pooled = np.sqrt((s1 ** 2 + s2 ** 2) / 2.0) + 1e-6
    d = (mu2 - mu1) / pooled
    return {
        "mean_abs_cohen_d": round(float(np.abs(d).mean()), 4),
        "median_abs_cohen_d": round(float(np.median(np.abs(d))), 4),
        "max_abs_cohen_d": round(float(np.abs(d).max()), 4),
    }



def fit_ridge_multi(Xtr, ytr, n_classes=3, lam=RIDGE_LAMBDA):
    Xb = np.hstack([np.asarray(Xtr, np.float32),
                    np.ones((len(Xtr), 1), np.float32)])
    Y = np.zeros((len(ytr), n_classes), np.float32)
    Y[np.arange(len(ytr)), np.asarray(ytr, int)] = 1.0
    A = Xb.T @ Xb + lam * np.eye(Xb.shape[1], dtype=np.float32)
    return np.linalg.solve(A, Xb.T @ Y)


def predict_multi(W, X):
    Xb = np.hstack([np.asarray(X, np.float32),
                    np.ones((len(X), 1), np.float32)])
    return np.argmax(Xb @ W, axis=1)


def metrics_multi(y_true, y_pred, n_classes=3):
    y_true = np.asarray(y_true, int)
    y_pred = np.asarray(y_pred, int)
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    for t, p in zip(y_true, y_pred):
        cm[t, p] += 1
    recalls = {}
    for c in range(n_classes):
        denom = int(cm[c].sum())
        recalls[c] = float(cm[c, c] / denom) if denom else None
    present = [c for c in range(n_classes) if recalls[c] is not None]
    return {
        "n": int(cm.sum()),
        "acc": round(float(np.trace(cm) / cm.sum()), 4) if cm.sum() else 0.0,
        "balanced_acc": round(float(np.mean([recalls[c] for c in present])), 4) if present else 0.0,
        "recalls": {c: (round(recalls[c], 4) if recalls[c] is not None else None) for c in range(n_classes)},
        "present": present,
        "cm": cm.tolist(),
    }


def load_data_multi(path):
    with np.load(path, allow_pickle=False) as z:
        X = pool_features(z["X_counts"])
        y = np.asarray(z["y"]).astype(int)
        meta = {k: np.asarray(z[k]) for k in
                ("session", "split", "source", "group", "t_rel_ms", "win_ms", "stride_ms")}
        n_wave_total = int(np.isin(meta["session"], sorted(set(meta["session"][y == 2].tolist()))).sum())
    meta.update({"X": X, "y": y, "n_wave_total": n_wave_total})
    return meta


def loo3_eval(data, n_classes=3):
    """class2 留一会话 3 折；class1 各会话同口径 LFO 作对照。"""
    X, y = data["X"], data["y"]
    sess, split = data["session"], data["split"]
    wave_sessions = sorted(set(sess[y == 2].tolist()))
    class1_sessions = sorted(set(sess[y == 1].tolist()))
    c2_folds = []
    for held in wave_sessions:
        train = (split == "train") & (sess != held)
        test = (split == "test") | (sess == held)
        idx_te = np.where(test)[0]
        W = fit_ridge_multi(X[train], y[train], n_classes)
        pred = predict_multi(W, X[test])
        m = metrics_multi(y[test], pred, n_classes)
        held_mask = (sess[idx_te] == held) & (y[idx_te] == 2)
        held_pred = pred[held_mask]
        c2_folds.append({
            "held_session": str(held),
            "n_train_class2": int(((y == 2) & train).sum()),
            "held_class2_windows": int(held_mask.sum()),
            "recall_class2_held": round(float((held_pred == 2).mean()), 4) if held_mask.any() else 0.0,
            "balanced_acc": m["balanced_acc"],
            "recalls_all": m["recalls"],
            "cm": m["cm"],
            "n_test": m["n"],
        })
    c1_folds = []
    for held in class1_sessions:
        train = (split == "train") & (sess != held)
        test = (split == "test") | (sess == held)
        idx_te = np.where(test)[0]
        W = fit_ridge_multi(X[train], y[train], n_classes)
        pred = predict_multi(W, X[test])
        m = metrics_multi(y[test], pred, n_classes)
        held_mask = (sess[idx_te] == held) & (y[idx_te] == 1)
        c1_folds.append({
            "held_session": str(held),
            "held_class1_windows": int(held_mask.sum()),
            "recall_class1_held": round(float((pred[held_mask] == 1).mean()), 4) if held_mask.any() else 0.0,
            "balanced_acc": m["balanced_acc"],
            "n_test": m["n"],
        })
    return wave_sessions, class1_sessions, c2_folds, c1_folds


def loo3_one_session(data, n_classes=3):
    """诊断：class2 只用 1 条训练会话（其余训练窗照旧），评估留出会话；用于估计会话数缩放趋势。"""
    X, y = data["X"], data["y"]
    sess, split = data["session"], data["split"]
    wave_sessions = sorted(set(sess[y == 2].tolist()))
    folds = []
    for held in wave_sessions:
        for src in wave_sessions:
            if src == held:
                continue
            train = (split == "train") & (sess != held) & ((y != 2) | (sess == src))
            test = (split == "test") | (sess == held)
            idx_te = np.where(test)[0]
            W = fit_ridge_multi(X[train], y[train], n_classes)
            pred = predict_multi(W, X[test])
            held_mask = (sess[idx_te] == held) & (y[idx_te] == 2)
            folds.append({
                "held_session": str(held),
                "train_session": str(src),
                "held_class2_windows": int(held_mask.sum()),
                "recall_class2_held": round(float((pred[held_mask] == 2).mean()), 4) if held_mask.any() else 0.0,
            })
    return folds


def _mean_std(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None, None
    return round(float(np.mean(vals)), 4), round(float(np.std(vals)), 4)


def loo3_main(npz_path):
    data = load_data_multi(npz_path)
    y = data["y"]
    if int((y == 2).sum()) == 0:
        print("[FATAL] 无 class2 窗口", file=sys.stderr)
        print("SEP3_OK=0")
        return 1
    wave_sessions, class1_sessions, c2_folds, c1_folds = loo3_eval(data)
    print(f"[probe3] npz={npz_path}")
    print(f"[probe3] windows={len(y)} class1={int((y == 1).sum())} class2={int((y == 2).sum())}"
          f" class0={int((y == 0).sum())}")
    print(f"[probe3] class2 会话数={len(wave_sessions)}: {wave_sessions}")
    print(f"[probe3] class1 会话数={len(class1_sessions)}")
    print("[probe3] ==== class2 留一会话 3 折（训练=全部 train 且去掉该会话；测试=该会话全部窗 + 固定 test 会话） ====")
    for f in c2_folds:
        print(f"  - held={f['held_session']} 训练class2窗={f['n_train_class2']}"
              f" 测试class2窗={f['held_class2_windows']} recall_class2={f['recall_class2_held']}"
              f" balanced_acc={f['balanced_acc']} recalls={f['recalls_all']} n_test={f['n_test']}")
        print(f"    cm(行=真实0/1/2,列=预测)={f['cm']}")
    c2_rec = [f["recall_class2_held"] for f in c2_folds]
    c2_bal = [f["balanced_acc"] for f in c2_folds]
    rec_mean, rec_std = _mean_std(c2_rec)
    bal_mean, bal_std = _mean_std(c2_bal)
    print(f"[probe3] class2 LOO 汇总: recall={rec_mean}±{rec_std} balanced_acc={bal_mean}±{bal_std}"
          f"（{len(c2_folds)} 折，范围 recall {min(c2_rec):.4f}~{max(c2_rec):.4f}）")
    one_folds = loo3_one_session(data, 3)
    r1 = float(np.mean([f["recall_class2_held"] for f in one_folds])) if one_folds else None
    print(f"[probe3] 会话数缩放（诊断）：只给 1 条 class2 训练会话 recall={r1}（{len(one_folds)} 折），"
          f"给 2 条（LOO）recall={rec_mean}")
    if r1 is not None:
        delta = (rec_mean - r1) if rec_mean is not None else None
        if delta and delta > 0:
            import math
            need_sess = 2.0 * (2.0 ** ((0.85 - rec_mean) / delta))
            print(f"[probe3] 会话数外推：每次训练会话翻倍 recall 提升 {delta:.4f}；"
                  f"按此线性于 log2(会话数) 外推到 0.85 需约 {need_sess:.1f} 条 class2 训练会话"
                  f"（当前 {len(wave_sessions)} 条）")
        else:
            need_sess = None
            print("[probe3] 会话数外推：增加训练会话未见可靠 recall 提升（或方向为负），"
                  "无法按会话数外推到 0.85")
    print("[probe3] ==== class1 各会话 LFO 对照（同口径：留出会话 + 固定 test；其余 train） ====")
    for f in c1_folds:
        print(f"  - held={f['held_session']} 测试class1窗={f['held_class1_windows']}"
              f" recall_class1={f['recall_class1_held']} balanced_acc={f['balanced_acc']} n_test={f['n_test']}")
    c1_rec = [f["recall_class1_held"] for f in c1_folds]
    c1_bal = [f["balanced_acc"] for f in c1_folds]
    r1m, r1s = _mean_std(c1_rec)
    b1m, b1s = _mean_std(c1_bal)
    print(f"[probe3] class1 LFO 汇总: recall={r1m}±{r1s} balanced_acc={b1m}±{b1s}")
    # 补录量化：沿用 v2 尾部学习曲线斜率（recall ~ slope*log(m_class2)），按跨会话观测谨慎外推
    V2_SLOPE = 0.0477
    train_c2 = float(np.mean([f["n_train_class2"] for f in c2_folds]))
    per_session = len(data["y"][y == 2]) / max(1, len(wave_sessions))
    print(f"[probe3] 基线: 每折平均训练 class2 窗={train_c2:.1f}，每条 class2 会话平均窗={per_session:.1f}")
    if rec_mean is None:
        print("SEP3_OK=0")
        return 1
    if rec_mean >= 0.85:
        verdict = "跨会话 class2 recall >= 0.85，建议直接开训 M2（仍需在正式报告中声明 3 会话/205 窗的置信度边界）"
        need_sessions = 0
        need_windows = 0
    elif rec_mean >= 0.70:
        verdict = "跨会话 class2 recall 落在 0.70~0.85，建议再补 2~3 段（每段独立会话/角度）后重跑 SEP3 再决定开训"
        mult = float(np.exp((0.85 - rec_mean) / V2_SLOPE))
        need_windows = int(round(train_c2 * mult - train_c2))
        need_sessions = int(np.ceil(need_windows / per_session))
    else:
        verdict = "跨会话 class2 recall < 0.70，仅加数据不够，需先改采集条件（手完整入画/距离≥0.3m/背景与角度多样化/控制挥速）再补采"
        mult = float(np.exp((0.85 - rec_mean) / V2_SLOPE))
        need_windows = int(round(train_c2 * mult - train_c2))
        need_sessions = int(np.ceil(need_windows / per_session))
    print(f"[probe3] 结论: {verdict}")
    print(f"[probe3] 补齐到 recall>=0.85 估计: 在当前 {len(wave_sessions)} 条会话/{int((y == 2).sum())} 窗基础上"
          f" 再补约 {need_windows} 个 class2 重叠窗 ≈ {need_sessions} 条独立会话"
          f"（按 v2 尾部斜率 {V2_SLOPE}/log 外推；跨会话可能更乐观，作下限参考）")
    if rec_mean < 0.70:
        print("[probe3] 注意：该线性外推仅在「同会话时间切分」曲线上拟合过，本次跨会话基线远低于同会话口径"
              f"（v2 SEP2 recall=0.8297 vs 本次 LOO recall={rec_mean}），外推数字不可作为补录预算；"
              "跨会话差距主要是特征/会话偏移问题，应优先改特征与采集协议，再谈数据量。")
    ok = len(c2_folds) == 3 and len(wave_sessions) == 3
    print(f"SEP3_OK={1 if ok else 0}")
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="class2 vs class1 可分性探针")
    ap.add_argument("--npz", default=NPZ_DEFAULT)
    ap.add_argument("--target-acc", type=float, default=TARGET_ACC)
    ap.add_argument("--mode", choices=("sep2", "loo3"), default="sep2",
                    help="sep2=单会话时间后半段（v2）；loo3=class2 留一会话 3 折（v3）")
    args = ap.parse_args(argv)
    if args.mode == "loo3":
        return loo3_main(args.npz)
    if not os.path.exists(args.npz):
        print(f"[FATAL] 找不到 {args.npz}，先跑 build_dataset_v2.py", file=sys.stderr)
        return 2
    data = load_data(args.npz)
    print(f"[probe] npz={args.npz}")
    print(f"[probe] class1 windows={data['n1']} sessions={len(set(data['session1'].tolist()))}"
          f" | class2 windows={data['n2']} sessions={len(set(data['session2'].tolist()))}")
    if data["n1"] == 0 or data["n2"] == 0:
        print("[FATAL] class1 或 class2 无窗口；请检查标签", file=sys.stderr)
        return 2
    print(f"[probe] class2 time-half: cut_t={class2_time_split(data['t2'])[2]}ms"
          f" train={len(class2_time_split(data['t2'])[0])} test={len(class2_time_split(data['t2'])[1])}"
          "（单会话，统计意义弱；已按 task-9 允许的时间后半段留出）")
    print(f"[probe] class1 分组: { {g: int((data['group1'] == g).sum()) for g in sorted(set(data['group1'].tolist()))} }")
    print(f"[probe] class2 分组: { {g: int((data['group2'] == g).sum()) for g in sorted(set(data['group2'].tolist()))} }")
    folds, cm_total, m, (c2_tr, c2_te, cut) = lfo_eval(data)
    print("[probe] LFO 逐折（class1 留一会话 + class2 时间后半段固定测试）：")
    for f in folds:
        print(f"  - held={f['held_session']} class1_test={f['n_class1_test']}"
              f" class1_acc={f['class1_acc']} class2_acc={f['class2_test_acc']}")
    print(f"[probe] 汇总混淆矩阵 [[TN,FN],[FP,TP]] = {cm_total.tolist()}")
    print(f"[probe] 汇总指标: {m}")
    print(f"[probe] 特征效应量: {effect_size(data)}")
    sizes = [m for m in (4, 8, 12, 16, 20, 24, 28) if m <= len(c2_tr)]
    sizes = sorted(set(sizes))
    curve = learning_curve(data, sorted(set(data["session1"].tolist())), c2_tr, c2_te, sizes)
    print("[probe] 学习曲线（class2 前半段训练窗数 m2 -> 固定测试集准确率 / class2 召回）：")
    for c in curve:
        print(f"  - m2={c['m_class2']} acc={c['mean_acc']}±{c['std_acc']}"
              f" recall_class2={c['mean_recall_class2']}")
    ext = extrapolate(curve, args.target_acc)
    print(f"[probe] 外推 class2 召回 target={args.target_acc}: {ext}")
    win_ms = data["win_ms"]
    stride_ms = data["stride_ms"]
    coverage_frac = data["n2"] / max(1, data["n_wave_total"])
    board_frac = data["n_board"] / max(1, data["n_board_total"])
    print(f"[probe] class2 标注覆盖率={coverage_frac:.3f}"
          f"（class2 窗 {data['n2']} / 该会话总窗 {data['n_wave_total']}）")
    print(f"[probe] 板移噪声覆盖率={board_frac:.3f}"
          f"（板移窗 {data['n_board']} / 该会话总窗 {data['n_board_total']}）")
    print(f"[probe] WIN_MS={win_ms} STRIDE_MS={stride_ms}")
    session_win = data["n_wave_total"]
    record_s = session_win * stride_ms / 1000.0
    if ext.get("reachable"):
        m_need = ext["pred_m_class2"]
        non_ol = int(round(m_need * stride_ms / win_ms))
        rec_s = non_ol * win_ms / 1000.0 / max(coverage_frac, 1e-6)
        extra = max(0.0, rec_s - record_s)
        print(f"[probe] 补录估算：class2 需约 {m_need} 个训练重叠窗 = {non_ol} 个非重叠窗"
              f" ≈ {rec_s:.1f}s 录制（当前 {record_s:.1f}s，额外 {extra:.1f}s"
              f" ≈ {max(1, int(np.ceil(extra / 5.0)))} 段×5s）")
    else:
        print("[probe] 补录估算：学习曲线未显示 class2 召回可达 90%（大概率数据量不是唯一瓶颈），"
              "仅按 v1「每类 500 非重叠窗」口径给下限：")
        print(f"        class2 目标 500 非重叠窗 ≈ 50s 覆盖 / {coverage_frac:.3f} ="
              f" {50.0 / max(coverage_frac, 1e-6):.1f}s 录制（额外"
              f" {max(0.0, 50.0 / max(coverage_frac, 1e-6) - record_s):.1f}s）")
    # 板移硬负样本：当前 95 重叠窗 / 48 非重叠；建议至少 150 非重叠窗（3 倍）
    board_non_ol = int(round(data["n_board"] * stride_ms / win_ms))
    board_need = 150
    board_rec = board_need * win_ms / 1000.0 / max(board_frac, 1e-6)
    board_now = data["n_board_total"] * stride_ms / 1000.0
    print(f"[probe] 噪声(板移)估算：当前 {data['n_board']} 重叠窗≈{board_non_ol} 非重叠；"
          f"目标 {board_need} 非重叠窗 ≈ {board_rec:.1f}s 录制（当前 {board_now:.1f}s，额外"
          f" {max(0.0, board_rec - board_now):.1f}s"
          f" ≈ {max(1, int(np.ceil(max(0.0, board_rec - board_now) / 5.0)))} 段×5s）")
    # 明确结论：class2 现有 29 个非重叠窗；给出 3 档补录方案（按同样 0.604 覆盖率折算）
    print("[probe] ==== 还需补录（class2 横向挥手） ====")
    for target_non_ol in (150, 300, 500):
        need_s = target_non_ol * win_ms / 1000.0 / max(coverage_frac, 1e-6)
        extra = max(0.0, need_s - record_s)
        print(f"  - 目标 {target_non_ol} 非重叠窗：需录制 {need_s:.1f}s（额外 {extra:.1f}s"
              f" ≈ {max(1, int(np.ceil(extra / 5.0)))} 段×5s；建议跨 >=3 个独立会话/角度）")
    print("[probe] ==== 还需补录（class0 板移硬负样本） ====")
    print(f"  - 目标 {board_need} 非重叠窗：额外 {max(0.0, board_rec - board_now):.1f}s"
          f" ≈ {max(1, int(np.ceil(max(0.0, board_rec - board_now) / 5.0)))} 段×5s"
          "（板移噪声易与挥手的满屏运动混淆，建议至少 3 段独立位移）")
    if not ext.get("reachable"):
        print("[probe] 结论：class2 召回在尾部饱和（见 max_recall_observed），仅增加同一会话的窗口"
              "收益递减；要冲 90% 召回需同时改采集多样性（距离/角度/背景/挥手相位），"
              "并至少补 2 条独立会话用于会话级验证。")
    print("SEP2_OK=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
