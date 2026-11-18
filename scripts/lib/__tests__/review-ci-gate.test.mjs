import { describe, it, expect } from 'vitest';
import { reviewCiGate } from '../review-ci-gate.mjs';
const headSha = 'a'.repeat(40);
const success = name => ({ name, status: 'completed', conclusion: 'success' });
const gate = checks => reviewCiGate({ headSha, requiredChecks: ['test', 'daemon-soak'], checks });
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
      expect(reviewCiGate({ headSha, requiredChecks: ['test'], checks: [success('test')], ...over }).allowed).toBe(false);
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
    expect(reviewCiGate({ headSha, requiredChecks: ['review-gate'], checks: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] })).toMatchObject({ allowed: false, reason: 'required-review-gate-conflict' });
  });
  it('admits successful required commit statuses', () => {
    for (const row of [{ context: 'legacy', state: 'success' }, { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' }]) {
      expect(reviewCiGate({ headSha, requiredChecks: ['legacy'], checks: [row] }).allowed).toBe(true);
    }
  });
  it.each([['pending', 'pending'], ['expected', 'pending'], ['failure', 'failure'], ['error', 'error'], ['weird', 'malformed']])(
    'refuses a required commit status in state %s', (state, reason) => {
      expect(reviewCiGate({ headSha, requiredChecks: ['legacy'], checks: [{ context: 'legacy', state }] }))
        .toMatchObject({ allowed: false, affected: [{ name: 'legacy', reason }] });
    });
});
