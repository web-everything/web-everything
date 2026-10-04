/**
 * @file scripts/__tests__/lane-pool-acquire-refused-lease.test.mjs
 * @description Regression test for #3407 — a refused `acquire` used to leave the lane HELD by the failed
 *   requester instead of restored to its prior (reclaimable/stale) state. `cmdAcquire`'s `#3390` (explicit-lane
 *   dirty/ahead) guard was fixed first (`restoreLeaseAfterRefusedClaim`, called right before that one `fail()`).
 *   This file covers the REMAINING gaps the same card names: the `#2924` post-fetch re-verify-containment
 *   refusal (both the explicit-lane AND auto-pick paths reach it) and a bad `--base=` (`resolveBaseRef`), none
 *   of which rolled the claim back before this fix wrapped the whole post-claim reset/deps sequence in one
 *   try/catch that restores-or-drops the lease on ANY failure in that window.
 *
 *   Live incident this reproduces: 2026-09-24, two refused acquires held lane-1 and lane-11 this way — found
 *   only by hand, via `lane-pool.mjs status`, well after the refusing command had already exited.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const leaseMarker = (lane) => join(lane, '.git', '.lane-lease');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-refused-lease-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-refused-lease-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=refused', '--branch=trunk', '--no-install'];

function shimLsRemoteToLie(staleSha, staleRef) {
  const shimDir = join(base, 'bin');
  mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/bash\n` +
      `if [ "$1" = "ls-remote" ] && [ "$2" = "--heads" ] && [ "$3" = "origin" ]; then\n` +
      `  echo -e "${staleSha}\\trefs/heads/${staleRef}"\n` +
      `fi\n` +
      `exec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
  return shimDir;
}

/** Push an ahead-of-trunk commit under `lane/landed`, then delete that ref on origin — the shape the #2924
 *  re-verify refuses once the pick-time `ls-remote` snapshot is lied to (see the sibling #2924 test file). */
function setUpDanglingAheadCommit(lane) {
  writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
  git(['add', 'file.txt'], lane);
  git(['config', 'user.email', 't@t.com'], lane);
  git(['config', 'user.name', 't'], lane);
  git(['commit', '--quiet', '-m', 'landed'], lane);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed'], lane);
  const landedSha = git(['rev-parse', 'HEAD'], lane);
  git(['update-ref', '-d', 'refs/heads/lane/landed'], originDir);
  return landedSha;
}

describe('#3407 — a refused acquire never leaves the lane held by the failed requester', () => {
  it('EXPLICIT-LANE #3390 dirty/ahead refusal releases the lease it just claimed (the ALREADY-fixed call site — a regression guard, not new coverage)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'refused', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // Landing-freeze fix (lane-leftover-reclaim) — explicit-lane's pre-fetch guard (#3390) now applies the
    // SAME provably-pushed relaxation auto-pick's own candidate check and the #2924 re-verify below already
    // apply (mirrors `list --acquirable`'s own verdict — a dispatched fix/ci-heal brief names a lane explicitly
    // that the scan already vouched for; see the sibling
    // `lane-pool-acquire-explicit-lane-patch-equivalent.test.mjs`). This test's own setup — a stale, not-yet-
    // pruned local `refs/remotes/origin/lane/landed` still pointing at the just-deleted ref — is now exactly
    // the case the pre-claim guard's OWN relaxation looks "pushed", so it no longer refuses here; the refusal
    // now comes from the #2924 re-verify instead, right after `fetchOriginPruneWithRetry` prunes that stale ref
    // for real. Same outcome this test exists to prove either way: refused, and the lease it just claimed is
    // released, never left held.
    setUpDanglingAheadCommit(lane);

    const acquire = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=picker']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no longer provably safe to reset as of this fetch/);
    expect(existsSync(leaseMarker(lane))).toBe(false);

    // And the lane is genuinely free again — a totally different session can now acquire it.
    const retry = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=someone-else', '--force']);
    expect(retry.code).toBe(0);
  });

  it('AUTO-PICK #2924 re-verify refusal ALSO releases the lease it just claimed (the candidate-loop path, not the explicit-lane one)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'refused', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    const landedSha = setUpDanglingAheadCommit(lane);
    const shimDir = shimLsRemoteToLie(landedSha, 'lane/landed');

    // No --lane=N here: auto-pick's own candidate loop must claim lane-1 (the only lane in the pool) itself.
    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no longer provably safe to reset/);
    expect(existsSync(leaseMarker(lane))).toBe(false);
  });

  it('a bad --base=<ref> (resolveBaseRef refusal) also releases the lease it just claimed', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'refused', 'lane-1');

    const acquire = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=picker', '--base=does-not-exist-anywhere']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/does not resolve in lane-1/);
    expect(existsSync(leaseMarker(lane))).toBe(false);
  });

  it('a refused re-acquire of an ALREADY-LIVE own lease restores that live lease, not an empty lane (idempotent re-acquire must survive a later refusal)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'refused', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // First, a REAL successful acquire by "owner" — a live lease now sits on lane-1.
    const first = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=owner']);
    expect(first.code).toBe(0);
    expect(existsSync(leaseMarker(lane))).toBe(true);

    // Now the SAME owner re-acquires (idempotent re-acquire keeps the hold), but this time the #2924 re-verify
    // refuses (dangling ahead commit + lied ls-remote, same shape as above).
    const landedSha = setUpDanglingAheadCommit(lane);
    const shimDir = shimLsRemoteToLie(landedSha, 'lane/landed');
    const second = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=owner'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(second.code).not.toBe(0);

    // The lease must still be there (owner's original hold restored, not dropped) — a refusal must never
    // un-protect a lane an agent is legitimately still working in.
    expect(existsSync(leaseMarker(lane))).toBe(true);
  });

  // #3407 fix item 2 — auto-pick FALLS THROUGH to the next candidate on a provisioning failure, rather than
  // failing the whole command: a requester must not see "no free lane" just because the FIRST candidate it
  // happened to win turned out unprovisionable, as long as a clean one is still available.
  it('AUTO-PICK falls through to a clean second lane when the first candidate fails #2924 re-verify', () => {
    const provision = runPool(['provision', '--count=2', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane1 = join(poolRoot, 'refused', 'lane-1');
    const lane2 = join(poolRoot, 'refused', 'lane-2');
    git(['fetch', '--quiet', 'origin'], lane1);

    const landedSha = setUpDanglingAheadCommit(lane1);
    const shimDir = shimLsRemoteToLie(landedSha, 'lane/landed');

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane2); // fell through to the clean lane, not lane-1
    expect(existsSync(leaseMarker(lane1))).toBe(false); // lane-1's failed claim was released, not left held
    expect(existsSync(leaseMarker(lane2))).toBe(true);
  });

  it('AUTO-PICK, every candidate refused: fails with no-free-lane, and no candidate is left holding a lease', () => {
    const provision = runPool(['provision', '--count=2', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane1 = join(poolRoot, 'refused', 'lane-1');
    const lane2 = join(poolRoot, 'refused', 'lane-2');
    git(['fetch', '--quiet', 'origin'], lane1);
    git(['fetch', '--quiet', 'origin'], lane2);

    const sha1 = setUpDanglingAheadCommit(lane1);
    // A second, independently-ahead-and-deleted ref for lane-2, so BOTH candidates fail the same #2924 check.
    writeFileSync(join(lane2, 'file.txt'), 'v1\nlanded2\n');
    git(['add', 'file.txt'], lane2);
    git(['config', 'user.email', 't@t.com'], lane2);
    git(['config', 'user.name', 't'], lane2);
    git(['commit', '--quiet', '-m', 'landed2'], lane2);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed2'], lane2);
    const sha2 = git(['rev-parse', 'HEAD'], lane2);
    git(['update-ref', '-d', 'refs/heads/lane/landed2'], originDir);

    const shimDir = join(base, 'bin-both');
    mkdirSync(shimDir, { recursive: true });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/bash\n` +
        `if [ "$1" = "ls-remote" ] && [ "$2" = "--heads" ] && [ "$3" = "origin" ]; then\n` +
        `  echo -e "${sha1}\\trefs/heads/lane/landed"\n` +
        `  echo -e "${sha2}\\trefs/heads/lane/landed2"\n` +
        `fi\n` +
        `exec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
    expect(existsSync(leaseMarker(lane1))).toBe(false);
    expect(existsSync(leaseMarker(lane2))).toBe(false);
  });
});
