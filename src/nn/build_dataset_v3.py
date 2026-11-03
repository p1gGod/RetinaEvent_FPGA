#!/usr/bin/env python3
"""构建数据集 v3：并入 2026-10-29 21:19/21:20 补录的 2 条横向挥手会话。

v3 与 v2 唯一的区别是数据来源多 L / 产物名不同；字段、切分协议、类别语义完全沿用 v2，
因此直接复用 build_dataset_v2 的加载/构建/自检逻辑，保证 meta 同构。
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

import build_dataset_v2 as B
import extract_events as E

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = B.DEFAULT_ROOT
V3_CLASS2_SESSIONS = {
    "retina-events-20261029-210102",
    "retina-events-20261029-211950",
    "retina-events-20261029-212036",
}


def build_v3(data_root: str, out_dir: str, wins):
    specs = B.load_v2_sessions(data_root)
    if not specs:
        print(f"[FATAL] 未发现任何会话：{data_root}", file=sys.stderr)
        return 2
    class2 = sorted({sp.session.name for sp in specs if sp.cls == 2})
    print("[dataset_v3] class2 会话:", class2)
    if set(class2) != V3_CLASS2_SESSIONS:
        print(f"[DATASET3_ERROR] class2 会话集合不符：{class2}", file=sys.stderr)
        return 1

    B.assign_split(specs)
    rows, known = B.group_evidence(specs)
    print("[dataset_v3] 会话表：")
    for r in rows:
        print(f"  - {r['session']} cls={r['cls']} group={r['group']}"
              f" assumed={r['assumed']} source={r['source']} events={r['events']}"
              f" frames={r['frames']} dur={r['duration_s']}s"
              f" median_events_per_frame={r['median_events_per_frame']}")
    print(f"[dataset_v3] v1 已知参数组 median events/frame：{known}")
    for r in rows:
        if r["session"] in V3_CLASS2_SESSIONS:
            print(f"[dataset_v3] 补录挥手 {r['session']}: group={r['group']} assumed={r['assumed']}"
                  f" median_events_per_frame={r['median_events_per_frame']}"
                  f" frames={r['frames']} dur={r['duration_s']}s")
    all_ok = True
    summary = {}
    for win in wins:
        specs = B.load_v2_sessions(data_root)
        B.assign_split(specs)
        ds, n_per = B.build_v2(specs, win)
        meta = ds["meta"]
        y = np.asarray(ds["y"])
        s2 = np.asarray(meta["session"])[y == 2]
        n2 = int((y == 2).sum())
        n2_sessions = len(set(s2.tolist()))
        ok_split, problems, session, split, mode = B.session_split_check(meta)
        print(f"[dataset_v3] win_ms={win} windows={len(y)} class2_windows={n2}"
              f" class2_sessions={n2_sessions}")
        for c in (0, 1, 2):
            s = B.class_summary(ds)[c]
            print(f"  class {c} ({B.CLASS_NAMES[c]}): windows={s['windows']}"
                  f" non_overlap_est={s['non_overlap_est']}"
                  f" board_move_windows={s['windows_board_move']}")
        print(f"  SESSION_SPLIT_PASS={1 if ok_split else 0}")
        if win == 100:
            if n2 < 110:
                print(f"  [DATASET3_ERROR] class2 窗数 {n2} < 110")
                all_ok = False
            if n2_sessions != 3:
                print(f"  [DATASET3_ERROR] class2 会话数 {n2_sessions} != 3")
                all_ok = False
        if not ok_split:
            all_ok = False
            for p in problems:
                print(f"  [SPLIT_PROBLEM] {p}")
        path = os.path.join(out_dir, f"dataset_v3_w{win}.npz")
        E.save_dataset(ds, path)
        print(f"  wrote {path} size={os.path.getsize(path)}")
        with np.load(path, allow_pickle=False) as z:
            need = {"X_counts", "X_q", "y", "file", "session", "group", "action",
                    "file_idx", "seg_id", "seg_start_frame", "seg_end_frame", "t_ms",
                    "win_ms", "stride_ms", "split_reason", "source", "split", "split_mode",
                    "group_assumption", "cls", "theta", "delta", "channels",
                    "grid_shift", "grid_w", "grid_h"}
            missing = need - set(z.files)
            if missing:
                print(f"  [DATASET3_ERROR] missing keys: {sorted(missing)}")
                all_ok = False
            if z["X_counts"].shape[1:] != (4, E.GRID_H, E.GRID_W):
                print(f"  [DATASET3_ERROR] X shape {z['X_counts'].shape}")
                all_ok = False
            keys_v2 = set(np.load(os.path.join(HERE, "dataset_v2_w100.npz")).files) if os.path.exists(
                os.path.join(HERE, "dataset_v2_w100.npz")) else set()
            if keys_v2 and set(z.files) != keys_v2:
                print(f"  [DATASET3_ERROR] 字段与 v2 不同构：extra={sorted(set(z.files)-keys_v2)}"
                      f" missing={sorted(keys_v2-set(z.files))}")
                all_ok = False
        summary[win] = {"windows": len(y), "class2": n2, "class2_sessions": n2_sessions}
    print("DATASET3_OK=%d" % (1 if all_ok else 0))
    return 0 if all_ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="构建数据集 v3（并入 2 条补录横向挥手）")
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=HERE)
    ap.add_argument("--wins", default="100,150,200")
    args = ap.parse_args(argv)
    wins = [int(w) for w in args.wins.split(",") if w.strip()]
    return build_v3(args.data_root, args.out_dir, wins)


if __name__ == "__main__":
    raise SystemExit(main())
