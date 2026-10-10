/**
 * @file scripts/lib/__tests__/review-daemon-first-pass.test.mjs
 * @description Card 5673 — the review daemon's first pass after a restart was slow because its first tick ran the
 *   gated rebuild INLINE (`withSelfSync` awaits `rebuildClone`, live smoke 2.4–7.7 min on a loaded host) and, when
 *   that rebuild adopted, restarted instead of ticking. Live 2026-10-09 (fixture below): boot → first completed
 *   tick took 586 s (20:33Z), 673 s (22:26Z) and 2064 s (23:06Z, five restarts chained by inline smokes), and the
 *   00:24Z boot had not ticked 20 min later. Profiling one cold tick's reads with every write stubbed took ~30 s,
 *   so the read side was never the 10 minutes: the inline rebuild was.
 *
 *   The fix is the background builder the fix daemon already runs (x44lnnt, card 5572): the shipped settings turn
 *   it on for `review-daemon.mjs`, so a restarted review daemon ticks first and the next version builds off the
 *   tick path. Same gated rebuild, same smoke, same swap rule (only between ticks, at most once per window) —
 *   nothing is skipped, only moved off the tick.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackgroundBuildSettings, resolveBackgroundBuild } from '../daemon-background-build.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/background-build/review-daemon-2026-10-09.json'), 'utf8'));
const MIN = 60_000;
const ms = (iso) => Date.parse(iso);
const REVIEW_ENTRY = '/clone/skills-src/conveyor/review-daemon.mjs';

describe('replay — tonight\'s review-daemon log (2026-10-09)', () => {
  const ev = FIXTURE.events;
  const firstTickAfterBoot = () => ev.filter((e) => e.kind === 'boot').map((b) => {
    const t = ev.find((e) => e.kind === 'tick-done' && e.at > b.at);
    return t ? ms(t.at) - ms(b.at) : null;
  });

  it('BEFORE: a restarted review daemon waited ~10 min and up to 34 min for its first completed tick', () => {
    const waits = firstTickAfterBoot().filter((w) => w !== null);
    expect(waits.some((w) => w > 9 * MIN)).toBe(true); // 20:33:41 → 20:43:27 (586 s), the card's case
    expect(Math.max(...waits)).toBeGreaterThan(30 * MIN); // 23:06:41 → 23:41:05 (2064 s)
  });

  it('BEFORE: the long waits are inline rebuild smokes, not the pass itself', () => {
    const smokes = ev.filter((e) => e.kind === 'smoke-done').map((e) => e.ms);
    expect(smokes.length).toBeGreaterThan(2);
    expect(Math.min(...smokes)).toBeGreaterThan(2 * MIN);
  });
});

describe('settings — the review daemon builds off the tick path', () => {
  it('the committed file turns the background build on for review-daemon.mjs', () => {
    const r = resolveBackgroundBuild({ entry: REVIEW_ENTRY, settings: loadBackgroundBuildSettings() });
    expect(r).toMatchObject({ enabled: true, source: 'file' });
  });

  it('the operator can still force it off for one process (env beats file)', () => {
    const r = resolveBackgroundBuild({ entry: REVIEW_ENTRY, settings: loadBackgroundBuildSettings(), env: { WE_DAEMON_BACKGROUND_BUILD: '0' } });
    expect(r.enabled).toBe(false);
  });
});

// ── simulation: real `withSelfSync`, settings resolved from the committed file, tonight's review-daemon smokes ──
const SMOKES = FIXTURE.events.filter((e) => e.kind === 'smoke-done').map((e) => e.ms);

async function run({ background, horizonMs = 3 * 60 * MIN, intervalMs = 2 * MIN, tickMs = 4 * MIN, bootMs = 10_000 }) {
  const world = { clock: 0, head: 0, smokeIdx: 0 };
  const boots = [];
  const tickDoneAt = [];
  const swaps = [];
  let inTick = false;
  let builder = null;
  const nextSmoke = () => SMOKES[(world.smokeIdx++) % SMOKES.length];
  const mainHead = () => Math.floor(world.clock / (3 * MIN)) + 1;
  const settleBuilder = () => {
    if (builder && !builder.finishedAt && world.clock >= builder.doneAt) { world.head = builder.target; builder.finishedAt = builder.doneAt; }
  };
  const builderApi = {
    read: () => { settleBuilder(); return builder ? { startedAt: new Date(builder.startedAt).toISOString(), finishedAt: builder.finishedAt ?? null } : null; },
    alive: (st) => !!st && !st.finishedAt,
    start: () => { builder = { startedAt: world.clock, doneAt: world.clock + nextSmoke(), target: mainHead() }; return { pid: 1 }; },
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
    boots.push(world.clock);
    let restarted = false;
    const bootClock = world.clock;
    const w = withSelfSync({
      tickOnce: async () => { inTick = true; world.clock += tickMs; settleBuilder(); inTick = false; tickDoneAt.push(world.clock); return { repos: [] }; },
    }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: [REVIEW_ENTRY],
      rebuild: inlineRebuild, readHead: () => `h${world.head}`, readOriginRef: () => null,
      acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({ quarantine: null, adopted: null }),
      diffFiles: () => ['skills-src/conveyor/review-daemon.mjs'], importClosure: () => null,
      now: () => world.clock,
      onRestart: () => { swaps.push({ at: world.clock, uptimeMs: world.clock - bootClock, inTick }); restarted = true; return { restarted: true }; },
      // `undefined` = resolve from the committed settings file by entry name — exactly what the live daemon does.
      background, builder: builderApi, tickProgress: progress,
    });
    while (!restarted && world.clock < horizonMs) {
      // eslint-disable-next-line no-await-in-loop
      await w.tickOnce();
      if (!restarted) { world.clock += intervalMs; settleBuilder(); }
    }
  }
  const firstTickWait = boots.map((b, i) => {
    const next = boots[i + 1] ?? Infinity;
    const t = tickDoneAt.find((x) => x > b && x < next);
    return t === undefined ? null : t - b;
  });
  return { boots, tickDoneAt, swaps, inlineRebuild, firstTickWait };
}

describe('simulation — main moving every 3 min, a 4-min pass, tonight\'s smoke durations', () => {
  it('OLD (inline rebuild, settings off): a restarted review daemon restarts again before its first tick', async () => {
    const r = await run({ background: null });
    expect(r.inlineRebuild).toHaveBeenCalled();
    expect(r.firstTickWait.filter((w) => w !== null)).toHaveLength(0);
  });

  it('NEW (committed settings): every restarted process completes its first pass within one pass length, never after a smoke', async () => {
    const r = await run({ background: undefined });
    expect(r.inlineRebuild).not.toHaveBeenCalled();
    expect(r.boots.length).toBeGreaterThan(2); // the swap still happens, so new code is still picked up
    const waits = r.firstTickWait.slice(0, -1); // the last boot may be cut off by the horizon
    expect(waits.every((w) => w !== null && w <= 4 * MIN)).toBe(true);
    expect(r.swaps.every((s) => !s.inTick && s.uptimeMs >= 10 * MIN)).toBe(true);
  });
});
