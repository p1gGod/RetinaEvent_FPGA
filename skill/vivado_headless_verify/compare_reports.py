#!/usr/bin/env python3
"""compare_reports.py -- parse Vivado utilization/timing reports or HEADLESS_* markers,
print a before/after table with deltas, and apply resource/timing gates.

Works on:
  - report_utilization output (Slice LUTs, Slice Registers, Slice, Block RAM Tile, DSPs)
  - report_timing_summary output (WNSns table)
  - metrics.txt produced by synth_verify.tcl (HEADLESS_LUT=... lines)

Exit codes: 0 all gates pass, 1 a gate fails, 2 usage/IO error.
Python 3 standard library only; no fixed repository paths.
"""

import argparse
import re
import sys
import tempfile
from pathlib import Path

UTIL_PATTERNS = (
    ("lut", re.compile(r"^\|\s+Slice LUTs\s+\|\s+([0-9.]+)")),
    ("ff", re.compile(r"^\|\s+Slice Registers\s+\|\s+([0-9.]+)")),
    ("slices", re.compile(r"^\|\s+Slice\s+\|\s+([0-9.]+)")),
    ("bram", re.compile(r"^\|\s+Block RAM Tile\s+\|\s+([0-9.]+)")),
    ("dsp", re.compile(r"^\|\s+DSPs\s+\|\s+([0-9.]+)")),
)
MARKER_PATTERNS = (
    ("lut", re.compile(r"^HEADLESS_LUT=([0-9.]+)")),
    ("ff", re.compile(r"^HEADLESS_FF=([0-9.]+)")),
    ("slices", re.compile(r"^HEADLESS_SLICES=([0-9.]+)")),
    ("bram", re.compile(r"^HEADLESS_BRAM=([0-9.]+)")),
    ("dsp", re.compile(r"^HEADLESS_DSP=([0-9.]+)")),
    ("wns", re.compile(r"^HEADLESS_WNS=(-?[0-9.]+)")),
)
ORDER = ("lut", "ff", "slices", "bram", "dsp", "wns")
LABELS = {"lut": "Slice LUTs", "ff": "Slice Registers", "slices": "Slices",
          "bram": "Block RAM tiles", "dsp": "DSPs", "wns": "WNS ns"}


def parse_util(text):
    found = {}
    for line in text.splitlines():
        for key, rx in UTIL_PATTERNS:
            m = rx.match(line)
            if m and key not in found:
                found[key] = float(m.group(1))
    return found


def parse_timing_wns(text):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "WNS(ns)" in line:
            for nxt in lines[i + 1:i + 12]:
                m = re.search(r"(-?[0-9]+\.[0-9]+)", nxt)
                if m:
                    return float(m.group(1))
    return None


def parse_markers(text):
    found = {}
    for line in text.splitlines():
        s = line.strip()
        for key, rx in MARKER_PATTERNS:
            m = rx.match(s)
            if m:
                found[key] = float(m.group(1))
    return found


def parse_files(paths):
    merged = {}
    for path in paths:
        text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
        found = {}
        found.update(parse_markers(text))
        found.update({k: v for k, v in parse_util(text).items() if k not in found})
        if "wns" not in found:
            wns = parse_timing_wns(text)
            if wns is not None:
                found["wns"] = wns
        for key, val in found.items():
            merged.setdefault(key, val)
    return merged


def fmt(val, key=None):
    if val is None:
        return "NA"
    if abs(val - round(val)) < 1e-9:
        return "%d" % int(round(val))
    if key == "wns":
        return "%.3f" % val
    return "%.1f" % val


def print_table(before, after):
    print("METRIC                before        after         delta")
    for key in ORDER:
        b = before.get(key)
        a = after.get(key)
        d = (a - b) if (a is not None and b is not None) else None
        print("%-20s %10s %12s %12s" % (LABELS[key], fmt(b, key), fmt(a, key), fmt(d, key)))


def evaluate(after, args):
    gates = [
        ("lut", "max", args.max_lut),
        ("ff", "max", args.max_ff),
        ("slices", "max", args.max_slice),
        ("bram", "max", args.max_bram),
        ("dsp", "min", args.min_dsp),
        ("dsp", "max", args.max_dsp),
        ("wns", "min", args.min_wns),
    ]
    ok = True
    for key, kind, limit in gates:
        if limit is None:
            continue
        val = after.get(key)
        if val is None:
            passed = False
            detail = "missing"
        elif kind == "max":
            passed = val <= limit
            detail = fmt(val, key)
        else:
            passed = val >= limit
            detail = fmt(val, key)
        ok = ok and passed
        print("GATE=%s kind=%s value=%s limit=%s status=%s" % (
            key, kind, detail, fmt(limit, key), "PASS" if passed else "FAIL"))
    return ok


def selftest():
    util = (
        "| Slice LUTs              |  1108 |     0 |    63400 |    1.75% |\n"
        "| Slice Registers         |   400 |     0 |   126800 |    0.32% |\n"
        "| Slice                   |   356 |     0 |    15850 |    2.25% |\n"
        "| Block RAM Tile          |  10.5 |     0 |      135 |    7.78% |\n"
        "| DSPs                    |     1 |     0 |      240 |    0.42% |\n")
    timing = (
        "| WNS(ns) | TNS(ns) | TNS Failing Endpoints |\n"
        "|---------|---------|-----------------------|\n"
        "|   8.827 |   0.000 |                     0 |\n")
    markers = "HEADLESS_LUT=900\nHEADLESS_WNS=-1.250\n"
    tmp = Path(tempfile.mkdtemp(prefix="compare_reports_selftest_"))
    u = tmp / "util.rpt"
    u.write_text(util, encoding="utf-8")
    t = tmp / "timing.rpt"
    t.write_text(timing, encoding="utf-8")
    m = tmp / "metrics.txt"
    m.write_text(markers, encoding="utf-8")
    cases = []

    got = parse_files([str(u), str(t)])
    util_ok = (got.get("lut") == 1108 and got.get("ff") == 400 and got.get("slices") == 356
               and got.get("bram") == 10.5 and got.get("dsp") == 1 and got.get("wns") == 8.827)
    print("SELFTEST_CASE=parse_util_timing status=%s" % ("PASS" if util_ok else "FAIL"))
    cases.append(util_ok)

    got_m = parse_files([str(m)])
    marker_ok = got_m.get("lut") == 900 and got_m.get("wns") == -1.25
    print("SELFTEST_CASE=parse_markers status=%s" % ("PASS" if marker_ok else "FAIL"))
    cases.append(marker_ok)

    ns = argparse.Namespace(max_lut=2000, max_ff=None, max_slice=None, max_bram=None,
                            min_dsp=None, max_dsp=None, min_wns=0.0)
    pass_ok = evaluate(got, ns)
    print("SELFTEST_CASE=gates_pass status=%s" % ("PASS" if pass_ok else "FAIL"))
    cases.append(pass_ok)

    ns2 = argparse.Namespace(max_lut=500, max_ff=None, max_slice=None, max_bram=None,
                             min_dsp=None, max_dsp=None, min_wns=None)
    fail_ok = not evaluate(got, ns2)
    print("SELFTEST_CASE=gate_fail_detected status=%s" % ("PASS" if fail_ok else "FAIL"))
    cases.append(fail_ok)

    ns3 = argparse.Namespace(max_lut=None, max_ff=None, max_slice=None, max_bram=None,
                             min_dsp=None, max_dsp=None, min_wns=0.0)
    neg_ok = not evaluate({"wns": -1.25}, ns3)
    print("SELFTEST_CASE=negative_wns_detected status=%s" % ("PASS" if neg_ok else "FAIL"))
    cases.append(neg_ok)

    ns4 = argparse.Namespace(max_lut=100, max_ff=None, max_slice=None, max_bram=None,
                             min_dsp=None, max_dsp=None, min_wns=None)
    miss_ok = not evaluate({}, ns4)
    print("SELFTEST_CASE=missing_metric_detected status=%s" % ("PASS" if miss_ok else "FAIL"))
    cases.append(miss_ok)

    print("SELFTEST_TMP=%s" % tmp)
    good = all(cases)
    print("SELFTEST_RESULT=%s" % ("PASS" if good else "FAIL"))
    return 0 if good else 1


def main(argv):
    ap = argparse.ArgumentParser(description="Compare Vivado reports before/after and apply gates.")
    ap.add_argument("--before", nargs="+", default=[])
    ap.add_argument("--after", nargs="+", default=[])
    ap.add_argument("--max-lut", type=float, default=None)
    ap.add_argument("--max-ff", type=float, default=None)
    ap.add_argument("--max-slice", type=float, default=None)
    ap.add_argument("--max-bram", type=float, default=None)
    ap.add_argument("--min-dsp", type=float, default=None)
    ap.add_argument("--max-dsp", type=float, default=None)
    ap.add_argument("--min-wns", type=float, default=None)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    if not args.after:
        ap.print_help()
        return 2
    try:
        before = parse_files(args.before) if args.before else {}
        after = parse_files(args.after)
    except OSError as exc:
        print("COMPARE_ERROR=%s" % exc)
        return 2
    print_table(before, after)
    ok = evaluate(after, args)
    print("COMPARE_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
