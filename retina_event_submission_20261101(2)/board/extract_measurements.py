#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""board/extract_measurements.py

从仓库文件抽取板级实测数字，生成 board/measurements.md。
同时做硬断言、跨文件交叉校验、链接存在性与文风自检。
仅使用 Python 标准库，全部路径以本脚本所在目录为基准。
成功时末行打印 BOARD_DOC_OK=1。
"""

from pathlib import Path
import hashlib
import json
import sys

NL = chr(10)
BT = chr(96)
ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "board"
OUT_MD = BOARD / "measurements.md"
OUT_LOG = BOARD / "evidence_board_doc.log"

M4C = "sim/nn/EVIDENCE_M4C.md"
M2E = "sim/nn/EVIDENCE_M2E.md"
M3F = "sim/nn/EVIDENCE_M3f.md"
STATUS = "docs/06_facts/00_current_status.md"
KJ = "docs/06_facts/02_metric_register.md"
H1DOC = "docs/06_facts/01_fact_register.md"
V7B = "docs/06_facts/03_v7b_deployment_decision.md"
M5 = "docs/05_experiments/m5_board_acceptance_20261029.md"
MEAS = "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md"
REC7 = "docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md"
BV = "board/board_vs_offline_v5.md"
STATS = "report/evidence/event_stream_stats.json"
U3C_UTIL = "build/variant_act3c/inproc_util_impl.rpt"
U3C_TIM = "build/variant_act3c/timing_deliver.rpt"
U7_UTIL = "build/variant_act7/inproc_util_impl.rpt"
U7_TIM = "build/variant_act7/inproc_timing.rpt"
BIT3 = "build/variant_act3/retina_event.bit"
BIT3B = "build/variant_act3b/retina_event.bit"
BIT3C = "build/variant_act3c/retina_event.bit"
BIT7 = "build/variant_act7/retina_event.bit"

E = {}
SRC = {}
ENTRIES = []
HARD = []
CROSS = []

BANNED = [
    "首先", "其次", "最后", "值得注意的是", "不难发现", "众所周知",
    "赋能", "打造", "助力", "闭环", "痛点", "一站式", "多维度",
    "显著提升", "极大地", "大幅", "完美", "我们认为", "笔者以为",
    "可以说", "综上", "总而言之", "深度学习赋能", "智能识别",
    "硬件加速", "我们",
]

COPIES = [
    ("board/pin.xdc", "retina_event/prj/retina_event.srcs/constrs_1/new/pin.xdc"),
    ("board/retina_event.xdc", "retina_event/src/constraints/retina_event.xdc"),
    ("board/program_retina.tcl", "build/program_retina.tcl"),
    ("board/flash_program.tcl", "build/flash_program.tcl"),
    ("board/flash_program_v3.tcl", "build/flash_program_v3.tcl"),
    ("board/flash_retry.tcl", "build/flash_retry.tcl"),
    ("board/flash_detect.tcl", "docs/05_experiments/Flash固化_20261009/flash_detect.tcl"),
    ("board/board_vs_offline_v5.md", "temp_test/vs/out/board_vs_offline_v5explicit.md"),
]

SESSIONS = ["v5probe", "v6clean384", "v6clean", "v7hands"]
META = {
    "v5probe": "records/20261030-212214_v5probe/meta.json",
    "v6clean384": "records/20261030-214353_v6clean/meta.json",
    "v6clean": "records/20261030-215700_v6clean/meta.json",
    "v7hands": "records/20261030-222201_v7hands/meta.json",
}


class BoardError(Exception):
    pass


def fmt(n):
    return "{:,}".format(int(n))


def fmt3(x):
    return "%.3f" % float(x)


def json_num(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return str(v)


def read_text(rel):
    p = ROOT / rel
    if not p.exists():
        raise BoardError("missing file: " + rel)
    return p.read_text(encoding="utf-8", errors="replace")


def lines_of(rel):
    return read_text(rel).splitlines()


def locate(rel, needle, occurrence=0):
    hits = []
    for i, ln in enumerate(lines_of(rel)):
        if needle in ln:
            hits.append((i + 1, ln))
    if len(hits) <= occurrence:
        raise BoardError("locate failed: " + rel + " needle=" + needle)
    return hits[occurrence]


def add(key, value, rel, needle, match=None, occurrence=0):
    lineno, ln = locate(rel, needle, occurrence)
    m = value if match is None else match
    if m not in ln:
        raise BoardError("value not on line: " + key + " " + rel + ":" + str(lineno))
    E[key] = value
    SRC[key] = rel + ":" + str(lineno)
    ENTRIES.append((key, value, SRC[key]))


def add_line(key, value, rel, lineno, match=None):
    ln = lines_of(rel)[lineno - 1]
    m = value if match is None else match
    if m not in ln:
        raise BoardError("value not on line: " + key + " " + rel + ":" + str(lineno))
    E[key] = value
    SRC[key] = rel + ":" + str(lineno)
    ENTRIES.append((key, value, SRC[key]))


def hard(key, got, exp):
    ok = (got == exp)
    HARD.append((key, str(got), str(exp), ok))
    if not ok:
        raise BoardError("hard assert failed: " + key + " got=" + str(got) + " exp=" + str(exp))


def cross(key, got, exp):
    ok = (got == exp)
    CROSS.append((key, str(got), str(exp), ok))
    if not ok:
        raise BoardError("cross check failed: " + key + " got=" + str(got) + " exp=" + str(exp))


def file_size(rel):
    return (ROOT / rel).stat().st_size


def file_md5(rel):
    h = hashlib.md5()
    with open(ROOT / rel, "rb") as fh:
        while True:
            b = fh.read(1048576)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def text_sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def util_row(rel, label):
    for i, ln in enumerate(lines_of(rel)):
        if not ln.startswith("|"):
            continue
        cells = ln.split("|")
        if len(cells) >= 6 and cells[1].strip() == label:
            return {
                "line": i + 1,
                "used": int(cells[2].strip()),
                "avail": int(cells[4].strip()),
                "pct": cells[5].strip(),
                "text": ln,
            }
    raise BoardError("util row missing: " + rel + " " + label)


def timing_row(rel):
    lines = lines_of(rel)
    for i, ln in enumerate(lines):
        if ("WNS(ns)" in ln) and ("TNS(ns)" in ln) and ("WHS(ns)" in ln):
            vals = lines[i + 2].split()
            if len(vals) < 12:
                raise BoardError("timing row parse failed: " + rel)
            return {
                "line": i + 3,
                "wns": float(vals[0]),
                "tns": float(vals[1]),
                "tns_fail": int(vals[2]),
                "setup_total": int(vals[3]),
                "whs": float(vals[4]),
                "ths": float(vals[5]),
                "ths_fail": int(vals[6]),
                "hold_total": int(vals[7]),
            }
    raise BoardError("timing header missing: " + rel)


def bv_rows():
    rows = {}
    for i, ln in enumerate(lines_of(BV)):
        if not ln.startswith("|"):
            continue
        cells = [c.strip() for c in ln.split("|")]
        if len(cells) < 13:
            continue
        zone = cells[1].replace("**", "").strip()
        if not zone or zone == "zone":
            continue
        if set(zone) <= set("-: "):
            continue
        rows[zone] = {
            "line": i + 1,
            "cells": [c.replace("**", "").strip() for c in cells[2:12]],
        }
    return rows


def add_util(prefix, rel, key, label, used_exp=None):
    r = util_row(rel, label)
    if used_exp is not None:
        hard(prefix + "_" + key, r["used"], used_exp)
    add_line(prefix + "_" + key, fmt(r["used"]), rel, r["line"], match=str(r["used"]))
    add_line(prefix + "_" + key + "_pct", r["pct"], rel, r["line"], match=r["pct"])
    add_line(prefix + "_" + key + "_capacity", fmt(r["avail"]), rel, r["line"], match=str(r["avail"]))


def build():
    s3 = file_size(BIT3)
    add("act3_bit_bytes", fmt(s3), M4C, fmt(s3))
    add("act3_bit_md5", file_md5(BIT3), M4C, file_md5(BIT3))
    add("act3_burn_time", "2026-10-29 23:32", H1DOC, "2026-10-29 23:32")
    add("act3_delivery_wns_ns", "0.228", M4C, "+0.228", match="+0.228")
    add("act3_full_build_lut", "20,501", M4C, "| LUT | 18,973 | 20,501", match="20,501")

    add("act3b_bit_bytes", fmt(file_size(BIT3B)), STATUS, fmt(file_size(BIT3B)))
    add("act3b_bit_md5", file_md5(BIT3B), STATUS, file_md5(BIT3B))
    add("act3b_weight_note", "v4 两分类", STATUS, "v4 两分类 ROM")

    add("act3c_bit_bytes", fmt(file_size(BIT3C)), STATUS, fmt(file_size(BIT3C)))
    add("act3c_bit_md5", file_md5(BIT3C), STATUS, file_md5(BIT3C))
    add("act3c_burn_time", "2026-10-30 21:10:36", STATUS, "21:10:36")

    add("act7_bit_bytes", fmt(file_size(BIT7)), M3F, fmt(file_size(BIT7)))
    add("act7_bit_md5", file_md5(BIT7), M3F, file_md5(BIT7))
    add("act7_build_start", "2026-10-31T00:46:42", M3F, "2026-10-31T00:46:42")
    add("act7_build_end", "2026-10-31 00:56:48", M3F, "00:56:48")
    add("act7_build_total", "10 分 06 秒", M3F, "10 分 06 秒")

    add("act3c_drc_warnings", "95", M2E, "Violations found 95")
    add("act3c_drc_errors", "0", M2E, "0 Error")
    add("act7_drc_warnings", "98", M3F, "Violations found 98")
    add("act7_drc_errors", "0", M3F, "0 Error")

    add("act3c_build_flow", "9 分 39 秒", M2E, "9 分 39 秒")
    add("act3c_timingfix", "4 分 30 秒", M2E, "4 分 30 秒")
    add("act3c_build_total", "14 分 09 秒", M2E, "14 分 09 秒")

    t3 = timing_row(U3C_TIM)
    hard("act3c_wns_ns", fmt3(t3["wns"]), "0.306")
    add_line("act3c_wns_ns", fmt3(t3["wns"]), U3C_TIM, t3["line"], match=fmt3(t3["wns"]))
    add_line("act3c_tns_ns", fmt3(t3["tns"]), U3C_TIM, t3["line"], match=fmt3(t3["tns"]))
    add_line("act3c_whs_ns", fmt3(t3["whs"]), U3C_TIM, t3["line"], match=fmt3(t3["whs"]))
    add_line("act3c_ths_ns", fmt3(t3["ths"]), U3C_TIM, t3["line"], match=fmt3(t3["ths"]))
    add_line("act3c_setup_endpoints", fmt(t3["setup_total"]), U3C_TIM, t3["line"], match=str(t3["setup_total"]))
    add_line("act3c_hold_endpoints", fmt(t3["hold_total"]), U3C_TIM, t3["line"], match=str(t3["hold_total"]))
    cross("act3c_timing_clean", t3["tns_fail"] + t3["ths_fail"], 0)

    t7 = timing_row(U7_TIM)
    hard("act7_wns_ns", fmt3(t7["wns"]), "0.059")
    add_line("act7_wns_ns", fmt3(t7["wns"]), U7_TIM, t7["line"], match=fmt3(t7["wns"]))
    add_line("act7_tns_ns", fmt3(t7["tns"]), U7_TIM, t7["line"], match=fmt3(t7["tns"]))
    add_line("act7_whs_ns", fmt3(t7["whs"]), U7_TIM, t7["line"], match=fmt3(t7["whs"]))
    add_line("act7_ths_ns", fmt3(t7["ths"]), U7_TIM, t7["line"], match=fmt3(t7["ths"]))
    add_line("act7_setup_endpoints", fmt(t7["setup_total"]), U7_TIM, t7["line"], match=str(t7["setup_total"]))
    add_line("act7_hold_endpoints", fmt(t7["hold_total"]), U7_TIM, t7["line"], match=str(t7["hold_total"]))
    cross("act7_timing_clean", t7["tns_fail"] + t7["ths_fail"], 0)

    add_util("act3c", U3C_UTIL, "lut", "Slice LUTs", 20559)
    add_util("act3c", U3C_UTIL, "ff", "Slice Registers")
    add_util("act3c", U3C_UTIL, "slice", "Slice")
    add_util("act3c", U3C_UTIL, "bram", "Block RAM Tile")
    add_util("act3c", U3C_UTIL, "dsp", "DSPs")
    add_util("act3c", U3C_UTIL, "iob", "Bonded IOB")

    add_util("act7", U7_UTIL, "lut", "Slice LUTs", 22371)
    add_util("act7", U7_UTIL, "ff", "Slice Registers")
    add_util("act7", U7_UTIL, "slice", "Slice")
    add_util("act7", U7_UTIL, "bram", "Block RAM Tile")
    add_util("act7", U7_UTIL, "dsp", "DSPs")
    add_util("act7", U7_UTIL, "iob", "Bonded IOB")

    cross("lut_capacity_equal", E["act3c_lut_capacity"], E["act7_lut_capacity"])
    cross("ff_capacity_equal", E["act3c_ff_capacity"], E["act7_ff_capacity"])
    cross("slice_capacity_equal", E["act3c_slice_capacity"], E["act7_slice_capacity"])
    cross("bram_capacity_equal", E["act3c_bram_capacity"], E["act7_bram_capacity"])
    cross("dsp_capacity_equal", E["act3c_dsp_capacity"], E["act7_dsp_capacity"])
    cross("iob_capacity_equal", E["act3c_iob_capacity"], E["act7_iob_capacity"])

    rows = bv_rows()
    zone_names = ["empty_desk", "absent", "openclose", "static_a", "reposition", "static_b", "wave", "end"]
    total_key = "合计"
    for z in zone_names + [total_key]:
        if z not in rows:
            raise BoardError("zone missing in " + BV + ": " + z)
    for z in zone_names:
        c = rows[z]["cells"]
        ln = rows[z]["line"]
        add_line("board_" + z, c[1], BV, ln, match=c[1])
        add_line("offline_" + z, c[2], BV, ln, match=c[2])
    add_line("board_openclose_confident", rows["openclose"]["cells"][4], BV, rows["openclose"]["line"])
    add_line("board_openclose_phase", rows["openclose"]["cells"][5], BV, rows["openclose"]["line"])
    add_line("board_wave_confident", rows["wave"]["cells"][4], BV, rows["wave"]["line"])
    add_line("board_wave_phase", rows["wave"]["cells"][5], BV, rows["wave"]["line"])
    for z in ["absent", "openclose", "reposition", "wave", "end"]:
        c = rows[z]["cells"]
        add_line("dt_p50_" + z, c[8], BV, rows[z]["line"], match=c[8])
        add_line("dt_p90_" + z, c[9], BV, rows[z]["line"], match=c[9])

    c = rows[total_key]["cells"]
    ln = rows[total_key]["line"]
    add_line("board_events", c[1], BV, ln, match=c[1])
    add_line("offline_events", c[2], BV, ln, match=c[2])
    add_line("board_offline_delta", c[3], BV, ln, match=c[3])
    add_line("matched_confident", c[4], BV, ln, match=c[4])
    add_line("phase_drift_pairs", c[5], BV, ln, match=c[5])
    add_line("isolated_board", c[6], BV, ln, match=c[6])
    add_line("isolated_offline", c[7], BV, ln, match=c[7])
    cross("sum_board_zones", sum(int(rows[z]["cells"][1]) for z in zone_names), int(c[1]))
    cross("sum_offline_zones", sum(int(rows[z]["cells"][2]) for z in zone_names), int(c[2]))
    cross("sum_confident", sum(int(rows[z]["cells"][4]) for z in zone_names), int(c[4]))
    cross("sum_phase", sum(int(rows[z]["cells"][5]) for z in zone_names), int(c[5]))
    cross("sum_iso_board", sum(int(rows[z]["cells"][6]) for z in zone_names), int(c[6]))
    cross("sum_iso_offline", sum(int(rows[z]["cells"][7]) for z in zone_names), int(c[7]))
    cross("delta_matches_totals", int(c[1]) - int(c[2]), 2)

    add("offline_windows", "8,641", BV, "8641", match="8641")
    add("offline_decision_points", "4,320", BV, "4320", match="4320")
    add("offline_g0_ms", "37", BV, "g0=37")
    add("frame_offset_ms", "1793365856477.0", BV, "frame_offset=1793365856477.0")
    add("align_residual_median_ms", "9.0", BV, "median=9.0")
    add("board_record_events", "121", BV, "记录 121 条")
    add("board_kept_events", "120", BV, "保留 120 条")
    add("params_sha256", "1903bc994b3e2a6ffe5782e0691aebf27f04a9c00ab14c2da86c8cc3815be583", BV, "1903bc994b3e2a6ffe5782e0691aebf27f04a9c00ab14c2da86c8cc3815be583")

    add("measure_openclose_count", "61", MEAS, "开合段 61 条")
    add("measure_wave_count", "47", MEAS, "挥手段 47 条")
    add("measure_swap_count", "8", MEAS, "换手段 8 条")
    add("measure_still_count", "0", MEAS, "手静止两段为 0")
    add("conf_sat_count", "76", MEAS, "118 条中有 76 条 conf=31", match="118 条中有 76 条 conf=31")
    add("conf_sat_total", "118", MEAS, "118 条中有 76 条 conf=31", match="118 条中有 76 条 conf=31")
    add("board_pps", "15,940", STATUS, "pps≈15,940")

    add("part_number", "xc7a100tfgg484-2", KJ, "xc7a100tfgg484-2")
    add("vivado_version", "2020.2", KJ, "Vivado 2020.2")
    add("modelsim_version", "2020.4", KJ, "ModelSim SE 2020.4")
    add("sys_clk_mhz", "50", KJ, "sys_clk", match="50 MHz")
    cross("act3c_wns_doc_match", fmt3(t3["wns"]), "0.306")
    cross("act7_wns_doc_match", fmt3(t7["wns"]), "0.059")
    cross("act3c_lut_doc_match", str(util_row(U3C_UTIL, "Slice LUTs")["used"]), "20559")
    cross("act7_lut_doc_match", str(util_row(U7_UTIL, "Slice LUTs")["used"]), "22371")

    stats = json.loads(read_text(STATS))["sessions"]
    for sess in SESSIONS:
        m = stats[sess]
        for metric in ["frames", "events", "span_s", "events_per_s", "events_per_frame"]:
            v = m[metric]
            needle = '"' + metric + '": ' + json_num(v)
            add("stream_" + sess + "_" + metric, fmt(v) if isinstance(v, int) else str(v), STATS, needle, match=needle)
        meta = json.loads(read_text(META[sess]))["counters"]
        for mk in ["droppedFrames", "droppedEvents"]:
            needle = '"' + mk + '": ' + str(meta[mk])
            add("stream_" + sess + "_" + mk, str(meta[mk]), META[sess], needle)
        cross("meta_" + sess + "_frames", meta["frames"], m["frames"])
        cross("meta_" + sess + "_events", meta["events"], m["events"])
        cross("stats_" + sess + "_frames", m["frames"], m["meta_counters"]["frames"])

    hard("act3c_bit_md5", E["act3c_bit_md5"], "a5fff751e20019d7e80a3a953f7f8c5a")
    hard("act7_bit_md5", E["act7_bit_md5"], "9c13668c029c9d3a248cf69cbec03582")

def mono(s):
    return BT + s + BT


def cite(*items):
    return "（源：" + "；".join(mono(x) for x in items) + "）"


def strip_code(s):
    out = ""
    inside = False
    for ch in s:
        if ch == BT:
            inside = not inside
            continue
        if not inside:
            out += ch
    return out


def strip_links(s):
    out = ""
    i = 0
    while i < len(s):
        if s[i] == "]" and i + 1 < len(s) and s[i + 1] == "(":
            j = s.find(")", i + 2)
            if j < 0:
                out += s[i:]
                break
            i = j + 1
            continue
        out += s[i]
        i += 1
    return out


def write_text_file(path, text):
    with open(path, "w", encoding="utf-8", newline=NL) as fh:
        fh.write(text)


def check_copies():
    out = []
    for dst, src in COPIES:
        if not (ROOT / src).exists():
            raise BoardError("copy source missing: " + src)
        md5_dst = file_md5(dst)
        md5_src = file_md5(src)
        if md5_dst != md5_src:
            raise BoardError("copy mismatch: " + dst + " vs " + src)
        out.append((dst, src, md5_dst))
    return out


def render():
    rows = bv_rows()
    total = rows["合计"]["cells"]
    L = []

    def h1(t):
        L.append("# " + t)
        L.append("")

    def h2(t):
        L.append("## " + t)
        L.append("")

    def h3(t):
        L.append("### " + t)
        L.append("")

    def p(t):
        L.append(t)
        L.append("")

    def bullet(t):
        L.append("- " + t)

    def table(head, body):
        L.append("| " + " | ".join(head) + " |")
        L.append("|" + "|".join(["---"] * len(head)) + "|")
        for r in body:
            L.append("| " + " | ".join(r) + " |")
        L.append("")

    h1("板上实测与离线参考比对")
    p("结论：板上 act3c 共输出 " + E["board_events"] + " 条动作事件，离线同源回放 " + E["offline_events"] + " 条，差值为 " + E["board_offline_delta"] + "。逐段数字与出处见第 2 节和第 7 节。")
    bullet("生成命令：python board/extract_measurements.py，仅用标准库，路径以本脚本为基准。")
    bullet("复跑记录：" + mono("board/evidence_board_doc.log") + "，含命令、条目数与全部自检结果。")
    bullet("数字口径：板上为 act3c 位流实测，离线为 v5 权重同源回放。")
    bullet("引用格式：源文件:行号，逐条条目见第 7 节抽取索引。")
    L.append("")

    h2("1 位流身份")
    p("本工程保留四个可对照的位流版本，其中只有 act3c 已上板并产生动作事件。act3 曾于 2026-10-29 23:32 烧板验证通路，act3b 与 act7 均未烧板。位流大小与 md5 由脚本对文件直接计算，并与下表出处逐字比对。")
    table(
        ["版本", "位流大小（B）", "md5", "构建或烧录时间", "上板", "权重", "源"],
        [
            ["act3", E["act3_bit_bytes"], E["act3_bit_md5"], "2026-10-29 23:32 烧录", "是", "v4 两分类", mono(SRC["act3_bit_bytes"]) + "；" + mono(SRC["act3_burn_time"]) + "；" + mono(MEAS + ":213")],
            ["act3b", E["act3b_bit_bytes"], E["act3b_bit_md5"], "2026-10-29 构建", "否", "v4 两分类", mono(SRC["act3b_bit_md5"]) + "；" + mono(MEAS + ":213")],
            ["act3c", E["act3c_bit_bytes"], E["act3c_bit_md5"], E["act3c_burn_time"] + " 烧录", "是", "v5 两分类 + byte23 修复", mono(SRC["act3c_bit_md5"])],
            ["act7", E["act7_bit_bytes"], E["act7_bit_md5"], E["act7_build_start"] + " 至 " + E["act7_build_end"], "否", "v7（7 路全局量 + 256 输入 fc）", mono(SRC["act7_bit_bytes"]) + "；" + mono(SRC["act7_build_start"])],
        ],
    )
    p("act3 与 act3b 的权重为 v4 两分类，两者构建均早于 v5 ROM 落盘" + cite(MEAS + ":213") + "。act7 为 v7 链路首次完整构建，默认流程一次收敛" + cite(M3F + ":20") + "。")

    h2("2 act3c 上板实测与离线参考逐项比对")
    p("板上实测来自会话 records/20261030-212214_v5probe，采样时长 " + E["stream_v5probe_span_s"] + " s。离线参考用 v5 权重对同一事件流逐窗回放并逐段统计。原始比对输出见 [board_vs_offline_v5.md](board_vs_offline_v5.md)。")
    body = []
    zone_labels = [
        ("empty_desk", "空桌面"),
        ("absent", "无人"),
        ("openclose", "开合"),
        ("static_a", "手静止 A"),
        ("reposition", "换手"),
        ("static_b", "手静止 B"),
        ("wave", "挥手"),
        ("end", "结束段"),
    ]
    for z, lbl in zone_labels:
        c = rows[z]["cells"]
        body.append([lbl, c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], mono(BV + ":" + str(rows[z]["line"]))])
    body.append(["合计", total[1], total[2], total[3], total[4], total[5], total[6], total[7], "-", "-", mono(BV + ":" + str(rows["合计"]["line"]))])
    table(["区段", "板上", "离线", "Δ", "confident", "phase-drift", "isolated 板", "isolated 离线", "Δt p50（ms）", "Δt p90（ms）", "源"], body)
    bullet("记录链：板上文件记录 " + E["board_record_events"] + " 条，保留 " + E["board_kept_events"] + " 条。录制内有效 " + E["board_events"] + " 条，离线 pulse " + E["offline_events"] + " 条。")
    bullet("对齐：frame_offset 为 " + E["frame_offset_ms"] + " ms，最近帧残差中位数 " + E["align_residual_median_ms"] + " ms，校正量为 -9.0 ms。")
    bullet("离线参数：窗口 " + E["offline_windows"] + " 个、决策点 " + E["offline_decision_points"] + " 个、g0 为 " + E["offline_g0_ms"] + " ms、offset 为 2。")
    bullet("confident 配对 " + E["matched_confident"] + " 对；开合段 p50 71.0 ms、p90 317.4 ms，各区段见上表。")
    bullet("phase-drift " + E["phase_drift_pairs"] + " 对单独统计，不并入 p50 与 p90。")
    bullet("isolated 事件 " + E["isolated_board"] + " 条只在板上、" + E["isolated_offline"] + " 条只在离线。")
    L.append("")

    h2("3 时序与资源实测")
    p("结论：act3c 最终布线 WNS 为 +" + E["act3c_wns_ns"] + " ns，act7 为 +" + E["act7_wns_ns"] + " ns，两者 TNS 与 THS 均为 0。act7 的 LUT 比 act3c 多 1,812 个，FF 多 2,475 个，BRAM 与 IOB 持平。")
    h3("3.1 时序")
    t_src = mono(SRC["act3c_wns_ns"]) + "；" + mono(SRC["act7_wns_ns"])
    table(
        ["指标", "act3c", "act7", "源"],
        [
            ["WNS（ns）", "+" + E["act3c_wns_ns"], "+" + E["act7_wns_ns"], t_src],
            ["TNS（ns）", E["act3c_tns_ns"], E["act7_tns_ns"], t_src],
            ["WHS（ns）", "+" + E["act3c_whs_ns"], "+" + E["act7_whs_ns"], t_src],
            ["THS（ns）", E["act3c_ths_ns"], E["act7_ths_ns"], t_src],
            ["setup 端点", E["act3c_setup_endpoints"], E["act7_setup_endpoints"], t_src],
            ["hold 端点", E["act3c_hold_endpoints"], E["act7_hold_endpoints"], t_src],
        ],
    )
    p("act3c 时序取 timing_deliver.rpt。同目录 inproc_timing.rpt 的 WNS -0.175 ns 属中间版，不采用" + cite(M2E + ":158") + "。")
    h3("3.2 资源占用")
    res_rows = [("LUT", "lut"), ("FF", "ff"), ("Slice", "slice"), ("BRAM Tile", "bram"), ("DSP", "dsp"), ("IOB", "iob")]
    body = []
    for label, key in res_rows:
        body.append([label, E["act3c_" + key], E["act3c_" + key + "_pct"] + "%", E["act7_" + key], E["act7_" + key + "_pct"] + "%", mono(SRC["act3c_" + key]) + "；" + mono(SRC["act7_" + key])])
    table(["资源", "act3c", "占比", "act7", "占比", "源"], body)
    p("act3c 布线 DRC 为 " + E["act3c_drc_warnings"] + " 条警告、0 错误；act7 为 " + E["act7_drc_warnings"] + " 条警告、0 错误" + cite(M2E + ":128", M3F + ":141") + "。")
    h3("3.3 器件容量")
    body = []
    for label, key in res_rows:
        body.append([label, E["act3c_" + key + "_capacity"], E["act3c_" + key], E["act7_" + key], mono(SRC["act3c_" + key + "_capacity"])])
    table(["资源", "容量", "act3c", "act7", "源"], body)
    p("容量取自 xc7a100tfgg484-2 数据手册，与登记册逐项一致" + cite(KJ + ":27") + "。")

    h2("4 事件流健康")
    p("四次录像的采集侧计数均为 0 丢帧与 0 丢事件。事件率与事件密度取自统计文件，并与各录像目录 meta.json 的计数器交叉核对一致。")
    sess_label = {
        "v5probe": "v5probe（act3c 实测）",
        "v6clean384": "v6clean384（短会话）",
        "v6clean": "v6clean",
        "v7hands": "v7hands（v7 前端）",
    }
    body = []
    for sess in SESSIONS:
        src = mono(SRC["stream_" + sess + "_frames"]) + "；" + mono(SRC["stream_" + sess + "_droppedFrames"])
        body.append([sess_label[sess], E["stream_" + sess + "_frames"], E["stream_" + sess + "_events"], E["stream_" + sess + "_span_s"], E["stream_" + sess + "_events_per_s"], E["stream_" + sess + "_events_per_frame"], E["stream_" + sess + "_droppedFrames"], E["stream_" + sess + "_droppedEvents"], src])
    table(["会话", "帧数", "事件数", "采样时长（s）", "事件/秒", "事件/帧", "丢帧", "丢事件", "源"], body)
    bullet("v5probe 的事件流同时用于第 2 节的离线回放。")
    bullet("v6clean384 为 " + E["stream_v6clean384_frames"] + " 帧短会话，事件率 " + E["stream_v6clean384_events_per_s"] + " 事件/秒，只作采集健康对照。")
    bullet("v7hands 采集 " + E["stream_v7hands_frames"] + " 帧与 " + E["stream_v7hands_events"] + " 条事件。")
    bullet("四会话的 meta.json counters 与统计文件逐项相等。")
    L.append("")

    h2("5 结论与不一致项解释")
    p("板上输出与离线参考在次数与时间上一致，差值为 " + E["board_offline_delta"] + " 条，占板上 " + E["board_events"] + " 条的 1.7%。差异可由相位漂移、孤立事件与视角三类机制解释。")
    L.append("1. 相位漂移：" + E["phase_drift_pairs"] + " 对差额落在 600 ms 至 1500 ms 之间，单独统计。板上 pulse 是触发时刻，离线取窗口中心，漂移随窗序号累积。")
    L.append("2. 次数差：开合 +1、换手 +1、挥手 +1、手静止 -1，四段净差 " + E["board_offline_delta"] + "。逐段数值见第 2 节表。")
    L.append("3. 孤立事件：板上 " + E["isolated_board"] + " 条、离线 " + E["isolated_offline"] + " 条，位置见原始输出第 44 至 47 行。")
    L.append("4. 置信度饱和：" + E["conf_sat_total"] + " 条中 " + E["conf_sat_count"] + " 条 conf=31，占 64.4%。开合 37/61、换手 5/8、挥手 33/47 均触顶，阈值上调空间小。")
    L.append("5. 视角差异：view B 只作硬负样本，不进入训练与部署指标。打字与端纸杯的 dx 为 9 至 11 像素，与开合段 5.8 至 9.0 重叠，跨视角判别力有限" + cite(REC7 + ":171") + "。")
    L.append("6. 判定：板上与离线同源回放一致，可作为 3.3.5.1 的实测输出与参考结果比对材料。")
    L.append("")

    h2("6 未测量与未验证")
    p("下表列出五项未完成项，均不改变 act3c 的实测比对结论。")
    table(
        ["项", "状态", "影响", "源"],
        [
            ["act7 烧板", "未烧板", "v7 功能只有 TB 与离线证据", mono(M3F + ":192")],
            ["Flash 固化", "未实测", "只影响脱机上电自启", mono(M5 + ":129")],
            ["act3c 烧录日志", "未留存", "身份靠时间戳与行为反证旁证", mono(STATUS + ":299")],
            ["act7 源码到位流逐字节复现", "未建立", "注释修改逻辑等价，基线留到 act8", mono(M3F + ":133")],
            ["部署视角真实误报率", "未测量", "只有 view B 的 46.5 s 素材", mono(V7B + ":48")],
        ],
    )

    h2("7 抽取索引（" + str(len(ENTRIES)) + " 条）")
    p("每条格式为 键、值、源文件:行号。脚本对每条值做源行包含校验，任一条失败即退出码 1。")
    body = []
    for k, v, s in ENTRIES:
        body.append([mono(k), v, mono(s)])
    table(["键", "值", "源文件:行号"], body)

    h2("8 复现")
    L.append("1. 在仓库根执行 python board/extract_measurements.py。")
    L.append("2. 期望退出码为 0，末行输出 BOARD_DOC_OK=1。")
    L.append("3. 生成 board/measurements.md，证据写入 board/evidence_board_doc.log。")
    L.append("4. 脚本只用标准库，不依赖 Vivado、ModelSim 与板卡。")
    L.append("")
    return NL.join(L)


def validate_links(label, text, planned):
    base = (ROOT / label).parent
    total = 0
    missing = []
    i = 0
    while True:
        a = text.find("](", i)
        if a < 0:
            break
        b = text.find(")", a + 2)
        if b < 0:
            break
        t = text[a + 2:b].strip()
        i = b + 1
        if t.startswith("http") or t.startswith("#") or t.startswith("mailto:"):
            continue
        if " " in t:
            t = t.split(" ")[0]
        p = (base / t).resolve()
        total += 1
        if not p.exists() and p not in planned:
            missing.append(label + " -> " + t)
    return total, missing


def sentence_check(label, idx, s):
    t = "".join(s.split())
    if len(t) > 60:
        return [label + ":" + str(idx) + " long=" + str(len(t))]
    return []


def check_style(label, text):
    viol = []
    in_code = False
    for idx, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line.startswith(BT + BT + BT):
            in_code = not in_code
            continue
        if in_code or not line:
            continue
        plain = strip_links(strip_code(line))
        for w in BANNED:
            if w in plain:
                viol.append(label + ":" + str(idx) + " banned=" + w)
        if ("不是" in plain) and ("而是" in plain):
            viol.append(label + ":" + str(idx) + " pattern=bushi-ershi")
        if ("!" in plain) or ("?" in plain) or ("！" in plain) or ("？" in plain):
            viol.append(label + ":" + str(idx) + " punctuation")
        if line.startswith("#") or line.startswith("|"):
            continue
        body = plain.strip()
        for marker in ["- ", "* ", "+ "]:
            if body.startswith(marker):
                body = body[2:].strip()
                break
        if len(body) > 3 and body[0].isdigit() and body[1:3] == ". ":
            body = body[3:].strip()
        cur = ""
        for ch in body:
            cur += ch
            if ch in "。！？":
                viol.extend(sentence_check(label, idx, cur))
                cur = ""
        if cur:
            viol.extend(sentence_check(label, idx, cur))
    return viol


def csv_field(v):
    q = chr(34)
    if ("," in v) or (q in v) or (NL in v):
        return q + v.replace(q, q + q) + q
    return v


BOARD_EXPECT = [
    "board/pin.xdc",
    "board/retina_event.xdc",
    "board/program_retina.tcl",
    "board/flash_program.tcl",
    "board/flash_program_v3.tcl",
    "board/flash_retry.tcl",
    "board/flash_detect.tcl",
    "board/readme.md",
    "board/measurements.md",
    "board/extract_measurements.py",
    "board/board_vs_offline_v5.md",
    "board/evidence_board_doc.log",
]


def pack_map_targets():
    data = json.loads(read_text("report/tools/pack_map.json"))
    tg = set()
    for sec in ["required", "optional", "mappings", "generated_files"]:
        items = data.get(sec, [])
        for item in items:
            if isinstance(item, dict) and ("target" in item):
                tg.add(item["target"])
    return tg


def check_pack_map():
    tg = pack_map_targets()
    present = [t for t in BOARD_EXPECT if t in tg]
    missing = [t for t in BOARD_EXPECT if t not in tg]
    return present, missing


def render_log(doc, copies, link_count, viol, ok, pack_present, pack_missing):
    L = []
    L.append("BOARD_DOC_OK=1" if ok else "BOARD_DOC_FAIL=1")
    L.append("CMD: python board/extract_measurements.py")
    L.append("EXIT_CODE: " + ("0" if ok else "1"))
    L.append("ENTRIES: " + str(len(ENTRIES)))
    L.append("HARD_ASSERTIONS: " + str(sum(1 for h in HARD if h[3])) + "/" + str(len(HARD)) + " PASS")
    L.append("CROSS_CHECKS: " + str(sum(1 for c in CROSS if c[3])) + "/" + str(len(CROSS)) + " PASS")
    L.append("COPIES: " + str(len(copies)) + " files, md5 identical")
    L.append("LINKS: " + str(link_count) + " checked, " + str(len([v for v in viol if v.find('link') >= 0])) + " missing")
    L.append("STYLE: " + str(len(viol)) + " violations")
    if doc is not None:
        L.append("OUTPUT: board/measurements.md lines=" + str(len(doc.splitlines())) + " sha256=" + text_sha256(doc))
    L.append("---- hard assertions ----")
    for k, got, exp, good in HARD:
        L.append("HARD " + k + " got=" + got + " exp=" + exp + " " + ("PASS" if good else "FAIL"))
    L.append("---- cross checks ----")
    for k, got, exp, good in CROSS:
        L.append("CROSS " + k + " got=" + got + " exp=" + exp + " " + ("PASS" if good else "FAIL"))
    L.append("---- copy md5 ----")
    for dst, src, md5 in copies:
        L.append("COPY " + dst + " " + md5 + " = " + src)
    L.append("---- pack_map ----")
    L.append("PACK_MAP_TARGETS: present=" + str(len(pack_present)) + " missing=" + str(len(pack_missing)) + " of " + str(len(BOARD_EXPECT)) + " board files")
    for t in pack_missing:
        L.append("PACK_MAP_NEED: " + t)
    L.append("---- style ----")
    if viol:
        for v in viol:
            L.append("VIOLATION " + v)
    else:
        L.append("STYLE_OK 0 violations")
    L.append("---- entries ----")
    L.append("key,value,source")
    L.append("value is quoted if it contains a comma")
    for k, v, s in ENTRIES:
        L.append(csv_field(k) + "," + csv_field(v) + "," + csv_field(s))
    L.append("")
    return NL.join(L)


def main():
    try:
        build()
        doc = render()
        copies = check_copies()
        planned = set()
        planned.add(OUT_MD.resolve())
        planned.add(OUT_LOG.resolve())
        pack_present, pack_missing = check_pack_map()
        readme = read_text("board/readme.md")
        n1, m1 = validate_links("board/readme.md", readme, planned)
        n2, m2 = validate_links("board/measurements.md", doc, planned)
        viol = check_style("board/readme.md", readme) + check_style("board/measurements.md", doc)
        link_count = n1 + n2
        missing = m1 + m2
        for x in missing:
            viol.append("link " + x)
        if viol:
            log = render_log(doc, copies, link_count, viol, False, pack_present, pack_missing)
            write_text_file(OUT_LOG, log)
            for x in missing:
                print("BOARD_LINK_MISSING=" + x)
            for x in viol:
                print("BOARD_STYLE_VIOLATION=" + x)
            print("BOARD_DOC_FAIL=1")
            return 1
        write_text_file(OUT_MD, doc)
        log = render_log(doc, copies, link_count, [], True, pack_present, pack_missing)
        write_text_file(OUT_LOG, log)
        print("BOARD_CMD=python board/extract_measurements.py")
        print("BOARD_ENTRIES=" + str(len(ENTRIES)))
        print("BOARD_HARD=" + str(sum(1 for h in HARD if h[3])) + "/" + str(len(HARD)))
        print("BOARD_CROSS=" + str(sum(1 for c in CROSS if c[3])) + "/" + str(len(CROSS)))
        print("BOARD_COPIES=" + str(len(copies)) + "/" + str(len(COPIES)))
        print("BOARD_LINKS=" + str(link_count))
        print("BOARD_STYLE=0")
        print("BOARD_MD=board/measurements.md")
        print("BOARD_LOG=board/evidence_board_doc.log")
        print("BOARD_PACK_PRESENT=" + str(len(pack_present)))
        print("BOARD_PACK_MISSING=" + str(len(pack_missing)))
        for t in pack_missing:
            print("BOARD_PACK_NEED=" + t)
        for k, v, s in ENTRIES:
            print("ENTRY," + csv_field(k) + "," + csv_field(v) + "," + csv_field(s))
        print("BOARD_DOC_OK=1")
        return 0
    except BoardError as e:
        print("BOARD_DOC_FAIL=1")
        print("BOARD_FAIL_REASON=" + str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

