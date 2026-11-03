#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_extract.py -- extract_events.py 的单元测试（标准库 unittest，不依赖真实 CSV）。

运行：
    cd nn && python test_extract.py          # 直接运行，末行打印 UNIT_OK=1
    cd nn && python -m unittest -v test_extract.py
"""

import os
import sys
import unittest
from datetime import datetime

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_events as ex  # noqa: E402


def synth_session(counts, dt=100, action=1, theta=1, delta=20,
                  name="synthetic", file_idx=0, offset=0):
    """造合成会话：保留完整帧时间轴（含 0 事件的帧），事件全落 (0,0) 格。"""
    counts = [int(c) for c in counts]
    n = len(counts)
    t, fids = [], []
    for i, c in enumerate(counts):
        for _ in range(c):
            t.append(offset + i * dt)
            fids.append(i)
    t = np.asarray(t, np.int64)
    fids = np.asarray(fids, np.int64)
    x = np.zeros(len(t), np.int32)
    y = np.zeros(len(t), np.int32)
    pol = np.ones(len(t), np.int8)
    ft = np.arange(n, dtype=np.int64) * dt + offset
    return ex.Session(
        name=name, path=name + ".csv", action=action, theta=theta,
        delta=delta, file_idx=file_idx,
        t=t, x=x, y=y, pol=pol, cell_id=ex.cell_ids(x, y),
        frame_times=ft, frame_counts=np.asarray(counts, np.int64),
        frame_ids=np.arange(n, dtype=np.int64))


def synth_events(events, frame_times, action=1, theta=1, delta=20,
                 name="synthetic", file_idx=0):
    """events: [(t,x,y,pol)]，frame_times 为显式帧时间轴（可为空帧）。"""
    events = sorted(events, key=lambda e: e[0])
    t = np.asarray([e[0] for e in events], np.int64)
    x = np.asarray([e[1] for e in events], np.int32)
    y = np.asarray([e[2] for e in events], np.int32)
    pol = np.asarray([e[3] for e in events], np.int8)
    ft = np.asarray(frame_times, np.int64)
    fids = np.searchsorted(ft, t, side="right") - 1
    fids = np.clip(fids, 0, len(ft) - 1)
    return ex.Session(
        name=name, path=name + ".csv", action=action, theta=theta,
        delta=delta, file_idx=file_idx,
        t=t, x=x, y=y, pol=pol, cell_id=ex.cell_ids(x, y),
        frame_times=ft, frame_counts=np.bincount(fids, minlength=len(ft)),
        frame_ids=np.arange(len(ft), dtype=np.int64))


class TestParsing(unittest.TestCase):
    def test_parse_tolerates_bad_rows(self):
        lines = [
            "frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts",
            "1,1000,10,20,1,ON,0,0",
            "2,1000,11,21,0,OFF,0,0",
            "this,is,not,a,valid,row",
            "3,1001,1,2,2,XX,0,0",          # 非法极性
            "4,1001,3,4,1,ON,0,0",
            "5,1002,abc,4,1,ON,0,0",        # 非整数
            "",
        ]
        t, x, y, pol, bad = ex.parse_event_lines(lines, skip_header=True)
        self.assertEqual(bad, 3)
        np.testing.assert_array_equal(t, [1000, 1000, 1001])
        np.testing.assert_array_equal(x, [10, 11, 3])
        np.testing.assert_array_equal(pol, [1, 0, 1])
        self.assertEqual(t.dtype, np.int64)
        self.assertEqual(y.dtype, np.int32)

    def test_parse_empty_ok(self):
        t, x, y, pol, bad = ex.parse_event_lines(
            ["frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts"], skip_header=True)
        self.assertEqual(len(t), 0)
        self.assertEqual(bad, 0)


class TestCellMapping(unittest.TestCase):
    def test_cell_mapping_boundaries(self):
        cid = ex.cell_ids(np.array([0, 7, 8, 399, 400, -1]),
                          np.array([0, 7, 8, 239, 240, -1]))
        self.assertEqual(cid[0], 0)                    # (0,0)
        self.assertEqual(cid[1], 0)                    # 7>>3=0
        self.assertEqual(cid[2], 1 * ex.GRID_W + 1)    # 8>>3=1
        self.assertEqual(cid[3], 29 * ex.GRID_W + 49)  # 边界内最大格
        self.assertEqual(cid[4], -1)                   # x=400 越界
        self.assertEqual(cid[5], -1)                   # 负数越界


class TestWindows(unittest.TestCase):
    def test_polarity_and_prev_channels(self):
        sess = synth_events(
            [(0, 8, 8, 1), (50, 16, 16, 0), (110, 8, 8, 1), (200, 8, 8, 1)],
            frame_times=[0, 100, 200])
        d = ex.build_session_windows(sess, 100, stride_ms=100)
        self.assertEqual(len(d["y"]), 2)
        # 窗口 0 [0,100)：ON(1,1)=1, OFF(2,2)=1，prev 全 0
        self.assertEqual(int(d["X"][0, 0, 1, 1]), 1)
        self.assertEqual(int(d["X"][0, 1, 2, 2]), 1)
        self.assertEqual(int(d["X"][0, 2:].sum()), 0)
        # 窗口 1 [100,200)：now 有 ON(1,1)=1；prev=[0,100) 有 ON(1,1)+OFF(2,2)
        self.assertEqual(int(d["X"][1, 0, 1, 1]), 1)
        self.assertEqual(int(d["X"][1, 2, 1, 1]), 1)
        self.assertEqual(int(d["X"][1, 3, 2, 2]), 1)
        self.assertEqual(int(d["X"][1, 0].sum() + d["X"][1, 1].sum()), 1)

    def test_window_overlap(self):
        # 75ms 处的事件，在 [0,100) 与 [50,150) 的 now 里都应出现
        sess = synth_events([(0, 0, 0, 1), (75, 0, 0, 1), (200, 0, 0, 1)],
                            frame_times=[0, 100, 200])
        d = ex.build_session_windows(sess, 100, stride_ms=50)
        self.assertEqual(len(d["y"]), 3)                # starts 0, 50, 100
        self.assertEqual(int(d["X"][0, 0].sum()), 2)    # [0,100)
        self.assertEqual(int(d["X"][1, 0].sum()), 1)    # [50,150)
        self.assertEqual(int(d["X"][2, 0].sum()), 0)    # [100,200)
        self.assertEqual(int(d["X"][1, 2].sum()), 1)    # prev=[-50,50) 含 t=0
        self.assertEqual(int(d["X"][0, 2].sum()), 0)    # prev=[-100,0) 不含 t=0

    def test_boundary_drop(self):
        self.assertEqual(len(ex.window_starts(0, 50, 100)), 0)     # 跨度不足
        starts = ex.window_starts(0, 1000, 100, 50)
        self.assertEqual(int(starts[0]), 0)
        self.assertEqual(int(starts[-1]), 900)                     # 950+100>1000 被丢弃
        self.assertTrue(all(int(s) + 100 <= 1000 for s in starts))
        # 步长默认 win/2
        self.assertEqual(ex.build_session_windows(
            synth_session([10] * 11), 100)["stride_ms"], 50)

    def test_prev_does_not_leak_across_files(self):
        s1 = synth_session([100] * 11, name="s1", file_idx=0)
        s2 = synth_session([100] * 11, name="s2", file_idx=1, offset=100000)
        ds = ex.build_dataset([s1, s2], 100)
        idx2 = int(np.where(ds["meta"]["file_idx"] == 1)[0][0])
        self.assertEqual(int(ds["X_counts"][idx2, 2:].sum()), 0)   # 首窗 prev 全 0
        self.assertEqual(int(ds["X_counts"][idx2, 0].sum()), 100)  # 首窗 now 有事件


class TestLabels(unittest.TestCase):
    def test_none_label_from_segments(self):
        segs = [ex.Segment(i0=0, i1=1, t0=0, t1=200, frame_id0=0, frame_id1=1)]
        self.assertEqual(ex.label_window(0, 100, segs, 100, 1), (1, 0))
        self.assertEqual(ex.label_window(200, 300, segs, 100, 1), (0, -1))   # 段外
        self.assertEqual(ex.label_window(150, 250, segs, 100, 1), (1, 0))    # 50% 重叠
        self.assertEqual(ex.label_window(210, 310, segs, 100, 1), (0, -1))   # 不足 50%

    def test_action_class_propagates(self):
        s2 = synth_session([100] * 11, action=2, offset=100000, name="s2")
        segs = [ex.Segment(i0=0, i1=3, t0=100000, t1=100300,
                           frame_id0=0, frame_id1=3)]
        d = ex.build_session_windows(s2, 100, segments=segs)
        self.assertTrue(set(d["y"].tolist()) <= {0, 2})
        self.assertEqual(int(d["y"].max()), 2)
        self.assertGreater(int((d["y"] == 2).sum()), 0)
        # 段外窗口仍为 none
        far = ex.Segment(i0=0, i1=1, t0=0, t1=100, frame_id0=0, frame_id1=1)
        d2 = ex.build_session_windows(s2, 100, segments=[far])
        self.assertEqual(int(d2["y"].max()), 0)


class TestSaturation(unittest.TestCase):
    def test_saturation_int8(self):
        sess = synth_session([0, 0, 0, 200] + [0] * 7)  # 200 个事件同帧同格 t=300
        ds = ex.build_dataset([sess], 100)
        self.assertEqual(int(ds["X_counts"].max()), 200)
        self.assertEqual(int(ds["X_q"].max()), ex.SAT_MAX)
        self.assertEqual(ds["X_counts"].dtype, np.uint16)
        self.assertEqual(ds["X_q"].dtype, np.int8)
        self.assertEqual(ds["y"].dtype, np.uint8)


class TestSegments(unittest.TestCase):
    def test_hysteresis_and_gap(self):
        counts = [0, 600, 700, 400, 100, 100, 100, 100, 100, 600, 700]
        sess = synth_session(counts, dt=100)
        segs = ex.detect_segments(sess, hi=500, lo=120, gap_ms=400, ext_ms=0)
        self.assertEqual(len(segs), 2)
        self.assertEqual((segs[0].i0, segs[0].i1), (1, 3))
        self.assertEqual((segs[1].i0, segs[1].i1), (9, 10))
        # 低阈值帧不会开启活动段
        self.assertEqual(ex.detect_segments(synth_session([0, 100, 100, 100]), ext_ms=0), [])

    def test_extension_clipped_to_file_range(self):
        sess = synth_session([0, 0, 900, 900, 0, 0], dt=100)  # 帧 0..500
        segs = ex.detect_segments(sess, ext_ms=200)
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].t0, 0)      # 200-200 裁到 0
        self.assertEqual(segs[0].t1, 500)    # 300+200 裁到末帧
        self.assertEqual(segs[0].frame_id0, 2)
        self.assertEqual(segs[0].frame_id1, 3)

    def test_cycle_split_conservative(self):
        # 深下凹（4 个 100ms 桶 150 事件 = 18.75% 峰值，且 150>=lo 不断段）=> 切 1 刀
        deep = [800] * 10 + [150] * 4 + [800] * 15
        sess = synth_session(deep, dt=100)
        segs = ex.annotate_cycles(sess, ex.detect_segments(sess, ext_ms=0))
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].cycles, 2, msg="cuts=" + str(segs[0].cuts_ms))
        self.assertTrue(segs[0].split_reason.startswith("envelope_dip@"))
        # 浅下凹（300/800=37.5% > 25%）=> 不切
        shallow = [800] * 10 + [300] * 4 + [800] * 15
        sess2 = synth_session(shallow, dt=100)
        segs2 = ex.annotate_cycles(sess2, ex.detect_segments(sess2, ext_ms=0))
        self.assertEqual(segs2[0].cycles, 1)
        self.assertEqual(segs2[0].split_reason, "single")
        # 短段（<2s）即使有深下凹也不切
        short = [800] * 5 + [150] * 2 + [800] * 5
        sess3 = synth_session(short, dt=100)
        segs3 = ex.annotate_cycles(sess3, ex.detect_segments(sess3, ext_ms=0))
        self.assertEqual(segs3[0].cycles, 1)


class TestParamsAndMeta(unittest.TestCase):
    def test_parse_filter_lines(self):
        lines = [
            "2026 10 29-19/09  19/42 过滤参数为阈值 1 ，最小得塔 20",
            "2026 10 29-19/16  19/45 过滤参数为阈值 1 ，最小得塔 32",
            "2026 10 29-19/16  19/47 过滤参数为阈值 3 ，最小得塔 18",
        ]
        ps = ex.parse_filter_lines(lines)
        self.assertEqual([(p["theta"], p["delta"]) for p in ps], [(1, 20), (1, 32), (3, 18)])
        self.assertEqual((ps[0]["start_min"], ps[0]["end_min"]), (19 * 60 + 9, 19 * 60 + 42))

    def test_match_group_indices_k_plus_3(self):
        starts = [datetime(2026, 10, 29, h, m, s) for (h, m, s) in [
            (19, 9, 57), (19, 16, 20), (19, 19, 5), (19, 42, 50), (19, 45, 8), (19, 47, 7)]]
        params = [
            {"date": (2026, 10, 29), "start_min": 19 * 60 + 9,
             "end_min": 19 * 60 + 42, "theta": 1, "delta": 20},
            {"date": (2026, 10, 29), "start_min": 19 * 60 + 16,
             "end_min": 19 * 60 + 45, "theta": 1, "delta": 32},
            {"date": (2026, 10, 29), "start_min": 19 * 60 + 16,
             "end_min": 19 * 60 + 47, "theta": 3, "delta": 18},
        ]
        pairs = ex.match_group_indices(starts, params)
        self.assertEqual(pairs, [(0, 3, 1, 20), (1, 4, 1, 32), (2, 5, 3, 18)])

    def test_dataset_meta_fields(self):
        ds = ex.build_dataset([synth_session([100] * 11, action=1)], 100)
        for key in ("file", "session", "group", "theta", "delta", "action",
                    "frame_ms", "seg_start_frame", "seg_end_frame", "split_reason"):
            self.assertIn(key, ds["meta"])
        self.assertEqual(ds["meta"]["group"][0], "theta1_delta20")
        self.assertEqual(int(ds["meta"]["theta"][0]), 1)
        self.assertEqual(ds["meta"]["action"].tolist(), ds["y"].tolist())
        self.assertEqual(int(ds["meta"]["win_ms"][0]), 100)


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    ok = result.wasSuccessful() and result.testsRun >= 8
    print("UNIT_OK=1" if ok else "UNIT_OK=0")
    sys.exit(0 if ok else 1)
