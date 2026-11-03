#!/usr/bin/env python3
"""run_vivado.py -- launch vivado_headless_verify/synth_verify.tcl without a GUI.

Responsibilities:
  - locate a Vivado executable (--vivado, $VIVADO, PATH)
  - reject TCL files that start with a UTF-8 BOM
  - keep -tclargs as the last argument group
  - retry when the synthesis helper process crashes before RTL is read
  - save the full log and echo the HEADLESS_* metric markers

Exit codes: 0 flow passed, 1 flow failed, 2 usage/IO error.
Python 3 standard library only; no fixed repository paths.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HELPER_CRASH_SIGNS = (
    "rt-undefined",
    "unimacro_verilog.tcl",
    "lib_core.tcl",
    "couldn't read file",
    "can't read file",
)

BOM = b"\xef\xbb\xbf"


def find_vivado(explicit):
    if explicit:
        return explicit
    env = os.environ.get("VIVADO")
    if env:
        return env
    for name in ("vivado", "vivado.bat", "vivado.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def has_bom(path):
    with open(path, "rb") as fh:
        return fh.read(3) == BOM


def build_cmd(vivado, tcl, part, top, sources, xdc, out_dir):
    prefix = [vivado]
    if vivado.lower().endswith((".py", ".pyw")):
        prefix = [sys.executable, vivado]
    cmd = prefix + ["-mode", "batch", "-nolog", "-nojournal", "-source", str(tcl)]
    cmd += ["-tclargs", part, top, str(sources), str(xdc), str(out_dir)]
    return cmd


def tclargs_is_last(cmd):
    try:
        return cmd[-6] == "-tclargs" and len(cmd) - cmd.index("-tclargs") == 6
    except ValueError:
        return False


def read_log(path):
    try:
        return Path(path).read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def is_helper_crash(text):
    low = text.lower()
    return any(sign.lower() in low for sign in HELPER_CRASH_SIGNS)


def echo_markers(text):
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("HEADLESS_"):
            print(s)


def run_flow(vivado, tcl, part, top, sources, xdc, out_dir, retries, delay, quiet=False):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    log_path = out / "vivado.log"
    cmd = build_cmd(vivado, tcl, part, top, sources, xdc, out_dir)
    if not tclargs_is_last(cmd):
        print("RUNNER_RESULT=FAIL")
        print("RUNNER_ERROR=tclargs_not_last")
        return False, 0
    attempts = 0
    last_code = None
    for attempt in range(1, max(1, retries) + 1):
        attempts = attempt
        with open(log_path, "w", encoding="utf-8") as log:
            proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
        last_code = proc.returncode
        text = read_log(log_path)
        if last_code == 0 and "HEADLESS_RESULT=PASS" in text:
            print("RUNNER_LOG=%s" % log_path)
            if not quiet:
                echo_markers(text)
            return True, attempts
        if attempt < retries and is_helper_crash(text):
            print("RUNNER_ATTEMPT=%d status=helper_crash retry=1" % attempt)
            if delay:
                time.sleep(delay)
            continue
        break
    print("RUNNER_LOG=%s" % log_path)
    print("RUNNER_EXIT=%s" % last_code)
    if not quiet:
        echo_markers(read_log(log_path))
    print("RUNNER_RESULT=FAIL")
    return False, attempts


def selftest():
    tmp = Path(tempfile.mkdtemp(prefix="vivado_runner_selftest_"))
    tcl = tmp / "synth_verify.tcl"
    tcl.write_text("puts HEADLESS_RESULT=PASS\n", encoding="utf-8")
    fake = tmp / "fake_vivado.py"
    fake.write_text(
        "import pathlib, sys\n"
        "state = pathlib.Path(__file__).with_name('fake_state.txt')\n"
        "n = int(state.read_text()) if state.exists() else 0\n"
        "n += 1\n"
        "state.write_text(str(n))\n"
        "print('HEADLESS_STEP=synth_done')\n"
        "print('HEADLESS_LUT=10')\n"
        "if n == 1:\n"
        "    sys.stderr.write('invalid command name \"rt-undefined\"\\n')\n"
        "    sys.exit(1)\n"
        "print('HEADLESS_RESULT=PASS')\n",
        encoding="utf-8")
    src = tmp / "src_list.txt"
    src.write_text("top.v\n", encoding="utf-8")
    (tmp / "top.v").write_text("module top; endmodule\n", encoding="utf-8")
    cases = []

    ok, attempts = run_flow(str(fake), str(tcl), "part-none", "top", str(src), "-",
                            str(tmp / "out_retry"), 3, 0, quiet=True)
    state = int((tmp / "fake_state.txt").read_text()) if (tmp / "fake_state.txt").exists() else 0
    print("SELFTEST_CASE=retry_recovers status=%s attempts=%d runs=%d" % (
        "PASS" if (ok and attempts == 2 and state == 2) else "FAIL", attempts, state))
    cases.append(ok and attempts == 2 and state == 2)

    bom_tcl = tmp / "bom.tcl"
    bom_tcl.write_bytes(BOM + b"puts HEADLESS_RESULT=PASS\n")
    bom_ok = has_bom(str(bom_tcl))
    print("SELFTEST_CASE=bom_detected status=%s" % ("PASS" if bom_ok else "FAIL"))
    cases.append(bom_ok)

    cmd = build_cmd(str(fake), str(tcl), "part-none", "top", str(src), "-", str(tmp / "out_dry"))
    dry_ok = tclargs_is_last(cmd) and cmd[-5:] == ["part-none", "top", str(src), "-", str(tmp / "out_dry")]
    print("SELFTEST_CASE=tclargs_last status=%s" % ("PASS" if dry_ok else "FAIL"))
    cases.append(dry_ok)

    ok2, attempts2 = run_flow(str(fake), str(tcl), "part-none", "top", str(src), "-",
                             str(tmp / "out_ok"), 1, 0, quiet=True)
    print("SELFTEST_CASE=clean_pass status=%s attempts=%d" % (
        "PASS" if (ok2 and attempts2 == 1) else "FAIL", attempts2))
    cases.append(ok2 and attempts2 == 1)

    print("SELFTEST_TMP=%s" % tmp)
    good = all(cases)
    print("SELFTEST_RESULT=%s" % ("PASS" if good else "FAIL"))
    return 0 if good else 1


def main(argv):
    ap = argparse.ArgumentParser(description="Headless Vivado synth/opt/place/route runner.")
    ap.add_argument("--tcl", required=False, default=str(Path(__file__).with_name("synth_verify.tcl")))
    ap.add_argument("--part", default="xc7a35tcsg324-1")
    ap.add_argument("--top", default="top")
    ap.add_argument("--sources", default="src_list.txt")
    ap.add_argument("--xdc", default="-")
    ap.add_argument("--out-dir", default="build/headless")
    ap.add_argument("--vivado", default=None)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--retry-delay", type=float, default=20.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    tcl = Path(args.tcl)
    if not tcl.exists():
        print("RUNNER_RESULT=FAIL")
        print("RUNNER_ERROR=tcl_not_found")
        return 2
    if has_bom(str(tcl)):
        print("RUNNER_RESULT=FAIL")
        print("RUNNER_ERROR=bom_in_tcl")
        return 2
    vivado = find_vivado(args.vivado)
    if not vivado:
        if args.dry_run:
            vivado = args.vivado or "vivado"
        else:
            print("RUNNER_RESULT=FAIL")
            print("RUNNER_ERROR=vivado_not_found")
            return 2
    cmd = build_cmd(vivado, tcl, args.part, args.top, args.sources, args.xdc, args.out_dir)
    if args.dry_run:
        print("RUNNER_CMD=%s" % subprocess.list2cmdline(cmd))
        print("RUNNER_TCLARGS_LAST=%d" % (1 if tclargs_is_last(cmd) else 0))
        print("RUNNER_RESULT=DRY_RUN")
        return 0
    ok, _ = run_flow(vivado, tcl, args.part, args.top, args.sources, args.xdc, args.out_dir,
                     args.retries, args.retry_delay)
    print("RUNNER_RESULT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
