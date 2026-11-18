/** PR #7095: a join timeout must never authorize a fixer from unknown check evidence. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PLANNER = 'scripts/conveyor/reconcile-core.mjs';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-16T12:30:00Z');

export default {
  id: 'reconcile-fix-evidence-provenance',
  title: 'joined fixer waits for complete current-head check evidence across the join cap',
  card: 'PR #7095 check-evidence contract PR2b',
  fixedBy: { sha: 'HEAD', where: 'lane/check-evidence-contract-pr2b', paths: [PLANNER] },
  fixPresent(root) {
    try { return readFileSync(join(root, PLANNER), 'utf8').includes('function reviewTimingEvidence('); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, PLANNER)).href);
    const { REVIEW_PR_CHANNEL } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-escalation.mjs')).href);
    const finding = {
      author: { login: 'web-everything' }, createdAt: new Date(NOW - 60_000).toISOString(),
      body: `🔁 review — changes requested\n\nRecorded by juror via ${REVIEW_PR_CHANNEL}.\n\nRepair the unit failure.\n\n---\n\nNet basis: \`0000..${HEAD}\` — 1 net changed file(s) vs current main\n\n_Recorded through ${REVIEW_PR_CHANNEL}._`,
    };
    const pr = {
      number: 7, state: 'OPEN', headRefOid: HEAD, headRefName: 'lane/evidence-provenance',
      rowsHead: HEAD, rowsComplete: true, rosterSource: 'live',
      labels: [{ name: 'review:changes' }], comments: [finding],
      files: [{ path: 'scripts/example.mjs' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
        head_sha: HEAD, completedAt: new Date(NOW - 60_000).toISOString() }],
    };
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const plan = (patch, now) => planReconcile({
      prs: [{ ...pr, ...patch }], agents: [], durableCounts: {}, requiredChecks: ['test'], now,
      reviewTiming: { startAfter: 'ci-green', startEarly: 'off' },
      fixTiming: { joinCiAndReview: true, joinWaitMaxMin: 15 },
      shadowDeps: {},
    });
    const cases = [
      ['incomplete', { rowsComplete: false }, 'rows-incomplete'],
      ['unreadable', { requiredCheckReadError: 'offline' }, 'rows-incomplete'],
      ['foreign snapshot', { rowsHead: OTHER_HEAD }, 'foreign-head'],
      ['missing provenance', { rowsHead: undefined, rowsComplete: undefined, rosterSource: undefined }, 'roster-unavailable'],
      ['untrusted roster', { rosterSource: 'guessed' }, 'roster-unavailable'],
    ];
    for (const [name, patch, reason] of cases) {
      for (const elapsed of [0, 16 * 60_000, 60 * 60_000]) {
        const result = plan(patch, NOW + elapsed);
        check(result.dispatch.length === 0, `${name} at ${elapsed}: dispatched from unknown evidence`);
        check(result.refusals.some(row => row.kind === 'fix-join-wait'
          && row.evidenceReason?.includes(reason) && row.why?.includes(reason)),
        `${name} at ${elapsed}: missing visible evidence refusal`);
        log?.(`${name} at ${elapsed}: dispatches=${result.dispatch.length}\n`);
      }
      // A fresh read recovers on the same head; no durable wait may strand the repair.
      const recovered = plan({}, NOW + 61 * 60_000);
      check(recovered.dispatch.length === 1 && recovered.dispatch[0].kind === 'fix'
        && recovered.dispatch[0].joinedInputs?.head === HEAD
        && recovered.dispatch[0].joinedInputs?.ciFailures?.[0]?.name === 'test'
        && recovered.dispatch[0].joinedInputs?.reviewFindings?.[0] === finding.body,
      `${name}: complete current-head evidence did not release one fixer with both inputs`);
      check(!recovered.refusals.some(row => row.kind === 'fix-join-wait'), `${name}: wait survived evidence recovery`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
