import { describe, it, expect, vi } from 'vitest';
import {
  shaCacheRepo, resolveFastDrainScopeSetting, resolveFastDrainListingSetting, mergeLiveTargetIntoRows, shouldReadContextCommits,
  filterToFastDrainTarget, readLegacyManifestCached,
} from '../fast-drain-scope.mjs';

describe('fast drain scope', () => {
  it('normalizes the local cache repo without changing an explicit repo', () => {
    expect(shaCacheRepo(null, 'web-everything/web-everything')).toBe('web-everything/web-everything');
    expect(shaCacheRepo('other/repo', 'web-everything/web-everything')).toBe('other/repo');
  });

  const resolve = (options = {}) => resolveFastDrainScopeSetting({ env: {}, tool: {}, platform: {}, ...options });
  it('defaults to target from the standard', () => {
    expect(resolve()).toEqual({ scope: 'target', source: 'standard', line: 'fast-drain: mergeQueue.fastDrain.scope=target (standard)' });
  });
  it('resolves platform, tool and env in cascade order', () => {
    expect(resolve({ platform: { scope: 'full' } })).toMatchObject({ scope: 'full', source: 'platform' });
    expect(resolve({ tool: { scope: 'full' } })).toMatchObject({ scope: 'full', source: 'tool' });
    expect(resolve({ tool: { scope: 'target' }, env: { WE_FAST_DRAIN_SCOPE: 'full' } })).toMatchObject({ scope: 'full', source: 'env' });
  });
  it('rejects and reports invalid settings', () => {
    for (const options of [{ tool: { scope: 'bogus' } }, { env: { WE_FAST_DRAIN_SCOPE: 'bogus' } }]) {
      expect(resolve(options)).toMatchObject({ scope: 'target', source: 'standard' });
      expect(resolve(options).line).toMatch(/ignored invalid:.*bogus/);
    }
  });

  it.each([
    [null, 'target', false, true], [null, 'target', true, true],
    [7, 'target', false, false], [7, 'target', true, true],
    [7, 'full', false, true], [7, 'full', true, true],
  ])('selects commits for onlyPr=%s scope=%s target=%s', (onlyPr, scope, isTarget, expected) => {
    expect(shouldReadContextCommits({ onlyPr, scope, isTarget })).toBe(expected);
  });
  it('filters housekeeping only for a target-scoped fast drain', () => {
    const prs = [{ number: 7 }, { number: 8 }];
    const isTarget = (p) => p.number === 7;
    expect(filterToFastDrainTarget(prs, { onlyPr: 7, scope: 'target', isTarget })).toEqual([prs[0]]);
    expect(filterToFastDrainTarget(prs, { onlyPr: null, scope: 'target', isTarget })).toBe(prs);
    expect(filterToFastDrainTarget(prs, { onlyPr: 7, scope: 'full', isTarget })).toBe(prs);
  });
});

describe('legacy manifest persistence', () => {
  const key = { repo: 'web-everything/web-everything', num: 7, sha: 'abc', kind: 'legacy-manifest' };
  it.each([null, { item: 7 }])('reuses a cached answer %s without a git read', async (manifest) => {
    const readCache = vi.fn(() => manifest), writeCache = vi.fn(), readLegacy = vi.fn();
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toBe(manifest);
    expect(readCache).toHaveBeenCalledWith(key);
    expect(readLegacy).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });
  it.each([
    [{ item: 7 }, true, true], [{ item: 7 }, false, true],
    [null, true, true], [null, false, false],
  ])('caches manifest=%s fetchSucceeded=%s only when definitive', async (manifest, fetchSucceeded, persists) => {
    const readCache = vi.fn(() => undefined), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest, fetchSucceeded }));
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toBe(manifest);
    if (persists) expect(writeCache).toHaveBeenCalledWith({ ...key, value: manifest });
    else expect(writeCache).not.toHaveBeenCalled();
  });
});


describe('fast drain listing', () => {
  const resolve = (options = {}) => resolveFastDrainListingSetting({ env: {}, tool: {}, platform: {}, ...options });
  it('defaults to snapshot from the standard', () => {
    expect(resolve()).toEqual({ listing: 'snapshot', source: 'standard', line: 'fast-drain: mergeQueue.fastDrain.listing=snapshot (standard)' });
  });
  it('resolves platform, tool and env in cascade order', () => {
    expect(resolve({ platform: { listing: 'live' } })).toMatchObject({ listing: 'live', source: 'platform' });
    expect(resolve({ platform: { listing: 'snapshot' }, tool: { listing: 'live' } })).toMatchObject({ listing: 'live', source: 'tool' });
    expect(resolve({ tool: { listing: 'snapshot' }, env: { WE_FAST_DRAIN_LISTING: 'live' } })).toMatchObject({ listing: 'live', source: 'env' });
  });
  it('reads the declared tool fastDrain block', () => {
    expect(resolve({ tool: undefined, readSettings: () => ({ settings: { mergeQueue: { fastDrain: { listing: 'live' } } } }) })).toMatchObject({ listing: 'live', source: 'tool' });
  });
  it.each([
    { platform: { listing: 'bogus' } }, { tool: { listing: 'bogus' } },
    { env: { WE_FAST_DRAIN_LISTING: 'bogus' } },
  ])('ignores and reports invalid listing settings: %s', (options) => {
    expect(resolve(options)).toMatchObject({ listing: 'snapshot', source: 'standard' });
    expect(resolve(options).line).toMatch(/ignored invalid:.*bogus/);
  });
});

describe('mergeLiveTargetIntoRows', () => {
  const other = Object.freeze({ number: 8 });
  const stale = Object.freeze({ number: 7, title: 'stale' });
  const rows = Object.freeze([stale, other]);
  it('replaces the target using string-normalized numbers without mutation', () => {
    const target = Object.freeze({ number: 7, state: 'OPEN', title: 'live' });
    const result = mergeLiveTargetIntoRows(rows, target, '7');
    expect(result).toEqual([target, other]);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(target);
    expect(rows).toEqual([stale, other]);
  });
  it('appends a missing target, including a row without state', () => {
    const target = Object.freeze({ number: 9 });
    expect(mergeLiveTargetIntoRows(rows, target, 9)).toEqual([stale, other, target]);
  });
  it.each([null, { number: 7, state: 'CLOSED' }, { number: 7, state: 'MERGED' }])('removes a null or closed target: %s', (target) => {
    expect(mergeLiveTargetIntoRows(rows, target, '7')).toEqual([other]);
    expect(rows).toEqual([stale, other]);
  });
});
