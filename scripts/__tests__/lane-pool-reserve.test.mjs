/**
 * @file scripts/__tests__/lane-pool-reserve.test.mjs
 * @description Proof of the #2350 PERMANENT reserved-lane primitive in `scripts/lane-pool.mjs` +
 *   `scripts/lib/lane-lease.mjs`. `acquire --reserve --lane=N` mints a reserved lease that NEVER expires and
 *   is off-limits to the whole pool: auto-pick skips it, an explicit `acquire --lane=N` (even `--force`)
 *   hard-fails on it, `refresh`/`provision` (even `--force`) never reset it, and a plain `release` (even
 *   `--force`) refuses to hand it back — only the deliberate `release --release-reserved` un-reserves it. This
 *   is the agent-doable half of #2350 (provision the dedicated persistent memory-lane); the live repoint of the
 *   machine-global `~/.claude/…/memory` symlink at it is the SUPERVISED, human-gated half and is NOT exercised
 *   here. The CLI tests spawn the real script against a throwaway local origin + reference checkout (no network,
 *   no shared pool root); the pure tests exercise the lease-decision core directly.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLeaseStale, isReservedLease, leaseBody } from '../lib/lane-lease.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANE_POOL_ROOT: poolRoot },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const COMMON = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=reservetest', '--branch=main', '--no-install'];

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-reserve-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-reserve-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function provision(count) {
  const r = runPool(['provision', `--count=${count}`, ...COMMON()]);
  expect(r.code).toBe(0);
  return (n) => join(poolRoot, 'reservetest', `lane-${n}`);
}

// Reserve lane-1 with a stable owner slug; returns that lane's path.
function reserveLane1(lanePath) {
  const r = runPool(['acquire', '--reserve', '--lane=1', '--session=memory-lane', '--purpose=memory', ...COMMON()]);
  expect(r.code).toBe(0);
  expect(r.out + r.err).toMatch(/RESERVED lane-1/);
  return lanePath(1);
}

describe('lane-pool #2350 — PERMANENT reserved lane', () => {
  it('acquire --reserve --lane=N stamps a reserved lease (reserved:true in the marker)', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    const marker = JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8'));
    expect(marker.reserved).toBe(true);
    expect(marker.session).toBe('memory-lane');
  });

  it('--reserve WITHOUT --lane fails loud (a reserved lane is a specific, known slot)', () => {
    provision(1);
    const r = runPool(['acquire', '--reserve', '--session=memory-lane', ...COMMON()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--reserve requires an explicit --lane/);
  });

  it('auto-pick acquire SKIPS the reserved lane and picks another', () => {
    const lanePath = provision(2);
    reserveLane1(lanePath);
    const r = runPool(['acquire', '--session=consumer', '--no-reset', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(lanePath(2)); // lane-1 is reserved → auto-pick lands on lane-2
  });

  it('explicit acquire --lane=N on a reserved lane HARD-FAILS, even with --force (points at --release-reserved)', () => {
    const lanePath = provision(1);
    reserveLane1(lanePath);
    const r = runPool(['acquire', '--lane=1', '--force', '--session=intruder', ...COMMON()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PERMANENT reserved lane/);
    expect(r.err).toMatch(/--release-reserved/);
  });

  it('explicit acquire --lane=N by the OWNING session (no --reserve) HARD-FAILS — never self-un-reserves + wipes', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath); // owner slug is `memory-lane`
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n');

    // The reserved lane's OWN session re-acquiring it plainly (forgetting --reserve) must NOT downgrade the
    // lease and reset --hard the lane. It hard-fails, and the accrued content + reserved marker survive.
    const r = runPool(['acquire', '--lane=1', '--session=memory-lane', ...COMMON()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PERMANENT reserved lane/);
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory');
    expect(JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8')).reserved).toBe(true);
  });

  it('idempotent re-reserve (acquire --reserve --lane=N again) keeps it reserved AND does NOT wipe accrued content', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n');

    const r = runPool(['acquire', '--reserve', '--lane=1', '--session=memory-lane', '--purpose=memory', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8')).reserved).toBe(true); // still reserved
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory'); // NOT reset away
  });

  it('refresh --force does NOT reset a reserved lane — its dirty work survives', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n'); // the kind of write the memory-lane accrues

    const r = runPool(['refresh', '--force', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED/);
    expect(r.out + r.err).toMatch(/reserved lane/i);
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory');
  });

  it('provision --force does NOT reset a reserved lane', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n');

    const r = runPool(['provision', '--count=1', '--force', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/SKIPPED/);
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory');
  });

  it('release (even --force) REFUSES a reserved lane; the lease survives', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    const r = runPool(['release', '--lane=1', '--force', '--session=intruder', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/PERMANENT reserved lane/);
    expect(existsSync(LEASE_FILE(lane))).toBe(true); // lease NOT dropped
    expect(JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8')).reserved).toBe(true);
  });

  it('release --release-reserved is the deliberate un-reserve; the lane becomes acquirable again', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);

    const rel = runPool(['release', '--lane=1', '--release-reserved', ...COMMON()]);
    expect(rel.code).toBe(0);
    expect(existsSync(LEASE_FILE(lane))).toBe(false); // reserved lease dropped

    // Now an ordinary acquire can claim it again.
    const reacq = runPool(['acquire', '--lane=1', '--session=consumer', '--no-reset', ...COMMON()]);
    expect(reacq.code).toBe(0);
  });

  // #2350 (review:changes on #745) — `remove` teardown must NOT wipe a reserved memory lane.
  it('remove --all leaves a reserved lane (its dir + accrued content) intact', () => {
    const lanePath = provision(2);
    const lane = reserveLane1(lanePath);
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n'); // the kind of write the memory-lane accrues

    const r = runPool(['remove', '--all', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/PERMANENT reserved lane/);
    // lane-1 (reserved) survives, content and lease intact; lane-2 (ordinary) is torn down.
    expect(existsSync(lane)).toBe(true);
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory');
    expect(JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8')).reserved).toBe(true);
    expect(existsSync(lanePath(2))).toBe(false);
  });

  it('remove --lane=N REFUSES a reserved lane; its dir + content survive', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);
    writeFileSync(join(lane, 'memory-write.txt'), 'live memory\n');

    const r = runPool(['remove', '--lane=1', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/PERMANENT reserved lane/);
    expect(existsSync(lane)).toBe(true);
    expect(readFileSync(join(lane, 'memory-write.txt'), 'utf8')).toContain('live memory');
  });

  it('remove --lane=N --release-reserved is the deliberate teardown escape hatch (single-lane)', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);

    const r = runPool(['remove', '--lane=1', '--release-reserved', ...COMMON()]);
    expect(r.code).toBe(0);
    expect(existsSync(lane)).toBe(false); // deliberately torn down
  });

  // #2350 (review:changes on #745) — `--release-reserved` is single-lane BY CONTRACT: never a bulk `--all` act.
  it('release --all --release-reserved is REJECTED (must name an explicit --lane); the reserved lease survives', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);

    const r = runPool(['release', '--all', '--release-reserved', ...COMMON()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--release-reserved may not be combined with --all/);
    expect(existsSync(LEASE_FILE(lane))).toBe(true); // NOT un-reserved
    expect(JSON.parse(readFileSync(LEASE_FILE(lane), 'utf8')).reserved).toBe(true);
  });

  it('remove --all --release-reserved is REJECTED (single-lane teardown only); the reserved lane survives', () => {
    const lanePath = provision(1);
    const lane = reserveLane1(lanePath);

    const r = runPool(['remove', '--all', '--release-reserved', ...COMMON()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--release-reserved may not be combined with --all/);
    expect(existsSync(lane)).toBe(true); // NOT torn down
  });
});

describe('lane-pool #2350 — reserved lease decision core (pure)', () => {
  it('a reserved lease NEVER goes stale, regardless of age / TTL', () => {
    const reserved = leaseBody({ session: 'memory-lane', acquiredAt: new Date(0).toISOString(), reserved: true });
    // Even with an ancient acquiredAt and a zero TTL, a reserved lease is never stale.
    expect(isLeaseStale(reserved, Date.now(), 0)).toBe(false);
    expect(isReservedLease(reserved)).toBe(true);
  });

  it('an ordinary lease still expires on TTL (reserved short-circuit does not leak)', () => {
    const ordinary = leaseBody({ session: 's', acquiredAt: new Date(0).toISOString(), ttlMinutes: 1 });
    expect(isReservedLease(ordinary)).toBe(false);
    expect(isLeaseStale(ordinary, Date.now(), 60_000)).toBe(true); // long past a 1-min TTL
  });

  it('leaseBody omits `reserved` when false (back-compat byte-identical marker) and includes it when true', () => {
    const plain = leaseBody({ session: 's', acquiredAt: 'now' });
    expect('reserved' in plain).toBe(false);
    const res = leaseBody({ session: 's', acquiredAt: 'now', reserved: true });
    expect(res.reserved).toBe(true);
  });
});
