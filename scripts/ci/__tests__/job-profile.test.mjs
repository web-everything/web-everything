// @vitest-environment node
// All process snapshots, clocks, signals and child handles are fixture-owned. No host /proc reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let api;
const roots = [];
const temp = () => { const dir = fs.mkdtempSync(join(tmpdir(), 'job-profile-')); roots.push(dir); return dir; };
beforeEach(async () => { api = await import('../job-profile.mjs'); });
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const error = code => Object.assign(new Error(code), { code });

function stat(pid, { ppid = 1, name = 'node', state = 'S', user = 0, system = 0, childUser = 0, childSystem = 0, start = 10 } = {}) {
  const fields = Array(50).fill('0');
  Object.assign(fields, { 0: state, 1: String(ppid), 11: String(user), 12: String(system),
    13: String(childUser), 14: String(childSystem), 19: String(start) });
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}
function processFile(root, pid, values = {}) {
  const dir = join(root, String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'stat'), stat(pid === 'self' ? 99 : pid, values));
  fs.writeFileSync(join(dir, 'status'), `Name:\tnode\nVmRSS:\t${(values.rss ?? 10) * 1024} kB\nVmHWM:\t${(values.hwm ?? values.rss ?? 10) * 1024} kB\n`);
}
function sampler(root, io = fs) { return api.createSampler({ procRoot: root, rootPid: 100, fs: io }); }

function harness({ code = 0, signal = null, noProc = false, env = {}, onSpawn, onKill, io = fs } = {}) {
  const dir = temp(), proc = join(dir, 'proc'); fs.mkdirSync(proc);
  if (!noProc) processFile(proc, 'self', { childUser: 100, childSystem: 50, user: 20 });
  const child = new EventEmitter(); child.pid = 100;
  const signals = new EventEmitter(), intervals = new Set(), timeouts = new Set();
  let now = 0, stderr = '', stdout = '';
  child.kill = vi.fn(s => { onKill?.(s, child); return true; });
  const deps = {
    fs: io, env: { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_WORKFLOW: 'Fixture CI', RUNNER_NAME: 'fixture-runner', ...env },
    cwd: dir, now: () => now, at: () => '2026-11-27T14:00:00.000Z', signals,
    stderr: s => { stderr += s; }, stdout: s => { stdout += s; },
    getClockTicks: vi.fn(() => 100),
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn),
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timeouts.add(timer); return timer; }, clearTimeout: timer => timeouts.delete(timer),
    spawn: vi.fn(() => { processFile(proc, 100); onSpawn?.(proc); return child; }),
  };
  const out = join(dir, 'profile.jsonl');
  return { dir, proc, out, deps, child, signals, intervals, timeouts,
    start: (args = []) => api.runProfile(['--job=test-shard (2)', `--out=${out}`, `--proc-root=${proc}`, ...args, '--', 'fixture-command', '--token=t0k3n'], deps),
    tick: (ms = 500) => { now += ms; for (const fn of intervals) fn(); },
    finish: () => { now += 100; child.emit('exit', code, signal); },
    stderr: () => stderr, stdout: () => stdout,
    record: () => JSON.parse(fs.readFileSync(out, 'utf8').trim()),
  };
}

describe('process tree sampler', () => {
  it('sums RSS across the process tree', () => {
    // Three simultaneous 100 MiB grandchildren, compared to the identical zero-allocation tree.
    const measure = allocation => {
      const root = temp(); processFile(root, 100); processFile(root, 101, { ppid: 100 });
      for (const pid of [102, 103, 104]) processFile(root, pid, { ppid: 101, rss: 10 + allocation });
      const s = sampler(root); for (let i = 0; i < 4; i++) s.poll(); return s.result(100);
    };
    const baseline = measure(0), loaded = measure(100);
    expect(loaded.peakTreeRssMb - baseline.peakTreeRssMb).toBeGreaterThanOrEqual(270);
    expect(loaded.peakTreeRssMb - baseline.peakTreeRssMb).toBeLessThanOrEqual(330);
    expect(loaded.peakProcRssMb).toBeLessThan(baseline.peakProcRssMb + 150);
  });
  it('parses names after the last closing parenthesis and stat accounting fields', () => {
    expect(api.parseStat(stat(100, { name: '(a b) (c)', ppid: 7, user: 12, system: 8, childUser: 15, childSystem: 5, start: 99 })))
      .toMatchObject({ pid: 100, ppid: 7, user: 12, system: 8, childUser: 15, childSystem: 5, start: 99 });
  });
  it.each(['ENOENT', 'ESRCH', 'EACCES'])('skips a pid with %s between listing and reading', code => {
    const root = temp(); processFile(root, 100, { rss: 20 }); processFile(root, 101, { ppid: 100 });
    const s = sampler(root, { ...fs, readFileSync: (path, ...args) => {
      if (String(path).includes('/101/')) throw error(code); return fs.readFileSync(path, ...args);
    } });
    s.poll(); expect(s.result(100).peakTreeRssMb).toBe(20);
  });
  it('does not merge a reused pid into the old descendant identity', () => {
    const root = temp(); processFile(root, 100); processFile(root, 101, { ppid: 100, user: 100, start: 1 });
    const s = sampler(root); s.poll();
    processFile(root, 101, { ppid: 1, user: 900, rss: 1000, start: 2 }); s.poll(true);
    expect(s.result(100)).toMatchObject({ peakTreeRssMb: 20, orphanCpuSecLowerBound: 0 });
  });
  it('excludes a reaped helper from the CPU baseline', () => {
    const baseline = api.parseStat(stat(99, { childUser: 100, childSystem: 50 }));
    const end = api.parseStat(stat(99, { childUser: 300, childSystem: 50 }));
    expect(api.reapedCpuSeconds(baseline, end, 100)).toBe(2);
  });
  it('counts an observed orphan outside the root tree using only its last self CPU', () => {
    const root = temp(); processFile(root, 100); processFile(root, 101, { ppid: 100 });
    processFile(root, 102, { ppid: 101, user: 25 });
    const s = sampler(root); s.poll(); fs.rmSync(join(root, '101'), { recursive: true });
    processFile(root, 102, { ppid: 1, user: 150 }); s.poll();
    expect(s.result(100).orphanCpuSecLowerBound).toBe(1.5);
  });
  it('finds descendants in unordered snapshots and counts still-living children at root exit', () => {
    const root = temp(); processFile(root, 100); processFile(root, 2, { ppid: 100 }); processFile(root, 1, { ppid: 2, user: 110 });
    const s = sampler(root); s.poll(); fs.rmSync(join(root, '100'), { recursive: true }); s.poll(true);
    expect(s.result(100).orphanCpuSecLowerBound).toBe(1.1);
  });
  it.each(['broken', stat(100).replace(' S ', ' S -1 '), stat(100).replace(' S ', ' S NaN ')])('rejects malformed stat input', raw => {
    expect(() => api.parseStat(raw)).toThrow();
  });
  it('rejects missing RSS evidence instead of reporting a zero sample', () => {
    const root = temp(); processFile(root, 100); fs.writeFileSync(join(root, '100/status'), 'Name: node\n');
    expect(() => sampler(root).poll()).toThrow();
  });
  it('rejects an oversized process listing with a named bound', () => {
    expect(() => sampler(temp(), { ...fs, readdirSync: () => Array(65537).fill('100') }).poll()).toThrow(/bound/);
  });
});

describe('command contract', () => {
  it('rejects never-observed roots as sizing evidence while preserving child verdicts', async () => {
    const s = sampler(temp()); s.poll(); s.poll(true);
    expect(() => s.result(100)).toThrow(/root/);
    for (const code of [0, 3]) {
      for (const missing of ['absent', 'ENOENT', 'ESRCH', 'EACCES']) {
        const h = harness({ code, onSpawn: proc => fs.rmSync(join(proc, '100'), { recursive: true }) });
        if (missing !== 'absent') h.deps.fs = { ...fs, readdirSync: (path, ...args) => {
          const entries = fs.readdirSync(path, ...args);
          return path === h.proc && !args.length ? [...entries, '100'] : entries;
        }, readFileSync: (path, ...args) => {
          if (path === join(h.proc, '100/stat')) throw error(missing);
          return fs.readFileSync(path, ...args);
        } };
        const done = h.start(); h.tick(); h.finish();
        expect(await done).toBe(code);
        expect(h.stderr()).toContain('job-profile: accounting failed ERR\n');
        expect(h.record()).toMatchObject({ exitCode: code, peakTreeRssMb: null, peakProcRssMb: null, cpuSec: null, samplerCpuSec: null });
        expect(h.record().error).toContain('accounting');
        expect(api.summarize(h.dir)).toBe('no valid records (skipped: 1)\n');
      }
    }
  });
  it('keeps valid metrics and continues sampling after a live descendant becomes a readable zombie', async () => {
    const h = harness({ onSpawn: proc => {
      processFile(proc, 100); processFile(proc, 101, { ppid: 100, rss: 30 });
    } });
    const done = h.start();
    fs.writeFileSync(join(h.proc, '101/stat'), stat(101, { ppid: 100, state: 'Z' }));
    fs.writeFileSync(join(h.proc, '101/status'), 'Name:\tnode\nState:\tZ (zombie)\n');
    h.tick();
    processFile(h.proc, 100, { rss: 60, hwm: 80 }); h.tick();
    processFile(h.proc, 100, { rss: 90, hwm: 100 });
    processFile(h.proc, 'self', { childUser: 300, childSystem: 50, user: 21 });
    h.finish();
    expect(await done).toBe(0); expect(h.stderr()).toBe('');
    expect(h.record()).toMatchObject({ peakTreeRssMb: 90, peakProcRssMb: 100, cpuSec: 2, reapedCpuSec: 2, samplerCpuSec: 0.01 });
    expect(h.record()).not.toHaveProperty('error');
  });
  it('keeps valid metrics when a descendant becomes a zombie between stat and status reads', async () => {
    const h = harness({ onSpawn: proc => {
      processFile(proc, 100, { rss: 20 }); processFile(proc, 101, { ppid: 100, rss: 30 });
    } });
    let transition = true;
    h.deps.fs = { ...fs, readFileSync: (path, ...args) => {
      if (path === join(h.proc, '101/status') && transition) {
        transition = false;
        fs.writeFileSync(join(h.proc, '101/stat'), stat(101, { ppid: 100, state: 'Z' }));
        fs.writeFileSync(path, 'Name:\tnode\nState:\tZ (zombie)\n');
      }
      return fs.readFileSync(path, ...args);
    } };
    const done = h.start(); processFile(h.proc, 100, { rss: 60 }); h.tick(); h.finish();
    expect(await done).toBe(0); expect(h.stderr()).toBe('');
    expect(h.record()).toMatchObject({ peakTreeRssMb: 60, peakProcRssMb: 60, cpuSec: 0 });
    expect(h.record()).not.toHaveProperty('error');
  });
  it('still invalidates metrics when a live descendant loses RSS evidence after a valid poll', async () => {
    const h = harness({ onSpawn: proc => {
      processFile(proc, 100); processFile(proc, 101, { ppid: 100 });
    } });
    const done = h.start();
    fs.writeFileSync(join(h.proc, '101/status'), 'Name:\tnode\nState:\tS (sleeping)\n');
    h.tick(); h.finish();
    expect(await done).toBe(0); expect(h.stderr()).toContain('job-profile: sample failed ERR\n');
    expect(h.record()).toMatchObject({ peakTreeRssMb: null, peakProcRssMb: null, cpuSec: null });
    expect(h.record().error).toContain('sample');
  });
  it.each([[0, null, 0], [3, null, 3], [null, 'SIGTERM', 143]])('keeps child verdict %s / %s', async (code, signal, expected) => {
    const h = harness({ code, signal }); const done = h.start(); h.finish();
    expect(await done).toBe(expected); expect(h.record().exitCode).toBe(expected);
  });
  it('returns 127 for a missing binary without fabricating a profile', async () => {
    const h = harness(); h.deps.spawn = () => { queueMicrotask(() => h.child.emit('error', error('ENOENT'))); return h.child; };
    expect(await h.start()).toBe(127); expect(h.stderr()).toContain('job-profile: spawn failed ENOENT');
    expect(fs.existsSync(h.out)).toBe(false);
  });
  it.each([[], ['--job=x'], ['--job=', '--', 'cmd'], ['--job=x', '--unknown', '--', 'cmd'], ['--summary'], ['--summary', 'dir', '--job=x']].map(args => [args]))('rejects bad arguments before spawn: %j', async args => {
    const h = harness(); expect(await api.runProfile(args, h.deps)).toBe(2); expect(h.deps.spawn).not.toHaveBeenCalled();
  });
  it('inherits output, cwd, env and argv without interception', async () => {
    const h = harness({ env: { SECRET_X: 's3cr3t' } }); const done = h.start();
    expect(h.deps.spawn).toHaveBeenCalledWith('fixture-command', ['--token=t0k3n'], { cwd: h.dir, env: h.deps.env, stdio: 'inherit' });
    // Inherited descriptors send bytes directly to the parent's streams; the wrapper has no copies/listeners.
    expect(h.child.listenerCount('data')).toBe(0); h.finish(); await done;
    expect(h.stdout()).toBe(''); expect(h.stderr()).toBe('');
    expect(fs.readFileSync(h.out, 'utf8')).not.toMatch(/s3cr3t|t0k3n|fixture-command/);
    expect(Object.keys(h.record()).sort()).toEqual(['v', 'repo', 'workflow', 'job', 'runner', 'intervalMs', 'peakTreeRssMb', 'peakProcRssMb', 'cpuSec', 'reapedCpuSec', 'orphanCpuSecLowerBound', 'samplerCpuSec', 'wallSec', 'avgThreads', 'exitCode', 'at'].sort());
  });
  it('preserves exactly 1 MiB of fixed bytes on each inherited stream from a real child', () => {
    const dir = temp(), proc = join(dir, 'proc'); fs.mkdirSync(proc); processFile(proc, 'self');
    const child = join(dir, 'child.mjs'), driver = join(dir, 'driver.mjs');
    fs.writeFileSync(child, `import { writeSync } from 'node:fs';
writeSync(1, Buffer.alloc(1024 * 1024, 65)); writeSync(2, Buffer.alloc(1024 * 1024, 66));`);
    fs.writeFileSync(driver, `import { runProfile } from ${JSON.stringify(new URL('../job-profile.mjs', import.meta.url).href)};
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
process.exitCode = await runProfile(['--job=bytes', '--proc-root=' + ${JSON.stringify(proc)}, '--', process.execPath, ${JSON.stringify(child)}], {
  cwd: ${JSON.stringify(dir)}, env: {}, getClockTicks: () => 100, now: () => 0, at: () => 'fixture',
  spawn: (...args) => {
    const child = spawn(...args), root = ${JSON.stringify(proc)} + '/' + child.pid;
    mkdirSync(root);
    writeFileSync(root + '/stat', ${JSON.stringify(stat(100))}.replace(/^100 /, child.pid + ' '));
    writeFileSync(root + '/status', 'VmRSS: 0 kB\\nVmHWM: 0 kB\\n');
    return child;
  }
});`);
    const result = spawnSync(process.execPath, [driver], { cwd: dir, env: {}, timeout: 10000, maxBuffer: 3 * 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(1024 * 1024, 65)); expect(result.stderr).toEqual(Buffer.alloc(1024 * 1024, 66));
  });
  it('measures reaped CPU, orphan CPU, sampler CPU, wall time and average threads separately', async () => {
    const h = harness({ onSpawn: proc => { processFile(proc, 100); processFile(proc, 101, { ppid: 100, user: 100 }); } });
    const done = h.start(); h.tick();
    processFile(h.proc, 'self', { childUser: 300, childSystem: 50, user: 21 });
    fs.rmSync(join(h.proc, '100'), { recursive: true }); h.finish(); await done;
    expect(h.record()).toMatchObject({ reapedCpuSec: 2, orphanCpuSecLowerBound: 1, cpuSec: 3, samplerCpuSec: 0.01, wallSec: 0.6, avgThreads: 5, intervalMs: 500 });
    expect(h.deps.getClockTicks.mock.invocationCallOrder[0]).toBeLessThan(h.deps.spawn.mock.invocationCallOrder[0]);
  });
  it('samples a 100 ms command at exit and clears timers and signal handlers', async () => {
    const h = harness({ onSpawn: proc => processFile(proc, 100, { rss: 25 }) }); const done = h.start(); h.finish(); await done;
    expect(h.record().peakTreeRssMb).toBe(25); expect(h.record().wallSec).toBe(0.1);
    expect(h.intervals.size).toBe(0); expect(h.timeouts.size).toBe(0); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('uses null average threads when wall time is zero', async () => {
    const h = harness(); h.deps.now = () => 0; const done = h.start(); h.finish(); await done; expect(h.record().avgThreads).toBeNull();
  });
  it('forwards SIGTERM to a trapping root and keeps its successful verdict', async () => {
    const h = harness({ onKill: (s, child) => { fs.writeFileSync(join(h.dir, 'signal-marker'), s); child.emit('exit', 0, null); } });
    const done = h.start(); h.signals.emit('SIGTERM'); expect(await done).toBe(0);
    expect(fs.readFileSync(join(h.dir, 'signal-marker'), 'utf8')).toBe('SIGTERM'); expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
  it('kills only the root after the grace period and exits with the first forwarded signal', async () => {
    const h = harness({ env: { JOB_PROFILE_GRACE_MS: '1000' } }); const done = h.start();
    h.signals.emit('SIGTERM'); h.signals.emit('SIGINT'); h.tick();
    expect([...h.timeouts].map(t => t.ms)).toEqual([1000]); [...h.timeouts][0].fn();
    expect(await done).toBe(143); expect(h.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGINT'], ['SIGKILL']]);
    expect(h.record().exitCode).toBe(143);
  });
  it.each(['0', '-1', 'NaN', '30001'])('refuses invalid grace %s before spawn', async value => {
    const h = harness({ env: { JOB_PROFILE_GRACE_MS: value } }); expect(await h.start()).toBe(2); expect(h.deps.spawn).not.toHaveBeenCalled();
  });
  it.each([0, 3])('keeps exit %s when record writing is denied', async code => {
    const h = harness({ code, io: { ...fs, openSync: (path, ...args) => { if (String(path).endsWith('.jsonl')) throw error('EACCES'); return fs.openSync(path, ...args); } } });
    const done = h.start(); h.finish(); expect(await done).toBe(code); expect(h.stderr()).toBe('job-profile: write failed EACCES\n');
  });
  it('isolates a partial write from the next full record and counts the broken line', async () => {
    const h = harness(); let partial = true;
    h.deps.fs = { ...fs, writeSync: (fd, data, ...args) => {
      if (partial) { partial = false; fs.writeSync(fd, data.slice(0, data.length / 2)); throw error('EIO'); }
      return fs.writeSync(fd, data, ...args);
    } };
    const done = h.start(); h.finish(); expect(await done).toBe(0); expect(h.stderr()).toContain('write failed EIO');
    api.appendRecord(h.out, { v: 1, job: 'second', peakTreeRssMb: 1, cpuSec: 0, samplerCpuSec: 0, wallSec: 1, exitCode: 0 });
    expect(api.summarize(h.dir)).toContain('records: 1'); expect(api.summarize(h.dir)).toContain('skipped: 1');
  });
  it.each([0, 3])('keeps exit %s and marks unknown metrics on malformed sampler evidence', async code => {
    const h = harness({ code, onSpawn: proc => { processFile(proc, 100); fs.writeFileSync(join(proc, '100/stat'), 'broken'); } });
    const done = h.start(); h.tick(); h.finish(); expect(await done).toBe(code);
    expect(h.stderr()).toMatch(/job-profile: sample failed ERR\n/); expect(h.record().error).toContain('sample');
    expect(h.record().peakTreeRssMb).toBeNull(); expect(h.record().cpuSec).toBeNull();
  });
  it.each(['EIO', 'EACCES'])('marks unreadable self accounting %s as telemetry failure rather than no-proc', async code => {
    const h = harness(); h.deps.fs = { ...fs, readFileSync: (path, ...args) => { if (String(path).endsWith('/self/stat')) throw error(code); return fs.readFileSync(path, ...args); } };
    const done = h.start(); h.finish(); expect(await done).toBe(0);
    expect(h.record().error).toBeDefined(); expect(h.stderr()).not.toContain('no /proc');
  });
  it('excludes getconf helper CPU by reading the baseline after getconf', async () => {
    const h = harness(); h.deps.getClockTicks = () => { processFile(h.proc, 'self', { childUser: 500 }); return 100; };
    const done = h.start(); processFile(h.proc, 'self', { childUser: 700 }); h.finish(); await done;
    expect(h.record().reapedCpuSec).toBe(2);
  });
  it('keeps the verdict on getconf failure and marks unknown accounting', async () => {
    const h = harness({ code: 3 }); h.deps.getClockTicks = () => { throw error('ETIMEDOUT'); };
    const done = h.start(); h.finish(); expect(await done).toBe(3); expect(h.record().error).toContain('clock');
  });
  it('runs without proc, writes no record, and names the skip', async () => {
    const h = harness({ code: 3, noProc: true }); const done = h.start(); h.finish(); expect(await done).toBe(3);
    expect(fs.existsSync(h.out)).toBe(false); expect(h.stderr()).toBe('job-profile: no /proc, skipped\n');
  });
});

describe('summary', () => {
  const record = (job, peak, extra = {}) => ({ v: 1, job, runner: 'fixture', at: 'a', peakTreeRssMb: peak, cpuSec: 2, samplerCpuSec: 0.01, wallSec: 2, exitCode: 0, ...extra });
  it('excludes negative resource metrics and wall times before deduplication, P90 and overhead ratios', () => {
    for (const field of ['peakTreeRssMb', 'cpuSec', 'samplerCpuSec', 'wallSec']) {
      const root = temp(), file = join(root, 'metrics.jsonl');
      const bad = record('a', 100, { [field]: -100 });
      fs.writeFileSync(file, JSON.stringify(bad));
      expect(api.summarize(root)).toBe('no valid records (skipped: 1)\n');
      fs.writeFileSync(file, [bad, record('a', 100), record('zero', 0, { cpuSec: 0, samplerCpuSec: 0, wallSec: 0 })].map(JSON.stringify).join('\n'));
      const output = api.summarize(root);
      expect(output).toContain('records: 2\njobs: 2\nskipped: 1\np90 peakTreeRssMb: 100\n');
      expect(output).toContain('a\tfixture\ta\t100\t2\t1\t0.005\t0\n');
      expect(output).toContain('zero\tfixture\ta\t0\t0\tnull\tnull\t0\n');
    }
  });
  it('sorts nested records, deduplicates identities, validates lines and ranks only successful rows', () => {
    const root = temp(); fs.mkdirSync(join(root, 'nested'));
    const a = record('a', 100);
    fs.writeFileSync(join(root, 'nested', 'one.jsonl'), [record('b', 200), a, record('c', 300), record('failed', 999, { exitCode: 1 }), a, record('a', 150, { at: 'b' }), '{', { ...a, v: 2 }, { ...a, cpuSec: 'x' }].map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n'));
    const text = api.summarize(root);
    expect(text).toContain('records: 5'); expect(text).toContain('jobs: 4'); expect(text).toContain('skipped: 3'); expect(text).toContain('p90 peakTreeRssMb: 300');
    const rows = text.split('\n').filter(line => /^(a|b|c|failed)\t/.test(line)); expect(rows).toHaveLength(5);
    expect(rows.slice(0, 2).map(row => row.split('\t').slice(0, 3))).toEqual([['a', 'fixture', 'a'], ['a', 'fixture', 'b']]);
  });
  it('prints no records for empty directories and empty files', () => {
    const root = temp(); expect(api.summarize(root)).toBe('no records\n'); fs.writeFileSync(join(root, 'empty.jsonl'), ''); expect(api.summarize(root)).toBe('no records\n');
  });
  it('prints no valid records for malformed lines', () => {
    const root = temp(); fs.writeFileSync(join(root, 'bad.jsonl'), '{\nwat\n'); expect(api.summarize(root)).toBe('no valid records (skipped: 2)\n');
  });
  it('prints n/a without successful rows and derives ratios from finite measured numbers', () => {
    const root = temp(); fs.writeFileSync(join(root, 'one.jsonl'), JSON.stringify(record('a', 3, { exitCode: 1, avgThreads: 999 })));
    const text = api.summarize(root); expect(text).toContain('p90 peakTreeRssMb: n/a'); expect(text).toContain('\t1\t0.005\t1');
  });
  it.each([null, [], { v: 1 }, record('', 1), record('a', 1, { wallSec: null }), record('a', 1, { error: 'sample failed' })])('rejects incomplete or failed evidence: %j', value => {
    const root = temp(); fs.writeFileSync(join(root, 'bad.jsonl'), JSON.stringify(value)); expect(api.summarize(root)).toBe('no valid records (skipped: 1)\n');
  });
  it('refuses unreadable inputs and oversized lines with an operator-visible reason', () => {
    expect(() => api.summarize(join(temp(), 'absent'))).toThrow();
    const root = temp(); fs.writeFileSync(join(root, 'large.jsonl'), 'x'.repeat(65537)); expect(api.summarize(root)).toBe('no valid records (skipped: 1)\n');
  });
});
