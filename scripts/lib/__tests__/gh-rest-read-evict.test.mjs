/**
 * @file scripts/lib/__tests__/gh-rest-read-evict.test.mjs
 * @description Bounded eviction of the on-disk ETag cache (gh-etag-evict). The planner is PURE: age cut first,
 *   then oldest-first until under the byte cap; it only ever names regular files shaped `<32 hex>.json`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEtagEviction, pruneEtagDir, maybePruneEtagDir, ghRestGetJson } from '../gh-rest-read.mjs';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const hex = (n) => String(n).padStart(32, '0');
const e = (n, ageDays, size = 10, extra = {}) => ({ name: `${hex(n)}.json`, mtimeMs: NOW - ageDays * DAY, size, isFile: true, ...extra });
const opts = { now: NOW, maxAgeDays: 3, maxTotalBytes: 1000 };

describe('planEtagEviction', () => {
  it('returns nothing for an empty dir', () => {
    expect(planEtagEviction([], opts)).toEqual([]);
  });
  it('cuts everything older than maxAgeDays', () => {
    const plan = planEtagEviction([e(1, 5), e(2, 1), e(3, 4)], opts);
    expect(plan.map((p) => p.name).sort()).toEqual([`${hex(1)}.json`, `${hex(3)}.json`]);
  });
  it('then cuts oldest-first until total is within maxTotalBytes', () => {
    const entries = [e(1, 2, 400), e(2, 1, 400), e(3, 0.5, 400)];
    const plan = planEtagEviction(entries, opts);
    expect(plan.map((p) => p.name)).toEqual([`${hex(1)}.json`]);
  });
  it('ignores non-matching names, directories and symlinks', () => {
    const entries = [
      { name: 'notes.txt', mtimeMs: 0, size: 5000, isFile: true },
      { name: `${hex(9)}.json.tmp`, mtimeMs: 0, size: 5000, isFile: true },
      { name: `${hex(8)}.json`, mtimeMs: 0, size: 5000, isFile: true, isSymlink: true },
      { name: `${hex(7)}.json`, mtimeMs: 0, size: 5000, isFile: false },
      { name: `${'G'.repeat(32)}.json`, mtimeMs: 0, size: 5000, isFile: true },
    ];
    expect(planEtagEviction(entries, opts)).toEqual([]);
  });
});

describe('pruneEtagDir', () => {
  it('deletes only planned regular files, never a symlink or foreign file, and honours dryRun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-evict-'));
    const outside = mkdtempSync(join(tmpdir(), 'etag-outside-'));
    writeFileSync(join(outside, 'target.json'), 'keep');
    const old = new Date(NOW - 9 * DAY);
    const files = [`${hex(1)}.json`, `${hex(2)}.json`];
    for (const f of files) { writeFileSync(join(dir, f), 'x'); utimesSync(join(dir, f), old, old); }
    writeFileSync(join(dir, 'keep.txt'), 'x'); utimesSync(join(dir, 'keep.txt'), old, old);
    symlinkSync(join(outside, 'target.json'), join(dir, `${hex(3)}.json`));
    const dry = pruneEtagDir(dir, { now: NOW, maxAgeDays: 3, maxTotalBytes: 1e9, dryRun: true });
    expect(dry.deleted).toBe(2);
    expect(existsSync(join(dir, files[0]))).toBe(true);
    const real = pruneEtagDir(dir, { now: NOW, maxAgeDays: 3, maxTotalBytes: 1e9 });
    expect(real.deleted).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([`${hex(3)}.json`, 'keep.txt']);
    expect(existsSync(join(outside, 'target.json'))).toBe(true);
  });
  it('treats a missing dir as nothing to do', () => {
    expect(pruneEtagDir(join(tmpdir(), 'no-such-etag-dir-xyz'), { now: NOW }).deleted).toBe(0);
  });
});

describe('maybePruneEtagDir', () => {
  it('prunes at most once per hour (stamp file) and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-evict-'));
    const old = new Date(NOW - 9 * DAY);
    writeFileSync(join(dir, `${hex(1)}.json`), 'x'); utimesSync(join(dir, `${hex(1)}.json`), old, old);
    expect(maybePruneEtagDir(dir, { now: NOW, force: true }).ran).toBe(true);
    writeFileSync(join(dir, `${hex(2)}.json`), 'x'); utimesSync(join(dir, `${hex(2)}.json`), old, old);
    expect(maybePruneEtagDir(dir, { now: NOW + 60_000, force: true }).ran).toBe(false);
    expect(existsSync(join(dir, `${hex(2)}.json`))).toBe(true);
    expect(maybePruneEtagDir(dir, { now: NOW + 2 * 3_600_000, force: true }).ran).toBe(true);
    expect(() => maybePruneEtagDir('/proc/definitely/not/here', { now: NOW, force: true })).not.toThrow();
  });
});

describe('audit fixes', () => {
  it('the process memo expires after an hour without force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-evict-'));
    expect(maybePruneEtagDir(dir, { now: NOW }).ran).toBe(true);
    expect(maybePruneEtagDir(dir, { now: NOW + 2 * 3_600_000 }).ran).toBe(true);
  });
  it('a non-ENOENT directory read error is reported, not hidden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-evict-'));
    const f = join(dir, 'plain-file');
    writeFileSync(f, 'x');
    expect(pruneEtagDir(f, { now: NOW }).error).toBe('ENOTDIR');
  });
});

describe('missing cache file is a plain miss', () => {
  it('sends an unconditional GET and caches the answer when the file was evicted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-evict-'));
    const calls = [];
    const exec = (_c, argv) => { calls.push(argv); return 'HTTP/2.0 200 OK\r\nEtag: "e1"\r\n\r\n[1]'; };
    const r = ghRestGetJson('repos/o/r/pulls', { exec, dir, env: { HOME: dir } });
    expect(r.json).toEqual([1]);
    expect(calls[0]).not.toContain('-H');
  });
});
