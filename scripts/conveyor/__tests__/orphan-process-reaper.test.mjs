// Orphan-process reaper (2026-10-20): closed allowlist, orphans only, SIGTERM then SIGKILL, dry-run first.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORPHAN_REAPER_DEFAULTS, parseEtime, parseReaperPs, planOrphanReap, reapOrphans, listProcesses,
  resolveOrphanReaperSettings, runOrphanReaperPass, orphanReaperTickAllowed,
} from '../orphan-process-reaper.mjs';
import { KEEPALIVE_MARKER } from '../../lib/test-keepalive.mjs';

const UID = 501;
const NODE = '/usr/local/bin/node';
const settings = { ...ORPHAN_REAPER_DEFAULTS };
const proc = (over) => ({ pid: 1000, ppid: 1, pgid: 1000, uid: UID, ageMs: 3 * 3600_000, command: `${NODE} -e ${KEEPALIVE_MARKER}{x}`, ...over });
const plan = (procs, extra = {}) => planOrphanReap(procs, { uid: UID, selfPid: 1, settings, isAlive: () => false, ...extra });

describe('parsing ps', () => {
  it('reads etime in every ps shape', () => {
    expect(parseEtime('05:07')).toBe(307_000);
    expect(parseEtime('02:05:07')).toBe((2 * 3600 + 307) * 1000);
    expect(parseEtime('19-02:05:07')).toBe(((19 * 24 + 2) * 3600 + 307) * 1000);
    expect(parseEtime('nope')).toBeNull();
  });
  it('parses pid, ppid, pgid, uid, age and the full command', () => {
    expect(parseReaperPs('  50046     1 50046   501 11-14:06:00 Fri Oct  9 19:38:25 2026 /x/node -e setInterval(()=>{},1000)\n')).toEqual([ // keepalive-guard: not-a-spawn (ps fixture)
      { pid: 50046, ppid: 1, pgid: 50046, uid: 501, ageMs: parseEtime('11-14:06:00'), started: 'Fri Oct 9 19:38:25 2026', command: '/x/node -e setInterval(()=>{},1000)' }, // keepalive-guard: not-a-spawn (ps fixture)
    ]);
  });
});

describe('planOrphanReap — the closed allowlist', () => {
  it('matches each of our own job signatures when orphaned and old', () => {
    const procs = [
      proc({ pid: 11, command: `${NODE} -e setInterval(() => {}, 1e9)` }), // keepalive-guard: not-a-spawn (ps fixture)
      proc({ pid: 12, command: `${NODE} -e process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)` }), // keepalive-guard: not-a-spawn (ps fixture)
      proc({ pid: 13, command: `${NODE} -e ${KEEPALIVE_MARKER}{const a=5}` }),
      proc({ pid: 14, command: `${NODE} /var/folders/T/we-vitest/53178-ExVZLj/fixture/job.mjs` }),
      proc({ pid: 15, command: 'node (vitest)' }),
      proc({ pid: 16, command: `${NODE} /repo/node_modules/vitest/vitest.mjs run scripts/a.test.mjs` }),
      proc({ pid: 17, command: `${NODE} /repo/scripts/verify-lane.mjs --files=a` }),
      proc({ pid: 18, command: `${NODE} /repo/scripts/codex-direct-task.mjs --task-file=t` }),
      proc({ pid: 19, command: `${NODE} /repo/scripts/operations/review-job.mjs 12` }),
    ];
    expect(plan(procs).reap.map((r) => [r.pid, r.signature])).toEqual([
      [11, 'test-keepalive'], [12, 'test-keepalive'], [13, 'test-keepalive'], [14, 'vitest-tmp-fixture'],
      [15, 'vitest'], [16, 'vitest'], [17, 'verify-lane'], [18, 'codex-direct-task'], [19, 'review-job'],
    ]);
  });
  it('never touches anything outside the allowlist, even an old orphan', () => {
    const procs = [
      proc({ command: `${NODE} /repo/node_modules/.bin/vite --port 4000` }),
      proc({ command: 'npm start' }),
      proc({ command: '/Users/me/.local/bin/claude --resume x' }),
      proc({ command: `${NODE} /repo/scripts/conveyor/health-watch.mjs tick` }),
      proc({ command: '/bin/sleep 1000' }),
      // a signature mentioned later in the arguments is not the script being run
      proc({ command: `${NODE} /other/server.mjs --label=/repo/scripts/verify-lane.mjs` }),
      // an -e program that does real work beside an idle interval is not a keep-alive
      proc({ command: `${NODE} -e require('http').createServer().listen(0); setInterval(() => {}, 1000)` }), // keepalive-guard: not-a-spawn (ps fixture)
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
      proc({ pid: 1 }),
    ], { selfPid: 25, jobPids: new Set([22, 21]), isAlive: (pid) => pid === 900 });
    expect(r.reap).toEqual([]);
    expect(r.skipped).toEqual({ 'live-parent': 1, 'younger-than-max-age': 1, 'live-group-leader': 1 });
    expect(plan([proc({ pid: 26 })], { jobPids: new Set([26]) }).skipped).toEqual({ 'live-job-record': 1 });
  });
  it('an incomplete lease scan keeps everything a daemon job could own, but still reaps pure test artifacts', () => {
    const r = plan([proc({ pid: 41 }), proc({ pid: 42, command: `${NODE} /repo/scripts/verify-lane.mjs` })], { leaseScanComplete: false });
    expect(r.reap.map((c) => c.pid)).toEqual([41]);
    expect(r.skipped).toEqual({ 'lease-scan-incomplete': 1 });
  });
  it('keeps a fixture whose vitest run is still alive', () => {
    const p = proc({ command: `${NODE} /tmp/we-vitest/4308-SVDmrp/x.mjs` });
    expect(plan([p], { isAlive: (pid) => pid === 4308 }).reap).toEqual([]);
    expect(plan([p]).reap).toHaveLength(1);
  });
});

describe('reapOrphans — identity is re-checked before every signal', () => {
  const base = { settings: { ...settings, termGraceSeconds: 0 }, dryRun: false, uid: UID, selfPid: 1, isAlive: () => false, log: () => {}, sleep: async () => {} };
  it('never signals a recycled pid (same pid, different start time)', async () => {
    const scans = [[proc({ pid: 51, started: 'A' })], [proc({ pid: 51, started: 'B' })]];
    const kills = [];
    const out = await reapOrphans({ ...base, list: () => scans.shift() ?? [], jobPids: new Set(), kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([]);
    expect(out.reaped).toEqual([]);
  });
  it('never escalates to SIGKILL once the process gained a lease after SIGTERM', async () => {
    const p = proc({ pid: 52, started: 'A' });
    const leases = [new Set(), new Set(), new Set([52])];
    const kills = [];
    const out = await reapOrphans({ ...base, list: () => [p], jobPids: () => ({ pids: leases.shift() ?? new Set([52]), complete: true }), kill: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([[52, 'SIGTERM']]);
    expect(out.reaped.map((r) => r.signal)).toEqual(['SIGTERM']);
  });
  it('dry-run sends no signal at all', async () => {
    const kills = [];
    const out = await reapOrphans({ ...base, dryRun: true, list: () => [proc({ pid: 53 })], jobPids: new Set(), kill: (pid, sig) => kills.push([pid, sig]) });
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

describe('the pass — cadence and tick gating', () => {
  it('runs once per interval and records what it did', async () => {
    const s = { value: { ...settings, intervalMinutes: 10 } };
    const deps = { list: () => [proc({ pid: 31 })], jobPids: new Set(), isAlive: () => false, uid: UID, selfPid: 1, log: () => {} };
    const first = await runOrphanReaperPass({ now: 1_000_000, state: {}, settings: s, ...deps });
    expect(first.state).toMatchObject({ lastRunAt: 1_000_000, dryRun: true, planned: 1, reaped: 1 });
    const again = await runOrphanReaperPass({ now: 1_000_000 + 60_000, state: first.state, settings: s, ...deps });
    expect(again.result).toBeNull();
    const later = await runOrphanReaperPass({ now: 1_000_000 + 11 * 60_000, state: first.state, settings: s, ...deps });
    expect(later.result.planned).toBe(1);
    expect((await runOrphanReaperPass({ state: {}, settings: { value: { ...settings, enabled: false } }, ...deps })).result).toBeNull();
  });
  it('a test run or a fixture tick never reaps the real host', () => {
    expect(orphanReaperTickAllowed({}, { env: { WE_UNDER_TEST: '1' } })).toBe(false);
    expect(orphanReaperTickAllowed({ 'state-root': '/x' }, { env: {} })).toBe(false);
    expect(orphanReaperTickAllowed({ 'ps-fixture': '/x' }, { env: {} })).toBe(false);
    expect(orphanReaperTickAllowed({ 'heavy-status-file': '/x' }, { env: {} })).toBe(false);
    expect(orphanReaperTickAllowed({ now: '2026-10-20T00:00:00Z' }, { env: {} })).toBe(false);
    expect(orphanReaperTickAllowed({ 'dry-run': true, 'no-gh': true }, { env: {} })).toBe(true);
    expect(orphanReaperTickAllowed({}, { env: {} })).toBe(true);
    expect(orphanReaperTickAllowed({}, { injected: true, env: { WE_UNDER_TEST: '1' } })).toBe(true);
  });
});

// ── a harness of REAL fake orphans ─────────────────────────────────────────────────────────────────────────
// Each fake is a real grandchild re-parented to pid 1. Each exits on its own after 60s, so a failed test leaks
// nothing for long. The reaper only ever sees THESE pids (the injected list filters real `ps` to them), so this
// test can never signal a real process on the host.
const fakes = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
afterEach(() => { for (const pid of fakes) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } fakes.clear(); });

function spawnOrphan(body, { title = '' } = {}) {
  // `title` is a comment in the child's -e source, so its command line can carry a signature.
  const child = `${title}${body};setTimeout(()=>process.exit(0),60000)`;
  const out = spawnSync(process.execPath, ['-e',
    `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`],
  { encoding: 'utf8' });
  const pid = Number(out.stdout.trim());
  fakes.add(pid);
  return pid;
}
async function waitOrphaned(pid) {
  for (let i = 0; i < 100; i++) {
    const row = listProcesses().find((p) => p.pid === pid);
    if (row?.ppid === 1) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} never re-parented to 1`);
}

describe('reapOrphans on real fake orphans', () => {
  it('dry-run lists them and signals nothing; apply TERMs, then KILLs one that ignores TERM; a live-parented one is untouched', async () => {
    const polite = spawnOrphan('setInterval(()=>0,1000)', { title: KEEPALIVE_MARKER });
    const stubborn = spawnOrphan("process.on('SIGTERM',()=>{});setInterval(()=>0,1000)", { title: KEEPALIVE_MARKER });
    const parented = spawn(process.execPath, ['-e', `${KEEPALIVE_MARKER}setInterval(()=>0,1000);setTimeout(()=>process.exit(0),60000)`], { stdio: 'ignore' });
    fakes.add(parented.pid);
    await waitOrphaned(polite); await waitOrphaned(stubborn);
    const mine = new Set([polite, stubborn, parented.pid]);
    const list = () => listProcesses().filter((p) => mine.has(p.pid));
    const dir = mkdtempSync(join(tmpdir(), 'orphan-reaper-'));
    try {
      const logPath = join(dir, 'orphan-reaper.jsonl');
      const cfg = { ...settings, keepAliveMaxAgeMinutes: 1 / 600, termGraceSeconds: 1 }; // 100ms
      await new Promise((r) => setTimeout(r, 1_100)); // ps etime counts whole seconds
      const dry = await reapOrphans({ settings: cfg, dryRun: true, list, jobPids: new Set(), logPath, log: () => {} });
      expect(dry.reaped.map((r) => r.pid).sort()).toEqual([polite, stubborn].sort());
      expect(dry.skipped).toEqual({ 'live-parent': 1 });
      expect([polite, stubborn, parented.pid].every(alive)).toBe(true);

      const lines = [];
      const applied = await reapOrphans({ settings: cfg, dryRun: false, list, jobPids: new Set(), logPath, log: (l) => lines.push(l) });
      const bySignal = Object.fromEntries(applied.reaped.map((r) => [r.pid, r.signal]));
      expect(bySignal).toEqual({ [polite]: 'SIGTERM', [stubborn]: 'SIGKILL' });
      for (let i = 0; i < 40 && (alive(polite) || alive(stubborn)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(polite)).toBe(false);
      expect(alive(stubborn)).toBe(false);
      expect(alive(parented.pid)).toBe(true);
      expect(lines.every((l) => /pid=\d+ signature=test-keepalive age=\d+s reason="/.test(l))).toBe(true);
      const logged = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(logged.filter((e) => !e.dryRun).map((e) => e.signal).sort()).toEqual(['SIGKILL', 'SIGTERM']);
      expect(logged.filter((e) => e.dryRun)).toHaveLength(2);
    } finally {
      parented.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
