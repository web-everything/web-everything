/** @file scripts/lib/daemon-rebuild/smoke-classify/env-unavailable.mjs — GitHub API unavailability is environment.
 * Live 2026-10-12 13:10 ET: 502/504s rejected healthy code and blamed overlays. The gate's own probe now
 * confirms the outage before this classifier holds on last-good, ahead of the fallback/suspect ladder.
 */

import { redactDetail } from './redact-detail.mjs';

export const envUnavailable = Object.freeze({
  name: 'env-unavailable',
  matches(verdict) { return verdict === 'env-unavailable'; },
  async run(ctx) {
    const { a, failedA, alert, hold, plan, prepAlerts, alertsList } = ctx;
    const attempts = (a.smokeResult.githubEnv?.attempts ?? []).map((entry) => ({
      ...entry, probe: { ...entry.probe, detail: redactDetail(entry.probe?.detail) },
    }));
    alert('smoke-env-unavailable', {
      failed: failedA.map((r) => r.name).join(','),
      details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
      attempts,
      probe: attempts.at(-1)?.probe.detail ?? '',
      message: "GitHub's API is unavailable (5xx / timeout / rate limit, confirmed by the gate's own probe) — not the candidate; staying on the current build and re-checking next tick; no overlay is blamed or dropped",
    });
    await hold('smoke-env-unavailable', failedA);
    return { moved: false, reason: 'smoke-env-unavailable', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
