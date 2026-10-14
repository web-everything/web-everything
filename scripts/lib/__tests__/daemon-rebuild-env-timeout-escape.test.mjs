import { describe, it, expect, vi } from 'vitest';
import { envTimeout, ENV_TIMEOUT_HOLD_STANDARD, resolveEnvTimeoutHold } from '../daemon-rebuild/smoke-classify/env-timeout.mjs';

const now = Date.parse('2026-10-14T17:00:00Z');
const failed = [{ name: 'reconcile-dry-run', ok: false, ms: 120_000, detail: 'timeout' }];
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

  it('adopts when last-good reproduces any candidate failure', async () => {
    const ctx = context({ failedA: [...failed, { name: 'dispatch-dry-run', ok: false }] });
    expect((await envTimeout.run(ctx)).reason).toBe('env-timeout-adopted-not-worse');
    expect(ctx.smokeSha).toHaveBeenCalledWith('last-good', null, 'last-good', [], {
      failFast: ['reconcile-dry-run', 'dispatch-dry-run'],
    });
    expect(ctx.budgetAllows).toHaveBeenCalledWith('last-good');
    expect(ctx.finalize).toHaveBeenCalledWith(ctx.plan, undefined, undefined, smokeResult);
    expect(ctx.hold).not.toHaveBeenCalled();
    expect(ctx.alert).toHaveBeenCalledWith('smoke-env-timeout-adopted-not-worse', expect.objectContaining({
      reproducedOnLastGood: ['reconcile-dry-run'], heldSinceMinutes: 60,
      holdPolicy: { ...ENV_TIMEOUT_HOLD_STANDARD, source: { mode: 'standard', afterMinutes: 'standard' } },
    }));
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
