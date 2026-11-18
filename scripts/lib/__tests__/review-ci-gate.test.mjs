import { describe, it, expect } from 'vitest';
import { reviewCiGate } from '../review-ci-gate.mjs';
const headSha = 'a'.repeat(40);
const success = name => ({ name, status: 'completed', conclusion: 'success' });
const gate = checks => reviewCiGate({ rowsComplete: true, headSha, requiredChecks: ['test', 'daemon-soak'], checks });

describe('row-bound candidacy excusal', () => {
  const hold = { id: 'review-acceptance', status: 'hold', reason: 'review owed' };
  const annotation = { kind: 'candidacy', holds: [hold], holdIds: [hold.id], headSha, jobId: 7 };
  const row = { ...success('merge-gate'), detailsUrl: 'https://github.com/o/r/actions/runs/1/job/7',
    mergeGateHoldExcused: annotation };
  const admit = (checks, extra = {}) => reviewCiGate({ headSha, rowsHead: headSha, rowsComplete: true,
    requiredChecks: ['merge-gate'], checks, ...extra });
  it('admits only the bound excused row without mutating evidence', () => {
    expect(admit([row])).toMatchObject({ allowed: true, affected: [] });
    expect(row.mergeGateHoldExcused).toBe(annotation);
  });
  it.each([
    { jobId: 8 }, { jobId: null }, { headSha: 'b'.repeat(40) }, { headSha: null },
    { holdIds: [] }, { holdIds: ['codeql'] }, { holds: [] }, { holds: null },
    { holds: [{ ...hold, status: 'fail-closed' }] }, { kind: 'unknown' },
    { holds: [{ id: 'red-team', status: 'hold', reason: 'red-team failed' }], holdIds: ['red-team'] },
  ])('rejects stale or malformed excusal %j', invalid => {
    expect(admit([{ ...row, mergeGateHoldExcused: { ...annotation, ...invalid } }]).allowed).toBe(false);
  });
  it('preserves pending, foreign-head, incomplete and separate failed-run evidence', () => {
    expect(admit([{ ...row, status: 'in_progress', conclusion: null }]).allowed).toBe(false);
    expect(admit([{ ...row, head_sha: 'b'.repeat(40) }]).allowed).toBe(false);
    expect(admit([row], { rowsComplete: false }).allowed).toBe(false);
    expect(admit([row, { ...success('merge-gate'), conclusion: 'failure' }]).allowed).toBe(false);
    expect(admit([{ ...row, mergeGateHoldExcused: undefined, mergeGateReviewHold: annotation }]).allowed).toBe(true);
    expect(admit([{ ...row, conclusion: 'failure', mergeGateHoldExcused: undefined,
      mergeGateReviewHold: annotation }]).allowed).toBe(false);
  });
});
describe('strict review CI prerequisite', () => {
  it('admits complete success, ignoring an advisory failure', () => {
    expect(gate([success('test'), success('daemon-soak'), { name: 'review-gate', status: 'completed', conclusion: 'failure' }]).allowed).toBe(true);
  });
  it.each([
    [undefined, 'missing'], [{ status: 'in_progress' }, 'pending'],
    [{ status: 'completed', conclusion: 'failure' }, 'failure'],
    [{ status: 'completed', conclusion: 'skipped' }, 'skipped'],
    [{ status: 'completed', conclusion: 'neutral' }, 'neutral'],
    [{ status: 'completed', conclusion: null }, 'malformed'], [{ status: 3 }, 'malformed'],
    [{ status: 'completed', conclusion: 'success', head_sha: 'other' }, 'wrong-head'],
  ])('refuses affected name: %j', (row, reason) => {
    expect(gate([success('test'), ...(row ? [{ name: 'daemon-soak', ...row }] : [])])).toMatchObject({ allowed: false, affected: [{ name: 'daemon-soak', reason }] });
  });
  it('fails closed for absent evidence', () => {
    for (const over of [{ headSha: null }, { requiredChecks: null }, { requiredChecks: [] }, { requiredChecks: [null] }, { checks: [] }, { checks: null }]) {
      expect(reviewCiGate({ rowsComplete: true, headSha, requiredChecks: ['test'], checks: [success('test')], ...over }).allowed).toBe(false);
    }
  });
  it('supersedes only ordered attempts of the same job in a run', () => {
    const old = { ...success('test'), id: 1, run_id: 1, run_attempt: 1, conclusion: 'failure' };
    const fresh = { ...success('test'), id: 1, run_id: 1, run_attempt: 2 };
    for (const rows of [[old, fresh], [fresh, old]]) expect(gate([...rows, success('daemon-soak')]).allowed).toBe(true);
    for (const status of ['in_progress', 'completed']) {
      expect(gate([{ ...fresh, id: 3, status, conclusion: 'failure' }, fresh, success('daemon-soak')]).allowed).toBe(false);
    }
  });
  it('does not discard same-name failures based on job IDs', () => {
    expect(gate([{ ...success('test'), id: 1, conclusion: 'failure' }, { ...success('test'), id: 2 }, success('daemon-soak')]).allowed).toBe(false);
  });
  it('never exempts an explicitly required review-gate', () => {
    expect(reviewCiGate({ rowsComplete: true, headSha, requiredChecks: ['review-gate'], checks: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] })).toMatchObject({ allowed: false, reason: 'required-review-gate-conflict' });
  });
  it('admits successful required commit statuses', () => {
    for (const row of [{ context: 'legacy', state: 'success' }, { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' }]) {
      expect(reviewCiGate({ rowsComplete: true, headSha, requiredChecks: ['legacy'], checks: [row] }).allowed).toBe(true);
    }
  });
  it.each([['pending', 'pending'], ['expected', 'pending'], ['failure', 'failure'], ['error', 'error'], ['weird', 'malformed']])(
    'refuses a required commit status in state %s', (state, reason) => {
      expect(reviewCiGate({ rowsComplete: true, headSha, requiredChecks: ['legacy'], checks: [{ context: 'legacy', state }] }))
        .toMatchObject({ allowed: false, affected: [{ name: 'legacy', reason }] });
    });
});


describe('review CI completeness evidence', () => {
  it.each([
    [{ status: 'in_progress' }, 'pending'],
    [{ status: 'completed', conclusion: 'failure' }, 'failure'],
  ])('reports observed %s before incomplete rows without admitting review', (fields, reason) => {
    expect(reviewCiGate({ headSha, requiredChecks: ['daemon-soak'], rowsComplete: false,
      checks: [{ name: 'daemon-soak', ...fields }] })).toMatchObject({
      allowed: false, unknown: true, reason: 'required-checks-not-successful',
      affected: [{ name: 'daemon-soak', reason }], secondaryReasons: ['rows-incomplete'],
    });
  });
  it('does not describe an unobserved missing check as an observed blocker', () => {
    expect(reviewCiGate({ headSha, requiredChecks: ['daemon-soak'], checks: [], rowsComplete: false }))
      .toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
  });
  it('refuses missing or false completeness with successful rows and names the fallback', () => {
    const evidence = { headSha, requiredChecks: ['test'], checks: [success('test')] };
    expect(reviewCiGate(evidence)).toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
    expect(reviewCiGate({ ...evidence, rowsComplete: false })).toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
    // Retry with exhausted pagination or explicit reads of every required name.
    expect(reviewCiGate({ ...evidence, rowsComplete: true }).allowed).toBe(true);
  });
});

it('the review adapter explicitly opts into historical integration implication', () => {
  const options = { headSha, rowsComplete: true, requiredChecks: ['test', 'integration'],
    checks: [success('test')] };
  expect(reviewCiGate(options).allowed).toBe(true);
  for (const integration of [{ name: 'integration' }, { ...success('integration'), head_sha: 'b'.repeat(40) }]) {
    expect(reviewCiGate({ ...options, checks: [...options.checks, integration] }).allowed).toBe(false);
  }
});
