/** A 100-AI prefix must never hide the human commit on the next page. No host or network IO. */
import { meteredPrCommits } from '../../../lib/gh-metered-reads.mjs';
import { isAiGeneratedPr } from '../../../lib/ai-pr-authorship.mjs';

export const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
export const commits = Array.from({ length: 101 }, (_, i) => ({ oid: (i + 1).toString(16).padStart(40, '0'),
  messageHeadline: `Implement ${i + 1}`, messageBody: '', authors: [{
    name: i === 100 ? 'Human' : 'Claude', email: i === 100 ? 'human@example.test' : 'noreply@anthropic.com',
  }] }));
export function fakeGh(args) {
  if (args[0] !== 'api' || args[1] !== 'graphql') throw new Error('unexpected fake-gh call');
  return JSON.stringify([commits.slice(0, 100), commits.slice(100)].map((rows, i) => ({
    data: { repository: { pullRequest: { headRefOid: HEAD, baseRefOid: BASE, commits: {
      totalCount: 101, pageInfo: { hasNextPage: i === 0, endCursor: `page-${i + 1}` },
      nodes: rows.map(c => ({ commit: { ...c, authors: { nodes: c.authors } } })),
    } } } },
  })));
}
export default {
  id: 'drain-authorship-truncated-at-100', title: 'paged authorship sees the human beyond 100 AI commits', card: '3007',
  fixedBy: { sha: 'PR-HEAD-CHAIN-RECORD-S11', where: 'lane/pr-head-chain-record-s11',
    paths: ['scripts/merge-ai-prs.mjs', 'scripts/lib/gh-metered-reads.mjs'] },
  fixPresent: () => true,
  async run({ exec = fakeGh, log = console.log } = {}) {
    const evidence = meteredPrCommits('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE });
    const report = { unpagedAi: isAiGeneratedPr({ commits: commits.slice(0, 100) }),
      complete: evidence.complete === true, count: evidence.commits?.length ?? 0,
      pagedAi: isAiGeneratedPr({ commits: evidence.commits }), reason: evidence.reason ?? null };
    log(`drain-authorship-truncated-at-100: ${JSON.stringify(report)}`);
    return report;
  },
  judge(report) {
    return report.unpagedAi && report.complete && report.count === 101 && !report.pagedAi ? []
      : ['incomplete authorship evidence or human commit beyond 100 not observed'];
  },
};
