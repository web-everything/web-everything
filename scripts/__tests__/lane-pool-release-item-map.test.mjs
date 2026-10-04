/**
 * @file scripts/__tests__/lane-pool-release-item-map.test.mjs
 * @description Proof of #3466 — `release` (and the lease-reaper's reclaim path, which shells out to `release
 *   --force`) must clear the lane-ports registry entry it releases, mirroring `acquire --item=`'s write
 *   (#2616, see lane-pool-item-map.test.mjs). Before this fix `cmdRelease` did exactly one mutating thing —
 *   drop the lease marker — and never called `unmapLanes`, so a released or reaped lane kept claiming its old
 *   item forever, until some LATER acquire/refresh/remove/map/unmap on that same lane happened to clear it.
 *   That let `conveyor-state.mjs`'s health-stall scan (and the tick status line's `building` count) overcount
 *   real capacity indefinitely.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
// #2452/#2997 — always start from a clean session identity: this test process's OWN `CLAUDE_CODE_SESSION_ID`
// (set because it is itself running inside a Claude Code session) would otherwise leak into every spawned CLI
// call and make two genuinely separate acquire/release invocations read as "the same session" via the durable
// ownerSession fallback — exactly the confusion lane-pool-release-ownership.test.mjs isolates against.
function runPool(args, extraEnv = {}, opts = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env, ...opts });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-release-item-map-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'main-tip\n');
  writeFileSync(join(referenceDir, '.gitignore'), '.env.local\n');
  git(['add', 'file.txt', '.gitignore'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-release-item-map-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const registryPath = () => join(referenceDir, '.claude', 'lane-ports.json');
const readRegistry = () => JSON.parse(readFileSync(registryPath(), 'utf8'));

function provision(count, name) {
  const r = runPool(
    ['provision', `--count=${count}`, `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install'],
    { LANE_POOL_ROOT: poolRoot },
  );
  expect(r.code).toBe(0);
}
function acquire(extra, name) {
  return runPool(
    ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install', ...extra],
    { LANE_POOL_ROOT: poolRoot },
  );
}
function release(extra, name) {
  return runPool(
    ['release', `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', ...extra],
    { LANE_POOL_ROOT: poolRoot },
  );
}

describe('lane-pool release clears the lane-ports registry entry (#3466)', () => {
  it('release --lane=N drops that lane\'s item(s) from the registry', () => {
    provision(1, 'basetest');
    expect(acquire(['--lane=1', '--item=3466'], 'basetest').code).toBe(0);
    expect(readRegistry()).toEqual({ 3466: { lane: 1, repo: 'basetest' } });

    const r = release(['--lane=1', '--force'], 'basetest');
    expect(r.code).toBe(0);

    // The registry file itself is written empty (unmapLanes drops the key and rewrites), not left stale.
    expect(readRegistry()).toEqual({});
    expect(r.err).toMatch(/unmapped item\(s\) 3466/);
  });

  it('release --all drops every released lane\'s item(s), leaving unreleased mappings intact', () => {
    provision(2, 'basetest');
    expect(acquire(['--lane=1', '--item=3466'], 'basetest').code).toBe(0);
    expect(acquire(['--lane=2', '--item=3467'], 'basetest').code).toBe(0);
    expect(readRegistry()).toEqual({
      3466: { lane: 1, repo: 'basetest' },
      3467: { lane: 2, repo: 'basetest' },
    });

    const r = release(['--all', '--force'], 'basetest');
    expect(r.code).toBe(0);
    expect(readRegistry()).toEqual({});
  });

  it('the reaper reclaim path (release --force, its exact delegation shape) also clears the registry', () => {
    // scripts/conveyor/lease-reaper.mjs reclaims a dead lease by shelling out to EXACTLY this command shape —
    // `lane-pool.mjs release --pool=<name> --lane=<n> --force`, no `--reference=`/`--origin=`, and (per its own
    // `execFileSync` call) no `cwd` override, so it inherits the reaper's own process cwd. In real use that
    // process always runs from the PRIMARY checkout, which `resolveRepo()` then falls back to as `referencePath`
    // (`resolve(flags.reference || flags.repo || process.cwd())`) — so this test reproduces that by running the
    // release with `cwd: referenceDir`, not by passing `--reference=` (which the real reaper never does).
    provision(1, 'basetest');
    expect(acquire(['--lane=1', '--item=3466'], 'basetest').code).toBe(0);
    const r = runPool(['release', '--pool=basetest', '--lane=1', '--force'], { LANE_POOL_ROOT: poolRoot }, { cwd: referenceDir });
    expect(r.code).toBe(0);
    expect(readRegistry()).toEqual({});
  });

  it('a release that fails ownership (no --force, foreign lease) leaves the registry untouched', () => {
    provision(1, 'basetest');
    expect(acquire(['--lane=1', '--item=3466'], 'basetest').code).toBe(0);

    const r = release(['--lane=1', '--session=some-other-session'], 'basetest');
    expect(r.code).toBe(0); // release logs "not yours" and continues; no hard failure
    expect(r.out + r.err).toMatch(/not yours/);
    expect(readRegistry()).toEqual({ 3466: { lane: 1, repo: 'basetest' } }); // untouched — nothing was released
  });
});

// #3466 review round 2 — `cmdReleaseAllPools` (the SEPARATE `--all-pools` code path) does the identical
// mutating thing (`rmSync(LEASE_MARKER(dir))`) that `cmdRelease` was fixed above, and it is the path
// `scripts/lane-drain.mjs`'s land-time cleanup and `scripts/conveyor/pr-watch.mjs`'s merge-time auto-release
// actually call — the dominant real-world release triggers, not just the reaper's TTL reclaim. Two pools under
// one POOL_ROOT, matching lane-pool-cross-pool.test.mjs's fixture shape (cwd = referenceDir, since
// `resolveRepo()` still runs before `--all-pools` dispatch and needs SOME origin to resolve, even though the
// sweep itself needs no --reference/--repo).
describe('lane-pool release --all-pools clears the lane-ports registry across every pool it touches (#3466)', () => {
  const POOL = (name) => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install'];

  it('--session sweep clears BOTH pools\' item entries, leaving an unrelated session\'s entry intact', () => {
    expect(runPool(['provision', '--count=2', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['provision', '--count=1', ...POOL('poolB')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);

    // couple's WE half + impl half — same session, different pools — plus one unrelated live item elsewhere.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-9999', '--item=9999', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-9999', '--item=9999', ...POOL('poolB')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['acquire', '--lane=2', '--session=other-session', '--item=8888', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);

    // Both acquires were given an explicit `--reference=referenceDir`, so they share ONE registry file; the
    // same `--item=9999` key on both means poolB's acquire (run second) is the one that survives — the
    // pre-existing "same item, last write wins" acquire-time behavior `reverseLaneItemMap`'s own doc comment
    // already accepts, not something this fix changes. What matters here is that release --all-pools clears it.
    expect(readRegistry()).toEqual({
      9999: { lane: 1, repo: 'poolB' },
      8888: { lane: 2, repo: 'poolA' },
    });

    const r = runPool(['release', '--all-pools', '--session=conveyor-9999', '--json'], { LANE_POOL_ROOT: poolRoot }, { cwd: referenceDir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(2); // conveyor-9999's lease in EACH pool (poolA/lane-1, poolB/lane-1)

    // conveyor-9999's entry is gone; the unrelated other-session/#8888 entry survives untouched.
    expect(readRegistry()).toEqual({ 8888: { lane: 2, repo: 'poolA' } });
  });

  it('--item sweep (the drain\'s release-on-land selector) clears the registry the same way', () => {
    expect(runPool(['provision', '--count=1', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-3466', '--item=3466', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(readRegistry()).toEqual({ 3466: { lane: 1, repo: 'poolA' } });

    const r = runPool(['release', '--all-pools', '--item=3466', '--json'], { LANE_POOL_ROOT: poolRoot }, { cwd: referenceDir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1);
    expect(readRegistry()).toEqual({});
  });

  // #3466 PR #1919 review round 2 (independent post-merge review) — `cmdReleaseAllPools` built its own
  // `{ referencePath: resolve(process.cwd()) }` instead of reusing `resolveRepo()`'s already git-toplevel-
  // normalized `repo.referencePath` (which `cmdRelease` already has in scope). `pr-watch.mjs`'s
  // `releaseSessionAcrossPools` — the REAL merge-time auto-release caller — passes no `cwd` override to its
  // `execFileSync` call at all, so it inherits whatever directory that Node process happens to be running
  // from, which need not be the checkout's toplevel. Reproduced here by running the exact same
  // `release --all-pools --item=<num>` shape with `cwd` set to a SUBDIRECTORY of `referenceDir` (never
  // exercised by the sibling tests above, which always pass `cwd: referenceDir` — the toplevel).
  it('--item sweep run with cwd in a SUBDIRECTORY of the reference checkout still clears the CANONICAL registry (no --reference/--origin flags, matching pr-watch.mjs\'s real no-cwd-override call shape)', () => {
    expect(runPool(['provision', '--count=1', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-333', '--item=333', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(readRegistry()).toEqual({ 333: { lane: 1, repo: 'poolA' } });

    const subDir = join(referenceDir, 'sub', 'dir');
    mkdirSync(subDir, { recursive: true });
    const r = runPool(['release', '--all-pools', '--item=333', '--json'], { LANE_POOL_ROOT: poolRoot }, { cwd: subDir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1);
    // The bug: a raw `resolve(process.cwd())` computes the registry path under `<referenceDir>/sub/dir/.claude/
    // lane-ports.json` — a file that never existed — so `unmapLanes` silently no-ops there while the CANONICAL
    // registry at `<referenceDir>/.claude/lane-ports.json` (read by `readRegistry()`) stays stale.
    expect(readRegistry()).toEqual({});
  });
});

// #3466 PR #1919 review round 2 — `unmapLanes` matched registry entries purely by lane NUMBER, ignoring the
// `repo` field each entry already stores. Reproduced via the PRE-EXISTING acquire-time pre-clear
// (`unmapLanes(repo, [chosen])` in `cmdAcquire`, unrelated to this diff's new code but inherited by the fixed
// `cmdRelease`/`cmdReleaseAllPools` too): two different pools that happen to reuse the same lane NUMBER for two
// DIFFERENT items must never cross-clear each other's still-live registry entry.
describe('lane-pool registry unmap does not cross-clear a DIFFERENT pool\'s entry sharing the same lane number (#3466)', () => {
  const POOL = (name) => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install'];

  it('acquiring lane-1 in poolB for a different item leaves poolA\'s lane-1 item untouched', () => {
    expect(runPool(['provision', '--count=1', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['provision', '--count=1', ...POOL('poolB')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);

    expect(runPool(['acquire', '--lane=1', '--session=conveyor-111', '--item=111', ...POOL('poolA')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(readRegistry()).toEqual({ 111: { lane: 1, repo: 'poolA' } });

    // poolB's lane-1 acquire for an UNRELATED item — its pre-clear `unmapLanes(repo, [1])` must filter on
    // `repo` as well as lane number, or it silently wipes poolA's still-live item-111 entry purely because
    // both pools happen to use lane number 1 — undercounting `building` and losing health-stall visibility
    // for a genuinely live item.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-222', '--item=222', ...POOL('poolB')], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);

    expect(readRegistry()).toEqual({
      111: { lane: 1, repo: 'poolA' },
      222: { lane: 1, repo: 'poolB' },
    });
  });
});
