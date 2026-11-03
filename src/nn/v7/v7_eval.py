#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v7 评估工具：按 zone 序列回放决策状态机，输出脉冲级 + 窗级指标。

口径（与 task-36/38 保持一致）：
  - 每 100ms 一次决策（窗 stride 50ms，故 step=2）；
  - N_CONSEC=3 连续同类命中 -> 1 个 pulse；pulse 后 1.5s 不应期；
  - class1 命中 = argmax==1 且 margin(l1-l0) >= MARGIN_MIN；
  - 开合召回 = 每个开合 zone 内按 5s 块（从 zone 首窗算）统计，块内 >=1 pulse 即检出；
  - 静默误触/分 = 静默 zone pulse 总数 / 静默分钟数（非 210307 静默窗）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402

WIN_MS = 100
STRIDE_MS = 50  # 窗中心间距：决策间隔 = step * STRIDE_MS
DT_CYC = 5_000_000
REFRACTORY_CYC = 75_000_000
ONLINE_MARGIN_MIN = 8
ONLINE_N_CONSEC = 3
GUARD_DEC = 5  # lead m01607：zone 首尾各 0.5s（5 个 100ms 决策点）不计 pulse
OPEN_CHUNK_MS = 5_000

OPEN_ZONES = ("open_L", "open_L_near", "open_L_far", "openclose")
WAVE_ZONES = ("wave_L", "wave_L_far", "wave")
STATIC_ZONES = ("static_a", "static_b", "still_B")
EMPTY_ZONES = ("empty_A", "empty_A2", "empty_desk")
HARDNEG_ZONES = ("typing", "cup_paper", "gap_away")
EXCLUDE_ZONES = ("absent", "reposition", "end")

ZONE_GROUP = {}
for _z in OPEN_ZONES:
    ZONE_GROUP[_z] = "open"
for _z in WAVE_ZONES:
    ZONE_GROUP[_z] = "wave"
for _z in STATIC_ZONES:
    ZONE_GROUP[_z] = "static"
for _z in EMPTY_ZONES:
    ZONE_GROUP[_z] = "empty"
for _z in HARDNEG_ZONES:
    ZONE_GROUP[_z] = "hardneg"
for _z in EXCLUDE_ZONES:
    ZONE_GROUP[_z] = "exclude"


def load(path) -> dict:
    d = np.load(path, allow_pickle=False)
    return {k: d[k] for k in d.files}


def masks(d: dict) -> dict:
    role = d["role"].astype(str)
    hint = d["hint"].astype(str)
    y = d["y"].astype(np.int64)
    aug = d["aug"].astype(np.int64)
    fold = d["fold"].astype(np.int64)
    primary = role == "v7_primary"
    hardneg = role == "v7_hardneg"
    # 注意：npz 里 hint 是 <U10，字符串被截断（control_ne/control_po），必须 startswith
    control_neg = (role == "control_7min") & np.char.startswith(hint, "control_ne")
    control_pos = (role == "control_7min") & np.char.startswith(hint, "control_po")
    assert int(control_neg.sum()) > 0, "control_neg mask empty (hint truncation?)"
    m = {
        "primary": primary,
        "hardneg": hardneg,
        "control_neg": control_neg,
        "control_pos": control_pos,
        "pos": primary & (y == 1),
        "wave": primary & (y == 2),
        "neg": (primary & (y == 0)) | hardneg | control_neg,
        "y": y,
        "aug": aug,
        "fold": fold,
        "y_bin": np.where(y == 1, 1, 0).astype(np.int64),
        "wave_weight_row": np.where(primary & (y == 2), 1.0, 0.0).astype(np.float32),
        "w": d["win_idx"].astype(np.int64),
        "n_ev": d["g"][:, C.GIDX["n"]].astype(np.int64),
    }
    m["pos_aug0"] = m["pos"] & (aug == 0)
    m["pos_aug1"] = m["pos"] & (aug == 1)
    m["wave_aug0"] = m["wave"] & (aug == 0)
    m["wave_aug1"] = m["wave"] & (aug == 1)
    return m


def train_set(d, m, fold=None, aug_pos=None, near_only=False, neg_roles=("primary", "hardneg", "control_neg")):
    """返回二元训练行号 + 标签 + 样本权重。

    fold: None=全部 fold；否则 fold==该值。
    aug_pos: None=原始与镜像正样本都用；0/1=只用该 aug 的正样本。
    near_only: True 时正样本只用近距开合（open_L_near）与近距挥手（wave_L），远距 zone 不参与训练。
    """
    sel = np.zeros(len(m["y"]), dtype=bool)
    pos = m["pos"].copy()
    if aug_pos is not None:
        pos &= (m["aug"] == aug_pos)
    if near_only:
        zone = d["zone"].astype(str)
        pos &= np.isin(zone, ("open_L_near", "wave_L"))
    if fold is not None:
        pos &= (m["fold"] == fold)
    sel |= pos
    neg = np.zeros(len(m["y"]), dtype=bool)
    for r in neg_roles:
        neg |= m[r]
    if fold is not None:
        neg &= (m["fold"] == fold)
    sel |= neg
    rows = np.where(sel)[0]
    yb = np.where(m["y"][rows] == 1, 1, 0).astype(np.int64)
    return rows, yb


def sample_weights(rows, y, wave_mask, wave_weight=3.0):
    sw = np.ones(len(rows), dtype=np.float32)
    sw[wave_mask[rows]] = wave_weight
    return sw


def zone_sequences(d, rows):
    """按 (zone, session, aug) 分组，组内按 win_idx 排序。返回 {key: row_index_array}。"""
    zone = d["zone"].astype(str)
    session = d["session"].astype(str)
    aug = d["aug"].astype(np.int64)
    w = d["win_idx"].astype(np.int64)
    out = {}
    keys = np.array([f"{zone[i]}|{session[i]}|{aug[i]}" for i in range(len(d["y"]))], dtype=object)
    for key in np.unique(keys[rows]):
        sel = rows[keys[rows] == key]
        out[key] = sel[np.argsort(w[sel])]
    return out


def _chunks(center_dec, base_center):
    return ((center_dec - base_center) // OPEN_CHUNK_MS).astype(np.int64)


def eval_rows(d, rows, pred, c1, margin_min=ONLINE_MARGIN_MIN, n_consec=ONLINE_N_CONSEC,
              step=2, offset=0):
    """rows 为待评估行（已对齐 pred/c1 全数组），返回 (summary, per_zone, pulses)。"""
    per_zone = {}
    pulses_all = []
    t_ms = d["t_ms"].astype(np.int64)
    center_ms = d["center_ms"].astype(np.int64)
    rows = np.asarray(rows)
    for key, ridx in zone_sequences(d, rows).items():
        zname, session, aug = key.split("|")
        dec = np.arange(offset, len(ridx), step)
        rid = ridx[dec]
        t0 = t_ms[rid]
        ctr = center_ms[rid]
        # pred/c1 与 rows 对齐（不是全 14447 长数组）：用 rows 内局部位置取
        loc = np.searchsorted(rows, rid)
        p = pred[loc]
        sc = c1[loc]
        hit = (p == 1) & (sc >= margin_min)
        # 守卫带：zone 首尾各 GUARD_DEC 个决策点内的命中不参与 pulse 成链（统一对所有 zone）
        hit_g = hit.copy()
        if len(hit_g) > 2 * GUARD_DEC:
            hit_g[:GUARD_DEC] = False
            hit_g[-GUARD_DEC:] = False
        pulses = C.replay_pulses(t0, hit_g, sc, p, n_consec=n_consec)
        pulses_ng = C.replay_pulses(t0, hit, sc, p, n_consec=n_consec)
        for pp in pulses + pulses_ng:
            pp["zone"] = zname
            pp["session"] = session
        pulses_all.extend(pulses)
        base = center_ms[ridx[0]]
        ch = _chunks(ctr, base)
        total_chunks = len(np.unique(ch))
        det_chunks = len(np.unique(ch[[pp["j"] for pp in pulses]])) if pulses else 0
        det_chunks_ng = len(np.unique(ch[[pp["j"] for pp in pulses_ng]])) if pulses_ng else 0
        n_dec = len(rid)
        n_win = len(ridx)
        # 决策事件率的分母 = 决策点覆盖的墙钟（lead m01486：n_decisions × 决策间隔）
        cadence_ms = step * STRIDE_MS
        minutes = n_dec * cadence_ms / 60000.0
        minutes_old = n_win * WIN_MS / 60000.0  # 旧约定，仅报告对照
        hit_w = int(hit.sum())
        arg1 = int((p == 1).sum())
        n_ev = d["g"][rid, C.GIDX["n"]].astype(np.int64)
        low_n = int((n_ev < 50).sum())
        hit_low_n = int((hit & (n_ev < 50)).sum())
        per_zone[zname] = {
            "n_windows": int(n_win),
            "n_decisions": int(n_dec),
            "decision_cadence_ms": int(cadence_ms),
            "minutes": round(float(minutes), 4),
            "minutes_old": round(float(minutes_old), 4),
            "pulses": int(len(pulses)),
            "pulses_per_min": round(len(pulses) / minutes, 3) if minutes > 0 else None,
            "pulses_no_guard": int(len(pulses_ng)),
            "pulses_per_min_no_guard": round(len(pulses_ng) / minutes, 3) if minutes > 0 else None,
            "open_chunks_detected_no_guard": int(det_chunks_ng),
            "class1_argmax": arg1,
            "class1_argmax_ratio": round(arg1 / max(n_dec, 1), 4),
            "class1_hit": hit_w,
            "class1_hit_ratio": round(hit_w / max(n_dec, 1), 4),
            "mean_c1": round(float(sc.mean()), 3) if n_dec else None,
            "open_chunks_total": int(total_chunks),
            "open_chunks_detected": int(det_chunks),
            "low_n_windows": int(low_n),
            "low_n_hits": hit_low_n,
            "aug": int(aug),
            "session": session,
        }
    # 分组汇总
    groups = {}
    for gname in ("open", "wave", "static", "empty", "hardneg", "exclude"):
        zs = [v for k, v in per_zone.items() if ZONE_GROUP.get(k, "exclude") == gname]
        if not zs:
            continue
        pulses = sum(z["pulses"] for z in zs)
        pulses_ng = sum(z["pulses_no_guard"] for z in zs)
        minutes = sum(z["minutes"] for z in zs)
        minutes_old = sum(z["minutes_old"] for z in zs)
        n_win = sum(z["n_windows"] for z in zs)
        n_dec = sum(z["n_decisions"] for z in zs)
        hits = sum(z["class1_hit"] for z in zs)
        arg1 = sum(z["class1_argmax"] for z in zs)
        chunks_t = sum(z["open_chunks_total"] for z in zs)
        chunks_d = sum(z["open_chunks_detected"] for z in zs)
        chunks_d_ng = sum(z["open_chunks_detected_no_guard"] for z in zs)
        low_n = sum(z["low_n_windows"] for z in zs)
        low_n_hits = sum(z["low_n_hits"] for z in zs)
        groups[gname] = {
            "zones": sorted([k for k in per_zone if ZONE_GROUP.get(k, "exclude") == gname]),
            "n_windows": int(n_win),
            "n_decisions": int(n_dec),
            "decision_cadence_ms": int(step * STRIDE_MS),
            "minutes": round(float(minutes), 4),
            "minutes_old": round(float(minutes_old), 4),
            "pulses": int(pulses),
            "pulses_per_min": round(pulses / minutes, 3) if minutes > 0 else None,
            "pulses_no_guard": int(pulses_ng),
            "pulses_per_min_no_guard": round(pulses_ng / minutes, 3) if minutes > 0 else None,
            "class1_hit": int(hits),
            "class1_hit_ratio": round(hits / max(n_dec, 1), 4),
            "class1_argmax_ratio": round(arg1 / max(n_dec, 1), 4),
            "open_chunks_total": int(chunks_t),
            "open_chunks_detected": int(chunks_d),
            "open_chunk_recall": round(chunks_d / chunks_t, 4) if chunks_t else None,
            "open_chunks_detected_no_guard": int(chunks_d_ng),
            "open_chunk_recall_no_guard": round(chunks_d_ng / chunks_t, 4) if chunks_t else None,
            "low_n_windows": int(low_n),
            "low_n_hits": int(low_n_hits),
        }
    open_g = groups.get("open", {})
    wave_g = groups.get("wave", {})
    static_g = groups.get("static", {})
    empty_g = groups.get("empty", {})
    summary = {
        "n_windows": int(len(rows)),
        "margin_min": int(margin_min),
        "n_consec": int(n_consec),
        "decision_cadence_ms": int(step * STRIDE_MS),
        "minutes_definition": "n_decisions * step * STRIDE_MS (board cadence)",
        "pulses_total": int(len(pulses_all)),
        "open_recall": open_g.get("open_chunk_recall"),
        "open_chunks": f"{open_g.get('open_chunks_detected', 0)}/{open_g.get('open_chunks_total', 0)}",
        "open_pulses": open_g.get("pulses", 0),
        "wave_pulses": wave_g.get("pulses", 0),
        "wave_minutes": wave_g.get("minutes", 0.0),
        "wave_pulses_per_min": wave_g.get("pulses_per_min"),
        "wave_window_hit_ratio": wave_g.get("class1_hit_ratio"),
        "wave_window_argmax_ratio": wave_g.get("class1_argmax_ratio"),
        "static_pulses": static_g.get("pulses", 0),
        "static_minutes": static_g.get("minutes", 0.0),
        "static_fp_per_min": static_g.get("pulses_per_min"),
        "empty_pulses": empty_g.get("pulses", 0),
        "empty_minutes": empty_g.get("minutes", 0.0),
        "empty_low_n_windows": empty_g.get("low_n_windows", 0),
        "empty_low_n_hits": empty_g.get("low_n_hits", 0),
        "hardneg_pulses": groups.get("hardneg", {}).get("pulses", 0),
        "guard_decisions": int(GUARD_DEC),
        "guard_rule": "lead m01607: zone 首尾各 0.5s(5 决策) 不参与 pulse 成链；判据用 with_guard",
        "open_chunks_no_guard": f"{open_g.get('open_chunks_detected_no_guard', 0)}/{open_g.get('open_chunks_total', 0)}",
        "open_recall_no_guard": open_g.get("open_chunk_recall_no_guard"),
        "wave_pulses_no_guard": wave_g.get("pulses_no_guard", 0),
        "wave_pulses_per_min_no_guard": wave_g.get("pulses_per_min_no_guard"),
        "static_pulses_no_guard": static_g.get("pulses_no_guard", 0),
        "static_fp_per_min_no_guard": static_g.get("pulses_per_min_no_guard"),
        "empty_pulses_no_guard": empty_g.get("pulses_no_guard", 0),
        "hardneg_pulses_no_guard": groups.get("hardneg", {}).get("pulses_no_guard", 0),
        "groups": groups,
    }
    return summary, per_zone, pulses_all
