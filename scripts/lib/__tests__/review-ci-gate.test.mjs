import { describe, it, expect } from 'vitest';
import { reviewCiGate } from '../review-ci-gate.mjs';
const headSha = 'a'.repeat(40);
const success = name => ({ name, status: 'completed', conclusion: 'success' });
const gate = checks => reviewCiGate({ rosterSource: 'live', rowsComplete: true, headSha, requiredChecks: ['test', 'daemon-soak'], checks });
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
      expect(reviewCiGate({ rosterSource: 'live', rowsComplete: true, headSha, requiredChecks: ['test'], checks: [success('test')], ...over }).allowed).toBe(false);
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
  it('admits successful required commit statuses', () => {
    for (const row of [{ context: 'legacy', state: 'success' }, { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' }]) {
      expect(reviewCiGate({ rosterSource: 'live', rowsComplete: true, headSha, requiredChecks: ['legacy'], checks: [row] }).allowed).toBe(true);
    }
  });
  it.each([['pending', 'pending'], ['expected', 'pending'], ['failure', 'failure'], ['error', 'error'], ['weird', 'malformed']])(
    'refuses a required commit status in state %s', (state, reason) => {
      expect(reviewCiGate({ rosterSource: 'live', rowsComplete: true, headSha, requiredChecks: ['legacy'], checks: [{ context: 'legacy', state }] }))
        .toMatchObject({ allowed: false, affected: [{ name: 'legacy', reason }] });
    });
});


describe('review CI completeness evidence', () => {
  it.each([
    [{ status: 'in_progress' }, 'pending'],
    [{ status: 'completed', conclusion: 'failure' }, 'failure'],
  ])('reports observed %s before incomplete rows without admitting review', (fields, reason) => {
    expect(reviewCiGate({ rosterSource: 'live', headSha, requiredChecks: ['daemon-soak'], rowsComplete: false,
      checks: [{ name: 'daemon-soak', ...fields }] })).toMatchObject({
      allowed: false, unknown: true, reason: 'required-checks-not-successful',
      affected: [{ name: 'daemon-soak', reason }], secondaryReasons: ['rows-incomplete'],
    });
  });
  it('does not describe an unobserved missing check as an observed blocker', () => {
    expect(reviewCiGate({ rosterSource: 'live', headSha, requiredChecks: ['daemon-soak'], checks: [], rowsComplete: false }))
      .toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
  });
  it('refuses missing or false completeness with successful rows and names the fallback', () => {
    const evidence = { rosterSource: 'live', headSha, requiredChecks: ['test'], checks: [success('test')] };
    expect(reviewCiGate(evidence)).toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
    expect(reviewCiGate({ rosterSource: 'live', ...evidence, rowsComplete: false })).toMatchObject({ allowed: false, unknown: true, reason: 'rows-incomplete' });
    // Retry with exhausted pagination or explicit reads of every required name.
    expect(reviewCiGate({ rosterSource: 'live', ...evidence, rowsComplete: true }).allowed).toBe(true);
  });
});

it('the review adapter leaves absent integration pending (Rule 6 removed)', () => {
  const options = { rosterSource: 'live', headSha, rowsComplete: true, requiredChecks: ['test', 'integration'],
    checks: [success('test')] };
  // Coordinator ruling removes the historical test => integration implication.
  expect(reviewCiGate(options)).toMatchObject({ allowed: false, affected: [{ name: 'integration', reason: 'missing' }] });
  for (const integration of [{ name: 'integration' }, { ...success('integration'), head_sha: 'b'.repeat(40) }]) {
    expect(reviewCiGate({ rosterSource: 'live', ...options, checks: [...options.checks, integration] }).allowed).toBe(false);
  }
});

it.each([undefined, 'declared', 'stale-cache', 'unavailable'])('missing or untrusted roster provenance %s is unknown', rosterSource => {
  expect(reviewCiGate({ headSha, rowsComplete: true, requiredChecks: ['test'], checks: [success('test')], rosterSource }))
    .toMatchObject({ allowed: false, unknown: true, reason: 'unknown-required-set' });
});

const reviewOwnedRows = ['cancelled', 'cancelled', 'failure'].map(conclusion => ({
  name: 'review-gate', head_sha: headSha, status: 'completed', conclusion,
})).concat({ name: 'merge-gate', head_sha: headSha, status: 'completed', conclusion: 'failure' });
const admission = { rosterSource: 'live', rowsComplete: true, headSha,
  requiredChecks: ['test', 'daemon-soak', 'review-gate', 'merge-gate'] };
it('#7037 admits complete same-head green CI despite cancelled and failing review-owned checks', () => {
  expect(reviewCiGate({ ...admission, checks: [...reviewOwnedRows, success('test'), success('daemon-soak')] }))
    .toMatchObject({ allowed: true, affected: [] });
});
it('#7037 still blocks another required check failing', () => {
  expect(reviewCiGate({ ...admission, checks: [...reviewOwnedRows, { ...success('test'), conclusion: 'failure' }, success('daemon-soak')] }))
    .toMatchObject({ allowed: false, affected: [{ name: 'test', reason: 'failure' }] });
});
it.each(['success', 'failure', 'cancelled', 'timed_out', 'startup_failure', 'stale', 'action_required', 'neutral', 'skipped', null])(
  'excludes review-owned required names entirely for conclusion %s', conclusion => {
    expect(reviewCiGate({ ...admission, requiredChecks: ['review-gate', 'merge-gate'], checks:
      ['review-gate', 'merge-gate'].map(name => ({ name, status: 'completed', conclusion })) }))
      .toMatchObject({ allowed: true, affected: [] });
  });
it('review-owned-only roster still requires complete same-head evidence and trusted provenance', () => {
  const evidence = { ...admission, requiredChecks: ['review-gate', 'merge-gate'], checks: reviewOwnedRows };
  for (const over of [{ rowsComplete: false }, { rowsHead: 'b'.repeat(40) }, { rosterSource: undefined }, { requiredChecks: [] }]) {
    expect(reviewCiGate({ ...evidence, ...over }).allowed).toBe(false);
  }
});
