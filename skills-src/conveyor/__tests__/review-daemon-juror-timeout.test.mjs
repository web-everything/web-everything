import { describe, it, expect, vi } from 'vitest';
import { runReviewTick } from '../review-daemon.mjs';
const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const key = `${repo}#77`;
function timeoutFixture() {
  const state = { firstOwedAt: new Map(), lastDispatched: new Map([[key, { pid: 41, head }]]) };
  const dispatch = vi.fn(() => ({ jobPid: 42 }));
  const log = vi.fn();
  const tick = (options = {}) => runReviewTick({ repo, dispatchState: state,
    reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 77, headRefOid: head }], refusals: [] }),
    readPrs: () => [{ number: 77, headRefOid: head, labels: ['review:pending'] }], readAgents: () => [],
    holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
    dispatch, log, isPidAlive: () => false, acquirableLanes: () => 10,
    diagnoseJob: () => ({ exitCode: 0, signal: null, marker: true, head,
      jurorTimeout: { reason: 'juror-timeout', lens: 'security', provider: 'claude', model: 'sonnet' } }),
    writeJobDiagnosis: () => {}, timeoutRouteAvailable: () => true, ...options });
  return { state, dispatch, log, tick };
}
describe('head-bound juror timeout recovery', () => {
  it('passes persistent per-lens exclusions and logs the real outcome, never no verdict', () => {
    const f = timeoutFixture();
    f.tick();
    expect(f.dispatch.mock.calls[0][0].jurorTimeoutExclusions).toEqual([{ lens: 'security', provider: 'claude' }]);
    expect(f.state.jurorTimeouts.get(key)).toMatchObject({ head, count: 1 });
    expect(f.log.mock.calls.flat().join(' ')).toContain('juror-timeout lens=security provider=claude');
    expect(f.log.mock.calls.flat().join(' ')).not.toContain('no-verdict');
  });
  it('holds after two timeouts with no alternative and emits an orchestrator ask; repeated ticks never dispatch', () => {
    const f = timeoutFixture(); f.tick(); f.dispatch.mockClear();
    const second = { ...{ reason: 'juror-timeout', lens: 'security', provider: 'agy-gemini', model: 'gemini-3-pro' } };
    const options = { timeoutRouteAvailable: () => false,
      diagnoseJob: () => ({ marker: true, head, jurorTimeout: second }) };
    const out = f.tick(options);
    expect(out.notStarted).toContainEqual(expect.objectContaining({ reason: 'review-blocked-on-infra: juror timeout x2' }));
    expect(f.dispatch).not.toHaveBeenCalled();
    f.tick(options); expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join(' ')).toMatch(/orchestrator ask:.*security/);
  });
  it.each(['missing', 'wrong-head', 'untrusted-run'])('never routes from %s timeout evidence', kind => {
    const f = timeoutFixture();
    f.tick({ diagnoseJob: () => ({ marker: kind !== 'untrusted-run', head: kind === 'wrong-head' ? 'b'.repeat(40) : head,
      jurorTimeout: kind === 'missing' ? undefined : { reason: 'juror-timeout', lens: 'security', provider: 'claude', model: 'sonnet' } }) });
    expect(f.dispatch.mock.calls[0][0].jurorTimeoutExclusions).toBeUndefined();
    expect(f.state.jurorTimeouts?.get(key)).toBeUndefined();
  });
  it('resets old-head timeout exclusions and holds', () => {
    const f = timeoutFixture();
    f.state.jurorTimeouts = new Map([[key, { head: 'b'.repeat(40), count: 2, held: true, exclusions: [{ lens: 'security', provider: 'claude' }] }]]);
    f.state.lastDispatched.clear(); f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0][0].jurorTimeoutExclusions).toBeUndefined();
  });
});


it('unreadable routing holds the head and asks the orchestrator instead of dispatching blindly', () => {
  const f = timeoutFixture();
  const out = f.tick({ timeoutRouteAvailable: () => { throw Error('routing unreadable'); } });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(out.notStarted[0].reason).toBe('review-blocked-on-infra: juror timeout x1');
  expect(f.log.mock.calls.flat().join(' ')).toContain('orchestrator ask:');
  expect(f.log.mock.calls.flat().join(' ')).toContain('routing unreadable');
});


it('rechecks narrowed routing before a later retry instead of dispatching from stale availability', () => {
  const f = timeoutFixture(); f.tick();
  f.state.lastDispatched.clear(); f.dispatch.mockClear();
  const out = f.tick({ timeoutRouteAvailable: () => false });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(out.notStarted[0].reason).toBe('review-blocked-on-infra: juror timeout x1');
});
