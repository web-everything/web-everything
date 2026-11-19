import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { DEFAULT_BRANCH_CACHE_TTL_MS, defaultBranchCacheFile, readDefaultBranchCache,
  writeDefaultBranchCache, resolveCachedDefaultBranch } from '../default-branch-cache.mjs';

const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
const repo = 'fixture/web-everything';
async function fixture(run) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'branch-cache-'));
  let time = 1_000;
  const env = { HOME: dir, WE_UNDER_TEST: '1', WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'cache') };
  const options = { env, now: () => time };
  let calls = 0;
  const resolve = (extra = {}) => resolveCachedDefaultBranch({ repo, map: new Map(),
    readCache: r => readDefaultBranchCache(r, options), writeCache: (r, name) => writeDefaultBranchCache(r, name, options),
    readLive: async () => { calls++; return 'trunk\n'; }, ...extra });
  try { return await run({ dir, env, options, resolve, calls: () => calls, advance: ms => { time += ms; } }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('host default-branch cache hit within one hour skips gh across fresh resolver maps', () => fixture(async f => {
  writeDefaultBranchCache(repo, 'main', f.options);
  f.advance(DEFAULT_BRANCH_CACHE_TTL_MS - 1);
  assert.equal(await f.resolve(), 'main');
  assert.equal(await f.resolve(), 'main');
  assert.equal(f.calls(), 0);
}));

test('expired host cache reads live and atomically rewrites the one-hour entry', () => fixture(async f => {
  writeDefaultBranchCache(repo, 'main', f.options);
  f.advance(DEFAULT_BRANCH_CACHE_TTL_MS);
  let writes = 0;
  assert.equal(await f.resolve({ writeCache: (r, name) => writeDefaultBranchCache(r, name, { ...f.options,
    write: (path, value) => { writes++; writeJsonAtomic(path, value); } }) }), 'trunk');
  assert.equal(f.calls(), 1);
  assert.equal(writes, 1);
  assert.equal(readDefaultBranchCache(repo, f.options), 'trunk');
  assert.equal(JSON.parse(readFileSync(defaultBranchCacheFile(repo, f.options), 'utf8')).atMs, f.options.now());
}));

for (const [kind, contents] of [['corrupt', '{'], ['oversized', ' '.repeat(16 * 1024 + 1)],
  ['foreign', JSON.stringify({ v: 1, repo: 'other/repo', name: 'main', atMs: 1000 })],
  ['future', JSON.stringify({ v: 1, repo, name: 'main', atMs: 2000 })]]) {
  test(`${kind} host cache falls back to live and refreshes usable evidence`, () => fixture(async f => {
    const file = defaultBranchCacheFile(repo, f.options);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    assert.equal(await f.resolve(), 'trunk');
    assert.equal(f.calls(), 1);
    assert.equal(readDefaultBranchCache(repo, f.options), 'trunk');
  }));
}

test('lookup order is process map, then round snapshot, then host cache, then live', async () => {
  const never = () => { throw new Error('lower-priority source called'); };
  assert.equal(await resolveCachedDefaultBranch({ repo, map: new Map([[repo, 'process']]), readRound: never,
    readCache: never, readLive: never }), 'process');
  const round = new Map();
  assert.equal(await resolveCachedDefaultBranch({ repo, map: round, readRound: () => 'round',
    readCache: never, readLive: never }), 'round');
  assert.equal(round.get(repo), 'round');
  assert.equal(await resolveCachedDefaultBranch({ repo, map: new Map(), readRound: () => null,
    readCache: () => 'host', readLive: never }), 'host');
});

test('a throwing cache read uses the live reader; failed writes cannot hide successful live evidence', async () => {
  let calls = 0;
  const map = new Map();
  assert.equal(await resolveCachedDefaultBranch({ repo, map, readCache: () => { throw new Error('unreadable'); },
    writeCache: () => { throw new Error('read only'); }, readLive: async () => { calls++; return 'main'; } }), 'main');
  assert.equal(calls, 1);
  assert.equal(map.get(repo), 'main');
});

test('failed live reads warn, leave the process map empty and do not refresh an expired cache', () => fixture(async f => {
  writeDefaultBranchCache(repo, 'main', f.options);
  f.advance(DEFAULT_BRANCH_CACHE_TTL_MS);
  const map = new Map(), warnings = [];
  let writes = 0;
  const branch = await f.resolve({ map, readLive: async () => { throw new Error('fixture gh failure'); },
    writeCache: () => { writes++; }, warn: e => warnings.push(e.message) });
  assert.equal(branch, null);
  assert.equal(map.size, 0);
  assert.equal(writes, 0);
  assert.deepEqual(warnings, ['fixture gh failure']);
  assert.equal(readDefaultBranchCache(repo, f.options), null);
}));

test('host cache paths are shared across checkouts, repo/host scoped, and never under .git', () => fixture(async f => {
  const a = defaultBranchCacheFile(repo, { env: { ...f.env, PWD: '/lane-a' } });
  assert.equal(a, defaultBranchCacheFile(repo, { env: { ...f.env, PWD: '/lane-b' } }));
  assert.notEqual(a, defaultBranchCacheFile('fixture/frontierui', f.options));
  assert.notEqual(a, defaultBranchCacheFile(repo, { env: { ...f.env, GH_HOST: 'ghe.example.com' } }));
  assert.equal(defaultBranchCacheFile(repo, { env: { ...f.env, WE_DEFAULT_BRANCH_CACHE_DIR: join(f.dir, '.git', 'cache') } }), null);
  assert.equal(defaultBranchCacheFile(repo, { env: { WE_UNDER_TEST: '1' } }), null);
}));
