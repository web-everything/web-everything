/**
 * @file scripts/__tests__/lane-pool-clean-verdict-memo.test.mjs
 * @description Card xwn53th (build-daemon tick overrun): `list --acquirable` re-proved every CLEAN lane on every
 *   scan (~50 s of the daemon's 120 s tick). With LANE_POOL_CLEAN_VERDICT_MEMO_MAX_AGE_MS set the clean verdict is
 *   reused while the lane's stat fingerprint is unchanged. Proof here: (1) the answer is IDENTICAL to a full scan
 *   in every state we can create (clean, dirty, ahead, leased, reset), (2) git no longer runs in a reused clean
 *   lane, (3) any fingerprint change re-probes, (4) it is OFF unless asked for.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let base, originDir, referenceDir, poolRoot, shimDir, traceLog;
const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=memotest', '--branch=main', '--no-install', '--no-reap'];
const pool = () => join(poolRoot, 'memotest');
const lanePath = (n) => join(pool(), `lane-${n}`);
const MEMO = () => join(pool(), '.acquirable-verdict-memo.json');
let extraEnv = {};
const env = () => ({ ...process.env, ...extraEnv, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, GIT_TRACE_LOG: traceLog });
function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: env() });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function list(extra = []) {
  const r = runPool(['list', '--acquirable', '--no-cache', '--json', ...REPO(), ...extra]);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}
const resetTrace = () => rmSync(traceLog, { force: true });
const gitCallsIn = (n) => {
  if (!existsSync(traceLog)) return [];
  const dir = realpathSync(lanePath(n));
  return readFileSync(traceLog, 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([cwd]) => cwd === dir || cwd.startsWith(`${dir}/`));
};
const dirty = (n) => writeFileSync(join(lanePath(n), 'file.txt'), 'v1\nUNCOMMITTED\n');
const commitAhead = (n) => {
  writeFileSync(join(lanePath(n), 'ahead.txt'), 'local only\n');
  git(['add', 'ahead.txt'], lanePath(n));
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'unpushed'], lanePath(n));
};

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-memo-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-memo-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shim');
  traceLog = join(base, 'git-trace.log');
  mkdirSync(shimDir);
  // GIT_FAIL_ON=<subcommand> makes that one subcommand exit 1 (fault injection for "a probe git failed").
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$GIT_TRACE_LOG"\n[ -n "$GIT_FAIL_ON" ] && [ "$1" = "$GIT_FAIL_ON" ] && exit 1\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  expect(runPool(['provision', '--count=3', ...REPO()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const ON = { LANE_POOL_CLEAN_VERDICT_MEMO_MAX_AGE_MS: '600000' };
// The same scan with the memo off and with no memo file at all — the reference answer.
function referenceList() {
  const saved = extraEnv;
  extraEnv = { LANE_POOL_CLEAN_VERDICT_MEMO_MAX_AGE_MS: '0', LANE_POOL_VERDICT_MEMO_MAX_AGE_MS: '0' };
  try { return list(); } finally { extraEnv = saved; }
}
const lease = (n) => expect(runPool(['acquire', `--lane=${n}`, ...REPO(), '--no-reset', '--session=foreign-holder']).code).toBe(0);

describe('list --acquirable: opt-in reuse of a clean lane verdict', () => {
  afterEach(() => { extraEnv = {}; });

  it('reuses a clean lane: only the index-read `ls-files` runs in it on the second scan (no status/rev-list), same answer as the full scan', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) expect(gitCallsIn(n).map(([, args]) => args)).toEqual(['ls-files -z']);
    expect(list()).toEqual(referenceList());
  });

  it('is OFF unless asked for: the second scan still probes every clean lane', () => {
    expect(list()).toEqual([1, 2, 3]);
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) expect(gitCallsIn(n).length).toBeGreaterThan(0);
  });

  it('a memo written with the feature on is never trusted by a scan with it off', () => {
    extraEnv = ON;
    list();
    extraEnv = {};
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    expect(gitCallsIn(1).length).toBeGreaterThan(0);
  });

  it('a lease taken on a reused lane drops it at once', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    lease(2);
    expect(list()).toEqual([1, 3]);
    expect(list()).toEqual(referenceList());
  });

  it('a commit, a staged change and a reset on a reused lane all re-probe and match the full scan', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    commitAhead(1);
    expect(list()).toEqual([2, 3]);
    expect(list()).toEqual(referenceList());
    writeFileSync(join(lanePath(2), 'staged.txt'), 'x\n');
    git(['add', 'staged.txt'], lanePath(2));
    expect(list()).toEqual([3]);
    expect(list()).toEqual(referenceList());
    git(['reset', '--hard', '--quiet', 'origin/main'], lanePath(1));
    git(['reset', '--hard', '--quiet', 'origin/main'], lanePath(2));
    expect(list()).toEqual([1, 2, 3]);
    expect(list()).toEqual(referenceList());
  });

  it('an entry older than its max age is re-probed', () => {
    extraEnv = { LANE_POOL_CLEAN_VERDICT_MEMO_MAX_AGE_MS: '1' };
    expect(list()).toEqual([1, 2, 3]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    expect(gitCallsIn(1).length).toBeGreaterThan(0);
  });

  it('a dirty lane is still excluded and stays excluded through the negative memo', () => {
    extraEnv = ON;
    dirty(1);
    expect(list()).toEqual([2, 3]);
    expect(list()).toEqual([2, 3]);
    expect(list()).toEqual(referenceList());
  });

  // Review round 1 (PR #4356): the stat fingerprint cannot see a working-tree change with no index change, so a
  // warmed clean verdict must also carry a tree signature. Each test WARMS the verdict first, then changes the lane.
  it('excludes an unstaged edit after warming a clean verdict', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    dirty(1); // tracked file.txt edited in place, nothing staged: HEAD, refs and .git/index are untouched
    expect(list()).toEqual([2, 3]);
    expect(list()).toEqual(referenceList());
  });

  it('excludes a deleted tracked file and a new untracked file after warming a clean verdict', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    rmSync(join(lanePath(1), 'file.txt'));
    writeFileSync(join(lanePath(2), 'brand-new.txt'), 'x\n');
    expect(list()).toEqual([3]);
    expect(list()).toEqual(referenceList());
  });

  // Review round 1: one test per conjunct of the "fully clean" predicate — each makes ONLY that conjunct false and
  // asserts the lane is not recorded as a reusable clean verdict.
  const cleanEntry = (n) => { try { return JSON.parse(readFileSync(MEMO(), 'utf8')).lanes?.[n]?.clean === true; } catch { return false; } };

  it('does not record a litter-only dirty lane as clean (doa.uncommitted !== 0)', () => {
    extraEnv = ON;
    writeFileSync(join(lanePath(1), '.pr-body.md'), 'scratch\n'); // allowlisted litter: the full scan still calls the lane acquirable
    expect(list()).toEqual(referenceList());
    expect(list()).toContain(1);
    expect(cleanEntry(1)).toBe(false);
    expect(cleanEntry(2)).toBe(true); // the control: an untouched lane IS recorded
  });

  it('does not record an expired-lease lane as clean (info.lease), and a lane with a live lease is dropped at once', () => {
    extraEnv = ON;
    expect(runPool(['acquire', '--lane=2', ...REPO(), '--no-reset', '--session=short-lived', '--ttl-minutes=0.001']).code).toBe(0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    expect(list()).toEqual(referenceList());
    expect(list()).toContain(2); // stale lease ⇒ acquirable in the full scan too
    expect(cleanEntry(2)).toBe(false);
  });

  it('does not record an ahead-but-provably-pushed lane as clean (doa.aheadPushed): deleting the remote branch must exclude it', () => {
    extraEnv = ON;
    commitAhead(1);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/pushed-elsewhere'], lanePath(1));
    expect(list()).toEqual(referenceList());
    expect(list()).toContain(1); // pushed ⇒ the unpushed-work guard lets it go
    expect(cleanEntry(1)).toBe(false);
    git(['push', '--quiet', 'origin', '--delete', 'lane/pushed-elsewhere'], lanePath(1));
    expect(list()).toEqual(referenceList());
    expect(list()).not.toContain(1);
  });

  it('excludes a mode-only change (chmod) after warming a clean verdict', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    chmodSync(join(lanePath(1), 'file.txt'), 0o755); // mtime and size unchanged; only mode/ctime move
    expect(list()).toEqual(referenceList());
    expect(list()).not.toContain(1);
  });

  it('excludes an edit that keeps the old mtime and size (touch -r style) after warming a clean verdict', () => {
    extraEnv = ON;
    const f = join(lanePath(1), 'file.txt');
    utimesSync(f, 1_000_000, 1_000_000); // a whole-second mtime restores exactly (Date objects would round it)
    expect(list()).toEqual([1, 2, 3]);
    writeFileSync(f, 'v2\n'); // same length as 'v1\n'
    utimesSync(f, 1_000_000, 1_000_000);
    expect(list()).toEqual(referenceList());
    expect(list()).not.toContain(1);
  });

  it('a file whose name starts with whitespace is covered by the signature', () => {
    extraEnv = ON;
    const f = join(lanePath(1), ' lead.txt');
    writeFileSync(f, 'a\n');
    git(['add', '--', ' lead.txt'], lanePath(1));
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'ws'], lanePath(1));
    git(['push', '--quiet', 'origin', 'HEAD:main'], lanePath(1));
    git(['fetch', '--quiet', 'origin'], lanePath(1));
    expect(list()).toEqual(referenceList());
    expect(list()).toContain(1);
    writeFileSync(f, 'b\n');
    expect(list()).toEqual(referenceList());
    expect(list()).not.toContain(1);
  });

  it('does not record a lane when its git status/rev-list probe failed (a cached failure is not a clean verdict)', () => {
    extraEnv = { ...ON, GIT_FAIL_ON: 'status' };
    list(); // the failing probe reads "nothing uncommitted": acquirable for this one scan, as before
    expect(cleanEntry(1)).toBe(false);
    extraEnv = ON;
    resetTrace();
    expect(list()).toEqual(referenceList());
    expect(gitCallsIn(1).length).toBeGreaterThan(0); // re-probed, not served from a remembered failure
  });

  it('does not record a lane whose tree signature is racy (a tracked file modified at/after the probe start)', () => {
    extraEnv = ON;
    const future = new Date(Date.now() + 120_000);
    utimesSync(join(lanePath(1), 'file.txt'), future, future);
    expect(list()).toContain(1);
    expect(cleanEntry(1)).toBe(false);
    expect(cleanEntry(2)).toBe(true);
  });

  it('does no tree walk in a live-leased lane (it is never recorded clean, so the walk would be waste)', () => {
    extraEnv = ON;
    lease(2);
    resetTrace();
    expect(list()).toEqual([1, 3]);
    expect(gitCallsIn(2).filter(([, args]) => args.startsWith('ls-files'))).toEqual([]);
  });

  it('every recorded clean entry carries a tree signature', () => {
    extraEnv = ON;
    list();
    const memo = JSON.parse(readFileSync(MEMO(), 'utf8'));
    for (const n of [1, 2, 3]) expect(typeof memo.lanes[n].tree).toBe('string');
  });
});

describe('the verdict memo file format is versioned with its entry shape', () => {
  afterEach(() => { extraEnv = {}; });

  it('pins the version and the clean-entry keys together: a shape change must bump VERDICT_MEMO_VERSION', () => {
    extraEnv = ON;
    list();
    const memo = JSON.parse(readFileSync(MEMO(), 'utf8'));
    // If this fails because an entry key was added/removed/renamed, bump VERDICT_MEMO_VERSION in lane-pool.mjs
    // (an older reader treats any `{at, fp}` entry as "held / not acquirable") and update BOTH numbers here.
    expect(memo.v).toBe(3);
    expect(Object.keys(memo.lanes[1]).sort()).toEqual(['at', 'clean', 'fp', 'tree']);
  });

  it('a v2-shaped file carrying a clean entry is discarded by the current reader (and vice versa the file is v3)', () => {
    extraEnv = ON;
    list();
    const memo = JSON.parse(readFileSync(MEMO(), 'utf8'));
    writeFileSync(MEMO(), JSON.stringify({ ...memo, v: 2 }) + '\n');
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) expect(gitCallsIn(n).length).toBeGreaterThan(0); // nothing reused: every lane re-probed
    expect(JSON.parse(readFileSync(MEMO(), 'utf8')).v).toBe(3);
  });
});
