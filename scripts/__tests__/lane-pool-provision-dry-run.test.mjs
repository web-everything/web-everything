/**
 * @file scripts/__tests__/lane-pool-provision-dry-run.test.mjs
 * @description Proof of the #4139 live bug fix (2026-09-25): `lane-pool.mjs provision --count=86 --dry-run`
 *   IGNORED `--dry-run` and really cloned lanes 72-86 against a real ~71-lane pool. Root cause: `--dry-run` is
 *   accepted by `KNOWN_FLAGS` (so it was never rejected as an unknown flag) but `cmdProvision` never actually
 *   READ it anywhere, in either the plain `--count` loop or the `--acquirable` growth loop — both always
 *   provisioned for real regardless of the flag. Real throwaway origin + reference checkout, private
 *   `LANE_POOL_ROOT` — same fixture shape as `lane-pool-reclaim.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, env;

function runPool(args) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env, timeout: 60_000, killSignal: 'SIGKILL' });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=provisiondryrun', '--branch=main', '--no-install'];
const poolDir = () => join(poolRoot, 'provisiondryrun');
const laneDirs = () => {
  try { return readdirSync(poolDir()).filter((n) => /^lane-\d+$/.test(n)); } catch { return []; }
};

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-provision-dry-run-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  execFileSync('sh', ['-c', 'echo v1 > file.txt'], { cwd: referenceDir });
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-provision-dry-run-'));
  poolRoot = join(base, 'pool');
  env = { ...process.env, LANE_POOL_ROOT: poolRoot, HOME: base };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool provision --dry-run — BEFORE the fix (documents the gap)', () => {
  it('a bare `provision --count=N` (no --dry-run) really clones N lanes — the baseline this bug regressed', () => {
    expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
    expect(laneDirs().sort()).toEqual(['lane-1', 'lane-2', 'lane-3']);
  });
});

describe('lane-pool provision --dry-run — AFTER the fix', () => {
  it('creates NOTHING — no pool dir, no lane dirs — for a count above the current total (0 lanes exist)', () => {
    const r = runPool(['provision', '--count=25', '--dry-run', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(laneDirs()).toEqual([]);
  });

  it('creates NOTHING on top of an EXISTING pool either — a dry-run past the current count never grows it', () => {
    expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
    expect(laneDirs()).toHaveLength(3);
    const r = runPool(['provision', '--count=25', '--dry-run', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(laneDirs()).toHaveLength(3); // still exactly 3 — dry-run created none of lanes 4-25
  });

  it('--json reports the shape without ever touching disk', () => {
    const r = runPool(['provision', '--count=25', '--dry-run', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toEqual({ dryRun: true, acquirable: false, count: 25, existingCount: 0, wouldCreate: 25 });
    expect(laneDirs()).toEqual([]);
  });

  it('--acquirable --dry-run also creates nothing (the growth branch had the identical gap)', () => {
    const r = runPool(['provision', '--count=25', '--acquirable', '--dry-run', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toEqual({ dryRun: true, acquirable: true, count: 25, existingCount: 0 });
    expect(laneDirs()).toEqual([]);
  });
});
