/**
 * @file scripts/__tests__/lane-pool-acquire-lock-contention.test.mjs
 * @description Proof of the xj2k2pp fix (epic #3383/#4075, backlog #4173, soak break `lane-acquire-under-load`).
 *   `acquirableListCached`'s "wait for someone ELSE's in-flight shared scan" loop (`we:scripts/lane-pool.mjs`)
 *   used to be bounded ONLY by `scanTimeoutMs + LIST_LOCK_ORPHAN_GRACE_MS` — the SCAN's own generous budget —
 *   never by THIS caller's own, usually much smaller, `--wait-ms`. So a caller with a small `--wait-ms` who
 *   loses the race for the single-flight scan lock to a slower, longer-lived caller sat there until either (a)
 *   the lock owner's scan actually finished (fresh cache appears), or (b) the lock was judged stale (the OTHER
 *   caller's scan-timeout + grace elapsed) — whichever came first — REGARDLESS of its own wait-ms having long
 *   since elapsed. At 14-lane/5-caller soak scale this produced the "serialized staircase": waiters returning
 *   33s/34s/45s/56s/68s for a `--wait-ms=20000` bound of ~40s (`SOAK_LOAD_LANES=14 SOAK_LOAD_CALLERS=5 node
 *   we:scripts/conveyor/soak/run.mjs break lane-acquire-under-load`).
 *
 *   THE FIX: `acquirableListCached` now takes a `callerDeadlineMs` (this acquire call's own `wait-ms` deadline)
 *   and checks it EVERY time it is about to sit out someone else's lock — never widening the shared scan's own
 *   budget (a genuinely different, longer-lived caller sharing that same lock still gets the full scan), only
 *   bounding how long THIS caller may wait on it. On its own deadline, it throws a distinguishable
 *   `{ lockContention: true }` error, which `cmdAcquire` reports as its own clear reason ("lock contention"),
 *   distinct from "N all held/dirty" (a completed scan found nothing) and "the acquirability scan itself did
 *   not finish" (the scan itself hung) — mirroring the existing `sawScanTimeout` handling exactly, including
 *   refusing to let growth-on-empty fire on it (an unanswered lock is not proof the pool is starved).
 *
 *   Same throwaway origin+pool harness shape as the sibling `lane-pool-acquire-scan-wait-decouple.
 *   test.mjs` this file is modeled on.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=lockwait', '--branch=main', '--no-install', '--no-reap'];
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 30_000 });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runPoolAsync(args, extraEnv = {}) {
  return new Promise((res) => {
    const c = spawn('node', [SCRIPT, ...args], { env: env(extraEnv), timeout: 25_000 });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => res({ code, out, err }));
  });
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-lockwait-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-lockwait-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool acquire (xj2k2pp) — the shared-scan LOCK WAIT is bounded by the caller\'s own --wait-ms', () => {
  it('contenders leave a live scan lock untouched and return without starting a serialized scan', async () => {
    provision(3);
    // Install a real lock owned by this live process before starting any contender. No sleep-based
    // race, slow git, or host-speed assertion: the owner cannot finish until we explicitly release it.
    const lock = join(poolRoot, 'lockwait', '.list-acquirable.lock');
    mkdirSync(lock);
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() });
    writeFileSync(join(lock, 'owner.json'), owner);
    const audit = join(base, 'git-calls');
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${audit}"\nexec "${REAL_GIT}" "$@"\n`);
    const waiters = await Promise.all(Array.from({ length: 5 }, (_, i) => runPoolAsync([
      'acquire', ...REPO(), `--session=waiter-${i}`, '--wait-ms=500',
      '--scan-timeout-ms=30000', '--hard-max=3',
    ])));
    for (const waiter of waiters) {
      expect(waiter.code).not.toBe(0);
      expect(waiter.err).toMatch(/lock contention/i);
      expect(waiter.err).toMatch(/no lane within \d+ms/);
      expect(waiter.err).not.toMatch(/all held\/dirty|scan itself did not finish/);
    }
    expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(owner);
    // Repo discovery may call git; lane inspection/mutation must never start behind this owner.
    const calls = existsSync(audit) ? readFileSync(audit, 'utf8') : '';
    expect(calls).not.toMatch(/(?:status|rev-list|checkout|fetch|reset|clone)(?: |$)/m);
    rmSync(lock, { recursive: true });
    const next = runPool(['acquire', ...REPO(), '--session=after-owner', '--wait-ms=0', '--hard-max=3']);
    expect(next.code, next.err).toBe(0);
  }, 30_000);
});
