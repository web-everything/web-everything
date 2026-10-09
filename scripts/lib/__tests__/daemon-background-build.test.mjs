/**
 * @file scripts/lib/__tests__/daemon-background-build.test.mjs
 * @description x44lnnt — the fix daemon's tick starved behind its own inline rebuild (live 2026-10-09: no completed
 *   tick 06:03Z→07:11Z). Pure rules, the declared settings, a replay of tonight's log, and a simulation of
 *   `withSelfSync` over a fast-moving `main` with tonight's real smoke durations: zero ticks inline (today), ticks
 *   on schedule with the background builder, swaps only between ticks and at most once per window.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILT_IN_BACKGROUND_BUILD_SETTINGS, validateBackgroundBuildSettings, loadBackgroundBuildSettings,
  resolveBackgroundBuild, decideBuilderStart, tickStarvedSmell, builderIsAlive,
} from '../daemon-background-build.mjs';
import { summarizeRebuildResult, parseBuilderArgs } from '../daemon-rebuild-builder.mjs';
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
  it('builderIsAlive: unfinished + same host + live pid', () => {
    expect(builderIsAlive({ pid: 1, host: 'h' }, { host: 'h', isAlive: () => true })).toBe(true);
    expect(builderIsAlive({ pid: 1, host: 'h', finishedAt: 'x' }, { host: 'h', isAlive: () => true })).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'other' }, { host: 'h', isAlive: () => true })).toBe(false);
    expect(builderIsAlive(null)).toBe(false);
  });
  it('summarize + args', () => {
    expect(summarizeRebuildResult({ moved: true, adopted: true, head: 'abc', alerts: [1] })).toEqual({ moved: true, adopted: true, reason: 'adopted', head: 'abc' });
    expect(summarizeRebuildResult(null).reason).toBe('no-result');
    expect(parseBuilderArgs(['--root=/c', '--entry=/c/a.mjs', '--main-only'])).toEqual({ root: '/c', entries: ['/c/a.mjs'], mainOnly: true });
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
