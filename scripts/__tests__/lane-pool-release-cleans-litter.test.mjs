/**
 * @file scripts/__tests__/lane-pool-release-cleans-litter.test.mjs
 * @description Proof of `we:backlog/3568-*.md`'s release-time half: `cmdRelease` reaps ONLY the named
 *   `we:scripts/lib/lane-litter.mjs#LANE_RELEASE_LITTER_ALLOWLIST` scratch files from a lane's tree before
 *   dropping its lease — so a released lane reads immediately re-acquirable instead of DIRTY — while leaving
 *   any genuinely-dirty state (a tracked modification, an unknown untracked file, unpushed commits) exactly as
 *   it was, per the #2267 data-loss guard. Spawns the real CLI as a separate process, mirroring
 *   `lane-pool-release-ownership.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot };
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-release-litter-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-release-litter-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=litterpool', '--branch=trunk', '--no-install'];

function acquireOneLane() {
  expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
  const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json']);
  expect(acquire.code).toBe(0);
  return JSON.parse(acquire.out); // { lane, path?, holder, ... }
}

function laneDir(lane) {
  return join(poolRoot, 'litterpool', `lane-${lane}`);
}

function statusOf(lane) {
  const status = runPool(['status', ...poolArgs(), '--json']);
  expect(status.code).toBe(0);
  const rows = JSON.parse(status.out).lanes;
  return rows.find((r) => r.lane === lane);
}

describe('lane-pool release reaps known-safe litter (#3568)', () => {
  it('a lane whose ONLY dirty state is allowlisted litter reads clean:true immediately after release', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, '.commit-msg.txt'), 'WE #1: test\n');
    writeFileSync(join(dir, '.pr-body.md'), 'body\n');
    writeFileSync(join(dir, 'review-3568-output.json'), '{}\n');
    writeFileSync(join(dir, 'commit-msg-fix-1.txt'), 'fix\n');
    expect(git(['status', '--porcelain'], dir).split('\n').filter(Boolean).length).toBe(4);

    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);

    expect(git(['status', '--porcelain'], dir)).toBe('');
    expect(statusOf(lane).clean).toBe(true);
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(false);
    expect(existsSync(join(dir, 'review-3568-output.json'))).toBe(false);
  });

  it('a genuinely modified TRACKED file is left untouched by release (still dirty afterward)', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'file.txt'), 'unpushed edit\n'); // modifies the tracked seed file
    writeFileSync(join(dir, '.commit-msg.txt'), 'WE #1: test\n'); // litter, alongside real work

    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);

    // the litter is gone, but the real tracked edit is untouched and the lane still reads dirty
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('unpushed edit\n');
    expect(statusOf(lane).clean).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toMatch(/file\.txt/);
  });

  // #3568 — `cleanLaneLitter`'s own doc comment claims a TRACKED file sharing an allowlisted name is left
  // untouched — proved directly here with a TRACKED file whose name IS an allowlist entry, rather than left
  // as an unverified claim.
  it('a TRACKED file whose name collides with an allowlist entry is never touched by release, even modified', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    // A fresh clone carries no LOCAL git identity of its own (config is per-repo, never inherited from the
    // reference repo it was cloned from) — a CI runner with no global identity configured cannot `commit`
    // here without this, even though it works locally on a machine with an ambient global identity set.
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, '.commit-msg.txt'), 'a real tracked file, not litter\n');
    git(['add', '.commit-msg.txt'], dir);
    git(['commit', '--quiet', '-m', 'track a file that happens to share the litter allowlist name'], dir);
    writeFileSync(join(dir, '.commit-msg.txt'), 'modified — this is real tracked work\n');

    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);

    expect(readFileSync(join(dir, '.commit-msg.txt'), 'utf8')).toBe('modified — this is real tracked work\n');
    expect(statusOf(lane).clean).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toMatch(/\.commit-msg\.txt/);
  });

  it('an untracked file NOT on the allowlist is left untouched by release (still dirty afterward)', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'scratch-notes-mine.txt'), 'not on the allowlist\n');
    writeFileSync(join(dir, '.pr-body.txt'), 'litter\n');

    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);

    expect(existsSync(join(dir, '.pr-body.txt'))).toBe(false);
    expect(existsSync(join(dir, 'scratch-notes-mine.txt'))).toBe(true);
    expect(statusOf(lane).clean).toBe(false);
  });

  it('a lane that is only commits-ahead (not dirty) is untouched by the cleanup step', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    // See the identical comment above — a fresh clone has no LOCAL git identity of its own.
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'file.txt'), 'v2\n');
    git(['add', 'file.txt'], dir);
    git(['commit', '--quiet', '-m', 'ahead commit'], dir);
    const head = git(['rev-parse', 'HEAD'], dir);
    expect(git(['status', '--porcelain'], dir)).toBe(''); // ahead, not dirty

    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);

    expect(git(['rev-parse', 'HEAD'], dir)).toBe(head); // commit preserved — no reset/clean of tracked history
    expect(statusOf(lane).clean).toBe(true);
  });
});
