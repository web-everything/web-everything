/**
 * @file scripts/__tests__/lane-pool-acquire-stale-origin.test.mjs
 * @description Proof of the #2452 Gap 1 fix: `acquire`'s auto-pick judges "ahead" purely against the LOCAL
 *   `origin/<branch>` ref (no per-lane fetch). A lane whose HEAD has already landed on origin under a PUSHED
 *   `lane/*` ref, but whose local `origin/<branch>` ref simply hasn't caught up, used to compute the SAME
 *   `ahead > 0` as a genuinely unpushed lane, so the #2267 data-loss guard over-fired and the whole pool read
 *   as "all held" even though an explicit `acquire --lane=N` (which skips this check) succeeded. The fix
 *   proves "already pushed" against the LIVE remote (one `ls-remote`, taken lazily and only when some lane
 *   looks ahead) before treating an "ahead" lane as recyclable — a purely-local containment check was
 *   unsound, since a remote-tracking ref is exactly as stale as the `origin/<branch>` ref it would vouch for
 *   (see the deleted-ref case below). Fails closed: no proof means the #2267 guard holds. Reproduces the
 *   observed scenario with a real throwaway origin (bare repo) + reference checkout, no shared pool root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the
  // real default pool root (~/workspace/.lanes), colliding with any other lane pool of the same --name.
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-stale-origin-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  // `--initial-branch=trunk` (not `main`) so seeding this throwaway bare origin never trips this checkout's own
  // "no direct push to main" guard — that guard only fires on THIS repo's own commands, but stays out of the way
  // by using a name it never pattern-matches.
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  // Seed the bare origin's `trunk` ref via a lane/* push (allowed) + a direct plumbing ref update (not `git push`,
  // so no guard fires) — establishes a common ancestor both the pool and the reference agree on.
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=staleorigin', '--branch=trunk', '--no-install'];

describe('lane-pool acquire auto-pick stale-origin-ahead false negative (#2452 Gap 1)', () => {
  it('auto-pick SKIPS a false-negative "ahead" lane whose HEAD already landed under a pushed lane/* ref', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'staleorigin', 'lane-1');

    // Fetch once so this lane's local origin/trunk + origin/lane/seed both exist and agree with HEAD.
    git(['fetch', '--quiet', 'origin'], lane);

    // Advance the lane's own HEAD past origin/trunk (a locally-committed, then PUSHED, commit) — but do NOT
    // fetch afterward, so this clone's local origin/trunk ref stays stale (exactly the observed bug: HEAD is
    // "ahead" only of the stale local ref, not of what origin actually has).
    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded via a pushed lane ref\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/batch-landed'], lane);

    // Sanity: local origin/trunk is indeed stale (this exact HEAD reads as "ahead" of it).
    expect(Number(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane))).toBeGreaterThan(0);

    // A fresh acquire (auto-pick, no --lane) must still find this lane free — it must NOT report the pool as
    // "all held/dirty" just because the local origin/trunk ref is behind what's actually landed on origin.
    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker']);
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
  });

  // PR #1022 review, finding 5 — the case above pushes HEAD *directly* to a remote ref, so
  // `aheadIsProvablyPushed` returns at its `remoteShas.has(head)` exact-tip short-circuit and the
  // `merge-base --is-ancestor` loop is never proven true. On the live 38-lane pool the split is the REVERSE:
  // only 2 of 14 clearing lanes match a tip exactly; 12 clear via the ancestor branch. That branch decides
  // whether `acquire` may `checkout -B --force` + `clean -fd` a lane — i.e. whether it may DESTROY work — so
  // it needs a passing assertion, and it needs its LIMIT pinned.
  it('auto-pick clears via the ANCESTOR branch when the containing tip is in the local object store', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'staleorigin', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded, then the branch moved on\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/moving'], lane);
    const laneHead = git(['rev-parse', 'HEAD'], lane).trim();

    // Advance the REMOTE branch one commit past this lane's HEAD, from a separate clone, so the lane's HEAD is
    // an ANCESTOR of the tip and is no longer any tip itself — the shape a landed lane really has.
    const mover = join(base, 'mover');
    git(['clone', '--quiet', '--branch', 'lane/moving', originDir, mover]);
    git(['config', 'user.email', 't@t.com'], mover);
    git(['config', 'user.name', 't'], mover);
    writeFileSync(join(mover, 'file.txt'), 'v1\nlanded, then the branch moved on\nand again\n');
    git(['add', 'file.txt'], mover);
    git(['commit', '--quiet', '-m', 'moved on'], mover);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/moving'], mover);

    expect(git(['ls-remote', '--heads', 'origin'], lane)).not.toContain(laneHead);
    // The proof needs the containing commit LOCALLY (see the sibling test); a normal lane has fetched recently.
    git(['fetch', '--quiet', 'origin'], lane);

    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker']);
    expect(acquire.code, 'the ancestor branch of aheadIsProvablyPushed did not clear the lane').toBe(0);
    expect(acquire.out.trim()).toBe(lane);
  });

  // THE LIMIT, pinned deliberately. `liveRemoteShas` reads tips over the network (`ls-remote`), but
  // `merge-base --is-ancestor <head> <tip>` needs that tip OBJECT locally. When the remote branch advanced and
  // this clone never fetched it, git answers `fatal: Not a valid commit name <sha>` — verified on 2.50.1 —
  // `tryGit` maps that to null, and the lane stays protected. That is the SAFE direction (a lane is never
  // wrongly recycled), so it is incompleteness, not a regression: the lane is merely not reclaimed. Filed.
  it('fails CLOSED when the containing tip is known to the remote but absent locally', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'staleorigin', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/moved-away'], lane);

    const mover2 = join(base, 'mover2');
    git(['clone', '--quiet', '--branch', 'lane/moved-away', originDir, mover2]);
    git(['config', 'user.email', 't@t.com'], mover2);
    git(['config', 'user.name', 't'], mover2);
    writeFileSync(join(mover2, 'file.txt'), 'v1\nlanded\nand moved\n');
    git(['add', 'file.txt'], mover2);
    git(['commit', '--quiet', '-m', 'moved'], mover2);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/moved-away'], mover2);

    // deliberately NO fetch in `lane` — the new tip object is unknown to this clone
    // #3383 — `--hard-max=1` pins acquire's own growth-on-empty ceiling at this pool's actual size (1 lane),
    // so it can't mask "genuinely unproven, must fail" by just cloning a fresh lane instead: this test's whole
    // point is the#2267 guard on the ONE existing lane, not whether a pool CAN be grown.
    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker', '--hard-max=1']);
    expect(acquire.code, 'unproven must stay protected — recycling would destroy work').not.toBe(0);
  });

  it('a GENUINELY unpushed-ahead lane stays protected (never auto-picked) — the #2267 guard is not weakened', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'staleorigin', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // A local-only commit, NEVER pushed anywhere — no remote ref (known or otherwise) contains this HEAD.
    writeFileSync(join(lane, 'file.txt'), 'v1\nnever pushed\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'unpushed'], lane);

    // #3383 — see the note on the sibling case above: pin the growth ceiling at this pool's real size.
    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker', '--hard-max=1']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
  });

  // #2452 review — the hardening case. The first cut proved "pushed" from LOCAL remote-tracking refs
  // (`for-each-ref --contains=HEAD refs/remotes`), which is exactly as stale as the `origin/<branch>` ref the
  // check exists to distrust: deleting a `lane/*` branch on origin (the normal end of a lane's life) leaves
  // its remote-tracking ref behind locally, so HEAD still "contains" into a ref that no longer exists
  // anywhere. Clearing the #2267 guard on that evidence hands a `reset --hard` to a lane whose commits are
  // on NO remote — destroyed work. Ownership of this proof now belongs to the live remote.
  it('a lane whose only containing remote ref was DELETED on origin stays protected (stale local ref is not proof)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'staleorigin', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    writeFileSync(join(lane, 'file.txt'), 'v1\nwork that only ever lived on a since-deleted ref\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'pushed then deleted'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/soon-deleted'], lane);
    git(['fetch', '--quiet', 'origin'], lane); // local refs/remotes/origin/lane/soon-deleted now exists

    // ...and now the branch is deleted on ORIGIN, while this clone keeps its stale remote-tracking ref
    // (no --prune), so a purely-local containment check would still answer "pushed".
    git(['update-ref', '-d', 'refs/heads/lane/soon-deleted'], originDir);
    expect(git(['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes'], lane)).toContain('soon-deleted');

    // The guard must hold: HEAD is on no live remote ref, so the lane is NOT recyclable.
    // #3383 — see the note above: pin the growth ceiling at this pool's real size.
    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker', '--hard-max=1']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
  });
});
