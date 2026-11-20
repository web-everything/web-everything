/** Regression: catch-up must prioritise urgent work and never park it behind an ineligible overlap target. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const urgent = { ...pr(2, 1, ['priority:urgent']), urgentLabelVerified: true };
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
  if (result.error || result.status !== 0) throw new Error('urgent/parked drain probe failed', { cause: result.error ?? new Error(result.stderr) });
  try {
    const report = JSON.parse(result.stdout.trim().split('\n').pop());
    if (report?.seam !== true || !Array.isArray(report.violations)
      || !report.violations.every(v => typeof v === 'string')) throw new Error('invalid report');
    return report;
  } catch (cause) { throw new Error('urgent/parked drain probe returned an unreadable report', { cause }); }
}

export default {
  id: 'drain-urgent-behind-parked',
  title: 'Urgent catch-up work waits behind a deferred or parked overlapping PR',
  card: 'drain-priority-label-prep acceptances 1, 2 and 3',
  fixedBy: { sha: 'pending', where: 'drain priority and pass-local eligibility', paths: [
    'scripts/lib/enqueue-on-event.mjs', 'scripts/conveyor/overlap-yield-enqueueable.mjs', 'scripts/merge-ai-prs.mjs',
    'scripts/lib/merge-queue-adaptive-batching.mjs',
  ] },
  // Registration checks source only: a behavioural regression must fail run(),
  // never select it.fails. Read every source eagerly so unreadable files throw.
  fixPresent(root) {
    const [enqueue, overlap, batching] = [
      'scripts/lib/enqueue-on-event.mjs',
      'scripts/conveyor/overlap-yield-enqueueable.mjs',
      'scripts/lib/merge-queue-adaptive-batching.mjs',
    ].map(path => readFileSync(join(root, path), 'utf8'));
    return /^\s*override: priority\?\.mode === 'enforce' && pr\.urgentLabelVerified === true && pr\.labels\?\.some\(label => label\.name === 'priority:urgent'\) \? \{ value: 'urgent', byOperator: true \} : undefined,/m.test(enqueue)
      && /^\s*if \(\['BEHIND', 'BLOCKED', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE'\]\.includes\(row\.mergeStateStatus\)\) return false;/m.test(overlap)
      && /^\s*if \(!row\.requiredCheckGreen \|\| !labels\.has\('ready-to-merge'\)/m.test(overlap)
      && /'parked', 'hold'\]\.some\(\(label\) => labels\.has\(label\)\)/.test(overlap)
      && /^\s*const enqueueEligibility = new Map\(\);/m.test(batching)
      && /enqueueEligibility\.set\(suspect, false\)/.test(batching)
      && /admitEnqueue\(\{ state, num, nowMs: nowMs\(\), settings, inQueue: facts\.inQueue, priorityClass, enqueueEligibility \}\)/.test(batching);
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    return probe(root);
  },
  judge(report) { return report.violations; },
};
