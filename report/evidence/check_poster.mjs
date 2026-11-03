#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`CHECK ${name} = 1 ${detail}`);
  else { failures += 1; console.log(`CHECK ${name} = 0 ${detail}`); }
};

const posterMd = read("report/poster_en.md");
const posterSvg = read("report/poster_en.svg");
const d8 = read("docs/06_facts/02_metric_register.md");

const sections = [...posterMd.matchAll(/^## \d+\./gm)].length;
ok("POSTER_SECTIONS_6", sections === 6, `sections=${sections}`);

const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
const svgTexts = [...posterSvg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, " "))
  .join("\n");
ok("POSTER_ENGLISH_MD", !hasCjk(posterMd));
ok("POSTER_ENGLISH_SVG", !hasCjk(svgTexts));

let parseOk = false;
try {
  const out = execFileSync("python", ["-c", "import xml.etree.ElementTree as ET; ET.parse('report/poster_en.svg'); print('PARSE_OK=1')"], { cwd: root, encoding: "utf8" });
  parseOk = out.includes("PARSE_OK=1");
  if (parseOk) console.log("PARSE_OK=1");
} catch (error) {
  console.log("PARSE_ERROR " + String(error.message).slice(0, 200));
}
ok("SVG_XML_PARSE", parseOk);
ok("SVG_A4_PORTRAIT", /width="210mm"/.test(posterSvg) && /height="297mm"/.test(posterSvg));

const visible = posterMd + "\n" + svgTexts;
const numeric = [...new Set((visible.match(/[0-9]+(?:[.,][0-9]+)*/g) || []))];
const missing = numeric.filter((n) => !d8.includes(n));
ok("POSTER_NUMBERS", missing.length === 0, `=${numeric.length - missing.length}/${numeric.length}`);
console.log(`POSTER_NUMBERS=${numeric.length - missing.length}/${numeric.length}`);
for (const n of missing) console.log("MISSING_NUMBER " + n);

const video = read("report/demo_video_script.md");
const timeRe = /(\d{2}):(\d{2})[–-](\d{2}):(\d{2})/;
const rows = [];
for (const line of video.split(/\r?\n/)) {
  if (!/^\|/.test(line)) continue;
  const m = line.match(timeRe);
  if (!m) continue;
  const toSec = (h, mm) => Number(h) * 60 + Number(mm);
  rows.push({ line, start: toSec(m[1], m[2]), end: toSec(m[3], m[4]) });
}
let monotonic = rows.length > 0 && rows[0].start === 0;
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].start < rows[i - 1].end) monotonic = false;
}
const totalSec = rows.length ? rows[rows.length - 1].end : 0;
ok("VIDEO_SHOTS_GE_6", rows.length >= 6, `shots=${rows.length}`);
ok("VIDEO_MONOTONIC", monotonic);
ok("VIDEO_TOTAL_LE_180", totalSec <= 180, `total=${totalSec}s`);
const requiredShots = ["静止", "开合", "录制", "标注", "时序", "资源"];
const missingShots = requiredShots.filter((k) => !video.includes(k));
ok("VIDEO_REQUIRED_SHOTS", missingShots.length === 0, `missing=${missingShots.join(",")}`);
let maxSentence = 0;
for (const row of rows) {
  const cols = row.line.split("|").map((s) => s.trim());
  const narration = cols[4] || "";
  for (const sentence of narration.split("。").filter(Boolean)) {
    const cjk = (sentence.match(/[\u4e00-\u9fff]/g) || []).length;
    maxSentence = Math.max(maxSentence, cjk);
  }
}
ok("VIDEO_SENTENCE_LE_25", maxSentence > 0 && maxSentence <= 25, `max=${maxSentence}`);
const coreChecksOk = failures === 0;
if (coreChecksOk) console.log("VIDEO_OK=1");
else console.log("VIDEO_OK=0");

const checklist = read("report/platform_checklist.md");
const requiredItems = ["演示视频", "概览图", "实物照", "承诺", "关键词"];
const missingItems = requiredItems.filter((k) => !checklist.includes(k));
ok("PLATFORM_FIVE_ITEMS", missingItems.length === 0, `missing=${missingItems.join(",")}`);
const cnStart = checklist.indexOf("### 3.1");
const cnEnd = checklist.indexOf("### 3.2");
const cnIntro = cnStart >= 0 && cnEnd > cnStart
  ? checklist.slice(cnStart, cnEnd).split("\n").slice(1).join(" ").trim()
  : "";
const cnCjk = (cnIntro.match(/[\u4e00-\u9fff]/g) || []).length;
ok("INTRO_CN_LE_200", cnCjk > 0 && cnCjk <= 200, `cjk=${cnCjk}`);
const enStart = checklist.indexOf("### 3.2");
const enEnd = checklist.indexOf("## 4.", enStart);
const enIntro = enStart >= 0 && enEnd > enStart
  ? checklist.slice(enStart, enEnd).split("\n").slice(1).join(" ").trim()
  : "";
const enWords = enIntro.split(/\s+/).filter(Boolean).length;
ok("INTRO_EN_LE_120", enWords > 0 && enWords <= 120, `words=${enWords}`);
const keywordRows = [...checklist.matchAll(/^\| (event-driven|on-chip-inference|reproducible) \|/gm)].length;
ok("PLATFORM_THREE_KEYWORDS", keywordRows === 3, `keywords=${keywordRows}`);

const docs04 = read("docs/04_contest/02_提交物清单.md");
ok("DOCS04_POSTER_PATH", docs04.includes("report/poster_en.svg") && docs04.includes("report/poster_en.md"));
ok("DOCS04_PLATFORM_PATH", docs04.includes("report/platform_checklist.md"));
if (failures === 0) {
  console.log("VIDEO_OK=1");
  console.log("PLATFORM_OK=1");
  console.log("POSTER_OK=1");
  process.exit(0);
} else {
  console.log("POSTER_OK=0");
  process.exit(1);
}
