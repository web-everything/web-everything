import { describe, it, expect } from 'vitest';
import { sessionGoneForLease, releaseLane, judgedLeaseReleaseOptions } from '../lease-reaper.mjs';

const nowMs = Date.parse('2026-10-22T11:14:14.500Z');
const leaseAtAge = (ageMs) => ({ session: 'fix-5759', holder: 'current-round', acquiredAt: new Date(nowMs - ageMs).toISOString() });
const terminal = new Map([['fix-5759', 'done']]);

function releaseArgv(options = {}) {
  let captured;
  releaseLane('test-pool', 10, { ...options, cli: 'lane-pool.mjs', env: {}, exec: (command, argv) => { captured = { command, argv }; } });
  return captured;
}

describe('reused session names cannot kill a new round inside listing grace', () => {
  it.each(['terminal', 'dead-pid'])('a 5-second lease ignores an old %s row', (signal) => {
    const states = signal === 'terminal' ? terminal : new Map([['fix-5759', 'working']]);
    expect(sessionGoneForLease(leaseAtAge(5_000), states, { nowMs, ...(signal === 'dead-pid' ? { pidAlive: false } : {}) })).toBe(null);
  });

  it.each(['terminal', 'dead-pid'])('a 20-minute lease still reaps on a %s row despite recent renewal', (signal) => {
    const lease = { ...leaseAtAge(20 * 60_000), renewedAt: new Date(nowMs).toISOString() };
    const states = signal === 'terminal' ? terminal : new Map([['fix-5759', 'working']]);
    expect(sessionGoneForLease(lease, states, { nowMs, ...(signal === 'dead-pid' ? { pidAlive: false } : {}) })).toBe(true);
  });

  it('uses the exact grace boundary and a supplied graceMs', () => {
    expect(sessionGoneForLease(leaseAtAge(599_999), terminal, { nowMs })).toBe(null);
    expect(sessionGoneForLease(leaseAtAge(600_000), terminal, { nowMs })).toBe(true);
    expect(sessionGoneForLease(leaseAtAge(5_000), terminal, { nowMs, graceMs: 1_000 })).toBe(true);
  });

  it('keeps wrapper, owner, absence and non-terminal behavior unchanged', () => {
    expect(sessionGoneForLease(leaseAtAge(20 * 60_000), terminal, { nowMs, wrapperAlive: true, pidAlive: false })).toBe(false);
    expect(sessionGoneForLease(leaseAtAge(20 * 60_000), new Map(), { nowMs, ownerAlive: true })).toBe(false);
    expect(sessionGoneForLease(leaseAtAge(5_000), new Map(), { nowMs })).toBe(null);
    expect(sessionGoneForLease(leaseAtAge(20 * 60_000), new Map(), { nowMs })).toBe(true);
    expect(sessionGoneForLease(leaseAtAge(5_000), new Map([['fix-5759', 'working']]), { nowMs })).toBe(false);
    expect(sessionGoneForLease(leaseAtAge(5_000), null, { nowMs, pidAlive: false })).toBe(null);
  });
});

describe('release carries the identity of the lease the reaper judged', () => {
  it('passes expected holder and acquiredAt alongside the reason', () => {
    const lease = leaseAtAge(20 * 60_000);
    expect(releaseArgv({ reason: 'session-gone', expectHolder: lease.holder, expectAcquiredAt: lease.acquiredAt })).toEqual({
      command: 'node', argv: ['lane-pool.mjs', 'release', '--pool=test-pool', '--lane=10', '--force', '--reason=session-gone',
        `--expect-holder=${lease.holder}`, `--expect-acquired-at=${lease.acquiredAt}`],
    });
  });

  it('leaves argv unchanged without expectations', () => {
    expect(releaseArgv().argv).toEqual(['lane-pool.mjs', 'release', '--pool=test-pool', '--lane=10', '--force']);
    expect(releaseArgv({ reason: 'ttl-stale' }).argv).toEqual(['lane-pool.mjs', 'release', '--pool=test-pool', '--lane=10', '--force', '--reason=ttl-stale']);
  });

  it('the main-loop options carry the judged lease identity', () => {
    const lease = leaseAtAge(20 * 60_000);
    const options = judgedLeaseReleaseOptions({ reason: 'session-gone', lease });
    expect(options).toEqual({ reason: 'session-gone', expectHolder: lease.holder, expectAcquiredAt: lease.acquiredAt });
    expect(releaseArgv(options).argv).toContain(`--expect-holder=${lease.holder}`);
    expect(releaseArgv(options).argv).toContain(`--expect-acquired-at=${lease.acquiredAt}`);
  });

  it('a pre-holder judged lease passes only acquiredAt', () => {
    const lease = { ...leaseAtAge(20 * 60_000) };
    delete lease.holder;
    const argv = releaseArgv(judgedLeaseReleaseOptions({ reason: 'session-gone', lease })).argv;
    expect(argv).toContain(`--expect-acquired-at=${lease.acquiredAt}`);
    expect(argv.some((arg) => arg.startsWith('--expect-holder='))).toBe(false);
  });
});
