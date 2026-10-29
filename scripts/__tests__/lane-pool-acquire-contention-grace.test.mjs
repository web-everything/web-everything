/**
 * CLI regression for lease churn invalidating the shared acquire scan cache.
 * Mirrors lane-pool-acquire-shares-scan-cache.test.mjs: local origin, four real
 * lanes, and a PATH git shim. No implementation exports or remote services.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildFreeLaneList, writeFreeLaneListAtomic, resolveFreeLaneListPath } from '../lib/free-lane-list.mjs';

const SCRIPT = resolve('scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const DEFAULT_GRACE_MS = 8000;
let base, origin, reference, poolRoot, pool, shim, traceLog;

const git = (args, cwd) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
const cachePath = () => join(pool, '.list-acquirable-cache.json');
const readCache = () => JSON.parse(readFileSync(cachePath(), 'utf8'));
const writeCache = (cache) => writeFileSync(cachePath(), JSON.stringify(cache) + '\n');
const refreshCache = () => writeCache({ ...readCache(), writtenAt: Date.now() });

function runPool(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args,
    `--origin=${origin}`, `--reference=${reference}`, '--name=contention-grace',
    '--branch=main', '--no-install', '--no-reap', '--no-verdict-memo',
  ], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env, TMPDIR: base, LANE_POOL_ROOT: poolRoot, LANE_POOL_NO_RECOVER: '1',
      // Disable the independent per-lane memo so a full scan is observable in git.
      LANE_POOL_LIST_LANE_CLEAN_REUSE_MS: '0', LANE_POOL_LIST_CACHE_TTL_MS: '30000',
      LANE_POOL_LIST_CONTENTION_GRACE_MS: '',
      PATH: `${shim}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog,
      LANE_POOL_TEST_REAL_GIT: REAL_GIT,
      ...extraEnv,
    },
  });
  expect(r.error, `CLI failed to execute: ${r.stderr}`).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return args[0] === 'provision' ? null : JSON.parse(r.stdout);
}

const list = () => runPool(['list', '--acquirable', '--json']);
const acquire = (session, extraEnv = {}, extraArgs = []) => runPool([
  'acquire', `--session=${session}`, '--no-free-list', '--wait-ms=20000', '--json', ...extraArgs,
], { CLAUDE_CODE_SESSION_ID: session, ...extraEnv });

function scanProbes() {
  if (!existsSync(traceLog)) return [];
  // Acquires choose lanes 1 and 2. Git in untouched lanes 3 and 4 can only be
  // shared-scan work, never the mandatory verification/reset of a winning lane.
  const untouched = [3, 4].map((n) => realpathSync(join(pool, `lane-${n}`)));
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean).filter((line) => {
    const [cwd, , args] = line.split('\t');
    return untouched.includes(cwd) && /^(status|rev-list|cherry|diff-tree|patch-id)( |$)/.test(args);
  });
}

function seedClaimedPool() {
  runPool(['provision', '--count=4', '--json']);
  expect(list().map((p) => Number(p.match(/lane-(\d+)$/)[1]))).toEqual([1, 2, 3, 4]);
  expect(scanProbes().length, 'warm list must really probe the untouched lanes').toBeGreaterThan(0);
  const cached = readCache();
  refreshCache();
  const fresh = readCache();
  const first = acquire('first-holder');
  expect(first.lane).toBe(1);
  // The first claim leaves the pre-claim list in place but changes lease state.
  expect(fresh).toEqual({ ...cached, writtenAt: fresh.writtenAt });
  expect(readCache()).toEqual(fresh);
  return first;
}

function expectSecondLane(first, extraEnv = {}, { rescans = false, extraArgs = [], cacheAgeMs = 0 } = {}) {
  const before = scanProbes().length;
  writeCache({ ...readCache(), writtenAt: Date.now() - cacheAgeMs });
  const second = acquire('second-holder', extraEnv, extraArgs);
  expect(second.lane).toBe(2);
  expect(second.lane).not.toBe(first.lane);
  const after = scanProbes().length;
  if (rescans) expect(after, 'ineligible cache must trigger full-scan probes').toBeGreaterThan(before);
  else expect(after - before, 'second acquire must issue ZERO new full-scan probe git calls').toBe(0);
}

beforeEach(() => {
  base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'lane-pool-contention-grace-'));
  origin = join(base, 'origin.git');
  reference = join(base, 'reference');
  poolRoot = join(base, 'pool');
  pool = join(poolRoot, 'contention-grace');
  shim = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shim);
  git(['init', '--quiet', '--initial-branch=main', reference]);
  writeFileSync(join(reference, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], reference);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], reference);
  git(['clone', '--quiet', '--bare', reference, origin]);
  git(['remote', 'add', 'origin', origin], reference);
  writeFileSync(join(shim, 'git'), `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$GIT_TRACE_LOG"
exec "$LANE_POOL_TEST_REAL_GIT" "$@"
`);
  chmodSync(join(shim, 'git'), 0o755);
  // The CLI may best-effort query PR state; keep that path entirely local.
  writeFileSync(join(shim, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}, 30_000);

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('acquire shared-list contention grace', () => {
  it('rescans an empty cache after a lease release changes its fingerprint inside grace with --wait-ms=0', () => {
    seedClaimedPool();
    for (const n of [2, 3, 4]) {
      expect(acquire(`holder-${n}`, {}, [`--lane=${n}`]).lane).toBe(n);
    }
    expect(list()).toEqual([]);
    const cached = readCache();
    expect(cached.paths).toEqual([]);
    // Release just the lease: retain the empty snapshot and its pre-release fingerprint.
    rmSync(join(pool, 'lane-3', '.git', '.lane-lease'));
    expect(readCache()).toEqual(cached);
    refreshCache();
    const before = scanProbes().length;
    const released = acquire('released-lane-picker', { LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '0' }, ['--wait-ms=0']);
    expect(released.lane).toBe(3);
    expect(scanProbes().length, 'released lane must be found by a fresh scan').toBeGreaterThan(before);
    expect(readCache().fingerprint).not.toBe(cached.fingerprint);
    expect(readCache().paths).toEqual([join(pool, 'lane-3')]);
  }, 30_000);

  it('reuses a matching cache younger than the default 8000ms grace despite a lease fingerprint change', () => {
    expectSecondLane(seedClaimedPool());
  }, 30_000);

  it.each(['scan cache', 'free list'])('same-session auto-acquire skips its live lease from a stale %s without rewriting it', (source) => {
    const first = seedClaimedPool();
    const marker = join(pool, 'lane-1', '.git', '.lane-lease');
    const originalLease = readFileSync(marker, 'utf8');
    const before = scanProbes().length;
    if (source === 'free list') {
      writeFreeLaneListAtomic(resolveFreeLaneListPath({ repoName: 'contention-grace', poolDir: pool }), buildFreeLaneList({
        repoName: 'contention-grace', poolDir: pool, writtenAt: Date.now(),
        lanes: [1, 2].map((n) => ({ lane: n, path: join(pool, `lane-${n}`), head: 'deadbeef', branch: 'main' })),
      }));
    }
    refreshCache();
    const second = runPool([
      'acquire', '--session=first-holder', '--wait-ms=0', '--json',
      ...(source === 'scan cache' ? ['--no-free-list'] : []),
    ], { CLAUDE_CODE_SESSION_ID: 'first-holder' });
    expect(second.lane).toBe(2);
    expect(second.holder).not.toBe(first.holder);
    expect(readFileSync(marker, 'utf8')).toBe(originalLease);
    expect(scanProbes().length - before, 'skip a claimed candidate without rescanning the pool').toBe(0);
  }, 30_000);

  it('reclaims a TTL-stale same-session candidate with a fresh holder slug', () => {
    const first = seedClaimedPool();
    const marker = join(pool, 'lane-1', '.git', '.lane-lease');
    const lease = JSON.parse(readFileSync(marker, 'utf8'));
    writeFileSync(marker, JSON.stringify({ ...lease, acquiredAt: '2000-01-01T00:00:00.000Z' }) + '\n');
    refreshCache();
    const second = acquire('first-holder');
    expect(second.lane).toBe(first.lane);
    expect(second.holder).not.toBe(first.holder);
    expect(JSON.parse(readFileSync(marker, 'utf8')).holder).toBe(second.holder);
  }, 30_000);

  it('rescans a non-empty grace cache when every listed lane is now claimed and an unlisted lane is released', () => {
    seedClaimedPool();
    expect(acquire('holder-3', {}, ['--lane=3']).lane).toBe(3);
    expect(list()).toEqual([2, 4].map((n) => join(pool, `lane-${n}`)));
    const cached = readCache();
    for (const n of [2, 4]) {
      expect(acquire(`holder-${n}`, {}, [`--lane=${n}`]).lane).toBe(n);
    }
    rmSync(join(pool, 'lane-3', '.git', '.lane-lease'));
    expect(readCache()).toEqual(cached);
    // Keep this specifically inside grace even on a slow host; retain the scan's fingerprint.
    writeCache({ ...cached, writtenAt: Date.now() });
    const before = scanProbes().length;
    const released = acquire('released-lane-picker', { LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '0' }, ['--wait-ms=0']);
    expect(released.lane).toBe(3);
    expect(scanProbes().length, 'all cached candidates leased must trigger a fresh scan').toBeGreaterThan(before);
    expect(readCache().fingerprint).not.toBe(cached.fingerprint);
    expect(readCache().paths).toEqual([join(pool, 'lane-3')]);
  }, 30_000);

  it.each(['flag', 'environment'])('zero contention grace from %s disables reuse on a fingerprint change', (source) => {
    expectSecondLane(seedClaimedPool(), source === 'environment' ? { LANE_POOL_LIST_CONTENTION_GRACE_MS: '0' } : {}, {
      rescans: true,
      extraArgs: source === 'flag' ? ['--list-contention-grace-ms=0'] : [],
    });
  }, 30_000);

  it('re-checks contention grace under the scan lock after the initial cache read misses', () => {
    const first = seedClaimedPool();
    // Deterministically model a cache becoming visible between the first read
    // and lock acquisition. All later reads, including the one under the lock,
    // see the real pre-claim cache. The preload changes no production files.
    const preload = join(base, 'initial-cache-miss.test.mjs');
    const evidence = join(base, 'cache-read-evidence.jsonl');
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function(path, ...args) {
  if (String(path) === process.env.LANE_POOL_TEST_CACHE) {
    reads++;
    fs.appendFileSync(process.env.LANE_POOL_TEST_READ_EVIDENCE, JSON.stringify({ reads, locked: fs.existsSync(process.env.LANE_POOL_TEST_LOCK) }) + '\\n');
    if (reads === 1) throw Object.assign(new Error('simulated initial cache miss'), { code: 'ENOENT' });
  }
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
    const before = scanProbes().length;
    refreshCache();
    const second = acquire('second-holder', {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`,
      LANE_POOL_TEST_CACHE: cachePath(), LANE_POOL_TEST_LOCK: join(pool, '.list-acquirable.lock'),
      LANE_POOL_TEST_READ_EVIDENCE: evidence,
    });
    expect(second.lane).toBe(2);
    expect(second.lane).not.toBe(first.lane);
    const reads = readFileSync(evidence, 'utf8').trim().split('\n').map(JSON.parse);
    expect(reads.slice(0, 2)).toEqual([{ reads: 1, locked: false }, { reads: 2, locked: true }]);
    expect(scanProbes().length - before, 'under-lock re-check must issue ZERO new full-scan probe git calls').toBe(0);
  }, 30_000);

  it('refuses a stale-listed lane with a live foreign lease and acquires another without overwriting the lease', () => {
    const first = seedClaimedPool();
    // Force the candidate snapshot to include the now-leased lane even on the
    // old implementation, isolating tryClaimLane safety from grace acceptance.
    const cached = readCache();
    list();
    const current = readCache();
    writeCache({ ...cached, fingerprint: current.fingerprint, writtenAt: Date.now() });
    const marker = join(pool, 'lane-1', '.git', '.lane-lease');
    const leaseBefore = readFileSync(marker, 'utf8');
    expectSecondLane(first);
    expect(readFileSync(marker, 'utf8')).toBe(leaseBefore);
  }, 30_000);

  it('list --acquirable still rescans on a fingerprint mismatch inside the grace', () => {
    seedClaimedPool();
    refreshCache();
    const before = scanProbes().length;
    expect(list().map((p) => Number(p.match(/lane-(\d+)$/)[1]))).toEqual([2, 3, 4]);
    expect(scanProbes().length).toBeGreaterThan(before);
  }, 30_000);

  it('rescans a cache older than the default grace even though its normal TTL has not expired', () => {
    const first = seedClaimedPool();
    expectSecondLane(first, {}, { rescans: true, cacheAgeMs: DEFAULT_GRACE_MS + 1000 });
  }, 30_000);

  it('honours LANE_POOL_LIST_CONTENTION_GRACE_MS when it extends the grace', () => {
    const first = seedClaimedPool();
    expectSecondLane(first, { LANE_POOL_LIST_CONTENTION_GRACE_MS: '20000' }, { cacheAgeMs: 9000 });
  }, 30_000);

  it('honours LANE_POOL_LIST_CONTENTION_GRACE_MS when it shortens the grace', () => {
    const first = seedClaimedPool();
    expectSecondLane(first, { LANE_POOL_LIST_CONTENTION_GRACE_MS: '1000' }, { rescans: true, cacheAgeMs: 2000 });
  }, 30_000);

  it.each([
    { grace: 20000, age: 9000, rescans: false, envGrace: '1000' },
    { grace: 1000, age: 2000, rescans: true, envGrace: '20000' },
  ])('honours --list-contention-grace-ms=$grace over the environment (rescans=$rescans)', ({ grace, age, rescans, envGrace }) => {
    const first = seedClaimedPool();
    expectSecondLane(first, { LANE_POOL_LIST_CONTENTION_GRACE_MS: envGrace }, {
      rescans, cacheAgeMs: age, extraArgs: [`--list-contention-grace-ms=${grace}`],
    });
  }, 30_000);

  it('resolves contention grace lazily when reading the cache', () => {
    const first = seedClaimedPool();
    const preload = join(base, 'change-grace-at-cache-read.test.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (String(path) === process.env.LANE_POOL_TEST_CACHE) {
    process.env.LANE_POOL_LIST_CONTENTION_GRACE_MS = '1000';
  }
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
    expectSecondLane(first, {
      LANE_POOL_LIST_CONTENTION_GRACE_MS: '20000', LANE_POOL_TEST_CACHE: cachePath(),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`,
    }, { rescans: true, cacheAgeMs: 2000 });
  }, 30_000);

  it('fails closed on a cache key mismatch even inside the contention grace', () => {
    const first = seedClaimedPool();
    writeCache({ ...readCache(), key: 'different-branch|ttl=1|reap=1' });
    expectSecondLane(first, {}, { rescans: true });
  }, 30_000);
});
