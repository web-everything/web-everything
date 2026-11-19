/** #7183: a drain rebase must not be bounced using the previous head's conflict read. */
import { watchParkedPrConflicts, CONFLICT_LABEL, QUEUED_CONFLICT_GRACE_MS } from '../../parked-pr-conflict-watch.mjs';

function probe(watch = watchParkedPrConflicts) {
  const oldHead = '39e2b10f'.padEnd(40, '0'), newHead = 'c7c88378'.padEnd(40, '0');
  const now = Date.parse('2026-09-27T22:22:29Z');
  const pr = { number: 7183, headRefName: 'lane/7183', baseRefName: 'main', headRefOid: oldHead,
    mergeable: 'CONFLICTING', labels: ['review:accepted', 'ready-to-merge', CONFLICT_LABEL] };
  const violations = [];
  for (const mergeable of ['MERGEABLE', 'CONFLICTING']) {
    let bounces = 0;
    const entries = watch({ repo: 'web-everything/web-everything', listPrs: () => [pr], now,
      sameLineConflict: 'stand-down',
      inCardGroupFn: () => false, cardGroupStateUnreadable: () => false,
      labelAgeMs: () => QUEUED_CONFLICT_GRACE_MS + 1,
      computeConflictDisposition: () => null, computeConflictingPaths: () => null,
      listPrFiles: () => [{ path: 'scripts/x.mjs' }], listPrComments: () => [],
      readPrLive: () => ({ headRefOid: newHead, mergeable }),
      postFinding: () => { bounces++; }, postStandDown: () => { bounces++; },
      provider: {}, log: () => {},
    });
    if (bounces || entries[0]?.error || !entries[0]?.routedTo?.includes('conflict-cleared-before-bounce'))
      violations.push(`two-head #7183 sequence bounced or failed (live mergeable: ${mergeable})`);
  }
  return { violations };
}
export default {
  id: 'conflict-watch-drain-rebase-stale-bounce',
  title: 'drain rebase invalidates the stale accepted-conflict bounce',
  card: '#7183',
  fixedBy: { sha: 'HEAD', where: 'conflict watch head guard', paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent() { return probe().violations.length === 0; },
  run() { return probe(); },
  judge: report => report.violations,
};
