import { describe, it, expect, vi } from 'vitest';
import { envTimeout, ENV_TIMEOUT_HOLD_STANDARD, resolveEnvTimeoutHold } from '../daemon-rebuild/smoke-classify/env-timeout.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeAndAdopt, failsSameChecks } from '../daemon-rebuild/smoke.mjs';
import { writeRebuildState, readRebuildState } from '../daemon-rebuild/state.mjs';
import { materializeCandidate } from '../daemon-rebuild/candidate.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';

// Exercise the real smokeAndAdopt ladder and persisted state without writing any Git metadata.
vi.mock('../daemon-rebuild/candidate.mjs', () => ({
  candidateSmokeEnv: ({ env }) => env,
  materializeCandidate: vi.fn(({ sha }) => ({ ok: true, path: `/fake/${sha}` })),
  removeCandidate: vi.fn(),
}));
vi.mock('../daemon-clone-lock.mjs', () => ({
  withWriteLock: async (_root, fn) => ({ ok: true, value: await fn() }),
}));
vi.mock('../daemon-rebuild/adopt.mjs', () => ({
  finalizeRebuild: vi.fn(() => ({ adopted: true, moved: true, alerts: [] })),
  staleAlertDetail: () => null,
  dropSuspectOverlays: vi.fn(),
}));

const now = Date.parse('2026-10-14T17:00:00Z');
const failed = [{ name: 'reconcile-dry-run', ok: false, ms: 120_000, detail: 'reconcile failed: timed out after 120000ms (process group killed)' }];
const dispatchTimeout = { ...failed[0], name: 'dispatch-dry-run' };
const interruptedTimeout = { ...failed[0], budgetInterrupted: true,
  detail: 'reconcile-pass dry-run failed for 2/2 repo(s): a: scan exceeded its 120000ms budget; b: skipped: rebuild smoke budget exhausted (0ms left)' };
const smokeResult = { verdict: 'env-timeout', smoke: { results: failed } };

function context(overrides = {}) {
  return {
    env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/env-timeout-test-policy.json' },
    a: { smokeResult }, failedA: failed,
    alert: vi.fn(), hold: vi.fn(), plan: { finalSha: 'candidate' }, prepAlerts: [], alertsList: [],
    now: () => now, heldSince: new Date(now - 60 * 60_000).toISOString(), prevHead: 'last-good',
    smokeSha: vi.fn().mockResolvedValue({ smokeResult }),
    finalize: vi.fn().mockResolvedValue({ adopted: true, moved: true }),
    dispatchOnly: vi.fn().mockResolvedValue({ result: { ok: true } }),
    dispatchFailed: vi.fn().mockReturnValue({ moved: false, reason: 'dispatch-failed' }),
    dispatchPassedAlert: vi.fn(), aSuspects: [], budgetAllows: vi.fn().mockReturnValue(true),
    failedRows: (result) => result.smoke.results.filter((r) => !r.ok),
    failsSameChecks,
    ...overrides,
  };
}

describe('env-timeout hold escape', () => {
  it('keeps hold mode selectable without a control smoke', async () => {
    const ctx = context({ env: { WE_SMOKE_ENV_TIMEOUT_HOLD_MODE: 'hold' } });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.hold).toHaveBeenCalledWith('smoke-env-timeout', failed);
    expect(ctx.smokeSha).not.toHaveBeenCalled();
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout', expect.objectContaining({
      holdPolicy: expect.objectContaining({ mode: 'hold', source: expect.objectContaining({ mode: 'env' }) }),
    }));
  });

  it('holds while younger than the cap', async () => {
    const ctx = context({ heldSince: new Date(now - 44 * 60_000).toISOString() });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.smokeSha).not.toHaveBeenCalled();
  });

  it('adopts when last-good reproduces every candidate timeout', async () => {
    const results = [...failed, dispatchTimeout];
    const candidate = { verdict: 'env-timeout', smoke: { results } };
    const ctx = context({ a: { smokeResult: candidate }, failedA: results,
      smokeSha: vi.fn().mockResolvedValue({ smokeResult: candidate }) });
    expect((await envTimeout.run(ctx)).reason).toBe('env-timeout-adopted-not-worse');
    expect(ctx.smokeSha).toHaveBeenCalledWith('last-good', null, 'last-good', [], {
      failFast: [],
    });
    expect(ctx.budgetAllows).toHaveBeenCalledWith('last-good');
    expect(ctx.finalize).toHaveBeenCalledWith(ctx.plan, undefined, undefined, candidate);
    expect(ctx.hold).not.toHaveBeenCalled();
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-adopted-not-worse', expect.objectContaining({
      reproducedOnLastGood: ['reconcile-dry-run', 'dispatch-dry-run'], heldSinceMinutes: 60,
      holdPolicy: { ...ENV_TIMEOUT_HOLD_STANDARD, source: { mode: 'standard', afterMinutes: 'standard' } },
    }));
  });

  it.each([
    ['subset', failed],
    ['passed sibling', [...failed, { ...dispatchTimeout, ok: true }]],
    ['fail-fast skipped sibling', [...failed, { ...dispatchTimeout, detail: 'skipped: fail-fast — reconcile-dry-run failed' }]],
    ['flagged skipped sibling', [...failed, { ...dispatchTimeout, skipped: true }]],
    ['budget skipped sibling', [...failed, { ...dispatchTimeout, budgetSkipped: true }]],
    ['partially executed check', [interruptedTimeout, dispatchTimeout]],
    ['ordinary error', [{ ...failed[0], detail: 'reconcile failed: invalid configuration' }, dispatchTimeout]],
    ['unmeasured timeout', [{ ...failed[0], ms: 1 }, dispatchTimeout]],
    ['timeout text in ordinary error', [{ ...failed[0], detail: 'assertion failed: timeout option is invalid' }, dispatchTimeout]],
  ])('holds without finalizing when control has %s', async (_label, results) => {
    const candidate = { verdict: 'env-timeout', smoke: { results: [...failed, dispatchTimeout] } };
    const ctx = context({ a: { smokeResult: candidate }, failedA: candidate.smoke.results,
      smokeSha: vi.fn().mockResolvedValue({ smokeResult: { verdict: 'env-timeout', smoke: { results } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.dispatchOnly).not.toHaveBeenCalled();
    expect(ctx.hold).toHaveBeenCalledWith('smoke-env-timeout', ctx.failedA);
  });

  it('holds when a candidate failure is not a measured timeout', async () => {
    const candidate = { verdict: 'env-timeout', smoke: { results: [...failed, { ...dispatchTimeout, detail: 'invalid dispatch configuration' }] } };
    const ctx = context({ a: { smokeResult: candidate }, failedA: candidate.smoke.results,
      smokeSha: vi.fn().mockResolvedValue({ smokeResult: { ...smokeResult, smoke: { results: [...failed, dispatchTimeout] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
  });

  it('holds when a candidate textual skip contains a timeout signature', async () => {
    const skipped = { ...dispatchTimeout, detail: 'skipped: fail-fast — scan exceeded its 120000ms budget' };
    const candidate = { verdict: 'env-timeout', smoke: { results: [...failed, skipped] } };
    const ctx = context({ a: { smokeResult: candidate }, failedA: candidate.smoke.results,
      smokeSha: vi.fn().mockResolvedValue({ smokeResult: { ...smokeResult, smoke: { results: [...failed, dispatchTimeout] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.hold).toHaveBeenCalledWith('smoke-env-timeout', ctx.failedA);
  });

  it.each([
    ['a different kill budget', { detail: 'reconcile failed: timed out after 30000ms (process group killed)' }],
    ['a different kind of give-up', { detail: 'lane scan: scan exceeded its 120000ms budget' }],
    ['a lock give-up', { detail: 'gave up waiting for the shared acquirability-scan lock' }],
  ])('holds when the control times out on the same check but with %s', async (_label, patch) => {
    const controlRow = { ...failed[0], ...patch };
    const ctx = context({ smokeSha: vi.fn().mockResolvedValue({
      smokeResult: { verdict: 'env-timeout', smoke: { results: [controlRow] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.hold).toHaveBeenCalledWith('smoke-env-timeout', ctx.failedA);
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-control-not-equivalent', expect.objectContaining({
      reproducedOnLastGood: [],
    }));
  });

  it('adopts when a scan give-up reproduces with the same budget on every repo', async () => {
    const scan = { ...failed[0], detail: 'reconcile-pass dry-run failed for 2/2 repo(s): a: scan exceeded its 120000ms budget; b: scan exceeded its 60000ms budget' };
    const candidate = { verdict: 'env-timeout', smoke: { results: [scan] } };
    const reordered = { ...scan, detail: 'reconcile-pass dry-run failed for 2/2 repo(s): b: scan exceeded its 60000ms budget; a: scan exceeded its 120000ms budget' };
    const ctx = context({ a: { smokeResult: candidate }, failedA: candidate.smoke.results,
      smokeSha: vi.fn().mockResolvedValue({ smokeResult: { verdict: 'env-timeout', smoke: { results: [reordered] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('env-timeout-adopted-not-worse');
  });

  it('does not report a textual control skip as a reproduced timeout', async () => {
    const skipped = { ...failed[0], detail: 'skipped: budget — scan exceeded its 120000ms budget' };
    const ctx = context({ smokeSha: vi.fn().mockResolvedValue({ smokeResult: { ...smokeResult, smoke: { results: [skipped] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-control-not-equivalent', expect.objectContaining({
      reproducedOnLastGood: [],
    }));
  });

  it('holds when the candidate timeout check was interrupted by the budget', async () => {
    const candidate = { ...smokeResult, smoke: { results: [interruptedTimeout] } };
    const ctx = context({ a: { smokeResult: candidate }, failedA: candidate.smoke.results });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.finalize).not.toHaveBeenCalled();
  });

  it('holds when the control passes', async () => {
    const ctx = context({ smokeSha: vi.fn().mockResolvedValue({ smokeResult: { verdict: 'pass', smoke: { results: [] } } }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-control-passed', expect.any(Object));
    expect(ctx.finalize).not.toHaveBeenCalled();
  });

  it('returns dispatch failure before finalizing when suspects are present', async () => {
    const d = { result: { ok: false } };
    const ctx = context({ aSuspects: [{ ref: 'overlay' }], dispatchOnly: vi.fn().mockResolvedValue(d) });
    expect(await envTimeout.run(ctx)).toEqual({ moved: false, reason: 'dispatch-failed' });
    expect(ctx.dispatchOnly).toHaveBeenCalledWith('candidate', ctx.aSuspects);
    expect(ctx.dispatchFailed).toHaveBeenCalledWith(d);
    expect(ctx.finalize).not.toHaveBeenCalled();
  });

  it('reports policy env overrides and falls back for invalid values', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/env-timeout-test-policy.json' };
    expect(ENV_TIMEOUT_HOLD_STANDARD).toEqual({ mode: 'control-after', afterMinutes: 45 });
    expect(resolveEnvTimeoutHold({ ...env, WE_SMOKE_ENV_TIMEOUT_HOLD_MODE: 'hold', WE_SMOKE_ENV_TIMEOUT_HOLD_AFTER_MIN: '12.5' }))
      .toEqual({ mode: 'hold', afterMinutes: 12.5, source: { mode: 'env', afterMinutes: 'env' } });
    for (const value of ['0', '-1', 'Infinity', 'bad']) {
      expect(resolveEnvTimeoutHold({ ...env, WE_SMOKE_ENV_TIMEOUT_HOLD_MODE: 'bad', WE_SMOKE_ENV_TIMEOUT_HOLD_AFTER_MIN: value }))
        .toEqual({ ...ENV_TIMEOUT_HOLD_STANDARD, source: { mode: 'standard', afterMinutes: 'standard' } });
    }
    expect(resolveEnvTimeoutHold(new Proxy({}, { get() { throw new Error('unreadable env'); } })))
      .toEqual({ ...ENV_TIMEOUT_HOLD_STANDARD, source: { mode: 'standard', afterMinutes: 'standard' } });
  });

  it('keeps old callers without smokeSha holding', async () => {
    const ctx = context({ smokeSha: undefined });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.hold).toHaveBeenCalledWith('smoke-env-timeout', failed);
    expect(ctx.finalize).not.toHaveBeenCalled();
  });

  it.each(['budget', 'no-result'])('holds and reports an unavailable control: %s', async (kind) => {
    const ctx = context(kind === 'budget'
      ? { budgetAllows: vi.fn().mockReturnValue(false) }
      : { smokeSha: vi.fn().mockResolvedValue({ worktreeFailed: 'unavailable' }) });
    expect((await envTimeout.run(ctx)).reason).toBe('smoke-env-timeout');
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-control-unavailable', expect.any(Object));
    expect(ctx.finalize).not.toHaveBeenCalled();
    if (kind === 'budget') expect(ctx.smokeSha).not.toHaveBeenCalled();
  });
});

describe('no-worse shared check comparison', () => {
  it.each([
    { ...failed[0], ok: true },
    { ...failed[0], skipped: true },
    { ...failed[0], budgetSkipped: true },
    interruptedTimeout,
    { ...failed[0], detail: 'skipped: fail-fast — previous check failed' },
  ])('does not count passed, skipped or interrupted evidence on either side: %j', (row) => {
    expect(failsSameChecks(failed, [row])).toBe(false);
    expect(failsSameChecks([row], failed)).toBe(false);
  });
});

describe('smokeAndAdopt env-timeout escape wiring', () => {
  it.each([
    ['all measured timeouts', [...failed, dispatchTimeout], true],
    ['only one timeout', failed, false],
    ['fail-fast skipped sibling', [...failed, { ...dispatchTimeout, detail: 'skipped: fail-fast — reconcile-dry-run failed' }], false],
    ['budget skipped sibling', [...failed, { ...dispatchTimeout, budgetSkipped: true }], false],
    ['partially executed check', [interruptedTimeout, dispatchTimeout], false],
    ['ordinary failure on the same check', [...failed, { ...dispatchTimeout, detail: 'dispatch failed: invalid configuration' }], false],
    ['unmeasured timeout on the same check', [...failed, { ...dispatchTimeout, ms: 1 }], false],
  ])('requires every measured timeout through the real ladder: %s', async (_label, controlRows, adopts) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-env-timeout-equivalence-'));
    const root = join(dir, 'clone');
    const env = { WE_DAEMON_STATE_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'absent.json'),
      WE_SMOKE_ENV_TIMEOUT_HOLD_MODE: 'control-after', WE_SMOKE_ENV_TIMEOUT_HOLD_AFTER_MIN: '45' };
    try {
      writeRebuildState(root, { held: { reason: 'smoke-env-timeout', since: new Date(now - 60 * 60_000).toISOString() } }, env);
      materializeCandidate.mockClear();
      finalizeRebuild.mockClear();
      const candidate = { ...smokeResult, smoke: { results: [...failed, dispatchTimeout] } };
      const runSmoke = vi.fn().mockResolvedValueOnce(candidate)
        .mockResolvedValueOnce({ ...smokeResult, smoke: { results: controlRows } });
      const result = await smokeAndAdopt({ root, env, stEnv: env, log: {},
        run: () => ({ status: 1, stdout: '' }), runSmoke, now: () => now,
        plan: { finalSha: 'candidate', mainSha: 'candidate', applied: [] }, prevHead: 'last-good',
        lease: { path: join(dir, 'candidate'), id: 'test' }, prepAlerts: [], overlaysBefore: [],
        dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: vi.fn(), match: vi.fn() },
      });
      expect(result.reason).toBe(adopts ? 'env-timeout-adopted-not-worse' : 'smoke-env-timeout');
      expect(runSmoke).toHaveBeenCalledTimes(2);
      expect(runSmoke.mock.calls[1][0].runChild.failFast).toEqual([]);
      if (adopts) {
        expect(finalizeRebuild).toHaveBeenCalledTimes(1);
      } else {
        expect(finalizeRebuild).not.toHaveBeenCalled();
        expect(readRebuildState(root, env).held.reason).toBe('smoke-env-timeout');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['aged timeout', 'smoke-env-timeout', 60, true],
    ['different reason', 'smoke-harness-broken', 60, false],
    ['young timeout', 'smoke-env-timeout', 44, false],
  ])('%s', async (_label, reason, minutes, adopts) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-env-timeout-wiring-'));
    const root = join(dir, 'clone');
    const env = { WE_DAEMON_STATE_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'absent.json'),
      WE_SMOKE_ENV_TIMEOUT_HOLD_MODE: 'control-after', WE_SMOKE_ENV_TIMEOUT_HOLD_AFTER_MIN: '45' };
    const stEnv = env;
    try {
      writeRebuildState(root, { held: { reason, since: new Date(now - minutes * 60_000).toISOString() } }, stEnv);
      materializeCandidate.mockClear();
      finalizeRebuild.mockClear();
      const runSmoke = vi.fn(async () => smokeResult);
      const result = await smokeAndAdopt({ root, env, stEnv, log: {},
        run: () => ({ status: 1, stdout: '' }), runSmoke, now: () => now,
        plan: { finalSha: 'candidate', mainSha: 'candidate', applied: [] }, prevHead: 'last-good',
        lease: { path: join(dir, 'candidate'), id: 'test' }, prepAlerts: [], overlaysBefore: [],
        dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: vi.fn(), match: vi.fn() },
      });
      expect(result.reason).toBe(adopts ? 'env-timeout-adopted-not-worse' : 'smoke-env-timeout');
      expect(runSmoke).toHaveBeenCalledTimes(adopts ? 2 : 1);
      if (adopts) {
        expect(materializeCandidate.mock.calls.map(([args]) => args.sha)).toEqual(['candidate', 'last-good']);
        expect(finalizeRebuild).toHaveBeenCalledWith(expect.objectContaining({ prevHead: 'last-good', plan: expect.objectContaining({ finalSha: 'candidate' }) }));
      } else {
        expect(finalizeRebuild).not.toHaveBeenCalled();
        expect(readRebuildState(root, stEnv).held.reason).toBe('smoke-env-timeout');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
