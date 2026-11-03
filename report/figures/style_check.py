# -*- coding: utf-8 -*-
"""M9d 文风与结构自查：禁用词、字数、章节、图表引用、表格来源列。
运行：nn/.venv/Scripts/python.exe report/figures/style_check.py
末行输出 STYLE_CHECK_OK=1；任一不满足即退出 1。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "report/evaluation_report.md"
CHAPTERS = [
    "结论先行", "测试平台与环境", "数据与标签来源", "v5 实机评测",
    "v7 离线评测", "资源与时序", "与基线对比", "局限与不可复现的部分",
]
BANNED = [
    "首先", "其次", "最后", "值得注意的是", "不难发现", "众所周知",
    "赋能", "打造", "助力", "闭环", "痛点", "一站式", "多维度",
    "显著提升", "极大地", "大幅", "完美", "我们认为", "笔者以为",
    "可以说", "综上", "总而言之", "智能识别", "硬件加速口号",
]
FAILS = []


def fail(msg):
    FAILS.append(msg)
    print("FAIL " + msg)


if not REPORT.exists():
    print("STYLE_FAIL missing report/evaluation_report.md")
    sys.exit(1)
text = REPORT.read_text(encoding="utf-8")
lines = text.splitlines()

# 1) 禁用词（逐行定位）
banned_hits = []
for no, line in enumerate(lines, 1):
    for word in BANNED:
        if word in line:
            banned_hits.append((no, word, line.strip()[:120]))
if banned_hits:
    for no, word, snippet in banned_hits:
        fail("banned word %r at line %d: %s" % (word, no, snippet))
else:
    print("STYLE OK banned_words=0")

# 对比结构
pat = re.compile(r"不是[^。；\n]{0,24}而是")
for m in pat.finditer(text):
    no = text[:m.start()].count("\n") + 1
    fail("banned construction 不是...而是... at line %d" % no)
if not pat.search(text):
    print("STYLE OK contrast_construction=0")

# 感叹号
for ch, name in [("！", "fullwidth exclamation"), ("!", "ascii exclamation")]:
    if ch in text:
        no = text[:text.index(ch)].count("\n") + 1
        fail("%s at line %d" % (name, no))
print("STYLE OK exclamation=0")

# 2) 字数（中文字符）
cn = len(re.findall(r"[\u4e00-\u9fff]", text))
print("STYLE chars_cn=%d" % cn)
if cn < 6000:
    fail("Chinese chars=%d < 6000" % cn)

# 3) 八章
heads = [l.strip() for l in lines if l.startswith("## ")]
print("STYLE headings=%d" % len(heads))
for i, name in enumerate(CHAPTERS, 1):
    if not any(re.match(r"##\s*%d[\.、]" % i, h) and name in h for h in heads):
        fail("missing chapter %d %s" % (i, name))

# 4) 图 F1..F12 全部被正文引用
for i in range(1, 13):
    if not re.search(r"图\s*F%d\b" % i, text):
        fail("figure F%d not referenced" % i)
print("STYLE OK figure_refs=12")

# 5) 表格必须有“数据来源”列
table_headers = []
for no, line in enumerate(lines, 1):
    s = line.strip()
    if s.startswith("|") and s.endswith("|") and re.search(r"数据来源", s):
        table_headers.append(no)
if not table_headers:
    fail("no markdown table with 数据来源 column")
else:
    print("STYLE OK source_tables=%d lines=%s" % (len(table_headers), ",".join(map(str, table_headers))))

# 6) 单句长度（按句号/问号切分；中文计字）
sents = [s.strip() for s in re.split(r"[。！？\n]", text) if s.strip()]
long_sents = []
for s in sents:
    if s.startswith("#") or s.startswith("|") or s.startswith(chr(96) * 3):
        continue
    n = len(re.findall(r"[\u4e00-\u9fff]", s))
    if n > 60:
        long_sents.append((n, s[:90]))
if long_sents:
    for n, s in long_sents[:12]:
        fail("sentence too long (%d chars): %s" % (n, s))
else:
    print("STYLE OK max_sentence_cn<=60")

# 7) 段落句数（普通正文段，3~5 句）
paras = []
buf = []
for line in lines + [""]:
    s = line.strip()
    if not s:
        if buf:
            paras.append(" ".join(buf))
            buf = []
        continue
    if s.startswith("#") or s.startswith("|") or s.startswith(chr(96) * 3) or s.startswith("- ") or re.match(r"^\d+\.", s):
        if buf:
            paras.append(" ".join(buf))
            buf = []
        continue
    buf.append(s)
bad_paras = []
for p in paras:
    n = len([x for x in re.split(r"[。！？]", p) if x.strip()])
    if len(re.findall(r"[\u4e00-\u9fff]", p)) >= 40 and not (3 <= n <= 5):
        bad_paras.append((n, p[:80]))
if bad_paras:
    for n, p in bad_paras:
        fail("paragraph sentence count=%d (expect 3-5): %s" % (n, p))
else:
    print("STYLE OK paragraph_sentences=3..5")

if FAILS:
    print("STYLE_FAIL=%d" % len(FAILS))
    sys.exit(1)
print("STYLE_CHECK_OK=1")
