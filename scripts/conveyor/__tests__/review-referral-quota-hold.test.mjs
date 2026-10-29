import { describe, expect, it } from 'vitest';
import { reviewRunEvidence, decideSameHeadHold } from '../review-referral-hold.mjs';

const repo = 'example/repo';
const head = 'a'.repeat(40);
const at = Date.parse('2026-10-29T08:00:00Z');
const iso = n => new Date(n).toISOString();
const quotaError = "judge-spawn: the juror failed: You've hit your weekly limit · resets ...";
const genuineError = 'judge-spawn: the juror failed: schema invalid';
const pr = { number: 7, headRefOid: head, labels: [{ name: 'review:pending' }], comments: [],
  createdAt: iso(at - 24 * 3_600_000) };
const options = { repo, env: {}, now: at + 30 * 60_000 };

// Failure location follows review-pr-io.test.mjs's persisted mandatory-referral records:
// findings.mandatoryReferrals.effects[].result.records[].failure (not telemetry.failure).
function failedRun(failures, index = 0, { complete = false } = {}) {
  const time = at + index * 1_000;
  return { id: `review-${index}`, op: 'review-pr',
    findings: {
      read: { repo, pr: 7, netBasis: { rev: head } },
      mandatoryReferrals: { applied: true, effects: [{ type: 'review.mandatory-referrals', status: 'applied',
        result: { records: failures.map((failure, i) => ({ repo, pr: 7, head, runId: `review-${index}`,
          attempted: true, referrals: [{ key: `finding-${i}` }], rulings: [],
          ...(failure === null ? {} : { failure }) })) } }] },
    },
    stepTimings: [{ step: 'read', startedAt: iso(time), finishedAt: iso(time + 1) },
      ...(complete ? [{ step: 'advise', startedAt: iso(time + 2), finishedAt: iso(time + 3) }] : [])],
  };
}
const evidence = (failures, index, opts) => reviewRunEvidence(failedRun(failures, index, opts));
const history = (failures, count = 13) => Array.from({ length: count }, (_, i) => evidence(failures, i));

describe('quota-only review run evidence', () => {
  it.each([false, true])('marks every recorded failure as quota-only (completed: %s)', complete => {
    const row = evidence([quotaError, 'HTTP 429', null], 0, { complete });
    expect(row).toMatchObject({ quotaOnly: true });
    expect(Boolean(row.incomplete)).toBe(!complete);
  });

  it.each([
    ['genuine failure', [genuineError]],
    ['mixed failures', [quotaError, genuineError]],
    ['no result text', ['judge-spawn: the juror failed with no result text']],
    ['no recorded failures', [null]],
    ['no records', []],
  ])('does not exempt %s', (_, failures) => {
    expect(evidence(failures).quotaOnly).not.toBe(true);
  });
});

describe('same-head quota attempt accounting', () => {
  it('13 quota-only incomplete runs never create a hold', () => {
    expect(decideSameHeadHold(pr, history([quotaError]), options)).toBeNull();
  });

  it('13 genuine incomplete failures still exhaust the no-verdict cap', () => {
    expect(decideSameHeadHold(pr, history([genuineError]), options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
  });

  it('quota-only runs plus two genuine attempts remain below the cap', () => {
    const rows = [...history([quotaError]), evidence([genuineError], 13), evidence([quotaError, genuineError], 14)];
    expect(decideSameHeadHold(pr, rows, options)).toBeNull();
  });

  it('mixed-failure runs count, but quota-only runs do not count as attempts or last', () => {
    const genuine = history([quotaError, genuineError], 3);
    const expected = decideSameHeadHold(pr, genuine, options);
    expect(expected).toMatchObject({ count: 3, attemptsSinceWake: 3, retryAt: at + 2_000 + 3_600_000 });
    // These newer failures must not extend the cooldown or spend any release budget.
    const quotaOnly = Array.from({ length: 13 }, (_, i) => evidence([quotaError], i + 3));
    expect(decideSameHeadHold(pr, [...genuine, ...quotaOnly], options)).toEqual(expected);
  });

  it('a newer quota-only incomplete run cannot replace the last completed genuine review', () => {
    const acceptedPr = { ...pr, labels: [{ name: 'review:accept' }] };
    const genuine = evidence([genuineError], 0, { complete: true });
    const expected = decideSameHeadHold(acceptedPr, [genuine], options);
    expect(expected).toMatchObject({ kind: 'same-head', count: 1, attemptsSinceWake: 1 });
    expect(decideSameHeadHold(acceptedPr, [genuine, evidence([quotaError], 1)], options)).toEqual(expected);
  });
});
