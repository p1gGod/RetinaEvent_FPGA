#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const reportPath = path.join(root, "report", "design_report.md");
const text = fs.readFileSync(reportPath, "utf8");
const lines = text.split(/\r?\n/);
let failures = 0;

// 代码块里的 # 是 PowerShell 注释，不是 Markdown 标题；表格/标题检查只看围栏外。
const proseLines = [];
let inFence = false;
for (const line of lines) {
  if (/^```/.test(line)) {
    inFence = !inFence;
    continue;
  }
  if (!inFence) proseLines.push(line);
}

function ok(name, cond, detail = "") {
  if (cond) {
    console.log(`CHECK ${name} = 1 ${detail}`);
  } else {
    failures += 1;
    console.log(`CHECK ${name} = 0 ${detail}`);
  }
}

const expectedH1 = [
  "选题背景与创新点",
  "设计原理与功能框图",
  "软硬件划分依据与接口设计",
  "优化过程与前后对比",
  "大模型协作",
  "技能包提炼过程",
  "复现说明",
];
const h1 = proseLines.filter((l) => /^# /.test(l)).map((l) => l.slice(2).trim());
ok("H1_COUNT", h1.length === 7, `got=${h1.length}`);
ok("H1_TITLES", JSON.stringify(h1) === JSON.stringify(expectedH1), JSON.stringify(h1));
ok("H4_PLUS", proseLines.filter((l) => /^#{4,} /.test(l)).length === 0);

const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
ok("CJK_GE_12000", cjk >= 12000, `cjk=${cjk}`);

const tables = (text.match(/^\|[- :|]+\|$/gm) || []).length;
ok("TABLES_GE_8", tables >= 8, `tables=${tables}`);

let tableIssues = 0;
let inTable = false;
let columns = 0;
for (let i = 0; i < proseLines.length; i += 1) {
  const line = proseLines[i];
  if (/^\|/.test(line)) {
    const n = (line.match(/\|/g) || []).length;
    if (!inTable) {
      inTable = true;
      columns = n;
    } else if (n !== columns) {
      tableIssues += 1;
      console.log(`TABLE_COLUMN_MISMATCH line=${i + 1} got=${n} expect=${columns}`);
    }
  } else if (inTable) {
    inTable = false;
  }
}
ok("TABLE_COLUMNS", tableIssues === 0, `issues=${tableIssues}`);

const banned = [
  "不是[^。\\n]{0,30}而是",
  "首先",
  "其次",
  "最后",
  "值得注意",
  "赋能",
  "打造",
  "助力",
  "闭环",
  "痛点",
  "一站式",
  "多维度",
  "显著提升",
  "极大地",
  "大幅",
  "完美",
  "我们认为",
  "可以说",
  "综上",
  "总而言之",
  "智能识别",
  "硬件加速",
  "我们",
];
let bannedHits = 0;
for (const pattern of banned) {
  const re = new RegExp(pattern, "g");
  const hits = [...text.matchAll(re)].length;
  if (hits > 0) {
    bannedHits += hits;
    console.log(`BANNED_PATTERN ${pattern} hits=${hits}`);
  }
}
ok("BANNED_TERMS", bannedHits === 0, `hits=${bannedHits}`);

const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|mailto:|#)/.test(u));
const missing = [];
for (const raw of links) {
  const file = decodeURI(raw.split("#")[0]);
  if (!fs.existsSync(path.resolve(root, "report", file))) missing.push(raw);
}
ok("REFS", missing.length === 0, `links=${links.length} missing=${missing.length}`);
for (const item of missing) console.log(`MISSING_LINK ${item}`);

const required = [
  "docs/06_facts/02_metric_register.md",
  "docs/03_tech/05_action_uplink_contract.md",
  "docs/06_facts/00_current_status.md",
];
for (const rel of required) {
  ok(`SOURCE_EXISTS_${rel.split("/").pop()}`, fs.existsSync(path.join(root, rel)), rel);
}

const numbers = [
  "20,559",
  "11,850",
  "7,327",
  "+0.306 ns",
  "2,890,875",
  "a5fff751",
  "15,940",
  "207,840",
  "5,652",
  "0.9042",
];
for (const n of numbers) {
  ok(`NUMBER_PRESENT_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}

// 任务 A1：厂家依赖前置步骤必须可复现。
for (const n of ["步骤 0：厂家依赖前置", "vendor_manifest.json", "26 个文件", "206,613", "a9693c2c", "setup_vendor_rtl.ps1 -Check", "VENDOR_MANIFEST_OK=1", "只做仿真"]) {
  ok(`STEP0_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}

// 任务 A2：Vivado 版本迁移边界必须写明。
for (const n of ["Vivado 2020.2", "2026.1", "迁移差异本版未测量"]) {
  ok(`VIVADO_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}

// 任务 A3：匿名声明，且不出现学校名与指导教师姓名。
ok("ANON_STATEMENT", text.includes("匿名声明：按赛事要求，本报告不包含学校名称与指导教师姓名"), "");
const schoolHits = [...text.matchAll(/([\u4e00-\u9fff]{2,10})(大学|学院)(?!生)/g)].map((m) => m[0]);
ok("ANON_NO_SCHOOL", schoolHits.length === 0, schoolHits.join(","));
ok("ANON_NO_ADVISOR", !/指导教师[：:]\s*\S+/.test(text), "");

// act7 / v7b 的关键数字与裁决结果必须同时出现，防止只改标题不改数字。
for (const n of ["2,835,423", "+0.059 ns", "22,371", "7,968", "50.27%"]) {
  ok(`ACT7_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}
for (const n of ["2,839,107", "5ec55e", "+0.215 ns", "22,383", "8,026", "50.64%", "已烧板"]) {
  ok(`ACT8_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}
for (const n of ["8/3", "16/3", "24/4", "88 降到 74", "14/17", "0.0196", "V7B_MODEL_OK 记 0", "46.5 s"]) {
  ok(`V7B_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}
for (const n of ["17/17", "5/510", "0.0098", "A1~A4 动作段验收未执行", "同一模型在两种窗口径下的硬负率不同，报告统一采用 s100 板端口径"]) {
  ok(`V7_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}

// 2026-10-31 act8 空场景被动基线：数字与口径必须一起出现，防止只改结论。
for (const n of ["20.1 分钟带录像", "4 小时连续监测", "0.0125", "0.149", "32,163", "19,750", "67,467,822", "D8-M13"]) {
  ok(`BASE_${n.replace(/[^0-9a-zA-Z]/g, "")}`, text.includes(n), n);
}

console.log(`STYLE_CHECK_OK=${failures === 0 ? 1 : 0}`);
console.log(`REFS_OK=${missing.length === 0 ? 1 : 0}`);
process.exit(failures === 0 && missing.length === 0 ? 0 : 1);
