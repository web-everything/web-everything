/**
 * @file scripts/__tests__/lane-pool-list-cache.test.mjs
 * @description Proof of #xn432dz — `lane-pool list --acquirable` must stay cheap under concurrency. Observed live
 *   2026-09-23: 14 concurrent `list --acquirable --json` scans each ran git in every one of ~129 lanes (most of
 *   them leased) and pinned fseventsd at ~100% CPU. These tests spawn the real CLI against a throwaway local
 *   origin + pool (no network) with a PATH `git` shim that logs every git invocation's cwd, and assert:
 *   - LEASE-FIRST: no git runs inside a live-leased lane (the lease already decides the verdict);
 *   - read-only git runs with GIT_OPTIONAL_LOCKS=0 (so `git status` never rewrites `.git/index`);
 *   - a second call inside the cache TTL reuses the result (zero lane git), and misses once the TTL passes;
 *   - a lease change invalidates the cache immediately (fingerprint); `--no-cache` forces a fresh scan;
 *   - concurrent callers share ONE scan (single-flight);
 *   - a stale scan lock (dead holder pid, or held past the scan timeout) is taken over;
 *   - `--limit=N` stops early and never writes a truncated cache; the scan timeout fails cleanly.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir, hostname } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir, traceLog;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=cachetest', '--branch=main', '--no-install', '--no-reap'];
const pool = () => join(poolRoot, 'cachetest');
const lanePath = (n) => join(pool(), `lane-${n}`);
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runPoolAsync(args) {
  return new Promise((res) => {
    const c = spawn('node', [SCRIPT, ...args], { env: env() });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => res({ code, out, err }));
  });
}
const lanesOf = (out) => JSON.parse(out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
function list(extra = [], extraEnv = {}) {
  const r = runPool(['list', '--acquirable', '--json', ...REPO(), ...extra], extraEnv);
  expect(r.code, r.err).toBe(0);
  return lanesOf(r.out);
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}
function leaseLane(n) {
  expect(runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', '--session=foreign-holder']).code).toBe(0);
}
const dirty = (n) => writeFileSync(join(lanePath(n), 'file.txt'), 'v1\nUNCOMMITTED\n');
// Every logged git call: { cwd, optionalLocks, args }.
function trace() {
  if (!existsSync(traceLog)) return [];
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [cwd, optionalLocks, args] = l.split('\t');
    return { cwd, optionalLocks, args };
  });
}
const resetTrace = () => rmSync(traceLog, { force: true });
const inLane = (t, n) => t.cwd === realpathSync(lanePath(n)) || t.cwd.startsWith(realpathSync(lanePath(n)) + '/');
const laneGitCalls = () => trace().filter((t) => t.cwd.startsWith(realpathSync(pool()) + '/lane-'));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK = () => join(pool(), '.list-acquirable.lock');
const CACHE = () => join(pool(), '.list-acquirable-cache.json');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-cache-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-cache-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shimDir);
  // A logging `git` shim: records cwd + GIT_OPTIONAL_LOCKS + argv, optionally sleeps, then execs the real git.
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$GIT_TRACE_LOG"\n` +
      `if [ -n "$GIT_SHIM_SLEEP" ]; then sleep "$GIT_SHIM_SLEEP"; fi\n` +
      // One-shot mid-scan hook: the FIRST git call whose cwd is $GIT_SHIM_HOOK_CWD runs $GIT_SHIM_HOOK first.
      `if [ -n "$GIT_SHIM_HOOK" ] && [ "$(pwd -P)" = "$GIT_SHIM_HOOK_CWD" ] && [ ! -e "$GIT_SHIM_HOOK_DONE" ]; then : > "$GIT_SHIM_HOOK_DONE"; sh -c "$GIT_SHIM_HOOK"; fi\n` +
      `exec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#xn432dz lease-first + read-only git', () => {
  it('runs NO git inside a live-leased lane, and still probes the unleased one', () => {
    provision(3);
    leaseLane(1);
    leaseLane(2);
    resetTrace();
    expect(list(['--no-cache'])).toEqual([3]);
    const t = trace();
    expect(t.filter((c) => inLane(c, 1) || inLane(c, 2))).toEqual([]);
    expect(t.some((c) => inLane(c, 3) && c.args.startsWith('status'))).toBe(true);
  });

  it('read-only git (status / rev-list) runs with GIT_OPTIONAL_LOCKS=0', () => {
    provision(1);
    resetTrace();
    list(['--no-cache']);
    const probes = laneGitCalls().filter((c) => /^(status|rev-list)\b/.test(c.args));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((c) => c.optionalLocks === '0')).toBe(true);
  });

  it('a mutating git call (acquire\'s fetch/checkout/clean) does NOT get GIT_OPTIONAL_LOCKS=0', () => {
    provision(1);
    resetTrace();
    expect(runPool(['acquire', '--lane=1', ...REPO(), '--session=me']).code).toBe(0);
    const mutating = laneGitCalls().filter((c) => /^(fetch|checkout|clean)\b/.test(c.args));
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating.every((c) => c.optionalLocks === '')).toBe(true);
  });
});

describe('#xn432dz list --acquirable cache', () => {
  it('a second call inside the TTL reuses the cached result (zero lane git), --no-cache rescans', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    expect(existsSync(CACHE())).toBe(true);
    dirty(2); // a tree-only change the cache cannot see (no lease change) — staleness within TTL is by design
    resetTrace();
    expect(list()).toEqual([1, 2]);
    expect(laneGitCalls()).toEqual([]);
    expect(list(['--no-cache'])).toEqual([1]); // forced fresh scan sees the dirt
  });

  it('misses once the cache TTL has passed', () => {
    provision(2);
    expect(list(['--cache-ttl-ms=300'])).toEqual([1, 2]);
    dirty(2);
    sleep(450);
    expect(list(['--cache-ttl-ms=300'])).toEqual([1]);
  });

  it('the TTL env var is honoured, and TTL 0 disables caching entirely', () => {
    provision(1);
    list([], { LANE_POOL_LIST_CACHE_TTL_MS: '0' });
    expect(existsSync(CACHE())).toBe(false);
  });

  it('a lease change invalidates the cache immediately (fingerprint), with no TTL wait', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    leaseLane(1);
    expect(list()).toEqual([2]);
  });

  it('an in-place clean of an UNLEASED lane (git checkout -- <path>, rewrites the index) invalidates the cache immediately', () => {
    // soak-main-red: the cached "lane-2 holds work" answer used to outlive this clean for the full TTL, so an
    // `acquire --wait-ms` shorter than the TTL never saw the freed lane (break lane-acquire-under-load).
    provision(2);
    dirty(2);
    expect(list()).toEqual([1]);
    sleep(20); // distinct index mtime even on a coarse-mtime filesystem
    git(['checkout', '--', 'file.txt'], lanePath(2));
    expect(list()).toEqual([1, 2]);
  });

  it('a clean that lands MID-scan, after its lane was already probed, still invalidates the cached answer', () => {
    // soak-main-red: the fingerprint used to be read AFTER the scan, so it already included this clean and the
    // stale "lane-1 holds work" answer validated for the full TTL. It is now captured before the first probe.
    provision(2);
    dirty(1);
    list(['--no-cache', '--cache-ttl-ms=0']); // settle: nothing cached
    rmSync(CACHE(), { force: true });
    const hook = {
      GIT_SHIM_HOOK: `sleep 0.05; cd "${realpathSync(lanePath(1))}" && "${REAL_GIT}" checkout -- file.txt`,
      GIT_SHIM_HOOK_CWD: realpathSync(lanePath(2)), // lane-2 is probed after lane-1
      GIT_SHIM_HOOK_DONE: join(base, 'hook-done'),
    };
    expect(list([], hook)).toEqual([2]); // this scan read lane-1 before the clean
    expect(existsSync(join(base, 'hook-done'))).toBe(true);
    expect(list()).toEqual([1, 2]); // the next caller must not be served that stale answer
  });

  it('scanning never invalidates its own cache (read-only git leaves every unleased index untouched)', () => {
    provision(2);
    dirty(2);
    expect(list()).toEqual([1]);
    resetTrace();
    expect(list()).toEqual([1]);
    expect(laneGitCalls()).toEqual([]); // a cache hit — the first scan's own `git status` did not bust it
  });

  it('provision/refresh invalidate the cache (they reset trees with no lease change)', () => {
    provision(2);
    dirty(2);
    expect(list()).toEqual([1]);
    expect(runPool(['refresh', ...REPO(), '--force']).code).toBe(0); // --force resets the dirty lane
    expect(existsSync(CACHE())).toBe(false);
    expect(list()).toEqual([1, 2]);
  });

  it('concurrent callers share ONE scan (single-flight)', async () => {
    provision(2);
    resetTrace();
    const rs = await Promise.all([1, 2, 3, 4].map(() => runPoolAsync(['list', '--acquirable', '--json', ...REPO()])));
    for (const r of rs) {
      expect(r.code, r.err).toBe(0);
      expect(lanesOf(r.out)).toEqual([1, 2]);
    }
    // One scan = exactly one `status --porcelain` per clean lane.
    expect(laneGitCalls().filter((c) => c.args.startsWith('status')).length).toBe(2);
  });
});

describe('#xn432dz scan lock takeover', () => {
  function deadPid() {
    const r = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return Number(r.stdout);
  }
  function plantLock(owner) {
    mkdirSync(LOCK());
    writeFileSync(join(LOCK(), 'owner.json'), JSON.stringify(owner));
  }

  it('takes over a lock whose holder pid is dead', () => {
    provision(2);
    plantLock({ pid: deadPid(), host: hostname(), startedAt: Date.now() });
    const r = runPool(['list', '--acquirable', '--json', ...REPO()]);
    expect(r.code, r.err).toBe(0);
    expect(lanesOf(r.out)).toEqual([1, 2]);
    expect(r.err).toMatch(/took over a stale scan lock/);
    expect(existsSync(LOCK())).toBe(false); // released after the scan
  });

  it('takes over a lock held (by a live pid) longer than the scan timeout allows', () => {
    provision(1);
    plantLock({ pid: process.pid, host: hostname(), startedAt: Date.now() - 60 * 60_000 });
    const r = runPool(['list', '--acquirable', '--json', '--scan-timeout-ms=1000', ...REPO()]);
    expect(r.code, r.err).toBe(0);
    expect(lanesOf(r.out)).toEqual([1]);
    expect(r.err).toMatch(/took over a stale scan lock/);
  });
});

describe('#xn432dz --limit and scan timeout', () => {
  it('--limit=N stops at N acquirable lanes and never writes a truncated cache', () => {
    provision(3);
    resetTrace();
    expect(list(['--limit=1'])).toEqual([1]);
    expect(existsSync(CACHE())).toBe(false);
    expect(laneGitCalls().filter((c) => inLane(c, 3))).toEqual([]); // stopped before lane-3
  });

  it('--limit=N is served from a full cached list when one is fresh', () => {
    provision(3);
    expect(list()).toEqual([1, 2, 3]);
    resetTrace();
    expect(list(['--limit=2'])).toEqual([1, 2]);
    expect(laneGitCalls()).toEqual([]);
  });

  it('rejects a non-positive --limit', () => {
    provision(1);
    const r = runPool(['list', '--acquirable', '--limit=0', ...REPO()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--limit needs a positive integer/);
  });

  it('fails cleanly (exit 1, clear message, no cache) when the scan overruns its budget', () => {
    provision(2);
    const r = runPool(['list', '--acquirable', '--json', '--no-cache', '--scan-timeout-ms=150', ...REPO()], { GIT_SHIM_SLEEP: '0.3' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/scan exceeded its 150ms budget/);
    expect(r.out).toBe('');
    expect(existsSync(CACHE())).toBe(false);
  });
});
