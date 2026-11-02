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
  fixPresent(root) { return readFileSync(join(root, 'scripts/merge-ai-prs.mjs'), 'utf8').includes('retainPriority = false'); },
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
    // Send-back: the listing-only path must recover even though classification never admits a merge.
    let listedMarks = 0; let listedNudges = 0;
    await drain.repollUnknownListings({ prsByRepo: new Map([['example/web', [pr()]]]),
      read: async () => pr(), sleep: async () => {}, setting: { retries: 1, delayMs: 0 },
      onPersistentUnknown: () => { listedMarks += 1; }, nudge: () => { listedNudges += 1; } });
    if (listedMarks !== 1 || listedNudges !== 1) violations.push('a listing-only UNKNOWN never reached durable recovery');
    if (typeof drain.pruneStuckUnknown !== 'function') violations.push('no durable UNKNOWN lifecycle recovery');
    else {
      const repo = 'example/web';
      const marks = drain.markStuckUnknown(new Map(), { repo, num: 42, now: 0 });
      const resolved = drain.pruneStuckUnknown(marks, { prs: [{ repo, num: 42, mergeable: 'MERGEABLE' }], retainPriority: true });
      if (!resolved.has(`${repo}#42`)) violations.push('the early resolved read discarded starvation priority before landing');
      if (drain.decideStuckUnknownAlert(resolved, { now: 80 * 60_000 }).length) violations.push('resolved mergeability retained a stale alert');
      const absent = drain.pruneStuckUnknown(marks, { prs: [], listedRepos: [repo], retainPriority: true });
      if (absent.size || drain.decideStuckUnknownAlert(absent, { now: 80 * 60_000 }).length) violations.push('departed PR retained its UNKNOWN mark or alert');
      const candidates = [1, 7, 42].map(num => ({ repo, num, item: num, decision: 'merge' }));
      const ordered = drain.planLabelDrain(candidates, { readyOrder: { priority: { mode: 'enforce' },
        stuckUnknownMarks: marks, now: 60_000,
        infoOf: c => ({ readyAtMs: c.num, facts: { incident: { open: true, owner: c.num === 1 } } }),
      } });
      if (ordered.ready.map(c => c.num).join() !== '1,42,7') violations.push('starvation priority displaced a higher class or failed to advance in class');
      if (ordered.readyOrder.map(c => c.num).join() !== ordered.ready.map(c => c.num).join()) violations.push('logged plan order disagreed with ready candidates');
      if (!drain.decideStuckUnknownAlert(marks, { now: 20 * 60_000, afterMinutes: 10 }).length
        || drain.decideStuckUnknownAlert(marks, { now: 20 * 60_000 }).length) violations.push('configured alert threshold fell back to the default');
    }
    const now = 80 * 60_000;
    const plan = planCatchUp({ prs: [{ num: 42, labels: [{ name: 'ready-to-merge' }], baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, inQueue: false, readyAt: 0 }],
      queued: 0, capacity: 5, pendingNums: [42], pendingSince: new Map([[42, 0]]), pendingExpiryMinutes: 15, repo: 'example/web', now });
    if (!plan.run.some((r) => r.num === 42)) violations.push('an 80-minute stale pending catch-up entry was never retried');
    return { violations };
  },
  judge(report) { return report.violations; },
};
