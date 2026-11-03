#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v6 表征实验公共常量 / 回放 / 统计 / 小模型。

坐标约定：events.csv 的 x,y 是 400x240 原始事件坐标（已实测 0..398 / 0..238），
窗口网格与 v4/v5 训练集一致：shift=3 -> 50x30，通道 [ON_now,OFF_now,ON_prev,OFF_prev]。
板卡节拍：窗口 100 ms，决策步 100 ms（probe_decide_sweep 的 start_offset=2, step=2），
dt_cyc=5e6（50 MHz），不应期 1.5 s，空窗清零 1.0 s。
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("RETE_ROOT") or Path(__file__).resolve().parents[2])
V6 = ROOT / "nn" / "v6"
OUT6 = ROOT / "nn" / "out_v6"

GRID_SHIFT = 3
GRID_W = 50
GRID_H = 30
N_CELLS = GRID_W * GRID_H
SAT = 127
WIN_MS = 100
STRIDE_MS = 50
DECISION_STEP = 2          # 板卡每 100 ms 决策一次
DECISION_OFFSET = 2        # probe 的 start_offset=2（与 v4 标定同相位）

CLK_HZ = 50_000_000
DT_CYC = 5_000_000         # 100 ms 决策步
REFRACTORY_CYC = 75_000_000  # 1.5 s
IDLE_CYC = 50_000_000      # 1.0 s
ONLINE_MARGIN_MIN = 8
ONLINE_N_CONSEC = 3
CONF_MAX = 31

CHANNELS = ("ON_now", "OFF_now", "ON_prev", "OFF_prev")

# (start_ms, end_ms, name, label, group)  label=255 表示 exclude（不参与训练/窗级统计）
ZONES = [
    (0, 50_000, "empty_desk", 0, "empty"),
    (50_000, 128_000, "absent", 255, "exclude"),
    (128_000, 246_000, "openclose", 1, "open"),
    (246_000, 281_000, "static_a", 0, "static"),
    (281_000, 295_000, "reposition", 255, "exclude"),
    (295_000, 328_000, "static_b", 0, "static"),
    (328_000, 421_000, "wave", 2, "wave"),
    (421_000, 10 ** 12, "end", 255, "exclude"),
]
ZONE_NAMES = [z[2] for z in ZONES]
ZONE_GROUP = [z[4] for z in ZONES]
LABELED_GROUPS = ("empty", "static", "open", "wave")
OPEN_CHUNK_MS = 5_000
WAVE_CHUNK_MS = 5_000

GLOBAL_NAMES = [
    "n", "on", "off", "cx", "cy", "sx", "sy",
    "pcx", "pcy", "dx", "dy", "speed", "dsx", "dsy",
    "bal", "frames", "prev_n",
]
GIDX = {name: i for i, name in enumerate(GLOBAL_NAMES)}


def zone_index(center_ms: float) -> int:
    for i, (t0, t1, _n, _l, _g) in enumerate(ZONES):
        if t0 <= center_ms < t1:
            return i
    return len(ZONES) - 1


def zone_label(zone_idx: int) -> int:
    return ZONES[int(zone_idx)][3]


def zone_group(zone_idx: int) -> str:
    return ZONES[int(zone_idx)][4]


def open_chunk(center_ms: float) -> int:
    """开合区间按 5 s 分块（27 段类比）。返回 -1 表示不在开合区间。"""
    if 128_000 <= center_ms < 246_000:
        return int((center_ms - 128_000) // OPEN_CHUNK_MS)
    return -1


def wave_chunk(center_ms: float) -> int:
    if 328_000 <= center_ms < 421_000:
        return int((center_ms - 328_000) // WAVE_CHUNK_MS)
    return -1


def decision_indices(n_windows: int, offset: int = DECISION_OFFSET,
                     step: int = DECISION_STEP) -> np.ndarray:
    return np.arange(offset, n_windows, step, dtype=np.int64)


# ---------------------------------------------------------------------------
# 决策状态机（与 nn/probe_decide_sweep.py replay_session 逐位一致）
# ---------------------------------------------------------------------------
def replay_pulses(t0_ms, hit, margin, cls, dt_cyc: int = DT_CYC,
                  refractory_cyc: int = REFRACTORY_CYC,
                  n_consec: int = ONLINE_N_CONSEC):
    """输入已按决策节拍下采样的数组。返回 pulse 列表（j 为决策点序号）。"""
    pulses = []
    refr = 0
    hit_cnt = 0
    last_c = 0
    n = len(hit)
    for j in range(n):
        if refr > 0:
            refr = max(0, refr - int(dt_cyc))
            hit_cnt = 0
            if refr > 0:
                continue
        if hit[j]:
            c = int(cls[j])
            cnt_new = hit_cnt + 1 if (hit_cnt != 0 and last_c == c) else 1
            if cnt_new >= n_consec:
                pulses.append({
                    "j": int(j),
                    "t0_ms": int(t0_ms[j]),
                    "center_ms": int(t0_ms[j]) + WIN_MS // 2,
                    "class_pred": c,
                    "margin": int(margin[j]),
                })
                refr = int(refractory_cyc) - 1
                hit_cnt = 0
                last_c = c
            else:
                hit_cnt = cnt_new
                last_c = c
        else:
            hit_cnt = 0
    return pulses


def count_valid_edges(t0_ms, pulses, dt_cyc: int = DT_CYC,
                      idle_cyc: int = IDLE_CYC) -> int:
    js = {p["j"] for p in pulses}
    valid = 0
    idle = 0
    edges = 0
    for j in range(len(t0_ms)):
        if j in js:
            if valid == 0:
                edges += 1
            valid = 1
            idle = 0
        else:
            idle += int(dt_cyc)
            if valid == 1 and idle >= idle_cyc:
                valid = 0
    return edges


# ---------------------------------------------------------------------------
# 指标
# ---------------------------------------------------------------------------
def zones_of(center_ms: np.ndarray) -> np.ndarray:
    """向量化 zone index。"""
    out = np.full(len(center_ms), len(ZONES) - 1, dtype=np.int64)
    for i, (t0, t1, _n, _l, _g) in enumerate(ZONES):
        out[(center_ms >= t0) & (center_ms < t1)] = i
    return out


def zone_minutes(zone_idx: np.ndarray, dt_ms: int = WIN_MS) -> dict:
    out = {}
    for i, name in enumerate(ZONE_NAMES):
        out[name] = float((zone_idx == i).sum()) * dt_ms / 60000.0
    return out


def pulse_metrics(pulses, zone_idx_dec: np.ndarray, center_dec: np.ndarray,
                  dt_ms: int = WIN_MS) -> dict:
    """按 pulse 中心时刻所在标注段统计（与 probe 的口径对齐，但这里是一段长录）。"""
    zmin = zone_minutes(zone_idx_dec, dt_ms)
    per = {}
    for i, name in enumerate(ZONE_NAMES):
        ps = [p for p in pulses if p["center_ms"] >= ZONES[i][0] and p["center_ms"] < ZONES[i][1]]
        per[name] = len(ps)
    empty_fp = per.get("empty_desk", 0)
    static_fp = per.get("static_a", 0) + per.get("static_b", 0)
    static_min = zmin.get("static_a", 0.0) + zmin.get("static_b", 0.0)
    empty_min = zmin.get("empty_desk", 0.0)
    open_min = zmin.get("openclose", 0.0)
    wave_min = zmin.get("wave", 0.0)

    chunks = {}
    for p in pulses:
        k = open_chunk(p["center_ms"])
        if k >= 0:
            chunks[k] = chunks.get(k, 0) + 1
    open_total = len({open_chunk(c) for c in center_dec if open_chunk(c) >= 0})
    open_det = sum(1 for k in chunks if chunks[k] > 0)

    return {
        "pulses_total": int(len(pulses)),
        "pulses_per_zone": per,
        "empty_fp": int(empty_fp),
        "empty_minutes": round(empty_min, 4),
        "empty_fp_per_min": (empty_fp / empty_min) if empty_min > 0 else None,
        "static_fp": int(static_fp),
        "static_minutes": round(static_min, 4),
        "static_fp_per_min": (static_fp / static_min) if static_min > 0 else None,
        "openclose_pulses": int(per.get("openclose", 0)),
        "openclose_minutes": round(open_min, 4),
        "openclose_pulses_per_min": (per.get("openclose", 0) / open_min) if open_min > 0 else None,
        "openclose_chunks_total": int(open_total),
        "openclose_chunks_detected": int(open_det),
        "openclose_chunk_recall": (open_det / open_total) if open_total else None,
        "wave_pulses": int(per.get("wave", 0)),
        "wave_minutes": round(wave_min, 4),
        "wave_pulses_per_min": (per.get("wave", 0) / wave_min) if wave_min > 0 else None,
        "excluded_pulses": int(per.get("absent", 0) + per.get("reposition", 0) + per.get("end", 0)),
        "minutes": {k: round(v, 4) for k, v in zmin.items()},
    }


def window_hit_table(pred_cls: np.ndarray, c1_score: np.ndarray,
                     zone_idx: np.ndarray, margin_min: int = ONLINE_MARGIN_MIN) -> dict:
    """窗级：每标注段内 class1 argmax 比例 / class1 hit（argmax=1 且 score>=margin）比例。"""
    out = {}
    for i, name in enumerate(ZONE_NAMES):
        m = zone_idx == i
        n = int(m.sum())
        if n == 0:
            out[name] = {"n": 0}
            continue
        pc = pred_cls[m]
        sc = c1_score[m]
        arg = pc == 1
        hit = arg & (sc >= margin_min)
        out[name] = {
            "n": n,
            "class1_argmax": int(arg.sum()),
            "class1_argmax_ratio": round(float(arg.mean()), 4),
            "class1_hit": int(hit.sum()),
            "class1_hit_ratio": round(float(hit.mean()), 4),
            "mean_c1_score": round(float(sc.mean()), 3),
            "mean_c1_score_pos": round(float(sc[arg].mean()), 3) if arg.any() else None,
            "c1_score_p50": round(float(np.percentile(sc, 50)), 3),
            "c1_score_p90": round(float(np.percentile(sc, 90)), 3),
        }
    return out


def evaluate_predictions(pred_cls: np.ndarray, c1_score: np.ndarray,
                         center: np.ndarray, zone: np.ndarray,
                         dec_idx: np.ndarray,
                         margin_min: int = ONLINE_MARGIN_MIN,
                         n_consec: int = ONLINE_N_CONSEC) -> dict:
    pc = pred_cls[dec_idx]
    sc = c1_score[dec_idx]
    t0 = (center[dec_idx] - WIN_MS // 2)
    zd = zone[dec_idx]
    cd = center[dec_idx]
    hit = (pc == 1) & (sc >= margin_min)
    pulses = replay_pulses(t0, hit, sc, pc, n_consec=n_consec)
    pm = pulse_metrics(pulses, zd, cd)
    pm["window_table"] = window_hit_table(pred_cls, c1_score, zone, margin_min)
    pm["n_decision_windows"] = int(len(dec_idx))
    return pm


# ---------------------------------------------------------------------------
# 全局标量特征（c2/c5 的标量分支）
# ---------------------------------------------------------------------------
def global_features(g: np.ndarray) -> tuple[np.ndarray, list]:
    n = g[:, GIDX["n"]]
    on = g[:, GIDX["on"]]
    off = g[:, GIDX["off"]]
    cx = g[:, GIDX["cx"]]
    cy = g[:, GIDX["cy"]]
    sx = g[:, GIDX["sx"]]
    sy = g[:, GIDX["sy"]]
    dx = g[:, GIDX["dx"]]
    dy = g[:, GIDX["dy"]]
    speed = g[:, GIDX["speed"]]
    dsx = g[:, GIDX["dsx"]]
    dsy = g[:, GIDX["dsy"]]
    frames = g[:, GIDX["frames"]]
    prev_n = g[:, GIDX["prev_n"]]
    safe_n = np.maximum(n, 1.0)
    bg = 1.0 / np.log1p(2000.0)
    feats = np.stack([
        np.log1p(n) * bg,
        np.log1p(prev_n) * bg,
        (on - off) / safe_n,
        (cx - 200.0) / 120.0,
        (cy - 120.0) / 80.0,
        sx / 40.0,
        sy / 30.0,
        dx / 40.0,
        dy / 40.0,
        speed / 40.0,
        dsx / 20.0,
        dsy / 20.0,
        np.clip(frames / 30.0, 0.0, 1.0),
    ], axis=1).astype(np.float32)
    names = ["log_n", "log_prev_n", "pol_bal", "cx", "cy", "sx", "sy",
             "dx", "dy", "speed", "dsx", "dsy", "frames"]
    return feats, names


# ---------------------------------------------------------------------------
# torch 小模型（只在训练脚本里用；延迟 import 避免 numpy-only 脚本加载 torch）
# ---------------------------------------------------------------------------
def _torch():
    import torch
    from torch import nn
    return torch, nn


def build_model(kind: str, n_in: int = 4, n_feat: int = 0, n_out: int = 3):
    """kind: c1/c3/c4 (纯 CNN)；c2/c5 = CNN + 全局标量 MLP 分支。"""
    torch, nn = _torch()

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.c1 = nn.Conv2d(n_in, 8, 3, stride=2)
            self.c2 = nn.Conv2d(8, 16, 3, stride=2)
            self.c3 = nn.Conv2d(16, 24, 3, stride=2)
            fc_in = 24 * 2 * 5
            self.has_glob = n_feat > 0
            if self.has_glob:
                self.g1 = nn.Linear(n_feat, 16)
                fc_in += 16
            self.fc = nn.Linear(fc_in, n_out)

        def forward(self, x, feat=None):
            h = torch.relu(self.c1(x))
            h = torch.relu(self.c2(h))
            h = torch.relu(self.c3(h))
            h = h.flatten(1)
            if self.has_glob:
                h = torch.cat([h, torch.relu(self.g1(feat))], dim=1)
            return self.fc(h)

    return Net()


def train_model(x, y, feat=None, seed: int = 1234, epochs: int = 30,
                batch: int = 128, lr: float = 2e-3, wd: float = 1e-4,
                n_out: int = 3, kind: str = "c1", class_weight_mode: str = "sqrt"):
    torch, nn = _torch()
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    n = len(y)
    counts = np.bincount(y, minlength=n_out).astype(np.float64)
    counts[counts == 0] = 1.0
    w = np.sqrt(n / (n_out * counts))
    w = np.clip(w, 0.5, 3.0)
    cw = torch.tensor(w, dtype=torch.float32)
    model = build_model(kind, n_in=x.shape[1], n_feat=(feat.shape[1] if feat is not None else 0), n_out=n_out)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    lossf = nn.CrossEntropyLoss(weight=cw)
    xt = torch.from_numpy(np.ascontiguousarray(x)).float()
    yt = torch.from_numpy(np.ascontiguousarray(y)).long()
    ft = torch.from_numpy(np.ascontiguousarray(feat)).float() if feat is not None else None
    for ep in range(epochs):
        perm = rng.permutation(n)
        model.train()
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            xb = xt[idx]
            yb = yt[idx]
            fb = ft[idx] if ft is not None else None
            opt.zero_grad()
            out = model(xb, fb) if fb is not None else model(xb)
            loss = lossf(out, yb)
            loss.backward()
            opt.step()
        sched.step()
    model.eval()
    return model


def predict_model(model, x, feat=None, batch: int = 512):
    torch, _nn = _torch()
    xs = torch.from_numpy(np.ascontiguousarray(x)).float()
    fs = torch.from_numpy(np.ascontiguousarray(feat)).float() if feat is not None else None
    outs = []
    with torch.no_grad():
        for i in range(0, len(xs), batch):
            xb = xs[i:i + batch]
            fb = fs[i:i + batch] if fs is not None else None
            out = model(xb, fb) if fb is not None else model(xb)
            outs.append(out.cpu().numpy())
    logits = np.concatenate(outs, axis=0)
    pred = logits.argmax(axis=1).astype(np.int64)
    srt = np.sort(logits, axis=1)
    margin = (srt[:, -1] - srt[:, -2]).astype(np.float32)
    # class1 score: 三分类下的 margin（l1 - max(l0,l2)）；二分类等价 |l1-l0| 的符号版
    c1 = logits[:, 1] - np.max(np.concatenate([logits[:, :1], logits[:, 2:]], axis=1), axis=1) \
        if logits.shape[1] >= 3 else logits[:, 1] - logits[:, 0]
    return pred, margin.astype(np.float32), c1.astype(np.float32), logits


def write_json(path: Path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def fmt(x, nd=4):
    if x is None:
        return "None"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)
