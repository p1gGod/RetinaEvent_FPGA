#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v7 int8 量化（逐输出通道精确 scale）+ 整数前向 + ROM + 参数契约检查。

相对 nn/quantize.py 的两处改进：
  1) 精确 scale：SH = floor(log2(s_y_desired*127/max|w_eff|))，
     A = s_y_desired/2^SH  =>  s_y == s_y_desired（不再有最大 √2 的取整误差），
     代价是 max|w_q| ∈ (63.5,127]（权重分辨率最多差 1 bit）。
  2) fc 两个输出通道强制共享同一个 s_y = max(logit_max)/127，
     这样 int8 logit 的 argmax 与实值 argmax 在量化域真正等价。

整数语义（与 RTL 契约逐位一致，见 out_v7/INT8_CONTRACT.md）：
  acc = sum(int8 w * int8 x) + int32 bias          （int64 累加，等价 int32 不溢出）
  out = clip(acc >> SH[oc], -128, 127)；conv/g1 之后 ReLU，fc 不接
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as TF

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "nn"))
import quantize as Q  # noqa: E402  只读复用整数 conv/fc 实现

CONV_NAMES = ("conv1", "conv2", "conv3")
FEAT_NAME = "g1"
FC_NAME = "fc"


# ---------------------------------------------------------------------------
# 整数原语（与 nn/quantize.py 逐位相同算术；另提供 shift 前的 int32 累加值）
# ---------------------------------------------------------------------------
def conv2d_acc(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    n, cin, h, wd = x.shape
    cout, _, k, _ = w.shape
    oh = (h - k) // 2 + 1
    ow = (wd - k) // 2 + 1
    acc = np.zeros((n, cout, oh, ow), dtype=np.int64)
    for ky in range(k):
        for kx in range(k):
            xs = x[:, :, ky:ky + h - k + 1:2, kx:kx + wd - k + 1:2].astype(np.int64)
            wk = w[:, :, ky, kx].T.astype(np.int64)
            acc += np.einsum("nchw,co->nohw", xs, wk)
    acc += b.reshape(1, cout, 1, 1).astype(np.int64)
    return acc


def conv2d_int8_v7(x, w, b, sh, relu=True):
    acc = conv2d_acc(x, w, b) >> sh.reshape(1, -1, 1, 1)
    out = np.clip(acc, -128, 127)
    if relu:
        out = np.maximum(out, 0)
    return out.astype(np.int8)


def fc_acc(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    return x.astype(np.int64) @ w.T.astype(np.int64) + b.astype(np.int64).reshape(1, -1)


def fc_int8_v7(x, w, b, sh, relu=False):
    acc = fc_acc(x, w, b) >> sh.reshape(1, -1)
    out = np.clip(acc, -128, 127)
    if relu:
        out = np.maximum(out, 0)
    return out.astype(np.int8)


# ---------------------------------------------------------------------------
# 精确 scale 量化
# ---------------------------------------------------------------------------
def exact_scale(max_abs_w: float, s_y_desired: float):
    """由 max|w_eff| 与期望输出 scale 反推 A、SH，保证 A*2^SH == s_y_desired。"""
    s_y_desired = max(float(s_y_desired), 1e-12)
    if max_abs_w <= 1e-12:
        return s_y_desired, 0, s_y_desired
    ratio = s_y_desired * 127.0 / max_abs_w
    if ratio < 1.0:
        # 死通道：校准输出几乎恒 0，权重满量程表示；s_y 由 max|w_eff| 推出（可能远大于期望）
        A = max_abs_w / 127.0
        return A, 0, A
    SH = int(math.floor(math.log2(ratio)))
    SH = max(0, min(31, SH))
    A = s_y_desired / float(2 ** SH)
    s_y = A * float(2 ** SH)
    return A, SH, s_y


def quant_layer(w_f: np.ndarray, b_f: np.ndarray, s_x: np.ndarray, s_y_desired: np.ndarray):
    """逐输出通道量化。返回 dict（含 w_q/b_q/A/SH/s_y/max|w_q|）。"""
    w_f = np.asarray(w_f, dtype=np.float64)
    b_f = np.asarray(b_f, dtype=np.float64)
    s_x = np.asarray(s_x, dtype=np.float64).reshape(-1)
    s_y_desired = np.asarray(s_y_desired, dtype=np.float64).reshape(-1)
    cout = w_f.shape[0]
    assert s_x.shape[0] == w_f.shape[1], (s_x.shape, w_f.shape)
    w_eff = w_f * s_x.reshape((1, -1) + (1,) * (w_f.ndim - 2))
    max_abs = np.abs(w_eff).reshape(cout, -1).max(axis=1)
    A = np.zeros(cout, dtype=np.float64)
    SH = np.zeros(cout, dtype=np.int64)
    s_y = np.zeros(cout, dtype=np.float64)
    for oc in range(cout):
        A[oc], SH[oc], s_y[oc] = exact_scale(float(max_abs[oc]), float(s_y_desired[oc]))
    scale = A.reshape((cout,) + (1,) * (w_f.ndim - 1))
    w_q = np.rint(w_eff / scale).astype(np.int64)
    max_wq = int(np.abs(w_q).max()) if w_q.size else 0
    w_q = np.clip(w_q, -127, 127).astype(np.int8)
    b_q = np.rint(b_f / A).astype(np.int64)
    return {
        "weight_int8": w_q, "bias_int32": b_q,
        "A": A, "SH": SH, "s_y": s_y,
        "max_abs_w_eff": max_abs, "max_abs_w_q": max_wq,
    }


# ---------------------------------------------------------------------------
# 校准 + 量化整个 v7 模型
# ---------------------------------------------------------------------------
def _act_max(y: np.ndarray, cout: int) -> np.ndarray:
    return y.astype(np.float64).reshape(y.shape[0], y.shape[1], -1).max(axis=(0, 2))


def quantize_v7(model, x_cal: np.ndarray, feat_cal: np.ndarray, headroom: float = 1.0) -> dict:
    """model: v6_common.build_model(kind, n_in=4, n_feat=F, n_out=2) 实例。"""
    model.eval()
    x_q = np.ascontiguousarray(x_cal).astype(np.int8)
    feat_q = None if feat_cal is None else np.ascontiguousarray(feat_cal).astype(np.int8)
    layers = []
    s_x = np.ones(4, dtype=np.float64)
    calib = {"n": int(x_cal.shape[0]), "headroom": float(headroom), "layers": {}}

    convs = [("conv1", model.c1), ("conv2", model.c2), ("conv3", model.c3)]
    for name, conv in convs:
        w_f = conv.weight.detach().numpy()
        b_f = conv.bias.detach().numpy()
        x_real = x_q.astype(np.float64) * s_x.reshape(1, -1, 1, 1)
        with torch.no_grad():
            y = TF.conv2d(torch.from_numpy(x_real).float(), conv.weight, conv.bias, stride=2)
            y = torch.relu(y).numpy()
        act_max = _act_max(y, w_f.shape[0])
        s_y_des = np.where(act_max > 1e-12, act_max / 127.0, 1e-6) * headroom
        q = quant_layer(w_f, b_f, s_x, s_y_des)
        layers.append(_layer_dict(name, w_f, q, s_x, act_max))
        x_q = conv2d_int8_v7(x_q, q["weight_int8"], q["bias_int32"], q["SH"], relu=True)
        calib["layers"][name] = {"act_max": [float(v) for v in act_max],
                                 "out_min": int(x_q.min()), "out_max": int(x_q.max())}
        s_x = q["s_y"]

    s_y_conv = np.asarray(s_x, dtype=np.float64)

    # 特征分支：输入特征本身是 int8（s_x = 1）
    s_y_feat = None
    if feat_q is not None:
        w_f = model.g1.weight.detach().numpy()
        b_f = model.g1.bias.detach().numpy()
        n_feat = w_f.shape[1]
        s_x_f = np.ones(n_feat, dtype=np.float64)
        y = feat_q.astype(np.float64) @ w_f.T + b_f.reshape(1, -1)
        y = np.maximum(y, 0.0)
        act_max = _act_max(y.reshape(y.shape[0], -1, 1, 1), w_f.shape[0])
        s_y_des = np.where(act_max > 1e-12, act_max / 127.0, 1e-6) * headroom
        q = quant_layer(w_f, b_f, s_x_f, s_y_des)
        layers.append(_layer_dict(FEAT_NAME, w_f, q, s_x_f, act_max))
        feat_q = fc_int8_v7(feat_q, q["weight_int8"], q["bias_int32"], q["SH"], relu=True)
        calib["layers"][FEAT_NAME] = {"act_max": [float(v) for v in act_max],
                                      "out_min": int(feat_q.min()), "out_max": int(feat_q.max())}
        s_y_feat = q["s_y"]

    # fc：输入 = conv3 flatten(24*2*5=240) [+ g1 out]
    flat = np.ascontiguousarray(x_q).reshape(x_q.shape[0], -1)
    s_x_fc = [np.repeat(s_y_conv, 10)]
    fc_in = flat
    if feat_q is not None:
        fc_in = np.concatenate([flat, feat_q], axis=1)
        s_x_fc.append(np.asarray(s_y_feat))
    s_x_fc = np.concatenate(s_x_fc)
    w_f = model.fc.weight.detach().numpy()
    b_f = model.fc.bias.detach().numpy()
    x_real = fc_in.astype(np.float64) * s_x_fc.reshape(1, -1)
    logits_real = x_real @ w_f.T + b_f.reshape(1, -1)
    logit_max = np.abs(logits_real).max(axis=0)
    shared = float(np.max(logit_max) / 127.0) * headroom
    if shared <= 1e-12:
        shared = 1e-6
    s_y_des = np.full(w_f.shape[0], shared, dtype=np.float64)
    q = quant_layer(w_f, b_f, s_x_fc, s_y_des)
    layers.append(_layer_dict(FC_NAME, w_f, q, s_x_fc, logit_max))
    calib["layers"][FC_NAME] = {"logit_abs_max": [float(v) for v in logit_max],
                                "shared_logit_scale": shared}
    logits_q = fc_int8_v7(fc_in, q["weight_int8"], q["bias_int32"], q["SH"], relu=False)

    # ROM layout
    layout = []
    offset = 0
    for layer in layers:
        n = int(layer["weight_count"])
        layout.append({"name": layer["name"] + "_w", "start": offset, "end": offset + n, "words": n})
        offset += n
    weight_end = offset
    for layer in layers:
        n = len(layer["bias_int32"])
        layout.append({"name": layer["name"] + "_b", "start": offset, "end": offset + n, "words": n})
        offset += n
    bias_end = offset
    for layer in layers:
        n = len(layer["SH"])
        layout.append({"name": layer["name"] + "_sh", "start": offset, "end": offset + n, "words": n})
        offset += n
    rom_words = offset

    params = {
        "arch": "v7_cnn_glob_bin",
        "data_version": "v7.1-int-rtl-eq",
        "grid": [30, 50],
        "in_ch": 4,
        "num_classes": 2,
        "channels": ["ON_now", "OFF_now", "ON_prev", "OFF_prev"],
        "feat_names": list(getattr(model, "v7_feat_names", [])),
        "input_scale": 1.0,
        "feature_scale": 1.0,
        "logit_scale_shared": shared,
        "layers": layers,
        "layout": layout,
        "weight_words": int(weight_end),
        "bias_words": int(bias_end - weight_end),
        "sh_words": int(rom_words - bias_end),
        "rom_words": int(rom_words),
        "calibration": calib,
        "int8_sample_check": {"logits_int8_min": int(logits_q.min()), "logits_int8_max": int(logits_q.max())},
    }
    return params


def _layer_dict(name, w_f, q, s_x, act_max):
    return {
        "name": name,
        "weight_shape": [int(v) for v in w_f.shape],
        "weight_count": int(w_f.size),
        "weight_int8": [int(v) for v in q["weight_int8"].reshape(-1).tolist()],
        "bias_int32": [int(v) for v in q["bias_int32"].tolist()],
        "SH": [int(v) for v in q["SH"].tolist()],
        "A_scale": [float(v) for v in q["A"].tolist()],
        "s_x_in": [float(v) for v in np.asarray(s_x).reshape(-1).tolist()],
        "s_y_out": [float(v) for v in q["s_y"].tolist()],
        "calib_act_max": [float(v) for v in np.asarray(act_max).reshape(-1).tolist()],
        "max_abs_w_eff": [float(v) for v in q["max_abs_w_eff"].tolist()],
        "max_abs_w_q": int(q["max_abs_w_q"]),
        "s_y_is_exact": bool(np.allclose(q["s_y"], q["A"] * np.exp2(q["SH"].astype(np.float64)), rtol=0, atol=0)),
        "dead_channel_fallback": [int(i) for i in np.where(q["SH"] == 0)[0]],
    }


# ---------------------------------------------------------------------------
# int8 前向（部署口径）
# ---------------------------------------------------------------------------
def forward_int8_v7(x: np.ndarray, feats, params: dict, debug: bool = False):
    """返回 (int8 logits, stats)。debug=True 时 stats 里带每层 shift 前 int32 累加值。"""
    layers = {l["name"]: l for l in params["layers"]}
    acts = np.ascontiguousarray(x).astype(np.int8)
    stats = {}
    dbg = {}
    for name in CONV_NAMES:
        l = layers[name]
        w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        sh = np.asarray(l["SH"], dtype=np.int64)
        if debug:
            dbg[name] = conv2d_acc(acts, w, b)
        acts = conv2d_int8_v7(acts, w, b, sh, relu=True)
        stats[name] = {"in_min": int(acts.min()), "out_min": int(acts.min()),
                       "out_max": int(acts.max())}
        if debug:
            dbg[name + "_out"] = acts.copy()
    feat_acts = None
    if FEAT_NAME in layers:
        assert feats is not None, "model has g1 branch but no features given"
        feat_acts = np.ascontiguousarray(feats).astype(np.int8)
        l = layers[FEAT_NAME]
        w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        sh = np.asarray(l["SH"], dtype=np.int64)
        if debug:
            dbg[FEAT_NAME] = fc_acc(feat_acts, w, b)
        feat_acts = fc_int8_v7(feat_acts, w, b, sh, relu=True)
        stats[FEAT_NAME] = {"out_min": int(feat_acts.min()), "out_max": int(feat_acts.max())}
        if debug:
            dbg[FEAT_NAME + "_out"] = feat_acts.copy()
    flat = np.ascontiguousarray(acts).reshape(acts.shape[0], -1)
    fc_in = flat if feat_acts is None else np.concatenate([flat, feat_acts], axis=1)
    l = layers[FC_NAME]
    w = np.asarray(l["weight_int8"], dtype=np.int8).reshape(l["weight_shape"])
    b = np.asarray(l["bias_int32"], dtype=np.int64)
    sh = np.asarray(l["SH"], dtype=np.int64)
    if debug:
        dbg["fc"] = fc_acc(fc_in, w, b)
    logits = fc_int8_v7(fc_in, w, b, sh, relu=False)
    stats["fc"] = {"out_min": int(logits.min()), "out_max": int(logits.max())}
    if debug:
        dbg["fc_out"] = logits.copy()
        dbg["fc_in"] = fc_in.copy()
        return logits, stats, dbg
    return logits, stats


# ---------------------------------------------------------------------------
# 参数契约检查 / ROM 输出
# ---------------------------------------------------------------------------
def expected_counts(params: dict) -> dict:
    n_feat = len(params.get("feat_names") or [])
    counts = {"conv1": 8 * 4 * 3 * 3, "conv2": 16 * 8 * 3 * 3, "conv3": 24 * 16 * 3 * 3, "fc": 2 * (240 + 16 * (1 if n_feat else 0))}
    biases = {"conv1": 8, "conv2": 16, "conv3": 24, "fc": 2}
    if n_feat:
        counts["g1"] = 16 * n_feat
        biases["g1"] = 16
    return counts, biases


def check_params_v7(params: dict) -> list:
    errors = []
    names = [l["name"] for l in params["layers"]]
    n_feat = len(params.get("feat_names") or [])
    want = ["conv1", "conv2", "conv3"] + (["g1"] if n_feat else []) + ["fc"]
    if names != want:
        errors.append(f"layer order {names} != {want}")
    counts, biases = expected_counts(params)
    for l in params["layers"]:
        n = l["name"]
        if l["weight_count"] != counts[n] or len(l["weight_int8"]) != counts[n]:
            errors.append(f"{n}: weight count mismatch ({l['weight_count']} vs {counts[n]})")
        if len(l["bias_int32"]) != biases[n]:
            errors.append(f"{n}: bias count mismatch")
        if len(l["SH"]) != biases[n]:
            errors.append(f"{n}: SH count mismatch")
        w = np.asarray(l["weight_int8"])
        if w.size and (w.min() < -128 or w.max() > 127):
            errors.append(f"{n}: weight outside int8")
        b = np.asarray(l["bias_int32"], dtype=np.int64)
        if b.size and (b.min() < -2**31 or b.max() > 2**31 - 1):
            errors.append(f"{n}: bias outside int32")
        sh = np.asarray(l["SH"], dtype=np.int64)
        if sh.size and (sh.min() < 0 or sh.max() > 31):
            errors.append(f"{n}: SH outside 0..31")
        A = np.asarray(l["A_scale"], dtype=np.float64)
        sy = np.asarray(l["s_y_out"], dtype=np.float64)
        if not np.array_equal(sy, A * np.exp2(sh.astype(np.float64))):
            errors.append(f"{n}: s_y_out != A*2^SH")
        if len(l["s_x_in"]) != int(l["weight_shape"][1]):
            errors.append(f"{n}: s_x_in length mismatch")
    if params.get("num_classes") != 2:
        errors.append("num_classes != 2")
    words = rom_words_v7(params)
    if len(words) != params["rom_words"]:
        errors.append(f"ROM words {len(words)} != {params['rom_words']}")
    flat = []
    for it in params["layout"]:
        flat.extend(range(it["start"], it["end"]))
    if sorted(flat) != list(range(params["rom_words"])):
        errors.append("layout does not cover ROM exactly once")
    # 权重总字数与 layout 一致
    total_w = sum(l["weight_count"] for l in params["layers"])
    if params["weight_words"] != total_w:
        errors.append("weight_words mismatch")
    return errors


def rom_words_v7(params: dict) -> list:
    words = []
    for l in params["layers"]:
        words.extend(int(v) for v in l["weight_int8"])
    for l in params["layers"]:
        words.extend(int(v) for v in l["bias_int32"])
    for l in params["layers"]:
        words.extend(int(v) for v in l["SH"])
    return words


def write_rom_v7(path, params: dict) -> None:
    words = rom_words_v7(params)
    n = params["rom_words"]
    assert len(words) == n
    addr_bits = max(13, int(math.ceil(math.log2(max(n, 2)))))
    lines = [
        "// Auto-generated by nn/v7/quant_v7.py -- do not edit by hand.",
        f"// v7 binary CNN+glob: conv1 8x4x3x3, conv2 16x8x3x3, conv3 24x16x3x3,",
        f"// g1 16x{len(params.get('feat_names') or [])}, fc 2x{params['layers'][-1]['weight_shape'][1]},",
        f"// int32 bias, per-channel SH; {n} words.",
        "module nn_rom_data(",
        "    output reg [31:0] o_dout,",
        "    input             clk,",
        f"    input      [{addr_bits - 1}:0] i_addr",
        ");",
        "",
        f"    reg [31:0] rom [0:{n - 1}];",
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
    Path(path).write_text("\n".join(lines), encoding="utf-8")
    return words
