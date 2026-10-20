// Orphan-process reaper (2026-10-20): closed allowlist on the PROGRAM, orphans only, fail-closed leases,
// re-judged before every signal, dry-run first.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEEPALIVE_MARKER, ORPHAN_REAPER_DEFAULTS, parseEtime, parseNodeCommand, parseReaperPs, planOrphanReap, reapOrphans,
  listProcesses, readProcess, readLiveJobPids, resolveOrphanReaperSettings, runOrphanReaperPass,
} from '../orphan-process-reaper.mjs';

const UID = 501;
const NODE = '/usr/local/bin/node';
const settings = { ...ORPHAN_REAPER_DEFAULTS };
const LEASE_OK = { pids: new Set(), complete: true };
const proc = (over) => ({ pid: 1000, ppid: 1, pgid: 1000, uid: UID, ageMs: 3 * 3600_000, started: 'Mon Oct 19 09:00:00 2026', command: `${NODE} -e ${KEEPALIVE_MARKER}{x}`, ...over });
const ctx = (extra = {}) => ({ uid: UID, selfPid: 1, settings, isAlive: () => false, lease: LEASE_OK, cwdOf: () => '/repo', ...extra });
const plan = (procs, extra) => planOrphanReap(procs, ctx(extra));

describe('parsing ps and node command lines', () => {
  it('reads etime in every ps shape', () => {
    expect(parseEtime('05:07')).toBe(307_000);
    expect(parseEtime('02:05:07')).toBe((2 * 3600 + 307) * 1000);
    expect(parseEtime('19-02:05:07')).toBe(((19 * 24 + 2) * 3600 + 307) * 1000);
    expect(parseEtime('nope')).toBeNull();
  });
  it('parses pid, ppid, pgid, uid, age, start time and the full command', () => {
    expect(parseReaperPs('  50046     1 50046   501 11-14:06:00 Fri Oct  9 19:38:25 2026 /x/node -e x\n')).toEqual([
      { pid: 50046, ppid: 1, pgid: 50046, uid: 501, ageMs: parseEtime('11-14:06:00'), started: 'Fri Oct 9 19:38:25 2026', command: '/x/node -e x' },
    ]);
  });
  it('finds the program node runs, and refuses when a flag might swallow it', () => {
    expect(parseNodeCommand(`${NODE} --input-type=module -e import x`)).toEqual({ kind: 'eval', program: 'import x' });
    expect(parseNodeCommand(`${NODE} --no-warnings /r/scripts/verify-lane.mjs --files=a`)).toEqual({ kind: 'script', script: '/r/scripts/verify-lane.mjs' });
    expect(parseNodeCommand(`${NODE} --title=/r/scripts/verify-lane.mjs /other/server.mjs`)).toEqual({ kind: 'script', script: '/other/server.mjs' });
    expect(parseNodeCommand(`${NODE} --require /r/scripts/verify-lane.mjs /other/server.mjs`)).toBeNull();
    expect(parseNodeCommand('/usr/bin/python3 /r/scripts/verify-lane.mjs')).toBeNull();
  });
});

describe('planOrphanReap — the closed allowlist, on the program only', () => {
  it('matches each of our own job signatures when orphaned and old', () => {
    const procs = [
      proc({ pid: 11, command: `${NODE} -e setInterval(() => {}, 1e9)` }), // keepalive-guard: not-a-spawn (ps fixture)
      proc({ pid: 12, command: `${NODE} -e process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)` }), // keepalive-guard: not-a-spawn (ps fixture)
      proc({ pid: 13, command: `${NODE} -e ${KEEPALIVE_MARKER}{const a=5}` }),
      proc({ pid: 14, command: `${NODE} /var/folders/T/we-vitest/53178-ExVZLj/fixture/job.mjs` }),
      proc({ pid: 15, command: 'node (vitest)' }),
      proc({ pid: 16, command: `${NODE} /repo/node_modules/vitest/vitest.mjs run scripts/a.test.mjs` }),
      proc({ pid: 17, command: `${NODE} /repo/scripts/verify-lane.mjs --files=a` }),
      proc({ pid: 18, command: `${NODE} scripts/codex-direct-task.mjs --task-file=t` }), // relative: resolved via its cwd
      proc({ pid: 19, command: `${NODE} /repo/scripts/operations/review-job.mjs 12` }),
    ];
    expect(plan(procs).reap.map((r) => [r.pid, r.signature])).toEqual([
      [11, 'test-keepalive'], [12, 'test-keepalive'], [13, 'test-keepalive'], [14, 'vitest-tmp-fixture'],
      [15, 'vitest'], [16, 'vitest'], [17, 'verify-lane'], [18, 'codex-direct-task'], [19, 'review-job'],
    ]);
  });
  it('never matches a flag value, a later argument, or a program that does real work', () => {
    const procs = [
      proc({ command: `${NODE} --title=/repo/scripts/verify-lane.mjs /other/server.mjs` }),
      proc({ command: `${NODE} /other/server.mjs --label=/repo/scripts/verify-lane.mjs` }),
      proc({ command: `${NODE} /other/server.mjs --input=/tmp/we-vitest/999999-AbCdEf/data.json` }),
      proc({ command: `${NODE} --require x /repo/scripts/verify-lane.mjs` }),
      proc({ command: `${NODE} -e require('http').createServer().listen(0); setInterval(() => {}, 1000)` }), // keepalive-guard: not-a-spawn (ps fixture)
      proc({ command: `${NODE} scripts/verify-lane.mjs` }), // relative with an unknown cwd
    ];
    expect(plan(procs, { cwdOf: () => null }).reap).toEqual([]);
  });
  it('never touches anything outside the allowlist, even an old orphan', () => {
    const procs = [
      proc({ command: `${NODE} /repo/node_modules/.bin/vite --port 4000` }),
      proc({ command: 'npm start' }),
      proc({ command: '/Users/me/.local/bin/claude --resume x' }),
      proc({ command: `${NODE} /repo/scripts/conveyor/health-watch.mjs tick` }),
      proc({ command: '/bin/sleep 1000' }),
    ];
    expect(plan(procs).reap).toEqual([]);
  });
  it('refuses a dev-server or daemon command line even when a signature also matches', () => {
    const r = plan([proc({ command: `${NODE} /repo/scripts/verify-lane.mjs via /repo/node_modules/.bin/vite ` })]);
    expect(r.reap).toEqual([]);
    expect(r.skipped['never-reap-pattern']).toBe(1);
  });
  it('skips a live parent, a young process, another user, itself, a live job record and a live group leader', () => {
    const r = plan([
      proc({ pid: 21, ppid: 777 }),
      proc({ pid: 22, ageMs: 60_000 }),
      proc({ pid: 23, uid: 0 }),
      proc({ pid: 24, pgid: 900 }),
      proc({ pid: 25 }),
      proc({ pid: 26 }),
      proc({ pid: 1 }),
    ], { selfPid: 25, lease: { pids: new Set([26]), complete: true }, isAlive: (pid) => pid === 900 });
    expect(r.reap).toEqual([]);
    expect(r.skipped).toEqual({ 'live-parent': 1, 'younger-than-max-age': 1, 'live-group-leader': 1, 'live-job-record': 1 });
  });
  it('an incomplete lease scan reaps nothing at all (fail closed)', () => {
    const r = plan([proc({ pid: 41 }), proc({ pid: 42, command: `${NODE} /repo/scripts/verify-lane.mjs` })], { lease: { pids: new Set(), complete: false } });
    expect(r.reap).toEqual([]);
    expect(r.skipped).toEqual({ 'lease-scan-incomplete': 2 });
  });
  it('keeps a fixture whose vitest run is still alive', () => {
    const p = proc({ command: `${NODE} /tmp/we-vitest/4308-SVDmrp/x.mjs` });
    expect(plan([p], { isAlive: (pid) => pid === 4308 }).reap).toEqual([]);
    expect(plan([p]).reap).toHaveLength(1);
  });
});

describe('readLiveJobPids — fail closed', () => {
  const roots = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const root = () => { const r = mkdtempSync(join(tmpdir(), 'reaper-jobs-')); roots.push(r); return r; };
  it('reads live pids from every store; ignores terminal records and non-record JSON', () => {
    const r = root(); mkdirSync(join(r, 'a')); mkdirSync(join(r, 'b'));
    writeFileSync(join(r, 'a', 'j1.json'), JSON.stringify({ job: { status: 'running', pid: 77 } }));
    writeFileSync(join(r, 'a', 'j2.json'), JSON.stringify({ job: { status: 'succeeded', pid: 78 } }));
    writeFileSync(join(r, 'b', 'consumed.json'), JSON.stringify(['x']));
    expect(readLiveJobPids({ root: r })).toEqual({ pids: new Set([77]), complete: true });
  });
  it('a missing root, an unreadable store or a torn record is an incomplete scan', () => {
    expect(readLiveJobPids({ root: join(tmpdir(), 'reaper-no-such-root-x9') }).complete).toBe(false);
    const r = root(); mkdirSync(join(r, 'a'));
    writeFileSync(join(r, 'a', 'torn.json'), '{"job": {');
    expect(readLiveJobPids({ root: r }).complete).toBe(false);
    const r2 = root(); mkdirSync(join(r2, 'a'));
    const fs = { readdirSync: (p, o) => { if (p.endsWith('/a')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return o ? [{ name: 'a', isDirectory: () => true }] : []; }, readFileSync };
    expect(readLiveJobPids({ root: r2, fs }).complete).toBe(false);
  });
});

describe('reapOrphans — every signal is preceded by a fresh re-judgement of that one process', () => {
  const base = { settings: { ...settings, termGraceSeconds: 0 }, dryRun: false, uid: UID, selfPid: 1, isAlive: () => false, cwdOf: () => '/repo', log: () => {}, sleep: async () => {} };
  it('never signals a recycled pid (same pid, different start time)', async () => {
    const kills = [];
    const out = await reapOrphans({ ...base, list: () => [proc({ pid: 51, started: 'A' })], readOne: () => proc({ pid: 51, started: 'B' }),
      leaseScan: () => LEASE_OK, kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([]);
    expect(out.reaped).toEqual([]);
  });
  it('re-runs the lease scan before EACH signal: a lease that appears after SIGTERM stops the SIGKILL', async () => {
    const p = proc({ pid: 52 });
    const scans = [LEASE_OK, LEASE_OK, { pids: new Set([52]), complete: true }];
    const kills = [];
    const out = await reapOrphans({ ...base, list: () => [p], readOne: () => p, leaseScan: () => scans.shift() ?? { pids: new Set([52]), complete: true },
      kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([[52, 'SIGTERM']]);
    expect(out.reaped.map((r) => r.signal)).toEqual(['SIGTERM']);
  });
  it('a later candidate is re-read right before its own signal, not from the batch snapshot', async () => {
    const a = proc({ pid: 61 }); const b = proc({ pid: 62 });
    const kills = [];
    let reads = 0;
    // b gains a live parent after a was signalled: only a is signalled.
    const readOne = (pid) => { reads++; return pid === 62 ? { ...b, ppid: 4242 } : a; };
    await reapOrphans({ ...base, list: () => [a, b], readOne, leaseScan: () => LEASE_OK, kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills.filter(([, s]) => s === 'SIGTERM').map(([pid]) => pid)).toEqual([61]);
    expect(reads).toBeGreaterThanOrEqual(3);
  });
  it('dry-run sends no signal at all', async () => {
    const kills = [];
    const out = await reapOrphans({ ...base, dryRun: true, list: () => [proc({ pid: 53 })], leaseScan: () => LEASE_OK, kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([]);
    expect(out.reaped).toHaveLength(1);
  });
});

describe('settings — the cascade, with sources', () => {
  it('ships in dry-run from the tool file, and an env override wins with its source logged', () => {
    const lines = [];
    const tool = resolveOrphanReaperSettings({ env: {}, log: (l) => lines.push(l) });
    expect(tool.value.dryRun).toBe(true);
    expect(tool.sources.dryRun).toBe('tool');
    const env = resolveOrphanReaperSettings({ env: { WE_ORPHAN_REAPER_DRY_RUN: '0', WE_ORPHAN_REAPER_KEEP_ALIVE_MAX_AGE_MINUTES: '3' }, log: (l) => lines.push(l) });
    expect(env.value).toMatchObject({ dryRun: false, keepAliveMaxAgeMinutes: 3 });
    expect(env.sources).toMatchObject({ dryRun: 'env', keepAliveMaxAgeMinutes: 'env' });
    expect(lines.at(-1)).toMatch(/orphanReaper: .*dryRun=false \(env\)/);
  });
  it('rejects a bad env value and keeps the lower layer', () => {
    const out = resolveOrphanReaperSettings({ env: { WE_ORPHAN_REAPER_INTERVAL_MINUTES: '-1' }, log: () => {} });
    expect(out.value.intervalMinutes).toBe(10);
  });
});

describe('the periodic pass — cadence', () => {
  it('runs once per interval and records what it did', async () => {
    const s = { value: { ...settings, intervalMinutes: 10 } };
    const deps = { list: () => [proc({ pid: 31 })], leaseScan: () => LEASE_OK, isAlive: () => false, uid: UID, selfPid: 1, cwdOf: () => null, log: () => {} };
    const first = await runOrphanReaperPass({ now: 1_000_000, state: {}, settings: s, ...deps });
    expect(first.state).toMatchObject({ lastRunAt: 1_000_000, dryRun: true, planned: 1, reaped: 1 });
    expect((await runOrphanReaperPass({ now: 1_000_000 + 60_000, state: first.state, settings: s, ...deps })).result).toBeNull();
    expect((await runOrphanReaperPass({ now: 1_000_000 + 11 * 60_000, state: first.state, settings: s, ...deps })).result.planned).toBe(1);
    expect((await runOrphanReaperPass({ state: {}, settings: { value: { ...settings, enabled: false } }, ...deps })).result).toBeNull();
  });
});

// ── a harness of REAL fake orphans ─────────────────────────────────────────────────────────────────────────
// Each fake is a real grandchild re-parented to pid 1 that exits on its own after 60s, so a failed test leaks
// nothing for long. The reaper only ever sees THESE pids (the injected list/readOne are filtered to them), so
// this test can never signal a real process on the host.
const fakes = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
afterEach(() => { for (const pid of fakes) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } fakes.clear(); });

function spawnOrphan(body) {
  const child = `${KEEPALIVE_MARKER}${body};setTimeout(()=>process.exit(0),60000)`;
  const out = spawnSync(process.execPath, ['-e',
    `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`],
  { encoding: 'utf8' });
  const pid = Number(out.stdout.trim());
  fakes.add(pid);
  return pid;
}
async function waitOrphaned(pid) {
  for (let i = 0; i < 100; i++) {
    if (readProcess(pid)?.ppid === 1) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} never re-parented to 1`);
}

describe('reapOrphans on real fake orphans', () => {
  it('dry-run lists them and signals nothing; apply TERMs, then KILLs one that ignores TERM; a live-parented one is untouched', async () => {
    const polite = spawnOrphan('setInterval(()=>0,1000)');
    const stubborn = spawnOrphan("process.on('SIGTERM',()=>{});setInterval(()=>0,1000)");
    const parented = spawn(process.execPath, ['-e', `${KEEPALIVE_MARKER}setInterval(()=>0,1000);setTimeout(()=>process.exit(0),60000)`], { stdio: 'ignore' });
    fakes.add(parented.pid);
    await waitOrphaned(polite); await waitOrphaned(stubborn);
    const mine = new Set([polite, stubborn, parented.pid]);
    const io = {
      list: () => listProcesses().filter((p) => mine.has(p.pid)),
      readOne: (pid) => (mine.has(pid) ? readProcess(pid) : null),
      leaseScan: () => LEASE_OK,
    };
    const dir = mkdtempSync(join(tmpdir(), 'orphan-reaper-'));
    try {
      const logPath = join(dir, 'orphan-reaper.jsonl');
      const cfg = { ...settings, keepAliveMaxAgeMinutes: 1 / 600, termGraceSeconds: 1 }; // 100ms
      await new Promise((r) => setTimeout(r, 1_100)); // ps etime counts whole seconds
      const dry = await reapOrphans({ settings: cfg, dryRun: true, ...io, logPath, log: () => {} });
      expect(dry.reaped.map((r) => r.pid).sort()).toEqual([polite, stubborn].sort());
      expect(dry.skipped).toEqual({ 'live-parent': 1 });
      expect([polite, stubborn, parented.pid].every(alive)).toBe(true);

      const lines = [];
      const applied = await reapOrphans({ settings: cfg, dryRun: false, ...io, logPath, log: (l) => lines.push(l) });
      expect(Object.fromEntries(applied.reaped.map((r) => [r.pid, r.signal]))).toEqual({ [polite]: 'SIGTERM', [stubborn]: 'SIGKILL' });
      for (let i = 0; i < 40 && (alive(polite) || alive(stubborn)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(polite)).toBe(false);
      expect(alive(stubborn)).toBe(false);
      expect(alive(parented.pid)).toBe(true);
      expect(lines.filter((l) => l.includes('reaped')).every((l) => /pid=\d+ signature=test-keepalive age=\d+s reason="/.test(l))).toBe(true);
      const logged = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(logged.filter((e) => !e.dryRun).map((e) => e.signal).sort()).toEqual(['SIGKILL', 'SIGTERM']);
      expect(logged.filter((e) => e.dryRun)).toHaveLength(2);
    } finally {
      parented.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
