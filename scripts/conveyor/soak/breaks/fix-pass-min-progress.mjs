/**
 * LIVE incident, 2026-11-12 (R362/R907): with a per-PR deadline alone, a phase whose blocking prelude (reconcile)
 * always outruns its budget would defer every PR on every pass and never promote or heal anything. Replay a
 * promote-draft phase whose reconcile spends the whole budget: the first PR must still be handled, and the rest
 * deferred with a cursor for the next pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';

const PRS = [201, 202];

export default {
  id: 'fix-pass-min-progress',
  title: 'a budgeted phase handles at least one PR per pass even when its prelude overruns the budget',
  card: 'R907',
  fixedBy: {
    sha: '317ca20764',
    where: 'lane/fix-daemon-notes-cursor',
    paths: ['scripts/operations/promote-draft-pr-dispatch.mjs'],
  },
  fixPresent(root) {
    const path = join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs');
    return existsSync(path) && readFileSync(path, 'utf8').includes('handled > 0 && deadlineAt');
  },
  async run({ log } = {}) {
    const deadlineAt = 120_000;
    let time = 0;
    const promoted = [];
    try {
      const result = runReconcilePromoteDraftDispatch({
        reconcile: () => {
          time = deadlineAt + 5_000; // the prelude alone outruns the budget
          return { dispatch: PRS.map(prNumber => ({ kind: 'promote-draft', prNumber,
            headRefOid: String(prNumber).padStart(40, '0'), baseRefName: 'main' })), refusals: [] };
        },
        provider: { ready(pr) { promoted.push(pr); } },
        checkStaleness: () => ({}),
        readHeadCheckState: () => ({ state: 'green' }),
        readPrLabels: () => [],
        clearAwaitingCi: () => {},
        deadlineAt,
        now: () => time,
      });
      const report = { result, promoted };
      log?.(JSON.stringify(report));
      return report;
    } catch (error) {
      return { error: String(error?.message ?? error), promoted };
    }
  },
  judge(report) {
    const problems = [];
    if (!report?.result) return [`[incomplete-report] ${report?.error ?? 'missing dispatch result'}`];
    const { result, promoted } = report;
    if (JSON.stringify(promoted) !== JSON.stringify([PRS[0]]) || result.handled !== 1) {
      problems.push('[min-progress] expected exactly the first PR handled although the prelude overran the budget');
    }
    if (JSON.stringify(result.deferred) !== JSON.stringify([PRS[1]]) || result.nextCursor !== PRS[1]) {
      problems.push('[resume-cursor] the second PR must be deferred with nextCursor pointing at it');
    }
    return problems;
  },
};
