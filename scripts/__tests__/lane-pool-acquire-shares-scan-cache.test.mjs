/**
 * @file scripts/__tests__/lane-pool-acquire-shares-scan-cache.test.mjs
 * @description Proof of #3383's live incident (2026-09-24, review-2582): `acquire`'s own auto-pick used to
 *   recompute the full dirty/ahead probe pipeline (`git status` + `rev-list` + patch-equivalence, via
 *   `effectiveDirtyOrAhead`) for EVERY unleased lane, from scratch, on EVERY `ACQUIRE_POLL_MS` poll tick, in
 *   EACH caller — with no per-iteration time bound at all, so `--wait-ms=<W>` bounded only the gaps BETWEEN
 *   full-pool rescans, never a rescan itself. A real `acquire --wait-ms=30000` under 5 concurrent review
 *   dispatches took ~6 minutes and still failed ("no free lane ... 60 all held/dirty"), while
 *   `lane-pool-health-watch.mjs`'s own read at the same moment showed real spare capacity.
 *
 *   Fixed by having auto-pick consume `list --acquirable`'s own single-flight, cached, `--scan-timeout-ms`-
 *   bounded scan (#xn432dz) as its candidate source, instead of an independent uncached full-pool rescan per
 *   caller per tick. These tests spawn the real CLI against a throwaway local origin + pool (no network) with
 *   a PATH `git` shim (mirrors `lane-pool-list-cache.test.mjs`'s own harness), and assert:
 *   - N concurrent auto-pick `acquire`s each land on a DISTINCT lane (no double-claim), and together issue
 *     roughly ONE shared scan's worth of probe git calls — not N independent full-pool scans;
 *   - an artificially slow scan (an injected per-git-call delay) still makes `acquire --wait-ms=<W>
 *     --scan-timeout-ms=<S>` return within `W + S` plus slack, never anywhere near the unbounded cost a full
 *     rescan-per-tick would take — the exact "the 30s wait doesn't bound the scan" failure mode this closes.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir, traceLog;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=acqcache', '--branch=main', '--no-install', '--no-reap'];
const pool = () => join(poolRoot, 'acqcache');
const lanePath = (n) => join(pool(), `lane-${n}`);
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runPoolAsync(args, extraEnv = {}) {
  return new Promise((res) => {
    const c = spawn('node', [SCRIPT, ...args], { env: env(extraEnv) });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => res({ code, out, err }));
  });
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}
function trace() {
  if (!existsSync(traceLog)) return [];
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [cwd, optionalLocks, args] = l.split('\t');
    return { cwd, optionalLocks, args };
  });
}
const resetTrace = () => rmSync(traceLog, { force: true });
const laneGitCalls = () => trace().filter((t) => t.cwd.startsWith(realpathSync(pool()) + '/lane-'));
const dirty = (n) => writeFileSync(join(lanePath(n), 'file.txt'), 'v1\nUNCOMMITTED\n');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-cache-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-cache-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shimDir);
  // A logging `git` shim: records cwd + GIT_OPTIONAL_LOCKS + argv, optionally sleeps (GIT_SHIM_SLEEP, seconds),
  // then execs the real git — identical to `lane-pool-list-cache.test.mjs`'s own shim.
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$GIT_TRACE_LOG"\n` +
      `if [ -n "$GIT_SHIM_SLEEP" ]; then sleep "$GIT_SHIM_SLEEP"; fi\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#3383 acquire auto-pick shares the single-flight scan under concurrency', () => {
  // #4075 follow-up (ci-heal-2721, 2026-09-26): every test in this file provisions several real lanes (real
  // `git clone`s) and then races several concurrent real `node lane-pool.mjs acquire` child processes against
  // each other — under real load (~3 runnable procs/core) that combination can easily outrun vitest's default
  // 5000ms per-test timeout well before any of this file's own `--wait-ms`/`elapsedMs` bounds are even reached,
  // which is indistinguishable from a real failure in the report. Explicit, generous it()-level timeouts below
  // fix that layer without touching the actual behavior under test.
  it('3 concurrent auto-pick acquires each land on a distinct lane when lanes are free, sharing the scan work', async () => {
    provision(6);
    resetTrace();
    const rs = await Promise.all(
      [1, 2, 3].map((i) => runPoolAsync(['acquire', ...REPO(), `--session=caller-${i}`, '--wait-ms=8000', '--json'])),
    );
    for (const r of rs) expect(r.code, r.err).toBe(0);
    const lanes = rs.map((r) => JSON.parse(r.out).lane).sort((a, b) => a - b);
    expect(new Set(lanes).size).toBe(3); // no two callers ever won the same lane
  }, 30_000);

  it('a genuinely SATURATED pool (nothing acquirable) costs ~ONE shared scan total, not one per caller per poll tick', async () => {
    // The exact shape of the live incident: every candidate is ineligible, so no claim EVER succeeds — nothing
    // ever changes the lease fingerprint, so every caller on every poll tick after the first should read a
    // cache HIT (zero lane git) rather than re-scanning. 3 callers polling across ~2-3 ticks with NO fix would
    // cost ~3 callers × ~3 ticks × 6 lanes = 54 independent `status --porcelain` probes; sharing costs ~6 (one
    // real scan) regardless of how many callers or ticks occur inside the cache TTL.
    provision(6);
    for (let n = 1; n <= 6; n++) dirty(n);
    resetTrace();
    // #3383 — `--hard-max=6` pins the SEPARATE growth-on-empty fix's ceiling at this pool's real size, so
    // "genuinely saturated, nothing acquirable" stays genuinely saturated instead of self-healing via a
    // fresh clone (that fix's own point elsewhere) — this test's actual subject is the shared-scan cost.
    const rs = await Promise.all(
      [1, 2, 3].map((i) => runPoolAsync(['acquire', ...REPO(), `--session=caller-${i}`, '--wait-ms=2500', '--hard-max=6'])),
    );
    for (const r of rs) {
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/no free lane in pool "acqcache" \(6 all held\/dirty\)/);
      // A scan that FINISHED and found nothing is a genuinely full pool — never reported as a scan timeout.
      expect(r.err).not.toMatch(/scan itself did not finish/);
    }
    const statusCalls = laneGitCalls().filter((c) => c.args.startsWith('status'));
    // Well under the ~54 an unshared, per-caller-per-tick rescan would cost; close to one scan's worth (6).
    expect(statusCalls.length).toBeLessThan(6 * 3);
  }, 30_000);

  it('--wait-ms bounds total time even when the scan itself is slow (never an unbounded per-tick rescan)', () => {
    provision(8);
    resetTrace();
    const startedMs = Date.now();
    // Every git call (including each lane's `status --porcelain` scan probe) now sleeps 1s. A full, uncapped
    // 8-lane scan alone would need >=8s; the OLD auto-pick reran a scan like that on every 1s poll tick with
    // no bound until `--wait-ms` was checked only BETWEEN full scans. The fix bounds a single scan attempt by
    // `--scan-timeout-ms`, so the whole command must return within `--wait-ms` + `--scan-timeout-ms` + slack.
    const r = runPool(
      ['acquire', ...REPO(), '--session=slow-scan', '--wait-ms=1500', '--scan-timeout-ms=1500'],
      { GIT_SHIM_SLEEP: '1' },
    );
    const elapsedMs = Date.now() - startedMs;
    // Bounded: well under the >=8000ms an unbounded full rescan of 8 slow lanes would cost, let alone several
    // of them chained across poll ticks (the live incident: a 30s bound that actually ran ~6 minutes).
    expect(elapsedMs).toBeLessThan(6000);
    // No 8-lane scan at 1s per git call can finish inside a 1.5s budget, so this must fail — and it must say the
    // SCAN ran out of time, never the saturated-pool "all held/dirty" message: all 8 lanes are free, so that
    // message would be false and send an operator hunting for a full pool instead of a slow/hung git probe.
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/scan itself did not finish/);
    expect(r.err).not.toMatch(/\(\d+ all held\/dirty\)/);
    // #3383 — growth left ON here on purpose: a scan that merely ran out of time is not a full pool (all 8
    // lanes are free), so acquire must never clone new lanes because the scan was slow.
    expect(r.err).not.toMatch(/growing by up to|grew pool/);
  }, 30_000);
});
