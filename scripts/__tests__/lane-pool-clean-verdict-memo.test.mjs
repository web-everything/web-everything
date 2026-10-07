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
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
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
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$GIT_TRACE_LOG"\nexec "${REAL_GIT}" "$@"\n`);
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

  it('reuses a clean lane: no git in it on the second scan, same answer as the full scan', () => {
    extraEnv = ON;
    expect(list()).toEqual([1, 2, 3]);
    resetTrace();
    expect(list()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) expect(gitCallsIn(n)).toEqual([]);
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
});
