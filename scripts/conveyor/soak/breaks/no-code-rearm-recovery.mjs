/** PR #7514: a receipted writer failure needs an explicit replacement, including abbreviated stand-down heads. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planReconcile } from '../../reconcile-core.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { runStandDownAnswer } from '../../stand-down-answer.mjs';
import { parseOperatorAnswer, parseNoCodeRearmReceipt } from '../../stand-down-answer-core.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';

export default {
  id: 'no-code-rearm-recovery',
  title: 'failed no-code rearm can be explicitly replaced once on the same full or abbreviated head (PR #7514)',
  card: 'PR #7514',
  fixedBy: { sha: 'HEAD', where: 'lane/standdown-d2-v2', paths: ['scripts/conveyor/stand-down-answer-core.mjs', 'scripts/conveyor/stand-down-answer.mjs'] },
  fixPresent(root) {
    return readFileSync(resolve(root, 'scripts/conveyor/stand-down-answer-core.mjs'), 'utf8').includes('function noCodeRearmWindowHonours');
  },
  async run() {
    const violations = [], cases = [];
    for (const length of [40, 9]) {
      const head = 'a'.repeat(40);
      const c = (id, body) => ({ id, body, author: { login: 'chalbert' } });
      const comments = [c('verdict', `🔁 review — changes requested\n\nFix defect\n<!-- reviewed-sha: ${head} -->`),
        c('begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${head}\``),
        c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head: head.slice(0, length) }))];
      let labels = ['review:changes'], answers = 0, receipts = 0, writes = 0, confirms = 0;
      const planned = [];
      const plan = () => {
        const result = planReconcile({ agents: [], requiredChecks: ['gate'], prs: [{ number: 42, state: 'OPEN',
          headRefName: 'lane/test', headRefOid: head, labels, comments, mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
        }] });
        planned.push(...result.dispatch.map(d => d.kind));
        return result;
      };
      const answer = () => runStandDownAnswer(['42', '--repo=web-everything/web-everything', '--reason=Inspected; no code owed',
        '--actor=chalbert', '--channel=chat', '--disposition=rearm-review', '--no-code-owed'], {
        gh: args => {
          if (args[1] === 'view') return JSON.stringify({ comments, headRefOid: head, labels: labels.map(name => ({ name })) });
          comments.push(c(`answer-${++answers}`, args.at(-1)));
          return '';
        },
      });
      const tick = () => {
        const out = runReconcilePromoteDraftDispatch({ root: process.cwd(), checkStaleness: () => ({ fresh: true }),
          provider: { ready() { throw Error('unexpected promotion'); } }, reconcile: plan,
          readPrLabels: () => labels, readThread: () => comments.slice(), readClaim: () => null,
          acquireRearmLock: () => () => {},
          postComment: ({ comment }) => { receipts++; comments.push(c(`receipt-${receipts}`, comment)); },
          rearm: () => {
            writes++;
            if (writes === 1) return { status: 1, stdout: JSON.stringify({ ok: false, reason: 'injected writer failure' }) };
            labels = ['review:pending'];
            return { status: 0, stdout: JSON.stringify({ ok: true, labelsObserved: true, labels }) };
          },
        });
        confirms += out.dispatched.filter(d => d.kind === 'rearm-no-code').length;
        return out;
      };
      try {
        answer();
        const failed = tick();
        if (!failed.refusals.some(r => r.kind === 'rearm-no-code-unconfirmed')) violations.push(`${length}: writer failure was not refused`);
        tick();
        if (writes !== 1 || receipts !== 1 || confirms !== 0) violations.push(`${length}: failed attempt retried automatically or confirmed`);
        answer();
        if (parseOperatorAnswer(comments.at(-1))?.supersedes !== 'answer-1') violations.push(`${length}: replacement did not name prior ruling`);
        tick();
        tick();
        if (writes !== 2 || receipts !== 2 || confirms !== 1) violations.push(`${length}: replacement was not executed exactly once`);
        const receiptAnswers = comments.map(parseNoCodeRearmReceipt).filter(Boolean).map(r => r.answerId);
        if (JSON.stringify(receiptAnswers) !== JSON.stringify(['answer-1', 'answer-2'])) violations.push(`${length}: receipts were not per answer`);
        if (planned.includes('fix')) violations.push(`${length}: no-code ruling dispatched a fixer`);
      } catch (e) { violations.push(`${length}: ${e.message}`); }
      cases.push({ length, answers, receipts, writes, confirms, planned });
    }
    return { violations, cases };
  },
  judge: report => report.violations,
};
