/**
 * The core around the fixer slot rules (we:scripts/conveyor/await-verify-loop.mjs, we:backlog/xn025gx): facts are read
 * correctly, the unchanged verdict pass runs in two phases under R3, and R5 releases only what it should.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitRecordForClaim, slotCountedFixClaims, runSlotAwareAwaitPass, runCompletionReleaseSweep, runTickAwaitVerify,
  withCycleLock, cycleLockRoot, CYCLE_LOCK_RESOURCE, nextWokenJournal, defaultSlotCountedFixClaims, cycleFailed,
  superviseAwaitVerifyLoop, runAwaitVerifyCycleDefault, sessionSpeaksFor, runLoopCycle, runLoopIteration, LOOP_APP_AUTH_OPTS, readJournal,
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
  it('every setting off → the unchanged legacy pass, nothing else (except dropping a wake journal the unstamped wakes would make stale)', async () => {
    const legacyPass = vi.fn(async () => ({ rows: ['legacy'] }));
    const cycle = vi.fn();
    const root = mkdtempSync(join(tmpdir(), 'avl-off-'));
    const env = { ...process.env, WE_COORDINATION_ROOT: root };
    writeFileSync(join(root, 'await-verify-woken.json'), '{"fix-1":"2026-10-08T00:00:00Z"}');
    expect(await runTickAwaitVerify({ allowResume: true, settings: OFF, legacyPass, cycle, env })).toEqual({ rows: ['legacy'] });
    expect(legacyPass).toHaveBeenCalledWith({ allowResume: true });
    expect(cycle).not.toHaveBeenCalled();
    expect(readJournal(join(root, 'await-verify-woken.json')).state).toBe('missing');
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
  it('nextWokenJournal: before the pass every session with a wait is stamped with the cycle start (never its older requestedAt); old entries drop', () => {
    const recs = new Map([['sid-1', rec(1)], ['sid-2', rec(2)]]);
    const prev = { 'fix-9': new Date(NOW - 25 * 3_600_000).toISOString(), 'fix-8': new Date(NOW - 60_000).toISOString() };
    const pre = nextWokenJournal(prev, { recordsByKey: recs, nowMs: NOW });
    expect(pre).toEqual({ 'fix-8': prev['fix-8'], 'fix-1': new Date(NOW).toISOString(), 'fix-2': new Date(NOW).toISOString() });
    expect(Date.parse(pre['fix-1'])).toBeGreaterThan(Date.parse(rec(1).requestedAt));
  });
  it('R5: the journal floor holds back a done written before it, for a session with no stamp of its own', () => {
    const release = vi.fn(() => ({ released: true }));
    const done = (iso) => ({ status: 'done', updatedAt: iso });
    const floor = { __floor: new Date(T0 + 120_000).toISOString() };
    runCompletionReleaseSweep({ claims: [claim(1)], records: [], readCompletion: () => done(new Date(T0 + 60_000).toISOString()), release, readClaim: () => claim(1), woken: floor });
    expect(release).not.toHaveBeenCalled();
    runCompletionReleaseSweep({ claims: [claim(1)], records: [], readCompletion: () => done(new Date(T0 + 180_000).toISOString()), release, readClaim: () => claim(1), woken: floor });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('readJournal tells a missing, corrupt and unreadable journal apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avl-journal-'));
    expect(readJournal(join(dir, 'none.json'))).toEqual({ state: 'missing', value: null });
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readJournal(join(dir, 'bad.json')).state).toBe('corrupt');
    writeFileSync(join(dir, 'arr.json'), '[1]');
    expect(readJournal(join(dir, 'arr.json')).state).toBe('corrupt');
    writeFileSync(join(dir, 'ok.json'), '{"fix-1":"2026-10-08T00:00:00Z"}');
    expect(readJournal(join(dir, 'ok.json'))).toEqual({ state: 'ok', value: { 'fix-1': '2026-10-08T00:00:00Z' } });
    expect(readJournal(dir).state).toBe('unreadable'); // a directory: the read itself fails, the file is not ours to replace
  });
  it('R2 reader fails open to the raw claim list when the await store cannot be read', () => {
    const raw = [claim(1), claim(2)];
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'on' }, listClaims: () => raw, readRecords: () => { throw new Error('EIO'); } })).toBe(raw);
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'off' }, listClaims: () => raw, readRecords: () => [{ key: 'a', record: rec(1) }] })).toBe(raw);
    expect(defaultSlotCountedFixClaims({ env: { WE_FIX_PARKED_RELEASES_SLOT: 'on' }, listClaims: () => raw, readRecords: () => [{ key: 'a', record: rec(1, { requestedAt: new Date(Date.now() - 60_000).toISOString() }) }] }).map((c) => c.meta.pr)).toEqual([2]);
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
  it('a spawn that throws is logged, leaves no child, and is retried no sooner than once a minute until it works or the daemon stops it', () => {
    const log = { error: vi.fn() };
    const timers = [];
    let n = 0;
    const child = fakeChild();
    const sup = superviseAwaitVerifyLoop({
      spawnLoop: () => { n += 1; if (n < 3) throw new Error('EMFILE'); return child; },
      log, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, now: () => 0, minGapMs: 60_000,
    });
    expect(sup.start()).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/spawn failed: EMFILE/));
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    timers[0].fn(); // second attempt throws again → another retry is armed
    expect(timers.map((t) => t.ms)).toEqual([60_000, 60_000]);
    timers[1].fn(); // third attempt works
    expect(sup.current()).toBe(child);
    expect(timers).toHaveLength(2);
    sup.stop();
  });
  it('a retry that fires after stop() starts nothing', () => {
    const timers = [];
    const spawnLoop = vi.fn(() => { throw new Error('EAGAIN'); });
    const sup = superviseAwaitVerifyLoop({ spawnLoop, log: { error: vi.fn() }, setTimer: (fn) => { timers.push(fn); return { unref() {} }; } });
    sup.start();
    sup.stop();
    timers[0]();
    expect(spawnLoop).toHaveBeenCalledTimes(1);
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
  it('an unreadable wake journal skips the release sweep outright (the journalOk gate): a fresh done with no wait record still holds the claim', async () => {
    const { root, env, restore, passModule } = await setup();
    try {
      mkdirSync(join(root, 'await-verify-woken.json')); // a directory where the file should be: the read itself fails
      const out = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule });
      expect(out.released).toEqual([]);
      expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).not.toBeNull();
      expect(readJournal(join(root, 'await-verify-woken.json')).state).toBe('unreadable');
    } finally { restore(); }
  });
  it('a corrupt wake journal is replaced with a floor (that cycle releases nothing); a readable one releases the done session\'s claim', async () => {
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
      const { writeStoredAwaitVerify, listStoredAwaitVerify } = await import('../await-verify.mjs');
      // a wake IS owed (a decided verdict is on the record), so phase B would run if the gate let it
      writeStoredAwaitVerify(rec(21, { requestedAt: new Date(Date.now() - 60_000).toISOString(), pendingResume: { kind: 'red', detail: 'x' } }));
      const runAwaitVerifyPass = vi.fn(async () => ({ rows: [] }));
      const passModule = { defaultAwaitVerifyIo: async () => ({ listRecords: () => listStoredAwaitVerify(), readMarker: () => null }), runAwaitVerifyPass };
      await runAwaitVerifyCycleDefault({ env, settings: ON, passModule, authGate: () => { throw new Error('probe failed'); } });
      expect(runAwaitVerifyPass.mock.calls.length).toBeGreaterThan(0);
      expect(runAwaitVerifyPass.mock.calls.every(([a]) => a.allowResume === false)).toBe(true); // the gate could not answer → no wake
      runAwaitVerifyPass.mockClear();
      await runAwaitVerifyCycleDefault({ env, settings: ON, passModule, authGate: () => ({ paused: false }) });
      expect(runAwaitVerifyPass.mock.calls.map(([a]) => a.allowResume)).toEqual([false, true]); // phase A pushes, phase B wakes
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

  // PR #4510 review (codex-correctness, CONFIRMED): a fixer parks, writes `done`, is woken to repair a red verdict, and the
  // process dies before the post-pass journal write. The journal then holds only the wait's `requestedAt`, which is older
  // than that `done`, so the next cycle used to release the claim of a session that is working again.
  describe('wake intent is on disk before the wake (crash window)', () => {
    const parked = async (extra = {}) => {
      const ctx = await setup(); // setup() wrote the `done` just now; the wait below was requested before it
      const store = await import('../await-verify.mjs');
      store.writeStoredAwaitVerify(rec(21, { requestedAt: new Date(Date.now() - 120_000).toISOString(), ...extra }));
      await new Promise((r) => { setTimeout(r, 15); });
      const resume = vi.fn(() => ({ resumed: true }));
      const io = { listRecords: () => store.listStoredAwaitVerify(), readMarker: () => null, listSessions: () => [{ sessionId: 'sid-21', name: 'fix-21' }], resume };
      return { ...ctx, store, io, resume };
    };
    it('a crash after the wake and the wait clear, before the post-pass journal write, keeps the claim held', async () => {
      const { env, restore, store, io, resume } = await parked();
      try {
        const [{ key }] = store.listStoredAwaitVerify();
        const crashing = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async ({ io: i }) => {
          i.resume({ session: { sessionId: 'sid-21' }, prompt: 'repair' });
          store.clearStoredAwaitVerify(key);
          throw new Error('process died before the journal write');
        } };
        const first = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: { ...ON, parkedReleasesSlot: false }, passModule: crashing });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(first.released).toEqual([]);
        const quiet = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async () => ({ rows: [] }) };
        const second = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule: quiet });
        expect(second.released).toEqual([]);
        expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).not.toBeNull();
      } finally { restore(); }
    });
    it('the two-phase pass (parked-releases-slot on) is covered the same way', async () => {
      const { env, restore, store, io, resume } = await parked({ pendingResume: { kind: 'red', detail: 'x' } });
      try {
        const [{ key }] = store.listStoredAwaitVerify();
        let calls = 0;
        const crashing = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async ({ io: i, allowResume }) => {
          calls += 1;
          if (!allowResume) return { rows: [{ key, action: 'resume', result: 'resume-paused' }] };
          i.resume({ session: { sessionId: 'sid-21' }, prompt: 'repair' });
          store.clearStoredAwaitVerify(key);
          throw new Error('process died before the journal write');
        } };
        await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule: crashing });
        expect(calls).toBe(2);
        expect(resume).toHaveBeenCalledTimes(1);
        const quiet = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async () => ({ rows: [] }) };
        expect((await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule: quiet })).released).toEqual([]);
      } finally { restore(); }
    });
    it('a journal stamp that cannot be written turns the cycle\'s wakes OFF before the pass (the pass counts a refused wake as a failure), and never wakes', async () => {
      const { root, env, restore, store, io, resume } = await parked();
      try {
        mkdirSync(join(root, `await-verify-woken.json.${process.pid}.tmp`)); // the journal's temp file path is now a directory
        const allow = [];
        let seen = null;
        const pass = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async ({ io: i, allowResume }) => {
          allow.push(allowResume);
          seen = i.resume({ session: { sessionId: 'sid-21' }, prompt: 'repair' }); // even a pass that ignores allowResume cannot wake
          return { rows: [] };
        } };
        await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: { ...ON, parkedReleasesSlot: false }, passModule: pass });
        expect(allow).toEqual([false]);
        expect(resume).not.toHaveBeenCalled();
        expect(seen).toMatchObject({ resumed: false });
        expect(store.listStoredAwaitVerify()).toHaveLength(1); // the wait is still owed
      } finally { restore(); }
    });
    it('a done the woken session writes AFTER the wake, while the pass is still waking others, still releases next cycle (no post-pass stamp)', async () => {
      const { env, restore, store, io } = await parked();
      try {
        const [{ key }] = store.listStoredAwaitVerify();
        const { writeCompletion } = await import('../../operations/completion-store.mjs');
        const { newCompletionRecord, applyCompletionUpdate } = await import('../../operations/completion-record.mjs');
        const pass = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async ({ io: i }) => {
          i.resume({ session: { sessionId: 'sid-21' }, prompt: 'repair' });
          store.clearStoredAwaitVerify(key);
          await new Promise((r) => { setTimeout(r, 15); });
          writeCompletion(applyCompletionUpdate(newCompletionRecord({ session: 'fix-21', kind: 'fix', pr: 21 }), { status: 'done' })); // the repair finished
          await new Promise((r) => { setTimeout(r, 15); }); // ...and the pass is still busy with other records
          return { rows: [{ key, action: 'resume', result: 'resumed:red' }] };
        } };
        // the same cycle's sweep runs after the pass: the finished repair's done is newer than the wake stamp, so it releases
        const out = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: { ...ON, parkedReleasesSlot: false }, passModule: pass });
        expect(out.released.map((r) => r.pr)).toEqual([21]);
        expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).toBeNull();
      } finally { restore(); }
    });
    it('a lost journal (missing or corrupt) restarts with a floor: a done from before the loss is held, a later one releases; an unreadable one is left alone and blocks wakes', async () => {
      const { root, env, restore, store, io, resume } = await parked();
      try {
        const quiet = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async () => ({ rows: [] }) };
        const path = join(root, 'await-verify-woken.json');
        store.clearStoredAwaitVerify(store.listStoredAwaitVerify()[0].key);
        for (const lost of [() => rmSync(path, { force: true }), () => writeFileSync(path, '{not json')]) {
          lost();
          const out = await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule: quiet });
          expect(out.released).toEqual([]);
          expect(readJournal(path).value.__floor).toBeTruthy();
          expect(readFixDispatchClaim({ repo: 'we', pr: 21, kind: 'fix' })).not.toBeNull();
        }
        await new Promise((r) => { setTimeout(r, 15); });
        const { writeCompletion } = await import('../../operations/completion-store.mjs');
        const { newCompletionRecord, applyCompletionUpdate } = await import('../../operations/completion-record.mjs');
        writeCompletion(applyCompletionUpdate(newCompletionRecord({ session: 'fix-21', kind: 'fix', pr: 21 }), { status: 'done' }));
        expect((await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: ON, passModule: quiet })).released.map((r) => r.pr)).toEqual([21]);
        // unreadable: a directory where the file should be
        rmSync(path, { force: true });
        mkdirSync(path);
        store.writeStoredAwaitVerify(rec(21, { requestedAt: new Date(Date.now() - 1000).toISOString() }));
        const allow = [];
        const pass = { defaultAwaitVerifyIo: async () => io, runAwaitVerifyPass: async ({ allowResume }) => { allow.push(allowResume); return { rows: [] }; } };
        await runAwaitVerifyCycleDefault({ allowResume: true, env, settings: { ...ON, parkedReleasesSlot: false }, passModule: pass });
        expect(allow).toEqual([false]);
        expect(resume).not.toHaveBeenCalled();
        expect(readJournal(path).state).toBe('unreadable'); // still the directory: never replaced
      } finally { restore(); }
    });
    it('sessionSpeaksFor: a record naming a session id binds to that session only; otherwise to its name', () => {
      expect(sessionSpeaksFor(rec(1), { sessionId: 'sid-1' })).toBe(true);
      expect(sessionSpeaksFor(rec(1), { sessionId: 'sid-2', name: 'fix-1' })).toBe(false);
      expect(sessionSpeaksFor(rec(1, { sessionId: undefined }), { sessionId: 'x', name: 'fix-1' })).toBe(true);
      expect(sessionSpeaksFor(rec(1, { sessionId: undefined }), { sessionId: 'x', name: 'fix-2' })).toBe(false);
    });
  });
});

// PR #4510 review (security, PLAUSIBLE→broken): the loop child is spawned once with a frozen env and never refreshed
// the GitHub App token, so its pushes ran on personal auth, or on an inherited token that lapsed after an hour.
describe('the loop refreshes its GitHub App auth before every cycle', () => {
  it('runLoopCycle: ensureAuth runs first on every cycle and its token is what the cycle sees; a failing refresh never stops the cycle', async () => {
    const saved = process.env.GH_TOKEN;
    try {
      let n = 0;
      const ensureAuth = vi.fn(async () => { n += 1; process.env.GH_TOKEN = `fresh-${n}`; });
      const seen = [];
      const cycle = vi.fn(async () => { seen.push(process.env.GH_TOKEN); return { rows: [] }; });
      await runLoopCycle({ settings: ON, ensureAuth, cycle });
      await runLoopCycle({ settings: ON, ensureAuth, cycle });
      expect(seen).toEqual(['fresh-1', 'fresh-2']);
      expect(cycle).toHaveBeenCalledWith({ settings: ON });
      const out = await runLoopCycle({ settings: ON, ensureAuth: async () => { throw new Error('mint down'); }, cycle });
      expect(out).toEqual({ rows: [] });
      expect(cycle).toHaveBeenCalledTimes(3);
    } finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
  });
  describe('runLoopIteration (one pass of the child\'s forever-loop, every effect injected)', () => {
    const base = (over = {}) => {
      const log = [];
      const order = [];
      return { log, order, args: {
        parentPid: 4242, lastDeferred: '', formatLines: (r) => r.lines ?? [], write: (l) => log.push(l),
        resolveSettings: () => ON, parentAlive: () => true,
        ensureAuth: async () => { order.push('auth'); },
        cycle: async () => { order.push('cycle'); return { rows: [] }; },
        writeHeartbeat: (hb) => order.push(`heartbeat:${hb.parentPid}:${hb.seconds}`),
        ...over,
      } };
    };
    it('refreshes the auth BEFORE the cycle and writes the heartbeat after a healthy one', async () => {
      const { order, args } = base();
      const out = await runLoopIteration(args);
      expect(order).toEqual(['auth', 'cycle', 'heartbeat:4242:15']);
      expect(out).toMatchObject({ exit: null, seconds: 15 });
    });
    it('an unhealthy cycle (lock busy, or every push transient) writes no heartbeat, so the tick takes over', async () => {
      const busy = base({ cycle: async () => ({ rows: [], busy: true }) });
      await runLoopIteration(busy.args);
      expect(busy.order).toEqual(['auth']);
      const stalled = base({ cycle: async () => ({ rows: [{ key: 'a', action: 'push', result: 'push-retry (could not resolve the head ref)' }] }) });
      await runLoopIteration(stalled.args);
      expect(stalled.order).toEqual(['auth']);
    });
    it('exits without running anything when the setting is off or the parent is gone', async () => {
      const off = base({ resolveSettings: () => OFF });
      expect(await runLoopIteration(off.args)).toMatchObject({ exit: 'setting-off' });
      expect(off.order).toEqual([]);
      const orphan = base({ parentAlive: () => false });
      expect(await runLoopIteration(orphan.args)).toMatchObject({ exit: 'parent-gone' });
      expect(orphan.order).toEqual([]);
      expect(orphan.log).toEqual([expect.stringMatching(/parent gone — exiting/)]);
    });
    it('logs each pass line once, and repeats a deferred line only when it changes', async () => {
      const { log, args } = base({ cycle: async () => ({ rows: [], lines: ['a pushed', 'b resume-deferred (fix slot full)'], released: [] }) });
      const first = await runLoopIteration(args);
      expect(log).toHaveLength(2);
      log.length = 0;
      await runLoopIteration({ ...args, lastDeferred: first.lastDeferred });
      expect(log).toEqual([expect.stringMatching(/^a pushed \[loop \d+ms\]$/)]);
    });
  });
  it('the default refresh is the fleet one (per-owner tokens), never a single pinned org', async () => {
    const { FLEET_APP_AUTH_OPTS } = await import('../../lib/github-app-auth-env.mjs');
    expect(LOOP_APP_AUTH_OPTS).toBe(FLEET_APP_AUTH_OPTS);
  });
  it('a cycle whose acted rows are all transient push failures is not a heartbeat (the tick, which holds a fresh token, takes over)', () => {
    const retry = { key: 'a', action: 'push', result: 'push-retry (could not resolve the head ref of web-everything/web-everything PR #1)' };
    const gone = { key: 'b', action: 'push', result: 'push-transient; salvaged' };
    expect(cycleFailed({ rows: [retry] })).toBe(true);
    expect(cycleFailed({ rows: [retry, gone] })).toBe(true);
    expect(cycleFailed({ rows: [retry, { key: 'c', action: 'push', result: 'pushed; resumed:green' }] })).toBe(false);
    expect(cycleFailed({ rows: [retry, { key: 'd', action: 'wait' }] })).toBe(true); // waiting rows are not acting
  });
});
