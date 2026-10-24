import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, sharedFixture, origin, reference, base, poolRoot, backupRoot, laneDir, lane;
const poolArgs = () => [`--origin=${origin}`, `--reference=${reference}`, '--name=releasesalvage', '--branch=main', '--no-install'];
function runPool(args) {
  const result = spawnSync(process.execPath, [script, ...args, ...poolArgs(), '--session=salvage-holder', '--json'], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_BACKUP_ROOT: backupRoot }),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
const salvageBranches = () => git(['ls-remote', '--heads', origin, `refs/heads/salvage/lane-${lane}-*`], reference)
  .split('\n').filter(Boolean).map(line => line.split(/\s+/));
function assertReleased(result) {
  expect(result.released).toBe(1);
  expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
}
function commitLocalWork() {
  writeFileSync(join(laneDir, 'local-work.txt'), 'work that must survive release\n');
  git(['add', 'local-work.txt'], laneDir);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'local work'], laneDir);
  const sha = git(['rev-parse', 'HEAD'], laneDir);
  expect(git(['rev-list', 'origin/main..HEAD'], laneDir)).toBe(sha);
  expect(git(['ls-remote', '--heads', origin], laneDir)).not.toContain(sha);
  return sha;
}
function recordFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? recordFiles(path) : entry.isFile() ? [path] : [];
  });
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'release-salvage-fixture-'));
  origin = join(fixtureRoot, 'origin.git');
  reference = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'seed.txt'), 'seed\n');
  git(['add', '.'], reference);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  sharedFixture = sharedRepos(fixtureRoot, [origin, reference]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'release-salvage-case-'));
  poolRoot = join(base, 'pool');
  backupRoot = join(base, 'backups');
  runPool(['provision', '--count=1']);
  const acquired = runPool(['acquire', '--lane=1', '--no-reset', '--purpose=salvage-test']);
  lane = acquired.lane;
  expect(lane).toBe(1);
  laneDir = join(poolRoot, 'releasesalvage', `lane-${lane}`);
  expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(true);
  expect(salvageBranches()).toEqual([]);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool release salvage push against a throwaway origin', () => {
  it('pushes an unpushed local HEAD while still leased, records it under WE_LANE_BACKUP_ROOT, then releases', () => {
    const sha = commitLocalWork();
    // The origin observes the lease during receive, proving preservation precedes release.
    // The hook uses the child's private fixture env, never a developer-specific path.
    writeFileSync(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh
set -eu
test -f "$LANE_POOL_ROOT/releasesalvage/lane-1/.git/.lane-lease"
printf 'lease present during receive\\n' > "$LANE_POOL_ROOT/push-observed"
`, { mode: 0o755 });
    const result = runPool(['release', `--lane=${lane}`]);
    assertReleased(result);
    const branches = salvageBranches();
    expect(branches).toHaveLength(1);
    expect(branches[0]).toEqual([sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-\d{8}-\d{4}(?:-\d+)?$/)]);
    expect(readFileSync(join(poolRoot, 'push-observed'), 'utf8')).toContain('lease present');
    const ref = branches[0][1].replace(/^refs\/heads\//, '');
    const records = recordFiles(backupRoot);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some(path => {
      const text = readFileSync(path, 'utf8');
      return text.includes(ref) && text.includes(sha);
    })).toBe(true);
  });

  it('releases a lane with no ahead commits without creating any salvage branch', () => {
    expect(git(['rev-list', 'origin/main..HEAD'], laneDir)).toBe('');
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });

  it('creates no salvage branch when a different SHA on another remote branch has the same patch', () => {
    const localSha = commitLocalWork();
    // Amend the message in a separate clone; leave the lane on its original, never-pushed SHA.
    const published = join(base, 'published');
    git(['clone', '--quiet', '--shared', laneDir, published]);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--amend', '-m', 'same patch, published message'], published);
    const remoteSha = git(['rev-parse', 'HEAD'], published);
    expect(remoteSha).not.toBe(localSha);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/work/renamed'], published);
    git(['fetch', '--quiet', 'origin'], laneDir);
    expect(git(['cherry', 'origin/work/renamed', 'HEAD'], laneDir)).toBe(`- ${localSha}`);
    expect(git(['ls-remote', '--heads', origin], laneDir)).not.toContain(localSha);
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });
});
