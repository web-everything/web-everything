/** Fix readiness, load evidence, CLI append discipline, and read-only probing. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import smell, { notLoadedFixes, resolveFixNotLoadedSettings } from '../fix-not-loaded.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { probeFixReady } from '../../fix-ready-probe.mjs';
import { emptyHealthState, episodeKey, runHealthTick } from '../../health-watch-core.mjs';
import { resolveFixReadyStore, FIX_READY_STORE } from '../../../fix-ready.mjs';
import { readDeclaredSettings } from '../../../lib/settings-files.mjs';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

const now = Date.parse('2026-10-22T12:00:00Z');
const minute = 60_000;
const options = { now, readyMs: 30 * minute };
const record = (extra = {}) => ({ at: new Date(now - 31 * minute).toISOString(), ref: 'lane/fix', sha: 'abcdef123456789', tests: 'green', audit: 'approved', ancestorOf: [], ...extra });
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fix-ready-test-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

 describe('fix-not-loaded', () => {
  it('has a valid auto-discovered smell descriptor', () => {
    expect(validateSmellShape(smell, 'fix-not-loaded.mjs')).toBe(smell);
    expect(smell).toMatchObject({ id: 'fix-not-loaded', scope: 'host', cadence: 'every-tick', probes: ['fixReady', 'selfSync'], openAfter: 1, closeAfter: 2, severity: 'high', action: 'alert' });
  });
  it('alerts beyond 30 minutes with actionable evidence', () => {
    const [row] = notLoadedFixes([record()], [], options);
    expect(row).toMatchObject({ subject: 'fix-not-loaded:lane/fix', breach: true, measure: { ref: 'lane/fix', sha: record().sha, readyAtIso: record().at, ageMs: 31 * minute, audit: 'approved' } });
    expect(row.summary).toContain('no daemon clone carries it');
    expect(row.recommendation).toContain('sanctioned overlay load');
    expect(row.recommendation).toContain('--load-skip-quote=');
    expect(smell.evaluate({ fixReady: [record()], selfSync: [] }, { now })).toEqual([row]);
  });
  it.each([29, 30])('is quiet at %i minutes', (age) => {
    expect(notLoadedFixes([record({ at: new Date(now - age * minute).toISOString() })], [], options)).toEqual([]);
  });
  it('is quiet for an operator quote or ancestor evidence', () => {
    expect(notLoadedFixes([record({ loadSkipQuote: 'Operator: defer until morning' })], [], options)).toEqual([]);
    expect(notLoadedFixes([record({ ancestorOf: ['/daemon'] })], [], options)).toEqual([]);
    expect(notLoadedFixes([record({ loadSkipQuote: '' })], [], options)).toHaveLength(1);
  });
  it('fails loud for unknown records unless there is positive load evidence or a skip quote', () => {
    const unknown = record({ unknown: true, ancestorOf: null, liveHeads: ['bbbbbbb'] });
    const [row] = notLoadedFixes([unknown], [], options);
    expect(row).toMatchObject({ breach: true, measure: { unknown: true } });
    expect(row.summary).toContain('load could not be verified this tick (probe budget spent)');
    expect(notLoadedFixes([{ ...unknown, ancestorOf: ['/first'] }], [], options)).toEqual([]);
    expect(notLoadedFixes([{ ...unknown, loadSkipQuote: 'Operator: defer' }], [], options)).toEqual([]);
    const selfSync = [{ cloneKey: 'live', rebuild: { adopted: { head: 'bbbbbbb', applied: [{ sha: unknown.sha }] } } }];
    expect(notLoadedFixes([unknown], selfSync, options)).toEqual([]);
    expect(notLoadedFixes([{ ...unknown, liveHeads: ['ccccccc'] }], selfSync, options)).toHaveLength(1);
    expect(notLoadedFixes([{ ...unknown, at: new Date(now - 29 * minute).toISOString() }], [], options)).toEqual([]);
  });
  it('keeps an open episode open across two unknown ticks in the real episode engine', () => {
    const descriptor = { ...smell, readyMs: options.readyMs };
    const tick = (state, r, at) => runHealthTick(state, { fixReady: [r], selfSync: [] }, [descriptor], at);
    let result = tick(emptyHealthState(), record(), now);
    const key = episodeKey(smell.id, 'fix-not-loaded:lane/fix');
    expect(result.transitions.map((t) => t.type)).toContain('opened');
    const id = result.state.episodes[key].id;
    for (const at of [now + minute, now + 2 * minute]) {
      result = tick(result.state, record({ unknown: true, ancestorOf: null }), at);
      expect(result.state.episodes[key]).toMatchObject({ id, status: 'open', cleanStreak: 0, measure: { unknown: true } });
      expect(result.transitions.some((t) => t.type === 'closed')).toBe(false);
      expect(result.state.history).toEqual([]);
    }
  });
  it.each([
    ['abcdef1', 'ABCDEF123456789'],
    ['ABCDEF123456789', 'abcdef1'],
    ['abcdef123456789', 'abcdef123456789'],
  ])('is quiet for adopted SHA %s matching %s', (sha, applied) => {
    expect(notLoadedFixes([record({ sha })], [{ cloneKey: 'k', rebuild: { adopted: { applied: [{ sha: applied }] } } }], options)).toEqual([]);
  });
  it('does not count rejected, empty, or unrelated applied SHAs', () => {
    const selfSync = [{ rebuild: { adopted: { applied: [{ sha: '' }, { sha: '1234567' }] }, rejected: { applied: [{ sha: record().sha }] } } }];
    expect(notLoadedFixes([record()], selfSync, options)).toHaveLength(1);
  });
  it.each([null, {}, 'abcdef123456789', 1])('treats non-array applied %j as empty without throwing', (applied) => {
    expect(notLoadedFixes([record()], [{ rebuild: { adopted: { applied } } }], options)).toHaveLength(1);
  });
  it.each(['a', 'abcdefg', 1234567])('does not accept invalid applied SHA %j as load evidence', (sha) => {
    expect(notLoadedFixes([record()], [{ rebuild: { adopted: { applied: [{ sha }] } } }], options)).toHaveLength(1);
  });
  it.each([[], ['123456789abcdef'], ['b'], [null]].map((liveHeads) => ({ liveHeads })))('ignores an adopted rebuild absent from liveHeads $liveHeads', ({ liveHeads }) => {
    const selfSync = [{ cloneKey: 'stale', rebuild: { adopted: { head: 'bbbbbbb', applied: [{ sha: record().sha }] } } }];
    expect(notLoadedFixes([record({ liveHeads })], selfSync, options)).toHaveLength(1);
  });
  it.each([
    ['BBBBBBB', 'bbbbbbb123456789'],
    ['bbbbbbb123456789', 'BBBBBBB'],
    ['bbbbbbb123456789', 'bbbbbbb123456789'],
  ])('accepts a live adopted head %s matching %s', (head, liveHead) => {
    const selfSync = [{ cloneKey: 'live', rebuild: { adopted: { head, applied: [{ sha: record().sha }] } } }];
    expect(notLoadedFixes([record({ liveHeads: [liveHead] })], selfSync, options)).toEqual([]);
  });
  it('requires an adopted head when liveHeads is present', () => {
    const selfSync = [{ rebuild: { adopted: { applied: [{ sha: record().sha }] } } }];
    expect(notLoadedFixes([record({ liveHeads: [record().sha] })], selfSync, options)).toHaveLength(1);
  });
  it('shell-quotes ref, sha, and audit without command substitution', () => {
    const r = record({ ref: "lane/it's-$(id)", sha: "abcdef1'$(id)", audit: '$(id)' });
    const [row] = notLoadedFixes([r], [], options);
    const command = row.recommendation.slice(row.recommendation.indexOf('node scripts/'), -1);
    // Intercept node so the copied command only prints its literal argv.
    const result = spawnSync('/bin/sh', ['-c', `node() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'scripts/fix-ready.mjs', 'mark', `--ref=${r.ref}`, `--sha=${r.sha}`,
      '--tests=green', '--audit=$(id)', '--load-skip-quote=<operator quote>',
    ]);
    expect(command).toContain("--ref='lane/it'\\''s-$(id)'");
    expect(command).toContain("--audit='$(id)'");
  });
  it('resolves settings with a built-in fallback', () => {
    expect(resolveFixNotLoadedSettings({ fixNotLoaded: { readyMinutes: 45, lookbackDays: '3' } })).toEqual({ readyMinutes: 45, lookbackDays: 3, probeBudgetMs: 15000 });
    for (const v of [null, {}, { fixNotLoaded: { readyMinutes: 'bad' } }, { fixNotLoaded: { readyMinutes: 0 } }]) {
      expect(resolveFixNotLoadedSettings(v)).toEqual({ readyMinutes: 30, lookbackDays: 7, probeBudgetMs: 15000 });
    }
    expect(resolveFixNotLoadedSettings({ fixNotLoaded: { probeBudgetMs: '250' } }).probeBudgetMs).toBe(250);
    for (const probeBudgetMs of [null, 0, -1, 'bad', Infinity]) {
      expect(resolveFixNotLoadedSettings({ fixNotLoaded: { probeBudgetMs } }).probeBudgetMs).toBe(15000);
    }
    for (const lookbackDays of [null, 0, -1, 'bad', Infinity]) {
      expect(resolveFixNotLoadedSettings({ fixNotLoaded: { lookbackDays } }).lookbackDays).toBe(7);
    }
  });
  it('falls back when the settings reader throws', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/settings-files.mjs', () => ({ readSettings: () => { throw new Error('unreadable'); } }));
    try { expect((await import('../fix-not-loaded.mjs')).default.readyMs).toBe(30 * minute); }
    finally { vi.doUnmock('../../../lib/settings-files.mjs'); vi.resetModules(); }
  });
});

describe('fix-ready probe and store', () => {
  it('skips bad lines and selects the latest timestamp per ref, even out of append order', () => {
    const storePath = join(temp(), 'ready.jsonl');
    const older = record({ sha: '1234567', at: new Date(now - 60 * minute).toISOString() });
    writeFileSync(storePath, [JSON.stringify(record()), '{broken', JSON.stringify(older), JSON.stringify({}), JSON.stringify(record({ tests: 'red' }))].join('\n'));
    const head = 'b'.repeat(40);
    const exec = vi.fn((_cmd, args) => { if (args[1] === '/missing') throw new Error('missing object'); return args[2] === 'rev-parse' ? Buffer.from(`${head}\n`) : ''; });
    expect(probeFixReady({ storePath, roots: ['/loaded', '/missing'], exec, timeoutMs: 123, now })).toEqual([record({ liveHeads: [head], ancestorOf: ['/loaded'] })]);
    expect(exec.mock.calls).toEqual([
      ['git', ['-C', '/loaded', 'rev-parse', 'HEAD'], { timeoutMs: 123 }],
      ['git', ['-C', '/missing', 'rev-parse', 'HEAD'], { timeoutMs: 123 }],
      ['git', ['-C', '/loaded', 'merge-base', '--is-ancestor', record().sha, 'HEAD'], { timeoutMs: 123 }],
    ]);
  });
  it('bounds all git calls together and alerts on incomplete and later records', () => {
    const storePath = join(temp(), 'ready.jsonl');
    const rows = [record(), record({ ref: 'partial' }), record({ ref: 'later' })];
    writeFileSync(storePath, rows.map((r) => JSON.stringify(r)).join('\n'));
    let clock = 0;
    const exec = vi.fn((_cmd, args) => {
      clock += 2000;
      return args[2] === 'rev-parse' ? { status: 0, stdout: 'b'.repeat(40) } : { status: 1 };
    });
    const result = probeFixReady({ storePath, roots: ['/daemon'], now, exec, budgetMs: 5500, nowFn: () => clock, rotation: 0 });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls.map(([, , opts]) => opts.timeoutMs)).toEqual([5000, 3500, 1500]);
    expect(result[0]).toMatchObject({ ancestorOf: [] });
    expect(result[0].unknown).toBeUndefined();
    expect(result.slice(1)).toEqual(rows.slice(1).map((r) => ({ ...r, liveHeads: ['b'.repeat(40)], ancestorOf: null, unknown: true })));
    expect(smell.evaluate({ fixReady: result, selfSync: [] }, { now }).map((r) => r.subject)).toEqual(rows.map((r) => `fix-not-loaded:${r.ref}`));
  });
  it('stops at the first ancestry proof and retains it even when that call spends the budget', () => {
    const storePath = join(temp(), 'ready.jsonl');
    writeFileSync(storePath, JSON.stringify(record()));
    let clock = 0;
    const exec = vi.fn((_cmd, args) => {
      if (args[2] === 'merge-base') clock = 1001;
      return { status: 0, stdout: 'b'.repeat(40) };
    });
    const result = probeFixReady({ storePath, roots: ['/first', '/second'], now, exec, budgetMs: 1000, nowFn: () => clock });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(result[0]).toMatchObject({ ancestorOf: ['/first'] });
    expect(result[0].unknown).toBeUndefined();
    expect(smell.evaluate({ fixReady: result, selfSync: [] }, { now })).toEqual([]);
  });
  it('default rotation reaches every record when the tick cadence is a multiple of the record count', () => {
    const storePath = join(temp(), 'ready.jsonl');
    const rows = [0, 1, 2, 3, 4].map((i) => record({ ref: `fix-${i}`, sha: `${i}`.repeat(7), at: new Date(now - (31 + i) * minute).toISOString() }));
    writeFileSync(storePath, rows.map((r) => JSON.stringify(r)).join('\n'));
    const checked = new Set();
    for (let tick = 0; tick < 20; tick += 1) {
      let clock = tick * 5 * minute;
      const exec = vi.fn((_cmd, args) => {
        if (args[2] === 'merge-base') { clock += 1000; return { status: 0 }; }
        return { status: 0, stdout: 'b'.repeat(40) };
      });
      probeFixReady({ storePath, roots: ['/daemon'], now, exec, budgetMs: 1000, nowFn: () => clock });
      checked.add(exec.mock.calls.find(([, args]) => args[2] === 'merge-base')[1][4]);
    }
    expect(checked.size).toBe(rows.length);
  });
  it.each(['injected'])('rotates across three records with a one-record budget (%s rotation)', (mode) => {
    const storePath = join(temp(), 'ready.jsonl');
    // Store order deliberately differs from timestamp order.
    const rows = [record({ ref: 'newest', sha: 'aaaaaaa', at: new Date(now - 31 * minute).toISOString() }),
      record({ ref: 'oldest', sha: 'bbbbbbb', at: new Date(now - 33 * minute).toISOString() }),
      record({ ref: 'middle', sha: 'ccccccc', at: new Date(now - 32 * minute).toISOString() })];
    writeFileSync(storePath, rows.map((r) => JSON.stringify(r)).join('\n'));
    const checked = [];
    for (const rotation of [0, 1, 2]) {
      let clock = rotation * minute;
      const exec = vi.fn((_cmd, args) => {
        if (args[2] === 'merge-base') { clock += 1000; return { status: 0 }; }
        return { status: 0, stdout: 'b'.repeat(40) };
      });
      const result = probeFixReady({ storePath, roots: ['/daemon'], now, exec, budgetMs: 1000,
        nowFn: () => clock, ...(mode === 'injected' ? { rotation } : {}) });
      expect(exec.mock.calls.filter(([, args]) => args[2] === 'merge-base')).toHaveLength(1);
      expect(result.map((r) => r.ref)).toEqual(rows.map((r) => r.ref));
      checked.push(exec.mock.calls.find(([, args]) => args[2] === 'merge-base')[1][4]);
      expect(result.filter((r) => r.ancestorOf?.length).map((r) => r.sha)).toEqual([checked.at(-1)]);
      expect(result.filter((r) => r.unknown)).toHaveLength(2);
    }
    expect(checked).toEqual([rows[1].sha, rows[2].sha, rows[0].sha]);
  });
  it('stops after live-head probing consumes the budget', () => {
    const storePath = join(temp(), 'ready.jsonl');
    writeFileSync(storePath, JSON.stringify(record()));
    let clock = 0;
    const exec = vi.fn(() => { clock = 1000; return { status: 1 }; });
    const result = probeFixReady({ storePath, roots: ['/first', '/second'], now, exec, budgetMs: 1000, nowFn: () => clock });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ ancestorOf: null, unknown: true });
    expect(smell.evaluate({ fixReady: result, selfSync: [] }, { now })[0]).toMatchObject({ breach: true, measure: { unknown: true } });
  });
  it('skips unparseable timestamps before issuing any git call', () => {
    const storePath = join(temp(), 'ready.jsonl');
    writeFileSync(storePath, JSON.stringify(record({ at: 'invalid' })));
    const exec = vi.fn();
    expect(probeFixReady({ storePath, roots: ['/daemon'], now, exec })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
  it('returns no records for a missing store without executing git', () => {
    const exec = vi.fn();
    expect(probeFixReady({ storePath: join(temp(), 'missing'), roots: ['/daemon'], exec })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
  it('treats nonzero injected process status as not loaded', () => {
    const storePath = join(temp(), 'ready.jsonl');
    writeFileSync(storePath, JSON.stringify(record()));
    expect(probeFixReady({ storePath, roots: ['/daemon'], now, exec: () => ({ status: 1 }) })[0]).toMatchObject({ ancestorOf: [], liveHeads: [] });
  });
  it('filters to the last seven days before git and probes live heads once with a 5000 ms timeout', () => {
    const storePath = join(temp(), 'ready.jsonl');
    const day = 24 * 60 * minute;
    const rows = [record(), record({ ref: 'boundary', at: new Date(now - 7 * day).toISOString() }),
      record({ ref: 'old', at: new Date(now - 7 * day - 1).toISOString() }),
      record({ ref: 'future', at: new Date(now + 1).toISOString() })];
    writeFileSync(storePath, rows.map((r) => JSON.stringify(r)).join('\n'));
    const head = 'c'.repeat(40);
    const exec = vi.fn((_cmd, args) => args[2] === 'rev-parse' ? { status: 0, stdout: `${head}\n` } : { status: 1 });
    const result = probeFixReady({ storePath, roots: ['/daemon'], now, exec });
    expect(result.map((r) => r.ref)).toEqual(['lane/fix', 'boundary']);
    expect(result.every((r) => r.liveHeads.length === 1 && r.liveHeads[0] === head)).toBe(true);
    expect(exec.mock.calls.filter(([, args]) => args[2] === 'rev-parse')).toHaveLength(1);
    expect(exec.mock.calls).toHaveLength(3);
    expect(exec.mock.calls.every(([, , opts]) => opts.timeoutMs === 5000)).toBe(true);
    expect(probeFixReady({ storePath, roots: [], now, lookbackDays: 1 }).map((r) => r.ref)).toEqual(['lane/fix']);
    exec.mockClear();
    writeFileSync(storePath, JSON.stringify(rows[2]));
    expect(probeFixReady({ storePath, roots: ['/daemon'], now, exec })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
  it('resolves CLI > env > declared owner > built-in, expanding home', () => {
    const declared = { settings: { fixNotLoaded: { storePath: '~/declared' } }, owners: { 'fixNotLoaded.storePath': 'settings/custom.json' } };
    expect(resolveFixReadyStore('/explicit', { env: { FIX_READY_STORE: '/env' }, declared })).toEqual({ path: '/explicit', source: '--store' });
    expect(resolveFixReadyStore(undefined, { env: { FIX_READY_STORE: '/env' }, declared })).toEqual({ path: '/env', source: 'FIX_READY_STORE' });
    expect(resolveFixReadyStore(undefined, { env: {}, declared })).toEqual({ path: join(homedir(), 'declared'), source: 'settings/custom.json' });
    expect(resolveFixReadyStore(undefined, { env: {}, declared: { settings: {}, owners: {} } })).toEqual({ path: join(homedir(), FIX_READY_STORE.slice(2)), source: 'built-in' });
  });
  it('settings enumeration includes the new keys without duplicate ownership or errors', () => {
    const declared = readDeclaredSettings();
    expect(declared.owners['fixNotLoaded.storePath']).toBe('settings/fix-not-loaded.json');
    expect(declared.settings.fixNotLoaded.readyMinutes).toBe(30);
    expect(declared.settings.fixNotLoaded.lookbackDays).toBe(7);
    expect(declared.settings.fixNotLoaded.probeBudgetMs).toBe(15000);
    expect(declared.owners['fixNotLoaded.probeBudgetMs']).toBe('settings/fix-not-loaded.json');
    expect(declared.owners['fixNotLoaded.lookbackDays']).toBe('settings/fix-not-loaded.json');
    expect(declared.errors.filter((e) => e.source === 'settings/fix-not-loaded.json')).toEqual([]);
    expect(declared.duplicates.filter((d) => d.path.startsWith('fixNotLoaded.'))).toEqual([]);
  });
});

describe('fix-ready CLI', () => {
  const script = resolve(__dirname, '../../../fix-ready.mjs');
  const cli = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  it('creates parents and appends exactly one valid JSON line per mark', () => {
    const store = join(temp(), 'nested', 'ready.jsonl');
    const args = ['mark', `--store=${store}`, '--ref=lane/fix', '--sha=abcdef1', '--tests=green', '--audit=approved', '--at=2026-10-22T11:00:00Z'];
    const result = cli(args);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`store ${resolve(store)} (source: --store)`);
    expect(cli([...args, '--load-skip-quote=Operator: later']).status).toBe(0);
    const lines = readFileSync(store, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    const rows = lines.slice(0, -1).map((l) => JSON.parse(l));
    expect(rows[0]).toEqual({ at: '2026-10-22T11:00:00.000Z', ref: 'lane/fix', sha: 'abcdef1', tests: 'green', audit: 'approved', host: hostname() });
    expect(rows[1].loadSkipQuote).toBe('Operator: later');
    const list = cli(['list', '--json', `--store=${store}`]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([rows[1]]);
  });
  it.each([
    ['--ref=lane/fix', '--sha=abcdef1', '--tests=red', '--audit=approved'],
    ['--sha=abcdef1', '--tests=green', '--audit=approved'],
    ['--ref=lane/fix', '--sha=xyz', '--tests=green', '--audit=approved'],
    ['--ref=lane/fix', '--sha=abcdef1', '--tests=green'],
  ])('rejects invalid marks without creating a store: %j', (...args) => {
    const store = join(temp(), 'ready.jsonl');
    expect(cli(['mark', `--store=${store}`, ...args]).status).toBe(1);
    expect(existsSync(store)).toBe(false);
  });
});
