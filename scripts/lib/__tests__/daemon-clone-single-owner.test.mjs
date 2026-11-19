/** Phase 1 contract tests: single rebuild owner and durable overlay wakeups. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as lock from '../daemon-clone-lock.mjs';
import { rebuildClone as publicRebuildClone } from '../daemon-rebuild.mjs';
import { rebuildClone as coreRebuildClone } from '../daemon-rebuild/index.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';
import { retireRegistration } from '../../daemon-overlay.mjs';

// The hermetic guard rebinds native fs exports. Spy on that native object and synchronize its
// bindings, so production imports and assertions observe the same filesystem calls.
let writeSpy, renameSpy, realRename;
let scratch, root, lockRoot, env;
const T = 1_800_000_000_000;
beforeEach(() => {
  realRename = fs.renameSync;
  writeSpy = vi.spyOn(fs, 'writeFileSync');
  renameSpy = vi.spyOn(fs, 'renameSync');
  syncBuiltinESMExports();
  vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', undefined);
  scratch = mkdtempSync(join(tmpdir(), 'clone-single-owner-'));
  root = join(scratch, 'wev-review-daemon');
  lockRoot = join(scratch, 'locks');
  mkdirSync(root);
  env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
    WE_DAEMON_STATE_DIR: join(scratch, 'state'), WE_DAEMON_OVERLAY_STACK_BASES: '{}' };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(scratch, { recursive: true, force: true }); });
const ownership = (entries, extra = {}) => lock.resolveCloneOwnership({ root, entries, env, lockRoot, nowMs: T, ...extra });
const heartbeat = (nowMs = T) => lock.touchOwnerHeartbeat(root, { lockRoot, nowMs });
const request = (nowMs = T) => lock.writeRebuildRequest(root, { lockRoot, nowMs, by: 'operator', reason: 'removed', ref: 'lane/fix' });
const readRequest = (extra = {}) => lock.readRebuildRequest(root, { lockRoot, nowMs: T, ...extra });
function onlyFile() {
  const base = lock.cloneLockDirs(root, lockRoot).base;
  const files = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.includes('.tmp')).map((entry) => entry.name);
  expect(files).toHaveLength(1);
  return join(base, files[0]);
}

describe('resolveCloneOwnership and owner heartbeat', () => {
  it('maps the clone basename to the owner entry basename, including absolute entry paths', () => {
    expect(ownership([join(root, 'scripts/review-daemon.mjs')])).toMatchObject({ owner: true });
    heartbeat();
    expect(ownership(['scripts/fix-dispatch-daemon.mjs'])).toMatchObject({ owner: false });
    expect(ownership([])).toMatchObject({ owner: false });
  });
  it('unknown clone has no configured owner and preserves everybody-can-rebuild', () => {
    expect(ownership(['other.mjs'], { root: join(scratch, 'unknown-clone') })).toMatchObject({ owner: true });
  });
  it('environment overrides the configured owner entry', () => {
    env.WE_DAEMON_CLONE_OWNER_ENTRY = 'custom-owner.mjs';
    heartbeat();
    expect(ownership(['scripts/custom-owner.mjs'])).toMatchObject({ owner: true });
    expect(ownership(['review-daemon.mjs'])).toMatchObject({ owner: false });
  });
  it('missing heartbeat elects the sole live sibling', () => {
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-elected' });
  });
  it('default heartbeat freshness ends exactly at fifteen minutes', () => {
    heartbeat(T - 15 * 60_000 + 1);
    expect(ownership(['other.mjs']).owner).toBe(false);
    heartbeat(T - 15 * 60_000);
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-elected' });
  });
  it('configured freshness and heartbeat refresh use injected time', () => {
    env.WE_DAEMON_CLONE_OWNER_STALE_MS = '100';
    heartbeat(T - 100);
    expect(ownership(['other.mjs']).reason).toBe('owner-stale-elected');
    heartbeat();
    expect(ownership(['other.mjs']).owner).toBe(false);
  });
  it('unreadable legacy heartbeat elects a live sibling', () => {
    heartbeat();
    const file = onlyFile();
    rmSync(file); mkdirSync(file); // EISDIR even when the test runs as root.
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-elected' });
  });
});

describe('deterministic fallback election and fencing', () => {
  const beat = (key, nowMs = T) => lock.touchOwnerHeartbeat(root, { lockRoot, nowMs, key });
  it('elects the lowest live stable key independent of heartbeat order or clock offsets', () => {
    beat('z.mjs', T + 500); beat('a.mjs', T - 500);
    expect(ownership(['z.mjs']).owner).toBe(false);
    expect(ownership(['a.mjs']).owner).toBe(true);
  });
  it('rejects a previous epoch after takeover and never invokes its rebuild', async () => {
    beat('z.mjs'); const old = ownership(['z.mjs']);
    beat('a.mjs'); const next = ownership(['a.mjs']);
    expect(next.epoch).toBeGreaterThan(old.epoch);
    const rebuild = vi.fn();
    expect(await lock.withCloneOwnership(root, old, rebuild, { lockRoot })).toMatchObject({ owner: false });
    expect(rebuild).not.toHaveBeenCalled();
  });
  it('holds the election fence through a rebuild while leaving reader admission independent', async () => {
    beat('z.mjs'); const lease = ownership(['z.mjs']);
    const value = await lock.withCloneOwnership(root, lease, async () => {
      beat('a.mjs');
      expect(ownership(['a.mjs'])).toMatchObject({ owner: false, reason: 'owner-election-contended' });
      expect(lock.acquireRead(root, { lockRoot, owner: 'reader' }).ok).toBe(true);
      lock.releaseRead(root, { lockRoot, owner: 'reader' });
      return 'rebuilt';
    }, { lockRoot });
    expect(value).toBe('rebuilt');
    expect(ownership(['a.mjs']).epoch).toBeGreaterThan(lease.epoch);
  });
  it('missing daemon identity refuses election', () => {
    expect(ownership([])).toMatchObject({ owner: false, reason: 'owner-key-missing' });
  });
  it.each(['{broken', JSON.stringify({ key: 'z.mjs', epoch: Number.MAX_SAFE_INTEGER, session: 'old' })])(
    'unreadable or exhausted epoch evidence refuses election: %s', (contents) => {
      const file = join(lock.cloneLockDirs(root, lockRoot).base, 'owner-lease.json');
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents);
      expect(ownership(['a.mjs'])).toMatchObject({ owner: false, reason: 'owner-election-unavailable' });
    });
  it('future configured-owner heartbeat is live only within thirty seconds of reader time', () => {
    heartbeat(T + 30_000);
    expect(ownership(['z.mjs']).owner).toBe(false);
    heartbeat(T + 30_001);
    expect(ownership(['z.mjs']).owner).toBe(true);
  });
  it('excludes a heartbeat beyond the bounded future skew', () => {
    beat('a.mjs', T + 60_000);
    expect(ownership(['z.mjs']).owner).toBe(true);
  });
  it('every sibling publishes its own candidacy even when the configured owner is live', () => {
    heartbeat(); ownership(['z.mjs']);
    expect(ownership(['a.mjs'], { nowMs: T + 15 * 60_000 }).owner).toBe(true);
    expect(ownership(['z.mjs'], { nowMs: T + 15 * 60_000 }).owner).toBe(false);
  });
});

describe('durable rebuild request', () => {
  it('absent request is null; write/read preserves actor, reason and ref; clear is idempotent', () => {
    expect(readRequest()).toBeNull();
    request();
    expect(readRequest()).toMatchObject({ by: 'operator', reason: 'removed', ref: 'lane/fix' });
    lock.clearRebuildRequest(root, { lockRoot });
    lock.clearRebuildRequest(root, { lockRoot });
    expect(readRequest()).toBeNull();
  });
  it('marks requests stale at the explicit TTL or default thirty minutes without discarding work', () => {
    request(); const onStale = vi.fn();
    expect(readRequest({ nowMs: T + 99, ttlMs: 100, onStale })).not.toBeNull();
    expect(onStale).not.toHaveBeenCalled();
    expect(readRequest({ nowMs: T + 100, ttlMs: 100, onStale })).not.toBeNull();
    expect(onStale).toHaveBeenCalledOnce();
    request(); onStale.mockClear();
    expect(readRequest({ nowMs: T + 30 * 60_000 - 1, onStale })).not.toBeNull();
    expect(onStale).not.toHaveBeenCalled();
    expect(readRequest({ nowMs: T + 30 * 60_000, onStale })).not.toBeNull();
    expect(onStale).toHaveBeenCalledOnce();
  });
  it('honours the environment TTL as a stale retry threshold', () => {
    vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', '100');
    request(); const onStale = vi.fn();
    expect(readRequest({ nowMs: T + 101, onStale })).not.toBeNull();
    expect(onStale).toHaveBeenCalledOnce();
  });
  it.each(['{broken', '{}', 'null', '{"at":0}'])('corrupt or incomplete request %s remains synthetically pending', (contents) => {
    request();
    const file = onlyFile();
    writeFileSync(file, contents);
    const pending = readRequest();
    expect(pending).toEqual({ corrupt: true, id: `corrupt:${fs.statSync(file).mtimeMs}` });
    lock.clearRebuildRequest(root, { lockRoot, id: pending.id });
    expect(readRequest()).toBeNull();
  });
  it('publishes via tmp + rename in the lock base, keeping the old complete request until publication', () => {
    request();
    const target = onlyFile();
    const old = readFileSync(target, 'utf8');
    renameSpy.mockImplementationOnce((from, to) => {
      expect(String(to)).toBe(target);
      expect(String(from)).not.toBe(target);
      expect(dirname(String(from))).toBe(dirname(target));
      expect(readFileSync(target, 'utf8')).toBe(old);
      expect(JSON.parse(readFileSync(from, 'utf8'))).toMatchObject({ ref: 'lane/next' });
      return realRename(from, to);
    });
    writeSpy.mockClear(); renameSpy.mockClear();
    lock.writeRebuildRequest(root, { lockRoot, nowMs: T + 1, by: 'tester', reason: 'retired', ref: 'lane/next' });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls.some(([path]) => String(path) !== target)).toBe(true);
    expect(readRequest()).toMatchObject({ ref: 'lane/next' });
    expect(readdirSync(dirname(target), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name))
      .toEqual([target.slice(dirname(target).length + 1)]);
  });
});

function wrapper(entry, overrides = {}) {
  const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
  const onRestart = vi.fn((r) => r.reason);
  const tick = vi.fn(() => {
    const snap = lock.inspectCloneLock(root, { lockRoot });
    expect(snap.readers.filter((r) => r.live)).toHaveLength(1);
    expect(snap.writerLive).toBe(false);
    return 'ticked';
  });
  const options = { root, env, entries: [entry], rebuild, onRestart, readHead: () => 'boot',
    readState: () => ({}), readReady: () => null, readOriginRef: () => null, versions: null, background: null,
    diffFiles: () => ['shared.mjs'], importClosure: () => ({ complete: true, files: new Set(['shared.mjs']), jsonNames: new Set() }),
    now: () => T, minRestartIntervalMs: 0, log: { error: vi.fn() }, ...overrides };
  return { synced: withSelfSync({ tickOnce: tick }, options), rebuild, tick, onRestart };
}
describe('withSelfSync single owner', () => {
  it('public rebuild facade leaves lock policy opt-in with a plain re-export', () => {
    expect(publicRebuildClone).toBe(coreRebuildClone);
  });
  it('ordinary owner discovery never requests a hard claim', async () => {
    const w = wrapper('review-daemon.mjs');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it('corrupt requests rebuild normally, alert once, and acknowledge their synthetic ID', async () => {
    request(); writeFileSync(onlyFile(), '{broken');
    const pending = readRequest();
    const alert = vi.fn();
    const log = { error: vi.fn() };
    const w = wrapper('review-daemon.mjs', { log, tickProgress: { alert, markTickDone: vi.fn() } });
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
    expect(readRequest()).toBeNull();
    const ack = JSON.parse(readFileSync(join(lock.cloneLockDirs(root, lockRoot).base, 'rebuild-request-ack.json'), 'utf8'));
    expect(ack.id).toBe(pending.id);
    await w.synced.tickOnce();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('rebuild-request-corrupt', expect.objectContaining({ id: pending.id }), T);
    expect(log.error.mock.calls.filter(([line]) => line.includes('ALERT rebuild-request-corrupt'))).toHaveLength(1);
    expect(w.rebuild.mock.calls[1]).toEqual([]);
  });
  it('unreadable existing request remains pending and can be acknowledged by its synthetic ID', async () => {
    request();
    const file = onlyFile();
    fs.rmSync(file); fs.mkdirSync(file); // EISDIR is reliable even under root.
    const pending = readRequest();
    expect(pending).toEqual({ corrupt: true, id: `corrupt:${fs.statSync(file).mtimeMs}` });
    const w = wrapper('review-daemon.mjs');
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
    expect(readRequest()).toBeNull();
  });
  it('refused rebuild retains a corrupt request and deduplicates its alert across retries', async () => {
    request(); writeFileSync(onlyFile(), '{}');
    const pending = readRequest();
    const alert = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'tick-in-progress' }));
    const w = wrapper('review-daemon.mjs', { rebuild, tickProgress: { alert, markTickDone: vi.fn() } });
    await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(readRequest()).toEqual(pending);
    expect(rebuild.mock.calls).toEqual([[], []]);
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it('stale request alerts once and is consumed by a successful retry', async () => {
    request(T - 30 * 60_000 - 1);
    const alert = vi.fn();
    const log = { error: vi.fn() };
    const w = wrapper('review-daemon.mjs', { log, tickProgress: { alert, markTickDone: vi.fn() } });
    await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(readRequest()).toBeNull();
    expect(w.rebuild.mock.calls).toEqual([[], []]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('rebuild-request-stale', expect.any(Object), T);
    expect(log.error.mock.calls.filter(([line]) => line.includes('ALERT rebuild-request-stale'))).toHaveLength(1);
  });
  it('owner consumes a live request through ordinary rebuild discovery', async () => {
    request();
    const w = wrapper('review-daemon.mjs');
    await w.synced.tickOnce();
    expect(readRequest()).toBeNull();
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[], []]);
  });
  it('stale rebuild requests retry through ordinary discovery', async () => {
    request(T - 30 * 60_000 - 1);
    const w = wrapper('review-daemon.mjs');
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it('owner discovers a ready smoke-passed candidate on the current HEAD without changing lock policy', async () => {
    const ready = { prevHead: 'boot', adopt: { finalSha: 'next' }, passedAt: 'smoke-passed' };
    const w = wrapper('review-daemon.mjs', { readReady: () => ready });
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it('a ready candidate for another HEAD preserves ordinary discovery', async () => {
    const ready = { prevHead: 'other', adopt: { finalSha: 'next' }, passedAt: 'smoke-passed' };
    const w = wrapper('review-daemon.mjs', { readReady: () => ready });
    await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it('non-owner yields reader priority after maxAdoptWaitTicks for a ready candidate without rebuilding', async () => {
    heartbeat();
    const ready = { prevHead: 'boot', adopt: { finalSha: 'next' }, passedAt: 'smoke-passed' };
    const readReady = vi.fn(() => ready);
    const acquireRead = vi.fn((clone, opts) => opts.trackStarvation === false
      ? lock.acquireRead(clone, opts) : { ok: false, reason: 'writer-active', starved: 5 });
    const log = { error: vi.fn() };
    const w = wrapper('other.mjs', { readReady, acquireRead, log, maxAdoptWaitTicks: 2,
      readerPriorityAfter: 1, priorityWaitMs: 100, sleep: async () => {} });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    acquireRead.mockClear();
    await expect(w.synced.tickOnce()).resolves.toMatchObject({ skipped: true, reason: 'writer-active' });
    expect(acquireRead).toHaveBeenCalledTimes(1);
    expect(readReady).toHaveBeenCalledTimes(3);
    expect(w.tick).toHaveBeenCalledTimes(2);
    expect(w.rebuild).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/yielding this tick.*ready.*3.*2/));
  });
  it('configured stale owner fallback logs reason changes and alerts at most once per fifteen minutes', async () => {
    let nowMs = T;
    env.WE_DAEMON_CLONE_OWNER_STALE_MS = '1';
    const alert = vi.fn();
    const log = { error: vi.fn() };
    const w = wrapper('other.mjs', { now: () => nowMs, log,
      tickProgress: { alert, markTickDone: vi.fn() } });
    await w.synced.tickOnce();
    nowMs += 1;
    await w.synced.tickOnce();
    expect(alert).toHaveBeenCalledTimes(1);
    heartbeat(nowMs);
    await w.synced.tickOnce(); // Owner recovered: no fallback, no rebuild, and no alert.
    nowMs += 2;
    await w.synced.tickOnce(); // Fallback recurs within the window: log it, but do not alert again.
    nowMs = T + 15 * 60_000 - 1;
    await w.synced.tickOnce();
    expect(alert).toHaveBeenCalledTimes(1);
    nowMs += 1;
    await w.synced.tickOnce();
    expect(alert.mock.calls).toEqual([
      ['clone-owner-stale', expect.objectContaining({ clone: 'wev-review-daemon', entry: 'other.mjs', reason: 'owner-stale-elected' }), T],
      ['clone-owner-stale', expect.objectContaining({ reason: 'owner-stale-elected' }), T + 15 * 60_000],
    ]);
    expect(log.error.mock.calls.filter(([line]) => line.includes('clone ownership=owner-stale-elected'))).toHaveLength(2);
  });
  it('failed stale-owner alert delivery does not freeze fallback or retry every tick', async () => {
    const alert = vi.fn(() => { throw new Error('sink unavailable'); });
    const w = wrapper('other.mjs', { tickProgress: { alert, markTickDone: vi.fn() } });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(w.rebuild).toHaveBeenCalledTimes(2);
  });
  it('an unconfigured clone never emits a stale-owner alert', async () => {
    root = join(scratch, 'unconfigured-clone');
    mkdirSync(root);
    const alert = vi.fn();
    const w = wrapper('other.mjs', { tickProgress: { alert, markTickDone: vi.fn() } });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('non-owner runs every tick under a read lock without rebuild or a write reservation', async () => {
    heartbeat();
    const w = wrapper('other.mjs');
    writeSpy.mockClear();
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild).not.toHaveBeenCalled();
    const writerRoot = lock.cloneLockDirs(root, lockRoot).writerRoot;
    expect(writeSpy.mock.calls.some(([file]) => String(file).startsWith(writerRoot))).toBe(false);
    expect(lock.inspectCloneLock(root, { lockRoot }).readers).toEqual([]);
  });
  it('non-owner stale-refusal recovery never rebuilds', async () => {
    heartbeat();
    const w = wrapper('other.mjs', { hasStaleRefusal: () => true });
    await w.synced.tickOnce();
    expect(w.rebuild).not.toHaveBeenCalled();
  });
  it('non-owner still restarts on head-moved and releases its read slot first', async () => {
    heartbeat();
    const readHead = vi.fn().mockReturnValueOnce('boot').mockReturnValue('new-head');
    const onRestart = vi.fn((r) => {
      expect(lock.inspectCloneLock(root, { lockRoot }).readers).toEqual([]);
      return r.reason;
    });
    const w = wrapper('other.mjs', { readHead, onRestart, diffFiles: () => ['shared.mjs'],
      importClosure: () => ({ complete: true, files: new Set(['shared.mjs']) }) });
    await expect(w.synced.tickOnce()).resolves.toBe('head-moved');
    expect(w.tick).not.toHaveBeenCalled();
    expect(w.rebuild).not.toHaveBeenCalled();
  });
  it('owner rebuilds and refreshes heartbeat on each tick, even when no rebuild moves HEAD', async () => {
    let nowMs = T;
    const w = wrapper('review-daemon.mjs', { now: () => nowMs });
    await w.synced.tickOnce();
    expect(ownership(['other.mjs']).owner).toBe(false);
    nowMs += 14 * 60_000;
    await w.synced.tickOnce();
    expect(w.rebuild).toHaveBeenCalledTimes(2);
    expect(ownership(['other.mjs'], { nowMs: nowMs + 14 * 60_000 }).owner).toBe(false);
  });
  it.each([
    ['moved', { moved: true, adopted: true, head: 'new' }, true],
    ['up-to-date', { moved: false, reason: 'up-to-date' }, true],
    ['refused', { moved: false, reason: 'tick-in-progress' }, false],
    ['failed', { moved: false, reason: 'smoke-failed' }, false],
    ['job-pending', { moved: false, reason: 'rebuild-job-running' }, false],
  ])('request is consumed only after concluded rebuild: %s', async (_name, result, consumed) => {
    // The request and self-sync tick share the same injected clock.
    request();
    const rebuild = vi.fn(async () => {
      expect(readRequest()).not.toBeNull();
      return result;
    });
    const w = wrapper('review-daemon.mjs', { rebuild });
    await w.synced.tickOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(readRequest() === null).toBe(consumed);
  });
  it('non-owner leaves requests for the owner', async () => {
    heartbeat(); request();
    const w = wrapper('other.mjs');
    await w.synced.tickOnce();
    expect(w.rebuild).not.toHaveBeenCalled();
    expect(readRequest()).not.toBeNull();
  });
  it('thrown rebuild retains the request for retry', async () => {
    request();
    const w = wrapper('review-daemon.mjs', { rebuild: async () => { throw new Error('failed'); } });
    await expect(w.synced.tickOnce()).rejects.toThrow('failed');
    expect(readRequest()).not.toBeNull();
  });
});

describe('overlay withdrawal requests', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon-overlay.mjs');
  for (const pinned of [true, false]) {
    it(`remove ${pinned ? 'pinned writes' : 'unpinned does not write'} a rebuild request`, () => {
      addOverlay(root, { ref: 'lane/fix', pinned }, { env });
      const r = spawnSync(process.execPath, [cli, 'remove', `--clone=${root}`, '--ref=lane/fix',
        '--by=tester', '--reason=withdrawn', '--json'], {
        env: { ...process.env, ...env, HOME: scratch }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ removed: true });
      expect(readOverlays(root, { env })).toEqual([]);
      const rec = readRequest({ nowMs: Date.now() });
      if (pinned) expect(rec).toMatchObject({ ref: 'lane/fix', by: 'tester', reason: expect.any(String) });
      else expect(rec).toBeNull();
    });
    it(`retire ${pinned ? 'pinned writes' : 'unpinned does not write'} a rebuild request`, async () => {
      addOverlay(root, { ref: 'lane/fix', pinned }, { env });
      const tip = 'a'.repeat(40);
      const r = await retireRegistration({ root, ref: 'lane/fix', expectedTip: tip, by: 'tester', env,
        deps: { prove: () => ({ action: 'retire', reason: 'in-main', tip, evidence: {} }), tip: () => tip } });
      expect(r.retired).toBe(true);
      expect(readOverlays(root, { env })).toEqual([]);
      const rec = readRequest({ nowMs: Date.now() });
      if (pinned) expect(rec).toMatchObject({ ref: 'lane/fix', by: 'tester', reason: expect.any(String) });
      else expect(rec).toBeNull();
    });
  }
  it('refused retirement leaves the pinned registration and writes no request', async () => {
    addOverlay(root, { ref: 'lane/fix', pinned: true }, { env });
    const r = await retireRegistration({ root, ref: 'lane/fix', expectedTip: 'a'.repeat(40), env,
      deps: { prove: () => ({ action: 'keep', reason: 'not-merged' }) } });
    expect(r.retired).toBe(false);
    expect(readOverlays(root, { env })).toHaveLength(1);
    expect(readRequest()).toBeNull();
  });
});
