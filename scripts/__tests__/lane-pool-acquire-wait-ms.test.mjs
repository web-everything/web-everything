/**
 * @file scripts/__tests__/lane-pool-acquire-wait-ms.test.mjs
 * @description Proof of the #x3jmao3 fix: live-caught 2026-09-04, a background review session's own
 *   `acquire` (auto-pick, no `--lane`) read the pool as fully held/dirty and gave up on the VERY FIRST
 *   reading — no retry, no backoff — even though the pool freed up again within minutes under real
 *   concurrent load (PR #1908's independent review, `we:backlog/3383-*.md`). `acquire --wait-ms=<total>` is
 *   the fix: an OPT-IN bounded poll (no busy-wait; `sleepSyncMs` reused from `we:scripts/readiness/
 *   drain-lock.mjs`) that lets a momentary capacity flicker self-heal instead of failing instantly. Three
 *   properties proven with a real throwaway origin + reference checkout (mirrors `lane-pool-acquire-stale-
 *   origin.test.mjs`'s own fixture shape), no shared pool root:
 *
 *   1. Omitting `--wait-ms` reproduces TODAY's behavior byte-for-byte: instant failure, same message.
 *   2. `--wait-ms=<bound>` self-heals: a lane released mid-wait (by a real background OS process, since
 *      `spawnSync`'s blocking acquire call would otherwise starve any same-process `setTimeout`/async
 *      callback) is picked up before the bound elapses.
 *   3. `--wait-ms=<bound>` still fails, with the IDENTICAL "no free lane" message, once the bound elapses
 *      on a pool that genuinely never frees up — this is a bounded retry, not an indefinite spin.
 *
 * #xj4tewd — flaky on a busy CI runner: live-caught on PR #2596's and #2634's CI (~11:05Z 2026-09-25, also
 * #2643) as `AssertionError: expected 1030 to be less than 1000` (also 1011, 1003). Property 1's ONLY job is
 * proving "omitting `--wait-ms` never polls at all", but it used to prove that indirectly via a tight
 * `elapsed < ACQUIRE_POLL_MS` wall-clock bound — and on a loaded runner, plain process/git overhead alone
 * (zero polling) can exceed one poll interval, so the assertion false-failed on a perfectly correct run.
 * Fixed by asserting the fact itself: `we:scripts/lane-pool.mjs`'s auto-pick loop now counts its own poll
 * iterations and prints `__ACQUIRE_POLLS__=<n>` to stderr when `LANE_POOL_ACQUIRE_DEBUG=1` (opt-in; no
 * output/behavior change for any real caller). `pollCount === 0` is a load-independent proof that no
 * `sleepSyncMs` ever ran — in fact mathematically guaranteed by `deadline = nowMs + 0`, since
 * `Date.now() < deadline` can never be true once any time at all has passed — strictly stronger than the
 * wall-clock proxy it replaces, not a weaker substitute for it. Properties 2 and 3 keep
 * their wall-clock assertions (their lower bounds are safe — a poll provably HAD to happen — and their
 * upper bounds are generous multiples, not the tight single-interval bound that flaked) but now also assert
 * `pollCount >= 1` for the same load-independent proof that this is the retry path, not a lucky first read.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
// Mirrors the fixed `ACQUIRE_POLL_MS` in `we:scripts/lane-pool.mjs` — the test's own timing budgets are
// expressed relative to it so a change to the poll spacing there doesn't silently make this flaky.
const POLL_MS = 1000;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the real
  // default pool root (~/workspace/.lanes), colliding with any other lane pool of the same --name.
  // LANE_POOL_ACQUIRE_DEBUG=1 (#xj4tewd) makes `acquire` print its poll-iteration count to stderr as
  // `__ACQUIRE_POLLS__=<n>` — a deterministic fact this file asserts on instead of relying on wall time
  // alone. A no-op for every command other than `acquire`'s auto-pick retry loop.
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_ACQUIRE_DEBUG: '1' }),
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// Parses the `__ACQUIRE_POLLS__=<n>` debug marker `runPool` requests above. Returns `null` if the marker
// is absent (e.g. an explicit `--lane=N` acquire, which never runs the auto-pick retry loop at all).
function pollCount(result) {
  const m = result.err.match(/__ACQUIRE_POLLS__=(\d+)/);
  return m ? Number(m[1]) : null;
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-wait-ms-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-wait-ms-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=waitms', '--branch=trunk', '--no-install'];

// Schedule a release DELAYS ms from now, as a genuinely independent OS process — not a same-process
// `setTimeout`, which would never fire while the test's own `spawnSync` acquire call blocks the one JS
// thread. `spawn` (async, non-blocking) forks a `sh -c 'sleep …'` child that outlives the parent's block.
function scheduleRelease(delayMs) {
  const sleepSec = (delayMs / 1000).toFixed(3);
  spawn('sh', ['-c', `sleep ${sleepSec} && node "${SCRIPT}" release --pool=waitms --lane=1 --session=holder`], {
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot }),
    stdio: 'ignore',
    detached: true,
  }).unref();
}

describe('lane-pool acquire --wait-ms bounded retry/backoff on a full pool (#x3jmao3)', () => {
  it('omitting --wait-ms fails INSTANTLY on a full pool — today\'s behavior, unchanged', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const hold = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=holder']);
    expect(hold.code).toBe(0);

    const t0 = Date.now();
    // #3383 — `--hard-max=1` pins acquire's own growth-on-empty ceiling at this pool's real size (1 lane), so
    // this test's actual subject (the wait/poll/fail timing) isn't masked by the SEPARATE growth-on-empty fix
    // just cloning a fresh lane instead of failing.
    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--hard-max=1']);
    const elapsed = Date.now() - t0;

    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
    // #xj4tewd — the load-independent proof: no wait requested ⇒ no poll ever happens, PERIOD (not "usually
    // finishes before one poll interval would have elapsed", which a busy runner's own overhead can violate
    // with zero polling involved — see the file header). A generous wall-clock backstop stays alongside it,
    // only to catch a genuine hang (e.g. a wedged acquirability scan), never as the primary guard.
    expect(pollCount(acquire)).toBe(0);
    expect(elapsed).toBeLessThan(POLL_MS * 15);
  });

  it('--wait-ms=<bound> self-heals once the held lane is released mid-wait', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'waitms', 'lane-1');
    const hold = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=holder']);
    expect(hold.code).toBe(0);

    // Release lands mid-wait (after ~1 poll), well inside the bound.
    scheduleRelease(POLL_MS * 1.2);

    // #xj4tewd — widened from 6000 to 15000: the ORIGINAL bound only needed to clear "release lands after
    // ~1.2 polls", but under CPU load the release process itself (a detached `sh -c 'sleep … && node …'`)
    // can be scheduled late, and this bound must stay well clear of that without becoming the flake.
    const t0 = Date.now();
    const acquire = runPool(['acquire', '--wait-ms=15000', ...poolArgs(), '--session=picker']);
    const elapsed = Date.now() - t0;

    expect(acquire.code, acquire.err).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
    // Had to poll at least once (release didn't land before the first read) but self-healed well before
    // the bound — proves this is the retry path, not a lucky first read. `pollCount` is the load-independent
    // half of that proof; the wall-clock checks stay too (safe: their bounds are a generous multiple of the
    // real minimum, not the single tight interval that flaked in property 1 — see the file header).
    expect(pollCount(acquire)).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeGreaterThanOrEqual(POLL_MS);
    expect(elapsed).toBeLessThan(15000);
  });

  it('--wait-ms=<bound> still fails, with the SAME message, once a genuinely-exhausted pool\'s bound elapses', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const hold = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=holder']);
    expect(hold.code).toBe(0);
    // No release scheduled — the pool stays exhausted for the whole window.

    const waitMs = POLL_MS * 1.5; // spans one poll boundary without running long
    const t0 = Date.now();
    // #3383 — see the note on the sibling case above: pin the growth ceiling at this pool's real size so this
    // test still proves a GENUINELY exhausted pool fails, rather than self-healing via growth instead of wait.
    const acquire = runPool(['acquire', `--wait-ms=${waitMs}`, ...poolArgs(), '--session=picker', '--hard-max=1']);
    const elapsed = Date.now() - t0;

    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane in pool "waitms" \(1 all held\/dirty\)/);
    // `waitMs` (1500ms) spans one poll boundary, so at least one poll provably had to happen — the
    // load-independent half of "bounded, not instant" (pairs with `pollCount === 0` in property 1's fix).
    expect(pollCount(acquire)).toBeGreaterThanOrEqual(1);
    // Bounded, not instant and not unbounded: at least the requested floor, comfortably under a generous
    // multiple of it. #xj4tewd — widened the multiple 3→8: poll granularity can overshoot by more than one
    // interval under CPU load (scheduler jitter delaying `Atomics.wait`'s return), and this bound only needs
    // to stay well short of "unbounded", not track the real overshoot tightly.
    expect(elapsed).toBeGreaterThanOrEqual(waitMs);
    expect(elapsed).toBeLessThan(waitMs + POLL_MS * 8);
  });
});
