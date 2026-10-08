/**
 * @file scripts/__tests__/lane-pool-hold-rule.test.mjs
 * @description xbdixjc — the lane hold rule wired through the real `lane-pool.mjs` CLI and the lease reaper's
 *   plan. On 2026-10-08 the reaper's `release --force` dropped lanes whose fixer was parked awaiting verify, and
 *   acquire reset a lane over a verified, unpushed commit because ONE already-pushed ahead commit "proved" the
 *   whole stack pushed. Each case here fails on main and passes with the rule; `WE_LANE_HOLD=off` /
 *   `WE_LANE_AHEAD_EQUIVALENCE=any` reproduce the old behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLaneHold } from '../conveyor/lease-reaper.mjs';
import { checkLaneHold } from '../lib/lane-hold-io.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let base, poolRoot, storeDir, originDir, referenceDir, fixtureRoot, sharedFixture;

function runPool(args, extraEnv = {}) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_AWAIT_VERIFY_STORE: storeDir, CLAUDE_CODE_SESSION_ID: 'sess-test', ...extraEnv };
  delete env.LANE_SESSION;
  for (const k of ['WE_LANE_HOLD', 'WE_LANE_HOLD_MINUTES', 'WE_LANE_AHEAD_EQUIVALENCE']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-hold-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-hold-'));
  poolRoot = join(base, 'pool');
  storeDir = join(base, 'await-store');
  mkdirSync(storeDir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=lanehold', '--branch=trunk', '--no-install'];
const laneDir = () => join(poolRoot, 'lanehold', 'lane-1');
const journal = () => {
  const p = join(poolRoot, 'lanehold', '.lane-journal.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** A leased lane-1 with one committed, unpushed fix, as a parked fixer leaves it. */
function parkedFixerLane({ awaitRecord = true, verified = false } = {}) {
  expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
  expect(runPool(['acquire', '--lane=1', '--session=fix-4453', ...poolArgs()]).code).toBe(0);
  const dir = laneDir();
  git(['config', 'user.email', 't@t.com'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(join(dir, 'file.txt'), 'fix\n');
  git(['commit', '--quiet', '-am', 'fix'], dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  const now = new Date().toISOString();
  if (awaitRecord) {
    writeFileSync(join(dir, '.git', '.fix-await-verify'), JSON.stringify({ v: 1, who: 'fix-4453', pr: 4453, sha, requestedAt: now, attempt: 1 }));
  }
  if (verified) {
    writeFileSync(join(dir, '.git', '.lane-verify'), JSON.stringify({ sha, status: 'green', startedAt: now, finishedAt: now, exitCode: 0 }));
  }
  return { dir, sha };
}

describe('release (the reaper path: `release --force`)', () => {
  it('refuses to drop a lane whose fixer is parked awaiting verify, and journals the refusal', () => {
    const { dir } = parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--force', '--reason=session-gone', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(true);
    const refusal = journal().find((e) => e.action === 'hold-refused');
    expect(refusal).toMatchObject({ hold: 'awaiting-verify' });
    expect(journal().some((e) => e.action === 'release' && e.unpushed === true)).toBe(false);
  });

  it('refuses a verified, unpushed commit with no await record', () => {
    parkedFixerLane({ awaitRecord: false, verified: true });
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(0);
    expect(journal().find((e) => e.action === 'hold-refused')).toMatchObject({ hold: 'verified-unpushed' });
  });

  it('a shared-store await record bound to the lane holds it too', () => {
    const { dir, sha } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(join(storeDir, 'sess-fixer.json'), JSON.stringify({ v: 1, sessionId: 'sess-fixer', who: 'fix-4453', pr: 4453, sha, lane: dir, ref: 'lane/x', kind: 'fix', requestedAt: new Date().toISOString(), attempt: 1 }));
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(0);
  });

  it('the holder still releases its own lane', () => {
    parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs(), '--json']);
    expect(JSON.parse(r.out).released).toBe(1);
  });

  it('WE_LANE_HOLD=off restores the old behaviour (the reaper drops it)', () => {
    parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper', WE_LANE_HOLD: 'off' });
    expect(JSON.parse(r.out).released).toBe(1);
  });
});

describe('acquire', () => {
  it('never takes over a stale lease on a lane whose fixer is parked awaiting verify, even with --force', () => {
    const { dir, sha } = parkedFixerLane();
    const leasePath = join(dir, '.git', '.lane-lease');
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    writeFileSync(leasePath, JSON.stringify({ ...lease, acquiredAt: '2000-01-01T00:00:00.000Z' }));
    const r = runPool(['acquire', '--lane=1', '--force', '--session=review-4484', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'reviewer' });
    expect(r.code).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
  });

  it('never resets an unleased lane over a verified unpushed fix stacked on an already-pushed PR commit', () => {
    // the lane-5 17:56Z shape: the PR's earlier commit is on a remote `lane/*` ref, the new fix commit is not.
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const dir = laneDir();
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'pr.txt'), 'pr\n');
    git(['add', 'pr.txt'], dir);
    git(['commit', '--quiet', '-m', 'pr commit'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/pr-branch'], dir);
    writeFileSync(join(dir, 'file.txt'), 'fix\n');
    git(['commit', '--quiet', '-am', 'fix commit (verified, not pushed)'], dir);
    const sha = git(['rev-parse', 'HEAD'], dir);
    const r = runPool(['acquire', '--lane=1', '--session=smoke', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'smoke' });
    expect(r.code).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
    // The old 'any' rule hands the same lane out and resets it — the bug this guards.
    const old = runPool(['acquire', '--lane=1', '--session=smoke', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'smoke', WE_LANE_AHEAD_EQUIVALENCE: 'any' });
    expect(old.code).toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).not.toBe(sha);
  });
});

describe('trim and reclaim', () => {
  it('trim never removes a lane whose fixer is parked awaiting verify, even when its work is pushed', () => {
    const { dir } = parkedFixerLane();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/fix-4453'], dir);
    runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs()]);
    runPool(['trim', '--max=0', ...poolArgs(), '--json']);
    expect(existsSync(dir)).toBe(true);
  });

  it('reclaim --override refuses a lane whose fixer is parked awaiting verify', () => {
    const { dir, sha } = parkedFixerLane();
    runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs()]);
    const r = runPool(['reclaim', '--lane=1', '--override', ...poolArgs(), '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ reclaimed: false, hold: 'awaiting-verify' });
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
  });
});

describe('lease reaper plan', () => {
  it('moves a held lane from reap to keep with a held:<hold> reason', () => {
    const plan = { reap: [{ pool: 'p', lane: 1, dir: '/a', reason: 'session-gone', lease: {} }, { pool: 'p', lane: 2, dir: '/b', reason: 'pr-merged', lease: {} }], keep: [] };
    const check = (dir) => (dir === '/a' ? { allowed: false, hold: 'awaiting-verify', reason: 'lane-hold: parked' } : { allowed: true, hold: null });
    const out = applyLaneHold(plan, { nowMs: 0, check });
    expect(out.reap.map((c) => c.lane)).toEqual([2]);
    expect(out.keep).toEqual([expect.objectContaining({ lane: 1, reason: 'held:awaiting-verify', wouldHaveBeen: 'session-gone' })]);
  });
  it('fails closed when the check throws nothing useful', () => {
    const out = applyLaneHold({ reap: [{ lane: 1, dir: '/a', reason: 'ttl-stale' }], keep: [] }, { nowMs: 0, check: () => null });
    expect(out.reap).toEqual([]);
  });
  it('the real check reads a live lane: parked fixer → held', () => {
    const { dir } = parkedFixerLane();
    expect(checkLaneHold(dir, { action: 'release', storeDir, env: {} })).toMatchObject({ allowed: false, hold: 'awaiting-verify' });
  });
});
