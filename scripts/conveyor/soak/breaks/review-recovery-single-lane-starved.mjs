/** PR #7023 red team: halving lane capacity for ordinary review rounds also starved red-team-only recovery. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'skills-src/conveyor/review-daemon.mjs';
const NOOP = () => {};

export default {
  id: 'review-recovery-single-lane-starved',
  title: 'PR #7023: one free lane, no ordinary reviews — red-team-only recovery skipped for "no review capacity left" every tick',
  card: 'PR #7023 post-accept red team',
  fixedBy: { sha: 'c7bd2c8e4c,f7415de704', where: 'lane/review-cap-16', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('defaultRecoveryLaneNumbers') && source.includes('recovery lane read failed');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const mod = await import(pathToFileURL(join(root, SOURCE)).href);
    const violations = [];
    // The production readers, fed a pool with exactly one acquirable lane.
    const readLanes = () => [7];
    const recoveryReader = typeof mod.defaultRecoveryLaneNumbers === 'function'
      ? { recoveryAcquirableLanes: opts => mod.defaultRecoveryLaneNumbers(opts, { readLanes }) } : {};
    const recovery = (sink) => ({ capacity }) => {
      sink.lanes = capacity.lanes;
      if (capacity.lanes < 1 || capacity.remainingStarts < 1) return { dispatched: [], skipped: ['no review capacity left'] };
      capacity.take(); capacity.lanes--; capacity.remainingStarts--;
      return { dispatched: [{ prNumber: 900 }] };
    };
    const base = { holdReconcile: () => [], tagRound: NOOP, tagStatus: NOOP, statusCandidates: () => [],
      hostAdmission: () => ({ admitted: true, maxPerTick: 4 }), liveReviewBudget: { left: 4 } };
    const seen = {};
    const out = mod.runReviewTick({ ...base, reconcile: () => ({ dispatch: [], refusals: [] }), dispatch: NOOP,
      acquirableLanes: opts => mod.defaultAcquirableLaneNumbers(opts, { readLanes }), ...recoveryReader,
      redTeamOnSkip: recovery(seen) });
    if (seen.lanes !== 1 || out.redTeamOnSkip?.dispatched?.length !== 1) {
      violations.push(`recovery-only tick with one free lane: recovery saw ${seen.lanes} lane(s), started ${out.redTeamOnSkip?.dispatched?.length ?? 0}`);
    }
    // The recovery-only lane read runs before ordinary dispatch; its failure must not abort the tick.
    let dispatched = 0;
    try {
      mod.runReviewTick({ ...base, reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 100, attempts: 0 }], refusals: [] }),
        dispatch: () => { dispatched++; return { agentId: 'ordinary' }; }, acquirableLanes: () => 2,
        recoveryAcquirableLanes: () => { throw new Error('lane pool unreadable'); }, redTeamOnSkip: recovery({}) });
    } catch (e) { violations.push(`throwing recovery lane read aborted the tick: ${String(e?.message ?? e)}`); }
    if (dispatched !== 1) violations.push(`throwing recovery lane read: ordinary dispatch started ${dispatched} review(s), expected 1`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
