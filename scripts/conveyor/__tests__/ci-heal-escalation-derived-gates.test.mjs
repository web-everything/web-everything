import { describe, expect, it } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';

const HEAD = 'a'.repeat(40);
const check = (name, conclusion, extra = {}) => ({
  name, status: 'completed', conclusion, head_sha: HEAD, ...extra,
});
const plan = statusCheckRollup => planReconcile({
  prs: [{
    number: 7100, state: 'OPEN', headRefName: 'lane/derived-gates', headRefOid: HEAD,
    labels: [{ name: 'review:pending' }], mergeStateStatus: 'CLEAN', statusCheckRollup,
    comments: [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({
      headSha: HEAD, outcome: 'needs-human', reason: 'durable escalation from an earlier tick',
    }) }],
  }],
  agents: [], now: Date.parse('2026-11-19T12:00:00Z'),
  requiredChecks: statusCheckRollup.map(row => row.name), reviewTiming: { startAfter: 'ci-green' },
});

describe('ci-heal escalation review routing', () => {
  it('dispatches review for gate-only red, retaining the needs-human refusal and note', () => {
    const result = plan([
      check('test', 'success'), check('review-gate', 'failure'),
      check('merge-gate', 'failure'),
    ]);
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', derivedGateOnlyRed: true }));
    expect(result.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated' }));
    expect(result.notes).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', outcome: 'needs-human' }));
  });

  it('retains the escalation refusal without review when a real required check is red', () => {
    const result = plan([check('test', 'failure')]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated' }));
  });

  it('retains the escalation refusal without review for mixed real and derived reds', () => {
    const result = plan([check('test', 'failure'), check('review-gate', 'failure')]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated' }));
  });
});
