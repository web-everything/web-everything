/**
 * Live PR #5729: review:changes ranked above ci-red, so a bounced PR with a new real required
 * failure on its fixer head owed no ci-heal. Intentional gate holds must keep their review fix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REARM_COMMENT_MARKER } from '../../rearm-review.mjs';

const HEAD = '5729'.repeat(10);

export default {
  id: 'bounced-pr-real-red-no-ci-heal',
  title: 'PR #5729: a review:changes-bounced PR with a new real red required check owes no ci-heal',
  card: 'PR #5729 bounced fixer head with real required CI failure',
  fixedBy: { sha: 'd4f659cbc61688a24faeba03ac9693fa3fd5e134', where: 'main', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('const bouncedRealRed = isBouncedRealRed('); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const violations = [];
    const failed = name => ({ name, status: 'completed', conclusion: 'failure' });
    const pr = { number: 5729, state: 'OPEN', isDraft: false, headRefName: 'lane/fix-5729', headRefOid: HEAD,
      labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
      comments: [{ body: '🔁 human review — changes requested\n\nDerive the cap from the comment thread.' }] };
    const plan = names => planReconcile({
      prs: [{ ...pr, statusCheckRollup: names.map(failed) }], agents: [], durableCounts: {},
      now: Date.parse('2026-10-23T11:00:00Z'),
      requiredChecks: ['test-shard (2)', 'review-gate', 'merge-gate'],
      reviewTiming: { startAfter: 'ci-green' },
    });
    const realRed = plan(['test-shard (2)', 'review-gate', 'merge-gate']);
    if (realRed.dispatch.length !== 1 || !realRed.dispatch.some(row =>
      row.kind === 'ci-heal' && row.phase === 'bounced' && row.prNumber === pr.number && row.headRefOid === HEAD)) {
      violations.push('bounced PR with a real red required check owes no ci-heal for its fixer head');
    }
    const gateOnly = plan(['review-gate', 'merge-gate']);
    if (gateOnly.dispatch.length !== 1 || !gateOnly.dispatch.some(row =>
      row.kind === 'fix' && row.phase === 'bounced' && row.prNumber === pr.number)) {
      violations.push('gate-only holds no longer retain the bounced PR review-findings fix');
    }
    // PR #5836 send-back: ten re-arms at the effective cap still leave the operator's directed round unused.
    const round = () => ({ author: { login: 'web-everything' }, body: REARM_COMMENT_MARKER });
    const directedPr = { ...pr, headRefOid: 'a'.repeat(40), statusCheckRollup: [failed('gate')],
      comments: [...pr.comments, ...Array.from({ length: 8 }, round),
        { id: 'operator', author: { login: 'chalbert' }, createdAt: '2026-10-23T10:00:00Z',
          body: '🔁 review — changes requested\n\nRecorded by chalbert via chat.\n\nRepair at head aaaaaaa.' },
        round(), round()] };
    const directed = planReconcile({ prs: [directedPr], agents: [], requiredChecks: ['gate'], roundCap: 6,
      reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-10-23T11:00:00Z') });
    if (directed.dispatch.length !== 1 || !directed.dispatch.some(row => row.kind === 'fix'
        && row.operatorSendBackRound?.sendBackId === 'operator' && row.operatorSendBackRound.used === 0)) {
      violations.push('bounced real-red routing ignores the unused operator-directed repair round at the cap');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
