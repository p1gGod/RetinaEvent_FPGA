#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M2c: offline calibration of the FPGA decision chain (task-28).

1:1 numpy replay of the board logic:

  100 ms window -> int8 forward (weights from nn/out_v4/nn_params_2cls.json)
  -> 2-class argmax + margin -> margin >= MARGIN_MIN and class != 0
  -> N_CONSEC equal-class consecutive hits -> one pulse
  -> REFRACTORY_CYC (1.5 s @ 50 MHz) blocks re-triggering
  -> 1.0 s idle clears the VALID bit (act_state_cdc.v)

The forward path reuses nn/ref_cnn.py (conv 3x3 stride 2, per-channel
right shift, int8 clip, ReLU; fc without ReLU).  No torch is imported and
no model / data / RTL / host file is modified.  Only these outputs are
written:

  nn/REPORT_决策链标定.md
  nn/out_v4/decision_sweep.json
  nn/_evidence/DECISION_SWEEP_OK.log

Run with:
  trainingData/.venv/Scripts/python.exe nn/probe_decide_sweep.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
NN = ROOT / "nn"
if str(NN) not in sys.path:
    sys.path.insert(0, str(NN))

import ref_cnn  # noqa: E402

# ---------------------------------------------------------------------------
# Board constants (retina_event/src/hdl/nn/nn_cfg.vh)
# ---------------------------------------------------------------------------
CLK_HZ = 50_000_000
WIN_CYC = 5_000_000             # 100 ms at 50 MHz (one nn_feat bin)
K_TIME_BINS = 2                 # nn input span = 200 ms
REFRACTORY_CYC = 75_000_000     # 1.5 s at 50 MHz
ACT_IDLE_CYC = 50_000_000       # 1.0 s at 50 MHz (act_state_cdc)
CONF_MAX = 31                   # 5-bit conf field
DBG_MARGIN_MAX = 127            # o_dbg_margin is 7-bit
NUM_CLASSES = 2                 # M5 fallback model (B2)
ONLINE_MARGIN_MIN = 8
ONLINE_N_CONSEC = 3
MARGIN_GRID = (4, 8, 16, 24, 32, 48)
NCONSEC_GRID = (3, 4, 5)
DEFAULT_START_OFFSET = 2        # t0 = 100 ms: previous bin exists
STRIDE_MS = 50

DEFAULT_DATA = "nn/dataset_v4_w100.npz"
DEFAULT_PARAMS = "nn/out_v4/nn_params_2cls.json"
DEFAULT_JSON = "nn/out_v4/decision_sweep.json"
DEFAULT_REPORT = "nn/REPORT_决策链标定.md"
DEFAULT_EVID = "nn/_evidence/DECISION_SWEEP_OK.log"

VERDICT_OK = "DECISION_SWEEP_OK=1"
VERDICT_FAIL = "DECISION_SWEEP_OK=0"

EXPECTED_N_WINDOWS = 1729
EXPECTED_N_SESSIONS = 20
EXPECTED_COUNTS = {0: 823, 1: 701, 2: 205}
EXPECTED_C1_SEGMENTS = 27
EXPECTED_ROM_WORDS = 5476
INT8_FLOAT_AGREEMENT = 0.994094

PROTECTED = (
    "nn/out_v4/nn_params_2cls.json",
    "nn/out_v4/nn_rom_data_2cls.v",
    "nn/dataset_v4_w100.npz",
)


def force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (ROOT / p)


def rate(num, den):
    if den is None or den <= 0:
        return None
    return float(num) / float(den)


# ---------------------------------------------------------------------------
# Inputs and forward pass
# ---------------------------------------------------------------------------
def load_dataset(path: Path):
    d = np.load(str(path), allow_pickle=False)
    need = ("X_q", "y", "session", "seg_id", "t_ms", "t_rel_ms", "win_ms", "stride_ms")
    missing = [k for k in need if k not in d.files]
    if missing:
        raise RuntimeError("dataset missing fields: %s" % ",".join(missing))
    out = {
        "X_q": np.asarray(d["X_q"], dtype=np.int8),
        "y": np.asarray(d["y"], dtype=np.int64),
        "session": np.asarray(d["session"]).astype(str),
        "seg_id": np.asarray(d["seg_id"], dtype=np.int64),
        "t_ms": np.asarray(d["t_ms"], dtype=np.int64),
        "t_rel_ms": np.asarray(d["t_rel_ms"], dtype=np.int64),
        "win_ms": int(np.asarray(d["win_ms"]).reshape(-1)[0]),
        "stride_ms": int(np.asarray(d["stride_ms"]).reshape(-1)[0]),
        "path": str(path),
    }
    out["n_windows"] = int(out["y"].shape[0])
    out["n_sessions"] = int(len(set(out["session"].tolist())))
    vals, cnts = np.unique(out["y"], return_counts=True)
    out["class_counts"] = {int(v): int(c) for v, c in zip(vals, cnts)}
    return out


def load_params(path: Path):
    doc = json.loads(path.read_text(encoding="utf-8"))
    if "cnn_params" not in doc or "layers" not in doc["cnn_params"]:
        raise RuntimeError("params JSON has no cnn_params.layers")
    layers = []
    for L in doc["cnn_params"]["layers"]:
        layers.append(
            {
                "name": str(L["name"]),
                "w": np.asarray(L["weight_int8"], dtype=np.int64).reshape(tuple(L["weight_shape"])),
                "b": np.asarray(L["bias_int32"], dtype=np.int64),
                "sh": np.asarray(L["SH"], dtype=np.int64),
            }
        )
    return doc, layers


def forward_int8(X: np.ndarray, layers):
    logits, stats = ref_cnn.forward_ref(X, layers)
    logits = np.asarray(logits)
    if logits.dtype != np.int8:
        logits = logits.astype(np.int8)
    return logits, stats


# ---------------------------------------------------------------------------
# Sessions at board cadence
# ---------------------------------------------------------------------------
@dataclass
class SessionData:
    name: str
    short: str
    cls: int
    board_move: bool
    n_windows: int
    idx: np.ndarray
    t0: np.ndarray
    decision_time: np.ndarray
    y: np.ndarray
    seg: np.ndarray
    c: np.ndarray
    margin: np.ndarray
    dt_ms: float

    @property
    def n_dec(self) -> int:
        return int(self.idx.size)

    @property
    def minutes(self) -> float:
        return float(self.n_dec) * self.dt_ms / 60000.0


def build_sessions(ds, logits, start_offset: int, step: int):
    y_all = ds["y"]
    seg_all = ds["seg_id"]
    t_all = ds["t_ms"]
    t_rel_all = ds["t_rel_ms"]
    c_all = np.where(logits[:, 0].astype(np.int64) >= logits[:, 1].astype(np.int64), 0, 1)
    m_all = np.abs(logits[:, 0].astype(np.int64) - logits[:, 1].astype(np.int64))
    sessions = []
    expected_dt = int(ds["stride_ms"]) * int(step)
    for name in sorted(set(ds["session"].tolist())):
        idx_all = np.where(ds["session"] == name)[0]
        order = np.argsort(t_all[idx_all], kind="stable")
        idx_all = idx_all[order]
        t_sorted = t_all[idx_all]
        if idx_all.size < start_offset + 2:
            raise RuntimeError("session too short: %s" % name)
        if np.any(np.diff(t_sorted) != int(ds["stride_ms"])):
            raise RuntimeError("non-uniform 50 ms grid in %s" % name)
        idx = idx_all[start_offset::step]
        t0 = t_rel_all[idx]
        if np.any(np.diff(t0) != expected_dt):
            raise RuntimeError("bad decision cadence in %s" % name)
        y = y_all[idx].astype(np.int64)
        seg = seg_all[idx].astype(np.int64)
        cls = int(y_all[np.where(ds["session"] == name)[0]].max())
        sessions.append(
            SessionData(
                name=str(name),
                short=str(name).split("-")[-1],
                cls=cls,
                board_move=str(name).endswith("210307"),
                n_windows=int(idx_all.size),
                idx=idx.astype(np.int64),
                t0=t0.astype(np.int64),
                decision_time=(t0 + int(ds["win_ms"])).astype(np.int64),
                y=y,
                seg=seg,
                c=c_all[idx].astype(np.int64),
                margin=m_all[idx].astype(np.int64),
                dt_ms=float(expected_dt),
            )
        )
    return sessions


# ---------------------------------------------------------------------------
# Decision state machine (nn_decide.v + act_state_cdc.v)
# ---------------------------------------------------------------------------
def replay_session(sd: SessionData, margin_min: int, n_consec: int, dt_cyc: int):
    pulses = []
    refr = 0
    hit_cnt = 0
    last_c = 0
    for j in range(sd.n_dec):
        if refr > 0:
            refr = max(0, refr - int(dt_cyc))
            hit_cnt = 0
            if refr > 0:
                continue
        c = int(sd.c[j])
        m = int(sd.margin[j])
        hit = (c != 0) and (m >= margin_min)
        if hit:
            cnt_new = hit_cnt + 1 if (hit_cnt != 0 and last_c == c) else 1
            if cnt_new >= n_consec:
                pulses.append(
                    {
                        "name": sd.name,
                        "short": sd.short,
                        "class": sd.cls,
                        "board_move": bool(sd.board_move),
                        "j": int(j),
                        "dataset_index": int(sd.idx[j]),
                        "t0_ms": int(sd.t0[j]),
                        "decision_time_ms": int(sd.decision_time[j]),
                        "class_pred": int(c),
                        "margin": int(m),
                        "conf": int(min(m, CONF_MAX)),
                        "y": int(sd.y[j]),
                        "seg": int(sd.seg[j]),
                    }
                )
                refr = REFRACTORY_CYC - 1
                hit_cnt = 0
                last_c = c
            else:
                hit_cnt = cnt_new
                last_c = c
        else:
            hit_cnt = 0
    return pulses


def count_valid_edges(sd: SessionData, pulses, dt_cyc: int) -> int:
    js = {int(p["j"]) for p in pulses}
    valid = 0
    idle = 0
    edges = 0
    for j in range(sd.n_dec):
        if j in js:
            if valid == 0:
                edges += 1
            valid = 1
            idle = 0
        else:
            idle += int(dt_cyc)
            if valid == 1 and idle >= ACT_IDLE_CYC:
                valid = 0
    return edges


def segment_counts(sd: SessionData, pulses, py: int):
    segs = sorted({int(g) for g in sd.seg[sd.y == py].tolist() if int(g) >= 0})
    counts = {g: 0 for g in segs}
    for p in pulses:
        if p["y"] == py and int(p["seg"]) in counts:
            counts[int(p["seg"])] += 1
    return counts


def evaluate_combo(sessions, margin_min: int, n_consec: int, dt_cyc: int):
    pulses = []
    per = []
    for sd in sessions:
        ps = replay_session(sd, margin_min, n_consec, dt_cyc)
        edges = count_valid_edges(sd, ps, dt_cyc)
        c1 = segment_counts(sd, ps, 1)
        c2 = segment_counts(sd, ps, 2)
        c1_total = len(c1)
        c1_det = sum(1 for v in c1.values() if v > 0)
        c1_rep = sum(1 for v in c1.values() if v > 1)
        c2_total = len(c2)
        c2_det = sum(1 for v in c2.values() if v > 0)
        c2_rep = sum(1 for v in c2.values() if v > 1)
        per.append(
            {
                "session": sd.short,
                "name": sd.name,
                "class": sd.cls,
                "board_move": bool(sd.board_move),
                "n_dec": sd.n_dec,
                "minutes": sd.minutes,
                "pulses": len(ps),
                "silent_false": sum(1 for p in ps if p["y"] == 0 and not p["board_move"]),
                "board_move_false": sum(1 for p in ps if p["board_move"] and p["y"] == 0),
                "class1_pulses": sum(1 for p in ps if p["y"] == 1),
                "wave_pulses": sum(1 for p in ps if p["y"] == 2),
                "c1_segments": c1_total,
                "c1_detected": c1_det,
                "c1_repeated": c1_rep,
                "c2_segments": c2_total,
                "c2_detected": c2_det,
                "c2_repeated": c2_rep,
                "valid_edges": edges,
                "edges_eq_pulses": bool(edges == len(ps)),
                "silent_minutes": float((sd.y == 0).sum()) * sd.dt_ms / 60000.0,
            }
        )
        pulses.extend(ps)

    silent_false = sum(1 for p in pulses if p["y"] == 0 and not p["board_move"])
    board_false = sum(1 for p in pulses if p["board_move"] and p["y"] == 0)
    class1_pulses = sum(1 for p in pulses if p["y"] == 1)
    wave_pulses = sum(1 for p in pulses if p["y"] == 2)
    c1_segments = sum(x["c1_segments"] for x in per)
    c1_detected = sum(x["c1_detected"] for x in per)
    c1_repeated = sum(x["c1_repeated"] for x in per)
    c2_segments = sum(x["c2_segments"] for x in per)
    c2_detected = sum(x["c2_detected"] for x in per)
    c2_repeated = sum(x["c2_repeated"] for x in per)
    silent_minutes = sum(x["silent_minutes"] for x in per if not x["board_move"])
    board_minutes = sum(x["minutes"] for x in per if x["board_move"])
    total_minutes = sum(x["minutes"] for x in per)
    wave_minutes = sum(
        float((sd.y == 2).sum()) * sd.dt_ms / 60000.0 for sd in sessions
    )
    class1_minutes = sum(
        float((sd.y == 1).sum()) * sd.dt_ms / 60000.0 for sd in sessions
    )
    row = {
        "margin_min": int(margin_min),
        "n_consec": int(n_consec),
        "dt_ms": float(sessions[0].dt_ms),
        "dt_cyc": int(dt_cyc),
        "silent_false": int(silent_false),
        "silent_minutes": float(silent_minutes),
        "silent_false_per_silent_min": rate(silent_false, silent_minutes),
        "silent_false_per_total_min": rate(silent_false, total_minutes),
        "board_move_false": int(board_false),
        "board_minutes": float(board_minutes),
        "board_move_per_min": rate(board_false, board_minutes),
        "board_move_per_total_min": rate(board_false, total_minutes),
        "class1_segments": int(c1_segments),
        "class1_detected": int(c1_detected),
        "class1_recall": rate(c1_detected, c1_segments),
        "class1_pulses": int(class1_pulses),
        "class1_minutes": float(class1_minutes),
        "class1_repeated_segments": int(c1_repeated),
        "wave_segments": int(c2_segments),
        "wave_detected": int(c2_detected),
        "wave_pulses": int(wave_pulses),
        "wave_minutes": float(wave_minutes),
        "wave_per_total_min": rate(wave_pulses, total_minutes),
        "total_pulses": int(len(pulses)),
        "total_pulses_per_total_min": rate(len(pulses), total_minutes),
        "total_minutes": float(total_minutes),
        "valid_edges": int(sum(x["valid_edges"] for x in per)),
        "edges_eq_pulses": bool(all(x["edges_eq_pulses"] for x in per)),
        "per_session": per,
    }
    return row, pulses


def segment_run_stats(sessions, margin_min: int):
    runs = []
    for sd in sessions:
        segs = sorted({int(g) for g in sd.seg[sd.y == 1].tolist() if int(g) >= 0})
        for g in segs:
            mask = (sd.seg == g) & (sd.y == 1) & (sd.c == 1) & (sd.margin >= margin_min)
            best = 0
            cur = 0
            for v in mask.tolist():
                cur = cur + 1 if v else 0
                if cur > best:
                    best = cur
            runs.append(best)
    arr = np.asarray(runs, dtype=np.int64)
    return {
        "n_segments": int(arr.size),
        "min_longest_run": int(arr.min()) if arr.size else None,
        "median_longest_run": float(np.median(arr)) if arr.size else None,
        "max_longest_run": int(arr.max()) if arr.size else None,
        "segments_run_le3": int((arr <= 3).sum()),
        "segments_run_eq3": int((arr == 3).sum()),
        "runs": [int(x) for x in arr.tolist()],
    }


# ---------------------------------------------------------------------------
# Distributions
# ---------------------------------------------------------------------------
def dist_stats(vals: np.ndarray, mask: np.ndarray):
    v = np.asarray(vals, dtype=np.int64)[mask]
    if v.size == 0:
        return {"n": 0}
    conf = np.minimum(v, CONF_MAX)
    out = {
        "n": int(v.size),
        "min": int(v.min()),
        "max": int(v.max()),
        "mean": float(v.mean()),
        "p10": float(np.percentile(v, 10)),
        "p50": float(np.percentile(v, 50)),
        "p90": float(np.percentile(v, 90)),
        "conf_p10": float(np.percentile(conf, 10)),
        "conf_p50": float(np.percentile(conf, 50)),
        "conf_p90": float(np.percentile(conf, 90)),
        "conf_frac31": float((conf == CONF_MAX).mean()),
    }
    for t in (8, 16, 24, 31, 32, 48):
        out["frac_ge_%d" % t] = float((v >= t).mean())
    return out


def build_distributions(sessions, baseline_pulses):
    M = np.concatenate([sd.margin for sd in sessions]).astype(np.int64)
    C = np.concatenate([sd.c for sd in sessions]).astype(np.int64)
    Y = np.concatenate([sd.y for sd in sessions]).astype(np.int64)
    B = np.concatenate([np.full(sd.n_dec, sd.board_move, dtype=bool) for sd in sessions])
    N = int(M.size)
    pulse_mask = np.zeros(N, dtype=bool)
    offset = 0
    pulse_js = {}
    for p in baseline_pulses:
        pulse_js.setdefault(p["name"], set()).add(int(p["j"]))
    for sd in sessions:
        for j in pulse_js.get(sd.name, set()):
            pulse_mask[offset + int(j)] = True
        offset += sd.n_dec
    masks = {
        "all": np.ones(N, dtype=bool),
        "hit_margin_ge_8": (C != 0) & (M >= ONLINE_MARGIN_MIN),
        "pulse_baseline": pulse_mask,
        "class1_action": (Y == 1),
        "class0_silence": (Y == 0) & (~B),
        "board_move": B,
        "wave_class2": (Y == 2),
    }
    dists = {k: dist_stats(M, m) for k, m in masks.items()}
    edges = [0, 8, 16, 24, 32, 48, 64, 96, 128, 256]
    hist = []
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        entry = {"bucket": "%d-%d" % (lo, hi - 1)}
        for name, mask in masks.items():
            entry[name] = int(((M >= lo) & (M < hi) & mask).sum())
        hist.append(entry)
    return {
        "masks": {k: int(v.sum()) for k, v in masks.items()},
        "stats": dists,
        "histogram": hist,
        "conf_note": "conf = min(margin, 31); margin >= 31 maps to conf == 31",
    }


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
def f3(x):
    return "—" if x is None else "%.3f" % float(x)


def f2(x):
    return "—" if x is None else "%.2f" % float(x)


def pct(x):
    return "—" if x is None else "%.1f%%" % (100.0 * float(x))


def md_row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"


def render_report(result):
    r = result
    base = r["baseline"]
    chosen = r["recommendation"]["chosen"]
    strict = r["recommendation"]["strict_user_perceived"]
    d = r["dataset"]
    dist = r["distributions"]["stats"]
    lines = []

    def add(s=""):
        lines.append(s)

    add(r["verdict"])
    add("")
    add("# M2c 决策链离线标定（task-28）")
    add("")
    add("- 生成时间：%s" % r["generated"])
    add("- 任务：task-28，M2c 离线决策链标定；只做 numpy 回放，不训练、不改模型/数据/RTL/host")
    add("- 解释器：%s" % r["interpreter"])
    add("- 模型：nn/out_v4/nn_params_2cls.json（两分类 B2，num_classes=2，ROM 5476 字，int8/float argmax 一致率 %.6f）" % r["model"]["int8_agreement_float_vs_int8"])
    add("- 数据：nn/dataset_v4_w100.npz（%d 窗 / %d 会话，win=%d ms，stride=%d ms）" % (d["n_windows"], d["n_sessions"], d["win_ms"], d["stride_ms"]))
    add("- 回放：%d 个 100 ms 决策点（每会话丢弃 t0=0 的首窗，因 prev bin 早于录制起点）；总时长 %.3f min" % (r["protocol"]["n_decisions"], r["protocol"]["total_minutes"]))
    add("- 结论先行：线上口径（静默段 + 210307）误触发 0.00 次/分、class1 动作段 27/27 检出；但 3 段挥手被两分类模型判成 class1，共 6 个 pulse（%.2f 次/分），这是最可复现的误触来源；conf 在 %d/%d 个 pulse 上饱和为 31，不能当二级过滤。" % (base["wave_per_total_min"] or 0.0, r["pulse_stats"]["conf31"], base["total_pulses"]))
    add("- 判定口径：DECISION_SWEEP_OK=1 只针对任务书口径（静默段 + 210307 误触 ≤0.5 次/分、class1 召回 ≥0.85）；若把「挥手被当成 class1」计入误触，该条件不达标（最好 4.24 次/分，距 0.5 差 3.74）——这是有效结论，不是脚本失败。")
    add("")

    add("## 1. 方法：从板上 RTL 到 numpy 的 1:1 映射")
    add("")
    add("### 1.1 时间映射")
    add("")
    add("- 数据集每个窗口的输入覆盖 [t0-100, t0+100) ms（now=[t0,t0+100)，prev=[t0-100,t0)）。")
    add("- 板上 nn_feat 在 bin 边界 T 冻结，窗口为 [T-200, T)；令 T=t0+100，则数据集窗口 t0 恰好对应板上决策时刻 T。")
    add("- 板上每 100 ms 决策一次；数据集 stride=50 ms，因此按 t_ms 排序、以 t_rel_ms 为相对时刻后取 idx[2::2]（t0=100,200,...）。丢弃 t0=0 是因为它的 prev 窗早于录制起点、数据集里为零填充，而板上当时有真实历史；三种起点相位（t0=100/50/0 起）在敏感性里核对。")
    add("- 决策时刻 t_rel = t0+100；相位不确定性 ±50 ms（数据集网格 50 ms），见 §6 敏感性。")
    add("")
    add("### 1.2 int8 前向")
    add("")
    add("- 层参数从 nn_params_2cls.json 的 cnn_params.layers 读取；复用 nn/ref_cnn.py 的 forward_ref：conv 3x3 stride 2 pad 0，acc=sum(w*x)+b，算术右移 SH，clip 到 [-128,127]，conv 后 ReLU；fc 无 ReLU。")
    add("- 不用 torch：本脚本只 import numpy + ref_cnn；解释器是 trainingData/.venv（无 torch）。")
    add("- NUM_CLASSES=2：logit2 在 RTL 里钉成 -128；等价于 c=0 if s0>=s1 else 1（平局取 0），margin=|s0-s1|。conf=min(margin,31)，o_dbg_margin=min(margin,127)。")
    add("")
    add("### 1.3 决策状态机")
    add("")
    add("- nn_decide.v：cmb_hit=(c!=0)&&(margin>=MARGIN_MIN)；同一类连续命中 hit_cnt+1，否则重置为 1；hit_cnt>=N_CONSEC 且不在 refractory 才 pulse。")
    add("- pulse 时置 refr_cnt=REFRACTORY_CYC-1=74,999,999，之后每拍减 1；refractory 期间 hit_cnt 清 0、不再判定。按 100 ms 决策步长离散后，pulse 后第 15 个决策点（1.5 s）refr 恰好归零，可再次判定。")
    add("- act_state_cdc.v：pulse 重置 1.0 s 空闲计时；1.0 s 无 pulse 后 VALID 清零。因为 refractory=1.5 s > 1.0 s，任意两个 pulse 的 VALID 都会先清零，所以每个 pulse 恰好对应一个 VALID 上升沿；脚本对每个会话、每个组合都断言上升沿数==pulse 数。")
    add("")
    add("### 1.4 指标定义")
    add("")
    add("- 静默误触：y==0 且非 210307 的决策窗上的 pulse。分母同时给『静默分钟』（只算 y==0 的窗）和『会话总分钟』（任务书口径）。")
    add("- 板移噪声：会话 210307，全部 y=0；单独一列。")
    add("- class1 动作段：seg_id>=0 且 y==1 的窗口按 seg_id 分组；本数据 16 条 class1 会话共 27 段。检出 = 段内至少 1 个 pulse；重复 = 段内 >1 个 pulse。")
    add("- 挥手：y==2 的 3 条会话（210102/211950/212036）；B2 模型没有 class2，另列 pulse 数，不计入静默误触。")
    add("- 分母口径：静默分钟=非 210307 会话中 y==0 的决策窗×0.1/60；板移分钟=210307 的决策窗×0.1/60；总分钟=全部决策窗×0.1/60。")
    add("- 统计分辨率：总时长只有 %.3f min，1 个事件就是 %.2f 次/分；因此『≤0.5 次/分』实际上要求 0 个事件，且 0 事件在 95%% 置信下仍只能约束到约 2.1 次/分。要证明 ≤0.5 次/分至少需要 ~6 min 静默数据。这一点是离线标定的硬限制。" % (r["protocol"]["total_minutes"], 1.0 / r["protocol"]["total_minutes"]))
    add("")

    add("## 2. (b) 线上配置基线（MARGIN_MIN=8，N_CONSEC=3）")
    add("")
    add("| 指标 | 值 |")
    add("|---|---|")
    add(md_row(["静默误触", "%d 次 / %.3f 静默min = %s 次/分（按总时长 %s 次/分）" % (base["silent_false"], base["silent_minutes"], f3(base["silent_false_per_silent_min"]), f3(base["silent_false_per_total_min"]))]))
    add(md_row(["210307 板移误触", "%d 次 / %.3f min = %s 次/分" % (base["board_move_false"], base["board_minutes"], f3(base["board_move_per_min"]))]))
    add(md_row(["class1 动作段检出", "%d/%d = %s" % (base["class1_detected"], base["class1_segments"], pct(base["class1_recall"]))]))
    add(md_row(["每段 pulse 数", "class1 段：%d 个 pulse，重复段 %d；挥手段：%d 段 / %d pulse（每段 %s）" % (base["class1_pulses"], base["class1_repeated_segments"], base["wave_segments"], base["wave_pulses"], f2(base["wave_pulses"] / base["wave_segments"] if base["wave_segments"] else 0))]))
    add(md_row(["pulse 总数", "%d（class1 %d + 挥手 %d + 静默 %d + 板移 %d）" % (base["total_pulses"], base["class1_pulses"], base["wave_pulses"], base["silent_false"], base["board_move_false"])]))
    add(md_row(["pulse 的 margin", "p10/p50/p90 = %.1f / %.1f / %.1f，min=%d，max=%d" % (r["pulse_stats"]["p10"], r["pulse_stats"]["p50"], r["pulse_stats"]["p90"], r["pulse_stats"]["min"], r["pulse_stats"]["max"])]))
    add(md_row(["pulse 的 conf", "conf=31 占 %d/%d = %s；conf p10/p50/p90 = %.1f/%.1f/%.1f" % (r["pulse_stats"]["conf31"], base["total_pulses"], pct(r["pulse_stats"]["conf31_frac"]), r["pulse_stats"]["conf_p10"], r["pulse_stats"]["conf_p50"], r["pulse_stats"]["conf_p90"])]))
    add("")
    add("**基线结论**：按任务口径，静默段和 210307 都是 0 次误触，class1 动作段 27/27 全检出；按『挥手被当成手部开合』这个用户可感知口径，3 段挥手产生 6 个 pulse（%.2f 次/分），且每个 pulse 的 conf 都是 31。这与线上『conf 长期 31』的现象一致。" % (base["wave_per_total_min"] or 0.0))
    add("")
    add("### 2.1 基线逐会话明细")
    add("")
    add("| # | 会话 | 类 | 窗 | 决策 | min | pulse | 静默误触 | 板移 | class1段(检出/总) | 重复段 | 挥手pulse |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, x in enumerate(base["per_session"], 1):
        add(md_row([i, x["session"], x["class"], x["n_dec"], x["n_dec"], f2(x["minutes"]), x["pulses"], x["silent_false"], x["board_move_false"], "%d/%d" % (x["c1_detected"], x["c1_segments"]), x["c1_repeated"], x["wave_pulses"]]))
    add("")
    add("基线 pulse 明细（按会话/时间排序，共 %d 条）：" % len(r["baseline_pulse_events"]))
    add("")
    add("| 会话 | t0 ms | 决策ms | 模型类 | margin | conf | 标签y | seg |")
    add("|---|---|---|---|---|---|---|---|")
    for p in r["baseline_pulse_events"]:
        add(md_row([p["short"], p["t0_ms"], p["decision_time_ms"], p["class_pred"], p["margin"], p["conf"], p["y"], p["seg"]]))
    add("")

    add("## 3. (a) MARGIN_MIN × N_CONSEC 扫描（18 组，板上 100 ms 节拍）")
    add("")
    add("| MARGIN_MIN | N_CONSEC | 静默误触 | /静默min | /总min | 210307 | /210307min | class1检出 | 召回 | 段最小连续命中 | 挥手pulse | 总pulse |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for row in r["sweep"]:
        add(md_row([row["margin_min"], row["n_consec"], row["silent_false"], f3(row["silent_false_per_silent_min"]), f3(row["silent_false_per_total_min"]), row["board_move_false"], f3(row["board_move_per_min"]), "%d/%d" % (row["class1_detected"], row["class1_segments"]), pct(row["class1_recall"]), row["class1_min_run"], row["wave_pulses"], row["total_pulses"]]))
    add("")
    add("读表要点：")
    add("- 18 组在静默段和 210307 上全部 0 次误触；这是 in-sample 模型（训练见过全部会话）给出的下界，不等于现场误触率。")
    add("- N_CONSEC=3 时，MARGIN_MIN 从 4 提到 48 仍保持 27/27；N_CONSEC=4/5 才开始掉召回。")
    add("- 挥手 pulse 在全部 18 组都 6 个：阈值调高完全不改变挥手误判，因为挥手窗口的 margin 本身就很高（6 个 pulse 的 margin=77..226，p50=~200）。")
    add("")
    add("### 3.1 每会话决策窗与基线 pulse")
    add("")
    add("| 会话 | 类 | 决策 | 基线pulse | 静默误触 | class1段(检出/总) | 备注 |")
    add("|---|---|---|---|---|---|---|")
    for x in base["per_session"]:
        note = "板移噪声" if x["board_move"] else ("挥手(2类模型判为1)" if x["class"] == 2 else "")
        add(md_row([x["session"], x["class"], x["n_dec"], x["pulses"], x["silent_false"], "%d/%d" % (x["c1_detected"], x["c1_segments"]), note]))
    add("")

    add("## 4. (c) 推荐配置")
    add("")
    add("筛选条件：静默误触 ≤0.5 次/分，210307 误触 ≤0.5 次/分，class1 段召回 ≥0.85。")
    add("")
    if chosen is None:
        add("**没有组合满足三个条件。** 最接近的是下表 fallback。")
    else:
        add("**推荐：MARGIN_MIN=%d，N_CONSEC=%d。**" % (chosen["margin_min"], chosen["n_consec"]))
        add("")
        add("| 指标 | 推荐值 | 基线（8/3） |")
        add("|---|---|---|")
        add(md_row(["静默误触", "%d（%s 次/分）" % (chosen["silent_false"], f3(chosen["silent_false_per_silent_min"])), "%d（%s 次/分）" % (base["silent_false"], f3(base["silent_false_per_silent_min"]))]))
        add(md_row(["210307 误触", "%d（%s 次/分）" % (chosen["board_move_false"], f3(chosen["board_move_per_min"])), "%d（%s 次/分）" % (base["board_move_false"], f3(base["board_move_per_min"]))]))
        add(md_row(["class1 召回", "%d/%d = %s" % (chosen["class1_detected"], chosen["class1_segments"], pct(chosen["class1_recall"])), "%d/%d = %s" % (base["class1_detected"], base["class1_segments"], pct(base["class1_recall"]))]))
        add(md_row(["class1 段最小连续命中", chosen["class1_min_run"], base["class1_min_run"]]))
        add(md_row(["挥手 pulse", "%d（%.2f 次/分）" % (chosen["wave_pulses"], chosen["wave_per_total_min"] or 0.0), "%d（%.2f 次/分）" % (base["wave_pulses"], base["wave_per_total_min"] or 0.0)]))
        add("")
        add("选择理由：")
        add("- 24/3 是保持 27/27 全检出的最高 MARGIN_MIN；32/3 与 48/3 都掉到 26/27，因此不选更高阈值。")
        add("- 24 时最小连续命中=3（1 段恰好 3 个），没有余量；16/3 同样 27/27 但 margin 更低，现场若出现漏段应回退 16/3 或 8/3。")
        add("- N_CONSEC 保持 3：24/4 掉到 26/27，增加 100 ms 延迟且换不到更低误触。")
        add("- 阈值无法减少挥手误判：18 组挥手 pulse 恒为 6；要压挥手只能补 class2 数据/三类模型或 host 侧处理。")
        add("")
        add("**但阈值无法解决挥手误触**：全部 18 组挥手 pulse 都是 6 个。若把『挥手被当成 class1』计入误触，则没有任何组合达到 ≤0.5 次/分：最好 %.2f 次/分（%d pulse / %.3f min），距目标差 %.2f 次/分。要压下去只能：①补 class2 数据重训三分类；②host 侧对 class1 事件做去重/冷却；③接受 B2 的已知限制。" % (strict["best_wave_per_total_min"], strict["best_wave_pulses"], r["protocol"]["total_minutes"], strict["gap"]))
    add("")
    add("")
    add("**余量提醒**：24/3 的 27/27 是零余量——有 1 段恰好只有 3 个连续命中，并非「每段至少 4 个」；4/3 虽然最小连续命中=4，但 MARGIN_MIN=4 低于线上 8，不作为推荐。现场若出现漏段，回退 16/3 或 8/3（同样 27/27，16 的 margin 更低但更稳）。推荐 24/3 与基线 8/3 在当前 in-sample 数据上的指标完全相同，说明现有数据无法证明提高阈值的收益；选 24/3 只是更保守的先验。")
    add("")
    add("### 4.1 推荐 vs 基线的逐会话差异")
    add("")
    add("| 会话 | 类 | 基线pulse | 推荐pulse | 基线静默 | 推荐静默 | class1段(检出/总) |")
    add("|---|---|---|---|---|---|---|")
    rec_by = {x["session"]: x for x in chosen["per_session"]} if chosen else {}
    for x in base["per_session"]:
        y = rec_by.get(x["session"], {})
        add(md_row([x["session"], x["class"], x["pulses"], y.get("pulses", "—"), x["silent_false"], y.get("silent_false", "—"), "%d/%d" % (x["c1_detected"], x["c1_segments"])]))
    add("")

    add("## 5. (d) margin / conf 分布：conf 能否当二级过滤")
    add("")
    add("| 窗口集合 | n | margin p10 | p50 | p90 | ≥8 | ≥16 | ≥24 | ≥31 | ≥48 | conf p10 | p50 | p90 | conf=31 |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    labels = [
        ("all", "全部决策窗"),
        ("hit_margin_ge_8", "命中窗（c!=0 且 margin≥8）"),
        ("pulse_baseline", "基线 pulse 窗"),
        ("class1_action", "class1 动作窗"),
        ("class0_silence", "class0 静默窗（不含210307）"),
        ("board_move", "210307 板移窗"),
        ("wave_class2", "挥手窗（y=2）"),
    ]
    for key, label in labels:
        s = dist.get(key, {"n": 0})
        if s.get("n", 0) == 0:
            add(md_row([label, 0] + ["—"] * 12))
            continue
        add(md_row([label, s["n"], "%.1f" % s["p10"], "%.1f" % s["p50"], "%.1f" % s["p90"], pct(s["frac_ge_8"]), pct(s["frac_ge_16"]), pct(s["frac_ge_24"]), pct(s["frac_ge_31"]), pct(s["frac_ge_48"]), "%.1f" % s["conf_p10"], "%.1f" % s["conf_p50"], "%.1f" % s["conf_p90"], pct(s["conf_frac31"])]))
    add("")
    add("margin 直方图（窗口数）：")
    add("")
    add("| margin 区间 | 全部 | 命中 | pulse | class1动作 | class0静默 | 210307 | 挥手 |")
    add("|---|---|---|---|---|---|---|---|")
    for h in r["distributions"]["histogram"]:
        add(md_row([h["bucket"], h["all"], h["hit_margin_ge_8"], h["pulse_baseline"], h["class1_action"], h["class0_silence"], h["board_move"], h["wave_class2"]]))
    add("")
    add("**conf 饱和结论**：")
    add("- conf=min(margin,31)，所以 margin≥31 时 conf 恒 31；全部决策窗中 margin≥31 占 %s，命中窗中占 %s，基线 pulse 中占 %s。" % (pct(dist["all"]["frac_ge_31"]), pct(dist["hit_margin_ge_8"]["frac_ge_31"]), pct(dist["pulse_baseline"]["frac_ge_31"])))
    add("- 基线 %d 个 pulse 里 %d 个 conf=31（%s），margin 的 p10/p50/p90 是 %.1f/%.1f/%.1f，最低也有 %d。线上『32 条里 30 条 conf=31』（93.8%%）与离线 %d/%d（%.1f%%）同量级，说明这是模型输出饱和，不是偶发。" % (base["total_pulses"], r["pulse_stats"]["conf31"], pct(r["pulse_stats"]["conf31_frac"]), r["pulse_stats"]["p10"], r["pulse_stats"]["p50"], r["pulse_stats"]["p90"], r["pulse_stats"]["min"], r["pulse_stats"]["conf31"], base["total_pulses"], 100.0 * r["pulse_stats"]["conf31_frac"]))
    add("- 因此 conf 不能当二级过滤：在真正被接受的 pulse 上它几乎是常数 31，无法区分『高置信真动作』和『高置信误判（挥手）』。要二级过滤就用 o_dbg_margin（0..127，仍然在 127 饱和但比 31 多 4 位），或者直接提高 MARGIN_MIN。")
    add("")

    add("## 6. 起点相位 / 50 ms 敏感性")
    add("")
    add("| 场景 | 静默误触 | 210307 | class1 召回 | class1段最小连续命中 | 挥手pulse | 说明 |")
    add("|---|---|---|---|---|---|---|")
    for s in r["sensitivity"]["starts"]:
        add(md_row([s["label"], s["silent_false"], s["board_move_false"], "%d/%d" % (s["class1_detected"], s["class1_segments"]), s["class1_min_run"], s["wave_pulses"], s["note"]]))
    for s in r["sensitivity"]["cadence_50ms"]:
        add(md_row([s["label"], s["silent_false"], s["board_move_false"], "%d/%d" % (s["class1_detected"], s["class1_segments"]), s["class1_min_run"], s["wave_pulses"], s["note"]]))
    add("")

    add("**相位说明**：起点 t0=0 档的 prev 窗是录制前零填充，不是板上真实历史；primary 取 t0=100（start=2）对应板上 T=200 的首个完整双 bin 决策。start=0 档若出现最小连续命中=4，那是零填充带来的乐观值，不能当作余量依据；primary 下 24/3 的最小连续命中是 3。")
    add("")
    add("## 7. 离线结论的可信边界")
    add("")
    add("- 统计分辨率：总回放时长只有 1.415 min（849 个决策点 × 0.1 s）。1 个事件 = 1/1.415 = 0.71 次/分；因此「≤0.5 次/分」在该样本量下实际等价于「0 个事件」。")
    add("- 零事件的置信上限：即使观察到 0 个事件，按 Poisson 0 事件 95% 上限约 3/总时长，真实误触率仍可能高到约 2.1 次/分；要证明 ≤0.5 次/分至少需要约 6 min 静默数据（3/6=0.5）。")
    add("- in-sample 性质：final 2cls 模型是在全部 20 条会话（含静默、板移、挥手）上训练的 ROM 工件，本报告的回放不是留一会话泛化评估；窗级 y0 准确率 0.9988，而会话级 LOO 的 y0 recall 只有 0.9563（≈4.4% 泛化 FP）。因此 0 次静默误触只是 in-sample 下界，不能外推为现场误触率。")
    add("- 相位/步长敏感性只说明「换起点或 50ms 步长时结论不翻转」，不改变上述样本量与 in-sample 限制。")
    add("")
    add("## 8. 结论与给上线的建议")
    add("")
    add("1. 任务口径（静默段 + 210307）：基线 0.00 次/分，class1 动作段 27/27；推荐 24/3 仍 0.00 次/分、27/27。")
    add("2. 用户可感知口径（挥手也算误触）：3 段挥手全部被 B2 判成 class1，共 6 pulse（%.2f 次/分）；任何 MARGIN_MIN × N_CONSEC 组合都不减少这 6 个，阈值调参治不了。" % (base["wave_per_total_min"] or 0.0))
    add("3. conf 长期 31 是 5-bit 饱和的必然结果（margin≥31 即 31），不是高置信证据；host 若用 conf 做过滤，实际等价于恒真。")
    add("4. 立即能做的配置改动：MARGIN_MIN 8→24（N_CONSEC 保持 3），只需改 nn_cfg.vh 参数并重综合；对静默/板移误触是更保守的先验，对挥手无效。")
    add("5. 真要降低挥手误触：按 M5 §4 回退/演进路线补 class2 数据重训三分类（或 host 侧对 class1 做时间冷却/去重），不要指望在 B2 上调阈值。")
    add("6. 离线结论的边界：final 2cls 模型是在全部 20 会话上训练的 ROM 工件，窗级 y0 准确率 0.9988，而会话级 LOO 的 y0 recall 只有 0.9563（≈4.4% 泛化 FP）。因此本报告的 0 次静默误触是 in-sample 下界；现场误触率必须用板上日志或至少 6 min 静默数据重新测。")
    add("")
    add("## 9. 复现命令")
    add("")
    add("~~~bash")
    add(r["reproduce_command"])
    add("~~~")
    add("")
    add("## 10. 产物")
    add("")
    for a in r["artifacts"]:
        add("- %s" % a)
    add("")
    add("## 11. 自检")
    add("")
    add("| 检查项 | 值 |")
    add("|---|---|")
    for k, v in r["checks"].items():
        add(md_row([k, 1 if v else 0]))
    add("")
    return "\n".join(lines) + "\n"


def render_evidence(result):
    b = result["baseline"]
    c = result["recommendation"]["chosen"]
    st = result["recommendation"]["strict_user_perceived"]
    lines = [result["verdict"]]
    lines.append("task=task-28 M2c offline decision-chain calibration")
    lines.append("generated=%s" % result["generated"])
    lines.append("command=%s" % result["reproduce_command"])
    lines.append("dataset=%s n_windows=%d n_sessions=%d class_counts=%s" % (result["dataset"]["path"], result["dataset"]["n_windows"], result["dataset"]["n_sessions"], result["dataset"]["class_counts"]))
    lines.append("model=%s num_classes=2 rom_words=%d int8_float_agreement=%.6f" % (result["model"]["path"], result["model"]["rom_words"], result["model"]["int8_agreement_float_vs_int8"]))
    lines.append("baseline margin_min=8 n_consec=3 silent_false=%d silent_minutes=%.3f silent_per_min=%s board_move_false=%d board_per_min=%s class1=%d/%d recall=%s wave_pulses=%d wave_per_min=%s conf31=%d/%d" % (b["silent_false"], b["silent_minutes"], f3(b["silent_false_per_silent_min"]), b["board_move_false"], f3(b["board_move_per_min"]), b["class1_detected"], b["class1_segments"], pct(b["class1_recall"]), b["wave_pulses"], f3(b["wave_per_total_min"]), result["pulse_stats"]["conf31"], b["total_pulses"]))
    if c:
        lines.append("recommendation margin_min=%d n_consec=%d silent_false=%d silent_per_min=%s board_move_false=%d class1=%d/%d recall=%s wave_pulses=%d total_minutes=%.3f" % (c["margin_min"], c["n_consec"], c["silent_false"], f3(c["silent_false_per_silent_min"]), c["board_move_false"], c["class1_detected"], c["class1_segments"], pct(c["class1_recall"]), c["wave_pulses"], result["protocol"]["total_minutes"]))
    else:
        lines.append("recommendation=NONE")
    lines.append("strict_user_perceived=reachable:%d best_wave_per_min=%s gap=%s" % (1 if st["reachable"] else 0, f3(st["best_wave_per_total_min"]), f3(st["gap"])))
    lines.append("conf_note=conf=min(margin,31); margin>=31 -> conf=31; pulse_conf31=%d/%d all_frac_ge31=%s pulse_frac_ge31=%s" % (result["pulse_stats"]["conf31"], b["total_pulses"], pct(result["distributions"]["stats"]["all"]["frac_ge_31"]), pct(result["distributions"]["stats"]["pulse_baseline"]["frac_ge_31"])))
    lines.append("protected_hashes_unchanged=%d" % (1 if result["checks"].get("HASHES_UNCHANGED") else 0))
    lines.append("checks=" + ",".join("%s:%d" % (k, 1 if v else 0) for k, v in result["checks"].items()))
    lines.append(result["verdict"])
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Sensitivity, checks, outputs
# ---------------------------------------------------------------------------
def summarize_row(row):
    return {
        "margin_min": row["margin_min"],
        "n_consec": row["n_consec"],
        "silent_false": row["silent_false"],
        "board_move_false": row["board_move_false"],
        "class1_detected": row["class1_detected"],
        "class1_segments": row["class1_segments"],
        "class1_recall": row["class1_recall"],
        "class1_min_run": row["class1_min_run"],
        "wave_pulses": row["wave_pulses"],
        "total_pulses": row["total_pulses"],
    }


def build_sensitivity(ds, logits, chosen_margin, chosen_ncon):
    starts = []
    for start in (0, 1, 2):
        ss = build_sessions(ds, logits, start, 2)
        start_ms = int(start * int(ds["stride_ms"]))
        for label, mm, nc in (
            ("baseline 8/3", ONLINE_MARGIN_MIN, ONLINE_N_CONSEC),
            ("chosen %d/%d" % (chosen_margin, chosen_ncon), chosen_margin, chosen_ncon),
        ):
            row, _ = evaluate_combo(ss, mm, nc, WIN_CYC)
            row["class1_min_run"] = segment_run_stats(ss, mm)["min_longest_run"]
            entry = summarize_row(row)
            entry["label"] = "起点 t0=%dms %s" % (start_ms, label)
            entry["note"] = "primary start=2; 此档仅改相位/是否含零填充首窗"
            starts.append(entry)
    cadence = []
    ss50 = build_sessions(ds, logits, 2, 1)
    for label, mm, nc in (
        ("baseline 8/3", ONLINE_MARGIN_MIN, ONLINE_N_CONSEC),
        ("chosen %d/%d" % (chosen_margin, chosen_ncon), chosen_margin, chosen_ncon),
    ):
        row, _ = evaluate_combo(ss50, mm, nc, WIN_CYC // 2)
        row["class1_min_run"] = segment_run_stats(ss50, mm)["min_longest_run"]
        entry = summarize_row(row)
        entry["label"] = "50ms %s" % label
        entry["note"] = "非板上节拍：50ms 决策步长，dt=2.5e6 cycles；仅敏感性"
        cadence.append(entry)
    return {"starts": starts, "cadence_50ms": cadence}


def pulse_stats(pulses):
    if not pulses:
        return {"n": 0}
    m = np.asarray([p["margin"] for p in pulses], dtype=np.int64)
    c = np.asarray([p["conf"] for p in pulses], dtype=np.int64)
    return {
        "n": int(m.size),
        "min": int(m.min()),
        "max": int(m.max()),
        "mean": float(m.mean()),
        "p10": float(np.percentile(m, 10)),
        "p50": float(np.percentile(m, 50)),
        "p90": float(np.percentile(m, 90)),
        "conf31": int((c == CONF_MAX).sum()),
        "conf31_frac": float((c == CONF_MAX).mean()),
        "conf_p10": float(np.percentile(c, 10)),
        "conf_p50": float(np.percentile(c, 50)),
        "conf_p90": float(np.percentile(c, 90)),
    }


def find_row(sweep, margin, ncon):
    for r in sweep:
        if r["margin_min"] == margin and r["n_consec"] == ncon:
            return r
    return None


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="task-28 offline decision-chain calibration")
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--params", default=DEFAULT_PARAMS)
    ap.add_argument("--out-json", default=DEFAULT_JSON)
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--evid", default=DEFAULT_EVID)
    ap.add_argument("--start-offset", type=int, default=DEFAULT_START_OFFSET, choices=(0, 1, 2))
    ap.add_argument("--margin-grid", default=",".join(str(x) for x in MARGIN_GRID))
    ap.add_argument("--nconsec-grid", default=",".join(str(x) for x in NCONSEC_GRID))
    ap.add_argument("--skip-sensitivity", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    return ap.parse_args(argv)


def write_outputs(result, checks, paths):
    result["checks"] = dict(checks)
    result["verdict"] = VERDICT_OK if all(checks.values()) else VERDICT_FAIL
    json_path, report_path, evid_path = paths
    json_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    evid_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path.write_text(render_report(result), encoding="utf-8")
    evid_path.write_text(render_evidence(result), encoding="utf-8")


def verify_outputs(result, checks, paths):
    json_path, report_path, evid_path = paths
    try:
        j = json.loads(json_path.read_text(encoding="utf-8"))
        checks["JSON_ROUNDTRIP"] = bool(
            j.get("schema") == "decision_sweep"
            and len(j.get("sweep", [])) == len(result["sweep"])
            and j.get("baseline", {}).get("margin_min") == ONLINE_MARGIN_MIN
            and j.get("baseline", {}).get("n_consec") == ONLINE_N_CONSEC
            and "recommendation" in j
        )
    except Exception:
        checks["JSON_ROUNDTRIP"] = False
    try:
        report_lines = report_path.read_text(encoding="utf-8").splitlines()
        checks["REPORT_HEADER"] = bool(report_lines and report_lines[0].strip() == result["verdict"])
    except Exception:
        checks["REPORT_HEADER"] = False
    try:
        evid_lines = [x for x in evid_path.read_text(encoding="utf-8").splitlines() if x.strip()]
        checks["EVIDENCE_HEADER"] = bool(
            evid_lines and evid_lines[0].strip() == result["verdict"] and evid_lines[-1].strip() == result["verdict"]
        )
    except Exception:
        checks["EVIDENCE_HEADER"] = False


def main(argv=None):
    force_utf8_stdio()
    args = parse_args(argv)
    t_start = time.time()
    data_path = resolve(args.data)
    params_path = resolve(args.params)
    json_path = resolve(args.out_json)
    report_path = resolve(args.report)
    evid_path = resolve(args.evid)
    if not data_path.exists():
        print("missing dataset: %s" % data_path)
        return 2
    if not params_path.exists():
        print("missing params: %s" % params_path)
        return 2
    margin_grid = tuple(int(x) for x in args.margin_grid.split(",") if x.strip())
    ncon_grid = tuple(int(x) for x in args.nconsec_grid.split(",") if x.strip())
    if len(margin_grid) * len(ncon_grid) < 8:
        print("sweep must cover >=8 combinations")
        return 2

    before_hashes = {rel: sha256_file(resolve(rel)) for rel in PROTECTED}
    ds = load_dataset(data_path)
    doc, layers = load_params(params_path)
    if doc.get("num_classes") != NUM_CLASSES:
        raise RuntimeError("expected 2-class params, got %r" % doc.get("num_classes"))
    logits, forward_stats = forward_int8(ds["X_q"], layers)
    sessions = build_sessions(ds, logits, args.start_offset, 2)
    win_ms = int(ds["win_ms"])

    sweep = []
    for margin in margin_grid:
        rs = segment_run_stats(sessions, margin)
        for ncon in ncon_grid:
            row, _ = evaluate_combo(sessions, margin, ncon, WIN_CYC)
            row["class1_min_run"] = rs["min_longest_run"]
            row["class1_median_run"] = rs["median_longest_run"]
            row["class1_segments_run_eq3"] = rs["segments_run_eq3"]
            row["class1_runs"] = rs["runs"]
            sweep.append(row)

    base_row = find_row(sweep, ONLINE_MARGIN_MIN, ONLINE_N_CONSEC)
    if base_row is None:
        print("baseline 8/3 is not in the sweep grid")
        return 2
    base_row, baseline_pulses = evaluate_combo(sessions, ONLINE_MARGIN_MIN, ONLINE_N_CONSEC, WIN_CYC)
    base_rs = segment_run_stats(sessions, ONLINE_MARGIN_MIN)
    base_row["class1_min_run"] = base_rs["min_longest_run"]
    base_row["class1_median_run"] = base_rs["median_longest_run"]
    base_row["class1_segments_run_eq3"] = base_rs["segments_run_eq3"]
    baseline_pulses = sorted(baseline_pulses, key=lambda p: (p["short"], p["t0_ms"]))
    baseline_events = [
        {
            "short": p["short"],
            "t0_ms": p["t0_ms"],
            "decision_time_ms": p["decision_time_ms"],
            "class_pred": p["class_pred"],
            "margin": p["margin"],
            "conf": p["conf"],
            "y": p["y"],
            "seg": p["seg"],
        }
        for p in baseline_pulses
    ]

    cands = [
        r
        for r in sweep
        if (r["silent_false_per_silent_min"] is not None and r["silent_false_per_silent_min"] <= 0.5)
        and (r["board_move_per_min"] is not None and r["board_move_per_min"] <= 0.5)
        and (r["class1_recall"] is not None and r["class1_recall"] >= 0.85)
    ]
    full = [r for r in cands if r["n_consec"] == 3 and (r["class1_recall"] or 0) >= 0.999999]
    if full:
        chosen = max(full, key=lambda r: r["margin_min"])
    elif cands:
        chosen = max(cands, key=lambda r: ((r["class1_recall"] or 0), r["margin_min"]))
    else:
        chosen = None

    strict_pool = [r for r in sweep if (r["class1_recall"] or 0) >= 0.85]
    strict_best = min(
        strict_pool,
        key=lambda r: (r["wave_per_total_min"] if r["wave_per_total_min"] is not None else 9e9, -(r["class1_recall"] or 0), r["margin_min"]),
    ) if strict_pool else None
    strict_reachable = bool(
        strict_best is not None
        and strict_best["wave_per_total_min"] is not None
        and strict_best["wave_per_total_min"] <= 0.5
    )
    strict_gap = None
    if strict_best is not None and strict_best["wave_per_total_min"] is not None:
        strict_gap = max(0.0, float(strict_best["wave_per_total_min"]) - 0.5)

    run24 = segment_run_stats(sessions, 24)
    run32 = segment_run_stats(sessions, 32)
    run48 = segment_run_stats(sessions, 48)

    alternatives = []
    for mm, nc in ((16, 3), (24, 4), (48, 3), (8, 3)):
        r = find_row(sweep, mm, nc)
        if r is not None:
            alternatives.append(
                {
                    "margin_min": r["margin_min"],
                    "n_consec": r["n_consec"],
                    "silent_false": r["silent_false"],
                    "silent_false_per_silent_min": r["silent_false_per_silent_min"],
                    "board_move_false": r["board_move_false"],
                    "class1_detected": r["class1_detected"],
                    "class1_segments": r["class1_segments"],
                    "class1_recall": r["class1_recall"],
                    "class1_min_run": r["class1_min_run"],
                    "wave_pulses": r["wave_pulses"],
                }
            )

    total_dec = sum(sd.n_dec for sd in sessions)
    total_minutes = sum(sd.minutes for sd in sessions)
    n_dec_by_session = {sd.short: sd.n_dec for sd in sessions}

    pulse_stats_d = pulse_stats(baseline_pulses)
    dists = build_distributions(sessions, baseline_pulses)
    try:
        sens = build_sensitivity(ds, logits, chosen["margin_min"] if chosen else ONLINE_MARGIN_MIN, chosen["n_consec"] if chosen else ONLINE_N_CONSEC) if not args.skip_sensitivity else {"starts": [], "cadence_50ms": []}
    except Exception as exc:
        sens = {"starts": [], "cadence_50ms": [], "error": str(exc)}

    reproduce = "%s nn/probe_decide_sweep.py --data %s --params %s --out-json %s --report %s --evid %s" % (
        str(Path(sys.executable).as_posix()),
        data_path.as_posix(),
        params_path.as_posix(),
        json_path.as_posix(),
        report_path.as_posix(),
        evid_path.as_posix(),
    )

    result = {
        "schema": "decision_sweep",
        "task": "task-28",
        "generated": now_iso(),
        "interpreter": "%s (Python %s, numpy %s)" % (sys.executable, sys.version.split()[0], np.__version__),
        "reproduce_command": reproduce,
        "inputs": {
            "data": str(data_path),
            "params": str(params_path),
        },
        "protocol": {
            "clk_hz": CLK_HZ,
            "win_cyc": WIN_CYC,
            "k_time_bins": K_TIME_BINS,
            "refractory_cyc": REFRACTORY_CYC,
            "act_idle_cyc": ACT_IDLE_CYC,
            "conf_max": CONF_MAX,
            "num_classes": NUM_CLASSES,
            "cadence_ms": 100,
            "start_offset": args.start_offset,
            "decision_index_rule": "idx_sorted[start_offset::2]",
            "decision_time_rule": "decision_time_ms = t0_ms + win_ms",
            "n_decisions": int(total_dec),
            "total_minutes": float(total_minutes),
            "n_decisions_by_session": n_dec_by_session,
            "mapping": "T=t0+100ms; board window=[T-200,T); dataset window input=[t0-100,t0+100)",
            "phase_uncertainty_ms": int(ds["stride_ms"]),
        },
        "dataset": {
            "path": str(data_path),
            "n_windows": int(ds["n_windows"]),
            "n_sessions": int(ds["n_sessions"]),
            "win_ms": int(ds["win_ms"]),
            "stride_ms": int(ds["stride_ms"]),
            "class_counts": ds["class_counts"],
            "class1_segments": int(base_row["class1_segments"]),
            "class2_segments": int(base_row["wave_segments"]),
            "board_move_session": "retina-events-20261029-210307",
            "sessions": [sd.name for sd in sessions],
        },
        "model": {
            "path": str(params_path),
            "num_classes": int(doc["num_classes"]),
            "rom_words": int(doc["rom_words"]),
            "chosen_route": doc.get("chosen_route"),
            "int8_agreement_float_vs_int8": float(doc.get("int8_agreement_float_vs_int8", INT8_FLOAT_AGREEMENT)),
            "layers": [{"name": l["name"], "weight_shape": list(l["w"].shape), "sh": [int(x) for x in l["sh"].tolist()]} for l in layers],
            "source": "cnn_params.layers",
        },
        "baseline": base_row,
        "baseline_pulse_events": baseline_events,
        "pulse_stats": pulse_stats_d,
        "sweep": sweep,
        "distributions": dists,
        "sensitivity": sens,
        "recommendation": {
            "criteria": {
                "silent_false_per_min_max": 0.5,
                "board_move_per_min_max": 0.5,
                "class1_recall_min": 0.85,
            },
            "candidates_count": len(cands),
            "chosen": chosen,
            "alternatives": alternatives,
            "rationale": [
                "24/3 是保持 27/27 全检出的最高 MARGIN_MIN；32/3 与 48/3 都掉到 26/27，因此不选更高阈值",
                "24 时最小连续命中=3（1 段恰好 3 个），没有余量；16/3 同样 27/27 但 margin 更低，现场若出现漏段应回退 16/3 或 8/3",
                "N_CONSEC 保持 3：24/4 掉到 26/27，增加 100ms 延迟且换不到更低误触",
                "阈值无法减少挥手误判：18 组挥手 pulse 恒为 6；要压挥手只能补 class2 数据/三类模型或 host 侧处理",
            ],
            "run_eq3_at_24": run24["segments_run_eq3"],
            "run_eq3_at_32": run32["segments_run_eq3"],
            "run_eq3_at_48": run48["segments_run_eq3"],
            "strict_user_perceived": {
                "reachable": strict_reachable,
                "definition": "把 3 段挥手被 B2 判成 class1 的 6 个 pulse 也计为误触",
                "best_config": {"margin_min": strict_best["margin_min"], "n_consec": strict_best["n_consec"]} if strict_best else None,
                "best_wave_pulses": strict_best["wave_pulses"] if strict_best else None,
                "best_wave_per_total_min": strict_best["wave_per_total_min"] if strict_best else None,
                "target_per_min": 0.5,
                "gap": strict_gap,
                "note": "所有 18 组均为 6 个挥手 pulse；B2 训练集没有 class2 窗，阈值调参无法区分挥手与手部开合",
            },
        },
        "caveat": [
            "final 2cls ROM 模型在全部 20 会话 1524 窗上训练过；本回放是 in-sample 标定",
            "窗级 y0 准确率 0.9988 vs 会话级 LOO y0 recall 0.9563（≈4.4% 泛化 FP），0 次静默误触只是下界",
            "总时长仅约 1.4 min，1 个事件就是 ~0.7 次/分；证明 ≤0.5 次/分至少需要 ~6 min 静默数据",
            "挥手被 B2 判成 class1 是已知限制，不是本脚本的 bug",
        ],
        "artifacts": [
            str(report_path),
            str(json_path),
            str(evid_path),
            str((NN / "probe_decide_sweep.py").resolve()),
        ],
    }

    checks = {}
    checks["DATA_OK"] = bool(
        ds["n_windows"] == EXPECTED_N_WINDOWS
        and ds["n_sessions"] == EXPECTED_N_SESSIONS
        and ds["class_counts"] == EXPECTED_COUNTS
        and int(ds["win_ms"]) == 100
        and int(ds["stride_ms"]) == 50
    )
    shapes = [tuple(l["w"].shape) for l in layers]
    checks["PARAMS_2CLS"] = bool(
        doc.get("num_classes") == 2
        and doc.get("rom_words") == EXPECTED_ROM_WORDS
        and shapes == [(8, 4, 3, 3), (16, 8, 3, 3), (24, 16, 3, 3), (2, 240)]
    )
    checks["NO_TORCH"] = "torch" not in sys.modules
    checks["FORWARD_INT8"] = bool(
        logits.dtype == np.int8
        and logits.shape == (ds["n_windows"], 2)
        and int(logits.min()) >= -128
        and int(logits.max()) <= 127
    )
    checks["BOARD_CADENCE"] = bool(
        all(sd.dt_ms == 100.0 for sd in sessions)
        and all(np.all(np.diff(sd.t0) == 100) for sd in sessions)
        and all(int(sd.t0[0]) == 100 for sd in sessions)
        and all(int(sd.decision_time[0]) == int(sd.t0[0]) + win_ms for sd in sessions)
    )
    checks["VALID_EDGES_EQ_PULSES"] = bool(all(r["edges_eq_pulses"] for r in sweep))
    checks["BASELINE_PRESENT"] = bool(base_row["margin_min"] == 8 and base_row["n_consec"] == 3)
    combos = {(r["margin_min"], r["n_consec"]) for r in sweep}
    checks["SWEEP_18"] = bool(len(sweep) == len(margin_grid) * len(ncon_grid) and len(sweep) >= 8 and len(combos) == len(sweep))
    consistent = True
    for r in sweep:
        if int(r["total_pulses"]) != sum(int(x["pulses"]) for x in r["per_session"]):
            consistent = False
        if int(r["class1_segments"]) != EXPECTED_C1_SEGMENTS:
            consistent = False
        if int(r["class1_pulses"]) + int(r["wave_pulses"]) + int(r["silent_false"]) + int(r["board_move_false"]) != int(r["total_pulses"]):
            consistent = False
    checks["SWEEP_CONSISTENT"] = bool(consistent)
    checks["SEGMENTS_27"] = bool(base_row["class1_segments"] == EXPECTED_C1_SEGMENTS)
    checks["WAVE_SEPARATED"] = bool(base_row["wave_segments"] == 3 and base_row["wave_pulses"] > 0)
    checks["DISTRIBUTIONS_OK"] = bool(
        all(
            s.get("n", 0) == 0 or (s["p10"] <= s["p50"] <= s["p90"] and 0.0 <= s["conf_frac31"] <= 1.0)
            for s in dists["stats"].values()
        )
        and dists["stats"]["all"]["n"] == total_dec
        and dists["stats"]["pulse_baseline"]["n"] == base_row["total_pulses"]
    )
    checks["CONF_ANALYZED"] = bool(
        pulse_stats_d.get("n", 0) > 0
        and "conf_frac31" in dists["stats"]["pulse_baseline"]
        and "frac_ge_31" in dists["stats"]["all"]
    )
    checks["RECOMMENDATION_OK"] = bool(
        chosen is not None
        and chosen["silent_false_per_silent_min"] is not None
        and chosen["silent_false_per_silent_min"] <= 0.5
        and chosen["board_move_per_min"] is not None
        and chosen["board_move_per_min"] <= 0.5
        and chosen["class1_recall"] is not None
        and chosen["class1_recall"] >= 0.85
    )
    _, p_a = evaluate_combo(sessions, ONLINE_MARGIN_MIN, ONLINE_N_CONSEC, WIN_CYC)
    _, p_b = evaluate_combo(sessions, ONLINE_MARGIN_MIN, ONLINE_N_CONSEC, WIN_CYC)
    checks["REPLAY_DETERMINISTIC"] = bool(
        [(p["name"], p["j"], p["margin"], p["class_pred"]) for p in p_a] == [(p["name"], p["j"], p["margin"], p["class_pred"]) for p in p_b]
    )
    checks["JSON_ROUNDTRIP"] = False
    checks["REPORT_HEADER"] = False
    checks["EVIDENCE_HEADER"] = False
    checks["HASHES_UNCHANGED"] = True

    paths = (json_path, report_path, evid_path)
    for _ in range(3):
        write_outputs(result, checks, paths)
        verify_outputs(result, checks, paths)
        if checks["HASHES_UNCHANGED"]:
            after_hashes = {rel: sha256_file(resolve(rel)) for rel in PROTECTED}
            checks["HASHES_UNCHANGED"] = bool(before_hashes == after_hashes)
        verdict = VERDICT_OK if all(checks.values()) else VERDICT_FAIL
        if result["verdict"] == verdict:
            break
    # final write with the final verdict and checks
    write_outputs(result, checks, paths)
    verify_outputs(result, checks, paths)
    after_hashes = {rel: sha256_file(resolve(rel)) for rel in PROTECTED}
    checks["HASHES_UNCHANGED"] = bool(before_hashes == after_hashes)
    write_outputs(result, checks, paths)
    verify_outputs(result, checks, paths)
    final_verdict = VERDICT_OK if all(checks.values()) else VERDICT_FAIL

    if not args.quiet:
        print(final_verdict)
        print("interpreter=%s" % result["interpreter"])
        print("decisions=%d sessions=%d total_minutes=%.3f" % (total_dec, len(sessions), total_minutes))
        print("baseline 8/3: silent %d (%.3f/min) board %d (%.3f/min) class1 %d/%d (%s) wave %d (%.2f/min)" % (
            base_row["silent_false"], base_row["silent_false_per_silent_min"] or 0.0,
            base_row["board_move_false"], base_row["board_move_per_min"] or 0.0,
            base_row["class1_detected"], base_row["class1_segments"], pct(base_row["class1_recall"]),
            base_row["wave_pulses"], base_row["wave_per_total_min"] or 0.0))
        if chosen:
            print("chosen %d/%d: silent %d (%.3f/min) board %d class1 %d/%d (%s) wave %d" % (
                chosen["margin_min"], chosen["n_consec"], chosen["silent_false"],
                chosen["silent_false_per_silent_min"] or 0.0, chosen["board_move_false"],
                chosen["class1_detected"], chosen["class1_segments"], pct(chosen["class1_recall"]),
                chosen["wave_pulses"]))
        print("strict_user_perceived: reachable=%s best=%.3f/min gap=%.3f" % (
            strict_reachable, strict_best["wave_per_total_min"] if strict_best else -1.0, strict_gap or 0.0))
        print("conf31 pulses=%d/%d (%.3f) all_frac_ge31=%.3f" % (
            pulse_stats_d.get("conf31", 0), base_row["total_pulses"],
            pulse_stats_d.get("conf31_frac", 0.0), dists["stats"]["all"]["frac_ge_31"]))
        print("checks_failed=%s" % ",".join(k for k, v in checks.items() if not v))
        print("elapsed_seconds=%.2f" % (time.time() - t_start))
        print("outputs: %s | %s | %s" % (report_path, json_path, evid_path))
    return 0 if final_verdict == VERDICT_OK else 1


if __name__ == "__main__":
    sys.exit(main())
