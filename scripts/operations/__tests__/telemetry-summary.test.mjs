/**
 * @file telemetry-summary.test.mjs — proof of the `telemetry-summary` operation (backlog `xaxks4j`, epic
 * `xjtmptc`): its declaration (`../telemetry-summary.mjs`) and its io shell (`../telemetry-summary-io.mjs`).
 *
 * Every fs/clock touch below is either INJECTED (`loadFacts`) or exercised against a throwaway temp
 * directory this suite creates and removes itself — it never reads the real `.operations/claude-otel` or
 * `.operations/telemetry` stores, the same discipline `claim-io.test.mjs` uses for `backlog/`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning } from '../engine.mjs';
import { isReadOnlyDeclaration } from '../http-adapter.mjs';
import { importGraph } from './import-graph.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { OPERATIONS } from '../run.mjs';
import {
  telemetrySummaryOperation, TELEMETRY_SUMMARY_OP, shapeFacts,
} from '../telemetry-summary.mjs';
import {
  resolveCollectorRoot, resolveHostRoot, neededCollectorDayKeys, parseJsonlLines, dropPartialFirstLine,
  readTailBytes, readCollectorDay, readHostToday, extractSamplesByName, listRollups,
  extractHourlySamplesFromRollup, readHazardFacts, createTelemetrySummaryReader, utcDayKey, scanFileForMetric,
  scanFileForRecordsByName, readDeliveryTelemetryRecords, DELIVERY_METRIC_NAMES_FOR_DAEMON_REPORT,
} from '../telemetry-summary-io.mjs';
import { PLAN_WEEK_RENEWAL } from '../../lib/telemetry-summary.mjs';

// HERMETIC (xcu4cqf): `createTelemetrySummaryReader` resolves the shared host-sampler root from the checkout's own
// workspace (`resolveHostRoot()` takes no argument), so its `existsSync` would read the REAL
// `<workspace>/.operations/telemetry`. Answer "no such directory" for exactly that path: the host root is then
// deterministically MISSING (what these tests already assumed), whatever the machine holds. Every other path,
// including the collector/host fixtures under tmp, goes to the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const realHostRoot = (p) => typeof p === 'string' && p.endsWith(`${sep}.operations${sep}telemetry`);
  const mocked = { ...actual, existsSync: (p) => (realHostRoot(p) ? false : actual.existsSync(p)) };
  return { ...mocked, default: mocked };
});

const HERE = dirname(fileURLToPath(import.meta.url));

// ── temp-directory scaffolding, cleaned up after every test that uses it ────────────────────────────────

const tmpDirs = [];
function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'telemetry-summary-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// the io shell
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('root resolution', () => {
  it('an env override wins outright, with no existence check', () => {
    expect(resolveCollectorRoot({ env: { OPERATION_CLAUDE_OTEL_DIR: '/anywhere/at/all' } })).toBe('/anywhere/at/all');
  });
  it('resolveHostRoot always names the shared telemetry store', () => {
    expect(resolveHostRoot().endsWith(join('.operations', 'telemetry'))).toBe(true);
  });
});

describe('parseJsonlLines / dropPartialFirstLine — torn-line tolerance', () => {
  it('skips a torn (mid-write) line rather than throwing, and keeps the good ones', () => {
    const text = '{"a":1}\n{"b":2\n{"c":3}\n\n';
    expect(parseJsonlLines(text)).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it('drops a leading partial line only when the read started mid-file', () => {
    expect(dropPartialFirstLine('rtial\n{"a":1}\n', true)).toBe('{"a":1}\n');
    expect(dropPartialFirstLine('{"a":1}\n', false)).toBe('{"a":1}\n');
    // No newline at all in a mid-file read means the whole chunk is one partial line.
    expect(dropPartialFirstLine('no newline here', true)).toBe('');
  });
});

describe('readTailBytes — bounded, tail-only, for `machine.now` (Done when #3)', () => {
  it('reads only the end of a large file, never the whole thing', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'big.jsonl');
    const fd = openSync(path, 'w');
    writeSync(fd, 'START-MARK-DO-NOT-APPEAR\n');
    // Pad well past any reasonable tail bound.
    const line = `{"event":"metric","name":"host.cpu.busy_pct","value":1,"timestamp":"2026-01-01T00:00:00Z"}\n`;
    for (let i = 0; i < 80_000; i += 1) writeSync(fd, line); // ~7.5 MB of padding
    writeSync(fd, '{"event":"metric","name":"host.cpu.busy_pct","value":42,"timestamp":"2026-01-01T00:00:00Z"}\nEND-MARK\n');
    closeSync(fd);

    const text = readTailBytes(path, 64 * 1024); // 64 KB tail
    expect(text).toContain('END-MARK');
    expect(text).not.toContain('START-MARK-DO-NOT-APPEAR');
    // Bounded — nowhere near the file's several-MB size.
    expect(text.length).toBeLessThan(200 * 1024);
  });

  it('reads the whole file when it is smaller than the bound', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'small.jsonl');
    writeFileSync(path, 'START\nEND\n');
    expect(readTailBytes(path, 4 * 1024 * 1024)).toBe('START\nEND\n');
  });
});

describe('readCollectorDay', () => {
  it('returns [] for a day with no file yet, rather than throwing', () => {
    const dir = makeTmpDir();
    expect(readCollectorDay(dir, '2026-09-01')).toEqual([]);
  });
  it('reads and parses a whole day file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '2026-09-01.jsonl'), '{"receivedAt":"2026-09-01T00:00:00Z","name":"x","value":1}\n');
    expect(readCollectorDay(dir, '2026-09-01')).toEqual([{ receivedAt: '2026-09-01T00:00:00Z', name: 'x', value: 1 }]);
  });
});

describe('readHostToday / extractSamplesByName', () => {
  it('filters to metric events and reports the latest timestamp', () => {
    const dir = makeTmpDir();
    const lines = [
      '{"event":"metric","name":"host.cpu.busy_pct","value":10,"timestamp":"2026-09-23T10:00:00Z"}',
      '{"event":"other","name":"ignored","value":0,"timestamp":"2026-09-23T10:05:00Z"}',
      '{"event":"metric","name":"host.cpu.busy_pct","value":20,"timestamp":"2026-09-23T10:10:00Z"}',
    ].join('\n');
    writeFileSync(join(dir, '2026-09-23.jsonl'), `${lines}\n`);
    const out = readHostToday(dir, '2026-09-23', 4 * 1024 * 1024);
    expect(out.records.length).toBe(2);
    expect(out.lastAtMs).toBe(new Date('2026-09-23T10:10:00Z').getTime());
    expect(extractSamplesByName(out.records, 'host.cpu.busy_pct')).toEqual([
      { timestamp: '2026-09-23T10:00:00Z', value: 10 },
      { timestamp: '2026-09-23T10:10:00Z', value: 20 },
    ]);
  });

  it('a not-yet-created today file is no data, not a failure', () => {
    const dir = makeTmpDir();
    const out = readHostToday(dir, '2026-09-23', 1024);
    expect(out).toEqual({ records: [], lastAtMs: null, root: join(dir, '2026-09-23.jsonl') });
  });
});

describe('scanFileForMetric — bounded MEMORY, whole-file, for `machine.todayHourlyBusyPct` (Done when #3)', () => {
  it('finds every matching sample across a file far larger than any tail bound', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'big.jsonl');
    const fd = openSync(path, 'w');
    // An early sample that a 4 MB tail read would never reach.
    writeSync(fd, '{"event":"metric","name":"host.cpu.busy_pct","value":11,"timestamp":"2026-09-23T00:00:00Z"}\n');
    const noise = '{"event":"metric","name":"host.mem.pressure_level","value":1,"timestamp":"2026-09-23T00:00:00Z"}\n';
    for (let i = 0; i < 80_000; i += 1) writeSync(fd, noise); // ~7 MB of a DIFFERENT metric name
    writeSync(fd, '{"event":"metric","name":"host.cpu.busy_pct","value":22,"timestamp":"2026-09-23T12:00:00Z"}\n');
    closeSync(fd);

    const out = scanFileForMetric(path, 'host.cpu.busy_pct', { chunkBytes: 64 * 1024 });
    expect(out).toEqual([
      { timestamp: '2026-09-23T00:00:00Z', value: 11 },
      { timestamp: '2026-09-23T12:00:00Z', value: 22 },
    ]);
  });

  it('tolerates a torn last line (the file still being appended) without throwing', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'torn.jsonl');
    writeFileSync(path, '{"event":"metric","name":"host.cpu.busy_pct","value":5,"timestamp":"2026-09-23T00:00:00Z"}\n'
      + '{"event":"metric","name":"host.cpu.busy_pct","value":9,"timestamp":"2026-09-23T01:00:00');
    expect(scanFileForMetric(path, 'host.cpu.busy_pct')).toEqual([
      { timestamp: '2026-09-23T00:00:00Z', value: 5 },
    ]);
  });

  it('a chunk boundary landing mid-line still parses correctly', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'boundary.jsonl');
    const line1 = '{"event":"metric","name":"host.cpu.busy_pct","value":1,"timestamp":"2026-09-23T00:00:00Z"}\n';
    const line2 = '{"event":"metric","name":"host.cpu.busy_pct","value":2,"timestamp":"2026-09-23T01:00:00Z"}\n';
    writeFileSync(path, line1 + line2);
    // A chunk size that splits `line1` itself, mid-object.
    const out = scanFileForMetric(path, 'host.cpu.busy_pct', { chunkBytes: 30 });
    expect(out).toEqual([{ timestamp: '2026-09-23T00:00:00Z', value: 1 }, { timestamp: '2026-09-23T01:00:00Z', value: 2 }]);
  });
});

describe('scanFileForRecordsByName — FULL records (not just {timestamp,value}), for backlog #4071', () => {
  it('returns the whole record for every metric matching one of the wanted names', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'delivery.jsonl');
    const workerEvent = JSON.stringify({
      event: 'metric', name: 'dispatch.worker.event', kind: 'sampler', value: 1, timestamp: '2026-09-25T00:00:00Z',
      attributes: { session_id: 'sess-a', name: 'review-2625' },
    });
    const throttleEvent = JSON.stringify({
      event: 'metric', name: 'gh.throttle.rate_limited', kind: 'review', value: 1, timestamp: '2026-09-25T00:00:01Z',
      attributes: { op: 'pr view' },
    });
    const ignored = JSON.stringify({ event: 'metric', name: 'host.cpu.busy_pct', value: 5, timestamp: '2026-09-25T00:00:02Z' });
    writeFileSync(path, `${workerEvent}\n${throttleEvent}\n${ignored}\n`);

    const out = scanFileForRecordsByName(path, ['dispatch.worker.event', 'gh.throttle.rate_limited']);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(JSON.parse(workerEvent));
    expect(out[1]).toEqual(JSON.parse(throttleEvent));
  });

  it('accepts a single name string, not only an array', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'delivery.jsonl');
    const rec = { event: 'metric', name: 'gh.throttle.exhausted', kind: 'fix', value: 1, timestamp: '2026-09-25T00:00:00Z' };
    writeFileSync(path, `${JSON.stringify(rec)}\n`);
    expect(scanFileForRecordsByName(path, 'gh.throttle.exhausted')).toEqual([rec]);
  });

  it('skips a torn line and a non-metric event rather than throwing', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'torn.jsonl');
    const good = { event: 'metric', name: 'dispatch.worker.event', value: 1, timestamp: '2026-09-25T00:00:00Z' };
    writeFileSync(path, `${JSON.stringify(good)}\n{"event":"metric","name":"dispatch.worker.event","value":2,"time`);
    expect(scanFileForRecordsByName(path, 'dispatch.worker.event')).toEqual([good]);
  });

  it('a chunk boundary landing mid-line still parses correctly', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'boundary.jsonl');
    const r1 = { event: 'metric', name: 'dispatch.worker.event', value: 1, timestamp: '2026-09-25T00:00:00Z' };
    const r2 = { event: 'metric', name: 'dispatch.worker.event', value: 2, timestamp: '2026-09-25T01:00:00Z' };
    writeFileSync(path, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
    const out = scanFileForRecordsByName(path, 'dispatch.worker.event', { chunkBytes: 20 });
    expect(out).toEqual([r1, r2]);
  });
});

describe('readDeliveryTelemetryRecords — per-day-key reads under a root, for backlog #4071', () => {
  it('reads every wanted record across the given day keys', () => {
    const dir = makeTmpDir();
    const rec1 = { event: 'metric', name: 'dispatch.worker.event', value: 1, timestamp: '2026-09-24T00:00:00Z' };
    const rec2 = { event: 'metric', name: 'gh.throttle.backoff_ms', kind: 'review', value: 500, timestamp: '2026-09-25T00:00:00Z' };
    writeFileSync(join(dir, '2026-09-24.jsonl'), `${JSON.stringify(rec1)}\n`);
    writeFileSync(join(dir, '2026-09-25.jsonl'), `${JSON.stringify(rec2)}\n`);
    const out = readDeliveryTelemetryRecords(dir, ['2026-09-24', '2026-09-25']);
    expect(out).toEqual([rec1, rec2]);
  });

  it('silently skips a day with no raw file (rolled over to .jsonl.gz, or never written)', () => {
    const dir = makeTmpDir();
    expect(readDeliveryTelemetryRecords(dir, ['2026-01-01', '2026-01-02'])).toEqual([]);
  });

  it('is stable with an empty or non-array dayKeys', () => {
    const dir = makeTmpDir();
    expect(readDeliveryTelemetryRecords(dir, [])).toEqual([]);
    expect(readDeliveryTelemetryRecords(dir, undefined)).toEqual([]);
  });
});

describe('DELIVERY_METRIC_NAMES_FOR_DAEMON_REPORT — the closed metric-name set backlog #4071 reads', () => {
  it('names the worker-join metric and every gh.throttle.* kind', () => {
    expect(DELIVERY_METRIC_NAMES_FOR_DAEMON_REPORT).toEqual([
      'dispatch.worker.event', 'gh.throttle.rate_limited', 'gh.throttle.backoff_ms', 'gh.throttle.exhausted',
    ]);
  });
});

describe('listRollups / extractHourlySamplesFromRollup', () => {
  it('parses every rollup, newest day first, skipping a malformed one', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '2026-09-20.rollup.json'), JSON.stringify({ day: '2026-09-20', cores: 12, load1: { p50: 1 } }));
    writeFileSync(join(dir, '2026-09-22.rollup.json'), JSON.stringify({ day: '2026-09-22', cores: 12, load1: { p50: 3 } }));
    writeFileSync(join(dir, '2026-09-21.rollup.json'), 'not json');
    const out = listRollups(dir);
    // The malformed 2026-09-21 file is dropped entirely — it fails JSON.parse, not merely a bad shape.
    expect(out.map((r) => r.dayKey)).toEqual(['2026-09-22', '2026-09-20']);
  });

  it('remaps a rollup\'s hourly capacity buckets into busy-pct samples', () => {
    const rollup = { capacity: { hourly: { '2026-09-22T00:00Z': { hostBusyPct: { p50: 91 } }, '2026-09-22T01:00Z': { hostBusyPct: {} } } } };
    const out = extractHourlySamplesFromRollup(rollup);
    expect(out).toEqual([{ timestamp: '2026-09-22T00:00:00.000Z', value: 91 }]);
  });

  it('is empty for a rollup with no capacity data', () => {
    expect(extractHourlySamplesFromRollup({})).toEqual([]);
    expect(extractHourlySamplesFromRollup(null)).toEqual([]);
  });
});

describe('readHazardFacts (#3739)', () => {
  function plistWith(scriptPath) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.webeverything.claude-otel-collector</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${scriptPath}</string></array>
</dict></plist>`;
  }

  it('a missing plist is no hazard, and is reported as such', () => {
    const out = readHazardFacts({ plistPath: '/does/not/exist.plist' });
    expect(out).toEqual({ plistFound: false, scriptPath: null, scriptExists: null });
  });

  it('finds the script path and reports whether it exists', () => {
    const dir = makeTmpDir();
    const realScript = join(dir, 'real.mjs');
    writeFileSync(realScript, '// exists');
    const plistPath = join(dir, 'com.webeverything.claude-otel-collector.plist');
    writeFileSync(plistPath, plistWith(realScript));
    expect(readHazardFacts({ plistPath })).toEqual({ plistFound: true, scriptPath: realScript, scriptExists: true });

    const goneScript = join(dir, 'gone.mjs');
    const plistPath2 = join(dir, 'other.plist');
    writeFileSync(plistPath2, plistWith(goneScript));
    expect(readHazardFacts({ plistPath: plistPath2 })).toEqual({ plistFound: true, scriptPath: goneScript, scriptExists: false });
  });
});

describe('neededCollectorDayKeys — pure, no fs', () => {
  it('returns sorted, deduplicated UTC day keys spanning the usage window', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const keys = neededCollectorDayKeys(now, PLAN_WEEK_RENEWAL, 'America/New_York');
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length); // deduplicated
    expect([...keys].sort()).toEqual(keys); // sorted
    for (const k of keys) expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Today's own UTC day is always needed (it's in last10).
    expect(keys).toContain(utcDayKey(now));
  });
});

describe('createTelemetrySummaryReader assembles one facts bundle from all the roots above', () => {
  it('produces the shape `shapeFacts` accepts, with a missing host root reported as `missing`', () => {
    const collectorDir = makeTmpDir();
    // no host dir created — resolveHostRoot's real path won't exist under this fake env, but the reader's
    // own existsSync checks are against the REAL resolveHostRoot() (the shared workspace root), which this
    // suite cannot relocate without env support the module does not expose. This test only exercises the
    // collector-root override and the resulting shape; the "missing directory" behavior end-to-end is
    // proven at the operation level below, against an injected `loadFacts`.
    const now = new Date('2026-09-23T12:00:00Z');
    writeFileSync(join(collectorDir, `${utcDayKey(now)}.jsonl`), '');
    const reader = createTelemetrySummaryReader({
      env: { OPERATION_CLAUDE_OTEL_DIR: collectorDir }, now: () => now,
    });
    const facts = reader();
    expect(() => shapeFacts(facts)).not.toThrow();
    expect(facts.sources['claude-usage'].missing).toBe(false);
    expect(facts.sources['claude-usage'].root).toBe(collectorDir);
  });
});

describe('real-mechanism fidelity (#2949 fidelity qualifier) — against a real directory tree, not a double', () => {
  // #2949's own motivation (`we:scripts/lib/operation-io-fidelity.mjs`): an injected stub has no clone
  // geometry and no directory tree, so it cannot fail the way the real filesystem can. `withRealRepo` hands
  // this test a genuine git working tree on disk — used here simply AS a real directory, the same way
  // `claim`'s own fidelity test uses it for a real dirty-file probe — and every read below runs against
  // real files this test wrote, through the SAME functions `createTelemetrySummaryReader` composes.
  it('reads real collector/host/rollup/plist files on disk end to end', async () => {
    await withRealRepo(async ({ root }) => {
      const collectorDir = join(root, 'claude-otel');
      const hostDir = join(root, 'telemetry');
      mkdirSync(collectorDir, { recursive: true });
      mkdirSync(hostDir, { recursive: true });

      const now = new Date('2026-09-23T15:00:00Z');
      const todayUtc = utcDayKey(now);

      writeFileSync(join(collectorDir, `${todayUtc}.jsonl`), `${JSON.stringify({
        receivedAt: now.toISOString(), name: 'claude_code.cost.usage', unit: 'USD', value: 1.5,
        attributes: { model: 'claude-sonnet-5-5', query_source: 'main' },
      })}\n`);
      // An EARLY sample (hour 0) plus enough padding that a small tail bound cannot reach it — this is the
      // exact real-data shape that motivated `scanFileForMetric`: a real run against the actual laptop found
      // only 1 of 8 elapsed ET hours filled before that fix, because the tail read only ever saw the last
      // hour or so of a much larger file.
      const earlyIso = `${todayUtc}T00:00:00.000Z`;
      const hostLines = [JSON.stringify({ event: 'metric', name: 'host.cpu.busy_pct', value: 7, timestamp: earlyIso })];
      const noise = JSON.stringify({ event: 'metric', name: 'host.mem.pressure_level', value: 1, timestamp: earlyIso });
      for (let i = 0; i < 2000; i += 1) hostLines.push(noise); // padding a small tail bound will not cross
      hostLines.push(JSON.stringify({ event: 'metric', name: 'host.cpu.busy_pct', value: 41, timestamp: now.toISOString() }));
      hostLines.push(JSON.stringify({ event: 'metric', name: 'host.sessions.live', value: 3, timestamp: now.toISOString() }));
      hostLines.push(JSON.stringify({ event: 'metric', name: 'host.cpu.count', value: 12, timestamp: now.toISOString() }));
      writeFileSync(join(hostDir, `${todayUtc}.jsonl`), `${hostLines.join('\n')}\n`);
      writeFileSync(join(hostDir, '2026-09-20.rollup.json'), JSON.stringify({
        day: '2026-09-20', cores: 12, load1: { p50: 1, p90: 2, max: 3 },
      }));
      const plistPath = join(root, 'collector.plist');
      const missingScript = join(root, 'does-not-exist.mjs');
      writeFileSync(plistPath, `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key>`
        + `<array><string>/usr/bin/node</string><string>${missingScript}</string></array></dict></plist>`);

      // The full assembled reader, with only the ONE root it can be pointed at overridden — the collector
      // root — driven by real env resolution and a real `existsSync`/`readFileSync` against the files above,
      // not a stub returning canned data. (Its host root is not test-overridable — the host/rollup/hazard
      // mechanics are proven directly below, against the same real `hostDir` fixture, the same way the rest
      // of this test already does for rollups/hazard.)
      const reader = createTelemetrySummaryReader({ env: { OPERATION_CLAUDE_OTEL_DIR: collectorDir }, now: () => now });
      const facts = reader();
      expect(facts.sources['claude-usage'].root).toBe(collectorDir);
      expect(facts.usage.records.length).toBeGreaterThan(0);
      expect(() => shapeFacts(facts)).not.toThrow();

      // The host/rollup/hazard mechanics `createTelemetrySummaryReader` composes, driven directly against
      // the same kind of real files — the real tail-bounded read, the real bounded-memory whole-file scan,
      // the real rollup parse, and the real `plutil`/regex plist read.
      const hostFilePath = join(hostDir, `${todayUtc}.jsonl`);
      // A DELIBERATELY tiny tail bound proves the tail read really is bounded: it sees only the samples near
      // the end of the file, never the early one ~200 KB of padding earlier.
      const tailOut = readHostToday(hostDir, todayUtc, 4096);
      expect(extractSamplesByName(tailOut.records, 'host.cpu.busy_pct')).toEqual([
        { timestamp: now.toISOString(), value: 41 },
      ]);
      // The bounded-MEMORY full scan is what actually reaches the whole day's history — this is the exact
      // real-data gap `scanFileForMetric` closes (a real run against the laptop found only 1 of 8 elapsed ET
      // hours filled before this fix).
      expect(scanFileForMetric(hostFilePath, 'host.cpu.busy_pct')).toEqual([
        { timestamp: earlyIso, value: 7 }, { timestamp: now.toISOString(), value: 41 },
      ]);
      expect(listRollups(hostDir).map((r) => r.dayKey)).toEqual(['2026-09-20']);
      expect(readHazardFacts({ plistPath })).toEqual({ plistFound: true, scriptPath: missingScript, scriptExists: false });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// the declaration
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

function runTelemetrySummary(facts) {
  const declaration = telemetrySummaryOperation({ loadFacts: () => facts });
  const registry = createRegistry();
  registry.register(declaration);
  return {
    declaration,
    run: advanceWhileRunning(startRun({ op: TELEMETRY_SUMMARY_OP, id: 'run-ts-test', input: {}, registry }), { registry }),
  };
}

const NOW_ISO = '2026-09-23T15:00:00Z'; // 11:00 ET

function baseFacts(overrides = {}) {
  return {
    now: new Date(NOW_ISO),
    timezone: 'America/New_York',
    usage: { records: [] },
    machine: {
      busySamples: [{ timestamp: NOW_ISO, value: 37 }],
      sessionSamples: [{ timestamp: NOW_ISO, value: 2 }],
      pressureSamples: [{ timestamp: NOW_ISO, value: 1 }],
      coreSamples: [{ timestamp: NOW_ISO, value: 12 }],
      fallbackCores: null,
      hourlySamples: [{ timestamp: NOW_ISO, value: 37 }],
      rollups: [{ day: '2026-09-22', cores: 12, load1: { p50: 10, p90: 20, max: 30 } }],
    },
    sources: {
      'claude-usage': { lastAtMs: new Date(NOW_ISO).getTime(), missing: false, root: '/roots/claude-usage' },
      'host-sampler': { lastAtMs: new Date(NOW_ISO).getTime(), missing: false, root: '/roots/host-sampler' },
      rollups: { lastAtMs: new Date(NOW_ISO).getTime(), missing: false, root: '/roots/rollups' },
    },
    hazard: { plistFound: true, scriptPath: '/script.mjs', scriptExists: true },
    ...overrides,
  };
}

describe('the operation is REGISTERED — it shipped callable by nothing otherwise (gate-health, PR #1163)', () => {
  it('run.mjs can resolve it', () => {
    expect(Object.keys(OPERATIONS)).toContain(TELEMETRY_SUMMARY_OP);
    expect(typeof OPERATIONS[TELEMETRY_SUMMARY_OP]).toBe('function');
  });
});

describe('is read-only and GET-shaped, and reaches neither a node: specifier nor its own io module', () => {
  it('both steps are `compute`', () => {
    expect(isReadOnlyDeclaration(runTelemetrySummary(baseFacts()).declaration)).toBe(true);
  });

  it('the declaration\'s import graph holds no `node:` specifier and cannot reach the io module', () => {
    const { files, external } = importGraph(resolve(HERE, '..', 'telemetry-summary.mjs'));
    expect(external.filter((s) => s.startsWith('node:'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('telemetry-summary-io.mjs'))).toEqual([]);
  });
});

describe('shapeFacts refuses a malformed reader shape', () => {
  it('needs an object', () => {
    expect(() => shapeFacts(null)).toThrow(/must return an object/);
  });
  it('needs a valid `now`', () => {
    expect(() => shapeFacts({ now: 'not-a-date', timezone: 'America/New_York', sources: {} })).toThrow(/valid `now`/);
  });
  it('needs a `timezone`', () => {
    expect(() => shapeFacts({ now: new Date(), sources: {} })).toThrow(/timezone/);
  });
  it('needs `sources`', () => {
    expect(() => shapeFacts({ now: new Date(), timezone: 'America/New_York' })).toThrow(/sources/);
  });
});

describe('the assembled snapshot', () => {
  it('has the full v1 wire shape (Done when #1)', () => {
    const { run } = runTelemetrySummary(baseFacts());
    const snap = run.findings.snapshot;
    for (const key of ['v', 'observedAt', 'timezone', 'week', 'today', 'last10', 'machine', 'sources', 'hazards', 'degraded']) {
      expect(snap).toHaveProperty(key);
    }
    expect(snap.v).toBe(1);
    expect(snap.timezone).toBe('America/New_York');
    expect(snap.observedAt).toBe(new Date(NOW_ISO).toISOString());
    expect(snap.machine.cores).toBe(12);
    expect(snap.machine.now).toEqual({ busyPct: 37, claudeSessions: 2, memPressure: 'normal' });
    expect(snap.machine.todayHourlyBusyPct.length).toBe(24);
    expect(snap.machine.days.length).toBe(1);
    expect(snap.sources.map((s) => s.id)).toEqual(['claude-usage', 'host-sampler', 'rollups']);
    expect(snap.hazards).toEqual([]);
    expect(snap.degraded).toEqual([]);
  });

  it('names a source `missing` and in `degraded` while the rest still renders (Done when #2)', () => {
    const facts = baseFacts({
      sources: {
        'claude-usage': { lastAtMs: new Date(NOW_ISO).getTime(), missing: false, root: '/roots/claude-usage' },
        'host-sampler': { missing: true, root: '/does/not/exist' },
        rollups: { lastAtMs: new Date(NOW_ISO).getTime(), missing: false, root: '/roots/rollups' },
      },
    });
    const { run } = runTelemetrySummary(facts);
    const snap = run.findings.snapshot;
    expect(snap.degraded).toEqual(['host-sampler']);
    expect(snap.sources.find((s) => s.id === 'host-sampler').state).toBe('missing');
    // The rest of the snapshot still renders — machine/week/today are computed from whatever WAS read.
    expect(snap.machine.now.busyPct).toBe(37);
    expect(snap.week).toBeTruthy();
    expect(snap.today).toBeTruthy();
  });

  it('flags the collector-restart hazard only when the plist\'s script path does not exist (Done when #2)', () => {
    const present = runTelemetrySummary(baseFacts({ hazard: { plistFound: true, scriptPath: '/x.mjs', scriptExists: true } }));
    expect(present.run.findings.snapshot.hazards).toEqual([]);

    const absent = runTelemetrySummary(baseFacts({ hazard: { plistFound: true, scriptPath: '/x.mjs', scriptExists: false } }));
    expect(absent.run.findings.snapshot.hazards).toEqual([{ id: 'collector-restart', ref: 'WE #3739' }]);

    const noPlist = runTelemetrySummary(baseFacts({ hazard: { plistFound: false, scriptPath: null, scriptExists: null } }));
    expect(noPlist.run.findings.snapshot.hazards).toEqual([]);
  });

  it('names each root it read (Done when #4)', () => {
    const { run } = runTelemetrySummary(baseFacts());
    const roots = Object.fromEntries(run.findings.snapshot.sources.map((s) => [s.id, s.root]));
    expect(roots).toEqual({
      'claude-usage': '/roots/claude-usage', 'host-sampler': '/roots/host-sampler', rollups: '/roots/rollups',
    });
  });

  it('stays comfortably under the 64 KB wire cap on a realistic-sized fixture', () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      receivedAt: new Date(Date.now() - i * 3600_000).toISOString(),
      name: 'claude_code.cost.usage', unit: 'USD', value: 0.5,
      attributes: { model: 'claude-sonnet-5-5', query_source: 'main' },
    }));
    const { run } = runTelemetrySummary(baseFacts({ usage: { records } }));
    const bytes = Buffer.byteLength(JSON.stringify(run.findings.snapshot), 'utf8');
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
