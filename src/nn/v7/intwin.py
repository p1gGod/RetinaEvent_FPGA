#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""RTL 等价整数窗生成（v7.1）。

与 nn_winstat / nn_feat 的板上整数约定逐位一致：
  - 坐标：events.csv 的 x,y 是 400x240 原始像素（整数）；GRID_SHIFT=3 -> 50x30 网格。
  - 窗口：100 ms 宽、50 ms 步；窗口 k 起点 t0_k = g0 + 50*k（g0 = 首事件相对 board0 的时刻）。
  - 统计量（全部由窗口内原始事件整数累加）：
        n=事件数, on=pol1 数, off=pol0 数, Sx=sum(x), Sy=sum(y),
        Sx2=sum(x*x), Sy2=sum(y*y)
    质心 cx = floor(Sx/n), cy = floor(Sy/n)（整数除法；n>0 才更新，n=0 保持上一有效值，
    初值 200/120）；sx = isqrt((Sx2*n - Sx*Sx) // (n*n))（像素，floor sqrt）。
  - 平移归一化（只用上一窗整数质心，初始 200/120）：
        x' = clamp(x - (pcx-200), 0, 399); gx = x' >> 3
        y' = clamp(y - (pcy-120), 0, 239); gy = y' >> 3
    事件不丢弃：越界事件被 clamp 到边界格（与 RTL 一致）。
  - 通道 [ON_now, OFF_now, ON_prev, OFF_prev]，计数饱和 127；prev 通道 = 上一窗自己的
    平移网格（上一窗坐标系，寄存器直接保存）。
  - 全局量 17 路全部为整数/整数派生（见 GLOBAL_NAMES）；sx/sy/speed 用 floor sqrt。

本模块不做任何浮点坐标运算；g 以 float32 存储但每个值都是整数（精确可表示）。
"""
from __future__ import annotations

import math

import numpy as np

GRID_SHIFT = 3
GRID_W = 50
GRID_H = 30
N_CELLS = GRID_W * GRID_H
SAT = 127
WIN_MS = 100
STRIDE_MS = 50

CHANNELS = ("ON_now", "OFF_now", "ON_prev", "OFF_prev")
GLOBAL_NAMES = [
    "n", "on", "off", "cx", "cy", "sx", "sy",
    "pcx", "pcy", "dx", "dy", "speed", "dsx", "dsy",
    "bal", "frames", "prev_n",
]
GIDX = {k: i for i, k in enumerate(GLOBAL_NAMES)}

X_PIX_MAX = (GRID_W << GRID_SHIFT) - 1   # 399
Y_PIX_MAX = (GRID_H << GRID_SHIFT) - 1   # 239


def _isqrt_arr(v: np.ndarray) -> np.ndarray:
    """整数 floor(sqrt(v))，v>=0 int64。"""
    r = np.sqrt(v.astype(np.float64)).astype(np.int64)
    r = np.where((r + 1) * (r + 1) <= v, r + 1, r)
    r = np.where((r + 1) * (r + 1) <= v, r + 1, r)
    r = np.where(r * r > v, r - 1, r)
    return r


def _carry_prev(vals: np.ndarray, valid: np.ndarray, init: int) -> np.ndarray:
    """n==0 时保持上一个有效值；窗口 0 之前用 init。"""
    idx = np.maximum.accumulate(np.where(valid, np.arange(len(vals), dtype=np.int64), -1))
    out = np.where(idx >= 0, vals[np.clip(idx, 0, None)], np.int64(init))
    return out.astype(np.int64)


def subblock_stats(rel, x, y, pol, g0: int, n_sub: int):
    """按 50 ms 子块汇总整数累加量与原始（未平移）网格计数。"""
    rel = np.asarray(rel, dtype=np.int64)
    x = np.asarray(x, dtype=np.int64)
    y = np.asarray(y, dtype=np.int64)
    pol = np.asarray(pol, dtype=np.int64)
    sidx = (rel - int(g0)) // STRIDE_MS
    ok = (sidx >= 0) & (sidx < n_sub)
    s = sidx[ok]
    xo, yo, po = x[ok], y[ok], pol[ok]
    one = np.ones(len(s), dtype=np.float64)

    def bc(w):
        return np.bincount(s, weights=w, minlength=n_sub).astype(np.int64)

    N = bc(one)
    ON = bc((po == 1).astype(np.float64))
    OFF = bc((po == 0).astype(np.float64))
    SX = bc(xo.astype(np.float64))
    SY = bc(yo.astype(np.float64))
    SX2 = bc((xo * xo).astype(np.float64))
    SY2 = bc((yo * yo).astype(np.float64))

    gx = xo >> GRID_SHIFT
    gy = yo >> GRID_SHIFT
    inb = (gx >= 0) & (gx < GRID_W) & (gy >= 0) & (gy < GRID_H)
    cell = gy[inb] * GRID_W + gx[inb]
    ch = 1 - po[inb]
    flat = s[inb] * (2 * N_CELLS) + ch * N_CELLS + cell
    sub = np.bincount(flat, minlength=n_sub * 2 * N_CELLS).reshape(n_sub, 2, GRID_H, GRID_W)
    assert int(sub.sum()) == int(inb.sum())
    assert int(sub.max()) <= 65535, "subblock cell count overflow: %d" % int(sub.max())
    return {
        "N": N, "ON": ON, "OFF": OFF, "SX": SX, "SY": SY, "SX2": SX2, "SY2": SY2,
        "sub_grid": sub.astype(np.uint16), "n_bad": int((~inb).sum()),
    }


def window_stats(sub: dict, n_win: int, frames_per_window=None):
    """窗口 = 两个相邻 50ms 子块；返回整数统计量与质心（含 carry-forward）。"""
    def w(a):
        v = sub[a]
        return v[:n_win] + v[1:n_win + 1]

    n = w("N"); on = w("ON"); off = w("OFF")
    Sx = w("SX"); Sy = w("SY"); Sx2 = w("SX2"); Sy2 = w("SY2")
    valid = n > 0
    ns = np.maximum(n, np.int64(1))
    cx_raw = np.where(valid, Sx // ns, np.int64(0))
    cy_raw = np.where(valid, Sy // ns, np.int64(0))
    cx = _carry_prev(cx_raw, valid, 200)
    cy = _carry_prev(cy_raw, valid, 120)
    # 方差（整数）：var_num = Sx2*n - Sx^2, var_floor = var_num // n^2
    varx_num = Sx2 * n - Sx * Sx
    vary_num = Sy2 * n - Sy * Sy
    den = ns * ns
    sx = np.where(valid, _isqrt_arr(np.maximum(varx_num, 0) // den), np.int64(0))
    sy = np.where(valid, _isqrt_arr(np.maximum(vary_num, 0) // den), np.int64(0))
    pcx = np.concatenate([np.array([200], np.int64), cx[:-1]]) if n_win else cx
    pcy = np.concatenate([np.array([120], np.int64), cy[:-1]]) if n_win else cy
    psx = np.concatenate([np.array([0], np.int64), sx[:-1]]) if n_win else sx
    psy = np.concatenate([np.array([0], np.int64), sy[:-1]]) if n_win else sy
    dx = np.where(valid, cx - pcx, np.int64(0))
    dy = np.where(valid, cy - pcy, np.int64(0))
    speed = _isqrt_arr(dx * dx + dy * dy)
    prev_n = np.concatenate([np.array([0], np.int64), n[:-1]]) if n_win else n
    bal = np.where(valid, (on - off) / np.maximum(n, 1), 0.0)
    frames = (np.zeros(n_win, np.int64) if frames_per_window is None
              else np.asarray(frames_per_window, np.int64))
    g = np.zeros((n_win, len(GLOBAL_NAMES)), dtype=np.float32)
    g[:, GIDX["n"]] = n
    g[:, GIDX["on"]] = on
    g[:, GIDX["off"]] = off
    g[:, GIDX["cx"]] = cx
    g[:, GIDX["cy"]] = cy
    g[:, GIDX["sx"]] = sx
    g[:, GIDX["sy"]] = sy
    g[:, GIDX["pcx"]] = pcx
    g[:, GIDX["pcy"]] = pcy
    g[:, GIDX["dx"]] = dx
    g[:, GIDX["dy"]] = dy
    g[:, GIDX["speed"]] = speed
    g[:, GIDX["dsx"]] = sx - psx
    g[:, GIDX["dsy"]] = sy - psy
    g[:, GIDX["bal"]] = bal
    g[:, GIDX["frames"]] = frames
    g[:, GIDX["prev_n"]] = prev_n
    return {
        "n": n, "on": on, "off": off, "cx": cx, "cy": cy, "sx": sx, "sy": sy,
        "pcx": pcx, "pcy": pcy, "dx": dx, "dy": dy, "speed": speed,
        "dsx": sx - psx, "dsy": sy - psy, "prev_n": prev_n, "frames": frames, "g": g,
    }


def shifted_grids(rel, x, y, pol, g0: int, n_win: int, stats: dict,
                  event_lo=None, event_hi=None, log=print):
    """按上一窗整数质心平移 + clamp + >>3 生成 X_shift（返回 int8 (n_win,4,H,W)）。"""
    rel = np.asarray(rel, dtype=np.int64)
    x = np.asarray(x, dtype=np.int64)
    y = np.asarray(y, dtype=np.int64)
    pol = np.asarray(pol, dtype=np.int64)
    t0s = np.arange(n_win, dtype=np.int64) * STRIDE_MS + int(g0)
    if event_lo is None:
        event_lo = np.searchsorted(rel, t0s, side="left")
    if event_hi is None:
        event_hi = np.searchsorted(rel, t0s + WIN_MS, side="left")
    offx = (stats["pcx"] - 200).astype(np.int64)
    offy = (stats["pcy"] - 120).astype(np.int64)
    X = np.zeros((n_win, 4, GRID_H, GRID_W), dtype=np.int8)
    prev_shift = np.zeros((2, GRID_H, GRID_W), dtype=np.int8)
    t_start = None
    import time as _time
    t_start = _time.time()
    for k in range(n_win):
        a = int(event_lo[k]); b = int(event_hi[k])
        if b > a:
            xs = np.clip(x[a:b] - offx[k], 0, X_PIX_MAX) >> GRID_SHIFT
            ys = np.clip(y[a:b] - offy[k], 0, Y_PIX_MAX) >> GRID_SHIFT
            ch = 1 - pol[a:b]
            flat = ch * N_CELLS + ys * GRID_W + xs
            cnt = np.bincount(flat, minlength=2 * N_CELLS).reshape(2, GRID_H, GRID_W)
            X[k, 0] = np.clip(cnt[0], 0, SAT)
            X[k, 1] = np.clip(cnt[1], 0, SAT)
        X[k, 2] = prev_shift[0]
        X[k, 3] = prev_shift[1]
        prev_shift[0] = X[k, 0]
        prev_shift[1] = X[k, 1]
        if log and k and k % 2048 == 0:
            log("[intwin] shifted grids %d/%d %.1fs" % (k, n_win, _time.time() - t_start))
    return X, event_lo, event_hi


def raw_grids(sub_grid: np.ndarray, n_win: int) -> np.ndarray:
    """原始（未平移）4 通道网格：now = 子块 k + k+1，prev = 上一窗 now。"""
    now = sub_grid[:n_win].astype(np.int64) + sub_grid[1:n_win + 1].astype(np.int64)
    X = np.zeros((n_win, 4, GRID_H, GRID_W), dtype=np.int8)
    X[:, 0] = np.clip(now[:, 0], 0, SAT)
    X[:, 1] = np.clip(now[:, 1], 0, SAT)
    if n_win > 1:
        X[1:, 2] = X[:-1, 0]
        X[1:, 3] = X[:-1, 1]
    return X


def window_t0(rel, g0: int, n_win: int) -> np.ndarray:
    return np.arange(n_win, dtype=np.int64) * STRIDE_MS + int(g0)


def n_windows(rel) -> tuple:
    rel = np.asarray(rel, dtype=np.int64)
    g0 = int(rel[0]); t_last = int(rel[-1])
    n_win = (t_last - g0 - WIN_MS) // STRIDE_MS + 1
    n_sub = (t_last - g0) // STRIDE_MS + 2
    return g0, n_win, n_sub
