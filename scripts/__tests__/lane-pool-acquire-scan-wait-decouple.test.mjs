/**
 * @file scripts/__tests__/lane-pool-acquire-scan-wait-decouple.test.mjs
 * @description Proof of the #3383 coordinator follow-up (live-caught 2026-09-24 16:25 ET, on top of #2602's
 *   own scan-sharing fix): 7 concurrent review dispatches, each `acquire --wait-ms=30000`, all failed
 *   reporting "65 all held/dirty" while ~13 lanes were genuinely acquirable — because the SHARED scan itself
 *   took ~56s under load, longer than any one caller's own `--wait-ms`. #2602's own cut still tied the
 *   scan's OWN timeout to `Math.max(remainingMs, ACQUIRE_POLL_MS)` — a caller with little wait-ms left could
 *   truncate a scan a DIFFERENT, longer-lived caller was relying on (the single-flight lock is pool-wide),
 *   and a caller could itself inherit whichever other caller's smaller budget started the scan it joined.
 *
 *   The fix: the scan's own budget is now ALWAYS the full configured/default `--scan-timeout-ms` /
 *   `LANE_POOL_LIST_SCAN_TIMEOUT_MS`, independent of any one caller's `--wait-ms` — `--wait-ms` bounds only
 *   how long an acquire call may keep POLLING for a lane to free up once a scan has answered, never the scan
 *   itself. Two consequences proven here:
 *   1. A small `--wait-ms` never gets the OLD misleading false "all held/dirty" (this file's original
 *      complaint) — but per the LATER xj2k2pp fix (soak break `lane-acquire-under-load`, epic #3383/#4075:
 *      "acquire honours its --wait-ms as a real deadline"), it also no longer silently blocks past its OWN
 *      wait-ms waiting for a DIFFERENT, longer-lived caller's shared scan to finish — 5-concurrent-caller soak
 *      evidence showed that wait, unbounded, compounding across repeated scan rounds into a 3.4x-of-wait-ms
 *      "serialized staircase". It now fails FAST, at its own wait-ms (`acquirableListCached`'s
 *      `callerDeadlineMs`), with its own clearly labeled reason — "lock contention" — which still, like
 *      before, is explicitly NEVER the misleading "all held/dirty" this file exists to rule out; it is simply
 *      an honest "don't know yet, gave up waiting on someone else" instead of either extreme.
 *   2. When a scan genuinely never finishes within its own (now-independent) budget, the failure message
 *      says so explicitly ("the acquirability scan itself did not finish"), never the misleading "N all
 *      held/dirty" — and the SEPARATE growth-on-empty fix (#3383 bug 1) refuses to fire on that signal,
 *      since an incomplete scan is not evidence the pool is genuinely starved.
 *
 *   Real throwaway origin + pool + a logging/sleeping PATH `git` shim, same harness shape as this file's own
 *   sibling `lane-pool-acquire-shares-scan-cache.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=scanwait', '--branch=main', '--no-install', '--no-reap'];
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 20_000 });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runPoolAsync(args, extraEnv = {}) {
  const startedAt = Date.now();
  return new Promise((res) => {
    const c = spawn('node', [SCRIPT, ...args], { env: env(extraEnv) });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    // #xj2k2pp — `ms` (wall-clock duration) lets the lock-contention case below assert boundedness, not just
    // the message text.
    c.on('close', (code) => res({ code, out, err, ms: Date.now() - startedAt }));
  });
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}
function listLanes() {
  const r = runPool(['list', '--json', ...REPO(), '--no-cache']);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-scanwait-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-scanwait-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  mkdirSync(shimDir);
  // A `git` shim: real git for everything, but every invocation sleeps `GIT_SHIM_SLEEP` seconds first —
  // stands in for a slow/loaded host, the exact condition the live incident traced to.
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nif [ -n "$GIT_SHIM_SLEEP" ]; then sleep "$GIT_SHIM_SLEEP"; fi\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool acquire (#3383 coordinator follow-up) — the scan budget is independent of --wait-ms', () => {
  it('a small --wait-ms no longer waits out a slower SHARED scan it lost the lock race for — never the false "all held/dirty", now a fast, honest "lock contention" instead', async () => {
    provision(2);
    // Dirty lane-1's tracked file so evaluating it costs a REAL git call (status --porcelain), which the
    // slow shim delays — a genuinely slow scan, not an instant one. lane-2 stays clean: the one real
    // candidate a correctly-unbounded scan will find.
    writeFileSync(join(poolRoot, 'scanwait', 'lane-1', 'file.txt'), 'v1\ndirty\n');

    // Each git call sleeps 0.5s (empirically ~7s wall-clock for this 2-lane pool's full scan — real git
    // spawn overhead adds up beyond the raw sleep total). Both callers ask for only 1s of --wait-ms (far
    // smaller than the scan itself needs), but a generous --scan-timeout-ms (15s) so the scan can actually
    // finish (for whichever caller wins the lock and runs it). `--hard-max=2` pins the SEPARATE
    // growth-on-empty fix's ceiling at this pool's real size — not this test's subject.
    const rs = await Promise.all(
      [1, 2].map((i) => runPoolAsync(
        ['acquire', ...REPO(), `--session=caller-${i}`, '--wait-ms=1000', '--scan-timeout-ms=15000', '--hard-max=2'],
        { GIT_SHIM_SLEEP: '0.5' },
      )),
    );
    const succeeded = rs.filter((r) => r.code === 0);
    const failed = rs.filter((r) => r.code !== 0);
    // The lock WINNER still runs the real (slow but successful, unbounded-by-its-own-wait-ms) scan and gets
    // the one real acquirable lane, exactly as before.
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].out.trim()).toBe(join(poolRoot, 'scanwait', 'lane-2'));
    expect(failed).toHaveLength(1);
    // The lock LOSER (xj2k2pp): no longer sits out the winner's ~7s scan just because its own wait-ms was
    // small — it gives up at its OWN --wait-ms (1000ms) with an honest "lock contention" reason, still never
    // the misleading "all held/dirty" this file's ORIGINAL fix exists to rule out (the truth is simply not
    // known yet when this caller gives up — a different fact from "a completed scan found nothing").
    expect(failed[0].err).toMatch(/no lane within 1000ms in pool "scanwait"/);
    expect(failed[0].err).toMatch(/lock contention/i);
    expect(failed[0].err).not.toMatch(/all held\/dirty/);
    expect(failed[0].err).not.toMatch(/scan itself did not finish/);
    // Bounded: the loser's total wall time reflects ITS OWN wait-ms (1000ms), not the ~7s the winner's real
    // scan took — generous margin (4s) for process/git spawn overhead, never the scan's own cost.
    const loserIdx = rs[0].code === 0 ? 1 : 0;
    expect(rs[loserIdx].ms).toBeLessThan(4000);
  }, 30_000);

  it('when a scan genuinely never finishes in time, the message says so — never the misleading "all held/dirty" — and growth does not fire', () => {
    provision(2);
    const before = listLanes();
    // Every git call sleeps 2s; a 2-lane scan needs several such calls. --scan-timeout-ms=1000 can never
    // let it finish.
    const r = runPool(
      ['acquire', ...REPO(), '--session=picker', '--wait-ms=500', '--scan-timeout-ms=1000'],
      { GIT_SHIM_SLEEP: '2' },
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/acquirability scan itself did not finish/);
    expect(r.err).not.toMatch(/all held\/dirty/);
    // Growth (the separate #3383 bug-1 fix) must refuse to fire here: an incomplete scan is not proof the
    // pool is starved, so no new lane may be cloned on the strength of it alone.
    expect(listLanes()).toEqual(before);
  }, 20_000);
});
