/**
 * @file breaks/review-human-red-ci-never-healed.mjs — live break, 2026-10-04 (PR #3833). A `review:human` PR
 * with a genuinely red required check was never dispatched a ci-heal.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #3833 (`review:human`, `ci:failed`, required `test` red from an
 * unrelated flaky test). For ~9 hours the fix-dispatch daemon logged "refused own-failure … owed a ci-heal, not a
 * rebase" and "reconcile-refused review-ci … test=failure" on every pass, and planned no ci-heal. Cause:
 * `classifyPr` ranks `review:human` ('needs-human') above `ci-red`, so `planReconcile`'s ci-red branch never ran
 * for it; the main-red watch said "owed a ci-heal" and the review row said "red CI", and nothing owned the heal.
 *
 * FIX — `reconcile-core.mjs#planReconcile`: `ciRepairOwed` also holds for a needs-human PR whose required check
 * is COMPLETED red. A CI repair is not a review decision.
 *
 * SCENARIO: ONE PR, labels `review:human` + `ci:failed`, required `test` FAILURE, no backlog item. It owes a
 * `ci-heal`. RED = the `owed` invariant fires (no ci-heal dispatched within grace). GREEN = a ci-heal dispatches.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runSoak } from '../soak.mjs';

const ROUNDS = 9; // exceeds invariants.mjs#DEFAULT_BOUNDS.owedGraceTicks (6) with margin
const WE_SLUG = CONSTELLATION_REPOS.we.slug;

export default {
  id: 'review-human-red-ci-never-healed',
  title: 'a review:human PR with a red required check is owed a ci-heal that the planner never dispatches',
  card: 'owed-ci-heal never dispatched — live PR #3833 (epic #3383/#4075)',
  fixedBy: { sha: 'bd101ed9e', where: 'lane/owed-ciheal-dispatch', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('const ciRepairOwed =');
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:review-human-red-ci-never-healed',
      rounds: ROUNDS,
      daemons: ['fix-dispatch'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w, { api }) {
        w.gh.setRequiredChecks('we', ['test', 'smoke', 'daemon-soak']);
        const head = 'lane/soak-review-human-red';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/review-human-red.txt': 'a parked PR whose CI went red\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: 'soak: review:human + red required check', labels: ['review:human'], body: 'No backlog item.' });
        execFileSync('gh', ['label', 'create', 'ci:failed', '--repo', WE_SLUG], { env: { ...process.env, ...w.env }, stdio: 'ignore' });
        w.gh.addLabels('we', pr, ['ci:failed']);
        w.gh.setChecks('we', pr, [{ name: 'test', conclusion: 'FAILURE' }]);
        api.owe(pr, 'ci-heal', 'review:human + red required check');
        return { pr };
      },
      log,
    });
  },
  judge(report) {
    const pr = report.ctx?.pr;
    return report.violations
      .filter((v) => v.invariant === 'owed' && pr != null && v.detail.includes(`PR #${pr} `) && v.detail.includes('ci-heal'))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
