/**
 * @file scripts/readiness/__tests__/scope-lease-collect-per-lane-bounded-spawn.test.mjs
 * @description Spawn-count budget test for `scope-lease-collect.mjs`'s per-lane git reads, named as a candidate
 *   in x3xz8qp/#3988 (the work-bound-tests item this file answers): "scope-lease-collect.mjs's per-lane `git
 *   remote get-url`/lease reads". Follows the SAME technique `lane-pool-ahead-provably-pushed-single-spawn.
 *   test.mjs` (#2920) and `lane-pool-ahead-patch-equivalent-bounded-spawn.test.mjs` (#3383-perf) pin for
 *   `lane-pool.mjs` — a PATH-shimmed `git` counting wrapper over a REAL, throwaway lane pool — extended to this
 *   file's own per-lane git fan-out.
 *
 *   AUDIT RESULT (see this item's PR description for the full trace): `main()`'s `observedForLane` closure runs
 *   UP TO SIX git spawns per lane (`remote get-url` once via `repoKeyForLane`'s cache, `merge-base`, two
 *   `rev-list --count` ahead/behind checks, `diff --name-only`, `status --porcelain`) and is itself MEMOIZED per
 *   lane path so `collectSnapshot` + the `itemsForLane` derivation never double it. None of those six spawns
 *   fan out over remote HEADS or over any OTHER lane — each lane's cost is a fixed constant, so the total is
 *   O(lanes), never O(lanes × heads). That per-lane linear cost is INHERENT (each lane genuinely needs its own
 *   ahead/behind/diff/status read) — the property worth pinning is that it stays exactly that, and never grows a
 *   silent per-remote-head or per-OTHER-lane term the way `lane-pool.mjs`'s `git cherry`/`merge-base` loops did
 *   (#2542/#2547/#2920).
 *
 *   The test provisions a REAL throwaway lane pool (`LANE_POOL_ROOT` — never the shared real pool, enforced by
 *   `lane-pool.mjs`'s own `guardedPoolRoot` vitest guard, #3383/#2552) with MANY lanes, inflates the remote with
 *   MANY unrelated filler branches (so a regressed per-head loop would have plenty to churn through), and asserts
 *   the TOTAL git spawn count (this file's own six-per-lane reads, PLUS the `lane-pool.mjs status` sub-call's own
 *   four-per-lane reads it shells to build the pool picture) stays within a budget that scales with LANE COUNT
 *   only — a budget an O(lanes × heads) regression would blow through by roughly two orders of magnitude, while
 *   the correct O(lanes) implementation clears it comfortably. Spawn counts only, never wall time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** A minimal, valid `.lane-lease` marker (see `scripts/lib/lane-lease.mjs`'s `leaseBody`) — just enough for
 *  `isLeaseStale` to read it as LIVE (a fresh `acquiredAt`, well under the default 240-minute TTL). Written
 *  directly rather than via `lane-pool.mjs acquire` (which would ALSO run its own auto-pick git reads per lane,
 *  the exact O(n) setup cost this test does not want to pay N times over) — `collectSnapshot` only walks
 *  LEASED lanes ("active work streams"), so a provisioned-but-never-acquired lane is invisible to it and would
 *  make this test assert nothing about the per-lane git fan-out it exists to budget.
 */
function writeLeaseMarker(laneDir, session) {
  mkdirSync(join(laneDir, '.git'), { recursive: true });
  writeFileSync(join(laneDir, '.git', '.lane-lease'), JSON.stringify({
    session, acquiredAt: new Date().toISOString(), ttlMinutes: 240, host: 'test', pid: 1,
  }));
}

const HERE_ROOT = process.cwd(); // vitest runs from the repo root — matches the sibling lane-pool spawn tests.
const POOL_CLI = join(HERE_ROOT, 'scripts', 'lane-pool.mjs');
const COLLECT_CLI = join(HERE_ROOT, 'scripts', 'readiness', 'scope-lease-collect.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function gitc(args, cwd) {
  return git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', ...args], cwd);
}

let base, originDir, referenceDir, poolRoot;
const POOL_NAME = 'scopespawn';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'scope-lease-bound-spawn-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  gitc(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function poolEnv(extra = {}) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — matches the sibling lane-pool spawn tests: without it
  // every command falls back to the real default pool root, colliding with the LIVE pool this task runs under.
  // VITEST is already set by the runner; `guardedPoolRoot` accepts that because LANE_POOL_ROOT is explicit.
  return { ...process.env, LANE_POOL_ROOT: poolRoot, ...extra };
}

function provision(count) {
  const r = spawnSync('node', [
    POOL_CLI, 'provision', `--count=${count}`,
    `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${POOL_NAME}`, '--branch=main', '--no-install',
  ], { encoding: 'utf8', env: poolEnv() });
  if (r.status !== 0) throw new Error(`provision failed: ${r.stderr}`);
  // Lease every provisioned lane (see `writeLeaseMarker`'s own comment on why this is written directly).
  for (let n = 1; n <= count; n++) {
    writeLeaseMarker(join(poolRoot, POOL_NAME, `lane-${n}`), `test-session-${n}`);
  }
}

/** Inflate origin with `n` unrelated one-commit filler branches, from a throwaway clone. */
function addFillerHeads(n) {
  const filler = join(base, 'filler');
  git(['clone', '--quiet', originDir, filler]);
  for (let i = 0; i < n; i++) {
    writeFileSync(join(filler, `filler-${i}.txt`), `filler-${i}\n`);
    git(['add', '.'], filler);
    gitc(['commit', '--quiet', '-m', `filler ${i}`], filler);
    git(['push', '--quiet', 'origin', `HEAD:refs/heads/lane/filler-${i}`], filler);
    git(['reset', '--quiet', '--hard', 'origin/main'], filler);
  }
}

/** Every `git` process spawned WHILE `fn` runs, via a PATH-shimmed counting wrapper (same technique as the
 *  sibling `lane-pool-ahead-*-spawn.test.mjs` files — a real `git` underneath, just logged). */
function countGitSpawnsDuring(fn) {
  const shimDir = join(base, 'bin');
  mkdirSync(shimDir, { recursive: true });
  const spawnLog = join(base, 'git-spawns.log');
  writeFileSync(spawnLog, '');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shimDir, 'git'), `#!/bin/bash\necho "$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  const result = fn({ PATH: `${shimDir}:${process.env.PATH}` });
  const spawnCount = Number(execFileSync('wc', ['-l', spawnLog], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  return { result, spawnCount };
}

function runCollect(extraEnv) {
  // cwd = the throwaway reference clone, NOT the real checkout: the collector probes `git rev-parse origin/main`
  // in its own cwd, which hermetic tests forbid inside the real checkout.
  const r = spawnSync('node', [
    COLLECT_CLI, '--json', '--no-track-attempts', `--repo=${referenceDir}`, `--name=${POOL_NAME}`,
  ], { encoding: 'utf8', env: poolEnv(extraEnv), cwd: referenceDir });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const N_LANES = 40;
const N_FILLER_HEADS = 60; // matches the sibling lane-pool spawn tests' own N_FILLER — an established, cheap-enough scale
// Correct O(lanes) behavior: lane-pool.mjs status's own 4 git spawns/lane + this file's own 6/lane = ~10/lane,
// so ~400 for 40 lanes. An O(lanes × heads) regression (the #2542/#2547/#2920 shape) would spend on the order of
// N_LANES * N_FILLER_HEADS = 2400 spawns for the SAME setup. This ceiling sits well above the correct cost and
// well below the regressed one, so it fails loudly on a reintroduced per-head fan-out without being brittle
// about the exact per-lane constant.
const SPAWN_BUDGET = N_LANES * 25;

describe('scope-lease-collect.mjs per-lane git reads — spawn count is O(lanes), never O(lanes × remote-heads) (x3xz8qp/#3988)', () => {
  it(`stays within a lanes-scaled budget and is unmoved by remote-head count (${N_LANES} lanes, ${N_FILLER_HEADS} filler heads)`, () => {
    provision(N_LANES);

    // BASELINE — same lanes, essentially no remote heads beyond `main` itself.
    const before = countGitSpawnsDuring((env) => runCollect(env));
    expect(before.result.code, `stderr: ${before.result.err}`).toBe(0);
    const picture = JSON.parse(before.result.out);
    expect(Array.isArray(picture.leases)).toBe(true);
    expect(picture.leases.length).toBe(N_LANES); // every provisioned+leased lane shows up

    // Inflate the remote with MANY unrelated filler branches — plenty for a regressed per-head loop to churn
    // through — then re-run against the SAME lane set.
    addFillerHeads(N_FILLER_HEADS);
    expect(git(['ls-remote', '--heads', 'origin'], referenceDir).split('\n').filter(Boolean).length)
      .toBeGreaterThanOrEqual(N_FILLER_HEADS);

    const after = countGitSpawnsDuring((env) => runCollect(env));
    expect(after.result.code, `stderr: ${after.result.err}`).toBe(0);

    // 1. Absolute budget: well above the correct O(lanes) cost, well below an O(lanes×heads) regression.
    expect(after.spawnCount, `git spawns: ${after.spawnCount} (budget ${SPAWN_BUDGET}; would be ~${N_LANES * N_FILLER_HEADS} under an O(lanes×heads) regression)`)
      .toBeLessThan(SPAWN_BUDGET);

    // 2. Head-invariance: the SAME lanes cost the SAME (small, fixed per-lane amount) whether the remote has a
    //    handful of heads or many dozen more — allowing generous per-run jitter (lane-pool status's own reads
    //    are not perfectly deterministic in count run-to-run) without allowing anything close to a per-head term.
    expect(after.spawnCount, `before: ${before.spawnCount}, after: ${after.spawnCount}`)
      .toBeLessThan(before.spawnCount + N_LANES * 2);
  }, 120_000);
});
