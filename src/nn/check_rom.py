"""Independent structural check of nn/out/nn_rom_data.v against nn_params.json."""
from __future__ import annotations

import json
import re
from pathlib import Path

NN_DIR = Path(__file__).resolve().parent
ROM = NN_DIR / "out" / "nn_rom_data.v"
PARAMS = NN_DIR / "out" / "nn_params.json"

RE_ROM = re.compile(r"rom\[(\d+)\]\s*=\s*32'h([0-9A-Fa-f]{8});")


def main() -> int:
    text = ROM.read_text(encoding="utf-8")
    hits = RE_ROM.findall(text)
    problems: list[str] = []
    if len(hits) != 5718:
        problems.append(f"expected 5718 rom entries, found {len(hits)}")
    if "module nn_rom_data(" not in text:
        problems.append("module nn_rom_data( header missing")
    if "output reg [31:0] o_dout" not in text:
        problems.append("o_dout port missing")
    if "input      [12:0] i_addr" not in text:
        problems.append("i_addr port missing")
    if "reg [31:0] rom [0:5717]" not in text:
        problems.append("rom declaration missing")
    if "always @(posedge clk)" not in text or "o_dout <= rom[i_addr]" not in text:
        problems.append("synchronous read block missing")

    addr = [int(a) for a, _ in hits]
    vals = [int(v, 16) for _, v in hits]
    if addr != list(range(5718)):
        problems.append("rom addresses are not 0..5717 in order")

    params = json.loads(PARAMS.read_text(encoding="utf-8"))
    expected: list[int] = []
    weights = []
    biases = []
    shs = []
    for layer in params["layers"]:
        weights.extend(int(v) for v in layer["weight_int8"])
        biases.extend(int(v) for v in layer["bias_int32"])
        shs.extend(int(v) for v in layer["SH"])
    expected.extend(w & 0xFFFFFFFF for w in weights)
    expected.extend(b & 0xFFFFFFFF for b in biases)
    expected.extend(s & 0xFFFFFFFF for s in shs)
    if len(expected) != 5718:
        problems.append(f"expected words from params = {len(expected)}, not 5718")
    if len(vals) == len(expected):
        for i, (a, e) in enumerate(zip(vals, expected)):
            if a != e:
                problems.append(f"word {i}: rom={a:08X} params={e:08X}")
                break
    if len(weights) != 5616:
        problems.append(f"weight count {len(weights)} != 5616")
    if len(biases) != 51 or len(shs) != 51:
        problems.append("bias/SH count != 51")

    # Signed interpretation and range checks.
    def s32(v: int) -> int:
        return v - (1 << 32) if v & 0x80000000 else v

    signed = [s32(v) for v in vals]
    for name, lo, hi in (("conv1", 0, 288), ("conv2", 288, 1440), ("conv3", 1440, 4896), ("fc", 4896, 5616)):
        block = signed[lo:hi]
        if block and (min(block) < -128 or max(block) > 127):
            problems.append(f"{name} weight block not int8")
    for i, b in enumerate(signed[5616:5667]):
        if b < -(2**31) or b > 2**31 - 1:
            problems.append(f"bias[{i}] not int32")
    for i, s in enumerate(vals[5667:5718]):
        if s > 31:
            problems.append(f"SH[{i}]={s} outside 0..31")

    print(f"[check_rom] entries={len(hits)} weights={len(weights)} bias={len(biases)} SH={len(shs)}")
    print(f"[check_rom] word[0]={vals[0]:08X} word[287]={vals[287]:08X} word[288]={vals[288]:08X}")
    print(f"[check_rom] word[4895]={vals[4895]:08X} bias[0]={vals[5616]:08X} SH[0]={vals[5667]:08X} "
          f"word[5717]={vals[5717]:08X}")
    if problems:
        print("ROM_CHECK_FAILED")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("ROM_CHECK_OK=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
