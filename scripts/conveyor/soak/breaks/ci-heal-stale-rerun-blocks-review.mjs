/**
 * @file breaks/ci-heal-stale-rerun-blocks-review.mjs — live DEADLOCK 2026-09-28/29, PR #2878 (chalbert/
 * web-everything, WE #4358, we:backlog/fix-review-ciheal-deadlock). Its only red check was `review-gate`, red
 * BY DESIGN while `review:pending` stood — every real required check (`test`, shards, soak, smoke) was green.
 * The fix/ci-heal dispatcher nonetheless dispatched a ci-heal on it, which correctly found nothing to fix and
 * escalated ("not a CI break — the only red check is review-gate … PR awaits its review verdict"). The review
 * daemon then refused to review it, every tick: "ci-heal-escalated: ci-heal already escalated this exact head
 * … to a human". Review waited for ci-heal; ci-heal said it was waiting for review. Nothing moved.
 *
 * ROOT CAUSE (half 1 of 2, the half this soak reproduces): `review-gate` re-runs on every `labeled`/`unlabeled`
 * event (`.github/workflows/review-gate.yml`) and `soak-replay-gate` re-runs on every `edited` event
 * (`.github/workflows/soak-replay-gate.yml`) — a single HEAD can carry a STALE `FAILURE` run beside a LATER
 * `SUCCESS` rerun of the SAME check name in one `statusCheckRollup` fetch (confirmed live against #2878's own
 * rollup: 7 stale `review-gate` FAILUREs beside 11 SUCCESSes, all on head `cf59b9d10`). `we:scripts/progress-
 * board.mjs#ciFailed` and `we:scripts/operations/pr-status.mjs#reduceCheckState` both scanned the RAW rollup
 * array with a flat `.some()`/`.filter()` — never collapsing to the LATEST run per check name first, unlike the
 * established `collapseRollupToLatestPerName` reader (`we:scripts/merge-ai-prs.mjs`, #2925/#2932) their own
 * SIBLING single-check readers (`isRequiredCheckGreen`/`isRequiredCheckFailed`) already use. `review-gate`
 * itself is excluded from CI truth either way (`CI_TRUTH_EXCLUDED_CHECKS`) — but ANY required check that
 * reruns more than once on one head (this soak uses `test`, already in the FALLBACK required set so no branch-
 * protection fixture is needed) hits the identical defect: a stale `FAILURE` run the LATEST run has already
 * superseded still read `ci-red` forever, because nothing had ever deduped the rollup by name first.
 *
 * MECHANISM IN `planReconcile` (`we:scripts/conveyor/reconcile-core.mjs`): `classifyPr`'s `ci-red` branch sits
 * AHEAD of the generic OWED table that would otherwise dispatch `review` for a `review:pending` PR — so a PR
 * misread as `ci-red` NEVER reaches the review-dispatch code AT ALL (the `ci-red` branch's own `continue`
 * short-circuits the whole rest of the per-PR loop body). `ci-heal` gets dispatched against a PR with nothing
 * to fix; `review` never even gets CONSIDERED. This is exactly the review-daemon's own observed symptom (no
 * `review` row in the plan, only a `ci-heal`/`ci-heal-escalated` one).
 *
 * FIX — this same PR (we:backlog/fix-review-ciheal-deadlock): `ciFailed`/`reduceCheckState` both collapse their
 * rollup to the latest run per check name (`collapseRollupToLatestPerName`) BEFORE judging pass/fail — the
 * SAME collapse `isRequiredCheckGreen`/`isRequiredCheckFailed` already apply per-check. (Half 2 of the live
 * fix — `ci-heal-escalation-mark.mjs`'s new structured `not-a-ci-break` outcome, so an escalation ALREADY on
 * the PR cannot durably block review either — is covered by unit tests on `reconcile-core.mjs#planReconcile`,
 * not this soak: it needs no daemon-timing scenario, and reproducing it here would require also faking `gh`'s
 * branch-protection API, which the fake `gh` shim does not implement.)
 *
 * SCENARIO: one PR shaped like #2878 — `review:pending`, no `ci:failed` label, no draft, no conflict. `test`
 * (a FALLBACK-required check, so no branch-protection fixture is needed) carries TWO check runs on the SAME
 * head: a stale `FAILURE` immediately superseded by a `SUCCESS` rerun — `smoke`/`daemon-soak` (the other two
 * FALLBACK-required checks) each ran once, green. Both `fix-dispatch` (ci-heal's own dispatcher) and `review`
 * daemons tick every round.
 *
 * RED = a `ci-heal-<pr>` session is ever dispatched (pre-fix: round 0) AND a `review-<pr>` session is NEVER
 * dispatched across the whole run — `classifyPr` reads `ci-red` off the stale run, so the review branch is
 * structurally unreachable. GREEN = the opposite: `ci-heal-<pr>` is NEVER dispatched, and `review-<pr>` IS,
 * within a couple of ticks — `classifyPr` reads `needs-review` off the collapsed (latest-run) rollup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSoak } from '../soak.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../../lib/required-status-checks.mjs';
import { sessionMatches } from '../invariants.mjs';

const ROUNDS = 4;
const CI_RED_INVARIANT = 'ci-heal-dispatched-on-stale-rerun';
const REVIEW_STARVED_INVARIANT = 'review-never-dispatched';

export default {
  id: 'ci-heal-stale-rerun-blocks-review',
  title: 'a required check\'s STALE, superseded run (from a rerun on the same head) reads ci-red forever, dispatching a ci-heal that finds nothing and permanently starving the review this PR was actually owed',
  card: 'we:backlog/fix-review-ciheal-deadlock — live deadlock, PR #2878 (WE #4358)',
  fixedBy: {
    sha: 'this same PR', where: 'this same PR (we:backlog/fix-review-ciheal-deadlock)',
    paths: ['scripts/progress-board.mjs', 'scripts/operations/pr-status.mjs'],
  },
  fixPresent(root) {
    const has = (rel, re) => { try { return re.test(readFileSync(join(root, rel), 'utf8')); } catch { return false; } };
    return has('scripts/progress-board.mjs', /collapseRollupToLatestPerName\(rollup\)\.some/)
      // Either spelling: filtering the collapse inline, or filtering a `collapsed` const bound to it first
      // (reduceCheckState binds it so the implied-required-check reducer reads the same collapsed rollup).
      && has('scripts/operations/pr-status.mjs',
        /collapseRollupToLatestPerName\(runs\)\.filter|const collapsed = collapseRollupToLatestPerName\(runs\);[\s\S]*?collapsed\.filter/);
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:ci-heal-stale-rerun-blocks-review',
      rounds: ROUNDS,
      daemons: ['fix-dispatch', 'review'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w) {
        // The review CI gate only trusts a declared (live) required set — serve the fallback set as branch protection.
        w.gh.setRequiredChecks('we', FALLBACK_REQUIRED_STATUS_CHECKS);
        const head = 'lane/soak-stale-rerun-review-pending';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/stale-rerun-review-pending.txt': 'a change awaiting review, whose CI reran once on this same head\n' } });
        const pr = w.gh.openPr({
          repo: 'we', head, base: 'main', title: 'soak: review:pending, a required check reran (stale FAILURE, latest SUCCESS)',
          labels: ['review:pending'], body: 'No backlog item.',
        });
        // Two runs of `test` on the SAME head: a stale FAILURE (superseded) then the LATEST SUCCESS. `smoke`/
        // `daemon-soak` — the other two FALLBACK-required checks (`we:scripts/lib/required-status-checks.mjs`,
        // no branch-protection fixture available in the fake `gh`) — each ran once, green.
        w.gh.setChecks('we', pr, [
          { name: 'test', conclusion: 'FAILURE' }, // stale — superseded below
          { name: 'smoke', conclusion: 'SUCCESS' },
          { name: 'daemon-soak', conclusion: 'SUCCESS' },
          { name: 'test', conclusion: 'SUCCESS' }, // the LATEST run of `test` — this is the one that counts
        ]);
        return { pr, healSeen: false, reviewSeen: false };
      },
      perRound(w, round, ctx, api) {
        const heals = w.claude.sessions().filter((s) => sessionMatches(s.name, 'ci-heal', ctx.pr));
        const reviews = w.claude.sessions().filter((s) => sessionMatches(s.name, 'review', ctx.pr));
        if (heals.length) ctx.healSeen = true;
        if (reviews.length) ctx.reviewSeen = true;
        api.say(`r${String(round).padStart(2, '0')} PR #${ctx.pr}: ${heals.length} ci-heal session(s), ${reviews.length} review session(s)`);
        if (round === ROUNDS - 1) {
          if (ctx.healSeen) {
            api.violation(CI_RED_INVARIANT, `PR #${ctx.pr} got a ci-heal dispatched against a stale, superseded check run — every required check's LATEST run was green`);
          }
          if (!ctx.reviewSeen) {
            api.violation(REVIEW_STARVED_INVARIANT, `PR #${ctx.pr} never got a review dispatched over ${ROUNDS} rounds despite carrying review:pending with no other blocker`);
          }
        }
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === CI_RED_INVARIANT || v.invariant === REVIEW_STARVED_INVARIANT)
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
