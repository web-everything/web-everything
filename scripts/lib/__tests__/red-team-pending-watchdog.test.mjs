/** Pure pending-label watchdog contract; implementation follows in phase 2. */
import { describe, it, expect } from 'vitest';
import { planPendingRedTeam } from '../red-team-pending-watchdog.mjs';

const evidence = (patch = {}) => ({ ageMinutes: 61, status: null, ownerAlive: null,
  restarts: 0, minutesSinceLastRestart: null, ...patch });
const plan = (patch = {}) => planPendingRedTeam(evidence(patch));
const expectKind = (patch, kind) => {
  const result = plan(patch);
  expect(result).toEqual({ kind, reason: expect.any(String) });
  expect(result.reason.trim().length).toBeGreaterThan(0);
  return result;
};

describe('planPendingRedTeam', () => {
  it('restarts a pending head older than 60 minutes with no run or result', () => {
    expectKind({}, 'restart');
  });
  it.each([0, 59, 59.99])('waits below the threshold at %s minutes', ageMinutes => {
    expectKind({ ageMinutes }, 'wait');
  });
  it('restarts at the inclusive 60-minute threshold', () => {
    expectKind({ ageMinutes: 60 }, 'restart');
  });
  it('the age threshold also precedes publication and exhaustion', () => {
    expectKind({ ageMinutes: 59, status: { status: 'finished', result: { status: 'ran' } } }, 'wait');
    expectKind({ ageMinutes: 59, restarts: 2 }, 'wait');
  });
  it.each(['queued', 'running'])('waits for a live %s owner even beyond the stale-run deadline', status => {
    expectKind({ ageMinutes: 1000, status: { status }, ownerAlive: true, restarts: 2 }, 'wait');
  });
  it.each(['queued', 'running'])('waits for an unknown %s owner before 120 minutes', status => {
    expectKind({ ageMinutes: 119.99, status: { status }, ownerAlive: null }, 'wait');
  });
  it.each(['queued', 'running'])('restarts an unknown %s owner at the stale deadline', status => {
    expectKind({ ageMinutes: 120, status: { status }, ownerAlive: null }, 'restart');
  });
  it.each(['queued', 'running'])('restarts a proven-dead %s owner before the stale deadline', status => {
    expectKind({ status: { status }, ownerAlive: false }, 'restart');
  });
  it.each([0, 1, 2, 3])('publishes a finished real result, never restarts, with %s prior restarts', restarts => {
    expectKind({ restarts, minutesSinceLastRestart: 0,
      status: { status: 'finished', result: { status: 'ran', findings: [] } } }, 'publish-result');
  });
  it.each([null, 'ran', {}, { status: 'failed' }, { status: 'resumed' }])('finished without a real ran result %j is eligible for restart', result => {
    expectKind({ status: { status: 'finished', result } }, 'restart');
  });
  it('a ran result on a still-running status is not publishable', () => {
    expectKind({ status: { status: 'running', result: { status: 'ran' } }, ownerAlive: true }, 'wait');
  });
  it('spaces restarts by at least the threshold, including the exact boundary', () => {
    expectKind({ restarts: 1, minutesSinceLastRestart: 59.99 }, 'wait');
    expectKind({ restarts: 1, minutesSinceLastRestart: 60 }, 'restart');
  });
  it.each([2, 3, 100])('exhausts after %s restarts rather than retrying forever', restarts => {
    expectKind({ restarts, minutesSinceLastRestart: 180 }, 'exhausted');
  });
  it('honors explicit threshold, restart ceiling and stale-run deadline overrides', () => {
    expectKind({ thresholdMinutes: 90, ageMinutes: 89 }, 'wait');
    expectKind({ thresholdMinutes: 90, ageMinutes: 100, restarts: 1, minutesSinceLastRestart: 89 }, 'wait');
    expectKind({ maxRestarts: 1, restarts: 1, minutesSinceLastRestart: 100 }, 'exhausted');
    expectKind({ staleRunMinutes: 180, ageMinutes: 150, status: { status: 'running' } }, 'wait');
  });
  it.each([NaN, Infinity, -Infinity, undefined, null, '61', -1])('fails closed on malformed age %s with a reason', ageMinutes => {
    expectKind({ ageMinutes }, 'wait');
  });
  it('an unreadable status waits even after the restart budget is exhausted', () => {
    const result = expectKind({ ageMinutes: 1000, restarts: 2, status: { unreadable: true } }, 'wait');
    expect(result.reason).toMatch(/unreadable/i);
  });
  it.each([
    { restarts: -1 }, { restarts: 0.5 }, { restarts: NaN }, { restarts: '0' },
    { restarts: 1, minutesSinceLastRestart: null }, { restarts: 1, minutesSinceLastRestart: NaN },
    { restarts: 1, minutesSinceLastRestart: -1 }, { ownerAlive: 'false' },
    { thresholdMinutes: NaN }, { maxRestarts: -1 }, { staleRunMinutes: Infinity },
  ])('malformed evidence %j fails closed rather than implying clear', patch => {
    expectKind(patch, 'wait');
  });
  it.each([undefined, null, [], 'pending', 61])('fails closed on a malformed argument %j', input => {
    expect(planPendingRedTeam(input)).toEqual({ kind: 'wait', reason: expect.any(String) });
  });
  it.each([false, 'running', [], { status: 'unknown' }])('fails closed on malformed status %j', status => {
    expectKind({ status }, 'wait');
  });
  it('unreadability wins over an apparently finished ran result', () => {
    expectKind({ status: { unreadable: true, status: 'finished', result: { status: 'ran' } } }, 'wait');
  });
  it('non-finite age cannot authorize publication of an otherwise finished result', () => {
    expectKind({ ageMinutes: Infinity, status: { status: 'finished', result: { status: 'ran' } } }, 'wait');
  });
  it('the first restart does not require a previous restart timestamp', () => {
    expectKind({ minutesSinceLastRestart: null }, 'restart');
  });
  it('a configured zero-restart budget immediately escalates an old orphan', () => {
    expectKind({ maxRestarts: 0 }, 'exhausted');
  });
});
