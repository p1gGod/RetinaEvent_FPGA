# -*- coding: utf-8 -*-
"""生成 INT8 契约 golden_vectors.json：预处理整数语义 + 8 路全局量 + 逐层 int32/int8 + 网络 logits。"""
import sys, json, hashlib, struct
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for p in ("nn", "nn/v7", "nn/v6"):
    sys.path.insert(0, str(ROOT / p))
import v7_eval as E, v7_feats as F, quant_v7 as QV, intwin as IW, train_v7 as T

import argparse
_ap = argparse.ArgumentParser()
_ap.add_argument("--feats", default="fmin_n_rel7", help="部署特征集（必须与 params.feat_names 一致）")
_ap.add_argument("--data", default=str(ROOT / "nn/v7/windows_v7.npz"))
_args = _ap.parse_args()
FEAT_MODE = _args.feats
OUT = ROOT / "nn/out_v7"
d = E.load(_args.data)
params = json.loads((OUT / "nn_params_v7.json").read_text(encoding="utf-8"))
errs = QV.check_params_v7(params)
assert not errs, errs
model_ck = T.C._torch()[0].load(str(OUT / "model_v7.pt"), map_location="cpu", weights_only=False)
import v6_common as C
model = C.build_model("cnn_glob", n_in=4, n_feat=len(params["feat_names"]), n_out=2)
model.load_state_dict(model_ck["state_dict"]); model.eval()
feats, names = F.build(FEAT_MODE, d["g"])
assert names == params["feat_names"], (names, params["feat_names"])
X = d["X"]; g = d["g"]; y = d["y"]; zone = d["zone"].astype(str)
m = E.masks(d)
pool = np.where(m["primary"] | m["hardneg"] | m["control_neg"])[0]
rng = np.random.default_rng(20261030)
sample = np.sort(rng.choice(pool, size=min(1600, len(pool)), replace=False))

def int8_logits(rows):
    out = []
    for i in range(0, len(rows), 512):
        r = rows[i:i + 512]
        li, _ = QV.forward_int8_v7(X[r], feats[r].astype(np.int8), params)
        out.append(li)
    return np.concatenate(out) if out else np.zeros((0, 2), np.int8)

LS = int8_logits(sample)
margin = LS[:, 1].astype(np.int64) - LS[:, 0].astype(np.int64)
ties = sample[np.where(margin == 0)[0]]
print("sample", len(sample), "ties", len(ties), "near<=1", int((np.abs(margin) <= 1).sum()), flush=True)

def pick(cond, n=1):
    cond = np.asarray(cond, dtype=bool)
    if cond.shape != sample.shape:
        cond = cond[sample]
    r = sample[cond]
    return [int(r[i]) for i in range(min(n, len(r)))]

cols = {k: np.asarray(g[:, i]) for k, i in IW.GIDX.items()}
sxc = cols["sx"].astype(np.int64); syc = cols["sy"].astype(np.int64)
dxc = cols["dx"].astype(np.int64); dyc = cols["dy"].astype(np.int64); spc = cols["speed"].astype(np.int64)
S = np.maximum(IW._isqrt_arr(sxc * syc), 8)
rel_dx = np.clip((dxc << 6) // S, -127, 127)
rel_sp = np.clip((spc << 6) // S, -127, 127)

base = []
used = set()
def add(tag, rows, desc):
    for r in rows:
        if r in used: continue
        used.add(r); base.append({"tag": tag, "row": int(r), "desc": desc})

add("open_left_aug0", pick((zone == "open_L") & (y == 1) & (d["aug"] == 0)), "开合窗（左手视角，aug0）")
add("open_left_aug1", pick((zone == "open_L") & (y == 1) & (d["aug"] == 1)), "开合窗（镜像 aug1）")
add("wave_left", pick((zone == "wave_L") & (y == 2)), "挥手窗（y=2，部署折 class0 硬负）")
add("empty_A", pick((zone == "empty_A") & (y == 0)), "空桌面窗（y=0）")
add("static_a", pick((zone == "static_a") & (y == 0)), "静止手窗（y=0）")
add("openclose_ctrl", pick((zone == "openclose") & (y == 1)), "7min control 开合窗（y=1）")
add("tie0", ties[:1].tolist() if len(ties) else [], "int8 平局（l0==l1）→ 打平取较小类 0")
add("tie1", ties[1:2].tolist() if len(ties) > 1 else [], "int8 平局第二例")
n0 = np.where((cols["n"] == 0) & (cols["prev_n"] > 0))[0]
add("n_zero_hold", [int(r) for r in n0[:1] if r in set(pool)], "n==0 窗（质心保持上一有效值，dx=dy=0）")
floor8 = np.where((S <= 8) & (np.abs(rel_dx) + np.abs(rel_sp) > 0))[0]
add("S_floor8", [int(r) for r in floor8[:1] if r in set(pool)], "S 被下限 8 截断的窗（rel 特征放大/饱和）")
sat = np.where((np.abs(rel_dx) == 127) | (np.abs(rel_sp) == 127))[0]
add("clip127", [int(r) for r in sat[:1] if r in set(pool)], "rel 特征触发 clip127 饱和")

vectors = []
for v in base:
    r = v["row"]
    li, st, dbg = QV.forward_int8_v7(X[r:r + 1], feats[r:r + 1].astype(np.int8), params, debug=True)
    lf = T.predict_logits(model, X[r:r + 1], feats[r:r + 1])
    vi = int(li[0].argmax())
    layers = {}
    for k in ("conv1", "conv2", "conv3", "g1"):
        if k in dbg:
            layers[k] = {"acc_int32": [int(a) for a in dbg[k].ravel()],
                         "out_int8": [int(a) for a in dbg[k + "_out"].ravel()],
                         "out_shape": list(dbg[k + "_out"].shape[1:])}
    layers["fc"] = {"acc_int32": [int(a) for a in dbg["fc"].ravel()],
                    "out_int8": [int(a) for a in dbg["fc_out"].ravel()],
                    "in_int8": [int(a) for a in dbg["fc_in"].ravel()]}
    vectors.append({
        "id": "gv_%02d_%s" % (len(vectors) + 1, v["tag"]),
        "desc": v["desc"],
        "source": {"row": r, "zone": zone[r], "y": int(y[r]), "role": d["role"][r].item() if hasattr(d["role"][r], "item") else str(d["role"][r]),
                   "view": str(d["view"][r]), "aug": int(d["aug"][r]), "fold": int(d["fold"][r]),
                   "hand": str(d["hand"][r]), "win_idx": int(d["win_idx"][r]), "center_ms": int(d["center_ms"][r])},
        "g17": [int(cols[k][r]) if k != "bal" else float(cols["bal"][r]) for k in IW.GLOBAL_NAMES],
        "feat_int8": [int(x) for x in feats[r].astype(np.int64)],
        "X_int8": [int(x) for x in X[r].ravel()],
        "X_shape": list(X[r].shape),
        "layers": layers,
        "logits_int8": [int(li[0][0]), int(li[0][1])],
        "float_logits": [float(lf[0][0]), float(lf[0][1])],
        "class_int8": vi,
        "class_float": int(lf[0].argmax()),
        "margin_int8": int(li[0][1]) - int(li[0][0]),
        "saturate_layers": [k for k in ("conv1", "conv2", "conv3", "g1")
                            if k in dbg and (dbg[k + "_out"].max() >= 127 or dbg[k + "_out"].min() <= -128)],
    })
# 合成饱和向量：X/feat 全 127，逐层与输出均触发 clamp（RTL clamp 语义刻意用例）
Xs = np.full((1, 4, 30, 50), 127, np.int8)
fs = np.full((1, len(params["feat_names"])), 127, np.int8)
li, st, dbg = QV.forward_int8_v7(Xs, fs, params, debug=True)
layers = {}
for k in ("conv1", "conv2", "conv3", "g1"):
    if k in dbg:
        layers[k] = {"acc_int32": [int(a) for a in dbg[k].ravel()],
                     "out_int8": [int(a) for a in dbg[k + "_out"].ravel()],
                     "out_shape": list(dbg[k + "_out"].shape[1:])}
layers["fc"] = {"acc_int32": [int(a) for a in dbg["fc"].ravel()],
                "out_int8": [int(a) for a in dbg["fc_out"].ravel()],
                "in_int8": [int(a) for a in dbg["fc_in"].ravel()]}
vectors.append({
    "id": "gv_%02d_saturate_all127" % (len(vectors) + 1),
    "desc": "合成饱和用例：X 与 7 路特征全 127，conv/g1 输出饱和 127，fc 两端 clamp(-128,127)",
    "source": {"row": -1, "zone": "synthetic", "y": -1, "role": "synthetic", "view": "synthetic",
               "aug": 0, "fold": -1, "hand": "synthetic", "win_idx": -1, "center_ms": -1},
    "g17": [127 if k != "bal" else 1.0 for k in IW.GLOBAL_NAMES],
    "feat_int8": [127] * len(params["feat_names"]),
    "X_int8": [127] * 6000,
    "X_shape": list(Xs.shape[1:]),
    "layers": layers,
    "logits_int8": [int(li[0][0]), int(li[0][1])],
    "float_logits": [0.0, 0.0],
    "class_int8": int(li[0].argmax()),
    "class_float": -1,
    "margin_int8": int(li[0][1]) - int(li[0][0]),
    "saturate_layers": [k for k in ("conv1", "conv2", "conv3", "g1")
                        if k in dbg and (dbg[k + "_out"].max() >= 127 or dbg[k + "_out"].min() <= -128)],
    "note": "float_logits/class_float 无意义（合成输入），仅 int8 参考用",
})
print("net vectors", len(vectors), flush=True)

# ---------------- 预处理整数语义向量（合成事件，覆盖 非整除质心 / n=0 carry / clamp / SAT） ----------------
def pack_X_sparse(Xw):
    ch, H, W = Xw.shape
    items = []
    for c in range(ch):
        idx = np.argwhere(Xw[c] != 0)
        for h, w in idx:
            items.append([c, int(h), int(w), int(Xw[c, h, w])])
    return items

def preprocess_case(tag, desc, events, n_win):
    # 事件域校验：硬件 x 为 9 bit 无符号 0..511、y 为 8 bit 0..255、pol 0/1，时间必须单调。
    # 越界直接 raise（不静默裁剪），错误信息带向量 id 与事件序号，便于 TB 定位。
    for idx, e in enumerate(events):
        if len(e) != 4:
            raise ValueError("%s: event[%d] must be [t_rel_ms,x,y,pol], got %r" % (tag, idx, e))
        te, xe, ye, pe = (int(v) for v in e)
        if not (0 <= xe <= 511):
            raise ValueError("%s: event[%d] x=%d outside hardware uint9 range 0..511 (event=%r)" % (tag, idx, xe, e))
        if not (0 <= ye <= 255):
            raise ValueError("%s: event[%d] y=%d outside hardware uint8 range 0..255 (event=%r)" % (tag, idx, ye, e))
        if pe not in (0, 1):
            raise ValueError("%s: event[%d] pol=%d not in {0,1} (event=%r)" % (tag, idx, pe, e))
        if idx > 0 and te < int(events[idx - 1][0]):
            raise ValueError("%s: event[%d] t_rel_ms=%d not monotonic (prev=%d)" % (tag, idx, te, int(events[idx - 1][0])))
    rel = np.array([e[0] for e in events], dtype=np.int64)
    x = np.array([e[1] for e in events], dtype=np.int64)
    yy = np.array([e[2] for e in events], dtype=np.int64)
    pol = np.array([e[3] for e in events], dtype=np.int64)
    g0 = int(rel[0]); n_sub = (int(rel[-1]) - g0) // IW.STRIDE_MS + 2
    sub = IW.subblock_stats(rel, x, yy, pol, g0, n_sub)
    stats = IW.window_stats(sub, n_win)
    Xw, _, _ = IW.shifted_grids(rel, x, yy, pol, g0, n_win, stats, log=None)
    gw = stats["g"]
    feats_w, fnames = F.build(FEAT_MODE, gw)
    Sw = np.maximum(IW._isqrt_arr(np.maximum(gw[:, IW.GIDX["sx"]], 0) * np.maximum(gw[:, IW.GIDX["sy"]], 0)), 8)
    return {
        "id": tag, "desc": desc,
        "input": {"g0": g0, "n_win": n_win, "n_sub": n_sub,
                  "events": [[int(a), int(b), int(c), int(dd)] for a, b, c, dd in events],
                  "event_order": "t_rel_ms, x, y, pol(1=rise,0=fall)"},
        "subblock_expected": {k: [int(v) for v in sub[k]] for k in ("N", "ON", "OFF", "SX", "SY", "SX2", "SY2")},
        "window_expected": {k: [int(v) for v in stats[k]] for k in
                            ("n", "on", "off", "cx", "cy", "sx", "sy", "pcx", "pcy", "dx", "dy", "speed", "prev_n")},
        "g17_expected": [[int(v) if j != 14 else float(v) for j, v in enumerate(row)] for row in gw],
        "feat_names": list(fnames),
        "feat_expected_int8": [[int(v) for v in row] for row in feats_w.astype(np.int64)],
        "S_expected": [int(v) for v in Sw],
        "X_sparse_nonzero": [[k, pack_X_sparse(Xw[k])] for k in range(n_win)],
        "X_note": "未列出的网格单元为 0；通道 0/1=now rise/fall，2/3=上一窗 now",
    }

t0 = 10000
P = []
P.append(preprocess_case("pp01_centroid_floor", "窗口 0 质心 Sx/n 非整除（floor）；窗口 1 有效质心", [
    [t0 + 0, 101, 51, 1], [t0 + 10, 104, 57, 0], [t0 + 20, 110, 61, 1],
    [t0 + 60, 300, 101, 0], [t0 + 70, 303, 107, 1], [t0 + 80, 310, 113, 0],
    [t0 + 120, 120, 71, 1], [t0 + 130, 127, 77, 0], [t0 + 140, 133, 83, 1],
], 2))
P.append(preprocess_case("pp02_n_zero_carry", "窗口 0 有事件；窗口 1 全空 → n=0，质心保持窗口 0 值、dx=dy=0、sx=sy=0", [
    [t0 + 0, 150, 80, 1], [t0 + 10, 154, 86, 0], [t0 + 20, 160, 90, 1],
], 2))
# pp03 只用硬件可表达的事件域（x 0..511, y 0..255）：x=402/y=250 在网格 clamp 到 399/239（n_bad=1），
# 两窗各 128 个同 cell 同通道事件触发 SAT=127；质心从 399 跳到 0 使 dx_rel/dy_rel 饱和到 ±127。
pp03 = [[t0 + (i * 49) // 126, 399, 239, 1] for i in range(127)]
pp03.append([t0 + 49, 402, 250, 0])
pp03 += [[t0 + 100 + (i * 49) // 127, 0, 0, 0] for i in range(128)]
P.append(preprocess_case("pp03_clamp_and_sat", "事件域内极值：x=402/y=250 被网格 clamp 到 399/239（n_bad=1）；两窗同 cell 同通道 128 次累积触发 SAT=127；质心 399→0 使 dx_rel/dy_rel 饱和到 ±127", pp03, 2))

# pp04 正方形手：x/y 展布相近 → sx≈sy，S>8
sq = []
for i, xx in enumerate(range(100, 181, 20)):
    for j, yy2 in enumerate(range(60, 141, 20)):
        sq.append([t0 + (i * 5 + j) * 2, xx, yy2, (i + j) % 2])
P.append(preprocess_case("pp04_square_hand", "正方形手：x/y 展布相近（sx≈sy），S>8，验 isqrt(sx*sy) 与 rel 特征", sq, 1))
# pp05 细长手：x 展布 80 / y 展布 20 → sx≠sy
sl = []
for i, xx in enumerate(range(100, 181, 20)):
    for j, yy2 in enumerate(range(100, 121, 10)):
        sl.append([t0 + (i * 3 + j) * 2, xx, yy2, (i + j) % 2])
P.append(preprocess_case("pp05_slender_hand", "细长手：x 展布 80/y 展布 20（sx≠sy），验 S 与 rel 缩放", sl, 1))
# pp06 var 极小：全部事件同一 cell → sx=sy=0 → S 兜底 8
tiny = [[t0 + i * 2, 200, 120, i % 2] for i in range(12)]
P.append(preprocess_case("pp06_var_tiny_S_floor", "所有事件同一 cell → sx=sy=0，S=max(isqrt(0),8)=8 兜底", tiny, 1))

out = {
    "schema": "fpga_comp.v7.int8_golden.v1",
    "generated_utc": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "data_sha256": hashlib.sha256((ROOT / "nn/v7/windows_v7.npz").read_bytes()).hexdigest(),
    "params_sha256": hashlib.sha256((OUT / "nn_params_v7.json").read_bytes()).hexdigest(),
    "model_sha256": hashlib.sha256((OUT / "model_v7.pt").read_bytes()).hexdigest(),
    "arch": params["arch"], "num_classes": params["num_classes"],
    "feat_names": params["feat_names"],
    "quant_contract": {
        "conv_forward": "acc[oc][oh][ow] = bias_q[oc] + sum_{ic,kh,kw} x[ic][ih][iw]*w_q[oc][ic][kh][kw]; ih=oh*2+kh, iw=ow*2+kw",
        "shift": "y[oc][oh][ow] = clamp(acc >> SH[oc], 0, 127)  (ReLU 后接 int8 饱和；算术右移)",
        "g1": "acc[o] = bias_q[o] + sum_{i} f_q[i]*w_q[o][i]; y[o] = clamp(acc >> SH[o], 0, 127)",
        "fc": "acc[c] = bias_q[c] + sum_{i} in_q[i]*w_q[c][i]; logit[c] = clamp(acc >> SH[c], -128, 127)",
        "argmax_tie_break": "l1 > l0 ? 1 : 0  (平局取较小类索引 0)",
        "feature_formula": (lambda fn: {
            "S": "S = max(isqrt(sx*sy), 8)  (sx/sy 为窗口像素标准差，见第 1 节)",
            **{k: v for k, v in {
                "n_div16": "min(127, n>>4)",
                "prev_n_div16": "min(127, prev_n>>4)",
                "pol_bal": "clamp( trunc_div((on-off)*127, max(n,1)), -127, 127 )",
                "dx": "clamp((cx-pcx)>>2, -127, 127)",
                "dy": "clamp((cy-pcy)>>1, -127, 127)",
                "dx_rel": "clamp( trunc_div((cx-pcx)<<6, S), -127, 127)",
                "dy_rel": "clamp( trunc_div((cy-pcy)<<6, S), -127, 127)",
                "speed_rel": "clamp( trunc_div(isqrt((cx-pcx)^2+(cy-pcy)^2)<<6, S), -127, 127)",
            }.items() if k in fn},
        })(params["feat_names"]),
    },
    "net_vectors": vectors,
    "preprocess_vectors": P,
    "tie_cases": [v["id"] for v in vectors if v["margin_int8"] == 0],
}
(OUT / "golden_vectors.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("wrote", OUT / "golden_vectors.json", (OUT / "golden_vectors.json").stat().st_size, "bytes", flush=True)
print("tie ids", out["tie_cases"], flush=True)
print("saturate", [(v["id"], v["saturate_layers"]) for v in vectors if v["saturate_layers"]], flush=True)