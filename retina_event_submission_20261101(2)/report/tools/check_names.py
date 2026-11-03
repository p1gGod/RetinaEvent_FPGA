#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提交工程包的命名 / 体积 / 清单检查器。

用途：
  * 遍历一个目录树，检查所有目录名与文件名是否符合比赛官方命名规则
    （默认 ^[a-z0-9_][a-z0-9._-]*$，允许首位下划线/数字；含扩展名大小写，.MD / .PNG 都算违规）。
  * 输出 BADNAME <相对路径>，供 pack_submission.ps1 汇总。
  * 可选检查单个文件是否超过 --max-bytes，超限打印 SKIP <相对路径> <字节>。
  * 可选生成排序后的“相对路径|字节数”清单并打印 TREE_HASH=<sha256>。

退出码：
  0  名称合规且没有超限文件
  1  存在 BADNAME
  2  仅存在超限文件（名称合规）

注意：任务 (b) 强制要求根 README.md 与 skill/README.md 两个大小写混合的约定文件名，
与 (c) 的全小写规则天然冲突。默认对这两个路径做显式例外并由 --exceptions 传入；
.MD 等扩展名大小写违规不会被例外。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


DEFAULT_NAME_REGEX = r"^[a-z0-9_][a-z0-9._-]*$"
DEFAULT_MAX_BYTES = 20 * 1024 * 1024


def _utf8_stdout() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass


def _rel_posix(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _iter_entries(root: Path):
    """Yield (relative path, is_dir, size or None) in a stable order."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        filenames.sort()
        current = Path(dirpath)
        if current != root:
            yield _rel_posix(root, current), True, None
        for name in filenames:
            child = current / name
            try:
                size = child.stat().st_size
            except OSError:
                size = None
            yield _rel_posix(root, child), False, size


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="检查提交工程包的命名、单文件体积并生成稳定清单哈希。",
    )
    parser.add_argument("--root", required=True, help="待检查的目录（输出树根）")
    parser.add_argument("--name-regex", default=DEFAULT_NAME_REGEX, help="目录/文件名正则（默认官方小写规则）")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help="单文件体积上限；0 表示不检查")
    parser.add_argument("--manifest", default="", help="写出排序后的 '相对路径|字节数' 清单")
    parser.add_argument("--json", default="", help="写出机器可读摘要 JSON")
    parser.add_argument(
        "--exceptions",
        default="",
        help="逗号分隔的精确相对路径例外（仅用于任务强制的 README.md / skill/README.md）",
    )
    args = parser.parse_args(argv)

    _utf8_stdout()
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"ERROR root not found: {root}")
        return 3

    try:
        name_re = re.compile(args.name_regex)
    except re.error as exc:
        print(f"ERROR bad name regex: {exc}")
        return 3

    exceptions = {item.strip().replace("\\", "/") for item in args.exceptions.split(",") if item.strip()}
    entries: list[tuple[str, bool, int | None]] = list(_iter_entries(root))
    files = [(rel, size) for rel, is_dir, size in entries if not is_dir]
    files.sort(key=lambda item: item[0])

    bad: list[str] = []
    skipped_large: list[tuple[str, int]] = []
    exception_hits: list[str] = []

    for rel, is_dir, size in entries:
        if rel in exceptions:
            exception_hits.append(rel)
            print(f"NAME_EXCEPTION {rel}")
            continue
        leaf = rel.rsplit("/", 1)[-1]
        if not name_re.fullmatch(leaf):
            bad.append(rel)
            print(f"BADNAME {rel}")

    if args.max_bytes and args.max_bytes > 0:
        for rel, size in files:
            if size is not None and size > args.max_bytes:
                skipped_large.append((rel, size))
                print(f"SKIP {rel} {size}")

    manifest_hash = ""
    if args.manifest:
        manifest_path = Path(args.manifest)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        body = "".join(f"{rel}|{size if size is not None else 0}\n" for rel, size in files)
        data = body.encode("utf-8")
        manifest_path.write_bytes(data)
        manifest_hash = hashlib.sha256(data).hexdigest()
        print(f"MANIFEST {manifest_path}")
        print(f"TREE_HASH={manifest_hash}")

    total = len(entries)
    print(f"NAMECHECK entries={total} bad={len(bad)} skipped={len(skipped_large)}")
    if exception_hits:
        print(f"NAME_EXCEPTIONS={','.join(exception_hits)}")

    if args.json:
        summary = {
            "root": str(root),
            "entries": total,
            "files": len(files),
            "bad": bad,
            "skipped_large": [{"path": rel, "bytes": size} for rel, size in skipped_large],
            "name_exceptions": exception_hits,
            "tree_hash": manifest_hash,
            "max_bytes": args.max_bytes,
            "name_regex": args.name_regex,
        }
        json_path = Path(args.json)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"JSON {json_path}")

    if bad:
        return 1
    if skipped_large:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
