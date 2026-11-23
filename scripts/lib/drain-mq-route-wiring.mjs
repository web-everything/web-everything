import { routeMqFailureOnHold } from './drain-mq-failure-recovery-io.mjs';

/** One drain's pending best-effort routes; the recovery adapter owns head deduplication. */
export function createDrainMqRouteWiring({ route = routeMqFailureOnHold, log = () => {} } = {}) {
  const pending = [];
  let cursor;
  const key = ({ repo, pr, head }) => `${repo}#${pr}@${head}`;
  const note = line => { try { log(line); } catch { /* Logging cannot change a hold. */ } };
  return {
    start({ repo, pr, head, guard, dryRun }) {
      if (guard?.hold !== true || dryRun || typeof guard.line !== 'string'
        || !guard.line.startsWith('mq-same-head-failed:')
        // Unreadable or mismatched live queue state is never routing authority.
        || !guard.line.includes(' — failed_checks')) return;
      pending.push({ repo, pr, head, guard, dryRun, log });
    },
    async settle() {
      const candidates = pending.splice(0);
      if (!candidates.length) return;
      // Resume after the last attempted identity, using only this sweep's live holds.
      const offset = (candidates.findIndex(args => key(args) === cursor) + 1) % candidates.length;
      const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
      const batch = ordered.slice(0, 3);
      cursor = key(batch.at(-1));
      for (const _deferred of ordered.slice(3))
        note('mq-failure-recovery: route cap reached; hold retained, deferred to next sweep');
      // Defer invocation so even synchronous adapter failures cannot change a hold.
      await Promise.allSettled(batch.map(args => Promise.resolve().then(() => route(args))
        .catch(() => { note('mq-failure-recovery: route unavailable; hold retained, operator inspection required'); })));
    },
  };
}
