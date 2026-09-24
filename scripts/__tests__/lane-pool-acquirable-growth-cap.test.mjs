/**
 * @file scripts/__tests__/lane-pool-acquirable-growth-cap.test.mjs
 * @description Proof of the #4025 fix to `cmdProvision`'s `--acquirable` branch. Root-caused from the real WE
 *   pool's 2026-09-23 growth burst: lanes 84-114 (31 new lanes) were cloned in one ~4-minute window right after
 *   PR #2542 landed an (at-the-time) unbounded `list --acquirable` — 31 ≈ `ACQUIRABLE_PROVISION_HEADROOM` (32).
 *   Reading: an acquirability probe (the `git ls-remote` `aheadIsProvablyPushed` depends on to tell "ahead but
 *   already pushed" from "genuinely ahead") failed/timed out under load, was read fail-safe as "nothing here is
 *   provably pushed, therefore not acquirable", and `provision --acquirable` chased its headroom cloning new
 *   lanes looking for enough. Two independent guards now bound that:
 *     1. a small per-call cap (`--max-new`, default 4, env `LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW`) on how
 *        many BRAND-NEW lanes one `provision --acquirable` call may clone — reaching it means "ask again",
 *        never "clone dozens in one shot";
 *     2. an outright remote-reachability PROBE FAILURE stops growth entirely and alerts, rather than treating
 *        "we don't know" the same as "grow".
 *
 *   Real throwaway origin + reference checkout (same fixture shape as `lane-pool-acquirable.test.mjs`, whose
 *   own regression suite this file leaves untouched — see that file for the baseline `--acquirable` growth
 *   behavior this fix must not regress). The probe-failure case uses a `git` PATH shim that fails ONLY
 *   `ls-remote` (real git otherwise), mirroring `lane-pool-hung-git-bounded.test.mjs`'s shim pattern but
 *   failing fast instead of hanging.
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
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=growcap', '--branch=main', '--no-install'];

function listLanes(args = []) {
  const r = runPool(['list', '--json', ...REPO(), ...args]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

function provision(count, extra = [], extraEnv = {}) {
  return runPool(['provision', `--count=${count}`, ...REPO(), ...extra], extraEnv);
}

function leaseLane(n, { session = 'foreign-holder' } = {}) {
  const r = runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', `--session=${session}`]);
  expect(r.code).toBe(0);
}

/** A `git` shim: real git for everything EXCEPT `ls-remote`, which fails immediately (simulates a probe that
 *  failed/timed out — the class of failure #4025 traces the growth burst to) without hanging the test. */
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-growcap-'));
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

describe('lane-pool provision --acquirable (#4025) — per-call new-lane cap', () => {
  it('never clones more than the default cap (4) of brand-new lanes in one call, even when count needs far more', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1); // the only existing lane is held — every new clone counts as "brand new"

    const r = provision(20, ['--acquirable']);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/reached the per-call new-lane cap \(4/);
    // Only 4 NEW lanes cloned (lane-2..5) — never anywhere near 20 or the 32-headroom ceiling.
    expect(listLanes([])).toEqual([1, 2, 3, 4, 5]);
  });

  it('--max-new=N overrides the default per-call cap', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);

    const r = provision(20, ['--acquirable', '--max-new=2']);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/reached the per-call new-lane cap \(2/);
    expect(listLanes([])).toEqual([1, 2, 3]); // lane-1 (held) + 2 new
  });

  it('LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW env overrides the default when --max-new is omitted', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);

    const r = provision(20, ['--acquirable'], { LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW: '1' });
    expect(r.code).toBe(0);
    expect(listLanes([])).toEqual([1, 2]); // lane-1 (held) + exactly 1 new
  });

  it('LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW=0 disables new-lane growth (0 is honored, never read as "unset")', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);

    const r = provision(20, ['--acquirable'], { LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW: '0' });
    expect(r.out + r.err).toMatch(/new-lane cap 0 this call/);
    expect(listLanes([])).toEqual([1]); // no new lane cloned
  });

  it('a second call picks up where the first stopped (repeated calls converge without one giant clone)', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);

    provision(20, ['--acquirable', '--max-new=2']); // → lane-2, lane-3
    provision(20, ['--acquirable', '--max-new=2']); // → lane-4, lane-5 (existingCount now includes 2,3)
    expect(listLanes([])).toEqual([1, 2, 3, 4, 5]);
  });

  it('does NOT regress the #2426 baseline: growth still happens (bounded by the cap) when a low lane is held', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);
    const r = provision(2, ['--acquirable']); // needs 2 acquirable; lane-1 is held; default cap (4) covers it
    expect(r.out + r.err).toMatch(/ensured 2 acquirable lane/);
    const acq = listLanes(['--acquirable']);
    expect(acq).not.toContain(1);
    expect(acq.length).toBeGreaterThanOrEqual(2);
  });
});

describe('lane-pool provision --acquirable (#4025) — remote-probe-failure stops growth, never grows on "unknown"', () => {
  it('a failed ls-remote probe (checking an existing AHEAD lane) stops further cloning and alerts, rather than growing to headroom', () => {
    const p = provision(2);
    expect(p.code).toBe(0);
    // Make lane-1 genuinely AHEAD (a real local commit never pushed) so evaluating its acquirability actually
    // NEEDS the ls-remote probe (effectiveDirtyOrAhead only calls it when ahead > 0).
    writeFileSync(join(poolRoot, 'growcap', 'lane-1', 'new.txt'), 'unpushed\n');
    git(['add', 'new.txt'], join(poolRoot, 'growcap', 'lane-1'));
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], join(poolRoot, 'growcap', 'lane-1'));
    leaseLane(2); // lane-2 also unavailable, so the pass must look past both existing lanes

    installFailingLsRemoteShim();
    const before = listLanes([]);
    expect(before).toEqual([1, 2]);

    const r = provision(5, ['--acquirable'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/remote reachability probe.*failed/i);
    expect(r.out + r.err).not.toMatch(/reached the per-call new-lane cap/); // stopped for the OTHER reason
    // No brand-new lane was cloned at all — the probe failure was detected while evaluating lane-1 (an
    // existing lane), i.e. strictly BEFORE any new clone would begin.
    expect(listLanes([])).toEqual([1, 2]);
  });

  it('once the probe can succeed again (real git restored), a later call grows normally', () => {
    const p = provision(1);
    expect(p.code).toBe(0);
    leaseLane(1);
    // No shim this time — ordinary growth still works, proving the fix is a targeted stop, not a permanent one.
    const r = provision(2, ['--acquirable']);
    expect(r.out + r.err).toMatch(/ensured 2 acquirable lane/);
    expect(listLanes(['--acquirable']).length).toBeGreaterThanOrEqual(2);
  });
});
