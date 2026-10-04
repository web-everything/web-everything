/**
 * @file scripts/__tests__/lane-pool-keep.test.mjs
 * @description Proof of #4139's `keep` command in `scripts/lane-pool.mjs` — the other half of the LANE RECLAIM
 *   one-click pair: an operator records "I looked at this queued lane, leave it", scoped to a fingerprint of
 *   the lane's CURRENT content, and that decision is read back by `we:scripts/lane-whois.mjs`
 *   (`we:scripts/lib/lane-whois-core.mjs#keepMarkerApplies`). Real throwaway origin + reference checkout,
 *   private `LANE_POOL_ROOT` — same fixture shape as `lane-pool-reclaim.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, env;

function runPool(args) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env, timeout: 30_000, killSignal: 'SIGKILL' });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=keeppool', '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'keeppool', `lane-${n}`);
const keepMarker = (n) => join(lanePath(n), '.git', '.lane-keep');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-keep-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-keep-'));
  poolRoot = join(base, 'pool');
  env = { ...process.env, LANE_POOL_ROOT: poolRoot, HOME: base };

  expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool keep (#4139)', () => {
  it('needs an explicit --lane — never a batch', () => {
    const r = runPool(['keep', '--json', ...poolArgs()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--lane/);
  });

  it('refuses a lane that does not exist', () => {
    const r = runPool(['keep', '--lane=99', '--json', ...poolArgs()]);
    expect(r.code).not.toBe(0);
  });

  it('writes a durable marker recording the fingerprint + an optional reason', () => {
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    const r = runPool(['keep', '--lane=1', '--reason=reviewed, safe to leave', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(keepMarker(1))).toBe(true);
    const marker = JSON.parse(readFileSync(keepMarker(1), 'utf8'));
    expect(marker.reason).toBe('reviewed, safe to leave');
    expect(marker.fingerprint.dirtyPaths).toEqual(['orphan.txt']);
    expect(typeof marker.fingerprint.headSha).toBe('string');
    expect(marker.keptAt).toBeTruthy();
    const report = JSON.parse(r.out);
    expect(report.kept).toBe(true);
  });

  it('a --reason is optional', () => {
    const r = runPool(['keep', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const marker = JSON.parse(readFileSync(keepMarker(1), 'utf8'));
    expect(marker.reason).toBeNull();
  });

  it('never mutates the lane itself — keep is a pure record, not a reclaim', () => {
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    const before = readFileSync(join(lanePath(1), 'file.txt'), 'utf8');
    expect(runPool(['keep', '--lane=1', ...poolArgs()]).code).toBe(0);
    expect(readFileSync(join(lanePath(1), 'file.txt'), 'utf8')).toBe(before);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true);
  });

  it('re-running keep on the SAME content overwrites the marker (idempotent, not an error)', () => {
    expect(runPool(['keep', '--lane=1', '--reason=first', ...poolArgs()]).code).toBe(0);
    expect(runPool(['keep', '--lane=1', '--reason=second', ...poolArgs()]).code).toBe(0);
    const marker = JSON.parse(readFileSync(keepMarker(1), 'utf8'));
    expect(marker.reason).toBe('second');
  });
});
