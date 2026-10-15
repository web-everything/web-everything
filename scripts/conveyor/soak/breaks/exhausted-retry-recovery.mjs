/** PR #5331 review: replay exhausted recovery across red main, green main, and failed retries. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepCiRedRecovery, sweepExhaustedRetry } from '../../ci-red-recovery-watch.mjs';
import { CI_HEAL_COMMENT_MARKER } from '../../ci-heal-mark.mjs';
import { resolveExhaustedRetry, countExhaustedRetries } from '../../exhausted-retry.mjs';
import { standDownComments, buildStandDownComment } from '../../stand-down.mjs';

export default {
  id: 'exhausted-retry-recovery',
  title: 'exhausted main-red PR waits for recovery, while a conflicting own-failure retry hands off once',
  card: 'PR #5331 review; live PR #5195',
  fixedBy: { sha: 'pending', where: 'lane/exhausted-retry', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs', 'scripts/conveyor/exhausted-retry.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8').includes('existingMainRecoveryOwns');
  },
  run() {
    const violations = [];
    const at = '2026-10-14T01:00:00Z';
    const head = 'a'.repeat(40);
    const main = 'b'.repeat(40);
    const trusted = body => ({ body, createdAt: at, author: { login: 'web-everything' } });
    const settings = resolveExhaustedRetry({ env: {}, platform: {}, file: {} });
    const redRun = { status: 'completed', conclusion: 'failure', updatedAt: '2026-10-14T02:00:00Z', checkConclusions: { 'daemon-soak': 'failure' } };
    const greenRun = { ...redRun, conclusion: 'success', updatedAt: '2026-10-14T03:00:00Z', checkConclusions: { 'daemon-soak': 'success' } };
    for (const inherited of [true, false]) {
      const comments = Array.from({ length: 3 }, () => trusted(CI_HEAL_COMMENT_MARKER));
      let attempts = 0;
      const refresh = () => { attempts++; return { ok: false, error: 'rebase conflict' }; };
      const readComments = () => comments;
      const checks = [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE',
        completedAt: inherited ? '2026-10-14T02:30:00Z' : at }];
      const reads = { readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: head, statusCheckRollup: checks }],
        readAheadBy: () => 2, readAttributedRequiredChecks: () => ['daemon-soak'], readComments,
        readMainLatestCheckRuns: () => [], readMainFixedSignatureFacts: () => null, readMainGreenFixFacts: () => ({}),
        readMainFailureSignature: () => null, readPriority: () => null, ciHealCap: 3 };
      // A watcher restart retains only the durable thread; repeated sweeps share no process bookkeeping.
      for (let tick = 0; tick < 4; tick++) {
        const mainRuns = tick < 2 ? [redRun] : [redRun, greenRun];
        const recovery = sweepCiRedRecovery({ ...reads, exhaustedRetrySettings: settings, readMainRuns: () => mainRuns });
        if (inherited && tick < 2 && recovery.refusals[0]?.kind !== 'main-still-red') violations.push(`tick ${tick}: exhausted PR lost main-red wait`);
        if (inherited && tick >= 2 && recovery.dispatch[0]?.kind !== 'rebase-onto-main') violations.push(`tick ${tick}: recovered main did not restore existing rebase path`);
        sweepExhaustedRetry({ ...reads, apply: true, settings, candidates: recovery.candidates, mainRuns,
          now: Date.parse(at) + 24 * 3600000, readMainTip: () => ({ sha: main, committedAt: greenRun.updatedAt }),
          refresh, checkClaim: () => null, postComment: (n, { body }) => comments.push(trusted(body)) });
      }
      if (inherited && attempts !== 0) violations.push(`inherited main red consumed ${attempts} exhausted retry attempt(s)`);
      if (!inherited && (attempts !== 1 || countExhaustedRetries(comments) !== 1 || standDownComments(comments).length !== 1)) {
        violations.push(`conflict loop: ${attempts} attempts, ${countExhaustedRetries(comments)} durable retries, ${standDownComments(comments).length} handoffs`);
      }
    }
    // A mechanical retry continues the hold; an unrelated manual head must not inherit it.
    const comments = [trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head }))];
    let currentHead = head;
    const retryHead = 'c'.repeat(40);
    let attempts = 0;
    const options = { apply: true, settings, ciHealCap: 3, mainRuns: [],
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: currentHead,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }] }],
      readAttributedRequiredChecks: () => ['daemon-soak'], readAheadBy: () => 2, readComments: () => comments,
      readMainTip: () => ({ sha: main, committedAt: greenRun.updatedAt }), readMainFailureSignature: () => null,
      refresh: () => { attempts++; currentHead = retryHead; return { ok: true, action: 'rebased', newCommit: retryHead }; },
      checkClaim: () => null, reconcileAcceptance: () => ({}),
      postComment: (n, { body }) => comments.push(trusted(body)) };
    sweepExhaustedRetry(options);
    if (attempts !== 1 || sweepExhaustedRetry(options).refusals[0]?.kind !== 'needs-you') violations.push('mechanical retry head lost the exhausted handoff');
    const beforeManualPush = comments.length;
    currentHead = 'd'.repeat(40);
    sweepExhaustedRetry(options);
    if (comments.length !== beforeManualPush) violations.push('manual head inherited a lapsed fix-loop stand-down');
    if (standDownComments(comments, { headRefOid: currentHead, lapseOnNewHead: 'on' }).length) violations.push('spent handoff still blocks the manual head');
    return { violations };
  },
  judge(report) { return report.violations; },
};
