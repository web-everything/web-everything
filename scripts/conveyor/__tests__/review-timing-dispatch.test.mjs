import { it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { planFixesFromReconcile, withPlannedContext } from '../reconcile-fix-dispatch.mjs';
import { REVIEW_PR_CHANNEL } from '../../lib/review-escalation.mjs';
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
