import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { DEFAULT_BRANCH_CACHE_TTL_MS, defaultBranchCacheFile, readDefaultBranchCache,
  writeDefaultBranchCache, resolveCachedDefaultBranch, createLiveDefaultBranchReader, defaultBranchHold } from '../default-branch-cache.mjs';

const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
const repo = 'fixture/web-everything';
async function fixture(run) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'branch-cache-'));
  let time = 1_000;
  const env = { HOME: dir, WE_UNDER_TEST: '1', WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'cache') };
  const options = { env, now: () => time };
  let calls = 0;
  const hint = (extra = {}) => resolveCachedDefaultBranch({ repo, map: new Map(),
    readCache: r => readDefaultBranchCache(r, options), ...extra });
  const verifier = (extra = {}) => createLiveDefaultBranchReader({
    writeCache: (r, name) => writeDefaultBranchCache(r, name, options),
    readLive: async () => { calls++; return 'trunk\n'; }, ...extra });
  try { return await run({ dir, env, options, hint, verifier, calls: () => calls, advance: ms => { time += ms; } }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('host cache hit skips gh for listing hints but cannot authorize a merge', () => fixture(async f => {
  writeDefaultBranchCache(repo, 'main', f.options);
  f.advance(DEFAULT_BRANCH_CACHE_TTL_MS - 1);
  assert.equal(await f.hint(), 'main');
  assert.equal(await f.hint(), 'main');
  assert.equal(f.calls(), 0);
  const live = await f.verifier()(repo);
  assert.equal(live, 'trunk');
  assert.equal(defaultBranchHold('main', live), 'base is not trunk (main)');
  assert.equal(f.calls(), 1);
  assert.equal(readDefaultBranchCache(repo, f.options), 'trunk');
}));

test('expired host cache yields no hint; gate reads live and atomically rewrites the one-hour entry', () => fixture(async f => {
  writeDefaultBranchCache(repo, 'main', f.options);
  f.advance(DEFAULT_BRANCH_CACHE_TTL_MS);
  assert.equal(await f.hint(), null);
  let writes = 0;
  assert.equal(await f.verifier({ writeCache: (r, name) => writeDefaultBranchCache(r, name, { ...f.options,
    write: (path, value) => { writes++; writeJsonAtomic(path, value); } }) })(repo), 'trunk');
  assert.equal(f.calls(), 1);
  assert.equal(writes, 1);
  assert.equal(readDefaultBranchCache(repo, f.options), 'trunk');
  assert.equal(JSON.parse(readFileSync(defaultBranchCacheFile(repo, f.options), 'utf8')).atMs, f.options.now());
}));

for (const [kind, contents] of [['corrupt', '{'], ['oversized', ' '.repeat(16 * 1024 + 1)],
  ['foreign', JSON.stringify({ v: 1, repo: 'other/repo', name: 'main', atMs: 1000 })],
  ['future', JSON.stringify({ v: 1, repo, name: 'main', atMs: 2000 })]]) {
  test(`${kind} host cache yields no hint; gate reads live and refreshes the cache`, () => fixture(async f => {
    const file = defaultBranchCacheFile(repo, f.options);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    assert.equal(await f.hint(), null);
    assert.equal(await f.verifier()(repo), 'trunk');
    assert.equal(f.calls(), 1);
    assert.equal(readDefaultBranchCache(repo, f.options), 'trunk');
  }));
}

test('hint lookup order is process map, round snapshot, host cache; absence never starts live IO', async () => {
  const never = () => { throw new Error('lower-priority source called'); };
  assert.equal(await resolveCachedDefaultBranch({ repo, map: new Map([[repo, 'process']]), readRound: never,
    readCache: never }), 'process');
  const round = new Map();
  assert.equal(await resolveCachedDefaultBranch({ repo, map: round, readRound: () => 'round',
    readCache: never }), 'round');
  assert.equal(round.get(repo), 'round');
  assert.equal(await resolveCachedDefaultBranch({ repo, map: new Map(), readRound: () => null,
    readCache: () => 'host' }), 'host');
  assert.equal(await resolveCachedDefaultBranch({ repo, map: new Map(), readCache: () => { throw Error('unreadable'); } }), null);
});

test('one process shares exactly one live read per repo across concurrent and later gates', async () => {
  const map = new Map();
  let calls = 0;
  const verify = createLiveDefaultBranchReader({ map, readLive: async () => { calls++; return 'develop'; },
    writeCache: () => { throw Error('read only'); } });
  assert.deepEqual(await Promise.all([verify(repo), verify(repo)]), ['develop', 'develop']);
  assert.equal(await verify(repo), 'develop');
  assert.equal(map.get(repo), 'develop');
  assert.equal(calls, 1);
  assert.equal(await verify('other/repo'), 'develop');
  assert.equal(calls, 2);
});

for (const answer of [null, '', 'null', 'main\nother', new Error('fixture gh failure')]) {
  test(`failed/ambiguous live read ${String(answer)} defers every gate, never refreshing cache`, () => fixture(async f => {
    writeDefaultBranchCache(repo, 'main', f.options);
    const map = new Map(), warnings = [];
    let writes = 0, reads = 0;
    const verify = f.verifier({ map, readLive: async () => { reads++; if (answer instanceof Error) throw answer; return answer; },
      writeCache: () => { writes++; }, warn: e => warnings.push(e.message) });
    assert.deepEqual(await Promise.all([verify(repo), verify(repo)]), [null, null]);
    assert.equal(await verify(repo), null);
    assert.match(defaultBranchHold('main', map.get(repo)), /unresolved live.*deferring merge\/enqueue/);
    assert.equal(reads, 2);
    assert.equal(writes, 0);
    assert.equal(warnings.length, 2);
    assert.equal(readDefaultBranchCache(repo, f.options), 'main');
  }));
}

for (const [kind, fail] of [
  ['synchronous throw', () => { throw Error('temporary 502'); }],
  ['asynchronous rejection', async () => { throw Error('temporary 502'); }],
  ['null', () => null],
  ['undefined', () => undefined],
  ['empty', () => ''],
  ['ambiguous', () => 'main\nother'],
]) {
  test(`same reader recovers after ${kind}, sharing each concurrent attempt`, async () => {
    const map = new Map(), writes = [], warnings = [];
    let reads = 0;
    const verify = createLiveDefaultBranchReader({ map,
      readLive: () => ++reads === 1 ? fail() : 'main\n',
      writeCache: (r, name) => writes.push([r, name]), warn: e => warnings.push(e.message) });
    const failed = verify(repo);
    assert.equal(verify(repo), failed);
    assert.equal(await failed, null);
    assert.equal(map.get(repo), null);
    assert.match(defaultBranchHold('main', map.get(repo)), /unresolved live.*deferring merge\/enqueue/);
    assert.equal(reads, 1);
    assert.equal(writes.length, 0);
    assert.equal(warnings.length, 1);

    const recovered = verify(repo);
    assert.equal(verify(repo), recovered);
    assert.equal(await recovered, 'main');
    assert.equal(map.get(repo), 'main');
    assert.equal(defaultBranchHold('main', map.get(repo)), null);
    assert.equal(await verify(repo), 'main');
    assert.equal(reads, 2);
    assert.deepEqual(writes, [[repo, 'main']]);
    assert.equal(warnings.length, 1);
  });
}

test('host cache paths are shared across checkouts, repo/host scoped, and never under .git', () => fixture(async f => {
  const a = defaultBranchCacheFile(repo, { env: { ...f.env, PWD: '/lane-a' } });
  assert.equal(a, defaultBranchCacheFile(repo, { env: { ...f.env, PWD: '/lane-b' } }));
  assert.notEqual(a, defaultBranchCacheFile('fixture/frontierui', f.options));
  assert.notEqual(a, defaultBranchCacheFile(repo, { env: { ...f.env, GH_HOST: 'ghe.example.com' } }));
  assert.equal(defaultBranchCacheFile(repo, { env: { ...f.env, WE_DEFAULT_BRANCH_CACHE_DIR: join(f.dir, '.git', 'cache') } }), null);
  assert.equal(defaultBranchCacheFile(repo, { env: { WE_UNDER_TEST: '1' } }), null);
}));
