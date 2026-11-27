#!/usr/bin/env node
/** Process-tree telemetry only; never substitute profiling success for the child's verdict. */
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const INTERVAL_MS = 500, MAX_ENTRIES = 65536, MAX_BYTES = 65536;
const transient = e => ['ENOENT', 'ESRCH', 'EACCES'].includes(e.code);
const fail = message => { throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
const integer = raw => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : fail('invalid stat integer');

export function parseStat(raw) {
  const end = raw.lastIndexOf(')'), prefix = raw.slice(0, raw.indexOf('(')).trim();
  if (end < 0 || !/^\d+$/.test(prefix)) fail('invalid stat');
  const f = raw.slice(end + 1).trim().split(/\s+/);
  if (f.length < 20 || !/^[A-Za-z]$/.test(f[0])) fail('invalid stat fields');
  return { pid: integer(prefix), state: f[0], ppid: integer(f[1]), user: integer(f[11]), system: integer(f[12]),
    childUser: integer(f[13]), childSystem: integer(f[14]), start: integer(f[19]) };
}

function readStat(io, path) {
  const raw = io.readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > MAX_BYTES) fail('proc file bound exceeded');
  return parseStat(raw);
}

export function reapedCpuSeconds(before, after, ticks) {
  const delta = after.childUser + after.childSystem - before.childUser - before.childSystem;
  if (!Number.isFinite(ticks) || ticks <= 0 || delta < 0) fail('invalid CPU accounting');
  return delta / ticks;
}

export function createSampler({ procRoot, rootPid, fs: io = fs }) {
  const known = new Map(); let rootIdentity, peakTree = 0, peakProc = 0;
  const key = p => `${p.pid}:${p.start}`;
  return {
    poll(final = false) {
      const entries = io.readdirSync(procRoot);
      if (entries.length > MAX_ENTRIES) fail('process listing bound exceeded');
      const current = new Map();
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        try { const p = readStat(io, join(procRoot, name, 'stat')); if (String(p.pid) !== name) fail('pid mismatch'); current.set(p.pid, p); }
        catch (e) { if (!transient(e)) throw e; }
      }
      const root = current.get(rootPid);
      if (root && rootIdentity === undefined) rootIdentity = key(root);
      // Parent adjacency traverses each process once; no unbounded ancestry walks.
      const children = new Map();
      for (const p of current.values()) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
      const tree = new Set(), queue = root && key(root) === rootIdentity ? [root] : [];
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i]; if (tree.has(p.pid)) continue; tree.add(p.pid);
        for (const child of children.get(p.pid) ?? []) queue.push(child);
      }
      // Previously discovered orphans remain observable after leaving the current tree.
      for (const p of current.values()) {
        const id = key(p), previous = known.get(id);
        if (tree.has(p.pid)) known.set(id, { ...p, orphan: previous?.orphan ?? false });
        else if (previous) known.set(id, { ...p, orphan: true });
        if (final && p.pid !== rootPid && known.has(id)) known.get(id).orphan = true;
      }
      let sum = 0;
      for (const pid of tree) {
        try {
          if (current.get(pid).state === 'Z') continue;
          const raw = io.readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
          if (Buffer.byteLength(raw) > MAX_BYTES) fail('proc status bound exceeded');
          // A process can exit between stat and status. Confirm identity and state
          // before treating absent memory fields as corrupt evidence.
          const afterStatus = readStat(io, join(procRoot, String(pid), 'stat'));
          if (key(afterStatus) !== key(current.get(pid)) || afterStatus.state === 'Z') continue;
          const rss = raw.match(/^VmRSS:\s+(\d+) kB\s*$/m), hwm = raw.match(/^VmHWM:\s+(\d+) kB\s*$/m);
          if (!rss || !hwm) fail('missing RSS evidence');
          sum += integer(rss[1]); peakProc = Math.max(peakProc, integer(hwm[1]));
        } catch (e) { if (!transient(e)) throw e; }
      }
      peakTree = Math.max(peakTree, sum);
    },
    result(ticks) {
      if (rootIdentity === undefined) fail('missing root observation; rerun profile');
      let orphanTicks = 0;
      for (const p of known.values()) if (p.orphan && p.pid !== rootPid) orphanTicks += p.user + p.system;
      return { peakTreeRssMb: Math.floor(peakTree / 1024), peakProcRssMb: Math.floor(peakProc / 1024), orphanCpuSecLowerBound: orphanTicks / ticks };
    },
  };
}

export function appendRecord(path, record, io = fs) {
  const fd = io.openSync(path, 'a+');
  try {
    const size = io.fstatSync(fd).size, last = Buffer.alloc(1);
    if (size && io.readSync(fd, last, 0, 1, size - 1) !== 1) fail('cannot read last record byte');
    const data = Buffer.from(`${size && last[0] !== 10 ? '\n' : ''}${JSON.stringify(record)}\n`);
    for (let offset = 0; offset < data.length;) {
      const written = io.writeSync(fd, data.subarray(offset));
      if (!Number.isInteger(written) || written <= 0 || written > data.length - offset) fail('invalid record write');
      offset += written;
    }
  } finally { io.closeSync(fd); }
}

export function summarize(dir, io = fs) {
  const files = [], pending = [[dir, 0]]; let entriesSeen = 0;
  while (pending.length) {
    const [path, depth] = pending.pop();
    if (depth > 64) fail('summary depth bound exceeded; split artifacts');
    if (io.lstatSync(path).isSymbolicLink()) fail('summary symlink refused');
    for (const entry of io.readdirSync(path, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (++entriesSeen > MAX_ENTRIES) fail('summary entry bound exceeded; split artifacts');
      const name = join(path, entry.name);
      if (entry.isSymbolicLink()) fail('summary symlink refused');
      if (entry.isDirectory()) pending.push([name, depth + 1]);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(name);
    }
  }
  const rows = [], identities = new Set(); let skipped = 0, lines = 0;
  for (const file of files.sort(compare)) {
    if (io.statSync(file).size > 64 * 1024 * 1024) fail('summary file bound exceeded; split artifacts');
    const raw = io.readFileSync(file, 'utf8'), parts = raw.split('\n');
    if (parts.at(-1) === '') parts.pop();
    for (const line of parts) {
      if (++lines > 100000) fail('summary line count bound exceeded; split artifacts');
      let row;
      try { if (Buffer.byteLength(line) > MAX_BYTES) throw Error('line bound'); row = JSON.parse(line); }
      catch { skipped++; continue; }
      if (!row || row.v !== 1 || typeof row.job !== 'string' || !row.job.trim() || Object.hasOwn(row, 'error')
        || !['peakTreeRssMb', 'cpuSec', 'samplerCpuSec', 'wallSec', 'exitCode'].every(k => typeof row[k] === 'number' && Number.isFinite(row[k]))
        || ['peakTreeRssMb', 'cpuSec', 'samplerCpuSec', 'wallSec'].some(k => row[k] < 0)
        || ['runner', 'at'].some(k => row[k] !== undefined && typeof row[k] !== 'string')) { skipped++; continue; }
      row = { ...row, runner: row.runner ?? '', at: row.at ?? '' };
      const id = JSON.stringify([row.job, row.runner, row.at]);
      if (identities.has(id)) continue;
      identities.add(id); rows.push(row);
    }
  }
  if (!lines) return 'no records\n';
  if (!rows.length) return `no valid records (skipped: ${skipped})\n`;
  rows.sort((a, b) => compare(a.job, b.job) || compare(a.at, b.at) || compare(a.runner, b.runner));
  const output = ['job\trunner\tat\tpeakTreeRssMb\tcpuSec\tavgThreads\tsamplerCpuSec/wallSec\texitCode'];
  for (const r of rows) output.push([r.job, r.runner, r.at, r.peakTreeRssMb, r.cpuSec,
    r.wallSec === 0 ? 'null' : r.cpuSec / r.wallSec, r.wallSec === 0 ? 'null' : r.samplerCpuSec / r.wallSec, r.exitCode].map(text).join('\t'));
  const peaks = rows.filter(r => r.exitCode === 0).map(r => r.peakTreeRssMb).sort((a, b) => a - b);
  output.push(`records: ${rows.length}`, `jobs: ${new Set(rows.map(r => r.job)).size}`, `skipped: ${skipped}`,
    `p90 peakTreeRssMb: ${peaks.length ? peaks[Math.ceil(0.9 * peaks.length) - 1] : 'n/a'}`);
  return `${output.join('\n')}\n`;
}

function argumentsFor(args) {
  if (!Array.isArray(args)) fail('invalid arguments');
  if (args[0] === '--summary') {
    if (args.length !== 2 || !args[1]) fail('expected --summary <dir>');
    return { summary: args[1] };
  }
  const split = args.indexOf('--');
  if (split < 0 || !args[split + 1]) fail('expected -- <command>');
  const options = { out: 'job-profile.jsonl', 'proc-root': '/proc' }, seen = new Set();
  for (const arg of args.slice(0, split)) {
    const match = /^--(job|out|proc-root)=(.+)$/.exec(arg);
    if (!match || seen.has(match[1])) fail('invalid option');
    seen.add(match[1]); options[match[1]] = match[2];
  }
  if (!options.job?.trim()) fail('expected --job=<label>');
  return { ...options, command: args[split + 1], argv: args.slice(split + 2) };
}

export async function runProfile(args, injected = {}) {
  const d = { fs, env: process.env, cwd: process.cwd(), now: () => performance.now(), at: () => new Date().toISOString(),
    signals: process, spawn, setInterval, clearInterval, setTimeout, clearTimeout,
    stderr: s => process.stderr.write(s), stdout: s => process.stdout.write(s),
    getClockTicks: () => {
      const raw = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 }).trim();
      if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) fail('invalid CLK_TCK');
      return Number(raw);
    }, ...injected };
  const report = (phase, e) => d.stderr(`job-profile: ${phase} failed ${text(e.code ?? 'ERR')}\n`);
  let options, grace = 30000;
  try {
    options = argumentsFor(args);
    if (options.summary) { d.stdout(summarize(resolve(d.cwd, options.summary), d.fs)); return 0; }
    if (d.env.JOB_PROFILE_GRACE_MS !== undefined) {
      const raw = d.env.JOB_PROFILE_GRACE_MS;
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 30000) fail('invalid grace');
      grace = Number(raw); d.stderr(`job-profile: graceMs=${grace} source=env JOB_PROFILE_GRACE_MS\n`);
    }
  } catch (e) { report(options?.summary ? 'summary' : 'arguments', e); return 2; }
  const procRoot = resolve(d.cwd, options['proc-root']), selfPath = join(procRoot, 'self/stat'), errors = [];
  const telemetryError = (phase, e) => { report(phase, e); errors.push(`${phase}:${text(e.code ?? 'ERR')}`); };
  let profile = true, before, ticks, sampler;
  try { d.fs.statSync(selfPath); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { profile = false; d.stderr('job-profile: no /proc, skipped\n'); } else telemetryError('proc', e); }
  if (profile) {
    try { ticks = d.getClockTicks(); if (!Number.isSafeInteger(ticks) || ticks <= 0) fail('invalid CLK_TCK'); }
    catch (e) { telemetryError('clock', e); }
    try { before = readStat(d.fs, selfPath); } catch (e) { telemetryError('baseline', e); }
  }
  const start = d.now(); let child;
  try { child = d.spawn(options.command, options.argv, { cwd: d.cwd, env: d.env, stdio: 'inherit' }); }
  catch (e) { report('spawn', e); return 127; }
  return await new Promise(resolveVerdict => {
    let finished = false, interval, graceTimer, firstSignal;
    if (profile) sampler = createSampler({ procRoot, rootPid: child.pid, fs: d.fs });
    const poll = final => { if (sampler) try { sampler.poll(final); } catch (e) { telemetryError('sample', e); sampler = null; } };
    const handlers = {};
    const finish = (code, signal, spawnError) => {
      if (finished) return; finished = true;
      d.clearInterval(interval); d.clearTimeout(graceTimer);
      for (const [name, handler] of Object.entries(handlers)) d.signals.removeListener(name, handler);
      if (spawnError) { report('spawn', spawnError); resolveVerdict(127); return; }
      const exitCode = signal ? 128 + constants.signals[signal] : code;
      poll(true);
      const wallSec = (d.now() - start) / 1000;
      if (profile) {
        let reapedCpuSec, samplerCpuSec, measured;
        try {
          const after = readStat(d.fs, selfPath);
          if (!before || !ticks) fail('missing accounting');
          reapedCpuSec = reapedCpuSeconds(before, after, ticks);
          samplerCpuSec = (after.user + after.system - before.user - before.system) / ticks;
          if (samplerCpuSec < 0) fail('invalid sampler CPU');
          measured = sampler?.result(ticks);
        } catch (e) { telemetryError('accounting', e); }
        const failed = errors.length > 0, cpuSec = failed ? null : reapedCpuSec + measured.orphanCpuSecLowerBound;
        const record = { v: 1, repo: d.env.GITHUB_REPOSITORY ?? '', workflow: d.env.GITHUB_WORKFLOW ?? '', job: options.job,
          runner: d.env.RUNNER_NAME ?? '', intervalMs: INTERVAL_MS, peakTreeRssMb: failed ? null : measured.peakTreeRssMb,
          peakProcRssMb: failed ? null : measured.peakProcRssMb, cpuSec, reapedCpuSec: failed ? null : reapedCpuSec,
          orphanCpuSecLowerBound: failed ? null : measured.orphanCpuSecLowerBound, samplerCpuSec: failed ? null : samplerCpuSec,
          wallSec, avgThreads: failed || wallSec === 0 ? null : cpuSec / wallSec, exitCode, at: d.at(),
          ...(failed ? { error: errors.join(',') } : {}) };
        try { appendRecord(resolve(d.cwd, options.out), record, d.fs); } catch (e) { report('write', e); }
      }
      resolveVerdict(exitCode);
    };
    child.once('error', e => finish(null, null, e)); child.once('exit', (code, signal) => finish(code, signal));
    for (const name of ['SIGINT', 'SIGTERM']) {
      handlers[name] = () => {
        if (!firstSignal) {
          firstSignal = name;
          graceTimer = d.setTimeout(() => {
            try { if (!child.kill('SIGKILL')) fail('root kill refused'); } catch (e) { telemetryError('signal', e); }
            finish(null, firstSignal);
          }, grace);
        }
        try { if (!child.kill(name)) fail('root signal refused'); } catch (e) { telemetryError('signal', e); }
      };
      d.signals.on(name, handlers[name]);
    }
    poll(false); interval = d.setInterval(() => poll(false), INTERVAL_MS);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runProfile(process.argv.slice(2));
}
