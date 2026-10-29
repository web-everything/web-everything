import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reviewRunEvidence, decideSameHeadHold, readReviewRunEvidence,
  REVIEW_EVIDENCE_CACHE_FILE } from '../review-referral-hold.mjs';
import { isQuotaError } from '../../lib/provider-quota-hold.mjs';
import { parseJudgeOutcome } from '../../lib/judge-spawn.mjs';
import { normalizeJudgeTelemetry } from '../../operations/run-record.mjs';

const repo = 'example/repo';
const head = 'a'.repeat(40);
const at = Date.parse('2026-10-29T08:00:00Z');
const iso = n => new Date(n).toISOString();
const pr = { number: 7, headRefOid: head, labels: [{ name: 'review:pending' }], comments: [],
  createdAt: iso(at - 24 * 3_600_000) };
const options = { repo, env: {}, now: at + 30 * 60_000 };
const quotaRow = step => ({ step, failureKind: 'provider-quota' });
const failedSeat = seat => ({ seat, verdict: 'error', finishedAt: iso(at + 1) });

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
  ['two errors for judge have only one quota row (second failure has no telemetry)', run => {
    run.seatTimings = [failedSeat('judge'), failedSeat('judge')];
    run.telemetry = [quotaRow('judge')];
  }],
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
    run.seatTimings.push({ seat: 'judgeStyle', verdict: 'accept', finishedAt: iso(at + 1) });
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

  it.each(['', undefined, null, 0, false, {}, []])('seat-name guard', seat => {
    const run = reviewRun(0, complete);
    run.seatTimings[1] = failedSeat(seat);
    run.telemetry[1] = quotaRow(seat);
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: false });
  });

  it.each([
    ['non-array effects', {}],
    ['effects containing null', [null, { type: 'review.mandatory-referrals',
      result: { records: [{ failure: "You've hit your weekly limit" }] } }]],
  ])('fails closed without throwing for %s and keeps the run as evidence', (_, effects) => {
    const run = reviewRun(0, complete);
    run.findings.mandatoryReferrals = { effects };
    expect(reviewRunEvidence(run)).toMatchObject({ id: run.id, quotaOnly: false });
  });

  it('exempts two errors for judge when each has its own provider-quota telemetry row', () => {
    const run = reviewRun(0, complete);
    run.seatTimings = [failedSeat('judge'), failedSeat('judge')];
    run.telemetry = [quotaRow('judge'), quotaRow('judge')];
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: true });
  });

  it('does not infer quotaOnly from recorded referral failure text without seat telemetry', () => {
    const run = reviewRun(0, complete);
    delete run.telemetry;
    run.findings.mandatoryReferrals = { effects: [{ type: 'review.mandatory-referrals',
      result: { records: [{ failure: "You've hit your weekly limit", referrals: [], rulings: [] }] } }] };
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: false });
  });

  it('rejects a non-quota referral failure even when every failed seat has quota telemetry', () => {
    const run = reviewRun(0, complete);
    run.findings.mandatoryReferrals = { effects: [{ type: 'review.mandatory-referrals',
      result: { records: [{ failure: 'GitHub refused to persist the referral', referrals: [], rulings: [] }] } }] };
    expect(reviewRunEvidence(run)).toMatchObject({ quotaOnly: false });
  });
});

describe('incomplete quota evidence after the seat phase', () => {
  it.each([
    ['object records', {}],
    ['string records', 'provider-quota'],
    ['null records', null],
    ['null record elements', [null]],
    ['a null element mixed with a quota failure', [
      { failure: "You've hit your weekly limit" }, null,
    ]],
  ])('fails closed without throwing for malformed referral evidence: %s', (_, records) => {
    const run = reviewRun();
    run.findings.mandatoryReferrals = { effects: [{ type: 'review.mandatory-referrals',
      result: { records } }] };
    expect(reviewRunEvidence(run)).toMatchObject({ incomplete: true, quotaOnly: false });
  });

  it.each([
    ['no verdict', { seat: 'judgeStyle', finishedAt: iso(at + 1) }],
    ['no finishedAt', { seat: 'judgeStyle', verdict: 'accept' }],
    ['neither verdict nor finishedAt', { seat: 'judgeStyle', startedAt: iso(at) }],
  ])('fails closed when a seat has %s despite quota tags on every error', (_, seat) => {
    const run = reviewRun();
    run.seatTimings.push(seat);
    expect(reviewRunEvidence(run)).toMatchObject({ incomplete: true, quotaOnly: false });
  });

  it.each(['reduce', 'mandatoryReferrals', 'referralVerdict', 'advise'])(
    'counts an incomplete run once %s has started despite all seat quota tags', step => {
      const run = reviewRun();
      run.stepTimings.push({ step, startedAt: iso(at + 2) });
      expect(reviewRunEvidence(run)).toMatchObject({ incomplete: true, quotaOnly: false });
    },
  );

  it('preserves quota evidence from the judge parser through normalized run telemetry', () => {
    let error;
    try {
      parseJudgeOutcome(JSON.stringify({ is_error: true,
        result: "You've hit your weekly limit · resets tomorrow" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.telemetry).toMatchObject({ failureKind: 'provider-quota' });
    const run = reviewRun();
    run.seatTimings = [failedSeat('judge')];
    run.telemetry = [normalizeJudgeTelemetry({ step: 'judge', telemetry: error.telemetry })];
    expect(reviewRunEvidence(run)).toMatchObject({ incomplete: true, quotaOnly: true });
  });
});

describe('review evidence disk cache classifier invalidation', () => {
  it.each([
    ['omits isQuotaError source', ''],
    ['uses different isQuotaError source', `${String(isQuotaError)}\n// previous classifier source`],
  ])('ignores a stale disk projection whose code %s', (_, classifierSource) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-quota-evidence-'));
    try {
      const run = reviewRun();
      const name = 'review-pr-quota-cache.json';
      writeFileSync(join(dir, name), JSON.stringify(run));
      const readRun = vi.fn(() => run);
      const expected = [reviewRunEvidence(run)];
      expect(readReviewRunEvidence({ dir, readRun, memo: new Map() })).toEqual(expected);
      const file = join(dir, REVIEW_EVIDENCE_CACHE_FILE);
      const cache = JSON.parse(readFileSync(file, 'utf8'));
      // Retain the real file key so only code invalidation can reject this stale projection.
      cache.code = createHash('sha256').update(String(reviewRunEvidence))
        .update(classifierSource).digest('hex').slice(0, 16);
      cache.entries[name].evidence = { ...expected[0], quotaOnly: false };
      writeFileSync(file, JSON.stringify(cache));
      readRun.mockClear();

      expect(readReviewRunEvidence({ dir, readRun, memo: new Map() })).toEqual(expected);
      expect(readRun).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('holds for 13 completed runs even when their evidence is quotaOnly', () => {
    const rows = Array.from({ length: 13 }, (_, index) => reviewRunEvidence(reviewRun(index, true)));
    for (const row of rows) {
      expect(row).toMatchObject({ quotaOnly: true, completedAt: expect.any(Number) });
      expect(row.incomplete).not.toBe(true);
    }
    expect(decideSameHeadHold(pr, rows, options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
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

  it('holds for 13 incomplete runs with two judge errors but only one quota telemetry row each', () => {
    const rows = history(run => {
      run.seatTimings = [failedSeat('judge'), failedSeat('judge')];
      run.telemetry = [quotaRow('judge')];
    });
    expect(decideSameHeadHold(pr, rows, options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
  });
});
