#!/usr/bin/env node
/*
 * keyevt_recorder.mjs -- RetinaEvent host-side resident logger.
 * Pure Node builtins (http/fs/path), no npm dependencies.
 *
 * Usage:
 *   node tools/keyevt_recorder.mjs --out <abs.csv> [--hz 5] [--minutes 120]
 *
 *每 200ms 依次 GET /api/health 与 /api/stats, 立即追加一行 CSV(行级 flush)。
 * 请求失败时该行照写, http_err=1, 数值列 0, 进程不退出。
 * 到时打印 RECORDER_DONE rows=<n> 并以 0 退出。输出全 ASCII。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ARGV = process.argv.slice(2);
function opt(name, dflt) {
  const i = ARGV.indexOf(name);
  if (i >= 0 && i + 1 < ARGV.length) return ARGV[i + 1];
  return dflt;
}

const OUT = opt('--out', '');
const HZ = Number(opt('--hz', '5'));
const MINUTES = Number(opt('--minutes', '120'));
const HOST = opt('--host', '127.0.0.1');
const PORT = Number(opt('--port', '8787'));

if (!OUT) { console.error('ERR missing --out <abs.csv>'); process.exit(2); }

const hz = (Number.isFinite(HZ) && HZ > 0) ? HZ : 5;
const minutes = (Number.isFinite(MINUTES) && MINUTES > 0) ? MINUTES : 120;
const PERIOD_MS = Math.max(50, Math.round(1000 / hz));
const TOTAL_MS = minutes * 60 * 1000;
const REQ_TIMEOUT_MS = 1500;

const HEADER = [
  't_wall_ms', 'uptime_ms', 'frames_seen', 'fps', 'pps', 'mbps', 'idx_gap', 'aborted',
  'crc_fail', 'bad_magic', 'dup_chunk', 'ev_drop', 'ev_partial', 'seg_inconsistent',
  'ev_count', 'ev_origin', 'age_ms', 'latest_frame_idx', 'http_err'
].join(',');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fd = fs.openSync(OUT, 'a');
fs.writeSync(fd, HEADER + '\n');   // header first, flushed immediately

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : 0; }
function dec(v, d) { const p = Math.pow(10, d); return Math.round(num(v) * p) / p; }
function csvStr(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fetchJson(pathname, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let req = null;
    const finish = (val, err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: !err, val: val, err: err ? String(err) : '' });
    };
    timer = setTimeout(() => { try { if (req) req.destroy(); } catch (e) {} finish(null, 'timeout'); }, timeoutMs);
    req = http.get({ host: HOST, port: PORT, path: pathname, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 2000000) { try { res.destroy(); } catch (e) {} finish(null, 'body-too-big'); }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) { finish(null, 'http' + res.statusCode); return; }
        try { finish(JSON.parse(body)); } catch (e) { finish(null, 'json'); }
      });
      res.on('error', (e) => finish(null, 'res-' + (e && e.code ? e.code : 'err')));
    });
    req.on('error', (e) => finish(null, 'req-' + (e && e.code ? e.code : (e && e.message) || 'err')));
  });
}

let rows = 0;
const T0 = Date.now();
let prevFrames = null;
let prevT = null;

async function sample() {
  const tWall = Date.now();
  const [h, s] = await Promise.all([fetchJson('/api/health', REQ_TIMEOUT_MS), fetchJson('/api/stats', REQ_TIMEOUT_MS)]);
  const httpErr = (h.ok && s.ok) ? 0 : 1;
  const health = h.ok ? (h.val || {}) : {};
  const stats = s.ok ? (s.val || {}) : {};
  const st = stats.stats || {};
  const ct = stats.counters || {};
  const lf = health.latestFrame || {};
  const le = health.latestEvents || {};

  const framesSeen = num(health.framesSeen);
  let fps = 0;
  if (httpErr === 0) {
    if (prevFrames !== null && tWall > prevT && framesSeen >= prevFrames) {
      fps = (framesSeen - prevFrames) * 1000 / (tWall - prevT);
    } else if (num(lf.ageMs) > 0) {
      fps = 1000 / num(lf.ageMs);
    }
  }
  prevFrames = framesSeen;
  prevT = tWall;

  const latestIdx = (stats.lastFrameIdx !== undefined && stats.lastFrameIdx !== null)
    ? num(stats.lastFrameIdx) : num(lf.frameIdx);

  const row = [
    tWall,
    num(health.uptimeMs),
    httpErr ? 0 : framesSeen,
    httpErr ? 0 : dec(fps, 2),
    httpErr ? 0 : Math.round(num(st.pps)),
    httpErr ? 0 : dec(num(st.bps) / 1e6, 3),
    httpErr ? 0 : num(ct.idxGap),
    httpErr ? 0 : num(ct.aborted),
    httpErr ? 0 : num(ct.crcFail),
    httpErr ? 0 : num(ct.badMagic),
    httpErr ? 0 : num(ct.dupChunk),
    httpErr ? 0 : num(ct.evDrop),
    httpErr ? 0 : num(ct.evPartial),
    httpErr ? 0 : num(ct.segInconsistent),
    httpErr ? 0 : num(le.count),
    httpErr ? '' : csvStr(le.origin),
    httpErr ? 0 : num(le.ageMs),
    httpErr ? 0 : latestIdx,
    httpErr
  ];
  fs.writeSync(fd, row.join(',') + '\n');   // row-level flush
  rows++;
}

function finishRun() {
  try { fs.closeSync(fd); } catch (e) {}
  process.stdout.write('RECORDER_DONE rows=' + rows + '\n');
  process.exit(0);
}

function tick() {
  const started = Date.now();
  sample().then(() => {
    if (Date.now() - T0 >= TOTAL_MS) { finishRun(); return; }
    const wait = Math.max(0, PERIOD_MS - (Date.now() - started));
    setTimeout(tick, wait);
  }, () => {
    // sample() must never reject, but keep the loop alive just in case
    if (Date.now() - T0 >= TOTAL_MS) { finishRun(); return; }
    setTimeout(tick, PERIOD_MS);
  });
}

process.on('uncaughtException', (e) => {
  process.stderr.write('RECORDER_WARN uncaught ' + ((e && e.message) || 'err') + '\n');
});

process.stdout.write('RECORDER_START out=' + OUT + ' hz=' + hz + ' periodMs=' + PERIOD_MS +
  ' minutes=' + minutes + ' pid=' + process.pid + '\n');
tick();
