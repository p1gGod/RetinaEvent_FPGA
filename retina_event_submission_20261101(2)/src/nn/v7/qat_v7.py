# -*- coding: utf-8 -*-
"""task-42 QAT：固定 PTQ 的 A/SH/s_y，用整数前向的 straight-through 版本微调。

整数链路（与 nn/quantize.py / nn/v7/quant_v7.py 逐位一致）：
  acc   = sum(w_q * x_int) + b_q              (int32)
  y_int = clip(floor(acc / 2^SH), -128, 127)  (算术右移=floor；conv 后接 ReLU)
  y     = y_int * s_y                          (部署等价实数)
实数域等价写法（QAT 用）：
  w_eff = w * s_x (float)；w_q = clip(rint(w_eff/A), -127,127)；wd = w_q*A/s_x
  pre   = conv(x_int*s_x, wd) + b_q*A；y_int = clip(floor(pre/s_y), -128,127)
因此训练时梯度经 STE 穿过 rint/floor/clip，直接优化部署整数链路的交叉熵。
"""
import numpy as np
import torch
import torch.nn.functional as Fn

import quant_v7 as QV

MODMAP = {"conv1": "c1", "conv2": "c2", "conv3": "c3", "g1": "g1", "fc": "fc"}


def _layer_dict(params):
    return {l["name"]: l for l in params["layers"]}


def _arr(v, dtype=np.float32):
    return np.asarray(v, dtype=dtype)


def _qweight(w, A, s_x, is_conv=True):
    """实数权重量化 + STE：返回 wd ≈ w_q * A / s_x（实数域）。"""
    if is_conv:
        a = torch.as_tensor(A, dtype=w.dtype).view(-1, 1, 1, 1)
        sx = torch.as_tensor(s_x, dtype=w.dtype).view(1, -1, 1, 1)
    else:
        a = torch.as_tensor(A, dtype=w.dtype).view(-1, 1)
        sx = torch.as_tensor(s_x, dtype=w.dtype).view(1, -1)
    q = torch.clamp(torch.round(w * sx / a), -127.0, 127.0)
    wd = q * a / sx
    return w + (wd - w).detach()


def _qact(y_int):
    """已经是整数格点值，仅用于统一接口（STE 恒等）。"""
    return y_int


def _to_int(pre, s_y, is_conv):
    if is_conv:
        s = torch.as_tensor(s_y, dtype=pre.dtype).view(1, -1, 1, 1)
    else:
        s = torch.as_tensor(s_y, dtype=pre.dtype).view(1, -1)
    y = torch.floor(pre / s)
    return torch.clamp(y, -128.0, 127.0)


def fake_forward(model, x, feats, params):
    """返回 (q_logits_int, float_logits)。q_logits_int 为量化链路 int8 格点值（floor 后 clip）。"""
    L = _layer_dict(params)
    h = x.float()
    q_int = {}
    for name in ("conv1", "conv2", "conv3"):
        l = L[name]
        mod = getattr(model, MODMAP[name])
        wd = _qweight(mod.weight, l["A_scale"], l["s_x_in"], is_conv=True)
        A = torch.as_tensor(_arr(l["A_scale"]), dtype=h.dtype)
        bq = torch.as_tensor(_arr(l["bias_int32"], np.float32), dtype=h.dtype)
        pre = Fn.conv2d(h, wd, bias=bq * A, stride=2)
        y = _to_int(pre, _arr(l["s_y_out"]), is_conv=True)
        q_int[name] = y
        h = torch.relu(y) * torch.as_tensor(_arr(l["s_y_out"]), dtype=h.dtype).view(1, -1, 1, 1)
    h = h.flatten(1)
    if "g1" in L:
        feat = feats.float()
        l = L["g1"]
        wd = _qweight(model.g1.weight, l["A_scale"], l["s_x_in"], is_conv=False)
        A = torch.as_tensor(_arr(l["A_scale"]), dtype=h.dtype)
        bq = torch.as_tensor(_arr(l["bias_int32"], np.float32), dtype=h.dtype)
        pre = Fn.linear(feat, wd, bq * A)
        y = _to_int(pre, _arr(l["s_y_out"]), is_conv=False)
        q_int["g1"] = y
        h = torch.cat([h, torch.relu(y) * torch.as_tensor(_arr(l["s_y_out"]), dtype=h.dtype).view(1, -1)], dim=1)
    l = L["fc"]
    wd = _qweight(model.fc.weight, l["A_scale"], l["s_x_in"], is_conv=False)
    A = torch.as_tensor(_arr(l["A_scale"]), dtype=h.dtype)
    bq = torch.as_tensor(_arr(l["bias_int32"], np.float32), dtype=h.dtype)
    pre = Fn.linear(h, wd, bq * A)
    q_logits = _to_int(pre, _arr(l["s_y_out"]), is_conv=False)
    q_int["fc"] = q_logits
    fl = model(x.float(), feats.float()) if feats is not None else model(x.float())
    return q_logits, fl


def refresh_params(model, params):
    """把 QAT 后的浮点权重按原 A/SH 重新量化回 params（A/SH/s_y 不变）。"""
    L = _layer_dict(params)
    for name, l in L.items():
        mod = getattr(model, MODMAP[name])
        w = mod.weight.detach().cpu().numpy().astype(np.float64)
        b = mod.bias.detach().cpu().numpy().astype(np.float64)
        A = _arr(l["A_scale"], np.float64)
        sx = _arr(l["s_x_in"], np.float64)
        if w.ndim == 4:
            w_eff = w * sx.reshape(1, -1, 1, 1)
            wq = np.clip(np.rint(w_eff / A.reshape(-1, 1, 1, 1)), -127, 127).astype(np.int8)
        else:
            w_eff = w * sx.reshape(1, -1)
            wq = np.clip(np.rint(w_eff / A.reshape(-1, 1)), -127, 127).astype(np.int8)
        l["weight_int8"] = wq.ravel().astype(int).tolist()
        l["bias_int32"] = np.rint(b / A).astype(np.int32).tolist()
        l["max_abs_w_q"] = float(np.abs(wq.astype(np.float64)).max())
    return params


def qat_finetune(model, params, x_tr, feat_tr, y_tr, sw, epochs=8, lr=3e-4,
                 seed=1234, lam_float=0.5, verbose=False):
    """固定量化尺度，微调模型；返回 model（原地）。"""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    n = len(y_tr)
    counts = np.bincount(y_tr, minlength=2).astype(np.float64)
    counts[counts == 0] = 1.0
    cw = torch.tensor(np.clip(np.sqrt(n / (2 * counts)), 0.5, 3.0), dtype=torch.float32)
    lossf = torch.nn.CrossEntropyLoss(weight=cw, reduction="none")
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    xt = torch.from_numpy(np.ascontiguousarray(x_tr)).float()
    ft = None if feat_tr is None else torch.from_numpy(np.ascontiguousarray(feat_tr)).float()
    yt = torch.from_numpy(np.ascontiguousarray(y_tr)).long()
    swt = torch.from_numpy(np.ascontiguousarray(sw)).float()
    batch = 128
    for ep in range(epochs):
        perm = rng.permutation(n)
        tot = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            xb = xt[idx]
            fb = None if ft is None else ft[idx]
            yb = yt[idx]
            wb = swt[idx]
            q_logits, fl = fake_forward(model, xb, fb, params)
            lq = (lossf(q_logits, yb) * wb).sum() / wb.sum()
            lf = (lossf(fl, yb) * wb).sum() / wb.sum()
            loss = lq + lam_float * lf
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.detach()) * len(idx)
        if verbose:
            print(f"[qat] epoch {ep + 1}/{epochs} loss={tot / max(n, 1):.4f}", flush=True)
    return model
