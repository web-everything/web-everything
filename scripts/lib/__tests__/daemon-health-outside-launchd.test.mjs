import { expect, it, vi } from 'vitest';
import { probeDaemonStatus, probeLeasePid } from '../../conveyor/health-watch.mjs';
import outsideLaunchd from '../../conveyor/health-smells/daemon-outside-launchd.mjs';
import { SMELLS } from '../../conveyor/health-smells/index.mjs';
import { emptyHealthState, runHealthTick } from '../../conveyor/health-watch-core.mjs';

const row = (running = false, pid = 42) => ({ name: 'com.we.review-daemon', readable: true, running,
  lease: { entry: { pid, heartbeatAt: '2026-11-18T15:09:00Z' } } });
function probe(rows, alive) {
  return probeDaemonStatus({ collect: () => ({ observedAt: '2026-11-18T15:10:00Z', daemons: rows }), leasePidAlive: alive });
}
it('health-watch alerts on a live lease outside launchd and never plans intervention', () => {
  const alive = vi.fn(() => true);
  const leases = probe([row()], alive);
  expect(alive).toHaveBeenCalledWith(42);
  expect(leases[0]).toMatchObject({ outsideLaunchd: true, pid: 42, pidAlive: true });
  expect(SMELLS.some(s => s.id === outsideLaunchd.id)).toBe(true);
  expect(outsideLaunchd.action).toBe('alert');
  const result = runHealthTick(emptyHealthState(), { leases }, [outsideLaunchd], Date.parse('2026-11-18T15:10:00Z'));
  expect(result.plan.some(p => p.kind === 'notify' && !p.suppressed)).toBe(true);
  expect(result.plan.some(p => ['investigate', 'dispatch', 'kill'].includes(p.kind))).toBe(false);
  expect(outsideLaunchd.evaluate({ leases })[0].summary).toContain('live lease holder pid 42');
});
it('fails closed with an operator alert when lease process evidence is unreadable', () => {
  const leases = probe([row()], () => null);
  expect(outsideLaunchd.evaluate({ leases })[0]).toMatchObject({ breach: true, measure: { livenessKnown: false } });
  expect(outsideLaunchd.evaluate({ leases })[0].recommendation).toContain('manually');
});
it.each([['launchd supervised', true, 42, true], ['dead holder', false, 42, false],
  ['no lease', false, undefined, true], ['invalid pid', false, -1, true]])(
  'does not allege an outside-launchd daemon for %s', (_name, running, pid, live) => {
    const r = row(running); r.lease.entry.pid = pid;
    const alive = vi.fn(() => live);
    const leases = probe([r], alive);
    expect(outsideLaunchd.evaluate({ leases })).toEqual([]);
    if (running || pid === undefined || pid < 0) expect(alive).not.toHaveBeenCalled();
  });

it('probes only ps with bounded injectable IO; malformed, oversized and unavailable evidence alert for inspection', () => {
  const exec = vi.fn(() => ' 42\n');
  expect(probeLeasePid(42, { exec })).toBe(true);
  expect(exec).toHaveBeenCalledWith('ps', ['-o', 'pid=', '-p', '42'], expect.objectContaining({ timeout: 5000, maxBuffer: 4096 }));
  for (const output of ['', 'wrong', '42'.repeat(3000)]) {
    expect(probeLeasePid(42, { exec: () => output })).toBeNull();
  }
  expect(probeLeasePid(42, { exec: () => { throw Object.assign(new Error('gone'), { status: 1 }); } })).toBe(false);
  expect(probeLeasePid(42, { exec: () => { throw new Error('unreadable'); } })).toBeNull();
  expect(probeLeasePid(42, { exec: () => { throw Object.assign(new Error('overflow'), { code: 'ENOBUFS' }); } })).toBeNull();
});
