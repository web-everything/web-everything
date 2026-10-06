import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OUR_TMP_PREFIXES, ourTmpEntryPattern } from '../../lib/our-tmp-prefixes.mjs';
import { sweepOurTmp, readBusyTopLevel, formatTmpSweepLine } from '../tmp-sweep.mjs';

let root;
const now = Date.now();
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'tmp-sweep-test-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function entry(name, old = true) {
  const path = join(root, name); fs.mkdirSync(path);
  fs.utimesSync(path, new Date(now), new Date(old ? now - 10000 : now));
  return path;
}
const sweep = (opts = {}) => sweepOurTmp({ tmpRoot: root, now, olderThanMs: 1000, busy: new Set(), ...opts });

describe('temp sweep', () => {
  it('matches only exact allowlisted names and escapes custom prefixes', () => {
    expect(Object.isFrozen(OUR_TMP_PREFIXES)).toBe(true);
    for (const name of ['we-coord-test-AbC123', 'gh-t-xyz789', 'gh-t_AbC123', 'gh-t.AbC123']) expect(ourTmpEntryPattern().test(name)).toBe(true);
    for (const name of ['gh-t-home', 'com.apple.foo', 'we-coord-test-AbC1234567', 'other-AbC123', 'gh-tx-AbC123', 'gh-t-AbC123\n']) expect(ourTmpEntryPattern().test(name)).toBe(false);
    expect(ourTmpEntryPattern(['a.b']).test('axb-AbC123')).toBe(false);
    expect(ourTmpEntryPattern(['a.b']).test('a.b-AbC123')).toBe(true);
    expect(ourTmpEntryPattern([]).test('-AbC123')).toBe(false);
  });
  it('deletes old ours and preserves young, busy and foreign entries', async () => {
    const old = entry('gh-t-AbC123'); const young = entry('gh-t-AbC124', false);
    const busy = entry('gh-t-AbC125'); const foreign = entry('other-AbC123');
    const result = await sweep({ busy: new Set(['gh-t-AbC125']) });
    expect(result).toMatchObject({ listed: 4, matched: 3, busy: 1, young: 1, eligible: 1, deleted: 1, errors: 0, complete: true });
    expect(fs.existsSync(old)).toBe(false);
    for (const path of [young, busy, foreign]) expect(fs.existsSync(path)).toBe(true);
    expect(formatTmpSweepLine(result)).toContain('deleted 1/1 eligible');
  });
  it('counts dry-run deletions without removing anything', async () => {
    const path = entry('gh-t-AbC123');
    expect(await sweep({ dryRun: true })).toMatchObject({ deleted: 1, eligible: 1 });
    expect(fs.existsSync(path)).toBe(true);
  });
  it('stops at the cap and pauses between batches', async () => {
    for (let i = 0; i < 5; i++) entry(`gh-t-AbC12${i}`);
    const sleep = vi.fn();
    expect(await sweep({ batchSize: 2, maxDeletes: 3, sleep, pauseMs: 7 })).toMatchObject({ deleted: 3, complete: false });
    expect(sleep.mock.calls).toEqual([[7]]);
    expect(await sweep({ batchSize: 1, sleep })).toMatchObject({ deleted: 2, complete: true });
  });
  it('counts entry errors and observes the time budget between batches', async () => {
    entry('gh-t-AbC123'); entry('gh-t-AbC124'); entry('gh-t-AbC125');
    expect(await sweep({ fs: { ...fs, lstatSync: () => { throw Error('denied'); } } })).toMatchObject({ errors: 3, deleted: 0 });
    let clock = now; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    expect(await sweep({ batchSize: 1, timeBudgetMs: 10, sleep: async () => { clock += 11; } })).toMatchObject({ deleted: 1, complete: false });
  });
  it('resumes past 5000 young entries and eventually deletes all 200 old entries', async () => {
    let clock = now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const names = new Set(Array.from({ length: 5200 }, (_, i) => `gh-t-${String(i).padStart(6, '0')}`));
    const fakeFs = {
      readdirSync: () => [...names].reverse(),
      lstatSync: (path) => { clock++; return { mtimeMs: Number(path.slice(-6)) < 5000 ? now : now - 10000 }; },
      rmSync: (path) => { clock++; names.delete(path.slice(path.lastIndexOf('/') + 1)); },
    };
    const opts = { fs: fakeFs, scanBudgetMs: 5000, timeBudgetMs: 50, pauseMs: 0 };
    const first = await sweep(opts);
    expect(first).toMatchObject({ deleted: 0, nextCursor: 'gh-t-004999', complete: false });
    // Restarting at the front reproduces starvation on every invocation.
    for (let i = 0; i < 3; i++) expect(await sweep(opts)).toMatchObject({ deleted: 0, nextCursor: first.nextCursor });
    let result = await sweep({ ...opts, cursor: first.nextCursor });
    expect(result.deleted).toBe(50);
    let total = result.deleted;
    for (let i = 0; !result.complete && i < 10; i++) {
      result = await sweep({ ...opts, cursor: result.nextCursor });
      total += result.deleted;
    }
    expect(total).toBe(200);
    expect(result).toMatchObject({ complete: true, nextCursor: null, topPrefixes: [['gh-t', 5000]] });
    expect(names.size).toBe(5000);
    expect(await sweep({ ...opts, cursor: result.nextCursor })).toMatchObject({ young: 5000, complete: true, nextCursor: null });
  });
  it('budgets deletion and pauses separately from scanning, with a total wall cap', async () => {
    let clock = now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const rmSync = vi.fn(() => { clock += 2; });
    const fakeFs = {
      readdirSync: () => ['gh-t-000002', 'gh-t-000000', 'gh-t-000001'],
      lstatSync: () => { clock += 8; return { mtimeMs: now - 10000 }; },
      rmSync,
    };
    const opts = { fs: fakeFs, timeBudgetMs: 5, scanBudgetMs: 100, batchSize: 1, sleep: async () => { clock += 3; } };
    expect(await sweep(opts)).toMatchObject({ deleted: 1, complete: false, nextCursor: 'gh-t-000000' });
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(await sweep({ ...opts, scanBudgetMs: 8 })).toMatchObject({ deleted: 0, complete: false, nextCursor: null });
    expect(await sweep({ ...opts, batchSize: 10 })).toMatchObject({ deleted: 3, complete: true, nextCursor: null });
  });
  it('handles missing cursor names, end-of-list wrap-around, and remaining prefix counts', async () => {
    entry('gh-t-000000', false); entry('gh-t-000002'); entry('gh-t-000004');
    const result = await sweep({ cursor: 'gh-t-000001', maxDeletes: 1 });
    expect(result).toMatchObject({ deleted: 1, nextCursor: 'gh-t-000002', topPrefixes: [['gh-t', 2]] });
    expect(formatTmpSweepLine(result)).toContain('listed 3');
    expect(formatTmpSweepLine(result)).toContain('[["gh-t",2]]');
    expect(await sweep({ cursor: result.nextCursor })).toMatchObject({ deleted: 1, complete: true, nextCursor: null });
    expect(await sweep({ cursor: 'zzz' })).toMatchObject({ deleted: 0, complete: true, nextCursor: null });
    expect(await sweep({ dryRun: true, olderThanMs: 0 })).toMatchObject({ deleted: 1, topPrefixes: [['gh-t', 1]] });
  });
  it('reads cwd once, handles realpath aliases and partial stdout', () => {
    const alias = join(root, 'alias'); const actual = join(root, 'actual'); fs.mkdirSync(actual); fs.symlinkSync(actual, alias);
    const run = vi.fn(() => `p1\nn${alias}/gh-t-AbC123/nested\np2\nn${fs.realpathSync(actual)}/gh-t-AbC124\nn${actual}-other/foreign\nn/private/var/unrelated\nn/var/unrelated\n`);
    expect(readBusyTopLevel(alias, { run })).toEqual(new Set(['gh-t-AbC123', 'gh-t-AbC124']));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0].slice(0, 2)).toEqual(['lsof', ['-n', '-d', 'cwd', '-Fpn']]);
    expect(readBusyTopLevel(root, { run: () => { throw Object.assign(Error('partial'), { stdout: `p1\nn${root}/gh-t-AbC123\n` }); } })).toEqual(new Set(['gh-t-AbC123']));
    for (const stdout of ['', 'p123\n', 'garbage']) expect(() => readBusyTopLevel(root, { run: () => { throw Object.assign(Error('failed'), { stdout }); } })).toThrow();
  });
  it('treats a truncated lsof scan (timeout, kill, buffer overflow) as unknown busy state, never partial', () => {
    const stdout = `p1\nn${root}/gh-t-AbC123\n`;
    const truncations = [
      { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM', status: null },
      { killed: true, signal: 'SIGTERM', status: null },
      { signal: 'SIGKILL', status: null },
      { code: 'ENOBUFS' },
    ];
    for (const shape of truncations) {
      expect(() => readBusyTopLevel(root, { run: () => { throw Object.assign(Error('truncated'), { ...shape, stdout }); } })).toThrow();
    }
    // a routine non-zero exit (permission gaps) keeps its partial output
    expect(readBusyTopLevel(root, { run: () => { throw Object.assign(Error('exit 1'), { status: 1, signal: null, stdout }); } })).toEqual(new Set(['gh-t-AbC123']));
  });
  it('fails closed on non-numeric or NaN sweep knobs (young entries are never swept)', async () => {
    const path = entry('gh-t-AbC123');
    for (const olderThanMs of ['24h', NaN, undefined, null]) {
      const result = await sweep({ olderThanMs, now: Date.now() });
      expect(result).toMatchObject({ deleted: 0, young: 1 });
      expect(fs.existsSync(path)).toBe(true);
    }
    for (const knob of [{ batchSize: 'x' }, { batchSize: NaN }, { maxDeletes: 'x' }, { timeBudgetMs: 'x' }, { scanBudgetMs: 'x' }, { scanBudgetMs: NaN }, { scanBudgetMs: -1 }, { pauseMs: NaN }]) {
      expect(await sweep({ olderThanMs: 0, busy: new Set(), dryRun: true, ...knob })).toMatchObject({ deleted: 1, complete: true });
    }
  });
});


it('runs the CLI with merged config and fixture lsof, including dry-run JSON', () => {
  const bin = join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'lsof'), "#!/bin/sh\nprintf 'p1\\nn/unrelated\\n'\n", { mode: 0o755 });
  const state = join(root, 'state'); const health = join(state, '.conveyor', 'health'); fs.mkdirSync(health, { recursive: true });
  fs.writeFileSync(join(health, 'config.json'), JSON.stringify({ tmpSweepOlderThanMs: 0 }));
  const path = entry('gh-t-AbC123');
  const args = ['scripts/conveyor/health-watch.mjs', 'tmp-sweep', `--tmp-sweep-root=${root}`, `--state-root=${state}`];
  const options = { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 };
  expect(JSON.parse(execFileSync(process.execPath, [...args, '--dry-run', '--json'], options))).toMatchObject({ deleted: 1, complete: true });
  expect(fs.existsSync(path)).toBe(true);
  expect(execFileSync(process.execPath, args, options)).toContain('tmp-sweep: deleted 1/1 eligible');
  expect(fs.existsSync(path)).toBe(false);
});
