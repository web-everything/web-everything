/**
 * @file scripts/lib/__tests__/daemon-background-build.test.mjs
 * @description x44lnnt — the fix daemon's tick starved behind its own inline rebuild (live 2026-10-09: no completed
 *   tick 06:03Z→07:11Z). Pure rules, the declared settings, a replay of tonight's log, and a simulation of
 *   `withSelfSync` over a fast-moving `main` with tonight's real smoke durations: zero ticks inline (today), ticks
 *   on schedule with the background builder, swaps only between ticks and at most once per window.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILT_IN_BACKGROUND_BUILD_SETTINGS, validateBackgroundBuildSettings, loadBackgroundBuildSettings,
  resolveBackgroundBuild, decideBuilderStart, tickStarvedSmell, builderIsAlive, builderRunFinished,
  spawnBuilder, readBuilderState, writeBuilderState,
} from '../daemon-background-build.mjs';
import { summarizeRebuildResult, parseBuilderArgs, writeBuilderStateIfOwner } from '../daemon-rebuild-builder.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/background-build/fix-daemon-2026-10-09.json'), 'utf8'));
const MIN = 60_000;
const ms = (iso) => Date.parse(iso);

describe('settings — off = today', () => {
  it('built-in default enables no daemon', () => {
    expect(BUILT_IN_BACKGROUND_BUILD_SETTINGS.enabled).toEqual({});
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/review-daemon.mjs' }).enabled).toBe(false);
  });
  it('the committed file turns it on for the fix daemon only', () => {
    const s = loadBackgroundBuildSettings();
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', settings: s }).enabled).toBe(true);
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/review-daemon.mjs', settings: s }).enabled).toBe(false);
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/pass-daemon.mjs', settings: s }).enabled).toBe(false);
  });
  it('env forces on/off and overrides numbers; malformed values keep the file/default', () => {
    const s = { enabled: { 'a.mjs': true }, swapMinIntervalMs: 5 };
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD: '0' } }).enabled).toBe(false);
    expect(resolveBackgroundBuild({ entry: 'b.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD: '1' } }).enabled).toBe(true);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD_SWAP_MIN_INTERVAL_MS: 'x' } }).swapMinIntervalMs).toBe(5);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_TICK_STARVED_SMELL_MS: '0' } }).tickStarvedSmellMs).toBe(0);
    expect(validateBackgroundBuildSettings({ enabled: { 'a/b': true }, buildMinIntervalMs: -1 })).toEqual({ ...BUILT_IN_BACKGROUND_BUILD_SETTINGS });
  });
});

describe('decideBuilderStart — pure', () => {
  const base = { enabled: true, builderAlive: false, lastStartedAtMs: null, swapPending: false, nowMs: 100 * MIN, buildMinIntervalMs: 5 * MIN };
  it('off never starts', () => expect(decideBuilderStart({ ...base, enabled: false })).toEqual({ start: false, reason: 'off' }));
  it('one builder at a time', () => expect(decideBuilderStart({ ...base, builderAlive: true }).reason).toBe('builder-running'));
  it('no new build while a built version waits for the swap', () => expect(decideBuilderStart({ ...base, swapPending: true }).reason).toBe('swap-pending'));
  it('coalesces starts within the window', () => expect(decideBuilderStart({ ...base, lastStartedAtMs: 97 * MIN }).reason).toBe('coalesce'));
  it('due otherwise', () => expect(decideBuilderStart({ ...base, lastStartedAtMs: 90 * MIN })).toEqual({ start: true, reason: 'due' }));
});

describe('tickStarvedSmell — pure', () => {
  const t = 30 * MIN;
  it('off at 0', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 99 * MIN, lastAdoptedAtMs: 50 * MIN, thresholdMs: 0 }).starved).toBe(false));
  it('ticking recently is not starved', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 80 * MIN, nowMs: 90 * MIN, lastAdoptedAtMs: 85 * MIN, thresholdMs: t }).reason).toBe('ticking'));
  it('a long gap WITHOUT an adoption since is some other stall', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 90 * MIN, lastAdoptedAtMs: null, thresholdMs: t }).reason).toBe('no-adoption-since'));
  it('a long gap while rebuilds adopt is starved', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 40 * MIN, lastAdoptedAtMs: 35 * MIN, thresholdMs: t })).toMatchObject({ starved: true, sinceTickMs: 40 * MIN }));
  it('never ticked: measured from first seen', () => expect(tickStarvedSmell({ lastTickDoneAtMs: NaN, firstSeenAtMs: 0, nowMs: 40 * MIN, lastAdoptedAtMs: 1, thresholdMs: t }).starved).toBe(true));
});

describe('builder helpers', () => {
  it('builderIsAlive: unfinished + same host + live pid + younger than the max age', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 100 * MIN, maxAgeMs: 90 * MIN };
    const startedAt = new Date(95 * MIN).toISOString();
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt }, o)).toBe(true);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt, finishedAt: 'x' }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'other', startedAt }, o)).toBe(false);
    expect(builderIsAlive(null)).toBe(false);
  });
  it('builderIsAlive: a stale unfinished record with a live-looking pid is NOT alive (pid reuse after SIGKILL / reboot)', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 300 * MIN, maxAgeMs: 90 * MIN };
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(100 * MIN).toISOString() }, o)).toBe(false);
    // exactly at the bound is still alive; a record whose age cannot be read cannot be bounded, so it is not trusted
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(210 * MIN).toISOString() }, o)).toBe(true);
    expect(builderIsAlive({ pid: 1, host: 'h' }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: 'garbage' }, o)).toBe(false);
  });
  it('the age bound is a declared setting (built-in default, file/env override), not a magic number', () => {
    expect(BUILT_IN_BACKGROUND_BUILD_SETTINGS.builderMaxAgeMs).toBeGreaterThan(30 * MIN);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: { builderMaxAgeMs: 7 } }).builderMaxAgeMs).toBe(7);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', env: { WE_DAEMON_BACKGROUND_BUILD_MAX_AGE_MS: '9' } }).builderMaxAgeMs).toBe(9);
    expect(loadBackgroundBuildSettings().builderMaxAgeMs).toBeGreaterThan(30 * MIN);
  });
  it('summarize + args', () => {
    expect(summarizeRebuildResult({ moved: true, adopted: true, head: 'abc', alerts: [1] })).toEqual({ moved: true, adopted: true, reason: 'adopted', head: 'abc' });
    expect(summarizeRebuildResult(null).reason).toBe('no-result');
    expect(parseBuilderArgs(['--root=/c', '--entry=/c/a.mjs', '--main-only'])).toEqual({ root: '/c', entries: ['/c/a.mjs'], mainOnly: true, maxAgeMs: 0 });
    expect(parseBuilderArgs(['--root=/c', '--max-age-ms=5400000']).maxAgeMs).toBe(5_400_000);
    expect(parseBuilderArgs(['--root=/c', '--max-age-ms=junk']).maxAgeMs).toBe(0);
  });
});

describe('replay — tonight\'s fix-daemon log (2026-10-09)', () => {
  const ev = FIXTURE.events;
  it('BEFORE: the longest gap between completed ticks was over an hour', () => {
    const ticks = ev.filter((e) => e.kind === 'tick-done').map((e) => ms(e.at));
    const gaps = ticks.slice(1).map((v, i) => v - ticks[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(60 * MIN); // 06:03:03 → 07:11:25
  });
  it('the smell fires during the starved window and never while ticks flow', () => {
    let lastTick = null;
    let lastAdopt = null;
    const fired = [];
    for (const e of ev) {
      const now = ms(e.at);
      if (e.kind === 'tick-done') lastTick = now;
      if (e.kind === 'restart') lastAdopt = now; // every restart here followed an adopted rebuild
      // a tickOnce entry point: each boot / restart / finished smoke is where the wrapper evaluates the smell
      if (['boot', 'restart', 'smoke-done', 'rebuild-not-moved'].includes(e.kind)) {
        const s = tickStarvedSmell({ lastTickDoneAtMs: lastTick, firstSeenAtMs: ms(ev[0].at), lastAdoptedAtMs: lastAdopt, nowMs: now, thresholdMs: 30 * MIN });
        if (s.starved) fired.push(e.at);
      }
    }
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((at) => at >= '2026-10-09T06:33' && at <= '2026-10-09T07:11')).toBe(true);
  });
});

// ── simulation: withSelfSync over a fast-moving main, with tonight's real smoke durations ────────────────────────
const SMOKES = FIXTURE.events.filter((e) => e.kind === 'smoke-done').map((e) => e.ms);

/** Drive real `withSelfSync` wrappers, one per daemon process, on a fake clock. */
async function run({ backgroundOn, horizonMs = 3 * 60 * MIN, intervalMs = 2 * MIN, tickMs = 30_000, bootMs = 10_000 }) {
  const world = { clock: 0, head: 0, smokeIdx: 0 };
  const tickDoneAt = [];
  const swaps = [];
  let inTick = false;
  let builder = null;
  let builderStarts = 0;
  const nextSmoke = () => SMOKES[(world.smokeIdx++) % SMOKES.length];
  const mainHead = () => Math.floor(world.clock / (3 * MIN)) + 1;
  const settleBuilder = () => {
    if (builder && !builder.finishedAt && world.clock >= builder.doneAt) { world.head = builder.target; builder.finishedAt = builder.doneAt; }
  };
  const builderApi = {
    read: () => { settleBuilder(); return builder ? { startedAt: new Date(builder.startedAt).toISOString(), finishedAt: builder.finishedAt ?? null } : null; },
    alive: (st) => !!st && !st.finishedAt,
    start: () => { builderStarts += 1; builder = { startedAt: world.clock, doneAt: world.clock + nextSmoke(), target: mainHead() }; return { pid: 1 }; },
  };
  const progress = { read: () => ({}), markSeen: () => {}, markTickDone: () => {}, alert: () => {} };
  const inlineRebuild = vi.fn(async () => {
    const target = mainHead();
    world.clock += nextSmoke();
    world.head = target;
    return { moved: true, adopted: true, head: `h${target}` };
  });
  while (world.clock < horizonMs) {
    world.clock += bootMs;
    settleBuilder();
    const bootClock = world.clock;
    let restarted = false;
    const w = withSelfSync({
      tickOnce: async () => { inTick = true; world.clock += tickMs; settleBuilder(); inTick = false; tickDoneAt.push(world.clock); return { repos: [] }; },
    }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'],
      rebuild: inlineRebuild, readHead: () => `h${world.head}`, readOriginRef: () => null,
      acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({ quarantine: null, adopted: null }),
      diffFiles: () => ['scripts/conveyor/reconcile-fix-dispatch.mjs'], importClosure: () => null,
      now: () => world.clock,
      onRestart: () => { swaps.push({ at: world.clock, uptimeMs: world.clock - bootClock, inTick }); restarted = true; return { restarted: true }; },
      background: backgroundOn ? { enabled: true, swapMinIntervalMs: 10 * MIN, buildMinIntervalMs: 5 * MIN, tickStarvedSmellMs: 30 * MIN } : null,
      builder: builderApi, tickProgress: progress,
    });
    while (!restarted && world.clock < horizonMs) {
      // eslint-disable-next-line no-await-in-loop
      await w.tickOnce();
      if (!restarted) { world.clock += intervalMs; settleBuilder(); }
    }
  }
  return { tickDoneAt, swaps, inlineRebuild, builderStarts };
}

describe('simulation — withSelfSync, main moving every 3 min, tonight\'s smoke durations (A1)', () => {
  it('TODAY (inline rebuild): every process restarts before its first tick — zero ticks in 3 h', async () => {
    const r = await run({ backgroundOn: false });
    expect(r.inlineRebuild).toHaveBeenCalled();
    expect(r.swaps.length).toBeGreaterThan(5);
    expect(r.tickDoneAt).toHaveLength(0);
  });

  it('BACKGROUND: ticks complete every ≤ 3 min, the builder runs off the tick path, swaps only between ticks', async () => {
    const r = await run({ backgroundOn: true });
    expect(r.inlineRebuild).not.toHaveBeenCalled();
    expect(r.builderStarts).toBeGreaterThan(2);
    expect(r.tickDoneAt.length).toBeGreaterThan(50);
    const gaps = r.tickDoneAt.slice(1).map((v, i) => v - r.tickDoneAt[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(3 * MIN);
    // the swap happened (the new version is picked up), never mid-tick, at most once per 10 min
    expect(r.swaps.length).toBeGreaterThan(2);
    expect(r.swaps.every((s) => !s.inTick && s.uptimeMs >= 10 * MIN)).toBe(true);
    // every process completes at least one tick before it swaps (tick-first after restart)
    for (const s of r.swaps) expect(r.tickDoneAt.some((t) => t <= s.at && t > s.at - s.uptimeMs)).toBe(true);
  });

  it('a stale-main refusal in background mode never rebuilds inline', async () => {
    const rebuild = vi.fn(async () => ({ moved: true, adopted: true, head: 'h2' }));
    const start = vi.fn(() => ({ pid: 9 }));
    const w = withSelfSync({ tickOnce: async () => ({ refusals: ['stale'] }) }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/a.mjs'], rebuild,
      readHead: () => 'h1', acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({}),
      hasStaleRefusal: () => true, now: () => 0, onRestart: vi.fn(),
      background: { enabled: true, swapMinIntervalMs: 0, buildMinIntervalMs: 0, tickStarvedSmellMs: 0 },
      builder: { read: () => null, alive: () => false, start }, tickProgress: null,
    });
    await w.tickOnce();
    expect(rebuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a clone re-cloned by the builder runs no children until the builder\'s rebuild on it finished', async () => {
    const tick = vi.fn(async () => ({ repos: [] }));
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/a.mjs'], rebuild: vi.fn(),
      readHead: () => 'h1', acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({}), now: () => 0, onRestart: vi.fn(),
      background: { enabled: true, swapMinIntervalMs: 0, buildMinIntervalMs: 0, tickStarvedSmellMs: 0 },
      builder: { read: () => ({ recloned: true, finishedAt: null }), alive: () => true, start: vi.fn() }, tickProgress: null,
    });
    const r = await w.tickOnce();
    expect(tick).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
  });

  it('the smell is logged on the inline path when ticks starve while rebuilds adopt', async () => {
    const log = { error: vi.fn() };
    const alert = vi.fn();
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/clone', env: {}, log, versions: null, entries: ['/clone/a.mjs'],
      rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      readHead: () => 'h1', acquireRead: () => ({ ok: true }), releaseRead: () => {}, now: () => 40 * MIN, onRestart: vi.fn(),
      readState: () => ({ adopted: { at: new Date(35 * MIN).toISOString() } }),
      background: { enabled: false, tickStarvedSmellMs: 30 * MIN },
      tickProgress: { read: () => ({ lastTickDoneAt: new Date(0).toISOString() }), markSeen: () => {}, markTickDone: () => {}, alert },
    });
    await w.tickOnce();
    expect(log.error.mock.calls.some(([m]) => /SMELL tick-starved — no completed tick for 40 min/.test(m))).toBe(true);
    expect(alert).toHaveBeenCalledWith('tick-starved', expect.objectContaining({ sinceTickMs: 40 * MIN, background: false }), 40 * MIN);
  });
});

// ── review:changes round 1 (PR #4578) ────────────────────────────────────────────────────────────────────────────

/** A background-mode `withSelfSync` over fakes; returns the wrapper plus the spies the repair tests assert on. */
function bgDaemon({ tick = async () => ({ repos: [] }), readState = () => ({}), acquireRead, builderRead = () => null, cloneIdentity, cloneBornAt, readHead = () => 'h1', diffFiles, swapMinIntervalMs = 0 } = {}) {
  const start = vi.fn(() => ({ pid: 7 }));
  const onRestart = vi.fn(() => ({ restarted: true }));
  const tickOnce = vi.fn(tick);
  const w = withSelfSync({ tickOnce }, {
    root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/a.mjs'], rebuild: vi.fn(),
    readHead, acquireRead: acquireRead ?? (() => ({ ok: true })), releaseRead: vi.fn(), readState, now: () => 0, onRestart,
    ...(cloneIdentity ? { cloneIdentity } : {}),
    ...(cloneBornAt ? { cloneBornAt } : {}),
    ...(diffFiles ? { diffFiles, importClosure: () => null } : {}),
    background: { enabled: true, swapMinIntervalMs, buildMinIntervalMs: 0, tickStarvedSmellMs: 0 },
    builder: { read: builderRead, alive: () => false, start }, tickProgress: null,
  });
  return { w, start, onRestart, tickOnce };
}

describe('F1 — every skip path still starts the builder (a quarantined clone must be able to heal)', () => {
  it('quarantined clone: the tick is skipped AND the builder (whose rebuildClone clears the quarantine) starts', async () => {
    const { w, start, tickOnce } = bgDaemon({ readState: () => ({ quarantine: { prevHead: 'p', reason: 'reset-rollback-failed' } }) });
    const r = await w.tickOnce();
    expect(r).toMatchObject({ skipped: true, reason: 'quarantine' });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('read lock refused: the builder still starts', async () => {
    const { w, start, tickOnce } = bgDaemon({ acquireRead: () => ({ ok: false, reason: 'writer-active' }) });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'writer-active' });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('writer-priority yield: the builder still starts', async () => {
    const { w, start } = bgDaemon({ acquireRead: () => ({ ok: false, reason: 'writer-priority' }) });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'writer-priority' });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('a tick() that throws: the error still propagates and the builder still starts', async () => {
    const { w, start } = bgDaemon({ tick: async () => { throw new Error('boom'); } });
    await expect(w.tickOnce()).rejects.toThrow('boom');
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('a completed tick starts it exactly once (no double start from two exit points)', async () => {
    const { w, start } = bgDaemon();
    await w.tickOnce();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('a re-cloned skip starts it exactly once', async () => {
    const { w, start } = bgDaemon({ builderRead: () => ({ recloned: true, finishedAt: null }) });
    await w.tickOnce();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('a restart (the swap) starts no builder: the new process builds after its own first tick', async () => {
    const { w, start, onRestart } = bgDaemon({ readHead: (() => { let n = 0; return () => (n++ === 0 ? 'h1' : 'h2'); })(), diffFiles: () => ['scripts/lib/daemon-self-sync.mjs'] });
    await w.tickOnce();
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('F2 — the re-clone fail-closed flag survives a respawn', () => {
  const withState = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try { return fn({ root: dir, env: { WE_DAEMON_STATE_DIR: join(dir, 'state') } }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const fakeSpawn = () => () => Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
  it('a builder spawned after a recloned record keeps recloned until a builder run finishes on the fresh clone', () => withState(({ root, env }) => {
    writeBuilderState(root, { pid: 1, host: 'h', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), recloned: true, result: { reason: 'clone-recloned' } }, env);
    const next = spawnBuilder({ root, env, spawnFn: fakeSpawn(), log: { error: () => {} } });
    expect(next.recloned).toBe(true);
    expect(readBuilderState(root, env)).toMatchObject({ pid: 4242, finishedAt: null, recloned: true });
  }));
  it('a normal respawn does not invent the flag', () => withState(({ root, env }) => {
    writeBuilderState(root, { pid: 1, host: 'h', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), recloned: false }, env);
    expect(spawnBuilder({ root, env, spawnFn: fakeSpawn(), log: { error: () => {} } }).recloned).toBeUndefined();
  }));
});

describe('F3 — an asynchronous spawn failure never crashes the daemon', () => {
  it('a child that emits \'error\' (ENOENT/EAGAIN) is logged and recorded as a finished failed build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try {
      const env = { WE_DAEMON_STATE_DIR: join(dir, 'state') };
      const child = Object.assign(new EventEmitter(), { pid: undefined, unref: () => {} });
      const log = { error: vi.fn() };
      spawnBuilder({ root: dir, env, spawnFn: () => child, log });
      const err = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
      // an EventEmitter with no 'error' listener THROWS on emit — exactly the uncaught exception that killed the daemon
      expect(() => child.emit('error', err)).not.toThrow();
      expect(log.error.mock.calls.some(([m]) => /spawn node ENOENT/.test(m) && /next tick/.test(m))).toBe(true);
      const st = readBuilderState(dir, env);
      expect(st.finishedAt).toBeTruthy();
      expect(st.result).toMatchObject({ moved: false, adopted: false });
      expect(st.result.reason).toMatch(/^spawn-failed: spawn node ENOENT/);
      expect(builderIsAlive(st)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('F5 — a checkout re-cloned between the pre-lock check and the read lock runs no children', () => {
  it('replaced checkout + builder not finished (its recloned record not yet written): skip under the read lock, builder starts', async () => {
    const ids = ['inode-a', 'inode-a', 'inode-b']; // boot, the pre-lock check (not yet replaced), then under the read lock (replaced)
    const { w, start, tickOnce } = bgDaemon({ cloneIdentity: () => ids.shift() ?? 'inode-b', builderRead: () => ({ pid: 5, finishedAt: null }) });
    const r = await w.tickOnce();
    expect(r).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('replaced checkout + the builder\'s run on it has finished (not re-cloned again): ticks, and keeps ticking while a LATER build runs', async () => {
    let rec = { pid: 5, finishedAt: new Date(1).toISOString(), recloned: false };
    const identities = ['inode-a'];
    const { w, tickOnce } = bgDaemon({ cloneIdentity: () => identities[0], builderRead: () => rec });
    identities[0] = 'inode-b'; // the re-clone happened after boot
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
    rec = { pid: 6, finishedAt: null }; // the next build's smoke is running: the accepted checkout must not starve the ticks again
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(2);
  });
  it('the recloned flag is re-read UNDER the read lock (it can land between the pre-lock read and the lock)', async () => {
    const reads = [{ pid: 5, finishedAt: null }, { pid: 5, finishedAt: null, recloned: true }];
    const { w, tickOnce } = bgDaemon({ builderRead: () => reads.shift() ?? { pid: 5, finishedAt: null, recloned: true } });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
  });
  it('an unchanged checkout is untouched: ticks with an unfinished builder running', async () => {
    const { w, tickOnce } = bgDaemon({ cloneIdentity: () => 'inode-a', builderRead: () => ({ pid: 5, finishedAt: null }) });
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
  // D1 (self-review): a finished record from BEFORE the replacement (a sibling daemon's inline re-clone) proves nothing.
  it('a finished record OLDER than the replaced checkout does not unblock it', async () => {
    const identities = ['inode-a'];
    const { w, tickOnce } = bgDaemon({
      cloneIdentity: () => identities[0], cloneBornAt: () => 5000,
      builderRead: () => ({ pid: 5, finishedAt: new Date(1000).toISOString(), recloned: false, result: { reason: 'up-to-date' } }),
    });
    identities[0] = 'inode-b';
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
  });
  it('a finished record NEWER than the replaced checkout unblocks it', async () => {
    const identities = ['inode-a'];
    const { w, tickOnce } = bgDaemon({
      cloneIdentity: () => identities[0], cloneBornAt: () => 5000,
      builderRead: () => ({ pid: 5, finishedAt: new Date(9000).toISOString(), recloned: false, result: { reason: 'up-to-date' } }),
    });
    identities[0] = 'inode-b';
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
  // D2 (self-review): a spawn that never started, or a builder that hit its deadline, ran no rebuild on the fresh clone.
  it.each([['spawn-failed: spawn node EAGAIN'], ['builder-deadline']])('a record finished as "%s" is not a completed run', async (reason) => {
    const rec = { pid: 5, finishedAt: new Date(9000).toISOString(), result: { moved: false, adopted: false, reason } };
    expect(builderRunFinished(rec)).toBe(false);
    expect(builderRunFinished({ ...rec, result: { reason: 'up-to-date' } })).toBe(true);
    const identities = ['inode-a'];
    const { w, tickOnce } = bgDaemon({ cloneIdentity: () => identities[0], builderRead: () => rec });
    identities[0] = 'inode-b';
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
  });
});

describe('self-review round — stale swapPending, record ownership, future-dated records', () => {
  // D3: HEAD moves (swap deferred => swapPending), then HEAD returns to boot; the flag must not block builders forever.
  it('swapPending is recomputed every tick: a deferred swap that no longer applies does not block the builder', async () => {
    const heads = ['h1', 'h2', 'h1']; // boot, tick 1 (moved, deferred), tick 2 (moved back)
    const { w, start } = bgDaemon({ readHead: () => heads.shift() ?? 'h1', diffFiles: () => ['scripts/lib/daemon-self-sync.mjs'], swapMinIntervalMs: 10 * MIN });
    await w.tickOnce(); // deferred swap: no builder (swap-pending)
    expect(start).not.toHaveBeenCalled();
    await w.tickOnce(); // HEAD is back at boot: the stale flag must have cleared
    expect(start).toHaveBeenCalledTimes(1);
  });
  // D4: a late finish from an expired builder must not mark its successor's record finished.
  it('writeBuilderStateIfOwner refuses to write over a record another pid owns', () => {
    const write = vi.fn();
    expect(writeBuilderStateIfOwner('/c', { x: 1 }, { pid: 10, read: () => ({ pid: 11 }), write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeBuilderStateIfOwner('/c', { x: 1 }, { pid: 10, read: () => ({ pid: 10 }), write })).toBe(true);
    expect(writeBuilderStateIfOwner('/c', { x: 2 }, { pid: 10, read: () => null, write })).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('spawnBuilder hands the builder its own deadline (the daemon\'s trust bound)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try {
      const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { pid: 1, unref: () => {} }));
      spawnBuilder({ root: dir, env: { WE_DAEMON_STATE_DIR: join(dir, 'state') }, spawnFn, log: { error: () => {} }, maxAgeMs: 5_400_000 });
      expect(spawnFn.mock.calls[0][1]).toContain('--max-age-ms=5400000');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // D6: a clock jump back must not keep a stale record young forever.
  it('a future-dated record (beyond clock skew) is not alive', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 100 * MIN, maxAgeMs: 90 * MIN };
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(1000 * MIN).toISOString() }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(101 * MIN).toISOString() }, o)).toBe(true); // small skew is fine
  });
});
