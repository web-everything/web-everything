/** PR #3850 (2026-10-04): an operator "Close as superseded" answer was handed to a fix agent as free text. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'operator-supersede-answer-sent-to-fixer',
  title: 'PR #3850: the operator answered "Close as superseded"; the conveyor dispatched a fixer, which tried to delete the card files and ended blocked-on-infra',
  card: 'conveyor gap A follow-up — structured stand-down disposition (PR #3850)',
  fixedBy: { sha: '4a7d895ee', where: 'lane/dispatch-trust-parent', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/stand-down-answer-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes("kind: 'close-superseded'"); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { buildOperatorAnswer } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer-core.mjs')).href);
    const standDown = { id: 'IC_kwDORBt1-c8AAAABZHz0hw', author: { login: 'web-everything' },
      body: '🛑 conveyor fix — stood down, human judgment needed\n\nconveyor fix agent stopped rather than guessing.' };
    const answer = { id: 'IC_kwDORBt1-c8AAAABZJJA3w', author: { login: 'chalbert' },
      body: buildOperatorAnswer({ standDownId: standDown.id, reason: 'Close as superseded: the org move already happened', actor: 'chalbert', channel: 'claude-code-chat' }) };
    const pr = { number: 3850, state: 'OPEN', isDraft: false, headRefName: 'lane/prepare-org-move-xvgqv8h', headRefOid: '1e9fa9be3',
      labels: [{ name: 'review:changes' }], comments: [standDown, answer], commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN' };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:40:00Z') });
    const kinds = plan.dispatch.filter((d) => d.prNumber === 3850).map((d) => d.kind);
    const violations = kinds.includes('close-superseded') && !kinds.includes('fix') ? []
      : [`PR #3850 planned ${JSON.stringify(kinds)} — a supersede ruling must close mechanically, never dispatch a fixer`];
    return { violations };
  },
  judge(report) { return report.violations; },
};
