/**
 * @file scripts/__tests__/lane-pool-reap-on-acquire.test.mjs
 * @description Proof of the #2748 ACQUIRE-NATIVE REAPER BACKSTOP in `scripts/lane-pool.mjs`: before allocating,
 *   `acquire` reclaims a PROVABLY-DEAD ghost lease — one whose item card reads `status: resolved` on origin/main
 *   (the OFFLINE item-resolved axis; the gh PR axis degrades OFF against a non-GitHub throwaway origin, so this
 *   exercises the offline path deterministically) — while NEVER reaping a lease whose item is still open (the
 *   #2267 positive-death-signal-only safety) and NEVER a reserved lane. Spawns the real script against a
 *   throwaway origin + reference under a private POOL_ROOT (no network, no shared pool root).
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

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: referenceDir,
    env: { ...withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot }), ...extraEnv },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// #3283 — BACKDATE a lease past its TTL, in place. The reaper's narrowing turns "is this lease still alive?"
// into a real precondition, so the TTL-stale ghost that #2748 exists for has to be MADE stale rather than
// merely asserted about. Rewrites only `acquiredAt`, so every other field stays exactly as acquire stamped it.
function backdateLease(laneDirPath, minutesAgo) {
  const file = LEASE_FILE(laneDirPath);
  const lease = JSON.parse(readFileSync(file, 'utf8'));
  lease.acquiredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(lease, null, 2) + '\n');
}

// #3283 — a FAKE `gh` on PATH, so the live PR axis (`gh pr list`, `we:scripts/lane-pool.mjs:880`) can be
// exercised against the throwaway origin, where the real `gh` degrades the axis to OFF. Without this the PR
// axis is untestable here and its half of the fix would rest on the item-resolved axis's evidence — which the
// #3283 card's own retraction (b) records as the mistake that let a prior fix miss the demonstrated collapse.
function fakeGhOnPath(prs) {
  const binDir = join(base, `ghbin-${prs.length}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`, { mode: 0o755 });
  return { PATH: `${binDir}:${process.env.PATH}` };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=reappool`, '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'reappool', `lane-${n}`);

// Write a backlog card at a given status into the reference, commit + push (so origin/main carries it).
function pushCard(num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-reap-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-reap-'));
  poolRoot = join(base, 'pool');

  expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function acquire(lane, session, extra = []) {
  const r = runPool(['acquire', `--lane=${lane}`, `--session=${session}`, '--no-reset', '--no-reap', ...extra, ...poolArgs()]);
  expect(r.code).toBe(0);
  return lanePath(lane);
}

describe('lane-pool #2748 — acquire reaps a provably-dead (item-resolved) ghost before allocating', () => {
  // #3283 RE-POINTED — this case previously minted the ghost with `acquire(1, 'conveyor-9999')` and asserted
  // it was reaped MILLISECONDS later. That is the collapse #3283 fixes: a lease seconds old is structurally
  // indistinguishable from the live lease a concurrent acquire just took, so a terminal signal about the ITEM
  // is now NECESSARY BUT NOT SUFFICIENT. #2748's actual subject — a ghost whose holder is gone — is the
  // TTL-STALE lease below, and it is still reaped, on the same axis, with the same log line. The narrowing is
  // deliberate: see the fresh-lease inverse two cases down.
  it('reaps a TTL-STALE lease whose item is RESOLVED on origin/main when a fresh acquire runs', () => {
    pushCard('9999', 'resolved');
    const ghost = acquire(1, 'conveyor-9999'); // a lingering lease for an already-resolved item
    expect(existsSync(LEASE_FILE(ghost))).toBe(true);
    backdateLease(ghost, DEFAULT_LEASE_TTL_MINUTES + 60); // its holder outlived its heartbeat — a real ghost

    // A fresh acquire (reaper ON) on a DIFFERENT lane must first reclaim the dead lease on lane-1.
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(ghost))).toBe(false); // ghost reaped
    expect(r.err).toMatch(/reaped lane-1 before acquire/);
  });

  it('does NOT reap a lease whose item is still OPEN (positive-death-signal only, #2267)', () => {
    pushCard('8888', 'open');
    const live = acquire(1, 'conveyor-8888');
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(live))).toBe(true); // NOT reaped — no death signal
  });

  it('does NOT reap when there is no card for the item at all (unknown → keep)', () => {
    const live = acquire(1, 'conveyor-5555'); // no backlog/5555-*.md on main
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(live))).toBe(true);
  });

  it('NEVER reaps a reserved lane even when its item is resolved', () => {
    pushCard('9999', 'resolved');
    const resv = runPool(['acquire', '--reserve', '--lane=1', '--session=conveyor-9999', '--purpose=memory', ...poolArgs()]);
    expect(resv.code).toBe(0);
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(lanePath(1)))).toBe(true); // reserved memory lane survives
  });

  it('--no-reap opts out — a dead lease is left in place', () => {
    pushCard('9999', 'resolved');
    const ghost = acquire(1, 'conveyor-9999');
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', '--no-reap', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(ghost))).toBe(true); // not reaped
  });
});

/**
 * #3283 — the reaper reclaimed a lane SECONDS after it was handed out, so concurrent acquires all collided on
 * one lane. Two independent defects composed, and each case below fails on exactly one of them:
 *
 *   1. a TERMINAL signal about the ITEM ("its card is resolved" / "its PR merged") was used as a proxy for
 *      "is anyone holding this lease?" — two questions that only coincide once the holder has exited; and
 *   2. `itemNumFromSession` read the trailing digit run of ANY session slug as a backlog item number, so
 *      `probe1`, `Mac:<ppid>` and a minted `holder` slug all aliased onto real cards.
 *
 * Same tier-1 geometry as the block above (real `lane-pool.mjs` child processes, real bare origin + reference,
 * private `LANE_POOL_ROOT`), because the collapse is a property of the ALLOCATOR, not of a predicate.
 */
describe('lane-pool #3283 — a terminal item signal is necessary but NOT sufficient to reap', () => {
  it('case 1 — does NOT reap a FRESH lease whose slug merely ALIASES a resolved item, and hands out another lane', () => {
    pushCard('1', 'resolved'); // ~4 in 5 real backlog ids name a resolved card, so this is the common case
    const held = acquire(1, 'probe1'); // `probe1` is NOT item 1 — the alias is the whole defect
    const r = runPool(['acquire', '--session=fresh', '--no-reset', ...poolArgs()]); // auto-pick
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(held))).toBe(true); // the seconds-old lease survives
    expect(r.out.trim()).not.toBe(held);             // …and the acquire got a DIFFERENT lane
    expect(r.out.trim()).toBe(lanePath(2));
  });

  it('case 3 — does NOT reap a FRESH lease under a GENUINE conveyor slug whose item is resolved on main', () => {
    // The inverse of the re-pointed `#2748` case above, and the one that forces defect 1 to be closed:
    // `conveyor-9999` resolves to `'9999'` before AND after defect 2's fix, so tightening the slug grammar
    // cannot produce this outcome. Only gating the terminal axes on the lease's own liveness can.
    pushCard('9999', 'resolved');
    const held = acquire(1, 'conveyor-9999');
    const r = runPool(['acquire', '--session=fresh', '--no-reset', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(held))).toBe(true);
    expect(r.out.trim()).toBe(lanePath(2));
  });

  it('case 3b — the PR axis is gated too: a FRESH lease whose item PR is MERGED is not reaped', () => {
    // The offline item-resolved axis and the live `gh` axis both feed `prState`, and both must be gated —
    // otherwise the collapse simply moves to the axis with no case of its own. No card is pushed here, so the
    // MERGED PR reported by the fake `gh` is the ONLY death signal in play.
    const env = fakeGhOnPath([{ headRefName: 'lane/7777-some-slug', state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' }]);
    const held = acquire(1, 'conveyor-7777');
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(held))).toBe(true); // NOT reaped — the holder is seconds old
  });

  it('case 3b (twin) — …but a TTL-STALE lease whose item PR is MERGED still IS reaped on that axis', () => {
    // The gate narrows the PR axis; it does not switch it off. Without this twin, case 3b would also pass
    // against a fix that simply deleted the axis.
    const env = fakeGhOnPath([{ headRefName: 'lane/7777-some-slug', state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' }]);
    const ghost = acquire(1, 'conveyor-7777');
    backdateLease(ghost, DEFAULT_LEASE_TTL_MINUTES + 60);
    const r = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(ghost))).toBe(false);
    expect(r.err).toMatch(/reaped lane-1 before acquire \(pr-merged/);
  });

  it('case 5 — N successive acquires with NO release return N DISTINCT lanes, for BOTH slug shapes', () => {
    // The property that actually broke, and no case above states it. Both halves ran at 1 distinct lane
    // before the fix: the aliased half via defect 2, the genuine half via defect 1.
    pushCard('1', 'resolved');
    pushCard('2', 'resolved');
    pushCard('3', 'resolved');
    const aliased = [1, 2, 3].map((i) => {
      const r = runPool(['acquire', `--session=probe${i}`, '--no-reset', ...poolArgs()]);
      expect(r.code).toBe(0);
      return r.out.trim();
    });
    expect(new Set(aliased).size).toBe(3);

    // Same pool, drained and re-run under a GENUINE-but-resolved slug — the same slug every time, which is
    // exactly the conveyor's own dispatch shape.
    for (const n of [1, 2, 3]) expect(runPool(['release', `--lane=${n}`, '--force', ...poolArgs()]).code).toBe(0);
    pushCard('9999', 'resolved');
    const genuine = [1, 2, 3].map(() => {
      const r = runPool(['acquire', '--session=conveyor-9999', '--no-reset', ...poolArgs()]);
      expect(r.code).toBe(0);
      return r.out.trim();
    });
    expect(new Set(genuine).size).toBe(3);
  });
});
