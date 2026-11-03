#!/usr/bin/env node
// 仓库同步后的「库容 / 大文件 / 密钥 / 干净克隆」体检工具（纯 Node，无第三方依赖）。
//
// 目的：给"31 个提交已同步到 GitHub 私有仓 scissorlight/FPGA_comp（远端 tip=ee5cd01）"
// 这件事提供一份可机器判真的证据。判据全部来自 HEAD 里的**已跟踪内容**，
// 不读工作区里未跟踪的构建垃圾。
//
// 机读判据（脚本自己打印，全过退出码 0，否则 1）：
//   REPO_HYGIENE_OK=1
//   TRACKED_FILES=<n>         HEAD 已跟踪条目数
//   TREE_MIB=<x>              HEAD 已跟踪内容总字节折 MiB，要求 <= 800
//   MAX_BLOB_BYTES=<n>        HEAD 可达对象里最大的单个 blob，要求 <= 104857600（100 MB）
//   GEN_TRACKED=<n>           HEAD 中 *.gen/ 路径的已跟踪文件数（只报告，不判死）
//   SECRET_HITS=0             对已跟踪**文本**文件扫密钥特征（git grep -I）
//   CLONE_OK=1                从本地路径干净克隆后 fsck 无错且 HEAD 与源一致
//   CLONE_MIB=<x>             克隆目录实占 MiB（du -sm 口径，缺 du 时用 fs 遍历）
//
// 只读边界：本脚本只调用 git 的读命令（rev-parse / ls-tree / rev-list / cat-file /
// grep / ls-remote / count-objects / status / fsck），以及 git clone —— 克隆目标是
// 临时目录，对源仓库不产生任何写操作。不跑 Vivado / ModelSim / fpgab.bat。
//
// 用法（仓库根）：
//   node report/tools/repo_size_audit.mjs
//   node report/tools/repo_size_audit.mjs --repo E:/workspace/FPGA_Comp
//   可选：--clone-dir <dir>  临时克隆目录，默认 <repo>/temp_test/repo_audit_20261031/clone
//         --keep-clone       保留克隆目录（默认校验完删除）
//         --skip-clone       跳过克隆（开发调试用，此时 CLONE_OK=SKIP，判据必然不过）
//         --skip-remote      跳过 git ls-remote（离线时用）
//
// 退出码：0 全过；1 有判据未过；2 参数/环境错误。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// 判据阈值（与任务板 task-1 一致，改动需同步报告）
// ---------------------------------------------------------------------------
const LIMITS = {
  treeMib: 800,                 // TREE_MIB <= 800
  maxBlobBytes: 104857600,      // 100 MiB
  secretHits: 0
};

// 密钥特征。刻意都用"带长度下限"的精确形态：
//   - 裸 `sk-` 会命中中文正文里的 "task-5"（ta|sk-|5），不能用；
//   - 裸 `AKIA` 会命中 Vivado IP 里 blk_mem_gen 的 base64 存储器初值，不能用。
const SECRET_PATTERNS = [
  'oc_sk_[A-Za-z0-9]{10,}',                        // 本仓库上游用过的 token 前缀
  'sk-[A-Za-z0-9]{20,}',                           // OpenAI 风格
  'ghp_[A-Za-z0-9]{20,}',                          // GitHub PAT (classic)
  'gh[pousr]_[A-Za-z0-9]{36}',                     // GitHub token 全家族
  '\\bAKIA[0-9A-Z]{16}\\b',                        // AWS Access Key ID
  'xox[baprs]-[0-9A-Za-z-]{10,}',                  // Slack
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'             // 私钥块
];

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function usage() {
  console.log('用法: node report/tools/repo_size_audit.mjs [--repo <dir>] [--clone-dir <dir>]');
  console.log('                               [--keep-clone] [--skip-clone] [--skip-remote]');
}

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    cloneDir: null,
    keepClone: false,
    skipClone: false,
    skipRemote: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    if (a === '--repo') { opts.repo = argv[++i]; if (!opts.repo) fail2('--repo 缺少参数'); continue; }
    if (a === '--clone-dir') { opts.cloneDir = argv[++i]; if (!opts.cloneDir) fail2('--clone-dir 缺少参数'); continue; }
    if (a === '--keep-clone') { opts.keepClone = true; continue; }
    if (a === '--skip-clone') { opts.skipClone = true; continue; }
    if (a === '--skip-remote') { opts.skipRemote = true; continue; }
    fail2(`未知参数: ${a}`);
  }
  return opts;
}

function fail2(msg) {
  console.error(`ERROR ${msg}`);
  usage();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 输出助手：所有进度与结果统一走 stdout，保证 log 里顺序与终端完全一致
// ---------------------------------------------------------------------------
const T0 = Date.now();
function step(msg) {
  const s = ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${msg}`);
}
function kv(key, value) {
  console.log(`${key}=${value}`);
}

// ---------------------------------------------------------------------------
// git 调用封装
// ---------------------------------------------------------------------------
const GIT_MAXBUFFER = 512 * 1024 * 1024;

function git(args, { cwd, input, allowFail = false, timeout = 300000 } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
    windowsHide: true,
    timeout
  });
  if (r.error) {
    if (allowFail) return { code: -1, stdout: '', stderr: String(r.error.message || r.error) };
    throw new Error(`git ${args.join(' ')} 启动失败: ${r.error.message}`);
  }
  const out = { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (!allowFail && out.code !== 0) {
    throw new Error(`git ${args.join(' ')} 退出码 ${out.code}: ${out.stderr.trim().slice(0, 500)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 目录体积（字节）。git 仓库里大量小文件，用 fs 遍历比 du 更可复现
// ---------------------------------------------------------------------------
function dirBytes(root) {
  let total = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          total += statSync(p).size;
          files++;
        } catch {
          /* 竞态删除，忽略 */
        }
      }
    }
  }
  return { bytes: total, files };
}

function duMib(path) {
  const r = spawnSync('du', ['-sm', path], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.error || r.status !== 0) return null;
  const m = /^(\d+)/.exec((r.stdout || '').trim());
  return m ? Number(m[1]) : null;
}

const toMib = (bytes) => Number((bytes / 1048576).toFixed(2));

// ---------------------------------------------------------------------------
// 1) 仓库定位与 HEAD
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolve(opts.repo);

  console.log('=== repo_size_audit（仓库同步后库容 / 大文件 / 密钥 / 干净克隆体检）===');
  console.log(`AUDIT_TIME=${new Date().toISOString()}`);
  kv('REPO', repo);

  if (!existsSync(join(repo, '.git'))) {
    console.error(`ERROR ${repo} 下没有 .git，不是 git 仓库根`);
    process.exit(2);
  }

  const headFull = git(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).stdout.trim();
  kv('HEAD', headFull);
  kv('HEAD_SHORT', headFull.slice(0, 7));
  kv('BRANCH', branch);

  const remoteUrl = git(['config', '--get', 'remote.origin.url'], { cwd: repo, allowFail: true });
  kv('REMOTE_ORIGIN_URL', remoteUrl.code === 0 ? remoteUrl.stdout.trim() : '(none)');

  // -------------------------------------------------------------------------
  // 2) HEAD 已跟踪文件与内容体积（git ls-tree -r -l，NUL 分隔以容纳中文/空格路径）
  // -------------------------------------------------------------------------
  step('统计 HEAD 已跟踪文件（git ls-tree -r -l -z）');
  const treeRaw = git(['ls-tree', '-r', '-l', '-z', 'HEAD'], { cwd: repo }).stdout;
  const entries = [];
  for (const chunk of treeRaw.split('\0')) {
    if (!chunk) continue;
    const tab = chunk.indexOf('\t');
    if (tab < 0) continue;
    // 注意：`ls-tree -l` 的 size 字段是右对齐填充的（例如 "100644 blob <sha>    1234"），
    // 按单个空格 split 会产生大量空串，必须按连续空白切分，否则小数文件全部被算成 0 字节。
    const meta = chunk.slice(0, tab).trim().split(/\s+/);
    const path = chunk.slice(tab + 1);
    // meta = [mode, type, object, size]
    if (meta.length < 4) continue;
    const type = meta[1];
    const size = meta[3] === '-' ? 0 : Number(meta[3]);
    entries.push({ mode: meta[0], type, object: meta[2], size, path });
  }

  const blobs = entries.filter((e) => e.type === 'blob');
  const treeBytes = blobs.reduce((s, e) => s + e.size, 0);
  const trackedFiles = entries.length;
  const treeMib = toMib(treeBytes);

  // 最大单文件（就 HEAD 当前内容而言）
  let maxHeadBlob = { size: 0, path: '(none)' };
  for (const e of blobs) if (e.size > maxHeadBlob.size) maxHeadBlob = e;

  // *.gen/ 构建产物（Vivado IP 的 OOC 生成目录，.gitignore 已忽略但历史上被 -f 加入）
  const genTracked = entries.filter((e) => /\.gen\//.test(e.path)).length;

  kv('TRACKED_FILES', trackedFiles);
  kv('TRACKED_BLOBS', blobs.length);
  kv('TREE_BYTES', treeBytes);
  kv('TREE_MIB', treeMib.toFixed(2));
  kv('GEN_TRACKED', genTracked);
  console.log(`# 说明: TRACKED_FILES 含 gitlink(${entries.filter((e) => e.type !== 'blob').length} 个非 blob 条目)`);

  // -------------------------------------------------------------------------
  // 3) 全历史最大 blob（git rev-list --objects + git cat-file --batch-check）
  //    这比"当前内容最大文件"更严格：删掉的大文件仍占 .git 体积。
  // -------------------------------------------------------------------------
  step('扫描 HEAD 可达对象的最大 blob（git rev-list --objects | git cat-file --batch-check）');
  const revRaw = git(['rev-list', '--objects', 'HEAD'], { cwd: repo }).stdout;
  const pathBySha = new Map();
  const shas = [];
  for (const line of revRaw.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) {
      shas.push(line);
    } else {
      const sha = line.slice(0, sp);
      shas.push(sha);
      pathBySha.set(sha, line.slice(sp + 1));
    }
  }

  const bcRaw = git(['cat-file', '--batch-check'], {
    cwd: repo,
    input: shas.join('\n') + '\n',
    timeout: 600000
  }).stdout;

  let maxBlob = { size: 0, sha: '', type: '', path: '(none)' };
  let objectCount = 0;
  let blobCount = 0;
  const allBlobs = [];
  for (const line of bcRaw.split('\n')) {
    if (!line) continue;
    const f = line.split(' ');
    if (f.length < 3) continue;          // "<sha> missing" 之类
    objectCount++;
    if (f[1] !== 'blob') continue;
    blobCount++;
    const size = Number(f[2]);
    const rec = { sha: f[0], size, path: pathBySha.get(f[0]) || '(unknown)' };
    allBlobs.push(rec);
    if (size > maxBlob.size) maxBlob = { ...rec, type: 'blob' };
  }

  kv('OBJECTS_REACHABLE', objectCount);
  kv('BLOBS_REACHABLE', blobCount);
  kv('MAX_BLOB_BYTES', maxBlob.size);
  kv('MAX_BLOB_MIB', toMib(maxBlob.size).toFixed(2));
  kv('MAX_BLOB_SHA', maxBlob.sha || '(none)');
  kv('MAX_BLOB_PATH', maxBlob.path);
  kv('MAX_HEAD_BLOB_BYTES', maxHeadBlob.size);
  kv('MAX_HEAD_BLOB_PATH', maxHeadBlob.path);

  // 前 10 大 blob（供报告里列"最该关注的大文件"）
  allBlobs.sort((a, b) => b.size - a.size);
  allBlobs.slice(0, 10).forEach((b, i) => {
    console.log(`BLOB_TOP${i + 1}=${b.size}\t${toMib(b.size).toFixed(2)}MiB\t${b.path}`);
  });

  // -------------------------------------------------------------------------
  // 4) 密钥扫描（只扫已跟踪的**文本**文件：git grep -I HEAD）
  // -------------------------------------------------------------------------
  step(`密钥特征扫描（git grep -I，${SECRET_PATTERNS.length} 条特征）`);
  const grepArgs = ['grep', '-I', '-n', '--no-color'];
  for (const p of SECRET_PATTERNS) grepArgs.push('-e', p);
  grepArgs.push('HEAD');
  const grepRes = git(grepArgs, { cwd: repo, allowFail: true, timeout: 600000 });

  let secretHits = 0;
  let secretError = '';
  if (grepRes.code === 0) {
    const lines = grepRes.stdout.split('\n').filter((l) => l.trim());
    secretHits = lines.length;
    lines.slice(0, 5).forEach((l) => console.log(`SECRET_HIT_SAMPLE=${l}`));
  } else if (grepRes.code === 1) {
    secretHits = 0;                          // 无匹配，正常
  } else {
    secretError = (grepRes.stderr || '').trim().slice(0, 300);
  }
  kv('SECRET_PATTERNS', SECRET_PATTERNS.length);
  kv('SECRET_HITS', secretError ? 'ERROR' : secretHits);
  if (secretError) kv('SECRET_ERROR', secretError);

  // -------------------------------------------------------------------------
  // 5) 体积旁证：.git 目录体积 + count-objects
  // -------------------------------------------------------------------------
  step('统计 .git 目录体积（git count-objects + fs 遍历）');
  const co = git(['count-objects', '-v'], { cwd: repo, allowFail: true });
  if (co.code === 0) {
    const pack = /size-pack:\s*(\d+)/.exec(co.stdout);
    const loose = /count:\s*(\d+)/.exec(co.stdout);
    const inPack = /in-pack:\s*(\d+)/.exec(co.stdout);
    if (pack) kv('GIT_PACK_MIB', toMib(Number(pack[1]) * 1024).toFixed(2));
    if (loose) kv('GIT_LOOSE_OBJECTS', loose[1]);
    if (inPack) kv('GIT_IN_PACK_OBJECTS', inPack[1]);
  }
  const gitDirInfo = dirBytes(join(repo, '.git'));
  kv('GIT_DIR_BYTES', gitDirInfo.bytes);
  kv('GIT_DIR_MIB', toMib(gitDirInfo.bytes).toFixed(2));
  kv('GIT_DIR_FILES', gitDirInfo.files);

  // -------------------------------------------------------------------------
  // 6) 远端实测（git ls-remote origin main）——只读网络操作
  // -------------------------------------------------------------------------
  let remoteMain = '(skipped)';
  let remoteMatch = 'SKIP';
  if (!opts.skipRemote) {
    step('git ls-remote origin main（只读，验证远端 tip）');
    const lr = git(['ls-remote', 'origin', 'main'], { cwd: repo, allowFail: true, timeout: 120000 });
    if (lr.code === 0) {
      const line = lr.stdout.split('\n').find((l) => l.trim());
      if (line) {
        const parts = line.trim().split(/\s+/);
        remoteMain = parts[0];
        remoteMatch = parts[0] === headFull ? '1' : '0';
      } else {
        remoteMain = '(branch main 在远端不存在)';
        remoteMatch = '0';
      }
    } else {
      remoteMain = `(ERR: ${(lr.stderr || '').trim().split('\n')[0].slice(0, 200)})`;
      remoteMatch = 'ERR';
    }
    kv('REMOTE_MAIN', remoteMain);
    kv('REMOTE_MAIN_MATCH', remoteMatch);
  }

  // -------------------------------------------------------------------------
  // 7) 工作区状态（只报告：本次体检不改任何已跟踪文件）
  // -------------------------------------------------------------------------
  const status = git(['status', '--porcelain'], { cwd: repo, allowFail: true });
  if (status.code === 0) {
    const lines = status.stdout.split('\n').filter((l) => l.trim());
    const dirtyTracked = lines.filter((l) => !l.startsWith('??')).length;
    const untracked = lines.filter((l) => l.startsWith('??')).length;
    kv('WORKTREE_DIRTY_TRACKED', dirtyTracked);
    kv('WORKTREE_UNTRACKED', untracked);
  }

  // -------------------------------------------------------------------------
  // 8) 队友视角的干净克隆（git clone --no-hardlinks 本地路径，不走外网）
  // -------------------------------------------------------------------------
  let cloneOk = 'SKIP';
  let cloneMib = 'SKIP';
  let cloneBytes = 0;
  let cloneFiles = 0;
  let duCloneMib = null;
  let cloneSeconds = 0;
  let cloneErr = '';

  if (!opts.skipClone) {
    const cloneDir = resolve(
      opts.cloneDir || join(repo, 'temp_test', 'repo_audit_20261031', 'clone')
    );
    kv('CLONE_DIR', cloneDir);

    if (existsSync(cloneDir)) {
      step('清理上一次的克隆目录');
      rmSync(cloneDir, { recursive: true, force: true });
    }

    step('git clone --no-hardlinks（本地路径克隆，模拟队友 clone 后的视角）');
    const cloneT0 = Date.now();
    const cloneRes = spawnSync('git', ['clone', '--no-hardlinks', '--quiet', repo, cloneDir], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      windowsHide: true,
      timeout: 1800000
    });
    cloneSeconds = Number(((Date.now() - cloneT0) / 1000).toFixed(1));

    if (cloneRes.error || cloneRes.status !== 0) {
      cloneErr = String(cloneRes.error?.message || cloneRes.stderr || '').trim().slice(0, 400);
      cloneOk = '0';
    } else {
      kv('CLONE_SECONDS', cloneSeconds);

      // 8.1 HEAD 必须与源一致
      const cHead = git(['rev-parse', 'HEAD'], { cwd: cloneDir, allowFail: true });
      const cHeadSha = cHead.code === 0 ? cHead.stdout.trim() : '(ERR)';
      kv('CLONE_HEAD', cHeadSha);
      kv('CLONE_HEAD_MATCH', cHeadSha === headFull ? '1' : '0');

      // 8.2 已跟踪文件数必须一致（队友能看到的文件目录树完整）
      const cTree = git(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: cloneDir, allowFail: true });
      const cTreeCount = cTree.code === 0
        ? cTree.stdout.split('\n').filter((l) => l).length
        : -1;
      kv('CLONE_TRACKED_FILES', cTreeCount);

      // 8.3 fsck 无错误
      const fsck = git(['fsck', '--no-progress'], { cwd: cloneDir, allowFail: true, timeout: 900000 });
      const fsckOut = ((fsck.stdout || '') + (fsck.stderr || '')).trim();
      const fsckBad = fsckOut
        .split('\n')
        .filter((l) => /^(error|fatal|missing)/i.test(l.trim())).length;
      kv('CLONE_FSCK_EXIT', fsck.code);
      kv('CLONE_FSCK_TROUBLE_LINES', fsckBad);
      if (fsckOut) fsckOut.split('\n').slice(0, 5).forEach((l) => console.log(`CLONE_FSCK_LINE=${l}`));

      // 8.4 体积
      const info = dirBytes(cloneDir);
      cloneBytes = info.bytes;
      cloneFiles = info.files;
      duCloneMib = duMib(cloneDir);
      cloneMib = duCloneMib != null ? duCloneMib : toMib(cloneBytes);
      kv('CLONE_BYTES', cloneBytes);
      kv('CLONE_MIB', cloneMib);
      kv('CLONE_FILES_ON_DISK', cloneFiles);
      if (duCloneMib != null) kv('DU_CLONE_MIB', duCloneMib);

      const pass = cHeadSha === headFull && cTreeCount === trackedFiles && fsckBad === 0;
      if (!pass) {
        cloneErr = `HEAD匹配=${cHeadSha === headFull} 文件数匹配=${cTreeCount === trackedFiles} fsck问题行=${fsckBad}`;
      }
      cloneOk = pass ? '1' : '0';

      // 8.5 默认清理克隆目录（证据留在 log 里，不留在磁盘上）
      if (opts.keepClone) {
        step('--keep-clone：保留克隆目录');
      } else {
        step('删除临时克隆目录（--keep-clone 可保留）');
        rmSync(cloneDir, { recursive: true, force: true });
        kv('CLONE_DIR_REMOVED', existsSync(cloneDir) ? '0' : '1');
      }
    }
    if (cloneErr) kv('CLONE_ERROR', cloneErr);
  } else {
    step('--skip-clone：跳过克隆验收');
  }

  // -------------------------------------------------------------------------
  // 9) 判据汇总
  // -------------------------------------------------------------------------
  const checks = [
    // value 用与机器行完全一致的格式化字符串，便于 log 里逐字比对
    { name: 'TREE_MIB', value: treeMib.toFixed(2), rule: `<= ${LIMITS.treeMib}`, pass: treeMib <= LIMITS.treeMib },
    { name: 'MAX_BLOB_BYTES', value: maxBlob.size, rule: `<= ${LIMITS.maxBlobBytes}`, pass: maxBlob.size <= LIMITS.maxBlobBytes },
    { name: 'SECRET_HITS', value: secretError ? 'ERROR' : secretHits, rule: '= 0', pass: !secretError && secretHits === LIMITS.secretHits },
    { name: 'CLONE_OK', value: cloneOk, rule: '= 1', pass: cloneOk === '1' }
  ];
  const allPass = checks.every((c) => c.pass);

  console.log('');
  console.log('=== 判据核对 ===');
  for (const c of checks) {
    console.log(`CHECK ${c.name}=${c.value}  (${c.rule})  ${c.pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(`# GEN_TRACKED=${genTracked}（只报告，不参与判定；Vivado IP 的 .gen/ 生成产物）`);

  console.log('');
  console.log('=== 机读结果 ===');
  kv('TRACKED_FILES', trackedFiles);
  kv('TREE_MIB', treeMib.toFixed(2));
  kv('MAX_BLOB_BYTES', maxBlob.size);
  kv('GEN_TRACKED', genTracked);
  kv('SECRET_HITS', secretError ? 'ERROR' : secretHits);
  kv('CLONE_OK', cloneOk);
  kv('CLONE_MIB', cloneMib);
  kv('GIT_DIR_MIB', toMib(gitDirInfo.bytes).toFixed(2));
  kv('AUDIT_SECONDS', Number(((Date.now() - T0) / 1000).toFixed(1)));
  kv('REPO_HYGIENE_OK', allPass ? 1 : 0);

  process.exit(allPass ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`FATAL ${err && err.message ? err.message : err}`);
  kv('REPO_HYGIENE_OK', 0);
  process.exit(2);
}
