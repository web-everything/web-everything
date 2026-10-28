/** PR #5925 / #5972: a held review gate must retain one safe owner on every planner tick. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'review-gate-only-red-ownership',
  title: 'review-gate-only red retains review, CI repair, or operator-ruling ownership',
  card: 'PR #5925 incident and PR #5972 review findings, 2026-10-26',
  fixedBy: { sha: 'HEAD', where: 'lane/review-gate-only-red', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/ci-heal-escalation-mark.mjs',
    'scripts/conveyor/ci-heal-verdict-recheck.mjs',
    'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('reviewFailures.required')
      && readFileSync(join(root, 'scripts/conveyor/ci-heal-verdict-recheck.mjs'), 'utf8').includes('notCiBreakCheckStates');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { notCiBreakRecordRefusal, buildCiHealEscalationComment } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/ci-heal-escalation-mark.mjs')).href);
    const { planVerdictVoid } = await import(pathToFileURL(join(sourceRoot, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
    const head = 'a'.repeat(40);
    const check = (name, conclusion = 'SUCCESS') => ({ name, status: 'COMPLETED', conclusion });
    const rollup = [check('standards'), check('test-shard (1)'), check('test'), check('smoke', 'CANCELLED'), check('review-gate', 'FAILURE')];
    const pull = { number: 5925, state: 'OPEN', isDraft: false, headRefName: 'lane/review-gate-only',
      headRefOid: head, mergeStateStatus: 'CLEAN', comments: [], labels: [{ name: 'review:human' }], statusCheckRollup: rollup };
    const blocked = [{ key: 'blocked', finding: { file: 'example.mjs' } }];
    const standDown = { author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: head, outcome: 'not-a-ci-break' }) };
    const variants = [
      { name: 'cancelled smoke', expected: 'review' },
      { name: 'optional red before and after stand-down', expected: 'review', recordAfterTick: true,
        over: { statusCheckRollup: rollup.map(row => row.name === 'smoke' ? check('smoke') : row)
          .concat(check('optional-ci', 'FAILURE')) } },
      { name: 'operator send-back before review', expected: 'fix', mode: 'operator-send-back',
        over: { comments: [{ id: 'op-send-back', createdAt: '2026-10-26T11:00:00Z', author: { login: 'chalbert' },
          body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nMUST FIX: rename the export.' }] } },
      { name: 'spent smoke retry keeps recorded verdict', refusal: 'ci-heal-escalated', checkVoid: true,
        over: { labels: [], comments: [standDown],
          timeoutRetry: { eligible: true, infraCancelled: true, head, pr: pull.number, cap: 6,
            jobs: [{ run: 10, job: 20, attempt: 1 }] },
          timeoutRetryBudget: { confirmed: 6, rejected: 0, pending: false } } },
      { name: 'later infra-cancelled smoke voids verdict and restores retry', expected: 'ci-timeout-rerun',
        checkVoid: true, expectVoid: true,
        over: { labels: [], comments: [standDown],
          timeoutRetry: { eligible: true, infraCancelled: true, head, pr: pull.number, cap: 6,
            jobs: [{ run: 10, job: 20, attempt: 1 }] },
          timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } } },
      { name: 'missing smoke on old base', expected: 'fix', mode: 'stale-base-rebase',
        reviewTiming: { startAfter: 'ci-green' },
        over: { baseRefName: 'main', statusCheckRollup: rollup.filter(row => row.name !== 'smoke') } },
      { name: 'required merge gate held only for review', expected: 'review', requiredChecks: ['test', 'smoke', 'merge-gate'],
        over: { statusCheckRollup: rollup.map(row => row.name === 'smoke' ? check('smoke') : row)
          .concat({ ...check('merge-gate', 'FAILURE'), mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } }) } },
      ...['review:changes', 'advisory:changes'].map(label => ({ name: label, expected: 'ci-heal',
        over: { labels: [...pull.labels, { name: label }] } })),
      { name: 'block ruling', expected: 'fix', over: { blockRuledReferrals: blocked } },
      { name: 'ignored ruling', expected: 'fix', over: { ignoredRulings: { head, misses: 1,
        matches: [{ finding: { file: 'example.mjs' }, ruling: 'block: repair', priorHead: 'b'.repeat(40), misses: 1 }] } } },
      { name: 'cancelled test without retry evidence', expected: 'ci-heal',
        over: { statusCheckRollup: rollup.map(row => row.name === 'test' ? check('test', 'CANCELLED') : row) } },
      ...['review:human', 'review:pending'].flatMap(label => ['test', 'smoke'].flatMap(cancelled =>
        [false, true].map(strict => ({ name: `${label} cancelled ${cancelled} strict=${strict}`,
          expected: cancelled === 'smoke' && !strict ? 'review' : 'ci-timeout-rerun',
          ...(strict ? { reviewTiming: { startAfter: 'ci-green' } } : {}),
          over: { labels: [{ name: label }], statusCheckRollup: rollup.map(row =>
            ['test', 'smoke'].includes(row.name) ? check(row.name, row.name === cancelled ? 'CANCELLED' : 'SUCCESS') : row),
          timeoutRetry: { eligible: true, infraCancelled: true, repo: 'review-gate-fixture/example',
            pr: pull.number, head, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] },
          timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } },
        })))),
      { name: 'required gate and optional red', refusal: 'review-ci', requiredChecks: ['test', 'smoke', 'review-gate'],
        over: { statusCheckRollup: rollup.map(row => row.name === 'smoke' ? check('smoke') : row).concat(check('optional-ci', 'FAILURE')) } },
    ];
    const violations = [];
    for (let tick = 0; tick < 3; tick++) {
      const silentReview = planReconcile({
        prs: [5924, 5925].map(number => ({ ...pull, number, baseRefName: 'main',
          statusCheckRollup: rollup.filter(row => row.name !== 'smoke') })),
        agents: [], requiredChecks: ['test', 'smoke'], reviewTiming: { startAfter: 'ci-green' },
        now: Date.parse('2026-10-26T12:00:00Z') + tick * 60000,
        dispatchReviewRow: ({ pr, refuse, withPhase }) => {
          if (pr.number === 5924) refuse('review-ci', { ...withPhase,
            ci: { affected: [{ name: 'smoke', reason: 'missing' }] } });
          // The next PR has a silent decision, so it must not inherit this refusal.
        },
      });
      if (silentReview.dispatch.length !== 1 || silentReview.dispatch[0].prNumber !== 5924
          || silentReview.dispatch[0].mode !== 'stale-base-rebase') {
        violations.push(`tick ${tick}: silent review inherited another PR's stale-base repair`);
      }
      log?.(`tick ${tick} silent review: ${silentReview.dispatch.map(row => `${row.prNumber}:${row.mode}`).join(',')}`);
      for (const variant of variants) {
        const pr = { ...pull, ...variant.over };
        if (variant.recordAfterTick && tick > 0) pr.comments = [standDown];
        const requiredChecks = variant.requiredChecks ?? ['test', 'smoke'];
        if (variant.checkVoid) {
          const voidRow = planVerdictVoid({ note: { kind: 'ci-heal-escalated', outcome: 'not-a-ci-break',
            headSha: head, prNumber: pull.number }, pr, repo: 'review-gate-fixture/example',
            verdictSettings: { recheckNotCiBreak: true }, readRequiredChecks: () => requiredChecks });
          if (Boolean(voidRow) !== Boolean(variant.expectVoid)) {
            violations.push(`tick ${tick} ${variant.name}: expected void=${Boolean(variant.expectVoid)}, got ${Boolean(voidRow)}`);
          }
          if (voidRow) {
            pr.comments = [...pr.comments, { author: { login: 'web-everything' }, body: voidRow.body }];
          }
        }
        // Exercise the recording guard before the planner: accepting this stand-down would suppress the retry.
        if (variant.reviewTiming && pr.timeoutRetry?.infraCancelled
            && pr.statusCheckRollup.some(row => row.name === 'smoke' && row.conclusion === 'CANCELLED')
            && !notCiBreakRecordRefusal({ headSha: head, pr, requiredChecks })) {
          violations.push(`tick ${tick} ${variant.name}: retry-eligible smoke accepted as not-a-ci-break`);
        }
        const plan = planReconcile({ prs: [pr], agents: [], requiredChecks,
          ...(variant.reviewTiming ? { reviewTiming: variant.reviewTiming } : {}),
          now: Date.parse('2026-10-26T12:00:00Z') + tick * 60000 });
        const kinds = plan.dispatch.map(row => row.kind);
        if (variant.recordAfterTick && (!plan.dispatch[0]?.nonRequiredRed?.includes('optional-ci')
            || !plan.dispatch[0]?.why?.includes('optional-ci'))) {
          violations.push(`tick ${tick} ${variant.name}: optional failure was not reported`);
        }
        const safe = variant.expected ? kinds.length === 1 && kinds[0] === variant.expected
          && (!variant.mode || plan.dispatch[0].mode === variant.mode)
          : kinds.length === 0 && plan.refusals.some(row => row.kind === variant.refusal);
        log?.(`tick ${tick} ${variant.name}: ${kinds.join(',') || plan.refusals.map(row => row.kind).join(',')}`);
        if (!safe) violations.push(`tick ${tick} ${variant.name}: expected ${variant.expected ?? variant.refusal}, got ${kinds.join(',') || plan.refusals.map(row => row.kind).join(',')}`);
      }
    }
    const cancelledTest = { ...pull, statusCheckRollup: [check('test', 'CANCELLED'), check('smoke')] };
    if (!notCiBreakRecordRefusal({ headSha: head, pr: cancelledTest, requiredChecks: ['test', 'smoke'] })) {
      violations.push('cancelled required test accepted as not-a-ci-break');
    }
    return { violations };
  },
  judge: report => report.violations,
};
