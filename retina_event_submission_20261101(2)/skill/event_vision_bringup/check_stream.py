#!/usr/bin/env python3
"""check_stream.py -- offline checks for an event-vision stream.

Subcommands:
  report   read exported CSV/JSON counters and flag the first anomaly
  crc      compute CRC16-CCITT-FALSE for a hex payload
  selftest run built-in clean/broken fixtures and a CRC vector

Inputs (report):
  --events  CSV with columns ts_us,x,y,pol
  --packets CSV with columns seq,crc_ok,len,ts_us
  --stats   JSON object of counters (nested keys joined with dots)

Exit codes: 0 pass, 1 anomaly found, 2 usage/IO error.
Python 3 standard library only.
"""

import argparse
import csv
import json
import re
import sys
import tempfile
from pathlib import Path

MTU_DEFAULT = 1472
STATS_KEY_RE = re.compile(r"(drop|lost|err|fail|bad|overflow|corrupt|missing|timeout)", re.I)


def crc16_ccitt_false(data, init=0xFFFF, poly=0x1021):
    crc = init
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ poly) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def as_int(value, default=None):
    try:
        return int(round(float(str(value).strip())))
    except (TypeError, ValueError):
        return default


def as_bool(value):
    s = str(value).strip().lower()
    return s in ("1", "true", "yes", "ok", "pass")


def check_events(path, width, height, max_gap):
    m = {"rows": 0, "bad_time": 0, "oob": 0, "bad_pol": 0, "max_gap": 0,
         "first_bad_time_ts": "NA", "first_bad_coord": "NA", "first_bad_gap_ts": "NA"}
    prev = None
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            row = {k.strip().lower(): v for k, v in row.items() if k}
            ts = as_int(row.get("ts_us"))
            x = as_int(row.get("x"))
            y = as_int(row.get("y"))
            pol = as_int(row.get("pol"))
            m["rows"] += 1
            if ts is None:
                m["bad_time"] += 1
                continue
            if prev is not None:
                if ts < prev:
                    m["bad_time"] += 1
                    if m["first_bad_time_ts"] == "NA":
                        m["first_bad_time_ts"] = str(ts)
                    continue
                gap = ts - prev
                if gap > m["max_gap"]:
                    m["max_gap"] = gap
                if gap > max_gap and m["first_bad_gap_ts"] == "NA":
                    m["first_bad_gap_ts"] = str(ts)
            prev = ts
            if x is None or y is None or x < 0 or y < 0 or x >= width or y >= height:
                m["oob"] += 1
                if m["first_bad_coord"] == "NA":
                    m["first_bad_coord"] = "%s,%s" % (row.get("x"), row.get("y"))
            if pol not in (0, 1):
                m["bad_pol"] += 1
    m["ok"] = (m["rows"] > 0 and m["bad_time"] == 0 and m["oob"] == 0
               and m["bad_pol"] == 0 and m["first_bad_gap_ts"] == "NA")
    return m


def check_packets(path, mtu, seq_mod):
    m = {"rows": 0, "seq_gaps": 0, "crc_fail": 0, "oversize": 0,
         "first_bad_seq": "NA", "first_crc_fail_seq": "NA", "first_oversize_seq": "NA"}
    prev = None
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            row = {k.strip().lower(): v for k, v in row.items() if k}
            seq = as_int(row.get("seq"))
            m["rows"] += 1
            if seq is None:
                m["seq_gaps"] += 1
                continue
            if prev is not None and seq_mod > 0:
                step = (seq - prev) % seq_mod
                if step != 1:
                    m["seq_gaps"] += 1
                    if m["first_bad_seq"] == "NA":
                        m["first_bad_seq"] = str(seq)
            prev = seq
            if not as_bool(row.get("crc_ok")):
                m["crc_fail"] += 1
                if m["first_crc_fail_seq"] == "NA":
                    m["first_crc_fail_seq"] = str(seq)
            length = as_int(row.get("len"))
            if length is not None and length > mtu:
                m["oversize"] += 1
                if m["first_oversize_seq"] == "NA":
                    m["first_oversize_seq"] = str(seq)
    m["ok"] = (m["rows"] > 0 and m["seq_gaps"] == 0 and m["crc_fail"] == 0 and m["oversize"] == 0)
    return m


def flatten(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for key, val in obj.items():
            name = "%s.%s" % (prefix, key) if prefix else str(key)
            out.update(flatten(val, name))
    else:
        out[prefix] = obj
    return out


def check_stats(path, allow):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    flat = flatten(data)
    bad = []
    for key, val in flat.items():
        if not STATS_KEY_RE.search(key):
            continue
        num = val if isinstance(val, (int, float)) else as_int(val)
        if num is None or num == 0:
            continue
        if key in allow:
            continue
        bad.append("%s=%s" % (key, num))
    return {"keys": len(flat), "nonzero": len(bad), "list": ",".join(bad), "ok": len(bad) == 0}


def print_events(m):
    print("EVENTS_ROWS=%d" % m["rows"])
    print("EVENTS_BAD_TIME=%d first_bad_ts=%s" % (m["bad_time"], m["first_bad_time_ts"]))
    print("EVENTS_OUT_OF_RANGE=%d first_bad_coord=%s" % (m["oob"], m["first_bad_coord"]))
    print("EVENTS_BAD_POL=%d" % m["bad_pol"])
    print("EVENTS_MAX_GAP_US=%d first_gap_ts=%s" % (m["max_gap"], m["first_bad_gap_ts"]))
    print("EVENTS_RESULT=%s" % ("PASS" if m["ok"] else "FAIL"))


def print_packets(m):
    print("PACKETS_ROWS=%d" % m["rows"])
    print("PACKETS_SEQ_GAPS=%d first_bad_seq=%s" % (m["seq_gaps"], m["first_bad_seq"]))
    print("PACKETS_CRC_FAIL=%d first_crc_fail_seq=%s" % (m["crc_fail"], m["first_crc_fail_seq"]))
    print("PACKETS_OVERSIZE=%d first_oversize_seq=%s" % (m["oversize"], m["first_oversize_seq"]))
    print("PACKETS_RESULT=%s" % ("PASS" if m["ok"] else "FAIL"))


def print_stats(m):
    print("STATS_KEYS=%d" % m["keys"])
    print("STATS_NONZERO=%d" % m["nonzero"])
    if m["list"]:
        print("STATS_NONZERO_LIST=%s" % m["list"])
    print("STATS_RESULT=%s" % ("PASS" if m["ok"] else "FAIL"))


EVENTS_CLEAN = "ts_us,x,y,pol\n1000,10,20,1\n1100,11,20,0\n1500,12,21,1\n"
EVENTS_BAD = "ts_us,x,y,pol\n1000,10,20,1\n900,11,20,0\n1200,500,20,1\n1300,12,21,2\n900000,13,21,1\n"
PACKETS_CLEAN = "seq,crc_ok,len,ts_us\n1,1,100,1000\n2,1,120,1100\n3,1,140,1200\n"
PACKETS_BAD = "seq,crc_ok,len,ts_us\n1,1,100,1000\n4,0,2000,1100\n5,1,140,1200\n"


def selftest():
    tmp = Path(tempfile.mkdtemp(prefix="check_stream_selftest_"))
    cases = []

    p = tmp / "events_clean.csv"
    p.write_text(EVENTS_CLEAN, encoding="utf-8")
    m = check_events(str(p), 400, 240, 100000)
    print("SELFTEST_CASE=events_clean status=%s" % ("PASS" if m["ok"] else "FAIL"))
    cases.append(m["ok"])

    p = tmp / "events_bad.csv"
    p.write_text(EVENTS_BAD, encoding="utf-8")
    m = check_events(str(p), 400, 240, 100000)
    good = (not m["ok"]) and m["bad_time"] >= 1 and m["oob"] >= 1 and m["bad_pol"] >= 1 and m["first_bad_gap_ts"] != "NA"
    print("SELFTEST_CASE=events_bad_detected status=%s bad_time=%d oob=%d bad_pol=%d" % (
        "PASS" if good else "FAIL", m["bad_time"], m["oob"], m["bad_pol"]))
    cases.append(good)

    p = tmp / "packets_clean.csv"
    p.write_text(PACKETS_CLEAN, encoding="utf-8")
    m = check_packets(str(p), MTU_DEFAULT, 65536)
    print("SELFTEST_CASE=packets_clean status=%s" % ("PASS" if m["ok"] else "FAIL"))
    cases.append(m["ok"])

    p = tmp / "packets_bad.csv"
    p.write_text(PACKETS_BAD, encoding="utf-8")
    m = check_packets(str(p), MTU_DEFAULT, 65536)
    good = (not m["ok"]) and m["seq_gaps"] >= 1 and m["crc_fail"] >= 1 and m["oversize"] >= 1
    print("SELFTEST_CASE=packets_bad_detected status=%s gaps=%d crc=%d oversize=%d" % (
        "PASS" if good else "FAIL", m["seq_gaps"], m["crc_fail"], m["oversize"]))
    cases.append(good)

    p = tmp / "stats_clean.json"
    p.write_text(json.dumps({"rx": {"ok": 10, "drop": 0}, "crc_fail": 0}), encoding="utf-8")
    m = check_stats(str(p), set())
    print("SELFTEST_CASE=stats_clean status=%s" % ("PASS" if m["ok"] else "FAIL"))
    cases.append(m["ok"])

    p = tmp / "stats_bad.json"
    p.write_text(json.dumps({"rx": {"drop": 3}, "crc_fail": 2, "tx_ok": 5}), encoding="utf-8")
    m = check_stats(str(p), set())
    good = (not m["ok"]) and m["nonzero"] == 2
    print("SELFTEST_CASE=stats_bad_detected status=%s nonzero=%d" % ("PASS" if good else "FAIL", m["nonzero"]))
    cases.append(good)

    vector = crc16_ccitt_false(b"123456789")
    good = vector == 0x29B1
    print("SELFTEST_CASE=crc_vector status=%s crc=0x%04X want=0x29B1" % ("PASS" if good else "FAIL", vector))
    cases.append(good)

    p = tmp / "payload.hex"
    p.write_text("313233343536373839", encoding="utf-8")
    parsed = bytes.fromhex(p.read_text().strip())
    good = crc16_ccitt_false(parsed) == 0x29B1
    print("SELFTEST_CASE=crc_hex_parse status=%s" % ("PASS" if good else "FAIL"))
    cases.append(good)

    print("SELFTEST_TMP=%s" % tmp)
    ok = all(cases)
    print("SELFTEST_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def cmd_report(args):
    if not (args.events or args.packets or args.stats):
        print("STREAM_ERROR=no_input")
        return 2
    ok = True
    try:
        if args.events:
            m = check_events(args.events, args.width, args.height, args.max_gap_us)
            print_events(m)
            ok = ok and m["ok"]
        if args.packets:
            m = check_packets(args.packets, args.mtu, args.seq_mod)
            print_packets(m)
            ok = ok and m["ok"]
        if args.stats:
            m = check_stats(args.stats, set(args.allow_key or []))
            print_stats(m)
            ok = ok and m["ok"]
    except (OSError, json.JSONDecodeError, csv.Error) as exc:
        print("STREAM_ERROR=%s" % exc)
        return 2
    print("STREAM_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def cmd_crc(args):
    raw = args.hex.strip().lower().replace("0x", "").replace(" ", "").replace(":", "")
    try:
        data = bytes.fromhex(raw)
    except ValueError as exc:
        print("CRC_ERROR=%s" % exc)
        return 2
    crc = crc16_ccitt_false(data, args.init, args.poly)
    print("CRC16=0x%04X" % crc)
    print("CRC_BYTES=%d" % len(data))
    return 0


def main(argv):
    if argv and argv[0] == "--selftest":
        return selftest()
    ap = argparse.ArgumentParser(description="Offline checks for an event-vision stream.")
    sub = ap.add_subparsers(dest="cmd")

    pr = sub.add_parser("report")
    pr.add_argument("--events")
    pr.add_argument("--packets")
    pr.add_argument("--stats")
    pr.add_argument("--width", type=int, default=400)
    pr.add_argument("--height", type=int, default=240)
    pr.add_argument("--max-gap-us", type=int, default=100000)
    pr.add_argument("--mtu", type=int, default=MTU_DEFAULT)
    pr.add_argument("--seq-mod", type=int, default=65536)
    pr.add_argument("--allow-key", action="append", default=[])

    pc = sub.add_parser("crc")
    pc.add_argument("--hex", required=True)
    pc.add_argument("--init", type=lambda x: int(x, 0), default=0xFFFF)
    pc.add_argument("--poly", type=lambda x: int(x, 0), default=0x1021)

    sub.add_parser("selftest")
    args = ap.parse_args(argv)
    if args.cmd == "report":
        return cmd_report(args)
    if args.cmd == "crc":
        return cmd_crc(args)
    if args.cmd == "selftest":
        return selftest()
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
