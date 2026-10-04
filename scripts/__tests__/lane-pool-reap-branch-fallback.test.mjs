/**
 * @file scripts/__tests__/lane-pool-reap-branch-fallback.test.mjs
 * @description Proof of #xkk4lv7's BRANCH-BASED item-resolution fallback in `deadLeasePlan` (`scripts/lane-pool.mjs`'s
 *   #2748 acquire-native reap backstop) — the exact capacity-cap root cause: a lease acquired via a bare
 *   `lane-pool.mjs acquire --purpose=<slug>` with no dispatcher-recognizable `--session=` is invisible to BOTH
 *   `itemNumFromSession`/`prNumFromSession`, so it rode the 4-hour TTL backstop even once its PR objectively
 *   merged (live evidence: lane-2/lane-9 in the card's own root-cause writeup). Mirrors
 *   `lane-pool-reap-on-acquire.test.mjs`'s own tier-1 harness (real `lane-pool.mjs` child processes, a real
 *   throwaway bare origin + reference, a fake `gh` on PATH, a private `LANE_POOL_ROOT`) — the collapse (and its
 *   fix) is a property of the ALLOCATOR, not of a predicate.
 *
 *   Proves TWO things at once (test plan #7, "acquire-time TTL preserved"):
 *     1. the branch fallback genuinely reclaims a non-dispatcher-session lease once its lane's own checked-out
 *        branch names a merged PR and the corroboration (clean tree, contained HEAD, quiet window) holds; and
 *     2. `deadLeasePlan`'s PRE-EXISTING TTL gate is unchanged by this fix — a FRESH (not yet TTL-stale) lease of
 *        the exact same branch/PR shape is NOT reaped by the acquire-time backstop (only the resident,
 *        never-TTL-gated `lease-reaper.mjs` pass would reclaim that one — this integration proves the backstop's
 *        own existing timing guarantee survived the fix, not that the fix reaches the resident pass too, which
 *        the sibling `lease-reaper.mjs` unit suite already covers directly).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_LEASE_TTL_MINUTES } from '../lib/lane-lease.mjs';
import { DEFAULT_QUIET_MS } from '../conveyor/lease-reaper.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');
// #xkk4lv7 — round-3 convergence (correctness + simplicity, independently): import the real constant rather
// than duplicating its value as a magic number this file must remember to keep in sync by hand.
const QUIET_MINUTES = DEFAULT_QUIET_MS / 60_000;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Write a backlog card at a given status into the reference, commit + push (so origin/main carries it) —
// mirrors `lane-pool-reap-on-acquire.test.mjs`'s own `pushCard`, needed here for the `itemResolvedOnMain`
// provenance-gating regression below.
function pushCard(referenceDir, num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: referenceDir,
    env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function backdateLease(laneDirPath, minutesAgo) {
  const file = LEASE_FILE(laneDirPath);
  const lease = JSON.parse(readFileSync(file, 'utf8'));
  lease.acquiredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(lease, null, 2) + '\n');
}

// A fake `gh` reporting ONE merged PR whose `mergeCommit.oid` is the lane's OWN current HEAD (trivially its own
// ancestor — `git merge-base --is-ancestor <sha> <sha>` exits 0) — i.e. "HEAD is contained in the merge", the
// corroboration `laneQuietSincePr` requires, without needing a real merge event in this throwaway origin.
function fakeGhOnPath(headRefName, mergedAtIso, mergeCommitSha) {
  const binDir = join(base, `ghbin-${Math.random().toString(16).slice(2)}`);
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  const prs = [{ number: 9001, headRefName, state: 'MERGED', mergedAt: mergedAtIso, mergeCommit: { oid: mergeCommitSha } }];
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`, { mode: 0o755 });
  return { PATH: `${binDir}:${process.env.PATH}` };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=branchfallbackpool`, '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'branchfallbackpool', `lane-${n}`);

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-branch-fallback-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-branch-fallback-'));
  poolRoot = join(base, 'pool');

  expect(runPool(['provision', '--count=2', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

// Acquires under a NON-DISPATCHER session (the `Mac:<ppid>`-shaped `defaultSession()` fallback every bare
// `acquire --purpose=` without a recognizable `--session=` mints — see `lane-pool.mjs#defaultSession`), then
// checks the lane out onto a `lane/<num>-<slug>` branch DIRECTLY (bypassing `pr-land`, exactly as the card's own
// live evidence — `soak-gate-merge-base` / `promote-stale-green` — did): the item lives ONLY in the branch name,
// never in `--session=`, which is the entire population this fix exists for.
function acquireOnBranch(lane, itemNum) {
  const session = `Mac:${9_000_000 + lane}`; // deliberately NOT dispatcher-minted (no conveyor-/prepare-/fix- etc)
  const r = runPool(['acquire', `--lane=${lane}`, `--session=${session}`, '--no-reset', '--no-reap', ...poolArgs()]);
  expect(r.code).toBe(0);
  const dir = lanePath(lane);
  git(['checkout', '--quiet', '-b', `lane/${itemNum}-mechanical-pass`], dir);
  const headSha = git(['rev-parse', 'HEAD'], dir);
  return { dir, headSha };
}

describe('lane-pool #xkk4lv7 — deadLeasePlan\'s branch-based fallback reclaims a non-dispatcher-session lease whose lane branch names a merged PR', () => {
  it('a TTL-STALE lease on lane/<num>-* whose PR is MERGED (clean tree, HEAD contained, quiet window elapsed) IS reaped, reason pr-merged', () => {
    const { dir, headSha } = acquireOnBranch(1, 7001);
    // Both the PR's merge and this lease's own acquisition are well past the quiet window (and past TTL) —
    // corroboration + the pre-existing TTL gate both clear.
    const mergedAt = new Date(Date.now() - (QUIET_MINUTES + 60) * 60_000).toISOString();
    const env = fakeGhOnPath('lane/7001-mechanical-pass', mergedAt, headSha);
    backdateLease(dir, DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(false); // reaped
    expect(r.err).toMatch(/reaped lane-1 before acquire \(pr-merged/);
  });

  it('the SAME branch/merged-PR shape but a FRESH lease (seconds old, well within TTL) is NOT reaped — the pre-existing TTL gate is UNCHANGED by this fix (test plan #7)', () => {
    const { dir, headSha } = acquireOnBranch(1, 7002);
    // The PR merged long ago (an old-merged branch, exactly round-3's scenario), but THIS lease is fresh.
    const mergedAt = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const env = fakeGhOnPath('lane/7002-mechanical-pass', mergedAt, headSha);

    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(true); // NOT reaped — deadLeasePlan's own TTL gate never fired
  });

  it('a TTL-STALE lease whose lane ALSO carries new commits beyond the merge point is NEVER reaped as pr-merged on the branch axis', () => {
    const { dir } = acquireOnBranch(1, 7003);
    // A NEW commit on top of what any "merge" could have contained — live, un-landed work in the same lane.
    writeFileSync(join(dir, 'new-work.txt'), 'still working\n');
    git(['add', 'new-work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'new work'], dir);
    const newHead = git(['rev-parse', 'HEAD~1'], dir); // the OLD tip is what the fake PR claims as its merge
    const mergedAt = new Date(Date.now() - (QUIET_MINUTES + 60) * 60_000).toISOString();
    const env = fakeGhOnPath('lane/7003-mechanical-pass', mergedAt, newHead);
    backdateLease(dir, DEFAULT_LEASE_TTL_MINUTES + 60);

    // `reapDeadLeasesInPool` (the cross-lane sweep an acquire runs BEFORE allocating a DIFFERENT lane) only
    // ever acts on `pr-merged`/`pr-closed` — `ttl-stale` is deliberately left to acquire's OWN reclaim path for
    // the SPECIFIC lane being acquired (see that function's own docblock), so acquiring lane-2 here never
    // touches lane-1 on the ttl-stale axis regardless of this fix. What this proves is narrower and exactly
    // what matters: the branch axis correctly REFUSES to corroborate `pr-merged` (HEAD is not contained in the
    // claimed merge point — live, un-landed work in the same lane), so lane-1 is untouched by the sweep, full
    // stop — never wrongly reclaimed as "done" just because its branch names a merged PR.
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(true); // NOT reaped — the branch axis refused to corroborate
    expect(r.err).not.toMatch(/reaped lane-1/);
  });

  // #xkk4lv7 — round-1 convergence (correctness finding): a REAL merge commit (this repo's own `pr-land.mjs`
  // default, `--method=merge --no-ff`) has the lane's own tip as a direct parent, so `git merge-base
  // --is-ancestor` finds it immediately — every case above already proves that path. A SQUASH (or rebase)
  // merge reports a merge commit with NO ancestry relationship to the lane's own commits at all, even though
  // the PR is genuinely, fully landed — `defaultGitIsAncestor`'s `git cherry` fallback (mirroring
  // `lane-pool.mjs`'s own `cherryAllPatchEquivalent`) is what this test proves, through the REAL default git
  // readers (no injected `isAncestor` stub) rather than the pure `laneQuietSincePr` unit tests, which only ever
  // stub containment directly.
  it('a TTL-STALE lease whose PR was SQUASH-merged (the merge commit shares NO ancestry with the lane, only a patch-equivalent diff) IS STILL reaped, via the real git cherry fallback', () => {
    const { dir } = acquireOnBranch(1, 7005);
    // The lane's own "feature" commit — this is what a squash merge would fold into one commit on the base.
    writeFileSync(join(dir, 'feature.txt'), 'the feature\n');
    git(['add', 'feature.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'the feature'], dir);

    // Build the "squash merge" commit on a DISJOINT history root, directly in `referenceDir` — the lane was
    // cloned `--reference` (no `--dissociate`, per `lib/lane-pool-paths.mjs#referenceArgs`), so any object that
    // lands in `referenceDir/.git/objects` stays resolvable from the lane via alternates, with no fetch needed.
    git(['checkout', '--quiet', '-b', 'unrelated-history', 'main'], referenceDir);
    writeFileSync(join(referenceDir, 'unrelated.txt'), 'nothing to do with the feature\n');
    git(['add', 'unrelated.txt'], referenceDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unrelated'], referenceDir);
    // The squash commit itself: the SAME net diff as the lane's own `feature.txt` commit, but built on top of
    // the unrelated commit above — zero shared ancestry with the lane's branch beyond the ORIGINAL common root.
    writeFileSync(join(referenceDir, 'feature.txt'), 'the feature\n');
    git(['add', 'feature.txt'], referenceDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'squash: the feature (#9001)'], referenceDir);
    const squashSha = git(['rev-parse', 'HEAD'], referenceDir);
    git(['checkout', '--quiet', 'main'], referenceDir); // leave the reference clone back on its own integration branch

    const mergedAt = new Date(Date.now() - (QUIET_MINUTES + 60) * 60_000).toISOString();
    const env = fakeGhOnPath('lane/7005-mechanical-pass', mergedAt, squashSha);
    backdateLease(dir, DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(false); // reaped — the cherry-based patch-equivalence fallback fired
    expect(r.err).toMatch(/reaped lane-1 before acquire \(pr-merged/);
  });

  // #xkk4lv7 — round-3/round-5 convergence (standards-conformance, repeatedly): a `mergeCommit.oid` that does
  // NOT resolve to any real object in the lane's own git history (a malformed `gh` response, or a merge commit
  // this lane/reference genuinely hasn't fetched yet — see `defaultGitIsAncestor`'s own doc on that race) must
  // fail CLOSED — through the REAL default git readers (no injected `isAncestor`/`statusPorcelain` stub), which
  // every OTHER test in this file bypasses by construction (they all resolve a REAL, present sha). This is the
  // one case that forces `defaultGitIsAncestor`'s `merge-base --is-ancestor` call to fail on a genuinely
  // unresolvable ref (not the ordinary "exit 1, not an ancestor" answer), proving the null-not-guess path fires
  // against real git, not merely a stubbed contract.
  it('a TTL-STALE lease whose fake gh response names an UNRESOLVABLE mergeCommit sha (never fetched/never real) is NOT reaped — real git fails closed, never guesses', () => {
    const { dir } = acquireOnBranch(1, 7006);
    const bogusSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // well-formed hex, resolves to NOTHING real
    const mergedAt = new Date(Date.now() - (QUIET_MINUTES + 60) * 60_000).toISOString();
    const env = fakeGhOnPath('lane/7006-mechanical-pass', mergedAt, bogusSha);
    backdateLease(dir, DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(true); // NOT reaped — an unresolvable sha corroborates nothing
    expect(r.err).not.toMatch(/reaped lane-1/);
  });

  // #xkk4lv7 — round-1 convergence (standards-conformance + claim-accuracy, independently found): an
  // UNCORROBORATED branch-derived itemNum (no PR at all for it, or an open one) must NEVER be trusted by
  // `itemResolvedOnMain` — a SECOND, independent terminal signal (an offline backlog-card check) that has no
  // clean-tree/contained-HEAD/quiet-window corroboration story of its own. Reproduces the exact hazard: a
  // RETRY branch (`lane/2500b-*`) collapses to the SAME base item number `matchLaneRef` already keys a
  // same-numbered ORIGINAL attempt by — whose backlog card can easily already read `status: resolved` from
  // that earlier, already-landed attempt — while this lane is doing genuinely NEW, live (dirty) work on the
  // SAME item number under a retry.
  it('a TTL-stale, non-dispatcher-session lease on a RETRY branch (lane/2500b-*) whose item 2500 is ALREADY status:resolved on main, but has NO PR of its own and carries live DIRTY work, is NOT reaped via itemResolvedOnMain', () => {
    pushCard(referenceDir, '2500', 'resolved'); // item 2500's ORIGINAL, already-landed attempt
    const { dir } = acquireOnBranch(1, '2500b'); // THIS lease's branch collapses to the SAME base number, 2500
    // Live, uncommitted work in the retry lane — never actually reaped, but proves the gate holds even when
    // the tree is NOT clean (the shape that would be reaped if `itemResolvedOnMain` were still ungated).
    writeFileSync(join(dir, 'retry-work.txt'), 'still working on the retry\n');
    git(['add', 'retry-work.txt'], dir);
    // `gh pr list` reports NOTHING for item 2500 at all — the exact "no PR at all" shape that leaves
    // `resolveLeaseItemNum`'s branch fallback `'branch-uncorroborated'`.
    const env = fakeGhOnPath('lane/9999-unrelated', new Date(Date.now() - (QUIET_MINUTES + 60) * 60_000).toISOString(), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    backdateLease(dir, DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(dir))).toBe(true); // NOT reaped — itemResolvedOnMain never consulted for an uncorroborated branch guess
    expect(r.err).not.toMatch(/reaped lane-1/);
  });
});
