import { describe, it, expect, vi } from 'vitest';
import { urgentSweep, createSweepDeps } from '../urgent-sweep.mjs';
import { removeRegistration } from '../../daemon-overlay.mjs';
import { resolveOperation } from '../run.mjs';

const sha = 'a'.repeat(40);
const load = { type: 'prototype-load.urgent', ref: 'lane/repair', sha, repo: 'https://example.com/org/repo', clone: '/clone',
  registration: { clone: '/clone', ref: 'lane/repair-m1', sha: 'b'.repeat(40) } };
const required = ['changes', 'test-shard', 'test'];
const check = (name, conclusion = 'success', extra = {}) => ({ id: 1, head_sha: sha, name, app: { id: 15368 }, status: 'completed', conclusion, ...extra });
function fixture(rows = required.map(n => check(n))) {
  const state = [], events = [], loads = [load];
  const d = { loads: () => loads, state: () => state, now: () => '2026-11-18T12:00:00Z', required: vi.fn(() => required),
    checks: vi.fn(() => ({ total_count: rows.length, check_runs: rows })), remove: vi.fn(() => ({ removed: true })),
    event: vi.fn(e => events.push(e)), settle: vi.fn(e => state.push(e)), escalate: vi.fn() };
  return { d, state, settlements: () => state.filter(r => r.status !== 'sweep-cursor'), events, loads, run: () => urgentSweep({}, d) };
}
describe('urgent CI sweep', () => {
  it.each(['failure', 'cancelled', 'timed_out'])('unloads required %s and escalates once across repeated passes', async conclusion => {
    const f = fixture([check('test-shard (1)', conclusion), check('test', null, { status: 'in_progress' })]);
    expect(await f.run()).toMatchObject({ ok: true, results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
    expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded', sha, clone: '/clone', registration: load.registration })]);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU'), status: 'open' }));
    await f.run(); expect(f.d.remove).toHaveBeenCalledTimes(1); expect(f.d.escalate).toHaveBeenCalledTimes(1);
  });
  it('settles all required green and never checks it again', async () => {
    const f = fixture(); await f.run(); await f.run();
    expect(f.settlements()[0].status).toBe('settled-green'); expect(f.d.checks).toHaveBeenCalledTimes(1); expect(f.d.remove).not.toHaveBeenCalled();
  });
  it.each([
    ['missing required checks', [check('test')]],
    ['pending', [check('test', null, { status: 'queued' })]],
    ['unrelated failure', [check('smoke', 'failure')]],
    ['foreign app', [check('test', 'failure', { app: { id: 1 } })]],
    ['one shard pending', [check('test-shard (1)'), check('test-shard (2)', null, { status: 'in_progress' }), check('changes'), check('test')]],
  ])('leaves %s unsettled', async (_, rows) => {
    const f = fixture(rows); expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled(); expect(f.d.escalate).not.toHaveBeenCalled();
  });
  it.each([
    ['oversized', { total_count: 101, check_runs: [] }], ['incomplete', { total_count: 2, check_runs: [check('test')] }],
    ['wrong sha', { total_count: 1, check_runs: [check('test', 'failure', { head_sha: 'c'.repeat(40) })] }],
    ['malformed', { total_count: 1, check_runs: [{}] }],
  ])('escalates %s evidence without unloading or settling', async (_, data) => {
    const f = fixture(); f.d.checks.mockReturnValue(data);
    expect(await f.run()).toMatchObject({ ok: false, fallback: expect.stringContaining('manually') });
    expect(f.d.escalate).toHaveBeenCalled(); expect(f.d.remove).not.toHaveBeenCalled(); expect(f.settlements()).toEqual([]);
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
    expect((await f.run()).ok).toBe(false); expect(f.events).toEqual([]); expect(f.settlements()).toEqual([]); expect(f.d.escalate).toHaveBeenCalled();
  });
  it('refuses an unsuccessful removal that still lists the overlay', async () => {
    const f = fixture([check('test', 'failure')]); f.d.remove.mockReturnValue({ removed: false, list: [{ ref: load.registration.ref }] });
    expect((await f.run()).ok).toBe(false); expect(f.events).toEqual([]); expect(f.settlements()).toEqual([]);
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
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(32); await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(33);
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
    expect(f.d.remove).toHaveBeenCalledTimes(1); expect(f.d.remove).toHaveBeenCalledWith(failing);
    expect(f.settlements()).toEqual([expect.objectContaining({ ref: failing.ref, status: 'settled-unloaded' })]);
  });
  it('honors legacy settlements without cursor records', async () => {
    const f = fixture(); await f.run();
    f.state.splice(0, f.state.length, ...f.settlements());
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(1); expect(f.settlements()).toHaveLength(1);
  });
  it('starts at the beginning if the cursor load was archived', async () => {
    const f = fixture(); f.state.push({ id: 'a'.repeat(64), status: 'sweep-cursor' });
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(1); expect(f.settlements()[0].status).toBe('settled-green');
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
  it('reads exact-SHA checks through the origin-bound throttled reader and guards the actual overlay tip', () => {
    const exec = vi.fn((cmd, args) => args[0] === 'remote' ? load.repo : 'workflow');
    const ghExec = vi.fn((cmd, args) => JSON.stringify(args[0] === 'repo'
      ? { nameWithOwner: 'org/repo', url: load.repo } : { total_count: 0, check_runs: [] }));
    const remove = vi.fn(() => ({ removed: true })), env = {};
    const deps = createSweepDeps({ exec, ghExec, remove, env });
    expect(deps.checks(load)).toEqual({ total_count: 0, check_runs: [] });
    expect(ghExec.mock.calls[1][1]).toEqual(['api', `repos/org/repo/commits/${sha}/check-runs?per_page=100`, '--hostname', 'example.com']);
    expect(ghExec.mock.calls.every(([, , o]) => o.maxBuffer === 1024 * 1024 && o.timeout === 30000 && o.throttle.caller === 'urgent-sweep')).toBe(true);
    deps.remove(load);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ root: '/clone', ref: 'lane/repair-m1', expectedTip: load.registration.sha, env }));
  });
  it('bounds ledgers before reading and uses the shared escalation packet writer', async () => {
    const io = { statSync: () => ({ size: 4 * 1024 * 1024 + 1 }), readFileSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() };
    const deps = createSweepDeps({ home: '/home/test', io });
    expect(await urgentSweep({}, deps)).toMatchObject({ ok: false, detail: expect.stringContaining('archive') });
    expect(io.readFileSync).not.toHaveBeenCalled();
    expect(io.renameSync).toHaveBeenCalledWith('/home/test/workspace/.operations/escalations/urgent-ledger.json.tmp', '/home/test/workspace/.operations/escalations/urgent-ledger.json');
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
