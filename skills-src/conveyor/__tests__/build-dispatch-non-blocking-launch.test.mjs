import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuildDispatchTick, cliHostLoadGate, cliSettleLaunches, cliLaunchConfirmed } from '../build-dispatch-daemon.mjs';
import { listBuildDispatchClaims, acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../../../scripts/conveyor/build-dispatch-claim.mjs';

const scope = ['plateau-app:src/a.ts'];
const tickOut = () => ({
  decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [{ num: '3827', lane: 13 }],
    admission: { queue: [{ num: '3827', scope }], cleared: [{ num: '3827', ready: true }] } },
  nextState: { tick: 1, buildGuards: [], launchedNums: [] },
});

function effectsFor(lockRoot, over = {}) {
  return {
    planTick: () => tickOut(),
    fetchOpenPrs: () => [{ repo: 'plateau-app', prs: [] }],
    listClaims: () => listBuildDispatchClaims({ lockRoot }),
    releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
    acquireClaim: ({ num, scope: sc }) => acquireBuildDispatchClaim({ num, scope: sc, owner: 'h:1', pid: process.pid, lockRoot }),
    listRunStoreInFlight: () => [],
    listSettledBuilds: () => [],
    killSwitch: () => ({ engaged: false }),
    dispatch: vi.fn(() => ({ dispatching: true, pending: true })),
    ...over,
  };
}

describe('non-blocking launch (78b)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-nb-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('a pending launch keeps its claim and is not offered again; a launched settle keeps the claim', async () => {
    const settleLaunches = vi.fn(async () => ({ pending: [], settled: [] }));
    const a = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { settleLaunches }) });
    expect(a.dispatched.map((d) => d.num)).toEqual(['3827']);
    settleLaunches.mockResolvedValue({ pending: [{ num: '3827', kind: 'build' }], settled: [] });
    const dispatch = vi.fn();
    const b = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { settleLaunches, dispatch }) });
    expect(dispatch).not.toHaveBeenCalled();
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['3827']);
    expect(b.launchSettlement.pending).toHaveLength(1);
    settleLaunches.mockResolvedValue({ pending: [], settled: [{ num: '3827', kind: 'build', outcome: { dispatching: true } }] });
    const c = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { settleLaunches, dispatch }) });
    expect(c.launchSettlement.settled).toEqual([expect.objectContaining({ num: '3827', launched: true })]);
    expect(c.failures).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c2) => c2.meta.num)).toEqual(['3827']);
  });

  it('a launch that died releases its claim and is recorded as a failure (launch-died)', async () => {
    await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot) });
    const settleLaunches = async () => ({ pending: [], settled: [{ num: '3827', kind: 'build', outcome: { dispatching: false, reason: 'launch-died: no output' } }] });
    const dispatch = vi.fn(() => ({ dispatching: true, pending: true }));
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { settleLaunches, dispatch }) });
    expect(r.failures).toEqual([expect.objectContaining({ num: '3827', stage: 'dispatch', reason: 'launch-died: no output' })]);
    expect(dispatch).toHaveBeenCalledTimes(1); // freed claim: retried this tick, as a failed blocking launch was the next tick
  });

  it('"launch not confirmed" with a live session is a launch, not a failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bdd-settle-'));
    try {
      const { startDetachedLaunch } = await import('../../../scripts/conveyor/pending-launches.mjs');
      const { writeFileSync } = await import('node:fs');
      const rec = startDetachedLaunch({ root, num: '4131', kind: 'build', argv: ['x'], env: {}, cwd: root, spawn: () => ({ pid: 9, unref() {} }) });
      writeFileSync(rec.outFile, JSON.stringify({ run: { verdict: { dispatching: true }, effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'declared' }] } }));
      const yes = await cliSettleLaunches({ root, isPidAlive: () => false, confirmed: async () => true });
      expect(yes.settled[0].outcome.dispatching).toBe(true);
      const rec2 = startDetachedLaunch({ root, num: '4132', kind: 'build', argv: ['x'], env: {}, cwd: root, spawn: () => ({ pid: 9, unref() {} }) });
      writeFileSync(rec2.outFile, JSON.stringify({ run: { verdict: { dispatching: true }, effects: [] } }));
      const no = await cliSettleLaunches({ root, isPidAlive: () => false, confirmed: async () => false });
      expect(no.settled[0].outcome.dispatching).toBe(false);
      expect(typeof cliLaunchConfirmed).toBe('function');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('builder host-load gate (#4139)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-load-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('a loaded host refuses new launches with a host-load reason and takes no claim', async () => {
    const dispatch = vi.fn(() => ({ dispatching: true }));
    const hostLoadGate = () => ({ admit: false, kind: 'host-load', why: 'host load 36.0 on 12 cores = 3.00/core > 2' });
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { dispatch, hostLoadGate }) });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.dispatched).toEqual([]);
    expect(r.loadHolds).toEqual([expect.objectContaining({ num: '3827', reason: 'host-load' })]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
  });

  it('never interrupts running work: an existing claim survives a loaded tick', async () => {
    await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot) });
    const hostLoadGate = () => ({ admit: false, kind: 'host-load', why: 'busy' });
    await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { hostLoadGate }) });
    expect(listBuildDispatchClaims({ lockRoot })).toHaveLength(1);
  });

  it('cliHostLoadGate uses the shared helper and the maxLoadPerCore setting', () => {
    expect(cliHostLoadGate({ env: {}, loadavg: () => 36, cpuCount: () => 12 })).toMatchObject({ admit: false, kind: 'host-load' });
    expect(cliHostLoadGate({ env: {}, loadavg: () => 10, cpuCount: () => 12 }).admit).toBe(true);
    expect(cliHostLoadGate({ env: { WE_MAX_LOAD_PER_CORE: '4' }, loadavg: () => 36, cpuCount: () => 12 }).admit).toBe(true);
  });
});
