/**
 * @file scripts/__tests__/lane-pool-trim.test.mjs
 * @description Proof of the #4025 `trim` command in `scripts/lane-pool.mjs`. `provision --acquirable` grows a
 *   pool whenever nothing looks free (`ACQUIRABLE_PROVISION_HEADROOM`), but nothing ever shrank it back — the
 *   real WE pool reached 118 lanes / 87GB and `list --acquirable` slowed from ~45s (83 lanes, PR #2547's own
 *   bound) to ~90s. `trim [--max=N] [--dry-run]` is the missing shrink half: delete lane directories, HIGHEST
 *   numbers first, down toward a cap — but ONLY when a lane is provably safe (no live/undead lease, never
 *   reserved, nothing uncommitted beyond the shared scratch allowlist, every ahead commit provably pushed).
 *
 *   Real throwaway origin + reference checkout, no shared pool root (`LANE_POOL_ROOT` per test) — same fixture
 *   shape as `lane-pool-acquirable.test.mjs`, which this file's own tier joins in `vitest.integration.config.ts`
 *   (see that file's exclude list in `vitest.config.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=trimtest', '--branch=main', '--no-install'];
const ENV = () => ({ LANE_POOL_ROOT: poolRoot });

function provision(count) {
  const r = runPool(['provision', `--count=${count}`, ...REPO()], ENV());
  expect(r.code).toBe(0);
  return r;
}

function laneDir(n) {
  return join(poolRoot, 'trimtest', `lane-${n}`);
}

function existingLaneNums() {
  const dir = join(poolRoot, 'trimtest');
  if (!existsSync(dir)) return [];
  return execFileSync('ls', ['-1', dir], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter((s) => /^lane-\d+$/.test(s))
    .map((s) => Number(s.slice(5))).sort((a, b) => a - b);
}

function trim(args = []) {
  return runPool(['trim', ...REPO(), '--json', ...args], ENV());
}

function leaseLane(n, { session = 'foreign-holder', ttlMinutes, reserve = false } = {}) {
  const ttl = ttlMinutes === undefined ? [] : [`--ttl-minutes=${ttlMinutes}`];
  const reserveArgs = reserve ? ['--reserve'] : [];
  const r = runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', `--session=${session}`, ...ttl, ...reserveArgs], ENV());
  expect(r.code).toBe(0);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-trim-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

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

describe('lane-pool trim (#4025) — at/under cap', () => {
  it('does nothing when the pool is already at or under --max', () => {
    provision(3);
    const r = trim(['--max=5']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).toEqual([]);
    expect(existingLaneNums()).toEqual([1, 2, 3]);
    // Same key set as the compute path, so a consumer (health-watch's summary line) never reads undefined.
    expect(parsed.remaining).toBe(3);
    expect(parsed.overCap).toBe(0);
  });
});

describe('lane-pool trim (#4025) — TOCTOU: a lane acquired between evaluation and deletion survives', () => {
  /** Run a real trim in the background, pause it (test seam) after evaluation, acquire+dirty `lane` inside
   *  that window, then release trim and return its parsed JSON. */
  async function trimWithMidRunAcquire(args, lane, { dirty = true, acquire = true, at = 'evaluated', during } = {}) {
    const barrier = join(base, 'trim-barrier');
    const child = spawn('node', [SCRIPT, 'trim', ...REPO(), '--json', ...args], {
      env: { ...process.env, ...ENV(), LANE_POOL_TRIM_TEST_BARRIER: barrier, LANE_POOL_TRIM_TEST_BARRIER_AT: at },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const done = new Promise((res) => child.on('exit', res));
    for (let i = 0; i < 600 && !existsSync(`${barrier}.ready`); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${barrier}.ready`)).toBe(true);
    if (during) during();
    if (acquire) leaseLane(lane, { session: 'mid-trim-acquirer' });
    if (dirty) writeFileSync(join(laneDir(lane), 'real-work.txt'), 'written right after acquire\n');
    writeFileSync(`${barrier}.go`, '');
    await done;
    return JSON.parse(out);
  }

  it('never deletes a lane a live session acquired after trim evaluated it (lease + work survive)', async () => {
    provision(3);
    const parsed = await trimWithMidRunAcquire(['--max=0'], 3);
    expect(existingLaneNums()).toContain(3);
    expect(existsSync(join(laneDir(3), 'real-work.txt'))).toBe(true);
    expect(readFileSync(join(laneDir(3), '.git', '.lane-lease'), 'utf8')).toMatch(/mid-trim-acquirer/);
    expect(parsed.removed).not.toContain(3);
    expect(parsed.kept.find((k) => k.lane === 3).kind).toBe('leased');
    // The lanes nobody touched are still trimmed.
    expect(parsed.removed.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(parsed.remaining).toBe(1);
  });

  it('a lane whose provably-dead lease was re-acquired mid-run survives too', async () => {
    provision(2);
    leaseLane(2, { ttlMinutes: 0 }); // dead at evaluation time → eligible
    const parsed = await trimWithMidRunAcquire(['--max=0'], 2, { dirty: false });
    expect(existingLaneNums()).toContain(2);
    expect(readFileSync(join(laneDir(2), '.git', '.lane-lease'), 'utf8')).toMatch(/mid-trim-acquirer/);
    expect(parsed.removed).toEqual([1]);
  });

  it('a lane that gains real work mid-run (no lease) is re-checked and kept, with no trim lease left behind', async () => {
    provision(2);
    const parsed = await trimWithMidRunAcquire(['--max=0'], 2, { acquire: false });
    expect(existingLaneNums()).toContain(2);
    expect(existsSync(join(laneDir(2), 'real-work.txt'))).toBe(true);
    expect(existsSync(join(laneDir(2), '.git', '.lane-lease'))).toBe(false);
    expect(parsed.kept.find((k) => k.lane === 2).kind).toBe('work');
    expect(parsed.removed).toEqual([1]);
  });

  it("a lease that REPLACES trim's own claim before the move (acquire's non-O_EXCL rewrite/reclaim paths) keeps the lane", async () => {
    provision(1);
    const marker = join(laneDir(1), '.git', '.lane-lease');
    const parsed = await trimWithMidRunAcquire(['--max=0'], 1, {
      at: 'claimed', acquire: false, dirty: false,
      // Overwrite trim's fresh claim the way `tryClaimLane`'s own-lease rewrite does: a plain write, no O_EXCL.
      during: () => writeFileSync(marker, JSON.stringify({ session: 'returning-owner', purpose: 'test', acquiredAt: new Date().toISOString(), ttlMinutes: 240 })),
    });
    expect(existingLaneNums()).toEqual([1]);
    expect(readFileSync(marker, 'utf8')).toMatch(/returning-owner/);
    expect(parsed.removed).toEqual([]);
    expect(parsed.kept.find((k) => k.lane === 1).kind).toBe('leased');
  });
});

describe('lane-pool trim (#4025) — highest-numbered-first removal', () => {
  it('removes the highest-numbered idle/clean lanes down to --max, keeping low numbers stable', () => {
    provision(6);
    const r = trim(['--max=3']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed.sort((a, b) => a - b)).toEqual([4, 5, 6]);
    expect(existingLaneNums()).toEqual([1, 2, 3]);
  });

  it('--dry-run reports what WOULD be removed but changes nothing on disk', () => {
    provision(6);
    const r = trim(['--max=3', '--dry-run']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.removed.sort((a, b) => a - b)).toEqual([4, 5, 6]);
    // Nothing actually removed — every lane dir still exists.
    expect(existingLaneNums()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a removed lane also drops its lane-ports registry entry (#2139)', () => {
    provision(4);
    // `map` requires a PORT_BANDS entry for the pool name (only the real repo names have one) — write the
    // registry entry directly rather than depending on that, so this throwaway pool name stays arbitrary.
    const registryPath = join(referenceDir, '.claude', 'lane-ports.json');
    mkdirSync(join(referenceDir, '.claude'), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ 555: { lane: 4, repo: 'trimtest' } }, null, 2) + '\n');

    trim(['--max=2']);
    expect(existingLaneNums()).toEqual([1, 2]);
    const after = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(after['555']).toBeUndefined();
  });
});

describe('lane-pool trim (#4025) — safety: never removes real work', () => {
  it('never removes lanes with real (non-litter) uncommitted changes — reports them, cap not fully reached', () => {
    provision(4);
    // Both of the two highest-numbered lanes hold real work — with only lane-1/2 safely removable, an excess
    // of 3 (4 lanes, cap 1) can only be reduced by 2, so the cap cannot be fully reached.
    writeFileSync(join(laneDir(4), 'file.txt'), 'v1\nREAL EDIT\n');
    writeFileSync(join(laneDir(3), 'file.txt'), 'v1\nREAL EDIT TOO\n');

    const r = trim(['--max=1']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(existingLaneNums()).toEqual([3, 4]);
    // 2 lanes held real work and could not be removed, so 2 remain against a cap of 1.
    expect(parsed.remaining).toBe(2);
    expect(parsed.overCap).toBe(1);
    expect(parsed.kept.find((k) => k.lane === 4).kind).toBe('work');
    expect(parsed.kept.find((k) => k.lane === 3).kind).toBe('work');
    expect(r.err + r.out).toMatch(/hold unpushed\/uncommitted work.*lane-3.*lane-4|hold unpushed\/uncommitted work.*lane-4.*lane-3/s);
  });

  it('never removes a lane with a real unpushed commit (ahead, not patch-equivalent)', () => {
    provision(2);
    writeFileSync(join(laneDir(2), 'new-file.txt'), 'unpushed work\n');
    git(['add', 'new-file.txt'], laneDir(2));
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], laneDir(2));

    const r = trim(['--max=0']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).not.toContain(2);
    expect(existingLaneNums()).toContain(2);
    expect(parsed.kept.find((k) => k.lane === 2).kind).toBe('work');
  });

  it('a lane whose ONLY dirty files are on the scratch litter allowlist IS still removed', () => {
    provision(2);
    writeFileSync(join(laneDir(2), '.pr-body.md'), 'scratch\n');

    const r = trim(['--max=0']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).toContain(2);
    expect(existingLaneNums()).not.toContain(2);
  });

  it('never removes a live-leased lane, even if it is the highest-numbered', () => {
    provision(3);
    leaseLane(3);

    const r = trim(['--max=1']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).not.toContain(3);
    expect(existingLaneNums()).toContain(3);
    expect(parsed.kept.find((k) => k.lane === 3).kind).toBe('leased');
    // lane-2 (idle) is removed instead to make progress toward the cap.
    expect(parsed.removed).toContain(2);
  });

  it('a STALE (TTL-expired) lease does NOT protect a lane — it is provably dead, so removable', () => {
    provision(2);
    leaseLane(2, { ttlMinutes: 0 }); // already stale
    const r = trim(['--max=0']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).toContain(2);
    expect(existingLaneNums()).not.toContain(2);
  });

  it('NEVER removes a RESERVED (permanent) lane, even with --max=0 and no other candidates', () => {
    provision(1);
    leaseLane(1, { reserve: true });
    const r = trim(['--max=0']);
    const parsed = JSON.parse(r.out);
    expect(parsed.removed).toEqual([]);
    expect(existingLaneNums()).toEqual([1]);
    expect(parsed.kept.find((k) => k.lane === 1).kind).toBe('reserved');
  });
});

describe('lane-pool trim (#4025) — crash safety', () => {
  it('sweeps a leftover .trash-* directory from an interrupted earlier trim on the next real run', () => {
    provision(1);
    const poolDir = join(poolRoot, 'trimtest');
    const leftover = join(poolDir, '.trash-999-1234567890');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'stale-marker.txt'), 'orphaned by a killed trim\n');

    const r = trim(['--max=10']); // nothing over cap — but the sweep still runs on a real (non-dry) call
    expect(r.code).toBe(0);
    expect(existsSync(leftover)).toBe(false);
  });

  it('a --dry-run never sweeps leftover trash (dry-run must change nothing on disk)', () => {
    provision(1);
    const poolDir = join(poolRoot, 'trimtest');
    const leftover = join(poolDir, '.trash-999-1234567890');
    mkdirSync(leftover, { recursive: true });

    trim(['--max=10', '--dry-run']);
    expect(existsSync(leftover)).toBe(true);
  });
});

describe('lane-pool trim (#4025) — cap resolution', () => {
  it('falls back to the pool-name default cap when --max is omitted (unrecognized name → 20 fallback)', () => {
    provision(1);
    const r = trim([]); // no --max — pool name "trimtest" has no TRIM_DEFAULT_CAP entry → fallback 20
    const parsed = JSON.parse(r.out);
    expect(parsed.max).toBe(20);
    expect(parsed.removed).toEqual([]); // 1 lane, well under 20
  });

  it('LANE_POOL_TRIM_MAX env overrides the default cap when --max is omitted', () => {
    provision(3);
    const r = runPool(['trim', ...REPO(), '--json'], { ...ENV(), LANE_POOL_TRIM_MAX: '1' });
    const parsed = JSON.parse(r.out);
    expect(parsed.max).toBe(1);
    expect(parsed.removed.sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
