import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseBuilderTick, foldBuilderTicks, builderStarvedMinutes } from '../../health-builder-ticks.mjs';
import smell, { builderStarvedVerdict } from '../builder-starved.mjs';
import { runHealthTick } from '../../health-watch-core.mjs';

const minute = 60_000;
const now = Date.parse('2026-10-07T10:52:00Z');
let originalLimit;
beforeEach(() => {
  originalLimit = process.env.WE_BUILDER_STARVED_MINUTES;
  delete process.env.WE_BUILDER_STARVED_MINUTES;
});
afterEach(() => {
  if (originalLimit === undefined) delete process.env.WE_BUILDER_STARVED_MINUTES;
  else process.env.WE_BUILDER_STARVED_MINUTES = originalLimit;
});

const record = (at, overrides = {}) => ({
  at: new Date(at).toISOString(),
  timings: {},
  status: 'conveyor · 3 building · 26 preparing · 0 fixing · 0 healing · 400 queued · 1 parked · health ok',
  freeze: { frozen: false },
  inFlight: [],
  dispatched: [],
  prepare: { planned: [], launched: [], inFlight: [] },
  ...overrides,
});
const line = (at, overrides) => JSON.stringify(record(at, overrides));
const liveLines = () => {
  const lines = [];
  const start = Date.parse('2026-10-07T03:45:00Z');
  for (let at = start; at <= Date.parse('2026-10-07T10:51:00Z'); at += 2 * minute) {
    lines.push(line(at, { dispatched: at === start ? [{ num: '4752' }] : [] }));
  }
  return lines;
};
const recentLaunch = () => foldBuilderTicks(null, [
  line(now - 30 * minute, { dispatched: [{ num: '4752' }] }),
  line(now - minute),
].join('\n'));

it('rejects non-tick lines and parses queue size and build plus prepare launches', () => {
  expect(parseBuilderTick('daemon starting')).toBeNull();
  expect(parseBuilderTick('{"timings": invalid JSON')).toBeNull();
  const withoutTimings = record(now);
  delete withoutTimings.timings;
  expect(parseBuilderTick(JSON.stringify(withoutTimings))).toBeNull();
  const withoutPrepare = record(now);
  delete withoutPrepare.prepare;
  expect(parseBuilderTick(JSON.stringify(withoutPrepare))).toBeNull();
  expect(parseBuilderTick(line(now, {
    dispatched: [{ num: '4752' }],
    prepare: { planned: [], launched: [{ num: 4753 }], inFlight: [] },
  }))).toMatchObject({ at: now, queued: 400, launched: ['4752', '4753'], capacityFree: true, frozen: false, prepareLaunched: ['4753'] });
});

it('infers old-record capacity from prepare slots and respects a freeze', () => {
  for (const inFlight of [[], [{ num: '4752' }]]) {
    expect(parseBuilderTick(line(now, {
      prepare: { planned: [], launched: [], inFlight },
    })).capacityFree).toBe(true);
  }
  expect(parseBuilderTick(line(now, {
    prepare: { planned: [], launched: [], inFlight: [{ num: '4752' }, { num: '4753' }] },
  })).capacityFree).toBe(false);
  expect(parseBuilderTick(line(now, { freeze: { frozen: true } }))).toMatchObject({
    capacityFree: false, frozen: true,
  });
});

it('folds successive samples while preserving first sighting and skipping older or equal ticks', () => {
  const firstAt = now - 10 * minute;
  const first = foldBuilderTicks(null, [
    line(firstAt),
    line(firstAt + 2 * minute, { dispatched: [{ num: '4752' }] }),
  ].join('\n'));
  expect(first).toMatchObject({ firstSeenAt: firstAt, lastLaunchAt: firstAt + 2 * minute, lastLaunch: ['4752'], ticksSeen: 2 });
  const second = foldBuilderTicks(first, [
    line(firstAt, { dispatched: [{ num: 'replayed-old' }] }),
    line(firstAt + 2 * minute, { dispatched: [{ num: 'replayed-equal' }] }),
    line(firstAt + 4 * minute, { prepare: { planned: [], launched: [{ num: '4753' }], inFlight: [] } }),
    line(firstAt + 6 * minute),
  ].join('\n'));
  expect(second).toMatchObject({
    firstSeenAt: firstAt, lastLaunchAt: firstAt + 4 * minute, lastLaunch: ['4753'],
    lastTickAt: firstAt + 6 * minute, ticksSeen: 4,
  });
  expect(foldBuilderTicks(second, [line(firstAt), line(second.lastTickAt, {
    dispatched: [{ num: 'replayed' }],
  })].join('\n'))).toEqual(second);
  expect(first.lastLaunch).toEqual(['4752']);
});

it('defaults to 60 minutes and accepts only positive finite overrides', () => {
  expect(builderStarvedMinutes()).toBe(60);
  expect(builderStarvedMinutes({ WE_BUILDER_STARVED_MINUTES: '15' })).toBe(15);
  for (const value of ['invalid', '-15', '0', 'Infinity', '']) {
    expect(builderStarvedMinutes({ WE_BUILDER_STARVED_MINUTES: value })).toBe(60);
  }
});

it('detects the live case of a ticking builder with 400 queued and no launches since 03:45Z', () => {
  const builder = foldBuilderTicks(null, liveLines().join('\n'));
  expect(builder).toMatchObject({ lastTickAt: Date.parse('2026-10-07T10:51:00Z'), ticksSeen: 214 });
  expect(builderStarvedVerdict(builder, { now, limitMinutes: 60 })).toMatchObject({ breach: true, queued: 400, knownSince: true });
  const results = smell.evaluate({}, { now, builder });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    subject: 'build-dispatch-daemon', breach: true,
    measure: { queued: 400, lastLaunch: ['4752'] },
  });
  expect(results[0].measure.idleMinutes).toBeGreaterThanOrEqual(60);
});

it('does not breach for an empty queue, occupied capacity, recent launch or stale tick, and honours a shorter limit', () => {
  const live = liveLines();
  const emptyQueue = record(now);
  emptyQueue.status = emptyQueue.status.replace('400 queued', '0 queued');
  const noCapacity = line(now, {
    capacity: { buildSlots: { claude: 1, external: 3 }, prepareSlots: 2, frozen: false, free: false },
  });
  const builders = [
    foldBuilderTicks(null, [...live, JSON.stringify(emptyQueue)].join('\n')),
    foldBuilderTicks(null, [...live, noCapacity].join('\n')),
    recentLaunch(),
    foldBuilderTicks(null, line(now - 61 * minute, { dispatched: [{ num: '4752' }] })),
  ];
  for (const builder of builders) {
    expect(smell.evaluate({}, { now, builder })).toEqual([expect.objectContaining({ breach: false })]);
  }
  expect(smell.evaluate({}, {
    now, builder: recentLaunch(), env: { WE_BUILDER_STARVED_MINUTES: '20' },
  })).toEqual([expect.objectContaining({ breach: true, measure: expect.objectContaining({ idleMinutes: 30, limitMinutes: 20 }) })]);
});

it('opens a builder-starved episode through runHealthTick using the builder log probe', () => {
  const result = runHealthTick(null, {
    builderLog: { name: 'build-dispatch-daemon', text: liveLines().join('\n') },
  }, [smell], now);
  expect(result.state.builder).toMatchObject({ queued: 400, lastLaunch: ['4752'], lastTickAt: Date.parse('2026-10-07T10:51:00Z') });
  expect(Object.keys(result.state.episodes)).toContain('builder-starved::build-dispatch-daemon');
  expect(result.state.episodes['builder-starved::build-dispatch-daemon']).toMatchObject({
    smell: 'builder-starved', subject: 'build-dispatch-daemon', status: 'open', openedAt: now,
  });
});

it('builder-starved-2: breaches when prepares starve even though one lone build launched (live 16:59Z–18:49Z)', () => {
  const t0 = Date.parse('2026-10-07T16:59:00Z');
  const end = Date.parse('2026-10-07T18:49:00Z');
  const holds = [{ num: '4648', reason: 'prepare-stale' }, { num: '4560', reason: 'needs-prepare' }];
  const capacity = { buildSlots: { claude: 1, external: 3 }, prepareSlots: 2, frozen: false, free: true };
  const lines = [];
  for (let at = t0; at <= end; at += 3 * minute) {
    lines.push(line(at, { capacity, buildHolds: holds, dispatched: at === t0 + 78 * minute ? [{ num: '4688' }] : [] }));
  }
  const builder = foldBuilderTicks(null, lines.join('\n'));
  const v = builderStarvedVerdict(builder, { now: end + minute, limitMinutes: 60 });
  expect(v).toMatchObject({ breach: true, prepareStarved: true });
  const [obs] = smell.evaluate({}, { now: end + minute, builder, env: {} });
  expect(obs.summary).toMatch(/2 cards need a prepare/);
});

it('builder-starved-2: builder-starved notifies even in shadow mode', async () => {
  const { NOTIFY_EVEN_IN_SHADOW } = await import('../../health-smells-notify-list.mjs');
  expect(NOTIFY_EVEN_IN_SHADOW.has('builder-starved')).toBe(true);
});
