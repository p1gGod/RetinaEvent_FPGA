# -*- coding: utf-8 -*-
"""M9d 评测报告图表生成器：读取仓库源数据/报告 -> report/figures/f*.svg。
运行：nn/.venv/Scripts/python.exe report/figures/make_figures.py
末行输出 FIGURES_OK=1；每个图打印数据点数。
"""
import csv
import json
import math
import os
import re
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
from matplotlib import font_manager
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
FONT = "C:/Windows/Fonts/msyh.ttc"
if Path(FONT).exists():
    font_manager.fontManager.addfont(FONT)
    plt.rcParams["font.family"] = "Microsoft YaHei"
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["font.size"] = 9
C = dict(blue="#2b6cb0", teal="#2c7a7b", orange="#c05621", red="#c53030",
         green="#2f855a", gray="#4a5568", light="#edf2f7", purple="#6b46c1")


def text(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def jload(rel):
    return json.loads(text(rel))


def footer(fig, msg):
    fig.text(0.01, 0.005, "数据来源: " + msg, fontsize=6.8, color="#555555")


def save(fig, name):
    p = OUT / name
    fig.savefig(p, format="svg", bbox_inches="tight")
    if os.environ.get("FIG_PNG"):
        pv = OUT / "preview"
        pv.mkdir(exist_ok=True)
        fig.savefig(pv / (Path(name).stem + ".png"), format="png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    return p


def parse_pipe_rows(textblock):
    rows = []
    for i, line in enumerate(textblock.splitlines(), 1):
        s = line.strip()
        if len(s) >= 2 and s.startswith("|") and s.endswith("|"):
            rows.append((i, [c.strip() for c in s[1:-1].split("|")], s))
    return rows


def find_section(textblock, header):
    # Vivado 报告开头有目录，同一标题在正文再出现一次；取最后一次出现（正文）。
    lines = textblock.splitlines()
    hits = [i for i, l in enumerate(lines) if l.strip() == header]
    if not hits:
        raise ValueError("section %r matched 0 lines" % header)
    start = hits[-1] + 1
    for j in range(start, len(lines)):
        s = lines[j].strip()
        if re.match(r"^#{1,3}\s", s) or re.match(r"^\d+\.\s+\S", s):
            return start, j
    return start, len(lines)


def row_cell(textblock, exact, src="", section=None):
    lines = textblock.splitlines()
    lo, hi = 0, len(lines)
    if section:
        lo, hi = find_section(textblock, section)
    hits = [(i, cells, raw) for (i, cells, raw) in parse_pipe_rows(textblock)
            if lo <= i - 1 < hi and cells and cells[0] == exact]
    if len(hits) != 1:
        detail = "; ".join("%d:%s" % (h[0], h[2][:110]) for h in hits) or "(none)"
        raise ValueError("%s: exact first cell %r matched %d rows -> %s"
                         % (src or "<text>", exact, len(hits), detail))
    return hits[0]


def find_unique_line(textblock, needle, src=""):
    hits = [(i, l) for i, l in enumerate(textblock.splitlines(), 1) if needle in l]
    if len(hits) != 1:
        raise ValueError("%s: needle %r matched %d lines -> %s"
                         % (src, needle, len(hits), [h[0] for h in hits]))
    return hits[0]


def die(msg):
    print("METRIC_CHECK_FAIL " + msg)
    raise SystemExit(1)


def require(label, actual, expected, tol=1e-9):
    try:
        ok = abs(float(actual) - float(expected)) <= tol
    except (TypeError, ValueError):
        ok = False
    if not ok:
        die("%s actual=%r expected=%r" % (label, actual, expected))
    return actual


def assert_source_line(rel, lineno, needle):
    blocks = text(rel).splitlines()
    if lineno < 1 or lineno > len(blocks) or needle not in blocks[lineno - 1]:
        die("source line mismatch %s:%d expected %r" % (rel, lineno, needle))


def _numeric(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    m = re.search(r"[-+]?\d+(?:\.\d+)?", str(value).replace(",", ""))
    return float(m.group()) if m else None


def metric(fig, label, value, source, expected=None):
    if expected is None:
        equal = "CALC"
        exp = ""
    else:
        exp = expected
        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
            num = _numeric(value)
            equal = "YES" if num is not None and abs(num - float(expected)) <= max(1e-9, 1e-6 * abs(float(expected))) else "NO"
        else:
            equal = "YES" if str(value).strip() == str(expected).strip() else "NO"
        if equal == "NO":
            die("metric mismatch %s / %s: value=%r expected=%r" % (fig, label, value, expected))
    METRICS.append((fig, label, str(value), str(exp), source, equal))


def session_stats(sub):
    meta = jload("records/" + sub + "/meta.json")
    chunks = sorted(meta["chunks"], key=lambda c: c["index"])
    frames = 0
    t0 = None
    t1 = None
    ev_bytes = 0
    for ch in chunks:
        with open(ROOT / "records" / sub / ch["frames"], newline="", encoding="utf-8") as f:
            rd = csv.reader(f)
            next(rd)
            n = 0
            for row in rd:
                if row:
                    n += 1
                    t = int(row[1])
                    if t0 is None:
                        t0 = t
                    t1 = t
        frames += n
        ev_bytes += (ROOT / "records" / sub / ch["events"]).stat().st_size
    span = (t1 - t0) / 1000.0
    raw = frames * 800 * 480 * 2
    return dict(sub=sub, frames=frames, events=meta["counters"]["events"],
                span_s=span, fps_eff=(frames - 1) / span,
                ev_per_s=meta["counters"]["events"] / span,
                raw_bytes=raw, ev_csv_bytes=ev_bytes,
                ratio=ev_bytes / raw)


def v7_zone_stats():
    z = jload("report/figures/v7_zones.json")
    zones = z["zones"]
    ends = [q["t1"] for q in zones]
    stats = []
    for q in zones:
        stats.append(dict(name=q["name"], t0=q["t0"], t1=q["t1"], label=q["label"],
                          dur=q["t1"] - q["t0"], ev=0, on=0))
    sub = "20261030-222201_v7hands"
    with open(ROOT / "records" / sub / "chunk-000.frames.csv", newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        next(rd)
        board0 = int(next(rd)[1])
    ev_path = ROOT / "records" / sub / "chunk-000.events.csv"
    if ev_path.exists():
        import bisect
        with open(ev_path, newline="", encoding="utf-8") as f:
            rd = csv.reader(f)
            next(rd)
            for row in rd:
                if not row:
                    continue
                rel = (int(row[1]) - board0) / 1000.0
                i = bisect.bisect_left(ends, rel)
                if i >= len(zones) or rel < zones[i]["t0"]:
                    continue
                stats[i]["ev"] += 1
                if int(row[4]) == 1:
                    stats[i]["on"] += 1
    for s in stats:
        s["rate"] = s["ev"] / s["dur"] if s["dur"] else 0.0
        s["on_ratio"] = s["on"] / s["ev"] if s["ev"] else 0.0
    return stats


SESS = {s["sub"]: s for s in [session_stats(p) for p in
         ["20261030-212214_v5probe", "20261030-214353_v6clean",
          "20261030-215700_v6clean", "20261030-222201_v7hands"]]}
ZONES = v7_zone_stats()
RES = jload("nn/out_v7/results_v7_final.json")
POOL = RES["A_time"]["pooled"]["8"]
POOL_I8 = RES["A_time"]["pooled_int8"]["8"]
BD = RES["B_distance"]
BD8 = BD["eval"]["8"]
M3 = text("sim/nn/EVIDENCE_M3.md")
M3C = text("sim/nn/EVIDENCE_M3c.md")
IMPL = text("build/variant_act3c/inproc_util_impl.rpt")
TIM = text("build/variant_act3c/timing_deliver.rpt")
M0 = text("docs/03_tech/04_action_recognition_selection.md")
V6REP = text("nn/REPORT_v6_表征实验.md")
V7REP = text("nn/REPORT_v7_数据集.md")
M3F = text("sim/nn/EVIDENCE_M3f.md")
SWEEP = jload("nn/out_v7b/s100_threshold_sweep.json")
SWEEP_LINE = {}
_margin = None
for _i, _line in enumerate(text("nn/out_v7b/s100_threshold_sweep.json").splitlines(), 1):
    _m = re.search(r'"margin":\s*(\d+)', _line)
    if _m:
        _margin = int(_m.group(1))
    _n = re.search(r'"n_consec":\s*(\d+)', _line)
    if _n:
        SWEEP_LINE[(_margin, int(_n.group(1)))] = _i - 1
ACT7 = dict(wns=0.059, tns=0.0, whs=0.027, ths=0.0, endpoints=84405,
            lut=22371, lut_pct=35.29, ff=14325, ff_pct=11.30,
            slice=7968, slice_pct=50.27, bram=87, bram_pct=64.44,
            dsp=8, dsp_pct=3.33, iob=140, iob_pct=49.12,
            bit=2835423, build_s=606)
ACT7_SRC = "sim/nn/EVIDENCE_M3f.md"
ACT8 = dict(wns=0.215, tns=0.0, whs=0.017, ths=0.0, endpoints=84390,
            lut=22383, lut_pct=35.30, ff=14325, ff_pct=11.30,
            slice=8026, slice_pct=50.64, bram=86.5, bram_pct=64.07,
            dsp=8, dsp_pct=3.33, iob=140, iob_pct=49.12,
            bit=2839107)
ACT3C_BIT = 2890875
ACT3C_BUILD_S = 579
MEAS = text("docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md")
HOST = text("docs/05_experiments/action_recognition_20261029/report.md")
EVALLOG = text("docs/05_experiments/action_recognition_20261029/EVIDENCE_EVAL.log")
CAPTURE = text("docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md")

m = re.search(r"224,095 拍 @200 MHz = ([0-9.]+) ms", M3)
m2 = re.search(r"440,087 拍 @50 MHz = ([0-9.]+) ms", M3)
m3 = re.search(r"827,154 拍 = ([0-9.]+) ms", M3)
V1_MS = float(m.group(1))
V2_MS = float(m2.group(1))
K6_MS = float(m3.group(1))
CYC = re.search(r"440,087 拍 = 2x208,080（每 MAC 2 拍）\+ 6x3,987（每像素固定开销）\+ 5", M3)
if not CYC:
    raise SystemExit("CYCLE_DECOMP_FAIL")
MAC_CYC = 2 * 208080
PIX_CYC = 6 * 3987
FIX_CYC = 5
m4 = re.search(r"v1 WNS (-?[0-9.]+) ns.*?v2 .*?WNS \+([0-9.]+) ns", M3)
WNS_V1 = float(m4.group(1))
WNS_V2 = float(m4.group(2))
M3C_ROW = row_cell(M3C, "Slice LUTs", "EVIDENCE_M3c.md")
M3C_CELLS = M3C_ROW[1]
LUT_BASE = int(M3C_CELLS[1].replace(",", ""))
LUT_FIN = int(M3C_CELLS[2].replace(",", ""))
LUT_DELTA = int(M3C_CELLS[3].replace("*", "").replace("+", ""))
GU = row_cell(IMPL, "Slice LUTs", "inproc_util_impl.rpt")
GF = row_cell(IMPL, "Slice Registers", "inproc_util_impl.rpt", section="1. Slice Logic")
GS = row_cell(IMPL, "Slice", "inproc_util_impl.rpt", section="2. Slice Logic Distribution")
GB = row_cell(IMPL, "Block RAM Tile", "inproc_util_impl.rpt")
GD = row_cell(IMPL, "DSPs", "inproc_util_impl.rpt")
GI = row_cell(IMPL, "Bonded IOB", "inproc_util_impl.rpt")


def _util(row):
    return (int(row[1][1].replace(",", "")), float(row[1][4]), row[0])


UTIL = dict(lut=_util(GU), ff=_util(GF), slices=_util(GS),
            bram=_util(GB), dsp=_util(GD), iob=_util(GI))

def clock_row(name):
    for line in TIM.splitlines():
        if line.strip().startswith(name):
            toks = line.split()
            if len(toks) < 6:
                continue
            try:
                wns = float(toks[1])
                whs = float(toks[5])
            except ValueError:
                continue
            return dict(wns=wns, whs=whs)
    raise KeyError(name)

def clock_mhz(name):
    for line in TIM.splitlines():
        if line.startswith(name):
            toks = line.split()
            return float(toks[-1])
    raise KeyError(name)

CLK_ETH = clock_row("eth_rxc")
CLK_CAM = clock_row("cam_pclk")
CLK_50 = clock_row("clk_out2_clk_wiz_0")
TSUM_LINE, TSUM_RAW = find_unique_line(TIM, "76854", "timing_deliver.rpt")
TSUM = TSUM_RAW.split()
WNS_FIN = float(TSUM[0])
TNS_FIN = float(TSUM[1])
WHS_FIN = float(TSUM[4])
MIDT = text("build/variant_act3c/inproc_timing.rpt")
MID_LINE, MID_RAW = find_unique_line(MIDT, "76854", "inproc_timing.rpt")
WNS_MID = float(MID_RAW.split()[0])

M0_BASE_SECTION = "## 2. 现有资源基线【实测】"
M0_BUDGET_SECTION = "## 5. 资源预算表（新增引擎）"
M0B_LUT = row_cell(M0, "Slice LUT", "M0 baseline", section=M0_BASE_SECTION)
M0B_FF = row_cell(M0, "Slice Registers (FF)", "M0 baseline", section=M0_BASE_SECTION)
M0B_SL = row_cell(M0, "Slices", "M0 baseline", section=M0_BASE_SECTION)
M0B_BRAM = row_cell(M0, "Block RAM Tile", "M0 baseline", section=M0_BASE_SECTION)
M0B_DSP = row_cell(M0, "DSP48E1", "M0 baseline", section=M0_BASE_SECTION)
M0B_IOB = row_cell(M0, "Bonded IOB", "M0 baseline", section=M0_BASE_SECTION)
BASE_LUT = int(M0B_LUT[1][1].replace(",", ""))
BASE_FF = int(M0B_FF[1][1].replace(",", ""))
BASE_SL = int(M0B_SL[1][1].replace(",", ""))
BASE_BRAM = float(M0B_BRAM[1][1].replace("*", ""))
BASE_DSP = int(M0B_DSP[1][1].replace(",", ""))
BASE_IOB = int(M0B_IOB[1][1].replace(",", ""))
BUD_LUT = row_cell(M0, "Slice LUT", "M0 budget", section=M0_BUDGET_SECTION)
BUD_FF = row_cell(M0, "Slice FF", "M0 budget", section=M0_BUDGET_SECTION)
BUD_SL = row_cell(M0, "Slices", "M0 budget", section=M0_BUDGET_SECTION)
BUD_BRAM = row_cell(M0, "BRAM36 Tile", "M0 budget", section=M0_BUDGET_SECTION)
BUD_DSP = row_cell(M0, "DSP48E1", "M0 budget", section=M0_BUDGET_SECTION)
BUD_IOB = row_cell(M0, "IOB", "M0 budget", section=M0_BUDGET_SECTION)


def _delta(cells):
    return int(cells[3].replace("*", "").replace("+", "").replace(",", ""))


BUDGET_DELTA = dict(lut=_delta(BUD_LUT[1]), ff=_delta(BUD_FF[1]), slices=_delta(BUD_SL[1]),
                    bram=_delta(BUD_BRAM[1]), dsp=_delta(BUD_DSP[1]), iob=_delta(BUD_IOB[1]))

V6_SECTION = "## 4. 主结果（留出集，线上 8/3 档；int8 一致率为标定 1024 窗）"
V6_C3 = row_cell(V6REP, "c3_shift", "REPORT_v6", section=V6_SECTION)
V6_C5 = row_cell(V6REP, "**c5_shift_glob**", "REPORT_v6", section=V6_SECTION)
V5_WAVE_LINE, V5_WAVE_RAW = find_unique_line(
    MEAS, "| 挥手 | 1,860 | **0.652**", "MEASURE_v5")
WAVE_HIT_V5 = float(re.search(r"\*\*([0-9.]+)\*\*", V5_WAVE_RAW).group(1))
V5_OPEN_LINE, _ = find_unique_line(MEAS, "open_chunks=24/24", "MEASURE_v5")
OPEN_V5 = 1.0
WAVE_HIT_C3 = float(V6_C3[1][6])
WAVE_HIT_C5 = float(V6_C5[1][6].replace("*", ""))
OPEN_C3 = float(V6_C3[1][4].replace("*", "").split("/")[0]) / 24.0
OPEN_C5 = float(V6_C5[1][4].replace("*", "").split("/")[0]) / 24.0
OPEN_V7 = POOL["open_recall"]
WAVE_HIT_V7 = POOL["wave_window_hit_ratio"]
GRP = POOL["groups"]
HARD_MIN = float(GRP["hardneg"]["minutes"])
HARD_RATE = float(GRP["hardneg"]["pulses_per_min"])
OPEN_RATE = float(GRP["open"]["pulses_per_min"])
WAVE_RATE = float(GRP["wave"]["pulses_per_min"])
STATIC_RATE = float(GRP["static"]["pulses_per_min"])
EMPTY_RATE = float(GRP["empty"]["pulses_per_min"])
m5 = re.search(r"匹配延迟: n=4 min=[0-9.]+ mean=[0-9.]+ p50=([0-9.]+) p95=([0-9.]+)", EVALLOG)
LAT_P50 = float(m5.group(1))
LAT_P95 = float(m5.group(2))
HOST638 = re.search(r"npm test.\s*638/638（28 suites", HOST)
if not HOST638:
    raise SystemExit("HOST_COUNT_FAIL")
FPS_V7 = SESS["20261030-222201_v7hands"]["fps_eff"]
FRAME_LATCH_MS = 1000.0 / FPS_V7
REPORTED = []
METRICS = []
EVSTREAM = jload("report/evidence/event_stream_stats.json")
EV_SESS = EVSTREAM["sessions"]
EV_ZONE = {z["name"]: z for z in EVSTREAM["v7_zones"]}

# ---- 口径断言（与 docs/06_facts/02_metric_register.md 一致）----
REG = text("docs/06_facts/02_metric_register.md")
for _needle in ["LUT 20,559（32.43%）", "FF 11,850（9.35%）", "Slice 7,327（46.23%）",
                "BRAM 87（64.44%）", "DSP 7（2.92%）", "IOB 140（49.12%）",
                "WNS `+0.306 ns`", "TNS 0", "WHS `+0.036 ns`"]:
    if _needle not in REG:
        die("registry missing %r" % _needle)
require("util.lut used", UTIL["lut"][0], 20559)
require("util.lut pct", UTIL["lut"][1], 32.43)
require("util.ff used", UTIL["ff"][0], 11850)
require("util.ff pct", UTIL["ff"][1], 9.35)
require("util.slice used", UTIL["slices"][0], 7327)
require("util.slice pct", UTIL["slices"][1], 46.23)
require("util.bram used", UTIL["bram"][0], 87)
require("util.bram pct", UTIL["bram"][1], 64.44)
require("util.dsp used", UTIL["dsp"][0], 7)
require("util.dsp pct", UTIL["dsp"][1], 2.92)
require("util.iob used", UTIL["iob"][0], 140)
require("util.iob pct", UTIL["iob"][1], 49.12)
require("timing.wns", WNS_FIN, 0.306)
require("timing.tns", TNS_FIN, 0.0)
require("timing.whs", WHS_FIN, 0.036)
require("timing.mid_wns", WNS_MID, -0.175)
require("m3c.lut_base", LUT_BASE, 21518)
require("m3c.lut_fin", LUT_FIN, 21913)
require("m3c.lut_delta", LUT_DELTA, 395)
require("m0.baseline.lut", BASE_LUT, 18973)
require("m0.baseline.ff", BASE_FF, 11296)
require("m0.baseline.slices", BASE_SL, 6721)
require("m0.baseline.bram", BASE_BRAM, 77.5)
require("m0.baseline.dsp", BASE_DSP, 6)
require("m0.baseline.iob", BASE_IOB, 140)
for _k, _v in [("lut", 2800), ("ff", 3200), ("slices", 800), ("bram", 7), ("dsp", 8), ("iob", 0)]:
    require("m0.budget." + _k, BUDGET_DELTA[_k], _v)
require("m3c.cycle", MAC_CYC + PIX_CYC + FIX_CYC, 440087)
require("v6.c3.wave_hit", WAVE_HIT_C3, 0.0817)
require("v6.c5.wave_hit", WAVE_HIT_C5, 0.0575)
require("v6.c3.open_chunks", OPEN_C3, 1.0)
require("v6.c5.open_chunks", OPEN_C5, 1.0)
require("v5.wave_hit", WAVE_HIT_V5, 0.652)
require("v7.open_recall", OPEN_V7, 0.9412)
require("v7.wave_hit", WAVE_HIT_V7, 0.0098)
require("v7.hardneg.rate", HARD_RATE, 1.212)
require("v7.group.open", GRP["open"]["n_windows"], 1560)
require("v7.group.wave", GRP["wave"]["n_windows"], 1020)
require("v7.group.static", GRP["static"]["n_windows"], 400)
require("v7.group.empty", GRP["empty"]["n_windows"], 619)
require("v7.group.hardneg", GRP["hardneg"]["n_windows"], 990)
assert_source_line("nn/REPORT_v7_数据集.md", 38, "y0=2,009 / y1=1,560 / y2=1,020（合计 4,589）")
assert_source_line("nn/REPORT_v7_数据集.md", 41, "5,067 / 5,480 / 3,900")
assert_source_line("nn/out_v7/results_v7_final.json", 4673, '"minutes": 1.3')
assert_source_line("nn/out_v7/results_v7_final.json", 4676, '"pulses_per_min": 30.769')
assert_source_line("nn/out_v7/results_v7_final.json", 4641, '"wave_minutes": 0.85')
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["lut"][2], "Slice LUTs")
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["ff"][2], "Slice Registers")
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["slices"][2], "| Slice ")
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["bram"][2], "Block RAM Tile")
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["dsp"][2], "DSPs")
assert_source_line("build/variant_act3c/inproc_util_impl.rpt", UTIL["iob"][2], "Bonded IOB")
assert_source_line("build/variant_act3c/timing_deliver.rpt", TSUM_LINE, "0.306")
assert_source_line("build/variant_act3c/inproc_timing.rpt", MID_LINE, "-0.175")
assert_source_line("docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", V5_WAVE_LINE, "0.652")
assert_source_line("docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", V5_OPEN_LINE, "24/24")
assert_source_line("nn/REPORT_v6_表征实验.md", V6_C3[0], "c3_shift")
assert_source_line("nn/REPORT_v6_表征实验.md", V6_C5[0], "c5_shift_glob")
assert_source_line("nn/out_v7/results_v7_final.json", 4637, '"open_recall": 0.9412')
assert_source_line("nn/out_v7/results_v7_final.json", 4643, '"wave_window_hit_ratio": 0.0098')
assert_source_line("nn/out_v7/results_v7_final.json", 4773, '"minutes": 0.8251')
assert_source_line("nn/out_v7/results_v7_final.json", 4776, '"pulses_per_min": 1.212')
assert_source_line("sim/nn/EVIDENCE_M3f.md", 15, "WNS +0.059")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 57, "84,405")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 108, "22,371")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 111, "14,325")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 112, "7,968")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 113, "Block RAM Tile")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 116, "DSPs")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 117, "Bonded IOB")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 128, "2,835,423")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 129, "9c13668c029c9d3a248cf69cbec03582")
assert_source_line("sim/nn/EVIDENCE_M3f.md", 42, "10 分 06 秒")
assert_source_line("nn/out_v7b/s100_threshold_sweep.json", 3, '"margin": 8')
assert_source_line("nn/out_v7b/s100_threshold_sweep.json", 75, '"margin": 16')
assert_source_line("nn/out_v7b/s100_threshold_sweep.json", 123, '"margin": 24')
assert_source_line("docs/06_facts/02_metric_register.md", 19, "2,835,423")
assert_source_line("docs/06_facts/02_metric_register.md", 35, "+0.059")
assert_source_line("docs/06_facts/02_metric_register.md", 36, "22,371")
assert_source_line("docs/06_facts/00_current_status.md", 28, "2,890,875")

# v7b s100 summary and act8 build artifacts
_V7B_REP = "nn/REPORT_v7b_部署口径重训.md"
_ACT8_EV = "report/evidence/act8_artifacts.txt"
assert_source_line(_V7B_REP, 210, "| open 块 | 17/18 | 17/17 | 17/17 |")
assert_source_line(_V7B_REP, 212, "| wave pulse | 1 | 5 | 1 |")
assert_source_line(_V7B_REP, 213, "| hardneg pulse | 3 | 5 | 2 |")
assert_source_line(_V7B_REP, 216, "| 总 pulse | 67 | 97 | 74 |")
assert_source_line(_V7B_REP, 245, "0.9299")
assert_source_line(_ACT8_EV, 4, "2839107")
assert_source_line(_ACT8_EV, 5, "5ec55ec07c44f2503df63f1bb160a6e6")
assert_source_line(_ACT8_EV, 7, "0.215")
assert_source_line(_ACT8_EV, 14, "22383 35.30")
assert_source_line(_ACT8_EV, 15, "14325 11.30")
assert_source_line(_ACT8_EV, 16, "8026 50.64")
assert_source_line(_ACT8_EV, 17, "86.5 64.07")
assert_source_line(_ACT8_EV, 18, "8 3.33")
assert_source_line(_ACT8_EV, 19, "140 49.12")

# ---- METRIC 表：每张图用到的数字 -> 源文件:行号 ----
_IMPL = "build/variant_act3c/inproc_util_impl.rpt"
_TIM = "build/variant_act3c/timing_deliver.rpt"
_V7JSON = "nn/out_v7/results_v7_final.json"
_V7REP = "nn/REPORT_v7_数据集.md"
_MEAS = "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md"
M0_RES = "docs/03_tech/04_action_recognition_selection.md"
M3_SRC = "sim/nn/EVIDENCE_M3.md"
M3C_SRC = "sim/nn/EVIDENCE_M3c.md"

def reg(tag, n, path):
    REPORTED.append((tag, n, path.name))
    print("[%s] data_points=%d -> %s" % (tag, n, path.name))


def box(ax, x, y, w, h, label, fc, ec, fs=8.2):
    p = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.08",
                       linewidth=1.0, edgecolor=ec, facecolor=fc)
    ax.add_patch(p)
    ax.text(x + w / 2, y + h / 2, label, ha="center", va="center", fontsize=fs, color="#1a202c")


def arrow(ax, x1, y1, x2, y2, color="#4a5568"):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle="-|>", color=color, lw=1.1, shrinkA=1, shrinkB=1))

# ---------------- F1 system architecture ----------------
def f1():
    fig, ax = plt.subplots(figsize=(10.4, 5.0))
    ax.set_xlim(0, 10.6); ax.set_ylim(0, 5.6); ax.axis("off")
    ax.text(0.15, 5.28, "图 F1  系统功能框图（交付位流 variant_act3c）", fontsize=12, weight="bold")
    box(ax, 0.15, 3.55, 1.85, 0.95, "OV5640 摄像头\n800×480 RGB565\n约 26.67 fps", "#ebf8ff", C["blue"])
    box(ax, 2.35, 3.55, 1.55, 0.95, "cam_tap\n只读并联抓取", "#ebf8ff", C["blue"])
    box(ax, 4.30, 4.25, 2.05, 0.95, "显示通路（厂家例程 37）\nDDR3 乒乓 + lcd_rgb_top", "#f7fafc", C["gray"])
    box(ax, 4.30, 2.55, 2.05, 1.05, "retina_core\n事件引擎 400×240", "#e6fffa", C["teal"])
    box(ax, 6.70, 2.55, 1.95, 1.05, "event_render\n事件位图 BRAM\n400×240×4 bit", "#e6fffa", C["teal"])
    box(ax, 6.70, 4.25, 1.95, 0.95, "disp_mux\n显示源选择 · HUD", "#faf5ff", C["purple"])
    box(ax, 9.10, 4.25, 1.35, 0.95, "4.3 英寸 LCD\n原始/事件画面", "#f7fafc", C["gray"])
    box(ax, 6.70, 0.85, 1.95, 0.95, "udp_merge\n单流合并 24 B 头", "#fffaf0", C["orange"])
    box(ax, 9.10, 0.85, 1.35, 0.95, "PC 上位机\n拆分/录制/推理", "#fffaf0", C["orange"])
    arrow(ax, 2.00, 4.02, 2.33, 4.02)
    arrow(ax, 3.90, 4.02, 4.28, 4.60)
    arrow(ax, 3.90, 4.02, 4.28, 3.20)
    arrow(ax, 6.35, 3.08, 6.68, 3.08, C["teal"])
    arrow(ax, 6.35, 4.60, 6.68, 4.72, C["gray"])
    arrow(ax, 7.67, 3.60, 7.67, 4.23, C["teal"])
    arrow(ax, 8.65, 4.72, 9.08, 4.72, C["purple"])
    arrow(ax, 7.67, 2.53, 7.67, 1.82, C["orange"])
    arrow(ax, 7.67, 1.32, 9.08, 1.32, C["orange"])
    ax.plot([6.20, 6.52, 6.52], [4.23, 3.95, 1.32], color=C["orange"], lw=1.1)
    arrow(ax, 6.52, 1.32, 6.68, 1.32, C["orange"])
    ax.text(6.58, 2.55, "原始帧", rotation=90, fontsize=6.2, color=C["orange"], va="center", ha="left")
    ax.text(4.15, 0.42, "KEY0 切换显示源；HUD 恒叠加；动作分类结果写数据帧 byte23（每帧锁存一次）",
            fontsize=8, color="#555555")
    footer(fig, "docs/assets/system_architecture.svg；docs/03_tech/05_action_uplink_contract.md §2")
    reg("F1", 9 + 10, save(fig, "f1_system_arch.svg"))

# ---------------- F2 data volume ----------------
def f2():
    fig, axes = plt.subplots(1, 2, figsize=(11.0, 4.4))
    ax = axes[0]
    use = [z for z in ZONES if z["label"] != "exclude"]
    order = ["empty_A", "gap_away", "empty_A2", "still_B", "open_L_far", "open_L", "open_L_near",
             "wave_L", "wave_L_far", "typing", "cup_paper"]
    use = sorted(use, key=lambda z: order.index(z["name"]) if z["name"] in order else 99)
    names = [z["name"] for z in use]
    vals = [max(z["rate"], 0.1) for z in use]
    colors = [C["green"] if z["label"] in ("empty", "away") else
              (C["blue"] if z["label"].startswith("openclose") else
               (C["orange"] if z["label"] == "wave_left" else C["gray"])) for z in use]
    ax.barh(range(len(names)), vals, color=colors, height=0.68)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names, fontsize=7.5)
    ax.set_xscale("log")
    ax.set_xlim(10, 300000)
    ax.set_xlabel("事件率（事件/秒，对数轴）")
    ax.set_title("(a) v7hands 各分区事件率（实测）", fontsize=10)
    for i, v in enumerate(vals):
        ax.text(v * 1.08, i, ("%d" % round(v)) if v >= 1 else "%.1f" % v, va="center", fontsize=6.8, color="#333333")
    ax.grid(axis="x", which="major", ls=":", lw=0.5, color="#cbd5e0")

    ax = axes[1]
    labels = ["v5probe", "v6clean-384", "v6clean", "v7hands"]
    keys = ["20261030-212214_v5probe", "20261030-214353_v6clean",
            "20261030-215700_v6clean", "20261030-222201_v7hands"]
    raw = [SESS[k]["raw_bytes"] for k in keys]
    evb = [SESS[k]["ev_csv_bytes"] for k in keys]
    x = list(range(len(keys)))
    ax.bar([i - 0.19 for i in x], raw, width=0.36, color=C["gray"], label="原始帧字节（frames×768,000 B）")
    ax.bar([i + 0.19 for i in x], evb, width=0.36, color=C["orange"], label="events.csv 实测字节")
    ax.set_yscale("log")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("字节数（对数轴）")
    ax.set_title("(b) 帧流与事件流落盘体积", fontsize=10)
    ax.legend(fontsize=7, loc="upper right")
    for i in x:
        ax.text(i - 0.19, raw[i] * 1.3, "%.2f GB" % (raw[i] / 1e9), ha="center", fontsize=6.3)
        ax.text(i + 0.19, evb[i] * 1.3, "%.1f MB" % (evb[i] / 1e6), ha="center", fontsize=6.3)
    ax.grid(axis="y", which="major", ls=":", lw=0.5, color="#cbd5e0")
    fig.suptitle("图 F2  事件流数据量与码率（实测）", fontsize=12, weight="bold", x=0.02, ha="left")
    fig.subplots_adjust(bottom=0.24)
    footer(fig, "records/*/meta.json + frames.csv + events.csv；report/figures/v7_zones.json；统计脚本 report/figures/stream_stats.py（快照 report/evidence/event_stream_stats.json）")
    reg("F2", len(names) + 2 * len(keys), save(fig, "f2_data_volume.svg"))

# ---------------- F3 pipeline ----------------
def f3():
    fig, ax = plt.subplots(figsize=(11.0, 3.3))
    ax.set_xlim(0, 11.2); ax.set_ylim(0, 3.6); ax.axis("off")
    ax.text(0.15, 3.32, "图 F3  事件处理管线（逐像素流水线）", fontsize=12, weight="bold")
    stages = [("输入\n800×480\nRGB565", "#edf2f7"), ("vps_resample\n2×2 抽点\n→400×240", "#ebf8ff"),
              ("px_luma\nRGB→亮度", "#e6fffa"), ("luma_log\n对数压缩", "#e6fffa"),
              ("temporal_diff\n时间差分\n+帧存", "#faf5ff"), ("spatial_lap\n中心-周边\n+2 行缓存", "#faf5ff"),
              ("event_gen\n双阈值\n判决", "#fffaf0"), ("输出\nON/OFF\n事件流", "#edf2f7")]
    w = 1.23
    for i, (lab, col) in enumerate(stages):
        x = 0.15 + i * 1.38
        box(ax, x, 1.45, w, 1.05, lab, col, C["blue"] if i < 2 else (C["teal"] if i < 4 else C["purple"]))
        if i:
            arrow(ax, x - 0.15, 1.97, x - 0.02, 1.97)
    ax.text(0.15, 0.95, "每像素拍数：", fontsize=8.5, weight="bold")
    ax.text(1.55, 0.95, "2 拍/像素（800×480 域）", fontsize=8.5, color=C["blue"])
    ax.text(5.15, 0.95, "1 拍/像素（400×240 域，5 级）", fontsize=8.5, color=C["teal"])
    ax.text(0.15, 0.55, "事件输出与 100 ms 推理窗异步：事件先入 FIFO/双缓冲，推理引擎按窗读取。",
            fontsize=8, color="#555555")
    footer(fig, "docs/assets/event_engine_pipeline.svg；docs/03_tech/04_action_recognition_selection.md")
    reg("F3", len(stages), save(fig, "f3_event_pipeline.svg"))

# ---------------- F4 resources ----------------
def f4():
    fig, axes = plt.subplots(1, 2, figsize=(11.6, 4.5))
    lab = ["LUT", "FF", "Slice", "BRAM", "DSP", "IOB"]
    p3 = [UTIL[k][1] for k in ("lut", "ff", "slices", "bram", "dsp", "iob")]
    p7 = [ACT7["lut_pct"], ACT7["ff_pct"], ACT7["slice_pct"], ACT7["bram_pct"], ACT7["dsp_pct"], ACT7["iob_pct"]]
    p8 = [ACT8["lut_pct"], ACT8["ff_pct"], ACT8["slice_pct"], ACT8["bram_pct"], ACT8["dsp_pct"], ACT8["iob_pct"]]
    x = list(range(6))
    ax = axes[0]
    ax.bar([i - 0.26 for i in x], p3, width=0.24, color=C["gray"], label="act3c 交付")
    ax.bar([i for i in x], p7, width=0.24, color=C["blue"], label="act7 构建")
    ax.bar([i + 0.26 for i in x], p8, width=0.24, color=C["green"], label="act8 交付")
    ax.set_xticks(x)
    ax.set_xticklabels(lab, fontsize=8)
    ax.set_ylabel("占全器件比例（%）")
    ax.set_ylim(0, 82)
    ax.set_title("(a) act3c / act7 / act8 六项资源占用率", fontsize=9.5)
    for i in x:
        ax.text(i - 0.26, p3[i] + 1.4, "%.2f%%" % p3[i], ha="center", fontsize=5.4, rotation=90)
        ax.text(i, p7[i] + 1.4, "%.2f%%" % p7[i], ha="center", fontsize=5.4, rotation=90)
        ax.text(i + 0.26, p8[i] + 1.4, "%.2f%%" % p8[i], ha="center", fontsize=5.4, rotation=90)
    ax.legend(fontsize=6.3, loc="upper right")
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")

    ax = axes[1]
    a3 = [UTIL["lut"][0], UTIL["ff"][0], UTIL["slices"][0], UTIL["bram"][0], UTIL["dsp"][0], UTIL["iob"][0]]
    a7 = [ACT7["lut"], ACT7["ff"], ACT7["slice"], ACT7["bram"], ACT7["dsp"], ACT7["iob"]]
    a8 = [ACT8["lut"], ACT8["ff"], ACT8["slice"], ACT8["bram"], ACT8["dsp"], ACT8["iob"]]
    ax.bar([i - 0.26 for i in x], a3, width=0.24, color=C["gray"], label="act3c 交付")
    ax.bar([i for i in x], a7, width=0.24, color=C["blue"], label="act7 构建")
    ax.bar([i + 0.26 for i in x], a8, width=0.24, color=C["green"], label="act8 交付")
    ax.set_xticks(x)
    ax.set_xticklabels(lab, fontsize=8)
    ax.set_yscale("log")
    ax.set_ylim(1, 60000)
    ax.set_ylabel("数量（对数轴）")
    ax.set_title("(b) 三代实现绝对量", fontsize=9.5)
    for i in x:
        ax.text(i + 0.26, a8[i] * 1.18, "{:,}".format(a8[i]), ha="center", fontsize=5.6, rotation=90)
    ax.legend(fontsize=6.3, loc="upper left")
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    fig.suptitle("图 F4  三代实现资源占用：act3c、act7、act8", fontsize=12, weight="bold", x=0.02, ha="left")
    fig.text(0.01, 0.035, "act8 Slice 占比按 8,026/15,850=50.636% 四舍五入为 50.64%；act3c 为 7,327/15,850=46.23%。",
             fontsize=6.4, color="#555555")
    fig.subplots_adjust(bottom=0.22)
    footer(fig, "build/variant_act3c/inproc_util_impl.rpt:34,39,72,104,119,130；sim/nn/EVIDENCE_M3f.md:108-117；build/variant_act8_final/util.rpt:34,39,72,104,119,130")
    reg("F4", len(p3) * 3 + len(a3) * 3, save(fig, "f4_resources.svg"))

# ---------------- F5 timing ----------------
def f5():
    fig, ax = plt.subplots(figsize=(10.8, 4.3))
    names = ["v1\n200 MHz 单 MAC\n−7.001 ns",
             "v2\n50 MHz / 2 拍\n+8.827 ns",
             "act3c 中间版\n(未采用)\n−0.175 ns",
             "act3c 交付\n+0.306 ns",
             "act7\n+0.059 ns",
             "act8 交付\n+0.215 ns"]
    vals = [WNS_V1, WNS_V2, WNS_MID, WNS_FIN, ACT7["wns"], ACT8["wns"]]
    cols = [C["red"], C["green"], C["orange"], C["blue"], C["teal"], C["purple"]]
    bars = ax.bar(names, vals, color=cols, width=0.62)
    ax.axhline(0, color="#2d3748", lw=1.0)
    ax.set_ylabel("WNS（ns）")
    ax.set_ylim(-9, 10)
    ax.set_title("图 F5  时序收敛过程（六组实现，最差建立裕量 WNS）", fontsize=11.5, weight="bold")
    ax.set_xticklabels(names, fontsize=7.2)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + (0.35 if v >= 0 else -0.75),
                "%+.3f ns" % v, ha="center", fontsize=8.2)
    ax.text(0.02, 0.03, "绿色为收敛；红色为 v1 失败；橙色为未采用的中间版本；act7 与 act8 为当前构建结果。",
            transform=ax.transAxes, fontsize=7.2, color="#555555")
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    fig.subplots_adjust(bottom=0.28, top=0.88)
    footer(fig, "sim/nn/EVIDENCE_M3.md:205；variant_act3c/timing_deliver.rpt:131；inproc_timing.rpt；EVIDENCE_M3f.md:15；act8_artifacts.txt:7")
    reg("F5", len(vals), save(fig, "f5_timing.svg"))

# ---------------- F6 inference cycle budget ----------------
def f6():
    fig, axes = plt.subplots(1, 2, figsize=(10.6, 3.8), gridspec_kw={"width_ratios": [2.0, 1.0]})
    ax = axes[0]
    parts = [("MAC 416,160 拍\n(2×208,080)", MAC_CYC, C["blue"]),
             ("像素固定开销 23,922 拍\n(6×3,987)", PIX_CYC, C["orange"]),
             ("固定 5 拍", FIX_CYC, C["gray"])]
    left = 0
    for lab, v, col in parts:
        ax.barh([0], [v], left=left, color=col, height=0.42)
        left += v
    ax.set_yticks([])
    ax.set_xlim(0, 480000)
    ax.set_ylim(-0.55, 0.55)
    ax.set_xlabel("时钟周期（50 MHz）")
    ax.set_title("(a) 单窗推理周期构成：440,087 拍 = 8.80 ms", fontsize=10)
    ax.text(MAC_CYC / 2, 0.0, "416,160", ha="center", va="center", fontsize=8, color="white")
    ax.text(MAC_CYC + PIX_CYC / 2, 0.0, "23,922", ha="center", va="center", fontsize=7, color="white")
    ax.text(440087, 0.33, "合计 440,087 拍（含固定 5 拍）", ha="right", fontsize=7.5, color="#2d3748")

    ax = axes[1]
    names = ["100 ms 窗\n(8.80 ms)", "600 ms 窗\n(16.54 ms)"]
    vals = [100.0 * V2_MS / 100.0, 100.0 * K6_MS / 600.0]
    bars = ax.bar(names, vals, color=[C["blue"], C["teal"]], width=0.5)
    ax.set_ylabel("推理占窗比（%）")
    ax.set_ylim(0, 12)
    ax.set_title("(b) 占空比", fontsize=10)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.25, "%.2f%%" % v, ha="center", fontsize=8)
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    fig.subplots_adjust(bottom=0.30, top=0.88)
    fig.text(0.01, 0.04, "占 100 ms 窗 8.80%；K=6（600 ms 窗）827,154 拍 = 16.54 ms = 2.76%。", fontsize=7.5, color="#555555")
    footer(fig, "sim/nn/EVIDENCE_M3.md:121-125,190；TB busy duration 440,083 拍（EVIDENCE_M3.md:51）")
    reg("F6", len(parts) + len(vals), save(fig, "f6_cycle_budget.svg"))

# ---------------- F7 held-out rates ----------------
def f7():
    fig, ax = plt.subplots(figsize=(8.2, 4.2))
    vals = [OPEN_RATE, WAVE_RATE, STATIC_RATE, EMPTY_RATE, HARD_RATE]
    mins = [GRP["open"]["minutes"], POOL["wave_minutes"],
            POOL["static_minutes"], POOL["empty_minutes"], HARD_MIN]
    names = ["手部开合\nopen\n%.2f min" % mins[0], "横向挥手\nwave\n%.2f min" % mins[1],
             "静止\nstatic\n%.2f min" % mins[2], "空桌面\nempty\n%.2f min" % mins[3],
             "硬负样本\nhardneg\n%.2f min" % mins[4]]
    cols = [C["green"], C["green"], C["green"], C["green"], C["red"]]
    bars = ax.bar(names, vals, color=cols, width=0.6)
    ax.set_ylabel("pulse 率（次/分）")
    ax.set_ylim(0, 36)
    ax.set_title("图 F7  留出集各动作段 pulse 率（float，margin=8，N_CONSEC=3）", fontsize=11, weight="bold")
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.9, "%.2f 次/分" % v, ha="center", fontsize=8)
    ax.text(0.01, 0.97, "开合检出 16/17 块（0.9412）；挥手 0 pulse；硬负样本 1 pulse（0.83 min）。",
            transform=ax.transAxes, fontsize=7.8, va="top", color="#444444",
            bbox=dict(facecolor="white", edgecolor="none", alpha=0.85, pad=1.2))
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    fig.subplots_adjust(bottom=0.30)
    footer(fig, "nn/out_v7/results_v7_final.json（pooled.8）；nn/REPORT_v7_数据集.md §3")
    reg("F7", len(vals), save(fig, "f7_heldout_rates.svg"))

# ---------------- F8 representation iteration ----------------
def f8():
    fig, ax = plt.subplots(figsize=(8.4, 4.2))
    names = ["v5\n(基线)", "c3_shift", "c5_shift_glob", "v7\n(fold-level)"]
    wave = [WAVE_HIT_V5, WAVE_HIT_C3, WAVE_HIT_C5, WAVE_HIT_V7]
    openr = [OPEN_V5, OPEN_C3, OPEN_C5, OPEN_V7]
    x = list(range(4))
    ax.bar([i - 0.19 for i in x], wave, width=0.36, color=C["orange"], label="挥手窗级命中率（越低越好）")
    ax.bar([i + 0.19 for i in x], openr, width=0.36, color=C["blue"], label="开合块召回率（越高越好）")
    ax.set_xticks(x)
    ax.set_xticklabels(names, fontsize=8.5)
    ax.set_ylim(0, 1.12)
    ax.set_ylabel("比例")
    ax.set_title("图 F8  表征迭代：挥手误命中与开合召回", fontsize=11.5, weight="bold")
    ax.legend(fontsize=7.5, loc="upper right")
    for i in x:
        ax.text(i - 0.19, wave[i] + 0.02, "%.3f" % wave[i], ha="center", fontsize=7.2)
        if i == 3:
            ax.text(i + 0.19, openr[i] - 0.07, "%.3f" % openr[i], ha="center", fontsize=7.2, color="white")
        else:
            ax.text(i + 0.19, openr[i] + 0.02, "%.3f" % openr[i], ha="center", fontsize=7.2)
    fig.text(0.01, 0.125, "v5/c3/c5 为同一 7 min 录制离线回放，非独立测试集；v7 为 222201 会话留出。",
             fontsize=7.0, color="#555555")
    fig.text(0.01, 0.083, "v7 折级 16/17=0.941（含 0.5 s 守卫带）；同模型 pooled 无守卫 17/17=1.000，二者口径不同。",
             fontsize=7.0, color="#555555")
    fig.text(0.01, 0.041, "v7 挥手窗级命中 5/510 决策窗，仅 wave 两段（1,020 窗），不含硬负样本。",
             fontsize=7.0, color="#555555")
    fig.subplots_adjust(bottom=0.34, top=0.90)
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    footer(fig, "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md:129,135；nn/REPORT_v6_表征实验.md:56,59；nn/out_v7/results_v7_final.json:4637,4638,4643,4655,4656")
    reg("F8", len(wave) + len(openr), save(fig, "f8_iteration.svg"))

# ---------------- F9 data composition ----------------
def f9():
    fig, axes = plt.subplots(1, 2, figsize=(10.2, 4.0), gridspec_kw={"width_ratios": [1.35, 1.0]})
    ax = axes[0]
    names = ["开合 open", "挥手 wave", "静止 static", "空桌面 empty", "硬负 hardneg"]
    vals = [GRP["open"]["n_windows"], GRP["wave"]["n_windows"], GRP["static"]["n_windows"],
            GRP["empty"]["n_windows"], GRP["hardneg"]["n_windows"]]
    cols = [C["green"], C["orange"], C["blue"], C["gray"], C["red"]]
    bars = ax.barh(names, vals, color=cols, height=0.6)
    ax.set_xlabel("保留窗数（100 ms 窗，50 ms 步）")
    ax.set_title("(a) v7 可用窗按动作组（4,589 窗）", fontsize=10)
    for b, v in zip(bars, vals):
        ax.text(v + 15, b.get_y() + b.get_height() / 2, "%d" % v, va="center", fontsize=8)
    ax.set_xlim(0, 1750)
    ax.grid(axis="x", ls=":", lw=0.5, color="#cbd5e0")

    ax = axes[1]
    names2 = ["y=0\n空/静止/硬负", "y=1\n手部开合", "y=2\n横向挥手"]
    vals2 = [5067, 5480, 3900]
    bars = ax.bar(names2, vals2, color=[C["gray"], C["green"], C["orange"]], width=0.55)
    ax.set_ylabel("npz 行数")
    ax.set_title("(b) windows_v7.npz 标签构成（14,447 行）", fontsize=10)
    for b, v in zip(bars, vals2):
        ax.text(b.get_x() + b.get_width() / 2, v + 90, "%d" % v, ha="center", fontsize=8)
    ax.set_ylim(0, 6300)
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")
    fig.subplots_adjust(bottom=0.24)
    footer(fig, "nn/REPORT_v7_数据集.md:19-36,41；nn/out_v7/results_v7_final.json（n=14447）")
    reg("F9", len(vals) + len(vals2), save(fig, "f9_data_composition.svg"))

# ---------------- F10 end-to-end latency anchors ----------------
def f10():
    fig, ax = plt.subplots(figsize=(9.0, 3.9))
    names = ["板端推理（实测）", "帧锁存粒度（由 26.671 fps 推算）", "上位机事件匹配 p50（合成）",
             "上位机事件匹配 p95（合成）", "契约 R3 上限（3.3 fps）", "卡片轮询周期"]
    vals = [V2_MS, FRAME_LATCH_MS, LAT_P50, LAT_P95, 300.0, 500.0]
    cols = [C["blue"], C["teal"], C["orange"], C["orange"], C["red"], C["gray"]]
    bars = ax.barh(range(len(names)), vals, color=cols, height=0.62)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names, fontsize=7.8)
    ax.invert_yaxis()
    ax.set_xscale("log")
    ax.set_xlim(5, 900)
    ax.set_xlabel("时间（ms，对数轴）")
    ax.set_title("图 F10  端到端时延锚点（实测/推算/契约，非同一链路求和）", fontsize=11, weight="bold")
    for i, v in enumerate(vals):
        fmt = "%.3f ms" if i in (2, 3) else ("%.2f ms" if v < 100 else "%.0f ms")
        ax.text(v * 1.12, i, fmt % v, va="center", fontsize=7.6)
    ax.grid(axis="x", ls=":", lw=0.5, color="#cbd5e0")
    fig.subplots_adjust(bottom=0.26)
    footer(fig, "EVIDENCE_M3.md:29；records v7 fps；EVIDENCE_EVAL.log:51；契约 §8 R3:462")
    reg("F10", len(vals), save(fig, "f10_latency.svg"))

# ---------------- F11 threshold sweep ----------------
def f11():
    fig, axes = plt.subplots(1, 3, figsize=(11.4, 4.3), sharey=False)
    margins = sorted({p["margin"] for p in SWEEP})
    for k, nc in enumerate([3, 4, 5]):
        ax = axes[k]
        pts = sorted([p for p in SWEEP if p["n_consec"] == nc], key=lambda p: p["margin"])
        x = [p["margin"] for p in pts]
        op = [int(p["open"].split("/")[0]) for p in pts]
        hn = [p["hardneg"] for p in pts]
        ax.plot(x, op, "-o", color=C["blue"], lw=1.4, ms=4)
        ax.set_xlim(4, 52)
        ax.set_ylim(0, 18)
        ax.set_xticks(margins)
        ax.set_xticklabels([str(v) for v in margins], fontsize=7)
        ax.set_xlabel("margin 门限")
        if k == 0:
            ax.set_ylabel("开合块命中数（/17）")
        ax.set_title("N_CONSEC=%d" % nc, fontsize=10)
        ax.grid(ls=":", lw=0.5, color="#cbd5e0")
        ax2 = ax.twinx()
        ax2.plot(x, hn, "-s", color=C["red"], lw=1.4, ms=4)
        ax2.set_ylim(0, 4)
        if k == 2:
            ax2.set_ylabel("硬负 pulse 数")
        i = x.index(16)
        ax.axvline(16, color=C["gray"], ls="--", lw=0.9)
        ax.text(0.97, 0.97, "选中 16/%d\n开合 %d/17 · 硬负 %d" % (nc, op[i], hn[i]),
                transform=ax.transAxes, ha="right", va="top", fontsize=7.0, color="#2d3748",
                bbox=dict(facecolor="white", edgecolor="#cbd5e0", lw=0.5, alpha=0.94, pad=2.0))
    fig.suptitle("图 F11  决策门限扫描：开合召回与硬负 pulse（18 组）", fontsize=11.5, weight="bold", x=0.02, ha="left")
    fig.text(0.01, 0.155, "蓝线：开合块命中数（左轴）；红线：硬负 pulse 数（右轴）；竖虚线为选中的 margin=16。",
             fontsize=7.0, color="#555555")
    fig.text(0.01, 0.100, "8/3 与 16/3 在开合、挥手、静止、空桌面四项相同；16/3 把硬负 3 压到 2、总 pulse 88 压到 74。",
             fontsize=7.0, color="#555555")
    fig.text(0.01, 0.045, "24/4 把硬负压到 1，但开合掉到 14/17，不作为部署选择。",
             fontsize=7.0, color="#555555")
    fig.subplots_adjust(bottom=0.32, top=0.86, wspace=0.34)
    footer(fig, "nn/out_v7b/s100_threshold_sweep.json（18 组，margin 3-207 行）；docs/06_facts/03_v7b_deployment_decision.md:10,18-23")
    reg("F11", len(SWEEP), save(fig, "f11_threshold_sweep.svg"))


# ---------------- F12 act7 vs act3c ----------------
def f12():
    fig, axes = plt.subplots(1, 3, figsize=(11.4, 4.3), gridspec_kw={"width_ratios": [1.0, 1.55, 0.95]})
    ax = axes[0]
    labels = ["WNS", "WHS"]
    a3 = [WNS_FIN, WHS_FIN]
    a7 = [ACT7["wns"], ACT7["whs"]]
    a8 = [ACT8["wns"], ACT8["whs"]]
    x = [0, 1]
    ax.bar([i - 0.26 for i in x], a3, width=0.24, color=C["gray"], label="act3c 交付")
    ax.bar([i for i in x], a7, width=0.24, color=C["blue"], label="act7 构建")
    ax.bar([i + 0.26 for i in x], a8, width=0.24, color=C["green"], label="act8 构建")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylim(0, 0.40)
    ax.set_ylabel("裕量（ns）")
    ax.set_title("(a) 时序裕量", fontsize=10)
    for i in x:
        ax.text(i - 0.26, a3[i] + 0.012, "%.3f" % a3[i], ha="center", fontsize=6.0)
        ax.text(i, a7[i] + 0.012, "%.3f" % a7[i], ha="center", fontsize=6.0)
        ax.text(i + 0.26, a8[i] + 0.012, "%.3f" % a8[i], ha="center", fontsize=6.0)
    ax.legend(fontsize=5.8, loc="upper right")
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")

    ax = axes[1]
    names = ["LUT", "FF", "Slice", "BRAM", "DSP", "IOB"]
    p3 = [UTIL[k][1] for k in ("lut", "ff", "slices", "bram", "dsp", "iob")]
    p7 = [ACT7["lut_pct"], ACT7["ff_pct"], ACT7["slice_pct"], ACT7["bram_pct"], ACT7["dsp_pct"], ACT7["iob_pct"]]
    p8 = [ACT8["lut_pct"], ACT8["ff_pct"], ACT8["slice_pct"], ACT8["bram_pct"], ACT8["dsp_pct"], ACT8["iob_pct"]]
    x = list(range(6))
    ax.bar([i - 0.26 for i in x], p3, width=0.24, color=C["gray"], label="act3c 交付")
    ax.bar([i for i in x], p7, width=0.24, color=C["blue"], label="act7 构建")
    ax.bar([i + 0.26 for i in x], p8, width=0.24, color=C["green"], label="act8 构建")
    ax.set_xticks(x)
    ax.set_xticklabels(names, fontsize=8)
    ax.set_ylim(0, 85)
    ax.set_ylabel("占全器件比例（%）")
    ax.set_title("(b) 实现资源占用率", fontsize=10)
    for i in x:
        ax.text(i - 0.26, p3[i] + 1.6, "%.2f" % p3[i], ha="center", fontsize=5.2, rotation=90)
        ax.text(i, p7[i] + 1.6, "%.2f" % p7[i], ha="center", fontsize=5.2, rotation=90)
        ax.text(i + 0.26, p8[i] + 1.6, "%.2f" % p8[i], ha="center", fontsize=5.2, rotation=90)
    ax.legend(fontsize=5.8, loc="upper right")
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")

    ax = axes[2]
    names = ["act3c", "act7", "act8"]
    vals = [ACT3C_BIT, ACT7["bit"], ACT8["bit"]]
    bars = ax.bar(names, vals, color=[C["gray"], C["blue"], C["green"]], width=0.60)
    ax.set_ylim(2.75e6, 2.95e6)
    ax.set_ylabel("位流字节数（纵轴截断）")
    ax.set_title("(c) 位流大小", fontsize=10)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 3500, "{:,}".format(v), ha="center", fontsize=6.0)
    ax.grid(axis="y", ls=":", lw=0.5, color="#cbd5e0")

    fig.suptitle("图 F12  act3c、act7 与 act8 并排：时序、资源、位流", fontsize=11.5, weight="bold", x=0.02, ha="left")
    fig.text(0.01, 0.085, "act7 与 act8 为 variant_act7 与 variant_act8_final 构建；act8 换 v7b ROM 并用 Explore 重跑，WNS 回到 +0.215 ns。",
             fontsize=7.0, color="#555555")
    fig.text(0.01, 0.052, "位流差值：act7−act3c = −55,452 B；act8−act7 = +3,684 B。",
             fontsize=7.0, color="#c53030")
    fig.subplots_adjust(bottom=0.28, top=0.86, wspace=0.36)
    footer(fig, "build/variant_act3c/timing_deliver.rpt:131 + inproc_util_impl.rpt:34,39,72,104,119,130；sim/nn/EVIDENCE_M3f.md:15,108-117,128；report/evidence/act8_artifacts.txt:4-19")
    reg("F12", len(a3) + len(p3) * 3 + len(vals), save(fig, "f12_act7_vs_act3c.svg"))


def emit_metrics():
    # F1
    metric("F1", "功能块/连线", "9 节点 / 10 箭头",
           "docs/assets/system_architecture.svg; report/figures/make_figures.py:%d" % f1.__code__.co_firstlineno,
           "9 节点 / 10 箭头")
    # F2
    zline = {}
    for i, l in enumerate(text("report/figures/v7_zones.json").splitlines(), 1):
        mm = re.search(r'"name":\s*"([^"]+)"', l)
        if mm:
            zline[mm.group(1)] = i
    for z in ZONES:
        if z["label"] == "exclude":
            continue
        ez = EV_ZONE[z["name"]]
        metric("F2", "事件率 %s" % z["name"], "%d 事件/秒" % round(z["rate"]),
               "records/20261030-222201_v7hands/chunk-000.events.csv:2（逐行）; report/figures/v7_zones.json:%d" % zline[z["name"]],
               round(ez["ev"] / ez["duration_s"]))
    sess_labels = [("v5probe", "20261030-212214_v5probe", "v5probe"),
                   ("v6clean-384", "20261030-214353_v6clean", "v6clean384"),
                   ("v6clean", "20261030-215700_v6clean", "v6clean"),
                   ("v7hands", "20261030-222201_v7hands", "v7hands")]
    for lab, key, evkey in sess_labels:
        s = SESS[key]
        ev = EV_SESS[evkey]
        src = "records/%s/meta.json:19,20,23; records/%s/chunk-000.frames.csv:2" % (key, key)
        metric("F2", "%s 帧数" % lab, s["frames"], src, ev["frames"])
        metric("F2", "%s 事件数" % lab, s["events"], src, ev["events"])
        metric("F2", "%s 板卡跨度" % lab, "%.3f s" % s["span_s"], src, ev["span_s"])
        metric("F2", "%s 有效帧率" % lab, "%.3f fps" % s["fps_eff"], src, ev["fps_eff"])
        metric("F2", "%s 事件率" % lab, "%.2f 事件/秒" % s["ev_per_s"], src, ev["events_per_s"])
        metric("F2", "%s CSV/原始字节" % lab, "%.5f" % s["ratio"], src, ev["events_csv_ratio"])
    # F3
    metric("F3", "流水级数", "8", "docs/assets/event_engine_pipeline.svg:1; report/figures/make_figures.py:%d"
           % f3.__code__.co_firstlineno, 8)
    metric("F3", "每像素拍数", "2（800×480）/ 1（400×240 五级）", M0_RES + ":20",
           "2（800×480）/ 1（400×240 五级）")
    # F4
    exp_util = dict(lut=(20559, 32.43), ff=(11850, 9.35), slices=(7327, 46.23),
                    bram=(87, 64.44), dsp=(7, 2.92), iob=(140, 49.12))
    exp_base = dict(LUT=18973, FF=11296, Slice=6721, BRAM=77.5, DSP=6, IOB=140)
    exp_budget = {"Slice LUT": 2800, "Slice FF": 3200, "Slices": 800,
                  "BRAM36 Tile": 7, "DSP48E1": 8, "IOB": 0}
    exp_delta = dict(LUT=1586, FF=554, BRAM=9.5, DSP=1)
    for k, lab in [("lut", "LUT"), ("ff", "FF"), ("slices", "Slice"), ("bram", "BRAM"),
                   ("dsp", "DSP"), ("iob", "IOB")]:
        metric("F4", "%s 已用" % lab, UTIL[k][0], "%s:%d" % (_IMPL, UTIL[k][2]), exp_util[k][0])
        metric("F4", "%s 占比" % lab, "%.2f%%" % UTIL[k][1], "%s:%d" % (_IMPL, UTIL[k][2]), exp_util[k][1])
    act7_lines = dict(LUT=108, FF=111, Slice=112, BRAM=113, DSP=116, IOB=117)
    act8_lines = dict(LUT=34, FF=39, Slice=72, BRAM=104, DSP=119, IOB=130)
    for lab, key in [("LUT", "lut"), ("FF", "ff"), ("Slice", "slice"), ("BRAM", "bram"),
                     ("DSP", "dsp"), ("IOB", "iob")]:
        metric("F4", "act7 %s 占比" % lab, "%.2f%%" % ACT7[key + "_pct"],
               "%s:%d" % (ACT7_SRC, act7_lines[lab]), ACT7[key + "_pct"])
        metric("F4", "act8 %s 占比" % lab, "%.2f%%" % ACT8[key + "_pct"],
               "build/variant_act8_final/util.rpt:%d" % act8_lines[lab], ACT8[key + "_pct"])
    for lab, val, row in [("LUT", BASE_LUT, M0B_LUT), ("FF", BASE_FF, M0B_FF), ("Slice", BASE_SL, M0B_SL),
                          ("BRAM", BASE_BRAM, M0B_BRAM), ("DSP", BASE_DSP, M0B_DSP), ("IOB", BASE_IOB, M0B_IOB)]:
        metric("F4", "M0 基线 %s" % lab, val, "%s:%d" % (M0_RES, row[0]), exp_base[lab])
    for lab, val, row in [("Slice LUT", BUDGET_DELTA["lut"], BUD_LUT), ("Slice FF", BUDGET_DELTA["ff"], BUD_FF),
                          ("Slices", BUDGET_DELTA["slices"], BUD_SL), ("BRAM36 Tile", BUDGET_DELTA["bram"], BUD_BRAM),
                          ("DSP48E1", BUDGET_DELTA["dsp"], BUD_DSP), ("IOB", BUDGET_DELTA["iob"], BUD_IOB)]:
        metric("F4", "预算增量 %s" % lab, ("+%d" % val) if val else "0", "%s:%d" % (M0_RES, row[0]), exp_budget[lab])
    for lab, base, fin, brow in [("LUT", BASE_LUT, UTIL["lut"][0], M0B_LUT),
                                 ("FF", BASE_FF, UTIL["ff"][0], M0B_FF),
                                 ("BRAM", BASE_BRAM, UTIL["bram"][0], M0B_BRAM),
                                 ("DSP", BASE_DSP, UTIL["dsp"][0], M0B_DSP)]:
        metric("F4", "实测增量 %s" % lab, "%+.1f" % (fin - base),
               "%s:%d; %s:%d" % (M0_RES, brow[0], _IMPL, UTIL[{"LUT": "lut", "FF": "ff", "BRAM": "bram", "DSP": "dsp"}[lab]][2]),
               exp_delta[lab])
    # F5
    metric("F5", "v1 WNS", "%+.3f ns" % WNS_V1, M3_SRC + ":205", -7.001)
    metric("F5", "v2 WNS", "%+.3f ns" % WNS_V2, M3_SRC + ":205", 8.827)
    metric("F5", "中间版 WNS", "%+.3f ns" % WNS_MID, "build/variant_act3c/inproc_timing.rpt:%d" % MID_LINE, -0.175)
    metric("F5", "交付 WNS", "%+.3f ns" % WNS_FIN, "%s:%d" % (_TIM, TSUM_LINE), 0.306)
    metric("F5", "交付 WHS", "%+.3f ns" % WHS_FIN, "%s:%d" % (_TIM, TSUM_LINE), 0.036)
    metric("F5", "交付端点", 76854, "%s:%d" % (_TIM, TSUM_LINE), 76854)
    metric("F5", "act7 WNS", "%+.3f ns" % ACT7["wns"], ACT7_SRC + ":15", ACT7["wns"])
    metric("F5", "act7 WHS", "%+.3f ns" % ACT7["whs"], ACT7_SRC + ":15", ACT7["whs"])
    metric("F5", "act7 端点", ACT7["endpoints"], ACT7_SRC + ":57", ACT7["endpoints"])
    metric("F5", "act8 WNS", "%+.3f ns" % ACT8["wns"], "report/evidence/act8_artifacts.txt:7", ACT8["wns"])
    metric("F5", "act8 WHS", "%+.3f ns" % ACT8["whs"], "report/evidence/act8_artifacts.txt:9", ACT8["whs"])
    metric("F5", "act8 端点", ACT8["endpoints"], "report/evidence/act8_artifacts.txt:11", ACT8["endpoints"])
    # F6
    metric("F6", "MAC 拍", MAC_CYC, M3_SRC + ":121", 416160)
    metric("F6", "像素固定开销拍", PIX_CYC, M3_SRC + ":121", 23922)
    metric("F6", "固定拍", FIX_CYC, M3_SRC + ":121", 5)
    metric("F6", "单窗总拍", MAC_CYC + PIX_CYC + FIX_CYC, M3_SRC + ":121", 440087)
    metric("F6", "100 ms 窗推理", "%.2f ms" % V2_MS, M3_SRC + ":29", 8.80)
    metric("F6", "100 ms 窗占空比", "8.80%", M3_SRC + ":123", 8.80)
    # F7
    metric("F7", "开合 pulse 率", "%.3f 次/分" % OPEN_RATE, _V7JSON + ":4676", 30.769)
    metric("F7", "挥手 pulse 率", "%.3f 次/分" % WAVE_RATE, _V7JSON + ":4642", 0.0)
    metric("F7", "静止 pulse 率", "%.3f 次/分" % STATIC_RATE, _V7JSON + ":4647", 0.0)
    metric("F7", "空桌面 pulse 率", "%.3f 次/分" % EMPTY_RATE, _V7JSON + ":4750", 0.0)
    metric("F7", "硬负 pulse 率", "%.3f 次/分" % HARD_RATE, _V7JSON + ":4776", 1.212)
    metric("F7", "开合时长", "%.2f min" % GRP["open"]["minutes"], _V7JSON + ":4673", 1.30)
    metric("F7", "挥手时长", "%.2f min" % POOL["wave_minutes"], _V7JSON + ":4641", 0.85)
    metric("F7", "静止时长", "%.4f min" % POOL["static_minutes"], _V7JSON + ":4646", 0.3333)
    metric("F7", "空桌面时长", "%.4f min" % POOL["empty_minutes"], _V7JSON + ":4649", 0.5167)
    metric("F7", "硬负时长", "%.4f min" % HARD_MIN, _V7JSON + ":4773", 0.8251)
    # F8
    metric("F8", "v5 挥手窗级命中", "%.3f" % WAVE_HIT_V5, _MEAS + ":%d" % V5_WAVE_LINE, 0.652)
    metric("F8", "v5 开合块召回", "%.3f" % OPEN_V5, _MEAS + ":%d" % V5_OPEN_LINE, 1.0)
    metric("F8", "c3 挥手窗级命中", "%.4f" % WAVE_HIT_C3, "nn/REPORT_v6_表征实验.md:%d" % V6_C3[0], 0.0817)
    metric("F8", "c3 开合块召回", "%.3f" % OPEN_C3, "nn/REPORT_v6_表征实验.md:%d" % V6_C3[0], 1.0)
    metric("F8", "c5 挥手窗级命中", "%.4f" % WAVE_HIT_C5, "nn/REPORT_v6_表征实验.md:%d" % V6_C5[0], 0.0575)
    metric("F8", "c5 开合块召回", "%.3f" % OPEN_C5, "nn/REPORT_v6_表征实验.md:%d" % V6_C5[0], 1.0)
    metric("F8", "v7 挥手窗级命中", "%.4f" % WAVE_HIT_V7, _V7JSON + ":4643", 0.0098)
    metric("F8", "v7 开合块召回", "%.4f" % OPEN_V7, _V7JSON + ":4637", 0.9412)
    # F9
    metric("F9", "开合窗数", GRP["open"]["n_windows"], _V7REP + ":20,23,24", 1560)
    metric("F9", "挥手窗数", GRP["wave"]["n_windows"], _V7REP + ":21,25", 1020)
    metric("F9", "静止窗数", GRP["static"]["n_windows"], _V7REP + ":29", 400)
    metric("F9", "空桌面窗数", GRP["empty"]["n_windows"], _V7REP + ":19,31", 619)
    metric("F9", "硬负窗数", GRP["hardneg"]["n_windows"], _V7REP + ":22,27,28", 990)
    metric("F9", "npz y=0", 5067, _V7REP + ":41", 5067)
    metric("F9", "npz y=1", 5480, _V7REP + ":41", 5480)
    metric("F9", "npz y=2", 3900, _V7REP + ":41", 3900)
    # F10
    metric("F10", "板端推理", "%.2f ms" % V2_MS, M3_SRC + ":29", 8.80)
    metric("F10", "帧锁存粒度", "%.2f ms" % FRAME_LATCH_MS,
           "docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md:53", 37.49)
    metric("F10", "上位机匹配 p50", "%.3f ms" % LAT_P50,
           "docs/05_experiments/action_recognition_20261029/EVIDENCE_EVAL.log:51", 85.612)
    metric("F10", "上位机匹配 p95", "%.3f ms" % LAT_P95,
           "docs/05_experiments/action_recognition_20261029/EVIDENCE_EVAL.log:51", 97.555)
    metric("F10", "契约 R3 上限", "300 ms", "docs/03_tech/05_action_uplink_contract.md:462", 300)
    metric("F10", "卡片轮询周期", "500 ms", "docs/03_tech/05_action_uplink_contract.md:462", 500)
    # F11
    for margin, nc in [(8, 3), (16, 3), (24, 4)]:
        point = next(q for q in SWEEP if q["margin"] == margin and q["n_consec"] == nc)
        src = "nn/out_v7b/s100_threshold_sweep.json:%d" % SWEEP_LINE[(margin, nc)]
        metric("F11", "%d/%d 开合块" % (margin, nc), point["open"], src, point["open"])
        metric("F11", "%d/%d 硬负 pulse" % (margin, nc), point["hardneg"], src, point["hardneg"])
        metric("F11", "%d/%d 总 pulse" % (margin, nc), point["pulses"], src, point["pulses"])
    metric("F11", "v7b 开合块", "17/17", _V7B_REP + ":210", "17/17")
    metric("F11", "v7b 挥手 pulse", 1, _V7B_REP + ":212", 1)
    metric("F11", "v7b 硬负 pulse", 2, _V7B_REP + ":213", 2)
    metric("F11", "v7b 总 pulse", 74, _V7B_REP + ":216", 74)
    metric("F11", "v7b int8 一致率", "%.4f" % 0.9299, _V7B_REP + ":245", 0.9299)
    # F12
    metric("F12", "act3c WNS", "%.3f ns" % WNS_FIN, _TIM + ":131", 0.306)
    metric("F12", "act7 WNS", "%.3f ns" % ACT7["wns"], ACT7_SRC + ":15", 0.059)
    metric("F12", "act3c WHS", "%.3f ns" % WHS_FIN, _TIM + ":131", 0.036)
    metric("F12", "act7 WHS", "%.3f ns" % ACT7["whs"], ACT7_SRC + ":15", 0.027)
    metric("F12", "act7 LUT", "{:,}".format(ACT7["lut"]), ACT7_SRC + ":108", 22371)
    metric("F12", "act7 LUT 占比", "%.2f%%" % ACT7["lut_pct"], ACT7_SRC + ":108", 35.29)
    metric("F12", "act7 FF", "{:,}".format(ACT7["ff"]), ACT7_SRC + ":111", 14325)
    metric("F12", "act7 FF 占比", "%.2f%%" % ACT7["ff_pct"], ACT7_SRC + ":111", 11.30)
    metric("F12", "act7 Slice", "{:,}".format(ACT7["slice"]), ACT7_SRC + ":112", 7968)
    metric("F12", "act7 Slice 占比", "%.2f%%" % ACT7["slice_pct"], ACT7_SRC + ":112", 50.27)
    metric("F12", "act7 BRAM", ACT7["bram"], ACT7_SRC + ":113", 87)
    metric("F12", "act7 BRAM 占比", "%.2f%%" % ACT7["bram_pct"], ACT7_SRC + ":113", 64.44)
    metric("F12", "act7 DSP", ACT7["dsp"], ACT7_SRC + ":116", 8)
    metric("F12", "act7 DSP 占比", "%.2f%%" % ACT7["dsp_pct"], ACT7_SRC + ":116", 3.33)
    metric("F12", "act7 IOB", ACT7["iob"], ACT7_SRC + ":117", 140)
    metric("F12", "act7 IOB 占比", "%.2f%%" % ACT7["iob_pct"], ACT7_SRC + ":117", 49.12)
    metric("F12", "act7 位流", "{:,}".format(ACT7["bit"]), ACT7_SRC + ":128", 2835423)
    metric("F12", "act7 位流 md5", "9c13668c029c9d3a248cf69cbec03582", ACT7_SRC + ":129",
           "9c13668c029c9d3a248cf69cbec03582")
    metric("F12", "act7 构建耗时", "10 分 06 秒", ACT7_SRC + ":42", "10 分 06 秒")
    metric("F12", "act8 WNS", "+0.215 ns", _ACT8_EV + ":7", 0.215)
    metric("F12", "act8 WHS", "+0.017 ns", _ACT8_EV + ":9", 0.017)
    metric("F12", "act8 LUT", "{:,}".format(22383), _ACT8_EV + ":14", 22383)
    metric("F12", "act8 LUT 占比", "35.30%", _ACT8_EV + ":14", 35.30)
    metric("F12", "act8 FF", "{:,}".format(14325), _ACT8_EV + ":15", 14325)
    metric("F12", "act8 FF 占比", "11.30%", _ACT8_EV + ":15", 11.30)
    metric("F12", "act8 Slice", "{:,}".format(8026), _ACT8_EV + ":16", 8026)
    metric("F12", "act8 Slice 占比", "50.64%", _ACT8_EV + ":16", 50.64)
    metric("F12", "act8 BRAM", "86.5", _ACT8_EV + ":17", 86.5)
    metric("F12", "act8 BRAM 占比", "64.07%", _ACT8_EV + ":17", 64.07)
    metric("F12", "act8 DSP", 8, _ACT8_EV + ":18", 8)
    metric("F12", "act8 DSP 占比", "3.33%", _ACT8_EV + ":18", 3.33)
    metric("F12", "act8 IOB", 140, _ACT8_EV + ":19", 140)
    metric("F12", "act8 IOB 占比", "49.12%", _ACT8_EV + ":19", 49.12)
    metric("F12", "act8 位流", "{:,}".format(2839107), _ACT8_EV + ":4", 2839107)
    metric("F12", "act8 位流 md5", "5ec55ec07c44f2503df63f1bb160a6e6", _ACT8_EV + ":5",
           "5ec55ec07c44f2503df63f1bb160a6e6")
    metric("F12", "act3c 位流", "{:,}".format(ACT3C_BIT), "docs/06_facts/00_current_status.md:28", 2890875)
    metric("F12", "LUT 增量", "+1,812", ACT7_SRC + ":108", 1812)
    metric("F12", "FF 增量", "+2,475", ACT7_SRC + ":111", 2475)
    metric("F12", "Slice 增量", "+641", ACT7_SRC + ":112", 641)
    metric("F12", "DSP 增量", "+1", ACT7_SRC + ":116", 1)
    for fig, label, val, exp, src, equal in METRICS:
        if not re.search(r":\d", src):
            die("metric source lacks line number: %s / %s -> %s" % (fig, label, src))
        if equal != "YES":
            die("metric expected missing/unequal: %s / %s" % (fig, label))
    print("FIGURE,METRIC,VALUE,EXPECTED,SOURCE,EQUAL")
    for fig, label, val, exp, src, equal in METRICS:
        print("%s,%s,%s,%s,%s,%s" % (fig, label, val, exp, src, equal))
    table = OUT / "figure_data_table.csv"
    with open(table, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["figure", "metric", "value", "expected", "source_path:line", "equal"])
        for fig, label, val, exp, src, equal in METRICS:
            w.writerow([fig.lower(), label, val, exp, src, equal])
    print("csv=%s rows=%d" % (table, len(METRICS)))
    print("metrics=%d" % len(METRICS))


emit_metrics()
f1(); f2(); f3(); f4(); f5(); f6(); f7(); f8(); f9(); f10(); f11(); f12()
print("figures=%d data_points_total=%d" % (len(REPORTED), sum(n for _, n, _ in REPORTED)))
print("FIGURES_OK=1")
