/**
 * The core around the fixer slot rules (we:scripts/conveyor/await-verify-loop.mjs, we:backlog/xn025gx): facts are read
 * correctly, the unchanged verdict pass runs in two phases under R3, and R5 releases only what it should.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  waitRecordForClaim, slotCountedFixClaims, runSlotAwareAwaitPass, runCompletionReleaseSweep, runTickAwaitVerify,
} from '../await-verify-loop.mjs';
import { runAwaitVerifyPass } from '../await-verify-pass.mjs';

const SHA = '65a382e81413952ab11e5448e36f01bb7ce4c332';
const TREE = 'f'.repeat(64);
const T0 = Date.parse('2026-10-08T19:30:00Z');
const NOW = T0 + 5 * 60_000;
const TTL = 150 * 60_000;
const ON = { awaitVerifyLoopSeconds: 15, parkedReleasesSlot: true, parkedCapFactor: 2, releaseOnCompletion: true };
const OFF = { awaitVerifyLoopSeconds: 0, parkedReleasesSlot: false, parkedCapFactor: 2, releaseOnCompletion: false };

const claim = (pr, over = {}) => ({ owner: 'Mac:1', meta: { repo: 'we', pr, kind: 'fix', claimedAt: new Date(T0 - 60_000).toISOString(), ...over } });
const rec = (pr, over = {}) => ({
  v: 1, sessionId: `sid-${pr}`, who: `fix-${pr}`, repo: 'web-everything/web-everything', pr, sha: SHA,
  requestedAt: new Date(T0).toISOString(), attempt: 1, lane: `/lanes/lane-${pr}`, ref: `lane/x-${pr}`, kind: 'fix', ...over,
});

describe('facts', () => {
  it('a wait record binds to its claim by repo, PR, kind and session name', () => {
    const records = [{ key: 'sid-1', record: rec(1) }, { key: 'sid-2', record: rec(2, { kind: 'ci-heal' }) }];
    expect(waitRecordForClaim(claim(1), records)?.pr).toBe(1);
    expect(waitRecordForClaim(claim(2), records)).toBeNull(); // kind differs
    expect(waitRecordForClaim(claim(1, { repo: 'plateau-app' }), records)).toBeNull();
    expect(waitRecordForClaim(claim(9), records)).toBeNull();
    expect(waitRecordForClaim(claim(1, { kind: 'fixing' }), records)).toBeNull(); // not a slot claim
  });
  it('R2 on the throttle list: parked claims drop out, off leaves the list untouched', () => {
    const claims = [claim(1), claim(2), claim(3), claim(4, { kind: 'fixing' })];
    const records = [{ key: 'a', record: rec(1) }, { key: 'b', record: rec(2, { pendingResume: { kind: 'green' } }) }];
    const on = slotCountedFixClaims(claims, { records, settings: ON, cap: 6, nowMs: NOW, ttlMs: TTL });
    expect(on.map((c) => c.meta.pr).sort()).toEqual([2, 3]);
    expect(slotCountedFixClaims(claims, { records, settings: OFF, cap: 6, nowMs: NOW, ttlMs: TTL })).toBe(claims);
  });
});

/** In-memory store + lanes + sessions for the REAL verdict pass. Every session is idle and resumable. */
function harness(records, markers) {
  const store = new Map(records.map((r) => [r.sessionId, r]));
  const calls = { push: [], resume: [] };
  const io = {
    listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set(r.sessionId, r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => ({ head: SHA, dirty: false, treeHash: TREE }),
    readMarker: (lane) => markers[lane] ?? null,
    rerequest: () => ({ ok: true, status: 'requested' }),
    push: (a) => { calls.push.push(a.pr); return { ok: true }; },
    listSessions: () => records.map((r) => ({ sessionId: r.sessionId, name: r.who, status: 'idle', kind: 'background' })),
    resume: ({ session }) => { calls.resume.push(session.sessionId); return { resumed: true }; },
  };
  return { io, store, calls };
}
const green = { sha: SHA, status: 'green', startedAt: new Date(T0).toISOString(), treeHash: TREE, exitCode: 0 };
const running = { ...green, status: 'running', exitCode: null };

describe('runSlotAwareAwaitPass — the real pass, R3-gated', () => {
  it('off: one pass, same as today — every green is pushed and woken', async () => {
    const h = harness([rec(1), rec(2)], { '/lanes/lane-1': green, '/lanes/lane-2': green });
    await runSlotAwareAwaitPass({ io: h.io, runPass: runAwaitVerifyPass, allowResume: true, settings: OFF, claims: [], nowMs: NOW, ttlMs: TTL, cap: 1 });
    expect(h.calls.push).toEqual([1, 2]);
    expect(h.calls.resume).toEqual(['sid-1', 'sid-2']);
  });
  it('on: both greens are pushed at once, but only as many wake as there are free slots; the other stays owed', async () => {
    const h = harness([rec(1), rec(2, { requestedAt: new Date(T0 - 60_000).toISOString() })], { '/lanes/lane-1': green, '/lanes/lane-2': green });
    const claims = [claim(1), claim(2), claim(7)]; // 7 is working; cap 2 leaves one free slot
    const out = await runSlotAwareAwaitPass({ io: h.io, runPass: runAwaitVerifyPass, allowResume: true, settings: ON, claims, nowMs: NOW, ttlMs: TTL, cap: 2 });
    expect(h.calls.push.sort()).toEqual([1, 2]); // the push never waits for a slot
    expect(h.calls.resume).toEqual(['sid-2']); // the older wait wakes first
    expect(h.store.get('sid-1')?.pendingResume?.kind).toBe('green'); // kept on disk for the next cycle
    expect(out.rows.find((r) => r.pr === 2)).toMatchObject({ action: 'push', result: 'pushed; resumed:green' });
    expect(out.rows.find((r) => r.pr === 1).result).toMatch(/^pushed; resume-deferred \(fix slot full/);
    // next cycle, a slot is free (7 finished): the owed resume wakes without a second push
    const again = await runSlotAwareAwaitPass({ io: h.io, runPass: runAwaitVerifyPass, allowResume: true, settings: ON, claims: [claim(1)], nowMs: NOW, ttlMs: TTL, cap: 2 });
    expect(h.calls.push.sort()).toEqual([1, 2]);
    expect(h.calls.resume).toEqual(['sid-2', 'sid-1']);
    expect(again.rows).toEqual([expect.objectContaining({ pr: 1, result: 'resumed:green' })]);
  });
  it('on: a wait still running is left alone (no push, no wake)', async () => {
    const h = harness([rec(1)], { '/lanes/lane-1': running });
    const out = await runSlotAwareAwaitPass({ io: h.io, runPass: runAwaitVerifyPass, allowResume: true, settings: ON, claims: [claim(1)], nowMs: NOW, ttlMs: TTL, cap: 2 });
    expect(h.calls).toEqual({ push: [], resume: [] });
    expect(out.rows).toEqual([expect.objectContaining({ action: 'wait' })]);
  });
});

describe('runCompletionReleaseSweep (R5)', () => {
  const doneAt = new Date(T0 + 60_000).toISOString();
  it('releases a finished session\'s claim, owner- and claimedAt-checked on a fresh read', () => {
    const claims = [claim(1), claim(2), claim(3, { borrowed: { executor: 'codex' } })];
    const completions = { 'fix-1': { status: 'done', updatedAt: doneAt }, 'fix-2': { status: 'started', updatedAt: doneAt }, 'fix-3': { status: 'done', updatedAt: doneAt } };
    const release = vi.fn(() => ({ released: true }));
    const rows = runCompletionReleaseSweep({
      claims, records: [], readCompletion: (s) => completions[s] ?? null, release, readClaim: (m) => claims.find((c) => c.meta.pr === m.pr),
    });
    expect(rows).toEqual([{ repo: 'we', pr: 1, kind: 'fix', session: 'fix-1', doneAt }]);
    expect(release).toHaveBeenCalledWith({ repo: 'we', pr: 1, kind: 'fix', owner: 'Mac:1' });
  });
  it('never releases a claim re-taken meanwhile, or one whose session still awaits verify', () => {
    const release = vi.fn(() => ({ released: true }));
    const readCompletion = () => ({ status: 'done', updatedAt: doneAt });
    runCompletionReleaseSweep({ claims: [claim(1)], records: [], readCompletion, release, readClaim: () => claim(1, { claimedAt: doneAt }) });
    runCompletionReleaseSweep({ claims: [claim(1)], records: [{ key: 'k', record: rec(1) }], readCompletion, release, readClaim: () => claim(1) });
    expect(release).not.toHaveBeenCalled();
  });
});

describe('runTickAwaitVerify (R4 in the tick)', () => {
  it('every setting off → the unchanged legacy pass, nothing else', async () => {
    const legacyPass = vi.fn(async () => ({ rows: ['legacy'] }));
    const cycle = vi.fn();
    expect(await runTickAwaitVerify({ allowResume: true, settings: OFF, legacyPass, cycle })).toEqual({ rows: ['legacy'] });
    expect(legacyPass).toHaveBeenCalledWith({ allowResume: true });
    expect(cycle).not.toHaveBeenCalled();
  });
  it('loop alive → the tick skips; loop dead → the tick runs the cycle itself', async () => {
    const legacyPass = vi.fn();
    const cycle = vi.fn(async () => ({ rows: ['cycle'], released: [] }));
    const fresh = () => ({ pid: 42, at: new Date(NOW - 10_000).toISOString() });
    expect(await runTickAwaitVerify({ allowResume: true, nowMs: NOW, settings: ON, legacyPass, cycle, heartbeat: fresh, alive: () => true }))
      .toMatchObject({ rows: [], runner: 'loop' });
    expect(cycle).not.toHaveBeenCalled();
    expect(await runTickAwaitVerify({ allowResume: false, nowMs: NOW, settings: ON, legacyPass, cycle, heartbeat: fresh, alive: () => false }))
      .toMatchObject({ rows: ['cycle'], runner: 'tick', runnerReason: 'loop-not-alive' });
    expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ allowResume: false }));
    expect(legacyPass).not.toHaveBeenCalled();
  });
});

it('annotatePushLag adds the verify-finished → push lag to pushed rows only', async () => {
  const { annotatePushLag } = await import('../await-verify-loop.mjs');
  const fin = new Map([['a', new Date(NOW - 42_000).toISOString()], ['b', new Date(NOW - 5_000).toISOString()]]);
  const rows = annotatePushLag([{ key: 'a', result: 'pushed; resumed:green' }, { key: 'b', result: 'resumed:red' }, { key: 'c', result: 'pushed' }], fin, NOW);
  expect(rows[0]).toMatchObject({ pushLagMs: 42_000, result: 'pushed; resumed:green — pushed 42s after verify finished' });
  expect(rows[1]).toEqual({ key: 'b', result: 'resumed:red' });
  expect(rows[2]).toEqual({ key: 'c', result: 'pushed' });
});
