import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const VERSION = 'a'.repeat(64);
const VERSION_PATTERN = /^[0-9a-f]{64}$/;
const RUN = '20261101T120000-123-abcd';
const roots = [];
const options = (extra = {}) => ({
  now: NOW, maxAgeDays: 7, maxTotalBytes: 2 * 1024 ** 3,
  minAgeMs: HOUR, namePattern: VERSION_PATTERN, ...extra,
});
const entry = (name, ageDays, bytes = 10, kind = 'dir') =>
  ({ name, kind, bytes, mtimeMs: NOW - ageDays * DAY });

function sandbox() {
  // The launcher supplies a task-private TMPDIR; never fall back to the host cache.
  if (!process.env.TMPDIR) throw new Error('TMPDIR must be set for hermetic cache tests');
  const root = fs.mkdtempSync(join(process.env.TMPDIR, 'local-cache-evict-'));
  roots.push(root);
  return root;
}

function oldDir(parent, name, ageDays = 8, content = 'payload') {
  const dir = join(parent, name);
  fs.mkdirSync(join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(join(dir, 'nested', 'data'), content);
  fs.utimesSync(dir, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
  return dir;
}

function treeBytes(path) {
  const stat = fs.lstatSync(path);
  return stat.size + (stat.isDirectory()
    ? fs.readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0) : 0);
}

// Inject a deterministic per-entry lstat failure, including when running as root.
// Other paths still use the real filesystem. Each test gets a fresh module Map.
async function withStatError(path) {
  vi.resetModules();
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
      ...actual,
      lstatSync: (...args) => {
        if (resolve(String(args[0])) === path) {
          throw Object.assign(new Error('fixture stat denied'), { code: 'EACCES' });
        }
        return actual.lstatSync(...args);
      },
    };
  });
  return import('../standards-cache.mjs');
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('local cache eviction planner', () => {
  it('exports LOCAL_CACHE_EVICT_DEFAULTS: 7 days, 2 GiB, one hour protection', async () => {
    const cache = await import('../standards-cache.mjs');
    expect(cache.LOCAL_CACHE_EVICT_DEFAULTS).toEqual({
      maxAgeDays: 7, maxTotalBytes: 2 * 1024 ** 3, minAgeMs: HOUR,
    });
  });

  it('planner age cut: evicts strictly older entries and leaves its input unchanged', async () => {
    const { planLocalCacheEviction } = await import('../standards-cache.mjs');
    const old = Object.freeze(entry(VERSION, 8));
    const boundary = Object.freeze(entry('b'.repeat(64), 7));
    const recent = Object.freeze(entry('c'.repeat(64), 2, 10, 'file'));
    const entries = Object.freeze([recent, boundary, old]);
    expect(planLocalCacheEviction(entries, options())).toEqual([old]);
    expect(entries).toEqual([recent, boundary, old]);
  });

  it('planner size cut oldest-first: age victims are removed before applying the cap', async () => {
    const { planLocalCacheEviction } = await import('../standards-cache.mjs');
    const expired = entry(VERSION, 8, 100);
    const oldest = entry('b'.repeat(64), 6, 30);
    const middle = entry('c'.repeat(64), 4, 30);
    const newest = entry('d'.repeat(64), 2, 30, 'file');
    expect(planLocalCacheEviction([newest, middle, expired, oldest], options({ maxTotalBytes: 60 })))
      .toEqual([expired, oldest]);
    expect(planLocalCacheEviction([newest, middle, oldest], options({ maxTotalBytes: 30 })))
      .toEqual([oldest, middle]);
  });

  it('planner ignores non-matching names and symlink kinds: neither evicted nor counted', async () => {
    const { planLocalCacheEviction } = await import('../standards-cache.mjs');
    const ignored = [entry('README', 99, 1e12), entry(VERSION, 99, 1e12, 'symlink'),
      entry('b'.repeat(64), 99, 1e12, 'other')];
    const keep = entry('c'.repeat(64), 2, 20);
    expect(planLocalCacheEviction([...ignored, keep], options({ maxTotalBytes: 20 }))).toEqual([]);
  });

  it('planner protects entries younger than minAgeMs even when the cap cannot be met', async () => {
    const { planLocalCacheEviction } = await import('../standards-cache.mjs');
    const young = { ...entry(VERSION, 0, 1000), mtimeMs: NOW - HOUR + 1 };
    const eligible = { ...entry('b'.repeat(64), 0, 10), mtimeMs: NOW - HOUR };
    expect(planLocalCacheEviction([young, eligible], options({ maxTotalBytes: 0 }))).toEqual([eligible]);
    expect(planLocalCacheEviction([young], options({ maxAgeDays: 0, maxTotalBytes: 0 }))).toEqual([]);
  });
});

describe('pruneLocalCacheDir real-fs', () => {
  it('removes only matching old dirs, leaves a non-matching sibling file and a symlink (and its target) untouched', async () => {
    const { pruneLocalCacheDir } = await import('../standards-cache.mjs');
    const root = sandbox();
    const dir = join(root, 'cache');
    fs.mkdirSync(dir);
    const old = oldDir(dir, VERSION);
    const keep = oldDir(dir, 'b'.repeat(64), 1);
    const outside = oldDir(root, 'outside');
    const outsideBytes = treeBytes(outside);
    const link = join(dir, 'c'.repeat(64));
    fs.symlinkSync(outside, link, 'dir');
    fs.symlinkSync(outside, join(old, 'external'), 'dir');
    fs.utimesSync(old, new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY));
    fs.writeFileSync(join(dir, 'README'), 'keep me');
    const freedBytes = treeBytes(old);
    const remainingBytes = treeBytes(keep);
    const result = await pruneLocalCacheDir(dir, options());
    expect(result).toMatchObject({ evicted: [VERSION], freedBytes, remainingBytes, incomplete: false, dryRun: false });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.readFileSync(join(dir, 'README'), 'utf8')).toBe('keep me');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(treeBytes(outside)).toBe(outsideBytes);
    expect(fs.readFileSync(join(outside, 'nested', 'data'), 'utf8')).toBe('payload');
  });

  it('dryRun deletes nothing and reports the planned victims and bytes', async () => {
    const { pruneLocalCacheDir } = await import('../standards-cache.mjs');
    const dir = sandbox();
    const old = oldDir(dir, VERSION);
    const before = treeBytes(old);
    expect(await pruneLocalCacheDir(dir, options({ dryRun: true })))
      .toMatchObject({ evicted: [VERSION], freedBytes: before, incomplete: false, dryRun: true });
    expect(treeBytes(old)).toBe(before);
    expect(fs.readFileSync(join(old, 'nested', 'data'), 'utf8')).toBe('payload');
  });

  it('missing dir returns an empty complete scan without creating it', async () => {
    const { pruneLocalCacheDir } = await import('../standards-cache.mjs');
    const dir = join(sandbox(), 'missing');
    expect(await pruneLocalCacheDir(dir, options()))
      .toMatchObject({ scanned: 0, evicted: [], freedBytes: 0, remainingBytes: 0, incomplete: false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('stat error => incomplete:true and the affected entry is not evicted', async () => {
    const dir = sandbox();
    const old = oldDir(dir, VERSION);
    const { pruneLocalCacheDir } = await withStatError(join(old, 'nested', 'data'));
    const result = await pruneLocalCacheDir(dir, options());
    expect(result).toMatchObject({ incomplete: true, evicted: [] });
    expect(fs.readFileSync(join(old, 'nested', 'data'), 'utf8')).toBe('payload');
  });
});

describe('maybePrune', () => {
  it('stamp is a sibling path; a second call in the same hour returns ran:false even if the stamp is removed', async () => {
    const { maybePruneLocalCache } = await import('../standards-cache.mjs');
    const dir = join(sandbox(), 'cache');
    fs.mkdirSync(dir);
    expect(await maybePruneLocalCache(dir, options())).toMatchObject({ ran: true, incomplete: false });
    expect(fs.lstatSync(`${dir}.prune-stamp`).isFile()).toBe(true);
    expect(fs.existsSync(join(dir, '.prune-stamp'))).toBe(false);
    fs.rmSync(`${dir}.prune-stamp`);
    expect(await maybePruneLocalCache(dir, options({ now: NOW + HOUR - 1 }))).toMatchObject({ ran: false });
    expect(await maybePruneLocalCache(dir, options({ now: NOW + HOUR + 1 }))).toMatchObject({ ran: true });
  });

  it('honors a fresh sibling stamp from another process; force bypasses throttling', async () => {
    const { maybePruneLocalCache } = await import('../standards-cache.mjs');
    const dir = join(sandbox(), 'cache');
    fs.mkdirSync(dir);
    oldDir(dir, VERSION);
    fs.writeFileSync(`${dir}.prune-stamp`, '');
    fs.utimesSync(`${dir}.prune-stamp`, new Date(NOW), new Date(NOW));
    expect(await maybePruneLocalCache(dir, options())).toMatchObject({ ran: false });
    expect(await maybePruneLocalCache(dir, options({ force: true }))).toMatchObject({ ran: true, evicted: [VERSION] });
  });

  it('incomplete scan leaves no stamp', async () => {
    const dir = join(sandbox(), 'cache');
    const old = oldDir(dir, VERSION);
    const { maybePruneLocalCache } = await withStatError(join(old, 'nested', 'data'));
    expect(await maybePruneLocalCache(dir, options())).toMatchObject({ ran: true, incomplete: true });
    expect(fs.existsSync(`${dir}.prune-stamp`)).toBe(false);
    expect(fs.existsSync(join(dir, '.prune-stamp'))).toBe(false);
  });

  it('stamp writes never follow a symlink', async () => {
    const { maybePruneLocalCache } = await import('../standards-cache.mjs');
    const root = sandbox();
    const dir = join(root, 'cache');
    fs.mkdirSync(dir);
    const target = join(root, 'outside-stamp');
    fs.writeFileSync(target, 'untouched');
    fs.utimesSync(target, new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    const before = fs.lstatSync(target);
    fs.symlinkSync(target, `${dir}.prune-stamp`);
    await maybePruneLocalCache(dir, options({ force: true }));
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(target).mtimeMs).toBe(before.mtimeMs);
  });
});

describe('standards cache integration', () => {
  it('standards: prunes only 64-character lowercase hex version names', async () => {
    const { pruneStandardsCache } = await import('../standards-cache.mjs');
    const dir = sandbox();
    oldDir(dir, VERSION);
    const invalid = ['F'.repeat(64), 'b'.repeat(63), 'notes'];
    for (const name of invalid) oldDir(dir, name);
    expect(await pruneStandardsCache({ env: { WE_STANDARDS_CACHE_DIR: dir }, now: NOW, dryRun: true }))
      .toMatchObject({ evicted: [VERSION], dryRun: true });
    expect(fs.existsSync(join(dir, VERSION))).toBe(true);
    expect(await pruneStandardsCache({ env: { WE_STANDARDS_CACHE_DIR: dir }, now: NOW }))
      .toMatchObject({ evicted: [VERSION] });
    for (const name of invalid) expect(fs.existsSync(join(dir, name))).toBe(true);
  });

  it('standards: lookup of a missing/deleted section file or version dir is a plain miss', async () => {
    const { openSectionCache } = await import('../standards-cache.mjs');
    const dir = sandbox();
    const args = { section: 'section', version: VERSION, env: { WE_STANDARDS_CACHE_DIR: dir } };
    expect(openSectionCache(args).lookup('key')).toBeUndefined();
    for (const removed of [join(dir, VERSION, 'section.json'), join(dir, VERSION)]) {
      const writer = openSectionCache(args);
      writer.record('key', []);
      expect(writer.commit()).toBe(true);
      expect(openSectionCache(args).lookup('key')).toEqual([]);
      fs.rmSync(removed, { recursive: true });
      expect(openSectionCache(args).lookup('key')).toBeUndefined();
    }
  });

  it('standards: successful commit opportunistically prunes old versions', async () => {
    const { openSectionCache } = await import('../standards-cache.mjs');
    const dir = join(sandbox(), 'cache');
    oldDir(dir, VERSION);
    const writer = openSectionCache({ section: 'section', version: 'b'.repeat(64), env: { WE_STANDARDS_CACHE_DIR: dir } });
    writer.record('key', []);
    expect(writer.commit()).toBe(true);
    expect(fs.existsSync(join(dir, VERSION))).toBe(false);
    expect(fs.existsSync(`${dir}.prune-stamp`)).toBe(true);
  });

  it('standards: pruning failure after a successful write is fail-soft', async () => {
    const dir = join(sandbox(), 'cache');
    const old = oldDir(dir, VERSION);
    const { openSectionCache } = await withStatError(join(old, 'nested', 'data'));
    const args = { section: 'section', version: 'b'.repeat(64), env: { WE_STANDARDS_CACHE_DIR: dir } };
    const writer = openSectionCache(args);
    writer.record('key', []);
    expect(writer.commit()).toBe(true);
    expect(openSectionCache(args).lookup('key')).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.existsSync(`${dir}.prune-stamp`)).toBe(false);
  });
});

describe('vitest-cache integration', () => {
  it('vitest-cache: pruned/missing trace and entry dirs do not throw from the key path', async () => {
    const cache = await import('../test-result-cache.mjs');
    const root = sandbox();
    const dir = join(root, 'missing-cache');
    const env = { WE_TEST_CACHE_DIR: dir, WE_TEST_CACHE_RUN_ID: RUN };
    expect(cache.pruneCache({ dir, env, now: NOW }).removed).toEqual([]);
    fs.writeFileSync(join(root, 'sample.test.mjs'), "it('example', () => {});\n");
    const key = () => cache.keyFor('sample.test.mjs', cache.createKeyContext({
      root, env, vitestVersion: '3.0.0', policy: { allow: [], deny: [] },
    }));
    const before = key();
    expect(before.cacheable).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(key().key).toBe(before.key);
  });

  it('vitest-cache: existing retention default size cap is 2 GiB with the 3-day age cut kept', async () => {
    const { TEST_CACHE_RETENTION_DEFAULTS, retentionSettings } = await import('../test-result-cache.mjs');
    expect(TEST_CACHE_RETENTION_DEFAULTS.maxBytes).toBe(2 * 1024 ** 3);
    expect(TEST_CACHE_RETENTION_DEFAULTS.maxAgeDays).toBe(3);
    expect(retentionSettings({}).maxBytes).toBe(2 * 1024 ** 3);
  });
});
