#!/usr/bin/env python3
"""nn/qc_clip.py 的单测（task-19 QC_OK 的一部分）。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import extract_events as E  # noqa: E402
import qc_clip  # noqa: E402

ROOT = Path(r"E:\workspace\FPGA_Comp\row_datas\原始采集数据")
KNOWN = {
    "211950": ROOT / "动作三 横向移动手掌" / "retina-events-20261029-211950.csv",
    "212036": ROOT / "动作三 横向移动手掌" / "retina-events-20261029-212036.csv",
    "204439": ROOT / "动作一 从握拳到张开手掌（手心朝向摄像头）" / "参数搭配三 事件补录" / "retina-events-20261029-204439.csv",
}


def synth_session(name: str = "synth", n_frames: int = 80, per_frame: int = 1500,
                  amp: float = 80.0, cycles: int = 4) -> E.Session:
    """确定性合成会话：每帧 per_frame 个事件，质心 x 做 cycles 个周期的正弦。"""
    t, x, y, pol, fidx = [], [], [], [], []
    for i in range(n_frames):
        tt = i * 40
        cx = 200.0 + amp * np.sin(2.0 * np.pi * cycles * i / n_frames)
        cy = 120.0 + 10.0 * np.cos(2.0 * np.pi * i / n_frames)
        off = np.linspace(-25.0, 25.0, per_frame)
        off2 = np.linspace(-20.0, 20.0, per_frame)
        xs = np.clip(np.rint(cx + off), 0, 399).astype(np.int32)
        ys = np.clip(np.rint(cy + off2), 0, 239).astype(np.int32)
        ps = (np.arange(per_frame) % 2).astype(np.int8)
        t.extend([tt] * per_frame)
        x.extend(xs.tolist())
        y.extend(ys.tolist())
        pol.extend(ps.tolist())
        fidx.extend([i] * per_frame)
    return E.make_session(name, f"{name}.csv", 1, 3, 18, 0,
                          np.asarray(fidx, np.int64), np.asarray(t, np.int64),
                          np.asarray(x, np.int32), np.asarray(y, np.int32),
                          np.asarray(pol, np.int8))


def write_csv(path: Path, n_frames: int = 2, per_frame: int = 5) -> None:
    lines = ["frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts"]
    for i in range(n_frames):
        for j in range(per_frame):
            lines.append(f"{i},{i * 40},{100 + j},{100 + j},{j % 2},"
                         f"{'ON' if j % 2 else 'OFF'},0,{i * 40}")
    path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")


class QcMetricsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pass_sess = synth_session("synth_pass")
        cls.dense_sess = synth_session("synth_dense", per_frame=2500)
        cls.lowswing_sess = synth_session("synth_lowswing", amp=10.0)

    def test_synthetic_pass(self):
        m = qc_clip.compute_session_metrics(self.pass_sess)
        self.assertEqual(m["verdict"], "PASS", m["reasons"])
        self.assertEqual(m["n_frames"], 80)
        self.assertEqual(m["active_frames"], 80)
        self.assertAlmostEqual(m["density_p50"], 1500.0)
        self.assertGreaterEqual(m["swing_px"], 120.0)
        self.assertGreaterEqual(m["cycles"], 3.0)

    def test_density_fail_and_reason_has_active_mean(self):
        m = qc_clip.compute_session_metrics(self.dense_sess)
        self.assertEqual(m["verdict"], "FAIL")
        text = " ".join(m["reasons"])
        self.assertIn("2,500.0", text)
        self.assertIn("> 上限 2,000", text)
        self.assertIn("2,500", text)  # 活跃帧均值整数
        self.assertEqual([c["status"] for c in m["checks"] if c["name"] == "density_p50"], ["FAIL"])

    def test_override_can_relax_density(self):
        m = qc_clip.compute_session_metrics(self.dense_sess, {"density_max": 3000.0})
        self.assertEqual(m["verdict"], "PASS", m["reasons"])

    def test_low_swing_fail(self):
        m = qc_clip.compute_session_metrics(self.lowswing_sess)
        self.assertEqual(m["verdict"], "FAIL")
        text = " ".join(m["reasons"])
        self.assertIn("横向摆幅", text)
        self.assertIn("< 下限 120px", text)

    def test_zero_crossings(self):
        self.assertEqual(qc_clip.count_zero_crossings(np.array([1, 1, -1, -1, 1, 1])), 2)
        self.assertEqual(qc_clip.count_zero_crossings(np.array([1.0, 2.0, 3.0])), 0)
        self.assertEqual(qc_clip.count_zero_crossings(np.array([])), 0)

    def test_window_scalars(self):
        w = qc_clip.window_scalars(self.pass_sess, 0, 100)
        self.assertEqual(w["density_p50"], 1500.0)
        self.assertEqual(w["active_frames"], 3)  # 0/40/80 ms 三帧
        self.assertGreater(w["swing_x_over_s"], 0.0)
        self.assertGreaterEqual(w["horizontality"], 0.0)
        self.assertLessEqual(w["horizontality"], 1.0)

    def test_json_stable(self):
        a = json.dumps(qc_clip.compute_session_metrics(self.pass_sess), ensure_ascii=False, sort_keys=True)
        b = json.dumps(qc_clip.compute_session_metrics(self.pass_sess), ensure_ascii=False, sort_keys=True)
        self.assertEqual(a, b)

    def test_parse_overrides(self):
        self.assertEqual(qc_clip.parse_overrides(["density_max=2500"]), {"density_max": 2500.0})
        with self.assertRaises(ValueError):
            qc_clip.parse_overrides(["nope=1"])
        with self.assertRaises(ValueError):
            qc_clip.parse_overrides(["density_max"])


class PathTest(unittest.TestCase):
    def test_discover_recursive_and_dedup(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "a").mkdir()
            (root / "a" / "b").mkdir()
            f1 = root / "a" / "retina-events-x.csv"
            f2 = root / "a" / "b" / "retina-events-y.csv"
            for f in (f1, f2):
                write_csv(f)
            got = qc_clip.discover_csvs([str(root), str(f1)])
            self.assertEqual(len(got), 2)
            self.assertEqual({Path(p).name for p in got},
                             {"retina-events-x.csv", "retina-events-y.csv"})

    def test_evaluate_temp_csv_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "retina-events-t.csv"
            write_csv(p, n_frames=3, per_frame=5)
            a = qc_clip.evaluate_session(p)
            b = qc_clip.evaluate_session(p)
            self.assertEqual(json.dumps(a, ensure_ascii=False, sort_keys=True),
                             json.dumps(b, ensure_ascii=False, sort_keys=True))
            self.assertEqual(a["verdict"], "FAIL")
            self.assertIn("每帧事件数中位", " ".join(a["reasons"]))

    def test_cli_two_runs_byte_identical(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "retina-events-t.csv"
            write_csv(p, n_frames=3, per_frame=5)
            cmd = [sys.executable, str(HERE / "qc_clip.py"), str(p)]
            outs = []
            for _ in range(2):
                r = subprocess.run(cmd, cwd=str(HERE), capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr)
                outs.append(r.stdout)
            self.assertEqual(outs[0], outs[1])
            last = outs[0].strip().splitlines()[-1]
            summary = json.loads(last)
            self.assertEqual(summary["n_sessions"], 1)
            self.assertEqual(summary["sessions"][0]["verdict"], "FAIL")


@unittest.skipUnless(all(p.exists() for p in KNOWN.values()), "真实采集 CSV 不存在")
class KnownClipTest(unittest.TestCase):
    def test_known_verdicts(self):
        r = qc_clip.evaluate_paths(list(KNOWN.values()))
        by = {s["session"][-6:]: s for s in r["sessions"]}
        self.assertEqual(by["211950"]["verdict"], "FAIL")
        self.assertEqual(by["212036"]["verdict"], "FAIL")
        self.assertEqual(by["204439"]["verdict"], "PASS")
        self.assertIn("3,148", " ".join(by["211950"]["reasons"]))
        self.assertIn("2,749", " ".join(by["212036"]["reasons"]))
        self.assertIn("> 上限 2,000", " ".join(by["211950"]["reasons"]))
        self.assertIn("> 上限 2,000", " ".join(by["212036"]["reasons"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
