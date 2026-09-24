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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { readLockEntry, reserve as reserveLockDirect } from '../../../scripts/readiness/file-locks.mjs';
import {
  RUNNER_LEASE_PATH,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned, runnerLeaseStatus,
  probeRunnerLeaseLiveness,
} from '../runner-lock.mjs';
import {
  carryForward, shouldStop, tickSurface, runLoop, driveConveyor, DEFAULT_TICK_INTERVAL_MS,
  summarizeMechanicalPassError, MECHANICAL_PASS_ERROR_LOG_CHARS, makeCliMechanicalPasses,
  writeDriverStatus, appendDecisionTrace, DRIVER_STATUS_FILENAME,
  MECHANICAL_PASS_NAMES, resolveSkipPasses, wireSelfSyncAndAppAuth,
} from '../runner.mjs';
import { localDateString } from '../../../scripts/lib/local-date.mjs';

// Keep real exports for transitive imports; inject the mocked exec into the runner.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn() };
});

// Keep the real fetch builder while replacing throttle effects (no machine-global locks or real gh).
vi.mock('../../../scripts/lib/gh-throttle.mjs', async () => {
  const { execFileSync } = await import('node:child_process');
  return {
    runGhSync: (args, opts) => execFileSync('gh', args, opts),
    execFileSyncThrottled: (file, args, opts) => execFileSync(file, args, opts),
  };
});

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

  // #3877 — a distinct `key` is a wholly independent lock dir: a second daemon takes its own singleton lease
  // from this SAME primitive without contending with (or being visible to) the default-keyed one.
  it('a distinct key is an independent lease — default-key callers never see it, and vice versa', () => {
    const DISPATCHER_KEY = RUNNER_LEASE_PATH; // the default every existing caller already uses, unchanged
    const VERIFY_KEY = '<conveyor:verify-daemon-lease>';
    expect(acquireRunnerLease(root, 'DISPATCHER', { nowMs: T0, key: DISPATCHER_KEY })).toMatchObject({ ok: true });
    // The Verify daemon's OWN key is untouched by the Dispatcher's live lease — no false 'held'.
    expect(acquireRunnerLease(root, 'VERIFY', { nowMs: T0, key: VERIFY_KEY })).toMatchObject({ ok: true });
    expect(runnerLeaseStatus(root, { nowMs: T0, key: DISPATCHER_KEY })).toMatchObject({ held: true, owner: 'DISPATCHER' });
    expect(runnerLeaseStatus(root, { nowMs: T0, key: VERIFY_KEY })).toMatchObject({ held: true, owner: 'VERIFY' });
    // Heartbeating/releasing one key never touches the other.
    expect(heartbeatRunnerLease(root, 'VERIFY', { nowMs: T0 + 1 * MIN, key: VERIFY_KEY })).toBe(true);
    expect(releaseRunnerLeaseIfOwned(root, 'VERIFY', { key: VERIFY_KEY })).toBe(true);
    expect(runnerLeaseStatus(root, { nowMs: T0 + 1 * MIN, key: VERIFY_KEY })).toMatchObject({ held: false, owner: null });
    expect(runnerLeaseStatus(root, { nowMs: T0 + 1 * MIN, key: DISPATCHER_KEY })).toMatchObject({ held: true, owner: 'DISPATCHER' });
  });

  it('omitting `key` is unchanged behavior — every existing call site keeps working with no edits', () => {
    // No `key` passed anywhere here — this is the exact call shape every pre-#3877 caller already uses.
    expect(acquireRunnerLease(root, 'A', { nowMs: T0, leaseMinutes: 15 })).toMatchObject({ ok: true });
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe('A');
    expect(heartbeatRunnerLease(root, 'A', { nowMs: T0 + 1 * MIN })).toBe(true);
    expect(releaseRunnerLeaseIfOwned(root, 'A')).toBe(true);
  });
});

// ── (1b) #3952 — dead-lease reclaim: a force-killed (SIGKILL, e.g. `launchctl kickstart -k` mid-tick)
//         daemon's lease no longer blocks every restart for the full TTL. REAL child processes throughout
//         (never a mocked pid) — a real `process.kill(pid, 0)` is exactly what the fix calls. ───────────────

describe('acquireRunnerLease — #3952 dead-lease fast reclaim (real processes, never mocked)', () => {
  let root;
  let liveChild;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-lock-reclaim-')); });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (liveChild) { try { liveChild.kill('SIGKILL'); } catch { /* already gone */ } liveChild = null; }
  });

  /** A real pid that is now provably dead: spawn a child that exits immediately, then wait (spawnSync
   *  blocks until it exits) — so by the time the pid comes back, `kill(pid, 0)` is guaranteed ESRCH, no
   *  race against the child still shutting down. */
  function deadPid() {
    const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    return res.pid;
  }

  /** A real pid that stays alive for the test — killed in afterEach. */
  function livePid() {
    liveChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    return liveChild.pid;
  }

  it('BEFORE (red without the fix): a lease owned by a dead local pid still blocks acquire inside the TTL', () => {
    // Sanity/regression proof of the OLD behavior this fix changes: `reserve` called with a hardcoded
    // 'unknown' pidLiveness (what acquireRunnerLease did pre-#3952) refuses a dead-pid lease exactly like a
    // live one — the bug. This exercises the SAME primitive (`reserve`) the parent commit's
    // `acquireRunnerLease` called, with the pre-fix argument, to prove the bug was real, not assumed.
    const pid = deadPid();
    const owner = `${hostname()}:${pid}:reconcile-fix-dispatch-daemon`;
    acquireRunnerLease(root, owner, { pid, nowMs: Date.parse('2026-09-23T00:00:00.000Z') });
    expect(readLockEntry(root, RUNNER_LEASE_PATH)).toMatchObject({ owner, pid });

    // Directly reproduce the PRE-FIX call shape (`reserve(..., 'unknown', ...)` — never the fast path),
    // against the SAME real dead pid and the SAME lock dir `acquireRunnerLease` just wrote.
    const staleResult = reserveLockDirect(
      root, RUNNER_LEASE_PATH, 'RELAUNCH', Date.parse('2026-09-23T00:05:00.000Z'), '2026-09-23T00:05:00.000Z',
      process.pid, 'unknown', 15,
    );
    expect(staleResult).toMatchObject({ ok: false, reason: 'held', heldBy: owner }); // the bug: refused for the full TTL
  });

  it('AFTER (green): a real dead-on-this-host owner is reclaimed immediately, well inside the TTL', () => {
    const pid = deadPid();
    const owner = `${hostname()}:${pid}:reconcile-fix-dispatch-daemon`;
    const t0 = Date.parse('2026-09-23T00:00:00.000Z');
    acquireRunnerLease(root, owner, { pid, nowMs: t0, leaseMinutes: 15 });
    expect(readLockEntry(root, RUNNER_LEASE_PATH)).toMatchObject({ owner, pid });

    // Only 30s later — nowhere near the 15-min TTL — a relaunch reclaims at once via the fixed pid probe.
    const relaunchOwner = `${hostname()}:${process.pid}:reconcile-fix-dispatch-daemon`;
    const result = acquireRunnerLease(root, relaunchOwner, { pid: process.pid, nowMs: t0 + 30_000, leaseMinutes: 15 });
    expect(result).toMatchObject({ ok: true, reason: 'pid-dead', heldBy: relaunchOwner });
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe(relaunchOwner);
  });

  it('a lease held by a LIVE pid is still refused (no early reclaim) even on the same host', () => {
    const pid = livePid();
    const owner = `${hostname()}:${pid}:reconcile-fix-dispatch-daemon`;
    const t0 = Date.parse('2026-09-23T00:00:00.000Z');
    acquireRunnerLease(root, owner, { pid, nowMs: t0, leaseMinutes: 15 });

    const relaunchOwner = `${hostname()}:${process.pid}:reconcile-fix-dispatch-daemon`;
    const result = acquireRunnerLease(root, relaunchOwner, { pid: process.pid, nowMs: t0 + 30_000, leaseMinutes: 15 });
    expect(result).toMatchObject({ ok: false, reason: 'held', heldBy: owner });
    expect(readLockEntry(root, RUNNER_LEASE_PATH).owner).toBe(owner); // untouched
  });

  it('a lease recorded for a DIFFERENT host is NEVER fast-reclaimed, even if this host happens to have a live process at that pid', () => {
    // Use OUR OWN real, live pid, but attribute it to a fictitious foreign host — proves the host check,
    // not just the liveness probe: a live match on pid alone must never be enough.
    const owner = `some-other-mac.local:${process.pid}:reconcile-fix-dispatch-daemon`;
    const t0 = Date.parse('2026-09-23T00:00:00.000Z');
    acquireRunnerLease(root, owner, { pid: process.pid, nowMs: t0, leaseMinutes: 15 });

    const relaunchOwner = `${hostname()}:${process.pid + 1}:reconcile-fix-dispatch-daemon`;
    const result = acquireRunnerLease(root, relaunchOwner, { pid: process.pid + 1, nowMs: t0 + 30_000, leaseMinutes: 15 });
    expect(result).toMatchObject({ ok: false, reason: 'held', heldBy: owner }); // TTL-only; not fast-reclaimed
  });

  it('probeRunnerLeaseLiveness — dead/alive/unknown/foreign-host verdicts directly', () => {
    const deadP = deadPid();
    const liveP = livePid();
    expect(probeRunnerLeaseLiveness({ owner: `${hostname()}:${deadP}:k`, pid: deadP })).toBe('dead');
    expect(probeRunnerLeaseLiveness({ owner: `${hostname()}:${liveP}:k`, pid: liveP })).toBe('alive');
    expect(probeRunnerLeaseLiveness({ owner: `other-host:${deadP}:k`, pid: deadP })).toBe('unknown');
    expect(probeRunnerLeaseLiveness(null)).toBe('unknown');
    expect(probeRunnerLeaseLiveness({ owner: `${hostname()}:x:k`, pid: null })).toBe('unknown');
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
      stalled: [{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }],
      decisionTrace: [{ kind: 'dispatch', num: 1, text: 'dispatched #1 to lane-1: build' }],
    } };
    const s = tickSurface(out);
    expect(s.statusLine).toBe('conveyor · 2 building');
    expect(s.notes).toHaveLength(1);
    expect(s.dispatch).toEqual({
      builds: [{ num: 1, lane: 1 }], prepareScope: [{ num: 2, lane: 2 }],
      prepareDecision: [{ num: 3, lane: 3 }], fixes: [{ pr: 9 }], ciHeals: [{ pr: 10 }],
    });
    expect(s.armWatchers).toEqual([{ pr: 9, releaseSession: 'conveyor-1' }]);
    // 2026-09-14 (#3521/lane-2 incident) — the self-diagnosed stall list and the plain-language decision trace
    // are projected through just as faithfully as every other decisions field.
    expect(s.stalled).toEqual([{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }]);
    expect(s.decisionTrace).toEqual([{ kind: 'dispatch', num: 1, text: 'dispatched #1 to lane-1: build' }]);
  });
  it('is total on a bare tick output (all empties, never throws)', () => {
    const s = tickSurface({});
    expect(s).toEqual({
      statusLine: '', notes: [], dispatch: { builds: [], prepareScope: [], prepareDecision: [], fixes: [], ciHeals: [] },
      armWatchers: [], stalled: [], decisionTrace: [],
    });
  });
});

describe('writeDriverStatus — the durable EXTERNAL status file (2026-09-14, #3521/lane-2 incident)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'driver-status-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('writes tick, timestamp, statusLine, stalled, and dispatch — readable by a separate process', () => {
    const path = join(root, '.conveyor', DRIVER_STATUS_FILENAME);
    const surface = {
      statusLine: 'conveyor · 1 building',
      stalled: [{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }],
      dispatch: { builds: [{ num: 1, lane: 1 }], prepareScope: [], prepareDecision: [], fixes: [], ciHeals: [] },
    };
    writeDriverStatus(path, { tick: 7 }, surface);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.tick).toBe(7);
    expect(typeof written.at).toBe('string');
    expect(written.statusLine).toBe('conveyor · 1 building');
    expect(written.stalled).toEqual([{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }]);
    expect(written.dispatch.builds).toEqual([{ num: 1, lane: 1 }]);
  });

  it('overwrites (not appends) on the next tick — the file always reflects only the LATEST tick', () => {
    const path = join(root, '.conveyor', DRIVER_STATUS_FILENAME);
    writeDriverStatus(path, { tick: 1 }, { statusLine: 'a', stalled: [], dispatch: {} });
    writeDriverStatus(path, { tick: 2 }, { statusLine: 'b', stalled: [], dispatch: {} });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.tick).toBe(2);
    expect(written.statusLine).toBe('b');
  });

  it('never throws on an unwritable path (best-effort — a status write must never wedge the tick)', () => {
    expect(() => writeDriverStatus('/nonexistent-root-xyz/.conveyor/driver-status.json', { tick: 0 }, { statusLine: '', stalled: [], dispatch: {} })).not.toThrow();
  });
});

describe('appendDecisionTrace — the durable, day-sharded decision-trace JSONL sidecar (2026-09-14, #3521 decision-trace v1)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'decision-trace-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('appends one JSON line per trace entry, each carrying the tick and a timestamp', () => {
    const dir = join(root, '.conveyor', 'decision-trace');
    appendDecisionTrace(dir, { tick: 3 }, [
      { kind: 'dispatch', num: 10, text: 'dispatched #10 to lane-4: build' },
      { kind: 'skip', num: 3521, reason: 'overlaps lane-2', text: 'skipped #3521: overlaps lane-2' },
    ]);
    const day = localDateString(new Date());
    const lines = readFileSync(join(dir, `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tick: 3, kind: 'dispatch', num: 10, text: 'dispatched #10 to lane-4: build' });
    expect(lines[1]).toMatchObject({ tick: 3, kind: 'skip', num: 3521, reason: 'overlaps lane-2' });
    expect(typeof lines[0].at).toBe('string');
  });

  it('appends across multiple calls into the SAME day file rather than overwriting', () => {
    const dir = join(root, '.conveyor', 'decision-trace');
    appendDecisionTrace(dir, { tick: 1 }, [{ kind: 'dispatch', num: 1, text: 'a' }]);
    appendDecisionTrace(dir, { tick: 2 }, [{ kind: 'dispatch', num: 2, text: 'b' }]);
    const day = localDateString(new Date());
    const lines = readFileSync(join(dir, `${day}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('is a no-op on an empty/absent entries list — never creates a file for a quiet tick', () => {
    const dir = join(root, '.conveyor', 'decision-trace');
    appendDecisionTrace(dir, { tick: 1 }, []);
    appendDecisionTrace(dir, { tick: 2 }, null);
    expect(existsSync(join(dir, `${localDateString(new Date())}.jsonl`))).toBe(false);
  });

  it('never throws on an unwritable path (best-effort)', () => {
    expect(() => appendDecisionTrace('/nonexistent-root-xyz/.conveyor/decision-trace', { tick: 0 }, [{ kind: 'dispatch', num: 1, text: 'x' }])).not.toThrow();
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

// ── (4) summarizeMechanicalPassError — WE #3479, found live 2026-09-04 investigating a silent-looking
//        session-reaper.mjs tick failure ────────────────────────────────────────────────────────────────────

describe('summarizeMechanicalPassError — the real error, not just execFileSync\'s first "Command failed" line', () => {
  it('keeps the child stderr Node appends to `.message`, not just the leading "Command failed: <cmd>" line', () => {
    // Reproduces exactly what a real `execFileSync` throw looks like: Node appends the captured stderr to
    // `.message` after the "Command failed: ..." line — this is the shape the OLD `.split(\'\\n\')[0]` threw
    // away, live, for the one session-reaper.mjs failure this file's own commit is fixing.
    const e = new Error(
      'Command failed: node /Users/x/scripts/conveyor/session-reaper.mjs\n' +
        '  ⚠ abcd1234: stop failed after 3 attempts (dispatch-abort: `claude stop abcd1234` failed: some transient CLI lock) — left for the next tick\n' +
        'session-reaper: 40 session(s) listed · 12 stopped, 1 failed · 27 kept',
    );
    const summary = summarizeMechanicalPassError(e);
    expect(summary).toContain('stop failed after 3 attempts');
    expect(summary).toContain('transient CLI lock');
    expect(summary).toContain('session-reaper: 40 session(s) listed');
  });

  it('collapses newlines so a multi-line error still logs as ONE line', () => {
    const summary = summarizeMechanicalPassError(new Error('line one\nline two\nline three'));
    expect(summary).not.toContain('\n');
    expect(summary).toBe('line one line two line three');
  });

  it('is bounded — a runaway message never floods the log unbounded', () => {
    const huge = new Error('x'.repeat(5000));
    const summary = summarizeMechanicalPassError(huge);
    expect(summary.length).toBeLessThanOrEqual(MECHANICAL_PASS_ERROR_LOG_CHARS);
  });

  it('falls back to String(e) for a non-Error thrown value', () => {
    expect(summarizeMechanicalPassError('a plain string failure')).toBe('a plain string failure');
  });
});

// ── (5) makeCliMechanicalPasses' review-reconcile block — x5v8yy9 review finding, 2026-09-05: before this
//        fix, `review-round-tag.mjs` ran unconditionally after `review-dispatch.mjs`, even when the dispatch
//        attempt itself threw and no session was ever spawned — so a PR's `review-round:<N>` label kept
//        advancing every tick regardless of whether a review actually happened ─────────────────────────────

describe('makeCliMechanicalPasses — the review-reconcile dispatch block never advances review-round on a failed dispatch', () => {
  /** Route each mocked `execFileSync` call by which script it invokes, recording every call along the way. */
  function makeExecFileSyncRouter({ plan, dispatchThrows = false }) {
    const calls = [];
    return {
      calls,
      execFileSync: vi.fn((cmd, args) => {
        calls.push([cmd, ...args]);
        const joined = args.join(' ');
        if (joined.includes('reconcile-pass.mjs')) return JSON.stringify(plan);
        if (cmd === 'gh' && args.includes('repo') && args.includes('view')) return 'chalbert/web-everything';
        if (joined.includes('review-dispatch.mjs')) {
          if (dispatchThrows) throw new Error('review-dispatch.mjs: assertMainNotStale tripped');
          return '';
        }
        return ''; // every other best-effort pass (infra-blocked, lease-reaper, review-round-tag, review-status-tag, ...)
      }),
    };
  }

  it('SKIPS review-round-tag.mjs for a PR whose review-dispatch.mjs call threw', async () => {
    const { execFileSync, calls } = makeExecFileSyncRouter({
      dispatchThrows: true,
      plan: { dispatch: [{ kind: 'review', prNumber: 99, attempts: 0 }], refusals: [] },
    });
    const cp = await import('node:child_process');
    cp.execFileSync.mockImplementation(execFileSync);

    const mechanicalPasses = makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync });
    await mechanicalPasses({ out: {} });

    const dispatchCalls = calls.filter((c) => c.join(' ').includes('review-dispatch.mjs'));
    const roundTagCalls = calls.filter((c) => c.join(' ').includes('review-round-tag.mjs'));
    expect(dispatchCalls).toHaveLength(1); // the dispatch WAS attempted
    expect(roundTagCalls).toHaveLength(0); // but the round label must NOT advance — nothing was spawned
  });

  it('DOES run review-round-tag.mjs when the dispatch actually succeeds', async () => {
    const { execFileSync, calls } = makeExecFileSyncRouter({
      dispatchThrows: false,
      plan: { dispatch: [{ kind: 'review', prNumber: 99, attempts: 2 }], refusals: [] },
    });
    const cp = await import('node:child_process');
    cp.execFileSync.mockImplementation(execFileSync);

    const mechanicalPasses = makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync });
    await mechanicalPasses({ out: {} });

    const roundTagCalls = calls.filter((c) => c.join(' ').includes('review-round-tag.mjs'));
    expect(roundTagCalls).toHaveLength(1);
    expect(roundTagCalls[0]).toEqual(expect.arrayContaining(['99', '--repo=chalbert/web-everything', '--round=3']));
  });

  it('still runs the informative review-status-tag.mjs sweep even when the dispatch above it failed', async () => {
    const { execFileSync, calls } = makeExecFileSyncRouter({
      dispatchThrows: true,
      plan: { dispatch: [{ kind: 'review', prNumber: 99, attempts: 0 }], refusals: [] },
    });
    const cp = await import('node:child_process');
    cp.execFileSync.mockImplementation(execFileSync);

    const mechanicalPasses = makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync });
    await mechanicalPasses({ out: {} });

    const statusTagCalls = calls.filter((c) => c.join(' ').includes('review-status-tag.mjs'));
    expect(statusTagCalls).toHaveLength(1); // reviewsOwed still feeds selectStatusCandidates regardless
  });
});

// ── (6) makeCliMechanicalPasses' OWN "does it still invoke every mechanical pass" proof — xb4fjir, filed as
//        the OWED prevention on the #1949 review finding (2026-09-05): before this test, deleting any single
//        `runQuiet('conveyor/<pass>.mjs', …)` line reddened nothing here — this file only ever mocked
//        `execFileSync` generically and asserted individual passes' own behavior, never the SET the function
//        invokes each tick. A future refactor/reorder/accidental deletion could silently drop a mechanical
//        pass (e.g. `duplicate-pr-watch.mjs`, `parked-pr-conflict-watch.mjs`) with nothing here noticing —
//        exactly the failure class #xs19sz9's own duplicate-PR watch exists to catch, made invisible again by
//        its own wiring silently regressing. ─────────────────────────────────────────────────────────────

describe('makeCliMechanicalPasses — invokes the exact set of mechanical passes, in order, every tick', () => {
  it('a plain tick (no reconcile findings) runs exactly this ordered script list, with --repo threaded through', async () => {
    const calls = [];
    const execFileSync = vi.fn((cmd, args) => {
      calls.push([cmd, ...args]);
      const joined = args.join(' ');
      if (joined.includes('reconcile-pass.mjs')) return JSON.stringify({ dispatch: [], refusals: [] });
      return ''; // every other best-effort pass — this test only cares WHICH scripts run, not their own output
    });
    const cp = await import('node:child_process');
    cp.execFileSync.mockImplementation(execFileSync);

    const mechanicalPasses = makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync });
    await mechanicalPasses({ out: {} });

    // The exact relative script path (or literal flag) each call carries, in the order `execFileSync` saw them
    // — mutating this list is the mechanical check: delete/reorder/rename a `runQuiet(...)` line above and this
    // assertion goes red, which is the whole point (a `grep` for the added line, this PR's own backlog card
    // cited as its only prior check, catches none of that).
    expect(calls.filter((c) => c[0] === 'node').map((c) => c.filter((a) => !a.startsWith('--prs-file=')).join(' '))).toEqual([
      'node /scripts/conveyor/infra-blocked.mjs retry --repo=chalbert/web-everything',
      'node /scripts/conveyor/lease-reaper.mjs --repo=chalbert/web-everything',
      'node /scripts/conveyor/session-reaper.mjs --repo=chalbert/web-everything',
      'node /scripts/conveyor/branch-drift.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/lane-pool-health-watch.mjs --repo=chalbert/web-everything',
      'node /scripts/operations/operator-notify.mjs --once --repo=chalbert/web-everything',
      'node /scripts/conveyor/reconcile-fix-dispatch.mjs --repo=chalbert/web-everything',
      'node /scripts/conveyor/ci-queue-watch.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/parked-pr-conflict-watch.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/advisory-label-sweep.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/review-hold-reconcile.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/reconcile-pass.mjs --json --repo=chalbert/web-everything',
      'node /scripts/conveyor/duplicate-pr-watch.mjs sweep --repo=chalbert/web-everything',
      'node /scripts/conveyor/parked-pr-progress-watch.mjs sweep --repo=chalbert/web-everything',
    ]);
  });
});


// Emulate only the five named subprocesses' discovery at the mocked boundary. The separate
// reconcile-fix-dispatch invocation deliberately remains opaque and contributes no calls here.
import { defaultListOpenPrs } from '../../../scripts/conveyor/duplicate-pr-watch.mjs';
import { defaultListParkedPrs as listConflicts } from '../../../scripts/conveyor/parked-pr-conflict-watch.mjs';
import { defaultListParkedPrs as listProgress } from '../../../scripts/conveyor/parked-pr-progress-watch.mjs';
import { defaultListPrs as listAdvisory } from '../../../scripts/conveyor/advisory-label-sweep.mjs';
import { defaultReadPrs } from '../../../scripts/conveyor/reconcile-pass.mjs';
import { OPEN_PR_LIST_FIELDS } from '../../../scripts/conveyor/open-pr-fetch.mjs';

const consumers = {
  'parked-pr-conflict-watch.mjs': listConflicts,
  'advisory-label-sweep.mjs': listAdvisory,
  // #x01u7az — the sibling sweep piggybacks on the SAME shared snapshot AND the same standalone-fallback
  // reader (it reuses `advisory-label-sweep.mjs#defaultListPrs` directly rather than a second copy).
  'review-hold-reconcile.mjs': listAdvisory,
  'reconcile-pass.mjs': defaultReadPrs,
  'duplicate-pr-watch.mjs': defaultListOpenPrs,
  'parked-pr-progress-watch.mjs': listProgress,
};

describe('one open-PR snapshot per mechanical tick', () => {
  async function tick({ fetchThrows = false, consumerThrows = false, ticks = 1 } = {}) {
    const cp = await import('node:child_process');
    const calls = [];
    const files = [];
    const snapshots = [];
    const fixture = [{ number: 42, body: 'snapshot retained intact', files: [{ path: 'scripts/example.mjs' }] }];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cp.execFileSync.mockImplementation((cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') {
        if (fetchThrows && args.includes(OPEN_PR_LIST_FIELDS)) throw new Error('shared discovery failed');
        return JSON.stringify(fixture);
      }
      const name = args[0].split('/').pop();
      if (consumers[name]) {
        const flag = args.find((a) => a.startsWith('--prs-file='));
        if (flag) {
          const file = flag.slice('--prs-file='.length);
          files.push(file);
          // It exists while each consumer runs and contains the full snapshot.
          snapshots.push(JSON.parse(readFileSync(file, 'utf8')));
        } else {
          consumers[name]({ repo: 'chalbert/web-everything', exec: cp.execFileSync });
        }
        if (consumerThrows) throw new Error('consumer failed');
      }
      return name === 'reconcile-pass.mjs' ? JSON.stringify({ dispatch: [], refusals: [] }) : '';
    });
    try {
      const run = makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync });
      for (let i = 0; i < ticks; i++) await run({ out: {} });
      for (const snapshot of snapshots) expect(snapshot).toEqual(fixture);
      return { calls, files, warnings: stderr.mock.calls.map(([line]) => line) };
    } finally {
      stderr.mockRestore();
    }
  }

  function consumerCalls(calls) {
    return calls.filter(([cmd, script]) => cmd === 'node' && consumers[script.split('/').pop()]);
  }

  it('fetches exactly once and invokes all six consumers once with the same live file, then deletes it', async () => {
    const { calls, files } = await tick();
    const fetches = calls.filter(([cmd, ...args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'list');
    expect(fetches).toEqual([['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', OPEN_PR_LIST_FIELDS, '--repo', 'chalbert/web-everything']]);
    const consumed = consumerCalls(calls);
    for (const call of calls.filter(([cmd, script]) => cmd === 'node' && !consumers[script.split('/').pop()] && !script.endsWith('/reconcile-fix-dispatch.mjs'))) {
      expect(call.some((a) => a.startsWith('--prs-file='))).toBe(false);
    }
    expect(consumed.map((c) => c[1].split('/').pop())).toEqual(Object.keys(consumers));
    expect(files).toHaveLength(6);
    expect(new Set(files).size).toBe(1);
    for (const call of consumed) {
      expect(call).toContain(`--prs-file=${files[0]}`);
      expect(call).toContain(call[1].endsWith('/reconcile-pass.mjs') ? '--json' : 'sweep');
    }
    expect(existsSync(files[0])).toBe(false);
  });

  it('warns once on shared-fetch failure and all six consumers perform their standalone discovery without a flag', async () => {
    const { calls, files, warnings } = await tick({ fetchThrows: true });
    const consumed = consumerCalls(calls);
    expect(consumed.map((c) => c[1].split('/').pop())).toEqual(Object.keys(consumers));
    expect(consumed.flat().some((a) => a.startsWith('--prs-file='))).toBe(false);
    expect(files).toEqual([]);
    expect(calls.filter(([cmd]) => cmd === 'gh')).toHaveLength(7); // failed shared attempt + six fallbacks
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('mechanical pass open-pr-fetch [we] failed (non-fatal): shared discovery failed');
  });

  it('cleans up even when consumers fail, still invoking every consumer', async () => {
    const { calls, files } = await tick({ consumerThrows: true });
    expect(consumerCalls(calls)).toHaveLength(6);
    expect(files).toHaveLength(6);
    for (const file of files) expect(existsSync(file)).toBe(false);
  });

  it('fetches afresh with a distinct file on the next tick', async () => {
    const { calls, files } = await tick({ ticks: 2 });
    expect(calls.filter(([cmd]) => cmd === 'gh')).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    for (const file of files) expect(existsSync(file)).toBe(false);
  });
});

// ── (7) --skip-pass — resolveSkipPasses' typo-safety refusal and repeatable-flag acceptance ──────────────────

describe('resolveSkipPasses — typo-safety for --skip-pass (repeatable)', () => {
  it('accepts a single known name', () => {
    expect(resolveSkipPasses('reconcile-fix-dispatch')).toEqual({ ok: true, skipPasses: new Set(['reconcile-fix-dispatch']) });
  });

  it('accepts several repeated known names as an array (what parseFlags produces for a repeated flag)', () => {
    const names = ['reconcile-fix-dispatch', 'parked-pr-conflict-watch', 'lane-pool-health-watch', 'reconcile-pass'];
    const result = resolveSkipPasses(names);
    expect(result.ok).toBe(true);
    expect(result.skipPasses).toEqual(new Set(names));
  });

  it('no flag at all → an empty skip set, not a refusal', () => {
    expect(resolveSkipPasses(undefined)).toEqual({ ok: true, skipPasses: new Set() });
  });

  it('refuses a single unknown/typo name, naming it', () => {
    const result = resolveSkipPasses('reconcile-fix-dispach'); // typo: missing 't'
    expect(result).toEqual({ ok: false, unknown: ['reconcile-fix-dispach'] });
  });

  it('refuses the WHOLE set when even one of several repeated names is unknown', () => {
    const result = resolveSkipPasses(['reconcile-fix-dispatch', 'not-a-real-pass']);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['not-a-real-pass']);
  });

  it('every name MECHANICAL_PASS_NAMES itself declares is individually accepted', () => {
    for (const name of MECHANICAL_PASS_NAMES) {
      expect(resolveSkipPasses(name).ok).toBe(true);
    }
  });
});

// ── (8) makeCliMechanicalPasses honors skipPasses — a skipped pass is not run at all, and the reconcile-pass
//        → review-dispatch → review-round-tag/review-status-tag sequence skips as ONE unit ──────────────────

describe('makeCliMechanicalPasses — skipPasses omits exactly the named pass(es), nothing else', () => {
  async function runWithSkip(skipPasses) {
    const calls = [];
    const execFileSync = vi.fn((cmd, args) => {
      calls.push([cmd, ...args]);
      const joined = args.join(' ');
      if (joined.includes('reconcile-pass.mjs')) return JSON.stringify({ dispatch: [{ kind: 'review', prNumber: 7, attempts: 0 }], refusals: [] });
      return '';
    });
    const cp = await import('node:child_process');
    cp.execFileSync.mockImplementation(execFileSync);
    const mechanicalPasses = makeCliMechanicalPasses({
      scriptsDir: '/scripts', repo: 'chalbert/web-everything', exec: cp.execFileSync, skipPasses,
    });
    await mechanicalPasses({ out: {} });
    return calls.filter((c) => c[0] === 'node').map((c) => c[1]);
  }

  it('an empty skip set runs every pass (unchanged default behavior)', async () => {
    const paths = await runWithSkip(new Set());
    expect(paths).toEqual(expect.arrayContaining([
      '/scripts/conveyor/reconcile-fix-dispatch.mjs',
      '/scripts/conveyor/parked-pr-conflict-watch.mjs',
      '/scripts/conveyor/lane-pool-health-watch.mjs',
      '/scripts/conveyor/reconcile-pass.mjs',
      '/scripts/operations/review-dispatch.mjs',
      '/scripts/conveyor/review-round-tag.mjs',
    ]));
  });

  it('skipping "reconcile-fix-dispatch" omits only that one script', async () => {
    const paths = await runWithSkip(new Set(['reconcile-fix-dispatch']));
    expect(paths).not.toContain('/scripts/conveyor/reconcile-fix-dispatch.mjs');
    expect(paths).toContain('/scripts/conveyor/parked-pr-conflict-watch.mjs');
    expect(paths).toContain('/scripts/conveyor/reconcile-pass.mjs');
  });

  it('skipping "parked-pr-conflict-watch" omits only that one script', async () => {
    const paths = await runWithSkip(new Set(['parked-pr-conflict-watch']));
    expect(paths).not.toContain('/scripts/conveyor/parked-pr-conflict-watch.mjs');
    expect(paths).toContain('/scripts/conveyor/reconcile-fix-dispatch.mjs');
  });

  it('skipping "lane-pool-health-watch" omits only that one script', async () => {
    const paths = await runWithSkip(new Set(['lane-pool-health-watch']));
    expect(paths).not.toContain('/scripts/conveyor/lane-pool-health-watch.mjs');
    expect(paths).toContain('/scripts/conveyor/infra-blocked.mjs');
  });

  it('skipping "reconcile-pass" drops the WHOLE group — reconcile-pass, review-dispatch, AND review-round-tag — as one unit', async () => {
    const paths = await runWithSkip(new Set(['reconcile-pass']));
    expect(paths).not.toContain('/scripts/conveyor/reconcile-pass.mjs');
    expect(paths).not.toContain('/scripts/operations/review-dispatch.mjs');
    expect(paths).not.toContain('/scripts/conveyor/review-round-tag.mjs');
    expect(paths).not.toContain('/scripts/conveyor/review-status-tag.mjs');
    // everything outside the group still runs
    expect(paths).toContain('/scripts/conveyor/reconcile-fix-dispatch.mjs');
    expect(paths).toContain('/scripts/conveyor/duplicate-pr-watch.mjs');
    expect(paths).toContain('/scripts/conveyor/parked-pr-progress-watch.mjs');
  });

  it('skipping all four daemonized passes together leaves the rest running', async () => {
    const paths = await runWithSkip(new Set(['reconcile-fix-dispatch', 'reconcile-pass', 'parked-pr-conflict-watch', 'lane-pool-health-watch']));
    for (const gone of [
      '/scripts/conveyor/reconcile-fix-dispatch.mjs', '/scripts/conveyor/reconcile-pass.mjs',
      '/scripts/operations/review-dispatch.mjs', '/scripts/conveyor/parked-pr-conflict-watch.mjs',
      '/scripts/conveyor/lane-pool-health-watch.mjs',
    ]) expect(paths).not.toContain(gone);
    for (const kept of [
      '/scripts/conveyor/infra-blocked.mjs', '/scripts/conveyor/lease-reaper.mjs',
      '/scripts/conveyor/session-reaper.mjs', '/scripts/conveyor/branch-drift.mjs',
      '/scripts/conveyor/ci-queue-watch.mjs', '/scripts/conveyor/advisory-label-sweep.mjs',
      '/scripts/conveyor/duplicate-pr-watch.mjs', '/scripts/conveyor/parked-pr-progress-watch.mjs',
    ]) expect(paths).toContain(kept);
  });
});

// ── (9) wireSelfSyncAndAppAuth — the per-tick ordering: self-sync first (a restart PRE-EMPTS the tick and the
//        token refresh), then the App-token refresh (before the real tick), then the tick — with the tick's
//        own payload argument threaded through both wrappers unchanged ─────────────────────────────────────

describe('wireSelfSyncAndAppAuth — self-sync, then token refresh, then the tick, in order', () => {
  it('up-to-date self-sync: token refresh runs, THEN the tick, and the tick receives the forwarded payload', async () => {
    const order = [];
    const payloadsSeen = [];
    const wrapped = wireSelfSyncAndAppAuth({
      tickOnce: async (payload) => { order.push('tick'); payloadsSeen.push(payload); return { nextState: { fromTick: true } }; },
      root: '/irrelevant-since-sync-is-injected',
      selfSync: true,
      onRestart: () => { throw new Error('onRestart must not run when nothing merged'); },
      sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }),
      authOpts: {
        env: { WE_GITHUB_APP_ID: 'a', WE_GITHUB_APP_INSTALLATION_ID: 'b', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' },
        readCache: () => ({ v: 2, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), // fresh cache → no real mint
        setEnv: () => { order.push('token-refresh'); },
        log: { error: () => {} },
      },
    });

    const out = await wrapped({ carriedOver: 'bookkeeping' });

    expect(order).toEqual(['token-refresh', 'tick']); // token refresh strictly before the tick
    expect(payloadsSeen).toEqual([{ carriedOver: 'bookkeeping' }]); // the payload survived both wrappers unchanged
    expect(out).toEqual({ nextState: { fromTick: true } });
  });

  it('self-sync merged: onRestart pre-empts BOTH the token refresh and the tick', async () => {
    const order = [];
    const wrapped = wireSelfSyncAndAppAuth({
      tickOnce: async () => { order.push('tick'); return {}; },
      root: '/irrelevant-since-sync-is-injected',
      selfSync: true,
      onRestart: () => { order.push('restart'); return 'restarted'; },
      sync: () => ({ merged: true, commits: 3, reason: 'merged' }),
      // #3383 live-smoke gate: this test is about restart PRECEDENCE (restart before token-refresh/tick), not
      // the gate's own verdict — inject a passing one (real daemon-live-smoke.test.mjs covers the gate itself).
      gate: async () => ({ adopt: true, reason: 'test-gate-pass' }),
      authOpts: {
        env: { WE_GITHUB_APP_ID: 'a', WE_GITHUB_APP_INSTALLATION_ID: 'b', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' },
        setEnv: () => { order.push('token-refresh'); },
        log: { error: () => {} },
      },
    });

    const out = await wrapped({ carriedOver: 'bookkeeping' });

    expect(order).toEqual(['restart']); // neither the token refresh nor the tick ran
    expect(out).toBe('restarted');
  });

  it('a self-sync conflict still ticks (never worse than today), still refreshing the token first', async () => {
    const order = [];
    const wrapped = wireSelfSyncAndAppAuth({
      tickOnce: async () => { order.push('tick'); return {}; },
      root: '/irrelevant-since-sync-is-injected',
      selfSync: true,
      onRestart: () => { throw new Error('must not restart on a conflict'); },
      sync: () => ({ merged: false, commits: 0, reason: 'conflict' }),
      authOpts: { log: { error: () => {} } }, // not-configured → token refresh is a fast no-op, still runs first
    });

    await wrapped({});
    expect(order).toEqual(['tick']); // no App env configured, so no 'token-refresh' entry — but no throw, and the tick still ran
  });
});

describe('wireSelfSyncAndAppAuth — self-sync is OPT-IN (never mutates an interactive checkout by default)', () => {
  const syncWouldMerge = (calls) => () => { calls.push('sync'); return { merged: true, commits: 2, reason: 'merged' }; };

  it.each([
    ['omitted', {}],
    ['false', { selfSync: false }],
    ['a truthy non-boolean string', { selfSync: 'true' }],
    ['a truthy non-boolean number', { selfSync: 1 }],
  ])('selfSync %s: sync never runs, no restart, token refresh + tick still run with the payload', async (_label, extra) => {
    const calls = [];
    const payloadsSeen = [];
    const wrapped = wireSelfSyncAndAppAuth({
      tickOnce: async (payload) => { calls.push('tick'); payloadsSeen.push(payload); return { ok: 1 }; },
      root: '/irrelevant',
      onRestart: () => { throw new Error('must never restart without the self-sync opt-in'); },
      sync: syncWouldMerge(calls),
      authOpts: {
        env: { WE_GITHUB_APP_ID: 'a', WE_GITHUB_APP_INSTALLATION_ID: 'b', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' },
        readCache: () => ({ v: 2, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
        setEnv: () => { calls.push('token-refresh'); },
        log: { error: () => {} },
      },
      ...extra,
    });

    const out = await wrapped({ carriedOver: 'x' });
    expect(calls).toEqual(['token-refresh', 'tick']); // no 'sync' — the git mutation was never attempted
    expect(payloadsSeen).toEqual([{ carriedOver: 'x' }]);
    expect(out).toEqual({ ok: 1 });
  });

  it('selfSync: true is the only value that wires the sync (and a merge then restarts)', async () => {
    const calls = [];
    const wrapped = wireSelfSyncAndAppAuth({
      tickOnce: async () => { calls.push('tick'); return {}; },
      root: '/irrelevant',
      onRestart: () => { calls.push('restart'); return 'restarted'; },
      sync: syncWouldMerge(calls),
      // #3383 live-smoke gate: passing, so this test keeps proving selfSync opt-in wiring, not the gate.
      gate: async () => ({ adopt: true, reason: 'test-gate-pass' }),
      authOpts: { log: { error: () => {} } },
      selfSync: true,
    });
    expect(await wrapped({})).toBe('restarted');
    expect(calls).toEqual(['sync', 'restart']);
  });
});
