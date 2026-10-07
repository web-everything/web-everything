/**
 * @file scripts/operations/__tests__/maintenance.test.mjs
 * @description Card 105 — dry run of `maintenance` start/status/end against FAKE io (never the live daemons).
 */
import { describe, it, expect } from 'vitest';
import { maintenanceOperation, MAINTENANCE_OP, runMaintenance, classifySession } from '../maintenance.mjs';
import { planClaudeAuthDispatchGate } from '../../conveyor/claude-auth-health.mjs';

function fakeIo({ sessions = [], testOk = true, pause = { paused: false } } = {}) {
  const st = { marker: null, pause, kill: false, calls: [] };
  return {
    st,
    readMarker: () => st.marker,
    writeMarker: (m) => { st.marker = m; st.calls.push('writeMarker'); },
    clearMarker: () => { st.marker = null; st.calls.push('clearMarker'); },
    readPause: () => st.pause,
    setPause: ({ reason, by }) => { st.pause = { paused: true, reason, by }; st.calls.push('setPause'); },
    clearPause: () => { st.pause = { paused: false }; st.calls.push('clearPause'); },
    killExists: () => st.kill,
    touchKill: () => { st.kill = true; st.calls.push('touchKill'); },
    removeKill: () => { st.kill = false; st.calls.push('removeKill'); },
    listSessions: () => sessions,
    testSession: () => (testOk ? { ok: true, detail: 'OK' } : { ok: false, detail: 'Login expired' }),
    now: () => '2026-10-06T12:00:00.000Z',
  };
}

const SESSIONS = [
  { name: 'fix-4100', cwd: '/w/.lanes/web-everything/lane-7', sessionId: 's1', startedAt: 1 },
  { name: 'review-4101', cwd: '/w/.lanes/web-everything/lane-9', sessionId: 's2', startedAt: 2 },
];

describe('maintenance', () => {
  it('classifySession names lane and PR', () => {
    expect(classifySession(SESSIONS[0])).toMatchObject({ lane: 7, pr: 4100, kind: 'fix' });
  });

  it('start pauses dispatch kinds, kill file and marker, and lists running sessions', () => {
    const io = fakeIo({ sessions: SESSIONS });
    const r = runMaintenance({ action: 'start', reason: 'account switch', by: 'op' }, io);
    expect(io.st.pause.paused).toBe(true);
    expect(io.st.kill).toBe(true);
    expect(io.st.marker).toMatchObject({ reason: 'account switch', by: 'op' });
    expect(r.running.map((s) => s.pr)).toEqual([4100, 4101]);
    expect(r.state).toBe('paused');
  });

  it('start refuses without a reason', () => {
    expect(() => runMaintenance({ action: 'start', reason: '' }, fakeIo())).toThrow(/reason/);
  });

  it('status reports what is paused and who is running', () => {
    const io = fakeIo({ sessions: SESSIONS });
    runMaintenance({ action: 'start', reason: 'x', by: 'op' }, io);
    const r = runMaintenance({ action: 'status' }, io);
    expect(r).toMatchObject({ state: 'paused', dispatchPaused: true, killFile: true, review: 'paused' });
    expect(r.running).toHaveLength(2);
    expect(runMaintenance({ action: 'status' }, fakeIo()).state).toBe('running');
  });

  it('end with a failing login test keeps everything paused and fails loudly', () => {
    const io = fakeIo({ testOk: false });
    runMaintenance({ action: 'start', reason: 'x', by: 'op' }, io);
    expect(() => runMaintenance({ action: 'end' }, io)).toThrow(/login test FAILED.*still paused/s);
    expect(io.st.pause.paused).toBe(true);
    expect(io.st.kill).toBe(true);
    expect(io.st.marker).not.toBeNull();
  });

  it('end with a passing login test lifts everything', () => {
    const io = fakeIo();
    runMaintenance({ action: 'start', reason: 'x', by: 'op' }, io);
    const r = runMaintenance({ action: 'end' }, io);
    expect(r.state).toBe('running');
    expect(io.st).toMatchObject({ kill: false, marker: null, pause: { paused: false } });
  });

  it('does not clear a pause or kill file the operator set before maintenance', () => {
    const io = fakeIo({ pause: { paused: true, reason: 'manual', by: 'me' } });
    io.st.kill = true;
    runMaintenance({ action: 'start', reason: 'x', by: 'op' }, io);
    expect(io.st.calls).not.toContain('setPause');
    expect(io.st.calls).not.toContain('touchKill');
    runMaintenance({ action: 'end' }, io);
    expect(io.st.pause.paused).toBe(true);
    expect(io.st.kill).toBe(true);
  });

  it('end without an active maintenance is refused', () => {
    expect(() => runMaintenance({ action: 'end' }, fakeIo())).toThrow(/not in maintenance/);
  });

  it('is a declared operation', () => {
    expect(MAINTENANCE_OP).toBe('maintenance');
    expect(maintenanceOperation().name).toBe('maintenance');
  });

  it('the review/fix daemons gate pauses while the marker exists', () => {
    const gate = planClaudeAuthDispatchGate({ listAgents: () => [], health: () => ({ broken: false }), readMaintenance: () => ({ reason: 'swap' }) });
    expect(gate).toMatchObject({ paused: true, source: 'maintenance' });
    expect(planClaudeAuthDispatchGate({ listAgents: () => [], health: () => ({ broken: false }), readMaintenance: () => null }).paused).toBe(false);
  });
});
