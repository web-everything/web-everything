import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { urgentSweep, createSweepDeps } from '../urgent-sweep.mjs';
import { removeRegistration } from '../../daemon-overlay.mjs';
import { resolveOperation } from '../run.mjs';

const sha = 'a'.repeat(40);
const load = { type: 'prototype-load.urgent', trackingId: 'first-load', at: '2026-11-18T12:00:00Z', ref: 'lane/repair', sha, repo: 'https://example.com/org/repo', clone: '/clone',
  registration: { clone: '/clone', ref: 'lane/repair-m1', sha: 'b'.repeat(40) } };
const workflows = { total_count: 1, workflow_runs: [{ check_suite_id: 7, head_sha: sha, path: '.github/workflows/ci.yml' }] };
const required = ['changes', 'test-shard', 'test'];
let checkId = 0;
const check = (name, conclusion = 'success', extra = {}) => ({ id: ++checkId, head_sha: sha, name, app: { id: 15368 }, check_suite: { id: 7 }, status: 'completed', conclusion, ...extra });
function fixture(rows = required.map(n => check(n))) {
  const state = [], events = [], loads = [load];
  const d = { loads: () => loads, state: () => state, now: () => '2026-11-18T12:00:00Z', required: vi.fn(() => required),
    containsOverlay: vi.fn(() => true), mergedOverlay: vi.fn(() => false),
    overlayState: vi.fn(() => ({ corrupt: false, overlays: loads.map(r => ({ ref: r.registration?.ref })) })),
    checks: vi.fn(() => ({ total_count: rows.length, check_runs: rows, workflows })), remove: vi.fn(() => ({ retired: true })),
    event: vi.fn(e => events.push(e)), settle: vi.fn(e => state.push(e)), escalate: vi.fn() };
  return { d, state, settlements: () => [...new Map(state.filter(r => r.status !== 'sweep-cursor').map(r => [r.id, r])).values()], events, loads, run: () => urgentSweep({}, d) };
}
describe('urgent CI sweep', () => {
  it('unloads a 17-day-old zero-check load, escalates once and tracks adoption', async () => {
    const f = fixture([]);
    f.loads[0] = { ...load, at: '2026-11-01T12:00:00Z' };
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(f.loads[0], { ref: load.registration.ref });
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', evidence: ['urgent load has no CI verdict after 6h'] }));
    expect(f.settlements()[0]).toMatchObject({ status: 'unloaded-pending-adoption', unloadReason: expect.stringContaining('no CI verdict after 24h') });
    await urgentSweep({}, { ...f.d });
    expect(f.d.remove).toHaveBeenCalledTimes(1);
    expect(f.d.escalate.mock.calls.filter(([p]) => p.evidence.includes('urgent load has no CI verdict after 6h'))).toHaveLength(1);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-adopted' }] });
  });
  it.each(['ci-failed', 'ci-expired'])('persists %s evidence before guarded removal', async reason => {
    const f = fixture(reason === 'ci-failed' ? [check('test', 'failure')] : []);
    if (reason === 'ci-expired') f.d.now = () => '2026-11-19T12:00:00Z';
    f.d.remove.mockImplementation(() => {
      expect(f.state.at(-1)).toMatchObject({ status: 'unload-decision', reason, trackingId: load.trackingId,
        clone: load.clone, sha: load.sha, registration: load.registration });
      if (reason === 'ci-failed') expect(f.state.at(-1).check).toMatchObject({ head_sha: sha, conclusion: 'failure' });
      return { retired: true };
    });
    expect((await f.run()).ok).toBe(true);
  });
  it('keeps the registration when persisting the unload decision fails', async () => {
    const f = fixture([check('test', 'failure')]);
    const settle = f.d.settle;
    f.d.settle = vi.fn(r => { if (r.status === 'unload-decision') throw new Error('ledger write failed'); return settle(r); });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.d.remove).not.toHaveBeenCalled();
  });
  it('escalates a 7h pending load once per tracking id and keeps it loaded', async () => {
    const f = fixture([check('test', null, { status: 'in_progress' })]);
    f.loads[0] = { ...load, at: '2026-11-18T05:00:00Z' };
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    await urgentSweep({}, { ...f.d });
    expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.d.escalate).toHaveBeenCalledTimes(1);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', evidence: ['urgent load has no CI verdict after 6h'] }));
    f.loads[0] = { ...f.loads[0], trackingId: 'reload' };
    await f.run();
    expect(f.d.escalate).toHaveBeenCalledTimes(2);
  });
  describe.each(['throws', 'incomplete', 'oversized', 'required-unreadable'])('unreadable CI timeout (%s)', kind => {
    function unreadable() {
      const f = fixture();
      if (kind === 'throws') f.d.checks.mockImplementation(() => { throw new Error('API unavailable'); });
      if (kind === 'incomplete') f.d.checks.mockReturnValue({ total_count: 1, check_runs: [] });
      if (kind === 'oversized') f.d.checks.mockReturnValue({ total_count: 101, check_runs: [] });
      if (kind === 'required-unreadable') f.d.required.mockImplementation(() => { throw new Error('workflow unavailable'); });
      return f;
    }
    it('unloads after 24h through removal and tracks adoption despite unreadable CI', async () => {
      const f = unreadable();
      f.d.now = () => '2026-11-19T12:00:00Z';
      expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
      expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
      expect(f.settlements()[0]).toMatchObject({ unloadReason: expect.stringContaining('after 24h') });
      await f.run();
      expect(f.d.remove).toHaveBeenCalledTimes(1);
    });
    it('escalates once after 6h across repeated API failures without unloading', async () => {
      const f = unreadable();
      f.d.now = () => '2026-11-18T18:00:00Z';
      expect(await f.run()).toMatchObject({ results: [{ status: 'needs-you' }] });
      await urgentSweep({}, { ...f.d });
      expect(f.d.escalate).toHaveBeenCalledTimes(1);
      expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ evidence: ['urgent load has no CI verdict after 6h'] }));
      expect(f.d.remove).not.toHaveBeenCalled();
    });
  });
  it('preserves a recorded green completion beyond 24h when CI becomes unreadable', async () => {
    const f = fixture();
    await f.run();
    f.d.now = () => '2026-11-19T13:00:00Z';
    f.d.checks.mockImplementation(() => { throw new Error('API unavailable'); });
    expect(await f.run()).toMatchObject({ results: [{ status: 'needs-you' }] });
    expect(f.d.remove).not.toHaveBeenCalled();
  });
  it.each(['pinned-closed-pr', 'edge-resolution-recorded', 'history-unreadable'])('raises NEEDS-YOU when guarded expiry retirement refuses a %s overlay', async reason => {
    const f = fixture();
    f.d.now = () => '2026-11-19T13:00:00Z';
    f.d.checks.mockImplementation(() => { throw new Error('API unavailable'); });
    f.d.remove.mockReturnValue({ retired: false, refused: 'not-proved', proof: { action: 'keep', reason } });
    expect(await f.run()).toMatchObject({ results: [{ status: 'needs-you', detail: 'overlay removal refused: not-proved' }] });
    expect(f.events).toEqual([]);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ evidence: ['overlay removal refused: not-proved'] }));
  });
  it.each(['bad', undefined, '2026-11-19T12:00:00Z'])('fails closed on missing or invalid load time %s', async at => {
    const f = fixture([]);
    f.loads[0] = { ...load, at };
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('timestamp') }] });
    expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ evidence: [expect.stringContaining('unload manually')] }));
  });
  it.each([
    ['before 6h', '2026-11-18T06:00:01Z', false, false],
    ['at 6h', '2026-11-18T06:00:00Z', true, false],
    ['before 24h', '2026-11-17T12:00:01Z', true, false],
    ['at 24h', '2026-11-17T12:00:00Z', true, true],
  ])('enforces verdict timeout boundary %s', async (_, at, alerted, removed) => {
    const f = fixture([]);
    f.loads[0] = { ...load, at };
    await f.run();
    expect(f.d.escalate.mock.calls.some(([p]) => p.evidence.includes('urgent load has no CI verdict after 6h'))).toBe(alerted);
    expect(f.d.remove.mock.calls.length > 0).toBe(removed);
  });
  describe.each([
    ['queued test', () => [check('changes'), check('test-shard'), check('test', null, { status: 'queued' })]],
    ['missing test', () => [check('changes'), check('test-shard')]],
    ['queued prerequisite', () => [check('changes'), check('test-shard', null, { status: 'queued' }), check('test')]],
    ['missing prerequisite', () => [check('changes'), check('test')]],
    ['skipped prerequisite', () => [check('changes'), check('test-shard', 'skipped'), check('test')]],
    ['unbound test', () => [check('changes'), check('test-shard'), check('test', 'success', { check_suite: { id: 8 } })]],
  ])('required result timeout with %s despite completed checks', (_, rows) => {
    it.each([
      [6 * 60 - 1, false, false],
      [6 * 60, true, false],
      [24 * 60 - 1, true, false],
      [24 * 60, true, true],
    ])('at %i minutes escalated=%s unloaded=%s', async (minutes, alerted, unloaded) => {
      const f = fixture([...rows(), check('unrelated')]);
      f.d.now = () => new Date(Date.parse(load.at) + minutes * 60 * 1000).toISOString();
      expect(await f.run()).toMatchObject({ results: [{ status: unloaded ? 'unloaded-pending-adoption' : 'pending' }] });
      expect(f.d.escalate.mock.calls.some(([p]) => p.evidence.includes('urgent load has no CI verdict after 6h'))).toBe(alerted);
      expect(f.d.remove).toHaveBeenCalledTimes(unloaded ? 1 : 0);
      if (unloaded) expect(f.settlements()[0]).toMatchObject({ unloadReason: expect.stringContaining('no CI verdict after 24h') });
    });
  });
  it('does not time out successful required results while an unrelated check remains queued', async () => {
    const f = fixture([...required.map(n => check(n)), check('unrelated', null, { status: 'queued' })]);
    f.d.now = () => new Date(Date.parse(load.at) + 24 * 60 * 60 * 1000).toISOString();
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.d.escalate).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', 'timed_out'])('unloads required %s and escalates once across repeated passes', async conclusion => {
    const f = fixture([check('test-shard (1)', conclusion), check('test', null, { status: 'in_progress' })]);
    expect(await f.run()).toMatchObject({ ok: true, results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
    expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded', sha, clone: '/clone', registration: load.registration })]);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU'), status: 'open' }));
    await f.run(); expect(f.d.remove).toHaveBeenCalledTimes(1); expect(f.d.escalate).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['event', 'unloadEventSent', 'escalate', 'unloadEscalationSent'],
    ['escalate', 'unloadEscalationSent', 'event', 'unloadEventSent'],
  ])('retries a failed unload %s on another sweep and preserves the other notification', async (sink, flag, other, otherFlag) => {
    const f = fixture([check('test', 'failure')]);
    f.d[sink].mockRejectedValueOnce(new Error(`${sink} unavailable`));
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('notifications incomplete') }] });
    expect(f.settlements()[0]).toMatchObject({ status: 'unloaded-pending-adoption', [flag]: false, [otherFlag]: true });
    expect(f.d[other]).toHaveBeenCalledTimes(1);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ ok: true, results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.settlements()[0]).toMatchObject({ [flag]: true, [otherFlag]: true });
    await f.run();
    expect(f.d[sink]).toHaveBeenCalledTimes(2);
    expect(f.d[other]).toHaveBeenCalledTimes(1);
    expect(f.d.remove).toHaveBeenCalledTimes(1);
    expect(f.d.checks).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded', at: '2026-11-18T12:00:00Z' })]);
  });
  it.each(['event', 'escalate'])('continues adoption while unload %s fails and retries after adoption', async sink => {
    const f = fixture([check('test', 'failure')]);
    f.d[sink].mockRejectedValueOnce(new Error('notification unavailable')).mockRejectedValueOnce(new Error('still unavailable'));
    await f.run();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()[0].status).toBe('unloaded-adopted');
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ ok: true, results: [{ status: 'unloaded-adopted' }] });
    expect(f.d[sink]).toHaveBeenCalledTimes(3);
    expect(f.d.containsOverlay).toHaveBeenCalledTimes(1);
    await f.run(); expect(f.d[sink]).toHaveBeenCalledTimes(3);
  });
  it.each(['unloadEventSent', 'unloadEscalationSent'])('retries notification after its %s checkpoint write fails', async flag => {
    const f = fixture([check('test', 'failure')]);
    let rejected = false;
    f.d.settle.mockImplementation(row => {
      if (!rejected && row[flag] === true) { rejected = true; throw new Error('checkpoint unavailable'); }
      f.state.push(row);
    });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()[0][flag]).toBe(false);
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ ok: true, results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.settlements()[0]).toMatchObject({ unloadEventSent: true, unloadEscalationSent: true });
    expect(f.d[flag === 'unloadEventSent' ? 'event' : 'escalate']).toHaveBeenCalledTimes(2);
    expect(f.d[flag === 'unloadEventSent' ? 'escalate' : 'event']).toHaveBeenCalledTimes(1);
    expect(f.d.remove).toHaveBeenCalledTimes(1);
  });
  it('retries missing notification progress from old pending receipts', async () => {
    const f = fixture([check('test', 'failure')]); await f.run();
    delete f.settlements()[0].unloadEventSent;
    delete f.settlements()[0].unloadEscalationSent;
    await f.run();
    expect(f.d.event).toHaveBeenCalledTimes(2);
    expect(f.d.escalate).toHaveBeenCalledTimes(2);
    expect(f.settlements()[0]).toMatchObject({ unloadEventSent: true, unloadEscalationSent: true });
  });
  it('keeps removal pending while clone HEAD still contains the failed overlay, without rechecking CI', async () => {
    const f = fixture([check('test', 'failure')]);
    await f.run();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.now = () => '2026-11-18T12:14:59Z';
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ ok: true, results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.containsOverlay).toHaveBeenCalledWith(load);
    expect(f.d.checks).toHaveBeenCalledTimes(1);
    expect(f.d.remove).toHaveBeenCalledTimes(1);
    expect(f.d.escalate).toHaveBeenCalledTimes(1);
    expect(f.settlements()).toEqual([expect.objectContaining({ status: 'unloaded-pending-adoption', removedAt: '2026-11-18T12:00:00Z' })]);
  });
  it('settles unloaded-adopted only when HEAD excludes the SHA and the registration is absent', async () => {
    const f = fixture([check('test', 'failure')]); await f.run();
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-adopted' }] });
    await f.run(); expect(f.d.containsOverlay).toHaveBeenCalledTimes(2);
    expect(f.d.remove).toHaveBeenCalledTimes(1);
  });
  it('raises fallback NEEDS-YOU once per tracking id after 15 minutes and checks adoption each later pass', async () => {
    const f = fixture([check('test', 'failure')]); await f.run();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.now = () => '2026-11-18T12:15:00Z';
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('last-good build containing the failed overlay') }] });
    const packet = f.d.escalate.mock.calls[1][0];
    expect(packet).toMatchObject({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') });
    expect(packet.id).not.toBe(f.d.escalate.mock.calls[0][0].id);
    f.d.now = () => '2026-11-18T12:20:00Z';
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.d.escalate).toHaveBeenCalledTimes(2);
    expect(f.d.containsOverlay).toHaveBeenCalledTimes(2);
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ ok: true, results: [{ status: 'unloaded-adopted' }] });
    f.loads[0] = { ...load, trackingId: 'reload' };
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: load.registration.ref }] });
    await f.run();
    f.d.containsOverlay.mockReturnValue(true);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.now = () => '2026-11-18T12:35:00Z';
    await f.run(); expect(f.d.escalate).toHaveBeenCalledTimes(4);
    expect(f.d.escalate.mock.calls[3][0].id).not.toBe(packet.id);
  });
  it.each([null, undefined, 'false', new Error('git failed')])('keeps unknown ancestry tracked and escalates (%s)', async evidence => {
    const f = fixture([check('test', 'failure')]); await f.run();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.containsOverlay.mockImplementation(() => { if (evidence instanceof Error) throw evidence; return evidence; });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()).toHaveLength(1);
    expect(f.settlements()[0].status).toBe('unloaded-pending-adoption');
    expect(f.d.escalate).toHaveBeenCalledTimes(2);
  });
  it('rechecks legacy settled-unloaded receipts for adoption', async () => {
    const f = fixture([check('test', 'failure')]); await f.run();
    f.settlements()[0].status = 'settled-unloaded'; delete f.settlements()[0].removedAt;
    delete f.settlements()[0].unloadEventSent; delete f.settlements()[0].unloadEscalationSent;
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-adopted' }] });
    expect(await f.run()).toMatchObject({ results: [] });
    expect(f.d.event).toHaveBeenCalledTimes(1);
    expect(f.d.escalate).toHaveBeenCalledTimes(1);
  });
  it('escalates an unreadable removal timestamp without declaring adoption', async () => {
    const f = fixture([check('test', 'failure')]); await f.run();
    f.settlements()[0].removedAt = 'bad';
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.d.containsOverlay).not.toHaveBeenCalled();
    expect(f.settlements()).toHaveLength(1);
  });
  it('rechecks green beyond 24 hours until absent registration and HEAD exclusion are proven', async () => {
    const f = fixture(); await f.run();
    expect(f.settlements()[0].status).toBe('monitoring-green');
    f.d.now = () => '2026-11-25T12:00:00Z';
    await f.run(); await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(3);
    expect(f.settlements()).toHaveLength(1);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: 'lane/other' }] });
    f.d.containsOverlay.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unregistered' }] });
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(3);
    expect(f.d.overlayState).toHaveBeenCalledTimes(4);
    expect(f.d.remove).not.toHaveBeenCalled();
  });
  it('tracks absent registration with unmerged code in HEAD and escalates once after 15 minutes per tracking ID', async () => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    expect(await f.run()).toMatchObject({ ok: true, results: [{ status: 'monitoring-unregistered' }] });
    f.d.now = () => '2026-11-18T12:14:59Z';
    await urgentSweep({}, { ...f.d });
    expect(f.d.escalate).not.toHaveBeenCalled();
    f.d.now = () => '2026-11-18T12:15:00Z';
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('unmerged urgent overlay') }] });
    await urgentSweep({}, { ...f.d });
    expect(f.d.escalate).toHaveBeenCalledTimes(1);
    expect(f.d.checks).toHaveBeenCalledTimes(4);
    expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.settlements()[0]).toMatchObject({ status: 'monitoring-unregistered', at: '2026-11-18T12:00:00Z', fallbackEscalated: true });
    f.loads[0] = { ...load, trackingId: 'reload' };
    await f.run();
    f.d.now = () => '2026-11-18T12:30:00Z';
    await f.run();
    expect(f.d.escalate).toHaveBeenCalledTimes(2);
    expect(f.d.escalate.mock.calls[0][0].id).not.toBe(f.d.escalate.mock.calls[1][0].id);
  });
  it.each(['excluded from HEAD', 'merged into main'])('settles absent registration only when code is %s', async proof => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    await f.run();
    f.d.containsOverlay.mockReturnValue(proof !== 'excluded from HEAD');
    f.d.mergedOverlay.mockReturnValue(proof === 'merged into main');
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unregistered' }] });
    expect(f.settlements()[0]).toMatchObject({ ancestryVerified: true });
    expect(await f.run()).toMatchObject({ results: [] });
    expect(f.d.checks).toHaveBeenCalledTimes(1);
    expect(f.d.mergedOverlay).toHaveBeenCalledTimes(proof === 'merged into main' ? 2 : 1);
  });
  it('rechecks legacy unregistered settlements without ancestry proof', async () => {
    const f = fixture(); await f.run();
    f.settlements()[0].status = 'settled-unregistered';
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'monitoring-unregistered' }] });
    expect(f.d.checks).toHaveBeenCalledTimes(2);
  });
  it('checks later CI failures for absent registrations and escalates immediately without a no-op unload', async () => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    await f.run();
    f.d.checks.mockReturnValue({ check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('CI failed and unloading is a no-op') }] });
    await f.run();
    expect(f.d.checks).toHaveBeenCalledTimes(3);
    expect(f.d.escalate).toHaveBeenCalledTimes(1);
    expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.settlements()[0].status).toBe('monitoring-unregistered');
  });
  it.each(['containsOverlay', 'mergedOverlay'])('keeps absent registration tracked on unknown %s evidence', async reader => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d[reader].mockReturnValue(undefined);
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()).toEqual([]);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ question: expect.stringContaining('NEEDS-YOU') }));
    f.d[reader].mockReturnValue(true);
    expect((await f.run()).ok).toBe(true);
  });
  it.each([undefined, { total_count: 101, check_runs: [] }, { total_count: 1, check_runs: [] }])('escalates unreadable or oversized absent-registration CI evidence (%j)', async data => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.checks.mockReturnValue(data);
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()[0].status).toBe('monitoring-unregistered');
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ question: expect.stringContaining('NEEDS-YOU') }));
  });
  it.each(['bad', '2026-11-18T11:59:59Z'])('escalates unreadable or backwards absent-registration time (%s)', async now => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    await f.run();
    f.d.now = () => now;
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: expect.stringContaining('timestamp') }] });
    expect(f.settlements()[0].status).toBe('monitoring-unregistered');
  });
  it('keeps absent registration tracked when CI is unreadable', async () => {
    const f = fixture();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [] });
    f.d.checks.mockRejectedValue(new Error('CI unavailable'));
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()[0].status).toBe('monitoring-unregistered');
  });
  it('unloads a failing same-SHA rerun more than 24 hours after persisted green', async () => {
    const f = fixture(); await f.run();
    f.d.now = () => '2026-11-25T12:00:00Z';
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you' }));
  });
  it.each(['settled-unloaded', 'unloaded-pending-adoption', 'unloaded-adopted', 'settled-unregistered', 'monitoring-green'])('starts fresh for a reload with a new trackingId after %s', async status => {
    const f = fixture(); await f.run();
    const first = f.settlements()[0]; first.status = status;
    f.loads[0] = { ...load, trackingId: 'reload' };
    f.d.now = () => '2026-11-25T12:00:00Z';
    expect(await f.run()).toMatchObject({ results: [{ status: 'monitoring-green' }] });
    expect(f.d.checks).toHaveBeenCalledTimes(2);
    expect(f.settlements().at(-1)).toMatchObject({ greenAt: f.d.now(), status: 'monitoring-green' });
    expect(f.settlements().at(-1).id).not.toBe(first.id);
  });
  it('rechecks historical time-complete green receipts while still registered', async () => {
    const f = fixture(); await f.run();
    Object.assign(f.settlements()[0], { status: 'settled-green', monitoringComplete: true,
      greenAt: '2026-11-16T12:00:00Z', at: '2026-11-18T12:00:00Z' });
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('smoke', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
  });
  it('rechecks pre-trackingId identity receipts instead of inheriting their settlement', async () => {
    const f = fixture([check('smoke', 'failure')]);
    const id = createHash('sha256').update(JSON.stringify([load.ref, load.sha, load.clone, load.registration])).digest('hex');
    f.state.push({ id, status: 'settled-green', monitoringComplete: true,
      greenAt: '2026-11-16T12:00:00Z', at: '2026-11-18T12:00:00Z' });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
  });
  it.each([null, { corrupt: true, overlays: [] }, { corrupt: false, overlays: [{}] }])('keeps unreadable overlay state tracked and escalates (%j)', async overlay => {
    const f = fixture(); f.d.overlayState.mockReturnValue(overlay);
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }], fallback: expect.stringContaining('manually') });
    expect(f.settlements()).toEqual([]); expect(f.d.checks).not.toHaveBeenCalled();
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: load.registration.ref }] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'monitoring-green' }] });
  });
  it('unloads any failing check before attempting an unreadable required-job parse', async () => {
    const f = fixture([check('smoke', 'failure', { app: { id: 1 } })]);
    f.d.required.mockImplementation(() => { throw new Error('workflow parse failed'); });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.required).not.toHaveBeenCalled(); expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you' }));
  });
  it('never settles green on unreadable required jobs and retries next pass', async () => {
    const f = fixture(); f.d.required.mockImplementation(() => { throw new Error('workflow parse failed'); });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled();
    f.d.required.mockReturnValue(required);
    expect(await f.run()).toMatchObject({ results: [{ status: 'monitoring-green' }] });
    expect(f.d.checks).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['missing suite', undefined, { check_suite: undefined }],
    ['foreign workflow', { total_count: 1, workflow_runs: [{ ...workflows.workflow_runs[0], path: '.github/workflows/other.yml' }] }],
    ['wrong suite', { total_count: 1, workflow_runs: [{ ...workflows.workflow_runs[0], check_suite_id: 8 }] }],
    ['wrong SHA', { total_count: 1, workflow_runs: [{ ...workflows.workflow_runs[0], head_sha: 'b'.repeat(40) }] }],
    ['unavailable workflow', null],
    ['incomplete workflows', { ...workflows, total_count: 2 }],
    ['oversized workflows', { total_count: 101, workflow_runs: Array.from({ length: 101 }, () => workflows.workflow_runs[0]) }],
  ])('keeps otherwise green %s evidence unsettled', async (_, runs, extra = {}) => {
    const f = fixture();
    f.d.checks.mockReturnValue({ total_count: required.length, check_runs: required.map(n => check(n, 'success', extra)), workflows: runs });
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled();
  });
  it('binds test to the configured workflow path', async () => {
    const f = fixture();
    f.d.checks.mockReturnValue({ total_count: required.length, check_runs: required.map(n => check(n)), workflows,
      testWorkflowPath: '.github/workflows/custom.yml' });
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
  });
  it('ignores a failed registration intent without cancelling a later attempt', async () => {
    const f = fixture([check('test', 'failure')]);
    f.loads[0] = { ...load, trackingId: 'failed-attempt' };
    f.loads.push({ ...f.loads[0], type: 'prototype-load.urgent-registration-failed', status: 'registration-failed' });
    f.d.overlayState.mockReturnValueOnce({ corrupt: false, overlays: [] });
    expect(await f.run()).toMatchObject({ results: [] });
    expect(f.d.checks).not.toHaveBeenCalled();
    const retry = { ...load, trackingId: 'retry', registration: { ...load.registration, ref: 'lane/retry' } };
    f.loads.push(retry);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: retry.registration.ref }] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledTimes(1);
    expect(f.d.remove).toHaveBeenCalledWith(retry, { ref: retry.registration.ref });
  });
  it('keeps monitoring a registration-failed intent when its overlay is present and unloads on CI failure', async () => {
    const f = fixture();
    f.loads.push({ ...load, type: 'prototype-load.urgent-registration-failed', status: 'registration-failed' });
    expect(await f.run()).toMatchObject({ results: [{ status: 'monitoring-green' }] });
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
  });
  it.each(['corrupt', 'throws'])('keeps a registration-failed intent tracked when the overlay read %s', async kind => {
    const f = fixture([check('test', 'failure')]);
    f.loads.push({ ...load, type: 'prototype-load.urgent-registration-failed', status: 'registration-failed' });
    if (kind === 'throws') f.d.overlayState.mockImplementationOnce(() => { throw new Error('store unreadable'); });
    else f.d.overlayState.mockReturnValueOnce({ corrupt: true, overlays: [] });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }], fallback: expect.stringContaining('manually') });
    expect(f.settlements()).toEqual([]);
    expect(f.d.checks).not.toHaveBeenCalled();
    expect(f.d.escalate).toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
  });
  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])('unloads and raises NEEDS-YOU for completed smoke %s from any app', async conclusion => {
    for (const appId of [15368, 1]) {
      const f = fixture([...required.map(n => check(n)), check('smoke', conclusion, { app: { id: appId } })]);
      expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
      expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
      expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded' })]);
      expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') }));
    }
  });
  it('unloads and raises NEEDS-YOU when required CI fails after required green with another run pending', async () => {
    const f = fixture([...required.map(n => check(n)), check('smoke', null, { status: 'in_progress' })]);
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled();
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') }));
  });
  it.each([true, false])('rechecks persisted legacy green (checksComplete=%s) and unloads later failure', async checksComplete => {
    const f = fixture(); await f.run();
    Object.assign(f.settlements()[0], { status: 'settled-green', checksComplete });
    delete f.settlements()[0].greenAt;
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
  });
  it.each([
    ['unrelated queued check', [...required.map(n => check(n)), check('smoke', null, { status: 'queued' })]],
    ['unrelated running check', [...required.map(n => check(n)), check('smoke', null, { status: 'in_progress' })]],
    ['missing required checks', [check('test')]],
    ['pending', [check('test', null, { status: 'queued' })]],
    ['foreign app success cannot satisfy required test', [check('test', 'success', { app: { id: 1 } })]],
    ['one shard pending', [check('test-shard (1)'), check('test-shard (2)', null, { status: 'in_progress' }), check('changes'), check('test')]],
  ])('leaves %s unsettled', async (_, rows) => {
    const f = fixture(rows); expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled(); expect(f.d.escalate).not.toHaveBeenCalled();
  });
  it.each([
    ['oversized', { total_count: 101, check_runs: [] }], ['incomplete', { total_count: 2, check_runs: [check('test')] }],
    ['wrong sha', { total_count: 1, check_runs: [check('test', 'failure', { head_sha: 'c'.repeat(40) })] }],
    ['pagination gap', { total_count: 3, check_runs: [check('test', 'success', { id: 1 }), check('test', 'success', { id: 1 }), check('changes')] }],
    ['malformed', { total_count: 1, check_runs: [{}] }],
  ])('escalates %s evidence without unloading or settling', async (_, data) => {
    const f = fixture(); f.d.checks.mockReturnValue(data);
    expect(await f.run()).toMatchObject({ ok: false, fallback: expect.stringContaining('manually') });
    expect(f.d.escalate).toHaveBeenCalled(); expect(f.d.remove).not.toHaveBeenCalled(); expect(f.settlements()).toEqual([]);
  });
  it.each([
    ['oversized', { total_count: 101, check_runs: [check('test', 'failure')] }],
    ['incomplete', { total_count: 2, check_runs: [check('test', 'failure')] }],
    ['missing count', { check_runs: [check('test', 'failure')] }],
    ['malformed row', { total_count: 2, check_runs: [null, check('smoke', 'failure', { app: undefined, id: undefined })] }],
    ['duplicate IDs', { total_count: 2, check_runs: [check('test', 'success', { id: 1 }), check('test', 'failure', { id: 1 })] }],
  ])('unloads before escalating %s evidence containing an explicit exact-SHA failure', async (_, data) => {
    const f = fixture(); f.d.checks.mockReturnValue(data);
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load, { ref: load.registration.ref });
    expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded' })]);
    expect(f.settlements()).toEqual([expect.objectContaining({ status: 'unloaded-pending-adoption' })]);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') }));
    expect(f.d.remove.mock.invocationCallOrder[0]).toBeLessThan(f.d.escalate.mock.invocationCallOrder[0]);
    expect(f.d.required).not.toHaveBeenCalled();
  });
  it.each([
    ['foreign SHA', check('test', 'failure', { head_sha: 'c'.repeat(40) })],
    ['unfinished failure', check('test', 'failure', { status: 'in_progress' })],
  ])('keeps incomplete evidence with %s unsettled', async (_, row) => {
    const f = fixture(); f.d.checks.mockReturnValue({ total_count: 2, check_runs: [row] });
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you' }] });
    expect(f.d.remove).not.toHaveBeenCalled(); expect(f.settlements()).toEqual([]);
  });
  it.each(['required', 'checks'])('escalates an unreadable %s reader', async step => {
    const f = fixture(); f.d[step].mockImplementation(() => { throw new Error('unreadable'); });
    expect((await f.run()).ok).toBe(false); expect(f.d.escalate).toHaveBeenCalled(); expect(f.settlements()).toEqual([]);
  });
  it('retains legacy loads without clone registration for operator recovery', async () => {
    const f = fixture(); f.loads[0] = { type: load.type, ref: load.ref, sha };
    expect((await f.run()).ok).toBe(false); expect(f.d.escalate).toHaveBeenCalled(); expect(f.d.checks).not.toHaveBeenCalled();
  });
  it('does not settle or emit unloaded when the expected-tip guard refuses', async () => {
    const f = fixture([check('test', 'failure')]); f.d.remove.mockReturnValue({ removed: false, refused: 'tip-moved' });
    expect((await f.run()).ok).toBe(false); expect(f.events).toEqual([]); expect(f.settlements()).toEqual([expect.objectContaining({ status: 'unload-decision', reason: 'ci-failed' })]); expect(f.d.escalate).toHaveBeenCalled();
  });
  it('refuses an unsuccessful removal that still lists the overlay', async () => {
    const f = fixture([check('test', 'failure')]); f.d.remove.mockReturnValue({ removed: false, list: [{ ref: load.registration.ref }] });
    expect((await f.run()).ok).toBe(false); expect(f.events).toEqual([]); expect(f.settlements()).toEqual([expect.objectContaining({ status: 'unload-decision', reason: 'ci-failed' })]);
  });
  it('escalates an unknown persisted settlement status before reading CI', async () => {
    const f = fixture(); f.state.push({ id: 'a'.repeat(64), status: 'pending' });
    expect((await f.run()).ok).toBe(false); expect(f.d.checks).not.toHaveBeenCalled(); expect(f.d.escalate).toHaveBeenCalled();
  });
  it('deduplicates identical records but processes separate clones', async () => {
    const f = fixture([check('test', 'failure')]);
    f.loads.push(load, { ...load, clone: '/other', registration: { ...load.registration, clone: '/other' } });
    await f.run(); expect(f.d.remove).toHaveBeenCalledTimes(2);
  });
  it('bounds work to 32 loads per pass, deferring remaining loads to the orchestrator', async () => {
    const f = fixture(); f.loads.splice(0, 1, ...Array.from({ length: 33 }, (_, i) => ({ ...load, ref: `lane/ref-${i}` })));
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(32); await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(64);
  });
  it.each(['pending', 'needs-you'])('persistently %s first 32 loads cannot starve a later CI failure across passes', async status => {
    const f = fixture();
    f.loads.splice(0, 1, ...Array.from({ length: 33 }, (_, i) => ({ ...load, ref: `lane/ref-${i}`,
      registration: { ...load.registration, ref: `lane/ref-${i}` } })));
    const failing = f.loads[32];
    f.d.checks.mockImplementation(r => {
      if (r === failing) return { total_count: 1, check_runs: [check('test', 'failure')] };
      if (status === 'needs-you') throw new Error('reader needs operator repair');
      return { total_count: 1, check_runs: [check('test', null, { status: 'in_progress' })] };
    });
    const first = await f.run();
    expect(first.results).toHaveLength(32); expect(first.results.every(r => r.status === status)).toBe(true);
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled();
    expect(f.state).toEqual([expect.objectContaining({ status: 'sweep-cursor' })]);
    // A fresh invocation resumes only from persisted state, even when none of the first batch settled.
    const second = await urgentSweep({}, { ...f.d });
    expect(second.results).toHaveLength(32);
    expect(f.d.checks.mock.calls[32][0]).toBe(failing);
    expect(f.d.remove).toHaveBeenCalledTimes(1); expect(f.d.remove).toHaveBeenCalledWith(failing, { ref: failing.registration.ref });
    expect(f.settlements()).toEqual([expect.objectContaining({ ref: failing.ref, status: 'unloaded-pending-adoption' })]);
  });
  it('resumes green monitoring without cursor records', async () => {
    const f = fixture(); await f.run();
    f.state.splice(0, f.state.length, ...f.settlements());
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(2); expect(f.settlements()).toHaveLength(1);
  });
  it('starts at the beginning if the cursor load was archived', async () => {
    const f = fixture(); f.state.push({ id: 'a'.repeat(64), status: 'sweep-cursor' });
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(1); expect(f.settlements()[0].status).toBe('monitoring-green');
  });
  it('escalates a malformed persisted cursor before reading CI', async () => {
    const f = fixture(); f.state.push({ id: 'bad', status: 'sweep-cursor' });
    expect((await f.run()).ok).toBe(false); expect(f.d.checks).not.toHaveBeenCalled(); expect(f.d.escalate).toHaveBeenCalled();
  });
  it('registers the operation with an injectable effect sink', () => {
    const op = resolveOperation('urgent-sweep'); expect(op.declaration.input).toEqual({}); expect(op.sinks['urgent-sweep.run']).toBeTypeOf('function');
  });
});

describe('production sweep storage and removal guards', () => {
  it.each([0, 1, 128, '1', undefined])('reads clone HEAD ancestry with bounded injectable Git IO (exit %s)', status => {
    const exec = vi.fn(() => { if (status !== 0) throw Object.assign(new Error('git failed'), { status }); return ''; });
    const env = {}, deps = createSweepDeps({ exec, env });
    if (status === 0 || status === 1) expect(deps.containsOverlay(load)).toBe(status === 0);
    else expect(() => deps.containsOverlay(load)).toThrow('unreadable clone HEAD ancestry');
    expect(exec).toHaveBeenCalledWith('git', ['merge-base', '--is-ancestor', sha, 'HEAD'],
      { cwd: load.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  });
  it.each([0, 1, 128, '1', undefined])('reads fresh main ancestry with bounded injectable Git IO (exit %s)', status => {
    const exec = vi.fn((cmd, args) => {
      if (args[0] === 'merge-base' && status !== 0) throw Object.assign(new Error('git failed'), { status });
      return '';
    });
    const env = {}, deps = createSweepDeps({ exec, env });
    if (status === 0 || status === 1) expect(deps.mergedOverlay(load)).toBe(status === 0);
    else expect(() => deps.mergedOverlay(load)).toThrow('unreadable origin/main ancestry');
    const options = { cwd: load.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };
    expect(exec.mock.calls).toEqual([
      ['git', ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], options],
      ['git', ['merge-base', '--is-ancestor', sha, 'origin/main'], options],
    ]);
  });
  it('refuses stale main evidence when fetching fails, including exit 1', () => {
    const exec = vi.fn(() => { throw Object.assign(new Error('offline'), { status: 1 }); });
    expect(() => createSweepDeps({ exec }).mergedOverlay(load)).toThrow('unreadable origin/main fetch');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('reads exact-SHA checks and recovers drops before retiring the loaded overlay tip and snapshot', async () => {
    const exec = vi.fn((cmd, args) => args[0] === 'remote' ? load.repo : 'workflow');
    const ghExec = vi.fn((cmd, args) => JSON.stringify(args[0] === 'repo'
      ? { nameWithOwner: 'org/repo', url: load.repo } : args[1].includes('/actions/runs') ? workflows : { total_count: 0, check_runs: [] }));
    const retire = vi.fn(() => ({ retired: true })), recover = vi.fn(() => ({ pending: [] })), env = {};
    const io = { statSync: () => ({ size: 1024 }), readFileSync: p => {
      if (p.endsWith('/coordination/urgent-loads.jsonl')) return `${JSON.stringify(load)}\n`;
      if (p.endsWith('prototype-load.json')) return JSON.stringify({ testWorkflowPath: '.github/workflows/custom.yml' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } };
    const readState = vi.fn(() => ({ corrupt: false, overlays: [{ ref: load.registration.ref }] }));
    const deps = createSweepDeps({ exec, ghExec, retire, recover, readState, env, io });
    expect(deps.overlayState(load)).toEqual({ corrupt: false, overlays: [{ ref: load.registration.ref }] });
    expect(readState).toHaveBeenCalledWith(load.clone, { env });
    expect(deps.checks(load)).toEqual({ total_count: 0, check_runs: [], workflows, testWorkflowPath: '.github/workflows/custom.yml' });
    expect(ghExec.mock.calls[2][1]).toEqual(['api', `repos/org/repo/actions/runs?head_sha=${sha}&per_page=100`, '--hostname', 'example.com']);
    expect(ghExec.mock.calls[1][1]).toEqual(['api', `repos/org/repo/commits/${sha}/check-runs?per_page=100&filter=all`, '--hostname', 'example.com']);
    expect(ghExec.mock.calls.every(([, , o]) => o.maxBuffer === 1024 * 1024 && o.timeout === 30000 && o.throttle.caller === 'urgent-sweep')).toBe(true);
    const entry = { ref: load.registration.ref, addedAt: 'original-load', pinned: true };
    await deps.remove(load, entry);
    await deps.remove(load, entry);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledWith({ root: load.clone, by: 'urgent-sweep', env });
    expect(recover.mock.invocationCallOrder[0]).toBeLessThan(retire.mock.invocationCallOrder[0]);
    expect(recover.mock.invocationCallOrder[1]).toBeLessThan(retire.mock.invocationCallOrder[1]);
    expect(retire).toHaveBeenCalledWith({ root: load.clone, ref: load.registration.ref,
      expectedTip: load.registration.sha, expectedEntry: entry, mode: 'urgent-failed', trackingId: load.trackingId,
      by: 'urgent-sweep', env, deps: { readUrgentLoads: expect.any(Function), readUrgentDecisions: expect.any(Function) } });
    expect(retire.mock.calls[0][0].deps.readUrgentLoads()).toEqual([load]);
    expect(retire.mock.calls[0][0].deps.readUrgentDecisions()).toEqual([]);
  });
  it('refuses oversized unload-decision storage with an archive fallback', async () => {
    const retire = vi.fn(async args => {
      expect(() => args.deps.readUrgentDecisions()).toThrow('ledger exceeds 4 MiB; archive settled records and retry');
      return { retired: false, refused: 'urgent-decision-unreadable' };
    });
    const deps = createSweepDeps({ retire, recover: () => ({ pending: [] }),
      io: { statSync: () => ({ size: 4 * 1024 * 1024 + 1 }) } });
    expect(await deps.remove(load, { ref: load.registration.ref })).toMatchObject({ retired: false });
    expect(retire).toHaveBeenCalledTimes(1);
  });
  it('retrieves failures before the production workflow and required-job readers', async () => {
    const exec = vi.fn((cmd, args) => {
      if (args[0] === 'show') throw new Error('workflow unavailable');
      return load.repo;
    });
    const ghExec = vi.fn((cmd, args) => {
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo', url: load.repo });
      if (args[1].includes('/actions/runs')) throw new Error('workflow unavailable');
      return JSON.stringify({ total_count: 1, check_runs: [check('test', 'failure')] });
    });
    const io = { readFileSync: p => {
      if (p.endsWith('prototype-load.json')) return '{}';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } };
    const production = createSweepDeps({ exec, ghExec, io });
    const data = production.checks(load);
    expect(data.workflows).toBeUndefined();
    expect(ghExec.mock.calls.some(([, args]) => args[1]?.includes('/actions/runs'))).toBe(false);
    const f = fixture(); f.d.checks.mockReturnValue(data);
    f.d.required = vi.fn(production.required);
    expect(await f.run()).toMatchObject({ results: [{ status: 'unloaded-pending-adoption' }] });
    expect(f.d.escalate).toHaveBeenCalled(); expect(f.d.required).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args[0] === 'show')).toBe(false);
  });
  it('bounds ledgers before reading and uses the shared escalation packet writer', async () => {
    const io = { statSync: () => ({ size: 4 * 1024 * 1024 + 1 }), readFileSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() };
    const deps = createSweepDeps({ home: '/home/test', io });
    expect(await urgentSweep({}, deps)).toMatchObject({ ok: false, detail: expect.stringContaining('archive') });
    expect(io.readFileSync).not.toHaveBeenCalled();
    expect(io.renameSync).toHaveBeenCalledWith('/home/test/workspace/.operations/escalations/urgent-ledger.json.tmp', '/home/test/workspace/.operations/escalations/urgent-ledger.json');
  });
  it.each([undefined, { pending: [{}] }, {}])('refuses removal on incomplete recovery (%j)', async recovery => {
    const retire = vi.fn(), recover = vi.fn(() => recovery);
    const deps = createSweepDeps({ retire, recover });
    await expect(deps.remove(load, { ref: load.registration.ref })).rejects.toThrow('recover-drops');
    expect(retire).not.toHaveBeenCalled();
  });
  it('escalates recovery failures without recording an unload or invoking retire', async () => {
    const retire = vi.fn(), recover = vi.fn(() => { throw new Error('corrupt drop intent'); });
    const f = fixture([check('test', 'failure')]);
    f.d.remove = createSweepDeps({ retire, recover }).remove;
    expect(await f.run()).toMatchObject({ ok: false, results: [{ status: 'needs-you', detail: 'corrupt drop intent' }] });
    expect(retire).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.settlements()).toEqual([expect.objectContaining({ status: 'unload-decision', reason: 'ci-failed' })]);
  });
  it('rejects a moved or unreadable tip before mutation', () => {
    const remove = vi.fn();
    const result = removeRegistration({ root: '/clone', ref: load.ref, expectedTip: sha, reason: 'CI failed',
      deps: { readState: () => ({ overlays: [{ ref: load.ref }] }), tip: () => 'b'.repeat(40), remove } });
    expect(result.refused).toBe('tip-moved-or-unreadable'); expect(remove).not.toHaveBeenCalled();
  });
  it('restores a removal if the branch moves during the drop', () => {
    const entry = { ref: load.ref }, restore = vi.fn();
    const result = removeRegistration({ root: '/clone', ref: load.ref, expectedTip: sha, reason: 'CI failed', deps: {
      readState: () => ({ overlays: [entry] }), tip: vi.fn().mockReturnValueOnce(sha).mockReturnValueOnce('b'.repeat(40)),
      remove: () => ({ removed: true }), restore,
    } });
    expect(result.refused).toBe('tip-moved-restored'); expect(restore).toHaveBeenCalledWith('/clone', entry, process.env);
  });
});
