/**
 * The core around the fixer slot rules (we:scripts/conveyor/await-verify-loop.mjs, we:backlog/xn025gx): facts are read
 * correctly, the unchanged verdict pass runs in two phases under R3, and R5 releases only what it should.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitRecordForClaim, slotCountedFixClaims, runSlotAwareAwaitPass, runCompletionReleaseSweep, runTickAwaitVerify,
  withCycleLock, cycleLockRoot, CYCLE_LOCK_RESOURCE, nextWokenJournal, defaultSlotCountedFixClaims, cycleFailed,
  superviseAwaitVerifyLoop, runAwaitVerifyCycleDefault,
} from '../await-verify-loop.mjs';
import { reserve, readLockEntry } from '../../readiness/file-locks.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim, readFixDispatchClaim, listFixDispatchClaims } from '../fix-dispatch-claim.mjs';
import { resolveFixerSlotSettings } from '../fixer-slot-rules.mjs';
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

describe('glue against the real lock store and settings file', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'avl-'));
  it('withCycleLock: a second cycle is refused while one runs; a dead holder is reclaimed; the lock is released after', async () => {
    const env = { ...process.env, WE_COORDINATION_ROOT: tmp() };
    let inner = 'unset';
    const outer = await withCycleLock(async () => { inner = await withCycleLock(async () => 'second', { env, pid: 999_999_1 }); return 'first'; }, { env });
    expect(outer).toBe('first');
    expect(inner).toBeNull(); // held by a live pid (this process)
    // a holder whose pid is gone: reclaimed at once
    reserve(cycleLockRoot(env), CYCLE_LOCK_RESOURCE, 'Mac:2147483', Date.now(), new Date().toISOString(), 2147483, 'unknown', 20);
    expect(await withCycleLock(async () => 'reclaimed', { env })).toBe('reclaimed');
    expect(readLockEntry(cycleLockRoot(env), CYCLE_LOCK_RESOURCE)).toBeNull();
    // a LIVE holder (e.g. a reused pid) whose lease ran out is reclaimed too — never stuck until cleared by hand
    const old = Date.now() - 25 * 60_000;
    reserve(cycleLockRoot(env), CYCLE_LOCK_RESOURCE, 'Mac:live', old, new Date(old).toISOString(), process.pid, 'unknown', 20);
    expect(await withCycleLock(async () => 'lease-expired', { env, pid: 999_999_2 })).toBe('lease-expired');
  });
  it('R5 against real claims: releases a done session\'s claim and keeps a re-taken one', () => {
    const lockRoot = tmp();
    const claimedAt = new Date(Date.now() - 60_000).toISOString();
    acquireFixDispatchClaim({ repo: 'we', pr: 11, kind: 'fix', owner: 'Mac:1', lockRoot, nowIso: claimedAt, nowMs: Date.parse(claimedAt) });
    acquireFixDispatchClaim({ repo: 'we', pr: 12, kind: 'fix', owner: 'Mac:1', lockRoot, nowIso: claimedAt, nowMs: Date.parse(claimedAt) });
    const claims = listFixDispatchClaims(lockRoot);
    const done = { status: 'done', updatedAt: new Date().toISOString() };
    const rows = runCompletionReleaseSweep({
      claims, records: [], readCompletion: () => done,
      release: (a) => releaseFixDispatchClaim({ ...a, lockRoot }),
      readClaim: (m) => (m.pr === 12 ? { ...readFixDispatchClaim({ ...m, lockRoot }), owner: 'Mac:2' } : readFixDispatchClaim({ ...m, lockRoot })),
    });
    expect(rows.map((r) => r.pr)).toEqual([11]);
    expect(readFixDispatchClaim({ repo: 'we', pr: 11, kind: 'fix', lockRoot })).toBeNull();
    expect(readFixDispatchClaim({ repo: 'we', pr: 12, kind: 'fix', lockRoot })).not.toBeNull();
  });
  it('R5: a done written before the session was woken again does not release', () => {
    const release = vi.fn(() => ({ released: true }));
    const woken = { 'fix-1': new Date(T0 + 120_000).toISOString() };
    runCompletionReleaseSweep({ claims: [claim(1)], records: [], readCompletion: () => ({ status: 'done', updatedAt: new Date(T0 + 60_000).toISOString() }), release, readClaim: () => claim(1), woken });
    expect(release).not.toHaveBeenCalled();
  });
  it('nextWokenJournal: before the pass every parked session is stamped with its wait time; after it every woken one with the wake time', () => {
    const recs = new Map([['sid-1', rec(1)], ['sid-2', rec(2)]]);
    const prev = { 'fix-9': new Date(NOW - 25 * 3_600_000).toISOString(), 'fix-8': new Date(NOW - 60_000).toISOString() };
    const pre = nextWokenJournal(prev, { recordsByKey: recs, nowMs: NOW });
    expect(pre).toEqual({ 'fix-8': prev['fix-8'], 'fix-1': rec(1).requestedAt, 'fix-2': rec(2).requestedAt });
    const post = nextWokenJournal(pre, { rows: [{ key: 'sid-1', result: 'pushed; resumed:green' }, { key: 'sid-2', result: 'pushed; resume-deferred (fix slot full)' }], recordsByKey: recs, nowMs: NOW });
    expect(post['fix-1']).toBe(new Date(NOW).toISOString());
    expect(post['fix-2']).toBe(rec(2).requestedAt);
  });
  it('R2 reader fails open to the raw claim list when the await store cannot be read', () => {
    const raw = [claim(1), claim(2)];
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'on' }, listClaims: () => raw, readRecords: () => { throw new Error('EIO'); } })).toBe(raw);
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'off' }, listClaims: () => raw, readRecords: () => [{ key: 'a', record: rec(1) }] })).toBe(raw);
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'on' }, listClaims: () => raw, readRecords: () => [{ key: 'a', record: rec(1, { requestedAt: new Date().toISOString() }) }] }).map((c) => c.meta.pr)).toEqual([2]);
  });
  it('a cycle that threw or could not get the lock is not a heartbeat; an acting cycle is', () => {
    expect(cycleFailed({ rows: [{ action: 'error', result: 'error: boom' }] })).toBe(true);
    expect(cycleFailed({ rows: [], busy: true })).toBe(true);
    expect(cycleFailed({ rows: [], released: [] })).toBe(false);
    expect(cycleFailed({ rows: [{ key: 'k', action: 'error', result: 'error: one record' }] })).toBe(true); // every acted record errored
    expect(cycleFailed({ rows: [{ key: 'k', action: 'error', result: 'error: one' }, { key: 'j', action: 'push', result: 'pushed' }] })).toBe(false);
    expect(cycleFailed({ rows: [{ key: 'k', action: 'wait' }] })).toBe(false);
  });
  it('the shipped settings file turns the operator-ruled features on (P1/P2)', () => {
    expect(resolveFixerSlotSettings({ env: {} })).toEqual({ awaitVerifyLoopSeconds: 15, parkedReleasesSlot: true, parkedCapFactor: 2, releaseOnCompletion: true });
  });
});

describe('the loop process', () => {
  it('spawnAwaitVerifyLoop: setting off → nothing; on → this file as a child with the parent pid', async () => {
    const { spawnAwaitVerifyLoop } = await import('../await-verify-loop.mjs');
    const spawnFn = vi.fn(() => ({ on: () => {} }));
    expect(spawnAwaitVerifyLoop({ settings: OFF, spawnFn })).toBeNull();
    spawnAwaitVerifyLoop({ settings: ON, spawnFn, parentPid: 4242 });
    expect(spawnFn).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/await-verify-loop\.mjs$/), '--parent-pid=4242'], expect.any(Object));
  });
  it('exits 0 on its own when the parent is gone or the setting is off — no cycle runs', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'await-verify-loop.mjs');
    const env = { ...process.env, WE_COORDINATION_ROOT: mkdtempSync(join(tmpdir(), 'avl-main-')) };
    const gone = spawnSync(process.execPath, [script, '--parent-pid=2147483'], { env, encoding: 'utf8', timeout: 30_000 });
    expect(gone.status).toBe(0);
    expect(gone.stderr).toMatch(/await-verify-loop: parent gone — exiting/);
    const off = spawnSync(process.execPath, [script, `--parent-pid=${process.pid}`], { env: { ...env, WE_AWAIT_VERIFY_LOOP_SECONDS: '0' }, encoding: 'utf8', timeout: 30_000 });
    expect(off.status).toBe(0);
    expect(off.stderr).toMatch(/setting off — exiting/);
    expect(off.stderr).not.toMatch(/await-verify:/);
  });
});

describe('superviseAwaitVerifyLoop (the daemon\'s child lifecycle)', () => {
  const fakeChild = () => { const h = {}; return { h, on: (ev, fn) => { h[ev] = fn; }, kill: vi.fn() }; };
  it('restarts a crashed loop no sooner than once a minute, never one that exited 0, and stops it on request', () => {
    const children = [];
    const timers = [];
    let t = 1_000_000;
    const log = { error: vi.fn() };
    const sup = superviseAwaitVerifyLoop({ spawnLoop: () => { const c = fakeChild(); children.push(c); return c; }, log, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return null; } });
    sup.start();
    t += 10_000;
    children[0].h.exit(1); // crashed after 10 s
    expect(timers).toEqual([{ fn: expect.any(Function), ms: 50_000 }]);
    timers[0].fn();
    expect(children).toHaveLength(2);
    children[1].h.exit(0); // stopped on purpose (setting off)
    expect(timers).toHaveLength(1);
    children[1].h.error(new Error('EAGAIN')); // an async spawn error is logged, never thrown
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/await-verify loop error: EAGAIN/));
    sup.start();
    sup.stop();
    expect(children[2].kill).toHaveBeenCalledWith('SIGTERM');
    children[2].h.exit(null); // killed by us: no restart
    expect(timers).toHaveLength(1);
  });
  it('a spawn that throws is logged and leaves no child', () => {
    const log = { error: vi.fn() };
    const sup = superviseAwaitVerifyLoop({ spawnLoop: () => { throw new Error('EMFILE'); }, log });
    expect(sup.start()).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/spawn failed: EMFILE/));
  });
});

describe('runAwaitVerifyCycleDefault against real stores (R5 fail-closed on the wake journal)', () => {
  const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), 'avl-cycle-'));
    const env = { ...process.env, WE_COORDINATION_ROOT: root, WE_AWAIT_VERIFY_STORE: join(root, 'aw'), OPERATION_COMPLETIONS_DIR: join(root, 'comp') };
    const saved = {};
    for (const k of ['WE_COORDINATION_ROOT', 'WE_AWAIT_VERIFY_STORE', 'OPERATION_COMPLETIONS_DIR']) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    const claimedAt = new Date(Date.now() - 60_000).toISOString();
    acquireFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix', owner: 'Mac:1', nowIso: claimedAt, nowMs: Date.parse(claimedAt) });
    const { writeCompletion } = await import('../../operations/completion-store.mjs');
    const { newCompletionRecord, applyCompletionUpdate } = await import('../../operations/completion-record.mjs');
    writeCompletion(applyCompletionUpdate(newCompletionRecord({ session: 'fix-21', kind: 'fix', pr: 21 }), { status: 'done' }));
    const passModule = { defaultAwaitVerifyIo: async () => ({ listRecords: () => [], readMarker: () => null }), runAwaitVerifyPass: async () => ({ rows: [] }) };
    return { root, env, restore, passModule };
  };
  it('a corrupt wake journal skips the release; a readable one releases the done session\'s claim', async () => {
    const { root, env, restore, passModule } = await setup();
    try {
      writeFileSync(join(root, 'await-verify-woken.json'), '{not json');
      const kept = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule });
      expect(kept.released).toEqual([]);
      expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).not.toBeNull();
      writeFileSync(join(root, 'await-verify-woken.json'), '{}');
      const out = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule });
      expect(out.released.map((r) => r.pr)).toEqual([21]);
      expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).toBeNull();
    } finally { restore(); }
  });
  it('the loop path (no allowResume given): an auth gate that throws defers wake-ups', async () => {
    const { env, restore } = await setup();
    try {
      const { writeStoredAwaitVerify } = await import('../await-verify.mjs');
      writeStoredAwaitVerify(rec(21));
      const runAwaitVerifyPass = vi.fn(async () => ({ rows: [] }));
      const passModule = { defaultAwaitVerifyIo: async () => ({ listRecords: () => [], readMarker: () => null }), runAwaitVerifyPass };
      await runAwaitVerifyCycleDefault({ env, settings: ON, passModule, authGate: () => { throw new Error('probe failed'); } });
      expect(runAwaitVerifyPass).toHaveBeenCalledWith(expect.objectContaining({ allowResume: false }));
      runAwaitVerifyPass.mockClear();
      await runAwaitVerifyCycleDefault({ env, settings: ON, passModule, authGate: () => ({ paused: false }) });
      expect(runAwaitVerifyPass).toHaveBeenCalledWith(expect.objectContaining({ allowResume: false })); // phase A
      expect(runAwaitVerifyPass.mock.calls.every(([a]) => a.allowResume === false)).toBe(true); // nothing owed → no phase B
    } finally { restore(); }
  });
  it('setting off: the cycle never releases', async () => {
    const { env, restore, passModule } = await setup();
    try {
      const out = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: { ...ON, releaseOnCompletion: false }, passModule });
      expect(out.released).toEqual([]);
      expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).not.toBeNull();
    } finally { restore(); }
  });
});
