import { it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { planFixesFromReconcile, withPlannedContext } from '../reconcile-fix-dispatch.mjs';
import { REVIEW_PR_CHANNEL } from '../../lib/review-escalation.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
const head = 'a'.repeat(40);
const now = Date.parse('2026-10-16T12:30:00Z');
const labels = (...names) => names.map(name => ({ name }));
const check = (name, conclusion = 'SUCCESS') => ({ name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
  head_sha: head, completedAt: new Date(now - 60_000).toISOString() });
const finding = { author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(), body:
  `🔁 review — changes requested\n\nRecorded by juror via ${REVIEW_PR_CHANNEL}.\n\nRepair the unit failure.\n\n---\n\nNet basis: \`0000..${head}\` — 1 net changed file(s) vs current main\n\n_Recorded through ${REVIEW_PR_CHANNEL}._` };
const pr = (over = {}) => ({ number: 7, state: 'OPEN', headRefOid: head, headRefName: 'lane/xabc-test',
  labels: labels('review:pending'), comments: [], files: [{ path: 'scripts/example.mjs' }], statusCheckRollup: [check('standards'), check('test-shard (1)'), check('test', null)], ...over });
const plan = (row, extra = {}) => planReconcile({ prs: [row], requiredChecks: ['test'], now, ...extra });
it('the production planner releases fast-check review while aggregate CI is pending', () => {
  const row = pr();
  expect(plan(row).dispatch.map(d => d.kind)).toContain('review');
  expect(plan(row, { reviewTiming: { startAfter: 'ci-green' } }).dispatch).toEqual([]);
});
it('joins red CI and current review findings into exactly one existing fixer with both inputs', () => {
  const row = pr({ labels: labels('review:changes'), comments: [finding], statusCheckRollup: [check('test', 'FAILURE')] });
  const result = plan(row);
  expect(result.dispatch).toHaveLength(1);
  expect(plan(row, { durableCounts: { 7: 4 } }).dispatch[0].attempts).toBe(4);
  expect(result.dispatch[0]).toMatchObject({ kind: 'fix', joinedInputs: { head, ciFailures: [{ name: 'test' }], reviewFindings: [finding.body] } });
  const { planned } = planFixesFromReconcile(result.dispatch, () => null, () => [], () => [], 'we', () => ['scripts/example.mjs']);
  expect(planned).toHaveLength(1);
  expect(withPlannedContext('fix brief', planned[0])).toContain('Repair the unit failure.');
  expect(withPlannedContext('fix brief', planned[0])).toContain('"ciFailures"');
});
it('waits for pending CI after findings, but never resets the cap when polled', () => {
  const row = pr({ labels: labels('review:changes'), comments: [finding] });
  expect(plan(row).dispatch).toEqual([]);
  expect(plan(row).refusals).toContainEqual(expect.objectContaining({ kind: 'fix-join-wait' }));
  expect(plan(row, { now: now + 15 * 60_000 }).dispatch.map(d => d.kind)).toEqual(['fix']);
});
it('does not join findings on a different reviewed head', () => {
  const row = pr({ labels: labels('review:pending'), comments: [{ ...finding, body: finding.body.replaceAll(head, 'b'.repeat(40)) }], statusCheckRollup: [check('test', 'FAILURE')] });
  expect(plan(row).dispatch[0]).toMatchObject({ kind: 'ci-heal' });
  expect(plan(row).dispatch[0].joinedInputs).toBeUndefined();
});
it('heals red CI immediately when review is refused and no reviewer is live', () => {
  const result = plan(pr({ statusCheckRollup: [check('test', 'FAILURE')] }));
  expect(result.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  expect(result.refusals.some(r => r.kind === 'fix-join-wait')).toBe(false);
});
it('caps waiting even when a reviewer is still live, while retaining fixer liveness protection', () => {
  const row = pr({ statusCheckRollup: [check('test', 'FAILURE')] });
  const reviewer = { name: 'review-7', pid: 123, pidAlive: true, state: 'working' };
  expect(plan(row, { agents: [reviewer] }).dispatch).toEqual([]);
  expect(plan(row, { agents: [reviewer], now: now + 15 * 60_000 }).dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  expect(plan(row, { agents: [{ ...reviewer, name: 'fix-7' }], now: now + 15 * 60_000 }).dispatch).toEqual([]);
});
it('joining cannot bypass the review-fix round cap', () => {
  const row = pr({ labels: labels('review:changes'), comments: [finding], statusCheckRollup: [check('test', 'FAILURE')] });
  const result = plan(row, { durableCounts: { 7: 5 }, roundCap: 5 });
  expect(result.dispatch.filter(d => ['fix', 'ci-heal'].includes(d.kind))).toEqual([]);
  expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', capKind: 'fix' }));
});
it('a later accept on the head closes the earlier finding episode', () => {
  const accepted = { ...finding, body: `<!-- reviewed-sha: ${head} -->` };
  const row = pr({ comments: [finding, accepted], statusCheckRollup: [check('test', 'FAILURE')] });
  const result = plan(row, { now: now + 15 * 60_000 });
  expect(result.dispatch[0]).toMatchObject({ kind: 'ci-heal' });
  expect(result.dispatch[0].joinedInputs).toBeUndefined();
});
it('an optional red check never releases a live reviewer, so no duplicate review is dispatched', () => {
  const reviewer = { name: 'review-7', pid: 123, pidAlive: true, state: 'working' };
  const row = pr({ statusCheckRollup: [check('standards'), check('test-shard (1)'), check('test'), check('CodeQL', 'FAILURE')] });
  for (const at of [now, now + 15 * 60_000, now + 60 * 60_000]) {
    const result = plan(row, { agents: [reviewer], now: at });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'live-process', prNumber: 7 }));
  }
  expect(plan(row, { now: now + 15 * 60_000 }).dispatch.map(d => d.kind)).toEqual(['review']);
});
it('quoted advisory text inside a trusted current-head accept is never a review finding, so the CI heal is not held', () => {
  const quoted = buildVerdictComment({ to: 'accepted', actor: 'juror', headSha: head,
    body: 'Prior advisory, quoted for context:\n\n> **Advisory outcome:** `changes` — blocking findings on this head' });
  const accept = { author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(), body: quoted };
  const reviewer = { name: 'review-7', pid: 123, pidAlive: true, state: 'working' };
  const row = pr({ comments: [accept], statusCheckRollup: [check('test', 'FAILURE')] });
  const result = plan(row);
  expect(result.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  expect(result.dispatch[0].joinedInputs).toBeUndefined();
  // Even beside a live reviewer, no joined-fix wait is invented from the quote.
  expect(plan(row, { agents: [reviewer] }).refusals.some(r => r.kind === 'fix-join-wait' && r.why?.includes('review'))).toBe(false);
  // The structural, unquoted advisory outcome still counts.
  const advisory = { ...accept, body: `${ADVISORY_NOTE_MARKER} reason\n\n**Verdict:** ❌ changes — blocking findings\n\nbody\n\n**Advisory outcome:** \`changes\` — blocking findings on this head; \`advisory:changes\` is applied.\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.\n\nthe human ceremony` };
  expect(plan(pr({ comments: [advisory], statusCheckRollup: [check('test', 'FAILURE')] })).dispatch[0]).toMatchObject({ kind: 'fix', joinedInputs: { head } });
});
it('a reviewer set aside for a CI heal past the join cap releases only the heal, never a second review', () => {
  const reviewer = { name: 'review-7', pid: 123, pidAlive: true, state: 'working' };
  for (const [requiredChecks, rollup] of [[['test'], [check('standards'), check('test-shard (1)'), check('test', 'FAILURE')]],
    [null, [check('standards'), check('test-shard (1)'), check('CodeQL', 'FAILURE')]]]) {
    const result = planReconcile({ prs: [pr({ statusCheckRollup: rollup })], requiredChecks, now: now + 15 * 60_000, agents: [reviewer] });
    expect(result.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  }
});
