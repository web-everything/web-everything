/**
 * @file scripts/__tests__/lane-pool-ahead-patch-equivalent-bounded-spawn.test.mjs
 * @description Regression test for #3383-perf, the SAME shape of bug #2920 fixed for the ancestry check, now
 *   for the squash/rebase-merge patch-equivalence fallback #3383 added: the first cut of that fallback ran one
 *   full `git cherry <head> HEAD` PER live remote head, per ahead lane — O(lanes × heads). Live-caught on the
 *   real web-everything pool (83 lanes, 160 remote heads): a single `list --acquirable` pass stalled for 20+
 *   minutes, hanging the fix daemon's every tick (it calls this on every tick). The fix: (1) try ONE `git
 *   cherry origin/<branch> HEAD` first (covers the common case — a lane's work lands on its own integration
 *   branch); (2) only if that finds nothing, a single O(1)-git-spawn-pair batched patch-id comparison against
 *   every OTHER remote head (`git diff-tree --stdin -p | git patch-id --stable`, once total — never once per
 *   head). This file pins: (a) the primary-branch case still resolves with almost no extra spawns; (b) the
 *   fallback case (patch-equivalent to a DIFFERENT branch, e.g. lane-11's real PR #176 case) still resolves,
 *   with MANY unrelated filler heads present, WITHOUT the spawn count scaling with the filler-head count; (c)
 *   a genuinely unrelated/unpushed lane still correctly stays protected.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function gitc(args, cwd) {
  return git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', ...args], cwd);
}

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=boundspawn', '--branch=main', '--no-install'];

function listAcquirable() {
  const r = runPool(['list', '--json', '--acquirable', ...REPO()]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

// Every git process spawned WHILE `fn` runs, counted via a PATH-shimmed counting wrapper — same technique as
// `lane-pool-ahead-provably-pushed-single-spawn.test.mjs` (#2920).
function countGitSpawnsDuring(fn) {
  const shimDir = join(base, 'bin');
  mkdirSync(shimDir, { recursive: true });
  const spawnLog = join(base, 'git-spawns.log');
  writeFileSync(spawnLog, '');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shimDir, 'git'), `#!/bin/bash\necho "$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  const result = fn({ PATH: `${shimDir}:${process.env.PATH}` });
  const spawnCount = Number(execFileSync('wc', ['-l', spawnLog], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  return { result, spawnCount };
}

// Inflate origin with N unrelated filler branches, each one commit off origin's current `main`. Written straight
// into the bare origin with ONE `git fast-import` (one pack, one process) rather than N × (write + add + commit +
// push + reset) in a throwaway clone — the same N real remote heads the lane fetches, at a small fraction of the
// file-system churn (this helper alone was ~15k file events per run of this file).
function addFillerHeads(n) {
  const mainSha = git(['rev-parse', 'refs/heads/main'], originDir);
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let stream = '';
  for (let i = 0; i < n; i++) {
    stream += `commit refs/heads/lane/filler-${i}\n`
      + 'committer t <t@t.com> 1700000000 +0000\n'
      + data(`filler ${i}`)
      + `from ${mainSha}\n`
      + `M 100644 inline filler-${i}.txt\n`
      + data(`filler-${i}`)
      + '\n';
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: originDir, input: stream });
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-bound-spawn-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  gitc(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-bound-spawn-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const N_FILLER = 60;

describe('#3383-perf — patch-equivalence fallback spawn count is BOUNDED (does not scale with remote-head count)', () => {
  it('the common case (squash-merged onto the lane\'s own branch) resolves via the primary check, cheaply, with many unrelated heads present', () => {
    const r = runPool(['provision', '--count=1', ...REPO()]);
    expect(r.code).toBe(0);
    const lane = join(poolRoot, 'boundspawn', 'lane-1');

    writeFileSync(join(lane, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], lane);
    gitc(['commit', '--quiet', '-m', 'add feature'], lane);

    // Other work lands on main first, then a squash-merge lands the SAME content as a new commit — the exact
    // #3383 scenario — plus a large pile of unrelated filler branches (simulating the real 160-remote-head
    // WE pool) that must NOT be walked one-by-one.
    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    writeFileSync(join(filler, 'other.txt'), 'unrelated\n');
    git(['add', 'other.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'unrelated work landed first'], filler);
    writeFileSync(join(filler, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'squash-merge add feature (#123)'], filler);
    git(['push', '--quiet', 'origin', 'main'], filler);
    addFillerHeads(N_FILLER);
    git(['fetch', '--quiet', 'origin'], lane);

    expect(git(['ls-remote', '--heads', 'origin'], lane).split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(N_FILLER);

    const { result, spawnCount } = countGitSpawnsDuring((env) => runPool(['list', '--json', '--acquirable', ...REPO()], env));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).map((p) => basename(p))).toEqual(['lane-1']);
    // OLD behavior: ≥ N_FILLER `git cherry` spawns (one per remote head) for this one ahead lane alone. NEW
    // behavior: the primary branch check finds it directly — total spawn count stays small, well under
    // N_FILLER, regardless of how many filler heads exist.
    expect(spawnCount, `git spawns: ${spawnCount}`).toBeLessThan(N_FILLER);
  });

  it('the fallback case (patch-equivalent to a DIFFERENT branch — the lane-11/PR-#176 shape) still resolves, without one git-cherry spawn per filler head', () => {
    const r = runPool(['provision', '--count=1', ...REPO()]);
    expect(r.code).toBe(0);
    const lane = join(poolRoot, 'boundspawn', 'lane-1');

    writeFileSync(join(lane, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], lane);
    gitc(['commit', '--quiet', '-m', 'add feature'], lane);

    // The SAME content lands on a DIFFERENT, still-open branch (never on main) — main advances with unrelated
    // work only, so the primary `git cherry origin/main HEAD` check finds nothing and the batched fallback
    // must find it instead.
    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    writeFileSync(join(filler, 'other.txt'), 'unrelated\n');
    git(['add', 'other.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'unrelated work on main'], filler);
    git(['push', '--quiet', 'origin', 'main'], filler);
    git(['reset', '--quiet', '--hard', 'origin/main'], filler);
    writeFileSync(join(filler, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'PR #176: add feature'], filler);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/pr-176'], filler);
    addFillerHeads(N_FILLER);
    git(['fetch', '--quiet', 'origin'], lane);

    // Confirm the setup: the primary branch alone does NOT prove it (a `+`), but SOME live head does.
    expect(git(['cherry', 'origin/main', 'HEAD'], lane)).toMatch(/^\+/);

    const { result, spawnCount } = countGitSpawnsDuring((env) => runPool(['list', '--json', '--acquirable', ...REPO()], env));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).map((p) => basename(p))).toEqual(['lane-1']);
    // OLD behavior: one `git cherry` PER remote head (≥ N_FILLER + 1) to find this. NEW behavior: two batched
    // `diff-tree | patch-id` pipelines total, regardless of N_FILLER.
    expect(spawnCount, `git spawns: ${spawnCount}`).toBeLessThan(N_FILLER);
  });

  it('a genuinely different (unpushed) patch stays protected even with many filler heads present', () => {
    const r = runPool(['provision', '--count=1', ...REPO()]);
    expect(r.code).toBe(0);
    const lane = join(poolRoot, 'boundspawn', 'lane-1');

    writeFileSync(join(lane, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], lane);
    gitc(['commit', '--quiet', '-m', 'add feature'], lane);

    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    writeFileSync(join(filler, 'other.txt'), 'unrelated\n');
    git(['add', 'other.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'unrelated work'], filler);
    git(['push', '--quiet', 'origin', 'main'], filler);
    addFillerHeads(N_FILLER);
    git(['fetch', '--quiet', 'origin'], lane);

    expect(listAcquirable()).toEqual([]);
  });
});
