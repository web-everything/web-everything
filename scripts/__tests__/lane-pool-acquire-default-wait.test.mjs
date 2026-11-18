/** CLI proofs for the bounded default acquire wait, using a private, fully held pool. */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { replayAcquireDeadline } from '../conveyor/soak/breaks/lane-acquire-default-wait.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
// Mirrors the fixed `ACQUIRE_POLL_MS` in `we:scripts/lane-pool.mjs` — the test's own timing budgets are
// expressed relative to it so a change to the poll spacing there doesn't silently make this flaky.
const POLL_MS = 1000;
const source = readFileSync(SCRIPT, 'utf8');
const waitSetting = source.slice(source.indexOf('const ACQUIRE_DEFAULT_WAIT_MS ='), source.indexOf('// A lane holds a LIVE lease'));
const rawStart = source.indexOf('function acquirableListCachedRaw(');
const cachedList = source.slice(rawStart, source.indexOf('\n}', rawStart) + 2);

// Execute the production policy with a controlled clock/IO: oversized settings need no minute-long sleep,
// and deadline races can be pinned to the exact moment the scan would start.
describe('default acquire scan startup policy', () => {
  it.each(['60001', '9007199254740991'])(
    'clamps oversized safe environment override %s to 60000ms', (value) => {
      expect(runInNewContext(`${waitSetting}\nacquireDefaultWaitMs`, {
        process: { env: { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: value } },
      })).toBe(60_000);
    },
  );

  function probe({ now = 100, deadline = 100, lockAt = now, hit = null, limit = null } = {}) {
    const scan = vi.fn(() => { now = 1000; return ['/lane']; });
    const release = vi.fn();
    const run = () => runInNewContext(`${cachedList}\nacquirableListCachedRaw({}, opts)`, {
      opts: { limit, scanTimeoutMs: 120_000, cacheTtlMs: 5000, scanStartDeadlineMs: deadline },
      Date: { now: () => now },
      lastListWasLockPartial: false, lastScanPartial: false,
      readListCache: () => hit,
      tryTakeListLock: () => { now = lockAt; return true; },
      scanAcquirable: scan, releaseListLock: release,
      readLockOwner: () => null, writeListCache: vi.fn(),
      LIST_LOCK_ORPHAN_GRACE_MS: 1000,
      process: { env: {} },
    });
    return { run, scan, release };
  }

  it.each([null, 1])('refuses a new scan at the default deadline (limit %s)', (limit) => {
    const p = probe({ limit });
    expect(p.run).toThrow(expect.objectContaining({ scanStartDeadline: true }));
    expect(p.scan).not.toHaveBeenCalled();
    if (limit === null) expect(p.release).toHaveBeenCalledOnce();
  });

  it('rechecks expiry after acquiring the scan lock and releases it without scanning', () => {
    const p = probe({ now: 99, lockAt: 101 });
    expect(p.run).toThrow(expect.objectContaining({ scanStartDeadline: true }));
    expect(p.scan).not.toHaveBeenCalled();
    expect(p.release).toHaveBeenCalledOnce();
  });

  it('lets a scan started before expiry finish with its full 120s budget', () => {
    const p = probe({ now: 99 });
    expect(p.run()).toEqual(['/lane']);
    expect(p.scan).toHaveBeenCalledWith({}, expect.objectContaining({ scanTimeoutMs: 120_000 }));
    expect(p.release).toHaveBeenCalledOnce();
  });

  it('still accepts cached evidence after the deadline', () => {
    const p = probe({ hit: ['/cached'] });
    expect(p.run()).toEqual(['/cached']);
    expect(p.scan).not.toHaveBeenCalled();
  });

  it('preserves explicit-wait callers without a scan-start deadline', () => {
    const p = probe({ deadline: null });
    expect(p.run()).toEqual(['/lane']);
    expect(p.scan).toHaveBeenCalledOnce();
  });
});

describe('acquire deadline integration with private IO', () => {
  it('a slow reaper does not consume the polling budget or prevent the first scan', async () => {
    const result = await replayAcquireDeadline({ reaperMs: 60 });
    expect(result.error).toBeNull();
    expect(result.scans).toBe(1);
    expect(result.polls).toBeGreaterThan(0);
    expect(result.claimed).toBe('/fixture/lane-2');
  });

  it('a zero default still scans and claims a free lane without polling', async () => {
    const result = await replayAcquireDeadline({ waitMs: 0, free: true });
    expect(result.error).toBeNull();
    expect(result.scans).toBe(1);
    expect(result.polls).toBe(0);
    expect(result.claimed).toBe('/fixture/lane-1');
  });

  it.each([false, true])('an expired uncached rescan preserves completed evidence for recovery=%s', async (recovery) => {
    const result = await replayAcquireDeadline({ recovery });
    expect(result.error).toBeNull();
    expect(result.scans).toBe(1);
    expect(result.grown).toBe(1);
    expect(result.recovered).toBe(recovery ? 1 : 0);
    expect(result.claimed).toBe(`/fixture/lane-${recovery ? 1 : 2}`);
  });

  it.each(['scanTimeout', 'lockContention'])('never grows or recovers after %s', async (scanFailure) => {
    const result = await replayAcquireDeadline({ scanFailure, recovery: true });
    expect(result.error).not.toBeNull();
    expect(result.claimed).toBeNull();
    expect(result.grown).toBe(0);
    expect(result.recovered).toBe(0);
  });
});

describe('CLI integration with temporary Git repositories', () => {
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  const { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: inheritedWait, ...env } = process.env;
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the real
  // default pool root (~/workspace/.lanes), colliding with any other lane pool of the same --name.
  // LANE_POOL_ACQUIRE_DEBUG=1 (#xj4tewd) makes `acquire` print its poll-iteration count to stderr as
  // `__ACQUIRE_POLLS__=<n>` — a deterministic fact this file asserts on instead of relying on wall time
  // alone. A no-op for every command other than `acquire`'s auto-pick retry loop.
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
    env: withGhStub({ ...env, LANE_POOL_NO_RECOVER: '1', LANE_POOL_ROOT: poolRoot, LANE_POOL_ACQUIRE_DEBUG: '1', ...extraEnv }),
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// Parses the `__ACQUIRE_POLLS__=<n>` debug marker `runPool` requests above. Returns `null` if the marker
// is absent (e.g. an explicit `--lane=N` acquire, which never runs the auto-pick retry loop at all).
function pollCount(result) {
  const m = result.err.match(/__ACQUIRE_POLLS__=(\d+)/);
  return m ? Number(m[1]) : null;
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-default-wait-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  // The pool's primary checkout (a sibling of the reference): `release --pool=waitms` proves lane work against that
  // primary's canonical origin and refuses when it cannot resolve one.
  git(['clone', '--quiet', '--branch=trunk', originDir, join(fixtureRoot, 'waitms')]);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-default-wait-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=waitms', '--branch=trunk', '--no-install'];

// Every case holds the only lane and disables growth, so failure must exercise the wait policy.
function fullyHeldPool() {
  const provision = runPool(['provision', '--count=1', ...poolArgs()]);
  expect(provision.code, provision.err).toBe(0);
  const hold = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=holder']);
  expect(hold.code, hold.err).toBe(0);
}

function exhaustedAcquire(extraArgs = [], extraEnv = {}) {
  const started = Date.now();
  const result = runPool([
    'acquire', ...poolArgs(), '--session=picker', '--hard-max=1', '--no-free-list', ...extraArgs,
  ], extraEnv);
  expect(result.code, result.err).not.toBe(0);
  expect(result.err).toMatch(/no free lane in pool "waitms" \(1 all held\/dirty\)/);
  return { ...result, elapsed: Date.now() - started };
}

function expectDefaultWait(result) {
  expect(pollCount(result)).toBeGreaterThan(0);
  expect(result.elapsed).toBeGreaterThanOrEqual(8000);
  // Generous hang backstop; zero-poll checks below use the deterministic debug marker.
  expect(result.elapsed).toBeLessThan(20_000);
}

it('env=0 acquires a free lane on the first uncached scan', () => {
  const provision = runPool(['provision', '--count=1', ...poolArgs()]);
  expect(provision.code, provision.err).toBe(0);
  const result = runPool(['acquire', ...poolArgs(), '--session=picker', '--no-free-list', '--cache-ttl-ms=0'], {
    LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '0',
  });
  expect(result.code, result.err).toBe(0);
  expect(result.out.trim()).toMatch(/lane-1$/);
  expect(result.err.match(/__SCAN_LOCK_HELD_MS__=/g)).toHaveLength(1);
  expect(pollCount(result)).toBe(0);
});

it('a slow reaper IO read still allows the first CLI scan to acquire a free lane', () => {
  fullyHeldPool();
  const provision = runPool(['provision', '--count=2', ...poolArgs()]);
  expect(provision.code, provision.err).toBe(0);
  const preload = join(base, 'slow-reaper.mjs');
  // Delay one lease read specifically inside the reaper; use the real clock and CLI wiring.
  writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
let delayed = false;
fs.readFileSync = function (...args) {
  if (!delayed && String(args[0]).endsWith('.lane-lease') && new Error().stack.includes('deadLeasePlan')) {
    delayed = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    process.stderr.write('__SLOW_REAPER__=1200\\n');
  }
  return read.apply(this, args);
};
syncBuiltinESMExports();
`);
  const result = runPool(['acquire', ...poolArgs(), '--session=picker', '--no-free-list', '--cache-ttl-ms=0'], {
    LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '1000',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`,
  });
  expect(result.err).toContain('__SLOW_REAPER__=1200');
  expect(result.code, result.err).toBe(0);
  expect(result.out.trim()).toMatch(/lane-2$/);
  expect(result.err.match(/__SCAN_LOCK_HELD_MS__=/g)).toHaveLength(1);
}, 30_000);

describe('lane-pool acquire default bounded wait', () => {
  beforeEach(fullyHeldPool);

  it('a zero environment default scans a held pool once and reports known capacity without polling', () => {
    const result = runPool(['acquire', ...poolArgs(), '--session=picker', '--hard-max=1', '--no-free-list', '--cache-ttl-ms=0'], {
      LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '0',
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('no free lane in pool "waitms" (1 all held/dirty)');
    expect(result.err.match(/__SCAN_LOCK_HELD_MS__=/g)).toHaveLength(1);
    expect(pollCount(result)).toBe(0);
  });

  it('omitting --wait-ms polls for the 8000ms default on a fully held pool', () => {
    expectDefaultWait(exhaustedAcquire());
  }, 30_000);

  it('omitting --wait-ms honors a 1500ms environment override and polls', () => {
    const result = exhaustedAcquire([], { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '1500' });
    expect(pollCount(result)).toBeGreaterThan(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(1500);
    expect(result.elapsed).toBeLessThan(8000);
  }, 15_000);

  it('explicit --wait-ms=0 instant-fails with zero polls despite a positive environment default', () => {
    const result = exhaustedAcquire(['--wait-ms=0'], { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '1500' });
    expect(pollCount(result)).toBe(0);
    expect(result.elapsed).toBeLessThan(POLL_MS * 15);
  });

  it.each(['not-a-number', '-1', '9007199254740992'])(
    'invalid environment override %s falls back to the bounded 8000ms default',
    (value) => {
      const result = exhaustedAcquire([], { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: value });
      expectDefaultWait(result);
      expect(result.err).toContain(`invalid LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS=${JSON.stringify(value)}; falling back to 8000ms`);
    }, 30_000,
  );

  it.each([undefined, '1000'])('omitted --wait-ms with environment %s prints no fallback warning', (value) => {
    const result = exhaustedAcquire([], value === undefined ? {} : { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: value });
    expect(result.err).not.toContain('falling back to 8000ms');
  }, 30_000);
});
});
