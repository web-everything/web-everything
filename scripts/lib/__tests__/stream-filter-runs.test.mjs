import { describe, it, expect } from 'vitest';
import { readFilteredInOrder } from '../stream-filter-runs.mjs';

// The reference: today's array form. Each case must throw the same error or return the same hits.
const arrayForm = (ids, read, keep) => ids.map(read).filter(keep);
const outcome = (fn) => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };

describe('readFilteredInOrder (xwu9oxh S1a)', () => {
  const runs = { a: { n: 1, ok: true }, b: { n: 2, ok: false }, c: { n: 3, ok: true } };
  const read = (log) => (id) => { log.push(id); if (!(id in runs)) throw new Error(`no run ${id}`); return runs[id]; };

  it('returns the same hits in id order and reads every id once, in order', () => {
    const logA = []; const logB = [];
    const keep = (r) => r.ok;
    expect(readFilteredInOrder(['a', 'b', 'c'], read(logA), keep)).toEqual(arrayForm(['a', 'b', 'c'], read(logB), keep));
    expect(logA).toEqual(['a', 'b', 'c']);
  });

  it('a read error throws at the same id, even after a keep error', () => {
    const keep = (r) => { if (r.n === 1) throw new Error('keep broke'); return true; };
    const ids = ['a', 'b', 'missing', 'c'];
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep))).toEqual(outcome(() => arrayForm(ids, read([]), keep)));
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep)).error).toBe('no run missing');
  });

  it('the first keep error is thrown once every read succeeded; later runs are not tested', () => {
    const tested = [];
    const keep = (r) => { tested.push(r.n); if (r.n >= 2) throw new Error(`keep broke at ${r.n}`); return true; };
    const ids = ['a', 'b', 'c'];
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep))).toEqual(outcome(() => arrayForm(ids, read([]), (r) => keep(r))));
    tested.length = 0;
    expect(() => readFilteredInOrder(ids, read([]), keep)).toThrow('keep broke at 2');
    expect(tested).toEqual([1, 2]);
  });

  it('projects matching runs with their id', () => {
    expect(readFilteredInOrder(['a', 'b', 'c'], read([]), (r) => r.ok, (run, id) => ({ id, run })))
      .toEqual([{ id: 'a', run: runs.a }, { id: 'c', run: runs.c }]);
  });
});

import { findNewestMatchingRun, MAX_RUN_RECORDS_PARSED } from '../stream-filter-runs.mjs';
describe('findNewestMatchingRun bounded newest-first scan', () => {
  it('stats 5000 candidates but parses only the cap; older evidence explicitly holds for operator inspection', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => String(i));
    let reads = 0, stats = 0;
    const options = { ids, stat: id => { stats++; return { mtimeMs: Number(id) }; },
      read: id => { reads++; return { id }; }, keep: run => run.id === '0' };
    expect(findNewestMatchingRun(options)).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(stats).toBe(5000);
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
    reads = 0;
    expect(findNewestMatchingRun({ ...options, keep: run => run.id === '4998' })).toMatchObject({ id: '4998', at: 4998 });
    expect(reads).toBe(2);
  });
  it.each([[undefined, 'a'], ['id-asc', 'a'], ['id-desc', 'b']])('matches exhaustive selection below the cap with tieBreak=%s', (tieBreak, expectedId) => {
    const ids = ['a', 'b', 'c'];
    const runs = { a: { ok: true }, b: { ok: true }, c: { ok: false } };
    const expected = ids.map(id => ({ id, run: runs[id], at: 1 })).filter(r => r.run.ok)
      .sort((a, b) => b.at - a.at || (tieBreak === 'id-desc' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)))[0];
    expect(expected.id).toBe(expectedId);
    expect(findNewestMatchingRun({ ids, read: id => runs[id], stat: () => ({ mtimeMs: 1 }), keep: r => r.ok, tieBreak })).toEqual(expected);
  });
  it('refuses unreadable candidate metadata and unreadable newest records', () => {
    expect(() => findNewestMatchingRun({ ids: ['a'], stat: () => { throw Error('stat failed'); } })).toThrow('stat failed');
    expect(() => findNewestMatchingRun({ ids: ['a'], stat: () => ({ mtimeMs: 1 }), read: () => { throw Error('torn'); }, keep: () => true })).toThrow('torn');
  });
});

import { createNewestRunFinder } from '../stream-filter-runs.mjs';
it('continues the same scan after a match without rereads or exceeding the shared cap', () => {
  let reads = 0;
  const find = createNewestRunFinder({ ids: Array.from({ length: 5000 }, (_, i) => String(i)),
    stat: id => ({ mtimeMs: Number(id) }), read: id => { reads++; return id; } });
  expect(find(run => run === '4999')).toMatchObject({ id: '4999' });
  expect(reads).toBe(1);
  expect(find(run => run === '4998')).toMatchObject({ id: '4998' });
  expect(reads).toBe(2);
  expect(find(() => false)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(find(() => true)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
});
it('tells keep the mtime of the first unscanned candidate so a caller can stop early', () => {
  const seen = [];
  const find = createNewestRunFinder({ ids: ['1', '2', '3'], stat: id => ({ mtimeMs: Number(id) * 10 }), read: id => id, maxParses: 5 });
  expect(find((run, id, at, nextAt) => { seen.push([id, at, nextAt]); return false; })).toBeNull();
  expect(seen).toEqual([['3', 30, 20], ['2', 20, 10], ['1', 10, -Infinity]]);
});
it('refuses unknown mtimes', () => {
  expect(() => findNewestMatchingRun({ ids: ['a'], stat: () => ({ mtimeMs: NaN }) })).toThrow('unreadable mtime');
});

it('refuses an unknown tie-break policy', () => {
  expect(() => createNewestRunFinder({ ids: [], tieBreak: 'unknown' })).toThrow('unknown run tieBreak');
});

import { resolveRunScanSettings } from '../stream-filter-runs.mjs';
import { readSettings } from '../settings-files.mjs';
describe('runs.scan.maxParses policy setting', () => {
  it('declares the setting and resolves standard, platform and tool with provenance', () => {
    expect(readSettings().runs.scan).toEqual({});
    const standard = resolveRunScanSettings({ file: {}, platform: {}, env: {} });
    expect(standard.value.scan.maxParses).toBe(300);
    expect(standard.sources['scan.maxParses']).toBe('standard');
    const platform = resolveRunScanSettings({ file: {}, platform: { scan: { maxParses: 7 } }, env: {} });
    expect(platform.value.scan.maxParses).toBe(7);
    expect(platform.sources['scan.maxParses']).toBe('platform');
    const tool = resolveRunScanSettings({ file: { runs: { scan: { maxParses: 2 } } }, platform: { scan: { maxParses: 7 } }, env: {} });
    expect(tool.value.scan.maxParses).toBe(2);
    expect(tool.sources['scan.maxParses']).toBe('tool');
  });
  it('scan budget exposes no environment override', () => {
    const env = { WE_RUNS_SCAN_MAX_PARSES: '5000', RUNS_SCAN_MAX_PARSES: '5000', WE_RUNS_SCAN_MAXPARSES: '5000',
      WE_POLICY_RUNS: JSON.stringify({ scan: { maxParses: 5000 } }) };
    const standard = resolveRunScanSettings({ file: {}, platform: {}, env });
    expect(standard.value.scan.maxParses).toBe(300);
    expect(standard.sources['scan.maxParses']).toBe('standard');
    const platform = resolveRunScanSettings({ file: {}, platform: { scan: { maxParses: 7 } }, env });
    expect(platform.value.scan.maxParses).toBe(7);
    expect(platform.sources['scan.maxParses']).toBe('platform');
  });
  it.each([0, -1, 1.5, '4', null, Infinity])('rejects invalid maxParses=%s, keeping the valid lower layer', maxParses => {
    const resolved = resolveRunScanSettings({ file: { runs: { scan: { maxParses } } }, platform: { scan: { maxParses: 7 } }, env: {} });
    expect(resolved.value.scan.maxParses).toBe(7);
    expect(resolved.invalid.length).toBeGreaterThan(0);
  });
  it('bounds parsing by the configured value, warns once with the fallback, and distinguishes exhaustion', () => {
    const warnings = []; let reads = 0;
    const find = createNewestRunFinder({ ids: ['a', 'b', 'c'], stat: () => ({ mtimeMs: 1 }),
      read: id => { reads++; return id; }, maxParses: 2, warn: message => warnings.push(message) });
    expect(find(() => false)).toEqual({ ok: false, reason: 'scan-capped' });
    expect(find(() => false)).toEqual({ ok: false, reason: 'scan-capped' });
    expect(reads).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/runs.scan.maxParses=2.*inspect/i);
    expect(findNewestMatchingRun({ ids: ['a', 'b'], stat: () => ({ mtimeMs: 1 }), read: id => id,
      maxParses: 2, keep: () => false })).toBeNull();
  });
  it('throws for a corrupt record inside a configured window even after a non-match', () => {
    expect(() => findNewestMatchingRun({ ids: ['a', 'b', 'c'], stat: () => ({ mtimeMs: 1 }),
      maxParses: 2, read: id => { if (id === 'b') throw Error('unreadable run'); return id; }, keep: () => false })).toThrow('unreadable run');
  });
});

it('logs the effective scan setting and its source through the shared cascade', () => {
  const lines = [];
  resolveRunScanSettings({ file: { runs: { scan: { maxParses: 17 } } }, platform: {},
    env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => lines.push(line) });
  expect(lines.join('\n')).toContain('scan.maxParses=17 (tool)');
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Resource guarantee: 300 payloads of ~1 MiB each (~300 MiB in all) scanned in a child whose
// old-space heap is 64 MiB. Each payload fits; keeping them all cannot. The `retain` control
// proves the bound is tight enough to catch a scan that keeps what it read.
describe('finder releases nonmatching payloads between reads', () => {
  const lib = name => JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib', name)).href);
  const scan = (mode, dir) => spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
    const { createNewestRunFinder } = await import(${lib('stream-filter-runs.mjs')});
    const { readDrainRedTeamEvidence } = await import(${lib('drain-red-team-evidence.mjs')});
    const ids = Array.from({ length: 300 }, (_, i) => 'review-pr-' + i);
    const stat = id => ({ mtimeMs: Number(String(id).match(/(\\d+)(\\.json)?$/)[1]) });
    const blob = () => new Array(1 << 17).fill(1); // ~1 MiB of heap per payload
    const kept = [];
    let result;
    if ($mode === 'drain') {
      // Same-repo runs for another PR: the review lookup must keep none of them.
      const r = readDrainRedTeamEvidence({ repo: 'o/r', pr: 1, head: 'b'.repeat(40), env: { WE_SHARED_RUNS_DIR: ${JSON.stringify(dir)} },
        runsDir: ${JSON.stringify(dir)}, list: () => ids, stat,
        read: () => ({ op: 'review-pr', input: { repo: 'o/r', pr: 2 }, blob: blob() }),
        readScorecards: () => [], scanSettings: { file: {}, platform: {}, env: {} }, warn: () => {} });
      result = r.ok === false ? r.reason : 'evidence';
    } else {
      const find = createNewestRunFinder({ ids, stat, read: blob, maxParses: 300, warn: () => {} });
      result = String(find(run => { if ($mode === 'retain') kept.push(run); return false; }));
    }
    process.stdout.write(result);
  `.replaceAll('$mode', JSON.stringify(mode))], { encoding: 'utf8', timeout: 120_000 });
  it('scans payloads whose total exceeds the heap when each one fits', () => {
    const child = scan('finder');
    expect(child.stderr).not.toMatch(/out of memory|Error/);
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('null');
  });
  it('the review-run lookup keeps no payload of another PR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finder-heap-'));
    try {
      const child = scan('drain', dir);
      expect(child.stderr).not.toMatch(/out of memory|Error/);
      expect(child.status).toBe(0);
      expect(child.stdout).toBe('evidence');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('control: the same heap runs out when the caller keeps every payload', () => {
    const child = scan('retain');
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/heap out of memory/i);
  });
});

describe('createNewestRunFinder id-asc tie order', () => {
  it('breaks equal-mtime ties by code-unit order like the pre-bound sorted listing, not locale order', async () => {
    const { createNewestRunFinder } = await import('../stream-filter-runs.mjs');
    const find = createNewestRunFinder({ ids: ['review-pr-a', 'review-pr-A'], stat: () => ({ mtimeMs: 5 }), read: id => id, maxParses: 5 });
    expect(find(() => true).id).toBe('review-pr-A');
  });
});

// Interim relief: skip runs that cannot be for the target PR before stat/parse (cheap bounded head check).
import { mkdtempSync as mkTmp, writeFileSync, rmSync as rmTmp } from 'node:fs';
import { tmpdir as tmpDir } from 'node:os';
import { join as joinPath } from 'node:path';
import { prNumberFromRunHead, runMayBeForPr, RUN_HEAD_BYTES } from '../stream-filter-runs.mjs';

describe('run PR prefilter (bounded head read)', () => {
  const dir = mkTmp(joinPath(tmpDir(), 'runhead-'));
  const put = (name, text) => { writeFileSync(joinPath(dir, `${name}.json`), text); return joinPath(dir, `${name}.json`); };
  const rec = pr => JSON.stringify({ v: 1, id: 'x', op: 'review-pr', input: { pr, repo: 'o/r' }, big: 'z'.repeat(5000) }, null, 2);

  it('finds a target run older than 2000 newer runs from other PRs, parsing none of the others', () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `r${i}`);
    const prOf = id => id === 'r0' ? 7 : 8;
    let reads = 0;
    const find = createNewestRunFinder({ ids, maxParses: 300, stat: id => ({ mtimeMs: id === 'r0' ? 1 : 1000 + Number(id.slice(1)) }),
      mayMatch: id => prOf(id) === 7, read: id => { reads++; return { id, pr: prOf(id) }; } });
    expect(find(run => run.pr === 7)).toMatchObject({ id: 'r0' });
    expect(reads).toBe(1);
  });
  it('reads the PR from the first bytes of a pretty-printed record, and only a different number skips', () => {
    expect(prNumberFromRunHead(rec(3420))).toBe(3420);
    expect(prNumberFromRunHead('{"input":{"pr":12,"x":1}}')).toBe(12);
    expect(prNumberFromRunHead('{"input":{"repo":"o/r"}}')).toBeNull();
    expect(prNumberFromRunHead(`{"pad":"${'a'.repeat(RUN_HEAD_BYTES)}","input":{"pr":5}}`)).toBeNull();
    expect(runMayBeForPr(put('a', rec(5)), 5)).toBe(true);
    expect(runMayBeForPr(put('b', rec(6)), 5)).toBe(false);
    expect(runMayBeForPr(put('c', 'not json at all'), 5)).toBe(true); // unknown, never skipped
    expect(runMayBeForPr(joinPath(dir, 'missing.json'), 5)).toBe(true); // the real read decides
  });
  it('ignores a nested metadata.input decoy and needs the root input first', () => {
    expect(prNumberFromRunHead('{"metadata":{"input":{"pr":8}},"input":{"pr":7}}')).toBe(7); // the root input, not the decoy
    expect(prNumberFromRunHead('{"input":{"pr":7}}')).toBe(7);
    expect(prNumberFromRunHead('{"input":{"x":{"pr":8},"pr":7}}')).toBeNull();
    expect(prNumberFromRunHead('["input"]')).toBeNull();
    expect(runMayBeForPr(put('decoy', '{"metadata":{"input":{"pr":8}},"input":{"pr":7}}'), 7)).toBe(true);
  });
  it('skips a clean other-PR record but parses a torn one so its throw is kept', () => {
    expect(runMayBeForPr(put('clean', '{"input":{"pr":8},"x":1}\n'), 7)).toBe(false);
    expect(runMayBeForPr(put('torn', '{"input":{"pr":8},BROKEN'), 7)).toBe(true);
    expect(runMayBeForPr(put('trunc', rec(8).slice(0, 3000)), 7)).toBe(true);
    expect(runMayBeForPr(put('empty', ''), 7)).toBe(true);
  });
  it('an unreadable head read throws instead of skipping (fail closed)', () => {
    expect(() => runMayBeForPr(dir, 5)).toThrow(); // EISDIR
  });
  it('a matching-looking run that fails the real parse still throws', () => {
    const find = createNewestRunFinder({ ids: ['a'], maxParses: 5, stat: () => ({ mtimeMs: 1 }), mayMatch: () => true,
      read: () => { throw Error('torn'); } });
    expect(() => find(() => true)).toThrow('torn');
  });
  it('the cap still bounds the filtered set', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const find = createNewestRunFinder({ ids, maxParses: 3, stat: id => ({ mtimeMs: Number(id.slice(1)) }),
      mayMatch: () => true, read: id => id, warn: () => {} });
    expect(find(() => false)).toEqual(RUN_SCAN_CAPPED_FOR_TEST);
    const skipAll = createNewestRunFinder({ ids, maxParses: 3, stat: () => ({ mtimeMs: 1 }), mayMatch: () => false, read: () => { throw Error('no'); } });
    expect(skipAll(() => true)).toBeNull();
  });
});
const RUN_SCAN_CAPPED_FOR_TEST = { ok: false, reason: 'scan-capped' };
