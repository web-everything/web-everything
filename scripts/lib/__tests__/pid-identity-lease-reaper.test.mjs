import { describe, expect, it, vi } from 'vitest';
import { pidIdentity } from '../pid-alive.mjs';
import { defaultIsPidAlive } from '../../conveyor/driver-watchdog.mjs';
import { buildLeaseSignalsFor, classifyReap } from '../../conveyor/lease-reaper.mjs';

const PID = 424242;
const START = 'Sat Oct 24 12:00:00 2026';
const ARGV = 'node scripts/operations/fix-runner.mjs --pr 42';
const ROW = `S+ ${START} ${ARGV}\n`;
const NOW = Date.parse('2026-10-24T12:02:00.000Z');

const detachedWrapperSignals = (exec, wrapperPids = new Map([['conveyor-42', PID]])) => {
  const kill = vi.fn(() => true);
  const identity = vi.fn((pid) => pidIdentity(pid, { exec }));
  const isPidAlive = (pid) => defaultIsPidAlive(pid, identity, kill);
  const lease = { session: 'conveyor-42', acquiredAt: new Date(NOW - 60 * 60_000).toISOString() };
  const signalsFor = buildLeaseSignalsFor({
    prStatesByRepo: new Map(), sessionStates: new Map(), sessionPidAlive: new Map(),
    sessionAgents: [], wrapperPids, nowMs: NOW, isPidAlive,
  });
  return { lease, signals: signalsFor({ lease, repoKey: 'we' }), kill, identity };
};

const expectProbe = (exec, kill, identity, snapshot) => {
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith(PID, 0);
  expect(identity).toHaveBeenCalledTimes(1);
  expect(identity).toHaveBeenCalledWith(PID);
  expect(identity).toHaveReturnedWith(snapshot);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledWith('ps',
    ['-p', String(PID), '-o', 'stat=,lstart=,command='], expect.any(Object));
};

describe('detached wrapper identity through the production lease reaper', () => {
  it('unreadable ps identity after a successful existence probe stays unknown and keeps the lane', () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error('ps: permission denied'), { status: 1, stderr: 'ps: permission denied' });
    });
    const { lease, signals, kill, identity } = detachedWrapperSignals(exec);
    expectProbe(exec, kill, identity, { alive: null, reason: 'unreadable' });
    // With no session or owner evidence, only wrapperAlive's veto can retain this lane.
    expect(signals.sessionGone).toBe(false);
    expect(classifyReap(lease, { ...signals, nowMs: NOW })).toEqual({ reap: false, reason: null });
  });

  it.each([
    ['matching live wrapper keeps the lane', ROW, { alive: true, reason: 'match' }, false],
    ['zombie wrapper permits reclamation', `Z+ ${START} ${ARGV}\n`, { alive: false, reason: 'zombie' }, true],
    ['recycled spare wrapper permits reclamation', `S ${START} claude bg-spare --bg-spare /tmp/x.sock\n`,
      { alive: false, reason: 'recycled-spare' }, true],
    ['gone wrapper permits reclamation', '', { alive: false, reason: 'gone' }, true],
  ])('%s', (_name, output, snapshot, reap) => {
    const exec = vi.fn(() => output);
    const { lease, signals, kill, identity } = detachedWrapperSignals(exec);
    expectProbe(exec, kill, identity, snapshot);
    expect(signals.sessionGone).toBe(reap);
    expect(classifyReap(lease, { ...signals, nowMs: NOW }))
      .toEqual({ reap, reason: reap ? 'session-gone' : null });
  });

  it('missing wrapper permits ordinary absence reclamation without probing a process', () => {
    const exec = vi.fn(() => { throw new Error('unexpected subprocess'); });
    const { lease, signals, kill, identity } = detachedWrapperSignals(exec, new Map());
    expect(kill).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(signals.sessionGone).toBe(true);
    expect(classifyReap(lease, { ...signals, nowMs: NOW }))
      .toEqual({ reap: true, reason: 'session-gone' });
  });
});
