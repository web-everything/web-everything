/**
 * @file scripts/__tests__/lane-pool-acquirable.test.mjs
 * @description Proof of the #2426 lease-aware coupling filter in `scripts/lane-pool.mjs`. The parallel
 *   /workflow dispatch coupled item→lane by array position off `list`, which enumerated EVERY lane-N dir
 *   with no lease check — so a lane held by a foreign session's live lease still got an item assigned, and
 *   that item was carried with zero work (the lane's own `git reset --hard` correctly refused to clobber the
 *   foreign lease). The fix: `list --acquirable` filters out any lane holding a live lease or un-pushed work,
 *   and `provision --count=N --acquirable` grows the pool PAST held lanes so N ACQUIRABLE lanes result. These
 *   tests spawn the real CLI against a throwaway local origin + reference checkout (no network, no shared pool
 *   root) and assert: a leased lane drops out of `list --acquirable` (but stays in the bare `list`); a dirty
 *   lane drops out too; and `provision --count=N --acquirable` provisions extra lanes to cover N when a
 *   low-index lane is held.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: withGhStub({ ...process.env, ...extraEnv }) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// Common repo flags every invocation needs (throwaway origin/reference, no npm install).
const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=acqtest', '--branch=main', '--no-install'];
const ENV = () => ({ LANE_POOL_ROOT: poolRoot });

// Lane numbers (basename → N) an invocation printed to stdout as a JSON array of paths.
function listLanes(args) {
  const r = runPool(['list', '--json', ...REPO(), ...args], ENV());
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

function provision(count, extra = []) {
  const r = runPool(['provision', `--count=${count}`, ...REPO(), ...extra], ENV());
  expect(r.code).toBe(0);
  return r;
}

// Lease a specific lane as a FOREIGN session (leaves a live lease, no reset). `ttlMinutes` is stamped INTO the
// lease (it overrides a reader's --ttl-minutes), so pass 0 to mint an already-stale lease.
function leaseLane(n, { session = 'foreign-holder', ttlMinutes } = {}) {
  const ttl = ttlMinutes === undefined ? [] : [`--ttl-minutes=${ttlMinutes}`];
  const r = runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', `--session=${session}`, ...ttl], ENV());
  expect(r.code).toBe(0);
  return join(poolRoot, 'acqtest', `lane-${n}`);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-acq-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-acq-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool list --acquirable (#2426)', () => {
  it('DROPS a live-leased lane from --acquirable, but keeps it in the bare list', () => {
    provision(2);
    leaseLane(1); // lane-1 held by a foreign session

    // Bare list still enumerates every lane (unchanged behaviour a human relies on).
    expect(listLanes([])).toEqual([1, 2]);
    // --acquirable filters the held lane out — a picker never couples an item onto it.
    expect(listLanes(['--acquirable'])).toEqual([2]);
  });

  it('DROPS a dirty (unleased) lane from --acquirable (its reset would fail / clobber)', () => {
    provision(2);
    writeFileSync(join(poolRoot, 'acqtest', 'lane-2', 'file.txt'), 'v1\nUNCOMMITTED\n');

    expect(listLanes([])).toEqual([1, 2]);
    expect(listLanes(['--acquirable'])).toEqual([1]);
  });

  it('a STALE lease does NOT drop the lane (reclaimable ⇒ acquirable)', () => {
    provision(1);
    leaseLane(1, { ttlMinutes: 0 }); // an already-stale lease (0-minute TTL) is reclaimable, so not "held"
    expect(listLanes(['--acquirable'])).toEqual([1]);
  });
});

describe('lane-pool provision --count=N --acquirable (#2426)', () => {
  it('grows PAST a foreign-leased low-index lane so N acquirable lanes result', () => {
    provision(1);
    leaseLane(1); // hold lane-1 before the acquirable provision

    // Ask for 2 ACQUIRABLE lanes: lane-1 is held, so provision must reach lane-3 (lane-2 + lane-3 acquirable).
    const r = provision(2, ['--acquirable']);
    expect(r.out + r.err).toMatch(/ensured 2 acquirable lane/);

    const acq = listLanes(['--acquirable']);
    expect(acq).not.toContain(1); // the held lane is never offered
    expect(acq.length).toBeGreaterThanOrEqual(2); // ≥ N usable lanes exist
    // The two lowest offered lanes are distinct real lanes past the hold.
    expect(acq.slice(0, 2)).toEqual([2, 3]);
  });

  it('without --acquirable, provision --count=N is unchanged (stops at lane-N, held lane included in bare list)', () => {
    provision(1);
    leaseLane(1);
    provision(2); // plain provision: lane-1 (skipped, leased) + lane-2, no growth past the hold
    expect(listLanes([])).toEqual([1, 2]); // exactly 2 lanes exist, not 3
  });
});
