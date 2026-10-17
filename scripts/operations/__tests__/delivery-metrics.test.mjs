import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayWindow, classifyPaths, snapshot, writeHistory, backfillDates, protocolProgress, collectMerged, resolveSettings, collectDay, collectAgreement, main } from '../delivery-metrics.mjs';
import { collectExecutorLogs } from '../coroner-executors.mjs';

// Vitest can snapshot named builtin imports before syncBuiltinESMExports runs.
// Forward both import styles through the same real fs object so shared readers
// and the lock helper observe the spies, while all filesystem operations stay real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    ...Object.fromEntries(['openSync', 'closeSync', 'readSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync']
      .map(key => [key, (...args) => actual.default[key](...args)])),
  };
});

const traceFs = () => {
  for (const key of ['openSync', 'closeSync', 'readSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync']) vi.spyOn(fs, key);
};
afterEach(() => vi.restoreAllMocks());

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
const emptyCoroner = () => ({ sources: { jobs: { found: false }, archive: { found: false }, codexSessions: { found: false } }, sessions: [] });
const localOptions = dir => ({ env: { WE_COORDINATION_ROOT: dir, WE_FIX_LOOP_LEDGER: join(dir, 'fix.jsonl'), WE_NEEDS_YOU_FEED: join(dir, 'needs-you-events.jsonl') }, settings,
  gh: () => ({ items: [], total_count: 0, incomplete_results: false }), readShadow: () => ({ runs: [], corrupt: 0 }), coroner: emptyCoroner });

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
    const query = new URL(calls[0][1], 'https://api.github.com/').searchParams.get('q');
    expect(query).toBe('repo:web-everything/web-everything is:pr is:merged merged:2026-10-16T04:00:00.000Z..2026-10-17T04:00:00.000Z');
    expect(collectMerged('we', dayWindow('2026-10-16'), () => null)).toMatchObject({ reason: expect.any(String) });
  });
  it('paginates search and files, filters inclusive search endpoints to the half-open day', () => {
    const window = dayWindow('2026-10-16'), calls = [];
    const gh = args => {
      const url = new URL(args[1], 'https://api.github.com/'); calls.push(url);
      if (url.pathname === '/search/issues') {
        expect(url.searchParams.get('q')).toBe(`repo:web-everything/web-everything is:pr is:merged merged:${window.since}..${window.until}`);
        return { total_count: 101, incomplete_results: false, items: Number(url.searchParams.get('page')) === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [{ number: 101 }] };
      }
      const number = Number(url.pathname.split('/')[5]);
      if (url.pathname.endsWith('/files')) return number === 1 && url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ filename: `scripts/operations/${i}.mjs` })) : [{ filename: 'scripts/operations/last.mjs' }];
      return { created_at: window.since, merged_at: number === 101 ? window.until : window.since, changed_files: number === 1 ? 101 : 1 };
    };
    const prs = collectMerged('we', window, gh);
    expect(prs.rows).toHaveLength(100);
    expect(prs.rows[0].files).toHaveLength(101);
    expect(calls.filter(url => url.pathname === '/search/issues').map(url => url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(calls.some(url => url.pathname.endsWith('/1/files') && url.searchParams.get('page') === '2')).toBe(true);
    expect(measures(snapshot({ date: '2026-10-16', inputs: { prs }, settings }))['throughput.total'].value).toBe(100);
  });
  it.each(['incomplete', 'changing total', 'short page', 'duplicate', 'missing detail', 'search cap'])('rejects %s search results', mode => {
    let page = 0;
    const gh = args => {
      if (args[1].startsWith('search/')) {
        page++;
        if (mode === 'incomplete') return { items: [], total_count: 0, incomplete_results: true };
        if (mode === 'search cap') return { items: [], total_count: 1001 };
        if (mode === 'changing total') return { items: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [], total_count: page === 1 ? 101 : 102 };
        return { items: mode === 'duplicate' ? [{ number: 1 }, { number: 1 }] : [{ number: 1 }], total_count: 2 };
      }
      if (mode === 'missing detail') return null;
      return args[1].includes('/files?') ? [] : { created_at: at, merged_at: at, changed_files: 0 };
    };
    expect(collectMerged('we', dayWindow('2026-10-16'), gh)).toMatchObject({ reason: expect.any(String) });
  });
  it.each(['page failure', 'changed_files mismatch', 'file page cap'])('marks files unknown on %s', mode => {
    const gh = args => {
      if (args[1].startsWith('search/')) return { items: [{ number: 1 }], total_count: 1 };
      if (args[1].includes('/files?')) return mode === 'page failure' && args[1].endsWith('page=2') ? null : Array.from({ length: mode === 'changed_files mismatch' ? 1 : 100 }, () => ({ filename: 'scripts/operations/x.mjs' }));
      return { created_at: at, merged_at: at, changed_files: mode === 'changed_files mismatch' ? 2 : 100 };
    };
    const prs = collectMerged('we', dayWindow('2026-10-16'), gh);
    expect(prs.rows[0].files).toBeNull();
    const m = measures(snapshot({ date: '2026-10-16', inputs: { prs }, settings }));
    expect(m['throughput.we.unknown'].value).toBe(1);
    expect(m['throughput.we.delivery'].value).toBe(0);
  });
  it('coverage uses the full decision census, including unprotocolled events', () => {
    const row = snapshot({ date: '2026-10-16', settings: { delivery: { metrics: { protocols: [{ id: 'p' }] } } }, inputs: { decisions: available([
      { at, protocol: 'p' }, { at, protocol: null }, { at, protocol: 'other' }, { at: '2026-10-17T04:00:00Z', protocol: 'p' },
    ]) } });
    expect(measures(row)['delivery-protocols.coverage']).toMatchObject({ value: 100 / 3, n: 3 });
  });
  it('every emitted measure has a non-null fixture assertion', () => {
    const census = { ...inputs(), decisions: available([{ at, protocol: null }]) };
    const row = snapshot({ date: '2026-10-16', inputs: census, settings });
    const expected = {
      'throughput.total': 3, 'throughput.we.product': 1, 'throughput.we.delivery': 1, 'throughput.we.unknown': 0,
      'throughput.frontierui.product': 1, 'throughput.frontierui.delivery': 0, 'throughput.frontierui.unknown': 0,
      'throughput.plateau-app.product': 0, 'throughput.plateau-app.delivery': 0, 'throughput.plateau-app.unknown': 0,
      'lead-time.p50': 10, 'lead-time.p90': 20, 'fix-rounds.mean': 2 / 3, 'needs-you.episodes': 1, 'needs-you.wait.p50': 17,
      'verdict-ledger.agreement': 50, 'verdict-ledger.unsafe': 1, 'coroner.incidents': 1, 'daemon.restarts': 1, 'daemon.crashes': 1,
      'sessions.claude': 1, 'sessions.codex': 1, 'sessions.gemini': 1, 'delivery-protocols.coverage': 0,
    };
    expect(Object.fromEntries(row.measures.map(m => [m.key, m.value]))).toEqual(expected);
  });
  it('fix rounds include only eligible pre-merge attempts', () => {
    const data = inputs();
    data.fixes = available([{ repo: 'we', pr: 1, kind: 'ci-heal', at: '2026-10-15T00:00:00Z' },
      { repo: 'we', pr: 1, kind: 'fix', at }, { repo: 'we', pr: 1, kind: 'fix', at: '2026-10-16T17:00:00Z' },
      { repo: 'frontierui', pr: 1, kind: 'fix', at }, { repo: 'we', pr: 99, kind: 'fix', at }, { repo: 'we', pr: 1, kind: 'outcome', at }]);
    expect(measures(snapshot({ date: '2026-10-16', inputs: data, settings }))['fix-rounds.mean']).toMatchObject({ value: 2 / 3, n: 3 });
  });
  it('wait pairing isolates repo, PR, head and episode kind', () => {
    const start = { at: '2026-10-15T23:00:00Z', repo: 'we', pr: 1, head: 'a', kind: 'needs-you' };
    const clear = { ...start, at, kind: 'cleared', was: 'needs-you' };
    const needsYou = available([clear, { ...clear, repo: 'frontierui' }, { ...clear, pr: 2 }, { ...clear, head: 'b' }, { ...clear, was: 'other' }, start, { ...start, at, pr: 3 }]);
    expect(measures(snapshot({ date: '2026-10-16', inputs: { needsYou }, settings }))['needs-you.wait.p50']).toMatchObject({ value: 17, n: 1 });
  });
  it('agreement includes unreadable comparisons and excludes transient rows', () => {
    const agreement = available([{ at, status: 'agree' }, { at, status: 'disagree' }, { at, status: 'unreadable' }, { at, status: 'transient' }]);
    expect(measures(snapshot({ date: '2026-10-16', inputs: { agreement }, settings }))['verdict-ledger.agreement']).toMatchObject({ value: 100 / 3, n: 3 });
  });
  it('counts valid JSON fixture files and requires every preceding protocol evidence level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-protocol-levels-'));
    try {
      mkdirSync(join(dir, 'fixtures'));
      for (const [name, text] of [['a.json', '{}'], ['b.json', 'invalid'], ['c.json', '[]'], ['d.txt', '{}'], ['rule.mjs', 'rule'], ['caller.mjs', 'caller']]) writeFileSync(join(dir, name.endsWith('.mjs') ? name : `fixtures/${name}`), text);
      const base = { id: 'p', rules: [{ path: 'rule.mjs' }], fixtureDirectory: 'fixtures', callers: [{ path: 'caller.mjs' }] };
      const report = p => protocolProgress([p], { root: dir })[0];
      expect(report(base)).toMatchObject({ stage: 'live', ruleCount: 1, fixtureCount: 2, callerCount: 1 });
      expect(report({ ...base, rules: [...base.rules, { path: 'missing.mjs' }] }).stage).toBe('proposed');
      expect(report({ ...base, fixtureDirectory: 'missing' }).stage).toBe('defined');
      expect(report({ ...base, callers: [] }).stage).toBe('fixtures');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects absolute, parent-traversal and symlink paths in evidence and journal sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-paths-'));
    try {
      const root = join(dir, 'root'); mkdirSync(root); mkdirSync(join(dir, 'outside'));
      writeFileSync(join(dir, 'outside', 'evidence.json'), '{}');
      writeFileSync(join(dir, 'outside', 'events.jsonl'), JSON.stringify({ at }) + '\n');
      symlinkSync(join(dir, 'outside'), join(root, 'link'));
      mkdirSync(join(root, 'fixtures'));
      symlinkSync(join(dir, 'outside/evidence.json'), join(root, 'fixtures/escape.json'));
      expect(protocolProgress([{ id: 'p', fixtureDirectory: 'fixtures' }], { root })[0].fixtureCount).toBe(0);
      for (const path of [join(dir, 'outside/evidence.json'), '../outside/evidence.json', 'link/evidence.json']) {
        const p = protocolProgress([{ id: 'p', rules: [{ path }], fixtures: [{ path }], callers: [{ path }] }], { root })[0];
        expect(p).toMatchObject({ stage: 'proposed', ruleCount: 0, fixtureCount: 0, callerCount: 0 });
      }
      for (const path of [join(dir, 'outside'), '../outside', 'link']) expect(protocolProgress([{ id: 'p', fixtureDirectory: path }], { root })[0].fixtureCount).toBe(0);
      for (const path of [join(dir, 'outside/events.jsonl'), '../outside/events.jsonl', 'link/events.jsonl']) {
        const day = await collectDay('2026-10-16', { ...localOptions(root), settings: { delivery: { metrics: { sources: { incidents: path } } } } });
        expect(day.incidents).toMatchObject({ reason: expect.any(String) });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses oversized fix ledgers and invalid non-stub ledger rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'));
    try {
      writeFileSync(join(dir, 'fix.jsonl'), ' '.repeat(1024 * 1024 + 1));
      expect((await collectDay('2026-10-16', localOptions(dir))).fixes).toMatchObject({ reason: expect.stringContaining('truncated') });
      writeFileSync(join(dir, 'fix.jsonl'), JSON.stringify({ at, kind: 'fix' }) + '\n');
      expect((await collectDay('2026-10-16', localOptions(dir))).fixes).toMatchObject({ reason: expect.stringContaining('malformed') });
      const valid = { v: 1, repo: 'we', pr: 1, head: 'a'.repeat(40), at, kind: 'fix' };
      writeFileSync(join(dir, 'fix.jsonl'), [valid, { session: 'stub-fix' }].map(JSON.stringify).join('\n') + '\n');
      expect((await collectDay('2026-10-16', localOptions(dir))).fixes.rows).toEqual([valid]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('collectDay bounds journal reads, avoids unbounded rereads and never writes upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-io-'));
    try {
      const line = `NEEDS-YOU we#1 ${JSON.stringify({ at, repo: 'we', pr: 1, head: 'a', kind: 'needs-you' })}\n`;
      writeFileSync(join(dir, 'needs-you-events.jsonl'), line);
      writeFileSync(join(dir, 'fix.jsonl'), '');
      writeFileSync(join(dir, 'incidents.jsonl'), ' '.repeat(8 * 1024 * 1024 + 1));
      traceFs();
      const day = await collectDay('2026-10-16', { ...localOptions(dir), settings: { delivery: { metrics: { sources: { incidents: 'incidents.jsonl' } } } } });
      expect(day.needsYou.rows).toHaveLength(1);
      expect(day.incidents.reason).toContain('truncated');
      const incidentOpen = fs.openSync.mock.calls.findIndex(([path]) => path === fs.realpathSync(join(dir, 'incidents.jsonl')));
      const openedAt = fs.openSync.mock.invocationCallOrder[incidentOpen];
      const incidentFd = fs.openSync.mock.results[incidentOpen].value;
      const closedAt = fs.closeSync.mock.invocationCallOrder.find((order, i) => order > openedAt && fs.closeSync.mock.calls[i][0] === incidentFd);
      const bytesRead = fs.readSync.mock.calls.reduce((sum, [fd], i) => fd === incidentFd && fs.readSync.mock.invocationCallOrder[i] > openedAt && fs.readSync.mock.invocationCallOrder[i] < closedAt ? sum + fs.readSync.mock.results[i].value : sum, 0);
      expect(bytesRead).toBe(8 * 1024 * 1024);
      expect(fs.readFileSync.mock.calls.some(([path]) => ['needs-you-events.jsonl', 'fix.jsonl', 'incidents.jsonl'].some(name => path === join(dir, name)))).toBe(false);
      expect(fs.openSync.mock.calls.every(([, flags]) => flags === 'r')).toBe(true);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('session census counts in-window starts when total rollouts exceed 600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-codex-'));
    try {
      for (const [day, count, timestamp] of [['2026/09/01', 601, '2026-09-01T16:00:00Z'], ['2026/10/16', 2, at]]) {
        const path = join(dir, day); mkdirSync(path, { recursive: true });
        for (let i = 0; i < count; i++) writeFileSync(join(path, `rollout-${i}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp, payload: { id: `${day}-${i}` } }) + '\n');
      }
      const options = localOptions(dir);
      const day = await collectDay('2026-10-16', { ...options, coroner: window => {
        const census = collectExecutorLogs(window, { home: dir, env: { WE_CORONER_CODEX_SESSIONS: dir } });
        expect(census.sources.codex).toMatchObject({ found: true, count: 2 });
        return { ...emptyCoroner(), sources: { ...emptyCoroner().sources, codexSessions: census.sources.codex }, executorRuns: census.runs };
      } });
      expect(measures(snapshot({ date: '2026-10-16', inputs: day, settings }))['sessions.codex']).toMatchObject({ value: 2, n: 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('history locks before reading and atomically renames; failed writes preserve the previous file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-history-io-'));
    try {
      const file = join(dir, 'history.jsonl'); writeHistory(file, [{ schemaVersion: 1, date: '2026-10-15' }]);
      traceFs();
      writeHistory(file, [{ schemaVersion: 1, date: '2026-10-16' }]);
      const lock = fs.openSync.mock.calls.findIndex(([path, flags]) => path === `${file}.lock` && flags === 'wx');
      const read = fs.readFileSync.mock.calls.findIndex(([path]) => path === file);
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(fs.openSync.mock.invocationCallOrder[lock]).toBeLessThan(fs.readFileSync.mock.invocationCallOrder[read]);
      expect(fs.writeFileSync.mock.calls.every(([path]) => path !== file)).toBe(true);
      expect(fs.renameSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), file);
      const before = readFileSync(file, 'utf8');
      fs.renameSync.mockImplementationOnce(() => { throw new Error('injected rename failure'); });
      expect(() => writeHistory(file, [{ schemaVersion: 1, date: '2026-10-17' }])).toThrow('injected rename failure');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(fs.readdirSync(dir)).toEqual(['history.jsonl']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
  it('dry-run smoke for a known past day uses range queries and reports non-null throughput', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-smoke-'));
    try {
      const output = [];
      const rows = await main(['--date=2026-10-16', '--dry-run', '--json'], { ...localOptions(dir), output: x => output.push(x), log: () => {}, gh: args => {
        const url = new URL(args[1], 'https://api.github.com/');
        if (url.pathname === '/search/issues') {
          // Range syntax confirmed by the reviewer's 2026-10-17 live probe: range=36, duplicate qualifiers=5351.
          if (!url.searchParams.get('q').includes('merged:2026-10-16T04:00:00.000Z..2026-10-17T04:00:00.000Z')) return { items: [], total_count: 5351 };
          return { items: [{ number: 1 }], total_count: 1, incomplete_results: false };
        }
        return url.pathname.endsWith('/files') ? [{ filename: 'src/index.njk' }] : { created_at: at, merged_at: at, changed_files: 1 };
      }, write: () => { throw new Error('dry-run wrote'); } });
      expect(measures(rows[0])['throughput.total']).toMatchObject({ value: 3, n: 3 });
      expect(measures(JSON.parse(output[0]))['throughput.total'].value).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['budget', 'unavailable', 'throw'])('aborts a backfill on GitHub %s without further calls or history writes', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-budget-'));
    try {
      const gh = vi.fn(() => {
        if (mode === 'throw') throw new Error('rate limited');
        return mode === 'unavailable' ? null : { items: [], total_count: 0, incomplete_results: false };
      });
      const write = vi.fn();
      // Map success to a scalar so a regression does not dump 366 snapshots.
      // Four calls complete day one (three repositories) and reach day two,
      // proving the counter is shared across days rather than reset each day.
      await expect(main(['--date=2026-10-16', '--backfill=366'], { ...localOptions(dir), gh, githubCallBudget: 4, write, output: () => {}, log: () => {} }).then(() => 'completed')).rejects.toThrow(/GitHub/);
      expect(gh).toHaveBeenCalledTimes(mode === 'budget' ? 4 : 1);
      expect(write).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
