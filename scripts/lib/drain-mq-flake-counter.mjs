/**
 * Merge-queue flake counter (MQ-FLAKE-COUNTER). Pure decision: eject a PR only after N consecutive failures of the
 * same check (same merge-group head, check name, producer app and Actions run). Default N=1 keeps today's behaviour;
 * the shadow field always records what the 3-failure rule would have done so turn-on can be proven first.
 * Merge-path: producer app bound (1), ordering by attempt number never timestamps (3), 40-hex head binding (5),
 * run binding (6), unreadable, absent or incomplete evidence ejects (2, 7). Persist the count only after the rerun
 * request succeeds (8).
 */
const SHADOW_THRESHOLD = 3;
const HEAD_RE = /^[0-9a-f]{40}$/;
// skipped/neutral are unsupported evidence: they never count as a pass and never reset a streak, so they eject.
const FINAL = new Set(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale']);
const MAX_THRESHOLD = 10;
// inspectMqReruns treats a second failure of the same run+check as head-failure evidence even if a later attempt is
// green, so the counter never passes where that guard rejects: two failures always eject.
const GUARD_FAILURES = 2;
const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);
const stamp = v => typeof v === 'string' ? Date.parse(v) : NaN;

const eject = reason => ({ action: 'eject', failures: 0, reason });

export function resolveEjectAfterFailures(settings) {
  const n = settings?.mergeQueue?.ejectAfterFailures;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

function decide({ checks, head, name, appId, runId, threshold }) {
  if (!HEAD_RE.test(head ?? '') || typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(appId) || appId < 1
    || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) return eject('unreadable binding');
  if (!Array.isArray(checks)) return eject('unreadable attempts');
  const mine = checks.filter(c => c && c.head_sha === head && c.name === name && c.app?.id === appId
    && (runId === undefined || String(c.run_id) === String(runId)));
  if (!mine.length) return eject('no attempts for this head, check and app');
  const idOf = c => (typeof c.run_id === 'number' || typeof c.run_id === 'string') && String(c.run_id).trim() ? String(c.run_id) : null;
  if (mine.some(c => idOf(c) === null)) return eject('run id missing');
  if (new Set(mine.map(idOf)).size > 1) return eject('attempts span several runs');
  for (const c of mine) if (!Number.isInteger(c.run_attempt) || c.run_attempt < 1) return eject('unreadable attempt numbers');
  mine.sort((a, b) => a.run_attempt - b.run_attempt);
  // Complete history only: attempts must be exactly 1..n.
  if (mine.some((c, i) => c.run_attempt !== i + 1)) return eject('attempt history incomplete or duplicated');
  for (let i = 0; i < mine.length; i++) {
    const c = mine[i], last = i === mine.length - 1;
    if (c.status === 'completed') {
      if (!FINAL.has(c.conclusion) || !(stamp(c.started_at) <= stamp(c.completed_at))) return eject('unreadable completed attempt');
    } else if (!last || (c.status !== 'in_progress' && c.status !== 'queued') || c.conclusion != null) {
      return eject('unreadable or incomplete attempt');
    }
  }
  const latest = mine[mine.length - 1];
  let streak = 0, worst = 0;
  for (const c of mine) {
    if (c.status !== 'completed') continue;
    if (BAD.has(c.conclusion)) worst = Math.max(worst, ++streak); else streak = 0;
  }
  // A threshold-reaching streak is head-failure evidence even if a later attempt is green or still pending.
  const limit = Math.min(threshold, GUARD_FAILURES);
  if (worst >= limit) return { action: 'eject', failures: worst, reason: `${worst} consecutive failures` };
  if (latest.status !== 'completed') return { action: 'wait', failures: worst, reason: 'latest attempt not complete' };
  if (latest.conclusion === 'success') return { action: 'pass', failures: 0, reason: 'latest attempt succeeded' };
  if (!BAD.has(latest.conclusion)) return eject('latest attempt neither success nor failure');
  return { action: 'rerun', failures: streak, reason: `${streak} of ${threshold} failures` };
}

export function evaluateMqFlakeCounter({ checks, head, name, appId, runId, threshold = 1 }) {
  const actual = decide({ checks, head, name, appId, runId, threshold });
  const shadow = decide({ checks, head, name, appId, runId, threshold: SHADOW_THRESHOLD });
  return { ...actual, shadow: { action: shadow.action, failures: shadow.failures, threshold: SHADOW_THRESHOLD } };
}
