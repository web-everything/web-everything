/** DRAIN-YIELD-LANDABLE: replay the real row builder and drain planner without network IO.
 * This pins release in a subsequent plan of the same pass; it does not simulate a GitHub merge.
 */
import { buildOverlapRows, planLabelDrain } from '../../../merge-ai-prs.mjs';
import { overlapYieldWaits } from '../../land-overlap-yield.mjs';
import { isAffirmativeMqSameHeadFailure } from '../../overlap-yield-enqueueable.mjs';

const repo = 'web-everything/web-everything';
export function replay(buildRows = buildOverlapRows, {
  detail = 'failed_checks; non-infrastructure failed check(s): test; main was not red at removal',
  affirmative = isAffirmativeMqSameHeadFailure,
} = {}) {
  const verdicts = [7399, 7369].map(num => ({ num, repo: null, decision: 'merge' }));
  const remaining = verdicts.map(v => ({ ...v }));
  const heldKeys = new Set();
  const openPrContext = { prsByRepo: new Map([[null, verdicts.map(v => ({
    number: v.num, baseRefName: 'main', labels: ['review:accepted', 'ready-to-merge'],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    files: [{ path: 'scripts/merge-ai-prs.mjs', additions: v.num === 7369 ? 100 : 1, deletions: 0 }],
  }))]]) };
  const plan = () => {
    const rows = buildRows({ candidates: remaining, verdicts, openPrContext, localSlug: repo, heldKeys });
    // Deliberately bypass wall-clock budgets: release must result from the hold, never expiry.
    const overlapContext = overlapYieldWaits({ candidates: rows.candidateRows, openPrs: rows.openPrRows, nowMs: 0, ignoreBudget: true });
    const result = planLabelDrain(remaining, { overlapContext, overlapLocalSlug: repo });
    return { ready: result.ready.map(v => v.num), waits: result.deferred.map(v => ({ num: v.num, waitOn: v.waitOn })) };
  };
  const before = plan();
  remaining[1].decision = 'skip'; // enqueue refused L; original verdict still says merge
  const outcome = { outcome: 'not-enqueued', kind: 'mq-same-head-failed', num: 7369, repo,
    reason: `mq-same-head-failed: #7369 head ${'a'.repeat(40)} — ${detail}` };
  if (affirmative(outcome)) heldKeys.add(`${repo}#7369`);
  return { before, after: plan(), again: plan(), originalDecision: verdicts[1].decision };
}

export function replayCases(buildRows = buildOverlapRows, affirmative = isAffirmativeMqSameHeadFailure) {
  return { ...replay(buildRows, { affirmative }), unreadable: replay(buildRows, { affirmative,
    detail: 'unreadable or mismatched live merge-queue state; inspect queue before retrying',
  }) };
}

export default {
  id: 'overlap-yield-skips-mq-held-target',
  title: 'overlap waiters release for confirmed failures and stay yielded for unreadable queue state',
  card: 'DRAIN-YIELD-LANDABLE',
  fixedBy: { sha: 'HEAD', where: 'DRAIN-YIELD-LANDABLE', paths: [
    'scripts/conveyor/overlap-yield-enqueueable.mjs', 'scripts/merge-ai-prs.mjs',
  ] },
  // Behaviour decides fix presence. Never inspect source text for a token.
  fixPresent() { return this.judge(replayCases()).length === 0; },
  async run({ log } = {}) {
    const report = replayCases();
    log?.(JSON.stringify(report));
    return report;
  },
  judge(report) {
    const failures = [];
    if (JSON.stringify(report.before.waits) !== JSON.stringify([{ num: 7399, waitOn: ['overlap-yield:#7369'] }])) failures.push('S must initially yield to L');
    for (const key of ['after', 'again']) {
      if (JSON.stringify(report[key].ready) !== '[7399]' || report[key].waits.length) failures.push(`${key}: S must be released and L must remain held`);
    }
    if (report.originalDecision !== 'merge') failures.push('pass-start verdict was mutated');
    for (const key of ['after', 'again']) {
      const plan = report.unreadable[key];
      if (plan.ready.length || JSON.stringify(plan.waits) !== JSON.stringify([{ num: 7399, waitOn: ['overlap-yield:#7369'] }])) {
        failures.push(`${key}: unreadable queue state must keep S yielded`);
      }
    }
    return failures;
  },
};
