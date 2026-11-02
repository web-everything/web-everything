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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshSalvageIndex } from '../lib/salvage-index.mjs';
import { removeFiledCards, salvageLaneCards } from '../lib/lane-card-salvage.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, preload = null) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_SALVAGE_DIR: join(base, 'salvage') };
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [...(preload ? ['--import', preload] : []), SCRIPT, ...args], { encoding: 'utf8', env });
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

// R310 — 2026-11-01: 75 of 90 lanes were released DIRTY with only leftover card files and the pool read 0 acquirable.
describe('lane-pool release saves, then cleans, a lane dirty only with backlog card files (R310)', () => {
  // Patch the child's process boundary only: the real release, Git operations and lease IO still run.
  function gitHook(dir, body) {
    const path = join(base, 'git-hook.mjs');
    writeFileSync(path, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const original = cp.execFileSync;
const lane = ${JSON.stringify(dir)};
let statusReads = 0;
cp.execFileSync = function(cmd, args, opts) {
  ${body}
  return original.call(this, cmd, args, opts);
};
syncBuiltinESMExports();\n`);
    return path;
  }
  function leaveCards(dir) {
    mkdirSync(join(dir, 'backlog', 'raised-by', '5360'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'xfmkody-prevention-guard.md'), 'card\n');
    writeFileSync(join(dir, 'backlog', 'raised-by', '5360', '5771-abc.md'), 'raise\n');
    git(['add', '--', 'backlog/raised-by/5360/5771-abc.md'], dir);
  }

  it.each(['filed', 'salvage'])('failed unstaging keeps the exact lease on release and retry (%s)', mode => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    const rel = 'backlog/raised-by/5360/5771-abc.md';
    mkdirSync(join(dir, 'backlog', 'raised-by', '5360'), { recursive: true });
    writeFileSync(join(dir, rel), 'admitted card\n');
    git(['add', '--', rel], dir);
    const leasePath = join(dir, '.git', '.lane-lease');
    const leaseBytes = readFileSync(leasePath);
    const indexBytes = readFileSync(join(dir, '.git', 'index'));
    const lock = join(dir, '.git', 'index.lock');
    writeFileSync(lock, 'busy');
    const options = { dir, lane, salvageRoot: join(base, 'salvage'), pool: 'litterpool', isLeaseCurrent: () => true };
    let retiredDir;
    if (mode === 'filed') {
      expect(() => removeFiledCards({ ...options, expected: new Map([[rel, 'admitted card\n']]) })).toThrow();
      retiredDir = join(base, 'salvage', 'litterpool', 'retired-cards');
    } else {
      const result = salvageLaneCards(options);
      expect(result.status).toBe('failed');
      retiredDir = join(result.outDir, 'retired');
    }
    const [retired] = readdirSync(retiredDir);
    expect(readFileSync(join(retiredDir, retired), 'utf8')).toBe('admitted card\n');
    for (const locked of [true, false]) {
      if (!locked) rmSync(lock);
      const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
      expect(release.code).toBe(0);
      expect(JSON.parse(release.out).released).toBe(0);
      expect(release.out + release.err).toContain('staged card deletion needs recovery');
      expect(readFileSync(leasePath)).toEqual(leaseBytes);
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(indexBytes);
      expect(git(['status', '--porcelain'], dir)).toBe(`AD ${rel}`);
    }
    // Operator recovery after checking saved bytes: resolve the pending deletion, then retry release.
    git(['rm', '--cached', '--quiet', '--', rel], dir);
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(JSON.parse(release.out).released).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toBe('');
    expect(readFileSync(join(retiredDir, retired), 'utf8')).toBe('admitted card\n');
  });

  it('card-only dirt: the cards are saved byte for byte and the released lane reads clean', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    leaveCards(dir);
    writeFileSync(join(dir, '.pr-body.md'), 'litter\n');
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);
    expect(git(['status', '--porcelain', '--untracked-files=all'], dir)).toBe('');
    expect(statusOf(lane).clean).toBe(true);
    const out = join(base, 'salvage', 'litterpool');
    const [stamp] = readdirSync(out);
    expect(readFileSync(join(out, stamp, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card\n');
    expect(readFileSync(join(out, stamp, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise\n');
    const events = readFileSync(join(poolRoot, 'litterpool', '.lane-journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events.filter(e => e.action === 'card-salvage')).toEqual([expect.objectContaining({
      removed: expect.arrayContaining(['backlog/xfmkody-prevention-guard.md', 'backlog/raised-by/5360/5771-abc.md']),
      salvagedTo: join(out, stamp),
    })]);
  });

  it('a status-read failure with no known cards does not block release', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    const hook = gitHook(dir, `if (cmd === 'git' && opts?.cwd === lane && args.includes('status')) throw new Error('forced unreadable status');`);
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'], hook);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);
    expect(release.out + release.err).toContain('card salvage skipped');
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    expect(existsSync(join(base, 'salvage'))).toBe(false);
  });

  it.each(['litter cleanup', 'salvage recheck'])('lease changed during %s prevents card retirement', stage => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    leaveCards(dir);
    writeFileSync(join(dir, '.pr-body.md'), 'litter\n');
    const leasePath = join(dir, '.git', '.lane-lease');
    const replacement = { ...JSON.parse(readFileSync(leasePath, 'utf8')), session: 'replacement-owner', holder: 'replacement-holder' };
    const replacementBytes = JSON.stringify(replacement);
    // -uall distinguishes card salvage reads from the earlier snapshot/litter reads.
    const hook = gitHook(dir, `if (cmd === 'git' && opts?.cwd === lane && (
      ${JSON.stringify(stage)} === 'litter cleanup' ? args.includes('clean')
        : args.includes('status') && args.includes('--untracked-files=all') && ++statusReads === 2
    )) {
      const out = original.call(this, cmd, args, opts);
      writeFileSync(${JSON.stringify(leasePath)}, ${JSON.stringify(replacementBytes)});
      return out;
    }`);
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'], hook);
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(0);
    expect(release.out + release.err).toMatch(/lease changed/);
    expect(readFileSync(leasePath, 'utf8')).toBe(replacementBytes);
    expect(readFileSync(join(dir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card\n');
    expect(readFileSync(join(dir, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise\n');
    expect(existsSync(join(dir, '.pr-body.md'))).toBe(false); // the hook really ran during cleanup
    if (stage === 'litter cleanup') expect(existsSync(join(base, 'salvage'))).toBe(false);
    else {
      const root = join(base, 'salvage');
      const entry = JSON.parse(readFileSync(join(root, 'index.jsonl'), 'utf8').trim());
      expect(readFileSync(join(entry.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card\n');
      expect(existsSync(join(entry.outDir, 'retired'))).toBe(false);
    }
  });

  it('retired cards survive real lane trim and salvage expiry', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    leaveCards(dir);
    expect(JSON.parse(runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).out).released).toBe(1);
    const root = join(base, 'salvage');
    const entry = JSON.parse(readFileSync(join(root, 'index.jsonl'), 'utf8').trim());
    const retiredDir = join(entry.outDir, 'retired');
    const retained = readdirSync(retiredDir).map(name => join(retiredDir, name));
    expect(retained).toHaveLength(2);
    const trim = runPool(['trim', '--max=0', ...poolArgs(), '--json']);
    expect(trim.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(refreshSalvageIndex({ root, nowMs: Date.parse(entry.ts) + 30 * 86400_000, isLanded: () => false }).expired).toHaveLength(1);
    expect(retained.map(path => readFileSync(path, 'utf8')).sort()).toEqual(['card\n', 'raise\n']);
  });

  it('cards plus other real work: nothing is touched (the existing release behavior)', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    leaveCards(dir);
    writeFileSync(join(dir, 'file.txt'), 'real edit\n');
    const before = git(['status', '--porcelain', '--untracked-files=all'], dir);
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(release.code).toBe(0);
    expect(git(['status', '--porcelain', '--untracked-files=all'], dir)).toBe(before);
    expect(existsSync(join(base, 'salvage'))).toBe(false);
  });

  it('a save that fails refuses the release: the lease is kept and every card stays in the lane', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    leaveCards(dir);
    writeFileSync(join(base, 'salvage'), 'not a directory'); // forced error
    const before = git(['status', '--porcelain', '--untracked-files=all'], dir);
    const leasePath = join(dir, '.git', '.lane-lease');
    const leaseBefore = readFileSync(leasePath, 'utf8');
    const release = runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']);
    expect(JSON.parse(release.out).released).toBe(0);
    expect(release.err + release.out).toMatch(/KEPT — card files could not be saved/);
    expect(git(['status', '--porcelain', '--untracked-files=all'], dir)).toBe(before);
    expect(readFileSync(leasePath, 'utf8')).toBe(leaseBefore);
  });
});
