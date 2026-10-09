/**
 * @file scripts/__tests__/lane-pool-reap-on-list-acquirable.test.mjs
 * @description Proof of #3449: `list --acquirable` (the read `dispatch-plan.mjs` calls to size launch capacity)
 *   now runs the SAME provably-dead-ghost reap `acquire` already runs (`reapDeadLeasesInPool`, #2748) before
 *   filtering — so a pool saturated with ghost leases (holder gone, item resolved on main) can reclaim them via
 *   a read-only capacity check ALONE, with no `acquire` call ever made. Before this fix the reap only ran as a
 *   side effect of `acquire`, so a capacity read that never triggers an `acquire` (because it kept reporting
 *   low/no capacity) could never break the deadlock — this test fails against that pre-fix code. Same tier-1
 *   geometry as `lane-pool-reap-on-acquire.test.mjs` (real child process, throwaway bare origin + reference,
 *   private `LANE_POOL_ROOT`, no network).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_LEASE_TTL_MINUTES } from '../lib/lane-lease.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: referenceDir,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot }),
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function backdateLease(laneDirPath, minutesAgo) {
  const file = LEASE_FILE(laneDirPath);
  const lease = JSON.parse(readFileSync(file, 'utf8'));
  lease.acquiredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(lease, null, 2) + '\n');
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=listreap`, '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'listreap', `lane-${n}`);

function pushCard(num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

function acquire(lane, session, extra = []) {
  const r = runPool(['acquire', `--lane=${lane}`, `--session=${session}`, '--no-reset', '--no-reap', ...extra, ...poolArgs()]);
  expect(r.code).toBe(0);
  return lanePath(lane);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-list-reap-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-list-reap-'));
  poolRoot = join(base, 'pool');

  expect(runPool(['provision', '--count=2', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool #3449 — `list --acquirable` reaps a provably-dead ghost with NO acquire call', () => {
  it('reclaims a TTL-stale, item-resolved ghost lease via `list --acquirable` alone, and reports the freed lane', () => {
    pushCard('9999', 'resolved');
    const ghost = acquire(1, 'conveyor-9999'); // a lingering lease for an already-resolved item
    expect(existsSync(LEASE_FILE(ghost))).toBe(true);
    backdateLease(ghost, DEFAULT_LEASE_TTL_MINUTES + 60); // its holder outlived its heartbeat — a real ghost

    // A read-only capacity query — the exact call `dispatch-plan.mjs` makes — with NO acquire ever run.
    const r = runPool(['list', '--acquirable', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(ghost))).toBe(false); // ghost reaped by the READ alone
    expect(r.err).toMatch(/reaped lane-1 before acquire/);
    expect(JSON.parse(r.out)).toEqual(expect.arrayContaining([lanePath(1), lanePath(2)])); // lane-1 now offered
  });

  it('does NOT reap a lease whose item is still OPEN (positive-death-signal only, #2267 — unchanged by #3449)', () => {
    pushCard('8888', 'open');
    const live = acquire(1, 'conveyor-8888');
    // Keep the lease FRESH (not TTL-stale): a stale-but-un-reaped lease is already reported acquirable by the
    // pre-existing `isLaneAcquirable` stale check (see `lane-pool-acquirable.test.mjs`), which would make this
    // case indistinguishable from a reap. A fresh, live lease is the case that isolates "was it REAPED".
    const r = runPool(['list', '--acquirable', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(live))).toBe(true); // NOT reaped — no death signal
    expect(JSON.parse(r.out)).toEqual([lanePath(2)]); // lane-1 still held, so still filtered out
  });

  it('NEVER reaps a reserved lane via `list --acquirable`, even when its item is resolved', () => {
    pushCard('9999', 'resolved');
    const resv = runPool(['acquire', '--reserve', '--lane=1', '--session=conveyor-9999', '--purpose=memory', ...poolArgs()]);
    expect(resv.code).toBe(0);
    backdateLease(lanePath(1), DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['list', '--acquirable', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(lanePath(1)))).toBe(true); // reserved memory lane survives
  });

  it('--no-reap opts out of the reap triggered by `list --acquirable` too', () => {
    pushCard('9999', 'resolved');
    const ghost = acquire(1, 'conveyor-9999');
    backdateLease(ghost, DEFAULT_LEASE_TTL_MINUTES + 60);

    const r = runPool(['list', '--acquirable', '--json', '--no-reap', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(ghost))).toBe(true); // not reaped
  });
});
