#!/usr/bin/env python3
"""QC 门禁：对事件相机 CSV 做「可用性」判定（task-19）。

判据口径（与 nn/REPORT_QC与数据集v4.md 一致）：
  - 密度：全部帧的每帧事件数中位数（不是活跃帧均值），800 ~ 2,000 ev/frame；
  - 活跃段：frame_counts >= 60 的帧，首末时间跨度 >= 2.0 s；
  - 横向摆幅：活跃帧逐帧事件质心的 x 序列，线性去趋势后 ptp >= 120 px；
  - 摆动周期：上述去趋势序列做 3 点滑动平均，符号变化次数 / 2 >= 3；
  - 活跃帧占比：活跃帧数 / 总帧数 >= 0.35。

输出稳定：不含时间戳/随机数，JSON 使用 sort_keys + 紧凑分隔符。
同一输入连跑两次输出逐字节一致。

用法：
  python qc_clip.py <csv-or-dir> [...]
  python qc_clip.py --set density_max=2500 <dir>
  python qc_clip.py --json-out qc.json <dir>
退出码：0=完成判定（即使有 FAIL）；2=参数/读取错误。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import extract_events as E  # noqa: E402

ACTIVE_FRAME_EVENTS = 60.0
DEFAULT_THRESHOLDS = {
    "density_min": 800.0,
    "density_max": 2000.0,
    "active_duration_ms": 2000.0,
    "swing_px": 120.0,
    "cycles": 3.0,
    "active_ratio": 0.35,
    "active_frame_events": ACTIVE_FRAME_EVENTS,
}
THRESHOLD_KEYS = tuple(DEFAULT_THRESHOLDS.keys())
VERDICT_RANK = {"PASS": 0, "WARN": 1, "FAIL": 2}


# ---------------------------------------------------------------------------
# 基础几何/运动量
# ---------------------------------------------------------------------------
def frame_bounds(sess) -> tuple[np.ndarray, np.ndarray]:
    """每个唯一 frame_t 对应的事件下标区间 [start, end)。"""
    starts = np.searchsorted(sess.t, sess.frame_times, side="left").astype(np.int64)
    ends = np.empty_like(starts)
    ends[:-1] = starts[1:]
    ends[-1] = len(sess.t)
    return starts, ends


def frame_centroids(sess, starts=None, ends=None) -> tuple[np.ndarray, np.ndarray]:
    """逐帧事件质心（活跃/非活跃都算，索引与 sess.frame_times 对齐）。"""
    if starts is None or ends is None:
        starts, ends = frame_bounds(sess)
    counts = np.maximum(ends - starts, 1).astype(np.float64)
    sx = np.add.reduceat(sess.x.astype(np.float64), starts)
    sy = np.add.reduceat(sess.y.astype(np.float64), starts)
    # reduceat 在最后一个 start 之后会一直加到末尾；因 ends[-1]=len(t) 且 starts 严格递增，
    # 每个 start 的累加区间正好是 [starts[i], starts[i+1])，最后一个到 len(t)。
    return sx / counts, sy / counts


def detrend(t: np.ndarray, v: np.ndarray) -> np.ndarray:
    """对 (t, v) 做一次线性去趋势；t 方差为 0 时只减均值。"""
    t = np.asarray(t, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    if len(v) == 0:
        return v.copy()
    if len(v) < 2 or float(np.ptp(t)) <= 1e-12:
        return v - float(v.mean())
    coef = np.polyfit(t, v, 1)
    return v - np.polyval(coef, t)


def count_zero_crossings(signal: np.ndarray) -> int:
    """符号变化次数（与标定探针完全一致：np.sign，0 也参与比较）。"""
    sg = np.sign(np.asarray(signal, dtype=np.float64))
    if len(sg) < 2:
        return 0
    return int(np.sum(sg[1:] != sg[:-1]))


def _motion_from_centroids(times_ms: np.ndarray, cx: np.ndarray, cy: np.ndarray) -> dict:
    """返回 swing_x/swing_y（去趋势 ptp）、cycles。"""
    n = len(cx)
    if n < 2:
        return {"swing_x_px": 0.0, "swing_y_px": 0.0, "cycles": 0.0,
                "crossings": 0, "active_duration_ms": 0.0}
    t = (np.asarray(times_ms, dtype=np.float64) - float(times_ms[0])) / 1000.0
    dx = detrend(t, cx)
    dy = detrend(t, cy)
    sm = np.convolve(dx, np.ones(3, dtype=np.float64) / 3.0, mode="same")
    crossings = count_zero_crossings(sm)
    dur_ms = float(times_ms[-1] - times_ms[0])
    return {"swing_x_px": float(np.ptp(dx)), "swing_y_px": float(np.ptp(dy)),
            "cycles": float(crossings) / 2.0, "crossings": int(crossings),
            "active_duration_ms": dur_ms}


def motion_features(times_ms: np.ndarray, cx: np.ndarray, cy: np.ndarray) -> dict:
    """公开的**单一口径**运动特征：swing_x/swing_y（去趋势 ptp）、cycles、crossings、
    horizontality、active_duration_ms、cycle_hz。

    QC 的整段口径与 v4 的逐窗口径都调用本函数，区别只在传入的序列：
      - QC（motion_metrics）：整段会话**活跃帧**（frame_counts >= active_frame_events）的质心；
      - 逐窗（window_scalars）：窗内**全部帧**的质心。
    两套口径数值不可混用（同一会话整段 horizontality 可能 0.455、逐窗中位 0.747），
    报告里引用时必须注明口径。公式只此一份，禁止别处重写。
    """
    out = _motion_from_centroids(times_ms, cx, cy)
    sx, sy = out["swing_x_px"], out["swing_y_px"]
    out["horizontality"] = float(sx / max(sx + sy, 1e-9))
    dur_s = max(out["active_duration_ms"] / 1000.0, 1e-9)
    out["cycle_hz"] = float(out["cycles"] / dur_s)
    return out


def motion_metrics(sess, thresholds: dict | None = None) -> dict:
    """活跃帧质心的运动指标；活跃帧 = frame_counts >= active_frame_events。"""
    th = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        th.update(thresholds)
    thresh = float(th["active_frame_events"])
    fc = np.asarray(sess.frame_counts, dtype=np.float64)
    active = fc >= thresh
    if not np.any(active):
        return {"swing_x_px": 0.0, "swing_y_px": 0.0, "cycles": 0.0,
                "crossings": 0, "active_duration_ms": 0.0,
                "horizontality": 0.0, "cycle_hz": 0.0}
    starts, ends = frame_bounds(sess)
    cx, cy = frame_centroids(sess, starts, ends)
    times = np.asarray(sess.frame_times, dtype=np.float64)[active]
    return motion_features(times, cx[active], cy[active])


# ---------------------------------------------------------------------------
# 会话级 QC
# ---------------------------------------------------------------------------
def _fmt(v: float, nd: int = 1) -> str:
    return f"{v:,.{nd}f}"


def _status(value: float, *, low: float | None = None, high: float | None = None,
            near_frac: float = 0.05) -> tuple[str, bool]:
    """返回 (status, is_warn)；FAIL 由调用方判，本函数只判 PASS/WARN。"""
    if low is not None and value < low:
        return "FAIL", False
    if high is not None and value > high:
        return "FAIL", False
    near = False
    if low is not None and low > 0:
        near = near or (value - low) <= low * near_frac
    if high is not None and high > 0:
        near = near or (high - value) <= high * near_frac
    return ("WARN" if near else "PASS"), bool(near)


def compute_session_metrics(sess, thresholds: dict | None = None) -> dict:
    th = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        th.update(thresholds)
    fc = np.asarray(sess.frame_counts, dtype=np.float64)
    n_frames = int(len(fc))
    n_events = int(len(sess.t))
    duration_ms = int(sess.frame_times[-1] - sess.frame_times[0]) if n_frames else 0
    active = fc >= float(th["active_frame_events"])
    n_active = int(np.sum(active))
    active_duration_ms = int(sess.frame_times[active][-1] - sess.frame_times[active][0]) if n_active else 0
    active_ratio = float(n_active / n_frames) if n_frames else 0.0
    density_p50 = float(np.median(fc)) if n_frames else 0.0
    density_q25 = float(np.percentile(fc, 25)) if n_frames else 0.0
    density_q75 = float(np.percentile(fc, 75)) if n_frames else 0.0
    density_iqr = density_q75 - density_q25
    density_mean_active = float(fc[active].mean()) if n_active else 0.0
    motion = motion_metrics(sess, th)
    swing = float(motion["swing_x_px"])
    cycles = float(motion["cycles"])
    horiz = float(motion["horizontality"])

    checks: list[dict] = []
    reasons: list[str] = []

    # 1) 密度：门限用全部帧 p50；原因里带活跃帧均值（诊断值，不参与门限）
    if density_p50 > float(th["density_max"]):
        density_status = "FAIL"
        reasons.append(
            f"每帧事件数中位 {_fmt(density_p50)} ev/frame > 上限 {_fmt(float(th['density_max']), 0)}"
            f"（活跃帧均值 {int(density_mean_active):,} ev/frame；活跃帧 {n_active}/{n_frames}）")
    elif density_p50 < float(th["density_min"]):
        density_status = "FAIL"
        reasons.append(
            f"每帧事件数中位 {_fmt(density_p50)} ev/frame < 下限 {_fmt(float(th['density_min']), 0)}"
            f"（活跃帧均值 {int(density_mean_active):,} ev/frame）")
    else:
        density_status, warn = _status(float(density_p50),
                                       low=float(th["density_min"]),
                                       high=float(th["density_max"]))
        if warn:
            reasons.append(f"密度接近门限：每帧事件数中位 {_fmt(density_p50)} ev/frame")
    checks.append({"name": "density_p50", "value": round(density_p50, 4),
                   "status": density_status, "min": float(th["density_min"]),
                   "max": float(th["density_max"])})

    # 2) 活跃段时长
    if active_duration_ms < float(th["active_duration_ms"]):
        status = "FAIL"
        reasons.append(f"活跃段 {active_duration_ms / 1000.0:.2f}s < 下限 "
                       f"{float(th['active_duration_ms']) / 1000.0:.2f}s")
    else:
        status, warn = _status(float(active_duration_ms),
                               low=float(th["active_duration_ms"]))
        if warn:
            reasons.append(f"活跃段接近门限：{active_duration_ms / 1000.0:.2f}s")
    checks.append({"name": "active_duration_ms", "value": active_duration_ms,
                   "status": status, "min": float(th["active_duration_ms"])})

    # 3) 横向摆幅
    if swing < float(th["swing_px"]):
        status = "FAIL"
        reasons.append(f"横向摆幅(去趋势质心) {swing:.1f}px < 下限 {float(th['swing_px']):.0f}px")
    else:
        status, warn = _status(swing, low=float(th["swing_px"]))
        if warn:
            reasons.append(f"横向摆幅接近门限：{swing:.1f}px")
    checks.append({"name": "swing_px", "value": round(swing, 4),
                   "status": status, "min": float(th["swing_px"])})

    # 4) 完整周期数
    if cycles < float(th["cycles"]):
        status = "FAIL"
        reasons.append(f"完整摆动周期 {cycles:.1f} < 下限 {float(th['cycles']):.0f}"
                       f"（符号变化 {motion['crossings']} 次）")
    else:
        status = "PASS"
    checks.append({"name": "cycles", "value": round(cycles, 4),
                   "status": status, "min": float(th["cycles"])})

    # 5) 活跃帧占比
    if active_ratio < float(th["active_ratio"]):
        status = "FAIL"
        reasons.append(f"活跃帧占比 {active_ratio:.3f} < 下限 {float(th['active_ratio']):.2f}")
    else:
        status, warn = _status(active_ratio, low=float(th["active_ratio"]))
        if warn:
            reasons.append(f"活跃帧占比接近门限：{active_ratio:.3f}")
    checks.append({"name": "active_ratio", "value": round(active_ratio, 6),
                   "status": status, "min": float(th["active_ratio"])})

    statuses = [c["status"] for c in checks]
    verdict = "FAIL" if "FAIL" in statuses else ("WARN" if "WARN" in statuses else "PASS")
    return {
        "session": Path(sess.path).stem if getattr(sess, "path", None) else sess.name,
        "path": os.path.abspath(sess.path) if getattr(sess, "path", None) else "",
        "n_frames": n_frames,
        "n_events": n_events,
        "duration_ms": duration_ms,
        "active_frames": n_active,
        "active_duration_ms": active_duration_ms,
        "active_ratio": round(active_ratio, 6),
        "density_p50": round(density_p50, 4),
        "density_q25": round(density_q25, 4),
        "density_q75": round(density_q75, 4),
        "density_iqr": round(density_iqr, 4),
        "density_mean_active": round(density_mean_active, 4),
        "swing_px": round(swing, 4),
        "swing_y_px": round(float(motion["swing_y_px"]), 4),
        "cycles": round(cycles, 4),
        "cycle_hz": round(float(motion["cycle_hz"]), 4),
        "horizontality": round(horiz, 6),
        "verdict": verdict,
        "reasons": reasons,
        "checks": checks,
    }


def evaluate_session(path: str | os.PathLike, thresholds: dict | None = None) -> dict:
    sess = E.load_session(str(path), action=0, theta=0, delta=0, file_idx=0)
    return compute_session_metrics(sess, thresholds)


def evaluate_paths(paths: list[str | os.PathLike], thresholds: dict | None = None) -> dict:
    th = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        th.update(thresholds)
    reports = [evaluate_session(p, th) for p in paths]
    counts = {"PASS": 0, "WARN": 0, "FAIL": 0}
    for r in reports:
        counts[r["verdict"]] += 1
    return {
        "thresholds": {k: float(th[k]) for k in THRESHOLD_KEYS},
        "n_sessions": len(reports),
        "counts": counts,
        "sessions": reports,
    }


# ---------------------------------------------------------------------------
# 每窗标量（供 v4 / 融合训练复用，定义与 QC 报告一致）
# ---------------------------------------------------------------------------
def window_scalars(sess, t0: int, t1: int, thresholds: dict | None = None) -> dict:
    """窗内标量：swing_x/s、horizontality、density_p50、active_frames、swing_px。

    s = max(p95-p05 x, p95-p05 y)（窗内事件，clamp >=1）；
    swing_x/y = 窗内逐帧质心线性去趋势后的 ptp（与 QC 同算法）。
    """
    th = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        th.update(thresholds)
    t0 = int(t0)
    t1 = int(t1)
    fa = int(np.searchsorted(sess.frame_times, t0, side="left"))
    fb = int(np.searchsorted(sess.frame_times, t1, side="left"))
    fc = np.asarray(sess.frame_counts, dtype=np.float64)[fa:fb]
    density_p50 = float(np.median(fc)) if len(fc) else 0.0
    active_frames = int(np.sum(fc >= float(th["active_frame_events"])))

    a = int(np.searchsorted(sess.t, t0, side="left"))
    b = int(np.searchsorted(sess.t, t1, side="left"))
    if b <= a:
        return {"swing_x_over_s": 0.0, "horizontality": 0.0, "swing_px": 0.0,
                "density_p50": round(density_p50, 4), "active_frames": active_frames}
    xs = sess.x[a:b].astype(np.float64)
    ys = sess.y[a:b].astype(np.float64)
    s = max(float(np.percentile(xs, 95) - np.percentile(xs, 5)),
            float(np.percentile(ys, 95) - np.percentile(ys, 5)), 1.0)
    swing_x = swing_y = 0.0
    if fb - fa >= 2:
        # 窗内逐帧事件下标（相对 a:b）
        f0 = int(np.searchsorted(sess.t, sess.frame_times[fa], side="left"))
        f1 = int(np.searchsorted(sess.t, sess.frame_times[fb], side="left"))
        starts = np.searchsorted(sess.t, sess.frame_times[fa:fb], side="left") - f0
        ends = np.empty_like(starts)
        ends[:-1] = starts[1:]
        ends[-1] = f1 - f0
        counts = np.maximum(ends - starts, 1).astype(np.float64)
        cx = np.add.reduceat(sess.x[f0:f1].astype(np.float64), starts) / counts
        cy = np.add.reduceat(sess.y[f0:f1].astype(np.float64), starts) / counts
        m = motion_features(sess.frame_times[fa:fb], cx, cy)
        swing_x, swing_y = float(m["swing_x_px"]), float(m["swing_y_px"])
    horiz = float(swing_x / max(swing_x + swing_y, 1e-9))
    return {"swing_x_over_s": round(swing_x / s, 6),
            "horizontality": round(horiz, 6),
            "swing_px": round(swing_x, 4),
            "density_p50": round(density_p50, 4),
            "active_frames": active_frames}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def discover_csvs(inputs: list[str]) -> list[str]:
    found: dict[str, str] = {}
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            for q in p.rglob("*.csv"):
                found[os.path.normcase(str(q.resolve()))] = str(q.resolve())
        elif p.is_file() and p.suffix.lower() == ".csv":
            found[os.path.normcase(str(p.resolve()))] = str(p.resolve())
        else:
            raise FileNotFoundError(f"不是 CSV 或目录：{raw}")
    return [found[k] for k in sorted(found)]


def parse_overrides(items: list[str] | None) -> dict:
    out: dict[str, float] = {}
    for raw in items or []:
        if "=" not in raw:
            raise ValueError(f"--set 需要 key=value：{raw}")
        k, v = raw.split("=", 1)
        k = k.strip()
        if k not in DEFAULT_THRESHOLDS:
            raise ValueError(f"未知阈值 {k}；可用：{', '.join(THRESHOLD_KEYS)}")
        out[k] = float(v)
    return out


def _print_report(r: dict) -> None:
    print(f"[QC] {r['session']} {r['verdict']} "
          f"frames={r['n_frames']} active={r['active_frames']} "
          f"dur={r['duration_ms'] / 1000.0:.2f}s active_dur={r['active_duration_ms'] / 1000.0:.2f}s "
          f"density_p50={r['density_p50']:.1f} density_iqr={r['density_iqr']:.1f} "
          f"active_mean={r['density_mean_active']:.1f} "
          f"swing={r['swing_px']:.1f}px cycles={r['cycles']:.1f} "
          f"ratio={r['active_ratio']:.3f}")
    for reason in r["reasons"]:
        print(f"  - {reason}")


def _force_utf8_stdio() -> None:
    """把 stdout/stderr 固定为 UTF-8：Git Bash / cp936 控制台下中文 reason 不再乱码。

    落盘文件另有 encoding="utf-8"（见 --json-out），不依赖终端编码假象。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):  # 无 reconfigure 的流/已关闭
            pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(description="事件相机 CSV 的 QC 门禁（task-19）")
    ap.add_argument("inputs", nargs="+", help="CSV 文件或目录（目录递归）")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE",
                    help=f"覆盖阈值；可用：{', '.join(THRESHOLD_KEYS)}")
    ap.add_argument("--json-out", default=None, help="把汇总 JSON 另写一份到文件")
    ap.add_argument("--strict", action="store_true", help="有 FAIL 时退出码 1")
    args = ap.parse_args(argv)
    try:
        thresholds = parse_overrides(args.set)
        paths = discover_csvs(args.inputs)
    except (ValueError, FileNotFoundError) as exc:
        print(f"[qc] 参数错误：{exc}", file=sys.stderr)
        return 2
    if not paths:
        print("[qc] 没有找到 CSV", file=sys.stderr)
        return 2
    try:
        summary = evaluate_paths(paths, thresholds)
    except Exception as exc:  # noqa: BLE001 - CLI 统一转换为退出码
        print(f"[qc] 读取失败：{exc}", file=sys.stderr)
        return 2
    for r in summary["sessions"]:
        _print_report(r)
    line = json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if args.json_out:
        Path(args.json_out).write_text(line + "\n", encoding="utf-8")
    print(line)
    if args.strict and summary["counts"]["FAIL"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
