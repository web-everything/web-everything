/**
 * @file skills-src/conveyor/__tests__/runner.test.mjs
 * @description Unit proof of the conveyor HEADLESS RUNNER (WE #2702, epic #2677(b), the DELEGATE half) — the
 *   SINGLETON-LOCKED, no-LLM runner that drives the mechanized tick core. Two subjects, both driven with plain
 *   objects / a REAL temp lock root (never the machine-global home dir) and an injected clock — no git/network,
 *   no LLM, no real lease:
 *
 *   • the SINGLETON LOCK ({@link ../runner-lock.mjs}) — the #2701 build-condition-2 sole-driver right: a second
 *     runner NO-OPS on a live lease, a STALE lease is reclaimable, heartbeat/release fence on ownership;
 *   • the RUNNER'S CONTROL FLOW ({@link ../runner.mjs} pure core) — it threads the core's `nextState` forward
 *     UNCHANGED (the thin-shell invariant: it never re-derives a guard), surfaces every tick's decisions,
 *     stops on the core's idle-stop and on the tick budget, and stops when its singleton lease is lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLockEntry } from '../../../scripts/readiness/file-locks.mjs';
import {
  RUNNER_LEASE_PATH,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned, runnerLeaseStatus,
} from '../runner-lock.mjs';
import {
  carryForward, shouldStop, tickSurface, runLoop, driveConveyor, DEFAULT_TICK_INTERVAL_MS,
} from '../runner.mjs';

const T0 = Date.parse('2026-07-27T12:00:00.000Z');
const MIN = 60_000;

// ── (1) the singleton lock — sole-driver right (#2701 build condition 2) ────────────────────────────────────

describe('runner singleton lease — two runners never both drive', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-lock-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('the first runner wins the lease; a SECOND live launch NO-OPS (held)', () => {
    const a = acquireRunnerLease(root, 'A', { nowMs: T0 });
    expect(a).toMatchObject({ ok: true });
    // B launches while A's lease is fresh → blocked, told who holds it, so B stands down instead of driving.
    const b = acquireRunnerLease(root, 'B', { nowMs: T0 + 1000, leaseMinutes: 15 });
    expect(b.ok).toBe(false);
    expect(b.heldBy).toBe('A');
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('A'); // A still owns it — B never stomped
  });

  it('a STALE lease (a crashed runner) is RECLAIMABLE via the TTL', () => {
    acquireRunnerLease(root, 'DEAD', { nowMs: T0, leaseMinutes: 15 });
    // 16 min later the heartbeat is older than the 15-min lease → a fresh runner reclaims it.
    const fresh = acquireRunnerLease(root, 'FRESH', { nowMs: T0 + 16 * MIN, leaseMinutes: 15 });
    expect(fresh.ok).toBe(true);
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('FRESH');
  });

  it('heartbeat extends an OWNED lease and is a no-op once reclaimed away', () => {
    acquireRunnerLease(root, 'A', { nowMs: T0, leaseMinutes: 15 });
    expect(heartbeatRunnerLease(root, 'A', { nowMs: T0 + 1 * MIN })).toBe(true);
    // Another runner reclaims A's now-stale lease; A's later heartbeat must NOT resurrect its ownership.
    acquireRunnerLease(root, 'B', { nowMs: T0 + 20 * MIN, leaseMinutes: 15 });
    expect(heartbeatRunnerLease(root, 'A', { nowMs: T0 + 21 * MIN })).toBe(false);
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('B');
  });

  it('release fences on ownership — a reclaimed owner never stomps the new holder', () => {
    acquireRunnerLease(root, 'A', { nowMs: T0, leaseMinutes: 15 });
    acquireRunnerLease(root, 'B', { nowMs: T0 + 20 * MIN, leaseMinutes: 15 }); // B reclaims A's stale lease
    expect(releaseRunnerLeaseIfOwned(root, 'A')).toBe(false);                   // A's late release is a no-op
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('B');             // B's lease intact
    expect(releaseRunnerLeaseIfOwned(root, 'B')).toBe(true);                    // the true owner releases
    expect(readLockEntry(root, RUNNER_LEASE_PATH)).toBeNull();
  });

  it('runnerLeaseStatus reports held / stale / absent', () => {
    expect(runnerLeaseStatus(root, { nowMs: T0 })).toMatchObject({ held: false, stale: false, owner: null });
    acquireRunnerLease(root, 'A', { nowMs: T0, leaseMinutes: 15 });
    expect(runnerLeaseStatus(root, { nowMs: T0 + 1 * MIN, leaseMinutes: 15 })).toMatchObject({ held: true, stale: false, owner: 'A' });
    expect(runnerLeaseStatus(root, { nowMs: T0 + 16 * MIN, leaseMinutes: 15 })).toMatchObject({ held: false, stale: true, owner: 'A' });
  });
});

// ── (2) the runner's pure control flow — thin shell over the core ───────────────────────────────────────────

describe('carryForward — threads the core nextState UNCHANGED (never re-derives a guard)', () => {
  it('carries nextState verbatim into the next tick payload', () => {
    const nextState = { tick: 4, buildGuards: [{ num: 7, lane: 2, spawnedTick: 3 }], watched: [{ pr: 9 }] };
    const payload = carryForward({ nextState });
    expect(payload.bookkeeping).toBe(nextState);   // SAME object — no copy, no mutation, no re-derivation
    expect(payload.signals).toEqual({});
  });
  it('defaults to empty bookkeeping when the core returned no nextState', () => {
    expect(carryForward({}).bookkeeping).toEqual({});
    expect(carryForward(null).bookkeeping).toEqual({});
  });
  it('passes through only observed signals the runner may add', () => {
    const payload = carryForward({ nextState: { tick: 1 } }, { signals: { returnedBuildNums: [5] } });
    expect(payload.signals).toEqual({ returnedBuildNums: [5] });
  });
});

describe('shouldStop — the two mechanical stop conditions, both from the core', () => {
  it('stops on the core idle-stop', () => {
    expect(shouldStop({ decisions: { idleStop: true } }, { tick: 0, maxTicks: Infinity })).toEqual({ stop: true, reason: 'idle-stop' });
  });
  it('stops when the tick budget is spent (--once ⇒ maxTicks 1)', () => {
    expect(shouldStop({ decisions: { idleStop: false } }, { tick: 0, maxTicks: 1 })).toEqual({ stop: true, reason: 'max-ticks' });
  });
  it('keeps going while neither condition holds', () => {
    expect(shouldStop({ decisions: { idleStop: false } }, { tick: 0, maxTicks: Infinity })).toEqual({ stop: false, reason: null });
    expect(shouldStop({ decisions: { idleStop: false } }, { tick: 3, maxTicks: 10 })).toEqual({ stop: false, reason: null });
  });
});

describe('tickSurface — a faithful projection of the core decisions (drops nothing, invents nothing)', () => {
  it('projects status, notes, every dispatch kind, and watchers', () => {
    const out = { decisions: {
      statusLine: 'conveyor · 2 building',
      notes: [{ kind: 'build-ttl', text: '⚠ re-dispatching' }],
      spawnBuilds: [{ num: 1, lane: 1 }], spawnPrepareScope: [{ num: 2, lane: 2 }],
      spawnPrepareDecision: [{ num: 3, lane: 3 }], spawnFixes: [{ pr: 9 }], spawnCiHeals: [{ pr: 10 }],
      armWatchers: [{ pr: 9, releaseSession: 'conveyor-1' }],
    } };
    const s = tickSurface(out);
    expect(s.statusLine).toBe('conveyor · 2 building');
    expect(s.notes).toHaveLength(1);
    expect(s.dispatch).toEqual({
      builds: [{ num: 1, lane: 1 }], prepareScope: [{ num: 2, lane: 2 }],
      prepareDecision: [{ num: 3, lane: 3 }], fixes: [{ pr: 9 }], ciHeals: [{ pr: 10 }],
    });
    expect(s.armWatchers).toEqual([{ pr: 9, releaseSession: 'conveyor-1' }]);
  });
  it('is total on a bare tick output (all empties, never throws)', () => {
    const s = tickSurface({});
    expect(s).toEqual({ statusLine: '', notes: [], dispatch: { builds: [], prepareScope: [], prepareDecision: [], fixes: [], ciHeals: [] }, armWatchers: [] });
  });
});

describe('runLoop — the runner control flow over injected effects', () => {
  it('defaults the tick interval to the SKILL heartbeat', () => {
    expect(DEFAULT_TICK_INTERVAL_MS).toBe(120_000);
  });

  it('steps the core, carries nextState forward UNCHANGED, and stops on idle-stop', async () => {
    // Tick 0 returns a live plan + nextState; tick 1 the core reports idle-stop → the loop stops after it.
    const outs = [
      { decisions: { idleStop: false, statusLine: 't0', spawnBuilds: [{ num: 5, lane: 1 }] }, nextState: { tick: 1, buildGuards: [{ num: 5, lane: 1, spawnedTick: 0 }] } },
      { decisions: { idleStop: true, statusLine: 't1' }, nextState: { tick: 2, buildGuards: [] } },
    ];
    const seenPayloads = [];
    const emitted = [];
    let heartbeats = 0;
    const res = await runLoop({
      tickOnce: (payload) => { seenPayloads.push(payload); return outs[Math.min(seenPayloads.length - 1, outs.length - 1)]; },
      emit: (s) => emitted.push(s),
      heartbeat: () => { heartbeats++; return true; },
      sleep: () => {},
      maxTicks: Infinity,
      initial: { bootstrap: true },
    });
    expect(res.stoppedReason).toBe('idle-stop');
    expect(res.ticks).toBe(2);
    // Tick 0 saw the bootstrap payload; tick 1 saw EXACTLY the core's tick-0 nextState (threaded unchanged).
    expect(seenPayloads[0]).toEqual({ bootstrap: true });
    expect(seenPayloads[1].bookkeeping).toEqual({ tick: 1, buildGuards: [{ num: 5, lane: 1, spawnedTick: 0 }] });
    // Every tick surfaced; a heartbeat only between ticks (once), not after the terminal idle tick.
    expect(emitted.map((e) => e.statusLine)).toEqual(['t0', 't1']);
    expect(heartbeats).toBe(1);
  });

  it('respects the --once / max-ticks budget', async () => {
    let calls = 0;
    const res = await runLoop({
      tickOnce: () => { calls++; return { decisions: { idleStop: false }, nextState: { tick: calls } }; },
      sleep: () => {},
      maxTicks: 1,
    });
    expect(res.stoppedReason).toBe('max-ticks');
    expect(calls).toBe(1);
  });

  it('STOPS when the singleton lease is lost (reclaimed away mid-run)', async () => {
    // The heartbeat returns false on the 2nd tick — the runner went stale and another process took the lease.
    let n = 0;
    const res = await runLoop({
      tickOnce: () => ({ decisions: { idleStop: false }, nextState: { tick: ++n } }),
      heartbeat: () => n < 2,   // tick 0 heartbeat ok, tick 1 heartbeat lost
      sleep: () => {},
      maxTicks: Infinity,
    });
    expect(res.stoppedReason).toBe('lease-lost');
    expect(res.ticks).toBe(2);
  });

  it('a throwing mechanical pass never wedges the loop (best-effort §4b/§4c)', async () => {
    const res = await runLoop({
      tickOnce: () => ({ decisions: { idleStop: true }, nextState: {} }),
      mechanicalPasses: () => { throw new Error('reaper blew up'); },
      sleep: () => {},
    });
    expect(res.stoppedReason).toBe('idle-stop');  // the throw was swallowed; the tick still completed
  });

  it('requires a tickOnce effect', async () => {
    await expect(runLoop({})).rejects.toThrow(/tickOnce/);
  });
});

// ── (2b) dispatchPass (#3383) — the runner carries the DISPATCH PASS's nextState forward, not the raw tick's ─

describe('runLoop — dispatchPass (#3383): carries the dispatch pass\'s nextState forward, fails soft', () => {
  it('the NEXT tick sees the dispatch pass\'s nextState, not the raw tick\'s own', async () => {
    // Tick 0's own raw nextState says `{ tick: 1, from: 'raw' }`; a fake dispatchPass (standing in for
    // `dispatch-lane`'s nested tick-core read actually recording the new guard) returns a DIFFERENT one. The
    // second `tickOnce` call must receive the dispatch pass's copy, per the file header's #3383 rationale.
    const seenPayloads = [];
    const res = await runLoop({
      tickOnce: (payload) => {
        seenPayloads.push(payload);
        return seenPayloads.length === 1
          ? { decisions: { idleStop: false }, nextState: { tick: 1, from: 'raw' } }
          : { decisions: { idleStop: true }, nextState: { tick: 2, from: 'raw' } };
      },
      dispatchPass: async () => ({ nextState: { tick: 1, from: 'dispatch-pass' } }),
      sleep: () => {},
      maxTicks: 2,
    });
    expect(res.ticks).toBe(2);
    expect(seenPayloads[1].bookkeeping).toEqual({ tick: 1, from: 'dispatch-pass' });
  });

  it('the DEFAULT dispatchPass (omitted) is an identity pass-through — legacy behaviour is preserved', async () => {
    // No override supplied: the next tick's payload must carry the SAME nextState the tick itself produced.
    const seenPayloads = [];
    const res = await runLoop({
      tickOnce: (payload) => {
        seenPayloads.push(payload);
        return seenPayloads.length === 1
          ? { decisions: { idleStop: false }, nextState: { tick: 1, from: 'raw' } }
          : { decisions: { idleStop: true }, nextState: { tick: 2, from: 'raw' } };
      },
      sleep: () => {},
      maxTicks: 2,
    });
    expect(res.ticks).toBe(2);
    expect(seenPayloads[1].bookkeeping).toEqual({ tick: 1, from: 'raw' });
  });

  it('a THROWING dispatchPass fails soft — the loop keeps going and falls back to the raw tick nextState', async () => {
    const seenPayloads = [];
    const res = await runLoop({
      tickOnce: (payload) => {
        seenPayloads.push(payload);
        return seenPayloads.length === 1
          ? { decisions: { idleStop: false }, nextState: { tick: 1, from: 'raw' } }
          : { decisions: { idleStop: true }, nextState: { tick: 2, from: 'raw' } };
      },
      dispatchPass: async () => { throw new Error('dispatch-lane exploded'); },
      sleep: () => {},
      maxTicks: 2,
    });
    // The loop never crashed and completed both ticks; the second tick's payload falls back to tick 0's own
    // raw nextState (the pre-throw default set before `dispatchPass` is awaited).
    expect(res.ticks).toBe(2);
    expect(seenPayloads[1].bookkeeping).toEqual({ tick: 1, from: 'raw' });
  });
});

// ── (3) driveConveyor — the lease lifecycle: ALWAYS released, never behind process.exit ─────────────────────

describe('driveConveyor — acquire → drive → ALWAYS release (no leaked singleton lease)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-drive-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const boundedEffects = () => ({
    tickOnce: () => ({ decisions: { idleStop: false }, nextState: {} }),
    sleep: () => {},
    maxTicks: 1,
  });

  it('RELEASES the lease on a clean bounded exit (the leak the finally-after-exit bug caused)', async () => {
    const res = await driveConveyor({ lockRoot: root, owner: 'A', buildEffects: boundedEffects });
    expect(res).toMatchObject({ started: true, ticks: 1, stoppedReason: 'max-ticks' });
    // The lease MUST be gone — a next launch inside the TTL would otherwise falsely stand down.
    expect(runnerLeaseStatus(root, { nowMs: Date.now() }).held).toBe(false);
    expect(readLockEntry(root, RUNNER_LEASE_PATH)).toBeNull();
  });

  it('STANDS DOWN on a held lease without touching the incumbent (started:false, no build, no release)', async () => {
    acquireRunnerLease(root, 'INCUMBENT', { leaseMinutes: 15 });
    let built = false;
    const res = await driveConveyor({ lockRoot: root, owner: 'B', buildEffects: () => { built = true; return boundedEffects(); } });
    expect(res).toMatchObject({ started: false, heldBy: 'INCUMBENT' });
    expect(built).toBe(false);                                            // never drove
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('INCUMBENT'); // incumbent's lease untouched
  });

  it('RELEASES the lease even when the loop throws (finally, not behind an exit)', async () => {
    const throwing = () => ({ tickOnce: () => { throw new Error('tick-core exploded'); }, sleep: () => {}, maxTicks: 1 });
    await expect(driveConveyor({ lockRoot: root, owner: 'A', buildEffects: throwing })).rejects.toThrow(/exploded/);
    expect(readLockEntry(root, RUNNER_LEASE_PATH)).toBeNull(); // released despite the throw
  });

  it('requires a buildEffects factory', async () => {
    await expect(driveConveyor({ lockRoot: root, owner: 'A' })).rejects.toThrow(/buildEffects/);
  });
});
