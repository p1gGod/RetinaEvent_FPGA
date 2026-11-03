#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据集 v4：v3 构建逻辑（build_dataset_v2）+ 逐窗 QC 协变量（qc_clip 同一实现）。

与 v3 的差异（只增不改，X/y 与 v3 逐窗一致）：
  1. 会话表 = v2 显式表 + 用 Path(root).rglob("retina-events-*.csv") 递归补入
     「新目录」里的 CSV（已存在的绝对路径按 normcase 去重，绝不重复计数）；
     新目录类别沿用 v2 的目录名规则（动作一/二=class1，动作三=class2，
     位移/噪声/环境事件=class0 硬负样本）；无法判类的目录直接判 V4_OK=0 并列出，
     绝不静默猜类。
  2. 每条会话跑 qc_clip.compute_session_metrics()，判定按会话广播到窗：
     qc_pass(uint8)/qc_verdict(<U5)；阈值只来自 qc_clip.DEFAULT_THRESHOLDS。
  3. 每个窗用 qc_clip.window_scalars() 算 density_p50 / active_frames / swing_px /
     scalar_swing_x(=swing_x/s) / scalar_horiz(=horizontality)；该函数与 QC 共用
     qc_clip.motion_features() 这一份运动公式，v4 里零复制。断言 t_ms 与 build_v2
     的窗口逐窗对齐（防止协变量错位）。
  4. 产出 nn/dataset_v4_w100.npz + nn/REPORT_QC与数据集v4.md + nn/_evidence/V4_OK.log。

工程裁决（lead，2026-10-29）：QC 的 PASS/WARN/FAIL 在 v4 里**只作协变量与警告，
不作硬过滤**（硬过滤会把 class2 清零、class1 只剩 3 条会话）。密度 800~2,000 是
「理想采集带」，不是历史数据不合格的判决。报告同时给「过滤前 / 只保留 qc_pass 窗」
两套类别计数。

用法：
  cd E:/workspace/FPGA_Comp/nn
  PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe build_dataset_v4.py
  ... --data-root <root> --out-dir <dir> --win 100
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import build_dataset_v2 as B  # noqa: E402
import extract_events as E  # noqa: E402
import qc_clip  # noqa: E402

DEFAULT_ROOT = B.DEFAULT_ROOT
DEFAULT_OUT = HERE
DEFAULT_WIN = 100
DEFAULT_NPZ = "dataset_v4_w100.npz"
DEFAULT_REPORT = "REPORT_QC与数据集v4.md"
DEFAULT_EVIDENCE = Path("_evidence") / "V4_OK.log"
CLASS_SHORT = {0: "class0", 1: "class1", 2: "class2"}
COV_FIELDS = ("density_p50", "active_frames", "swing_px", "qc_pass", "qc_verdict",
              "scalar_swing_x", "scalar_horiz")
FUSION_BEGIN = "<!-- FUSION_SECTION_BEGIN -->"
FUSION_END = "<!-- FUSION_SECTION_END -->"
REQUIRED_KEYS = (
    "X_counts", "X_q", "y", "file", "session", "group", "action", "file_idx",
    "seg_id", "seg_start_frame", "seg_end_frame", "t_ms", "win_ms", "stride_ms",
    "split_reason", "source", "split", "split_mode", "group_assumption", "cls",
    "class_name",
) + COV_FIELDS
BT = chr(96)  # 反引号只用于报告里的行内代码，源码本身不含字面反引号


class Log:
    """同时写 stdout 与证据日志。"""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, msg: str = "") -> None:
        print(msg, flush=True)
        self.lines.append(str(msg))


def norm_path(p) -> str:
    return os.path.normcase(os.path.abspath(str(p)))


def class_for_path(path, root):
    """按 v2 的目录名规则给「新目录」里的 CSV 定类；返回 (cls, source) 或 None。

    规则顺序与 build_dataset_v2.class_for_dir 一致（import 复用，不复制规则）；
    未知目录返回 None（由调用方判 V4_OK=0，绝不静默猜类）。"""
    rel = Path(path).resolve().relative_to(Path(root).resolve())
    for name in rel.parts[:-1]:  # 去掉文件名，只看目录层级
        try:
            return B.class_for_dir(name)
        except ValueError:
            continue
    return None


def discover_new_csvs(root, known_paths):
    """rglob 递归找所有事件 CSV，返回 (extras, unknown)。

    extras: [(Path, cls, source)]；unknown: [Path]（目录名无法判类）。"""
    root_p = Path(root).resolve()
    known = {norm_path(p) for p in known_paths}
    extras, unknown = [], []
    for p in sorted(root_p.rglob("retina-events-*.csv")):
        if norm_path(p) in known:
            continue
        cls = class_for_path(p, root_p)
        if cls is None:
            unknown.append(p)
        else:
            extras.append((p, int(cls[0]), str(cls[1])))
    return extras, unknown


def build_specs(root):
    """v2 会话表 + rglob 补入的新目录 CSV；再跑 B.assign_split。"""
    specs = B.load_v2_sessions(root)
    known_n = len(specs)
    extras, unknown = discover_new_csvs(root, [sp.session.path for sp in specs])
    for p, cls, source in extras:
        sess = E.load_session(str(p), cls, B.DEFAULT_GROUP[0], B.DEFAULT_GROUP[1], 0)
        mode = "session" if cls == 1 else "single_session"
        specs.append(B.SessionSpec(sess, cls=cls, source=source,
                                   group_assumed=True, split="train",
                                   split_mode=mode))
    for i, sp in enumerate(specs):
        sp.session.file_idx = i
    B.assign_split(specs)
    return specs, extras, unknown, known_n


def session_qc(specs):
    """逐会话 QC 判定（qc_clip 的同一实现，阈值不复制）。"""
    return {sp.session.name: qc_clip.compute_session_metrics(sp.session) for sp in specs}


def window_covariates(specs, win_ms):
    """逐窗协变量；返回 dict[字段]->np.ndarray（含用于对齐校验的 t0）。"""
    stride = max(1, win_ms // 2)
    t0s, dens, act, swing, sx, hz = [], [], [], [], [], []
    for sp in specs:
        sess = sp.session
        starts = E.window_starts(int(sess.frame_times[0]), int(sess.frame_times[-1]),
                                 win_ms, stride)
        for t0 in starts.tolist():
            w = qc_clip.window_scalars(sess, int(t0), int(t0) + win_ms)
            t0s.append(int(t0))
            dens.append(float(w["density_p50"]))
            act.append(int(w["active_frames"]))
            swing.append(float(w["swing_px"]))
            sx.append(float(w["swing_x_over_s"]))
            hz.append(float(w["horizontality"]))
    n = len(t0s)
    cov = {
        "t0": np.asarray(t0s, dtype=np.int64),
        "density_p50": np.asarray(dens, dtype=np.float32),
        "active_frames": np.asarray(act, dtype=np.int16),
        "swing_px": np.asarray(swing, dtype=np.float32),
        "scalar_swing_x": np.asarray(sx, dtype=np.float32),
        "scalar_horiz": np.asarray(hz, dtype=np.float32),
    }
    assert len(cov["density_p50"]) == n
    return cov


def vectorize_qc(specs, qcs, n_per):
    """会话级 QC 结论按会话广播到窗（QC 的验证单位是会话）。"""
    qc_pass, qc_verdict = [], []
    for sp, n in zip(specs, n_per):
        m = qcs[sp.session.name]
        qc_pass.extend([1 if m["verdict"] == "PASS" else 0] * int(n))
        qc_verdict.extend([m["verdict"]] * int(n))
    return np.asarray(qc_pass, dtype=np.uint8), E._uarray(qc_verdict, 5)


def class_counts(y):
    return {int(c): int((np.asarray(y) == c).sum()) for c in (0, 1, 2)}


def session_class_counts(specs, only_verdict=None, qcs=None):
    out = {0: 0, 1: 0, 2: 0}
    for sp in specs:
        if only_verdict is not None and qcs[sp.session.name]["verdict"] != only_verdict:
            continue
        out[int(sp.cls)] += 1
    return out


def pct(vals, q):
    v = np.asarray(vals, dtype=np.float64)
    return float(np.percentile(v, q)) if v.size else 0.0


def md_table(headers, rows):
    out = ["| " + " | ".join(str(h) for h in headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(v) for v in r) + " |")
    return "\n".join(out)


def read_fusion_section(report_path: Path):
    """保留上一轮 train_fusion.py 写进报告里的融合章节。"""
    if not report_path.exists():
        return None
    try:
        text = report_path.read_text(encoding="utf-8")
    except OSError:
        return None
    i = text.find(FUSION_BEGIN)
    j = text.find(FUSION_END)
    if i < 0 or j < 0 or j <= i:
        return None
    return text[i:j + len(FUSION_END)]


def warn_if_zero(name, before, after):
    """某类过滤后归零 => 显式红字警告（task-19 硬性要求）。"""
    if before > 0 and after == 0:
        return ('<span style="color:red">**⚠ 红字警告：' + name + ' 只保留 qc_pass 窗后归零**'
                '（过滤前 ' + str(before) + ' 窗 → 过滤后 0 窗）。硬过滤会让 ' + name +
                ' 无法训练/评估，所以 v4 **不做硬过滤**，qc_pass 只作为协变量与加权依据。</span>')
    return None


def build_report(path, root, win_ms, stride_ms, specs, qcs, extra_rows, unknown,
                 known_n, ds, npz_path, cov, checks, log):
    y = np.asarray(ds["y"])
    meta = ds["meta"]
    session = np.asarray(meta["session"])
    qc_pass = np.asarray(meta["qc_pass"])
    split = np.asarray(meta["split"])
    n = len(y)
    before = class_counts(y)
    mask = qc_pass == 1
    after = class_counts(y[mask])
    before_sess = session_class_counts(specs)
    after_sess = session_class_counts(specs, only_verdict="PASS", qcs=qcs)
    pass_sess = [sp for sp in specs if qcs[sp.session.name]["verdict"] == "PASS"]
    fail_sess = [sp for sp in specs if qcs[sp.session.name]["verdict"] == "FAIL"]
    warn_sess = [sp for sp in specs if qcs[sp.session.name]["verdict"] == "WARN"]
    ok, problems, _, _, _ = B.session_split_check(meta)
    thr = dict(qc_clip.DEFAULT_THRESHOLDS)
    verdict_all = all(good for _, good in checks)
    t_pass = len(pass_sess)
    t_fail = len(fail_sess)

    L = []
    L.append("# REPORT：录制质量门禁（QC）与数据集 v4")
    L.append("")
    L.append(f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S %z')}")
    L.append("- 生成脚本：nn/build_dataset_v4.py（qc_clip.py 提供阈值/判定，"
             "build_dataset_v2.py 提供会话表/切分/窗口构建，extract_events.py 提供解析与 npz 写出）")
    L.append(f"- 数据根：{root}")
    L.append(f"- 数据集：{npz_path}（win={win_ms} ms，stride={stride_ms} ms，"
             f"{n} 窗，X_q {tuple(ds['X_q'].shape)}，X_counts {tuple(ds['X_counts'].shape)}）")
    L.append(f"- 判定：**{'V4_OK=1' if verdict_all else 'V4_OK=0'}**；"
             f"会话 {len(specs)} 条（v2 已知 {known_n} + rglob 新目录 {len(extra_rows)}）；"
             f"QC PASS {t_pass} / FAIL {t_fail}")
    L.append("")
    L.append("> 工程裁决：QC 的三档判定在 v4 里**只作协变量与警告，不作硬过滤**。"
             "密度 800~2,000 是「理想采集带」，不是历史数据不合格的判决；"
             "历史数据的价值是先训出可用网络，新数据到位后再按 qc_pass 加权/重训。")
    L.append("")
    L.append("## 1. QC 阈值（单一来源 qc_clip.DEFAULT_THRESHOLDS，本脚本不复制数值实现）")
    L.append("")
    L.append(md_table(["阈值", "值", "含义"], [
        ["density_min / density_max", f"{thr['density_min']:.0f} / {thr['density_max']:.0f} ev/frame",
         "每帧事件数中位数的理想采集带"],
        ["active_duration_ms", f"{thr['active_duration_ms']:.0f} ms", "活跃段最短时长"],
        ["swing_px", f"{thr['swing_px']:.0f} px", "横向去趋势摆幅下限"],
        ["cycles", f"{thr['cycles']:.0f}", "完整摆动周期数下限（过零法/2）"],
        ["active_ratio", f"{thr['active_ratio']:.2f}", "活跃帧占比下限"],
        ["active_frame_events", f"{thr['active_frame_events']:.0f} ev/frame", "活跃帧判定阈值"],
    ]))
    L.append("")
    L.append("## 2. 逐会话 QC 表（20 条会话逐条判定，可复核）")
    L.append("")
    rows = []
    for i, sp in enumerate(specs):
        m = qcs[sp.session.name]
        rows.append([str(i + 1), m["session"][-6:], CLASS_SHORT[sp.cls], sp.source, m["verdict"],
                     f"{m['n_frames']}/{m['active_frames']}",
                     f"{m['duration_ms'] / 1000:.2f}/{m['active_duration_ms'] / 1000:.2f}",
                     f"{m['density_p50']:,.1f}",
                     f"{m['swing_px']:.1f}/{m['swing_y_px']:.1f}",
                     f"{m['horizontality']:.3f}",
                     f"{m['cycles']:.1f}", f"{m['active_ratio']:.3f}",
                     "；".join(m["reasons"]) if m["reasons"] else "—"])
    L.append(md_table(
        ["#", "会话(后6位)", "类", "源", "判定", "帧/活跃", "时长/活跃(s)", "密度p50",
         "摆幅x/y(px)", "横向度", "周期", "占比", "原因"], rows))
    L.append("")
    L.append("> 表内「摆幅x/y」「横向度」是**整段口径**（整段会话的活跃帧质心，"
             "qc_clip.motion_features），与逐窗特征（窗内全部帧）口径不同，不可混用。"
             "例：211950（class2 横向挥手）整段口径 swing_y=211.4px > swing_x=176.6px、"
             "horizontality=0.455 —— 说明那一段「横向挥手」其实上下漂得比左右还多，"
             "这是要重录的原因之一；而它的整段密度 p50=3,046 ev/frame，是判 FAIL 的**唯一**硬项"
             "（摆幅/周期/占比其余四项都过）。")
    L.append("")
    L.append("## 3. 达标 / 不达标会话清单")
    L.append("")
    L.append(f"- **PASS（{len(pass_sess)} 条）**："
             + ("、".join(f"{sp.session.name[-6:]}({CLASS_SHORT[sp.cls]})" for sp in pass_sess) or "无"))
    L.append(f"- **WARN（{len(warn_sess)} 条）**："
             + ("、".join(f"{sp.session.name[-6:]}({CLASS_SHORT[sp.cls]})" for sp in warn_sess) or "无"))
    L.append(f"- **FAIL（{len(fail_sess)} 条）**：")
    reason_kinds = {}
    for sp in fail_sess:
        for r in qcs[sp.session.name]["reasons"]:
            key = re.split(r"[ 0-9]", r, maxsplit=1)[0].strip() or r
            reason_kinds.setdefault(key, []).append(sp.session.name[-6:])
    for key in sorted(reason_kinds, key=lambda k: -len(reason_kinds[k])):
        L.append(f"  - {key}：{len(reason_kinds[key])} 条 —— " + "、".join(reason_kinds[key]))
    L.append("")
    L.append("## 4. 类别计数：过滤前 vs 只保留 qc_pass 窗")
    L.append("")
    L.append(md_table(
        ["类别", "过滤前·窗", "过滤前·会话", "过滤后·窗", "过滤后·会话", "变化"],
        [[CLASS_SHORT[c], before[c], before_sess[c], after[c], after_sess[c],
          f"{before[c]} → {after[c]}"] for c in (0, 1, 2)]))
    L.append("")
    L.append(f"- 合计：过滤前 {n} 窗 / {len(specs)} 会话 → 只保留 qc_pass 后 "
             f"{int(mask.sum())} 窗 / {int(sum(after_sess.values()))} 会话"
             f"（占 {100.0 * mask.sum() / max(n, 1):.1f}% 窗）。")
    dens = np.asarray(cov["density_p50"], dtype=np.float64)
    in_band = float(((dens >= thr["density_min"]) & (dens <= thr["density_max"])).mean())
    L.append(f"- 窗级密度落在理想采集带 [{thr['density_min']:.0f}, {thr['density_max']:.0f}] 内的比例："
             f"**{100.0 * in_band:.1f}%**（仅供参考，不作过滤）。")
    L.append("")
    warns = [w for c in (0, 1, 2) if (w := warn_if_zero(CLASS_SHORT[c], before[c], after[c]))]
    if warns:
        for w in warns:
            L.append(w)
            L.append("")
    L.append("> 结论：**不做硬过滤**。v4 里 qc_pass=1 的窗只占 "
             f"{100.0 * mask.sum() / max(n, 1):.1f}%，若按它硬过滤，class2 会归零、"
             "class1 只剩 3 条会话，训练无从谈起。正确用法是新数据到位后按 qc_pass "
             "做样本加权（或重建 v4 后重训），而不是删数据。")
    L.append("")
    L.append("## 5. 逐窗协变量（字段定义与分布）")
    L.append("")
    L.append("qc_pass / qc_verdict 是**会话级**判定按会话广播到窗（QC 的判定单位是会话："
             "摆幅/周期/密度都是整段尺度）；其余均为**窗级**实测值，"
             "由 qc_clip.window_scalars(sess, t0, t1) 用与 QC 同一份运动公式"
             "（qc_clip.motion_features）算出，v4 脚本里没有第二套公式。")
    L.append("")
    defs = {
        "density_p50": "窗内每帧事件数中位数（ev/frame）",
        "active_frames": "窗内活跃帧数（frame_counts >= active_frame_events）",
        "swing_px": "窗内逐帧质心 x 线性去趋势后的 ptp（px）",
        "scalar_swing_x": "swing_x / s，s=max(窗内事件 x/y 的 p95-p05)（clamp>=1），无量纲",
        "scalar_horiz": "swing_x/(swing_x+swing_y)，无量纲，∈[0,1]",
    }
    rows = []
    for f in ("density_p50", "active_frames", "swing_px", "scalar_swing_x", "scalar_horiz"):
        v = np.asarray(cov[f], dtype=np.float64)
        rows.append([f, str(np.asarray(cov[f]).dtype), defs[f],
                     f"{pct(v, 5):.4f}", f"{pct(v, 50):.4f}", f"{pct(v, 95):.4f}",
                     f"{float(v.min()):.4f}", f"{float(v.max()):.4f}"])
    rows.append(["qc_pass", "uint8", "会话判定==PASS 则 1（会话级广播）", "—", "—", "—",
                 str(int(qc_pass.min())), str(int(qc_pass.max()))])
    rows.append(["qc_verdict", "<U5", "会话判定字符串（会话级广播）", "—", "—", "—",
                 "/".join(sorted(set(np.asarray(meta["qc_verdict"]).tolist()))) if n else "—", ""])
    L.append(md_table(["字段", "dtype", "定义", "p05", "p50", "p95", "min", "max"], rows))
    L.append("")
    L.append("## 6. 会话级切分自检")
    L.append("")
    L.append(f"- SESSION_SPLIT_PASS={1 if ok else 0}（同一会话的窗绝不跨 train/test）。"
             f"train 窗 {int((split == 'train').sum())}，test 窗 {int((split == 'test').sum())}；"
             "test 会话（v2 固定留出）："
             + ("、".join(sorted(set(session[split == 'test'].tolist()))) or "无"))
    if problems:
        for p in problems:
            L.append(f"- [SPLIT_PROBLEM] {p}")
    L.append("")
    L.append("## 7. 新增目录 / rglob 补入")
    L.append("")
    L.append(f"- 递归扫描 {root}/**/retina-events-*.csv：v2 已覆盖 {known_n} 条，"
             f"本次 rglob 新增 {len(extra_rows)} 条，无法判类 {len(unknown)} 条。")
    if extra_rows:
        L.append(md_table(["新增 CSV", "类", "源"],
                          [[str(p), CLASS_SHORT[c], s] for p, c, s in extra_rows]))
    else:
        L.append("- 本次没有出现 v2 会话表之外的新 CSV（新增目录数据会自动经 rglob 进入，"
                 "已存在路径按 normcase 去重）。")
    for p in unknown:
        L.append(f"- [V4_UNKNOWN_DIR] 无法从目录名判类：{p}（需在 build_dataset_v2.class_for_dir 增规则）")
    L.append("")
    L.append("## 8. dataset_v4 npz 字段")
    L.append("")
    L.append(f"- 本构建校验的必需字段 {len(REQUIRED_KEYS)} 个："
             + ", ".join(REQUIRED_KEYS))
    L.append(f"- X_counts uint16 {tuple(ds['X_counts'].shape)}、X_q int8 {tuple(ds['X_q'].shape)}，"
             f"通道 = {tuple(ds['meta']['channels'])}；y uint8 三类（0/1/2）。")
    L.append("- 与 v3 的关系：X/y/窗口位置逐窗一致（同 build_dataset_v2.build_v2 与 "
             "extract_events.build_dataset），v4 只**追加**协变量字段，不改 v3 文件。")
    L.append("")
    L.append("## 9. 自检结果（机读）")
    L.append("")
    for name, good in checks:
        L.append(f"- {name} = {1 if good else 0}")
    L.append("")
    L.append("## 10. 融合训练")
    L.append("")
    fusion = read_fusion_section(path)
    if fusion:
        L.append(fusion)
    else:
        L.append(FUSION_BEGIN)
        L.append("（由 nn/train_fusion.py 生成：会话级 LOO 逐折数字 + ROM 地址表 + 不可部署判断）")
        L.append(FUSION_END)
    L.append("")
    L.append("## 11. 新数据到手后的命令")
    L.append("")
    L.append("~~~bash")
    L.append("cd E:/workspace/FPGA_Comp/nn")
    L.append("# 1) 先验新录像是否达标（目录递归；最后一行是汇总 JSON）")
    L.append("PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe qc_clip.py \"E:/workspace/FPGA_Comp/row_datas/原始采集数据\"")
    L.append("# 2) 重建 v4 数据集（自动 rglob 收进新目录）")
    L.append("PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe build_dataset_v4.py")
    L.append("# 3) 重训融合管线（会话级 LOO + out_v4 产物）")
    L.append("PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe train_fusion.py")
    L.append("~~~")
    L.append("")
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def main(argv=None):
    qc_clip._force_utf8_stdio()
    ap = argparse.ArgumentParser(description="构建数据集 v4（v3 + QC 协变量）")
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--win", type=int, default=DEFAULT_WIN)
    ap.add_argument("--npz", default=DEFAULT_NPZ)
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--evidence", default=str(DEFAULT_EVIDENCE))
    args = ap.parse_args(argv)

    log = Log()
    t_start = time.time()
    checks = []
    log(f"[v4] data_root={args.data_root} win={args.win}ms")
    specs, extra_rows, unknown, known_n = build_specs(args.data_root)
    if not specs:
        log(f"[V4_FATAL] 未发现任何会话：{args.data_root}")
        checks.append(("SESSIONS_FOUND", False))
        return finish(log, args, checks, t_start)
    log(f"[v4] 会话 {len(specs)} 条（v2 已知 {known_n}，rglob 新增 {len(extra_rows)}，"
        f"无法判类 {len(unknown)}）")
    checks.append(("SESSIONS_FOUND", len(specs) > 0))
    checks.append(("NO_UNKNOWN_DIR", len(unknown) == 0))

    t0 = time.time()
    qcs = session_qc(specs)
    counts = {v: sum(1 for m in qcs.values() if m["verdict"] == v) for v in ("PASS", "WARN", "FAIL")}
    log(f"[v4] QC 完成，用时 {time.time() - t0:.1f}s；判定 {counts}")
    verdicts = [m["verdict"] for m in qcs.values()]
    checks.append(("QC_ALL_SESSIONS_SCORED", len(qcs) == len(specs)))
    checks.append(("QC_VERDICT_VALID", all(v in qc_clip.VERDICT_RANK for v in verdicts)))

    t0 = time.time()
    ds, n_per = B.build_v2(specs, args.win)
    log(f"[v4] build_v2 完成，用时 {time.time() - t0:.1f}s，窗 {len(ds['y'])} 个")
    checks.append(("WINDOW_CONSERVATION", int(sum(n_per)) == int(len(ds["y"]))))

    t0 = time.time()
    cov = window_covariates(specs, args.win)
    log(f"[v4] 逐窗协变量完成，用时 {time.time() - t0:.1f}s，{len(cov['t0'])} 窗")
    t_ms = np.asarray(ds["meta"]["t_ms"])
    align_ok = (len(cov["t0"]) == len(t_ms)) and bool(np.array_equal(cov["t0"], t_ms))
    if not align_ok:
        log(f"[V4_ERROR] 协变量与窗口错位：cov={len(cov['t0'])} vs t_ms={len(t_ms)}；"
            f"前 5 个 {cov['t0'][:5].tolist()} vs {t_ms[:5].tolist()}")
    checks.append(("COVARIATE_ALIGN", align_ok))

    qc_pass, qc_verdict = vectorize_qc(specs, qcs, n_per)
    meta = ds["meta"]
    meta["density_p50"] = cov["density_p50"]
    meta["active_frames"] = cov["active_frames"]
    meta["swing_px"] = cov["swing_px"]
    meta["qc_pass"] = qc_pass
    meta["qc_verdict"] = qc_verdict
    meta["scalar_swing_x"] = cov["scalar_swing_x"]
    meta["scalar_horiz"] = cov["scalar_horiz"]
    for f in COV_FIELDS:
        assert len(meta[f]) == len(ds["y"]), f
    checks.append(("COVARIATE_LENGTHS", all(len(meta[f]) == len(ds["y"]) for f in COV_FIELDS)))

    ok, problems, _, _, _ = B.session_split_check(meta)
    log(f"[v4] SESSION_SPLIT_PASS={1 if ok else 0}" + ("" if ok else f" problems={problems}"))
    checks.append(("SESSION_SPLIT_PASS", ok))

    before = class_counts(ds["y"])
    after = class_counts(np.asarray(ds["y"])[qc_pass == 1])
    log(f"[v4] 过滤前类别窗数 {before}；只保留 qc_pass 窗后 {after}")
    checks.append(("CLASS2_ALIVE_IN_FULL", before[2] > 0))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    npz_path = out_dir / args.npz
    t0 = time.time()
    E.save_dataset(ds, str(npz_path))
    log(f"[v4] 写出 {npz_path} size={npz_path.stat().st_size} 用时 {time.time() - t0:.1f}s")

    # 读回校验：npz 必须含全部必需字段、形状/dtype 正确、协变量逐窗对齐。
    reread_ok = True
    with np.load(npz_path, allow_pickle=False) as z:
        keys = set(z.files)
        missing = [k for k in REQUIRED_KEYS if k not in keys]
        if missing:
            reread_ok = False
            log(f"[V4_ERROR] npz missing keys: {missing}")
        if z["X_counts"].shape[1:] != (4, E.GRID_H, E.GRID_W):
            reread_ok = False
            log(f"[V4_ERROR] X_counts shape {z['X_counts'].shape}")
        if str(z["X_q"].dtype) != "int8" or len(z["y"]) != len(ds["y"]):
            reread_ok = False
            log("[V4_ERROR] X_q dtype / y length")
        if not np.array_equal(np.asarray(z["t_ms"]), cov["t0"]):
            reread_ok = False
            log("[V4_ERROR] npz t_ms 与协变量 t0 不一致")
        for f in COV_FIELDS:
            if f in keys and len(z[f]) != len(z["y"]):
                reread_ok = False
                log(f"[V4_ERROR] {f} len {len(z[f])} != {len(z['y'])}")
    checks.append(("NPZ_FIELDS_OK", reread_ok))

    report_path = out_dir / args.report
    stride_ms = int(np.asarray(meta["stride_ms"]).reshape(-1)[0])
    t0 = time.time()
    build_report(report_path, args.data_root, args.win, stride_ms, specs, qcs, extra_rows,
                 unknown, known_n, ds, npz_path, cov, checks, log)
    log(f"[v4] 写出 {report_path} size={report_path.stat().st_size} 用时 {time.time() - t0:.1f}s")
    report_text = report_path.read_text(encoding="utf-8")
    report_ok = all(f in report_text for f in COV_FIELDS)
    need_warn = any(before[c] > 0 and after[c] == 0 for c in (0, 1, 2))
    zero_warn = any(f"红字警告：class{c}" in report_text for c in (0, 1, 2)
                    if before[c] > 0 and after[c] == 0)
    checks.append(("REPORT_HAS_COVARIATES", report_ok))
    checks.append(("REPORT_ZERO_CLASS_WARNING", (not need_warn) or zero_warn))
    log(f"[v4] 报告协变量字段={1 if report_ok else 0} 归零警告="
        f"{(1 if zero_warn else 0) if need_warn else 'n/a'}")

    return finish(log, args, checks, t_start)


def finish(log, args, checks, t_start):
    ok = all(good for _, good in checks)
    log("")
    log("[v4] 自检汇总：")
    for name, good in checks:
        log(f"  - {name} = {1 if good else 0}")
    log(f"[v4] 总用时 {time.time() - t_start:.1f}s")
    verdict = "V4_OK=1" if ok else "V4_OK=0"
    log(verdict)
    ev = Path(args.out_dir) / args.evidence
    ev.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        verdict,
        "# task-19 判据 V4_OK —— 数据集 v4（v3 构建逻辑 + QC 协变量，QC 只作协变量不作硬过滤）",
        f"# 时间：{time.strftime('%Y-%m-%d %H:%M:%S %z')}",
        "# cwd：E:/workspace/FPGA_Comp/nn",
        "# PY ：E:/workspace/FPGA_Comp/nn/.venv/Scripts/python.exe（Python 3.12.14, numpy 2.5.4）",
        "# 命令：python build_dataset_v4.py",
        "# 说明：阈值只来自 qc_clip.DEFAULT_THRESHOLDS（import 复用，无第二套阈值）；",
        "#       运动公式只来自 qc_clip.motion_features（QC 整段与逐窗共用）。",
        "#",
    ]
    ev.write_text("\n".join(lines + log.lines) + "\n", encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
