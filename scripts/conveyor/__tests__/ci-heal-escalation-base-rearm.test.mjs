import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';

const HEAD = '6b8657f05' + '0'.repeat(31);
const BASE = 'ca4b3f6a4' + '0'.repeat(31);
const CREATED = '2026-10-11T16:34:56Z';

function plan({ outcome = 'needs-human', recordedBase = null, sha = BASE, committedAt } = {}) {
  return planReconcile({
    requiredChecks: ['gate'], agents: [], now: Date.parse('2026-10-11T17:00:00Z'),
    prs: [{
      number: 4792, state: 'OPEN', headRefName: 'lane/4792-stacked', headRefOid: HEAD,
      baseRefName: 'lane/takeover-budget', mergeStateStatus: 'CLEAN',
      labels: [{ name: 'review:pending' }, { name: 'checking' }],
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }],
      comments: [{ author: { login: 'web-everything' }, createdAt: CREATED,
        body: buildCiHealEscalationComment({ headSha: HEAD, outcome, basePr: 4779,
          baseHeadSha: recordedBase, reason: 'base test contradicts base rule' }) }],
      escalationBaseHead: { sha, committedAt },
    }],
  });
}

function expectRearmed(result) {
  expect(result.refusals.filter(r => r.kind === 'ci-heal-escalated')).toEqual([]);
  expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal', prNumber: 4792 }));
}

describe('#4792 stacked CI-heal re-arm and base ownership', () => {
  it('re-arms the live legacy escalation after the base commit advances', () => {
    expectRearmed(plan({ committedAt: '2026-10-11T16:44:54Z' }));
  });
  it('retains a legacy escalation and operator note when the base predates it', () => {
    const result = plan({ committedAt: '2026-10-11T16:24:54Z' });
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 4792 }));
    expect(result.notes).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 4792 }));
  });
  it('routes inherited red to the base fixer without an operator note', () => {
    const result = plan({ outcome: 'inherited-from-base', recordedBase: BASE });
    expect(result.refusals).toContainEqual(expect.objectContaining({
      kind: 'ci-heal-escalated', basePr: '4779', baseHeadSha: BASE,
      why: expect.stringContaining("owed to the base PR's fixer, not the operator"),
    }));
    expect(result.notes.filter(r => r.kind === 'ci-heal-escalated')).toEqual([]);
  });
  it('re-arms inherited red when the recorded base differs', () => {
    expectRearmed(plan({ outcome: 'inherited-from-base', recordedBase: 'a'.repeat(40) }));
  });
});
