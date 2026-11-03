#!/usr/bin/env python3
"""run_selfchecks.py -- run every item self-test from an empty temporary directory
and write skill/_check/EVIDENCE_SKILL_OK.log with real captured output.

The log starts with SKILL_PKG_OK=1 only when every check passed.
Exit codes: 0 all pass, 1 a check failed, 2 package layout problem.
Python 3 standard library only; package root is derived from this file.
"""

import datetime
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def build_checks(tmp):
    item = ROOT / "fpga_agent_task_contract"
    hv = ROOT / "vivado_headless_verify"
    ev = ROOT / "event_vision_bringup"
    ex = ev / "examples"
    return [
        ("contract_selftest", "fpga_agent_task_contract/check_contract.py",
         ["--selftest"], 0, ["SELFTEST_RESULT=PASS"]),
        ("contract_example", "fpga_agent_task_contract/check_contract.py",
         ["contract", str(item / "examples" / "contract_led_blink.md")], 0, ["CONTRACT_RESULT=PASS"]),
        ("evidence_example", "fpga_agent_task_contract/check_contract.py",
         ["evidence", str(item / "examples" / "evidence_led_blink.log"), "--min-checks", "3"],
         0, ["EVIDENCE_RESULT=PASS"]),
        ("evidence_negative", "fpga_agent_task_contract/check_contract.py",
         ["evidence", str(item / "examples" / "evidence_led_blink_fail.log"), "--min-checks", "3"],
         1, ["EVIDENCE_RESULT=FAIL"]),
        ("runner_selftest", "vivado_headless_verify/run_vivado.py",
         ["--selftest"], 0, ["SELFTEST_RESULT=PASS"]),
        ("runner_dryrun", "vivado_headless_verify/run_vivado.py",
         ["--dry-run", "--part", "xc7a35tcsg324-1", "--top", "blinky",
          "--sources", "src_list.txt", "--xdc", "-", "--out-dir", str(tmp / "dry")],
         0, ["RUNNER_RESULT=DRY_RUN", "RUNNER_TCLARGS_LAST=1"]),
        ("compare_selftest", "vivado_headless_verify/compare_reports.py",
         ["--selftest"], 0, ["SELFTEST_RESULT=PASS"]),
        ("stream_selftest", "event_vision_bringup/check_stream.py",
         ["--selftest"], 0, ["SELFTEST_RESULT=PASS"]),
        ("stream_clean", "event_vision_bringup/check_stream.py",
         ["report", "--events", str(ex / "events_clean.csv"),
          "--packets", str(ex / "packets_clean.csv"),
          "--stats", str(ex / "stats_clean.json")],
         0, ["STREAM_RESULT=PASS"]),
        ("stream_negative", "event_vision_bringup/check_stream.py",
         ["report", "--events", str(ex / "events_bad.csv"),
          "--packets", str(ex / "packets_bad.csv"),
          "--stats", str(ex / "stats_bad.json")],
         1, ["STREAM_RESULT=FAIL"]),
        ("crc_vector", "event_vision_bringup/check_stream.py",
         ["crc", "--hex", "313233343536373839"], 0, ["CRC16=0x29B1"]),
    ]


def display_args(script_rel, argv):
    shown = []
    for arg in argv:
        text = str(arg)
        try:
            rel = Path(text).resolve().relative_to(ROOT)
            shown.append(rel.as_posix())
        except (ValueError, OSError):
            shown.append(text)
    return "python %s %s" % (script_rel, " ".join(shown))


def run_check(label, script_rel, argv, expect_rc, markers, cwd):
    script = ROOT / script_rel
    proc = subprocess.run([PY, str(script)] + [str(a) for a in argv], cwd=str(cwd),
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or "") + (proc.stderr or "")
    ok = proc.returncode == expect_rc and all(m in out for m in markers)
    return {
        "label": label,
        "display": display_args(script_rel, argv),
        "rc": proc.returncode,
        "ok": ok,
        "out": out.rstrip("\n"),
        "markers": markers,
    }


def main(_argv):
    if not (ROOT / "_check").is_dir():
        print("SELFCHECK_ERROR=missing_check_dir")
        return 2
    tmp = Path(tempfile.mkdtemp(prefix="skill_selftest_"))
    results = []
    for label, script_rel, argv, expect_rc, markers in build_checks(tmp):
        result = run_check(label, script_rel, argv, expect_rc, markers, tmp)
        results.append(result)
        print("SELFCHECK=%s exit=%d status=%s" % (
            label, result["rc"], "PASS" if result["ok"] else "FAIL"))
        if not result["ok"]:
            print(result["out"][-2000:])
    schema = run_check("readme_schema", "_check/check_readme.py", [], 0,
                       ["SKILL_README_SCHEMA_OK=1"], tmp)
    results.append(schema)
    print("SELFCHECK=%s exit=%d status=%s" % (
        schema["label"], schema["rc"], "PASS" if schema["ok"] else "FAIL"))

    all_ok = all(r["ok"] for r in results)
    if not all_ok:
        print("SKILL_PKG_OK=0")
        print("SELFCHECK_FAILED=%d" % sum(1 for r in results if not r["ok"]))
        return 1

    lines = [
        "SKILL_PKG_OK=1",
        "generated=%s" % datetime.datetime.now().isoformat(timespec="seconds"),
        "package=skill",
        "python=%s" % Path(PY).name,
        "cwd=empty temporary directory per check",
        "scope=each item self-test plus schema check",
        "",
    ]
    for r in results:
        lines.append("## %s" % r["label"])
        lines.append("$ %s" % r["display"])
        lines.append("exit=%d" % r["rc"])
        body = r["out"].splitlines()
        if len(body) > 40:
            body = body[:20] + ["..."] + body[-19:]
        lines.extend(body)
        lines.append("")
    log_path = ROOT / "_check" / "EVIDENCE_SKILL_OK.log"
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("EVIDENCE_LOG=%s" % log_path.relative_to(ROOT).as_posix())
    print("SELFCHECK_RESULT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
