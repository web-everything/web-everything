/** PR #3918 review round 1: the supersede disposition re-closed a reopened PR every tick, and read loose prose as a close ruling. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'operator-supersede-reclosed-or-misread',
  title: 'PR #3918: a reopened PR with a standing "Close as superseded" answer was re-planned for close every tick, and prose like "Supersedes the earlier ruling - keep the PR" was inferred as a close ruling',
  card: 'conveyor gap A follow-up — structured stand-down disposition (PR #3918 review round 1)',
  fixedBy: { sha: 'dfbc7e421', where: 'lane/dispatch-trust-parent', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/stand-down-answer-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/stand-down-answer-core.mjs'), 'utf8').includes('export function isCloseSupersededExecuted'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const core = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer-core.mjs')).href);
    const violations = [];
    const standDown = { id: 'IC_stand', author: { login: 'web-everything' },
      body: '🛑 conveyor fix — stood down, human judgment needed\n\nconveyor fix agent stopped rather than guessing.' };
    const answer = { id: 'IC_ans', author: { login: 'chalbert' },
      body: core.buildOperatorAnswer({ standDownId: standDown.id, reason: 'Close as superseded: done', actor: 'chalbert', channel: 'chat' }) };
    // the conveyor already closed it (its own marker comment) and a human reopened the PR
    const closed = { id: 'IC_closed', author: { login: 'web-everything' }, body: '<!-- conveyor-close-superseded:v1 -->\n## Closed as superseded — operator disposition' };
    const pr = { number: 3850, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: 'abc1234',
      labels: [{ name: 'review:changes' }], comments: [standDown, answer, closed], commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN' };
    const kinds = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:40:00Z') })
      .dispatch.filter((d) => d.prNumber === 3850).map((d) => d.kind);
    if (kinds.includes('close-superseded')) violations.push(`reopened PR re-planned close-superseded after the close comment: ${JSON.stringify(kinds)}`);
    for (const reason of ['Supersedes the earlier ruling — keep the PR, just fix the failing test', 'Close issue #123 as superseded; continue this repair']) {
      if (core.answerDisposition({ reason })) violations.push(`prose inferred as a close ruling: ${reason}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
