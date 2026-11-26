/** Planning overruns must not starve no-code rearm behind recurring promotions. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';

export default {
  id: 'no-code-rearm-deadline-starve',
  title: 'no-code rearm progresses within two admitted passes despite planning overruns and recurring promotions',
  card: 'NOCODE-REARM-DEADLINE-STARVE',
  fixedBy: { sha: 'HEAD', where: 'lane/nocode-rearm-deadline-m1', paths: ['scripts/operations/promote-draft-pr-dispatch.mjs'] },
  fixPresent(root) {
    return readFileSync(resolve(root, 'scripts/operations/promote-draft-pr-dispatch.mjs'), 'utf8').includes('rearmAttempted');
  },
  async run() {
    const head = 'a'.repeat(40), attempts = [], receipts = [], dispatched = [], violations = [];
    const c = (id, body) => ({ id, body, author: { login: 'chalbert' } });
    const comments = [c('verdict', `🔁 review — changes requested\n\nFix defect`),
      c('begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${head}\``),
      c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head })),
      c('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', reason: 'No code owed', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true }))];
    let time = 0, cursor, rearmCursor;
    for (let pass = 0; pass < 2; pass++) {
      time = 0;
      const result = runReconcilePromoteDraftDispatch({ root: process.cwd(), cursor, rearmCursor, deadlineAt: 10, now: () => time,
        checkStaleness: () => ({ fresh: true }), provider: {},
        reconcile: () => { time = 11; return { dispatch: [1, 2].map(prNumber => ({ kind: 'promote-draft', prNumber, headRefOid: head }))
          .concat([43, 42].map(prNumber => ({ kind: 'rearm-no-code', prNumber, expectHead: head, answerId: 'answer' }))), refusals: [] }; },
        readHeadCheckState: () => ({ state: 'pending' }),
        acquireRearmLock: ({ prNumber }) => { attempts.push(prNumber); if (prNumber === 42) throw Error('fixture lock busy'); return () => {}; },
        readThread: () => [...comments, ...receipts], readPrLabels: () => ['review:changes'], readClaim: () => null,
        postComment: ({ comment }) => receipts.push(c('receipt', comment)),
        rearm: () => ({ status: 0, stdout: JSON.stringify({ ok: true, labelsObserved: true, labels: ['review:pending'] }) }),
      });
      dispatched.push(...result.dispatched);
      cursor = result.nextCursor; rearmCursor = result.nextRearmCursor;
    }
    for (const pr of [42, 43]) if (!attempts.includes(pr)) violations.push(`PR #${pr} had no attempt within two admitted passes`);
    if (!dispatched.some(d => d.pr === 43)) violations.push('eligible PR #43 did not dispatch');
    return { violations, attempts, receipts: receipts.length, dispatched };
  },
  judge: report => report.violations,
};
