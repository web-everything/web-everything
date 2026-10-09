/**
 * @file scripts/__tests__/lane-pool-refresh-guard.test.mjs
 * @description Proof of the #2267 dirty-or-ahead guard AND the #2337(b) live-lease gate in
 *   `scripts/lane-pool.mjs`. `refreshLane()` used to unconditionally `git reset --hard` + `git clean -fd`
 *   every lane on `refresh`/`provision`, silently destroying a concurrent session's uncommitted edits or
 *   locally-committed-but-unpushed work; `--force` restores that reset for dirty/ahead (staleness), but per
 *   #2337(b) must NEVER stomp a LIVE lease (an ownership hold) on any of the three forced entry points —
 *   `refresh --force` / `provision --force` (skip loud) and `acquire --lane=N --force` (hard-fail, pointing
 *   at `release --force`). These tests spawn the real CLI against a throwaway local origin + reference
 *   checkout (no network, no shared pool root) and assert: a dirty lane is left untouched; an ahead
 *   (unpushed-commit) lane is left untouched; a clean/up-to-date lane still fast-forwards; `--force` still
 *   recycles a free-but-dirty lane; `--force` does NOT recycle a live-leased lane; `acquire --lane=N --force`
 *   hard-fails on a live lease; and `release --force` is the documented escape hatch.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: withGhStub({ ...process.env, ...extraEnv }) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-guard-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-guard-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function provisionOne() {
  const r = runPool(
    ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
    { LANE_POOL_ROOT: poolRoot },
  );
  expect(r.code).toBe(0);
  return join(poolRoot, 'guardtest', 'lane-1');
}

describe('lane-pool refresh/provision dirty-or-ahead guard (#2267)', () => {
  it('SKIPS a DIRTY lane (uncommitted edit survives a refresh)', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'file.txt'), 'v1\nUNCOMMITTED EDIT\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED \(dirty\/ahead/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toContain('UNCOMMITTED EDIT');
  });

  it('SKIPS an AHEAD lane (locally-committed-but-unpushed commit survives a refresh)', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'file.txt'), 'v1\nlocal commit\n');
    git(['add', 'file.txt'], lane);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], lane);
    const headBefore = git(['rev-parse', 'HEAD'], lane);

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED \(dirty\/ahead/);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(headBefore); // local commit NOT reset away
  });

  it('still refreshes a CLEAN, up-to-date lane normally (no skip)', () => {
    const lane = provisionOne();
    // Push a new commit to origin so the lane is behind (not dirty, not ahead).
    writeFileSync(join(referenceDir, 'file.txt'), 'v2\n');
    git(['add', 'file.txt'], referenceDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v2'], referenceDir);
    git(['push', '--quiet', 'origin', 'main'], referenceDir);

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toMatch(/SKIPPED/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('v2\n');
  });

  it('--force restores the unconditional reset, discarding a dirty edit', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'file.txt'), 'v1\nUNCOMMITTED EDIT\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--force'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toMatch(/SKIPPED/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('v1\n');
  });

  // #2329 — the incident that triggered this verification was purely UNTRACKED work (freshly scaffolded
  // backlog files, never `git add`ed), not a modification of a tracked file. `laneDirtyOrAhead` runs
  // `git status --porcelain` WITHOUT `--untracked-files=no`, so untracked files count (uncommitted > 0) and
  // the un-forced refresh MUST skip. This pins that the un-forced guard genuinely protects untracked-only work.
  it('SKIPS a lane whose ONLY change is UNTRACKED (never git-added) work (#2329)', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'scaffolded-untracked.md'), '# not yet added\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED \(dirty\/ahead/);
    expect(readFileSync(join(lane, 'scaffolded-untracked.md'), 'utf8')).toContain('not yet added');
  });

  // #2329 / #2275 — a LIVE lease (what `acquire` stamps) is the primary protection: a non-forced refresh must
  // skip a leased lane BEFORE it even looks at dirty/ahead, so a consumer's untracked work is safe for the
  // lease TTL. Verifies acquire leaves a live lease that refresh honors (candidate root-cause 1 in the item).
  it('SKIPS a LEASED lane on a non-forced refresh, untracked work survives (acquire left a live lease)', () => {
    provisionOne();
    const acq = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--no-reset'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(acq.code).toBe(0);
    const lane = acq.out.trim().split('\n').pop();
    writeFileSync(join(lane, 'untracked-during-lease.txt'), 'consumer work\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED/);
    expect(readFileSync(join(lane, 'untracked-during-lease.txt'), 'utf8')).toContain('consumer work');
  });

  // #2337(b) ruling — `--force` overrides the dirty/ahead STALENESS guard but must NEVER stomp a LIVE
  // lease (an ownership hold, distinct from tree residue). `refresh --force` on a leased lane now SKIPS it
  // (loud), so the lease-holder's untracked work SURVIVES — flipped from the pre-#2337 characterization
  // that this same scenario silently ate the work.
  it('--force does NOT eat a leased lane\'s untracked work — the lease still skips it (#2337b)', () => {
    provisionOne();
    const acq = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--no-reset'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(acq.code).toBe(0);
    const lane = acq.out.trim().split('\n').pop();
    writeFileSync(join(lane, 'untracked-eaten.txt'), 'survives --force now\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--force'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED/); // lease skip fires even under --force
    expect(readFileSync(join(lane, 'untracked-eaten.txt'), 'utf8')).toContain('survives --force now');
  });

  // #2337(b) — a free-but-DIRTY (unleased) lane is still recycled by `--force`, exactly as before: the
  // override targets tree-staleness, not ownership, so this path is unchanged.
  it('--force still eats a free-but-dirty (unleased) lane\'s untracked work (unchanged)', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'untracked-free-dirty.txt'), 'no lease here\n');

    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--force'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toMatch(/SKIPPED/);
    expect(existsSync(join(lane, 'untracked-free-dirty.txt'))).toBe(false); // free lane, no lease → still recycled
  });

  // #2337(b) point 1 — `acquire --lane=N --force` is the THIRD forced entry point (besides refresh/provision
  // --force) that reclaimed a live lease and reset the lane; it must now hard-fail instead, pointing at the
  // deliberate override (`release --force`), and must NOT touch the lane's untracked work.
  it('acquire --lane=N --force HARD-FAILS on a live-leased lane, work untouched (#2337b)', () => {
    provisionOne();
    const acq = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--no-reset', '--session=holder'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(acq.code).toBe(0);
    const lane = acq.out.trim().split('\n').pop();
    writeFileSync(join(lane, 'untouched-by-force-acquire.txt'), 'still here\n');

    const r = runPool(
      ['acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--force', '--session=intruder'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/LIVE lease/);
    expect(r.err).toMatch(/release/);
    expect(readFileSync(join(lane, 'untouched-by-force-acquire.txt'), 'utf8')).toContain('still here');
  });

  // #2337(b) point 3 — the documented escape hatch: `release --force` drops the lease, then a subsequent
  // `acquire --lane=N --force` (or even a plain acquire) succeeds normally.
  it('release --force then re-acquire succeeds (the documented deliberate override)', () => {
    provisionOne();
    const acq = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--no-reset', '--session=holder'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(acq.code).toBe(0);

    const rel = runPool(
      ['release', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--force', '--session=intruder'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(rel.code).toBe(0);

    const reacq = runPool(
      ['acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install', '--session=intruder'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(reacq.code).toBe(0);
  });

  it('provision also honors the guard for an already-existing dirty lane', () => {
    const lane = provisionOne();
    writeFileSync(join(lane, 'file.txt'), 'v1\nUNCOMMITTED EDIT\n');

    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED \(dirty\/ahead/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toContain('UNCOMMITTED EDIT');
  });

  // #3390 — real incident: lane-11's lease went TTL-stale mid-epic with 4 built-and-tested files sitting as
  // uncommitted/untracked edits. Unlike refresh/provision (both guarded above) and unlike auto-pick (which
  // never selects a dirty/ahead candidate to begin with), `acquire --lane=N`'s TTL-stale reclaim path ran
  // straight to `checkout -B --force` + `clean -fd` with no dirty/ahead check at all — recovered only from
  // Claude Code's own session transcripts, not from anything git-recoverable.
  describe('acquire --lane=N dirty/ahead guard on a TTL-stale reclaim (#3390)', () => {
    it('REFUSES to reclaim a TTL-stale lease whose tree holds untracked work, work survives', () => {
      provisionOne();
      const acq = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--no-reset', '--session=holder', '--ttl-minutes=0',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(acq.code).toBe(0);
      const lane = acq.out.trim().split('\n').pop();
      writeFileSync(join(lane, 'built-and-tested.txt'), 'four files worth of real work\n');

      const reclaim = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--session=intruder',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(reclaim.code).not.toBe(0);
      expect(reclaim.err).toMatch(/would destroy that work/);
      expect(reclaim.err).toMatch(/--force/);
      expect(readFileSync(join(lane, 'built-and-tested.txt'), 'utf8')).toContain('four files worth of real work');
    });

    it('REFUSES to reclaim a TTL-stale lease whose tree is ahead (locally-committed, unpushed), work survives', () => {
      provisionOne();
      const acq = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--no-reset', '--session=holder', '--ttl-minutes=0',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(acq.code).toBe(0);
      const lane = acq.out.trim().split('\n').pop();
      writeFileSync(join(lane, 'file.txt'), 'v1\nunpushed commit\n');
      git(['add', 'file.txt'], lane);
      git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], lane);
      const headBefore = git(['rev-parse', 'HEAD'], lane);

      const reclaim = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--session=intruder',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(reclaim.code).not.toBe(0);
      expect(reclaim.err).toMatch(/would destroy that work/);
      expect(git(['rev-parse', 'HEAD'], lane)).toBe(headBefore);
      // #3383 — the refusal hands the lane back: no intruder lease is left holding it until its TTL
      const leaseFile = join(lane, '.git', '.lane-lease');
      const left = existsSync(leaseFile) ? JSON.parse(readFileSync(leaseFile, 'utf8')) : null;
      expect(left?.session).not.toBe('intruder');
    });

    it('--force still reclaims a TTL-stale, dirty lane (documented override, unchanged end state)', () => {
      provisionOne();
      const acq = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--no-reset', '--session=holder', '--ttl-minutes=0',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(acq.code).toBe(0);
      const lane = acq.out.trim().split('\n').pop();
      writeFileSync(join(lane, 'stale-residue.txt'), 'abandoned garbage, for real this time\n');

      const reclaim = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--session=intruder', '--force',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(reclaim.code).toBe(0);
      expect(existsSync(join(lane, 'stale-residue.txt'))).toBe(false);
    });

    it('does not block reclaiming a TTL-stale lease whose tree is already clean', () => {
      provisionOne();
      const acq = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--no-reset', '--session=holder', '--ttl-minutes=0',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(acq.code).toBe(0);

      const reclaim = runPool(
        [
          'acquire', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=guardtest',
          '--branch=main', '--no-install', '--session=intruder',
        ],
        { LANE_POOL_ROOT: poolRoot },
      );
      expect(reclaim.code).toBe(0);
    });
  });
});
