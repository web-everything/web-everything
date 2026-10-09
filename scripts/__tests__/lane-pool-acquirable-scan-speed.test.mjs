/**
 * @file scripts/__tests__/lane-pool-acquirable-scan-speed.test.mjs
 * @description Card xkv3p37 — `lane-pool list --acquirable` must stay fast and bounded on a big, busy pool.
 *   Live 2026-10-09 (load ~18-26, 90-101 lanes): the builder's dispatch-plan calls it every tick, and the scan
 *   ran past its 120s budget, so the tick planned with ZERO free lanes and launched nothing. Measured: ~70% of
 *   the scan was `git status --porcelain` in each of ~64 CLEAN, unleased lanes (≈100ms each idle, 3-4x that in a
 *   launchd-throttled daemon tree), re-run from scratch on every scan because the whole-list cache is dropped
 *   whenever ANY unleased lane's index changes (agents run read-only git in unleased lanes all the time).
 *
 *   These tests spawn the real CLI against a throwaway origin + pool with a PATH `git` shim that logs every call:
 *   - a re-scan re-probes ONLY the lanes whose cheap signals changed (git refs/index/lease marker, or the stat of
 *     the lane root's own entries) — a clean lane whose signals are unchanged is reused, no git spawned;
 *   - every change that could hold work still forces a re-probe: a new untracked file (root or one level down),
 *     an in-place edit of a root file, a commit, a lease; a deep in-place edit is bounded by the reuse window;
 *   - `--no-cache`, a list-cache TTL of 0, and `--lane-clean-reuse-ms=0` all keep the old always-probe scan;
 *   - an overrunning scan returns the lanes it already PROVED acquirable (a lower bound, never cached) instead
 *     of failing the whole read — and still fails when it proved none.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync, utimesSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir, traceLog;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=speedtest', '--branch=main', '--no-install', '--no-reap'];
const pool = () => join(poolRoot, 'speedtest');
const lanePath = (n) => join(pool(), `lane-${n}`);
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const lanesOf = (out) => JSON.parse(out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
// `--cache-ttl-ms=1`: the whole-list cache is effectively always a miss, so every call really scans — what is
// under test is the per-lane reuse INSIDE that scan, not the whole-list cache.
function list(extra = [], extraEnv = {}) {
  const r = runPool(['list', '--acquirable', '--json', '--cache-ttl-ms=1', ...REPO(), ...extra], extraEnv);
  expect(r.code, r.err).toBe(0);
  return lanesOf(r.out);
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}
function trace() {
  if (!existsSync(traceLog)) return [];
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [cwd, args] = l.split('\t');
    return { cwd, args };
  });
}
const resetTrace = () => rmSync(traceLog, { force: true });
const inLane = (t, n) => t.cwd === realpathSync(lanePath(n)) || t.cwd.startsWith(realpathSync(lanePath(n)) + '/');
const statusLanes = () => [1, 2, 3, 4].filter((n) => existsSync(lanePath(n)) && trace().some((t) => inLane(t, n) && t.args.startsWith('status')));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const CACHE = () => join(pool(), '.list-acquirable-cache.json');
// Bump a file's mtime (and so its ctime) without touching its bytes — "something rewrote it".
const touchFuture = (p) => { const t = new Date(Date.now() + 5_000); utimesSync(p, t, t); };

let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-speed-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  mkdirSync(join(referenceDir, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(referenceDir, 'sub', 'deep', 'x.txt'), 'x\n');
  git(['add', 'file.txt', 'sub'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-speed-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shimDir);
  // Logging shim. `GIT_SHIM_SLOW_CWD`: a call from that dir `exec`s a long sleep instead of git (exec, so the
  // scan's timeout kill reaches the sleeping pid itself and its pipes close at once).
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$GIT_TRACE_LOG"\n` +
      `if [ -n "$GIT_SHIM_SLOW_CWD" ] && [ "$(pwd -P)" = "$GIT_SHIM_SLOW_CWD" ]; then exec sleep 30; fi\n` +
      `exec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('xkv3p37 per-lane reuse of a clean verdict', () => {
  it('a re-scan re-probes ONLY the lane whose index changed — the unchanged clean lanes run no git', () => {
    provision(3);
    expect(list()).toEqual([1, 2, 3]);
    sleep(20);
    touchFuture(join(lanePath(1), '.git', 'index')); // e.g. an agent's read-only `git status` refreshed lane-1's index
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    expect(statusLanes()).toEqual([1]);
  });

  it('a new untracked file at the lane root is seen on the very next scan', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    writeFileSync(join(lanePath(2), 'scratch.txt'), 'work\n');
    expect(list()).toEqual([1]);
  });

  it('a new untracked file one level down is seen on the very next scan', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    writeFileSync(join(lanePath(2), 'sub', 'new.txt'), 'work\n');
    expect(list()).toEqual([1]);
  });

  it('an in-place edit of a root-level tracked file is seen on the very next scan', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    writeFileSync(join(lanePath(2), 'file.txt'), 'v1\nUNCOMMITTED\n');
    expect(list()).toEqual([1]);
  });

  it('a deep in-place edit is bounded by the reuse window (--lane-clean-reuse-ms)', () => {
    provision(2);
    expect(list(['--lane-clean-reuse-ms=300'])).toEqual([1, 2]);
    writeFileSync(join(lanePath(2), 'sub', 'deep', 'x.txt'), 'x\nUNCOMMITTED\n');
    sleep(450);
    expect(list(['--lane-clean-reuse-ms=300'])).toEqual([1]);
  });

  it('a commit (work ahead of origin) is seen on the very next scan', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    writeFileSync(join(lanePath(2), 'file.txt'), 'v2\n');
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-am', 'local work'], lanePath(2));
    expect(list()).toEqual([1]);
  });

  it('a lease taken on a reused lane drops it at once', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    expect(runPool(['acquire', '--lane=2', ...REPO(), '--no-reset', '--session=foreign-holder']).code).toBe(0);
    expect(list()).toEqual([1]);
  });

  it('--no-cache, a list-cache TTL of 0, and --lane-clean-reuse-ms=0 each keep the always-probe scan', () => {
    provision(2);
    expect(list()).toEqual([1, 2]);
    for (const [extra, extraEnv] of [[['--no-cache'], {}], [[], { LANE_POOL_LIST_CACHE_TTL_MS: '0' }], [['--cache-ttl-ms=1', '--lane-clean-reuse-ms=0'], {}]]) {
      resetTrace();
      const r = runPool(['list', '--acquirable', '--json', ...REPO(), ...extra], extraEnv);
      expect(r.code, r.err).toBe(0);
      expect(statusLanes()).toEqual([1, 2]);
    }
  });
});

describe('xkv3p37 a scan that runs out of budget returns what it proved', () => {
  it('returns the lanes already proven acquirable (exit 0, a warning, nothing cached)', () => {
    provision(2);
    const r = runPool(
      ['list', '--acquirable', '--json', '--scan-timeout-ms=6000', ...REPO()],
      { GIT_SHIM_SLOW_CWD: realpathSync(lanePath(2)) },
    );
    expect(r.code, r.err).toBe(0);
    expect(lanesOf(r.out)).toEqual([1]);
    expect(r.err).toMatch(/ran out of its 6000ms budget at lane-2.*1 lane\(s\) already proven/);
    expect(existsSync(CACHE())).toBe(false);
  }, 30_000);

  it('still fails when the budget ran out before any lane was proven', () => {
    provision(2);
    const r = runPool(
      ['list', '--acquirable', '--json', '--no-cache', '--scan-timeout-ms=1500', ...REPO()],
      { GIT_SHIM_SLOW_CWD: realpathSync(lanePath(1)) },
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/scan exceeded its 1500ms budget/);
    expect(r.out).toBe('');
  }, 30_000);
});
