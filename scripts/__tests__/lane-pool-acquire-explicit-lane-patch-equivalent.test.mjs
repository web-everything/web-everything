/**
 * @file scripts/__tests__/lane-pool-acquire-explicit-lane-patch-equivalent.test.mjs
 * @description Landing-freeze fix (lane-leftover-reclaim, #4000/#3383 follow-up) — live incident, 2026-09-26
 *   (ci-heal-2783): the dispatcher's own `list --acquirable` scan (`effectiveDirtyOrAhead` /
 *   `aheadIsProvablyPushed`) already treats a lane whose only "ahead" commits are patch-equivalent to work
 *   already pushed elsewhere (a squash/rebase merge, or the SAME patch landed under a different lane/session)
 *   as safe to reclaim — but a fix/ci-heal brief NAMES that lane explicitly (`acquire --lane=N`, picked by the
 *   scan), and the explicit-lane path's OWN pre-claim guard used to stay on the RAW `ahead` fact, refusing
 *   without `--force`. That mismatch — the picker says free, the picked path demands `--force` — is exactly
 *   what stalled the heal (an auto-mode classifier denies `--force` as "Interfere With
 *   Workloads"/"Modify Shared Resources").
 *
 *   This suite proves, against a real (throwaway, bare-git) pool via the real CLI: (1) `acquire --lane=N` on a
 *   patch-equivalent-ahead lane now succeeds with NO `--force`, resets the lane, and LOGS what it dropped; (2)
 *   `acquire --lane=N` on a lane with a genuinely unique unpushed commit is UNCHANGED — still refused without
 *   `--force` (the fix must never widen the hole `#2267`/`#3390` exist to close).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the real
  // default pool root (~/workspace/.lanes), colliding with the LIVE pool this very task is running under.
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-explicit-patch-eq-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-explicit-patch-eq-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=explicitpatcheq', '--branch=trunk', '--no-install'];

describe('acquire --lane=N applies the SAME patch-equivalence relaxation `list --acquirable` already does', () => {
  it('reclaims a patch-equivalent-ahead lane with NO --force, and logs what it dropped', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'explicitpatcheq', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // This lane commits some content locally, then the IDENTICAL patch lands on trunk via a squash/rebase from
    // elsewhere (a different sha, same diff) — the classic #3383 shape: HEAD is genuinely "ahead" of the
    // local origin/trunk ref by rev-list count, but every one of those commits is patch-equivalent to
    // something already on the remote.
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    writeFileSync(join(lane, 'file.txt'), 'v1\nsquashed-elsewhere\n');
    git(['add', 'file.txt'], lane);
    git(['commit', '--quiet', '-m', 'leftover from an earlier session'], lane);
    expect(Number(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane))).toBeGreaterThan(0);

    // Land the SAME patch on trunk from a separate clone (a different sha — a real squash-merge does this).
    const landing = join(base, 'landing');
    git(['clone', '--quiet', originDir, landing]);
    git(['config', 'user.email', 't@t.com'], landing);
    git(['config', 'user.name', 't'], landing);
    writeFileSync(join(landing, 'file.txt'), 'v1\nsquashed-elsewhere\n');
    git(['add', 'file.txt'], landing);
    git(['commit', '--quiet', '-m', 'squash-merged'], landing);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], landing);
    // A periodic `refresh`/`provision --acquirable` pass (the real health-watch's own routine upkeep, not
    // this test's business) fetches every lane regularly — simulate that so the lane's local object DB
    // actually HAS the newly-landed squash commit to compare patch-ids against (`ls-remote` alone only lists
    // refs/shas, it never transfers objects).
    git(['fetch', '--quiet', 'origin'], lane);

    // `list --acquirable` already treats this lane as free (this is the dispatcher's own picker — proves the
    // scan side of the incident, not just the acquire side) — `reconcile-fix-dispatch.mjs#freeLaneNumbers`'s
    // own exact call shape.
    const list = runPool(['list', '--acquirable', '--json', ...poolArgs()]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toEqual([lane]);

    // THE FIX: acquire --lane=1 (explicit, exactly what a fix/ci-heal brief runs), NO --force.
    const acquire = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=picker']);
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
    // Logged what it dropped (this suite's other job: a silent reclaim is still a reclaim nobody can audit).
    expect(acquire.err).toMatch(/reclaiming 1 local commit\(s\), already patch-equivalent/);
    expect(acquire.err).toMatch(/leftover from an earlier session/);
    // The lane actually landed on trunk's tip, not stuck on the stale local commit.
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(git(['rev-parse', 'trunk'], originDir));
  });

  it('still REFUSES a lane with a genuinely unique unpushed commit, without --force (#2267/#3390 unchanged)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'explicitpatcheq', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    writeFileSync(join(lane, 'file.txt'), 'v1\nnever pushed anywhere\n');
    git(['add', 'file.txt'], lane);
    git(['commit', '--quiet', '-m', 'real unpushed work'], lane);

    const acquire = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=picker']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/would destroy that work/);
    expect(acquire.err).toMatch(/Use --force/);
    // Never silently reset — the commit is still right there afterward.
    expect(git(['log', '--oneline', '-1'], lane)).toContain('real unpushed work');
  });

  it('still REFUSES a genuinely-dirty (uncommitted) lane, without --force, even with zero ahead commits', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'explicitpatcheq', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);
    writeFileSync(join(lane, 'untracked-scratch.txt'), 'not litter, not committed\n');

    const acquire = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=picker']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/uncommitted change\(s\)/);
  });
});
