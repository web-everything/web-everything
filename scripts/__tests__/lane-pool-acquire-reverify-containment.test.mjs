/**
 * @file scripts/__tests__/lane-pool-acquire-reverify-containment.test.mjs
 * @description Regression test for #2924 — PR #1042 review residue. `cmdAcquire` used to prove an ahead
 *   lane's containment ONCE, from a `ls-remote` snapshot taken at pick time, then run the merge-base fan-out
 *   (#2920), the O_EXCL claim, and `git fetch origin --prune` before the destructive `checkout -B --force` +
 *   `clean -fd` — with NO re-verification. A `lane/*` ref deleted or force-pushed on origin inside that
 *   window meant acquire could wipe the last local copy of commits that, by the time of the actual reset,
 *   exist on no remote at all.
 *
 *   This test simulates the race deterministically: a `git` PATH shim makes the pick-time `ls-remote --heads
 *   origin` LIE that a since-deleted `lane/*` ref is still live (exactly what a snapshot taken a moment
 *   before the real deletion would have seen), while the real `git fetch --prune` that runs moments later
 *   (unshimmed) correctly prunes the now-gone remote-tracking ref. The fix re-verifies containment on
 *   FRESH post-fetch local refs (`localRemoteShas`, network-free) immediately before the reset and refuses
 *   when the earlier proof no longer holds.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-reverify-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-reverify-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=reverify', '--branch=trunk', '--no-install'];

// Builds a PATH-shimmed `git` that lies on `ls-remote --heads origin` (prepends one extra, now-stale
// `sha\trefs/heads/<ref>` line to the real output) but passes every other invocation straight to the real
// binary — including the `fetch --prune` that must see the TRUE, already-pruned state.
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

describe('acquire re-verifies containment on fresh post-fetch refs before the destructive reset (#2924)', () => {
  it('REFUSES an ahead lane whose only proof-of-pushed ref was deleted between the pick-time snapshot and the reset', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'reverify', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // Commit ahead of trunk, push it ONLY under its own lane/* ref (never onto trunk) — the ordinary shape of
    // a landed-but-not-yet-fast-forwarded lane.
    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed'], lane);
    const landedSha = git(['rev-parse', 'HEAD'], lane);
    expect(Number(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane))).toBeGreaterThan(0);

    // Now delete that ref on origin for real — the window this item is about: something (a manual cleanup, an
    // abandoned-PR sweep, a rebase force-push) removed the ONLY remote proof this lane's commits were ever
    // pushed anywhere, WITHOUT this lane ever having landed on trunk.
    git(['update-ref', '-d', 'refs/heads/lane/landed'], originDir);

    // The shim makes the pick-time `ls-remote` see the ref as still live (simulating a snapshot taken a
    // moment before the real deletion above) — reproducing exactly the stale-proof race #2924 describes.
    const shimDir = shimLsRemoteToLie(landedSha, 'lane/landed');

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no longer provably safe to reset/);
    expect(acquire.err).toMatch(/#2924/);
    // The lane's commit must survive — this is the destroyed-work failure mode the item names as unrecoverable.
    expect(git(['cat-file', '-e', landedSha], lane)).toBe('');
  });

  it('--force still proceeds through the re-verification, same documented override as every other guard here', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'reverify', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed'], lane);
    const landedSha = git(['rev-parse', 'HEAD'], lane);

    git(['update-ref', '-d', 'refs/heads/lane/landed'], originDir);
    const shimDir = shimLsRemoteToLie(landedSha, 'lane/landed');

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--force'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
  });
});
