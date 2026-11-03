#!/usr/bin/env node
// 检查提交包内的路径一致性：
//   1) report/**/*.md 正文与链接里出现的 figures/ 路径逐个 isfile；
//   2) report/figures 下每个 SVG 都被 report/**/*.md 正文/链接按相对路径引用，且文件名全小写；
//   3) report/**/*.md 与根 README.md 的正文/行内引用里，report/、src/、build/、board/、skill/、docs/
//      开头的路径逐个在包内存在；缺失打印 DANGLING_REF 并失败；
//   4) 跨包引用（retina_event/、nn/ 等上游路径）单独计入 EXTERNAL_REF，不算断链；
//   5) 官方 3.3.5.4 八项目录/文件对照表，缺项为 0。
// 代码块（围栏与 4 空格缩进）按既有口径跳过：里面常是生成命令/产物示例，不是可点击引用。
//
// 用法（仓库根）：
//   node report/tools/check_pack_paths.mjs --pack temp_test/pack
//
// 只读检查，不写文件、不跑 Vivado、不占网络端口。退出码：0 全通过；1 有缺失；2 参数/包目录错误。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const OFFICIAL = [
  { requirement: 'README.md', target: 'README.md', kind: 'file' },
  { requirement: 'src/', target: 'src', kind: 'dir' },
  { requirement: 'sim/', target: 'sim', kind: 'dir' },
  { requirement: 'build/', target: 'build', kind: 'dir' },
  { requirement: 'board/', target: 'board', kind: 'dir' },
  { requirement: 'data/', target: 'data', kind: 'dir' },
  { requirement: 'skill/README.md', target: 'skill/README.md', kind: 'file' },
  { requirement: 'report/', target: 'report', kind: 'dir' }
];

const FIGURE_REF_RE = /((?:report\/)?figures\/[A-Za-z0-9._\/-]+)/g;
const INTERNAL_REF_RE = /(?<![\w./-])((?:report|src|build|board|skill|docs)\/[\p{L}\p{N}_.\/-]+)/gu;
// 上游原始仓库里的路径（retina_event/、nn/ 等）不随提交包分发，
// report 正文引用它们属于跨包引用：单独计入 EXTERNAL_REF，不算断链失败。
const EXTERNAL_REF_RE = /(?<![\w./-])((?:retina_event|nn|host|ref_original|exp_ov5640_lcd_eth)\/[\p{L}\p{N}_.\/-]+)/gu;

function usage() {
  console.log('用法: node report/tools/check_pack_paths.mjs [--pack <dir>]');
  console.log('  --pack <dir>  提交包根目录，默认 temp_test/pack（相对当前工作目录）');
}

function parseArgs(argv) {
  const opts = { pack: 'temp_test/pack' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (arg === '--pack') {
      const value = argv[++i];
      if (!value) { console.error('ERROR --pack 缺少参数'); process.exit(2); }
      opts.pack = value;
      continue;
    }
    console.error(`ERROR 未知参数: ${arg}`);
    usage();
    process.exit(2);
  }
  return opts;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkFiles(root, predicate, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function lineKind(line, state) {
  const fence = line.match(/^\s*(`{3,}|~{3,})/);
  if (fence) {
    if (!state.inFence) {
      state.inFence = true;
      state.fenceChar = fence[1][0];
    } else if (fence[1][0] === state.fenceChar) {
      state.inFence = false;
      state.fenceChar = '';
    }
    return 'code';
  }
  if (state.inFence) return 'code';
  if (/^(?: {4,}|\t)/.test(line)) return 'code';
  return 'text';
}

function collectFigureRefs(packRoot, mdFiles) {
  const refs = [];
  let mdFilesWithRefs = 0;
  for (const mdFile of mdFiles) {
    const text = readFileSync(mdFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const state = { inFence: false, fenceChar: '' };
    let fileHasRef = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kind = lineKind(line, state);
      if (kind !== 'text') continue;
      for (const match of line.matchAll(FIGURE_REF_RE)) {
        const raw = match[1];
        if (raw.endsWith('/') || raw === 'figures') continue;
        const stripped = raw.replace(/[.,;:]+$/, '');
        const isRepoRel = stripped.startsWith('report/');
        const abs = isRepoRel ? resolve(packRoot, stripped) : resolve(dirname(mdFile), stripped);
        const packRel = toPosix(relative(packRoot, abs));
        let ok = false;
        let reason = 'missing';
        try {
          // 逐段精确匹配大小写：Windows 的 statSync 大小写不敏感，Linux 上会断链。
          ok = exactExists(packRoot, packRel) && statSync(abs).isFile();
        } catch {
          ok = false;
        }
        if (!ok) reason = 'not-a-file';
        if (packRel.startsWith('..')) reason = 'outside-pack';
        refs.push({
          mdRel: toPosix(relative(packRoot, mdFile)),
          line: i + 1,
          raw: stripped,
          packRel,
          ok,
          reason
        });
        fileHasRef = true;
      }
    }
    if (fileHasRef) mdFilesWithRefs++;
  }
  return { refs, mdFilesWithRefs };
}

// 仓库内源目录名是 retina_event/src/hdl，提交包按官方结构降为 src/rtl。
// 设计报告在仓库语境里写 src/hdl 是正确的，不要求改正文；只在包内引用
// 检查时把它视作 src/rtl 的已知等价别名，并统计 ALIAS_APPLIED。
const KNOWN_PATH_ALIASES = new Map([
  ['src/hdl', 'src/rtl']
]);

function resolveInternalAlias(raw) {
  for (const [from, to] of KNOWN_PATH_ALIASES) {
    if (raw === from || raw.startsWith(from + '/')) {
      return { target: to + raw.slice(from.length), label: from + '->' + to };
    }
  }
  return { target: raw, label: '' };
}

function collectInternalRefs(packRoot, mdFiles) {
  const refs = [];
  const aliasCounts = new Map();
  let mdFilesWithRefs = 0;
  for (const mdFile of mdFiles) {
    const mdRel = toPosix(relative(packRoot, mdFile));
    const text = readFileSync(mdFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const state = { inFence: false, fenceChar: '' };
    let fileHasRef = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kind = lineKind(line, state);
      if (kind !== 'text') continue;
      for (const match of line.matchAll(INTERNAL_REF_RE)) {
        let raw = match[1];
        raw = raw.replace(/[.,;:!?，。；：！？、）】》」』"'`]+$/u, '');
        if (!raw || raw.endsWith('/')) continue;
        if (/[*?{}<>]/.test(raw)) continue;
        // 只跳过真正的通配 token：board/EVIDENCE_*.log 这类，正则先截到 EVIDENCE_。
        const nextChar = line.charAt(match.index + match[0].length);
        if (nextChar === '*' || nextChar === '?' || nextChar === '{' || nextChar === '<') continue;
        const alias = resolveInternalAlias(raw);
        const target = alias.target;
        const abs = resolve(packRoot, target);
        const packRel = toPosix(relative(packRoot, abs));
        // 逐段精确匹配大小写；否则 Windows 上 act8_artifacts.txt / act8_artifacts.txt 会被误判存在。
        const ok = exactExists(packRoot, target);
        let reason = 'missing';
        if (!ok) reason = 'not-found';
        if (packRel.startsWith('..')) reason = 'outside-pack';
        if (alias.label) aliasCounts.set(alias.label, (aliasCounts.get(alias.label) || 0) + 1);
        refs.push({ mdRel, line: i + 1, raw, packRel, ok, reason, target, alias: alias.label });
        fileHasRef = true;
      }
    }
    if (fileHasRef) mdFilesWithRefs++;
  }
  return { refs, mdFilesWithRefs, aliasCounts };
}

function collectExternalRefs(mdFiles, packRoot) {
  const refs = [];
  for (const mdFile of mdFiles) {
    const mdRel = toPosix(relative(packRoot, mdFile));
    const text = readFileSync(mdFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const state = { inFence: false, fenceChar: '' };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (lineKind(line, state) !== 'text') continue;
      for (const match of line.matchAll(EXTERNAL_REF_RE)) {
        let raw = match[1];
        raw = raw.replace(/[.,;:!?，。；：！？、）】》」』"'\x60]+$/u, '');
        if (!raw || raw.endsWith('/')) continue;
        if (/[*?{}<>]/.test(raw)) continue;
        const nextChar = line.charAt(match.index + match[0].length);
        if (nextChar === '*' || nextChar === '?' || nextChar === '{' || nextChar === '<') continue;
        refs.push({ mdRel, line: i + 1, raw });
      }
    }
  }
  return refs;
}

function exactExists(packRoot, rel) {
  let cur = packRoot;
  for (const part of rel.split('/')) {
    if (!part) continue;
    let names;
    try {
      names = readdirSync(cur);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    cur = join(cur, part);
  }
  try {
    statSync(cur);
    return true;
  } catch {
    return false;
  }
}

function countFiles(packRoot, rel) {
  const abs = join(packRoot, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return -1;
  }
  if (st.isFile()) return 1;
  if (!st.isDirectory()) return -1;
  let count = 0;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(packRoot, toPosix(join(rel, entry.name)));
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const packRoot = resolve(process.cwd(), opts.pack);
  let packStat;
  try {
    packStat = statSync(packRoot);
  } catch {
    console.error(`ERROR 包目录不存在: ${packRoot}`);
    process.exit(2);
  }
  if (!packStat.isDirectory()) {
    console.error(`ERROR --pack 不是目录: ${packRoot}`);
    process.exit(2);
  }

  const errors = [];
  console.log(`PACK_PATH_PACK=${toPosix(packRoot)}`);

  const mdFiles = walkFiles(packRoot, (p) => p.endsWith('.md'))
    .map((p) => join(packRoot, toPosix(relative(packRoot, p))))
    .filter((p) => toPosix(relative(packRoot, p)).startsWith('report/'))
    .sort();
  const reportMd = mdFiles.filter((p) => toPosix(relative(packRoot, p)).startsWith('report/'));
  const { refs, mdFilesWithRefs } = collectFigureRefs(packRoot, reportMd);
  const uniqueRefs = new Set(refs.map((r) => r.packRel));
  const missing = [...new Map(
    refs.filter((r) => !r.ok).map((r) => [`${r.packRel}|${r.mdRel}|${r.line}|${r.raw}`, r])
  ).values()];

  console.log(`FIG_PATH_MD_FILES=${reportMd.length}`);
  console.log(`FIG_PATH_MD_WITH_REFS=${mdFilesWithRefs}`);
  console.log(`FIG_PATH_REFS=${refs.length}`);
  console.log(`FIG_PATH_UNIQUE=${uniqueRefs.size}`);
  console.log(`检查 ${refs.length} 条、缺失 ${missing.length} 条`);
  if (missing.length > 0) {
    for (const item of missing) {
      console.log(`MISSING_FIGURE_PATH ${item.packRel} <- ${item.mdRel}:${item.line} (${item.raw}) reason=${item.reason}`);
      errors.push('figure-path');
    }
  } else {
    console.log('FIG_PATH_MISSING=0');
  }

  const rootReadme = join(packRoot, 'README.md');
  const internalMd = [];
  try {
    if (statSync(rootReadme).isFile()) internalMd.push(rootReadme);
  } catch {
    // README.md 缺失由官方八项检查报告，这里不重复。
  }
  internalMd.push(...reportMd);
  const internal = collectInternalRefs(packRoot, internalMd);
  const uniqueInternal = new Set(internal.refs.map((r) => r.packRel));
  const missingInternal = [...new Map(
    internal.refs.filter((r) => !r.ok).map((r) => [`${r.mdRel}|${r.line}|${r.packRel}`, r])
  ).values()];
  console.log(`INTERNAL_REF_MD_FILES=${internalMd.length}`);
  console.log(`INTERNAL_REF_FILES_WITH_REFS=${internal.mdFilesWithRefs}`);
  console.log(`INTERNAL_REFS=${internal.refs.length}`);
  console.log(`INTERNAL_UNIQUE=${uniqueInternal.size}`);
  console.log(`INTERNAL_MISSING=${missingInternal.length}`);
  for (const [label, count] of internal.aliasCounts) {
    console.log(`ALIAS_APPLIED ${label} count=${count}`);
  }
  if (missingInternal.length > 0) {
    for (const item of missingInternal) {
      const targetPart = item.target !== item.raw ? `, target=${item.target}` : '';
      console.log(`DANGLING_REF ${item.mdRel}:${item.line} -> ${item.packRel} (raw=${item.raw}${targetPart}, reason=${item.reason})`);
      errors.push('internal-ref');
    }
  } else {
    console.log('INTERNAL_REF_MISSING=0');
  }

  const externalRefs = collectExternalRefs(internalMd, packRoot);
  const uniqueExternal = new Set(externalRefs.map((r) => r.raw));
  console.log(`EXTERNAL_REFS=${externalRefs.length}`);
  console.log(`EXTERNAL_REF_UNIQUE=${uniqueExternal.size}`);
  // 同一跨包路径可能在多份文档重复出现：逐条打印会淹没输出，按首次位置各打一条。
  const seenExternal = new Set();
  for (const item of externalRefs) {
    if (seenExternal.has(item.raw)) continue;
    seenExternal.add(item.raw);
    console.log(`EXTERNAL_REF ${item.mdRel}:${item.line} -> ${item.raw}`);
  }

  const figuresDir = join(packRoot, 'report', 'figures');
  let figureEntries = [];
  try {
    figureEntries = readdirSync(figuresDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    console.log(`ERROR report/figures 不存在: ${toPosix(figuresDir)}`);
    errors.push('figures-dir');
  }
  const svgNames = figureEntries.filter((n) => n.endsWith('.svg')).sort();
  const badSvgNames = svgNames.filter((n) => n !== n.toLowerCase());
  const badFigureNames = figureEntries.filter((n) => n !== n.toLowerCase());
  console.log(`FIGURE_SVGS=${svgNames.length}`);
  console.log(`FIGURE_SVG_NAMES_LOWER=${badSvgNames.length === 0 ? 1 : 0}`);
  console.log(`FIGURE_FILES=${figureEntries.length}`);
  console.log(`FIGURE_FILES_LOWER=${badFigureNames.length === 0 ? 1 : 0}`);
  const referencedFigurePaths = new Set(refs.map((item) => item.packRel));
  const missingSvgRefs = svgNames.filter((name) => !referencedFigurePaths.has(`report/figures/${name}`));
  const referencedSvgCount = svgNames.length - missingSvgRefs.length;
  console.log(`FIGURES=${svgNames.length} refs_ok=${referencedSvgCount} missing_refs=[${missingSvgRefs.join(',')}]`);
  for (const name of missingSvgRefs) {
    console.log(`UNREFERENCED_FIGURE report/figures/${name}`);
    errors.push('svg-unreferenced');
  }
  for (const name of badSvgNames) {
    console.log(`BAD_FIGURE_NAME ${name}`);
    errors.push('svg-case');
  }
  for (const name of badFigureNames) {
    console.log(`BAD_FIGURE_FILE_NAME ${name}`);
    errors.push('figure-case');
  }

  console.log('官方要求 | 包内路径 | 文件数');
  let officialMissing = 0;
  for (const item of OFFICIAL) {
    const exists = exactExists(packRoot, item.target);
    const count = countFiles(packRoot, item.target);
    const ok = exists && count > 0;
    if (!ok) {
      officialMissing++;
      errors.push('official');
    }
    console.log(`${item.requirement} | ${item.target} | ${count < 0 ? 0 : count}${ok ? '' : ' MISSING'}`);
  }
  console.log(`官方八项缺项=${officialMissing}`);
  if (officialMissing === 0) {
    console.log('OFFICIAL_LAYOUT_OK=1');
  } else {
    console.log('OFFICIAL_LAYOUT_OK=0');
  }

  if (errors.length > 0) {
    console.log('PACK_PATH_CHECK_OK=0');
    process.exit(1);
  }
  console.log('PACK_PATH_CHECK_OK=1');
}

main();
