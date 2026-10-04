/**
 * @file scripts/__tests__/lane-pool-cross-pool.test.mjs
 * @description Proof of the #2667 POOL-AWARE release in `scripts/lane-pool.mjs`: the `--pool=<name>` selector
 *   (release/status a pool by its dir-name, no checkout path) and `release --all-pools --session=<slug>` (sweep
 *   EVERY pool under POOL_ROOT and hand back that session's leases — the cross-locus couple cleanup that clears
 *   a WE-pool lane AND a plateau-app-pool lane in one call). Spawns the real script against a throwaway origin +
 *   reference checkout under a private POOL_ROOT holding TWO pools (no network, no shared pool root). Pool names
 *   deliberately avoid the WE band names so no constellation-sibling clone is provisioned.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    // cwd = the reference checkout so resolveRepo can always derive an origin (release --all-pools needs none,
    // but resolveRepo still runs before dispatch); the private LANE_POOL_ROOT scopes every pool op.
    cwd: referenceDir,
    env: { ...process.env, LANE_POOL_ROOT: poolRoot },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// Provision/acquire flags for a named pool over the throwaway origin (no npm install, own branch).
const POOL = (name) => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install'];
const lanePath = (name, n) => join(poolRoot, name, `lane-${n}`);

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-xpool-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  execFileSync('bash', ['-c', 'echo v1 > file.txt'], { cwd: referenceDir });
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-xpool-'));
  poolRoot = join(base, 'pool');

  // Two pools under one POOL_ROOT, 2 lanes each.
  expect(runPool(['provision', '--count=2', ...POOL('poolA')]).code).toBe(0);
  expect(runPool(['provision', '--count=2', ...POOL('poolB')]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

// Acquire a specific lane in a named pool under a given session (no reset needed — testing the lease only).
function acquire(name, lane, session, extra = []) {
  const r = runPool(['acquire', `--lane=${lane}`, `--session=${session}`, '--no-reset', ...extra, ...POOL(name)]);
  expect(r.code).toBe(0);
  return lanePath(name, lane);
}

describe('lane-pool #2667 — release --all-pools --session sweeps every pool', () => {
  it('releases the session\'s leases in BOTH pools; leaves other sessions and other lanes held', () => {
    const a1 = acquire('poolA', 1, 'conveyor-9999'); // couple's WE half
    const b1 = acquire('poolB', 1, 'conveyor-9999'); // couple's impl half (different pool)
    const a2 = acquire('poolA', 2, 'other-session');  // an unrelated live lease
    expect(existsSync(LEASE_FILE(a1))).toBe(true);
    expect(existsSync(LEASE_FILE(b1))).toBe(true);

    const r = runPool(['release', '--all-pools', '--session=conveyor-9999', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.released).toBe(2);
    // both pools reported, each with its released lane
    const byPool = Object.fromEntries(out.pools.map((p) => [p.pool, p.lanes]));
    expect(byPool.poolA).toEqual([1]);
    expect(byPool.poolB).toEqual([1]);

    expect(existsSync(LEASE_FILE(a1))).toBe(false); // conveyor-9999 lanes released in both pools
    expect(existsSync(LEASE_FILE(b1))).toBe(false);
    expect(existsSync(LEASE_FILE(a2))).toBe(true); // other-session lane untouched
  });

  it('a session holding no leases anywhere → released:0, no error', () => {
    acquire('poolA', 1, 'conveyor-9999');
    const r = runPool(['release', '--all-pools', '--session=nobody', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(LEASE_FILE(lanePath('poolA', 1)))).toBe(true); // untouched
  });

  it('NEVER reaps a reserved lane in the sweep (its whole point is to survive routine release)', () => {
    acquire('poolA', 1, 'conveyor-9999');
    // reserve poolB/lane-2 under the SAME session — the sweep must still skip it.
    const resv = runPool(['acquire', '--reserve', '--lane=2', '--session=conveyor-9999', '--purpose=memory', ...POOL('poolB')]);
    expect(resv.code).toBe(0);
    const resvLane = lanePath('poolB', 2);

    const r = runPool(['release', '--all-pools', '--session=conveyor-9999', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1); // only the ordinary poolA lane
    expect(existsSync(LEASE_FILE(lanePath('poolA', 1)))).toBe(false);
    expect(existsSync(LEASE_FILE(resvLane))).toBe(true); // reserved lane survives
    expect(JSON.parse(readFileSync(LEASE_FILE(resvLane), 'utf8')).reserved).toBe(true);
  });

  it('release --all-pools WITHOUT --session fails loud', () => {
    const r = runPool(['release', '--all-pools']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/requires --session/);
  });

  it('release --all-pools --all is rejected (cross-pool release is BY SESSION)', () => {
    const r = runPool(['release', '--all-pools', '--all', '--session=conveyor-9999']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not allowed/);
  });
});

describe('lane-pool #2748 — release --all-pools --item sweeps every pool BY ITEM (drain release-on-land)', () => {
  it('releases every lease whose session ENCODES the item number, in both pools; leaves others held', () => {
    const a1 = acquire('poolA', 1, 'conveyor-9999'); // couple's WE half
    const b1 = acquire('poolB', 1, 'conveyor-9999'); // couple's impl half (different pool)
    const a2 = acquire('poolA', 2, 'conveyor-8888'); // an unrelated item's live lease

    const r = runPool(['release', '--all-pools', '--item=9999', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.item).toBe(9999);
    expect(out.released).toBe(2);
    const byPool = Object.fromEntries(out.pools.map((p) => [p.pool, p.lanes]));
    expect(byPool.poolA).toEqual([1]);
    expect(byPool.poolB).toEqual([1]);
    expect(existsSync(LEASE_FILE(a1))).toBe(false);
    expect(existsSync(LEASE_FILE(b1))).toBe(false);
    expect(existsSync(LEASE_FILE(a2))).toBe(true); // item #8888 untouched
  });

  it('matches an UNPADDED session number numerically (--item=99 ↔ conveyor-99)', () => {
    const a1 = acquire('poolA', 1, 'conveyor-99');
    const r = runPool(['release', '--all-pools', '--item=99', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1);
    expect(existsSync(LEASE_FILE(a1))).toBe(false);
  });

  it('a retry-suffix session for the same item still matches', () => {
    const b1 = acquire('poolB', 1, 'conveyor-7777b'); // retry suffix collapses to 7777
    const r = runPool(['release', '--all-pools', '--item=7777', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1);
    expect(existsSync(LEASE_FILE(b1))).toBe(false);
  });

  // #x5wm9ot (bug #1) — `fix-<PR>`'s number IS A PR NUMBER (mintSessionSlug mints it FROM a PR number), a
  // DIFFERENT namespace from a true backlog item number. This used to ALSO match `--item=N` here (the exact
  // bug: landing item 7777 could drop an unrelated `fix-7777` session's lane just because its PR happened to
  // be numbered 7777) — now it correctly does not.
  it('does NOT match a fix-<PR> session even when its PR number equals the item number (bug #1 fix)', () => {
    const a1 = acquire('poolA', 1, 'fix-7777');
    const r = runPool(['release', '--all-pools', '--item=7777', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(LEASE_FILE(a1))).toBe(true); // the fix session's own lease survives, untouched
  });

  it('NEVER releases a reserved lane in the by-item sweep', () => {
    const resv = runPool(['acquire', '--reserve', '--lane=2', '--session=conveyor-9999', '--purpose=memory', ...POOL('poolB')]);
    expect(resv.code).toBe(0);
    acquire('poolA', 1, 'conveyor-9999');
    const r = runPool(['release', '--all-pools', '--item=9999', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(1); // only the ordinary poolA lane
    expect(existsSync(LEASE_FILE(lanePath('poolB', 2)))).toBe(true); // reserved survives
  });

  it('--item with neither a match → released:0, no error', () => {
    acquire('poolA', 1, 'conveyor-9999');
    const r = runPool(['release', '--all-pools', '--item=1234', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(LEASE_FILE(lanePath('poolA', 1)))).toBe(true);
  });

  it('--session and --item together is rejected (pick one selector)', () => {
    const r = runPool(['release', '--all-pools', '--session=conveyor-9999', '--item=9999']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not both/);
  });
});

describe('lane-pool #2667 — --pool=<name> selects a pool by dir-name (no checkout path)', () => {
  it('release --pool=<name> --lane=N targets that pool, not the cwd\'s', () => {
    const b1 = acquire('poolB', 1, 'sess-x');
    // Release it by pool NAME + session, with NO --origin/--reference/--repo — just --pool.
    const r = runPool(['release', '--pool=poolB', '--lane=1', '--session=sess-x']);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(b1))).toBe(false);
  });

  it('status --pool=<name> reads that pool without a checkout path', () => {
    acquire('poolA', 1, 'sess-y');
    const r = runPool(['status', '--pool=poolA', '--json']);
    expect(r.code).toBe(0);
    const st = JSON.parse(r.out);
    expect(st.repo).toBe('poolA');
    const l1 = st.lanes.find((l) => l.lane === 1);
    expect(l1.leased).toBe(true);
    expect(l1.lease.session).toBe('sess-y');
  });
});
