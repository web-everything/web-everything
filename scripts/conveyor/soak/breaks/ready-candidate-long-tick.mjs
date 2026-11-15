/** A ready candidate arrives during a complete PR action in a long tick. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';

const PRS = [41, 42];
export default {
  id: 'ready-candidate-long-tick',
  title: 'a long tick yields for a ready candidate after one complete PR action',
  card: 'R889',
  fixedBy: { sha: 'adopt-yield-S1', where: 'working-tree', paths: [
    'scripts/lib/daemon-rebuild/adopt-yield.mjs',
    'scripts/operations/promote-draft-pr-dispatch.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs'), 'utf8')
        .includes('yieldedForAdoption');
    } catch { return false; }
  },
  async run({ log } = {}) {
    let time = 0;
    let ready = null;
    const events = [];
    try {
      // Dynamic import lets the pre-fix tree reproduce the break instead of failing to load it.
      let probe = () => false;
      try {
        const { createAdoptYieldProbe } = await import('../../../lib/daemon-rebuild/adopt-yield.mjs');
        probe = createAdoptYieldProbe({ root: '.', bootHead: 'boot-head', env: {},
          now: () => time, readReady: () => ready });
      } catch { /* The pre-fix implementation has no safe-point probe. */ }
      const result = runReconcilePromoteDraftDispatch({
        root: '.', repo: null,
        reconcile: () => ({ dispatch: PRS.map(prNumber => ({ kind: 'promote-draft', prNumber,
          headRefOid: String(prNumber).padStart(40, '0'), baseRefName: 'main' })), refusals: [] }),
        provider: { ready(pr) {
          events.push(`start:${pr}`);
          time += 20 * 60_000; // simulated long action; never sleep or interrupt it
          ready = { prevHead: 'boot-head', passedAt: '2026-11-14T20:00:00.000Z',
            adopt: { finalSha: 'candidate-head' } };
          events.push(`done:${pr}`);
        } },
        shouldYield: () => {
          const yieldNow = probe();
          if (yieldNow) events.push('yield');
          return yieldNow;
        },
        checkStaleness: () => ({}), readHeadCheckState: () => ({ state: 'green' }),
        readPrLabels: () => [], clearAwaitingCi: () => {},
        deadlineAt: 60 * 60_000, now: () => time,
      });
      const report = { result, events };
      log?.(JSON.stringify(report));
      return report;
    } catch (error) { return { error: String(error?.message ?? error), events }; }
  },
  judge(report) {
    if (!report?.result) return [`[incomplete-report] ${report?.error ?? 'missing result'}`];
    const problems = [];
    if (report.result.yieldedForAdoption !== true) problems.push('[no-yield] ready candidate held until tick end');
    if (JSON.stringify(report.events) !== JSON.stringify(['start:41', 'done:41', 'yield'])) {
      problems.push('[safe-point] yield must follow the first complete action and precede the next');
    }
    if (report.result.handled !== 1 || report.result.nextCursor !== 42
      || JSON.stringify(report.result.deferred) !== JSON.stringify([42])) {
      problems.push('[resume-cursor] deferred PR must retain its cursor');
    }
    return problems;
  },
};
