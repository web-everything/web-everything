import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayWindow, classifyPaths, snapshot, writeHistory, backfillDates, protocolProgress, collectMerged, resolveSettings, collectDay, collectAgreement, main } from '../delivery-metrics.mjs';

const settings = { delivery: { metrics: { deliveryPaths: ['scripts/conveyor/', 'scripts/operations/'], protocols: [] } } };
const available = rows => ({ rows, source: 'fixture' });
const at = '2026-10-16T16:00:00Z';
const inputs = () => ({
  prs: available([
    { repo: 'we', number: 1, createdAt: '2026-10-16T06:00:00Z', mergedAt: at, files: ['scripts/operations/run.mjs'] },
    { repo: 'we', number: 2, createdAt: '2026-10-15T20:00:00Z', mergedAt: at, files: ['src/index.njk'] },
    { repo: 'frontierui', number: 3, createdAt: '2026-10-16T11:00:00Z', mergedAt: at, files: ['src/app.ts'] },
    { repo: 'we', number: 4, createdAt: at, mergedAt: '2026-10-17T04:00:00Z', files: [] },
  ]),
  fixes: available([{ repo: 'we', pr: 1, kind: 'fix', at }, { repo: 'we', pr: 1, kind: 'fix', at }, { repo: 'we', pr: 1, kind: 'outcome', at }]),
  needsYou: available([{ at: '2026-10-15T23:00:00Z', repo: 'we', pr: 1, head: 'a', kind: 'needs-you' },
    { at, repo: 'we', pr: 1, head: 'a', kind: 'cleared', was: 'needs-you' },
    { at, repo: 'we', pr: 2, head: 'a', kind: 'needs-you' }]),
  agreement: available([{ at, status: 'agree' }, { at, status: 'disagree', direction: 'ledger-clears-label-holds' }]),
  incidents: available([{ at }]), restarts: available([{ at, kind: 'restart' }, { at, kind: 'crash' }]),
  sessions: available([{ at, provider: 'Claude' }, { at, provider: 'Codex' }, { at, provider: 'Gemini' }]),
});
const measures = row => Object.fromEntries(row.measures.map(m => [m.key, m]));

describe('delivery metrics acceptance', () => {
  it('fixture ET day produces delivery measures and explicit denominators', () => {
    const row = snapshot({ date: '2026-10-16', inputs: inputs(), settings });
    expect(row.schemaVersion).toBe(1);
    const m = measures(row);
    expect(m['throughput.total'].value).toBe(3);
    expect(m['throughput.we.delivery'].value).toBe(1);
    expect(m['throughput.we.product'].value).toBe(1);
    expect(m['throughput.frontierui.product'].value).toBe(1);
    expect(m['lead-time.p50'].value).toBe(10);
    expect(m['lead-time.p90'].value).toBe(20);
    expect(m['fix-rounds.mean']).toMatchObject({ value: 2 / 3, n: 3 });
    expect(m['needs-you.episodes'].value).toBe(1);
    expect(m['needs-you.wait.p50'].value).toBe(17);
    expect(m['verdict-ledger.agreement'].value).toBe(50);
    expect(m['verdict-ledger.unsafe'].value).toBe(1);
    expect(m['coroner.incidents'].value).toBe(1);
    expect(m['daemon.restarts'].value).toBe(1);
    expect(m['daemon.crashes'].value).toBe(1);
    for (const p of ['claude', 'codex', 'gemini']) expect(m[`sessions.${p}`].value).toBe(1);
    for (const metric of row.measures) expect(metric).toHaveProperty('source');
  });
  it('missing or incomplete sources produce null with a reason, empty samples do not imply a latency of zero', () => {
    const row = snapshot({ date: '2026-10-16', inputs: { prs: available([]), fixes: { source: 'fixture', reason: 'truncated' } }, settings });
    const m = measures(row);
    expect(m['throughput.total'].value).toBe(0);
    expect(m['lead-time.p50']).toMatchObject({ value: null, n: 0, reason: expect.any(String) });
    expect(m['fix-rounds.mean']).toMatchObject({ value: null, reason: 'truncated' });
    expect(m['sessions.claude']).toMatchObject({ value: null, reason: expect.any(String) });
  });
  it('classifies mixed changes as product, all delivery paths as delivery, unknown paths as unknown', () => {
    expect(classifyPaths(['scripts/conveyor/x.mjs'], settings.delivery.metrics.deliveryPaths)).toBe('delivery');
    expect(classifyPaths(['scripts/conveyor/x.mjs', 'docs/a.md'], settings.delivery.metrics.deliveryPaths)).toBe('product');
    expect(classifyPaths(null, [])).toBe('unknown');
    expect(classifyPaths([], [])).toBe('unknown');
  });
  it('uses ET midnight and half-open boundaries across both DST transitions', () => {
    expect(dayWindow('2026-03-08')).toEqual({ since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T04:00:00.000Z' });
    expect(dayWindow('2026-11-01')).toEqual({ since: '2026-11-01T04:00:00.000Z', until: '2026-11-02T05:00:00.000Z' });
    expect(() => dayWindow('2026-02-30')).toThrow();
    expect(backfillDates('2026-03-09', 3)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(() => backfillDates('2026-03-09', -1)).toThrow();
  });
  it('replaces a date atomically, preserves other dates, refuses corrupt history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-metrics-'));
    try {
      const file = join(dir, 'delivery-metrics.jsonl');
      writeHistory(file, [{ date: '2026-10-15', schemaVersion: 1 }]);
      writeHistory(file, [{ date: '2026-10-16', schemaVersion: 1, measures: [] }]);
      writeHistory(file, [{ date: '2026-10-16', schemaVersion: 1, measures: [1] }]);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows).toHaveLength(2);
      expect(rows[1].measures).toEqual([1]);
      writeFileSync(file, 'broken\n');
      expect(() => writeHistory(file, [{ date: '2026-10-16' }])).toThrow();
      expect(readFileSync(file, 'utf8')).toBe('broken\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports proposed, defined, fixtures and live only from declared evidence, without importing modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-protocols-'));
    try {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/core.mjs'), 'throw new Error("never execute");\nexport function decide() {}');
      writeFileSync(join(dir, 'rules/replay.mjs'), 'it("case", () => {});');
      writeFileSync(join(dir, 'rules/daemon.mjs'), 'decide(facts)');
      const base = { id: 'p', rules: [{ path: 'rules/core.mjs', contains: 'export function decide' }] };
      const report = protocols => protocolProgress(protocols, { root: dir });
      expect(report([{ id: 'proposed', card: '5461' }])[0]).toMatchObject({ stage: 'proposed', ruleCount: 0, fixtureCount: 0 });
      expect(report([base])[0]).toMatchObject({ stage: 'defined', ruleCount: 1 });
      const fixture = { ...base, fixtures: [{ path: 'rules/replay.mjs', contains: 'it(' }] };
      expect(report([fixture])[0]).toMatchObject({ stage: 'fixtures', fixtureCount: 1 });
      expect(report([{ ...fixture, callers: [{ path: 'rules/daemon.mjs', contains: 'decide(' }] }])[0].stage).toBe('live');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('paginates GitHub and refuses partial PR or file lists', () => {
    const calls = [];
    const gh = args => { calls.push(args); return args[1].includes('/files?') ? [{ filename: 'src/a.ts' }] : args[1].includes('/pulls/') ? { created_at: at, merged_at: at } : { items: [{ number: 1, created_at: at }], total_count: 1, incomplete_results: false }; };
    expect(collectMerged('we', dayWindow('2026-10-16'), gh).rows[0].files).toEqual(['src/a.ts']);
    expect(calls).toHaveLength(3);
    expect(collectMerged('we', dayWindow('2026-10-16'), () => null)).toMatchObject({ reason: expect.any(String) });
  });
  it('reads daily drain shadow history and treats ledger-clears-label-holds as unsafe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-shadow-'));
    try {
      const readShadow = () => ({ corrupt: 0, runs: [
        { input: { at, schema: 2 }, findings: { rows: [{ status: 'agree' }, { status: 'disagree', direction: 'ledger-clears-label-holds' }, { status: 'disagree', direction: 'ledger-holds-label-clears' }], rowsTruncated: false } },
        { input: { at: '2026-10-17T04:00:00Z' }, findings: { rows: [{ status: 'agree' }] } },
      ] });
      const agreement = collectAgreement('2026-10-16', { env: { WE_SHARED_RUNS_DIR: dir }, readShadow });
      const m = measures(snapshot({ date: '2026-10-16', inputs: { agreement }, settings }));
      expect(m['verdict-ledger.agreement']).toMatchObject({ value: 100 / 3, n: 3 });
      expect(m['verdict-ledger.unsafe'].value).toBe(1);
      const truncated = collectAgreement('2026-10-16', { env: { WE_SHARED_RUNS_DIR: dir }, readShadow: () => ({ corrupt: 1, runs: [] }) });
      expect(truncated).toMatchObject({ reason: expect.stringContaining('incomplete') });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects malformed local journals and a capped session census instead of reporting partial totals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-inputs-'));
    try {
      writeFileSync(join(dir, 'incidents.jsonl'), 'not json\n');
      const day = await collectDay('2026-10-16', { env: { WE_COORDINATION_ROOT: dir, WE_FIX_LOOP_LEDGER: join(dir, 'fix.jsonl'), WE_NEEDS_YOU_FEED: join(dir, 'needs-you-events.jsonl') },
        settings: { delivery: { metrics: { sources: { incidents: 'incidents.jsonl' } } } },
        gh: () => null, readShadow: () => ({ runs: [], corrupt: 0 }),
        coroner: () => ({ sources: { jobs: { found: false }, archive: { found: false }, codexSessions: { found: true, count: 600 } }, executorRuns: { codex: Array.from({ length: 600 }, () => ({ at })) }, sessions: [] }),
      });
      const m = measures(snapshot({ date: '2026-10-16', inputs: day, settings }));
      expect(m['coroner.incidents']).toMatchObject({ value: null, reason: expect.stringContaining('malformed') });
      expect(m['sessions.codex']).toMatchObject({ value: null, reason: expect.stringContaining('cap') });
      expect(m['sessions.gemini']).toMatchObject({ value: null, reason: expect.any(String) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('resolves cascade settings with sources and dry-run backfill never writes', async () => {
    expect(resolveSettings({ env: { WE_DELIVERY_METRICS_ENABLED: 'false' }, file: settings }).enabled).toEqual({ value: false, source: 'env' });
    const output = [], collected = [];
    await main(['--backfill=2', '--dry-run', '--json'], { now: new Date('2026-10-17T16:00:00Z'), settings,
      collect: date => { collected.push(date); return inputs(); }, output: x => output.push(x), log: () => {},
      write: () => { throw new Error('dry-run wrote'); } });
    expect(collected).toEqual(['2026-10-15', '2026-10-16']);
    expect(JSON.parse(output[0])).toHaveLength(2);
  });
});
