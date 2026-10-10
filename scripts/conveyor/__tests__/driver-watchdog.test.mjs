/**
 * @file driver-watchdog.test.mjs — epic #3383. The SEPARATE, minimal watchdog that catches a conveyor driver
 * which has gone silently stale (alive, heartbeating, dispatching nothing) and rolls its checkout back to the
 * last known-good commit.
 *
 * TWO HALVES, and the first is the bigger one.
 *
 *   1. THE FALSE-POSITIVE TABLE. A watchdog that restarts a healthy driver is worse than no watchdog, so every
 *      "this is NOT stale" branch is asserted individually and by name: an empty queue, legitimately in-flight
 *      work, a driver that is simply down, a recent progress signal, and every unreadable input. The one
 *      actionable branch is asserted to need ALL of them ruled out at once.
 *
 *   2. THE PURITY ASSERTION. The whole design rests on this watchdog sharing none of the driver's own decision
 *      logic — a bug in that logic must not be able to disable the thing meant to catch it. That is asserted as
 *      a STATIC IMPORT-GRAPH FACT (`we:scripts/operations/__tests__/import-graph.mjs`, the same scanner
 *      `restart-runner.test.mjs` proves its own purity with), not as a promise in a comment.
 *
 * NOTHING IS STARTED. No runner, no supervisor, no watchdog process, no `claude`, no real `git reset`. Every
 * process and filesystem boundary is injected; the only real fs is a throwaway tmpdir for the marker round-trip.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importGraph } from '../../operations/__tests__/import-graph.mjs';
import {
  DEFAULT_STALE_AFTER_MS, WATCHED_SESSION_KINDS, MAX_RUNS_SCANNED,
  itemBases, sessionMatchesItem, splitQueue, runTouchesScope, latestProgress,
  classifyDriver, decideRollback,
  defaultDriverLease, newestScopedRun, readHead, recordLastKnownGood, readLastKnownGood,
  healDriver, runWatchdogOnce, readWatchdogFacts, parseFlags, lastKnownGoodPath, alertPath, logPath,
  driverModePath, WATCHDOG_REPO_ROOT,
  resolvePidAlive, defaultIsPidAlive, scanPsOutput,
} from '../driver-watchdog.mjs';
import { DEFAULT_RENAG_MS } from '../branch-sync.mjs';
import { driverModeFor, parseDriverMode, readDriverMode, writeDriverMode, DRIVER_MODES } from '../driver-mode.mjs';
import { sessionSlugFor } from '../../operations/dispatch-lane.mjs';

const NOW = Date.parse('2026-09-12T18:00:00.000Z');
const MIN = 60_000;
const GOOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_SHA = 'ffffeeeeddddccccbbbbaaaa99998888777766ff';

/** The healthy-but-stale skeleton: one queued item, no sessions, a live lease, a quiet clock. Each test below
 *  perturbs exactly ONE field, so a verdict change is always attributable. */
const stuck = (over = {}) => ({
  nowMs: NOW,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  queue: [{ num: '3383', addedAt: null }],
  listingReadable: true,
  agents: [],
  lease: { held: true, stale: false, heartbeatAt: '…', detail: 'a live runner lease' },
  progress: { source: 'queue-sidecar', atMs: NOW - 45 * MIN },
  ...over,
});

// ── (1) session ↔ item matching ────────────────────────────────────────────────────────────────────────────

describe('sessionMatchesItem — EXACT match against a known id, never id extraction', () => {
  it('matches a plain conveyor session for the item', () => {
    expect(sessionMatchesItem('conveyor-3383', '3383')).toBe(true);
  });

  it('matches every watched session kind, so more things count as in-flight, not fewer', () => {
    for (const kind of WATCHED_SESSION_KINDS) expect(sessionMatchesItem(`${kind}-3383`, '3383')).toBe(true);
  });

  it('matches a retry-suffixed slug (#3110 — `conveyor-2500b` is the second attempt at 2500)', () => {
    expect(sessionMatchesItem('conveyor-3383b', '3383')).toBe(true);
    expect(sessionMatchesItem('conveyor-3383z', '3383')).toBe(true);
  });

  it('matches a HASH-shaped item id, which the digits-only session grammar cannot', () => {
    // `lease-reaper.mjs#itemNumFromSession` matches `(\d+)` only, so a hash-identified item's session reads as
    // "no item at all" there. Here the id is already known, so whole-string comparison just works — and the
    // direction is the safe one: this session now counts as in-flight, suppressing a false "stale".
    expect(sessionMatchesItem('conveyor-xqxpeac', 'xqxpeac')).toBe(true);
  });

  it('does NOT alias — the #3283 failure mode cannot occur, because nothing is extracted', () => {
    expect(sessionMatchesItem('probe1', '1')).toBe(false);
    expect(sessionMatchesItem('Mac:24827', '24827')).toBe(false);
    expect(sessionMatchesItem('conveyor-33830', '3383')).toBe(false);   // a longer number, not a retry letter
    expect(sessionMatchesItem('drain-3383', '3383')).toBe(false);       // not a watched kind
    expect(sessionMatchesItem('conveyor-3383bc', '3383')).toBe(false);  // two trailing letters is not the grammar
    expect(sessionMatchesItem('my-conveyor-3383', '3383')).toBe(false); // a prefix, not the whole name
  });

  it('tolerates the `#NNN` sigil and leading zeros on the queued id, the way the sidecar writer does', () => {
    expect(itemBases('#042')).toEqual(['042', '42']);
    expect(sessionMatchesItem('conveyor-42', '#042')).toBe(true);
    expect(sessionMatchesItem('conveyor-042', '#042')).toBe(true);
  });

  it('is case-insensitive and blank-safe', () => {
    expect(sessionMatchesItem('CONVEYOR-3383', '3383')).toBe(true);
    expect(sessionMatchesItem('', '3383')).toBe(false);
    expect(sessionMatchesItem('conveyor-3383', '')).toBe(false);
    expect(sessionMatchesItem(null, null)).toBe(false);
  });
});

describe('splitQueue — what is being worked vs what is waiting', () => {
  it('splits on live sessions', () => {
    const { inFlight, eligible } = splitQueue(
      [{ num: '1' }, { num: '2' }, { num: '3' }],
      [{ name: 'conveyor-2', startedAt: NOW - MIN }],
    );
    expect(eligible.map((e) => e.num)).toEqual(['1', '3']);
    expect(inFlight).toEqual([{ num: '2', session: 'conveyor-2', startedAt: NOW - MIN }]);
  });

  it('counts a session with an UNREADABLE start time as in-flight — an undatable session is assumed live', () => {
    const { inFlight, eligible } = splitQueue([{ num: '7' }], [{ name: 'conveyor-7', startedAt: 'nonsense' }]);
    expect(eligible).toEqual([]);
    expect(inFlight[0]).toMatchObject({ num: '7', session: 'conveyor-7', startedAt: null });
  });

  it('never throws on junk rows on either side', () => {
    expect(splitQueue([null, { num: '' }, { num: '5' }], [null, 'nope', { name: null }]).eligible.map((e) => e.num))
      .toEqual(['5']);
    expect(splitQueue(null, null)).toEqual({ inFlight: [], eligible: [], deadSessions: [] });
  });

  it('moves a CONFIRMED-dead registered session to eligible, and names it in `deadSessions` — never silently blocks dispatch on a stale registry entry', () => {
    const { inFlight, eligible, deadSessions } = splitQueue(
      [{ num: '2786' }],
      [{ name: 'conveyor-2786', startedAt: NOW - 10 * 24 * 60 * MIN, pidAlive: false }],
    );
    expect(inFlight).toEqual([]);
    expect(eligible.map((e) => e.num)).toEqual(['2786']);
    expect(deadSessions).toEqual([{ num: '2786', session: 'conveyor-2786' }]);
  });

  it('keeps a name-matched session in-flight when liveness is merely UNKNOWN (pidAlive undefined/null) — absence of a field is not evidence of death', () => {
    expect(splitQueue([{ num: '9' }], [{ name: 'conveyor-9', startedAt: NOW }]).inFlight)
      .toEqual([{ num: '9', session: 'conveyor-9', startedAt: NOW }]);
    expect(splitQueue([{ num: '9' }], [{ name: 'conveyor-9', startedAt: NOW, pidAlive: null }]).inFlight.map((e) => e.num))
      .toEqual(['9']);
  });

  it('keeps a name-matched session in-flight when pidAlive is CONFIRMED true', () => {
    expect(splitQueue([{ num: '9' }], [{ name: 'conveyor-9', startedAt: NOW, pidAlive: true }]).inFlight.map((e) => e.num))
      .toEqual(['9']);
  });
});

describe('resolvePidAlive — the two-signal liveness probe (#3383)', () => {
  it('a real `pid` field wins outright — `isPidAlive` decides, the `ps aux` scan is never consulted', () => {
    expect(resolvePidAlive({ pid: 4242 }, { isPidAlive: () => true, psOutput: 'nothing relevant here' })).toBe(true);
    expect(resolvePidAlive({ pid: 4242 }, { isPidAlive: () => false, psOutput: 'irrelevant' })).toBe(false);
  });

  it('no `pid` → scans the already-captured `ps aux` text for the full `sessionId`, case-insensitively', () => {
    const psOutput = 'nicolasgilbert 123 0.0 0.0 … claude --resume=ABCD-1234-full-uuid\n';
    expect(resolvePidAlive({ sessionId: 'abcd-1234-full-uuid' }, { psOutput })).toBe(true);
    expect(resolvePidAlive({ sessionId: 'never-appears-anywhere' }, { psOutput })).toBe(false);
  });

  it('no `pid` and no `sessionId` → UNKNOWN (`null`), never read as death', () => {
    expect(resolvePidAlive({}, { psOutput: 'anything' })).toBe(null);
  });

  it('the `ps aux` scan itself failed (`psOutput: null`) → UNKNOWN, even with a `sessionId` to look for', () => {
    expect(resolvePidAlive({ sessionId: 'abcd-1234' }, { psOutput: null })).toBe(null);
  });
});

describe('defaultIsPidAlive — process.kill(pid, 0)', () => {
  it('the current process\'s own pid is alive', () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });

  it('a pid nothing holds answers false', () => {
    // A pid that is astronomically unlikely to exist; ESRCH ⇒ false (not EPERM ⇒ true).
    expect(defaultIsPidAlive(999_999_999)).toBe(false);
  });
});

describe('scanPsOutput — best-effort `ps aux`, never throws', () => {
  it('returns the exec output', () => {
    expect(scanPsOutput({ exec: () => 'line one\nline two\n' })).toBe('line one\nline two\n');
  });

  it('an exec failure reads as `null` (unknown), never a throw', () => {
    expect(scanPsOutput({ exec: () => { throw new Error('ps: command not found'); } })).toBe(null);
  });
});

// ── (2) run-record scoping ─────────────────────────────────────────────────────────────────────────────────

describe('runTouchesScope — a run counts as progress only if it is THIS driver\'s', () => {
  const keys = new Set(['3383', '2612']);

  it('matches on a queued item id in the input', () => {
    expect(runTouchesScope({ op: 'dispatch-lane', input: { num: '3383' } }, keys, '/drv')).toBe(true);
    expect(runTouchesScope({ op: 'dispatch-lane', input: { num: '#3383' } }, keys, '/drv')).toBe(true);
  });

  it('matches on the driver checkout named in the input', () => {
    expect(runTouchesScope({ input: { checkout: '/drv' } }, keys, '/drv')).toBe(true);
    expect(runTouchesScope({ input: { cwd: '/drv' } }, keys, '/drv')).toBe(true);
  });

  it('does NOT match an out-of-scope run — the #3383 lesson: another instance\'s work is not our progress', () => {
    expect(runTouchesScope({ op: 'review-pr', input: { pr: 1234 } }, keys, '/drv')).toBe(false);
    expect(runTouchesScope({ op: 'dispatch-lane', input: { num: '9999' } }, keys, '/drv')).toBe(false);
    expect(runTouchesScope({ input: { checkout: '/somewhere-else' } }, keys, '/drv')).toBe(false);
  });

  it('compares SCALARS only — a nested blob cannot suppress the alarm by accident', () => {
    expect(runTouchesScope({ input: { payload: { num: '3383' } } }, keys, '/drv')).toBe(false);
    expect(runTouchesScope({ input: { list: ['3383'] } }, keys, '/drv')).toBe(false);
  });

  it('never throws on a missing/garbage record', () => {
    expect(runTouchesScope(null, keys, '/drv')).toBe(false);
    expect(runTouchesScope({ input: 'not-an-object' }, keys, '/drv')).toBe(false);
  });
});

describe('newestScopedRun — bounded by age and by count', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `run-${i}.json`);

  it('returns the newest in-scope record', () => {
    const got = newestScopedRun({
      checkout: '/drv', queueKeys: new Set(['3383']), nowMs: NOW, lookbackMs: 60 * MIN,
      readDir: () => ['old.json', 'new.json', 'notes.txt'],
      stat: (p) => (p.endsWith('new.json') ? NOW - MIN : NOW - 30 * MIN),
      read: (p) => ({ op: 'dispatch-lane', input: { num: p.endsWith('new.json') ? '3383' : '3383' } }),
    });
    expect(got).toMatchObject({ atMs: NOW - MIN, op: 'dispatch-lane' });
  });

  it('skips records older than the lookback, and returns null when only stale ones remain', () => {
    expect(newestScopedRun({
      checkout: '/drv', queueKeys: new Set(['3383']), nowMs: NOW, lookbackMs: 10 * MIN,
      readDir: () => ['old.json'], stat: () => NOW - 99 * MIN, read: () => ({ input: { num: '3383' } }),
    })).toBeNull();
  });

  it(`parses at most ${MAX_RUNS_SCANNED} records, newest first — the runs sidecar is never pruned`, () => {
    let parsed = 0;
    newestScopedRun({
      checkout: '/drv', queueKeys: new Set(['nope']), nowMs: NOW, lookbackMs: 60 * MIN,
      readDir: () => mk(500), stat: () => NOW - MIN, read: () => { parsed += 1; return { input: {} }; },
    });
    expect(parsed).toBe(MAX_RUNS_SCANNED);
  });

  it('returns null (never throws) when the runs directory does not exist', () => {
    expect(newestScopedRun({
      checkout: '/drv', queueKeys: new Set(), nowMs: NOW, lookbackMs: MIN,
      readDir: () => { throw new Error('ENOENT'); },
    })).toBeNull();
  });
});

describe('latestProgress — the newest readable signal, or null', () => {
  it('picks the newest and names its source', () => {
    expect(latestProgress([
      { source: 'queue-sidecar', atMs: NOW - 40 * MIN },
      { source: 'dispatch-log', atMs: NOW - 2 * MIN },
      { source: 'run-record', atMs: null },
    ])).toEqual({ source: 'dispatch-log', atMs: NOW - 2 * MIN });
  });

  it('is null when nothing was readable — "cannot tell", never "infinitely quiet"', () => {
    expect(latestProgress([{ source: 'a', atMs: null }, { source: 'b', atMs: 0 }])).toBeNull();
    expect(latestProgress(null)).toBeNull();
  });
});

// ── (3) THE FALSE-POSITIVE TABLE — the heart of this suite ─────────────────────────────────────────────────

describe('classifyDriver — every way a HEALTHY driver could be mistaken for a stale one', () => {
  it('EMPTY QUEUE is idle, not stale — "there is just nothing to do right now"', () => {
    const v = classifyDriver(stuck({ queue: [] }));
    expect(v.state).toBe('idle');
    expect(v.actionable).toBe(false);
  });

  it('an empty queue is idle EVEN IF the clock has been quiet for days', () => {
    const v = classifyDriver(stuck({ queue: [], progress: { source: 'queue-sidecar', atMs: NOW - 5000 * MIN } }));
    expect(v.state).toBe('idle');
    expect(v.actionable).toBe(false);
  });

  it('IN-FLIGHT WORK is healthy, however long it has been running', () => {
    const v = classifyDriver(stuck({
      agents: [{ name: 'conveyor-3383', startedAt: NOW - 400 * MIN }],
      progress: { source: 'queue-sidecar', atMs: NOW - 400 * MIN },
    }));
    expect(v.state).toBe('working');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('conveyor-3383');
  });

  it('in-flight work wins over a dead lease — never restart a driver with a live delivery agent out', () => {
    const v = classifyDriver(stuck({ agents: [{ name: 'conveyor-3383', startedAt: NOW }], lease: { held: false } }));
    expect(v.state).toBe('working');
  });

  it('an UNREADABLE agent listing fails SAFE (no action) — the opposite direction from restart-runner', () => {
    const v = classifyDriver(stuck({ listingReadable: false, listingError: 'spawn claude ENOENT' }));
    expect(v.state).toBe('unknown');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('spawn claude ENOENT');
  });

  it('NO LIVE LEASE is `down`, not stale — a crash is the supervisor\'s job, not this one\'s', () => {
    const v = classifyDriver(stuck({ lease: { held: false, stale: true, detail: 'holder crashed' } }));
    expect(v.state).toBe('down');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('holder crashed');
  });

  it('a lease belonging to a DIFFERENT checkout is `down` for this driver', () => {
    const v = classifyDriver(stuck({ lease: { held: false, detail: 'the live runner lease belongs to a different checkout (/other)' } }));
    expect(v.state).toBe('down');
    expect(v.reason).toContain('/other');
  });
});

// ── (3a) THE #3383 STALE-REGISTRATION BUG — a NAME MATCH is not liveness ───────────────────────────────────
//
// Live incident, 2026-09-14: 18 queued items (`conveyor-2786`, `prepare-3438`, …) all read as "have a live
// session" — the watchdog logged `working` every 5 minutes for over an hour — while every one of those
// sessions' transcripts had last written 6-13 days earlier, with no backing process at all. `splitQueue`
// matched purely on NAME, so a stale/orphaned `claude agents --json` registration (the same #77683-shaped
// decay `clear-stuck-session.mjs` documents) was indistinguishable from a genuinely live delivery agent. Fixed
// by reading `agent.pidAlive` (attached by the IO shell via `resolvePidAlive`) before counting a match as
// in-flight: `pidAlive === false` is the ONLY value that excludes it.

describe('classifyDriver — a CONFIRMED-DEAD registered session must not read as in-flight work (#3383)', () => {
  it('THE BUG, reproduced: a name-matched session with NO liveness field defaults to in-flight (unchanged, conservative default)', () => {
    const v = classifyDriver(stuck({ agents: [{ name: 'conveyor-3383', startedAt: NOW - 10 * 24 * 60 * MIN }] }));
    expect(v.state).toBe('working');
  });

  it('THE FIX: the SAME name-matched session, now CONFIRMED dead (pidAlive:false), is NOT in-flight — the item is eligible and the driver reaches `stale`', () => {
    const v = classifyDriver(stuck({
      agents: [{ name: 'conveyor-3383', startedAt: NOW - 10 * 24 * 60 * MIN, pidAlive: false }],
      progress: { source: 'queue-sidecar', atMs: NOW - 45 * MIN },
    }));
    expect(v.state).toBe('stale');
    expect(v.actionable).toBe(true);
    expect(v.eligible.map((e) => e.num)).toEqual(['3383']);
    expect(v.inFlight).toEqual([]);
    expect(v.deadSessions).toEqual([{ num: '3383', session: 'conveyor-3383' }]);
  });

  it('a MERELY-UNPROBED liveness (pidAlive:null, e.g. `ps` itself failed) stays in-flight — unknown is never read as death', () => {
    const v = classifyDriver(stuck({ agents: [{ name: 'conveyor-3383', startedAt: NOW - 10 * 24 * 60 * MIN, pidAlive: null }] }));
    expect(v.state).toBe('working');
    expect(v.deadSessions).toEqual([]);
  });

  it('a CONFIRMED-live session (pidAlive:true) stays in-flight, as ever', () => {
    const v = classifyDriver(stuck({ agents: [{ name: 'conveyor-3383', startedAt: NOW, pidAlive: true }] }));
    expect(v.state).toBe('working');
  });

  it('18 stale sessions across 18 queued items ALL become eligible at once — the exact live-incident shape', () => {
    const nums = ['2786', '3435', '3442', '3443', '3445', '3411', '3447', '3448', '2416', '3438', '3441', '3436', '3399', '3401', '3454', '3452', '3402', '3457'];
    const queue = nums.map((num) => ({ num, addedAt: null }));
    const agents = nums.map((num) => ({ name: `conveyor-${num}`, startedAt: NOW - 8 * 24 * 60 * MIN, pidAlive: false }));
    const v = classifyDriver(stuck({ queue, agents, progress: { source: 'queue-sidecar', atMs: NOW - 45 * MIN } }));
    expect(v.inFlight).toEqual([]);
    expect(v.eligible.map((e) => e.num).sort()).toEqual([...nums].sort());
    expect(v.deadSessions).toHaveLength(18);
    expect(v.state).toBe('stale');
    expect(v.actionable).toBe(true);
  });
});

// ── (3b) `down` IS NOT A SYNONYM FOR "CRASHED" — the 2026-09-12 bug ────────────────────────────────────────
//
// Observed live: a driver deliberately started `--once` ran ONE tick, dispatched a real item, exited 0 and
// released its lease cleanly (`held:false, stale:false`). `classifyDriver` collapsed that into the same verdict
// — and the same words — as a crash, and the watchdog logged "crash" every 5 minutes about a process that had
// done exactly what it was told. Two signals now separate the four cases below: WAS it supposed to keep running
// (the `.conveyor/driver-mode.json` marker), and DID it die or leave (`lease.stale`, already computed and
// previously discarded).

describe('classifyDriver — a BOUNDED driver that finished is not a crash', () => {
  /** The live shape: `--once`, one tick, clean exit, lease released. */
  const boundedFinished = (over = {}) => stuck({
    lease: { held: false, stale: false, heartbeatAt: null, detail: 'no runner lease at all' },
    driverMode: { mode: 'bounded', startedAt: '2026-09-12T17:30:00.000Z', pid: 4242, maxTicks: 1 },
    ...over,
  });

  it('THE BUG: a bounded driver that ran its tick and exited cleanly is `completed`, and is NOT called a crash', () => {
    const v = classifyDriver(boundedFinished());
    expect(v.state).toBe('completed');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('BOUNDED');
    expect(v.reason).toContain('FINISHING');
    expect(v.reason).not.toContain('That is a crash');
    // The pre-fix assertion, in the exact words it used, must not survive anywhere in this verdict.
    expect(v.reason).not.toMatch(/is a crash\b/);
  });

  it('carries the marker through onto the verdict, so a human reading --json sees WHY it was excused', () => {
    expect(classifyDriver(boundedFinished()).driverMode).toMatchObject({ mode: 'bounded', maxTicks: 1 });
  });

  it('names the ceiling it was given — `--max-ticks=N` reads differently from a bare `--once`', () => {
    expect(classifyDriver(boundedFinished({ driverMode: { mode: 'bounded', maxTicks: 5 } })).reason)
      .toContain('--max-ticks=5');
    expect(classifyDriver(boundedFinished({ driverMode: { mode: 'bounded', maxTicks: null } })).reason)
      .toContain('--once');
  });

  it('REGRESSION GUARD: a bounded driver that LEAKED its lease is still `down`, and still a crash', () => {
    // Bounded does not mean "never alarm". A leaked lease past the TTL is the one POSITIVE death signal there
    // is: a process that crashes cannot release. Being allowed to stop does not excuse dying mid-tick.
    const v = classifyDriver(boundedFinished({
      lease: { held: false, stale: true, detail: 'a runner lease exists but its holder crashed (heartbeat past the TTL)' },
    }));
    expect(v.state).toBe('down');
    expect(v.reason).toContain('LEAKED');
    expect(v.reason).toContain('crash');
  });

  it('REGRESSION GUARD: a RESIDENT driver that is gone is still `down` — clean release or not', () => {
    for (const lease of [
      { held: false, stale: true, detail: 'a runner lease exists but its holder crashed (heartbeat past the TTL)' },
      { held: false, stale: false, detail: 'no runner lease at all' },
    ]) {
      const v = classifyDriver(boundedFinished({ lease, driverMode: { mode: 'resident', startedAt: '…' } }));
      expect(v.state).toBe('down');
      expect(v.actionable).toBe(false);
    }
  });

  it('BACKWARD COMPAT: NO marker behaves exactly as before the fix — `down`, non-actionable, resident assumed', () => {
    // Every driver checkout that has not yet been restarted onto the marker-writing runner is this case, and it
    // must not move an inch. Same state, same actionability, same non-action.
    for (const driverMode of [null, undefined]) {
      const v = classifyDriver(boundedFinished({ driverMode }));
      expect(v.state).toBe('down');
      expect(v.actionable).toBe(false);
      expect(v.reason).toContain('assumed resident');
    }
  });

  it('BACKWARD COMPAT: an UNPARSEABLE marker is no better than no marker — it can never silence a crash', () => {
    // `readDriverMode` hands `null` up for junk, so junk cannot be more powerful than absence. Asserted through
    // the parser rather than by hand, so the two halves cannot drift.
    for (const junk of ['', 'not json', '[]', '{}', '{"mode":"whatever"}', '{"mode":null}']) {
      expect(parseDriverMode(junk)).toBe(null);
      expect(classifyDriver(boundedFinished({ driverMode: parseDriverMode(junk) })).state).toBe('down');
    }
  });

  it('the bounded excuse never outranks a LIVE lease or in-flight work — the earlier branches still win', () => {
    // `completed` is reachable ONLY from the no-lease branch. A bounded driver that is still holding its lease
    // is just a running driver, and is judged on progress like any other.
    expect(classifyDriver(boundedFinished({ lease: { held: true, stale: false, detail: 'a live runner lease' } })).state)
      .toBe('stale');
    expect(classifyDriver(boundedFinished({ agents: [{ name: 'conveyor-3383', startedAt: NOW }] })).state)
      .toBe('working');
    expect(classifyDriver(boundedFinished({ queue: [] })).state).toBe('idle');
  });

  it('a `completed` verdict can never reach the rollback — it is not actionable, so the guard refuses', () => {
    expect(decideRollback({ verdict: classifyDriver(boundedFinished()), lastKnownGood: { sha: GOOD }, head: { sha: HEAD_SHA, dirty: false } }))
      .toMatchObject({ roll: false, guard: 'not-stale' });
  });

  it('THE MESSAGE FOLLOWS THE EVIDENCE: a clean release is reported as a STOP, a leaked lease as a death', () => {
    const resident = { mode: 'resident', startedAt: '2026-09-12T17:30:00.000Z' };
    const clean = classifyDriver(boundedFinished({ driverMode: resident }));
    expect(clean.state).toBe('down');
    expect(clean.reason).toContain('released cleanly');
    expect(clean.reason).toContain('STOPPED rather than crashed');
    expect(clean.reason).toContain('recorded as RESIDENT');

    const died = classifyDriver(boundedFinished({
      driverMode: resident,
      lease: { held: false, stale: true, detail: 'a runner lease exists but its holder crashed (heartbeat past the TTL)' },
    }));
    expect(died.reason).toContain('LEAKED');
    expect(died.reason).toContain('past the TTL');
  });
});

describe('classifyDriver — progress, the staleness window, and the one actionable verdict', () => {

  it('RECENT PROGRESS is `settling`, not stale — just under the window still counts', () => {
    const v = classifyDriver(stuck({ progress: { source: 'dispatch-log', atMs: NOW - (DEFAULT_STALE_AFTER_MS - 1000) } }));
    expect(v.state).toBe('settling');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('dispatch-log');
  });

  it('NO OBSERVABLE PROGRESS TIMESTAMP is `unknown` — quiet time is unmeasurable, so no action', () => {
    const v = classifyDriver(stuck({ progress: null }));
    expect(v.state).toBe('unknown');
    expect(v.actionable).toBe(false);
  });

  it('GENUINELY STUCK is the ONE actionable verdict — and needs every other branch ruled out', () => {
    const v = classifyDriver(stuck());
    expect(v.state).toBe('stale');
    expect(v.actionable).toBe(true);
    expect(v.eligible.map((e) => e.num)).toEqual(['3383']);
    expect(v.inFlight).toEqual([]);
    expect(v.quietMs).toBe(45 * MIN);
    expect(v.reason).toContain('making no dispatch progress');
  });

  it('the window is configurable — a shorter one makes the same facts stale sooner', () => {
    const facts = stuck({ progress: { source: 'dispatch-log', atMs: NOW - 8 * MIN } });
    expect(classifyDriver(facts).state).toBe('settling');
    expect(classifyDriver({ ...facts, staleAfterMs: 5 * MIN }).state).toBe('stale');
  });

  it('exactly at the window boundary is stale (>=, not >)', () => {
    expect(classifyDriver(stuck({ progress: { source: 'dispatch-log', atMs: NOW - DEFAULT_STALE_AFTER_MS } })).state)
      .toBe('stale');
  });
});

// ── (4) the rollback guards ────────────────────────────────────────────────────────────────────────────────

describe('decideRollback — four independent refusals in front of `git reset --hard`', () => {
  const stale = classifyDriver(stuck());
  const clean = { sha: HEAD_SHA, dirty: false };

  it('rolls back when the driver is stale, the tree is clean, and a marker names a DIFFERENT commit', () => {
    const d = decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD }, head: clean });
    expect(d).toMatchObject({ roll: true, sha: GOOD, from: HEAD_SHA, guard: null });
  });

  it('refuses when the driver was not judged stale — every non-actionable verdict', () => {
    for (const v of [classifyDriver(stuck({ queue: [] })), classifyDriver(stuck({ listingReadable: false })), null]) {
      expect(decideRollback({ verdict: v, lastKnownGood: { sha: GOOD }, head: clean }))
        .toMatchObject({ roll: false, guard: 'not-stale' });
    }
  });

  it('refuses with NO MARKER — the fallback is recorded, never guessed', () => {
    for (const lkg of [null, {}, { sha: '' }, { sha: 'HEAD~1' }, { sha: 'zzz' }]) {
      expect(decideRollback({ verdict: stale, lastKnownGood: lkg, head: clean }))
        .toMatchObject({ roll: false, guard: 'no-fallback' });
    }
  });

  it('refuses on a DIRTY driver checkout — a driver only runs the runner, it never edits (rule 104)', () => {
    const d = decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD }, head: { sha: HEAD_SHA, dirty: true } });
    expect(d).toMatchObject({ roll: false, guard: 'dirty-checkout' });
    expect(d.reason).toContain('uncommitted');
  });

  it('refuses when the working-tree state could not be read at all — unproven is not clean', () => {
    expect(decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD }, head: { sha: HEAD_SHA, dirty: null } }))
      .toMatchObject({ roll: false, guard: 'unknown-tree' });
  });

  it('refuses when HEAD could not be read', () => {
    expect(decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD }, head: { sha: null, dirty: false } }))
      .toMatchObject({ roll: false, guard: 'unknown-head' });
  });

  it('THE LOOP GUARD: refuses when the driver is ALREADY at last-known-good and stale there', () => {
    const d = decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD }, head: { sha: GOOD, dirty: false } });
    expect(d).toMatchObject({ roll: false, guard: 'already-at-last-known-good' });
    expect(d.reason).toContain('loop forever');
  });

  it('the loop guard also catches an abbreviated marker naming the same commit', () => {
    expect(decideRollback({ verdict: stale, lastKnownGood: { sha: GOOD.slice(0, 10) }, head: { sha: GOOD, dirty: false } }))
      .toMatchObject({ roll: false, guard: 'already-at-last-known-good' });
  });
});

// ── (5) the driver-lease read ──────────────────────────────────────────────────────────────────────────────

describe('defaultDriverLease — is the driver WE watch actually up?', () => {
  const lease = (over) => defaultDriverLease({
    checkout: '/drv', nowMs: NOW,
    leaseStatusFn: () => ({ held: true, stale: false, owner: 'host:1:conveyor-runner', heartbeatAt: '…' }),
    resolveCheckout: () => ({ status: 'resolved', cwd: '/drv' }),
    ...over,
  });

  it('held when the live lease resolves to OUR checkout', () => {
    expect(lease()).toMatchObject({ held: true, checkoutMatch: true });
  });

  it('NOT held when the live lease resolves to a different checkout', () => {
    const l = lease({ resolveCheckout: () => ({ status: 'resolved', cwd: '/other' }) });
    expect(l).toMatchObject({ held: false, checkoutMatch: false });
    expect(l.detail).toContain('/other');
  });

  it('NOT held when there is no lease, or the holder crashed', () => {
    expect(lease({ leaseStatusFn: () => ({ held: false, stale: false, heartbeatAt: null }) })).toMatchObject({ held: false });
    const crashed = lease({ leaseStatusFn: () => ({ held: false, stale: true, heartbeatAt: '…' }) });
    expect(crashed.detail).toContain('crashed');
  });

  it('an UNRESOLVABLE checkout under a live lease counts as ours — the accepted, documented residual', () => {
    const l = lease({ resolveCheckout: () => ({ status: 'cwd-unresolved', cwd: null }) });
    expect(l).toMatchObject({ held: true, checkoutMatch: null });
    expect(l.detail).toContain('cwd-unresolved');
  });
});

// ── (6) the marker round-trip (real fs, injected git) ──────────────────────────────────────────────────────

describe('record-good — the fallback is recorded EXPLICITLY', () => {
  const withDir = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-marker-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('defaults to the driver checkout\'s HEAD, resolves it, and writes {sha, recordedAt, note}', () => withDir((dir) => {
    const { path, record } = recordLastKnownGood({
      checkout: dir, note: 'before promoting onto lane/mechanical-dispatcher',
      git: (args) => ({ ok: true, stdout: args.includes('--verify') ? `${GOOD}\n` : `${GOOD}\n`, stderr: '' }),
      now: () => NOW,
    });
    expect(path).toBe(lastKnownGoodPath(dir));
    expect(record).toEqual({ sha: GOOD, recordedAt: new Date(NOW).toISOString(), note: 'before promoting onto lane/mechanical-dispatcher' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
    expect(readLastKnownGood(dir)).toEqual(record);
  }));

  it('resolves ANY rev through the DRIVER\'s object database, and stores the immutable sha it resolved to', () => withDir((dir) => {
    const seen = [];
    // A symbolic rev is fine as INPUT — a branch or tag could later move, so what lands in the marker is the
    // resolved 40-hex sha, never the name the operator typed.
    const { record } = recordLastKnownGood({
      checkout: dir, sha: 'v1.2',
      git: (a, cwd) => { seen.push([a, cwd]); return { ok: true, stdout: `${GOOD}\n`, stderr: '' }; }, now: () => NOW,
    });
    expect(seen[0][0]).toEqual(['rev-parse', '--verify', 'v1.2^{commit}']);
    expect(seen[0][1]).toBe(dir);
    expect(record.sha).toBe(GOOD);
  }));

  it('REFUSES a rev the driver checkout does not have — an unreachable target fails at the worst moment', () => withDir((dir) => {
    expect(() => recordLastKnownGood({ checkout: dir, sha: GOOD, git: () => ({ ok: false, stdout: '', stderr: 'unknown revision\n' }) }))
      .toThrow(/not a commit in/);
  }));

  it('refuses when git resolves to something that is not a commit id', () => withDir((dir) => {
    expect(() => recordLastKnownGood({ checkout: dir, sha: 'main', git: () => ({ ok: true, stdout: 'not-a-sha\n', stderr: '' }) }))
      .toThrow(/not a commit id/);
  }));

  it('a missing or corrupt marker reads as null, never as a guess', () => withDir((dir) => {
    expect(readLastKnownGood(dir)).toBeNull();
    mkdirSync(join(dir, '.conveyor'), { recursive: true });
    writeFileSync(lastKnownGoodPath(dir), '{ not json');
    expect(readLastKnownGood(dir)).toBeNull();
  }));
});

describe('readHead — unknown is reported as null, never assumed', () => {
  it('reads sha + dirtiness', () => {
    const head = readHead({ checkout: '/drv', git: (a) => (a[0] === 'rev-parse' ? { ok: true, stdout: `${HEAD_SHA}\n` } : { ok: true, stdout: ' M x.mjs\n' }) });
    expect(head).toEqual({ sha: HEAD_SHA, dirty: true });
  });

  it('a clean tree is `dirty:false`; a failed git is `null` on both', () => {
    expect(readHead({ checkout: '/drv', git: () => ({ ok: true, stdout: '' }) })).toEqual({ sha: '', dirty: false });
    expect(readHead({ checkout: '/drv', git: () => ({ ok: false, stdout: '', stderr: 'not a repo' }) })).toEqual({ sha: null, dirty: null });
  });
});

// ── (7) the rollback + restart sequence ────────────────────────────────────────────────────────────────────

describe('healDriver — reset the driver checkout, then use the EXISTING restart-runner operation', () => {
  const capture = () => {
    const calls = { git: [], run: [] };
    const heal = (over = {}) => healDriver({
      checkout: '/drv', sha: GOOD,
      git: (a, cwd) => { calls.git.push([a, cwd]); return { ok: true, stdout: '', stderr: '' }; },
      run: (bin, args, opts) => { calls.run.push({ bin, args, opts }); return { status: 0, stdout: 'restarted\n', stderr: '' }; },
      ...over,
    });
    return { calls, heal };
  };

  it('resets the DRIVER checkout hard to the marker sha, then restarts', () => {
    const { calls, heal } = capture();
    const out = heal();
    expect(calls.git).toEqual([[['reset', '--hard', GOOD], '/drv']]);
    expect(out).toMatchObject({ rolledBack: true, restarted: true, sha: GOOD, error: null });
  });

  it('drives `run.mjs restart-runner` with the DRIVER as data plane and THIS checkout as control plane', () => {
    const { calls, heal } = capture();
    heal();
    const { bin, args, opts } = calls.run[0];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toBe(join(WATCHDOG_REPO_ROOT, 'scripts', 'operations', 'run.mjs'));
    expect(args[1]).toBe('restart-runner');
    expect(args).toContain('--checkout=/drv');
    expect(args).toContain(`--supervisor=${join('/drv', 'skills-src', 'conveyor', 'supervisor.mjs')}`);
    // The restart sequence itself runs code we did NOT just roll back.
    expect(opts.cwd).toBe(WATCHDOG_REPO_ROOT);
  });

  it('NEVER passes --force — a watchdog must not override restart-runner\'s double-dispatch guard', () => {
    const { calls, heal } = capture();
    heal();
    expect(calls.run[0].args.some((a) => String(a).includes('force'))).toBe(false);
  });

  it('a failed reset SHORT-CIRCUITS — it never restarts onto a tree it could not roll back', () => {
    const { calls, heal } = capture();
    const out = heal({ git: () => ({ ok: false, stdout: '', stderr: 'fatal: bad object\n' }) });
    expect(out).toMatchObject({ rolledBack: false, restarted: false });
    expect(out.error).toContain('fatal: bad object');
    expect(calls.run).toEqual([]);
  });

  it('a refusing restart-runner is reported, not swallowed — the next check tries again', () => {
    const { heal } = capture();
    const out = heal({ run: () => ({ status: 1, stdout: '', stderr: 'restart-runner: REFUSING — 1 build agent(s) spawned\n' }) });
    expect(out).toMatchObject({ rolledBack: true, restarted: false, restartStatus: 1 });
    expect(out.error).toContain('REFUSING');
  });
});

// ── (8) one whole pass ─────────────────────────────────────────────────────────────────────────────────────

describe('runWatchdogOnce — observe, judge, heal, and ALWAYS surface', () => {
  const harness = (over = {}) => {
    const seen = { logs: [], notices: [], heals: [], alerts: [] };
    const alertStore = { value: over.lastAlert ?? null };
    const result = runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => ({
        checkout: '/drv', nowMs: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS,
        ...stuck(), ...(over.facts || {}),
      }),
      readHeadFn: () => over.head ?? { sha: HEAD_SHA, dirty: false },
      readMarker: () => (over.marker === undefined ? { sha: GOOD } : over.marker),
      heal: (a) => { seen.heals.push(a); return over.healResult ?? { rolledBack: true, restarted: true, sha: GOOD, error: null }; },
      notify: (n) => seen.notices.push(n),
      appendLog: (p, l) => seen.logs.push([p, l]),
      loadAlert: () => alertStore.value,
      saveAlert: (p, v) => { seen.alerts.push([p, v]); alertStore.value = v; return p; },
      now: () => NOW,
      ...(over.opts || {}),
    });
    return { result, seen };
  };

  it('a HEALTHY driver: logs its state, heals nothing, notifies nobody', () => {
    const { result, seen } = harness({ facts: { queue: [] } });
    expect(result).toMatchObject({ action: 'none', rollback: null, heal: null, alerted: false });
    expect(result.verdict.state).toBe('idle');
    expect(seen.heals).toEqual([]);
    expect(seen.notices).toEqual([]);
    expect(seen.logs[0][0]).toBe(logPath('/drv'));
    expect(seen.logs[0][1]).toContain('watchdog[idle]');
  });

  it('in-flight work heals nothing either', () => {
    const { result, seen } = harness({ facts: { agents: [{ name: 'conveyor-3383', startedAt: NOW }] } });
    expect(result.action).toBe('none');
    expect(seen.heals).toEqual([]);
  });

  it('#3383 FIX: a CONFIRMED-dead registered session is logged distinctly, EVERY check, never silently dropped', () => {
    const { result, seen } = harness({
      facts: {
        agents: [{ name: 'conveyor-3383', startedAt: NOW - 10 * 24 * 60 * MIN, pidAlive: false }],
        progress: { source: 'queue-sidecar', atMs: NOW - 45 * MIN },
      },
    });
    expect(result.verdict.state).toBe('stale'); // the item is now correctly eligible, not falsely "working"
    expect(result.verdict.deadSessions).toEqual([{ num: '3383', session: 'conveyor-3383' }]);
    const logged = seen.logs.map((l) => l[1]).join('\n');
    expect(logged).toContain('CONFIRMED no longer running');
    expect(logged).toContain('conveyor-3383');
  });

  it('a merely-unprobed (unknown) session logs NO dead-session line — never a false accusation', () => {
    const { seen } = harness({ facts: { agents: [{ name: 'conveyor-3383', startedAt: NOW }] } });
    expect(seen.logs.map((l) => l[1]).join('\n')).not.toContain('CONFIRMED no longer running');
  });

  it('a STALE driver is rolled back and restarted, and a human is told', () => {
    const { result, seen } = harness();
    expect(result.action).toBe('healed');
    expect(result.rollback).toMatchObject({ roll: true, sha: GOOD });
    expect(seen.heals[0]).toMatchObject({ checkout: '/drv', sha: GOOD });
    expect(result.alerted).toBe(true);
    expect(seen.notices[0].title).toContain('ROLLED BACK');
    expect(seen.notices[0].body).toContain('/drv');
    expect(seen.logs.map((l) => l[1]).join('\n')).toContain('HEALED');
  });

  it('a REFUSED rollback still escalates — the case with nothing else to show for itself', () => {
    const { result, seen } = harness({ head: { sha: HEAD_SHA, dirty: true } });
    expect(result.action).toBe('refused');
    expect(result.rollback.guard).toBe('dirty-checkout');
    expect(seen.heals).toEqual([]);
    expect(result.alerted).toBe(true);
    expect(seen.notices[0].title).toContain('STALE');
    expect(seen.notices[0].body).toContain('uncommitted');
  });

  it('a missing marker refuses and escalates rather than guessing a commit', () => {
    const { result, seen } = harness({ marker: null });
    expect(result.rollback.guard).toBe('no-fallback');
    expect(seen.heals).toEqual([]);
    expect(result.alerted).toBe(true);
  });

  it('the loop guard fires end to end: already at last-known-good ⇒ refuse, never re-heal', () => {
    const { result, seen } = harness({ head: { sha: GOOD, dirty: false } });
    expect(result.action).toBe('refused');
    expect(result.rollback.guard).toBe('already-at-last-known-good');
    expect(seen.heals).toEqual([]);
  });

  it('--dry-run diagnoses and logs but touches nothing', () => {
    const { result, seen } = harness({ opts: { dryRun: true } });
    expect(result.action).toBe('dry-run');
    expect(seen.heals).toEqual([]);
    expect(seen.logs.map((l) => l[1]).join('\n')).toContain('DRY RUN');
  });

  it('an incomplete heal is reported as `heal-failed`, not as success', () => {
    const { result, seen } = harness({ healResult: { rolledBack: true, restarted: false, sha: GOOD, error: 'restart-runner exited 1' } });
    expect(result.action).toBe('heal-failed');
    expect(seen.logs.map((l) => l[1]).join('\n')).toContain('HEAL INCOMPLETE');
  });

  it('the escalation DEDUPS — the same stuck state does not re-notify every pass', () => {
    const first = harness({ head: { sha: HEAD_SHA, dirty: true } });
    expect(first.result.alerted).toBe(true);
    const again = harness({ head: { sha: HEAD_SHA, dirty: true }, lastAlert: first.seen.alerts[0][1] });
    expect(again.result.alerted).toBe(false);
    expect(again.seen.notices).toEqual([]);
    // …but it is still judged and still logged, so the record is continuous.
    expect(again.result.verdict.state).toBe('stale');
    expect(again.seen.logs.length).toBeGreaterThan(0);
  });

  it('a CHANGED situation re-notifies immediately', () => {
    const first = harness({ head: { sha: HEAD_SHA, dirty: true } });
    const changed = harness({ marker: null, lastAlert: first.seen.alerts[0][1] });
    expect(changed.result.alerted).toBe(true);
  });

  it('the alert record lands beside the queue it describes', () => {
    const { seen } = harness({ head: { sha: HEAD_SHA, dirty: true } });
    expect(seen.alerts[0][0]).toBe(alertPath('/drv'));
    expect(seen.alerts[0][1]).toMatchObject({ state: 'stale', action: 'refused' });
  });
});

// ── (8a) THE GAP FOUND TONIGHT: a fully-DOWN driver never alerted ─────────────────────────────────────────
//
// `.conveyor/watchdog-alert.json` was confirmed to sit untouched through two real "down" episodes: `down`
// always sets `actionable:false`, and `runWatchdogOnce` gated the desktop notification ENTIRELY on
// `verdict.actionable` — so the most severe verdict this file can reach (the driver is not even running) was
// the one that never told anyone. The fix widens ONLY the alert path for `down`, reusing the exact
// `notifyDesktop`/`decideEscalation` mechanism `stale` already had. It must NOT widen healing: `down` must
// never reach `decideRollback`/`healDriver` (rolling a checkout back under a dead driver destroys evidence —
// see `classifyDriver`'s own `down` branch), so `verdict.actionable` stays `false` and is asserted so below.

describe('runWatchdogOnce — a DOWN driver now ALERTS, but is still never healed (tonight\'s gap)', () => {
  const downFacts = (over = {}) => ({
    checkout: '/drv', nowMs: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS,
    ...stuck({ lease: { held: false, stale: true, detail: 'holder crashed' } }),
    ...over,
  });

  it('THE FIX: a DOWN verdict fires the SAME desktop notification `stale` uses, and records the dedup alert', () => {
    const seen = { logs: [], notices: [], alerts: [] };
    const result = runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => downFacts(),
      readHeadFn: () => { throw new Error('a DOWN verdict must never read the driver\'s HEAD — see decideRollback\'s not-stale guard'); },
      readMarker: () => { throw new Error('a DOWN verdict must never read the last-known-good marker'); },
      heal: () => { throw new Error('a DOWN driver must NEVER be healed by this file — that stays restart-runner\'s job'); },
      notify: (n) => seen.notices.push(n),
      appendLog: (p, l) => seen.logs.push([p, l]),
      loadAlert: () => null,
      saveAlert: (p, v) => { seen.alerts.push([p, v]); return p; },
      now: () => NOW,
    });
    expect(result.verdict.state).toBe('down');
    expect(result.verdict.actionable).toBe(false); // THE HEAL-GATING IS UNCHANGED — only the alert widened
    expect(result.action).toBe('alert-only');
    expect(result.rollback).toBeNull();
    expect(result.heal).toBeNull();
    expect(result.alerted).toBe(true);
    expect(seen.notices).toHaveLength(1);
    expect(seen.notices[0].title).toBe('Conveyor driver DOWN');
    expect(seen.notices[0].body).toContain('/drv');
    expect(seen.notices[0].body).toContain('holder crashed');
    expect(seen.alerts[0][0]).toBe(alertPath('/drv'));
    expect(seen.alerts[0][1]).toMatchObject({ state: 'down', action: 'alert-only' });
    expect(seen.logs.map((l) => l[1]).join('\n')).toContain('watchdog[down]');
  });

  // quietHours (card xmvc6oc): the DOWN alert says how long nothing has moved (the silence, not an episode age), so
  // overnight it is held below 30 min and breaks through on the re-nag once the silence has grown past it.
  it('tags the DOWN alert {kind:daemon-down, downForMs: the silence}; the re-nag carries the longer silence', () => {
    const notices = [];
    const alertStore = { value: null };
    const run = (nowMs) => runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => downFacts({ nowMs }),
      readHeadFn: () => { throw new Error('must not read HEAD for `down`'); },
      heal: () => { throw new Error('must not heal `down`'); },
      notify: (n) => notices.push(n),
      appendLog: () => {},
      loadAlert: () => alertStore.value,
      saveAlert: (p, v) => { alertStore.value = v; return p; },
      now: () => nowMs,
    });
    const first = run(NOW);
    expect(Number.isFinite(first.verdict.quietMs)).toBe(true);
    expect(notices[0].emergency).toEqual({ kind: 'daemon-down', downForMs: first.verdict.quietMs });
    const later = run(NOW + DEFAULT_RENAG_MS + MIN);
    expect(later.alerted).toBe(true);
    expect(notices[1].emergency.downForMs).toBe(first.verdict.quietMs + DEFAULT_RENAG_MS + MIN);
    expect(notices[1].emergency.downForMs).toBeGreaterThanOrEqual(30 * MIN);
  });

  it('DEDUPS exactly like `stale` — the SAME down cause does not re-notify inside the re-nag window', () => {
    const notices = [];
    const alertStore = { value: null };
    const run = () => runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => downFacts(),
      readHeadFn: () => { throw new Error('must not read HEAD for `down`'); },
      heal: () => { throw new Error('must not heal `down`'); },
      notify: (n) => notices.push(n),
      appendLog: () => {},
      loadAlert: () => alertStore.value,
      saveAlert: (p, v) => { alertStore.value = v; return p; },
      now: () => NOW,
    });
    expect(run().alerted).toBe(true);
    expect(run().alerted).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it('a CHANGED down cause re-notifies immediately — a different lease detail is a different signature', () => {
    const notices = [];
    const alertStore = { value: null };
    const run = (detail) => runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => downFacts({ lease: { held: false, stale: true, detail } }),
      readHeadFn: () => { throw new Error('must not read HEAD for `down`'); },
      heal: () => { throw new Error('must not heal `down`'); },
      notify: (n) => notices.push(n),
      appendLog: () => {},
      loadAlert: () => alertStore.value,
      saveAlert: (p, v) => { alertStore.value = v; return p; },
      now: () => NOW,
    });
    expect(run('holder crashed').alerted).toBe(true);
    expect(run('a completely different failure').alerted).toBe(true);
    expect(notices).toHaveLength(2);
  });

  it('REGRESSION GUARD: `stale`\'s own heal path is untouched — still reaches decideRollback/heal exactly as before', () => {
    const seen = { heals: [], notices: [] };
    const result = runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => ({ checkout: '/drv', nowMs: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS, ...stuck() }),
      readHeadFn: () => ({ sha: HEAD_SHA, dirty: false }),
      readMarker: () => ({ sha: GOOD }),
      heal: (a) => { seen.heals.push(a); return { rolledBack: true, restarted: true, sha: GOOD, error: null }; },
      notify: (n) => seen.notices.push(n),
      appendLog: () => {},
      loadAlert: () => null,
      saveAlert: () => '/drv/.conveyor/watchdog-alert.json',
      now: () => NOW,
    });
    expect(result.verdict.state).toBe('stale');
    expect(result.action).toBe('healed');
    expect(seen.heals).toHaveLength(1);
    expect(seen.notices[0].title).toContain('ROLLED BACK');
  });
});

describe('parseFlags', () => {
  it('splits --k=v, bare --flags and positionals', () => {
    expect(parseFlags(['heal', '--checkout=/drv', '--stale-after-min=5', '--dry-run']))
      .toEqual({ flags: { checkout: '/drv', 'stale-after-min': '5', 'dry-run': true }, rest: ['heal'] });
  });
});

// ── (8b) THE LAUNCH-POSTURE MARKER, end to end ─────────────────────────────────────────────────────────────

describe('driver-mode.mjs — the sidecar that says whether this driver was SUPPOSED to keep running', () => {
  it('classifies the launch flags exactly as runner.mjs#main does — `--once` and a finite `--max-ticks` are bounded', () => {
    // Mirrors the runner's own `flags.once ? 1 : finiteOr(flags['max-ticks'], Infinity)`. A launch with no
    // ceiling at all is the supervisor's resident driver, and the runner's own fallback is `Infinity`.
    expect(driverModeFor({ once: true })).toBe('bounded');
    expect(driverModeFor({ once: true, maxTicks: 1 })).toBe('bounded');
    expect(driverModeFor({ maxTicks: 5 })).toBe('bounded');
    expect(driverModeFor({})).toBe('resident');
    expect(driverModeFor({ maxTicks: Infinity })).toBe('resident');
    expect(driverModeFor({ maxTicks: 0 })).toBe('resident');
    expect(driverModeFor({ maxTicks: NaN })).toBe('resident');
    expect(driverModeFor()).toBe('resident');
  });

  it('round-trips through a REAL file, and the reader agrees with the writer about the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-mode-'));
    try {
      const { ok, path, record } = writeDriverMode({ root: dir, mode: 'bounded', maxTicks: 1, pid: 4242, now: () => NOW });
      expect(ok).toBe(true);
      expect(path).toBe(driverModePath(dir));           // one spelling, the writer's
      expect(record).toMatchObject({ mode: 'bounded', maxTicks: 1, pid: 4242 });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
      expect(readDriverMode(dir)).toEqual({ mode: 'bounded', startedAt: record.startedAt, pid: 4242, maxTicks: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a checkout that never ran a marker-writing runner reads as `null` — absence, not a guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-mode-'));
    try { expect(readDriverMode(dir)).toBe(null); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a mode that is not one of the two, rather than recording a word nothing understands', () => {
    const bad = writeDriverMode({ root: '/nope', mode: 'whenever' });
    expect(bad).toMatchObject({ ok: false, record: null });
    expect(bad.error).toContain('whenever');
    expect(DRIVER_MODES).toEqual(['bounded', 'resident']);
  });

  it('is BEST-EFFORT — an unwritable checkout returns the error instead of throwing, so a runner still starts', () => {
    const res = writeDriverMode({ root: '/drv', mode: 'resident', mkdir: () => { throw new Error('EROFS: read-only file system'); } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('EROFS');
  });

  it('writes atomically (temp + rename), so a watchdog reading mid-write never sees partial JSON', () => {
    // Partial JSON parses to `null`, which reads as "no marker" — straight back into the bug being fixed.
    const writes = [];
    const renames = [];
    writeDriverMode({
      root: '/drv', mode: 'bounded', maxTicks: 1, pid: 7, now: () => NOW,
      mkdir: () => {}, write: (p, s) => writes.push([p, s]), rename: (a, b) => renames.push([a, b]),
    });
    expect(writes[0][0]).not.toBe(driverModePath('/drv'));
    expect(writes[0][0]).toContain('.tmp');
    expect(renames[0]).toEqual([writes[0][0], driverModePath('/drv')]);
  });
});

describe('readWatchdogFacts — the marker reaches the verdict', () => {
  const facts = (readMode) => readWatchdogFacts({
    checkout: '/drv',
    listAgents: () => [],
    readQueueText: () => JSON.stringify([{ num: '3383' }]),
    leaseStatus: () => ({ held: false, stale: false, heartbeatAt: null, detail: 'no runner lease at all' }),
    readMode,
    stat: () => NOW - 45 * MIN,
    scanRuns: () => null,
    now: () => NOW,
  });

  it('reads the marker from the DRIVER\'s checkout and threads it onto the verdict', () => {
    const seen = [];
    const f = facts((root) => { seen.push(root); return { mode: 'bounded', startedAt: '…', pid: 1, maxTicks: 1 }; });
    expect(seen).toEqual(['/drv']);
    expect(classifyDriver({ ...f, driverMode: f.driverMode }).state).toBe('completed');
  });

  it('…and with no marker the SAME facts still read as `down`, the pre-fix answer', () => {
    const f = facts(() => null);
    expect(f.driverMode).toBe(null);
    expect(classifyDriver({ ...f, driverMode: f.driverMode }).state).toBe('down');
  });

  it('the marker is NOT a progress signal — it is written once at launch and must never look like movement', () => {
    // `stat` is the only thing feeding `latestProgress`; the marker path must not be among the paths statted.
    const statted = [];
    readWatchdogFacts({
      checkout: '/drv', listAgents: () => [], readQueueText: () => '[]',
      leaseStatus: () => ({ held: true }), readMode: () => ({ mode: 'bounded' }),
      stat: (p) => { statted.push(p); return NOW; }, scanRuns: () => null, now: () => NOW,
    });
    expect(statted).not.toContain(driverModePath('/drv'));
  });

  it('#3383 FIX: attaches a resolved `pidAlive` to every listed agent, via ONE shared `ps aux` scan — never one subprocess per row', () => {
    let psCalls = 0;
    const f = readWatchdogFacts({
      checkout: '/drv',
      listAgents: () => [
        { name: 'conveyor-3383', sessionId: 'alive-uuid' },
        { name: 'conveyor-9999', sessionId: 'dead-uuid' },
      ],
      readQueueText: () => JSON.stringify([{ num: '3383' }, { num: '9999' }]),
      leaseStatus: () => ({ held: true }),
      readMode: () => null,
      stat: () => NOW,
      scanRuns: () => null,
      scanPs: () => { psCalls += 1; return 'proc … --resume=alive-uuid …\n'; },
      now: () => NOW,
    });
    expect(psCalls).toBe(1); // ONE scan for the whole batch
    expect(f.agents.find((a) => a.name === 'conveyor-3383').pidAlive).toBe(true);
    expect(f.agents.find((a) => a.name === 'conveyor-9999').pidAlive).toBe(false);
  });

  it('skips the `ps aux` scan entirely when nothing was listed — no rows, nothing to probe', () => {
    let psCalls = 0;
    readWatchdogFacts({
      checkout: '/drv', listAgents: () => [], readQueueText: () => '[]',
      leaseStatus: () => ({ held: true }), readMode: () => null, stat: () => NOW, scanRuns: () => null,
      scanPs: () => { psCalls += 1; return ''; }, now: () => NOW,
    });
    expect(psCalls).toBe(0);
  });
});

describe('runWatchdogOnce — a finished bounded driver is logged as done and nobody is woken up', () => {
  it('logs `completed`, heals nothing, alerts nobody', () => {
    const seen = { logs: [], notices: [], heals: [] };
    const result = runWatchdogOnce({
      checkout: '/drv',
      readFacts: () => ({
        checkout: '/drv', nowMs: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS,
        ...stuck({ lease: { held: false, stale: false, detail: 'no runner lease at all' } }),
        driverMode: { mode: 'bounded', startedAt: '2026-09-12T17:30:00.000Z', pid: 4242, maxTicks: 1 },
      }),
      readHeadFn: () => { throw new Error('a non-actionable verdict must never read the driver\'s HEAD'); },
      readMarker: () => ({ sha: GOOD }),
      heal: () => { throw new Error('a completed bounded driver must never be healed'); },
      notify: (n) => seen.notices.push(n),
      appendLog: (p, l) => seen.logs.push([p, l]),
      loadAlert: () => null,
      saveAlert: () => '/drv/.conveyor/watchdog-alert.json',
      now: () => NOW,
    });
    expect(result).toMatchObject({ action: 'none', rollback: null, heal: null, alerted: false });
    expect(result.verdict.state).toBe('completed');
    expect(seen.notices).toEqual([]);
    expect(seen.logs[0][0]).toBe(logPath('/drv'));
    expect(seen.logs[0][1]).toContain('watchdog[completed]');
    // The regression in one line: the 5-minutely log line no longer claims a crash.
    expect(seen.logs[0][1]).not.toMatch(/is a crash\b/);
  });
});

// ── (8c) THE WATCHED SESSION KINDS agree with the dispatcher's own slugs ───────────────────────────────────

describe('WATCHED_SESSION_KINDS covers every slug the dispatcher actually mints', () => {
  it('an `investigate-<num>` session for a queued item counts as IN FLIGHT (it did not, and that was the hole)', () => {
    // `sessionSlugFor(num, 'investigate')` is keyed on the ITEM id exactly like `conveyor-<num>`, but
    // `investigate` was missing from the watched list, so a live investigation read as "no session at all" and
    // let the `working` branch fall through to `down`/`settling`/`stale` with real work still out.
    expect(sessionMatchesItem(sessionSlugFor('3383', 'investigate'), '3383')).toBe(true);
    const v = classifyDriver(stuck({
      agents: [{ name: 'investigate-3383', startedAt: NOW - MIN }],
      lease: { held: false, stale: false, detail: 'no runner lease at all' },
    }));
    expect(v.state).toBe('working');
    expect(v.actionable).toBe(false);
    expect(v.reason).toContain('investigate-3383');
  });

  it('every item-keyed slug kind the dispatcher mints is watched — a new kind fails HERE, not in production', () => {
    // `fix`/`ci-heal` are keyed on the PR number rather than the item, so they are exercised at the id they are
    // actually given; the point is that the PREFIX is one the watchdog recognises.
    for (const kind of ['build', 'prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal']) {
      const slug = sessionSlugFor('3383', kind, '3383');
      expect(sessionMatchesItem(slug, '3383'), `${kind} ⇒ ${slug} is not watched`).toBe(true);
    }
  });

  it('widening the list did not widen ALIASING — nothing is extracted, so nothing can collide', () => {
    expect(sessionMatchesItem('investigate-33830', '3383')).toBe(false);
    expect(sessionMatchesItem('ci-heal-33830', '3383')).toBe(false);
    expect(sessionMatchesItem('my-investigate-3383', '3383')).toBe(false);
  });
});

// ── (9) THE PURITY ASSERTION — the reason this file exists at all ──────────────────────────────────────────

describe('the watchdog shares NONE of the driver\'s own decision logic', () => {
  const ENTRY = join(WATCHDOG_REPO_ROOT, 'scripts', 'conveyor', 'driver-watchdog.mjs');

  it('cannot reach the driver\'s planning modules — a bug there cannot disable the thing that catches it', () => {
    const reached = importGraph(ENTRY).files.map((f) => f.split('/').pop());
    for (const forbidden of [
      'tick-core.mjs',          // the mechanized tick's state machine
      'dispatch-plan.mjs',      // "what may be dispatched right now"
      'dispatch-lane.mjs',      // the dispatch operation's declaration
      'dispatch-lane-io.mjs',   // …and its io shell, which imports the declaration
      'dispatch-pause.mjs',     // the pause lever the planner reads
      'lane-concurrency.mjs',   // the concurrency cap the planner reads
      'queue-scope.mjs',        // the scoping lever the passes read
      'scope-lease.mjs',
      'conveyor-state.mjs',
      'runner.mjs',
      'supervisor.mjs',
    ]) expect(reached).not.toContain(forbidden);
  });

  it('its WHOLE graph is this short list — a `toEqual`, so any future creep fails here rather than passing silently', () => {
    // `toEqual` and not `not.toContain`: the point of this suite's purity half is that nobody can widen the
    // watchdog's dependency surface without a test telling them. Adding a module is fine; adding one silently
    // is not. (`import-graph.mjs`'s own header recommends exactly this shape.)
    expect(importGraph(ENTRY).files.map((f) => f.split('/').pop()).sort()).toEqual([
      'automation-home.mjs',        // decouple-primary-checkout — queue-store's state-home path (leaf: builtins only)
      'bounded-child.mjs',          // #x5n4zn3 — branch-sync.mjs's gitRun budget (resolveChildTimeoutMs) only
      'branch-sync.mjs',            // gitRun / notifyDesktop / decideEscalation / defaultAppendLog (#3472)
      'claude-agents-cache.mjs',    // hot-cache — short-TTL file cache for `claude agents --json` (leaf: builtins only)
      'constellation-repos.mjs',   // decouple-primary-checkout — the primary's dir names, for the legacy queue read
      'daemon-clone-layout.mjs',    // card 89 S1 — logical clone identity for daemon-last-good's cloneKeyOf (leaf: builtins only)
      'daemon-last-good.mjs',       // decouple-primary-checkout — daemonConveyorStateRoot (the state home)
      'driver-mode.mjs',            // the launch-posture sidecar's GRAMMAR — bounded vs resident, path+parse only
      'driver-watchdog.mjs',
      'file-locks.mjs',             // the lease TTL primitive
      'git-run.mjs',                // #x8pcbf3 — branch-sync's ensureFullHistory (shallow-checkout recovery)
      'infra-blocked.mjs',          // branch-sync's backoff primitives
      'policy-cascade.mjs',         // #5600 — quiet-hours-io's settings resolve through the shared cascade (builtins + under-test only)
      'pr-land-reasons.mjs',        // #4348-open-pr-retry — infra-blocked's refused/unrun split (leaf: no imports)
      'queue-store.mjs',            // the sidecar GRAMMAR — parseQueue / normNum
      'quiet-hours-io.mjs',         // card xmvc6oc — branch-sync's notify goes through the quietHours gate
      'quiet-hours.mjs',            // card xmvc6oc — its pure core (leaf: no imports)
      'resolve-runner-checkout.mjs',// lease pid → checkout
      'runner-lock.mjs',            // the singleton lease
      'under-test.mjs',             // #5187 — claude-agents-cache's runner-neutral test-isolation predicate
      'write-all-sync.mjs',
    ]);
  });

  it('reads the queue sidecar as BYTES through the shared parser, never through the driver\'s planner', () => {
    // The substantive form of the claim above: handed a queue file and a listing, the watchdog reaches a
    // verdict with no planner in sight, and it is the DUMB verdict — it knows nothing of holds or caps.
    const facts = stuck({ queue: [{ num: '3383' }, { num: 'xqxpeac' }] });
    expect(classifyDriver(facts).eligible.map((e) => e.num)).toEqual(['3383', 'xqxpeac']);
  });

  it('pulls in no package dependency — only this repo\'s own modules and `node:` builtins', () => {
    expect(importGraph(ENTRY).external.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });
});
