/** @file scripts/lib/__tests__/daemon-rebuild-recovery.test.mjs — Persisted environment-timeout retry boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { readRebuildState, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { envTimeoutRetry, recoveryDue, timeoutRetryAt } from '../daemon-rebuild/recovery.mjs';
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

  it('legacy attempts start at one and successive retry delays cap at the configured maximum', () => {
    const first = envTimeoutRetry({ reason: 'smoke-env-timeout', since: at(100) }, 1000, settings);
    expect(first).toEqual({ attempts: 1, retryAt: at(2000) });
    expect(envTimeoutRetry({ reason: 'smoke-env-timeout', attempts: 30 }, 1000, settings)).toEqual({ attempts: 31, retryAt: at(5000) });
  });
});
