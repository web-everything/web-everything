import { describe, it, expect } from 'vitest';
import { reviewCiGate, reviewCiPrerequisites } from '../review-ci-gate.mjs';
const headSha = 'a'.repeat(40);
const success = name => ({ name, status: 'completed', conclusion: 'success' });
const gate = checks => reviewCiGate({ rowsComplete: true, rowsHead: headSha, headSha, requiredChecks: ['test', 'daemon-soak'], checks });
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
    for (const over of [{ requiredChecks: null }, { requiredChecks: [] }, { requiredChecks: [null] }, { checks: [] }, { checks: null }]) {
      expect(reviewCiGate({ rowsComplete: true, rowsHead: headSha, headSha, requiredChecks: ['test'], checks: [success('test')], ...over }).allowed).toBe(false);
    }
  });
  it.each([undefined, null, '', '   '])('reports missing-head before row hydration for headSha=%j', missingHead => {
    for (const rowsHead of [missingHead, headSha]) {
      expect(reviewCiGate({ rowsComplete: true, rowsHead, headSha: missingHead,
        requiredChecks: ['test'], checks: [success('test')] }))
        .toMatchObject({ allowed: false, reason: 'missing-head', affected: [] });
    }
  });
  it('uses the newest rerun regardless of REST ordering', () => {
    const old = { ...success('test'), id: 1, conclusion: 'failure' };
    const fresh = { ...success('test'), id: 2 };
    for (const rows of [[old, fresh], [fresh, old]]) expect(gate([...rows, success('daemon-soak')]).allowed).toBe(true);
    for (const status of ['in_progress', 'completed']) {
      expect(gate([{ ...fresh, id: 3, status, conclusion: 'failure' }, fresh, success('daemon-soak')]).allowed).toBe(false);
    }
  });
  it('never exempts an explicitly required review-gate', () => {
    expect(reviewCiGate({ rowsComplete: true, rowsHead: headSha, headSha, requiredChecks: ['review-gate'], checks: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] })).toMatchObject({ allowed: false, reason: 'required-review-gate-conflict' });
  });
  it('admits successful required commit statuses', () => {
    for (const row of [{ context: 'legacy', state: 'success' }, { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' }]) {
      expect(reviewCiGate({ rowsComplete: true, rowsHead: headSha, headSha, requiredChecks: ['legacy'], checks: [row] }).allowed).toBe(true);
    }
  });
  it.each([['pending', 'pending'], ['expected', 'pending'], ['failure', 'failure'], ['error', 'error'], ['weird', 'malformed']])(
    'refuses a required commit status in state %s', (state, reason) => {
      expect(reviewCiGate({ rowsComplete: true, rowsHead: headSha, headSha, requiredChecks: ['legacy'], checks: [{ context: 'legacy', state }] }))
        .toMatchObject({ allowed: false, affected: [{ name: 'legacy', reason }] });
    });
});

describe('hydrated rollup evidence', () => {
  it.each([undefined, false, 'true'])('refuses rowsComplete=%j despite green checks', rowsComplete => {
    expect(reviewCiGate({ headSha, checks: [success('test')], requiredChecks: ['test'], rowsComplete, rowsHead: headSha }))
      .toEqual({ allowed: false, headSha, reason: 'rows-incomplete', unknown: true, affected: [] });
  });
  it.each([undefined, 'other', null])('refuses complete rows hydrated for another head: %j', rowsHead => {
    expect(reviewCiGate({ headSha, checks: [success('test')], requiredChecks: ['test'], rowsComplete: true, rowsHead }))
      .toMatchObject({ allowed: false, reason: 'rows-incomplete', unknown: true });
  });
});

describe('aggregate head binding before implication', () => {
  it('marks wrong-head required evidence unknown so consumers cannot bypass the refusal', () => {
    expect(gate([success('test'), { ...success('daemon-soak'), head_sha: 'other' }]))
      .toMatchObject({ allowed: false, unknown: true, affected: [{ name: 'daemon-soak', reason: 'wrong-head' }] });
  });
  it.each([
    { name: 'test', status: 'completed', conclusion: 'success' },
    { context: 'test', state: 'success' },
  ])('refuses a wrong-head aggregate even when only integration is required: %j', aggregate => {
    const input = { headSha, rowsHead: headSha, rowsComplete: true, requiredChecks: ['integration'] };
    expect(reviewCiGate({ ...input, checks: [{ ...aggregate, head_sha: headSha }] }).allowed).toBe(true);
    const result = reviewCiGate({ ...input, checks: [{ ...aggregate, head_sha: 'other' }] });
    expect(result).toMatchObject({ allowed: false, unknown: true, reason: 'required-checks-not-successful' });
    expect(result.affected).toContainEqual({ name: 'test', reason: 'wrong-head' });
    expect(result.affected).toContainEqual({ name: 'integration', reason: 'missing' });
  });
  // PR #7160 round 7: heads must be validated on every raw row BEFORE the per-name collapse, so a newer
  // current-head run cannot hide an older run of the same name that is explicitly bound to another head.
  it.each([
    ['check-run ids, foreign older', [{ ...success('test'), id: 1, head_sha: 'other' }, { ...success('test'), id: 2, head_sha: headSha }]],
    ['check-run ids, foreign newer', [{ ...success('test'), id: 2, head_sha: 'other' }, { ...success('test'), id: 1, head_sha: headSha }]],
    ['rollup order, foreign first', [{ ...success('test'), head_sha: 'other' }, { ...success('test'), head_sha: headSha }]],
    ['status context, foreign first', [{ context: 'test', state: 'success', head_sha: 'other' }, { context: 'test', state: 'success', head_sha: headSha }]],
  ])('refuses foreign-head evidence hidden behind a same-name current-head row (%s)', (_label, checks) => {
    expect(gate([...checks.map(row => ({ ...row, head_sha: headSha })), success('daemon-soak')]).allowed).toBe(true);
    const result = gate([...checks, success('daemon-soak')]);
    expect(result).toMatchObject({ allowed: false, unknown: true });
    expect(result.affected).toContainEqual({ name: 'test', reason: 'wrong-head' });
  });
  it('refuses a foreign-head aggregate hidden behind a current-head rerun when it would imply a required check', () => {
    const result = reviewCiGate({ headSha, rowsHead: headSha, rowsComplete: true, requiredChecks: ['integration'],
      checks: [{ ...success('test'), id: 1, head_sha: 'other' }, { ...success('test'), id: 2, head_sha: headSha }] });
    expect(result).toMatchObject({ allowed: false, unknown: true });
    expect(result.affected).toContainEqual({ name: 'test', reason: 'wrong-head' });
  });
  it('reviewCiPrerequisites reports the name wrong-head from raw rows, not only the collapsed latest', () => {
    const { wrongHeads, needed } = reviewCiPrerequisites({ headSha, requiredChecks: ['test'],
      checks: [{ ...success('test'), id: 1, head_sha: 'other' }, { ...success('test'), id: 2, head_sha: headSha }] });
    expect([...wrongHeads]).toEqual(['test']);
    expect(needed).toEqual(['test']);
  });
});
