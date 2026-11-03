// Purpose: DEBUG-ONLY, log-only timing + contention capture for the red-main freeze read (R510). Changes no behaviour:
// the wrapped git call returns/throws exactly what it would have; every logging step is inside try/catch.
// Exports: formatTimingLine, summarizeTrace2, summarizePackets, contentionSnapshot, instrumentGit, TIMING_LOG
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';

export const TIMING_LOG = process.env.WE_FREEZE_READ_TIMING_LOG || join(homedir(), '.claude', 'freeze-read-timing.log');
const LOG_CAP_BYTES = 2 * 1024 * 1024;

/** One log line: `freeze-read-timing {json}`. Pure. */
export function formatTimingLine(rec) { return `freeze-read-timing ${JSON.stringify(rec)}`; }

/** trace2 event stream (JSON lines) -> child-process spans in ms. Pure. */
export function summarizeTrace2(text) {
  const starts = new Map(); const spans = [];
  for (const l of String(text).split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.event === 'child_start') starts.set(e.child_id, { argv: (e.argv || []).slice(0, 2).join(' '), t: e.t_abs });
    else if (e.event === 'child_exit' && starts.has(e.child_id)) { const s = starts.get(e.child_id); spans.push({ child: s.argv, ms: Math.round((e.t_rel != null && s.t != null ? e.t_abs - s.t : 0) * 1000) }); }
  }
  return spans;
}

/** GIT_TRACE_PACKET text -> ms offsets from `startMs` (ms since midnight) or the first line. Pure. */
export function summarizePackets(text, startMs = null) {
  const ts = []; let want = null; let pack = null;
  for (const l of String(text).split('\n')) {
    const m = /^(\d\d):(\d\d):(\d\d)\.(\d+) /.exec(l); if (!m) continue;
    const t = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Number(`0.${m[4]}`) * 1000;
    ts.push(t);
    if (want == null && /fetch> want /.test(l)) want = t;
    if (pack == null && /fetch< packfile/.test(l)) pack = t;
  }
  if (!ts.length) return { packets: 0 };
  const base = startMs ?? ts[0]; const r = (v) => (v == null ? null : Math.round(v - base));
  return { packets: ts.length, firstPacketMs: r(ts[0]), wantMs: r(want), packfileMs: r(pack), lastPacketMs: r(ts[ts.length - 1]) };
}

/** Load + git-process context for the clone `cwd`. Best effort; never throws. */
export function contentionSnapshot(cwd, { exec = execFileSync } = {}) {
  const snap = { load: loadavg().map((n) => +n.toFixed(2)) };
  try {
    const ps = exec('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n');
    const git = ps.filter((l) => /(^|[\s/])git(\s|$)|git-(remote|upload|pack|index|unpack)/.test(l));
    snap.gitProcs = git.length;
    snap.heavyGit = git.filter((l) => /\b(gc|repack|pack-objects|maintenance|index-pack|prune|fsck)\b/.test(l)).map((l) => l.trim().slice(0, 140)).slice(0, 5);
    snap.fetchProcs = git.filter((l) => /\b(fetch|clone|pull)\b/.test(l)).length;
  } catch (e) { snap.psError = String(e?.message || e).slice(0, 80); }
  try {
    const dir = join(cwd, '.git'); const locks = [];
    const walk = (d, depth) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.name.endsWith('.lock') || n.name === 'gc.pid' || n.name.startsWith('tmp_pack_') || n.name.startsWith('tmp_idx_')) locks.push(p.slice(dir.length + 1)); else if (n.isDirectory() && depth < 2 && ['refs', 'objects', 'pack', 'remotes', 'origin'].includes(n.name)) walk(p, depth + 1); } };
    walk(dir, 0); snap.locks = locks.slice(0, 8);
  } catch { /* not a clone dir */ }
  return snap;
}

function appendLog(line, file = TIMING_LOG) {
  try { if (existsSync(file) && statSync(file).size > LOG_CAP_BYTES) renameSync(file, `${file}.1`); } catch { /* ignore */ }
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

/**
 * Wrap a git runner (args, opts) -> string. Only a `fetch` gets trace env (scoped to that one child via opts.env). Same
 * result/throw as `run`. Logs every fetch, plus any call that fails or exceeds `slowMs`.
 */
export function instrumentGit(run, { label = 'freeze-read', slowMs = 5000, log = appendLog } = {}) {
  return (args, opts = {}) => {
    let tdir = null; let runOpts = opts; let pre = null;
    const t0 = Date.now(); const d0 = new Date(); const startClock = ((d0.getHours() * 60 + d0.getMinutes()) * 60 + d0.getSeconds()) * 1000 + d0.getMilliseconds();
    try {
      pre = contentionSnapshot(opts.cwd);
      if (args[0] === 'fetch') {
        tdir = mkdtempSync(join(tmpdir(), 'freeze-trace-'));
        runOpts = { ...opts, env: { ...(opts.env || process.env), GIT_TRACE2_EVENT: join(tdir, 't2'), GIT_TRACE_PACKET: join(tdir, 'pkt') } };
      }
    } catch { runOpts = opts; }
    let err = null;
    try { return run(args, runOpts); } catch (e) { err = e; throw e; }
    finally {
      try {
        const ms = Date.now() - t0;
        if (args[0] === 'fetch' || err || ms > slowMs) {
          const rec = { label, cmd: String(args[0]), ms, ok: !err, err: err ? String(err.code || err.signal || err.message).slice(0, 60) : null, pre };
          if (tdir) {
            const rd = (f) => { try { return readFileSync(join(tdir, f), 'utf8'); } catch { return ''; } };
            rec.children = summarizeTrace2(rd('t2')); rec.packets = summarizePackets(rd('pkt'), startClock);
          }
          try { rec.post = contentionSnapshot(opts.cwd); } catch { /* ignore */ }
          log(formatTimingLine(rec));
        }
      } catch { /* log-only: never affects the call */ }
      if (tdir) try { rmSync(tdir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}
