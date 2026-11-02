import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBuildFailure, clearBuildFailure, listBuildBackoffs, claimAttemptKeys } from '../../../scripts/conveyor/build-dispatch-failures.mjs';
import { runBuildDispatchTick, cliHostLoadGate, cliSettleLaunches, cliLaunchConfirmed, createPrepareStatusReader } from '../build-dispatch-daemon.mjs';
import { listBuildDispatchClaims, acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../../../scripts/conveyor/build-dispatch-claim.mjs';
import { adoptOrphanedBuildClaims } from '../../../scripts/conveyor/build-dispatch-orphan-adopt.mjs';
import { outcomePayload } from '../../../scripts/operations/cli-adapter.mjs';
import { readDispatchOutcome } from '../build-dispatch-daemon.mjs';
import { readBuildUnconfirmedSettings } from '../../../scripts/lib/build-unconfirmed-settings.mjs';
import { redactSpawnText } from '../../../scripts/lib/describe-spawn-failure.mjs';
import { startDetachedLaunch } from '../../../scripts/conveyor/pending-launches.mjs';
import { execFileSyncThrottled } from '../../../scripts/lib/gh-throttle.mjs';

// Pass-through spy, so the default sync exec of prepare discovery can be pinned to the shared throttle (PR #5453).
vi.mock('../../../scripts/lib/gh-throttle.mjs', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, execFileSyncThrottled: vi.fn((...args) => orig.execFileSyncThrottled(...args)) };
});

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

  it.each(['failed', 'indeterminate'])('redacts %s dispatch receipts at the public payload and daemon boundaries', async (status) => {
    // Shared payload guard: CLI JSON and HTTP run routes both use outcomePayload.
    // Include settings JSON, assignment, bearer and token shapes across line/quote boundaries.
    const secret = 'ghp_fixtureSecret123456789';
    const error = `Command failed: worker --settings {"env":{"GH_TOKEN":"${secret}"}}\n\r\u2028\`" -- ../ GH_TOKEN=${secret} Bearer ${secret}`;
    const effect = { key: 'receipt#0', type: 'conveyor.dispatch-delivery-agent', status,
      handle: `worker GH_TOKEN=${secret}`, error };
    const run = { id: 'secret-receipt', op: 'dispatch-lane', effects: [effect], verdict: { dispatching: true } };
    const envelope = outcomePayload({ run, stopped: 'effect-halted', error: new Error(error) });
    // Any additional receipt field needs an explicit public-payload/redaction assertion here.
    expect(Object.keys(envelope.effects[0]).sort()).toEqual(['error', 'handle', 'key', 'status', 'type']);
    expect(envelope.effects[0].error).toBe(redactSpawnText(error));
    expect(envelope.effects[0].handle).toBe(redactSpawnText(effect.handle));
    expect(envelope.error).toBe(redactSpawnText(error));
    expect(JSON.stringify(envelope)).not.toContain(secret);
    // Also defend older/raw producers that bypass the serializer entirely.
    for (const input of [envelope, { run }]) {
      const outcome = readDispatchOutcome(JSON.stringify(input));
      expect(outcome).toMatchObject({ dispatching: false, reason: redactSpawnText(error) });
      const tick = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
        settleLaunches: () => ({ pending: [], settled: [{ num: '3827', kind: 'build', outcome }] }),
        dispatch: () => outcome,
      }) });
      expect(tick.launchSettlement.settled[0].reason).toBe(redactSpawnText(error));
      expect(tick.failures.length).toBeGreaterThan(0);
      for (const failure of tick.failures) expect(failure.reason).toBe(redactSpawnText(error));
      expect(JSON.stringify(tick)).not.toContain(secret);
    }
  });

  it.each(['reason', 'why'])('redacts the dispatch verdict %s fallback', (field) => {
    const reason = 'refused GH_TOKEN=ghp_fixtureSecret123456789';
    const envelope = outcomePayload({ run: { id: 'refusal', op: 'dispatch-lane', effects: [], verdict: { dispatching: false, [field]: reason } }, stopped: 'complete' });
    expect(envelope.verdict[field]).toBe(redactSpawnText(reason));
    expect(readDispatchOutcome(JSON.stringify({ verdict: { dispatching: false, [field]: reason } })).reason)
      .toBe(redactSpawnText(reason));
  });

  it.each(['empty', 'invalid', 'failed', 'partial'])('redacts detached %s output before excerpts reach tick reasons', async (kind) => {
    const secret = 'ghp_fixtureSecret123456789';
    const opaque = 'opaqueDiagnosticCredential123';
    const error = `Command failed: GH_TOKEN=${secret} {"env":{"GH_TOKEN":"${opaque}"}}`;
    const rec = startDetachedLaunch({ root: lockRoot, num: '3827', kind: 'build', argv: [], env: {}, cwd: lockRoot,
      spawn: () => ({ pid: 9, unref() {} }) });
    const envelope = JSON.stringify({ verdict: { dispatching: true },
      effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'failed', error }] });
    const text = kind === 'empty' ? '' : kind === 'invalid' ? error : kind === 'partial' ? `${envelope}\nextra diagnostic` : envelope;
    writeFileSync(rec.outFile, text);
    // Place a token across the excerpt boundary: redaction must precede slicing.
    writeFileSync(rec.errFile, `${'x'.repeat(155)} ${error}`);
    const tick = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
      settleLaunches: () => cliSettleLaunches({ root: lockRoot, isPidAlive: () => false }),
      dispatch: () => ({ dispatching: false, reason: 'retry declined' }),
    }) });
    expect(tick.launchSettlement.settled[0].reason).toContain('<redacted-token>');
    expect(JSON.stringify(tick)).not.toContain(secret);
    expect(JSON.stringify(tick)).not.toContain('fixtureSecret');
    expect(JSON.stringify(tick)).not.toContain(opaque);
  });

  it('confirms the real CLI dispatch envelope from its persisted receipt, without a later liveness rescue', async () => {
    const { createFileRunStore } = await import('../../../scripts/operations/run-store.mjs');
    const { startRun } = await import('../../../scripts/operations/engine.mjs');
    const { createRegistry } = await import('../../../scripts/operations/registry.mjs');
    const { dispatchLaneOperation } = await import('../../../scripts/operations/dispatch-lane.mjs');
    const registry = createRegistry();
    registry.register(dispatchLaneOperation({ readTick: () => ({}) }));
    const store = createFileRunStore(lockRoot);
    const run = startRun({ op: 'dispatch-lane', id: 'receipt-test', input: { num: '4415' }, registry });
    run.verdict = { dispatching: true, lane: 16 };
    run.effects = [{ key: 'receipt-test#2#0', stepIndex: 2, step: 'dispatch', index: 0,
      type: 'conveyor.dispatch-delivery-agent', idempotent: false, payload: {}, status: 'in-flight', handle: 'pid:65420' }];
    store.write(run);
    const envelope = outcomePayload({ run: store.read(run.id), stopped: 'effect-in-flight' });
    expect(readDispatchOutcome(JSON.stringify(envelope))).toMatchObject({ dispatching: true, handle: 'pid:65420', reason: null });
    // A key with no handle, a declared effect, and a halted sink still fail closed.
    for (const receipt of [{ ...run.effects[0], handle: null }, { ...run.effects[0], status: 'declared' },
      { ...run.effects[0], status: 'failed', error: 'worker refused' }]) {
      expect(readDispatchOutcome(JSON.stringify(outcomePayload({ run: { ...run, effects: [receipt] }, stopped: 'effect-halted' }))).dispatching).toBe(false);
    }
  });

  it('unconfirmed twice on the same base cools down #4415 before any third launch, with durable needs-you evidence', async () => {
    const path = join(lockRoot, 'failures.json');
    let clock = 0;
    const settings = { baseMs: 1, maxMs: 1, maxAttempts: 6 };
    const reason = 'dispatch launch not confirmed (missing effect; no running session) [stdout: { "stopped": "effect-in-flight" }]';
    const dispatch = vi.fn(() => ({ dispatching: true, pending: true }));
    let settled = [];
    const effects = () => effectsFor(lockRoot, {
      planTick: () => { const t = tickOut(); t.decisions.spawnBuilds[0].num = '4415'; t.decisions.admission.queue[0].num = '4415'; t.decisions.admission.cleared[0].num = '4415'; return t; },
      dispatch, settleLaunches: () => ({ pending: [], settled }),
      recordBuildFailure: o => recordBuildFailure(o, { path, now: clock, settings }),
      listBuildBackoffs: () => listBuildBackoffs({ path, now: clock }),
    });
    await runBuildDispatchTick({ live: true, effects: effects() });
    settled = [{ num: '4415', kind: 'build', base: 'base-a', outcome: { dispatching: false, reason } }];
    await runBuildDispatchTick({ live: true, effects: effects() });
    settled = []; clock = 2;
    await runBuildDispatchTick({ live: true, effects: effects() });
    expect(dispatch).toHaveBeenCalledTimes(2);
    settled = [{ num: '4415', kind: 'build', base: 'base-a', outcome: { dispatching: false, reason: `${reason}; last attempt` } }];
    const cooled = await runBuildDispatchTick({ live: true, effects: effects() });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(cooled.needsYou).toContainEqual(expect.objectContaining({ num: '4415', step: 'launch-confirmation', reason: expect.stringContaining('last attempt') }));
    expect(cooled.buildBackoffs).toContainEqual(expect.objectContaining({ num: '4415', unconfirmedCooldown: true, retryAfter: new Date(clock + 120 * 60_000).toISOString() }));
    settled = []; clock = 60_000;
    const restarted = await runBuildDispatchTick({ live: true, effects: effects() });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(restarted.needsYou).toContainEqual(expect.objectContaining({ num: '4415', step: 'launch-confirmation' }));
    clock = 120 * 60_000 + 3;
    await runBuildDispatchTick({ live: true, effects: effects() });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('counts unconfirmed launches per base and resolves the cooldown cascade with source logging', () => {
    const log = vi.fn();
    const unconfirmed = readBuildUnconfirmedSettings({ platform: { unconfirmedLaunchMax: 3, unconfirmedCooldownMin: 50 },
      tool: { unconfirmedCooldownMin: 60 }, env: { WE_BUILD_UNCONFIRMED_LAUNCH_MAX: '2', WE_POLICY_CASCADE_LOG: '1' }, log });
    expect(unconfirmed).toEqual({ unconfirmedLaunchMax: 2, unconfirmedCooldownMin: 60 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unconfirmedLaunchMax=2 (env)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unconfirmedCooldownMin=60 (tool)'));
    expect(readBuildUnconfirmedSettings({ platform: {}, tool: {}, env: {} }))
      .toEqual({ unconfirmedLaunchMax: 2, unconfirmedCooldownMin: 120 });
    expect(readBuildUnconfirmedSettings({ platform: { unconfirmedLaunchMax: 4, unconfirmedCooldownMin: 45 },
      tool: { unconfirmedLaunchMax: -1 }, env: { WE_BUILD_UNCONFIRMED_LAUNCH_MAX: 'oops', WE_BUILD_UNCONFIRMED_COOLDOWN_MIN: '0' } }))
      .toEqual({ unconfirmedLaunchMax: 4, unconfirmedCooldownMin: 45 });
    const path = join(lockRoot, 'base-failures.json');
    const fail = base => recordBuildFailure({ num: '4415', base, reason: 'dispatch launch not confirmed' }, { path, now: 0, unconfirmed });
    expect(fail('a').unconfirmedLaunches).toBe(1);
    expect(fail('b').unconfirmedLaunches).toBe(1);
    expect(fail('b')).toMatchObject({ unconfirmedLaunches: 2, unconfirmedCooldown: true, retryAfter: new Date(60 * 60_000).toISOString() });
  });

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
      const rec = startDetachedLaunch({ root, num: '4131', kind: 'build', base: 'launch-base', argv: ['x'], env: {}, cwd: root, spawn: () => ({ pid: 9, unref() {} }) });
      writeFileSync(rec.outFile, JSON.stringify({ run: { verdict: { dispatching: true }, effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'declared' }] } }));
      const yes = await cliSettleLaunches({ root, isPidAlive: () => false, confirmed: async () => true });
      expect(yes.settled[0].outcome.dispatching).toBe(true);
      expect(yes.settled[0]).toMatchObject({ base: 'launch-base', outcome: { reason: null, confirmedBy: 'live-session' } });
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
    expect(cliHostLoadGate({ sample: () => ({ ok: false }), env: {}, loadavg: () => 36, cpuCount: () => 12 })).toMatchObject({ admit: false, kind: 'host-load' });
    expect(cliHostLoadGate({ sample: () => ({ ok: false }), env: {}, loadavg: () => 10, cpuCount: () => 12 }).admit).toBe(true);
    expect(cliHostLoadGate({ sample: () => ({ ok: false }), env: { WE_MAX_LOAD_PER_CORE: '4' }, loadavg: () => 36, cpuCount: () => 12 }).admit).toBe(true);
  });
});

describe('one detached launch at a time (78b)', () => {
  it('never starts a second launch while one is pending or just started', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-one-'));
    try {
      const t = tickOut();
      t.decisions.spawnBuilds.push({ num: '2662', lane: 14 });
      t.decisions.admission.queue.push({ num: '2662', scope: ['plateau-app:src/b.ts'] });
      t.decisions.admission.cleared.push({ num: '2662', ready: true });
      const dispatch = vi.fn(() => ({ dispatching: true, pending: true }));
      const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { planTick: () => t, dispatch, settleLaunches: async () => ({ pending: [], settled: [] }) }) });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(r.dispatched).toHaveLength(1);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });
});


it.each([true, false])('retains #4413 retry history across launch confirmation and daemon restarts (pending=%s)', async pending => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-4413-'));
  const path = join(lockRoot, 'failures.json');
  let clock = 0;
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 3 };
  const failure = () => recordBuildFailure({ num: '4413', reason: 'build-not-started: orphan-released' }, { path, now: clock, settings });
  const dispatch = vi.fn(() => ({ dispatching: true, pending }));
  const tick = (settleLaunches = async () => ({ pending: [], settled: [] }), fetchOpenPrs) => {
    const out = tickOut();
    out.decisions.spawnBuilds[0].num = '4413';
    out.decisions.admission.queue[0].num = '4413';
    out.decisions.admission.cleared[0].num = '4413';
    // Recreate the effects every tick, using only disk for claim and failure history.
    return runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
      planTick: () => out, dispatch, settleLaunches,
      listBuildBackoffs: () => listBuildBackoffs({ path, now: clock }),
      clearBuildFailure: ({ num }) => clearBuildFailure(num, { path }),
      ...(fetchOpenPrs ? { fetchOpenPrs } : {}),
    }) });
  };
  try {
    failure();
    clock = 10000;
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await tick(async () => ({ pending: [{ num: '4413', kind: 'build' }], settled: [] }));
    await tick(async () => ({ pending: [], settled: [{ num: '4413', kind: 'build', outcome: { dispatching: true } }] }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listBuildDispatchClaims({ lockRoot }).map(c => c.meta.num)).toEqual(['4413']);
    releaseBuildDispatchClaim({ num: '4413', lockRoot }); // observed dead worker
    expect(failure().attempts).toBe(2);
    clock = 20000;
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    releaseBuildDispatchClaim({ num: '4413', lockRoot });
    expect(failure()).toMatchObject({ attempts: 3, exhausted: true });
    clock = 1000000;
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

// Red-team (PR #5453): orphan adoption can release a delivered claim BEFORE the claim-retire loop, so the
// observed-delivery clear must live on that path too, or the next failure after the PR closes exhausts the card.
it('clears #4413 retry history when orphan adoption observes the dead worker\'s PR first', async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-4413-adopt-'));
  const path = join(lockRoot, 'failures.json');
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 3 };
  const failure = () => recordBuildFailure({ num: '4413', reason: 'build-not-started: orphan-released' }, { path, now: 0, settings });
  const pr = { number: 9001, headRefName: 'lane/4413-fix' };
  try {
    failure(); failure();
    acquireBuildDispatchClaim({ num: '4413', scope, owner: 'h:1', pid: 98761, lockRoot });
    const out = tickOut();
    out.decisions.spawnBuilds = [];
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
      planTick: () => out,
      fetchOpenPrs: () => [{ repo: 'we', prs: [pr] }],
      clearBuildFailure: ({ num }) => clearBuildFailure(num, { path }),
      adoptOrphans: () => adoptOrphanedBuildClaims({
        listClaims: () => listBuildDispatchClaims({ lockRoot }),
        isPidAlive: () => false, findRow: () => null, readResumeMarker: () => null, sessionLivenessFor: () => null,
        readDelivery: () => ({ outcome: 'pr-open', pr: 9001, reason: 'PR #9001 is open' }), settleDelivered: () => {},
        releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }), releaseResumeMarker: () => {},
        clearFailure: ({ num }) => clearBuildFailure(num, { path }),
        recordFailure: () => { throw new Error('delivered claim must not record a failure'); },
        releaseLaneLease: () => { throw new Error('delivered claim must not release a reserved lane'); },
        spawnResume: () => { throw new Error('delivered claim must not resume'); },
      }),
    }) });
    expect(r.orphanAdoption).toEqual([expect.objectContaining({ num: '4413', action: 'settled' })]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
    expect(listBuildBackoffs({ path, now: 0 })).toEqual([]);
    // The PR then closes unmerged and the next dispatch fails: a fresh first attempt, not an exhausted card.
    expect(failure()).toMatchObject({ attempts: 1, exhausted: false });
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

// PR #5472 red team: the settled-launch failure is recorded BEFORE its claim is released. If that release throws,
// orphan adoption then charges the same dead claim; both charges must share one attempt key.
it('a failed claim release after a settled launch failure never lets orphan adoption charge the attempt twice', async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-5472-release-'));
  const path = join(lockRoot, 'failures.json');
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 6 };
  const record = (o) => recordBuildFailure(o, { path, now: 0, settings });
  try {
    for (let i = 0; i < 4; i += 1) record({ num: '3827', reason: 'launch-died: earlier' });
    // A claim left by the dead prior daemon, with no run-store row.
    acquireBuildDispatchClaim({ num: '3827', scope, owner: 'h:1', pid: 98762, lockRoot });
    let releases = 0;
    const releaseClaim = ({ num }) => {
      releases += 1;
      if (releases === 1) throw new Error('EBUSY: transient release failure');
      return releaseBuildDispatchClaim({ num, lockRoot });
    };
    const out = tickOut();
    out.decisions.spawnBuilds = [];
    await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
      planTick: () => out, releaseClaim, recordBuildFailure: record,
      settleLaunches: () => ({ pending: [], settled: [{ num: '3827', kind: 'build', outcome: { dispatching: false, reason: 'launch-died: no output' } }] }),
      adoptOrphans: () => adoptOrphanedBuildClaims({
        listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
        isPidAlive: () => false, findRow: () => null, readResumeMarker: () => null, sessionLivenessFor: () => null,
        readDelivery: () => null, settleDelivered: () => {},
        resolveResumability: () => ({ resumable: false, reason: 'no row' }),
        releaseClaim, releaseResumeMarker: () => {}, settleRow: () => {}, placeHold: () => {},
        recordFailure: record, clearFailure: () => {}, releaseLaneLease: () => {},
        spawnResume: () => { throw new Error('must not resume'); },
      }),
    }) });
    const [backoff] = listBuildBackoffs({ path, now: 0 });
    expect(backoff).toMatchObject({ num: '3827', attempts: 5, reason: 'dispatch-backoff' });
    expect(backoff.retryAfter).not.toBeNull();
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

// Self-review variants of the same class: a stale member claim must not dedupe a later, genuine failure, and the
// blocking launch path charges before it releases, so a release throw never leaves the attempt uncharged.
it('a member claim left by an earlier launch never dedupes a later settled failure of its lead', async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-5472-member-'));
  const path = join(lockRoot, 'failures.json');
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 9 };
  const record = (o) => recordBuildFailure(o, { path, now: 0, settings });
  const settle = () => ({ pending: [], settled: [{ num: '3827', kind: 'build', outcome: { dispatching: false, reason: 'launch-died: no output' } }] });
  try {
    // An earlier launch's member claim that outlived it (orphan adoption leaves members).
    acquireBuildDispatchClaim({ num: '200', scope, owner: 'h:1', pid: 98763, lockRoot, groupLead: '3827' });
    for (let launch = 0; launch < 2; launch += 1) {
      acquireBuildDispatchClaim({ num: '3827', scope, owner: 'h:1', pid: 98763, lockRoot });
      const out = tickOut();
      out.decisions.spawnBuilds = [];
      await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { planTick: () => out, recordBuildFailure: record, settleLaunches: settle }) });
      await new Promise((done) => setTimeout(done, 5)); // a distinct claimedAt for the next launch's claim
    }
    expect(listBuildBackoffs({ path, now: 0 })[0]).toMatchObject({ num: '3827', attempts: 2 });
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

it('a member claim older than its lead claim names no attempt, so orphan and fail-group charges of later launches count', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bdd-5472-keys-')), 'failures.json');
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 9 };
  const claim = (num, at, groupLead) => ({ meta: { num, claimedAt: at, ...(groupLead ? { groupLead } : {}) } });
  const stale = claim('11', '2026-10-17T00:00:00.000Z', '10');
  expect(claimAttemptKeys([claim('10', '2026-10-17T01:00:00.000Z'), stale], '10')).toEqual(['orphan:2026-10-17T01:00:00.000Z']);
  // With no lead claim visible the member keys still tie fail-group and orphan charges of one attempt.
  expect(claimAttemptKeys([stale], '10')).toEqual(['member:11:2026-10-17T00:00:00.000Z']);
  // Attempt 1 (lead t0 + member t0), then attempts 2 and 3 with the attempt-1 member claim left behind.
  for (const [i, leadAt] of ['2026-10-17T00:00:00.000Z', '2026-10-17T01:00:00.000Z', '2026-10-17T02:00:00.000Z'].entries()) {
    const keys = claimAttemptKeys([claim('10', leadAt), stale], '10');
    expect(recordBuildFailure({ num: '10', reason: 'build-not-started: orphan-released', attemptKey: keys }, { path, now: 0, settings }))
      .toMatchObject({ attempts: i + 1 });
  }
});

it('a blocking launch failure is charged before its claim release, keyed so orphan adoption cannot charge it again', async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-5472-blocking-'));
  const path = join(lockRoot, 'failures.json');
  const settings = { baseMs: 1000, maxMs: 5000, maxAttempts: 9 };
  const record = (o) => recordBuildFailure(o, { path, now: 0, settings });
  try {
    let releases = 0;
    const releaseClaim = ({ num }) => {
      releases += 1;
      if (releases === 1) throw new Error('EBUSY: transient release failure');
      return releaseBuildDispatchClaim({ num, lockRoot });
    };
    await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, {
      releaseClaim, recordBuildFailure: record, dispatch: () => ({ dispatching: false, reason: 'launch-died: no output' }) }) });
    expect(listBuildBackoffs({ path, now: 0 })[0]).toMatchObject({ num: '3827', attempts: 1 });
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toHaveLength(1); // the release threw
    await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false, findRow: () => null, readResumeMarker: () => null, sessionLivenessFor: () => null,
      readDelivery: () => null, settleDelivered: () => {}, resolveResumability: () => ({ resumable: false, reason: 'no row' }),
      releaseClaim, releaseResumeMarker: () => {}, settleRow: () => {}, placeHold: () => {},
      recordFailure: record, clearFailure: () => {}, releaseLaneLease: () => {},
      spawnResume: () => { throw new Error('must not resume'); },
    });
    expect(listBuildBackoffs({ path, now: 0 })[0]).toMatchObject({ num: '3827', attempts: 1 });
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

it('prepare discovery reads through the shared throttle by default on the sync path (PR #5453)', () => {
  const real = execFileSyncThrottled.getMockImplementation();
  execFileSyncThrottled.mockImplementation(() => { throw new Error('throttled-stub'); });
  try {
    expect(() => createPrepareStatusReader().resolveCard({ num: '4413' })).toThrow('throttled-stub');
    expect(execFileSyncThrottled).toHaveBeenCalledWith('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], expect.any(Object));
  } finally { execFileSyncThrottled.mockImplementation(real); }
});
