#!/usr/bin/env python3
"""check_readme.py -- validate the skill package layout and the five README sections.

Checks:
  - top-level README exists and lists every item with an overview table
  - every item README has five non-empty sections: 适用范围 / 使用方法 / 已验证效果 / 失效条件 / 来源
  - directory and file names use lowercase letters, digits, underscore, hyphen, dot
  - scripts contain no absolute repository paths from this workspace
  - every item ships at least one script with --selftest or --dry-run

Prints SKILL_README_SCHEMA_OK=1 on success; exits 0 pass, 1 fail.
Python 3 standard library only; the package root is derived from this file.
"""

import re
import sys
from pathlib import Path

ITEMS = ("fpga_agent_task_contract", "vivado_headless_verify", "event_vision_bringup")
SECTIONS = ("适用范围", "使用方法", "已验证效果", "失效条件", "来源")
ALLOWED_TOP = {"README.md", "EVIDENCE_SKILL_OK.log"}
NAME_RE = re.compile(r"^[a-z0-9_][a-z0-9_.-]*$")
SCRIPT_SUFFIXES = {".py", ".tcl", ".ps1", ".sh", ".cmd", ".bat", ".mjs"}
FORBIDDEN_TEXT = (
    re.compile(r"[A-Za-z]:[\\/]"),
    re.compile(r"(?<![\w])/(?:home|Users|workspace|mnt|opt)/", re.I),
    re.compile(r"\\\\[A-Za-z0-9_.-]+\\\\"),
)


def sections_of(text):
    lines = text.splitlines()
    heads = []
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,3})\s+(.+?)\s*$", line)
        if m:
            heads.append((i, len(m.group(1)), m.group(2)))
    out = {}
    for idx, (i, level, title) in enumerate(heads):
        end = len(lines)
        for j, lv, _ in heads[idx + 1:]:
            if lv <= level:
                end = j
                break
        body = "\n".join(lines[i + 1:end]).strip()
        out[title] = body
    return out


def check_item(root, item):
    ok = True
    readme = root / item / "README.md"
    if not readme.exists():
        print("SCHEMA_ITEM=%s status=FAIL reason=missing_readme" % item)
        return False
    text = readme.read_text(encoding="utf-8-sig", errors="replace")
    sections = sections_of(text)
    for name in SECTIONS:
        body = ""
        for title, content in sections.items():
            if name in title:
                body = content
                break
        good = body.strip() != ""
        print("SCHEMA_SECTION=%s/%s status=%s" % (item, name, "PASS" if good else "FAIL"))
        ok = ok and good
    scripts = [p for p in (root / item).rglob("*") if p.is_file() and p.suffix in SCRIPT_SUFFIXES]
    has_hook = False
    for p in scripts:
        data = p.read_text(encoding="utf-8-sig", errors="replace")
        if "--selftest" in data or "--dry-run" in data:
            has_hook = True
        for rx in FORBIDDEN_TEXT:
            if rx.search(data):
                print("SCHEMA_FORBIDDEN_PATH=%s/%s pattern=%s" % (item, p.name, rx.pattern))
                ok = False
    print("SCHEMA_HOOK=%s status=%s" % (item, "PASS" if has_hook else "FAIL"))
    ok = ok and has_hook
    return ok


def main(_argv):
    root = Path(__file__).resolve().parent.parent
    ok = True
    top = root / "README.md"
    if not top.exists():
        print("SCHEMA_TOP status=FAIL reason=missing")
        print("SKILL_README_SCHEMA_OK=0")
        return 1
    top_text = top.read_text(encoding="utf-8-sig", errors="replace")
    for item in ITEMS:
        has_name = item in top_text
        print("SCHEMA_TOP_ITEM=%s status=%s" % (item, "PASS" if has_name else "FAIL"))
        ok = ok and has_name
    has_table = "| 技能项 |" in top_text
    print("SCHEMA_TOP_TABLE status=%s" % ("PASS" if has_table else "FAIL"))
    ok = ok and has_table

    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        parts = rel.parts
        if p.name in ALLOWED_TOP:
            continue
        if not NAME_RE.match(p.name):
            print("SCHEMA_BAD_NAME=%s" % rel.as_posix())
            ok = False

    for item in ITEMS:
        if not (root / item).is_dir():
            print("SCHEMA_ITEM=%s status=FAIL reason=missing_dir" % item)
            ok = False
            continue
        ok = check_item(root, item) and ok

    print("SKILL_README_SCHEMA_OK=%d" % (1 if ok else 0))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
