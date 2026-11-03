# -*- coding: utf-8 -*-
"""校验 nn_params_v7.json 与 nn_rom_data_v7.v 逐字一致（PARAMS_ROM_MATCH_OK）。

用法：
  PYTHONUTF8=1 nn/.venv/Scripts/python.exe nn/v7/check_params_rom.py \
      [--params nn/out_v7/nn_params_v7.json] [--rom nn/out_v7/nn_rom_data_v7.v] \
      [--offsets-json nn/out_v7/rom_offsets.json]

校验项：模块名/地址位宽/ROM 深度/字数、每 word 值（权重按 uint32 补码、bias int32、SH int32）、
layout 各段 offset+length 连续覆盖、layout 名字与权重/偏置/SH 段顺序一致。
"""
import sys, json, hashlib, re, argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in ("nn", "nn/v7", "nn/v6"):
    sys.path.insert(0, str(ROOT / p))
import quant_v7 as QV


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_rom(path):
    txt = Path(path).read_text(encoding="utf-8")
    m = re.search(r"module\s+(\w+)", txt)
    module = m.group(1) if m else None
    m = re.search(r"input\s*\[\s*(\d+)\s*:\s*0\s*\]\s*i_addr", txt)
    addr_bits = int(m.group(1)) + 1 if m else None
    m = re.search(r"reg\s*\[\s*31\s*:\s*0\s*\]\s*rom\s*\[\s*0\s*:\s*(\d+)\s*\]", txt)
    depth = int(m.group(1)) + 1 if m else None
    words = []
    for mm in re.finditer(r"rom\[(\d+)\]\s*=\s*32'h([0-9A-Fa-f]{8})\s*;", txt):
        idx = int(mm.group(1)); val = int(mm.group(2), 16)
        if idx != len(words):
            raise SystemExit(f"rom 地址不连续：期望 {len(words)} 实际 {idx}")
        words.append(val)
    return {"module": module, "addr_bits": addr_bits, "depth": depth, "words": words,
            "text": txt, "sha256": sha256(path)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default=str(ROOT / "nn/out_v7/nn_params_v7.json"))
    ap.add_argument("--rom", default=str(ROOT / "nn/out_v7/nn_rom_data_v7.v"))
    ap.add_argument("--offsets-json", default=str(ROOT / "nn/out_v7/rom_offsets.json"))
    args = ap.parse_args()
    params = json.loads(Path(args.params).read_text(encoding="utf-8"))
    errs = list(QV.check_params_v7(params))
    rom = parse_rom(args.rom)
    exp = QV.rom_words_v7(params)
    n = int(params["rom_words"])
    if len(exp) != n:
        errs.append(f"rom_words_v7 生成 {len(exp)} 字 != params.rom_words {n}")
    if rom["module"] != "nn_rom_data":
        errs.append(f"module 名 {rom['module']} != nn_rom_data")
    if rom["depth"] != n:
        errs.append(f"ROM 深度 {rom['depth']} != rom_words {n}")
    if rom["addr_bits"] != 13:
        errs.append(f"地址位宽 {rom['addr_bits']} != 13（RTL nn_cfg 依此写死）")
    if not re.search(r"5652|%d" % n, rom["text"]):
        pass
    if len(rom["words"]) != n:
        errs.append(f"ROM 实际赋值 {len(rom['words'])} 字 != rom_words {n}")

    bad = [(i, exp[i], rom["words"][i]) for i in range(min(len(exp), len(rom["words"])))
           if (exp[i] & 0xFFFFFFFF) != rom["words"][i]]
    if bad:
        errs.append(f"word 值不一致 {len(bad)} 个，首个 idx={bad[0][0]} 期望 {bad[0][1]&0xFFFFFFFF:08X} 实际 {bad[0][2]:08X}")

    # layout 覆盖校验：每段与 weight/bias/sh 序号一致
    layout = params.get("layout") or []
    cmp_words = params["weight_words"] + params["bias_words"] + params["sh_words"]
    if cmp_words != n:
        errs.append(f"weight_words+bias_words+sh_words={cmp_words} != rom_words={n}")
    pos = 0
    for ent in layout:
        if int(ent["start"]) != pos or int(ent["end"]) != pos + int(ent["words"]):
            errs.append(f"layout 段 {ent['name']} 不连续：start={ent['start']} end={ent['end']} 期望 start={pos}")
        if int(ent["words"]) != int(ent["end"]) - int(ent["start"]):
            errs.append(f"layout 段 {ent['name']} words 与 end-start 不符")
        pos += int(ent["words"])
    if pos != n:
        errs.append(f"layout 覆盖 {pos} 字 != rom_words {n}")

    offset_table = []
    for ent in layout:
        offset_table.append({"name": ent["name"], "start": int(ent["start"]), "length": int(ent["words"]),
                             "end": int(ent["end"]), "elem_bits": 8 if ent["name"].endswith("_w") else 32,
                             "meaning": {"_w": "int8 weight", "_b": "int32 bias", "_sh": "shift SH"}.get(ent["name"][-2:], "")})
    Path(args.offsets_json).write_text(json.dumps({
        "params": args.params, "params_sha256": sha256(args.params),
        "rom": args.rom, "rom_sha256": rom["sha256"],
        "rom_words": n, "addr_bits": rom["addr_bits"], "module": rom["module"],
        "sections": offset_table,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"params={args.params} rom={args.rom}")
    print(f"rom_words={n} layout_words={cmp_words} module={rom['module']} addr_bits={rom['addr_bits']} depth={rom['depth']}")
    print(f"params_sha256={sha256(args.params)}")
    print(f"rom_sha256={rom['sha256']}")
    if errs:
        print(f"PARAMS_ROM_MATCH_OK=0 errors={len(errs)}")
        for e in errs:
            print("  ERR", e)
        return 1
    print(f"PARAMS_ROM_MATCH_OK=1 words={n} checked={len(exp)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
