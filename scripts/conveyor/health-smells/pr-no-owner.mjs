/**
 * @file scripts/conveyor/health-smells/pr-no-owner.mjs
 * @description Landing-freeze fix, web-everything/web-everything#2793 (2026-09-27) — a PR with NO live session, whose
 * fix-dispatch daemon's OWN planner keeps refusing it with a reason that means "someone else owns this"
 * (`reconcile-refused owed-elsewhere` — `reconcile-core.mjs`'s `OWED_ELSEWHERE.conflicted` — or
 * `refused missing-run-cap-exhausted` — `ci-red-recovery-watch.mjs`'s missing-run pass giving up and handing off
 * to "a human/ci-heal look"), with nothing else ever actually picking it up. Both refusal kinds are, BY THEIR OWN
 * DESIGN, an explicit "not my job, ask elsewhere" — never a correct terminal no-op like `nothing-owed` or
 * `cap-exhausted` (which DO mean "this PR genuinely needs a human now", already covered by their own smells/caps).
 * #2793 sat exactly here for hours: `parked-pr-conflict-watch.mjs` decided its own routing was "reconcile-finding"
 * once, then went silent (the file's own "IDEMPOTENCY, NO SEPARATE STORE" rule — never repeats past the label's
 * first application), while `reconcile-core.mjs` kept refusing `owed-elsewhere` every tick and
 * `ci-red-recovery-watch.mjs`'s missing-run pass kept retriggering CI on a PR that could never possibly produce a
 * check run, until its own cap burned — a ping-pong with no owner, invisible to every EXISTING smell (this
 * population is neither CI-red — `statusCheckRollup` is EMPTY, not failing — nor an ordinary dispatch-layer
 * refusal `red-pr-unattended.mjs` already covers).
 *
 * `openAfter: 4` at the 15-minute `GH_CADENCE_MS` gh-probe cadence (`../health-watch.mjs#GH_CADENCE_MS`) is this
 * smell's OWN "> 60 min" gate — mirrors every other gh-cadence smell in this directory (e.g. `stale-claim.mjs`'s
 * `staleAfterDays` threshold, `daemon-owed-no-dispatch.mjs`'s `minDurationMs`): the framework's own episode
 * bookkeeping (`stepEpisodes`'s `openedAt`) tracks "since when has this held", not this file.
 *
 * Reads the SAME `daemons['fix-dispatch-daemon'].prRefusals` memory `red-pr-unattended.mjs` already reads (no new
 * probe) — the fix-dispatch daemon's own per-PR "last refusal reason" map, folded from its log by
 * `../health-watch-core.mjs#foldDaemonMemory`.
 */
import { fmtAge } from '../health-watch-core.mjs';

/** The two refusal kinds this smell exists for — both mean "elsewhere", never "this PR is fine" or "a human is
 *  already correctly on the hook via a different, already-covered channel". Matched against the exact reason
 *  text `../health-watch-core.mjs#parseDaemonLog` already records (`reconcile-refused <kind>` / `refused <kind>:
 *  <why>`), never re-parsed from a raw log line here. */
export const ELSEWHERE_REASON_RE = /^(reconcile-refused owed-elsewhere\b|refused missing-run-cap-exhausted\b)/;

/** Mirrors `red-pr-unattended.mjs`'s own fixer-session-name match exactly — the conveyor's own session-naming
 *  convention (`fix-<PR>`, `ci-heal-…<PR>…`, `conflict-<PR>…`), never re-derived differently here. */
export function findFixerSession(live, prNumber) {
  const re = new RegExp(`^(fix|ci-heal|heal|conflict)-.*\\b${prNumber}\\b|^(fix|ci-heal)-${prNumber}$`);
  return (live || []).find((a) => re.test(a.name || '')) ?? null;
}

export default {
  id: 'pr-no-owner',
  scope: 'repo',
  cadence: 'gh',
  probes: ['prs', 'agents'],
  openAfter: 4,
  closeAfter: 1,
  severity: 'high',
  action: 'investigate',
  recommendationHint: 'A PR has no live session and the fix-dispatch daemon\'s own planner refusals all point '
    + '"elsewhere" (owed-elsewhere / missing-run-cap-exhausted) with nothing else ever picking it up — a routing '
    + 'gap in reconcile-core.mjs / ci-red-recovery-watch.mjs / parked-pr-conflict-watch.mjs, never a reason to '
    + 'resolve the PR by hand.',
  evaluate({ prs, agents }, { now, daemons }) {
    const live = (agents || []).filter((a) => a.state !== 'done' && a.state !== 'stopped' && a.state !== 'failed');
    const fixLog = daemons?.['fix-dispatch-daemon'];
    const out = [];
    for (const pr of prs || []) {
      const n = String(pr.number);
      const key = `${pr.repo}#${n}`;
      const last = fixLog?.prRefusals?.[key];
      if (!last || !ELSEWHERE_REASON_RE.test(last.reason || '')) continue; // not this smell's narrow population
      const fixer = findFixerSession(live, n);
      out.push({
        subject: key,
        breach: !fixer,
        measure: {
          reason: last.reason, lastRefusalAgo: fmtAge(now - last.at), fixerSession: fixer?.name ?? null,
          title: String(pr.title || '').slice(0, 80),
        },
        summary: `${key} has no live session and the fix-dispatch daemon's last word on it is "${last.reason}" — nobody currently owns resolving it.`,
        recommendation: `${key}: refused "${last.reason}" with nothing else picking it up — a ping-pong with no `
          + 'owner. Fix the routing (reconcile-core.mjs\'s OWED_ELSEWHERE table, ci-red-recovery-watch.mjs\'s '
          + `missing-run population, or parked-pr-conflict-watch.mjs's re-check gate), never resolve ${key} by hand.`,
      });
    }
    return out;
  },
};
