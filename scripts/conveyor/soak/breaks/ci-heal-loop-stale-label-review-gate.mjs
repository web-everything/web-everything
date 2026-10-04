/**
 * @file breaks/ci-heal-loop-stale-label-review-gate.mjs — live break, 2026-09-26 (#4075/#3383, card 4249
 * follow-up). PR #2748 (web-everything/web-everything) got SIX `ci-heal-2748` sessions in ~30 minutes (15:48–16:18 ET).
 * Its required `test` check was GREEN; the only red check was `review-gate`, which is red BY DESIGN while
 * `review:pending` stands (a hold signal, not a code-health signal). Every session correctly found nothing to
 * heal and stood down — and the next fix-dispatch tick sent another one.
 *
 * MECHANISM — an interaction between the resident DRAIN (`merge-ai-prs.mjs --label=ready-to-merge --watch`) and
 * the fix-DISPATCH daemon:
 *   1. `ci:failed` had been applied earlier, legitimately, by `we:scripts/merge-ai-prs.mjs`'s ci-lifecycle
 *      reconcile, while `test` really was red.
 *   2. That reconcile only ever touched (added OR removed) ci-lifecycle labels on a `ciLifecycleCertified` PR
 *      (AI-generated / `ready-to-merge` / `review:accepted`). #2748's long-lived branch had absorbed the drain's
 *      own bookkeeping commits, so it read UNCERTIFIED and the whole reconcile was skipped every pass — the stale
 *      `ci:failed` was never cleared once `test` went green (live timeline: added once at 19:26Z, never removed).
 *   3. The dispatcher: the fix-dispatch daemon's ci-heal half (`we:skills-src/conveyor/reconcile-fix-dispatch-
 *      daemon.mjs#runReconcileCiHealDispatchAllRepos` → `we:scripts/operations/ci-heal-pr-dispatch.mjs
 *      #runReconcileCiHealDispatch` → `we:scripts/conveyor/reconcile-core.mjs#planReconcile`) borrows its phase
 *      from `we:scripts/progress-board.mjs#classifyPr`, which returned `ci-red` for `ciFailed(rollup) ||
 *      labels.has('ci:failed')` — trusting the stale label even though its own rollup proved `test` green.
 *      `ci-red` → a `kind:'ci-heal'` dispatch. The durable ci-heal cap (`CI_HEAL_ROUND_CAP`, counted off the
 *      `🩹 conveyor CI-heal` marker comment) is never consumed by a session that posts no marker, and the
 *      liveness guard only blocks while a `ci-heal-<pr>` session is still running — so every session that
 *      finished bought the next one. An unbounded loop.
 *   (`we:scripts/operator/dispatch.mjs#healCi` also counted `review-gate` as a failure, but it has no caller in
 *   any running daemon, so it plays no part in this soak.)
 *
 * FIX — PR #2764, merge commit f264b7f81 (on main):
 *   - `merge-ai-prs.mjs`: an `else` arm on the TOTAL ci-lifecycle reconcile — an UNCERTIFIED PR still gets any
 *     owned stale ci-lifecycle label (`checking`/`ci:failed`/`blocked`) removed once the required check reads
 *     green (only ADDING still needs certification).
 *   - `progress-board.mjs#classifyPr`: the `ci:failed` label is only trusted when the rollup can NOT prove the
 *     required check green (`labels.has('ci:failed') && !isRequiredCheckGreen(pr)`).
 *   - `operator/dispatch.mjs#healCi`: excludes `CI_TRUTH_EXCLUDED_CHECKS` (latent; unwired, not exercised here).
 * EITHER of the first two alone breaks the loop in this soak: classifyPr's stops the first dispatch outright;
 * the drain's clears the label on its first pass, so only the one dispatch that raced it gets through (verified:
 * reverting progress-board.mjs alone = exactly one ci-heal, label gone after round 0 → GREEN). So
 * RED needs BOTH reverted (red-green.mjs's default: all three non-test paths of the merge), and `fixPresent` is
 * an OR of their two source markers.
 *
 * SCENARIO: no default fleet (its PRs would add unrelated dispatches). ONE PR shaped like #2748: labels
 * `review:pending` + a stale `ci:failed`; checks `test=SUCCESS`, `review-gate=FAILURE`; ordinary non-AI commits,
 * so it reads uncertified to merge-ai-prs. Each round ticks the REAL fix-dispatch daemon, then the REAL
 * `drain` pass daemon — one pass of `merge-ai-prs.mjs --label=ready-to-merge` (`sim/daemon-host.mjs#PASS_DAEMONS`;
 * NOT the bare `merge-sweep`, whose missing `--label` turns the ci-lifecycle reconcile off entirely,
 * `scripts/lib/reconcile-predicate.mjs#reconcileWouldRunFor`). The dispatched ci-heal
 * session runs the soak's default seeded plan (for `ci-heal-1` under seed 1: push a commit, leave junk, exit
 * done — never posting the ci-heal marker), which is enough to show the loop: the session ends, the label stays,
 * the next tick redispatches.
 *
 * RED = a second `ci-heal-<pr>` session is dispatched at the PR (pre-fix: round 0 and again round 3, the moment
 * the first one exits; `ci:failed` stays on the PR the whole time). GREEN = at most ONE ci-heal session for the
 * PR over the whole run (post-fix: none — classifyPr reads `needs-review`, and the drain clears `ci:failed` on
 * its first pass). 5 rounds: the redispatch lands in round 3 and is observed by the round-4 hook.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runSoak } from '../soak.mjs';
import { sessionMatches } from '../invariants.mjs';

const ROUNDS = 5;
const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const INVARIANT = 'ci-heal-redispatch';

function labelNames(w, pr) {
  return (w.gh.pr('we', pr)?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
}

export default {
  id: 'ci-heal-loop-stale-label-review-gate',
  title: 'a stale ci:failed on an uncertified review:pending PR (test green, only review-gate red) is never cleared, so ci-heal is redispatched every time a session stands down',
  card: 'PR #2764 (card 4249 follow-up, epic #4075/#3383) — live incident PR #2748, six ci-heal sessions in 30 min',
  fixedBy: {
    sha: 'f264b7f81',
    where: 'main',
    paths: ['scripts/merge-ai-prs.mjs', 'scripts/progress-board.mjs', 'scripts/operator/dispatch.mjs'],
  },
  fixPresent(root) {
    const has = (rel, re) => { try { return re.test(readFileSync(join(root, rel), 'utf8')); } catch { return false; } };
    // Either half alone breaks the loop in this soak (see header), so the break stays GREEN if either is present.
    return has('scripts/progress-board.mjs', /labels\.has\('ci:failed'\)\s*&&\s*!isRequiredCheckGreen\(pr\)/)
      || has('scripts/merge-ai-prs.mjs', /cleared stale ci-lifecycle label\(s\)/);
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:ci-heal-loop-stale-label-review-gate',
      rounds: ROUNDS,
      daemons: ['fix-dispatch', 'drain'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w) {
        const head = 'lane/soak-stale-ci-failed';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/stale-ci-failed.txt': 'a change awaiting review\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: 'soak: review:pending + stale ci:failed (test green, review-gate red)', labels: ['review:pending'], body: 'No backlog item.' });
        // `ci:failed` is not among the fake repo's seed labels — create it through the fake `gh` itself.
        execFileSync('gh', ['label', 'create', 'ci:failed', '--repo', WE_SLUG], { env: { ...process.env, ...w.env }, stdio: 'ignore' });
        w.gh.addLabels('we', pr, ['ci:failed']);
        w.gh.setChecks('we', pr, [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'review-gate', conclusion: 'FAILURE' }]);
        return { pr, maxSeen: 0 };
      },
      perRound(w, round, ctx, api) {
        const heals = w.claude.sessions().filter((s) => sessionMatches(s.name, 'ci-heal', ctx.pr));
        const labels = labelNames(w, ctx.pr);
        api.say(`r${String(round).padStart(2, '0')} PR #${ctx.pr}: ${heals.length} ci-heal session(s) [${heals.map((s) => s.state).join(',')}]; labels ${labels.join(',')}`);
        if (heals.length > 1 && heals.length > ctx.maxSeen) {
          api.violation(INVARIANT, `PR #${ctx.pr} dispatched ${heals.length} ci-heal sessions (test green, only review-gate red) — labels still ${labels.join(',')}`);
        }
        ctx.maxSeen = Math.max(ctx.maxSeen, heals.length);
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === INVARIANT)
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
