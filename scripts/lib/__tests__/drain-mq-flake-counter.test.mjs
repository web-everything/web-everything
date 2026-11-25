import { describe, expect, it } from 'vitest';
import { evaluateMqFlakeCounter, resolveEjectAfterFailures } from '../drain-mq-flake-counter.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const APP = 15368;
const run = (attempt, conclusion, extra = {}) => ({
  name: 'test', head_sha: HEAD, app: { id: APP }, run_id: 7, run_attempt: attempt,
  status: conclusion ? 'completed' : 'in_progress', conclusion,
  started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z', ...extra,
});
const ev = (checks, o = {}) => evaluateMqFlakeCounter({ checks, head: HEAD, name: 'test', appId: APP, threshold: 3, ...o });

describe('drain-mq-flake-counter', () => {
  it('two failures then a pass of the same check on the same tree does not eject', () => {
    expect(ev([run(1, 'failure'), run(2, 'failure'), run(3, 'success')]).action).toBe('pass');
  });
  it('one failure asks for a rerun, not an ejection, at threshold 3', () => {
    expect(ev([run(1, 'failure')]).action).toBe('rerun');
    expect(ev([run(1, 'failure'), run(2, 'failure')]).action).toBe('rerun');
  });
  it('three consecutive failures eject, even if a later attempt is green', () => {
    expect(ev([run(1, 'failure'), run(2, 'failure'), run(3, 'failure')]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, 'failure'), run(3, 'failure'), run(4, 'success')]).action).toBe('eject');
  });
  it('threshold 1 keeps a failed first attempt as ejecting evidence', () => {
    expect(ev([run(1, 'failure'), run(2, 'success')], { threshold: 1 }).action).toBe('eject');
  });
  it('a failure from another app or check name does not count as a pass', () => {
    const r = ev([run(1, 'failure'), run(2, 'failure'), run(3, 'failure'),
      run(4, 'success', { app: { id: 999 } }), run(5, 'success', { name: 'lint' })]);
    expect(r.action).toBe('eject');
  });
  it('a success from another run does not clear a failure', () => {
    expect(ev([run(1, 'failure'), run(1, 'success', { run_id: 8 })]).action).toBe('eject');
  });
  it('a different merge-group head resets the counter', () => {
    const r = ev([run(1, 'failure', { head_sha: OTHER }), run(2, 'failure', { head_sha: OTHER }), run(1, 'failure')]);
    expect(r.action).toBe('rerun');
    expect(r.failures).toBe(1);
  });
  it('counts are ordered by attempt number, not timestamps', () => {
    const t = (a, c, ts) => run(a, c, { started_at: ts, completed_at: ts });
    const r = ev([t(3, 'success', '2026-01-01T00:00:00Z'), t(1, 'failure', '2026-01-03T00:00:00Z'), t(2, 'failure', '2026-01-02T00:00:00Z')]);
    expect(r.action).toBe('pass');
  });
  it('unreadable or incomplete attempts eject', () => {
    expect(ev([]).action).toBe('eject');
    expect(ev(null).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(undefined, 'failure')]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(1, 'success')]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, 'weird')]).action).toBe('eject');
    expect(ev([run(8, 'failure')]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, null, { status: 'unknown' })]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, null, { status: 'completed' })]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, null), run(3, 'failure')]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, 'success', { started_at: undefined })]).action).toBe('eject');
    expect(ev([run(1, 'failure'), run(2, 'skipped')]).action).toBe('eject');
    expect(evaluateMqFlakeCounter({ checks: [run(1, 'failure')], head: 'short', name: 'test', appId: APP, threshold: 3 }).action).toBe('eject');
    expect(ev([run(1, 'failure')], { name: ' ' }).action).toBe('eject');
    expect(ev([run(1, 'failure')], { appId: 'bogus' }).action).toBe('eject');
    expect(ev([run(1, 'failure')], { threshold: Infinity }).action).toBe('eject');
    expect(ev([run(1, 'failure')], { threshold: NaN }).action).toBe('eject');
  });
  it('an in-progress latest attempt waits', () => {
    expect(ev([run(1, 'failure'), run(2, null)]).action).toBe('wait');
  });
  it('default threshold 1 ejects on the first failure and records the shadow decision', () => {
    const r = ev([run(1, 'failure')], { threshold: 1 });
    expect(r.action).toBe('eject');
    expect(r.shadow.action).toBe('rerun');
  });
  it('threshold resolves from settings, defaulting to 1 and refusing bad values', () => {
    expect(resolveEjectAfterFailures({})).toBe(1);
    expect(resolveEjectAfterFailures({ mergeQueue: { ejectAfterFailures: 3 } })).toBe(3);
    expect(resolveEjectAfterFailures({ mergeQueue: { ejectAfterFailures: 0 } })).toBe(1);
    expect(resolveEjectAfterFailures({ mergeQueue: { ejectAfterFailures: 'x' } })).toBe(1);
  });
});
