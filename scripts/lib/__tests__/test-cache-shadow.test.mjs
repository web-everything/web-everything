/**
 * @file scripts/lib/__tests__/test-cache-shadow.test.mjs
 * @description prepare-124 S2 — shadow decisions, the atomic store, and the reporter (off under CI, writes under a temp dir).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideShadow, falseSkipCategory, storeAllowedForRun, summarizeFile } from '../test-cache-shadow.mjs';
import { isQuarantined, readEntry, writeEntry, writeQuarantine, writeShadowLog, entryPath } from '../test-result-store.mjs';
import ShadowReporter, { laneName } from '../../test-cache/shadow-reporter.mjs';

// The reporter records `git merge-base HEAD origin/main` as the run's base sha; hermetic tests may not read the real
// checkout's remote refs. Answer that one probe with "no base" (the reporter already treats it as null); everything
// else passes through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: (cmd, args, ...rest) => (cmd === 'git' && args?.[0] === 'merge-base' ? '' : actual.execFileSync(cmd, args, ...rest)),
  };
});

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tcs-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const pass = (n = 2) => ({ type: 'suite', result: { state: 'pass', duration: 40 }, tasks: Array.from({ length: n }, () => ({ type: 'test', mode: 'run', result: { state: 'pass' } })) });
const failing = (message) => ({ type: 'suite', result: { state: 'fail', duration: 9 }, tasks: [{ type: 'test', mode: 'run', result: { state: 'fail', errors: [{ message }] } }] });
const row = { file: 'a.test.mjs', key: 'ab'.repeat(32), cacheable: true, tier: 'pure', reason: null };
const run = { runId: 'r1', lane: 'lane-9', baseSha: 'abc', storeAllowed: true, now: '2026-10-07T00:00:00Z' };
const stored = { outcome: 'pass', passed: 2, skipped: 0, durationMs: 40 };

describe('prepare-124 S2 — decideShadow', () => {
  it('records a miss, stores a full pass, and would-skip on the next run', () => {
    const first = decideShadow({ row, summary: summarizeFile(pass()), stored: null, quarantined: false, run });
    expect(first.record).toMatchObject({ wouldSkip: false, reason: 'no-entry', outcome: 'pass', falseSkip: null });
    expect(first.store).toMatchObject({ outcome: 'pass', passed: 2 });
    const second = decideShadow({ row, summary: summarizeFile(pass()), stored: first.store, quarantined: false, run });
    expect(second.record).toMatchObject({ wouldSkip: true, reason: 'hit', falseSkip: null, storedDurationMs: 40 });
  });

  it('flags and quarantines a false-skip by category', () => {
    const cases = [
      [failing('expected 1 to be 2'), 'assertion'],
      [failing('Test timed out in 5000ms.'), 'timeout'],
      [{ type: 'suite', result: { state: 'fail', errors: [{ message: 'Failed to load' }] }, tasks: [] }, 'crash'],
      [pass(3), 'count-changed'],
    ];
    for (const [file, category] of cases) {
      const d = decideShadow({ row, summary: summarizeFile(file), stored, quarantined: false, run });
      expect(d.record.falseSkip, category).toBe(category);
      expect(d.quarantine).toEqual({ category });
      expect(d.store).toBeNull();
    }
  });

  it('never stores failures, uncacheable files, quarantined files, only-runs or filtered runs', () => {
    const only = { ...pass(), tasks: [{ type: 'test', mode: 'only', result: { state: 'pass' } }] };
    expect(decideShadow({ row, summary: summarizeFile(failing('x')), stored: null, quarantined: false, run }).store).toBeNull();
    expect(decideShadow({ row: { ...row, cacheable: false, key: null, reason: 'network' }, summary: summarizeFile(pass()), stored: null, quarantined: false, run }).record.reason).toBe('not-cacheable: network');
    expect(decideShadow({ row, summary: summarizeFile(pass()), stored, quarantined: true, run }).record.reason).toBe('quarantined');
    expect(decideShadow({ row, summary: summarizeFile(only), stored: null, quarantined: false, run }).store).toBeNull();
    expect(decideShadow({ row, summary: summarizeFile(pass()), stored: null, quarantined: false, run: { ...run, storeAllowed: false } }).store).toBeNull();
    expect(storeAllowedForRun({ testNamePattern: 'x' })).toBe(false);
    expect(storeAllowedForRun({ shard: '1/4' })).toBe(false);
    expect(storeAllowedForRun({ runErrors: [new Error('x')] })).toBe(false);
    expect(storeAllowedForRun({})).toBe(true);
    expect(falseSkipCategory(summarizeFile(pass()), stored)).toBeNull();
  });
});

describe('prepare-124 S2 — store', () => {
  it('round-trips an entry atomically and treats junk as a miss', () => {
    const dir = tmp();
    writeEntry(dir, row.key, { outcome: 'pass', passed: 2 });
    expect(readEntry(dir, row.key)).toMatchObject({ outcome: 'pass', key: row.key });
    expect(readdirSync(join(dir, 'entries', 'ab')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readEntry(dir, 'cd'.repeat(32))).toBeNull();
    writeEntry(dir, 'ef'.repeat(32), { outcome: 'pass' });
    writeQuarantine(dir, 'a.test.mjs', { category: 'timeout' });
    expect(isQuarantined(dir, 'a.test.mjs')).toBe(true);
    expect(isQuarantined(dir, 'b.test.mjs')).toBe(false);
    const path = writeShadowLog(dir, 'run-1', [{ a: 1 }, { a: 2 }], new Date('2026-10-07T12:00:00Z'));
    expect(path).toContain('shadow/2026-10-07/run-1.jsonl');
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(entryPath(dir, row.key))).toBe(true);
  });
});

describe('prepare-124 S2 — reporter', () => {
  const finish = (reporter, root, files) => {
    reporter.onInit({ config: { root } });
    reporter.onPathsCollected(files.map((f) => join(root, f.name)));
    reporter.onFinished(files.map((f) => ({ ...f.file, filepath: join(root, f.name) })), []);
  };
  const cacheable = (dir) => (existsSync(join(dir, 'entries')) ? readdirSync(join(dir, 'entries')).length : 0);

  it('CI=1 writes nothing (no entries, no log, no quarantine)', () => {
    const dir = tmp();
    const root = process.cwd();
    const name = 'scripts/test-cache/__tests__/seeded-unkeyed-input.test.mjs';
    finish(new ShadowReporter({ env: { CI: '1' }, dir }), root, [{ name, file: pass() }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes an entry on the first run and logs would-skip on the second, then a false-skip when it fails', () => {
    const dir = tmp();
    const root = process.cwd();
    const name = 'scripts/test-cache/__tests__/seeded-unkeyed-input.test.mjs';
    finish(new ShadowReporter({ env: {}, dir }), root, [{ name, file: pass() }]);
    expect(cacheable(dir)).toBe(1);
    finish(new ShadowReporter({ env: {}, dir }), root, [{ name, file: pass() }]);
    finish(new ShadowReporter({ env: {}, dir }), root, [{ name, file: failing('boom') }]);
    const logs = readdirSync(join(dir, 'shadow')).flatMap((d) => readdirSync(join(dir, 'shadow', d)).map((f) => JSON.parse(readFileSync(join(dir, 'shadow', d, f), 'utf8').trim())));
    expect(logs.map((l) => [l.wouldSkip, l.falseSkip]).sort()).toEqual([[false, null], [true, 'assertion'], [true, null]].sort());
    expect(isQuarantined(dir, name)).toBe(true);
  });

  it('names a lane from its checkout path', () => {
    expect(laneName('/x/.lanes/web-everything/lane-5')).toBe('lane-5');
    expect(laneName('/x/webeverything')).toBe('webeverything');
  });
});
