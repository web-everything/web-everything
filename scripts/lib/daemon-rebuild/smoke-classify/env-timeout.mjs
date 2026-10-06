/** @file scripts/lib/daemon-rebuild/smoke-classify/env-timeout.mjs — the env-timeout classifier: the smoke verdict
 * `env-timeout` (a check ran out of time twice, budgets widened) is an environment fault.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { redactDetail } from './redact-detail.mjs';

export const envTimeout = Object.freeze({
  name: 'env-timeout',
  matches(verdict) { return verdict === 'env-timeout'; },
  async run(ctx) {
    const { a, failedA, alert, hold, plan, prepAlerts, alertsList } = ctx;
    // A check ran out of TIME twice (the second time with every budget widened) — the host is overloaded, which
    // plain main and last-good would hit identically (live 2026-09-26 22:37Z: lane-pool-list over its 120s scan
    // budget at load ~25 got #2773 dropped as a "suspect"). ENVIRONMENT: no reject record, no fallback/control
    // smokes, no overlay suspects. Hold on last-good; the next tick re-smokes and adopts once the host recovers.
    const et = a.smokeResult.envTimeout || {};
    alert('smoke-env-timeout', {
      failed: failedA.map((r) => r.name).join(','),
      details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
      ...(et.budgetFactor ? { retriedWithBudgetFactor: et.budgetFactor } : {}),
      ...(et.loadAvg ? { loadAvg: et.loadAvg } : {}),
      message: 'a smoke check ran out of time even with widened budgets — the host is overloaded, not the candidate; staying on last-good and re-checking next tick',
    });
    await hold('smoke-env-timeout', failedA);
    return { moved: false, reason: 'smoke-env-timeout', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
