/**
 * @file scripts/__tests__/lane-pool-release-reap-race.test.mjs
 * @description Regression test for #x96v5hl — `release` (and the acquire-native reaper's own reclaim) used to
 *   read a lease ONCE, decide it was reapable/releasable, then `rmSync` the marker much later with no re-check
 *   that it was still the SAME lease — a check-then-act TOCTOU. Between the read and the delete, real wall-
 *   clock time passes (`cleanLaneLitter`'s own git/fs calls for `release`; a `gh pr list` + git ls-tree/show
 *   for the reaper), a window wide enough for the real holder to legitimately release and a brand-new acquirer
 *   to land on the exact same lane. An unconditional `rmSync` in that window destroys the NEW holder's live
 *   lease, believing it is still reclaiming the dead one it judged.
 *
 *   The fix reuses `cmdTrim`'s own `sameLease`-then-`takeMarkerIf` primitive right before the deletion in both
 *   `cmdRelease` and `reapDeadLeasesInPool`: the marker is moved aside ATOMICALLY and kept gone only if it is
 *   STILL, by value, the exact lease that was judged — anything else (a fresh re-acquire that raced in) is put
 *   back untouched.
 *
 *   Proven here for `release` via the same deterministic test-seam barrier `cmdTrim`'s own race test uses
 *   (`lane-pool-trim.test.mjs`): a real background `release --force` is paused (`LANE_POOL_RELEASE_TEST_BARRIER`)
 *   immediately before its final take-or-keep decision, a real concurrent `acquire` lands on the exact same
 *   lane inside that window, then `release` is let through. `reapDeadLeasesInPool` shares the IDENTICAL
 *   `sameLease`/`takeMarkerIf` call shape (see that function's own barrier, `LANE_POOL_REAP_TEST_BARRIER`) —
 *   proving the primitive once, here, covers both call sites; it is not re-proven per site.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=racetest', '--branch=trunk', '--no-install'];
const leaseMarker = (n) => join(poolRoot, 'racetest', `lane-${n}`, '.git', '.lane-lease');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-release-race-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-release-race-'));
  poolRoot = join(base, 'pool');

  const provision = runPool(['provision', '--count=1', ...REPO()]);
  expect(provision.code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#x96v5hl — release never clobbers a lease that changed underneath it (check-then-act TOCTOU)', () => {
  it('a live re-acquire that lands DURING a concurrent --force release survives, not the release', async () => {
    // Someone (session "dead-holder") holds lane-1 — the lease `release --force` will decide to drop.
    const first = runPool(['acquire', '--lane=1', ...REPO(), '--session=dead-holder']);
    expect(first.code).toBe(0);

    const barrier = join(base, 'release-barrier');
    const child = spawn('node', [SCRIPT, 'release', '--lane=1', ...REPO(), '--force'], {
      env: { ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_RELEASE_TEST_BARRIER: barrier },
    });
    const done = new Promise((res) => child.on('exit', res));
    for (let i = 0; i < 600 && !existsSync(`${barrier}.ready`); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${barrier}.ready`)).toBe(true);

    // INSIDE the paused window: the old holder's session genuinely released, and a brand-new session acquired
    // the SAME lane — a live lease now sits where the dead one used to be. `release` already read+decided
    // against the OLD one; it must not act on this new one.
    runPool(['release', '--lane=1', ...REPO(), '--session=dead-holder']);
    const reAcquire = runPool(['acquire', '--lane=1', ...REPO(), '--session=new-live-holder']);
    expect(reAcquire.code).toBe(0);

    writeFileSync(`${barrier}.go`, '');
    await done;

    // THE FIX: the new live lease survives — `release --force` backed off instead of deleting it.
    expect(existsSync(leaseMarker(1))).toBe(true);
    expect(readFileSync(leaseMarker(1), 'utf8')).toMatch(/new-live-holder/);
  });
});
