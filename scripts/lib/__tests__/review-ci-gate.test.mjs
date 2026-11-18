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
    const old = { ...success('test'), workflowName: 'CI', id: 1, startedAt: '2026-10-28T01:00:00Z', conclusion: 'failure' };
    const fresh = { ...success('test'), workflowName: 'CI', id: 2, startedAt: '2026-10-28T02:00:00Z' };
    for (const rows of [[old, fresh], [fresh, old]]) expect(gate([...rows, success('daemon-soak')]).allowed).toBe(true);
    for (const status of ['in_progress', 'completed']) {
      expect(gate([{ ...fresh, id: 3, startedAt: '2026-10-28T03:00:00Z', status, conclusion: 'failure' }, fresh, success('daemon-soak')]).allowed).toBe(false);
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

// R37: display names are shared across independent workflows.
describe('R37 workflow partitions', () => {
  it.each(['failure', null])('refuses a separate failing/pending workflow (%s) despite later success', conclusion => {
    const rows = [
      { ...success('test'), workflowName: 'security', startedAt: '2026-10-28T01:00:00Z',
        status: conclusion ? 'completed' : 'in_progress', conclusion },
      { ...success('test'), workflowName: 'CI', startedAt: '2026-10-28T02:00:00Z' },
    ];
    for (const order of [rows, rows.toReversed()]) {
      expect(gate([...order, success('daemon-soak')]).allowed).toBe(false);
    }
  });
  it.each([undefined, '2026-10-28T01:00:00Z'])('fails closed for missing/tied times (%s), ignoring ids', startedAt => {
    const rows = [
      { ...success('test'), id: 1, startedAt, conclusion: 'failure' },
      { ...success('test'), id: 99, startedAt: '2026-10-28T01:00:00Z' },
    ];
    for (const order of [rows, rows.toReversed()]) expect(gate([...order, success('daemon-soak')]).allowed).toBe(false);
  });
});

it.each([undefined, 'CI'])('review gate preserves CheckRun failure beside later legacy success (workflow=%s)', workflowName => {
  const failed = { ...success('test'), __typename: 'CheckRun', workflowName, conclusion: 'failure', startedAt: '2026-10-28T01:00:00Z' };
  const passed = { context: 'test', workflowName, state: 'success', startedAt: '2026-10-28T02:00:00Z' };
  for (const rows of [[failed, passed], [passed, failed]]) expect(gate([...rows, success('daemon-soak')]))
    .toMatchObject({ allowed: false, affected: [{ name: 'test', reason: 'failure' }] });
});
it('review gate refuses newer REST success without workflow identity', () => {
  const failed = { ...success('test'), conclusion: 'failure', startedAt: '2026-10-28T01:00:00Z', id: 1 };
  const passed = { ...success('test'), startedAt: '2026-10-28T02:00:00Z', id: 99 };
  for (const rows of [[failed, passed], [passed, failed]]) expect(gate([...rows, success('daemon-soak')]).allowed).toBe(false);
});

it.each([2, undefined])('review gate retains CodeQL failure for a different or missing workflow id (%s)', workflow_id => {
  const failed = { ...success('CodeQL'), workflowName: 'CI', workflow_id: 1, conclusion: 'failure', startedAt: '2026-10-28T01:00:00Z' };
  const passed = { ...failed, workflow_id, conclusion: 'success', startedAt: '2026-10-28T02:00:00Z' };
  for (const checks of [[failed, passed], [passed, failed]]) {
    expect(reviewCiGate({ headSha, requiredChecks: ['CodeQL'], checks }))
      .toMatchObject({ allowed: false, affected: [{ name: 'CodeQL', reason: 'failure' }] });
  }
});
