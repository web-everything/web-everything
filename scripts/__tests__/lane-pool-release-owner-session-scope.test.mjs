/**
 * @file scripts/__tests__/lane-pool-release-owner-session-scope.test.mjs
 * @description Regression test for #x2psfwz — `review-<PR>` / `fix-<PR>` session NAMES carry no attempt
 *   suffix (session-slug.mjs's `mintSessionSlug` forbids one for every PR_KIND), so a round-2 dispatch for the
 *   same PR reuses the EXACT name round 1 used. `release --all-pools --session=<name>` used to match by name
 *   ALONE: a belated cleanup call for round 1's finished session (`--session=review-1234`) would drop ROUND 2's
 *   live lease too, if round 2 had already been dispatched and acquired its own lane under the identical name
 *   before that cleanup ran.
 *
 *   The fix adds an OPTIONAL `--owner-session=<id>` co-selector: when given alongside `--session`, a same-named
 *   lease is only released if its OWN `ownerSession` (the durable `CLAUDE_CODE_SESSION_ID` stamped at acquire,
 *   #2367) also matches. Omitted, behaviour is unchanged (name alone, as every other existing caller expects).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=ownerscope', '--branch=main', '--no-install'];
const laneDir = (n) => join(poolRoot, 'ownerscope', `lane-${n}`);

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-owner-scope-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  execFileSync('bash', ['-c', 'echo v1 > file.txt'], { cwd: referenceDir });
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-owner-scope-'));
  poolRoot = join(base, 'pool');

  expect(runPool(['provision', '--count=2', ...REPO()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#x2psfwz — release --all-pools --session=<reused-name> --owner-session=<id> never drops a different round\'s lease', () => {
  it('round 1 (session A) acquires under "review-1234"; round 2 (session B) REUSES the exact same name on a different lane', () => {
    // Round 1: dispatched under CLAUDE_CODE_SESSION_ID "round-1-uuid".
    const round1 = runPool(['acquire', '--lane=1', ...REPO(), '--session=review-1234', '--adopt'], { CLAUDE_CODE_SESSION_ID: 'round-1-uuid' });
    expect(round1.code).toBe(0);

    // Round 1 finishes and its OWN lease is left in place (a belated/queued cleanup hasn't run yet) — but round
    // 2 has ALREADY been dispatched under a NEW CLAUDE_CODE_SESSION_ID and reuses the identical session name.
    const round2 = runPool(['acquire', '--lane=2', ...REPO(), '--session=review-1234', '--adopt'], { CLAUDE_CODE_SESSION_ID: 'round-2-uuid' });
    expect(round2.code).toBe(0);

    // A belated cleanup for ROUND 1 SPECIFICALLY (its own ownerSession) must drop ONLY lane-1, never lane-2.
    const cleanup = runPool(['release', '--all-pools', '--session=review-1234', '--owner-session=round-1-uuid']);
    expect(cleanup.code).toBe(0);
    expect(existsSync(LEASE_FILE(laneDir(1)))).toBe(false); // round 1's own lease — released
    expect(existsSync(LEASE_FILE(laneDir(2)))).toBe(true);  // round 2's live lease — untouched
    expect(readFileSync(LEASE_FILE(laneDir(2)), 'utf8')).toMatch(/round-2-uuid/);
  });

  it('without --owner-session, --session=<name> alone still sweeps EVERY same-named lease (unchanged default behaviour)', () => {
    const round1 = runPool(['acquire', '--lane=1', ...REPO(), '--session=review-1234', '--adopt'], { CLAUDE_CODE_SESSION_ID: 'round-1-uuid' });
    expect(round1.code).toBe(0);
    const round2 = runPool(['acquire', '--lane=2', ...REPO(), '--session=review-1234', '--adopt'], { CLAUDE_CODE_SESSION_ID: 'round-2-uuid' });
    expect(round2.code).toBe(0);

    const sweep = runPool(['release', '--all-pools', '--session=review-1234']);
    expect(sweep.code).toBe(0);
    expect(existsSync(LEASE_FILE(laneDir(1)))).toBe(false);
    expect(existsSync(LEASE_FILE(laneDir(2)))).toBe(false);
  });

  it('--owner-session without --session is refused — it narrows a by-session release and means nothing alone', () => {
    const bad = runPool(['release', '--all-pools', '--owner-session=round-1-uuid']);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/requires --session/);
  });
});
