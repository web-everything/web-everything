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

  it('is dormant with settings omitted entirely (built-in defaults enable no clone)', () => {
    const empty = join(fixture, 'no-settings.json');
    expect(rt.resolveVersionedContext({ root: clone, env: {}, settings: undefined, settingsPath: empty })).toBeNull();
  });

  it('holds a rolled-back sha even after gc pruned the held version record (sha persisted in the hold)', async () => {
    const first = await rebuild();
    land('second.txt');
    const second = await rebuild();
    const { rollback } = await import('../daemon-version-switch.mjs');
    const rolled = await rollback({ clone: ctx.clone, home: ctx.home, settings, by: 'test', reason: 'bad' });
    expect(rolled.status).toBe('switched');
    const state = JSON.parse(readFileSync(join(ctx.dir, 'state.json'), 'utf8'));
    expect(state.hold).toMatchObject({ version: second.versionId, sha: git(origin, 'rev-parse', 'main') });
    rmSync(join(ctx.dir, 'versions', second.versionId), { recursive: true, force: true });
    expect(first.versionId).not.toBe(second.versionId);
    expect(await rebuild()).toMatchObject({ moved: false, reason: 'held-after-rollback' });
  });

  it('a hold with a traversal version id is ignored, never path-joined', async () => {
    await rebuild();
    land('third.txt');
    writeFileSync(join(ctx.dir, 'state.json'), JSON.stringify({ hold: { version: '../../etc', until: 'main-moves' } }));
    expect(await rebuild()).toMatchObject({ moved: true, adopted: true });
  });

  it.each(['transient', 'auth-broken', 'env-timeout'])('a %s smoke is retried with backoff, not recorded permanent', async (verdict) => {
    let clock = 1_000_000;
    const attempt = () => rt.versionedRebuild({ ctx, log, deps: { buildDeps, now: () => clock } });
    buildDeps.runSmoke = vi.fn(async () => ({ verdict, attempts: 1 }));
    expect(await attempt()).toMatchObject({ moved: false, reason: 'smoke-retry' });
    expect(await attempt()).toMatchObject({ moved: false, reason: 'smoke-backoff' });
    expect(buildDeps.runSmoke).toHaveBeenCalledTimes(1);
    clock += 61 * 60_000;
    buildDeps.runSmoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1 }));
    expect(await attempt()).toMatchObject({ moved: true, adopted: true });
    expect(buildDeps.runSmoke).toHaveBeenCalledTimes(1);
  });

  it('rebuildClone on a versioned clone takes the versioned path and never takes a clone lock', async () => {
    const r = await rebuildClone({ root: clone, versions: { ...ctx, clone: join(fixture, 'not-a-repo') }, log });
    expect(r).toMatchObject({ moved: false, reason: 'fetch-failed' });
    expect(lock.withWriteLock).not.toHaveBeenCalled();
    expect(lock.acquireRead).not.toHaveBeenCalled();
  });

  it.each([true, false].flatMap((mainOnly) =>
    ['recorded', 'unknown', 'ancestry', 'successor', 'pin-mismatch', 'corrupt'].map((kind) => [mainOnly, kind])))('versioned route mainOnly=%s protects %s overlays and audits force', async (mainOnly, kind) => {
    const { addOverlay, readOverlays, overlayFilePath, replaceOverlayRef } = await import('../daemon-overlays.mjs');
    const { readRebuildState, writeRebuildState, alertsFilePath } = await import('../daemon-rebuild/state.mjs');
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(fixture, 'overlays'), WE_DAEMON_STATE_DIR: join(fixture, 'state'),
      WE_NEEDS_YOU_FEED: join(fixture, 'needs-you-events.jsonl') };
    const head = git(clone, 'rev-parse', 'HEAD');
    const ref = 'lane/live';
    git(clone, 'update-ref', 'refs/remotes/origin/lane/old', head);
    if (kind === 'ancestry') git(clone, 'update-ref', `refs/remotes/origin/${ref}`, head);
    addOverlay(clone, { ref: kind === 'successor' ? 'lane/old' : ref, ...(kind === 'pin-mismatch' ? { pinnedSha: 'f'.repeat(40) } : {}) }, { env });
    if (kind === 'successor') replaceOverlayRef(clone, readOverlays(clone, { env })[0], ref, { env, pinnedSha: head });
    const registryBefore = readOverlays(clone, { env });
    if (kind !== 'unknown') writeRebuildState(clone, { adopted: { head, applied: ['recorded', 'pin-mismatch'].includes(kind) ? [{ ref }] : [] } }, env);
    const file = overlayFilePath(clone, env);
    if (kind === 'corrupt') writeFileSync(file, '{ invalid json');
    const before = readFileSync(file, 'utf8');
    // Deliberately unreachable version source: a guard must return before the versioned fetch.
    const opts = { root: clone, env, versions: { ...ctx, clone: join(fixture, 'not-a-repo') }, asJob: false, log, ...(mainOnly ? { mainOnly: true } : {}) };
    const held = await rebuildClone(opts);
    expect(held).toMatchObject({ moved: false, reason: kind === 'corrupt' ? 'overlay-state-corrupt' : 'overlay-refresh-held' });
    if (kind !== 'corrupt') {
      expect(readRebuildState(clone, env).held).toMatchObject({ reason: 'overlay-refresh-held', lastGood: head });
      const { replay } = await import('../../operations/needs-you-feed.mjs');
      expect(replay({ path: env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({ kind: 'overlay-held-on-last-good', refs: [ref] }));
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('overlay-held-on-last-good'));
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(rt.currentVersion(ctx)).toBeNull();
    expect(buildDeps.runSmoke).not.toHaveBeenCalled();
    const mainOnlyForce = { by: 'operator', reason: 'approved version recovery' };
    const forced = await rebuildClone({ ...opts, mainOnly: true, mainOnlyForce });
    expect(forced.reason).toBe('fetch-failed');
    const detail = { ...mainOnlyForce, refs: [kind === 'corrupt' ? 'unknown' : ref] };
    expect(forced.alerts).toContainEqual({ kind: 'main-only-forced', detail });
    const events = readFileSync(file.replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events.filter((e) => e.kind === 'main-only-forced')).toEqual([expect.objectContaining(detail)]);
    const alerts = readFileSync(alertsFilePath(clone, env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'main-only-forced', detail }));
    const { replay } = await import('../../operations/needs-you-feed.mjs');
    expect(replay({ path: env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({ kind: 'main-only-forced', ...detail }));
    expect(log.error).toHaveBeenCalledWith(`daemon-rebuild: main-only-forced ${JSON.stringify(detail)}`);
    expect(lock.withWriteLock).not.toHaveBeenCalled();
    if (kind !== 'corrupt') expect(readOverlays(clone, { env })).toEqual(registryBefore);
  });

  it.each([{}, { by: 'operator' }, { reason: 'recovery' }, { by: ' ', reason: 'recovery' }])('versioned force requires complete authorization %j', async (mainOnlyForce) => {
    await expect(rebuildClone({ root: clone, versions: ctx, mainOnly: true, mainOnlyForce, asJob: false, log }))
      .rejects.toThrow('--by=<operator> and --reason=<text>');
    expect(rt.currentVersion(ctx)).toBeNull();
    expect(buildDeps.runSmoke).not.toHaveBeenCalled();
  });

  it('versioned normal rebuild also refuses a corrupt registry', async () => {
    const { overlayFilePath } = await import('../daemon-overlays.mjs');
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(fixture, 'overlays') };
    const file = overlayFilePath(clone, env);
    mkdirSync(join(fixture, 'overlays'), { recursive: true });
    writeFileSync(file, '{ invalid json');
    expect(await rebuildClone({ root: clone, env, versions: ctx, asJob: false, log }))
      .toMatchObject({ moved: false, reason: 'overlay-state-corrupt' });
    expect(rt.currentVersion(ctx)).toBeNull();
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
        pin: over.pin ?? vi.fn(async ({ id }) => { pins.push(`pin:${id}`); return { status: 'pinned' }; }),
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

    it.each(['busy', 'disabled'])('a %s pin skips the tick instead of running unpinned', async (status) => {
      const t = mk({ pin: vi.fn(async () => ({ status })) });
      await expect(t.w.tickOnce()).resolves.toMatchObject({ skipped: true, reason: `pin-${status}` });
      expect(t.seen).toEqual([]);
      expect(t.versionApi.unpin).not.toHaveBeenCalled();
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
        versionApi: { currentVersion: () => ({ id: 'v9', dir: '/h/daemon/versions/v9', sha: 'aaa' }), pin: async () => ({ status: 'pinned' }), unpin: async () => {} },
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
