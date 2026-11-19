/** @file scripts/lib/__tests__/daemon-rebuild-recovery.test.mjs — Persisted environment-timeout retry boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { readRebuildState, writeRebuildState, readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { envTimeoutRetry, recoveryDue, timeoutRetryAt, resolveRecovery, MAX_OVERLAY_OVERDUE_MS } from '../daemon-rebuild/recovery.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { rebuildCloneAsJob, REBUILD_JOB_KIND, RESULT_SUFFIX } from '../daemon-rebuild/rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';
import { markSucceeded } from '../daemon-jobs.mjs';
import { OVERLAY_ADOPTION_TTL_MS, OVERLAY_ADOPTION_OVERDUE_MS } from '../overlay-adoption.mjs';
import * as edgeFetch from '../daemon-rebuild/edge-fetch.mjs';
import * as planner from '../daemon-rebuild/plan.mjs';
import * as candidate from '../daemon-rebuild/candidate.mjs';
import * as locks from '../daemon-clone-lock.mjs';

const dirs = [];
const settings = { envTimeoutBaseMs: 1000, envTimeoutMaxMs: 4000, overlayOverdueMs: 900000 };
const at = ms => new Date(ms).toISOString();
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(held) {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-recovery-'));
  dirs.push(dir);
  const root = join(dir, 'clone');
  mkdirSync(root);
  const git = args => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  }).trim();
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'file'), 'old'); git(['add', '.']); git(['commit', '-qm', 'old']);
  const target = git(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'file'), 'new'); git(['commit', '-qam', 'new']);
  const head = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', head]);
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_AUTO_REBASE: '0', WE_OVERLAY_STALE: '0',
    WE_DAEMON_RECOVERY_ENV_TIMEOUT_BASE_MS: '1000', WE_DAEMON_RECOVERY_ENV_TIMEOUT_MAX_MS: '4000' };
  writeRebuildState(root, { held }, env);
  const plan = { ok: true, upToDate: false, finalSha: target, mainSha: head, inputsKey: 'recovery-fixture', applied: [], decisions: [], alerts: [] };
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [], refEvidence: new Map() });
  vi.spyOn(planner, 'planRebuild').mockResolvedValue(plan);
  const run = (args, opts) => {
    if (args[0] === 'fetch') throw new Error('network forbidden in recovery fixture');
    if (args[0] === 'rev-list' && args.includes('--remotes=origin')) return { status: 0, stdout: '', stderr: '' };
    const r = spawnSync('git', args, {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const prepare = nowMs => prepareRebuild({ root, env, run, log: { error() {} }, mainOnly: true, now: () => nowMs });
  return { root, env, run, plan, head, prepare };
}

function expectHeld(f, result, held) {
  expect(result).toMatchObject({ terminal: true, result: { reason: 'smoke-env-timeout-backoff', moved: false } });
  expect(readRebuildState(f.root, f.env).held).toEqual(held);
  expect(readRebuildState(f.root, f.env).building).toBeNull();
}

describe('environment-timeout recovery deadlines', () => {
  it('refuses before persisted retryAt and retries exactly at expiry after rereading state', async () => {
    const held = { reason: 'smoke-env-timeout', since: at(1000), updatedAt: at(2000), attempts: 2, retryAt: at(9000) };
    const f = fixture(held);
    expectHeld(f, await f.prepare(8999), held);
    expect(recoveryDue({ state: readRebuildState(f.root, f.env), pending: [], nowMs: 8999, settings })).toBe(false);
    const due = await f.prepare(9000);
    expect(due.terminal).toBe(false);
    expect(due.lease.token).toBeTruthy();
    expect(readRebuildState(f.root, f.env).building.target).toBe(f.plan.finalSha);
    expect(recoveryDue({ state: readRebuildState(f.root, f.env), pending: [], nowMs: 9000, settings })).toBe(true);
  });

  it('retries after a persisted deadline even when a daemon resumes long after expiry', async () => {
    const f = fixture({ reason: 'smoke-env-timeout', updatedAt: at(1000), attempts: 1, retryAt: at(2000) });
    expect((await f.prepare(20000)).terminal).toBe(false);
  });

  it.each([
    ['updatedAt', { since: at(1000), updatedAt: at(2000) }, 3000],
    ['since when updatedAt is absent', { since: at(1000) }, 2000],
  ])('legacy hold without retryAt recovers from persisted %s without sliding the deadline', async (_name, dates, deadline) => {
    const held = { reason: 'smoke-env-timeout', ...dates };
    const f = fixture(held);
    expectHeld(f, await f.prepare(deadline - 100), held);
    expectHeld(f, await f.prepare(deadline - 1), held);
    expect(timeoutRetryAt(readRebuildState(f.root, f.env).held, settings)).toBe(deadline);
    expect((await f.prepare(deadline)).terminal).toBe(false);
  });

  it.each([
    { reason: 'smoke-env-timeout', retryAt: 'invalid', updatedAt: at(1000) },
    { reason: 'smoke-env-timeout' },
  ])('incomplete persisted deadline evidence remains held for operator repair: %j', async held => {
    const f = fixture(held);
    expectHeld(f, await f.prepare(20000), held);
    expect(recoveryDue({ state: readRebuildState(f.root, f.env), pending: [], nowMs: 20000, settings })).toBe(false);
  });

  it('a real timeout outcome persists retryAt and attempts; repeated timeouts retain capped backoff across reloads', async () => {
    const f = fixture(null);
    vi.spyOn(locks, 'withWriteLock').mockImplementation(async (_root, fn) => ({ ok: true, value: await fn() }));
    vi.spyOn(candidate, 'materializeCandidate').mockReturnValue({ ok: true, path: join(f.root, 'candidate') });
    vi.spyOn(candidate, 'removeCandidate').mockImplementation(() => {});
    const runSmoke = vi.fn(async () => ({ verdict: 'env-timeout', smoke: { results: [{ name: 'lane-pool-list', ok: false, ms: 120000, detail: 'timed out' }] } }));
    for (const [nowMs, attempts, deadline] of [[1000, 1, 2000], [2000, 2, 4000], [4000, 3, 8000], [8000, 4, 12000]]) {
      const result = await smokeAndAdopt({ root: f.root, env: f.env, stEnv: f.env, run: f.run, log: { error() {} },
        now: () => nowMs, runSmoke, plan: f.plan, prevHead: f.head, lease: { token: 'fixture', path: join(f.root, 'candidate') },
        overlaysBefore: [], prepAlerts: [], mainOnly: true, stateOpts: {}, finalLockOpts: {},
        dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: () => {}, match: () => false } });
      expect(result.reason).toBe('smoke-env-timeout');
      const state = readRebuildState(f.root, f.env);
      expect(state.held).toMatchObject({ reason: 'smoke-env-timeout', attempts, retryAt: at(deadline), since: at(1000), updatedAt: at(nowMs) });
      expect(state.rejected).toBeNull();
      expectHeld(f, await f.prepare(deadline - 1), state.held);
    }
    expect(runSmoke).toHaveBeenCalledTimes(4);
    expect((await f.prepare(12000)).terminal).toBe(false);
  });

  it('the real ready-only child path reaches smoke again after an env-timeout with unchanged inputs', async () => {
    const f = fixture(null);
    vi.spyOn(locks, 'withWriteLock').mockImplementation(async (_root, fn) => ({ ok: true, value: await fn() }));
    vi.spyOn(candidate, 'materializeCandidate').mockReturnValue({ ok: true, path: f.root });
    vi.spyOn(candidate, 'removeCandidate').mockImplementation(() => {});
    const runSmoke = vi.fn()
      .mockResolvedValueOnce({ verdict: 'env-timeout', smoke: { results: [{ name: 'lane-pool-list', ok: false, ms: 120000 }] } })
      .mockResolvedValueOnce({ verdict: 'pass', smoke: { results: [] } });
    const child = nowMs => rebuildClone({ root: f.root, env: f.env, run: f.run, log: { error() {} },
      now: () => nowMs, readyOnly: true, asJob: false, mainOnly: true, versions: null, runSmoke,
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: () => {}, match: () => false } });
    expect((await child(1000)).reason).toBe('smoke-env-timeout');
    expect(readRebuildState(f.root, f.env).rejected).toBeNull();
    expect((await child(1999)).reason).toBe('smoke-env-timeout-backoff');
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(await child(2000)).toMatchObject({ reason: 'ready-recorded', readyRecorded: true, target: f.plan.finalSha });
    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(readReadyCandidate(f.root, f.env).adopt.inputsKey).toBe(f.plan.inputsKey);
  });

  it.each(['early', 'recovery'])('%s child with clean evidence records a passed candidate', async launchedBy => {
    const f = fixture(null);
    vi.spyOn(locks, 'withWriteLock').mockImplementation(async (_root, fn) => ({ ok: true, value: await fn() }));
    vi.spyOn(candidate, 'materializeCandidate').mockReturnValue({ ok: true, path: f.root });
    vi.spyOn(candidate, 'removeCandidate').mockImplementation(() => {});
    const runSmoke = vi.fn().mockResolvedValue({ verdict: 'pass', smoke: { results: [] } });
    expect(await rebuildClone({ root: f.root, env: f.env, run: f.run, log: { error() {} },
      now: () => 2000, readyOnly: true, launchedBy, asJob: false, mainOnly: true, versions: null, runSmoke,
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: () => {}, match: () => false } }))
      .toMatchObject({ reason: 'ready-recorded', readyRecorded: true, target: f.plan.finalSha });
    expect(readReadyCandidate(f.root, f.env).adopt.inputsKey).toBe(f.plan.inputsKey);
    expect(runSmoke).toHaveBeenCalledTimes(1);
  });

  it('legacy attempts start at one and successive retry delays cap at the configured maximum', () => {
    const first = envTimeoutRetry({ reason: 'smoke-env-timeout', since: at(100) }, 1000, settings);
    expect(first).toEqual({ attempts: 1, retryAt: at(2000) });
    expect(envTimeoutRetry({ reason: 'smoke-env-timeout', attempts: 30 }, 1000, settings)).toEqual({ attempts: 31, retryAt: at(5000) });
  });
});

describe('overdue recovery launch bounds', () => {
  function queueFixture() {
    const root = mkdtempSync(join(tmpdir(), 'recovery-queue-'));
    dirs.push(root);
    const store = createJobStore(join(root, 'jobs'));
    mkdirSync(store.dir);
    let clock = 2_000_000;
    const invoke = (reason = 'up-to-date', extra = {}) => rebuildCloneAsJob({ root, env: {}, store,
      codeSha: 'a'.repeat(40), now: () => clock, recoverySettings: settings,
      settings: { minIntervalMs: 60000, minIntervalJitterPct: 0 },
      readState: () => ({}), readPending: () => [{ at: at(0) }],
      adopt: async () => ({ reason, plan: { finalSha: 'a'.repeat(40), inputsKey: 'unchanged' } }),
      reattach: async () => {}, evict: () => {}, log: { error() {} }, ...extra });
    return { root, store, invoke, advance: ms => { clock += ms; } };
  }

  it.each([false, true])('spaces overdue recovery across completed jobs and store reloads (readyRecorded=%s)', async readyRecorded => {
    const f = queueFixture();
    expect((await f.invoke()).reason).toBe('rebuild-job-started');
    const rec = f.store.list().records[0];
    f.store.update(rec.id, r => markSucceeded(r, { at: at(2_000_000) }));
    writeFileSync(join(f.store.dir, `${rec.id}${RESULT_SUFFIX}`), JSON.stringify({ reason: readyRecorded ? 'ready-recorded' : 'smoke-env-timeout', readyRecorded }));
    f.advance(59999);
    expect(await f.invoke('up-to-date', { store: createJobStore(f.store.dir) })).toMatchObject({ reason: 'rebuild-job-spaced', retryInMs: 1 });
    expect(f.store.list().records).toHaveLength(1);
    f.advance(1);
    expect((await f.invoke()).reason).toBe('rebuild-job-started');
    expect(f.store.list().records).toHaveLength(2);
  });

  it.each(['env-timeout retryAt', 'overdue registration'])('marks %s launches as recovery', async trigger => {
    const f = queueFixture();
    const readState = trigger === 'env-timeout retryAt'
      ? () => ({ held: { reason: 'smoke-env-timeout', retryAt: at(2_000_000) } }) : () => ({});
    expect((await f.invoke('needs-build', { readState,
      readPending: () => trigger === 'env-timeout retryAt' ? [] : [{ at: at(0) }] })).reason).toBe('rebuild-job-started');
    expect(f.store.list().records[0].input.launchedBy).toBe('recovery');
  });

  it('does not launch unchanged sticky-rejected inputs even after the interval expires', async () => {
    const f = queueFixture();
    const rec = enqueueJob({ store: f.store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40),
      input: { root: f.root, target: 'a'.repeat(40) }, now: 1000 });
    f.store.update(rec.id, r => markSucceeded(r, { at: at(1000) }));
    writeFileSync(join(f.store.dir, `${rec.id}${RESULT_SUFFIX}`), JSON.stringify({ reason: 'still-rejected' }));
    expect((await f.invoke('still-rejected')).reason).toBe('still-rejected');
    expect((await f.invoke('still-rejected')).reason).toBe('still-rejected');
    expect(f.store.list().records).toHaveLength(1);
    expect((await f.invoke('needs-build', { adopt: async () => ({ reason: 'needs-build',
      plan: { finalSha: 'b'.repeat(40), inputsKey: 'changed' } }) })).reason).toBe('rebuild-job-started');
  });
});

describe('recovery setting retention bound', () => {
  it.each([MAX_OVERLAY_OVERDUE_MS + 1, OVERLAY_ADOPTION_TTL_MS - 1, OVERLAY_ADOPTION_TTL_MS, OVERLAY_ADOPTION_TTL_MS + 1])('clamps overlayOverdueMs=%s and logs the environment source', value => {
    const log = vi.fn();
    const resolved = resolveRecovery({ tool: { overlayOverdueMs: value }, log,
      env: { WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), 'absent-recovery-preferences.json'),
        WE_DAEMON_RECOVERY_OVERLAY_OVERDUE_MS: String(value) } });
    expect(MAX_OVERLAY_OVERDUE_MS).toBe(15 * 60_000);
    expect(resolved.overlayOverdueMs).toBe(15 * 60_000);
    expect(log.mock.calls.flat().join('\n')).toContain(`overlayOverdueMs=${MAX_OVERLAY_OVERDUE_MS} (source env; clamped to maximum`);
    expect(recoveryDue({ state: {}, pending: [{ at: at(0) }], nowMs: resolved.overlayOverdueMs, settings: resolved })).toBe(true);
  });

  it('clamps oversized tool settings with tool provenance', () => {
    const log = vi.fn();
    expect(resolveRecovery({ tool: { overlayOverdueMs: OVERLAY_ADOPTION_TTL_MS - 1 }, env: {}, log }).overlayOverdueMs).toBe(MAX_OVERLAY_OVERDUE_MS);
    expect(log.mock.calls.flat().join('\n')).toContain('source tool; clamped');
  });

  it('accepts the cap and preserves the standard overdue threshold', () => {
    expect(resolveRecovery({ tool: { overlayOverdueMs: MAX_OVERLAY_OVERDUE_MS }, env: {} }).overlayOverdueMs).toBe(MAX_OVERLAY_OVERDUE_MS);
    expect(resolveRecovery({ tool: {}, env: {} }).overlayOverdueMs).toBe(OVERLAY_ADOPTION_OVERDUE_MS);
  });

  it.each(['tool', 'env'])('honours a shorter overdue threshold from %s', source => {
    const value = 5 * 60_000;
    const resolved = resolveRecovery({ tool: { overlayOverdueMs: value },
      env: source === 'env' ? { WE_DAEMON_RECOVERY_OVERLAY_OVERDUE_MS: String(value) } : {}, log: vi.fn() });
    expect(resolved.overlayOverdueMs).toBe(value);
    expect(recoveryDue({ state: {}, pending: [{ at: at(0) }], nowMs: value - 1, settings: resolved })).toBe(false);
    expect(recoveryDue({ state: {}, pending: [{ at: at(0) }], nowMs: value, settings: resolved })).toBe(true);
  });
});
