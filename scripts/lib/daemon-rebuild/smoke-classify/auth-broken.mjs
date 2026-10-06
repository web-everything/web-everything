/** @file scripts/lib/daemon-rebuild/smoke-classify/auth-broken.mjs — the 401 classifier: the smoke verdict
 * `auth-broken` (GitHub rejected the smoke env's token even after a re-mint) is an environment fault.
 * Split out of daemon-rebuild.mjs (move-only).
 */

export const authBroken = Object.freeze({
  name: 'auth-broken',
  matches(verdict) { return verdict === 'auth-broken'; },
  async run(ctx) {
    const { a, failedA, alert, hold, plan, prepAlerts, alertsList } = ctx;
    // GitHub rejected the smoke env's credential even after a forced re-mint (daemon-live-smoke.mjs): an
    // ENVIRONMENT fault, never evidence against the candidate — no reject record, no fallback/control smokes.
    alert('github-auth-broken', {
      failed: failedA.map((r) => r.name).join(','),
      ...(a.smokeResult.auth || {}),
      message: 'GitHub rejects the daemon\'s token even after a re-mint — fix the App credentials; the clone stays on its last-good build meanwhile',
    });
    await hold('github-auth-broken', failedA);
    return { moved: false, reason: 'github-auth-broken', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
