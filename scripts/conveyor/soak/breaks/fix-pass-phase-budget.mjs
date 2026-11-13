/**
 * LIVE incident, 2026-11-12 ~12:29 ET (R362): a fix-dispatch pass took
 * 2485.6 s. promote-draft ran 643 s against its 120 s budget, and ci-heal
 * ran 467 s against 180 s: budgets were checked only between repositories.
 * Replay a single repository with three promotions. The first finishes after
 * the phase deadline; the remaining PRs must wait for the next pass, whose
 * cursor starts at the second PR.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';

const PRS = [101, 102, 103];

export default {
  id: 'fix-pass-phase-budget',
  title: 'fix-dispatch phase yields within a repository when its budget expires',
  card: 'R362',
  fixedBy: {
    sha: 'b4421f60bd',
    where: 'lane/fix-daemon-pr-budgets',
    paths: [
      'scripts/operations/promote-draft-pr-dispatch.mjs',
    ],
  },
  fixPresent(root) {
    const path = join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs');
    return existsSync(path) && readFileSync(path, 'utf8').includes('deadlineAt');
  },
  async run({ log } = {}) {
    const deadlineAt = 120_000;
    let time = 0;
    const promoted = [];
    try {
      const result = runReconcilePromoteDraftDispatch({
        reconcile: () => ({
          dispatch: PRS.map(prNumber => ({
            kind: 'promote-draft', prNumber,
            headRefOid: String(prNumber).padStart(40, '0'),
            baseRefName: 'main',
          })),
          refusals: [],
        }),
        provider: {
          ready(pr) {
            promoted.push(pr);
            time = deadlineAt + 1;
          },
        },
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
    if (JSON.stringify(promoted) !== JSON.stringify([PRS[0]])
        || result.handled !== 1
        || JSON.stringify(result.dispatched) !== JSON.stringify([{ pr: PRS[0], kind: 'promote-draft' }])
        || !Array.isArray(result.refusals) || result.refusals.length !== 0) {
      problems.push('[phase-budget] expected only the first PR to finish promotion before yielding');
    }
    if (JSON.stringify(result.deferred) !== JSON.stringify(PRS.slice(1))) {
      problems.push('[deferred-prs] remaining PRs were not deferred after the phase deadline');
    }
    if (result.nextCursor !== PRS[1]) {
      problems.push('[resume-cursor] nextCursor must point to the second PR for the next pass');
    }
    return problems;
  },
};
