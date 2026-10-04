/**
 * @file scripts/__tests__/lane-pool-acquire-free-list.test.mjs
 * @description Proof of #4122 — `acquire`'s auto-pick reads `we:scripts/conveyor/lane-pool-health-watch.mjs`'s
 *   pre-computed free-lane list (`we:scripts/lib/free-lane-list.mjs`) as a fast pre-filter, instead of always
 *   paying for its own full-pool scan. Live incident, 2026-09-25: `acquire` measured 240s / `list --acquirable`
 *   66s under load, against acquire's 180s wait, while 30+ lanes sat genuinely free. These tests spawn the real
 *   CLI against a throwaway local origin + pool (no network) with a PATH `git` shim that logs every git
 *   invocation's cwd (mirrors `lane-pool-list-cache.test.mjs`'s own harness), and assert:
 *   - a FRESH list naming a genuinely free lane is used, with far fewer lane git calls than a full scan;
 *   - a STALE list (older than `--free-list-max-age-ms`) is never consulted — acquire falls back to the scan
 *     and picks the scan's lowest free lane, never the stale list's higher-numbered one;
 *   - an EXHAUSTED fresh list (every listed lane taken) falls through to the scan in the SAME call, even with
 *     no `--wait-ms` and growth capped — never a false "all held/dirty" failure or a needless pool growth;
 *   - a lane the list named that went BUSY (leased by someone else) between the list being written and this
 *     acquire call is skipped — the claim fails, the lane is excluded, and a different lane is returned; never
 *     a double-claim;
 *   - a MISSING list is a pure no-op — acquire falls back to the scan exactly like before this feature existed;
 *   - `--no-free-list` opts out even when a fresh, valid list is sitting right there.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFreeLaneList, writeFreeLaneListAtomic, resolveFreeLaneListPath } from '../lib/free-lane-list.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, shimDir, traceLog;

const NAME = 'freelisttest';
const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${NAME}`, '--branch=main', '--no-install', '--no-reap'];
const pool = () => join(poolRoot, NAME);
const lanePath = (n) => join(pool(), `lane-${n}`);
const env = (extra = {}) => ({ ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog, ...extra });

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env(extraEnv) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function provision(count) {
  expect(runPool(['provision', `--count=${count}`, ...REPO()]).code).toBe(0);
}
function trace() {
  if (!existsSync(traceLog)) return [];
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [cwd, optionalLocks, args] = l.split('\t');
    return { cwd, optionalLocks, args };
  });
}
const resetTrace = () => rmSync(traceLog, { force: true });
const laneGitCalls = () => trace().filter((t) => t.cwd.startsWith(realpathSync(pool()) + '/lane-'));
const laneNumberOf = (path) => Number(basename(path.trim()).slice(5));

// Write a real free-lane list file via the production helpers, so the fixture is byte-identical in shape to
// what `lane-pool-health-watch.mjs` would actually publish.
function writeFreeList({ lanes, writtenAt = Date.now() }) {
  const poolDir = pool();
  const list = buildFreeLaneList({
    repoName: NAME, poolDir, writtenAt,
    lanes: lanes.map((n) => ({ lane: n, path: lanePath(n), head: 'deadbeef', branch: 'main' })),
  });
  writeFreeLaneListAtomic(resolveFreeLaneListPath({ repoName: NAME, poolDir }), list);
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-free-list-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-free-list-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shimDir);
  // Logging `git` shim: records cwd + GIT_OPTIONAL_LOCKS + argv, then execs the real git — identical to the
  // sibling scan-cache/shares-scan-cache tests' own shim.
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$GIT_TRACE_LOG"\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('#4122 acquire consumes the free-lane list', () => {
  it('a FRESH list naming a genuinely free lane is used, with far fewer lane git calls than a full scan', () => {
    provision(10);
    writeFreeList({ lanes: [7] });
    resetTrace();
    const r = runPool(['acquire', ...REPO(), '--session=free-list-caller', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(7);
    // The fast path claims + re-verifies ONE lane (a handful of git calls: fetch, dirty/ahead check,
    // checkout/clean) — nowhere near the ~4 calls-per-lane a 10-lane full scan would cost (40+).
    expect(laneGitCalls().length).toBeLessThan(15);
  });

  it('a STALE list is never consulted — acquire falls back to the scan and picks the scan\'s lowest free lane', () => {
    provision(5);
    // The stale list names a REAL, genuinely free, higher-numbered lane (4). Were the staleness check bypassed,
    // acquire would claim lane 4 straight off the list; the scan instead picks the lowest free lane (1) — so
    // this assertion reddens the moment freshness stops being enforced.
    writeFreeList({ lanes: [4], writtenAt: Date.now() - 60 * 60_000 }); // 1h old, way past the 10min default
    const r = runPool(['acquire', ...REPO(), '--session=stale-caller', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(1);
  });

  it('an EXHAUSTED fresh list (every listed lane already taken) falls through to the scan in the SAME call, with no --wait-ms and no growth', () => {
    provision(5);
    writeFreeList({ lanes: [1] });
    // The only listed lane gets leased by someone else after the list was published — the list is now
    // exhausted, but lanes 2-5 are genuinely free and unlisted.
    expect(runPool(['acquire', '--lane=1', ...REPO(), '--no-reset', '--session=foreign-holder']).code).toBe(0);
    // Default acquire (no --wait-ms) with growth capped at the current pool size: the only way to succeed is
    // the scan fallback running in this very call.
    const r = runPool(['acquire', ...REPO(), '--session=exhausted-caller', '--hard-max=5', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(2);
    // And the pool was never grown to get there.
    expect(existsSync(lanePath(6))).toBe(false);
  });

  it('a lane the list named goes BUSY before acquire runs — it is skipped, never double-claimed, and a different lane is returned', () => {
    provision(5);
    writeFreeList({ lanes: [2, 3, 4] });
    // Simulate the race: lane 2 gets leased by someone else AFTER the list was published but BEFORE this
    // acquire call reads it.
    expect(runPool(['acquire', '--lane=2', ...REPO(), '--no-reset', '--session=foreign-holder']).code).toBe(0);
    const r = runPool(['acquire', ...REPO(), '--session=race-caller', '--json']);
    expect(r.code, r.err).toBe(0);
    const lane = JSON.parse(r.out).lane;
    expect(lane).not.toBe(2); // the busy lane must never be double-claimed
    expect([3, 4]).toContain(lane); // the fast path moves on to the next listed candidate
  });

  it('a MISSING list is a pure no-op — acquire falls back to the scan exactly like before this feature', () => {
    provision(4);
    // No free-lane list file written at all.
    const r = runPool(['acquire', ...REPO(), '--session=no-list-caller', '--json']);
    expect(r.code, r.err).toBe(0);
    const lane = JSON.parse(r.out).lane;
    expect(lane).toBeGreaterThanOrEqual(1);
    expect(lane).toBeLessThanOrEqual(4);
  });

  it('--no-free-list opts out even when a fresh, valid list is sitting right there', () => {
    provision(4);
    // A fresh list naming a genuinely free, higher-numbered lane (3): consuming it would return 3; the scan
    // returns its lowest free lane (1) — so this reddens if the flag stops being honored.
    writeFreeList({ lanes: [3] });
    const r = runPool(['acquire', ...REPO(), '--session=opt-out-caller', '--no-free-list', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(1);
  });
});
