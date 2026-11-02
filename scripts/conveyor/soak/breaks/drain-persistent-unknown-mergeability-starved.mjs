/**
 * Live 2026-11-01: approved CLEAN PRs #6197 and #6189 were refused for 80+ minutes with
 * `not mergeable (mergeable=UNKNOWN)` after the bounded re-read; nothing nudged GitHub to recompute, the next pass did
 * not re-read them first, and catch-up logged "already pending" forever. A persistent UNKNOWN must stay refused
 * (fail closed) but be nudged and marked, and a stale catch-up pending entry must expire and be retried.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEAD = 'a'.repeat(40);
const pr = () => ({
  number: 42, title: 'Approved change', body: 'A concrete change summary.', headRefName: 'lane/approved', headRefOid: HEAD,
  baseRefName: 'main', state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  commits: [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
});

export default {
  id: 'drain-persistent-unknown-mergeability-starved',
  title: 'PRs #6197/#6189: a persistent UNKNOWN mergeability was refused for 80+ min with no nudge, no early re-read and a catch-up that never retried',
  card: 'drain persistent UNKNOWN mergeability (R372)',
  fixedBy: { sha: '104874e1d897e58a4a9185e9e9a8e153b35ec8e7', where: 'lane/drain-unknown-mergeability', paths: ['scripts/merge-ai-prs.mjs', 'scripts/lib/enqueue-on-event.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/merge-ai-prs.mjs'), 'utf8').includes('stuck-unknown-mergeability'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const drain = await import(pathToFileURL(join(root, 'scripts/merge-ai-prs.mjs')).href);
    const { planCatchUp } = await import(pathToFileURL(join(root, 'scripts/lib/enqueue-on-event.mjs')).href);
    const violations = [];
    let marked = 0; let nudged = 0;
    const verdict = await drain.revalidateWithUnknownRetry({
      repo: 'example/web', num: 42, read: async () => pr(), sleep: async () => {}, setting: { retries: 3, delayMs: 0 },
      opts: { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD },
      onPersistentUnknown: () => { marked += 1; }, nudge: () => { nudged += 1; },
    });
    if (verdict.decision === 'merge') violations.push('a persistent UNKNOWN mergeability was treated as mergeable');
    if (marked !== 1 || nudged !== 1) violations.push('a persistent UNKNOWN was not marked and nudged once');
    const now = 80 * 60_000;
    const plan = planCatchUp({ prs: [{ num: 42, labels: [{ name: 'ready-to-merge' }], baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, inQueue: false, readyAt: 0 }],
      queued: 0, capacity: 5, pendingNums: [42], pendingSince: new Map([[42, 0]]), pendingExpiryMinutes: 15, repo: 'example/web', now });
    if (!plan.run.some((r) => r.num === 42)) violations.push('an 80-minute stale pending catch-up entry was never retried');
    return { violations };
  },
  judge(report) { return report.violations; },
};
