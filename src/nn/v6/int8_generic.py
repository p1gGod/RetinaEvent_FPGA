#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""通用 int8 量化/前向（复用 nn/quantize.py 的折叠规则，只读 import）。

支持三类结构：
  - cnn:       conv1/2/3 + fc（4ch 或 8ch 输入）
  - cnn_glob:  conv1/2/3 + 全局量 Linear(g1)+ReLU + fc(concat)
  - scalar:    纯 MLP（3 层 Linear，前两层 ReLU）

规则与 nn/quantize.py:quantize_model 完全一致：按输入通道把激活 scale 折进权重，
逐输出通道对称量化 + SH=round(log2(s_y_desired/A))，bias=round(b/A)，int8 前向
conv 除 SH 后 clip(-128,127)+ReLU、fc 只 clip。仅作离线一致率评估，RTL 契约仍以
nn/quantize.py 为准。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path("E:/workspace/FPGA_Comp")
sys.path.insert(0, str(ROOT / "nn"))
import quantize as Q  # noqa: E402

# 标定头寸：act_max 乘 1.3 再定 SH，抵消 pow2 取整向下的 clip（参数结构不变，仅标定更保守）
HEADROOM = 1.0


def _make_layer(name, w_q, b_q, SH, w_f, s_x, s_y, act_max):
    return {
        "name": name,
        "weight_shape": list(w_f.shape),
        "weight_count": int(w_q.size),
        "weight_int8": [int(v) for v in w_q.reshape(-1).tolist()],
        "bias_int32": [int(v) for v in b_q.tolist()],
        "SH": [int(v) for v in SH.tolist()],
        "A_scale": [float(v) for v in _A_of(w_q, w_f, s_x)],
        "s_x_in": [float(v) for v in np.asarray(s_x).reshape(-1).tolist()],
        "s_y_out": [float(v) for v in s_y.tolist()],
        "calib_act_max": [float(v) for v in act_max.tolist()],
    }


def _A_of(w_q, w_f, s_x):
    # 仅用于 metadata：从量化结果反推 A 不可行，重算一遍
    import numpy as _np
    w_eff = w_f * _np.asarray(s_x).reshape((1, -1) + (1,) * (w_f.ndim - 2))
    mx = _np.abs(w_eff).reshape(w_f.shape[0], -1).max(axis=1)
    return _np.where(mx > 1e-12, mx / 127.0, 1.0)


def _linear_layer(name, x_q, s_x, w_f, b_f, relu=True):
    w_q, A = Q._quant_layer_weights(w_f, s_x)
    x_real = x_q.astype(np.float64) * np.asarray(s_x).reshape(1, -1)
    y = x_real @ w_f.T + b_f.reshape(1, -1)
    if relu:
        y = np.maximum(y, 0.0)
    act_max = np.abs(y).max(axis=0)
    s_y_desired = np.where(act_max > 1e-12, act_max * HEADROOM / 127.0, 1e-6)
    SH, s_y = Q._shift_for(A, s_y_desired)
    b_q = np.rint(b_f / A).astype(np.int64)
    assert np.all(np.abs(b_q) < 2 ** 31), name + " bias overflow"
    out_q = Q.fc_int8(x_q, w_q, b_q, SH)
    if relu:
        out_q = np.maximum(out_q, 0).astype(np.int8)
    layer = {
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
    }
    return layer, out_q, s_y


def _feat_scale(feats_cal):
    m = float(np.abs(feats_cal).max()) if len(feats_cal) else 0.0
    return (m / 127.0) if m > 1e-12 else 1.0


def quantize_generic(model, x_cal, feats_cal=None, n_layers_hint=None):
    """返回 {kind, layers, feat_scale}；layers 顺序 = 前向执行顺序。"""
    layers = []
    has_conv = hasattr(model, "c1")
    has_glob = hasattr(model, "g1")
    if has_conv:
        x_q = np.asarray(x_cal, dtype=np.int8)
        s_x = np.ones(x_q.shape[1], dtype=np.float64)
        for name, conv in (("conv1", model.c1), ("conv2", model.c2), ("conv3", model.c3)):
            w_f = conv.weight.detach().numpy().astype(np.float64)
            b_f = conv.bias.detach().numpy().astype(np.float64)
            w_q, A = Q._quant_layer_weights(w_f, s_x)
            x_real = x_q.astype(np.float64) * s_x.reshape(1, -1, 1, 1)
            with torch.no_grad():
                y = F.conv2d(torch.from_numpy(x_real).float(), conv.weight, conv.bias, stride=2)
                y = torch.relu(y).numpy().astype(np.float64)
            act_max = y.reshape(y.shape[0], y.shape[1], -1).max(axis=(0, 2))
            s_y_desired = np.where(act_max > 1e-12, act_max * HEADROOM / 127.0, 1e-6)
            SH, s_y = Q._shift_for(A, s_y_desired)
            b_q = np.rint(b_f / A).astype(np.int64)
            assert np.all(np.abs(b_q) < 2 ** 31), name + " bias overflow"
            layers.append({
                "name": name, "weight_shape": list(w_f.shape),
                "weight_count": int(w_q.size),
                "weight_int8": [int(v) for v in w_q.reshape(-1).tolist()],
                "bias_int32": [int(v) for v in b_q.tolist()],
                "SH": [int(v) for v in SH.tolist()],
                "A_scale": [float(v) for v in A.tolist()],
                "s_x_in": [float(v) for v in np.asarray(s_x).reshape(-1).tolist()],
                "s_y_out": [float(v) for v in s_y.tolist()],
                "calib_act_max": [float(v) for v in act_max.tolist()],
            })
            x_q = Q.conv2d_int8(x_q, w_q, b_q, SH, relu=True)
            s_x = s_y
        feat_scale = None
        g_out = None
        g_scale = None
        if has_glob:
            feat_scale = _feat_scale(feats_cal)
            feats_q = np.clip(np.rint(np.asarray(feats_cal) / feat_scale), -128, 127).astype(np.int8)
            s_g = np.full(feats_q.shape[1], feat_scale, dtype=np.float64)
            w_f = model.g1.weight.detach().numpy().astype(np.float64)
            b_f = model.g1.bias.detach().numpy().astype(np.float64)
            gl, g_out, g_scale = _linear_layer("g1", feats_q, s_g, w_f, b_f, relu=True)
            layers.append(gl)
        # fc: concat(conv flat, g1 out)
        flat = x_q.reshape(x_q.shape[0], -1)
        s_flat = np.repeat(np.asarray(s_x, dtype=np.float64), 10)
        if has_glob:
            s_fc = np.concatenate([s_flat, g_scale])
            x_fc = np.concatenate([flat, g_out], axis=1)
        else:
            s_fc = s_flat
            x_fc = flat
        w_f = model.fc.weight.detach().numpy().astype(np.float64)
        b_f = model.fc.bias.detach().numpy().astype(np.float64)
        fl, _logits, _s = _linear_layer("fc", x_fc, s_fc, w_f, b_f, relu=False)
        layers.append(fl)
        return {"kind": "cnn_glob" if has_glob else "cnn", "layers": layers,
                "feat_scale": feat_scale, "n_in": int(x_cal.shape[1])}
    # scalar-only: nn.Sequential(Linear,ReLU,Linear,ReLU,Linear)
    lin = [m for m in model.modules() if isinstance(m, torch.nn.Linear)]
    feat_scale = _feat_scale(feats_cal)
    feats_q = np.clip(np.rint(np.asarray(feats_cal) / feat_scale), -128, 127).astype(np.int8)
    x_q = feats_q
    s_x = np.full(feats_q.shape[1], feat_scale, dtype=np.float64)
    for i, l in enumerate(lin):
        relu = i < len(lin) - 1
        w_f = l.weight.detach().numpy().astype(np.float64)
        b_f = l.bias.detach().numpy().astype(np.float64)
        ly, x_q, s_x = _linear_layer("fc%d" % (i + 1), x_q, s_x, w_f, b_f, relu=relu)
        layers.append(ly)
    return {"kind": "scalar", "layers": layers, "feat_scale": feat_scale, "n_in": 0}


def forward_generic(x, feats, params):
    kind = params["kind"]
    xq = None if x is None else np.asarray(x, dtype=np.int8)
    fq = None
    if kind in ("cnn_glob", "scalar"):
        fq = np.clip(np.rint(np.asarray(feats) / params["feat_scale"]), -128, 127).astype(np.int8)
    if kind == "scalar":
        acts = fq
        for layer in params["layers"]:
            w = np.asarray(layer["weight_int8"], dtype=np.int8).reshape(layer["weight_shape"])
            b = np.asarray(layer["bias_int32"], dtype=np.int64)
            sh = np.asarray(layer["SH"], dtype=np.int64)
            acts = Q.fc_int8(acts, w, b, sh)
            if layer["name"] != "fc%d" % len(params["layers"]):
                acts = np.maximum(acts, 0).astype(np.int8)
        return acts
    acts = xq
    g = None
    for layer in params["layers"]:
        w = np.asarray(layer["weight_int8"], dtype=np.int8).reshape(layer["weight_shape"])
        b = np.asarray(layer["bias_int32"], dtype=np.int64)
        sh = np.asarray(layer["SH"], dtype=np.int64)
        if layer["name"] == "g1":
            g = Q.fc_int8(fq, w, b, sh)
            g = np.maximum(g, 0).astype(np.int8)
        elif layer["name"] == "fc":
            flat = np.ascontiguousarray(acts).reshape(acts.shape[0], -1)
            if g is not None:
                flat = np.concatenate([flat, g], axis=1)
            acts = Q.fc_int8(flat, w, b, sh)
        else:
            acts = Q.conv2d_int8(acts, w, b, sh, relu=True)
    return acts
