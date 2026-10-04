/**
 * @file breaks/stale-fixing-label-ci-heal-owed.mjs — live break, 2026-09-26 (card 4249, epic #4075/#3383).
 * A PR that moved from being owed a FIX to being owed a CI-HEAL kept a stale `review-status:fixing` label forever.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #2742. Its `fix-2742` session finished (`state: 'done'`) and the
 * re-push went CI-red (`ci:failed`), so every review-daemon tick's plan carried a `kind:'ci-heal'` dispatch entry
 * for it. `we:skills-src/conveyor/review-daemon.mjs#runReviewTick` only fed `kind:'review'` / `kind:'fix'`
 * entries plus refusals to `we:scripts/conveyor/reconcile-core.mjs#selectStatusCandidates` — a ci-heal entry is
 * a real `dispatch` (not a refusal) while its cap is unspent, so the PR fell out of the review-status sweep and
 * `review-status:fixing` (added while the fix really was live) was never re-derived. The operator read "fixing"
 * on a PR nothing was touching.
 *
 * FIX — PR #2748 (`lane/4249-ci-lifecycle-drain-bookkeeping-commits`, not merged when this was written):
 * `runReviewTick` filters `kind:'ci-heal'` entries and passes them as `selectStatusCandidates`' fourth source
 * (`ciHealsOwed`); `we:scripts/conveyor/review-status-tag.mjs` also learned the `healing-ci`/`ci-heal-stalled`
 * states for a live `ci-heal-<pr>` session.
 *
 * SCENARIO (review daemon only, no default fleet): ONE PR shaped like #2742 — labels `review:pending`,
 * `ci:failed`, `review-round:1`, `review-status:fixing`; `test=FAILURE`; and a finished `fix-<pr>` session in
 * the fake claude store. The review daemon never dispatches a ci-heal itself, so no ci-heal session ever
 * starts — the correct status is "nothing live", i.e. the stale label is removed.
 *
 * RED  = `review-status:fixing` is still on the PR after the daemon has ticked twice (pre-fix: forever).
 * GREEN = the first tick clears it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { withStoreLock } from '../../../operations/__tests__/helpers/fake-claude-shim.mjs';
import { runSoak } from '../soak.mjs';

const ROUNDS = 3;
const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const STALE = 'review-status:fixing';
const INVARIANT = 'stale-review-status';

function labelNames(w, pr) {
  return (w.gh.pr('we', pr)?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
}

export default {
  id: 'stale-fixing-label-ci-heal-owed',
  title: 'a PR that went from fix-owed to ci-heal-owed keeps a stale review-status:fixing because ci-heal entries never reach the review-status sweep',
  card: 'card 4249 / PR #2748 (epic #4075/#3383) — live incident PR #2742',
  fixedBy: {
    sha: '2daaf2239',
    where: 'lane/4249-ci-lifecycle-drain-bookkeeping-commits',
    paths: ['skills-src/conveyor/review-daemon.mjs', 'scripts/conveyor/reconcile-core.mjs', 'skills-src/conveyor/runner.mjs'],
  },
  fixPresent(root) {
    try {
      const daemon = readFileSync(join(root, 'skills-src/conveyor/review-daemon.mjs'), 'utf8');
      return /statusCandidates\(\s*reviews,\s*plan\.refusals\s*\?\?\s*\[\],\s*fixes,\s*ciHeals\s*\)/.test(daemon);
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:stale-fixing-label-ci-heal-owed',
      rounds: ROUNDS,
      daemons: ['review'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w) {
        const head = 'lane/soak-stale-fixing';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/stale-fixing.txt': 'a fix whose re-push went CI-red\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: 'soak: fix finished, re-push CI-red, stale review-status:fixing', labels: ['review:pending'], body: 'No backlog item.' });
        // None of these are among the fake repo's seed labels — create them through the fake `gh` itself.
        for (const name of ['ci:failed', 'review-round:1', STALE]) {
          execFileSync('gh', ['label', 'create', name, '--repo', WE_SLUG], { env: { ...process.env, ...w.env }, stdio: 'ignore' });
        }
        w.gh.addLabels('we', pr, ['ci:failed', 'review-round:1', STALE]);
        w.gh.setChecks('we', pr, [{ name: 'test', conclusion: 'FAILURE' }]);
        // The fix session that added `review-status:fixing` — finished, not live.
        withStoreLock(w.claude.env.FAKE_CLAUDE_STORE, (s) => {
          s.sessions.push({ id: 'fix0soak', sessionId: 'fix0soak-session', name: `fix-${pr}`, kind: 'background', state: 'done', status: null, waitingFor: null, cwd: w.simCloneRoot, startedAt: new Date(0).toISOString() });
        });
        return { pr, reported: false };
      },
      perRound(w, round, ctx, api) {
        const labels = labelNames(w, ctx.pr);
        api.say(`r${String(round).padStart(2, '0')} PR #${ctx.pr}: labels ${labels.join(',')}`);
        // `perRound` runs BEFORE its round's tick: by round 2 the daemon has ticked twice.
        if (round >= 2 && !ctx.reported && labels.includes(STALE)) {
          ctx.reported = true;
          api.violation(INVARIANT, `PR #${ctx.pr} still carries ${STALE} after ${round} review ticks, though its fix session is done and it is owed a ci-heal`);
        }
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === INVARIANT || v.invariant === 'crash' || v.invariant === 'isolation')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
