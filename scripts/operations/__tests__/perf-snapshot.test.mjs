import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  percentile, midpoint, rootCauseTotals, standardsScope, standardsSplit, ciWallMetrics,
  builderStarvation, deriveFromCoroner, diffSnapshots, formatDiff, tagChange,
  parseStore, pickReferences, planPerfSnapshot, finishPerfSnapshot, PERF_SNAPSHOT_EFFECT,
} from '../perf-snapshot.mjs';
import { backfillBaseline, createPerfSnapshotSinks } from '../perf-snapshot-io.mjs';

const at = (time) => `2026-10-07T${time}:00.000Z`;
const window = { since: at('10:00'), until: at('11:00') };
const m = (v, unit = 'min', source = 'computed') => ({ v, unit, source });
const row = (kind, metrics = {}) => ({ schema: 1, kind, metrics });
const coroner = () => ({
  window,
  sessions: { count: 2, minutes: 30, byKind: { fix: { minutes: 12 } } },
  gate: { minutesInGate: 6, shareInGate: 0.2, verifyLane: { calls: 2, medianMin: 3, p90Min: 5 } },
  admission: { waitMedianSec: 4, waitP90Sec: 9, markers: { gateMedianSec: 15, standardsMedianSec: 10 } },
  errorRates: {
    fixSessions: { count: 1, causes: { pushed: { count: 1, minutes: 12 } } },
    byKind: {
      code: { prsOpened: 2, timeToMerge: { medianMin: 8, p90Min: 10 } },
      'card-only': { prsOpened: 3, timeToMerge: { medianMin: 2, p90Min: 4 } },
    },
  },
  executors: { codex: { runs: 2, roundsPerTask: 1.5, medianMin: 7, p90Min: 9 } },
  changeRequests: { byKind: { code: {
    prs: 2, rounds: 1, findings: 1, minutes: 12,
    records: [{ rounds: [{ round: 1, minutes: 12, findings: [{ hint: null, prevention: 'add a check' }] }] }],
    correlation: [{ attribute: 'builder', effect: 0.5, buckets: [{ value: 'operator-agent', meanExtraRounds: 1.5 }] }],
  } } },
});

async function withTemp(fn) {
  const home = mkdtempSync(join(tmpdir(), 'perf-snapshot-'));
  try {
    const env = { WE_CORONER_NO_EXECUTORS: '1' };
    for (const key of ['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'COORD', 'LANES', 'BACKLOG']) {
      env[`WE_CORONER_${key}`] = join(home, key);
      mkdirSync(env[`WE_CORONER_${key}`]);
    }
    const archive = join(home, 'archive');
    mkdirSync(archive);
    writeFileSync(join(archive, 'coroner-24h.json'), JSON.stringify(coroner()));
    writeFileSync(join(archive, 'coroner-48h.json'), JSON.stringify({
      window: { since: '2026-10-05T11:00:00.000Z', until: window.until },
      changeRequests: coroner().changeRequests,
    }));
    return await fn({ home, env, archive });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('perf-snapshot pure metrics', () => {
  it('uses nearest-rank percentiles and range midpoints', () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([40, 10, NaN, 30, Infinity, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.9)).toBe(40);
    expect(midpoint({ lo: 9, hi: 34 })).toBe(21.5);
    expect(midpoint(7)).toBe(7);
  });

  it('classifies findings by hint or prevention and shares each round’s minutes evenly', () => {
    const totals = rootCauseTotals([{ rounds: [
      { round: 1, minutes: 20, findings: [
        { hint: null, prevention: 'reuse the shared helper' },
        { hint: null, prevention: 'document the missing requirement' },
      ] },
      { round: 2, minutes: 9, findings: [
        { hint: 're-raised', prevention: 'reuse the shared helper' },
        { hint: 'fix-introduced' }, { hint: 'unknown-hint' },
      ] },
      { minutes: 100, findings: [] },
    ] }]);
    expect(totals).toMatchObject({
      reinvented: { findings: 1, minutes: 10 }, checklist: { findings: 1, minutes: 10 },
      're-raised': { findings: 1, minutes: 3 }, 'fix-introduced': { findings: 1, minutes: 3 },
      other: { findings: 1, minutes: 3 },
    });
    expect(Object.values(totals).reduce((sum, x) => sum + x.minutes, 0)).toBe(29);
  });

  it('splits standards markers by scope, deduplicates and respects the window', () => {
    const scoped = "npm run test:unit && npm run check:standards -- --local --files='a.mjs'";
    const unscoped = 'npm run check:standards';
    expect(standardsScope({ suites: scoped })).toBe('scoped');
    expect(standardsScope({ suites: unscoped })).toBe('unscoped');
    expect(standardsScope({ suites: 'npm run test:unit' })).toBeNull();
    const marker = (sha, suites, ms, finishedAt = at('10:30')) => ({
      sha, suites, startedAt: at('10:00'), finishedAt, phases: { standardsMs: ms },
    });
    const first = marker('a', scoped, 9000);
    const metrics = standardsSplit([
      first, { ...first, phases: { standardsMs: 999000 } }, marker('b', scoped, 34000),
      marker('c', unscoped, 113000), marker('d', unscoped, 308000),
      marker('e', scoped, 1000, at('09:59')), marker('f', unscoped, 1000, window.until),
      marker('g', 'npm run test:unit', 1000),
    ], window);
    expect(metrics).toEqual({
      'std.scoped.count': m(2, 'runs'), 'std.scoped.medianSec': m(9, 's'), 'std.scoped.p90Sec': m(34, 's'),
      'std.unscoped.count': m(2, 'runs'), 'std.unscoped.medianSec': m(113, 's'), 'std.unscoped.p90Sec': m(308, 's'),
    });
  });

  it('separates code CI walls, shard timings and card-only runs', () => {
    const job = (name, minutes) => ({ name, ms: minutes * 60000 });
    expect(ciWallMetrics([
      { wallMs: 600000, jobs: [job('test-shard (1)', 2), job('test-shard (2)', 5), job('soak-shard (1)', 3), job('soak-shard (2)', 4), job('test', 1)] },
      { wallMs: 1200000, jobs: [job('test-shard (1)', 7), job('test-shard (2)', 8), job('soak-shard (1)', 6), job('test', 2)] },
      { wallMs: 120000, jobs: [job('standards', 1)] },
    ])).toEqual({
      'ci.sampleRuns': m(3, 'runs'), 'ci.code.runs': m(2, 'runs'),
      'ci.code.wallMedianMin': m(10), 'ci.code.wallP90Min': m(20),
      'ci.slowestShardMedianMin': m(5), 'ci.shardSpreadMedianMin': m(1),
      'ci.slowestSoakMedianMin': m(4), 'ci.testJobMedianMin': m(1),
      'ci.cardOnly.runs': m(1, 'runs'), 'ci.cardOnly.wallMedianMin': m(2),
    });
  });

  it('counts idle free ticks, caps long gaps and excludes busy/outside ticks', () => {
    const tick = (time, extra = {}) => ({ at: at(time), capacity: { free: true }, dispatched: [], inFlight: [], ...extra });
    expect(builderStarvation([
      tick('09:59'), tick('10:00'), tick('10:05'),
      tick('10:30', { inFlight: ['job'] }), tick('10:40', { dispatched: ['job'] }),
      tick('10:50', { capacity: { free: false } }), tick('11:00'),
    ], window, { maxGapMin: 10 })).toEqual({
      'builder.starvedMin': m(15), 'builder.starvedTicks': m(2, 'ticks'), 'builder.ticks': m(5, 'ticks'),
    });
  });

  it('derives named coroner metrics with units and computed provenance', () => {
    const metrics = deriveFromCoroner(coroner());
    expect(metrics).toMatchObject({
      'sessions.minutes': m(30), 'gate.shareInGatePct': m(20, '%'),
      'gate.verifyLane.medianMin': m(3), 'queue.waitP90Sec': m(9, 's'),
      'marker.standardsMedianSec': m(10, 's'), 'fix.pushed.minutes': m(12),
      'fix.handed-to-harness.count': m(0, 'sessions'),
      'prs.code': m(2, 'PRs'), 'prs.cardOnly': m(3, 'PRs'),
      'rc.cause.checklist.findings': m(1, 'findings'), 'rc.cause.checklist.minutes': m(12),
      'pred.builder.operator-agent': m(1.5, 'rounds'), 'exec.codex.runs': m(2, 'runs'),
    });
    for (const value of Object.values(metrics)) {
      expect(value).toEqual({ v: expect.any(Number), unit: expect.any(String), source: 'computed' });
    }
  });
});

describe('comparison and store parsing', () => {
  it('drops noise and missing keys, judges costs and leaves volumes neutral', () => {
    const before = row('baseline', {
      noise: m(100), 'gate.verifyLane.medianMin': m(10), 'ci.testJobMedianMin': m(10),
      'prs.code': m(2, 'PRs'), 'exec.codex.runs': m(2, 'runs'),
      'std.scoped.sec': m({ lo: 10, hi: 30 }, 's', 'opus-report'), onlyBefore: m(1),
    });
    const after = row('snapshot', {
      noise: m(104), 'gate.verifyLane.medianMin': m(8), 'ci.testJobMedianMin': m(12),
      'prs.code': m(4, 'PRs'), 'exec.codex.runs': m(1, 'runs'),
      'std.scoped.sec': m(10, 's'), onlyAfter: m(1),
    });
    const changes = diffSnapshots(before, after);
    expect(changes.map((c) => [c.key, c.verdict])).toEqual([
      ['ci.testJobMedianMin', 'worse'], ['exec.codex.runs', 'neutral'],
      ['gate.verifyLane.medianMin', 'better'], ['prs.code', 'neutral'], ['std.scoped.sec', 'better'],
    ]);
    expect(changes.at(-1)).toMatchObject({ delta: -10, pct: -50, approx: true });
    const merged = [{ number: 12, title: 'verify-lane: scope standards' }, { number: 13, title: 'docs typo' }];
    expect(tagChange('gate.verifyLane.medianMin', merged)).toEqual({ prs: [12], more: 1 });
    const lines = formatDiff('vs baseline', before, after, merged).join('\n');
    expect(lines).toContain('better gate.verifyLane.medianMin: 10 -> 8 min, -20% PRs #12 (+1 others merged)');
    expect(lines).toContain('WORSE  ci.testJobMedianMin: 10 -> 12');
    expect(lines).toContain('moved  prs.code: 2 -> 4');
    expect(lines).toContain('better std.scoped.sec: ~10-30 -> 10 s, -50%');
    expect(formatDiff('vs baseline', null, after, [])).toEqual(['vs baseline', '  (no earlier row to compare with)']);
  });

  it('skips malformed/foreign rows and picks baseline and last snapshot', () => {
    const baseline = row('baseline', { a: m(1) });
    const first = row('snapshot', { a: m(2) });
    const last = row('snapshot', { a: m(3) });
    const text = [baseline, '{bad', { ...first, schema: 2 }, first, null, {}, last]
      .map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
    expect(parseStore(`\n${text}\n`)).toEqual([baseline, first, last]);
    expect(pickReferences(parseStore(text))).toEqual({ baseline, last });
    expect(pickReferences([baseline])).toEqual({ baseline, last: baseline });
    expect(pickReferences([])).toEqual({ baseline: null, last: null });
  });
});

describe('planning and output', () => {
  const read = { archive: '/archive', store: '/store', dir: '/perf', rows: [], archiveFound: true, hasBaseline: false };

  it('refuses missing archives and treats an existing baseline as idempotent', () => {
    const missing = planPerfSnapshot({ ...read, archiveFound: false }, { apply: true, backfill: true });
    expect(missing).toMatchObject({ apply: false, refused: expect.stringContaining('no archived baseline') });
    const existing = planPerfSnapshot({ ...read, hasBaseline: true }, { apply: true, backfill: true });
    expect(existing).toMatchObject({ apply: false, refused: expect.stringContaining('idempotent') });
    expect(finishPerfSnapshot({ run: { verdict: existing }, code: 1, lines: [] }).code).toBe(0);
    expect(finishPerfSnapshot({ run: { verdict: missing }, code: 0, lines: [] }).code).toBe(1);
  });

  it('defaults to 24 hours, accepts 1 and caps at 168 (sub-1 inputs currently default)', () => {
    expect(planPerfSnapshot(read).hours).toBe(24);
    for (const [hours, expected] of [[1, 1], [1.9, 1], [168, 168], [999, 168], [0, 24], [-1, 24], ['bad', 24]]) {
      expect(planPerfSnapshot(read, { hours }).hours).toBe(expected);
    }
  });

  it('prints the dry-run instruction or the applied sink’s lines', () => {
    const dry = finishPerfSnapshot({ run: { verdict: planPerfSnapshot(read) }, code: 0, lines: [] });
    expect(dry.code).toBe(0);
    expect(dry.lines).toHaveLength(1);
    expect(dry.lines[0]).toMatch(/^perf-snapshot: dry run - would: .*Re-run with --apply\.$/);
    const lines = ['sink wrote a snapshot', 'vs baseline'];
    expect(finishPerfSnapshot({ run: {
      verdict: planPerfSnapshot(read, { apply: true }),
      effects: [{ type: PERF_SNAPSHOT_EFFECT, status: 'applied', result: { lines } }],
    }, code: 0, lines: ['adapter output'] })).toEqual({ code: 0, lines });
  });
});

describe('perf-snapshot IO with isolated stores and injected gh', () => {
  it('backfills computed metrics and the three report-sourced standards ranges', () => withTemp(({ archive, env, home }) => {
    const baseline = backfillBaseline({ archive, env, home, gh: null });
    expect(baseline).toMatchObject({ kind: 'baseline', date: '2026-10-07', schema: 1 });
    expect(baseline.metrics['std.scoped.sec']).toEqual(m({ lo: 9, hi: 34 }, 's', 'opus-report'));
    expect(baseline.metrics['rc48.cause.checklist.findings']).toEqual(m(1, 'findings'));
    expect(baseline.metrics['rc48.code.rounds']).toEqual(m(1, 'rounds'));
    const reportKeys = ['std.scoped.sec', 'std.unscoped.sec', 'std.unscoped.ciSec'];
    expect(Object.keys(baseline.metrics).filter((k) => baseline.metrics[k].source === 'opus-report')).toEqual(reportKeys);
    for (const [key, value] of Object.entries(baseline.metrics)) {
      expect(value.source).toBe(reportKeys.includes(key) ? 'opus-report' : 'computed');
    }
  }));

  it('appends a baseline and snapshots, retains raw JSON and compares both references', () => withTemp(async ({ archive, env, home }) => {
    const dir = join(home, 'perf'), store = join(dir, 'snapshots.jsonl');
    const sink = createPerfSnapshotSinks({ env, home, gh: () => null })[PERF_SNAPSHOT_EFFECT];
    const payload = { store, dir, archive, hours: 24, now: '2026-10-08T14:05:00.000Z' };
    await sink({ ...payload, backfill: true });
    const first = await sink({ ...payload, backfill: false });
    const rows = () => parseStore(readFileSync(store, 'utf8'));
    expect(rows().map((r) => r.kind)).toEqual(['baseline', 'snapshot']);
    expect(rows()[1]).toEqual(first.row);
    expect(first.row.takenAt).toBe(payload.now);
    const raw = join(dir, '2026-10-08', 'coroner-24h-1405Z.json');
    expect(existsSync(raw)).toBe(true);
    expect(JSON.parse(readFileSync(raw, 'utf8')).window).toMatchObject({
      since: '2026-10-07T14:05:00.000Z', until: payload.now,
    });
    expect(first.lines.join('\n')).toContain('vs baseline 2026-10-07');
    expect(first.lines).toContain('vs last snapshot: this is the first snapshot after the baseline');
    const second = await sink({ ...payload, backfill: false, now: '2026-10-08T15:05:00.000Z' });
    expect(rows()).toHaveLength(3);
    expect(second.lines).toContain(`vs last snapshot 2026-10-08 (${payload.now})`);
    expect(second.lines.join('\n')).toContain('vs baseline 2026-10-07');
  }));
});
