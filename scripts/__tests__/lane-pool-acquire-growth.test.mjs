/**
 * @file scripts/__tests__/lane-pool-acquire-growth.test.mjs
 * @description Proof of the #3383 fix to `cmdAcquire`'s auto-pick path. Live-caught 2026-09-24: the
 *   web-everything pool sat at its 60-lane trim cap with only ~3-4 lanes actually acquirable (the rest held
 *   real uncommitted work or sat un-provably-ahead of origin) — EVERY review dispatch that call failed with
 *   `no free lane in pool "web-everything" (60 all held/dirty)`, however long `--wait-ms` waited, because
 *   `acquire`'s auto-pick never grows the pool: it only polls the SAME lane set, then fails. This mirrors
 *   #4025's `provision --acquirable` growth guards (a small per-call new-lane cap, an outright hard ceiling,
 *   and a fail-SAFE-STOP — never fail-safe-GROW — on a live remote-probe failure), applied to `acquire` itself:
 *
 *   1. On a genuinely full pool, `acquire` (auto-pick) now grows by up to a bounded number of brand-new lanes
 *      (default 4, `--growth-max-new=N` / `LANE_POOL_ACQUIRE_GROWTH_MAX_NEW` override) rather than failing
 *      outright, and succeeds against a freshly-grown lane.
 *   2. Growth never crosses a HARD cap set above the trim target (default 90 for web-everything / 30 for the
 *      constellation siblings, `--hard-max=N` / `LANE_POOL_HARD_MAX` override) — once there, `acquire` fails
 *      with the ORIGINAL "no free lane" message, unchanged.
 *   3. `LANE_POOL_ACQUIRE_GROWTH_MAX_NEW=0` disables growth outright (0 honored, never read as "unset").
 *   4. A live remote-probe failure (the same `ls-remote` class of failure #4025 traces its growth burst to)
 *      stops growth entirely and alerts, rather than treating "we don't know" as "starved, so grow" — proven
 *      with the same PATH git-shim pattern `lane-pool-acquirable-growth-cap.test.mjs` uses.
 *
 *   Real throwaway origin + reference checkout (same fixture shape as the two files above) — no shared pool
 *   root, no mocking of `lane-pool.mjs` itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=growacq', '--branch=main', '--no-install'];

function listLanes(args = []) {
  const r = runPool(['list', '--json', ...REPO(), ...args]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

function provision(count, extra = []) {
  const r = runPool(['provision', `--count=${count}`, ...REPO(), ...extra]);
  expect(r.code).toBe(0);
  return r;
}

function leaseLane(n, { session = 'foreign-holder' } = {}) {
  const r = runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', `--session=${session}`]);
  expect(r.code).toBe(0);
}

/** A `git` shim: real git for everything EXCEPT `ls-remote`, which fails immediately (simulates a probe that
 *  failed/timed out) without hanging the test — identical pattern to
 *  `lane-pool-acquirable-growth-cap.test.mjs`'s own shim. */
function installFailingLsRemoteShim() {
  const real = execFileSync('command', ['-v', 'git'], { shell: '/bin/bash', encoding: 'utf8' }).trim();
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'git');
  const script = [
    '#!/usr/bin/env bash',
    `REAL_GIT=${JSON.stringify(real)}`,
    'if [ "$1" = "ls-remote" ]; then',
    '  echo "fatal: simulated probe failure (network unreachable)" >&2',
    '  exit 128',
    'fi',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n');
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  return shimDir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-growacq-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shimbin');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('lane-pool acquire (#3383) — growth-on-empty, bounded by a per-call cap', () => {
  it('a fully-held pool grows by new lanes and acquire succeeds against one of them, instead of failing', () => {
    provision(1);
    leaseLane(1); // the only lane is held — auto-pick has nothing to choose from

    const r = runPool(['acquire', ...REPO(), '--session=picker', '--adopt']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toMatch(/lane-2$/); // lowest brand-new lane, since lane-1 is held
    expect(r.err).toMatch(/growing by up to 4 new lane/);
    // Growth cloned up to the default cap (4): lane-1 (held) + lane-2..5 = 5 total, one of which (lane-2) is
    // now also leased by this acquire.
    expect(listLanes([])).toEqual([1, 2, 3, 4, 5]);
  });

  it('--growth-max-new=N overrides the default per-call cap', () => {
    provision(1);
    leaseLane(1);

    const r = runPool(['acquire', ...REPO(), '--growth-max-new=1', '--session=picker']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toMatch(/lane-2$/);
    expect(listLanes([])).toEqual([1, 2]); // exactly one new lane grown
  });

  it('LANE_POOL_ACQUIRE_GROWTH_MAX_NEW env overrides the default when --growth-max-new is omitted', () => {
    provision(1);
    leaseLane(1);

    const r = runPool(['acquire', ...REPO(), '--session=picker'], { LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '2' });
    expect(r.code, r.err).toBe(0);
    expect(listLanes([])).toEqual([1, 2, 3]);
  });

  it('LANE_POOL_ACQUIRE_GROWTH_MAX_NEW=0 disables growth (0 honored, never read as "unset") — fails like before the fix', () => {
    provision(1);
    leaseLane(1);

    const r = runPool(['acquire', ...REPO(), '--session=picker'], { LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '0' });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/growth cap is 0/);
    expect(r.err).toMatch(/no free lane in pool "growacq" \(1 all held\/dirty\)/);
    expect(listLanes([])).toEqual([1]); // nothing new cloned
  });

  it('never grows past the hard cap — once there, acquire fails with the ORIGINAL message, unchanged', () => {
    provision(1);
    leaseLane(1);

    const r = runPool(['acquire', ...REPO(), '--hard-max=1', '--session=picker']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/already at its hard cap/);
    expect(r.err).toMatch(/no free lane in pool "growacq" \(1 all held\/dirty\) — release one or `provision` more/);
    expect(listLanes([])).toEqual([1]); // nothing new cloned
  });

  it('--hard-max=N still allows PARTIAL growth up to the cap when it is above the current size but below the per-call cap', () => {
    provision(1);
    leaseLane(1);

    const r = runPool(['acquire', ...REPO(), '--hard-max=2', '--session=picker']); // room for exactly 1 new lane
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toMatch(/lane-2$/);
    expect(listLanes([])).toEqual([1, 2]); // capped at hard-max, not the default per-call cap of 4
  });

  it('omitting nothing regresses the baseline: a pool with a genuinely free lane never grows at all', () => {
    provision(2); // lane-1, lane-2 both free
    const r = runPool(['acquire', ...REPO(), '--session=picker']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toMatch(/lane-1$/);
    expect(r.err).not.toMatch(/growing by up to/);
    expect(listLanes([])).toEqual([1, 2]); // no growth — the existing free lane was used
  });
});

describe('lane-pool acquire (#3383) — remote-probe-failure stops growth, never grows on "unknown"', () => {
  it('a failed ls-remote probe (checking an existing AHEAD lane) stops growth and alerts, rather than cloning past starvation', () => {
    provision(2);
    // Make lane-1 genuinely AHEAD (a real local commit never pushed) so evaluating its acquirability actually
    // NEEDS the ls-remote probe (effectiveDirtyOrAhead only calls it when ahead > 0) — same technique
    // `lane-pool-acquirable-growth-cap.test.mjs` uses for its own probe-failure case.
    writeFileSync(join(poolRoot, 'growacq', 'lane-1', 'new.txt'), 'unpushed\n');
    git(['add', 'new.txt'], join(poolRoot, 'growacq', 'lane-1'));
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], join(poolRoot, 'growacq', 'lane-1'));
    leaseLane(2); // lane-2 also unavailable, so auto-pick must look past both existing lanes

    installFailingLsRemoteShim();
    expect(listLanes([])).toEqual([1, 2]);

    const r = runPool(['acquire', ...REPO(), '--session=picker'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/remote-reachability probe.*failed while evaluating this pool/i);
    expect(r.err).toMatch(/no free lane in pool "growacq" \(2 all held\/dirty\)/);
    // No brand-new lane was cloned — the probe failure was detected while evaluating lane-1, strictly before
    // growth would begin.
    expect(listLanes([])).toEqual([1, 2]);
  });

  it('once the probe can succeed again (real git restored), acquire grows normally', () => {
    provision(1);
    leaseLane(1);
    // No shim this time — ordinary growth still works, proving the fix is a targeted stop, not a permanent one.
    const r = runPool(['acquire', ...REPO(), '--session=picker']);
    expect(r.code, r.err).toBe(0);
    expect(listLanes([]).length).toBeGreaterThanOrEqual(2);
  });
});
