import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openProbation, readProbation, readProvenGood, writeProvenGood, requestRollback,
  applyPendingRollback, bootProbation, checkProbationAtTick, withProbationLock, probationMsOf,
} from '../probation.mjs';
import { finalizeRebuild } from '../adopt.mjs';
import { alertsFilePath, rebuildStatePath, readRebuildState, writeRebuildState } from '../state.mjs';
import { cloneKeyOf } from '../../daemon-last-good.mjs';
import { acquireRead, inspectCloneLock, releaseRead, withWriteLock } from '../../daemon-clone-lock.mjs';
import { acquireLockDir, lockDirFor, makeLockEntry } from '../../../readiness/file-locks.mjs';

vi.mock('../adopt.mjs', () => ({ finalizeRebuild: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('../../daemon-clone-lock.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withWriteLock: vi.fn(actual.withWriteLock) };
});
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const AT = Date.parse('2026-11-16T12:00:00Z');
const dirs = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'probation-s2a-')); dirs.push(root);
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
    WE_DAEMON_PROBATION_MS: '1000', WE_DAEMON_EVENTS: join(root, 'events.jsonl') };
  let head = B, at = AT + 10;
  const run = vi.fn(args => {
    if (args[0] !== 'rev-parse') throw new Error('Unexpected Git mutation');
    return { status: 0, stdout: head };
  });
  const opts = { root, env, run, now: () => at, bootSha: B, bootAt: AT + 1, emit: vi.fn(), log: { error: vi.fn() }, lockWaitMs: 0 };
  const file = kind => join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(root)}.${kind}.json`);
  const good = { head: A, inputsKey: 'good', mainSha: A, applied: [], provenAt: new Date(AT - 1000).toISOString() };
  expect(writeProvenGood(root, env, good)).toBe(true);
  writeRebuildState(root, { adopted: { head: B, inputsKey: 'bad' } }, env);
  const open = (sha = B, extra = {}) => openProbation({ ...opts, sha, inputsKey: sha === B ? 'bad' : 'new',
    mainSha: A, prevHead: A, applied: [], now: () => AT, ...extra });
  expect(open()).toBe(true);
  const json = (kind, rec) => writeFileSync(file(kind), JSON.stringify(rec));
  const snapshot = () => Object.fromEntries(readdirSync(env.WE_DAEMON_STATE_DIR)
    .filter(name => name.endsWith('.json')).map(name => [name, readFileSync(join(env.WE_DAEMON_STATE_DIR, name), 'utf8')]));
  const tick = (extra = {}) => json('ticks.worker', { pid: process.pid, head: B, lastTickDoneAt: new Date(AT + 2).toISOString(), ...extra });
  finalizeRebuild.mockImplementation(async ({ plan }) => {
    expect(readRebuildState(root, env).rejected.inputsKey).toBe('bad');
    head = plan.finalSha;
    writeRebuildState(root, { ...readRebuildState(root, env), adopted: { head, inputsKey: plan.inputsKey } }, env);
    return { adopted: true };
  });
  return { root, env, opts, run, file, open, json, snapshot, tick, good,
    get head() { return head; }, set head(value) { head = value; }, set at(value) { at = value; } };
}

describe('S2a adoption identity and serialization', () => {
  it('open stamps a UUID and boot registration and marker carry that same adoptionId', async () => {
    const f = fixture(), id = readProbation(f.root, f.env).adoptionId;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    await bootProbation(f.opts);
    expect(readProbation(f.root, f.env)).toMatchObject({ adoptionId: id, bootAdoptionId: id, boots: 1 });
    expect(requestRollback({ ...f.opts, expectId: id })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(f.file('rollback-requested'))).adoptionId).toBe(id);
    expect(readProbation(f.root, f.env)).toBeNull();
  });

  it('stale rollback request cannot delete a newer adoption\'s probation', () => {
    const f = fixture(), id = readProbation(f.root, f.env).adoptionId;
    f.head = C; expect(f.open(C)).toBe(true);
    const before = f.snapshot();
    expect(requestRollback({ ...f.opts, expectId: id, expectSha: B }).superseded).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });

  it('late openProbation for B after C\'s finalize is a no-op', () => {
    const f = fixture(); f.head = C; expect(f.open(C)).toBe(true);
    const before = f.snapshot();
    expect(f.open(B)).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['open', 'request', 'tick-pass', 'tick-fail', 'tick-delete', 'boot', 'apply', 'proven-good', 'lock'])(
    'probation mutation with a mismatched adoptionId changes no file: %s', async kind => {
      const f = fixture(), expectId = randomUUID();
      f.tick();
      if (kind === 'tick-fail') f.at = AT + 2001;
      if (kind === 'tick-delete') f.head = C;
      if (kind === 'apply') expect(requestRollback(f.opts).ok).toBe(true);
      const before = f.snapshot();
      const opts = { ...f.opts, expectId };
      const mutators = {
        open: () => f.open(B, { expectId }),
        request: () => requestRollback(opts),
        'tick-pass': () => checkProbationAtTick(opts),
        'tick-fail': () => checkProbationAtTick(opts),
        'tick-delete': () => checkProbationAtTick(opts),
        boot: () => bootProbation(opts),
        apply: () => applyPendingRollback(opts),
        'proven-good': () => writeProvenGood(f.root, f.env, { ...f.good, head: C }, expectId),
        lock: () => withProbationLock(f.root, expectId, () => { throw new Error('must not execute'); }, f.env),
      };
      await mutators[kind]();
      expect(f.snapshot()).toEqual(before);
      expect(finalizeRebuild).not.toHaveBeenCalled();
    });

  it('every writer contends on the same mutex, including recovery cleanup', async () => {
    const f = fixture(), id = readProbation(f.root, f.env).adoptionId;
    let release;
    const held = withProbationLock(f.root, id, () => new Promise(resolve => { release = resolve; }), f.env);
    const before = f.snapshot();
    expect(f.open()).toBe(false);
    expect(requestRollback(f.opts).reason).toBe('probation-locked');
    expect(checkProbationAtTick(f.opts).reason).toBe('probation-locked');
    expect((await bootProbation(f.opts)).reason).toBe('probation-locked');
    expect(writeProvenGood(f.root, f.env, { ...f.good, head: C })).toBe(false);
    expect(f.snapshot()).toEqual(before);
    release(); await held;
    expect(requestRollback(f.opts).ok).toBe(true);
    const markerBefore = f.snapshot();
    const pending = withProbationLock(f.root, id, () => new Promise(resolve => { release = resolve; }), f.env);
    expect((await applyPendingRollback(f.opts)).reason).toBe('probation-locked');
    expect(f.snapshot()).toEqual(markerBefore);
    release(); await pending;
  });

  it.each(['alive', 'remote', 'unreadable', 'dead'])('mutex only reclaims a dead local owner: %s', kind => {
    const f = fixture();
    const lockRoot = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.probation-registration`);
    const pid = kind === 'dead' ? 2147483647 : process.pid;
    const holder = makeLockEntry(`${kind === 'remote' ? 'remote.invalid' : hostname()}:${pid}-${randomUUID()}`,
      'probation', '2000-01-01T00:00:00Z', pid);
    expect(acquireLockDir(lockRoot, 'probation', holder)).toBe(true);
    if (kind === 'unreadable') writeFileSync(join(lockDirFor(lockRoot, 'probation'), 'lock.json'), '{');
    const before = f.snapshot();
    const result = requestRollback(f.opts);
    if (kind === 'dead') expect(result.ok).toBe(true);
    else { expect(result.reason).toBe('probation-locked'); expect(f.snapshot()).toEqual(before); }
  });
});

describe('S2a boot and synchronous tick boundaries', () => {
  it('failed boot registration remains visible to the caller for retry', async () => {
    const f = fixture(), before = f.snapshot();
    renameSync.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(await bootProbation(f.opts)).toMatchObject({ reason: 'probation-write-failed' });
    expect(f.snapshot()).toEqual(before);
    await bootProbation(f.opts);
    expect(readProbation(f.root, f.env).boots).toBe(1);
  });
  it('startup failure after adoption rolls back at a later boot', async () => {
    const f = fixture();
    await bootProbation(f.opts);
    // A tick which throws before reaching rebuild leaves no completion evidence.
    expect(() => { throw new Error('B startup failure'); }).toThrow('B startup failure');
    f.at = AT + 2001;
    const result = await bootProbation({ ...f.opts, bootAt: AT + 2001 });
    expect(result).toMatchObject({ ok: true, restartRequired: true, head: A });
    expect(f.head).toBe(A);
    expect(finalizeRebuild).toHaveBeenCalledOnce();
    expect(readRebuildState(f.root, f.env).rejected).toMatchObject({ inputsKey: 'bad', probation: true });
    expect(existsSync(f.file('rollback-requested'))).toBe(false);
  });

  it('boot registration is idempotent for the same process start', async () => {
    const f = fixture();
    await bootProbation(f.opts); await bootProbation(f.opts);
    expect(readProbation(f.root, f.env).boots).toBe(1);
  });

  it.each(['alive', 'unknown', 'dead'])('boot accounting preserves sibling evidence: %s', async predecessor => {
    const f = fixture();
    f.json('probation', { ...readProbation(f.root, f.env), boots: 3, bootPid: 2147483647, bootHost: hostname() });
    const result = await bootProbation({ ...f.opts, probeBoot: () => predecessor });
    if (predecessor === 'dead') expect(result).toMatchObject({ ok: true, restartRequired: true });
    else expect(readProbation(f.root, f.env)).toMatchObject({ boots: 1, concurrentBoots: true });
  });

  it('tick proof promotes synchronously and only after adoption and this process boot', async () => {
    const f = fixture(); await bootProbation(f.opts); f.tick();
    const result = checkProbationAtTick(f.opts);
    expect(result).toEqual({ action: 'pass' });
    expect(result?.then).toBeUndefined();
    expect(readProvenGood(f.root, f.env)).toMatchObject({ head: B, inputsKey: 'bad' });
    expect(readProbation(f.root, f.env)).toBeNull();
    expect(finalizeRebuild).not.toHaveBeenCalled();
  });

  it.each([
    ['other pid', { pid: process.pid + 1 }], ['other head', { head: C }],
    ['at adoption', { lastTickDoneAt: new Date(AT).toISOString() }],
    ['at boot', { lastTickDoneAt: new Date(AT + 1).toISOString() }],
    ['future', { lastTickDoneAt: new Date(AT + 60011).toISOString() }],
    ['invalid date', { lastTickDoneAt: 'invalid' }],
  ])('rejects %s tick evidence', async (_name, tick) => {
    const f = fixture(); await bootProbation(f.opts); f.tick(tick);
    expect(checkProbationAtTick(f.opts)).toEqual({ action: 'pending' });
    expect(readProvenGood(f.root, f.env).head).toBe(A);
  });

  it('no-imported-change permits this pid while an old boot alone cannot prove B', () => {
    const f = fixture(); f.tick();
    const opts = { ...f.opts, bootSha: A, bootAt: AT - 100 };
    expect(checkProbationAtTick(opts).action).toBe('pending');
    expect(checkProbationAtTick({ ...opts, noRestartSha: B }).action).toBe('pass');
  });

  it.each([1002, 2001])('late tick cannot override the deadline at %s ms', async elapsed => {
    const f = fixture(); await bootProbation(f.opts); f.at = AT + elapsed;
    f.tick({ lastTickDoneAt: new Date(AT + elapsed - 1).toISOString() });
    expect(checkProbationAtTick(f.opts).action).toBe('fail');
    expect(f.head).toBe(B);
    expect(finalizeRebuild).not.toHaveBeenCalled();
    expect(existsSync(f.file('rollback-requested'))).toBe(true);
  });

  it('superseded tick removes only its own probation and never moves HEAD', () => {
    const f = fixture(); f.head = C;
    expect(checkProbationAtTick(f.opts)).toMatchObject({ action: 'none', superseded: true });
    expect(readProbation(f.root, f.env)).toBeNull();
    expect(readProvenGood(f.root, f.env).head).toBe(A);
  });

  it.each(['probation', 'rebuild-state'])('unreadable %s stays fail-closed and alerts once', kind => {
    const f = fixture(); f.tick();
    writeFileSync(kind === 'probation' ? f.file(kind) : rebuildStatePath(f.root, f.env), '{');
    for (let i = 0; i < 3; i++) expect(checkProbationAtTick(f.opts).action).toBe('pending');
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readProvenGood(f.root, f.env).head).toBe(A);
    expect(existsSync(f.file('probation'))).toBe(true);
  });

  it('force-unverified trees cannot become provenGood or rollback targets', () => {
    const f = fixture(); f.tick();
    writeRebuildState(f.root, { forceUnverifiedTrees: [B] }, f.env);
    expect(requestRollback(f.opts)).toMatchObject({ ok: false, reason: 'proven-good-unverified' });
    expect(checkProbationAtTick(f.opts)).toEqual({ action: 'pass', unverified: true });
    expect(readProvenGood(f.root, f.env).head).toBe(A);
  });

  it.each(['corrupt', 'directory', 'missing', 'array', 'null'])('unreadable rebuild state refuses promotion and rollback: %s', async kind => {
    const corrupt = f => {
      const path = rebuildStatePath(f.root, f.env);
      rmSync(path);
      if (kind === 'directory') mkdirSync(path);
      else if (kind !== 'missing') writeFileSync(path, kind === 'array' ? '[]' : kind === 'null' ? 'null' : '{');
    };
    const f = fixture(); f.tick(); corrupt(f);
    expect(checkProbationAtTick(f.opts).action).toBe('pending');
    expect(requestRollback(f.opts)).toMatchObject({ ok: false, reason: 'proven-good-unverified' });
    expect(readProvenGood(f.root, f.env).head).toBe(A);
    expect(existsSync(f.file('probation'))).toBe(true);
    const g = fixture(); expect(requestRollback(g.opts).ok).toBe(true); corrupt(g);
    expect(await applyPendingRollback(g.opts)).toMatchObject({ ok: false, reason: 'proven-good-unverified' });
    expect(existsSync(g.file('rollback-requested'))).toBe(true);
    expect(finalizeRebuild).not.toHaveBeenCalled();
  });
});

describe('S2a durable boot recovery', () => {
  it.each(['consumed', 'new adoption'])('identity changes while awaiting clone lock still retire stale code: %s', async kind => {
    const f = fixture(); requestRollback(f.opts);
    const actual = await vi.importActual('../../daemon-clone-lock.mjs');
    let newer;
    withWriteLock.mockImplementationOnce(async (root, fn, options) => {
      // A sibling holds the clone lock ahead of this caller, completes its recovery,
      // and optionally opens C before this caller acquires either mutation lock.
      rmSync(f.file('rollback-requested')); f.head = kind === 'consumed' ? A : C;
      if (kind === 'new adoption') { expect(f.open(C)).toBe(true); newer = f.snapshot(); }
      return actual.withWriteLock(root, fn, options);
    });
    expect(await applyPendingRollback({ ...f.opts, bootHead: B })).toMatchObject({ restartRequired: true });
    expect(finalizeRebuild).not.toHaveBeenCalled();
    if (newer) expect(f.snapshot()).toEqual(newer);
  });
  it('request does not move HEAD; boot finalizes under the clone write lock', async () => {
    const f = fixture(); expect(requestRollback(f.opts).ok).toBe(true);
    expect(f.head).toBe(B); expect(finalizeRebuild).not.toHaveBeenCalled();
    finalizeRebuild.mockImplementation(async ({ plan }) => {
      expect(inspectCloneLock(f.root, { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT }).writer).toBeTruthy();
      expect(readRebuildState(f.root, f.env).rejected.inputsKey).toBe('bad');
      f.head = plan.finalSha; return { adopted: true };
    });
    expect(await applyPendingRollback({ ...f.opts, bootHead: B })).toMatchObject({ ok: true, restartRequired: true });
  });

  it.each(['missing', 'corrupt', 'seeded'])('refuses %s provenGood without removing probation', kind => {
    const f = fixture(), before = readFileSync(f.file('probation'), 'utf8');
    if (kind === 'missing') rmSync(f.file('proven-good'));
    if (kind === 'corrupt') writeFileSync(f.file('proven-good'), '{');
    if (kind === 'seeded') f.json('proven-good', { ...f.good, seeded: true });
    for (let i = 0; i < 3; i++) expect(requestRollback(f.opts).reason).toBe('no-proven-good');
    expect(readFileSync(f.file('probation'), 'utf8')).toBe(before);
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(f.file('rollback-requested'))).toBe(false);
  });

  it.each(['adoptionId', 'from', 'to', 'rejectInputsKey', 'reason', 'at'])('malformed marker %s stays for operator recovery', async field => {
    const f = fixture(); requestRollback(f.opts);
    const marker = JSON.parse(readFileSync(f.file('rollback-requested'))); delete marker[field];
    f.json('rollback-requested', marker); const before = f.snapshot();
    expect(await applyPendingRollback(f.opts)).toMatchObject({ ok: false, reason: 'rollback-request-unreadable' });
    expect(f.snapshot()).toEqual(before);
    expect(finalizeRebuild).not.toHaveBeenCalled();
  });

  it('a consumed marker still restarts a sibling whose loaded head is stale', async () => {
    const f = fixture(); requestRollback(f.opts);
    expect((await applyPendingRollback({ ...f.opts, bootHead: B })).ok).toBe(true);
    expect(await applyPendingRollback({ ...f.opts, bootHead: B })).toMatchObject({ restartRequired: true });
    expect(await applyPendingRollback({ ...f.opts, bootHead: A })).toEqual({ action: 'none' });
  });

  it('failed finalization keeps marker and rejection for next boot', async () => {
    const f = fixture(); requestRollback(f.opts);
    finalizeRebuild.mockImplementation(async () => { f.head = A; throw new Error('after reset'); });
    expect(await applyPendingRollback({ ...f.opts, bootHead: B })).toMatchObject({ ok: false, restartRequired: true });
    expect(existsSync(f.file('rollback-requested'))).toBe(true);
    expect(readRebuildState(f.root, f.env).rejected.inputsKey).toBe('bad');
    expect((await applyPendingRollback({ ...f.opts, bootHead: A })).ok).toBe(true);
  });

  it('boot rollback preserves expired reader leases of unknown liveness', async () => {
    const f = fixture(); requestRollback(f.opts);
    const lease = { owner: 'remote.invalid:123', pid: 123, nowMs: AT - 3600000, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT };
    expect(acquireRead(f.root, lease).ok).toBe(true);
    const before = f.snapshot();
    expect(await applyPendingRollback(f.opts)).toMatchObject({ ok: false, reason: 'rollback-lock-timeout' });
    expect(inspectCloneLock(f.root, lease).readers).toHaveLength(1);
    expect(f.snapshot()).toEqual(before);
    releaseRead(f.root, lease);
  });

  it('boot rollback reclaims only a verifiably dead same-host reader', async () => {
    const f = fixture(); requestRollback(f.opts);
    const lease = { owner: `${hostname()}:2147483647`, pid: 2147483647, nowMs: AT, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT };
    expect(acquireRead(f.root, lease).ok).toBe(true);
    expect((await applyPendingRollback(f.opts)).ok).toBe(true);
    expect(inspectCloneLock(f.root, lease).readers).toHaveLength(0);
  });

  it.each(['', '0', '-1', '1.5', 'NaN'])('invalid probation window %s uses the default', value => {
    expect(probationMsOf({ WE_DAEMON_PROBATION_MS: value })).toBe(900000);
  });
});
