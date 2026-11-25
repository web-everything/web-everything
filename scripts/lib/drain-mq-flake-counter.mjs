/**
 * Merge-queue flake counter (MQ-FLAKE-COUNTER). Pure decision: eject a PR only after N consecutive failures of the
 * same check (same merge-group head, check name and producer app). Default N=1 keeps today's behaviour; the shadow
 * field always records what the 3-failure rule would have done so turn-on can be proven first.
 * Merge-path: producer app bound (1), ordering by attempt number never timestamps (3), 40-hex head binding (5),
 * unreadable or absent evidence ejects (2, 7). Persist the count only after the rerun request succeeds (8).
 */
const SHADOW_THRESHOLD = 3;
const HEAD_RE = /^[0-9a-f]{40}$/;
const FINAL = new Set(['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', 'stale']);
const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

const eject = reason => ({ action: 'eject', failures: 0, reason });

export function resolveEjectAfterFailures(settings) {
  const n = settings?.mergeQueue?.ejectAfterFailures;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

function decide({ checks, head, name, appId, threshold }) {
  if (!HEAD_RE.test(head ?? '') || typeof name !== 'string' || !name || appId == null) return eject('unreadable binding');
  if (!Array.isArray(checks)) return eject('unreadable attempts');
  const mine = checks.filter(c => c && c.head_sha === head && c.name === name && c.app?.id === appId);
  if (!mine.length) return eject('no attempts for this head, check and app');
  const seen = new Set();
  for (const c of mine) {
    if (!Number.isInteger(c.run_attempt) || c.run_attempt < 1 || seen.has(c.run_attempt)) return eject('unreadable attempt numbers');
    seen.add(c.run_attempt);
  }
  mine.sort((a, b) => a.run_attempt - b.run_attempt);
  const latest = mine[mine.length - 1];
  if (latest.status !== 'completed' || latest.conclusion == null) {
    if (mine.some(c => c.conclusion != null && !FINAL.has(c.conclusion))) return eject('unknown conclusion');
    return { action: 'wait', failures: 0, reason: 'latest attempt not complete' };
  }
  if (mine.some(c => c.conclusion != null && !FINAL.has(c.conclusion))) return eject('unknown conclusion');
  let failures = 0;
  for (let i = mine.length - 1; i >= 0 && BAD.has(mine[i].conclusion); i--) failures++;
  if (!failures) return { action: 'pass', failures: 0, reason: 'latest attempt passed' };
  return failures >= threshold
    ? { action: 'eject', failures, reason: `${failures} consecutive failures` }
    : { action: 'rerun', failures, reason: `${failures} of ${threshold} failures` };
}

export function evaluateMqFlakeCounter({ checks, head, name, appId, threshold = 1 }) {
  const actual = decide({ checks, head, name, appId, threshold });
  const shadow = decide({ checks, head, name, appId, threshold: SHADOW_THRESHOLD });
  return { ...actual, shadow: { action: shadow.action, failures: shadow.failures, threshold: SHADOW_THRESHOLD } };
}
