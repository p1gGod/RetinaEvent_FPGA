"""Post-training int8 quantization of the P1 CNN + ROM generation.

Produces:
  nn/out/nn_params.json      per-layer int8 weights, int32 bias, SH shifts
  nn/out/nn_rom_data.v       5718-word RTL ROM (verilog, no readmemh)
  nn/out/quant_test_preds.npz float/int8 predictions on the official test split

Integer semantics (must match the RTL contract):
  acc = sum(int8 weight * int8 activation) + int32 bias
  out = clip((acc + bias) >> SH[out_ch], -128, 127)
  conv outputs go through ReLU, fc output does not.

Quantization model:
  For layer l the real activation is x_q[ic] * s_x[ic].  We fold s_x into the
  weight target (w_eff = w_f * s_x), then pick a per-output-channel scale
  A[oc] = max|w_eff|/127 and w_q = round(w_eff/A).  The requant shift is chosen
  so that s_y[oc] = A[oc] * 2^SH[oc] equals the desired output scale, hence the
  RTL only needs the integer shift -- no float scales are stored in ROM.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import NUM_CLASSES, P1CNN, build_model  # noqa: E402

NN_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = NN_DIR / "dataset_v3_w100.npz"
DEFAULT_OUT = NN_DIR / "out"

# ROM layout, exactly as frozen by the M3 RTL contract.
ROM_WORD_COUNT = 5718
LAYOUT = (
    ("conv1_w", 0, 288),
    ("conv2_w", 288, 1440),
    ("conv3_w", 1440, 4896),
    ("fc_w", 4896, 5616),
    ("bias", 5616, 5667),
    ("sh", 5667, 5718),
)
WEIGHT_COUNTS = {"conv1": 288, "conv2": 1152, "conv3": 3456, "fc": 720}
BIAS_COUNTS = {"conv1": 8, "conv2": 16, "conv3": 24, "fc": 3}
SH_COUNTS = dict(BIAS_COUNTS)
CONV_SHAPES = {"conv1": (8, 4, 3, 3), "conv2": (16, 8, 3, 3), "conv3": (24, 16, 3, 3)}
FC_SHAPE = (NUM_CLASSES, 240)


def conv2d_int8(x: np.ndarray, w: np.ndarray, b: np.ndarray, sh: np.ndarray,
                relu: bool = True) -> np.ndarray:
    """Integer conv (k=3, stride=2, pad=0) with per-output-channel shift."""
    n, cin, h, wd = x.shape
    cout, _, k, _ = w.shape
    oh = (h - k) // 2 + 1
    ow = (wd - k) // 2 + 1
    acc = np.zeros((n, cout, oh, ow), dtype=np.int64)
    for ky in range(k):
        for kx in range(k):
            xs = x[:, :, ky:ky + h - k + 1:2, kx:kx + wd - k + 1:2].astype(np.int64)
            wk = w[:, :, ky, kx].T.astype(np.int64)  # (cin, cout)
            acc += np.einsum("nchw,co->nohw", xs, wk)
    acc += b.reshape(1, cout, 1, 1).astype(np.int64)
    acc = acc >> sh.reshape(1, cout, 1, 1)
    acc = np.clip(acc, -128, 127)
    if relu:
        acc = np.maximum(acc, 0)
    return acc.astype(np.int8)


def fc_int8(x: np.ndarray, w: np.ndarray, b: np.ndarray, sh: np.ndarray) -> np.ndarray:
    acc = x.astype(np.int64) @ w.T.astype(np.int64) + b.astype(np.int64).reshape(1, -1)
    acc = acc >> sh.reshape(1, -1)
    return np.clip(acc, -128, 127).astype(np.int8)


def forward_int8(x: np.ndarray, params: dict) -> tuple[np.ndarray, dict]:
    """Run the integer pipeline; returns int8 logits and per-layer stats."""
    acts = x
    stats: dict[str, dict] = {}
    for layer in params["layers"]:
        w = np.asarray(layer["weight_int8"], dtype=np.int8).reshape(layer["weight_shape"])
        b = np.asarray(layer["bias_int32"], dtype=np.int64)
        sh = np.asarray(layer["SH"], dtype=np.int64)
        before = acts
        if layer["name"] == "fc":
            flat = np.ascontiguousarray(acts).reshape(acts.shape[0], -1)
            logits = fc_int8(flat, w, b, sh)
            stats["fc"] = {"in_min": int(flat.min()), "in_max": int(flat.max()),
                           "out_min": int(logits.min()), "out_max": int(logits.max())}
            acts = logits
        else:
            out = conv2d_int8(acts, w, b, sh, relu=True)
            stats[layer["name"]] = {"in_min": int(before.min()), "in_max": int(before.max()),
                                    "out_min": int(out.min()), "out_max": int(out.max()),
                                    "out_zero_frac": round(float((out == 0).mean()), 6)}
            acts = out
    return acts, stats


def _quant_layer_weights(w_f: np.ndarray, s_x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Fold per-input-channel activation scales into weights and quantize per output channel."""
    w_eff = w_f * s_x.reshape((1, -1) + (1,) * (w_f.ndim - 2))
    max_abs = np.abs(w_eff).reshape(w_f.shape[0], -1).max(axis=1)
    A = np.where(max_abs > 1e-12, max_abs / 127.0, 1.0)
    q = np.rint(w_eff / A.reshape((-1,) + (1,) * (w_f.ndim - 1))).astype(np.int64)
    q = np.clip(q, -127, 127).astype(np.int8)
    return q, A


def _shift_for(A: np.ndarray, s_y_desired: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ratio = np.maximum(s_y_desired, 1e-12) / A
    SH = np.rint(np.log2(np.maximum(ratio, 1.0))).astype(np.int64)
    SH = np.clip(SH, 0, 31)
    s_y = A * np.exp2(SH.astype(np.float64))
    return SH, s_y


def quantize_model(model: P1CNN, x_cal: np.ndarray) -> dict:
    layers: list[dict] = []
    x_q = x_cal.astype(np.int8)
    s_x = np.ones(4, dtype=np.float64)
    total_clipped_in = 0
    cal_stats: dict[str, dict] = {}

    convs = (("conv1", model.conv1), ("conv2", model.conv2), ("conv3", model.conv3))
    for name, conv in convs:
        w_f = conv.weight.detach().numpy().astype(np.float64)
        b_f = conv.bias.detach().numpy().astype(np.float64)
        w_q, A = _quant_layer_weights(w_f, s_x)
        x_real = x_q.astype(np.float64) * s_x.reshape(1, -1, 1, 1)
        with torch.no_grad():
            y = F.conv2d(torch.from_numpy(x_real).float(), conv.weight, conv.bias, stride=2)
            y = torch.relu(y).numpy().astype(np.float64)
        act_max = y.reshape(y.shape[0], y.shape[1], -1).max(axis=(0, 2))
        s_y_desired = np.where(act_max > 1e-12, act_max / 127.0, 1e-6)
        SH, s_y = _shift_for(A, s_y_desired)
        b_q = np.rint(b_f / A).astype(np.int64)
        assert np.all(np.abs(b_q) < 2**31), f"{name} bias does not fit int32"
        layers.append({
            "name": name,
            "weight_shape": list(w_f.shape),
            "weight_count": int(w_q.size),
            "weight_int8": [int(v) for v in w_q.reshape(-1).tolist()],
            "bias_int32": [int(v) for v in b_q.tolist()],
            "SH": [int(v) for v in SH.tolist()],
            "A_scale": [float(v) for v in A.tolist()],
            "s_x_in": [float(v) for v in np.asarray(s_x).reshape(-1).tolist()],
            "s_y_out": [float(v) for v in s_y.tolist()],
            "calib_act_max": [float(v) for v in act_max.tolist()],
        })
        # Advance calibration with the integer result, so later layers see the
        # same activations the RTL will see.
        x_q = conv2d_int8(x_q, w_q, b_q, SH, relu=True)
        cal_stats[name] = {"input_abs_max": float(np.abs(x_real).max()),
                           "quant_out_min": int(x_q.min()), "quant_out_max": int(x_q.max())}
        s_x = s_y

    # FC layer: flatten conv3 as (24,2,5) -> 240.
    w_f = model.fc.weight.detach().numpy().astype(np.float64)
    b_f = model.fc.bias.detach().numpy().astype(np.float64)
    flat = np.ascontiguousarray(x_q).reshape(x_q.shape[0], -1)
    s_x_fc = np.repeat(np.asarray(s_x, dtype=np.float64), 10)  # 2*5 spatial per channel
    w_q, A = _quant_layer_weights(w_f, s_x_fc)
    x_real = flat.astype(np.float64) * s_x_fc.reshape(1, -1)
    y = x_real @ w_f.T + b_f.reshape(1, -1)
    logit_max = np.abs(y).max(axis=0)
    s_y_desired = np.where(logit_max > 1e-12, logit_max / 127.0, 1e-6)
    SH, s_y = _shift_for(A, s_y_desired)
    b_q = np.rint(b_f / A).astype(np.int64)
    assert np.all(np.abs(b_q) < 2**31), "fc bias does not fit int32"
    layers.append({
        "name": "fc",
        "weight_shape": list(w_f.shape),
        "weight_count": int(w_q.size),
        "weight_int8": [int(v) for v in w_q.reshape(-1).tolist()],
        "bias_int32": [int(v) for v in b_q.tolist()],
        "SH": [int(v) for v in SH.tolist()],
        "A_scale": [float(v) for v in A.tolist()],
        "s_x_in": [float(v) for v in s_x_fc.tolist()],
        "s_y_out": [float(v) for v in s_y.tolist()],
        "calib_act_max": [float(v) for v in logit_max.tolist()],
    })
    cal_stats["fc"] = {"logit_abs_max": float(np.abs(y).max())}
    return {
        "arch": "P1CNN",
        "grid": [30, 50],
        "in_ch": 4,
        "num_classes": NUM_CLASSES,
        "channels": ["ON_now", "OFF_now", "ON_prev", "OFF_prev"],
        "input_scale": 1.0,
        "layout": [{"name": n, "start": s, "end": e, "words": e - s} for n, s, e in LAYOUT],
        "rom_words": ROM_WORD_COUNT,
        "layers": layers,
        "calibration": {"n": int(x_cal.shape[0]), "stats": cal_stats},
    }


def rom_words(params: dict) -> list[int]:
    words: list[int] = []
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["weight_int8"])
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["bias_int32"])
    for layer in params["layers"]:
        words.extend(int(v) for v in layer["SH"])
    return words


def write_rom(path: Path, words: list[int]) -> None:
    assert len(words) == ROM_WORD_COUNT, f"ROM needs {ROM_WORD_COUNT} words, got {len(words)}"
    lines = [
        "// Auto-generated by nn/quantize.py -- do not edit by hand.",
        "// P1 int8 CNN: conv1 8x4x3x3, conv2 16x8x3x3, conv3 24x16x3x3, fc 3x240,",
        "// then int32 bias (8/16/24/3) and per-channel SH (8/16/24/3); 5718 words.",
        "module nn_rom_data(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        "    input      [12:0] i_addr",
        ");",
        "",
        "    reg [31:0] rom [0:5717];",
        "",
        "    initial begin",
    ]
    for i, v in enumerate(words):
        lines.append(f"        rom[{i}] = 32'h{v & 0xFFFFFFFF:08X};")
    lines += [
        "    end",
        "",
        "    always @(posedge clk) begin",
        "        o_dout <= rom[i_addr];",
        "    end",
        "",
        "endmodule",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def check_params(params: dict) -> list[str]:
    errors: list[str] = []
    seen = 0
    for layer in params["layers"]:
        name = layer["name"]
        if layer["weight_count"] != WEIGHT_COUNTS[name]:
            errors.append(f"{name}: weight_count mismatch")
        if len(layer["weight_int8"]) != WEIGHT_COUNTS[name]:
            errors.append(f"{name}: weight list length mismatch")
        if len(layer["bias_int32"]) != BIAS_COUNTS[name]:
            errors.append(f"{name}: bias count mismatch")
        if len(layer["SH"]) != SH_COUNTS[name]:
            errors.append(f"{name}: SH count mismatch")
        w = np.asarray(layer["weight_int8"])
        if w.size and (w.min() < -128 or w.max() > 127):
            errors.append(f"{name}: weight outside int8")
        b = np.asarray(layer["bias_int32"], dtype=np.int64)
        if b.size and (b.min() < -2**31 or b.max() > 2**31 - 1):
            errors.append(f"{name}: bias outside int32")
        sh = np.asarray(layer["SH"], dtype=np.float64)
        if not np.all(np.equal(np.mod(sh, 1), 0)) or sh.min() < 0 or sh.max() > 31:
            errors.append(f"{name}: SH not integer in 0..31")
        seen += layer["weight_count"]
    if seen != 5616:
        errors.append(f"total weights {seen} != 5616")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Quantize P1 CNN and generate ROM")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--model", default=str(DEFAULT_OUT / "model.pt"))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--calib", type=int, default=512)
    args = ap.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt = torch.load(args.model, map_location="cpu", weights_only=False)
    model = build_model(num_classes=ckpt.get("num_classes", NUM_CLASSES))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    d = np.load(args.data, allow_pickle=False)
    x_all = d["X_q"].astype(np.int8)
    y_all = d["y"].astype(np.int64)
    split = d["split"].astype(str)
    tr = split == "train"
    te = split == "test"
    rng = np.random.default_rng(1234)
    idx_tr = np.where(tr)[0]
    if len(idx_tr) > args.calib:
        idx_tr = np.sort(rng.choice(idx_tr, size=args.calib, replace=False))
    x_cal = x_all[idx_tr]

    params = quantize_model(model, x_cal)
    problems = check_params(params)
    words = rom_words(params)
    if len(words) != ROM_WORD_COUNT:
        problems.append(f"ROM word count {len(words)} != {ROM_WORD_COUNT}")
    # Layout check: every slot is covered exactly once.
    flat = []
    for name, start, end in LAYOUT:
        flat.extend(range(start, end))
    if sorted(flat) != list(range(ROM_WORD_COUNT)):
        problems.append("ROM layout does not cover 0..5717 exactly once")
    if problems:
        print("QUANT_CHECK_FAILED")
        for p in problems:
            print(f"  - {p}")
        return 1

    params_path = out_dir / "nn_params.json"
    params_path.write_text(json.dumps(params, ensure_ascii=False, indent=1), encoding="utf-8")
    rom_path = out_dir / "nn_rom_data.v"
    write_rom(rom_path, words)

    # Round-trip the ROM so a hand-edit or layout slip is caught immediately.
    rom_vals = [int(v) for v in words]
    readback_ok = len(rom_vals) == ROM_WORD_COUNT
    offset = 0
    for layer in params["layers"]:
        n = layer["weight_count"]
        readback_ok &= rom_vals[offset:offset + n] == [int(v) for v in layer["weight_int8"]]
        offset += n
    for layer in params["layers"]:
        n = len(layer["bias_int32"])
        readback_ok &= rom_vals[offset:offset + n] == [int(v) for v in layer["bias_int32"]]
        offset += n
    for layer in params["layers"]:
        n = len(layer["SH"])
        readback_ok &= rom_vals[offset:offset + n] == [int(v) for v in layer["SH"]]
        offset += n
    if not readback_ok or offset != ROM_WORD_COUNT:
        print("QUANT_CHECK_FAILED: ROM round-trip mismatch")
        return 1

    # Accuracy check on the official test split.
    with torch.no_grad():
        logits_f = model(torch.from_numpy(x_all[te].astype(np.float32)))
        pred_f = logits_f.argmax(dim=1).numpy().astype(np.int64)
    logits_q, qstats = forward_int8(x_all[te], params)
    pred_q = logits_q.argmax(axis=1).astype(np.int64)
    y_te = y_all[te]
    acc_f = float((pred_f == y_te).mean())
    acc_q = float((pred_q == y_te).mean())
    agree = float((pred_f == pred_q).mean())
    drop = acc_f - acc_q

    # Int8 sanity on a training subset too (not a generalization claim).
    logits_q_tr, _ = forward_int8(x_all[tr][:256], params)
    with torch.no_grad():
        pred_f_tr = model(torch.from_numpy(x_all[tr][:256].astype(np.float32))).argmax(dim=1).numpy()
    train_agree = float((pred_f_tr == logits_q_tr.argmax(axis=1)).mean())

    np.savez(out_dir / "quant_test_preds.npz",
             y_true=y_te, pred_float=pred_f, pred_int8=pred_q,
             window_index=np.where(te)[0], logits_float=logits_f.numpy(),
             logits_int8=logits_q.astype(np.int8))

    print(f"[quant] params     : {params_path}")
    print(f"[quant] rom        : {rom_path} ({ROM_WORD_COUNT} words)")
    print(f"[quant] layers     : " + ", ".join(
        f"{l['name']}(w={l['weight_count']}, SH={l['SH']})" for l in params["layers"]))
    print(f"[quant] ROM offset after weights/bias/SH = {offset} (expect {ROM_WORD_COUNT})")
    print(f"[quant] test n={int(te.sum())} float_acc={acc_f:.4f} int8_acc={acc_q:.4f} drop={drop:.4f}")
    print(f"[quant] argmax agreement float/int8 = {agree:.4f}, train-subset agreement = {train_agree:.4f}")
    print(f"[quant] int8 per-layer stats: {json.dumps(qstats, ensure_ascii=False)}")
    ok = (not problems) and drop <= 0.02
    print(f"QUANT_ACC_DROP_OK={1 if drop <= 0.02 else 0}")
    print(f"QUANT_OK={1 if ok else 0}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
