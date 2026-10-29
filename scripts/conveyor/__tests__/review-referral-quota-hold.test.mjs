import { describe, expect, it } from 'vitest';
import { reviewRunEvidence, decideSameHeadHold } from '../review-referral-hold.mjs';

const repo = 'example/repo';
const head = 'a'.repeat(40);
const at = Date.parse('2026-10-29T08:00:00Z');
const iso = n => new Date(n).toISOString();
const pr = { number: 7, headRefOid: head, labels: [{ name: 'review:pending' }], comments: [],
  createdAt: iso(at - 24 * 3_600_000) };
const options = { repo, env: {}, now: at + 30 * 60_000 };
const quotaRow = step => ({ step, failureKind: 'provider-quota' });
const failedSeat = seat => ({ seat, verdict: 'error' });

function reviewRun(index = 0, complete = false) {
  const time = at + index * 1_000;
  return { id: `review-${index}`, op: 'review-pr',
    findings: { read: { repo, pr: 7, netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', startedAt: iso(time), finishedAt: iso(time + 1) },
      ...(complete ? [{ step: 'advise', startedAt: iso(time + 2), finishedAt: iso(time + 3) }] : [])],
    seatTimings: [failedSeat('judgeSecurity'), failedSeat('judgeCorrectness')],
    telemetry: [quotaRow('judgeSecurity'), quotaRow('judgeCorrectness')],
  };
}

const closedCases = [
  ['no failed seats', run => { run.seatTimings = [{ seat: 'judgeSecurity', verdict: 'accept' }]; }],
  ['empty seat timings', run => { run.seatTimings = []; }],
  ['missing seat timings', run => { delete run.seatTimings; }],
  ['one failed seat has no matching row', run => { run.telemetry.pop(); }],
  ['rows name unrelated steps', run => { run.telemetry = [quotaRow('unrelated')]; }],
  ['one failed seat has another failureKind', run => { run.telemetry[1].failureKind = 'provider-error'; }],
  ['one failed seat has no failureKind', run => { delete run.telemetry[1].failureKind; }],
  ['failureKind is not the exact quota string', run => { run.telemetry[1].failureKind = true; }],
  ['empty telemetry', run => { run.telemetry = []; }],
  ['missing telemetry', run => { delete run.telemetry; }],
  ['null telemetry', run => { run.telemetry = null; }],
  ['object telemetry', run => { run.telemetry = { judgeSecurity: quotaRow('judgeSecurity') }; }],
  ['string telemetry', run => { run.telemetry = 'provider-quota'; }],
  ['unreadable telemetry', run => { Object.defineProperty(run, 'telemetry', {
    get() { throw new Error('telemetry unreadable'); },
  }); }],
];

// Both projections must use the same persisted seat evidence, including the closed paths.
describe.each([false, true])('reviewRunEvidence quotaOnly (completed: %s)', complete => {
  it('exempts only when every failed seat has a matching provider-quota telemetry row', () => {
    const run = reviewRun(0, complete);
    // Successful seats and unrelated telemetry need no quota classification; row order is immaterial.
    run.seatTimings.push({ seat: 'judgeStyle', verdict: 'accept' });
    run.telemetry.reverse();
    run.telemetry.push({ step: 'judgeStyle' });
    const row = reviewRunEvidence(run);
    expect(row).toMatchObject({ quotaOnly: true });
    expect(Boolean(row.incomplete)).toBe(!complete);
  });

  it.each(closedCases)('fails closed with %s', (_, mutate) => {
    const run = reviewRun(0, complete);
    mutate(run);
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: false });
  });

  it('does not infer quotaOnly from recorded referral failure text without seat telemetry', () => {
    const run = reviewRun(0, complete);
    delete run.telemetry;
    run.findings.mandatoryReferrals = { effects: [{ type: 'review.mandatory-referrals',
      result: { records: [{ failure: "You've hit your weekly limit", referrals: [], rulings: [] }] } }] };
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: false });
  });
});

function history(mutate = () => {}) {
  return Array.from({ length: 13 }, (_, index) => {
    const run = reviewRun(index);
    mutate(run);
    return reviewRunEvidence(run);
  });
}

describe('same-head quota attempt accounting from persisted seat telemetry', () => {
  it('ignores 13 quota-only incomplete runs', () => {
    expect(decideSameHeadHold(pr, history(), options)).toBeNull();
  });

  it('still holds for 13 incomplete runs each with one genuine failed seat among quota failures', () => {
    const rows = history(run => { run.telemetry[1].failureKind = 'provider-error'; });
    expect(decideSameHeadHold(pr, rows, options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
  });

  it('fails closed and holds for 13 incomplete runs with missing telemetry', () => {
    const rows = history(run => { delete run.telemetry; });
    expect(decideSameHeadHold(pr, rows, options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
  });
});
