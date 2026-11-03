#!/usr/bin/env python3
"""Independent checker for the 2-class ROM (nn/out_v4/nn_rom_data_2cls.v).

Rebuilds all ROM words straight from nn/out_v4/nn_params_2cls.json:
  weights : int8  -> 32-bit two's complement
  bias    : int32 -> 32-bit two's complement
  SH      : power of two -> low 8 bits, upper bits zero
then compares word by word against the Verilog initial block, and checks the
declared word count, module name, address width and JSON address fields.

First log line is the machine-readable verdict: ROM2_CHECK_OK=1.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_JSON = ROOT / "out_v4" / "nn_params_2cls.json"
DEFAULT_ROM = ROOT / "out_v4" / "nn_rom_data_2cls.v"
DEFAULT_EVID = ROOT / "_evidence" / "ROM2_LOG.log"

EXPECT_WORDS = 5476
WEIGHT_WORDS = 5376
FC_BASE = 4896
BIAS_BASE = 5376
SH_BASE = 5426
LAYER_ORDER = ("conv1", "conv2", "conv3", "fc")


def flat(x):
    if isinstance(x, list):
        for y in x:
            yield from flat(y)
    else:
        yield x


def u32(v) -> int:
    return int(v) & 0xFFFFFFFF


def recompute_words(doc: dict) -> list:
    """Rebuild the compact 5476-word ROM from the JSON contract."""
    layers = doc["cnn_params"]["layers"]
    names = [l["name"] for l in layers]
    assert names == list(LAYER_ORDER), "layer order changed: %s" % names
    words = []
    for layer in layers:
        ws = [u32(v) for v in flat(layer["weight_int8"])]
        assert len(ws) == int(layer["weight_count"]), (layer["name"], len(ws), layer["weight_count"])
        words.extend(ws)
    assert len(words) == WEIGHT_WORDS, "weights must be %d words, got %d" % (WEIGHT_WORDS, len(words))
    for layer in layers:
        words.extend(u32(v) for v in layer["bias_int32"])
    assert len(words) == BIAS_BASE - 0 + 50, "bias must end at %d, got %d" % (BIAS_BASE + 50, len(words))
    for layer in layers:
        words.extend(int(v) & 0xFF for v in layer["SH"])
    assert len(words) == EXPECT_WORDS, "ROM must be %d words, got %d" % (EXPECT_WORDS, len(words))
    return words


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Independent checker for nn_rom_data_2cls.v")
    ap.add_argument("--json", default=str(DEFAULT_JSON))
    ap.add_argument("--rom", default=str(DEFAULT_ROM))
    ap.add_argument("--evid", default=str(DEFAULT_EVID))
    args = ap.parse_args(argv)

    doc = json.loads(Path(args.json).read_text(encoding="utf-8"))
    text = Path(args.rom).read_text(encoding="utf-8")
    words = recompute_words(doc)

    found = {}
    for idx_s, hex_s in re.findall(r"rom\[(\d+)\] = 32'h([0-9A-F]{8});", text):
        found[int(idx_s)] = int(hex_s, 16)

    checks = []
    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))
        return bool(cond)

    check("json_num_classes", doc.get("num_classes") == 2, doc.get("num_classes"))
    check("json_rom_words", doc.get("rom_words") == EXPECT_WORDS, doc.get("rom_words"))
    check("json_fc_base", doc.get("fc_word_base") == FC_BASE, doc.get("fc_word_base"))
    check("json_bias_base", doc.get("bias_base") == BIAS_BASE, doc.get("bias_base"))
    check("json_sh_base", doc.get("sh_base") == SH_BASE, doc.get("sh_base"))
    check("json_bias_words", len(doc.get("bias_int32") or []) == 50, len(doc.get("bias_int32") or []))
    check("json_sh_words", len(doc.get("sh") or []) == 50, len(doc.get("sh") or []))
    check("module_name", "module nn_rom_data(" in text)
    check("addr_port_13", "input      [12:0] i_addr" in text)
    check("reg_decl", ("reg [31:0] rom [0:%d];" % (EXPECT_WORDS - 1)) in text)
    check("no_readmemh", "readmemh" not in text)
    check("rom_word_count", len(found) == EXPECT_WORDS, len(found))
    check("rom_contiguous", sorted(found) == list(range(EXPECT_WORDS)))

    mismatch = [i for i in range(min(len(words), EXPECT_WORDS))
                if found.get(i) != words[i]]
    checks.append(("word_match", not mismatch, "first_diff=%s" % (mismatch[:5] if mismatch else "-")))

    ok = all(c[1] for c in checks)
    out = ["ROM2_CHECK_OK=%d" % int(ok),
           "ROM2_WORDS=%d" % len(words),
           "ROM2_WEIGHT_WORDS=%d" % WEIGHT_WORDS,
           "ROM2_BIAS_WORDS=50",
           "ROM2_SH_WORDS=50",
           "ROM2_MODULE=nn_rom_data",
           "ROM2_JSON_NUM_CLASSES=%s" % doc.get("num_classes"),
           "ROM2_FC_BASE=%d" % FC_BASE,
           "ROM2_BIAS_BASE=%d" % BIAS_BASE,
           "ROM2_SH_BASE=%d" % SH_BASE,
           "ROM2_MISMATCHES=%d" % len(mismatch),
           "ROM2_FIRST_DIFF=%s" % (mismatch[0] if mismatch else "-"),
           "ROM2_FIRST_WORD=%08X" % words[0],
           "ROM2_LAST_WORD=%08X" % words[-1]]
    for name, good, detail in checks:
        out.append("CHECK %-20s %s %s" % (name, "PASS" if good else "FAIL", detail))

    evid = Path(args.evid)
    evid.parent.mkdir(parents=True, exist_ok=True)
    evid.write_text("\n".join(out) + "\n", encoding="utf-8")
    for line in out:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
