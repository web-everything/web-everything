/** Phase 6 contracts: durable counted retries, and retirement of hard writer priority. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lock from '../daemon-clone-lock.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';
import { rebuildClone as publicRebuildClone } from '../daemon-rebuild.mjs';
import { rebuildClone as coreRebuildClone } from '../daemon-rebuild/index.mjs';

const T = 1_800_000_000_000;
const alive = () => 'alive';
let scratch, root, lockRoot, env, nowMs;
beforeEach(() => {
  vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_MAX_FAILURES', undefined);
  vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', '100');
  vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', undefined);
  scratch = fs.mkdtempSync(join(tmpdir(), 'rebuild-request-failures-'));
  root = join(scratch, 'wev-review-daemon');
  lockRoot = join(scratch, 'locks');
  fs.mkdirSync(root);
  env = { ...process.env, WE_DAEMON_CLONE_LOCK_ROOT: lockRoot,
    WE_DAEMON_STATE_DIR: join(scratch, 'state'), WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays') };
  nowMs = T;
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const base = () => lock.cloneLockDirs(root, lockRoot).base;
// The retry ledger is clone-local, independent of the daemon instance and working tree.
const failureFile = () => join(base(), 'rebuild-request-failures.json');
const publish = () => lock.writeRebuildRequest(root, { lockRoot, nowMs, by: 'operator', reason: 'removed', ref: 'lane/fix' });
const pending = () => lock.readRebuildRequest(root, { lockRoot, env, nowMs });
function maxFailures(value) {
  vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_MAX_FAILURES', value);
  env.WE_DAEMON_REBUILD_REQUEST_MAX_FAILURES = value;
}
function owner(rebuild, overrides = {}) {
  const alert = vi.fn();
  const log = { error: vi.fn() };
  const tick = vi.fn(() => 'ticked');
  const synced = withSelfSync({ tickOnce: tick }, {
    root, env, entries: ['review-daemon.mjs'], rebuild, onRestart: vi.fn(),
    readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
    versions: null, background: null, rebuildAsJob: false,
    diffFiles: () => ['shared.mjs'],
    importClosure: () => ({ complete: true, files: new Set(['shared.mjs']), jsonNames: new Set() }),
    now: () => nowMs, minRestartIntervalMs: 0, log,
    tickProgress: { alert, markTickDone: vi.fn() }, ...overrides,
  });
  return { synced, alert, log, tick };
}
const refused = () => vi.fn(async () => ({ moved: false, reason: 'tick-in-progress' }));
const alertsOf = (w, kind) => w.alert.mock.calls.filter(([name]) => name === kind);

describe('rebuild request failure budget and retention', () => {
  it('TTL alone keeps an unacknowledged request pending with zero counted failures', () => {
    const req = publish(); nowMs += 101;
    expect(pending()).toMatchObject({ id: req.id });
  });
  it('the default thirty-minute TTL also keeps an unacknowledged request with zero failures', () => {
    vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', undefined);
    delete env.WE_DAEMON_REBUILD_REQUEST_TTL_MS;
    const req = publish(); nowMs += 30 * 60_000 + 1;
    expect(pending()).toMatchObject({ id: req.id });
  });
  it('a stale owner keeps retrying below the budget and alerts at most once per fifteen minutes', async () => {
    maxFailures('100');
    const req = publish(); const rebuild = refused(); const w = owner(rebuild);
    nowMs = T + 101;
    await w.synced.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(pending()).toMatchObject({ id: req.id });
    nowMs += 1; await w.synced.tickOnce();
    nowMs = T + 101 + 15 * 60_000 - 1; await w.synced.tickOnce();
    expect(alertsOf(w, 'rebuild-request-stale')).toHaveLength(1);
    nowMs += 1; await w.synced.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(4);
    expect(pending()).toMatchObject({ id: req.id });
    expect(alertsOf(w, 'rebuild-request-stale')).toEqual([
      ['rebuild-request-stale', expect.objectContaining({ id: req.id }), T + 101],
      ['rebuild-request-stale', expect.objectContaining({ id: req.id }), nowMs],
    ]);
    expect(alertsOf(w, 'rebuild-request-abandoned')).toEqual([]);
  });
  it('the default budget abandons on the fifth refusal, not on the first four', async () => {
    const req = publish(); const rebuild = refused(); const w = owner(rebuild);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await w.synced.tickOnce();
      expect(pending()).toMatchObject({ id: req.id });
    }
    await w.synced.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(5);
    expect(pending()).toBeNull();
    expect(alertsOf(w, 'rebuild-request-abandoned')).toHaveLength(1);
    expect(alertsOf(w, 'rebuild-request-abandoned')[0][1]).toMatchObject({ id: req.id });
    await w.synced.tickOnce();
    expect(alertsOf(w, 'rebuild-request-abandoned')).toHaveLength(1);
  });
  it.each(['0', '-1', 'invalid'])('invalid failure budget %s falls back to five attempts', async (value) => {
    maxFailures(value);
    const req = publish(); const w = owner(refused());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await w.synced.tickOnce(); expect(pending()).toMatchObject({ id: req.id });
    }
    await w.synced.tickOnce(); expect(pending()).toBeNull();
  });
  it('configured failure counts persist in the clone lock base across daemon restarts', async () => {
    maxFailures('3');
    const req = publish(); const rebuild = refused();
    await owner(rebuild).synced.tickOnce();
    expect(pending()).toMatchObject({ id: req.id });
    expect(fs.existsSync(failureFile())).toBe(true);
    await owner(rebuild).synced.tickOnce();
    expect(pending()).toMatchObject({ id: req.id });
    await owner(rebuild).synced.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(3);
    expect(pending()).toBeNull();
  });
  it.each(['tick-in-progress', 'dirty', 'smoke-rejected', 'rebuild-job-running'])('a refused/failed rebuild (%s) consumes an attempt', async (reason) => {
    maxFailures('1'); publish();
    const w = owner(vi.fn(async () => ({ moved: false, reason })));
    await w.synced.tickOnce();
    expect(pending()).toBeNull();
    expect(alertsOf(w, 'rebuild-request-abandoned')).toHaveLength(1);
  });
  it('a thrown rebuild consumes a persisted failure and abandons at the configured bound', async () => {
    maxFailures('2');
    const req = publish(); const rebuild = vi.fn(async () => { throw new Error('smoke crashed'); });
    // Counting a thrown rebuild is required; whether the tick propagates that error is unchanged.
    const acceptRebuildError = (error) => expect(error.message).toBe('smoke crashed');
    await owner(rebuild).synced.tickOnce().catch(acceptRebuildError);
    expect(pending()).toMatchObject({ id: req.id });
    const restarted = owner(rebuild); await restarted.synced.tickOnce().catch(acceptRebuildError);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(pending()).toBeNull();
    expect(alertsOf(restarted, 'rebuild-request-abandoned')).toHaveLength(1);
  });
  it('TTL expiry after the configured counted failures abandons with the named alert', async () => {
    maxFailures('2');
    const req = publish(); const w = owner(refused());
    await w.synced.tickOnce(); expect(pending()).toMatchObject({ id: req.id });
    nowMs += 101; await w.synced.tickOnce();
    expect(pending()).toBeNull();
    expect(alertsOf(w, 'rebuild-request-abandoned')).toHaveLength(1);
    expect(alertsOf(w, 'rebuild-request-abandoned')[0][1]).toMatchObject({ id: req.id });
    expect(alertsOf(w, 'rebuild-request-expired')).toEqual([]);
  });
  it.each([
    ['moved', { moved: true, reason: 'adopted' }],
    ['up-to-date', { moved: false, reason: 'up-to-date' }],
  ])('a successful %s rebuild clears before exhausting the failure budget', async (_name, result) => {
    maxFailures('5');
    const req = publish();
    await owner(refused()).synced.tickOnce(); expect(pending()).toMatchObject({ id: req.id });
    await owner(vi.fn(async () => result)).synced.tickOnce();
    expect(pending()).toBeNull();
  });
  it('a newly published request gets a fresh budget independent of the preceding id', async () => {
    maxFailures('2');
    const old = publish(); await owner(refused()).synced.tickOnce();
    const next = publish(); expect(next.id).not.toBe(old.id);
    await owner(refused()).synced.tickOnce(); expect(pending()).toMatchObject({ id: next.id });
    await owner(refused()).synced.tickOnce(); expect(pending()).toBeNull();
  });
  it("a replacement published during the old request's last failed attempt survives abandonment", async () => {
    maxFailures('1'); const old = publish(); let next;
    const w = owner(vi.fn(async () => { next = publish(); return { moved: false, reason: 'dirty' }; }));
    await w.synced.tickOnce();
    expect(next.id).not.toBe(old.id);
    expect(pending()).toMatchObject({ id: next.id });
    // The old attempt must not be charged against the replacement's budget.
    await owner(refused()).synced.tickOnce(); expect(pending()).toBeNull();
  });
  it.each(['directory', '{broken', '{}', 'null'])('unreadable/incomplete failure ledger (%s) stays pending even after a successful rebuild', async (contents) => {
    maxFailures('1'); const req = publish();
    if (contents === 'directory') fs.mkdirSync(failureFile());
    else fs.writeFileSync(failureFile(), contents);
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await owner(rebuild).synced.tickOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(pending()).toMatchObject({ id: req.id });
    nowMs += 101;
    expect(pending()).toMatchObject({ id: req.id });
  });
  it("a non-owner neither rebuilds nor spends the owner's retry budget", async () => {
    maxFailures('1'); const req = publish();
    lock.touchOwnerHeartbeat(root, { lockRoot, nowMs });
    const rebuild = refused(); const w = owner(rebuild, { entries: ['other.mjs'] });
    await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(rebuild).not.toHaveBeenCalled();
    expect(fs.existsSync(failureFile())).toBe(false);
    expect(pending()).toMatchObject({ id: req.id });
    await owner(refused()).synced.tickOnce(); expect(pending()).toBeNull();
  });
});

describe('failure evidence publication safeguards', () => {
  it('failure ledger publication is atomic and failed publication leaves the request pending', async () => {
    maxFailures('1'); const req = publish();
    const original = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === failureFile()) {
        expect(String(from)).toContain(`${failureFile()}.tmp-`);
        expect(pending()).toMatchObject({ id: req.id }); // old evidence stays visible until rename
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return original(from, to);
    });
    await owner(refused()).synced.tickOnce();
    expect(pending()).toMatchObject({ id: req.id });
    expect(fs.existsSync(failureFile())).toBe(false);
    rename.mockRestore();
    await owner(refused()).synced.tickOnce(); expect(pending()).toBeNull();
  });
  it('a corrupt request with unknown generation cannot be acknowledged or abandoned against a later publication', async () => {
    maxFailures('1'); publish();
    const requestFile = join(base(), 'rebuild-request.json');
    const stat = fs.statSync, read = fs.readFileSync;
    vi.spyOn(fs, 'statSync').mockImplementation((path, ...args) => {
      if (path === requestFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return stat(path, ...args);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (path === requestFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(path, ...args);
    });
    const w = owner(vi.fn(async () => ({ moved: false, reason: 'up-to-date' })));
    await w.synced.tickOnce(); await owner(refused()).synced.tickOnce();
    expect(pending()).toEqual({ corrupt: true, id: 'corrupt:unknown' });
    expect(fs.existsSync(join(base(), 'rebuild-request-ack.json'))).toBe(false);
    expect(fs.existsSync(failureFile())).toBe(false);
  });
});

describe('hard writer claims are retired; original soft fairness remains', () => {
  const options = () => ({ lockRoot, probe: alive, leaseMinutes: 1e9, writerClaimTtlMs: 1e12,
    writerPriorityAfter: 1, readerPriorityAfter: 3, writerPriorityMaxSkips: 0 });
  const read = (name) => lock.acquireRead(root, { ...options(), owner: name, readerKey: name, nowMs });
  const write = (extra = {}) => lock.acquireWrite(root, { ...options(), owner: 'writer', waitMs: 5,
    pollMs: 1, now: () => nowMs, sleep: async (ms) => { nowMs += ms; }, ...extra });
  function olderReader() {
    const { starvedRoot } = lock.cloneLockDirs(root, lockRoot); fs.mkdirSync(starvedRoot, { recursive: true });
    fs.writeFileSync(join(starvedRoot, 'older.json'), JSON.stringify({ owner: 'older', readerKey: 'older',
      pid: process.pid, count: 3, firstRefusedAt: new Date(nowMs - 100).toISOString(), lastRefusedAt: new Date(nowMs).toISOString() }));
  }
  it.each([true, false, undefined])('acquireWrite ignores hardClaim=%s and writes no hard field', async (hardClaim) => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', '1'); // a retired env cannot restore promotion
    expect(read('existing').ok).toBe(true);
    expect(await write({ hardClaim })).toMatchObject({ reason: 'tick-in-progress' });
    const claim = JSON.parse(fs.readFileSync(join(base(), 'writer-claim.json'), 'utf8'));
    expect(claim).not.toHaveProperty('hard');
    lock.releaseRead(root, { lockRoot, owner: 'existing' });
  });
  it('hardClaim cannot bypass the legacy reader skip cap', async () => {
    expect(read('existing').ok).toBe(true);
    await write({ hardClaim: true });
    expect(read('newcomer')).toEqual({ ok: true });
    lock.releaseRead(root, { lockRoot, owner: 'newcomer' });
    lock.releaseRead(root, { lockRoot, owner: 'existing' });
  });
  it('hardClaim cannot bypass the older starved reader or make the writer ignore reader-priority', async () => {
    expect(read('existing').ok).toBe(true); olderReader();
    expect(await write({ hardClaim: true })).toMatchObject({ ok: false, reason: 'reader-priority', heldBy: 'older' });
    expect(read('older')).toEqual({ ok: true });
    lock.releaseRead(root, { lockRoot, owner: 'older' });
    lock.releaseRead(root, { lockRoot, owner: 'existing' });
  });
  it('a persisted obsolete hard:true claim is treated as an ordinary soft claim', () => {
    fs.mkdirSync(base(), { recursive: true });
    fs.writeFileSync(join(base(), 'writer-claim.json'), JSON.stringify({ owner: 'old:123', pid: process.pid,
      hard: true, count: 2, since: new Date(nowMs).toISOString(), lastAt: new Date(nowMs).toISOString() }));
    expect(read('newcomer')).toEqual({ ok: true });
    lock.releaseRead(root, { lockRoot, owner: 'newcomer' });
  });
  it.each(['request', 'ready candidate'])('owner discovery with a %s never passes lockOpts.hardClaim', async (trigger) => {
    if (trigger === 'request') publish();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const ready = { passedAt: new Date(T).toISOString(), prevHead: 'boot', adopt: { finalSha: 'candidate' } };
    const w = owner(rebuild, { readReady: () => trigger === 'ready candidate' ? ready : null });
    await w.synced.tickOnce();
    expect(rebuild.mock.calls).toEqual([[]]);
  });
  it('daemon-rebuild remains the core function itself, with no wrapper forcing a hard claim', () => {
    expect(publicRebuildClone).toBe(coreRebuildClone);
  });
});
