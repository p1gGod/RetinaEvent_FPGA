# -*- coding: utf-8 -*-
"""M9d 数字核验：把评测报告/图表中的关键数字逐条锚到源文件行。
运行：nn/.venv/Scripts/python.exe report/figures/verify_numbers.py
末行输出 NUMBERS_VERIFIED=1；任一不符即退出 1。
"""
import csv
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = {}
JSONS = {}
CHECKS = 0
LINES = 0
DERIVED = 0
TABLES = 0
SVGS = 0
FAILS = []


def fail(msg):
    FAILS.append(msg)
    print("FAIL " + msg)


def read(rel):
    if rel not in CACHE:
        CACHE[rel] = (ROOT / rel).read_text(encoding="utf-8")
    return CACHE[rel]


def line_check(label, rel, lineno, needles, shown):
    global CHECKS, LINES
    CHECKS += 1
    rows = read(rel).splitlines()
    if lineno < 1 or lineno > len(rows):
        fail("%s: %s:%d out of range" % (label, rel, lineno))
        return
    row = rows[lineno - 1]
    if isinstance(needles, str):
        needles = [needles]
    miss = [n for n in needles if n not in row]
    if miss:
        fail("%s: %s:%d missing %r in %r" % (label, rel, lineno, miss, row[:180]))
        return
    LINES += 1
    print("LINE OK %-34s %s:%d = %s" % (label, rel, lineno, shown))


def get_json(rel):
    if rel not in JSONS:
        JSONS[rel] = json.loads(read(rel))
    return JSONS[rel]


def walk(obj, path):
    cur = obj
    for key in path:
        if isinstance(key, int):
            cur = cur[key]
        else:
            cur = cur[key]
    return cur


def json_check(label, rel, path, expected, ref):
    global CHECKS, LINES
    CHECKS += 1
    try:
        got = walk(get_json(rel), path)
    except Exception as exc:
        fail("%s: %s key path %r -> %s" % (label, rel, path, exc))
        return
    ok = False
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        try:
            ok = abs(float(got) - float(expected)) <= max(1e-9, 1e-6 * abs(float(expected)))
        except (TypeError, ValueError):
            ok = False
    else:
        ok = got == expected
    if not ok:
        fail("%s: %s %r got=%r expected=%r" % (label, rel, path, got, expected))
        return
    LINES += 1
    print("JSON OK %-34s %s = %r (%s)" % (label, rel, got, ref))


def derived(label, got, expected, tol, basis):
    global CHECKS, DERIVED
    CHECKS += 1
    if abs(float(got) - float(expected)) > tol:
        fail("%s: got=%.10g expected=%.10g (%s)" % (label, got, expected, basis))
        return
    DERIVED += 1
    print("CALC OK %-34s %.10g = %s" % (label, got, basis))


# ---- 1. 资源基线/预算/实现 ----
line_check("MAC 单窗", "docs/03_tech/04_action_recognition_selection.md", 15, ["208,080"], "208,080 MAC")
line_check("M0 LUT", "docs/03_tech/04_action_recognition_selection.md", 77, ["18,973"], "18,973")
line_check("M0 FF", "docs/03_tech/04_action_recognition_selection.md", 78, ["11,296"], "11,296")
line_check("M0 DSP", "docs/03_tech/04_action_recognition_selection.md", 81, ["DSP48E1 | 6"], "6")
line_check("预算 LUT 增量", "docs/03_tech/04_action_recognition_selection.md", 177, ["+2,800"], "+2,800")
line_check("预算 BRAM 基线", "docs/03_tech/04_action_recognition_selection.md", 180, ["77.5"], "77.5")
line_check("预算 DSP 增量", "docs/03_tech/04_action_recognition_selection.md", 181, ["+8"], "+8")
line_check("act3c LUT", "build/variant_act3c/inproc_util_impl.rpt", 34, ["20559", "32.43"], "20,559 / 32.43%")
line_check("act3c FF", "build/variant_act3c/inproc_util_impl.rpt", 39, ["11850", "9.35"], "11,850 / 9.35%")
line_check("act3c Slice", "build/variant_act3c/inproc_util_impl.rpt", 72, ["7327", "46.23"], "7,327 / 46.23%")
line_check("act3c BRAM", "build/variant_act3c/inproc_util_impl.rpt", 104, ["87", "64.44"], "87 / 64.44%")
line_check("act3c DSP", "build/variant_act3c/inproc_util_impl.rpt", 119, ["DSPs", "7", "2.92"], "7 / 2.92%")
line_check("act3c IOB", "build/variant_act3c/inproc_util_impl.rpt", 130, ["140", "49.12"], "140 / 49.12%")
line_check("M3C LUT", "sim/nn/EVIDENCE_M3c.md", 176, ["21,518", "21,913", "+395"], "21,518 -> 21,913 (+395)")
line_check("交付 WNS/WHS", "build/variant_act3c/timing_deliver.rpt", 131,
           ["0.306", "0.036", "76854"], "WNS +0.306 / WHS +0.036 / 76854")
line_check("eth_rxc 0.306", "build/variant_act3c/timing_deliver.rpt", 189, ["eth_rxc", "0.306"], "eth_rxc WNS 0.306")
line_check("clk_out2 50 MHz", "build/variant_act3c/timing_deliver.rpt", 220, ["clk_out2", "2.695"], "50 MHz WNS 2.695")
derived("LUT 实测增量", 20559 - 18973, 1586, 0, "20,559-18,973")
derived("FF 实测增量", 11850 - 11296, 554, 0, "11,850-11,296")
derived("BRAM 实测增量", 87 - 77.5, 9.5, 1e-9, "87-77.5")
derived("DSP 实测增量", 7 - 6, 1, 0, "7-6")
derived("M3C LUT 增量", 21913 - 21518, 395, 0, "21,913-21,518")

# ---- 2. 推理周期 ----
line_check("M3 推理延迟", "sim/nn/EVIDENCE_M3.md", 29,
           ["440,087 拍 @50 MHz = 8.80 ms"], "440,087 拍 / 8.80 ms")
line_check("M3 周期分解", "sim/nn/EVIDENCE_M3.md", 121,
           ["2x208,080", "6x3,987", "+ 5"], "440,087=2x208,080+6x3,987+5")
line_check("M3 占空比", "sim/nn/EVIDENCE_M3.md", 123, ["8.80%"], "8.80%")
line_check("M3 K=6", "sim/nn/EVIDENCE_M3.md", 125, ["827,154 拍 = 16.54 ms"], "827,154 拍 / 16.54 ms")
line_check("M3 版本 WNS", "sim/nn/EVIDENCE_M3.md", 205, ["-7.001", "+8.827"], "-7.001 / +8.827 ns")
derived("MAC 拍", 2 * 208080, 416160, 0, "2x208,080")
derived("像素固定拍", 6 * 3987, 23922, 0, "6x3,987")
derived("总拍", 2 * 208080 + 6 * 3987 + 5, 440087, 0, "2x208,080+6x3,987+5")
derived("8.80 ms", 440087 / 50e6 * 1000, 8.80174, 5e-5, "440,087/50 MHz")
derived("占空比", 440087 / 5000000 * 100, 8.80174, 5e-5, "440,087/5,000,000")
derived("K=6 时长", 827154 / 50e6 * 1000, 16.54308, 5e-5, "827,154/50 MHz")
derived("K=6 占比", 827154 / 30000000 * 100, 2.75718, 5e-5, "827,154/(50 MHz*600 ms)")

# ---- 3. 事件流会话 ----
line_check("v7 帧/事件", "nn/REPORT_v7_数据集.md", 5, ["6,831 帧 / 7,913,893 事件"], "6,831 / 7,913,893")
line_check("v7 meta 帧", "records/20261030-222201_v7hands/meta.json", 19, ["6831"], "6831")
line_check("v7 meta 事件", "records/20261030-222201_v7hands/meta.json", 20, ["7913893"], "7913893")
line_check("v7 meta 字节", "records/20261030-222201_v7hands/meta.json", 23, ["5246208000"], "5,246,208,000 B")
line_check("v7 容器时间比", "docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md", 23, ["0.889"], "0.889")
line_check("会话有效帧率", "docs/05_experiments/action_recognition_20261029/capture_log_v7hands_20261030.md", 53,
           ["26.671", "26.646", "26.616"], "26.671 / 26.646 / 26.616 fps")
derived("v7 事件率", 7913893 / 256.088, 30903.02, 0.02, "7,913,893/256.088 s")
derived("v5 事件率", 10312327 / 432.143, 23863.23, 0.02, "10,312,327/432.143 s")
derived("v7 CSV/原始", 244754716 / 5246208000, 0.04665, 5e-6, "244,754,716/5,246,208,000")
derived("v7 100 ms 桶均值", 7913893 / 2562, 3088.95, 0.02, "7,913,893/2,562 桶")

# ---- 4. 数据构成/留出指标 ----
line_check("v7 总行数", "nn/REPORT_v7_数据集.md", 41, ["14,447", "5,067 / 5,480 / 3,900"], "14,447 / 5067/5480/3900")
for ln, n in [(19, "299"), (20, "580"), (21, "620"), (22, "80"), (23, "440"),
              (24, "540"), (25, "400"), (27, "440"), (28, "470"), (29, "400"), (31, "320")]:
    line_check("v7 区间窗数 %s" % n, "nn/REPORT_v7_数据集.md", ln, ["| %s |" % n], n)
derived("v7 保留窗合计", 1560 + 1020 + 400 + 619 + 990, 4589, 0, "1560+1020+400+619+990")
derived("npz 行数", 5067 + 5480 + 3900, 14447, 0, "5067+5480+3900")
line_check("A_time fold1", "nn/out_v7/results_v7_final.json", 31, ["0.9042"], "0.9042")
line_check("A_time fold2", "nn/out_v7/results_v7_final.json", 2332, ["0.8754"], "0.8754")
json_check("A_time pooled 窗数", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "n_windows"], 7868, "json:4631")
json_check("A_time open 召回", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "open_recall"], 0.9412, "json:4637")
json_check("A_time open 折级", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "open_chunks"], "16/17", "json:4638")
json_check("A_time pool 无守卫", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "open_chunks_no_guard"], "17/17", "json:4655")
json_check("A_time 无守卫召回", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "open_recall_no_guard"], 1.0, "json:4656")
json_check("挥手段窗数", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "groups", "wave", "n_windows"], 1020, "json:4695")
json_check("挥手段决策窗", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "groups", "wave", "n_decisions"], 510, "json:4696")
json_check("挥手段 class1 命中", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "groups", "wave", "class1_hit"], 5, "json:4704")
json_check("挥手段窗级命中", "nn/out_v7/results_v7_final.json", ["A_time", "pooled", "8", "groups", "wave", "class1_hit_ratio"], 0.0098, "json:4705")
json_check("int8 一致率下限", "nn/out_v7/results_v7_final.json", ["A_time", "int8_agree_min"], 0.970775, "json:5605")
json_check("B 距离窗准确率", "nn/out_v7/results_v7_final.json", ["B_distance", "window_acc"], 0.916, "json:5624")
json_check("B 距离混淆 true0p0", "nn/out_v7/results_v7_final.json", ["B_distance", "confusion_win", "true0_pred0"], 376, "json:5626")
json_check("B 距离混淆 true1p1", "nn/out_v7/results_v7_final.json", ["B_distance", "confusion_win", "true1_pred1"], 485, "json:5629")
derived("折级召回", 16 / 17, 0.941176, 5e-7, "16/17")
derived("挥手窗级命中", 5 / 510, 0.009804, 5e-7, "5/510")

# ---- 5. 决策链/上位机 ----
line_check("决策一致率", "nn/REPORT_决策链标定.md", 8, ["0.994094"], "0.994094")
line_check("决策点", "nn/REPORT_决策链标定.md", 10, ["849", "1.415 min"], "849 / 1.415 min")
line_check("决策误触", "nn/REPORT_决策链标定.md", 11, ["27/27", "4.24"], "27/27 / 4.24 次分")
line_check("决策差距", "nn/REPORT_决策链标定.md", 12, ["3.74"], "3.74")
line_check("决策分辨率", "nn/REPORT_决策链标定.md", 42, ["0.71", "2.1", "~6 min"], "0.71 / 2.1 / 6 min")
derived("决策分辨率算术", 1 / 1.415, 0.7067, 1e-4, "1/1.415 min")
line_check("v5 总脉冲", "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", 67, ["118", "16.4"], "118 / 16.4 次分")
line_check("v5 最小间隔", "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", 87, ["1,687 ms"], "1,687 ms")
line_check("v5 挥手窗命中", "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", 129, ["0.652"], "0.652")
line_check("v5 开合块召回", "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", 135, ["24/24"], "24/24")
line_check("v5 挥手误触率", "docs/05_experiments/action_recognition_20261029/measure_v5_false_triggers_20261030.md", 143, ["29.68"], "29.68 次分")
line_check("v6 c3", "nn/REPORT_v6_表征实验.md", 56, ["0.0817", "24/24"], "0.0817 / 24/24")
line_check("v6 c5", "nn/REPORT_v6_表征实验.md", 59, ["0.0575", "24/24"], "0.0575 / 24/24")
line_check("v6 数据", "nn/REPORT_v6_表征实验.md", 112, ["5174 帧", "6,012,765 事件", "194.4 s"], "5174 / 6,012,765 / 194.4 s")
line_check("上位机 p50/p95", "docs/05_experiments/action_recognition_20261029/report.md", 231, ["85.612", "97.555"], "85.612 / 97.555 ms")
line_check("上位机全量回归", "docs/05_experiments/action_recognition_20261029/report.md", 368,
           ["638/638", "28 suites", "19719.2047"], "638/638 / 28 suites / 19719.2047 ms")
line_check("EVAL 延迟", "docs/05_experiments/action_recognition_20261029/EVIDENCE_EVAL.log", 51,
           ["p50=85.612", "p95=97.555"], "p50 / p95")
line_check("EVAL 未达标", "docs/05_experiments/action_recognition_20261029/EVIDENCE_EVAL.log", 53, ["13.913/min", "未达标"], "13.913/min")
line_check("契约 R3", "docs/03_tech/05_action_uplink_contract.md", 462, ["≤300 ms", "500 ms"], "≤300 ms / 500 ms")
derived("帧锁存粒度", 1000 / 26.671, 37.4939, 5e-4, "1000/26.671")

# ---- 5b. act7 构建实测 ----
line_check("act7 时序判据", "sim/nn/EVIDENCE_M3f.md", 15,
           ["WNS +0.059", "WHS +0.027", "THS 0.000"], "WNS +0.059 / WHS +0.027")
line_check("act7 时序总表", "sim/nn/EVIDENCE_M3f.md", 57,
           ["0.059", "84,405", "0.027", "84,382"], "0.059 / 84,405 / 0.027 / 84,382")
line_check("act7 LUT", "sim/nn/EVIDENCE_M3f.md", 108, ["22,371", "35.29%", "+1,812"], "22,371 / 35.29%")
line_check("act7 FF", "sim/nn/EVIDENCE_M3f.md", 111, ["14,325", "11.30%", "+2,475"], "14,325 / 11.30%")
line_check("act7 Slice", "sim/nn/EVIDENCE_M3f.md", 112, ["7,968", "50.27%", "+641"], "7,968 / 50.27%")
line_check("act7 BRAM", "sim/nn/EVIDENCE_M3f.md", 113, ["87", "64.44%"], "87 / 64.44%")
line_check("act7 DSP", "sim/nn/EVIDENCE_M3f.md", 116, ["8", "3.33%", "+1"], "8 / 3.33%")
line_check("act7 IOB", "sim/nn/EVIDENCE_M3f.md", 117, ["140", "49.12%"], "140 / 49.12%")
line_check("act7 位流字节", "sim/nn/EVIDENCE_M3f.md", 128, ["2,835,423"], "2,835,423 B")
line_check("act7 位流 md5", "sim/nn/EVIDENCE_M3f.md", 129,
           ["9c13668c029c9d3a248cf69cbec03582"], "9c13668c...3582")
line_check("act7 构建耗时", "sim/nn/EVIDENCE_M3f.md", 42, ["10 分 06 秒"], "10 分 06 秒")
line_check("act3c 位流与 md5", "docs/06_facts/00_current_status.md", 28,
           ["2,890,875", "a5fff751e20019d7e80a3a953f7f8c5a"], "2,890,875 B / a5fff751...")
line_check("act7 登记册", "docs/06_facts/02_metric_register.md", 19,
           ["2,835,423", "9c13668c029c9d3a248cf69cbec03582", "未烧板"], "2,835,423 / 未烧板")
line_check("act7 口径 R9", "docs/06_facts/02_metric_register.md", 35,
           ["+0.059", "+0.027", "84,405"], "R9 +0.059 / +0.027 / 84,405")
line_check("act7 口径 R10", "docs/06_facts/02_metric_register.md", 36,
           ["22,371", "14,325", "7,968", "87", "8", "140"], "R10 六项资源")
line_check("act3c 时序", "build/variant_act3c/timing_deliver.rpt", 131,
           ["0.306", "0.036", "76854"], "0.306 / 0.036 / 76854")
line_check("act3c LUT", "build/variant_act3c/inproc_util_impl.rpt", 34, ["20559", "32.43"], "20,559 / 32.43%")
line_check("act3c FF", "build/variant_act3c/inproc_util_impl.rpt", 39, ["11850", "9.35"], "11,850 / 9.35%")
line_check("act3c Slice", "build/variant_act3c/inproc_util_impl.rpt", 72, ["7327", "46.23"], "7,327 / 46.23%")
line_check("act3c BRAM", "build/variant_act3c/inproc_util_impl.rpt", 104, ["87", "64.44"], "87 / 64.44%")
line_check("act3c DSP", "build/variant_act3c/inproc_util_impl.rpt", 119, ["7", "2.92"], "7 / 2.92%")
line_check("act3c IOB", "build/variant_act3c/inproc_util_impl.rpt", 130, ["140", "49.12"], "140 / 49.12%")
derived("act7 时序下降量", 0.306 - 0.059, 0.247, 5e-4, "0.306-0.059")
derived("act7 余量占周期", 0.059 / 8.0, 0.007375, 5e-6, "0.059/8")
derived("act7 位流差", 2890875 - 2835423, 55452, 0.5, "2,890,875-2,835,423")

# ---- 5c. v7b 部署裁决与门限扫描 ----
line_check("v7b 判据记 0", "docs/06_facts/03_v7b_deployment_decision.md", 8,
           ["V7B_MODEL_OK", "0"], "V7B_MODEL_OK=0")
line_check("v7b 部署参数", "docs/06_facts/03_v7b_deployment_decision.md", 10,
           ["MARGIN_MIN = 16", "N_CONSEC = 3", "1.5 s", "100 ms"], "16 / 3 / 1.5 s / 100 ms")
line_check("v7b 开合", "docs/06_facts/03_v7b_deployment_decision.md", 18, ["17/17", "通过"], "17/17")
line_check("v7b 挥手", "docs/06_facts/03_v7b_deployment_decision.md", 19, ["1", "通过"], "1")
line_check("v7b 静止", "docs/06_facts/03_v7b_deployment_decision.md", 20, ["0 次每分", "通过"], "0")
line_check("v7b 空桌面", "docs/06_facts/03_v7b_deployment_decision.md", 21, ["0", "通过"], "0")
line_check("v7b 硬负未通过", "docs/06_facts/03_v7b_deployment_decision.md", 22,
           ["2（卷纸 1、打字 1）", "未通过"], "2 / 未通过")
line_check("v7b 镜像未通过", "docs/06_facts/03_v7b_deployment_decision.md", 23,
           ["0.0196", "未通过"], "0.0196 / 未通过")
line_check("v7 到 v7b 挥手", "docs/06_facts/03_v7b_deployment_decision.md", 34,
           ["5", "1", "减少 4"], "5→1")
line_check("v7 到 v7b 硬负", "docs/06_facts/03_v7b_deployment_decision.md", 35,
           ["5", "2", "减少 3"], "5→2")
line_check("v7b 硬负折算", "docs/06_facts/03_v7b_deployment_decision.md", 43,
           ["46.5 s", "2.6"], "2.6 次每分")
line_check("v7b 镜像退化", "docs/06_facts/03_v7b_deployment_decision.md", 44,
           ["0.0078", "0.0196"], "0.0078→0.0196")
derived("v7b 硬负折算算术", 2.0 / 46.5 * 60.0, 2.5806, 1e-3, "2/46.5s")
line_check("sweep 8/3 边距", "nn/out_v7b/s100_threshold_sweep.json", 3, ['"margin": 8'], "8")
line_check("sweep 8/3 硬负", "nn/out_v7b/s100_threshold_sweep.json", 9, ['"hardneg": 3'], "3")
line_check("sweep 8/3 总 pulse", "nn/out_v7b/s100_threshold_sweep.json", 12, ['"pulses": 88'], "88")
line_check("sweep 16/3 边距", "nn/out_v7b/s100_threshold_sweep.json", 75, ['"margin": 16'], "16")
line_check("sweep 16/3 开合", "nn/out_v7b/s100_threshold_sweep.json", 77, ['"open": "17/17"'], "17/17")
line_check("sweep 16/3 硬负", "nn/out_v7b/s100_threshold_sweep.json", 81, ['"hardneg": 2'], "2")
line_check("sweep 16/3 总 pulse", "nn/out_v7b/s100_threshold_sweep.json", 84, ['"pulses": 74'], "74")
line_check("sweep 24/4 边距", "nn/out_v7b/s100_threshold_sweep.json", 123, ['"margin": 24'], "24")
line_check("sweep 24/4 开合", "nn/out_v7b/s100_threshold_sweep.json", 125, ['"open": "14/17"'], "14/17")
line_check("sweep 24/4 硬负", "nn/out_v7b/s100_threshold_sweep.json", 129, ['"hardneg": 1'], "1")
line_check("sweep 24/4 总 pulse", "nn/out_v7b/s100_threshold_sweep.json", 132, ['"pulses": 32'], "32")
derived("16/3 相对 8/3 pulse 降幅", 88 - 74, 14, 0.5, "88-74")
derived("16/3 硬负降幅", 3 - 2, 1, 0.5, "3-2")

# ---- 5d. s100 口径与 v7b 重训 ----
line_check("s100 口径表", "nn/REPORT_s100_部署口径复核.md", 16,
           ["100 ms / 50 ms", "100 ms / 100 ms"], "s50 100/50 ms；s100 100/100 ms")
line_check("s100 窗数", "nn/REPORT_s100_部署口径复核.md", 17, ["5120", "2560"], "5120 -> 2560")
line_check("s100 pooled", "nn/REPORT_s100_部署口径复核.md", 76,
           ["3935", "17/17", "42", "5", "0", "0", "5", "97"], "3935 窗 / 17/17 / 5 / 5 / 97")
line_check("v7b 挥手", "nn/REPORT_v7b_部署口径重训.md", 212, ["1", "5", "1"], "1 -> 5 -> 1")
line_check("v7b 硬负", "nn/REPORT_v7b_部署口径重训.md", 213, ["3", "5", "2"], "3 -> 5 -> 2")
line_check("v7b 总 pulse", "nn/REPORT_v7b_部署口径重训.md", 216, ["67", "97", "74"], "67 -> 97 -> 74")
line_check("act7 余量差", "sim/nn/EVIDENCE_M3f.md", 20,
           ["+0.306", "247 ps"], "比 act3c 少 247 ps")
line_check("act7 端点数", "sim/nn/EVIDENCE_M3f.md", 102,
           ["+7,551"], "端点 +7,551")
line_check("act8 已烧板待验收", "docs/06_facts/02_metric_register.md", 20,
           ["2026-10-31 02:02", "未做板级动作验收"], "act8 已烧板，动作验收待 A1~A4")
line_check("M5 四段协议", "docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md", 17,
           ["5 轮 × 210 s", "A1", "A2", "A3", "A4"], "5x210 s / A1-A4")
line_check("M5 5 轮合计门槛", "docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md", 21,
           ["TP≥85", "false≤5", "false/min<1"], "TP>=85 / false<=5 / <1 次每分")
line_check("M5 单轮召回门槛", "docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md", 55,
           ["每轮 ≥0.85", "TP≥17/20", "TP≥85/100"], "0.85 / 17/20 / 85/100")
line_check("M5 A3 判据", "docs/05_experiments/action_recognition_20261029/m5_board_acceptance_v2_20261030.md", 125,
           ["TP 17–20", "false ≤1"], "TP>=17 / false<=1")
derived("s100 窗数减半", 5120 - 2560, 2560, 0, "5120-2560")
derived("s100 评估行减半差", 7868 - 3935, 3933, 0, "7868-3935")
derived("v7b 对 v7 s100 总 pulse 降幅", 97 - 74, 23, 0, "97-74")
derived("v7b 对 v7 s100 硬负降幅", 5 - 2, 3, 0, "5-2")
derived("v7b 对 v7 s100 挥手降幅", 5 - 1, 4, 0, "5-1")
derived("act7 端点增量", 84405 - 76854, 7551, 0, "84,405-76,854")

# ---- 5f act8 构建与 v7b 汇总 ----
_ACT8 = "report/evidence/act8_artifacts.txt"
_ACT8_T = "build/variant_act8_final/timing.rpt"
_ACT8_U = "build/variant_act8_final/util.rpt"
line_check("act8 位流字节", _ACT8, 4, ["2839107"], "2,839,107 B")
line_check("act8 位流 md5", _ACT8, 5, ["5ec55ec07c44f2503df63f1bb160a6e6"], "md5")
line_check("act8 载荷 md5", "build/variant_act8_final/md5.txt", 11, ["dcbcf543210c33cb22625128bc5f6b97"], "载荷 md5")
line_check("act8 WNS/WHS", _ACT8, 7, ["0.215"], "+0.215 ns")
line_check("act8 资源 LUT", _ACT8, 14, ["22383 35.30"], "22,383 / 35.30%")
line_check("act8 资源 FF", _ACT8, 15, ["14325 11.30"], "14,325 / 11.30%")
line_check("act8 资源 Slice", _ACT8, 16, ["8026 50.64"], "8,026 / 50.64%")
line_check("act8 资源 BRAM/DSP/IOB", _ACT8, 17, ["86.5 64.07"], "86.5 / 64.07%")
line_check("act8 timing.rpt 行", _ACT8_T, 131, ["0.215", "84390", "0.017", "84367"], "0.215 / 84,390 / 0.017")
line_check("act8 util LUT 行", _ACT8_U, 34, ["22383", "35.30"], "22383 35.30")
line_check("act8 util Slice 行", _ACT8_U, 72, ["8026", "50.64"], "8026 50.64")
line_check("act8 util BRAM 行", _ACT8_U, 104, ["86.5", "64.07"], "86.5 64.07")
line_check("act8 CHOSEN", "build/variant_act8_final/CHOSEN.txt", 3,
           ["+0.215", "+0.188"], "Explore > Default")
line_check("v7b 开合块 17/18→17/17", "nn/REPORT_v7b_部署口径重训.md", 210,
           ["| open 块 | 17/18 | 17/17 | 17/17 |"], "17/18 -> 17/17")
line_check("v7b open pulse", "nn/REPORT_v7b_部署口径重训.md", 211, ["34", "42", "42"], "34 -> 42")
line_check("v7b int8 一致率", "nn/REPORT_v7b_部署口径重训.md", 245, ["0.9352", "0.9299"], "0.9299")
derived("act8 相对 act7 WNS 增量", 0.215 - 0.059, 0.156, 1e-9, "0.215-0.059")
derived("act8 相对 act7 WHS 差", 0.017 - 0.027, -0.010, 1e-9, "0.017-0.027")
derived("act8 相对 act7 LUT 增量", 22383 - 22371, 12, 0, "22383-22371")
derived("act8 相对 act7 Slice 增量", 8026 - 7968, 58, 0, "8026-7968")
derived("act8 相对 act7 位流差", 2839107 - 2835423, 3684, 0, "2,839,107-2,835,423")
derived("act8 相对 act7 端点差", 84390 - 84405, -15, 0, "84,390-84,405")
derived("act8 WNS 占 8 ns 百分比", 0.215 / 8 * 100, 2.6875, 1e-6, "0.215/8")

# ---- 6. 图表 CSV/SVG 完整性 ----
csv_path = ROOT / "report/figures/figure_data_table.csv"
if not csv_path.exists():
    fail("missing report/figures/figure_data_table.csv")
else:
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    CHECKS += 1
    if rows[0] != ["figure", "metric", "value", "expected", "source_path:line", "equal"]:
        fail("figure_data_table.csv header=%r" % (rows[0],))
    else:
        TABLES += 1
        print("TABLE OK header")
    body = rows[1:]
    if len(body) != 182:
        fail("figure_data_table.csv rows=%d expected=182" % len(body))
    else:
        TABLES += 1
        print("TABLE OK rows=182")
    bad_eq = [r for r in body if len(r) < 6 or r[5] != "YES"]
    bad_src = [r for r in body if len(r) < 6 or not re.search(r":\d", r[4])]
    if bad_eq:
        fail("figure_data_table.csv non-YES rows=%d" % len(bad_eq))
    if bad_src:
        fail("figure_data_table.csv source-without-line rows=%d" % len(bad_src))
    figs = sorted({r[0] for r in body if r}, key=lambda s: int(s[1:]))
    if figs != ["f%d" % i for i in range(1, 13)]:
        fail("figure_data_table.csv figures=%r" % figs)
    else:
        TABLES += 1
        print("TABLE OK figures=%s" % ",".join(figs))
    row_map = {(r[0], r[1]): r for r in body if len(r) >= 6}
    for fig, metric, value in [("f4", "act8 Slice 占比", "50.64%"),
                               ("f5", "act8 WNS", "+0.215 ns")]:
        CHECKS += 1
        row = row_map.get((fig, metric))
        if not row or row[2] != value:
            fail("figure_data_table.csv %s %s=%r expected=%r" % (fig, metric, row[2] if row else None, value))
        else:
            print("TABLE OK %s %s=%s" % (fig, metric, value))

EXPECTED_SVGS = ["f1_system_arch.svg", "f2_data_volume.svg", "f3_event_pipeline.svg",
                 "f4_resources.svg", "f5_timing.svg", "f6_cycle_budget.svg",
                 "f7_heldout_rates.svg", "f8_iteration.svg", "f9_data_composition.svg",
                 "f10_latency.svg", "f11_threshold_sweep.svg", "f12_act7_vs_act3c.svg"]
svgs = sorted((ROOT / "report/figures").glob("f*.svg"), key=lambda p: int(re.search(r"f(\d+)", p.name).group(1)))
CHECKS += 1
names = [p.name for p in svgs]
if names != EXPECTED_SVGS:
    fail("SVG names=%r expected=%r" % (names, EXPECTED_SVGS))
else:
    SVGS = len(svgs)
    print("SVG OK count=%d names=lowercase" % len(svgs))
for p in svgs:
    CHECKS += 1
    try:
        ET.parse(str(p))
    except Exception as exc:
        fail("SVG parse %s -> %s" % (p.name, exc))
    if "数据来源" not in p.read_text(encoding="utf-8"):
        fail("SVG missing 数据来源: %s" % p.name)

f4_txt = (ROOT / "report/figures/f4_resources.svg").read_text(encoding="utf-8")
for token in ["32.43%", "9.35%", "46.23%", "64.44%", "2.92%", "49.12%",
              "35.30%", "11.30%", "50.64%", "64.07%", "3.33%"]:
    CHECKS += 1
    if token not in f4_txt:
        fail("f4_resources.svg missing %s" % token)
    else:
        print("SVG OK f4 %s" % token)
f5_txt = (ROOT / "report/figures/f5_timing.svg").read_text(encoding="utf-8")
for token in ["−7.001 ns", "+8.827 ns", "−0.175 ns", "+0.306 ns", "+0.059 ns", "+0.215 ns"]:
    CHECKS += 1
    if token not in f5_txt:
        fail("f5_timing.svg missing %s" % token)
    else:
        print("SVG OK f5 %s" % token)

print("checks=%d line_refs=%d derived=%d table_checks=%d svgs=%d fails=%d"
      % (CHECKS, LINES, DERIVED, TABLES, SVGS, len(FAILS)))
if FAILS:
    print("NUMBERS_VERIFY_FAIL=%d" % len(FAILS))
    sys.exit(1)
print("NUMBERS_VERIFIED=1")
