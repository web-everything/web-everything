/** Quick rebuild policy, real check selection, and durable post-adopt recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import {
  decideQuick, QUICK_ALWAYS_FULL_PATHS, QUICK_DEFERRED_CHECKS, quickFinalizeWaitMs,
  resolveQuick, QUICK_SOAK_CHECKS, QUICK_SOAK_MAX_MS,
} from '../daemon-rebuild/quick.mjs';
import {
  launchQuickSoak, recoverQuickSoak, recordQuickSoakResult, settleQuickSoak, runQuickSoak, QUICK_SOAK_JOB_KIND,
} from '../daemon-rebuild/quick-soak-job.mjs';
import { alertsFilePath, readReadyCandidate, readRebuildState, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { completeSmokePass, smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { DISPATCH_DRY_RUN_CODE_ENTRIES, SMOKE_CHECKS, runLiveSmoke, runLiveSmokeWithRetry } from '../daemon-live-smoke.mjs';

vi.mock('../resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn() }));
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'we-quick-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);
const prevHead = 'b'.repeat(40);
const closure = { complete: true, bareDeps: true, jsonNames: new Set(['dispatch-settings.json']), files: new Set([...DISPATCH_DRY_RUN_CODE_ENTRIES, 'scripts/operations/dispatch-lane.mjs']) };
const decision = (changedFiles, extra = {}) => decideQuick({ enabled: true, changedFiles, dispatchClosure: closure, ...extra });

describe('quick mode policy (default OFF)', () => {
  it('off preserves full checks and the existing finalize/starvation wait', () => {
    expect(decision(null, { enabled: false })).toEqual({ quick: false, why: 'disabled' });
    expect(quickFinalizeWaitMs({ quick: false, env: {}, waitMs: 900_000 })).toBe(900_000);
    expect(quickFinalizeWaitMs({ quick: false, env: {}, waitMs: 60_000 })).toBe(180_000);
    expect(quickFinalizeWaitMs({ quick: false, env: {}, overrideWaitMs: 123 })).toBe(123);
  });

  it('resolves standard → platform → tool → env with provenance; malformed settings stay off', () => {
    const path = join(temp(), 'settings.json');
    writeFileSync(path, '{}');
    expect(resolveQuick({}, { path, platform: {} })).toMatchObject({ quick: false, source: 'standard' });
    expect(resolveQuick({}, { path, platform: { quick: true } })).toMatchObject({ quick: true, source: 'platform' });
    writeFileSync(path, JSON.stringify({ daemonRebuild: { quick: false } }));
    expect(resolveQuick({}, { path, platform: { quick: true } })).toMatchObject({ quick: false, source: 'tool' });
    expect(resolveQuick({ WE_DAEMON_REBUILD_QUICK: '1' }, { path })).toMatchObject({ quick: true, source: 'env' });
    writeFileSync(path, JSON.stringify({ daemonRebuild: { quick: true } }));
    expect(resolveQuick({ WE_DAEMON_REBUILD_QUICK: '0' }, { path })).toMatchObject({ quick: false, source: 'env' });
    writeFileSync(path, '{');
    expect(resolveQuick({}, { path, platform: {} }).quick).toBe(false);
  });

  it('logs the effective setting and its cascade source', () => {
    const log = vi.fn();
    resolveQuick({ WE_DAEMON_REBUILD_QUICK: '1', WE_POLICY_CASCADE_LOG: '1' }, { path: join(temp(), 'missing'), log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('quick=true (env)'));
  });

  it('permits an unrelated readable change', () => { expect(decision(['README.md']).quick).toBe(true); });
  it.each([
    ...DISPATCH_DRY_RUN_CODE_ENTRIES,
    'scripts/operations/dispatch-lane.mjs',
    'scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-boot-smoke.mjs',
    'scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-rebuild-extra.mjs',
    'scripts/lib/daemon-rebuild/smoke.mjs', 'scripts/lib/daemon-rebuild/nested/new.mjs',
  ])('always uses full smoke for dispatch/smoke/rebuild code: %s', path => {
    expect(decision([path])).toMatchObject({ quick: false, why: expect.stringContaining('protected') });
  });
  it.each(['package.json', 'package-lock.json', 'nested/package-lock.json', 'scripts/dispatch-settings.json'])(
    'always uses full smoke for dispatch package/config dependency: %s', path => {
      expect(decision([path])).toMatchObject({ quick: false, why: expect.stringContaining('protected') });
    });
  it.each([
    { bareDeps: undefined }, { bareDeps: null }, { jsonNames: undefined }, { jsonNames: [] },
  ])('fails closed when dispatch dependency evidence is missing or malformed: %j', evidence => {
    expect(decision(['README.md'], { dispatchClosure: { ...closure, ...evidence } }))
      .toMatchObject({ quick: false, why: expect.stringContaining('unknown dispatch import closure') });
  });
  it('exports a single protected path list including the dispatch entries', () => {
    expect(QUICK_ALWAYS_FULL_PATHS).toEqual(expect.arrayContaining(DISPATCH_DRY_RUN_CODE_ENTRIES));
  });
  it('fails closed on unknown/incomplete diff or dispatch evidence, with a full-path explanation', () => {
    for (const changedFiles of [null, ['../escape'], [null], new Array(10_001).fill('a')]) {
      expect(decision(changedFiles)).toMatchObject({ quick: false, why: expect.stringContaining('unknown') });
    }
    expect(decision(['README.md'], { dispatchClosure: { ...closure, complete: false } }).quick).toBe(false);
    expect(decision(['README.md'], { dispatchClosure: null }).quick).toBe(false);
    expect(decision(['README.md'], { dispatchClosure: { complete: true, files: [] } }).quick).toBe(false);
  });
  it('quick finalize is bounded at 60s even after starvation, and an explicit finalize env wins', () => {
    expect(quickFinalizeWaitMs({ quick: true, env: {}, waitMs: 900_000 })).toBe(60_000);
    expect(quickFinalizeWaitMs({ quick: true, env: { WE_DAEMON_FINALIZE_LOCK_WAIT_MS: '777' }, waitMs: 900_000 })).toBe(777);
  });
});

const smokeChild = async (cmd, args) => {
  if (args[1] === 'list') return '[]';
  if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
  if (cmd === 'node') return JSON.stringify({ ok: true });
  return '';
};
describe('quick pre-adopt smoke', () => {
  it('defers exactly dispatch-dry-run and reconcile-dry-run, keeping boot, cleanliness, pool and gh rows', async () => {
    expect(QUICK_DEFERRED_CHECKS).toEqual(['dispatch-dry-run', 'reconcile-dry-run']);
    const out = await runLiveSmoke({ root: temp(), env: { WE_DAEMON_STATE_DIR: temp() }, hostBusy: () => false, runChild: smokeChild,
      deferredChecks: QUICK_DEFERRED_CHECKS });
    expect(out.results.map(row => row.name)).toEqual(SMOKE_CHECKS.map(row => row.name));
    expect(out.results.filter(row => row.skipped).map(row => row.name).sort()).toEqual([...QUICK_DEFERRED_CHECKS].sort());
    for (const row of out.results) {
      if (QUICK_DEFERRED_CHECKS.includes(row.name)) expect(row.detail).toBe('deferred to post-adopt soak (quick mode)');
      else expect(row.ok).toBe(true);
    }
  });
  it('off adds no quick skip rows', async () => {
    const out = await runLiveSmoke({ root: temp(), env: { WE_DAEMON_STATE_DIR: temp() }, hostBusy: () => false, runChild: smokeChild });
    expect(out.results.some(row => row.detail === 'deferred to post-adopt soak (quick mode)')).toBe(false);
  });
  it('single attempt forbids timeout, auth and transient retries regardless of retry env', async () => {
    const sleep = vi.fn();
    const refreshAuth = vi.fn(async ({ env }) => ({ env }));
    let time = 0;
    const result = await runLiveSmokeWithRetry({ root: temp(), env: { WE_DAEMON_STATE_DIR: temp(), WE_DAEMON_SMOKE_TRANSIENT_RETRIES: '99' },
      singleAttempt: true, deferredChecks: QUICK_DEFERRED_CHECKS, sleep, refreshAuth, clock: () => (time += 40_000),
      runChild: async () => { throw new Error('ETIMEDOUT Bad credentials HTTP 401'); } });
    expect(result.attempts).toBe(1);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

function soakFixture() {
  const root = temp();
  const env = { WE_DAEMON_STATE_DIR: temp(), WE_DAEMON_CLONE_LOCK_ROOT: temp(), WE_DAEMON_JOBS_ROOT: temp() };
  const lastGood = { head: prevHead, mainSha: prevHead, applied: [], at: new Date(0).toISOString() };
  const adoptedMs = Date.now();
  const marker = { quick: true, unverified: true, sha, head: sha, prevHead, lastGood, token: 'test',
    adoptedAt: new Date(adoptedMs).toISOString(), deadline: adoptedMs + QUICK_SOAK_MAX_MS };
  const state = { adopted: { head: sha, unverified: true, inputsKey: 'new' }, unverified: marker };
  writeRebuildState(root, state, env);
  const run = vi.fn(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : '' }));
  const alerts = () => readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, env, marker, state, run, alerts };
}
describe('post-adopt soak', () => {
  it('an interrupted quick reset that cannot recover is quarantined and reports the unavailable soak', async () => {
    const f = soakFixture();
    f.run.mockImplementation(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : args[0] === 'status' ? ' M tracked' : '' }));
    writeRebuildState(f.root, { adopted: f.marker.lastGood, inProgress: { quick: true, verified: false,
      target: sha, prevHead, host: 'foreign-fixture', startedAt: new Date(0).toISOString() } }, f.env);
    const result = await prepareRebuild({ ...f, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe('rebuild-interrupted-unrecoverable');
    expect(readRebuildState(f.root, f.env)).toMatchObject({ inProgress: null, quarantine: { prevHead } });
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(true);
  });
  it('failed soak rolls back to last-good under the write lock and alerts', () => {
    const f = soakFixture();
    settleQuickSoak({ ...f, outcome: 'failed' });
    expect(f.run).toHaveBeenCalledWith(['reset', '--hard', prevHead], expect.objectContaining({ cwd: f.root }));
    const st = readRebuildState(f.root, f.env);
    expect(st.unverified).toBeNull();
    expect(st.adopted).toEqual(f.marker.lastGood);
    expect(st.rejected).toMatchObject({ inputsKey: 'new' });
    expect(f.alerts().at(-1).kind).toBe('quick-soak-failed');
  });
  it('passing soak clears both unverified marks without rollback', () => {
    const f = soakFixture();
    settleQuickSoak({ ...f, outcome: 'passed' });
    expect(readRebuildState(f.root, f.env)).toMatchObject({ unverified: null, adopted: { head: sha } });
    expect(readRebuildState(f.root, f.env).adopted.unverified).toBeUndefined();
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(f.alerts().at(-1).kind).toBe('quick-soak-passed');
  });
  it('dirty rollback fails closed, quarantines and clears the pending mark', () => {
    const f = soakFixture();
    f.run.mockImplementation(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : ' M tracked' }));
    settleQuickSoak({ ...f, outcome: 'failed' });
    const st = readRebuildState(f.root, f.env);
    expect(st.unverified).toBeNull();
    expect(st.quarantine).toMatchObject({ prevHead });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('does not roll back a different head or settle another adoption token', () => {
    const f = soakFixture();
    settleQuickSoak({ ...f, marker: { ...f.marker, token: 'other' }, outcome: 'failed' });
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    f.run.mockImplementation(() => ({ status: 0, stdout: prevHead }));
    settleQuickSoak({ ...f, outcome: 'passed' });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
  });
  it('recovers a durable completed result even if the worker could not acquire the final lock', () => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome: 'passed' });
    expect(recoverQuickSoak({ ...f, now: () => 2000, pidAlive: () => false }).pending).toBe(false);
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
  });
  it.each(['dead', 'expired', 'missing-pid'])('abandoned soak (%s) becomes unavailable, never pending forever', mode => {
    const f = soakFixture();
    f.state.unverified = { ...f.marker, pid: mode === 'missing-pid' ? undefined : 123, host: 'fixture' };
    writeRebuildState(f.root, f.state, f.env);
    recoverQuickSoak({ ...f, now: () => mode === 'expired' ? f.marker.deadline + 1 : 2000, pidAlive: () => mode !== 'dead' });
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
  });
  it('a live bounded soak remains pending so another rebuild cannot displace its adopted tree', () => {
    const f = soakFixture();
    f.state.unverified.pid = 123;
    writeRebuildState(f.root, f.state, f.env);
    expect(recoverQuickSoak({ ...f, pidAlive: () => true }).pending).toBe(true);
    expect(readRebuildState(f.root, f.env).unverified.sha).toBe(sha);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('a live worker cannot extend its deadline beyond one hour from the exact adoptedAt', () => {
    const f = soakFixture();
    const adoptedMs = Date.parse(f.marker.adoptedAt);
    const nowMs = adoptedMs + QUICK_SOAK_MAX_MS + 1;
    f.state.unverified = { ...f.marker, pid: 123, deadline: adoptedMs + 2 * QUICK_SOAK_MAX_MS };
    writeRebuildState(f.root, f.state, f.env);
    const pidAlive = vi.fn(() => true);
    // Neither a dead worker nor expiry of the recorded deadline can independently reject this marker.
    expect(f.state.unverified.deadline).toBeGreaterThan(nowMs);
    expect(recoverQuickSoak({ ...f, now: () => nowMs, pidAlive }).pending).toBe(false);
    expect(pidAlive).toHaveBeenCalledOnce();
    expect(pidAlive).toHaveBeenCalledWith(expect.objectContaining({ pid: 123,
      adoptedAt: f.marker.adoptedAt, deadline: adoptedMs + 2 * QUICK_SOAK_MAX_MS }));
    const state = readRebuildState(f.root, f.env);
    expect(state.unverified).toBeNull();
    expect(state.adopted).toEqual(f.marker.lastGood);
    expect(f.run).toHaveBeenCalledWith(['reset', '--hard', prevHead], expect.objectContaining({ cwd: f.root }));
    expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-unavailable', detail: { rollback: { ok: true } } });
  });
  it('launches detached and returns before any soak check completes', async () => {
    const f = soakFixture();
    const child = new EventEmitter(); child.pid = 123; child.unref = vi.fn();
    const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    await launchQuickSoak({ ...f, spawnFn, readStart: () => 'fixture-start' });
    expect(spawnFn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({ detached: true }));
    expect(child.unref).toHaveBeenCalledOnce();
    expect(readRebuildState(f.root, f.env).unverified.pid).toBe(123);
    expect(readRebuildState(f.root, f.env).unverified.jobId).toEqual(expect.any(String));
    expect(QUICK_SOAK_JOB_KIND).toMatchObject({ maxAttempts: 1, codeMode: 'readonly-tree' });
  });
  it('failed launch records unavailable and rolls back without waiting for a later tick', async () => {
    const f = soakFixture();
    await launchQuickSoak({ ...f, spawnFn: () => { throw new Error('unavailable'); } });
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
  });
  it('runs both deferred checks and final cleanliness once, against the adopted root', async () => {
    const f = soakFixture();
    const smoke = vi.fn(async () => ({ pass: true, results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: true })) }));
    await runQuickSoak({ ...f, smoke });
    expect(smoke).toHaveBeenCalledOnce();
    expect(smoke).toHaveBeenCalledWith(expect.objectContaining({ root: f.root,
      onlyChecks: ['dispatch-dry-run', 'reconcile-dry-run', 'tree-stays-clean'],
      changedFiles: null, reuseCode: false }));
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
  });
  it('excludes a concurrent writer while a soak check is open and admits it after checks finish', async () => {
    const f = soakFixture();
    let checkStarted;
    let finishCheck;
    const started = new Promise(resolve => { checkStarted = resolve; });
    const heldCheck = new Promise(resolve => { finishCheck = resolve; });
    const smoke = vi.fn(async () => {
      checkStarted();
      await heldCheck;
      return { pass: true, results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: true })) };
    });
    // A distinct owner models another writer even though the fixture shares this process.
    const writerOptions = { owner: 'soak-test-writer', lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 0 };
    const writer = vi.fn(() => 'entered');
    const soaking = runQuickSoak({ ...f, smoke });
    try {
      await started;
      const blocked = await withWriteLock(f.root, writer, writerOptions);
      expect(blocked).toMatchObject({ ok: false, reason: 'tick-in-progress' });
      expect(writer).not.toHaveBeenCalled();
      expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    } finally {
      finishCheck();
      await soaking;
    }
    expect(smoke).toHaveBeenCalledOnce();
    expect(f.alerts().at(-1).kind).toBe('quick-soak-passed');
    expect(await withWriteLock(f.root, writer, writerOptions)).toEqual({ ok: true, value: 'entered' });
    expect(writer).toHaveBeenCalledOnce();
  });
  it.each([true, false])('both dry runs pass, dirty afterwards=%s: fail and roll back or pass only after settlement', async dirty => {
    const f = soakFixture();
    const calls = [];
    let result;
    const expectUnverified = () => {
      expect(readRebuildState(f.root, f.env)).toMatchObject({
        unverified: f.marker, adopted: { head: sha, unverified: true },
      });
    };
    // Settlement still probes rollback safety independently; persistent dirt is covered above.
    f.run.mockImplementation(args => {
      if (args[0] === 'reset') expectUnverified();
      return { status: 0, stdout: args[0] === 'rev-parse' ? sha : '' };
    });
    const smoke = async options => {
      result = await runLiveSmoke({ ...options, repos: ['we'], hostBusy: () => false,
        runChild: async (cmd, args) => {
          expectUnverified();
          if (cmd === 'git') {
            if (!calls.length) { calls.push('before'); return ''; }
            expect(calls).toEqual(['before', 'reconcile', 'dispatch']);
            calls.push('after');
            return dirty ? ' M tracked' : '';
          }
          if (args[0] === 'scripts/conveyor/reconcile-pass.mjs') {
            calls.push('reconcile');
            return '{}';
          }
          expect(cmd).toBe('node');
          expect(args[0]).toBe('--input-type=module');
          calls.push('dispatch');
          return JSON.stringify([{ kind: 'fixture', ok: true }]);
        },
      });
      expectUnverified();
      return result;
    };
    await runQuickSoak({ ...f, smoke });
    expect(calls).toEqual(['before', 'reconcile', 'dispatch', 'after']);
    expect(result.results.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: 'reconcile-dry-run', ok: true },
      { name: 'dispatch-dry-run', ok: true },
      { name: 'tree-stays-clean', ok: !dirty },
    ]);
    expect(result.pass).toBe(!dirty);
    const state = readRebuildState(f.root, f.env);
    expect(state.unverified).toBeNull();
    if (dirty) {
      expect(f.run).toHaveBeenCalledWith(['reset', '--hard', prevHead], expect.objectContaining({ cwd: f.root }));
      expect(state.adopted).toEqual(f.marker.lastGood);
      expect(state.rejected).toMatchObject({ reason: 'quick-soak-failed' });
      expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-failed', detail: { rollback: { ok: true } } });
    } else {
      expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
      expect(state.adopted.head).toBe(sha);
      expect(state.adopted.unverified).toBeUndefined();
      expect(f.alerts().at(-1).kind).toBe('quick-soak-passed');
    }
  });
  it.each([[], [{ name: 'dispatch-dry-run', ok: true, skipped: true }],
    QUICK_DEFERRED_CHECKS.map(name => ({ name, ok: true })),
    ['tree-stays-clean', ...QUICK_DEFERRED_CHECKS].map(name => ({ name, ok: true })),
    [...QUICK_DEFERRED_CHECKS.map(name => ({ name, ok: true })), { name: 'tree-stays-clean', ok: true, skipped: true }],
  ].map(results => ({ results })))('incomplete, skipped or non-final cleanliness evidence is unavailable: $results', async ({ results }) => {
    const f = soakFixture();
    await runQuickSoak({ ...f, smoke: async () => ({ pass: true, results }) });
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
  });
  it.each(['skipped', 'disabled'])('%s soak evidence with all passing rows is unavailable and rolls back', async mode => {
    const f = soakFixture();
    const results = QUICK_SOAK_CHECKS.map(name => ({ name, ok: true }));
    if (mode === 'skipped') results[0].skipped = true;
    await runQuickSoak({ ...f, smoke: async () => ({ pass: true, results, ...(mode === 'disabled' ? { disabled: true } : {}) }) });
    const state = readRebuildState(f.root, f.env);
    expect(state.unverified).toBeNull();
    expect(state.adopted).toEqual(f.marker.lastGood);
    expect(f.run).toHaveBeenCalledWith(['reset', '--hard', prevHead], expect.objectContaining({ cwd: f.root }));
    expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-unavailable', detail: { rollback: { ok: true } } });
    expect(f.alerts().some(row => row.kind === 'quick-soak-passed')).toBe(false);
  });
});

// These local Git fixtures use only init/add/commit/reset/update-ref: no network, fetch or push.
function candidateFixture(changedPath = 'README.md', quick = '1', { seed = () => {}, change } = {}) {
  const root = temp();
  const env = { ...process.env, WE_DAEMON_STATE_DIR: temp(), WE_DAEMON_CLONE_LOCK_ROOT: temp(),
    WE_DAEMON_OVERLAY_DIR: temp(), LANE_POOL_ROOT: temp(), WE_DAEMON_REBUILD_QUICK: quick,
    WE_PLATFORM_PREFERENCES_FILE: join(temp(), 'absent.json') };
  const run = (args, opts = {}) => spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', cwd: root, ...opts });
  const git = args => {
    const result = run(args);
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git(['init', '-q', '-b', 'main']);
  for (const entry of DISPATCH_DRY_RUN_CODE_ENTRIES) write(entry, 'export const v = 1;\n');
  write('README.md', 'old\n');
  seed({ write, git });
  git(['add', '.']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  if (change) change({ write, git });
  else write(changedPath, 'export const v = 2;\n');
  git(['add', '.']); git(['commit', '-qm', 'target']);
  const target = git(['rev-parse', 'HEAD']);
  git(['reset', '--hard', base]);
  git(['update-ref', 'refs/remotes/origin/main', base]);
  const lease = { token: 'fixture', path: join(env.WE_DAEMON_STATE_DIR, 'candidate') };
  writeRebuildState(root, { adopted: { head: base, mainSha: base, applied: [] }, building: lease }, env);
  const plan = { ok: true, finalSha: target, mainSha: base, applied: [], inputsKey: 'fixture', decisions: [] };
  return { root, env, run, plan, prevHead: base, lease, git };
}
const smokeOptions = f => ({ ...f, stEnv: f.env, stateOpts: {}, log: { error: vi.fn() }, now: Date.now,
  overlaysBefore: [], prepAlerts: [], mainOnly: false, finalLockOpts: { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 100 },
  dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: vi.fn(), match: vi.fn() }, readyOnly: true });
const passed = () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } });
const completePassed = () => ({ verdict: 'pass', attempts: 1,
  smoke: { results: SMOKE_CHECKS.map(({ name }) => ({ name, ok: true, ms: 0 })) } });

const dependency = 'scripts/lib/quick-mode-test-dependency.mjs';
const renamedDependency = 'scripts/lib/renamed-quick-mode-test-dependency.mjs';
function dependencyFixture(action) {
  return candidateFixture('README.md', '1', {
    seed: ({ write, git }) => {
      // Keep the dispatch entry identical across the move: editing it would independently force full
      // smoke and hide a broken closure union. A literal lazy import may name a not-yet-present module.
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0],
        "export async function checkDependency() { return import('../lib/quick-mode-test-dependency.mjs'); }\n");
      if (action !== 'add') write(dependency, 'export const fixture = true;\n');
      git(['config', 'diff.renames', 'true']);
    },
    change: ({ write, git }) => {
      if (action === 'rename') git(['mv', dependency, renamedDependency]);
      else if (action === 'remove') git(['rm', dependency]);
      else write(dependency, 'export const fixture = true;\n');
    },
  });
}

async function expectDependencyFullSmoke(f) {
  const options = smokeOptions(f);
  const runSmoke = vi.fn(async () => passed());
  await smokeAndAdopt({ ...options, runSmoke });
  expect(runSmoke).toHaveBeenCalledOnce();
  expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
  expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('deferredChecks');
  // A protected-path explanation proves this is closure evidence, rather than an unknown-evidence fallback.
  expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining(`ignored — full path: protected code changed: ${dependency}`));
  const ready = readReadyCandidate(f.root, f.env);
  expect(ready).toMatchObject({ adopt: { finalSha: f.plan.finalSha } });
  expect(ready).not.toHaveProperty('quick');
}

describe('quick mode through the existing candidate/adoption pipeline', () => {
  it('off keeps the original smoke options and writes an ordinary full-ready record', async () => {
    const f = candidateFixture('README.md', '0');
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...smokeOptions(f), runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
    expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('deferredChecks');
    expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
  });
  it('quick runs one pre-adopt smoke, carries its mark through ready adoption and launches soak', async () => {
    const f = candidateFixture();
    const runSmoke = vi.fn(async () => completePassed());
    await smokeAndAdopt({ ...smokeOptions(f), runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).toMatchObject({ singleAttempt: true, deferredChecks: QUICK_DEFERRED_CHECKS,
      changedFiles: null, reuseCode: false });
    const ready = readReadyCandidate(f.root, f.env);
    expect(ready.quick).toBe(true);
    const launchSoak = vi.fn(async () => ({ started: true }));
    const adopted = await finalizeRebuild({ ...smokeOptions(f), quick: ready.quick, plan: ready.adopt, launchSoak });
    expect(adopted.moved).toBe(true);
    expect(launchSoak).toHaveBeenCalledOnce();
    const st = readRebuildState(f.root, f.env);
    expect(st.adopted).toMatchObject({ head: f.plan.finalSha, unverified: true });
    expect(st.unverified).toMatchObject({ sha: f.plan.finalSha, prevHead: f.prevHead, adoptedAt: expect.any(String) });
    expect(st.smokePassed).toBeNull();
  });
  it('quick mode alone excludes otherwise cache-eligible complete passes from the full-smoke cache', async () => {
    const full = candidateFixture('README.md', '0');
    const quick = candidateFixture();
    // An unknown prior adoption makes changedFiles null in BOTH modes, so skip-unchanged evidence
    // cannot independently prevent the full-mode positive control from establishing a cache proof.
    writeRebuildState(full.root, { adopted: null, building: full.lease }, full.env);
    writeRebuildState(quick.root, { adopted: null, building: quick.lease }, quick.env);
    const evidence = completePassed();
    expect(completeSmokePass(evidence)).toBe(true);
    const fullSmoke = vi.fn(async () => evidence);
    const quickSmoke = vi.fn(async () => evidence);
    await smokeAndAdopt({ ...smokeOptions(full), runSmoke: fullSmoke });
    await smokeAndAdopt({ ...smokeOptions(quick), runSmoke: quickSmoke });
    expect(fullSmoke).toHaveBeenCalledOnce();
    expect(quickSmoke).toHaveBeenCalledOnce();
    expect(fullSmoke.mock.calls[0][0]).toMatchObject({ changedFiles: null, reuseCode: false });
    expect(quickSmoke.mock.calls[0][0]).toMatchObject({ changedFiles: null, reuseCode: false, singleAttempt: true });
    expect(readRebuildState(full.root, full.env).smokePassed).toEqual([
      expect.objectContaining({ key: expect.any(String), tree: expect.any(String), passedAt: expect.any(String) }),
    ]);
    expect(readReadyCandidate(quick.root, quick.env).quick).toBe(true);
    expect(readRebuildState(quick.root, quick.env).smokePassed).toBeNull();
  });
  it.each(['scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-rebuild/new.mjs', DISPATCH_DRY_RUN_CODE_ENTRIES[0]])(
    'logs why quick is ignored and runs full for %s', async path => {
      const f = candidateFixture(path);
      const options = smokeOptions(f);
      const runSmoke = vi.fn(async () => passed());
      await smokeAndAdopt({ ...options, runSmoke });
      expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
      expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('ignored — full path: protected'));
      expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
    });
  it.each(['package.json', 'package-lock.json', 'scripts/dispatch-settings.json', 'config/other-settings.json'])(
    'retains package/config closure evidence through the pipeline for %s', async path => {
      const f = candidateFixture(path, '1', { seed: ({ write }) => {
        write(DISPATCH_DRY_RUN_CODE_ENTRIES[0],
          "import 'fixture-package';\nexport const configs = ['dispatch-settings.json', 'other-settings.json'];\n");
      } });
      const options = smokeOptions(f);
      const runSmoke = vi.fn(async () => passed());
      await smokeAndAdopt({ ...options, runSmoke });
      expect(runSmoke).toHaveBeenCalledOnce();
      expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
      expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('deferredChecks');
      expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining(`protected code changed: ${path}`));
      expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
    });
  it('uses full smoke when the dispatch closure cannot be computed', async () => {
    const f = candidateFixture('README.md', '1', { seed: ({ write }) => {
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0], 'export const load = name => import(name);\n');
    } });
    const options = smokeOptions(f);
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...options, runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('deferredChecks');
    expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('unknown dispatch import closure'));
    expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
  });
  it('protects both rename endpoints when a dispatch dependency is renamed outside the candidate closure', async () => {
    const f = dependencyFixture('rename');
    // Prove Git recognizes the rename and would hide its protected source endpoint without --no-renames.
    expect(f.git(['diff', '--name-only', '--find-renames=100%', f.prevHead, f.plan.finalSha])).toBe(renamedDependency);
    expect(f.git(['diff', '--name-only', '--no-renames', f.prevHead, f.plan.finalSha]).split('\n').sort())
      .toEqual([dependency, renamedDependency].sort());
    await expectDependencyFullSmoke(f);
  });
  it('protects the old dispatch closure when a dependency disappears from the candidate closure', async () => {
    const f = dependencyFixture('remove');
    expect(f.git(['diff', '--name-only', f.prevHead, f.plan.finalSha])).toBe(dependency);
    await expectDependencyFullSmoke(f);
  });
  it('protects the candidate dispatch closure when a dependency was absent from the old closure', async () => {
    const f = dependencyFixture('add');
    expect(f.git(['diff', '--name-only', f.prevHead, f.plan.finalSha])).toBe(dependency);
    await expectDependencyFullSmoke(f);
  });
  it('keeps plain-main fallback after a code-shaped quick failure and schedules its already-HEAD soak', async () => {
    const f = candidateFixture();
    f.plan.applied = [{ ref: 'lane/work', sha: f.plan.finalSha }];
    f.git(['update-ref', 'refs/remotes/origin/lane/work', f.plan.finalSha]);
    const runSmoke = vi.fn().mockResolvedValueOnce({ verdict: 'code', smoke: { results: [
      { name: 'daemon-entries-boot', ok: false, mayBeTransient: false, ms: 100, detail: 'TypeError: broken boot' },
    ] } }).mockResolvedValue(passed());
    const result = await smokeAndAdopt({ ...smokeOptions(f), overlaysBefore: [{ ref: 'lane/work' }], runSmoke });
    expect(result.reason).toBe('fallback-plain-main');
    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(readReadyCandidate(f.root, f.env)).toMatchObject({ quick: true, kind: 'fallback', adopt: { finalSha: f.prevHead } });
    const ready = readReadyCandidate(f.root, f.env);
    const launchSoak = vi.fn(async ({ marker }) => {
      // Scheduling must never precede the durable unverified marker.
      expect(readRebuildState(f.root, f.env).unverified).toEqual(marker);
      return { started: true };
    });
    const adopted = await finalizeRebuild({ ...smokeOptions(f), quick: ready.quick, plan: ready.adopt, launchSoak });
    expect(adopted).toMatchObject({ moved: false, adopted: true, reason: 'already-adopted' });
    expect(launchSoak).toHaveBeenCalledOnce();
    expect(launchSoak.mock.calls[0][0].marker).toMatchObject({ sha: f.prevHead, quick: true, unverified: true });
    expect(readRebuildState(f.root, f.env)).toMatchObject({
      adopted: { head: f.prevHead, unverified: true }, unverified: { sha: f.prevHead, quick: true },
    });
  });
  it('marks an already-adopted quick SHA unverified without mutating its last-good snapshot', async () => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    const lastGood = { head: f.plan.finalSha, inputsKey: f.plan.inputsKey, mainSha: f.plan.mainSha,
      applied: [], at: new Date(0).toISOString() };
    writeRebuildState(f.root, { adopted: lastGood, building: f.lease }, f.env);
    const launchSoak = vi.fn(async () => ({ started: true }));
    const result = await finalizeRebuild({ ...smokeOptions(f), quick: true, launchSoak });
    expect(result).toMatchObject({ adopted: true, moved: false, reason: 'already-adopted' });
    expect(launchSoak).toHaveBeenCalledOnce();
    const state = readRebuildState(f.root, f.env);
    expect(state.adopted.unverified).toBe(true);
    expect(state.unverified).toMatchObject({ sha: f.plan.finalSha, lastGood });
    expect(state.unverified.lastGood).not.toHaveProperty('unverified');
    expect(state.unverified.deadline).toBe(Date.parse(state.unverified.adoptedAt) + QUICK_SOAK_MAX_MS);
  });
  it('never confirm re-smokes a load-shaped quick failure or drops overlays without that evidence', async () => {
    const f = candidateFixture();
    f.plan.applied = [{ ref: 'lane/work', sha: f.plan.finalSha }];
    f.git(['update-ref', 'refs/remotes/origin/lane/work', f.plan.finalSha]);
    const runSmoke = vi.fn().mockResolvedValueOnce({ verdict: 'code', smoke: { results: [
      { name: 'lane-acquire-release', ok: false, mayBeTransient: false, ms: 1000, detail: 'lane acquire refused (lock contention)' },
    ] } }).mockResolvedValue(passed());
    await smokeAndAdopt({ ...smokeOptions(f), overlaysBefore: [{ ref: 'lane/work' }], runSmoke });
    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(readRebuildState(f.root, f.env).rejected).toMatchObject({ envLoad: true });
    expect(readReadyCandidate(f.root, f.env)).toMatchObject({ quick: true, kind: 'candidate' });
    expect(readReadyCandidate(f.root, f.env).dropRefs).toBeUndefined();
  });
  it('an adopted tree that fails its soak actually returns to the previous Git HEAD', async () => {
    const f = candidateFixture();
    const lastGood = readRebuildState(f.root, f.env).adopted;
    await finalizeRebuild({ ...smokeOptions(f), quick: true, launchSoak: async () => ({ started: true }) });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    await runQuickSoak({ ...f, smoke: async () => ({ pass: false,
      results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: name !== 'dispatch-dry-run' })) }) });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(readRebuildState(f.root, f.env)).toMatchObject({ adopted: lastGood, unverified: null });
  });
});
