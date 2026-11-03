#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_events.py -- 视网膜事件 CSV -> 板端 4x30x50 特征窗口数据集（含 none 类）。

契约为 task-4 固化内容：
- GRID_SHIFT=3 => 400>>3=50, 240>>3=30；通道顺序 [ON_now, OFF_now, ON_prev, OFF_prev]
- WIN_MS=100 为主配置，同时产出 100/150/200 三份数据集（stride = win/2，50% 重叠）
- 标注：会话（单个 CSV）内活动段（逐帧事件量阈值 + 滞回，向两侧扩 200 ms）内窗口标该动作类；
  段外窗口标 none=0。动作一=1，动作二=2。
- 每活动段计一次循环；长段若含多次重复，按「运动包络下凹」保守切分（见 envelope_cuts）。
- 数据切分必须按会话文件整体切分；meta 里给 file/session/group(θ,Δ)/seg 起止帧号。
- 部署子集 = (θ=3, Δ=18) 参数组。

用法：
    python extract_events.py                 # 构建三份 npz + stats.json
    python extract_events.py --no-build      # 只重算 stats.json
    python extract_events.py --data-root D:/... --out-dir nn
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# 常量（契约）
# ---------------------------------------------------------------------------
GRID_SHIFT = 3
GRID_W = 400 >> GRID_SHIFT          # 50
GRID_H = 240 >> GRID_SHIFT          # 30
N_CELLS = GRID_W * GRID_H           # 1500
WIN_MS_DEFAULT = 100
WINS_MS = (100, 150, 200)
CHANNELS = ("ON_now", "OFF_now", "ON_prev", "OFF_prev")
SAT_MAX = 127                       # int8 饱和
UINT16_MAX = 65535

ACT_HI = 500                        # 活动段进入阈值（事件/帧）
ACT_LO = 120                        # 活动段退出阈值（滞回）
ACT_GAP_MS = 400                    # 连续无活动帧超过该时长 => 段结束
ACT_EXT_MS = 200                    # 活动段两侧扩展

ENV_MIN_SEG_MS = 2000               # 只有 >=2 s 的段才考虑切分（宁可少切）
ENV_DIP_FRAC = 0.25                 # 平滑事件包络低于峰值 25% 视为下凹
ENV_MIN_LOW_BINS = 2                # 下凹至少持续 2 个 100ms 桶
ENV_MIN_PHASE_MS = 500              # 切点两侧各需 >=500ms 活动
BIN_MS = 100

ACTION_DIRS = (("动作一", 1), ("动作二", 2))


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass
class Session:
    name: str
    path: str
    action: int
    theta: int
    delta: int
    file_idx: int
    t: np.ndarray          # 排序后逐事件 frame_t_ms (int64)
    x: np.ndarray
    y: np.ndarray
    pol: np.ndarray        # 0=OFF, 1=ON
    cell_id: np.ndarray    # 预计算 (gy*GRID_W+gx)，越界=-1
    frame_times: np.ndarray
    frame_counts: np.ndarray
    frame_ids: np.ndarray  # 每个帧的 frame_idx

    @property
    def group(self) -> str:
        return f"theta{self.theta}_delta{self.delta}"

    @property
    def span_ms(self) -> int:
        return int(self.frame_times[-1] - self.frame_times[0])


@dataclass
class Segment:
    i0: int                # 首活动帧下标
    i1: int                # 末活动帧下标
    t0: int                # 扩展后起点（含）
    t1: int                # 扩展后终点（含）
    frame_id0: int
    frame_id1: int
    cuts_ms: list = field(default_factory=list)
    split_reason: str = "single"

    @property
    def cycles(self) -> int:
        return 1 + len(self.cuts_ms)

    @property
    def dur_ms(self) -> int:
        return self.t1 - self.t0


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def parse_event_lines(lines, *, skip_header: bool = False):
    """容错解析 events CSV 行。返回 (t, x, y, pol, bad_rows)。"""
    ts, xs, ys, ps = [], [], [], []
    bad = 0
    header_checked = not skip_header
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        if not header_checked:
            header_checked = True
            if s.startswith("frame_idx"):
                continue
        parts = s.split(",")
        if len(parts) != 8:
            bad += 1
            continue
        try:
            t = int(parts[1])
            x = int(parts[2])
            y = int(parts[3])
            p = int(parts[4])
        except (TypeError, ValueError):
            bad += 1
            continue
        if p not in (0, 1):
            bad += 1
            continue
        ts.append(t)
        xs.append(x)
        ys.append(y)
        ps.append(p)
    if not ts:
        return (np.empty(0, np.int64), np.empty(0, np.int32),
                np.empty(0, np.int32), np.empty(0, np.int8), bad)
    return (np.asarray(ts, np.int64), np.asarray(xs, np.int32),
            np.asarray(ys, np.int32), np.asarray(ps, np.int8), bad)


def cell_ids(x, y, shift: int = GRID_SHIFT):
    """x>>shift, y>>shift 映射到 50x30 网格；越界返回 -1。"""
    gx = np.asarray(x, dtype=np.int64) >> shift
    gy = np.asarray(y, dtype=np.int64) >> shift
    w = 400 >> shift
    h = 240 >> shift
    ok = (gx >= 0) & (gx < w) & (gy >= 0) & (gy < h)
    out = np.where(ok, gy * w + gx, -1)
    return out.astype(np.int64)


def make_session(name: str, path: str, action: int, theta: int, delta: int,
                 file_idx: int, frame_idx, t, x, y, pol) -> Session:
    order = np.argsort(t, kind="stable")
    t = np.asarray(t, np.int64)[order]
    x = np.asarray(x, np.int32)[order]
    y = np.asarray(y, np.int32)[order]
    pol = np.asarray(pol, np.int8)[order]
    fidx = np.asarray(frame_idx, np.int64)[order]
    if len(t) == 0:
        raise ValueError(f"会话无有效事件：{path}")
    uniq, first = np.unique(t, return_index=True)
    counts = np.diff(np.append(first, len(t)))
    ids = fidx[first]
    return Session(name=name, path=path, action=action, theta=theta,
                   delta=delta, file_idx=file_idx, t=t, x=x, y=y, pol=pol,
                   cell_id=cell_ids(x, y), frame_times=uniq,
                   frame_counts=counts.astype(np.int64),
                   frame_ids=ids.astype(np.int64))


def load_session(path: str, action: int, theta: int, delta: int,
                 file_idx: int) -> Session:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    t, x, y, pol, bad = parse_event_lines(lines, skip_header=True)
    if bad:
        print(f"[warn] {os.path.basename(path)} 跳过坏行 {bad} 行", file=sys.stderr)
    # frame_idx 列（第 0 列）单独再解析一次：坏行与 parse 保持一致略过
    fids = []
    for raw in lines[1:]:
        s = raw.strip()
        if not s:
            continue
        parts = s.split(",")
        if len(parts) != 8:
            continue
        try:
            fi = int(parts[0]); int(parts[1]); int(parts[2]); int(parts[3]); int(parts[4])
        except (TypeError, ValueError):
            continue
        if int(parts[4]) not in (0, 1):
            continue
        fids.append(fi)
    fids = np.asarray(fids, np.int64)
    if len(fids) != len(t):
        raise AssertionError(f"frame_idx 与事件数不一致：{len(fids)} vs {len(t)}")
    name = os.path.splitext(os.path.basename(path))[0]
    return make_session(name, path, action, theta, delta, file_idx,
                        fids, t, x, y, pol)


def parse_session_time(filename: str) -> datetime:
    m = re.search(r"(\d{8})-(\d{6})", os.path.basename(filename))
    if not m:
        raise ValueError(f"文件名无时间戳：{filename}")
    return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")


def parse_filter_lines(lines) -> list:
    """解析 过滤参数.txt：每行 => dict(date, start(min), end(min), theta, delta)。"""
    out = []
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        m = re.search(r"(\d{4})\s+(\d{1,2})\s+(\d{1,2})-(\d{1,2})[/:](\d{2})\s+(\d{1,2})[/:](\d{2})", s)
        if not m:
            continue
        y, mo, d, h1, m1, h2, m2 = [int(v) for v in m.groups()]
        mt = re.search(r"阈值\s*(\d+)", s)
        md = re.search(r"(?:得塔|德尔塔|delta|Δ)\D*(\d+)", s)
        nums = re.findall(r"\d+", s)
        if not mt or not md:
            if len(nums) >= 2:
                theta = int(nums[-2]); delta = int(nums[-1])
            else:
                continue
        else:
            theta = int(mt.group(1)); delta = int(md.group(1))
        out.append({
            "date": (y, mo, d),
            "start_min": h1 * 60 + m1,
            "end_min": h2 * 60 + m2,
            "theta": theta,
            "delta": delta,
        })
    return out


def _minute_of(dt: datetime, date) -> float:
    base = datetime(date[0], date[1], date[2])
    return (dt - base).total_seconds() / 60.0


def match_group_indices(file_starts: list, params: list) -> list:
    """过滤参数每行 = 同参数组的两次录制：start≈第 k 个文件起始，end≈第 k+3 个文件起始。

    实现按 end 匹配最近文件起始，再回退 3 个文件（数据实测：动作一第 3 行 start 疑似笔误，
    按 end 对齐无歧义）。返回 [(i, j, theta, delta)]。
    """
    n = len(file_starts)
    pairs = []
    for p in params:
        date = p["date"]
        mins = [_minute_of(t, date) for t in file_starts]
        e = min(range(n), key=lambda k: abs(mins[k] - p["end_min"]))
        i = e - 3
        if i < 0 or i == e:
            # 回退失败时按行序号成对
            idx = params.index(p)
            i = idx
            e = idx + 3
        if i >= n or e >= n:
            continue
        pairs.append((i, e, int(p["theta"]), int(p["delta"])))
    return pairs


def discover_sessions(root: str) -> list:
    """发现两个动作目录下所有 retina-events-*.csv，并按参数组标注 θ/Δ。"""
    sessions = []
    file_idx = 0
    for dir_prefix, action in ACTION_DIRS:
        d = None
        for entry in sorted(os.listdir(root)):
            full = os.path.join(root, entry)
            if os.path.isdir(full) and entry.startswith(dir_prefix):
                d = full
                break
        if d is None:
            print(f"[warn] 未找到目录 {dir_prefix}*", file=sys.stderr)
            continue
        csvs = sorted(
            os.path.join(d, f) for f in os.listdir(d)
            if f.startswith("retina-events-") and f.endswith(".csv"))
        if not csvs:
            continue
        starts = [parse_session_time(p) for p in csvs]
        fp = os.path.join(d, "过滤参数.txt")
        params = []
        if os.path.exists(fp):
            with open(fp, "rb") as f:
                params = parse_filter_lines(
                    f.read().decode("utf-8", errors="ignore").splitlines())
        pairs = match_group_indices(starts, params) if params else []
        group_of = {}
        for (i, e, th, dl) in pairs:
            group_of[i] = (th, dl)
            group_of[e] = (th, dl)
        for k, p in enumerate(csvs):
            th, dl = group_of.get(k, (0, 0))
            s = load_session(p, action, th, dl, file_idx)
            file_idx += 1
            sessions.append(s)
    return sessions


# ---------------------------------------------------------------------------
# 活动段
# ---------------------------------------------------------------------------
def detect_segments(sess: Session, hi: int = ACT_HI, lo: int = ACT_LO,
                    gap_ms: int = ACT_GAP_MS, ext_ms: int = ACT_EXT_MS) -> list:
    """逐帧事件量阈值 + 滞回 + 时间跳变断段；两侧扩 ext_ms 并裁到文件时间范围。"""
    times = sess.frame_times
    counts = sess.frame_counts
    segs_idx = []
    active = False
    i0 = 0
    last = 0
    for i in range(len(times)):
        if active and times[i] - times[last] > gap_ms:
            segs_idx.append((i0, last))
            active = False
        if not active and counts[i] > hi:
            active = True
            i0 = last = i
        elif active and counts[i] >= lo:
            last = i
    if active:
        segs_idx.append((i0, last))
    out = []
    for (a, b) in segs_idx:
        t0 = int(times[a]) - ext_ms
        t1 = int(times[b]) + ext_ms
        t0 = max(t0, int(times[0]))
        t1 = min(t1, int(times[-1]))
        if t1 <= t0:
            continue
        out.append(Segment(i0=a, i1=b, t0=t0, t1=t1,
                           frame_id0=int(sess.frame_ids[a]),
                           frame_id1=int(sess.frame_ids[b])))
    return out


def envelope_cuts(sess: Session, seg: Segment, bin_ms: int = BIN_MS,
                  min_seg_ms: int = ENV_MIN_SEG_MS,
                  dip_frac: float = ENV_DIP_FRAC,
                  min_low_bins: int = ENV_MIN_LOW_BINS,
                  min_phase_ms: int = ENV_MIN_PHASE_MS) -> list:
    """保守的「长段含多次重复」切分：平滑事件包络出现持续下凹才切。

    判定量：段内每 bin_ms 的事件量，3 点滑动平均得到运动包络；
    切分条件（全部满足）：
      1) 段长 >= min_seg_ms（默认 2 s，宁可少切）；
      2) 存在连续 >= min_low_bins 个桶的包络 < dip_frac*峰值（默认 25%）；
      3) 切点距两端各 >= min_phase_ms，且切点两侧 max 包络 >= 50% 峰值；
      4) 切点之间相距 >= min_phase_ms。
    返回切点绝对时间（frame_t_ms）列表。
    """
    dur = seg.t1 - seg.t0
    if dur < min_seg_ms:
        return []
    a = int(np.searchsorted(sess.t, seg.t0, side="left"))
    b = int(np.searchsorted(sess.t, seg.t1, side="left"))
    if b - a < 4:
        return []
    nb = int(dur // bin_ms) + 1
    k = ((sess.t[a:b] - seg.t0) // bin_ms).astype(np.int64)
    bins = np.bincount(np.clip(k, 0, nb - 1), minlength=nb).astype(np.float64)
    if nb < 5 or bins.max() <= 0:
        return []
    kern = np.ones(3) / 3.0
    sm = np.convolve(bins, kern, mode="same")
    peak = float(sm.max())
    if peak <= 0:
        return []
    low = sm < dip_frac * peak
    cuts = []
    i = 0
    while i < nb:
        if not low[i]:
            i += 1
            continue
        j = i
        while j + 1 < nb and low[j + 1]:
            j += 1
        if j - i + 1 >= min_low_bins:
            cbin = i + int(np.argmin(sm[i:j + 1]))
            cut = int(seg.t0 + cbin * bin_ms + bin_ms // 2)
            left_ok = cut - seg.t0 >= min_phase_ms and sm[:cbin + 1].max() >= 0.5 * peak
            right_ok = seg.t1 - cut >= min_phase_ms and sm[cbin:].max() >= 0.5 * peak
            far = (not cuts) or (cut - cuts[-1] >= min_phase_ms)
            if left_ok and right_ok and far:
                cuts.append(cut)
        i = j + 1
    return cuts


def annotate_cycles(sess: Session, segs: list) -> list:
    """对每段调用保守切分，写回 split_reason。"""
    for seg in segs:
        cuts = envelope_cuts(sess, seg)
        if cuts:
            seg.cuts_ms = cuts
            seg.split_reason = "envelope_dip@" + ",".join(
                str(c - seg.t0) for c in cuts)
    return segs


# ---------------------------------------------------------------------------
# 窗口计数
# ---------------------------------------------------------------------------
def count_window(sess: Session, t0: int, t1: int) -> np.ndarray:
    """[t0, t1) 内事件按通道顺序 (0=ON, 1=OFF) x 30 x 50 计数。

    CHANNELS=("ON_now","OFF_now","ON_prev","OFF_prev") 要求通道 0 为 ON，
    因此这里必须把 pol=1 放到第 0 层（与极性数组的 0=OFF/1=ON 语义相反）。
    """
    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    out = np.zeros(2 * N_CELLS, dtype=np.int64)
    if b > a:
        cid = sess.cell_id[a:b]
        ok = cid >= 0
        if ok.any():
            ch = (1 - sess.pol[a:b][ok]).astype(np.int64)
            idx = ch * N_CELLS + cid[ok]
            out = np.bincount(idx, minlength=2 * N_CELLS)
    return out.reshape(2, GRID_H, GRID_W).astype(np.int32)


def window_starts(t_first: int, t_last: int, win_ms: int,
                  stride_ms: Optional[int] = None) -> np.ndarray:
    """窗口起点：必须完整落在 [t_first, t_last] 内（边界丢弃）。"""
    stride = stride_ms if stride_ms else max(1, win_ms // 2)
    if t_last - t_first < win_ms:
        return np.empty(0, np.int64)
    return np.arange(t_first, t_last - win_ms + 1, stride, dtype=np.int64)


def label_window(t0: int, t1: int, segments: list, win_ms: int,
                 action: int):
    """窗口与活动段重叠 >= 50% 窗口长度 => 该会话动作类；否则 none=0。返回 (label, seg_idx)。"""
    best = -1
    best_ov = 0
    for si, seg in enumerate(segments):
        ov = min(t1, seg.t1) - max(t0, seg.t0)
        if ov > best_ov:
            best_ov = ov
            best = si
    if best >= 0 and best_ov * 2 >= win_ms:
        return int(action), best
    return 0, -1


def build_session_windows(sess: Session, win_ms: int,
                          stride_ms: Optional[int] = None,
                          segments: Optional[list] = None) -> dict:
    """为一个会话生成窗口（含 prev 通道）。"""
    if segments is None:
        segments = annotate_cycles(sess, detect_segments(sess))
    t_first = int(sess.frame_times[0])
    t_last = int(sess.frame_times[-1])
    starts = window_starts(t_first, t_last, win_ms, stride_ms)
    n = len(starts)
    X = np.zeros((n, 4, GRID_H, GRID_W), dtype=np.int32)
    y = np.zeros(n, dtype=np.uint8)
    seg_id = np.full(n, -1, dtype=np.int16)
    seg_start = np.full(n, -1, dtype=np.int64)
    seg_end = np.full(n, -1, dtype=np.int64)
    split_reason = [""] * n
    for k, t0 in enumerate(starts):
        t0 = int(t0)
        t1 = t0 + win_ms
        now = count_window(sess, t0, t1)
        prev = count_window(sess, t0 - win_ms, t0)
        X[k, 0] = now[0]
        X[k, 1] = now[1]
        X[k, 2] = prev[0]
        X[k, 3] = prev[1]
        lab, si = label_window(t0, t1, segments, win_ms, sess.action)
        if si >= 0:
            y[k] = lab
            seg_id[k] = si
            seg_start[k] = segments[si].frame_id0
            seg_end[k] = segments[si].frame_id1
            split_reason[k] = segments[si].split_reason
    return {
        "X": X, "y": y, "seg_id": seg_id,
        "seg_start_frame": seg_start, "seg_end_frame": seg_end,
        "split_reason": split_reason,
        "t_ms": starts.astype(np.int64),
        "t_rel_ms": (starts - t_first).astype(np.int64),
        "stride_ms": int(stride_ms if stride_ms else max(1, win_ms // 2)),
        "win_ms": int(win_ms),
        "segments": segments,
    }


def _uarray(strings, width: int) -> np.ndarray:
    out = np.empty(len(strings), dtype=f"<U{width}")
    for i, s in enumerate(strings):
        out[i] = s
    return out


def build_dataset(sessions: list, win_ms: int,
                  stride_ms: Optional[int] = None) -> dict:
    """把多个会话窗口拼接成数据集；meta 保留每个窗口的会话与段信息。"""
    stride = int(stride_ms) if stride_ms else max(1, win_ms // 2)
    chunks = []
    for sess in sessions:
        chunks.append((sess, build_session_windows(sess, win_ms, stride)))
    total = sum(len(c[1]["y"]) for c in chunks)
    X = np.zeros((total, 4, GRID_H, GRID_W), dtype=np.int32)
    y = np.zeros(total, dtype=np.uint8)
    file_idx = np.zeros(total, dtype=np.int16)
    seg_id = np.full(total, -1, dtype=np.int16)
    seg_start = np.full(total, -1, dtype=np.int64)
    seg_end = np.full(total, -1, dtype=np.int64)
    t_ms = np.zeros(total, dtype=np.int64)
    t_rel = np.zeros(total, dtype=np.int64)
    frame_ms = np.zeros(total, dtype=np.float32)
    files = []
    session_ids = []
    groups = []
    theta = np.zeros(total, dtype=np.int16)
    delta = np.zeros(total, dtype=np.int16)
    split_reason = []
    p = 0
    for sess, d in chunks:
        n = len(d["y"])
        X[p:p + n] = d["X"]
        y[p:p + n] = d["y"]
        file_idx[p:p + n] = sess.file_idx
        seg_id[p:p + n] = d["seg_id"]
        seg_start[p:p + n] = d["seg_start_frame"]
        seg_end[p:p + n] = d["seg_end_frame"]
        t_ms[p:p + n] = d["t_ms"]
        t_rel[p:p + n] = d["t_rel_ms"]
        frame_ms[p:p + n] = float(np.median(np.diff(sess.frame_times)))
        theta[p:p + n] = sess.theta
        delta[p:p + n] = sess.delta
        files.extend([sess.name] * n)
        session_ids.extend([sess.name] * n)
        groups.extend([sess.group] * n)
        split_reason.extend(d["split_reason"])
        p += n
    widths = max(8, max((len(s) for s in files), default=1) + 1) if files else 8
    X_counts = np.clip(X, 0, UINT16_MAX).astype(np.uint16)
    X_q = np.clip(X, 0, SAT_MAX).astype(np.int8)
    return {
        "X_counts": X_counts,
        "X_q": X_q,
        "y": y,
        "meta": {
            "file": _uarray(files, max(widths, 40)),
            "session": _uarray(session_ids, max(widths, 40)),
            "group": _uarray(groups, 20),
            "theta": theta,
            "delta": delta,
            "action": y.copy(),
            "file_idx": file_idx,
            "seg_id": seg_id,
            "seg_start_frame": seg_start,
            "seg_end_frame": seg_end,
            "t_ms": t_ms,
            "frame_ms": frame_ms,
            "t_rel_ms": t_rel,
            "win_ms": np.full(total, win_ms, dtype=np.int16),
            "stride_ms": np.full(total, stride, dtype=np.int16),
            "split_reason": _uarray(split_reason, 40),
            "channels": CHANNELS,
            "grid_shift": GRID_SHIFT,
            "grid_w": GRID_W,
            "grid_h": GRID_H,
        },
        "sessions": sessions,
    }


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
def _pct(vals: np.ndarray) -> dict:
    v = vals.ravel()
    if v.size == 0:
        return {"p50": 0.0, "p90": 0.0, "p99": 0.0, "max": 0, "zero_frac": 1.0}
    return {
        "p50": float(np.percentile(v, 50)),
        "p90": float(np.percentile(v, 90)),
        "p99": float(np.percentile(v, 99)),
        "max": float(v.max()),
        "zero_frac": float((v == 0).mean()),
    }


def window_stats(ds: dict) -> dict:
    X = ds["X_counts"]
    y = ds["y"]
    meta = ds["meta"]
    out = {
        "n_windows": int(len(y)),
        "win_ms": int(meta["win_ms"][0]) if len(y) else 0,
        "stride_ms": int(meta["stride_ms"][0]) if len(y) else 0,
        "per_class": {str(c): int((y == c).sum()) for c in (0, 1, 2)},
        "per_class_named": {
            "none": int((y == 0).sum()),
            "action1": int((y == 1).sum()),
            "action2": int((y == 2).sum()),
        },
        "per_group": {},
        "per_file": {},
        "cell": {},
        "on_off": {},
    }
    groups = meta["group"]
    for g in sorted(set(groups.tolist())):
        idx = groups == g
        out["per_group"][g] = {
            "windows": int(idx.sum()),
            "per_class": {str(c): int(((y == c) & idx).sum()) for c in (0, 1, 2)},
        }
    files = meta["file"]
    for f in sorted(set(files.tolist())):
        idx = files == f
        out["per_file"][str(f)] = {
            "windows": int(idx.sum()),
            "per_class": {str(c): int(((y == c) & idx).sum()) for c in (0, 1, 2)},
        }
    for c in (0, 1, 2):
        sel = y == c
        if not sel.any():
            continue
        out["cell"][f"class{c}"] = {}
        for ch, name in enumerate(CHANNELS):
            out["cell"][f"class{c}"][name] = _pct(X[sel, ch, :, :])
        out["cell"][f"class{c}"]["all_channels"] = _pct(X[sel, :, :, :])
    for c in (1, 2):
        sel = y == c
        if sel.any():
            on = float(X[sel, 0].sum())
            off = float(X[sel, 1].sum())
            out["on_off"][f"class{c}"] = {
                "on": on, "off": off,
                "on_ratio": round(on / (on + off), 4) if on + off else None,
            }
    return out


def coverage_stats(sessions: list) -> dict:
    """每类活动段覆盖时长与循环数（段内切分后）。"""
    out = {}
    for c in (1, 2):
        segs = [s for s in sessions if s.action == c]
        n_seg = 0
        n_cyc = 0
        cov_ms = 0
        splits = []
        rec_ms = 0
        for s in segs:
            ss = annotate_cycles(s, detect_segments(s))
            rec_ms += int(s.span_ms)
            for seg in ss:
                n_seg += 1
                n_cyc += seg.cycles
                cov_ms += seg.dur_ms
                if seg.cuts_ms:
                    splits.append({"file": s.name, "dur_ms": seg.dur_ms,
                                   "cuts_ms": [int(c - seg.t0) for c in seg.cuts_ms],
                                   "reason": seg.split_reason})
        out[c] = {
            "sessions": len(segs),
            "segments": n_seg,
            "cycles": n_cyc,
            "coverage_s": round(cov_ms / 1000.0, 3),
            "recording_s": round(rec_ms / 1000.0, 3),
            "coverage_frac": round(cov_ms / rec_ms, 4) if rec_ms else 0.0,
            "split_segments": splits,
            "cycles_per_group": {},
        }
        for s in segs:
            g = s.group
            ss = annotate_cycles(s, detect_segments(s))
            d = out[c]["cycles_per_group"].setdefault(g, {"sessions": 0, "segments": 0, "cycles": 0})
            d["sessions"] += 1
            for seg in ss:
                d["segments"] += 1
                d["cycles"] += seg.cycles
    return out


def sample_gap(stats_w100: dict, cov: dict, target: int = 500) -> dict:
    """估算「每类 >=target 个不重叠动作窗口」还需多少分钟录像。"""
    out = {}
    for c in (1, 2):
        w = stats_w100["per_class_named"].get("action1" if c == 1 else "action2", 0)
        stride = stats_w100["stride_ms"]
        win = stats_w100["win_ms"]
        # 非重叠窗口数 = 覆盖时长 / 窗长；重叠窗口数 * stride / win 是等价估计
        non_overlap = int(round(w * stride / win)) if win else w
        cov_frac = cov[c]["coverage_frac"] or 1.0
        # 每类不重叠窗口数 ≈ 覆盖秒数 * 10（100ms 窗）
        cur_cov = cov[c]["coverage_s"]
        need_cov = target / 10.0
        need_rec = need_cov / cov_frac if cov_frac > 0 else 0.0
        out[f"class{c}"] = {
            "windows_overlap": w,
            "windows_non_overlap_est": non_overlap,
            "coverage_s": cur_cov,
            "recording_s": cov[c]["recording_s"],
            "coverage_frac": cov_frac,
            "target_non_overlap": target,
            "needed_coverage_s": round(need_cov, 1),
            "needed_recording_s": round(need_rec, 1),
            "needed_recording_min": round(need_rec / 60.0, 2),
            "extra_recording_min": round(max(0.0, need_rec - cov[c]["recording_s"]) / 60.0, 2),
        }
    return out


def write_stats(sessions: list, out_dir: str) -> dict:
    windows = {}
    ds_by_win = {}
    for w in WINS_MS:
        ds = build_dataset(sessions, w)
        ds_by_win[w] = ds
        windows[str(w)] = window_stats(ds)
    cov = coverage_stats(sessions)
    w100 = windows[str(WIN_MS_DEFAULT)]
    # 固定留出方案：每类取一条 (3,18) 会话做测试（file_idx 最小的一条），其余训练
    theta = np.array([s.theta for s in sessions])
    delta = np.array([s.delta for s in sessions])
    action = np.array([s.action for s in sessions])
    test_files = []
    for c in (1, 2):
        cand = [s.name for s in sessions
                if s.action == c and s.theta == 3 and s.delta == 18]
        if cand:
            test_files.append(cand[0])
    train_files = [s.name for s in sessions if s.name not in test_files]
    test_windows = int(np.isin(ds_by_win[WIN_MS_DEFAULT]["meta"]["file"],
                               test_files).sum())
    deploy = {f"class{c}": {"windows": 0, "non_overlap_est": 0} for c in (1, 2)}
    for c in (1, 2):
        g = "theta3_delta18"
        n = w100["per_group"].get(g, {}).get("per_class", {}).get(str(c), 0)
        deploy[f"class{c}"]["windows"] = n
        deploy[f"class{c}"]["non_overlap_est"] = int(round(
            n * w100["stride_ms"] / w100["win_ms"])) if w100["win_ms"] else n
    stats = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "data_root": os.path.dirname(os.path.abspath(sessions[0].path)) if sessions else "",
        "grid": {"shift": GRID_SHIFT, "w": GRID_W, "h": GRID_H, "cells": N_CELLS},
        "channels": list(CHANNELS),
        "saturation": {"dtype": "int8", "max": SAT_MAX},
        "activity_detector": {
            "hi_events_per_frame": ACT_HI,
            "lo_events_per_frame": ACT_LO,
            "gap_ms": ACT_GAP_MS,
            "extend_ms": ACT_EXT_MS,
        },
        "cycle_split_heuristic": {
            "name": "envelope_dip",
            "min_segment_ms": ENV_MIN_SEG_MS,
            "dip_frac_of_peak": ENV_DIP_FRAC,
            "min_low_bins": ENV_MIN_LOW_BINS,
            "min_phase_ms": ENV_MIN_PHASE_MS,
            "bin_ms": BIN_MS,
            "note": "宁可少切：段长 >=2s 且平滑事件包络持续低于峰值 25% 才切；切点两侧各需 >=500ms 活动",
        },
        "sessions": [{
            "file": s.name,
            "action": s.action,
            "theta": s.theta,
            "delta": s.delta,
            "group": s.group,
            "events": int(len(s.t)),
            "frames": int(len(s.frame_times)),
            "duration_s": round(s.span_ms / 1000.0, 3),
            "fps": round(len(s.frame_times) / (s.span_ms / 1000.0), 2) if s.span_ms else 0,
            "events_per_s": round(len(s.t) / (s.span_ms / 1000.0), 1) if s.span_ms else 0,
        } for s in sessions],
        "coverage": {str(c): cov[c] for c in (1, 2)},
        "windows": windows,
        "holdout_plan": {
            "rule": "按会话文件整体切分（禁止按窗口随机切）；每类取 file_idx 最小的 (3,18) 会话做测试集，其余训练",
            "test_files": test_files,
            "train_files": train_files,
            "test_windows_w100": test_windows,
            "note": "单留出测试窗约 60~70 个，统计意义弱；M2 应另做留一参数组交叉验证",
        },
        "deployment_subset": {
            "group": "theta3_delta18",
            "note": "板卡部署参数 TH3/DL18",
            **deploy,
        },
        "sample_gap": sample_gap(w100, cov, target=500),
        "recommendation": {
            "grid_shift": 3,
            "grid_shift_reason": "GRID_SHIFT=2 => 100x60=6000 格，100ms 窗内大量格为 0（过稀）；GRID_SHIFT=4 => 25x15=375 格，手部空间细节丢失；=3（50x30）实测每窗每格 1~2 事件，与 uint16/int8 特征匹配",
            "win_ms": WIN_MS_DEFAULT,
            "win_ms_reason": "100ms ≈ 2.6 帧；200ms 会把时间分辨率降到 5Hz 并模糊开合过渡；150/200 作为逃生口已产出，主配置保持 100ms（板端特征更新率 10Hz）",
        },
    }
    path = os.path.join(out_dir, "stats.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    return stats


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _npy_bytes(arr) -> bytes:
    buf = io.BytesIO()
    np.lib.format.write_array(buf, np.asanyarray(arr), allow_pickle=False)
    return buf.getvalue()


def save_dataset(ds: dict, path: str) -> None:
    """写 .npz。自己压缩而不是 np.savez_compressed(..., file=...)：
    契约要求 meta 里有名为 file 的数组，与 savez 的 file 参数重名。"""
    arrays = {"X_counts": ds["X_counts"], "X_q": ds["X_q"], "y": ds["y"]}
    arrays.update(ds["meta"])
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for key, val in arrays.items():
            zf.writestr(str(key) + ".npy", _npy_bytes(val))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="构建视网膜事件窗口数据集")
    ap.add_argument("--data-root", default=r"E:\workspace\FPGA_Comp\row_datas\原始采集数据")
    ap.add_argument("--out-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--no-build", action="store_true", help="只重算 stats.json")
    args = ap.parse_args(argv)
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    sessions = discover_sessions(args.data_root)
    if not sessions:
        print(f"[FATAL] 未发现任何会话 CSV：{args.data_root}", file=sys.stderr)
        return 2
    print(f"[info] 会话 {len(sessions)} 个：")
    for s in sessions:
        print(f"  - {s.name} action={s.action} group={s.group} "
              f"events={len(s.t)} frames={len(s.frame_times)} span={s.span_ms / 1000.0:.2f}s")
    if not args.no_build:
        for w in WINS_MS:
            ds = build_dataset(sessions, w)
            name = f"dataset_w{w}.npz"
            save_dataset(ds, os.path.join(out_dir, name))
            if w == WIN_MS_DEFAULT:
                save_dataset(ds, os.path.join(out_dir, "dataset.npz"))
            print(f"[build] {name}: X_counts={ds['X_counts'].shape} "
                  f"y={ds['y'].shape} dtype={ds['X_counts'].dtype}/{ds['X_q'].dtype}")
    stats = write_stats(sessions, out_dir)
    w100 = stats["windows"]["100"]
    print("[stats] windows w100:", w100["n_windows"],
          w100["per_class_named"], "cells p50/p90/p99/max=",
          w100["cell"].get("class1", {}).get("ON_now"))
    print("[stats] coverage:", {c: {k: stats["coverage"][c][k]
                                    for k in ("segments", "cycles", "coverage_s")}
                                for c in ("1", "2")})
    print("[stats] cycles_per_group:",
          {c: stats["coverage"][c]["cycles_per_group"] for c in ("1", "2")})
    print("[stats] sample_gap:", json.dumps(stats["sample_gap"], ensure_ascii=False))
    print("[stats] deploy_subset:", json.dumps(stats["deployment_subset"], ensure_ascii=False))
    print("[stats] holdout test_files:", stats["holdout_plan"]["test_files"],
          "train:", len(stats["holdout_plan"]["train_files"]))
    # 契约自检
    ok = True
    ds = build_dataset(sessions, WIN_MS_DEFAULT)
    if list(ds["X_counts"].shape[1:]) != [4, GRID_H, GRID_W] or ds["X_counts"].dtype != np.uint16:
        ok = False
        print("[check] X_counts shape/dtype 不符", file=sys.stderr)
    if ds["X_q"].dtype != np.int8 or int(ds["X_q"].max(initial=0)) > SAT_MAX:
        ok = False
        print("[check] X_q dtype/饱和 不符", file=sys.stderr)
    if ds["y"].dtype != np.uint8 or any(int((ds["y"] == c).sum()) == 0 for c in (0, 1, 2)):
        ok = False
        print("[check] y dtype 或类别缺失", file=sys.stderr)
    for key in ("file", "session", "frame_ms", "group", "theta", "delta",
                "seg_start_frame", "seg_end_frame", "split_reason"):
        if key not in ds["meta"]:
            ok = False
            print(f"[check] meta 缺少 {key}", file=sys.stderr)
    if ok:
        print("DATASET_OK=1")
        print(f"DATASET w100 windows={w100['n_windows']} "
              f"per_class={w100['per_class_named']} "
              f"cycles={stats['coverage']['1']['cycles']}/"
              f"{stats['coverage']['2']['cycles']} "
              f"groups={ {g: w100['per_group'][g]['per_class'] for g in w100['per_group']} }")
        print("STATS_OK=1")
    else:
        print("DATASET_OK=0")
        print("STATS_OK=0")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
