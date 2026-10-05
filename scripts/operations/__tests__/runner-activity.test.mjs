import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { runnerActivityOperation } from '../runner-activity.mjs';
import { collectRunnerActivity, createRunnerActivityReader, READ_TIMEOUT_MS, KNOWN_DAEMONS } from '../runner-activity-io.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { RUNNER_LOCK_ROOT } from '../../../skills-src/conveyor/runner-lock.mjs';

const NOW = '2026-09-15T12:00:00.000Z';
const fresh = '2026-09-15T11:59:00.000Z';
const old = '2026-09-15T10:00:00.000Z';
const lease = { owner: 'host:42:conveyor-runner', pid: 42, heartbeatAt: fresh };
const fixLease = { owner: 'host:43:reconcile-fix-dispatch-daemon', pid: 43, heartbeatAt: fresh };
const reviewLease = { owner: 'host:44:review-daemon', pid: 44, heartbeatAt: fresh };
const tick = { tick: 7, at: fresh, stalled: [], dispatch: {}, statusLine: 'quiet' };

/** The three known daemons' own lease-file paths, precomputed with the SAME pure hashing `collectRunnerActivity`
 *  uses at read time — lets the fixture route each daemon's lease independently rather than one shared mock
 *  answering every `lock.json` read identically (which would make every daemon share one lease). */
const LOCK_PATH = Object.fromEntries(KNOWN_DAEMONS.map((d) =>
  [d.name, join(lockDirFor(RUNNER_LOCK_ROOT, d.leaseKey), 'lock.json')]));

/** Absolute, already-resolved command lines for each daemon's own script token — avoids exercising the
 *  cwd/`lsof` resolution path (covered separately by the existing relative-invocation tests below) so these
 *  fixtures stay focused on the daemon-generalization behavior under test. */
const ALIVE_COMMAND = Object.fromEntries(KNOWN_DAEMONS.map((d) => [d.name, `node /driver/${d.scriptToken}`]));
const PID = { dispatcher: 42, 'fix-dispatch': 43, review: 44 };

function dispatcherOf(verdict) { return verdict.runners.find((r) => r.name === 'dispatcher'); }

/**
 * @param {{ leases?: Record<string, object|null>, status?: object|null, records?: object[], agents?: object[],
 *   commandsByPid?: Record<number, string>, throwOnRead?: Record<string, Error>, dead?: boolean }} o
 *   `leases` maps daemon name -> lease object (or `null`/omitted for "no lease"). `throwOnRead` maps daemon
 *   name -> an Error to throw when its own lock.json is read (simulating an unreadable lock directory,
 *   distinct from a merely-absent one). `dead` makes every `ps` call fail as "no such pid" (exit 1, no
 *   stderr) — the existing recycled-pid/process-gone simulation, now shared across every daemon under test.
 */
function fixture({ leases = { dispatcher: lease }, status = tick, records = [], agents = [],
  commandsByPid = {}, throwOnRead = {}, dead = false } = {}) {
  const store = { list: vi.fn(() => records.map((r) => r.id)), read: vi.fn((id) => records.find((r) => r.id === id)),
    write: vi.fn(() => { throw new Error('unexpected write'); }), delete: vi.fn(() => { throw new Error('unexpected delete'); }) };
  const io = {
    env: {}, now: () => new Date(NOW), storeFor: vi.fn(() => store),
    readText: vi.fn((path) => {
      const daemonName = Object.entries(LOCK_PATH).find(([, p]) => p === path)?.[0];
      if (daemonName) {
        if (throwOnRead[daemonName]) throw throwOnRead[daemonName];
        const entry = leases[daemonName];
        return entry ? JSON.stringify(entry) : null;
      }
      return status && JSON.stringify(status);
    }),
    exec: vi.fn((file, argv) => {
      if (dead) throw Object.assign(new Error('no process'), { status: 1, stderr: '' });
      if (file === 'ps') {
        const pid = Number(argv[argv.indexOf('-p') + 1]);
        return commandsByPid[pid] ?? ALIVE_COMMAND.dispatcher;
      }
      return ALIVE_COMMAND.dispatcher;
    }),
    listAgents: vi.fn(() => agents),
  };
  const readActivity = (input) => collectRunnerActivity(input, io);
  return { io, store, readActivity };
}

async function report(f, argv = ['--json']) {
  const declaration = runnerActivityOperation({ readActivity: f.readActivity });
  const registry = createRegistry();
  registry.register(declaration);
  const out = await runOperationCli({ declaration, registry, store: createMemoryRunStore(),
    argv, sinks: {}, newRunId: () => 'activity-test' });
  return { ...out, payload: JSON.parse(out.lines.join('\n')) };
}

function dispatch(id, status = 'in-flight', extra = {}) {
  return { id, effects: [{ key: `${id}:dispatch:0`, step: 'dispatch', type: DISPATCH_EFFECT,
    status, handle: ' SESSION-A ', startedAt: old, expectedBy: old,
    payload: { num: '123', launchKind: 'prepare-decision' }, ...extra }] };
}

describe('runner-activity through the declared CLI adapter', () => {
  it('reports down with no runner and no durable data', async () => {
    const f = fixture({ leases: {}, status: null });
    const out = await report(f);
    expect(out.code).toBe(0);
    expect(out.payload.verdict).toMatchObject({ state: 'down', stalled: false, dispatching: false,
      lastTick: { number: null, at: null } });
    expect(dispatcherOf(out.payload.verdict)).toMatchObject({ name: 'dispatcher', present: false, pid: null, alive: false, state: 'down' });
    expect(out.payload.verdict.runners).toHaveLength(3);
    expect(out.payload.verdict.runners.map((r) => r.state)).toEqual(['down', 'down', 'down']);
    expect(f.io.exec).not.toHaveBeenCalled();
    expect(f.io.listAgents).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.store.delete).not.toHaveBeenCalled();
    expect(out.payload.applied).toEqual([]);
  });

  it('keeps alive-and-idle distinct from a stalled runner', async () => {
    const out = await report(fixture());
    expect(out.payload.verdict).toMatchObject({ state: 'alive-and-idle', stalled: false,
      lastTick: { number: 7, at: fresh, proxy: false } });
    expect(dispatcherOf(out.payload.verdict)).toMatchObject({ pid: 42, alive: true, heartbeatAt: fresh, state: 'alive-and-idle' });
    expect(out.payload.verdict.stalledReason).toMatch(/Quiet work is not a stall/);
    expect(out.payload.verdict.checkout).toBe('/driver');
  });

  it.each([
    ['/elsewhere', '../driver/skills-src/conveyor/runner.mjs'],
    ['/driver/skills-src', 'conveyor/runner.mjs'],
  ])('resolves a live relative invocation from %s: %s', async (cwd, script) => {
    const f = fixture();
    f.io.exec.mockImplementation((file) => file === 'ps' ? `node ${script}` : `p42\nn${cwd}\n`);
    f.io.readText.mockImplementation((path) => path === LOCK_PATH.dispatcher ? JSON.stringify(lease)
      : path === '/driver/.conveyor/driver-status.json' ? JSON.stringify(tick) : null);
    const out = await report(f);
    expect(out.payload.verdict).toMatchObject({ state: 'alive-and-idle', checkout: '/driver', lastTick: { number: 7, at: fresh } });
    expect(dispatcherOf(out.payload.verdict)).toMatchObject({ alive: true });
    expect(f.io.storeFor).toHaveBeenCalledWith('/driver');
  });

  it('reports alive-and-stalled when the existing heartbeat window expires', async () => {
    const out = await report(fixture({ leases: { dispatcher: { ...lease, heartbeatAt: old } }, status: { ...tick, at: old } }));
    expect(out.payload.verdict).toMatchObject({ state: 'alive-and-stalled', stalled: true });
    expect(out.payload.verdict.stalledReason).toMatch(/lease window/);
  });

  it('uses the tick core held-work diagnosis even with a fresh heartbeat', async () => {
    const out = await report(fixture({ status: { ...tick, stalled: [{ num: '123', reason: 'scope blocked', ticks: 3 }] } }));
    expect(out.payload.verdict.stalled).toBe(true);
    expect(out.payload.verdict.stalledReason).toContain('#123: scope blocked');
  });

  it('reports alive-and-dispatching independently of driver health, reusing normalized session liveness', async () => {
    const f = fixture({ records: [dispatch('live')], agents: [{ sessionId: 'session-a' }] });
    const out = await report(f);
    expect(out.payload.verdict).toMatchObject({ state: 'alive-and-idle', stalled: false, dispatching: true,
      dispatchLiveness: 'claude-agents' });
    expect(out.payload.verdict.inFlightDispatches[0]).toMatchObject({ launchKind: 'prepare-decision',
      live: true, ageMs: 7_200_000, holds: true });
    expect(f.io.listAgents).toHaveBeenCalledTimes(1);
    expect(f.store.write).not.toHaveBeenCalled();
  });

  it('distinguishes dead from down even when the lease is still fresh', async () => {
    expect((await report(fixture({ dead: true }))).payload.verdict.state).toBe('dead');
    const f = fixture();
    f.io.exec.mockReturnValue('node unrelated.mjs');
    expect((await report(f)).payload.verdict.state).toBe('dead');
  });

  it('does not call a missing first tick stalled while the lease is fresh', async () => {
    const out = await report(fixture({ status: null }));
    expect(out.payload.verdict).toMatchObject({ state: 'alive-and-idle', lastTick: { at: null, number: null } });
    expect(out.payload.verdict.stalledReason).toMatch(/no completed tick/i);
  });

  it('does not confuse planned launches or absent sessions with real work', async () => {
    const out = await report(fixture({ records: [dispatch('gone')], status: { ...tick, dispatch: { builds: [{ num: '999' }] } } }));
    expect(out.payload.verdict.dispatching).toBe(false);
    expect(out.payload.verdict.inFlightDispatches[0]).toMatchObject({ live: false, holds: false });
  });

  it('keeps an unreadable listing unknown; never persists a last-seen stamp', async () => {
    const f = fixture({ records: [dispatch('unknown')] });
    f.io.listAgents.mockImplementation(() => { throw new Error('timeout'); });
    const out = await report(f);
    expect(out.payload.verdict.dispatchLiveness).toBe('unreadable');
    expect(out.payload.verdict.inFlightDispatches[0].live).toBe(null);
    expect(f.store.write).not.toHaveBeenCalled();
  });

  it('returns the last N terminal effects with outcome and honest timestamp provenance', async () => {
    const older = dispatch('older', 'failed', { lastAttemptAt: old, error: 'spawn refused' });
    const newer = { ...dispatch('newer', 'applied', { result: { resolvedBy: 'pr-merged' } }),
      stepTimings: [{ step: 'dispatch', finishedAt: fresh }] };
    const f = fixture({ records: [newer, dispatch('still-live'), older, { id: 'no-launch', effects: [] }] });
    const out = await report(f, ['--json', '--limit=1']);
    expect(out.payload.verdict.completedAvailable).toBe(2);
    expect(out.payload.verdict.completedDispatches).toEqual([expect.objectContaining({ runId: 'newer',
      outcome: 'applied', at: fresh, timestampSource: 'run.stepTimings.finishedAt' })]);
    const all = (await report(f)).payload.verdict.completedDispatches;
    expect(all[1]).toMatchObject({ outcome: 'failed', error: 'spawn refused', timestampSource: 'last-attempt-proxy' });
  });

  it('reports partial history and refuses failed required reads instead of claiming down', async () => {
    const f = fixture({ records: [dispatch('corrupt')] });
    f.store.read.mockImplementation(() => { throw new Error('corrupt'); });
    expect((await report(f)).payload.verdict.unreadableRunRecords).toBe(1);
    f.store.list.mockImplementation(() => { throw new Error('unreadable store'); });
    expect((await report(f)).code).toBe(1);
    const bad = fixture();
    bad.io.readText.mockReturnValue('{');
    expect((await report(bad)).code).toBe(1);
    const timeout = fixture();
    timeout.io.exec.mockImplementation(() => { throw Object.assign(new Error('timeout'), { signal: 'SIGKILL' }); });
    expect((await report(timeout)).code).toBe(1);
  });

  it('validates N before making any external read', async () => {
    const f = fixture();
    for (const limit of ['-1', '1.5', '1001']) expect((await report(f, ['--json', `--limit=${limit}`])).code).toBe(1);
    expect(f.io.readText).not.toHaveBeenCalled();
  });
});

describe('runner-activity reports all three known daemons', () => {
  it('reports all three daemons alive-and-idle when every lease is fresh and identity-matched', async () => {
    const f = fixture({
      leases: { dispatcher: lease, 'fix-dispatch': fixLease, review: reviewLease },
      commandsByPid: { 42: ALIVE_COMMAND.dispatcher, 43: ALIVE_COMMAND['fix-dispatch'], 44: ALIVE_COMMAND.review },
    });
    const out = await report(f);
    expect(out.code).toBe(0);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher).toMatchObject({ present: true, alive: true, pid: 42, state: 'alive-and-idle' });
    expect(byName['fix-dispatch']).toMatchObject({ present: true, alive: true, pid: 43, state: 'alive-and-idle' });
    expect(byName.review).toMatchObject({ present: true, alive: true, pid: 44, state: 'alive-and-idle' });
    // Non-dispatcher daemons have no tick concept: their stalledReason never mentions the tick core.
    expect(byName['fix-dispatch'].stalledReason).toMatch(/heartbeat is fresh/i);
    expect(byName.review.stalledReason).toMatch(/heartbeat is fresh/i);
  });

  it('reports one daemon down (no lease) while the other two are up', async () => {
    const f = fixture({
      leases: { dispatcher: lease, review: reviewLease },
      commandsByPid: { 42: ALIVE_COMMAND.dispatcher, 44: ALIVE_COMMAND.review },
    });
    const out = await report(f);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher.state).toBe('alive-and-idle');
    expect(byName.review.state).toBe('alive-and-idle');
    expect(byName['fix-dispatch']).toMatchObject({ present: false, alive: false, pid: null, state: 'down' });
  });

  it('reports one daemon dead (stale heartbeat) while the others are alive-and-idle', async () => {
    const f = fixture({
      leases: { dispatcher: lease, 'fix-dispatch': { ...fixLease, heartbeatAt: old }, review: reviewLease },
      commandsByPid: { 42: ALIVE_COMMAND.dispatcher, 43: ALIVE_COMMAND['fix-dispatch'], 44: ALIVE_COMMAND.review },
    });
    const out = await report(f);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher.state).toBe('alive-and-idle');
    expect(byName.review.state).toBe('alive-and-idle');
    expect(byName['fix-dispatch']).toMatchObject({ state: 'alive-and-stalled', stalled: true });
  });

  it('reports one daemon dead (recycled pid — command no longer matches its own script) while others are fine', async () => {
    const f = fixture({
      leases: { dispatcher: lease, 'fix-dispatch': fixLease, review: reviewLease },
      commandsByPid: { 42: ALIVE_COMMAND.dispatcher, 43: 'node some-unrelated-process.mjs', 44: ALIVE_COMMAND.review },
    });
    const out = await report(f);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher.state).toBe('alive-and-idle');
    expect(byName.review.state).toBe('alive-and-idle');
    expect(byName['fix-dispatch']).toMatchObject({ present: true, pid: 43, alive: false, state: 'dead' });
  });

  it('isolates one daemon\'s unreadable lock directory: it reports down/unreadable in its own entry, never aborts the whole snapshot', async () => {
    const f = fixture({
      leases: { dispatcher: lease, review: reviewLease },
      commandsByPid: { 42: ALIVE_COMMAND.dispatcher, 44: ALIVE_COMMAND.review },
      throwOnRead: { 'fix-dispatch': Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
    });
    const out = await report(f);
    expect(out.code).toBe(0);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher.state).toBe('alive-and-idle');
    expect(byName.review.state).toBe('alive-and-idle');
    expect(byName['fix-dispatch']).toMatchObject({ present: null, alive: false, state: 'down' });
    expect(byName['fix-dispatch'].error).toMatch(/lock directory unreadable/);
    expect(byName['fix-dispatch'].stalledReason).toMatch(/could not be read reliably/);
  });

  it('isolates one daemon\'s malformed lease the same way', async () => {
    const f = fixture({ leases: { dispatcher: lease } });
    f.io.readText.mockImplementation((path) => {
      if (path === LOCK_PATH['fix-dispatch']) return '{not-json';
      if (path === LOCK_PATH.dispatcher) return JSON.stringify(lease);
      if (path === LOCK_PATH.review) return null;
      return JSON.stringify(tick);
    });
    const out = await report(f);
    expect(out.code).toBe(0);
    const byName = Object.fromEntries(out.payload.verdict.runners.map((r) => [r.name, r]));
    expect(byName.dispatcher.state).toBe('alive-and-idle');
    expect(byName['fix-dispatch']).toMatchObject({ present: null, state: 'down' });
    expect(byName['fix-dispatch'].error).toBe('malformed lease');
  });

  it('still hard-fails the whole read on a genuine process-identity infra error for a NON-dispatcher daemon (never masquerades as dead)', async () => {
    const f = fixture({ leases: { dispatcher: lease, 'fix-dispatch': fixLease } });
    f.io.exec.mockImplementation((file, argv) => {
      const pid = Number(argv?.[argv.indexOf('-p') + 1]);
      if (file === 'ps' && pid === 43) throw Object.assign(new Error('permission denied'), { status: 13, stderr: 'ps: not permitted' });
      if (file === 'ps') return ALIVE_COMMAND.dispatcher;
      return ALIVE_COMMAND.dispatcher;
    });
    expect((await report(f)).code).toBe(1);
  });
});

describe('hard read deadlines', () => {
  it('bounds the entire snapshot, including synchronous store/file reads, with SIGKILL', () => {
    const run = vi.fn(() => JSON.stringify({ sentinel: true }));
    expect(createRunnerActivityReader({ run })({ limit: 3 })).toEqual({ sentinel: true });
    expect(run.mock.calls[0][1].slice(-2)).toEqual(['--snapshot', '{"limit":3}']);
    expect(run.mock.calls[0][2]).toMatchObject({ timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL' });
    run.mockImplementation(() => { throw new Error('deadline'); });
    expect(() => createRunnerActivityReader({ run })({})).toThrow('deadline');
  });

  it('bounds process identity reads inside the snapshot', () => {
    const f = fixture();
    f.readActivity({ limit: 10 });
    expect(f.io.exec.mock.calls[0][2]).toMatchObject({ timeout: 2000, killSignal: 'SIGKILL' });
  });

  it('bounds the existing agent listing even when the environment requests an unbounded read', () => {
    const f = fixture({ records: [dispatch('live')] });
    const exec = vi.fn((file) => file === 'ps' ? 'node /driver/skills-src/conveyor/runner.mjs' : '[]');
    collectRunnerActivity({}, { ...f.io, listAgents: undefined, exec,
      // The cache must be off: this bare env carries no VITEST, so a sibling test's fresh `[]` listing for the same
      // (empty) PATH/HOME scope would be served and `claude` never exec'd — an order-dependent CI-only failure.
      env: { WE_DISPATCH_LIST_TIMEOUT_MS: '0', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } });
    expect(exec.mock.calls.find(([file]) => file === 'claude')[2]).toMatchObject({ timeout: 2000, killSignal: 'SIGKILL' });
  });
});
