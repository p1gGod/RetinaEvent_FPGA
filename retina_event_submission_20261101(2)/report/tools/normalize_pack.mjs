import fs from 'node:fs';
import path from 'node:path';

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const rootArg = argOf('root', 'temp_test/pack');
const mapArg = argOf('map', 'report/tools/name_map.json');
const dry = process.argv.includes('--dry-run');
const root = path.resolve(rootArg);
if (!fs.existsSync(root)) { console.log('NORMALIZE_FAIL missing-root ' + root); process.exit(2); }
const map = JSON.parse(fs.readFileSync(path.resolve(mapArg), 'utf8'));
const dirMap = map.dirs || {};
const fileMap = map.files || {};
const baseMap = map.basenames || {};
const allow = (map.allow || ['README.md', 'LICENSE']).map(s => s.split('/').pop());

const posix = p => p.split(path.sep).join('/');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function mapDir(d) {
  let best = null;
  for (const k of Object.keys(dirMap)) {
    if (d === k || d.startsWith(k + '/')) {
      if (best === null || k.length > best.length) best = k;
    }
  }
  return best === null ? d : dirMap[best] + d.slice(best.length);
}

const files = walk(root, []);
const plan = [];
const targets = new Map();
const unmapped = [];
for (const abs of files) {
  const rel = posix(path.relative(root, abs));
  const dir = posix(path.dirname(rel));
  const base = path.posix.basename(rel);
  const fin = fileMap[rel] !== undefined ? fileMap[rel] : mapDir(dir) + '/' + base;
  if (/[^\x00-\x7F]/.test(fin)) unmapped.push(rel + ' -> ' + fin);
  if (/[A-Z]/.test(path.posix.basename(fin)) && allow.indexOf(path.posix.basename(fin)) < 0) unmapped.push(rel + ' -> ' + fin + ' (uppercase basename)');
  if (targets.has(fin)) unmapped.push(rel + ' -> ' + fin + ' (collision with ' + targets.get(fin) + ')');
  targets.set(fin, rel);
  plan.push({ abs, rel, fin, finalAbs: path.join(root, fin) });
}

let renamed = 0;
for (const p of plan) {
  if (p.rel === p.fin) continue;
  if (!dry) {
    fs.mkdirSync(path.dirname(p.finalAbs), { recursive: true });
    fs.renameSync(p.abs, p.finalAbs);
  }
  renamed++;
}

function pruneEmpty(dir) {
  let removed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const abs = path.join(dir, e.name);
    removed += pruneEmpty(abs);
    if (fs.readdirSync(abs).length === 0) { fs.rmdirSync(abs); removed++; }
  }
  return removed;
}
const prunedDirs = dry ? 0 : pruneEmpty(root);

const replacements = [];
for (const k of Object.keys(dirMap)) replacements.push([k, dirMap[k]]);
for (const k of Object.keys(fileMap)) replacements.push([k, fileMap[k]]);
for (const k of Object.keys(baseMap)) replacements.push([k, baseMap[k]]);
replacements.sort((a, b) => b[0].length - a[0].length);

const rules = Array.isArray(map.content_rules) ? map.content_rules : [];
function globMatch(glob, rel) {
  const base = rel.split('/').pop();
  if (glob.indexOf('/') < 0) {
    const re = new RegExp('^' + glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
    return re.test(base);
  }
  const re = new RegExp('^' + glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
  return re.test(rel);
}

const REWRITE_EXT = new Set(['.md', '.txt', '.json', '.mjs', '.js', '.py', '.csv', '.log', '.tcl', '.ps1', '.v', '.vh', '.f', '.html', '.yml', '.yaml', '.bat', '.cmd', '.sh']);
const SKIP_DIRS = ['src/nn/'];

const after = walk(root, []).map(abs => ({ abs, rel: posix(path.relative(root, abs)) }));
let rewrittenFiles = 0;
let totalRepl = 0;
for (const f of after) {
  const ext = path.posix.extname(f.rel).toLowerCase();
  if (!REWRITE_EXT.has(ext)) continue;
  if (SKIP_DIRS.some(d => f.rel.startsWith(d))) continue;
  let buf;
  try { buf = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
  if (buf.indexOf('\u0000') >= 0) continue;
  let text = buf;
  let n = 0;
  for (const [o, nw] of replacements) {
    if (text.indexOf(o) < 0) continue;
    const before = text;
    text = text.split(o).join(nw);
    if (text !== before) n++;
  }
  // 按扩展名的定点改写（例如包内 .f 依赖清单里的仓库路径 src/hdl 需改为 src/rtl）
  for (const rule of rules) {
    if (!globMatch(rule.glob, f.rel)) continue;
    if (text.indexOf(rule.from) < 0) continue;
    text = text.split(rule.from).join(rule.to);
    n++;
  }
  if (text !== buf) {
    if (!dry) fs.writeFileSync(f.abs, text);
    rewrittenFiles++;
    totalRepl += n;
  }
}

const leftover = [];
for (const f of walk(root, [])) {
  const ext = path.posix.extname(f).toLowerCase();
  if (!REWRITE_EXT.has(ext)) continue;
  const rel = posix(path.relative(root, f));
  if (SKIP_DIRS.some(d => rel.startsWith(d))) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const [o] of replacements) {
    if (o.indexOf('/') < 0 && o.length < 6) continue;
    if (text.indexOf(o) >= 0) leftover.push(rel + ' still has ' + o);
  }
}

const finalBad = [];
for (const f of walk(root, [])) {
  const rel = posix(path.relative(root, f));
  if (/[^\x00-\x7F]/.test(rel)) finalBad.push(rel);
  const base = path.posix.basename(rel);
  if (/[A-Z]/.test(base) && allow.indexOf(base) < 0) finalBad.push(rel + ' (uppercase)');
}

console.log('NORMALIZE root=' + root);
console.log('NORMALIZE_RENAMED=' + renamed);
console.log('NORMALIZE_PRUNED_DIRS=' + prunedDirs);
console.log('NORMALIZE_REWRITTEN_FILES=' + rewrittenFiles);
console.log('NORMALIZE_REPLACEMENTS=' + totalRepl);
console.log('NORMALIZE_UNMAPPED=' + unmapped.length);
for (const u of unmapped.slice(0, 20)) console.log('  UNMAPPED ' + u);
console.log('NORMALIZE_LEFTOVER=' + leftover.length);
for (const l of leftover.slice(0, 20)) console.log('  LEFTOVER ' + l);
console.log('NORMALIZE_BADPATHS=' + finalBad.length);
for (const b of finalBad.slice(0, 20)) console.log('  BAD ' + b);
const ok = unmapped.length === 0 && leftover.length === 0 && finalBad.length === 0;
console.log(ok ? 'NORMALIZE_OK=1' : 'NORMALIZE_OK=0');
process.exit(ok ? 0 : 1);
