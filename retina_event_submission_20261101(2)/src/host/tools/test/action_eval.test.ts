// tools/action_eval.mjs 的单元测试（node:test，无第三方依赖）
//
// 覆盖 task-16 的 6 个强制场景：
//  1) 真值标注窗口匹配（窗口内第一个判定）；
//  2) 超时未判定 → 漏检；
//  3) 同一窗口多次判定只计一次（第二次计重复）；
//  4) 无动作区间判定 → 误触发计数；
//  5) 置信度分档统计；
//  6) CSV / summary JSON 字段完整。
// 另覆盖参数解析、script 解析、动作字节边界，防止 CLI 入口回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MOD_URL = new URL("../action_eval.mjs", import.meta.url).href;

type Truth = { tMs: number; class: number; className?: string };
type Pred = {
  seq?: number;
  tMs: number;
  recvMs?: number;
  recvEpochMs?: number;
  class: number;
  className?: string;
  conf?: number;
  raw?: number;
  frameIdx?: number;
  valid?: boolean;
};
type Analysis = { summary: any; rows: any[] };
type EvalMod = {
  VERSION: number;
  CSV_HEADER: string;
  CSV_NAME: string;
  JSON_NAME: string;
  CLASS_NAMES: readonly string[];
  parseEvalArgs: (argv: string[]) => any;
  parseScript: (text: string, sourceName?: string) => any[];
  parseClassValue: (raw: unknown) => number;
  makeActionByte: (cls: number, conf: number, valid?: boolean) => number;
  analyze: (truths: Truth[], preds: Pred[], options?: any) => Analysis;
  evaluate: (truths: Truth[], preds: Pred[], options?: any) => any;
  buildEvalCsv: (rows: any[]) => string;
  writeEvalOutputs: (analysis: Analysis, outDir: string, meta?: any) => any;
  formatSummary: (summary: any) => string;
  latencyStats: (values: number[]) => any;
};
let mod: EvalMod;

test("载入被测模块（动态 import，规避 TS 对 .mjs 的类型解析）", async () => {
  mod = (await import(MOD_URL)) as EvalMod;
  assert.equal(mod.VERSION, 1);
  assert.equal(mod.CSV_HEADER, "t_ms,kind,class,className,conf,matched");
  assert.equal(mod.CLASS_NAMES[1], "手部开合");
  assert.equal(mod.CLASS_NAMES[2], "横向挥手");
});

test("参数解析：默认值、E2E 端口约束、--help 与非法值", () => {
  const base = mod.parseEvalArgs([]);
  assert.equal(base.mode, "interactive");
  assert.equal(base.api, "http://127.0.0.1:8787");
  assert.equal(base.windowMs, 3000);
  assert.equal(base.udpPort, 12400);
  assert.equal(base.wsPort, 8900);

  const script = mod.parseEvalArgs(["--script", "truth.json", "--out", "/tmp/x", "--window-ms", "1500"]);
  assert.equal(script.mode, "script");
  assert.equal(script.windowMs, 1500);
  assert.equal(script.out, "/tmp/x");

  const e2e = mod.parseEvalArgs(["--e2e", "--udp-port", "12500", "--ws-port", "8901", "--out", "/tmp/e2e"]);
  assert.equal(e2e.mode, "e2e");
  assert.equal(e2e.udpPort, 12500);
  assert.equal(e2e.wsPort, 8901);

  assert.throws(() => mod.parseEvalArgs(["--e2e", "--udp-port", "1234"]), /12400|1234/);
  assert.throws(() => mod.parseEvalArgs(["--e2e", "--udp-port", "12401", "--ws-port", "8787"]), /8800|8787/);
  assert.throws(() => mod.parseEvalArgs(["--e2e", "--udp-port", "12400", "--ws-port", "8799"]), /8800/);
  assert.throws(() => mod.parseEvalArgs(["--e2e", "--bind", "192.168.1.1"]), /127\.0\.0\.1/);
  assert.throws(() => mod.parseEvalArgs(["--unknown"]), /未知参数/);
  assert.throws(() => mod.parseEvalArgs(["--window-ms", "0"]), /范围/);
  assert.throws(() => mod.parseEvalArgs(["--api", "ftp://x"]), /http/);
  assert.equal(mod.parseEvalArgs(["--help"]).help, true);
});

test("script 解析：对象/数组别名、排序、空/坏 JSON/保留类拒绝", () => {
  const rows = mod.parseScript(JSON.stringify({
    timeline: [
      { tMs: 500, class: "2" },
      { atMs: 100, cls: 1 },
      { tMs: 0, class: "无动作" },
    ],
  }), "truth.json");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tMs), [0, 100, 500]);
  assert.deepEqual(rows.map((r) => r.class), [0, 1, 2]);
  assert.equal(rows[1].className, "手部开合");

  const arrays = mod.parseScript(JSON.stringify([[300, "wave"], [100, "hand"]]));
  assert.deepEqual(arrays.map((r) => r.class), [1, 2]);

  assert.throws(() => mod.parseScript("[]"), /为空/);
  assert.throws(() => mod.parseScript("{bad"), /JSON/);
  assert.throws(() => mod.parseScript('[{"tMs":1,"class":3}]'), /保留类/);
  assert.throws(() => mod.parseScript('[{"tMs":-1,"class":1}]'), /tMs/);
  assert.throws(() => mod.parseScript('[{"tMs":1.5,"class":1}]'), /tMs/);
  assert.throws(() => mod.parseScript('[{"tMs":1,"class":"unknown"}]'), /类别/);
});

test("窗口匹配 + 重复 + 误触发：每个真值窗口只消费第一条判定", () => {
  const truths: Truth[] = [
    { tMs: 1000, class: 1 },
    { tMs: 5000, class: 2 },
  ];
  const preds: Pred[] = [
    { seq: 1, tMs: 1100, recvMs: 1100, class: 1, conf: 10 },
    { seq: 2, tMs: 1500, recvMs: 1500, class: 1, conf: 9 },  // 同窗口第二条 → 重复
    { seq: 3, tMs: 2500, recvMs: 2500, class: 2, conf: 8 },  // 同窗口第三条 → 重复
    { seq: 4, tMs: 4501, recvMs: 4501, class: 2, conf: 7 },  // 第二窗口已过 +1ms → 误触发
    { seq: 5, tMs: 9000, recvMs: 9000, class: 2, conf: 6 },  // 完全无真值窗口 → 误触发
  ];
  const { summary, rows } = mod.analyze(truths, preds, { windowMs: 3000, durationMs: 10000 });
  assert.equal(summary.windowMs, 3000);
  assert.equal(summary.totalTruthActions, 2);
  assert.equal(summary.matched, 1);
  assert.equal(summary.duplicates, 2);
  assert.equal(summary.falseTriggers, 2);
  assert.equal(summary.missed, 1);
  assert.equal(summary.correct, 1);
  assert.equal(summary.wrong, 0);
  assert.equal(summary.confusionMatrix.rows["1"]["1"], 1);
  assert.equal(summary.confusionMatrix.rows["2"].miss, 1);
  assert.equal(rows.length, 7);
  assert.equal(rows.filter((r) => r.matched).length, 2); // truth1 + pred1
});

test("超时未判定算漏检（窗口外判定不能救回）", () => {
  const truths: Truth[] = [{ tMs: 1000, class: 1 }];
  const preds: Pred[] = [{ seq: 1, tMs: 4001, recvMs: 4001, class: 1, conf: 8 }];
  const s = mod.evaluate(truths, preds, { windowMs: 3000, durationMs: 5000 });
  assert.equal(s.matched, 0);
  assert.equal(s.missed, 1);
  assert.equal(s.falseTriggers, 1);
  assert.equal(s.accuracy, 0);
  assert.equal(s.confusionMatrix.rows["1"].miss, 1);
});

test("无动作区间误触发：同一窗口内的多余判定不重复计误触发", () => {
  const truths: Truth[] = [{ tMs: 1000, class: 2 }];
  const preds: Pred[] = [
    { seq: 1, tMs: 1001, recvMs: 1001, class: 2, conf: 20 },
    { seq: 2, tMs: 1200, recvMs: 1200, class: 1, conf: 20 }, // 窗口内重复，不算误触发
    { seq: 3, tMs: 2000, recvMs: 2000, class: 1, conf: 20 }, // 窗口内重复
    { seq: 4, tMs: 5000, recvMs: 5000, class: 2, conf: 20 }, // 无窗口 → 误触发
  ];
  const s = mod.evaluate(truths, preds, { windowMs: 3000, durationMs: 6000 });
  assert.equal(s.matched, 1);
  assert.equal(s.duplicates, 2);
  assert.equal(s.falseTriggers, 1);
  assert.equal(s.falseTriggersPerMin, 10); // 1 * 60000 / 6000
  assert.equal(s.perClass["2"].tp, 1);
  assert.equal(s.perClass["2"].fp, 1);
});

test("各类 P/R/F1 与置信度分档：错分同时记 FN/FP", () => {
  const truths: Truth[] = [
    { tMs: 100, class: 1 },
    { tMs: 2000, class: 1 },
    { tMs: 3000, class: 2 },
  ];
  const preds: Pred[] = [
    { seq: 1, tMs: 150, recvMs: 150, class: 1, conf: 5 },   // truth1 正确
    { seq: 2, tMs: 2050, recvMs: 2050, class: 2, conf: 12 }, // truth2 错分
    { seq: 3, tMs: 3050, recvMs: 3050, class: 2, conf: 20 }, // truth3 正确
    { seq: 4, tMs: 7000, recvMs: 7000, class: 1, conf: 28 }, // 所有真值窗口之外 → 误触发
  ];
  const s = mod.evaluate(truths, preds, { windowMs: 3000, durationMs: 8000 });
  assert.equal(s.correct, 2);
  assert.equal(s.wrong, 1);
  assert.equal(s.falseTriggers, 1);
  assert.equal(s.accuracy, 0.5); // 2 / (3 + 1)
  assert.equal(s.balancedAccuracy, 0.75); // (0.5 + 1.0) / 2
  assert.equal(s.perClass["1"].support, 2);
  assert.equal(s.perClass["1"].tp, 1);
  assert.equal(s.perClass["1"].fp, 1); // 仅 5000ms 的 class1 误触发；错分 pred 归 class2 的 FP
  assert.equal(s.perClass["1"].fn, 1);
  assert.equal(s.perClass["2"].tp, 1);
  assert.equal(s.perClass["2"].fp, 1); // truth2 被预测成 class2
  assert.equal(s.perClass["2"].fn, 0);
  assert.equal(s.perClass["2"].precision, 0.5);
  assert.equal(s.perClass["2"].recall, 1);
  assert.equal(s.perClass["2"].f1, 0.6667);

  const buckets: any[] = s.confidenceBuckets;
  const b0 = buckets.find((b) => b.label === "0-7");
  const b8 = buckets.find((b) => b.label === "8-15");
  const b16 = buckets.find((b) => b.label === "16-23");
  const b24 = buckets.find((b) => b.label === "24-31");
  assert.deepEqual([b0.total, b0.correct, b0.wrong, b0.falseTrigger], [1, 1, 0, 0]);
  assert.deepEqual([b8.total, b8.correct, b8.wrong, b8.falseTrigger], [1, 0, 1, 0]);
  assert.deepEqual([b16.total, b16.correct, b16.wrong, b16.falseTrigger], [1, 1, 0, 0]);
  assert.deepEqual([b24.total, b24.correct, b24.wrong, b24.falseTrigger], [1, 0, 0, 1]);
});

test("CSV 字段完整：6 列、truth conf 留空、matched 布尔可读", () => {
  const truths: Truth[] = [{ tMs: 1000, class: 1 }, { tMs: 3000, class: 2 }];
  const preds: Pred[] = [
    { seq: 1, tMs: 1100, recvMs: 1100, class: 1, conf: 8 },
    { seq: 2, tMs: 5000, recvMs: 5000, class: 2, conf: 31 },
  ];
  const a = mod.analyze(truths, preds, { windowMs: 3000, durationMs: 6000 });
  const csv = mod.buildEvalCsv(a.rows);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "t_ms,kind,class,className,conf,matched");
  assert.equal(lines.length, 5);
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    assert.equal(cols.length, 6);
    assert.ok(cols[0] !== "");
    assert.ok(cols[1] === "truth" || cols[1] === "pred");
    assert.ok(cols[2] === "1" || cols[2] === "2" || cols[2] === "3" || cols[2] === "0");
    const confCol = cols[4] ?? "";
    assert.ok(confCol === "" || /^\d+$/.test(confCol));
    assert.ok(cols[5] === "true" || cols[5] === "false");
  }
  const truthLine = lines.find((l) => l.includes(",truth,"));
  assert.ok(truthLine !== undefined);
  assert.equal(truthLine.split(",")[4], "");
});

test("summary JSON 落盘字段完整，formatSummary 含混淆矩阵", () => {
  const truths: Truth[] = [{ tMs: 1000, class: 1 }];
  const preds: Pred[] = [{ seq: 1, tMs: 1100, recvMs: 1100, class: 1, conf: 9 }];
  const a = mod.analyze(truths, preds, { windowMs: 3000, durationMs: 4000, mode: "test" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-eval-"));
  try {
    const out = mod.writeEvalOutputs(a, dir, { mode: "test", api: "http://127.0.0.1:1" });
    assert.equal(out.csvPath, path.join(dir, "action_eval.csv"));
    assert.equal(out.jsonPath, path.join(dir, "action_eval_summary.json"));
    const json = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));
    for (const key of [
      "mode", "durationMs", "totalTruthActions", "totalPredictions", "matched", "missed",
      "falseTriggers", "accuracy", "balancedAccuracy", "falseTriggersPerMin",
      "confusionMatrix", "perClass", "latencyMs", "confidenceBuckets", "m5Acceptance",
    ]) assert.ok(key in json, "summary JSON 缺字段 " + key);
    assert.equal(json.mode, "test");
    assert.equal(json.tool, "action_eval");
    assert.equal(json.version, 1);
    assert.equal(json.m5Acceptance.actionCount, 1);
    assert.equal(json.m5Acceptance.pass, false);
    const text = mod.formatSummary(json);
    assert.match(text, /混淆矩阵/);
    assert.match(text, /accuracy=100\.0%/);
    assert.match(text, /M5 门槛/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("动作字节边界：VALID/CONF/CLASS 位域与非法值", () => {
  assert.equal(mod.makeActionByte(0, 0, false), 0x00);
  assert.equal(mod.makeActionByte(1, 8, true), 0xa1);
  assert.equal(mod.makeActionByte(2, 31, true), 0xfe);
  assert.equal(mod.makeActionByte(3, 0, true), 0x83);
  assert.throws(() => mod.makeActionByte(4, 0), /class/);
  assert.throws(() => mod.makeActionByte(1, 32), /conf/);
  assert.throws(() => mod.makeActionByte(-1, 0), /class/);
  assert.equal(mod.parseClassValue("手部开合"), 1);
  assert.equal(mod.parseClassValue("横向挥手"), 2);
  assert.equal(mod.parseClassValue("0"), 0);
  assert.throws(() => mod.parseClassValue("4"), /类别/);
});

test("延迟统计：空列表、分位数与舍入", () => {
  const empty = mod.latencyStats([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p95Ms, null);
  const s = mod.latencyStats([10, 20, 30, 40, 50]);
  assert.equal(s.count, 5);
  assert.equal(s.minMs, 10);
  assert.equal(s.meanMs, 30);
  assert.equal(s.p50Ms, 30);
  assert.equal(s.p95Ms, 50);
  assert.equal(s.maxMs, 50);
});


test("检测次数接 /api/action count：Δ 与事件条数一致；旧网关缺 count 时回落事件数", () => {
  const truths: Truth[] = [{ tMs: 1000, class: 1 }];
  const preds: Pred[] = [
    { seq: 1, tMs: 1100, recvMs: 1100, class: 1, conf: 8 },
    { seq: 2, tMs: 1400, recvMs: 1400, class: 0, conf: 8 }, // class0 事件也占一次检测
  ];
  const s = mod.evaluate(truths, preds, {
    windowMs: 3000,
    durationMs: 5000,
    gatewayCountStart: 7,
    gatewayCountEnd: 9,
    gatewayCount: 2,
  });
  assert.equal(s.eventCount, 2);
  assert.equal(s.totalPredictions, 1, "class0 不计入判定统计（既有口径不变）");
  assert.equal(s.detectionCount, 2, "检测次数用网关 count 增量");
  assert.equal(s.gatewayCountStart, 7);
  assert.equal(s.gatewayCountEnd, 9);
  assert.equal(s.countMatchesEvents, true);
  assert.match(mod.formatSummary(s), /检测次数 count=2（事件 2 条）/);

  const legacy = mod.evaluate(truths, preds, { windowMs: 3000, durationMs: 5000 });
  assert.equal(legacy.detectionCount, 2, "读不到 count 时回落到长轮询事件条数");
  assert.equal(legacy.gatewayCountStart, null);
  assert.equal(legacy.countMatchesEvents, null);
});
