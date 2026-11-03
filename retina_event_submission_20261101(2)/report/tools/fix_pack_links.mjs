#!/usr/bin/env node
// 打包后处理：修正仓库风格链接到包内位置；确实指向包外文件的降级为文本标注。
// 用法: node report/tools/fix_pack_links.mjs --pack <dir> [--dry]
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--pack");
const pack = path.resolve(pi >= 0 ? argv[pi + 1] : ".");
const dry = argv.includes("--dry");
const exts = new Set([".md"]);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.has(path.extname(e.name).toLowerCase())) files.push(p);
  }
})(pack);

const ALIAS = [
  ["retina_event/src/hdl", "src/rtl"],
  ["retina_event/sim", "sim"],
  ["retina_event/tool", "build"],
  ["retina_event/build", "build"],
  ["retina_event/docs", "docs/06_facts"],
  ["host/app", "src/host"],
  ["nn/", "src/nn/"],
];
const roots = new Set();
for (const e of fs.readdirSync(pack)) roots.add(e);

function existsRel(rel) {
  const abs = path.resolve(pack, rel);
  return fs.existsSync(abs) && abs.startsWith(pack);
}
function tryPackRoot(raw) {
  let cand = raw.replace(/^\.\//, "");
  if (existsRel(cand)) return cand;
  for (const [from, to] of ALIAS) {
    if (cand === from || cand.startsWith(from + "/")) {
      const mapped = to + cand.slice(from.length);
      if (existsRel(mapped)) return mapped;
    }
    if (cand.startsWith(to + "/")) return null;
  }
  return null;
}

let scanned = 0, fixed = 0, rewritten = 0;
const report = [];
const linkRe = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  scanned++;
  let changed = false;
  const out = src.replace(linkRe, (all, bang, label, target) => {
    if (/^(https?:|mailto:|#|data:)/i.test(target)) return all;
    const hashIdx = target.indexOf("#");
    const raw = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
    const hash = hashIdx >= 0 ? target.slice(hashIdx) : "";
    if (!raw) return all;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (e) {}
    const direct = path.resolve(path.dirname(f), decoded);
    if (fs.existsSync(direct)) return all;
    const mapped = tryPackRoot(decoded);
    if (mapped) {
      let rel = path.relative(path.dirname(f), path.resolve(pack, mapped)).split(path.sep).join("/");
      if (decoded.endsWith("/")) rel += "/";
      changed = true; rewritten++;
      report.push("FIX " + path.relative(pack, f).split(path.sep).join("/") + " -> " + target + " => " + rel);
      return (bang ? "!" : "") + "[" + label + "](" + (rel + hash) + ")";
    }
    changed = true; fixed++;
    report.push("DROP " + path.relative(pack, f).split(path.sep).join("/") + " -> " + target);
    const shown = label && label.trim() ? label.trim() : raw;
    const kind = bang === "!" ? "图" : "文件";
    return shown + "（" + kind + " " + decoded + "，未随包发布）";
  });
  if (changed && !dry) fs.writeFileSync(f, out);
}
console.log("LINK_FIX_FILES=" + scanned + " REWRITTEN=" + rewritten + " DROPPED=" + fixed + (dry ? " DRY=1" : ""));
for (const r of report.slice(0, 30)) console.log("LINK_FIX " + r);
if (report.length > 30) console.log("LINK_FIX ... 其余 " + (report.length - 30) + " 条");
console.log("PACK_LINK_FIX_OK=1");
