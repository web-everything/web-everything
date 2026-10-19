/** Operator 2026-10-19 hotfix: context-only persistence, freshness, and wiring boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDrainContextCache, resolveDrainContextCacheSettings } from '../drain-context-cache.mjs';
import { prReadCacheIdentity } from '../../merge-ai-prs.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pr = { headRefOid: 'a'.repeat(40), body: 'manifest body', updatedAt: '2026-10-19T12:00:00Z' };
const keyFor = (p = pr) => ({ repo: 'owner/repo', num: 42, headRefOid: p.headRefOid,
  updatedAt: p.updatedAt, identity: prReadCacheIdentity(p), readCommits: true });
const value = [{ oid: 'a'.repeat(40), messageHeadline: 'commit' }];
function fixture(options = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'drain-context-cache-'));
  dirs.push(dir);
  let time = 100_000;
  const make = (extra = {}) => createDrainContextCache({ dir, env: {}, now: () => time, ...options, ...extra });
  return { dir, make, cache: make(), advance: ms => { time += ms; },
    file: () => join(dir, 'drain-context-cache', fs.readdirSync(join(dir, 'drain-context-cache'))[0]) };
}

describe('drain context cache', () => {
  it('persists a same-key hit across instances and sums the recorded live-read duration', () => {
    const { cache, make, file } = fixture();
    expect(cache.set(keyFor(), value, 123)).toBe(true);
    const next = make();
    expect(next.get(keyFor())).toEqual(value);
    expect(next.get(keyFor())).toEqual(value);
    expect(next.stats).toEqual({ hits: 2, misses: 0, savedMs: 246 });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toMatchObject({ savedAt: 100_000, readMs: 123, commits: value, v: 2 });
  });

  it.each([
    ['headRefOid', { ...pr, headRefOid: 'b'.repeat(40) }],
    ['updatedAt', { ...pr, updatedAt: '2026-10-19T12:01:00Z' }],
    ['body', { ...pr, body: 'edited manifest body' }],
  ])('misses changed %s and overwrites the old PR entry on refresh', (_name, changed) => {
    const { cache, dir } = fixture();
    cache.set(keyFor(), value);
    expect(cache.get(keyFor(changed))).toBeUndefined();
    expect(cache.set(keyFor(changed), value)).toBe(true);
    expect(cache.get(keyFor(changed))).toEqual(value);
    expect(cache.get(keyFor())).toBeUndefined();
    expect(fs.readdirSync(join(dir, 'drain-context-cache'))).toHaveLength(1);
  });

  it('keeps repository and PR identities separate', () => {
    const { cache } = fixture();
    cache.set(keyFor(), value);
    expect(cache.get({ ...keyFor(), repo: 'other/repo' })).toBeUndefined();
    expect(cache.get({ ...keyFor(), num: 43 })).toBeUndefined();
  });

  it('expires after maxAgeSec using the injected clock', () => {
    const { cache, advance } = fixture({ maxAgeSec: 2 });
    cache.set(keyFor(), value);
    advance(2000);
    expect(cache.get(keyFor())).toEqual(value);
    advance(1);
    expect(cache.get(keyFor())).toBeUndefined();
  });

  it.each([undefined, null, ''])('bypasses reads and writes when updatedAt is %s', updatedAt => {
    const { cache, dir } = fixture();
    cache.set(keyFor(), value);
    const key = { ...keyFor(), updatedAt };
    expect(cache.get(key)).toBeUndefined();
    expect(cache.set(key, value)).toBe(false);
    expect(fs.readdirSync(join(dir, 'drain-context-cache'))).toHaveLength(1);
  });

  it('counts only requested commit reads and accepts confirmed empty lists', () => {
    const { cache } = fixture();
    const skipped = { ...keyFor(), readCommits: false };
    expect(cache.get(skipped)).toBeUndefined();
    expect(cache.set(skipped, value)).toBe(false);
    expect(cache.stats).toEqual({ hits: 0, misses: 0, savedMs: 0 });
    expect(cache.set(keyFor(), [])).toBe(true);
    expect(cache.get(keyFor())).toEqual([]);
    expect(cache.get(skipped)).toBeUndefined();
    expect(cache.stats).toEqual({ hits: 1, misses: 0, savedMs: 0 });
  });

  it('never writes manifest, degraded, or transient to disk', () => {
    const { cache, file } = fixture();
    expect(cache.set(keyFor(), { commits: value, manifest: {}, degraded: false, transient: false })).toBe(false);
    expect(cache.set(keyFor(), value)).toBe(true);
    const raw = fs.readFileSync(file(), 'utf8');
    expect(raw).not.toContain(pr.body);
    const entry = JSON.parse(raw);
    expect(Object.keys(entry).sort()).toEqual([
      'v', 'repo', 'num', 'headRefOid', 'updatedAt', 'identity', 'savedAt', 'readMs', 'commits',
    ].sort());
    for (const field of ['manifest', 'degraded', 'transient']) expect(entry).not.toHaveProperty(field);
  });

  it.each([
    ['null commit', entry => { entry.commits = [null]; }],
    ['string commits', entry => { entry.commits = 'x'; }],
    ['array commit', entry => { entry.commits = [[]]; }],
    ['primitive commit', entry => { entry.commits = [1]; }],
    ['missing savedAt', entry => { delete entry.savedAt; }],
    ['NaN savedAt', entry => { entry.savedAt = NaN; }],
    ['string savedAt', entry => { entry.savedAt = '100000'; }],
    ['extra manifest', entry => { entry.manifest = { stale: true }; }],
    ['wrong version', entry => { entry.v = 1; }],
    ['wrong repository', entry => { entry.repo = 'other/repo'; }],
    ['wrong PR type', entry => { entry.num = '42'; }],
    ['wrong head', entry => { entry.headRefOid = 'b'.repeat(40); }],
    ['wrong freshness', entry => { entry.updatedAt = 'other'; }],
    ['wrong body identity', entry => { entry.identity = 'other'; }],
    ['negative readMs', entry => { entry.readMs = -1; }],
    ['NaN readMs', entry => { entry.readMs = NaN; }],
  ])('rejects malformed disk entries: %s', (_name, mutate) => {
    const { cache, file } = fixture();
    cache.set(keyFor(), value);
    const path = file();
    const entry = JSON.parse(fs.readFileSync(path, 'utf8'));
    mutate(entry);
    fs.writeFileSync(path, JSON.stringify(entry));
    expect(cache.get(keyFor())).toBeUndefined();
    expect(cache.stats).toEqual({ hits: 0, misses: 1, savedMs: 0 });
  });

  it('rejects non-finite savedAt even when supplied by an injected reader', () => {
    const { cache, file, make } = fixture();
    cache.set(keyFor(), value);
    const raw = fs.readFileSync(file(), 'utf8').replace(/"savedAt":\s*100000/, '"savedAt":1e999');
    const reader = make({ fs: { ...fs, readFileSync: () => raw } });
    expect(reader.get(keyFor())).toBeUndefined();
  });

  it('treats corrupt, incomplete, unreadable, and missing files as misses', () => {
    const { cache, file, make } = fixture();
    expect(cache.get(keyFor())).toBeUndefined();
    cache.set(keyFor(), value);
    const path = file();
    for (const raw of ['{broken', '{}', 'null']) {
      fs.writeFileSync(path, raw);
      expect(cache.get(keyFor())).toBeUndefined();
    }
    const unreadable = make({ fs: { ...fs, readFileSync: () => { throw new Error('unreadable'); } } });
    expect(unreadable.get(keyFor())).toBeUndefined();
  });

  it('disabled switch bypasses all filesystem reads and writes', () => {
    const { cache, make } = fixture();
    cache.set(keyFor(), value, 50);
    const fail = () => { throw new Error('disabled cache touched filesystem'); };
    const disabled = make({ enabled: false, fs: { readFileSync: fail, mkdirSync: fail } });
    expect(disabled.get(keyFor())).toBeUndefined();
    expect(disabled.set(keyFor(), value)).toBe(false);
    expect(disabled.stats).toEqual({ hits: 0, misses: 1, savedMs: 0 });
    expect(cache.get(keyFor())).toEqual(value);
  });

  it('failed writes never throw', () => {
    const { make } = fixture();
    const cache = make({ fs: { ...fs, mkdirSync: () => { throw new Error('read-only'); } } });
    expect(cache.set(keyFor(), value)).toBe(false);
  });
});

describe('drain context settings cascade', () => {
  const resolve = (options = {}) => resolveDrainContextCacheSettings({ env: {}, platform: {},
    readSettings: () => ({ settings: {} }), ...options });
  it('reports standard defaults and both sources', () => {
    expect(resolve()).toMatchObject({ contextCache: true, contextCacheMaxAgeSec: 900,
      sources: { contextCache: 'standard', contextCacheMaxAgeSec: 'standard' },
      line: 'contextCache=true (standard), maxAgeSec=900 (standard)' });
  });
  it('cascades platform, declared drain block, and env independently', () => {
    const options = { platform: { contextCache: false, contextCacheMaxAgeSec: 100 },
      readSettings: () => ({ settings: { drain: { contextCacheMaxAgeSec: 200 } } }) };
    expect(resolve(options)).toMatchObject({ contextCache: false, contextCacheMaxAgeSec: 200,
      sources: { contextCache: 'platform', contextCacheMaxAgeSec: 'tool' } });
    expect(resolve({ ...options, env: { WE_DRAIN_CONTEXT_CACHE: 'true', WE_DRAIN_CONTEXT_CACHE_MAX_AGE_SEC: '300' } }))
      .toMatchObject({ contextCache: true, contextCacheMaxAgeSec: 300,
        sources: { contextCache: 'env', contextCacheMaxAgeSec: 'env' },
        line: 'contextCache=true (env), maxAgeSec=300 (env)' });
  });
  it.each(['false', 'off', '0'])('accepts the %s disabled override', raw => {
    expect(resolve({ env: { WE_DRAIN_CONTEXT_CACHE: raw } }).contextCache).toBe(false);
  });
  it.each(['0', '-1', '1.5', '12junk', 'Infinity', '9007199254740992'])('ignores invalid env age %s', raw => {
    const settings = resolve({ platform: { contextCacheMaxAgeSec: 100 },
      env: { WE_DRAIN_CONTEXT_CACHE_MAX_AGE_SEC: raw } });
    expect(settings.contextCacheMaxAgeSec).toBe(100);
    expect(settings.sources.contextCacheMaxAgeSec).toBe('platform');
    expect(settings.invalid.length).toBeGreaterThan(0);
  });
  it('rejects invalid tool/platform types and invalid booleans', () => {
    const settings = resolve({ platform: { contextCache: 'yes', contextCacheMaxAgeSec: -5 },
      tool: { contextCache: 0, contextCacheMaxAgeSec: '500' }, env: { WE_DRAIN_CONTEXT_CACHE: 'maybe' } });
    expect(settings).toMatchObject({ contextCache: true, contextCacheMaxAgeSec: 900,
      sources: { contextCache: 'standard', contextCacheMaxAgeSec: 'standard' } });
    expect(settings.invalid.length).toBeGreaterThan(0);
  });
  it('handles unreadable settings and blank env overrides', () => {
    expect(resolve({ readSettings: () => { throw new Error('missing'); },
      env: { WE_DRAIN_CONTEXT_CACHE: ' ', WE_DRAIN_CONTEXT_CACHE_MAX_AGE_SEC: '' } }))
      .toMatchObject({ contextCache: true, contextCacheMaxAgeSec: 900 });
  });
});

describe('context-only wiring safety', () => {
  it('a commit hit still reads and returns the live manifest and health on every pass', async () => {
    const source = fs.readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('        fetchOne: async ({ repo, p }) => {', source.indexOf('  const collectContext = '));
    const end = source.indexOf('\n        },', start);
    const body = source.slice(start + '        fetchOne: async ({ repo, p }) => {'.length, end);
    const { cache } = fixture();
    const readPrManifest = vi.fn()
      .mockResolvedValueOnce({ manifest: { live: 1 }, degraded: false, transient: false })
      .mockResolvedValueOnce({ manifest: { live: 2 }, degraded: true, transient: true })
      .mockResolvedValueOnce({ manifest: { live: 3 }, degraded: false, transient: false });
    const fetchPrCommits = vi.fn().mockResolvedValue({ commits: value, degraded: false });
    const fetchOne = new Function('contextCache', 'shouldReadContextCommits', 'onlyPr', 'fastDrain',
      'isFastDrainTarget', 'shaCacheRepo', 'localSlug', 'prReadCacheIdentity', 'readPrManifest',
      'fetchPrCommits', 'prHeadSha', `return async ({ repo, p }) => {${body}};`)(
      cache, () => true, null, { scope: 'all' }, () => true, repo => repo, null,
      prReadCacheIdentity, readPrManifest, fetchPrCommits, p => p.headRefOid);
    const input = { repo: 'owner/repo', p: { ...pr, number: 42, headRefName: 'branch' } };
    expect(await fetchOne(input)).toEqual({ manifest: { live: 1 }, commits: value, degraded: false, transient: false });
    expect(await fetchOne(input)).toEqual({ manifest: { live: 2 }, commits: value, degraded: true, transient: true });
    expect(await fetchOne(input)).toEqual({ manifest: { live: 3 }, commits: value, degraded: false, transient: false });
    expect(readPrManifest).toHaveBeenCalledTimes(3);
    expect(fetchPrCommits).toHaveBeenCalledTimes(1);
    expect(cache.stats.hits).toBe(2);
  });

  it('only consults the persistent cache within collectOpenPrContext fetchReads, never sweepReadCache', () => {
    const source = fs.readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  const collectContext = ');
    const end = source.indexOf('\n  // #2421 — POST-CI', start);
    const context = source.slice(start, end);
    const reads = context.slice(context.indexOf('    fetchReads:'));
    expect(reads).toContain('contextCache.get(cacheKey)');
    expect(reads).toContain('if (!result.degraded) contextCache.set(cacheKey, result.commits, Date.now() - readStart)');
    expect(context.slice(0, context.indexOf('    fetchReads:'))).not.toMatch(/contextCache\.(get|set)/);
    const outside = source.slice(0, start) + source.slice(end);
    expect(outside).not.toMatch(/contextCache\.(get|set)/);
    const sweep = source.slice(source.indexOf('  const sweepReads ='), source.indexOf('  // #2421 (generalizes'));
    expect(sweep).toContain('cache: sweepReadCache');
    expect(sweep).toContain('fetchOne:');
    expect(sweep).not.toMatch(/contextCache|drain-context-cache|createDrainContextCache/);
    expect(reads).toContain('cache: new Map()');
    expect(source).not.toContain('ctxReadCache');
    expect(source).toMatch(/CONTEXT_LIST_FIELDS = '[^']*updatedAt/);
    expect(source).toContain("__t.timeAsync('listing.context.list'");
    expect(source).toContain("__t.timeAsync('listing.context.reads'");
    expect(source.indexOf('merge-ai-prs · context cache:')).toBeLessThan(source.indexOf('merge-ai-prs · pass timings:'));
    const paged = fs.readFileSync(new URL('../pr-list-paged.mjs', import.meta.url), 'utf8');
    expect(paged).toContain('updatedAt: n.updatedAt');
  });
});
