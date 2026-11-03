#!/usr/bin/env python3
"""M1b 数据集 v2：class1=手部开合(动作一+动作二合并)、class2=横向挥手(动作三)、
class0=无动作+板子位移噪声(硬负样本，source=board_move)。

只读复用 nn/extract_events.py 的解析/分帧/计数/标注；本文件负责：
  1. 显式会话表（含 4 个「参数搭配三」补录、动作三、板移噪声）；
  2. 类别映射与参数组 assumption 标注；
  3. 会话级 train/test 切分自检（单会话类 class2/板移全部 train，由探针另做时间后半段留出）；
  4. 产出 dataset_v2_w100/150/200.npz + 统计打印。
用法：
  python build_dataset_v2.py [--data-root ...] [--out-dir ...]
"""
import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import extract_events as E  # noqa: E402

DEFAULT_ROOT = r"E:\workspace\FPGA_Comp\row_datas\原始采集数据"
DEFAULT_GROUP = (3, 18)
GROUP_HINTS = ("参数搭配三", "事件补录", "事件数据补录")
WAVE_DIR_PREFIX = "动作三"
NOISE_DIR_KEYWORDS = ("位移", "噪声", "环境事件")
# 会话级留出：两条 (3,18) 会话（动作一 191905 / 动作二 192720），与 v1 的固定留出方案一致
HOLDOUT_SESSIONS = (
    "retina-events-20261029-191905",
    "retina-events-20261029-192720",
)
CLASS_NAMES = {0: "class0_none_or_board_move", 1: "class1_hand_open_close", 2: "class2_wave"}


def find_dir(root, prefixes):
    for entry in sorted(os.listdir(root)):
        full = os.path.join(root, entry)
        if not os.path.isdir(full):
            continue
        if any(entry.startswith(p) for p in prefixes):
            return full
    return None


def list_event_csvs(d):
    return sorted(os.path.join(d, f) for f in os.listdir(d)
                  if f.startswith("retina-events-") and f.endswith(".csv"))


def class_for_dir(dir_name):
    """目录名 -> (cls, source)。class1=动作一/动作二；class2=动作三；class0=板移噪声。"""
    if dir_name.startswith("动作一") or dir_name.startswith("动作二"):
        return 1, "camera"
    if dir_name.startswith(WAVE_DIR_PREFIX):
        return 2, "camera"
    if any(k in dir_name for k in NOISE_DIR_KEYWORDS):
        return 0, "board_move"
    raise ValueError(f"无法判定类别的目录：{dir_name}")


def infer_group(path):
    """新目录没有过滤参数.txt：路径含参数搭配三/事件补录 => (3,18) 且有依据；
    其它未知目录同样默认 (3,18) 但 assumption=True（报告用每帧事件数中位数佐证）。"""
    joined = path.replace("\\", "/")
    if any(h in joined for h in GROUP_HINTS):
        return DEFAULT_GROUP[0], DEFAULT_GROUP[1], True
    return DEFAULT_GROUP[0], DEFAULT_GROUP[1], True


class SessionSpec:
    def __init__(self, session, cls, source, group_assumed, split, split_mode):
        self.session = session
        self.cls = int(cls)
        # 类别合并后，会话自身动作标签必须与合并后的类一致（动作二 -> class1）
        self.session.action = self.cls
        self.source = source
        self.group_assumed = bool(group_assumed)
        self.split = split
        self.split_mode = split_mode

    def __repr__(self):
        return (f"SessionSpec({self.session.name}, cls={self.cls}, group={self.session.group},"
                f" source={self.source}, assumed={self.group_assumed}, split={self.split})")


def load_v2_sessions(root):
    """显式会话表：v1 的 12 条 + 4 条补录 + 动作三 + 板移噪声 = 18 条。"""
    specs = []
    base = E.discover_sessions(root)
    for s in base:
        specs.append(SessionSpec(s, cls=1, source="camera", group_assumed=False,
                                 split="train", split_mode="session"))
    next_idx = len(specs)
    for dir_prefix in ("动作一", "动作二"):
        parent = find_dir(root, (dir_prefix,))
        if parent is None:
            continue
        for sub in sorted(os.listdir(parent)):
            subp = os.path.join(parent, sub)
            if not os.path.isdir(subp):
                continue
            if not any(h in sub for h in GROUP_HINTS):
                continue
            for csv in list_event_csvs(subp):
                th, dl, assumed = infer_group(csv)
                s = E.load_session(csv, 1, th, dl, next_idx)
                next_idx += 1
                specs.append(SessionSpec(s, cls=1, source="camera", group_assumed=assumed,
                                         split="train", split_mode="session"))
    wave_dir = find_dir(root, (WAVE_DIR_PREFIX,))
    if wave_dir is not None:
        for csv in list_event_csvs(wave_dir):
            th, dl, assumed = infer_group(csv)
            s = E.load_session(csv, 2, th, dl, next_idx)
            next_idx += 1
            specs.append(SessionSpec(s, cls=2, source="camera", group_assumed=assumed,
                                     split="train", split_mode="single_session"))
    noise_dir = find_dir(root, ("板子", "噪声"))
    if noise_dir is not None:
        for csv in list_event_csvs(noise_dir):
            th, dl, assumed = infer_group(csv)
            s = E.load_session(csv, 0, th, dl, next_idx)
            next_idx += 1
            specs.append(SessionSpec(s, cls=0, source="board_move", group_assumed=assumed,
                                     split="train", split_mode="single_session"))
    for i, sp in enumerate(specs):
        sp.session.file_idx = i
    return specs


def non_overlap_count(n_windows, stride_ms, win_ms):
    """重叠窗数 -> 不重叠窗口数估计（v1 sample_gap 同式：n * stride / win）。"""
    if not win_ms:
        return int(n_windows)
    return int(round(n_windows * stride_ms / win_ms))


def _bin_median(frame_counts):
    fc = np.asarray(frame_counts, dtype=np.float64)
    return float(np.median(fc)) if fc.size else 0.0


def group_evidence(specs):
    """参数组 assumption 佐证：v1 已知组的每帧事件数中位数 vs 新文件。"""
    rows = []
    for sp in specs:
        rows.append({
            "session": sp.session.name,
            "cls": sp.cls,
            "group": sp.session.group,
            "assumed": sp.group_assumed,
            "source": sp.source,
            "events": int(len(sp.session.t)),
            "frames": int(len(sp.session.frame_times)),
            "duration_s": round(sp.session.span_ms / 1000.0, 3),
            "median_events_per_frame": round(_bin_median(sp.session.frame_counts), 1),
        })
    known = {}
    for r in rows:
        if not r["assumed"]:
            known.setdefault(r["group"], []).append(r["median_events_per_frame"])
    summary = {g: round(float(np.median(v)), 1) for g, v in known.items()}
    return rows, summary


def assign_split(specs):
    """会话级切分：留出两条 (3,18) 会话 -> test；其余 train。
    单会话类（class2 横向挥手、板移噪声）整条会话进 train（mode=single_session），
    由 probe_class2.py 在这条会话内部按时间后半段另做留出评估。"""
    for sp in specs:
        if sp.session.name in HOLDOUT_SESSIONS:
            sp.split = "test"
            sp.split_mode = "session"
        else:
            sp.split = "train"
            sp.split_mode = sp.split_mode if sp.split_mode == "single_session" else "session"
    return specs


def build_v2(specs, win_ms, stride_ms=None):
    """用 v1 的 build_dataset 拼 X/y，再补 source/split/group_assumption 元数据。"""
    sessions = [sp.session for sp in specs]
    ds = E.build_dataset(sessions, win_ms, stride_ms)
    stride = int(stride_ms) if stride_ms else max(1, win_ms // 2)
    n_per = [len(E.window_starts(int(s.frame_times[0]), int(s.frame_times[-1]),
                                 win_ms, stride)) for s in sessions]
    total = int(len(ds["y"]))
    if sum(n_per) != total:
        raise AssertionError(f"窗口数不守恒：{sum(n_per)} vs {total}")
    source, split, split_mode, assumed, cls = [], [], [], [], []
    for sp, n in zip(specs, n_per):
        source.extend([sp.source] * n)
        split.extend([sp.split] * n)
        split_mode.extend([sp.split_mode] * n)
        assumed.extend([1 if sp.group_assumed else 0] * n)
        cls.extend([sp.cls] * n)
    meta = ds["meta"]
    meta["source"] = E._uarray(source, 12)
    meta["split"] = E._uarray(split, 5)
    meta["split_mode"] = E._uarray(split_mode, 16)
    meta["group_assumption"] = np.asarray(assumed, dtype=np.uint8)
    meta["cls"] = np.asarray(cls, dtype=np.uint8)
    meta["class_name"] = E._uarray([CLASS_NAMES[c] for c in cls], 32)
    return ds, n_per


def session_split_check(meta):
    """同一 session 的窗口不得同时出现在 train/test；单会话类整条进 train 也必须唯一。"""
    session = np.asarray(meta["session"])
    split = np.asarray(meta["split"])
    mode = np.asarray(meta["split_mode"])
    problems = []
    for name in sorted(set(session.tolist())):
        mask = session == name
        vals = sorted(set(split[mask].tolist()))
        m = sorted(set(mode[mask].tolist()))
        if len(vals) > 1 or len(m) > 1:
            problems.append(f"{name} split={vals} mode={m}")
    return len(problems) == 0, problems, session, split, mode


def class_summary(ds):
    y = np.asarray(ds["y"])
    meta = ds["meta"]
    stride = int(meta["stride_ms"][0]) if len(y) else 0
    win = int(meta["win_ms"][0]) if len(y) else 0
    out = {}
    for c in (0, 1, 2):
        mask = y == c
        n = int(mask.sum())
        n_src = int(np.sum(np.asarray(meta["source"])[mask] == "board_move"))
        out[c] = {
            "windows": n,
            "windows_board_move": n_src,
            "non_overlap_est": non_overlap_count(n, stride, win),
            "recording_s": round(n * stride / 1000.0, 2) if win else 0.0,
        }
    return out


def print_dataset_report(ds, specs, n_per, win_ms):
    meta = ds["meta"]
    y = np.asarray(ds["y"])
    print(f"[dataset_v2] win_ms={win_ms} windows={len(y)} stride={int(meta['stride_ms'][0])}")
    for c in (0, 1, 2):
        s = class_summary(ds)[c]
        print(f"  class {c} ({CLASS_NAMES[c]}): windows={s['windows']}"
              f" non_overlap_est={s['non_overlap_est']}"
              f" board_move_windows={s['windows_board_move']}")
    src = np.asarray(meta["source"])
    print(f"  source: camera={int(np.sum(src == 'camera'))} board_move={int(np.sum(src == 'board_move'))}")
    sp = np.asarray(meta["split"])
    print(f"  split: train={int(np.sum(sp == 'train'))} test={int(np.sum(sp == 'test'))}")
    print(f"  group_assumption windows: {int(np.sum(np.asarray(meta['group_assumption']) == 1))}")
    ok, problems, session, split, mode = session_split_check(meta)
    print(f"  SESSION_SPLIT_PASS={1 if ok else 0}")
    if problems:
        for p in problems:
            print(f"  [SPLIT_PROBLEM] {p}")
    for name in sorted(set(session.tolist())):
        mask = session == name
        print(f"  - {name}: windows={int(mask.sum())} split={sorted(set(split[mask].tolist()))}"
              f" mode={sorted(set(mode[mask].tolist()))} cls={sorted(set(np.asarray(meta['cls'])[mask].tolist()))}"
              f" source={sorted(set(np.asarray(meta['source'])[mask].tolist()))}")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="构建数据集 v2（合并类别 + 板移硬负样本）")
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=HERE)
    ap.add_argument("--wins", default="100,150,200")
    args = ap.parse_args(argv)
    specs = load_v2_sessions(args.data_root)
    if not specs:
        print(f"[FATAL] 未发现任何会话：{args.data_root}", file=sys.stderr)
        return 2
    assign_split(specs)
    rows, known = group_evidence(specs)
    print("[dataset_v2] 会话表：")
    for r in rows:
        print(f"  - {r['session']} cls={r['cls']} group={r['group']}"
              f" assumed={r['assumed']} source={r['source']} events={r['events']}"
              f" frames={r['frames']} dur={r['duration_s']}s"
              f" median_events_per_frame={r['median_events_per_frame']}")
    print(f"[dataset_v2] v1 已知参数组 median events/frame：{known}")
    new_rows = [r for r in rows if r["assumed"]]
    print("[dataset_v2] 补录/新文件 median events/frame:",
          {r["session"]: r["median_events_per_frame"] for r in new_rows})
    all_ok = True
    for win in [int(w) for w in args.wins.split(",") if w.strip()]:
        ds, n_per = build_v2(specs, win)
        ok = print_dataset_report(ds, specs, n_per, win)
        all_ok = all_ok and ok
        path = os.path.join(args.out_dir, f"dataset_v2_w{win}.npz")
        E.save_dataset(ds, path)
        print(f"  wrote {path} size={os.path.getsize(path)}")
        with np.load(path, allow_pickle=False) as z:
            keys = set(z.files)
            need = {"X_counts", "X_q", "y", "file", "session", "group", "action",
                    "file_idx", "seg_id", "seg_start_frame", "seg_end_frame", "t_ms",
                    "win_ms", "stride_ms", "split_reason", "source", "split", "split_mode",
                    "group_assumption", "cls"}
            missing = need - keys
            if missing:
                print(f"  [DATASET2_ERROR] missing keys: {sorted(missing)}")
                all_ok = False
            if z["X_counts"].shape[1:] != (4, E.GRID_H, E.GRID_W):
                print(f"  [DATASET2_ERROR] X shape {z['X_counts'].shape}")
                all_ok = False
    print(f"DATASET2_OK={1 if all_ok else 0}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
