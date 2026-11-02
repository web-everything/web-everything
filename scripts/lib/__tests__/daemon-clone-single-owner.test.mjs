/** Phase 1 contract tests: single rebuild owner and durable overlay wakeups. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as lock from '../daemon-clone-lock.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';
import { retireRegistration } from '../../daemon-overlay.mjs';

// Observe publication through the real filesystem, including the old contents at rename time.
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), renameSync: vi.fn(fs.renameSync) };
});
let scratch, root, lockRoot, env;
const T = 1_800_000_000_000;
beforeEach(() => {
  vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', undefined);
  scratch = mkdtempSync(join(tmpdir(), 'clone-single-owner-'));
  root = join(scratch, 'wev-review-daemon');
  lockRoot = join(scratch, 'locks');
  mkdirSync(root);
  env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
    WE_DAEMON_STATE_DIR: join(scratch, 'state'), WE_DAEMON_OVERLAY_STACK_BASES: '{}' };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });
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
  it('missing heartbeat fails closed to owner-stale-fallback', () => {
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-fallback' });
  });
  it('default heartbeat freshness ends exactly at fifteen minutes', () => {
    heartbeat(T - 15 * 60_000 + 1);
    expect(ownership(['other.mjs']).owner).toBe(false);
    heartbeat(T - 15 * 60_000);
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-fallback' });
  });
  it('configured freshness and heartbeat refresh use injected time', () => {
    env.WE_DAEMON_CLONE_OWNER_STALE_MS = '100';
    heartbeat(T - 100);
    expect(ownership(['other.mjs']).reason).toBe('owner-stale-fallback');
    heartbeat();
    expect(ownership(['other.mjs']).owner).toBe(false);
  });
  it('unreadable heartbeat fails closed with the named fallback', () => {
    heartbeat();
    const file = onlyFile();
    rmSync(file); mkdirSync(file); // EISDIR even when the test runs as root.
    expect(ownership(['other.mjs'])).toMatchObject({ owner: true, reason: 'owner-stale-fallback' });
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
  it('expires at the explicit TTL and defaults to thirty minutes', () => {
    request();
    expect(readRequest({ nowMs: T + 99, ttlMs: 100 })).not.toBeNull();
    expect(readRequest({ nowMs: T + 101, ttlMs: 100 })).toBeNull();
    request();
    expect(readRequest({ nowMs: T + 30 * 60_000 - 1 })).not.toBeNull();
    expect(readRequest({ nowMs: T + 30 * 60_000 + 1 })).toBeNull();
  });
  it('honours the environment TTL', () => {
    vi.stubEnv('WE_DAEMON_REBUILD_REQUEST_TTL_MS', '100');
    request();
    expect(readRequest({ nowMs: T + 101 })).toBeNull();
  });
  it.each(['{broken', '{}', 'null'])('corrupt or incomplete request %s is null', (contents) => {
    request(); writeFileSync(onlyFile(), contents);
    expect(readRequest()).toBeNull();
  });
  it('publishes via tmp + rename in the lock base, keeping the old complete request until publication', () => {
    request();
    const target = onlyFile();
    const old = readFileSync(target, 'utf8');
    const realRename = renameSync.getMockImplementation();
    renameSync.mockImplementationOnce((from, to) => {
      expect(String(to)).toBe(target);
      expect(String(from)).not.toBe(target);
      expect(dirname(String(from))).toBe(dirname(target));
      expect(readFileSync(target, 'utf8')).toBe(old);
      expect(JSON.parse(readFileSync(from, 'utf8'))).toMatchObject({ ref: 'lane/next' });
      return realRename(from, to);
    });
    writeFileSync.mockClear(); renameSync.mockClear();
    lock.writeRebuildRequest(root, { lockRoot, nowMs: T + 1, by: 'tester', reason: 'retired', ref: 'lane/next' });
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync.mock.calls.some(([path]) => String(path) !== target)).toBe(true);
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
  it('non-owner runs every tick under a read lock without rebuild or a write reservation', async () => {
    heartbeat();
    const w = wrapper('other.mjs');
    writeFileSync.mockClear();
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild).not.toHaveBeenCalled();
    const writerRoot = lock.cloneLockDirs(root, lockRoot).writerRoot;
    expect(writeFileSync.mock.calls.some(([file]) => String(file).startsWith(writerRoot))).toBe(false);
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
