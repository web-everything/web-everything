/**
 * @file scripts/readiness/__tests__/heavy-admission-fast-lane.test.mjs
 * @description Card xkyw1x4 — the heavy-admission IO half against a REAL (temp) lock root: the FAST LANE (a short
 *   job never waits behind a full-suite waiter; one slot reserved for short jobs; first-come-first-served still
 *   holds inside each lane), hold durations recorded by kind on release, and the queue baseline (held + waiting +
 *   dispatched-not-yet-queued). Never touches the real lane pool: every lock root is a `mkdtemp` dir and lane
 *   leases are injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runUnderAdmission, acquireSlotBlocking, tryAcquireSlot, markWaiting, releaseOwnedSlot, heldSlots, listWaiting, clearWaiting,
  recordHoldDuration, readHoldDurations, readStandardMinutes, resolveQueueBaseline, resolveLiveQueueBaseline,
} from '../heavy-admission.mjs';

const roots = [];
function tempRoot() {
  const r = mkdtempSync(join(tmpdir(), 'heavy-fast-lane-'));
  roots.push(r);
  return r;
}
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-25T20:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** A deterministic clock + sleep: each sleep advances the clock by `pollMs` and runs `onSleep(n)`. */
function fakeTime({ start = T0, onSleep = () => {} } = {}) {
  let t = start;
  let n = 0;
  return {
    now: () => t,
    sleep: async (ms) => { n += 1; t += ms; onSleep(n); },
    polls: () => n,
  };
}

/** A slot held by a "full suite" that is still running (own pid → liveness unknown → the lease protects it). */
function holdSlot(lockRoot, cap, owner, kind = 'FULL', slot = 0) {
  const r = tryAcquireSlot({ lockRoot, cap, owner, pid: process.pid, nowMs: T0, nowIso: iso(T0), meta: { kind, acquiredAt: iso(T0) }, slots: [slot] });
  expect(r.ok).toBe(true);
}

describe('fast lane — the fast slot is ADDED ON TOP of the heavy cap (operator decision on PR #2707)', () => {
  it('cap 2: TWO full suites run at once while a short job uses the fast slot', async () => {
    const lockRoot = tempRoot();
    const clock = fakeTime();
    const opts = { lockRoot, cap: 2, env: {}, canDefer: true, ceilingMs: 10_000, log: () => {}, ...clock };
    const a = await acquireSlotBlocking({ ...opts, owner: 'lane-full-a', kind: 'FULL' });
    const b = await acquireSlotBlocking({ ...opts, owner: 'lane-full-b', kind: 'FULL' });
    const c = await acquireSlotBlocking({ ...opts, owner: 'lane-fixer-check', kind: 'selected' });
    expect([a, b, c].map((r) => [r.ok, r.slot, r.waitedMs])).toEqual([[true, 0, 0], [true, 1, 0], [true, 2, 0]]);
    expect(heldSlots({ lockRoot, cap: 2, fastSlots: 1 }).map((h) => h.meta?.kind)).toEqual(['FULL', 'FULL', 'selected']);
    // The fast slot is released like any other (the release scans past the heavy slots).
    expect(releaseOwnedSlot({ lockRoot, cap: 2, owner: 'lane-fixer-check', fastSlots: 1 })).toEqual({ released: true, slot: 2 });
  });

  it('cap 2: a THIRD full suite waits — it never takes the fast slot', async () => {
    const lockRoot = tempRoot();
    holdSlot(lockRoot, 2, 'lane-full-a', 'FULL', 0);
    holdSlot(lockRoot, 2, 'lane-full-b', 'FULL', 1);
    const r = await acquireSlotBlocking({ lockRoot, cap: 2, owner: 'lane-full-c', kind: 'FULL', env: {}, canDefer: true, ceilingMs: 10_000, log: () => {}, ...fakeTime() });
    expect(r).toMatchObject({ ok: false, ceilingHit: true });
  });

  it('a short job arriving after a full-suite WAITER still takes the fast slot at once', async () => {
    const lockRoot = tempRoot();
    holdSlot(lockRoot, 2, 'lane-full-a', 'FULL', 0);
    holdSlot(lockRoot, 2, 'lane-full-b', 'FULL', 1);
    markWaiting({ lockRoot, owner: 'lane-full-waiting', lane: '5', pid: process.pid, kind: 'FULL', nowIso: iso(T0 - 60_000) });
    const r = await acquireSlotBlocking({ lockRoot, cap: 2, owner: 'lane-fixer-check', kind: 'standards', env: {}, canDefer: true, ceilingMs: 60_000, log: () => {}, ...fakeTime() });
    expect(r).toMatchObject({ ok: true, slot: 2, waitedMs: 0 });
  });

  it('when the fast slot is busy, a short job may take a free heavy slot', async () => {
    const lockRoot = tempRoot();
    holdSlot(lockRoot, 2, 'lane-short-busy', 'selected', 2);
    const r = await acquireSlotBlocking({ lockRoot, cap: 2, owner: 'lane-fixer-check', kind: 'files', env: {}, canDefer: true, ceilingMs: 10_000, log: () => {}, ...fakeTime() });
    expect(r).toMatchObject({ ok: true, slot: 0 });
  });

  it('no fast slot (WE_HEAVY_ADMISSION_FAST_SLOTS=0), cap 1: when the slot frees, the short job still goes ahead of an OLDER full-suite waiter', async () => {
    const lockRoot = tempRoot();
    holdSlot(lockRoot, 1, 'lane-full-running', 'FULL', 0);
    markWaiting({ lockRoot, owner: 'lane-full-waiting', lane: '5', pid: process.pid, kind: 'FULL', nowIso: iso(T0 - 60_000) });
    const clock = fakeTime({ onSleep: (n) => { if (n === 1) releaseOwnedSlot({ lockRoot, cap: 1, owner: 'lane-full-running' }); } });
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'lane-fixer-check', kind: 'standards', env: { WE_HEAVY_ADMISSION_FAST_SLOTS: '0', LANE_POOL_ROOT: '/private-test-pool' }, canDefer: true, ceilingMs: 60_000, log: () => {}, ...clock,
    });
    expect(r).toMatchObject({ ok: true, slot: 0 });
    expect(clock.polls()).toBe(1);
  });

  it('first-come-first-served still holds INSIDE the fast lane: an older short waiter goes first', async () => {
    const lockRoot = tempRoot();
    markWaiting({ lockRoot, owner: 'lane-older-short', lane: '7', pid: process.pid, kind: 'selected', nowIso: iso(T0 - 60_000) });
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'lane-newer-short', kind: 'files', env: {}, canDefer: true, ceilingMs: 10_000, log: () => {}, ...fakeTime() });
    expect(r).toMatchObject({ ok: false, ceilingHit: true });
  });

  it('a full-suite waiter still ranks first-come-first-served among full suites', async () => {
    const lockRoot = tempRoot();
    markWaiting({ lockRoot, owner: 'lane-older-full', lane: '7', pid: process.pid, kind: 'FULL', nowIso: iso(T0 - 60_000) });
    const r = await acquireSlotBlocking({ lockRoot, cap: 2, owner: 'lane-newer-full', kind: 'FULL', env: {}, canDefer: true, ceilingMs: 10_000, log: () => {}, ...fakeTime() });
    expect(r).toMatchObject({ ok: false, ceilingHit: true });
  });
});

describe('waiting markers — two long owners never share one marker file', () => {
  it('owners that differ only after 128 characters (lanes under a deep pool root) keep separate markers', () => {
    const lockRoot = tempRoot();
    const deep = `/tmp/${'x'.repeat(140)}/web-everything`;
    markWaiting({ lockRoot, owner: `${deep}/lane-2#1`, pid: process.pid, kind: 'FULL', nowIso: iso(T0) });
    markWaiting({ lockRoot, owner: `${deep}/lane-3#2`, pid: process.pid, kind: 'FULL', nowIso: iso(T0) });
    expect(listWaiting(lockRoot).map((m) => m.owner).sort()).toEqual([`${deep}/lane-2#1`, `${deep}/lane-3#2`]);
    clearWaiting({ lockRoot, owner: `${deep}/lane-2#1` });
    expect(listWaiting(lockRoot).map((m) => m.owner)).toEqual([`${deep}/lane-3#2`]);
  });
});

describe('hold durations — recorded by kind on release, rolled into the standard time', () => {
  it('each release appends {kind, ms}; three FULL holds of ~20m make FULL\'s standard ~20m', async () => {
    const lockRoot = tempRoot();
    for (let i = 0; i < 3; i++) {
      const owner = `lane-${i}`;
      // Acquired "20 minutes ago" on the fake clock; released now on the real one.
      const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner, kind: 'FULL', env: {}, log: () => {}, now: () => Date.now() - 20 * 60_000, sleep: async () => {} });
      expect(r.ok).toBe(true);
      releaseOwnedSlot({ lockRoot, cap: 1, owner });
    }
    const recs = readHoldDurations(lockRoot);
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => r.kind === 'FULL' && r.ms >= 20 * 60_000 - 1000)).toBe(true);
    const { minutes, source } = readStandardMinutes(lockRoot);
    expect(Math.round(minutes.FULL)).toBe(20);
    expect(source.FULL.from).toBe('rolling');
    expect(source.selected.from).toBe('seed');
  });

  it('item 100 — a kind-less acquire is labelled from its command or holder, and the command is recorded', async () => {
    const lockRoot = tempRoot();
    const t = () => Date.now() - 60_000;
    const cases = [
      ['o1', { command: 'npm ci' }, 'build'],
      ['o2', { holder: 'verify-lane.mjs run' }, 'verify'],
      ['o3', { kind: 'other', command: 'node scripts/mystery.mjs', holder: 'mystery.mjs' }, 'other'],
    ];
    for (const [owner, extra, want] of cases) {
      const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner, env: {}, log: () => {}, now: t, sleep: async () => {}, ...extra });
      expect(r.ok).toBe(true);
      releaseOwnedSlot({ lockRoot, cap: 1, owner });
      expect(readHoldDurations(lockRoot).at(-1).kind, owner).toBe(want);
    }
    const last = readHoldDurations(lockRoot).at(-1);
    expect(last.command).toBe('node scripts/mystery.mjs');
    expect(last.holder).toBe('mystery.mjs');
  });

  it('card xmh9mtr — identity at acquire: a dispatcher env identity is recorded though the lane has no lease at release', async () => {
    const lockRoot = tempRoot();
    const lane = join(tempRoot(), 'lane-12'); // no `.git/.lane-lease` at all — the reaped probation lane
    const env = { WE_HEAVY_SESSION: 'conveyor-4420', WE_HEAVY_DISPATCH_KIND: 'build', WE_HEAVY_RUN_ID: 'run-abc' };
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: `${lane}#1`, kind: 'selected', env, log: () => {}, now: () => Date.now() - 60_000, sleep: async () => {} });
    expect(r.ok).toBe(true);
    releaseOwnedSlot({ lockRoot, cap: 1, owner: `${lane}#1` });
    expect(readHoldDurations(lockRoot).at(-1)).toMatchObject({ session: 'conveyor-4420', dispatchKind: 'build', runId: 'run-abc', repo: lane });
  });

  it('card xmh9mtr — identity at acquire: the lease held at ACQUIRE wins over the one (or none) left at release', async () => {
    const lockRoot = tempRoot();
    const lane = join(tempRoot(), 'lane-7');
    mkdirSync(join(lane, '.git'), { recursive: true });
    const lease = (o) => writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify(o));
    lease({ session: 'conveyor-77', purpose: 'probation-doc-fix-build', holder: 'probation-doc-fix-build-lane-7-aa', acquiredAt: iso(T0) });
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: lane, kind: 'standards', env: {}, log: () => {}, now: () => Date.now() - 60_000, sleep: async () => {} });
    expect(r.ok).toBe(true);
    // The lane is reaped and handed to someone else while the hold is still running.
    lease({ session: 'ci-heal-9', purpose: 'conveyor-ci-heal', holder: 'conveyor-ci-heal-lane-7-bb', acquiredAt: iso(T0 + 1) });
    releaseOwnedSlot({ lockRoot, cap: 1, owner: lane });
    expect(readHoldDurations(lockRoot).at(-1)).toMatchObject({ session: 'probation-doc-fix-build-lane-7-aa', dispatchKind: 'build', leaseAcquiredAt: iso(T0) });
  });

  it('a slot acquired by older code (no kind recorded) is released without writing a guessed duration', () => {
    const lockRoot = tempRoot();
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'legacy', pid: process.pid, nowMs: T0, nowIso: iso(T0) });
    releaseOwnedSlot({ lockRoot, cap: 1, owner: 'legacy' });
    expect(readHoldDurations(lockRoot)).toEqual([]);
  });
});

describe('resolveQueueBaseline — held + waiting + dispatched-not-yet-queued', () => {
  it('counts remaining held time, live waiters, and fresh dispatched sessions that have not reached the slots', () => {
    const lockRoot = tempRoot();
    const NOW = T0 + 6 * 60_000;
    tryAcquireSlot({ lockRoot, cap: 2, owner: '/p/we/lane-1#11', pid: process.pid, nowMs: T0, nowIso: iso(T0), meta: { kind: 'FULL', acquiredAt: iso(T0) } });
    markWaiting({ lockRoot, owner: '/p/we/lane-2', repo: '/p/we/lane-2', lane: '2', pid: process.pid, kind: 'selected', nowIso: iso(NOW - 60_000) });
    const leases = [
      { repo: '/p/we/lane-3', lease: { purpose: 'conveyor-fix', session: 'fix-10', acquiredAt: iso(NOW - 2 * 60_000), ttlMinutes: 240 } }, // pending fix
      { repo: '/p/we/lane-4', lease: { purpose: 'conveyor-delivery', session: 'conveyor-99', acquiredAt: iso(NOW - 3 * 60_000), ttlMinutes: 240 } }, // pending build
      { repo: '/p/we/lane-5', lease: { purpose: 'conveyor-fix', session: 'fix-11', acquiredAt: iso(NOW - 40 * 60_000), ttlMinutes: 240 } }, // past the arrival window
      { repo: '/p/we/lane-1', lease: { purpose: 'conveyor-fix', session: 'fix-12', acquiredAt: iso(NOW - 60_000), ttlMinutes: 240 } }, // already holding
      { repo: '/p/we/lane-6', lease: { purpose: 'review-juror', session: 'review-5', acquiredAt: iso(NOW - 60_000), ttlMinutes: 240 } }, // review: 0
      { repo: '/p/we/lane-7', lease: { purpose: 'hermetic-host-tests', session: 'Mac:1', acquiredAt: iso(NOW - 60_000), ttlMinutes: 240 } }, // not a dispatch
    ];
    const b = resolveQueueBaseline({ lockRoot, cap: 2, nowMs: NOW, env: {}, readLeases: () => leases, isLiveWaiter: () => true });
    expect(b.pending.map((p) => [p.lane, p.dispatchKind, p.demandMinutes])).toEqual([['3', 'fix', 3.25], ['4', 'build', 6.5]]);
    // FULL held 6m of 18 → 12 left; one selected waiter 3; pending 3.25 + 6.5 → 24.75 slot-min over 2 slots.
    expect(b).toMatchObject({ heldRemainingMinutes: 12, waitingMinutes: 3, pendingMinutes: 9.75, backlogMinutes: 24.75, maxWaitMinutes: 30 });
    // Per lane: heavy 12 over 2 heavy slots → 6m for a full suite; short 3 + 9.75 = 12.75 over 1 fast + 1 free heavy → 6.38m.
    expect(b).toMatchObject({ heavySlots: 2, fastSlots: 1, slots: 3, heavyBacklogMinutes: 12, shortBacklogMinutes: 12.75, freeHeavySlots: 1, shortCapacity: 2, heavyWaitMinutes: 6, projectedWaitMinutes: 6.38 });
  });

  it('a dispatched session that already finished a heavy run since its lease began is not pending any more', () => {
    const lockRoot = tempRoot();
    const now = Date.now();
    const leases = [{ repo: '/p/we/lane-3', lease: { purpose: 'conveyor-fix', session: 'fix-10', acquiredAt: iso(now - 5 * 60_000), ttlMinutes: 240 } }];
    // Before its first heavy run: pending.
    expect(resolveQueueBaseline({ lockRoot, cap: 1, nowMs: now, env: {}, readLeases: () => leases }).pending).toHaveLength(1);
    // It runs (and finishes) a selected check → a duration is recorded for its repo → it has arrived.
    tryAcquireSlot({ lockRoot, cap: 1, owner: '/p/we/lane-3#5', pid: process.pid, nowMs: now, nowIso: iso(now), meta: { kind: 'selected', acquiredAt: iso(now - 60_000) } });
    releaseOwnedSlot({ lockRoot, cap: 1, owner: '/p/we/lane-3#5' });
    expect(resolveQueueBaseline({ lockRoot, cap: 1, nowMs: Date.now() + 1000, env: {}, readLeases: () => leases }).pending).toEqual([]);
  });

  it('WE_QUEUE_ADMISSION=off and CI bypass the gate; the max wait is configurable', () => {
    const lockRoot = tempRoot();
    expect(resolveQueueBaseline({ lockRoot, cap: 2, env: { WE_QUEUE_ADMISSION: 'off' }, readLeases: () => [] }).bypassed).toBe('off');
    expect(resolveQueueBaseline({ lockRoot, cap: 2, env: { CI: 'true' }, readLeases: () => [] }).bypassed).toBe('ci');
    expect(resolveQueueBaseline({ lockRoot, cap: 2, env: { WE_QUEUE_ADMISSION_MAX_WAIT_MINUTES: '45' }, readLeases: () => [] }).maxWaitMinutes).toBe(45);
  });

  it('the live resolver never reads the real host pool from a test worker (fails open instead)', () => {
    const b = resolveLiveQueueBaseline({ checkoutRoot: '/nonexistent/checkout', env: { VITEST: 'true', HOME: '/nonexistent-home' } });
    expect(b.bypassed).toBe('error');
  });
});


describe('prepare hold identity and pending demand', () => {
  it('records the lane lease identity on release, preferring holder over session', () => {
    const lockRoot = tempRoot();
    const repo = tempRoot();
    const acquiredAt = iso(Date.now() - 5 * 60_000);
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', '.lane-lease'), JSON.stringify({ purpose: 'prepare-item', holder: 'worker-uuid', session: 'prepare-123', acquiredAt }));
    holdSlot(lockRoot, 1, `${repo}#123`, 'selected');
    releaseOwnedSlot({ lockRoot, cap: 1, owner: `${repo}#123` });
    expect(readHoldDurations(lockRoot)).toEqual([expect.objectContaining({ repo, dispatchKind: 'prepare', session: 'worker-uuid', leaseAcquiredAt: acquiredAt })]);
    writeFileSync(join(repo, '.git', '.lane-lease'), JSON.stringify({ purpose: 'prepare-item', session: 'prepare-123', acquiredAt }));
    holdSlot(lockRoot, 1, `${repo}#123`, 'standards');
    releaseOwnedSlot({ lockRoot, cap: 1, owner: `${repo}#123` });
    expect(readHoldDurations(lockRoot)[1]).toMatchObject({ session: 'prepare-123', dispatchKind: 'prepare' });
  });
  it('omits optional identity fields for old callers or missing leases', () => {
    const lockRoot = tempRoot();
    recordHoldDuration({ lockRoot, kind: 'selected', ms: 60_000 });
    holdSlot(lockRoot, 1, '/nonexistent/lane-4#123', 'selected');
    releaseOwnedSlot({ lockRoot, cap: 1, owner: '/nonexistent/lane-4#123' });
    for (const row of readHoldDurations(lockRoot)) {
      expect(row).not.toHaveProperty('dispatchKind');
      expect(row).not.toHaveProperty('session');
      expect(row).not.toHaveProperty('leaseAcquiredAt');
    }
  });
  it('counts a fresh prepare lease with the seed, then rolling session demand; exempt removes it', () => {
    const lockRoot = tempRoot();
    const leases = [{ repo: '/p/we/lane-3', lease: { purpose: 'prepare-item', session: 'prepare-123', acquiredAt: iso(T0 - 60_000), ttlMinutes: 240 } }];
    const options = { lockRoot, cap: 2, nowMs: T0, env: {}, readLeases: () => leases };
    const seed = resolveQueueBaseline(options);
    expect(seed.pending).toEqual([expect.objectContaining({ dispatchKind: 'prepare', demandMinutes: 3.25 })]);
    expect(seed).toMatchObject({ prepareAdmission: 'charge', dispatchMinutes: { prepare: null }, dispatchSource: { prepare: { from: 'seed', samples: 0 } } });
    for (const session of ['a', 'b', 'c']) {
      for (const minutes of [3.55, 3.55]) recordHoldDuration({ lockRoot, kind: 'selected', ms: minutes * 60_000, dispatchKind: 'prepare-item', session });
    }
    const rolling = resolveQueueBaseline(options);
    expect(rolling).toMatchObject({ pendingMinutes: 7.1, dispatchMinutes: { prepare: 7.1 }, dispatchSource: { prepare: { from: 'rolling', samples: 3 } } });
    expect(rolling.pending[0].demandMinutes).toBe(7.1);
    const exempt = resolveQueueBaseline({ ...options, env: { WE_QUEUE_ADMISSION_PREPARE: 'exempt' } });
    expect(exempt.prepareAdmission).toBe('exempt');
    expect(exempt.pending).toEqual([]);
  });
});

describe('x1ds37v — a single-test debug run is bounded by a per-run timeout', () => {
  it('a `files` run gets the fast-run timeout; a FULL run gets none; a timeout exits 124', async () => {
    const seen = [];
    const base = { lockRoot: tempRoot(), cap: 2, owner: 'o', log: () => {}, env: { WE_HEAVY_ADMISSION_FAST_RUN_TIMEOUT_MS: '5000' } };
    await runUnderAdmission({ ...base, command: 'vitest run a.test.mjs', exec: (_c, o) => seen.push(o.timeout) });
    await runUnderAdmission({ ...base, command: 'vitest run', exec: (_c, o) => seen.push(o.timeout) });
    expect(seen).toEqual([5000, undefined]);
    const r = await runUnderAdmission({ ...base, command: 'vitest run a.test.mjs', exec: () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT', status: null }); } });
    expect(r.exitCode).toBe(124);
  });
});
