#!/usr/bin/env python3
"""UNIT2：dataset_v2 的类映射/参数组 assumption/切分自检/prev 不泄漏/非重叠窗公式。"""
import os
import sys
import types
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import build_dataset_v2 as B  # noqa: E402

NPZ = os.path.join(HERE, "dataset_v2_w100.npz")
HOLDOUT = B.HOLDOUT_SESSIONS[0]


def fake_spec(name, action=2, cls=1, source="camera", split="train", mode="session"):
    sess = types.SimpleNamespace(name=name, action=action, group="theta3_delta18")
    return B.SessionSpec(sess, cls=cls, source=source, group_assumed=True,
                         split=split, split_mode=mode)


class ClassMappingTest(unittest.TestCase):
    def test_class_for_dir(self):
        self.assertEqual(B.class_for_dir("动作一 手部开合"), (1, "camera"))
        self.assertEqual(B.class_for_dir("动作二 握拳"), (1, "camera"))
        self.assertEqual(B.class_for_dir("动作三 横向移动手掌"), (2, "camera"))
        self.assertEqual(B.class_for_dir("板子在现实中发生位移时的环境事件数据"), (0, "board_move"))
        with self.assertRaises(ValueError):
            B.class_for_dir("未知目录")

    def test_action_remap_merges_action2_into_class1(self):
        sp = fake_spec("动作二会话", action=2, cls=1)
        self.assertEqual(sp.session.action, 1)
        sp2 = fake_spec("横挥", action=2, cls=2)
        self.assertEqual(sp2.session.action, 2)
        sp0 = fake_spec("噪声", action=0, cls=0, source="board_move", mode="single_session")
        self.assertEqual(sp0.session.action, 0)

    def test_group_assumption_default(self):
        th, dl, assumed = B.infer_group(r"E:\data\动作一\参数搭配三 事件补录\x.csv")
        self.assertEqual((th, dl, assumed), (3, 18, True))
        th, dl, assumed = B.infer_group(r"E:\data\动作三 横向移动手掌\x.csv")
        self.assertEqual((th, dl, assumed), (3, 18, True))


class SplitTest(unittest.TestCase):
    def test_non_overlap_formula(self):
        self.assertEqual(B.non_overlap_count(96, 50, 100), 48)
        self.assertEqual(B.non_overlap_count(58, 50, 100), 29)
        self.assertEqual(B.non_overlap_count(0, 50, 100), 0)
        self.assertEqual(B.non_overlap_count(95, 50, 100), 48)

    def test_assign_split_holdout_and_single_session(self):
        specs = [fake_spec("a"), fake_spec(HOLDOUT), fake_spec("w", cls=2, mode="single_session")]
        B.assign_split(specs)
        by = {sp.session.name: sp for sp in specs}
        self.assertEqual((by[HOLDOUT].split, by[HOLDOUT].split_mode), ("test", "session"))
        self.assertEqual((by["a"].split, by["a"].split_mode), ("train", "session"))
        self.assertEqual((by["w"].split, by["w"].split_mode), ("train", "single_session"))

    def test_session_split_check(self):
        meta = {
            "session": np.array(["a", "a", "b", "b"]),
            "split": np.array(["test", "test", "train", "train"]),
            "split_mode": np.array(["session"] * 4),
        }
        ok, problems, *_ = B.session_split_check(meta)
        self.assertTrue(ok)
        self.assertEqual(problems, [])
        meta_bad = dict(meta)
        meta_bad["split"] = np.array(["test", "train", "train", "train"])
        ok, problems, *_ = B.session_split_check(meta_bad)
        self.assertFalse(ok)
        self.assertIn("a", problems[0])


@unittest.skipUnless(os.path.exists(NPZ), "dataset_v2_w100.npz 未生成，先跑 build_dataset_v2.py")
class DatasetIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with np.load(NPZ, allow_pickle=False) as z:
            cls.z = {k: z[k] for k in z.files}

    def test_required_keys_and_shape(self):
        need = {"X_counts", "X_q", "y", "file", "session", "group", "action", "file_idx",
                "seg_id", "seg_start_frame", "seg_end_frame", "t_ms", "win_ms", "stride_ms",
                "split_reason", "source", "split", "split_mode", "group_assumption", "cls"}
        self.assertTrue(need.issubset(set(self.z)))
        self.assertEqual(self.z["X_counts"].shape[1:], (4, 30, 50))
        self.assertTrue(set(np.unique(self.z["y"]).tolist()).issubset({0, 1, 2}))

    def test_class1_merged_16_sessions_and_class2_single(self):
        y = self.z["y"]
        sess = self.z["session"]
        s1 = set(sess[y == 1].tolist())
        s2 = set(sess[y == 2].tolist())
        self.assertEqual(len(s1), 16, f"class1 应合并动作一+动作二+补录：{s1}")
        self.assertIn("retina-events-20261029-192251", s1)  # 动作二文件必须归 class1
        self.assertIn("retina-events-20261029-204439", s1)  # 补录也归 class1
        self.assertEqual(s2, {"retina-events-20261029-210102"})
        self.assertTrue((self.z["cls"][y == 1] == 1).all())
        self.assertTrue((self.z["cls"][y == 2] == 2).all())

    def test_board_move_source_and_label(self):
        src = self.z["source"]
        y = self.z["y"]
        board = src == "board_move"
        self.assertGreater(int(board.sum()), 0)
        self.assertTrue((y[board] == 0).all(), "板移噪声必须是 class0")
        self.assertEqual(set(self.z["session"][board].tolist()),
                         {"retina-events-20261029-210307"})

    def test_group_assumption_marks_new_dirs(self):
        sess = self.z["session"]
        ga = self.z["group_assumption"]
        for name in ("retina-events-20261029-204439", "retina-events-20261029-204054",
                     "retina-events-20261029-210102", "retina-events-20261029-210307"):
            mask = sess == name
            self.assertTrue((ga[mask] == 1).all(), f"{name} 应标注 assumption")
            self.assertEqual(set(self.z["group"][mask].tolist()), {"theta3_delta18"})
        old = sess == "retina-events-20261029-190957"
        self.assertTrue((ga[old] == 0).all())

    def test_prev_channels_do_not_leak_across_files(self):
        X = self.z["X_counts"].astype(np.int64)
        sess = self.z["session"]
        first = {}
        for i, name in enumerate(sess.tolist()):
            first.setdefault(name, i)
        for name, i in first.items():
            prev_sum = int(X[i, 2:, :, :].sum())
            self.assertEqual(prev_sum, 0, f"会话 {name} 首窗 prev 通道应为 0，实际 {prev_sum}")

    def test_session_split_has_no_overlap(self):
        ok, problems, session, split, mode = B.session_split_check(self.z)
        self.assertTrue(ok, problems)
        # 时间/单会话类（class2/板移）整条在 train，评估由 probe 另行时间后半段留出
        self.assertEqual(set(self.z["split"].tolist()), {"train", "test"})

    def test_each_split_is_whole_session(self):
        sess = self.z["session"]
        split = self.z["split"]
        for name in set(sess.tolist()):
            vals = set(split[sess == name].tolist())
            self.assertEqual(len(vals), 1, f"{name} 跨 train/test：{vals}")


V3_NPZ = os.path.join(HERE, "dataset_v3_w100.npz")


@unittest.skipUnless(os.path.exists(V3_NPZ), "dataset_v3_w100.npz 未生成，先跑 build_dataset_v3.py")
class DatasetV3Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import build_dataset_v3 as B3  # noqa: E402
        cls.B3 = B3
        with np.load(V3_NPZ, allow_pickle=False) as z:
            cls.z = {k: z[k] for k in z.files}

    def test_v3_fields_isomorphic_to_v2(self):
        v2 = os.path.join(HERE, "dataset_v2_w100.npz")
        if os.path.exists(v2):
            with np.load(v2, allow_pickle=False) as z2:
                self.assertEqual(set(self.z), set(z2.files), "v3 字段必须与 v2 完全同构")
        self.assertEqual(self.z["X_counts"].shape[1:], (4, 30, 50))
        def sc(key):
            return int(np.asarray(self.z[key]).reshape(-1)[0])
        self.assertEqual(sc("grid_w"), 50)
        self.assertEqual(sc("grid_h"), 30)
        self.assertEqual(sc("grid_shift"), 3)
        self.assertEqual(sc("win_ms"), 100)
        self.assertEqual(sc("stride_ms"), 50)

    def test_class2_three_sessions_and_at_least_110_windows(self):
        y = self.z["y"]
        sess = self.z["session"]
        s2 = set(sess[y == 2].tolist())
        self.assertEqual(s2, set(self.B3.V3_CLASS2_SESSIONS))
        self.assertEqual(len(s2), 3)
        self.assertGreaterEqual(int((y == 2).sum()), 110)
        self.assertEqual(set(self.z["cls"][y == 2].tolist()), {2})

    def test_v3_session_split_pass(self):
        ok, problems, *_ = B.session_split_check(self.z)
        self.assertTrue(ok, problems)
        for name in set(self.z["session"].tolist()):
            vals = set(self.z["split"][self.z["session"] == name].tolist())
            self.assertEqual(len(vals), 1, f"{name} 跨 train/test：{vals}")

    def test_v3_new_wave_sessions_group_assumption(self):
        sess, ga, group = self.z["session"], self.z["group_assumption"], self.z["group"]
        for name in ("retina-events-20261029-211950", "retina-events-20261029-212036"):
            mask = sess == name
            self.assertGreater(int(mask.sum()), 0, f"{name} 无窗口")
            self.assertTrue((ga[mask] == 1).all())
            self.assertEqual(set(group[mask].tolist()), {"theta3_delta18"})

    def test_v3_all_three_windows_files(self):
        for win in (150, 200):
            p = os.path.join(HERE, f"dataset_v3_w{win}.npz")
            self.assertTrue(os.path.exists(p), p)
            with np.load(p, allow_pickle=False) as z:
                self.assertEqual(z["X_counts"].shape[1:], (4, 30, 50))
                self.assertEqual(len(z["y"]), len(z["session"]))


if __name__ == "__main__":
    prog = unittest.main(exit=False, verbosity=2)
    print(f"UNIT2_OK={1 if prog.result.wasSuccessful() else 0} tests_run={prog.result.testsRun}")
    raise SystemExit(0 if prog.result.wasSuccessful() else 1)
