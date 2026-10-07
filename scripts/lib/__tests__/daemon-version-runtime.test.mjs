/** @file scripts/lib/__tests__/daemon-version-runtime.test.mjs — card 89 S5: the lock-free in-tick versioned path. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../daemon-clone-lock.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, withWriteLock: vi.fn(real.withWriteLock), acquireRead: vi.fn(real.acquireRead) };
});

const lock = await import('../daemon-clone-lock.mjs');
const { rebuildClone } = await import('../daemon-rebuild/rebuild.mjs');
const { withSelfSync } = await import('../daemon-self-sync.mjs');
const { runDaemonLoadOverlay } = await import('../daemon-load-overlay.mjs');
const { spawnPassOnce } = await import('../../../skills-src/conveyor/pass-daemon.mjs');
const rt = await import('../daemon-version-runtime.mjs');

describe('card 89 S5 — versioned in-tick path', () => {
  let fixture, origin, clone, home, settings, ctx, buildDeps, log;
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const land = (name, body = name) => {
    const work = join(fixture, 'work');
    if (!existsSync(work)) git(fixture, 'clone', '--quiet', origin, work);
    git(work, 'config', 'user.name', 'F'); git(work, 'config', 'user.email', 'f@example.test');
    writeFileSync(join(work, name), body);
    git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', name); git(work, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'daemon-vruntime-'));
    origin = join(fixture, 'origin.git');
    git(fixture, 'init', '--quiet', '--bare', '-b', 'main', origin);
    land('package.json', '{"name":"f","version":"1.0.0"}'); land('package-lock.json', '{"lockfileVersion":3}');
    clone = join(fixture, 'daemon');
    git(fixture, 'clone', '--quiet', origin, clone);
    home = join(fixture, '.daemon-clones');
    settings = { enabled: { daemon: true }, clonesRoot: home, statePaths: ['.conveyor'], carryPaths: [] };
    ctx = rt.resolveVersionedContext({ root: clone, settings });
    let tick = 0;
    buildDeps = {
      now: () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)),
      installer: (into) => { mkdirSync(join(into, 'node_modules')); },
      runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1 })),
    };
    log = { error: vi.fn() };
    lock.withWriteLock.mockClear(); lock.acquireRead.mockClear();
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  const rebuild = () => rt.versionedRebuild({ ctx, log, deps: { buildDeps } });

  it('is dormant: an unlisted clone resolves no versioned context', () => {
    expect(rt.resolveVersionedContext({ root: clone, settings: { enabled: {} } })).toBeNull();
    expect(rt.resolveVersionedContext({ root: clone, settings: { enabled: { daemon: false } } })).toBeNull();
  });

  it('rebuildClone on a versioned clone takes the versioned path and never takes a clone lock', async () => {
    const r = await rebuildClone({ root: clone, versions: { ...ctx, clone: join(fixture, 'not-a-repo') }, log });
    expect(r).toMatchObject({ moved: false, reason: 'fetch-failed' });
    expect(lock.withWriteLock).not.toHaveBeenCalled();
    expect(lock.acquireRead).not.toHaveBeenCalled();
  });

  it('first adoption then a second main commit: two switches, current follows, nothing locked', async () => {
    const first = await rebuild();
    expect(first).toMatchObject({ moved: true, adopted: true, reason: 'adopted' });
    expect(rt.currentVersion(ctx).sha).toBe(git(origin, 'rev-parse', 'main'));
    expect(await rebuild()).toMatchObject({ moved: false, reason: 'up-to-date' });
    const second = land('second.txt');
    const r2 = await rebuild();
    expect(r2).toMatchObject({ moved: true, adopted: true, head: second });
    expect(rt.currentVersion(ctx).sha).toBe(second);
    expect(readlinkSync(join(ctx.dir, 'current'))).toBe(`versions/${r2.versionId}`);
    expect(lock.withWriteLock).not.toHaveBeenCalled();
    expect(lock.acquireRead).not.toHaveBeenCalled();
  });

  it('a version whose smoke fails is never switched to', async () => {
    buildDeps.runSmoke = vi.fn(async () => ({ verdict: 'code', attempts: 1 }));
    expect(await rebuild()).toMatchObject({ moved: false, reason: 'smoke-failed' });
    expect(rt.currentVersion(ctx)).toBeNull();
  });

  it('answers queued requests with the rebuild result and removes them', async () => {
    const id = rt.submitRequest(ctx, { ref: 'lane/x', pr: 7, by: 'me' });
    await rebuild();
    const res = JSON.parse(readFileSync(join(ctx.dir, 'results', `${id}.json`), 'utf8'));
    expect(res).toMatchObject({ id, adopted: true, overlaysApplied: false });
    expect(existsSync(join(ctx.dir, 'requests', `${id}.json`))).toBe(false);
  });

  describe('withSelfSync', () => {
    const mk = (over = {}) => {
      const tickContext = {};
      const seen = [];
      const pins = [];
      let cur = { id: 'v1', dir: '/h/daemon/versions/v1', sha: 'aaa' };
      const versionApi = {
        currentVersion: () => cur,
        pin: vi.fn(async ({ id }) => { pins.push(`pin:${id}`); }),
        unpin: vi.fn(async ({ id }) => { pins.push(`unpin:${id}`); }),
      };
      const w = withSelfSync({ tickOnce: over.tick ?? (async () => { seen.push(tickContext.tickRoot); return 'ticked'; }) }, {
        root: over.root ?? '/h/daemon/versions/v1', onRestart: over.onRestart ?? vi.fn(() => 'restarted'), env: {},
        versions: { name: 'daemon', clone: '/ws/daemon', home: '/h', dir: '/h/daemon', settings: {} },
        versionApi, tickContext, rebuild: over.rebuild ?? vi.fn(async () => ({ moved: false, reason: 'up-to-date' })),
        readHead: () => 'aaa', acquireRead: lock.acquireRead, releaseRead: vi.fn(), readState: vi.fn(),
        importClosure: () => new Set(['/h/daemon/versions/v1/x.mjs']), entries: ['/h/daemon/versions/v1/x.mjs'],
        diffFiles: over.diffFiles ?? (() => ['x.mjs']), minRestartIntervalMs: 0, log, now: () => Date.now(),
      });
      return { w, seen, pins, versionApi, setCur: (c) => { cur = c; }, tickContext };
    };

    it('ticks from the pinned current folder, never touching the read/write lock', async () => {
      const t = mk();
      await expect(t.w.tickOnce()).resolves.toBe('ticked');
      expect(t.seen).toEqual(['/h/daemon/versions/v1']);
      expect(t.pins).toEqual(['pin:v1', 'unpin:v1']);
      expect(t.tickContext.tickRoot).toBeUndefined();
      expect(lock.acquireRead).not.toHaveBeenCalled();
    });

    it('a switch triggers the restart gate: imported change -> restart instead of tick', async () => {
      const onRestart = vi.fn(() => 'restarted');
      const t = mk({ onRestart, rebuild: async () => ({ moved: true, adopted: true, head: 'bbb' }) });
      t.setCur({ id: 'v2', dir: '/h/daemon/versions/v2', sha: 'bbb' });
      await expect(t.w.tickOnce()).resolves.toBe('restarted');
      expect(onRestart).toHaveBeenCalled();
      expect(t.seen).toEqual([]);
    });

    it('a switch that changes nothing imported ticks on, from the NEW folder', async () => {
      const t = mk({ diffFiles: () => ['docs/unrelated.md'], rebuild: async () => ({ moved: true, adopted: true, head: 'bbb' }) });
      t.setCur({ id: 'v2', dir: '/h/daemon/versions/v2', sha: 'bbb' });
      await expect(t.w.tickOnce()).resolves.toBe('ticked');
      expect(t.seen).toEqual(['/h/daemon/versions/v2']);
    });

    it('soak shape: a switch mid-tick leaves the running tick on its old folder; the next tick uses the new one', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const seen = [];
      let t;
      t = mk({
        diffFiles: () => ['docs/unrelated.md'],
        tick: async () => { seen.push(t.tickContext.tickRoot); await gate; seen.push(t.tickContext.tickRoot); return 'done'; },
      });
      const running = t.w.tickOnce();
      while (seen.length < 1) await new Promise((r) => { setImmediate(r); });
      t.setCur({ id: 'v2', dir: '/h/daemon/versions/v2', sha: 'bbb' }); // the switch lands mid-tick
      release();
      await running;
      expect(seen).toEqual(['/h/daemon/versions/v1', '/h/daemon/versions/v1']);
      await t.w.tickOnce();
      expect(t.pins).toEqual(['pin:v1', 'unpin:v1', 'pin:v2', 'unpin:v2']);
    });

    it('a pass child spawns from the tick root (pass-daemon wiring)', async () => {
      const spawned = [];
      const tickContext = {};
      const spawnFn = (exe, argv) => {
        spawned.push(argv[0]);
        const handlers = {};
        const child = { stdout: null, stderr: null, on: (e, f) => { handlers[e] = f; if (e === 'close') queueMicrotask(() => f(0, null)); return child; } };
        return child;
      };
      const t = withSelfSync({ tickOnce: () => spawnPassOnce({ script: 'scripts/conveyor/p.mjs' }, { root: tickContext.tickRoot ?? '/fallback', spawnFn, log }) }, {
        root: '/h/daemon/versions/v1', onRestart: vi.fn(), env: {}, tickContext,
        versions: { name: 'daemon', clone: '/ws/daemon', home: '/h', dir: '/h/daemon', settings: {} },
        versionApi: { currentVersion: () => ({ id: 'v9', dir: '/h/daemon/versions/v9', sha: 'aaa' }), pin: async () => {}, unpin: async () => {} },
        rebuild: async () => ({ moved: false, reason: 'up-to-date' }), readHead: () => 'aaa', log,
      });
      await t.tickOnce();
      expect(spawned).toEqual(['/h/daemon/versions/v9/scripts/conveyor/p.mjs']);
      const src = readFileSync(join(process.cwd(), 'skills-src/conveyor/pass-daemon.mjs'), 'utf8');
      expect(src).toMatch(/root: tickContext\.tickRoot \?\? REPO_ROOT/);
    });
  });

  describe('daemon-load-overlay on a versioned clone', () => {
    it('--wait returns the request result produced by the in-tick rebuild; no lock, no direct rebuild', async () => {
      const rebuildSpy = vi.fn();
      const res = await runDaemonLoadOverlay({
        clone, ref: 'lane/x', pr: 1, wait: true, waitMs: 5000, versions: ctx, addOverlayFn: vi.fn(), rebuild: rebuildSpy, log,
        waitFor: async (c, id) => { await rebuild(); return rt.waitForResult(c, id, { timeoutMs: 1000, sleep: async () => {} }); },
      });
      expect(rebuildSpy).not.toHaveBeenCalled();
      expect(res).toMatchObject({ versioned: true, registered: true, adopted: true, mergedAnything: true, timedOut: false });
      expect(res.request).toMatchObject({ id: res.requestId, adopted: true });
      expect(lock.withWriteLock).not.toHaveBeenCalled();
    });

    it('without --wait it only queues the request; a wait with no updater times out cleanly', async () => {
      const queued = await runDaemonLoadOverlay({ clone, ref: 'lane/x', versions: ctx, addOverlayFn: vi.fn(), log });
      expect(queued).toMatchObject({ versioned: true, pending: true });
      const r = await rt.waitForResult(ctx, 'nope', { timeoutMs: 0, sleep: async () => {} });
      expect(r.status).toBe('timeout');
    });
  });
});
