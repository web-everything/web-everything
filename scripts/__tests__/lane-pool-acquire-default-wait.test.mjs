/** CLI proofs for the bounded default acquire wait, using a private, fully held pool. */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
// Mirrors the fixed `ACQUIRE_POLL_MS` in `we:scripts/lane-pool.mjs` — the test's own timing budgets are
// expressed relative to it so a change to the poll spacing there doesn't silently make this flaky.
const POLL_MS = 1000;

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

describe('lane-pool acquire default bounded wait', () => {
  beforeEach(fullyHeldPool);

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
      expectDefaultWait(exhaustedAcquire([], { LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: value }));
    }, 30_000,
  );
});
