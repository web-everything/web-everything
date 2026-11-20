/** Live 2026-11-20: CI healing waited for the end of a 35-minute fix pass. */
import * as daemon from '../../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

function fakeTimer() {
  let callback, delay;
  let cleared = false, unrefed = false;
  const handle = { unref() { unrefed = true; } };
  return {
    setTimer(fn, ms) { callback = fn; delay = ms; return handle; },
    clearTimer(value) { if (value === handle) cleared = true; },
    fire: () => callback?.(),
    status: () => ({ delay, cleared, unrefed }),
  };
}

export default {
  id: 'ci-heal-runs-on-own-interval',
  title: 'an in-process timer heals between main passes and skips overlapping healing',
  card: 'ci-heal-own-cadence',
  fixedBy: { sha: 'uncommitted', where: 'lane/ci-heal-cadence', paths: [
    'scripts/conveyor/ci-heal-interval.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  // Synchronous behavior probe: registering and firing the real ticker must invoke healing.
  fixPresent() {
    if (typeof daemon.createCiHealTicker !== 'function') return false;
    const clock = fakeTimer();
    let calls = 0;
    const ticker = daemon.createCiHealTicker({ ...clock, intervalSec: 60,
      healState: { healing: false }, tick: () => { calls += 1; } });
    clock.fire();
    ticker.stop();
    const { delay, cleared, unrefed } = clock.status();
    return calls === 1 && delay === 60_000 && cleared && unrefed;
  },
  async run() {
    const clock = fakeTimer(), healState = { healing: false };
    let heals = 0;
    const ticker = daemon.createCiHealTicker({ ...clock, healState, intervalSec: 90,
      tick: () => { heals += 1; } });
    try {
      await clock.fire(); // no main pass runs: the timer itself must drive healing
      const betweenPasses = heals;
      healState.healing = true;
      await clock.fire();
      const whilePassHealing = heals;
      healState.healing = false;
      await clock.fire();
      ticker.stop();
      await clock.fire(); // queued callbacks must be inert after shutdown
      return { betweenPasses, whilePassHealing, total: heals, released: !healState.healing, ...clock.status() };
    } finally { ticker.stop(); }
  },
  judge: report => [
    ...(report.betweenPasses === 1 ? [] : ['timer did not heal between main passes']),
    ...(report.whilePassHealing === 1 ? [] : ['timer overlapped a healing main pass']),
    ...(report.total === 2 ? [] : ['timer failed to resume or healed after shutdown']),
    ...(report.delay === 90_000 && report.unrefed && report.cleared && report.released ? [] : ['timer cadence, shutdown or flag release failed']),
  ],
};
