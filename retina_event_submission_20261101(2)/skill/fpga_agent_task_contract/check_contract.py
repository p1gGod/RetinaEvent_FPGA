#!/usr/bin/env python3
"""check_contract.py -- lint an agent task contract and its evidence log.

Two independent checks:
  contract <file>            required sections and a machine-readable marker
  evidence <log> [<log>...]  first-line marker, CHECK PASS/FAIL counts, TEST_RESULT

Exit codes: 0 = pass, 1 = fail, 2 = usage or IO error.
Python 3 standard library only; no fixed repository paths.
"""

import argparse
import re
import sys
import tempfile
from pathlib import Path

REQUIRED_SECTIONS = (
    ("goal", "目标"),
    ("machine", "机读判据"),
    ("whitelist", "白名单"),
    ("forbidden", "禁忌"),
    ("deliverables", "产出物"),
)
MARKER_RE = re.compile(r"^([A-Z][A-Z0-9_]{2,})=1$")
CHECK_RE = re.compile(r"^CHECK=\s*([A-Za-z0-9_.:\-]+)\s+(PASS|FAIL)$")
RESULT_RE = re.compile(r"^TEST_RESULT=(PASS|FAIL)$")
HEADING_RE = re.compile(r"^(#{1,3})\s+(.+?)\s*$")


def norm_line(line):
    """Drop common log prefixes so simulator output can be copied verbatim."""
    return re.sub(r"^[#;>]\s*", "", line.strip())


def read_text(path):
    return Path(path).read_text(encoding="utf-8-sig", errors="replace")


def find_section(text, keyword):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = HEADING_RE.match(line)
        if not m or keyword not in m.group(2):
            continue
        level = len(m.group(1))
        body = []
        for nxt in lines[i + 1:]:
            m2 = HEADING_RE.match(nxt)
            if m2 and len(m2.group(1)) <= level:
                break
            body.append(nxt)
        return "\n".join(body)
    return None


def bullet_count(body):
    return sum(1 for line in body.splitlines() if line.strip().startswith(("-", "*")))


def check_contract(path):
    text = read_text(path)
    ok = True
    bodies = {}
    for key, keyword in REQUIRED_SECTIONS:
        body = find_section(text, keyword)
        good = body is not None and body.strip() != ""
        bodies[key] = body or ""
        print("CONTRACT_SECTION=%s status=%s" % (key, "PASS" if good else "FAIL"))
        ok = ok and good
    marker = None
    m = re.search(r"([A-Z][A-Z0-9_]{2,})=1", bodies.get("machine", ""))
    if m:
        marker = m.group(1)
    print("CONTRACT_MARKER=%s" % (marker or "MISSING"))
    ok = ok and marker is not None
    for key in ("whitelist", "forbidden", "deliverables"):
        n = bullet_count(bodies.get(key, ""))
        good = n >= 1
        print("CONTRACT_BULLETS=%s count=%d status=%s" % (key, n, "PASS" if good else "FAIL"))
        ok = ok and good
    print("CONTRACT_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return ok, marker


def check_evidence(paths, expect_marker, min_checks):
    ok = True
    total_pass = 0
    total_fail = 0
    for path in paths:
        text = read_text(path)
        lines = [norm_line(x) for x in text.splitlines() if norm_line(x) != ""]
        marker = None
        first = lines[0] if lines else ""
        m = MARKER_RE.match(first)
        if m:
            marker = m.group(1)
        marker_ok = marker is not None and (expect_marker is None or marker == expect_marker)
        checks = []
        result = None
        for line in lines:
            mc = CHECK_RE.match(line)
            if mc:
                checks.append((mc.group(1), mc.group(2)))
            mr = RESULT_RE.match(line)
            if mr:
                result = mr.group(1)
        npass = sum(1 for _, s in checks if s == "PASS")
        nfail = sum(1 for _, s in checks if s == "FAIL")
        result_ok = result == "PASS"
        count_ok = npass >= min_checks
        log_ok = marker_ok and result_ok and nfail == 0 and count_ok
        print("EVIDENCE_LOG=%s marker=%s checks_pass=%d checks_fail=%d test_result=%s status=%s" % (
            Path(path).name, marker or "MISSING", npass, nfail, result or "MISSING",
            "PASS" if log_ok else "FAIL"))
        if nfail:
            print("EVIDENCE_FAILED_CHECKS=%s" % ",".join(n for n, s in checks if s == "FAIL"))
        total_pass += npass
        total_fail += nfail
        ok = ok and log_ok
    print("EVIDENCE_TOTAL pass=%d fail=%d" % (total_pass, total_fail))
    print("EVIDENCE_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return ok


GOOD_CONTRACT = """# Task contract: blinker demo

## 1 目标（可验收）
- 交付 4 位闪烁计数器模块与配套 testbench。

## 2 机读判据
- 证据首行：BLINKER_OK=1
- 全部 CHECK 行 PASS，末行 TEST_RESULT=PASS。

## 3 白名单
- src/blinker.v
- sim/tb_blinker.v

## 4 禁忌
- 不得修改顶层工程文件。

## 5 产出物
- src/blinker.v
- sim/tb_blinker.v
"""

GOOD_EVIDENCE = """BLINKER_OK=1
CHECK=BLINK_PERIOD PASS
CHECK=BLINK_RESET PASS
TEST_RESULT=PASS
"""


def selftest():
    tmp = Path(tempfile.mkdtemp(prefix="contract_selftest_"))
    cases = []
    contract_good = tmp / "contract_good.md"
    contract_good.write_text(GOOD_CONTRACT, encoding="utf-8")
    cases.append(("contract_good", check_contract(str(contract_good))[0], True))

    contract_bad = tmp / "contract_bad.md"
    contract_bad.write_text(GOOD_CONTRACT.replace("## 3 白名单", "## 3 removed"), encoding="utf-8")
    cases.append(("contract_missing_whitelist", check_contract(str(contract_bad))[0], False))

    ev_good = tmp / "evidence_good.log"
    ev_good.write_text(GOOD_EVIDENCE, encoding="utf-8")
    cases.append(("evidence_good", check_evidence([str(ev_good)], "BLINKER_OK", 1), True))

    ev_nomark = tmp / "evidence_nomark.log"
    ev_nomark.write_text("CHECK=A PASS\nTEST_RESULT=PASS\n", encoding="utf-8")
    cases.append(("evidence_missing_marker", check_evidence([str(ev_nomark)], None, 1), False))

    ev_fail = tmp / "evidence_fail.log"
    ev_fail.write_text("BLINKER_OK=1\nCHECK=A PASS\nCHECK=B FAIL\nTEST_RESULT=FAIL\n", encoding="utf-8")
    cases.append(("evidence_check_fail", check_evidence([str(ev_fail)], None, 1), False))

    ev_zero = tmp / "evidence_zero.log"
    ev_zero.write_text("BLINKER_OK=1\nTEST_RESULT=PASS\n", encoding="utf-8")
    cases.append(("evidence_no_checks", check_evidence([str(ev_zero)], None, 1), False))

    print("SELFTEST_TMP=%s" % tmp)
    all_ok = True
    for name, got, want in cases:
        good = got == want
        all_ok = all_ok and good
        print("SELFTEST_CASE=%s status=%s want=%s got=%s" % (name, "PASS" if good else "FAIL", want, got))
    print("SELFTEST_RESULT=%s" % ("PASS" if all_ok else "FAIL"))
    return 0 if all_ok else 1


def main(argv):
    if argv and argv[0] == "--selftest":
        return selftest()
    ap = argparse.ArgumentParser(description="Validate an agent task contract or its evidence log.")
    sub = ap.add_subparsers(dest="cmd")
    pc = sub.add_parser("contract")
    pc.add_argument("file")
    pe = sub.add_parser("evidence")
    pe.add_argument("logs", nargs="+")
    pe.add_argument("--expect-marker", default=None)
    pe.add_argument("--min-checks", type=int, default=1)
    sub.add_parser("selftest")
    args = ap.parse_args(argv)
    if args.cmd == "contract":
        try:
            ok, _ = check_contract(args.file)
            return 0 if ok else 1
        except OSError as exc:
            print("CONTRACT_ERROR=%s" % exc)
            return 2
    if args.cmd == "evidence":
        try:
            ok = check_evidence(args.logs, args.expect_marker, args.min_checks)
            return 0 if ok else 1
        except OSError as exc:
            print("EVIDENCE_ERROR=%s" % exc)
            return 2
    if args.cmd == "selftest":
        return selftest()
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
