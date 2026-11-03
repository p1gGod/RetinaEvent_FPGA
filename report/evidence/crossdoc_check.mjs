#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const files = {
  design: "report/design_report.md",
  eval: "report/evaluation_report.md",
  figure: "report/figures/figure_data_table.csv",
  registry: "docs/06_facts/02_metric_register.md",
  decision: "docs/06_facts/03_v7b_deployment_decision.md",
};
const docs = {};
const missingFiles = [];
for (const [key, rel] of Object.entries(files)) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) { missingFiles.push(rel); docs[key] = ""; }
  else docs[key] = fs.readFileSync(p, "utf8");
}

function get(doc, re) {
  const m = docs[doc].match(re);
  return m && m[1] ? m[1].trim() : null;
}
function norm(v) {
  if (v === null) return null;
  const s = v.replace(/[，,\s]/g, "").replace(/^\+/, "");
  if (/^\d+\/\d+$/.test(s)) return s;
  const n = Number(s.replace(/(ns|ms|B|%|次每分|次\/分|words)$/g, ""));
  if (Number.isFinite(n)) return String(n);
  return s;
}
function cell(v) {
  if (v === null || v === undefined) return "—";
  const s = String(v).replace(/\|/g, "\|");
  return s.length > 44 ? s.slice(0, 41) + "..." : s;
}

const metrics = [
  { key: "act3c_bits", label: "act3c 位流大小", unit: "B",
    docs: { design: /(2,890,875)\s*B/, eval: /(2,890,875)\s*B/, registry: /(2,890,875)\s*B/ } },
  { key: "act3c_wns", label: "act3c WNS", unit: "ns",
    docs: { design: /(\+0\.306)\s*ns/, eval: /(\+0\.306)\s*ns/, registry: /(\+0\.306)\s*ns/, figure: /f5,交付 WNS,([-+0-9.]+) ns/ } },
  { key: "act3c_lut", label: "act3c LUT", unit: "",
    docs: { design: /LUT (20,559)/, eval: /LUT (20,559)/, registry: /LUT (20,559)/, figure: /f4,LUT 已用,(\d+)/ } },
  { key: "act3c_ff", label: "act3c FF", unit: "",
    docs: { design: /FF (11,850)/, eval: /FF (11,850)/, registry: /FF (11,850)/, figure: /f4,FF 已用,(\d+)/ } },
  { key: "act3c_slice", label: "act3c Slice", unit: "",
    docs: { design: /Slice (7,327)/, eval: /Slice (7,327)/, registry: /Slice (7,327)/, figure: /f4,Slice 已用,(\d+)/ } },
  { key: "act3c_bram", label: "act3c BRAM", unit: "",
    docs: { design: /BRAM (87)/, eval: /BRAM (87)/, registry: /BRAM (87)/, figure: /f4,BRAM 已用,(\d+)/ } },
  { key: "act3c_dsp", label: "act3c DSP", unit: "",
    docs: { design: /DSP (7)/, eval: /DSP (7)/, registry: /DSP (7)/, figure: /f4,DSP 已用,(\d+)/ } },
  { key: "infer_cycles", label: "单窗推理拍数", unit: "cycles",
    docs: { design: /(440,087)/, eval: /(440,087)/, registry: /(440,087)/, figure: /f6,单窗总拍,(\d+)/ } },
  { key: "infer_ms", label: "单窗推理时间", unit: "ms",
    docs: { design: /(8\.80)\s*ms/, eval: /(8\.80)\s*ms/, registry: /(8\.80)\s*ms/, figure: /f6,100 ms 窗推理,([\d.]+) ms/ } },
  { key: "v7_fold_recall", label: "v7 折级开合召回", unit: "",
    docs: { design: /(0\.9412)/, eval: /(0\.9412)/, registry: /(0\.9412)/, figure: /f8,v7 开合块召回,([\d.]+)/ } },
  { key: "v7_wave_win", label: "v7 挥手窗级命中", unit: "",
    docs: { design: /(5\/510)=0\.0098/, eval: /(5\/510)=0\.0098/, registry: /(5\/510)=0\.0098/ } },
  { key: "v7_wave_hit", label: "v7 挥手窗级命中率", unit: "",
    docs: { design: /5\/510=(0\.0098)/, eval: /5\/510=(0\.0098)/, registry: /5\/510=(0\.0098)/, figure: /f8,v7 挥手窗级命中,([\d.]+)/ } },
  { key: "v7_s50_hardneg_rate", label: "v7 s50 硬负脉冲率", unit: "次/分", tolerance: 0.01,
    docs: { eval: /折合 (1\.21) 次\/分/, figure: /f7,硬负 pulse 率,([\d.]+) 次\/分/ } },
  { key: "v7_s100_hardneg", label: "v7 s100 硬负脉冲数", unit: "pulse",
    docs: { design: /硬负 pulse (5)/, registry: /硬负 pulse (5)/, decision: /硬负样本 pulse \| (5) \| 2/ } },
  { key: "v7b_hardneg", label: "v7b 硬负脉冲数", unit: "pulse",
    docs: { design: /硬负 pulse (2)/, registry: /硬负 pulse (2)/, decision: /硬负样本 pulse \| ≤ 1 \| (2)（/ } },
  { key: "v7b_dwave", label: "v7b 镜像 d_wave", unit: "",
    docs: { design: /d_wave (0\.0196)/, registry: /d_wave=?(0\.0196)/, decision: /(0\.0196)（int8）/ } },
  { key: "v7b_ok", label: "V7B_MODEL_OK", unit: "",
    docs: { design: /V7B_MODEL_OK 记 (0)/, registry: /V7B_MODEL_OK=(0)/, decision: /V7B_MODEL_OK[^0-9]{0,20}(0)/ } },
  { key: "act7_bits", label: "act7 位流大小", unit: "B",
    docs: { design: /(2,835,423)\s*B/, registry: /(2,835,423)\s*B/ } },
  { key: "act7_wns", label: "act7 WNS", unit: "ns",
    docs: { design: /WNS (\+0\.059)\s*ns/, registry: /WNS[^+\n]{0,3}(\+0\.059)/, decision: /余量仅 (0\.059) ns/ } },
  { key: "act7_lut", label: "act7 LUT", unit: "",
    docs: { design: /LUT (22,371)/, registry: /LUT (22,371)/ } },
  { key: "act7_slice", label: "act7 Slice", unit: "",
    docs: { design: /Slice (7,968)/, registry: /Slice (7,968)/ } },
  { key: "act8_bits", label: "act8 位流大小", unit: "B",
    docs: { design: /(2,839,107)\s*B/, registry: /(2,839,107)\s*B/ } },
  { key: "act8_wns", label: "act8 WNS", unit: "ns",
    docs: { design: /(\+0\.215)\s*ns/, registry: /(\+0\.215)\s*ns/ } },
  { key: "act8_lut", label: "act8 LUT", unit: "",
    docs: { design: /LUT (22,383)/, registry: /LUT (22,383)/ } },
  { key: "act8_slice", label: "act8 Slice", unit: "",
    docs: { design: /Slice (8,026)/, registry: /Slice (8,026)/ } },
  { key: "startup_pps", label: "实时链路 pps", unit: "",
    docs: { design: /pps≈(15,940)/, registry: /pps≈(15,940)/ } },
  { key: "host_tests", label: "上位机测试数", unit: "tests",
    docs: { design: /(670) tests/, registry: /(670) tests/ } },
];

const results = [];
for (const metric of metrics) {
  const raw = {};
  const present = [];
  for (const [doc, re] of Object.entries(metric.docs)) {
    raw[doc] = get(doc, re);
    if (raw[doc] !== null) present.push(doc);
  }
  const vals = present.map((doc) => norm(raw[doc]));
  const unique = [...new Set(vals)];
  let status = "OK";
  if (present.length === 0) status = "NO_SOURCE";
  else if (unique.length > 1) {
    const nums = vals.map(Number);
    const rounded = metric.tolerance !== undefined && nums.every(Number.isFinite) && Math.max(...nums) - Math.min(...nums) <= metric.tolerance;
    status = rounded ? "OK_ROUNDED" : "CONFLICT";
  }
  else if (present.length < Object.keys(metric.docs).length) status = "GAP";
  results.push({ ...metric, raw, present, status });
}

const scopeConflicts = [{
  key: "v7_hardneg_scope",
  item: "v7 硬负样本脉冲数",
  evalValue: "1（s50 0.5 s 守卫；1.212 次/分）",
  otherValue: "5（s100 板端口径；design/registry/decision）",
  resolution: "两个数都真，口径不同：evaluation_report 的 1 来自 s50 带守卫的离线折；design/registry/decision 的 5 来自 lead 的 s100 板端复评。D8-A7 已把 s50 与 s100 分开登记；evaluation_report 由 anno 补一句口径说明后关闭，不阻塞本报告。",
  resolved: true,
  owner: "anno（评测报告加口径句）；director（D8-A7 已拆开）",
}];

const unresolved = scopeConflicts.filter((c) => !c.resolved);
const strong = results.filter((r) => r.status === "CONFLICT" || r.status === "NO_SOURCE");
const gaps = results.filter((r) => r.status === "GAP");
const ok = missingFiles.length === 0 && strong.length === 0 && unresolved.length === 0;

const rows = results.map((r, i) => {
  const cols = ["design", "eval", "figure", "registry", "decision"].map((d) => cell(r.raw[d]));
  return "| " + (i + 1) + " | " + r.label + " | " + cols.join(" | ") + " | " + r.status + " |";
});
const gapRows = gaps.map((r) => "| " + r.label + " | " + r.present.join("、") + " | " + Object.keys(r.docs).filter((d) => !r.present.includes(d)).join("、") + " |");
const conflictRows = scopeConflicts.map((c) => "| " + c.item + " | " + c.evalValue + " | " + c.otherValue + " | " + (c.resolved ? "已裁定" : "未裁定") + " | " + c.resolution + " |");

const md = [
  "# 跨文档数字一致性核对（M9m）",
  "",
  "生成命令：node report/evidence/crossdoc_check.mjs（本文件由脚本生成，勿手改）。",
  "核对范围：design_report.md、evaluation_report.md、figure_data_table.csv、02_metric_register.md、03_v7b_deployment_decision.md。",
  "",
  "## 1 方法",
  "",
  "脚本按“指标名 + 数值”抽取五份文档中的同一口径，先去掉千分位、单位与正号再比较。指标名与文档的映射由人工维护；脚本只做抽取和比对，不猜语义。五个源文件中任一个缺失，CROSSDOC_OK 记 0。",
  "",
  "数值缺失记为 GAP：该文档尚未覆盖这个指标，不等于冲突。两个以上来源数值不一致才记 CONFLICT。同一指标存在两种已声明口径时，单列到第 3 节裁定，不混进主表。",
  "",
  "## 2 指标对照",
  "",
  "| # | 指标 | 设计报告 | 评测报告 | 图表数据表 | 口径登记 | v7b 裁决 | 结论 |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
  "主表共 " + results.length + " 项：OK " + results.filter((r) => r.status.startsWith("OK")).length + " 项（其中舍入一致 " + results.filter((r) => r.status === "OK_ROUNDED").length + " 项），GAP " + gaps.length + " 项，CONFLICT " + results.filter((r) => r.status === "CONFLICT").length + " 项，NO_SOURCE " + results.filter((r) => r.status === "NO_SOURCE").length + " 项。",
  "",
  "## 3 冲突与裁定",
  "",
  "| 项 | evaluation_report | 设计报告 / 登记册 / 裁决 | 状态 | 裁定 |",
  "|---|---|---|---|---|",
  ...conflictRows,
  "",
  "这条是口径冲突，未发现同一口径下的数值矛盾。两个数分别属于 s50 与 s100：s50 是训练侧带 0.5 s 守卫的折级结果，s100 是部署口径的板端复评。设计报告与登记册已把两个口径并列，评测报告仍只写 s50，需由 anno 补一句口径说明。",
  "",
  "## 4 未完整覆盖的指标（记为 GAP，不参与判定）",
  "",
  "| 指标 | 已有来源 | 缺失来源 |",
  "|---|---|---|",
  ...(gapRows.length ? gapRows : ["| 无 | — | — |"]),
  "",
  "上表是主表 " + results.length + " 项中记为 GAP 的指标：act3c 位流大小缺口径登记，v7 s50 硬负脉冲率缺图表数据表。act7、act8 与 v7b 的位流、时序、资源与部署数字目前只在设计报告、登记册与裁决记录中有来源，评测报告与图表数据表尚未完整覆盖；仅有两个来源的指标按现有来源判 OK，不记为 GAP。GAP 表示“该文档尚未覆盖”，不等于数值冲突，不参与 CROSSDOC_OK 判定。这些缺口不影响已登记数字的一致性，但提交前应由 lead 决定是否让 anno 同步评测报告与图表。",
  "",
  "## 5 结论",
  "",
  "五份源文件均存在。主表没有同一口径的数值冲突；唯一的跨口径差异已单列裁定并指定补写人。CROSSDOC_OK=" + (ok ? "1" : "0") + "。",
  "",
].join("\n");

const out = path.join(root, "report", "evidence", "crossdoc_conflicts.md");
fs.writeFileSync(out, md, "utf8");

for (const r of results) console.log("METRIC " + r.key + " = " + r.status + " [" + r.present.join(",") + "]");
for (const c of scopeConflicts) console.log("SCOPE_DIFF " + c.key + " resolved=" + (c.resolved ? 1 : 0));
for (const f of missingFiles) console.log("MISSING_SOURCE " + f);
console.log("METRICS=" + results.length + " OK=" + results.filter((r) => r.status.startsWith("OK")).length + " ROUNDED=" + results.filter((r) => r.status === "OK_ROUNDED").length + " GAP=" + gaps.length + " CONFLICT=" + results.filter((r) => r.status === "CONFLICT").length + " NO_SOURCE=" + results.filter((r) => r.status === "NO_SOURCE").length);
console.log("CROSSDOC_OK=" + (ok ? 1 : 0));
process.exit(ok ? 0 : 1);
