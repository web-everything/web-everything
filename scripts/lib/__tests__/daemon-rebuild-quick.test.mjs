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
import { DISPATCH_PATH_DEFAULTS } from '../daemon-rebuild/dispatch-paths.mjs';
import { DISPATCH_DRY_RUN_CODE_ENTRIES, SMOKE_CHECKS, rollbackToSha, runLiveSmoke, runLiveSmokeWithRetry } from '../daemon-live-smoke.mjs';

vi.mock('../resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn() }));
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'we-quick-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);
const prevHead = 'b'.repeat(40);
const closure = { complete: true, bareDeps: true, jsonNames: new Set(['dispatch-settings.json']), files: new Set([...DISPATCH_DRY_RUN_CODE_ENTRIES, 'scripts/lib/red-main-hold.mjs']) };
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
    ...DISPATCH_PATH_DEFAULTS.map(path => path.replaceAll('*', 'fixture')),
    'scripts/lib/daemon-last-good.mjs', 'scripts/lib/quick-extra.mjs',
    'scripts/lib/daemon-rebuild/quick.mjs', 'scripts/lib/daemon-rebuild/quick-soak-job.mjs',
    'scripts/lib/daemon-rebuild/dispatch-paths.mjs',
    'scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-boot-smoke.mjs',
    'scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-rebuild-extra.mjs',
    'scripts/lib/daemon-rebuild/smoke.mjs', 'scripts/lib/daemon-rebuild/nested/new.mjs',
  ])('always uses full smoke for dispatch/smoke/rebuild code: %s', path => {
    expect(decision([path])).toMatchObject({ quick: false, why: expect.stringContaining('protected') });
  });
  it.each(['package.json', 'package-lock.json', 'nested/package-lock.json',
    'dispatch-settings.json', 'scripts/dispatch-settings.json', 'nested/config/dispatch-settings.json'])(
    'always uses full smoke for dispatch package/config dependency: %s', path => {
      expect(decision([path])).toMatchObject({ quick: false, why: expect.stringContaining('protected') });
    });
  it.each([null, { complete: false }, { complete: true, files: [] },
    { ...closure, bareDeps: undefined, jsonNames: undefined }])(
    'does not consult unknown or incomplete dispatch closure evidence: %j', dispatchClosure => {
      expect(decision(['scripts/lib/red-main-hold.mjs'], { dispatchClosure }).quick).toBe(true);
      expect(decision([DISPATCH_DRY_RUN_CODE_ENTRIES[0]], { dispatchClosure }).quick).toBe(false);
    });
  it('allows a transitive-only dispatch dependency even with complete closure evidence', () => {
    expect(decision(['scripts/lib/red-main-hold.mjs']).quick).toBe(true);
  });
  it('exports a single protected path list including the dispatch entries and shared dispatch core paths', () => {
    expect(QUICK_ALWAYS_FULL_PATHS).toEqual(expect.arrayContaining([...DISPATCH_DRY_RUN_CODE_ENTRIES, ...DISPATCH_PATH_DEFAULTS]));
  });
  it('fails closed on unknown/incomplete diff evidence, with a full-path explanation', () => {
    for (const changedFiles of [null, ['../escape'], [null], new Array(10_001).fill('a')]) {
      expect(decision(changedFiles)).toMatchObject({ quick: false, why: expect.stringContaining('unknown') });
    }
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
  const env = { WE_DAEMON_STATE_DIR: temp(), WE_DAEMON_CLONE_LOCK_ROOT: temp(), WE_DAEMON_JOBS_ROOT: temp(), WE_DAEMON_OVERLAY_DIR: temp() };
  const lastGood = { head: prevHead, mainSha: prevHead, applied: [], at: new Date(0).toISOString() };
  const adoptedMs = Date.now();
  // Existing terminal recovery cases model the final allowed attempt; retry cases reset this counter.
  const marker = { quick: true, unverified: true, sha, head: sha, prevHead, lastGood, token: 'test', soakAttempts: 3,
    adoptedAt: new Date(adoptedMs).toISOString(), deadline: adoptedMs + QUICK_SOAK_MAX_MS };
  const state = { adopted: { head: sha, unverified: true, inputsKey: 'new' }, unverified: marker };
  writeRebuildState(root, state, env);
  const run = vi.fn(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : '' }));
  const alerts = () => readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, env, marker, state, run, alerts };
}
describe('post-adopt soak', () => {
  it('read barrier retries contention and runs the checks on its second attempt', async () => {
    const f = soakFixture();
    const smoke = vi.fn(async () => ({ pass: true, results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: true })) }));
    const readLock = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' })
      .mockImplementationOnce(async (_root, check) => ({ ok: true, value: await check() }));
    const pause = vi.fn(async () => {});
    await runQuickSoak({ ...f, smoke, readLock, pause });
    expect(readLock).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(60_000);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(smoke).toHaveBeenCalledWith(expect.objectContaining({ onlyChecks: QUICK_SOAK_CHECKS }));
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
  });
  it('exhausted read barrier is bounded and pages after the last soak attempt', async () => {
    const f = soakFixture();
    const readLock = vi.fn(async () => ({ ok: false, reason: 'tick-in-progress' }));
    const pause = vi.fn(async () => {});
    const smoke = vi.fn();
    await runQuickSoak({ ...f, smoke, readLock, pause });
    expect(readLock).toHaveBeenCalledTimes(11);
    expect(pause).toHaveBeenCalledTimes(10);
    expect(smoke).not.toHaveBeenCalled();
    expect(f.alerts()).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you', detail: {
      sha, lastGood: prevHead, attempts: 3, reason: 'soak-could-not-run', rollback: { ok: true },
    } }));
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
  });
  it('legacy markers retry unavailable evidence on later ticks, cap at three, then page', async () => {
    const f = soakFixture();
    delete f.marker.soakAttempts;
    writeRebuildState(f.root, f.state, f.env);
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter(); child.pid = 123; child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn')); return child;
    });
    const tokens = [f.marker.token];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const marker = readRebuildState(f.root, f.env).unverified;
      recordQuickSoakResult({ ...f, marker, outcome: 'unavailable' });
      const recovered = recoverQuickSoak({ ...f, state: readRebuildState(f.root, f.env) });
      if (attempt < 3) {
        expect(recovered.pending).toBe(true);
        expect(recovered.retry).toBe(true);
        expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
        // The tick owns relaunch; detached completion/recovery only schedules it.
        await prepareRebuild({ ...f, log: { error: vi.fn() }, stateOpts: {}, now: Date.now,
          launchSoak: opts => launchQuickSoak({ ...opts, spawnFn, readStart: () => 'fixture' }) });
        const next = readRebuildState(f.root, f.env).unverified;
        expect(next.soakAttempts).toBe(attempt + 1);
        expect(next.deadline).toBe(f.marker.deadline);
        expect(tokens).not.toContain(next.token);
        tokens.push(next.token);
      } else {
        expect(recovered.pending).toBe(false);
        expect(readRebuildState(f.root, f.env).unverified).toBeNull();
      }
    }
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(f.alerts().filter(row => row.kind === 'quick-soak-needs-you')).toHaveLength(1);
    expect(f.alerts().find(row => row.kind === 'quick-soak-needs-you').detail.attempts).toBe(3);
  });
  it.each([0, -1, 4, 1_000_000, '2', null])('invalid or exhausted attempt count %j cannot buy another retry', soakAttempts => {
    const f = soakFixture();
    f.marker.soakAttempts = soakAttempts;
    writeRebuildState(f.root, f.state, f.env);
    settleQuickSoak({ ...f, outcome: 'unavailable' });
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
    expect(f.alerts().some(row => row.kind === 'quick-soak-needs-you')).toBe(true);
  });
  it('retry deadline exhaustion settles and pages instead of relaunching', () => {
    const f = soakFixture();
    f.marker.soakAttempts = 1;
    writeRebuildState(f.root, f.state, f.env);
    settleQuickSoak({ ...f, outcome: 'unavailable' });
    expect(recoverQuickSoak({ ...f, state: readRebuildState(f.root, f.env),
      now: () => f.marker.deadline + 1 })).toEqual({ pending: false });
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
    expect(f.alerts().some(row => row.kind === 'quick-soak-needs-you')).toBe(true);
  });
  it('first launch failure persists a retry without rolling back', async () => {
    const f = soakFixture();
    delete f.marker.soakAttempts;
    writeRebuildState(f.root, f.state, f.env);
    await launchQuickSoak({ ...f, spawnFn: () => { throw new Error('unavailable'); } });
    expect(readRebuildState(f.root, f.env).unverified).toMatchObject({ retryPending: true, soakAttempts: 1 });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('tracked-dirty rollback still refuses, quarantines and pages', () => {
    const f = soakFixture();
    f.run.mockImplementation(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : ' M tracked' }));
    settleQuickSoak({ ...f, outcome: 'failed' });
    expect(readRebuildState(f.root, f.env)).toMatchObject({ unverified: null, quarantine: { prevHead } });
    expect(f.alerts()).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
      detail: expect.objectContaining({ sha, lastGood: prevHead, attempts: 3, rollback: { ok: false, reason: 'dirty' } }) }));
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it.each([false, true])('rollback untracked opt-in=%s preserves runtime files and default refusal', ignoreUntracked => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    const runtime = join(f.root, 'runtime-sidecar.md');
    writeFileSync(runtime, 'keep me');
    const options = { root: f.root, sha: f.prevHead, run: f.run };
    const result = rollbackToSha(ignoreUntracked ? { ...options, ignoreUntracked } : options);
    expect(result).toEqual(ignoreUntracked ? { ok: true } : { ok: false, reason: 'dirty' });
    expect(readFileSync(runtime, 'utf8')).toBe('keep me');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(ignoreUntracked ? f.prevHead : f.plan.finalSha);
  });
  it.each([false, true])('real tracked dirt refuses rollback with untracked opt-in=%s', ignoreUntracked => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    writeFileSync(join(f.root, 'README.md'), 'operator edit');
    expect(rollbackToSha({ root: f.root, sha: f.prevHead, run: f.run, ignoreUntracked }))
      .toEqual({ ok: false, reason: 'dirty' });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('operator edit');
  });
  it('unreadable tracked status refuses opt-in rollback', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '' }));
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: 'status-failed' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual(['status', '--porcelain', '--untracked-files=no']);
  });
  it.each([
    { name: 'same path', tracked: 'runtime-sidecar.md', runtime: 'runtime-sidecar.md' },
    { name: 'untracked file obstructs target directory', tracked: 'runtime/target.md', runtime: 'runtime' },
    { name: 'untracked directory obstructs target file', tracked: 'runtime', runtime: 'runtime/sidecar.md' },
    { name: 'ignored sidecar obstructs target file', tracked: 'ignored.md', runtime: 'ignored.md', ignored: true },
  ])('refuses rollback target collision and preserves obstructing bytes: $name', ({ tracked, runtime, ignored }) => {
    const f = candidateFixture('README.md', '1', {
      seed: ({ write, git }) => {
        write(tracked, 'last good tracked content');
        if (ignored) {
          write('.gitignore', 'ignored.md\n');
          git(['add', '-f', '--', tracked]);
        }
      },
      change: ({ git }) => { git(['rm', '--', tracked]); },
    });
    f.git(['reset', '--hard', f.plan.finalSha]);
    const sidecar = join(f.root, runtime);
    mkdirSync(dirname(sidecar), { recursive: true });
    const bytes = Buffer.from([0, 255, 10, 13, 42]);
    writeFileSync(sidecar, bytes);
    expect(rollbackToSha({ root: f.root, sha: f.prevHead, run: f.run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: 'untracked-collision' });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(readFileSync(sidecar)).toEqual(bytes);
    const marker = { quick: true, sha: f.plan.finalSha, prevHead: f.prevHead, token: 'collision',
      soakAttempts: 3, lastGood: { head: f.prevHead } };
    writeRebuildState(f.root, { unverified: marker, adopted: { head: marker.sha, unverified: true } }, f.env);
    expect(settleQuickSoak({ ...f, marker, outcome: 'unavailable' }).rollback)
      .toEqual({ ok: false, reason: 'untracked-collision' });
    expect(readRebuildState(f.root, f.env)).toMatchObject({ unverified: null, quarantine: { prevHead: f.prevHead } });
    const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
      detail: expect.objectContaining({ rollback: { ok: false, reason: 'untracked-collision' } }) }));
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(readFileSync(sidecar)).toEqual(bytes);
  });
  it.each([
    { name: 'untracked listing failed', command: 'ls-files', result: { status: 1, stdout: '' } },
    { name: 'target listing failed', command: 'ls-tree', result: { status: 1, stdout: '' } },
    { name: 'target listing missing', command: 'ls-tree', result: { status: 0 } },
    { name: 'target listing truncated', command: 'ls-tree', result: { status: 0, stdout: 'partial' } },
    { name: 'untracked listing truncated', command: 'ls-files', result: { status: 0, stdout: 'partial' } },
    { name: 'listing oversized', command: 'ls-tree', result: { status: 0, stdout: 'x'.repeat(1024 * 1024) + '\0' } },
  ])('unreadable collision evidence refuses rollback: $name', ({ command, result }) => {
    const run = vi.fn(args => args[0] === command ? result : { status: 0, stdout: '' });
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: 'status-failed' });
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it.each([
    { name: 'ignored sidecar', tracked: 'ignored.md', runtime: 'ignored.md', ignored: true },
    { name: 'ancestor collision', tracked: 'runtime', runtime: 'runtime/sidecar.md' },
  ].flatMap(collision => ['pending-soak', 'persisted-quarantine', 'interrupted-adoption']
    .map(recovery => ({ ...collision, recovery }))))(
    'quick $recovery preserves $name and quarantines + pages without a reset', async ({ tracked, runtime, ignored, recovery }) => {
      const f = candidateFixture('README.md', '1', {
        seed: ({ write, git }) => {
          write(tracked, 'last good tracked content');
          if (ignored) {
            write('.gitignore', 'ignored.md\n');
            git(['add', '-f', '--', tracked]);
          }
        },
        change: ({ git }) => { git(['rm', '--', tracked]); },
      });
      f.git(['reset', '--hard', f.plan.finalSha]);
      const sidecar = join(f.root, runtime);
      mkdirSync(dirname(sidecar), { recursive: true });
      const bytes = Buffer.from([0, 255, 10, 13, 42]);
      writeFileSync(sidecar, bytes);
      const marker = { quick: true, sha: f.plan.finalSha, prevHead: f.prevHead, token: 'recovery-collision',
        soakAttempts: 3, lastGood: { head: f.prevHead } };
      const state = recovery === 'pending-soak'
        ? { unverified: marker, adopted: { head: marker.sha, unverified: true } }
        : recovery === 'persisted-quarantine'
          ? { quarantine: { prevHead: f.prevHead, reason: 'quick-soak-rollback-failed' } }
          : { adopted: marker.lastGood, inProgress: { quick: true, verified: false,
            target: marker.sha, prevHead: f.prevHead, host: 'foreign-fixture', startedAt: new Date(0).toISOString() } };
      writeRebuildState(f.root, state, f.env);
      const run = vi.fn(f.run);
      const result = await prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
      expect(result.result.reason).toBe(recovery === 'interrupted-adoption' ? 'rebuild-interrupted-unrecoverable' : 'quarantined');
      expect(readRebuildState(f.root, f.env)).toMatchObject({ unverified: null, quarantine: { prevHead: f.prevHead } });
      const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
      expect(alerts).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
        detail: expect.objectContaining({ lastGood: f.prevHead, rollback: expect.objectContaining({ ok: false }) }) }));
      expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
      expect(readFileSync(sidecar)).toEqual(bytes);
    });
  it('quick settlement rolls back untracked-only dirt and preserves the sidecar', () => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    const marker = { quick: true, sha: f.plan.finalSha, prevHead: f.prevHead, token: 'runtime',
      soakAttempts: 3, lastGood: { head: f.prevHead } };
    writeRebuildState(f.root, { unverified: marker, adopted: { head: marker.sha, unverified: true } }, f.env);
    writeFileSync(join(f.root, 'runtime-sidecar.md'), 'keep me');
    expect(settleQuickSoak({ ...f, marker, outcome: 'unavailable' }).rollback).toEqual({ ok: true });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(readFileSync(join(f.root, 'runtime-sidecar.md'), 'utf8')).toBe('keep me');
  });
  it('an interrupted quick reset that cannot recover is quarantined and reports the unavailable soak', async () => {
    const f = soakFixture();
    f.run.mockImplementation(args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : args[0] === 'status' ? ' M tracked' : '' }));
    writeRebuildState(f.root, { adopted: f.marker.lastGood, inProgress: { quick: true, verified: false,
      target: sha, prevHead, host: 'foreign-fixture', startedAt: new Date(0).toISOString() } }, f.env);
    const result = await prepareRebuild({ ...f, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe('rebuild-interrupted-unrecoverable');
    expect(readRebuildState(f.root, f.env)).toMatchObject({ inProgress: null, quarantine: { prevHead } });
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(true);
    expect(f.alerts()).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
      detail: expect.objectContaining({ sha, lastGood: prevHead, attempts: 0, cause: 'adoption-interrupted', rollback: { ok: false } }) }));
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

const dependency = 'scripts/lib/red-main-hold.mjs';
const renamedDependency = 'scripts/lib/renamed-red-main-hold.mjs';
function dependencyFixture(action) {
  return candidateFixture('README.md', '1', {
    seed: ({ write, git }) => {
      // Keep the dispatch entry identical across the move: editing it would independently force full
      // smoke and hide whether a transitive-only change allows quick mode.
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0],
        "export async function checkDependency() { return import('../lib/red-main-hold.mjs'); }\n");
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

async function expectDependencyQuickSmoke(f) {
  const options = smokeOptions(f);
  const runSmoke = vi.fn(async () => passed());
  await smokeAndAdopt({ ...options, runSmoke });
  expect(runSmoke).toHaveBeenCalledOnce();
  expect(runSmoke.mock.calls[0][0]).toMatchObject({ singleAttempt: true, deferredChecks: QUICK_DEFERRED_CHECKS });
  expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('daemon-rebuild: quick=on reason='));
  expect(readReadyCandidate(f.root, f.env)).toMatchObject({ quick: true, adopt: { finalSha: f.plan.finalSha } });
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
  it.each([
    { path: 'README.md', setting: '0', quick: false, reason: 'disabled (source env)' },
    { path: 'README.md', setting: '1', quick: true, reason: 'two dry-run checks deferred to post-adopt soak' },
    { path: 'scripts/lib/daemon-last-good.mjs', setting: '1', quick: false,
      reason: 'protected code changed: scripts/lib/daemon-last-good.mjs' },
  ])('logs and persists exactly one quick decision: $path / $setting', async ({ path, setting, quick, reason }) => {
    const f = candidateFixture(path, setting);
    const options = smokeOptions(f);
    const result = await smokeAndAdopt({ ...options, runSmoke: vi.fn(async () => passed()) });
    const lines = options.log.error.mock.calls.map(([line]) => line).filter(line => line.startsWith('daemon-rebuild: quick'));
    expect(lines).toEqual([`daemon-rebuild: quick=${quick ? 'on' : 'off'} reason=${reason}`]);
    const detail = { quick, reason, ...(path !== 'README.md' ? { file: path } : {}) };
    expect(result.alerts.filter(row => row.kind === 'quick-decision')).toEqual([{ kind: 'quick-decision', detail }]);
    const rows = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter(row => row.kind === 'quick-decision')).toEqual([
      { at: expect.any(String), kind: 'quick-decision', detail },
    ]);
  });
  it('allows a transitive-only JSON config change', async () => {
    await expectDependencyQuickSmoke(candidateFixture('config/other-settings.json', '1', { seed: ({ write }) => {
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0], "export const config = 'other-settings.json';\n");
    } }));
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
  it.each(['scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-rebuild/new.mjs',
    'scripts/lib/daemon-rebuild/quick.mjs', 'scripts/lib/daemon-last-good.mjs',
    'scripts/operations/dispatch-lane.mjs', ...DISPATCH_DRY_RUN_CODE_ENTRIES])(
    'logs why quick is ignored and runs full for %s', async path => {
      const f = candidateFixture(path);
      const options = smokeOptions(f);
      const runSmoke = vi.fn(async () => passed());
      await smokeAndAdopt({ ...options, runSmoke });
      expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
      expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('daemon-rebuild: quick=off reason=protected'));
      expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
    });
  it.each(['package.json', 'package-lock.json', 'scripts/dispatch-settings.json'])(
    'protects package/config paths through the pipeline for %s', async path => {
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
  it('allows quick when the dispatch closure cannot be computed', async () => {
    const f = candidateFixture('README.md', '1', { seed: ({ write }) => {
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0], 'export const load = name => import(name);\n');
    } });
    const options = smokeOptions(f);
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...options, runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).toMatchObject({ singleAttempt: true, deferredChecks: QUICK_DEFERRED_CHECKS });
    expect(readReadyCandidate(f.root, f.env)).toMatchObject({ quick: true });
  });
  it('allows quick when a transitive-only dispatch dependency is renamed', async () => {
    const f = dependencyFixture('rename');
    // Prove Git recognizes the rename; the quick diff still includes both endpoints.
    expect(f.git(['diff', '--name-only', '--find-renames=100%', f.prevHead, f.plan.finalSha])).toBe(renamedDependency);
    expect(f.git(['diff', '--name-only', '--no-renames', f.prevHead, f.plan.finalSha]).split('\n').sort())
      .toEqual([dependency, renamedDependency].sort());
    await expectDependencyQuickSmoke(f);
  });
  it('allows quick when a transitive-only dispatch dependency is removed', async () => {
    const f = dependencyFixture('remove');
    expect(f.git(['diff', '--name-only', f.prevHead, f.plan.finalSha])).toBe(dependency);
    await expectDependencyQuickSmoke(f);
  });
  it('allows quick when a transitive-only dispatch dependency is added', async () => {
    const f = dependencyFixture('add');
    expect(f.git(['diff', '--name-only', f.prevHead, f.plan.finalSha])).toBe(dependency);
    await expectDependencyQuickSmoke(f);
  });
  it('keeps plain-main fallback after a code-shaped quick failure and schedules its already-HEAD soak', async () => {
    const f = candidateFixture();
    f.plan.applied = [{ ref: 'lane/work', sha: f.plan.finalSha }];
    f.git(['update-ref', 'refs/remotes/origin/lane/work', f.plan.finalSha]);
    const runSmoke = vi.fn().mockResolvedValueOnce({ verdict: 'code', smoke: { results: [
      { name: 'daemon-entries-boot', ok: false, mayBeTransient: false, ms: 100, detail: 'TypeError: broken boot' },
    ] } }).mockResolvedValue(passed());
    const options = smokeOptions(f);
    const result = await smokeAndAdopt({ ...options, overlaysBefore: [{ ref: 'lane/work' }], runSmoke });
    expect(options.log.error.mock.calls.filter(([line]) => line.startsWith('daemon-rebuild: quick'))).toHaveLength(1);
    expect(result.alerts.filter(row => row.kind === 'quick-decision')).toHaveLength(1);
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
