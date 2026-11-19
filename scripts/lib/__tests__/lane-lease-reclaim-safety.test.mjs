import { it, expect, vi } from 'vitest';
import { holderPidAlive, laneReclaimDecision, probeLaneReclaim } from '../lane-lease-liveness.mjs';
import { applyReclaimSafety } from '../../conveyor/lease-reaper.mjs';

it.each([[true, false, 'stale-but-live'], [false, true, 'stale-but-dirty'],
  [null, false, 'stale-but-live'], [false, null, 'stale-but-dirty']])(
  'refuses unsafe evidence pid=%s dirty=%s', (pidAlive, dirty, reason) => {
    expect(laneReclaimDecision({ pidAlive, dirty })).toEqual({ safe: false, reason });
  });
it('allows a dead holder with a clean tree (including legacy leases without a pid)', () => {
  expect(probeLaneReclaim('lane', {}, { run: () => ({ status: 0, stdout: '' }) })).toEqual({ safe: true, reason: null });
});
it.each([['EPERM', true], ['ESRCH', false], ['EIO', null]])('pid probe handles %s', (code, alive) => {
  const kill = vi.fn(() => { throw Object.assign(Error(code), { code }); });
  expect(holderPidAlive({ pid: 123 }, { kill })).toBe(alive);
  expect(kill).toHaveBeenCalledWith(123, 0);
});
it('observes the live holder with kill(pid, 0)', () => {
  expect(holderPidAlive({ pid: process.pid })).toBe(true);
});
it('refuses foreign-host PID evidence', () => {
  expect(holderPidAlive({ pid: 123, host: 'elsewhere' }, { host: 'here' })).toBe(null);
});
it.each([
  () => ({ status: 1, stdout: '' }),
  () => { throw Error('unreadable'); },
  () => ({ status: null, error: Object.assign(Error('overflow'), { code: 'ENOBUFS' }) }),
])('unreadable or oversized git evidence refuses with an operator-visible reason', run => {
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
});
it('bounds the git probe and detects untracked work', () => {
  const run = vi.fn(() => ({ status: 0, stdout: '?? work.txt\n' }));
  expect(probeLaneReclaim('lane', {}, { run }).safe).toBe(false);
  expect(run).toHaveBeenCalledWith('git', ['status', '--porcelain', '--untracked-files=all'],
    expect.objectContaining({ timeout: 5000, maxBuffer: 1024 * 1024 }));
});
it('the conveyor keeps unsafe lanes even with terminal PR evidence', () => {
  const candidate = { dir: 'lane', lease: {}, reason: 'pr-merged' };
  const plan = applyReclaimSafety({ reap: [candidate], keep: [] }, {
    check: () => laneReclaimDecision({ pidAlive: true, dirty: false }),
  });
  expect(plan.reap).toEqual([]);
  expect(plan.keep).toEqual([{ ...candidate, reason: 'stale-but-live' }]);
});
