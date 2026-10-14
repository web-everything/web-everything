/** @file scripts/lib/daemon-rebuild/smoke-classify/env-timeout.mjs — the env-timeout classifier: the smoke verdict
 * `env-timeout` (a check ran out of time twice, budgets widened) is an environment fault.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { redactDetail } from './redact-detail.mjs';
import { cascadePolicy } from '../../policy-cascade.mjs';
import { isEnvTimeoutRow } from '../../daemon-live-smoke.mjs';

export const ENV_TIMEOUT_HOLD_STANDARD = { mode: 'control-after', afterMinutes: 45 };

// Skipped or partially executed checks can quote a timeout without completing the check.
function isExecutedTimeoutRow(row) {
  return !row.skipped && !row.budgetSkipped && !row.budgetInterrupted && !/^skipped:/.test(String(row.detail ?? ''))
    && isEnvTimeoutRow(row);
}

// The kind of give-up and the budget a timeout fragment ran out of (0 for a lock give-up); null when the text is
// not a timeout at all. A kill is the gate's own clock; scan and lock text is printed by the tree under test.
function fragmentBudget(text) {
  const kill = /timed out after (\d+)ms \(process group killed\)/.exec(text);
  if (kill) return { kind: 'kill', budget: Number(kill[1]) };
  const scan = /scan exceeded its (\d+)ms budget/.exec(text);
  if (scan) return { kind: 'scan', budget: Number(scan[1]) };
  return /gave up waiting for the shared acquirability-scan lock/.test(text) ? { kind: 'lock', budget: 0 } : null;
}

// What a timeout row measured, as unit → {kind, budget it ran out of}. A multi-repo reconcile row is one unit per
// repo; every other row is a single unit. null when any unit is something other than a timeout (a real error
// beside a timeout).
function timeoutProfile(row) {
  const detail = String(row.detail ?? '');
  const kills = /^reconcile-pass dry-run \(\d+\/\d+ repo\(s\) — (.+)\) failed: (timed out after \d+ms \(process group killed\))$/.exec(detail);
  if (kills) return new Map(kills[1].split(', ').map((repo) => [repo, fragmentBudget(kills[2])]));
  const mixed = /^reconcile-pass dry-run failed for \d+\/\d+ repo\(s\): (.+)$/.exec(detail);
  if (mixed) {
    const units = new Map();
    for (const part of mixed[1].split('; ')) {
      const m = /^([^:]+): ((?:timed out after|scan exceeded its|gave up waiting)[\s\S]*)$/.exec(part);
      const budget = m ? fragmentBudget(m[2]) : null;
      if (budget === null) return null;
      units.set(m[1], budget);
    }
    return units;
  }
  const budget = fragmentBudget(detail);
  return budget === null ? null : new Map([['', budget]]);
}

// Equivalent control = same check, every candidate unit timed out again, and with at least as much time. A control
// killed at a smaller budget (host load differs, or the shared deadline cut it short) proves nothing; one killed at
// a larger budget is stronger evidence. Exact equality would reject nearly every load-scaled budget.
function sameTimeout(candidateRow, controlRow) {
  const want = timeoutProfile(candidateRow);
  const got = timeoutProfile(controlRow);
  return !!want && !!got && candidateRow.name === controlRow.name
    && [...want].every(([unit, w]) => got.get(unit)?.kind === w.kind && got.get(unit).budget >= w.budget);
}

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
    // reproduces every timeout before adopting as no worse (gh slot contention can persist at low CPU load).
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
        // A no-worse proof needs every failed check to run; fail-fast skips cannot reproduce a failure.
        ? await ctx.smokeSha(ctx.prevHead, null, 'last-good', [], { failFast: [] })
        : {};
      const controlTimeouts = c.smokeResult
        ? ctx.failedRows(c.smokeResult).filter(isExecutedTimeoutRow)
        : [];
      // Equivalent = same check, same kind of timeout, same budget — not merely a failure on the same check name.
      const reproducedOnLastGood = c.smokeResult
        ? controlTimeouts.filter((r) => failedA.some((f) => sameTimeout(f, r))).map((r) => r.name)
        : [];
      if (failedA.every(isExecutedTimeoutRow)
        && ctx.failsSameChecks?.(failedA, controlTimeouts)
        && failedA.every((f) => controlTimeouts.some((r) => sameTimeout(f, r)))) {
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
      alert(!c.smokeResult ? 'smoke-env-timeout-control-unavailable'
        : c.smokeResult.verdict === 'pass' ? 'smoke-env-timeout-control-passed' : 'smoke-env-timeout-control-not-equivalent', {
        failed, reproducedOnLastGood, heldSinceMinutes, holdPolicy,
      });
    }
    await hold('smoke-env-timeout', failedA);
    return { moved: false, reason: 'smoke-env-timeout', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
