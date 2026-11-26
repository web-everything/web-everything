/** PR #7514: a consumed no-code ruling must not suppress a later genuine changes verdict. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planReconcile } from '../../reconcile-core.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer, NO_CODE_REARM_RECEIPT } from '../../stand-down-answer-core.mjs';
import { REARM_COMMENT_MARKER } from '../../rearm-review.mjs';
import { runStandDownAnswer } from '../../stand-down-answer.mjs';

export default {
  id: 'no-code-rearm-later-changes',
  title: 'a no-code rearm ruling stalled subsequent changes verdicts and pushes (PR #7514)',
  card: 'PR #7514',
  fixedBy: { sha: 'HEAD', where: 'lane/standdown-d2-v2', paths: ['scripts/conveyor/stand-down-answer-core.mjs'] },
  fixPresent(root) {
    return readFileSync(resolve(root, 'scripts/conveyor/stand-down-answer-core.mjs'), 'utf8').includes('ruling superseded by a later fix claim or changes verdict');
  },
  async run() {
    const head = 'a'.repeat(40);
    const c = (id, body) => ({ id, body, author: { login: 'chalbert' } });
    const verdict = c('verdict', `🔁 review — changes requested\n\nFix defect\n<!-- reviewed-sha: ${head} -->`);
    const comments = [verdict, c('begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${head}\``),
      c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head })),
      c('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', channel: 'chat', reason: 'No code owed', disposition: 'rearm-review', noCodeOwed: true }))];
    const plan = (labels, liveHead = head) => planReconcile({ agents: [], requiredChecks: ['gate'], prs: [{
      number: 42, state: 'OPEN', headRefName: 'lane/test', headRefOid: liveHead, labels,
      mergeStateStatus: 'CLEAN', comments,
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
    }] });
    const kinds = result => result.dispatch.map(d => d.kind);
    const violations = [];
    if (JSON.stringify(kinds(plan(['review:changes']))) !== JSON.stringify(['rearm-no-code'])) violations.push('initial ruling did not plan one mechanical rearm');
    for (const label of ['red-team:blocked', 'red-team:pending']) {
      const result = plan(['review:changes', label], 'b'.repeat(40));
      if (JSON.stringify(kinds(result)) !== JSON.stringify(['fix'])) violations.push(`${label}: changed head did not resume ordinary fix planning`);
      if (result.refusals.some(r => r.kind.startsWith('no-code-rearm'))) violations.push(`${label}: obsolete ruling still holds changed head`);
    }
    comments.push(c('receipt', NO_CODE_REARM_RECEIPT('answer', head)), c('rearmed', REARM_COMMENT_MARKER));
    if (kinds(plan(['review:pending'])).includes('fix')) violations.push('rearmed pending review dispatched a fixer');
    comments.push({ ...verdict, id: 'new-verdict' });
    for (const label of ['red-team:blocked', 'red-team:pending']) {
      const result = plan(['review:changes', label]);
      if (JSON.stringify(kinds(result)) !== JSON.stringify(['fix'])) violations.push(`${label}: later verdict did not resume ordinary fix planning`);
      if (result.refusals.some(r => r.kind.startsWith('no-code-rearm'))) violations.push(`${label}: obsolete ruling still holds later verdict`);
    }
    if (JSON.stringify(kinds(plan(['review:changes']))) !== JSON.stringify(['fix'])) violations.push('later changes verdict did not resume ordinary fix planning');
    if (JSON.stringify(kinds(plan(['review:changes'], 'b'.repeat(40)))) !== JSON.stringify(['fix'])) violations.push('changed head did not resume ordinary fix planning');
    const headless = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Legacy question' }));
    const legacyThread = [verdict, comments[1], headless];
    let posts = 0, refusal = null;
    try {
      runStandDownAnswer(['42', '--repo=no-code-rearm-fixture/example', '--reason=No code owed',
        '--actor=chalbert', '--channel=chat', '--disposition=rearm-review', '--no-code-owed'], {
        gh: args => {
          if (args[1] === 'view') return JSON.stringify({ comments: legacyThread, headRefOid: head,
            labels: [{ name: 'review:changes' }] });
          posts++;
          return '';
        },
      });
    } catch (error) { refusal = error.message; }
    if (posts !== 0 || !refusal?.includes('stand-down has no head')) violations.push('headless ceremony did not refuse before posting');
    const legacyAnswer = comments[3];
    for (const [cause, later, liveHead] of [
      ['push', [], 'b'.repeat(40)], ['verdict', [verdict], head], ['claim', [comments[1]], head],
    ]) {
      comments.splice(0, comments.length, ...legacyThread, legacyAnswer, ...later);
      for (const label of ['red-team:blocked', 'red-team:pending']) {
        const result = plan(['review:changes', label], liveHead);
        if (JSON.stringify(kinds(result)) !== JSON.stringify(['fix'])) violations.push(`headless ${cause}/${label}: ordinary fix did not resume`);
        if (result.dispatch.some(d => d.operatorAnswer)) violations.push(`headless ${cause}/${label}: old ruling leaked into fixer payload`);
        if (result.refusals.some(r => r.kind.startsWith('no-code-rearm'))) violations.push(`headless ${cause}/${label}: obsolete ruling still holds`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
