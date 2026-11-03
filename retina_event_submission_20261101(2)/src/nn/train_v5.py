#!/usr/bin/env python3
"""M2d / task-29: train a v5 CNN so that a waving hand is no longer reported as
class1 (hand open/close), while keeping class1 segment recall.

Two routes are trained and compared with the exact offline decision chain of
task-28 (probe_decide_sweep.py semantics: int8 forward -> 100 ms decisions ->
nn_decide state machine with MARGIN_MIN / N_CONSEC / 1.5 s refractory):

  A (two-class fold): all windows, waving sessions (y=2) relabelled to class0
      and up-weighted as hard negatives.  Artifact: 2-class CNN, 5476-word ROM
      (identical contract to nn/out_v4/nn_params_2cls.json).
  B (three-class):    class0 none / class1 hand_open_close / class2 wave.
      Artifact: 3-class CNN, 5718-word ROM (standard M3 layout).

Everything is evaluated with pulses and segments, not just window accuracy.
Session-level leave-one-session-out (LOO) is the honest generalisation column;
the deployed artifact (trained on every recorded window, exactly like v4) is
the column that is comparable with the 6 wave pulses of the v4 baseline.

Usage:
  python nn/train_v5.py --route all
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset

NN = Path(__file__).resolve().parent
sys.path.insert(0, str(NN))
from model import build_model  # noqa: E402
import quantize as Q  # noqa: E402
import ref_cnn  # noqa: E402

# ---------------------------------------------------------------------------
# Board / decision-chain constants (1:1 with nn/probe_decide_sweep.py)
# ---------------------------------------------------------------------------
CLK_HZ = 50_000_000
WIN_CYC = 5_000_000            # 100 ms at 50 MHz
REFRACTORY_CYC = 75_000_000    # 1.5 s
ACT_IDLE_CYC = 50_000_000      # 1.0 s act_state_cdc
CONF_MAX = 31
DT_CYC = 5_000_000             # one 100 ms decision step
ONLINE_MARGIN_MIN = 8
ONLINE_N_CONSEC = 3
MARGIN_GRID = (0, 4, 8, 16, 24, 32, 48)
NCONSEC_GRID = (3, 4, 5)
DEFAULT_START_OFFSET = 2
STRIDE_MS = 50

TWO_ROM_WORDS = 5476
TWO_FC_BASE = 4896
TWO_BIAS_BASE = 5376
TWO_SH_BASE = 5426
PY_FENCE = chr(96) * 3

CLASS_NAMES_2 = {"0": "class0_none_or_board_move", "1": "class1_hand_open_close"}
CLASS_NAMES_3 = {"0": "class0_none_or_board_move", "1": "class1_hand_open_close", "2": "class2_wave"}

DATA_DEFAULT = str(NN / "dataset_v4_w100.npz")
OUT_DEFAULT = str(NN / "out_v5")
EVID_DEFAULT = str(NN / "_evidence" / "TRAIN_V5.log")
REPORT_DEFAULT = str(NN / "REPORT_训练v5.md")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def load_dataset(path: Path) -> dict:
    d = np.load(str(path), allow_pickle=False)
    need = ("X_q", "y", "session", "seg_id", "t_ms", "t_rel_ms", "win_ms", "stride_ms")
    missing = [k for k in need if k not in d.files]
    if missing:
        raise RuntimeError("dataset missing fields: %s" % ",".join(missing))
    out = {
        "path": str(path),
        "raw": d,
        "keys": list(d.files),
        "X_q": np.asarray(d["X_q"], dtype=np.int8),
        "y": np.asarray(d["y"], dtype=np.int64),
        "session": np.asarray(d["session"]).astype(str),
        "seg_id": np.asarray(d["seg_id"], dtype=np.int64),
        "t_ms": np.asarray(d["t_ms"], dtype=np.int64),
        "t_rel_ms": np.asarray(d["t_rel_ms"], dtype=np.int64),
        "win_ms": int(np.asarray(d["win_ms"]).reshape(-1)[0]),
        "stride_ms": int(np.asarray(d["stride_ms"]).reshape(-1)[0]),
    }
    out["n_windows"] = int(out["y"].shape[0])
    out["n_sessions"] = int(len(set(out["session"].tolist())))
    vals, cnts = np.unique(out["y"], return_counts=True)
    out["class_counts"] = {int(v): int(c) for v, c in zip(vals, cnts)}
    return out


def grouped_folds(session: np.ndarray, y: np.ndarray, n_folds: int, seed: int) -> dict:
    """Stratified session-level round-robin folds; a session is never split."""
    uniq = sorted(set(session.tolist()))
    buckets = {}
    for s in uniq:
        ys = set(y[session == s].tolist())
        if s.endswith("210307"):
            kind = "board"
        elif 2 in ys:
            kind = "wave"
        elif 1 in ys:
            kind = "class1"
        else:
            kind = "silent"
        buckets.setdefault(kind, []).append(s)
    fold_of = {}
    k = 0
    for key in sorted(buckets):
        mem = list(buckets[key])
        random.Random("%s:%s" % (seed, key)).shuffle(mem)
        for s in mem:
            fold_of[s] = k % n_folds
            k += 1
    return fold_of


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------
def class_weights(y: np.ndarray, n_classes: int) -> torch.Tensor:
    counts = np.bincount(y, minlength=n_classes).astype(np.float64)
    counts = np.maximum(counts, 1.0)
    w = np.sqrt(float(len(y)) / (n_classes * counts))
    w = np.clip(w, 0.5, 3.0)
    return torch.tensor(w, dtype=torch.float32)


def train_model(x, y, sw, seed, epochs, batch, lr, wd, n_classes, quiet=True):
    torch.manual_seed(seed)
    np.random.seed(seed)
    model = build_model(num_classes=n_classes)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    cw = class_weights(y, n_classes)
    gen = torch.Generator()
    gen.manual_seed(seed)
    ds = TensorDataset(torch.from_numpy(np.asarray(x, dtype=np.float32)), torch.from_numpy(y),
                       torch.from_numpy(np.asarray(sw, dtype=np.float32)))
    loader = DataLoader(ds, batch_size=batch, shuffle=True, generator=gen, num_workers=0)
    t0 = time.time()
    last = 0.0
    for _ in range(epochs):
        model.train()
        tot = 0.0
        seen = 0.0
        for xb, yb, wb in loader:
            opt.zero_grad(set_to_none=True)
            logits = model(xb)
            ce = F.cross_entropy(logits, yb, weight=cw, reduction="none")
            denom = wb.sum().clamp_min(1e-6)
            loss = (ce * wb).sum() / denom
            loss.backward()
            opt.step()
            tot += float(loss.item()) * float(wb.sum().item())
            seen += float(wb.sum().item())
        sched.step()
        last = tot / max(seen, 1e-6)
    if not quiet:
        print("      loss=%.4f (%.1fs)" % (last, time.time() - t0), flush=True)
    return model, time.time() - t0, last


@torch.no_grad()
def predict_logits(model, x: np.ndarray, batch: int = 512) -> np.ndarray:
    model.eval()
    outs = []
    for i in range(0, len(x), batch):
        outs.append(model(torch.from_numpy(np.asarray(x[i:i + batch], dtype=np.float32))).numpy())
    return np.concatenate(outs, axis=0).astype(np.float32) if outs else np.zeros((0,), np.float32)


# ---------------------------------------------------------------------------
# int8 artifact (2-class compact ROM / 3-class standard layout)
# ---------------------------------------------------------------------------
def rom_layout_2cls() -> list:
    return [
        {"name": "conv1_w", "start": 0, "end": 288, "words": 288, "desc": "8x4x3x3 int8 (same as 3cls)"},
        {"name": "conv2_w", "start": 288, "end": 1440, "words": 1152, "desc": "16x8x3x3 int8 (same as 3cls)"},
        {"name": "conv3_w", "start": 1440, "end": 4896, "words": 3456, "desc": "24x16x3x3 int8 (same as 3cls)"},
        {"name": "fc_w", "start": 4896, "end": 5376, "words": 480, "desc": "2x240 int8 (no pad)"},
        {"name": "b1", "start": 5376, "end": 5384, "words": 8, "desc": "conv1 bias int32"},
        {"name": "b2", "start": 5384, "end": 5400, "words": 16, "desc": "conv2 bias int32"},
        {"name": "b3", "start": 5400, "end": 5424, "words": 24, "desc": "conv3 bias int32"},
        {"name": "bfc", "start": 5424, "end": 5426, "words": 2, "desc": "fc bias int32"},
        {"name": "sh1", "start": 5426, "end": 5434, "words": 8, "desc": "conv1 per-channel pow2 shift"},
        {"name": "sh2", "start": 5434, "end": 5450, "words": 16, "desc": "conv2 per-channel pow2 shift"},
        {"name": "sh3", "start": 5450, "end": 5474, "words": 24, "desc": "conv3 per-channel pow2 shift"},
        {"name": "shfc", "start": 5474, "end": 5476, "words": 2, "desc": "fc per-class pow2 shift"},
    ]


def check_2cls(p: dict) -> list:
    errs = []
    names = [l["name"] for l in p["layers"]]
    if names != ["conv1", "conv2", "conv3", "fc"]:
        errs.append("layer order %s" % names)
    want = {"conv1": (288, 8), "conv2": (1152, 16), "conv3": (3456, 24), "fc": (480, 2)}
    total = 0
    for l in p["layers"]:
        wc, bc = want.get(l["name"], (None, None))
        if wc is None:
            continue
        if len(l["weight_int8"]) != wc or int(l["weight_count"]) != wc:
            errs.append("%s weights %d/%d" % (l["name"], len(l["weight_int8"]), wc))
        if len(l["bias_int32"]) != bc or len(l["SH"]) != bc:
            errs.append("%s bias/sh %d/%d" % (l["name"], len(l["bias_int32"]), bc))
        w = np.asarray(l["weight_int8"])
        if w.size and (w.min() < -128 or w.max() > 127):
            errs.append("%s weight outside int8" % l["name"])
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        if b.size and (b.min() < -2 ** 31 or b.max() > 2 ** 31 - 1):
            errs.append("%s bias outside int32" % l["name"])
        sh = np.asarray(l["SH"], dtype=np.int64)
        if sh.size and (sh.min() < 0 or sh.max() > 31):
            errs.append("%s SH outside 0..31" % l["name"])
        total += wc
    if total != 5376:
        errs.append("total weights %d" % total)
    start = 0
    for it in rom_layout_2cls():
        if it["start"] != start:
            errs.append("layout gap at %d" % start)
        start = it["end"]
    if start != TWO_ROM_WORDS:
        errs.append("layout end %d" % start)
    return errs


def build_2cls_rom_words(p: dict) -> list:
    words = []
    for layer in p["layers"]:
        words.extend(int(v) for v in layer["weight_int8"])
    assert len(words) == 5376, len(words)
    for layer in p["layers"]:
        words.extend(int(v) for v in layer["bias_int32"])
    for layer in p["layers"]:
        words.extend(int(v) for v in layer["SH"])
    assert len(words) == TWO_ROM_WORDS, len(words)
    return words


def write_rom_2cls(path: Path, words: list, layout: list) -> None:
    assert len(words) == TWO_ROM_WORDS
    lines = [
        "// Auto-generated by nn/train_v5.py -- do not edit by hand.",
        "// Two-class v5 ROM (NUM_CLASSES=2): class0 none / class1 hand_open_close.",
        "// compact layout (no pad): weights [0,5376), bias [5376,5426), SH [5426,5476).",
        "// conv1..3 weights sit at the same addresses as the 3-class nn_rom_data.v.",
        "// layout:",
    ]
    for it in layout:
        lines.append("//   %-9s [%4d,%4d) %4d words  %s" % (it["name"], it["start"], it["end"], it["words"], it["desc"]))
    lines += [
        "// total %d words, 13-bit address (0..%d)." % (len(words), len(words) - 1),
        "module nn_rom_data(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        "    input      [12:0] i_addr",
        ");",
        "",
        "    reg [31:0] rom [0:%d];" % (len(words) - 1),
        "",
        "    initial begin",
    ]
    for i, v in enumerate(words):
        lines.append("        rom[%d] = 32'h%08X;" % (i, int(v) & 0xFFFFFFFF))
    lines += ["    end", "", "    always @(posedge clk) begin", "        o_dout <= rom[i_addr];", "    end", "", "endmodule", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def write_rom_3cls(path: Path, words: list) -> None:
    assert len(words) == Q.ROM_WORD_COUNT
    lines = [
        "// Auto-generated by nn/train_v5.py -- do not edit by hand.",
        "// Three-class v5 ROM (NUM_CLASSES=3): class0 none / class1 hand_open_close / class2 wave.",
        "// frozen M3 layout: weights [0,5616), bias [5616,5667), SH [5667,5718).",
        "module nn_rom_data(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        "    input      [12:0] i_addr",
        ");",
        "",
        "    reg [31:0] rom [0:%d];" % (len(words) - 1),
        "",
        "    initial begin",
    ]
    for i, v in enumerate(words):
        lines.append("        rom[%d] = 32'h%08X;" % (i, int(v) & 0xFFFFFFFF))
    lines += ["    end", "", "    always @(posedge clk) begin", "        o_dout <= rom[i_addr];", "    end", "", "endmodule", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def quantize_artifact(model, x_cal: np.ndarray, n_classes: int):
    p = Q.quantize_model(model, x_cal)
    p["int8_contract"] = "acc=sum(w_int8*a_int8)+bias_int32; out=clip(acc>>SH,-128,127); SH is a per-channel power of two"
    if n_classes == 2:
        p["arch"] = "P1CNN_2cls"
        p["num_classes"] = 2
        p["rom_words"] = TWO_ROM_WORDS
        p["layout"] = rom_layout_2cls()
        problems = check_2cls(p)
        words = build_2cls_rom_words(p)
    else:
        p["arch"] = "P1CNN_3cls"
        p["rom_words"] = Q.ROM_WORD_COUNT
        problems = Q.check_params(p)
        words = Q.rom_words(p)
    return p, words, problems


def doc_layers(p: dict) -> list:
    return [
        {
            "name": L["name"],
            "w": np.asarray(L["weight_int8"], dtype=np.int64).reshape(tuple(L["weight_shape"])),
            "b": np.asarray(L["bias_int32"], dtype=np.int64),
            "sh": np.asarray(L["SH"], dtype=np.int64),
        }
        for L in p["layers"]
    ]


def int8_logits(x: np.ndarray, layers: list) -> np.ndarray:
    logits, _stats = ref_cnn.forward_ref(x, layers)
    return np.asarray(logits, dtype=np.int64)


# ---------------------------------------------------------------------------
# Decision-chain replay (nn_decide.v + act_state_cdc.v)
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
    hitok: np.ndarray
    dt_ms: float

    @property
    def n_dec(self) -> int:
        return int(self.idx.size)

    @property
    def minutes(self) -> float:
        return float(self.n_dec) * self.dt_ms / 60000.0


def build_sessions(ds: dict, logits: np.ndarray, start_offset: int = DEFAULT_START_OFFSET,
                   step: int = 1) -> list:
    y_all = ds["y"]
    seg_all = ds["seg_id"]
    t_all = ds["t_ms"]
    t_rel_all = ds["t_rel_ms"]
    lg = np.asarray(logits, dtype=np.float64)
    n_cls = lg.shape[1]
    if n_cls == 2:
        c_all = np.where(lg[:, 0] >= lg[:, 1], 0, 1).astype(np.int64)
        m_all = np.abs(lg[:, 0] - lg[:, 1]).astype(np.int64)
        hit_all = c_all != 0
    else:
        c_all = lg.argmax(axis=1).astype(np.int64)
        rows = np.arange(lg.shape[0])
        top = lg[rows, c_all]
        others = lg.copy()
        others[rows, c_all] = -10 ** 9
        m_all = (top - others.max(axis=1)).astype(np.int64)
        hit_all = c_all == 1
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
            raise RuntimeError("non-uniform grid in %s" % name)
        idx = idx_all[start_offset::step]
        t0 = t_rel_all[idx]
        if np.any(np.diff(t0) != expected_dt):
            raise RuntimeError("bad decision cadence in %s" % name)
        sessions.append(SessionData(
            name=str(name),
            short=str(name).split("-")[-1],
            cls=int(y_all[np.where(ds["session"] == name)[0]].max()),
            board_move=str(name).endswith("210307"),
            n_windows=int(idx_all.size),
            idx=idx.astype(np.int64),
            t0=t0.astype(np.int64),
            decision_time=(t0 + int(ds["win_ms"])).astype(np.int64),
            y=y_all[idx].astype(np.int64),
            seg=seg_all[idx].astype(np.int64),
            c=c_all[idx].astype(np.int64),
            margin=m_all[idx].astype(np.int64),
            hitok=hit_all[idx].astype(bool),
            dt_ms=float(expected_dt),
        ))
    return sessions


def replay_session(sd: SessionData, margin_min: int, n_consec: int, dt_cyc: int = DT_CYC) -> list:
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
        hit = bool(sd.hitok[j]) and (m >= margin_min)
        if hit:
            cnt_new = hit_cnt + 1 if (hit_cnt != 0 and last_c == c) else 1
            if cnt_new >= n_consec:
                pulses.append({
                    "name": sd.name, "short": sd.short, "class": sd.cls,
                    "board_move": bool(sd.board_move), "j": int(j),
                    "dataset_index": int(sd.idx[j]), "t0_ms": int(sd.t0[j]),
                    "decision_time_ms": int(sd.decision_time[j]), "class_pred": int(c),
                    "margin": int(m), "conf": int(min(m, CONF_MAX)),
                    "y": int(sd.y[j]), "seg": int(sd.seg[j]),
                })
                refr = REFRACTORY_CYC - 1
                hit_cnt = 0
                last_c = c
            else:
                hit_cnt = cnt_new
                last_c = c
        else:
            hit_cnt = 0
    return pulses


def count_valid_edges(sd: SessionData, pulses: list, dt_cyc: int = DT_CYC) -> int:
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


def segment_counts(sd: SessionData, pulses: list, py: int):
    segs = sorted({int(g) for g in sd.seg[sd.y == py].tolist() if int(g) >= 0})
    counts = {g: 0 for g in segs}
    for p in pulses:
        if p["y"] == py and int(p["seg"]) in counts:
            counts[int(p["seg"])] += 1
    return counts


def rate(num, den) -> float:
    return round(float(num) / float(den), 6) if den else 0.0


def evaluate_combo(sessions: list, margin_min: int, n_consec: int, dt_cyc: int = DT_CYC):
    pulses = []
    per = []
    for sd in sessions:
        ps = replay_session(sd, margin_min, n_consec, dt_cyc)
        edges = count_valid_edges(sd, ps, dt_cyc)
        c1 = segment_counts(sd, ps, 1)
        c2 = segment_counts(sd, ps, 2)
        per.append({
            "session": sd.short, "name": sd.name, "class": sd.cls,
            "board_move": bool(sd.board_move), "n_dec": sd.n_dec, "minutes": sd.minutes,
            "pulses": len(ps),
            "silent_false": sum(1 for p in ps if p["y"] == 0 and not p["board_move"]),
            "board_move_false": sum(1 for p in ps if p["board_move"] and p["y"] == 0),
            "class1_pulses": sum(1 for p in ps if p["y"] == 1),
            "wave_pulses": sum(1 for p in ps if p["y"] == 2),
            "c1_segments": len(c1),
            "c1_detected": sum(1 for v in c1.values() if v > 0),
            "c1_repeated": sum(1 for v in c1.values() if v > 1),
            "c2_segments": len(c2),
            "c2_detected": sum(1 for v in c2.values() if v > 0),
            "valid_edges": edges,
            "edges_eq_pulses": bool(edges == len(ps)),
            "silent_minutes": float((sd.y == 0).sum()) * sd.dt_ms / 60000.0,
        })
        pulses.extend(ps)
    silent_false = sum(1 for p in pulses if p["y"] == 0 and not p["board_move"])
    board_false = sum(1 for p in pulses if p["board_move"] and p["y"] == 0)
    class1_pulses = sum(1 for p in pulses if p["y"] == 1)
    wave_pulses = sum(1 for p in pulses if p["y"] == 2)
    c1_segments = sum(x["c1_segments"] for x in per)
    c1_detected = sum(x["c1_detected"] for x in per)
    c1_repeated = sum(x["c1_repeated"] for x in per)
    silent_minutes = sum(x["silent_minutes"] for x in per if not x["board_move"])
    board_minutes = sum(x["minutes"] for x in per if x["board_move"])
    total_minutes = sum(x["minutes"] for x in per)
    wave_minutes = sum(float((sd.y == 2).sum()) * sd.dt_ms / 60000.0 for sd in sessions)
    row = {
        "margin_min": int(margin_min), "n_consec": int(n_consec), "dt_ms": float(sessions[0].dt_ms),
        "silent_false": int(silent_false), "silent_minutes": float(silent_minutes),
        "silent_false_per_silent_min": rate(silent_false, silent_minutes),
        "silent_false_per_total_min": rate(silent_false, total_minutes),
        "board_move_false": int(board_false), "board_minutes": float(board_minutes),
        "board_move_per_min": rate(board_false, board_minutes),
        "class1_segments": int(c1_segments), "class1_detected": int(c1_detected),
        "class1_recall": rate(c1_detected, c1_segments),
        "class1_pulses": int(class1_pulses),
        "class1_repeated_segments": int(c1_repeated),
        "wave_pulses": int(wave_pulses), "wave_minutes": float(wave_minutes),
        "wave_per_total_min": rate(wave_pulses, total_minutes),
        "total_pulses": int(len(pulses)),
        "total_pulses_per_total_min": rate(len(pulses), total_minutes),
        "total_minutes": float(total_minutes),
        "valid_edges": int(sum(x["valid_edges"] for x in per)),
        "edges_eq_pulses": bool(all(x["edges_eq_pulses"] for x in per)),
        "per_session": per,
    }
    return row, pulses


def eval_grid(sessions: list) -> dict:
    rows = {}
    for m in MARGIN_GRID:
        for n in NCONSEC_GRID:
            rows[(m, n)] = evaluate_combo(sessions, m, n)
    return rows


def gate_row(row: dict) -> dict:
    return {
        "wave_ok": bool(row["wave_pulses"] <= 1),
        "wave_pulses": int(row["wave_pulses"]),
        "recall_ok": bool(row["class1_segments"] == 27 and row["class1_detected"] >= 26),
        "class1_detected": int(row["class1_detected"]),
        "class1_segments": int(row["class1_segments"]),
        "static_ok": bool(row["silent_false_per_silent_min"] <= 0.5),
        "static_fp_per_min": float(row["silent_false_per_silent_min"]),
        "board_move_false": int(row["board_move_false"]),
    }


def gate_pass(row: dict) -> bool:
    g = gate_row(row)
    return g["wave_ok"] and g["recall_ok"] and g["static_ok"] and g["board_move_false"] == 0


def pick_config(rows: dict):
    """Prefer the online config (8/3); otherwise the smallest deviation that passes."""
    order = [(ONLINE_MARGIN_MIN, ONLINE_N_CONSEC)]
    for n in (3, 4, 5):
        for m in (8, 4, 16, 24, 32, 48, 0):
            if (m, n) not in order:
                order.append((m, n))
    for cfg in order:
        if gate_pass(rows[cfg][0]):
            return cfg, rows[cfg][0]
    best_cfg, best = None, None
    for cfg, res in rows.items():
        row = res[0]
        key = (row["wave_pulses"], -row["class1_detected"], row["silent_false"], cfg)
        if best is None or key < best:
            best, best_cfg = key, cfg
    return best_cfg, rows[best_cfg][0]


# ---------------------------------------------------------------------------
# Route training helpers
# ---------------------------------------------------------------------------
def route_a_labels(ds: dict) -> np.ndarray:
    y = ds["y"].copy()
    y[y == 2] = 0
    return y


def route_a_weights(ds: dict, wave_weight: float) -> np.ndarray:
    sw = np.ones(len(ds["y"]), dtype=np.float64)
    sw[ds["y"] == 2] = wave_weight
    return sw


def quick_pick_wave_weight(ds: dict, candidates: list, folds: int, args, log) -> float:
    y = route_a_labels(ds)
    fold_of = grouped_folds(ds["session"], y, folds, args.seed)
    scores = {}
    for cand in candidates:
        sw = route_a_weights(ds, cand)
        preds = np.full(len(y), -1, dtype=np.int64)
        for k in sorted(set(fold_of.values())):
            val = np.isin(ds["session"], [s for s, f in fold_of.items() if f == k])
            tr = ~val
            model, _secs, _ = train_model(ds["X_q"][tr], y[tr], sw[tr], args.seed + k, args.epochs,
                                          args.batch_size, args.lr, args.weight_decay, 2)
            preds[val] = predict_logits(model, ds["X_q"][val]).argmax(axis=1)
        r1 = float((preds[ds["y"] == 1] == 1).mean())
        rej = float((preds[ds["y"] == 2] == 0).mean())
        r0 = float((preds[ds["y"] == 0] == 0).mean())
        scores[cand] = {"class1_recall": round(r1, 6), "wave_reject": round(rej, 6),
                        "class0_recall": round(r0, 6)}
        log("[A] wave_weight=%.1f quick %d-fold: class1_recall=%.4f wave_reject=%.4f class0_recall=%.4f"
            % (cand, folds, r1, rej, r0))
    ok = [(c, s) for c, s in scores.items() if s["class1_recall"] >= 0.92]
    if not ok:
        ok = sorted(scores.items(), key=lambda kv: (-kv[1]["class1_recall"], -kv[1]["wave_reject"]))
        return float(ok[0][0]), scores
    best = sorted(ok, key=lambda kv: (-kv[1]["wave_reject"], -kv[1]["class1_recall"], kv[0]))[0]
    return float(best[0]), scores


# ---------------------------------------------------------------------------
# Artifact JSON
# ---------------------------------------------------------------------------
def flat_list(layers: list, key: str) -> list:
    out = []
    for L in layers:
        out.extend(int(v) for v in L[key])
    return out


def make_params_doc(route: str, p: dict, words: list, ds: dict, meta: dict) -> dict:
    n_cls = int(p["num_classes"])
    layers = p["layers"]
    if n_cls == 2:
        fc_base, bias_base, sh_base = TWO_FC_BASE, TWO_BIAS_BASE, TWO_SH_BASE
        class_names = CLASS_NAMES_2
        schema = "nn_params_2cls"
    else:
        fc_base, bias_base, sh_base = Q.LAYOUT[3][1], Q.LAYOUT[4][1], Q.LAYOUT[5][1]
        class_names = CLASS_NAMES_3
        schema = "nn_params_3cls"
    rom = {
        "conv_weights_words": 4896,
        "fc_words": 240 * n_cls,
        "bias_words": 50 + (n_cls - 2),
        "sh_words": 50 + (n_cls - 2),
        "total_words": len(words),
        "fc_word_base": fc_base,
        "bias_base": bias_base,
        "sh_base": sh_base,
        "addr_bits": 13,
        "layout": p["layout"],
    }
    doc = {
        "schema": schema,
        "generated": now_iso(),
        "module": "nn_rom_data",
        "num_classes": n_cls,
        "class_names": class_names,
        "chosen_route": route,
        "route_definition": meta["route_definition"],
        "route_reason": meta["route_reason"],
        "data": ds["path"],
        "n_windows_used": int(ds["n_windows"]),
        "class_counts_used": {str(k): int(v) for k, v in meta["class_counts_used"].items()},
        "protocol": meta["protocol"],
        "cv": meta["cv"],
        "gate_v5": meta["gate"],
        "rom_words": len(words),
        "fc_word_base": fc_base,
        "bias_base": bias_base,
        "sh_base": sh_base,
        "bias_int32": flat_list(layers, "bias_int32"),
        "sh": flat_list(layers, "SH"),
        "cnn_params": p,
        "rom": rom,
        "int8_agreement_float_vs_int8": float(meta["int8_match"]),
        "final_model": meta["final_model"],
        "deployment_note": meta["deployment_note"],
    }
    return doc


def save_npz(path: Path, arrays: dict) -> None:
    """Write an .npz that may contain a member literally named 'file'.

    np.savez() cannot take a keyword named 'file' (it binds the path parameter),
    and the v4 dataset uses that key name, so write the zip container directly.
    """
    import io
    import zipfile

    with zipfile.ZipFile(str(path), "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, value in arrays.items():
            buf = io.BytesIO()
            np.lib.format.write_array(buf, np.asanyarray(value), allow_pickle=False)
            zf.writestr(str(name) + ".npy", buf.getvalue())


def write_dataset_v5(ds: dict, path: Path, recommended: str) -> dict:
    raw = ds["raw"]
    payload = {}
    for k in raw.files:
        payload[k] = np.asarray(raw[k])
    y = ds["y"]
    y_fold = np.where(y == 2, 0, y).astype(np.uint8)
    wave_mask = (y == 2)
    sess_sorted = sorted(set(ds["session"].tolist()))
    fold_of = {s: i for i, s in enumerate(sess_sorted)}
    loo_fold = np.array([fold_of[s] for s in ds["session"].tolist()], dtype=np.int16)
    label_route = y_fold if recommended.startswith("A") else y
    payload["y_orig"] = y.astype(np.uint8)
    payload["y_fold"] = y_fold
    payload["wave_mask"] = wave_mask
    payload["loo_fold"] = loo_fold
    payload["label_for_recommended_route"] = np.asarray(label_route, dtype=np.uint8)
    payload["v5_route_recommended"] = np.asarray(recommended)
    payload["v5_note"] = np.asarray(
        "v5 adds y_fold (y=2 -> 0), wave_mask, loo_fold (session index), "
        "label_for_recommended_route; every v4 field is preserved unchanged")
    save_npz(path, payload)
    return {"path": str(path), "bytes": int(path.stat().st_size), "keys_added": ["y_fold", "wave_mask", "loo_fold",
                                                                               "label_for_recommended_route"]}


# ---------------------------------------------------------------------------
# Report / evidence text
# ---------------------------------------------------------------------------
def build_report(meta: dict) -> str:
    lines = []
    ok = meta["verdict"]
    lines.append("TRAIN_V5_OK=%d" % (1 if ok else 0))
    lines.append("")
    lines.append("# M2d 训练 v5：挥手不再误判为手部开合（task-29）")
    lines.append("")
    if ok:
        lines.append("**结论**：推荐 **%s**，部署件（int8，全部 1729 窗训练）离线决策链回放同时满足 "
                     "挥手 pulse=%d（基线 6）、class1 段召回 %d/27、静默误触 %.3f 次/分、板移 0。"
                     % (meta["recommended_label"], meta["gate"]["wave_pulses"], meta["gate"]["class1_detected"],
                        meta["gate"]["static_fp_per_min"]))
    else:
        lines.append("**结论**：未通过全部判据（见下表）。推荐路线 **%s**，差距：挥手 pulse=%d、class1 召回 %d/27、"
                     "静默误触 %.3f 次/分。" % (meta["recommended_label"], meta["gate"]["wave_pulses"],
                                                meta["gate"]["class1_detected"],
                                                meta["gate"]["static_fp_per_min"]))
    lines.append("")
    lines.append("## 1. 判据（部署件 = 全部数据训练 + int8 权重回放，与 task-28 基线同口径）")
    lines.append("")
    lines.append("| 判据 | 目标 | A 二分类折叠 | B 三分类 | 说明 |")
    lines.append("|---|---|---|---|---|")
    a, b = meta["routes"]["A"], meta["routes"]["B"]
    lines.append("| INT8_MATCH | ≥0.99 | %.6f | %.6f | 全部 1729 窗 float/int8 argmax 一致率 |"
                 % (a["int8_match"], b["int8_match"]))
    lines.append("| WAVE_PULSES | ≤1 | %d | %d | 3 条挥手会话回放总 pulse（基线 6） |"
                 % (a["row"]["wave_pulses"], b["row"]["wave_pulses"]))
    lines.append("| CLASS1_RECALL_SEGS | ≥26/27 | %d/%d | %d/%d | class1 动作段检出 |"
                 % (a["row"]["class1_detected"], a["row"]["class1_segments"],
                    b["row"]["class1_detected"], b["row"]["class1_segments"]))
    lines.append("| STATIC_FP_PER_MIN | ≤0.5 | %.3f | %.3f | 非 210307 会话 y=0 窗 pulse / 静默分钟 |"
                 % (a["row"]["silent_false_per_silent_min"], b["row"]["silent_false_per_silent_min"]))
    lines.append("| 板移 210307 | 0 | %d | %d | 板移噪声会话 |"
                 % (a["row"]["board_move_false"], b["row"]["board_move_false"]))
    lines.append("| 回放配置 | 线上 8/3 | %d/%.0f | %d/%.0f | MARGIN_MIN / N_CONSEC |" % (
        a["cfg"][0], a["cfg"][1], b["cfg"][0], b["cfg"][1]))
    lines.append("")
    lines.append("## 2. 留一会话交叉验证（honest / 该会话从未参与训练；每折单独量化后的 int8 权重回放，20 折 LOO）")
    lines.append("")
    lines.append("| 指标 | A 二分类折叠 | B 三分类 |")
    lines.append("|---|---|---|")
    lines.append("| 窗口级 accuracy | %.4f | %.4f |" % (a["loo"]["window_acc"], b["loo"]["window_acc"]))
    lines.append("| class1 窗口 recall | %.4f | %.4f |" % (a["loo"]["class1_recall"], b["loo"]["class1_recall"]))
    if "wave_reject" in a["loo"]:
        lines.append("| 挥手窗判成 class0 比例 | %.4f | — |" % a["loo"]["wave_reject"])
    if "wave_as2" in b["loo"]:
        lines.append("| 挥手窗判成 class2 比例 | — | %.4f |" % b["loo"]["wave_as2"])
    lines.append("| 挥手 pulse（各自配置） | %d | %d |" % (a["loo_row"]["wave_pulses"], b["loo_row"]["wave_pulses"]))
    lines.append("| class1 段召回 | %d/%d | %d/%d |"
                 % (a["loo_row"]["class1_detected"], a["loo_row"]["class1_segments"],
                    b["loo_row"]["class1_detected"], b["loo_row"]["class1_segments"]))
    lines.append("| 静默误触 | %.3f 次/分 | %.3f 次/分 |"
                 % (a["loo_row"]["silent_false_per_silent_min"], b["loo_row"]["silent_false_per_silent_min"]))
    lines.append("")
    lines.append("## 3. 训练与量化")
    lines.append("")
    lines.append("- 数据：%s，%d 窗 / %d 会话，y=0:%d / y=1:%d / y=2:%d；win=%dms stride=%dms。"
                 % (meta["data"], meta["n_windows"], meta["n_sessions"], meta["class_counts"].get(0, 0),
                    meta["class_counts"].get(1, 0), meta["class_counts"].get(2, 0), meta["win_ms"], meta["stride_ms"]))
    lines.append("- 网络：nn/model.py P1CNN（conv1 8x14x24 / conv2 16x6x11 / conv3 24x2x5 / fc 240->N），无 BN/dropout。")
    lines.append("- 训练：Adam lr=%.4g wd=%.1e，CosineAnnealing，%d epoch，batch=%d，seed=%d；"
                 "class_weight=sqrt(N/(C*n)) clip[0.5,3.0]。"
                 % (meta["lr"], meta["wd"], meta["epochs"], meta["batch"], meta["seed"]))
    if "A" in meta["routes"]:
        lines.append("- A 路线：y=2 全部重标为 0，并给挥手窗样本权重 %s（%s 选出）。"
                     % (meta["wave_weight"], meta["weight_selection"]["folds"]))
    lines.append("- B 路线：保留三分类，class2=wave（%d 窗）。" % meta["class_counts"].get(2, 0))
    lines.append("- 量化：nn/quantize.py per-output-channel int8 + 校准集=全部训练窗；int8 前向另用 nn/ref_cnn.py 逐位复算。")
    lines.append("- 部署件都是在**全部窗口**上训练（与 v4 一致），因此第 1 节是 in-sample 回放；第 2 节才是泛化估计。")
    lines.append("")
    lines.append("## 4. 决策链回放细节")
    lines.append("")
    lines.append("- 100 ms 决策步（start_offset=2），nn_decide：hit=(argmax==class1)&&margin>=MARGIN_MIN，"
                 "连续 N_CONSEC 次出 pulse，pulse 后 1.5 s refractory。")
    lines.append("- 2 分类 margin=|logit0-logit1|；3 分类 margin=logit1-max(logit0,logit2)（命中类固定为 1，与二分类口径一致）。")
    for tag in ("A", "B"):
        r = meta["routes"][tag]
        lines.append("- %s：回放配置 %d/%.0f，pulse 总数 %d（class1 %d + 挥手 %d + 静默 %d + 板移 %d），"
                     "class1 重复段 %d，VALID 上升沿==pulse：%s。"
                     % (tag, r["cfg"][0], r["cfg"][1], r["row"]["total_pulses"], r["row"]["class1_pulses"],
                        r["row"]["wave_pulses"], r["row"]["silent_false"], r["row"]["board_move_false"],
                        r["row"]["class1_repeated_segments"], r["row"]["edges_eq_pulses"]))
        if r["wave_detail"]:
            lines.append("- %s 挥手 pulse 明细：%s" % (tag, ", ".join(r["wave_detail"])))
    lines.append("")
    lines.append("## 5. 推荐与局限")
    lines.append("")
    for line in meta["recommendation_lines"]:
        lines.append("- " + line)
    lines.append("")
    lines.append("## 6. 产物与复现")
    lines.append("")
    for line in meta["artifact_lines"]:
        lines.append("- " + line)
    lines.append("")
    lines.append("复现命令（cwd=E:/workspace/FPGA_Comp）：")
    lines.append("")
    lines.append(PY_FENCE)
    for cmd in meta["commands"]:
        lines.append(cmd)
    lines.append(PY_FENCE)
    lines.append("")
    return "\n".join(lines)


def build_evidence(meta: dict) -> str:
    lines = []
    lines.append("TRAIN_V5_OK=%d" % (1 if meta["verdict"] else 0))
    lines.append("# M2d 训练 v5 证据日志（task-29）")
    lines.append("generated=%s" % now_iso())
    lines.append("data=%s" % meta["data"])
    lines.append("n_windows=%d n_sessions=%d class_counts=%s" % (meta["n_windows"], meta["n_sessions"],
                                                                 json.dumps(meta["class_counts"])))
    lines.append("")
    lines.append("## 判据（推荐路线 %s，部署件 int8 回放，配置 MARGIN_MIN=%d N_CONSEC=%d）"
                 % (meta["recommended_label"], meta["gate_cfg"][0], meta["gate_cfg"][1]))
    lines.append("INT8_MATCH=%.6f" % meta["gate"]["int8_match"])
    lines.append("WAVE_PULSES=%d" % meta["gate"]["wave_pulses"])
    lines.append("CLASS1_RECALL_SEGS=%d/%d" % (meta["gate"]["class1_detected"], meta["gate"]["class1_segments"]))
    lines.append("STATIC_FP_PER_MIN=%.3f" % meta["gate"]["static_fp_per_min"])
    lines.append("BOARD_MOVE_FP=%d" % meta["gate"]["board_move_false"])
    lines.append("")
    for tag in ("A", "B"):
        if tag not in meta["routes"]:
            continue
        r = meta["routes"][tag]
        lines.append("## 路线 %s（%s）" % (tag, r["label"]))
        lines.append("%s_INT8_MATCH=%.6f" % (tag, r["int8_match"]))
        lines.append("%s_CONFIG=MARGIN_MIN=%d,N_CONSEC=%d" % (tag, r["cfg"][0], r["cfg"][1]))
        lines.append("%s_WAVE_PULSES=%d" % (tag, r["row"]["wave_pulses"]))
        lines.append("%s_CLASS1_RECALL_SEGS=%d/%d" % (tag, r["row"]["class1_detected"], r["row"]["class1_segments"]))
        lines.append("%s_STATIC_FP_PER_MIN=%.3f" % (tag, r["row"]["silent_false_per_silent_min"]))
        lines.append("%s_BOARD_MOVE_FP=%d" % (tag, r["row"]["board_move_false"]))
        lines.append("%s_CLASS1_PULSES=%d" % (tag, r["row"]["class1_pulses"]))
        lines.append("%s_TOTAL_PULSES=%d" % (tag, r["row"]["total_pulses"]))
        lines.append("%s_VALID_EDGES_EQ_PULSES=%d" % (tag, int(r["row"]["edges_eq_pulses"])))
        lines.append("%s_LOO_WAVE_PULSES=%d" % (tag, r["loo_row"]["wave_pulses"]))
        lines.append("%s_LOO_CLASS1_RECALL_SEGS=%d/%d"
                     % (tag, r["loo_row"]["class1_detected"], r["loo_row"]["class1_segments"]))
        lines.append("%s_LOO_STATIC_FP_PER_MIN=%.3f" % (tag, r["loo_row"]["silent_false_per_silent_min"]))
        lines.append("%s_LOO_WINDOW_ACC=%.4f" % (tag, r["loo"]["window_acc"]))
        lines.append("%s_LOO_CLASS1_WINDOW_RECALL=%.4f" % (tag, r["loo"]["class1_recall"]))
        if "wave_reject" in r["loo"]:
            lines.append("%s_LOO_WAVE_REJECT=%.4f" % (tag, r["loo"]["wave_reject"]))
        if "wave_as2" in r["loo"]:
            lines.append("%s_LOO_WAVE_AS_CLASS2=%.4f" % (tag, r["loo"]["wave_as2"]))
        if tag == "A":
            lines.append("A_WAVE_WEIGHT=%.1f" % meta["wave_weight"])
        lines.append("")
    lines.append("## 产物")
    for line in meta["artifact_lines"]:
        lines.append(line)
    lines.append("")
    lines.append("## 命令")
    for cmd in meta["commands"]:
        lines.append(cmd)
    lines.append("")
    lines.append("## 备注")
    for line in meta["notes"]:
        lines.append("- " + line)
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="M2d v5 training: wave-vs-class1 (task-29)")
    ap.add_argument("--data", default=DATA_DEFAULT)
    ap.add_argument("--out-dir", default=OUT_DEFAULT)
    ap.add_argument("--route", default="all", choices=["A", "B", "all"])
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--wave-weights", default="3,6")
    ap.add_argument("--select-folds", type=int, default=5)
    ap.add_argument("--loo-max", type=int, default=0, help="0 = all sessions")
    ap.add_argument("--calib", type=int, default=0, help="0 = all training windows")
    ap.add_argument("--quick", action="store_true", help="smoke test: 2 sessions, 4 epochs")
    ap.add_argument("--evid", default=EVID_DEFAULT)
    ap.add_argument("--report", default=REPORT_DEFAULT)
    args = ap.parse_args(argv)
    if args.quick:
        args.epochs = 4
        args.loo_max = 2
        args.select_folds = 2
    return args


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    t_start = time.time()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ds = load_dataset(Path(args.data))
    log_lines = []

    def log(msg: str) -> None:
        log_lines.append(msg)
        print(msg, flush=True)

    log("[v5] data=%s n=%d sessions=%d counts=%s win=%dms stride=%dms"
        % (ds["path"], ds["n_windows"], ds["n_sessions"], ds["class_counts"], ds["win_ms"], ds["stride_ms"]))
    y = ds["y"]
    wave_weight = float(args.wave_weights.split(",")[0])
    weight_sel = {"folds": "n/a", "rule": "n/a", "scores": {}}
    routes = {}
    wave_candidates = [float(v) for v in args.wave_weights.split(",") if v.strip()]
    sess_sorted = sorted(set(ds["session"].tolist()))
    loo_sessions = sess_sorted[:args.loo_max] if args.loo_max else sess_sorted

    # ---- Route A -----------------------------------------------------------
    if args.route in ("A", "all"):
        log("[A] === route A: two-class fold (y=2 -> class0), wave windows are hard negatives ===")
        wave_weight, scores = quick_pick_wave_weight(ds, wave_candidates, args.select_folds, args, log)
        weight_sel = {"folds": "%d-fold session-grouped" % args.select_folds,
                      "rule": "class1_recall>=0.92, then max wave_reject, then min weight",
                      "scores": {str(k): v for k, v in scores.items()}}
        y_a = route_a_labels(ds)
        sw_a = route_a_weights(ds, wave_weight)
        loo_a = np.zeros((len(y), 2), dtype=np.float32)
        loo_time = 0.0
        for name in loo_sessions:
            val = ds["session"] == name
            model, secs, _ = train_model(ds["X_q"][~val], y_a[~val], sw_a[~val], args.seed, args.epochs,
                                         args.batch_size, args.lr, args.weight_decay, 2)
            p_fold, _w_fold, probs_fold = quantize_artifact(model, ds["X_q"][~val], 2)
            if probs_fold:
                raise RuntimeError("fold quantize failed: %s" % probs_fold)
            loo_a[val] = int8_logits(ds["X_q"][val], doc_layers(p_fold))
            loo_time += secs
        log("[A] LOO %d sessions in %.1fs" % (len(loo_sessions), loo_time))
        model_a, final_secs, final_loss = train_model(ds["X_q"], y_a, sw_a, args.seed, args.epochs,
                                                      args.batch_size, args.lr, args.weight_decay, 2)
        float_logits_a = predict_logits(model_a, ds["X_q"])
        x_cal = ds["X_q"] if args.calib <= 0 else ds["X_q"][np.linspace(0, len(y) - 1, args.calib).astype(int)]
        p_a, words_a, problems_a = quantize_artifact(model_a, x_cal, 2)
        int8_a = int8_logits(ds["X_q"], doc_layers(p_a))
        match_a = float((float_logits_a.argmax(1) == int8_a.argmax(1)).mean())
        log("[A] final model %.1fs loss=%.4f int8 words=%d problems=%s INT8_MATCH=%.6f"
            % (final_secs, final_loss, len(words_a), problems_a or "-", match_a))
        assert not problems_a, problems_a
        routes["A"] = {"y": y_a, "sw": sw_a, "loo": loo_a, "loo_sessions": loo_sessions,
                       "float_logits": float_logits_a, "int8_logits": int8_a,
                       "int8_match": float(match_a), "params": p_a, "words": words_a,
                       "final_seconds": final_secs, "loo_seconds": round(loo_time, 2)}

    # ---- Route B -----------------------------------------------------------
    if args.route in ("B", "all"):
        log("[B] === route B: three-class (class2 = wave) ===")
        sw_b = np.ones(len(y), dtype=np.float64)
        loo_b = np.zeros((len(y), 3), dtype=np.float32)
        loo_time = 0.0
        for name in loo_sessions:
            val = ds["session"] == name
            model, secs, _ = train_model(ds["X_q"][~val], y[~val], sw_b[~val], args.seed, args.epochs,
                                         args.batch_size, args.lr, args.weight_decay, 3)
            p_fold, _w_fold, probs_fold = quantize_artifact(model, ds["X_q"][~val], 3)
            if probs_fold:
                raise RuntimeError("fold quantize failed: %s" % probs_fold)
            loo_b[val] = int8_logits(ds["X_q"][val], doc_layers(p_fold))
            loo_time += secs
        log("[B] LOO %d sessions in %.1fs" % (len(loo_sessions), loo_time))
        model_b, final_secs, final_loss = train_model(ds["X_q"], y, sw_b, args.seed, args.epochs,
                                                      args.batch_size, args.lr, args.weight_decay, 3)
        float_logits_b = predict_logits(model_b, ds["X_q"])
        x_cal = ds["X_q"] if args.calib <= 0 else ds["X_q"][np.linspace(0, len(y) - 1, args.calib).astype(int)]
        p_b, words_b, problems_b = quantize_artifact(model_b, x_cal, 3)
        int8_b = int8_logits(ds["X_q"], doc_layers(p_b))
        match_b = float((float_logits_b.argmax(1) == int8_b.argmax(1)).mean())
        log("[B] final model %.1fs loss=%.4f int8 words=%d problems=%s INT8_MATCH=%.6f"
            % (final_secs, final_loss, len(words_b), problems_b or "-", match_b))
        assert not problems_b, problems_b
        routes["B"] = {"y": y, "sw": sw_b, "loo": loo_b, "loo_sessions": loo_sessions,
                       "float_logits": float_logits_b, "int8_logits": int8_b,
                       "int8_match": float(match_b), "params": p_b, "words": words_b,
                       "final_seconds": final_secs, "loo_seconds": round(loo_time, 2)}

    # ---- Evaluate ----------------------------------------------------------
    for tag, r in routes.items():
        sessions = build_sessions(ds, r["int8_logits"])
        rows = eval_grid(sessions)
        cfg, row = pick_config(rows)
        r["cfg"] = cfg
        r["row"] = row
        r["wave_detail"] = ["%s @%dms margin=%d conf=%d" % (p["short"], p["decision_time_ms"], p["margin"], p["conf"])
                            for p in rows[cfg][1] if p["y"] == 2]
        loo_sessions_data = build_sessions(ds, r["loo"])
        loo_rows = eval_grid(loo_sessions_data)
        loo_cfg, loo_row = pick_config(loo_rows)
        r["loo_cfg"] = loo_cfg
        r["loo_row"] = loo_row
        pred = r["loo"].argmax(1)
        loo_metrics = {
            "window_acc": round(float((pred == r["y"]).mean()), 6),
            "class1_recall": round(float((pred[r["y"] == 1] == 1).mean()), 6),
        }
        wave = r["y"] == 2
        if wave.any():
            loo_metrics["wave_reject"] = round(float((pred[wave] == 0).mean()), 6)
            if tag == "B":
                loo_metrics["wave_as2"] = round(float((pred[wave] == 2).mean()), 6)
        r["loo_metrics"] = loo_metrics
        log("[%s] deployed replay cfg=%s pulses=%d wave=%d class1=%d/%d static_fp=%.3f board=%d"
            % (tag, cfg, row["total_pulses"], row["wave_pulses"], row["class1_detected"],
               row["class1_segments"], row["silent_false_per_silent_min"], row["board_move_false"]))
        log("[%s] LOO replay cfg=%s pulses=%d wave=%d class1=%d/%d static_fp=%.3f"
            % (tag, loo_cfg, loo_row["total_pulses"], loo_row["wave_pulses"], loo_row["class1_detected"],
               loo_row["class1_segments"], loo_row["silent_false_per_silent_min"]))

    # ---- Gate / recommendation --------------------------------------------
    def gate_obj(tag: str) -> dict:
        r = routes[tag]
        g = gate_row(r["row"])
        g["int8_match"] = float(r["int8_match"])
        g["config"] = {"margin_min": r["cfg"][0], "n_consec": r["cfg"][1]}
        return g

    gates = {tag: gate_obj(tag) for tag in routes}
    passing = [tag for tag in routes if all([gates[tag]["wave_ok"], gates[tag]["recall_ok"],
                                             gates[tag]["static_ok"], gates[tag]["board_move_false"] == 0,
                                             gates[tag]["int8_match"] >= 0.99])]
    if passing:
        recommended = "B" if "B" in passing else "A"
        if "B" in passing and "A" in passing:
            recommended = "B" if gates["B"]["class1_detected"] >= gates["A"]["class1_detected"] else "A"
        verdict = 1
    else:
        ranked = sorted(routes.keys(), key=lambda t: (0 if gates[t]["wave_ok"] else 1,
                                                     0 if gates[t]["recall_ok"] else 1,
                                                     -gates[t]["class1_detected"], gates[t]["wave_pulses"]))
        recommended = ranked[0]
        verdict = 0
    route_label = {"A": "A 二分类折叠", "B": "B 三分类"}
    rec = routes[recommended]
    gate = gates[recommended]

    meta = {
        "verdict": bool(verdict),
        "recommended": recommended,
        "recommended_label": route_label[recommended],
        "gate": gate,
        "gate_cfg": rec["cfg"],
        "routes": {},
        "wave_weight": wave_weight,
        "weight_selection": weight_sel,
        "data": ds["path"],
        "n_windows": ds["n_windows"],
        "n_sessions": ds["n_sessions"],
        "class_counts": ds["class_counts"],
        "win_ms": ds["win_ms"],
        "stride_ms": ds["stride_ms"],
        "seed": args.seed, "epochs": args.epochs, "batch": args.batch_size,
        "lr": args.lr, "wd": args.weight_decay,
    }
    for tag, r in routes.items():
        meta["routes"][tag] = {
            "label": route_label[tag], "int8_match": r["int8_match"], "cfg": r["cfg"], "row": r["row"],
            "loo_cfg": r["loo_cfg"], "loo_row": r["loo_row"], "loo": r["loo_metrics"],
            "wave_detail": r["wave_detail"], "final_seconds": r["final_seconds"],
            "loo_seconds": r["loo_seconds"], "params": r["params"], "words": r["words"],
        }

    # ---- Artifacts ---------------------------------------------------------
    artifacts = []
    for tag, r in routes.items():
        n_cls = 2 if tag == "A" else 3
        if n_cls == 2:
            json_path = out_dir / "nn_params_2cls.json"
            rom_path = out_dir / "nn_rom_data_2cls.v"
            write_rom_2cls(rom_path, r["words"], rom_layout_2cls())
        else:
            json_path = out_dir / "nn_params_3cls.json"
            rom_path = out_dir / "nn_rom_data_3cls.v"
            write_rom_3cls(rom_path, r["words"])
        meta_r = {
            "route_definition": ("A: 全部窗训练；挥手会话 y=2 重标为 class0，样本权重 %.1f（二分类部署件，ROM 5476 字）" % wave_weight
                                 if tag == "A" else
                                 "B: 三分类训练（class0 无/板移、class1 手部开合、class2 挥手），class2 不再产生 class1 pulse（ROM 5718 字）"),
            "route_reason": ("与 v4 同 ROM 契约，RTL 只需 NUM_CLASSES=2；把挥手当硬负样本教会模型拒绝该方向运动"
                             if tag == "A" else
                             "保留挥手的独立类别，模型可显式输出 class2，从而 class1 不再命中；代价是 RTL NUM_CLASSES=3"),
            "class_counts_used": {0: int((r["y"] == 0).sum()), 1: int((r["y"] == 1).sum()),
                                  **({2: int((r["y"] == 2).sum())} if tag == "B" else {})},
            "protocol": {
                "cv": "leave-one-session-out (%d folds)" % len(r["loo_sessions"]),
                "epochs": args.epochs, "batch_size": args.batch_size, "lr": args.lr,
                "weight_decay": args.weight_decay, "seed": args.seed,
                "note": "deployed artifact trained on all windows (same as v4); LOO numbers are the honest ones",
            },
            "cv": {"loo": {k: v for k, v in r["loo_metrics"].items()
                           if k in ("window_acc", "class1_recall", "wave_reject", "wave_as2")},
                   "loo_seconds": r["loo_seconds"],
                   "loo_replay": {"config": {"margin_min": r["loo_cfg"][0], "n_consec": r["loo_cfg"][1]},
                                  "wave_pulses": r["loo_row"]["wave_pulses"],
                                  "class1_detected": r["loo_row"]["class1_detected"],
                                  "class1_segments": r["loo_row"]["class1_segments"],
                                  "silent_false_per_silent_min": r["loo_row"]["silent_false_per_silent_min"],
                                  "class1_recall": r["loo_row"]["class1_recall"]}},
            "gate": {"criteria": {"int8_match_min": 0.99, "wave_pulses_max": 1, "class1_detected_min": 26,
                                  "class1_segments": 27, "static_fp_per_min_max": 0.5, "board_move_false": 0},
                     "deployed": gate_row(r["row"]),
                     "pass": bool(all([gates[tag]["wave_ok"], gates[tag]["recall_ok"], gates[tag]["static_ok"],
                                       gates[tag]["board_move_false"] == 0, gates[tag]["int8_match"] >= 0.99]))},
            "int8_match": r["int8_match"],
            "final_model": {"train_seconds": round(r["final_seconds"], 2),
                            "params": int(sum(int(l["weight_count"]) for l in r["params"]["layers"])),
                            "note": "trained on all used windows only to emit ROM bytes; LOO numbers above are the honest ones"},
            "deployment_note": ("Replace nn_rom_data.v with out_v5/nn_rom_data_2cls.v and keep NUM_CLASSES=2; 13-bit address unchanged."
                                if tag == "A" else
                                "Replace nn_rom_data.v with out_v5/nn_rom_data_3cls.v and set NUM_CLASSES=3; 13-bit address unchanged."),
        }
        doc = make_params_doc(tag, r["params"], r["words"], ds, meta_r)
        json_path.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        artifacts.append({"tag": tag, "json": str(json_path), "rom": str(rom_path),
                          "json_bytes": int(json_path.stat().st_size), "rom_words": len(r["words"]),
                          "sha256_json": sha256(json_path), "sha256_rom": sha256(rom_path)})
        log("[out] wrote %s (%d words) + %s" % (json_path.name, len(r["words"]), rom_path.name))

    ds_path = out_dir / "dataset_v5_w100.npz"
    ds_info = write_dataset_v5(ds, ds_path, "A_fold_2cls" if recommended == "A" else "B_3cls")
    log("[out] wrote %s (%d MB)" % (ds_path.name, ds_info["bytes"] // (1 << 20)))

    # ---- Report / evidence -------------------------------------------------
    commands = [
        "E:/workspace/FPGA_Comp/nn/.venv/Scripts/python.exe nn/train_v5.py --route all",
        "E:/workspace/FPGA_Comp/nn/.venv/Scripts/python.exe nn/check_rom_2cls.py --json %s --rom %s --evid %s"
        % (out_dir / "nn_params_2cls.json", out_dir / "nn_rom_data_2cls.v", out_dir / "ROM2_CHECK_v5.log"),
    ]
    rec_lines = []
    rec_lines.append("A 与 B 都用同一份数据、同一网络、同一量化/回放代码；部署件都在全部窗口上训练（与 v4 同口径），第 2 节是 LOO 泛化列。")
    if verdict:
        rec_lines.append("推荐 %s：挥手 pulse %d（基线 6），class1 %d/%d，静默 %.3f 次/分，INT8_MATCH %.6f，配置 %d/%d%s。"
                         % (route_label[recommended], gate["wave_pulses"], gate["class1_detected"],
                            gate["class1_segments"], gate["static_fp_per_min"], gate["int8_match"],
                            rec["cfg"][0], rec["cfg"][1],
                            "（=线上配置，无需改 RTL 常量）" if rec["cfg"] == (8, 3) else "（需改 RTL 常量）"))
        for t in [x for x in routes if x != recommended]:
            g = gates[t]
            passed = (g["wave_ok"] and g["recall_ok"] and g["static_ok"] and g["board_move_false"] == 0
                      and g["int8_match"] >= 0.99)
            rec_lines.append("%s 未选：挥手 %d、class1 %d/%d、静默 %.3f 次/分、INT8 %.6f（四判据通过=%s）。"
                             % (route_label[t], g["wave_pulses"], g["class1_detected"], g["class1_segments"],
                                g["static_fp_per_min"], g["int8_match"], "是" if passed else "否"))
    else:
        rec_lines.append("没有路线同时满足四条判据；推荐 %s 是差距最小的：挥手 %d（目标≤1）、class1 %d/27（目标≥26）、"
                         "静默 %.3f 次/分（目标≤0.5）、INT8 %.6f。"
                         % (route_label[recommended], gate["wave_pulses"], gate["class1_detected"],
                            gate["static_fp_per_min"], gate["int8_match"]))
    for tag in routes:
        rr = routes[tag]
        rec_lines.append("%s LOO（留一会话）回放：挥手 %d、class1 %d/%d、静默 %.3f 次/分；class1 窗口 recall %.4f。"
                         % (route_label[tag], rr["loo_row"]["wave_pulses"], rr["loo_row"]["class1_detected"],
                            rr["loo_row"]["class1_segments"], rr["loo_row"]["silent_false_per_silent_min"],
                            rr["loo_metrics"]["class1_recall"]))
    rec_lines.append("局限：全部决策窗只有 1.415 min，1 个事件=0.71 次/分，所以 0 事件在 95% 置信下仍只能约束到约 2.1 次/分；"
                     "挥手只有 3 条会话/205 个 y=2 决策窗，LOO 列才是对『新录一段挥手』的诚实估计。")
    rec_lines.append("部署建议：%s 的 ROM/参数见产物；上板后用新录的挥手会话再回放一次，确认 LOO 列趋势。" % route_label[recommended])
    meta["recommendation_lines"] = rec_lines
    meta["artifact_lines"] = []
    for a in artifacts:
        meta["artifact_lines"].append("%s：%s（%d 字 ROM，json %d B，sha256 %s…）"
                                      % (a["tag"], Path(a["json"]).name, a["rom_words"], a["json_bytes"],
                                         a["sha256_json"][:12]))
    meta["artifact_lines"].append("dataset_v5：%s（%d MB，新增 y_fold / wave_mask / loo_fold / label_for_recommended_route）"
                                  % (Path(ds_info["path"]).name, ds_info["bytes"] // (1 << 20)))
    meta["artifact_lines"].append("报告：%s；证据：%s" % (Path(args.report).name, Path(args.evid).name))
    meta["commands"] = commands
    meta["notes"] = [
        "INT8 前向用 nn/ref_cnn.py 逐位复算（与 task-28 标定同一条参考实现）。",
        "决策窗口起点 start_offset=2（t0=100 ms），步长 100 ms，与线上 100 ms 决策节拍一致。",
        "挥手 pulse 只在 y=2 决策窗上统计；静默误触不含 210307。",
        "2 分类命中条件 argmax==1；3 分类命中条件 argmax==1 且 margin=logit1-max(logit0,logit2)。",
        "LOO 列：每折模型用该折训练窗做校准量化，再对留出会话跑 int8 前向，因此与部署件同口径。",
        "dataset_v5 的所有 v4 键名保持不变，新增列用于下一张 v5 标定卡。",
        "环境：nn/.venv（Python 3.12.14 + torch 2.15.0+cpu + numpy 2.5.4）；trainingData/.venv 无 torch，不能用于训练。",
    ]

    Path(args.report).write_text(build_report(meta), encoding="utf-8")
    Path(args.evid).parent.mkdir(parents=True, exist_ok=True)
    Path(args.evid).write_text(build_evidence(meta), encoding="utf-8")
    log("[out] wrote %s and %s" % (args.report, args.evid))

    print("")
    print("TRAIN_V5_OK=%d" % (1 if verdict else 0))
    print("INT8_MATCH=%.6f" % gate["int8_match"])
    print("WAVE_PULSES=%d" % gate["wave_pulses"])
    print("CLASS1_RECALL_SEGS=%d/%d" % (gate["class1_detected"], gate["class1_segments"]))
    print("STATIC_FP_PER_MIN=%.3f" % gate["static_fp_per_min"])
    print("BOARD_MOVE_FP=%d" % gate["board_move_false"])
    print("CHOSEN_ROUTE=%s" % recommended)
    print("CHOSEN_CONFIG=MARGIN_MIN=%d,N_CONSEC=%d" % (rec["cfg"][0], rec["cfg"][1]))
    print("ELAPSED_S=%.1f" % (time.time() - t_start))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
