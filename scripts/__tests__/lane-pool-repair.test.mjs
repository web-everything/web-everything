/**
 * @file scripts/__tests__/lane-pool-repair.test.mjs
 * @description xj1vryw — a corrupt lane clone / a dangling ref no longer blocks acquire. Reproduces the live
 *   2026-10-08 incident (lane-2: `fatal: bad object refs/heads/pr-1686`; lane-3: HEAD/index/commit-graph naming
 *   missing objects) against real clones, and proves a LIVE-leased lane is never quarantined.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { healLaneRefs, diagnoseLane, findBrokenRefs, looksLikeCorruption } from '../lib/lane-repair.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const BOGUS = '6b284a65a58521515c0bdcf9550484df3964df2c';

let base, originDir, referenceDir, poolRoot, fixtureRoot, sharedFixture;

function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=repair', '--branch=trunk', '--no-install'];
const laneDir = () => join(poolRoot, 'repair', 'lane-1');
const quarantineDir = () => join(poolRoot, 'repair', '.quarantine');

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-repair-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-repair-'));
  poolRoot = join(base, 'pool');
  expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

/** Plant a ref at an object that does not exist — what the gc'd shared store left behind. */
const plantDanglingRef = (dir, ref) => {
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', ref), BOGUS + '\n');
};

describe('xj1vryw — lane-repair lib', () => {
  it('finds and deletes dangling refs, leaving good ones', () => {
    plantDanglingRef(laneDir(), 'refs/heads/pr-1686');
    expect(findBrokenRefs(laneDir()).map((r) => r.ref)).toContain('refs/heads/pr-1686');
    const { actions } = healLaneRefs(laneDir());
    expect(actions.join('\n')).toMatch(/deleted dangling ref refs\/heads\/pr-1686/);
    expect(findBrokenRefs(laneDir())).toEqual([]);
    expect(diagnoseLane(laneDir()).ok).toBe(true);
  });
  it('diagnoses a broken index and a missing HEAD object as unhealthy', () => {
    writeFileSync(join(laneDir(), '.git', 'index'), 'garbage-not-an-index');
    expect(diagnoseLane(laneDir()).ok).toBe(false);
  });
  it('classifies corruption vs network messages', () => {
    expect(looksLikeCorruption('fatal: bad object refs/heads/pr-1686')).toBe(true);
    expect(looksLikeCorruption('fatal: unable to access: Could not resolve host')).toBe(false);
  });
});

describe('xj1vryw — acquire heals', () => {
  it('a dangling local ref (pr-1686) no longer breaks acquire: pruned with a logged reason', () => {
    plantDanglingRef(laneDir(), 'refs/heads/pr-1686');
    const r = runPool(['acquire', '--lane=1', '--session=s-ref', '--purpose=t', ...poolArgs()]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/deleted dangling ref refs\/heads\/pr-1686/);
    expect(findBrokenRefs(laneDir())).toEqual([]);
    expect(existsSync(quarantineDir())).toBe(false); // healed in place, no re-clone
  });

  it('a corrupt clone (broken index + HEAD branch at a missing object) is quarantined and re-provisioned, lease kept', () => {
    writeFileSync(join(laneDir(), '.git', 'index'), 'garbage-not-an-index');
    writeFileSync(join(laneDir(), '.git', 'refs', 'heads', 'trunk'), BOGUS + '\n');
    const r = runPool(['acquire', '--lane=1', '--session=s-corrupt', '--purpose=t', ...poolArgs()]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/QUARANTINED/);
    expect(readdirSync(quarantineDir()).some((d) => d.startsWith('lane-1-'))).toBe(true);
    expect(diagnoseLane(laneDir()).ok).toBe(true);
    expect(existsSync(join(laneDir(), '.git', '.lane-lease'))).toBe(true); // we hold the fresh lane
  });

  it('auto-pick hands out a healthy lane when the first candidate is corrupt', () => {
    writeFileSync(join(laneDir(), '.git', 'index'), 'garbage-not-an-index');
    const r = runPool(['acquire', '--session=s-auto', '--purpose=t', ...poolArgs()]);
    expect(r.code, r.err).toBe(0);
    expect(diagnoseLane(laneDir()).ok).toBe(true);
  });

  it('NEVER quarantines a lane held by a live lease (refresh skips it)', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s-live', '--purpose=t', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(laneDir(), '.git', 'index'), 'garbage-not-an-index');
    runPool(['provision', '--count=1', ...poolArgs()]);
    expect(existsSync(quarantineDir())).toBe(false);
    expect(existsSync(join(laneDir(), '.git', '.lane-lease'))).toBe(true);
  });
});
