/**
 * @file scripts/__tests__/lane-pool-stale-reclaim-race.test.mjs
 * @description Regression test for #x96v5hl — `tryClaimLane`'s stale-lease reclaim used to `rmSync` the stale
 *   marker unconditionally, then `wx`-create a fresh one: two concurrent reclaimers of the SAME stale lease
 *   could both "win" (the second one's `rmSync` deletes the FIRST reclaimer's brand-new, live lease; its own
 *   `wx` create then also succeeds), so both callers returned a truthy holder slug believing each held the
 *   lane, while only one lease file actually survives. The fix moves the stale marker aside ATOMICALLY
 *   (`takeMarkerIf`, the same primitive `cmdTrim` already used for its own identical TOCTOU) and only proceeds
 *   if what got moved is still, by value, the exact stale lease just judged.
 *
 *   Proven with the same deterministic barrier technique as the sibling release/reap race test: a real
 *   `acquire --lane=N` is paused (`LANE_POOL_ACQUIRE_RECLAIM_TEST_BARRIER`) immediately before its take-or-keep
 *   decision on a stale lease, a second real concurrent `acquire --lane=N` runs to completion and reclaims the
 *   SAME lane first, then the paused acquire is let through.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
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
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv }) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=stalereclaim', '--branch=trunk', '--no-install'];
const leaseMarker = (n) => join(poolRoot, 'stalereclaim', `lane-${n}`, '.git', '.lane-lease');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-stale-reclaim-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-stale-reclaim-'));
  poolRoot = join(base, 'pool');

  const provision = runPool(['provision', '--count=1', ...REPO()]);
  expect(provision.code).toBe(0);
  // Seed a long-TTL-stale lease on lane-1 — both reclaimers will judge it stale the same way.
  const seed = runPool(['acquire', '--lane=1', ...REPO(), '--session=long-dead', '--ttl-minutes=0']);
  expect(seed.code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#x96v5hl — two concurrent stale-lease reclaimers never both "win"', () => {
  it('the SECOND (paused) reclaimer refuses once the FIRST has already reclaimed the same stale lease', async () => {
    const barrier = join(base, 'reclaim-barrier');
    const paused = spawn('node', [SCRIPT, 'acquire', '--lane=1', ...REPO(), '--session=reclaimer-A'], {
      env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_ACQUIRE_RECLAIM_TEST_BARRIER: barrier }),
    });
    let pausedOut = '';
    paused.stdout.on('data', (d) => { pausedOut += d; });
    const pausedDone = new Promise((res) => paused.on('exit', res));
    for (let i = 0; i < 600 && !existsSync(`${barrier}.ready`); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${barrier}.ready`)).toBe(true);

    // INSIDE the pause: a second, completely independent acquire reclaims the SAME stale lease first.
    const winner = runPool(['acquire', '--lane=1', ...REPO(), '--session=reclaimer-B']);
    expect(winner.code).toBe(0);
    const winnerLeaseBefore = readFileSync(leaseMarker(1), 'utf8');
    expect(winnerLeaseBefore).toMatch(/reclaimer-B/);

    writeFileSync(`${barrier}.go`, '');
    const pausedExitCode = await pausedDone;

    // THE FIX: the paused reclaimer must NOT have clobbered the winner's fresh lease.
    expect(readFileSync(leaseMarker(1), 'utf8')).toBe(winnerLeaseBefore);
    // And it must not have falsely reported success (a truthy holder slug it doesn't actually hold) — an
    // explicit --lane=N with no free alternative fails outright when the lane is unexpectedly gone.
    expect(pausedExitCode).not.toBe(0);
  });
});
