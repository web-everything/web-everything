/** Regression: catch-up must prioritise urgent work and never park it behind an ineligible overlap target. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const { planCatchUp } = await import(process.argv[1]);
const { buildOverlapRows, planLabelDrain } = await import(process.argv[2]);
const { overlapYieldWaits } = await import(process.argv[3]);
const repo = 'owner/repo';
const pr = (number, additions, labels) => ({ number, num: number, readyAt: number,
  baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false,
  labels: ['ready-to-merge', 'review:accepted', ...labels].map(name => ({ name })),
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  files: [{ path: 'shared.mjs', additions, deletions: 0 }] });
const urgent = pr(2, 1, ['priority:urgent']);
const plain = pr(1, 100, []);
const violations = [];
const order = planCatchUp({ prs: [plain, urgent], queued: 0, capacity: 1, repo, now: 1000,
  priority: { mode: 'enforce', agingHours: null } });
if (order.run[0]?.num !== 2) violations.push('urgent PR lost the only catch-up slot to older plain work');
for (const parked of ['parked', 'hold', 'review:pending', 'deferred']) {
  const target = pr(1, 100, parked === 'deferred' ? [] : [parked]);
  const verdicts = [{ num: 2, repo, decision: 'merge' },
    { num: 1, repo, decision: parked === 'deferred' ? 'batching-deferred' : 'merge' }];
  const rows = buildOverlapRows({ candidates: verdicts, verdicts, localSlug: repo,
    openPrContext: { prsByRepo: new Map([[repo, [urgent, target]]]) } });
  const waits = overlapYieldWaits({ candidates: rows.candidateRows, openPrs: rows.openPrRows, nowMs: 1000, ignoreBudget: true });
  const plan = planLabelDrain(verdicts, { overlapContext: waits, overlapLocalSlug: repo });
  if (!plan.ready.some(p => p.num === 2)) violations.push('urgent PR yielded behind ' + parked + ' target');
}
console.log(JSON.stringify({ seam: typeof planCatchUp === 'function', violations }));
`;

function probe(root) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    ...['scripts/lib/enqueue-on-event.mjs', 'scripts/merge-ai-prs.mjs', 'scripts/conveyor/land-overlap-yield.mjs']
      .map(path => pathToFileURL(join(root, path)).href)], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WE_UNDER_TEST: '1', WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE: '1', WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE: '1' },
  });
  try { return result.status === 0 ? JSON.parse(result.stdout.trim().split('\n').pop()) : null; }
  catch { return null; }
}

export default {
  id: 'drain-urgent-behind-parked',
  title: 'Urgent catch-up work waits behind a deferred or parked overlapping PR',
  card: 'drain-priority-label-prep acceptances 1, 2 and 3',
  fixedBy: { sha: 'pending', where: 'drain priority and pass-local eligibility', paths: [
    'scripts/lib/enqueue-on-event.mjs', 'scripts/conveyor/overlap-yield-enqueueable.mjs', 'scripts/merge-ai-prs.mjs',
  ] },
  // Detect the callable seam, independently of the outcome: a regression remains a failure.
  fixPresent(root) { return probe(root)?.seam === true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    return probe(root) ?? { violations: ['urgent/parked drain probe could not run'] };
  },
  judge(report) { return report.violations; },
};
