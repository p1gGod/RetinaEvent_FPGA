#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v7 特征：f17 浮点参考 + 可在 RTL 整数精确复算的部署特征集。

部署特征只允许「加法/减法/算术右移/比较/clip」，再加上每窗一次的整数除法
（计算 pol_bal 与质心，质心除法板上本来就有）和整数开方（sqrt_n/sqrt_on 用）。
每个特征都在 int8 域 [-127,127]，模型输入时按 s_x = 1 处理。

f17 是 v6 的浮点 17 路特征，仅作对照，不可上板。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "nn" / "v6"))
import v6_common as C  # noqa: E402

G = C.GIDX
GLOBAL_NAMES = list(C.GLOBAL_NAMES)
CLIP = 127


# ---------------------------------------------------------------------------
# 整数工具（与 RTL 语义一一对应：向下取整除法、算术右移、饱和 clip）
# ---------------------------------------------------------------------------
def isqrt_arr(x) -> np.ndarray:
    """整数开方 floor(sqrt(x))，x 可为 int64 数组（x <= 2^52 时精确）。"""
    x = np.maximum(np.asarray(x, dtype=np.int64), 0)
    r = np.sqrt(x.astype(np.float64)).astype(np.int64)
    r = np.where((r + 1) * (r + 1) <= x, r + 1, r)
    r = np.where(r * r > x, r - 1, r)
    return r


def trunc_div(a, b):
    """向零截断除法（int64 数组），b 恒 > 0。"""
    a = np.asarray(a, dtype=np.int64)
    b = np.asarray(b, dtype=np.int64)
    q = np.abs(a) // np.maximum(b, 1)
    return np.where(a < 0, -q, q)


def clip127(v):
    return np.clip(np.asarray(v, dtype=np.int64), -CLIP, CLIP)


def sqrt_q(v):
    """sqrt 编码：min(127, isqrt(2*v) >> 1)。v=0 -> 0；v=2048 -> 32；v>=8192 饱和。"""
    return np.minimum(CLIP, isqrt_arr(2 * np.maximum(np.asarray(v, dtype=np.int64), 0)) >> 1)


def _cols(g):
    c = {name: g[:, G[name]].astype(np.int64) for name in GLOBAL_NAMES}
    return c


# ---------------------------------------------------------------------------
# f17：v6 浮点参考（不可上板）
# ---------------------------------------------------------------------------
def build_f17(g: np.ndarray):
    f13, n13 = C.global_features(g)
    n = g[:, G["n"]]
    on = g[:, G["on"]]
    off = g[:, G["off"]]
    safe = np.maximum(n, 1.0)
    extra = np.stack([(g[:, G["pcx"]] - 200.0) / 120.0,
                      (g[:, G["pcy"]] - 120.0) / 80.0,
                      on / safe, off / safe], axis=1).astype(np.float32)
    feats = np.concatenate([f13, extra], axis=1).astype(np.float32)
    names = n13 + ["pcx", "pcy", "on_ratio", "off_ratio"]
    return feats, names


# ---------------------------------------------------------------------------
# 部署特征集
# ---------------------------------------------------------------------------
def _int_feats(g: np.ndarray, sqrt_like: bool):
    c = _cols(g)
    n = c["n"]
    on = c["on"]
    off = c["off"]
    cx = c["cx"]
    cy = c["cy"]
    pcx = c["pcx"]
    pcy = c["pcy"]
    frames = c["frames"]
    safe_n = np.maximum(n, 1)
    pol_bal = clip127(trunc_div((on - off) * CLIP, safe_n))
    cx_q = clip127((cx - 200) >> 1)
    cy_q = clip127(cy - 120)
    dx_q = clip127((cx - pcx) >> 2)
    dy_q = clip127((cy - pcy) >> 1)
    pcx_q = clip127((pcx - 200) >> 1)
    pcy_q = clip127(pcy - 120)
    frames_q = clip127(frames)
    if sqrt_like:
        f = [sqrt_q(n), sqrt_q(c["prev_n"]), pol_bal, cx_q, cy_q,
             dx_q, dy_q, pcx_q, pcy_q, sqrt_q(on), sqrt_q(off), frames_q]
        names = ["sqrt_n", "sqrt_prev_n", "pol_bal", "cx", "cy", "dx", "dy",
                 "pcx", "pcy", "sqrt_on", "sqrt_off", "frames"]
    else:
        n_q = np.minimum(CLIP, n >> 4)
        pn_q = np.minimum(CLIP, c["prev_n"] >> 4)
        on_q = np.minimum(CLIP, on >> 4)
        off_q = np.minimum(CLIP, off >> 4)
        f = [n_q, pn_q, pol_bal, cx_q, cy_q, dx_q, dy_q, pcx_q, pcy_q,
             on_q, off_q, frames_q]
        names = ["n_div16", "prev_n_div16", "pol_bal", "cx", "cy", "dx", "dy",
                 "pcx", "pcy", "on_div16", "off_div16", "frames"]
    return np.stack(f, axis=1).astype(np.int16), names


def build_f12s(g):
    """12 路 sqrt 编码部署特征。"""
    return _int_feats(g, True)


def build_f12n(g):
    """12 路 线性移位编码部署特征（无开方，仅移位+一次除法）。"""
    return _int_feats(g, False)


# ---------------------------------------------------------------------------
# 尺度不变特征（lead m01124）：S = isqrt(sx*sy)，dx_rel/dy_rel/speed_rel = (v<<6)//S
# 每窗一次乘除法可承受；逐事件路径仍只有加法/clamp/移位。
# ---------------------------------------------------------------------------
def _rel_feats(g: np.ndarray):
    c = _cols(g)
    sx = c["sx"]
    sy = c["sy"]
    dx = c["dx"]
    dy = c["dy"]
    speed = c["speed"]
    s = np.maximum(isqrt_arr(sx * sy), 8)  # 手部等效尺度（像素），下限 8 兜底
    dx_rel = clip127((dx << 6) // s)
    dy_rel = clip127((dy << 6) // s)
    speed_rel = clip127((speed << 6) // s)
    return np.stack([dx_rel, dy_rel, speed_rel], axis=1).astype(np.int16), ["dx_rel", "dy_rel", "speed_rel"]


REL_SUBSET = {
    "fmin_n_rel": ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy", "dx_rel", "dy_rel", "speed_rel"],
    "rel_only": ["n_div16", "prev_n_div16", "pol_bal", "dx_rel", "dy_rel", "speed_rel"],
    "rel_only5": ["n_div16", "prev_n_div16", "pol_bal", "dx_rel", "dy_rel"],
    "fmin_n_rel7": ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy", "dx_rel", "dy_rel"],
    "frel7": ["n_div16", "prev_n_div16", "pol_bal", "cx", "cy", "dx_rel", "dy_rel"],
}


def build_rel(mode: str, g: np.ndarray):
    """部署特征 + 尺度不变特征，返回 (float32 feats, names)。"""
    f12, names12 = _int_feats(g, False)
    rel, names_rel = _rel_feats(g)
    f = np.concatenate([f12.astype(np.int32), rel.astype(np.int32)], axis=1)
    names = list(names12) + list(names_rel)
    keep = REL_SUBSET[mode]
    idx = [names.index(k) for k in keep]
    return f[:, idx].astype(np.float32), keep


SUBSET = {
    "fmin_s": ["sqrt_n", "sqrt_prev_n", "pol_bal", "dx", "dy"],
    "fmin_n": ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy"],
    "f7s": ["sqrt_n", "sqrt_prev_n", "pol_bal", "cx", "cy", "dx", "dy"],
    "f7n": ["n_div16", "prev_n_div16", "pol_bal", "cx", "cy", "dx", "dy"],
    "f9s": ["sqrt_n", "sqrt_prev_n", "pol_bal", "cx", "cy", "dx", "dy", "sqrt_on", "sqrt_off"],
}


def build(mode: str, g: np.ndarray):
    """返回 (feats float32/int16, names)。mode: f17 / f12s / f12n / fmin_s / fmin_n / f7s / f7n / f9s。"""
    if mode == "f17":
        return build_f17(g)
    if mode == "f12s":
        f, names = build_f12s(g)
        return f.astype(np.float32), names
    if mode == "f12n":
        f, names = build_f12n(g)
        return f.astype(np.float32), names
    if mode in REL_SUBSET:
        return build_rel(mode, g)
    if mode in SUBSET:
        if mode.endswith("_s") or mode.startswith("f7s") or mode.startswith("f9s"):
            f, names = build_f12s(g)
        else:
            f, names = build_f12n(g)
        keep = SUBSET[mode]
        idx = [names.index(k) for k in keep]
        return f[:, idx].astype(np.float32), keep
    raise ValueError(f"unknown feature mode: {mode}")


DEPLOY_MODES = ("f12s", "f12n", "fmin_s", "fmin_n", "f7s", "f7n", "f9s") + tuple(REL_SUBSET)
ALL_MODES = ("f17",) + DEPLOY_MODES


# ---------------------------------------------------------------------------
# 整数公式自检（用纯 Python 逐项复算任意 N 行，与向量化实现必须完全一致）
# ---------------------------------------------------------------------------
def _py_isqrt(x: int) -> int:
    if x <= 0:
        return 0
    r = int(x ** 0.5)
    while (r + 1) * (r + 1) <= x:
        r += 1
    while r * r > x:
        r -= 1
    return r


def _py_trunc_div(a: int, b: int) -> int:
    if b == 0:
        return 0
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q


def python_row(g_row, sqrt_like: bool):
    """单行纯 Python 参考实现（RTL 契约的可读版本）。"""
    n = int(g_row[G["n"]]); on = int(g_row[G["on"]]); off = int(g_row[G["off"]])
    cx = int(g_row[G["cx"]]); cy = int(g_row[G["cy"]])
    pcx = int(g_row[G["pcx"]]); pcy = int(g_row[G["pcy"]])
    prev_n = int(g_row[G["prev_n"]]); frames = int(g_row[G["frames"]])
    pol_bal = max(-127, min(127, _py_trunc_div((on - off) * 127, max(n, 1))))
    val = {
        "pol_bal": pol_bal,
        "cx": max(-127, min(127, (cx - 200) >> 1)),
        "cy": max(-127, min(127, cy - 120)),
        "dx": max(-127, min(127, (cx - pcx) >> 2)),
        "dy": max(-127, min(127, (cy - pcy) >> 1)),
        "pcx": max(-127, min(127, (pcx - 200) >> 1)),
        "pcy": max(-127, min(127, pcy - 120)),
        "frames": max(-127, min(127, frames)),
    }
    if sqrt_like:
        val["sqrt_n"] = min(127, _py_isqrt(2 * n) >> 1)
        val["sqrt_prev_n"] = min(127, _py_isqrt(2 * prev_n) >> 1)
        val["sqrt_on"] = min(127, _py_isqrt(2 * on) >> 1)
        val["sqrt_off"] = min(127, _py_isqrt(2 * off) >> 1)
    else:
        val["n_div16"] = min(127, n >> 4)
        val["prev_n_div16"] = min(127, prev_n >> 4)
        val["on_div16"] = min(127, on >> 4)
        val["off_div16"] = min(127, off >> 4)
    # 尺度不变特征：S=max(isqrt(sx*sy),8)，rel=(v<<6)//S（floor 除法）
    sx = int(g_row[G["sx"]]); sy = int(g_row[G["sy"]])
    s = max(_py_isqrt(sx * sy), 8)
    dx_raw = cx - pcx
    dy_raw = cy - pcy
    speed_raw = _py_isqrt(dx_raw * dx_raw + dy_raw * dy_raw)
    val["dx_rel"] = max(-127, min(127, (dx_raw << 6) // s))
    val["dy_rel"] = max(-127, min(127, (dy_raw << 6) // s))
    val["speed_rel"] = max(-127, min(127, (speed_raw << 6) // s))
    return val


def self_check(g: np.ndarray, n_rows: int = 200, seed: int = 7) -> list:
    """向量化实现 vs 纯 Python 参考，逐特征比对；返回失败列表（空 = 全过）。"""
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(g), size=min(n_rows, len(g)), replace=False)
    fails = []
    for sqrt_like, mode in ((True, "f12s"), (False, "f12n")):
        f, names = build(mode, g)
        for i in idx:
            ref = python_row(g[i], sqrt_like)
            for j, name in enumerate(names):
                got = int(f[i, j])
                exp = int(ref[name])
                if got != exp:
                    fails.append({"mode": mode, "row": int(i), "feat": name,
                                  "got": got, "exp": exp})
    for mode in REL_SUBSET:
        f, names = build(mode, g)
        for i in idx:
            ref = python_row(g[i], False)
            for j, name in enumerate(names):
                got = int(f[i, j])
                exp = int(ref[name])
                if got != exp:
                    fails.append({"mode": mode, "row": int(i), "feat": name,
                                  "got": got, "exp": exp})
    return fails


if __name__ == "__main__":
    import json
    d = np.load(ROOT / "nn" / "v7" / "windows_v7.npz", allow_pickle=False)
    g = d["g"]
    out = {"modes": {}}
    for mode in ALL_MODES:
        f, names = build(mode, g)
        out["modes"][mode] = {
            "n_feat": len(names), "names": names,
            "min": [int(v) for v in f.min(axis=0)],
            "max": [int(v) for v in f.max(axis=0)],
        }
    fails = self_check(g)
    out["self_check_fails"] = fails[:10]
    out["self_check_ok"] = len(fails) == 0
    print(json.dumps(out, ensure_ascii=False, indent=1))
