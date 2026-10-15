import { describe, it, expect, vi } from 'vitest';
import {
  shaCacheRepo, resolveFastDrainScopeSetting, shouldReadContextCommits,
  filterToFastDrainTarget, readLegacyManifestCached, readLegacyLocalManifestAt,
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
    [{ item: 7 }, true, true], [{ item: 7 }, false, false],
    [null, true, true], [null, false, false],
  ])('caches manifest=%s definitive=%s only when read from the head sha', async (manifest, definitive, persists) => {
    const readCache = vi.fn(() => undefined), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest, definitive }));
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toBe(manifest);
    if (persists) expect(writeCache).toHaveBeenCalledWith({ ...key, value: manifest });
    else expect(writeCache).not.toHaveBeenCalled();
  });
  it('never reads or writes the cache without a head sha', async () => {
    const readCache = vi.fn(() => ({ item: 9 })), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest: { item: 7 }, definitive: true }));
    expect(await readLegacyManifestCached({ ...key, sha: null, readCache, writeCache, readLegacy })).toEqual({ item: 7 });
    expect(readCache).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });
});

describe('legacy manifest revision identity', () => {
  const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40), STALE = 'c'.repeat(40);
  /** A fake clone: `commits` maps a sha to its manifest (or undefined = no manifest file); `refs` maps a ref to a sha. */
  const fakeGit = ({ commits = {}, refs = {}, fetch = () => {} }) => {
    const calls = [];
    const resolveRev = (rev) => (rev in commits ? rev : refs[rev]);
    const git = (args) => {
      calls.push(args);
      if (args[0] === 'fetch') return fetch(args);
      const target = args[args.length - 1];
      if (args[0] === 'cat-file') {
        const sha = target.replace(/\^\{commit\}$/, '');
        if (sha in commits) return '';
        throw new Error('missing object');
      }
      if (args[0] === 'show') {
        const [rev, path] = target.split(':');
        const m = commits[resolveRev(rev)];
        if (path !== '.lane-manifest.json' || m === undefined) throw new Error('no such path');
        return JSON.stringify(m);
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { git, calls };
  };
  const failFetch = () => { throw new Error('network'); };

  it('does not treat a stale origin ref as the head after a failed fetch', () => {
    const { git } = fakeGit({ commits: { [STALE]: { item: 3 } }, refs: { 'origin/lane/x': STALE }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, git })).toEqual({ manifest: { item: 3 }, definitive: false });
  });
  it('does not cache a manifest from stale FETCH_HEAD after fetch failure', () => {
    const { git } = fakeGit({ commits: { [OTHER]: { item: 99 } }, refs: { FETCH_HEAD: OTHER }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, git })).toMatchObject({ definitive: false });
  });
  it('reads the head sha, not FETCH_HEAD, when a concurrent drain moved FETCH_HEAD to another PR', () => {
    const { git } = fakeGit({ commits: { [HEAD]: { item: 7 }, [OTHER]: { item: 99 } }, refs: { FETCH_HEAD: OTHER } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, git })).toEqual({ manifest: { item: 7 }, definitive: true });
  });
  it('does not cache a fork branch named main as the PR head', () => {
    const { git } = fakeGit({ commits: { [OTHER]: { item: 1 } }, refs: { main: OTHER, 'origin/main': OTHER }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'main', headSha: HEAD, git })).toMatchObject({ definitive: false });
  });
  it('answers definitively from a local head object even when the fetch fails, without fetching', () => {
    const { git, calls } = fakeGit({ commits: { [HEAD]: undefined, [STALE]: { item: 3 } }, refs: { 'origin/lane/x': STALE }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, git })).toEqual({ manifest: null, definitive: true });
    expect(calls.some(a => a[0] === 'fetch')).toBe(false);
  });
  it('fetches a missing head object, then reads it definitively', () => {
    const commits = {};
    const { git } = fakeGit({ commits, fetch: () => { commits[HEAD] = { item: 7 }; } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, git })).toEqual({ manifest: { item: 7 }, definitive: true });
  });
  it.each([null, '', 'HEAD', `--output=/tmp/x`, 'A'.repeat(40), 'a'.repeat(39)])('never trusts or passes an invalid head sha %s', (headSha) => {
    const { git, calls } = fakeGit({ commits: { [OTHER]: { item: 1 } }, refs: { FETCH_HEAD: OTHER } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha, git })).toEqual({ manifest: { item: 1 }, definitive: false });
    expect(calls.some(a => a[0] === 'cat-file')).toBe(false);
  });
  it('keeps a dash-leading head ref behind --end-of-options', () => {
    const { git, calls } = fakeGit({ fetch: failFetch });
    readLegacyLocalManifestAt({ headRef: '--upload-pack=x', headSha: HEAD, git });
    for (const args of calls) {
      const at = args.findIndex(a => a.includes('--upload-pack'));
      if (at >= 0) expect(args.indexOf('--end-of-options')).toBeGreaterThanOrEqual(0);
      if (at >= 0) expect(args.indexOf('--end-of-options')).toBeLessThan(at);
    }
  });
});
