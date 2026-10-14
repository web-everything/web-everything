/** @file scripts/lib/daemon-rebuild/smoke-classify/env-timeout.mjs — the env-timeout classifier: the smoke verdict
 * `env-timeout` (a check ran out of time twice, budgets widened) is an environment fault.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { redactDetail } from './redact-detail.mjs';
import { cascadePolicy } from '../../policy-cascade.mjs';

export const ENV_TIMEOUT_HOLD_STANDARD = { mode: 'control-after', afterMinutes: 45 };

/** Resolve the environment-timeout hold cap through the platform/env policy cascade. Never throws. */
export function resolveEnvTimeoutHold(env = process.env) {
  try {
    const mode = env?.WE_SMOKE_ENV_TIMEOUT_HOLD_MODE;
    const afterMinutes = env?.WE_SMOKE_ENV_TIMEOUT_HOLD_AFTER_MIN;
    const r = cascadePolicy('smokeEnvTimeoutHold', undefined, {
      env, standard: ENV_TIMEOUT_HOLD_STANDARD,
      envValues: { mode, afterMinutes: afterMinutes === undefined ? undefined : Number(afterMinutes) },
      valid: {
        mode: (x) => x === 'hold' || x === 'control-after',
        afterMinutes: (x) => typeof x === 'number' && Number.isFinite(x) && x > 0,
      },
    });
    return {
      mode: r.value.mode, afterMinutes: r.value.afterMinutes,
      source: { mode: r.sources?.mode ?? 'standard', afterMinutes: r.sources?.afterMinutes ?? 'standard' },
    };
  } catch {
    return { ...ENV_TIMEOUT_HOLD_STANDARD, source: { mode: 'standard', afterMinutes: 'standard' } };
  }
}

export const envTimeout = Object.freeze({
  name: 'env-timeout',
  matches(verdict) { return verdict === 'env-timeout'; },
  async run(ctx) {
    const { a, failedA, alert, hold, plan, prepAlerts, alertsList } = ctx;
    // A check ran out of TIME twice with widened budgets. Hold first; after the cap, prove whether last-good
    // shares a failed check before adopting as no worse (gh slot contention can persist even at low CPU load).
    const et = a.smokeResult.envTimeout || {};
    const holdPolicy = resolveEnvTimeoutHold(ctx.env);
    const failed = failedA.map((r) => r.name).join(',');
    alert('smoke-env-timeout', {
      failed,
      details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
      holdPolicy,
      ...(et.budgetFactor ? { retriedWithBudgetFactor: et.budgetFactor } : {}),
      ...(et.loadAvg ? { loadAvg: et.loadAvg } : {}),
      message: 'a smoke check ran out of time even with widened budgets — the host is overloaded, not the candidate; staying on last-good and re-checking next tick',
    });
    const heldSinceMinutes = ctx.heldSince && ctx.now
      ? (ctx.now() - Date.parse(ctx.heldSince)) / 60_000 : null;
    if (holdPolicy.mode === 'control-after' && heldSinceMinutes > holdPolicy.afterMinutes
      && ctx.smokeSha && ctx.prevHead && ctx.finalize) {
      const c = ctx.budgetAllows('last-good')
        ? await ctx.smokeSha(ctx.prevHead, null, 'last-good', [], { failFast: failedA.map((r) => r.name) })
        : {};
      const reproducedOnLastGood = c.smokeResult
        ? ctx.failedRows(c.smokeResult).filter((r) => failedA.some((f) => f.name === r.name)).map((r) => r.name)
        : [];
      if (reproducedOnLastGood.length) {
        if (ctx.aSuspects?.length) {
          const d = await ctx.dispatchOnly(plan.finalSha, ctx.aSuspects);
          if (!d.result.ok) return ctx.dispatchFailed(d);
          ctx.dispatchPassedAlert(d);
        }
        alert('smoke-env-timeout-adopted-not-worse', {
          failed, reproducedOnLastGood, heldSinceMinutes, holdPolicy,
          message: 'env-timeout hold outlived its cap and last-good times out the same way — adopting the candidate as no worse so held overlays go live',
        });
        const fin = await ctx.finalize(plan, undefined, undefined, a.smokeResult);
        return { ...fin, reason: fin.adopted ? 'env-timeout-adopted-not-worse' : fin.reason };
      }
      alert(c.smokeResult ? 'smoke-env-timeout-control-passed' : 'smoke-env-timeout-control-unavailable', {
        failed, heldSinceMinutes, holdPolicy,
      });
    }
    await hold('smoke-env-timeout', failedA);
    return { moved: false, reason: 'smoke-env-timeout', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
