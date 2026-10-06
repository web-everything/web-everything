/**
 * #4068 (slice 3 of #4065) — a PR the reconcile pass keeps refusing as `live-process` ("a bound session has a
 * LIVE pid — something is already working this PR, however stale its transcript looks") while whatever is bound
 * to it has not done anything for a long time. The refusal never dispatches a second agent, so a stale binding
 * holds its PR with nobody working it. 2026-09-24: PRs sat for hours refused `live-process` behind bindings
 * whose transcripts had not moved. The reconcile pass already frees a claude SESSION whose transcript crosses the
 * hung threshold; a REVIEW JOB (x26lw6u) is held by its pid alone — its activity is never read.
 *
 * Joins two readings: the `reconcile-refused live-process <repo> PR #<n>` lines in the daemon logs since the last
 * health tick (the refusal as it actually happened), and `probes.liveBindings`
 * (`health-watch.mjs#probeLiveBindings` — review jobs + PR-bound sessions with their last-activity age). A PR
 * breaches when its FRESHEST binding has been idle past `staleMs`; a refused PR with no readable binding is
 * reported clean with `bindings: 0` (nothing to judge), never guessed stale.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';
import { expandRepeatedLines } from '../../lib/log-timestamp.mjs';

export const LIVE_PROCESS_REFUSAL_RE = /reconcile-refused live-process (\S+) PR #(\d+)/g;

/** PURE: the distinct `{repo, pr, count}` refused as `live-process` in the daemon log samples. */
export function liveProcessRefusals(daemonLogs) {
  const byKey = new Map();
  for (const s of daemonLogs || []) {
    for (const m of expandRepeatedLines(s?.text || '').matchAll(LIVE_PROCESS_REFUSAL_RE)) {
      const key = `${m[1]}#${m[2]}`;
      const e = byKey.get(key) ?? { repo: m[1], pr: Number(m[2]), count: 0 };
      e.count += 1;
      byKey.set(key, e);
    }
  }
  return [...byKey.values()];
}

export default {
  id: 'live-process-stale-transcript',
  scope: 'host',
  cadence: 'gh',
  probes: ['daemonLogs', 'liveBindings'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'medium',
  action: 'investigate',
  // Past the reaper's own 30-minute hung threshold, with margin.
  staleMs: 45 * MINUTE,
  recommendationHint: 'A PR is refused `live-process` behind a binding that has not done anything in a long time — nobody is working it.',
  evaluate({ daemonLogs, liveBindings }) {
    return liveProcessRefusals(daemonLogs).map(({ repo, pr, count }) => {
      const bound = (liveBindings || []).filter((b) => b.pr === pr && (b.repo == null || b.repo === repo));
      const ages = bound.map((b) => b.lastActivityAgeMs).filter(Number.isFinite);
      const freshest = ages.length ? Math.min(...ages) : null;
      const top = bound.find((b) => b.lastActivityAgeMs === freshest) ?? bound[0] ?? null;
      const breach = freshest != null && freshest >= this.staleMs;
      return {
        subject: `pr:${repo}#${pr}`,
        breach,
        measure: {
          refusals: count, bindings: bound.length, freshestIdleMin: freshest == null ? null : Math.round(freshest / MINUTE),
          bound: bound.map((b) => ({ name: b.name, source: b.source, pid: b.pid, idleMin: Number.isFinite(b.lastActivityAgeMs) ? Math.round(b.lastActivityAgeMs / MINUTE) : null })),
        },
        summary: bound.length === 0
          ? `${repo} PR #${pr}: refused live-process ${count}x, but no bound review job or session was found to read activity from.`
          : `${repo} PR #${pr}: refused live-process ${count}x; its freshest binding (${top?.source} ${top?.name}${top?.pid ? `, pid ${top.pid}` : ''}) ${freshest == null ? 'has no readable activity' : `last did anything ${fmtAge(freshest)} ago`}.`,
        recommendation: freshest == null
          ? `No activity could be read for what holds PR #${pr} — nothing to judge yet; if it keeps being refused, find its binding in the reconcile pass's own agent listing.`
          : top?.source === 'review-job'
          ? `Review job ${top.name} (pid ${top.pid}) holds PR #${pr} but its log has not moved in ${fmtAge(freshest)} — check what that pid is doing (\`ps -p ${top.pid}\`); if it is hung, stop it so its record goes stale and the PR can be reconciled again. The product fix is a liveness read on review jobs, not only a pid probe.`
          : top?.reason === 'pending-foreground-call-within-grace' || top?.reason === 'stale-with-pending-call-past-grace'
            ? `${top.name} holds PR #${pr} waiting on a tool call that never returned — find the child it is blocked on (the transcript's last tool_use); if it is gone, stop the session so the PR can be reconciled again.`
            : `${top?.name ?? 'The bound session'} holds PR #${pr} with no activity in ${fmtAge(freshest)} — confirm it finished, stop it so the PR can be reconciled again, and fix the finished-session detector that missed it.`,
      };
    });
  },
};
