import { routeMqFailureOnHold } from './drain-mq-failure-recovery-io.mjs';

/** One drain's pending best-effort routes; the recovery adapter owns head deduplication. */
export function createDrainMqRouteWiring({ route = routeMqFailureOnHold, log = () => {}, waitMs = 5000 } = {}) {
  const pending = [];
  const note = line => { try { log(line); } catch { /* Logging cannot change a hold. */ } };
  return {
    start({ repo, pr, head, guard, dryRun }) {
      if (guard?.hold !== true || dryRun || typeof guard.line !== 'string'
        || !guard.line.startsWith('mq-same-head-failed:')) return;
      // Defer invocation so even a synchronous adapter failure cannot change the hold.
      pending.push(Promise.resolve().then(() => route({ repo, pr, head, guard, dryRun, log }))
        .catch(() => { note('mq-failure-recovery: route unavailable; hold retained, operator inspection required'); }));
    },
    async settle() {
      if (!pending.length) return;
      const batch = pending.splice(0);
      let timer;
      try {
        await Promise.race([
          Promise.allSettled(batch),
          new Promise(resolve => { timer = setTimeout(() => {
            note('mq-failure-recovery: route wait bound reached; hold retained, operator inspection required');
            resolve();
          }, waitMs); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
