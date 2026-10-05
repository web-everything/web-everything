/** @file scripts/lib/daemon-rebuild/smoke-classify/transient.mjs — the transient classifier: any verdict that is
 * not `code` (env noise that survived its retries) holds on last-good without a reject record. It matches
 * everything non-`code`, so it must stay LAST in the ordered array. Split out of daemon-rebuild.mjs (move-only).
 */

export const transient = Object.freeze({
  name: 'transient',
  matches(verdict) { return verdict !== 'code'; },
  async run(ctx) {
    const { failedA, alert, hold, plan, prepAlerts, alertsList } = ctx;
    // 'transient' — never poison the reject-cache; hold on last-good (still dispatching), retry next tick.
    alert('smoke-transient');
    await hold('smoke-transient', failedA);
    return { moved: false, reason: 'smoke-transient', plan, alerts: [...prepAlerts, ...alertsList] };
  },
});
