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
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-wait-ms-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=waitms', '--branch=trunk', '--no-install'];

// Schedule a release DELAYS ms from now, as a genuinely independent OS process — not a same-process
// `setTimeout`, which would never fire while the test's own `spawnSync` acquire call blocks the one JS
// thread. `spawn` (async, non-blocking) forks a `sh -c 'sleep …'` child that outlives the parent's block.
function scheduleRelease(delayMs) {
  const sleepSec = (delayMs / 1000).toFixed(3);
  spawn('sh', ['-c', `sleep ${sleepSec} && node "${SCRIPT}" release --pool=waitms --lane=1 --session=holder`], {
    env: { ...process.env, LANE_POOL_ROOT: poolRoot },
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
    // No wait requested ⇒ no poll ever happens — well under one poll interval.
    expect(elapsed).toBeLessThan(POLL_MS);
  });

  it('--wait-ms=<bound> self-heals once the held lane is released mid-wait', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'waitms', 'lane-1');
    const hold = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=holder']);
    expect(hold.code).toBe(0);

    // Release lands mid-wait (after ~1 poll), well inside the 6s bound.
    scheduleRelease(POLL_MS * 1.2);

    const t0 = Date.now();
    const acquire = runPool(['acquire', '--wait-ms=6000', ...poolArgs(), '--session=picker']);
    const elapsed = Date.now() - t0;

    expect(acquire.code, acquire.err).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
    // Had to poll at least once (release didn't land before the first read) but self-healed well before
    // the 6s bound — proves this is the retry path, not a lucky first read.
    expect(elapsed).toBeGreaterThanOrEqual(POLL_MS);
    expect(elapsed).toBeLessThan(6000);
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
    // Bounded, not instant and not unbounded: at least the requested floor, comfortably under a
    // generous multiple of it (poll granularity can overshoot by up to ~one interval, never open-ended).
    expect(elapsed).toBeGreaterThanOrEqual(waitMs);
    expect(elapsed).toBeLessThan(waitMs + POLL_MS * 3);
  });
});
