/** Quick rebuild policy, real check selection, and durable post-adopt recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { createJobStore, enqueueJob, launchJob } from '../daemon-jobs-runtime.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { daemonJobsDir } from '../../operations/run-store.mjs';
import {
  decideQuick, QUICK_ALWAYS_FULL_PATHS, QUICK_DEFERRED_CHECKS, quickFinalizeWaitMs,
  resolveQuick, QUICK_SOAK_CHECKS, QUICK_SOAK_MAX_MS,
  matchesQuickProtectedPath,
} from '../daemon-rebuild/quick.mjs';
import {
  launchQuickSoak, launchPinnedSoak, recoverQuickSoak, recordQuickSoakResult, settleQuickSoak, runQuickSoak, handleQuickSoakFatal, QUICK_SOAK_JOB_KIND,
} from '../daemon-rebuild/quick-soak-job.mjs';
import { alertsFilePath, readReadyCandidate, readRebuildState, writeReadyCandidate, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { completeSmokePass, smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { FAILURE_REASONS, rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { DISPATCH_PATH_DEFAULTS } from '../daemon-rebuild/dispatch-paths.mjs';
import { DISPATCH_DRY_RUN_CODE_ENTRIES, SMOKE_CHECKS, rollbackToSha, runLiveSmoke, runLiveSmokeWithRetry } from '../daemon-live-smoke.mjs';

vi.mock('../resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn() }));
vi.mock('../daemon-jobs-runtime.mjs', async importOriginal => {
  const real = await importOriginal();
  return { ...real, launchJob: vi.fn(real.launchJob) };
});
vi.mock('../daemon-clone-lock.mjs', async importOriginal => {
  const real = await importOriginal();
  return { ...real, withWriteLock: vi.fn(real.withWriteLock) };
});
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'we-quick-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);
const prevHead = 'b'.repeat(40);
const decision = (changedFiles, extra = {}) => decideQuick({ enabled: true, changedFiles, ...extra });

describe('quick mode policy (default OFF)', () => {
  it('shipped quick settings default off without an environment override', () => {
    expect(resolveQuick({}, { platform: {} })).toMatchObject({ quick: false, source: 'tool' });
  });
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

  it.each(['\u2028', '\u2029', ' ', '\u00a0', '\u2000', '\u0000', '\u001f', '\u007f', '\u0085', '\u200b'])(
    'falls back to full smoke for unrelated paths containing separator/control %j', char => {
      expect(decision([`docs/a${char}b.md`])).toEqual({ quick: false, why: 'unknown or oversized change set — full smoke required' });
    });
  it('permits an unrelated readable change', () => { expect(decision(['README.md']).quick).toBe(true); });
  it('protects the complete local import closure of the soak and rollback verifier', () => {
    const graph = collectImportClosure({ root: process.cwd(), entries: [
      'scripts/lib/daemon-rebuild/quick-soak-job.mjs', 'scripts/lib/daemon-live-smoke.mjs',
    ] });
    expect(graph?.complete).toBe(true);
    expect(graph.files.size).toBeGreaterThan(100);
    expect([...graph.files].filter(path => decision([path]).quick)).toEqual([]);
  });
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
  it.each(['package.json', 'nested/package.json', 'package-lock.json', 'nested/package-lock.json',
    'dispatch-settings.json', 'scripts/dispatch-settings.json', 'nested/config/dispatch-settings.json'])(
    'always uses full smoke for dispatch package/config dependency: %s', path => {
      expect(decision([path])).toMatchObject({ quick: false, why: expect.stringContaining('protected') });
    });
  it('requires full smoke for a transitive verifier dependency', () => {
    expect(decision(['scripts/lib/red-main-hold.mjs']).quick).toBe(false);
  });
  it.each(['\u2028', '\u2029'])('requires full smoke for a protected filename containing separator %j', separator => {
    const path = `scripts/lib/entry${separator}.mjs`;
    expect(decision([path])).toEqual({ quick: false, why: 'unknown or oversized change set — full smoke required' });
  });
  it.each(QUICK_ALWAYS_FULL_PATHS)('protected pattern has an independently covered path: %s', pattern => {
    const path = pattern.replaceAll('**/', 'nested/').replaceAll('*', 'fixture');
    expect(decision([path])).toMatchObject({ quick: false, file: path });
    // Removing this pattern would expose its witness; scripts/** cannot mask these tests.
    expect(QUICK_ALWAYS_FULL_PATHS.filter(other => matchesQuickProtectedPath(path, other))).toEqual([pattern]);
  });
  it.each([
    'Scripts/lib/daemon-live-smoke.mjs', 'SCRIPTS/lib/daemon-rebuild/quick.mjs',
    'Skills-Src/Conveyor/Review-Daemon.mjs', 'Skills-Src/Conveyor/Dispatched-Agent-System-Prompt.md',
    'Dispatch-Settings.JSON', 'nested/Dispatch-Settings.JSON', 'PACKAGE.JSON', 'nested/Package-Lock.JSON',
  ])('normalizes protected path case while retaining the original diagnostic: %s', path => {
    expect(decision([path])).toEqual({ quick: false, file: path, why: `protected code changed: ${path}` });
  });
  it.each(['caf\u00e9', 'cafe\u0301'])('NFC-normalizes both paths and protected patterns: %s', name => {
    // Current protected names are ASCII; exercise canonical equivalence for future Unicode entries.
    expect(matchesQuickProtectedPath(`SKILLS-SRC/${name}/entry.mjs`, 'skills-src/caf\u00e9/*')).toBe(true);
    expect(matchesQuickProtectedPath('skills-src/caf\u00e9/entry.mjs', `SKILLS-SRC/${name}/*`)).toBe(true);
    expect(matchesQuickProtectedPath('skills-src/cafe/entry.mjs', `skills-src/${name}/*`)).toBe(false);
  });
  it.each(['quick-soak-failed', 'quick-soak-unavailable', 'quick-soak-rollback-failed',
    'quick-soak-failed: checks rejected'])(
    'classifies a quick soak failure as a rebuild-failed event: %s', async reason => {
      const f = soakFixture();
      const emitEvent = vi.fn();
      vi.mocked(withWriteLock).mockResolvedValueOnce({ ok: true,
        value: { terminal: true, result: { moved: false, reason }, alerts: [] } });
      expect(await rebuildClone({ ...f, asJob: false, versions: null, skipCheck: null, emitEvent }))
        .toMatchObject({ moved: false, reason });
      expect(emitEvent).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'rebuild-failed', detail: { reason },
      }), expect.any(Object));
  });
  it('keeps the failure inventory sorted and excludes nested soak diagnostics and the bare prefix', () => {
    expect([...FAILURE_REASONS]).toEqual([...FAILURE_REASONS].sort());
    for (const reason of ['quick-soak-', 'adopted-head-changed-or-unreadable', 'worker-dead-missing-or-expired',
      'worker-launch-failed', 'soak-could-not-run', 'soak-deadline', 'worker-fatal', 'rollback-threw',
      'untracked-list-failed', 'target-list-failed']) expect(FAILURE_REASONS.has(reason)).toBe(false);
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
describe('quick transition identity fence', () => {
  it.each(['settle', 'recover', 'launch', 'fatal', 'launcher', 'prepare-quarantine', 'prepare-interrupted', 'finalize'].flatMap(transition =>
    ['token', 'sha', 'prevHead', 'HEAD'].map(field => ({ transition, field }))).concat(
      ['existing', 'retired', 'target', 'missing-target', 'rejected', 'rejected-sha'].map(field => ({ transition: 'finalize', field }))))(
    '$transition refuses replaced $field without mutating clone state or HEAD', async ({ transition, field }) => {
      const f = soakFixture();
      const log = { error: vi.fn() };
      if (transition === 'finalize') f.state.building = { token: f.marker.token, target: sha };
      const replacement = { ...f.marker, [field]: field === 'token' ? 'replacement' : 'c'.repeat(40) };
      let liveHead = field === 'HEAD' ? 'd'.repeat(40) : sha;
      let expected;
      const replace = () => {
        const state = transition === 'prepare-quarantine'
          ? { quarantine: { token: replacement.token, failedHead: replacement.sha, prevHead: replacement.prevHead,
            reason: 'quick-soak-rollback-failed' } }
          : transition === 'prepare-interrupted'
            ? { inProgress: { ...replacement, target: replacement.sha, verified: false, host: 'foreign', startedAt: new Date(0).toISOString() } }
            : transition === 'finalize'
              ? { ...f.state, unverified: field === 'existing' ? f.marker : null,
                building: { token: field === 'retired' ? 'successor' : f.marker.token,
                  ...(field === 'missing-target' ? {} : { target: field === 'target' ? 'c'.repeat(40) : sha }) },
                ...(field.startsWith('rejected') ? { rejected: { reason: 'quick-soak-failed',
                  inputsKey: field === 'rejected' ? 'new' : 'other', sha } } : {}) }
              : { ...f.state, unverified: replacement };
        if (transition === 'finalize') {
          // Keep the lease valid for candidate replacements; only the named identity may refuse.
          writeReadyCandidate(f.root, { quick: true, token: replacement.token, prevHead: replacement.prevHead,
            adopt: { finalSha: replacement.sha } }, f.env);
        }
        writeRebuildState(f.root, state, f.env);
        expected = readRebuildState(f.root, f.env);
      };
      let injected = false;
      f.run.mockImplementation(args => {
        if (args[0] === 'rev-parse') {
          if (transition.startsWith('prepare') && !injected) { injected = true; replace(); }
          return { status: 0, stdout: liveHead };
        }
        if (args[0] === 'reset') liveHead = args.at(-1);
        return { status: 0, stdout: '' };
      });
      if (transition === 'prepare-quarantine') writeRebuildState(f.root, { quarantine: {
        token: f.marker.token, failedHead: sha, prevHead, reason: 'quick-soak-rollback-failed' } }, f.env);
      else if (transition === 'prepare-interrupted') writeRebuildState(f.root, { inProgress: {
        ...f.marker, target: sha, verified: false, host: 'foreign', startedAt: new Date(0).toISOString() } }, f.env);
      else if (transition === 'launcher') {
        const store = createJobStore(daemonJobsDir(`quick-soak-${cloneKey(f.root)}`, f.env));
        mkdirSync(store.dir, { recursive: true });
        const job = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: sha });
        vi.mocked(launchJob).mockReturnValueOnce(null);
        vi.mocked(withWriteLock).mockImplementationOnce(async (_root, callback) => {
          replace();
          return { ok: true, value: await callback() };
        });
        await launchPinnedSoak({ ...f, log, token: f.marker.token, jobId: job.id });
      } else replace();
      const beforeHead = liveHead;
      const beforeReady = readReadyCandidate(f.root, f.env);
      if (transition === 'launch') {
        const spawnFn = vi.fn();
        await launchQuickSoak({ ...f, log, spawnFn });
        expect(spawnFn).not.toHaveBeenCalled();
      }
      if (transition === 'fatal') {
        vi.mocked(withWriteLock).mockImplementationOnce(async (_root, callback) => {
          replace();
          return { ok: true, value: await callback() };
        });
        writeRebuildState(f.root, f.state, f.env);
        await handleQuickSoakFatal({ ...f, log, token: f.marker.token, error: new Error('late fatal') });
      }
      if (transition === 'settle') settleQuickSoak({ ...f, log, outcome: 'failed' });
      if (transition === 'recover') recoverQuickSoak({ ...f, log, pidAlive: () => false });
      if (transition.startsWith('prepare')) await prepareRebuild({ ...f, log, stateOpts: {}, now: Date.now });
      if (transition === 'finalize') await finalizeRebuild({ ...f, log, now: Date.now, quick: true,
        plan: { finalSha: sha, inputsKey: 'new', applied: [] }, prevHead,
        lease: { token: f.marker.token }, launchSoak: vi.fn() });
      expect(readRebuildState(f.root, f.env)).toEqual(expected);
      expect(readReadyCandidate(f.root, f.env)).toEqual(beforeReady);
      expect(liveHead).toBe(beforeHead);
      expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('marker-identity-mismatch'));
      if (transition === 'finalize' && field !== 'HEAD') expect(f.run).not.toHaveBeenCalled();
    });
});

describe('post-adopt soak', () => {
  it.each([
    ['passed', false], ['failed', false], ['unavailable', false], ['unavailable', true],
  ])('publication lock timeout for %s (existing unavailable: %s) preserves evidence and permits recovery', (outcome, existing) => {
    const f = soakFixture();
    if (existing) recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    let resultFile;
    let previous;
    const io = { link: vi.fn(linkSync), rename: vi.fn(renameSync), write: (path, data, options) => {
      writeFileSync(path, data, options);
      resultFile = path.replace(/\.\d+\.[^.]+\.tmp$/, '');
      expect(resultFile).not.toBe(path);
      previous = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : null;
      // A live holder prevents stale takeover; timeoutMs=0 exercises the real lock helper without waiting.
      writeFileSync(`${resultFile}.lock`, `${process.pid}\n`, { flag: 'wx' });
    } };
    expect(() => recordQuickSoakResult({ ...f, outcome, reason: 'worker-fatal', error: 'worker failed',
      io, resultLockOptions: { timeoutMs: 0 } })).toThrow('withFileLock: timed out waiting for');
    expect(io.link).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
    expect(existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : null).toBe(previous);
    expect(readFileSync(`${resultFile}.lock`, 'utf8')).toBe(`${process.pid}\n`);
    expect(readdirSync(f.env.WE_DAEMON_STATE_DIR).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    recoverQuickSoak({ ...f, pidAlive: () => false });
    expect(readRebuildState(f.root, f.env).unverified).toBeNull();
    expect(f.alerts().at(-1).kind).toBe('quick-soak-unavailable');
  });
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
  it('default rollback preserves its single status read, flags and failure shape', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '' }));
    const root = temp();
    expect(rollbackToSha({ root, sha: prevHead, run })).toEqual({ ok: false, reason: 'status-failed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['status', '--porcelain'],
      { cwd: root, timeout: 60_000, killSignal: 'SIGKILL' });
  });
  it('unreadable tracked status refuses opt-in rollback', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '' }));
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: 'status-failed', detail: 'status=1 signal=none code=none bytes=0 stderr=' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual(['status', '--porcelain', '--untracked-files=no']);
  });
  it('bounds rollback inventory subprocess output to 64 MiB', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '' }));
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true })).toEqual({ ok: true });
    for (const command of ['ls-files', 'ls-tree']) {
      const inventories = run.mock.calls.filter(([args]) => args[0] === command);
      expect(inventories).toHaveLength(1);
      expect(inventories[0][1]).toMatchObject({ maxBuffer: 64 * 1024 * 1024, env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }), timeout: 60_000, killSignal: 'SIGKILL' });
    }
  });
  it.each(['status', 'ls-files', 'ls-tree'])('retries a transient %s read once with optional locks disabled', command => {
    let reads = 0;
    const run = vi.fn(args => args[0] === command && reads++ === 0
      ? { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'locked' }
      : { status: 0, stdout: '' });
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true })).toEqual({ ok: true });
    const calls = run.mock.calls.filter(([args]) => args[0] === command);
    expect(calls).toHaveLength(2);
    for (const [, opts] of calls) expect(opts.env.GIT_OPTIONAL_LOCKS).toBe('0');
  });
  it.each(['status', 'ls-files', 'ls-tree'])('diagnoses failed %s reads without exposing paths', command => {
    const run = vi.fn(args => args[0] === command
      ? { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: 'abc', stderr: 'locked /private/clone/index\nsecret line' }
      : { status: 0, stdout: '' });
    const result = rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true });
    expect(result).toEqual({ ok: false,
      reason: command === 'status' ? 'status-failed' : command === 'ls-files' ? 'untracked-list-failed' : 'target-list-failed',
      detail: 'status=null signal=SIGKILL code=ETIMEDOUT bytes=3 stderr=locked <path>' });
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('retries thrown inventory reads and fails closed with error code evidence', () => {
    const run = vi.fn(args => {
      if (args[0] === 'ls-files') throw Object.assign(new Error('read /private/clone failed'), { code: 'EIO' });
      return { status: 0, stdout: '' };
    });
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: 'untracked-list-failed',
        detail: 'status=unknown signal=none code=EIO bytes=0 stderr=read <path> failed' });
    expect(run.mock.calls.filter(([args]) => args[0] === 'ls-files')).toHaveLength(2);
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('accepts a complete target list larger than the historical 1 MiB cap', () => {
    const run = vi.fn(args => ({ status: 0, stdout: args[0] === 'ls-tree' ? 'file\0'.repeat(220_000) : '' }));
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true })).toEqual({ ok: true });
  });
  it('rolls back with a node_modules-sized ignored tree without enumerating its files', () => {
    const f = candidateFixture('README.md', '1', { seed: ({ write }) => write('.gitignore', 'node_modules/\n') });
    f.git(['reset', '--hard', f.plan.finalSha]);
    const deps = join(f.root, 'node_modules');
    mkdirSync(deps);
    for (let i = 0; i < 20_000; i++) writeFileSync(join(deps, `${String(i).padStart(6, '0')}-${'dependency'.repeat(6)}.js`), 'keep');
    const run = vi.fn(f.run);
    expect(rollbackToSha({ root: f.root, sha: f.prevHead, run, ignoreUntracked: true })).toEqual({ ok: true });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(readFileSync(join(deps, `000000-${'dependency'.repeat(6)}.js`), 'utf8')).toBe('keep');
  }, 60_000);
  it.each([
    { name: 'same path', tracked: 'runtime-sidecar.md', runtime: 'runtime-sidecar.md' },
    { name: 'untracked file obstructs target directory', tracked: 'runtime/target.md', runtime: 'runtime' },
    { name: 'untracked directory obstructs target file', tracked: 'runtime', runtime: 'runtime/sidecar.md' },
    { name: 'ignored sidecar obstructs target file', tracked: 'ignored.md', runtime: 'ignored.md', ignored: true },
    { name: 'case variant', tracked: 'Runtime.md', runtime: 'runtime.md' },
    { name: 'Unicode normalization variant', tracked: 'caf\u00e9.md', runtime: 'cafe\u0301.md' },
    { name: 'case variant directory prefix', tracked: 'Runtime/target.md', runtime: 'runtime' },
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
    { name: 'listing oversized', command: 'ls-tree', result: { status: 0, stdout: 'x'.repeat(64 * 1024 * 1024) + '\0' } },
    ...['ls-files', 'ls-tree'].flatMap(command => ['../x', '/abs', 'a//b', './x', 'a/../b', '', '.'].map(path => ({
      name: `${command} malformed path ${JSON.stringify(path)}`, command,
      result: { status: 0, stdout: `${path}\0` },
    }))),
  ])('unreadable collision evidence refuses rollback: $name', ({ command, result }) => {
    const run = vi.fn(args => args[0] === command ? result : { status: 0, stdout: '' });
    expect(rollbackToSha({ root: temp(), sha: prevHead, run, ignoreUntracked: true }))
      .toEqual({ ok: false, reason: command === 'ls-files' ? 'untracked-list-failed' : 'target-list-failed',
        detail: expect.stringContaining(`bytes=${Buffer.byteLength(result.stdout ?? '')}`) });
    expect(run.mock.calls.filter(([args]) => args[0] === command)).toHaveLength(2);
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
          ? { quarantine: { prevHead: f.prevHead, failedHead: marker.sha, reason: 'quick-soak-rollback-failed' } }
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
      if (recovery === 'persisted-quarantine') {
        expect(alerts).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
          detail: expect.objectContaining({ rollback: { ok: false, reason: 'untracked-collision' } }) }));
        expect(run.mock.calls.some(([args]) => args[0] === 'ls-tree')).toBe(true);
      }
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
    expect(readRebuildState(f.root, f.env)).toMatchObject({ inProgress: null, quarantine: { prevHead, failedHead: sha } });
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
    expect(st.quarantine).toMatchObject({ prevHead, failedHead: sha });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('does not roll back a different head or settle another adoption token', () => {
    const f = soakFixture();
    const before = readRebuildState(f.root, f.env);
    settleQuickSoak({ ...f, marker: { ...f.marker, token: 'other' }, outcome: 'failed' });
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    f.run.mockImplementation(() => ({ status: 0, stdout: prevHead }));
    settleQuickSoak({ ...f, outcome: 'passed' });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
  });
  it.each(['replacement', 'unreadable', 'legacy'])('prepare preserves a different HEAD during quick-soak recovery: %s', async kind => {
    const f = soakFixture();
    const replacement = 'c'.repeat(40);
    f.run.mockImplementation(args => ({ status: args[0] === 'rev-parse' && kind === 'unreadable' ? 1 : 0,
      stdout: args[0] === 'rev-parse' ? replacement : '' }));
    settleQuickSoak({ ...f, outcome: 'failed' });
    if (kind === 'legacy') writeRebuildState(f.root, { quarantine: { prevHead, reason: 'quick-soak-unavailable' } }, f.env);
    const before = readRebuildState(f.root, f.env);
    const result = await prepareRebuild({ ...f, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe(kind === 'legacy' ? 'quarantined' : 'rebuild-in-progress');
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('settlement followed by prepare preserves a real replacement Git HEAD', async () => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    const marker = { quick: true, sha: 'd'.repeat(40), prevHead: f.prevHead,
      token: 'old-adoption', soakAttempts: 3, lastGood: { head: f.prevHead } };
    writeRebuildState(f.root, { unverified: marker, adopted: { head: marker.sha, unverified: true } }, f.env);
    const before = readRebuildState(f.root, f.env);
    const run = vi.fn(f.run);
    settleQuickSoak({ ...f, run, marker, outcome: 'failed', log: { error: vi.fn() } });
    const result = await prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe('rebuild-in-progress');
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('clears legacy quick quarantine already at last-good with quick off and proceeds to adopt later code', async () => {
    const f = candidateFixture('README.md', '0');
    delete f.env.WE_DAEMON_REBUILD_QUICK;
    expect(resolveQuick(f.env).quick).toBe(false);
    writeRebuildState(f.root, { adopted: { head: f.prevHead }, quarantine: {
      prevHead: f.prevHead, reason: 'quick-soak-rollback-failed',
    } }, f.env);
    writeFileSync(join(f.root, 'untracked-sidecar'), 'keep');
    f.git(['update-ref', 'refs/remotes/origin/main', f.plan.finalSha]);
    const run = vi.fn((args, opts) => args[0] === 'fetch' ? { status: 0, stdout: '' } : f.run(args, opts));
    const result = await rebuildClone({ ...f, run, asJob: false, mainOnly: true,
      runSmoke: async () => completePassed(), log: { error: vi.fn() } });
    expect(result.adopted).toBe(true);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(readRebuildState(f.root, f.env).quarantine).toBeNull();
    expect(result.alerts).toContainEqual({ kind: 'quick-soak-quarantine-cleared',
      detail: { prevHead: f.prevHead, via: 'already-at-last-good' } });
    expect(readFileSync(join(f.root, 'untracked-sidecar'), 'utf8')).toBe('keep');
    expect(run.mock.calls.filter(([args]) => args[0] === 'reset').map(([args]) => args))
      .not.toContainEqual(['reset', '--hard', f.prevHead]);
  });
  it.each([
    { name: 'missing stdout', status: { status: 0 } },
    { name: 'null stdout', status: { status: 0, stdout: null } },
    { name: 'buffer stdout', status: { status: 0, stdout: Buffer.alloc(0) } },
    { name: 'numeric stdout', status: { status: 0, stdout: 0 } },
    { name: 'error with zero status', status: { status: 0, stdout: '', error: new Error('status failed') } },
    { name: 'signal with zero status', status: { status: 0, stdout: '', signal: 'SIGTERM' } },
  ])('keeps last-good quick quarantine with $name', async ({ status }) => {
    const f = candidateFixture('README.md', '0');
    writeRebuildState(f.root, { quarantine: { prevHead: f.prevHead, reason: 'quick-soak-rollback-failed' } }, f.env);
    const run = vi.fn((args, opts) => args[0] === 'status' ? status : f.run(args, opts));
    const result = await prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe('quarantined');
    expect(run).toHaveBeenCalledWith(['status', '--porcelain', '--untracked-files=no'], expect.anything());
    expect(readRebuildState(f.root, f.env).quarantine).toMatchObject({ prevHead: f.prevHead });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(result.alerts.some(row => row.kind === 'quick-soak-quarantine-cleared')).toBe(false);
    const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'quick-soak-needs-you',
      detail: expect.objectContaining({ rollback: { ok: false, reason: 'status-failed' } }) }));
  });
  it.each(['dirty', 'unreadable'])('keeps last-good quick quarantine when tracked status is %s', async status => {
    const f = candidateFixture('README.md', '0');
    writeRebuildState(f.root, { quarantine: { prevHead: f.prevHead, reason: 'quick-soak-rollback-failed' } }, f.env);
    if (status === 'dirty') writeFileSync(join(f.root, 'README.md'), 'operator edits');
    const run = vi.fn((args, opts) => status === 'unreadable' && args[0] === 'status'
      ? { status: 1, stdout: '' } : f.run(args, opts));
    const result = await prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(result.result.reason).toBe('quarantined');
    expect(readRebuildState(f.root, f.env).quarantine).toMatchObject({ prevHead: f.prevHead });
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    if (status === 'dirty') expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('operator edits');
  });
  it('pages immediately for a distinct rollback reason or last-good head within the rate-limit window', async () => {
    const f = candidateFixture('README.md', '0');
    writeFileSync(join(f.root, 'README.md'), 'operator edits');
    writeRebuildState(f.root, { quarantine: { prevHead: f.prevHead, reason: 'quick-soak-rollback-failed' } }, f.env);
    let unreadable = false;
    const run = vi.fn((args, opts) => unreadable && args[0] === 'status'
      ? { status: 1, stdout: '' } : f.run(args, opts));
    const time = Date.now();
    const prepare = () => prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: () => time });
    await prepare();
    unreadable = true;
    await prepare();
    const state = readRebuildState(f.root, f.env);
    state.quarantine.prevHead = f.plan.finalSha;
    writeRebuildState(f.root, state, f.env);
    const before = readRebuildState(f.root, f.env);
    await prepare();
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts.filter(row => row.kind === 'quick-soak-needs-you').map(row => [row.detail.lastGood, row.detail.rollback.reason]))
      .toEqual([[f.prevHead, 'dirty'], [f.prevHead, 'status-failed']]);
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it.each([false, true])('rate-limits dirty tracked recovery away from last-good (legacy=%s)', async legacy => {
    const f = candidateFixture('README.md', '0');
    f.git(['reset', '--hard', f.plan.finalSha]);
    writeFileSync(join(f.root, 'README.md'), 'operator edits');
    writeRebuildState(f.root, { quarantine: { prevHead: f.prevHead, reason: 'quick-soak-rollback-failed',
      ...(legacy ? {} : { failedHead: f.plan.finalSha }) } }, f.env);
    const run = vi.fn(f.run);
    const before = readRebuildState(f.root, f.env);
    const log = { error: vi.fn() };
    const time = Date.now();
    for (const elapsed of [0, 20_000]) {
      const result = await prepareRebuild({ ...f, run, log, stateOpts: {}, now: () => time + elapsed });
      expect(result.result.reason).toBe('quarantined');
    }
    if (legacy) {
      expect(readRebuildState(f.root, f.env)).toEqual(before);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('marker-identity-mismatch'));
    } else {
      const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
      expect(alerts.filter(row => row.kind === 'quick-soak-needs-you')).toHaveLength(1);
      expect(readRebuildState(f.root, f.env).quarantine.lastPagedAt).toBe(new Date(time).toISOString());
    }
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('operator edits');
  });
  it('quarantine recovery retries rollback only at its persisted failed HEAD', async () => {
    const f = candidateFixture();
    f.git(['reset', '--hard', f.plan.finalSha]);
    writeRebuildState(f.root, { adopted: { head: f.prevHead }, quarantine: {
      prevHead: f.prevHead, failedHead: f.plan.finalSha, reason: 'quick-soak-rollback-failed',
    } }, f.env);
    const run = vi.fn((args, opts) => args[0] === 'fetch' ? { status: 0, stdout: '' } : f.run(args, opts));
    await prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: Date.now });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(readRebuildState(f.root, f.env).quarantine).toBeNull();
    expect(run.mock.calls.filter(([args]) => args[0] === 'reset').map(([args]) => args))
      .toEqual([['reset', '--hard', f.prevHead]]);
  });
  it('quick disabled rate-limits quarantine pages until the same guarded rollback succeeds', async () => {
    const f = candidateFixture('README.md', '0');
    f.git(['reset', '--hard', f.plan.finalSha]);
    writeRebuildState(f.root, { adopted: { head: f.prevHead }, quarantine: {
      prevHead: f.prevHead, failedHead: f.plan.finalSha, reason: 'quick-soak-rollback-failed',
    } }, f.env);
    let failing = true;
    const run = vi.fn((args, opts) => args[0] === 'ls-tree' && failing ? { status: 1, stdout: '', stderr: 'busy' }
      : args[0] === 'fetch' ? { status: 0, stdout: '' } : f.run(args, opts));
    let time = Date.now();
    const prepare = () => prepareRebuild({ ...f, run, log: { error: vi.fn() }, stateOpts: {}, now: () => time });
    expect((await prepare()).result.reason).toBe('quarantined');
    expect((await prepare()).result.reason).toBe('quarantined');
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts.filter(row => row.kind === 'quick-soak-needs-you')).toHaveLength(1);
    expect(readRebuildState(f.root, f.env).quarantine.lastPagedAt).toBe(new Date(time).toISOString());
    time += 30 * 60_000;
    expect((await prepare()).result.reason).toBe('quarantined');
    const laterAlerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(laterAlerts.filter(row => row.kind === 'quick-soak-needs-you')).toHaveLength(2);
    expect(readRebuildState(f.root, f.env).quarantine.failedHead).toBe(f.plan.finalSha);
    failing = false;
    await prepare();
    expect(readRebuildState(f.root, f.env).quarantine).toBeNull();
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(run.mock.calls.filter(([args]) => args[0] === 'reset').map(([args]) => args))
      .toEqual([['reset', '--hard', f.prevHead]]);
  });
  it.each(['passed', 'failed'])('fatal settlement consumes durable %s evidence without replacing it', async outcome => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome });
    vi.mocked(withWriteLock).mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' });
    await handleQuickSoakFatal({ ...f, token: f.marker.token, error: new Error('settle failed') });
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1).kind).toBe(`quick-soak-${outcome}`);
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(false);
  });
  it.each([1, 3])('fatal attempt %s alerts carry bounded first-line path-redacted errors through durable recovery', async attempts => {
    const f = soakFixture();
    f.marker.soakAttempts = attempts;
    writeRebuildState(f.root, f.state, f.env);
    const error = new Error('failed /private/clone/index C:\\checkout\\file ' + 'x'.repeat(400) + '\nsecond line');
    vi.mocked(withWriteLock).mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' });
    await handleQuickSoakFatal({ ...f, token: f.marker.token, error });
    recoverQuickSoak({ ...f });
    const rows = f.alerts().filter(row => ['quick-soak-retry', 'quick-soak-needs-you', 'quick-soak-unavailable'].includes(row.kind));
    expect(rows.map(row => row.kind)).toEqual(attempts === 1 ? ['quick-soak-retry'] : ['quick-soak-needs-you', 'quick-soak-unavailable']);
    for (const row of rows) {
      expect(row.detail.error).toHaveLength(300);
      expect(row.detail.error).toMatch(/^failed <path> <path> x/);
      expect(row.detail.error).not.toContain('second line');
      expect(row.detail.reason).toBe('worker-fatal');
    }
  });
  it.each(['passed', 'failed'])('late unavailable writes cannot replace a durable %s result', outcome => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome });
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1).kind).toBe(`quick-soak-${outcome}`);
  });
  it.each(['passed', 'failed'])('a concurrent %s result survives publication between an unavailable writer\'s read and write', outcome => {
    const f = soakFixture();
    let interleaved = false;
    let resultFile;
    const io = { write: writeFileSync, rename: renameSync, link: (source, target) => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(JSON.parse(readFileSync(source, 'utf8'))).toMatchObject({
        token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable', reason: 'soak-deadline' });
      // Inject an already-staged competing publication after the initial read. Calling
      // recordQuickSoakResult recursively here would wait on this publisher's own lock.
      const competing = `${source}.competing`;
      writeFileSync(competing, JSON.stringify({ token: f.marker.token, sha: f.marker.sha, outcome }));
      renameSync(competing, target);
      resultFile = target;
      interleaved = true;
      return linkSync(source, target); // EEXIST must preserve the completed evidence.
    } };
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline', io });
    expect(interleaved).toBe(true);
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ token: f.marker.token, sha: f.marker.sha, outcome });
    expect(readdirSync(f.env.WE_DAEMON_STATE_DIR).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1).kind).toBe(`quick-soak-${outcome}`);
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(false);
  });
  it('fatal diagnostics upgrade an existing unavailable record and survive a later bare timeout', () => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    let upgraded = false;
    let resultFile;
    const io = { write: writeFileSync, link: linkSync, rename: (source, target) => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
        token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable', reason: 'soak-deadline' });
      expect(JSON.parse(readFileSync(source, 'utf8'))).toMatchObject({
        token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable',
        reason: 'worker-fatal', error: 'completion lock failed' });
      resultFile = target;
      upgraded = true;
      return renameSync(source, target);
    } };
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'worker-fatal', error: 'completion lock failed', io });
    expect(upgraded).toBe(true);
    const richer = { token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable',
      reason: 'worker-fatal', error: 'completion lock failed' };
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual(richer);
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual(richer);
    expect(readdirSync(f.env.WE_DAEMON_STATE_DIR).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-unavailable',
      detail: { reason: 'worker-fatal', error: 'completion lock failed' } });
  });
  it.each(['foreign sha', 'invalid JSON'])('unavailable diagnostic upgrades preserve %s evidence', async mode => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    const dir = f.env.WE_DAEMON_STATE_DIR;
    const file = join(dir, readdirSync(dir).find(name => name.includes('.quick-soak-') && name.endsWith('.json')));
    const original = mode === 'invalid JSON' ? '{' : JSON.stringify({
      token: f.marker.token, sha: 'other', outcome: 'unavailable', reason: 'soak-deadline' });
    writeFileSync(file, original);
    vi.mocked(withWriteLock).mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' });
    await handleQuickSoakFatal({ ...f, token: f.marker.token, error: new Error('completion lock failed') });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-unavailable',
      detail: { reason: 'worker-dead-missing-or-expired' } });
    expect(f.alerts().at(-1).detail).not.toHaveProperty('error');
  });
  it.each(['passed', 'failed'])('a concurrent %s result survives an unavailable diagnostic upgrade', outcome => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    let interleaved = false;
    let resultFile;
    const io = { write: writeFileSync, rename: renameSync, link: (source, target) => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
        token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable', reason: 'soak-deadline' });
      expect(JSON.parse(readFileSync(source, 'utf8'))).toMatchObject({
        token: f.marker.token, sha: f.marker.sha, outcome: 'unavailable',
        reason: 'worker-fatal', error: 'completion lock failed' });
      // Publish completed evidence before the EEXIST handler re-reads the old timeout.
      const competing = `${source}.competing`;
      writeFileSync(competing, JSON.stringify({ token: f.marker.token, sha: f.marker.sha, outcome }));
      renameSync(competing, target);
      resultFile = target;
      interleaved = true;
      return linkSync(source, target);
    } };
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'worker-fatal', error: 'completion lock failed', io });
    expect(interleaved).toBe(true);
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ token: f.marker.token, sha: f.marker.sha, outcome });
    expect(readdirSync(f.env.WE_DAEMON_STATE_DIR).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1).kind).toBe(`quick-soak-${outcome}`);
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(false);
  });
  it.each(['passed', 'failed'])('completed %s checks supersede a prior unavailable result', outcome => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, outcome: 'unavailable', reason: 'soak-deadline' });
    recordQuickSoakResult({ ...f, outcome });
    recoverQuickSoak({ ...f });
    expect(f.alerts().at(-1).kind).toBe(`quick-soak-${outcome}`);
    expect(f.alerts().some(row => row.kind === 'quick-soak-unavailable')).toBe(false);
  });
  it.each(['token', 'sha'])('fatal recovery rejects a durable result for a mismatched %s', field => {
    const f = soakFixture();
    recordQuickSoakResult({ ...f, marker: { ...f.marker, [field]: 'other' }, outcome: 'passed' });
    return handleQuickSoakFatal({ ...f, token: f.marker.token, error: new Error('settle failed') }).then(() => {
      // A mismatched sha occupies the same token's path: no-clobber preserves it, and
      // recovery must reject that evidence and take the dead-worker fallback.
      expect(f.alerts().at(-1)).toMatchObject({ kind: 'quick-soak-unavailable',
        detail: field === 'sha' ? { reason: 'worker-dead-missing-or-expired' }
          : { reason: 'worker-fatal', error: 'settle failed' } });
      if (field === 'sha') expect(f.alerts().at(-1).detail).not.toHaveProperty('error');
      expect(f.alerts().some(row => row.kind === 'quick-soak-passed')).toBe(false);
      expect(readRebuildState(f.root, f.env).adopted).toEqual(f.marker.lastGood);
    });
  });
  it('worker completion-lock failure retains passed checks for fatal recovery', async () => {
    const f = soakFixture();
    const smoke = vi.fn(async () => ({ pass: true, results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: true })) }));
    vi.mocked(withWriteLock).mockRejectedValueOnce(new Error('completion lock failed'));
    await expect(runQuickSoak({ ...f, smoke })).rejects.toThrow('completion lock failed');
    await handleQuickSoakFatal({ ...f, token: f.marker.token, error: new Error('completion lock failed') });
    expect(smoke).toHaveBeenCalledOnce();
    expect(f.alerts().at(-1).kind).toBe('quick-soak-passed');
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });
  it('fatal handler preserves a newer adoption installed during write-lock acquisition', async () => {
    const f = soakFixture();
    const replacement = { ...f.marker, token: 'new-adoption', sha: 'c'.repeat(40), head: 'c'.repeat(40), pid: 123 };
    let expected;
    vi.mocked(withWriteLock).mockImplementationOnce(async (_root, recover) => {
      // The old worker passed its pre-lock check before another writer installed this adoption.
      writeRebuildState(f.root, { ...f.state, unverified: replacement,
        adopted: { ...f.state.adopted, head: replacement.sha } }, f.env);
      expected = readRebuildState(f.root, f.env);
      return { ok: true, value: await recover() };
    });
    await handleQuickSoakFatal({ ...f, token: f.marker.token, error: new Error('late fatal') });
    expect(withWriteLock).toHaveBeenCalledOnce();
    expect(expected.unverified).toEqual(replacement);
    expect(readRebuildState(f.root, f.env)).toEqual(expected);
    expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('fatal handler cannot settle a different adoption token', async () => {
    const f = soakFixture();
    await handleQuickSoakFatal({ ...f, token: 'old-token', error: new Error('late') });
    expect(readRebuildState(f.root, f.env).unverified).toEqual(f.marker);
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['token', 'sha'].flatMap(field => [1, 3].map(soakAttempts => ({ field, soakAttempts }))))(
    'detached launcher preserves replacement $field adoption during lock acquisition (attempt $soakAttempts)',
    async ({ field, soakAttempts }) => {
      const f = soakFixture();
      const store = createJobStore(daemonJobsDir(`quick-soak-${cloneKey(f.root)}`, f.env));
      mkdirSync(store.dir, { recursive: true });
      const oldJob = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: f.marker.sha });
      const replacementJob = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: f.marker.sha });
      const replacement = { ...f.marker, [field]: field === 'sha' ? 'c'.repeat(40) : 'replacement-token',
        soakAttempts, pid: process.pid, jobId: replacementJob.id };
      let expected;
      vi.mocked(launchJob).mockReturnValueOnce(null);
      vi.mocked(withWriteLock).mockImplementationOnce(async (_root, recover) => {
        writeRebuildState(f.root, { ...f.state, unverified: replacement,
          adopted: { ...f.state.adopted, head: replacement.sha } }, f.env);
        expected = readRebuildState(f.root, f.env);
        return { ok: true, value: await recover() };
      });
      await launchPinnedSoak({ ...f, token: f.marker.token, jobId: oldJob.id, log: { error() {} } });
      expect(withWriteLock).toHaveBeenCalledOnce();
      expect(readRebuildState(f.root, f.env)).toEqual(expected);
      expect(store.read(replacementJob.id)).toEqual(replacementJob);
      expect(f.run).not.toHaveBeenCalled();
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
    const nowMs = mode === 'expired' ? f.marker.deadline + 1 : Date.parse(f.marker.adoptedAt) + 1000;
    // A valid live PID stays pending at this time; dead/missing PID is the only refusal for those cases.
    if (mode !== 'expired') {
      expect(recoverQuickSoak({ ...f, state: { ...f.state, unverified: { ...f.marker, pid: 123 } },
        now: () => nowMs, pidAlive: () => true }).pending).toBe(true);
    }
    const pidAlive = vi.fn(() => mode !== 'dead');
    expect(recoverQuickSoak({ ...f, now: () => nowMs, pidAlive }).pending).toBe(false);
    if (mode === 'missing-pid') expect(pidAlive).not.toHaveBeenCalled();
    else expect(pidAlive).toHaveBeenCalledOnce();
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
  it('detached launcher runs the pinned adoption snapshot after dependency preparation without blocking adoption', async () => {
    const f = soakFixture();
    const control = temp();
    const release = join(control, 'release');
    const proof = join(control, 'proof.json');
    const driver = join(control, 'launcher.mjs');
    // Native Node children need file URLs; Vite rewrites new URL(..., import.meta.url)
    // into HTTP asset URLs that Node's default ESM loader cannot import.
    const libDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const soakUrl = pathToFileURL(join(libDir, 'daemon-rebuild/quick-soak-job.mjs')).href;
    const runtimeUrl = pathToFileURL(join(libDir, 'daemon-jobs-runtime.mjs')).href;
    const stateUrl = pathToFileURL(join(libDir, 'daemon-rebuild/state.mjs')).href;
    const worker = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { runJob } from ${JSON.stringify(runtimeUrl)};
      import { runQuickSoak } from ${JSON.stringify(soakUrl)};
      const watchdog = setTimeout(() => process.exit(1), 10000);
      const result = await runJob({ readStart: () => 'Thu Jan  1 00:00:00 1970',
        steps: [{ name: 'post-adopt-soak', run: ({ input }) =>
        runQuickSoak({ root: input.root, token: input.token,
          run: args => ({ status: 0, stdout: args[0] === 'rev-parse' ? ${JSON.stringify(sha)} : '' }),
          smoke: async ({ onlyChecks }) => {
            writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ cwd: process.cwd(),
              sha: readFileSync('snapshot-sha', 'utf8'),
              dependency: readFileSync('node_modules/ready', 'utf8'), checks: onlyChecks }));
            return { pass: true, results: onlyChecks.map(name => ({ name, ok: true })) };
          }, log: { error() {} } }) }] });
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      clearTimeout(watchdog);
    `;
    writeFileSync(driver, `
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { launchPinnedSoak } from ${JSON.stringify(soakUrl)};
      import { readRebuildState } from ${JSON.stringify(stateUrl)};
      const watchdog = setTimeout(() => process.exit(1), 20000);
      const root = process.argv[2];
      const snapshot = {
        repoDir: root,
        materialize(into) {
          const adopted = readRebuildState(root).unverified.sha;
          writeFileSync(join(into, 'snapshot-sha'), adopted);
          writeFileSync(join(into, 'package.json'), '{"type":"module"}');
          writeFileSync(join(into, 'package-lock.json'), '{"lockfileVersion":3}');
          const entry = join(into, ${JSON.stringify(QUICK_SOAK_JOB_KIND.entry)});
          mkdirSync(dirname(entry), { recursive: true });
          writeFileSync(entry, ${JSON.stringify(worker)});
        },
        install(into) {
          process.send({ event: 'preparing' });
          const until = Date.now() + 15000;
          while (!existsSync(${JSON.stringify(release)})) {
            if (Date.now() > until) throw new Error('dependency preparation not released');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          mkdirSync(join(into, 'node_modules'));
          writeFileSync(join(into, 'node_modules/ready'), 'installed');
        },
      };
      await launchPinnedSoak({ root, token: process.argv[3], jobId: process.argv[5], snapshot,
        run: args => ({ status: 0, stdout: args[0] === 'rev-parse' ? ${JSON.stringify(sha)} : '' }),
        log: { error() {} } });
      clearTimeout(watchdog);
      process.disconnect();
    `);
    // The adopted snapshot differs from the mutable clone; the worker must execute the former.
    writeFileSync(join(f.root, 'snapshot-sha'), 'newer-live-tree');
    let child; let preparing; let completion;
    let diagnostic = '';
    const spawnFn = (cmd, args, opts) => {
      child = spawn(cmd, [driver, ...args.slice(1)], { ...opts,
        env: { ...process.env, ...opts.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
      preparing = new Promise((resolveReady, reject) => {
        child.once('message', resolveReady);
        child.once('error', reject);
        child.once('close', () => reject(new Error(`launcher exited before preparation: ${diagnostic}`)));
      });
      // Attach immediately so a launch error cannot leave an unhandled rejection before assertion.
      preparing.catch(() => {});
      completion = new Promise((resolveDone, reject) => {
        child.once('error', reject);
        child.once('close', code => resolveDone(code));
      });
      completion.catch(() => {});
      return child;
    };
    try {
      expect(await launchQuickSoak({ ...f, spawnFn, readStart: () => 'Thu Jan  1 00:00:00 1970' }))
        .toEqual({ started: true });
      expect(await preparing).toEqual({ event: 'preparing' });
      const pending = readRebuildState(f.root, f.env).unverified;
      expect(pending).toMatchObject({ sha, pid: child.pid });
      expect(existsSync(proof)).toBe(false);
      const store = createJobStore(daemonJobsDir(`quick-soak-${cloneKey(f.root)}`, f.env));
      expect(store.read(pending.jobId).job.status).toBe('queued');
      writeFileSync(release, 'ready');
      expect(await completion, diagnostic).toBe(0);
      expect(JSON.parse(readFileSync(proof, 'utf8'))).toEqual({
        cwd: realpathSync(join(store.dir, '.snapshots', 'code', sha)), sha, dependency: 'installed', checks: QUICK_SOAK_CHECKS,
      });
      expect(store.read(pending.jobId).job).toMatchObject({ status: 'succeeded', codeSha: sha,
        attempts: 1, snapshotKeys: [`code:${sha}`, expect.stringMatching(/^node-modules:/)] });
      expect(readRebuildState(f.root, f.env)).toMatchObject({ unverified: null, adopted: { head: sha } });
      expect(readRebuildState(f.root, f.env).adopted).not.toHaveProperty('unverified');
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGKILL'); await completion; }
    }
  }, 25_000);
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
      changedFiles: null, reuseCode: false, tolerateBaselineUntracked: true }));
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
  it.each([
    ['clean tree', '', '', true],
    ['pre-existing untracked sidecar with clean tracked files', '?? .conveyor/unsupported-repo.json\n', '?? .conveyor/unsupported-repo.json\n', true],
    ['new untracked path during soak', '?? .conveyor/unsupported-repo.json\n', '?? .conveyor/unsupported-repo.json\n?? new.txt\n', false],
    ['modified tracked file during soak', '?? .conveyor/unsupported-repo.json\n', '?? .conveyor/unsupported-repo.json\n M tracked\n', false],
    ['pre-existing modified tracked file', ' M tracked\n', ' M tracked\n', false],
    ['null baseline with untracked sidecar', null, '?? .conveyor/unsupported-repo.json\n', false],
    ['null baseline with clean final tree', null, '', false],
  ])('both dry runs pass: %s settles only on complete cleanliness evidence', async (_name, before, after, passes) => {
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
            if (!calls.length) {
              calls.push('before');
              if (before === null) throw new Error('baseline status unavailable');
              return before;
            }
            expect(calls).toEqual(['before', 'reconcile', 'dispatch']);
            calls.push('after');
            return after;
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
      { name: 'tree-stays-clean', ok: passes },
    ]);
    expect(result.pass).toBe(passes);
    const state = readRebuildState(f.root, f.env);
    expect(state.unverified).toBeNull();
    if (!passes) {
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
  const lease = { token: 'fixture', target, path: join(env.WE_DAEMON_STATE_DIR, 'candidate') };
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

async function expectDependencyFullSmoke(f) {
  const options = smokeOptions(f);
  const runSmoke = vi.fn(async () => passed());
  await smokeAndAdopt({ ...options, runSmoke });
  expect(runSmoke).toHaveBeenCalledOnce();
  expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
  expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('deferredChecks');
  expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('daemon-rebuild: quick=off reason=protected'));
  expect(readReadyCandidate(f.root, f.env)).toMatchObject({ adopt: { finalSha: f.plan.finalSha } });
  expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
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
  it('ready quick candidate is discarded, not adopted, once quick is disabled, with the full finalize lock wait', async () => {
    const f = candidateFixture();
    await smokeAndAdopt({ ...smokeOptions(f), runSmoke: async () => passed() });
    expect(readReadyCandidate(f.root, f.env).quick).toBe(true);
    f.git(['update-ref', 'refs/remotes/origin/main', f.plan.finalSha]);
    vi.mocked(withWriteLock).mockClear();
    const run = vi.fn((args, opts) => args[0] === 'fetch' ? { status: 0, stdout: '' } : f.run(args, opts));
    const runSmoke = vi.fn();
    const result = await rebuildClone({ root: f.root, env: { ...f.env, WE_DAEMON_REBUILD_QUICK: '0' },
      run, runSmoke, asJob: false, adoptOnly: true, skipCheck: () => ({ skip: false }), log: { error: vi.fn() } });
    expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'ready-candidate-discarded',
      detail: expect.objectContaining({ note: 'quick mode disabled — full smoke required' }) }));
    expect(readReadyCandidate(f.root, f.env)).toBeNull();
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(withWriteLock.mock.calls[0][2].waitMs).toBe(180_000);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
  });
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
    const f = candidateFixture('config/other-settings.json', '1', { seed: ({ write }) => {
      write(DISPATCH_DRY_RUN_CODE_ENTRIES[0], "export const config = 'other-settings.json';\n");
    } });
    const options = smokeOptions(f);
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...options, runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).toMatchObject({ singleAttempt: true, deferredChecks: QUICK_DEFERRED_CHECKS });
    expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining('daemon-rebuild: quick=on'));
    expect(readReadyCandidate(f.root, f.env)).toMatchObject({ quick: true, adopt: { finalSha: f.plan.finalSha } });
  });
  it('quick with smoke disabled adopts without marking quick or scheduling soak debt', async () => {
    const f = candidateFixture();
    f.env.WE_DAEMON_SMOKE_DISABLE = '1';
    const runSmoke = vi.fn(runLiveSmokeWithRetry);
    await smokeAndAdopt({ ...smokeOptions(f), runSmoke });
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(await runSmoke.mock.results[0].value).toEqual({ verdict: 'pass', disabled: true });
    const ready = readReadyCandidate(f.root, f.env);
    expect(ready).not.toHaveProperty('quick');
    const launchSoak = vi.fn();
    const adopted = await finalizeRebuild({ ...smokeOptions(f), quick: ready.quick, plan: ready.adopt, launchSoak });
    expect(adopted.moved).toBe(true);
    expect(launchSoak).not.toHaveBeenCalled();
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    const st = readRebuildState(f.root, f.env);
    expect(st.adopted.head).toBe(f.plan.finalSha);
    expect(st.adopted).not.toHaveProperty('unverified');
    expect(st.unverified).toBeNull();
    expect(st.smokePassed).toBeNull();
  });
  it('smoke disable prevents quick debt even when an injected smoke omits disabled metadata', async () => {
    const f = candidateFixture();
    f.env.WE_DAEMON_SMOKE_DISABLE = '1';
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...smokeOptions(f), runSmoke });
    expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
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
  it.each([
    { name: 'missing stdout', res: { status: 0 } },
    { name: 'numeric stdout', res: { status: 0, stdout: 0 } },
    { name: 'error with zero status', res: { status: 0, stdout: 'README.md\0', error: new Error('boom') } },
    { name: 'signal with zero status', res: { status: 0, stdout: 'README.md\0', signal: 'SIGTERM' } },
    { name: 'truncated NUL stream', res: { status: 0, stdout: 'README.md' } },
  ])('requires full smoke when the quick diff is incomplete: $name', async ({ res }) => {
    const f = candidateFixture('README.md', '1');
    const run = vi.fn((args, opts) => args[0] === 'diff' && args.includes('-z') ? res : f.run(args, opts));
    const options = smokeOptions({ ...f, run });
    const runSmoke = vi.fn(async () => passed());
    await smokeAndAdopt({ ...options, runSmoke });
    expect(run.mock.calls.some(([args]) => args[0] === 'diff' && args.includes('-z'))).toBe(true);
    expect(runSmoke).toHaveBeenCalledOnce();
    expect(runSmoke.mock.calls[0][0]).not.toHaveProperty('singleAttempt');
    expect(readReadyCandidate(f.root, f.env)).not.toHaveProperty('quick');
  });
  it('requires full smoke when a transitive verifier dependency is renamed', async () => {
    const f = dependencyFixture('rename');
    // Prove Git recognizes the rename; the quick diff still includes both endpoints.
    expect(f.git(['diff', '--name-only', '--find-renames=100%', f.prevHead, f.plan.finalSha])).toBe(renamedDependency);
    expect(f.git(['diff', '--name-only', '--no-renames', f.prevHead, f.plan.finalSha]).split('\n').sort())
      .toEqual([dependency, renamedDependency].sort());
    await expectDependencyFullSmoke(f);
  });
  it('requires full smoke when a transitive verifier dependency is removed', async () => {
    const f = dependencyFixture('remove');
    expect(f.git(['diff', '--name-only', f.prevHead, f.plan.finalSha])).toBe(dependency);
    await expectDependencyFullSmoke(f);
  });
  it('requires full smoke when a transitive verifier dependency is added', async () => {
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
    writeReadyCandidate(f.root, { quick: true, token: f.lease.token, prevHead: f.prevHead, adopt: f.plan }, f.env);
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
  it.each([false, true].flatMap(refuseBackoffLock => [false, true].map(alreadyHead => ({ refuseBackoffLock, alreadyHead }))))(
    'ready-only load fallback preserves backoff through prepare adoption: $refuseBackoffLock lock refusal, already HEAD=$alreadyHead', async ({ refuseBackoffLock, alreadyHead }) => {
    const f = candidateFixture('README.md', '1', { change: ({ write, git }) => {
      write('README.md', 'new main\n');
      git(['add', '.']); git(['commit', '-qm', 'main moves']);
      write('overlay.md', 'overlay\n');
    } });
    f.plan.mainSha = f.git(['rev-parse', `${f.plan.finalSha}^`]);
    f.git(['update-ref', 'refs/remotes/origin/main', f.plan.mainSha]);
    if (alreadyHead) {
      f.git(['reset', '--hard', f.plan.mainSha]);
      f.prevHead = f.plan.mainSha;
    }
    f.plan.applied = [{ ref: 'lane/work', sha: f.plan.finalSha }];
    f.git(['update-ref', 'refs/remotes/origin/lane/work', f.plan.finalSha]);
    const runSmoke = vi.fn().mockResolvedValueOnce({ verdict: 'code', smoke: { results: [
      { name: 'lane-acquire-release', ok: false, mayBeTransient: false, ms: 1000, detail: 'lane acquire refused (lock contention)' },
    ] } }).mockImplementation(async () => {
      if (refuseBackoffLock) vi.mocked(withWriteLock).mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' });
      return passed();
    });
    await smokeAndAdopt({ ...smokeOptions(f), overlaysBefore: [{ ref: 'lane/work' }], runSmoke });
    const rejection = readReadyCandidate(f.root, f.env).rejectionBackoff;
    expect(rejection).toMatchObject({ envLoad: true, inputsKey: f.plan.inputsKey });
    expect(readReadyCandidate(f.root, f.env)).toMatchObject({ rejectionBackoff: rejection });
    if (!refuseBackoffLock) expect(readRebuildState(f.root, f.env).rejected).toEqual(rejection);
    // Main-only planning still consumes the candidate for plain main. No detached worker in this fixture.
    const run = (args, opts) => args[0] === 'fetch' ? { status: 0, stdout: '' } : f.run(args, opts);
    const launchSoak = vi.fn(async () => ({ started: true }));
    const result = await prepareRebuild({ ...f, run, mainOnly: true, stateOpts: {}, now: Date.now,
      log: { error: vi.fn() }, launchSoak });
    expect(result.result).toMatchObject({ adopted: true, reason: 'ready-adopted' });
    expect(launchSoak).toHaveBeenCalledOnce();
    expect(readRebuildState(f.root, f.env).unverified).toMatchObject({ quick: true, sha: f.plan.mainSha });
    expect(readRebuildState(f.root, f.env).rejected).toEqual(rejection);
  });
  it.each([false, true])('immediate adoption restores backoff when candidate already HEAD=%s', async alreadyHead => {
    const f = candidateFixture();
    if (alreadyHead) f.git(['reset', '--hard', f.plan.finalSha]);
    const rejectionBackoff = { inputsKey: 'failed-overlay', envLoad: true, attempts: 2,
      at: new Date(0).toISOString(), retryAt: new Date(300_000).toISOString(), reason: 'load' };
    const result = await finalizeRebuild({ ...smokeOptions(f), rejectionBackoff });
    expect(result.adopted).toBe(true);
    expect(readRebuildState(f.root, f.env).rejected).toEqual(rejectionBackoff);
  });
  it('an adopted tree that fails its soak actually returns to the previous Git HEAD', async () => {
    const f = candidateFixture();
    const lastGood = readRebuildState(f.root, f.env).adopted;
    writeReadyCandidate(f.root, { quick: true, token: f.lease.token, prevHead: f.prevHead, adopt: f.plan }, f.env);
    await finalizeRebuild({ ...smokeOptions(f), quick: true, launchSoak: async () => ({ started: true }) });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.plan.finalSha);
    await runQuickSoak({ ...f, smoke: async () => ({ pass: false,
      results: QUICK_SOAK_CHECKS.map(name => ({ name, ok: name !== 'dispatch-dry-run' })) }) });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.prevHead);
    expect(readRebuildState(f.root, f.env)).toMatchObject({ adopted: lastGood, unverified: null });
  });
});
