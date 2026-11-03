#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate nn/out_v7/tb_golden_v7.vh from nn/out_v7/golden_vectors.json.

Verilog-2001 constant file for the RTL testbench.  The file is generated,
never hand-edited.  Byte order is big-endian: element 0 of every packed
vector occupies the MOST significant bits, i.e. [W-1 -: E].

Usage:
  nn/.venv/Scripts/python.exe nn/v7/gen_tb_golden.py --json nn/out_v7/golden_vectors.json --out nn/out_v7/tb_golden_v7.vh
  nn/.venv/Scripts/python.exe nn/v7/gen_tb_golden.py --json ... --out ... --check
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

NL = chr(10)
WIN_MS = 100
STRIDE_MS = 50
EXPECTED_FEATS = ["n_div16", "prev_n_div16", "pol_bal", "dx", "dy", "dx_rel", "dy_rel"]
GEN_CMD = "nn/.venv/Scripts/python.exe nn/v7/gen_tb_golden.py --json nn/out_v7/golden_vectors.json --out nn/out_v7/tb_golden_v7.vh"


class GenError(Exception):
    pass


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            blk = f.read(1 << 20)
            if not blk:
                break
            h.update(blk)
    return h.hexdigest()


def pack_msb(elems, width):
    v = 0
    mask = (1 << width) - 1
    for e in elems:
        v = ((v << width) | (int(e) & mask))
    return v


def literal(v, nbits):
    if nbits % 4 == 0:
        return str(nbits) + "'h" + format(v, "0" + str(nbits // 4) + "x")
    return str(nbits) + "'b" + format(v, "0" + str(nbits) + "b")


def require(cond, msg):
    if not cond:
        raise GenError(msg)


def build_entries(d):
    "returns (entries, gvn, gvp, gemax, net_ids)"
    feat_names = list(d.get("feat_names") or [])
    require(feat_names == EXPECTED_FEATS,
            "feat_names mismatch: json has " + repr(feat_names) + " expected " + repr(EXPECTED_FEATS))
    entries = {}
    for name in ("GV_FEAT", "GV_CONV3", "GV_G1", "GV_FC", "GV_CLASS",
                 "GV_PP_FEAT", "GV_PP_EX", "GV_PP_EY", "GV_PP_EP", "GV_PP_EN",
                 "GV_PP_ET", "GV_PP_T0", "GV_PP_NSUB"):
        entries[name] = []

    nets = d.get("net_vectors") or []
    require(nets, "golden has no net_vectors")
    net_ids = []
    for i, v in enumerate(nets):
        vid = v.get("id") or ("net_" + str(i))
        net_ids.append(vid)
        layers = v.get("layers") or {}
        for need in ("conv3", "g1", "fc"):
            require(need in layers, "net vector " + vid + " missing layers." + need)
        conv3 = layers["conv3"].get("out_int8")
        g1 = layers["g1"].get("out_int8")
        fc = layers["fc"].get("out_int8")
        require(conv3 is not None, "net vector " + vid + " missing layers.conv3.out_int8")
        require(g1 is not None, "net vector " + vid + " missing layers.g1.out_int8")
        require(fc is not None, "net vector " + vid + " missing layers.fc.out_int8")
        require(len(conv3) == 240, "net vector " + vid + " conv3 out_int8 len " + str(len(conv3)) + " != 240")
        require(len(g1) == 16, "net vector " + vid + " g1 out_int8 len " + str(len(g1)) + " != 16")
        require(len(fc) == 2, "net vector " + vid + " fc out_int8 len " + str(len(fc)) + " != 2")
        feat = v.get("feat_int8")
        require(feat is not None and len(feat) == 7,
                "net vector " + vid + " feat_int8 missing or len != 7")
        cls = v.get("class_int8")
        require(cls is not None, "net vector " + vid + " missing class_int8")
        require(int(cls) in (0, 1), "net vector " + vid + " class_int8 " + str(cls) + " not in 0/1")
        entries["GV_FEAT"].append({"idx": i, "width": 56, "value": pack_msb(feat, 8), "id": vid})
        entries["GV_CONV3"].append({"idx": i, "width": 1920, "value": pack_msb(conv3, 8), "id": vid})
        entries["GV_G1"].append({"idx": i, "width": 128, "value": pack_msb(g1, 8), "id": vid})
        entries["GV_FC"].append({"idx": i, "width": 16, "value": pack_msb(fc, 8), "id": vid})
        entries["GV_CLASS"].append({"idx": i, "width": 2, "value": pack_msb([int(cls)], 2), "id": vid})
    gvn = len(nets)

    pps = d.get("preprocess_vectors") or []
    require(pps, "golden has no preprocess_vectors")
    pp_entries = []
    for x in pps:
        pid = x.get("id") or "pp"
        inp = x.get("input") or {}
        g0 = int(inp.get("g0", 0))
        nwin = int(inp.get("n_win", 0))
        nsub = int(inp.get("n_sub", 0))
        events = inp.get("events") or []
        feats = x.get("feat_expected_int8")
        wexp = x.get("window_expected") or {}
        require(nwin >= 1, "preprocess " + pid + " n_win invalid")
        require(nsub >= 1, "preprocess " + pid + " n_sub invalid")
        require(feats is not None and len(feats) == nwin,
                "preprocess " + pid + " feat_expected_int8 len != n_win")
        nexpect = list(wexp.get("n") or [])
        require(len(nexpect) == nwin, "preprocess " + pid + " window_expected.n len != n_win")
        for k in range(nwin):
            t0 = g0 + STRIDE_MS * k
            win = [e for e in events if t0 <= int(e[0]) < t0 + WIN_MS]
            require(len(win) == int(nexpect[k]),
                    "preprocess " + pid + " window " + str(k) + " event count " +
                    str(len(win)) + " != window_expected.n " + str(nexpect[k]))
            xs = [int(e[1]) for e in win]
            ys = [int(e[2]) for e in win]
            pol = [int(e[3]) for e in win]
            et = [int(e[0]) - t0 for e in win]
            for e in win:
                require(-256 <= int(e[1]) <= 511, "preprocess " + pid + " x out of 9-bit signed range")
                require(0 <= int(e[1]) & 511, "preprocess " + pid + " x pack range")
                require(-0 <= int(e[2]) <= 255, "preprocess " + pid + " y out of 8-bit range")
                require(int(e[3]) in (0, 1), "preprocess " + pid + " pol not 0/1")
            for t in et:
                require(0 <= t < 256, "preprocess " + pid + " event dt out of 8-bit range")
            require(0 <= t0 <= 65535, "preprocess " + pid + " t0 out of 16-bit range")
            require(0 <= nsub <= 255, "preprocess " + pid + " n_sub out of 8-bit range")
            feat = feats[k]
            require(len(feat) == 7, "preprocess " + pid + " window " + str(k) + " feat len != 7")
            pp_entries.append({"pid": pid, "win": k, "nsub": nsub, "t0": t0,
                               "feat": feat, "x": xs, "y": ys, "pol": pol, "et": et})
    gvp = len(pp_entries)
    gemax = max(len(p["x"]) for p in pp_entries)
    require(gemax >= 1, "preprocess max event count is 0")
    require(gemax * 9 <= 4096 * 8, "GVEMAX too large")

    for j, p in enumerate(pp_entries):
        tag = p["pid"] + " w" + str(p["win"])
        entries["GV_PP_FEAT"].append({"idx": j, "width": 56, "value": pack_msb(p["feat"], 8), "id": tag})
        entries["GV_PP_EX"].append({"idx": j, "width": gemax * 9, "value": pack_msb(p["x"], 9), "id": tag})
        entries["GV_PP_EY"].append({"idx": j, "width": gemax * 8, "value": pack_msb(p["y"], 8), "id": tag})
        entries["GV_PP_EP"].append({"idx": j, "width": gemax, "value": pack_msb(p["pol"], 1), "id": tag})
        entries["GV_PP_EN"].append({"idx": j, "width": 16, "value": pack_msb([len(p["x"])], 16), "id": tag})
        entries["GV_PP_ET"].append({"idx": j, "width": gemax * 8, "value": pack_msb(p["et"], 8), "id": tag})
        entries["GV_PP_T0"].append({"idx": j, "width": 16, "value": pack_msb([p["t0"]], 16), "id": tag})
        entries["GV_PP_NSUB"].append({"idx": j, "width": 8, "value": pack_msb([p["nsub"]], 8), "id": tag})
    return entries, gvn, gvp, gemax, net_ids


DECL = [
    ("GV_FEAT",    "reg [55:0]           GV_FEAT    [0:GVN-1];",   "7 int8 features [n_div16,prev_n_div16,pol_bal,dx,dy,dx_rel,dy_rel]"),
    ("GV_CONV3",   "reg [1919:0]         GV_CONV3   [0:GVN-1];",   "conv3 flatten 24x2x5 = 240 int8"),
    ("GV_G1",      "reg [127:0]          GV_G1      [0:GVN-1];",   "g1 hidden 16 int8 after ReLU"),
    ("GV_FC",      "reg [15:0]           GV_FC      [0:GVN-1];",   "fc 2 int8 logits, ReLU NOT applied"),
    ("GV_CLASS",   "reg [1:0]            GV_CLASS   [0:GVN-1];",   "expected argmax, tie -> lower index"),
    ("GV_PP_FEAT", "reg [55:0]           GV_PP_FEAT [0:GVP-1];",   "preprocess expected 7 int8 features per (case,window)"),
    ("GV_PP_EX",   "reg [GVEMAX*9-1:0]   GV_PP_EX   [0:GVP-1];",   "event x, 9 bit each, event 0 first (MSB)"),
    ("GV_PP_EY",   "reg [GVEMAX*8-1:0]   GV_PP_EY   [0:GVP-1];",   "event y, 8 bit each"),
    ("GV_PP_EP",   "reg [GVEMAX-1:0]     GV_PP_EP   [0:GVP-1];",   "event pol, 1 bit each"),
    ("GV_PP_EN",   "reg [15:0]           GV_PP_EN   [0:GVP-1];",   "valid event count, tail slots are 0"),
    ("GV_PP_ET",   "reg [GVEMAX*8-1:0]   GV_PP_ET   [0:GVP-1];",   "ADDITIVE: event dt within window (ms, 8 bit)"),
    ("GV_PP_T0",   "reg [15:0]           GV_PP_T0   [0:GVP-1];",   "ADDITIVE: window start time t0 (ms)"),
    ("GV_PP_NSUB", "reg [7:0]            GV_PP_NSUB [0:GVP-1];",   "ADDITIVE: subblock count n_sub"),
]


def generate_text(d, json_path, json_sha, entries, gvn, gvp, gemax, net_ids):
    mtime = os.path.getmtime(json_path)
    stamp = datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    L = []
    L.append("// ==========================================================================")
    L.append("// tb_golden_v7.vh  --  GENERATED FILE, DO NOT EDIT")
    L.append("// source JSON : nn/out_v7/golden_vectors.json  sha256=" + json_sha)
    L.append("// generator   : nn/v7/gen_tb_golden.py")
    L.append("// gen command : " + GEN_CMD)
    L.append("// gen time    : " + stamp + " (source JSON mtime, UTC; kept fixed for idempotency)")
    L.append("// format      : Verilog-2001. include INSIDE a module, outside any initial block.")
    L.append("// byte order  : big-endian. element 0 = MOST significant bits of each vector;")
    L.append("//               element i occupies [W-1-8*i -: 8] for int8 arrays; int8 = two's complement.")
    L.append("// pp layout   : one GV_PP_* slot per (preprocess case, window): pp01..pp03 have 2")
    L.append("//               windows, pp04..pp06 have 1 => GVP = " + str(gvp) + ". GV_PP_ET/T0/NSUB are ADDITIVE")
    L.append("//               helper arrays (event dt, window start, subblock count) needed to replay.")
    L.append("// ==========================================================================")
    L.append("localparam integer GVN    = " + str(gvn) + ";")
    L.append("localparam integer GVP    = " + str(gvp) + ";")
    L.append("localparam integer GVEMAX = " + str(gemax) + ";")
    L.append("")
    for name, decl, note in DECL:
        L.append("// " + name + ": " + note)
        L.append(decl)
    L.append("")
    L.append("// net-vector index -> id (applies to GV_FEAT/GV_CONV3/GV_G1/GV_FC/GV_CLASS):")
    for i, vid in enumerate(net_ids):
        L.append("//   " + str(i) + " = " + vid)
    L.append("initial begin")
    for name, decl, note in DECL:
        items = entries[name]
        if not items:
            continue
        L.append("  // " + name)
        for it in items:
            L.append("  " + name + "[" + str(it["idx"]) + "] = " + literal(it["value"], it["width"]) + "; // " + it["id"])
    L.append("  // hex spot-check (byte 0 of each engine vector, two's complement)")
    for i in range(gvn):
        f0 = int(d["net_vectors"][i]["feat_int8"][0]) & 255
        c0 = int(d["net_vectors"][i]["layers"]["conv3"]["out_int8"][0]) & 255
        g0 = int(d["net_vectors"][i]["layers"]["g1"]["out_int8"][0]) & 255
        fc = [int(t) & 255 for t in d["net_vectors"][i]["layers"]["fc"]["out_int8"]]
        L.append("  // " + net_ids[i] + " feat0=0x" + format(f0, "02x") + " conv3[0]=0x" + format(c0, "02x") +
                 " g1[0]=0x" + format(g0, "02x") + " fc=[0x" + format(fc[0], "02x") + ",0x" + format(fc[1], "02x") +
                 "] class=" + str(int(d["net_vectors"][i]["class_int8"])))
    L.append("end")
    L.append("")
    return NL.join(L)


def parse_vh(text):
    params = {}
    vals = {}
    for raw in text.split(NL):
        s = raw.strip()
        if not s or s.startswith("//"):
            continue
        if s.startswith("localparam integer "):
            body = s[len("localparam integer "):].rstrip(";")
            name, sep, num = body.partition("=")
            require(sep == "=", "bad localparam line: " + s)
            params[name.strip()] = int(num.strip())
            continue
        if s.startswith("reg ") or s.startswith("initial") or s in ("begin", "end"):
            continue
        if "=" not in s:
            continue
        lhs, rhs = s.split("=", 1)
        lhs = lhs.strip()
        rhs = rhs.split(";", 1)[0].strip()
        if "[" not in lhs or "]" not in lhs:
            continue
        name = lhs[:lhs.index("[")].strip()
        idx = int(lhs[lhs.index("[") + 1:lhs.index("]")].strip())
        q = rhs.find("'")
        require(q > 0, "bad literal: " + s)
        width = int(rhs[:q])
        base = rhs[q + 1]
        digits = rhs[q + 2:].strip()
        if base == "h":
            val = int(digits, 16) if digits else 0
            bits = 4 * len(digits)
        elif base == "b":
            val = int(digits, 2) if digits else 0
            bits = len(digits)
        else:
            raise GenError("bad base in literal: " + s)
        require(bits == width, "literal width mismatch: " + s)
        vals[(name, idx)] = (width, val)
    return params, vals


def selfcheck(text, entries, gvn, gvp, gemax):
    params, vals = parse_vh(text)
    require(params.get("GVN") == gvn, "GVN mismatch in vh")
    require(params.get("GVP") == gvp, "GVP mismatch in vh")
    require(params.get("GVEMAX") == gemax, "GVEMAX mismatch in vh")
    n = 0
    bits = 0
    for name, items in entries.items():
        for it in items:
            key = (name, it["idx"])
            require(key in vals, "missing " + name + "[" + str(it["idx"]) + "]")
            w, v = vals[key]
            require(w == it["width"], "width mismatch " + name + "[" + str(it["idx"]) + "]")
            require(v == it["value"], "value mismatch " + name + "[" + str(it["idx"]) + "]")
            n += 1
            bits += w
    total = sum(len(items) for items in entries.values())
    require(n == total, "checked " + str(n) + " of " + str(total))
    return n, bits // 8


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="nn/out_v7/golden_vectors.json")
    ap.add_argument("--out", default="nn/out_v7/tb_golden_v7.vh")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    d = json.load(open(args.json, "r", encoding="utf-8"))
    entries, gvn, gvp, gemax, net_ids = build_entries(d)
    json_sha = sha256_file(args.json)
    if args.check:
        require(os.path.exists(args.out), "--check: file not found: " + args.out)
        text = open(args.out, "r", encoding="utf-8", newline="").read()
        require(json_sha in text, "--check: header source sha does not match current JSON")
        n, nbytes = selfcheck(text, entries, gvn, gvp, gemax)
        print("TB_GOLDEN_VH_SHA256=" + sha256_file(args.out))
        print("TB_GOLDEN_SELFCHECK_OK=1 vec=" + str(gvn + len(d["preprocess_vectors"])) +
              " bytes=" + str(nbytes) + " chunks=" + str(n) + " GVN=" + str(gvn) +
              " GVP=" + str(gvp) + " GVEMAX=" + str(gemax))
        return 0
    text = generate_text(d, args.json, json_sha, entries, gvn, gvp, gemax, net_ids)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, args.out)
    n, nbytes = selfcheck(text, entries, gvn, gvp, gemax)
    lines = len(text.split(NL))
    print("TB_GOLDEN_VH_GEN=" + args.out)
    print("TB_GOLDEN_VH_JSON_SHA256=" + json_sha)
    print("TB_GOLDEN_VH_SHA256=" + sha256_file(args.out))
    print("TB_GOLDEN_VH_LINES=" + str(lines))
    print("TB_GOLDEN_SELFCHECK_OK=1 vec=" + str(gvn + len(d["preprocess_vectors"])) +
          " bytes=" + str(nbytes) + " chunks=" + str(n) + " GVN=" + str(gvn) +
          " GVP=" + str(gvp) + " GVEMAX=" + str(gemax))
    print("TB_GOLDEN_VH_OK=1")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except GenError as e:
        sys.stderr.write("ERROR: " + str(e) + NL)
        sys.exit(2)
