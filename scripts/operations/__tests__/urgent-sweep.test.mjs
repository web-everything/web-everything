import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { urgentSweep, createSweepDeps } from '../urgent-sweep.mjs';
import { removeRegistration } from '../../daemon-overlay.mjs';
import { resolveOperation } from '../run.mjs';

const sha = 'a'.repeat(40);
const load = { type: 'prototype-load.urgent', trackingId: 'first-load', ref: 'lane/repair', sha, repo: 'https://example.com/org/repo', clone: '/clone',
  registration: { clone: '/clone', ref: 'lane/repair-m1', sha: 'b'.repeat(40) } };
const workflows = { total_count: 1, workflow_runs: [{ check_suite_id: 7, head_sha: sha, path: '.github/workflows/ci.yml' }] };
const required = ['changes', 'test-shard', 'test'];
let checkId = 0;
const check = (name, conclusion = 'success', extra = {}) => ({ id: ++checkId, head_sha: sha, name, app: { id: 15368 }, check_suite: { id: 7 }, status: 'completed', conclusion, ...extra });
function fixture(rows = required.map(n => check(n))) {
  const state = [], events = [], loads = [load];
  const d = { loads: () => loads, state: () => state, now: () => '2026-11-18T12:00:00Z', required: vi.fn(() => required),
    overlayState: vi.fn(() => ({ corrupt: false, overlays: loads.map(r => ({ ref: r.registration?.ref })) })),
    checks: vi.fn(() => ({ total_count: rows.length, check_runs: rows, workflows })), remove: vi.fn(() => ({ removed: true })),
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
  it('rechecks green on every pass beyond 24 hours until the overlay is unregistered', async () => {
    const f = fixture(); await f.run();
    expect(f.settlements()[0].status).toBe('monitoring-green');
    f.d.now = () => '2026-11-25T12:00:00Z';
    await f.run(); await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(3);
    expect(f.settlements()).toHaveLength(1);
    f.d.overlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: 'lane/other' }] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unregistered' }] });
    await f.run(); expect(f.d.checks).toHaveBeenCalledTimes(3);
    expect(f.d.overlayState).toHaveBeenCalledTimes(4);
    expect(f.d.remove).not.toHaveBeenCalled();
  });
  it('unloads a failing same-SHA rerun more than 24 hours after persisted green', async () => {
    const f = fixture(); await f.run();
    f.d.now = () => '2026-11-25T12:00:00Z';
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await urgentSweep({}, { ...f.d })).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you' }));
  });
  it.each(['settled-unloaded', 'settled-unregistered', 'monitoring-green'])('starts fresh for a reload with a new trackingId after %s', async status => {
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
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
  });
  it('rechecks pre-trackingId identity receipts instead of inheriting their settlement', async () => {
    const f = fixture([check('smoke', 'failure')]);
    const id = createHash('sha256').update(JSON.stringify([load.ref, load.sha, load.clone, load.registration])).digest('hex');
    f.state.push({ id, status: 'settled-green', monitoringComplete: true,
      greenAt: '2026-11-16T12:00:00Z', at: '2026-11-18T12:00:00Z' });
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
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
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.required).not.toHaveBeenCalled(); expect(f.d.remove).toHaveBeenCalledWith(load);
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
    expect(await f.run()).toMatchObject({ results: [] });
    expect(f.d.checks).not.toHaveBeenCalled();
    f.loads.push({ ...load, trackingId: 'retry' });
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
  });
  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])('unloads and raises NEEDS-YOU for completed smoke %s from any app', async conclusion => {
    for (const appId of [15368, 1]) {
      const f = fixture([...required.map(n => check(n)), check('smoke', conclusion, { app: { id: appId } })]);
      expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
      expect(f.d.remove).toHaveBeenCalledWith(load);
      expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded' })]);
      expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') }));
    }
  });
  it('unloads and raises NEEDS-YOU when required CI fails after required green with another run pending', async () => {
    const f = fixture([...required.map(n => check(n)), check('smoke', null, { status: 'in_progress' })]);
    expect(await f.run()).toMatchObject({ results: [{ status: 'pending' }] });
    expect(f.settlements()).toEqual([]); expect(f.d.remove).not.toHaveBeenCalled();
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
    expect(f.d.escalate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'needs-you', question: expect.stringContaining('NEEDS-YOU') }));
  });
  it.each([true, false])('rechecks persisted legacy green (checksComplete=%s) and unloads later failure', async checksComplete => {
    const f = fixture(); await f.run();
    Object.assign(f.settlements()[0], { status: 'settled-green', checksComplete });
    delete f.settlements()[0].greenAt;
    f.d.checks.mockReturnValue({ total_count: 1, check_runs: [check('test', 'failure')] });
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
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
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
    expect(f.d.remove).toHaveBeenCalledWith(load);
    expect(f.events).toEqual([expect.objectContaining({ type: 'prototype-load.urgent-unloaded' })]);
    expect(f.settlements()).toEqual([expect.objectContaining({ status: 'settled-unloaded' })]);
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
    expect(f.d.remove).toHaveBeenCalledTimes(1); expect(f.d.remove).toHaveBeenCalledWith(failing);
    expect(f.settlements()).toEqual([expect.objectContaining({ ref: failing.ref, status: 'settled-unloaded' })]);
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
  it('reads exact-SHA checks through the origin-bound throttled reader and guards the actual overlay tip', () => {
    const exec = vi.fn((cmd, args) => args[0] === 'remote' ? load.repo : 'workflow');
    const ghExec = vi.fn((cmd, args) => JSON.stringify(args[0] === 'repo'
      ? { nameWithOwner: 'org/repo', url: load.repo } : args[1].includes('/actions/runs') ? workflows : { total_count: 0, check_runs: [] }));
    const remove = vi.fn(() => ({ removed: true })), env = {};
    const io = { readFileSync: p => {
      if (p.endsWith('prototype-load.json')) return JSON.stringify({ testWorkflowPath: '.github/workflows/custom.yml' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } };
    const readState = vi.fn(() => ({ corrupt: false, overlays: [{ ref: load.registration.ref }] }));
    const deps = createSweepDeps({ exec, ghExec, remove, readState, env, io });
    expect(deps.overlayState(load)).toEqual({ corrupt: false, overlays: [{ ref: load.registration.ref }] });
    expect(readState).toHaveBeenCalledWith(load.clone, { env });
    expect(deps.checks(load)).toEqual({ total_count: 0, check_runs: [], workflows, testWorkflowPath: '.github/workflows/custom.yml' });
    expect(ghExec.mock.calls[2][1]).toEqual(['api', `repos/org/repo/actions/runs?head_sha=${sha}&per_page=100`, '--hostname', 'example.com']);
    expect(ghExec.mock.calls[1][1]).toEqual(['api', `repos/org/repo/commits/${sha}/check-runs?per_page=100&filter=all`, '--hostname', 'example.com']);
    expect(ghExec.mock.calls.every(([, , o]) => o.maxBuffer === 1024 * 1024 && o.timeout === 30000 && o.throttle.caller === 'urgent-sweep')).toBe(true);
    deps.remove(load);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ root: '/clone', ref: 'lane/repair-m1', expectedTip: load.registration.sha, env }));
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
    expect(await f.run()).toMatchObject({ results: [{ status: 'settled-unloaded' }] });
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
